//! 数学公式：comrak 的 `Math` 节点 → MathML（`design/0007` §2.1.2 / §3.1）。
//!
//! 四件事，每一件都对应一条不变量：
//!
//! 1. **只走 `OutputFormat::Mathml`**（`INV-MATH-01`）——HTML 那一半需要 KaTeX 的
//!    CSS 与 `KaTeX_Size` 字体，`katex-rs` **两样都不带**，离线又不许下载；
//!    实测的失败形态是"大括号根本不拉伸"（`docs/kb/0013` §1.1）。
//! 2. **进 DOM 前按属性剥一次色**（`INV-MATH-02`）——⭐ 这是 2026-10-14 修正后的做法。
//!    原来写的是"`Err` 时走我们自己的节点，`#cc0000` 就永远进不了 DOM"，
//!    **那句话是错的**：`katex-rs` 有**三族字面色，全在成功路径上**，
//!    而且 `\href`/`\url` 这类"已定义但未实现"的命令**根本不返回 `Err`**
//!    （`format_unsupported_cmd` 不查 `throw_on_error`）。⇒ **没有 `Err` 可拦**。
//!    依据与逐例清单：`docs/kb/0014`。
//! 3. **尺寸闸门**（`INV-MATH-05`）：输入在渲染**前**判（主闸门）、输出在**进 DOM 前**判、
//!    文档累计在**每次渲染后**判。⛔ 阈值不是拍脑袋，但**是待实测的初值**，见 §3.1。
//! 4. **失败一律"该公式回退成源码"**，⛔ 不 panic、⛔ 不放弃整篇。

use std::sync::OnceLock;

use comrak::nodes::NodeMath;
// ⚠️ **crate 名与包名不同**：包是 `katex-rs`，而它的 `[lib] name = "katex"`
// （`katex-rs-0.3.0/Cargo.toml:60-62`）⇒ 代码里写 `katex::`，⛔ 不是 `katex_rs::`。
use katex::types::{OutputFormat, Settings, TrustSetting};

use super::highlight::escape_html_into;
use super::render::RenderStats;

/// 单个公式的 TeX 输入上限（`design/0007` §3.1）。
///
/// ⚠️ 依据：实测放大 **11–16×**，最坏一例 **4 KB → 91 KB**（`notes/0009` §2.6）。
/// 取 4 KB 就是那个最坏例本身。⭐ **这是主闸门**——能约束渲染阶段资源消耗的
/// 只有"渲染之前的输入闸门"，输出闸门是二次保险（评审 R4 点破的正是这一点）。
pub const MAX_TEX_INPUT: usize = 4 * 1024;

/// 单个公式的 MathML 输出上限（`design/0007` §3.1）：4 KB × 16 = 64 KB，留 2× 余量。
pub const MAX_MATHML_OUTPUT: usize = 128 * 1024;

/// 整篇文档的公式输出累计上限（`design/0007` §3.1）。
///
/// ⚠️ 战锚是**量级锚点，不是实测的公式语料**：本仓库最大语料的 HTML 是
/// `XL-tables` 的 33.3 MB（`benchmarks/results/2026-10-13-Mac14,9.json`），
/// 4 MB ≈ 它的 12%，是"加得下"的量级。`benchmarks/corpus/` 里**没有**公式密集语料。
pub const MAX_DOC_MATH_OUTPUT: usize = 4 * 1024 * 1024;

/// `KatexContext` 一次性构建（它要把全部函数/符号/环境注册一遍），并复用。
static KATEX: OnceLock<katex::KatexContext> = OnceLock::new();

fn ctx() -> &'static katex::KatexContext {
    KATEX.get_or_init(katex::KatexContext::default)
}

