//! 本机日志与 Rust panic 记录（`docs/design/0016-日志与崩溃诊断.md`）。
//!
//! ⭐ **为什么自写**：`0.2.0` 起应用走 `open -g` **后台启动**，fd 2 不在终端里 ⇒
//! 原来的 `eprintln!` 全部不可见。本期补一份落到 `~/Library/Logs/<identifier>/` 的
//! 文本日志。⛔ **零新增依赖、零新增命令**（`INV-LOG-10`）。
//!
//! ⚠️⚠️ **本文件最重要的一条纪律：日志文件里不许出现任何"任意文本"**
//! （文档正文、搜索词、错误原文、`summary`/`sample`、panic 消息、各类 note）。
//! 落盘面按**字段是否可信**划分（`INV-LOG-01/11`）：
//!
//! | 宏 | stderr | 文件 | 用在什么上 |
//! |---|---|---|---|
//! | [`diag!`] | ✅ | ✅ | **可信**字段：固定文案、数字、枚举、路径、pid、seq、耗时 |
//! | [`diag_stderr!`] | ✅ | ⛔ | **不可信**文本：`{e}`、stack、summary、sample、搜索词、note |
//! | [`diag_file!`] | ⛔ | ✅ | 同一事实的**结构化**字段（原文已由 `diag_stderr!` 报过） |
//!
//! ⚠️ 改调用点时**逐条对照**上表，⛔ 不要图省事把 `{e}` 塞进 `diag!`：
//! serde 的错误消息会引用**输入原文**，一次解析失败就能把正文带进日志。
//!
//! ## 跨进程单写者
//!
//! 所有实例共用 `<日志目录>/rmd.log`。写一行的顺序是
//! **取目录锁 → 打开 → 必要时轮转 → 写 → 关 → 放锁**（`INV-LOG-12`）：
//! - ⛔ **不长期持有文件句柄**——否则 A 轮转后，B 手里的旧句柄仍指向被改名/删除的 inode，
//!   后续诊断会写进"没人看得见"的文件（`design/0016` §2.1 ① 第 3 条）；
//! - 锁用 `fs::create_dir` 的原子性实现（std 没有跨进程文件锁，⛔ 不引 `libc`）；
//! - 取锁有界（20 × 2 ms = 40 ms），失败 ⇒ 本条只写 stderr；
//! - 陈旧锁（mtime > 5 s）才允许清除——正常持锁只有一次本地写；
//! - **轮转失败 ⇒ 本进程停止文件写入**（只留 stderr），⛔ 不继续追加
//!   （否则"空间有界"与"失败也能写"互相矛盾，`INV-LOG-05`）。
//!
//! ## 失败一律 fail-open
//!
//! 建不了目录 / 取锁超时 / 打开失败 / 写失败 / 轮转失败都**不改变应用行为**、
//! 不 panic、不阻塞启动（`INV-LOG-02`）。初始化失败后本模块只写 stderr。

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 单个日志文件的上限（所有实例共用这一对文件，`INV-LOG-05`）。
pub const FILE_CAP_BYTES: u64 = 2 * 1024 * 1024;
/// 单条记录上限：超出就截断并留标记（`INV-LOG-05`）。
pub const MAX_RECORD_BYTES: usize = 8 * 1024;
/// 取锁的上限：20 次 × 2 ms。
const LOCK_TRIES: u32 = 20;
const LOCK_SLEEP: Duration = Duration::from_millis(2);
/// 陈旧锁的判据：正常持锁只有一次本地写（微秒级）。
const STALE_LOCK: Duration = Duration::from_secs(5);
const LOCK_NAME: &str = "rmd.log.lock";
const LOG_NAME: &str = "rmd.log";
const LOG_PREV_NAME: &str = "rmd.log.1";

// —— 全局 sink ——

static SINK: OnceLock<Sink> = OnceLock::new();

/// 一个日志目录。⚠️ 测试直接构造它（带独立临时目录与更小的上限），**不调** [`init`]。
pub struct Sink {
    dir: PathBuf,
    cap: u64,
    /// 轮转/写盘失败后置位：本进程此后只写 stderr（`INV-LOG-05`）。
    disabled: AtomicBool,
    /// stderr 的"只提示一次"标记（取锁超时 / 轮转失败 / 写失败共用）。
    warned: AtomicBool,
}

