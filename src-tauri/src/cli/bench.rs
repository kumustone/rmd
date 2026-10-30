//! 步骤 1 · **CLI 基准**（`docs/design/0002` §7.2 第 1、2 条）。
//!
//! 口径（§7.3.1 的**口径 B · 跨进程对照**）：这里的数字**只回答"Rust 侧在这台机器上
//! 是什么量级"**。⛔ 不与 GUI 的绝对时间相加，⛔ 不做「T4 = GUI 总时长 − CLI 总时长」。
//!
//! 分段定义（§7.3.2 的 Rust 侧部分）：
//!
//! | 编号 | 这一段是什么 |
//! |---|---|
//! | T1 | 读盘（`fs::read` + UTF-8 校验 + 剥 BOM） |
//! | T2 | **建 arena + comrak 解析**（arena 分配含在内） |
//! | T3 | 渲染 HTML |
//! | T7 | **Rust 侧的目录数据**⚠️ 只是 §7.3.2 里 T7 的前半段（"目录数据到手"）；后半段"目录可用"在前端，GUI 才量得到 |
//! | T8 | **Rust 侧**源搜索 ⚠️ 同理，前端侧观测的同名调用在 GUI 量 |
//! | — | `t_index`：建行起始偏移索引。**不是设计里的编号**，但它确实发生在关键路径上，所以单列不藏 |
//!
//! ⚠️ 内存：**分行列出，不给"总内存"**（§7.3.4）。Rust 侧这一段与 WebView 侧
//! 有共享页，两者不可加。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use clap::Args;

use crate::document::offset::LineIndex;
use crate::document::parser::ParseOpts;
use crate::document::{loader, render, search, toc};

#[derive(Debug, Args)]
pub struct BenchArgs {
    /// 语料文件，可以给多个
    #[arg(value_name = "PATH", required = true)]
    paths: Vec<PathBuf>,

    /// 每个文件重复几轮（每轮都是完整的"打开一次"）
    #[arg(long, default_value_t = 5)]
    repeat: usize,

    /// 预热轮数（不计入统计）。⛔ 去掉预热会让第一轮把"冷页 + 首次分配"算进去
    #[arg(long, default_value_t = 1)]
    warmup: usize,

    /// 不跑 T7（目录）——XL 语料上目录很大时可以省点时间
    #[arg(long)]
    no_toc: bool,

    /// 不跑 T8（搜索）
    #[arg(long)]
    no_search: bool,

    /// T8 用的 needle。默认是语料词库里**必然存在**的高频词——
    /// ⚠️ 换成低频词，T8 会退化成"扫一遍什么都没找到"，那测的不是搜索成本。
    #[arg(long, default_value = "文档")]
    needle: String,

    /// 把结果写成 JSON（`benchmarks/results/` 用的就是这个）
    #[arg(long, value_name = "OUT")]
    json: Option<PathBuf>,

    /// 结果里记的日期，默认取本机当前 UTC 日期
    #[arg(long, value_name = "YYYY-MM-DD")]
    date: Option<String>,

    /// 打开 `parse.sourcepos_chars`（列按字符计而不是按字节计）。
    ///
    /// ⚠️ 只为回答 `kb/0002` 那条"这趟额外重扫要多少毫秒"的**未实测**——
    /// 本项目**不打算用它**（理由见 `kb/0002` §2）。
    #[arg(long)]
    chars: bool,

    /// 打开 `render.sourcepos`（在 HTML 里写 `data-sourcepos`）。
    ///
    /// ⚠️ **默认 `true` 是刻意的**：`benchmarks/results/` 里 2026-10-13/10-14 那两批
    /// 数字都是在它**开着**的时候跑的，改默认值等于换了一个口径，跨日期就不可比了。
    ///
    /// ⭐ 它是 `design/0002` §10.2 记的那条前置：「批 2 采 T5 前必须先把这个口径定下来」。
    /// 定法（2026-10-14）= **GUI 侧走产品口径（关，`GUI_OPTS`）**，而 CLI `bench` 保持
    /// **探针口径（开）**，后者唯一的用途是量 `kb/0002` 那块"真实规模上的膨胀比值"。
    /// ⇒ 加这个开关是为了**那个比值**能在一台机器、同一份语料上一次跑出两个口径。
    /// ⛔ 两个口径的数字**只按 §7.3.1 的口径 B 各自对照**，⛔ 不相加。
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    sourcepos: bool,

