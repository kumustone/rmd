//! 代码高亮的 comrak 适配器（`design/0007` §2.1.1）。
//!
//! ⛔ **不抄 comrak 自带的 `SyntectAdapter`**（`docs/kb/0012` 记了它的三处硬伤）：
//! ① 传 `theme` 会输出内联 `style="background-color:#…"` ⇒ 破 `INV-THEME-02`；
//! ② 主题名拼错会在 `HashMap` 索引处 **panic**；③ `Err` 回退的 `write_str(code)`
//! **不转义**，而 comrak 把适配器输出**逐字**写进 HTML（`html.rs` 的
//! `highlighter.write_highlighted(context, …)` 不再过任何转义）。
//!
//! 本模块的纪律就是那三条的镜像：
//!
//! - **只出 class**（`INV-HL-01`）：`ClassStyle::SpacedPrefixed { prefix: "rmd-" }`，
//!   ⛔ 没有 `ThemeSet`、⛔ 没有内联样式。
//! - **⛔ 永不把 theme 传进来**（`INV-HL-03`）：本结构体**不持有** `Theme`，
//!   所以"拼错主题名 ⇒ panic"这条路**写不出来**。
//! - **失败回退必须转义**（`INV-HL-02`）：`Err` 时丢弃生成到一半的 HTML，
//!   走 `escape_html_into()` 输出原文。
//!
//! ⚠️ **`Err` 那条路至今没被真实输入触发过**（`notes/0009` §1 的 25 例对抗输入
//! 一个都没触发）。它是**结构性隐患**，⛔ 不是已复现的漏洞——但转义便宜到没有理由不做。

use std::fmt;
use std::sync::OnceLock;

use comrak::adapters::SyntaxHighlighterAdapter;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

/// 高亮输出里所有 class 的前缀。⭐ **改它要同时改 `src/styles/highlight.css`。**
pub const CLASS_PREFIX: &str = "rmd-";

/// `<pre>` 上的 class（`design/0007` §2.1.1）。
pub const PRE_CLASS: &str = "rmd-code";

// ————————————————————————————————————————————————————————————————————————————
// 规模闸门（`design/0007` 文末「Q22 代码高亮规模闸门」追加节）
// ————————————————————————————————————————————————————————————————————————————
//
// ⚠️ 这四个数是用户 2026-10-15 拍板的**保守初值**，⛔ **不是实测最优值、
// 也不是延迟硬上界**：既有"每 KB 平均成本"不能保证单块最坏解析时间，
// 超长单行 / 正则最坏输入仍需探针（见 `design/0007` §10.3 与 Q22 追加节末段）。
//
// ⚠️ 判据是**字节**（`str::len()`，UTF-8），⛔ 不是字符数——中文代码块按字符数
// 判会**放行三倍**的量。

/// 单块**输入**上限：`⛔ 超限整块不高亮`（Q22 表第 1 行）。
///
/// ⭐ 它是**主闸门**：能约束渲染阶段资源消耗的只有"渲染之前的输入闸门"
/// （评审 R4 点破的那句话，`design/0007` §3.1 原则行）。
/// 依据：10 MB 代码密集文档上高亮把 `T3` 从 13.5 ms 推到 **3354 ms（248×）**（§10.3）。
pub const MAX_CODE_INPUT: usize = 128 * 1024;

/// 整篇**累计输入**上限：`当前块会超累计预算则整块回退，并将后续普通代码块都回退`（Q22 表第 2 行）。
pub const MAX_DOC_CODE_INPUT: usize = 512 * 1024;

/// 单块**高亮输出**上限：超限丢弃该块的部分结果，整块回退（Q22 表第 3 行）。
///
/// ⚠️ Q22 原文写的是"**生成期间**按写入预算限制"。本实现是**生成后判定**——
/// `syntect` 的 `ClassedHTMLGenerator` 不暴露已写字节数（只能 `finalize()`），
/// 硬做早停要按输入字节**估**一个膨胀系数，那是猜的。⇒ 这一条**只是二次保险**，
/// 真正省下分词时间的是上面那条输入闸门（⛔ 别把它读成"挡住了最坏耗时"）。
pub const MAX_CODE_OUTPUT: usize = 1024 * 1024;

/// 整篇**累计输出**上限（Q22 表第 4 行）。
///
/// ⚠️ 战锚同样是**量级锚点**：本仓库最大语料的 HTML 是 `XL-tables` 的 **33.3 MB**
/// （`benchmarks/results/2026-10-13-Mac14,9.json`）⇒ 4 MiB ≈ 它的 12%。
/// ⛔ 累计里**不含**普通正文与回退出去的那些代码块（Q22 明文）。
pub const MAX_DOC_CODE_OUTPUT: usize = 4 * 1024 * 1024;

