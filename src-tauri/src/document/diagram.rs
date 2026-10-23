//! 图表：` ```flow ` / ` ```sequence ` → Mermaid 严格子集 → SVG（`design/0007` §2.3）。
//!
//! # 为什么不把围栏直接交给 flowmaid
//!
//! 两个上游 DSL **不是** Mermaid：` ```flow ` 是 `adrai/flowchart.js` 的语法，
//! ` ```sequence ` 是 `bramp/js-sequence-diagrams` 的语法。`design/0007` §2.3 的三选一里
//! 我们取 **(B) 自写翻译层**：先把**严格子集**改写成 Mermaid 源码，再交给 `flowmaid`。
//!
//! # 两道闸门（⭐ 分工与初稿**相反**，见 §2.3.4）
//!
//! | 闸门 | 挡什么 | 依据 |
//! |---|---|---|
//! | 本模块的**翻译层**（第一道） | ⭐ **语义**：重复定义、引用未定义、`condition` 的分支不是 `yes`/`no`、同一槽位两条边、规模超限 | ⛔ `flowmaid` **不是语义闸门**——同一节点定义两次它**静默 last-wins**，未定义引用它**隐式建空节点**（`docs/kb/0015` ②） |
//! | `flowmaid` 自己（第二道） | **语法**：标识符形态、形状写法、`note` 的形状…… | 它不懂的输入**返回 `Err`**，⛔ 不是静默画错（`docs/kb/0015` ①） |
//!
//! **任何一条不过 ⇒ 整块回退成代码块**（`INV-DIAG-01`），⛔ 不截断、⛔ 不画一半。
//! ⚠️ 回退**不是降级**：它保证"看不懂的原样给你看"，而不是"猜一个给你看"。
//!
//! # 颜色：值替换（`INV-DIAG-02`）
//!
//! `flowmaid` 把颜色**写死**在 SVG 的表现属性里（`fill="#eef1fb"`）。我们不重画，
//! 只做 `#rrggbb → var(--reader-diag-*)` 的**值替换**，`docs/kb/0013` 已实测
//! 「`var()` 写进表现属性」在本机 WKWebView **成立**。
//! ⚠️ 替换表只收**能出现在我们这两条子集里的值**——见 `SWATCHES` 的来历。
//!
//! # 与设计文档的两处**具名偏离**（已写进 §10 实施记录）
//!
//! 1. 变量名用 `--reader-diag-*`，⛔ **不是** §3 表格里随手写的 `var(--rmd-*)`：
//!    `INV-THEME-02` 把语义层的命名冻结成 `--ui-*` / `--reader-*`。
//! 2. 回退出的 `<pre>` **不带 `data-sourcepos`**：适配器只拿到 `&mut dyn fmt::Write`
//!    （它就是 `Context` 本身，拿不到 `options`），⛔ 无法读到 `render.sourcepos`。
//!    代价见 §10。

use std::collections::HashMap;
use std::fmt;

use comrak::adapters::CodefenceRendererAdapter;
use comrak::nodes::Sourcepos;
use comrak::options::{Plugins, RenderPlugins};

use super::highlight::{escape_html_into, PRE_CLASS};

// ─────────────────────────── 规模闸门（§2.3.4）───────────────────────────

/// 单块输入上限。
///
/// ⚠️ 依据是 `docs/kb/0015` 的规模实测（**线性**）：400 节点链 11.7 KB → 168 KB SVG / 4.46 ms。
/// 11.7 KB × 1.4 ≈ 16 KB。⛔ 这是**待实测的初值**，不是测出来的最优值。
pub const MAX_INPUT: usize = 16 * 1024;

/// 节点数上限。⚠️ 400 节点仍能画（4.46 ms），但 SVG 已 168 KB ⇒ 取更保守的值。
pub const MAX_NODES: usize = 256;

/// 边数上限（两个 DSL 共用：flow 的边、sequence 的消息条数）。
pub const MAX_EDGES: usize = 256;

/// 输出 SVG 上限。⚠️ 与 `math.rs` 的 128 KB 同族：超过就说明"这不是给人看的一张图"。
pub const MAX_SVG: usize = 512 * 1024;

// ─────────────────────────── 颜色替换表（INV-DIAG-02）───────────────────────────

/// `flowmaid` 色值 → 我们的语义变量。
///
/// ⭐ **这张表的来历是源码，不是截图**（`design/0007` 规则 1）：
/// `flowmaid-0.27.0/src/style.rs` 的 `shape_style()` 按形状给「底/描边」对，
/// `src/scene.rs` 给边与文字，`src/seq.rs` 给生命线与注释。**我们把能画出的形状收成**：
///
/// | 我们生成的形状 | `flowmaid` 的取值 |
/// |---|---|
/// | `([…])` stadium | `Shape::Stadium` → `#e5f5ea` / `#33a35c` |
/// | `[…]` 矩形 | `Shape::Rect` → `#eef1fb` / `#5b6dc0` |
/// | `[[…]]` 子程序 | `Shape::Subroutine` → `#eef1fb` / `#5b6dc0`（与矩形同值） |
/// | `{…}` 菱形 | `Shape::Diamond` → `#fcf2da` / `#d99114` |
/// | `[/…/]` 平行四边形 | `Shape::Parallelogram` → `#fcf2da` / `#d99114`（与菱形同值） |
/// | 画布底 / 边标签盒 / participant 盒 | `#ffffff` |
/// | 文字 | `TEXT_COLOR = #232840` |
/// | 边与箭头 | `EDGE_COLOR = #44507a` |
/// | 边标签盒的边框 | `LABEL_BORDER = #d5d9ec` |
/// | sequence 生命线 | `GUIDE_COLOR = #aeb6d8` |
/// | sequence 参与者盒（第 n 个取 `ACCENTS[n % 8]`） | `style.rs:82-96` 的 8 色循环 |
///
/// ⚠️ **那 8 个参与者色是 `.wrap` 的**（`style.rs` 的 `accent(index)` 取模）——
/// 参与者一多就会走到 `rose`/`teal`/`violet`/`coral`/`steel` 这五个**不在任何形状里**
/// 的色值。2026-10-14 单测 13 正是靠"第 5 个参与者"抓到表里少了 `#c2588c`
/// （**画出来的图在深色主题下会露出一块刺眼的玫瑰红**，而且不报错）。
/// ⇒ 语料里必须有 ≥8 个参与者，否则这条防线是漏的。
///
/// ⚠️ **`flowmaid` 把同一个值复用在两处**（`#fcf2da`/`#d99114` 既是菱形又是注释块、
/// `#d99114` 又是第 3 个参与者色），所以变量名只能按**色族**取
/// （`green`/`indigo`/`amber`/…），⛔ 不能按"它是哪种形状"取
/// ——一个值只能映射到一个变量，这是**值替换**这条路的固有限制。
/// ⚠️ 反过来说：表里**没有**的色值会原样留下。⚠️ 这**不是**运行时兜底能救的
/// （见到不认识的色就整块回退，等于把"深色下某处颜色不对"换成"图没了"，更糟），
/// 所以它由 §7.2 单测 13「渲染结果里不得残留 `#rrggbb`」当**自动化防线**——
/// 版本已钉死（`=0.27.0`），表一旦漏项测试立刻变红。
/// ⚠️ 反过来也成立：这张表**只许收我们真能画出来的值**（多收无害但会误导）。
const SWATCHES: [(&str, &str); 16] = [
    // —— 场景底色 / 文字 / 边 / 边标签盒（`scene.rs`）——
    ("#ffffff", "--reader-diag-surface"),
    ("#232840", "--reader-diag-text"),
    ("#44507a", "--reader-diag-line"),
    ("#d5d9ec", "--reader-diag-line-soft"),
    // —— 形状色族（`style.rs::shape_style`）——
    ("#e5f5ea", "--reader-diag-green-bg"),
    ("#33a35c", "--reader-diag-green-line"),
    ("#eef1fb", "--reader-diag-indigo-bg"),
    ("#5b6dc0", "--reader-diag-indigo-line"),
    ("#fcf2da", "--reader-diag-amber-bg"),
    ("#d99114", "--reader-diag-amber-line"),
    // —— sequence（`seq.rs` + `style.rs::ACCENTS`）——
    ("#aeb6d8", "--reader-diag-guide"),
    ("#c2588c", "--reader-diag-rose-line"),
    ("#199a8e", "--reader-diag-teal-line"),
    ("#8a5cd6", "--reader-diag-violet-line"),
    ("#d96459", "--reader-diag-coral-line"),
    ("#4d8fbf", "--reader-diag-steel-line"),
];

// ─────────────────────────── 注册进 comrak ───────────────────────────

/// 围栏语言名 → 翻译器。⛔ **只认这两个**：Mermaid 本身是 `vision/0001` 的 V2 项，
/// 语法也不同（`design/0007` §2.3 末尾那句"V2 时几乎免费"就是为此留的）。
const FLOW: &str = "flow";
const SEQUENCE: &str = "sequence";

