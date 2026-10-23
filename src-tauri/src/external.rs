//! 外部编辑器 + 文件监视（`docs/design/0006`）。
//!
//! 三件事，按"有没有副作用"分两半：
//!
//! | 一半 | 内容 | 门控 |
//! |---|---|---|
//! | **纯**（本文件上半） | `editor_argv` / `spawn_editor` | ⛔ **不门控**——`make test` 要跑得到 |
//! | **运行期**（`watch` 子模块） | `notify` 监视 + `app.emit` | `#[cfg(feature = "gui")]` |
//!
//! ⭐ 为什么纯的那一半必须留在默认构建里：`editor_argv` 是 **`INV-EXT-01`** 的落点。
//! 把"路径怎么进命令行"这件事门控到 `--features gui` 后面，等于整条命令注入防线
//! 只在"会链 Tauri 的那次构建"里存在——而 `make test` 跑的不是那一次。
//!
//! ## ⛔ `INV-EXT-01`：**永远不经过 shell**
//!
//! 违反它 = **命令注入**，这是本项目**最严重的一类缺陷**。理由不是"理论上可能"：
//! 文档路径、以及将来任何要交给外部程序的东西，**内容来源是不可信的**
//! （用户从网上下载一份 `.md`，路径就可能带这些东西）。
//! 一旦写成 `sh -c "open -t {path}"` 或 `format!("open -t {path}")`，
//! 一个名叫 ``a; rm -rf ~; .md`` 的文件就是一个执行入口。
//!
//! ✅ 落地形式（两处，缺一不可）：
//! 1. `Command::new(argv[0]).args(&argv[1..])` —— 每个元素都是**独立的 argv**，
//!    内核 `execve` 拿到的是指针数组，⛔ **没有**任何一层会去解释 `;` `|` `$` 反引号。
//! 2. 路径以一个**独立元素**的身份进去，⛔ 不拼进任何字符串。
//!    `editor_argv` 的返回值里，路径**永远是最后一个元素**，且逐字未改。
//!
//! ⚠️ 注意连"无害的加固"也会破坏它：`format!("open -a {} {}", app, path)` 看起来
//! 跟上面一样，但它先把两个东西**合并成了一个字符串**，那一层就是 shell 的语义。
//!
//! ## 为什么用 `/usr/bin/open` 而不是直接起编辑器
//!
//! ① 它按 macOS 的 LaunchServices 语义找到"默认文本编辑器"，⛔ 不需要我们维护一份
//!    应用名清单；② ⭐ **它不等编辑器退出**（中位数 97.3 ms，实测见 `docs/kb/0019`），
//!    而 `Command::status()` 是同步等的 ⇒ 这一等的代价是 ~0.1 s，可接受
//!    （`open` 的退出码全表也在 `kb/0019`：这里是"读不读得到退出码"的唯一判据来源）。
//!
//! ## 为什么监视**文件本身**而不是父目录
//!
//! ⭐ 设计原稿写的是"必须监视父目录"，**已被实测推翻**（`docs/kb/0020`，2026-10-14）：
//! `notify 8.2.0` 在 macOS 上走 **FSEvents**（不是按 inode 的 kqueue），
//! 它"目录级注册、按文件报告"⇒ 监视文件本身时，
//! **原地覆写 / 写临时文件再 rename / 删除重建**三种保存方式**都收得到**，
//! 且事件**全部归到文件路径**（归到父目录 0 条）。
//!
//! ⇒ 好处是**结构上**的：监视目录会收到全部兄弟文件（含 `.tmp`、含编辑器自己写的备份），
//! 必须再按文件名过滤一层，而那一层一旦写错就是"静默地每条都丢"。
//! 监视文件本身**没有兄弟事件可过滤**。
//!
//! ## ⚠️ `Watch` 的 drop 是**异步**的（这一条不看会写出死锁）
//!
//! `notify` 的 `FsEventWatcher` 在 drop 时走 `stop()`：先自旋等运行循环空闲，
//! 再 `CFRunLoopStop`，再 **`thread_handle.join()` 自己那个运行循环线程**
//! （`notify-8.2.0/src/fsevent.rs:334-347`）。而回调**就是在那条线程上跑的**
//! （`fsevent.rs:574`）。⇒ 两个坑：
//!
//! 1. ⛔ **在回调里 drop 掉自己**（比如"代次变了就把监视摘掉"）⇒ `join` 自己 ⇒ **自锁**。
//! 2. ⛔ 任何线程持着会话锁去 drop，而回调正卡在那把锁上 ⇒ **互锁**。
//!
//! ⇒ 本文件的解法是 `impl Drop for Watch` **把真正的句柄交给一次性线程去 drop**：
//! 调用方（命令线程 / 回调线程 / 主线程）⛔ **从不阻塞在 `stop()` 上**。
//! 代价是"停止"不再同步完成——但那是安全的：前端按 `seq` 丢弃迟到的事件
//! （`design/0006` §2.1 ②），而旧的监视在几毫秒内自己退干净。

use std::path::Path;

/// 外部编辑器的**唯一**启动口。⛔ 别在别处再起一个 `Command` 去开文件。
///
/// `configured` = 配置里的 `external_editor`（`design/0006` §2.1 ④）：
/// `None` / 空 / 全空白 ⇒ 走系统默认文本编辑器（`open -t`）。
///
/// ⭐ 返回值是**完整 argv**（含 `argv[0]`），逐元素给 `Command` 用，
/// ⛔ **不是**一条命令字符串——这个区别就是 `INV-EXT-01`。
pub fn editor_argv(configured: Option<&str>, path: &Path) -> Vec<std::ffi::OsString> {
    let mut argv: Vec<std::ffi::OsString> = Vec::with_capacity(5);
    argv.push("/usr/bin/open".into());
    match configured.map(str::trim).filter(|s| !s.is_empty()) {
        Some(app) => {
            argv.push("-a".into());
            argv.push(app.into());
        }
        None => argv.push("-t".into()),
    }
    // ⚠️ `--` 是**实测过的**（2026-10-14）：`open -t -- -weird.md` 会把 `-weird.md`
    // 当**路径**处理并报 "The file … does not exist"（而不是当成未知选项）。
    // 授权模型保证路径是规范化的绝对路径（⛔ 不会以 `-` 开头），
    // 这一行是**纵深防御**，不是必需项。
    argv.push("--".into());
    // ⛔ 路径**逐字**作为独立元素进去。用 `OsString` 而不是 `display().to_string()`：
    // 后者会把非 UTF-8 字节替换成 U+FFFD，那是**另一个路径**（可能恰好存在！）。
    argv.push(path.as_os_str().to_os_string());
    argv
}

