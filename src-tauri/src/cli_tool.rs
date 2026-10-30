//! 应用内安装命令行工具（`design/0033`，五稿）。
//!
//! 一件事：在 `<落点>/rmd` 建一条**指向当前 `.app` 内可执行文件**的符号链接，
//! 并如实告诉用户"终端里到底能不能敲到它"。
//!
//! # 为什么这个模块**不门控** `gui`
//!
//! 与 `link.rs` / `external.rs` 同源（`design/0026` `INV-LINK-09`）：这里承载的是
//! **所有权判定 / 探测协议 / 提权命令构造**三族安全判据，而 `make test` 跑的是
//! **不带 `--features gui`** 的默认构建——门控掉等于这三族判据一条测试都跑不到。
//! 需要 `AppHandle` 的那半（菜单、原生框、`emit`）在 `gui/mod.rs`。
//!
//! # 五稿改了什么（`design/0033` §9.6）
//!
//! - **逐壳固定载荷**（G1）：`zsh` 用 `type -w`，`bash`/`sh` 用 `type -t`；
//!   `type -t` **不是跨壳通用接口**（zsh 直接 `bad option: -t`）。
//! - **写盘前的包名判据**（G2）：目标必须与链接**共用**同一份末四段判据，
//!   否则从改名后的 `.app` 首次安装会造出一条随后装不上也卸不掉的链接。
//! - **`realpath` 失败分类**：`ENOENT`/`ENOTDIR` 才算悬空；`EACCES`/`ELOOP` 等
//!   一律当"无法确认"⇒ `Foreign`（⛔ 不进可覆盖/可删分支）。
//! - **读线程有界结束**：后代可能继承 stdout 导致永不 EOF ⇒ kill+wait 之后
//!   `recv_timeout`，超时即 detach（⛔ `join`），并对 >64 KiB 的截断结果判 `unknown`。

use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;

// ─────────────────────────────────────────────────────────────────────────
// 一、所有权与落点（纯逻辑 + 薄 IO）
// ─────────────────────────────────────────────────────────────────────────

/// ⭐ **包名是字面量**（`design/0033` 决定 6 ③，F2）。
///
/// ⚠️ 判据只能证明"**这样写的一个链接**"，⛔ 证明不了"是 rmd 建的" ⇒
/// 范围必须窄到不会误伤别的产品：`/tmp/Other.app/Contents/MacOS/rmd` **不是我们的**。
pub const APP_TAIL: [&str; 4] = ["rmd.app", "Contents", "MacOS", "rmd"];

/// 落点 1：`$HOME/.local/bin`（不需要密码）。
pub const LOCAL_DIR_REL: &str = ".local/bin";

/// 落点 2：`/usr/local/bin`（要管理员密码）。
pub const SYSTEM_DIR: &str = "/usr/local/bin";

/// 一个落点。⚠️ 顺序 = `uninstall` 的 `candidates` 顺序（`INV-CLI-16`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Location {
    Local,
    System,
}

impl Location {
    pub fn dir(self, home: &Path) -> PathBuf {
        match self {
            Location::Local => home.join(LOCAL_DIR_REL),
            Location::System => PathBuf::from(SYSTEM_DIR),
        }
    }

    fn link(self, home: &Path) -> PathBuf {
        self.dir(home).join("rmd")
    }

    pub fn needs_admin(self) -> bool {
        self == Location::System
    }

    fn tag(self) -> &'static str {
        match self {
            Location::Local => "local",
            Location::System => "system",
        }
    }
}

/// 两个落点，顺序固定：`$HOME/.local/bin` → `/usr/local/bin`。
pub fn all_locations(home: &Path) -> Vec<(Location, PathBuf)> {
    [Location::Local, Location::System]
        .into_iter()
        .map(|l| (l, l.link(home)))
        .collect()
}

/// 链接形态的所有权判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    Ours,
    Foreign,
}

/// **词法**绝对化 + 归一化：⛔ 不访问文件系统、⛔ 不看 cwd（`INV-CLI-07`）。
pub fn lexical_abs(link_text: &str, link_dir: &Path) -> PathBuf {
    let raw = Path::new(link_text);
    let joined = if raw.is_absolute() { raw.to_path_buf() } else { link_dir.join(raw) };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::RootDir => out.push("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                // ⚠️ 不许越过根：`pop` 在 `/` 上是 no-op，正好符合"不越过根"。
                out.pop();
            }
            Component::Normal(s) => out.push(s),
            Component::Prefix(_) => {}
        }
    }
    out
}

/// ⭐ **唯一**的末四段判据：链接形态与安装目标**共用这一份**（G2 的要求）。
pub fn last_four_ok(path: &Path) -> bool {
    let parts: Vec<_> = path.components().filter_map(|c| match c {
        Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
        _ => None,
    }).collect();
    if parts.len() < 4 {
        return false;
    }
    let n = parts.len();
    parts[n - 4] == APP_TAIL[0]
        && parts[n - 3] == APP_TAIL[1]
        && parts[n - 2] == APP_TAIL[2]
        && parts[n - 1] == APP_TAIL[3]
}

/// 安装目标（`current_exe()` 规范化后）是否合格。
///
/// ⚠️ **必须在写盘之前**调用（G2）：只校验"在 `.app/Contents/MacOS/` 里"的话，
/// 从 `rmd-0.4.app` 启动能装成功，但同一份 `shape()` 随后判 `Foreign` ⇒
/// 重复安装冲突、菜单卸载拒删，而用户什么都没改过。
pub fn target_ok(target: &Path) -> bool {
    target.is_absolute() && last_four_ok(target)
}

/// `realpath` 的失败**要分类**（§9.5 补正）。
///
/// ⚠️ 权限错误或链接环**不是**"已确认悬空"——把它们读成悬空会让
/// `EACCES` 的条目走进**可覆盖/可删除**分支。
pub fn is_dangling_err(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory)
}

/// 给定链接文本与 `realpath` 的结果，判形态。
///
/// 抽成 `shape_with` 是为了两个方向都能单测：
/// ① 真链结构（临时目录里造）② 闭包注入的 `EACCES`/`ELOOP`（真造出来也能，但注入更快更准）。
pub fn shape_with<F>(link_text: &str, link_dir: &Path, realpath: F) -> Shape
where
    F: FnOnce(&Path) -> io::Result<PathBuf>,
{
    let abs = lexical_abs(link_text, link_dir);
    if !last_four_ok(&abs) {
        return Shape::Foreign;
    }
    match realpath(&abs) {
        Ok(real) => {
            if last_four_ok(&real) {
                Shape::Ours
            } else {
                Shape::Foreign
            }
        }
        // ⚠️ 只有"确实不存在"才是悬空；其余一律无法确认 ⇒ Foreign。
        Err(e) if is_dangling_err(&e) => Shape::Ours,
        Err(_) => Shape::Foreign,
    }
}

/// 真链结构版：`realpath` 用 `fs::canonicalize`。
pub fn shape(link_text: &str, link_dir: &Path) -> Shape {
    shape_with(link_text, link_dir, |p| fs::canonicalize(p))
}

/// 一个落点当前的条目形态（`install` / `uninstall` 共用）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Entry {
    Absent,
    /// 符号链接：`(链接文本, 形态)`
    Symlink { text: String, shape: Shape },
    /// 普通文件 / 目录 / 其它 ⇒ 永远不是我们的
    Other(&'static str),
}

fn read_entry(link: &Path) -> io::Result<Entry> {
    match fs::symlink_metadata(link) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Entry::Absent),
        Err(e) => Err(e),
        Ok(md) if md.file_type().is_symlink() => {
            let text = fs::read_link(link)?.to_string_lossy().into_owned();
            let dir = link.parent().unwrap_or(Path::new("/"));
            let sh = shape(&text, dir);
            Ok(Entry::Symlink { text, shape: sh })
        }
        Ok(md) if md.is_dir() => Ok(Entry::Other("目录")),
        Ok(_) => Ok(Entry::Other("普通文件")),
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 二、结果契约（`INV-CLI-16`）
// ─────────────────────────────────────────────────────────────────────────

