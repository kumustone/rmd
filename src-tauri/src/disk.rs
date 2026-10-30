//! 根范围的**磁盘状态**（`design/0050` M1 / M1b）——纯状态机。
//!
//! ⭐ **⛔ 不门控 `gui`**，理由与 `fs` / `error` / `config` / `external` 逐字同源：
//! `make test` 跑的是**不带 gui** 的默认构建，而这里那张"信号 → 反应"的真值表
//! 与"健康 / 核对"的状态转移是 `INV-DISK-10/11` 的**唯一自动化防线**。
//! 需要 `notify` / `AppHandle` 的那两半（事件归一化、emit）分别在
//! `external.rs::watch` 与 `commands/fs.rs`。
//!
//! # 为什么健康与核对**分开存**
//!
//! 第一版（`design/0050` v1/v2 稿）用的是**一个** `health: Health` 枚举，
//! 于是 `Io → Rescan → 核对成功` 会把监视故障**洗白**成 `Ok`
//! ——这是最终复评的 P1 第 2 条。现在：
//!
//! | 维度 | 字段 | 谁能改它 |
//! |---|---|---|
//! | **监视本身坏没坏**（持久档） | [`DiskState::watcher`] | 只由 `notify::Error` / 重建结果改 |
//! | **我们知不知道盘上现在是什么**（临时档） | `forced` / `attempted` / `reconciled` / `reconcile_failed` / `rescan_target` | 只由 `request_reconcile` 与核对完成改 |
//!
//! 展示用的 [`DiskView::reason`] 是**派生**的（⛔ 不是第三个真值），判据顺序见
//! [`DiskState::reason`]——顺序本身是契约。
//!
//! # 为什么是"目标修订"而不是"待办计数"
//!
//! `pending += 1` / 每扫完一次 `-= 1` 在**合并**下永远回不到零（两次事件合并成一次核对，
//! 减一次还剩一次），而减到零也可能**清掉后到的事件**。⇒ 用比大小：
//! `forced > attempted` 就是"还有工作"，`reconciled` 只由**它自己捕获的那个目标**推进
//! （`max` 取大，⛔ 不覆盖更大的已完成值）。见最终实施约束 1。
//!
//! # 为什么"已尝试"与"已成功"要分开（`bugs/0039`）
//!
//! `pending()` 一度用的是 `forced > reconciled`。于是**一次失败的核对**（`complete == false`）
//! 不推进 `reconciled` ⇒ "还有工作"永远为真 ⇒ 尾随重跑那一圈没有退避、没有次数上限地空转，
//! 而它每轮做的是**同一件事**（同一纪元的新鲜索引会被 `obtain_index` 直接复用）。
//! 现在两个水位各管一件事：
//!
//! | 字段 | 含义 | 谁看它 |
//! |---|---|---|
//! | `attempted` | 核对**跑过**到哪个目标（成功、失败都算） | 调度：`pending()` |
//! | `reconciled` | **知道**盘上是什么到哪个目标（只有成功） | 健康：`awaiting` 收尾、`rescan` 档 |
//!
//! ⇒ 失败那一轮**调度上结束**、**健康上降级**，重试归**下一次请求**
//! （用户点重试 / 新的 Rescan / 重接监视），⛔ 不是原地热重试。

use serde::Serialize;

/// 监视健康的一档（**只装持久档**）。
///
/// ⚠️ `Rescan` 也在这个枚举里，但它**不写进** [`DiskState::watcher`]——
/// 它是"临时性未知"，由 `rescan_target` 表达。留着它是因为
/// 前端与日志共用同一套字样（`DiskView::reason` 会吐出 `"rescan"`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DegradedReason {
    /// 明确"我们不知道盘上现在是什么"（`Event::need_rescan()`）。**临时档**。
    Rescan,
    /// `notify::ErrorKind::Io` / `Generic`。**持久档**。
    Io,
    /// 根或子树不见了。**持久档**。
    PathNotFound,
    /// `MaxFilesWatch`（inotify；macOS 上不会出现，映射仍要有）。**持久档**。
    Limit,
    /// 重建监视失败。**持久档**。
    RewatchFailed,
}

impl DegradedReason {
    /// 给前端 / 日志的稳定字样（⛔ 别改成随语言变的东西：它是协议的一部分）。
    pub fn as_str(&self) -> &'static str {
        match self {
            DegradedReason::Rescan => "rescan",
            DegradedReason::Io => "io",
            DegradedReason::PathNotFound => "path-not-found",
            DegradedReason::Limit => "limit",
            DegradedReason::RewatchFailed => "rewatch-failed",
        }
    }

    /// 临时档（核对完就能自己好）vs 持久档（必须重建监视）。
    ///
    /// ⚠️ 判据是"**用户要做的动作**"，⛔ 不是"哪个更严重"：
    /// 临时档只要等，持久档必须点"重试"。
    pub fn is_transient(&self) -> bool {
        matches!(self, DegradedReason::Rescan)
    }
}