impl Sink {
    /// 建目录并返回一个 sink。⚠️ 目录建不了就返回 `Err`，调用方据此放弃文件侧。
    pub fn new(dir: PathBuf, cap: u64) -> io::Result<Sink> {
        fs::create_dir_all(&dir)?;
        Ok(Sink {
            dir,
            cap,
            disabled: AtomicBool::new(false),
            warned: AtomicBool::new(false),
        })
    }

    /// 写一条（可多行）消息到文件。⛔ 不碰 stderr。
    pub fn write_message(&self, msg: &str) {
        let clean = msg.replace('\r', "");
        let mut any = false;
        for line in clean.split('\n') {
            if line.is_empty() {
                continue;
            }
            self.append_one(line);
            any = true;
        }
        if !any {
            self.append_one("");
        }
    }

    fn append_one(&self, body: &str) {
        if self.disabled.load(Ordering::Relaxed) {
            return;
        }
        let _lock = match acquire(&self.dir, STALE_LOCK) {
            Some(g) => g,
            None => {
                self.warn_once("取锁超时（40 ms）");
                return;
            }
        };
        // ⚠️ 拿到锁后再看一眼：别的线程可能刚才已经把本进程停写了。
        if self.disabled.load(Ordering::Relaxed) {
            return;
        }

        let prefix = format!("{} [{}] ", format_time(SystemTime::now()), std::process::id());
        let body = truncate_record(prefix.len(), body);
        let mut line = prefix;
        line.push_str(&body);
        line.push('\n');

        let log = self.dir.join(LOG_NAME);
        let mut f = match OpenOptions::new().create(true).append(true).open(&log) {
            Ok(f) => f,
            Err(e) => return self.fail(&e),
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if should_rotate(len, line.len(), self.cap) {
            drop(f);
            if let Err(e) = rotate(&self.dir) {
                return self.fail(&e);
            }
            f = match OpenOptions::new().create(true).append(true).open(&log) {
                Ok(f) => f,
                Err(e) => return self.fail(&e),
            };
        }
        if let Err(e) = f.write_all(line.as_bytes()).and_then(|_| f.flush()) {
            self.fail(&e);
        }
    }

    fn fail(&self, e: &io::Error) {
        // ⭐ 先置位：即使下面的提示写不出来，后续也不会再尝试落盘。
        if !self.disabled.swap(true, Ordering::Relaxed) {
            eprintln!("⚠️ 日志落盘失败，本进程后续只写 stderr：{e}");
        }
    }

    fn warn_once(&self, what: &str) {
        if !self.warned.swap(true, Ordering::Relaxed) {
            eprintln!("⚠️ 日志{what}，这一条只写 stderr");
        }
    }
}

/// 初始化日志目录。**每个进程只调用一次**（`INV-LOG-07`）。
///
/// ⚠️ 失败不是错误状态：调用方忽略返回值即可，本模块随后只写 stderr。
pub fn init(dir: &Path) -> io::Result<()> {
    let sink = Sink::new(dir.to_path_buf(), FILE_CAP_BYTES)?;
    // 第二个调用者拿不到 —— `OnceLock` 保证只装一次。失败不算错误（已经装过了）。
    let _ = SINK.set(sink);
    Ok(())
}

/// 当前日志目录（未初始化时为 `None`）。`make doctor` 与启动自证用。
pub fn dir() -> Option<PathBuf> {
    SINK.get().map(|s| s.dir.clone())
}

/// 写 stderr ＋ 文件。**只用于可信字段**（见模块头的表）。
pub fn emit(msg: &str) {
    if let Some(s) = SINK.get() {
        s.write_message(msg); // ⭐ 先文件后 stderr：崩溃前最后一行的落盘机会更大
    }
    eprintln!("{msg}");
}

/// 只写文件（同一事实的原文已经由 [`diag_stderr!`] 报过）。
pub fn emit_file_only(msg: &str) {
    if let Some(s) = SINK.get() {
        s.write_message(msg);
    }
}

/// 安装 panic hook：**链式保留**默认 hook，文件里只留元数据（`INV-LOG-09`）。
///
/// ⛔ 不写 panic 消息/payload/backtrace——它们是任意文本，可能就是正在解析的文档片段。
/// 原始消息照旧由默认 hook 打到 stderr（终端行为逐字不变）。
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current()
            .name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unnamed".to_string());
        let at = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        emit_file_only(&panic_line(&thread, &at, payload_len(info)));
        prev(info);
    }));
}

