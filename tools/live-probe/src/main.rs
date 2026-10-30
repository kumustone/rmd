//! 0047 候选原型探针 —— **只出可运行证据，⛔ 不接入产品默认路径**。
//!
//! 三件事（对应 `docs/design/0047` §7.1）：
//!
//! - **0a**：块表的**覆盖率** ＋ **往返稳定性**（把块行区间切出来重新 parse，还是同一块吗）
//! - **0b（半）**：`blocks` 序列化后多大、生成多久 —— ⚠️ 不含 HTML 那一侧，判据需产品侧补
//! - **0e（Rust 半）**：7 类信封的**行数不变**与 `restore(normalize(raw)) == raw`
//!
//! ⚠️ 这里**不抄第二份实现**：`parser` / `offset` / `envelope` / `link` 四份
//! **按 `#[path]` 直接编译产品源码**（`INV-SINGLE-01` 的探针版）。
//! ⇒ 探针与产品一旦分叉，这里编译就会断，⛔ 不会静默跑两份。
//!
//! ⚠️ **只用 `cargo run`**：`#[cfg(test)]` 那几段产品测试会引用 `render`/`toc`（本探针不装它们）。

#[path = "../../../src-tauri/src/link.rs"]
#[allow(dead_code)]
mod link;

mod document;
mod fixtures;

use comrak::Arena;
use comrak::nodes::{AstNode, NodeValue};
use document::envelope::{Eol, Envelope};
use document::parser::{ParseOpts, parse};
use std::path::Path;
use std::time::Instant;

/// ⚠️ 与 `src-tauri/src/commands/document.rs:55-77` 的 `GUI_OPTS` **逐字段相同**。
/// 一旦那边改字段，这里编译不过（`const` 少一个字段就是编译错误），这正是想要的。
/// ⚠️ `render_sourcepos` 必须是 `false`：块表只能走 AST 的 `sourcepos`。
const GUI_OPTS: ParseOpts = ParseOpts {
    render_sourcepos: false,
    sourcepos_chars: false,
    heading_ids: true,
    math_dollars: true,
    hardbreaks: true,
};

#[derive(Debug, Clone)]
struct BlockRow {
    index: usize,
    kind: String,
    start_line: u32,
    end_line: u32,
    /** `sourcepos` 缺失（`start.line == 0`）⇒ 天然不可编辑。 */
    no_sourcepos: bool,
}

/// ⭐ 这个顶层块**允不允许就地编辑**（`design/0047` §2.3 / §2.8 的候选口径）。
///
/// 判据是「在流里就地改它会不会改版面」——会 ⇒ 不进 CM6，单击走「跳到分栏并定位」。
///
/// ⚠️ **`FootnoteDefinition` 是本轮探针跑出来的新增项**（原清单里没有它）：
/// comrak **只在定义被别处引用时才物化它**，把它的行区间单独切出来重 parse 得到 **0 个块**
/// ⇒ "单块视图"对它没有意义（证据：`--fixtures` 的脚注两条）。
/// ⚠️ **一处定义、两处使用**：块表载荷（`blocks[*].editable`）与
/// [`roundtrip_issues`] 的"要不要往返"必须**问同一个函数**，
/// 否则会出现"标了不可编辑、却因为往返不稳定而报红"这种自相矛盾的报告。
fn editable_kind(kind: &str) -> bool {
    !matches!(
        kind,
        "Table" | "ThematicBreak" | "Math" | "HtmlBlock" | "FootnoteDefinition"
    )
}

fn kind_name(v: &NodeValue) -> &'static str {    match v {
        NodeValue::Document => "Document",
        NodeValue::BlockQuote => "BlockQuote",
        NodeValue::List(_) => "List",
        NodeValue::Item(_) => "Item",
        NodeValue::CodeBlock(_) => "CodeBlock",
        NodeValue::HtmlBlock(_) => "HtmlBlock",
        NodeValue::Paragraph => "Paragraph",
        NodeValue::Heading(_) => "Heading",
        NodeValue::ThematicBreak => "ThematicBreak",
        NodeValue::Table(_) => "Table",
        NodeValue::TableRow(_) => "TableRow",
        NodeValue::TableCell => "TableCell",
        NodeValue::FootnoteDefinition(_) => "FootnoteDefinition",
        NodeValue::Math(_) => "Math",
        NodeValue::Text(_) => "Text",
        _ => "Other",
    }
}

/// 从一个**已经解析好**的 AST 取顶层块表（`blocks.rs` 拟实现的纯函数，⛔ 不重新 parse）。
///
/// ⭐ 拆成两半是为了把成本量准：产品侧渲染**本来就要 parse 一遍**
/// （`commands/document.rs` 的 `parse → render`），块表只是**在既有 AST 上走一层**。
/// ⇒ 真正新增的成本是这一段的遍历时间，⛔ 不是整个 parse 的时间。
fn blocks_of<'a>(root: &'a AstNode<'a>) -> Vec<BlockRow> {
    root.children()
        .enumerate()
        .map(|(index, n)| {
            let d = n.data();
            let sp = d.sourcepos;
            BlockRow {
                index,
                kind: kind_name(&d.value).to_string(),
                start_line: sp.start.line as u32,
                end_line: sp.end.line as u32,
                no_sourcepos: sp.start.line == 0,
            }
        })
        .collect()
}

