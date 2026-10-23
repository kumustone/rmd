//! 出 HTML：`document/` 的渲染出口（`design/0002`；`design/0007` §3 扩）。
//!
//! ⚠️ 每次调用都要传 `ParseOpts`——**同一个 AST 可以用不同渲染选项输出多次**，
//! 这正是 `design/0002` §7.0 步骤 3 量 `render.sourcepos` 膨胀倍数的做法：
//! 解析一次，渲染两次，差值是纯渲染开销。
//!
//! # `design/0007` 之后这里多出来的三件事
//!
//! 1. **`NodeValue::Math` 由我们自己出**（`INV-MATH-01`）。
//!    ⚠️ comrak 的 `plugins` **截不到 `Math` 节点**——那条路只给围栏（`codefence_renderers`）
//!    与标题（`heading_adapter`）。唯一能截到的是**自定义 formatter**，
//!    所以本文件用 `create_formatter!` 造了一个，而不是继续用 `format_html`。
//! 2. **「整段就是一个块级公式」⇒ 不输出 `<p>`**（`INV-MATH-03`）。
//! 3. **代码围栏走我们的闸门**（⭐ 2026-10-15，`design/0007` 文末「Q22 代码高亮规模闸门」）：
//!    ⚠️ **这一条取代了 §3.1 原稿里"围栏走适配器"的做法**——[`RmdHighlighter`] 的
//!    `SyntaxHighlighterAdapter` 实现只拿得到 `&mut dyn fmt::Write`，⛔ **摸不到
//!    `context.user`**（就是本文件上面那段注释里图表计数传不回来的同一条限制）
//!    ⇒ 想按块判预算就只能在 formatter 里**自己出**这一块。
//!    `flow`/`sequence` 与 ````` ```math ````` **仍走适配器**（它们有各自的预算）。
//!
//! ⚠️ **不在这份 formatter 里的节点一律回落 `format_node_default`**——
//! 一字不差地保持 `design/0002` 以来的一切行为（含标题 ID 的分配方式，`INV-TOC-01`）。

use std::fmt::Write;

use comrak::html::{ChildRendering, Context};
use comrak::nodes::{AstNode, NodeCodeBlock, NodeValue};
use comrak::Options;

use super::parser::ParseOpts;
use super::{diagram, highlight};

/// 一次渲染的观测量（`design/0007` §3.1）。
///
/// ⭐ **存在的理由只有一个**：`INV-MATH-05` 要求"累计触顶必须可观测"，
/// ⛔ 不许"静默地少渲染了几个公式"——那正是本项目最怕的失败形态（§6）。
/// 所以计数器随 HTML 一起返回，由调用方带进 `report_status`。
///
/// ⭐ 2026-10-15 起多一组**代码高亮**的计数（`design/0007` 文末 Q22 追加节）：
/// 那四条预算同样要求"超限**可见**"——Q22 原话是「渲染统计报告"部分代码未高亮
/// （规模限制）"，界面提供轻量可见说明」。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RenderStats {
    /// 真正渲染成 MathML 的公式数。
    pub math_rendered: usize,
    /// 解析失败（`Err`）而回退成源码的公式数。
    pub math_error: usize,
    /// 空公式等"不必送进 katex-rs"的回退数。
    pub math_fallback: usize,
    /// 因**尺寸闸门**回退的公式数（输入超限 / 输出超限 / 累计触顶）。
    pub math_oversize: usize,
    /// ⭐ 其中**因文档累计触顶**而回退的公式数。⚠️ 这个数是 §3.1 点名要能看到的那个。
    pub math_budget_exhausted: usize,
    /// 累计 MathML 字节数（闸门的累加器）。
    pub math_bytes: usize,

    /// ⭐ **真正高亮出来**的代码块数（⛔ 不含回退成纯文本的那些，
    /// 也不含 `flow`/`sequence`/`math` 这三类"另有预算"的围栏）。
    pub code_highlighted: usize,
    /// 因**单块**闸门回退的代码块数（输入 > 128 KiB 或输出 > 1 MiB）。
    pub code_oversize: usize,
    /// 因**文档累计**触顶而回退的代码块数（⚠️ **含触顶之后的每一块**）。
    pub code_budget_exhausted: usize,
    /// 累计**高亮输入**字节。⛔ 只累加真的高亮了的那些块——
    /// Q22 表第 4 行末句：「累计高亮片段的输出预算，**不包含**普通正文和纯文本回退」。
    pub code_input_bytes: usize,
    /// 累计**高亮输出**字节（同上口径）。
    pub code_output_bytes: usize,
    /// ⛔ **粘滞位**：文档累计已触顶 ⇒ 本块及后续块一律回退（Q22 表第 2/4 行）。
    ///
    /// ⚠️ **私有**是刻意的：它是闸门的**内部状态**，⛔ 不是给人看的数。
    /// 给人看的形态是 `code_budget_exhausted`（"有几块是这么没的"）。
    code_exhausted: bool,
}

// ⚠️ **为什么没有图表的那三个计数器**（这几行是**一次显式取舍**，不是漏了）：
// `design/0007` §3.1 只要求"公式累计触顶必须可观测"（`INV-MATH-05`）——
// 那是**静默**失效（公式变成源码，一眼看不出少渲染了几个）。
// 图表的回退**没有这个问题**：它的可见后果就是"这一块显示成代码块"，
// 用户看得见、也读得懂。而技术上还有一层：图表走 `CodefenceRendererAdapter`，
// 它的 `write` 只拿到 `&mut dyn fmt::Write`（就是 `Context` 本身上转的），
// ⛔ **摸不到 `context.user`**，所以计数器根本传不回来。
// ⇒ 要么放弃 §3.1 里"围栏走适配器"的路子（去 `NodeValue::CodeBlock` 里重写一遍
// comrak 的围栏逻辑），要么这条观测项不做。选了后者。
//
// ⚠️⭐ **2026-10-15 更正（Q22）：那句话对"普通的代码围栏"已经不作数了。**
// 代码高亮的四条预算**要求**"超限可见"，而没有计数器就做不到 ⇒ 那一条**走了前者**
// （见本文件 `NodeValue::CodeBlock` 那一支）。⛔ **图表与公式仍走适配器**——
// 上一段给图表列的两个理由（后果肉眼可见 / 适配器摸不到 `context.user`）**依然成立**，
// Q22 追加节也明文「公式/图表**沿用各自预算**，不与高亮输入混算」。
// ⛔ 所以别把这段读成"图表也搬进 formatter 了"。