/// 语法集只载入一次（实测 0.4–1.3 ms / 75 条语法，但没必要每个围栏来一遍）。
///
/// ⚠️ 存的是 `Option`：`SyntaxSet` 载入失败（语法包损坏）时**降级成不高亮**
/// （`design/0007` §6），⛔ 不让它把整份文档的打开带崩。
static HIGHLIGHTER: OnceLock<Option<RmdHighlighter>> = OnceLock::new();

/// 取全局适配器。`None` = 高亮整体不可用（语法包坏了），调用方**照常渲染**。
pub fn highlighter() -> Option<&'static RmdHighlighter> {
    HIGHLIGHTER.get_or_init(|| RmdHighlighter::load().ok()).as_ref()
}

/// 自己实现的高亮适配器。
pub struct RmdHighlighter {
    syntaxes: SyntaxSet,
}

impl RmdHighlighter {
    /// 载入内置语法集。⚠️ 用 `load_defaults_newlines()`——
    /// `ClassedHTMLGenerator::parse_html_for_line_which_includes_newline`
    /// **要求每行带结尾换行**，配套的是 newlines 版语法集；两个 `load_defaults_*`
    /// 混用会静默少解析（上游文档写得很明确，但很容易配错）。
    fn load() -> Result<Self, syntect::LoadingError> {
        Ok(Self { syntaxes: SyntaxSet::load_defaults_newlines() })
    }

    /// 把一段代码渲染成 class-only 的 HTML 片段。
    ///
    /// **任何一步出错 ⇒ 返回 `None`**，由调用方回退成"转义后原样输出"。
    ///
    /// ⚠️ `pub(crate)`：调用方是 `render.rs` 的代码块闸门（Q22）。
    /// ⛔ **不要**把它当成"绕过适配器"的入口——`SyntaxHighlighterAdapter`
    /// 那条实现仍然在，两者用的是**同一个**函数。
    pub(crate) fn highlighted(&self, lang: Option<&str>, code: &str) -> Option<String> {
        let syntax = match lang {
            Some(l) if !l.is_empty() => self
                .syntaxes
                .find_syntax_by_token(l)
                // 认不出的语言**不是错误**：GFM 允许 ```` ```随便写 ````，
                // 回落成纯文本语法即可（有颜色不如没有强）。
                .unwrap_or_else(|| self.syntaxes.find_syntax_plain_text()),
            _ => self.syntaxes.find_syntax_plain_text(),
        };

        // ⚠️ **`gen` 是 edition 2024 的保留字**（`gen` 块），变量⛔ 不能叫这个名字。
        let mut generator = ClassedHTMLGenerator::new_with_class_style(
            syntax,
            &self.syntaxes,
            ClassStyle::SpacedPrefixed { prefix: CLASS_PREFIX },
        );

        for line in LinesWithEndings::from(code) {
            // ⛔ 这一行就是 `INV-HL-02` 的落点：出错**不能**把半截 HTML 交出去。
            generator.parse_html_for_line_which_includes_newline(line).ok()?;
        }
        Some(generator.finalize())
    }
}

impl SyntaxHighlighterAdapter for RmdHighlighter {
    fn write_highlighted(
        &self,
        output: &mut dyn fmt::Write,
        lang: Option<&str>,
        code: &str,
    ) -> fmt::Result {
        match self.highlighted(lang, code) {
            Some(html) => output.write_str(&html),
            // ⭐ 回退路径：**转义**后原样输出（INV-HL-02）。
            None => escape_html_into(output, code),
        }
    }

    fn write_pre_tag(
        &self,
        output: &mut dyn fmt::Write,
        mut attributes: std::collections::HashMap<&'static str, std::borrow::Cow<'_, str>>,
    ) -> fmt::Result {
        output.write_str("<pre class=\"")?;
        output.write_str(PRE_CLASS)?;
        output.write_str("\"")?;
        // ⚠️ 先摘掉 `attributes` 里的 `class`：comrak 在 `github_pre_lang` 模式下会把
        // `lang="…"` 放进 `<pre>`，但**不会**放 class（class 是我们的）。真出现了也不能
        // 与上面那个并列成两个 class 属性。
        attributes.remove("class");
        write_attributes(output, attributes)?;
        output.write_str(">")
    }

