//! 命令层：Tauri 的 IPC 表面。**授权与读取的唯一出入口。**
//!
//! # 两类命令，职责不能混（`design/0003` §2.1.2 (2)，`INV-FS-04`）
//!
//! | 类别 | 命令 | 能不能改授权 |
//! |---|---|---|
//! | **授权命令** | `choose_directory` / `choose_file` / 启动参数 | ✅ 唯一能改 [`SessionGrants`] 的地方 |
//! | **读取命令** | `open_document` / `list_dir` / `read_asset` | ⛔ **永不**新增可读路径 |
//! | ⭐ **写命令** | [`edit::save_document`] | ⛔ **永不**新增可读路径，⛔ 但**能改用户的磁盘** |
//!
//! ⚠️ [`edit`] 那三条（`begin_edit` / `end_edit` / `render_preview`）**不属于上表任何一类**，
//! 而这不是分类失误：[`SessionGrants`] 仍是"可读写哪条路径"的**唯一**来源
//! （上面那句 `INV-FS-04` 一个字没松），
//! 编辑态只是**在已授权的读路径上追加一道"用户正在编辑它"的动作判据**——
//! 它让写**更难**发生，⛔ 从不让读写**更多**路径。详见 [`edit`] 的模块头。
//!
//! ⛔ 读取命令**不做隐式提权**，也**不接受**前端传来的"这个路径是用户选的"标志——
//! 那是一个**前端说法**：可伪造、可过期、与真实授权状态可脱节。
//!
//! # ⚠️ 这里推翻了批 1 的一条结构性保证
//!
//! 批 1 的 `open_document` **不接路径参数**，读盘入口只有启动 argv
//! （那时它是"结构上不可能违反规则"的写法）。`design/0003` 通过了，
//! 现在前端**必须**能传路径（树里点一份文件）。
//! ⇒ 那条结构性保证被**换成**了本层的授权模型：路径参数可以有，
//! 但**每一条**都必须过 [`SessionGrants::check_readable`]。
//! ⚠️ 这正是 `docs/tasks.md` T6 边界 2 预告过的"这块要重做"。
//!
//! # 代次（`design/0003` §2.1.3）
//!
//! 每个读取命令都在**入口处**查一次 `root_generation`，不等就立刻返回
//! [`Denied::Stale`]、**不做任何工作**。⚠️ 这不是"取消"语义——它只保证
//! 「不做白工」，前端那一侧的提交点检查才保证「不显示错的东西」。

pub mod asset;
pub mod document;
pub mod edit;
pub mod fs;
// ⭐ `design/0026`：文档内链接的**判定与派发**（`open_link`）。
// ⚠️ 纯函数那半（分类 / 编码 / argv / 导航白名单）在 `crate::link`，**不门控**——
//    这里只剩"必须见到 `Session` 与 Tauri"的那一层（`INV-LINK-09`）。
pub mod link;

use std::collections::VecDeque;
use crate::logging;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::config::{Appearance, Config, DirSession, ReadingProgress, FAVORITES_LIMIT};
use crate::error::Denied;
use crate::external::watch::Watch;
use crate::fs::grants::SessionGrants;
use crate::fs::tree;
use crate::fs::tree::TreeCache;

/// 这个会话是怎么来的（决定侧边栏长什么样，`design/0003` §2.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// 打开的是一个**目录** → 侧边栏显示文件树。
    Directory,
    /// 打开的是一个**单文件** → 侧边栏显示"未授权态"（§2.1.4）。
    SingleFile,
    /// ⭐ **裸跑**（`rmd` 不带参数）→ 空会话：没有授权、没有文档、没有树。
    ///
    /// 这个模式存在的理由就是 §2.1.1 第 4 条（"记住上次打开的目录"）：
    /// 那条要求只有在**没有启动参数**时才有意义——否则每次重开都要重走一遍
    /// 目录选择器，而这正是它想省掉的事。
    /// ⚠️ 空会话里那个「上次打开的目录」只是**提示**，
    /// 点了仍然要过一次系统选择器（`INV-FS-03`：授权只在本会话内产生）。
    Empty,
}

impl Mode {
    /// 给前端看的字符串（⛔ 不是 `Debug` 的名字，那是给人看的）。
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Directory => "directory",
            Mode::SingleFile => "single-file",
            Mode::Empty => "empty",
        }
    }
}

/// 会话状态。**一个进程一份**，用 [`Mutex`] 抱住。
pub struct Session {
    /// ⭐ 会话授权（安全核心）。
    pub grants: SessionGrants,
    /// `list_dir` 的结果缓存，键带代次（§2.1.3）。
    pub tree: TreeCache,
    /// 落盘的配置（侧边栏宽度 / 上次目录，§2.1.1 第 3、4 条）。
    pub config: Config,
    /// 配置文件的完整路径（Tauri 的 `app_config_dir()/config.json`）。
    pub config_path: PathBuf,
    /// **当前已提交文档**的所在目录（**已规范化**）。
    ///
    /// ⚠️ 它是相对图片的解析基准（§2.1.2 (3)：`doc_dir.join(src)`）。
    /// ⛔ 前端**不得**自己拼接路径——它只把文档里那个原始 `src` 字符串递回来。
    pub doc_dir: Option<PathBuf>,
    /// 启动参数里的那份文档（若有）。前端据此发起**第一次** `open_document`。
    pub startup_document: Option<PathBuf>,

    /// ⭐ **Apple Event 送来的打开请求**（`design/0015` §2.1 ④）。
    ///
    /// ⚠️ 为什么必须有这个队列，而不是"收到就 `emit` 一个带路径的事件"：
    /// ① **冷启动时事件可能早于前端的监听**（macOS 会先把 `odoc` 投给进程，
    ///    而 WebView 的脚本还没跑起来）——只发事件会**丢请求**；
    /// ② 事件载荷里的路径是**可伪造的**，而队列里的每一条都已在
    ///    [`commands::fs::authorize_startup`] 里过了一遍授权（`INV-APP-02`）。
    /// ⇒ 事件只当"有新东西"的唤醒信号；**路径只从后端取**（`INV-APP-03`）。
    ///
    /// ⚠️ 它**不是**授权、**不是**配置：随进程消亡，⛔ 不落盘、⛔ 不进 `config.json`
    /// （与 `watch` / `edit_target` 同一条取向）。
    /// ⚠️ 多个请求**按到达顺序**排队，前端依次打开（本期不做多窗口，§4）。
    pub pending_opens: VecDeque<PathBuf>,
    /// ⭐ **最近一次渲染的观测量**（`design/0007` §3.1：`INV-MATH-05` 的"可观测"出口）。
    ///
    /// ⚠️ **为什么由后端存、而不是让前端回报**：这些计数**只有后端算得出来**
    /// （`katex-rs` 在 Rust 侧跑），前端拿到的是一个 HTML 字符串，它无从数出
    /// "有几个公式因为累计触顶回退了"。让它原样回显一个它不理解的字符串，
    /// 只会多一份需要保持同步的协议字段，⛔ 换不来任何独立性
    /// （与 `Session::mode()` 拒绝第二个真值是同一条理由）。
    ///
    /// ⚠️ **它是"后端发给前端的最后一份"的观测量，不是"前端正在显示的那一份"**。
    /// 前端若在提交点丢弃了这份响应（代次陈旧），这里的数字会比界面上多一次——
    /// 冒烟判据用它时要知道这个边界；⛔ 但它**绝不会把触顶报成零**，
    /// 而"报成零"才是 §6 点名的那类失败。
    pub last_render_stats: crate::document::render::RenderStats,

    /// ⭐ **当前文档的规范路径**（`design/0006` §2.1 ③）。
    ///
    /// ⚠️ 它是 `reload_document` 与 `open_in_external_editor` 的**唯一**目标来源——
    /// 那两条命令**不收路径参数**（§2.1 ②）。理由不是省事：路径一旦由前端再传一次，
    /// 就有两个说法（"前端以为在显示的那份"与"后端确实渲染过的那份"），
    /// 而两者会脱节（前端丢弃了陈旧响应、后端照旧渲染了）。
    ///
    /// ⭐ **本字段有三个写入点**：`watch_document`、`drop_watch`，以及
    /// `commands::fs::rename_entry`（`design/0035` §3.5：改名成功后**迁移**到新路径，
    /// ⚠️ 它在同一个持锁闭包里先 `drop_watch` 再写新值，并立刻重启监视）。
    /// ⛔ 别在别处随手改它——`INV-EXT-03` 要的是"它一定过了 `check_readable`"。
    pub current_document: Option<PathBuf>,

    /// ⭐ **打开会话号**（`design/0017` §2.2 ①）：每成功提交一份 `open_document` 就 +1。
    ///
    /// ⚠️ 存在的唯一理由是**区分同一路径的两次打开**（A → B → A）：
    /// `current_document == path` 挡不住"同路径重开"后的迟到写入，
    /// 而 `watch_seq` 也不行——`ensureWatch` 在同一路径上直接 return（不产生新代号）。
    /// ⚠️ **自动重载（`reload_document`）不加**：那不是新会话。
    /// ⛔ 它不是授权、不是文档版本号：不参与任何 `check_readable` 判定。
    pub doc_seq: u64,

    /// ⭐ **编辑态的授权落点**（`design/0012` §2.4-1 / `INV-EDIT-02` 后半）。
    ///
    /// ⚠️ 它**不是**授权来源，而是「用户显式按了『进入编辑』」这个**动作**的记录：
    /// 写授权只能由这个动作产生，⛔ **不许**把读授权自动升级成写授权
    /// （「文件被读过了」 ≠ 「可以写它」）。
    ///
    /// ⚠️ 它**随进程消亡、⛔ 不落盘**（`adr/0007` / `INV-FS-03` 的形态照旧）。
    /// 退出编辑态 / 换文档 / 摘监视 ⇒ 立刻清掉。
    ///
    /// ⚠️ 它与 [`current_document`](Self::current_document) 的 `==` 是
    /// `save_document` 的**第二道**判据（第一道是 `check_writable`）——
    /// ⛔ 两道都要，⛔ 不许合并成一道：第一道管「这条路径本来就授权过吗」，
    /// 第二道管「用户现在真的在编辑它吗」。
    pub edit_target: Option<PathBuf>,

    /// ⭐ **「刚写下去的那份」的指纹** `(len, mtime_ns)`（`design/0012` §2.1 ④）。
    ///
    /// ⚠️ **口径先摆正**：它**只用来少做一次无用功**（自写事件不触发自载），
    /// ⛔ **不承担**「是否被外部修改过」的判定——那个判定在 `save_document` 第二段，
    /// 比的是**内容**（[`baseline_bytes`](Self::baseline_bytes)，`INV-EDIT-04` ①）。
    /// ⭐ 分开之后，指纹漏判的后果从「写错文件」降级为「多一次无谓的重载」。
    ///
    /// ⚠️ mtime 用**纳秒**（`i64`）：秒级分辨率下"同秒两次写"会撞，
    /// 而 §2.1 ④b 那句"碰撞概率极低"的前提正是纳秒。
    ///
    /// ⚠️ **写入点只有一个**：[`note_self_write`](Self::note_self_write)（评审第 11 条）。
    /// 它与监视里的已知指纹（`Watch::seen`）**同批更新**——两处各记各的，
    /// 症状是"保存完点一下刷新，正文白重载一次"。⛔ 别在别处直接赋值。
    pub self_write: Option<(u64, i64)>,

    /// ⭐ **保存在途标记**（`design/0012` §2.1 ④a 与 §2.4-4 的**同一个字段的两面**）。
    ///
    /// | 面 | 谁读它 | 读来干什么 |
    /// |---|---|---|
    /// | §2.1 ④a | `notify` 回调 | 指纹对不上时**不立刻当外部修改**，先延迟复核 |
    /// | §2.4-4 | `save_document` | 已有保存在途 ⇒ **拒掉新请求**（⛔ 不排队） |
    ///
    /// ⚠️ 它是 `Instant` 而不是 `bool`：§2.1 ④a 第 4 条要求「窗口**有上限**」，
    /// 而我们**不许留一个永久的吞事件状态**（那会让真正的外部修改**永久静默**）。
    /// ⇒ 读它的地方要判 [`INFLIGHT_MAX`](Self::INFLIGHT_MAX) 这个上界，
    /// ⛔ 不是「置过就一直算数」。
    pub save_inflight: Option<Instant>,

    /// ⭐ **编辑器手里那份缓冲是基于哪份磁盘内容来的**（`design/0012` §2.4-3 的**内容级基线**）。
    ///
    /// ⚠️ **为什么必须是内容而不是 `(len, mtime)`**：`touch` / 同步工具改 mtime
    /// 而内容不变 ⇒ 假冲突（用户被无故拦住）；反过来某些写入会**漏判**（真漏）。
    /// 内容比对**两个方向都不会错**，代价是每次保存多读一遍文件——
    /// ⚠️ 那**只在用户按下保存时**发生，是毫秒级（`design/0012` §1.3(d)）。
    ///
    /// ⚠️ 值的来源是 [`Envelope::raw_bytes`](crate::document::envelope::Envelope::raw_bytes)
    /// 的**精确反推**（`BOM ++ source`）——而那份 `source` 与 editor 缓冲
    /// ([`EditGrant::text`](crate::commands::edit::EditGrant::text)) 出自**同一次读盘**，
    /// 所以"文本"与"基线"是一个动作的两个投影，⛔ 不存在错配的窗口。
    ///
    /// ⭐ **只有两个写入点**（`INV-EDIT-04` ①）：
    ///
    /// | 谁 | 写成什么 |
    /// |---|---|
    /// | [`edit::begin_edit`] | 那次读盘的字节（**唯一生产者**） |
    /// | [`edit::save_document`] 的第三段 | 本次写出的字节 |
    ///
    /// ⚠️ **打开 / 重载 ⇒ 落基线**（`design/0012` §2.4-3 的原文措辞）**已被本实现取代**：
    /// 基线只在编辑态存在，`begin_edit` 是它唯一的起点，
    /// 而 `reload_document` **刻意不碰它**（那里有一整段注释说明为什么：
    /// 编辑态下换基线会开出一个"静默顶掉别人修改"的窗口）。
    /// ⇒ 已登记在 `design/0012` §10 实施记录。
    pub baseline_bytes: Option<Vec<u8>>,