impl RenderStats {
    /// ⭐ Q22：因**规模闸门**未能高亮的代码块数（单块超限 ＋ 累计触顶）。
    ///
    /// ⚠️ 这是给**界面**用的那一个数（「部分代码未高亮（规模限制）」）。
    /// ⛔ 它**不含**"高亮整体不可用"（语法包坏了）那一类——那一种是环境问题，
    /// 与"这文档太大"是两件事，混在一起报会让提示文案说假话。
    pub fn code_unhighlighted(&self) -> usize {
        self.code_oversize + self.code_budget_exhausted
    }

    /// 一行摘要，给 `report_status` 用。
    ///
    /// ⚠️ 格式**故意稳定**（`key=value` 空格分隔）：冒烟脚本里是当断言用的字符串比对的。
    pub fn summary(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!("math={}", self.math_rendered));
        if self.math_error > 0 {
            s.push_str(&format!(" math_err={}", self.math_error));
        }
        if self.math_fallback > 0 {
            s.push_str(&format!(" math_empty={}", self.math_fallback));
        }
        if self.math_oversize > 0 {
            s.push_str(&format!(" math_over={}", self.math_oversize));
        }
        // ⭐ 累计触顶**单独列出来**：它是 §3.1 要求"不许静默"的那一个。
        if self.math_budget_exhausted > 0 {
            s.push_str(&format!(" math_budget={}", self.math_budget_exhausted));
        }
        // ── 代码高亮（Q22）──
        // ⚠️ `code=` **每次都打**（含零），理由与 `math=` 同（`open_document` 那段注释）：
        //    "这一行没有 code=" 与 "code=0" 必须是两件不同的事——
        //    后者意味着"闸门接上了、这次一块都没超"，前者意味着"这一版根本没接上计数"。
        s.push_str(&format!(" code={}", self.code_highlighted));
        if self.code_oversize > 0 {
            s.push_str(&format!(" code_over={}", self.code_oversize));
        }
        if self.code_budget_exhausted > 0 {
            s.push_str(&format!(" code_budget={}", self.code_budget_exhausted));
        }
        // ⭐ 累计字节：⭐ **Q22 追加节点名要"初期校准记录输入/输出字节"**，
        //    而这两个数就是那条的落点（`code_in` / `code_out`）。
        //    ⚠️ 只在**真有高亮**时打（`code_highlighted > 0`）：一份没有代码的文档
        //    多印两个恒零的键，只会让 `make smoke` 那一行越来越长、越来越没人看。
        if self.code_highlighted > 0 {
            s.push_str(&format!(
                " code_in={} code_out={}",
                self.code_input_bytes, self.code_output_bytes
            ));
        }
        s
    }
}

comrak::create_formatter!(RmdFormatter<RenderStats>, {
    // ── 公式（`INV-MATH-01` / `INV-MATH-04` / `INV-MATH-05`）──
    //
    // ⚠️ `Skip`：`Math` 节点的内容是 `literal`（一个 `String`），**没有子节点**。
    //    返回 `HTML` 也行，但 `Skip` 把"这一支不递归"写成显式的。
    NodeValue::Math(ref nm) => |context, node, entering| {
        if entering {
            let html = super::math::render(nm, &mut context.user);
            context.write_str(&html)?;
        }
        return Ok(ChildRendering::Skip);
    },

    // ── 块级公式不套 `<p>`（`INV-MATH-03`）──
    //
    // ⚠️ **为什么不能只在 `Math` 那一支里想办法**：`$$…$$` 在 comrak 里是
    //    `Paragraph → Math(display_math)`，`<p>` 是**父节点**写的。子节点拦不住父节点。
    // ⚠️ 判据要**严格**：只有"整段就是那一个 `display_math` 节点"才不写 `<p>`。
    //    段里有别的东西（哪怕只是一个空格）就照旧——否则会造出
    //    「`$$…$$ 后面跟一句话`」这种段落的 `<p>` 凭空消失的静默 DOM 变化。
    NodeValue::Paragraph => |context, node, entering| {
        if is_lone_display_math(node) {
            return Ok(ChildRendering::HTML);
        }
        return comrak::html::format_node_default(context, node, entering);
    },

    // ── 代码围栏：Q22 的规模闸门（`design/0007` 文末追加节）──
    //
    // ⚠️ **为什么这一支要自己出整块**（⛔ 不是继续交给适配器）：四条预算里有三条
    //    是**文档累计**的，而 `SyntaxHighlighterAdapter::write_highlighted` 只拿到
    //    `&mut dyn fmt::Write`、**摸不到 `context.user`**（本文件上面那段注释同一条限制）。
    //    ⇒ 要让"这一块该不该高亮"看得见**整篇已经用掉多少**，只能在这一层判。
    //
    // ⚠️ **`flow`/`sequence`/`math` 不进来**：它们各有各的预算
    //    （Q22 追加节：「公式/图表沿用各自预算，不与高亮输入混算」）
    //    ⇒ 原样回落 `format_node_default`，那里面 comrak 会自己分流到
    //    `render_math_code_block` 或 `codefence_renderers`（`html.rs:512-526`）。
    NodeValue::CodeBlock(ref ncb) => |context, node, entering| {
        if entering && !is_special_fence(&ncb.info) {
            return write_gated_code_block(context, ncb);
        }
        return comrak::html::format_node_default(context, node, entering);
    },
});

