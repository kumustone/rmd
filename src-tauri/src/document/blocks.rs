//! 顶层块表：`root.children()` 的行区间 ＋ 种类 ＋ 可编辑性。
//!
//! ⭐ `design/0047` §2.2 / §3.1：这张表是「唯一全文模型 ＋ 单块编辑视图」的**骨架**——
//! 前端靠它把 `#doc` 里那篇预渲染 HTML 与 `fullText` 的行对上，再把用户点到的那一块
//! 换成只装该块源码的 CM6 视图。
//!
//! ## 四条口径（⛔ 改之前先读）
//!
//! 1. ⭐ **块表（`blocks`）只用 `sourcepos` 的行号，⛔ 不用 columns** ⇒ 与 UTF-8 / UTF-16 /
//!    CRLF 三套口径全都无关（`design/0047` §2.1）。列语义本身的坑见 `offset.rs` 模块头。
//!    ⚠️ **`0049` / `0051` 起有了两个例外**：`table_cells` 与任务项的符号区间**必须**带列
//!    （它们要落在一个**行内的字符区间**上）。那两处的口径是：
//!    ① 只有**后端**做 `(行, 列)` → UTF-8 字节 → **UTF-16 列**的换算（[`crate::document::offset`]），
//!    前端⛔ 不重算；② 它们各自的区间是**右开**的 `[from, to)`，与块表的 1-based 含两端
//!    分开记——⛔ 别把同一份行号在两条口径之间直接搬。
//! 2. **只取 `root.children()`**，⛔ 不 `descendants()`：块表是**顶层块**的序号，
//!    子块（`Item` / `TableRow` / `TableCell` / 段落里的 `Text`）混进来会让序号
//!    与用户看到的东西错位（`design/0047` §2.2 的 2026-10-26 补正第 2 条）。
//! 3. **⛔ 不打开 `render.sourcepos`**：`toc.rs` 已经证明 AST 的 `sourcepos` 够用，
//!    打开渲染侧那一项会让 HTML 体积 +89.4%（`kb/0002`），而阅读态的 HTML 一个字节都不该动。
//! 4. **行号 1-based 含两端**，`LineIndex` 同一口径；换到 0-based 半开只在前端那**一处**
//!    做（`live/blocks.js`），⛔ 别在这里再摊一次。
//!
//! ## `editable` 的块族清单只能有一份
//!
//! 「允许就地编辑的块族」是**实测**出来的（`design/0047` §2.2 的 2026-10-26 补正）：
//! `FootnoteDefinition` 单独切出来重新 parse 得 **0 个块**（它只在被引用时才物化，
//! 证据在 `design/0047` §7.1.1 的 0a 与夹具），`HtmlBlock` / `Table` / `ThematicBreak`
//! 是**版面理由**（源码形态 ≠ 渲染形态）。
//! ⚠️ 这张清单与 §7.1 的往返判据必须问同一个函数（[`inline_editable`]）——
//! 两份清单会造出「标了不可编辑、却因为往返不稳定而报红」这种自相矛盾的报告。
//!
//! ⚠️ 这里写成**白名单**而不是「四个例外」：新增的块族落 [`BlockKind::Other`] ⇒ 不可编辑。
//! 理由是两侧代价不对称——错判成"能编辑"会让版面在输入期间跳（用户强需求，`F6`），
//! 错判成"不能编辑"只是少一个入口（单击退回"跳到分栏并定位"）。

// ⚠️ 默认构建（`make test`，**不带** `gui`）里 `commands/` 不编译 ⇒ 本模块的公开项
//    在那一边只有单测在调。写法与 `lang.rs` 同款：⛔ **不要**为了消告警把本模块
//    `#[cfg(feature = "gui")]` 掉——那样 `make test` 里一条块表断言都跑不到
//    （`INV-LINK-09` 的同族理由：纯逻辑必须留在默认构建里）。
#![cfg_attr(not(any(feature = "gui", test)), allow(dead_code))]

use comrak::nodes::{AstNode, NodeValue};

use crate::document::render;

/// 线格式里的种类名表。⭐ **下标就是 `blocks` 元组的第一个数**。
///
/// ⚠️ **每次都发全表**（固定 10 项、固定顺序，`design/0047` §3.1.1）：
/// 下标跨版本因此稳定。新增种类要 Rust 侧这里与前端 `live/blocks.js::tagOf`
/// **同批**改——漏改只会让已知种类落 `Other`（**可见降级**），⛔ 不会错位。
pub const KIND_NAMES: [&str; 10] = [
    "Paragraph",
    "Heading",
    "CodeBlock",
    "List",
    "BlockQuote",
    "Table",
    "HtmlBlock",
    "ThematicBreak",
    "FootnoteDefinition",
    "Other",
];

/// 一个顶层块的种类。⚠️ **只覆盖 `root.children()` 能出现的那些**。
///
/// 子块种类（`Item` / `TableRow` / `TableCell`）**故意没有**：它们不该进这张表。
/// 认不出来的种类一律 [`BlockKind::Other`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Paragraph,
    Heading,
    CodeBlock,
    List,
    BlockQuote,
    Table,
    HtmlBlock,
    ThematicBreak,
    FootnoteDefinition,
    /// 认不出来的种类。⚠️ 它与 [`KIND_NAMES`] 里最后那一项**同一下标**。
    Other,
}

impl BlockKind {
    /// 在 [`KIND_NAMES`] 里的下标 = 线格式里那个 `kind_idx`。
    pub fn index(self) -> usize {
        self as usize
    }

    /// 线格式里的名字（`KIND_NAMES[index]`）。
    pub fn name(self) -> &'static str {
        KIND_NAMES[self.index()]
    }

    /// `NodeValue` → 种类。⚠️ 只认顶层会出现的那些，其余一律 `Other`。
    pub fn of(value: &NodeValue) -> Self {
        match value {
            NodeValue::Paragraph => Self::Paragraph,
            NodeValue::Heading(_) => Self::Heading,
            NodeValue::CodeBlock(_) => Self::CodeBlock,
            NodeValue::List(_) => Self::List,
            NodeValue::BlockQuote => Self::BlockQuote,
            NodeValue::Table(_) => Self::Table,
            NodeValue::HtmlBlock(_) => Self::HtmlBlock,
            NodeValue::ThematicBreak => Self::ThematicBreak,
            NodeValue::FootnoteDefinition(_) => Self::FootnoteDefinition,
            _ => Self::Other,
        }
    }
}

/// ⭐ 这个块族**允不允许就地编辑**——本项目**唯一**一份清单。
///
/// 判据是「在流里就地改它会不会改版面 / 有没有意义」：
///
/// | 种类 | 能不能 | 为什么 |
/// |---|---|---|
/// | `Paragraph` / `Heading` / `CodeBlock` / `List` / `BlockQuote` | ✅ | 源码形态与渲染形态能在同一个槽位里对齐 |
/// | `Table` | ⛔ | 源码是竖线分列、渲染是网格（`|ΔH|` 实测 19.44 px） |
/// | `ThematicBreak` | ⛔ | 源码 `---` 与渲染的分隔线不是一回事 |
/// | `HtmlBlock` | ⛔ | 渲染结果由 HTML 决定，改源码看不见对应关系 |
/// | `FootnoteDefinition` | ⛔ | 单独切出来重新 parse 得 **0 个块**（物化条件是被引用） |
/// | `Other` | ⛔ | 没见过的种类，按安全侧处理 |
///
/// ⚠️ **这张表只按种类判**，它**不是**最终判据——`Paragraph` 里那个"整段就是一个
/// 块级公式"的、`CodeBlock` 里 `flow`/`sequence`/`math` 那三种围栏，渲染形态都不是
/// 一行源码（2026-10-26 实测：顶层 DOM 分别是 `<div class="rmd-math-display">` 与
/// `<div class="rmd-diagram">`），所以还要过 [`editable_of`] 那一道**逐节点**的闸。
/// ⛔ 别把这两道合成一道：种类是跨文档不变的，渲染形态是 comrak 分流决定的。
pub fn inline_editable(kind: BlockKind) -> bool {
    matches!(
        kind,
        BlockKind::Paragraph
            | BlockKind::Heading
            | BlockKind::CodeBlock
            | BlockKind::List
            | BlockKind::BlockQuote
    )
}

/// 逐节点的第二道闸：**它这一份的渲染形态还是不是源码**。
///
/// | 节点 | 顶层 DOM（2026-10-26 实测，见 `design/0047` §7.1.1） | 能不能就地改 |
/// |---|---|---|
/// | 整段只有一个 `display_math` 的 `Paragraph` | `<div class="rmd-math-display">` | ⛔ |
/// | 带别的内容（含行内公式）的 `Paragraph` | `<p>` | ✅ |
/// | ` ```flow ` / ` ```sequence ` | `<div class="rmd-diagram" data-diagram="…">` | ⛔ |
/// | ` ```math ` | `<pre><code class="language-math">`（⛔ 不是 `.rmd-code`，也不出 MathML） | ⛔ |
/// | 其余围栏 | `<pre class="rmd-code">` | ✅ |
///
/// ⚠️ 两个判据都**借用 `render.rs` 里已有的函数**（[`render::is_lone_display_math`] /
/// [`render::is_special_fence`]），⛔ 不在这里另写一份——那两份清单一旦分叉，
/// 表现是"comrak 换了渲染分支、而块表还标着可编辑"。它们本来就回答同一个问题。
pub fn editable_of<'a>(node: &'a AstNode<'a>, kind: BlockKind) -> bool {
    if !inline_editable(kind) {
        return false;
    }
    match kind {
        BlockKind::Paragraph => !render::is_lone_display_math(node),
        BlockKind::CodeBlock => match node.data().value {
            NodeValue::CodeBlock(ref ncb) => !render::is_special_fence(&ncb.info),
            // ⚠️ 到不了：`kind` 就是从同一个 `data().value` 判出来的。
            _ => false,
        },
        _ => true,
    }
}

/// 一个顶层块（`design/0047` §2.2 的语义形状）。
///
/// ⚠️ 它**不是**线上形状——线格式是紧凑元组，转换只在 [`to_wire`] 一处
/// （`design/0047` §3.1.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockSpan {
    /// 顶层块序号（0 起，= 它在 `root.children()` 里的位置）。
    pub index: usize,
    pub kind: BlockKind,
    /// 首行，**1-based 含**。
    pub start_line: u32,
    /// 末行，**1-based 含**。
    pub end_line: u32,
    /// 可编辑族 ∧ 区间可用（`design/0047` §2.2）。
    /// ⚠️ `Eol == Other` 那条闸在 [`to_wire`]（它要信封，`build` 手上没有）。
    pub editable: bool,
}