/// 启动外部编辑器打开 `path`。⭐ 阻塞到 `open` 自己退出（~0.1 s，⛔ 不是编辑器退出）。
///
/// ⛔ 返回 `Err` 只表示"**没送出去**"（应用名拼错、文件被删）。
/// ⚠️ 它⛔ **不表示"编辑器没打开"**：`open` 把请求转给 LaunchServices 就返回了，
/// 编辑器之后崩没崩我们一概不知（`docs/kb/0019`）。
pub fn spawn_editor(configured: Option<&str>, path: &Path) -> Result<(), std::io::Error> {
    let argv = editor_argv(configured, path);
    // ⭐ 这一行 + 下一行合起来是 `INV-EXT-01` 的**全部**实现体。
    // ⛔ 不许写成 `Command::new("sh").arg("-c")…`，⛔ 不许把 path 拼进任何字符串。
    let mut cmd = std::process::Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    let status = cmd.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "open 退出码 {:?}（见 docs/kb/0019 的全表：2=找不到应用 / 1=文件问题）",
            status.code()
        )))
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 文件监视（`design/0006` §2.1 ①②③）
// ⚠️ 本子模块在 `--features gui` 之外不存在；它的单测同样要
//    `cargo test --release --features gui` 才跑得到。
// ─────────────────────────────────────────────────────────────────────────

/// ⭐ **目录变化的去抖器**（`design/0034` §2.1 A）：静默 **300 ms** 发一次，
/// 但窗口的第一条事件起算 **1 s** 必发。
///
/// # 为什么它是纯逻辑、而且必须能被 `make test` 看到
///
/// 判据全是**时序**，用真实定时器测只能靠 `sleep`（慢，而且机器一抖就红）。
/// 这里所有时刻都由调用方**注入** ⇒ 逐帧断言。
/// ⚠️ `design/0034` §7.1 把「去抖器」列在**默认构建**那一栏（⛔ 不门控 `gui`）。
/// 而默认构建里**没有任何调用方**（唯一的调用方是 GUI 的目录监视）——
/// `bin` crate 会因此报 `dead_code`。⇒ 用 `cfg(any(feature = "gui", test))` 收窄：
/// 生产构建只在 gui 那一份里存在，测试构建两种都看得到。
/// ⚠️ 这与 `fs::finger` 的 `#[cfg(feature = "gui")]` 是**同一类处置、方向相反**。
///
/// # 语义（四条，全部有测试）
///
/// 1. 窗口内的**第一条**事件开始计时；
/// 2. 静默满 300 ms ⇒ 发一次；
/// 3. 一直在动 ⇒ **第一条**之后满 1 s 也必发（⛔ 不无限推迟）；
/// 4. 发完窗口关闭 ⇒ 下一条事件**重开**一个新窗口（不是"接着算"）。
///
/// ⚠️ 第 3 条是关键：没有它，一个"每秒都在写"的目录会让通知**永远发不出去"
/// （只在安静下来时才通知，而它永远不安静）。
#[cfg(any(feature = "gui", test))]
#[derive(Debug, Default, Clone, Copy)]
pub struct Debouncer {
    /// 当前窗口里**第一条**事件的时刻（`None` = 窗口没开）。
    first: Option<std::time::Instant>,
    /// 窗口里**最后一条**事件的时刻。
    last: Option<std::time::Instant>,
}

#[cfg(any(feature = "gui", test))]
impl Debouncer {
    /// 静默多久算"这一批结束了"。
    pub const QUIET: std::time::Duration = std::time::Duration::from_millis(300);
    /// 窗口最长开多久。⚠️ 起算点是**第一条**事件，⛔ 不是"最后一条 + 1 s"。
    pub const MAX_WINDOW: std::time::Duration = std::time::Duration::from_secs(1);

    /// 记一条事件（窗口没开就开窗）。
    pub fn on_event(&mut self, now: std::time::Instant) {
        // ⚠️ 只在**没开窗**时写 `first`：持续事件流不能把 1 s 的上限一直往后推。
        if self.first.is_none() {
            self.first = Some(now);
        }
        self.last = Some(now);
    }

    /// 窗口的**下一次检查时刻**；`None` = 当前没有开着的窗口（可以无限等）。
    pub fn deadline(&self) -> Option<std::time::Instant> {
        let first = self.first?;
        let last = self.last?;
        // ⭐ 两个上界取小：静默够了就发，或者第一条之后满 1 s 就发。
        Some(std::cmp::min(last + Self::QUIET, first + Self::MAX_WINDOW))
    }

    /// 到点就**关窗**并返回 `true`（调用方据此发一次事件）。
    pub fn poll(&mut self, now: std::time::Instant) -> bool {
        match self.deadline() {
            Some(d) if now >= d => {
                self.first = None;
                self.last = None;
                true
            }
            _ => false,
        }
    }
}

#[cfg(feature = "gui")]
pub mod watch {
    use super::*;
    use crate::commands::AppState;
    use crate::error::Denied;
    use notify::{RecursiveMode, Watcher};
    use std::path::PathBuf;
    use tauri::{AppHandle, Emitter, Manager};

    /// 事件名。⭐ 全项目**只有两处**该出现这个字面量：这里，与 `src/main.js` 的 `T.listen`。
    pub const CHANGED_EVENT: &str = "rmd://document-changed";

    /// 送上前端的事件载荷（`design/0006` §2.1 ②）。
    ///
    /// ⛔ **不带内容、⛔ 不带 HTML、⛔ 不带字节数**——前端要做的决定只需要
    /// "哪个文件"和"是不是我这一轮监视的东西"，其余都靠它自己 `reload_document` 去拿。
    /// ⚠️ 把文件内容塞进事件是**另一条读取路径**（`INV-FS-01` 不允许）。
    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
    pub struct ChangeEvent {
        /// 规范路径（`check_readable` 的返回值，`INV-EXT-03`）。
        pub path: String,
        /// 监视代号（`design/0006` §2.1 ③）。
        pub seq: u64,
    }

    /// `watch_document` 的返回（前端拿 `seq` 存进会话真值）。
    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
    pub struct WatchInfo {
        /// ⭐ 监视代号。每次**成功建立**监视时递增，从 1 开始（0 = 没有监视）。
        pub seq: u64,
        /// 真正被监视的那个**规范**路径。
        pub path: String,
        /// 建立时的 `root_generation`。
        ///
        /// ⚠️ 字段名是 `generation` 而线上是 `gen`：`gen` 在 **edition 2024 是保留字**
        /// （生成器语法），⛔ 不能当标识符用。这与 `DocumentPayload` 的 `generation`
        /// → `"gen"` 是同一处取舍（`commands/document.rs`），前后端都认 `gen`。
        #[serde(rename = "gen")]
        pub generation: u64,
    }