/// ⭐ 这个围栏语言名是不是**图表**（即"它有自己那一族预算"）。
///
/// ⚠️ 存在理由：`design/0007` Q22 追加节明文「**公式/图表沿用各自预算，
/// 不与高亮输入混算**」⇒ 代码高亮那四条预算**必须**把这两个语言排除掉，
/// 否则一张大图会去吃掉代码高亮的累计额度（反之亦然）。
/// ⛔ 这里的两个名字**必须**与上面两行、以及 `plugins()` 里注册的那两个一致——
/// 所以判据写成本函数而**不是**在 `render.rs` 里再抄一遍字面量。
pub fn is_diagram_fence(lang: &str) -> bool {
    lang == FLOW || lang == SEQUENCE
}

static DIAGRAM: DiagramRenderer = DiagramRenderer;

/// 造一份 `Plugins`：**图表适配器 + 高亮适配器**（`design/0007` §3）。
///
/// ⚠️ 每次调用都新建（两个 `HashMap` 项，可忽略），⛔ 不必 `OnceLock`：
/// 返回值按值给，调用方（`render.rs`）借一次就丢。
pub fn plugins() -> Plugins<'static> {
    let mut codefence_renderers: HashMap<String, &'static dyn CodefenceRendererAdapter> =
        HashMap::new();
    codefence_renderers.insert(FLOW.to_owned(), &DIAGRAM);
    codefence_renderers.insert(SEQUENCE.to_owned(), &DIAGRAM);

    Plugins {
        render: RenderPlugins {
            codefence_renderers,
            // ⚠️ 高亮**不可用**（语法包坏了）时给 `None`：comrak 会走它自己的
            // 默认转义路径，行为与 `design/0002` 一模一样（⛔ 不是"排版全崩"）。
            codefence_syntax_highlighter: super::highlight::highlighter()
                .map(|h| h as &'static dyn comrak::adapters::SyntaxHighlighterAdapter),
            // ⚠️ `RenderPlugins` 还有 `heading_adapter`（标题的自定义渲染）。
            // 本项目**不用**它：标题 ID 由 `toc.rs` 与 comrak 的 `header_id_prefix`
            // 共同定（`INV-TOC-01`），接一个适配器进来会多出第二条 ID 来源。
            ..Default::default()
        },
    }
}

struct DiagramRenderer;

impl CodefenceRendererAdapter for DiagramRenderer {
    fn write(
        &self,
        output: &mut dyn fmt::Write,
        lang: &str,
        _meta: &str,
        code: &str,
        _sourcepos: Option<Sourcepos>,
    ) -> fmt::Result {
        match render(lang, code) {
            Some(html) => output.write_str(&html)?,
            // ⭐ `INV-DIAG-01`：看不懂 / 超限 / 语义冲突 —— 整块回退成代码块。
            None => write_code_block(output, lang, code)?,
        }
        // ⚠️ **这一个换行归适配器**：comrak 在适配器分支里
        //    `context.cr()` 之后就 `return Ok(ChildRendering::HTML)`，
        //    **不写 `lf()`**（源码 `html.rs:513-524`）——适配器自己拥有结尾换行。
        //    ⛔ 漏了它会与下一个块黏成一行。
        // ⚠️ 真的 `lf()` 是"`compact_html` 关着才写"。本项目的 `ParseOpts`
        //    ⛔ 从不设 `compact_html`，由单测 `假设_compact_html_永远关着` 钉住。
        output.write_str("\n")
    }
}

/// 翻译 + 渲染一条龙。`None` = 回退成代码块。
fn render(lang: &str, code: &str) -> Option<String> {
    let mermaid = match lang {
        FLOW => to_mermaid_flow(code).ok()?,
        SEQUENCE => to_mermaid_sequence(code).ok()?,
        // ⛔ 到不了这里（只有这两个键注册过），但别用 `unreachable!()` 换 panic。
        _ => return None,
    };

    // ⚠️ **第二道闸门**：`flowmaid` 只查语法。它 `Err` 就回退，⛔ 不半渲染。
    let svg = flowmaid::render_svg(&mermaid).ok()?;
    if svg.len() > MAX_SVG {
        return None;
    }

    let svg = substitute_colors(&svg);
    let mut html = String::with_capacity(svg.len() + 96);
    html.push_str("<div class=\"rmd-diagram\" data-diagram=\"");
    html.push_str(lang);
    html.push_str("\">");
    html.push_str(&svg);
    html.push_str("</div>");
    Some(html)
}

/// 回退：**转义后**的代码块。
///
/// ⚠️ 手写而不是调 `highlight::highlighter()`：即使语言名恰好撞上某条语法，
/// 回退也应当**逐字**等于"原文"，⛔ 不该多出高亮 span。
/// ⚠️ 结构对齐 comrak 的非适配器路径（`github_pre_lang` 关着 ⇒ `<code class="language-x">`），
/// 唯一差别是**没有 `data-sourcepos`**——原因见本文件头部第 2 条偏离。
fn write_code_block(output: &mut dyn fmt::Write, lang: &str, code: &str) -> fmt::Result {
    output.write_str("<pre class=\"")?;
    output.write_str(PRE_CLASS)?;
    output.write_str("\"><code class=\"language-")?;
    // ⚠️ 语言名来自 info string，理论上含 `"` 就能插出一个属性。
    escape_html_into(output, lang)?;
    output.write_str("\">")?;
    escape_html_into(output, code)?;
    output.write_str("</code></pre>")
}

// ─────────────────────────── 颜色替换 ───────────────────────────

/// 把 SVG 里的 `flowmaid` 色值换成我们的语义变量。
///
/// ⚠️ **只认 `#` + 恰好 6 位十六进制 + 后面不再是标识符字符**。
/// 这一条同时挡住两类非颜色：
/// ① `url(#arrow)` 这类引用（`arrow` 不是 6 位十六进制）；
/// ② 万一将来出现 `#abcdef` 形态的 **id**——后面跟 `)` 之类的字符时不会被换掉。
/// 单测 `替换不动_url_引用` 钉住这一点。
///
/// ⚠️ **取那 6 位时要把 `#` 一起带上**（`SWATCHES` 的键是 `#rrggbb`）。
/// 这里曾经只取 `[i+1..i+7]`，于是 `lookup("44507a")` 永远匹配不上 `"#44507a"`
/// ——**整张色表静默失效**，SVG 里全是 `flowmaid` 的字面色值（2026-10-14 单测抓到）。
fn substitute_colors(svg: &str) -> String {
    let mut out = String::with_capacity(svg.len() + svg.len() / 32);
    let b = svg.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'#' {
            // ⚠️ `get(..)` 而不是切片：`i + 7` 可能落在多字节字符中间（那样会 panic），
            //    也可能越界。`#` 本身是 ASCII，所以 `i` 一定在字符边界上。
            if let Some(hex) = svg.get(i..i + 7) {
                let tail = b.get(i + 7).copied();
                if hex.as_bytes()[1..].iter().all(|c| c.is_ascii_hexdigit())
                    && tail.is_none_or(|t| !is_ident_byte(t))
                {
                    if let Some(var) = lookup(&hex.to_ascii_lowercase()) {
                        out.push_str("var(");
                        out.push_str(var);
                        out.push(')');
                        i += 7;
                        continue;
                    }
                }
            }
        }
        // ⚠️ 按 UTF-8 字符推进（`#` 的 ASCII 判定在非 ASCII 首字节上为 false）。
        let n = utf8_len(b[i]);
        out.push_str(&svg[i..i + n]);
        i += n;
    }
    out
}

/// ⚠️ 查找是**线性扫 16 项**：每条 SVG 里色值出现几十次，16 次字符串比较可忽略
/// （整块 SVG 本来就只有几 KB）。⛔ 不必为它建 `HashMap`/`phf`。
fn lookup(hex_lower: &str) -> Option<&'static str> {
    SWATCHES.iter().find(|(k, _)| *k == hex_lower).map(|(_, v)| *v)
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

// ─────────────────────────── 回退原因 ───────────────────────────

/// 为什么回退。⛔ 用户看不到它（看到的是代码块），它的用途是**让单测精确**
/// 与让 §10 的记录能说清"哪一类被挡下来了"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    /// 输入超 16 KB。
    TooLarge,
    /// 空块。
    Empty,
    /// 节点数 / 边数超限。
    TooMany,
    /// 同一个 id 定义两次（`flowmaid` 会静默 last-wins）。
    DuplicateDefinition,
    /// 连接里引用了未定义的 id。
    UndefinedReference,
    /// 同一节点的同一个槽位被连了两次（`flowmaid` 会画成两条边，语义就变了）。
    ConflictingEdge,
    /// `condition` 的分支不是 `yes`/`no`，或非 `condition` 带了分支说明。
    BadBranch,
    /// 定义了但一条连接都没用上（`flowchart.js` 里它是**画不出来**的）。
    OrphanNode,
    /// 标签含 `]` 或换行（Mermaid 标签里没有这两种写法，§2.3.2）。
    BadLabel,
    /// 两个 DSL 都不支持、且没有干净等价的构造（`parallel` / `|flowstate` / `:$` /
    /// `@>` / `>>` 箭头 / `title`）。
    Unsupported,
    /// 别处不认识。
    BadSyntax,
}