/// `notify::ErrorKind` 的**归一化副本**。
///
/// ⚠️ 为什么不直接用 `notify::ErrorKind`：`notify` 只在 `--features gui` 下编译，
/// 而本模块要在 `make test` 里跑。`external.rs::watch::signal_of` 做那一层映射，
/// 一张薄测试（gui）钉住"每一档都映射到了"，本模块只需要归一化后的值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalError {
    /// `ErrorKind::Generic`。
    Generic,
    /// `ErrorKind::Io`。
    Io,
    /// `ErrorKind::PathNotFound`。
    PathNotFound,
    /// `ErrorKind::WatchNotFound`。
    WatchNotFound,
    /// `ErrorKind::InvalidConfig`。
    InvalidConfig,
    /// `ErrorKind::MaxFilesWatch`。
    MaxFilesWatch,
}

/// 一条 notify 回调 / 一次手动动作**归一化之后**的样子。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskSignal {
    /// 普通事件（包括 `Flag::Rescan` 之外的一切）。
    Event,
    /// `Event::need_rescan()`——内核说"我可能丢了事件"。
    Rescan,
    /// 结构化错误。
    Error(SignalError),
}

/// 一条信号**要做的事**。⚠️ 纯数据，便于逐行钉真值表。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reaction {
    /// 内容修订 +1。
    pub bump: bool,
    /// 必须做一次**完整核对**（`forced = epoch`）。
    ///
    /// ⚠️ 普通事件**不置它**：隐藏面不该被拖去做全盘扫描（最终约束 1 末句）。
    pub force: bool,
    /// 要写进 [`DiskState::watcher`] 的持久档降级。
    ///
    /// ⚠️ `Some(Rescan)` 在这里只表示"另有一条 Rescan 信号"，
    /// [`DiskState::apply`] 会把它翻译成 `rescan_target`，⛔ 不写 `watcher`。
    pub degrade: Option<DegradedReason>,
}

impl Reaction {
    /// "什么都没发生"。⚠️ `pub` 是因为窗口合并（`external.rs` 的 `DirState`）要重置它。
    pub const NONE: Reaction = Reaction { bump: false, force: false, degrade: None };

    fn nothing_changed(&self) -> bool {
        !self.bump && !self.force && self.degrade.is_none()
    }
}

/// ⭐ **唯一的分类入口**（`design/0050` §2.3.1 那张表）。
///
/// ⛔ 别在回调里写第二份 `if`——那张表就是"收到什么信号做什么"的全部规则。
pub fn reaction(signal: DiskSignal) -> Reaction {
    match signal {
        // 普通事件：知道盘上变了，但**不需要**全盘核对（可见面按需 fresh）。
        DiskSignal::Event => Reaction { bump: true, force: false, degrade: None },
        // Rescan：内核可能丢了事件 ⇒ 我们不知道盘上是什么 ⇒ 必须核对。
        DiskSignal::Rescan => Reaction {
            bump: true,
            force: true,
            degrade: Some(DegradedReason::Rescan),
        },
        DiskSignal::Error(kind) => match kind {
            // 读不出来了：保守地让所有派生快照失效，并真的去核对一次。
            SignalError::Generic | SignalError::Io => Reaction {
                bump: true,
                force: true,
                degrade: Some(DegradedReason::Io),
            },
            SignalError::PathNotFound => Reaction {
                bump: true,
                force: true,
                degrade: Some(DegradedReason::PathNotFound),
            },
            SignalError::MaxFilesWatch => Reaction {
                bump: true,
                force: true,
                degrade: Some(DegradedReason::Limit),
            },
            // ⚠️ 这两类**重建才有意义**：不推纪元（盘上发生了什么我们仍不知道，
            //    但重扫也没用——句柄本身失效了），也不排核对。
            SignalError::WatchNotFound | SignalError::InvalidConfig => Reaction {
                bump: false,
                force: false,
                degrade: Some(DegradedReason::RewatchFailed),
            },
        },
    }
}

/// ⭐ **批次合并**：同一个去抖窗口里多条信号 ⇒ 按**最重**的那个算。
///
/// 判据三条各自取并：`bump` / `force` 取或；`degrade` 取"持久档优先、同级取更重"。
/// ⚠️ 为什么不是"后到覆盖"：`git checkout` 会先打出成百上千条普通事件、最后才来一条
/// Rescan，后到覆盖在某些顺序下会把最重要的那条丢掉。
pub fn merge(a: Reaction, b: Reaction) -> Reaction {
    Reaction {
        bump: a.bump || b.bump,
        force: a.force || b.force,
        degrade: match (a.degrade, b.degrade) {
            (None, x) => x,
            (x, None) => x,
            (Some(x), Some(y)) => {
                if severity(x) >= severity(y) { Some(x) } else { Some(y) }
            }
        },
    }
}

/// 降级档的**合并次序**（越大越"重"）。
///
/// ⚠️ 持久档一律重于 `Rescan`：一个窗口里既有"句柄失效"又有"可能丢事件"，
/// 前者需要重建、后者需要核对，丢掉前者等于**让用户看不到真正该做的事**。
fn severity(r: DegradedReason) -> u8 {
    match r {
        DegradedReason::Rescan => 0,
        DegradedReason::Io => 1,
        DegradedReason::PathNotFound => 2,
        DegradedReason::Limit => 3,
        DegradedReason::RewatchFailed => 4,
    }
}

