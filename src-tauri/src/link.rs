//! 文档内链接的**分类、编码与系统唤起**（`design/0026`）。
//!
//! # 为什么它不门控到 `--features gui`
//!
//! 这里装的是**安全判定**：导航闸门的入口白名单（[`is_app_entry`]）、
//! 链接分类（[`classify`]）、系统唤起的 argv 守卫（[`browser_argv`]）。
//! ⭐ 与 `fs` / `external` 同一条理由（`main.rs` 模块头）：**唯一那道防线必须在
//! `make test`（默认构建）里可断言**——只活在 gui 构建里的断言，等于没有。
//!
//! # 三条承重约定
//!
//! 1. ⚠️ **标记只是编码，⛔ 不是信任**（`INV-LINK-10`）：`rmd-file:` / `rmd-unsupported:`
//!    是**渲染前的受控改写**（[`rewrite_link_url`]），任何文档作者都能自己写出同样的串。
//!    ⇒ 它**照样**要过 `check_readable`（链接）或 `read_asset`（图片），与本仓任何其它
//!    路径**同权**。⛔ 别在这里或下游开"可信标记免检"的口子。
//! 2. ⚠️ **不解码两次**：URL 里的 `%XX` **只解一次**（`a%2520b` 只变成 `a%20b`）。
//!    [`percent_decode`] 对非法序列原样保留（它更可能是文件名里真有一个 `%`）。
//! 3. ⚠️ **⛔ 不引 `url` crate**（`design/0026` §2.3）：我们只要 RFC 3986 §3 的**语法切分**，
//!    不需要 IDNA / 规范化 / 相对解析；而且切分必须与入口白名单**共用一份**
//!    （两份解析 = 两份真值）。
//!
//! ⚠️ 本文件**不碰文件系统**：改写是**词法**的（`design/0026` §2.4 / 评审 `P2-3`），
//! 打开文档时⛔ 不为每条 `file:` 链接做一次存在性探测。

use std::ffi::OsString;
use std::path::Path;
use std::process::Command;

/// 受控标记：`file:` 被改写后的形态（`r` 开头不命中 comrak 的 `dangerous_url`）。
pub const MARKER_FILE: &str = "rmd-file:";
/// 受控标记：`data:` / `file:` / `javascript:` / `vbscript:` 里不能支持的那些。
pub const MARKER_UNSUPPORTED: &str = "rmd-unsupported:";

const HEX: &[u8; 16] = b"0123456789ABCDEF";

// ————————————————————————————————————————————————————————————————————————————
// RFC 3986 §3 的最小切分
// ————————————————————————————————————————————————————————————————————————————

/// 切分结果。⚠️ **纯词法**：只按 RFC 3986 §3 的定界符切，⛔ 不解析、⛔ 不规范化。
///
/// ⚠️ `fragment` / `query` 是**未解码**的原文；解码由调用方各做**一次**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Parts<'a> {
    /// 冒号前那段（`http` / `file` / `rmd-file`…）。**大小写未归一**。
    pub scheme: Option<&'a str>,
    /// `//` 之后到下一个 `/` 之前。⚠️ `Some("")` 是**合法的**（`file:///x`），
    /// 与 `None`（没有 `//`）不是一回事。
    pub authority: Option<&'a str>,
    /// 路径（`file:///x` ⇒ `/x`；没有 `//` 时就是冒号后的全部）。
    pub path: &'a str,
    pub query: Option<&'a str>,
    pub fragment: Option<&'a str>,
}

/// 找一个**合法**的 scheme 前缀（`ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"`）。
///
/// ⚠️ 首个冒号之前的字符非法（空白、`/`、`?`、`#`…）⇒ `None`（按相对路径处理）。
fn scheme_prefix(s: &str) -> Option<(&str, &str)> {
    let b = s.as_bytes();
    if b.is_empty() || !b[0].is_ascii_alphabetic() {
        return None;
    }
    for (i, &c) in b.iter().enumerate().skip(1) {
        match c {
            b':' => return Some((&s[..i], &s[i + 1..])),
            c if c.is_ascii_alphanumeric() || c == b'+' || c == b'-' || c == b'.' => {}
            _ => return None,
        }
    }
    None
}

