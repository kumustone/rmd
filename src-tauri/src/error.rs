//! 拒绝原因。`design/0003` §3 要求三类**必须可区分**——
//! `Stale` 要被前端**静默丢弃**，`NotAuthorized` 要在未授权态里显示成"未授权"，
//! 而 `NotFound` 显示成"文件不存在"。⚠️ 两者的用户含义完全不同
//! （§7 步骤 18 的"隐蔽断言"：用词错了会把安全策略说成 bug）。
//!
//! ⭐ `design/0012` 起多了**写侧**的两类（[`Denied::Conflict`] / [`Denied::SaveInFlight`]）。
//! ⚠️ 它们**不并进读侧那四类**：读侧的每一类都对应"这条路径读不了"，
//! 而这两类说的是"这次**保存动作**不能发生"——路径本身完全正常。
//! 合并会让前端在"文件好好的，只是我这边有冲突"时显示"未授权"。
//!
//! ⚠️ 本模块**不依赖 Tauri**——`fs::` 的单测要在默认构建下跑（`make test` 不带 gui），
//! 而拒绝类型是那条测试路径上的公共类型。命令层直接用它当错误类型
//! （Tauri 只要求 `Err` 侧实现 `Serialize`）。

use serde::Serialize;

/// 一次读取（或一次保存）被拒绝的原因。
///
/// ⚠️ `Serialize` 的形状是 `{"kind":"not_authorized","path":"…"}`——
/// 前端按 `kind` 分支，⛔ **不要**去解析 `Display` 的文本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Denied {
    /// 路径不在任何已授权范围内（含软链逃逸、`..` 逃逸、前缀陷阱）。
    NotAuthorized {
        /// 请求的那个路径（原样回显，便于前端在占位文案里显示它在引用谁）。
        path: String,
    },
    /// `canonicalize` 失败。
    ///
    /// ⛔ **刻意不区分「不存在」与「权限不足」**（`design/0003` §2.1.2 (1) 注意点 2）：
    /// 差别化会让一次越权尝试变成一次**目录探测**——"读到 PermissionDenied 就说明
    /// 这个路径存在"。
    NotFound {
        /// 请求的那个路径。
        path: String,
    },
    /// 代次不符（`design/0003` §2.1.3 规则 2）。
    ///
    /// ⚠️ 后端在**入口处**查一次 `root_generation`，不等就立刻返回，**不做后续工作**
    /// （⛔ 不读文件、⛔ 不解析）。前端收到它应当**静默丢弃**，⛔ 不弹错。
    Stale {
        /// 本次请求携带的代次。
        got: u64,
        /// 后端当前的代次。
        expected: u64,
    },
    /// ⭐⭐ **内容修订陈旧**（`design/0050`）：授权代次**没变**，但盘上内容变了。
    ///
    /// ⚠️ 它与 [`Stale`](Self::Stale) **必须分开**（`INV-DISK-09` 末条）：
    /// 换根要**清树重列**，内容修订只要**保留旧视图 ＋ 重试**——把后者也报成"代次陈旧"，
    /// 前端就会把整棵树清掉，用户看到的是"树闪了一下又长回来"。
    ///
    /// ⚠️ 它与 [`Conflict`](Self::Conflict) 也不是一码事：那个说的是
    /// "**已打开的那份文档**在盘上变了，要不要覆盖"，这个说的是
    /// "**这一次列目录**的观测起点已经过期，重列一次就行"。
    ///
    /// ⚠️⚠️ **两个数可能相等**，而那不是缺陷：`list_dir` 的票失效（有人 `fresh` 过、
    /// 或有更晚的扫描领了票）时，纪元**根本没动**（`design/0050` §2.2.4）——
    /// 唯一过期的是那张票。这种情形由 [`Denied::ticket_taken`] 构造，
    /// `Display` 会给一句**不含两个数**的话（"观测起点 5，当前 5"是自相矛盾的）。
    StaleRevision {
        /// 扫描起步时的内容修订（`DiskState::epoch`）。
        got: u64,
        /// 后端当前的内容修订。
        expected: u64,
    },
    /// 读盘 / 解析失败（文件存在且已授权，但内容读不出来）。
    ///
    /// ⚠️ 与 `NotFound` 分开：它**带上底层错误文本**，因为到这里已经没有
    /// 探测风险——路径早已通过授权校验。
    ///
    /// ⚠️ `design/0012` 起它**两边都用**：读侧（`loader` / 解码）与写侧
    /// （[`crate::commands::edit`] 的临时文件写、`rename`、权限位）。
    /// ⭐ 所以 `label` / `Display` 的措辞是**读写**，⛔ 不是"读取"——
    /// 保存失败时打一行"读取失败"会让排错的人去找一个不存在的读路径问题。
    Io {
        /// 出错的那个（已规范化的）路径。
        path: String,
        /// 底层错误文本。
        message: String,
    },
    /// ⚠️⚠️ **我们自己的后台线程没了**（panic / 运行时关停）——⛔ 不是读盘失败。
    ///
    /// ⭐ 2026-10-29 代码评审第 22 条：此前 `spawn_blocking` 的 join 失败一律包成
    /// [`Io`](Self::Io)，而前端的 `wording || message`（`services/tauri.js` 的归一化）
    /// **让 `wording` 赢** ⇒ 界面上只剩「读写失败」那一句，具体的
    /// 「目录扫描线程没能跑完：…」**永远显示不出来**。而代码里紧邻的注释
    /// 明写着「⛔ 别把它与'这个目录读不出来'用同一句文案」——两边相反。
    /// ⭐ 拉开一格之后那句话才真的**看得见**：用户不会跑去查一个不存在的读盘问题
    /// （`bugs/0005` 的同族教训）。
    ///
    /// ⚠️ 它**总是我们代码的缺陷**，不是用户环境的问题——⛔ 别在文案里让用户去动文件。
    WorkerLost {
        /// 出事的那条链路回显用的路径。
        path: String,
        /// 哪条线程 ＋ 底层错误（如「目录扫描线程没能跑完：task panicked」）。
        message: String,
    },
    /// **当前没有打开任何文档**（`design/0006` §2.1 ② 的 `⌘E` / `reload_document`）。
    ///
    /// ⚠️ 它是第 4 类，⛔ **不能并进 `NotFound`**：那两句文案在界面上是不同的意思
    /// （"文件不存在"会让用户去找文件；真实原因是**他还没打开任何文档**，
    /// 而这条路径的入口在菜单里、空会话下也点得着）。
    /// ⚠️ 也⛔ 不是 `Io`——它不是读取失败，是**前置条件不满足**。
    NoDocument,
    /// ⭐ **保存冲突**：磁盘上那份内容已经不是打开时的基线（`design/0012` §2.4-3 / `INV-EDIT-04` ①）。
    ///
    /// ⚠️ 判据是**内容**（逐字节比 [`Session::baseline_bytes`]），⛔ 不是 `(len, mtime)`：
    /// 同步工具 `touch` 一下就会让 mtime 变而内容不变（假冲突），
    /// 反过来某些写入能同时骗过长度与时间戳（真漏）。
    ///
    /// ⚠️ 前端文案**不许**说成"保存失败"——文件好好的，是**我们拒绝覆盖别人的改动**。
    /// ⛔ 也**不许**静默降级成"另存为"（那是替用户做决定，`design/0012` §6）。
    ///
    /// [`Session::baseline_bytes`]: crate::commands::Session::baseline_bytes
    Conflict {
        /// 冲突的那个（已规范化的）路径。
        path: String,
    },
    /// ⭐ **已有一次保存在途**（`design/0012` §2.4-4）：⛔ **不排队**，直接拒。
    ///
    /// ⚠️ 这是**正常的并发竞态**（用户连按两次 `⌘S`），不是错误 ⇒ 前端**静默处理**
    /// （第一次的结果会照常回来并把脏标记清掉），⛔ 不弹错、⛔ 不提示"请稍后重试"。
    /// ⚠️ 与 [`Stale`](Self::Stale) 分开是因为处置虽然都是静默，**含义不同**：
    /// 那个说"你的请求过期了"，这个说"我正在写，你这次白按了"。
    SaveInFlight {
        /// 正在被写的那个（已规范化的）路径。
        path: String,
    },
    /// ⭐ **目标已存在**（`design/0034` §2.1 B）：`create_new` / `create_dir` 的原子拒绝。
    ///
    /// ⚠️ 它是**正常的并发竞态**（两个同名创建同时到，或用户在 Finder 里抢先建了一个），
    /// ⇒ 前端要**保留输入框**并提示换个名字，⛔ 不弹错、⛔ 不覆盖、⛔ 不自动加后缀。
    /// ⚠️ 与 [`Conflict`](Self::Conflict) 分开：那个说的是"已打开的那份文档在盘上变了"，
    /// 这个说的是"我要创建的**新**名字被占了"——处置与文案都不同。
    AlreadyExists {
        /// 被占住的那个（父目录下的）路径。
        path: String,
    },
    /// ⭐ **名字不合法**（`design/0034` §2.1 B 的七步校验）。
    ///
    /// ⚠️ 六种 `reason` 分开是因为**出路不同**：改名 / 换父目录 / 缩短。
    /// 前端按 `reason` 给不同提示，⛔ 不合并成"名字不合法"一句。
    InvalidName {
        /// 用户输入的原名（原样回显，便于输入框旁边显示）。
        name: String,
        /// 具体是哪一条不过。
        reason: InvalidNameReason,
    },
    /// ⭐ **父目录不可建**（`design/0034` §2.1 B / `INV-FS-08`）。
    ///
    /// ⚠️ **不是 `NotAuthorized`**：父目录本身已授权、也确实是个目录，
    /// 只是它（或它的某一级祖先）是**隐藏 / 忽略目录**——在树里根本不可展开。
    /// 区分开才能让前端说清"这个位置不能新建"，而不是误导成"没有权限"。
    UnusableParent {
        /// 那个不可用的父目录。
        path: String,
    },
    /// ⚠️ **创建后复核发现目标落在根外**（`design/0034` §4.1 ③）。
    ///
    /// ⛔ **`create_entry` 遇到它绝不删除那个文件**：它可能已经是**别人的**文件，
    /// 删除就是数据破坏；而且"我们以为是自己建的"这件事在父链被并发替换时并不成立。
    /// ⇒ 只报错、只留痕，由用户自己判断。
    CreatedOutsideRoot {
        /// 复核时看到的真实路径。
        path: String,
    },
    /// ⭐ **这个条目不能改名**（`design/0035` §3.3.2.1）。
    ///
    /// ⚠️ 与 [`InvalidName`](Self::InvalidName) 是**两件事**：那个说的是
    /// 「**用户输入的新名字**不合法」，这个说的是「**这一行本身**不能改名」——
    /// 名字还没轮到被判。⇒ 前端文案也不同（那边给名字规则，这边给"换一种做法"）。
    ///
    /// ⚠️ 三种 `reason` 分开是因为**出路不同**：
    /// `Symlink` ⇒ 去改它指向的那一份；`NotMarkdown` ⇒ 本期只支持 Markdown；
    /// `Editing` ⇒ 先保存并退出编辑态。
    /// ⚠️ **保存在途不归这里**：那是 [`SaveInFlight`](Self::SaveInFlight)，
    /// ⛔ 不给同一个状态造第二套话术（`design/0035` §3.3.2.1）。
    NotRenamable {
        /// 被拒的那一条（已规范化的真实路径）。
        path: String,
        /// 具体是哪一条不过。
        reason: RenameRefusal,
    },
    /// ⭐ **有界集合已满**（`design/0043` §2.1：收藏满 `FAVORITES_LIMIT` 条）。
    ///
    /// ⚠️ 与 `Io` 分开：磁盘好好的，拒绝的是**这条产品规则**——
    /// 前端要能说"收藏已满，先删一条"，⛔ 不能说成"保存失败"。
    /// ⚠️ `what` 是集合名（今天只有 `"favorites"`），`limit` 是上限本身，
    /// 前端文案用它拼个数，⛔ 不在前端另写一份上限常量。
    LimitReached {
        /// 集合名（稳定标识，⛔ 不是文案）。
        what: &'static str,
        /// 该集合的上限。
        limit: usize,
    },
}