/// 从**已经解析好**的 AST 取顶层块表。⛔ 不重新 parse（`INV-SINGLE-01` 的同族要求：
/// 打开与预览本来就要 parse 一遍，这张表只是**在既有 AST 上走一层**）。
///
/// ⚠️ `sourcepos` 缺失（`start.line == 0`，comrak 对合成节点就是这样）⇒
/// 区间不可用 ⇒ `editable = false`，行号原样带 0 出去（前端按"不可编辑"处理）。
pub fn build<'a>(root: &'a AstNode<'a>) -> Vec<BlockSpan> {
    root.children()
        .enumerate()
        .map(|(index, node)| {
            let data = node.data();
            let sourcepos = data.sourcepos;
            let kind = BlockKind::of(&data.value);
            let start_line = sourcepos.start.line as u32;
            let end_line = sourcepos.end.line as u32;
            // ⚠️ 两个条件都要：comrak 的合成节点是 `(0,0)`，而真块不可能跨 0 行。
            let has_range = start_line >= 1 && end_line >= start_line;
            BlockSpan {
                index,
                kind,
                start_line,
                end_line,
                editable: has_range && editable_of(node, kind),
            }
        })
        .collect()
}

/// 语义形状 → **线格式**：`Vec<(kind_idx, start_line, end_line, editable)>`。
///
/// ⚠️ `editable` 在这里**再收一道**：`eol_is_other` 为真时整篇一个块都不能编辑
/// （`design/0047` §2.2：`Eol::Other` 整篇 `editable=false`）。
/// ⭐ 这条闸放在这里而**不是** `build` 里，是为了让"信封"只在**一个函数**里参与判定——
/// 打开与预览两条路都调它，⛔ 不会一边记得一边忘了。
///
/// ⚠️ 服务端就是这四个数的数组，`serde_json` 自动产出 `[[1,3,3,1], …]`，
/// **⛔ 不加自定义 `Serialize`**（`design/0047` §3.1.1）。
pub fn to_wire(spans: &[BlockSpan], eol_is_other: bool) -> Vec<(u8, u32, u32, u8)> {
    spans
        .iter()
        .map(|b| {
            let editable = b.editable && !eol_is_other;
            (
                b.kind.index() as u8,
                b.start_line,
                b.end_line,
                u8::from(editable),
            )
        })
        .collect()
}

/// ⭐ 一个表格单元格的**可写区间**（`design/0049`）。
///
/// 列坐标是 **UTF-16 码元**（⛔ 不是 comrak 给的 UTF-8 字节）——换算只在后端做一次，
/// 前端拿到的数可以直接喂给 JS 的 `String.prototype.slice`（`INV-CELL-03`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellSpan {
    /// 行号，**1-based**（与 `BlockSpan` / `toc` 同一口径）。
    pub line: u32,
    /// 行内起点，0-based，UTF-16 码元。
    pub from: u32,
    /// 行内终点，0-based，UTF-16 码元，**右开**。
    pub to: u32,
    /// 能不能往里写。`false` 的格子点进去必须**如实告知**（`INV-CELL-05`）。
    pub writable: bool,
}

/// ⭐ **表格的单元格区间表**（`design/0049` §2.1）：`[(顶层块序号, [格子…]), …]`。
///
/// 只收 `root.children()` 里的 `Table`；格子按**行主序**展开（先表头行，再各行），
/// 与 DOM 里 `<th>`/`<td>` 的顺序一一对应——上游会给缺的列**自动补空格子**
/// （`comrak-0.56.0/src/parser/table.rs:196`），所以 AST 的格子数恒等于对齐行的列数，
/// 这是"按扁平下标配对"能成立的前提。
///
/// ## 可写判据（⛔ 改之前先读）
///
/// comrak 的 `TableCell.sourcepos` **含两侧填充空格**（`:250-255` 把起点回退到前一个 `|` 之后、
/// 终点取修剪前的末字节），所以：
///
/// 1. 先把原始区间**两侧修剪 ASCII 空白** ⇒ 写回时填充空格与竖线一个字节不动（`INV-CELL-01`）。
/// 2. ⭐ **可写 ⟺ 原始区间的起点在本行前一格右端**之后**（⛔ 不是"落在首尾两个 `|` 之间"）。**
///    ⚠️ 自动补出来的空格子（行里少写了列）起点**恰好等于**前一格的右端
///    （`table.rs:196` 的 `last_column + 1`）⇒ 往里写字会写进**前一格**，
///    而屏幕上看起来"就是那一格"（`INV-CELL-05`）。真格子之间至少隔着一个 `|` 字节，
///    所以"起点 > 前一格右端"同时覆盖了"不是补出来的"与"没跨到前一格里"。
///    ⚠️⚠️ 早先的判据是「落在首尾竖线之间」，它在**省略首尾竖线的合法 GFM 表**（`a | b`）上
///    把**每一个真格子**都判成不可写 ⇒ 整张表点不动（`bugs/0038`，2026-10-29）。
/// 3. 跨行、非字符边界、区间倒置 ⇒ 一律 `writable = false`（宁可少一个入口，⛔ 不猜位置）。
pub fn table_cells<'a>(root: &'a AstNode<'a>, src: &str) -> Vec<(u32, Vec<CellSpan>)> {
    scan_tables(root, src)
        .into_iter()
        .map(|(block_index, shape)| (block_index, shape.cells))
        .collect()
}

/// 一张表的**结构形状**（⭐ `design/0054` `INV-EDITOBJ-03` 第 2 步要的结构证据）。
///
/// ⚠️ 它是 [`scan_tables`] 的原始产物，[`table_cells`] 与 [`verify_cell_edit`] **共用**
/// 同一份枚举——⛔ 不许在别处再写一遍 `root.children() → Table → TableCell` 的走法。
#[derive(Debug, Clone)]
struct TableShape {
    /// 列对齐（`NodeTable.alignments`）。⭐ 改一格内容**不许**改变它。
    alignments: Vec<comrak::nodes::TableAlignment>,
    /// **每行的格数**（行主序，含表头行）。
    ///
    /// ⚠️ 单看总格数不够：`|a|b|` 多切出一列的同时另一行少切一列，总数不变
    /// ⇒ 必须逐行比（`INV-EDITOBJ-03`「⛔ 只比格数会被上游自动补列掩盖合并」）。
    row_sizes: Vec<usize>,
    /// 扁平格区间（行主序）。
    cells: Vec<CellSpan>,
}

/// 枚举顶层 `Table` 块 → `[(顶层块序号, 形状…)]`（唯一的切格入口）。
fn scan_tables<'a>(root: &'a AstNode<'a>, src: &str) -> Vec<(u32, TableShape)> {
    let index = crate::document::offset::LineIndex::new(src);
    let mut out = Vec::new();
    for (block_index, node) in root.children().enumerate() {
        let alignments = match node.data().value {
            NodeValue::Table(ref t) => t.alignments.clone(),
            _ => continue,
        };
        let mut cells = Vec::new();
        let mut row_sizes = Vec::new();
        for row in node.children() {
            let mut n = 0usize;
            // ⚠️ 逐格带上**同一行前一格**的 sourcepos：那是「自动补出来的格子」的唯一判据
            //    （见 [`cell_span`] 判据 ②）。
            let mut prev: Option<comrak::nodes::Sourcepos> = None;
            for cell in row.children() {
                if !matches!(cell.data().value, NodeValue::TableCell) {
                    continue;
                }
                let sp = cell.data().sourcepos;
                n += 1;
                cells.push(cell_span(sp, src, &index, prev));
                prev = Some(sp);
            }
            row_sizes.push(n);
        }
        if !cells.is_empty() {
            out.push((block_index as u32, TableShape { alignments, row_sizes, cells }));
        }
    }
    out
}

/// ⭐ **一次单元格编辑的候选校验请求**（`design/0054` §7 第 4 条）。
///
/// ⚠️ **`baseline` 必须是「本次编辑所基于的最新已提交全文」**，⛔ 不是打开时那份原文：
/// 否则"连续改两个格子、不保存"时第二次会被误拒（用户 2026-10-28 的明确纠正）。
/// 磁盘基线（`baseline_bytes`）继续**只**服务保存冲突检测，⛔ 与这里无关。
pub struct CellEditRequest<'a> {
    /// 编辑所基于的全文（LF、无 BOM，与 `session.lines().join("\n")` 同源）。
    pub baseline: &'a str,
    /// 目标格的**行号**（1-based，相对 `baseline`）。后端会拿它与基线重新解析的结果对表。
    pub line: u32,
    /// 目标格所在的**顶层块序号**（与 `blocks` / `table_cells` 同一个枚举口径）。
    pub block: u32,
    /// 目标格在块内的**扁平下标**（行主序，0-based）。
    pub cell: u32,
    /// 预期写进那个区间的源码（已转义、已折行；前端 `cell.encode` 的产物）。
    pub replacement: &'a str,
}

/// 校验判决。`reason` 是**稳定字符串**（前端按它选文案，⛔ 不解析 `detail`）。
///
/// ⚠️ **曾经有一个 `expected: Option<String>`**（`candidate_mismatch` 时回带"唯一合法的那一份"），
/// 2026-10-29 代码评审第 21 条把它删了：它**从来没过 IPC**——[`crate::commands::edit::VerifyReply`]
/// 里没有这个字段，前端一个字节都拿不到，所以那句"供前端自证"的注释是**假的**。
/// ⭐ 要重新加回来得先回答「前端拿它干什么」；把一整份基线塞进回包⛔ 不是答案。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellVerdict {
    pub ok: bool,
    /// 通过时为空串。取值见 [`verify_cell_edit`] 的说明。
    pub reason: &'static str,
    /// 给人看的补充说明（**不进正文日志**，只回落给前端）。
    pub detail: String,
}

impl CellVerdict {
    fn ok() -> Self {
        Self { ok: true, reason: "", detail: String::new() }
    }

    fn fail(reason: &'static str, detail: String) -> Self {
        Self { ok: false, reason, detail }
    }
}