type Res<T> = Result<T, Reject>;

// ─────────────────────────── flowchart.js → Mermaid ───────────────────────────

/// ` ```flow ` → `flowchart TD` 那份 Mermaid 源码。
///
/// ⭐ 判据是 `design/0007` §2.3.3 里那段**逐字的预期输出**，单测直接比字符串。
pub fn to_mermaid_flow(src: &str) -> Res<String> {
    if src.len() > MAX_INPUT {
        return Err(Reject::TooLarge);
    }
    // ⚠️ 先归一换行：CRLF 会在行尾留下 `\r`，而"标签含换行"是回退条件之一，
    //    归一之后 `\r\n` 才不会把一整块无辜的图打成回退。
    let src = normalize_newlines(src);
    let src = src.trim();
    if src.is_empty() {
        return Err(Reject::Empty);
    }
    // ⛔ 行续接（flowchart.js 的 `\` + 换行合并）不支持：它能把一行变成任意长的
    //    多行定义，而我们按行判定的一切都会失去意义。
    if src.contains("\\\n") {
        return Err(Reject::BadSyntax);
    }
    // ⛔ `a@>b({"stroke":"Red"})` 整块回退（§2.3.1(b)）：它带**字面色值**，
    //    正是 `INV-THEME-02` 要挡的东西，而且我们没有等价的线型表达。
    if src.contains("@>") {
        return Err(Reject::Unsupported);
    }

    // ① 行合并 —— ⚠️ **与 flowchart.js 同语义**：不含 `->`/`=>` 的行并进上一行，
    //    用 `\n` 连接（`flowchart.parse.js:151-161`）。基准那段中间的空行就靠这条
    //    消化掉，所以这一步⛔ 不能省。
    let mut lines: Vec<String> = src.split('\n').map(str::to_owned).collect();
    let mut l = 1;
    while l < lines.len() {
        let cur = &lines[l];
        if !cur.contains("->") && !cur.contains("=>") {
            lines[l - 1] = format!("{}\n{}", lines[l - 1], cur);
            lines.remove(l);
        } else {
            l += 1;
        }
    }

    // ② 定义与连接分开收
    let mut nodes: Vec<Node> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut conns: Vec<&str> = Vec::new();
    for raw in &lines {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        // ⚠️ 顺序与 flowchart.js 一致：**先认 `=>`**（两边都有的行按定义算）。
        if line.contains("=>") {
            define(line, &mut nodes, &mut index)?;
        } else {
            conns.push(line);
        }
    }
    if nodes.is_empty() || conns.is_empty() {
        return Err(Reject::BadSyntax);
    }

    // ③ 连接：解析 → 查引用 → 定槽位 → 分配编号
    let mut parsed: Vec<Vec<(usize, Option<&str>)>> = Vec::new();
    let mut slots: Vec<HashMap<Slot, usize>> = vec![HashMap::new(); nodes.len()];
    let mut edges = 0usize;
    for line in &conns {
        let toks = parse_chain(line, &index)?;
        for w in 0..toks.len() - 1 {
            let (from, spec) = toks[w];
            let to = toks[w + 1].0;
            let branch = resolve_spec(nodes[from].shape, spec)?.unwrap_or(Branch::Plain);
            if slots[from].insert(branch.slot(), to).is_some() {
                // ⚠️ `flowmaid` 会把两条边都画出来，而 `flowchart.js` 只留最后一条
                //    ——两种结果都不是"用户写的那个"，所以⛔ 回退。
                return Err(Reject::ConflictingEdge);
            }
            // `flowchart.js` 的 `constructChart`：`next` 只在没有 yes/no 时才走。
            if nodes[from].shape == Shape::Diamond
                && slots[from].contains_key(&Slot::Next)
                && (slots[from].contains_key(&Slot::Yes) || slots[from].contains_key(&Slot::No))
            {
                return Err(Reject::ConflictingEdge);
            }
            edges += 1;
            if edges > MAX_EDGES {
                return Err(Reject::TooMany);
            }
        }
        // ⚠️ 链尾 token 上的说明：`flowchart.js` 会**静默忽略**它（`iS+1 < lenS` 不成立）。
        //    "静默忽略"正是本模块要挡的形态 ⇒ 回退。
        if toks.last().is_some_and(|(_, s)| s.is_some()) {
            return Err(Reject::BadBranch);
        }
        parsed.push(toks);
    }

    // ⭐ 编号按**连接里的首次出现顺序**分配（`design/0007` §2.3.2 的 `n0`/`n1`…）。
    //    ⚠️ 与"定义顺序"**不是一回事**：`BASE_FLOW` 里 `e=>end` 定义在第二条，
    //    但它在连接里最后才出现 ⇒ `n3`（§2.3.3 的预期输出就是这条的判据）。
    //    ⚠️ 分配顺序与下面的出图顺序**是同一个遍历**——这正是
    //    `flowchart.js` 的 `chart.start`（第一条连接的第一个 token）那套语义。
    let mut rank: Vec<Option<usize>> = vec![None; nodes.len()];
    let mut next_rank = 0usize;
    for toks in &parsed {
        for (idx, _) in toks {
            if rank[*idx].is_none() {
                rank[*idx] = Some(next_rank);
                next_rank += 1;
            }
        }
    }
    // ⭐ 定义了却没被任何连接引用 ⇒ `flowchart.js` **画不出来**（它只从 `start`
    //    出发走一遍），静默丢一个节点是我们最不想要的形态 ⇒ 回退。
    //    ⚠️ 判据就用上面那份编号表：`None` = 一次都没出现过。⛔ 不再另存一个
    //    `referenced` 布尔（那就是同一件事的第二个真值）。
    if rank.iter().any(Option::is_none) {
        return Err(Reject::OrphanNode);
    }
    // ⚠️ 既然上面已经排除过 `None`，`flatten` 出来的长度**必然**等于 `nodes.len()`，
    //    且下标一一对应——出图时可以直接 `rank[idx]` 取值，不必再处理 `Option`
    //    （渲染路径上一个 `expect` 都不留）。
    let rank: Vec<usize> = rank.into_iter().flatten().collect();

    // ④ 出 Mermaid 源
    let mut out = String::from("flowchart TD\n");
    let mut described = vec![false; nodes.len()];
    for toks in &parsed {
        for w in 0..toks.len() - 1 {
            let (from, spec) = toks[w];
            let to = toks[w + 1].0;
            out.push_str("    ");
            out.push_str(&node_ref(from, &rank, &nodes, &mut described));
            out.push_str(" -->");
            if let Some(b) = resolve_spec(nodes[from].shape, spec)? {
                out.push('|');
                out.push_str(b.label());
                out.push('|');
            }
            out.push(' ');
            out.push_str(&node_ref(to, &rank, &nodes, &mut described));
            out.push('\n');
        }
    }
    Ok(out)
}

/// 一个已定义的节点。
struct Node {
    shape: Shape,
    label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// `([文字])` —— `start` / `end`。
    Stadium,
    /// `[文字]` —— `operation`。
    Rect,
    /// `{文字}` —— `condition`。
    Diamond,
    /// `[/文字/]` —— `input` / `output` / `inputoutput`。
    Parallelogram,
    /// `[[文字]]` —— `subroutine`。
    Subroutine,
}

impl Shape {
    /// 这个形状在 Mermaid 里的写法。
    fn wrap(self, label: &str) -> String {
        match self {
            Shape::Stadium => format!("([{label}])"),
            Shape::Rect => format!("[{label}]"),
            Shape::Diamond => format!("{{{label}}}"),
            Shape::Parallelogram => format!("[/{label}/]"),
            Shape::Subroutine => format!("[[{label}]]"),
        }
    }
}

/// 一个节点的引用（连到谁），具体怎么引用由 `described` 决定。
///
/// ⚠️ `rank[下标]` 是**显示编号**（按连接里的首次出现顺序排的，见 `to_mermaid_flow` ③），
/// ⛔ 不是定义下标——两者在"定义顺序 ≠ 连接顺序"的图上不一样（`BASE_FLOW` 就是）。
fn node_ref(idx: usize, rank: &[usize], nodes: &[Node], described: &mut [bool]) -> String {
    let n = rank[idx];
    if described[idx] {
        return format!("n{n}");
    }
    described[idx] = true;
    format!("n{n}{}", nodes[idx].shape.wrap(&nodes[idx].label))
}

/// 一条边上的说明。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Branch {
    /// 普通边（`flowchart.js` 里的 `next` 槽）。
    Plain,
    /// `condition` 的 yes 支。
    Yes,
    /// `condition` 的 no 支。
    No,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Slot {
    Next,
    Yes,
    No,
}

impl Branch {
    fn slot(self) -> Slot {
        match self {
            Branch::Plain => Slot::Next,
            Branch::Yes => Slot::Yes,
            Branch::No => Slot::No,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Branch::Plain => "",
            Branch::Yes => "yes",
            Branch::No => "no",
        }
    }
}