    /// ⭐ **活着的文件监视**（`design/0006` §2.1 ③）。
    ///
    /// ⚠️ 它**不是**授权、**不是**配置，随进程消亡（§10.5：不需要额外的清理点）。
    /// ⚠️ drop 它是**异步**的（`external::watch` 模块头那段死锁），
    /// 所以统一走 [`Session::drop_watch`]。
    pub watch: Option<Watch>,

    /// 监视代号计数器（§2.1 ③ 的 `seq`）。⛔ 只增不减：前端拿它丢弃迟到事件。
    pub watch_seq: u64,

    /// ⭐ **后端见过的最大文档请求号**（`design/0006` §2.1 ⑤ 第三段）。
    ///
    /// ⚠️ 它存在的理由是三段式锁带来的新窗口：放锁渲染期间，
    /// 前端可能已经发起了**下一次**请求。此时这份渲染结果即使代次没变
    /// 也**不许提交**——它已经不是最新的了。
    /// ⛔ 前端那一侧当然也判（`latestReq`），但那是**显示**口径；
    /// 后端这一份保证"存进会话的状态"不被更旧的响应覆盖。
    ///
    /// ⚠️ 用 `max()` 递增：异步命令的**第一段**不保证按到达顺序执行
    /// （每个 `async fn` 命令都是被 spawn 出去的任务），取最大值才不会被
    /// 一个跑得快的旧请求把号拉回去。
    pub latest_doc_req: u64,

    /// ⭐ **文件名搜索的索引**（`design/0009` §2.1 ②）。
    ///
    /// ⚠️ 三条：① 它是**内存态**（随进程消失，⛔ 不落盘、⛔ 不碰 `config.json`）；
    /// ② 用 `Arc` 是为了**在锁外做匹配**——`search` 要遍历整份清单（5 万条约 2 ms），
    /// 放进 `with` 的临界区就等于每次按键都堵住 `notify` 的回调线程；
    /// ③ ⛔ 它**不是**"内容没变"的证据：代次只随 `roots` 变，
    /// 新建文件不会让代次动（`INV-SEARCH-06`）⇒ 重建时机见 `commands::fs::search_files`。
    pub index: Option<std::sync::Arc<tree::FileIndex>>,

    /// ⭐ **索引构建票号**（`design/0041` §2.1.2，R2 / `INV-DOCS-10`）。
    ///
    /// ⚠️ 它回答的是"**谁最后起步**"：同代次内可以有多份构建在跑，
    /// 代次只挡得住"换根"，挡不住"旧的建得慢、后完成覆盖新的"。
    /// 发布点核这一张票：只有 `ticket == index_ticket` 的那份能写进 [`index`](Self::index)。
    ///
    /// ⚠️ **无效化也必须涨票**（[`Session::invalidate_index`]）：
    /// 否则一份在无效化**之前**起步的构建回来时票号仍然相符，会把已经作废的索引复活。
    pub index_ticket: u64,

    /// ⭐ **索引发布版本**（`design/0041` §2.1.2）：每次成功发布 +1，
    /// 写进 [`FileIndex::rev`]，随 `DocListResult` 回给前端当提交判据。
    pub index_rev: u64,

    /// ⭐ **目录监视**（`design/0034` §2.1 A）：盯当前**那一个授权根**（递归，一条流）。
    ///
    /// ⚠️ 它与 [`watch`](Self::watch) 是**两个**监视、两套生命周期：
    /// 那个盯"当前文档"（非递归、带路径载荷），这个盯"整棵树的根"（递归、无载荷）。
    /// ⛔ 别把它们合并成一个句柄——它们的失效条件不同（换文档 vs 换根）。
    ///
    /// ⚠️ 它**不是授权**：监视只决定"要不要叫前端来重列"，
    /// 真正能不能读仍由每次 `list_dir` 过 `check_readable` 决定。
    /// 所以它出生在哪一份授权上并不提高任何权限——**它只监听，不读取**。
    ///
    /// ⚠️ 失败（权限、根太大）**不是致命**：`None` 表示"这一轮没有自动刷新"，
    /// 手动刷新照旧（`design/0034` §2.1 D）。
    pub tree_watch: Option<crate::external::watch::DirWatch>,

    /// ⭐ **根范围的磁盘状态**（`design/0050`）：内容修订 / 强制核对目标 / 监视健康 /
    /// 实例身份。⚠️ 纯内存，⛔ 不落盘、⛔ 不进 `config.json`。
    ///
    /// 它回答的是那个此前**没有任何字段能回答**的问题：
    /// "我们**现在**对盘上的认知对应哪一刻"（`INV-DISK-01`）。
    /// - [`epoch`](crate::disk::DiskState::epoch) ⇒ 树缓存与共享索引的失效判据；
    /// - [`watch_id`](crate::disk::DiskState::watch_id) ⇒ 跨实例 fencing
    ///   （旧监视的迟到结果不许改新监视的状态）；
    /// - `watcher` / `forced` / `reconciled` ⇒ **分开存**的健康与核对
    ///   （⛔ 合一个枚举会让 `Io → Rescan → 核对成功` 被洗白成 `Ok`）。
    pub disk: crate::disk::DiskState,

    /// ⭐ **是否已有一趟核对在跑**（`design/0050` 最终约束 1 的单飞位）。
    ///
    /// ⚠️ 它只是"**有没有**人在跑"，⛔ 不是"还差几次"——欠账全由
    /// [`DiskState::pending`]（`forced > reconciled`）表达。两者的分工：
    /// 这个字段防**并发**重复扫，`pending` 保证**合并过的请求不被漏掉**
    /// （跑完一轮再看一眼 `pending`，还有就补跑 ⇒ 尾随重跑）。
    pub reconcile_inflight: bool,

    /// ⭐ **最后一次发给前端的 `rmd://dir-watch` 修订号**（`design/0050` §2.3.3）。
    ///
    /// ⚠️ 它的唯一作用是**去重**：同一个派生状态不重复发。
    /// ⛔ 它**不是**第二个真值——真值在 [`DiskState::revision`]，这里只是"发到哪了"。
    pub last_disk_rev: u64,
}

/// ⭐ 「改名后重启监视」的注入结果（`design/0035` §3.5）。
///
/// ⚠️ 这个枚举存在只为**可单测**：[`Session::commit_rename`] 里除了"起监视"之外的
/// 每一步都是纯 `Session` 状态，而 `watch::start` 要 `&AppHandle` 与真 FSEvents。
/// 把结果收成这三态 ⇒ B6/B7 的矩阵能在 `--features gui` 下用真 `Session` 断言。
pub enum WatchRestart {
    /// 起好了，句柄在这里（**唯一**给产品代码用的形态）。
    Started(Watch),
    /// 起好了，但本次不保留句柄——⭐ **只给单测**（⛔ 产品代码不许用：
    /// 那会留下"后端以为有监视、实际没有"的假状态）。
    StartedWithoutHandle,
    /// 起失败 ⇒ `degraded: ["watch"]`（`current_document` 仍留在新路径）。
    Failed,
}

impl Session {
    /// ⭐ **保存在途标记的有效期上限**（10 秒）。
    ///
    /// ⚠️ 取值理由：正常保存是**毫秒级**（第二段只是一次重读 ＋ 一次 `rename`），
    /// 10 s 已经比任何正常路径宽 3 个数量级 ⇒ 它**只在意外路径上生效**，
    /// 存在的意义是"宁可多一次重载，也**不许**永久吞掉外部修改"。
    /// ⛔ 别把它调成 0（那等于取消 §2.1 ④a 的复核），
    /// ⛔ 也别调成一分钟以上（那才是"永久静默"的开端）。
    pub const INFLIGHT_MAX: std::time::Duration = std::time::Duration::from_secs(10);

    /// ⭐ **让文件名索引作废**（`design/0041` §2.1.2，R2）。
    ///
    /// 三件事**必须一起做**，⛔ 不能只写 `index = None`：
    /// ① 丢掉旧 `Arc`；② **票号 +1**（在途的旧构建回来时票号不符 ⇒ 不发布）；
    /// ③ 版本号**不动**（它只在"真的发布了新索引"时前进，前端据此判新旧）。
    ///
    /// 调用点：换根（[`crate::commands::fs::enter_directory`] 一侧）、收回授权、
    /// 改名迁移。⚠️ 换根本来就会让代次变化，票号是**第二道**——
    /// 它覆盖的是"同代次内的显式作废"。
    pub fn invalidate_index(&mut self) {
        self.index = None;
        self.index_ticket = self.index_ticket.wrapping_add(1);
    }

    /// ⭐ 模式是**推导**出来的，⛔ 不是存下来的第二个真值。
    ///
    /// 存一个 `mode` 字段就等于多了一份"必须与 `grants` / 文档保持一致"的状态，
    /// 而那份一致性**没有自动化防线**——完全靠人记得在每个写入点同步它
    /// （与 §2.1.2 (5) 拒绝第二个真值是同一条理由）。
    ///
    /// ⚠️ 这不是假想的风险：2026-10-13 实施时差点掉进去——
    /// 空会话里打开一份文档后，存下来的 `mode` 还停在 `Empty`，
    /// 而界面已经是单文件模式了。推导出来就没有这个可能。
    pub fn mode(&self) -> Mode {
        if self.grants.has_roots() {
            Mode::Directory
        } else if self.startup_document.is_some() {
            Mode::SingleFile
        } else {
            Mode::Empty
        }
    }

    /// ⭐ **摘下监视**（`design/0006` §2.1 ③ / `INV-EXT-09`）：清掉监视与当前文档。
    ///
    /// 两个调用点都有它：① `watch_document` 要换一份监视；
    /// ② 代次失效时（回调里 / 授权变更后）监视自动作废。
    ///
    /// ⚠️ **返回**被摘下的那份监视，⛔ 不在这里 drop 它——
    /// `Watch` 的 drop 是异步的（起一个一次性线程去停），
    /// 但把它**返回**出去让调用方看得见"确实摘下来了"，比就地丢掉更好排查。
    /// ⚠️ `current_document` 一并清掉是关键的一半：留着一个"后端以为在显示的文档"，
    /// 而它的监视已经没了，等于让 `⌘E` 与重载打向一份**可能已经不可读**的路径
    /// （那条路仍然会过 `check_readable`，所以不是漏洞，但它是个**静默的旧真值**）。
    ///
    /// ⭐ `design/0012` 起它**同时结束编辑态**（`end_edit` 的三个调用点之一）：
    /// 一份没有监视、也没有 `current_document` 的文档不可能还在被编辑，
    /// 而留下一个"孤儿写授权"是纯粹的风险面（`INV-EDIT-02` 的"退出编辑态即撤销"）。
    pub fn drop_watch(&mut self) -> Option<Watch> {
        self.current_document = None;
        self.end_edit();
        self.watch.take()
    }

    /// ⭐ **结束编辑态**：撤销写授权、清掉与"那一份缓冲"绑定的全部状态
    /// （`design/0012` §2.4-1 的「退出编辑态即撤销」）。
    ///
    /// ⚠️ 四个调用点：① `drop_watch`（换文档 / 监视失效）；
    /// ② `end_edit` 命令（用户按「退出编辑」）；③ `open_document` 成功提交后；
    /// ④ 代次失效（回调里）。
    ///
    /// ⚠️ 清 [`self_write`](Self::self_write) 与
    /// [`baseline_bytes`](Self::baseline_bytes) 是**顺手也是必须**的：
    /// 它们描述的是"上一份缓冲与磁盘的关系"，**换了一份文档之后它们就是旧的**，
    /// 而旧基线会让下一次保存的冲突检查**拿错参照物**（`INV-EDIT-04` ①）。
    /// ⛔ 反过来说：[`save_inflight`](Self::save_inflight) **不清**——
    /// 它描述的是"有没有一次写盘还在飞"，与文档无关，由写盘路径自己收尾。
    pub fn end_edit(&mut self) {
        self.edit_target = None;
        self.self_write = None;
        self.baseline_bytes = None;
    }

    /// ⭐ 判定保存在途标记**还算不算数**（`design/0012` §2.1 ④a 第 4 条）。
    ///
    /// ⚠️ 存在的理由是"**不许留一个永久的吞事件状态**"：标记理论上由写盘路径
    /// 在第三段清掉（成功失败都清），但一旦那条路径出了意外（panic / 早退），
    /// 一个永远为真的标记会让**真正的外部修改永久静默**——
    /// ⭐ 那比"多一次重载"坏得多（`INV-EDIT-04` 的违反后果那一栏两个方向都写了）。
    ///
    /// ⇒ 超过 [`INFLIGHT_MAX`](Self::INFLIGHT_MAX) 就**当作没有在途保存**，
    /// 于是事件回到"照常当外部修改"这条安全的一侧。
    pub fn inflight_active(&self) -> bool {
        matches!(self.save_inflight, Some(t) if t.elapsed() < Self::INFLIGHT_MAX)
    }

    /// ⭐ **登记一次自写**（`design/0012` §2.1 ④ ＋ 2026-10-29 代码评审第 11 条）。
    ///
    /// 它**同时**写两处，而这里是它们**唯一**的共同更新点：
    /// - [`self_write`](Self::self_write)：watcher 的判据——"别把这条事件当外部修改"；
    /// - [`Watch::seen`](crate::external::watch::Watch)：**最后一个我们确知的盘上指纹**
    ///   （主动核对 `reconcile_once` → `reconcile_current_document` 拿它与当刻指纹比）。
    ///
    /// ⚠️⚠️ **为什么不许两处各记各的**：此前保存只写 `self_write`，而 `seen` 只在
    /// 建监视时取一次、之后只由主动核对更新 ⇒ 一次 `⌘S` 之后盘上指纹变了而 `seen`
    /// 还是旧的 ⇒ 下一次**手动刷新**会把**我们自己刚写下去的那份**当成"外部修改"
    /// 报给前端。界面上表现为"保存完点一下刷新，正文莫名其妙重载一次"——
    /// 没有报错、没有日志异常，只是白重载（而重载会重置滚动锚点）。
    ///
    /// ⚠️ 判据是**路径相等**：写出去的不是当前监视着的那一份时（用户在保存途中切走了），
    /// ⛔ 不许拿它的指纹去改 `seen`——那是给另一份文档捏造一个"已知指纹"。
    pub fn note_self_write(&mut self, path: &std::path::Path, f: (u64, i64)) {
        self.self_write = Some(f);
        if let Some(w) = self.watch.as_mut() {
            w.note_known(path, f);
        }
    }