/// ⭐ **候选先校验**（`design/0054` `INV-EDITOBJ-03` 第 2 步）：用**同一份 comrak**
/// 判定「`candidate` 确实是 `baseline` 上只替换了目标格那一段」。
///
/// ## 六道判据（`reason` 的取值就是这六条 + 三条前置）
///
/// 1. `baseline_parse` —— 基线里找不到 `block` 那一块表格，或 `cell` 下标越界。
/// 2. `line_mismatch` —— 前端给的行号与基线重解析出来的行号不一致（陈旧行号）。
/// 3. `not_writable` —— 目标格不可写（自动补格等，`INV-CELL-05`）。
/// 4. `newline` —— 替换源码含换行：那一定改行结构，⛔ 早于解析就拒。
/// 5. `candidate_mismatch` —— 送来的候选 ≠ 基线⊕替换（⛔ 防伪造，**这是"不循环证明"的落点**：
///    先由后端自己算出唯一合法候选，再逐字比对，⛔ 不拿"目标格等于候选里任意一段"当证据）。
/// 6. `table_changed` —— 候选里那一块不再是表，或行数/每行格数/列对齐变了，或
///    某格的**真实 vs 自动补格**状态变了。
/// 7. `cell_content` —— 目标格（修剪 ASCII 空白后）不等于替换源码。
/// 8. `neighbor_changed` —— 任何**未编辑**格的内容变了（末尾反斜杠吃掉竖线的形态，`bugs/0032`）。
///    ⚠️ **第 5 条成立时理论上到不了这里**（替换区间严格落在两根竖线之间 ⇒ 邻格的定界字节没动）。
///    留着它是**第二道网**：第 5 条哪天被放宽（比如允许"前缀相同"），它仍然兜得住。
///    ⛔ 所以别拿它当测试覆盖——变异测试打不出"只命中第 8 条"的用例，这是**已知**的。
///
/// ⚠️ **对象外源码一个字都没动**是第 5 条**免费**给出来的：候选与基线只差那一个区间。
pub fn verify_cell_edit(
    req: &CellEditRequest<'_>,
    candidate: &str,
    opts: &crate::document::parser::ParseOpts,
) -> CellVerdict {
    use crate::document::offset::{utf16_to_byte_in_line, LineIndex};

    // —— 前置 1/2/3：目标格必须**由基线重新解析**得到，⛔ 不信任前端给的列号 ——
    let base = table_shape_in(req.baseline, req.block, opts);
    let Some(base_shape) = base else {
        return CellVerdict::fail("baseline_parse", format!("基线里没有第 {} 块表格", req.block));
    };
    let Some(target) = base_shape.cells.get(req.cell as usize).copied() else {
        return CellVerdict::fail(
            "baseline_parse",
            format!("基线第 {} 块只有 {} 格，没有第 {} 格", req.block, base_shape.cells.len(), req.cell),
        );
    };
    if target.line != req.line {
        return CellVerdict::fail(
            "line_mismatch",
            format!("基线里这一格在第 {} 行，请求说第 {} 行", target.line, req.line),
        );
    }
    if !target.writable {
        return CellVerdict::fail("not_writable", "这一格在基线里就不可写".to_string());
    }
    // —— 前置 4：换行一定会改行结构，早拒（省一次解析，也给前端一句准确的话）——
    if req.replacement.contains('\n') || req.replacement.contains('\r') {
        return CellVerdict::fail("newline", "替换源码含换行".to_string());
    }

    // —— 第 5 条：后端自己造出**唯一合法候选**，再与送来的候选逐字比 ——
    let index = LineIndex::new(req.baseline);
    let Some(line_str) = index.line_str(req.baseline, target.line as usize) else {
        return CellVerdict::fail("baseline_parse", "目标行不在基线里".to_string());
    };
    let Some(line_start) = index.line_start(target.line as usize) else {
        return CellVerdict::fail("baseline_parse", "目标行不在基线里".to_string());
    };
    let (Some(a), Some(b)) = (
        utf16_to_byte_in_line(line_str, target.from as usize),
        utf16_to_byte_in_line(line_str, target.to as usize),
    ) else {
        return CellVerdict::fail("baseline_parse", "目标格区间不在字符边界上".to_string());
    };
    let mut expected =
        String::with_capacity(req.baseline.len() + req.replacement.len());
    expected.push_str(&req.baseline[..line_start + a]);
    expected.push_str(req.replacement);
    expected.push_str(&req.baseline[line_start + b..]);
    if candidate != expected {
        return CellVerdict::fail(
            "candidate_mismatch",
            format!(
                "送来的候选 {} 字节，按基线与替换算出来 {} 字节，两者不是同一份",
                candidate.len(),
                expected.len()
            ),
        );
    }

    // —— 第 6/7/8 条：在**候选**上重新解析，逐格比对 ——
    let Some(cand_shape) = table_shape_in(candidate, req.block, opts) else {
        return CellVerdict::fail(
            "table_changed",
            format!("候选里第 {} 块不再是表格", req.block),
        );
    };
    if cand_shape.row_sizes != base_shape.row_sizes {
        return CellVerdict::fail(
            "table_changed",
            format!("每行格数变了：基线 {:?} → 候选 {:?}", base_shape.row_sizes, cand_shape.row_sizes),
        );
    }
    if cand_shape.alignments != base_shape.alignments {
        return CellVerdict::fail("table_changed", "列对齐变了".to_string());
    }
    let target_idx = req.cell as usize;
    let base_index = LineIndex::new(req.baseline);
    let cand_index = LineIndex::new(candidate);
    for i in 0..base_shape.cells.len() {
        let b = base_shape.cells[i];
        let c = cand_shape.cells[i];
        if c.writable != b.writable {
            return CellVerdict::fail(
                if i == target_idx { "table_changed" } else { "neighbor_changed" },
                format!("第 {i} 格的「真实 vs 自动补格」状态变了"),
            );
        }
        let ctext = cell_text_of(candidate, &cand_index, &cand_shape.cells, i);
        if i == target_idx {
            // ⚠️ 两侧修剪：区间的定义**就是**"两侧 ASCII 空白之外的那一段"
            //    （`cell_span` 判据 ①），所以替换源码自带的填充空格不进比较。
            if ctext.trim_matches([' ', '\t']) != req.replacement.trim_matches([' ', '\t']) {
                return CellVerdict::fail(
                    "cell_content",
                    format!("目标格写进去的是「{}」", ctext),
                );
            }
        } else {
            let btext = cell_text_of(req.baseline, &base_index, &base_shape.cells, i);
            if ctext != btext {
                return CellVerdict::fail(
                    "neighbor_changed",
                    format!("第 {i} 格内容从「{}」变成了「{}」", btext, ctext),
                );
            }
        }
    }
    CellVerdict::ok()
}

/// 在 `src` 里取第 `block` 块表格的形状。
fn table_shape_in(
    src: &str,
    block: u32,
    opts: &crate::document::parser::ParseOpts,
) -> Option<TableShape> {
    crate::document::parser::with_parsed(src, opts, |root| {
        scan_tables(root, src)
            .into_iter()
            .find(|(i, _)| *i == block)
            .map(|(_, shape)| shape)
    })
}

/// 第 `i` 格的内容（按 [`CellSpan`] 的 UTF-16 区间切行）。不可写格给空串。
///
/// ⚠️ `index` 必须与 `src` 对应——这里**不做**任何归属检查（调用方保证）。
fn cell_text_of(
    src: &str,
    index: &crate::document::offset::LineIndex,
    cells: &[CellSpan],
    i: usize,
) -> String {
    use crate::document::offset::utf16_to_byte_in_line;
    let Some(span) = cells.get(i) else { return String::new() };
    if !span.writable {
        return String::new();
    }
    let Some(line) = index.line_str(src, span.line as usize) else { return String::new() };
    let (Some(a), Some(b)) = (
        utf16_to_byte_in_line(line, span.from as usize),
        utf16_to_byte_in_line(line, span.to as usize),
    ) else {
        return String::new();
    };
    line.get(a..b).unwrap_or("").to_string()
}

/// 单个格子的区间换算（见 [`table_cells`] 的三条判据）。
///
/// `prev` 是**同一行上前一格**的 `sourcepos`（本行第一格传 `None`）。它是
/// 「这一格是真的还是 comrak 自动补出来的」的唯一判据，见下面 ②。
fn cell_span(
    sp: comrak::nodes::Sourcepos,
    src: &str,
    index: &crate::document::offset::LineIndex,
    prev: Option<comrak::nodes::Sourcepos>,
) -> CellSpan {
    use crate::document::offset::byte_to_utf16_in_line;

    let line_no = sp.start.line as u32;
    let mut span = CellSpan { line: line_no, from: 0, to: 0, writable: false };
    if sp.start.line != sp.end.line {
        return span;
    }
    let Some(line) = index.line_str(src, sp.start.line) else {
        return span;
    };
    // comrak 的列口径：`start.column` 是 1-based 的字节下标，`end.column` 已是右开边界。
    let raw_from = sp.start.column.saturating_sub(1);
    let raw_to = sp.end.column;
    if raw_from > raw_to || raw_to > line.len() {
        return span;
    }
    if !line.is_char_boundary(raw_from) || !line.is_char_boundary(raw_to) {
        return span;
    }
    // ② 结构判据：**自动补出来的空格子**必须拦掉（否则写进前一格）。
    //
    //    ⚠️⚠️ 判据是「与本行前一格**紧挨着**」，⛔ 不是「落在首尾两个 `|` 之间」——
    //    GFM 允许省略首尾竖线（`a | b`），拿竖线当边界会让**整张表一个可写格都没有**，
    //    用户看到的是「表格缺列」（`bugs/0038`，2026-10-29）。
    //
    //    依据是 comrak 自己的写法（`comrak-0.56.0/src/parser/table.rs:196`）：
    //    补出来的格子起点恒等于**上一个真格子的右端**（`last_column + 1`），
    //    换算成 0-based 就是 `raw_from == 前一格的 end.column`；而真格子之间至少隔着
    //    一个 `|` 字节 ⇒ 真格子的 `raw_from` 一定 **> 前一格的 `end.column`**。
    //    ⚠️ 这条判据对「带不带首尾竖线」「有没有填充空格」都不敏感——它只看相邻关系。
    if let Some(p) = prev {
        if p.start.line == sp.start.line && raw_from <= p.end.column {
            return span;
        }
    }
    // ① 两侧修剪 ASCII 空白 ⇒ 只替换**内容**，填充空格留在原处。
    let inner = &line[raw_from..raw_to];
    let lead = inner.len() - inner.trim_start_matches([' ', '\t']).len();
    let trail = inner.len() - inner.trim_end_matches([' ', '\t']).len();
    // ⚠️ 全空白的格子（`|  |`）两侧会**同时**修剪到中间 ⇒ 必须收口成一个插入点，
    //    否则会造出 `from > to` 这种倒置区间（写回时会把这一行切坏）。
    let from = raw_from + lead;
    let to = (raw_to.saturating_sub(trail)).max(from);
    let (Some(f), Some(t)) = (
        byte_to_utf16_in_line(line, from),
        byte_to_utf16_in_line(line, to),
    ) else {
        return span;
    };
    span.from = f as u32;
    span.to = t as u32;
    span.writable = true;
    span
}

/// 单元格区间表 → **线格式**：`[[block_index, [[line, from, to, writable], …]], …]`。
///
/// ⚠️ 与 [`to_wire`] 同一条理由：`serde_json` 直接吃嵌套数组，⛔ 不加自定义 `Serialize`。
/// ⚠️ 它**不进** `blocks` 四元组——非表格文档因此**一个字节都不多**（`design/0049` §2.2 最后一行）。
pub fn cells_to_wire(cells: &[(u32, Vec<CellSpan>)]) -> Vec<(u32, Vec<(u32, u32, u32, u8)>)> {
    cells
        .iter()
        .map(|(idx, list)| {
            (
                *idx,
                list.iter()
                    .map(|c| (c.line, c.from, c.to, u8::from(c.writable)))
                    .collect(),
            )
        })
        .collect()
}