fn payload_len(info: &std::panic::PanicHookInfo<'_>) -> usize {
    let p = info.payload();
    if let Some(s) = p.downcast_ref::<&str>() {
        s.len()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.len()
    } else {
        0
    }
}

/// panic 那一行的纯函数形式（单测直接断言它不含消息内容）。
pub fn panic_line(thread: &str, at: &str, msg_len: usize) -> String {
    format!("PANIC thread={thread} at={at} msg_len={msg_len}")
}

/// 错误分类：**只看类型，⛔ 不调用 `Display`**（`INV-LOG-11`）。
pub fn err_class(e: &(dyn std::error::Error + 'static)) -> &'static str {
    if e.downcast_ref::<io::Error>().is_some() {
        return "io";
    }
    if e.downcast_ref::<serde_json::Error>().is_some() {
        return "serde";
    }
    #[cfg(feature = "gui")]
    if e.downcast_ref::<tauri::Error>().is_some() {
        return "tauri";
    }
    "other"
}

/// `app_log_dir()` 在 macOS 的值：`$HOME/Library/Logs/<identifier>`（`docs/kb/0024`）。
/// ⚠️ 这里**自己推导**，因为初始化发生在 `tauri::Builder` **之前**（`Context::config()` 可用，
/// 但那需要 `tauri` feature；CLI 构建里不该为了一条日志路径链进 Tauri）。
pub fn default_dir(identifier: &str) -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join("Library")
            .join("Logs")
            .join(identifier)
    })
}

/// 从可执行文件向上两级找 `Contents/Resources/build-id.txt`（`design/0015` 的产物布局）。
/// 裸二进制（`~/.local/bin/rmd`）找不到就返回 `None`。
pub fn build_id_for_exe(exe: &Path) -> Option<String> {
    let contents = exe.parent()?.parent()?;
    let p = contents.join("Resources").join("build-id.txt");
    let s = fs::read_to_string(p).ok()?;
    let first = s.lines().next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

// —— 时间 ——

/// UTC RFC3339 ＋ 毫秒（`INV-LOG-08`）。⚠️ 日志内是 UTC；`make doctor` 按本机时区显示时
/// 必须标注，避免用户以为差了 8 小时（`design/0016` §2.1 ⑥）。
pub fn format_time(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let millis = d.subsec_millis();
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, dd) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        dd,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60,
        millis
    )
}

/// Howard Hinnant 的 `civil_from_days`（1970-01-01 起的天数 → 公历年月日）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

// —— 记录与轮转 ——

/// 写前判据：**等于**上限时不轮转（`design/0016` §6）。
fn should_rotate(len: u64, rec_len: usize, cap: u64) -> bool {
    len > 0 && len + rec_len as u64 > cap
}

/// 把一条记录截到 `MAX_RECORD_BYTES` 以内，末尾留 `…<截断 N 字节>`。
/// ⚠️ 按 **UTF-8 字符边界**截，⛔ 不留半个汉字。
fn truncate_record(prefix_len: usize, body: &str) -> String {
    let limit = MAX_RECORD_BYTES.saturating_sub(prefix_len);
    if body.len() <= limit {
        return body.to_string();
    }
    let mut kept = limit.saturating_sub(32);
    loop {
        let cut = floor_char_boundary(body, kept);
        let removed = body.len() - cut;
        let marker = format!("…<截断 {removed} 字节>");
        if cut + marker.len() <= limit {
            let mut out = String::with_capacity(cut + marker.len());
            out.push_str(&body[..cut]);
            out.push_str(&marker);
            return out;
        }
        if kept == 0 {
            return String::new();
        }
        kept = kept.saturating_sub(16);
    }
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// 轮转：`rmd.log` → `rmd.log.1`（覆盖旧的）。
fn rotate(dir: &Path) -> io::Result<()> {
    fs::rename(dir.join(LOG_NAME), dir.join(LOG_PREV_NAME))
}

// —— 目录锁 ——

struct LockGuard {
    path: PathBuf,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.path);
    }
}

