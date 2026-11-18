//! ⭐ **导出的纯逻辑**（`design/0076` §2.1.2–§2.1.4）：CSS 打包、图片内联、页面拼装。
//!
//! # 为什么这些放在 `document/`，而且**不 gate `gui`**
//!
//! 它们全是**纯函数**：输入一个已经渲染好的 `body_html`，输出一个自足的 HTML 字符串。
//! 不碰 Tauri、不碰 `Session`、不碰授权——授权与落点在 `commands/export.rs`，
//! 写盘在 `fs/atomic.rs`。⭐ 所以 `make test`（默认构建）能把这里每一条判据都跑一遍，
//! 而不是只能等"打开 app 点一次导出"。
//!
//! # 三条边界（`design/0076` §2.1.0）
//!
//! 1. **Rust 是渲染权威**：正文来自 [`render_source`](crate::commands::document)，
//!    本模块⛔ 不重新渲染、⛔ 不改正文，只**替换 `<img>` 的 `src` 值与整个标签**。
//! 2. **产物自足**：没有 `<link>`、没有 `<script>`、没有 `@import`；样式在**一个**
//!    `<style>` 里，图片是 `data:` URI，打不开的图换成占位框。
//! 3. **预算有上限**：单张 32 MiB、总量 64 MiB（原始字节）。超了**保留原标签**并计数，
//!    ⛔ 不让整个导出失败。
//!
//! ⚠️ 默认构建里这些函数只有单测在调用（产品调用点在 `commands/export.rs`，
//! 那是 `--features gui`）⇒ 统一豁免 `dead_code`（与 `fs/atomic.rs` 同一条理由）。

#![cfg_attr(not(feature = "gui"), allow(dead_code))]

use serde::{Deserialize, Serialize};

use crate::config::Appearance;

/// 单张图片内联的原始字节上限（`design/0076` §2.1.4）。
///
/// ⚠️ 与 `read_asset` 的 [`MAX_ASSET_BYTES`](crate::commands::asset::MAX_ASSET_BYTES)
/// 是**同一个数**——那边 `pub use` 的就是本常量。两份各写一遍的话，某天只改一边，
/// "阅读态能看的图导出时被保留成打不开的标签"会成为一个没有报错的怪现象。
pub const MAX_INLINE_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// 一次导出里图片内联的**原始字节**总量上限（`design/0076` §2.1.4）。
///
/// ⚠️ base64 约 ×1.37 ⇒ 最坏情况下产物 ~85 MiB。这是**接受**的上限，
/// 也是"不设上限"被打回的理由：一份 300 MB 的扫描件合集会把进程顶爆。
pub const MAX_INLINE_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────
// ① CSS 打包（编译期嵌入，`design/0076` §2.1.3）
// ─────────────────────────────────────────────────────────────────────

/// 六张样式表的**拼接**，顺序与 `index.html` 一致：
/// `tokens → themes → style → typography → highlight → print`。
///
/// `sidebar / quickopen / find / settings / image-viewer / editor / live`
/// **不内联**——产物里根本没有那些元素（而且 `live.css` 的规则是给编辑器的）。
/// ⚠️ `print.css` 带上：导出的这份文件将来再被打印时，页边距与去壳规则同样要有。
///
/// ⚠️ 每张前面一行 `/* ===== 文件名 ===== */`：产物是一整块 `<style>`，
/// 出问题时能一眼看出规则来自哪张表。
/// ⚠️ 编译期嵌入（`include_str!`）而不是运行期读盘：运行期读不到源码目录，
/// 而"把样式抄一份进 Rust 字符串"会在第一次改 CSS 时就漂掉。
const CSS_BUNDLE: &str = concat!(
    "/* ===== tokens.css ===== */\n",
    include_str!("../../../src/styles/tokens.css"),
    "\n/* ===== themes.css ===== */\n",
    include_str!("../../../src/styles/themes.css"),
    "\n/* ===== style.css ===== */\n",
    include_str!("../../../src/style.css"),
    "\n/* ===== typography.css ===== */\n",
    include_str!("../../../src/styles/typography.css"),
    "\n/* ===== highlight.css ===== */\n",
    include_str!("../../../src/styles/highlight.css"),
    "\n/* ===== print.css ===== */\n",
    include_str!("../../../src/styles/print.css"),
);

