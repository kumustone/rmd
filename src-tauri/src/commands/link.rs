//! 文档内链接的**判定与派发**（`design/0026` §2.5–§2.7）。
//!
//! # 这里的职责边界（`INV-LINK-03`）
//!
//! | 谁 | 干什么 | ⛔ 不干什么 |
//! |---|---|---|
//! | 前端 `links.js` | 归一 `href`、把**结果**映射成界面动作 | 判授权、拼绝对路径、自报基准目录 |
//! | **本文件** | 分类 → 过 `check_readable` → 决定派发什么 argv | 自己实现授权（那是第二条真值） |
//! | `link.rs` | 纯函数：分类 / 编码 / argv 构造 / 导航白名单 | 碰文件系统、碰 Tauri |
//!
//! ⚠️ **一次点击只发一条命令**：`open_link(href, doc_seq)`。前端**拿不到** `doc_dir`，
//! 也就不可能自己 join 出一个路径再让我们读——那正是 `design/0026` §2.9 里
//! 「前端判断一切」被否掉的理由。
//!
//! # 为什么要注入 `spawn`
//!
//! 派发 `/usr/bin/open` 会**真的弹出浏览器 / Finder**。单测必须能断言"派发了什么"、
//! 而且**一个字节都不许真的派发**（用户机器的前台不许被打扰）。
//! ⇒ 与 `design/0022` 的 `detach_self_with` 同款手法：生产路径传
//! [`crate::link::spawn_detached`]，单测传一个只记录 argv 的闭包。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::{AppState, Session};
use crate::error::Denied;
use crate::fs::grants::SessionGrants;
use crate::link::Classified;

/// 结果种类。⚠️ 前端 `services/links.js::plan` **穷举**这些值——加一种就要同批加它。
///
/// ⚠️ `document` / `reveal` / `external` 是**已经派发成功**的三种；
/// 带 `_failed` 后缀的是"决定要做，但系统调用失败了"，`message` 里有底层文本。
pub const KIND_EMPTY: &str = "empty";
/// 同文档锚点。
pub const KIND_ANCHOR: &str = "anchor";
/// 授权内的 Markdown ⇒ 交给既有 `openDocument`（`INV-LINK-06`）。
pub const KIND_DOCUMENT: &str = "document";
/// 授权内但不是 Markdown ⇒ Finder 里显示。
pub const KIND_REVEAL: &str = "reveal";
/// 已交给系统浏览器。
pub const KIND_EXTERNAL: &str = "external";
/// `open -R` 没起来。
pub const KIND_REVEAL_FAILED: &str = "reveal_failed";
/// `/usr/bin/open <url>` 没起来。
pub const KIND_EXTERNAL_FAILED: &str = "external_failed";
/// 未授权。⚠️ **与"授权外的不存在"同一个答复**（`INV-LINK-05`）。
pub const KIND_UNAUTHORIZED: &str = "unauthorized";
/// 授权内、确实不存在或不可达。
pub const KIND_MISSING: &str = "missing";
/// 协议不在白名单（含 `javascript:` / `data:` / `vbscript:` / 未知 scheme）。
pub const KIND_UNSUPPORTED: &str = "unsupported";
/// 本地目标带 query（V1 不支持）。
pub const KIND_LOCAL_QUERY: &str = "local_query";
/// 还没有已提交的文档 ⇒ 没有解析基准。
pub const KIND_NO_DOCUMENT: &str = "no_document";
/// 回包陈旧（`INV-LINK-11`）：本次**什么都不做**，前端只留一行提示。
pub const KIND_STALE: &str = "stale";
/// 其它失败。
pub const KIND_FAILED: &str = "failed";