    fn write_code_tag(
        &self,
        output: &mut dyn fmt::Write,
        attributes: std::collections::HashMap<&'static str, std::borrow::Cow<'_, str>>,
    ) -> fmt::Result {
        output.write_str("<code")?;
        write_attributes(output, attributes)?;
        output.write_str(">")
    }
}

/// 写出 `k="v"`。⚠️ 值必须转义——它来自 info string（`class="language-xxx"`），
/// 理论上含 `"` 就能从围栏信息串里插一个属性出来。
fn write_attributes(
    output: &mut dyn fmt::Write,
    attributes: std::collections::HashMap<&'static str, std::borrow::Cow<'_, str>>,
) -> fmt::Result {
    // ⚠️ 排序：`HashMap` 的迭代顺序不定，不排的话同一份输入能有多种输出，
    // 断言「输出逐字等于某串」会随机红。
    let mut keys: Vec<&'static str> = attributes.keys().copied().collect();
    keys.sort_unstable();
    for k in keys {
        let v = &attributes[k];
        output.write_str(" ")?;
        output.write_str(k)?;
        output.write_str("=\"")?;
        // 属性值用 `&quot;`：这是 HTML 里**唯一**能逃出双引号包围的属性值的字符。
        for ch in v.chars() {
            match ch {
                '"' => output.write_str("&quot;")?,
                '&' => output.write_str("&amp;")?,
                _ => output.write_char(ch)?,
            }
        }
        output.write_str("\"")?;
    }
    Ok(())
}

/// 围栏 info string 里的**语言**：起首到第一个空白为止（其余是 meta）。
///
/// ⚠️ 这是 comrak 0.56 `html.rs:503-510` 的**同一套切法**，⛔ 不是"取第一个词"的
/// 随手近似——两处对不齐的表现是"闸门按 A 判、渲染按 B 走"。
///
/// ⚠️⚠️ **判据是 cmark 的 ctype 表，⛔ 不是 `char::is_whitespace`**：
/// comrak 逐**字节**查 `ctype::isspace`，那张表（`comrak-0.56.0/src/ctype.rs:4`）
/// 只有 **`\t` `\n` `\r` 空格** 四个字节是空白。两处会差在这些字符上：
///
/// | 字符 | `char::is_whitespace` | comrak 的 `isspace` |
/// |---|---|---|
/// | U+3000 全角空格 | ✅ 算 | ⛔ 不算（首字节 `0xE3`） |
/// | U+000C 换页 `\f` | ✅ 算 | ⛔ 不算（表里第 12 位是 `0`） |
/// | U+000B 垂直制表 | ✅ 算 | ⛔ 不算 |
///
/// ⇒ 写成 `find(char::is_whitespace)` 会让 `````` ```\u{3000}rust `````` 这类围栏
/// **闸门判成空语言、渲染判成"语言是 `\u{3000}rust`"**——两边不一致，而症状是
/// 「`language-` 这个 class 与高亮语法对不上」这种没人会去看的地方。
pub fn fence_lang(info: &str) -> &str {
    let bytes = info.as_bytes();
    let mut i = 0;
    // ⚠️ cmark 那张表里为 1 的就是这四个字节，⛔ 别换成 `is_ascii_whitespace()`
    //    （那个多一个 `\f`）。
    while i < bytes.len() && !matches!(bytes[i], b'\t' | b'\n' | b'\r' | b' ') {
        i += 1;
    }
    &info[..i]
}

/// 取全局适配器；语法包坏了就是 `None`。
///
/// ⚠️ 与 [`highlighter`] 的差别只在于"要不要拿到适配器本体"：
/// 闸门那条路要自己写外壳（见 [`write_plain_code_block`]），所以要的是函数。
pub fn highlight_code(lang: Option<&str>, code: &str) -> Option<String> {
    highlighter()?.highlighted(lang, code)
}

/// 写出一整个**不高亮**的代码块：`<pre class="rmd-code"><code …>转义后的原文</code></pre>`。
///
/// ⭐ 这是 Q22「超限回退为**完整、转义的纯文本**代码块」的落点：
/// **不截断内容**、⛔ 不跳过正文、⛔ 不加 WebView 侧高亮 JS（Q22 决定段第一句）。
///
/// ⚠️ 外壳**镜像** comrak 0.56 `render_code_block`（`html.rs:494-590`）在
/// 本项目选项下的结果：`github_pre_lang = false`（⇒ `class="language-x"` 落在
/// `<code>` 上）、`full_info_string = false`、`render.sourcepos = false`
/// （⇒ `<pre>` 上没有 `data-sourcepos`）。⛔ 改 `ParseOpts` 那三项时要回来对一遍。
///
/// ⚠️ 调用方**还要写那个行尾换行**（`Context::lf()`）——这里只到 `</code></pre>`，
/// 因为 `lf()` 是 `Context` 的方法、要在 `render.rs` 那一侧调（与默认路径逐字一致）。
pub fn write_plain_code_block(
    out: &mut dyn fmt::Write,
    info: &str,
    lang: &str,
    code: &str,
) -> fmt::Result {
    write_code_block_open(out, info, lang)?;
    escape_html_into(out, code)?;
    out.write_str(CODE_BLOCK_CLOSE)
}