/// 顶层块表（parse ＋ 遍历）。⚠️ 只用于"给个整数"的场合；**成本判据请用 `blocks_of`**。
fn top_blocks(src: &str) -> Vec<BlockRow> {
    let arena = Arena::new();
    let root = parse(&arena, src, &GUI_OPTS);
    blocks_of(root)
}

/// 取 `[start_line, end_line]`（1-based，含）的源码切片。
///
/// ⚠️ 行数组**必须由调用方预先切好**：早先版本在函数里 `src.split('\n').collect()`，
/// 于是每个块都要把 10 MB 源扫一遍 ⇒ O(块数 × 行数)，在 XL 语料上跑不完。这就是那一版被换掉的原因。
fn slice_lines(lines: &[&str], start: u32, end: u32) -> Option<String> {
    let a = (start as usize).checked_sub(1)?;
    let b = end as usize;
    if a >= b || b > lines.len() {
        return None;
    }
    Some(lines[a..b].join("\n"))
}

/// 往返判定：切片单独 parse 后，是否**恰好一个**顶层块，且**同类、且首尾正好盖住切片**。
fn round_trip(slice: &str) -> Result<(String, u32, u32), String> {
    let arena = Arena::new();
    let root = parse(&arena, slice, &GUI_OPTS);
    let kids: Vec<&AstNode> = root.children().collect();
    if kids.len() != 1 {
        return Err(format!("切片重新 parse 得到 {} 个顶层块", kids.len()));
    }
    let d = kids[0].data();
    Ok((
        kind_name(&d.value).to_string(),
        d.sourcepos.start.line as u32,
        d.sourcepos.end.line as u32,
    ))
}

/// 对一份**全文**跑一遍往返判据，返回所有不稳定项。
///
/// ⚠️ 语料跑的是它，夹具（`fixtures.rs`）跑的也是它——⛔ 不许两处各写一份，
/// 否则"语料全绿"与"夹具全绿"就不再是同一个判据。
fn roundtrip_issues(src: &str, blocks: &[BlockRow]) -> Vec<String> {
    let lines: Vec<&str> = src.split('\n').collect();
    let mut issues = Vec::new();
    for b in blocks {
        if b.no_sourcepos {
            issues.push(format!("块 {}（{}）没有 sourcepos", b.index, b.kind));
            continue;
        }
        // ⚠️ 往返只对**允许就地编辑**的块要求：不可编辑块永远不进单块视图，
        //    "切片重 parse 还是同一块"对它没有意义（`FootnoteDefinition` 就是这样）。
        //    ⚠️ 但**结构/覆盖**判据对它们照旧成立——它们仍要有正确的 span（跳转要用）。
        if !editable_kind(&b.kind) {
            continue;
        }
        let Some(slice) = slice_lines(&lines, b.start_line, b.end_line) else {
            issues.push(format!(
                "块 {}（{}）行区间 {}-{} 越界",
                b.index, b.kind, b.start_line, b.end_line
            ));
            continue;
        };
        match round_trip(&slice) {
            Ok((kind, s, e)) => {
                let want_lines = b.end_line - b.start_line + 1;
                let got_lines = e.saturating_sub(s) + 1;
                if kind != b.kind {
                    issues.push(format!(
                        "块 {} 类型 {} ⇒ 重 parse 变成 {}（行 {}-{}）",
                        b.index, b.kind, kind, b.start_line, b.end_line
                    ));
                } else if got_lines != want_lines || s != 1 {
                    issues.push(format!(
                        "块 {}（{}）行 {}-{}（{} 行）⇒ 重 parse 得到行 {}-{}（{} 行）",
                        b.index, b.kind, b.start_line, b.end_line, want_lines, s, e, got_lines
                    ));
                }
            }
            Err(e) => issues.push(format!(
                "块 {}（{}）行 {}-{}：{e}",
                b.index, b.kind, b.start_line, b.end_line
            )),
        }
    }
    issues
}