/// 给测试与 `compose_page` 用：产物的样式块。
pub fn css_bundle() -> &'static str {
    CSS_BUNDLE
}

// ─────────────────────────────────────────────────────────────────────
// ② 外观快照（前端传，Rust 先校验再格式化）
// ─────────────────────────────────────────────────────────────────────

/// 前端传来的外观快照（`design/0076` §2.1.3）。
///
/// ⚠️ **为什么由前端传**：验收判据是"与**屏幕上**的阅读态一致"，
/// 而 `theme.js` 的乐观更新可能领先落盘队列 ≤500 ms（`INV-THEME-05` 的写盘节奏）。
/// 后端读 `config.json` 会读到"上一次落盘"的值，与用户眼前那一份不是一回事。
///
/// ⚠️⚠️ **它不可信**：所有字段都是 `Option`，越界 / 非有限值 / 未知主题名一律
/// **回落**到 [`Appearance`] 的当前值（`config.json` 那份），⛔ 不报错。
/// 拼进 `style` 属性的**只有 Rust 重新格式化后的数字与 `&'static str`**，
/// ⛔ 不直接拼前端字符串（防注入）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct AppearanceIn {
    /// `"light"` / `"dark"` / `"warm"`（`"system"` 等其余值回落）。
    pub theme: Option<String>,
    /// 正文字号（px）。
    pub font_size: Option<f64>,
    /// 行高倍数（无单位）。
    pub line_height: Option<f64>,
    /// 内容宽度上限（px；`0` = 铺满）。
    pub content_width: Option<f64>,
}

/// 校验并格式化后的外观（只含产品允许的取值）。
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedAppearance {
    /// 三套主题之一（`light` / `dark` / `warm`）。
    pub theme: &'static str,
    /// 正文字号（px）。
    pub font_size: f64,
    /// 行高倍数。
    pub line_height: f64,
    /// 内容宽度上限（px；`0` = 铺满）。
    pub content_width: f64,
}

impl AppearanceIn {
    /// 校验快照，越界项回落到 `fallback`（`config.json` 里的外观）。
    ///
    /// ⚠️ `"system"` **不**原样进产物：导出的是一份静态文件，没有"系统外观"可跟。
    /// 回落顺序：快照里的 `light/dark/warm` → 配置里的 `light/dark/warm` →
    /// 配置是 `system` ⇒ **`light`**（纸面/静态文件的安全缺省，不是深色）。
    pub fn resolve(&self, fallback: &Appearance) -> ResolvedAppearance {
        let theme = match self.theme.as_deref() {
            // ⚠️ 逐个匹配**字面量**，⛔ 不把 `as_deref()` 借出来的 `&str` 直接返回：
            //    它的生命周期跟着 `&self`，而 `ResolvedAppearance::theme` 要 `&'static str`
            //    （拼进产物的是编译期常量，⛔ 不是前端串）。
            Some("light") => "light",
            Some("dark") => "dark",
            Some("warm") => "warm",
            _ => match fallback.mode.as_str() {
                "dark" => "dark",
                "warm" => "warm",
                // `"system"` / 未知 ⇒ 静态文件取浅色（不改用户会话里的外观状态）
                _ => "light",
            },
        };
        let font_size = self
            .font_size
            .filter(|v| v.is_finite() && (8.0..=32.0).contains(v))
            .unwrap_or(fallback.font_size);
        let line_height = self
            .line_height
            .filter(|v| v.is_finite() && (1.0..=3.0).contains(v))
            .unwrap_or(fallback.line_height);
        let content_width = self
            .content_width
            .filter(|v| v.is_finite() && (*v == 0.0 || (320.0..=2400.0).contains(v)))
            .unwrap_or(fallback.content_width);
        ResolvedAppearance { theme, font_size, line_height, content_width }
    }
}

/// 把 `f64` 格式化成**没有指数、没有 `.0` 尾巴**的十进制——HTML 的 `style` 属性里要的是
/// `16px` / `1.8`，不是 `1.6e1`。
fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

// ─────────────────────────────────────────────────────────────────────
// ③ 页面拼装（`design/0076` §2.1.3 的模板）
// ─────────────────────────────────────────────────────────────────────