/// 写出一整个**已高亮**的代码块：外壳同上，内部换成 `highlight_code()` 的产物。
///
/// ⚠️ `html` 必须是 [`highlight_code`] 的返回值**逐字**——那一层自己会转义。
/// ⛔ 别把未转义的原文传进来（`INV-HL-02` 的镜像）。
pub fn write_highlighted_code_block(
    out: &mut dyn fmt::Write,
    info: &str,
    lang: &str,
    html: &str,
) -> fmt::Result {
    write_code_block_open(out, info, lang)?;
    out.write_str(html)?;
    out.write_str(CODE_BLOCK_CLOSE)
}

/// `</code></pre>`——外壳的收尾。
const CODE_BLOCK_CLOSE: &str = "</code></pre>";

/// 代码块外壳的**开头**，一直到 `<code …>` 的 `>` 为止。
///
/// ⚠️ **两条路（纯文本 / 已高亮）共用**这一份：外壳分叉过一次就再也对不齐了，
/// 而判据是"逐字节等于 comrak 在同一个选项下会写的那个"。
fn write_code_block_open(out: &mut dyn fmt::Write, info: &str, lang: &str) -> fmt::Result {
    out.write_str("<pre class=\"")?;
    out.write_str(PRE_CLASS)?;
    out.write_str("\">")?;
    out.write_str("<code")?;
    let mut attrs = std::collections::HashMap::new();
    // ⚠️ 判据是 `!info.is_empty()`（**原样**），⛔ 不是 `!lang.is_empty()`——
    //    comrak 那一行（`html.rs:537`）就是这个。```` ``` rust ```` 这类
    //    "info 非空但语言为空"的围栏，comrak 会写出 `class="language-"`；
    //    按 `lang` 判就会少一个属性，两处输出不再逐字一致。
    if !info.is_empty() {
        attrs.insert("class", std::borrow::Cow::Owned(format!("language-{lang}")));
    }
    // ⚠️ 复用同一份属性转义：`lang` 来自 info string，含 `"` 就能插一个属性出来。
    write_attributes(out, attrs)?;
    out.write_str(">")
}

