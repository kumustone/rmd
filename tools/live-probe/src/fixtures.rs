//! 0a 的**对抗性夹具**（`docs/design/0047` §7.1 的 0a 后半）。
//!
//! ⚠️ 语料（`benchmarks/corpus/*.md`）只能证明「**常规**中文/代码/表格文档稳定」。
//! 用户点名的五类风险——**换行增删、末尾空行、跨块合并、隐藏指令、引用定义**——
//! 语料里**未必出现**，必须由这里逐条钉住。⛔ 「语料全绿」不能替代这一份。
//!
//! 判据分两层：
//!
//! 1. **结构层**（任何输入都必须成立）：块区间合法、互不重叠、「块 ∪ 块间行」恰好盖满全文、
//!    每个块的行区间切片重新 parse 还是**同一类、同跨度**的单块。
//! 2. **语义层**（每条夹具点名一句）：那一行到底在**块内**还是**块间**。
//!    ⭐ 隐藏指令与引用定义**必须在块间或被完整纳入块内**，⛔ 不允许"半截挂在边界上"。
//!
//! ⚠️ 这里**不抄第二份实现**：块表与往返都走 `main.rs` 里那两个函数，
//! 它们与语料那一轮是**同一个**判据。

use crate::{BlockRow, kind_name, roundtrip_issues, top_blocks};

pub struct Check {
    pub scope: &'static str,
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

pub struct Report {
    pub checks: Vec<Check>,
}

impl Report {
    /// 打印报告，返回进程退出码（0 = 全绿）。
    pub fn print(&self) -> i32 {
        let failed: Vec<&Check> = self.checks.iter().filter(|c| !c.ok).collect();
        println!("# 0047 探针：0a 对抗性夹具（{} 条判据）\n", self.checks.len());

        // 按 scope 分组打印，一眼能看出是哪条夹具/哪个 splice 红了
        let mut last = "";
        for c in &self.checks {
            if c.scope != last {
                println!("\n## {}", c.scope);
                last = c.scope;
            }
            println!(
                "  {} {} — {}",
                if c.ok { "✅" } else { "❌" },
                c.name,
                c.detail
            );
        }

        println!("\n## 结论\n");
        if failed.is_empty() {
            println!("✅ {} 条判据全绿", self.checks.len());
            0
        } else {
            println!(
                "⚠️ {}/{} 条不成立 —— ⛔ 未通过，先修契约再谈实施",
                failed.len(),
                self.checks.len()
            );
            for c in failed {
                println!("  - [{}] {}：{}", c.scope, c.name, c.detail);
            }
            1
        }
    }
}

// ————————————————————————————————————————————————————————————————————————————
// 夹具定义
// ————————————————————————————————————————————————————————————————————————————

struct Fixture {
    name: &'static str,
    src: &'static str,
    /// 期望的顶层块种类序列（按文档顺序）。`None` = 只判结构，不判具体种类（画廊用）。
    kinds: Option<&'static [&'static str]>,
    /// 期望**落在块间行**的行号（1-based）。`None` = 不判。空数组 = 全文都被块盖满。
    gaps: Option<&'static [u32]>,
    /// 期望**落在某个块内部**的行号（1-based）——用于钉住"围栏吞空行""列表吞空行"这类形状。
    in_block: &'static [u32],
}