/// ⭐ 0f 的**静态半**：单一巨大顶层块（§7.1 的 0f 原文「10 MB 一个围栏/列表/无空行段落」）。
///
/// ⚠️ 这里只量"切一块要多久、切出来多大、是不是仍是一个块"——
/// **输入延迟 p50/p95 量不了**（那要真 CM6 ＋ 可见窗口，属 0c/0f 的离屏那半）。
/// 判据的价值在另一头：**单块视图装不下整篇时，必须有一个 `LIVE_MAX_LINES` 兜底**。
fn probe_giant() {
    const TARGET: usize = 10 * 1024 * 1024;
    /// ⚠️ 每行都得**足够长**：10 MB 用 20 字节一行会切出 50 万个行，
    /// 节点数把测量变成"内存压力测试"，⛔ 那量不出块视图要面对的形态。
    /// 99 字节 ≈ 10 万行，既有"行数不小"，又还没到把 `Arena` 撑爆。
    const SENT: &str = "这是一段用来把单个顶层块撑到十兆的中文正文，长度大约三十三个字。";

    fn fill(unit: &str) -> String {
        let mut s = String::with_capacity(TARGET + unit.len() * 2);
        while s.len() < TARGET {
            s.push_str(unit);
        }
        s
    }

    /// 每行 = 前缀 ＋ 一句，直到够 10 MB；去尾换行（保持"无尾空行"）。
    fn fill_lines(prefix: &str) -> String {
        let mut s = String::with_capacity(TARGET + 128);
        while s.len() < TARGET {
            s.push_str(prefix);
            s.push_str(SENT);
            s.push('\n');
        }
        s.pop();
        s
    }

    let cases: Vec<(&str, String)> = vec![
        (
            "单行·整篇没有换行（10 MB 一行）",
            fill("这是一段很长很长的中文正文，用来把单行撑到十兆。"),
        ),
        ("单段·软换行（每行一句，全文没有一个空行）", fill_lines("")),
        ("单个围栏代码块", {
            let body = fill("let x = 1;\n");
            format!("```rust\n{body}```\n")
        }),
        ("单个列表（10 万个项）", fill_lines("- ")),
        ("单个引用块", fill_lines("> ")),
    ];

    println!("# 0f 静态半：单一巨大顶层块\n");
    println!("| 样本 | 大小 | 行 | 顶层块 | 最大块种类 | 最大块行数 | 最大块字节 | 往返 | parse(含遍历) | 切块 |");
    println!("|---|---|---|---|---|---|---|---|---|---|");

    let mut bad = 0usize;
    for (name, src) in &cases {
        let lines: Vec<&str> = src.split('\n').collect();
        let arena = Arena::new();
        let t0 = Instant::now();
        let root = parse(&arena, src, &GUI_OPTS);
        let blocks = blocks_of(root);
        let parse_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let biggest = blocks
            .iter()
            .max_by_key(|b| b.end_line - b.start_line)
            .map(|b| (b.kind.clone(), b.start_line, b.end_line));
        let (kind, span_lines, slice_bytes, rt, cut_ms) = match &biggest {
            Some((k, s, e)) => {
                let t1 = Instant::now();
                let slice = slice_lines(&lines, *s, *e).unwrap_or_default();
                let cut_ms = t1.elapsed().as_secs_f64() * 1000.0;
                let ok = round_trip(&slice)
                    .map(|(sk, _, _)| sk == *k)
                    .unwrap_or(false);
                (k.clone(), *e - *s + 1, slice.len(), ok, cut_ms)
            }
            None => ("—".to_string(), 0, 0, false, 0.0),
        };
        if !rt {
            bad += 1;
        }
        println!(
            "| {name} | {:.1} MiB | {} | {} | {} | {} | {} | {} | {:.0} ms | {:.0} ms |",
            src.len() as f64 / 1048576.0,
            lines.len(),
            blocks.len(),
            kind,
            span_lines,
            slice_bytes,
            if rt { "✅" } else { "❌" },
            parse_ms,
            cut_ms
        );
    }

    println!("\n⚠️ 单块视图 = 把上面那个「最大块」整段装进一个 CM6 实例。");
    println!("⇒ 只要它超过阈值就必须**拒绝就地编辑**并定 `LIVE_MAX_LINES`（§7.1 的 0f）。");
    println!("⛔ 输入延迟 p50/p95 与切块延迟需要真 CM6 ＋ 可见窗口，⛔ 这一节量不了。");
    if bad > 0 {
        println!("⚠️ {bad} 个样本的巨型块**往返不稳定** —— ⛔ 未通过");
    }
}

#[derive(Default)]
struct FileReport {
    path: String,
    bytes: usize,
    lines: usize,
    top_children: usize,
    no_sourcepos: usize,
    blocks_json_bytes: usize,
    blocks_compact_bytes: usize,
    gaps: usize,
    unknown_gaps: Vec<(u32, String)>,
    parse_ms: f64,
    /// ⭐ 块表**自身**的成本（在既有 AST 上走一层），⛔ 不含 parse。
    walk_ms: f64,
    unstable: Vec<String>,
    kinds: std::collections::BTreeMap<String, usize>,
}

