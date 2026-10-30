//! 步骤 0 · **技术风险先行**（`docs/design/0002` §7.0）。
//!
//! 设计原文把话说死了：「两步都必须在写原型代码之前完成，因为它们的结论会改变原型的
//! 写法（不是"跑完再改"）」。所以这个子命令先于一切跑。
//!
//! 它回答的是 1–5 五件事：
//!
//! | # | 问题 | 期望 |
//! |---|---|---|
//! | 1 | comrak 的 `sourcepos` 到底给到什么粒度 | 复现 `kb/0002`；**不符就先回去改那份 kb** |
//! | 2 | `render.sourcepos = true` 让 HTML 长了多少 | 一个可引用的倍数 |
//! | 3 | HTML 长度 / 源长度 | 两个数（开关各一次） |
//! | 4 | 代码围栏里的 `#` 会不会被误判成标题 | **不会** |
//! | 5 | `(行, 列)` → 全局字节偏移 的换算 | **正确**，含 CRLF |
//!
//! 第 6 项（标题 ID 与目录）不在设计里，顺手做了——它验的是 `docs/adr/0003`
//! 「文档级统一分配 ID」这条，而验证成本几乎为零。

use std::path::PathBuf;

use clap::Args;

use crate::document::loader;
use crate::document::offset::{ColUnit, LineIndex};
use crate::document::parser::ParseOpts;
use crate::document::{render, search, toc};

/// ⚠️ 样例**内置**在源码里，不落磁盘：这样才能保证"别人跑出来的数字和我的一样"。
/// 覆盖：中文标题、重复标题（验 ID 去重）、围栏里带 `#` 的行（验步骤 4）、
/// 表格、强调、带 `&` 的链接、HTML 实体、4 字节 emoji、引用、嵌套列表、任务列表。
const SAMPLE_MD: &str = r##"# 中文标题