/// ⚠️ 每条夹具都是一个**具体的一手事实**，不是为了凑数加的。
static FIXTURES: &[Fixture] = &[
    Fixture {
        // 基线：两段被一行空行隔开。空行**必须**是块间行（它不属于任何一段）。
        name: "基线·空行分隔的两段",
        src: "para one\n\npara two\n",
        kinds: Some(&["Paragraph", "Paragraph"]),
        gaps: Some(&[2, 4]),
        in_block: &[1, 3],
    },
    Fixture {
        // 末尾连续空行：`split('\n')` 会产出多个**末尾空串**，行数口径在这里最容易错。
        name: "末尾空行·连续两个",
        src: "a\n\n\n",
        kinds: Some(&["Paragraph"]),
        gaps: Some(&[2, 3, 4]),
        in_block: &[1],
    },
    Fixture {
        // 无尾换行：最后一行**没有** `\n` ⇒ 行数 = `\n` 数 + 1，⛔ 不能按"行尾符个数"算。
        name: "无尾换行·软换行连成一段",
        src: "a\nb",
        kinds: Some(&["Paragraph"]),
        gaps: Some(&[]),
        in_block: &[1, 2],
    },
    Fixture {
        // ⭐ 隐藏指令：`[TOC]` 被 `strip_directives` **detach**，AST 里连节点都没有
        // ⇒ 它必然落在块间行里。这行**必须逐字留在 `fullText`**，否则提交一次就丢。
        name: "隐藏指令·[TOC] 必须落在块间行",
        src: "[TOC]\n\n# 标题\n\n正文\n",
        kinds: Some(&["Heading", "Paragraph"]),
        gaps: Some(&[1, 2, 4, 6]),
        in_block: &[3, 5],
    },
    Fixture {
        // ⭐ **实测结论（不是推测）**：comrak 把 `[a]: url` 从段落里摘走，
        // 段落的 `sourcepos` **只到正文那行** ⇒ 定义行是**块间行**（第 3 行）。
        // ⇒ §2.8 那条"块间行逐字保留、光标不进、边界键不吞"**正是为它写的**。
        name: "引用定义·定义行落在块间",
        src: "见[引用][a]。\n\n[a]: https://example.com\n\n下一段\n",
        kinds: Some(&["Paragraph", "Paragraph"]),
        gaps: Some(&[2, 3, 4, 6]),
        in_block: &[1, 5],
    },
    Fixture {
        // Setext 标题：`===` 那一行**属于标题块**，⛔ 不是独立的分隔线。
        name: "Setext 标题·两行一块",
        src: "标题\n===\n\n正文\n",
        kinds: Some(&["Heading", "Paragraph"]),
        gaps: Some(&[3, 5]),
        in_block: &[1, 2, 4],
    },
    Fixture {
        // ⭐ 围栏代码块：块内的**空行**必须留在块内（⛔ 不能被当成块间行切出去），
        // 且围栏关闭行之后**紧贴**段落（没有空行）仍然分成两块。
        name: "围栏代码块·内含空行 + 紧贴段落",
        src: "```rust\nfn a() {}\n\nfn b() {}\n```\n紧跟段落\n",
        kinds: Some(&["CodeBlock", "Paragraph"]),
        gaps: Some(&[7]),
        in_block: &[1, 2, 3, 4, 5, 6],
    },
    Fixture {
        // GFM 表格：`design/0047` 把 Table 定为**不进编辑态**（`editable=false`），
        // 但块表**仍然**要给出它，否则"单击跳分栏"没有落点。
        name: "表格·块表里仍在，但不是可编辑块",
        src: "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后段\n",
        kinds: Some(&["Table", "Paragraph"]),
        gaps: Some(&[4, 6]),
        in_block: &[1, 2, 3, 5],
    },
    Fixture {
        // ⭐ 宽松列表：项之间的空行**属于列表块**（`List` 的 span 跨过它）。
        // 把它当块间行 ⇒ 在那行回车会把一个列表劈成两个。
        name: "列表·项间空行属于列表块",
        src: "- 一\n\n- 二\n",
        kinds: Some(&["List"]),
        gaps: Some(&[4]),
        in_block: &[1, 2, 3],
    },
    Fixture {
        // ⭐⭐ **实测发现（本条是本轮最要紧的一条）**：脚注定义块**只在被引用时存在**。
        // 整篇有 `[^1]` 引用 ⇒ 顶层多出 `FootnoteDefinition`（行 3-3）；
        // 而把行 3 单独切出来重 parse ⇒ **0 个顶层块**（comrak 不物化未被引用的定义）。
        // ⇒ 它的"块存在性"依赖**同一文档别处的一行**，⛔ 不能进就地编辑态。
        name: "脚注定义·被引用时才有块（切片重 parse 为空）",
        src: "文字[^1]\n\n[^1]: 脚注内容\n",
        kinds: Some(&["Paragraph", "FootnoteDefinition"]),
        gaps: Some(&[2, 4]),
        in_block: &[1, 3],
    },
    Fixture {
        // ⭐ 同一个定义**没有**引用 ⇒ 连块都没有，那一整行是**纯块间行**。
        // 这是"全文里有正文、块表里没有它"的真实形态之一（另一个是 `[TOC]`）。
        name: "脚注定义·未被引用时整行是块间行",
        src: "文字\n\n[^1]: 脚注内容\n",
        kinds: Some(&["Paragraph"]),
        gaps: Some(&[2, 3, 4]),
        in_block: &[1],
    },
    Fixture {
        // HTML 块：`design/0047` 定为不可编辑块（就地改会变版面），块表仍要给。
        name: "HTML 块·不可编辑但要有 span",
        src: "<div>\n块\n</div>\n\n后段\n",
        kinds: Some(&["HtmlBlock", "Paragraph"]),
        gaps: Some(&[4, 6]),
        in_block: &[1, 2, 3, 5],
    },
    Fixture {
        // 块级公式：`$$…$$` 在 comrak 里是 **Paragraph → Math**（`INV-MATH-03`），
        // ⇒ 顶层种类是 `Paragraph`，⛔ 不是 `Math`。分栏定位必须认这个事实。
        name: "块级公式·顶层是 Paragraph",
        src: "$$\nx = 1\n$$\n\n后段\n",
        kinds: Some(&["Paragraph", "Paragraph"]),
        gaps: Some(&[4, 6]),
        in_block: &[1, 2, 3, 5],
    },
    // —— 画廊：只判「结构 + 覆盖 + 往返」，不预设种类/块间行 ——
    // ⚠️ 这几条抓的是"嵌套结构把行吃进块内"的形态；种类不预设是因为
    //    它们的顶层种类本来就没什么可争议的（List / BlockQuote / CodeBlock …）。
    Fixture {
        name: "画廊·引用块内套列表与围栏",
        src: "> 引用\n>\n> - 一\n> - 二\n>\n> ```\n> code\n> ```\n\n后段\n",
        kinds: None,
        gaps: None,
        in_block: &[],
    },
    Fixture {
        name: "画廊·缩进代码块（4 空格）紧跟段落",
        src: "    fn a() {}\n\n    fn b() {}\n\n后段\n",
        kinds: None,
        gaps: None,
        in_block: &[],
    },
    Fixture {
        name: "画廊·分隔线 + 标题 + 段落",
        src: "---\n\n# 标题\n\n正文\n\n---\n",
        kinds: None,
        gaps: None,
        in_block: &[],
    },
    Fixture {
        name: "画廊·任务列表（GFM）",
        src: "- [x] 已做\n- [ ] 未做\n\n后段\n",
        kinds: None,
        gaps: None,
        in_block: &[],
    },
    Fixture {
        name: "画廊·三层嵌套列表",
        src: "- 一\n  - 二\n    - 三\n\n后段\n",
        kinds: None,
        gaps: None,
        in_block: &[],
    },
    Fixture {
        name: "画廊·flow 围栏（项目自定义 DSL）",
        src: "```flow\nA --> B\n```\n\n后段\n",
        kinds: None,
        gaps: None,
        in_block: &[],
    },
    Fixture {
        name: "画廊·表格前无空行（GFM 不成立）",
        src: "正文\n| a | b |\n| --- | --- |\n\n后段\n",
        kinds: None,
        gaps: None,
        in_block: &[],
    },
    Fixture {
        name: "画廊·列表项内含围栏与缩进段落",
        src: "- 项\n\n  ```js\n  x()\n  ```\n\n  续段\n\n后段\n",
        kinds: None,
        gaps: None,
        in_block: &[],
    },
    Fixture {
        name: "画廊·中文与 Emoji + 行内标记",
        src: "中文**加粗**与 `代码` 与 🙂🙃\n\n下一段[链接](x.md)\n",
        kinds: None,
        gaps: None,
        in_block: &[],
    },
];