/// ⛔ 每一次渲染都**重新构造** `Settings`，三个字段**显式钉死**（`design/0007` §2.1.2）。
///
/// ⚠️ 不靠 `Settings::default()`：默认值会随版本变，而 `INV-MATH-01/02` 是对**行为**的承诺。
/// ⚠️ 也不靠 `Settings::builder()`（bon）：这里没有一处"可选"，把 16 个字段全写出来，
/// 升级时多一个字段会**编译报错**而不是静默取新默认值——这正是我们要的。
fn settings(display_mode: bool) -> Settings {
    Settings {
        display_mode,
        // ⭐ INV-MATH-01：只有这一个值可选。
        output: OutputFormat::Mathml,
        leqno: false,
        fleqn: false,
        // ⭐ 实测行为是**返回 `Err`**（⛔ 不是它文档注释里写的 panic）。
        throw_on_error: true,
        // ⛔ 不用默认的 `#cc0000`。它唯一的出口是 `throw_on_error = false` 的错染，
        //    而那个出口**不可达**；即便如此也不给它留一条带字面色的路（`INV-MATH-02`）。
        error_color: "inherit".to_owned(),
        macros: Default::default(),
        min_rule_thickness: 0.0,
        color_is_text_color: false,
        strict: Default::default(),
        // ⭐ 作者指定的 `\href` / `\htmlStyle` 一律不信任。
        trust: TrustSetting::Bool(false),
        max_size: f64::INFINITY,
        // 宏展开有界：实测 `\def\a{\a}\a` 返回 `Err`，不会挂死（`notes/0009` §2.3）。
        max_expand: 1000,
        global_group: false,
        size_multiplier: 1.0,
        color: None,
    }
}

/// 渲染一个公式节点，返回可直接进 DOM 的 HTML 片段。
///
/// 落点全在这里：**任何一条闸门不过 ⇒ 回退成转义后的源码**，且把原因记进 `stats`。
pub fn render(nm: &NodeMath, stats: &mut RenderStats) -> String {
    // ⭐ 主闸门（渲染**之前**）：块级公式的 literal 带首尾 `\n`，先 trim 再算长度，
    // 否则一个空行就能把长度推过界。
    let tex = nm.literal.trim();

    // 空公式（`$$ $$`）：comrak 会给出一个纯空白 literal。⛔ 不必送进 katex-rs。
    if tex.is_empty() {
        stats.math_fallback += 1;
        return fallback(nm, "rmd-math-empty");
    }

    if tex.len() > MAX_TEX_INPUT {
        stats.math_oversize += 1;
        return fallback(nm, "rmd-math-oversize");
    }

    // ⭐ 文档累计预算：**触顶之后剩余公式一律回退源码**，⛔ 不 panic、⛔ 不中止打开文档。
    if stats.math_bytes >= MAX_DOC_MATH_OUTPUT {
        stats.math_budget_exhausted += 1;
        return fallback(nm, "rmd-math-oversize");
    }

    match katex::render_to_string(ctx(), tex, &settings(nm.display_math)) {
        Ok(mathml) => {
            // ⭐ INV-MATH-02：MathML 是**第三方字符串**，进 DOM 前按属性剥一次。
            let clean = strip_color_attributes(&mathml);

            // 二次保险：渲染后、进 DOM 前。
            if clean.len() > MAX_MATHML_OUTPUT {
                stats.math_oversize += 1;
                return fallback(nm, "rmd-math-oversize");
            }

            stats.math_rendered += 1;
            stats.math_bytes += clean.len();
            wrap(&clean, nm.display_math)
        }
        Err(_) => {
            // ⛔ 不用 katex-rs 自己的错染（那是 `mathcolor="#cc0000"`，当场破 INV-THEME-02）。
            // ⚠️ 但要知道它盖不住谁：`\href` 一族走的是 `Ok`（`docs/kb/0014`）。
            stats.math_error += 1;
            fallback(nm, "rmd-math-error")
        }
    }
}

