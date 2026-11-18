//! ` ```mermaid ` 围栏 → SVG（`design/0060`）。
//!
//! # 它和 `diagram.rs` 是什么关系
//!
//! `diagram.rs` 是 ` ```flow ` / ` ```sequence ` 的**翻译层**：先把两个私有 DSL 改写成
//! Mermaid 源码，再交给 `flowmaid`。本文件**没有翻译层**——源码就是 Mermaid，
//! 直接 `parser::parse_document()` → `model::Document` → `render::*_with()`。
//!
//! ⭐ **解析一次、量两次、出一次图**（`design/0060` §0 第 2 条）：
//! `parse_document` 的产物既用来**数真实规模**，也**原样**交给 render，
//! ⛔ 不重复解析。这是 0.33 才公开的接口，也是升版的唯一理由。
//!
//! # 四道闸门（顺序即契约，`design/0060` §2.0）
//!
//! | 闸门 | 挡什么 | 为什么不能省 |
//! |---|---|---|
//! | ① 头部准入 | 不认识 / 不支持的图种 | 引擎对未知头部**静默当成流程图**（实测 `foobar` → `Ok`） |
//! | ② 线性预扫描 | **解析期**的乘法放大 | 实测 `A0&…&A99 --> B0&…&B99`：**1192 字节 → 10000 条边** |
//! | ③ 真实模型计数 | **布局期**的放大 | 布局是超线性的：1024 边 7 ms、490k 边仅解析就 70 ms |
//! | ④ XML 白名单重建 | 导航、外链、事件属性、ID 串台 | 引擎**原样产出** `<a href="file://…">` 与 `url(https://…)` |
//!
//! 任何一条不过 ⇒ **整块回退**成代码块 ＋ **一句看得见的原因**（`INV-DIAG-01` 扩）。
//!
//! # 颜色：两态契约（`design/0060` §2.1⑥）
//!
//! 引擎把颜色**写死**在表现属性里，而 SVG 里**作者的 `#ffffff` 与引擎的白无法区分**
//! （实测：`classDef x fill:#ffffff` 与无样式输出色值集合完全相同）。
//! ⇒ 只能按**模型**判：模型里有任何作者样式 ⇒ **整图保留作者配色、明确不跟主题**；
//! 否则 ⇒ **全部**换成 `var(--reader-diag-*)`。⛔ 「引擎色主题化、作者色保留」做不到，
//! 那条在评审 P1-2 已作废。

use std::fmt::{self, Write as _};

use comrak::html::{ChildRendering, Context};
use comrak::nodes::NodeCodeBlock;
use flowmaid::model::Document;
use flowmaid::scene::SvgOptions;
use quick_xml::events::Event;
use quick_xml::reader::Reader;

use super::highlight::{escape_html_into, PRE_CLASS};
use super::render::RenderStats;

// ─────────────────────────── 预算（design/0060 §6.1）───────────────────────────

/// 单块源码上限。与 `diagram::MAX_INPUT` 同值，但**各自独立**：
/// 改一个不该顺带改另一个（两族的判据不同）。
const MAX_SOURCE: usize = 16 * 1024;
/// 全文 Mermaid 源码累计上限。
const MAX_DOC_SOURCE: usize = 64 * 1024;
/// 预扫描（解析前）的边估算上限。
const MAX_PRESCAN_EDGES: usize = 512;
/// 预扫描（解析前）的标识符 token 上限——无箭头也能造节点（实测 500 个）。
const MAX_PRESCAN_TOKENS: usize = 512;
/// 真实模型：单图节点数上限。
const MAX_NODES: usize = 512;
/// 真实模型：全文节点累计上限。
const MAX_DOC_NODES: usize = 2048;
/// 真实模型：单图关系数（边/消息/提交/切片…）上限。
const MAX_RELATIONS: usize = 512;
/// 真实模型：全文关系累计上限。
const MAX_DOC_RELATIONS: usize = 2048;
/// 单图 subgraph 数上限。
const MAX_CLUSTERS: usize = 32;
/// 单图嵌套深度上限。⚠️ 上游只挡到 500 层；实测 450 层要 **20.9 ms**。
const MAX_DEPTH: usize = 16;
/// 全文图数上限。
const MAX_DIAGRAMS: usize = 32;
/// 单图 SVG 字节上限（约 400 B/边 ⇒ 512 KiB ≈ 1200 边）。
const MAX_SVG: usize = 512 * 1024;
/// 全文 SVG 字节累计上限（与代码高亮同口径）。
const MAX_DOC_SVG: usize = 4 * 1024 * 1024;
/// 回退说明里那句细节的最大字节数（按 UTF-8 字符边界截）。
const MAX_REASON_BYTES: usize = 200;
/// 回退提示的句首。⚠️ 它**算在** `MAX_REASON_BYTES` 里（`bugs/0075` §6 的整行判据）。
const NOTE_PREFIX: &str = "未渲染：";
/// 全文的 **Mermaid 围栏总数**上限（评审 P1-4）。
///
/// ⚠️ 回退的块**不占**图数（`MAX_DIAGRAMS`）与字节额度——它没有产物——
/// 所以没有这一条时，一份塞满坏图的文档可以有**任意多块**，每块都走一遍
/// `classify` ＋ 预扫描 ＋ 必要时解析。128 与图数 32 一样是**全文**闸门
/// （触顶即粘滞，`INV-MERMAID-04`）。
const MAX_BLOCKS: usize = 128;

// ─────────────────────────── 准入表（§2.1④）───────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Support {
    Yes,
    No,
}

/// 头部 token → 支不支持。
///
/// ⚠️ **`No` 那一半不是装饰**：引擎认识这些图种（或至少不报错），
/// 但我们不定它的产物白名单 ⇒ 明确说「暂不支持」，⛔ 不让它进白名单试运气。
const ADMISSION: &[(&str, Support)] = &[
    ("flowchart", Support::Yes),
    ("graph", Support::Yes),
    ("sequenceDiagram", Support::Yes),
    ("classDiagram", Support::Yes),
    ("stateDiagram-v2", Support::Yes),
    ("stateDiagram", Support::Yes),
    ("erDiagram", Support::Yes),
    ("pie", Support::Yes),
    ("mindmap", Support::Yes),
    ("journey", Support::Yes),
    ("gitGraph", Support::Yes),
    ("timeline", Support::Yes),
    ("sankey-beta", Support::Yes),
    ("sankey", Support::Yes),
    ("architecture-beta", Support::Yes),
    ("architecture", Support::Yes),
    ("gantt", Support::No),
    ("xychart-beta", Support::No),
    ("quadrantChart", Support::No),
    ("kanban", Support::No),
    ("treemap", Support::No),
    ("treemap-beta", Support::No),
    ("requirementDiagram", Support::No),
    ("block-beta", Support::No),
    ("packet-beta", Support::No),
    ("packet", Support::No),
    ("radar-beta", Support::No),
    ("C4Context", Support::No),
    ("C4Container", Support::No),
    ("C4Component", Support::No),
    ("C4Dynamic", Support::No),
    ("C4Deployment", Support::No),
    ("zenuml", Support::No),
    ("swimlane-beta", Support::No),
];

// ─────────────────────────── 回退原因（§2.1⑧）───────────────────────────

/// 为什么没画。⭐ **它会被写成文档里的一句话**（⛔ 不是藏在 `data-*` 里）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reject {
    /// 认识但明确不支持（`gantt` / `kanban` …）。
    UnsupportedKind(String),
    /// 准入表里没有的头部。
    UnknownKind(String),
    /// 开头是 `---` 且找得到闭合：引擎会**静默丢弃**它。
    Frontmatter,
    /// 开头是 `---` 但找不到闭合。
    FrontmatterUnclosed,
    /// `%%{init: …}%%`：引擎**逐字节忽略**它 ⇒ 接受等于静默丢作者配置。
    Config,
    /// 解析成功但主集合全空（含只有头部 / 只有 `classDef`）。
    Empty,
    /// 任何一道**单块**规模闸门。
    TooLarge,
    /// ⭐ **全文**额度用完（图数 / 围栏数 / 源码字节 / 节点 / 关系 / SVG 字节）。
    ///
    /// ⚠️ 与 `TooLarge` 分开是**归因**问题（评审 P2）：说成"超出规模限制"时，
    /// 用户会去删那一块图里的节点——而真正的做法是删掉**别的**图。
    DocBudget,
    /// 引擎的语法错误（带行号）。
    Syntax(usize, String),
    /// ⭐ `bugs/0076`：引擎**没实现的标准构造**（`rect` / `namespace` …）。
    /// ⚠️ 与 `Syntax` 分开是**归因**问题：说成「语法错误」时，作者会去改本来正确的源码。
    UnsupportedSyntax(&'static str),
    /// XML 白名单拒绝（fail-closed）。
    Security,
}

impl Reject {
    /// 给用户看的那一行。⚠️ 措辞是**判据**（`docs/features/0060` §3 第 3 条）：
    /// 必须说清"为什么"，⛔ 不是一句「出错了」。
    ///
    /// ⚠️ 预算是**整条提示**的 `MAX_REASON_BYTES`（`write_fallback` 还会在句首加
    /// `NOTE_PREFIX`）⇒ 扣掉前缀之后再分给各分支（`bugs/0075` §6）。
    fn text(&self) -> String {
        let budget = MAX_REASON_BYTES.saturating_sub(NOTE_PREFIX.len());
        match self {
            // ⚠️ 两个 `*Kind` 的 `k` 来自**用户首行**（`UnknownKind` 尤其无界）⇒
            //    必须在拼文案之前就把细节截到余额内，⛔ 不能等整句拼完再截：
            //    那样会把结尾的 `）` 一起切掉，提示变成一句没闭合的话（`bugs/0075`）。
            Self::UnsupportedKind(k) => kind_reason("这类图暂不支持", k, budget),
            Self::UnknownKind(k) => kind_reason("不认识的图类型", k, budget),
            Self::Frontmatter => "frontmatter 暂不支持".into(),
            Self::FrontmatterUnclosed => "frontmatter 未闭合".into(),
            Self::Config => "配置指令（%%{init}%%）暂不支持".into(),
            Self::Empty => "空图".into(),
            Self::TooLarge => "超出规模限制".into(),
            Self::DocBudget => "全文的图额度已用完（本块及后续不再渲染）".into(),
            Self::Syntax(line, msg) => {
                let head = msg.lines().next().unwrap_or("").trim();
                let bare = format!("语法错误（第 {line} 行）");
                let lead = format!("{bare}：");
                let head = truncate_utf8(head, budget.saturating_sub(lead.len()));
                if head.is_empty() {
                    bare
                } else {
                    format!("{lead}{head}")
                }
            }
            Self::UnsupportedSyntax(c) => format!("这类写法暂不支持（{c}）"),
            Self::Security => "安全拒绝".into(),
        }
    }
}

/// 按 **UTF-8 字符边界**截到至多 `max` 字节。⛔ 不按字节切——切进中文中间会 panic
/// 或产出 U+FFFD。
fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// 拼「标签（细节）」，细节按 `budget` 的余额截断（`budget` 已扣掉整行前缀）。
///
/// ⭐ 截的是**细节**，⛔ 不是拼好的整句：整句截断会把结尾的 `）` 切掉，
/// 而余额连一个字都放不下时干脆退化成不带括号的标签（`bugs/0075` §5）。
fn kind_reason(label: &str, kind: &str, budget: usize) -> String {
    const OPEN: &str = "（";
    const CLOSE: &str = "）";
    let budget = budget.saturating_sub(label.len() + OPEN.len() + CLOSE.len());
    let kind = truncate_utf8(kind, budget);
    if kind.is_empty() {
        label.to_string()
    } else {
        format!("{label}{OPEN}{kind}{CLOSE}")
    }
}

// ─────────────────── 命名实体码（`bugs/0074`）───────────────────

/// Mermaid 官方 `entityMap`（`mermaid/src/utils` 那三十条）。
///
/// ⚠️ 只收**具名**形式：`#35;` / `#60;` / `#9829;` 这类数字实体引擎自己会解，
///    这里再解一遍反而要跟引擎的边界对齐，⛔ 不做。
const ENTITIES: &[(&str, char)] = &[
    ("#quot;", '"'),
    ("#amp;", '&'),
    ("#lt;", '<'),
    ("#gt;", '>'),
    ("#nbsp;", '\u{a0}'),
    ("#period;", '.'),
    ("#comma;", ','),
    ("#colon;", ':'),
    ("#semi;", ';'),
    ("#plus;", '+'),
    ("#minus;", '-'),
    ("#sol;", '/'),
    ("#backslash;", '\\'),
    ("#lpar;", '('),
    ("#rpar;", ')'),
    ("#lbrace;", '{'),
    ("#rbrace;", '}'),
    ("#lbrack;", '['),
    ("#rbrack;", ']'),
    ("#equals;", '='),
    ("#tilde;", '~'),
    ("#grave;", '`'),
    ("#num;", '#'),
    ("#excl;", '!'),
    ("#at;", '@'),
    ("#dollar;", '$'),
    ("#percnt;", '%'),
    ("#ast;", '*'),
    ("#quest;", '?'),
    ("#apos;", '\''),
];

/// 单趟解码具名实体。返回 `None` ＝ 一个都没命中（调用方继续用原文，零分配）。
///
/// ⚠️ **单趟**是语义要求：`#num;lt;` 只解成 `#lt;`，⛔ 不能接着把 `lt;` 再解成 `<`。
/// ⚠️ 只认 `#名字;`，⛔ 不解 `&lt;` 这类 XML 实体——否则作者刻意写的 `&amp;lt;`
///    会被二次解码（`bugs/0074` §5）。
fn decode_entities(src: &str) -> Option<String> {
    let mut out = String::with_capacity(src.len());
    let mut rest = src;
    let mut changed = false;
    'outer: while let Some(i) = rest.find('#') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        for (k, v) in ENTITIES {
            if tail.starts_with(k) {
                out.push(*v);
                rest = &tail[k.len()..];
                changed = true;
                continue 'outer;
            }
        }
        out.push('#');
        rest = &tail[1..];
    }
    out.push_str(rest);
    if changed {
        Some(out)
    } else {
        None
    }
}

/// 引擎的 `Err` 落在一条**已知不支持的标准构造**上吗（`bugs/0076`）？
///
/// ⚠️ 判据是「**出错那一行**的整行形状」＋「图种对得上」两条同时成立：
///    ⛔ 不扫全文找关键字——那样会把真正的语法错误吞成「暂不支持」。
fn known_construct(kind: &str, line: &str) -> Option<&'static str> {
    let t = line.trim();
    let starts = |kw: &str| {
        t == kw
            || t
                .strip_prefix(kw)
                .is_some_and(|r| r.starts_with([' ', '\t', '(']))
    };
    match kind {
        "sequenceDiagram" => {
            if starts("rect") {
                return Some("rect");
            }
        }
        "classDiagram" => {
            if starts("namespace") {
                return Some("namespace");
            }
            if starts("cssClass") {
                return Some("cssClass");
            }
            if t.starts_with("<<") && t.contains(">>") {
                return Some("独立的 <<interface>>");
            }
        }
        "stateDiagram" | "stateDiagram-v2" => {
            if t == "--" {
                return Some("并发分隔线 --");
            }
        }
        _ => {}
    }
    None
}

// ─────────────────────────── 准入 ＋ 头部解析 ───────────────────────────

/// 头部解析的产物：图种 token（`ADMISSION` 的键）。
pub fn classify(src: &str) -> Result<&str, Reject> {
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    let mut lines = src.lines().peekable();

    // ① frontmatter：只有**首个非空行**是独占 `---` 才算。
    let first = loop {
        match lines.next() {
            Some(l) if l.trim().is_empty() => continue,
            Some(l) => break l,
            None => return Err(Reject::Empty),
        }
    };
    if first.trim() == "---" {
        for l in lines.by_ref() {
            if l.trim() == "---" {
                return Err(Reject::Frontmatter);
            }
        }
        return Err(Reject::FrontmatterUnclosed);
    }

    // ② `%%{…}%%` 配置指令：**任何一行**都算（评审 P1-2）。
    //    ⚠️ 引擎只认**行首**（允许前导空白），命中就**逐字节忽略** ⇒ 接受等于静默丢作者配置。
    //    ⛔ 旧写法只查表头之前那几行：`flowchart TD` 之后写 `%%{init}%%` 会被静默吃掉。
    if src.lines().any(|l| l.trim_start().starts_with("%%{")) {
        return Err(Reject::Config);
    }

    // ③ 跳过空行与 `%%` 注释。
    // ⚠️ 上面已经吃掉了一行（`first`），它本身就要参与判定 ⇒ 先查它。
    let mut pending = Some(first);
    let header = loop {
        let line = match pending.take() {
            Some(l) => l,
            None => match lines.next() {
                Some(l) => l,
                None => return Err(Reject::Empty),
            },
        };
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with("%%") {
            continue;
        }
        break t;
    };

    // ③ 取**第一个 token**（⛔ 不是第二个词）。`gitGraph` 允许紧跟 `:`。
    let tok = header.split_whitespace().next().unwrap_or("");
    let tok = tok.strip_suffix(':').unwrap_or(tok);
    if tok.is_empty() {
        return Err(Reject::Empty);
    }
    if let Some(&(kind, yes)) = ADMISSION.iter().find(|(k, _)| *k == tok) {
        if yes == Support::No {
            return Err(Reject::UnsupportedKind(kind.to_string()));
        }
        return Ok(kind);
    }
    Err(Reject::UnknownKind(tok.to_string()))
}

// ─────────────────────────── 第一道预算：线性预扫描（§2.1⑤）───────────────────────────

/// 预扫描结果：标识符 token 数、边估算（**上界**）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Estimate {
    pub tokens: usize,
    pub edges: usize,
}

/// 解析前的保守上界。`flowchart` 有 `&` 乘法语法，其余图种没有（实测 `;` 不切分语句）。
///
/// ⚠️⚠️ **头部关键字只认第一条非注释语句**（评审 P0-1，2026-11-03）：
/// 旧写法对**每一行**都套 `ADMISSION`，于是
/// `flowchart TD` / `graph &A…&A --> B…&B` 里的第二行被当成表头跳过
/// ⇒ 预扫描算 0 个 token，而引擎把它当边解析（实测 16 KiB 能做出千万级边）。
pub fn prescan(src: &str, flowchart: bool) -> Estimate {
    let mut tokens = 0usize;
    let mut edges = 0usize;
    let mut seen_header = false;
    // `accDescr {` 的多行块：块内是纯文本，⛔ 不是节点或关系（评审 P2-3）。
    let mut acc_block = false;
    for line in src.lines() {
        if acc_block {
            if line.contains('}') {
                acc_block = false;
            }
            continue;
        }
        for stmt in line.split(';') {
            let s = stmt.trim();
            if s.is_empty() {
                continue;
            }
            // `%%` 注释与 `%%{…}%%` 配置：任何位置都不是节点。
            if s.starts_with("%%") {
                continue;
            }
            if !seen_header {
                seen_header = true;
                if is_header(s) {
                    continue;
                }
            }
            if is_body_directive(s) {
                if s.to_ascii_lowercase().starts_with("accdescr")
                    && s.contains('{')
                    && !s.contains('}')
                {
                    acc_block = true;
                }
                continue;
            }
            if flowchart {
                let e = estimate_flow(stmt);
                tokens = tokens.saturating_add(e.tokens);
                edges = edges.saturating_add(e.edges);
            } else {
                // 非流程图：一条语句至多一条关系（实测 seq/class/er 的 `;` 不切分）。
                tokens = tokens.saturating_add(1);
                edges = edges.saturating_add(1);
            }
        }
    }
    Estimate { tokens, edges }
}

/// **第一条**非注释语句是不是表头（`flowchart TD` 里的两个词都不是节点）。
///
/// ⚠️ 这条**只能**用在第一条语句上：`graph` / `pie` 这些词在正文里是合法节点名。
fn is_header(s: &str) -> bool {
    let head = s.split_whitespace().next().unwrap_or("");
    ADMISSION.iter().any(|(k, _)| *k == head) || matches!(head, "TD" | "TB" | "BT" | "LR" | "RL")
}

/// 正文里**不产出节点或边**的语句（`subgraph` / `style` / `classDef` / `accTitle:` …）。
///
/// ⚠️ 头关键字后面紧跟边运算符时**不是**指令而是边：
/// `style --> B` 是"从一个名叫 `style` 的子图出发的边"（引擎 `parser.rs` 的
/// `kw_head_is_edge`）。⇒ 只要后面看着像边运算符，就**不当指令**（宁可多算）。
fn is_body_directive(s: &str) -> bool {
    let head = s.split_whitespace().next().unwrap_or("");
    let known = matches!(
        head,
        "TD" | "TB" | "BT" | "LR" | "RL"
            | "subgraph"
            | "end"
            | "classDef"
            | "style"
            | "linkStyle"
            | "click"
            | "direction"
    ) || head.eq_ignore_ascii_case("accTitle:")
        || head.eq_ignore_ascii_case("accDescr:")
        || head.eq_ignore_ascii_case("accDescr");
    if !known {
        return false;
    }
    let rest = s[head.len()..].trim_start();
    // 保守：这些字符开头的一律当边（`&` 扇出、`-->`、`-.->`、`==>`、`~~~`、
    // `<-->`、`o--`、`x--`）。多算只会更早触发预算，⛔ 不会放过放大。
    !rest.starts_with(['&', '-', '.', '=', '~', '<', 'o', 'x'])
}