// ————————————————————————————————————————————————————————————————————————————
// splice 情形（§2.4 的候选语义）
// ————————————————————————————————————————————————————————————————————————————

struct Splice {
    scope: &'static str,
    name: &'static str,
    src: &'static str,
    /// 被替换的行区间（1-based，含）。
    start: u32,
    end: u32,
    /// 替换成什么行（`&[]` = 删除这些行）。
    new: &'static [&'static str],
    /// 替换后的顶层块种类序列。
    kinds_after: &'static [&'static str],
    /// 替换后必须仍在全文里**逐字出现**的行（不关心它在块内还是块间）。
    must_contain: &'static [&'static str],
}

static SPLICES: &[Splice] = &[
    Splice {
        // ⭐ 跨块合并：删掉两段之间的空行 ⇒ **两个块变成一个**。
        // ⇒ 旧的块表整体作废，"活动块"必须重新解算，⛔ 不能拿旧 span 继续用。
        scope: "splice·跨块合并",
        name: "删掉分隔空行 ⇒ 两段合并成一段",
        src: "para one\n\npara two\n",
        start: 2,
        end: 2,
        new: &[],
        kinds_after: &["Paragraph"],
        must_contain: &["para one", "para two"],
    },
    Splice {
        // ⭐ 换行增删：块内插入一行 ⇒ 行数 +1，**后面的块全部下移**。
        scope: "splice·换行增删",
        name: "块内插入一行 ⇒ 块数不变但下游 span 全部下移",
        src: "para one\n\npara two\n",
        start: 1,
        end: 1,
        new: &["para one", "续行"],
        kinds_after: &["Paragraph", "Paragraph"],
        must_contain: &["para one", "续行", "para two"],
    },
    Splice {
        // ⭐ 末尾空行：往文末追加空行 ⇒ 行数变、块表不变。
        scope: "splice·末尾空行",
        name: "追加一个末尾空行 ⇒ 块表不变、行数 +1",
        src: "a\n\n\n",
        start: 1,
        end: 1,
        new: &["a", ""],
        kinds_after: &["Paragraph"],
        must_contain: &["a"],
    },
    Splice {
        // ⭐ 隐藏指令**不在**被编辑的块里 ⇒ 改标题不许把它带走。
        scope: "splice·隐藏指令",
        name: "改标题后 [TOC] 仍逐字在全文里",
        src: "[TOC]\n\n# 标题\n\n正文\n",
        start: 3,
        end: 3,
        new: &["## 改过的标题"],
        kinds_after: &["Heading", "Paragraph"],
        must_contain: &["[TOC]", "## 改过的标题"],
    },
    Splice {
        // ⭐ 引用定义**不在**被编辑的块里 ⇒ 改引用文字不许拆掉定义。
        scope: "splice·引用定义",
        name: "改引用文字后定义行仍逐字在全文里",
        src: "见[引用][a]。\n\n[a]: https://example.com\n\n下一段\n",
        start: 1,
        end: 1,
        new: &["改过的[引用][a]。"],
        kinds_after: &["Paragraph", "Paragraph"],
        must_contain: &["[a]: https://example.com", "改过的[引用][a]。"],
    },
];