/// `open_link` 的返回值（`design/0026` §2.7）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LinkOutcome {
    /// 见上面那组 `KIND_*`。
    pub kind: &'static str,
    /// 给用户看的**目标**：本地目标是解码后的可读路径，外链是完整 URL。
    ///
    /// ⚠️ 刻意**不是**渲染层那个 `href` 原文：`rmd-file:%2Ftmp%2Fa%20b.md` 直接显示给用户
    /// 是噪音，而它解码后的样子正是用户需要判断"要不要授权"的那个路径。
    pub href: String,
    /// `document` / `reveal` 的**规范化真实路径**（`check_readable` 的返回值）。
    /// ⚠️ 前端拿它去 `openDocument` / `revealInTree`，⛔ 不自己拼。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 锚点（已解码一次）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fragment: Option<String>,
    /// `unsupported` 时是 scheme；`*_failed` 时是底层错误文本。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl LinkOutcome {
    fn of(kind: &'static str, href: impl Into<String>) -> Self {
        Self { kind, href: href.into(), path: None, fragment: None, message: None }
    }

    fn with_path(mut self, p: &Path) -> Self {
        self.path = Some(p.display().to_string());
        self
    }

    fn with_fragment(mut self, f: Option<String>) -> Self {
        self.fragment = f;
        self
    }

    fn with_message(mut self, m: impl Into<String>) -> Self {
        self.message = Some(m.into());
        self
    }
}

/// **判定 ＋ 派发**（`design/0026` §2.3–§2.7）。`spawn` 是注入的（见文件头）。
///
/// ⚠️ 调用方必须**持着会话锁**调它：`doc_seq` 的核对与 `doc_dir` 的读取要在**同一把锁**里
/// （`INV-LINK-11`）——分开做就会出现"核对时还是 A 文档、读基准时已经换成 B"的窗口。
pub fn decide_and_execute(
    session: &mut Session,
    href: &str,
    doc_seq: u64,
    spawn: &mut dyn FnMut(&[OsString]) -> std::io::Result<()>,
) -> LinkOutcome {
    // `INV-LINK-11`：迟到的回包⛔ 不许把用户刚打开的文档顶掉。判据是**身份**，⛔ 不是时间。
    if session.doc_seq != doc_seq {
        return LinkOutcome::of(KIND_STALE, href);
    }

    match crate::link::classify(href) {
        // ⚠️ 空 href 与 `#` 是**两件事**（评审 `P1-1`）：空的不许滚文首。
        Classified::Empty => LinkOutcome::of(KIND_EMPTY, ""),
        Classified::Anchor { fragment } => {
            LinkOutcome::of(KIND_ANCHOR, href).with_fragment(Some(fragment))
        }
        Classified::Unsupported { scheme } => LinkOutcome::of(KIND_UNSUPPORTED, href)
            .with_message(scheme),
        Classified::LocalQuery => LinkOutcome::of(KIND_LOCAL_QUERY, href),
        Classified::External { url } => {
            // ⚠️ `classify` 已经保证它是安全的 http(s)；这里再守一次是**纵深防御**，
            //    因为 `browser_argv` 是唯一真的把字符串交给系统 `open` 的地方。
            let Some(argv) = crate::link::browser_argv(&url) else {
                return LinkOutcome::of(KIND_UNSUPPORTED, &url).with_message("http(s)");
            };
            match spawn(&argv) {
                Ok(()) => LinkOutcome::of(KIND_EXTERNAL, url),
                Err(e) => {
                    LinkOutcome::of(KIND_EXTERNAL_FAILED, url).with_message(e.to_string())
                }
            }
        }
        Classified::LocalFile { path, fragment } | Classified::LocalPath { path, fragment } => {
            let Some(doc_dir) = session.doc_dir.clone() else {
                return LinkOutcome::of(KIND_NO_DOCUMENT, path);
            };
            // ⚠️ 相对路径**相对当前文档所在目录**（与 `asset.rs::resolve` 同一口径），
            //    ⛔ 不相对进程 cwd、⛔ 不相对某个 root。
            let requested = if Path::new(&path).is_absolute() {
                PathBuf::from(&path)
            } else {
                doc_dir.join(&path)
            };
            resolve_local(session, &requested, fragment, path, spawn)
        }
    }
}