/// [`Denied::InvalidName`] 的六种原因（`design/0034` §2.1 B）。
///
/// ⚠️ 顺序就是校验顺序，前端文案与它一一对应；⛔ 别把它压成一个布尔。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InvalidNameReason {
    /// 空串或全空白。
    Empty,
    /// 含路径分隔符（`/` 或 `\`）。
    Separator,
    /// 是 `.` / `..`。
    Reserved,
    /// 以 `.` 开头（会被树当作隐藏项）。
    Hidden,
    /// 名字在忽略清单里（`node_modules` 等）。
    Ignored,
    /// 补上 `.md` 之后超过 255 字节。
    TooLong,
}

impl InvalidNameReason {
    /// 给人看的短标签（只用于 stderr）。
    pub fn label(self) -> &'static str {
        match self {
            InvalidNameReason::Empty => "名字为空",
            InvalidNameReason::Separator => "含路径分隔符",
            InvalidNameReason::Reserved => "保留名字",
            InvalidNameReason::Hidden => "点开头",
            InvalidNameReason::Ignored => "忽略目录名",
            InvalidNameReason::TooLong => "名字过长",
        }
    }
}

/// [`Denied::NotRenamable`] 的三种原因（`design/0035` §3.3.2.1）。
///
/// ⚠️ 前两种由 [`SessionGrants`](crate::fs::grants::SessionGrants) 判（授权与条目类型），
/// 第三种 `Editing` 由 `Session::rename_guard` 判（**状态**）——
/// 但三者**共用同一句类别文案**，⛔ 不因此拆成两个 kind。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RenameRefusal {
    /// 请求的那一条本身是符号链接（`design/0035` §3.3.2 第 3 步）。
    Symlink,
    /// 不是普通 Markdown 文件（目录 / 其它扩展名）。
    NotMarkdown,
    /// 当前文档处于编辑态（⭐ 干净也算，`design/0035` §3.3.7 R2）。
    Editing,
}