/// 这个围栏由**另外那条路**负责（⛔ 不归 Q22 的代码高亮预算管）。
///
/// ⚠️ 判据与 comrak 0.56 `render_code_block` 的分流**同序同义**（`html.rs:512-516`）：
/// 先看 `math`（→ `render_math_code_block`），再看 `codefence_renderers`（→ 图表适配器）。
/// ⛔ 少判一个的表现是"一张大图去吃了代码高亮的累计额度"——反过来也一样。
fn is_special_fence(info: &str) -> bool {
    let lang = highlight::fence_lang(info);
    lang == "math" || diagram::is_diagram_fence(lang)
}

/// Q22 的一次判定结果。
enum CodeFence {
    /// 高亮生成成功。里面是**已经转义好的** class-only HTML。
    Highlighted(String),
    /// 回退：写完整、转义的纯文本（⛔ **不截断**、⛔ 不跳过正文）。
    Plain,
}

/// ⭐ Q22 的四条阈值。
///
/// ⚠️ **生产值就是 `highlight::MAX_*` 那四个常量**（[`CodeBudget::PRODUCTION`]），
/// 抽成一个结构体**只为了让测试拿小数字精确测临界值**，理由有两条，都不是"图省事"：
///
/// 1. 「恰好等于阈值 ⇒ 放行」这条判据（Q22 要的"临界值"测试）用真阈值测就要造
///    128 KiB 的输入，而**两个输出闸门在正常代码上够不着**——`XL-code` 实测膨胀
///    **3.5×**（`adr/0004` 引的那份 `45.0 / 12.9`），而 `4 MiB ÷ 3.5 ≈ 1.2 MiB`
///    已经超过 512 KiB 的累计**输入**闸门 ⇒ 输入那两条会先响。
///    ⚠️ 但输出那两条**不是死代码**：膨胀率是随内容变的，`))))))` 这类"逐字符一个
///    token"的代码膨胀率可以到几十倍（每个 span 都带一整串 class），那时它们才响。
/// 2. 于是"用真阈值跑一遍 e2e"**测不到**输出闸门 —— 那样写出来的绿色是假的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CodeBudget {
    input: usize,
    doc_input: usize,
    output: usize,
    doc_output: usize,
}

impl CodeBudget {
    /// 生产用的那份：**逐字照抄 Q22 表**（⛔ 不在这里做单位换算，
    /// 四个数是"KiB/MiB"，换算在 `highlight.rs` 的常量定义处，只有那一处）。
    const PRODUCTION: Self = Self {
        input: highlight::MAX_CODE_INPUT,
        doc_input: highlight::MAX_DOC_CODE_INPUT,
        output: highlight::MAX_CODE_OUTPUT,
        doc_output: highlight::MAX_DOC_CODE_OUTPUT,
    };
}

/// ⭐ Q22 的四条闸门 ＋ 两个累计器。**判据只看字节**（`str::len()`，UTF-8）。
///
/// 判定**顺序**（⚠️ 它决定了超限的块记到哪个计数器里，所以要写成确定的）：
/// ① 粘滞（累计已触顶）→ ② 单块输入 → ③ 累计输入 → ④ 真的高亮 →
/// ⑤ 单块输出 → ⑥ 累计输出。
///
/// ⚠️ ① 排在 ② 之前是刻意的：触顶之后那块"恰好自己又超了单块"的代码，
/// 归因是**累计**而不是它自己大——而"累计触顶"正是 Q22 要求可观测的那一个。
fn gate_code_fence(
    stats: &mut RenderStats,
    limits: CodeBudget,
    info: &str,
    code: &str,
) -> CodeFence {
    // ① 粘滞：文档累计已触顶 ⇒ 本块**及后续每一块**都回退
    //    （Q22 表第 2 行「将后续普通代码块都回退，**避免半块着色**」＋ 第 4 行同义）。
    if stats.code_exhausted {
        stats.code_budget_exhausted += 1;
        return CodeFence::Plain;
    }

    // ② 单块输入闸门（⭐ **主闸门**，见 `highlight::MAX_CODE_INPUT` 的注释）。
    if code.len() > limits.input {
        stats.code_oversize += 1;
        return CodeFence::Plain;
    }

    // ③ 累计输入闸门：「当前块会超累计预算则整块回退」。
    if stats.code_input_bytes + code.len() > limits.doc_input {
        stats.code_exhausted = true;
        stats.code_budget_exhausted += 1;
        return CodeFence::Plain;
    }

    // ④ 真正生成。⚠️ 传 `Some(lang)` 而不是 `None`：comrak 那条路也是这么传的
    //    （`html.rs:573`），空语言由 `highlighted` 内部回落成纯文本语法。
    let lang = highlight::fence_lang(info);
    let Some(html) = highlight::highlight_code(Some(lang), code) else {
        // 高亮**整体**不可用（语法包没载起来）⇒ 回退。
        // ⚠️ 这里**不记 `code_oversize`**：那是"环境坏了"，⛔ 与"文档太大"是两件事，
        //    记进去会让界面那句提示把原因说错。
        return CodeFence::Plain;
    };

    // ⑤ 单块输出闸门：「超限丢弃该块部分结果，整块回退」。
    if html.len() > limits.output {
        stats.code_oversize += 1;
        return CodeFence::Plain;
    }

    // ⑥ 累计输出闸门：「触顶当前块及后续块回退」。
    if stats.code_output_bytes + html.len() > limits.doc_output {
        stats.code_exhausted = true;
        stats.code_budget_exhausted += 1;
        return CodeFence::Plain;
    }

    // ⭐ 累计器**只累加真的高亮了的那些块**（Q22 表第 4 行末句）。
    stats.code_input_bytes += code.len();
    stats.code_output_bytes += html.len();
    stats.code_highlighted += 1;
    CodeFence::Highlighted(html)
}