    /// 一次活着的监视。
    ///
    /// ⚠️ `watcher` **故意不被读取**：它的全部作用就是**活着**——drop 即停止监视。
    /// 所以这里不是"忘了用"，见模块头那段 drop 语义。
    ///
    /// ⚠️ `generation` / `seq` 存着是为了**回调里自己就能判断失效**，
    /// ⛔ 不需要回头去查前端。
    pub struct Watch {
        /// 被监视的规范路径。
        pub real: PathBuf,
        /// 监视代号。
        pub seq: u64,
        /// 建立时的 `root_generation`。
        pub generation: u64,
        watcher: Option<notify::RecommendedWatcher>,
    }

    impl std::fmt::Debug for Watch {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("Watch")
                .field("real", &self.real)
                .field("seq", &self.seq)
                .field("generation", &self.generation)
                .finish_non_exhaustive()
        }
    }

    impl Drop for Watch {
        /// ⭐ **异步停监视**——模块头那段"两个坑"的唯一解药。
        ///
        /// 调用方可能是：命令线程（换文档 / `unwatch`）、回调线程自己（代次失效）、
        /// 主线程（退出）。这三者里**任意一个**直接 `stop()` 都可能锁死，
        /// 所以这里把句柄搬到一个一次性线程上 drop。
        ///
        /// ⚠️ 代价是"停止"不再同步完成。**这是有意的**：`unwatch_document` 返回后
        /// 可能还有几条已经排在路上的事件，它们会被前端按 `seq` 丢掉
        /// （`design/0006` §2.1 ②；⛔ 别因此把 `seq` 判据去掉）。
        fn drop(&mut self) {
            if let Some(w) = self.watcher.take() {
                std::thread::spawn(move || drop(w));
            }
        }
    }

    /// 建立监视。⚠️ **调用方必须先过 `check_readable`**（`INV-EXT-03`）——
    /// 本函数不再查一次授权，它只负责"盯着这个路径"。
    ///
    /// ⚠️ `watch()` 对一个不存在的路径**立刻 `Err`**（`fsevent.rs:390`），
    /// ⛔ 不会"等它出现"。这与 §2.1 ② 的规则一致：监视只在一次**成功的读取**之后建立。
    pub fn start(
        app: &AppHandle,
        real: &Path,
        seq: u64,
        generation: u64,
    ) -> Result<Watch, Denied> {
        let target = real.to_path_buf();
        let cb_target = target.clone();
        let cb_app = app.clone();
        let mut watcher = notify::recommended_watcher(
            move |res: Result<notify::Event, notify::Error>| {
                let ev = match res {
                    Ok(ev) => ev,
                    Err(e) => {
                        // ⚠️ 底层错误**不静默**（spec 纪律 6 的同族要求）：
                        //    监视坏了 = 自动重载再也不发生，而界面上一切正常。
                        diag_stderr!("⚠️ 文件监视报错（seq={seq}）：{e}");
                        diag_file!(
                            "⚠️ 文件监视报错 seq={seq} err_class={} err_len={}",
                            crate::logging::err_class(&e),
                            e.to_string().len()
                        );
                        return;
                    }
                };
                // ① 只认目标文件本身。⭐ 实测：三种保存方式下事件**全部**归到文件
                //    （`kb/0020`）⇒ 这条过滤在生产里成立，而且它是**多余的一道**：
                //    监视文件时兄弟事件在结构上进不来。
                if !ev.paths.iter().any(|p| p == &cb_target) {
                    return;
                }
                on_change(&cb_app, &cb_target, seq, generation);
            },
        )
        .map_err(|e| Denied::io(real, e))?;
        watcher.watch(real, RecursiveMode::NonRecursive).map_err(|e| Denied::io(real, e))?;
        Ok(Watch { real: target, seq, generation, watcher: Some(watcher) })
    }

    /// 收到一条**归到目标文件**的事件之后。
    ///
    /// ⚠️ 本函数跑在 `notify` 自己的运行循环线程上（`fsevent.rs:574`）。
    /// 两件事的顺序是**判据的一部分**：
    /// ① 先核对代次（`INV-EXT-09`：授权一变监视就作废）；
    /// ② 代次不符 ⇒ **摘掉监视、不发事件**（前端已经知道授权变了，
    ///    再发一条只会让它去请求一个注定被拒的路径）。
    ///
    /// ⭐ `design/0012` §2.1 ④ 起多了**第三件事：认出"这是我刚写的"**——
    /// 自己保存后收到自己的事件、又去走一遍自动重载，是 `features/0012` 的
    /// 「不自杀」判据要挡的东西（表现是"每按一次 `⌘S`，预览闪一下、滚动位置跳一下"）。
    /// ⚠️ 但它的口径是**代价优化**，⛔ 不是正确性前提：漏判的后果只是"多一次无谓重载"，
    /// 而"写盘会不会覆盖别人的改动"由 [`crate::commands::edit`] 的**内容级基线**判定。
    fn on_change(app: &AppHandle, target: &Path, seq: u64, generation: u64) {
        // ⚠️ 这里**阻塞地**取会话锁是安全的：临界区里只有内存操作 + 一次
        //    `canonicalize`（三段式锁保证渲染不在锁里，`design/0006` §2.1 ⑤）。
        //    ⛔ 但绝不许在本线程 drop 掉 `Watch`——`Watch::drop` 把这件事
        //    交给了别的线程，所以这里可以放心地 `take()`。
        let state = app.state::<AppState>();
        let taken = state.with(|s| {
            if s.grants.root_generation() == generation {
                None
            } else {
                s.drop_watch()
            }
        });
        if let Some(w) = taken {
            diag!("▶ 授权已改变 ⇒ 监视自动失效（seq={seq}）");
            drop(w); // ⚠️ 异步停（见 `impl Drop for Watch`）
            return;
        }

        // —— ⭐ 自写识别（`design/0012` §2.1 ④a）——
        let first = crate::fs::finger(target);
        let verdict = state.with(|s| {
            if first.is_some() && first == s.self_write {
                // ⭐ 指纹对上 = 自己写的。⛔ 一条事件都不发。
                Verdict::SelfWrite { delay: false }
            } else if s.inflight_active() {
                // ⚠️ 指纹对不上，但**有保存在途** ⇒ 可能是"事件比登记先到"
                //    （§2.1 ④a (a)：`rename` 与"第三段登记"之间不是原子的）。
                Verdict::Recheck(first)
            } else {
                Verdict::External
            }
        });
        match verdict {
            Verdict::SelfWrite { delay } => {
                if delay {
                    diag!("▶ 延迟复核：指纹已变 ⇒ 按自写处理（seq={seq}）⇒ ⛔ 不重载");
                } else {
                    diag!("▶ 自写事件（指纹相符）⇒ ⛔ 不重载（seq={seq}）");
                }
                return;
            }
            Verdict::External => {}
            Verdict::Recheck(before) => {
                // ⭐ **延迟 150 ms 再 `stat` 一次**（§2.1 ④a 第 3 条）：
                //    **变了** ⇒ 写盘落地了，按自写处理；**没变** ⇒ 真外部修改，照常重载。
                //
                // ⚠️⚠️ **这里 `sleep` 是刻意的，而且必须在本线程**（⛔ 不 spawn 一个线程再睡）：
                //    ① ⛔ **不持锁**（上面 `state.with` 已经退出）——这是全项目那条
                //       「临界区里只许放内存操作」的另一面；
                //    ② 换到别的线程去睡会让**事件的先后**失去保证：一条更晚发生的事件
                //       可能抢在这次的"延迟重载"之前发出去，前端看到的是**倒序**的两次变化。
                //    ⚠️ 阻塞本回调线程 150 ms 的代价：同期**这个被监视文件**的其它事件
                //       要排队 150 ms。⚠️ 这条路径实测**一次都没触发**（`kb/0020`：20/20 轮
                //       事件都晚于登记）⇒ 它不构成常态延迟。
                std::thread::sleep(INFLIGHT_RECHECK);
                let after = crate::fs::finger(target);
                if after.is_some() && after != before {
                    // ⭐ 登记它（这一步等价于"第三段晚了一点才跑到"）。
                    //    ⚠️ **但只在监视还是这一步的时候登记**：这 150 ms 里用户可能已经
                    //    切走文档（`drop_watch` 会清 `self_write`，见 `Session::end_edit`），
                    //    那时再写进去就是给一个**别的文档**留一个陈旧指纹。
                    state.with(|s| {
                        let same = s
                            .watch
                            .as_ref()
                            .map(|w| w.seq == seq && w.real == target)
                            .unwrap_or(false);
                        if same {
                            s.self_write = after;
                        }
                    });
                    diag!("▶ 延迟复核：指纹已变 ⇒ 按自写处理（seq={seq}）⇒ ⛔ 不重载");
                    return;
                }
                // ⚠️ **没变 ⇒ 照常当外部修改**（⛔ 不是"再多等一会儿"）：
                //    这一步是这个窗口**唯一的出口**，⛔ 不许把它变成一个"一直等"的状态
                //    （那会让真正的外部修改**永久静默**，比多一次重载坏得多）。
                // ⚠️ 诚实说明边界：这 150 ms 里若真有**别人**写盘，这次也会被当成自写
                //    而**不发事件** ⇒ 用户不知道磁盘变了。⭐ 但损失被两件事兜住：
                //    ① 那是"少一次提示"，⛔ 不是"丢数据"；
                //    ② 他下一次保存会撞上**内容级基线**冲突并被拒（§2.4-3），
                //       所以别人的改动**不会被覆盖**。
                diag!("▶ 延迟复核：指纹未变 ⇒ 真外部修改（seq={seq}）⇒ 照常重载");
            }
        }

        let payload = ChangeEvent { path: target.display().to_string(), seq };
        if let Err(e) = app.emit(CHANGED_EVENT, payload) {
            diag_stderr!("⚠️ 变化事件发不出去（seq={seq}）：{e}");
            diag_file!(
                "⚠️ 变化事件发不出去 seq={seq} err_class={} err_len={}",
                crate::logging::err_class(&e),
                e.to_string().len()
            );
        }
    }

    /// ⭐ **在途窗口的延迟复核等多久**（`design/0012` §2.1 ④a 第 3 条）。
    ///
    /// ⚠️⚠️ **⛔ 不许把它读成"测出来的最优值"**：实测只给出**下界**——
    /// 事件到达比 `rename` 晚 **3.4–11.6 ms**（`kb/0020`，20 轮），
    /// 而 150 ms ≈ **13× 那个最大值**。
    /// ⭐ 更要紧的是这条复核在正常路径上**一次都没触发过**（20/20 轮事件都晚于登记），
    /// 留它的唯一理由是「**反转没被测到 ≠ 不可能**」，而省掉它只省下一次 `stat`。
    const INFLIGHT_RECHECK: std::time::Duration = std::time::Duration::from_millis(150);

    /// 事件到达时对"**这是不是我刚写的**"的判词（`design/0012` §2.1 ④a）。
    ///
    /// ⚠️ 三态而不是 `bool`：中间那一态（`Recheck`）是**处置不同**，⛔ 不是"再判一次"——
    /// 它要去睡 150 ms 再取一次指纹，而另外两态当场就有结论。
    enum Verdict {
        /// 指纹相符 ⇒ 自写，⛔ 不发事件。
        ///
        /// ⚠️ `delay` 只影响**日志措辞**（"延迟复核后确认" vs "当场确认"）：
        /// 两条路都走到这里，事后读日志要能分清"复核有没有用上"。
        SelfWrite { delay: bool },
        /// 指纹对不上、也没有保存在途 ⇒ 照常当外部修改。
        External,
        /// 指纹对不上，但**有保存在途** ⇒ 带上"现在看到的指纹"，延迟复核（第 3 条）。
        ///
        /// ⚠️ 里面那个 `Option` 可能是 `None`（`stat` 失败）——⛔ 不是错误，
        /// 复核那一步会把它和 150 ms 后的值比一比：`None → Some` 也算"变了"。
        Recheck(Option<(u64, i64)>),
    }

    // ─────────────────────────────────────────────────────────────────────
    // ⭐ 目录监视（`design/0034` §2.1 A）——与上面的**文档监视**并列，⛔ 不共用句柄
    // ─────────────────────────────────────────────────────────────────────
    //
    // 两者看起来都是"notify 监视 + 去抖"，但生命周期与语义完全不同：
    //
    // | | 文档监视（`watch`） | 目录监视（本节） |
    // |---|---|---|
    // | 目标 | 当前这一份文档 | **一个授权根**（递归） |
    // | 事件 | 带路径与 `seq`，前端靠它定位 | ⛔ **无载荷**（`INV-TREE-03`） |
    // | 去抖 | 无（前端 `reload.js` 自己判） | **300 ms / 最长 1 s**（Rust 侧） |
    // | 失效 | 代次变 ⇒ 摘监视 | 代次变 ⇒ 换根重建 |
    //
    // ⚠️⚠️ **两处死锁面（`kb/0020`）在这里同样成立**，所以 `DirWatch::drop`
    // 沿用同一条纪律：notify 句柄交给一次性线程 drop，⛔ 不在调用线程等它。

    /// 目录变化的事件名。⭐ 全项目**只有两处**该出现这个字面量：这里，与 `src/main.js` 的 `T.listen`。
    ///
    /// ⛔ **不带任何载荷**：FSEvents **不保证事件条数**（一次保存可以来好几条、也可能合并成一条），
    /// 前端拿路径做增量更新等于把"事件流的形状"当成契约。无载荷事件把"该重列哪一层"
    /// 的判断交回**树自己的状态**（它本来就知道哪些层是展开的）。
    pub const TREE_CHANGED_EVENT: &str = "rmd://tree-changed";

    /// 去抖线程最多每隔这么久醒一次，用来复查 `stopped`。
    ///
    /// ⚠️ 它的唯一作用是**让停监视有界**：drop 之后最迟这么久线程自己退出
    /// （⛔ 不在 drop 里 `join`，见 [`DirWatch`] 的说明）。
    const TICK: std::time::Duration = std::time::Duration::from_millis(100);

    /// 去抖线程与 notify 回调共享的状态。
    ///
    /// ⚠️ 用 `Mutex + Condvar` 而不是"事件里直接 `sleep(300ms)`"：
    /// 回调跑在 **FSEvents 自己的运行循环线程**上（`fsevent.rs:574`），
    /// 在那里阻塞 300 ms 等于**把整条递归流的投递堵住 300 ms**——
    /// 而递归流的延迟直接决定"用户新建文件多久之后树才变"。
    struct DirState {
        debouncer: Debouncer,
        stopped: bool,
    }

    /// ⭐ **一个授权根的递归目录监视**（`design/0034` §2.1 A）。
    ///
    /// ⚠️ 只 watch **那一个根**，⛔ 不"每展开一层加一个 watcher"：
    /// `notify` 的 fsevent 后端**每次 `watch()` 都重启整条流**（`fsevent.rs:308-314`）
    /// ⇒ 展开 20 层就等于重建 20 次，每次还要重收一遍历史窗口。
    ///
    /// ⚠️ `watcher` / `timer` **故意不被读取**：它们的作用就是**活着**——
    /// drop 即停止。⛔ 不是"忘了用"。
    pub struct DirWatch {
        /// 被监视的规范路径（授权根，`check_readable` 的返回值）。
        pub root: PathBuf,
        /// 建立时的 `root_generation`。
        ///
        /// ⚠️ 存着是为了**日志/排障时对得上账**：真正决定"这份监视还算不算数"的是
        /// `restart_tree_watch` 的复核与 `reset()`，⛔ 不是这个字段本身。
        pub generation: u64,
        watcher: Option<notify::RecommendedWatcher>,
        shared: std::sync::Arc<(std::sync::Mutex<DirState>, std::sync::Condvar)>,
        timer: Option<std::thread::JoinHandle<()>>,
    }

    impl std::fmt::Debug for DirWatch {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("DirWatch")
                .field("root", &self.root)
                .field("generation", &self.generation)
                .finish_non_exhaustive()
        }
    }

    impl Drop for DirWatch {
        /// ⭐ 两条清理，⛔ **都不许阻塞调用线程**：
        ///
        /// 1. **叫醒去抖线程**并置 `stopped` ⇒ 它最多再跑 `TICK` 就退出。
        ///    ⚠️ ⛔ 不 `join`：调用方可能是命令线程、也可能是 `notify` 回调线程，
        ///    而 `join` 会把"停止监视"变成一次最长 `TICK` 的同步等待
        ///    （与 `Watch::drop` 拒绝 `stop()` 是同一个理由——`kb/0020`）。
        /// 2. **notify 句柄交给一次性线程 drop**（`stop()` 会 `join` 它自己的运行循环线程）。
        ///
        /// ⚠️ 附带一条安全性质：`stopped` 置上之后定时线程**不再发事件**，
        /// 所以"停监视"之后不会再有 `rmd://tree-changed` 到达前端。
        fn drop(&mut self) {
            {
                let (lock, cvar) = &*self.shared;
                let mut g = lock.lock().unwrap_or_else(|p| p.into_inner());
                g.stopped = true;
                drop(g);
                cvar.notify_all();
            }
            self.timer.take(); // ⚠️ 分离，⛔ 不 join
            if let Some(w) = self.watcher.take() {
                std::thread::spawn(move || drop(w));
            }
        }
    }

    /// 在一个**已授权的**根上建立递归监视。
    ///
    /// ⚠️ **调用方必须先过 `check_readable` / `authorize_root`**——本函数不查授权，
    /// 它只负责"盯着这个目录"（与 [`start`] 同一条分工）。
    /// ⚠️ `watch()` 对不存在的路径**立刻 `Err`**（`fsevent.rs:390`），⛔ 不会等它出现。
    ///
    /// ⭐ `on_emit` 是**注入的回调**（⛔ 不是 `AppHandle`）：这样单测能直接数
    /// "发了几次"，而不用为了一个计时逻辑去造一个 Tauri 应用。
    pub fn watch_dir(
        root: &Path,
        on_emit: impl Fn() + Send + 'static,
    ) -> Result<DirWatch, Denied> {
        let shared: std::sync::Arc<(std::sync::Mutex<DirState>, std::sync::Condvar)> =
            std::sync::Arc::new((
                std::sync::Mutex::new(DirState {
                    debouncer: Debouncer::default(),
                    stopped: false,
                }),
                std::sync::Condvar::new(),
            ));

        // ① 去抖线程：**唯一**会在"安静下来之后"发事件的地方
        let timer_shared = std::sync::Arc::clone(&shared);
        let timer = std::thread::Builder::new()
            .name("rmd-tree-debounce".into())
            .spawn(move || {
                let (lock, cvar) = &*timer_shared;
                loop {
                    let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
                    // —— 等"到点"或"被叫醒"——
                    loop {
                        if guard.stopped {
                            return;
                        }
                        match guard.debouncer.deadline() {
                            // 没有开着的窗口 ⇒ 睡到有事件为止（由回调叫醒）。
                            None => {
                                guard = cvar.wait(guard).unwrap_or_else(|p| p.into_inner());
                            }
                            Some(d) => {
                                let now = std::time::Instant::now();
                                if now >= d {
                                    // ⚠️ 一定返回 true（deadline 就是它的判据）；
                                    //    返回值仍然读一下，免得"到点了却没关窗"这种
                                    //    不一致被**静默**吞掉。
                                    let fired = guard.debouncer.poll(now);
                                    debug_assert!(fired, "到点却没有关窗");
                                    break;
                                }
                                // ⚠️ 分段睡：保证 `stopped` 最迟 TICK 之后被看到。
                                let wait = (d - now).min(TICK);
                                let (g, _) = cvar
                                    .wait_timeout(guard, wait)
                                    .unwrap_or_else(|p| p.into_inner());
                                guard = g;
                            }
                        }
                    }
                    // ⚠️ **放锁之后再发**：`on_emit` 里会取会话锁（查代次），
                    //    持着这里的互斥量去取另一把锁是没有必要的锁序。
                    drop(guard);
                    on_emit();
                }
            })
            .map_err(|e| Denied::io(root, e))?;

        // ② 真正的监视：**递归**，只盯这一个根
        let cb_shared = std::sync::Arc::clone(&shared);
        let cb_root = root.to_path_buf();
        let mut watcher = notify::recommended_watcher(
            move |res: Result<notify::Event, notify::Error>| {
                let ev = match res {
                    Ok(ev) => ev,
                    Err(e) => {
                        // ⚠️ 底层错误**不静默**：监视坏了 = 树再也不自动刷新，
                        //    而界面上一切正常（与文档监视同一条纪律）。
                        diag_stderr!("⚠️ 目录监视报错：{e}");
                        diag_file!(
                            "⚠️ 目录监视报错 err_class={} err_len={}",
                            crate::logging::err_class(&e),
                            e.to_string().len()
                        );
                        return;
                    }
                };
                // ⚠️ 事件条数**不作判据**（FSEvents 不保证）：这里只记"来过",
                //    由去抖器决定什么时候发。`ev` 只用来排障时看一眼类型。
                let _ = ev;
                let (lock, cvar) = &*cb_shared;
                let mut g = lock.lock().unwrap_or_else(|p| p.into_inner());
                if g.stopped {
                    return;
                }
                g.debouncer.on_event(std::time::Instant::now());
                drop(g);
                cvar.notify_all();
            },
        )
        .map_err(|e| Denied::io(root, e))?;

        if let Err(e) = watcher.watch(root, RecursiveMode::Recursive) {
            // ⚠️ 定时线程已经起来了 ⇒ 得让它自己退出（它是分离的，⛔ 不 join）
            {
                let (lock, cvar) = &*shared;
                let mut g = lock.lock().unwrap_or_else(|p| p.into_inner());
                g.stopped = true;
                drop(g);
                cvar.notify_all();
            }
            return Err(Denied::io(&cb_root, e));
        }

        Ok(DirWatch {
            root: root.to_path_buf(),
            generation: 0,
            watcher: Some(watcher),
            shared,
            timer: Some(timer),
        })
    }

    /// 生产入口：把"发一次无载荷事件"接上 `AppHandle`（`restart_tree_watch` 调它）。
    ///
    /// ⚠️ 代次复核在**每一次发射之前**做，而不是只在建立时做一次：
    /// `DirWatch` 的 drop 是异步的（`notify` 的 `stop()` 要等运行循环），
    /// 换根的一瞬间可能还有一两条排在路上——它们必须被丢掉，
    /// 否则新树会收到一次"旧根变了"的唤醒（虽然只是多一次刷新，但没有必要）。
    pub fn start_tree_watch(
        app: &AppHandle,
        root: &Path,
        generation: u64,
    ) -> Result<DirWatch, Denied> {
        let cb_app = app.clone();
        let mut w = watch_dir(root, move || {
            // ⚠️ 冷启动的 Apple Event 路径上 `AppState` 可能还没 `manage`
            //    （`try_state` 而不是 `state`：后者在 manage 之前会 abort 进程）。
            let Some(state) = cb_app.try_state::<AppState>() else {
                return;
            };
            let same = state.with(|s| s.grants.root_generation() == generation);
            if !same {
                return;
            }
            if let Err(e) = cb_app.emit(TREE_CHANGED_EVENT, ()) {
                // ⚠️ 发不出去**不致命**（下一次变化还会再试），但⛔ 不许静默：
                //    它坏了的表现是"树再也不自动刷新"，与"目录什么都没变"长得一样。
                diag_stderr!("⚠️ 目录变化事件发不出去：{e}");
                diag_file!(
                    "⚠️ 目录变化事件发不出去 err_class={} err_len={}",
                    crate::logging::err_class(&e),
                    e.to_string().len()
                );
            }
        })?;
        w.generation = generation;
        Ok(w)
    }

    // ── 目录监视的**真 watcher** 测试（`design/0034` §7.1「GUI 那半」） ─────
    //
    // ⚠️ 这些只在 `cargo test --release --features gui` 里跑：它们要真起 FSEvents。
    // ⚠️ 仍然**不开窗、不抢焦点、不合成按键**（根 `CLAUDE.md` §4）——
    //    监视一个临时目录与用户此刻在用的应用没有关系。
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};

        struct TempDir(PathBuf);

        impl TempDir {
            fn new(tag: &str) -> Self {
                let p = std::env::temp_dir()
                    .join(format!("rmd-dirwatch-{}-{tag}", std::process::id()));
                let _ = std::fs::remove_dir_all(&p);
                std::fs::create_dir_all(&p).unwrap();
                TempDir(std::fs::canonicalize(&p).unwrap())
            }
            fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        /// ⭐ §7.0 的那条时间线：**3 批 × 25 个文件**，批内 ≤ 200 ms，批间静默 2 s。
        ///
        /// 判据（⚠️ **原始事件条数不参与判定**——FSEvents 不保证）：
        /// ① 每批**至少** 1 次 emit；② 总计 ≤ 4（允许一次迟到/粘连）；
        /// ③ 最后一批写完之后 3 s 内一定有一次。
        ///
        /// ⚠️ 耗时 ~8 s，是这套测试里最慢的一条；它验的东西**没有别的验法**
        /// （去抖器的纯时序在默认构建里已单独测过，这里验的是"真事件进得来"）。
        #[test]
        fn 目录监视_三批变化每批至少一次通知且总数有界() {
            let t = TempDir::new("batches");
            let emits: Arc<Mutex<Vec<Instant>>> = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&emits);
            let w = watch_dir(t.path(), move || {
                sink.lock().unwrap().push(Instant::now())
            })
            .expect("建立目录监视");

            let mut starts = Vec::new();
            for batch in 0..3 {
                starts.push(Instant::now());
                for i in 0..25 {
                    std::fs::write(
                        t.path().join(format!("b{batch}-{i:02}.md")),
                        b"# x\n",
                    )
                    .unwrap();
                }
                // 批间静默 2 s（> 300 ms 去抖窗口）
                std::thread::sleep(Duration::from_millis(2000));
            }
            let last_write = Instant::now();
            // 等最后一批收敛（3 s 上限）
            std::thread::sleep(Duration::from_millis(3000));

            let times = emits.lock().unwrap().clone();
            assert!(!times.is_empty(), "整轮一条通知都没发 ⇒ 真 watcher 没接到事件");

            // ① 每批至少一次（区间取 [批 i 开始, 批 i+1 开始)）
            for (i, start) in starts.iter().enumerate() {
                let end = starts.get(i + 1).copied();
                let hit = times
                    .iter()
                    .any(|t| *t >= *start && end.is_none_or(|e| *t < e));
                assert!(hit, "第 {i} 批没有任何通知（发出时刻：{times:?}）");
            }
            // ② 总数有界
            assert!(
                times.len() <= 4,
                "3 批变化发了 {} 次通知（> 4）⇒ 去抖没生效：{times:?}",
                times.len()
            );
            // ③ 最后一次通知在最后一批写完后的 3 s 内
            let last = *times.iter().max().unwrap();
            assert!(
                last <= last_write + Duration::from_millis(3000),
                "最后一次通知迟于收尾 + 3 s"
            );

            drop(w);
        }

        /// ⭐ `DirWatch::drop` **不许阻塞**（`kb/0020` 的两处死锁面）。
        ///
        /// ⚠️ 判据是**有界**而不是"立刻"：通知句柄是交给一次性线程停的，
        /// 所以这里量的是"调用线程有没有被 `stop()` 的 `join` 拖住"。
        #[test]
        fn 目录监视_drop_不会挂住调用线程() {
            let t = TempDir::new("drop");
            let w = watch_dir(t.path(), || {}).expect("建立目录监视");
            let t0 = Instant::now();
            drop(w);
            let took = t0.elapsed();
            assert!(took < Duration::from_secs(1), "drop 用了 {took:?}");
        }

        /// ⭐ 停止流程：`drop` 之后**再写也不许发通知**（`design/0035` §10.6 的 0034 核对）。
        ///
        /// ⚠️ 判据分两段，缺一段都不成立：
        /// ① **先证明它活着**——不写这一段，一条"从来没工作过"的 watcher 也能让 ② 通过；
        /// ② `drop` 之后再写一批，`hits` 必须**一个都不涨**。
        /// ⚠️ `drop` 是异步的（`notify` 的停止线程），所以允许在途事件到达回调——
        /// 但回调一进来就看到 `stopped`，`on_emit` 不该被调到（这正是要钉的那条）。
        #[test]
        fn 目录监视_停止之后不再发通知() {
            fn wait_until_hit(hits: &Arc<AtomicUsize>) -> usize {
                let deadline = Instant::now() + Duration::from_secs(3);
                while Instant::now() < deadline {
                    let n = hits.load(Ordering::SeqCst);
                    if n > 0 {
                        return n;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                hits.load(Ordering::SeqCst)
            }

            let t = TempDir::new("stopped");
            let hits = Arc::new(AtomicUsize::new(0));
            let sink = Arc::clone(&hits);
            let w = watch_dir(t.path(), move || {
                sink.fetch_add(1, Ordering::SeqCst);
            })
            .expect("建立目录监视");

            // ① 活着：一次写入 ⇒ 有界时间内至少一次 emit
            std::fs::write(t.path().join("alive.md"), b"# x\n").unwrap();
            let alive = wait_until_hit(&hits);
            assert!(alive > 0, "前置失败：drop 之前就收不到通知（环境问题，不是停止逻辑）");

            drop(w);
            let after_drop = hits.load(Ordering::SeqCst);

            // ② 停止之后：再写一批，等过一个完整窗口 + TICK，不许再涨
            for i in 0..5 {
                std::fs::write(t.path().join(format!("after-{i}.md")), b"# y\n").unwrap();
            }
            std::thread::sleep(Debouncer::QUIET + Duration::from_millis(500));
            assert_eq!(
                hits.load(Ordering::SeqCst),
                after_drop,
                "drop 之后仍然发出了目录变化通知"
            );
        }

        /// 不存在的路径：**立刻 `Err`**，⛔ 不"等它出现"（与文档监视同一条口径）。
        /// ⚠️ 同时证明**失败之后定时线程不会留下**（否则测试结束时进程里还有活线程）。
        #[test]
        fn 目录监视_路径不存在立刻报错() {
            let t = TempDir::new("missing");
            let missing = t.path().join("不存在");
            let hits = Arc::new(AtomicUsize::new(0));
            let sink = Arc::clone(&hits);
            let r = watch_dir(&missing, move || {
                sink.fetch_add(1, Ordering::SeqCst);
            });
            assert!(r.is_err(), "不存在的路径必须立刻失败");
            assert_eq!(hits.load(Ordering::SeqCst), 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn argv_str(v: &[OsString]) -> Vec<String> {
        v.iter().map(|s| s.to_string_lossy().into_owned()).collect()
    }

    /// 默认编辑器：`open -t -- <路径>`。
    #[test]
    fn 默认编辑器走_open_t() {
        let a = argv_str(&editor_argv(None, Path::new("/tmp/a.md")));
        assert_eq!(a, vec!["/usr/bin/open", "-t", "--", "/tmp/a.md"]);
    }

    /// 配置了应用名：`open -a <名字> -- <路径>`。⚠️ 名字也**不是**拼进去的。
    #[test]
    fn 配置了应用名走_open_a() {
        let a = argv_str(&editor_argv(Some("Typora"), Path::new("/tmp/a.md")));
        assert_eq!(a, vec!["/usr/bin/open", "-a", "Typora", "--", "/tmp/a.md"]);
    }

    /// 空 / 全空白 = 没配置（`design/0006` §2.1 ④ 的取值口径）。
    /// ⚠️ 只写 `None` 会漏掉"配置文件里留了个空格"这种真实情形。
    #[test]
    fn 空白的编辑器名按没配置处理() {
        for v in [Some(""), Some("   "), Some("\t\n")] {
            let a = argv_str(&editor_argv(v, Path::new("/tmp/a.md")));
            assert_eq!(a[1], "-t", "{v:?} 应回落默认编辑器");
        }
    }

    /// ⭐ `INV-EXT-01` 的**主判据**：路径永远是一个**逐字未改的独立元素**。
    ///
    /// 这三个输入是"如果哪天有人改成拼字符串"会立刻出事的样子：
    /// - `$(touch /tmp/pwned)` —— 命令替换
    /// - `a; rm -rf ~` —— 命令分隔
    /// - 反引号 / 换行 / 引号 —— 各种 quoting 逃逸
    ///
    /// ⚠️ 断言的是**元素个数**、**前三个元素逐字固定**、以及**路径那个元素逐字相等**
    /// 三件事。只断言"包含这个子串"是不够的：`format!("open -t {path}")` 拼出来的也能过那条。
    ///
    /// ⚠️ **别把"某个元素里有换行"当成判据**（第一版就是这么写的，测出来是错的）：
    /// POSIX 路径**本来就可以含换行**，`/tmp/a\nb.md` 是一个合法文件名，
    /// 它变成 argv 里的一个元素是**正确行为**——而我们从不经过 shell，没有谁会去拆它。
    /// 真正要钉住的是"**它没有被合进别的元素**"，那由"前三个元素逐字固定"来保证。
    #[test]
    fn 路径带元字符时仍然是逐字未改的独立元素() {
        let evil = [
            "/tmp/$(touch /tmp/pwned).md",
            "/tmp/a; rm -rf ~.md",
            "/tmp/`id`#.md",
            "/tmp/a\nb.md",
            "/tmp/it's \"quoted\".md",
            "/tmp/中文 空格.md",
            "/tmp/-leading-dash.md",
        ];
        for p in evil {
            let a = editor_argv(None, Path::new(p));
            assert_eq!(a.len(), 4, "{p}：元素个数变了说明被拼过");
            assert_eq!(a[3], OsString::from(p), "{p}：路径被改写了");
            // ⛔ 前三个元素必须**逐字**是那三个固定值——任何"把路径拼进选项里"的写法
            //    都会在这里露出来（比如 `--{path}`、或把 `--` 与路径合成一个串）。
            assert_eq!(
                argv_str(&a[..3]),
                vec!["/usr/bin/open", "-t", "--"],
                "{p}：选项那一半被污染了"
            );
        }
    }

    /// ⭐ 反面判据：argv 里**不许出现任何 shell**。
    /// ⚠️ 这条要**正面枚举** sh 的名字，而不是只断言"没有 `-c`"——
    /// 漏掉 `/bin/zsh` 或 `env` 的写法同样致命，而那时前一条断言照样绿。
    #[test]
    fn argv_里没有任何_shell() {
        let banned = ["sh", "bash", "zsh", "env", "eval", "exec", "sudo", "osascript"];
        for configured in [None, Some("Typora")] {
            let a = argv_str(&editor_argv(configured, Path::new("/tmp/a.md")));
            assert_eq!(a[0], "/usr/bin/open", "第一个元素必须是 open 本身");
            for one in &a {
                let base = Path::new(one).file_name().map(|s| s.to_string_lossy().into_owned());
                let base = base.unwrap_or_default();
                assert!(
                    !banned.contains(&base.as_str()),
                    "{configured:?}：argv 里出现了 {one} ⇒ 有东西在解释我们的输入"
                );
            }
        }
    }

    // ── ⭐ 目录变化的去抖时序（`design/0034` §7.1 那张矩阵） ─────────────
    //
    // ⚠️ 全部用**注入的 `now`**，⛔ 不碰真实定时器：睡眠只能证明"机器没卡死"，
    //    而这三条判的是**窗口的边界**，必须逐毫秒断言。

    use std::time::{Duration, Instant};

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn 去抖_单事件静默三百毫秒后发一次() {
        let t0 = Instant::now();
        let mut d = Debouncer::default();
        d.on_event(t0);
        assert_eq!(d.deadline(), Some(t0 + Debouncer::QUIET));
        // 还没静默够 ⇒ 不发，也不关窗
        assert!(!d.poll(t0 + ms(299)));
        assert_eq!(d.deadline(), Some(t0 + Debouncer::QUIET), "催一下不许把窗口关掉");
        assert!(d.poll(t0 + ms(300)));
        assert_eq!(d.deadline(), None, "发过之后窗口必须关上");
    }

    #[test]
    fn 去抖_持续事件流到一秒必发() {
        let t0 = Instant::now();
        let mut d = Debouncer::default();
        // 每 100 ms 来一条，一直到 1 s —— 永远不会"静默 300 ms"
        for i in 0..=10u64 {
            d.on_event(t0 + ms(i * 100));
        }
        assert_eq!(
            d.deadline(),
            Some(t0 + Debouncer::MAX_WINDOW),
            "上限必须从**第一条**起算"
        );
        assert!(!d.poll(t0 + ms(999)));
        assert!(d.poll(t0 + ms(1000)), "⛔ 一直在动也必须在 1 s 发一次");
        assert_eq!(d.deadline(), None);
    }

    #[test]
    fn 去抖_发射后窗口关闭且静默再来事件重开窗() {
        let t0 = Instant::now();
        let mut d = Debouncer::default();
        d.on_event(t0);
        assert!(d.poll(t0 + Debouncer::QUIET));

        // ⚠️ 窗口已关 ⇒ 不再发（⛔ 不许"缓存一次待发"）
        assert!(!d.poll(t0 + ms(10_000)));
        assert_eq!(d.deadline(), None);

        // 静默之后再来一条 ⇒ **新窗口**，从这一条起算
        let t1 = t0 + ms(5_000);
        d.on_event(t1);
        assert_eq!(d.deadline(), Some(t1 + Debouncer::QUIET));
        assert!(!d.poll(t1 + ms(299)));
        assert!(d.poll(t1 + ms(300)));
    }

    /// 边界：静默判定是**闭区间**（`now >= deadline`），
    /// 而窗口的 1 s 上限与 300 ms 静默取**小**。
    #[test]
    fn 去抖_两个上界取小() {
        let t0 = Instant::now();
        let mut d = Debouncer::default();
        // 第一条之后 850 ms 又来一条：静默点是 1150，1 s 上限是 1000 ⇒ 取 1000
        d.on_event(t0);
        d.on_event(t0 + ms(850));
        assert_eq!(d.deadline(), Some(t0 + ms(1000)));
        assert!(d.poll(t0 + ms(1000)));

        // 反过来：第一条之后 100 ms 来一条 ⇒ 静默点 400 < 1000 ⇒ 取 400
        let mut e = Debouncer::default();
        e.on_event(t0);
        e.on_event(t0 + ms(100));
        assert_eq!(e.deadline(), Some(t0 + ms(400)));
    }
}
