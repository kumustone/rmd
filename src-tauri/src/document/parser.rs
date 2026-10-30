//! comrak 封装。
//!
//! **选项只有一个来源**（本文件的 [`ParseOpts::to_comrak`]）。⛔ 不要在各个调用点
//! 各写一份 `Options`——那样"CLI 与 GUI 口径一致"就靠自觉了。

use comrak::nodes::{AstNode, NodeValue};
use comrak::{parse_document, Arena, Options};

/// 本项目的解析/渲染选项。
///
/// ⚠️ 之所以包一层而不是直接用 `comrak::Options`：`comrak::Options` 是
/// `#[non_exhaustive]` 风格的演进目标，字段会随版本改名（0.56 就把 `unsafe_`
/// 挪成了 `render.r#unsafe`）。包一层之后，升级要改的地方只有这一个函数。
#[derive(Debug, Clone, Copy)]
pub struct ParseOpts {
    /// 让 comrak 在 HTML 里输出 `data-sourcepos="L:C-L:C"`。
    ///
    /// ⚠️ 它**不是**白给的：实测会让 HTML 变长（`design/0002` §7.0 步骤 2 要的就是这个数）。
    pub render_sourcepos: bool,
    /// 让 `sourcepos` 的**列**按 Unicode 字符数计，而不是按 UTF-8 字节数计。
    ///
    /// 默认 `false` = **按字节**（`docs/kb/0002`）。中文一个字 3 字节，所以两种口径
    /// 差三倍——`design/0002` §7.0 步骤 5 就是在验证这件事。
    pub sourcepos_chars: bool,
    /// 让 comrak **自己**给标题输出 `id`（`extension.header_id_prefix = Some("")`）。
    ///
    /// ⚠️ 代价：它**同时**会给每个标题套一个
    /// `<a href="#id" aria-label="Link to heading '…'" data-heading-content="…">`。
    /// 这条路的收益是"锚点 ID 与 `toc` 模块算出来的完全一致"，
    /// 成本是 HTML 变长——两边都由 `design/0002` §7.0 步骤 2/3 的数字说话。
    pub heading_ids: bool,
    /// 开 `$…$` / `$$…$$` 定界符（`design/0007` §2.1.2）。
    ///
    /// ⭐ **出厂就是开的**（这也是 `ParseOpts` 手写 `Default` 的唯一原因）。
    /// ⚠️ 代价有两处，都是被接受的可见变化（`design/0007` §4）：
    /// ① 正文里成对出现的 `$` 会变成公式；② **含公式的标题，目录文字与 ID 都会变**
    /// ——后者是因为 `math_dollars` 一开，标题里那个 `$…$` 就成了一个 `Math` 节点，
    /// 而 `toc.rs` 取的是节点的 `literal`（`docs/research/notes/0009` §2.7 的 24/24 对照）。
    /// ⛔ **不开 `math_latex`**：验收样本全文只用 `$`（§2.1.2 的一手理由）。
    pub math_dollars: bool,
    /// 让**软换行**（段落内的单个换行）渲染成 `<br />`（`design/0008` §2.1(1)）。
    ///
    /// ⭐ **出厂就是开的**——这是"与基准（马克飞象）/ Typora 一致"的直接要求
    /// （`docs/research/notes/0008` 的元素级对照）。⚠️ 代价见 `design/0008` §4：
    /// 它作用于**所有**软换行，包括中文段落里正常的折行与用户为编辑方便折的行。
    ///
    /// ⛔ **只作用于软换行**（`INV-SYNTAX-02`）：行尾两空格 / 反斜杠那种**硬换行**
    /// 走的是另一个节点（`NodeValue::LineBreak`），它**默认就已经是 `<br>`**，
    /// 本字段碰不到它（一手依据：`comrak-0.56.0/src/html.rs` 的 `render_soft_break()`
    /// 只处理 `SoftBreak`）。
    ///
    /// ⚠️ **为什么做成字段而不是在 `to_comrak()` 里写死一行**：它与另外四个字段同属
    /// "**口径**"——`design/0002` §10.2 落盘的 17 文件数字要能被复现，
    /// 就必须有一个开关把口径拨回当时那一侧（`cli/bench.rs` / `cli/probe.rs` 显式传
    /// `false`，与 `math_dollars` 的处理同形）。
    pub hardbreaks: bool,
}

impl Default for ParseOpts {
    fn default() -> Self {
        Self {
            render_sourcepos: false,
            sourcepos_chars: false,
            heading_ids: false,
            // ⭐ 公式出厂即开（`design/0007` §2.1.2）。⛔ 别改成 `false`——
            //    `design/0002` 以来的一切默认值靠的是"这里手写"，不是 derive。
            math_dollars: true,
            // ⭐ 单换行断行出厂即开（`design/0008` §2.1(1)、§9.3 第 1 条）。
            hardbreaks: true,
        }
    }
}

impl ParseOpts {
    /// `sourcepos` 的列用哪个单位——**唯一**的换算依据，⛔ 别在调用点各写一遍。
    pub fn col_unit(&self) -> super::offset::ColUnit {
        if self.sourcepos_chars {
            super::offset::ColUnit::Chars
        } else {
            super::offset::ColUnit::Bytes
        }
    }

    /// 构造 comrak 选项。
    ///
    /// ⛔ **INV-SEC-01：安全选项从第一行代码起就在安全的那一侧。**
    /// comrak 0.56 里控制裸 HTML 透传的字段叫 **`options.render.r#unsafe`**
    /// （⚠️ 老教程里的 `options.unsafe_` 字段**已经不存在了**），
    /// 且 `Options::default()` 本身就是安全值。所以这里的纪律是
    /// **「永远不要把它设成 `true`」**，而不是「记得关掉它」——
    /// 前者不需要记得，后者会忘。
    pub fn to_comrak(&self) -> Options<'static> {
        let mut o = Options::default();

        // —— GFM 扩展：与 `docs/vision/0001` 承诺的能力对齐 ——
        o.extension.table = true;
        o.extension.strikethrough = true;
        o.extension.tasklist = true;
        o.extension.autolink = true;
        o.extension.footnotes = true;

        // ⭐ **任务列表的 class 必须开**（`design/0005` §2.3.1「任务列表（GFM）：
        // 复选框的样式与对齐」）。comrak 0.56 的 `render.tasklist_classes` **默认 false**，
        // 不开时输出 `<li><input type="checkbox" …>`——**没有 `task-list-item`**，
        // 于是 `src/styles/typography.css` 里那条 `li.task-list-item { list-style: none }`
        // **永远匹配不上**，UA 的 `•` 与复选框**同时**出现（实测：`• ☑ 已完成事项`）。
        // ⚠️ 这是**静默失效**：CSS 语法没错、浏览器不报错、单测也不红，只有看图才知道。
        // 开了之后顺带得到 GitHub 同名的 `contains-task-list`，将来代码高亮/锚点也用得上
        //（`adr/0003` 里「在 HTML 里预留可识别标记」的路子）。
        o.render.tasklist_classes = true;

        // —— 源码位置（本项目的地基，见 `docs/kb/0002`）——
        o.parse.sourcepos_chars = self.sourcepos_chars;
        o.render.sourcepos = self.render_sourcepos;
        if self.heading_ids {
            // `Some("")` = 不加前缀，即 GitHub 风格
            o.extension.header_id_prefix = Some(String::new());
        }

        // —— 数学公式（`design/0007` §2.1.2）——
        // ⚠️ 只开 `math_dollars`：`$…$` 与 `$$…$$` 由 comrak 扫，**定界符扫描**与
        // "代码围栏/行内代码里不算公式"两件事是免费拿到的（`design/0007` §2.2 备选 C 否决自造扫描器的理由）。
        o.extension.math_dollars = self.math_dollars;