// ————————————————————————————————————————————————————————————————————————————
// 结构层判据（夹具与 splice 共用）
// ————————————————————————————————————————————————————————————————————————————

/// 块区间合法、按序、互不重叠、不越界。
fn structure_issues(n: u32, blocks: &[BlockRow]) -> Vec<String> {
    let mut issues = Vec::new();
    let mut cursor = 1u32;
    for b in blocks {
        if b.start_line == 0 || b.end_line == 0 {
            issues.push(format!("块 {}（{}）行号为 0", b.index, b.kind));
            continue;
        }
        if b.end_line < b.start_line {
            issues.push(format!(
                "块 {}（{}）区间倒置 {}-{}",
                b.index, b.kind, b.start_line, b.end_line
            ));
            continue;
        }
        if b.end_line > n {
            issues.push(format!(
                "块 {}（{}）右端 {} 超出总行数 {}",
                b.index, b.kind, b.end_line, n
            ));
            continue;
        }
        if b.start_line < cursor {
            issues.push(format!(
                "块 {}（{}）起点 {} 与上一块重叠（游标 {}）",
                b.index, b.kind, b.start_line, cursor
            ));
        }
        cursor = cursor.max(b.end_line + 1);
    }
    issues
}

/// 落在**块间**的行号（1-based）。⚠️ 这些行就是 §2.8 里"光标不进、边界键不吞"的那批。
pub(crate) fn gap_lines(n: u32, blocks: &[BlockRow]) -> Vec<u32> {
    let mut covered = vec![false; n as usize + 1];
    for b in blocks {
        for l in b.start_line..=b.end_line {
            if (l as usize) < covered.len() {
                covered[l as usize] = true;
            }
        }
    }
    (1..=n).filter(|l| !covered[*l as usize]).collect()
}