    /// ⭐⭐ **改名前的两道状态拦截**（`design/0035` §3.3.7 / `INV-RENAME-07`、`INV-RENAME-08`）。
    ///
    /// 只在**持锁处**调用，而且必须排在 `renamex_np` **之前**——这两条一旦
    /// "改完再判"，判出来的就是假保护：
    ///
    /// - ① **有保存在途 ⇒ 拒绝**（[`Denied::SaveInFlight`]）：保存的第二段
    ///   （放锁写盘）最后是 `std::fs::rename(tmp, real)`，而 `rename(2)`
    ///   **不要求目标存在**——改名先一步搬走了 `real`，那一下会在**旧路径重建**一个
    ///   新文件。事后第三段判 `Stale` 已经晚了：盘上多出一份。
    /// - ② **当前文档处于编辑态 ⇒ 拒绝**（[`Denied::NotRenamable`]，`reason = Editing`）：
    ///   改名要走 [`drop_watch`](Self::drop_watch)，它同时 `end_edit()`
    ///   （撤销写授权、清基线）⇒ 前端还挂着编辑器，但预览 / 保存全都会失败。
    ///   ⚠️ **干净也算**：判据是"编辑器还挂着"（`edit_target.is_some()`），⛔ 不是"脏"。
    ///
    /// ⚠️⚠️ ① 的判据是 [`save_inflight`](Self::save_inflight) **`.is_some()`**，
    /// ⛔ **不是** [`inflight_active`](Self::inflight_active)：后者的 10 s 上限是给
    /// watcher 事件语义用的（"⛔ 不许永久吞掉外部修改"）。一次**卡住**的写盘线程
    /// 不会因为过了 10 s 就消失——拿"时间到了"当"写盘已经收尾"，放行的正是本节要堵的洞。
    ///
    /// ⚠️ 两条的**范围不同**，这是有意的：编辑目标的身份是已知的（`edit_target`），
    /// 所以只拦"改当前文档"；保存目标的身份**没有**（`Session` 里没有"这次保存在写哪一份"），
    /// ⇒ 保守取法：有保存在途就拒绝**整棵树**的改名（代价通常 ≪ 1 s，换取零新状态）。
    pub fn rename_guard(&self, real: &Path) -> Result<(), Denied> {
        // ① 有保存在途（⛔ 不用 inflight_active 的 10 s 上限）
        if self.save_inflight.is_some() {
            return Err(Denied::save_in_flight(real));
        }
        // ② 当前文档正在编辑（⭐ 干净也算）
        if self.current_document.as_deref() == Some(real) && self.edit_target.is_some() {
            return Err(Denied::not_renamable(real, crate::error::RenameRefusal::Editing));
        }
        Ok(())
    }

    /// ⭐ **改名成功之后的状态迁移**（`design/0035` §3.5 那张表）。
    ///
    /// ⚠️ 抽出来只为**可断言**：`rename_entry` 够不到 Tauri 之外（`watch::start` 要
    /// `&AppHandle` 与真 FSEvents），而这里要动的七八个字段全是纯 `Session` 状态
    /// （`current_document` / `doc_dir` / `startup_document` / `watch_seq` /
    /// 树缓存 / 搜索索引 / 目录会话）。把"起监视"收成一个**注入的闭包**之后，
    /// B6（当前文档跟随、`doc_seq` 不变）与 B7（缓存与索引失效）就能在 `--features gui`
    /// 下用真 `Session` 测，⛔ 不用去凑一个 `AppHandle`。
    ///
    /// ⚠️ **前置条件**：`rename_guard` 已经判过（不在编辑态、没有保存在途）——
    /// 否则 [drop_watch](Self::drop_watch) 顺手做的 `end_edit()` 会撤销还在用的写授权。
    ///
    /// ⚠️ 调用它的**唯一**位置是 `rename_entry`，而且必须在 `renamex_np` **之后**：
    /// 盘上那一步不可撤销，状态只能往前迁（§3.5 / `INV-RENAME-05`）。
    ///
    /// 返回 `(current_moved, watch_seq, degraded)`；`degraded` **只含** `"watch"`
    /// （`"path_check"` 由调用方在改名后立刻复核，与本函数的注入点无关）。
    pub fn commit_rename(
        &mut self,
        real: &Path,
        to: &Path,
        restart_watch: impl FnOnce(&Path, u64) -> WatchRestart,
    ) -> (bool, u64, Vec<&'static str>) {
        let mut degraded: Vec<&'static str> = Vec::new();
        let mut watch_seq: u64 = 0;

        let current_moved = self.current_document.as_deref() == Some(real);
        if current_moved {
            // ⭐ `drop_watch` 顺带清 `current_document` 与编辑态（本轮已被拦截保证不在编辑）
            let old_watch = self.drop_watch();
            self.current_document = Some(to.to_path_buf());
            self.doc_dir = to.parent().map(|d| d.to_path_buf());
            let seq = self.next_watch_seq();
            match restart_watch(to, seq) {
                WatchRestart::Started(w) => {
                    self.watch = Some(w);
                    // ⭐ 新代号必须回给前端（见 `RenamedEntry::watch_seq` 的注释）
                    watch_seq = seq;
                }
                WatchRestart::StartedWithoutHandle => watch_seq = seq,
                WatchRestart::Failed => {
                    // ⚠️ `current_document` **仍留在新路径**（⛔ 不退回旧路径：盘上已经搬走了）
                    degraded.push(crate::fs::rename::DEGRADED_WATCH);
                }
            }
            // ⚠️ 异步停，不会在本线程 join（`external::watch` 模块头）
            drop(old_watch);
        }

        // ⚠️⚠️ 这一条**必须独立判**，⛔ 不能写成上面的 `else if`：
        //    单文件模式里"启动参数那份"**通常就是当前文档**——写成 `else if` 时
        //    它永远轮不到，`snapshot()` 的 `pending_directory` / `startup_document`
        //    就指着一个已经不存在的旧路径（下面那条单测就是这么把它抓出来的）。
        if self.startup_document.as_deref() == Some(real) {
            self.startup_document = Some(to.to_path_buf());
        }

        // 缓存与索引（⛔ 不新增 refresh 命令：重建代价由用户的显式动作承担）
        let generation = self.grants.root_generation();
        let epoch = self.disk.epoch;
        if let Some(parent) = to.parent() {
            self.tree.invalidate(generation, epoch, parent);
        }
        // ⭐ 索引作废**必须连票号一起涨**（`design/0041` R2）：在途的旧构建回来时不发布
        self.invalidate_index();

        // 目录会话里的 `last_file`（§3.5）。⚠️ `set_dir_session` 是**整条覆盖**，
        //    所以读出原 `expanded` 一并写回；失败**静默**（不影响改名结果）。
        let old_str = real.display().to_string();
        let new_str = to.display().to_string();
        let roots: Vec<String> = self
            .config
            .dir_sessions
            .iter()
            .filter(|(_, v)| v.last_file.as_deref() == Some(old_str.as_str()))
            .map(|(k, _)| k.clone())
            .collect();
        if !roots.is_empty() {
            for root in roots {
                let Some(mut d) = self.config.dir_session(&root).cloned() else { continue };
                d.last_file = Some(new_str.clone());
                self.config.set_dir_session(&root, d);
            }
            if let Err(e) = self.config.save(&self.config_path) {
                diag_stderr!("⚠️ 改名后目录会话没能落盘：{e}");
            }
        }

        (current_moved, watch_seq, degraded)
    }

    /// 取下一个监视代号。⛔ 从 1 开始：`0` 在协议里表示"没有监视"。
    pub fn next_watch_seq(&mut self) -> u64 {
        self.watch_seq += 1;
        self.watch_seq
    }

    /// ⭐ 收下一条 **Apple Event** 打开请求（`design/0015` §2.1 ④）。
    ///
    /// ⚠️ 调用方**必须**先过 [`crate::commands::fs::authorize_startup`]——
    /// 这里只排队，⛔ 不做任何授权判断（`INV-APP-02`：授权写点只有两处）。
    pub fn push_pending_open(&mut self, path: PathBuf) {
        self.pending_opens.push_back(path);
    }

    /// ⭐ 把待打开队列**取空**（`take_pending_open` 命令的唯一实现）。
    ///
    /// ⚠️ 取空而不是"取一条"：前端一次可能拿到多个请求（Finder 多选）
    /// 而它要按顺序全部打开。⛔ 不在这里做去重——同一份文档被连点两次
    /// 是用户的两个动作，让前端按顺序各提交一次即可（第二次是幂等显示）。
    pub fn take_pending_opens(&mut self) -> Vec<PathBuf> {
        std::mem::take(&mut self.pending_opens).into()
    }
}

/// Tauri 的托管状态。
///
/// ⚠️ **不 derive `Debug`**：`Session` 里装着 `Config`（含 `serde_json::Value`）、
/// 授权路径与缓存，为了一个调试打印给它们全加 `Debug` 不划算。
pub struct AppState(Mutex<Session>);

impl AppState {
    /// 包一个会话。
    pub fn new(session: Session) -> Self {
        AppState(Mutex::new(session))
    }

    /// 借用会话。
    ///
    /// ⚠️ 锁中毒时**取回内部值**而不是 panic：临界区里全是内存操作，
    /// 中毒只可能来自别的线程 panic，而"整棵树用不了"比"继续跑"更糟。
    ///
    /// ⚠️⛔ **临界区里只许放内存操作**（外加一次 `canonicalize`）。
    /// 这条从 `design/0006` §2.1 ⑤ 起是**硬约束**，不再只是风格：
    /// `notify` 的回调**在别的线程上**取这把锁（见 `external::watch::on_change`），
    /// 临界区一长，整个 FSEvents 的投递就被我们堵住；而渲染（10 MB 文档要 3.4 s）
    /// 进锁的代价更直接——**界面上一次重载，全窗口卡死**。
    /// ✅ 落地形式 = 三段式：持锁取快照 → **放锁**渲染 → 持锁核对后提交。
    pub fn with<T>(&self, f: impl FnOnce(&mut Session) -> T) -> T {
        let mut guard = match self.0.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        f(&mut guard)
    }
}

/// 前端启动时问一次的"现在是什么状态"。
///
/// ⚠️ 它是**唯一**能让前端知道 roots / 代次 / 未授权态的地方——
/// 前端不猜、不拼路径（`INV-TREE-01`）。
#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshot {
    /// 后端当前代次。前端每次请求都要原样带上它。
    pub generation: u64,
    /// 已授权的根目录（**已规范化**）。
    pub roots: Vec<String>,
    /// 已授权的单文件（**已规范化**）。
    pub files: Vec<String>,
    /// `"directory"` / `"single-file"` / `"empty"`。
    pub mode: &'static str,
    /// ⭐ **未授权态**要显示的那个目录（§2.1.4）。
    ///
    /// 单文件模式下 = 该文件的父目录。⚠️ 显示它**不算越权**：
    /// 这个字符串来自**用户自己刚选中的那个文件**，后端本来就有
    /// （`open_document` 收到的参数），**没有读取任何目录内容**。
    /// ⛔ 前端拿到它之后**不得**调 `list_dir`——那张表里写死了"允许的 IPC：无"。
    pub pending_directory: Option<String>,
    /// 侧边栏宽度（带默认值，已夹取）。
    pub sidebar_width: f64,
    /// ⭐ **外观**（主题 + 字号 / 行高 / 内容宽度）——`design/0004` + `design/0005`。
    ///
    /// ⚠️ 它与 `sidebar_width` **在同一个快照里**，因为它们是同一份配置
    /// （`INV-THEME-03`：主题名只有一份真值）。前端拿到它之后
    /// 在**首帧之前**就该把 `data-theme` 写上去。
    pub appearance: Appearance,
    /// 上次打开的目录（**只是路径提示**，⛔ 不是授权）。
    pub last_directory: Option<String>,
    /// 启动参数里的文档（有则前端要开它）。
    pub startup_document: Option<String>,
    /// ⭐ **打开会话号**（`design/0017` §2.2 ①）。前端把它记在 `state.docSeq` 上，
    /// 之后每次写进度原样带回来。
    pub doc_seq: u64,
    /// ⭐ **阅读进度全表**（`design/0017` §2.3 ①）：键 = 规范化后的真实路径。
    ///
    /// ⚠️ 只在**启动 / 授权变化**时随快照发一次；运行期的变化由
    /// `set_reading_progress` 的应答回写（前端恢复表不是第二个真值，
    /// 它是这份表的**只读镜像 ＋ 本地增量**）。
    pub reading_progress: std::collections::BTreeMap<String, ReadingProgress>,
    /// ⭐ **当前根目录的会话**（`design/0020` §2.2 ①，仅目录模式）。
    ///
    /// ⚠️ **派生值**：每次都从 config 现算，⛔ 不是"待消费的 pending"——
    /// 没有任何"取走"动作，重复读一百次结果一样。前端自己决定"这一代只恢复一次"。
    pub dir_session: Option<DirSession>,
    /// ⭐ **最近的目录**（`design/0038` §2.1 ①）：启动页那张表，最多 10 条。
    ///
    /// ⚠️ 同样是**派生值**（来源 = `config.dir_sessions` ＋ `last_directory`），
    /// ⛔ 不新增任何存储、⛔ 不是第二份真值（`INV-START-05`）。
    /// ⚠️ `design/0045` 起它还会随 `recent_apply` 的回包再下发一次（删一条 / 清空），
    /// 前端按**这份派生表**重画，⛔ 不自己从 `dir_sessions` 推。
    pub recent: Vec<RecentDir>,
    /// ⭐ **收藏**（`design/0043` §2.1）：**后端规范化后的绝对路径**，数组顺序 = 显示顺序。
    ///
    /// ⚠️ **它不是授权**（`INV-FAV-01`）。点其中一条必须走 `open_favorite` 的复核；
    /// ⛔ 前端别把这里的字符串直接喂给 `list_dir` / `open_document`。
    /// ⚠️ 快照给的是**磁盘上那份**（含已失效项），前端只做展示换算（`start.js`）。
    pub favorites: Vec<String>,
    /// ⭐ **生效的界面语言**（`design/0025` §2.4）：`"zh"` / `"en"`。
    ///
    /// ⚠️ **不新增"读语言"命令**：它跟其余会话事实一起走这一趟快照。
    /// ⚠️ 生效语言的**唯一裁定点在后端**（`INV-I18N-07`）：
    /// 前端 ⛔ 不许读 `navigator.language` 自己算一个——两份答案分叉的表现是
    /// "菜单中文、界面英文"（而没有任何报错）。
    pub language: &'static str,
    /// ⭐ **语言偏好**（`"system"` / `"zh"` / `"en"`）——设置里那一栏要显示它，
    /// ⛔ 不是生效语言。⚠️ 两者的区别对用户是可见的：「跟随系统」时生效语言可能是中文。
    pub language_preference: &'static str,
    /// ⭐ **侧边栏形态**（`design/0041` §2.3）：`"tree"` / `"list"`，缺键回 `"tree"`。
    /// ⚠️ 前端在**首帧之前**就要用它决定显示哪个容器（与 `appearance` 同族）。
    pub sidebar_file_view: &'static str,
    /// ⭐ **树里是否隐藏"子树没有 md"的目录**（`design/0041` §2.2），出厂 `true`。
    /// ⚠️ 它是 `config.json` 的键，**没有写命令**——只随快照下发给前端当过滤开关。
    pub hide_empty_dirs: bool,
    /// ⭐ **阅读—编辑连续性开关**（`design/0047` §8），出厂 `false`。
    ///
    /// ⚠️ 关着时前端**一条监听都不挂**（不是"半开着"）⇒ 单击不进覆盖层，行为回到 `design/0012`。
    /// ⚠️ 与 `hide_empty_dirs` 同族：`config.json` 的键，**没有写命令**，只随快照下发。
    pub live_edit: bool,
    /// ⭐ **根范围的磁盘状态快照**（`design/0050` §2.2.5）。
    ///
    /// ⚠️ **不新增"读磁盘状态"命令**：它跟其余会话事实一起走这一趟快照
    /// （与 `language` / `sidebar_file_view` 同族）。运行期的变化走
    /// `rmd://dir-watch` 事件，载荷是**同一份** [`crate::disk::DiskView`]。
    ///
    /// ⚠️ 它是**只读派生值**：⛔ 前端别拿它当"盘上真的没变"的证据——
    /// 它只表示"我们**收到的信号**处理到哪了"（`INV-DISK-11`）。
    pub disk: crate::disk::DiskView,
}