/// 切成 scheme / authority / path / query / fragment（顺序：先 `#`、再 `?`、再 scheme、最后 `//`）。
pub fn split_url(s: &str) -> Parts<'_> {
    let (rest, fragment) = match s.find('#') {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let (rest, query) = match rest.find('?') {
        Some(i) => (&rest[..i], Some(&rest[i + 1..])),
        None => (rest, None),
    };
    let (scheme, rest) = match scheme_prefix(rest) {
        Some((sch, after)) => (Some(sch), after),
        None => (None, rest),
    };
    let (authority, path) = match rest.strip_prefix("//") {
        Some(after) => match after.find('/') {
            Some(i) => (Some(&after[..i]), &after[i..]),
            None => (Some(after), ""),
        },
        None => (None, rest),
    };
    Parts { scheme, authority, path, query, fragment }
}

// ————————————————————————————————————————————————————————————————————————————
// 百分号编码
// ————————————————————————————————————————————————————————————————————————————

/// `%XX` 解码一次。非法序列**原样保留**（不报错）——它更可能是文件名里
/// 真有一个 `%`，而不是谁写错了编码。
///
/// ⚠️ `design/0026` §2.3 起它住在这里（从 `commands/asset.rs` **迁入**，⛔ 不留第二份）；
/// `asset.rs` 只是转调。
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `%XX` 编码（unreserved ＋ `/` 原样）。⭐ 必须编 `%` `#` `?` 空格与非 ASCII
/// ——`escape_href` 会原样放行 `%XX`，而 `#` 若不编码会在**再切一次**时被误当 fragment。
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => {
                out.push('%');
                out.push(HEX[(b >> 4) as usize] as char);
                out.push(HEX[(b & 0x0f) as usize] as char);
            }
        }
    }
    out
}

/// **纯词法**归一：消掉 `.` / `..` / 重复斜杠。
///
/// ⚠️ ⛔ **不碰文件系统**（评审 `P2-3`）：`/a/../b` ⇒ `/b`（RFC 3986 §5.2.4 的形状），
/// 但**没有**任何一次 `canonicalize`。绝对路径的 `..` **不越过根**。
///
/// ⚠️ **⛔ 不削掉相对路径开头的 `..`**：`../../x` 保持原样——它仍然要过
/// `check_readable`，越权拿不到东西。
pub fn normalize_lexically(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => match out.last() {
                Some(&last) if last != ".." => {
                    out.pop();
                }
                _ => {
                    if !absolute {
                        out.push("..");
                    }
                }
            },
            other => out.push(other),
        }
    }
    let mut s = String::new();
    if absolute {
        s.push('/');
    }
    s.push_str(&out.join("/"));
    s
}

// ————————————————————————————————————————————————————————————————————————————
// 导航闸门（`INV-LINK-01`）
// ————————————————————————————————————————————————————————————————————————————

/// 这次导航是不是**应用自己的入口**。
///
/// `scheme == tauri` ∧ `authority == localhost` ∧ `path ∈ {"/", "/index.html"}`。
///
/// ⚠️⚠️ **⛔ 不许放宽成"同 scheme 任意路径"、⛔ 不许加静态资源后缀表**
/// （评审 `P1-2`）：Tauri 在 `tauri://` 下找不到的路径会**回退到 `index.html`**
/// ⇒ `tauri://localhost/nope.js` 是一条"放行即整页重载"的路，正是 `bugs/0001` 的根因②。
/// 而**子资源加载根本不经过导航策略** ⇒ 后缀表既无必要又有害。
///
/// ⚠️ 空 path 按 `/` 看待（`tauri://localhost` 与 `tauri://localhost/` 是同一个资源）。
pub fn is_app_entry(url: &str) -> bool {
    let p = split_url(url.trim());
    let Some(sch) = p.scheme else { return false };
    if !sch.eq_ignore_ascii_case("tauri") {
        return false;
    }
    match p.authority {
        Some(a) if a.eq_ignore_ascii_case("localhost") => {}
        _ => return false,
    }
    let path = if p.path.is_empty() { "/" } else { p.path };
    matches!(path, "/" | "/index.html")
}