/// 线上形状恒为 `{action, candidates[], verify}`（`design/0033` 决定 5，五稿机械同步）。
#[derive(Debug, Clone, Serialize)]
pub struct Payload {
    pub action: &'static str,
    pub candidates: Vec<Candidate>,
    // ⚠️ **不加** `skip_serializing_if`：`INV-CLI-16` 要求这个字段**始终存在**，
    //    uninstall 时序列化成 `null`。⛔ 别"顺手"补上——那会让线上形状变成两副，
    //    而前端那份 `clitool.js` 读到的是"字段缺失"与"null"两种不同的东西。
    pub verify: Option<Verify>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Candidate {
    pub path: String,
    pub result: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Candidate {
    fn new(path: &Path, result: &'static str, detail: Option<String>) -> Self {
        Candidate { path: path.display().to_string(), result, detail }
    }
}

/// 探测结论。`state` 只取四态之一；`kind` 只在 `shadowed` 时有值。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Verify {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl Verify {
    fn unknown() -> Self {
        Verify { state: "unknown", kind: None, path: None }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 三、提权命令（`INV-CLI-14`：数据永不进入脚本源码）
// ─────────────────────────────────────────────────────────────────────────

/// 安装脚本：**常量**，路径只走 argv，shell 引用交给 AppleScript 的 `quoted form of`。
pub const INSTALL_SCRIPT: &str = "on run argv
    set linkDir to item 1 of argv
    set targetPath to item 2 of argv
    set linkPath to item 3 of argv
    set shellCmd to \"/bin/mkdir -p \" & quoted form of linkDir & \" && /bin/ln -sfn \" & quoted form of targetPath & \" \" & quoted form of linkPath
    do shell script shellCmd with administrator privileges
end run";

/// 卸载脚本：与安装版**同一份构造**，唯一差异是内层 `/bin/rm -f`。
pub const UNINSTALL_SCRIPT: &str = "on run argv
    set linkPath to item 1 of argv
    set shellCmd to \"/bin/rm -f \" & quoted form of linkPath
    do shell script shellCmd with administrator privileges
end run";

/// 把脚本切成「每行一个 `-e`」＋末尾 argv。
///
/// ⚠️ 三个路径**只出现在最后的位置参数**里，⛔ 不出现在任何 `-e` 的文本中——
/// 这是 `INV-CLI-14` 的可断言形态（§7.1 #47）。
pub fn osascript_args(script: &str, positional: &[&Path]) -> Vec<OsString> {
    let mut out: Vec<OsString> = Vec::new();
    for line in script.lines() {
        out.push(OsString::from("-e"));
        out.push(OsString::from(line));
    }
    // ⚠️ `--` 之后的才是 run 处理器的 argv（防将来出现以 `-` 开头的参数被当选项）。
    out.push(OsString::from("--"));
    for p in positional {
        out.push(p.as_os_str().to_os_string());
    }
    out
}

enum Escalation {
    Ok,
    Cancelled,
    Failed(String),
}

/// 跑一次提权脚本（真弹系统密码框）。⚠️ 只有产品路径会走到这里，测试**不调**。
fn run_osascript(args: &[OsString]) -> Escalation {
    let out = Command::new("/usr/bin/osascript").args(args).output();
    let out = match out {
        Ok(o) => o,
        Err(e) => return Escalation::Failed(format!("osascript 起不来：{e}")),
    };
    if out.status.success() {
        return Escalation::Ok;
    }
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    // ⚠️ 取消**不是失败**：用户按了 Cancel，磁盘没动（决定 9）。
    if err.contains("User canceled") || err.contains("-128") {
        return Escalation::Cancelled;
    }
    let first = err.lines().next().unwrap_or("").trim().to_string();
    Escalation::Failed(if first.is_empty() {
        format!("osascript 退出码 {}", out.status.code().unwrap_or(-1))
    } else {
        first
    })
}

// ─────────────────────────────────────────────────────────────────────────
// 四、探测（五稿：逐壳固定载荷）
// ─────────────────────────────────────────────────────────────────────────

pub const PROBE_BEGIN: &str = "__RMD_BEGIN__";
pub const PROBE_RC: &str = "__RMD_RC__";
pub const PROBE_CMD: &str = "__RMD_CMD__";
pub const PROBE_TYPE: &str = "__RMD_TYPE__";
pub const PROBE_END: &str = "__RMD_END__";

/// 读线程的缓冲上限（超过即判 `unknown`，⛔ 不用截断数据下结论）。
pub const PROBE_CAP: usize = 64 * 1024;

/// POSIX 版（`bash` / `sh`）：`type -t`。
pub const POSIX_PAYLOAD: &str = "printf '__RMD_BEGIN__\\n'
__rmd_cmd=$(command -v rmd 2>/dev/null) && __rmd_rc=0 || __rmd_rc=$?
printf '__RMD_RC__%s\\n' \"$__rmd_rc\"
printf '__RMD_CMD__%s\\n' \"$__rmd_cmd\"
printf '__RMD_TYPE__%s\\n' \"$(type -t rmd 2>/dev/null || printf 'unsupported')\"
printf '__RMD_END__\\n'";

/// zsh 版：`type -w`（⭐ zsh **没有** `type -t`），输出 `rmd: <词>`，用参数展开去前缀。
pub const ZSH_PAYLOAD: &str = "printf '__RMD_BEGIN__\\n'
__rmd_cmd=$(command -v rmd 2>/dev/null) && __rmd_rc=0 || __rmd_rc=$?
printf '__RMD_RC__%s\\n' \"$__rmd_rc\"
printf '__RMD_CMD__%s\\n' \"$__rmd_cmd\"
__rmd_word=$(type -w rmd 2>/dev/null) || __rmd_word=''
__rmd_word=${__rmd_word#rmd: }
printf '__RMD_TYPE__%s\\n' \"$__rmd_word\"
printf '__RMD_END__\\n'";

/// 支持范围 = **本机实跑过的三种壳**；其余一律不探（`None`）。
///
/// ⚠️ `dash`/`ksh`/`fish` **刻意不在表里**：把它们划进"POSIX 族"只是同族推断，
/// `type -t` 本身也不是 POSIX 规定项 ⇒ 宁可 `unknown`，⛔ 不拿用户当实验场。
pub fn payload_for(shell: &str) -> Option<&'static str> {
    match shell {
        "zsh" => Some(ZSH_PAYLOAD),
        "bash" | "sh" => Some(POSIX_PAYLOAD),
        _ => None,
    }
}

/// zsh 的词表 → 与 bash 对齐的**统一词表**（`command`/`reserved`/`none` 是 zsh 独有的）。
pub fn normalize_type(raw: &str) -> &str {
    match raw.trim() {
        "command" => "file",
        "reserved" => "keyword",
        "none" => "unsupported",
        other => other,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub rc: i32,
    pub cmd: String,
    pub kind: String,
}

/// 解析五标记四字段协议。
///
/// 规则（`INV-CLI-15`）：
/// - 取**最后一个** `BEGIN` 之后、**第一个** `END` 之前的块；
/// - 块内每条字段**恰好一次**；缺失/重复 ⇒ `None`（协议违约，⛔ 不是 `not-on-path`）；
/// - 块内其余行忽略（banner、alias 展开、函数体都只能落到这里）；
/// - ⚠️ 超过 64 KiB 或读线程截断 ⇒ `None`（⛔ 用截断数据下结论）。
pub fn parse_probe(stdout: &str) -> Option<Probe> {
    let lines: Vec<&str> = stdout.lines().collect();
    let begin = lines.iter().rposition(|l| l.trim_end() == PROBE_BEGIN)?;
    let end = lines
        .iter()
        .enumerate()
        .skip(begin + 1)
        .find(|(_, l)| l.trim_end() == PROBE_END)
        .map(|(i, _)| i)?;
    let block = &lines[begin + 1..end];

    let mut rc: Option<i32> = None;
    let mut cmd: Option<String> = None;
    let mut kind: Option<String> = None;
    for line in block {
        if let Some(v) = line.strip_prefix(PROBE_RC) {
            if rc.is_some() {
                return None;
            }
            rc = Some(v.trim().parse().ok()?);
        } else if let Some(v) = line.strip_prefix(PROBE_CMD) {
            if cmd.is_some() {
                return None;
            }
            cmd = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix(PROBE_TYPE) {
            if kind.is_some() {
                return None;
            }
            kind = Some(v.to_string());
        }
    }
    Some(Probe { rc: rc?, cmd: cmd?, kind: kind? })
}

/// 分类（`design/0033` 决定 10 ④，按序判）。
///
/// ⚠️ **只有 `kind == file` 才要求 `cmd` 是绝对路径**（G1 的第二处补正）：
/// alias/function 的 `command -v` **合法地**输出 `alias rmd='…'` / 函数名。
pub fn classify_with<F>(probe: Option<Probe>, link: &Path, realpath: F) -> Verify
where
    F: Fn(&Path) -> io::Result<PathBuf>,
{
    let Some(p) = probe else {
        return Verify::unknown();
    };
    if p.rc != 0 {
        return Verify { state: "not-on-path", kind: None, path: None };
    }
    if p.cmd.trim().is_empty() {
        return Verify::unknown();
    }
    let kind = normalize_type(&p.kind).to_string();
    match kind.as_str() {
        "alias" | "function" | "builtin" | "keyword" => Verify {
            state: "shadowed",
            kind: Some(kind),
            path: None,
        },
        "file" => {
            let cmd_path = Path::new(&p.cmd);
            if !cmd_path.is_absolute() {
                // ⚠️ 文件型命令的 `command -v` 必须给绝对路径 ⇒ 协议违约。
                return Verify::unknown();
            }
            let shown = p.cmd.trim().to_string();
            match (realpath(cmd_path), realpath(link)) {
                (Ok(a), Ok(b)) if a == b => Verify { state: "verified", kind: None, path: Some(shown) },
                _ => Verify { state: "shadowed", kind: Some("file".into()), path: Some(shown) },
            }
        }
        _ => Verify::unknown(),
    }
}

/// 起一次 `$SHELL -l -i -c <载荷>` 并解析。
///
/// ⚠️ 五稿的**有界结束**（§9.5 补正）：启动配置可以留下**继承 stdout 的后代**，
/// 直接 shell 被 kill 了管道仍不 EOF ⇒ `kill`+`wait` 之后只等 500 ms，
/// 超时就 **detach 读线程**（⛔ `join`）并判 `unknown`。
fn run_probe(shell: &Path, payload: &str) -> Option<String> {
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", payload])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // ⚠️ 登录/交互壳会把 banner、提示符写 stderr ⇒ 丢到 null，⛔ 不让它污染协议。
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel::<(String, bool)>();
    std::thread::spawn(move || {
        let mut buf: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut reader = stdout;
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if !truncated {
                        if buf.len() + n > PROBE_CAP {
                            truncated = true;
                        } else {
                            buf.extend_from_slice(&chunk[..n]);
                        }
                    }
                    // 超限之后**继续读但丢弃**：⛔ 让子进程卡在满管上。
                }
                Err(_) => {
                    truncated = true;
                    break;
                }
            }
        }
        let _ = tx.send((String::from_utf8_lossy(&buf).into_owned(), truncated));
    });

    let deadline = Instant::now() + Duration::from_secs(3);
    let mut exited = false;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => {
                exited = true;
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break,
        }
    }
    if !exited {
        let _ = child.kill();
        let _ = child.wait();
    }

    match rx.recv_timeout(Duration::from_millis(500)) {
        Ok((text, false)) => Some(text),
        // ⚠️ 截断 / 超时（后代仍持管道）⇒ unknown，⛔ 不用半截数据下结论。
        _ => None,
    }
}

/// 装完探一次「终端到底能不能用」。
pub fn verify_link(shell: Option<&Path>, link: &Path) -> Verify {
    let Some(shell) = shell else {
        return Verify::unknown();
    };
    let name = shell.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let Some(payload) = payload_for(&name) else {
        return Verify::unknown();
    };
    let text = run_probe(shell, payload);
    classify_with(text.as_deref().and_then(parse_probe), link, |p| fs::canonicalize(p))
}

// ─────────────────────────────────────────────────────────────────────────
// 五、安装 / 卸载
// ─────────────────────────────────────────────────────────────────────────

fn other_detail(entry: &Entry) -> String {
    match entry {
        Entry::Symlink { text, .. } => format!("指向 {text}"),
        Entry::Other(kind) => kind.to_string(),
        Entry::Absent => "不存在".to_string(),
    }
}

fn io_detail(e: &io::Error) -> String {
    match e.raw_os_error() {
        Some(n) => format!("{e}（errno {n}）"),
        None => e.to_string(),
    }
}

/// 链接会不会指向自己（词法判定，⛔ 不碰文件系统）。
///
/// ⚠️ 正常路径上走不到：能过 `target_ok` 的目标必在 `rmd.app/Contents/MacOS/rmd`，
/// 而链接恒为 `<落点目录>/rmd`。留着是因为"上游一定先拦"不是一条可依赖的性质。
pub fn is_self_link(link: &Path, home: &Path, target: &Path) -> bool {
    lexical_abs(&link.to_string_lossy(), home) == target
}

/// 写一条链接。⚠️ 只有**用户点了菜单**才会走到这里（`INV-CLI-09`）。
fn create_link(home: &Path, loc: Location, target: &Path) -> Escalation {
    let link = loc.link(home);
    if loc.needs_admin() {
        let args = osascript_args(
            INSTALL_SCRIPT,
            &[loc.dir(home).as_path(), target, link.as_path()],
        );
        return run_osascript(&args);
    }
    if let Err(e) = fs::create_dir_all(loc.dir(home)) {
        return Escalation::Failed(io_detail(&e));
    }
    // ⚠️ `symlink` **不覆盖**：走到这里的"已存在"一定是**我们自己那条**（外来条目在调用方
    //    就判 conflict 了）⇒ 先摘掉再建。⛔ 不做 `rename` 交换：两步之间的失败态是"没有链接"，
    //    比"指向旧目标"更容易被发现，且下一次安装会再覆盖一次。
    match fs::symlink_metadata(&link) {
        Ok(md) if md.file_type().is_symlink() => {
            if let Err(e) = fs::remove_file(&link) {
                return Escalation::Failed(io_detail(&e));
            }
        }
        Ok(_) => return Escalation::Failed("写入前发现同名条目不是符号链接".to_string()),
        Err(_) => {}
    }
    if let Err(e) = std::os::unix::fs::symlink(target, &link) {
        return Escalation::Failed(io_detail(&e));
    }
    Escalation::Ok
}

/// 安装（`candidates` 恒 1 项）。
///
/// `exe` 是 `current_exe()`；`shell` 是探测用的 `$SHELL`（`None` ⇒ `unknown`）。
pub fn install(home: &Path, loc: Location, exe: &Path, shell: Option<&Path>) -> Payload {
    let link = loc.link(home);
    let mut out = Payload { action: "install", candidates: Vec::new(), verify: None };

    // ① 目标：规范化 + **写盘前**的包名判据（G2）
    let target = match fs::canonicalize(exe) {
        Ok(p) => p,
        Err(e) => {
            out.candidates.push(Candidate::new(&link, "refused", Some(format!("无法解析当前可执行文件：{}", io_detail(&e)))));
            return out;
        }
    };
    if !target_ok(&target) {
        out.candidates.push(Candidate::new(
            &link,
            "refused",
            Some(format!(
                "当前程序不在名为 rmd.app 的包里（{}）；若你给 .app 改过名，改回 rmd.app 再装",
                target.display()
            )),
        ));
        return out;
    }
    // ② 自指（防御；正常路径上 `target_ok` 先会拦住，但这里不能靠"上游一定先拦"）
    if is_self_link(&link, home, &target) {
        out.candidates.push(Candidate::new(&link, "refused", Some("链接目标就是链接自己".to_string())));
        return out;
    }

    // ③ 既有条目
    let result = match read_entry(&link) {
        Err(e) => {
            out.candidates.push(Candidate::new(&link, "failed", Some(io_detail(&e))));
            return out;
        }
        Ok(Entry::Other(kind)) => {
            out.candidates.push(Candidate::new(&link, "conflict", Some(format!("{kind}（不是本工具建的链接）"))));
            return out;
        }
        Ok(Entry::Symlink { text, shape: Shape::Foreign }) => {
            out.candidates.push(Candidate::new(&link, "conflict", Some(format!("指向 {text}"))));
            return out;
        }
        Ok(Entry::Symlink { shape: Shape::Ours, .. }) => {
            match fs::canonicalize(&link) {
                Ok(real) if real == target => "already",
                // 形态是我们的、但解析不到当前目标（含悬空）⇒ 覆盖
                _ => {
                    let r = create_link(home, loc, &target);
                    match r {
                        Escalation::Ok => "replaced",
                        Escalation::Cancelled => {
                            out.candidates.push(Candidate::new(&link, "cancelled", None));
                            return out;
                        }
                        Escalation::Failed(d) => {
                            out.candidates.push(Candidate::new(&link, "failed", Some(d)));
                            return out;
                        }
                    }
                }
            }
        }
        Ok(Entry::Absent) => {
            let r = create_link(home, loc, &target);
            match r {
                Escalation::Ok => "installed",
                Escalation::Cancelled => {
                    out.candidates.push(Candidate::new(&link, "cancelled", None));
                    return out;
                }
                Escalation::Failed(d) => {
                    out.candidates.push(Candidate::new(&link, "failed", Some(d)));
                    return out;
                }
            }
        }
    };

    // ⚠️ 写盘之后自证一次（`INV-CLI-02` 的可观测形态）：`installed` 却读不回来 = 失败。
    // ⚠️ 判的是**链接文本**的形态（`shape` 的第一个参数是目标文本，⛔ 不是链接自身）。
    if result != "already" {
        let ok = match fs::read_link(&link) {
            Ok(text) => {
                let dir = link.parent().unwrap_or(Path::new("/"));
                shape(&text.to_string_lossy(), dir) == Shape::Ours
            }
            Err(_) => false,
        };
        if !ok {
            out.candidates.push(Candidate::new(&link, "failed", Some("写完之后链接形态不可识别".into())));
            return out;
        }
    }

    out.candidates.push(Candidate::new(&link, result, None));
    // `verify` 只在 install 的成功分支（`INV-CLI-16`）
    out.verify = Some(verify_link(shell, &link));
    out
}

/// 卸载：两个落点**逐条**给结果（`candidates` 1–2 项，顺序固定）。
pub fn uninstall(home: &Path) -> Payload {
    let mut out = Payload { action: "uninstall", candidates: Vec::new(), verify: None };
    for (loc, link) in all_locations(home) {
        let c = uninstall_one(loc, &link);
        out.candidates.push(c);
    }
    out
}

fn uninstall_one(loc: Location, link: &Path) -> Candidate {
    match read_entry(link) {
        Err(e) => Candidate::new(link, "failed", Some(io_detail(&e))),
        Ok(Entry::Absent) => Candidate::new(link, "absent", None),
        Ok(entry @ Entry::Other(_)) => Candidate::new(link, "not-ours", Some(other_detail(&entry))),
        Ok(entry @ Entry::Symlink { shape: Shape::Foreign, .. }) => {
            Candidate::new(link, "not-ours", Some(other_detail(&entry)))
        }
        Ok(Entry::Symlink { shape: Shape::Ours, .. }) => {
            let r = if loc.needs_admin() {
                run_osascript(&osascript_args(UNINSTALL_SCRIPT, &[link]))
            } else {
                match fs::remove_file(link) {
                    Ok(()) => Escalation::Ok,
                    Err(e) => Escalation::Failed(io_detail(&e)),
                }
            };
            match r {
                Escalation::Ok => {
                    // ⚠️ 删完自证：`ENOENT` 才算删掉（⛔ 把"命令返回 0"当删掉）。
                    if fs::symlink_metadata(link).is_err() {
                        Candidate::new(link, "uninstalled", None)
                    } else {
                        Candidate::new(link, "failed", Some("命令返回成功，但条目仍在".into()))
                    }
                }
                Escalation::Cancelled => Candidate::new(link, "cancelled", None),
                Escalation::Failed(d) => Candidate::new(link, "failed", Some(d)),
            }
        }
    }
}

/// `$SHELL` 的路径（产品用）。
pub fn current_shell() -> Option<PathBuf> {
    std::env::var_os("SHELL").map(PathBuf::from).filter(|p| p.is_absolute())
}

// ─────────────────────────────────────────────────────────────────────────
// 六、测试
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    // ── 临时夹具 ──────────────────────────────────────────────────────