/// ⭐ 一个**任务项方框**在源码里的那一个字节（`design/0051`）。
///
/// 与 [`CellSpan`] 同一套列口径：**UTF-16 码元、0-based 右开**，换算只在后端做一次。
/// ⚠️ 但这里**恒为 1 个码元**——GFM 默认（非 relaxed）只认 `' ' | 'x' | 'X'` 三个 ASCII
/// 符号（`comrak-0.56.0/src/parser/mod.rs:2672`），所以打勾是**同长度替换**
/// （`INV-TASK-01`：行数、行尾、两侧文字一个字节都不动）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskSpan {
    /// 行号，**1-based**（与 `BlockSpan` / `CellSpan` 同一口径）。
    pub line: u32,
    /// 行内起点，0-based，UTF-16 码元。
    pub from: u32,
    /// 行内终点，0-based，UTF-16 码元，**右开**（恒等于 `from + 1`）。
    pub to: u32,
    /// 现在已经勾上了吗（`NodeTaskItem.symbol.is_some()`）。
    /// ⚠️ 它是**配对判据**：DOM 里那个方框的 `checked` 与它不一致 ⇒ 说明 DOM 陈旧。
    pub checked: bool,
    /// 能不能翻转。`false` 的项点下去必须**如实告知**（`INV-TASK-05`），⛔ 不猜位置。
    pub writable: bool,
}

/// ⭐ **任务项的方框区间表**（`design/0051` §2.1）：`[(顶层块序号, [方框…]), …]`。
///
/// 与 [`build`] / [`table_cells`] 走**同一个** `root.children()` 枚举（块序号因此逐条对齐），
/// 再对块内 `descendants()` 收集 `NodeValue::TaskItem`——comrak 的 `descendants` 是**先序**，
/// 与渲染出来的 DOM 顺序一致（`html.rs:1246` 一个 `TaskItem` 就写一个 `<input>`）。
///
/// ## 两条判据（⛔ 改之前先读）
///
/// 1. ⚠️ **只用 `symbol_sourcepos`，⛔ 不用节点自己的 `sourcepos`**：
///    `TaskItem` 是**替换** `Item` 节点物化出来的（`parser/mod.rs:2745`），它自己的
///    `sourcepos` 覆盖**整项**（可能多行）；只有 `symbol_sourcepos` 框住那个符号。
///    而它的 `end.column` 是**含端**（`parser/mod.rs:2679` 逐字写着 `- 1`），
///    换算到右开口径是 `[start.column - 1, end.column)`（与 `CellSpan` 的右开口径**不同源**，
///    但落到同一个表示上）。
/// 2. ⚠️ **`FootnoteDefinition` 整块排除**：脚注定义只在被引用时物化，它们的 DOM 全在文末
///    那个 `<section data-footnotes>` 里，**不在自己那一块底下** ⇒ 收进来会让前端
///    "块内复选框数"永远对不上（`INV-TASK-03`）。
pub fn task_items<'a>(root: &'a AstNode<'a>, src: &str) -> Vec<(u32, Vec<TaskSpan>)> {
    let index = crate::document::offset::LineIndex::new(src);
    let mut out = Vec::new();
    for (block_index, node) in root.children().enumerate() {
        if matches!(node.data().value, NodeValue::FootnoteDefinition(_)) {
            continue;
        }
        let mut tasks = Vec::new();
        for n in node.descendants() {
            if let NodeValue::TaskItem(ref nti) = n.data().value {
                tasks.push(task_span(nti, src, &index));
            }
        }
        if !tasks.is_empty() {
            out.push((block_index as u32, tasks));
        }
    }
    out
}

/// ⭐ **两份行事实的交叉断言**（2026-10-29 代码评审第 13 条）。
///
/// `blocks`（块起止行）与 `table_cells` / `task_items`（每格 / 每框的行号）出自
/// **同一次** `root.children()` 枚举，但此前**没有任何东西钉住它们互相一致**：
/// 格子行可以落在它所属块的行区间**之外**，而两侧单独看都"对"。
///
/// ⚠️ 今天它必然为空（两者确实同源），所以本函数的价值**不在今天**，在于：
/// - 它是**可单测的**判据（正面 ＋ 反面各一组，见本文件测试模块）；
/// - 加字段 / 改枚举时，任何一处漂移都会在 `make test` 里**响亮**地红，
///   而⛔ 不是等到用户屏幕上出现"整篇不可编辑"。
///
/// 返回人话描述的违规项；**空 = 一致**。
///
/// 判据三条（⛔ 不是"看起来像"的近似）：
/// 1. 块序号必须落在 `blocks` 的下标范围内，且 `blocks` 是按序号排好的（`index == 下标`）；
/// 2. `table_cells` 指到的块**必须是 `Table`**（`scan_tables` 只收顶层 `Table`，这条把
///    "两边枚举口径已经分叉"变成可测的）；
/// 3. 每个格子 / 方框的行号必须**落在它那个块的行区间内**（1-based 含两端）。
///    ⚠️ 任务项**不查块种类**：它们可以长在 `List`、`BlockQuote`、甚至嵌套列表里，
///    「哪些种类能装任务项」不是一份稳定的清单 ⇒ 查种类会造出假的失败。
pub fn cross_check(
    blocks: &[BlockSpan],
    table_cells: &[(u32, Vec<CellSpan>)],
    task_items: &[(u32, Vec<TaskSpan>)],
) -> Vec<String> {
    let mut out = Vec::new();
    // ① `blocks` 自己先按序号排好（后面两件事都靠"下标 = 序号"）。
    for (i, b) in blocks.iter().enumerate() {
        if b.index != i {
            out.push(format!("块表第 {i} 项的 index 是 {}（应当等于下标）", b.index));
        }
    }
    for (block_index, cells) in table_cells {
        let Some(b) = blocks.get(*block_index as usize) else {
            out.push(format!("table_cells 的块序号 {block_index} 越界（共 {} 块）", blocks.len()));
            continue;
        };
        if b.kind != BlockKind::Table {
            out.push(format!(
                "table_cells 的块 {block_index} 种类是 {}，不是 Table",
                b.kind.name()
            ));
        }
        for (n, c) in cells.iter().enumerate() {
            if c.line < b.start_line || c.line > b.end_line {
                out.push(format!(
                    "块 {block_index} 第 {n} 格在第 {} 行，落在块区间 {}-{} 之外",
                    c.line, b.start_line, b.end_line
                ));
            }
        }
    }
    for (block_index, tasks) in task_items {
        let Some(b) = blocks.get(*block_index as usize) else {
            out.push(format!("task_items 的块序号 {block_index} 越界（共 {} 块）", blocks.len()));
            continue;
        };
        for (n, t) in tasks.iter().enumerate() {
            if t.line < b.start_line || t.line > b.end_line {
                out.push(format!(
                    "块 {block_index} 第 {n} 个方框在第 {} 行，落在块区间 {}-{} 之外",
                    t.line, b.start_line, b.end_line
                ));
            }
        }
    }
    out
}

/// 单个方框的区间换算（见 [`task_items`] 的两条判据）。
fn task_span(
    nti: &comrak::nodes::NodeTaskItem,
    src: &str,
    index: &crate::document::offset::LineIndex,
) -> TaskSpan {
    use crate::document::offset::byte_to_utf16_in_line;

    let sp = nti.symbol_sourcepos;
    let mut span =
        TaskSpan { line: sp.start.line as u32, from: 0, to: 0, checked: nti.symbol.is_some(), writable: false };
    if sp.start.line != sp.end.line {
        return span;
    }
    let Some(line) = index.line_str(src, sp.start.line) else {
        return span;
    };
    // comrak 的列口径：`start.column` 是 1-based 的字节下标，`end.column` 是**含端**。
    let raw_from = sp.start.column.saturating_sub(1);
    let raw_to = sp.end.column;
    if raw_from >= raw_to || raw_to > line.len() {
        return span;
    }
    if !line.is_char_boundary(raw_from) || !line.is_char_boundary(raw_to) {
        return span;
    }
    // ⭐ 符号**恰好一个字节**且是三选一 —— 这是"同长度替换"能成立的全部依据。
    //    relaxed 模式下会出现 `[あ]`（3 字节），那时本条判据把它挡成不可写：
    //    宁可少一个入口，⛔ 也不去猜"替换几个字节"。
    if raw_to - raw_from != 1 {
        return span;
    }
    if !matches!(&line[raw_from..raw_to], " " | "x" | "X") {
        return span;
    }
    let (Some(f), Some(t)) = (
        byte_to_utf16_in_line(line, raw_from),
        byte_to_utf16_in_line(line, raw_to),
    ) else {
        return span;
    };
    span.from = f as u32;
    span.to = t as u32;
    span.writable = true;
    span
}