// ————————————————————————————————————————————————————————————————————————————
// 渲染前改写（`INV-LINK-07`）
// ————————————————————————————————————————————————————————————————————————————

/// `file:` 的改写结果。⚠️ **只做词法**（⛔ 不 canonicalize）。
fn file_marker(p: &Parts<'_>) -> String {
    // authority：`Some("")` / `Some("localhost")` / `None` 都算本机；
    // ⛔ 非本机（`file://evil/share/x`）**在这里**就要判掉——一旦只写回路径，authority 就丢了。
    let local = match p.authority {
        Some(a) => a.is_empty() || a.eq_ignore_ascii_case("localhost"),
        None => true,
    };
    if !local || p.query.is_some() || !p.path.starts_with('/') {
        return format!("{MARKER_UNSUPPORTED}file");
    }
    let decoded = percent_decode(p.path);
    let norm = normalize_lexically(&decoded);
    let mut s = format!("{MARKER_FILE}{}", percent_encode(&norm));
    if let Some(f) = p.fragment {
        if !f.is_empty() {
            s.push('#');
            s.push_str(&percent_encode(&percent_decode(f)));
        }
    }
    s
}

/// 把一个 Markdown 链接/图片的 `url` 改写成受控标记（`design/0026` §2.4）。
///
/// 返回 `Some(新值)` 表示要写回 AST 节点；`None` 表示原样不动。
///
/// ⚠️ **四种 scheme 一起处理**（评审 `P1-1`）：`dangerous_url()` 对
/// `d/f/j/v` 是**同一套**处理，只救 `file:` 会让 `javascript:` 渲染成**没有 href**
/// ⇒ 前端拿到空串 ⇒ 用户看到的是"滚到文首"，而不是"不支持的链接类型"。
pub fn rewrite_link_url(raw: &str) -> Option<String> {
    let t = raw.trim();
    let p = split_url(t);
    let sch = p.scheme?;
    let scheme = sch.to_ascii_lowercase();
    match scheme.as_str() {
        "file" => Some(file_marker(&p)),
        "javascript" | "data" | "vbscript" => Some(format!("{MARKER_UNSUPPORTED}{scheme}")),
        _ => None,
    }
}

// ————————————————————————————————————————————————————————————————————————————
// 分类（`design/0026` §2.3）
// ————————————————————————————————————————————————————————————————————————————

/// `classify` 的结果。⚠️ 前端**只认这些 kind**（`src/services/links.js` 的 `plan`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Classified {
    /// 空 href。⭐ **与 `Anchor` 解耦**（评审 `P1-1`）：⛔ 不许滚文首。
    Empty,
    /// 同文档锚点（`#frag`）。**零副作用**。
    Anchor { fragment: String },
    /// `http` / `https`（含协议相对 `//host`）。交给系统浏览器。
    External { url: String },
    /// 我们自己编码的本地文件标记。⚠️ **不是"可信"标记**（`INV-LINK-10`）。
    LocalFile { path: String, fragment: Option<String> },
    /// 直接出现的相对 / 绝对路径。
    LocalPath { path: String, fragment: Option<String> },
    /// 本地链接带了 query（产品规则：V1 不支持）。
    LocalQuery,
    /// 不支持的协议（含 d/j/v 与一切未知 scheme）。
    Unsupported { scheme: String },
}

fn decode_opt_fragment(f: Option<&str>) -> Option<String> {
    f.map(percent_decode).filter(|s| !s.is_empty())
}

/// `http(s)` 的守卫：**没有控制字符/空白**、authority 非空、host 里没有可疑字符。
///
/// ⚠️ 它同时被 [`browser_argv`] 用——两处共用一个判定（⛔ 不写第二份）。
fn is_safe_external(url: &str) -> bool {
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let p = split_url(url);
    let Some(a) = p.authority else { return false };
    if a.is_empty() {
        return false;
    }
    !a.bytes().any(|b| matches!(b, b'"' | b'\'' | b'\\' | b'@' | b'<' | b'>'))
}