fn probe_file(path: &Path) -> FileReport {
    let raw = std::fs::read(path).unwrap_or_else(|e| panic!("读不了 {}: {e}", path.display()));
    let mut rep = FileReport { path: path.display().to_string(), bytes: raw.len(), ..Default::default() };

    // ⚠️ 与 `loader::load` 同口径：只剥 BOM，**不规范化行尾**。
    let text = String::from_utf8(raw).unwrap_or_else(|e| panic!("{} 不是 UTF-8: {e}", path.display()));
    let src = text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned();
    let lines: Vec<&str> = src.split('\n').collect();
    rep.lines = lines.len();

    // ⚠️ parse 与遍历**分开计时**：产品侧渲染本来就要 parse（`parse → render`），
    // 块表只是在这棵既有 AST 上走一层 ⇒ 新增成本 = 遍历那一段。
    let arena = Arena::new();
    let t0 = Instant::now();
    let root = parse(&arena, &src, &GUI_OPTS);
    rep.parse_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let t1 = Instant::now();
    let blocks = blocks_of(root);
    rep.walk_ms = t1.elapsed().as_secs_f64() * 1000.0;
    rep.top_children = blocks.len();
    rep.no_sourcepos = blocks.iter().filter(|b| b.no_sourcepos).count();
    // blocks 的载荷大小（按产品拟用的 JSON 形状：index/kind/start_line/end_line/editable）
    let json: Vec<serde_json::Value> = blocks
        .iter()
        .map(|b| {
            serde_json::json!({
                "index": b.index,
                "kind": b.kind,
                "start_line": b.start_line,
                "end_line": b.end_line,
                "editable": !b.no_sourcepos && editable_kind(&b.kind),
            })
        })
        .collect();
    rep.blocks_json_bytes = serde_json::to_string(&json).unwrap().len();

    // ⭐ 0b 的**第二个**数字：同样的信息换成紧凑形状（种类编号 + 行号三元组）有多大。
    // 判据只关心"载荷能不能压到不影响打开耗时的量级"，所以给的是**下界形态**，
    // ⚠️ 真正实现要不要压缩是 `design/0047` §3 的决定，⛔ 探针不替它拍板。
    let compact: Vec<(u8, u32, u32, u8)> = blocks
        .iter()
        .map(|b| {
            let k = match b.kind.as_str() {
                "Paragraph" => 0u8,
                "Heading" => 1,
                "CodeBlock" => 2,
                "List" => 3,
                "BlockQuote" => 4,
                "Table" => 5,
                "HtmlBlock" => 6,
                "ThematicBreak" => 7,
                "FootnoteDefinition" => 8,
                _ => 9,
            };
            (k, b.start_line, b.end_line, u8::from(!b.no_sourcepos && editable_kind(&b.kind)))
        })
        .collect();
    rep.blocks_compact_bytes = serde_json::to_string(&compact).unwrap().len();

    for b in &blocks {
        *rep.kinds.entry(b.kind.clone()).or_insert(0) += 1;
    }
    rep.unstable = roundtrip_issues(&src, &blocks);

    // ⭐ 块间行：**静默丢块**的报警器（与 `--fixtures` 同一条判据，此处跑真语料）
    let gaps = fixtures::gap_lines(lines.len() as u32, &blocks);
    rep.gaps = gaps.len();
    rep.unknown_gaps = fixtures::unknown_gap_lines(&lines, &gaps);

    rep
}

/// ⭐ 0e 的 Rust 半：行数不变 + `restore(normalize)` 逐字节回原。
fn probe_envelope() {
    println!("\n## 0e（Rust 半）· 信封：行数与往返\n");
    println!("| 样本 | Eol | lossy | 原文 `\\n` | 规范化后 `\\n` | 行数差 | restore==原文 |");
    println!("|---|---|---|---|---|---|---|");

    let cases: &[(&str, &[u8])] = &[
        ("LF", b"a\nb\n"),
        ("CRLF", b"a\r\nb\r\n"),
        ("BOM+CRLF", b"\xEF\xBB\xBFa\r\nb\r\n"),
        ("无尾换行", b"a\nb"),
        ("空文件", b""),
        ("混合行尾", b"a\nb\r\nc\n"),
        ("裸 CR", b"a\rb\r"),
    ];

    let mut bad = 0usize;
    for (name, raw) in cases {
        let _ = raw;
        let env = Envelope::detect_raw(raw);
        let text = env
            .normalize_bytes(raw)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let raw_nl = raw.iter().filter(|&&b| b == b'\n').count();
        let norm_nl = text.matches('\n').count();
        let restored = env.restore(&text);
        let same = restored == *raw;
        if !same {
            bad += 1;
        }
        println!(
            "| {name} | {:?} | {} | {raw_nl} | {norm_nl} | {} | {} |",
            env.eol,
            env.is_lossy(),
            norm_nl as i64 - raw_nl as i64,
            if same { "✅" } else { "❌" }
        );
        // ⭐ 判据：`Other` **不承诺**逐字节；其余必须完全一致
        if env.eol != Eol::Other && !same {
            println!("  ⛔ {name} 在非 Other 档下必须逐字节回原");
        }
    }
    println!("\n判据：`Eol::Other`（混合行尾 / 裸 CR）是唯一允许不保真的档 ⇒ live 对它整篇 `editable=false`。");
    if bad > 0 {
        println!("⚠️ 有 {bad} 个样本 restore 后与原文不同（其中 Other 档是**预期的**）");
    }
}