这是**加粗**与*斜体*，还有 `行内代码` 与链接 [示例](https://example.com/a?b=1&c=2)。

## 重复标题

| 列 A | 列 B |
| --- | ---: |
| 值 1 | 值 2 |

```rust
fn main() {
    // # 这行看起来像标题，但在围栏里
    println!("你好");
}
```

## 重复标题

实体：&amp; &lt; &#39;；emoji：🚀 🇨🇳；行内代码里的 `# 也是井号`。

> 引用块第一行
> 引用块第二行

- 列表项 1
- 列表项 2
  - 嵌套项

- [ ] 未完成
- [x] 已完成

结束段落。
"##;

#[derive(Debug, Args)]
pub struct ProbeArgs {
    /// 改跑一份真实文件（默认跑内置样例）
    #[arg(long, value_name = "PATH")]
    file: Option<PathBuf>,

    /// 节点明细表最多打几行
    #[arg(long, default_value_t = 40)]
    limit: usize,

    /// 跳过 CRLF 那一轮
    #[arg(long)]
    no_crlf: bool,

    /// 只在有失败项时详细输出
    #[arg(long)]
    brief: bool,
}

pub fn run(args: &ProbeArgs) -> i32 {
    println!("rmd {} · 步骤 0（技术风险先行）", env!("CARGO_PKG_VERSION"));
    println!(
        "comrak {} · 平台 {} · 目标 {}",
        comrak::version(),
        std::env::consts::ARCH,
        std::env::consts::OS
    );

    let (label, source) = match &args.file {
        Some(p) => match loader::load(p) {
            Ok(l) => {
                println!(
                    "样例：{}（{} B{}）",
                    p.display(),
                    l.raw_bytes,
                    if l.had_bom { "，已剥 BOM" } else { "" }
                );
                (p.display().to_string(), l.source)
            }
            Err(e) => {
                eprintln!("读不了 {}：{e}", p.display());
                return 1;
            }
        },
        None => {
            println!("样例：内置 SAMPLE_MD（{} B，故意含中文与 emoji）", SAMPLE_MD.len());
            ("内置样例".to_string(), SAMPLE_MD.to_string())
        }
    };

    let mut failed = 0usize;
    failed += step_1_positions(&source, args);
    failed += step_2_3_html_size(&source);
    failed += step_4_fence_hash(&source);
    failed += step_5_offset_conversion(&source, args);
    failed += step_6_heading_ids(&source, args);

    println!();
    if failed == 0 {
        println!("✅ 五步全部符合预期。数字可回填 design/0002 §10。");
    } else {
        println!("⛔ {failed} 项不符合预期——**先别往下写代码**，回去改文档（kb 或 design）。");
    }
    // `label` 只是给人看的，避免 unused 警告的同时留个痕
    let _ = label;
    failed.min(127) as i32
}

// ───────────────────────────── 步骤 1 ─────────────────────────────

/// 打印节点位置明细 + 做三项机械校验。
fn step_1_positions(src: &str, args: &ProbeArgs) -> usize {
    section("【1】comrak `sourcepos` 的粒度与内容（复现 kb/0002）");

    let index = LineIndex::new(src);
    let opts = ParseOpts::default();

    let outcome = crate::document::parser::with_parsed(src, &opts, |root| {
        let spans = check_spans(root, src, &index, ColUnit::Bytes);
        let mut rows = Vec::new();
        for (i, node) in root.descendants().enumerate() {
            if i >= args.limit {
                break;
            }
            let data = node.data();
            let kind = kind_of(&data.value);
            let sp = data.sourcepos;
            let depth = depth_of(node);
            drop(data);
            let span = index.span(src, &sp, ColUnit::Bytes);
            let sliced = span.clone().and_then(|r| src.get(r)).unwrap_or("<越界>");
            rows.push(format!(
                "  {:>3} {}{}  {:>3}:{:<3}→{:>3}:{:<3}  {}  {}",
                i,
                "  ".repeat(depth.min(12)),
                pad(kind, 14),
                sp.start.line,
                sp.start.column,
                sp.end.line,
                sp.end.column,
                pad(&span.map(|r| format!("{}..{}", r.start, r.end)).unwrap_or("—".into()), 14),
                esc(&truncate(sliced, 34)),
            ));
        }
        (spans, rows)
    });

    let (spans, rows) = outcome;
    println!("  节点总数 {}，下面按前 {} 条打印：", spans.nodes, args.limit.min(spans.nodes));
    println!(
        "  {:>3}  {}  {}  {}  {}",
        "#", pad("节点", 14), pad("行列 (1-based)", 20), pad("字节区间", 14), "切片"
    );
    for r in &rows {
        println!("{r}");
    }

    println!();
    let mut failed = 0;
    failed += report(
        &format!("① 每个 sourcepos 都能换算成合法字节区间（{} 个节点）", spans.nodes),
        &spans.span_failures,
    );
    failed += report(
        "② 子节点区间被父节点区间包含（AST 的树形结构与源码位置自洽）",
        &spans.containment_failures,
    );

    if !args.brief {
        println!("  ℹ️ 列口径：parse.sourcepos_chars = false ⇒ **列按 UTF-8 字节**（comrak 默认）");
    }
    failed
}

// ─────────────────────── 步骤 2 / 3 ───────────────────────

/// 量 `data-sourcepos` 与标题 `id` 给 HTML 带来的体积。
fn step_2_3_html_size(src: &str) -> usize {
    section("【2/3】HTML 长度 / 源长度（`render.sourcepos` 与标题 `id` 各开关一次）");

    // ⚠️ 四个变体一律**关掉公式**（`design/0007` §2.1.2 的开关）：本步要量的差值是
    //    `data-sourcepos` 与标题 `id` 各自带来的体积，多开一个会把"本次多了多少公式"
    //    混进这个差值里（`math_dollars` 会计入 HTML 长度）。
    let variants: [(&str, ParseOpts); 4] = [
        (
            "朴素",
            ParseOpts {
                render_sourcepos: false,
                sourcepos_chars: false,
                heading_ids: false,
                math_dollars: false,
                hardbreaks: false,
            },
        ),
        (
            "+sourcepos",
            ParseOpts {
                render_sourcepos: true,
                sourcepos_chars: false,
                heading_ids: false,
                math_dollars: false,
                hardbreaks: false,
            },
        ),
        (
            "+标题id",
            ParseOpts {
                render_sourcepos: false,
                sourcepos_chars: false,
                heading_ids: true,
                math_dollars: false,
                hardbreaks: false,
            },
        ),
        (
            "+两者",
            ParseOpts {
                render_sourcepos: true,
                sourcepos_chars: false,
                heading_ids: true,
                math_dollars: false,
                hardbreaks: false,
            },
        ),
    ];

    println!("  源长度 {} B", src.len());
    println!(
        "  {}  {}  {}  {}  {}",
        pad("变体", 12),
        pad("HTML 字节", 12),
        pad("HTML/源", 10),
        pad("data-sourcepos", 16),
        "标题 id 数"
    );

    let mut base = 0usize;
    for (label, opts) in variants {
        let html = crate::document::parser::with_parsed(src, &opts, |root| render::to_html(root, &opts));
        if label == "朴素" {
            base = html.len();
        }
        let sp = html.matches("data-sourcepos").count();
        let ids = html.matches("<h").count();
        println!(
            "  {}  {}  {}  {}  {}",
            pad(label, 12),
            pad(&html.len().to_string(), 12),
            pad(&format!("{:.2}×", html.len() as f64 / src.len().max(1) as f64), 10),
            pad(&sp.to_string(), 16),
            ids
        );
        if label != "朴素" {
            println!(
                "  {}  → 相对朴素 {:+.1}%（{} B）",
                pad("", 12),
                (html.len() as f64 / base.max(1) as f64 - 1.0) * 100.0,
                html.len() as isize - base as isize
            );
        }
    }

    println!();
    println!("  ⚠️ 「标题 id」那两行**不只是加了个 `id=`**：comrak 会同时给每个标题套一个");
    println!("     <a href=\"#…\" aria-label=\"…\" data-heading-content=\"…\"> 包装。膨胀主要来自这里。");
    0
}

// ───────────────────────────── 步骤 4 ─────────────────────────────

/// 围栏里的 `#` 不能变成标题。
fn step_4_fence_hash(src: &str) -> usize {
    section("【4】代码围栏内的 `#` 不被误判为标题");

    let opts = ParseOpts::default();
    let (headings, code_literals) = crate::document::parser::with_parsed(src, &opts, |root| {
        let mut hs = Vec::new();
        let mut codes = Vec::new();
        for node in root.descendants() {
            let data = node.data();
            match &data.value {
                comrak::nodes::NodeValue::Heading(h) => {
                    hs.push((h.level, node.collect_text(), data.sourcepos.start.line))
                }
                comrak::nodes::NodeValue::CodeBlock(cb) => codes.push(cb.literal.clone()),
                _ => {}
            }
        }
        (hs, codes)
    });

    println!("  识别出的标题 {} 个：", headings.len());
    for (lvl, text, line) in &headings {
        println!("    h{lvl}  L{line}  {text}");
    }
    println!("  识别出的围栏代码块 {} 个，其中字面量含 `#` 的有 {} 个",
        code_literals.len(),
        code_literals.iter().filter(|c| c.contains('#')).count());

    let mut failures = Vec::new();
    for (_, text, _) in &headings {
        if text.contains("这行看起来像标题") {
            failures.push("围栏里的 `# 这行看起来像标题` 变成了标题".to_string());
        }
    }
    let has_fence_hash = code_literals.iter().any(|c| c.contains("# 这行看起来像标题"));
    if !has_fence_hash && src.contains("# 这行看起来像标题") {
        failures.push("围栏里的那行**没有**出现在 CodeBlock 字面量里（可能被别的规则吃掉了）".into());
    }
    // 行内代码里的 `#` 也不该造出标题
    if headings.iter().any(|(_, t, _)| t.contains("也是井号")) {
        failures.push("行内代码里的 `# 也是井号` 变成了标题".into());
    }

    let has_dup = headings.iter().filter(|(_, t, _)| t == "重复标题").count() == 2;
    if src.contains("## 重复标题") && !has_dup {
        failures.push("两个 `## 重复标题` 没有都识别出来".into());
    }

    report("围栏 / 行内代码里的 `#` 均未被当作标题", &failures)
}

// ───────────────────────────── 步骤 5 ─────────────────────────────

/// `(行, 列)` → 全局字节偏移。
fn step_5_offset_conversion(src: &str, args: &ProbeArgs) -> usize {
    section("【5】`(行, 列)` → 全局 UTF-8 字节偏移的换算");

    let index = LineIndex::new(src);
    let opts = ParseOpts::default();
    let mut failed = 0;

    // —— 5a：LF 文档 ——
    let lf = check_spans_call(src, &opts, &index, ColUnit::Bytes);
    println!("  LF   ：行数 {}，共 {} 个节点", index.line_count(), lf.nodes);
    failed += report("  全部 sourcepos 换算成功且父区间包含子区间", &lf.all_failures());

    // —— 5b：字节列 vs 字符列：拿第一个标题做实例 ——
    if let Some(demo) = byte_vs_char_demo(src, &index) {
        println!();
        println!("  口径实例（第一个标题）：");
        println!("    行内容           {}", demo.line_text);
        println!("    comrak 给的列号  {}", demo.cols);
        println!("    正确解读         {}", demo.right);
        println!("    ⛔ 若把 end 当\"最后字符的起点\"（常见的错读） →  {}", demo.naive_wrong);
        println!("    {}", demo.consequence);
        if demo.wrong_reading_is_detectable {
            println!("    ✅ 好消息：错读在这台机器上会被 `is_char_boundary` 抓住（不是静默的）——");
            println!("       但**别指望它**：只要文本恰好是 ASCII，错读也能蒙对。");
        }
    }

    // —— 5c：CRLF ——
    if !args.no_crlf {
        println!();
        if src.contains("\r\n") {
            println!("  ⚠️ 样例本身已经含 CRLF，跳过 CRLF 变形（否则会叠成 CRCRLF）");
        } else {
            let crlf = src.replace('\n', "\r\n");
            let crlf_index = LineIndex::new(&crlf);
            let crlf_check = check_spans_call(&crlf, &opts, &crlf_index, ColUnit::Bytes);
            println!(
                "  CRLF ：源 {} B（LF 版 {} B），行数 {}",
                crlf.len(),
                src.len(),
                crlf_index.line_count()
            );
            println!(
                "         每个 `\\n` 前各插一个 `\\r`，共 {} 处",
                src.matches('\n').count()
            );
            failed += report(
                "  全部 sourcepos 换算成功且父区间包含子区间",
                &crlf_check.all_failures(),
            );
            // CRLF 特有的：标题区间不该把 `\r` 吃进去
            let diffs = crlf_only_check(&crlf, &crlf_index);
            failed += report("  标题字节区间**不含** `\\r`（行尾的 `\\r` 没被算进节点）", &diffs);
        }
    }

    failed
}

/// 5b 的实例数据。
struct ByteCharDemo {
    line_text: String,
    cols: String,
    right: String,
    naive_wrong: String,
    consequence: String,
    wrong_reading_is_detectable: bool,
}

/// 拿第一个标题做「字节列 vs 字符列」的对照实例。
///
/// ⚠️ 这是给评审看的：同一条 `sourcepos`，口径弄错时**不会报错**，
/// 只会切到字符中间——所以这里把"错的那个答案"也打出来。
fn byte_vs_char_demo(src: &str, index: &LineIndex) -> Option<ByteCharDemo> {
    let opts = ParseOpts::default();

    let (line_no, sc, ec) = crate::document::parser::with_parsed(src, &opts, |root| {
        for node in root.descendants() {
            let data = node.data();
            if let comrak::nodes::NodeValue::Heading(_) = &data.value {
                let sp = data.sourcepos;
                return Some((sp.start.line, sp.start.column, sp.end.column));
            }
        }
        None
    })?;

    let line_text = index.line_str(src, line_no)?.to_string();
    let line_start = index.line_start(line_no)?;
    let sp = comrak::nodes::Sourcepos {
        start: comrak::nodes::LineColumn { line: line_no, column: sc },
        end: comrak::nodes::LineColumn { line: line_no, column: ec },
    };

    let right = index
        .slice(src, &sp, ColUnit::Bytes)
        .map(|s| format!("{s:?}"))
        .unwrap_or_else(|| "<换算失败>".into());

    // —— 错的读法：把 end.column 当成"最后一个字符的 1-based 下标" ——
    // 然后取那个字符并跨过它。纯英文文档上这**恰好也对**（ASCII 一字符一字节），
    // 中文上会落在字符中间。
    let naive_last = line_start + ec - 1;
    let naive_wrong = if naive_last < src.len() && src.is_char_boundary(naive_last) {
        let l = src[naive_last..].chars().next().map(char::len_utf8).unwrap_or(0);
        format!("{:?}（与本行的正确结果**看不出差别**——这就是它危险的地方）", &src[line_start..naive_last + l])
    } else {
        format!("<切在字符中间，偏移 {naive_last}> ← 能被 is_char_boundary 抓住")
    };

    // —— 反向对照：用**字符口径**解析同一段文本，再拿字节口径去解读它 ——
    // 这才是"口径用错"真正的样子：两种模式给出的列号数值完全不同，
    // 而它们只在纯 ASCII 文本上恰好相等。
    let char_mode = crate::document::parser::with_parsed(
        src,
        &ParseOpts { sourcepos_chars: true, ..ParseOpts::default() },
        |root| {
            for node in root.descendants() {
                let data = node.data();
                if let comrak::nodes::NodeValue::Heading(_) = &data.value {
                    let sp = data.sourcepos;
                    return Some((sp.start.column, sp.end.column));
                }
            }
            None
        },
    );

    let consequence = match char_mode {
        Some((sc2, ec2)) => {
            let sp2 = comrak::nodes::Sourcepos {
                start: comrak::nodes::LineColumn { line: line_no, column: sc2 },
                end: comrak::nodes::LineColumn { line: line_no, column: ec2 },
            };
            let wrong = index
                .slice(src, &sp2, ColUnit::Bytes)
                .map(|s| format!("{s:?}"))
                .unwrap_or_else(|| "<切在字符中间>".into());
            format!(
                "同一段文本用字符口径解析时列号变成 {sc2}–{ec2}（而不是 {sc}–{ec}）——\
                 两个数完全不同。若把 {ec2} 当字节列去切，得到的是 {wrong}。\
                 ⛔ 全程没有任何报错。"
            )
        }
        None => "（字符口径对照失败）".to_string(),
    };

    let detectable = naive_wrong.starts_with('<');
    Some(ByteCharDemo {
        line_text: format!("L{line_no}  {line_text:?}"),
        cols: format!("start.column = {sc}，end.column = {ec}（差 {} 个单位）", ec - sc),
        right: format!("{right}（字节口径 + 正确的 end 语义）"),
        naive_wrong,
        consequence,
        wrong_reading_is_detectable: detectable,
    })
}

/// CRLF 专属检查：标题区间里不该出现 `\r`。
fn crlf_only_check(src: &str, index: &LineIndex) -> Vec<String> {
    let opts = ParseOpts::default();
    crate::document::parser::with_parsed(src, &opts, |root| {
        let mut bad = Vec::new();
        let mut toc = Vec::new();
        for node in root.descendants() {
            let data = node.data();
            if let comrak::nodes::NodeValue::Heading(h) = &data.value {
                let sp = data.sourcepos;
                let _ = h;
                if let Some(r) = index.span(src, &sp, ColUnit::Bytes) {
                    if src[r.clone()].contains('\r') {
                        toc.push(format!("L{} 区间含 \\r：{:?}", sp.start.line, &src[r]));
                    }
                }
            }
        }
        bad.extend(toc.into_iter().take(3));
        bad
    })
}

// ───────────────────────────── 步骤 6（附加）─────────────────────────────

/// 标题 ID：本项目的 `toc` 模块 vs comrak 自己输出的 `id`。
///
/// 这条不是设计里的，但它验的是 `docs/adr/0003`「文档级统一分配 ID」——
/// 两条路算出来必须**逐字一致**，否则分块渲染一上线锚点就会错。
fn step_6_heading_ids(src: &str, args: &ProbeArgs) -> usize {
    section("【6】目录与标题 ID（附加：验 adr/0003 的文档级分配）");

    let index = LineIndex::new(src);
    let ours = crate::document::parser::with_parsed(src, &ParseOpts::default(), |root| {
        toc::build(root, src, &index, ColUnit::Bytes)
    });

    println!("  目录 {} 项：", ours.len());
    for e in &ours {
        println!(
            "    {}  {}  {}  {}",
            pad(&format!("h{}", e.level), 4),
            pad(&e.id, 22),
            pad(&format!("{}..{}", e.span.start, e.span.end), 14),
            e.text
        );
    }

    // comrak 自己的 id
    let comrak_opts = ParseOpts { heading_ids: true, ..ParseOpts::default() };
    let html =
        crate::document::parser::with_parsed(src, &comrak_opts, |root| render::to_html(root, &comrak_opts));
    let theirs = extract_heading_ids(&html);

    println!();
    println!("  comrak 自渲染的 id：{} 个", theirs.len());
    let mut failures = Vec::new();
    if theirs.len() != ours.len() {
        failures.push(format!(
            "数量不一致：本模块 {} vs comrak {}",
            ours.len(),
            theirs.len()
        ));
    } else {
        for (i, (a, b)) in ours.iter().zip(theirs.iter()).enumerate() {
            if &a.id != b {
                failures.push(format!("第 {} 项的 id 不同：{} vs {}", i + 1, a.id, b));
            }
        }
    }

    // 搜索演示（顺带把 search 模块跑通，验 §2.3 的偏移契约）
    if !args.brief {
        let hits = search::find_all(src, "标题", &index);
        println!("  顺带：在源串里搜 `标题` 命中 {} 处", hits.len());
        for h in hits.iter().take(4) {
            println!(
                "    L{} 字节 {}..{}  行内 UTF-16 {}..{}  {}",
                h.line,
                h.span.start,
                h.span.end,
                h.utf16_in_line.start,
                h.utf16_in_line.end,
                h.excerpt
            );
        }
        println!("  ⚠️ 字节偏移与 UTF-16 偏移**不是一回事**——中文行上两者差 {} 倍左右",
            3);
    }

    report("本模块与 comrak 算出的标题 id 逐字一致", &failures)
}

/// 从 HTML 里抠出 `<hN id="…"`。
fn extract_heading_ids(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = html.as_bytes();
    let mut i = 0usize;
    while let Some(rel) = html[i..].find("<h") {
        let at = i + rel;
        // 形如 <h1 id="xxx">
        if bytes.get(at + 2).is_some_and(|b| b.is_ascii_digit()) {
            if let Some(q) = html[at..].find("id=\"") {
                let s = at + q + 4;
                if let Some(e) = html[s..].find('"') {
                    out.push(html[s..s + e].to_string());
                }
            }
        }
        i = at + 2;
    }
    out
}

// ───────────────────────────── 机械校验 ─────────────────────────────

struct SpanChecks {
    nodes: usize,
    span_failures: Vec<String>,
    containment_failures: Vec<String>,
}

impl SpanChecks {
    fn all_failures(&self) -> Vec<String> {
        let mut v = self.span_failures.clone();
        v.extend(self.containment_failures.iter().cloned());
        v
    }
}

fn check_spans_call(src: &str, opts: &ParseOpts, index: &LineIndex, unit: ColUnit) -> SpanChecks {
    crate::document::parser::with_parsed(src, opts, |root| check_spans(root, src, index, unit))
}

fn check_spans<'a>(
    root: &'a comrak::nodes::AstNode<'a>,
    src: &str,
    index: &LineIndex,
    unit: ColUnit,
) -> SpanChecks {
    use comrak::nodes::AstNode;

    let mut checks = SpanChecks { nodes: 0, span_failures: Vec::new(), containment_failures: Vec::new() };
    let mut me: Vec<(usize, usize)> = Vec::new();

    for node in root.descendants() {
        checks.nodes += 1;
        let (sp, _kind) = {
            let data = node.data();
            (data.sourcepos, kind_of(&data.value))
        };

        let span = index.span(src, &sp, unit);
        let Some(r) = span else {
            if checks.span_failures.len() < 5 {
                checks.span_failures.push(format!(
                    "{} @ {}:{}–{}:{} 换算失败",
                    _kind, sp.start.line, sp.start.column, sp.end.line, sp.end.column
                ));
            }
            continue;
        };
        me.push((r.start, r.end));

        // 父区间必须包含子区间
        let parent: Option<&'a AstNode<'a>> = node.parent();
        if let Some(p) = parent {
            let psp = p.data().sourcepos;
            if let Some(pr) = index.span(src, &psp, unit) {
                if !(pr.start <= r.start && r.end <= pr.end) {
                    if checks.containment_failures.len() < 5 {
                        checks.containment_failures.push(format!(
                            "{} {}..{} 越出了父 {}..{}",
                            _kind, r.start, r.end, pr.start, pr.end
                        ));
                    }
                }
            }
        }
    }

    checks
}

