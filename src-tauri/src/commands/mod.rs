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

use serde::Serialize;

use crate::config::{Appearance, Config, DirSession, ReadingProgress};
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
        if let Some(parent) = to.parent() {
            self.tree.invalidate(generation, parent);
        }
        self.index = None;

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
        // ⚠️ **派生一次、字段填两处**：`language_preference()` 会把拼错的词归一成
        //    `"system"`，所以这里拿到的永远是 `config::LANGS` 里那三个之一。
        //    ⚠️ 显式档**不会** spawn（`lang::effective_with` 短路）；
        //    `system` 档走 `OnceLock` 缓存（启动时 `setup` 已经问过一次）⇒ 这次读是免费的。
        language: {
            let pref = s.config.language_preference();
            crate::lang::effective(pref).tag()
        },
        language_preference: s.config.language_preference(),
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
            tree_watch: None,
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
        s.tree.put(0, &dir, Vec::new());
        assert!(s.tree.get(0, &dir).is_some(), "前提：缓存里真有一条");
        // 搜索索引同理（B7）：置一份能认得出来的进去
        s.index = Some(std::sync::Arc::new(tree::FileIndex {
            roots_gen: 0,
            built_at: Instant::now(),
            roots: vec![dir.display().to_string()],
            entries: Vec::new(),
            stats: Default::default(),
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
        assert!(s.tree.get(0, &dir).is_none(), "B7：父层缓存必须作废");
        assert!(s.index.is_none(), "B7：搜索索引必须作废");
        assert_eq!(
            s.config.dir_session(&dir.display().to_string()).and_then(|d| d.last_file.clone()),
            Some(new.display().to_string()),
            "目录会话要指向新路径（否则下次恢复打向旧路径）；表={:?}",
            s.config.dir_sessions
        );
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
}