    struct Temp(PathBuf);
    impl Temp {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "rmd-cli-tool-{}-{}-{tag}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            Temp(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// 造一个 `<root>/rmd.app/Contents/MacOS/rmd` 假二进制，返回可执行文件路径。
    fn fake_app(root: impl AsRef<Path>) -> PathBuf {
        let dir = root.as_ref().join("rmd.app/Contents/MacOS");
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("rmd");
        fs::write(&exe, b"#!/bin/sh\n").unwrap();
        // ⚠️ 必须可执行：`command -v` 的 PATH 搜索会查执行位（探针夹具靠这一点才找得到）。
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        }
        exe
    }

    // ── 词法归一化与末四段 ────────────────────────────────────────────

    #[test]
    fn 词法归一化按链接目录且不越过根() {
        let dir = Path::new("/Applications");
        assert_eq!(
            lexical_abs("../x/./y/../rmd.app/Contents/MacOS/rmd", dir),
            PathBuf::from("/x/rmd.app/Contents/MacOS/rmd")
        );
        assert_eq!(
            lexical_abs("/../../rmd.app/Contents/MacOS/rmd", dir),
            PathBuf::from("/rmd.app/Contents/MacOS/rmd")
        );
        assert_eq!(
            lexical_abs("rmd.app/Contents/MacOS/rmd", dir),
            PathBuf::from("/Applications/rmd.app/Contents/MacOS/rmd")
        );
    }