/// 把文本按 **HTML 正文**语义转义后写出。
///
/// ⚠️ 与 comrak 的 `html::escape` 是同一套字符集（`&` `<` `>` `"`），
/// 这里自己写一份是因为它不在 comrak 的公开 API 里；⛔ 两处语义必须一致。
pub fn escape_html_into(output: &mut dyn fmt::Write, s: &str) -> fmt::Result {
    for ch in s.chars() {
        match ch {
            '&' => output.write_str("&amp;")?,
            '<' => output.write_str("&lt;")?,
            '>' => output.write_str("&gt;")?,
            '"' => output.write_str("&quot;")?,
            _ => output.write_char(ch)?,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h() -> &'static RmdHighlighter {
        highlighter().expect("内置语法集应当能载入")
    }

    fn render(lang: Option<&str>, code: &str) -> String {
        let mut out = String::new();
        h().write_highlighted(&mut out, lang, code).unwrap();
        out
    }

    /// 把一个标签的属性串按**引号感知**切成一个个 `name="value"`。
    ///
    /// ⚠️ ⛔ 不能 `split_whitespace()`：`class="a b"` 里的空格是**值的一部分**。
    fn split_attributes(attrs: &str) -> Vec<&str> {
        let b = attrs.as_bytes();
        let mut out = Vec::new();
        let mut i = 0usize;
        while i < b.len() {
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= b.len() {
                break;
            }
            let start = i;
            let mut quote: Option<u8> = None;
            while i < b.len() {
                let c = b[i];
                match quote {
                    Some(q) => {
                        if c == q {
                            quote = None;
                        }
                    }
                    None => {
                        if c == b'"' || c == b'\'' {
                            quote = Some(c);
                        } else if c.is_ascii_whitespace() {
                            break;
                        }
                    }
                }
                i += 1;
            }
            out.push(&attrs[start..i]);
        }
        out
    }

    /// ⭐ `INV-HL-01`：输出里**只有 class**，⛔ 没有字面色值、⛔ 没有内联 `style=`。
    ///
    /// ⚠️ 样本里**故意不含** `#rrggbb` 形态的字面量——这条测的是**我们生成的标记**，
    /// 而代码原文里的 `#ff0000` 本来就该原样显示。所以判据是两条：
    /// ① 没有 `style=`；② 没有 `class="` 之外的字面色值来源（用 `syntect` 只会出 class
    /// 这一事实 + 下面那条"span 里只有 class"来钉）。
    #[test]
    fn 高亮只出_class_不出字面色与内联样式() {
        let code = "fn main() {\n    let x = 1; // 注释\n    println!(\"{x}\");\n}\n";
        let html = render(Some("rust"), code);

        assert!(!html.contains("style="), "⛔ INV-HL-01：输出里出现了内联 style=\n{html}");
        assert!(!html.contains("color:"), "⛔ INV-HL-01：输出里出现了 CSS 颜色声明\n{html}");

        // ⭐ 每个 `<span …>` 上只允许有 `class`——这是"只出 class"的**结构性**判据，
        // ⛔ 比"搜某个颜色字符串"强（后者会漏掉没见过的色值）。
        // ⚠️ 属性解析必须**认引号**：`class="rmd-source rmd-rust"` 里的空格**不是**
        //    属性分隔符，按空白切会切出一个假的 `rmd-rust"`（2026-10-14 实测踩过，
        //    与 `notes/0009` §2.5"拿被转义的文本当属性"是同一族错）。
        for tag in html.split('<').skip(1) {
            let name_end = tag.find(|c: char| c == '>' || c.is_whitespace()).unwrap_or(tag.len());
            if &tag[..name_end] != "span" {
                continue;
            }
            let attrs = tag[name_end..].split('>').next().unwrap_or("");
            for attr in split_attributes(attrs) {
                assert!(
                    attr.is_empty() || attr.starts_with("class="),
                    "⛔ INV-HL-01：<span> 上有非 class 的属性 {attr:?}\n{html}"
                );
            }
        }

        // 反向断言：不能靠"干脆不高亮"通过上面两条
        assert!(html.contains("class=\""), "高亮没产出任何 class，等于没高亮\n{html}");
        assert!(html.contains(CLASS_PREFIX), "class 应当带 {CLASS_PREFIX} 前缀\n{html}");
    }

    /// ⭐ `INV-HL-02`：失败回退必须是**转义后**的输出。
    ///
    /// ⚠️ **真实输入至今没能触发 `Err`**（`notes/0009` §1 的 25 例一个都没触发）。
    /// 所以这里直接测**回退函数本身**，⛔ 不假装测过一条走不到的路——
    /// 断言的是"如果走到了那条路，它输出的是不是转义的"。
    #[test]
    fn 回退路径转义() {
        let hostile = "<script>alert(1)</script> & \"引号\"";
        let mut out = String::new();
        escape_html_into(&mut out, hostile).unwrap();

        assert!(!out.contains("<script"), "⛔ INV-HL-02：回退路径把原文标签送出去了\n{out}");
        assert!(out.contains("&lt;script&gt;"), "回退路径必须转义\n{out}");
        assert!(out.contains("&amp;"), "`&` 也要转义\n{out}");
        assert!(out.contains("&quot;"), "`\"` 也要转义\n{out}");
    }

    /// 认不出的语言**不是错误**，回落成纯文本语法。
    #[test]
    fn 未知语言回落成纯文本() {
        let html = render(Some("绝对不存在的语言"), "x < y\n");
        assert!(html.contains("&lt;"), "纯文本路径也必须转义\n{html}");
        assert!(!html.contains("style="), "⛔ INV-HL-01\n{html}");
    }

    /// ⭐ 属性值转义：info string 里的 `"` 不能插出一个属性来。
    #[test]
    fn 属性值里的引号被转义() {
        let mut out = String::new();
        let mut attrs = std::collections::HashMap::new();
        attrs.insert("class", std::borrow::Cow::Borrowed("language-x\" onload=\"alert(1)"));
        write_attributes(&mut out, attrs).unwrap();

        assert!(!out.contains("onload=\"alert"), "⛔ 属性值没转义，插出了一个新属性\n{out}");
        assert!(out.contains("&quot;"), "属性值里的 `\"` 必须转成 &quot;\n{out}");
    }
}