/// 走完闸门、把这一块代码写出去。
///
/// ⚠️ 与 comrak `render_code_block` 的普通分支**逐字对齐**三件事：
/// ① `<pre>` 之前一个 `context.cr()`（`html.rs:529`，⛔ 漏了与上一块黏成一行）；
/// ② 外壳与 class 的判据（在 `highlight::write_code_block_open` 里，镜像 `html.rs:537-552`）；
/// ③ 收尾的 `context.lf()`（`html.rs:567`）。
///
/// ⭐ 返回 `Skip`：这一支**拥有整块**。⚠️ 它**不会**因此丢掉那个 Post 调用——
/// comrak 在进子节点之前就把 `(node, HTML, Phase::Post)` 压栈了
/// （`html.rs:309-311`，本文件的 `Math` 那一支依赖的是同一条语义），
/// 而 `render_code_block` 在 `entering == false` 时是个 no-op（`html.rs:500` 那个 `if` 没有 `else`）。
fn write_gated_code_block(
    context: &mut Context<RenderStats>,
    ncb: &NodeCodeBlock,
) -> Result<ChildRendering, std::fmt::Error> {
    let lang = highlight::fence_lang(&ncb.info);
    let verdict = gate_code_fence(&mut context.user, CodeBudget::PRODUCTION, &ncb.info, &ncb.literal);

    context.cr()?;
    match verdict {
        CodeFence::Highlighted(html) => {
            highlight::write_highlighted_code_block(context, &ncb.info, lang, &html)?;
        }
        CodeFence::Plain => {
            highlight::write_plain_code_block(context, &ncb.info, lang, &ncb.literal)?;
        }
    }
    context.lf()?;
    Ok(ChildRendering::Skip)
}

/// 「这个段落**只**含一个块级公式」。
///
/// ⚠️ `&'a AstNode<'a>` 两个 `'a` 必须同名（同 `to_html` 那条注释）：
/// `AstNode` 对 `'a` 不变，写成两个 `'_` 编译器不接受。
fn is_lone_display_math<'a>(node: &'a AstNode<'a>) -> bool {
    let mut children = node.children();
    match (children.next(), children.next()) {
        (Some(only), None) => {
            matches!(only.data().value, NodeValue::Math(ref nm) if nm.display_math)
        }
        _ => false,
    }
}

/// 渲染成 HTML。
///
/// ⚠️ `&'a AstNode<'a>` 这两个 `'a` 必须是同一个：`AstNode` 对 `'a` **不变（invariant）**，
/// 写成 `&AstNode` 会变成两个独立生命周期，编译器不接受。
pub fn to_html<'a>(root: &'a AstNode<'a>, opts: &ParseOpts) -> String {
    to_html_with_stats(root, opts).0
}

/// 渲染成 HTML，并把观测计数一并给出（`design/0007` §3.1）。
pub fn to_html_with_stats<'a>(
    root: &'a AstNode<'a>,
    opts: &ParseOpts,
) -> (String, RenderStats) {
    let comrak_opts: Options<'static> = opts.to_comrak();
    let plugins = super::diagram::plugins();

    let mut out = String::new();
    // comrak 的 `format_*` 只在写 `io::Write` 失败时报错，写 String 不会失败。
    let stats = RmdFormatter::format_document_with_plugins(
        root,
        &comrak_opts,
        &mut out,
        &plugins,
        RenderStats::default(),
    )
    .expect("写 String 不会失败");

    (out, stats)
}

#[cfg(test)]
mod tests {
    use crate::document::parser::{with_parsed, ParseOpts};

    /// ⭐ **端到端**：一份同时含代码围栏 / 公式 / 图表 的文档，
    /// 走完 `to_html_with_stats` 之后**三族的 class 都在**。
    ///
    /// ⚠️ **为什么必须有这一条**：上面各模块的单测都只测了**自己那一层**
    ///    （`highlight.rs` 测适配器、`math.rs` 测 `render_tex`、`diagram.rs` 测
    ///    适配器 `write`）。而"适配器有没有真的**挂进** comrak 的渲染管线"
    ///    这件事，**哪一层都不管**：
    ///    `to_comrak()` 里没有它们的位置（它们在 `RmdFormatter` / `plugins()` 里），
    ///    所以有人把 `plugins()` 改成空 `Vec`、或者把 `write_pre_tag` 那段删掉，
    ///    所有模块单测照样全绿，而**正文里一个 span 都不会有**。
    ///
    /// ⚠️ 顺带钉住 `INV-MATH-02` 在**整篇**这一层的结果（不是单公式那一层）：
    ///    作者诱导的字面色在最终 HTML 里一个都不许剩。
    #[test]
    fn 三族增强在整篇渲染里都挂上了() {
        let src = "\
# 标题\n\
\n\
行内 $E = mc^2$ 与 `code span`。\n\
\n\
```rust\n\
fn main() { let x = 1; }\n\
```\n\
\n\
$$\n\
x = \\frac{a}{b}\n\
$$\n\
\n\
```flow\n\
st=>start: Start\n\
e=>end\n\
st->e\n\
```\n\
\n\
$\\textcolor{#ff0000}{y}$\n";

        let opts = ParseOpts::default();
        let (html, stats) = with_parsed(src, &opts, |root| {
            crate::document::render::to_html_with_stats(root, &opts)
        });

        // ① 高亮：`syntect` 的 class 前缀在，且代码块外壳是我们的。
        assert!(
            html.contains("class=\"rmd-code\""),
            "代码块外壳没挂上（`write_pre_tag` / 适配器没接进管线）\n{html}"
        );
        assert!(
            html.contains("rmd-keyword"),
            "代码高亮的 token span 一个都没有\n{html}"
        );
        // ② 公式：MathML + 我们的容器。
        assert!(html.contains("<math"), "公式没渲染\n{html}");
        assert!(html.contains("rmd-math-inline"), "行内公式容器没有\n{html}");
        assert!(html.contains("rmd-math-display"), "块级公式容器没有\n{html}");
        // ③ 图表：`flowmaid` 的 `<svg>` 与我们的外壳。
        assert!(html.contains("<svg"), "图表没画出来\n{html}");
        assert!(html.contains("class=\"rmd-diagram\""), "图表外壳没有\n{html}");

        // ④ ⭐ `INV-MATH-02` 在**整篇**这一层的复核：作者诱导的字面色不许进 DOM。
        // ⚠️ 判据是**属性名**，⛔ 不是搜 `#ff0000`——`<annotation>` 里会把 TeX 源码
        //    原样放回去，`\\textcolor{#ff0000}{y}` 那几个字符**本来就该在**。
        //    （这条断言第一版就写成了搜颜色串，2026-10-14 被它自己红了一次。）
        assert!(
            !html.contains("mathcolor"),
            "⛔ 整篇渲染后仍有作者诱导的字面色属性（`\\textcolor` 那一条）\n{html}"
        );
        assert!(
            html.contains("<mstyle><mi>y</mi></mstyle>"),
            "⚠️ 剥属性把标签切坏了：应当只剩一个光秃秃的 <mstyle>\n{html}"
        );

        // ⑤ ⭐ 三族的计数与"零失败"同时可观测（`design/0007` §3.1）。
        assert_eq!(stats.math_error, 0, "样本里没有该失败的公式：{stats:?}");
        assert_eq!(stats.math_fallback, 0, "样本里没有该回退的公式：{stats:?}");
        assert!(stats.math_rendered >= 3, "三个公式都该真的渲染：{stats:?}");

        // ⑥ ⭐ Q22：这一份样本里的 `rust` 围栏**该高亮、且没吃任何闸门**。
        //    ⚠️ 它是 `code=` 那个计数"接上了"的判据——⛔ 不是靠"HTML 里有 span"
        //    （那是 `highlight.rs` 那一层的事，适配器那条路也能做出 span）。
        assert_eq!(stats.code_highlighted, 1, "样本里正好一个普通围栏：{stats:?}");
        assert_eq!(stats.code_oversize, 0, "样本没超任何单块阈值：{stats:?}");
        assert_eq!(stats.code_budget_exhausted, 0, "样本没超累计阈值：{stats:?}");
    }