/// 行号是否落在**某个块的内部**。
fn in_any_block(line: u32, blocks: &[BlockRow]) -> bool {
    blocks
        .iter()
        .any(|b| line >= b.start_line && line <= b.end_line)
}

/// 全文的**行数组**（与 `probe_file` / `roundtrip_issues` 同口径：只剥 BOM、不规范化行尾）。
fn lines_of(src: &str) -> Vec<&str> {
    src.strip_prefix('\u{feff}').unwrap_or(src).split('\n').collect()
}

/// 对一份全文跑「结构 + 覆盖 + 往返」，返回 (块表, 问题列表)。
fn evaluate(src: &str) -> (Vec<BlockRow>, Vec<String>) {
    let lines = lines_of(src);
    let n = lines.len() as u32;
    let blocks = top_blocks(src);
    let mut issues = structure_issues(n, &blocks);

    // 覆盖：块内行数 + 块间行数必须恰好等于总行数（⛔ 既不许漏也不许重）
    let covered: u32 = blocks.iter().map(|b| b.end_line - b.start_line + 1).sum();
    let gaps = gap_lines(n, &blocks);
    if covered + gaps.len() as u32 != n {
        issues.push(format!(
            "覆盖对不上：块内 {covered} + 块间 {} ≠ 总行数 {n}",
            gaps.len()
        ));
    }

    issues.extend(roundtrip_issues(src, &blocks));
    (blocks, issues)
}

fn push(checks: &mut Vec<Check>, scope: &'static str, name: impl Into<String>, ok: bool, detail: String) {
    checks.push(Check {
        scope,
        name: name.into(),
        ok,
        detail,
    });
}

// ————————————————————————————————————————————————————————————————————————————
// 夹具
// ————————————————————————————————————————————————————————————————————————————

fn check_fixture(f: &'static Fixture) -> Vec<Check> {
    let mut checks = Vec::new();
    let lines = lines_of(f.src);
    let n = lines.len() as u32;
    let (blocks, issues) = evaluate(f.src);

    push(
        &mut checks,
        f.name,
        "结构 + 覆盖 + 往返",
        issues.is_empty(),
        if issues.is_empty() {
            format!("{n} 行 / {} 块，全部成立", blocks.len())
        } else {
            issues.join("；")
        },
    );

    if let Some(want) = f.kinds {
        let kinds: Vec<&str> = blocks.iter().map(|b| b.kind.as_str()).collect();
        push(
            &mut checks,
            f.name,
            "块种类序列",
            kinds == want,
            format!("得到 {kinds:?}，期望 {want:?}"),
        );
    }

    let gaps = gap_lines(n, &blocks);
    if let Some(want) = f.gaps {
        push(
            &mut checks,
            f.name,
            "块间行",
            gaps == want,
            format!("得到 {gaps:?}，期望 {want:?}"),
        );
    }

    let bad: Vec<u32> = f
        .in_block
        .iter()
        .copied()
        .filter(|l| !in_any_block(*l, &blocks))
        .collect();
    push(
        &mut checks,
        f.name,
        "点名行必须在块内",
        bad.is_empty(),
        if bad.is_empty() {
            format!("{:?} 都在块内", f.in_block)
        } else {
            format!("{bad:?} 不在任何块内")
        },
    );

    // ⭐ **静默丢块的报警器**：块间行按设计只装"解析器有意不生成块"的东西——
    // 空行、隐藏指令（`[TOC]` / `@(…)[…]`）、链接/脚注定义（含它们的缩进续行）。
    // 出现**别的**非空行 ⇒ 有一行正文既没进块、又不属于上述任何一类，
    // 那正是"内容还在 fullText 里但 UI 上看不见"的形态。
    let unknown = unknown_gap_lines(&lines, &gaps);
    push(
        &mut checks,
        f.name,
        "非空块间行只有已知形态",
        unknown.is_empty(),
        if unknown.is_empty() {
            format!("{} 行块间行全部属于「空行/指令/定义」", gaps.len())
        } else {
            format!("未知块间行 {unknown:?}")
        },
    );

    checks
}