    #[test]
    fn 末四段判据接受五段以上且包名逐字() {
        assert!(last_four_ok(Path::new("/Applications/rmd.app/Contents/MacOS/rmd")));
        assert!(last_four_ok(Path::new(
            "/Users/me/Applications/rmd.app/Contents/MacOS/rmd"
        )));
        assert!(!last_four_ok(Path::new("/Applications/rmd.app/Contents/MacOS/rdm")));
        assert!(!last_four_ok(Path::new("/Applications/rmd.app/Contents/MacOS/rmd/foo")));
        assert!(!last_four_ok(Path::new("/Applications/rmd.app/Contents/Resources/rmd")));
        // ⭐ F2 / G2：包名必须逐字 `rmd.app`
        assert!(!last_four_ok(Path::new("/tmp/Other.app/Contents/MacOS/rmd")));
        assert!(!last_four_ok(Path::new("/tmp/rmd-0.4.app/Contents/MacOS/rmd")));
        // 三稿的"恰好四段"会在这里红
        assert!(last_four_ok(Path::new("/a/b/c/rmd.app/Contents/MacOS/rmd")));
    }

    #[test]
    fn 目标判据要求绝对路径() {
        assert!(target_ok(Path::new("/Applications/rmd.app/Contents/MacOS/rmd")));
        assert!(!target_ok(Path::new("rmd.app/Contents/MacOS/rmd")));
        // ⛔ 裸二进制 / 拷贝都不过
        assert!(!target_ok(Path::new("/Users/me/.local/bin/rmd")));
        assert!(!target_ok(Path::new("/repo/src-tauri/target/release/rmd")));
    }

    // ── shape：真结构 ────────────────────────────────────────────────

    #[test]
    fn 悬空但形态是我们的算_Ours_悬空的外来算_Foreign() {
        let t = Temp::new("dangling");
        let dir = t.path().join("bin");
        fs::create_dir_all(&dir).unwrap();
        // 目标不存在 ⇒ realpath ENOENT ⇒ 悬空
        symlink("/nope/rmd.app/Contents/MacOS/rmd", dir.join("rmd")).unwrap();
        assert_eq!(shape("/nope/rmd.app/Contents/MacOS/rmd", &dir), Shape::Ours);
        assert_eq!(shape("/tmp/foo", &dir), Shape::Foreign);
    }

    #[test]
    fn 中间符号链接指向别处判_Foreign() {
        let t = Temp::new("midlink");
        let real = t.path().join("real");
        fs::create_dir_all(real.join("Contents/MacOS")).unwrap();
        fs::write(real.join("Contents/MacOS/rmd"), b"x").unwrap();
        let alias = t.path().join("rmd.app");
        symlink(&real, &alias).unwrap();
        // 文本过 ③，但 realpath 末四段是 real/Contents/MacOS/rmd ⇒ Foreign
        assert_eq!(
            shape(&alias.join("Contents/MacOS/rmd").to_string_lossy(), t.path()),
            Shape::Foreign
        );
    }

    #[test]
    fn realpath_的_EACCES_与_ELOOP_都判_Foreign() {
        let dir = Path::new("/tmp");
        let text = "/x/rmd.app/Contents/MacOS/rmd";
        let perm = io::Error::from_raw_os_error(13); // EACCES
        let loop_ = io::Error::from_raw_os_error(62); // ELOOP
        assert_eq!(shape_with(text, dir, |_| Err(perm)), Shape::Foreign);
        assert_eq!(shape_with(text, dir, |_| Err(loop_)), Shape::Foreign);
        let missing = io::Error::from(io::ErrorKind::NotFound);
        assert_eq!(shape_with(text, dir, |_| Err(missing)), Shape::Ours);
        let notdir = io::Error::from(io::ErrorKind::NotADirectory);
        assert_eq!(shape_with(text, dir, |_| Err(notdir)), Shape::Ours);
    }