    // ══════════════════════════════════════════════════════════════════════
    // Q22 代码高亮规模闸门（`design/0007` 文末追加节）
    //
    // ⚠️ 分两层测，**两层都必要**：
    //   ① `gate_code_fence` 直接测——用**小阈值**，这样四条闸门的**临界值**
    //      （"恰好等于就放行"）才测得准，⛔ 不用造 4 MiB 的夹具；
    //   ② 走 `to_html_with_stats` 的 e2e——用**真常量**，钉住"生产阈值真的接上了"
    //      （① 只证明函数对，⛔ 证明不了 `CodeBudget::PRODUCTION` 没写错数）。
    // ══════════════════════════════════════════════════════════════════════

    use super::{gate_code_fence, CodeBudget, CodeFence, RenderStats};

    /// 小阈值，专门给闸门单测用。
    /// ⚠️ 四个数**故意各不相同**且都不是整数十——写错一个（比如把 `doc_input`
    ///    接成 `input`）会立刻在某条断言上现形，⛔ 不会两个闸门"看起来都对"。
    const 小: CodeBudget =
        CodeBudget { input: 100, doc_input: 250, output: 4000, doc_output: 9000 };

    /// `n` 字节的代码体（单行）：`n-1` 个 `a` 加一个换行。
    fn 体(n: usize) -> String {
        let mut s = "a".repeat(n - 1);
        s.push('\n');
        s
    }

    /// 一次判定，只要结果**是不是高亮**（大多数断言只关心这个）。
    fn 判(stats: &mut RenderStats, code: &str) -> bool {
        matches!(gate_code_fence(stats, 小, "rust", code), CodeFence::Highlighted(_))
    }

    /// ⭐ Q22 表第 1 行：单块输入**恰好等于** 100 字节 ⇒ 放行。
    /// ⚠️ 判据是 `>`，⛔ 不是 `>=`——差一个字节就是"一个 128 KiB 的代码块
    ///    到底高不高亮"这种没人能从现象反推的分歧。
    #[test]
    fn 单块输入恰好等于阈值_放行() {
        let mut s = RenderStats::default();
        assert!(判(&mut s, &体(100)), "恰好 100 字节应当放行");
        assert_eq!(s.code_input_bytes, 100);
    }

    /// ⭐ 单块输入**超一个字节** ⇒ 整块回退，且**只记 `code_oversize`**。
    #[test]
    fn 单块输入超一个字节_整块回退() {
        let mut s = RenderStats::default();
        assert!(!判(&mut s, &体(101)), "101 字节应当回退");
        assert_eq!(s.code_oversize, 1, "{s:?}");
        assert_eq!(s.code_highlighted, 0, "{s:?}");
        assert_eq!(s.code_budget_exhausted, 0, "⚠️ 单块超限⛔ 不该记成累计触顶：{s:?}");
        assert_eq!(s.code_input_bytes, 0, "⛔ 回退块的字节不许进累计器：{s:?}");
    }