/// 一条 flowchart 语句的 `(token 数, 边估算)`。
///
/// ⭐ 边估算的来历（`design/0060` §2.1⑤）：
/// - **不含 `&`** ⇒ `T − 1`（一条链最多 `T−1` 条边）；
/// - **含 `&`** ⇒ `(Σgᵢ)² ÷ 4`，`gᵢ` 是第 i 个 `&` 段里的 token 数。
///   实测 `A0&…&A99 --> B0&…&B99`：Σg = 200 ⇒ **10000**，与真实边数**逐个相等**。
///
/// ⚠️ **标签内容不计入**：`[` `(` `{` `|` `>` 里的文字不可能是节点或边，
/// 所以整段跳过——否则一段中文标签会被算成几十个 token，把一屏正常的图打成回退。
/// 这仍然只**收紧**，不会低算：边与节点都只能出现在括号外面。
fn estimate_flow(s: &str) -> Estimate {
    // ⚠️ 乘法公式只对**有箭头**的语句成立：`A0 & A1 & …`（无箭头）一个边都不产出，
    //    套 `(Σg)²/4` 会把 512 个节点估成 65536 条边——一屏合法的图被打成回退。
    //    ⚠️ `~~~`（不可见连线）两个都不含 ⇒ 漏了它上界就不成立（评审 P0-2）。
    let edgeish = s.contains('-') || s.contains('=') || s.contains('~');
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    let mut tokens = 0usize;
    let mut groups: Vec<usize> = Vec::new();
    let mut group = 0usize;
    let mut in_run = false;
    let mut in_label: Vec<char> = Vec::new();
    let mut quote = false;

    while i < chars.len() {
        let c = chars[i];
        // —— 标签/引号里：整段跳过 ——
        if let Some(&open) = in_label.last() {
            if quote {
                if c == '"' {
                    quote = false;
                }
            } else if c == '"' {
                quote = true;
            } else if c == open {
                in_label.push(open);
            } else if (open == '[' && c == ']')
                || (open == '(' && c == ')')
                || (open == '{' && c == '}')
                || (open == '|' && c == '|')
                || (open == '>' && c == ']')
            {
                in_label.pop();
            }
            i += 1;
            continue;
        }
        if c == '&' {
            // ⚠️ **不要**在这里再给 `group` 加一：`in_run` 那次计数发生在 run **开始**时，
            //    再加一次就是双算（2026-11-03 实测：n=10 估成 111 而不是 100）。
            in_run = false;
            groups.push(group);
            group = 0;
            i += 1;
            continue;
        }
        if c == '[' || c == '(' || c == '{' || c == '|' {
            in_run = false;
            in_label.push(c);
            i += 1;
            continue;
        }
        // `A>文字]`（非对称旗形）：`>` 紧跟标识符才算标签开口，
        // ⛔ 否则 `A-->B` 的 `>` 会把后半句当标签吃掉。
        if c == '>' && in_run {
            in_run = false;
            in_label.push('>');
            i += 1;
            continue;
        }
        if c.is_alphanumeric() || c == '_' {
            if !in_run {
                in_run = true;
                group += 1;
                tokens += 1;
            }
        } else {
            in_run = false;
        }
        i += 1;
    }
    groups.push(group);

    let edges = if groups.len() > 1 && edgeish {
        let sum: usize = groups.iter().sum();
        (sum * sum) / 4
    } else {
        tokens.saturating_sub(1)
    };
    Estimate { tokens, edges }
}

// ─────────────────────────── 第二道预算：真实模型计数（§2.1⑤）───────────────────────────

/// 一张图的真实规模。⭐ **这就是最终判据**——预扫描只是解析前的闸门。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counts {
    pub nodes: usize,
    pub relations: usize,
    pub clusters: usize,
    pub depth: usize,
}

impl Counts {
    /// 主集合全空 ⇒ 空图。⚠️ 实测空源码 / 只有头部 / 只有注释都产出
    /// 一张 **56×56 白板 SVG** 且返回 `Ok`——那不是"画出来了"，是"什么都没画"。
    pub fn is_empty(&self) -> bool {
        self.nodes == 0 && self.relations == 0
    }
}

/// 按 `Document` 变体逐类取数。
fn counts(doc: &Document) -> Counts {
    use flowmaid::model::Document as D;
    let mut c = Counts::default();
    match doc {
        D::Flowchart(g) | D::State(g) => {
            c.nodes = g.nodes.len();
            c.relations = g.edges.len() + g.sub_edges.len();
            c.clusters = g.subgraphs.len();
            c.depth = g
                .subgraphs
                .iter()
                .enumerate()
                .map(|(i, _)| subgraph_depth(g, i))
                .max()
                .unwrap_or(0);
        }
        D::Er(d) => {
            c.nodes = d.entities.len();
            c.relations = d.relations.len();
        }
        D::Class(d) => {
            c.nodes = d.classes.len();
            c.relations = d.relations.len();
        }
        D::Sequence(d) => {
            c.nodes = d.participants.len();
            // ⚠️ `items` 里既有消息也有 `Note` / `Frame`，都算排版单元。
            c.relations = d.items.len();
        }
        D::Pie(d) => c.nodes = d.slices.len(),
        D::Mindmap(d) => {
            c.nodes = d.nodes.len();
            c.relations = d.nodes.len().saturating_sub(1);
            c.depth = d.nodes.iter().map(|n| n.depth).max().unwrap_or(0);
        }
        D::Journey(d) => {
            c.nodes = d.actors.len();
            c.relations = d.sections.iter().map(|s| s.tasks.len()).sum();
        }
        D::GitGraph(d) => {
            c.nodes = d.commits.len();
            c.relations = d.commits.len();
        }
        D::Architecture(d) => {
            c.nodes = d.services.len();
            c.relations = d.edges.len();
            c.clusters = d.groups.len();
        }
        D::Timeline(d) => {
            c.nodes = d.sections.iter().map(|s| s.periods.len()).sum();
            c.relations = d
                .sections
                .iter()
                .map(|s| s.periods.iter().map(|p| p.events.len()).sum::<usize>())
                .sum();
        }
        D::Sankey(d) => {
            c.nodes = d.nodes.len();
            c.relations = d.links.len();
        }
    }
    c
}

/// `subgraphs[i]` 的嵌套层数（自身算 1）。⚠️ 防御环：`parent` 链最多走 `len` 步。
/// ⚠️ `parent` 是**索引**：越界就停（`get` 而不是 `[]`）——渲染路径上宁可少算一层，
/// 也不许因为一个坏索引把整份文档打崩。
fn subgraph_depth(g: &flowmaid::model::Graph, i: usize) -> usize {
    let mut d = 1usize;
    let mut cur = g.subgraphs.get(i).and_then(|s| s.parent);
    let mut guard = 0usize;
    while let Some(p) = cur {
        guard += 1;
        if guard > g.subgraphs.len() {
            break;
        }
        let Some(sg) = g.subgraphs.get(p) else {
            break;
        };
        d += 1;
        cur = sg.parent;
    }
    d
}

// ─────────────────────────── 颜色：两态判定（§2.1⑥）───────────────────────────

/// 模型里有没有**作者写的样式**。
///
/// ⭐ 判定用模型，⛔ 不用源码正则：`style` / `classDef`+`class` / `linkStyle`
/// 三条路径解析后都会落到 `NodeStyle` / `EdgeMeta::style` 上。
/// ⚠️ `classDef` 定义了但没人用 ⇒ 模型里没有样式 ⇒ 仍是模式 A（正确）。
fn has_author_style(doc: &Document) -> bool {
    use flowmaid::model::Document as D;
    let node_styled = |ns: &flowmaid::model::NodeStyle| {
        ns.fill.is_some() || ns.stroke.is_some() || ns.stroke_width.is_some() || ns.color.is_some()
    };
    let graph_styled = |g: &flowmaid::model::Graph| {
        g.nodes.iter().any(|n| node_styled(&n.style))
            || g.edges.iter().any(|e| !e.meta.style.is_empty())
            || g.sub_edges.iter().any(|e| !e.meta.style.is_empty())
    };
    match doc {
        D::Flowchart(g) | D::State(g) => graph_styled(g),
        D::Mindmap(d) => d.nodes.iter().any(|n| node_styled(&n.style)),
        _ => false,
    }
}

// ─────────────────────────── 引擎色 → 语义变量（§2.1⑥）───────────────────────────

/// `flowmaid 0.33.0` 的**全部**运行期色值（12 类语料实跑取并集，39 个）→ 我们的语义槽。
///
/// ⚠️ **多对一**：本表 59 条映射，落在 `--reader-diag-*` 的 **25** 个槽上。
/// （覆盖面由「模式a下没有字面色残留」守着——它把 12 类语料整条 SVG 扫一遍；
/// 2026-11-03 另用 14 类更复杂的语料实测过一遍，残留为零。）深色/浅色的十六色循环
/// （`ACCENTS_DEEP`）会与浅色那半撞色——这是**刻意的**：宁可两个色相相近，
/// 也不让深色主题下露出一块刺眼的白。
///
/// ⭐ **来历是源码与实跑，不是截图**：`style.rs` 的 `shape_style` / `ACCENTS` /
/// `ACCENT_INKS` / `ACCENTS_DEEP` / `NOTE_STYLE`，`scene.rs` 的
/// `EDGE_COLOR` / `TEXT_COLOR` / `LABEL_BORDER`，`seq.rs` 的 `GUIDE_COLOR`。
/// ⛔ 表里**不许**收一个引擎已经不再使用的值（多收无害但会误导）；
/// ✅ 自动防线 = 单测「模式 A 下 12 类语料零 `#rrggbb` 残留」——
/// 引擎升版换了色值，那条立刻变红。
const MERMAID_SWATCHES: &[(&str, &str)] = &[
    // —— 画布 / 文字 / 边 ——
    ("#ffffff", "--reader-diag-surface"),
    ("#f7f8fc", "--reader-diag-surface"),
    ("#232840", "--reader-diag-text"),
    ("#0a0e1a", "--reader-diag-text"),
    ("#000000", "--reader-diag-text"),
    ("#2f3550", "--reader-diag-text"),
    ("#2f3768", "--reader-diag-text"),
    ("#44507a", "--reader-diag-line"),
    ("#d5d9ec", "--reader-diag-line-soft"),
    // —— 辅助线 / 分隔（timeline、journey、gitgraph、sequence 生命线）——
    ("#aeb6d8", "--reader-diag-guide"),
    ("#8a90a8", "--reader-diag-guide"),
    ("#c2c8dc", "--reader-diag-guide"),
    ("#c9cdd9", "--reader-diag-guide"),
    // ⭐ 评审 P0-5（2026-11-03）：journey 的八色段落底里，indigo 那一块原先
    // 借的是 `guide`（那是**线**的颜色）——换成它的本义色。
    ("#d4d9ef", "--reader-diag-indigo-bg"),
    // —— journey 的段落底（`SECTION_FILLS`，与 `ACCENTS` 一一对应）——
    ("#cae7d5", "--reader-diag-green-bg"),
    ("#f5e2c2", "--reader-diag-amber-bg"),
    ("#efd4e1", "--reader-diag-rose-bg"),
    ("#c3e5e2", "--reader-diag-teal-bg"),
    ("#e1d5f4", "--reader-diag-violet-bg"),
    ("#f5d7d4", "--reader-diag-coral-bg"),
    ("#d1e2ee", "--reader-diag-steel-bg"),
    // —— journey 的满意度色（1 → 5：红 → 绿）——
    ("#e8574f", "--reader-diag-coral-line"),
    ("#f0894e", "--reader-diag-amber-line"),
    ("#9fcf6a", "--reader-diag-green-line"),
    // —— 子图/簇的面板（`subgraph` / `cluster`）与簇标题、ER 类型栏 ——
    ("#f7f8fd", "--reader-diag-panel"),
    ("#c9cfe8", "--reader-diag-panel-line"),
    ("#6a7086", "--reader-diag-ink-soft"),
    // —— 形状底（`style_style` 的 pastel 那一半）——
    ("#e5f5ea", "--reader-diag-green-bg"),
    ("#eef1fb", "--reader-diag-indigo-bg"),
    ("#fcf2da", "--reader-diag-amber-bg"),
    ("#e4f5f4", "--reader-diag-teal-bg"),
    ("#f2ecfa", "--reader-diag-violet-bg"),
    ("#e7eef7", "--reader-diag-steel-bg"),
    ("#fff8c5", "--reader-diag-note-bg"),
    // —— 形状描边 / 强调色（`ACCENTS`）——
    ("#5b6dc0", "--reader-diag-indigo-line"),
    ("#33a35c", "--reader-diag-green-line"),
    ("#d99114", "--reader-diag-amber-line"),
    ("#c2588c", "--reader-diag-rose-line"),
    ("#199a8e", "--reader-diag-teal-line"),
    ("#8a5cd6", "--reader-diag-violet-line"),
    ("#d96459", "--reader-diag-coral-line"),
    ("#4d8fbf", "--reader-diag-steel-line"),
    // —— 笔记卡（`NOTE_STYLE`）与 journey 的第三族 ——
    ("#9c8a2c", "--reader-diag-amber-line"),
    ("#57b563", "--reader-diag-green-line"),
    ("#f2c94c", "--reader-diag-amber-line"),
    // —— `ACCENT_INKS`（白底上的深一档文字色）——
    ("#2a864c", "--reader-diag-green-line"),
    ("#a16b0f", "--reader-diag-amber-line"),
    ("#b85485", "--reader-diag-rose-line"),
    ("#15847a", "--reader-diag-teal-line"),
    ("#be574e", "--reader-diag-coral-line"),
    ("#437ca5", "--reader-diag-steel-line"),
    // —— `ACCENTS_DEEP`（十六色循环的后半，pie/sankey/journey 用）——
    ("#3b477d", "--reader-diag-indigo-line"),
    ("#216a3c", "--reader-diag-green-line"),
    ("#8d5e0d", "--reader-diag-amber-line"),
    ("#7e395b", "--reader-diag-rose-line"),
    ("#10645c", "--reader-diag-teal-line"),
    ("#5a3c8b", "--reader-diag-violet-line"),
    ("#8d413a", "--reader-diag-coral-line"),
    ("#325d7c", "--reader-diag-steel-line"),
];

/// ⚠️ 59 项线性扫：一条 SVG 里色值出现几十次，可忽略。
fn find_slot(hex_lower: &str) -> Option<&'static str> {
    MERMAID_SWATCHES
        .iter()
        .find(|(k, _)| *k == hex_lower)
        .map(|(_, v)| *v)
}

// ─────────────────── 强调填充上的字色（`bugs/0073`）───────────────────

/// 强调色（`ACCENTS` / `ACCENT_INKS` / `ACCENTS_DEEP` / journey 那三色）的语义槽
/// **全部**以 `-line` 结尾；`--reader-diag-line` 是中性边色，必须排除。
///
/// ⭐ 判据是「这个槽是不是强调色」，⛔ 不是再抄一份 25 项色值表——表那边加新色，
/// 这里自动跟上（`bugs/0073` §5 方案 1）。
fn accent_slot(hex_lower: &str) -> Option<&'static str> {
    find_slot(hex_lower).filter(|v| *v != "--reader-diag-line" && v.ends_with("-line"))
}

/// 强调填充上的字色槽（三套主题各一个 ≥4.5:1 的取值）。
const ON_ACCENT: &str = "--reader-diag-on-accent";

/// 强调色**当文字色**时用的槽（`bugs/0073` 同族）：浅色/暖色主题里 `-line` 那批值
/// 是给**填充**挑的中浅色，直接当 13px 文字只有 2.6–4.4 : 1 ⇒ 另给一套更深的 `-ink`。
///
/// ⚠️ 深色主题的 `-ink` 与 `-line` **同值**（那边本来就是亮色当字）。
fn ink_slot(line_slot: &str) -> Option<&'static str> {
    Some(match line_slot {
        "--reader-diag-green-line" => "--reader-diag-green-ink",
        "--reader-diag-indigo-line" => "--reader-diag-indigo-ink",
        "--reader-diag-amber-line" => "--reader-diag-amber-ink",
        "--reader-diag-rose-line" => "--reader-diag-rose-ink",
        "--reader-diag-teal-line" => "--reader-diag-teal-ink",
        "--reader-diag-violet-line" => "--reader-diag-violet-ink",
        "--reader-diag-coral-line" => "--reader-diag-coral-ink",
        "--reader-diag-steel-line" => "--reader-diag-steel-ink",
        _ => return None,
    })
}

/// 这个色值是不是**引擎的深字**（映射到 `--reader-diag-text` 的那一族）。
///
/// ⚠️ 只认 `#rrggbb` / `#rgb`：作者写法（`rgb()` 等）走模式 B，不参与替换。
fn is_dark_ink(value: &str) -> bool {
    let Some(rest) = value.strip_prefix('#') else {
        return false;
    };
    if !(rest.len() == 3 || rest.len() == 6) || !rest.bytes().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let six = if rest.len() == 3 {
        rest.chars().flat_map(|c| [c, c]).collect::<String>()
    } else {
        rest.to_string()
    };
    find_slot(&format!("#{}", six.to_ascii_lowercase())) == Some("--reader-diag-text")
}

/// 一个**闭合面积形状**的几何（只用于「这段文字压在哪块填充上」）。
#[derive(Clone)]
enum Cover {
    Rect { x0: f64, y0: f64, x1: f64, y1: f64 },
    Ellipse { cx: f64, cy: f64, rx: f64, ry: f64 },
    /// 折线围成的区域（polygon，以及 path **采样后**的边界）。
    Poly(Vec<(f64, f64)>),
}

impl Cover {
    fn contains(&self, x: f64, y: f64) -> bool {
        match self {
            Self::Rect { x0, y0, x1, y1 } => *x0 <= x && x <= *x1 && *y0 <= y && y <= *y1,
            Self::Ellipse { cx, cy, rx, ry } => {
                if *rx <= 0.0 || *ry <= 0.0 {
                    return false;
                }
                let dx = (x - cx) / rx;
                let dy = (y - cy) / ry;
                dx * dx + dy * dy <= 1.0
            }
            Self::Poly(p) => point_in_poly(p, x, y),
        }
    }
}