/// 一条"最近的目录"（`design/0038` §2.1 ①）。⚠️ **不是授权**，只是给人看的一行。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecentDir {
    /// 规范化后的绝对路径（`dir_sessions` 的键 / `last_directory` 的原字符串）。
    ///
    /// ⚠️ 它**逐字**就是后端记过的那个串——前端的 `open_recent_directory` 必须原样传回来
    /// （`INV-START-02` 的白名单是**字面比较**）。
    pub root: String,
    /// 上次在这个目录里读的那份文件（可能已不存在）。
    pub last_file: Option<String>,
    /// Unix 秒。⚠️ 补出来的 `last_directory` 行是 `0`——它**没有**时间戳，
    /// ⛔ 不拿"现在"或别的字段冒充。
    pub updated_at: u64,
    /// ⭐ 这条是不是「上次打开」那一条（`last_directory`）。前端只拿它加一个标记。
    pub last: bool,
}

/// 启动页最多显示多少行（`design/0038` §2.1 ①）。
///
/// ⚠️ 这是**显示上限**，与 `config::MAX_DIR_SESSIONS`（存储上限 20）**不是一回事**——
/// 配置容量一个字不改。取 10 与 Startify 的 `g:startify_files_number` 默认值一致
/// （`docs/research/notes/0031` §1.1）。
pub const RECENT_LIMIT: usize = 10;

/// 把 `config` 里的"最近"摊成启动页要的那张表（`design/0038` §2.1 ①）。
///
/// 规则（顺序就是判据）：
/// 1. `dir_sessions` 按 `updated_at` **降序**（同值按根路径升序，保证输出确定）；
/// 2. `last_directory` **不在**其中 ⇒ **最前面补一行**（`updated_at = 0`、`last = true`）；
///    在其中的，把那一行标成 `last = true`（它仍然是「上次打开」那一条）；
/// 3. **最后**统一截到 [`RECENT_LIMIT`] 条。
///
/// ⚠️ 第 2 步那条补行是必要的：只开过单文件 / 只点过一次面板的旧配置里
/// 可能**只有 `last_directory`**，没有对应的 `DirSession`。
pub fn recent_dirs(s: &Session) -> Vec<RecentDir> {
    let mut rows: Vec<RecentDir> = s
        .config
        .dir_sessions
        .iter()
        .map(|(root, d)| RecentDir {
            root: root.clone(),
            last_file: d.last_file.clone(),
            updated_at: d.updated_at,
            last: false,
        })
        .collect();
    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.root.cmp(&b.root)));

    if let Some(last) = s.config.last_directory.as_deref() {
        match rows.iter_mut().find(|r| r.root == last) {
            Some(row) => row.last = true,
            None => {
                // ⚠️ 只在表里找 `last_file`（找不到就是 `None`）；⛔ 不编时间戳
                let last_file = s.config.dir_session(last).and_then(|d| d.last_file.clone());
                rows.insert(
                    0,
                    RecentDir { root: last.to_string(), last_file, updated_at: 0, last: true },
                );
            }
        }
    }

    rows.truncate(RECENT_LIMIT);
    rows
}

/// 把当前会话摊成一份快照。
pub fn snapshot(s: &Session) -> SessionSnapshot {
    SessionSnapshot {
        generation: s.grants.root_generation(),
        roots: s.grants.roots().iter().map(|p| p.display().to_string()).collect(),
        files: s.grants.files().iter().map(|p| p.display().to_string()).collect(),
        mode: s.mode().as_str(),
        pending_directory: match s.mode() {
            Mode::Directory => s.grants.roots().first().map(|p| p.display().to_string()),
            Mode::SingleFile => {
                s.startup_document.as_ref().and_then(|p| p.parent()).map(|p| p.display().to_string())
            }
            // ⚠️ 空会话**没有**"所在目录"可显示——显示一个空的「所在目录：」
            //    比什么都不显示更让人困惑（§2.1.4 的未授权态是给单文件模式用的）。
            Mode::Empty => None,
        },
        sidebar_width: s.config.sidebar_width_or_default(),
        appearance: s.config.appearance(),
        last_directory: s.config.last_directory.clone(),
        startup_document: s.startup_document.as_ref().map(|p| p.display().to_string()),
        doc_seq: s.doc_seq,
        reading_progress: s.config.reading_progress.clone(),
        // ⚠️ 键必须与 `set_dir_session` 写入时用的**同一份规范化路径**
        //    （`roots()` 里那一份），⛔ 不用前端传来的原始串。
        dir_session: match s.mode() {
            Mode::Directory => s
                .grants
                .roots()
                .first()
                .and_then(|r| s.config.dir_session(&r.display().to_string()))
                .cloned(),
            _ => None,
        },
        // ⭐ `design/0038`：启动页那张表。⚠️ 派生值，`recent_dirs` 自己排序并截到 10。
        recent: recent_dirs(s),
        // ⭐ `design/0043`：收藏。⚠️ 原样下发（含失效项）——前端要能显示并管理它们。
        favorites: s.config.favorites.clone(),
        // ⚠️ **派生一次、字段填两处**：`language_preference()` 会把拼错的词归一成
        //    `"system"`，所以这里拿到的永远是 `config::LANGS` 里那三个之一。
        //    ⚠️ 显式档**不会** spawn（`lang::effective_with` 短路）；
        //    `system` 档走 `OnceLock` 缓存（启动时 `setup` 已经问过一次）⇒ 这次读是免费的。
        language: {
            let pref = s.config.language_preference();
            crate::lang::effective(pref).tag()
        },
        language_preference: s.config.language_preference(),
        // ⭐ `design/0041`：形态与空目录过滤开关。两者都**归一过**（坏值回出厂），
        //    前端不需要再判一次。
        sidebar_file_view: s.config.sidebar_file_view(),
        hide_empty_dirs: s.config.hide_empty_dirs(),
        // ⭐ `design/0047` §8：出厂关着 ⇒ 前端**一条监听都不挂**（回滚路径）。
        live_edit: s.config.live_edit(),
        // ⭐ `design/0050`：磁盘状态。⚠️ 与 `rmd://dir-watch` 的载荷**同一份形状**，
        //    前端因此只有一套解析（⛔ 别在这里多塞几个方便字段）。
        disk: s.disk.view(),
    }
}

/// 前端启动时问一次。
#[tauri::command]
pub fn get_session(state: tauri::State<'_, AppState>) -> SessionSnapshot {
    // ⚠️ 写成闭包而不是 `state.with(snapshot)`：`with` 收的是 `FnOnce(&mut Session)`，
    //    而 `snapshot` 是 `fn(&Session)`——函数项**不会**在泛型参数位置自动补上
    //    这个 `&mut` → `&` 的重借（`E0631`）。
    let snap = state.with(|s| snapshot(s));
    // ⚠️ 这一行是**诊断的锚点**，不是装饰：前端"到底跑到哪一步"只有后端知道。
    //    实测教训（2026-10-13）：没有它时，前端在 `get_session` 之前就静默卡住，
    //    而日志里只有"会话：模式=…"一行——分不清"没跑"与"跑到这一步失败"。
    diag!(
        "▶ get_session：模式={} 代次 {} 根 {} 个／文件 {} 个 侧栏宽 {:.0}",
        snap.mode,
        snap.generation,
        snap.roots.len(),
        snap.files.len(),
        snap.sidebar_width
    );
    snap
}

/// ⭐ **取走 Apple Event 送来的打开请求**（`design/0015` §2.1 ④）。
///
/// ⚠️ 这是 `design/0015` **唯一**新增的命令，而且它是一条**读取命令**：
/// ⛔ 不收路径参数、⛔ 不改 `SessionGrants`。授权在 `gui/mod.rs` 收到 Apple Event
/// 的那一刻就走完了既有入口 [`fs::authorize_startup`]（`INV-APP-02`）。
/// ⇒ 前端拿到的每一条路径**都已经在授权集合里**，它没有多出任何"要什么读什么"的能力。
///
/// ⚠️ 返回**规范化的真实路径**（`authorize_startup` 的返回值），⛔ 不是事件里那个原始串。
#[tauri::command]
pub fn take_pending_open(state: tauri::State<'_, AppState>) -> Vec<String> {
    let paths = state.with(|s| s.take_pending_opens());
    for p in &paths {
        // ⚠️ 与 `get_session` 那行同一条理由：前端"到底取到了什么"只有后端知道，
        //    而冒烟判据要能从 stderr 上把它按标记取出来（§7.1 第 9 条）。
        diag!("▶ 取走待打开：{}", p.display());
    }
    paths.into_iter().map(|p| p.display().to_string()).collect()
}

/// 侧边栏宽度变了（拖动结束 / 首次落默认值）。
///
/// ⚠️ 这是**唯一**会写配置文件的命令，而且写的是"界面偏好"——
/// ⛔ 它**不碰授权**（`INV-FS-04`：只有授权命令能改授权，而这条根本不是授权命令）。
#[tauri::command]
pub fn set_sidebar_width(state: tauri::State<'_, AppState>, width: f64) -> Result<f64, String> {
    Ok(state.with(|s| {
        s.config.set_sidebar_width(width);
        let applied = s.config.sidebar_width_or_default();
        if let Err(e) = s.config.save(&s.config_path) {
            // ⚠️ 存不下来**不是**致命错误：宽度已经生效，只是下次要重拖。
            //    这里只往 stderr 说一句，⛔ 不把 UI 卡在这件事上。
            diag_stderr!("⚠️ 侧边栏宽度存不下来（本次仍然生效）：{e}");
            diag_file!(
                "⚠️ 侧边栏宽度存不下来 err_class={} err_len={}",
                logging::err_class(&e),
                e.to_string().len()
            );
        }
        applied
    }))
}

/// ⭐ **侧边栏形态写盘**（`design/0041` §2.3 / R5）。
///
/// 与 [`set_sidebar_width`] 的差别只在**失败语义**：形态是"用户显式选了一个模式"，
/// 存不下来要让他知道（回 `Err`，前端置 dirty 并显示"这次的选择未能保存"）；
/// 而宽度是拖出来的，存不下来不值得打断。
///
/// ⚠️ 只接受 `"tree"` / `"list"`：其它值一律归一成 `"tree"`（⛔ 不产生第三种形态）。
/// ⛔ 它**不碰授权**、⛔ 不改根、⛔ 不动当前文档（`INV-DOCS-07`）。
#[tauri::command]
pub fn set_sidebar_file_view(
    state: tauri::State<'_, AppState>,
    view: String,
) -> Result<&'static str, String> {
    state.with(|s| {
        s.config.set_sidebar_file_view(&view);
        let applied = s.config.sidebar_file_view();
        if let Err(e) = s.config.save(&s.config_path) {
            diag_stderr!("⚠️ 侧边栏形态存不下来（本次仍然生效）：{e}");
            diag_file!(
                "⚠️ 侧边栏形态存不下来 err_class={} err_len={}",
                logging::err_class(&e),
                e.to_string().len()
            );
            return Err(format!("{e}"));
        }
        Ok(applied)
    })
}