/// 转义 HTML **文本**（标题用）。正文不经过这里——渲染器已经转义过了。
fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// 拼出那份**自足**的单文件 HTML。
///
/// ⚠️ `body_html` **原样嵌入**：渲染器已做过转义与 URL 改写，导出侧只动 `<img>`
/// （[`inline_images`]）。⛔ 别在这里再转义一次——那会把正文里的 `<p>` 印成字面量。
pub fn compose_page(
    title: &str,
    body_html: &str,
    app: &AppearanceIn,
    fallback: &Appearance,
) -> String {
    let a = app.resolve(fallback);
    let width = if a.content_width == 0.0 {
        "none".to_string()
    } else {
        format!("{}px", fmt_num(a.content_width))
    };
    let style = format!(
        "--reader-font-size:{}px;--reader-line-height:{};--reader-content-width:{}",
        fmt_num(a.font_size),
        fmt_num(a.line_height),
        width
    );
    format!(
        "<!DOCTYPE html>\n\
<html lang=\"zh-CN\" data-theme=\"{theme}\"\n      style=\"{style}\">\n\
<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{title}</title>\n  <style>{css}</style>\n</head>\n\
<body><main id=\"doc\" class=\"doc\">{body}</main></body>\n\
</html>\n",
        theme = a.theme,
        style = style,
        title = escape_text(title),
        css = css_bundle(),
        body = body_html,
    )
}

// ─────────────────────────────────────────────────────────────────────
// ④ 图片内联（`design/0076` §2.1.4）
// ─────────────────────────────────────────────────────────────────────

/// 一次内联尝试拿到的资产。**路径解析与 MIME 判定由调用方负责**
/// （`commands/export.rs` 走 `asset::resolve` / `asset::mime_of`）——
/// 本模块⛔ 不重复实现"文档里的 `src` 指向哪个文件"这条真相。
pub struct InlineAsset {
    /// 原始字节。
    pub bytes: Vec<u8>,
    /// MIME（`image/png` 等）。
    pub mime: String,
}

/// 内联计数（也是 [`ExportOutcome`] 的三个字段）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ImageCounts {
    /// 成功换成 `data:` URI 的张数。
    pub inlined: usize,
    /// **保留原标签**的张数（读失败 / 未授权 / 超预算 / 未知 scheme / 畸形）。
    pub kept: usize,
    /// 换成占位框的张数（远程 / 渲染期就不支持的 scheme）。
    pub placeholder: usize,
}

/// 导出的结果（前端据此写状态条）。
#[derive(Debug, Clone, Serialize)]
pub struct ExportOutcome {
    /// 写入的（已规范化的）目标路径。
    pub path: String,
    /// 写入字节数。
    pub bytes: usize,
    /// 成功内联的图片数。
    pub images_inlined: usize,
    /// 未能内联、原样保留的图片数。
    pub images_kept: usize,
    /// 换成占位框的图片数。
    pub images_placeholder: usize,
}

impl ExportOutcome {
    /// 用实际写下的字节数补全计数。
    pub fn new(path: String, bytes: usize, counts: ImageCounts) -> Self {
        ExportOutcome {
            path,
            bytes,
            images_inlined: counts.inlined,
            images_kept: counts.kept,
            images_placeholder: counts.placeholder,
        }
    }
}

/// `src` 的形态（`design/0076` §2.1.4 的表）。
#[derive(Debug, PartialEq, Eq)]
enum SrcKind {
    /// 空串。
    Empty,
    /// 本地路径：`rmd-file:` / 相对 / 绝对 —— 交给 loader。
    Local,
    /// `https:` / `http:` / `//host` —— 占位框。
    Remote,
    /// `rmd-unsupported:` —— 占位框（阅读态也看不见它）。
    Unsupported,
    /// 其它 scheme（`ftp:` 之类）：没有处理规则，**原样保留**并计数。
    Other,
}

fn classify(src: &str) -> SrcKind {
    let s = src.trim();
    if s.is_empty() {
        return SrcKind::Empty;
    }
    // 协议相对 URL：`//host/a.png`
    if s.starts_with("//") {
        return SrcKind::Remote;
    }
    if let Some(colon) = s.find(':') {
        let scheme = &s[..colon];
        let valid = !scheme.is_empty()
            && scheme.as_bytes()[0].is_ascii_alphabetic()
            && scheme
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'-' | b'.'));
        if valid {
            return match scheme.to_ascii_lowercase().as_str() {
                "http" | "https" => SrcKind::Remote,
                "rmd-unsupported" => SrcKind::Unsupported,
                "rmd-file" => SrcKind::Local,
                _ => SrcKind::Other,
            };
        }
    }
    // 没有 scheme ⇒ 相对或绝对路径
    SrcKind::Local
}