/// 非空、且**不属于**「隐藏指令 / 链接定义 / 脚注定义 / 它们的缩进续行」的块间行。
pub(crate) fn unknown_gap_lines(lines: &[&str], gaps: &[u32]) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let mut prev_was_def = false;
    for &l in gaps {
        let raw = lines[(l as usize) - 1];
        let t = raw.trim();
        let indented = raw.starts_with(' ') || raw.starts_with('\t');
        let is_def = t.starts_with("[^") && t.contains("]:")
            || (t.starts_with('[') && t.contains("]:"));
        let is_directive = t.eq_ignore_ascii_case("[TOC]")
            || (t.starts_with("@(") && t.contains(")[") && t.ends_with(']'));
        if t.is_empty() {
            prev_was_def = false;
            continue;
        }
        if is_def || is_directive || (indented && prev_was_def) {
            prev_was_def = is_def;
            continue;
        }
        out.push((l, raw.to_string()));
        prev_was_def = false;
    }
    out
}

// ————————————————————————————————————————————————————————————————————————————
// splice
// ————————————————————————————————————————————————————————————————————————————

/// ⭐ §2.4 的**候选**：按 1-based 行号把 `[start, end]`（含）换成 `new`。
///
/// ⚠️ **行数组进出**：函数里对行尾**不做任何假设**（`fullText` 恒 LF、无 BOM 是
/// `EditGrant.text` 给的保证，⛔ 不是这里再规范化一次）。
fn splice_lines(lines: &[&str], start: u32, end: u32, new: &[&str]) -> Result<Vec<String>, String> {
    let a = (start as usize)
        .checked_sub(1)
        .ok_or_else(|| "start 必须 ≥ 1".to_string())?;
    let b = end as usize;
    if start > end {
        return Err(format!("区间倒置 {start}-{end}"));
    }
    if b > lines.len() {
        return Err(format!("右端 {end} 超出总行数 {}", lines.len()));
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + new.len());
    out.extend(lines[..a].iter().map(|s| s.to_string()));
    out.extend(new.iter().map(|s| s.to_string()));
    out.extend(lines[b..].iter().map(|s| s.to_string()));
    Ok(out)
}