/// 把一个 href 分类。**纯函数**（默认构建里可断言）。
///
/// ⚠️ `percent_decode` **只解一次**；`file:` / `rmd-file:` 的 path 解一次后
/// 交给 `commands::link` 走 `check_readable`。
pub fn classify(href: &str) -> Classified {
    let t = href.trim();
    if t.is_empty() {
        return Classified::Empty;
    }
    if t.starts_with('#') {
        return Classified::Anchor { fragment: percent_decode(&t[1..]) };
    }
    if t.starts_with("//") {
        let url = format!("https:{t}");
        return if is_safe_external(&url) {
            Classified::External { url }
        } else {
            Classified::Unsupported { scheme: "https".to_string() }
        };
    }
    let p = split_url(t);
    let Some(sch) = p.scheme else {
        // 无 scheme：相对 / 绝对本地路径。⚠️ query 只对本地目标说不支持。
        if p.query.is_some() {
            return Classified::LocalQuery;
        }
        return Classified::LocalPath {
            path: percent_decode(p.path),
            fragment: decode_opt_fragment(p.fragment),
        };
    };
    let scheme = sch.to_ascii_lowercase();
    // ⚠️ 用 `==` 而不是把常量塞进 `match` 的模式位：`&str` 常量做模式虽然能编过，
    //    但"这是常量还是新字面量"一眼看不出来，而本文件的全部意义就是**一份**标记定义。
    if scheme == MARKER_FILE_SCHEME {
        if p.query.is_some() {
            return Classified::LocalQuery;
        }
        return Classified::LocalFile {
            path: percent_decode(p.path),
            fragment: decode_opt_fragment(p.fragment),
        };
    }
    if scheme == MARKER_UNSUPPORTED_SCHEME {
        return Classified::Unsupported {
            scheme: if p.path.is_empty() { "?".to_string() } else { p.path.to_ascii_lowercase() },
        };
    }
    match scheme.as_str() {
        "http" | "https" => {
            if is_safe_external(t) {
                Classified::External { url: t.to_string() }
            } else {
                Classified::Unsupported { scheme }
            }
        }
        // ⚠️ 直接出现的 `file:`：改名写之后**理论上不会再有**，但文档作者可以手写。
        //    照样按本地文件走（过 `check_readable`），⛔ 不信任、⛔ 不特殊放行。
        "file" => {
            let local = match p.authority {
                Some(a) => a.is_empty() || a.eq_ignore_ascii_case("localhost"),
                None => true,
            };
            if p.query.is_some() {
                return Classified::LocalQuery;
            }
            if !local || !p.path.starts_with('/') {
                return Classified::Unsupported { scheme };
            }
            Classified::LocalFile {
                path: percent_decode(p.path),
                fragment: decode_opt_fragment(p.fragment),
            }
        }
        _ => Classified::Unsupported { scheme },
    }
}

/// `rmd-file` 的 scheme 字面量（`MARKER_FILE` 去掉冒号）。
const MARKER_FILE_SCHEME: &str = "rmd-file";
/// `rmd-unsupported` 的 scheme 字面量（`MARKER_UNSUPPORTED` 去掉冒号）。
const MARKER_UNSUPPORTED_SCHEME: &str = "rmd-unsupported";

// ————————————————————————————————————————————————————————————————————————————
// 系统唤起（`INV-LINK-04`）
// ————————————————————————————————————————————————————————————————————————————

/// 「用系统默认浏览器打开」的**完整 argv**。
///
/// ⚠️ 与 `external.rs::editor_argv` 同一条硬约束：每个元素是**独立 argv**，
/// ⛔ 永不经过 shell。⛔ 不把任意 scheme 交给系统 `open`。
pub fn browser_argv(url: &str) -> Option<Vec<OsString>> {
    let t = url.trim();
    let p = split_url(t);
    let sch = p.scheme?;
    let scheme = sch.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    if !is_safe_external(t) {
        return None;
    }
    Some(vec![OsString::from("/usr/bin/open"), OsString::from(t)])
}