impl RenameRefusal {
    /// 给人看的短标签（只用于 stderr）。
    pub fn label(self) -> &'static str {
        match self {
            RenameRefusal::Symlink => "是符号链接",
            RenameRefusal::NotMarkdown => "不是普通 Markdown 文件",
            RenameRefusal::Editing => "当前文档正在编辑",
        }
    }
}

impl Denied {
    /// 「未授权」。
    pub fn not_authorized(path: impl AsRef<std::path::Path>) -> Self {
        Denied::NotAuthorized { path: path.as_ref().display().to_string() }
    }

    /// 「找不到」。
    pub fn not_found(path: impl AsRef<std::path::Path>) -> Self {
        Denied::NotFound { path: path.as_ref().display().to_string() }
    }

    /// 「代次陈旧」。
    pub fn stale(got: u64, expected: u64) -> Self {
        Denied::Stale { got, expected }
    }

    /// ⭐ 「内容修订陈旧」（`design/0050`）：同一代次内盘上变了，重列一次就行。
    pub fn stale_revision(got: u64, expected: u64) -> Self {
        Denied::StaleRevision { got, expected }
    }

    /// ⭐ 「这一趟扫描的票失效了」（`design/0050` §2.2.4）：纪元**没动**，
    /// 是有人 `fresh` 过、或有更晚的扫描领了票。
    ///
    /// ⚠️ 对前端它与 [`stale_revision`](Self::stale_revision) **同一条路由**
    /// （`kind` 相同 ⇒ 保留旧视图 ＋ 重列一次），差别只在文案：这一支**不许**
    /// 说"观测起点 X，当前 Y"——两个数相等，那句话自相矛盾。
    pub fn ticket_taken(epoch: u64) -> Self {
        Denied::StaleRevision { got: epoch, expected: epoch }
    }