    /// ⭐ Q22 表第 2 行：累计输入**恰好等于** 250 ⇒ 放行；**超了** ⇒ 本块回退，
    /// 且**后续块一律回退**（"避免半块着色"）。
    #[test]
    fn 累计输入触顶_本块与后续块一起回退() {
        let mut s = RenderStats::default();
        // 两块 100 + 一块 50 = 250，**恰好**打满 ⇒ 三块都该高亮。
        assert!(判(&mut s, &体(100)));
        assert!(判(&mut s, &体(100)));
        assert!(判(&mut s, &体(50)), "恰好打满 250 应当放行：{s:?}");
        assert_eq!(s.code_input_bytes, 250);

        // 第 4 块再加 1 字节就超了 ⇒ 整块回退。
        assert!(!判(&mut s, &体(1)), "超累计预算的当前块要整块回退：{s:?}");
        assert_eq!(s.code_budget_exhausted, 1);
        assert_eq!(s.code_oversize, 0, "⚠️ 归因是**累计**，⛔ 不是单块：{s:?}");
        assert_eq!(s.code_input_bytes, 250, "⛔ 回退块不许进累计器");

        // ⭐ **粘滞**：就算后面来一个 1 字节的小块，也不许再高亮
        //    （否则同一份文档里会出现"前一块灰、后一块彩"的混排）。
        assert!(!判(&mut s, &体(1)), "触顶之后的小块也必须回退：{s:?}");
        assert_eq!(s.code_budget_exhausted, 2);
        assert_eq!(s.code_highlighted, 3, "只有前三块被高亮：{s:?}");
    }

    /// ⭐ **粘滞位独立于累计器起作用**（Q22「避免半块着色」）。
    ///
    /// ⚠️⚠️ **为什么它必须单独成一条，而且必须手工构造状态**：
    /// 「删掉粘滞那一句」这件事**大多数情况下现象不变** —— 累计器一旦触顶，
    /// 后续块的字节/输出通常**仍然**撑爆同一个上限，于是"又触顶一次"与"粘滞"
    /// 给出**逐字相同**的结果。两者**分岔**只发生在"本块自己并不超"的时候：
    /// ① **空代码块**（`code.len() == 0` ⇒ `已用 + 0 > 上限` 是 `false`）；
    /// ② 输出闸门触顶后剩余额度恰好够一块小的。
    /// ⇒ 这条钉的是分岔点本身（第一版没写，变异测试**没变红**，如实记在 §10）。
    /// ⚠️ 字段私有、测试同模块 ⇒ 设得进去；⛔ 这不是"顺手开了一个测试口子"，
    /// 而是"要测一个只有构造得出才会出现的状态"。
    #[test]
    fn 粘滞位独立于累计器起作用() {
        let mut s = RenderStats::default();
        s.code_exhausted = true;
        // ⚠️ 累计器**故意清零**：这样闸门 ③/⑥ 都拦不住下面那些小块，
        //    唯一还能拦的就是粘滞位。
        assert_eq!((s.code_input_bytes, s.code_output_bytes), (0, 0));
        assert!(!判(&mut s, &体(1)), "⛔ 已触顶 ⇒ 小块也不许高亮");
        assert!(!判(&mut s, ""), "⛔ 已触顶 ⇒ 连**空**代码块也不许高亮");
        assert_eq!(s.code_budget_exhausted, 2, "{s:?}");
        assert_eq!(s.code_highlighted, 0, "{s:?}");
    }

    /// ⭐ 粘滞在**真实路径**上也是这么走的：累计输入打满之后，
    /// 一个**空**代码块（字节 0，累计器拦不住它）仍然必须灰着。
    #[test]
    fn 触顶之后空代码块也回退() {
        let mut s = RenderStats::default();
        assert!(判(&mut s, &体(100)));
        assert!(判(&mut s, &体(100)));
        assert!(判(&mut s, &体(50)));
        // 这一块把累计打爆 ⇒ 从此进入粘滞态。
        assert!(!判(&mut s, &体(1)));
        assert_eq!(s.code_budget_exhausted, 1, "{s:?}");
        // ⭐ 分岔点：空体不让累计器再响一次，只能靠粘滞位拦住。
        assert!(!判(&mut s, ""), "⛔ 触顶之后连空代码块也不许再高亮");
        assert_eq!(s.code_budget_exhausted, 2, "{s:?}");
        assert_eq!(s.code_highlighted, 3, "{s:?}");
    }

    /// ⭐ Q22 表第 3 行：单块**输出**超限 ⇒ 丢弃该块的结果，整块回退。
    ///
    /// ⚠️ 用 `output: 4000` 这个小阈值测：`体(100)` 高亮后远超 4000 字节
    ///    （每个 token 都带一整串 class）⇒ 一定触发。
    #[test]
    fn 单块输出超限_整块回退() {
        let mut s = RenderStats::default();
        let 紧 = CodeBudget { output: 10, ..小 };
        assert!(
            !matches!(gate_code_fence(&mut s, 紧, "rust", &体(100)), CodeFence::Highlighted(_)),
            "输出超 10 字节必然回退"
        );
        assert_eq!(s.code_oversize, 1, "{s:?}");
        assert_eq!(s.code_output_bytes, 0, "⛔ 被丢弃的结果不许进累计器：{s:?}");
        // ⚠️ **反向对照**：同一份输入、把输出阈值放开 ⇒ 高亮。
        //    ⛔ 少了这一条，上一句就可能是在测"这份输入本来就不高亮"。
        let mut s2 = RenderStats::default();
        assert!(matches!(
            gate_code_fence(&mut s2, CodeBudget { output: usize::MAX, ..小 }, "rust", &体(100)),
            CodeFence::Highlighted(_)
        ));
    }

    /// ⭐ Q22 表第 4 行：累计**输出**触顶 ⇒ 当前块及后续块回退，且**粘滞**。
    #[test]
    fn 累计输出触顶_当前块与后续块一起回退() {
        // 先量一块的真实输出，照着它定阈值——⛔ 不猜膨胀率。
        let mut probe = RenderStats::default();
        gate_code_fence(&mut probe, CodeBudget { output: usize::MAX, doc_output: usize::MAX, ..小 }, "rust", &体(100));
        let 一块输出 = probe.code_output_bytes;
        assert!(一块输出 > 0);

        // 阈值 = **恰好**一块 ⇒ 第一块放行、第二块整块回退。
        let 紧 = CodeBudget { output: usize::MAX, doc_output: 一块输出, ..小 };
        let mut s = RenderStats::default();
        assert!(matches!(gate_code_fence(&mut s, 紧, "rust", &体(100)), CodeFence::Highlighted(_)));
        assert_eq!(s.code_output_bytes, 一块输出);
        assert!(!matches!(gate_code_fence(&mut s, 紧, "rust", &体(100)), CodeFence::Highlighted(_)));
        assert_eq!(s.code_budget_exhausted, 1);
        assert_eq!(s.code_oversize, 0, "⚠️ 归因是**累计输出**，⛔ 不是单块：{s:?}");
        // 粘滞：再来一块也必须灰。
        assert!(!matches!(gate_code_fence(&mut s, 紧, "rust", &体(1)), CodeFence::Highlighted(_)));
        assert_eq!(s.code_budget_exhausted, 2);
        assert_eq!(s.code_highlighted, 1, "{s:?}");
    }