    /// ⭐ 额外量一次**顶层块表**（`design/0047` §3.1 的 `blocks::build`），单列 `t_blocks`。
    ///
    /// ⚠️ **默认关**：这条 CLI 链**不调** `render_source`（GUI 与预览才调），
    /// 所以块表在这里是一次**额外的**遍历——默认打开会改变既有结果的口径，
    /// 而 `benchmarks/results/` 是历史记录（`docs/README.md` §6）。
    /// ⚠️ 它量的是"在**已解析好的** AST 上再走一层"的成本，⛔ 不是整个 parse 的成本。
    #[arg(long)]
    blocks: bool,
}

/// 一个阶段在一批重复里的耗时分布。
#[derive(Debug, Default, Clone)]
struct Stat {
    min: Duration,
    median: Duration,
    max: Duration,
}

impl Stat {
    fn from(mut v: Vec<Duration>) -> Self {
        if v.is_empty() {
            return Self::default();
        }
        v.sort_unstable();
        // 偶数个取偏小的那个：比"平均两个"更容易复现，也更容易解释
        let median = v[(v.len() - 1) / 2];
        Self { min: v[0], median, max: v[v.len() - 1] }
    }
    fn ms(&self) -> (f64, f64, f64) {
        (ms(self.min), ms(self.median), ms(self.max))
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// 一个文件的全部结果。
#[derive(Debug, Default)]
struct FileResult {
    path: String,
    source_bytes: usize,
    html_bytes: usize,
    bytes_per_source_byte: f64,
    /// AST 节点数。⚠️ **不是** DOM 节点数——DOM 是它经 innerHTML 之后的结果，
    /// 只能在前端量（`design/0002` §7.2 第 9 条）。这里是它的上界参考。
    ast_nodes: usize,
    /// 目录项数。
    toc_entries: usize,
    /// ⭐ `design/0047` 的顶层块数（`--blocks` 才量）。
    blocks: usize,
    /// T8 命中数。
    hits: usize,
    /// ⭐ **Q22 规模闸门的结果**：真正高亮出来的代码块数。
    ///
    /// ⚠️⚠️ **不记这两个数，`results/` 里的历史就再也读不懂了**：
    /// 闸门上线后 `XL-code` 的 `t3_render` 从 3354 ms 掉到 403 ms（2026-10-15 实测），
    /// 而只看 `t3_render` **分不出**那是"闸门按预期回退了一批"还是"高亮整个关掉了"。
    code_highlighted: usize,
    /// ⭐ 因规模限制未高亮的代码块数（单块超限 ＋ 累计触顶）。
    code_unhighlighted: usize,
}

#[derive(Debug, Default)]
struct Timings {
    t1: Stat,
    t2: Stat,
    t3: Stat,
    t7: Stat,
    t8: Stat,
    t_index: Stat,
    /// ⭐ `design/0047` 的顶层块表遍历。⚠️ 只有在 `--blocks` 下才有值，
    /// 否则是 `Default`（全 0）——**⛔ 别把全 0 读成"耗时为零"**，它只表示"没量"。
    t_blocks: Stat,
}

pub fn run(args: &BenchArgs) -> i32 {
    let date = args.date.clone().unwrap_or_else(utc_date);
    println!("rmd {} · 步骤 1（CLI 基准）", env!("CARGO_PKG_VERSION"));
    println!(
        "comrak {} · profile {} · needle {:?}",
        comrak::version(),
        profile(),
        args.needle
    );
    let opts = ParseOpts {
        render_sourcepos: args.sourcepos,
        sourcepos_chars: args.chars,
        heading_ids: true,
        // ⚠️ **故意关掉公式**（`design/0007` §2.1.2 的开关，出厂是开的）。
        //    理由：`benchmarks/results/` 里那批 2026-10-13 的数字是在**没有这个选项**时
        //    跑出来的，而基准的全部意义就是**跨日期可比**。开着它跑，`$…$` 成对的语料
        //    会被 `katex-rs` 渲染一遍，T2/T3 里就混进了"本次多了多少公式"这个变量——
        //    那不是我们想量的东西。⇒ 口径钉死为"关"，并**打印出来**（下一行）。
        math_dollars: false,
        // ⚠️ **同样故意关掉单换行断行**（`design/0008` §2.1(1) 的开关，出厂是开的），
        //    理由与上面那条一模一样：`benchmarks/results/` 里的历史数字是在**没有它**的
        //    时候跑的，开着跑等于换了一个渲染口径，跨日期就不可比了。
        hardbreaks: false,
    };
    println!(
        "渲染口径：render.sourcepos={} · 标题 id={} · sourcepos_chars={} · math_dollars={} · hardbreaks={}",
        opts.render_sourcepos, opts.heading_ids, opts.sourcepos_chars, opts.math_dollars,
        opts.hardbreaks
    );
    println!(
        "机器 {} / {} / {} · 并发 {} · {} 个文件 × {} 轮（预热 {}）",
        machine_model(),
        std::env::consts::ARCH,
        os_release(),
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        args.paths.len(),
        args.repeat,
        args.warmup
    );
    println!();

    // —— 峰值 RSS：后台每 2ms 采一次 ——
    let stop = Arc::new(AtomicBool::new(false));
    let sampler = {
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            let mut peak = 0u64;
            while !stop.load(Ordering::Relaxed) {
                if let Some(r) = current_rss_bytes() {
                    peak = peak.max(r);
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            peak.max(current_rss_bytes().unwrap_or(0))
        })
    };


    let mut files: Vec<FileResult> = Vec::new();
    let mut all: Vec<Timings> = Vec::new();

    for path in &args.paths {
        match bench_one(path, args, &opts) {
            Ok((fr, t)) => {
                print_one(&fr, &t, args);
                files.push(fr);
                all.push(t);
            }
            Err(e) => {
                eprintln!("⛔ 跳过 {}：{e}", path.display());
                return 1;
            }
        }
    }

    stop.store(true, Ordering::Relaxed);
    let peak_sampled = sampler.join().unwrap_or(0);
    let peak_kernel = resident_size_max_bytes().unwrap_or(0);

    println!();
    println!("内存（Rust 进程侧，**不是** WebView 侧，两者不可加）：");
    println!("  采样峰值 RSS        {}  （每 2ms 采一次）", human_bytes_u64(peak_sampled));
    println!(
        "  内核记录的历史峰值  {}  （`mach_task_basic_info.resident_size_max`）",
        human_bytes_u64(peak_kernel)
    );
    println!("  ⚠️ 这两个数包含 T8 造出来的命中列表，不是「文档所需的常驻内存」——");
    println!("     要纯净的常驻值请加 `--no-search` 再跑一遍。");

    if let Some(out) = &args.json {
        match write_json(out, &date, args, &opts, &files, &all, peak_sampled, peak_kernel) {
            Ok(()) => println!("\n✅ 结果写入 {}", out.display()),
            Err(e) => {
                eprintln!("\n⛔ 写不了 {}：{e}", out.display());
                return 1;
            }
        }
    }

    0
}

fn bench_one(path: &Path, args: &BenchArgs, opts: &ParseOpts) -> std::io::Result<(FileResult, Timings)> {
    let mut t = Timings::default();
    let mut t1 = Vec::new();
    let mut t2 = Vec::new();
    let mut t3 = Vec::new();
    let mut t7 = Vec::new();
    let mut t8 = Vec::new();
    let mut ti = Vec::new();
    let mut tb = Vec::new();
    let mut fr = FileResult { path: path.display().to_string(), ..Default::default() };

    for round in 0..(args.warmup + args.repeat) {
        let counting = round >= args.warmup;

        // —— T1 读盘 ——
        let t0 = Instant::now();
        let loaded = loader::load(path)?;
        let d1 = t0.elapsed();
        let src = loaded.source;

        // —— 偏移索引（设计里没有编号，但它确实在关键路径上）——
        let t0 = Instant::now();
        let index = LineIndex::new(&src);
        let di = t0.elapsed();

        // —— T2 建 arena + 解析 ——
        let t0 = Instant::now();
        let arena = comrak::Arena::new();
        let root = crate::document::parser::parse(&arena, &src, opts);
        let d2 = t0.elapsed();

        // —— T3 渲染 ——
        let t0 = Instant::now();
        // ⚠️ 用 `to_html_with_stats`（⛔ 不是 `to_html`）：Q22 的规模闸门就在这条链上，
        //    而"闸门挡掉了几块"是**读数必需的上下文**——见 `FileResult` 上那两条注释。
        let (html, stats) = render::to_html_with_stats(root, opts);
        let d3 = t0.elapsed();

        // —— T7 目录数据 ——
        let t0 = Instant::now();
        let toc_n = if args.no_toc { 0 } else { toc::build(root, &src, &index, opts.col_unit()).len() };
        let d7 = t0.elapsed();

        // —— T8 搜索 ——
        let t0 = Instant::now();
        let hits = if args.no_search { 0 } else { search::find_all(&src, &args.needle, &index).len() };
        let d8 = t0.elapsed();

        // —— 顶层块表（`design/0047` §3.1，`--blocks` 才跑）——
        //    ⚠️ **搭同一趟车**才是产品口径（GUI/预览都在已解析的 AST 上走一层），
        //    所以这里也不重新 parse；单列计时是为了让"这一步值不值"能单独看。
        let t0 = Instant::now();
        let (block_n, db) = if args.blocks {
            let n = crate::document::blocks::build(root).len();
            (n, t0.elapsed())
        } else {
            (0, Duration::ZERO)
        };

        let ast_nodes = root.descendants().count();

        if counting {
            t1.push(d1);
            ti.push(di);
            t2.push(d2);
            t3.push(d3);
            t7.push(d7);
            t8.push(d8);
            if args.blocks {
                tb.push(db);
            }
        }

        fr.source_bytes = src.len();
        fr.html_bytes = html.len();
        fr.bytes_per_source_byte = html.len() as f64 / src.len().max(1) as f64;
        fr.ast_nodes = ast_nodes;
        fr.toc_entries = toc_n;
        fr.blocks = block_n;
        fr.hits = hits;
        fr.code_highlighted = stats.code_highlighted;
        fr.code_unhighlighted = stats.code_unhighlighted();

        // 规模数只在最后一轮打一次（免得把 5 轮刷成 5 遍）
        if round == args.warmup + args.repeat - 1 {
            println!(
                "  {} ：源 {} · HTML {}（{:.2}×）· AST 节点 {} · 目录 {} 项 · 命中 {} 处 · \
                 代码高亮 {}{}{}",
                path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                human_bytes(src.len()),
                human_bytes(html.len()),
                fr.bytes_per_source_byte,
                fr.ast_nodes,
                toc_n,
                hits,
                fr.code_highlighted,
                // ⚠️ 有回退时**必须显式写出**：它是 `t3_render` 那一条的读数前提。
                if fr.code_unhighlighted > 0 {
                    format!(" · ⛔ 未高亮 {}（规模限制）", fr.code_unhighlighted)
                } else {
                    String::new()
                },
                // ⭐ `--blocks` 下把块数摆出来：它是"块表到底切出了几段"的唯一读数。
                if args.blocks { format!(" · 块表 {} 项", fr.blocks) } else { String::new() }
            );
        }
    }

    t.t1 = Stat::from(t1);
    t.t2 = Stat::from(t2);
    t.t3 = Stat::from(t3);
    t.t7 = Stat::from(t7);
    t.t8 = Stat::from(t8);
    t.t_index = Stat::from(ti);
    t.t_blocks = Stat::from(tb);
    Ok((fr, t))
}

fn print_one(fr: &FileResult, t: &Timings, args: &BenchArgs) {
    println!(
        "  {}  {}  {}  {}  {}  {}",
        pad("阶段", 10),
        pad("min", 10),
        pad("median", 10),
        pad("max", 10),
        pad("占 median 合计", 16),
        "说明"
    );
    let stats = [&t.t1, &t.t2, &t.t3, &t.t7, &t.t8, &t.t_index];
    let mut sum: f64 = stats.iter().map(|s| ms(s.median)).sum();
    // ⚠️ 只有真量了才进分母——否则"占合计"这一列会被一个恒 0 的项稀释。
    if args.blocks {
        sum += ms(t.t_blocks.median);
    }

    let rows: [(&str, &Stat, &str); 6] = [
        ("T1 读盘", &t.t1, "fs::read + UTF-8 校验"),
        ("T2 解析", &t.t2, "建 arena + comrak（key）"),
        ("T3 渲染", &t.t3, "AST → HTML"),
        ("T7 目录", &t.t7, "Rust 侧前半段"),
        ("T8 搜索", &t.t8, "朴素子串"),
        ("t_index", &t.t_index, "行起始偏移索引（设计外）"),
    ];
    for (name, st, note) in rows {
        let (mn, md, mx) = st.ms();
        println!(
            "  {}  {}  {}  {}  {}  {}",
            pad(name, 10),
            pad(&fmt_ms(mn), 10),
            pad(&fmt_ms(md), 10),
            pad(&fmt_ms(mx), 10),
            pad(&format!("{:.1}%", md / sum.max(f64::EPSILON) * 100.0), 16),
            note
        );
    }
    println!("  （median 合计 {:.1} ms；⛔ 这只是 Rust 侧的合计，不是「打开一份文档要多久」）", sum);
    if args.blocks {
        // ⭐ `design/0047` §3.1：块表在**已解析好的** AST 上再走一层。
        let (mn, md, mx) = t.t_blocks.ms();
        println!(
            "  {}  {}  {}  {}  {}  {}",
            pad("块表", 10),
            pad(&fmt_ms(mn), 10),
            pad(&fmt_ms(md), 10),
            pad(&fmt_ms(mx), 10),
            pad(&format!("{:.1}%", md / sum.max(f64::EPSILON) * 100.0), 16),
            "`design/0047` 顶层块表（--blocks）"
        );
    }
    if args.no_toc || args.no_search {
        println!("  ⚠️ 本轮有阶段被 --no-toc / --no-search 跳过，合计不可比");
    }
    println!("  {}", format!("{}—— {} ——", pad("", 10), fr.path));
}

// ───────────────────────────── JSON ─────────────────────────────

fn write_json(
    out: &Path,
    date: &str,
    args: &BenchArgs,
    opts: &ParseOpts,
    files: &[FileResult],
    all: &[Timings],
    peak_sampled: u64,
    peak_kernel: u64,
) -> std::io::Result<()> {
    let stat = |s: &Stat| {
        let (mn, md, mx) = s.ms();
        serde_json::json!({ "min_ms": mn, "median_ms": md, "max_ms": mx })
    };

    let entries: Vec<serde_json::Value> = files
        .iter()
        .zip(all.iter())
        .map(|(f, t)| {
            let mut entry = serde_json::json!({
                "path": f.path,
                "source_bytes": f.source_bytes,
                "html_bytes": f.html_bytes,
                "html_per_source": f.bytes_per_source_byte,
                "ast_nodes": f.ast_nodes,
                "toc_entries": f.toc_entries,
                "t8_hits": f.hits,
                // ⭐ Q22 规模闸门（2026-10-15）：**`t3_render` 的读数前提**。
                //    ⚠️ 只看 `t3_render` 分不出"闸门回退了一批"与"高亮整个关掉了"——
                //    两者的差别全在这两个数里。旧结果文件**没有**这两个键
                //    ⇒ 比较时按"闸门不存在"读，⛔ 别当成 0。
                "code_highlighted": f.code_highlighted,
                "code_unhighlighted": f.code_unhighlighted,
                "t1_load": stat(&t.t1),
                "t2_parse": stat(&t.t2),
                "t3_render": stat(&t.t3),
                "t7_toc_rust": stat(&t.t7),
                "t8_search_rust": stat(&t.t8),
                "t_index_line_offsets": stat(&t.t_index),
            });
            // ⭐ `design/0047`：只有真量了才写这两个键——⛔ **不写全 0**。
            //    理由同 `code_highlighted` 那条：旧文件里没有这个键，
            //    所以"没有这个键"必须能表达"这一轮没量块表"。
            if args.blocks {
                entry["blocks"] = serde_json::json!(f.blocks);
                entry["t_blocks_ms"] = stat(&t.t_blocks);
            }
            entry
        })
        .collect();

    let doc = serde_json::json!({
        "schema": "rmd-bench/1",
        "date": date,
        "rmd_version": env!("CARGO_PKG_VERSION"),
        "comrak_version": comrak::version(),
        "profile": profile(),
        "口径": {
            "说明": "design/0002 §7.3.2 的 Rust 侧分段。口径 B（跨进程对照），⛔ 不与 GUI 绝对时间相加。",
            "T1": "读盘",
            "T2": "建 arena + comrak 解析",
            "T3": "渲染 HTML",
            "T7": "仅 Rust 侧前半段（目录数据）；\"目录可用\"在前端",
            "T8": "仅 Rust 侧搜索；前端侧同名调用另计",
            "ast_nodes": "AST 节点数，**不是** DOM 节点数——DOM 只能在前端量（§7.2 第 9 条）",
            "t_index": "行起始偏移索引，设计里没有编号，单列不藏",
            "t_blocks": "design/0047 的顶层块表遍历（--blocks 才有）；旧结果没有这个键 ⇒ 按\"没量\"读",
            "code_highlighted": "Q22 规模闸门真正高亮出来的代码块数（2026-10-15 起才有）",
            "code_unhighlighted": "因规模限制未高亮的代码块数；>0 时 t3_render 已不是\"全量高亮\"的口径",
        },
        "环境": {
            "machine_model": machine_model(),
            "arch": std::env::consts::ARCH,
            "os_release": os_release(),
            "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        },
        "参数": {
            "repeat": args.repeat,
            "warmup": args.warmup,
            "needle": args.needle,
            "no_toc": args.no_toc,
            "no_search": args.no_search,
            // ⭐ `--blocks` 也是**口径**的一部分：开了才有 `blocks` / `t_blocks_ms` 两个键。
            "blocks": args.blocks,
            // ⭐ **口径必须跟着结果走**（`design/0002` §10.2）。
            //    ⚠️ 这三个布尔是"渲染口径"的一部分：`html_bytes` / `t3_render` 都会跟着它们变，
            //    而结果文件里**原先一个字都没记**⇒ 三个月后没人能判断两份 json 可不可比。
            //    `math_dollars` / `hardbreaks` 同样是 2026-10-14 起新增的渲染开关（`0007`/`0008`），
            //    将来若哪天打开，同一句警告照样成立。
            "parse_opts": {
                "render_sourcepos": opts.render_sourcepos,
                "sourcepos_chars": opts.sourcepos_chars,
                "heading_ids": opts.heading_ids,
                "math_dollars": opts.math_dollars,
                "hardbreaks": opts.hardbreaks,
            },
        },
        "内存": {
            "注": "Rust 进程侧。与 WebView 侧不可加（共享页 + 重复映射，design/0002 §7.3.4）。",
            "peak_rss_sampled_bytes": peak_sampled,
            "resident_size_max_bytes": peak_kernel,
        },
        "文件": entries,
    });

    if let Some(dir) = out.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir)?;
        }
    }
    std::fs::write(out, serde_json::to_string_pretty(&doc).unwrap())?;
    Ok(())
}