/// ⭐ `--commit-json`：给 `tools/live-probe/js/commitFidelity.test.js` 的**机器可读出口**
/// （`design/0047` §7.2 第 7 条 `make probe-live-commit` 的 Rust 半）。
///
/// # 它为什么必须由 Rust 出，而不是在 JS 里手写夹具
///
/// 归一化（去 BOM / 统一行尾）是 `document/envelope.rs` 的事，⛔ 在 JS 里再写一遍就是
/// **第二份实现**（`INV-SINGLE-01`）——而这份 gate 要验的恰恰是
/// 「**归一化之后的文本** 经过 JS 行模型提交之后，逐字符不变」。
/// 块行区间同理：它来自 AST `sourcepos`（`blocks.rs` 那份遍历），⛔ 不是猜的。
///
/// # 样本：7 类信封 × 内容形态
///
/// 前 7 条与 `src-tauri/src/commands/edit.rs` 的 `FID`（0e 的 7 类）一一对应，
/// 只是把内容换成**真会出现在文档里的形态**（列表 / 围栏 / 表格 / 引用 / 多字节 / 无尾换行）。
/// 形状要覆盖到"块边界正好落在文件末尾"这种位置——行模型的 `'a\n' → ['a','']`
/// 那个坑只在**没有尾换行**的样本上才暴露。
///
/// ⚠️ `text` 是**归一化之后的全文**（恒 LF、无 BOM）；JS 侧⛔ 不许再归一化一次。
fn probe_commit_json() {
    let samples: &[(&str, &[u8])] = &[
        // ── 0e 的第 1 类：纯 LF ──
        ("para-lf", "段落一\n\n段落二\n".as_bytes()),
        ("list-lf", "- 一\n- 二\n\n收尾段\n".as_bytes()),
        // ── 第 2 类：CRLF ──
        ("quote-crlf", "> 引用\n>\n> 第二段\n".as_bytes()),
        ("fence-crlf", "```rust\nfn main() {}\n```\n".as_bytes()),
        // ── 第 3 类：BOM + CRLF ──
        ("bom-table-crlf", b"\xEF\xBB\xBF| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n"),
        // ── 第 4 类：无尾换行 ＋ 多字节（块边界贴着文件末尾）──
        ("heading-noeol", "# 标题\n\n正文没有尾换行".as_bytes()),
        // ── 第 5 类：空文件 ──
        ("empty", b""),
        // ── 第 6 类：混合行尾（`Eol::Other` ⇒ 整篇不可编辑）──
        ("mixed-eol", b"a\nb\r\nc"),
        // ── 第 7 类：裸 CR（同上）──
        ("bare-cr", b"# a\rb"),
    ];

    let mut out: Vec<serde_json::Value> = Vec::new();
    for (name, raw) in samples {
        let env = Envelope::detect_raw(raw);
        // ⚠️ 归一化失败（非法 UTF-8 之类）在真实文档里会走"不可编辑"分支，
        //    这里直接 panic：样本全是合法 UTF-8，失败即夹具写错，⛔ 别静默跳过。
        let text = env
            .normalize_bytes(raw)
            .unwrap_or_else(|e| panic!("{name}: 归一化失败 {e}"));
        let arena = Arena::new();
        let root = parse(&arena, &text, &GUI_OPTS);
        let blocks: Vec<serde_json::Value> = root
            .children()
            .map(|n| {
                let d = n.data();
                let sp = d.sourcepos;
                serde_json::json!({
                    "start": sp.start.line,
                    "end": sp.end.line,
                    "kind": kind_name(&d.value),
                })
            })
            .collect();
        out.push(serde_json::json!({
            "name": name,
            // ⚠️ 与 `envelope.rs` 的 `#[serde(rename)]` 逐字一致（lf / crlf / other）
            "eol": match env.eol {
                Eol::Lf => "lf",
                Eol::CrLf => "crlf",
                Eol::Other => "other",
            },
            "lossy": env.is_lossy(),
            "text": text,
            "blocks": blocks,
        }));
    }

    // ⛔ stdout 只有 JSON：调用方（`make probe-live-commit`）直接把它喂给 node。
    let doc = serde_json::json!({
        // ⚠️ 计数写进载荷：JS 侧据此断言"一条都没少"（静默跳过与全绿长得一样）
        "count": out.len(),
        "samples": out,
    });
    println!("{}", serde_json::to_string_pretty(&doc).unwrap());
}

// ── `--markup-json`（`design/0052` U9：Lezer ↔ comrak 的方言差分表）──────

/// 一处「该藏的标记」：**绝对 UTF-8 字节偏移**（产品 `sourcepos_chars: false` 的口径）。
#[derive(Clone)]
struct MarkRow {
    kind: &'static str,
    from: usize,
    to: usize,
}

/// 从 `i` 处**跨过它所在的那一个字符**，返回半开区间的右端。
///
/// ⚠️ `sourcepos_chars: false` 时 `end.column` 指向的是**最后一个字节**，遇到
///    CJK 就是某个**续接字节**（`0x80..=0xBF`）——2026-10-27 实测：`[汉字](http://x)`
///    的 `Text` 右端一算就落到 `ttp://x)` 里去了。这里不猜"它是首字节还是尾字节"，
///    而是**整体跨过这个字符**（两种指向都得到同一个答案）。
fn end_after(src: &str, i: usize) -> usize {
    let bytes = src.as_bytes();
    if i >= bytes.len() {
        return bytes.len();
    }
    let mut j = i;
    while j + 1 < bytes.len() && bytes[j + 1] & 0xC0 == 0x80 {
        j += 1;
    }
    (j + 1).min(bytes.len())
}

/// `sourcepos` → **半开**字节区间。⚠️ comrak 的 `end` 指向**最后一个字符**（闭区间）。
fn span_bytes(src: &str, starts: &[usize], sp: comrak::nodes::Sourcepos) -> (usize, usize) {
    let s = starts[sp.start.line.saturating_sub(1)] + sp.start.column.saturating_sub(1);
    let e = starts[sp.end.line.saturating_sub(1)] + sp.end.column.saturating_sub(1);
    (s, end_after(src, e))
}

/// 第 `line`（1-based）的**不含换行**的行字节区间。
fn line_bounds(src: &str, starts: &[usize], line: usize) -> (usize, usize) {
    let s = starts[line - 1];
    let e = src[s..].find('\n').map(|x| s + x).unwrap_or(src.len());
    (s, e)
}