fn check_splice(s: &'static Splice) -> Vec<Check> {
    let mut checks = Vec::new();
    let lines = lines_of(s.src);
    let joined: Vec<String> = lines.iter().map(|x| x.to_string()).collect();

    let after = match splice_lines(&lines, s.start, s.end, s.new) {
        Ok(v) => v,
        Err(e) => {
            push(&mut checks, s.scope, s.name, false, e);
            return checks;
        }
    };
    let new_src = after.join("\n");
    let (blocks, issues) = evaluate(&new_src);

    push(
        &mut checks,
        s.scope,
        "splice 后结构 + 覆盖 + 往返",
        issues.is_empty(),
        if issues.is_empty() {
            format!("{} 行 / {} 块，全部成立", after.len(), blocks.len())
        } else {
            issues.join("；")
        },
    );

    let kinds: Vec<&str> = blocks.iter().map(|b| b.kind.as_str()).collect();
    push(
        &mut checks,
        s.scope,
        "splice 后块种类序列",
        kinds == s.kinds_after,
        format!("得到 {kinds:?}，期望 {:?}", s.kinds_after),
    );

    let missing: Vec<&str> = s
        .must_contain
        .iter()
        .copied()
        .filter(|needle| !after.iter().any(|l| l.contains(needle)))
        .collect();
    push(
        &mut checks,
        s.scope,
        "必须逐字保留的行",
        missing.is_empty(),
        if missing.is_empty() {
            format!("{:?} 都在", s.must_contain)
        } else {
            format!("{missing:?} 丢了")
        },
    );

    // 反向自证：`splice` 不许悄悄改变未触及的行。
    // ⚠️ 新行占据的**新行号**区间是 `[start, start + new.len() - 1]`（1-based，含），
    // 于是尾巴从 `start + new.len()` 开始——早先写成 `> start + len` 会把尾巴第一行也排掉，
    // 那是判据自己写错了，不是 splice 错了。
    let prefix_end = (s.start as usize) - 1;
    let tail_from_new = (s.start as usize) - 1 + s.new.len();
    let untouched_ok = after[..prefix_end] == joined[..prefix_end]
        && after[tail_from_new..] == joined[(s.end as usize)..];
    push(
        &mut checks,
        s.scope,
        "未触及的行逐字不变",
        untouched_ok,
        format!(
            "前缀 {} 行 ＋ 尾巴 {} 行（新行 {} 行）",
            prefix_end,
            after.len() - tail_from_new,
            s.new.len()
        ),
    );

    checks
}

// ————————————————————————————————————————————————————————————————————————————
// 陈旧行号（为什么 `line_count` 必须进身份四件套）
// ————————————————————————————————————————————————————————————————————————————

/// ⭐ 判据：一次改变行数的编辑之后，**拿旧行号再提一次**会**静默落到别的行上**——
/// 它不会报错、不会越界，只是改错了地方。⇒ 这就是 `design/0047` §2.4 把
/// `line_count` 放进身份四件套、且迟到回包一律丢弃的**直接理由**。
fn check_stale_line_numbers() -> Vec<Check> {
    let mut checks = Vec::new();
    let src = "para one\n\npara two\n";
    let lines = lines_of(src);
    let blocks = top_blocks(src);

    // 第 1 次提交：在块 0（行 1）里插一行 ⇒ 全文 4 行变 5 行
    let after1 = splice_lines(&lines, 1, 1, &["para one", "续行"]).unwrap();
    let new_src = after1.join("\n");

    // 第 2 次提交：用**旧**块表里块 1（para two，旧行 3-3）的行号
    let stale = &blocks[1];
    let landed = after1
        .get((stale.start_line as usize) - 1)
        .cloned()
        .unwrap_or_else(|| "<越界>".into());
    push(
        &mut checks,
        "陈旧行号",
        format!(
            "旧 span {}-{} 落到新文本第 {} 行",
            stale.start_line, stale.end_line, stale.start_line
        ),
        true,
        format!("那里现在是 `{landed}`（期望 `para two`，实际不是）"),
    );
    push(
        &mut checks,
        "陈旧行号",
        "旧 span 在新文本里**不再**指向原块",
        landed != "para two",
        format!("现内容 `{landed}` ⇒ 静默改错位置，判据成立"),
    );

    // 而按新块表重新解算就能拿到正确 span
    let new_blocks = top_blocks(&new_src);
    let fresh = new_blocks
        .iter()
        .find(|b| {
            let s = after1.get((b.start_line as usize) - 1).map(|x| x.as_str());
            s == Some("para two")
        })
        .map(|b| b.start_line);
    push(
        &mut checks,
        "陈旧行号",
        "按新块表重解算能拿到正确行号",
        fresh == Some(4),
        format!("新块表里 `para two` 在第 {fresh:?} 行（期望 Some(4)）"),
    );

    // 行数变化本身是**可观测**的 ⇒ 它足以当身份的一部分
    push(
        &mut checks,
        "陈旧行号",
        "行数是可观测的身份位",
        lines.len() != after1.len(),
        format!("{} 行 → {} 行", lines.len(), after1.len()),
    );

    checks
}