// ───────────────────────────── 度量原语 ─────────────────────────────

/// 当前进程的常驻内存（字节）。
///
/// ⚠️ `libc::mach_task_self` 被标了 `deprecated`（libc 建议改用 `mach2` crate）。
/// 这里**故意不加**那个依赖：为了两次 `task_info` 引一个 crate 不划算。
/// 将来真要做详细的内存剖析再换。
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn current_rss_bytes() -> Option<u64> {
    let mut info: libc::mach_task_basic_info_data_t = unsafe { std::mem::zeroed() };
    let mut count = libc::MACH_TASK_BASIC_INFO_COUNT;
    let kr = unsafe {
        libc::task_info(
            libc::mach_task_self(),
            libc::MACH_TASK_BASIC_INFO,
            &mut info as *mut libc::mach_task_basic_info_data_t as libc::task_info_t,
            &mut count,
        )
    };
    if kr != libc::KERN_SUCCESS {
        return None;
    }
    Some(info.resident_size)
}

/// 内核记录的**历史峰值** RSS。比采样更准（不会漏掉两次采样之间的尖峰）。
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn resident_size_max_bytes() -> Option<u64> {
    let mut info: libc::mach_task_basic_info_data_t = unsafe { std::mem::zeroed() };
    let mut count = libc::MACH_TASK_BASIC_INFO_COUNT;
    let kr = unsafe {
        libc::task_info(
            libc::mach_task_self(),
            libc::MACH_TASK_BASIC_INFO,
            &mut info as *mut libc::mach_task_basic_info_data_t as libc::task_info_t,
            &mut count,
        )
    };
    if kr != libc::KERN_SUCCESS {
        return None;
    }
    Some(info.resident_size_max)
}