    /// 「读不出来」。
    pub fn io(path: impl AsRef<std::path::Path>, e: impl std::fmt::Display) -> Self {
        Denied::Io { path: path.as_ref().display().to_string(), message: e.to_string() }
    }

    /// ⚠️ 「我们的后台线程没了」（评审第 22 条）：`spawn_blocking` 的 join 失败时用它，
    /// ⛔ 不许再包成 [`io`](Self::io)——那会把我们代码里的 panic 说成"这个目录读不出来"。
    pub fn worker_lost(path: impl AsRef<std::path::Path>, what: &str, e: impl std::fmt::Display) -> Self {
        Denied::WorkerLost {
            path: path.as_ref().display().to_string(),
            message: format!("{what}：{e}"),
        }
    }

    /// 「保存冲突」（磁盘已变）。
    pub fn conflict(path: impl AsRef<std::path::Path>) -> Self {
        Denied::Conflict { path: path.as_ref().display().to_string() }
    }

    /// 「已有保存在途」。
    pub fn save_in_flight(path: impl AsRef<std::path::Path>) -> Self {
        Denied::SaveInFlight { path: path.as_ref().display().to_string() }
    }

    /// 「目标已存在」。
    pub fn already_exists(path: impl AsRef<std::path::Path>) -> Self {
        Denied::AlreadyExists { path: path.as_ref().display().to_string() }
    }