/// ⭐ **外观写盘**（主题 + 字号 / 行高 / 内容宽度）——`design/0004` §2.1.4.1 规则 2。
///
/// # 为什么是一整份，而不是四个各自的小命令
///
/// `INV-THEME-05`：**写的是取当前 `applied` 全量**，⛔ 不是"发请求那一刻的快照"。
/// 四个独立命令会让"500 ms 内改字号 5 次 + 中途切一次主题"变成四次并发写，
/// 各自带一份旧快照，**后者覆盖前者的改动**——
/// 表现是"我明明改了字号，切了个主题它又回去了"，而两次操作单独看都没问题。
///
/// # 关于返回 `Err`
///
/// ⚠️ 写盘失败时**返回错误**（而不是打条日志返回 Ok）：前端据此把 `dirty` 置上，
/// 工具栏就会显示「上次的设置未能保存」（`INV-THEME-06`）。
/// ⛔ 那条**不是弹窗**——设置写不进去不值得打断阅读，但也不许两边都静默。
#[tauri::command]
pub fn set_appearance(
    state: tauri::State<'_, AppState>,
    appearance: Appearance,
) -> Result<Appearance, String> {
    state.with(|s| {
        s.config.set_appearance(&appearance);
        // ⚠️ 回带**夹取之后**的值：前端的乐观更新可能比后端的合法范围更宽，
        //    不带回去就会出现"界面写着 40px、磁盘上是 28px"这种两个真值。
        let applied = s.config.appearance();
        if let Err(e) = s.config.save(&s.config_path) {
            diag_stderr!("⚠️ 外观存不下来（本次仍然生效）：{e}");
            diag_file!(
                "⚠️ 外观存不下来 err_class={} err_len={}",
                logging::err_class(&e),
                e.to_string().len()
            );
            return Err(format!("{e}"));
        }
        Ok(applied)
    })
}

/// ⭐ **记录"用户读到哪"**（`design/0017` §2.2 ②）。
///
/// ⚠️ 三条边界：
/// ① 它**只写 `config.json`**——⛔ 不读文档、⛔ 不改授权、⛔ 不新增可读路径
///    （`INV-PROG-01`：删掉整张表，读写能力一个字节都不变）；
/// ② `path` 由前端递回，但**用身份双判据挡住伪造**：它必须**恰好等于**
///    `Session.current_document`，且 `doc_seq` **相等**（⛔ 不是 `≥`）；
/// ③ `stale` **不抛 `Err`**——切文档 / 同路径重开后的迟到 IPC 是**预期形态**，
///    把它变成红色错误只会让正常切文档看起来像故障。
#[tauri::command]
pub fn set_reading_progress(
    state: tauri::State<'_, AppState>,
    path: String,
    doc_seq: u64,
    progress: ReadingProgress,
) -> ProgressWriteResult {
    state.with(|s| apply_reading_progress(s, &path, doc_seq, progress))
}

/// [`set_reading_progress`] 的**全部判定**（拆出来只为可测，见 §7.2）。
///
/// ⚠️ 命令体只是“取锁 + 调它”，⛔ 判定不许在两处各写一份。
pub fn apply_reading_progress(
    s: &mut Session,
    path: &str,
    doc_seq: u64,
    progress: ReadingProgress,
) -> ProgressWriteResult {
    // ⚠️ 两条判据缺一不可：`doc_seq` 是会话号（不记路径），
    //    `current_document` 才说明"这个号对应的是哪一份"。
    if s.current_document.as_deref() != Some(Path::new(path)) || s.doc_seq != doc_seq {
        // ⚠️ 不记每一条 stale 的日志：滚动结束就写一次，切文档时必然产生若干条，
        //    逐条打会把 stderr 淹掉（而那些**都是正常的**）。
        return ProgressWriteResult { status: "stale", entry: None, evicted: Vec::new() };
    }
    let out = s.config.set_reading_progress(path, progress);
    let Some(entry) = out.entry else {
        // ⚠️ "这条没有任何可用信息" ⇒ 不写盘，⛔ 也不动恢复表里已有的那一条。
        return ProgressWriteResult { status: "ignored", entry: None, evicted: Vec::new() };
    };
    let status = match s.config.save(&s.config_path) {
        Ok(()) => "ok",
        Err(e) => {
            // ⚠️ 与外观那条同族：**内存里已经写进去了**，只是没落盘。
            //    返回 `persist_failed` 而不是 `Err`，前端据此把它并入恢复表
            //    （下次任意配置写入会顺带把它写下去）。
            diag_stderr!("⚠️ 阅读进度存不下来（本次仍然记住）：{e}");
            diag_file!(
                "⚠️ 阅读进度存不下来 err_class={} err_len={}",
                logging::err_class(&e),
                e.to_string().len()
            );
            "persist_failed"
        }
    };
    ProgressWriteResult { status, entry: Some(entry), evicted: out.evicted }
}

/// [`set_reading_progress`] 的返回值（`design/0017` §2.2 ②）。
#[derive(Debug, Serialize)]
pub struct ProgressWriteResult {
    /// `"ok"` | `"stale"` | `"ignored"` | `"persist_failed"`。
    pub status: &'static str,
    /// 后端清洗并盖章后的条目（`ok` / `persist_failed` 时 `Some`）。
    pub entry: Option<ReadingProgress>,
    /// 本次写入触发淘汰的路径（供前端同步删表）。
    pub evicted: Vec<String>,
}

/// ⭐ **记录"这个目录上次离开时的样子"**（`design/0020` §2.2 ②）。
///
/// ⚠️ 三条边界：
/// ① 它**只写 `config.json`**——⛔ 不读文档、⛔ 不改授权、⛔ 不新增可读路径
///    （`INV-SESS-01/03`：删掉整张表，读写能力一个字节都不变）；
/// ② `root` 由前端递回，但必须**恰好等于**当前授权的那个根（⛔ 子目录也不行）；
/// ③ `stale` **不抛 `Err`**——切目录时的迟到写是**预期形态**。
#[tauri::command]
pub fn set_dir_session(
    state: tauri::State<'_, AppState>,
    root: String,
    generation: u64,
    last_file: Option<String>,
    expanded: Vec<String>,
) -> DirSessionWriteResult {
    state.with(|s| apply_dir_session(s, &root, generation, last_file, expanded))
}

/// [`set_dir_session`] 的**全部判定**（拆出来只为可测，见 §7.2）。
///
/// ⚠️ 命令体只是"取锁 + 调它"，⛔ 判定不许在两处各写一份。
pub fn apply_dir_session(
    s: &mut Session,
    root: &str,
    generation: u64,
    last_file: Option<String>,
    expanded: Vec<String>,
) -> DirSessionWriteResult {
    // 判据 1：代次。⚠️ 不记每条 stale 的日志（切目录时必然产生若干条，都是正常的）。
    if generation != s.grants.root_generation() {
        return DirSessionWriteResult { status: "stale", entry: None, evicted: Vec::new() };
    }

    // 判据 2：`root` 规范化后**恰好等于**某个授权根。
    // ⚠️ 规范化走既有入口 `check_readable`（它自带 `canonicalize`），
    //    ⛔ 不在这里写第二份 path 比较。⚠️ 这不是授权判断——授权早就发生过了，
    //    这里只回答"你写的这个根是不是当前授权的那个根"。
    let Ok(real) = s.grants.check_readable(Path::new(root)) else {
        return DirSessionWriteResult { status: "stale", entry: None, evicted: Vec::new() };
    };
    if !s.grants.roots().iter().any(|r| *r == real) {
        // ⚠️ 子目录也落这里：子目录不是"这一代会话"的键（`INV-SESS-02`）。
        return DirSessionWriteResult { status: "stale", entry: None, evicted: Vec::new() };
    }
    let key = real.display().to_string();

    // 判据 3：清洗后为空 ⇒ 合法空状态，删掉该条（`INV-SESS-12`），⛔ 不是 ignored。
    let out = s.config.set_dir_session(
        &key,
        DirSession { last_file, expanded, updated_at: 0 },
    );
    let cleared = out.entry.is_empty();

    let status = match s.config.save(&s.config_path) {
        Ok(()) => {
            if cleared {
                // ⚠️ 落一行日志（`design/0020` §2.1 ③ 的代价那一段）：
                //    一个自己发空载荷的前端 bug 会把记录删掉，而症状是
                //    "下次打开什么都没恢复"——不崩溃、不报错，只能靠这一行找回来。
                diag!("目录会话已清空（空载荷 = 合法状态） path={key}");
                "cleared"
            } else {
                "ok"
            }
        }
        Err(e) => {
            // ⚠️ 与进度 / 外观同族：内存已记住，只是没落盘。
            diag_stderr!("⚠️ 目录会话存不下来（本次仍然记住）：{e}");
            diag_file!(
                "⚠️ 目录会话存不下来 err_class={} err_len={}",
                logging::err_class(&e),
                e.to_string().len()
            );
            "persist_failed"
        }
    };
    DirSessionWriteResult { status, entry: Some(out.entry), evicted: out.evicted }
}

/// [`set_dir_session`] 的返回值（`design/0020` §2.2 ②）。
#[derive(Debug, Serialize)]
pub struct DirSessionWriteResult {
    /// `"ok"` | `"cleared"` | `"stale"` | `"persist_failed"`。
    pub status: &'static str,
    /// 后端清洗并盖章后的条目。
    /// ⚠️ `ok` / `cleared` / `persist_failed` 时是 `Some`——**`cleared` 时它是空会话**，
    /// 前端按**载荷本身**更新镜像（`design/0020` §2.2 ② 末尾那一段）。
    pub entry: Option<DirSession>,
    /// 本次写入触发淘汰的根路径（仅供诊断；前端镜像只有当前根一条）。
    pub evicted: Vec<String>,
}

/// ⭐ 收藏的写操作（`design/0043` §2.2）——**一条命令 ＋ 操作枚举**。
///
/// ⚠️ ⛔ 不拆成 `add_favorite` / `remove_favorite` / `move_favorite` 三条命令（`INV-FAV-04`）；
/// 也⛔ 不接受"前端交整份列表"——那样两个并发操作会各自从旧快照提交，结构上就丢更新。
///
/// ⚠️ `path` 是**记录里的原字符串**（`Add` 是用户点中的那一项、`Remove`/`Move` 是快照里那一条）：
/// - `Add`：先过当刻读取授权（`check_readable`），写入的是它返回的 `real`；
/// - `Remove` / `Move`：**不查可达**——失效项必须能被删掉、被重排（`INV-FAV-06`）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FavoriteOp {
    /// 收藏一项（目录 / Markdown 普通文件）。⚠️ 必须在当刻授权范围内。
    Add {
        /// 用户点中的那一项（路径）。
        path: String,
    },
    /// 取消收藏。⚠️ 缺项 = 无操作成功（幂等）。
    Remove {
        /// 要移除的那条记录（逐字匹配）。
        path: String,
    },
    /// 调整顺序。⚠️ 缺项 / 越界 / 同位置 = 无操作成功，⛔ 不夹取到边界。
    Move {
        /// 要移动的那条记录（逐字匹配）。
        path: String,
        /// 目标下标（0 起）。
        to: usize,
    },
}

/// ⭐ 最近目录的**删除操作**（`design/0045`）——**一条命令 ＋ 操作枚举**。
///
/// ⚠️ 用户 2026-10-25 原话：「最近打开的目录也可以清空，删除，为了隐私考虑。」
/// ⇒ 这条命令**只改这份历史**（`config.dir_sessions` ＋ `last_directory`），
/// ⛔ 不删磁盘上的任何东西、⛔ 不动授权、⛔ 不动收藏。
///
/// ⚠️ 与 [`FavoriteOp`] 同形：⛔ 不接受"前端交整份最近列表"——那会让两个并发操作
/// 各自从旧快照提交，结构上就丢更新（复评 §3 的失败形态）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecentOp {
    /// 从这份历史里删掉一条。⚠️ 缺项 = 无操作成功（幂等）。
    Remove {
        /// 启动页那一行的 `root`——**后端给的原串**（⛔ 不是 `~` 缩写）。
        path: String,
    },
    /// 清空整份历史。⚠️ 已经是空的 = 无操作成功。
    Clear,
}

/// ⭐ 最近目录的**唯一写入口**（`design/0045`）。
#[tauri::command]
pub fn recent_apply(
    state: tauri::State<'_, AppState>,
    op: RecentOp,
) -> Result<SessionSnapshot, Denied> {
    state.with(|s| {
        apply_recent_op(s, op)?;
        Ok(snapshot(s))
    })
}

/// [`recent_apply`] 的**全部判定**（拆出来只为可测）。
///
/// # 事务形态（与 [`apply_favorite_op`] 逐条同形）
///
/// ① 在**候选配置**上应用操作；② **保存成功**才赋回 `s.config`；③ 没有任何变化
/// ⇒ **一个字节都不写盘**（也就不会因为"本来就没有"而报一句写盘失败）。
///
/// # ⚠️ `last_directory` 必须跟着清（这条是"删了又回来"的唯一根因）
///
/// [`recent_dirs`] 的第 2 步会把 `last_directory` **补回表头**（`updated_at = 0`、
/// `last = true`）。所以只删 `dir_sessions` 里那一项 ⇒ 用户点「删除」之后
/// **那一行原地复活**，看起来像没生效。⇒ 删一条时若它正是 `last_directory`，
/// 两份一起清；`Clear` 时两份都清。
pub fn apply_recent_op(s: &mut Session, op: RecentOp) -> Result<(), Denied> {
    let mut candidate = s.config.clone();

    let changed = match &op {
        RecentOp::Remove { path } => {
            let removed = candidate.dir_sessions.remove(path.as_str()).is_some();
            // ⚠️ 逐字比较（与 `INV-START-02` 的白名单同口径）：记录侧⛔ 不规范化。
            let was_last = candidate.last_directory.as_deref() == Some(path.as_str());
            if was_last {
                candidate.last_directory = None;
            }
            removed || was_last
        }
        RecentOp::Clear => {
            let changed =
                !candidate.dir_sessions.is_empty() || candidate.last_directory.is_some();
            candidate.dir_sessions.clear();
            candidate.last_directory = None;
            changed
        }
    };

    // ⚠️ 没变化就不写盘：否则"清空一个本来就空的表"会回一句写盘失败（磁盘满 / 只读），
    //    而用户手里没有任何东西可以再改。
    if !changed {
        return Ok(());
    }

    // ⭐ 保存成功才提交内存（候选配置）。写盘失败归 `Io`：前端要能说"没删下来"，
    //    ⛔ 不能说成"未授权"。
    candidate
        .save(&s.config_path)
        .map_err(|e| Denied::io(&s.config_path, e))?;
    s.config = candidate;
    Ok(())
}