        // —— 换行（`design/0008` §2.1(1)）——
        // ⭐ 软换行 ⇒ `<br />`。⛔ 它**只**走 `render_soft_break()`，硬换行（行尾两空格 /
        //    反斜杠）是 `LineBreak` 节点、默认本来就是 `<br>`，两者互不影响（`INV-SYNTAX-02`）。
        o.render.hardbreaks = self.hardbreaks;
        // ⛔ 绝不出现 `o.render.r#unsafe = true;`
        o
    }
}

/// 解析整份文档。
///
/// 返回的 `&'a AstNode<'a>` 借自 `arena`——arena 必须比它活得久，这是 comrak 的
/// 固有形状（`design/0002` §7.0 步骤 1 已确认它没有增量入口）。
///
/// ⭐ **返回前无条件清洗一次指令段落**（`design/0008` §2.1(2)）——
/// 于是 `toc.rs` / `render.rs` / 所有调用点看到的**都是清洗过的 AST**，
/// ⛔ 不需要每个调用点各记一次。
///
/// ⭐ **`design/0026` 起再多一道链接改写**：`file:` / `javascript:` / `data:` / `vbscript:`
/// 在渲染时会被 comrak 清成**没有 href**（`dangerous_url`，`kb/0005`），原值**不可恢复**
/// ⇒ 只能在渲染**之前**把它们写成受控标记（[`rewrite_link_urls`]）。
/// ⚠️ 与清洗一样**无条件**：不是"GUI 才要"的可选项——CLI 与 GUI 看到同一份 AST。
///
/// ⭐ **`bugs/0035` 起还有第三道：表格单元格内的 `<br>` → 换行**（[`honor_cell_line_breaks`]）。
/// 它只遍历 `Table` 子树、只认 `HtmlInline` 节点，⛔ 不碰 `render.unsafe`；
/// 段外的 `<br>` 行为一个字节都没变（仍是 comrak 默认的"整段丢弃"）。
/// ⚠️ **前端 `live/cell.js::decode` 必须跟它同口径**（`bugs/0040`）：代码 span 里的
/// `<br>` 是 `Code` 节点、**不**在这一道里，那边也⛔ 不许解码成换行。
pub fn parse<'a>(arena: &'a Arena<'a>, src: &str, opts: &ParseOpts) -> &'a AstNode<'a> {
    let root = parse_document(arena, src, &opts.to_comrak());
    strip_directives(root, src, opts);
    rewrite_link_urls(root);
    honor_cell_line_breaks(root);
    root
}

// ————————————————————————————————————————————————————————————————————————————
// 单元格里的 `<br>`（`bugs/0035`，2026-10-28 用户需求）
// ————————————————————————————————————————————————————————————————————————————

/// 把**表格单元格内**的 `<br>` 从裸 HTML 节点换成真正的换行节点。
///
/// **为什么需要这一道**：`INV-SEC-01` 把 `render.unsafe` 永久关着，comrak 对裸 HTML
/// 的默认处置是**整段丢弃**（`<!-- raw HTML omitted -->`）⇒ 单元格里的 `<br>` 既不渲染
/// 成换行、也不报错，用户只会看到两段文字粘在一起。
///
/// **为什么只认单位格**：GFM 的单元格写不进字面换行（`design/0049` §4），
/// `<br>` 是那里**唯一**的换行表示；而普通段落里"换行"已经有两条现成通道
/// （软换行 ＋ 行尾两空格/反斜杠的硬换行），再让 `<br>` 也在段外生效就是**改了既有语义**。
/// ⇒ 范围收窄到 `Table` 子树，段外的 `<br>` 行为一个字节都不动（仍是丢弃，有断言钉住）。
///
/// **为什么不是"渲染时放行 HTML"**：那等于把 `<img onerror=…>` 的原样透传也一起打开；
/// 这里只认 `<br>` / `<br/>` / `<br />`（大小写不敏感）这**一种**字面量，其余仍然丢弃。
fn honor_cell_line_breaks<'a>(root: &'a AstNode<'a>) {
    for table in root.descendants() {
        if !matches!(table.data.borrow().value, NodeValue::Table(_)) {
            continue;
        }
        for cell in table.descendants() {
            let is_br = {
                let data = cell.data.borrow();
                match &data.value {
                    NodeValue::HtmlInline(h) => is_br_literal(h),
                    _ => false,
                }
            };
            if is_br {
                // ⚠️ 只换 `value`：`sourcepos` 原样留着（写回与定位都靠它）。
                cell.data.borrow_mut().value = NodeValue::LineBreak;
            }
        }
    }
}

/// `"<br>"` / `"<br/>"` / `"<br />"`（大小写不敏感，尖括号内允许空白与一个 `/`）。
fn is_br_literal(literal: &str) -> bool {
    let s = literal.trim();
    if s.len() < 4 || !s.starts_with('<') || !s.ends_with('>') {
        return false;
    }
    let inner = s[1..s.len() - 1].trim_end_matches('/').trim_end();
    inner.eq_ignore_ascii_case("br")
}

// ————————————————————————————————————————————————————————————————————————————
// 链接改写（`design/0026` §2.4、`INV-LINK-07`）
// ————————————————————————————————————————————————————————————————————————————

/// 把 `Link` / `Image` 节点的 `url` 改写成受控标记。
///
/// ⚠️ **四种危险 scheme 一起救**（评审 `P1-1`）：`dangerous_url()` 对
/// `d/f/j/v` 是同一套处理；只救 `file:` 会让 `javascript:` 渲染成**没有 href**，
/// 前端拿到空串 ⇒ 用户看到"滚到文首"，而不是"不支持的链接类型"。
///
/// ⚠️ **⛔ 不开 `render.unsafe`**：标记前缀 `rmd-` 的 `r` 不命中那道 DFA 的首字符集。
/// ⚠️ **只做词法**（⛔ 不 `canonicalize`）：打开文档时⛔ 不为每条 `file:` 链接探一次存在性。
/// ⚠️ 改写**不是授权、也不是信任**（`INV-LINK-10`）：作者可以手写同样的标记，
/// 它照样要过 `check_readable`。
fn rewrite_link_urls<'a>(root: &'a AstNode<'a>) {
    for node in root.descendants() {
        let mut data = node.data.borrow_mut();
        // ⚠️ `Link` 与 `Image` 的载荷**同形**（都是 `Box<NodeLink>`）⇒ 一条分支共用
        let url = match &mut data.value {
            NodeValue::Link(link) | NodeValue::Image(link) => &mut link.url,
            _ => continue,
        };
        if let Some(rewritten) = crate::link::rewrite_link_url(url) {
            *url = rewritten;
        }
    }
}


// ————————————————————————————————————————————————————————————————————————————
// 指令段落清洗（`design/0008` §2.1(2)、`INV-SYNTAX-01`）
// ————————————————————————————————————————————————————————————————————————————