#[cfg(not(target_os = "macos"))]
fn current_rss_bytes() -> Option<u64> {
    None
}
#[cfg(not(target_os = "macos"))]
fn resident_size_max_bytes() -> Option<u64> {
    None
}

#[cfg(target_os = "macos")]
fn sysctl_string(name: &str) -> Option<String> {
    let cname = std::ffi::CString::new(name).ok()?;
    let mut buf = [0u8; 256];
    let mut len = buf.len();
    let rc = unsafe {
        libc::sysctlbyname(
            cname.as_ptr(),
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(len);
    Some(String::from_utf8_lossy(&buf[..end]).to_string())
}

#[cfg(not(target_os = "macos"))]
fn sysctl_string(_name: &str) -> Option<String> {
    None
}

fn machine_model() -> String {
    sysctl_string("hw.model")
        .or_else(|| sysctl_string("machdep.cpu.brand_string"))
        .unwrap_or_else(|| "unknown".into())
}

fn os_release() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

fn profile() -> &'static str {
    if cfg!(debug_assertions) { "debug" } else { "release" }
}

/// 本机当前 UTC 日期。
fn utc_date() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant 的 `civil_from_days`。手写是因为**不想为一行日期引入一个 crate**。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn fmt_ms(v: f64) -> String {
    if v >= 100.0 { format!("{v:.1} ms") } else { format!("{v:.2} ms") }
}

fn human_bytes(b: usize) -> String {
    human_bytes_u64(b as u64)
}

fn human_bytes_u64(b: u64) -> String {
    const K: f64 = 1024.0;
    let f = b as f64;
    if f < K {
        format!("{b} B")
    } else if f < K * K {
        format!("{:.1} KB", f / K)
    } else if f < K * K * K {
        format!("{:.1} MB", f / (K * K))
    } else {
        format!("{:.2} GB", f / (K * K * K))
    }
}

fn pad(s: &str, w: usize) -> String {
    let cur: usize = s
        .chars()
        .map(|c| {
            let u = c as u32;
            if matches!(u, 0x1100..=0x115F | 0x2E80..=0x303E | 0x3041..=0x33FF | 0x3400..=0x4DBF
                | 0x4E00..=0x9FFF | 0xA000..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF
                | 0xFE30..=0xFE6F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6
                | 0x1F300..=0x1FAFF | 0x20000..=0x3FFFD) { 2 } else { 1 }
        })
        .sum();
    let mut out = s.to_string();
    if cur < w {
        out.push_str(&" ".repeat(w - cur));
    }
    out
}