/// 射线法。⚠️ 边界上的点**算命中**（文字锚点正好压在边上时宁可认成强调底）。
fn point_in_poly(p: &[(f64, f64)], x: f64, y: f64) -> bool {
    if p.len() < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = p.len() - 1;
    for i in 0..p.len() {
        let (xi, yi) = p[i];
        let (xj, yj) = p[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// 画过的填充（**按画出的顺序**），只留判断「文字压在哪块底上」要用的几何。
///
/// ⭐ 为什么不是「最近一个 fill」：`sequence` 的箭头、`pie` 的批量扇区、
/// `journey` 的图例块都会让「最近的 fill」与「文字真正的底」不一致。
///
/// ⚠️ `trust == false` ⇒ **整图退回旧映射**（深字一律 `--reader-diag-text`）：
/// 只可能"少修"，⛔ 不会因为几何算错而把本来正常的图改坏。
struct Covers {
    list: Vec<(Cover, bool)>,
    trust: bool,
}

/// 单图最多记这么多块填充。⚠️ 超了就**丢最旧的**：文字几乎总压在自己那块上。
const MAX_COVERS: usize = 4096;

impl Covers {
    fn new(trust: bool) -> Self {
        Self {
            list: Vec::new(),
            trust,
        }
    }

    fn push(&mut self, cover: Cover, accent: bool) {
        if self.list.len() >= MAX_COVERS {
            self.list.remove(0);
        }
        self.list.push((cover, accent));
    }

    /// 点 (x, y) 是否落在**一块强调填充**上：从最后画的往前找，第一个盖住它的算数。
    fn on_accent(&self, x: f64, y: f64) -> bool {
        if !self.trust {
            return false;
        }
        self.list
            .iter()
            .rev()
            .find(|(c, _)| c.contains(x, y))
            .is_some_and(|(_, accent)| *accent)
    }

    /// `<text>` 的判定点：锚点上方 4 px（≈ 字号 14 的垂直中线）。
    fn text_on_accent(&self, e: &quick_xml::events::BytesStart<'_>) -> bool {
        let (Some(x), Some(y)) = (attr_num(e, b"x"), attr_num(e, b"y")) else {
            return false;
        };
        self.on_accent(x, y - 4.0)
    }

    /// 把 `<rect|circle|ellipse|polygon|path>` 的填充记下来（`fill="none"` 跳过）。
    fn record(&mut self, local: &str, e: &quick_xml::events::BytesStart<'_>) {
        let fill = attr_text(e, b"fill");
        let accent = match fill.as_deref() {
            Some(v) if v.eq_ignore_ascii_case("none") || v.eq_ignore_ascii_case("transparent") => {
                return
            }
            Some(v) => match v.strip_prefix('#') {
                Some(rest) if !rest.is_empty() && rest.bytes().all(|c| c.is_ascii_hexdigit()) => {
                    let six = if rest.len() == 3 {
                        rest.chars().flat_map(|c| [c, c]).collect::<String>()
                    } else {
                        rest.to_string()
                    };
                    accent_slot(&format!("#{six}")).is_some()
                }
                // `url(#…)` / `rgb()` / 命名色：认不出 ⇒ 当作非强调底（只会少修）。
                _ => false,
            },
            None => false,
        };
        let cover = match local {
            "rect" => {
                let (x, y) = (attr_num(e, b"x").unwrap_or(0.0), attr_num(e, b"y").unwrap_or(0.0));
                let (w, h) = (attr_num(e, b"width"), attr_num(e, b"height"));
                match (w, h) {
                    (Some(w), Some(h)) if w > 0.0 && h > 0.0 => Some(Cover::Rect {
                        x0: x,
                        y0: y,
                        x1: x + w,
                        y1: y + h,
                    }),
                    _ => None,
                }
            }
            "circle" | "ellipse" => {
                let cx = attr_num(e, b"cx").unwrap_or(0.0);
                let cy = attr_num(e, b"cy").unwrap_or(0.0);
                let r = attr_num(e, b"r");
                let (rx, ry) = if local == "circle" {
                    (r, r)
                } else {
                    (attr_num(e, b"rx"), attr_num(e, b"ry"))
                };
                match (rx, ry) {
                    (Some(rx), Some(ry)) if rx > 0.0 && ry > 0.0 => Some(Cover::Ellipse { cx, cy, rx, ry }),
                    _ => None,
                }
            }
            "polygon" => attr_text(e, b"points")
                .as_deref()
                .and_then(poly_points)
                .map(Cover::Poly),
            "path" => attr_text(e, b"d").as_deref().and_then(path_poly).map(Cover::Poly),
            _ => None,
        };
        if let Some(cover) = cover {
            self.push(cover, accent);
        }
    }
}

/// 面积形状：只有它们会"盖住"一段文字。
fn is_area_shape(local: &str) -> bool {
    matches!(local, "rect" | "circle" | "ellipse" | "polygon" | "path")
}

/// 属性能不能解析成一个有限的 `f64`（几何用；⛔ 与 `plain_numbers` 的校验分开）。
fn parse_num(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

fn attr_text(
    e: &quick_xml::events::BytesStart<'_>,
    key: &[u8],
) -> Option<String> {
    for attr in e.attributes().flatten() {
        let name: &[u8] = attr.key.local_name().into_inner().as_ref();
        if name == key {
            // ⚠️ `normalized_value` 会解析实体；失败就当没有这个属性（只影响几何判定）。
            return attr
                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .ok()
                .map(|v| v.into_owned());
        }
    }
    None
}

fn attr_num(e: &quick_xml::events::BytesStart<'_>, key: &[u8]) -> Option<f64> {
    attr_text(e, key).as_deref().and_then(parse_num)
}

/// `points="x,y x,y …"` → 折线点。⚠️ 解析不出来就返回 `None`（这块几何不记）。
fn poly_points(v: &str) -> Option<Vec<(f64, f64)>> {
    let nums: Vec<f64> = v
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
        .map(parse_num)
        .collect::<Option<Vec<_>>>()?;
    if nums.len() < 6 || nums.len() % 2 != 0 {
        return None;
    }
    Some(nums.chunks_exact(2).map(|p| (p[0], p[1])).collect())
}

/// path 的 `d` → 采样后的边界折线（只用于命中判定）。
///
/// ⭐ 支持引擎实际会发的 `M L H V Q A Z`（pie 用 `A`，rounded 节点用 `Q`），
/// 另外补上 `C S T`；**小写命令 / 未知命令 ⇒ `None`**（不记这块几何，退回旧映射）。
fn path_poly(d: &str) -> Option<Vec<(f64, f64)>> {
    let bytes = d.as_bytes();
    let mut i = 0usize;
    let mut pts: Vec<(f64, f64)> = Vec::new();
    let (mut cx, mut cy) = (0.0f64, 0.0f64);
    let mut start = (0.0f64, 0.0f64);
    // 上一次的三次/二次控制点（`S` / `T` 要反射它）。
    let mut ctrl: Option<(f64, f64)> = None;
    let mut cmd: Option<u8> = None;

    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() || b == b',' {
            i += 1;
            continue;
        }
        if b.is_ascii_alphabetic() {
            if !b.is_ascii_uppercase() {
                return None;
            }
            cmd = Some(b);
            i += 1;
            if b == b'Z' {
                cx = start.0;
                cy = start.1;
                ctrl = None;
            }
            continue;
        }
        let cur = cmd?;
        let mut args = [0.0f64; 7];
        let need = match cur {
            b'M' | b'L' | b'T' => 2,
            b'H' | b'V' => 1,
            b'C' => 6,
            b'S' | b'Q' => 4,
            b'A' => 7,
            _ => return None,
        };
        for slot in args.iter_mut().take(need) {
            let (v, next) = scan_num(d, i)?;
            *slot = v;
            i = next;
        }
        match cur {
            b'M' => {
                cx = args[0];
                cy = args[1];
                start = (cx, cy);
                pts.push((cx, cy));
                ctrl = None;
                // SVG 语义：`M` 之后**隐式**的坐标对按 `L` 处理。
                cmd = Some(b'L');
            }
            b'L' => {
                cx = args[0];
                cy = args[1];
                pts.push((cx, cy));
                ctrl = None;
            }
            b'H' => {
                cx = args[0];
                pts.push((cx, cy));
                ctrl = None;
            }
            b'V' => {
                cy = args[0];
                pts.push((cx, cy));
                ctrl = None;
            }
            b'C' => {
                let (x1, y1, x2, y2, x, y) = (args[0], args[1], args[2], args[3], args[4], args[5]);
                for k in 1..=8 {
                    let t = k as f64 / 8.0;
                    pts.push(cubic(cx, cy, x1, y1, x2, y2, x, y, t));
                }
                cx = x;
                cy = y;
                ctrl = Some((x2, y2));
            }
            b'S' => {
                let (rx, ry) = reflect(ctrl, cx, cy);
                let (x2, y2, x, y) = (args[0], args[1], args[2], args[3]);
                for k in 1..=8 {
                    let t = k as f64 / 8.0;
                    pts.push(cubic(cx, cy, rx, ry, x2, y2, x, y, t));
                }
                cx = x;
                cy = y;
                ctrl = Some((x2, y2));
            }
            b'Q' => {
                let (x1, y1, x, y) = (args[0], args[1], args[2], args[3]);
                for k in 1..=8 {
                    let t = k as f64 / 8.0;
                    pts.push(quad(cx, cy, x1, y1, x, y, t));
                }
                cx = x;
                cy = y;
                ctrl = Some((x1, y1));
            }
            b'T' => {
                let (rx, ry) = reflect(ctrl, cx, cy);
                let (x, y) = (args[0], args[1]);
                for k in 1..=8 {
                    let t = k as f64 / 8.0;
                    pts.push(quad(cx, cy, rx, ry, x, y, t));
                }
                cx = x;
                cy = y;
                ctrl = Some((rx, ry));
            }
            b'A' => {
                let (rx, ry, rot, large, sweep, x, y) =
                    (args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
                for p in arc_points(cx, cy, rx, ry, rot, large != 0.0, sweep != 0.0, x, y) {
                    pts.push(p);
                }
                cx = x;
                cy = y;
                ctrl = None;
            }
            _ => return None,
        }
    }
    if pts.len() < 3 {
        None
    } else {
        Some(pts)
    }
}

/// 从 `i` 开始扫一个 SVG 数字，返回 (值, 新下标)。
fn scan_num(s: &str, mut i: usize) -> Option<(f64, usize)> {
    let b = s.as_bytes();
    // ⚠️ 必须自己跳过前导空白/逗号：`M 150.0 150.0` 的第二个数前面就是空格。
    while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b',') {
        i += 1;
    }
    let start = i;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let mut digits = false;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
        digits = true;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            digits = true;
        }
    }
    if !digits {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let save = i;
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let mut exp = false;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            exp = true;
        }
        if !exp {
            i = save;
        }
    }
    s.get(start..i)?.parse::<f64>().ok().map(|v| (v, i))
}

fn reflect(ctrl: Option<(f64, f64)>, cx: f64, cy: f64) -> (f64, f64) {
    match ctrl {
        Some((x, y)) => (2.0 * cx - x, 2.0 * cy - y),
        None => (cx, cy),
    }
}

fn cubic(x0: f64, y0: f64, x1: f64, y1: f64, x2: f64, y2: f64, x3: f64, y3: f64, t: f64) -> (f64, f64) {
    let u = 1.0 - t;
    let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    (
        a * x0 + b * x1 + c * x2 + d * x3,
        a * y0 + b * y1 + c * y2 + d * y3,
    )
}

fn quad(x0: f64, y0: f64, x1: f64, y1: f64, x2: f64, y2: f64, t: f64) -> (f64, f64) {
    let u = 1.0 - t;
    (
        u * u * x0 + 2.0 * u * t * x1 + t * t * x2,
        u * u * y0 + 2.0 * u * t * y1 + t * t * y2,
    )
}

/// SVG 椭圆弧 `A` → 边界采样点（端点参数 → 圆心参数，W3C 实现注记 F.6.5）。
///
/// ⚠️ **必须精确**：`pie` 的扇区就是一条 `M L A Z`，用端点外接框会把
/// 旁边扇区的标签算进来（`bugs/0073` 实测：`33%` 与 `67%` 互换底色）。
#[allow(clippy::too_many_arguments)]
fn arc_points(
    x1: f64,
    y1: f64,
    rx: f64,
    ry: f64,
    rot_deg: f64,
    large: bool,
    sweep: bool,
    x2: f64,
    y2: f64,
) -> Vec<(f64, f64)> {
    let mut rx = rx.abs();
    let mut ry = ry.abs();
    if rx == 0.0 || ry == 0.0 {
        return vec![(x2, y2)];
    }
    let phi = rot_deg.to_radians();
    let (sp, cp) = phi.sin_cos();
    let dx = (x1 - x2) / 2.0;
    let dy = (y1 - y2) / 2.0;
    let x1p = cp * dx + sp * dy;
    let y1p = -sp * dx + cp * dy;
    let lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
    if lam > 1.0 {
        let s = lam.sqrt();
        rx *= s;
        ry *= s;
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let mut co = if den > 0.0 { (num / den).max(0.0).sqrt() } else { 0.0 };
    if large == sweep {
        co = -co;
    }
    let cxp = co * rx * y1p / ry;
    let cyp = -co * ry * x1p / rx;
    let cx = cp * cxp - sp * cyp + (x1 + x2) / 2.0;
    let cy = sp * cxp + cp * cyp + (y1 + y2) / 2.0;
    let t1 = ((y1p - cyp) / ry).atan2((x1p - cxp) / rx);
    let t2 = ((-y1p - cyp) / ry).atan2((-x1p - cxp) / rx);
    let mut dt = t2 - t1;
    if sweep && dt < 0.0 {
        dt += std::f64::consts::TAU;
    }
    if !sweep && dt > 0.0 {
        dt -= std::f64::consts::TAU;
    }
    // 每段 ≤ 7.5°：对 130 px 半径 ≈ 8.5 px 弦长，命中判定的误差远小于一个字。
    let steps = ((dt.abs() / (std::f64::consts::PI / 24.0)).ceil() as usize).clamp(1, 96);
    let mut out = Vec::with_capacity(steps + 1);
    for k in 0..=steps {
        let t = t1 + dt * (k as f64 / steps as f64);
        let (st, ct) = t.sin_cos();
        out.push((
            cx + rx * ct * cp - ry * st * sp,
            cy + rx * ct * sp + ry * st * cp,
        ));
    }
    out
}

/// ⚠️ 只有测试（`has_hex_color`）用，⛔ 别当生产代码的依赖。
#[cfg(test)]
fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}


// ─────────────────────────── ③ 结构化清洗（§2.1⑦）───────────────────────────

/// 实测产物并集（12 类语料）＋ 设计列的三种。⛔ 白名单之外**一律回退**。
const ELEMENTS: &[&str] = &[
    "svg",
    "g",
    "defs",
    "title",
    "desc",
    "marker",
    "mask",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "linearGradient",
    "stop",
];

/// 出现在产物里就说明**引擎行为变了** ⇒ 整块回退，⛔ 不是静默删子树。
///
/// ⚠️ **两个例外**（都只丢"表现层"，保留图本身）：
/// - `<a>`：**解包**（丢标签、留子节点）——`click` 的导航消失，文字还在；
/// - `<style>`：**连内容一起丢**——它只服务**边动画**（`@keyframes`），
///   静态图不缺任何东西。⚠️ 它**绝不能透传**：文档作者写的 CSS 会作用到整个 WebView。
const DANGEROUS: &[&str] = &[
    "script",
    "foreignObject",
    "image",
    "use",
    "style",
    "iframe",
    "animate",
    "set",
    "handler",
    "audio",
    "video",
    "a",
];

/// 清洗时的一层栈帧。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Frame {
    /// 正常元素：闭合时补 `</name>`。
    Keep,
    /// `<a>`：丢标签，**保留**子节点（文字在）。
    UnwrapA,
    /// `<style>`：标签与**内容一起丢**（CSS 不进 WebView）。
    SkipStyle,
}

/// XML 语义的清洗：解析 → 白名单 → **自己重新转义序列化**。
///
/// ⭐ 为什么不是字符串替换（评审 P1-3）：`URL(` / `\75 rl(` / `url( "#x" )`
/// 各是一条绕过路径，而 XML 解析器只认一种语法。
///
/// ⚠️ `<a>` 是**解包**（丢标签、保留子节点）而不是回退：`click` 的导航就此消失，
/// 但节点上的文字还在——这是"图上的一条链接"与"图本身"的取舍。
/// 其余危险元素 ⇒ 回退。
///
/// `seq` 是**文档内的图序号**：每个 id 加 `m{seq}-` 前缀，`url(#x)` 同时改写，
/// 多张图的标记与渐变因此不会串（实测每个流程图都发 `id="arrow"`）。
fn sanitize_svg(svg: &str, seq: usize, subst: bool) -> Result<String, String> {
    let mut why = String::new();
    match sanitize_inner(svg, seq, subst, &mut why) {
        Ok(s) => Ok(s),
        Err(()) => Err(if why.is_empty() {
            "未知原因".to_string()
        } else {
            why
        }),
    }
}

/// ⭐ `why` 是**诊断用**的：产物只回一句「安全拒绝」，而单测与将来的升版对齐
/// 需要知道**是哪一条**把它挡下的。⛔ 它不进 DOM、⛔ 不给用户看。
fn sanitize_inner(
    svg: &str,
    seq: usize,
    subst: bool,
    why: &mut String,
) -> Result<String, ()> {
    let mut reader = Reader::from_str(svg);
    reader.config_mut().trim_text(false);
    let mut out = String::with_capacity(svg.len() + svg.len() / 8);
    let mut stack: Vec<Frame> = Vec::new();
    let mut seen_root = false;
    // ⭐ `<mask>` 子树里⛔ 不做主题色替换（评审 P0-3）：遮罩按**亮度**挖洞，
    //   颜色跟着主题走会让交叉处的洞消失（浅色主题）或反转（深色主题）。
    let mut mask_depth = 0usize;

    // ⭐ `bugs/0073`：强调填充上的深字要换成 `--reader-diag-on-accent`。
    //   ⇒ 边写边记"画过哪些填充"，文字开标签时拿它的锚点去问。
    //   ⚠️ 有一处 `transform=` 就**整图不判定**：几何坐标系不可比时只可能"少修"，
    //   绝不能把本来正常的图改坏（`flowmaid 0.33.0` 实测一个 `transform` 都不发）。
    let mut covers = Covers::new(!svg.contains("transform="));
    // ⚠️ `<defs>` 里是**模板**（marker / gradient），既不是画出来的填充，
    //   也不该拿模板坐标去判文字 ⇒ 子树里两头都不做。
    let mut defs_depth = 0usize;

    // ⭐ 处在被丢弃的子树里（`<style>`）：⛔ 不"先写再删"，直接不写。
    fn skipping(stack: &[Frame]) -> bool {
        stack.contains(&Frame::SkipStyle)
    }

    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                let local = e.local_name().into_inner();
                if skipping(&stack) {
                    // 丢弃中的子树：不校验、不输出，只把层数记住。
                    stack.push(Frame::SkipStyle);
                    continue;
                }
                if is_dangerous(local) {
                    if local == "a" {
                        stack.push(Frame::UnwrapA);
                        continue;
                    }
                    if local == "style" {
                        stack.push(Frame::SkipStyle);
                        continue;
                    }
                    *why = format!("危险元素 <{local}>");
                    return Err(());
                }
                if !seen_root {
                    if local != "svg" {
                        *why = format!("根元素不是 svg：<{local}>");
                        return Err(());
                    }
                    seen_root = true;
                }
                let track = subst && mask_depth == 0 && defs_depth == 0;
                let in_text = local == "text";
                let on_accent = track && in_text && covers.text_on_accent(&e);
                write_start(
                    &mut out,
                    local,
                    &e,
                    seq,
                    false,
                    subst && mask_depth == 0,
                    in_text,
                    on_accent,
                    why,
                )?;
                if local == "mask" {
                    mask_depth += 1;
                }
                if local == "defs" {
                    defs_depth += 1;
                }
                if track && is_area_shape(local) {
                    covers.record(local, &e);
                }
                stack.push(Frame::Keep);
            }
            Ok(Event::Empty(e)) => {
                let local = e.local_name().into_inner();
                if skipping(&stack) {
                    continue;
                }
                if is_dangerous(local) {
                    // 自闭合的 `<a/>` / `<style/>` 没有内容可留，直接丢；
                    // 其余照旧回退（fail-closed）。
                    if local == "a" || local == "style" {
                        continue;
                    }
                    *why = format!("危险元素 <{local}/>");
                    return Err(());
                }
                if !seen_root {
                    if local != "svg" {
                        *why = format!("根元素不是 svg：<{local}/>");
                        return Err(());
                    }
                    seen_root = true;
                }
                // ⚠️ 遮罩里最常见的就是**自闭合** `<rect/>`：这一支也要看 `mask_depth`。
                let track = subst && mask_depth == 0 && defs_depth == 0;
                let in_text = local == "text";
                let on_accent = track && in_text && covers.text_on_accent(&e);
                write_start(
                    &mut out,
                    local,
                    &e,
                    seq,
                    true,
                    subst && mask_depth == 0,
                    in_text,
                    on_accent,
                    why,
                )?;
                if track && is_area_shape(local) {
                    covers.record(local, &e);
                }
            }
            Ok(Event::End(e)) => {
                let local = e.local_name().into_inner();
                if skipping(&stack) {
                    stack.pop();
                    continue;
                }
                if local == "a" && stack.last() == Some(&Frame::UnwrapA) {
                    stack.pop();
                    continue;
                }
                if is_dangerous(local) {
                    *why = format!("危险元素 </{local}>");
                    return Err(());
                }
                if stack.last() != Some(&Frame::Keep) {
                    *why = format!("标签不配对 </{local}>");
                    return Err(());
                }
                stack.pop();
                if local == "mask" && mask_depth > 0 {
                    mask_depth -= 1;
                }
                if local == "defs" && defs_depth > 0 {
                    defs_depth -= 1;
                }
                out.push_str("</");
                out.push_str(local);
                out.push('>');
            }
            Ok(Event::Text(e)) => {
                if skipping(&stack) {
                    continue;
                }
                escape_html_into(&mut out, &e.into_inner()).map_err(|_| ())?;
            }
            Ok(Event::GeneralRef(e)) => {
                if skipping(&stack) {
                    continue;
                }
                let ch = match e.resolve_char_ref() {
                    Ok(Some(c)) => c,
                    Ok(None) => match e.into_inner().as_ref() {
                        "amp" => '&',
                        "lt" => '<',
                        "gt" => '>',
                        "quot" => '"',
                        "apos" => '\'',
                        other => {
                            *why = format!("未知实体 &{other};");
                            return Err(());
                        }
                    },
                    Err(e) => {
                        *why = format!("字符引用非法：{e}");
                        return Err(());
                    }
                };
                let mut buf = [0u8; 4];
                escape_html_into(&mut out, ch.encode_utf8(&mut buf)).map_err(|_| ())?;
            }
            Ok(Event::CData(e)) => {
                if skipping(&stack) {
                    continue;
                }
                *why = format!("CDATA（{} 字节）", e.into_inner().len());
                return Err(());
            }
            Ok(Event::Comment(_)) => {}
            Ok(Event::Decl(_)) | Ok(Event::PI(_)) | Ok(Event::DocType(_)) => {
                *why = "XML 声明 / 处理指令 / DOCTYPE".into();
                return Err(());
            }
            Err(e) => {
                *why = format!("XML 解析失败：{e}");
                return Err(());
            }
        }
    }
    if !seen_root {
        *why = "没有根元素".into();
        return Err(());
    }
    if !stack.is_empty() {
        *why = format!("有 {} 个标签没闭合", stack.len());
        return Err(());
    }
    Ok(out)
}

fn is_dangerous(local: &str) -> bool {
    DANGEROUS.contains(&local)
}

fn write_start(
    out: &mut String,
    local: &str,
    e: &quick_xml::events::BytesStart<'_>,
    seq: usize,
    empty_tag: bool,
    subst: bool,
    in_text: bool,
    on_accent: bool,
    why: &mut String,
) -> Result<(), ()> {
    if !ELEMENTS.contains(&local) {
        *why = format!("白名单外的元素 <{local}>");
        return Err(());
    }
    out.push('<');
    out.push_str(local);
    for attr in e.attributes() {
        let attr = attr.map_err(|_| ())?;
        let name = attr.key.local_name().into_inner();
        let value = attr
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .map_err(|_| ())?;
        let (name, value) = match map_attr(name, &value, seq, subst, in_text, on_accent) {
            Ok(v) => v,
            Err(()) => {
                *why = format!("属性 {name}=\"{value}\"");
                return Err(());
            }
        };
        out.push(' ');
        out.push_str(&name);
        out.push_str("=\"");
        escape_html_into(out, &value).map_err(|_| ())?;
        out.push('"');
    }
    out.push_str(if empty_tag { "/>" } else { ">" });
    Ok(())
}