/// 摘掉"**整段恰好是一条指令**"的顶层段落（`[TOC]` / `@(笔记本)[标签]`）。
///
/// ⛔ **只认顶层**（`root.children()`，⛔ **不是** `descendants()`）——引用块 / 列表项里的
/// `> [TOC]` 原样保留（那里出现它多半是**在讨论这个语法**，`design/0008` §2.1 记成已知边界）。
/// ⛔ **不做子串替换**——`关于 [TOC] 的说明` 必须原样留着。
///
/// ⭐ **判定分两层，层序是"先结构、后原文"**（§2.1(2) 的细则）：
/// ①【结构】顶层 `Paragraph`，且**全部子节点都是 `Text`**（没有 `Link` / `Code` /
///   `Strong` / `Emph` / `Math`…）⇒ 挡掉"只是提到它"的那些写法；
/// ②【原文】该段落 **`sourcepos` 的原文切片**去首尾空白后逐字满足指令的两种形态之一。
///
/// ⚠️⚠️ **② 必须用原文切片，⛔ 不能用 `Text` 的字面量或 `collect_text()`**——
/// `Text` 的字面量在**转义**（`\[TOC\]` → `[TOC]`）与**实体**（`&#91;TOC&#93;` → `[TOC]`）
/// 下都会变样，与真指令**无法区分**，于是作者刻意要显示的字面文本会被**静默吃掉**
/// （`design/0008` §1.6 的实测表、`docs/kb/0017` 的 13 行对照）。
/// ⭐ 换成原文切片之后，"转义与实体天然保守"是**免费**得到的，⛔ 不需要再加一条排除规则。
///
/// ⚠️ 切片必须取**段落**的 `sourcepos`，⛔ **不能取那个 `Text` 节点的**——
/// 合并后的文本节点 `sourcepos` **不对称**（前导反斜杠被切掉、尾随的留下），
/// 实测 `\@(笔记本)[标签]` 的文本节点切片**恰好等于**字面量 ⇒ 会**误判成指令**（kb/0017）。
///
/// ⚠️ **代价**：② 需要一份 `LineIndex`（全篇一次 O(n) 扫描）⇒ 设计成**两趟**：
/// 先在 AST 上挑候选（① **完全不碰源文本**），
/// **只有真的存在候选段落时才建 `LineIndex`**。普通文档**零额外开销**
/// ——⭐ 见 [`has_directive_candidate`] 对"候选"的收窄及其理由。
fn strip_directives<'a>(root: &'a AstNode<'a>, src: &str, opts: &ParseOpts) {
    // 第 1 趟：只挑候选，完全不碰源文本。
    let candidates: Vec<&'a AstNode<'a>> = root
        .children()
        .filter(|n| has_directive_candidate(n))
        .collect();
    if candidates.is_empty() {
        return; // ⛔ 到这里就返回：不建 LineIndex、不切片
    }

    // 第 2 趟：到这一步才建索引——候选为空时上面就返回了。
    let index = super::offset::LineIndex::new(src);
    for node in candidates {
        let sp = node.data().sourcepos;
        let Some(raw) = index.slice(src, &sp, opts.col_unit()) else {
            continue; // 位置不可用（如合成节点）⇒ 保守：不摘
        };
        if is_directive_text(raw.trim()) {
            // ⚠️ `detach()` 之后这个段落**根本不渲染** ⇒ DOM 里连元素都没有。
            //    这正是 `design/0008` §6 那条"搜索命中无处可落"的成因——
            //    ⛔ 不是"命中一个零高度的块"。
            node.detach();
        }
    }
}

/// 这个**顶层**节点是不是"可能是指令"的候选段落。
///
/// ⭐ **公开给测试**：`strip_directives` 在"一个候选都没有"时**直接返回**，
/// 于是这条判据就是"**要不要建 `LineIndex`**"的可观察形态
/// （`design/0008` §7 要求"用函数提前返回的形态断言，⛔ 别写成'看着没慢'"）。
///
/// 判据 = ①（结构）**全部子节点都是 `Text`** ∧ ②（粗筛）某段文本里**出现 `[` 或 `@`**。
///
/// ⚠️⚠️ **② 只用于"减少工作量"，⛔ 一句话也不参与判定**——判定看的是**原文切片**
/// （见 [`strip_directives`]）。它之所以是**安全的必要条件**：转义（`\[` → `[`）与实体
/// （`&#91;` → `[`）都会让**字面量**里出现同样的字符，也就是说
/// 「字面量里既没有 `[` 也没有 `@`」⇒「原文里也没有」。
/// ⭐ 少了它，**任何一段普通散文**（顶层、全 `Text`）都会成为候选 ⇒
/// 每份文档都要白建一次 `LineIndex`，`design/0008` §2.1(2) 那句"普通文档零额外开销"
/// 就成了空话（语料里最普通的 `XL-plain.md` 正是这个形状）。
fn has_directive_candidate<'a>(node: &'a AstNode<'a>) -> bool {
    let data = node.data();
    if !matches!(data.value, NodeValue::Paragraph) {
        return false;
    }
    drop(data);

    let mut mentions = false;
    for child in node.children() {
        match child.data().value {
            NodeValue::Text(ref t) => {
                if t.contains('[') || t.contains('@') {
                    mentions = true;
                }
            }
            // ① 结构：只要有一个非 `Text` 子节点，**立刻**不是候选。
            //    ⚠️ 必须在循环里 `return false`（⛔ 不能先记下 `mentions` 再判），
            //    否则"文本 + 行内代码"那种段落会被当成候选——**结论仍是对的**
            //    （切片那关会拒），但白建一次索引。
            _ => return false,
        }
    }
    mentions
}

/// 去首尾空白后的**原文切片**是不是一条指令。
///
/// 两种形态（`design/0008` §2.1(2)）：`[TOC]`（**仅 ASCII** 大小写不敏感）
/// 或 `@(<不含 ')' 的文本>)[<不含 ']' 的文本>]`。
///
/// ⚠️ **多行段落自动不是指令**：切片里带着 `\n` ⇒ 对不上那个单行字面量 ⇒ 不摘
/// （保守方向，`design/0008` §2.1 记成已知边界）。
/// ⚠️ `@(…)` 里含 `)` 的笔记名按**第一个 `)`** 收尾 ⇒ 那一段**不被摘**（保守方向）。
fn is_directive_text(trimmed: &str) -> bool {
    if trimmed.eq_ignore_ascii_case("[TOC]") {
        return true;
    }

    // `@(<不含 ')'>)[<不含 ']'>]` —— 逐段剥，剥不出来就不是。
    let Some(rest) = trimmed.strip_prefix("@(") else {
        return false;
    };
    let Some(close) = rest.find(')') else {
        return false;
    };
    let after = &rest[close + 1..];
    let Some(inner) = after.strip_prefix('[') else {
        return false;
    };
    let Some(inner) = inner.strip_suffix(']') else {
        return false;
    };
    // ⚠️ 这一句不能省：`[<不含 ']' 的文本>]` 是**恰好一对**中括号，
    //    `@(x)[a][b]` 剥完还剩 `][`，那不是这个语法。
    !inner.contains(']')
}

/// 解析并在同一个 arena 上跑 `f`。
///
/// 用来避免每个调用点都手写 `let arena = Arena::new();` 再自己管生命周期。
/// `R` 必须是**拥有所有权**的类型——`f` 拿到的 `&AstNode` 借自局部 arena，
/// 借用不出这个函数。
pub fn with_parsed<R>(src: &str, opts: &ParseOpts, f: impl for<'a> FnOnce(&'a AstNode<'a>) -> R) -> R {
    let arena = Arena::new();
    let root = parse(&arena, src, opts);
    f(root)
}