/// 一次核对请求的来由（只影响**要不要**推纪元 / 改健康）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileCause {
    /// 监视信号（普通 / Rescan / 错误）。由 [`reaction`] 的结果驱动。
    Signal(Reaction),
    /// 用户显式刷新（`reconcile_disk`）。⚠️ **不改** `watcher`：它不是故障检测。
    Manual,
    /// ⭐ **重组监视之后补排的那一次核对**（`restart_tree_watch` 的收尾）。
    ///
    /// ⚠️⚠️ **它推内容修订**——2026-10-29 代码评审第 9 条：此前调用点借的是
    /// [`Manual`](Self::Manual)，而 `retry_tree_watch` 的文档写着「⛔ 不推内容修订」，
    /// 两边**相反**。以代码为准，文档已改：重接之前那一段「没人接事件」的窗口里
    /// 盘上可能变过，而我们**一条事件都没收到** ⇒ 派生快照必须保守失效
    /// （否则展开过的子树用的仍是失效窗口里的旧层）。
    /// ⭐ `retry_tree_watch` 修的确实是**管道**，但"管道通了"不等于
    /// "我知道盘上是什么"（`design/0050` 最终约束 2）——推纪元正是这句话的代价。
    ///
    /// ⚠️ 与 [`Manual`](Self::Manual) **行为相同、来由不同**：分开是为了让日志与
    /// 调用点说得清"这一次为什么推"，⛔ 不是两条语义。
    Reattach,
}

/// ⭐ 根范围的磁盘状态。⚠️ **只是内存**：⛔ 不落盘、⛔ 不进 `config.json`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskState {
    /// 内容修订：每来一个**去抖批次** / 每次手动刷新 / 每次重建收尾 +1。
    ///
    /// ⚠️ 它是**树缓存与共享索引的失效判据**（`INV-DISK-07/09`），
    /// 所以任何"盘上可能变了"的动作都必须让它前进——包括监视错误
    /// （我们不知道盘上发生了什么，只能保守失效）。
    pub epoch: u64,
    /// 最近一次"必须做**完整核对**"的目标修订；`0` = 从未有过。
    pub forced: u64,
    /// 已**成功**核对到的目标修订——"**知道**盘上是什么"的水位。
    ///
    /// ⚠️ 它**只**由成功的那一轮推进（失败不推，否则健康会被洗白）。
    pub reconciled: u64,
    /// ⭐ 已**尝试**核对到的目标修订——成功与失败**都**推进（`bugs/0039`）。
    ///
    /// ⚠️ 它管的是**调度**（[`Self::pending`]），⛔ 不是健康。
    /// 与 [`Self::reconciled`] 分开的理由见模块头那一节。
    pub attempted: u64,
    /// 一次核对曾失败 / 只走完了部分子树（`design/0050` §2.3.2 第 4 条）。
    pub reconcile_failed: bool,
    /// 最近一次 Rescan 信号对应的修订；`0` = 没有"临时性未知"。
    pub rescan_target: u64,
    /// ⭐ **监视本身的健康**（只装持久档）。⛔ 核对成功**不会**清它。
    pub watcher: Option<DegradedReason>,
    /// 监视实例 token（每次 `restart_tree_watch` 发号，**单调**，⛔ 不随换根归零）。
    pub watch_id: u64,
    /// 派生快照的修订号（每次派生状态变化 +1）。前端据此丢弃倒退的包。
    pub revision: u64,
    /// 重建监视成功后**在等**的那次核对：`(watch_id, target)`。
    ///
    /// ⚠️ 它就是最终约束 2 那句"重建成功但核对失败仍降级"的落点：
    /// 重建成功**不立刻**清 `watcher`，要等同一实例下的核对真的完成。
    pub awaiting: Option<(u64, u64)>,
}

impl Default for DiskState {
    fn default() -> Self {
        Self::new()
    }
}

impl DiskState {
    pub fn new() -> Self {
        DiskState {
            epoch: 0,
            forced: 0,
            reconciled: 0,
            attempted: 0,
            reconcile_failed: false,
            rescan_target: 0,
            watcher: None,
            watch_id: 0,
            revision: 0,
            awaiting: None,
        }
    }

    /// ⭐ **换根**：整体重置（旧根的修订在新根上已经没有意义）。
    ///
    /// ⚠️ `watch_id` **不归零**：它必须单调，否则旧 watcher 的迟到结果
    /// 会与新实例撞号（`INV-DISK-07` 末项）。
    pub fn reset_roots(&mut self) {
        self.epoch = 0;
        self.forced = 0;
        self.reconciled = 0;
        self.attempted = 0;
        self.reconcile_failed = false;
        self.rescan_target = 0;
        self.watcher = None;
        self.awaiting = None;
        self.revision = self.revision.wrapping_add(1);
    }

    /// 发一个新的监视实例号。⚠️ 只有 [`crate::commands::fs::restart_tree_watch`] 该调它。
    pub fn next_watch_id(&mut self) -> u64 {
        self.watch_id = self.watch_id.wrapping_add(1);
        self.watch_id
    }