    /// 「名字不合法」。
    pub fn invalid_name(name: impl Into<String>, reason: InvalidNameReason) -> Self {
        Denied::InvalidName { name: name.into(), reason }
    }

    /// 「父目录不可建」。
    pub fn unusable_parent(path: impl AsRef<std::path::Path>) -> Self {
        Denied::UnusableParent { path: path.as_ref().display().to_string() }
    }

    /// 「创建后复核落在根外」。
    pub fn created_outside_root(path: impl AsRef<std::path::Path>) -> Self {
        Denied::CreatedOutsideRoot { path: path.as_ref().display().to_string() }
    }

    /// 「这个条目不能改名」。
    pub fn not_renamable(path: impl AsRef<std::path::Path>, reason: RenameRefusal) -> Self {
        Denied::NotRenamable { path: path.as_ref().display().to_string(), reason }
    }

    /// 「有界集合已满」（`design/0043`）。
    pub fn limit_reached(what: &'static str, limit: usize) -> Self {
        Denied::LimitReached { what, limit }
    }

    /// 给人看的短标签。⛔ 只用于 stderr 日志，前端文案看 `kind`。
    pub fn label(&self) -> &'static str {
        match self {
            Denied::NotAuthorized { .. } => "未授权",
            Denied::NotFound { .. } => "找不到",
            Denied::Stale { .. } => "代次陈旧",
            Denied::StaleRevision { .. } => "内容修订陈旧",
            // ⚠️ 读写**两侧**（`design/0012` 起写侧也用 `Io`），措辞见本变体的文档。
            Denied::Io { .. } => "读写失败",
            Denied::WorkerLost { .. } => "后台任务异常退出",
            Denied::NoDocument => "没有当前文档",
            Denied::Conflict { .. } => "磁盘已变",
            Denied::SaveInFlight { .. } => "已有保存在途",
            Denied::AlreadyExists { .. } => "目标已存在",
            Denied::InvalidName { reason, .. } => reason.label(),
            Denied::UnusableParent { .. } => "父目录不可建",
            Denied::CreatedOutsideRoot { .. } => "复核落在根外",
            Denied::NotRenamable { reason, .. } => reason.label(),
            Denied::LimitReached { .. } => "已达上限",
        }
    }
}