/// ⭐ **本项目的开关矩阵**——只在测试里编译。
///
/// ⚠️ 放在 `impl ParseOpts` 而不是某个 `mod tests` 里（`design/0007` §3 的
/// `all_opts()` 条目）：`document::diagram` 那条"结尾换行只在 `compact_html` 关着时才对"
/// 的断言也要跑同一份矩阵，⛔ 两份矩阵迟早会分叉。
///
/// ⚠️ **新增 `ParseOpts` 字段时加到这里**，否则安全断言会漏掉新组合。
/// ⛔ **不许把它硬编码成一份"预先算好"的组合清单**——它的形态就是"每个字段一层 `for`"，
/// 加字段 = 多一层循环（`design/0008` §7 的矩阵注）。**现在是 5 个 bool ⇒ 32 组**
/// （`design/0008` 之前是 4 ⇒ 16；⚠️ 再往前 `design/0007` 之前是 3 ⇒ 8）。
#[cfg(test)]
impl ParseOpts {
    pub fn all_opts() -> Vec<ParseOpts> {
        let mut v = Vec::new();
        for &render_sourcepos in &[false, true] {
            for &sourcepos_chars in &[false, true] {
                for &heading_ids in &[false, true] {
                    for &math_dollars in &[false, true] {
                        for &hardbreaks in &[false, true] {
                            v.push(ParseOpts {
                                render_sourcepos,
                                sourcepos_chars,
                                heading_ids,
                                math_dollars,
                                hardbreaks,
                            });
                        }
                    }
                }
            }
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⛔ **INV-SEC-01 的回归测试**（`design/0002` §5、§7.2 第 6 条的 Rust 侧）。
    ///
    /// **为什么必须有**：这条不变量此前**靠"没人去设 `r#unsafe`"成立**，
    /// 也就是说**没有任何东西守着它**。将来有人为某份文档"看起来正常"而
    /// 在 `to_comrak()` 里加一行 `o.render.r#unsafe = true`，其它测试照样全绿
    /// （只是 HTML 变长一点），而项目已经不设防了。这条让那行改动**立刻变红**。
    ///
    /// ⚠️ **它只覆盖 Rust 渲染层。** `design/0002` §7.2 第 6 条要的是
    /// "**无脚本执行**"——那还要 GUI 侧（DOM 里真的没有可执行内容）才算完。
    #[test]
    fn 危险_html_在任何选项组合下都不透传() {
        let hostile = "<script>alert(1)</script>\n\n\
                       <img src=x onerror=alert(1)>\n\n\
                       <iframe src=\"https://evil.example\"></iframe>\n\n\
                       [点我](javascript:alert(1))\n\n\
                       [正常](https://example.com/ok)\n";

        for opts in ParseOpts::all_opts() {
            let html =
                with_parsed(hostile, &opts, |root| crate::document::render::to_html(root, &opts));

            // ① 可执行的标签/属性一个都不许出现在输出里
            for tag in ["<script", "<iframe", "onerror=", "<img"] {
                assert!(
                    !html.contains(tag),
                    "INV-SEC-01 被破坏：输出里出现了 {tag:?}（opts={opts:?}）\n{html}"
                );
            }
            // ② 危险协议不许出现在 href/src 里
            assert!(
                !html.contains("javascript:"),
                "INV-SEC-01 被破坏：输出了 javascript: 协议（opts={opts:?}）\n{html}"
            );
            // ③ 正常链接**必须**还在——否则上面两条可以靠"整篇都不渲染"作弊通过
            assert!(
                html.contains("https://example.com/ok"),
                "安全断言不能靠「什么都不渲染」通过：正常链接也不见了（opts={opts:?}）\n{html}"
            );
            // ④ 链接文字仍在：裸 HTML 的语义是"整段丢弃"，不是"把整行吃掉"
            assert!(html.contains("点我"), "链接文字应当保留（opts={opts:?}）\n{html}");
        }
    }

    /// `render_sourcepos` 与标题 `id` **各自**要能独立开关——
    /// 它们影响的是 HTML 体积，而 `design/0002` §7.0 步骤 3 要分别量这两个数。
    /// 这条防止将来有人把它们耦合成"要么都开要么都关"。
    #[test]
    fn 两个渲染开关互不耦合() {
        let src = "# 标题\n\n正文\n";

        let none = with_parsed(src, &ParseOpts::default(), |r| {
            crate::document::render::to_html(r, &ParseOpts::default())
        });
        assert!(!none.contains("data-sourcepos"), "默认不该有 sourcepos");
        assert!(!none.contains("id=\""), "默认不该有标题 id");

        let only_sp = ParseOpts { render_sourcepos: true, ..Default::default() };
        let sp = with_parsed(src, &only_sp, |r| crate::document::render::to_html(r, &only_sp));
        assert!(sp.contains("data-sourcepos"), "开了 sourcepos 就该有");
        assert!(!sp.contains("id=\"user-content-"), "sourcepos 不该顺带带出标题 id");

        let only_id = ParseOpts { heading_ids: true, ..Default::default() };
        let id = with_parsed(src, &only_id, |r| crate::document::render::to_html(r, &only_id));
        assert!(!id.contains("data-sourcepos"), "标题 id 不该顺带带出 sourcepos");
        assert!(id.contains("id=\""), "开了 heading_ids 就该有 id");
    }

    /// ⭐ 任务列表**必须带上 class**（`design/0005` §2.3.1）。
    ///
    /// **为什么必须有这条**：`src/styles/typography.css` 里有
    /// `li.task-list-item { list-style: none; }`——它靠的就是 comrak 输出的这个 class。
    /// 而 comrak 0.56 的 `render.tasklist_classes` **默认 false**，一旦有人把
    /// `to_comrak()` 里那行删了，**CSS 语法没错、浏览器不报错、页面照样渲染**，
    /// 只是每个任务项前面多出一个 UA 的 `•`（看着像 `• ☑ 已完成事项`）。
    /// 这类静默失效只能靠断言守住 ⇒ 删掉那行时**这条立刻变红**。
    #[test]
    fn 任务列表带_task_list_item_class() {
        let src = "- [x] 已完成事项\n- [ ] 待办事项\n";
        let opts = ParseOpts::default();
        let html = with_parsed(src, &opts, |r| crate::document::render::to_html(r, &opts));

        assert!(
            html.contains("class=\"task-list-item\""),
            "任务项缺少 `task-list-item` class ⇒ typography.css 的 `list-style: none` 会失效，\
             圆点与复选框同时出现\n{html}"
        );
        assert!(
            html.contains("class=\"contains-task-list\""),
            "任务列表缺少 `contains-task-list` class\n{html}"
        );
        // ⚠️ 复选框本身也在——否则上面两条可以靠"任务列表整个不渲染"作弊通过
        assert!(html.contains("type=\"checkbox\""), "复选框不见了\n{html}");
    }

    /// ⭐ `$` 的**边界 13 例**（`design/0007` §7.2 第 3 条）。
    ///
    /// ⚠️ 逐例的**一手依据**是 `docs/research/notes/0009` §2.1 那张表
    ///    （前 10 行**逐字**来自它，后 3 行是本项目补的边界）。
    ///    那张表证明的是：**`$` 定界符扫描与"代码里不算公式"这两件事，
    ///    comrak 免费给了**——本项目原以为要自己写扫描器，实测这个前提是错的。
    ///    ⇒ 这条测试守的**不是我们的实现**，是"我们确实还在用 comrak 那个开关"：
    ///    有人哪天为了"更可控"自己写一版扫描器，它立刻变红。
    ///
    /// ⚠️ **反面判据（后 5 行 + 代码两行）比正面判据重要**：把一个普通美元符号
    ///    当成公式，正文会当场变形，而**不会有任何报错**。
    #[test]
    fn 美元定界符的_13_个边界() {
        let opts = ParseOpts::default();
        assert!(opts.math_dollars, "这条测试的前提是公式开着");

        /// 这一格期望什么。
        #[derive(PartialEq, Debug)]
        enum Want {
            /// 一个字都不解析成公式。
            None,
            /// 行内公式。
            Inline,
            /// 块级公式（且⛔ 不许被包在 `<p>` 里）。
            Display,
        }

        let cases: [(&str, Want); 13] = [
            // ── 前 10 行：notes §2.1 那张表，逐字照抄 ──
            ("价格是 $5 到 $10 元", Want::None),
            ("用 `$a+b$` 表示", Want::None),
            ("```\n$a+b$\n```", Want::None),
            ("用 \\$ 转义", Want::None),
            ("开始 $x+y 没有结束", Want::None),
            ("只要 $ 一个", Want::None),
            ("A 是 $3 和 B 是 $7", Want::None),
            ("质能方程 $E=mc^2$ 是对的", Want::Inline),
            ("$$\nE = mc^2\n$$", Want::Display),
            ("$$E = mc^2$$", Want::Display),
            // ── 下面 3 行是本项目补的 ──
            // ⭐ `math_latex` **关着**（`design/0007` §2.1.2）：`\(` 在讲正则/转义的
            //    正文里太常见，开了会多出一面没有证据支持的误报面。
            ("用 \\(x+y\\) 表示", Want::None),
            // ⚠️ `$$$$` **不是一个空公式**——实测 comrak 原样留下 `<p>$$$$</p>`
            //    （2026-10-14 实测；我原先按"空公式"写，红了一条）。
            //    "空 literal" 那条路（`$$ $$` 之类）走的是 `math.rs` 的
            //    `空公式直接回退`，那儿才有 `NodeMath` 可以构造。
            ("$$$$", Want::None),
            // 围栏里的 `$$` 同样不算公式。
            ("```\n$$\nx\n$$\n```", Want::None),
        ];

        for (src, want) in cases {
            let html = with_parsed(src, &opts, |r| crate::document::render::to_html(r, &opts));
            let has_inline = html.contains("rmd-math-inline");
            let has_display = html.contains("rmd-math-display");
            let has_math = has_inline || has_display;

            match want {
                Want::None => assert!(
                    !has_math,
                    "⛔ 反面判据被破坏：{src:?} 被当成了公式\n{html}"
                ),
                Want::Inline => {
                    assert!(has_inline, "{src:?} 应当是行内公式\n{html}");
                    assert!(!has_display, "{src:?} 不该是块级\n{html}");
                }
                Want::Display => {
                    assert!(has_display, "{src:?} 应当是块级公式\n{html}");
                    // ⭐ `INV-MATH-03`：`<div>` 不能嵌在 `<p>` 里——浏览器会
                    // **静默**拆开重排 DOM，我们的预期与真实 DOM 无声地不一致。
                    assert!(
                        !html.contains("<p>"),
                        "⛔ INV-MATH-03：块级公式不该被包在 <p> 里\n{html}"
                    );
                }
            }
        }

        // ⭐ 反面锚点：上面那 13 格里"不解析"的占了 9 格——不能靠"公式整个没接上"通过。
        let api = with_parsed("$x$", &opts, |r| crate::document::render::to_html(r, &opts));
        assert!(api.contains("<math"), "公式渲染整条路是不是断了？\n{api}");
    }

    /// ⭐ **R3 的回归**（`design/0007` §7.1 步骤 11 / `notes/0009` §2.7）：
    /// `math_dollars` 一开，**含公式的标题**其目录文字与 ID 都会变；
    /// ⛔ 但**不含公式的标题，文字与 ID 必须逐字不变**。
    ///
    /// ⚠️ 这条测的是"开这个开关的**代价有多大**"——代价只落在真的含公式的标题上。
    /// 如果哪天它红了，说明 `math_dollars` 影响到了别的标题，那是**不可接受的回归**。
    #[test]
    fn 开关公式只影响含公式的标题() {
        let src = "# 普通标题\n\n## 另一个 标题\n\n### $x$\n\n# 普通标题\n";

        let off = ParseOpts { math_dollars: false, ..Default::default() };
        let on = ParseOpts { math_dollars: true, ..Default::default() };

        let ids = |o: &ParseOpts| {
            with_parsed(src, o, |root| {
                let index = crate::document::offset::LineIndex::new(src);
                crate::document::toc::build(root, src, &index, o.col_unit())
                    .into_iter()
                    .map(|e| (e.text, e.id))
                    .collect::<Vec<_>>()
            })
        };

        let a = ids(&off);
        let b = ids(&on);
        assert_eq!(a.len(), b.len(), "开关公式不该改变标题的个数");

        for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
            if i == 2 {
                // 只有第三条（`### $x$`）允许不同——它就是那个"代价"。
                assert_ne!(x, y, "第 3 条是公式标题，它**应该**随开关变");
                continue;
            }
            assert_eq!(
                x, y,
                "⛔ 第 {} 条标题不含公式，开关前后必须逐字相同",
                i + 1
            );
        }

        // ⚠️ 重复标题（第 1 与第 4 条同名）仍然按 comrak 的规则加后缀，
        //    且这个后缀在开关前后**都一样**（说明去重没被公式那条搅乱）。
        assert_eq!(a[0].1, b[0].1, "首个同名标题的 id 不该变");
        assert_ne!(a[0].1, a[3].1, "同名标题必须加后缀区分");
    }

    // ══════════════════════════════════════════════════════════════════════
    //  `design/0008` —— Markdown 语法扩展
    // ══════════════════════════════════════════════════════════════════════

    /// 渲染一份源码（用默认口径之外的选项时显式传 `opts`）。
    fn html_of(src: &str, opts: &ParseOpts) -> String {
        with_parsed(src, opts, |root| crate::document::render::to_html(root, opts))
    }

    /// ⭐ **代价的回归**（`design/0008` §7 末条）：这份源码里**有几个候选段落**。
    ///
    /// ⚠️ 为什么断言"候选数"而不是"耗时"：`strip_directives` 在**候选为空时提前返回**，
    /// 于是"要不要建 `LineIndex`"**完全**由这个计数决定——它是那个提前返回的**可观察形态**。
    /// 断言耗时（"看着没慢"）在单测里既不稳也说不清。
    ///
    /// ⚠️⚠️ 这里**故意绕开 `parse()`**，直接 `parse_document`：`parse()` 出口处已经清洗过了，
    /// 走它的话**永远**数到 0（那正是这条测试的"假绿"形态——它一开始就是这么写的）。
    fn 候选段落数(src: &str) -> usize {
        let opts = ParseOpts::default();
        let arena = Arena::new();
        let root = parse_document(&arena, src, &opts.to_comrak());
        root.children().filter(|n| has_directive_candidate(n)).count()
    }

    /// ⭐ **出厂就是断行的**（`design/0008` §2.1(1)、§9.3 第 1 条）。
    #[test]
    fn 单换行_默认断行() {
        let html = html_of("甲\n乙\n", &ParseOpts::default());
        assert!(
            html.contains("<br"),
            "段落内的单个换行必须渲染成 `<br />`——否则「快捷键」那类**逐行对齐**的\
             基准文档会被合并成一整段\n{html}"
        );
    }

    /// ⭐ **它只管软换行**（`INV-SYNTAX-02`）：行尾两空格的**硬换行**是 `LineBreak` 节点，
    /// 与这个开关**无关**——开与关的输出必须**逐字相同**。
    ///
    /// ⚠️ 这条挡的是"顺手把 `hardbreaks` 也接到 `LineBreak` 上"这类改动：
    /// 它看起来只是"统一处理换行"，实际会**改变硬换行的既有行为**。
    #[test]
    fn 单换行_不影响硬换行() {
        // 第 1 段 = 行尾两空格的**硬**换行；第 2 段 = **软**换行。两者必须能分开看。
        let src = "甲  \n乙\n\n丙\n丁\n";

        let on = html_of(src, &ParseOpts::default());
        let off = html_of(src, &ParseOpts { hardbreaks: false, ..Default::default() });

        // ⚠️ 取**第 N 段**：不能笼统地 `contains("<br")`——关了之后硬换行**照样**是 `<br />`
        //    （那正是本条要钉的行为），笼统断言会在这一条上自我矛盾。
        fn nth_p(h: &str, n: usize) -> String {
            h.split("<p>").nth(n).and_then(|r| r.split("</p>").next()).unwrap_or("").to_string()
        }

        assert_eq!(
            nth_p(&on, 1),
            nth_p(&off, 1),
            "硬换行（行尾两空格）的行为**不该**受 hardbreaks 影响"
        );
        assert!(
            nth_p(&off, 1).contains("<br"),
            "关了 hardbreaks，硬换行**仍然**是 `<br />`（它本来就是这个语义）"
        );

        // 软换行那一段：开了才断行
        assert!(nth_p(&on, 2).contains("<br"), "软换行开了就该断\n{on}");
        assert!(!nth_p(&off, 2).contains("<br"), "软换行关了就不该有 `<br`\n{off}");
    }

    /// ⭐ **独占一段的 `[TOC]` 被摘掉**（`INV-SYNTAX-01`）。
    #[test]
    fn 独占一段的_toc_被摘掉() {
        let src = "# 标题\n\n[TOC]\n\n正文\n";
        let html = html_of(src, &ParseOpts::default());
        assert!(!html.contains("[TOC]"), "独占一段的 `[TOC]` 该被摘掉\n{html}");
        // ⚠️ 其余内容必须还在——否则上面那条可以靠"整篇不渲染"作弊通过
        assert!(html.contains("正文"), "摘指令不该顺手吃掉别的段落\n{html}");
    }

    /// ⭐ **R1 的回归**（`design/0008` §7 步骤 2b）：**转义过的 `[TOC]` 必须留下**。
    ///
    /// ⚠️ 这条曾经会**失败**——如果判据用 `Text` 节点的**字面量**（转义已被解开成 `[TOC]`）
    /// 而不是**原文切片**（原样带着反斜杠）。作者写 `\[TOC\]` 的**全部意思**就是
    /// "我要在正文里看到 `[TOC]` 这几个字"，把它摘掉是**静默吃掉用户内容**。
    #[test]
    fn 转义过的_toc_不被摘掉() {
        let src = "\\[TOC\\]\n";
        let html = html_of(src, &ParseOpts::default());
        assert!(
            html.contains("[TOC]"),
            "转义的 `\\[TOC\\]` 必须显示成字面的 `[TOC]`，⛔ 不许被摘掉\n{html}"
        );
    }

    /// ⭐ **实体编码的 `[TOC]` 必须留下**（反面）——与上面那条同族：
    /// 实体的**字面量**同样是 `[TOC]`，只有**原文切片**分得开。
    #[test]
    fn 实体编码的_toc_不被摘掉() {
        let src = "&#91;TOC&#93;\n";
        let html = html_of(src, &ParseOpts::default());
        assert!(
            html.contains("[TOC]"),
            "`&#91;TOC&#93;` 是**实体**写的字面文本，不是指令\n{html}"
        );
    }

    /// 行内代码里的 `[TOC]` 必须留下（反面）——**结构判据**拦的（子节点是 `Code`）。
    #[test]
    fn 行内代码里的_toc_不被摘掉() {
        let src = "`[TOC]`\n";
        let html = html_of(src, &ParseOpts::default());
        assert!(html.contains("[TOC]"), "行内代码里的不该被摘\n{html}");
        assert!(html.contains("<code"), "行内代码本身要照常渲染\n{html}");
    }

    /// 粗体里的 `[TOC]` 必须留下（反面）——同样是**结构判据**拦的（子节点是 `Strong`）。
    #[test]
    fn 粗体里的_toc_不被摘掉() {
        let src = "**[TOC]**\n";
        let html = html_of(src, &ParseOpts::default());
        assert!(html.contains("[TOC]"), "粗体里的不该被摘\n{html}");
    }

    /// ⭐ **句子中间的 `[TOC]` 必须留下**（反面）——**子串替换会在这里失败**。
    #[test]
    fn 句子中间的_toc_不被摘掉() {
        let src = "关于 [TOC] 的说明\n";
        let html = html_of(src, &ParseOpts::default());
        assert!(
            html.contains("[TOC]"),
            "⛔ 这条是「**不做子串替换**」的判据：只有**整段恰好**是指令才摘\n{html}"
        );
        assert!(html.contains("关于"), "整句都该在\n{html}");
    }

    /// 独占一段的 `@(笔记本)[标签]` 被摘掉。
    #[test]
    fn 独占一段的_at_标签被摘掉() {
        let src = "# 标题\n\n@(笔记本)[标签]\n\n正文\n";
        let html = html_of(src, &ParseOpts::default());
        assert!(!html.contains("标签"), "独占一段的 `@(…)[…]` 该被摘掉\n{html}");
        assert!(html.contains("正文"), "不该吃掉别的段落\n{html}");
    }

    /// ⭐ **转义过的 `@(…)[…]` 必须留下**——`docs/kb/0017` 说这条**用「那个 `Text`
    /// 节点的切片」会误判**（合并后的文本节点 `sourcepos` 不对称：前导反斜杠被切掉、
    /// 尾随的留下，实测切片**恰好等于**字面量）⇒ 它是"**必须取段落切片**"这条设计决定的
    /// **唯一**回归测试。
    #[test]
    fn 转义过的_at_标签不被摘掉() {
        let src = "\\@(笔记本)[标签]\n";
        let html = html_of(src, &ParseOpts::default());
        assert!(
            html.contains("@(笔记本)[标签]"),
            "转义过的必须原样显示，⛔ 不许被摘掉（kb/0017：这一条靠**段落**切片而不是\
             文本节点切片才成立）\n{html}"
        );
    }

    /// 句子中间的 `@(…)[…]` 必须留下（反面）。
    #[test]
    fn 句子中间的_at_标签不被摘掉() {
        let src = "见 @(笔记本)[标签] 那一节\n";
        let html = html_of(src, &ParseOpts::default());
        assert!(html.contains("@(笔记本)[标签]"), "整段不是指令，该原样保留\n{html}");
    }

    /// ⭐ **引用块里的 `[TOC]` 必须留下**（反面）——钉住"**只认顶层**"。
    ///
    /// ⚠️ 顺便记一笔（`design/0008` §7 要求）：`> [TOC]` 里那个**段落的原文切片
    /// 恰好就是 `[TOC]`**（`>` 是块级记号，不进段落的行内区间）⇒ **只有那条结构判据
    /// （"只认 `root.children()`"）拦得住它**，切片那关是**放行**的。
    /// 换句话说：把 `root.children()` 换成 `root.descendants()` 会**立刻**让这条变红。
    #[test]
    fn 引用块里的_toc_不被摘掉() {
        let src = "> [TOC]\n";
        let html = html_of(src, &ParseOpts::default());
        assert!(
            html.contains("[TOC]"),
            "⛔ 引用块里的 `[TOC]` 不是指令（那里出现它多半是**在讨论这个语法**）；\
             它的段落切片**恰好等于** `[TOC]` ⇒ 这条只有**结构判据**拦得住\n{html}"
        );
        assert!(html.contains("<blockquote"), "引用块本身要照常渲染\n{html}");
    }

    /// ⭐ **摘掉指令不改标题 id**（`adr/0003`：文档级统一分配）。
    ///
    /// ⚠️ 这条**直接比对清洗前后**（在同一个 arena 上先不清洗地解析一次），
    /// 因为"清洗"就是本设计加进来的那一步——`parse()` 之后已经看不到清洗前的样子了。
    #[test]
    fn 摘掉指令不改标题_id() {
        let src =
            "# 一级 标题\n\n[TOC]\n\n## 二级 **粗体**\n\n@(笔记本)[标签]\n\n### 一级 标题\n\n正文\n";
        let opts = ParseOpts::default();
        let index = crate::document::offset::LineIndex::new(src);
        // ⚠️ 写成**局部 fn** 而不是闭包：闭包的参数写不出"两个生命周期是同一个"，
        //    而 `toc::build` 需要 `&'a AstNode<'a>`（arena 的类型是不变的，见 E0621）。
        fn ids<'a>(
            root: &'a AstNode<'a>,
            src: &str,
            index: &crate::document::offset::LineIndex,
            opts: &ParseOpts,
        ) -> Vec<(String, String)> {
            crate::document::toc::build(root, src, index, opts.col_unit())
                .into_iter()
                .map(|e| (e.text, e.id))
                .collect()
        }

        let arena = Arena::new();
        // ⚠️ 这里**故意**绕开 `parse()`，直接拿 `parse_document`——就是要清洗**之前**的样子。
        let root = parse_document(&arena, src, &opts.to_comrak());
        let before = ids(root, src, &index, &opts);
        assert_eq!(before.len(), 3, "夹具该有 3 个标题");

        strip_directives(root, src, &opts);
        let after = ids(root, src, &index, &opts);

        assert_eq!(
            before, after,
            "摘掉指令段落**不该**改变任何标题的文字或 id（`adr/0003` 的文档级分配）"
        );
    }