/// 单个属性的裁决。`Err` = **整块回退**（fail-closed）。
fn map_attr(
    name: &str,
    value: &str,
    seq: usize,
    subst: bool,
    in_text: bool,
    on_accent: bool,
) -> Result<(String, String), ()> {
    // ⛔ 出现即回退：事件属性、导航、行内样式。
    // ⚠️ `class` **不在此列**：0.33 会给**边动画**发 `class="edge-animation-*"`，
    //    轻量图的节点也能带作者写的 `:::类名`；它由 `class_value()` 逐 token 验。
    if name.starts_with("on")
        || matches!(name, "href" | "style" | "target" | "rel" | "srcdoc")
        || name.is_empty()
    {
        return Err(());
    }
    match name {
        "id" => {
            if !ident_ok(value) {
                return Err(());
            }
            return Ok((name.into(), format!("m{seq}-{value}")));
        }
        "xmlns" => {
            if value != "http://www.w3.org/2000/svg" {
                return Err(());
            }
        }
        "viewBox" => {
            if !numbers(value, 4) {
                return Err(());
            }
        }
        "d" => {
            if !path_data(value) {
                return Err(());
            }
        }
        "points" => {
            if !plain_numbers(value) {
                return Err(());
            }
        }
        "transform" => {
            if !transform(value) {
                return Err(());
            }
        }
        "font-family" => {
            if !text_token(value) {
                return Err(());
            }
        }
        // 标题/无障碍描述是**用户内容**（`accTitle`），重新转义之后是纯文本。
        "aria-label" | "title" => {}
        // ⭐ 0.33 的无障碍配套：`accDescr` ⇒ 根 `<svg>` 上的 `aria-describedby`。
        //    它指向一个 **id** ⇒ 跟着 `id` 一起加文档前缀，否则多图/多文档下会指错。
        "aria-describedby" => {
            let mut parts = Vec::new();
            for idref in value.split_whitespace() {
                if !ident_ok(idref) {
                    return Err(());
                }
                parts.push(format!("m{seq}-{idref}"));
            }
            if parts.is_empty() {
                return Err(());
            }
            return Ok((name.into(), parts.join(" ")));
        }
        // ⭐ 边动画/轻量图的类名。⚠️ 只认**安全字符集**的 token——它是作者内容，
        //    但不是任意 CSS 类选择器（`class="a.b"` / 空格外的怪字符一律回退）。
        "class" => {
            if !class_value(value) {
                return Err(());
            }
        }
        // ⭐ 边的用户 id（`data-id`）与动画的无障碍标记：都是**惰性属性**（无脚本、无导航）。
        //    `data-id` 是作者写的内容，允许任意 UTF-8，但**不许控制字符**、不许过长。
        "data-id" => {
            if value.is_empty()
                || value.len() > 200
                || value.chars().any(|c| c.is_control())
            {
                return Err(());
            }
        }
        "aria-hidden" => {
            if !matches!(value, "true" | "false") {
                return Err(());
            }
        }
        // 斜体（`<i>` 标签、ER 行注释）。⚠️ `font-weight` 早就放行了，这条是它的同族。
        "font-style" => {
            if !matches!(value, "normal" | "italic" | "oblique") {
                return Err(());
            }
        }
        // ⭐ 边交叉处的"挖洞"遮罩（`casing.rs`）：**普通流程图只要边交叉就会发**。
        "mask" => {
            return Ok((name.into(), url_ref(value, seq)?));
        }
        "maskUnits" => {
            if !matches!(value, "userSpaceOnUse" | "objectBoundingBox") {
                return Err(());
            }
        }
        "role" => {
            if !matches!(
                value,
                "img" | "presentation" | "graphics-document" | "group" | "graphics-symbol"
            ) {
                return Err(());
            }
        }
        "text-anchor" => {
            if !matches!(value, "start" | "middle" | "end") {
                return Err(());
            }
        }
        "dominant-baseline" => {
            if !matches!(
                value,
                "auto"
                    | "middle"
                    | "central"
                    | "hanging"
                    | "alphabetic"
                    | "ideographic"
                    | "text-before-edge"
                    | "text-after-edge"
            ) {
                return Err(());
            }
        }
        "gradientUnits" => {
            if !matches!(value, "userSpaceOnUse" | "objectBoundingBox") {
                return Err(());
            }
        }
        "markerUnits" => {
            if !matches!(value, "strokeWidth" | "userSpaceOnUse") {
                return Err(());
            }
        }
        "orient" => {
            if !(value == "auto" || value == "auto-start-reverse" || numbers(value, 1)) {
                return Err(());
            }
        }
        "paint-order" => {
            if !value
                .split_whitespace()
                .all(|t| matches!(t, "normal" | "stroke" | "fill" | "markers"))
            {
                return Err(());
            }
        }
        "stroke-linecap" => {
            if !matches!(value, "butt" | "round" | "square") {
                return Err(());
            }
        }
        "stroke-linejoin" => {
            if !matches!(value, "miter" | "round" | "bevel" | "miter-clip" | "arcs") {
                return Err(());
            }
        }
        "font-weight" => {
            if !(matches!(value, "normal" | "bold" | "bolder" | "lighter")
                || numbers(value, 1))
            {
                return Err(());
            }
        }
        "marker-end" | "marker-start" => {
            return Ok((name.into(), url_ref(value, seq)?));
        }
        "fill" | "stroke" | "stop-color" => {
            // ⭐ `bugs/0073`：**深字压在强调填充上**时换 `--reader-diag-on-accent`。
            //   只动 `fill`，且只在 `<text>` 上（`on_accent` 只会对 text 为真）。
            if name == "fill" && on_accent && is_dark_ink(value) {
                return Ok((name.into(), format!("var({ON_ACCENT})")));
            }
            // ⭐ 同族：**强调色当文字色**。`-line` 是给填充挑的中浅色，当 13px 字
            //   只有 2.6–4.4 : 1 ⇒ 文字走 `-ink`（深色主题两者同值）。
            if name == "fill" && in_text {
                if let Some(slot) = painted_slot(value, seq, subst) {
                    if slot == "--reader-diag-line" {
                        // ER 的 `PK` / `FK`：引擎拿**边色**当键列标注（`#44507a`）。
                        //   当线用没问题，当字在暖色主题下只有 3.99 : 1 ⇒ 走软墨色。
                        return Ok((name.into(), "var(--reader-diag-ink-soft)".into()));
                    }
                    if let Some(ink) = ink_slot(slot) {
                        return Ok((name.into(), format!("var({ink})")));
                    }
                }
            }
            return Ok((name.into(), paint(value, seq, subst)?));
        }
        "stroke-dasharray" => {
            if !(value == "none" || plain_numbers(value)) {
                return Err(());
            }
        }
        "x" | "y" | "x1" | "y1" | "x2" | "y2" | "cx" | "cy" | "r" | "rx" | "ry" | "width"
        | "height" | "dx" | "dy" | "font-size" | "fill-opacity" | "opacity" | "stroke-width"
        | "stroke-dashoffset" | "offset" | "markerWidth" | "markerHeight" | "refX" | "refY" => {
            if !plain_numbers(value) {
                return Err(());
            }
        }
        // ⛔ 白名单之外 ⇒ 回退（⛔ 不是"原样透传"）。
        _ => return Err(()),
    }
    Ok((name.into(), value.into()))
}

/// `class` 的值：空格分隔的 token，每个 1..=64 字节，只许 `[A-Za-z0-9_-]`，总量 ≤256。
///
/// ⚠️ 它是**作者内容**（`:::my-class` 与边动画类名），但⛔ 不是 CSS 选择器——
/// 只认最窄的字符集，`.a`、`a[href]`、`a>b` 这类一律回退。
fn class_value(v: &str) -> bool {
    if v.is_empty() || v.len() > 256 {
        return false;
    }
    let mut any = false;
    for tok in v.split_whitespace() {
        if tok.is_empty() || tok.len() > 64 {
            return false;
        }
        if !tok
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return false;
        }
        any = true;
    }
    any
}

/// 这个色值在**模式 A** 下会落到哪个槽（`None` = 不替换 / 模式 B / 认不出的值）。
///
/// ⚠️ 只给"文字要换槽"那两条判据用；`paint()` 仍是唯一的**写值**出口。
fn painted_slot(value: &str, _seq: usize, subst: bool) -> Option<&'static str> {
    if !subst {
        return None;
    }
    let rest = value.strip_prefix('#')?;
    if !(rest.len() == 3 || rest.len() == 6) || !rest.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let six = if rest.len() == 3 {
        rest.chars().flat_map(|c| [c, c]).collect::<String>()
    } else {
        rest.to_string()
    };
    find_slot(&format!("#{}", six.to_ascii_lowercase()))
}

/// `#rgb` / `#rrggbb` / `none` / `currentColor` / `transparent` / `url(#id)`，
/// 以及**作者写法**的命名色与 `rgb()/rgba()/hsl()/hsla()`（评审 P0-4）。
///
/// ⭐ **模式 A 的替换就发生在这里**（评审 P1-1）：只有 `fill`/`stroke`/`stop-color`
/// 这三个**颜色属性**进这条路径，⇒ 图里的文字与 `aria-label` 永远不会被改写
/// （旧做法是出图后对整条 SVG 扫 `#rrggbb`，作者写的 `#ff0000` 也会被吃掉）。
///
/// `subst = false` 有两种情形：① 模式 B（作者自带样式，颜色归作者）；
/// ② `<mask>` 子树——遮罩靠**亮度**决定挖洞，跟着主题变会让交叉处的洞消失或反转。
fn paint(value: &str, seq: usize, subst: bool) -> Result<String, ()> {
    if let Some(rest) = value.strip_prefix('#') {
        if (rest.len() == 3 || rest.len() == 6) && rest.bytes().all(|c| c.is_ascii_hexdigit()) {
            if !subst {
                return Ok(value.to_string());
            }
            let six = if rest.len() == 3 {
                rest.chars().flat_map(|c| [c, c]).collect::<String>()
            } else {
                rest.to_string()
            };
            return Ok(match find_slot(&format!("#{}", six.to_ascii_lowercase())) {
                Some(var) => format!("var({var})"),
                // 引擎升版新增的色值：留着字面色（宁可这一块不跟主题，⛔ 也不要整图消失）。
                None => value.to_string(),
            });
        }
        return Err(());
    }
    // ⭐ **我们自己写的**那一族（`design/0060` §2.1⑦ 值形态⑤）。⚠️ 只认这一个前缀，
    //   ⛔ 不放行任意 `var(...)`——那等于把主题变量的调用面整个交出去。
    if let Some(name) = value
        .strip_prefix("var(--reader-diag-")
        .and_then(|r| r.strip_suffix(')'))
    {
        if !name.is_empty()
            && name.len() <= 64
            && name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Ok(value.to_string());
        }
        return Err(());
    }
    match value {
        "none" | "currentColor" | "transparent" => Ok(value.to_string()),
        _ => {
            if named_color(value) || func_color(value) {
                return Ok(value.to_string());
            }
            url_ref(value, seq)
        }
    }
}

/// CSS 命名色。⚠️ 只收**颜色关键字**，⛔ 不收 `url()` 里可能出现的函数名。
const NAMED_COLORS: &str = "aliceblue antiquewhite aqua aquamarine azure beige bisque black \
blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral \
cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen \
darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon \
darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink \
deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro \
ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory \
khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan \
lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen \
lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen \
magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen \
mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream \
mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid \
palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum \
powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown \
seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen \
steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen";

fn named_color(v: &str) -> bool {
    NAMED_COLORS
        .split_whitespace()
        .any(|n| n.eq_ignore_ascii_case(v.trim()))
}

/// `rgb()/rgba()/hsl()/hsla()` 的**受限文法**：只许数字、百分号、逗号、空白、斜杠、
/// `deg/rad/grad/turn` 与小数点。⛔ 不许引号、分号、嵌套括号、任意标识符
/// ——`url(...)` 里能塞的东西这里一个都塞不进来。
fn func_color(v: &str) -> bool {
    let t = v.trim();
    let lower = t.to_ascii_lowercase();
    let inner = ["rgba(", "rgb(", "hsla(", "hsl("]
        .iter()
        .find_map(|p| lower.strip_prefix(p).map(|r| (p, r)));
    let Some((_, rest)) = inner else {
        return false;
    };
    let Some(body) = rest.strip_suffix(')') else {
        return false;
    };
    if body.is_empty() || body.len() > 96 || body.contains('(') || body.contains(')') {
        return false;
    }
    let mut any = false;
    let mut token = String::new();
    for c in body.chars() {
        if c.is_ascii_digit() || c == '.' || c == '%' {
            token.push(c);
            any = true;
        } else if c.is_ascii_alphabetic() {
            token.push(c);
        } else if matches!(c, ',' | '/' | ' ' | '\t' | '\n') {
            if !token.is_empty() && !unit_token(&token) {
                return false;
            }
            token.clear();
        } else {
            return false;
        }
    }
    if !token.is_empty() && !unit_token(&token) {
        return false;
    }
    any
}

/// 一个 `rgb()` 实参：数字 ＋ 可选 `%` 或角度单位。
fn unit_token(t: &str) -> bool {
    for u in ["deg", "rad", "grad", "turn"] {
        if let Some(rest) = t.strip_suffix(u) {
            return rest.parse::<f64>().is_ok();
        }
    }
    let rest = t.strip_suffix('%').unwrap_or(t);
    !rest.is_empty() && rest.parse::<f64>().is_ok()
}

/// 只认**严格形态** `url(#id)`。⚠️ `URL(` / `url( "#id" )` / 反斜杠转义全部落进回退
/// ——fail-closed，⛔ 不靠"大小写/空白/转义各写一条正则"。
fn url_ref(value: &str, seq: usize) -> Result<String, ()> {
    let inner = value
        .strip_prefix("url(#")
        .and_then(|r| r.strip_suffix(')'))
        .ok_or(())?;
    if !ident_ok(inner) {
        return Err(());
    }
    Ok(format!("url(#m{seq}-{inner})"))
}

fn ident_ok(v: &str) -> bool {
    !v.is_empty() && v.len() <= 128 && v.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

/// 纯数字/小数/指数，允许逗号与空白分隔，允许 CSS 长度单位后缀。
///
/// ⚠️ **单位必须认**：引擎实测产出 `dy="0.33em"`——只认 `px` 会让**每一张有文字的图**
/// 都掉进安全回退（2026-11-03 实测踩到）。
fn plain_numbers(v: &str) -> bool {
    if v.trim().is_empty() {
        return false;
    }
    let mut any = false;
    for tok in v.split(|c: char| c.is_whitespace() || c == ',') {
        let t = tok.trim();
        if t.is_empty() {
            continue;
        }
        let t = strip_unit(t);
        if t.parse::<f64>().is_err() {
            return false;
        }
        any = true;
    }
    any
}

/// CSS 长度单位。⛔ 顺序无关，但必须**长的在前**（`rem` 不能被 `em` 吃掉）。
const UNITS: &[&str] = &["rem", "px", "em", "ex", "ch", "pt", "pc", "in", "cm", "mm", "%"];

fn strip_unit(t: &str) -> &str {
    for u in UNITS {
        if let Some(rest) = t.strip_suffix(u) {
            // 只有"数 ＋ 单位"才算，⛔ 别把 `none` 尾部的 `ne` 当单位。
            if rest.parse::<f64>().is_ok() {
                return rest;
            }
        }
    }
    t
}

fn numbers(v: &str, exactly: usize) -> bool {
    let n = v
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|t| !t.is_empty())
        .count();
    n == exactly && plain_numbers(v)
}

/// `d` 的字符集：命令字母、数字、分隔符。⛔ 不含 `(` `)` `:` `<` `&`。
fn path_data(v: &str) -> bool {
    !v.is_empty()
        && v.chars().all(|c| {
            matches!(
                c,
                'M' | 'm'
                    | 'L' | 'l'
                    | 'H' | 'h'
                    | 'V' | 'v'
                    | 'C' | 'c'
                    | 'S' | 's'
                    | 'Q' | 'q'
                    | 'T' | 't'
                    | 'A' | 'a'
                    | 'Z' | 'z'
            ) || c.is_ascii_digit()
                || matches!(c, '.' | ',' | '-' | '+' | 'e' | 'E' | ' ' | '\t' | '\n' | '\r')
        })
}

/// `transform="translate(1 2) rotate(3)"` —— 只认"函数名(安全字符)"。
fn transform(v: &str) -> bool {
    let mut rest = v.trim();
    if rest.is_empty() {
        return false;
    }
    while !rest.is_empty() {
        let Some(open) = rest.find('(') else {
            return false;
        };
        let name = &rest[..open];
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphabetic()) {
            return false;
        }
        let Some(close) = rest.find(')') else {
            return false;
        };
        let args = &rest[open + 1..close];
        if !args.chars().all(|c| {
            c.is_ascii_digit() || matches!(c, '.' | ',' | '-' | '+' | 'e' | 'E' | ' ' | '\t')
        }) {
            return false;
        }
        rest = rest[close + 1..].trim_start();
        if let Some(r) = rest.strip_prefix(',') {
            rest = r.trim_start();
        }
    }
    true
}

/// 字体族：字母、数字、空格、逗号、连字符、下划线、单引号。
fn text_token(v: &str) -> bool {
    !v.is_empty()
        && v.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | ',' | '-' | '_' | '\'' | '.'))
}

// ─────────────────────────── 渲染入口 ───────────────────────────