fn acquire(dir: &Path, stale: Duration) -> Option<LockGuard> {
    acquire_with(dir, stale, std::thread::sleep)
}

/// ⚠️ `sleep` 注入**只为可断言**：CI runner 上 `sleep(2 ms)` 实测会睡到 10 ms 以上
/// （2026-10-23 首轮 GitHub Actions：20 次合计 **221.8 ms**）。墙钟在那个环境下量的是
/// **调度延迟**，不是本函数的界 ⇒ 判"尝试次数 × 名义等待"用注入的 sleeper，
/// "真的会返回、不会挂死"另用一条宽松的墙钟判据。
fn acquire_with(
    dir: &Path,
    stale: Duration,
    sleep: impl Fn(Duration),
) -> Option<LockGuard> {
    let path = dir.join(LOCK_NAME);
    for _ in 0..LOCK_TRIES {
        match fs::create_dir(&path) {
            Ok(()) => return Some(LockGuard { path }),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                sleep(LOCK_SLEEP);
            }
            Err(_) => return None,
        }
    }
    // 陈旧锁才允许清（`INV-LOG-12`）。⚠️ 只重试一次。
    let stale_now = fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| m.elapsed().ok())
        .map(|age| age > stale)
        .unwrap_or(false);
    if stale_now {
        let _ = fs::remove_dir(&path);
        if fs::create_dir(&path).is_ok() {
            return Some(LockGuard { path });
        }
    }
    None
}

// —— 三个宏（`design/0016` §2.1 ②）——

/// **可信字段**：固定文案、数字、枚举、路径、pid、seq、耗时。stderr ＋ 文件。
#[macro_export]
macro_rules! diag {
    ($($arg:tt)*) => {{
        $crate::logging::emit(&format!($($arg)*));
    }};
}

/// **不可信文本**：任意错误 `Display`、stack、summary、sample、搜索词、note。
/// ⛔ 只写 stderr（与旧 `eprintln!` 字节级一致），文件里一个字节都不留。
#[macro_export]
macro_rules! diag_stderr {
    ($($arg:tt)*) => {{
        eprintln!($($arg)*);
    }};
}