/// 方框区间表 → **线格式**：`[[block_index, [[line, from, to, checked, writable], …]], …]`。
///
/// ⚠️ 与 [`to_wire`] / [`cells_to_wire`] 同一条理由：`serde_json` 直接吃嵌套数组，
/// ⛔ 不加自定义 `Serialize`；⚠️ 它**不进** `blocks` 四元组——非任务文档一个字节都不多。
pub fn tasks_to_wire(tasks: &[(u32, Vec<TaskSpan>)]) -> Vec<(u32, Vec<(u32, u32, u32, u8, u8)>)> {
    tasks
        .iter()
        .map(|(idx, list)| {
            (
                *idx,
                list.iter()
                    .map(|t| (t.line, t.from, t.to, u8::from(t.checked), u8::from(t.writable)))
                    .collect(),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::parser::{with_parsed, ParseOpts};

    /// 用产品**同一套**解析选项跑一遍（⛔ 不另造一份 opts，否则表里的种类会与 GUI 不一致）。
    fn spans_of(src: &str) -> (Vec<BlockSpan>, usize) {
        let opts = ParseOpts { heading_ids: true, ..Default::default() };
        with_parsed(src, &opts, |root| {
            let index = crate::document::offset::LineIndex::new(src);
            (build(root), index.line_count())
        })
    }

    fn kinds(spans: &[BlockSpan]) -> Vec<&'static str> {
        spans.iter().map(|b| b.kind.name()).collect()
    }

    /// 种类表本身的三条硬性质：长度固定、下标就是枚举值、最后一项是 `Other`。
    ///
    /// ⚠️ 它守的是**线格式的跨版本稳定性**（`design/0047` §3.1.1）：前端按 `block_kinds`
    /// 的下标解包，顺序一动所有块都会**静默错位**（而不是报错）。
    #[test]
    fn 种类表_下标与枚举值一致且兜底项在末尾() {
        assert_eq!(KIND_NAMES.len(), 10);
        for (i, name) in KIND_NAMES.iter().enumerate() {
            let kind = match *name {
                "Paragraph" => BlockKind::Paragraph,
                "Heading" => BlockKind::Heading,
                "CodeBlock" => BlockKind::CodeBlock,
                "List" => BlockKind::List,
                "BlockQuote" => BlockKind::BlockQuote,
                "Table" => BlockKind::Table,
                "HtmlBlock" => BlockKind::HtmlBlock,
                "ThematicBreak" => BlockKind::ThematicBreak,
                "FootnoteDefinition" => BlockKind::FootnoteDefinition,
                "Other" => BlockKind::Other,
                other => panic!("KIND_NAMES 里有认不出的名字：{other}"),
            };
            assert_eq!(kind.index(), i, "下标必须与枚举值一致：{name}");
            assert_eq!(kind.name(), *name);
        }
        assert_eq!(KIND_NAMES[9], "Other", "Other 必须在末尾（前端按它兜底）");
    }

    /// 一个块一条、行号 1-based 含两端、种类按源码顺序。
    #[test]
    fn 顶层块表_顺序与行号_逐块对得上() {
        let src = "# 标题\n\n正文第一段\n\n- 一\n- 二\n\n```rust\nlet x = 1;\n```\n\n> 引用\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n<div>x</div>\n";
        let (spans, line_count) = spans_of(src);

        assert_eq!(
            kinds(&spans),
            vec![
                "Heading",
                "Paragraph",
                "List",
                "CodeBlock",
                "BlockQuote",
                "Table",
                "ThematicBreak",
                "HtmlBlock",
            ],
            "顶层块顺序必须与源码顺序一致（子块不许混进来）"
        );
        // 逐块的行区间（1-based 含两端）——对不上就说明口径变了。
        let ranges: Vec<(u32, u32)> = spans.iter().map(|b| (b.start_line, b.end_line)).collect();
        assert_eq!(
            ranges,
            vec![(1, 1), (3, 3), (5, 6), (8, 10), (12, 12), (14, 16), (18, 18), (20, 20)]
        );
        // ⚠️ 序号是**连续**的 0 起：前端按下标对齐 DOM。
        assert_eq!(
            spans.iter().map(|b| b.index).collect::<Vec<_>>(),
            (0..spans.len()).collect::<Vec<_>>()
        );
        // 源串以 `\n` 结尾 ⇒ 末尾那一行是空的第 N+1 行（与"光标能停到最后一行之后"同一件事）。
        assert_eq!(line_count, 21, "20 行正文 ＋ 结尾换行后的空行 = 21 行");
        // 末块之后的行号不许超出行数。
        assert!(spans.iter().all(|b| (b.end_line as usize) <= line_count));
    }

    /// ⭐ 不可就地编辑的那四族，加上"没见过的种类落 `Other`"。
    #[test]
    fn 可编辑清单_四族不可编辑_其余可编辑() {
        assert!(!inline_editable(BlockKind::Table));
        assert!(!inline_editable(BlockKind::ThematicBreak));
        assert!(!inline_editable(BlockKind::HtmlBlock));
        assert!(!inline_editable(BlockKind::FootnoteDefinition));
        assert!(!inline_editable(BlockKind::Other));

        assert!(inline_editable(BlockKind::Paragraph));
        assert!(inline_editable(BlockKind::Heading));
        assert!(inline_editable(BlockKind::CodeBlock));
        assert!(inline_editable(BlockKind::List));
        assert!(inline_editable(BlockKind::BlockQuote));

        // ⚠️ 反面锚点：十种里**恰好**五种可编辑——加种类时这里会红，
        //    逼人回答"它算哪一半"，⛔ 不是自动落入可编辑。
        assert_eq!(KIND_NAMES.len(), 10);
        let editable = [
            BlockKind::Paragraph,
            BlockKind::Heading,
            BlockKind::CodeBlock,
            BlockKind::List,
            BlockKind::BlockQuote,
            BlockKind::Table,
            BlockKind::HtmlBlock,
            BlockKind::ThematicBreak,
            BlockKind::FootnoteDefinition,
            BlockKind::Other,
        ]
        .iter()
        .filter(|k| inline_editable(**k))
        .count();
        assert_eq!(editable, 5);
    }

    /// ⭐ `FootnoteDefinition` 只有**被引用**时才物化 ⇒ 它必须进表且不可编辑；
    /// 未被引用时它整行是**块间行**（不出现在块表里）。
    ///
    /// 证据与夹具：`design/0047` §7.1.1 的 0a、`tools/live-probe` 的脚注两条。
    #[test]
    fn 脚注定义_被引用才进表且不可编辑() {
        let referenced = "正文[^a]\n\n[^a]: 定义\n";
        let (spans, _) = spans_of(referenced);
        assert_eq!(
            kinds(&spans),
            vec!["Paragraph", "FootnoteDefinition"],
            "被引用时定义要物化成顶层块"
        );
        assert!(!spans[1].editable, "脚注定义不可就地编辑");
        assert_eq!((spans[1].start_line, spans[1].end_line), (3, 3));

        let unreferenced = "正文\n\n[^a]: 定义\n";
        let (spans, _) = spans_of(unreferenced);
        assert_eq!(
            kinds(&spans),
            vec!["Paragraph"],
            "未被引用的脚注定义是整行块间行（⛔ 不该进块表）"
        );
    }

    /// ⭐⚠️ **脚注定义被 comrak 搬到 AST 末尾，而 `sourcepos` 仍指着源码原处**
    /// ⇒ 块表里的行号**不是单调递增的**（`bugs/0037`）。
    ///
    /// 这是一条**跨语言契约**：块序号是 **AST 顺序**，⛔ 不是源码行号顺序。
    /// 前端 `src/live/blocks.js::fromPayload` 因此⛔ 不能拿"行号必须升序"当包完整性判据
    /// （否则整篇拒绝进编辑态，报的还是「块重叠」）；`align()` 也按**块序号**把脚注定义
    /// 映射到文末那个 `<section data-footnotes>`，⛔ 不按行号重排。
    /// ⚠️ 改这里等于改前端的解包前提——`tests/js/live-blocks.test.js` 有同名判据。
    #[test]
    fn 脚注定义在块表末尾而行号回到原位() {
        let src = "正文一[^a]\n\n正文二\n\n[^a]: 定义\n\n正文三\n";
        let (spans, _) = spans_of(src);
        assert_eq!(
            kinds(&spans),
            vec!["Paragraph", "Paragraph", "Paragraph", "FootnoteDefinition"],
            "定义写在源码中间，块表里却排到最后（comrak 的事实，⛔ 不是我们排的）"
        );
        assert_eq!(
            spans
                .iter()
                .map(|b| (b.start_line, b.end_line))
                .collect::<Vec<_>>(),
            vec![(1, 1), (3, 3), (7, 7), (5, 5)],
            "前三块按源码顺序，最后一块是定义的原位置 ⇒ 行号非升序"
        );
    }

    /// `Eol::Other` ⇒ 整篇不可编辑，**行区间一个都不许变**（口径是两条独立的闸）。
    #[test]
    fn eol_为_other_时整篇不可编辑但行区间不变() {
        let src = "# 标题\n\n正文\n\n- 一\n";
        let (spans, line_count) = spans_of(src);
        let normal = to_wire(&spans, false);
        let other = to_wire(&spans, true);

        assert_eq!(normal, vec![(1, 1, 1, 1), (0, 3, 3, 1), (3, 5, 5, 1)]);
        assert_eq!(
            other,
            vec![(1, 1, 1, 0), (0, 3, 3, 0), (3, 5, 5, 0)],
            "⛔ Eol::Other 只压 editable，不碰任何行号"
        );
        assert_eq!(line_count, 6);
        // 行数也要与 `split('\n')` 同口径（`'a\n'` = 2 行）。
        assert_eq!(crate::document::offset::LineIndex::new("a\n").line_count(), 2);
    }

    /// 嵌套结构只出**顶层**那一个：列表项、表格行列都不许出现在块表里。
    #[test]
    fn 嵌套结构只出顶层块() {
        let src = "- 一\n  - 一之一\n- 二\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
        let (spans, _) = spans_of(src);
        assert_eq!(kinds(&spans), vec!["List", "Table"]);
        assert_eq!(spans.len(), 2, "⛔ 子块（Item/TableRow/TableCell）不许进块表");
        assert_eq!(spans[0].kind, BlockKind::List);
        assert_eq!((spans[0].start_line, spans[0].end_line), (1, 3));
    }

    // ── `design/0049`：表格的单元格可写区间 ──────────────────────────────

    fn cells_of(src: &str) -> Vec<(u32, Vec<CellSpan>)> {
        let opts = ParseOpts { heading_ids: true, ..Default::default() };
        with_parsed(src, &opts, |root| table_cells(root, src))
    }

    /// 一行格子的 `(line, from, to, writable)`，方便逐格比对。
    fn flat(cells: &[(u32, Vec<CellSpan>)]) -> Vec<(u32, u32, u32, bool)> {
        cells
            .iter()
            .flat_map(|(_, list)| {
                list.iter().map(|c| (c.line, c.from, c.to, c.writable))
            })
            .collect()
    }

    /// ⭐ 基本口径：只切**修剪后的内容**，两侧填充空格与竖线**不在区间里**（`INV-CELL-01`）。
    ///
    /// `| a | b |` 的格子是**第 2–3** 与 **第 6–7** 个 UTF-16 码元：
    /// ```
    /// 0 1 2 3 4 5 6 7 8
    /// |   a   |   b   |
    /// ```
    #[test]
    fn 单元格区间_只含修剪后的内容() {
        let src = "| a | b |\n|---|---|\n| 1 | 2 |\n";
        let cells = cells_of(src);
        assert_eq!(cells.len(), 1, "一张表一条");
        assert_eq!(cells[0].0, 0, "顶层块序号");
        assert_eq!(
            flat(&cells),
            vec![
                (1, 2, 3, true),
                (1, 6, 7, true),
                (3, 2, 3, true),
                (3, 6, 7, true),
            ],
            "⛔ 分隔行 `|---|---|` 不是格子；⛔ 两侧空格不进区间"
        );
    }

    /// ⭐ 列是 **UTF-16 码元**（`INV-CELL-03`）：中文与 Emoji 上必须与 JS `slice` 对得上。
    #[test]
    fn 单元格区间_列是_utf16_码元() {
        // 「😀」= 2 个 UTF-16 码元、4 个 UTF-8 字节 ⇒ 字节列与码元列在这行里会分叉。
        let src = "| 😀 | 中文 |\n|---|---|\n| x | y |\n";
        let cells = cells_of(src);
        let first: Vec<(u32, u32, u32, bool)> = flat(&cells)[0..2].to_vec();
        // 行：`| 😀 | 中文 |` ⇒ 0='|' 1=' ' 2..4='😀' 5=' ' 6='|' 7=' ' 8..9='中文' 10=' ' 11='|'
        assert_eq!(
            first,
            vec![(1, 2, 4, true), (1, 7, 9, true)],
            "😀 占 2 个码元、中文两字各占 1 个"
        );
        // ⚠️ 反面锚点：同一行按**字节**数是 16（😀 4 字节、中文各 3 字节）⇒ 拿字节列会切进字符中间。
        let line = "| 😀 | 中文 |";
        assert_eq!(line.len(), 17, "字节数");
        assert_eq!(line.encode_utf16().count(), 11, "UTF-16 码元数");
        assert_ne!(line.len(), line.encode_utf16().count(), "这行里字节与码元确实不同");
    }

    /// ⭐⚠️ **省略首尾竖线的合法 GFM 表，每个格子都必须可写**（`bugs/0038`，2026-10-29）。
    ///
    /// 这一条守的是「拿竖线当边界」那个错判据：`a | b` 里第一格的起点就是行首，
    /// 「落在第一个 `|` 之后」对**每一格**都成立 ⇒ 整张表一个可写格都没有，
    /// 而前端报的是「表格缺列，没有对应的源码位置」——**归因完全错**。
    /// ⚠️ 兼容性对照：自动补出来的空格子仍然必须不可写（上一条测试），
    /// 两者一起看才知道新判据没有放宽到"什么都可写"。
    #[test]
    fn 单元格区间_省略首尾竖线的表每格都可写() {
        // 表头与分隔行都省掉首尾竖线 ⇒ 正文行少写一列时仍会发生自动补列。
        let bare = "a | b\n--- | ---\n1 | 2\n";
        let cells = flat(&cells_of(bare));
        assert_eq!(
            cells,
            vec![
                (1, 0, 1, true),
                (1, 4, 5, true),
                (3, 0, 1, true),
                (3, 4, 5, true),
            ],
            "四格都可写，且只切内容（两侧空格与竖线不进区间）"
        );

        // 省首尾竖线 ＋ 正文少一列 ⇒ 补出来的那格仍然不可写。
        let padded = "a | b | c\n--- | --- | ---\n1 | 2\n";
        let flags: Vec<bool> = flat(&cells_of(padded)).iter().map(|c| c.3).collect();
        assert_eq!(
            flags,
            vec![true, true, true, true, true, false],
            "自动补出来的第 3 格不许可写"
        );

        // 只省开头、保留结尾竖线（另一半形状）同样四格可写。
        let half = "a | b |\n--- | --- |\n1 | 2 |\n";
        let cells = flat(&cells_of(half));
        assert_eq!(cells.len(), 4, "⛔ 结尾那个 `|` 不制造第 3 格");
        assert!(cells.iter().all(|c| c.3), "四格都可写：{:?}", cells);
    }

    /// ⭐ 自动补出来的空列**不可写**（`INV-CELL-05`）：它落在最后一个 `|` 之后，
    /// 往里写字会写进**前一格**，而屏幕上看起来"就是那一格"。
    ///
    /// 真实存在的空格子相反——它可以写（插入点是这一格内部的填充位置）。
    #[test]
    fn 单元格区间_自动补的空列不可写_真实空格子可写() {
        // ⚠️ 表头与分隔行必须**同为 3 列**才算一张表（否则整段不是表格）；
        //    真正的自动补发生在**正文行少写**的时候。
        let auto = "| a | b | c |\n|---|---|---|\n| 1 | 2 |\n";
        let cells = cells_of(auto);
        let flags: Vec<bool> = flat(&cells).iter().map(|c| c.3).collect();
        assert_eq!(
            flags,
            vec![true, true, true, true, true, false],
            "⛔ 自动补出来的第 3 列必须标成不可写"
        );

        // 真实空格子：`| a |  |` 的第 2 格两侧都有竖线 ⇒ 可写，且区间是**空**的（插入点）。
        let real = "| a |  |\n|---|---|\n| 1 | 2 |\n";
        let cells = cells_of(real);
        let cells = flat(&cells);
        assert_eq!(cells[1].3, true, "空格子可写");
        assert_eq!(cells[1].1, cells[1].2, "空格子的区间是空区间（插入点）");
        assert!(cells[1].1 >= 5 && cells[1].1 <= 7, "插入点落在这一格内部：{:?}", cells[1]);
    }

    /// ⭐ 转义竖线：`\\|` 在上游已被去转义，但 `sourcepos` 仍是**原文区间** ⇒
    /// 区间必须盖住 `a \| b` 这 6 个码元，写回时才不会把 `\|` 留在外面。
    #[test]
    fn 单元格区间_转义竖线仍在区间内() {
        let src = "| a \\| b | c |\n|---|---|\n| 1 | 2 |\n";
        let cells = cells_of(src);
        assert_eq!(
            flat(&cells)[0],
            (1, 2, 8, true),
            "`a \\| b` 是 6 个码元（`a`、空格、`\\`、`|`、空格、`b`）"
        );
    }

    /// 用产品同一套 opts 渲染成 HTML（下面那条判据要的是**外部事实**，不是我们的区间）。
    ///
    /// ⚠️ comrak 的 formatter 会在标签之间落换行 ⇒ 这里把空白**折成单个空格**再比，
    /// 否则判据会红在排版上而不是语义上（`<td>z|y</td>` 与 `<td>z|y</td>\n<td></td>` 是同一个事实）。
    fn html_of(src: &str) -> String {
        let opts = ParseOpts { heading_ids: true, ..Default::default() };
        let raw = with_parsed(src, &opts, |root| render::to_html(root, &opts));
        raw.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// ⭐⭐ **末尾反斜杠会吃掉右侧分隔竖线，而且"凑成偶数"救不回来**
    /// （`INV-CELL-02` 的第二半，2026-10-28 评审 P1）。
    ///
    /// 这是本族**最阴**的一条：写回时那个 `\` 被当成 `\|` 转义序列 ⇒ 整行少一列，
    /// 右边那一格的字节并进这一格，而 comrak **不报错**——它补出一个空列。
    /// ⚠️ 所以判据⛔ 不能只看行数、也⛔ 不能只看「AST 格子总数」：
    /// 上游的自动补列会把"合并"掩盖成"一切正常"（下面第 ③ 段就是照着这一点钉的）。
    ///
    /// ⚠️⚠️ **根因是 re2c 的最长匹配，⛔ 不是"反斜杠奇偶"**：`scanners::table_cell` 是
    /// `(escaped_char|[^|\r\n])+`（`comrak-0.56.0/src/scanners.re:405`），
    /// 对 `z\\|y` 它会选"`\` 当普通字符 ＋ `\|` 当转义序列"这条**更长**的解析
    /// ⇒ **任意个**反斜杠紧贴 `|` 都会被吃进去。所以修法是**插一个空格**
    /// （`src/live/cell.js::padFor`），⛔ 不是把末尾反斜杠翻倍。
    ///
    /// 哪天 comrak 改了这条语义，这条会红——那时 `padFor` 也该跟着重新取值。
    #[test]
    fn 单元格区间_末尾反斜杠会吃掉右侧分隔竖线_空格才断得开() {
        // ① 坏的那一种：第一格写成 `z\` ⇒ 源码 `|z\|y|` ⇒ **一格** ＋ 自动补的空列。
        let one = html_of("|x|y|\n|---|---|\n|z\\|y|\n");
        assert!(
            one.contains("<td>z|y</td> <td></td>"),
            "1 个末尾反斜杠必须**合并**相邻格：{one}"
        );

        // ② ⚠️ 关键的负结果：翻倍成 `|z\\|y|` **照样合并**（评审报告建议的修法在这里无效）。
        let two = html_of("|x|y|\n|---|---|\n|z\\\\|y|\n");
        assert!(
            two.contains("<td>z\\|y</td> <td></td>"),
            "⛔ 凑成偶数**不解决问题**——照样一格 ＋ 自动补的空列：{two}"
        );

        // ③ 反面锚点：1 个与 2 个反斜杠的**格子总数完全一样**（都是 4 格），
        //    而且第 2 格都标成"自动补的、不可写" ⇒ 只看数量/行数分不出好坏。
        let cells_one = flat(&cells_of("|x|y|\n|---|---|\n|z\\|y|\n"));
        let cells_two = flat(&cells_of("|x|y|\n|---|---|\n|z\\\\|y|\n"));
        assert_eq!(cells_one.len(), 4, "表头 2 格 ＋ 正文 2 格");
        assert_eq!(
            cells_one.len(),
            cells_two.len(),
            "⛔ 两种坏写法的格子数一模一样——这正是「自动补列掩盖合并」"
        );
        assert_eq!(cells_one[3].3, false, "被吃掉之后补出来的那一列必须标成不可写");
        assert_eq!(cells_two[3].3, false, "同上：翻倍也救不回来");

        // ④ ✅ 只有**插一个空格**才断得开：`|z\ |y|` ⇒ 两格各归各位。
        let spaced = html_of("|x|y|\n|---|---|\n|z\\ |y|\n");
        assert!(
            spaced.contains("<td>z\\</td> <td>y</td>"),
            "末尾补一个空格 ⇒ 两格分开，第二格仍是 `y`：{spaced}"
        );
        let cells_spaced = flat(&cells_of("|x|y|\n|---|---|\n|z\\ |y|\n"));
        assert_eq!(cells_spaced[3].3, true, "✅ 修好之后第二格是**真的**内容，可写");

        // ⑤ 有填充空格的表同理（`padFor` 在这种情况下**不该**再补——右边已经是空白）。
        let padded = html_of("| x | y |\n|---|---|\n| z\\ | y |\n");
        assert!(
            padded.contains("<td>z\\</td> <td>y</td>"),
            "已经有一侧填充空格时天然断得开：{padded}"
        );
    }

    /// 多张表：块序号各自独立，格子不串。⛔ 非表格块不出现在这张表里。
    #[test]
    fn 单元格区间_多张表按块序号分条() {
        let src = "| a |\n|---|\n| 1 |\n\n正文\n\n| b |\n|---|\n| 2 |\n";
        let cells = cells_of(src);
        assert_eq!(cells.len(), 2, "两张表两条，段落不出现");
        assert_eq!(cells[0].0, 0);
        assert_eq!(cells[1].0, 2, "第二张表是顶层第 3 个块（序号 2）");
        assert_eq!(cells[0].1.len(), 2, "表头 1 格 ＋ 正文 1 格");
    }

    /// ⭐ 线格式：`[[block_index, [[line, from, to, writable], …]], …]`，⛔ 不加自定义 `Serialize`。
    #[test]
    fn 线格式_单元格区间是嵌套数组() {
        let cells = vec![(
            2u32,
            vec![
                CellSpan { line: 5, from: 2, to: 4, writable: true },
                CellSpan { line: 5, from: 8, to: 8, writable: false },
            ],
        )];
        assert_eq!(
            serde_json::to_string(&cells_to_wire(&cells)).unwrap(),
            "[[2,[[5,2,4,1],[5,8,8,0]]]]"
        );
    }

    // ── `design/0054`：候选校验（`INV-EDITOBJ-03` 第 2 步）──────────────────

    fn vopts() -> ParseOpts {
        ParseOpts { heading_ids: true, ..Default::default() }
    }

    fn verify(
        baseline: &str,
        line: u32,
        block: u32,
        cell: u32,
        replacement: &str,
        candidate: &str,
    ) -> CellVerdict {
        verify_cell_edit(
            &CellEditRequest { baseline, line, block, cell, replacement },
            candidate,
            &vopts(),
        )
    }

    /// `| a | b |\n|---|---|\n| 1 | 2 |\n` 里两个正文格是 `(3,2,3)` 与 `(3,6,7)`。
    const T1: &str = "| a | b |\n|---|---|\n| 1 | 2 |\n";

    #[test]
    fn 候选校验_合法编辑通过() {
        let cand = "| a | b |\n|---|---|\n| 1 | 22 |\n";
        let v = verify(T1, 3, 0, 3, "22", cand);
        assert!(v.ok, "应当通过：{v:?}");
        assert_eq!(v.reason, "");
    }

    /// ⭐⭐ **基线是「本次编辑所基于的最新已提交全文」**（用户 2026-10-28 的明确纠正）。
    ///
    /// 连续改两个格子、**不保存**：第二次的基线是第一次的候选，⛔ 不是打开时那份原文。
    /// ⚠️ 同一条用例里再钉一次反面：拿**原始**全文当基线时，第二次必须被拒
    /// （否则这条判据可以靠"反正总是通过"混过去）。
    #[test]
    fn 候选校验_连续两格未保存_基线跟着最新提交走() {
        let cand1 = "| a | b |\n|---|---|\n| 1 | 22 |\n";
        assert!(verify(T1, 3, 0, 3, "22", cand1).ok, "第一次改第 4 格");

        let cand2 = "| a | b |\n|---|---|\n| 11 | 22 |\n";
        let v = verify(cand1, 3, 0, 2, "11", cand2);
        assert!(v.ok, "第二次拿**上一次的候选**当基线必须通过：{v:?}");

        let wrong = verify(T1, 3, 0, 2, "11", cand2);
        assert_eq!(
            wrong.reason, "candidate_mismatch",
            "⛔ 拿打开时原文当基线 ⇒ 算出来的候选里第 4 格还是 `2` ⇒ 必拒"
        );
    }

    /// ⭐ **前文增删行之后再改表格**：行号跟着**基线**走，⛔ 不绑打开时的行号。
    #[test]
    fn 候选校验_前文增行后行号按基线重算() {
        let shifted = format!("\n{T1}");
        let cand = "\n| a | b |\n|---|---|\n| 1 | 22 |\n";
        let stale = verify(&shifted, 3, 0, 3, "22", cand);
        assert_eq!(stale.reason, "line_mismatch", "旧行号 3 必须被拒");

        let fresh = verify(&shifted, 4, 0, 3, "22", cand);
        assert!(fresh.ok, "新行号 4 必须通过：{fresh:?}");
        // 块序号也得跟着基线（前文多了一个空行不属于任何块 ⇒ 表仍是块 0）
        assert!(verify(&shifted, 4, 0, 3, "22", cand).ok);
    }

    /// ⛔ 换行一定改行结构：早于解析就拒，并给一句准确的话。
    #[test]
    fn 候选校验_替换含换行直接拒() {
        let v = verify(T1, 3, 0, 3, "2\n2", "| a | b |\n|---|---|\n| 1 | 2\n2 |\n");
        assert_eq!(v.reason, "newline");
    }

    /// ⛔ **防伪造**：候选与「基线⊕替换」逐字不符就拒——⛔ 不拿"目标格等于候选里任意一段"当证据。
    #[test]
    fn 候选校验_候选与基线不符时拒() {
        // 目标格写对了，但**别处**被动了 ⇒ 仍然是 candidate_mismatch（⛔ 不是"通过"）。
        let forged = "| X | b |\n|---|---|\n| 1 | 22 |\n";
        let v = verify(T1, 3, 0, 3, "22", forged);
        assert_eq!(v.reason, "candidate_mismatch");
        // ⚠️ 2026-10-29（评审第 21 条）：原来这里断言的是 `v.expected`——那个字段**从没过 IPC**，
        //    已删。判据改成「说清差了多少」：两个字节数都在那句话里（`INV-LOG-01` 只禁正文日志，
        //    这句是**回给界面**的，⛔ 不落盘）。
        assert!(
            v.detail.contains("不是同一份"),
            "candidate_mismatch 必须说清是字节对不上，实际：{}",
            v.detail
        );
    }

    /// ⭐⭐ `bugs/0032` 的形态：末尾反斜杠吃掉分隔竖线 ⇒ 行内少一格 ＋ 自动补列。
    /// 候选**确实是**合法拼接（第 5 条通过），必须由**结构**判据拦住。
    ///
    /// ⚠️ 基线必须**没有填充空格**（`|z|w|`）：有空格时 `z\ ` 里的 `\` 后面跟的是空格，
    /// 天然断得开——那正是 `padFor` 只在 `line.charAt(to) === '|'` 时才补空格的道理。
    #[test]
    fn 候选校验_末尾反斜杠合并邻格时拒() {
        let base = "|x|y|\n|---|---|\n|z|w|\n";
        // 第 3 行 `|z|w|` 的第一格是 `(3,1,2)`；替换成 `z\` ⇒ 源码 `|z\|w|`。
        let cand = "|x|y|\n|---|---|\n|z\\|w|\n";
        let v = verify(base, 3, 0, 2, "z\\", cand);
        assert!(!v.ok, "合并邻格必须被拒");
        assert!(
            v.reason == "table_changed"
                || v.reason == "neighbor_changed"
                || v.reason == "cell_content",
            "结构/邻格/内容三者之一，实际是 {}（{}）",
            v.reason,
            v.detail
        );
        // ⚠️ 这条同时钉住「只比格数拦不住」：合并之后**每行格数仍然一样**
        //    （真实格 1 ＋ 自动补格 1 = 2），区别只在内容与「真实 vs 自动补」状态上。
        let base_row = table_shape_in(base, 0, &vopts()).unwrap().row_sizes;
        let cand_row = table_shape_in(cand, 0, &vopts()).unwrap().row_sizes;
        assert_eq!(base_row, cand_row, "⛔ 格数一样——这正是自动补列掩盖合并的实证");
    }

    /// ✅ 反面锚点：`padFor` 那样**插一个空格**之后，同样的内容通过。
    #[test]
    fn 候选校验_末尾补空格后通过() {
        let base = "|x|y|\n|---|---|\n|z|w|\n";
        let cand = "|x|y|\n|---|---|\n|z\\ |w|\n";
        let v = verify(base, 3, 0, 2, "z\\ ", cand);
        assert!(v.ok, "补空格断得开 ⇒ 通过：{v:?}");
    }

    /// 越界、不可写格、非表格块各自的拒绝理由（⛔ 不许糊成同一个）。
    #[test]
    fn 候选校验_越界与不可写各有理由() {
        let auto = "| a | b | c |\n|---|---|---|\n| 1 | 2 |\n";
        let cand = "| a | b | c |\n|---|---|---|\n| 1 | 2 |x|\n";
        // 第 5 格是自动补出来的空列（`writable=false`）。
        assert_eq!(verify(auto, 3, 0, 5, "x", cand).reason, "not_writable");
        assert_eq!(verify(auto, 3, 0, 9, "x", cand).reason, "baseline_parse");
        assert_eq!(
            verify("正文\n", 1, 0, 0, "x", "正文x\n").reason,
            "baseline_parse",
            "第 0 块不是表格"
        );
    }

    /// 表头格也能改（`| a | b |` 的 `a`），且同一行的邻格一个字节不动。
    #[test]
    fn 候选校验_表头格可改且不碰邻格() {
        let cand = "| aa | b |\n|---|---|\n| 1 | 2 |\n";
        let v = verify(T1, 1, 0, 0, "aa", cand);
        assert!(v.ok, "表头第 1 格：{v:?}");
    }



    fn tasks_of(src: &str) -> Vec<(u32, Vec<TaskSpan>)> {
        let opts = ParseOpts { heading_ids: true, ..Default::default() };
        with_parsed(src, &opts, |root| task_items(root, src))
    }

    /// 扁平的 `(line, from, to, checked, writable)`，方便逐项比对。
    fn flat_tasks(tasks: &[(u32, Vec<TaskSpan>)]) -> Vec<(u32, u32, u32, bool, bool)> {
        tasks
            .iter()
            .flat_map(|(_, list)| list.iter().map(|t| (t.line, t.from, t.to, t.checked, t.writable)))
            .collect()
    }

    /// ⭐ 基本口径：区间**恰好**是方框里那一个字节（`INV-TASK-01`）。
    ///
    /// ```
    /// 0 1 2 3 4 5 6
    /// -   [ ]  待办
    /// ```
    /// `[` 在列 3（1-based）、`]` 在列 5 ⇒ 符号在列 4 ⇒ 0-based `[3, 4)`。
    #[test]
    fn 任务项区间_恰好一个符号字节() {
        let src = "- [ ] 待办\n- [x] 已办\n- [X] 也算了\n";
        let tasks = tasks_of(src);
        assert_eq!(tasks.len(), 1, "三项都在同一个 List 块里");
        assert_eq!(tasks[0].0, 0, "顶层块序号");
        assert_eq!(
            flat_tasks(&tasks),
            vec![
                (1, 3, 4, false, true),
                (2, 3, 4, true, true),
                (3, 3, 4, true, true),
            ],
            "⛔ 只框住方框里那一个字节；`X` 也勾选"
        );
    }

    /// ⭐ 行内位置随列表缩进/有序号而变 —— 必须由后端算，前端⛔ 不去数前缀。
    #[test]
    fn 任务项区间_缩进与有序列表() {
        // 嵌套：外层 2 个空格缩进，内层 4 个。
        let src = "- [ ] 外\n  - [x] 内\n";
        let nested = flat_tasks(&tasks_of(src));
        assert_eq!(nested.len(), 2);
        assert_eq!(nested[0], (1, 3, 4, false, true));
        assert_eq!(nested[1], (2, 5, 6, true, true), "缩进 2 格 ⇒ 符号右移 2");

        // 有序列表：`1. [ ]` ⇒ `[` 在列 4、符号在列 5 ⇒ 0-based `[4, 5)`。
        let ordered = flat_tasks(&tasks_of("1. [ ] 待办\n"));
        assert_eq!(ordered, vec![(1, 4, 5, false, true)]);

        // 引用块里的列表：`> - [x] 引用` ⇒ `>` 与空格各占一列。
        let quoted = flat_tasks(&tasks_of("> - [x] 引用\n"));
        assert_eq!(quoted, vec![(1, 5, 6, true, true)]);
    }

    /// ⭐ 列是 **UTF-16 码元**（`INV-TASK-02`），而这里有一个**结构性事实**值得钉住：
    /// 任务项只能出现在**项内容的最开头**（`parser/mod.rs:2717-2719` 的两条
    /// `previous_sibling().is_none()`），所以符号**前面**永远是 ASCII 的前缀
    /// （`- ` / `  ` / `> ` / `1. `）⇒ 字节列与码元列在这一点上**恒等**。
    /// ⚠️ 符号**后面**才会有中文/emoji，而那部分根本不参与换算。
    #[test]
    fn 任务项区间_列是_utf16_码元() {
        let src = "- [ ] 😀 后\n- [x] 中文\n";
        assert_eq!(
            flat_tasks(&tasks_of(src)),
            vec![(1, 3, 4, false, true), (2, 3, 4, true, true)],
            "后置的 emoji / 中文不许把区间挤歪"
        );
        // 反面对照：这一行**整行**确实有 14 字节 vs 10 码元的差 ⇒ 换算不是恒等映射，
        // 只是**前缀**（符号之前）恰好是 ASCII，于是两种口径在 `[3,4)` 上同值。
        let line = "- [ ] 😀 后";
        assert_eq!(line.len(), 14, "字节数");
        assert_eq!(line.encode_utf16().count(), 10, "UTF-16 码元数");
        assert_eq!(&line[3..4], " ", "符号区间在两种口径下同值（前缀全是 ASCII）");
    }

    /// ⭐ 反面判据：**看着像但不是任务项**的行一个条目都不许出（`INV-TASK-05`）。
    ///
    /// comrak 默认（未开 `relaxed_tasklist_matching`）只认 `' ' | 'x' | 'X'`，
    /// 且方括号里必须恰好一个字符——其余形态连 `TaskItem` 节点都不会物化。
    #[test]
    fn 任务项区间_不像任务项的一律不收() {
        let src = "- [] 空\n- [x ] 多一格\n- [√] 对勾\n- [y] 别的字母\n- [ ] 真任务\n";
        let tasks = flat_tasks(&tasks_of(src));
        assert_eq!(tasks.len(), 1, "只有最后一行是任务项，实得 {tasks:?}");
        assert_eq!(tasks[0], (5, 3, 4, false, true));
    }

    /// ⭐ `FootnoteDefinition` **整块排除**：它的 DOM 全在文末 `<section data-footnotes>` 里，
    /// 不在自己那一块底下 ⇒ 收进来会让"块内复选框数"永远对不上（`INV-TASK-03`）。
    #[test]
    fn 任务项区间_脚注定义整块排除() {
        // ⚠️ 脚注定义必须**被引用**才会物化（`design/0047` §2.2 的实测）。
        let src = "- [ ] 正文里的\n\n引用[^a]\n\n[^a]: - [x] 脚注里的\n";
        let tasks = tasks_of(src);
        assert_eq!(tasks.len(), 1, "只有正文那一个块，实得 {tasks:?}");
        assert_eq!(tasks[0].0, 0);
        assert_eq!(flat_tasks(&tasks), vec![(1, 3, 4, false, true)]);
    }

    /// ⭐ 线格式：`[[block_index, [[line, from, to, checked, writable], …]], …]`。
    #[test]
    fn 线格式_任务项区间是嵌套数组() {
        let tasks = vec![(
            1u32,
            vec![
                TaskSpan { line: 3, from: 3, to: 4, checked: false, writable: true },
                TaskSpan { line: 4, from: 3, to: 4, checked: true, writable: false },
            ],
        )];
        assert_eq!(
            serde_json::to_string(&tasks_to_wire(&tasks)).unwrap(),
            "[[1,[[3,3,4,0,1],[4,3,4,1,0]]]]"
        );
    }

    /// ⭐ **线格式就是把这两个值原样序列化出去**（`design/0047` §3.1.1）。
    ///
    /// ⚠️ 这条断言钉的是**前端解包时真正看到的东西**：`block_kinds` 的顺序与
    /// `blocks` 每一项的形状。⛔ 别改成"断言字段名"——那正是这一版**放弃**的形状
    /// （朴素 JSON 最坏占源码 68.49%）。
    #[test]
    fn 线格式_紧凑元组数组与种类名表() {
        assert_eq!(
            serde_json::to_string(&KIND_NAMES).unwrap(),
            r#"["Paragraph","Heading","CodeBlock","List","BlockQuote","Table","HtmlBlock","ThematicBreak","FootnoteDefinition","Other"]"#
        );

        let spans = [
            BlockSpan {
                index: 0,
                kind: BlockKind::Heading,
                start_line: 3,
                end_line: 3,
                editable: true,
            },
            BlockSpan {
                index: 1,
                kind: BlockKind::Paragraph,
                start_line: 5,
                end_line: 9,
                editable: true,
            },
            BlockSpan {
                index: 2,
                kind: BlockKind::Table,
                start_line: 11,
                end_line: 14,
                editable: false,
            },
        ];
        assert_eq!(
            serde_json::to_string(&to_wire(&spans, false)).unwrap(),
            "[[1,3,3,1],[0,5,9,1],[5,11,14,0]]",
            "⛔ 线格式就是 [kind_idx, start_line, end_line, editable] 的嵌套数组"
        );
        assert_eq!(
            serde_json::to_string(&to_wire(&spans, true)).unwrap(),
            "[[1,3,3,0],[0,5,9,0],[5,11,14,0]]",
            "`Eol::Other` 只压 editable"
        );
    }

    /// ⭐ **渲染形态不是源码**的两族：整段只有一个块级公式的段落、`flow`/`sequence`/`math` 围栏。
    ///
    /// 第一手证据（2026-10-26 用 `document::render` 实地渲出来的顶层 DOM）：
    ///
    /// | 源码 | 顶层 DOM | 块表种类 | 能不能就地改 |
    /// |---|---|---|---|
    /// | `$$ a+b $$` 独占一段 | `<div class="rmd-math-display">` | `Paragraph` | ⛔ |
    /// | `正文 $x$ 正文` | `<p>` | `Paragraph` | ✅ |
    /// | ` ```flow ` | `<div class="rmd-diagram" data-diagram="flow">` | `CodeBlock` | ⛔ |
    /// | ` ```math ` | `<pre><code class="language-math">`（无 `.rmd-code`） | `CodeBlock` | ⛔ |
    /// | ` ```rust ` | `<pre class="rmd-code">` | `CodeBlock` | ✅ |
    ///
    /// ⚠️ 这一条如果缺了，`INV-LIVE-06` 的"错位覆盖"就会真的发生：块表说可编辑，
    /// 而 DOM 那边根本没有对应的 `<p>`/`<pre class="rmd-code">` 可以套。
    #[test]
    fn 渲染形态不是源码的段落与围栏_不可编辑() {
        // ① 独占一段的块级公式 ⇒ `Paragraph` 但不可编辑。
        let (spans, _) = spans_of("$$\na+b\n$$\n");
        assert_eq!(kinds(&spans), vec!["Paragraph"]);
        assert!(!spans[0].editable, "整段就是一个块级公式 ⇒ ⛔ 不可就地编辑");

        // ② 同一段里还有别的内容（含行内公式）⇒ 仍是 `<p>`，可编辑。
        let (spans, _) = spans_of("前面 $x$ 后面\n");
        assert_eq!(kinds(&spans), vec!["Paragraph"]);
        assert!(spans[0].editable, "带行内公式的普通段落照旧可编辑");

        // ③ 一块不可编辑不影响它后面的块（闸是逐节点的，⛔ 不是整篇一刀切）。
        let (spans, _) = spans_of("$$\na+b\n$$\n\n后文\n");
        assert_eq!(kinds(&spans), vec!["Paragraph", "Paragraph"]);
        assert!(!spans[0].editable);
        assert!(spans[1].editable, "公式块之后那段照旧可编辑");

        // ④ 三种围栏：图表两种与 `math` 都不可编辑，普通代码围栏可编辑。
        let (spans, _) = spans_of(
            "```flow\nst=>start: S\ne=>end\nst->e\n```\n\n```sequence\nA->B: x\n```\n\n```math\na+b\n```\n\n```rust\nlet x = 1;\n```\n",
        );
        assert_eq!(kinds(&spans), vec!["CodeBlock"; 4]);
        assert!(!spans[0].editable, "`flow` 围栏渲染成 SVG ⇒ ⛔");
        assert!(!spans[1].editable, "`sequence` 围栏渲染成 SVG ⇒ ⛔");
        assert!(!spans[2].editable, "`math` 围栏不走代码块那条路 ⇒ ⛔");
        assert!(spans[3].editable, "普通围栏照旧可编辑");
    }

    /// 空文档 / 只有空行：块表为空，行数照算。
    #[test]
    fn 空文档_块表为空() {
        let (spans, line_count) = spans_of("");
        assert!(spans.is_empty());
        assert_eq!(line_count, 1, "空串也是 1 行（`LineIndex` 的口径）");

        let (spans, line_count) = spans_of("\n\n\n");
        assert!(spans.is_empty());
        assert_eq!(line_count, 4);
        assert!(to_wire(&spans, false).is_empty());
    }

    // ── 两份行事实的交叉断言（评审第 13 条） ──────────────────────────

    /// 真文档上**必须为空**——这是"两份副本本来就同源"的可执行形式。
    ///
    /// ⚠️ 语料刻意包含三类容易分叉的形状：表格、块引用**里面**的表格（不进 `table_cells`）、
    /// 嵌套列表里的任务项、块引用里的任务项（都进 `task_items`）。
    #[test]
    fn 交叉断言_真文档上为空() {
        let src = "| a | b |\n|---|---|\n| 1 | 2 |\n\n\
                   > | c | d |\n> |---|---|\n> | 3 | 4 |\n\n\
                   - [ ] 一\n  - [x] 二\n\n\
                   > - [ ] 引用里的\n\n\
                   后面一段\n";
        let opts = ParseOpts { heading_ids: true, ..Default::default() };
        with_parsed(src, &opts, |root| {
            let blocks = build(root);
            let cells = table_cells(root, src);
            let tasks = task_items(root, src);
            // 非空的前置事实：语料真的覆盖到了那两条路径（否则这条测试是空转）。
            assert_eq!(cells.len(), 1, "只有顶层那张表进 `table_cells`");
            assert_eq!(cells[0].1.len(), 4, "表头行 ＋ 一行正文 = 4 格（分隔行不是格子）");
            assert_eq!(tasks.len(), 2, "`List` 与 `BlockQuote` 各一份");
            assert_eq!(tasks[0].1.len() + tasks[1].1.len(), 3, "三个方框");
            assert_eq!(cross_check(&blocks, &cells, &tasks), Vec::<String>::new());
        });
    }

    /// 反过来：**分叉了必须说出来**，而且三类各自报得出。
    ///
    /// ⚠️ 这条是上一条的**负对照**——没有它，`cross_check` 永远返回空也能算"通过"。
    #[test]
    fn 交叉断言_三类分叉都报得出来() {
        let blocks = vec![
            BlockSpan {
                index: 0,
                kind: BlockKind::Paragraph,
                start_line: 1,
                end_line: 3,
                editable: true,
            },
            BlockSpan {
                index: 1,
                kind: BlockKind::Table,
                start_line: 5,
                end_line: 8,
                editable: false,
            },
        ];
        let cells = vec![
            // ① 块序号越界
            (
                9u32,
                vec![CellSpan { line: 1, from: 0, to: 1, writable: true }],
            ),
            // ② 指到的块不是 Table
            (
                0u32,
                vec![CellSpan { line: 1, from: 0, to: 1, writable: true }],
            ),
            // ③ 行号落在块区间之外（块 1 是 5–8，这里写第 4 行）
            (
                1u32,
                vec![CellSpan { line: 4, from: 0, to: 1, writable: true }],
            ),
        ];
        let tasks = vec![(
            1u32,
            vec![TaskSpan { line: 9, from: 0, to: 1, checked: false, writable: true }],
        )];
        let got = cross_check(&blocks, &cells, &tasks);
        assert_eq!(got.len(), 4, "四条都要报：{got:?}");
        assert!(got.iter().any(|s| s.contains("块序号 9 越界")), "{got:?}");
        assert!(
            got.iter().any(|s| s.contains("不是 Table")),
            "种类不符必须单独说：{got:?}"
        );
        assert!(got.iter().any(|s| s.contains("第 4 行")), "{got:?}");
        assert!(got.iter().any(|s| s.contains("第 9 行")), "{got:?}");

        // ④ 块表自己没按序号排好也要报（后面两件事都靠"下标 = 序号"）。
        let bad = vec![BlockSpan {
            index: 7,
            kind: BlockKind::Paragraph,
            start_line: 1,
            end_line: 1,
            editable: true,
        }];
        assert_eq!(cross_check(&bad, &[], &[]).len(), 1);
    }
}