/// 跳过这一行的**容器前缀**（最多 3 个空格 ＋ 一层 `> ` ，可反复），返回其后第一个字节。
///
/// ⚠️ 只给"要精确落在某个字符上"的节点用（围栏）。行内节点的 `sourcepos` 本来就是
///    绝对字节偏移，⛔ 不需要这个。
fn skip_container_prefix(bytes: &[u8], ls: usize, le: usize) -> usize {
    let mut i = ls;
    loop {
        let mut j = i;
        let mut pad = 0;
        while j < le && bytes[j] == b' ' && pad < 3 {
            j += 1;
            pad += 1;
        }
        if j < le && bytes[j] == b'>' {
            j += 1;
            if j < le && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            i = j;
        } else {
            return i;
        }
    }
}

/// ⭐ **父节点两侧的定界符**：`[父.from, 首子.from)` 与 `[末子.to, 父.to)`。
///
/// ⚠️ 这是唯一正确的做法：`***a***`、`[![img](s)](href)`、`**a *b* c**` 这类嵌套
/// 全部交给 AST，⛔ 不在这里写第二个括号/星号匹配器（那就成了**第二份实现**）。
/// ⚠️ 没有子节点（`[](url)`）⇒ 整段都藏：渲染态那一格什么都不显示。
fn push_delims(
    n: &AstNode<'_>,
    src: &str,
    starts: &[usize],
    kind: &'static str,
    out: &mut Vec<MarkRow>,
) {
    let (from, to) = span_bytes(src, starts, n.data().sourcepos);
    if to <= from {
        return;
    }
    let (fc, lc) = (n.first_child(), n.last_child());
    if fc.is_none() || lc.is_none() {
        out.push(MarkRow { kind, from, to });
        return;
    }
    let (a, _) = span_bytes(src, starts, fc.unwrap().data().sourcepos);
    let (_, b) = span_bytes(src, starts, lc.unwrap().data().sourcepos);
    if a > from && a <= to {
        out.push(MarkRow { kind, from, to: a });
    }
    if b < to && b >= from {
        out.push(MarkRow { kind, from: b, to });
    }
}