/// 回退：输出**转义后的源码**，并标出为什么回退（`design/0007` §3.1、§6）。
fn fallback(nm: &NodeMath, class: &str) -> String {
    let mut s = String::new();
    let tag = if nm.display_math { "div" } else { "span" };
    s.push('<');
    s.push_str(tag);
    s.push_str(" class=\"rmd-math-source ");
    s.push_str(class);
    s.push_str("\" data-math-style=\"");
    s.push_str(if nm.display_math { "display" } else { "inline" });
    s.push_str("\">");
    // ⚠️ 转义：这是用户写的 TeX 源码，⛔ 不是我们生成的标记。
    escape_html_into(&mut s, nm.literal.trim()).expect("写 String 不会失败");
    s.push_str("</");
    s.push_str(tag);
    s.push('>');
    s
}

/// 把 MathML 包进我们的容器。
///
/// ⚠️ **为什么还要包一层**：`<math display="block">` 在 WKWebView 里确实居中
/// （`kb/0013` §1.1 实测左右隙 394.6 / 394.5），但**溢出**（长公式横向撑破内容宽）
/// 需要一个能挂 `overflow-x` 的元素，而它的排版盒由我们的层控制。
/// ⛔ **不套 `<p>`**（`INV-MATH-03`）——那一条由 `render.rs` 的 Paragraph 分支负责。
fn wrap(mathml: &str, display: bool) -> String {
    let mut s = String::with_capacity(mathml.len() + 64);
    if display {
        s.push_str("<div class=\"rmd-math-display\">");
        s.push_str(mathml);
        s.push_str("</div>");
    } else {
        s.push_str("<span class=\"rmd-math-inline\">");
        s.push_str(mathml);
        s.push_str("</span>");
    }
    s
}

/// ⭐ **按属性名**剥掉全部颜色属性（`INV-MATH-02`）。
///
/// ⛔ **判据必须是属性名，不能是"在输出里搜颜色字符串"**——后者会在被转义的
/// `<annotation>` 正文里**误报**（`notes/0009` §2.5 记过同形态的一次误判：
/// 探针用 `contains("onerror=")` 把"被转义的文本"当成了"属性"）。
///
/// 剥三样，理由是它们**都会在 WKWebView 里生效**（`kb/0013` §1.3 的 2026-10-14 修正：
/// 旧结论说"`mathcolor` 被忽略"是**错的**，旧探针在未排布的元素上取值）：
///
/// | 属性 | 谁带来的 | 剥掉之后 |
/// |---|---|---|
/// | `mathcolor` | `\textcolor` / `\color` | 继承当前文字色（= 跟随主题） |
/// | `mathbackground` | `\colorbox` / `\fcolorbox` / ⭐ **`\rule`（连颜色参数都不要）** | 底色/杠不可见 |
/// | `style` | `\fcolorbox` 的 `border: … solid <color>` | 同上 |
///
/// ⚠️ `style` 是**整条**剥掉：干净的 MathML 输出里**一个 `style=` 都没有**
/// （`kb/0013` §1.1 实测），所以这条只可能删掉**作者诱导出来的**那些。
///
/// ⚠️ 实现上依赖一条 katex-rs 的构造性质：它把正文里的 `<` 转义成 `&lt;`
/// （`notes/0009` §2.5 的 9 例全过），⇒ 字符串里**裸的 `<` 只会出现在真标签处**。
/// ⛔ 这条是**信任属性**，所以 `INV-MATH-04` 要求钉版本 + 单测 6 那条回归。
pub fn strip_color_attributes(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let b = html.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'<' {
            // 找标签结尾。⚠️ 必须认引号：属性值里可以有 `>`（例如作者写的
            // `\textcolor{a>b}{x}`），按第一个 `>` 截断会切坏结构。
            let mut j = i + 1;
            let mut quote: Option<u8> = None;
            while j < b.len() {
                let c = b[j];
                match quote {
                    Some(q) => {
                        if c == q {
                            quote = None;
                        }
                    }
                    None => {
                        if c == b'"' || c == b'\'' {
                            quote = Some(c);
                        } else if c == b'>' {
                            break;
                        }
                    }
                }
                j += 1;
            }
            let end = j.min(b.len() - 1);
            out.push_str(&filter_tag(&html[i..=end]));
            i = end + 1;
        } else {
            // 按 UTF-8 字符推进（`<` 的 ASCII 判定在非 ASCII 首字节上为 false，
            // 所以这里不会切到字符中间）。
            let ch_len = utf8_len(b[i]);
            out.push_str(&html[i..i + ch_len]);
            i += ch_len;
        }
    }
    out
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