    /// ⭐ **推高处**（`INV-DISK-05`）：所有"盘上可能变了"的动作都经这里。
    ///
    /// ⚠️ 调用方必须在**会话锁内**、且已经复核过 `(代次, watch_id)`。
    pub fn request(&mut self, cause: ReconcileCause) {
        match cause {
            ReconcileCause::Signal(r) => {
                if r.nothing_changed() {
                    return;
                }
                if r.bump {
                    self.epoch = self.epoch.wrapping_add(1);
                }
                if r.force {
                    // ⚠️ 顺序：先 push 再取目标，⛔ 别写成 `forced = epoch` 在 bump 之前。
                    self.forced = self.epoch;
                }
                match r.degrade {
                    // ⭐ 临时档：只记"到哪个修订为止我们不知道"，⛔ 不写 `watcher`。
                    Some(DegradedReason::Rescan) => {
                        self.rescan_target = self.epoch.max(1);
                        // 一次新的 Rescan 意味着"上一轮核对不用再等"——目标是新的。
                    }
                    // ⭐ 持久档：写 `watcher`，并且**取消**正在等的那次核对
                    //    （它属于旧实例，已经救不了现在的故障了）。
                    Some(d) => {
                        self.watcher = Some(d);
                        self.awaiting = None;
                    }
                    None => {}
                }
                self.revision = self.revision.wrapping_add(1);
            }
            // ⭐ **两种"外来动作"都推纪元并排一次完整核对**（评审第 9 条）：
            //    `Manual` = 用户刷新；`Reattach` = 重接监视之后补排的那一次
            //    （重接之前那段窗口里我们现在什么都不知道）。
            ReconcileCause::Manual | ReconcileCause::Reattach => {
                self.epoch = self.epoch.wrapping_add(1);
                self.forced = self.epoch;
                self.revision = self.revision.wrapping_add(1);
            }
        }
    }

    /// 重建监视**失败** ⇒ 持久档降级（`design/0050` §2.3.3）。
    pub fn note_rewatch_failed(&mut self) {
        self.watcher = Some(DegradedReason::RewatchFailed);
        self.awaiting = None;
        self.revision = self.revision.wrapping_add(1);
    }

    /// 重建监视**成功** ⇒ 记下"等这个实例把目标 `target` 核对完"。
    ///
    /// ⚠️ ⛔ 不在这里把健康清成 `Ok`：重建成功 ≠ 盘上的事已经核对过。
    /// ⭐ 只清**它自己那个故障**（`RewatchFailed`）——句柄确实又好了，
    /// 再报"重连失败"就是假话；而 `Io` / `PathNotFound` / `Limit` **原样保留**，
    /// 它们要等同一实例把 `target` 核对完才走（见 [`complete`](Self::complete)）。
    pub fn note_rewatch_ok(&mut self, watch_id: u64, target: u64) {
        if self.watcher == Some(DegradedReason::RewatchFailed) {
            self.watcher = None;
        }
        self.awaiting = Some((watch_id, target));
        self.revision = self.revision.wrapping_add(1);
    }

    /// 还有没有强制核对没做完。`true` ⇒ 应当起一次（或补跑一次）核对。
    ///
    /// ⚠️ 判据是**已尝试**的目标（[`attempted`](Self::attempted)），⛔ 不是已成功的那个：
    /// 失败的那一轮**也算跑过了**，重试归**下一次请求**（用户点重试 / 新的 Rescan /
    /// 重接监视），⛔ 不是由调用方原地再跑一遍。
    /// ⚠️ 用 `forced > reconciled` 的旧写法会让一次失败把 `pending()` 永久钉在 `true` 上
    /// ⇒ 尾随重跑一圈一圈地空转（`bugs/0039`）。失败本身由 `reconcile_failed` 表达，
    /// 健康⛔ 不会因此被洗白。
    pub fn pending(&self) -> bool {
        self.forced > self.attempted
    }

    /// ⭐ **这一轮跑完之后还要不要再跑一轮**（尾随重跑；2026-10-29 代码评审第 8 条）。
    ///
    /// ⚠️ 它此前只活在 `commands/fs.rs::kick_reconcile` 的循环体里，而那段要真起线程
    /// 才跑得到 ⇒ "什么时候停"没有任何判据在 `make test` 里。搬成纯函数之后真值表可钉。
    ///
    /// ⭐ 参数是**当刻的[`pending`](Self::pending)快照**，不是 `&self`——调用方读它的时候
    /// 已经在锁内了，这里再锁一次只会制造第二个读点。
    /// ⚠️ 调用方**仍必须**在同一个锁内完成「判据 ＋ 归还单飞位」（⛔ 分开两步会丢唤醒，
    /// 见 `kick_reconcile` 那段注释）。
    pub fn wants_trailing_round(pending: bool, rounds: usize, max: usize) -> bool {
        pending && rounds < max
    }

    /// 当前该核对到的目标修订（`None` = 没活儿）。
    pub fn target(&self) -> Option<u64> {
        if self.pending() {
            Some(self.forced)
        } else {
            None
        }
    }