/// 一个节点贡献的标记区间（⛔ 不改树、⛔ 不递归——递归由 `descendants()` 做）。
///
/// ⚠️ 白名单与 `src/live/decorations.js` 的 `HIDDEN_MARK` **逐条对应**；
/// 表里没有的节点这里也**一个都不动**——两边都多认一样东西，差分表就会恒绿。
fn marks_of(n: &AstNode<'_>, src: &str, starts: &[usize], out: &mut Vec<MarkRow>) {
    let d = n.data();
    if d.sourcepos.start.line == 0 {
        return; // 合成节点（comrak 对它们不给 sourcepos），⚠️ 与块表那边同一判据
    }
    let bytes = src.as_bytes();
    let (from, to) = span_bytes(src, starts, d.sourcepos);
    match &d.value {
        NodeValue::Emph | NodeValue::Strong => {
            // ⚠️ comrak 只有 `Emph`/`Strong` 两种，没有"定界符节点"；Lezer 两者都叫
            //    `EmphasisMark` ⇒ 这里也统一记这个名字，否则差分表会满屏假差。
            push_delims(n, src, starts, "EmphasisMark", out);
        }
        NodeValue::Strikethrough => push_delims(n, src, starts, "StrikethroughMark", out),
        NodeValue::Link(_) | NodeValue::Image(_) => push_delims(n, src, starts, "LinkMark", out),
        NodeValue::Code(code) => {
            let k = code.num_backticks;
            if from + k <= to {
                out.push(MarkRow { kind: "CodeMark", from, to: from + k });
                out.push(MarkRow { kind: "CodeMark", from: to - k, to });
            }
        }
        NodeValue::Heading(h) => {
            if h.setext {
                // 下划线那一行整行（`===` / `---`）：Lezer 侧叫 `HeaderMark`
                let (ls, le) = line_bounds(src, starts, d.sourcepos.end.line);
                let t = &src[ls..le];
                let s = t.trim_start();
                if !s.is_empty() {
                    let off = ls + (t.len() - s.len());
                    let e = le - (t.len() - t.trim_end().len());
                    out.push(MarkRow { kind: "HeaderMark", from: off, to: e });
                }
            } else {
                // 行首 `#` 串 ＋ 紧跟的**一个**空格（产品 `markers()` 的口径）
                let mut i = from;
                while i < to && bytes[i] == b'#' {
                    i += 1;
                }
                if i > from {
                    let mut e = i;
                    if e < to && (bytes[e] == b' ' || bytes[e] == b'\t') {
                        e += 1;
                    }
                    out.push(MarkRow { kind: "HeaderMark", from, to: e });
                }
                // 行尾闭合序列（`## 标题 ##`）：⚠️ CommonMark 要求它前面**有空格**
                let mut j = to;
                while j > from && (bytes[j - 1] == b' ' || bytes[j - 1] == b'\t') {
                    j -= 1;
                }
                let mut k = j;
                while k > i && bytes[k - 1] == b'#' {
                    k -= 1;
                }
                if k < j && (k == i || bytes[k - 1] == b' ' || bytes[k - 1] == b'\t') {
                    out.push(MarkRow { kind: "HeaderMark", from: k, to: j });
                }
            }
        }
        NodeValue::BlockQuote => {
            // ⚠️ 只在**最外层**扫：内层 BlockQuote 覆盖同一批行，两边都扫会把同一条 `>`
            //    记两遍（去重之后看不出来，但差分表的"条数"就假了）。
            let nested = n
                .parent()
                .map(|p| matches!(p.data().value, NodeValue::BlockQuote))
                .unwrap_or(false);
            if nested {
                return;
            }
            for line in d.sourcepos.start.line..=d.sourcepos.end.line {
                let (ls, le) = line_bounds(src, starts, line);
                let mut i = ls;
                let mut pad = 0;
                while i < le && bytes[i] == b' ' && pad < 3 {
                    i += 1;
                    pad += 1;
                }
                while i < le && bytes[i] == b'>' {
                    let s = i;
                    i += 1;
                    // ⚠️ 必须把 `i` 一起推过那个空格：只推 `to` 的话下一轮 `bytes[i]` 还是
                    //    空格 ⇒ `> > 嵌套` 的第二层 `>` 会被静默漏掉（2026-10-27 实测踩过）。
                    if i < le && (bytes[i] == b' ' || bytes[i] == b'\t') {
                        i += 1;
                    }
                    out.push(MarkRow { kind: "QuoteMark", from: s, to: i });
                }
            }
        }
        NodeValue::CodeBlock(cb) if cb.fenced => {
            // 围栏符 ＋ 语言标记（`design/0052` U5 起产品两样都藏）
            let ch = cb.fence_char;
            let (ls, le) = line_bounds(src, starts, d.sourcepos.start.line);
            // ⚠️ 容器前缀必须跳过：`> ```` ` 那一行的围栏符不在行首，不跳就一个标记都
            //    找不到 ⇒ 差分表会把它报成"comrak 不藏"，那是**提取器的缺口**，不是方言差异。
            let mut i = skip_container_prefix(bytes, ls, le);
            while i < le && bytes[i] == b' ' {
                i += 1;
            }
            let mut e = i;
            while e < le && bytes[e] == ch {
                e += 1;
            }
            if e > i {
                out.push(MarkRow { kind: "CodeMark", from: i, to: e });
                let rest = &src[e..le];
                let info = rest.trim();
                if !info.is_empty() {
                    let off = e + (rest.len() - rest.trim_start().len());
                    out.push(MarkRow { kind: "CodeInfo", from: off, to: off + info.len() });
                }
            }
            // 收尾围栏行（未被闭合的代码块 ⇒ 末行是内容，⛔ 不记）
            let (cls, cle) = line_bounds(src, starts, d.sourcepos.end.line);
            let mut ci = skip_container_prefix(bytes, cls, cle);
            while ci < cle && bytes[ci] == b' ' {
                ci += 1;
            }
            let mut ce = ci;
            while ce < cle && bytes[ce] == ch {
                ce += 1;
            }
            if ce > ci && ce - ci >= cb.fence_length && src[ci..cle].trim().len() == ce - ci {
                out.push(MarkRow { kind: "CodeMark", from: ci, to: ce });
            }
        }
        _ => {}
    }
}