/// 要剥掉的属性名（小写比较）。
const COLOR_ATTRS: [&str; 3] = ["mathcolor", "mathbackground", "style"];

/// 一个标签（含 `<` `>`）⇒ 去掉颜色属性后的标签。
///
/// ⚠️ 保留**原始切片**而不是重新拼 `name="value"`：原文里的转义（`&quot;` 等）
/// 原样带过去，我们不必自己再实现一遍属性值转义。
fn filter_tag(tag: &str) -> String {
    let inner = &tag[1..tag.len() - 1];
    // 注释 / doctype / 处理指令：⛔ 不碰（里面没有属性可剥，动它只会破坏内容）。
    if inner.starts_with('!') || inner.starts_with('?') {
        return tag.to_owned();
    }
    let body = inner.strip_prefix('/').unwrap_or(inner);
    let closing = inner.starts_with('/');

    let name_end = body.find(char::is_whitespace).unwrap_or(body.len());
    let name = &body[..name_end];
    if closing || name_end == body.len() {
        return tag.to_owned();
    }

    let mut rest = &body[name_end..];
    let mut self_closing = false;
    if rest.trim_end().ends_with('/') {
        self_closing = true;
        rest = &rest.trim_end()[..rest.trim_end().len() - 1];
    }

    let mut kept: Vec<&str> = Vec::new();
    let mut p = rest;
    while !p.is_empty() {
        p = p.trim_start();
        if p.is_empty() {
            break;
        }
        let name_len = p.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(p.len());
        let attr_name = &p[..name_len];
        let attr_start = attr_name.as_ptr() as usize - body.as_ptr() as usize;
        let mut cursor = &p[name_len..];
        let mut attr_end = attr_start + attr_name.len();

        let after_ws = cursor.trim_start();
        if after_ws.starts_with('=') {
            cursor = after_ws[1..].trim_start();
            let mut chars = cursor.char_indices();
            match chars.next() {
                Some((_, q)) if q == '"' || q == '\'' => {
                    // 引号值：找到配对的引号。
                    match cursor[1..].find(q) {
                        Some(rel) => {
                            let consumed = 1 + rel + 1;
                            attr_end = attr_start + (cursor.as_ptr() as usize - p.as_ptr() as usize)
                                + consumed;
                            cursor = &cursor[consumed..];
                        }
                        None => cursor = "",
                    }
                }
                Some(_) => {
                    let n = cursor.find(char::is_whitespace).unwrap_or(cursor.len());
                    attr_end = attr_start + (cursor.as_ptr() as usize - p.as_ptr() as usize) + n;
                    cursor = &cursor[n..];
                }
                None => cursor = "",
            }
        }

        if !COLOR_ATTRS.contains(&attr_name.to_ascii_lowercase().as_str()) {
            // ⚠️ 用**原文切片**，连属性之间的空白一起保留（`attr_start..attr_end` 起于
            // 属性名，所以中间那些空白会丢；这里补一个空格回去）。
            kept.push(&body[attr_start..attr_end]);
        }
        p = cursor;
    }

    let mut out = String::with_capacity(tag.len());
    out.push('<');
    out.push_str(name);
    for a in kept {
        out.push(' ');
        out.push_str(a);
    }
    if self_closing {
        out.push('/');
    }
    out.push('>');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 直接调渲染核心（绕过 comrak 的 AST）：够测这一层的全部判据。
    fn render_tex(tex: &str, display: bool, stats: &mut RenderStats) -> String {
        let nm = NodeMath { dollar_math: true, display_math: display, literal: tex.to_owned() };
        render(&nm, stats)
    }

    /// 「这份 HTML 的**标签上**没有留下任何可剥的颜色属性」。
    ///
    /// ⚠️ 判据用 `strip_color_attributes` 的**恒等性**（再剥一次还是原样）——
    /// ⛔ **不是**"在字符串里搜 `style=`"。后者会误报两处**不是属性**的地方：
    /// ① `displaystyle="false"` / `scriptlevel="0"` 里藏着 `style=` 这几个字；
    /// ② `<annotation>` / `<mtext>` 里放的是**被转义的 TeX 源码**，作者写的
    ///    `\text{style=}` 会原样出现。2026-10-14 实测踩过这条：旧断言把
    ///    `\colorbox{yellow}{x}` 判成"还有 `style=`"（**测试红、实现没错**）——
    ///    与 `notes/0009` §2.5 记的"把被转义的文本当成属性"是同一类错。
    fn 无颜色属性(html: &str, what: &str) {
        assert_eq!(
            strip_color_attributes(html),
            html,
            "⛔ INV-MATH-02：{what} 的输出里还留着可剥的颜色属性\n{html}"
        );
    }

    /// ⭐ 上面那条恒等式**只有在"剥属性真的在干活"时才不是空断言**。
    ///
    /// 这里拿 `katex-rs 0.3.0` 的**原始输出**当输入（下面两段是 2026-10-14 用探针
    /// 从 crate 里逐个打出来、原样抄回来的）。⚠️ 它把「上游会输出这些属性」这条
    /// **版本假设变成了一条断言**——`INV-MATH-04` 要的"钉版本 + 跑得起来"就是这个。
    #[test]
    fn 剥属性对上游原始输出是必要的() {
        // `\textcolor{#ff0000}{x}`：⭐ 注意 `#ff0000` 是**字面色值**，
        // 不剥的话它会直接进 DOM，而 `INV-THEME-02` 要挡的正是这个。
        let raw = r##"<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mstyle mathcolor="#ff0000"><mi>x</mi></mstyle></mrow><annotation encoding="application/x-tex">\textcolor{#ff0000}{x}</annotation></semantics></math></span>"##;
        let clean = strip_color_attributes(raw);
        assert_ne!(clean, raw, "⛔ 上游确实会输出 mathcolor，剥属性必须改变它");
        // ⚠️ 判据是**属性**没了：`mathcolor` 连带它的值一起消失。
        // ⛔ **不能**写 `!clean.contains("#ff0000")`——下面那行就说明了为什么：
        //    `<annotation>` 里放的是**被转义的 TeX 源码**，它**含** `#ff0000` 这几个字。
        assert!(!clean.contains("mathcolor"), "⛔ 颜色属性还在：{clean}");
        assert!(clean.contains("<mstyle><mi>x</mi></mstyle>"), "⚠️ 标签被切坏了：{clean}");
        // ⚠️ 但**正文**（`<annotation>` 里被转义的 TeX 源码）要原样留着。
        assert!(clean.contains(r"\textcolor{#ff0000}{x}"), "⚠️ 源码被误伤：{clean}");

        // `\fcolorbox{red}{blue}{x}`：三族里最重的一个——`style` 与 `mathbackground` 同时上。
        let raw = r##"<mpadded lspace="3pt" width="+6pt" style="border: 0.04em solid red" voffset="3pt" mathbackground="blue" height="+6pt"><mstyle displaystyle="false" scriptlevel="0"><mtext>x</mtext></mstyle></mpadded>"##;
        let clean = strip_color_attributes(raw);
        // ⚠️ 判 `style` 用的是它的**值**（`border:`），⛔ 不是 `contains("style=")`——
        //    同一个串里的 `displaystyle="false"` 就含那几个字（见下面那条反面锚点）。
        assert!(!clean.contains("border:"), "⛔ `style` 那一条没剥掉：{clean}");
        assert!(!clean.contains("mathbackground"), "⛔ {clean}");
        // ⚠️ 反面锚点：几何属性必须留着，否则上面两条靠"把整个标签删掉"也能过。
        assert!(clean.contains("lspace=\"3pt\""), "⚠️ 剥过头了：{clean}");
        assert!(clean.contains("voffset=\"3pt\""), "⚠️ 剥过头了：{clean}");
        // ⚠️ `displaystyle="false"` 里**有** `style=` 这几个字，却**不是**属性
        //    ⇒ 不许把它剥掉（这是"按属性名判"的最短反例）。
        assert!(
            clean.contains("displaystyle=\"false\""),
            "⚠️ 把 `displaystyle` 当成了 `style`：{clean}"
        );
    }

    /// ⭐ `INV-MATH-02`：三族**成功路径**的字面色 + 7 个"不返回 `Err`"的命令。
    ///
    /// ⚠️ **只查错误节点的 `#cc0000` 不算通过**——那是首轮评审 R1 指出的漏检。
    /// ⚠️ 判据落在**属性**上（见 [`无颜色属性`]），⛔ 不是子串匹配。
    /// ⚠️ 逐例的一手依据（2026-10-14 探针实测，**全部走 `Ok` 成功路径**）：
    ///
    /// | 输入 | `katex-rs 0.3.0` 的原始输出里有什么 |
    /// |---|---|
    /// | `\textcolor{…}` / `\color{…}` | `mathcolor="#ff0000"` / `mathcolor="red"` |
    /// | `\colorbox{…}` | `mathbackground="yellow"` |
    /// | `\fcolorbox{…}` | `style="border: …"` **与** `mathbackground="blue"` |
    /// | `\rule{…}` | `<mspace mathbackground="black">`（连颜色参数都不要） |
    /// | 7 个"已定义但未实现"的命令 | `<mstyle mathcolor="inherit"><mtext>\href</mtext>` |
    #[test]
    fn 颜色属性在三族成功路径上都被剥掉() {
        let cases = [
            r"\textcolor{#ff0000}{x}",
            r"\color{red}x",
            r"\colorbox{yellow}{x}",
            r"\fcolorbox{red}{blue}{x}",
            r"\rule{1em}{1em}",
            // 下面这 7 个是 `kb/0014` 里"已定义但未实现"的命令：**都返回 `Ok`**。
            r"\href{https://e.com}{x}",
            r"\url{https://e.com}",
            r"\includegraphics{a.png}",
            r"\htmlStyle{color: red}{x}",
            r"\htmlClass{c}{x}",
            r"\htmlId{i}{x}",
            r"\htmlData{a=b}{x}",
        ];
        for tex in cases {
            let mut stats = RenderStats::default();
            let html = render_tex(tex, false, &mut stats);
            无颜色属性(&html, tex);
            assert!(
                !html.contains("#cc0000"),
                "⛔ INV-MATH-02：{tex} 的输出里还有 katex-rs 的错染色\n{html}"
            );
            // 反向断言：不能靠"什么都不渲染"通过上面几条。
            assert!(
                html.contains("<math"),
                "{tex} 应当渲染出 MathML（`\\href` 一族**不返回 Err**，走的是成功路径）\n{html}"
            );
        }
    }

    /// ⭐ 剥的是**属性名**，不是"输出里有没有颜色字符串"。
    /// `<annotation>` / `<mtext>` 里会把 TeX 源码原样放回去，其中可以出现
    /// `mathcolor=` `style=` 这几个字——那**不是属性**，⛔ 不许被当成属性处理
    /// （也不许因此判失败）。
    #[test]
    fn 剥属性认的是属性名不是子串() {
        let mut stats = RenderStats::default();
        let html = render_tex(r"\text{mathcolor=style=}", true, &mut stats);
        // 正文里的这几个字符必须**原样留着**（它只是文本）。
        assert!(
            html.contains("mathcolor=style="),
            "被转义的正文不该被当成属性剥掉\n{html}"
        );
        assert!(html.contains("<math"), "公式本身还是要渲染出来\n{html}");
        无颜色属性(&html, r"\text{mathcolor=style=}");
    }

    /// `style=` 整条剥掉（`\fcolorbox` 那条边框），但**几何属性一个都不许少**。
    ///
    /// ⚠️ 这条以前写成"输出里没有 `mpadded`"——**那是错的**：MathML 模式下
    /// `\fcolorbox` 本来就产出 `<mpadded>`（装内外边距，`kb/0013` 那句"干净的 MathML
    /// 里一个 `style=` 都没有"说的是**别的输入**），要剥的只是它身上的
    /// `style` 与 `mathbackground`（探针实测，见 [`剥属性对上游原始输出是必要的`]）。
    #[test]
    fn style_属性整条消失() {
        let mut stats = RenderStats::default();
        let html = render_tex(r"\fcolorbox{red}{blue}{x}", false, &mut stats);
        无颜色属性(&html, r"\fcolorbox");
        assert!(!html.contains("border:"), "⛔ 边框那条 `style` 没剥掉：{html}");
        // ⚠️ 反面锚点：几何属性还在（否则"什么都不输出"也能过）。
        assert!(html.contains("lspace="), "⚠️ 剥过头了：{html}");
        assert!(html.contains("<mtext>x</mtext>"), "⚠️ 内容被剥掉了：{html}");
    }

    /// ⭐ `INV-MATH-01`：只有 MathML，没有 HTML 那一半。
    ///
    /// ⚠️ 判据要认**HTML 那一半特有的东西**（`katex-html` / `base` / `mord` / `strut`）。
    /// ⛔ **不能拿 `class="katex"` 当判据**：`katex-rs` 即使在 MathML 模式下也会在
    /// 外面套一个 `<span class="katex">`（探针实测）——**两边都有**，认它必误判。
    #[test]
    fn 只走_mathml_不出_html_那一半() {
        let mut stats = RenderStats::default();
        let html = render_tex(r"\frac{a}{b}", false, &mut stats);
        assert!(html.contains("<math"), "应当是 MathML\n{html}");
        for needle in ["katex-html", "class=\"base\"", "class=\"mord\"", "class=\"strut\""] {
            assert!(
                !html.contains(needle),
                "⛔ INV-MATH-01：出现了 KaTeX 的 HTML 输出（{needle}）\n{html}"
            );
        }
        assert!(
            html.contains("class=\"katex\""),
            "⚠️ 上游的外壳还在这里（正好说明判据别认它）：{html}"
        );
    }

    /// 块级公式走 `display="block"` 且**不套 `<p>`**（`INV-MATH-03` 的公式侧；
    /// `<p>` 那一侧由 `render.rs` 的 Paragraph 分支负责）。
    #[test]
    fn 块级公式用_display_block() {
        let mut stats = RenderStats::default();
        let html = render_tex("x = 1", true, &mut stats);
        assert!(html.contains("display=\"block\""), "块级公式应当是 display=\"block\"\n{html}");
        assert!(!html.contains("<p>"), "⛔ INV-MATH-03：公式这一层不该出现 <p>\n{html}");
    }

    /// ⭐ `INV-MATH-04`：TeX 源码作为"第三方字符串"——进 DOM 前必须已转义。
    /// ⚠️ 判据是**真标签**，⛔ **不是子串匹配**（`notes/0009` §2.5 那条差点误报的教训）。
    #[test]
    fn annotation_里的对抗输入被转义() {
        let cases: [&str; 6] = [
            "<script>alert(1)</script>",
            "</annotation><script>alert(1)</script>",
            "</math><img src=x onerror=alert(1)>",
            "x\" onload=\"alert(1)",
            "]]>",
            r"\text{</annotation><b>hi</b>}",
        ];
        for tex in cases {
            let mut stats = RenderStats::default();
            let html = render_tex(tex, false, &mut stats);
            for needle in ["<script", "<img", "<b>"] {
                assert!(
                    !html.contains(needle),
                    "⛔ INV-MATH-04：{tex} 的输出里出现了真标签 {needle}\n{html}"
                );
            }
        }
    }

    /// ⭐ `INV-MATH-05`：三条边界各测恰好等于 / 超过一字节。
    #[test]
    fn 尺寸闸门_输入边界() {
        // 恰好等于上限：长度要落在**渲染前**的比较上，所以用 `\text{...}` 撑到精确长度。
        let pad = "a".repeat(MAX_TEX_INPUT - r"\text{}".len());
        let at_limit = format!(r"\text{{{pad}}}");
        assert_eq!(at_limit.len(), MAX_TEX_INPUT);
        let mut stats = RenderStats::default();
        let html = render_tex(&at_limit, false, &mut stats);
        assert!(html.contains("<math"), "恰好等于上限应当渲染\n{html}");
        assert_eq!(stats.math_oversize, 0);

        // 超过一字节：必须回落成源码。
        let over = format!("{at_limit}b");
        let mut stats = RenderStats::default();
        let html = render_tex(&over, false, &mut stats);
        assert!(html.contains("rmd-math-oversize"), "超过上限必须回退\n{html}");
        assert!(!html.contains("<math"), "回退时不该再有 MathML\n{html}");
        assert_eq!(stats.math_oversize, 1);

        // 回退输出的是**转义后的源码**，且长度与原文一致（没有偷偷截断）。
        assert!(html.contains(&"a".repeat(64)), "回退应当输出源码\n{html}");
        assert!(
            html.contains(&format!("{at_limit}b")),
            "回退要把源码**完整**给出（⛔ 不截断）\n{html}"
        );
    }

    /// ⭐ `INV-MATH-05`：文档累计触顶 ⇒ 剩余公式一律回退源码，且**可观测**。
    #[test]
    fn 尺寸闸门_文档累计触顶后可观测() {
        let mut stats = RenderStats::default();
        stats.math_bytes = MAX_DOC_MATH_OUTPUT;

        let html = render_tex("x", false, &mut stats);
        assert!(html.contains("rmd-math-oversize"), "触顶后应当回退\n{html}");
        assert_eq!(stats.math_budget_exhausted, 1, "触顶必须可观测（计数非零）");
        assert_eq!(stats.math_rendered, 0, "触顶之后不该再真的渲染");
    }

    /// 解析失败（`Err`）走**我们自己的**节点，⛔ 不用 katex-rs 的错染。
    #[test]
    fn 解析失败回退成转义源码() {
        let mut stats = RenderStats::default();
        let html = render_tex(r"\def\a{\a}\a", false, &mut stats);
        assert!(html.contains("rmd-math-error"), "应当是我们的错误节点\n{html}");
        assert!(!html.contains("mathcolor="), "⛔ 不许出现 katex-rs 的错染\n{html}");
        assert_eq!(stats.math_error, 1);
    }

    /// 空公式（`$$ $$`）不该被送进 katex-rs。
    #[test]
    fn 空公式直接回退() {
        let mut stats = RenderStats::default();
        let html = render_tex("\n  \n", true, &mut stats);
        assert!(html.contains("rmd-math-empty"), "{html}");
        assert_eq!(stats.math_fallback, 1);
    }

    /// 剥属性不能破坏标签结构：属性值里带 `>` 也要认得出来。
    #[test]
    fn 剥属性认引号里的尖括号() {
        let src = r#"<mstyle mathcolor="a>b" mathvariant="normal">x</mstyle>"#;
        let out = strip_color_attributes(src);
        assert_eq!(out, r#"<mstyle mathvariant="normal">x</mstyle>"#);
    }

    /// `url(#…)` 这类**不是颜色**的东西必须原样保留（同 `INV-DIAG-02` 的形态）。
    #[test]
    fn 剥属性不动别的引用() {
        // ⚠️ 用 `r##"…"##`：内容里有 `href="#x"`，那个 `"#` 会提前结束 `r#"…"#`。
        let src = r##"<math><a href="#x">u</a><mrow data-x="1"></mrow></math>"##;
        assert_eq!(strip_color_attributes(src), src);
    }
}