impl std::fmt::Display for Denied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Denied::NotAuthorized { path } => write!(f, "未授权：{path}"),
            Denied::NotFound { path } => write!(f, "找不到：{path}"),
            Denied::Stale { got, expected } => {
                write!(f, "代次陈旧：请求带 {got}，当前 {expected}")
            }
            Denied::StaleRevision { got, expected } if got == expected => {
                // ⭐ 票失效（[`Denied::ticket_taken`]）：纪元没动，说"观测起点 X，当前 X"是自相矛盾的。
                write!(f, "内容修订陈旧：这一趟扫描的票已失效（修订 {got}），重列一次即可")
            }
            Denied::StaleRevision { got, expected } => {
                write!(f, "内容修订陈旧：观测起点 {got}，当前 {expected}")
            }
            Denied::Io { path, message } => write!(f, "读写失败：{path}：{message}"),
            Denied::WorkerLost { message, .. } => write!(f, "后台任务异常退出：{message}"),
            Denied::NoDocument => write!(f, "没有当前文档"),
            Denied::Conflict { path } => write!(f, "磁盘上的内容已变：{path}"),
            Denied::SaveInFlight { path } => write!(f, "已有一次保存在途：{path}"),
            Denied::AlreadyExists { path } => write!(f, "目标已存在：{path}"),
            Denied::InvalidName { name, reason } => {
                write!(f, "名字不合法：{name}（{}）", reason.label())
            }
            Denied::UnusableParent { path } => write!(f, "父目录不可建：{path}"),
            Denied::CreatedOutsideRoot { path } => {
                write!(f, "复核发现目标落在已授权根之外：{path}")
            }
            Denied::NotRenamable { path, reason } => {
                write!(f, "不能改名：{path}（{}）", reason.label())
            }
            Denied::LimitReached { what, limit } => write!(f, "{what} 已达上限 {limit} 条"),
        }
    }
}

impl std::error::Error for Denied {}

#[cfg(test)]
mod tests {
    use super::*;

    /// 序列化形状是**前端契约**：`kind` 是分支依据（§7 步骤 18 的两句文案靠它区分）。
    #[test]
    fn 三种拒绝在序列化后可区分() {
        let json = |d: &Denied| serde_json::to_string(d).unwrap();
        let a = json(&Denied::not_authorized("/x"));
        let b = json(&Denied::not_found("/x"));
        let c = json(&Denied::stale(1, 2));
        assert!(a.contains("\"kind\":\"not_authorized\""), "{a}");
        assert!(b.contains("\"kind\":\"not_found\""), "{b}");
        assert!(c.contains("\"kind\":\"stale\""), "{c}");
        // ⚠️ 同一个路径，未授权与找不到必须是**两个** `kind`
        assert_ne!(a, b);
    }

    /// ⭐ 写侧那两类同样是**前端契约**（`design/0012` §6 的失败模型）。
    ///
    /// ⚠️ 判据是"**四种**在序列化之后两两不同"——只断言各自含自己的 `kind`
    /// 是不够的（有人把两个变体改成同一个字符串时，四条断言照样全绿）。
    #[test]
    fn 写侧两类与读侧可区分() {
        let json = |d: &Denied| serde_json::to_string(d).unwrap();
        let all = [
            json(&Denied::not_authorized("/x")),
            json(&Denied::conflict("/x")),
            json(&Denied::save_in_flight("/x")),
            json(&Denied::io("/x", "目录不可写")),
        ];
        assert!(all[1].contains("\"kind\":\"conflict\""), "{}", all[1]);
        assert!(all[2].contains("\"kind\":\"save_in_flight\""), "{}", all[2]);
        for i in 0..all.len() {
            for j in (i + 1)..all.len() {
                assert_ne!(all[i], all[j], "第 {i} 与第 {j} 类序列化后撞了");
            }
        }
    }