    /// ⭐ **核对完成记账**（`design/0050` §2.3.2 第 3/4 条）。
    ///
    /// - `target`：这次核对**自己捕获**的目标修订（⛔ 不是"当刻 forced"）。
    /// - `watch_id`：跑这次核对时的监视实例（**fencing**：换过实例就不算数）。
    /// - `complete`：`FileIndex.complete`——⚠️ `false` 表示**有子树没走完**，
    ///   那就**不算**核对完成（`reconcile_failed` 置位、`reconciled` 不推进）。
    ///
    /// ⭐ **成功与失败都推进 [`attempted`](Self::attempted)**（`bugs/0039`）：这一轮核对
    /// 确实**跑完了**，无论结论如何。⛔ 只推进 `reconciled` 的话，一次失败就让
    /// `pending()` 永久为真 ⇒ 尾随重跑陷入忙循环。
    ///
    /// 返回 `true` = 派生状态变了（调用方应当广播一次）。
    pub fn complete(&mut self, target: u64, watch_id: u64, complete: bool) -> bool {
        let before = self.revision;
        // ── ① 调度水位：成功失败都推进 ──
        let was_pending = self.pending();
        if target > self.attempted {
            self.attempted = target;
        }
        if was_pending && !self.pending() {
            // ⚠️ `DiskView.pending` 是**派生状态的一栏** ⇒ 它变了就要发一次，
            //    ⛔ 不能只改字段不推 `revision`（前端会按 revision 丢弃这份包）。
            self.revision = self.revision.wrapping_add(1);
        }
        if !complete {
            // ── ② 健康：失败**不推进** `reconciled` ──
            //    它记的是"**知道**盘上是什么"，推进它就把监视健康洗白成"没问题"
            //    （最终约束 2 第 3 条）。
            if !self.reconcile_failed {
                self.reconcile_failed = true;
                self.revision = self.revision.wrapping_add(1);
            }
            return self.revision != before;
        }
        if target > self.reconciled {
            self.reconciled = target;
            self.revision = self.revision.wrapping_add(1);
        }
        if self.reconcile_failed {
            self.reconcile_failed = false;
            self.revision = self.revision.wrapping_add(1);
        }
        // ⭐ 重建收尾：**同一个**监视实例把它的目标核对完，才清持久档。
        if let Some((w, t)) = self.awaiting {
            if w == watch_id && self.reconciled >= t {
                self.awaiting = None;
                if self.watcher.is_some() {
                    self.watcher = None;
                }
                self.revision = self.revision.wrapping_add(1);
            }
        }
        self.revision != before
    }

    /// ⭐ **派生**的展示档（判据顺序是契约，⛔ 别对调）。
    ///
    /// 1. `watcher` 有值 ⇒ 报它（**持久档**：用户必须点重试）；
    /// 2. `reconcile_failed` ⇒ `Io`（重建成功但核对失败**仍降级**）；
    /// 3. 还有 Rescan 型未核对的修订 ⇒ `Rescan`（临时档：等它自己好）；
    /// 4. 否则 `Ok`。
    ///
    /// ⚠️ 第 3 条只认 **Rescan** 引起的 pending。普通事件只推 `epoch`、
    /// 不动 `forced` ⇒ 不会让状态条闪（`design/0050` §2.3.3 末条的硬要求）。
    pub fn reason(&self) -> Option<DegradedReason> {
        if let Some(w) = self.watcher {
            return Some(w);
        }
        if self.reconcile_failed {
            return Some(DegradedReason::Io);
        }
        if self.pending() && self.rescan_target > self.reconciled {
            return Some(DegradedReason::Rescan);
        }
        // ⭐ 第 3 条下半：**正在等的那次核对还没回来**。它挡住的是这样一条缝：
        //    重建成功 → 清掉 `RewatchFailed` → 但目标修订其实早就算"完成过"了
        //    ⇒ 一瞬 `Ok` 再变回降级（界面上闪一下）。`awaiting` 在，就一直报临时档。
        if self.awaiting.is_some() {
            return Some(DegradedReason::Rescan);
        }
        None
    }

    /// 给前端 / 日志的只读快照。
    pub fn view(&self) -> DiskView {
        DiskView {
            epoch: self.epoch,
            watch_id: self.watch_id,
            revision: self.revision,
            reason: self.reason().map(|r| r.as_str()),
            pending: self.pending(),
        }
    }
}