/// 本地目标：**授权只由 `check_readable` 决定**（`INV-LINK-03`），本函数只决定"怎么告诉用户"。
fn resolve_local(
    session: &Session,
    requested: &Path,
    fragment: Option<String>,
    display: String,
    spawn: &mut dyn FnMut(&[OsString]) -> std::io::Result<()>,
) -> LinkOutcome {
    match session.grants.check_readable(requested) {
        Ok(real) => {
            // ⚠️ `metadata` 只调一次，且**只在 `Ok(real)` 之后**——这时路径已经规范化过，
            //    没有"探测存在性"的语义负担（`design/0026` §2.5 末条）。
            let is_file = std::fs::metadata(&real).map(|m| m.is_file()).unwrap_or(false);
            if is_file && is_markdown(&real) {
                // `INV-LINK-06`：换文档**只走**既有 `openDocument`（脏缓冲保护、阅读进度、
                // 目录会话全部复用）⇒ 这里只回一个路径，⛔ 不在这里读文件。
                LinkOutcome::of(KIND_DOCUMENT, display).with_path(&real).with_fragment(fragment)
            } else {
                let argv = crate::link::reveal_argv(&real);
                match spawn(&argv) {
                    Ok(()) => LinkOutcome::of(KIND_REVEAL, display).with_path(&real),
                    Err(e) => LinkOutcome::of(KIND_REVEAL_FAILED, display)
                        .with_path(&real)
                        .with_message(e.to_string()),
                }
            }
        }
        Err(Denied::NotFound { .. }) => {
            // ⭐ `INV-LINK-05`：**只有**"最近存在祖先仍在授权内"时才敢说"不存在"。
            //    软链逃逸（`root/link → /etc`）下 `root/link/nope` 的最近存在祖先是
            //    `root/link`，规范化成 `/etc` ⇒ 不在 root 下 ⇒ 与纯越权同一个答复。
            if existence_speakable(&session.grants, requested) {
                LinkOutcome::of(KIND_MISSING, display)
            } else {
                LinkOutcome::of(KIND_UNAUTHORIZED, display)
            }
        }
        // ⚠️ `NotAuthorized` 与**其它一切**（含 `Stale` / `Io`）都按未授权答：
        //    差别化文案会把一次越权尝试变成一次目录探测（`design/0003` §2.1.2 注意点 2）。
        Err(_) => LinkOutcome::of(KIND_UNAUTHORIZED, display),
    }
}