/// `id=>type: 文字[|flowstate][:>url]` 一行。
fn define(line: &str, nodes: &mut Vec<Node>, index: &mut HashMap<String, usize>) -> Res<()> {
    let (lhs, rest) = line.split_once("=>").ok_or(Reject::BadSyntax)?;

    // ⛔ 逐节点的绘制参数（`id(line-length=100,align-next=no)`）：V1 不猜它想表达什么。
    if lhs.contains('(') {
        return Err(Reject::Unsupported);
    }
    let key = lhs.trim();
    if key.is_empty() || key.contains("->") || key.contains('|') {
        return Err(Reject::BadSyntax);
    }
    if index.contains_key(key) {
        return Err(Reject::DuplicateDefinition);
    }

    // ⛔ `:$函数`：`flowchart.js` 会去调一个外部函数，我们没有等价物。
    if rest.contains(":$") {
        return Err(Reject::Unsupported);
    }
    // ⭐ `:>url[target]` **显式剥掉**（§2.3.1(a)）：它是个可点链接，
    //    而"点链接该做什么"至今没有定义（`bugs/0001` Q17），且它是 `javascript:` 的开口子。
    //    ⚠️ 与 `:$` 不同：这里**剥**不**拒**——链接不影响图形语义。
    let rest = match rest.find(":>") {
        Some(i) => &rest[..i],
        None => rest,
    };

    // ⭐ 切分口径**逐字照 `flowchart.js`**（`flowchart.parse.js:232-236`）：
    //    `split(': ')` + 取 `[0]` 当类型、**其余重新 `join(': ')`** 当文字。
    //    ⇒ ① 分隔符是 **`": "`（冒号 + 空格）**，⛔ 不是单独的冒号——
    //          `a=>start:`（无空格）在 `flowchart.js` 里类型就是 `"start:"`，
    //          落进 `drawSVG` 的 `switch` 会命中 `default: new Error('Wrong symbol type!')`
    //          （`flowchart.parse.js:56`）⇒ 我们**跟随它拒绝**（`BadSyntax`），
    //          ⛔ 不自己发明"空标签 ⇒ 用默认文字"那条（那只对**没有冒号**的情形成立）。
    //       ② `join` 会把后面每一个 `": "` **原样接回去** ⇒ 文字里可以含 `": "`：
    //          `a=>operation: 时间: 12` 的文字是 `时间: 12`，⛔ 不是被切到一半的 `12`。
    let (ty, text) = match rest.find(": ") {
        Some(i) => (&rest[..i], &rest[i + 2..]),
        None => (rest, ""),
    };
    let ty = ty.trim();

    // ⛔ `|flowstate`（`flowchart.js` 的"审批态"：`文字|approved`）。
    //    它把 `|` 前当文字、`|` 后当状态（`flowchart.parse.js:285-293`），
    //    而 Mermaid 里没有对应物 ⇒ 整块回退。⚠️ 判据落在**文字**上（那时 `:$`/`:>`
    //    已经剥过了，与 `flowchart.js` 的先后顺序一致）。
    if text.contains('|') {
        return Err(Reject::Unsupported);
    }

    let shape = match ty {
        "start" | "end" => Shape::Stadium,
        "operation" => Shape::Rect,
        "condition" => Shape::Diamond,
        "input" | "output" | "inputoutput" => Shape::Parallelogram,
        "subroutine" => Shape::Subroutine,
        // ⛔ Mermaid 里没有"并行分叉"这个形状（§2.3.1(a)）。
        "parallel" => return Err(Reject::Unsupported),
        _ => return Err(Reject::BadSyntax),
    };

    // ⭐ `end` 的默认文字是 `End`、`start` 是 `Start`（一手：`flowchart.symbol.{start,end}.js`
    //    的 `options.text || 'Start'` / `'End'`）⇒ ⛔ 不许自己发明空节点。
    let label = if text.is_empty() {
        match ty {
            "start" => "Start",
            "end" => "End",
            _ => "",
        }
    } else {
        text
    };

    // ⛔ 标签里挡两个字符（§2.3.2）：`]`（Mermaid 没有 `\]` 这种转义）与换行
    //    （`flowmaid` 会把 `<br/>` 转义成可见文字 ⇒ 表达不出来）。
    //    ⚠️ `<` `>` `&` `"` `'` **直传**，转义归 `flowmaid`，由单测 `标签里的尖括号直传` 钉住。
    if label.contains(']') || label.contains('\n') {
        return Err(Reject::BadLabel);
    }

    index.insert(key.to_owned(), nodes.len());
    nodes.push(Node { shape, label: label.to_owned() });
    if nodes.len() > MAX_NODES {
        return Err(Reject::TooMany);
    }
    Ok(())
}

/// `a->b->c` 一行 → 每个 token 的 `(节点序号, 该 token 上的说明)`。
///
/// ⚠️ 这里的"节点序号"是**定义下标**（`index` 里的那个），⛔ 不是最终显示的那个 `n{…}`
/// ——显示编号按连接里的首次出现顺序另算（`to_mermaid_flow` ③）。两者分开是因为
/// `parse_chain` 只看得见一行，而"首次出现"要跨行看全。
fn parse_chain<'a>(
    line: &'a str,
    index: &HashMap<String, usize>,
) -> Res<Vec<(usize, Option<&'a str>)>> {
    let raw: Vec<&str> = line.split("->").collect();
    if raw.len() < 2 {
        return Err(Reject::BadSyntax);
    }
    let mut out = Vec::with_capacity(raw.len());
    for tok in raw {
        let tok = tok.trim();
        if tok.is_empty() {
            return Err(Reject::BadSyntax);
        }
        let (key, spec) = match tok.find('(') {
            Some(i) => {
                let close = tok[i + 1..]
                    .find(')')
                    .map(|c| i + 1 + c)
                    .ok_or(Reject::BadSyntax)?;
                // ⚠️ `)` 之后再有东西（`cond(yes)x`）我们**严格拒绝**：`flowchart.js`
                //    会静默丢掉它，而"静默丢东西"是本模块要挡的那一类。
                if !tok[close + 1..].trim().is_empty() {
                    return Err(Reject::BadSyntax);
                }
                (tok[..i].trim(), Some(tok[i + 1..close].trim()))
            }
            None => (tok, None),
        };
        let idx = *index.get(key).ok_or(Reject::UndefinedReference)?;
        // ⚠️ `a()->b` 的空说明等于"没有说明"（`flowchart.js` 的 `getSymbValue` 给 `""`）。
        let spec = spec.filter(|s| !s.is_empty());
        out.push((idx, spec));
    }
    Ok(out)
}

/// 一个 token 上的 `(…)` 说明 → 这条边的分支标签。
///
/// ⚠️ 严格**按源节点的形状**判（`design/0007` §2.3.4）：
///
/// - `condition`：只认 `yes`/`no`（外加 `flowchart.js` 一手的 `true`/`false` 映射）。
///   ⛔ 别的写法在 `flowchart.js` 里会**变成普通边**（`getNextPath` 把非 yes/no 的
///   说明归到 `next`），也就是"用户以为分了支、其实没分"——必须回退。
/// - 非 `condition`：`(yes)` 在 `flowchart.js` 里是个永远画不出来的属性 ⇒ 回退。
///   只接受**方向提示** `right`/`left`/`top`/`bottom`，且⭐ **丢掉并逐条记录**
///   （§2.3.1(b)：它只影响排版，不影响"谁连谁"）。
fn resolve_spec(shape: Shape, spec: Option<&str>) -> Res<Option<Branch>> {
    let Some(spec) = spec else {
        return Ok(None);
    };
    // ⛔ `cond(true@自定义名)` 一行：`@` 是自定义分支名，V1 只认 yes/no（§2.3.1(b)）。
    if spec.contains('@') {
        return Err(Reject::Unsupported);
    }
    // `(next, right)` / `(yes, right)`：逗号前是槽位、逗号后是方向。
    let (head, dir) = match spec.split_once(',') {
        Some((a, b)) => {
            // ⚠️ `flowchart.js` 只取 `[1]`，第三个会被静默丢掉 ⇒ 我们严格拒绝。
            if b.contains(',') {
                return Err(Reject::BadSyntax);
            }
            (a.trim(), Some(b.trim()))
        }
        None => (spec, None),
    };
    if let Some(d) = dir {
        if !is_direction(d) {
            return Err(Reject::Unsupported);
        }
    }
    // ⭐ `flowchart.js` 一手的映射：`true`/`false` 就是 `yes`/`no`
    //    （`flowchart.parse.js:308-312`）——⚠️ 只在该 token 的说明**没有逗号**时成立。
    let head = if dir.is_none() {
        match head {
            "true" => "yes",
            "false" => "no",
            other => other,
        }
    } else {
        head
    };

    match shape {
        Shape::Diamond => match head {
            "yes" => Ok(Some(Branch::Yes)),
            "no" => Ok(Some(Branch::No)),
            _ => Err(Reject::BadBranch),
        },
        _ => {
            if is_direction(head) {
                // ⭐ 丢方向：只影响排版。⚠️ 记录在案，⛔ 不当成"等价"。
                Ok(None)
            } else {
                Err(Reject::BadBranch)
            }
        }
    }
}