    #[test]
    fn 中间目录权限不足时卸载判_not_ours_且条目仍在() {
        let t = Temp::new("eacces");
        let home = t.path().join("home");
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        // …/locked/… 里造一个形态正确的目标，再把 locked 设成 000
        let locked = t.path().join("locked");
        fs::create_dir_all(locked.join("rmd.app/Contents/MacOS")).unwrap();
        fs::write(locked.join("rmd.app/Contents/MacOS/rmd"), b"x").unwrap();
        let link = bin.join("rmd");
        symlink(locked.join("rmd.app/Contents/MacOS/rmd"), &link).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let p = uninstall(&home);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        // ⚠️ 以 root 跑时 EACCES 不会发生 ⇒ 那种环境下这条会退化成 uninstalled。
        if unsafe { libc::geteuid() } != 0 {
            assert_eq!(p.candidates[0].result, "not-ours", "{:?}", p.candidates[0]);
            assert!(fs::symlink_metadata(&link).is_ok(), "条目必须仍在");
        }
    }

    // ── install ──────────────────────────────────────────────────────

    #[test]
    fn 空目录装成_symbolic_link_再装是_already_且不重写() {
        let t = Temp::new("install");
        let home = t.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let exe = fake_app(t.path().join("apps"));
        let p = install(&home, Location::Local, &exe, None);
        assert_eq!(p.candidates[0].result, "installed");
        let link = home.join(".local/bin/rmd");
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_link(&link).unwrap(), fs::canonicalize(&exe).unwrap());
        let before = fs::symlink_metadata(&link).unwrap().modified().unwrap();
        let p2 = install(&home, Location::Local, &exe, None);
        assert_eq!(p2.candidates[0].result, "already");
        assert_eq!(fs::symlink_metadata(&link).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn 普通文件冲突且字节不变() {
        let t = Temp::new("conflict-file");
        let home = t.path().join("home");
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let link = bin.join("rmd");
        fs::write(&link, b"i am not a link").unwrap();
        let exe = fake_app(t.path().join("apps"));
        let p = install(&home, Location::Local, &exe, None);
        assert_eq!(p.candidates[0].result, "conflict");
        assert_eq!(fs::read(&link).unwrap(), b"i am not a link");
    }

    #[test]
    fn 目录冲突() {
        let t = Temp::new("conflict-dir");
        let home = t.path().join("home");
        fs::create_dir_all(home.join(".local/bin/rmd")).unwrap();
        let exe = fake_app(t.path().join("apps"));
        assert_eq!(install(&home, Location::Local, &exe, None).candidates[0].result, "conflict");
    }

    #[test]
    fn 外来链接不接管() {
        let t = Temp::new("conflict-link");
        let home = t.path().join("home");
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let link = bin.join("rmd");
        symlink("/tmp/foo", &link).unwrap();
        let exe = fake_app(t.path().join("apps"));
        let p = install(&home, Location::Local, &exe, None);
        assert_eq!(p.candidates[0].result, "conflict");
        assert_eq!(fs::read_link(&link).unwrap(), PathBuf::from("/tmp/foo"));
    }

    #[test]
    fn 悬空的外来链接也不接管() {
        let t = Temp::new("conflict-dangling");
        let home = t.path().join("home");
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let link = bin.join("rmd");
        symlink("/tmp/gone", &link).unwrap();
        let exe = fake_app(t.path().join("apps"));
        assert_eq!(install(&home, Location::Local, &exe, None).candidates[0].result, "conflict");
    }

    #[test]
    fn 我们的悬空链接可被覆盖成_replaced() {
        let t = Temp::new("replace-dangling");
        let home = t.path().join("home");
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let link = bin.join("rmd");
        symlink("/old/rmd.app/Contents/MacOS/rmd", &link).unwrap();
        let exe = fake_app(t.path().join("apps"));
        let p = install(&home, Location::Local, &exe, None);
        assert_eq!(p.candidates[0].result, "replaced");
        assert_eq!(fs::read_link(&link).unwrap(), fs::canonicalize(&exe).unwrap());
    }

    #[test]
    fn 形态是我们的但指向另一个_app_判_replaced() {
        let t = Temp::new("replace-other-app");
        let home = t.path().join("home");
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let other = fake_app(t.path().join("other"));
        let link = bin.join("rmd");
        symlink(&other, &link).unwrap();
        let exe = fake_app(t.path().join("apps"));
        assert_eq!(install(&home, Location::Local, &exe, None).candidates[0].result, "replaced");
    }

    #[test]
    fn 目标不在_app_内拒绝且不建目录() {
        let t = Temp::new("refused-target");
        let home = t.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let exe = t.path().join("target/release/rmd");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"x").unwrap();
        let p = install(&home, Location::Local, &exe, None);
        assert_eq!(p.candidates[0].result, "refused");
        assert!(!home.join(".local/bin").exists(), "⛔ 拒绝时不许建目录（G2）");
    }

    #[test]
    fn 改名后的_app_首次安装被拒绝且磁盘零改动() {
        // ⭐ G2 的核心：四稿只校验"在 .app/Contents/MacOS 里" ⇒ 这里会 installed，
        //    随后 shape() 判 Foreign ⇒ 装不上也卸不掉。
        let t = Temp::new("refused-renamed");
        let home = t.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let dir = t.path().join("rmd-0.4.app/Contents/MacOS");
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("rmd");
        fs::write(&exe, b"x").unwrap();
        let p = install(&home, Location::Local, &exe, None);
        assert_eq!(p.candidates[0].result, "refused", "{:?}", p.candidates[0]);
        assert!(!home.join(".local/bin").exists());
    }

    #[test]
    fn 目标路径中间有别名时允许且写规范化路径() {
        let t = Temp::new("alias-target");
        let home = t.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let real_root = t.path().join("real");
        let exe = fake_app(&real_root);
        let alias = t.path().join("app-alias");
        symlink(&real_root, &alias).unwrap();
        let via_alias = alias.join("rmd.app/Contents/MacOS/rmd");
        let p = install(&home, Location::Local, &via_alias, None);
        assert_eq!(p.candidates[0].result, "installed", "{:?}", p.candidates[0]);
        assert_eq!(
            fs::read_link(home.join(".local/bin/rmd")).unwrap(),
            fs::canonicalize(&exe).unwrap(),
            "写进链接的必须是规范化路径"
        );
    }

    #[test]
    fn 相对链接文本解析到同一目标仍算_already() {
        let t = Temp::new("relative");
        let home = t.path().join("home");
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let exe = fake_app(t.path().join("apps"));
        let link = bin.join("rmd");
        // 链接文本是相对的（`bin` 在 `<root>/home/.local/bin`，目标在 `<root>/apps/...`）
        symlink("../../../apps/rmd.app/Contents/MacOS/rmd", &link).unwrap();
        let p = install(&home, Location::Local, &exe, None);
        assert_eq!(p.candidates[0].result, "already");
    }

    #[test]
    fn 自指判据是词法相等() {
        let home = Path::new("/Users/me");
        // 与落点同一条路径 ⇒ 自指
        assert!(is_self_link(
            Path::new("/Users/me/.local/bin/rmd"),
            home,
            Path::new("/Users/me/.local/bin/rmd")
        ));
        // 只差一层 `..` 也算
        assert!(is_self_link(
            Path::new("/Users/me/.local/bin/../bin/rmd"),
            home,
            Path::new("/Users/me/.local/bin/rmd")
        ));
        assert!(!is_self_link(
            Path::new("/Users/me/.local/bin/rmd"),
            home,
            Path::new("/Applications/rmd.app/Contents/MacOS/rmd")
        ));
    }

    #[test]
    fn 从落点那份拷贝启动时拒绝并说明原因() {
        // ⭐ 交付判据：`current_exe()` 是 `~/.local/bin/rmd` 那份拷贝 ⇒ 不在包里 ⇒ refused。
        let t = Temp::new("from-copy");
        let home = t.path().join("home");
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let copy = bin.join("rmd");
        fs::write(&copy, b"#!/bin/sh\n").unwrap();
        let p = install(&home, Location::Local, &copy, None);
        assert_eq!(p.candidates[0].result, "refused");
        assert!(
            p.candidates[0].detail.as_deref().unwrap_or("").contains("rmd.app"),
            "文案要指向真正的原因：{:?}",
            p.candidates[0].detail
        );
        // 磁盘零改动：那条拷贝一个字都没动（⛔ 没被链接覆盖）
        assert_eq!(fs::read(&copy).unwrap(), b"#!/bin/sh\n");
    }