/// 打印一个校验项的结果；返回失败个数（0 或 1）。
fn report(label: &str, failures: &[String]) -> usize {
    if failures.is_empty() {
        println!("  ✅ {label}");
        0
    } else {
        println!("  ⛔ {label}");
        for f in failures.iter().take(5) {
            println!("       · {f}");
        }
        if failures.len() > 5 {
            println!("       … 另有 {} 条", failures.len() - 5);
        }
        1
    }
}

// ───────────────────────────── 小工具 ─────────────────────────────

fn section(title: &str) {
    println!();
    println!("{title}");
    println!("{}", "─".repeat(viz_width(title).max(24)));
}

fn kind_of(v: &comrak::nodes::NodeValue) -> &'static str {
    use comrak::nodes::NodeValue as V;
    match v {
        V::Document => "Document",
        V::FrontMatter(_) => "FrontMatter",
        V::BlockQuote => "BlockQuote",
        V::List(_) => "List",
        V::Item(_) => "Item",
        V::CodeBlock(_) => "CodeBlock",
        V::HtmlBlock(_) => "HtmlBlock",
        V::Paragraph => "Paragraph",
        V::Heading(_) => "Heading",
        V::ThematicBreak => "ThematicBreak",
        V::Table(_) => "Table",
        V::TableRow(_) => "TableRow",
        V::TableCell => "TableCell",
        V::Text(_) => "Text",
        V::TaskItem(_) => "TaskItem",
        V::SoftBreak => "SoftBreak",
        V::LineBreak => "LineBreak",
        V::Code(_) => "Code",
        V::HtmlInline(_) => "HtmlInline",
        V::Raw(_) => "Raw",
        V::Emph => "Emph",
        V::Strong => "Strong",
        V::Strikethrough => "Strikethrough",
        V::Link(_) => "Link",
        V::Image(_) => "Image",
        V::FootnoteDefinition(_) => "FootnoteDef",
        V::FootnoteReference(_) => "FootnoteRef",
        V::Math(_) => "Math",
        V::Escaped => "Escaped",
        V::EscapedTag(_) => "EscapedTag",
        _ => "Other",
    }
}