/// `flowchart.js` 认的方向词（源码里出现过的四个：`symbol.js` / `condition.js` / `parallel.js`）。
fn is_direction(s: &str) -> bool {
    matches!(s, "right" | "left" | "top" | "bottom")
}

fn normalize_newlines(src: &str) -> String {
    if !src.contains('\r') {
        return src.to_owned();
    }
    src.replace("\r\n", "\n").replace('\r', "\n")
}

// ─────────────────────────── js-sequence-diagrams → Mermaid ───────────────────────────

/// ` ```sequence ` → `sequenceDiagram` 那份 Mermaid 源码。
///
/// ⭐ 一手文法（`bramp/js-sequence-diagrams` 的 `src/grammar.ebnf`，`design/0007` §2.3.1(c)）：
///
/// ```text
/// statement ::= 'title' ':'? message
///             | 'participant' actor ('as' alias)?
///             | 'note' ( ('left of' | 'right of') actor
///                      | 'over' (actor | actor ',' actor) ) ':' message
///             | actor ( '-' | '--' ) ( '>' | '>>' )? actor ':' message
/// actor     ::= [^\->:\n,]+
/// ```
///
/// ⚠️ **两个库的箭头写法不对齐**（评审 R2 点破的那条陷阱）：
/// js-sequence-diagrams 的 `->` **已经带实心头**，`>>` 是**另一种**箭头；
/// Mermaid 的 `->` **没有箭头**、`->>` 才带。⇒ 逐字照搬会**静默丢箭头**。
/// 这一层做的就是把三种源写法**位移**到 Mermaid 的对应写法。
///
/// ⚠️ `title` 与 `>>` 一律**整块回退**：前者 `flowmaid` 的 sequence 解析器里
/// **不在支持列表**（`strip_keyword(line,"title")` 只对 pie/journey/state 生效），
/// 落下去必然 `Err`；后者在 Mermaid 里没有干净等价（§2.3.1(c)）。
pub fn to_mermaid_sequence(src: &str) -> Res<String> {
    if src.len() > MAX_INPUT {
        return Err(Reject::TooLarge);
    }
    let src = normalize_newlines(src);
    let src = src.trim();
    if src.is_empty() {
        return Err(Reject::Empty);
    }

    let mut out = String::from("sequenceDiagram\n");
    let mut messages = 0usize;
    for raw in src.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }

        // ⛔ `title`：`flowmaid` 的 sequence 不支持（会 `Err`），Mermaid 的标题语法
        //    又是"另一个话题"（§2.3.1(c) 的 ⚠️ 待确认 ⇒ 不确定就整块回退）。
        if keyword(line, "title").is_some() {
            return Err(Reject::Unsupported);
        }
        // ✅ `note` 与 `participant` **逐字相同**（位置与别名都是内容）。
        //    ⚠️ 这里**不做深度校验**：形状不对时 `flowmaid` 会出声（第二道闸门），
        //    两道路径的可视结果一样（都是回退成代码块），而多一处校验就多一处误拒。
        if keyword(line, "note").is_some() || keyword(line, "participant").is_some() {
            out.push_str("    ");
            out.push_str(line);
            out.push('\n');
            continue;
        }
        // ⛔ `actor`：`grammar.ebnf` 里**没有**这个关键词（只有 `participant`），
        //    它的 `actor` 是"参与者名"那个非终结符，不是关键字。落到消息解析里
        //    也一定失败 ⇒ 显式拒绝，好在记录里说清楚是哪一类。

        // message：`A (-|--) (>|>>)? B : text`
        let m = parse_message(line)?;
        out.push_str("    ");
        out.push_str(&m.from);
        // ⚠️ **`m.tail` 是整条箭头**（`->` / `->>` / `-->` / `-->>`），⛔ 这里不许再补一个 `->`。
        //    曾经写成 `push_str("->")` + `push_str(m.tail)`，于是 `A->B` 变成
        //    `A->->>B`（2026-10-14 由单测 `四种箭头写法各自位移` 抓到）。
        out.push_str(m.tail);
        out.push_str(&m.to);
        out.push_str(": ");
        out.push_str(&m.text);
        out.push('\n');
        messages += 1;
        if messages > MAX_EDGES {
            return Err(Reject::TooMany);
        }
    }
    if messages == 0 {
        return Err(Reject::BadSyntax);
    }
    Ok(out)
}

/// 一条已位移到 Mermaid 语义的消息。
struct Message {
    from: String,
    /// 箭头尾巴：`->`（无头）/ `->>`（实心头）/ `-->`（虚线无头）/ `-->>`（虚线实心头）。
    tail: &'static str,
    to: String,
    text: String,
}

/// `A->B: text` → 一条 [`Message`]。
///
/// 返回值里的 `tail` 是**已经位移到 Mermaid 语义**的那一段：
///
/// | 源 | 语义 | Mermaid |
/// |---|---|---|
/// | `A-B` | 实线、无头 | `A->B` |
/// | `A->B` | 实线、**实心头** | `A->>B` |
/// | `A--B` | 虚线、无头 | `A-->B` |
/// | `A-->B` | 虚线、实心头 | `A-->>B` |
fn parse_message(line: &str) -> Res<Message> {
    let colon = line.find(':').ok_or(Reject::BadSyntax)?;
    let head = line[..colon].trim();
    let text = line[colon + 1..].trim();

    // `actor ::= [^\->:\n,]+` ⇒ 左端不含 `-`，第一个 `-` 就是运算符的起点。
    let dash = head.find('-').ok_or(Reject::BadSyntax)?;
    let from = head[..dash].trim();
    if from.is_empty() || from.contains('>') || from.contains(':') || from.contains(',') {
        return Err(Reject::BadSyntax);
    }

    let rest = &head[dash..];
    let dashes = rest.bytes().take_while(|b| *b == b'-').count();
    let rest = &rest[dashes..];
    let heads = rest.bytes().take_while(|b| *b == b'>').count();
    let to = rest[heads..].trim();
    if to.is_empty() || to.contains('-') || to.contains('>') || to.contains(':') || to.contains(',')
    {
        return Err(Reject::BadSyntax);
    }

    let tail = match (dashes, heads) {
        (1, 0) => "->",
        (1, 1) => "->>",
        (2, 0) => "-->",
        (2, 1) => "-->>",
        // ⛔ `>>` = 空心头，Mermaid 的 `-)` 是 async，不是同一件事（§2.3.1(c)）。
        (_, 2) => return Err(Reject::Unsupported),
        _ => return Err(Reject::BadSyntax),
    };
    Ok(Message { from: from.to_owned(), tail, to: to.to_owned(), text: text.to_owned() })
}

/// 行首关键词（大小写不敏感，后面必须是空白、`:` 或行尾）。
///
/// ⚠️ 与 `flowmaid` 的 `strip_keyword` 同一套判据——⛔ 别用 `starts_with`：
/// `notebook->x: y` 里的 `note` 不是关键词。
fn keyword<'a>(line: &'a str, kw: &str) -> Option<&'a str> {
    let head = line.get(..kw.len())?;
    if !head.eq_ignore_ascii_case(kw) {
        return None;
    }
    let rest = &line[kw.len()..];
    if rest.is_empty() || rest.starts_with([' ', '\t', ':']) {
        Some(rest.trim_start())
    } else {
        None
    }
}