/// ⭐ `--markup-json`：给 `tools/live-probe/js/markupDiff.test.js` 的机器可读出口
/// （`design/0052` **U9**）。
///
/// # 它出口什么、⛔ 不出口什么
///
/// **只出口「comrak 认为该藏的标记区间」**，⛔ **不出口树**——比树形没有意义
/// （两个解析器的节点命名本来就不一样），要比的是"**同一行同一位置该不该藏**"。
/// 另一侧由 JS 拿**产品那份** `live/decorations.js::markers()` ＋ 同一份文本的
/// Lezer 树算出来（`INV-SINGLE-01`：探针不抄第二份判定）。
///
/// ⚠️ **差异不判红**（U9 原文）：两个解析器的方言差异是**外部事实**，
/// 它只落成 `docs/research/notes/` 的差分表 ＋ 一条 `docs/kb/`——但**必须可见**，
/// 否则会以"某个标记永远不消失 / 永远消失"的形式回来。
///
/// ⚠️ 坐标是**绝对字节偏移**；UTF-16 下标由 JS 侧换算（产品 `sourcepos_chars: false`）。
fn probe_markup_json(paths: &[String]) {
    let mut docs: Vec<serde_json::Value> = Vec::new();
    for p in paths {
        let raw = std::fs::read(p).unwrap_or_else(|e| panic!("读不到 {p}: {e}"));
        let env = Envelope::detect_raw(&raw);
        let text = env
            .normalize_bytes(&raw)
            .unwrap_or_else(|e| panic!("{p}: 归一化失败 {e}"));
        let arena = Arena::new();
        let root = parse(&arena, &text, &GUI_OPTS);

        let mut starts = vec![0usize];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                starts.push(i + 1);
            }
        }

        let mut marks: Vec<MarkRow> = Vec::new();
        for n in root.descendants() {
            marks_of(n, &text, &starts, &mut marks);
        }
        marks.sort_by_key(|m| (m.from, m.to));
        marks.dedup_by(|a, b| a.from == b.from && a.to == b.to);

        // 块表：**顶层**块（产品的块切片口径，`live/index.js::sliceLines`）
        let blocks: Vec<serde_json::Value> = root
            .children()
            .map(|n| {
                let d = n.data();
                serde_json::json!({
                    "start": d.sourcepos.start.line,
                    "end": d.sourcepos.end.line,
                    "kind": kind_name(&d.value),
                })
            })
            .collect();

        docs.push(serde_json::json!({
            // ⚠️ 用**传进来的那个路径**，⛔ 不只取 basename：`find docs -name '*.md'` 里
            //    `design/0017-x.md` 与 `features/0017-x.md` 同名，只留 basename 的话
            //    差分表里两篇会合成一篇（2026-10-27 实测：行号全对不上）。
            "name": p,
            "text": text,
            "blocks": blocks,
            "marks": marks.iter().map(|m| serde_json::json!({
                "kind": m.kind,
                "from": m.from,
                "to": m.to,
            })).collect::<Vec<_>>(),
        }));
    }
    let doc = serde_json::json!({ "count": docs.len(), "docs": docs });
    println!("{}", serde_json::to_string_pretty(&doc).unwrap());
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!(
            "用法: live-probe <文件…>（0a/0b）｜`--envelope`（0e 的 Rust 半）｜`--commit-json`（§7.2-7 的 Rust 半）｜`--markup-json <文件…>`（§7.2-9 的 Rust 半）｜`--fixtures`（0a 的对抗性夹具）｜`--giant`（0f 静态半）"
        );
        std::process::exit(2);
    }
    if args[0] == "--envelope" {
        probe_envelope();
        return;
    }
    if args[0] == "--commit-json" {
        probe_commit_json();
        return;
    }
    if args[0] == "--markup-json" {
        // ⚠️ 一个文件都没有 ⇒ 夹具写错了，⛔ 别静默产出空表（空表与"全一致"长得一样）
        if args.len() < 2 {
            eprintln!("✗ --markup-json 至少要一个语料文件");
            std::process::exit(2);
        }
        probe_markup_json(&args[1..]);
        return;
    }
    if args[0] == "--fixtures" {
        let rep = fixtures::run();
        std::process::exit(rep.print());
    }
    if args[0] == "--giant" {
        probe_giant();
        return;
    }

    println!("# 0047 探针：0a 块表覆盖与往返 · 0b blocks 载荷\n");
    println!(
        "| 文件 | 大小 | 行 | 顶层块 | 无 sourcepos | 块间行 | 未知块间行 | blocks JSON | 占源码 | 紧凑载荷 | 占源码 | 解析(既有) | 块表遍历(新增) | 不稳定 |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");

    let mut total_unstable = 0usize;
    let mut total_unknown = 0usize;
    for a in &args {
        let rep = probe_file(Path::new(a));
        total_unstable += rep.unstable.len();
        total_unknown += rep.unknown_gaps.len();
        println!(
            "| {} | {:.1} MiB | {} | {} | {} | {} | {} | {} B | {:.2}% | {} B | {:.2}% | {:.1} ms | {:.2} ms | {} |",
            rep.path.rsplit('/').next().unwrap_or(&rep.path),
            rep.bytes as f64 / 1048576.0,
            rep.lines,
            rep.top_children,
            rep.no_sourcepos,
            rep.gaps,
            rep.unknown_gaps.len(),
            rep.blocks_json_bytes,
            rep.blocks_json_bytes as f64 * 100.0 / rep.bytes as f64,
            rep.blocks_compact_bytes,
            rep.blocks_compact_bytes as f64 * 100.0 / rep.bytes as f64,
            rep.parse_ms,
            rep.walk_ms,
            rep.unstable.len()
        );
        if !rep.unstable.is_empty() {
            for u in rep.unstable.iter().take(5) {
                println!("  - {u}");
            }
            if rep.unstable.len() > 5 {
                println!("  - …共 {} 条", rep.unstable.len());
            }
        }
        if !rep.unknown_gaps.is_empty() {
            for (l, t) in rep.unknown_gaps.iter().take(5) {
                println!("  - 未知块间行 {l}：`{t}`");
            }
            if rep.unknown_gaps.len() > 5 {
                println!("  - …共 {} 条", rep.unknown_gaps.len());
            }
        }
        println!("  - 种类分布：{:?}", rep.kinds);
    }

    probe_envelope();

    println!("\n## 结论\n");
    if total_unstable == 0 && total_unknown == 0 {
        println!("✅ 全部块的「行区间切片 ⇒ 重新 parse」稳定：同一类、首尾正好盖住切片");
        println!("✅ 所有非空块间行都属于「隐藏指令 / 链接定义 / 脚注定义」⇒ 没有整行正文被静默丢块");
    } else {
        if total_unstable > 0 {
            println!("⚠️ 共 {total_unstable} 处往返不稳定 —— ⛔ 未通过，先修契约再谈实施");
        }
        if total_unknown > 0 {
            println!("⚠️ 共 {total_unknown} 行**非空**块间行不属于已知形态 —— ⛔ 疑似整行正文丢块");
        }
    }
    std::process::exit(if total_unstable == 0 && total_unknown == 0 { 0 } else { 1 });
}