fn is_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0c)
}

/// 找下一个 `<img`（大小写不敏感），且标签名之后必须是空白 / `>` / `/`。
fn find_img(b: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    while i + 4 <= b.len() {
        if b[i] == b'<' && b[i + 1].eq_ignore_ascii_case(&b'i') && b[i + 2].eq_ignore_ascii_case(&b'm')
            && b[i + 3].eq_ignore_ascii_case(&b'g')
        {
            match b.get(i + 4) {
                Some(&c) if is_ws(c) || c == b'>' || c == b'/' => return Some(i),
                None => return Some(i),
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// 一个 `<img …>` 标签在 HTML 字节里的位置与属性值区间。
struct ImgTag {
    /// `>` 之后的下标。
    end: usize,
    /// `src` 值的字节区间（不含引号）。
    src: Option<(usize, usize)>,
    /// `alt` 值的字节区间（不含引号）。
    alt: Option<(usize, usize)>,
}

/// 解析标签。返回 `None` = **畸形**（尖括号/引号没闭合）。
fn parse_img_tag(b: &[u8], start: usize) -> Option<ImgTag> {
    let mut j = start + 4;
    let mut quote: Option<u8> = None;
    while j < b.len() {
        let c = b[j];
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'"' | b'\'' => quote = Some(c),
                b'>' => break,
                // ⚠️ 引号外出现 `<` = 畸形：继续扫会把**后面某个** `>` 当成自己的结尾
                //    （`<img src="a.png"<p>后</p>` 会吞掉 `<p>` 并改写 `src`）。
                //    按"停止改写、原样保留"处理（本函数的返回 `None` 就表示这个）。
                b'<' => return None,
                _ => {}
            },
        }
        j += 1;
    }
    if j >= b.len() {
        // 到文件尾都没见到 `>`（或引号一直没闭合）⇒ 畸形
        return None;
    }
    let end = j + 1;

    let mut src = None;
    let mut alt = None;
    let mut k = start + 4;
    while k < j {
        while k < j && (is_ws(b[k]) || b[k] == b'/') {
            k += 1;
        }
        if k >= j {
            break;
        }
        let ns = k;
        while k < j && !is_ws(b[k]) && !matches!(b[k], b'=' | b'/' | b'>') {
            k += 1;
        }
        let ne = k;
        if ns == ne {
            k += 1;
            continue;
        }
        let mut eq = k;
        while eq < j && is_ws(b[eq]) {
            eq += 1;
        }
        let mut value = None;
        if eq < j && b[eq] == b'=' {
            let mut v = eq + 1;
            while v < j && is_ws(b[v]) {
                v += 1;
            }
            if v < j && (b[v] == b'"' || b[v] == b'\'') {
                let q = b[v];
                v += 1;
                let vs = v;
                while v < j && b[v] != q {
                    v += 1;
                }
                if v >= j {
                    return None;
                }
                value = Some((vs, v));
                k = v + 1;
            } else {
                let vs = v;
                while v < j && !is_ws(b[v]) && b[v] != b'>' {
                    v += 1;
                }
                // `<img src=a.png/>`：`/` 属于自闭合标记，不属于值
                let ve = if v > vs && b[v - 1] == b'/' { v - 1 } else { v };
                value = Some((vs, ve));
                k = v;
            }
        } else {
            k = eq;
        }
        let name = &b[ns..ne];
        if let Some(val) = value {
            if name.eq_ignore_ascii_case(b"src") {
                src = Some(val);
            } else if name.eq_ignore_ascii_case(b"alt") {
                alt = Some(val);
            }
        }
    }

    Some(ImgTag { end, src, alt })
}

/// 把正文里的 `<img>` 逐个处理成自足形态（`design/0076` §2.1.4）。
///
/// `load` 负责"这个 `src` 指向哪个本地文件、能不能读"——**路径解析与授权由调用方做**
/// （`commands/export.rs` 里是 `asset::resolve` ＋ `check_readable_asset` ＋ 读盘）。
/// 返回 `None` ⇒ 保留原标签并计入 `kept`。
///
/// ⚠️ **只碰 `<img>`**：其余字节一个不动。⚠️ 畸形标签 ⇒ **停止改写剩余部分**、
/// 原样输出并计入 `kept`；⛔ 不让整个导出失败。
pub fn inline_images(
    html: &str,
    load: impl Fn(&str) -> Option<InlineAsset>,
) -> (String, ImageCounts) {
    inline_images_with_budget(html, load, MAX_INLINE_IMAGE_BYTES, MAX_INLINE_TOTAL_BYTES)
}

/// [`inline_images`] 的本体，预算作为参数（单测用小预算，不必真造 32 MiB）。
fn inline_images_with_budget(
    html: &str,
    load: impl Fn(&str) -> Option<InlineAsset>,
    single_max: u64,
    total_max: u64,
) -> (String, ImageCounts) {
    let b = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut counts = ImageCounts::default();
    let mut total: u64 = 0;
    let mut i = 0usize;

    while i < b.len() {
        let Some(start) = find_img(b, i) else {
            out.push_str(&html[i..]);
            break;
        };
        out.push_str(&html[i..start]);

        let Some(tag) = parse_img_tag(b, start) else {
            // 畸形：停止改写，剩下的原样输出
            counts.kept += 1;
            out.push_str(&html[start..]);
            break;
        };
        let whole = &html[start..tag.end];
        i = tag.end;

        let Some((vs, ve)) = tag.src else {
            // 没有 src：原样，不计数
            out.push_str(whole);
            continue;
        };
        let src = &html[vs..ve];
        match classify(src) {
            SrcKind::Empty => out.push_str(whole),
            SrcKind::Remote | SrcKind::Unsupported => {
                counts.placeholder += 1;
                out.push_str("<span class=\"img-placeholder\">");
                if let Some((as_, ae)) = tag.alt {
                    // ⚠️ 原样搬（`design/0076` §2.1.4：alt 的**原文**，不再二次转义）
                    out.push_str(&html[as_..ae]);
                }
                out.push_str("</span>");
            }
            SrcKind::Other => {
                counts.kept += 1;
                out.push_str(whole);
            }
            SrcKind::Local => match load(src) {
                Some(asset)
                    if asset.bytes.len() as u64 <= single_max
                        && total + asset.bytes.len() as u64 <= total_max =>
                {
                    total += asset.bytes.len() as u64;
                    counts.inlined += 1;
                    out.push_str(&html[start..vs]);
                    out.push_str("data:");
                    out.push_str(&asset.mime);
                    out.push_str(";base64,");
                    out.push_str(&base64(&asset.bytes));
                    out.push_str(&html[ve..tag.end]);
                }
                _ => {
                    counts.kept += 1;
                    out.push_str(whole);
                }
            },
        }
    }

    (out, counts)
}

// ─────────────────────────────────────────────────────────────────────
// ⑤ base64（唯一实现；`commands/asset.rs` 复用它）
// ─────────────────────────────────────────────────────────────────────

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 标准 base64（带 `=` 填充）。
///
/// ⚠️ 手写而不是加一个 crate：本项目只需要 base64 这一处算法（`read_asset` 与导出共用），
/// 而它只有 20 行。⛔ 别在此基础上扩张（要 URL-safe 变体时该换库了）。
pub fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

// ─────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> InlineAsset {
        InlineAsset { bytes: b"abc".to_vec(), mime: "image/png".to_string() }
    }

    // —— 外观快照 ——

    #[test]
    fn 外观越界回落_合法值原样通过() {
        let fallback = Appearance {
            mode: "warm".into(),
            font_size: 15.0,
            line_height: 1.7,
            content_width: 900.0,
            vim_mode: false,
        };
        let ok = AppearanceIn {
            theme: Some("dark".into()),
            font_size: Some(18.0),
            line_height: Some(2.0),
            content_width: Some(760.0),
        };
        assert_eq!(
            ok.resolve(&fallback),
            ResolvedAppearance {
                theme: "dark",
                font_size: 18.0,
                line_height: 2.0,
                content_width: 760.0
            }
        );

        // 越界 / 未知 / 非有限 ⇒ 全部回落
        let bad = AppearanceIn {
            theme: Some("system".into()),
            font_size: Some(200.0),
            line_height: Some(f64::NAN),
            content_width: Some(1.0),
        };
        assert_eq!(
            bad.resolve(&fallback),
            ResolvedAppearance {
                theme: "warm",
                font_size: 15.0,
                line_height: 1.7,
                content_width: 900.0
            }
        );

        // 内容宽度 `0` 是**合法值**（铺满），不是越界
        let fill = AppearanceIn { content_width: Some(0.0), ..Default::default() };
        assert_eq!(fill.resolve(&fallback).content_width, 0.0);
    }

    #[test]
    fn 配置是系统主题时静态文件取浅色() {
        let fallback = Appearance { mode: "system".into(), ..Appearance::default() };
        assert_eq!(AppearanceIn::default().resolve(&fallback).theme, "light");
    }

    // —— 页面拼装 ——

    #[test]
    fn 页面模板自足_标题转义_外观进_style() {
        let fallback = Appearance::default();
        let app = AppearanceIn {
            theme: Some("dark".into()),
            font_size: Some(16.0),
            line_height: Some(1.8),
            content_width: Some(0.0),
        };
        let page = compose_page("a<b>&\"c", "<p>x</p>", &app, &fallback);
        assert!(page.starts_with("<!DOCTYPE html>"), "{page}");
        assert!(page.contains("lang=\"zh-CN\""), "{page}");
        assert!(page.contains("data-theme=\"dark\""), "{page}");
        assert!(
            page.contains(
                "style=\"--reader-font-size:16px;--reader-line-height:1.8;--reader-content-width:none\""
            ),
            "{page}"
        );
        assert!(page.contains("<title>a&lt;b&gt;&amp;&quot;c</title>"), "{page}");
        // 正文原样嵌入
        assert!(page.contains("<main id=\"doc\" class=\"doc\"><p>x</p></main>"), "{page}");
        // 自足：没有外链、没有脚本
        assert!(!page.contains("<link"), "{page}");
        assert!(!page.contains("<script"), "{page}");
        assert!(!page.contains("@import"), "{page}");
    }

    #[test]
    fn 样式包顺序与_index_一致且可安全内嵌() {
        let css = css_bundle();
        for name in [
            "tokens.css",
            "themes.css",
            "style.css",
            "typography.css",
            "highlight.css",
            "print.css",
        ] {
            assert!(css.contains(&format!("/* ===== {name} ===== */")), "缺 {name} 的分隔注释");
        }
        // 顺序
        let pos = |n: &str| css.find(&format!("/* ===== {n} =====")).unwrap();
        assert!(pos("tokens.css") < pos("themes.css"));
        assert!(pos("themes.css") < pos("style.css"));
        assert!(pos("style.css") < pos("typography.css"));
        assert!(pos("typography.css") < pos("highlight.css"));
        assert!(pos("highlight.css") < pos("print.css"));
        // ⭐ 安全：这六张表里不能有会提前结束 `<style>` 或拉外部资源的写法
        let lower = css.to_ascii_lowercase();
        assert!(!lower.contains("</style"), "样式表里出现了 </style");
        assert!(!lower.contains("@import"), "样式表里出现了 @import");
        assert!(!lower.contains("url("), "样式表里出现了 url(（产物将依赖外部资源）");
        // 打印样式确实带上了
        assert!(css.contains("@page {"), "print.css 没进包");
    }

    // —— 图片内联 ——

    #[test]
    fn 本地图片换成_data_uri() {
        let html = "<p><img src=\"a.png\" alt=\"图\"></p>";
        let (out, counts) = inline_images_with_budget(
            html,
            |src| {
                assert_eq!(src, "a.png");
                Some(png())
            },
            1024,
            4096,
        );
        assert_eq!(out, "<p><img src=\"data:image/png;base64,YWJj\" alt=\"图\"></p>");
        assert_eq!(counts, ImageCounts { inlined: 1, kept: 0, placeholder: 0 });
    }

    #[test]
    fn 大小写与引号形态都得能认() {
        let html = "<IMG SRC='x.jpg'/><img src=x2.jpg>";
        let (out, counts) = inline_images_with_budget(html, |_| Some(png()), 1024, 4096);
        assert_eq!(
            out,
            "<IMG SRC='data:image/png;base64,YWJj'/><img src=data:image/png;base64,YWJj>"
        );
        assert_eq!(counts.inlined, 2);
    }

    #[test]
    fn 远程与不支持_scheme_换占位框且_alt_原样() {
        let html = "<img src=\"https://x/a.png\" alt=\"A&amp;B\">\
<img src=\"//cdn/x.png\">\
<img src=\"rmd-unsupported:javascript\" alt=\"js\">";
        let (out, counts) = inline_images_with_budget(html, |_| panic!("不该读远程图片"), 1024, 4096);
        assert_eq!(
            out,
            "<span class=\"img-placeholder\">A&amp;B</span>\
<span class=\"img-placeholder\"></span>\
<span class=\"img-placeholder\">js</span>"
        );
        assert_eq!(counts, ImageCounts { inlined: 0, kept: 0, placeholder: 3 });
    }

    #[test]
    fn 没有_src_或空_src_原样且不计数() {
        let html = "<img alt=\"x\"><img src=\"\" alt=\"y\">";
        let (out, counts) = inline_images_with_budget(html, |_| panic!("不该读"), 1024, 4096);
        assert_eq!(out, html);
        assert_eq!(counts, ImageCounts::default());
    }

    #[test]
    fn 读失败与超预算保留原标签并计数() {
        let html = "<img src=\"miss.png\"><img src=\"big.png\">";
        let (out, counts) = inline_images_with_budget(
            html,
            |src| {
                if src == "big.png" {
                    Some(InlineAsset { bytes: vec![0u8; 10], mime: "image/png".into() })
                } else {
                    None
                }
            },
            8,
            4096,
        );
        assert_eq!(out, html, "两张都必须原样保留");
        assert_eq!(counts, ImageCounts { inlined: 0, kept: 2, placeholder: 0 });
    }

    #[test]
    fn 总量预算按原始字节累计() {
        // 单张 4 B，总量 6 B ⇒ 第一张进，第二张保留
        let html = "<img src=\"a.png\"><img src=\"b.png\">";
        let (out, counts) = inline_images_with_budget(
            html,
            |_| Some(InlineAsset { bytes: b"abcd".to_vec(), mime: "image/png".into() }),
            1024,
            6,
        );
        assert!(out.contains("data:image/png;base64,YWJjZA=="), "{out}");
        assert!(out.ends_with("<img src=\"b.png\">"), "{out}");
        assert_eq!(counts, ImageCounts { inlined: 1, kept: 1, placeholder: 0 });
    }

    #[test]
    fn 畸形标签停止改写且其余原样() {
        let html = "<p>前</p><img src=\"a.png\"<p>后</p>";
        let (out, counts) = inline_images_with_budget(html, |_| Some(png()), 1024, 4096);
        // 没有可闭合的 `>` ⇒ 从 `<img` 起到结尾原样输出
        assert_eq!(out, html);
        assert_eq!(counts, ImageCounts { inlined: 0, kept: 1, placeholder: 0 });
    }

    #[test]
    fn 未知_scheme_保留并计数() {
        let html = "<img src=\"ftp://x/a.png\">";
        let (out, counts) = inline_images_with_budget(html, |_| panic!("不该读"), 1024, 4096);
        assert_eq!(out, html);
        assert_eq!(counts, ImageCounts { inlined: 0, kept: 1, placeholder: 0 });
    }

    #[test]
    fn srcset_与其它属性一个字节不动() {
        let html = "<img srcset=\"a2.png 2x\" src=\"a.png\" class=\"pic\" data-x=\"y\">";
        let (out, _) = inline_images_with_budget(html, |_| Some(png()), 1024, 4096);
        assert!(out.contains("srcset=\"a2.png 2x\""), "{out}");
        assert!(out.contains("class=\"pic\""), "{out}");
        assert!(out.contains("data-x=\"y\""), "{out}");
        assert!(out.contains("src=\"data:image/png;base64,YWJj\""), "{out}");
    }

    // —— base64 ——

    #[test]
    fn base64_与已知值一致() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64("中".as_bytes()), "5Lit");
    }

    // —— 结果结构 ——

    #[test]
    fn 导出结果的序列化字段名就是前端契约() {
        let o = ExportOutcome::new(
            "/x/a.html".into(),
            3,
            ImageCounts { inlined: 1, kept: 2, placeholder: 3 },
        );
        let s = serde_json::to_string(&o).unwrap();
        for key in ["path", "bytes", "images_inlined", "images_kept", "images_placeholder"] {
            assert!(s.contains(&format!("\"{key}\"")), "缺 {key}：{s}");
        }
    }
}