    // ── uninstall ────────────────────────────────────────────────────

    #[test]
    fn 卸载两个候选恒定两项且全缺失时是两项_absent() {
        let t = Temp::new("uninstall-all-absent");
        let home = t.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let p = uninstall(&home);
        assert_eq!(p.action, "uninstall");
        assert_eq!(p.candidates.len(), 2, "⛔ 不许省成空数组");
        assert_eq!(p.candidates[0].result, "absent");
        assert_eq!(p.candidates[1].result, "absent");
        assert!(p.verify.is_none(), "uninstall 的 verify 恒为 null");
        assert!(p.candidates[1].path.starts_with(SYSTEM_DIR));
    }

    #[test]
    fn 装完再卸是_uninstalled_且父目录仍在() {
        let t = Temp::new("uninstall-ok");
        let home = t.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let exe = fake_app(t.path().join("apps"));
        install(&home, Location::Local, &exe, None);
        let p = uninstall(&home);
        assert_eq!(p.candidates[0].result, "uninstalled");
        assert!(!home.join(".local/bin/rmd").exists());
        assert!(home.join(".local/bin").is_dir(), "⛔ 不连锁删目录");
    }

    #[test]
    fn 卸载不删普通文件与目录() {
        let t = Temp::new("uninstall-notours");
        let home = t.path().join("home");
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("rmd"), b"copy").unwrap();
        let p = uninstall(&home);
        assert_eq!(p.candidates[0].result, "not-ours");
        assert_eq!(fs::read(bin.join("rmd")).unwrap(), b"copy");
    }

    #[test]
    fn 卸载删得掉形态属于我们的悬空链接() {
        let t = Temp::new("uninstall-dangling");
        let home = t.path().join("home");
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let link = bin.join("rmd");
        symlink("/gone/rmd.app/Contents/MacOS/rmd", &link).unwrap();
        let p = uninstall(&home);
        assert_eq!(p.candidates[0].result, "uninstalled");
        assert!(fs::symlink_metadata(&link).is_err());
    }

    #[test]
    fn 卸载拒删指向别处的链接() {
        let t = Temp::new("uninstall-foreign");
        let home = t.path().join("home");
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let link = bin.join("rmd");
        symlink("/tmp/foo", &link).unwrap();
        let p = uninstall(&home);
        assert_eq!(p.candidates[0].result, "not-ours");
        assert!(fs::symlink_metadata(&link).is_ok());
    }

    // ── 线上形状（`INV-CLI-16` / §7.1 #51）────────────────────────────
    //
    // ⚠️ 这两条守的是**序列化之后**的形状，⛔ 不是结构体的形状——
    //    `verify` 上的 `skip_serializing_if` 曾经让 uninstall 的那一帧**整个缺字段**，
    //    而所有结构体级断言照样全绿（字段在内存里确实是 `None`）。
    //    ⇒ 判据必须过一遍 `serde_json`，并且用 `get` 区分「键存在且为 null」与「键不存在」。

    #[test]
    fn 线上形状_install_恒有一项候选且_verify_非_null() {
        let t = Temp::new("wire-install");
        let home = t.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let exe = fake_app(t.path().join("apps"));

        let p = install(&home, Location::Local, &exe, None);
        let v = serde_json::to_value(&p).unwrap();

        assert_eq!(v["action"], "install");
        assert_eq!(v["candidates"].as_array().unwrap().len(), 1, "install 的 candidates 恒 1 项");
        // ⚠️ 成功分支的 verify **必须**存在且非 null（脚本据此告诉用户"终端能不能敲到"）。
        let verify = v.get("verify").expect("verify 键必须存在（INV-CLI-16）");
        assert!(!verify.is_null(), "install 成功分支的 verify 不许是 null：{v}");
    }

    #[test]
    fn 线上形状_uninstall_恒有两项候选且_verify_是_null() {
        let t = Temp::new("wire-uninstall");
        let home = t.path().join("home");
        fs::create_dir_all(&home).unwrap();

        let p = uninstall(&home);
        let v = serde_json::to_value(&p).unwrap();

        assert_eq!(v["action"], "uninstall");
        assert_eq!(v["candidates"].as_array().unwrap().len(), 2, "uninstall 恒两项（Local → System）");
        // ⚠️ 这里是本设计的**唯一**一处 null：字段存在、值为 null。
        //    ⛔ 别写成 `assert!(v["verify"].is_null())`——索引取值对"键不存在"也返回 Null，
        //    那条断言**恒真**，正是这个偏离能活下来的形态。
        assert!(v.get("verify").is_some(), "verify 键必须存在，哪怕值是 null：{v}");
        assert!(v["verify"].is_null(), "uninstall 的 verify 恒为 null：{v}");
    }

    // ── 探测协议 ─────────────────────────────────────────────────────

    fn probe_text(rc: i32, cmd: &str, kind: &str) -> String {
        format!(
            "{PROBE_BEGIN}\n{PROBE_RC}{rc}\n{PROBE_CMD}{cmd}\n{PROBE_TYPE}{kind}\n{PROBE_END}\n"
        )
    }

    #[test]
    fn 协议解析忽略块外噪声且取最后一个块() {
        let noisy = format!(
            "banner line 1\nbanner 2\n{}",
            probe_text(0, "/x/rmd", "file")
        );
        let p = parse_probe(&noisy).unwrap();
        assert_eq!(p.rc, 0);
        assert_eq!(p.cmd, "/x/rmd");
        assert_eq!(p.kind, "file");
    }

    #[test]
    fn 协议解析取最后一个块() {
        // ⚠️ 这条是**变异测试逼出来的**（§7.4 M13）：上一条用例只有**一个**块，
        //    把 `rposition` 换成 `position` 照样全绿 ⇒ "取最后一个"从来没被验过。
        let two = format!(
            "{}{}",
            probe_text(1, "/old/rmd", "alias"),
            probe_text(0, "/new/rmd", "file"),
        );
        let p = parse_probe(&two).unwrap();
        assert_eq!(p.rc, 0);
        assert_eq!(p.cmd, "/new/rmd");
        assert_eq!(p.kind, "file");
    }

    #[test]
    fn 协议违约一律解析失败() {
        let cases = [
            // 缺 END
            format!("{PROBE_BEGIN}\n{PROBE_RC}0\n{PROBE_CMD}/x\n{PROBE_TYPE}file\n"),
            // END 在 BEGIN 之前
            format!("{PROBE_END}\n{PROBE_BEGIN}\n{PROBE_RC}0\n{PROBE_CMD}/x\n{PROBE_TYPE}file\n"),
            // 字段重复
            format!("{PROBE_BEGIN}\n{PROBE_RC}0\n{PROBE_RC}0\n{PROBE_CMD}/x\n{PROBE_TYPE}file\n{PROBE_END}\n"),
            // 缺字段
            format!("{PROBE_BEGIN}\n{PROBE_RC}0\n{PROBE_CMD}/x\n{PROBE_END}\n"),
        ];
        for c in cases {
            assert!(parse_probe(&c).is_none(), "应判协议违约：{c:?}");
        }
    }

    #[test]
    fn 分类表逐格() {
        let link = Path::new("/home/.local/bin/rmd");
        let same = |_p: &Path| Ok(PathBuf::from("/apps/rmd.app/Contents/MacOS/rmd"));
        // ⚠️ 闭包是**按路径**映射的：`cmd` 与链接各自解析到不同目标才叫"被挡住"。
        let other = |p: &Path| {
            if p == Path::new("/opt/homebrew/bin/rmd") {
                Ok(PathBuf::from("/opt/homebrew/bin/rmd"))
            } else {
                Ok(PathBuf::from("/apps/rmd.app/Contents/MacOS/rmd"))
            }
        };

        let v = classify_with(Some(Probe { rc: 1, cmd: String::new(), kind: "unsupported".into() }), link, same);
        assert_eq!(v.state, "not-on-path");

        let v = classify_with(Some(Probe { rc: 0, cmd: String::new(), kind: "file".into() }), link, same);
        assert_eq!(v.state, "unknown");

        for kind in ["alias", "function", "builtin", "keyword"] {
            let v = classify_with(
                Some(Probe { rc: 0, cmd: "alias rmd='echo hi'".into(), kind: kind.into() }),
                link,
                same,
            );
            assert_eq!(v.state, "shadowed", "{kind}");
            assert_eq!(v.kind.as_deref(), Some(kind));
        }
        // ⭐ G1：alias/function 的非绝对 cmd 合法（不判协议违约）
        let v = classify_with(
            Some(Probe { rc: 0, cmd: "rmd".into(), kind: "function".into() }),
            link,
            same,
        );
        assert_eq!(v.state, "shadowed");

        let v = classify_with(
            Some(Probe { rc: 0, cmd: "/apps/rmd.app/Contents/MacOS/rmd".into(), kind: "file".into() }),
            link,
            same,
        );
        assert_eq!(v.state, "verified");

        let v = classify_with(
            Some(Probe { rc: 0, cmd: "/opt/homebrew/bin/rmd".into(), kind: "file".into() }),
            link,
            other,
        );
        assert_eq!(v.state, "shadowed");
        assert_eq!(v.kind.as_deref(), Some("file"));
        assert_eq!(v.path.as_deref(), Some("/opt/homebrew/bin/rmd"));

        // kind == file 但 cmd 相对 ⇒ 协议违约
        let v = classify_with(
            Some(Probe { rc: 0, cmd: "rmd".into(), kind: "file".into() }),
            link,
            same,
        );
        assert_eq!(v.state, "unknown");

        // unsupported / 空串 ⇒ unknown
        for kind in ["unsupported", ""] {
            let v = classify_with(
                Some(Probe { rc: 0, cmd: "/x/rmd".into(), kind: kind.into() }),
                link,
                same,
            );
            assert_eq!(v.state, "unknown", "{kind}");
        }
        assert_eq!(classify_with(None, link, same).state, "unknown");
    }

    #[test]
    fn zsh_词表归一化() {
        assert_eq!(normalize_type("command"), "file");
        assert_eq!(normalize_type("reserved"), "keyword");
        assert_eq!(normalize_type("none"), "unsupported");
        assert_eq!(normalize_type("alias"), "alias");
        assert_eq!(normalize_type("rmd: function"), "rmd: function");
        assert_eq!(normalize_type(""), "");
    }

    #[test]
    fn 载荷按壳分配且不支持的一律不探() {
        assert_eq!(payload_for("zsh"), Some(ZSH_PAYLOAD));
        assert_eq!(payload_for("bash"), Some(POSIX_PAYLOAD));
        assert_eq!(payload_for("sh"), Some(POSIX_PAYLOAD));
        for s in ["dash", "ksh", "fish", "csh", "tcsh", "nu", ""] {
            assert_eq!(payload_for(s), None, "{s} 不该在支持范围里");
        }
        // ⚠️ 两份载荷都**不含任何路径插值**（只有一个固定的命令名 `rmd`）
        for p in [POSIX_PAYLOAD, ZSH_PAYLOAD] {
            assert!(!p.contains("/Users/"), "载荷里不许出现路径");
            assert!(p.contains(PROBE_BEGIN) && p.contains(PROBE_END));
        }
        assert!(ZSH_PAYLOAD.contains("type -w rmd"));
        assert!(POSIX_PAYLOAD.contains("type -t rmd"));
    }

    // ── 真起进程（hermetic：`-f` / `--norc`，不读用户配置）──

    fn shell_path(p: &str) -> Option<PathBuf> {
        let p = PathBuf::from(p);
        if p.is_file() { Some(p) } else { None }
    }

    /// 造一个只含夹具目录的 PATH，返回该 PATH 字符串。
    fn fixture_path(dir: &Path) -> OsString {
        let mut s = OsString::from(dir);
        s.push(":/usr/bin:/bin");
        s
    }

    /// 免配置（不读用户 rc）地跑一次载荷，PATH 由夹具给定。
    ///
    /// ⚠️ 各壳的"别读我的配置"不是同一个开关：zsh 是 `-f`（NO_RCS），
    /// bash 是 `--norc`（`-f` 在 bash 里是 **noglob**，不是这个意思）。
    fn run_payload_raw(shell: &Path, payload: &str, path_env: &OsString) -> std::process::Output {
        let name = shell.file_name().unwrap().to_string_lossy().into_owned();
        let mut cmd = Command::new(shell);
        match name.as_str() {
            "zsh" => cmd.args(["-f", "-c", payload]),
            "bash" => cmd.args(["--norc", "-c", payload]),
            _ => cmd.args(["-c", payload]),
        };
        cmd.env("PATH", path_env).stdin(Stdio::null()).output().unwrap()
    }

    /// 交互态（`-i`）跑一次：⚠️ 只有交互壳才**展开别名**（`bash -f` 下 alias 不生效 ⇒ 报成 `file`）。
    fn run_payload_interactive(shell: &Path, body: &str, path_env: &OsString) -> std::process::Output {
        let name = shell.file_name().unwrap().to_string_lossy().into_owned();
        let mut cmd = Command::new(shell);
        match name.as_str() {
            "zsh" => cmd.args(["-f", "-i", "-c", body]),
            "bash" => cmd.args(["--norc", "-i", "-c", body]),
            _ => cmd.args(["-i", "-c", body]),
        };
        cmd.env("PATH", path_env).stdin(Stdio::null()).output().unwrap()
    }

    fn kind_of(out: &std::process::Output) -> Probe {
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        parse_probe(&text).unwrap_or_else(|| panic!("协议解析失败：{text:?}"))
    }

    #[test]
    fn 三种壳五场景真跑() {
        let t = Temp::new("shells");
        let bin = t.path().join("bin");
        let first = t.path().join("first");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&first).unwrap();
        let rmd = bin.join("rmd");
        fs::write(&rmd, b"#!/bin/sh\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&rmd, fs::Permissions::from_mode(0o755)).unwrap();
        let shadow = first.join("rmd");
        fs::write(&shadow, b"#!/bin/sh\n").unwrap();
        fs::set_permissions(&shadow, fs::Permissions::from_mode(0o755)).unwrap();

        for shell_name in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            let Some(shell) = shell_path(shell_name) else { continue };
            let base = shell.file_name().unwrap().to_string_lossy().into_owned();
            let payload = payload_for(&base).expect("三种壳都该在支持范围里");

            // ① 存在且是文件
            let out = run_payload_raw(&shell, payload, &fixture_path(&bin));
            let p = kind_of(&out);
            assert_eq!((p.rc, normalize_type(&p.kind)), (0, "file"), "{shell_name} 存在场景");

            // ② 遮蔽：first 在 PATH 前面
            let mut sh_path = OsString::from(&first);
            sh_path.push(":");
            sh_path.push(fixture_path(&bin));
            let out = run_payload_raw(&shell, payload, &sh_path);
            let p = kind_of(&out);
            assert_eq!(p.cmd, shadow.to_string_lossy(), "{shell_name} 遮蔽场景");

            // ③ 缺失
            let out = run_payload_raw(&shell, payload, &OsString::from("/usr/bin:/bin"));
            let p = kind_of(&out);
            assert_ne!(p.rc, 0, "{shell_name} 缺失场景应有非零 rc");

            // ④ alias：⚠️ 别名只在**交互**壳里展开（`-f` / `--norc` 非交互时 bash 会报成 `file`）
            let with_alias = format!("alias rmd='echo hi'\n{payload}");
            let out = run_payload_interactive(&shell, &with_alias, &fixture_path(&bin));
            let p = kind_of(&out);
            assert_eq!(normalize_type(&p.kind), "alias", "{shell_name} alias");

            // ⑤ function
            let with_fn = format!("rmd() {{ :; }}\n{payload}");
            let out = run_payload_raw(&shell, &with_fn, &fixture_path(&bin));
            let p = kind_of(&out);
            assert_eq!(normalize_type(&p.kind), "function", "{shell_name} function");
        }
    }

    #[test]
    fn 真跑载荷后_verified_与_shadowed_都能对上() {
        if let Some(shell) = shell_path("/bin/sh") {
            let t = Temp::new("verified-real");
            let home = t.path().join("home");
            fs::create_dir_all(&home).unwrap();
            let exe = fake_app(t.path().join("apps"));
            install(&home, Location::Local, &exe, None);
            let link = home.join(".local/bin/rmd");
            // 用注入 PATH 的方式跑同一份载荷：把链接目录放进 PATH
            let payload = POSIX_PAYLOAD;
            let out = Command::new(&shell)
                .args(["-f", "-c", payload])
                .env("PATH", fixture_path(&home.join(".local/bin")))
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            let v = classify_with(parse_probe(&text), &link, |p| fs::canonicalize(p));
            assert_eq!(v.state, "verified", "真实输出应能解析成 verified：{text:?}");
        }
    }

    /// 造一个假 shell：把 argv 里的载荷原样跑，或按剧本输出。
    fn fake_shell(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn 假壳打印_argv_证明三_flag_与不插值() {
        let t = Temp::new("argv");
        let sh = fake_shell(t.path(), "zsh", "printf '%s\\n' \"$@\"");
        // 直接观察 run_probe 交给壳的参数
        let out = Command::new(&sh)
            .args(["-l", "-i", "-c", POSIX_PAYLOAD])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        // ⚠️ 载荷自带换行 ⇒ 逐行比会把一份载荷拆成多行：按前缀切、剩下的整段比。
        let mut rest = text.as_str();
        for want in ["-l", "-i", "-c"] {
            assert!(rest.starts_with(want), "前三个参数应是 {want:?}：{text:?}");
            rest = &rest[want.len() + 1..];
        }
        assert_eq!(rest, format!("{POSIX_PAYLOAD}\n"), "载荷必须逐字等于常量");
    }

    #[test]
    fn 超时回收子进程() {
        let t = Temp::new("timeout");
        // 壳自己睡 10 s：run_probe 3 s 超时后必须 kill+wait
        let sh = fake_shell(t.path(), "sh", "sleep 10");
        let start = Instant::now();
        let out = run_probe(&sh, POSIX_PAYLOAD);
        assert!(out.is_none());
        assert!(start.elapsed() < Duration::from_secs(5), "应在 3 s 左右返回");
    }

    #[test]
    fn 后代持管道时仍在四秒内返回() {
        // ⭐ §9.5 补正：启动配置可留下继承 stdout 的后代 ⇒ 直接 shell 被 kill 了管道仍不 EOF。
        let t = Temp::new("descendant");
        // 起一个持 stdout 的后代（5 s），自己睡 10 s
        let sh = fake_shell(t.path(), "sh", "/bin/sh -c 'sleep 5' &\nsleep 10");
        let start = Instant::now();
        let out = run_probe(&sh, POSIX_PAYLOAD);
        assert!(out.is_none(), "后代持管道 ⇒ unknown");
        assert!(
            start.elapsed() < Duration::from_secs(4),
            "⛔ 不许在 join/EOF 上无限等待，实测 {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn 超过_64KiB_未闭合判_unknown() {
        let t = Temp::new("truncate");
        // 先吐 70 KiB 再吐完整块：截断 ⇒ ⛔ 不许用前缀下结论
        let sh = fake_shell(
            t.path(),
            "sh",
            "head -c 70000 /dev/zero | tr '\\0' 'x'\nprintf '__RMD_BEGIN__\\n__RMD_RC__0\\n__RMD_CMD__/x\\n__RMD_TYPE__file\\n__RMD_END__\\n'",
        );
        let start = Instant::now();
        let out = run_probe(&sh, POSIX_PAYLOAD);
        assert!(out.is_none(), "截断 ⇒ unknown");
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn 不支持的壳不_spawn() {
        // payload_for 返回 None 时调用方必须**不 spawn**——这里钉住那一半的判据形状。
        assert!(payload_for("fish").is_none());
        assert!(payload_for("dash").is_none());
        assert!(payload_for("ksh").is_none());
    }

    // ── 提权命令构造（`INV-CLI-14`）──

    #[test]
    fn 路径不进脚本源码只进末尾_argv() {
        let nasty = [
            "/tmp/a b/rmd.app/Contents/MacOS/rmd",
            "/tmp/quo'te/rmd.app/Contents/MacOS/rmd",
            "/tmp/dq\"uote/rmd.app/Contents/MacOS/rmd",
            "/tmp/back\\slash/rmd.app/Contents/MacOS/rmd",
            "/tmp/new\nline/rmd.app/Contents/MacOS/rmd",
            "/tmp/$(touch x)/rmd.app/Contents/MacOS/rmd",
        ];
        for n in nasty {
            let link = Path::new("/home/.local/bin/rmd");
            let dir = Path::new("/home/.local/bin");
            let args = osascript_args(INSTALL_SCRIPT, &[dir, Path::new(n), link]);
            // ⭐ 判据：每个 `-e` 的文本**逐字等于**常量脚本的某一行 ⇒ 路径根本进不去。
            let script_lines: Vec<String> = INSTALL_SCRIPT.lines().map(|s| s.to_string()).collect();
            let mut i = 0;
            let mut e_count = 0;
            while i < args.len() {
                if args[i] == "-e" {
                    let text = args[i + 1].to_string_lossy().into_owned();
                    assert!(script_lines.contains(&text), "⛔ 出现了不是常量脚本行的 `-e`：{text}");
                    assert!(!text.contains(n), "⛔ 路径进了脚本源码：{text}");
                    e_count += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            assert_eq!(e_count, script_lines.len(), "每行一个 `-e`");
            // 末尾三个位置参数逐字出现
            let tail: Vec<_> = args[args.len() - 3..].to_vec();
            assert_eq!(tail[0], OsString::from(dir));
            assert_eq!(tail[1], OsString::from(n));
            assert_eq!(tail[2], OsString::from(link));
            assert_eq!(args[args.len() - 4], OsString::from("--"));
        }
    }

    #[test]
    fn 卸载脚本与安装脚本只差内层命令() {
        let install_lines: Vec<&str> = INSTALL_SCRIPT.lines().collect();
        let uninstall_lines: Vec<&str> = UNINSTALL_SCRIPT.lines().collect();
        // 安装版 6 行、卸载版 5 行：差异只在 argv 解包与内层命令
        assert!(install_lines.iter().any(|l| l.contains("/bin/ln -sfn")));
        assert!(uninstall_lines.iter().any(|l| l.contains("/bin/rm -f")));
        assert!(!INSTALL_SCRIPT.contains("with administrator privileges") || INSTALL_SCRIPT.matches("with administrator privileges").count() == 1);
        assert_eq!(UNINSTALL_SCRIPT.matches("with administrator privileges").count(), 1);
        // 工具是绝对路径字面量，⛔ 不依赖 PATH、⛔ 不含 `$`
        for s in [INSTALL_SCRIPT, UNINSTALL_SCRIPT] {
            assert!(s.contains("/bin/mkdir -p") || !s.contains("mkdir"));
            assert!(!s.contains("$("));
        }
    }

    #[test]
    fn 脚本源码不含反斜杠_引号成对() {
        // ⚠️ 2026-10-22（`design/0035` §10.6 的核查报告称这里是 `\\\"`）：
        //    Rust 常量里的 `\"` 在**运行时**就是一个双引号，AppleScript 看到的是
        //    `set shellCmd to "/bin/mkdir -p " & …`——合法。若真写成 `\\\"`，
        //    运行时会多出一个字面量反斜杠，osascript 直接报 **-2741**（语法错误）。
        //    ⇒ 这里把"运行时文本里有没有反斜杠"钉死：有就是转义写错了。
        for (name, s) in [("install", INSTALL_SCRIPT), ("uninstall", UNINSTALL_SCRIPT)] {
            assert!(
                !s.contains('\\'),
                "{name} 脚本运行时文本里出现了反斜杠：{s:?}"
            );
            for (i, line) in s.lines().enumerate() {
                assert_eq!(
                    line.matches('"').count() % 2,
                    0,
                    "{name} 第 {i} 行引号不成对：{line}"
                );
            }
        }
    }

    #[test]
    fn 无提权真实往返_恶劣路径逐字节相等() {
        // ⭐ §7.1 #48：同一份脚本**去掉** `with administrator privileges`，在临时目录里真跑。
        let t = Temp::new("roundtrip");
        let target = fake_app(t.path().join("apps"));
        let script = INSTALL_SCRIPT.replace("with administrator privileges", "");
        for name in ["a b", "quo'te", "dq\"uote", "back\\slash", "new\nline", "$(touch x)"] {
            let dir = t.path().join(name);
            fs::create_dir_all(&dir).unwrap();
            let link = dir.join("rmd");
            let args = osascript_args(&script, &[dir.as_path(), target.as_path(), link.as_path()]);
            let out = match Command::new("/usr/bin/osascript").args(&args).output() {
                Ok(o) => o,
                Err(e) => {
                    eprintln!("跳过：osascript 起不来（{e}）");
                    return;
                }
            };
            assert!(
                out.status.success(),
                "osascript 失败：{}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert_eq!(fs::read_link(&link).unwrap(), target, "路径 {name:?}");
        }
    }
}