// 布局/出图调用的计数器。⭐ 它的存在只为一条判据：
// **超预算时布局调用次数必须为 0**（`design/0060` §7.1）——
// ⛔ 那只测耗时证明不了"没进布局"。
#[cfg(test)]
thread_local! {
    // ⚠️ **必须 thread_local**：libtest 一个测试一个线程，全局计数器会串
    // （2026-11-03 实测：`调用次数 = 0` 那条被隔壁测试的渲染污染成 3）。
    static RENDER_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    // ⭐ 解析次数**单独计**（§7.1 原文是「解析调用次数 = 0」）。
    //    ⚠️ 只计布局不够：预扫描闸门被停用时，模型闸门仍会拒绝、布局仍是 0，
    //    于是 `calls() == 0` 照样绿——变异自证（2026-11-03）正是这样漏掉它的。
    static PARSE_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// 解析的唯一出口。⭐ 抽这一层只为计数：预扫描拒绝之后**一次都不许解析**
/// 才是 §7.1 的判据本身（渲染次数为 0 只是它的一个后果）。
fn parse_model(src: &str) -> Result<Document, flowmaid::parser::ParseError> {
    #[cfg(test)]
    PARSE_CALLS.with(|c| c.set(c.get() + 1));
    flowmaid::parser::parse_document(src)
}

fn render_document(doc: &Document) -> String {
    #[cfg(test)]
    RENDER_CALLS.with(|c| c.set(c.get() + 1));
    let opts = SvgOptions::default();
    match doc {
        Document::Flowchart(g) | Document::State(g) => {
            flowmaid::render::render_with(g, &opts)
        }
        Document::Er(d) => flowmaid::render::render_er_with(d, &opts),
        Document::Class(d) => flowmaid::render::render_class_with(d, &opts),
        Document::Sequence(d) => flowmaid::render::render_seq_with(d, &opts),
        Document::Pie(d) => flowmaid::render::render_pie_with(d, &opts),
        Document::Mindmap(d) => flowmaid::render::render_mindmap_with(d, &opts),
        Document::Journey(d) => flowmaid::render::render_journey_with(d, &opts),
        Document::GitGraph(d) => flowmaid::render::render_gitgraph_with(d, &opts),
        Document::Architecture(d) => flowmaid::render::render_architecture_with(d, &opts),
        Document::Timeline(d) => flowmaid::render::render_timeline_with(d, &opts),
        Document::Sankey(d) => flowmaid::render::render_sankey_with(d, &opts),
    }
}

/// 一次渲染的结果：要么一张图（＋它占用的真实规模），要么一条原因。
#[derive(Debug)]
enum Outcome {
    Svg { svg: String, counts: Counts },
    Fallback(Reject),
    /// 单图合规、但**全文累计**放不下 ⇒ 触顶并**粘滞**（`INV-MERMAID-04`）。
    /// ⚠️ 它与 `Fallback(Reject::TooLarge)` 必须分开：后者是"**这一块**太大"，
    /// 归因写错会让用户以为缩一缩还能画，而实际是整篇额度用完了。
    BudgetExhausted,
}

/// 单图结构闸门（§6.1 的「单图」那一列）。
fn within_single(c: &Counts) -> bool {
    c.nodes <= MAX_NODES
        && c.relations <= MAX_RELATIONS
        && c.clusters <= MAX_CLUSTERS
        && c.depth <= MAX_DEPTH
}

/// 全文累计闸门（同一张表的「全文累计」那一列）。
fn within_doc(c: &Counts, doc: &RenderStats) -> bool {
    doc.mermaid_nodes + c.nodes <= MAX_DOC_NODES
        && doc.mermaid_relations + c.relations <= MAX_DOC_RELATIONS
}

/// 两道结构闸门的合取。⭐ 抽成函数**只为了让判据能被直接测**：
/// 每种图种的「512/513」边界不必造 513 行语料，也能钉住（§7.1）。
#[cfg(test)]
fn within_limits(c: &Counts, doc: &RenderStats) -> bool {
    within_single(c) && within_doc(c, doc)
}

/// 走完四道闸门，拿到一张干净的 SVG（或一条回退原因）。
///
/// ⚠️ `doc` 是**只读**的全文已用量：全文累计的节点/关系闸门必须在这里判，
/// ⛔ 不能等 `build` 返回之后——那时布局已经跑完了，闸门就成了"事后抱怨"。
fn build(src: &str, seq: usize, doc: &RenderStats) -> Outcome {
    if src.len() > MAX_SOURCE {
        return Outcome::Fallback(Reject::TooLarge);
    }
    let kind = match classify(src) {
        Ok(k) => k,
        Err(r) => return Outcome::Fallback(r),
    };

    // ① 解析前：线性预扫描。⭐ 它挡的是**解析期**的乘法放大。
    let flowchart = matches!(kind, "flowchart" | "graph");
    let est = prescan(src, flowchart);
    if est.tokens > MAX_PRESCAN_TOKENS || est.edges > MAX_PRESCAN_EDGES {
        return Outcome::Fallback(Reject::TooLarge);
    }

    // ② 解析**一次**。产物既用来计数，也直接交给 layout。
    //
    // ⭐ `bugs/0074`：具名实体必须在**入引擎前**单趟解码（引擎 0.33.0 只解数字实体）。
    //   ⚠️ 解码后解析不了时**退回原文再解析一次**——最坏也只是维持今天的"逐字显示"，
    //   ⛔ 不能让这一层把原本能画的图变成回退。
    let decoded = decode_entities(src);
    let parsed = match &decoded {
        Some(d) => parse_model(d).or_else(|_| parse_model(src)),
        None => parse_model(src),
    };
    let doc_model = match parsed {
        Ok(d) => d,
        Err(e) => {
            // ⭐ `bugs/0076`：引擎的 `Err` 落在**已知不支持的标准构造**上时改归因；
            //   其余仍是「语法错误」（⛔ 不吞真错）。
            let line = src.lines().nth(e.line.saturating_sub(1)).unwrap_or("");
            return Outcome::Fallback(match known_construct(kind, line) {
                Some(c) => Reject::UnsupportedSyntax(c),
                None => Reject::Syntax(e.line, e.message),
            });
        }
    };

    // ③ 解析后、布局前：真实模型计数（单图 ＋ 全文累计）。
    let c = counts(&doc_model);
    if c.is_empty() {
        return Outcome::Fallback(Reject::Empty);
    }
    if !within_single(&c) {
        return Outcome::Fallback(Reject::TooLarge);
    }
    if !within_doc(&c, doc) {
        // ⭐ 全文累计放不下 ⇒ 交给 `write_block` 置粘滞位并记成累计触顶。
        //    ⚠️ 判在这里而不是 `build` 之后，是为了**不跑布局**（同 ①②③ 的理由）。
        return Outcome::BudgetExhausted;
    }

    // ④ 出图（同一个 `Document`，⛔ 不重新解析）。
    let svg = render_document(&doc_model);
    if svg.len() > MAX_SVG {
        return Outcome::Fallback(Reject::TooLarge);
    }

    // ⑤ 结构化清洗（含 ID 前缀）＋ ⑥ 颜色两态，**同一趟**完成（评审 P1-1）。
    // ⚠️ 替换只发生在 `fill`/`stroke`/`stop-color` 这三个属性值上：作者写的
    //    `#ff0000` 若出现在**文字**里（图例、`aria-label`）就逐字保留。
    // ⚠️ 那句 `why` **不进 DOM**：产物只回一句「安全拒绝」（`INV-MERMAID-07`）。
    //    它留给单测与升版对齐——"是哪一条挡下的"必须能问得出来。
    let subst = !has_author_style(&doc_model);
    let clean = match sanitize_svg(&svg, seq, subst) {
        Ok(s) => s,
        Err(why) => {
            debug_assert!(!why.is_empty());
            return Outcome::Fallback(Reject::Security);
        }
    };
    Outcome::Svg { svg: clean, counts: c }
}

/// ` ```mermaid ` 的整块出口。⚠️ **这一支拥有整块**（返回 `Skip`），
/// 所以首尾换行也归它（与 `render::write_gated_code_block` 同一条纪律）。
pub fn write_block(
    context: &mut Context<RenderStats>,
    ncb: &NodeCodeBlock,
) -> Result<ChildRendering, fmt::Error> {
    let src = &ncb.literal;
    let stats = &mut context.user;

    // ⓐ 粘滞位（`INV-MERMAID-04`）：全文累计已触顶 ⇒ 本块及后续每一块都回退。
    //    ⚠️ 它排在所有其它判据**之前**是刻意的：触顶之后那块"恰好自己也超限"的图，
    //    归因是**累计**而不是它自己大——而"累计触顶"正是要求可观测的那一个。
    if stats.mermaid_exhausted {
        return fallback(context, src, Reject::DocBudget, true);
    }
    // ⭐ 单块自己的上限**先判**（评审 P1-3）：这一块本身就超了，归因是**它自己**，
    //    ⛔ 不是"全文额度用完"——后者会让它粘滞，后面那些本来画得出来的图全被连坐。
    if src.len() > MAX_SOURCE {
        return fallback(context, src, Reject::TooLarge, false);
    }
    stats.mermaid_blocks += 1;
    if stats.mermaid_blocks > MAX_BLOCKS {
        stats.mermaid_exhausted = true;
        return fallback(context, src, Reject::DocBudget, true);
    }
    if stats.mermaid_diagrams >= MAX_DIAGRAMS
        || stats.mermaid_source_bytes + src.len() > MAX_DOC_SOURCE
    {
        stats.mermaid_exhausted = true;
        return fallback(context, src, Reject::DocBudget, true);
    }

    let seq = stats.mermaid_diagrams;
    match build(src, seq, stats) {
        Outcome::Svg { svg, counts } => {
            if stats.mermaid_svg_bytes + svg.len() > MAX_DOC_SVG {
                stats.mermaid_exhausted = true;
                return fallback(context, src, Reject::DocBudget, true);
            }
            stats.mermaid_diagrams += 1;
            stats.mermaid_rendered += 1;
            stats.mermaid_source_bytes += src.len();
            stats.mermaid_svg_bytes += svg.len();
            stats.mermaid_nodes += counts.nodes;
            stats.mermaid_relations += counts.relations;
            context.cr()?;
            context.write_str("<div class=\"rmd-diagram\" data-diagram=\"mermaid\">")?;
            context.write_str(&svg)?;
            context.write_str("</div>")?;
            context.lf()?;
            Ok(ChildRendering::Skip)
        }
        // 回退的图**不占**图数与字节额度（它没有产物），但要计入可见统计。
        Outcome::Fallback(reason) => fallback(context, src, reason, false),
        Outcome::BudgetExhausted => {
            stats.mermaid_exhausted = true;
            fallback(context, src, Reject::DocBudget, true)
        }
    }
}

/// 记一次回退，再写回退块。⭐ **计数与输出在同一条路径上**——
/// 分两处写必然有一处漏掉（`code_exhausted` 那边的四条闸门就是照这个形状写的）。
fn fallback(
    context: &mut Context<RenderStats>,
    src: &str,
    reason: Reject,
    budget: bool,
) -> Result<ChildRendering, fmt::Error> {
    let stats = &mut context.user;
    stats.mermaid_fallback += 1;
    if budget {
        stats.mermaid_budget_exhausted += 1;
    }
    match reason {
        // ⚠️ 累计触顶**不再**记成单块超限：归因是"整篇用完了"，⛔ 不是"这一块太大"
        //    （同 `gate_code_fence` 的 ① 排在 ② 之前的理由）。
        Reject::TooLarge if !budget => stats.mermaid_oversize += 1,
        Reject::Empty => stats.mermaid_empty += 1,
        Reject::Security => stats.mermaid_security += 1,
        _ => {}
    }
    write_fallback(context, src, &reason)
}

/// 回退块：**一个**外壳 div（保持「1 个 AST 块 ↔ 1 个 DOM 节点」）＋
/// 一行看得见的原因 ＋ **逐字**原文。
///
/// ⚠️ 外壳里**没有** `rmd-diagram`：前端 `blocks.js` 用
/// `/(^|\s)rmd-diagram(-fallback)?(\s|$)/` 把两者都判成 `diagram` 形状，
/// 但样式上它们必须分开（`.rmd-diagram` 是 `text-align:center`，
/// 代码块跟着居中会很难看）。
fn write_fallback(
    context: &mut Context<RenderStats>,
    src: &str,
    reason: &Reject,
) -> Result<ChildRendering, fmt::Error> {
    context.cr()?;
    context.write_str("<div class=\"rmd-diagram-fallback\" data-diagram=\"mermaid\">")?;
    context.write_str("<p class=\"rmd-diagram-note\">")?;
    let mut note = String::from(NOTE_PREFIX);
    note.push_str(&reason.text());
    context.escape(&note)?;
    context.write_str("</p>")?;
    context.write_str("<pre class=\"")?;
    context.write_str(PRE_CLASS)?;
    context.write_str("\"><code class=\"language-mermaid\">")?;
    context.escape(src)?;
    context.write_str("</code></pre></div>")?;
    context.lf()?;
    Ok(ChildRendering::Skip)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset_calls() {
        RENDER_CALLS.with(|c| c.set(0));
        PARSE_CALLS.with(|c| c.set(0));
    }

    fn calls() -> usize {
        RENDER_CALLS.with(|c| c.get())
    }

    fn parse_calls() -> usize {
        PARSE_CALLS.with(|c| c.get())
    }

    /// 单图、无全文已用量的情形（绝大多数判据都在这个前提下）。
    fn render(src: &str) -> Outcome {
        build(src, 0, &RenderStats::default())
    }

    fn svg_of(src: &str) -> String {
        match render(src) {
            Outcome::Svg { svg, .. } => svg,
            Outcome::Fallback(r) => panic!("期望出图，实际回退：{r:?}"),
            Outcome::BudgetExhausted => panic!("空白文档不该触到全文累计闸门"),
        }
    }

    fn reject_of(src: &str) -> Reject {
        match render(src) {
            Outcome::Svg { .. } => panic!("期望回退，实际出图"),
            Outcome::Fallback(r) => r,
            Outcome::BudgetExhausted => panic!("空白文档不该触到全文累计闸门"),
        }
    }

    // ── 准入与头部 ──

    #[test]
    fn 准入表里的每类图都能出图() {
        for (kind, src) in corpus() {
            let out = render(src);
            assert!(
                matches!(out, Outcome::Svg { .. }),
                "{kind} 应当出图，实际 {:?}",
                match out {
                    Outcome::Fallback(r) => r,
                    _ => unreachable!(),
                }
            );
        }
    }

    fn corpus() -> Vec<(&'static str, &'static str)> {
        vec![
            ("flowchart", "flowchart TD\n A[开始] --> B{判断}\n B -->|是| C\n"),
            // ⭐ 评审 P0-5：子图面板（`#f7f8fd`/`#c9cfe8`/`#6a7086`）与**交叉边**的
            //    遮罩只有这两样语料能触发——少了它们，那三个色槽永远测不到。
            (
                "flowchart-子图与交叉",
                "flowchart TD\n subgraph 一组\n  A --> B\n  C --> D\n end\n                  subgraph 二组\n  E --> F\n end\n A --> F\n C --> B\n",
            ),
            // ⭐ 斜体标签（`font-style="italic"`）与 `&`／实体转义。
            ("flowchart-斜体与实体", "flowchart TD\n A[<i>斜体</i> &amp; 文本] --> B\n"),
            ("graph", "graph LR\n A --> B\n"),
            // ⭐ `accTitle` / `accDescr` ⇒ 根 `<svg>` 的 `aria-describedby`（评审 P0-3）。
            (
                "sequenceDiagram",
                "sequenceDiagram\n accTitle: 时序图\n accDescr: 只是两条消息\n                  participant A\n participant B\n A->>B: 一\n note right of B: 备注\n                  B-->>A: 二\n",
            ),
            ("classDiagram", "classDiagram\n class A {\n +int x\n }\n A <|-- B\n"),
            ("stateDiagram-v2", "stateDiagram-v2\n [*] --> A\n A --> [*]\n"),
            ("stateDiagram", "stateDiagram\n [*] --> A\n A --> [*]\n"),
            // ⭐ 评审 P0-5：ER 的**类型栏**（`#6a7086`）与注释只有带属性的实体才有。
            (
                "erDiagram",
                "erDiagram\n A {\n  string 名字\n  int 年龄\n }\n A ||--o{ B : has\n                  %% 一条注释\n",
            ),
            ("pie", "pie title 占比\n \"A\" : 40\n \"B\" : 60\n"),
            ("mindmap", "mindmap\n  root\n    一\n"),
            // ⭐ 评审 P0-5：≥2 个 section ＋ 分数 1/2/4 才能覆盖 JOY 的八色段落底
            //    与三档满意度色（`#cae7d5` … `#e8574f`）。
            (
                "journey",
                "journey\n title 一天\n section 早\n   起床: 1: 我\n   吃饭: 4: 你\n                  section 晚\n   读书: 2: 我\n",
            ),
            ("gitGraph", "gitGraph\n commit\n commit\n"),
            ("timeline", "timeline\n title 史\n section 古\n   唐 : 诗\n"),
            ("sankey-beta", "sankey-beta\n A,B,10\n B,C,5\n"),
            ("sankey", "sankey\n A,B,10\n B,C,5\n"),
            (
                "architecture-beta",
                "architecture-beta\n service a(server)[A]\n service b(server)[B]\n a:R -- L:b\n",
            ),
            (
                "architecture",
                "architecture\n service a(server)[A]\n service b(server)[B]\n a:R -- L:b\n",
            ),
        ]
    }

    #[test]
    fn 不支持的图种说明是这类图暂不支持() {
        for kind in [
            "gantt",
            "xychart-beta",
            "quadrantChart",
            "kanban",
            "treemap",
            "treemap-beta",
            "requirementDiagram",
            "block-beta",
            "packet-beta",
            "packet",
            "radar-beta",
            "C4Context",
            "C4Container",
            "C4Component",
            "C4Dynamic",
            "C4Deployment",
            "zenuml",
            "swimlane-beta",
        ] {
            let src = format!("{kind}\n A --> B\n");
            match reject_of(&src) {
                Reject::UnsupportedKind(k) => assert_eq!(k, kind),
                other => panic!("{kind} 的原因不对：{other:?}"),
            }
        }
    }

    #[test]
    fn 未知头部不是流程图() {
        // ⚠️ 引擎会把 `foobar` 当流程图并返回 Ok（实测）——这一条挡的就是那个。
        assert_eq!(
            reject_of("foobar\n A --> B\n"),
            Reject::UnknownKind("foobar".into())
        );
    }

    #[test]
    fn 头部取第一个_token_而不是第二个词() {
        assert_eq!(classify("flowchart TD\n").unwrap(), "flowchart");
        assert_eq!(classify("stateDiagram-v2\n A\n").unwrap(), "stateDiagram-v2");
        // `gitGraph:`（冒号紧跟）
        assert_eq!(classify("gitGraph:\n commit\n").unwrap(), "gitGraph");
        // BOM ＋ 前置空行
        assert_eq!(
            classify("\u{feff}\n\nflowchart TD\n").unwrap(),
            "flowchart"
        );
        // `%%` 注释在头部之前
        assert_eq!(classify("%% 说明\nflowchart TD\n").unwrap(), "flowchart");
    }

    #[test]
    fn frontmatter_与配置指令分别回退() {
        assert_eq!(reject_of("---\ntitle: x\n---\nflowchart TD\n A-->B\n"), Reject::Frontmatter);
        assert_eq!(reject_of("---\ntitle: x\nflowchart TD\n"), Reject::FrontmatterUnclosed);
        assert_eq!(
            reject_of("%%{init: {'theme':'dark'}}%%\nflowchart TD\n A-->B\n"),
            Reject::Config
        );
        // ⭐ 评审 P1-2：配置指令出现在**表头之后**同样是"静默丢作者配置"。
        assert_eq!(
            reject_of("flowchart TD\n A-->B\n %%{init: {'theme':'dark'}}%%\n"),
            Reject::Config
        );
        // ⚠️ 反向：`%%{` 不在行首时**不是**配置（节点标签里的字面文本）。
        assert!(matches!(
            render("flowchart TD\n A[\"看这里 %%{init}%%\"] --> B\n"),
            Outcome::Svg { .. }
        ));
    }

    #[test]
    fn 空块与只有头部都是空图() {
        assert_eq!(reject_of(""), Reject::Empty);
        assert!(matches!(reject_of("flowchart TD\n"), Reject::Empty));
        assert!(matches!(reject_of("%% 只有注释\n"), Reject::Empty));
        assert!(matches!(
            reject_of("flowchart TD\n classDef a fill:#f00\n"),
            Reject::Empty
        ));
    }

    #[test]
    fn 语法错误带行号() {
        match reject_of("flowchart TD\n A -->> B\n") {
            Reject::Syntax(line, _) => assert!(line >= 1),
            other => panic!("{other:?}"),
        }
    }

    // ── 结构预算 ──

    #[test]
    fn 乘法放大在解析前就被挡下且布局零调用() {
        let mut src = String::from("flowchart TD\n A0");
        for i in 1..100 {
            src.push_str(&format!(" & A{i}"));
        }
        src.push_str(" --> B0");
        for i in 1..100 {
            src.push_str(&format!(" & B{i}"));
        }
        reset_calls();
        assert_eq!(reject_of(&src), Reject::TooLarge);
        // ⭐ §7.1 的判据是**解析次数 = 0**。⚠️ 只断言布局为 0 不够：
        //    预扫描闸门被停用后，模型闸门仍会拒绝、布局仍是 0 ⇒ 那条断言照样绿
        //    （2026-11-03 变异自证 M2 就是这样漏的）。
        assert_eq!(parse_calls(), 0, "预扫描拒绝之后不许解析");
        assert_eq!(calls(), 0, "预扫描拒绝之后不许进布局");
    }

    #[test]
    fn 预扫描是真实边数的上界且小规模下逐个相等() {
        for n in [10usize, 20, 50] {
            let mut src = String::from("flowchart TD\n A0");
            for i in 1..n {
                src.push_str(&format!(" & A{i}"));
            }
            src.push_str(" --> B0");
            for i in 1..n {
                src.push_str(&format!(" & B{i}"));
            }
            let est = prescan(&src, true);
            assert_eq!(est.edges, n * n, "n={n}");
            let doc = flowmaid::parser::parse_document(&src).expect("合法");
            assert_eq!(counts(&doc).relations, n * n);
        }
    }

    #[test]
    fn 长链的边界是五一二个节点() {
        // ⚠️ 边界是**节点数**，不是边数：`N0-->…-->N512` 有 512 条边但 **513 个节点**。
        //    能出图的最长链是 511 条边 / 512 个节点。
        //    （`design/0060` §7.1 写的是「512/513 边」，那是边口径的笔误，实施记录里改了。）
        // ⚠️⚠️ 但**这条测试咬住的是预扫描的 token 闸门**（513 个 token > 512），
        //    ⛔ 不是 `MAX_NODES`——首行一个 token 一个节点，token 数恒 = 节点数，
        //    所以节点上限还没轮到就先被拦下了。模型闸门的独立判据在
        //    `模型闸门在非流程图里能先于预扫描咬住` 与 `每个图种的关系数边界都是五一二`。
        let chain = |n: usize| {
            let mut s = String::from("flowchart TD\n");
            s.push_str(" N0");
            for i in 1..=n {
                s.push_str(&format!(" --> N{i}"));
            }
            s.push('\n');
            s
        };
        assert!(matches!(render(&chain(511)), Outcome::Svg { .. }));
        reset_calls();
        assert_eq!(reject_of(&chain(512)), Reject::TooLarge);
        assert_eq!(parse_calls(), 0, "预扫描先拦下，不进解析");
        assert_eq!(calls(), 0);
    }

    #[test]
    fn 模型闸门在非流程图里能先于预扫描咬住() {
        // ⭐ 预扫描对非流程图**一条语句至多算一个节点、一条关系**，
        //    而一条 `sankey` 语句能带出**两个**不同节点 ⇒ 600 个节点只有 300 条语句。
        //    ⚠️ 没有这条判据，把 `MAX_NODES` 放宽到 5000 不会打红任何测试
        //    （2026-11-03 变异自证 M3 正是这样漏的）。
        let mut src = String::from("sankey-beta\n");
        for i in 0..300 {
            src.push_str(&format!("B{i},C{i},10\n"));
        }
        let est = prescan(&src, false);
        assert!(
            est.tokens <= MAX_PRESCAN_TOKENS && est.edges <= MAX_PRESCAN_EDGES,
            "预扫描必须放行：tokens={} edges={}",
            est.tokens,
            est.edges
        );
        reset_calls();
        assert_eq!(reject_of(&src), Reject::TooLarge);
        assert_eq!(parse_calls(), 1, "预扫描放行 ⇒ 必然解析过一次");
        assert_eq!(calls(), 0, "模型闸门拒绝之后不许进布局");
    }

    #[test]
    fn 没有箭头的大量节点也受_token_闸门管() {
        let many = |n: usize| {
            let mut s = String::from("flowchart TD\n A0");
            for i in 1..n {
                s.push_str(&format!(" & A{i}"));
            }
            s.push('\n');
            s
        };
        assert!(matches!(render(&many(512)), Outcome::Svg { .. }));
        reset_calls();
        assert_eq!(reject_of(&many(513)), Reject::TooLarge);
        assert_eq!(calls(), 0);
    }

    #[test]
    fn 深嵌套的边界是十六() {
        let nest = |d: usize| {
            let mut s = String::from("flowchart TD\n");
            for i in 0..d {
                s.push_str(&format!(" subgraph s{i}\n"));
            }
            s.push_str(" A-->B\n");
            for _ in 0..d {
                s.push_str(" end\n");
            }
            s
        };
        assert!(matches!(render(&nest(16)), Outcome::Svg { .. }));
        reset_calls();
        assert_eq!(reject_of(&nest(17)), Reject::TooLarge);
        assert_eq!(calls(), 0);
    }

    #[test]
    fn 头部关键字只在第一条语句上成立() {
        // 评审 P0-1：旧写法对**每一行**都套准入关键字 ⇒ 第二行 `graph …` 被当表头
        // 跳过，预扫描算 0 个 token，引擎却把它当边解析（16 KiB 可做出千万级边）。
        let fan = |n: usize| {
            let mut s = String::from("flowchart TD\n graph");
            for i in 0..n {
                s.push_str(&format!(" & A{i}"));
            }
            s.push_str(" -->");
            for i in 0..n {
                s.push_str(&format!(" & B{i}"));
            }
            s.push('\n');
            s
        };
        reset_calls();
        assert_eq!(reject_of(&fan(100)), Reject::TooLarge);
        assert_eq!(parse_calls(), 0, "预扫描必须自己挡住，⛔ 不许交给引擎");

        // ⭐ 反向：`flowchart TD` 作表头时，`subgraph` / `style` 等真指令仍不计数。
        assert!(matches!(render("flowchart TD\n subgraph s\n A\n end\n"), Outcome::Svg { .. }));
    }

    #[test]
    fn 头关键字后面跟边运算符时不算指令() {
        // `style --> B` 是"从一个叫 style 的节点出发的边"，⛔ 不是 `style` 指令。
        let est = prescan("flowchart TD\n A\n style --> B\n", true);
        assert_eq!(est.tokens, 3, "{est:?}");
        assert!(est.edges >= 1, "{est:?}");
    }

    #[test]
    fn 不可见连线也算边() {
        // 评审 P0-2：`~~~` 既没 `-` 也没 `=`，漏掉它上界就不成立。
        let mut s = String::from("flowchart TD\n A0");
        for i in 1..100 {
            s.push_str(&format!(" & A{i}"));
        }
        s.push_str(" ~~~ B0");
        for i in 1..100 {
            s.push_str(&format!(" & B{i}"));
        }
        s.push('\n');
        let est = prescan(&s, true);
        assert!(est.edges >= 10000, "乘法放大必须被算进来：{est:?}");
        reset_calls();
        assert_eq!(reject_of(&s), Reject::TooLarge);
        assert_eq!(parse_calls(), 0);
    }

    #[test]
    fn 预扫描公式对混合写法也是上界() {
        // `A & B --> C & D --> E` 的真实边数是 6，估算是 9。
        let est = prescan("flowchart TD\n A & B --> C & D --> E\n", true);
        assert!(est.edges >= 6, "{est:?}");
        let doc = flowmaid::parser::parse_document("flowchart TD\n A & B --> C & D --> E\n").unwrap();
        assert_eq!(counts(&doc).relations, 6);
    }

    #[test]
    fn 标签里的中文不计入_token() {
        // 一屏正常的中文标签不该被算成几百个 token。
        let est = prescan(
            "flowchart TD\n A[这是一个很长的中文标签用于测试] --> B[另一个同样很长的中文标签]\n",
            true,
        );
        assert_eq!(est.tokens, 2, "{est:?}");
        assert_eq!(est.edges, 1);
    }

    #[test]
    fn 标签里的箭头与花括号也不算结构() {
        // ⚠️ 标签里的 `-->` 是**文字**，⛔ 不是边：估多了会把一屏正常的图打成回退。
        //    引号形态与方括号形态都要覆盖（引擎两种都收）。
        let est = prescan("flowchart TD\n A[\"x --> y\"] --> B\n", true);
        assert_eq!((est.tokens, est.edges), (2, 1), "{est:?}");
        let est = prescan("flowchart TD\n A[x ==> y] --> B\n", true);
        assert_eq!((est.tokens, est.edges), (2, 1), "{est:?}");
        // 同族的 `%%{` 在标签里也不是配置指令（行首才算），这条在
        // `frontmatter_与配置指令分别回退` 里守着；这里钉住它**不会**被算成边。
        let est = prescan("flowchart TD\n A[看 %%{init}%% 这串字] --> B\n", true);
        assert_eq!((est.tokens, est.edges), (2, 1), "{est:?}");
    }

    #[test]
    fn accDescr_多行块既不算节点也不触发预算() {
        // ⭐ `accDescr { … }` 块里是**无障碍描述正文**，可以很长很自由；
        //    逐行当语句会让一段正常的描述把图打成「超出规模限制」。
        let mut src = String::from("flowchart TD\n accDescr {\n");
        for i in 0..200 {
            src.push_str(&format!(" 第{i}行描述，这一行是给读屏软件念的纯文本\n"));
        }
        src.push_str(" }\n A --> B\n");
        assert!(src.len() <= MAX_SOURCE, "语料必须在上限内：{}", src.len());
        // 预扫描：块内一行都不算 ⇒ 只剩 A、B 两个 token。
        let est = prescan(&src, true);
        assert_eq!((est.tokens, est.edges), (2, 1), "{est:?}");
        // ⚠️ 400 行若被逐行计数就是 400+ token，早已越过 512 的一半；
        //    真的走完管线出图，才是"这块被整段跳过"的判据。
        assert!(matches!(render(&src), Outcome::Svg { .. }));
    }

    // ── 安全清洗 ──

    #[test]
    fn click_三种协议都不留导航标签() {
        for url in ["https://example.com", "file:///etc/passwd", "../x.md"] {
            let src = format!("flowchart TD\n A-->B\n click A \"{url}\"\n");
            // ⚠️ **必须断言"真的出图了"**：⛔ 别写成 `if let Outcome::Svg {..}`——
            //    那样整块回退时循环体一次都不执行，测试**恒绿**，而它守的正是
            //    "`<a>` 被解包、文字还在"（`design/0060` §2.1⑦）。
            match render(&src) {
                Outcome::Svg { svg, .. } => {
                    assert!(!svg.contains("<a"), "{svg}");
                    assert!(!svg.contains("href"), "{svg}");
                    // 解包 ≠ 删掉节点：被链的节点文字必须还在（否则等于"点不了也看不见"）。
                    assert!(svg.contains(">A<"), "节点标签应当保留：{svg}");
                }
                other => panic!("`click` 只该去掉导航，不该整块回退：{other:?}"),
            }
        }
    }

    #[test]
    fn 两图的_id_集合不相交() {
        let src = "flowchart TD\n A-->B\n";
        let one = match build(src, 0, &RenderStats::default()) {
            Outcome::Svg { svg, .. } => svg,
            _ => panic!(),
        };
        let two = match build(src, 1, &RenderStats::default()) {
            Outcome::Svg { svg, .. } => svg,
            _ => panic!(),
        };
        let ids = |s: &str| -> Vec<String> {
            s.split("id=\"").skip(1).map(|r| r.split('"').next().unwrap_or("").to_string()).collect()
        };
        let (a, b) = (ids(&one), ids(&two));
        assert!(!a.is_empty());
        for id in &a {
            assert!(id.starts_with("m0-"), "{id}");
            assert!(!b.contains(id), "{id} 撞车");
        }
        // `url(#…)` 也必须指向本图
        for r in one.split("url(#").skip(1) {
            let id = r.split(')').next().unwrap_or("");
            assert!(id.starts_with("m0-"), "{id}");
        }
    }

    #[test]
    fn marker_与遮罩的_引用都跟着加前缀() {
        // ⭐ 引擎给**每张流程图**都发 `id="arrow"` 与交叉边的 `<mask id="…">`；
        //    引用的两个入口（`marker-end` / `mask`）漏掉任何一个，第二张图的箭头
        //    就会指向第一张图的标记（或被清掉）。`两图的_id_集合不相交` 只看 `<id=`，
        //    ⛔ 断言不到"引用这一侧"到底是哪个属性。
        let out = sanitize_svg(
            "<svg><defs><marker id=\"arrow\"/><mask id=\"mask1\"/></defs>\
             <path marker-end=\"url(#arrow)\"/><g mask=\"url(#mask1)\"/></svg>",
            3,
            true,
        )
        .unwrap();
        assert!(out.contains("id=\"m3-arrow\""), "{out}");
        assert!(out.contains("id=\"m3-mask1\""), "{out}");
        assert!(out.contains("marker-end=\"url(#m3-arrow)\""), "{out}");
        assert!(out.contains("mask=\"url(#m3-mask1)\""), "{out}");
        // ⛔ 引用值不认裸 id（`marker-end="arrow"` 是引擎行为变化的信号）。
        assert!(sanitize_svg("<svg><path marker-end=\"arrow\"/></svg>", 0, true).is_err());
        // ⛔ 白名单之外的同类引用属性（`clip-path`）不带前缀就回退，⛔ 不透传。
        assert!(sanitize_svg("<svg><g clip-path=\"url(#a)\"/></svg>", 0, true).is_err());
    }

    #[test]
    fn 清洗后的产物能被_xml_重新解析() {
        let svg = svg_of("flowchart TD\n A-->B\n");
        assert_eq!(svg_of("flowchart TD\n A-->B\n"), svg);
        // 自证：拿清洗结果再走一次清洗，必须仍成功（幂等且合法）
        assert!(sanitize_svg(&svg, 0, true).is_ok(), "{:?}", sanitize_svg(&svg, 0, true).err());
        // ⭐ 上面只钉了一种图。逐图种过一遍：清洗器**不许**产出自己会拒绝的东西
        //    （那等于"下次打开文档时图随机消失"），而 12 类产物的属性并集不同。
        for (kind, src) in corpus() {
            let svg = svg_of(src);
            assert!(
                sanitize_svg(&svg, 0, true).is_ok(),
                "{kind} 的产物过不了自家清洗器"
            );
        }
    }

    #[test]
    fn 未知元素与属性一律回退() {
        assert!(sanitize_svg("<svg><script>x</script></svg>", 0, true).is_err());
        assert!(sanitize_svg("<svg><foreignObject/></svg>", 0, true).is_err());
        assert!(sanitize_svg("<svg><bogus/></svg>", 0, true).is_err());
        assert!(sanitize_svg("<svg width=\"10\" onclick=\"x\"/>", 0, true).is_err());
        assert!(sanitize_svg("<svg width=\"10\" style=\"fill:red\"/>", 0, true).is_err());
        // ⚠️ `class` 自 2026-11-03 起**合法**（评审 P0-3：边动画与 `:::` 类名都要它），
        //    但它只认最窄字符集——带选择器语法的一律回退。
        assert!(sanitize_svg("<svg class=\"x\"/>", 0, true).is_ok());
        assert!(sanitize_svg("<svg class=\"a.b\"/>", 0, true).is_err());
        assert!(sanitize_svg("<svg class=\"a[href]\"/>", 0, true).is_err());
        assert!(sanitize_svg("<svg class=\"\"/>", 0, true).is_err());
        assert!(sanitize_svg("<svg flood-color=\"red\"/>", 0, true).is_err());
    }

    #[test]
    fn class_值只认安全字符集() {
        assert!(class_value("edge-animation-fast"));
        assert!(class_value("a b_c-d 0"));
        assert!(!class_value("a.b"));
        assert!(!class_value("a>b"));
        assert!(!class_value("a\"b"));
        assert!(!class_value(""));
        assert!(!class_value(&"a".repeat(65)));
    }

    #[test]
    fn 作者配色语法可以进清洗器() {
        // 评审 P0-4：模式 B 是作者配色，`fill:red` / `rgb()` 都是合法作者写法。
        for ok in [
            "<svg><rect fill=\"steelblue\"/></svg>",
            "<svg><rect fill=\"rebeccapurple\"/></svg>",
            "<svg><rect fill=\"rgb(12, 34, 56)\"/></svg>",
            "<svg><rect fill=\"rgba(12,34,56,0.5)\"/></svg>",
            "<svg><rect fill=\"hsl(120deg 50% 50% / 0.3)\"/></svg>",
        ] {
            assert!(sanitize_svg(ok, 0, false).is_ok(), "{ok}");
        }
        // ⛔ 括号嵌套 / 引号 / 分号 / 任意函数一律回退。
        for bad in [
            "<svg><rect fill=\"rgb(calc(1), 2, 3)\"/></svg>",
            "<svg><rect fill=\"rgb(1,2,3);x\"/></svg>",
            "<svg><rect fill=\"rgb('1',2,3)\"/></svg>",
            "<svg><rect fill=\"rgb(1,2,3\"/></svg>",
            "<svg><rect fill=\"rgb(1,2,3))\"/></svg>",
        ] {
            assert!(sanitize_svg(bad, 0, false).is_err(), "{bad}");
        }
    }

    #[test]
    fn 模式a的替换只碰颜色属性不碰文字() {
        // 评审 P1-1：旧做法对整条 SVG 扫 `#rrggbb`，图例文字里的色值也会被吃掉。
        let out = sanitize_svg(
            "<svg><text fill=\"#ffffff\">#ffffff</text><title>#ffffff</title></svg>",
            0,
            true,
        )
        .unwrap();
        assert!(out.contains("fill=\"var(--reader-diag-surface)\""), "{out}");
        assert!(out.contains(">#ffffff</text>"), "{out}");
        assert!(out.contains("<title>#ffffff</title>"), "{out}");
    }

    #[test]
    fn mask_子树不做主题色替换() {
        // 评审 P0-3：遮罩靠**亮度**挖洞，颜色跟着主题走会让洞消失或反转。
        let out = sanitize_svg(
            "<svg><mask id=\"m\"><rect fill=\"#ffffff\"/></mask><rect fill=\"#ffffff\"/></svg>",
            0,
            true,
        )
        .unwrap();
        assert!(out.contains("mask"), "{out}");
        assert!(
            out.contains("<mask id=\"m0-m\"><rect fill=\"#ffffff\"/></mask>"),
            "{out}"
        );
        assert!(out.contains("fill=\"var(--reader-diag-surface)\""), "{out}");
    }

    #[test]
    fn 外部_url_与非严格_url_都回退() {
        assert!(sanitize_svg("<svg><rect fill=\"url(https://evil/x.png)\"/></svg>", 0, true).is_err());
        assert!(sanitize_svg("<svg><rect fill=\"url(file:///etc/passwd)\"/></svg>", 0, true).is_err());
        assert!(sanitize_svg("<svg><rect fill=\"URL(#a)\"/></svg>", 0, true).is_err());
        assert!(sanitize_svg("<svg><rect fill=\"url( '#a' )\"/></svg>", 0, true).is_err());
        assert!(sanitize_svg("<svg><rect fill=\"url(#a)\"/></svg>", 0, true).is_ok());
    }

    #[test]
    fn 属性值重新转义() {
        let out = sanitize_svg("<svg aria-label=\"a&quot;&amp;&lt;b\"/>", 0, true).unwrap();
        assert!(out.contains("&amp;"), "{out}");
        assert!(!out.contains("<b>"), "{out}");
    }

    // ── 颜色两态 ──

    #[test]
    fn 模式a下没有字面色残留() {
        for (kind, src) in corpus() {
            let svg = svg_of(src);
            assert!(
                !svg.contains("#") || !has_hex_color(&svg),
                "{kind} 残留了字面色值"
            );
            for r in svg.split("var(--reader-diag-").skip(1) {
                let slot = format!("--reader-diag-{}", r.split(')').next().unwrap_or(""));
                assert!(
                    !slot.is_empty() && slot.len() > "--reader-diag-".len(),
                    "{kind} 变量名坏了"
                );
            }
        }
    }

    /// 产物里还有没有一个 6 位/3 位十六进制色值（`url(#…)` 不算）。
    fn has_hex_color(s: &str) -> bool {
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'#' {
                for n in [6usize, 3] {
                    if let Some(h) = s.get(i + 1..i + 1 + n) {
                        if h.bytes().all(|c| c.is_ascii_hexdigit())
                            && b.get(i + 1 + n).is_none_or(|&t| !is_ident_byte(t))
                        {
                            return true;
                        }
                    }
                }
            }
            i += 1;
        }
        false
    }

    #[test]
    fn 模式a_的每种图都真的画出它自己的色值() {
        // ⛔ 空表也能通过的断言不算数：逐类检查"至少映射到了一个变量"。
        for (kind, src) in corpus() {
            let svg = svg_of(src);
            assert!(
                svg.contains("var(--reader-diag-"),
                "{kind} 一个色值都没映射"
            );
        }
    }

    #[test]
    fn 模式b保留作者配色且不出现主题变量() {
        let svg = svg_of("flowchart TD\n A[开始] --> B\n classDef hot fill:#ffffff\n class A hot\n");
        assert!(svg.contains("#ffffff"), "{svg}");
        assert!(!svg.contains("var(--reader-diag-"), "{svg}");
    }

    // ── 强调填充上的字色（`bugs/0073`）──

    #[test]
    fn 强调填充上的深字换成_on_accent_白字与普通深字不动() {
        // 语料：参与者头 A=indigo（白字）、B=green（深字）；消息文字压在白底上。
        let svg = svg_of("sequenceDiagram\n participant A\n participant B\n A->>B: hi\n");
        assert!(
            svg.contains("fill=\"var(--reader-diag-on-accent)\""),
            "green 头上的深字必须换槽：{svg}"
        );
        assert!(
            svg.contains("fill=\"var(--reader-diag-surface)\""),
            "indigo 头上的白字仍走 surface：{svg}"
        );
        assert!(
            svg.contains("fill=\"var(--reader-diag-text)\""),
            "白底上的深字仍走 text：{svg}"
        );
        assert!(!has_hex_color(&svg), "产物里不该剩字面色：{svg}");
    }

    #[test]
    fn on_accent_只落在真正压着强调填充的那几段字上() {
        // ⚠️ 判据是**条数**：多映射一段就是把别的字也改了色。
        let svg = svg_of("sequenceDiagram\n participant A\n participant B\n A->>B: hi\n");
        // 参与者头上下各画一次 ⇒ 正好两段。
        assert_eq!(
            svg.matches("var(--reader-diag-on-accent)").count(),
            2,
            "只有 B 的参与者头是 green 底 + 深字：{svg}"
        );
    }

    #[test]
    fn 饼图的白字标签不会被相邻扇区抢走底() {
        // 33% 的标签压在 indigo 扇区上，但它的锚点落在 green 扇区的**外接框**里——
        // 用外接框判定会把它算成 green 底（`bugs/0073` §5 的原型实测）。
        let svg = svg_of("pie\n  \"A\" : 1\n  \"B\" : 2\n");
        // 画布底、两条扇区分隔线、33% 的白字都会用到 surface ⇒ 这里只钉白字那一处。
        assert!(
            svg.contains("fill=\"var(--reader-diag-surface)\">33%</text>"),
            "{svg}"
        );
        assert_eq!(
            svg.matches("var(--reader-diag-on-accent)").count(),
            1,
            "67% 的深字压在 green 扇区上：{svg}"
        );
    }

    #[test]
    fn 椭圆弧的边界是精确的_不吃相邻扇区() {
        // 语料 `44-pie-noshow` 的原始几何：green 是 67% 的大弧。
        let d = "M 150.0 150.0 L 262.6 215.0 A 130.0 130.0 0 1 1 150.0 20.0 Z";
        let poly = path_poly(d).expect("引擎发的语法要认得");
        // 33% 标签的锚点（语料里的 231.1 / 99.2）：在 green 的**外接框**内、**不在**扇区里。
        assert!(!point_in_poly(&poly, 231.1, 103.2 - 4.0), "33% 标签不该算 green 底");
        // 67% 标签的锚点（68.9 / 192.8）：确实在 green 扇区里。
        assert!(point_in_poly(&poly, 68.9, 196.8 - 4.0), "67% 标签必须算 green 底");
        // ⭐ 反面：拿外接框判就**会**误判——这条把「为什么必须解析 A 命令」钉住。
        let (x0, x1) = (poly.iter().map(|p| p.0).fold(f64::MAX, f64::min), poly.iter().map(|p| p.0).fold(f64::MIN, f64::max));
        let (y0, y1) = (poly.iter().map(|p| p.1).fold(f64::MAX, f64::min), poly.iter().map(|p| p.1).fold(f64::MIN, f64::max));
        assert!(x0 <= 231.1 && 231.1 <= x1 && y0 <= 99.2 && 99.2 <= y1);
    }

    #[test]
    fn defs_里的模板既不记账也不判定() {
        let 模板 = "<rect x=\"0\" y=\"0\" width=\"100\" height=\"100\" fill=\"#33a35c\"/>";
        let 文字 = "<text x=\"50\" y=\"50\" fill=\"#0a0e1a\">x</text>";
        let out = sanitize_svg(
            &format!("<svg><defs>{模板}</defs>{文字}</svg>"),
            0,
            true,
        )
        .unwrap();
        assert!(out.contains("fill=\"var(--reader-diag-text)\""), "{out}");
        assert!(!out.contains("on-accent"), "{out}");
        // 正面对照：同一块 rect 画在正文里 ⇒ 判定生效。
        let out = sanitize_svg(&format!("<svg>{模板}{文字}</svg>"), 0, true).unwrap();
        assert!(out.contains("fill=\"var(--reader-diag-on-accent)\""), "{out}");
    }

    #[test]
    fn 有_transform_时整图退回旧映射() {
        // ⚠️ 坐标系不可比时只可能"少修"：⛔ 不许把本来正常的图改坏。
        let svg = "<svg><rect x=\"0\" y=\"0\" width=\"100\" height=\"100\" fill=\"#33a35c\"/>\
                   <text x=\"50\" y=\"50\" fill=\"#0a0e1a\">x</text>\
                   <g transform=\"translate(1 1)\"/></svg>";
        let out = sanitize_svg(svg, 0, true).unwrap();
        assert!(out.contains("fill=\"var(--reader-diag-text)\""), "{out}");
        assert!(!out.contains("on-accent"), "{out}");
    }

    #[test]
    fn 作者配色下永远不出_on_accent() {
        let svg = "<svg><rect x=\"0\" y=\"0\" width=\"100\" height=\"100\" fill=\"#33a35c\"/>\
                   <text x=\"50\" y=\"50\" fill=\"#0a0e1a\">x</text></svg>";
        let out = sanitize_svg(svg, 0, false).unwrap();
        assert!(out.contains("#0a0e1a"), "{out}");
        assert!(!out.contains("on-accent"), "{out}");
    }

    #[test]
    fn 圆的精确边界_不外接框() {
        // 圆心 (10,10) 半径 10：外接框的角 (18,18) 在框内、在圆外。
        let svg = "<svg><circle cx=\"10\" cy=\"10\" r=\"10\" fill=\"#33a35c\"/>\
                   <text x=\"19\" y=\"19\" fill=\"#0a0e1a\">角</text></svg>";
        let out = sanitize_svg(svg, 0, true).unwrap();
        assert!(out.contains("fill=\"var(--reader-diag-text)\""), "{out}");
        // 圆心处仍判成强调底（anchor 的 y 减 4 ⇒ 用 (10, 10) 更稳）。
        let svg = "<svg><circle cx=\"10\" cy=\"10\" r=\"10\" fill=\"#33a35c\"/>\
                   <text x=\"10\" y=\"14\" fill=\"#0a0e1a\">心</text></svg>";
        let out = sanitize_svg(svg, 0, true).unwrap();
        assert!(out.contains("fill=\"var(--reader-diag-on-accent)\""), "{out}");
    }

    #[test]
    fn 深字的判据只认引擎那五个色值() {
        for v in ["#0a0e1a", "#232840", "#000000", "#2f3550", "#2f3768", "#0A0E1A"] {
            assert!(is_dark_ink(v), "{v}");
        }
        for v in ["#ffffff", "#33a35c", "#0a0e1", "0a0e1a", "rgb(1,2,3)", "#0a0e1ax"] {
            assert!(!is_dark_ink(v), "{v}");
        }
    }

    #[test]
    fn 模式b的三条路径都能判定() {
        for src in [
            "flowchart TD\n A-->B\n style A fill:#eee\n",
            "flowchart TD\n A-->B\n linkStyle 0 stroke:#f00\n",
            "flowchart TD\n A-->B\n classDef c fill:#eee\n class A c\n",
        ] {
            let doc = flowmaid::parser::parse_document(src).expect("合法");
            assert!(has_author_style(&doc), "{src}");
        }
    }

    #[test]
    fn 定义了但没用到的_classdef_仍是模式a() {
        let doc =
            flowmaid::parser::parse_document("flowchart TD\n A-->B\n classDef unused fill:#eee\n")
                .unwrap();
        assert!(!has_author_style(&doc));
    }

    // ── 回退与可见性 ──

    #[test]
    fn 合法特性不触发安全回退() {
        // ⭐ 评审 P0-3/P0-4 的判据（此前是一次性实验，2026-11-03 转正）：
        //    这些全是**普通文档里常见**的写法，撞白名单就等于"一不小心图就没了"。
        let cases: &[(&str, &str)] = &[
            ("粗体", "flowchart TD\n A[\"**b**\"] --> B\n"),
            ("斜体", "flowchart TD\n A[\"*i*\"] --> B\n"),
            ("斜体字面", "flowchart TD\n A[\"<i>i</i>\"] --> B\n"),
            ("accDescr", "flowchart TD\n accDescr { 一句话 }\n A-->B\n"),
            ("accDescr多行", "flowchart TD\n accDescr {\n 第一行\n 第二行\n }\n A-->B\n"),
            ("accTitle", "flowchart TD\n accTitle: 标题\n A-->B\n"),
            ("er注释", "erDiagram\n E {\n string n \"注释\"\n }\n"),
            ("mindmap类", "mindmap\n root\n  leaf:::urgent\n"),
            ("边动画", "flowchart TD\n A e1@--> B\n e1@{ animate: true }\n"),
            ("交叉", "flowchart LR\n A-->C\n B-->D\n A-->D\n B-->C\n"),
            ("交叉2", "flowchart TD\n A-->D\n B-->C\n A-->C\n B-->D\n"),
            ("交叉3", "flowchart LR\n A-->X\n B-->Y\n C-->Z\n A-->Y\n C-->X\n"),
            ("sankey", "sankey-beta\n A,B,10\n B,C,5\n"),
            ("pie", "pie title 占比\n \"A\" : 40\n"),
            ("class", "classDiagram\n class A\n A <|-- B\n"),
        ];
        for (name, src) in cases {
            match build(src, 0, &RenderStats::default()) {
                Outcome::Svg { svg, .. } => {
                    // ⭐ 交叉边必须真的带上遮罩（那是这次放行的**原因**），
                    //    ⛔ 否则"放行了 maskUnits"这件事没有被验证过。
                    if *name == "交叉" || *name == "交叉2" {
                        assert!(svg.contains("mask"), "{name} 应当带遮罩：{svg}");
                    }
                    // ⭐ accentDescr 的 idref 必须跟着加文档前缀。
                    if svg.contains("aria-describedby") {
                        assert!(svg.contains("aria-describedby=\"m0-"), "{name}：{svg}");
                    }
                }
                other => panic!("{name} 是合法写法，⛔ 不该整块回退：{other:?}"),
            }
        }
    }

    #[test]
    fn 畸形语料不会_panic() {
        // ⭐ 产物来自**用户文档**，而回退的语义是「换一段代码块」，⛔ 不是「整份文档打不开」。
        //    ⇒ 这里只要求**不 panic / 不越界**：走完全程（准入 → 预扫描 → 解析 → 计数）
        //    返回什么都行。⚠️ 它不是"渲染正确"的判据，那些在各自的分组里。
        let cases: &[&str] = &[
            "",
            "mermaid",
            "flowchart",
            "flowchart TD\n",
            "\u{feff}flowchart TD\n A-->B\n",
            "---\ntitle: x\n---\nflowchart TD\n A-->B\n",
            "%%{init: {'theme':'dark'}}%%\nflowchart TD\n A-->B\n",
            "flowchart TD\n A-->B <!-- 注释 -->\n",
            "flowchart TD\n A[\"含 \\\" 引号 与 & 和 <tag>\"] --> B\n",
            "flowchart TD\n A-->B\n click A \"https://x\" \"tip\"\n",
            "flowchart TD\n A-->B\n <script>x</script>\n",
            "flowchart TD\n subgraph 空\n end\n",
            "flowchart TD\n A -->\n",
            "erDiagram\n :::: \n",
            "sankey-beta\n A,B,\n",
            "timeline\n",
            "pie\n \"\":\n",
            "sequenceDiagram\n A->>B:\n",
            "classDiagram\n class \n",
            "%%{init}%% %% %%%%",
            "\0\u{1}\u{7f}",
            "flowchart TD\n A-->B\n style A fill:#\n",
        ];
        for s in cases {
            let _ = build(s, 0, &RenderStats::default());
        }

        // ⭐ 最深的一档：把 16 KiB 上限塞满 `subgraph`。⚠️ 这一段过 `is_directive` ⇒
        //    **预扫描一个 token 都不算**，所以能走到解析器里去——真正的栈深由它扛。
        let mut deep = String::from("flowchart TD\n");
        let mut opens = String::new();
        let mut n = 0usize;
        loop {
            let line = format!("subgraph S{n}\n");
            // 每层还要一条 `end\n`（4 字节），两者都要算进上限。
            if deep.len() + opens.len() + line.len() + (n + 1) * 4 > MAX_SOURCE {
                break;
            }
            opens.push_str(&line);
            n += 1;
        }
        deep.push_str(&opens);
        for _ in 0..n {
            deep.push_str("end\n");
        }
        assert!(deep.len() <= MAX_SOURCE, "语料必须在上限内：{}", deep.len());
        assert!(n > 300, "深度要够：{n}");
        // ⚠️ 只"不崩"不够：它必须真的**回退**，⛔ 不是画出来。
        //    ⭐ 实测（0.33.0）：引擎自己先挡——**嵌套 500 层**就 `Err("subgraph nesting
        //    too deep (max 500 levels)")`，于是这里是 `Syntax`（带行号）而不是 `TooLarge`。
        //    ⚠️ 别把这条钉成 `TooLarge`：我们的 `MAX_DEPTH=16` 在 17–500 层之间先咬住
        //    （`深嵌套的边界是十六`），更深的那些由引擎挡——两条闸门是接力关系。
        match reject_of(&deep) {
            Reject::Syntax(_, msg) => assert!(msg.contains("too deep"), "引擎的拒绝理由：{msg}"),
            Reject::TooLarge => {}
            other => panic!("最深嵌套必须回退，实际：{other:?}"),
        }

        // ⭐ 同族的另一头：一条超长单行（16 KiB 无换行）——预扫描按语句累加，必须不溢出。
        let long = format!("flowchart TD\n {}\n", "A-->".repeat(MAX_SOURCE / 4 + 1));
        assert_eq!(reject_of(&long), Reject::TooLarge, "单行超长必须回退");
    }

    #[test]
    fn 回退原因文案() {
        assert_eq!(Reject::UnsupportedKind("gantt".into()).text(), "这类图暂不支持（gantt）");
        assert_eq!(Reject::TooLarge.text(), "超出规模限制");
        assert_eq!(Reject::Security.text(), "安全拒绝");
        assert_eq!(Reject::Empty.text(), "空图");
        assert_eq!(Reject::Config.text(), "配置指令（%%{init}%%）暂不支持");
        assert_eq!(Reject::Frontmatter.text(), "frontmatter 暂不支持");
        // ⭐ 同族的两条：未闭合与"认识但不支持"的头部，⛔ 别让它们落进 `_` 分支
        //    被写成一句含糊的「出错了」（`docs/features/0060` §3 第 3 条）。
        assert_eq!(Reject::FrontmatterUnclosed.text(), "frontmatter 未闭合");
        assert_eq!(
            Reject::UnknownKind("foobar".into()).text(),
            "不认识的图类型（foobar）"
        );
        // ⭐ 全文额度用完必须是**另一句话**：它要用户去删**别的**图。
        assert_eq!(
            Reject::DocBudget.text(),
            "全文的图额度已用完（本块及后续不再渲染）"
        );
        assert!(Reject::Syntax(3, "boom\nsecond".into()).text().contains("第 3 行"));
        // ⚠️ 引擎给的消息可能只有空白（没有首行）——那时也必须说清是语法错误，
        //    ⛔ 不能退化成「语法错误（第 N 行）：」这种挂着冒号的半句话。
        assert_eq!(
            Reject::Syntax(2, "  \n第二行".into()).text(),
            "语法错误（第 2 行）"
        );
    }

    #[test]
    fn 超长原因按_utf8_边界截断() {
        let long = "很".repeat(500);
        let t = Reject::Syntax(1, long).text();
        std::str::from_utf8(t.as_bytes()).expect("必须是合法 UTF-8");
        assert!(t.len() < 400);
    }

    #[test]
    fn 未知图类型的超长_token_也不越过原因上限() {
        // `bugs/0075`：`UnknownKind` 的 token 直接来自用户首行，原本**无界**。
        let t = Reject::UnknownKind("图".repeat(300)).text();
        assert!(t.len() <= MAX_REASON_BYTES, "{} 字节：{t}", t.len());
        assert!(t.ends_with('）'), "结尾的括号必须保留：{t}");
        assert!(!t.contains('\u{fffd}'), "不能切出半个字符");
        std::str::from_utf8(t.as_bytes()).expect("必须是合法 UTF-8");
        // 反面：短 token 的文案逐字不变（与 `回退原因文案` 那条同口径）。
        assert_eq!(
            Reject::UnknownKind("foobar".into()).text(),
            "不认识的图类型（foobar）"
        );
        // `UnsupportedKind` 的 token 来自准入表、实际不会超长，但同一出口同样收口。
        let u = Reject::UnsupportedKind("甘".repeat(300)).text();
        assert!(u.len() <= MAX_REASON_BYTES, "{} 字节：{u}", u.len());
        assert!(u.ends_with('）'));
        // ⚠️ `Syntax` 的扣前缀口径同族：整行（含 `未渲染：`）也不越 200 字节。
        let s = Reject::Syntax(9, "故".repeat(300)).text();
        assert!(
            s.len() + NOTE_PREFIX.len() <= MAX_REASON_BYTES,
            "{} + {} 字节：{s}",
            s.len(),
            NOTE_PREFIX.len()
        );
    }

    // ── 结构闸门（直接测判据）──

    #[test]
    fn 每个图种的关系数边界都是五一二() {
        // ⭐ 逐图种走一遍 `within_limits`：判据是**模型里的数**，与源码行数无关。
        //    ⚠️ `design/0060` §7.1 要求「每个图种各一条 512/513」，这里用构造的
        //    `Counts` 精确钉住，⛔ 不靠造 513 行语料——那条会被预扫描先拦下，
        //    测到的就不是这一道闸门了。
        let noc = RenderStats::default();
        let ok = |n: usize, r: usize| within_limits(&Counts { nodes: n, relations: r, clusters: 0, depth: 0 }, &noc);
        assert!(ok(512, 0), "节点 512 放行");
        assert!(!ok(513, 0), "节点 513 回退");
        assert!(ok(0, 512), "关系 512 放行");
        assert!(!ok(0, 513), "关系 513 回退");
        assert!(ok(512, 512));
        assert!(!ok(513, 0));
        // 嵌套与 subgraph
        assert!(within_limits(&Counts { nodes: 1, relations: 0, clusters: 32, depth: 16 }, &noc));
        assert!(!within_limits(&Counts { nodes: 1, relations: 0, clusters: 33, depth: 0 }, &noc));
        assert!(!within_limits(&Counts { nodes: 1, relations: 0, clusters: 0, depth: 17 }, &noc));
    }

    #[test]
    fn 全文累计也走同一道闸门() {
        let mut doc = RenderStats::default();
        doc.mermaid_nodes = MAX_DOC_NODES - 10;
        doc.mermaid_relations = MAX_DOC_RELATIONS - 10;
        assert!(within_limits(&Counts { nodes: 10, relations: 10, clusters: 0, depth: 0 }, &doc));
        assert!(!within_doc(&Counts { nodes: 11, relations: 0, clusters: 0, depth: 0 }, &doc));
        assert!(!within_doc(&Counts { nodes: 0, relations: 11, clusters: 0, depth: 0 }, &doc));
        doc.mermaid_nodes = 0;
        doc.mermaid_relations = 0;
        assert!(within_doc(&Counts { nodes: MAX_DOC_NODES, relations: 0, clusters: 0, depth: 0 }, &doc));
        assert!(!within_doc(&Counts { nodes: MAX_DOC_NODES + 1, relations: 0, clusters: 0, depth: 0 }, &doc));
    }

    // ── 全文累计 ＋ 粘滞（走真渲染管线）──

    /// 一篇文档里放 `n` 张最小的流程图。
    fn doc_with(n: usize) -> String {
        let mut s = String::new();
        for i in 0..n {
            s.push_str(&format!("```mermaid\nflowchart TD\n A{i} --> B{i}\n```\n\n"));
        }
        s
    }

    fn render_doc(src: &str) -> (String, RenderStats) {
        use crate::document::parser::{with_parsed, ParseOpts};
        let opts = ParseOpts::default();
        with_parsed(src, &opts, |root| {
            crate::document::render::to_html_with_stats(root, &opts)
        })
    }

    #[test]
    fn 图数触顶之后的每一块都回退_粘滞() {
        let (html, st) = render_doc(&doc_with(34));
        assert_eq!(st.mermaid_rendered, 32, "{st:?}");
        assert_eq!(st.mermaid_fallback, 2, "{st:?}");
        assert_eq!(st.mermaid_budget_exhausted, 2, "第 33、34 块都该记成累计触顶：{st:?}");
        assert_eq!(st.mermaid_oversize, 0, "累计触顶不该再记成单块超限：{st:?}");
        assert_eq!(html.matches("data-diagram=\"mermaid\"").count(), 34);
        assert_eq!(html.matches("rmd-diagram-fallback").count(), 2);
        // ⭐ 归因要**说得准**（评审 P2）：额度用完了 ≠ 这一块太大了。
        assert!(
            html.contains("全文的图额度已用完"),
            "累计触顶必须说成全文额度：{html}"
        );
        assert!(!html.contains("超出规模限制"), "{html}");
    }

    #[test]
    fn 源码累计触顶之后粘滞() {
        // ⚠️ 每块要「字节大、结构极小」：用 `%%` 注释把字节数顶上去。
        //    ⛔ 别用 200 条边那种形状——它会先撞上**节点累计 2048**，测到的就是另一道闸门了。
        let pad = format!("%%{}\n", "=".repeat(3000));
        let mut src = String::new();
        for i in 0..40 {
            // ⚠️ 每块必须**各不相同**（否则后一块的 `id` 会与前一块重复）。
            src.push_str(&format!("```mermaid\nflowchart TD\n M{i} --> N{i}\n{pad}```\n\n"));
        }
        assert!(pad.len() + 64 < MAX_SOURCE, "单块仍须在单图源码上限内");
        let (_, st) = render_doc(&src);
        assert!(st.mermaid_exhausted, "40 × 3 KiB 应当触到 64 KiB 的累计闸门：{st:?}");
        assert!(st.mermaid_rendered >= 1, "{st:?}");
        assert!(st.mermaid_source_bytes <= MAX_DOC_SOURCE, "{st:?}");
        assert!(
            st.mermaid_source_bytes + pad.len() > MAX_DOC_SOURCE,
            "剩下的额度必须**不够再放一块**（否则触顶理由不成立）：{st:?}"
        );
        assert_eq!(
            st.mermaid_budget_exhausted,
            40 - st.mermaid_rendered,
            "触顶之后每一块都记成累计触顶（⛔ 不记成单块超限）：{st:?}"
        );
        assert_eq!(st.mermaid_oversize, 0, "{st:?}");
    }

    #[test]
    fn 节点累计触顶之后粘滞() {
        // 每块 101 节点 / 100 关系 ⇒ 20 块后 2020 节点，第 21 块起放不下 2048。
        let mut src = String::new();
        for i in 0..25 {
            let chain: String = (0..100)
                .map(|j| format!(" N{i}_{j} --> N{i}_{}\n", j + 1))
                .collect();
            src.push_str(&format!("```mermaid\nflowchart TD\n{chain}```\n\n"));
        }
        let (html, st) = render_doc(&src);
        assert_eq!(st.mermaid_rendered, 20, "{st:?}");
        assert!(st.mermaid_exhausted, "{st:?}");
        assert_eq!(
            st.mermaid_budget_exhausted, 5,
            "全文累计放不下的那一块起，其后每块都记成累计触顶：{st:?}"
        );
        assert_eq!(st.mermaid_oversize, 0, "累计触顶⛔ 不该记成单块超限：{st:?}");
        // ⭐ 归因也要说对（评审 P2）：这条路的回退原因**不是**「超出规模限制」。
        assert!(html.contains("全文的图额度已用完"), "{html}");
        assert!(!html.contains("超出规模限制"), "{html}");
    }

    #[test]
    fn 单块超限不连坐后面的图() {
        // 评审 P1-3：单块自己超上限时**先判它**，⛔ 不许记成"全文额度用完"。
        // ⚠️ 否则它会置粘滞位，后面那些本来画得出来的图全被连坐。
        //
        // ⚠️ 光放一块超限图**测不出来**：`build` 自己也会挡它（`TooLarge`），两条路
        //    结果一样。必须把全文额度先吃到"再放一块超限图就不够"的程度——
        //    那时"先判单块"才真正决定它会不会连坐后面那块。
        let mut src = String::new();
        for i in 0..4 {
            let pad = "=".repeat(15_000);
            src.push_str(&format!(
                "```mermaid\nflowchart TD\n P{i} --> Q{i}\n%%{pad}\n```\n\n"
            ));
        }
        let big = format!(
            "```mermaid\nflowchart TD\n A --> B\n%%{}\n```\n\n",
            "=".repeat(MAX_SOURCE)
        );
        src.push_str(&big);
        src.push_str("```mermaid\nflowchart TD\n C --> D\n```\n");
        let (_, st) = render_doc(&src);
        assert_eq!(st.mermaid_rendered, 5, "4 块填充 ＋ 最后一块：{st:?}");
        assert_eq!(st.mermaid_fallback, 1, "只有超限那块回退：{st:?}");
        assert_eq!(st.mermaid_oversize, 1, "{st:?}");
        assert_eq!(st.mermaid_budget_exhausted, 0, "{st:?}");
        assert!(!st.mermaid_exhausted, "单块超限⛔ 不许置粘滞位：{st:?}");
    }

    #[test]
    fn 单块超限与全文额度说的是两句不同的话() {
        let big = format!("```mermaid\nflowchart TD\n A --> B\n%%{}\n```\n", "=".repeat(MAX_SOURCE));
        let (html, _) = render_doc(&big);
        assert!(html.contains("超出规模限制"), "{html}");
        assert!(!html.contains("全文的图额度"), "{html}");
    }

    #[test]
    fn 源码刚好在上限内仍出图_多一字节才回退() {
        // ⭐ 闸门是 `>`（16 KiB **字节**），⛔ 不是 `>=`：恰好 16384 字节的图是合法的。
        //    ⚠️ 差一位的闸门不会打红别的任何一条测试——它们用的语料都远在上限之外。
        let pad = |extra: usize| {
            let base = "flowchart TD\n A --> B\n%%";
            // 末尾还要一个 `\n`，所以先扣掉它。
            let fill = MAX_SOURCE - base.len() - 1 - extra;
            format!("{base}{}\n", "=".repeat(fill))
        };
        let exact = pad(0);
        assert_eq!(exact.len(), MAX_SOURCE, "语料必须正好在上限上");
        assert!(matches!(render(&exact), Outcome::Svg { .. }), "恰好 16384 字节应当出图");
        let over = format!("{exact}%");
        assert_eq!(over.len(), MAX_SOURCE + 1);
        assert_eq!(reject_of(&over), Reject::TooLarge, "16385 字节必须回退");
    }

    #[test]
    fn 围栏总数有上限且触顶粘滞() {
        // 评审 P1-4：回退的块不占图数额度 ⇒ 没有这一条时块数可以无限多。
        // ⚠️ 全部用**必然回退**的块（`gantt`），这样 `mermaid_diagrams` 一直是 0。
        let mut src = String::new();
        let n = MAX_BLOCKS + 3;
        for _ in 0..n {
            src.push_str("```mermaid\ngantt\n title 计划\n```\n\n");
        }
        let (_, st) = render_doc(&src);
        assert_eq!(st.mermaid_rendered, 0, "{st:?}");
        assert_eq!(st.mermaid_fallback, n, "每一块都必须有可见回退：{st:?}");
        assert!(st.mermaid_exhausted, "{st:?}");
        assert_eq!(
            st.mermaid_budget_exhausted, 3,
            "超出的 3 块记成累计触顶：{st:?}"
        );
        // ⚠️ 前 MAX_BLOCKS 块的原因是**各自的**（gantt 不支持），⛔ 不是额度。
        assert_eq!(st.mermaid_oversize, 0, "{st:?}");
    }

    // ── 回退块在真管线里的形状 ──

    #[test]
    fn 回退块是一个外壳加一行原因加逐字原文() {
        let src = "```mermaid\ngantt\n title 计划\n section A\n 任务 :a1, 2024-01-01, 3d\n```\n";
        let (html, st) = render_doc(src);
        assert_eq!(st.mermaid_rendered, 0, "{st:?}");
        assert_eq!(st.mermaid_fallback, 1, "{st:?}");
        assert_eq!(
            html.matches("data-diagram=\"mermaid\"").count(),
            1,
            "回退也必须是**一个**外壳块\n{html}"
        );
        assert!(html.contains("class=\"rmd-diagram-fallback\""), "{html}");
        assert!(html.contains("class=\"rmd-diagram-note\""), "原因要看得见\n{html}");
        assert!(html.contains("未渲染：这类图暂不支持（gantt）"), "{html}");
        assert!(html.contains("class=\"rmd-code\""), "{html}");
        assert!(html.contains("class=\"language-mermaid\""), "{html}");
        // ⭐ 原文**逐字**（转义后）：`section A` / `2024-01-01` 都得在。
        assert!(html.contains("section A"), "原文丢了\n{html}");
        assert!(html.contains("2024-01-01"), "原文丢了\n{html}");
        // ⛔ 回退外壳不许冒充画出来的图（前端判形状靠 `-fallback`）。
        assert!(!html.contains("class=\"rmd-diagram\""), "{html}");
    }

    #[test]
    fn 超长首行的回退提示在真管线里也不越过上限() {
        // `bugs/0075` §6：端到端（真 formatter）而不是只测 `text()`。
        let src = format!("```mermaid\n{}\n```\n", "图".repeat(300));
        let (html, st) = render_doc(&src);
        assert_eq!(st.mermaid_fallback, 1, "{st:?}");
        let note = html
            .split("class=\"rmd-diagram-note\">")
            .nth(1)
            .and_then(|s| s.split("</p>").next())
            .expect("回退提示必须在");
        assert!(note.len() <= MAX_REASON_BYTES, "{} 字节：{note}", note.len());
        assert!(!note.contains('\u{fffd}'), "不能切出半个字符：{note}");
        assert!(note.ends_with('）'), "结尾的括号必须保留：{note}");
        // 反面：`<script>` 形式的 token 仍走转义路径，DOM 里不出现元素。
        let (html, st) = render_doc("```mermaid\n<script>alert(1)</script>\n```\n");
        assert_eq!(st.mermaid_fallback, 1, "{st:?}");
        assert!(!html.contains("<script>"), "必须转义\n{html}");
        assert!(html.contains("&lt;script&gt;"), "{html}");
    }

    #[test]
    fn 画出来的图有外壳且不含_note() {
        let (html, st) = render_doc("```mermaid\nflowchart TD\n A --> B\n```\n");
        assert_eq!(st.mermaid_rendered, 1, "{st:?}");
        assert!(html.contains("class=\"rmd-diagram\" data-diagram=\"mermaid\""), "{html}");
        assert!(html.contains("<svg"), "{html}");
        assert!(!html.contains("rmd-diagram-note"), "{html}");
    }

    #[test]
    fn 围栏语言大小写与参数不影响识别() {
        // ⚠️ `fence_lang` 取第一个词且转小写——`mermaid` 与 `Mermaid` 同义。
        let (html, _) = render_doc("```Mermaid\nflowchart TD\n A --> B\n```\n");
        assert!(html.contains("data-diagram=\"mermaid\""), "{html}");
        // ⚠️ 围栏参数（`mermaid title="x"`）也照收——取的是第一个词。
        let (html, _) = render_doc("```mermaid title=\"图一\"\nflowchart TD\n A --> B\n```\n");
        assert!(html.contains("data-diagram=\"mermaid\""), "{html}");
    }

    #[test]
    fn 两份围栏在同一文档里各自成图() {
        // ⚠️ 端到端走**真 formatter**（`render_doc`）：两块的 `seq` 必须不同，
        //    ID 前缀因此不撞——单测里直接 `build(…, 0, …)` 两次是测不到的。
        let src = "```mermaid\nflowchart TD\n A --> B\n```\n\n```mermaid\nflowchart TD\n C --> D\n```\n";
        let (html, st) = render_doc(src);
        assert_eq!(st.mermaid_rendered, 2, "{st:?}");
        assert_eq!(html.matches("data-diagram=\"mermaid\"").count(), 2, "{html}");
        assert!(html.contains("m0-arrow"), "{html}");
        assert!(html.contains("m1-arrow"), "{html}");
    }

    #[test]
    fn 回退的块不占_ID_前缀序号() {
        // ⭐ `seq` 取的是 `mermaid_diagrams`（**画出来的**图数），⛔ 不是围栏序号：
        //    否则中间夹一个回退块，后面所有图的 id 都带洞。
        //    ⚠️ 判据要同时看"没有 m2-"：只断言 m0-/m1- 存在，漏掉"回退块吃掉了序号"
        //    这种错误（那时是 m0-、m2-）。
        let src = "```mermaid\ngantt\n title 计划\n```\n\n\
                   ```mermaid\nflowchart TD\n A --> B\n```\n\n\
                   ```mermaid\nflowchart TD\n C --> D\n```\n";
        let (html, st) = render_doc(src);
        assert_eq!(st.mermaid_rendered, 2, "{st:?}");
        assert_eq!(st.mermaid_fallback, 1, "{st:?}");
        assert!(html.contains("m0-arrow"), "{html}");
        assert!(html.contains("m1-arrow"), "{html}");
        assert!(!html.contains("m2-"), "回退块不该吃掉一个序号：{html}");
    }

    #[test]
    fn 波浪号与四反引号围栏都认() {
        // ⭐ `~~~` 与四个反引号都是 CommonMark 的合法围栏；**只认三个反引号**等于
        //    "同一份文档换个写法图就没了"，而回退块至少还看得见原文，这里连原文都不出。
        let (html, st) = render_doc("~~~mermaid\nflowchart TD\n A --> B\n~~~\n");
        assert_eq!(st.mermaid_rendered, 1, "{st:?}");
        // 四个反引号的价值是**能装下三个反引号的正文**（`%%` 注释里写 ```` ``` ````）。
        let (html2, st2) = render_doc(
            "````mermaid\nflowchart TD\n A --> B\n %% ``` 这行是注释\n````\n",
        );
        assert_eq!(st2.mermaid_rendered, 1, "{st2:?}");
        assert_eq!(st2.mermaid_fallback, 0, "{st2:?}");
        assert!(html2.contains("m0-arrow"), "{html2}");
        assert!(html.contains("data-diagram=\"mermaid\""), "{html}");
        // 大写的 `MERMAID`（`Mermaid` 已在 `围栏语言大小写与参数不影响识别` 里）。
        let (_, st3) = render_doc("```MERMAID\nflowchart TD\n A --> B\n```\n");
        assert_eq!(st3.mermaid_rendered, 1, "{st3:?}");
    }

    #[test]
    fn CRLF_的源码也能出图() {
        // ⚠️ Windows 上存的 Markdown 每一行都是 `\r\n`。围栏内容会带着 `\r` 进来——
        //    只要有一层把 `\r` 当成标识符的一部分，图就会静默回退成"语法错误"。
        //    ⭐ 两条路径都要走：`build` 直接收 `\r`（单元层）与整篇 `render_doc`（管线层）。
        assert!(matches!(
            render("flowchart TD\r\n A --> B\r\n"),
            Outcome::Svg { .. }
        ));
        let (html, st) = render_doc("```mermaid\r\nflowchart TD\r\n A --> B\r\n```\r\n");
        assert_eq!(st.mermaid_rendered, 1, "{st:?}");
        assert_eq!(st.mermaid_fallback, 0, "{st:?}");
        assert!(html.contains("<svg"), "{html}");
    }

    #[test]
    fn 围栏在引用块与列表里仍然成图() {
        // ⚠️ 图在**嵌套上下文**里是常态（笔记里引用一段、列表里列几条）。
        //    `write_block` 返回 `Skip` 并自己写外壳——嵌在 `<blockquote>` / `<li>` 里时
        //    不能退化成回退块，也不能被外层再包一层 `<p>`。
        let src = "> ```mermaid\n> flowchart TD\n>  A --> B\n> ```\n\n\
                   - 列表项\n\n  ```mermaid\n  flowchart TD\n   C --> D\n  ```\n";
        let (html, st) = render_doc(src);
        assert_eq!(st.mermaid_rendered, 2, "{st:?}");
        assert_eq!(st.mermaid_fallback, 0, "{st:?}");
        assert_eq!(html.matches("data-diagram=\"mermaid\"").count(), 2, "{html}");
        assert!(html.contains("<blockquote"), "{html}");
        assert!(html.contains("<li"), "{html}");
    }

    #[test]
    fn 没有围栏时统计全零且不改正文() {
        // ⭐ 摘要里 `mermaid=` **每次都要出现**（含零）；其余分组键在零时**不出现**。
        //    ⚠️ 这条守的是"没有 mermaid 的文档完全不受影响"——新增统计字段时
        //    最容易在这里漏掉一个没归零的字段（`..Default::default()` 少写一格）。
        let src = "# 标题\n\n正文一段，里面提到 mermaid 这个词。\n\n```rust\nfn main() {}\n```\n";
        let (html, st) = render_doc(src);
        for (name, v) in [
            ("rendered", st.mermaid_rendered),
            ("fallback", st.mermaid_fallback),
            ("oversize", st.mermaid_oversize),
            ("empty", st.mermaid_empty),
            ("security", st.mermaid_security),
            ("budget", st.mermaid_budget_exhausted),
            ("source_bytes", st.mermaid_source_bytes),
            ("svg_bytes", st.mermaid_svg_bytes),
            ("nodes", st.mermaid_nodes),
            ("relations", st.mermaid_relations),
            ("blocks", st.mermaid_blocks),
        ] {
            assert_eq!(v, 0, "mermaid_{name} 应为 0：{st:?}");
        }
        assert!(!st.mermaid_exhausted, "{st:?}");
        let s = st.summary();
        assert!(s.contains("mermaid=0"), "{s}");
        for key in ["mermaid_skip=", "mermaid_over=", "mermaid_empty=", "mermaid_sec=", "mermaid_budget="] {
            assert!(!s.contains(key), "{key} 零时不该出现：{s}");
        }
        assert!(!html.contains("data-diagram"), "{html}");
    }

    #[test]
    fn 回退计数按门分类且合计等于回退总数() {
        // ⭐ `mermaid_oversize` / `_empty` 是 `mermaid_fallback` 的**子集**，
        //    ⛔ 不是并列的桶：两处各加一次就成"一份回退记两次"，摘要会自相矛盾。
        let src = "```mermaid\ngantt\n title 计划\n```\n\n\
                   ```mermaid\nflowchart TD\n```\n\n\
                   ```mermaid\nflowchart TD\n A --> B\n%%{}\n```\n";
        let big_pad = "=".repeat(MAX_SOURCE);
        let src = format!("{src}```mermaid\nflowchart TD\n C --> D\n%%{big_pad}\n```\n");
        let (html, st) = render_doc(&src);
        assert_eq!(st.mermaid_rendered, 0, "{st:?}");
        assert_eq!(st.mermaid_fallback, 4, "{st:?}");
        assert_eq!(st.mermaid_empty, 1, "空图只记一次：{st:?}");
        assert_eq!(st.mermaid_oversize, 1, "单块超限只记一次：{st:?}");
        assert_eq!(st.mermaid_budget_exhausted, 0, "{st:?}");
        assert_eq!(
            st.mermaid_empty + st.mermaid_oversize + 2,
            st.mermaid_fallback,
            "两条专用计数是回退总数的子集（剩下 2 条是「图种不支持」与「配置指令」）：{st:?}"
        );
        assert!(st.summary().contains("mermaid_skip=4"), "{}", st.summary());
        assert!(html.contains("这类图暂不支持（gantt）"), "{html}");
        assert!(html.contains("空图"), "{html}");
        assert!(html.contains("超出规模限制"), "{html}");
    }

    #[test]
    fn 中文标签的盒宽按全角宽度算() {
        // R3（`design/0060` §10.7）：引擎按 **1em** 估汉字宽（`layout.rs` 的
        // `c if (c as u32) >= 0x2E80 => 14.0`），而 SVG 把 `font-size` 写在**根元素**上
        // ⇒ 用户调大正文字号也不会把这几个字撑出框。
        // ⚠️ 这条**不抄引擎的算式**：只要求「最宽的盒子 ≥ 汉字数 × SVG 自己声明的字号」。
        //    引擎哪天改成按西文字宽（7.8）估汉字，图**照样画得出来**，字却会溢出——
        //    那正是这条要红的时刻（其余 50 多条判据全绿）。
        let (html, st) = render_doc("```mermaid\nflowchart TD\n 中文标签九个汉字呀 --> 短\n```\n");
        assert_eq!(st.mermaid_rendered, 1, "{st:?}");
        let fs: f64 = {
            let i = html.find("font-size=\"").expect("根 <svg> 上没有 font-size");
            let rest = &html[i + "font-size=\"".len()..];
            rest[..rest.find('"').unwrap()].parse().unwrap_or(0.0)
        };
        assert!(fs >= 12.0 && fs <= 16.0, "字号 {fs} 不是 14 附近的标定值：{html}");
        // ⚠️ 只看**节点盒子**（带 `rx=` 的 `<rect>`）：整张画布的最宽值由边路由决定，
        //    拿它当判据时把引擎的汉字宽度改成西文值**照样是绿的**——2026-11-03 实测踩到。
        let widest = html
            .match_indices("<rect ")
            .filter_map(|(i, _)| {
                let tag = &html[i..i + html[i..].find('>')?];
                if !tag.contains("rx=\"") {
                    return None; // 背景板／遮罩格子不是节点
                }
                let at = tag.find("width=\"")? + "width=\"".len();
                tag[at..at + tag[at..].find('"')?].parse::<f64>().ok()
            })
            .fold(0.0_f64, f64::max);
        assert!(
            widest >= 9.0 * fs,
            "最宽的节点盒子 {widest} < 9 个汉字 × {fs}px：{html}"
        );
    }

    #[test]
    fn 空图与安全拒绝各记各的() {
        let (_, st) = render_doc("```mermaid\nflowchart TD\n```\n");
        assert_eq!(st.mermaid_empty, 1, "{st:?}");
        assert_eq!(st.mermaid_security, 0, "{st:?}");
        assert_eq!(st.mermaid_oversize, 0, "{st:?}");
        assert_eq!(st.mermaid_unrendered(), 1, "{st:?}");
    }

    #[test]
    fn 统计摘要的键() {
        let (_, st) = render_doc("```mermaid\nflowchart TD\n A --> B\n```\n");
        let s = st.summary();
        assert!(s.contains("mermaid=1"), "{s}");
        assert!(!s.contains("mermaid_skip="), "没回退就不该出现这个键：{s}");
        assert_eq!(st.mermaid_unrendered(), 0);

        let (_, st) = render_doc("```mermaid\ngantt\n title x\n```\n");
        let s = st.summary();
        assert!(s.contains("mermaid=0"), "{s}");
        assert!(s.contains("mermaid_skip=1"), "{s}");
        assert_eq!(st.mermaid_unrendered(), 1);
    }

    #[test]
    fn mermaid_不再走代码高亮预算() {
        // ⚠️ `is_diagram_fence` 收了 `mermaid` 之后，它必须**不进** Q22 的四条预算。
        let (_, st) = render_doc("```mermaid\nflowchart TD\n A --> B\n```\n");
        assert_eq!(st.code_highlighted, 0, "{st:?}");
        assert_eq!(st.code_unhighlighted(), 0, "{st:?}");
    }

    // ── 强调色当文字色：`-line` → `-ink`（`bugs/0073`）──

    #[test]
    fn 八条强调线当文字时各走自己的_ink() {
        // 引擎 `ACCENTS` 那八个原色（`MERMAID_SWATCHES` 里的强调色那一组）。
        let pairs = [
            ("#5b6dc0", "indigo"),
            ("#33a35c", "green"),
            ("#d99114", "amber"),
            ("#c2588c", "rose"),
            ("#199a8e", "teal"),
            ("#8a5cd6", "violet"),
            ("#d96459", "coral"),
            ("#4d8fbf", "steel"),
        ];
        for (hex, fam) in pairs {
            let slot = painted_slot(hex, 0, true).unwrap_or_else(|| panic!("{hex} 没映射"));
            assert_eq!(slot, format!("--reader-diag-{fam}-line"), "{hex}");
            let ink = ink_slot(slot).unwrap_or_else(|| panic!("{hex} 没有 ink 槽"));
            assert_eq!(ink, format!("--reader-diag-{fam}-ink"), "{hex}");
            let (_, out) = map_attr("fill", hex, 0, true, true, false).expect(hex);
            assert_eq!(out, format!("var({ink})"), "{hex}");
        }
    }

    #[test]
    fn 边色当文字走软墨色_当描边不动() {
        // ER 的 `PK` / `FK` 标注拿**边色** `#44507a` 当字色（暖色主题下只有 3.99 : 1）。
        let (_, as_text) = map_attr("fill", "#44507a", 0, true, true, false).unwrap();
        assert_eq!(as_text, "var(--reader-diag-ink-soft)");
        let (_, as_line) = map_attr("stroke", "#44507a", 0, true, false, false).unwrap();
        assert_eq!(as_line, "var(--reader-diag-line)");
    }

    #[test]
    fn 强调填充上的白字仍走_surface_而深字走_on_accent() {
        let (_, white) = map_attr("fill", "#ffffff", 0, true, true, true).unwrap();
        assert_eq!(white, "var(--reader-diag-surface)");
        let (_, dark) = map_attr("fill", "#232840", 0, true, true, true).unwrap();
        assert_eq!(dark, "var(--reader-diag-on-accent)");
        // 同一段深字**不压强调填充**时仍是正文色——换槽的判据是几何，不是色值。
        let (_, plain) = map_attr("fill", "#232840", 0, true, true, false).unwrap();
        assert_eq!(plain, "var(--reader-diag-text)");
    }

    #[test]
    fn 作者配色下文字色一个字节都不改() {
        let (_, out) = map_attr("fill", "#33a35c", 0, false, true, false).unwrap();
        assert_eq!(out, "#33a35c");
    }

    #[test]
    fn ink_映射只认八条强调线() {
        for s in [
            "--reader-diag-line",
            "--reader-diag-line-soft",
            "--reader-diag-surface",
            "--reader-diag-ink-soft",
            "--reader-diag-text",
            "--reader-diag-panel-line",
        ] {
            assert!(ink_slot(s).is_none(), "{s} 不该有 ink 槽");
        }
    }

    // ── 命名实体码（`bugs/0074`）──

    #[test]
    fn 命名实体在入引擎前单趟解码() {
        let svg = svg_of("flowchart LR\n A[\"#lt;div#gt;#amp;#nbsp;\"] --> B\n");
        assert!(svg.contains("&lt;div&gt;&amp;"), "实体没解出来：{svg}");
        assert!(!svg.contains("#lt;"), "还剩着源码形态：{svg}");
    }

    #[test]
    fn 数字实体与_quot_的行为不变() {
        let svg = svg_of("flowchart LR\n A[\"#60;x#62;#quot;\"] --> B\n");
        assert!(svg.contains("&lt;x&gt;"), "{svg}");
        assert!(!svg.contains("#quot;"), "{svg}");
        assert!(!svg.contains("#60;"), "{svg}");
    }

    #[test]
    fn xml_实体不被二次解码() {
        let svg = svg_of("flowchart LR\n A[\"&lt;\"] --> B\n");
        assert!(svg.contains("&amp;lt;"), "`&lt;` 被当成了 Mermaid 实体：{svg}");
    }

    #[test]
    fn 单趟解码_不把_num_lt_继续解成尖括号() {
        assert_eq!(decode_entities("#num;lt;").as_deref(), Some("#lt;"));
        // 数字实体留给引擎 ⇒ 这一层一个字节都不动。
        assert_eq!(decode_entities("#35;lt;"), None);
        assert_eq!(decode_entities("没有实体的普通一行"), None);
    }

    #[test]
    fn 解码路径不打开注入面() {
        let svg = svg_of("flowchart LR\n A[\"#lt;script#gt;alert(1)#lt;/script#gt;\"] --> B\n");
        assert!(!svg.contains("<script"), "解出可执行标签：{svg}");
        assert!(svg.contains("&lt;script&gt;"), "转义丢了：{svg}");
    }

    // ── 引擎不支持的标准构造（`bugs/0076`）──

    fn assert_unsupported(src: &str, name: &str) {
        let r = reject_of(src);
        assert!(matches!(r, Reject::UnsupportedSyntax(_)), "{r:?}");
        let t = r.text();
        assert!(!t.contains("语法错误"), "归因仍在怪作者：{t}");
        assert!(t.contains(name), "文案没点名构造：{t}");
        assert!(
            t.len() + NOTE_PREFIX.len() <= MAX_REASON_BYTES,
            "整条提示超预算：{t}"
        );
    }

    #[test]
    fn 序列图的_rect_片段说暂不支持() {
        assert_unsupported(
            "sequenceDiagram\n    rect rgb(200, 220, 255)\n        A->>B: hi\n    end\n",
            "rect",
        );
    }

    #[test]
    fn 类图的_namespace_说暂不支持() {
        assert_unsupported(
            "classDiagram\nnamespace 模型 {\n  class User\n}\n",
            "namespace",
        );
    }

    #[test]
    fn 类图的独立_interface_说暂不支持() {
        assert_unsupported(
            "classDiagram\n  class A\n  class B\n  A <|-- B\n  <<interface>> Box\n",
            "<<interface>>",
        );
    }

    #[test]
    fn 类图的_cssClass_说暂不支持() {
        assert_unsupported("classDiagram\n  class A\n  cssClass \"A\" red\n", "cssClass");
    }

    #[test]
    fn 状态图的并发分隔线说暂不支持() {
        assert_unsupported(
            "stateDiagram-v2\n  [*] --> A\n  A --> B\n  --\n  B --> [*]\n",
            "--",
        );
    }

    #[test]
    fn 真语法错误仍报语法错误() {
        for src in [
            "classDiagram\n  class A\n  A <|--\n",
            "sequenceDiagram\n  A->>\n",
            "stateDiagram-v2\n  A -->\n",
        ] {
            let r = reject_of(src);
            match r {
                Reject::Syntax(line, _) => assert!(line >= 1),
                other => panic!("{src} 被误归因：{other:?}"),
            }
        }
        let r = reject_of("flowchart TD\n A[ --> B\n");
        assert!(!r.text().contains("暂不支持"), "{}", r.text());
    }
}