    /// ⭐ 回退出来的是**完整、转义**的纯文本（Q22 决定段第一句）。
    ///
    /// ⚠️ 两条一起断言：**内容一个字都不许少**（⛔ 不是"截断到阈值"），
    /// 且 `<` `&` **必须转义**（⛔ 否则回退路径自己开了一个注入面——
    /// 这正是 `INV-HL-02` 存在的理由，见 `kb/0012`）。
    #[test]
    fn 超限回退是完整且转义的纯文本() {
        // ⚠️ 夹具走的是**生产阈值**（下面那条 e2e 用的就是 `CodeBudget::PRODUCTION`）
        //    ⇒ 它必须超过 128 KiB。单位串 13 字节，凑够为止。
        const 单位: &str = "<script>&\"x\"\n";
        let 上限 = crate::document::highlight::MAX_CODE_INPUT;
        let n = 上限 / 单位.len() + 1;
        let 代码 = 单位.repeat(n);
        assert!(代码.len() > 上限, "夹具得真的超阈值：{}", 代码.len());

        // ① 直接测闸门（小阈值）：判成超限、且只记 `code_oversize`。
        let mut s = RenderStats::default();
        assert!(!判(&mut s, &代码));
        assert_eq!(s.code_oversize, 1);

        // ② 真正走一遍渲染，看**写出来的字节**。
        let opts = ParseOpts::default();
        let src = format!("```rust\n{代码}```\n");
        let (html, st) = with_parsed(&src, &opts, |root| {
            crate::document::render::to_html_with_stats(root, &opts)
        });
        assert_eq!(st.code_oversize, 1, "e2e 这一侧也得判成超限：{st:?}");
        assert_eq!(st.code_highlighted, 0, "{st:?}");
        assert!(!html.contains("<script"), "⛔ 回退路径把原文标签送出去了\n{html}");
        assert!(html.contains("&lt;script&gt;"), "回退路径必须转义\n{html}");
        assert!(html.contains("&amp;"), "`&` 也要转义\n{html}");
        assert!(html.contains("&quot;"), "`\"` 也要转义\n{html}");
        // ⭐ **不截断**：n 组全在（每组恰好一个 `<script>`）。
        assert_eq!(
            html.matches("&lt;script&gt;").count(),
            n,
            "⛔ 回退必须给**完整**内容，⛔ 不是截断到阈值\n（前 200 字节：{}）",
            &html[..html.len().min(200)]
        );

        // ⭐ **回退块仍然带着那个"有样式的外壳"**——这是"三套主题回归"那一条
        //    能**结构化**成立的原因，⛔ 不是"看着还行"：
        //    `highlight.css` 只管块内那些 `.rmd-*` token 色，
        //    **底色与底字归 `0004`**（`typography.css` 的 `.doc pre code` ＋
        //    `--reader-block-code-*`，它在 `lint-theme` 的 57 变量契约里，
        //    三套主题都必须给全）。⇒ 只要能证明"外壳没变"，
        //    就证明了"未高亮的块在三套主题下仍是有底色、可读的"。
        //    ⚠️ 把这条删掉/把外壳换掉，`code` 元素就会落回浏览器的裸样式——
        //    那是浅底深字的默认值，在 `dark` 上是一块刺眼的白。
        assert!(
            html.contains("<pre class=\"rmd-code\"><code class=\"language-rust\">"),
            "⛔ 回退块的**外壳**必须与高亮块逐字相同（底色/底字靠它）\n{html}"
        );
    }

    /// ⭐ **超长单行**：一行就把阈值撑爆 ⇒ 回退，⛔ 不截断、⛔ 不丢那一行。
    ///
    /// ⚠️ 它单独成一条是因为分词器在**超长单行**上的行为与多行不同
    ///    （`design/0007` §10.3 末段点名"超长单行 / 正则最坏输入仍需探针"），
    ///    而闸门是按**字节**判的，与行长无关——这条钉的就是"无关"。
    #[test]
    fn 超长单行超限也是整块回退且不截断() {
        let opts = ParseOpts::default();
        let 上限 = crate::document::highlight::MAX_CODE_INPUT;
        // 一行 `上限 + 1` 字节：`上限 - 5` 个 `a` ＋ 两个**多字节**中文当首尾哨兵，
        // **没有换行**（`体()` 那种带换行的不算超长行）。
        // ⚠️ 哨兵用中文是刻意的：闸门按**字节**判，谁把判据写成"字符数"
        //    这一行就会少算 ≈3 倍，这条立刻红。
        let 一行 = format!("{}中{}", "a".repeat(上限 - 5), "文");
        assert_eq!(一行.len(), 上限 + 1, "夹具的字节数得正好踩线");

        let src = format!("```rust\n{一行}\n```\n");
        let (html, st) = with_parsed(&src, &opts, |root| {
            crate::document::render::to_html_with_stats(root, &opts)
        });
        assert_eq!(st.code_oversize, 1, "{st:?}");
        assert_eq!(st.code_highlighted, 0, "{st:?}");
        // ⭐ **不截断**：整行原文**逐字**在输出里。
        // ⚠️ 判据是 `contains(整行)`，⛔ 不是"数 `a` 的个数"——外壳自己那
        //    `class="rmd-code"` / `class="language-rust"` 里**本来就有 4 个 `a`**，
        //    数出来会多 4（第一版就是这么写的，被它自己红了一次）。
        //    而一整条 131 073 字节的连续文本能被 `contains` 命中，就说明没被切断。
        assert!(
            html.contains(&一行),
            "⛔ 超长行被截断了（Q22：不截断内容）\n（输出前 200 字节：{}）",
            &html[..html.len().min(200)]
        );
        assert!(html.contains("中文"), "⚠️ 多字节哨兵丢了 —— UTF-8 边界被切坏了");
    }