/// 「在 Finder 中显示」的**完整 argv**（`open -R`）。
///
/// ⚠️ 路径来自 `check_readable` 的返回值（**canonical 绝对路径**）⇒ 必以 `/` 开头，
/// 不会被 `open` 当成选项。
pub fn reveal_argv(path: &Path) -> Vec<OsString> {
    vec![
        OsString::from("/usr/bin/open"),
        OsString::from("-R"),
        path.as_os_str().to_os_string(),
    ]
}

/// 「在访达中显示 / 打开」的**完整 argv**（`design/0048`）。
///
/// | 条目 | argv | 效果 |
/// |---|---|---|
/// | 文件 | `open -R <path>` | 打开父目录并**选中**这一份 |
/// | 目录 | `open <path>` | 直接用访达**打开这个目录** |
///
/// ⚠️ **只接受绝对路径**（`check_readable` 的返回值就是 canonical 绝对路径）：
/// 相对路径会被 `open` 按**我们自己的 cwd** 解析——那既不是用户以为的那一份，
/// 也会让一个以 `-` 开头的相对路径被当成**选项**。⇒ 不绝对就返回 `None`，
/// 由调用方转成一条明确的拒绝（⛔ 不猜一个"大概是这个"的路径）。
///
/// ⚠️ 与 [`reveal_argv`] 同一条纪律：路径是**一个独立元素**，⛔ 不经 shell。
pub fn reveal_or_open_argv(real: &Path, is_dir: bool) -> Option<Vec<OsString>> {
    if !real.is_absolute() {
        return None;
    }
    let mut argv = vec![OsString::from("/usr/bin/open")];
    if !is_dir {
        argv.push(OsString::from("-R"));
    }
    argv.push(real.as_os_str().to_os_string());
    Some(argv)
}

/// 派发一条 argv（**不等待**）。
///
/// ⚠️ 生产路径用它；单测一律注入自己的记录器（⛔ 不真的弹窗）。
pub fn spawn_detached(argv: &[OsString]) -> std::io::Result<()> {
    let Some((head, rest)) = argv.split_first() else {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "空 argv"));
    };
    Command::new(head).args(rest).spawn().map(|_| ())
}

// ————————————————————————————————————————————————————————————————————————————
// 测试
// ————————————————————————————————————————————————————————————————————————————

#[cfg(test)]
mod tests {
    use super::*;

    // —— split_url ——

    #[test]
    fn 切分_普通网址() {
        let p = split_url("https://example.com/a/b?q=1#frag");
        assert_eq!(p.scheme, Some("https"));
        assert_eq!(p.authority, Some("example.com"));
        assert_eq!(p.path, "/a/b");
        assert_eq!(p.query, Some("q=1"));
        assert_eq!(p.fragment, Some("frag"));
    }

    #[test]
    fn 切分_三个斜杠的本机文件() {
        let p = split_url("file:///tmp/a.md");
        assert_eq!(p.scheme, Some("file"));
        assert_eq!(p.authority, Some(""));
        assert_eq!(p.path, "/tmp/a.md");
    }

    #[test]
    fn 切分_没有路径的权威段() {
        let p = split_url("file://localhost");
        assert_eq!(p.authority, Some("localhost"));
        assert_eq!(p.path, "");
    }

    #[test]
    fn 切分_相对路径不算工程名() {
        let p = split_url("notes/a.md");
        assert_eq!(p.scheme, None);
        assert_eq!(p.path, "notes/a.md");
    }

    #[test]
    fn 切分_中文冒号不算工程名() {
        // 「注意：」这种写法里没有合法的 scheme 前缀（冒号前含非 ASCII）
        let p = split_url("注意：../a.md");
        assert_eq!(p.scheme, None);
    }

    #[test]
    fn 切分_标记自身() {
        let p = split_url("rmd-file:/tmp/a%20b.md#x%23y");
        assert_eq!(p.scheme, Some("rmd-file"));
        assert_eq!(p.path, "/tmp/a%20b.md");
        assert_eq!(p.fragment, Some("x%23y"));
    }

    // —— percent ——