    /// ⭐ **不含指令的文档：切片与建索引都不发生**（`design/0008` §7 的代价回归）。
    ///
    /// ⚠️ 判据是**候选段落数 = 0**——`has_directive_candidate` 为假时
    /// `strip_directives` 在第一趟就返回，⛔ 不建 `LineIndex`、不切任何片段。
    /// 少了这条，**任何一段普通散文**（顶层、全部子节点都是 `Text`）都会进候选，
    /// 于是每份文档都白建一次索引——语料里最普通的 `XL-plain.md` 正是这个形状。
    #[test]
    fn 不含指令的文档_切片与建索引都不发生() {
        // 普通散文：顶层段落、子节点全是 Text——**旧判据下它就是候选**
        let prose = "这是一段普通的说明文字，讲的是阅读器该怎么排版。\n\n\
                     另一段，同样没有任何花括号外的花样。\n";
        assert_eq!(
            候选段落数(prose),
            0,
            "普通散文**不该**成为候选（它会让每份文档白建一次 LineIndex）"
        );

        // 反面：真含指令的文档**必须**有候选——否则上面那条可以靠"永远返回 0"作弊通过
        assert!(
            候选段落数("# 标题\n\n[TOC]\n\n正文\n") >= 1,
            "含 `[TOC]` 的文档必须有候选段落"
        );
        assert!(
            候选段落数("见 @(笔记本)[标签] 那一节\n") >= 1,
            "含 `@(…)[…]` 的文档必须有候选段落"
        );
    }