    /// ⭐ 图表与公式围栏**不占代码高亮的额度**（Q22：「沿用各自预算，**不与高亮输入混算**」）。
    ///
    /// ⚠️ 判据不是"图渲染出来了"（那是 `0007` 既有的事），而是
    /// **`code_*` 那组计数一点都不动**——⛔ 少了这一条，
    /// 一张大图就会悄悄吃掉代码高亮的累计额度，而现象是"后面的代码块莫名不彩"。
    #[test]
    fn 图表与公式围栏不占高亮额度() {
        let opts = ParseOpts::default();
        let src = "\
```flow\nst=>start: 开始\ne=>end: 结束\nst->e\n```\n\
\n\
```math\nx^2 + y^2 = z^2\n```\n\
\n\
$$\\frac{a}{b}$$\n\
\n\
```rust\nfn main() {}\n```\n";
        let (html, st) = with_parsed(src, &opts, |root| {
            crate::document::render::to_html_with_stats(root, &opts)
        });
        assert!(html.contains("<svg"), "图得真的画出来（否则这条测的是别的东西）\n{html}");
        assert_eq!(st.code_highlighted, 1, "只有最后那个 rust 围栏算数：{st:?}");
        assert_eq!(st.code_oversize, 0, "{st:?}");
        assert_eq!(st.code_budget_exhausted, 0, "{st:?}");
        // ⚠️ 累计**输入**只该是那一个 rust 围栏的字节（`fn main() {}\n` = 13）。
        assert_eq!(st.code_input_bytes, "fn main() {}\n".len(), "{st:?}");
    }

    /// ⭐ 生产阈值**真的接上了**（e2e，用真常量）。
    ///
    /// ⚠️ 上面那些闸门单测全用 `小`，改坏了 `CodeBudget::PRODUCTION` 它们一条都不会红
    ///    ⇒ 必须有这一条守"那个结构体的四个数指向 `highlight::MAX_*`"。
    /// ⚠️ 判据取**恰好 128 KiB 放行 / 多一字节回退**，两边都测——
    ///    ⛔ 只测"多一字节回退"的话，把阈值写成 0 也照样绿。
    #[test]
    fn 生产阈值在_e2e_这一层真的生效() {
        let opts = ParseOpts::default();
        // ⚠️ `literal` = 代码体本身（围栏之间的那些行，**已含结尾换行**）
        //    ⇒ 想让它正好 128 KiB，代码体就得正好 128 KiB。
        let 上限 = crate::document::highlight::MAX_CODE_INPUT;
        assert_eq!(上限, 128 * 1024, "Q22 拍的是 128 KiB");

        let 恰好 = format!("```rust\n{}\n```\n", "a".repeat(上限 - 1));
        let (_, st) = with_parsed(&恰好, &opts, |root| {
            crate::document::render::to_html_with_stats(root, &opts)
        });
        assert_eq!(st.code_highlighted, 1, "恰好 128 KiB 应当高亮：{st:?}");
        assert_eq!(st.code_input_bytes, 上限, "{st:?}");

        let 超了 = format!("```rust\n{}\n```\n", "a".repeat(上限));
        let (_, st) = with_parsed(&超了, &opts, |root| {
            crate::document::render::to_html_with_stats(root, &opts)
        });
        assert_eq!(st.code_highlighted, 0, "128 KiB + 1 字节应当回退：{st:?}");
        assert_eq!(st.code_oversize, 1, "{st:?}");
    }

    /// ⭐ 不改既有行为：单个普通围栏走完闸门之后的 HTML，
    /// **逐字节等于** `design/0007` 落地时适配器那条路会写出的东西。
    ///
    /// ⚠️ 它守的是 Q22 决定段那一句「超限**才**回退」的镜像：
    ///    **没超限的**路径一个字都不许变（含 `<pre class="rmd-code">`、
    ///    `class="language-rust"`、行尾那个 `\n`）。
    #[test]
    fn 未超限的围栏输出与既有_html_逐字节一致() {
        let opts = ParseOpts::default();
        let src = "```rust\nfn main() { let x = 1; }\n```\n";
        let (html, st) = with_parsed(src, &opts, |root| {
            crate::document::render::to_html_with_stats(root, &opts)
        });
        assert_eq!(st.code_highlighted, 1, "{st:?}");

        // 照着 comrak `render_code_block` 的普通分支手拼一遍（`html.rs:559-577`）：
        // 高亮适配器的 `write_pre_tag` / `write_code_tag` / `write_highlighted`。
        let h = crate::document::highlight::highlighter().expect("语法集应当载得起来");
        let 期望 = {
            let mut s = String::new();
            use comrak::adapters::SyntaxHighlighterAdapter;
            h.write_pre_tag(&mut s, std::collections::HashMap::new()).unwrap();
            let mut code_attrs = std::collections::HashMap::new();
            code_attrs.insert("class", std::borrow::Cow::Borrowed("language-rust"));
            h.write_code_tag(&mut s, code_attrs).unwrap();
            h.write_highlighted(&mut s, Some("rust"), "fn main() { let x = 1; }\n").unwrap();
            s.push_str("</code></pre>");
            s
        };
        assert!(
            html.starts_with(&期望),
            "⛔ 未超限的围栏输出变了——Q22 只该改**超限**的那些\n期望开头：{期望}\n实际：{html}"
        );
    }
}