    #[test]
    fn 解码_只解一次() {
        assert_eq!(percent_decode("a%2520b"), "a%20b");
        assert_eq!(percent_decode("a%20b"), "a b");
    }

    #[test]
    fn 解码_非法序列原样保留() {
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zz"), "a%zz");
    }

    #[test]
    fn 编解码往返_中文空格井号问号() {
        for s in ["/tmp/中文 文件#1?.md", "/a/b", "/100%"] {
            assert_eq!(percent_decode(&percent_encode(s)), s, "往返失败：{s}");
        }
    }

    #[test]
    fn 编码_不编保留字符() {
        assert_eq!(percent_encode("/a-b_c.d~e"), "/a-b_c.d~e");
        assert_eq!(percent_encode("#?"), "%23%3F");
    }

    // —— normalize_lexically ——

    #[test]
    fn 归一_消点段与重复斜杠() {
        assert_eq!(normalize_lexically("/a//b/./c/../d"), "/a/b/d");
        assert_eq!(normalize_lexically("/"), "/");
        assert_eq!(normalize_lexically("/../etc"), "/etc");
    }

    #[test]
    fn 归一_相对路径开头的点点保留() {
        assert_eq!(normalize_lexically("../../x"), "../../x");
        assert_eq!(normalize_lexically("a/../../x"), "../x");
    }

    // —— classify 真值表 ——

    #[test]
    fn 分类_空与空白落进空态() {
        assert_eq!(classify(""), Classified::Empty);
        assert_eq!(classify("   "), Classified::Empty);
        assert_eq!(classify("\t"), Classified::Empty);
    }

    #[test]
    fn 分类_锚点() {
        assert_eq!(
            classify("#install"),
            Classified::Anchor { fragment: "install".to_string() }
        );
        assert_eq!(classify("#"), Classified::Anchor { fragment: String::new() });
        assert_eq!(
            classify("#a%20b"),
            Classified::Anchor { fragment: "a b".to_string() }
        );
    }

    #[test]
    fn 分类_http_https_与协议相对() {
        assert_eq!(
            classify("https://example.com/x"),
            Classified::External { url: "https://example.com/x".to_string() }
        );
        assert_eq!(
            classify("HTTP://example.com/x"),
            Classified::External { url: "HTTP://example.com/x".to_string() }
        );
        assert_eq!(
            classify("//example.com/x"),
            Classified::External { url: "https://example.com/x".to_string() }
        );
    }

    #[test]
    fn 分类_畸形外链判成不支持() {
        // 没有 host
        assert!(matches!(classify("https:///x"), Classified::Unsupported { .. }));
        // 塞了空白（open 的 argv 里不许有）
        assert!(matches!(
            classify("https://example.com/a b"),
            Classified::Unsupported { .. }
        ));
        // 控制字符
        assert!(matches!(
            classify("https://example.com/a\nb"),
            Classified::Unsupported { .. }
        ));
    }

    #[test]
    fn 分类_本地_rmd_file_标记() {
        assert_eq!(
            classify("rmd-file:/tmp/a%20b.md"),
            Classified::LocalFile { path: "/tmp/a b.md".to_string(), fragment: None }
        );
        assert_eq!(
            classify("rmd-file:/tmp/a.md#sec"),
            Classified::LocalFile {
                path: "/tmp/a.md".to_string(),
                fragment: Some("sec".to_string())
            }
        );
    }

    #[test]
    fn 分类_伪造的标记和普通路径同权() {
        // ⚠️ 这条钉的是"标记只是编码"：分类层照常接受它，
        //    授权判定在下游 `check_readable`——⛔ 分类层不许给它任何特权。
        assert_eq!(
            classify("rmd-file:/etc/passwd"),
            Classified::LocalFile { path: "/etc/passwd".to_string(), fragment: None }
        );
    }

    #[test]
    fn 分类_rmd_unsupported() {
        assert_eq!(
            classify("rmd-unsupported:javascript"),
            Classified::Unsupported { scheme: "javascript".to_string() }
        );
        assert_eq!(
            classify("rmd-unsupported:file"),
            Classified::Unsupported { scheme: "file".to_string() }
        );
    }