    /// ⭐ **开关矩阵必须真的覆盖每个字段的两个取值**（`design/0008` §7 的矩阵注）。
    ///
    /// ⚠️ 这条测的**不是**"个数是 32"——个数断言抓不住真正的那个错：
    /// 有人加了一个 `ParseOpts` 字段、**忘了加一层 `for`**，这时 `all_opts()` 仍然是
    /// 32 个（每个新字段都取 `Default` 的那个值），而**新字段的组合一个都没被验过**。
    /// 判据换成"**每个字段在矩阵里都出现过两个不同的取值**"之后，那个错立刻变红。
    ///
    /// ⚠️ 加字段时这条会**自动**覆盖到它（新字段若没进循环 ⇒ 常量 ⇒ 只有 1 个取值）。
    #[test]
    fn 开关矩阵覆盖每个字段的两个取值() {
        let all = ParseOpts::all_opts();
        assert_eq!(all.len(), 32, "5 个 bool ⇒ 2^5 = 32 组（`design/0008` 之前是 16）");

        let any = |f: &dyn Fn(&ParseOpts) -> bool| all.iter().any(f);
        let all_of = |f: &dyn Fn(&ParseOpts) -> bool| all.iter().all(f);

        // 每个字段都必须**既取过 false 也取过 true**，且**不是恒真/恒假**。
        let fields: [(&str, &dyn Fn(&ParseOpts) -> bool); 5] = [
            ("render_sourcepos", &|o| o.render_sourcepos),
            ("sourcepos_chars", &|o| o.sourcepos_chars),
            ("heading_ids", &|o| o.heading_ids),
            ("math_dollars", &|o| o.math_dollars),
            ("hardbreaks", &|o| o.hardbreaks),
        ];
        for (name, get) in fields {
            assert!(
                any(get) && !all_of(get),
                "字段 `{name}` 在 `all_opts()` 的矩阵里没有取到两个不同的值 ⇒ \
                 **它没进循环**，新组合一个都没被验过（`design/0008` §7）"
            );
        }
    }