/// `rmd://dir-watch` 的载荷 ＋ `SessionSnapshot.disk`（⚠️ **同一份形状**）。
///
/// ⚠️ **全是纯身份元数据**：⛔ 无路径、⛔ 无事件类型（`INV-DISK-06`）。
/// 前端收到它之后**仍要**在读状态时核 `revision`（丢弃倒退的包）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiskView {
    /// 内容修订（树缓存 / 索引的失效判据）。
    pub epoch: u64,
    /// 监视实例号（跨实例 fencing）。
    pub watch_id: u64,
    /// 这份快照自己的修订号。
    pub revision: u64,
    /// 派生健康：`null` / `"rescan"` / `"io"` / `"path-not-found"` / `"limit"` / `"rewatch-failed"`。
    pub reason: Option<&'static str>,
    /// 还有强制核对没做完。
    pub pending: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(s: DiskSignal) -> ReconcileCause {
        ReconcileCause::Signal(reaction(s))
    }

    // ── 真值表（`design/0050` §2.3.1） ────────────────────────────────

    #[test]
    fn 反应表_普通事件只推纪元不排核对() {
        let r = reaction(DiskSignal::Event);
        assert!(r.bump);
        assert!(!r.force, "普通事件⛔ 不许拖隐藏面去做全盘扫描");
        assert_eq!(r.degrade, None);
    }

    #[test]
    fn 反应表_重扫信号推纪元并排核对() {
        let r = reaction(DiskSignal::Rescan);
        assert!(r.bump && r.force);
        assert_eq!(r.degrade, Some(DegradedReason::Rescan));
        assert!(DegradedReason::Rescan.is_transient());
    }

    #[test]
    fn 反应表_四类错误都推纪元并排核对() {
        for (k, want) in [
            (SignalError::Generic, DegradedReason::Io),
            (SignalError::Io, DegradedReason::Io),
            (SignalError::PathNotFound, DegradedReason::PathNotFound),
            (SignalError::MaxFilesWatch, DegradedReason::Limit),
        ] {
            let r = reaction(DiskSignal::Error(k));
            assert!(r.bump && r.force, "{k:?} 必须推纪元并排核对");
            assert_eq!(r.degrade, Some(want));
            assert!(!want.is_transient(), "{k:?} 是持久档");
        }
    }

    #[test]
    fn 反应表_句柄失效类不推纪元只要求重建() {
        for k in [SignalError::WatchNotFound, SignalError::InvalidConfig] {
            let r = reaction(DiskSignal::Error(k));
            assert!(!r.bump && !r.force, "{k:?} 重扫没用，只有重建有意义");
            assert_eq!(r.degrade, Some(DegradedReason::RewatchFailed));
        }
    }

    #[test]
    fn 反应表_批次合并取最重() {
        let 普通 = reaction(DiskSignal::Event);
        let 重扫 = reaction(DiskSignal::Rescan);
        let 句柄 = reaction(DiskSignal::Error(SignalError::WatchNotFound));
        let io = reaction(DiskSignal::Error(SignalError::Io));

        let m = merge(普通, 重扫);
        assert!(m.bump && m.force);
        assert_eq!(m.degrade, Some(DegradedReason::Rescan));

        // 持久档压过临时档（⛔ 不许让"需要重建"被"可能丢事件"盖掉）
        let m = merge(重扫, io);
        assert_eq!(m.degrade, Some(DegradedReason::Io));

        let m = merge(io, 句柄);
        assert_eq!(m.degrade, Some(DegradedReason::RewatchFailed));
        // ⚠️ 句柄那一条自己不推纪元，但同窗口里那条普通事件推过 ⇒ 合并后仍要推
        let m = merge(普通, 句柄);
        assert!(m.bump, "同窗口里普通事件已经发生了，内容修订必须前进");
        assert!(!m.force);
    }

    // ── 目标修订（最终约束 1/7） ──────────────────────────────────────

    #[test]
    fn 目标修订_合并两次事件不会永远回不到零() {
        let mut d = DiskState::new();
        // 两条 Rescan 合并成**一次**核对（调用方负责合并窗口）
        d.request(sig(DiskSignal::Rescan));
        d.request(sig(DiskSignal::Rescan));
        let target = d.target().expect("还有活儿");
        assert_eq!(target, d.forced);
        assert!(d.complete(target, d.watch_id, true));
        assert!(!d.pending(), "一次核对就把合并过的两件事一起解决");

        // 但"核对在途时又来一条"必须补跑
        d.request(sig(DiskSignal::Rescan));
        let before = d.forced;
        // ⚠️ 这次调用**不改变任何东西**（旧目标已经在账上）⇒ 返回 `false` 是对的；
        //    要断言的是"它没能把后到的请求清掉"。
        d.complete(target, d.watch_id, true);
        assert!(d.pending(), "后到的请求不能被旧核对清掉");
        assert_eq!(d.forced, before);
        assert!(d.complete(before, d.watch_id, true));
        assert!(!d.pending());
    }

    #[test]
    fn 目标修订_旧核对不许覆盖更大的已完成值() {
        let mut d = DiskState::new();
        d.request(sig(DiskSignal::Rescan));
        let old = d.target().unwrap();
        d.request(sig(DiskSignal::Rescan));
        let new = d.target().unwrap();
        assert!(new > old);
        assert!(d.complete(new, d.watch_id, true));
        // 一份**更旧**的核对（比如更晚返回的旧任务）不许把 reconciled 拉回去
        d.complete(old, d.watch_id, true);
        assert_eq!(d.reconciled, new);
        assert!(!d.pending());
    }

    #[test]
    fn 目标修订_普通事件不产生强制核对() {
        let mut d = DiskState::new();
        d.request(sig(DiskSignal::Event));
        assert_eq!(d.epoch, 1);
        assert!(!d.pending(), "普通 dirty ⛔ 不许变成全盘扫描");
        assert_eq!(d.reason(), None, "普通事件⛔ 不许让状态条闪");
    }

    // ── 健康与核对是两个维度（最终约束 2） ────────────────────────────

    #[test]
    fn 健康_io之后的重扫成功不许洗白监视故障() {
        let mut d = DiskState::new();
        d.request(sig(DiskSignal::Error(SignalError::Io)));
        assert_eq!(d.reason(), Some(DegradedReason::Io));
        d.request(sig(DiskSignal::Rescan));
        assert_eq!(d.reason(), Some(DegradedReason::Io), "Rescan ⛔ 不许盖掉持久档");
        let t = d.target().unwrap();
        d.complete(t, d.watch_id, true);
        assert_eq!(d.reason(), Some(DegradedReason::Io), "核对成功⛔ 不许洗白监视故障");
    }

    #[test]
    fn 健康_只有重建成功且核对完成才恢复() {
        let mut d = DiskState::new();
        d.request(sig(DiskSignal::Error(SignalError::Io)));
        // 重建失败 ⇒ RewatchFailed
        d.note_rewatch_failed();
        assert_eq!(d.reason(), Some(DegradedReason::RewatchFailed));
        // 重建成功：⛔ 这一刻还不算好（⭐ 2026-10-27 修正：`RewatchFailed` 自身已结束，
        // 于是报的是"**正在重新核对**"这个临时档，而**不是** `Ok`）
        let w = d.next_watch_id();
        d.request(sig(DiskSignal::Rescan));
        let t = d.forced;
        d.note_rewatch_ok(w, t);
        assert_eq!(d.reason(), Some(DegradedReason::Rescan), "重建成功但没核对 ⇒ 仍降级");
        // 核对失败 ⇒ 仍降级（`reconcile_failed` 走 `Io`）
        assert!(d.complete(t, w, false));
        assert_eq!(d.reason(), Some(DegradedReason::Io));
        // 核对成功 ⇒ 恢复
        assert!(d.complete(t, w, true));
        assert_eq!(d.reason(), None);
    }

    #[test]
    fn 健康_重建成功但核对失败仍降级() {
        let mut d = DiskState::new();
        d.note_rewatch_failed();
        let w = d.next_watch_id();
        d.request(sig(DiskSignal::Rescan));
        let t = d.forced;
        d.note_rewatch_ok(w, t);
        d.complete(t, w, false);
        assert_eq!(d.reason(), Some(DegradedReason::Io), "核对失败 ≠ 已恢复");
        assert!(
            !d.pending(),
            "失败那一轮**跑完了** ⇒ 调度上结束，⛔ 不许原地热重试（`bugs/0039`）"
        );
        assert!(d.reconciled < t, "但「知道盘上是什么」没有推进");
        // 重试归**下一次请求**
        d.request(ReconcileCause::Manual);
        assert!(d.pending(), "用户点重试 ⇒ 重新待办");
    }

    #[test]
    fn 健康_部分扫描不算核对完成() {
        let mut d = DiskState::new();
        d.request(sig(DiskSignal::Rescan));
        let t = d.forced;
        d.complete(t, d.watch_id, false);
        assert!(!d.pending(), "部分扫描也**跑完**了这一轮 ⇒ ⛔ 不原地重跑（`bugs/0039`）");
        assert_eq!(d.reason(), Some(DegradedReason::Io));
        // 再跑一次（由**下一次请求**触发）走完了 ⇒ 好
        d.request(ReconcileCause::Manual);
        let t2 = d.forced;
        assert!(d.pending());
        d.complete(t2, d.watch_id, true);
        assert!(!d.pending());
        assert_eq!(d.reason(), None);
    }

    /// ⭐ `bugs/0039`：`complete == false` ⛔ **不许**让 `pending()` 永久为真。
    ///
    /// 钉的是**调度语义**（`design/0050` §2.3.2 第 5 条「⛔ 饿死、⛔ 忙循环」）：
    /// 失败那一轮也算"尝试过了"，重试归**下一次请求**。
    /// ⚠️ 变异：把 `pending()` 改回 `forced > reconciled` ⇒ 第一条断言必红。
    /// ⚠️ 第二条断言是**负对照**：健康⛔ 不许跟着一起被"结束"。
    #[test]
    fn 目标修订_失败的那一轮不算没跑过() {
        let mut d = DiskState::new();
        d.request(sig(DiskSignal::Rescan));
        let t = d.forced;
        d.complete(t, d.watch_id, false);
        assert!(!d.pending(), "跑完一轮就必须退出循环（⛔ 否则是忙循环）");
        assert_eq!(d.reason(), Some(DegradedReason::Io), "健康仍要降级");
        assert_eq!(d.attempted, t);
        assert!(d.reconciled < t, "「已知道」没前进");
        // 三种"下一次请求"之一（用户重试）能重新排上
        d.request(ReconcileCause::Manual);
        assert!(d.pending());
        d.complete(d.forced, d.watch_id, true);
        assert!(!d.pending());
        assert_eq!(d.reason(), None);
    }

    /// 同一目标重复 `complete(…, false)`：派生修订**只涨一次**，之后返回 `false`。
    ///
    /// ⚠️ 这条防的是另一种抖动：每次失败都推 `revision` ⇒ 前端每条包都要重画状态条。
    #[test]
    fn 目标修订_重复的失败不反复推进派生修订() {
        let mut d = DiskState::new();
        d.request(sig(DiskSignal::Rescan));
        let t = d.forced;
        assert!(d.complete(t, d.watch_id, false));
        let rev = d.revision;
        assert!(!d.complete(t, d.watch_id, false), "同样的失败 ⛔ 不许再发一次");
        assert_eq!(d.revision, rev);
    }

    #[test]
    fn 健康_普通事件不会让临时档出现() {
        let mut d = DiskState::new();
        d.request(sig(DiskSignal::Event));
        assert_eq!(d.reason(), None);
        d.request(ReconcileCause::Manual);
        assert_eq!(d.reason(), None, "手动刷新不是故障检测");
    }

    /// ⭐ 评审第 9 条：**重接监视也推内容修订**，并且排一次完整核对。
    ///
    /// 钉的是"文档与实现相反"那一半：`retry_tree_watch` 的文档曾写「⛔ 不推内容修订」，
    /// 而它内部走的是推纪元那条路。以**代码**为准 ⇒ 文档已改，并把来由拆成
    /// [`ReconcileCause::Reattach`]，⛔ 不再借 `Manual`。
    /// ⚠️ 变异：把 `Reattach` 挪出那个合臂、改成「不推纪元」⇒ 第一条断言必红；
    /// ⚠️ 第二条断言是**负对照**：它⛔ 不许把自己报成故障（`watcher` 仍是 `None`）。
    #[test]
    fn 重接监视_推纪元并排一次完整核对() {
        let mut d = DiskState::new();
        let e0 = d.epoch;
        d.request(ReconcileCause::Reattach);
        assert_eq!(d.epoch, e0 + 1, "重接之前的盲窗口里盘上可能变过 ⇒ 派生快照必须失效");
        assert_eq!(d.forced, d.epoch, "重接之后要**完整核对**一次，不是只看一眼");
        assert!(d.pending(), "排上的核对要真的待办");
        assert_eq!(d.reason(), None, "⛔ 重接本身不是故障检测");
    }

    // ── 尾随重跑的判据（评审第 8 条） ────────────────────────────────

    #[test]
    fn 尾随重跑_真值表() {
        // ⚠️ 判据 =「还有活儿」**且**「没到上限」。两侧单独都不够：
        //    只判 pending ⇒ 一次失败的核对会让这一圈跑到天荒地老；
        //    只判 rounds ⇒ 活儿都干完了还白跑，且每轮都要真扫盘。
        assert!(!DiskState::wants_trailing_round(false, 0, 4));
        assert!(DiskState::wants_trailing_round(true, 0, 4));
        assert!(DiskState::wants_trailing_round(true, 3, 4), "最后一轮还没到上限，照跑");
        assert!(!DiskState::wants_trailing_round(true, 4, 4), "到上限必须停");
        assert!(!DiskState::wants_trailing_round(false, 4, 4));
        // ⚠️ 上限是 0 时**一轮都不许追加**（真值表边界，⛔ 不靠调用方保证）
        assert!(!DiskState::wants_trailing_round(true, 0, 0));
    }

    // ── 监视实例身份（最终约束 3） ────────────────────────────────────

    #[test]
    fn 身份_旧实例的迟到结果不许改新实例的状态() {
        let mut d = DiskState::new();
        let old_w = d.next_watch_id();
        d.request(sig(DiskSignal::Error(SignalError::Io)));
        let t = d.forced;
        // 重建：新实例
        let new_w = d.next_watch_id();
        assert!(new_w > old_w);
        d.note_rewatch_ok(new_w, t);
        // 旧实例的"核对完成"迟到 ⇒ 不许清新实例的健康
        d.complete(t, old_w, true);
        assert_eq!(d.watcher, Some(DegradedReason::Io), "旧实例的完成⛔ 不算数");
        // 新实例自己完成才算
        d.complete(t, new_w, true);
        assert_eq!(d.watcher, None);
    }

    #[test]
    fn 身份_换根重置但监视号不归零() {
        let mut d = DiskState::new();
        d.next_watch_id();
        d.request(sig(DiskSignal::Error(SignalError::Io)));
        let w = d.watch_id;
        d.reset_roots();
        assert_eq!(d.watch_id, w, "watch_id 必须单调，⛔ 不许随换根归零");
        assert_eq!(d.epoch, 0);
        assert_eq!(d.forced, 0);
        assert_eq!(d.reconciled, 0);
        assert_eq!(d.attempted, 0);
        assert_eq!(d.watcher, None);
        assert_eq!(d.reason(), None);
    }

    // ── 快照 ──────────────────────────────────────────────────────────

    #[test]
    fn 快照_只有身份元数据没有路径() {
        let mut d = DiskState::new();
        d.next_watch_id();
        d.request(sig(DiskSignal::Error(SignalError::PathNotFound)));
        let v = d.view();
        assert_eq!(v.reason, Some("path-not-found"));
        assert!(v.pending);
        assert!(v.watch_id > 0);
        // ⚠️ 形状本身是契约：多一个带路径的字段就等于开了 `INV-DISK-06` 的口子
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains("path\""), "载荷⛔ 不许带路径: {json}");
        assert!(!json.contains("/"), "载荷⛔ 不许带任何路径片段: {json}");
    }

    #[test]
    fn 快照_revision_只增不减() {
        let mut d = DiskState::new();
        let r0 = d.revision;
        d.request(sig(DiskSignal::Event));
        let r1 = d.revision;
        assert!(r1 > r0);
        d.request(sig(DiskSignal::Event));
        assert!(d.revision > r1);
        // 同一种"没变化"的请求不推 revision（避免前端白刷新）
        let before = d.revision;
        d.request(ReconcileCause::Signal(Reaction::NONE));
        assert_eq!(d.revision, before);
    }
}