/// **可信的结构化字段**，且同一事实的原文已经由 [`diag_stderr!`] 报过 ⇒ 只补文件。
#[macro_export]
macro_rules! diag_file {
    ($($arg:tt)*) => {{
        $crate::logging::emit_file_only(&format!($($arg)*));
    }};
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as O};

    fn tmpdir(tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, O::Relaxed);
        let d = std::env::temp_dir().join(format!(
            "rmd-log-test-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn t(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn time_epoch() {
        assert_eq!(format_time(t(0)), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn time_known() {
        assert_eq!(format_time(t(1_700_000_000)), "2023-11-14T22:13:20.000Z");
    }

    #[test]
    fn time_leap_days() {
        assert_eq!(format_time(t(1_709_164_800)), "2024-02-29T00:00:00.000Z");
        assert_eq!(format_time(t(951_782_400)), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn time_millis() {
        let t = UNIX_EPOCH + Duration::from_millis(1_700_000_000_123);
        assert_eq!(format_time(t), "2023-11-14T22:13:20.123Z");
    }

    #[test]
    fn default_dir_shape() {
        let d = default_dir("io.github.kumustone.rmd").unwrap();
        assert!(d.ends_with("Library/Logs/io.github.kumustone.rmd"), "{d:?}");
    }

    #[test]
    fn build_id_layout() {
        let root = tmpdir("buildid");
        let exe = root.join("rmd.app/Contents/MacOS/rmd");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::create_dir_all(root.join("rmd.app/Contents/Resources")).unwrap();
        fs::write(root.join("rmd.app/Contents/Resources/build-id.txt"), "abc\n").unwrap();
        assert_eq!(build_id_for_exe(&exe).as_deref(), Some("abc"));
        // 裸二进制：向上两级没有 Resources/build-id.txt
        let bare = root.join("bin/rmd");
        fs::create_dir_all(bare.parent().unwrap()).unwrap();
        fs::write(&bare, b"x").unwrap();
        assert_eq!(build_id_for_exe(&bare), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn writes_prefix_and_pid() {
        let d = tmpdir("prefix");
        let s = Sink::new(d.clone(), FILE_CAP_BYTES).unwrap();
        s.write_message("hello");
        let body = fs::read_to_string(d.join(LOG_NAME)).unwrap();
        let line = body.lines().next().unwrap();
        assert!(line.ends_with(&format!("[{}] hello", std::process::id())), "{line}");
        assert!(line.ends_with("Z") == false);
        assert!(line.contains("T"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn multiline_split_and_cr_removed() {
        let d = tmpdir("multi");
        let s = Sink::new(d.clone(), FILE_CAP_BYTES).unwrap();
        s.write_message("a\r\nb\nc");
        let body = fs::read_to_string(d.join(LOG_NAME)).unwrap();
        let lines: Vec<_> = body.lines().collect();
        assert_eq!(lines.len(), 3, "{body:?}");
        assert!(lines[0].ends_with("a"));
        assert!(lines[1].ends_with("b"));
        assert!(lines[2].ends_with("c"));
        assert!(!body.contains('\r'));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn rotation_keeps_one_prev() {
        let d = tmpdir("rotate");
        // 上限设得很小，方便在几行内触发轮转。
        let s = Sink::new(d.clone(), 200).unwrap();
        for i in 0..10 {
            s.write_message(&format!("line-{i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
        }
        let prev = d.join(LOG_PREV_NAME);
        assert!(prev.exists(), "应出现 rmd.log.1");
        // 再写很多，`.1` 仍只有一个（rename 覆盖），且当前文件 ≤ 上限
        for i in 0..10 {
            s.write_message(&format!("again-{i}-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"));
        }
        assert!(prev.exists());
        let all: Vec<_> = fs::read_dir(&d)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("rmd.log.1"))
            .collect();
        assert_eq!(all.len(), 1, "{all:?}");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn rotation_boundary_is_exact() {
        assert!(!should_rotate(100, 100, 200), "等于上限时不轮转");
        assert!(should_rotate(101, 100, 200));
        assert!(!should_rotate(0, 200, 200), "空文件第一条永远写得进去");
    }

    #[test]
    fn oversized_record_is_truncated() {
        let d = tmpdir("oversize");
        let s = Sink::new(d.clone(), FILE_CAP_BYTES).unwrap();
        let big = "汉".repeat(9 * 1024); // 27 KB
        s.write_message(&big);
        let body = fs::read_to_string(d.join(LOG_NAME)).unwrap();
        assert!(body.len() < MAX_RECORD_BYTES + 64, "{}", body.len());
        assert!(body.contains("…<截断 "), "末尾要有截断标记");
        // 截断处必须是合法 UTF-8（能读回来就说明没有半个字）
        assert!(body.chars().count() > 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn rotation_failure_stops_file_writes() {
        let d = tmpdir("rotfail");
        fs::create_dir_all(&d).unwrap();
        // 预先写一个超过上限的 rmd.log；再把 .1 做成"非空目录" ⇒ rename 必失败。
        fs::write(d.join(LOG_NAME), vec![b'x'; 400]).unwrap();
        fs::create_dir_all(d.join(LOG_PREV_NAME)).unwrap();
        fs::write(d.join(LOG_PREV_NAME).join("keep"), b"x").unwrap();
        let s = Sink::new(d.clone(), 200).unwrap();
        let before = fs::metadata(d.join(LOG_NAME)).unwrap().len();
        for i in 0..10 {
            s.write_message(&format!("after-failure-{i}"));
        }
        let after = fs::metadata(d.join(LOG_NAME)).unwrap().len();
        assert_eq!(before, after, "轮转失败后⛔ 不再追加");
        assert!(s.disabled.load(Ordering::Relaxed));
        let _ = fs::remove_dir_all(&d);
    }

    /// ⭐ **取锁预算是有限的**——判"尝试次数 × 名义等待"，⛔ 不判墙钟。
    ///
    /// 2026-10-23 首轮 GitHub Actions 把旧版本判红：那里 `sleep(2 ms)` 实测睡了
    /// 10 ms 以上，20 次合计 **221.8 ms**（> 旧的 100 ms 断言）。那是**调度延迟**，
    /// 不是本函数的界 ⇒ 判据改由注入的 sleeper 记账：尝试次数必须正好用完预算、
    /// 名义等待必须等于预算，且**小于 100 ms**。
    #[test]
    fn lock_timeout_is_bounded() {
        let d = tmpdir("locktimeout");
        fs::create_dir_all(&d).unwrap();
        fs::create_dir(d.join(LOCK_NAME)).unwrap(); // 新鲜锁：⛔ 不许清
        let attempts = std::cell::Cell::new(0u32);
        let waited = std::cell::Cell::new(Duration::ZERO);
        let got = acquire_with(&d, STALE_LOCK, |dt| {
            attempts.set(attempts.get() + 1);
            waited.set(waited.get() + dt);
        });
        assert!(got.is_none(), "新鲜锁必须在预算内放弃");
        assert_eq!(attempts.get(), LOCK_TRIES, "尝试次数就是预算");
        assert_eq!(waited.get(), LOCK_SLEEP * LOCK_TRIES, "名义等待 = 每次等待 × 次数");
        assert!(waited.get() < Duration::from_millis(100), "{:?}", waited.get());
        assert!(!d.join(LOG_NAME).exists(), "取锁超时不应创建/写文件");
        let _ = fs::remove_dir_all(&d);
    }

    /// 真实睡眠下只要求**会返回**（⛔ 再断言 100 ms：那量的是调度延迟）。
    /// 这一条钉的是"别把预算是写成无界循环"——5 s 是宽松上限，不是性能指标。
    #[test]
    fn lock_timeout_returns_under_load() {
        let d = tmpdir("locktimeout-real");
        fs::create_dir_all(&d).unwrap();
        fs::create_dir(d.join(LOCK_NAME)).unwrap();
        let s = Sink::new(d.clone(), FILE_CAP_BYTES).unwrap();
        let t0 = std::time::Instant::now();
        s.write_message("blocked");
        let dt = t0.elapsed();
        assert!(dt < Duration::from_secs(5), "{dt:?}");
        assert!(!d.join(LOG_NAME).exists(), "取锁超时不应创建/写文件");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn stale_lock_is_cleared() {
        let d = tmpdir("stalelock");
        fs::create_dir_all(&d).unwrap();
        fs::create_dir(d.join(LOCK_NAME)).unwrap();
        // ⚠️ 测试缝：把"陈旧"判据降到 0，⛔ 不靠睡 5 秒（也不去改目录 mtime）。
        let got = acquire(&d, Duration::ZERO);
        assert!(got.is_some(), "陈旧锁应被清除");
        drop(got);
        assert!(!d.join(LOCK_NAME).exists(), "Drop 要放锁");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn init_failure_is_quiet() {
        let d = tmpdir("initfail");
        fs::create_dir_all(&d).unwrap();
        let file = d.join("not-a-dir");
        fs::write(&file, b"x").unwrap();
        assert!(init(&file).is_err());
        // 之后 emit 不 panic（SINK 可能未装，也只写 stderr）
        emit("after failed init");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn panic_line_has_no_message() {
        let s = panic_line("main", "src/x.rs:1:2", 42);
        assert_eq!(s, "PANIC thread=main at=src/x.rs:1:2 msg_len=42");
        assert!(!s.contains("SENTINEL"));
    }

    struct SentinelDisplay;
    impl std::fmt::Debug for SentinelDisplay {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("sentinel")
        }
    }
    impl std::fmt::Display for SentinelDisplay {
        fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            panic!("err_class 调用了 Display —— 违反 INV-LOG-11")
        }
    }
    impl std::error::Error for SentinelDisplay {}

    #[test]
    fn err_class_never_displays() {
        assert_eq!(err_class(&SentinelDisplay), "other");
        let io_err = io::Error::new(io::ErrorKind::NotFound, "x");
        assert_eq!(err_class(&io_err), "io");
        let se = serde_json::from_str::<i32>("nope").unwrap_err();
        assert_eq!(err_class(&se), "serde");
    }

    #[test]
    fn truncate_respects_char_boundary() {
        let body = "汉".repeat(4000); // 12 KB
        let out = truncate_record(40, &body);
        assert!(40 + out.len() <= MAX_RECORD_BYTES);
        assert!(out.ends_with("字节>"));
        // 能拼回合法字符串即说明按字符边界截断
        assert!(out.chars().all(|c| c != '\u{FFFD}'));
    }
}