    // ————————————————————————————————————————————————————————————————————————
    // 链接改写（`design/0026` §2.4、`INV-LINK-07`、§7.1 步骤 0b/0c）
    // ————————————————————————————————————————————————————————————————————————

    /// ⭐ **改写前的对照**：四种危险 scheme 在 comrak 眼里**都被清成空 href**
    /// （`dangerous_url` 对 d/f/j/v 是同一套处理）。
    ///
    /// ⚠️ 这条是 `design/0026` 评审 `P1-1` 的**证据本身**：如果只有 `file:` 被清，
    /// 说明"只救 `file:`"的方案还站得住；若另三种也被清，就必须四种一起改写。
    /// ⚠️ 实测定量：comrak **会写出 `href=""`**（写属性、值留空），⛔ 不是"整条属性都不写"
    /// ——`html.rs:836` 的 `escape_href` 那支被 `dangerous_url` 短路掉了。
    #[test]
    fn 危险_scheme_在渲染层都拿不到_href() {
        let src = "[f](file:///tmp/a.md) [j](javascript:alert(1)) \
                   [d](data:text/html,x) [v](vbscript:x)\n";
        let arena = Arena::new();
        let root = parse_document(&arena, src, &ParseOpts::default().to_comrak());
        let hrefs: Vec<String> = root
            .descendants()
            .filter_map(|n| match &n.data.borrow().value {
                NodeValue::Link(l) => Some(l.url.clone()),
                _ => None,
            })
            .collect();
        // ⚠️ 这里看的是**未改写**的 AST（`parse_document` 而不是 `parse`）——原值还在
        assert_eq!(hrefs, vec!["file:///tmp/a.md", "javascript:alert(1)", "data:text/html,x", "vbscript:x"]);

        let html = crate::document::render::to_html(root, &ParseOpts::default());
        assert_eq!(
            html.matches("href=\"\"").count(),
            4,
            "四种危险 scheme 都该被清成空 href：\n{html}"
        );
        // 原值一个都不许漏进 HTTP 层输出
        for bad in ["file:", "javascript:", "data:", "vbscript:"] {
            assert!(!html.contains(bad), "{bad} 不该出现在 HTML 里：\n{html}");
        }
    }