    /// ⭐ `design/0034` 新建了四种拒绝，它们同样要**两两可区分**，且与既有的七种不撞。
    ///
    /// ⚠️ 判据仍是"全表两两不同"：只断言各自含自己的 `kind` 抓不到
    /// 「两个变体被改成同一个字符串」这种漂移。
    #[test]
    fn 新建四种拒绝与既有七种两两不同() {
        let json = |d: &Denied| serde_json::to_string(d).unwrap();
        let all = [
            json(&Denied::not_authorized("/x")),
            json(&Denied::not_found("/x")),
            json(&Denied::stale(1, 2)),
            json(&Denied::io("/x", "e")),
            json(&Denied::NoDocument),
            json(&Denied::conflict("/x")),
            json(&Denied::save_in_flight("/x")),
            json(&Denied::already_exists("/x")),
            json(&Denied::invalid_name("a/b", InvalidNameReason::Separator)),
            json(&Denied::unusable_parent("/x")),
            json(&Denied::created_outside_root("/x")),
        ];
        for i in 0..all.len() {
            for j in (i + 1)..all.len() {
                assert_ne!(all[i], all[j], "第 {i} 与第 {j} 类序列化后撞了");
            }
        }
        for kind in ["already_exists", "invalid_name", "unusable_parent", "created_outside_root"] {
            assert!(
                all.iter().any(|s| s.contains(&format!("\"kind\":\"{kind}\""))),
                "缺 {kind}：{all:?}"
            );
        }
    }

    /// 六种 `reason` 也必须各自可区分——前端按它给出**不同出路**的文案。
    #[test]
    fn 名字不合法六种原因两两不同() {
        let json = |r: InvalidNameReason| serde_json::to_string(&r).unwrap();
        let all = [
            json(InvalidNameReason::Empty),
            json(InvalidNameReason::Separator),
            json(InvalidNameReason::Reserved),
            json(InvalidNameReason::Hidden),
            json(InvalidNameReason::Ignored),
            json(InvalidNameReason::TooLong),
        ];
        for i in 0..all.len() {
            for j in (i + 1)..all.len() {
                assert_ne!(all[i], all[j], "第 {i} 与第 {j} 种原因撞了");
            }
        }
    }

    /// ⭐ **票失效**（`Denied::ticket_taken`）：`kind` 与"内容修订陈旧"同一格（前端同一条路由），
    /// 但**文案不许**说"观测起点 X，当前 X"——那句自相矛盾（2026-10-29 评审第 21 条）。
    #[test]
    fn 票失效与内容修订陈旧_同一kind但文案不同() {
        let json = |d: &Denied| serde_json::to_string(d).unwrap();
        let expired = json(&Denied::stale_revision(4, 5));
        let taken = json(&Denied::ticket_taken(5));
        assert!(expired.contains("\"kind\":\"stale_revision\""), "{expired}");
        assert!(taken.contains("\"kind\":\"stale_revision\""), "{taken}");
        // 判据落在**文字**上：两个数相等时不许把它们并排印出来。
        let a = Denied::stale_revision(4, 5).to_string();
        let b = Denied::ticket_taken(5).to_string();
        assert!(a.contains("观测起点 4，当前 5"), "{a}");
        assert!(!b.contains("观测起点"), "票失效不许说观测起点：{b}");
        assert!(!b.contains("当前"), "票失效不许说『当前』：{b}");
        assert!(b.contains('5'), "票失效要把修订号说出来：{b}");
        assert_ne!(a, b);
    }
}