fn depth_of<'a>(node: &'a comrak::nodes::AstNode<'a>) -> usize {
    let mut d = 0usize;
    let mut cur = node.parent();
    while let Some(p) = cur {
        d += 1;
        cur = p.parent();
    }
    d
}

fn esc(s: &str) -> String {
    s.replace('\r', "␍").replace('\n', "⏎").replace('\t', "⇥")
}

fn truncate(s: &str, n: usize) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= n {
            out.push('…');
            break;
        }
        out.push(c);
    }
    out
}

fn pad(s: &str, w: usize) -> String {
    let cur = viz_width(s);
    let mut out = s.to_string();
    if cur < w {
        out.push_str(&" ".repeat(w - cur));
    }
    out
}

/// 终端里的显示宽度：CJK / emoji 算 2 列。
///
/// 纯 ASCII 表格用不上，但本项目的中文样例一进来，不这么算表格就会全部错位。
fn viz_width(s: &str) -> usize {
    s.chars()
        .map(|c| {
            let u = c as u32;
            let wide = matches!(u,
                0x1100..=0x115F | 0x2E80..=0x303E | 0x3041..=0x33FF | 0x3400..=0x4DBF
                | 0x4E00..=0x9FFF | 0xA000..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF
                | 0xFE30..=0xFE6F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6
                | 0x1F300..=0x1FAFF | 0x20000..=0x3FFFD);
            if wide { 2 } else { 1 }
        })
        .sum()
}