// ————————————————————————————————————————————————————————————————————————————
// 契约：可编辑性 × 往返稳定性
// ————————————————————————————————————————————————————————————————————————————

/// ⭐ 这条判据把"块种类清单"与"单块视图成不成立"**绑在一起**：
///
/// **可编辑 ⇒ 切片重 parse 必须是同一块**（否则单块视图看到的东西与整篇渲染不一致）。
/// 反过来**不成立也不要求**（`Table` 能往返但偏不让编辑——那是版面理由，不是稳定性理由）。
///
/// ⚠️ 它抓的是"清单漏项"：只要有人把一种**往返不稳定**的块标成可编辑，这里立刻红。
fn check_editability() -> Vec<Check> {
    use std::collections::BTreeMap;

    // kind → (是否标为可编辑, 该种类**每一块**都往返成功)
    let mut observed: BTreeMap<String, (bool, bool)> = BTreeMap::new();
    for f in FIXTURES {
        let lines = lines_of(f.src);
        for b in top_blocks(f.src) {
            let ok = crate::slice_lines(&lines, b.start_line, b.end_line)
                .map(|s| crate::round_trip(&s).is_ok())
                .unwrap_or(false);
            let slot = observed
                .entry(b.kind.clone())
                .or_insert((crate::editable_kind(&b.kind), true));
            slot.1 &= ok;
        }
    }

    let mut checks = Vec::new();
    for (kind, (editable, roundtrip_ok)) in &observed {
        push(
            &mut checks,
            "契约·可编辑性 × 往返",
            format!("{kind}"),
            !editable || *roundtrip_ok,
            match (*editable, *roundtrip_ok) {
                (true, true) => "可编辑，且切片往返稳定".to_string(),
                (false, true) => "不可编辑（版面理由），往返其实稳定".to_string(),
                (false, false) => "不可编辑，且切片往返不稳定 ⇒ 清单正确".to_string(),
                (true, false) => "⛔ 标了可编辑，但切片往返不稳定".to_string(),
            },
        );
    }

    // 不可编辑的清单本身也要钉住，否则"悄悄多一项"没人看得见
    let mut non_editable: Vec<String> = observed
        .iter()
        .filter(|(_, (e, _))| !e)
        .map(|(k, _)| k.clone())
        .collect();
    non_editable.sort();
    let expected: Vec<String> = ["FootnoteDefinition", "HtmlBlock", "Table", "ThematicBreak"]
        .iter()
        .filter(|k| observed.contains_key(**k))
        .map(|k| k.to_string())
        .collect();
    push(
        &mut checks,
        "契约·可编辑性 × 往返",
        "不可编辑清单（夹具里出现过的）",
        non_editable == expected,
        format!("得到 {non_editable:?}，期望 {expected:?}"),
    );

    checks
}

// ————————————————————————————————————————————————————————————————————————————

pub fn run() -> Report {
    let mut checks = Vec::new();
    for f in FIXTURES {
        checks.extend(check_fixture(f));
    }
    for s in SPLICES {
        checks.extend(check_splice(s));
    }
    checks.extend(check_stale_line_numbers());
    checks.extend(check_editability());
    Report { checks }
}

/// 供测试/调试：列出每条夹具的实际块表（⛔ 不进报告，只用于人工核对）。
#[allow(dead_code)]
pub fn dump() {
    for f in FIXTURES {
        let (blocks, _) = evaluate(f.src);
        println!("\n## {}", f.name);
        for b in &blocks {
            println!(
                "  块 {} {} 行 {}-{}",
                b.index, b.kind, b.start_line, b.end_line
            );
        }
        let n = lines_of(f.src).len() as u32;
        println!("  块间行: {:?}", gap_lines(n, &blocks));
    }
}

/// `kind_name` 在这里没有直接用到，但保留 `use` 是为了让"块种类名只有一份来源"这件事显式化：
/// 夹具里的字符串常量必须与 `main.rs::kind_name` 的返回值**逐字相同**，否则种类判据会假红。
#[allow(dead_code)]
fn _kind_source_is_single() -> &'static str {
    kind_name(&comrak::nodes::NodeValue::Document)
}