    #[test]
    fn 分类_直接出现的危险_scheme() {
        for (href, want) in [
            ("javascript:alert(1)", "javascript"),
            ("data:text/html;base64,AAAA", "data"),
            ("vbscript:msgbox(1)", "vbscript"),
            ("ftp://example.com/x", "ftp"),
        ] {
            assert_eq!(
                classify(href),
                Classified::Unsupported { scheme: want.to_string() },
                "{href}"
            );
        }
    }

    #[test]
    fn 分类_直接出现的_file_按本地走() {
        assert_eq!(
            classify("file:///tmp/a.md"),
            Classified::LocalFile { path: "/tmp/a.md".to_string(), fragment: None }
        );
        // 非本机 authority / 相对 / 带 query ⇒ 不支持
        assert!(matches!(
            classify("file://evil/share/a.md"),
            Classified::Unsupported { .. }
        ));
        assert!(matches!(classify("file:///tmp/a.md?x=1"), Classified::LocalQuery));
    }

    #[test]
    fn 分类_相对与绝对路径() {
        assert_eq!(
            classify("notes/a.md"),
            Classified::LocalPath { path: "notes/a.md".to_string(), fragment: None }
        );
        assert_eq!(
            classify("../assets/p.png#top"),
            Classified::LocalPath {
                path: "../assets/p.png".to_string(),
                fragment: Some("top".to_string())
            }
        );
        assert_eq!(
            classify("/Users/x/a%20b.md"),
            Classified::LocalPath { path: "/Users/x/a b.md".to_string(), fragment: None }
        );
    }

    #[test]
    fn 分类_本地带_query() {
        assert_eq!(classify("a.md?raw=1"), Classified::LocalQuery);
        assert_eq!(classify("../p.png?v=2"), Classified::LocalQuery);
    }

    #[test]
    fn 分类_前导空白被裁掉() {
        assert_eq!(
            classify("  https://example.com/x  "),
            Classified::External { url: "https://example.com/x".to_string() }
        );
        assert_eq!(
            classify("  #a"),
            Classified::Anchor { fragment: "a".to_string() }
        );
    }

    // —— is_app_entry 真值表（`INV-LINK-01`）——

    #[test]
    fn 闸门_只放行精确入口() {
        assert!(is_app_entry("tauri://localhost/index.html"));
        assert!(is_app_entry("tauri://localhost/"));
        assert!(is_app_entry("tauri://localhost"));
        assert!(is_app_entry("tauri://localhost/index.html?x=1#frag"));
        assert!(is_app_entry("TAURI://LOCALHOST/index.html"));
    }

    #[test]
    fn 闸门_其余一律不放行() {
        for url in [
            // ⭐ 评审 P1-2 点名的两格
            "tauri://localhost/nope.js",
            "tauri://evil/index.html",
            // 子资源也别想混进来（导航策略本不该收到它们）
            "tauri://localhost/style.css",
            "tauri://localhost/services/main.js",
            "https://example.com/",
            "http://localhost/index.html",
            "file:///tmp/index.html",
            "about:blank",
            "javascript:alert(1)",
            "",
            "notes/a.md",
        ] {
            assert!(!is_app_entry(url), "不该放行：{url}");
        }
    }

    // —— rewrite_link_url ——

    #[test]
    fn 改写_file_绝对路径() {
        assert_eq!(
            rewrite_link_url("file:///tmp/a b.md").as_deref(),
            Some("rmd-file:/tmp/a%20b.md")
        );
        assert_eq!(
            rewrite_link_url("FILE://localhost/tmp/中文.md").as_deref(),
            Some("rmd-file:/tmp/%E4%B8%AD%E6%96%87.md")
        );
        // ⚠️ 单斜杠写法（现实里存在）同样接
        assert_eq!(
            rewrite_link_url("file:/tmp/a.md").as_deref(),
            Some("rmd-file:/tmp/a.md")
        );
    }

    #[test]
    fn 改写_file_带锚点和点段() {
        assert_eq!(
            rewrite_link_url("file:///tmp/dir/../a.md#sec%201").as_deref(),
            Some("rmd-file:/tmp/a.md#sec%201")
        );
    }