/// ⭐ 收藏的**唯一写入口**（`design/0043` §2.2、`INV-FAV-04/07`）。
#[tauri::command]
pub fn favorites_apply(
    state: tauri::State<'_, AppState>,
    op: FavoriteOp,
) -> Result<SessionSnapshot, Denied> {
    state.with(|s| {
        apply_favorite_op(s, op)?;
        Ok(snapshot(s))
    })
}

/// [`favorites_apply`] 的**全部判定**（拆出来只为可测）。
///
/// # 事务形态（复评 §4，⭐ 顺序就是判据）
///
/// ① 在**候选配置**（`Config` 的 clone）上应用操作；
/// ② **保存成功**才把它赋回 `s.config`；
/// ⇒ 任何一步失败（含写盘）时，内存与磁盘**一个字节都不变**（`INV-FAV-04`）。
/// ⛔ 不许"先改 `s.config` 再 `save?`"——那会在写盘失败时留下一份**只在本次会话里存在**的收藏。
///
/// # 各操作的口径
///
/// - `Add`：`check_readable` → `real`；只接受**现有目录**或 **Markdown 普通文件**
///   （⛔ FIFO / 设备 / 套接字 / 其它后缀）；已存在（逐字等于 `real`）⇒ 无操作成功；
///   满 [`config::FAVORITES_LIMIT`] ⇒ `LimitReached`（⛔ 不静默淘汰）。
/// - `Remove`：逐字匹配删除；缺项 ⇒ 无操作成功（幂等）。
/// - `Move`：逐字匹配；缺项 / `to` 越界 / `to` 已是当前位置 ⇒ 无操作成功。
/// - ⚠️ 三者都**不规范化、不重新解析**既有项：失效项是用户的记录，⛔ 不因一次重排被清掉。
pub fn apply_favorite_op(s: &mut Session, op: FavoriteOp) -> Result<(), Denied> {
    let mut candidate = s.config.clone();

    match &op {
        FavoriteOp::Add { path } => {
            // ⭐ `INV-FAV-07`：先过当刻读取授权——不在已打开范围里的路径根本写不进去。
            //    ⚠️ 这不是"第二条授权路径"：`check_readable` 只回答"能不能读"，
            //    它**不新增**任何可读路径（`INV-FS-01/04`）。
            let real = s.grants.check_readable(Path::new(path))?;
            if !(real.is_dir() || (real.is_file() && link::is_markdown(&real))) {
                // ⚠️ 存在但类型不对（FIFO / 设备 / 非 Markdown 文件）⇒ 未授权，
                //    与"不在已打开范围"同一个答复，⛔ 不差别化成目录探测。
                return Err(Denied::not_authorized(Path::new(path)));
            }
            let real_str = real.display().to_string();
            if candidate.favorites.iter().any(|f| f == &real_str) {
                return Ok(());
            }
            if candidate.favorites.len() >= FAVORITES_LIMIT {
                return Err(Denied::limit_reached("favorites", FAVORITES_LIMIT));
            }
            candidate.favorites.push(real_str);
        }
        FavoriteOp::Remove { path } => {
            candidate.favorites.retain(|f| f != path);
        }
        FavoriteOp::Move { path, to } => {
            let Some(from) = candidate.favorites.iter().position(|f| f == path) else {
                return Ok(());
            };
            // ⚠️ 越界⛔ 不夹取：那会把"点错了"变成"确实移动了"；
            //    `to == from` 同位置也一样，无操作成功。
            if *to >= candidate.favorites.len() || *to == from {
                return Ok(());
            }
            let item = candidate.favorites.remove(from);
            candidate.favorites.insert(*to, item);
        }
    }

    // ⭐ 保存成功才提交内存（候选配置）。
    //    ⚠️ 写盘失败归 `Io`：前端要能说"没存下来"，而⛔ 不能说成"未授权"。
    candidate
        .save(&s.config_path)
        .map_err(|e| Denied::io(&s.config_path, e))?;
    s.config = candidate;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一份只够测 `set_reading_progress` 的会话。
    ///
    /// ⚠️ `config_path` 落在临时目录里：**这些测试真的会写盘**（那正是 #6 要验的
    /// “`save` 到底有没有被调用”的一半）。用 pid 隔离，避免并行测试互相踩。
    fn session(config_path: std::path::PathBuf) -> Session {
        Session {
            grants: SessionGrants::new(),
            tree: TreeCache::new(),
            config: Config::default(),
            config_path,
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
            index_ticket: 0,
            index_rev: 0,
            tree_watch: None,
            disk: crate::disk::DiskState::new(),
            reconcile_inflight: false,
            last_disk_rev: u64::MAX,
        }
    }

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rmd-progress-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn prog(id: Option<&str>, ratio: Option<f64>) -> ReadingProgress {
        ReadingProgress { id: id.map(str::to_string), ratio, ..Default::default() }
    }

    #[test]
    fn 进度命令_身份相符时ok且写进表() {
        let dir = tmp_dir("ok");
        let mut s = session(dir.join("config.json"));
        s.current_document = Some(PathBuf::from("/a.md"));
        s.doc_seq = 3;
        let r = apply_reading_progress(&mut s, "/a.md", 3, prog(Some("h1"), Some(0.5)));
        assert_eq!(r.status, "ok");
        assert!(s.config.reading_progress_of("/a.md").is_some());
        assert!(dir.join("config.json").exists(), "ok 意味着真的落盘了");
    }

    #[test]
    fn 进度命令_没有当前文档时stale且不新增键() {
        let dir = tmp_dir("none");
        let mut s = session(dir.join("config.json"));
        let r = apply_reading_progress(&mut s, "/a.md", 0, prog(Some("h1"), None));
        assert_eq!(r.status, "stale");
        assert!(s.config.reading_progress.is_empty());
        assert!(!dir.join("config.json").exists(), "stale 不许有任何写盘副作用");
    }

    #[test]
    fn 进度命令_当前是另一份时stale且旧条目不动() {
        let dir = tmp_dir("other");
        let mut s = session(dir.join("config.json"));
        s.current_document = Some(PathBuf::from("/b.md"));
        s.doc_seq = 1;
        s.config.set_reading_progress_at("/b.md", prog(Some("h1"), Some(0.1)), 100);
        let before = s.config.reading_progress_of("/b.md").cloned();
        let r = apply_reading_progress(&mut s, "/a.md", 1, prog(Some("h1"), Some(0.9)));
        assert_eq!(r.status, "stale");
        assert_eq!(s.config.reading_progress_of("/b.md").cloned(), before);
        assert!(s.config.reading_progress_of("/a.md").is_none());
    }

    #[test]
    fn 进度命令_同路径旧会话号时stale() {
        // ⭐ A → B → A：A 的迟到写入带着**上一轮**的会话号。
        let dir = tmp_dir("reopen");
        let mut s = session(dir.join("config.json"));
        s.current_document = Some(PathBuf::from("/a.md"));
        s.doc_seq = 2; // 第二次打开 A
        s.config.set_reading_progress_at("/a.md", prog(Some("old"), Some(0.2)), 100);
        let before = s.config.reading_progress_of("/a.md").cloned();
        let r = apply_reading_progress(&mut s, "/a.md", 1, prog(Some("late"), Some(0.8)));
        assert_eq!(r.status, "stale");
        assert_eq!(s.config.reading_progress_of("/a.md").cloned(), before, "旧值一个字不许动");
    }

    #[test]
    fn 进度命令_超前的会话号也是stale() {
        let dir = tmp_dir("ahead");
        let mut s = session(dir.join("config.json"));
        s.current_document = Some(PathBuf::from("/a.md"));
        s.doc_seq = 2;
        let r = apply_reading_progress(&mut s, "/a.md", 3, prog(Some("h1"), None));
        assert_eq!(r.status, "stale", "判据是相等，⛔ 不是 ≥");
    }

    #[test]
    fn 进度命令_不可用条目ignored且不写盘() {
        let dir = tmp_dir("ignored");
        let mut s = session(dir.join("config.json"));
        s.current_document = Some(PathBuf::from("/a.md"));
        s.doc_seq = 1;
        let r = apply_reading_progress(&mut s, "/a.md", 1, prog(None, None));
        assert_eq!(r.status, "ignored");
        assert!(!dir.join("config.json").exists(), "ignored 不许调用 save");
        assert!(s.config.reading_progress.is_empty());
    }

    #[test]
    fn 进度命令_save失败时persist_failed但内存里有() {
        // ⚠️ 指向一个**不存在且建不出来**的子路径：`create_dir_all` 会失败。
        //    在 macOS 上 `/dev/null/x` 是稳定的“建不出来”。
        let mut s = session(std::path::PathBuf::from("/dev/null/x/config.json"));
        s.current_document = Some(PathBuf::from("/a.md"));
        s.doc_seq = 1;
        let r = apply_reading_progress(&mut s, "/a.md", 1, prog(Some("h1"), Some(0.3)));
        assert_eq!(r.status, "persist_failed");
        assert!(r.entry.is_some(), "条目本身是好的，只是没落盘");
        assert!(s.config.reading_progress_of("/a.md").is_some(), "内存里必须已经记住了");
    }

    #[test]
    fn 快照带上全部条目与会话号() {
        let dir = tmp_dir("snapshot");
        let mut s = session(dir.join("config.json"));
        s.doc_seq = 7;
        s.config.set_reading_progress_at("/a.md", prog(Some("h1"), Some(0.25)), 100);
        s.config.set_reading_progress_at("/b.md", prog(None, Some(0.75)), 200);
        let snap = snapshot(&s);
        assert_eq!(snap.doc_seq, 7);
        assert_eq!(snap.reading_progress.len(), 2);
        let a = snap.reading_progress.get("/a.md").unwrap();
        assert_eq!(a.id.as_deref(), Some("h1"));
        assert_eq!(a.ratio, Some(0.25));
        let b = snap.reading_progress.get("/b.md").unwrap();
        assert_eq!(b.ratio, Some(0.75));
    }

    // ─────────────────────────────────────────────────────────────────────
    // ⭐ 目录会话命令（`design/0020` §7.2）
    // ─────────────────────────────────────────────────────────────────────

    /// 授权一个根并返回**规范化后**的键（`snapshot` / `set_dir_session` 用的那一份）。
    fn auth_root(s: &mut Session, dir: &Path) -> String {
        s.grants.authorize_root(dir).unwrap().display().to_string()
    }

    fn ds(last_file: Option<String>, expanded: &[&str]) -> (Option<String>, Vec<String>) {
        (
            last_file,
            expanded.iter().map(|s| s.to_string()).collect(),
        )
    }

    #[test]
    fn 目录会话命令_没有root时stale且不panic() {
        // 判据 15
        let dir = tmp_dir("dsession-no-root");
        let mut s = session(dir.join("config.json"));
        let (lf, ex) = ds(Some("/r/a.md".to_string()), &[]);
        let r = apply_dir_session(&mut s, "/r", 0, lf, ex);
        assert_eq!(r.status, "stale");
        assert!(r.entry.is_none());
        assert!(s.config.dir_sessions.is_empty());
    }

    #[test]
    fn 目录会话命令_代次不匹配时stale且配置不变() {
        // 判据 16：切目录时的迟到写是**预期形态**，⛔ 不能抛 Err、⛔ 不能改配置
        let dir = tmp_dir("dsession-stale");
        let mut s = session(dir.join("config.json"));
        let root = auth_root(&mut s, &dir);
        let (lf, ex) = ds(Some(format!("{root}/a.md")), &[]);
        let g = s.grants.root_generation();
        assert_eq!(apply_dir_session(&mut s, &root, g, lf, ex).status, "ok");
        let before = s.config.dir_session(&root).cloned();

        let (lf, ex) = ds(None, &[]);
        let r = apply_dir_session(&mut s, &root, 0, lf, ex);
        assert_eq!(r.status, "stale", "旧代次的写必须被拒");
        assert_eq!(s.config.dir_session(&root).cloned(), before, "配置一个字都不许动");
    }

    #[test]
    fn 目录会话命令_子目录作根时stale() {
        // 判据 17（`INV-SESS-02`）：子目录不是"这一代会话"的键
        let dir = tmp_dir("dsession-subdir");
        let mut s = session(dir.join("config.json"));
        auth_root(&mut s, &dir);
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let (lf, ex) = ds(Some(format!("{}/a.md", sub.display())), &[]);
        let g = s.grants.root_generation();
        let sub_root = sub.display().to_string();
        let r = apply_dir_session(&mut s, &sub_root, g, lf, ex);
        assert_eq!(r.status, "stale");
        assert!(s.config.dir_sessions.is_empty());
    }

    #[test]
    fn 目录会话命令_越界项被清洗() {
        // 判据 18
        let dir = tmp_dir("dsession-clean");
        let mut s = session(dir.join("config.json"));
        let root = auth_root(&mut s, &dir);
        let inside_dir = dir.join("docs");
        std::fs::create_dir_all(&inside_dir).unwrap();
        // ⚠️ 会话里的路径必须用**规范化后**的那一份：清洗是文本包含判断，
        //    而 macOS 的临时目录在 `/var` → `/private/var` 之间不相等。
        let inside = std::fs::canonicalize(&inside_dir).unwrap().display().to_string();
        let (lf, ex) = ds(
            Some("/etc/passwd".to_string()),
            &[inside.as_str(), "/etc", &format!("{root}/nope")],
        );
        let g = s.grants.root_generation();
        let r = apply_dir_session(&mut s, &root, g, lf, ex);
        assert_eq!(r.status, "ok");
        let e = r.entry.expect("ok 必须回带条目");
        assert_eq!(e.last_file, None, "越界的 last_file 被清成 None");
        // ⚠️ 注意：`{root}/nope` 是合法的**路径**（清洗只看包含关系，不查存在性），
        //    所以留下的是它和 docs，`/etc` 被丢。
        assert_eq!(e.expanded.len(), 2, "只丢越界项：{expanded:?}", expanded = e.expanded);
        assert!(e.expanded.contains(&inside));
        assert!(!e.expanded.iter().any(|p| p == "/etc"));
    }

    #[test]
    fn 目录会话命令_成功时ok且带后端时间戳() {
        // 判据 19
        let dir = tmp_dir("dsession-ok");
        let mut s = session(dir.join("config.json"));
        let root = auth_root(&mut s, &dir);
        let (lf, ex) = ds(Some(format!("{root}/a.md")), &[]);
        let g = s.grants.root_generation();
        let r = apply_dir_session(&mut s, &root, g, lf, ex);
        assert_eq!(r.status, "ok");
        assert!(r.entry.unwrap().updated_at > 0, "updated_at 由后端盖章");
        assert!(dir.join("config.json").exists(), "ok 意味着真的落盘了");
    }

    #[test]
    fn 目录会话命令_同代连写两次是覆盖() {
        // 判据 20
        let dir = tmp_dir("dsession-overwrite");
        let mut s = session(dir.join("config.json"));
        let root = auth_root(&mut s, &dir);
        let g = s.grants.root_generation();
        let (lf, ex) = ds(Some(format!("{root}/a.md")), &[]);
        apply_dir_session(&mut s, &root, g, lf, ex);
        let (lf, ex) = ds(Some(format!("{root}/b.md")), &[]);
        apply_dir_session(&mut s, &root, g, lf, ex);
        assert_eq!(s.config.dir_sessions.len(), 1, "覆盖而不是追加");
        assert_eq!(
            s.config.dir_session(&root).unwrap().last_file.as_deref(),
            Some(format!("{root}/b.md").as_str())
        );
    }

    #[test]
    fn 目录会话命令_空载荷cleared并删掉该条() {
        // 判据 21（R4）
        let dir = tmp_dir("dsession-cleared");
        let mut s = session(dir.join("config.json"));
        let root = auth_root(&mut s, &dir);
        let g = s.grants.root_generation();
        let (lf, ex) = ds(Some(format!("{root}/a.md")), &[]);
        assert_eq!(apply_dir_session(&mut s, &root, g, lf, ex).status, "ok");

        let (lf, ex) = ds(None, &[]);
        let r = apply_dir_session(&mut s, &root, g, lf, ex);
        assert_eq!(r.status, "cleared");
        assert!(r.entry.unwrap().is_empty());
        assert!(s.config.dir_session(&root).is_none(), "空会话 = 删掉该条");
    }

    #[test]
    fn 目录会话命令_表里没有该条时空载荷仍是cleared() {
        // 判据 22：幂等，⛔ 不 panic
        let dir = tmp_dir("dsession-cleared-idempotent");
        let mut s = session(dir.join("config.json"));
        let root = auth_root(&mut s, &dir);
        let (lf, ex) = ds(None, &[]);
        let g = s.grants.root_generation();
        let r = apply_dir_session(&mut s, &root, g, lf, ex);
        assert_eq!(r.status, "cleared");
        assert!(s.config.dir_sessions.is_empty());
    }

    #[test]
    fn 目录会话命令_快照派生当前根的会话() {
        // §2.2 ①：**派生值**，目录模式才给；单文件模式恒 None
        let dir = tmp_dir("dsession-snapshot");
        let mut s = session(dir.join("config.json"));
        let root = auth_root(&mut s, &dir);
        let (lf, ex) = ds(Some(format!("{root}/a.md")), &[]);
        let g = s.grants.root_generation();
        apply_dir_session(&mut s, &root, g, lf, ex);
        assert_eq!(snapshot(&s).mode, "directory");
        assert!(snapshot(&s).dir_session.is_some(), "目录模式必须带上会话");

        // 切到单文件模式（收回 roots）⇒ 快照不再带会话，但表里那条**还在**
        s.grants.revoke_roots();
        assert!(snapshot(&s).dir_session.is_none());
        assert!(s.config.dir_session(&root).is_some(), "关目录不清会话");
    }

    // ── `design/0035` §3.3.7：`rename_guard` 的确定性矩阵（B6c / B12b） ──
    //
    // ⚠️ 这一组验的是**判据与位置**，⛔ 不是"复现了真实并发交错"——
    //    没有可注入的"卡在保存第二段"的接缝（`design/0035` §8 第 7 条已如实登记）。

    fn guard_session(tag: &str) -> (Session, std::path::PathBuf) {
        let dir = tmp_dir(tag);
        let s = session(dir.join("config.json"));
        (s, dir)
    }

    #[test]
    fn 改名拦截_有保存在途时拒绝() {
        let (mut s, dir) = guard_session("guard-inflight");
        let real = dir.join("a.md");
        s.save_inflight = Some(Instant::now());
        match s.rename_guard(&real) {
            Err(Denied::SaveInFlight { .. }) => {}
            other => panic!("应当 SaveInFlight，实得 {other:?}"),
        }
        // ⚠️ 连"别的文件"也拒：保存目标的身份没有（§3.3.7 的范围不对称）
        assert!(matches!(
            s.rename_guard(&dir.join("b.md")),
            Err(Denied::SaveInFlight { .. })
        ));
    }

    /// ⭐⭐ 这一条专门钉住"⛔ 没用 `inflight_active()`"：
    /// 标记超过 10 s 之后，watcher 事件语义当它不存在，但**写盘线程可能还卡着**。
    #[test]
    fn 改名拦截_超时的在途标记仍然拒绝() {
        let (mut s, dir) = guard_session("guard-stale-mark");
        let real = dir.join("a.md");
        s.save_inflight = Some(Instant::now() - Session::INFLIGHT_MAX - std::time::Duration::from_secs(1));
        assert!(!s.inflight_active(), "前提：这一份标记已经超过 10 s 上限");
        match s.rename_guard(&real) {
            Err(Denied::SaveInFlight { .. }) => {}
            other => panic!("应当 SaveInFlight（⛔ 不按时间到了就放行），实得 {other:?}"),
        }
    }

    #[test]
    fn 改名拦截_当前文档编辑态拒绝_干净也算() {
        let (mut s, dir) = guard_session("guard-editing");
        let real = dir.join("a.md");
        s.current_document = Some(real.clone());
        s.edit_target = Some(real.clone());
        // ⚠️ `baseline_bytes` 有值 = 进过编辑态；**没改过**（干净）也照样拒
        s.baseline_bytes = Some(b"x".to_vec());
        match s.rename_guard(&real) {
            Err(Denied::NotRenamable { reason: crate::error::RenameRefusal::Editing, .. }) => {}
            other => panic!("应当 NotRenamable{{Editing}}，实得 {other:?}"),
        }
    }

    #[test]
    fn 改名拦截_编辑的是别的文件时不拒() {
        let (mut s, dir) = guard_session("guard-other");
        s.current_document = Some(dir.join("cur.md"));
        s.edit_target = Some(dir.join("cur.md"));
        // 改**别的**文件行：编辑态只挡"改当前文档"（§3.3.7 的范围说明）
        assert!(s.rename_guard(&dir.join("other.md")).is_ok());
    }

    #[test]
    fn 改名拦截_两者都无时放行() {
        let (s, dir) = guard_session("guard-ok");
        assert!(s.rename_guard(&dir.join("a.md")).is_ok());
    }

    // ── `design/0035` §3.5：改名成功之后的**状态迁移**（B6 / B7） ──
    //
    // ⚠️ `rename_entry` 本身要 `AppHandle`（`watch::start`），而迁移的每一步都是纯
    //    `Session` 状态 ⇒ 用 `WatchRestart` 把"起监视"注入进来，这里就能断言真状态。
    // ⚠️ 盘上那一步（`renamex_np`）不在这里：它由 `fs/rename.rs` 的真卷测试覆盖。

    #[test]
    fn 改名迁移_当前文档跟随新路径且会话号不变() {
        let (mut s, dir) = guard_session("migrate-current");
        let old = dir.join("a.md");
        let new = dir.join("b.md");
        s.current_document = Some(old.clone());
        s.startup_document = Some(old.clone());
        s.doc_seq = 7;
        // 树缓存里放**这一层**，改名之后必须被作废（B7）
        // ⚠️ `design/0050` 起缓存键里多了**内容纪元**：这里用会话当刻的纪元，
        //    否则"塞进去"的那一层本来就命中不了，后面"必须作废"的断言是空的。
        s.tree.seed(0, s.disk.epoch, &dir, Vec::new());
        assert!(s.tree.hit(0, s.disk.epoch, &dir).is_some(), "前提：缓存里真有一条");
        // 搜索索引同理（B7）：置一份能认得出来的进去
        s.index = Some(std::sync::Arc::new(tree::FileIndex {
            roots_gen: 0,
            disk_epoch: s.disk.epoch,
            built_at: Instant::now(),
            rev: 0,
            roots: vec![dir.display().to_string()],
            entries: Vec::new(),
            stats: Default::default(),
            complete: true,
            incomplete: Vec::new(),
            ignored_dirs: Vec::new(),
        }));
        // 目录会话的 `last_file` 也要跟着换
        s.config.set_dir_session(
            &dir.display().to_string(),
            DirSession { last_file: Some(old.display().to_string()), ..Default::default() },
        );

        let (current_moved, watch_seq, degraded) =
            s.commit_rename(&old, &new, |_, _| WatchRestart::StartedWithoutHandle);

        assert!(current_moved);
        assert_eq!(watch_seq, 1, "⭐ 新监视代号必须回给前端（否则迟到事件全被丢弃）");
        assert!(degraded.is_empty());
        assert_eq!(s.current_document.as_deref(), Some(new.as_path()));
        assert_eq!(s.doc_dir.as_deref(), Some(dir.as_path()));
        assert_eq!(s.startup_document.as_deref(), Some(new.as_path()));
        assert_eq!(s.doc_seq, 7, "⚠️ 改名不是新会话（B6）");
        assert!(s.tree.hit(0, s.disk.epoch, &dir).is_none(), "B7：父层缓存必须作废");
        assert!(s.index.is_none(), "B7：搜索索引必须作废");
        assert_eq!(
            s.config.dir_session(&dir.display().to_string()).and_then(|d| d.last_file.clone()),
            Some(new.display().to_string()),
            "目录会话要指向新路径（否则下次恢复打向旧路径）；表={:?}",
            s.config.dir_sessions
        );
    }

    // ── `design/0038`：启动页那张「最近目录」表 ─────────────────────────

    /// ⚠️ `expanded`/`last_file` **必须落在 `root` 之下**，否则 `sanitized()` 会把它清空，
    /// 而空会话会被 `set_dir_session_at` 直接删掉（`INV-SESS-12`）——表里一行都不会剩。
    fn dir_session_of(root: &str, last_file: Option<&str>) -> DirSession {
        DirSession {
            last_file: last_file.map(str::to_string),
            expanded: vec![format!("{root}/sub")],
            updated_at: 0,
        }
    }

    #[test]
    fn 最近目录_按更新时间降序并截到十条() {
        let dir = tmp_dir("recent-order");
        let mut s = session(dir.join("config.json"));
        for i in 0..12u64 {
            let root = format!("/r{i:02}");
            s.config.set_dir_session_at(&root, dir_session_of(&root, None), i);
        }
        let rows = recent_dirs(&s);
        assert_eq!(rows.len(), RECENT_LIMIT, "显示上限是 10（配置里仍存 20）");
        assert_eq!(rows[0].root, "/r11", "最新的在最前");
        assert_eq!(rows[9].root, "/r02", "截掉的是最旧的两条");
        assert!(rows.iter().all(|r| !r.last), "没有 last_directory 就没有「上次打开」标记");
    }

    #[test]
    fn 最近目录_只有last_directory时补一行且标记上次打开() {
        let dir = tmp_dir("recent-legacy");
        let mut s = session(dir.join("config.json"));
        for i in 0..12u64 {
            let root = format!("/r{i:02}");
            s.config.set_dir_session_at(
                &root,
                dir_session_of(&root, Some(&format!("{root}/a.md"))),
                i,
            );
        }
        // ⚠️ 只点过一次面板的旧配置：last_directory 有值，dir_sessions 里没有它
        s.config.set_last_directory(std::path::Path::new("/legacy"));
        let rows = recent_dirs(&s);
        assert_eq!(rows.len(), RECENT_LIMIT, "补行之后仍然截到 10");
        assert_eq!(rows[0].root, "/legacy", "补出来的那行在最前面");
        assert!(rows[0].last, "它就是「上次打开」那一条");
        assert_eq!(rows[0].updated_at, 0, "⛔ 不编时间戳");
        assert_eq!(rows[0].last_file, None, "没有同名 DirSession ⇒ last_file 是 None");
        assert_eq!(rows[1].root, "/r11");
        assert!(rows[1..].iter().all(|r| !r.last), "其余行一律 last=false");
    }

    #[test]
    fn 最近目录_last_directory已在表里时只打标记不重复() {
        let dir = tmp_dir("recent-mark");
        let mut s = session(dir.join("config.json"));
        s.config.set_dir_session_at("/a", dir_session_of("/a", Some("/a/x.md")), 10);
        s.config.set_dir_session_at("/b", dir_session_of("/b", None), 20);
        s.config.set_last_directory(std::path::Path::new("/a"));
        let rows = recent_dirs(&s);
        assert_eq!(rows.len(), 2, "⛔ 不许重复一行");
        assert_eq!(rows[0].root, "/b");
        assert_eq!(rows[1].root, "/a");
        assert!(rows[1].last, "/a 仍然是「上次打开」那一条");
        assert!(!rows[0].last);
        assert_eq!(rows[1].last_file.as_deref(), Some("/a/x.md"));
    }

    #[test]
    fn 快照带上最近目录() {
        let dir = tmp_dir("recent-snapshot");
        let mut s = session(dir.join("config.json"));
        s.config.set_dir_session_at("/a", dir_session_of("/a", None), 1);
        let snap = snapshot(&s);
        assert_eq!(snap.recent.len(), 1);
        assert_eq!(snap.recent[0].root, "/a");
    }

    #[test]
    fn 改名迁移_起监视失败只降级且路径仍在新的那份() {
        let (mut s, dir) = guard_session("migrate-watch-fail");
        let old = dir.join("a.md");
        let new = dir.join("b.md");
        s.current_document = Some(old.clone());
        s.doc_seq = 3;

        let (current_moved, watch_seq, degraded) =
            s.commit_rename(&old, &new, |_, _| WatchRestart::Failed);

        assert!(current_moved);
        assert_eq!(watch_seq, 0, "没有监视就没有代号");
        assert_eq!(degraded, vec![crate::fs::rename::DEGRADED_WATCH]);
        // ⛔ 不退回旧路径：盘上已经搬走了，退回等于指向一个不存在的文件
        assert_eq!(s.current_document.as_deref(), Some(new.as_path()));
        assert_eq!(s.doc_seq, 3);
    }

    #[test]
    fn 改名迁移_改的不是当前文档时不动身份() {
        let (mut s, dir) = guard_session("migrate-other");
        let cur = dir.join("cur.md");
        let old = dir.join("a.md");
        let new = dir.join("b.md");
        s.current_document = Some(cur.clone());
        s.startup_document = Some(old.clone());
        s.doc_seq = 5;

        let (current_moved, watch_seq, degraded) =
            s.commit_rename(&old, &new, |_, _| panic!("不是当前文档，⛔ 不该起监视"));

        assert!(!current_moved);
        assert_eq!(watch_seq, 0);
        assert!(degraded.is_empty());
        assert_eq!(s.current_document.as_deref(), Some(cur.as_path()), "当前文档不能被动");
        assert_eq!(s.startup_document.as_deref(), Some(new.as_path()), "启动那份要跟着走");
        assert_eq!(s.doc_seq, 5);
    }

    // ─────────────────────────────────────────────────────────────
    // ⭐ `design/0043`：favorites_apply（`INV-FAV-04/07`）
    //    ⚠️ 每条拒绝都另断"内存与磁盘一个字节不变"——那是候选配置事务的全部意义。
    // ─────────────────────────────────────────────────────────────

    /// 造一份带一个已授权根目录的会话，返回（会话、根、临时目录）。
    fn fav_session(tag: &str) -> (Session, std::path::PathBuf, std::path::PathBuf) {
        let dir = tmp_dir(tag);
        let root = dir.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let s = session(dir.join("config.json"));
        (s, root, dir)
    }

    fn fav_add(s: &mut Session, p: &Path) -> Result<(), Denied> {
        apply_favorite_op(s, FavoriteOp::Add { path: p.display().to_string() })
    }

    #[test]
    fn 收藏_未授权的绝对路径拒绝且配置与磁盘不变() {
        let (mut s, root, dir) = fav_session("fav-unauth");
        let outside = dir.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        s.grants.authorize_root(&root).unwrap();

        let err = fav_add(&mut s, &outside).expect_err("不在已打开范围里的路径必须拒绝");
        assert!(matches!(err, Denied::NotAuthorized { .. }), "拒绝类型：{err:?}");
        assert!(s.config.favorites.is_empty(), "⛔ 拒绝时不许写进内存");
        assert!(!dir.join("config.json").exists(), "⛔ 拒绝时不许写盘");
    }

    #[test]
    fn 收藏_授权目录与其内markdown可加_非markdown与目录外拒绝() {
        let (mut s, root, _dir) = fav_session("fav-add");
        s.grants.authorize_root(&root).unwrap();
        let md = root.join("a.md");
        std::fs::write(&md, "x").unwrap();
        let txt = root.join("b.txt");
        std::fs::write(&txt, "x").unwrap();

        fav_add(&mut s, &root).expect("已授权目录可收藏");
        fav_add(&mut s, &md).expect("已授权 markdown 可收藏");
        let real_root = std::fs::canonicalize(&root).unwrap().display().to_string();
        let real_md = std::fs::canonicalize(&md).unwrap().display().to_string();
        assert_eq!(s.config.favorites, vec![real_root, real_md], "存的是规范化后的 real");

        let err = fav_add(&mut s, &txt).expect_err("非 Markdown 文件不许收藏");
        assert!(matches!(err, Denied::NotAuthorized { .. }));
        assert_eq!(s.config.favorites.len(), 2, "拒绝不动既有项");
    }

    #[test]
    fn 收藏_重复收藏是无操作且不写盘() {
        let (mut s, root, dir) = fav_session("fav-dup");
        s.grants.authorize_root(&root).unwrap();
        fav_add(&mut s, &root).unwrap();
        std::fs::remove_file(dir.join("config.json")).unwrap();

        fav_add(&mut s, &root).expect("重复收藏不报错");
        assert_eq!(s.config.favorites.len(), 1);
        assert!(!dir.join("config.json").exists(), "无操作不该产生一次写盘");
    }

    #[test]
    fn 收藏_满额拒绝且不淘汰任何一条() {
        let (mut s, root, _dir) = fav_session("fav-limit");
        s.grants.authorize_root(&root).unwrap();
        s.config.favorites = (0..FAVORITES_LIMIT).map(|i| format!("/x{i}.md")).collect();
        let before = s.config.favorites.clone();

        let err = fav_add(&mut s, &root).expect_err("满了必须拒绝");
        assert!(matches!(err, Denied::LimitReached { limit, .. } if limit == FAVORITES_LIMIT));
        assert_eq!(s.config.favorites, before, "⛔ 不许静默淘汰最旧的一条");
    }

    #[test]
    fn 收藏_移除缺项幂等_移除既有项落盘() {
        let (mut s, _root, dir) = fav_session("fav-remove");
        s.config.favorites = vec!["/a.md".to_string(), "/b.md".to_string()];
        s.config.save(&s.config_path).unwrap();

        apply_favorite_op(&mut s, FavoriteOp::Remove { path: "/nope.md".into() })
            .expect("缺项移除是幂等成功");
        assert_eq!(s.config.favorites.len(), 2, "缺项不该动别的");

        apply_favorite_op(&mut s, FavoriteOp::Remove { path: "/a.md".into() }).unwrap();
        assert_eq!(s.config.favorites, vec!["/b.md".to_string()]);
        let text = std::fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(text.contains("/b.md") && !text.contains("/a.md"), "要真的落盘：{text}");
    }

    #[test]
    fn 收藏_移动缺项越界同位置都是无操作_正常移动保序() {
        let (mut s, _root, dir) = fav_session("fav-move");
        s.config.favorites = vec!["/a".into(), "/b".into(), "/c".into()];
        s.config.save(&s.config_path).unwrap();
        std::fs::remove_file(dir.join("config.json")).unwrap();

        for (path, to) in [("/nope", 0usize), ("/a", 3), ("/a", 9), ("/a", 0)] {
            apply_favorite_op(&mut s, FavoriteOp::Move { path: path.into(), to })
                .unwrap_or_else(|e| panic!("{path}→{to} 应当是无操作成功，实得 {e:?}"));
        }
        assert_eq!(s.config.favorites, vec!["/a", "/b", "/c"], "四种都不得改序");
        assert!(!dir.join("config.json").exists(), "无操作不写盘");

        apply_favorite_op(&mut s, FavoriteOp::Move { path: "/c".into(), to: 0 }).unwrap();
        assert_eq!(s.config.favorites, vec!["/c", "/a", "/b"]);
    }

    /// ⭐ 失效旧项不因重排被删、也不被重新解析（`INV-FAV-06` + 复评 §4）。
    #[test]
    fn 收藏_重排不动失效项() {
        let (mut s, _root, _dir) = fav_session("fav-stale");
        s.config.favorites = vec!["/gone/a.md".into(), "/b".into()];
        apply_favorite_op(&mut s, FavoriteOp::Move { path: "/b".into(), to: 0 }).unwrap();
        assert_eq!(s.config.favorites, vec!["/b", "/gone/a.md"], "失效项原样留着");
    }

    /// ⭐ 写盘失败 ⇒ 内存不提交（候选配置事务，`INV-FAV-04`）。
    #[test]
    fn 收藏_写盘失败时内存不提交() {
        let (mut s, root, dir) = fav_session("fav-persist-fail");
        s.grants.authorize_root(&root).unwrap();
        s.config.favorites = vec!["/keep.md".to_string()];
        // ⚠️ 让 `config_path` 的父目录是个**普通文件** ⇒ `create_dir_all` 必失败
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "x").unwrap();
        s.config_path = blocker.join("config.json");

        let err = fav_add(&mut s, &root).expect_err("写盘失败必须报错");
        assert!(matches!(err, Denied::Io { .. }), "写盘失败归 Io：{err:?}");
        assert_eq!(s.config.favorites, vec!["/keep.md".to_string()], "⛔ 内存不许提前提交");
        assert_eq!(s.grants.roots().len(), 1, "授权状态也不动");
    }

    /// ⭐ 交叉操作：连续三种操作各自成功，任何一条都不丢。
    #[test]
    fn 收藏_交叉操作不丢更新() {
        let (mut s, root, _dir) = fav_session("fav-cross");
        s.grants.authorize_root(&root).unwrap();
        let md = root.join("a.md");
        std::fs::write(&md, "x").unwrap();

        fav_add(&mut s, &root).unwrap();
        fav_add(&mut s, &md).unwrap();
        let real_md = std::fs::canonicalize(&md).unwrap().display().to_string();
        apply_favorite_op(&mut s, FavoriteOp::Move { path: real_md.clone(), to: 0 }).unwrap();
        apply_favorite_op(&mut s, FavoriteOp::Add { path: root.display().to_string() })
            .expect("重复 add 不报错");
        assert_eq!(s.config.favorites.len(), 2, "两种项的集合不变");
        assert_eq!(s.config.favorites[0], real_md, "移动的结果还在");
    }

    // ─────────────────────────────────────────────────────────────
    // ⭐ `design/0045`：recent_apply（删一条 / 清空）
    //    ⚠️ 核心判据不是"删掉了"，而是"**派生表里也不再出现它**"——
    //    `recent_dirs` 会把 `last_directory` 补回表头，只删一份等于没删。
    // ─────────────────────────────────────────────────────────────

    /// 造一份有两条历史、`last_directory = /a` 的会话。
    fn recent_session(tag: &str) -> (Session, std::path::PathBuf) {
        let dir = tmp_dir(tag);
        let mut s = session(dir.join("config.json"));
        s.config.set_dir_session_at("/a", dir_session_of("/a", Some("/a/x.md")), 10);
        s.config.set_dir_session_at("/b", dir_session_of("/b", None), 20);
        s.config.set_last_directory(std::path::Path::new("/a"));
        (s, dir)
    }

    #[test]
    fn 最近命令_删除一条同时清掉last_directory() {
        let (mut s, dir) = recent_session("recent-remove-last");
        apply_recent_op(&mut s, RecentOp::Remove { path: "/a".into() }).unwrap();
        assert!(!s.config.dir_sessions.contains_key("/a"), "历史里删掉了");
        assert_eq!(s.config.last_directory, None, "⭐ 两份必须一起清，否则派生表会把它补回来");
        let rows = recent_dirs(&s);
        assert_eq!(rows.len(), 1, "⭐ 派生表里也不再出现它");
        assert_eq!(rows[0].root, "/b");
        assert!(rows.iter().all(|r| !r.last), "没有 last_directory 就没有「上次打开」标记");
        assert!(dir.join("config.json").exists(), "删成功就该真的落盘");
    }

    #[test]
    fn 最近命令_删除另一条时last_directory不动() {
        let (mut s, _dir) = recent_session("recent-remove-other");
        apply_recent_op(&mut s, RecentOp::Remove { path: "/b".into() }).unwrap();
        assert!(!s.config.dir_sessions.contains_key("/b"));
        assert_eq!(
            s.config.last_directory.as_deref(),
            Some("/a"),
            "删的不是「上次打开」那一条 ⇒ 它照旧",
        );
        let rows = recent_dirs(&s);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].root, "/a");
        assert!(rows[0].last);
    }

    /// ⚠️ 幂等 + **零写盘**：缺项不该因为"磁盘写不进去"而报一句写盘失败。
    #[test]
    fn 最近命令_删除缺项是无操作成功且不写盘() {
        let (mut s, dir) = recent_session("recent-remove-missing");
        apply_recent_op(&mut s, RecentOp::Remove { path: "/nope".into() }).unwrap();
        assert_eq!(s.config.dir_sessions.len(), 2, "别的项一条不少");
        assert_eq!(s.config.last_directory.as_deref(), Some("/a"));
        assert!(!dir.join("config.json").exists(), "没有变化 ⇒ 一个字节都不写");
    }

    /// ⚠️ 只允许删**逐字相同**的那一条：⛔ 不规范化、⛔ 不做前缀匹配。
    #[test]
    fn 最近命令_删除要求逐字命中() {
        let (mut s, _dir) = recent_session("recent-remove-exact");
        // 尾斜杠 / 子目录 / `~` 缩写都不是同一条
        for path in ["/a/", "/a/sub", "~/a", "/A"] {
            apply_recent_op(&mut s, RecentOp::Remove { path: path.into() }).unwrap();
        }
        assert_eq!(s.config.dir_sessions.len(), 2, "四条都不该命中");
        assert_eq!(s.config.last_directory.as_deref(), Some("/a"));
    }

    #[test]
    fn 最近命令_清空两份都清且派生表为空() {
        let (mut s, dir) = recent_session("recent-clear");
        apply_recent_op(&mut s, RecentOp::Clear).unwrap();
        assert!(s.config.dir_sessions.is_empty());
        assert_eq!(s.config.last_directory, None, "清空连「上次打开」一起清");
        assert!(recent_dirs(&s).is_empty(), "⭐ 派生表必须真的空（否则那一行会原地复活）");
        assert!(dir.join("config.json").exists(), "清空也要落盘");
    }

    #[test]
    fn 最近命令_清空已空的表不写盘() {
        let dir = tmp_dir("recent-clear-empty");
        let mut s = session(dir.join("config.json"));
        apply_recent_op(&mut s, RecentOp::Clear).unwrap();
        assert!(!dir.join("config.json").exists(), "本来就空 ⇒ 没有变化 ⇒ 不写");
    }

    /// ⭐ 写盘失败 ⇒ 内存不提交（与 `favorites_apply` 同一条事务纪律）。
    #[test]
    fn 最近命令_写盘失败时内存不提交() {
        let (mut s, dir) = recent_session("recent-persist-fail");
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "x").unwrap();
        s.config_path = blocker.join("config.json");

        let err = apply_recent_op(&mut s, RecentOp::Clear).expect_err("写盘失败必须报错");
        assert!(matches!(err, Denied::Io { .. }), "写盘失败归 Io：{err:?}");
        assert_eq!(s.config.dir_sessions.len(), 2, "⛔ 内存不许提前提交");
        assert_eq!(s.config.last_directory.as_deref(), Some("/a"));
        assert_eq!(recent_dirs(&s).len(), 2);
    }
}