/// 目标是不是 Markdown（决定"同窗口打开"还是"Finder 里显示"）。
fn is_markdown(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

/// 「授权内、确实不存在」这件事**说不说得出口**（`INV-LINK-05`）。
///
/// 算法：从请求路径往上找**最近的已存在祖先**，`canonicalize` 它，再用
/// [`SessionGrants::is_inside_roots`]（`Path::starts_with`，**按分量**）判。
///
/// ⚠️ 它**只为不泄露而存在**，⛔ **不是第二条授权路径**——放行仍然只由 `check_readable` 决定。
/// ⚠️ 纯词法前缀（`rootfoo` 陷阱、软链逃逸）在这里都判不对，所以必须规范化。
fn existence_speakable(grants: &SessionGrants, requested: &Path) -> bool {
    let mut cur = requested;
    loop {
        if let Ok(real) = std::fs::canonicalize(cur) {
            return grants.is_inside_roots(&real);
        }
        match cur.parent() {
            Some(p) if p != cur => cur = p,
            // 一直走到根还是不存在 ⇒ 什么都证明不了 ⇒ 按"不能说"处理。
            _ => return false,
        }
    }
}

/// **唯一**打开文档内链接的入口（`design/0026` §2.2）。
///
/// ⚠️ 前端每次点击只发**这一条**命令，带 `href` ＋ `doc_seq`。
/// ⚠️ 它**不写盘、不新增授权**：`unauthorized` 之后要不要授权是**用户**在决策条上点出来的
/// （走既有 `choose_file` / `choose_directory`）。
#[tauri::command]
pub fn open_link(
    state: tauri::State<'_, AppState>,
    href: String,
    doc_seq: u64,
) -> LinkOutcome {
    let mut spawn: fn(&[OsString]) -> std::io::Result<()> = crate::link::spawn_detached;
    let out = state.with(|s| decide_and_execute(s, &href, doc_seq, &mut spawn));

    // ⚠️ `INV-LOG-01`：**⛔ 不落 href 原文**（外链可能带 query token），只落种类与长度。
    //    底层错误文本按既有分流留在 stderr，文件侧只记长度。
    diag!("▶ open_link kind={} href_len={}", out.kind, href.chars().count());
    if let Some(m) = &out.message {
        diag_stderr!("▶ open_link kind={} message={}", out.kind, m);
        diag_file!("▶ open_link kind={} msg_len={}", out.kind, m.len());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::Session;
    use crate::config::Config;
    use crate::fs::tree::TreeCache;
    use crate::link::MARKER_FILE;
    use std::collections::VecDeque;

    /// 记录派发了什么、⛔ **一个字节都不真的派发**。
    #[derive(Default)]
    struct Recorder {
        calls: Vec<Vec<String>>,
        fail: Option<String>,
    }

    impl Recorder {
        fn spawner(&mut self) -> impl FnMut(&[OsString]) -> std::io::Result<()> + '_ {
            move |argv| {
                self.calls.push(argv.iter().map(|a| a.to_string_lossy().into_owned()).collect());
                match &self.fail {
                    Some(m) => Err(std::io::Error::other(m.clone())),
                    None => Ok(()),
                }
            }
        }
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rmd-link-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn session() -> Session {
        Session {
            grants: SessionGrants::new(),
            tree: TreeCache::new(),
            config: Config::default(),
            config_path: std::env::temp_dir().join("rmd-link-unused.json"),
            doc_dir: None,
            startup_document: None,
            pending_opens: VecDeque::new(),
            last_render_stats: Default::default(),
            current_document: None,
            doc_seq: 0,
            edit_target: None,
            self_write: None,
            save_inflight: None,
            baseline_bytes: None,
            watch: None,
            watch_seq: 0,
            latest_doc_req: 0,
            index: None,
            // ⚠️ 目录监视（`design/0034`）与链接导航无关，测试里恒为 None。
            tree_watch: None,
        }
    }

    /// 造一个"已授权 `dir`、正在看 `dir/doc.md`"的会话。
    fn session_in(dir: &Path) -> Session {
        let mut s = session();
        std::fs::write(dir.join("doc.md"), "# t\n").unwrap();
        let root = s.grants.authorize_root(dir).expect("授权临时目录");
        s.doc_dir = Some(root.clone());
        s.current_document = Some(root.join("doc.md"));
        s.doc_seq = 7;
        s
    }

    fn run(s: &mut Session, href: &str, seq: u64) -> (LinkOutcome, Vec<Vec<String>>) {
        let mut rec = Recorder::default();
        let out = {
            let mut sp = rec.spawner();
            decide_and_execute(s, href, seq, &mut sp)
        };
        (out, rec.calls)
    }

    fn run_failing(s: &mut Session, href: &str, seq: u64, why: &str) -> LinkOutcome {
        let mut rec = Recorder { calls: Vec::new(), fail: Some(why.to_string()) };
        let mut sp = rec.spawner();
        decide_and_execute(s, href, seq, &mut sp)
    }

    // —— 身份闸 ——

    #[test]
    fn 陈旧的请求什么都不做() {
        let dir = tmp_dir("stale");
        let mut s = session_in(&dir);
        let (out, calls) = run(&mut s, "https://example.com/x", 6);
        assert_eq!(out.kind, KIND_STALE);
        assert!(calls.is_empty(), "陈旧请求⛔ 不许派发任何东西");
    }

    #[test]
    fn 没有文档时本地链接回_no_document() {
        let mut s = session();
        s.doc_seq = 0;
        let (out, calls) = run(&mut s, "a.md", 0);
        assert_eq!(out.kind, KIND_NO_DOCUMENT);
        assert!(calls.is_empty());
    }

    // —— 纯分类的三态（空 / 锚点 / 不支持）——

    #[test]
    fn 空_href_与锚点是两件事() {
        let mut s = session();
        let (out, _) = run(&mut s, "", 0);
        assert_eq!(out.kind, KIND_EMPTY, "空 href ⛔ 不许被当成锚点滚文首");
        assert_eq!(out.fragment, None);

        let (out, _) = run(&mut s, "#sec-1", 0);
        assert_eq!(out.kind, KIND_ANCHOR);
        assert_eq!(out.fragment.as_deref(), Some("sec-1"));
        assert!(out.path.is_none());
    }

    #[test]
    fn 锚点只解码一次() {
        let mut s = session();
        let (out, _) = run(&mut s, "#a%20b", 0);
        assert_eq!(out.fragment.as_deref(), Some("a b"));
        let (out, _) = run(&mut s, "#a%2520b", 0);
        assert_eq!(out.fragment.as_deref(), Some("a%20b"), "⛔ 不做二次解码");
    }

    #[test]
    fn 不支持的协议不派发() {
        let mut s = session();
        for href in [
            "javascript:alert(1)",
            "data:text/html,<script>x</script>",
            "vbscript:msgbox(1)",
            "rmd-unsupported:javascript",
            "ssh://host/x",
        ] {
            let (out, calls) = run(&mut s, href, 0);
            assert_eq!(out.kind, KIND_UNSUPPORTED, "{href}");
            assert!(calls.is_empty(), "{href} ⛔ 不许派发");
        }
    }

    #[test]
    fn 本地_query_链接明确拒绝() {
        let mut s = session();
        let (out, calls) = run(&mut s, "other.md?raw=1", 0);
        assert_eq!(out.kind, KIND_LOCAL_QUERY);
        assert!(calls.is_empty());
    }

    // —— 外部链接（`INV-LINK-04`）——

    #[test]
    fn 外部链接派发一次_open_且_argv_是独立元素() {
        let mut s = session();
        let (out, calls) = run(&mut s, "https://example.com/a?b=1", 0);
        assert_eq!(out.kind, KIND_EXTERNAL);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0], vec!["/usr/bin/open", "https://example.com/a?b=1"]);
    }

    #[test]
    fn 协议相对链接按_https_派发() {
        let mut s = session();
        let (out, calls) = run(&mut s, "//example.com/x", 0);
        assert_eq!(out.kind, KIND_EXTERNAL);
        assert_eq!(calls[0][1], "https://example.com/x");
    }

    #[test]
    fn 浏览器唤起失败变成_external_failed_而不是静默() {
        let dir = tmp_dir("extfail");
        let mut s = session_in(&dir);
        let out = run_failing(&mut s, "https://example.com/x", 7, "找不到浏览器");
        assert_eq!(out.kind, KIND_EXTERNAL_FAILED);
        assert_eq!(out.message.as_deref(), Some("找不到浏览器"));
    }

    // —— 本地目标：授权 / 不存在 / 不泄露 ——

    #[test]
    fn 授权内的_markdown_回_document_且带规范化路径() {
        let dir = tmp_dir("md");
        std::fs::write(dir.join("other.md"), "# o\n").unwrap();
        let mut s = session_in(&dir);
        let (out, calls) = run(&mut s, "other.md", 7);
        assert_eq!(out.kind, KIND_DOCUMENT);
        assert!(calls.is_empty(), "换文档不经过系统 open");
        let real = std::fs::canonicalize(dir.join("other.md")).unwrap();
        assert_eq!(out.path.as_deref(), Some(real.display().to_string().as_str()));
    }

    #[test]
    fn 标记里的_绝对路径解回可读路径并带上锚点() {
        let dir = tmp_dir("marker");
        std::fs::write(dir.join("a b.md"), "# x\n").unwrap();
        let real = std::fs::canonicalize(dir.join("a b.md")).unwrap();
        // 渲染层改写出来的形状：`rmd-file:<pct(path)>#<pct(fragment)>`
        let href = format!(
            "{}{}#sec%201",
            MARKER_FILE,
            crate::link::percent_encode(&real.display().to_string())
        );
        let mut s = session_in(&dir);
        let (out, _) = run(&mut s, &href, 7);
        assert_eq!(out.kind, KIND_DOCUMENT, "{href}");
        assert_eq!(out.path.as_deref(), Some(real.display().to_string().as_str()));
        assert_eq!(out.fragment.as_deref(), Some("sec 1"));
        assert!(!out.href.starts_with(MARKER_FILE), "给用户看的是解码后的路径");
    }

    #[test]
    fn 伪造的标记只按普通路径处理() {
        let dir = tmp_dir("forge");
        let mut s = session_in(&dir);
        // 作者手写一个"看起来像外链"的标记 ⇒ 它只是**编码**（`INV-LINK-10`）：
        // 载荷不是绝对路径 ⇒ 按**相对当前文档目录**解析，落在授权内、且不存在。
        let (out, calls) = run(&mut s, "rmd-file:https://example.com/x", 7);
        assert_eq!(out.kind, KIND_MISSING, "⛔ 不许被当成外链");
        assert!(calls.is_empty(), "⛔ 一个字节都不许交给系统 open");
        assert!(out.path.is_none());

        // 载荷是绝对路径 ⇒ 与手写绝对路径同权：照旧过授权校验
        let (out, calls) = run(&mut s, "rmd-file:/etc/passwd", 7);
        assert_eq!(out.kind, KIND_UNAUTHORIZED);
        assert!(calls.is_empty());
    }

    #[test]
    fn 授权内的非_markdown_在_Finder_里显示() {
        let dir = tmp_dir("reveal");
        std::fs::write(dir.join("a.png"), b"x").unwrap();
        let mut s = session_in(&dir);
        let (out, calls) = run(&mut s, "a.png", 7);
        assert_eq!(out.kind, KIND_REVEAL);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0][0], "/usr/bin/open");
        assert_eq!(calls[0][1], "-R");
        assert!(calls[0][2].ends_with("a.png"));
    }

    #[test]
    fn finder_唤起失败变成_reveal_failed() {
        let dir = tmp_dir("revealfail");
        std::fs::write(dir.join("a.png"), b"x").unwrap();
        let mut s = session_in(&dir);
        let out = run_failing(&mut s, "a.png", 7, "no finder");
        assert_eq!(out.kind, KIND_REVEAL_FAILED);
        assert_eq!(out.message.as_deref(), Some("no finder"));
    }

    #[test]
    fn 授权内确实不存在才说_missing() {
        let dir = tmp_dir("missing");
        let mut s = session_in(&dir);
        let (out, calls) = run(&mut s, "nope.md", 7);
        assert_eq!(out.kind, KIND_MISSING);
        assert!(calls.is_empty());
    }

    #[test]
    fn 授权外的存在与不存在给同一个答复() {
        let dir = tmp_dir("unauthz");
        let mut s = session_in(&dir);
        // 存在（`/etc/passwd` 一定在）与不存在（`/etc/rmd-no-such-file-xyz`）**必须同答复**
        let (a, _) = run(&mut s, "/etc/passwd", 7);
        let (b, _) = run(&mut s, "/etc/rmd-no-such-file-xyz", 7);
        assert_eq!(a.kind, KIND_UNAUTHORIZED);
        assert_eq!(b.kind, KIND_UNAUTHORIZED, "⛔ 别把点击变成存在性探针");
    }

    #[test]
    fn 相对路径越出授权根也是未授权() {
        let dir = tmp_dir("dotdot");
        let mut s = session_in(&dir);
        let (out, _) = run(&mut s, "../../../../../../etc/passwd", 7);
        assert_eq!(out.kind, KIND_UNAUTHORIZED);
    }

    #[test]
    fn 软链逃逸下不泄露存在性() {
        let dir = tmp_dir("symlink");
        let outside = std::env::temp_dir().join(format!("rmd-link-outside-{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        let mut s = session_in(&dir);
        // `root/link/secret.md` 真实存在，但软链写到授权外
        let (out, calls) = run(&mut s, "link/secret.md", 7);
        assert_eq!(out.kind, KIND_UNAUTHORIZED);
        assert!(calls.is_empty());
        // 同一个前缀下的**不存在**目标也只能得到同一个答复
        let (out, _) = run(&mut s, "link/nope.md", 7);
        assert_eq!(out.kind, KIND_UNAUTHORIZED, "最近存在祖先在 root 之外 ⇒ 不能说");
    }

    #[test]
    fn 绝对路径标记的_query_被拒() {
        let mut s = session();
        let (out, _) = run(&mut s, "rmd-file:/tmp/a.md?x=1", 0);
        assert_eq!(out.kind, KIND_LOCAL_QUERY);
    }
}