    #[test]
    fn 改写_file_的三种拒绝() {
        // 非本机 authority、带 query、相对路径 ⇒ 改成 unsupported（⛔ 悄悄当成本地）
        assert_eq!(
            rewrite_link_url("file://evil/share/a.md").as_deref(),
            Some("rmd-unsupported:file")
        );
        assert_eq!(
            rewrite_link_url("file:///tmp/a.md?x=1").as_deref(),
            Some("rmd-unsupported:file")
        );
        assert_eq!(
            rewrite_link_url("file:relative.md").as_deref(),
            Some("rmd-unsupported:file")
        );
    }

    #[test]
    fn 改写_另外三种危险_scheme() {
        assert_eq!(
            rewrite_link_url("javascript:alert(1)").as_deref(),
            Some("rmd-unsupported:javascript")
        );
        assert_eq!(
            rewrite_link_url("  JavaScript:alert(1)").as_deref(),
            Some("rmd-unsupported:javascript")
        );
        assert_eq!(
            rewrite_link_url("data:text/html,x").as_deref(),
            Some("rmd-unsupported:data")
        );
        assert_eq!(
            rewrite_link_url("vbscript:x").as_deref(),
            Some("rmd-unsupported:vbscript")
        );
    }

    #[test]
    fn 改写_其余一律不动() {
        for url in [
            "https://example.com/x",
            "#frag",
            "notes/a.md",
            "/tmp/a.md",
            "mailto:a@b",
            "",
        ] {
            assert_eq!(rewrite_link_url(url), None, "不该改写：{url}");
        }
    }

    // —— browser_argv / reveal_argv ——

    #[test]
    fn argv_只认_http_https() {
        let a = browser_argv("https://example.com/x?q=1#f").expect("应当放行");
        assert_eq!(a, vec![OsString::from("/usr/bin/open"), OsString::from("https://example.com/x?q=1#f")]);
        assert!(browser_argv("http://example.com/").is_some());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@b",
            "//example.com/x",
            "https://",
            "https://example.com/a b",
            "notes/a.md",
        ] {
            assert!(browser_argv(bad).is_none(), "不该放行：{bad}");
        }
    }

    #[test]
    fn argv_路径是一个独立元素() {
        let p = Path::new("/tmp/a b'c.md");
        let a = reveal_argv(p);
        assert_eq!(a.len(), 3);
        assert_eq!(a[0], OsString::from("/usr/bin/open"));
        assert_eq!(a[1], OsString::from("-R"));
        assert_eq!(a[2], p.as_os_str().to_os_string());
    }

    #[test]
    fn argv_空数组有明确错误() {
        let e = spawn_detached(&[]).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput);
    }

    // —— reveal_or_open_argv（`design/0048`）——

    #[test]
    fn 在访达中显示_文件加选中_目录直接打开() {
        let p = Path::new("/tmp/dir/a b.md");
        let f = reveal_or_open_argv(p, false).expect("绝对路径应当放行");
        assert_eq!(f.len(), 3);
        assert_eq!(f[0], OsString::from("/usr/bin/open"));
        assert_eq!(f[1], OsString::from("-R"));
        assert_eq!(f[2], p.as_os_str().to_os_string());

        let d = reveal_or_open_argv(Path::new("/tmp/dir"), true).expect("绝对路径应当放行");
        assert_eq!(d.len(), 2, "目录不加 -R：要的是「打开」而不是「选中」");
        assert_eq!(d[0], OsString::from("/usr/bin/open"));
        assert_eq!(d[1], OsString::from("/tmp/dir"));
    }

    #[test]
    fn 在访达中显示_相对路径一律拒绝() {
        // ⚠️ 相对路径会被 `open` 按**我们的 cwd** 解析，而且 `-x` 会被当成选项
        for bad in ["a.md", "-R", "./a.md", "../a.md", ""] {
            assert!(reveal_or_open_argv(Path::new(bad), false).is_none(), "不该放行：{bad}");
            assert!(reveal_or_open_argv(Path::new(bad), true).is_none(), "不该放行：{bad}");
        }
    }
}