// ─────────────────────────── 单测 ───────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::parser::ParseOpts;

    /// `design/0007` §2.3.3 的基准源（`mark_feixiang.md:48-54`）。
    const BASE_FLOW: &str = "st=>start: Start\ne=>end\nop=>operation: My Operation\ncond=>condition: Yes or No?\n\nst->op->cond\ncond(yes)->e\ncond(no)->op";

    /// `design/0007` §2.3.3 的**预期 Mermaid 源**（逐字）。
    const EXPECT_FLOW: &str = "flowchart TD\n    n0([Start]) --> n1[My Operation]\n    n1 --> n2{Yes or No?}\n    n2 -->|yes| n3([End])\n    n2 -->|no| n1\n";

    /// `design/0007` §2.3.3 的基准源（`mark_feixiang.md:60-64`）。
    const BASE_SEQ: &str =
        "Alice->Bob: Hello Bob, how are you?\nNote right of Bob: Bob thinks\nBob-->Alice: I am good thanks!";

    /// `design/0007` §2.3.3 的**预期 Mermaid 源**（逐字）。
    const EXPECT_SEQ: &str = "sequenceDiagram\n    Alice->>Bob: Hello Bob, how are you?\n    Note right of Bob: Bob thinks\n    Bob-->>Alice: I am good thanks!\n";

    /// ⭐ `design/0007` §2.3.3 的 ①–⑤：节点集合、文字、形状写法、边方向、`yes`/`no` 落在正确的边上。
    #[test]
    fn 基准的_flow_块逐字等于设计里的预期() {
        assert_eq!(to_mermaid_flow(BASE_FLOW).unwrap(), EXPECT_FLOW);
    }

    /// ⭐ `design/0007` §2.3.3 的 ⑥ 的**文本侧**：`->`→`->>`、`-->`→`-->>` 的位移。
    /// （"虚线 + 有箭头"的**像素侧**判据在 `渲染出的_SVG_里回信是虚线带箭头` 那条。）
    #[test]
    fn 基准的_sequence_块逐字等于设计里的预期() {
        assert_eq!(to_mermaid_sequence(BASE_SEQ).unwrap(), EXPECT_SEQ);
    }

    /// 形状映射逐项（§2.3.1(a) 的表）。
    #[test]
    fn 形状映射逐项() {
        let src = "a=>start: S\nb=>end: E\nc=>operation: O\nd=>input: I\ne=>output: O2\nf=>inputoutput: IO\ng=>subroutine: SR\nh=>condition: C\na->b\nb->c\nc->d\nd->e\ne->f\nf->g\ng->h\nh->c";
        let out = to_mermaid_flow(src).unwrap();
        for needle in [
            "([S])", "([E])", "[O]", "[/I/]", "[/O2/]", "[/IO/]", "[[SR]]", "{C}",
        ] {
            assert!(out.contains(needle), "缺少形状 {needle}\n{out}");
        }
        assert_eq!(out.matches("-->\n").count(), 0, "每条边都该有目标\n{out}");
    }

    /// ⭐ ⚠️ **无标签的 `start`/`end` 用默认文字**（⛔ 不是空节点）——一手依据：
    /// `flowchart.symbol.start.js` / `.end.js` 的 `options.text = options.text || 'Start' | 'End'`。
    ///
    /// ⚠️ **"没标签"只有一种写法**：`a=>start`（**整个冒号都不写**）。
    /// 写成 `a=>start:` 或 `a=>start: ` 是**另一件事**：`flowchart.parse.js:232-236`
    /// 的分隔符是 **`": "`（冒号 + 空格）**，而每一行进来先 `line.trim()`
    /// （`flowchart.parse.js:217`）⇒ 尾空格被吃掉 ⇒ `symbolType = "start:"`，
    /// 落进 `drawSVG` 的 `switch` 命中 `default: return new Error('Wrong symbol type!')`
    /// （`flowchart.parse.js:56`）——**它连图都画不出来**，⛔ 不是"用默认文字"。
    /// ⇒ 我们跟随它**拒绝**（回退成代码块）。⚠️ 这条曾经被写反过（2026-10-14）：
    /// 当时断言 `a=>start: ` 也得到 `Start`，那是把 `||` 的适用范围**放大**了。
    #[test]
    fn 无标签的_start_end_用默认文字() {
        let out = to_mermaid_flow("a=>start\nb=>end\na->b").unwrap();
        assert!(out.contains("n0([Start])"), "{out}");
        assert!(out.contains("n1([End])"), "{out}");

        // ⚠️ 逐字对照：`ty` 变成 `"start:"` ⇒ 未知形状 ⇒ 拒绝（不是"默认文字"）。
        assert_eq!(to_mermaid_flow("a=>start: \nb=>end\na->b"), Err(Reject::BadSyntax));
        assert_eq!(to_mermaid_flow("a=>end:\nb=>operation: y\na->b"), Err(Reject::BadSyntax));

        // ⚠️ 但**别的类型**本来就不给默认文字（`flowchart.js` 里只有 start/end 有 `||`）
        //    ⇒ `a=>operation` 是一个空标签的矩形，⛔ 不许我们凭空造一个词。
        let out = to_mermaid_flow("a=>operation\nb=>operation: y\na->b").unwrap();
        assert!(out.contains("n0[] --> n1[y]"), "{out}");
    }

    /// ⭐ 标识符按**首次出现顺序**重新分配（§2.3.3 的预期输出就是这条的判据：
    /// `e` 虽然定义在第二个，但它在连接里最后才出现 ⇒ `n3`）。
    #[test]
    fn 标识符按连接里的首次出现顺序重排() {
        let out = to_mermaid_flow(BASE_FLOW).unwrap();
        assert!(out.contains("n3([End])"), "{out}");
    }

    /// ⭐ §2.3.2：标签**只挡 `]` 与换行**。
    #[test]
    fn 标签只挡右方括号与换行() {
        assert_eq!(
            to_mermaid_flow("a=>operation: 有 ] 的标签\nb=>operation: x\na->b"),
            Err(Reject::BadLabel)
        );
        // `flowchart.js` 允许多行标签（靠 `\n` 合并），Mermaid 表达不出来 ⇒ 回退。
        assert_eq!(
            to_mermaid_flow("a=>operation: 第一行\n第二行\nb=>operation: x\na->b"),
            Err(Reject::BadLabel)
        );
    }

    /// ⭐ §2.3.2：`<` `>` `&` `"` `'` **直传**，转义归 `flowmaid`。
    /// ⚠️ 这条是**依赖上游实现细节**的回归（`docs/kb/0015` ③ 的 9 例），
    /// 判据是"`<text>` 里没有**真标签**"，⛔ 不是"字符串里没有 `<`"。
    #[test]
    fn 标签里的尖括号直传且被_flowmaid_转义() {
        let src = "a=>operation: <script>alert(1)</script>\nb=>operation: x\na->b";
        let mermaid = to_mermaid_flow(src).unwrap();
        assert!(
            mermaid.contains("<script>"),
            "翻译层应当直传（转义是上游的事）：{mermaid}"
        );
        let svg = flowmaid::render_svg(&mermaid).expect("flowmaid 应当照常接受");
        assert!(!svg.contains("<script>"), "⛔ 出现了真标签：\n{svg}");
        assert!(svg.contains("&lt;script&gt;"), "应当被转义成可见文字\n{svg}");
    }

    /// ⭐ §2.3.4：语义冲突**必须由第一道闸门挡**（`flowmaid` 会静默 last-wins / 隐式建点）。
    #[test]
    fn 语义冲突都整块回退() {
        // 同一个 id 定义两次。
        assert_eq!(
            to_mermaid_flow("a=>operation: 甲\nb=>operation: x\na=>operation: 丙\na->b"),
            Err(Reject::DuplicateDefinition)
        );
        // 引用未定义的 id。
        assert_eq!(
            to_mermaid_flow("a=>operation: x\na->b"),
            Err(Reject::UndefinedReference)
        );
        // `condition` 的分支不是 yes/no（⚠️ `flowchart.js` 会把它变成**普通边**）。
        assert_eq!(
            to_mermaid_flow("a=>condition: x\nb=>operation: y\na(right)->b\nc=>operation: z\nb->c"),
            Err(Reject::BadBranch)
        );
        // 非 `condition` 带了分支说明。
        assert_eq!(
            to_mermaid_flow("a=>operation: x\nb=>operation: y\na(yes)->b"),
            Err(Reject::BadBranch)
        );
        // 同一槽位两条边（`flowchart.js` 只留最后一条，Mermaid 会画两条）。
        assert_eq!(
            to_mermaid_flow("a=>operation: x\nb=>operation: y\nc=>operation: z\na->b\na->c"),
            Err(Reject::ConflictingEdge)
        );
        // `condition` 既有 `next` 又有分支（`flowchart.js` 里 `next` 走不到）。
        assert_eq!(
            to_mermaid_flow(
                "a=>condition: x\nb=>operation: y\nc=>operation: z\na->b\na(yes)->c\nb->c"
            ),
            Err(Reject::ConflictingEdge)
        );
        // 定义了却没用上（`flowchart.js` 静默不画）。
        assert_eq!(
            to_mermaid_flow("a=>operation: x\nb=>operation: y\nc=>operation: 孤儿\na->b"),
            Err(Reject::OrphanNode)
        );
        // 链尾 token 上的说明会被 `flowchart.js` 静默忽略。
        assert_eq!(
            to_mermaid_flow("a=>condition: x\nb=>operation: y\na(yes)->b(no)"),
            Err(Reject::BadBranch)
        );
    }

    /// ⛔ 没有干净等价的构造一律整块回退（§2.3.1 的四个 ⛔ 加 `title`）。
    #[test]
    fn 不支持构造整块回退() {
        // `parallel` 没有等价形状。
        assert_eq!(
            to_mermaid_flow("a=>parallel: x\nb=>operation: y\na->b"),
            Err(Reject::Unsupported)
        );
        // `|flowstate`（`flowchart.js` 的附加样式态）。
        assert_eq!(
            to_mermaid_flow("a=>operation: 文字|approved\nb=>operation: y\na->b"),
            Err(Reject::Unsupported)
        );
        // `:$函数`。
        assert_eq!(
            to_mermaid_flow("a=>operation: x:$fn\nb=>operation: y\na->b"),
            Err(Reject::Unsupported)
        );
        // `a@>b({...})` 带样式的连接。
        assert_eq!(
            to_mermaid_flow("a=>operation: x\nb=>operation: y\na@>b({\"stroke\":\"Red\"})"),
            Err(Reject::Unsupported)
        );
        // `cond(true@自定义名)` 自定义分支名。
        assert_eq!(
            to_mermaid_flow("a=>condition: x\nb=>operation: y\na(true@自定义)->b"),
            Err(Reject::Unsupported)
        );
        // 未知形状类型。
        assert_eq!(
            to_mermaid_flow("a=>绝对没有这种形状: x\nb=>operation: y\na->b"),
            Err(Reject::BadSyntax)
        );
        // sequence 的 `title` 与 `>>` 箭头。
        assert_eq!(
            to_mermaid_sequence("title: 标题\nA->B: m"),
            Err(Reject::Unsupported)
        );
        assert_eq!(to_mermaid_sequence("A->>B: m"), Err(Reject::Unsupported));
        assert_eq!(to_mermaid_sequence("A-->>B: m"), Err(Reject::Unsupported));
    }

    /// ⭐ `:>url[target]` **显式剥掉**（§2.3.1(a)）：URL ⛔ 不许进 SVG。
    #[test]
    fn 节点链接被剥掉() {
        let out = to_mermaid_flow(
            "a=>operation: 点我:>https://e.com[target]\nb=>operation: x\na->b",
        )
        .unwrap();
        assert!(out.contains("[点我]"), "{out}");
        assert!(!out.contains("https://e.com"), "⛔ URL 漏进 Mermaid 源\n{out}");
        assert!(!out.contains("target"), "⛔ 链接目标漏进 Mermaid 源\n{out}");
        // ⚠️ 连 URL 都不留 ⇒ 渲染出的 SVG 里也不该有。
        let svg = flowmaid::render_svg(&out).unwrap();
        assert!(!svg.contains("https://e.com"), "{svg}");
    }

    /// 方向提示**允许丢**（§2.3.1(b)），但只在非 `condition` 上、且丢了不影响"谁连谁"。
    #[test]
    fn 方向提示被丢掉但不影响连接() {
        let out = to_mermaid_flow("a=>operation: x\nb=>operation: y\na(right)->b").unwrap();
        assert_eq!(out, "flowchart TD\n    n0[x] --> n1[y]\n");
    }

    /// `(true)` / `(false)` 是 `flowchart.js` 一手的 `yes`/`no` 映射（§2.3.1(b) 的邻域）。
    #[test]
    fn true_false_映射成_yes_no() {
        let out = to_mermaid_flow(
            "a=>condition: x\nb=>operation: y\nc=>operation: z\na(true)->b\na(false)->c",
        )
        .unwrap();
        assert!(out.contains("-->|yes| "), "{out}");
        assert!(out.contains("-->|no| "), "{out}");
    }

    /// ⭐ `INV-DIAG-02` + §7.2 单测 13：**渲染结果里不得残留 `#rrggbb`**。
    /// ⚠️ 语料要盖住**我们真能画出来的每一种形状 / 每一种色族**，否则这条测试是空的。
    ///
    /// ⚠️ 第二块 Flow **必须写出合法的图**：`g` 是 `condition`，它的 `next` 槽只有一条
    /// （`g->c` 与 `g->b` 两条同时写会撞 `ConflictingEdge`，整块回退 ——
    /// 那这条测试就变成"测回退路径"，一个字都验不到）。
    ///
    /// ⚠️ 第二块 sequence 要**多于 8 个参与者**（这里 9 个）：
    /// `flowmaid` 的参与者盒按 `ACCENTS[index % 8]` 取色（`style.rs:82-96`），
    /// 前 3 个（indigo/green/amber）恰好与形状色族同值 ⇒ **只测 3 个人的话，
    /// `rose`/`teal`/`violet`/`coral`/`steel` 这五个色值根本进不了视野**。
    /// 2026-10-14 就是这样漏掉了 `#c2588c`（第 5 个参与者），
    /// 表现是深色主题下**露出一块刺眼的玫瑰红、而且不报任何错**。
    #[test]
    fn 渲染结果里不残留字面色值() {
        let blocks: [(&str, &str); 4] = [
            (FLOW, BASE_FLOW),
            (
                FLOW,
                "a=>start: S\nb=>end\nc=>operation: 操作\nd=>input: 输入\ne=>output: 输出\nf=>subroutine: 子程序\ng=>condition: 判断?\na->b\nb->c\nc->d\nd->e\ne->f\nf->g\ng(yes)->c\ng(no)->b",
            ),
            (SEQUENCE, BASE_SEQ),
            (
                SEQUENCE,
                "Alice->Bob: hi\nBob-->Carol: 回信\nnote left of Alice: 左注\nnote over Bob,Carol: 跨注\nparticipant D as 大卫\nD-Bob: 无头\nBob->Eve: 来\nEve-->Frank: 回\nFrank->Grace: 走\nGrace-->Heidi: 送\nHeidi->Ivan: 第五个之后的色族\nIvan-->Judy: 依次是 rose/teal/violet/coral/steel\nJudy->Alice: 绕一圈",
            ),
        ];
        for (lang, src) in blocks {
            let html = render(lang, src).unwrap_or_else(|| panic!("{lang} 应当能画出来\n{src}"));
            let svg = &html[html.find("<svg").expect("应当有 svg")..];
            for (i, _) in svg.match_indices('#') {
                let tail = &svg[i + 1..];
                let six: String = tail.chars().take(6).collect();
                assert!(
                    !(six.len() == 6 && six.bytes().all(|c| c.is_ascii_hexdigit())),
                    "⛔ INV-DIAG-02：SVG 里还有字面色值 #{six}\n{svg}"
                );
            }
            assert!(svg.contains("var(--reader-diag-"), "颜色应当全换成变量\n{svg}");
        }

        // ⭐ 反向锚点：**8 个色族都必须真的出现过一次**——否则上面那条
        // "不残留"可以靠"语料里根本没画出那种颜色"通过（那是空断言）。
        let seq = render(SEQUENCE, blocks[3].1).unwrap();
        for family in [
            "indigo", "green", "amber", "rose", "teal", "violet", "coral", "steel",
        ] {
            assert!(
                seq.contains(&format!("--reader-diag-{family}-")),
                "⭐ 参与者色族 `{family}` 没出现在语料里 ⇒ 这条测试对它是空的\n{seq}"
            );
        }
    }

    /// ⭐ §2.3.3 ⑥ 的**像素侧**判据：回信那条消息必须**虚线 + 有箭头**。
    ///
    /// ⚠️ 判据按 `docs/kb/0015` ⑤：**认值**——消息边虚线是 `stroke-dasharray="6 4"`，
    /// 而**生命线永远是 `4 4`**，所以"有没有 dasharray"是个**错**判据。
    /// 箭头看有没有 `<polygon>`（空心头才是别的元素）。
    #[test]
    fn 渲染出的_svg_里回信是虚线带箭头() {
        let svg = render(SEQUENCE, BASE_SEQ).expect("基准 sequence 应当能画");
        assert!(
            svg.contains("stroke-dasharray=\"6 4\""),
            "回信应当是虚线（判据必须认值，生命线是 4 4）\n{svg}"
        );
        assert!(svg.contains("<polygon"), "回信应当有实心箭头\n{svg}");
    }

    /// 取出 SVG 里**包含 `needle` 的那个标签**（`<` 到 `>`）。⚠️ 认引号，
    /// 属性值里的 `>` 不会把标签切断。
    fn 标签含<'a>(svg: &'a str, needle: &str) -> &'a str {
        let at = svg.find(needle).unwrap_or_else(|| panic!("找不到 {needle}\n{svg}"));
        let start = svg[..at].rfind('<').expect("应当落在一个标签里");
        let mut quote: Option<char> = None;
        for (k, c) in svg[start..].char_indices() {
            match quote {
                Some(q) if c == q => quote = None,
                Some(_) => {}
                None if c == '"' || c == '\'' => quote = Some(c),
                None if c == '>' => return &svg[start..start + k + 1],
                None => {}
            }
        }
        panic!("标签没闭合：{needle}");
    }

    /// 从标签里读一个属性的数值。
    ///
    /// ⚠️ **属性名前面必须有空白**：`x` 若按子串找，会先在 `rx="3"` 上命中
    /// （`rx="3"` 里就有 `x="`）——2026-10-14 这条让"注释框在 Bob 右侧"错判成
    /// `note x=3`（真值 245.3）。⚠️ 与 `displaystyle=` 里藏着 `style=` 是**同一类**错。
    fn 属性数值(tag: &str, name: &str) -> f64 {
        let pat = format!(" {name}=\"");
        let i = tag.find(&pat).unwrap_or_else(|| panic!("标签里没有 {name}：{tag}"));
        let rest = &tag[i + pat.len()..];
        let end = rest.find('"').unwrap();
        rest[..end].parse().unwrap_or_else(|_| panic!("{name} 不是数字：{}", &rest[..end]))
    }

    /// ⭐ §2.3.3 ⑦：`Note right of Bob` 落在 Bob 一侧。
    /// ⚠️ 判据取"注释框的水平位置与 Bob 的生命线之右"，⛔ 不是"某段文字出现两次"。
    #[test]
    fn 注释落在正确一侧() {
        let svg = render(SEQUENCE, BASE_SEQ).unwrap();
        // 琥珀底的那条 `<rect>` 就是注释框（`seq.rs` 的 `NOTE_FILL`）。
        let note_x = 属性数值(标签含(&svg, "var(--reader-diag-amber-bg)"), "x");
        // Bob 的显示名那个 `<text>` 的 x（`text-anchor: middle`，所以它就是生命线的中心）。
        let bob_x = 属性数值(标签含(&svg, ">Bob<"), "x");
        assert!(
            note_x > bob_x,
            "`Note right of Bob` 应当落在 Bob 右侧：note x={note_x}，Bob x={bob_x}\n{svg}"
        );
    }

    /// ⭐ 替换只动色值：`url(#arrow)` 这类引用**不是颜色**，⛔ 不许被换掉。
    ///
    /// ⚠️ 名字里写 `url` ⛔ 不要写成 `URL`：`non_snake_case` 会报警告
    /// （本项目的中文测试名风格是"汉字段 + 小写 ASCII 段"，见 `尺寸闸门_输入边界`）。
    #[test]
    fn 替换不动_url_引用() {
        // ⚠️ 用 `r##"…"##`：内容里有 `url(#arrow)`，那个 `"#` 会提前结束 `r#"…"#`。
        let src = r##"<path marker-end="url(#arrow)" fill="#44507a"/><path id="abcdef"/>"##;
        let out = substitute_colors(src);
        assert!(out.contains("url(#arrow)"), "⛔ 引用被换坏了：{out}");
        assert!(out.contains("var(--reader-diag-line)"), "{out}");
        // 6 位十六进制的 **id**（不是颜色）也必须留着——它后面跟的是 `"` 之外的字符。
        assert!(out.contains("id=\"abcdef\""), "⛔ 把 id 当颜色换了：{out}");
    }

    /// 走**真正的那条路**：适配器的 `write`（含它负责的结尾换行）。
    ///
    /// ⚠️ 断言要落在适配器上，⛔ 不是落在 `render()` 上：`render()` 的 `None` 是
    /// "这块我画不了"的**内部信号**，回退成代码块是**适配器**做的
    /// （`DiagramRenderer::write` 的 `None =>` 分支）。测 `render()` 只能测到
    /// "它说画不了"，测不到"用户到底看见什么"。
    fn 适配器输出(lang: &str, code: &str) -> String {
        let mut out = String::new();
        DIAGRAM.write(&mut out, lang, "", code, None).expect("写 String 不会失败");
        out
    }

    /// ⭐ `INV-DIAG-01`：看不懂的东西**原样**回退成代码块（转义后），⛔ 不截断。
    #[test]
    fn 回退成代码块且转义() {
        let hostile = "a=>parallel: <script>alert(1)</script>\nb=>operation: y\na->b";
        let html = 适配器输出(FLOW, hostile);
        assert!(html.contains(&format!("class=\"{PRE_CLASS}\"")), "{html}");
        assert!(html.contains("language-flow"), "{html}");
        assert!(!html.contains("<script"), "⛔ 回退路径没转义：{html}");
        assert!(html.contains("&lt;script&gt;"), "⚠️ 原文要逐字留下（转义后）：{html}");
        // ⭐ 回退的**不是** `<div class="rmd-diagram">`——那是画出来的图才有的外壳。
        assert!(!html.contains("rmd-diagram"), "回退不该冒充画出来的图：{html}");
        // ⚠️ 结尾换行归适配器（comrak 的适配器分支不写 `lf()`）。
        assert!(html.ends_with("</code></pre>\n"), "适配器必须自己收尾换行：{html}");

        // ⭐ 反面：画得出来的块**不该**走回退（否则上面几条可以靠"永远回退"通过）。
        let ok = 适配器输出(FLOW, BASE_FLOW);
        assert!(ok.contains("rmd-diagram"), "{ok}");
        assert!(!ok.contains(PRE_CLASS), "{ok}");
    }

    /// 规模闸门：输入 / 节点数 / 边数三条各测一遍（§2.3.4 的表）。
    ///
    /// ⚠️ 三条要**各自只撞自己那一堵墙**，否则测不出是哪一条在生效：
    /// 节点那条用链（每加一个点加一条边，边不会先超）；边那条**不能用链**——
    /// 一个 `operation` 的 `next` 槽只有一条边，链式造不出 256 条边；
    /// 而"两两相连"会因为撞上 `ConflictingEdge` 提前回退。
    /// ⇒ 用 129 个 `condition`，每个给 `yes`/`no` 各一条边：**258 条边、131 个节点**。
    #[test]
    fn 规模闸门() {
        let big = format!("a=>operation: {}\nb=>operation: x\na->b", "标".repeat(MAX_INPUT));
        assert_eq!(to_mermaid_flow(&big), Err(Reject::TooLarge));

        // 节点数：造一条够长的链（每加一个节点也加一条边）。
        let mut many = String::new();
        let n = MAX_NODES + 2;
        for i in 0..n {
            many.push_str(&format!("k{i}=>operation: n{i}\n"));
        }
        for i in 0..n - 1 {
            many.push_str(&format!("k{i}->k{}\n", i + 1));
        }
        assert_eq!(to_mermaid_flow(&many), Err(Reject::TooMany));

        // 边数：节点不超限、边超限。
        let conds = MAX_EDGES / 2 + 1; // 258 / 2 = 129 个条件 ⇒ 258 条边
        assert!(conds + 2 <= MAX_NODES, "语料本身不能先撞节点上限");
        let mut edges = String::new();
        for i in 0..conds {
            edges.push_str(&format!("k{i}=>condition: n{i}\n"));
        }
        edges.push_str("t=>operation: 是\nf=>operation: 否\n");
        for i in 0..conds {
            edges.push_str(&format!("k{i}(yes)->t\nk{i}(no)->f\n"));
        }
        assert_eq!(to_mermaid_flow(&edges), Err(Reject::TooMany));
    }

    /// ⚠️ 适配器写出的结尾换行**只在 `compact_html` 关着时**才是对的。
    /// 这条把那个假设变成**断言**：`ParseOpts` 的两个来源都不开它。
    #[test]
    fn 假设_compact_html_永远关着() {
        for opts in ParseOpts::all_opts() {
            assert!(
                !opts.to_comrak().render.compact_html,
                "⛔ `diagram.rs` 的结尾换行假设被打破了"
            );
        }
    }

    /// ⛔ 空块、纯空白块都不能变成"空白图"。
    #[test]
    fn 空块回退() {
        assert_eq!(to_mermaid_flow(""), Err(Reject::Empty));
        assert_eq!(to_mermaid_flow("   \n  "), Err(Reject::Empty));
        assert_eq!(to_mermaid_sequence(""), Err(Reject::Empty));
    }

    /// `participant` / `note` **逐字相同**（§2.3.1(c) 的 ✅ 两项）。
    #[test]
    fn participant_与_note_逐字相同() {
        let src = "participant Alice\nparticipant B as 小波\nAlice->B: 嗨\nB-->Alice: 好";
        let out = to_mermaid_sequence(src).unwrap();
        assert!(out.contains("    participant Alice\n"), "{out}");
        assert!(out.contains("    participant B as 小波\n"), "{out}");
        assert!(out.contains("    Alice->>B: 嗨\n"), "{out}");
        assert!(out.contains("    B-->>Alice: 好\n"), "{out}");
    }

    /// 四种箭头写法**逐一**位移（§2.3.1(c) 的前四行）。
    #[test]
    fn 四种箭头写法各自位移() {
        let cases = [
            ("A-B: m", "A->B: m"),
            ("A->B: m", "A->>B: m"),
            ("A--B: m", "A-->B: m"),
            ("A-->B: m", "A-->>B: m"),
        ];
        for (src, want) in cases {
            let out = to_mermaid_sequence(src).unwrap();
            assert!(out.contains(&format!("    {want}\n")), "{src} ⇒ {out}");
        }
    }

    /// `keyword` 的边界：`notebook->x: y` 里的 `note` **不是**关键词。
    #[test]
    fn 关键词要求词边界() {
        assert!(keyword("note right of Bob: x", "note").is_some());
        assert!(keyword("Note right of Bob: x", "note").is_some());
        assert!(keyword("title: x", "title").is_some());
        assert!(keyword("notebook->x: y", "note").is_none());
        assert!(keyword("titles: x", "title").is_none());
        // ⚠️ 多字节前缀不能 panic（`get(..len)` 在非字符边界上给 `None`）。
        assert!(keyword("中文行", "note").is_none());
    }

    /// 空块 / 只有一堆不认识的语句 ⇒ 回退，⛔ 不出一个空的 `sequenceDiagram`。
    #[test]
    fn 没有一条消息的_sequence_回退() {
        assert_eq!(to_mermaid_sequence("participant Alice"), Err(Reject::BadSyntax));
    }
}