    /// ⭐ `design/0026` §2.4：**四种一起**改成受控标记，且 `render.unsafe` 照旧关着。
    #[test]
    fn 链接改写_四种危险_scheme_都变成受控标记() {
        let src = "[f](file:///tmp/a%20b.md#sec) [j](javascript:alert(1)) \
                   [d](data:text/html,x) [v](vbscript:x) [ok](https://example.com/x)\n";
        let opts = ParseOpts::default();
        let html = with_parsed(src, &opts, |root| crate::document::render::to_html(root, &opts));

        assert!(html.contains("rmd-file:/tmp/a%20b.md#sec"), "file: 没被改写：\n{html}");
        assert!(html.contains("rmd-unsupported:javascript"), "javascript: 没被改写：\n{html}");
        assert!(html.contains("rmd-unsupported:data"), "data: 没被改写：\n{html}");
        assert!(html.contains("rmd-unsupported:vbscript"), "vbscript: 没被改写：\n{html}");
        // 正常链接一个字节都不动
        assert!(html.contains("href=\"https://example.com/x\""));
        // ⛔ 改写不等于开 unsafe：可执行标签仍然一个都不许出现
        for tag in ["<script", "onerror=", "<iframe"] {
            assert!(!html.contains(tag));
        }
    }

    /// ⭐ §2.4：**非本机 authority / 带 query / 相对路径**的 `file:` 一律改成不支持
    /// （⛔ 悄悄当成本地路径——尤其非本机 authority，改写成只含路径就再也拒绝不了了）。
    #[test]
    fn 链接改写_不支持的_file_形态() {
        let src = "[a](file://evil/share/x.md) [b](file:///tmp/x.md?raw=1) [c](file:rel.md)\n";
        let opts = ParseOpts::default();
        let html = with_parsed(src, &opts, |root| crate::document::render::to_html(root, &opts));
        assert_eq!(
            html.matches("rmd-unsupported:file").count(),
            3,
            "三种形态都该被判成不支持：\n{html}"
        );
    }

    /// ⭐ §2.4：**图片**也改写（否则 `![](file:///…)` 会变成没有 src 的裂图）。
    #[test]
    fn 图片的_file_也改写() {
        let src = "![图](file:///tmp/%E4%B8%AD.png)\n";
        let opts = ParseOpts::default();
        let html = with_parsed(src, &opts, |root| crate::document::render::to_html(root, &opts));
        assert!(
            html.contains("src=\"rmd-file:/tmp/%E4%B8%AD.png\""),
            "图片没被改写：\n{html}"
        );
    }

    /// ⚠️ §2.4（评审 `P2-3`）：改写**不碰文件系统**，`..` 只做词法归一，
    /// **⛔ 不 canonicalize**——否则"打开文档"就对每条 `file:` 链接做一次存在性探测。
    #[test]
    fn 链接改写_只做词法归一不碰文件系统() {
        let src = "[a](file:///tmp/dir/../a.md) [b](file:///tmp/%2e%2e/%2e%2e/etc/passwd)\n";
        let opts = ParseOpts::default();
        let html = with_parsed(src, &opts, |root| crate::document::render::to_html(root, &opts));
        assert!(html.contains("rmd-file:/tmp/a.md"), "点段没被词法归一：\n{html}");
        // ⚠️ 解码后是 `/tmp/../../etc/passwd` ⇒ 归一成 `/etc/passwd`，
        //    **照样过 `check_readable`**（这里只证明改写层没有偷偷做授权判断）
        assert!(html.contains("rmd-file:/etc/passwd"), "越权目标应在授权层被拒：\n{html}");
    }

    // ── 单元格里的 `<br>`（`bugs/0035`）────────────────────────────────────

    /// ⭐ 单元格里的 `<br>` 要**真的换行**：`render.unsafe` 关着 ⇒ 不换就会静默丢掉
    /// （`<!-- raw HTML omitted -->`），用户只看到两段文字粘在一起。
    #[test]
    fn 单元格里的_br_变成换行() {
        let src = "| 甲 |\n| --- |\n| 第一行<br>第二行 |\n";
        let opts = ParseOpts::default();
        let html = with_parsed(src, &opts, |root| crate::document::render::to_html(root, &opts));
        assert!(html.contains("<td>第一行<br />"), "`<br>` 没变成换行：\n{html}");
        assert!(!html.contains("raw HTML omitted"), "`<br>` 不该再被丢弃：\n{html}");
    }

    /// ⚠️ **负对照**：只认 `<br>` 这一种字面量，别的裸 HTML 在单元格里**照旧丢弃**
    /// ——否则这就是把 `render.unsafe` 从后门打开了。
    #[test]
    fn 单元格里别的裸_html_仍然丢弃() {
        let src = "| 甲 |\n| --- |\n| <img src=x onerror=alert(1)> |\n";
        let opts = ParseOpts::default();
        let html = with_parsed(src, &opts, |root| crate::document::render::to_html(root, &opts));
        for bad in ["onerror", "<img"] {
            assert!(!html.contains(bad), "`{bad}` 透传进了 HTML：\n{html}");
        }
    }

    /// ⚠️ **范围收窄的正面判据**：段外的 `<br>` 行为一个字节都不动（照旧丢弃）。
    /// 段落里要换行有软换行与硬换行两条现成通道，`<br>` 不该在那里另开一条。
    #[test]
    fn 段外_br_不生效() {
        let src = "甲<br>乙\n";
        let opts = ParseOpts::default();
        let html = with_parsed(src, &opts, |root| crate::document::render::to_html(root, &opts));
        assert!(!html.contains("<br"), "段外的 `<br>` 不该生效：\n{html}");
    }

    /// `<br/>` / `<br />` / 大写都认（作者手写的三种常见形态）。
    #[test]
    fn 单元格里的_br_变体() {
        let src = "| 甲 |\n| --- |\n| a<br/>b<BR />c |\n";
        let opts = ParseOpts::default();
        let html = with_parsed(src, &opts, |root| crate::document::render::to_html(root, &opts));
        assert_eq!(html.matches("<br />").count(), 2, "三个变体没有都认：\n{html}");
    }

    /// ⭐ **转义语义的一手夹具**（2026-10-29 复评 P2-5）：`live/cell.js::decode` 的判据
    /// 必须与**这一份真 comrak 的结果**对得上，⛔ 不是拿几个正则示例自证。
    ///
    /// 六条覆盖：转义尖括号 / 转义反引号 / 代码 span / 奇偶反斜杠 / 等长反引号串。
    /// ⚠️ 判据是「这一格渲染出了 `<br />` 还是字面 `<br>`」——前端 `decode` 只许在
    /// **前者**那一格把 `<br>` 还原成换行（`bugs/0040` 的阅读/编辑一致性）。
    /// ⚠️ 对应判据在 `tests/js/live-cell.test.js` 的「与真 comrak 夹具逐格对齐」，
    /// 两份用的是**同一串源码**（改动时同批改）。
    #[test]
    fn 单元格里的_br_转义语义() {
        let opts = ParseOpts::default();
        // (名字, 格内源码, 期望这一格有没有真换行)
        let cases: [(&str, &str, bool); 6] = [
            ("转义的尖括号", r"a\<br>b", false),
            ("转义的反引号", "\\`a<br>b`", true),
            ("代码 span 里的", r"`a<br>b`", false),
            ("偶数反斜杠", r"a\\<br>b", true),
            ("奇数反斜杠", r"a\\\<br>b", false),
            ("等长反引号串", r"``a`b<br>c``", false),
        ];
        for (name, cell, br) in cases {
            let src = format!("| 甲 |\n| --- |\n| {cell} |\n");
            let html = with_parsed(&src, &opts, |root| crate::document::render::to_html(root, &opts));
            let got = html.contains("<br />");
            assert_eq!(got, br, "「{name}」的换行判定与预期不符（源码 {cell:?}）：\n{html}");
        }
    }
}

