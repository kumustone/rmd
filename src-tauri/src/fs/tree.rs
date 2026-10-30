//! 单层目录扫描 + 过滤 + 缓存（`design/0003` §2.1）。
//!
//! # 三条从这里定死的规则
//!
//! 1. **懒加载**：本模块**只扫一层**，⛔ 永不递归。展开子目录是前端再发一次
//!    `list_dir`。递归扫描一个含 `node_modules` 的仓库会把时间花在用户根本
//!    不看的内容上（§2.1 的"理由"）。
//! 2. ⭐ **过滤分三个集合，判定顺序即优先级**（§2.1 的 P2-7 修订）：
//!
//!    | # | 规则 | 呈现 | 扫描子项 |
//!    |---|---|---|---|
//!    | ① | 名字以 `.` 开头（含 `.git`） | **完全隐藏** | ❌ |
//!    | ② | 名字在**过滤清单**里（出厂 [`DEFAULT_IGNORE_DIRS`]，`design/0040` 起可配置） | **灰显 + 不可展开** | ❌ |
//!    | ③ | 其余目录 + 扩展名 `.md` 的文件 | 正常 | ✅ |
//!
//!    ⚠️ **两类都绝不进入其子项**——这才是忽略清单的**性能目的**。
//!    禁止的呈现是「点开后才告诉你被忽略了」（等于先花扫描成本再拒绝）。
//! 3. ⭐ **取"是不是目录"用 [`DirEntry::file_type()`]**——APFS 上它是**免费的**
//!    （`readdir` 的 `d_type`）。⛔ **不要**每项 `symlink_metadata()`：
//!    实测 5200 项时 **2.44 ms → 14.98 ms（6.1×）**（`docs/research/notes/0006`）。
//!
//! # 两类"不产生"的条目
//!
//! - **符号链接**：`design/0003` §2.2 备选 D 选了**不跟随**。
//!   `DirEntry::file_type()` **不解符号链接**，所以软链既不是目录也不是文件
//!   → 本模块直接**不列它**（§6 的"不跟随即不产生"）。
//!   ⚠️ 这不是安全防线——防线是 [`SessionGrants::check_readable`] 里的
//!   `canonicalize`。就算有人绕过树直接点一个软链路径，那条路也读不到。
//! - **非 `.md` 的普通文件**：V1 的树只导航 Markdown。
//!
//! # ⭐ 递归索引（`design/0009`，2026-10-14 已通过）——**不是**树的懒加载被推翻
//!
//! 文件名模糊搜索需要一份"全树文件清单"，但**树的"单层、永不递归"依然成立**
//! （`design/0003` §2.1）：递归只发生在 [`build_index`] 这一条**搜索专用**的路径上，
//! 两者不互相污染，也⛔ 不往 [`TreeCache`] 里塞任何东西（那份缓存的键是**单层**的）。
//!
//! 三条不变量落在这里：过滤走同一个 [`classify`]（`INV-SEARCH-02`）、
//! 每一层 `read_dir` 之前都过 `check_readable`（`INV-SEARCH-01`）、
//! ⛔ 不跟随符号链接（`INV-SEARCH-05`）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

use crate::error::Denied;
use crate::fs::grants::SessionGrants;

use super::order;

/// ② 类：**灰显 + 不可展开 + 不扫描**的目录名的**出厂默认值**。
///
/// ⚠️ **这是本项目的自创，业界找不到先例**（`design/0003` §2.3 ②：扫遍 Typora 的
/// CSS 与配置都没有忽略目录的痕迹）。**⛔ 不得引"业界都这样"为据。**
/// 正当理由是**面向场景不同**：Typora 面向写作者（目录里通常只有 `.md`），
/// 本项目面向**读代码仓文档的人**（目录里有 `node_modules`）。
///
/// ⚠️ **不读 `.gitignore`**：那需要实现 gitignore 的匹配语义
/// （否定规则、目录规则、嵌套 `.gitignore`），成本与收益不成比例（§2.1）。
///
/// ⭐ **`design/0040`（2026-10-24）起清单可配置**：
/// ⚠️ **~~「清单里要能加东西，但不做成配置」~~ 已取代**——用户当日明确要求
/// 「打开目录时，过滤目录可配置，**当然会一个默认值**」。
/// 配置文件里的 `ignore_dirs` 覆盖本常量；**本常量从此只是"出厂默认值"**，
/// ⛔ 不再是"唯一的清单"。⚠️ 清单字面量**只此一处**：`config::default_ignore_dirs()`
/// 与测试都从 [`default_ignore_dirs`] 取，⛔ 不许在别处再抄一份四个名字。
pub const DEFAULT_IGNORE_DIRS: &[&str] = &["node_modules", "target", "dist", "build"];

/// 出厂默认清单的 `Vec<String>` 形式（配置默认值、测试共用）。
///
/// ⚠️ 为什么要这一层：判定侧统一吃 `&[String]`（配置里存的就是它），
/// 而常量是 `&[&str]`；转换只在这里做一次，⛔ 不在三处调用点各抄一遍。
pub fn default_ignore_dirs() -> Vec<String> {
    DEFAULT_IGNORE_DIRS.iter().map(|s| (*s).to_string()).collect()
}

/// 树里的一项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeEntry {
    /// 目录项的名字（**不含路径**）。
    pub name: String,
    /// 绝对路径。⚠️ 来自 `read_dir` 的 `DirEntry::path()`，⛔ **不是拼出来的**
    /// （`INV-TREE-01`：树节点里的路径不来自任何"猜测"）。
    pub path: String,
    /// 是不是目录。
    pub is_dir: bool,
    /// 在**过滤清单**里（出厂 [`DEFAULT_IGNORE_DIRS`]，`design/0040` 起来自配置）：
    /// **可见但点不动**（灰显、不展开）。
    pub ignored: bool,
}

/// 一次扫描的统计。
///
/// ⭐ 它是 §7 步骤 5 的**判据**：要证明 `.git` / `node_modules` 的子项
/// **从未被扫描**，靠的就是把"这一层读到了多少项"摆出来——
/// 若真进了子项，`scanned` 会明显大于本层可见项数。
#[derive(Debug, Clone, Default, Serialize)]
pub struct ScanStats {
    /// `read_dir` 在这一层读到的条目总数（含下面被跳过的）。
    pub scanned: usize,
    /// ① 点开头 → 完全隐藏。
    pub skipped_dot: usize,
    /// ② 忽略清单 → 灰显，**不扫描子项**。
    pub ignored: usize,
    /// 符号链接 → 不跟随即不产生。
    pub skipped_symlink: usize,
    /// 既不是目录、扩展名也不是 `.md`。
    pub skipped_other: usize,
    /// 本层扫描耗时（毫秒）。⚠️ 口径 = `read_dir` + 过滤 + 排序，
    /// **不含**任何子目录（本模块不递归）。
    pub scan_ms: f64,
}

/// `list_dir` 的返回值。
#[derive(Debug, Clone, Serialize)]
pub struct ListDirResult {
    /// **规范化后**的目录路径（⛔ 不是请求里那个字符串）。
    pub path: String,
    /// 后端当前代次（前端提交点要比对它）。
    #[serde(rename = "gen")]
    pub generation: u64,
    /// ⭐ **这次扫描起步时的内容修订**（`design/0050`，`INV-DISK-09`）。
    ///
    /// ⚠️ 前端的提交判据里可以只比 `gen`：**跨修订**的结果后端根本不会以 `Ok` 回来
    /// （它会回 `stale_revision`）。这一项是给日志与探针看的——
    /// "这份列表是哪一刻的观测"必须在载荷里看得见，⛔ 不许只能靠时间戳猜。
    #[serde(rename = "rev")]
    pub epoch: u64,
    /// 回显前端那次请求的 `request_id`（后端**不解释**它，只回显）。
    pub req: u64,
    /// 这一层的条目，已排好序。
    pub entries: Vec<TreeEntry>,
    /// 扫描统计（§7 步骤 5 的日志判据）。
    pub stats: ScanStats,
}

/// ⭐ **三档过滤的共享谓词**（`design/0009` §2.1 ①，`INV-SEARCH-02`）。
///
/// 单层扫描（[`list_dir`]）与递归索引（[`build_index`]）**调的是同一个它**——
/// ⛔ 不是洁癖：① 忽略目录里的东西被搜得出来是**语义错**（"忽略"就没意义了）；
/// ② `notes/0011` 实测**进不进忽略目录差 17.4×**（8.87 ms vs 154.08 ms）。
/// 两份判定一旦漂移，两个后果都**不报错**。
///
/// ⭐ `design/0040` 起**清单由调用方传入**（来源 = `config.ignore_dirs`）。
/// ⚠️ 匹配是**逐字、大小写敏感**的 `==`（`INV-FILTER-02`）——清单项只表示名字，
/// ⛔ 不解析成 glob / 正则。
///
/// ⚠️ 判据里**只有名字与"是不是目录"**，⛔ 不含 `file_type()` 失败、软链
/// 这两种"读不出来"的情形——它们的落点在调用方（各自的 `stats` 计数不同）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Class {
    /// ① 名字以 `.` 开头 → **完全隐藏**、⛔ 不进入子项。
    Hidden,
    /// ② 目录名在**过滤清单**里 → **灰显**、⛔ 不进入子项。
    /// ⚠️ 只有**目录**会落进这一档：同名的普通文件不受影响（现状如此，⛔ 别顺手改）。
    Ignored,
    /// ③ 其余目录 + `.md` 文件 → 正常。
    Normal,
    /// 既不是目录、扩展名也不是 `.md` → 不列、不进入。
    Other,
}

/// 判定顺序即优先级：① 在 ② 之前，② 在 ③ 之前（模块头那张表）。
///
/// ⚠️ `ignore` 是**目录名字**清单（已归一化，见 `config::normalize_ignore_dirs`）：
/// ⛔ 不在这里再做归一化——那是第二条真值。
pub(crate) fn classify(name: &str, is_dir: bool, ignore: &[String]) -> Class {
    if name.starts_with('.') {
        return Class::Hidden;
    }
    if is_dir {
        return if ignore.iter().any(|n| n == name) { Class::Ignored } else { Class::Normal };
    }
    if is_markdown(name) {
        Class::Normal
    } else {
        Class::Other
    }
}

/// ⭐ 单层扫描。
///
/// 顺序是**先查代次、再查授权**——代次不符时**不做任何工作**
/// （§2.1.3 规则 2：一份已被放弃的切换不该产生 IO）。
///
/// ⭐ `design/0050` 起多一个 `epoch`（内容修订）：它只被**回显**进结果，
/// 判据留在调用方（`commands/fs.rs` 的第 ③ 段）。⚠️ 为什么不在这里也判一次：
/// 这里拿到的是**扫描起步时**的那个值，它必然"等于自己"——真正要比的是
/// **扫描结束之后**的当刻值，那只有会话锁里那一段能看到。
pub fn list_dir(
    grants: &SessionGrants,
    requested: &Path,
    generation: u64,
    epoch: u64,
    req: u64,
    ignore: &[String],
) -> Result<ListDirResult, Denied> {
    // ① 后端入口处的代次检查（前端那一查保证"不显示错的东西"，这一查保证"不做白工"）
    let current = grants.root_generation();
    if generation != current {
        return Err(Denied::stale(generation, current));
    }

    // ② 授权校验：唯一的读取入口
    let real = grants.check_readable(requested)?;
    if !real.is_dir() {
        // ⚠️ 故意用 NotFound 而不是新造一个类型：对前端来说
        //    "这里不是目录"与"这里没有东西"应当是同一句文案
        return Err(Denied::not_found(requested));
    }

    let t0 = std::time::Instant::now();
    let mut stats = ScanStats::default();
    let mut out: Vec<TreeEntry> = Vec::new();

    let rd = std::fs::read_dir(&real).map_err(|e| Denied::io(&real, e))?;
    for item in rd {
        let Ok(item) = item else {
            // 单个条目读不出来不该让整层失败（§6：子目录权限不足时兄弟项仍正常）
            stats.skipped_other += 1;
            continue;
        };
        stats.scanned += 1;

        let name = item.file_name().to_string_lossy().into_owned();

        // ① 点开头：完全隐藏。⚠️ 判在忽略清单**之前**——`.git` 走 ①，
        //    不会出现在忽略清单的灰显项里（§2.1 的"判定顺序即优先级"）。
        //    ⚠️ 这一条**刻意留在 `file_type()` 之前**（`design/0009` §8 要求这一层行为不变）：
        //    换到后面之后，一个点开头的坏项/软链会从"① 类"改算成"其它/软链"，
        //    数量对不上而没有测试拦得住。⛔ `classify` 已经含这一档，别在这里改成调它。
        if name.starts_with('.') {
            stats.skipped_dot += 1;
            continue;
        }

        // ⭐ `file_type()` 不解符号链接，且在 APFS 上是免费的（模块头第 3 条）
        let Ok(ft) = item.file_type() else {
            stats.skipped_other += 1;
            continue;
        };
        if ft.is_symlink() {
            // 不跟随即不产生（§2.2 备选 D）
            stats.skipped_symlink += 1;
            continue;
        }

        let is_dir = ft.is_dir();
        // ⭐ ②③ 档走共享谓词（`design/0009` §2.1 ①）——索引那边调的是同一个函数
        match classify(&name, is_dir, ignore) {
            // ⚠️ 不可达（上面那一条已经挡掉了 ①），保留分支只为让谓词自足
            Class::Hidden => {
                stats.skipped_dot += 1;
                continue;
            }
            Class::Ignored => {
                stats.ignored += 1;
                // ② 灰显项：**列出来但点不动**，且⛔ 不扫描子项（这里就地 continue）
                out.push(TreeEntry {
                    path: item.path().to_string_lossy().into_owned(),
                    name,
                    is_dir: true,
                    ignored: true,
                });
                continue;
            }
            Class::Other => {
                stats.skipped_other += 1;
                continue;
            }
            Class::Normal => {}
        }

        out.push(TreeEntry {
            path: item.path().to_string_lossy().into_owned(),
            name,
            is_dir,
            ignored: false,
        });
    }

    // 目录在前 + Finder 那套自然排序（`fs/order.rs`）
    let out = order::sorted(out, |e| (e.is_dir, e.name.clone()));

    stats.scan_ms = t0.elapsed().as_secs_f64() * 1000.0;
    Ok(ListDirResult {
        path: real.to_string_lossy().into_owned(),
        generation: current,
        epoch,
        req,
        entries: out,
        stats,
    })
}

/// 是不是一份 Markdown（扩展名大小写不敏感）。
///
/// ⚠️ V1 **只认 `.md`**：`.markdown` / `.mdown` / `.mkd` 都不认。
/// 这是 `design/0003` §2.1 规则 ③ 的原话（"扩展名为 `.md` 的文件"），
/// ⛔ 别在这里"顺手放宽"——放宽就等于改了树里能看到什么。
///
/// ⭐ `design/0034` 起 `pub(crate)`：新建文件时**必须**用同一份后缀判据
/// （`.MD` 已经算 markdown ⇒ ⛔ 不再补一个 `.md`），⛔ 不许在 `fs/create.rs` 抄第二份。
pub(crate) fn is_markdown(name: &str) -> bool {
    Path::new(name).extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// `list_dir` 的结果缓存（`design/0003` §2.1 的懒加载 + §2.1.3 的缓存键）。
///
/// ⭐ **键是 `(root_generation, disk_epoch, path)`**：
/// - 代次管"**授权变没变**"（`design/0039`）——切根之后回到同一个目录，
///   裸 `path` 会命中**上一代的陈旧结果**；
/// - ⭐ 纪元管"**盘上内容变没变**"（`design/0050`，`INV-DISK-09`）——代次**不会**因为
///   别处新建一个文件而前进，所以只带代次的键在同一会话里**永远命不中变化**
///   （`bugs/0019` 的根因之一）。
///
/// # ⭐ `design/0039` 起：写入必须**凭票**
///
/// 扫描已经从会话锁里挪到了 `spawn_blocking`（`commands/fs.rs::list_dir`），
/// 于是出现了一个以前**不可能**的交错：A 扫到旧列表 → B 作废并提交新列表
/// → A 回锁时代次仍然相等（同一代！）→ 裸 `put` 把新缓存盖回旧列表。
/// 这类竞态**不会报错**，表现只是"刷新没生效"。
///
/// 解法是给每个键一张**单调票号**（[`TreeCache::begin`]）：任何写入都要先证明
/// `latest[key] == stamp`（[`TreeCache::commit`]）。`invalidate`/`begin` 都会把
/// `latest` 推过去 ⇒ 交错 A 在结构上不可能覆盖 B（`INV-TREE-10`）。
/// ⭐ 纪元进键之后，**跨纪元**的那张票天生就在另一个键上 ⇒ 不需要额外一条判据。
///
/// ⚠️ **不用时间戳**：那要处理"时钟相同 / 回拨"，而"谁更晚"本来就只是一个序数问题。
#[derive(Debug, Default)]
pub struct TreeCache {
    inner: Mutex<CacheInner>,
}

/// 缓存键：`(授权代次, 磁盘纪元, 规范化路径)`。
type CacheKey = (u64, u64, PathBuf);

#[derive(Debug, Default)]
struct CacheInner {
    /// 已经提交过的层。
    entries: HashMap<CacheKey, Vec<TreeEntry>>,
    /// 每个键**当前有效**的票号。⚠️ 它只记"现在算谁的"，不记历史。
    latest: HashMap<CacheKey, u64>,
    /// 全局单调发号器。`u64` 回绕要 2^64 次扫描，不处理。
    next: u64,
}

/// [`TreeCache::sweep`] 摘下来的旧纪元缓存。
///
/// ⚠️⚠️ **必须在会话锁之外 `drop`**（`INV-DISK-13` / 最终实施约束 7）：
/// 在锁内释放等于把"释放几百个 `TreeEntry`（含 `String`）"塞回临界区，
/// 而这正是 `design/0039` 把 `read_dir` 挪出去要解决的**同一类**问题。
#[derive(Debug, Default)]
#[must_use = "摘下来的旧纪元缓存必须在会话锁外 drop"]
pub struct Swept {
    layers: Vec<Vec<TreeEntry>>,
}

impl Swept {
    /// 摘下来多少层（日志 / 单测用）。
    pub fn len(&self) -> usize {
        self.layers.len()
    }
}

impl TreeCache {
    /// 新建。
    pub fn new() -> Self {
        Self::default()
    }

    /// 取一层（未命中返回 `None`）。⭐ **只读，不发号**。
    pub fn hit(&self, generation: u64, epoch: u64, path: &Path) -> Option<Vec<TreeEntry>> {
        self.lock().entries.get(&(generation, epoch, path.to_path_buf())).cloned()
    }

    /// 领一张票，并把它记为这个键**当前有效**的票——此前发出的票**全部作废**。
    ///
    /// ⚠️ 同键两次 `begin` 而没有中间的 `invalidate`：**晚发者赢**
    /// （与前端 `layerSeq` 同语义，`design/0039` §7 第 4 条）。
    pub fn begin(&self, generation: u64, epoch: u64, path: &Path) -> u64 {
        let mut g = self.lock();
        let key = (generation, epoch, path.to_path_buf());
        g.next += 1;
        let stamp = g.next;
        g.latest.insert(key, stamp);
        stamp
    }

    /// ⭐ **作废某一层**：删条目 ＋ **发新票**（在飞的那次扫描因此再也提交不进来）。
    ///
    /// 用途两处：① 搜索浮层回车后重列这一层（`design/0009` §2.1 ⑤——不先作废，
    /// 重列只会命中同一份陈旧结果，表现是"树死活不动"，`INV-SEARCH-07`）；
    /// ② 改名 / 新建之后父层要重列（`commands/mod.rs::commit_rename`）。
    ///
    /// ⚠️ 键里带代次与纪元，所以别代 / 别纪元的条目**不必**在这里清：
    /// 代次一变由 `retain_gen` 清，纪元一变由 [`TreeCache::sweep`] 清。
    pub fn invalidate(&self, generation: u64, epoch: u64, path: &Path) {
        let mut g = self.lock();
        let key = (generation, epoch, path.to_path_buf());
        g.next += 1;
        let stamp = g.next;
        g.entries.remove(&key);
        g.latest.insert(key, stamp);
    }

    /// ⭐ **凭票提交**：票仍是这个键的"当前有效"才写入。
    ///
    /// 返回 `false` = 这张票已经作废（有人 `fresh`/作废过，或有更晚的扫描领了票）
    /// ⇒ **不写缓存**。
    ///
    /// ⚠️⭐ `design/0050` **正面推翻** `design/0039` §2.1 ③ 那句"票失效 ⇒ **结果照回前端**"：
    /// 票失效意味着"这一份结果我们已经**无法**说明它对应哪个修订"，
    /// 照回前端等于让界面提交一份**来源不明的盘上事实**（`INV-DISK-07`）。
    /// 现在调用方回 `Denied::stale`，前端的"保留旧视图 ＋ 重试"接住它
    /// （它本来就有这条路：`session.listDir` 的两档 `reason`）。
    pub fn commit(
        &self,
        generation: u64,
        epoch: u64,
        path: &Path,
        stamp: u64,
        entries: Vec<TreeEntry>,
    ) -> bool {
        let mut g = self.lock();
        let key = (generation, epoch, path.to_path_buf());
        if g.latest.get(&key) != Some(&stamp) {
            return false;
        }
        g.entries.insert(key, entries);
        true
    }

    /// ⭐ **按住纪元清扫**：只留**恰好** `(generation, epoch)` 这一档，其余全部摘下来。
    ///
    /// 调用点是磁盘纪元前进之后的那一趟核对（`commands/fs.rs::reconcile_once` 的锁内半，
    /// 即 `state.with(|s| s.tree.sweep(..))` 那一句）。
    /// ⚠️ 早先这里写的是 `request_reconcile`——**那个函数不存在**（2026-10-29 评审第 21 条）。
    /// 摘下来的值**由调用方在会话锁外 `drop`**（返回 [`Swept`] 就是为这件事）。
    ///
    /// ⚠️ 它同时清**票表**：旧纪元的在飞扫描回来时，`commit` 找不到自己的票 ⇒
    /// 写不进去（`INV-DISK-07` 的"迟到结果不许改状态"在缓存这一层的落点）。
    ///
    /// ⚠️ 它也会顺手丢掉**非当前代**的条目——那是 `retain_gen` 的活儿，
    /// 在这里免费做了；`retain_gen` 仍留着（`close_directory` 不推进纪元）。
    pub fn sweep(&self, generation: u64, epoch: u64) -> Swept {
        let mut g = self.lock();
        let mut taken = Vec::new();
        g.entries.retain(|key, v| {
            let keep = key.0 == generation && key.1 == epoch;
            if !keep {
                // ⚠️ `retain` 只给 `&mut V`：`mem::take` 把 Vec 搬出来，真正的释放
                //    （逐个 `TreeEntry` 的 `String`）发生在调用方锁外的 `drop`。
                taken.push(std::mem::take(v));
            }
            keep
        });
        g.latest.retain(|key, _| key.0 == generation && key.1 == epoch);
        Swept { layers: taken }
    }

    /// 丢掉**非当前代**的全部缓存（条目表与票表一起，`design/0039` §7 第 5 条）。
    ///
    /// ⚠️ 不这么做的话，切根 N 次就留下 N 份再也命不中的结果——
    /// 它们不会造成错误，只会让内存随浏览历史单调增长。
    pub fn retain_gen(&self, generation: u64) {
        let mut g = self.lock();
        g.entries.retain(|key, _| key.0 == generation);
        g.latest.retain(|key, _| key.0 == generation);
    }

    /// 当前缓存了多少层（诊断用；⛔ 不含票表）。
    pub fn len(&self) -> usize {
        self.lock().entries.len()
    }

    /// ⚠️ **仅测试用**：不经票直接塞一条。
    ///
    /// `commands/` 的两处测试要造"先有缓存、再看它被作废"的前提
    /// （`design/0035` B7、`design/0034` 的拒绝不变式）。⛔ 产品代码不许调它——
    /// 那等于绕过 `INV-TREE-10`。
    #[cfg(test)]
    pub(crate) fn seed(&self, generation: u64, epoch: u64, path: &Path, entries: Vec<TreeEntry>) {
        self.lock().entries.insert((generation, epoch, path.to_path_buf()), entries);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CacheInner> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }
}

/// ⭐ 提交判据（`INV-TREE-12` ＋ `design/0050` 的 `INV-DISK-09`）：
/// **当前代次 == 扫描时的代次** ∧ **当前纪元 == 扫描时的纪元** ∧ 票仍有效。
///
/// ⚠️ 抽成纯函数是为了**能在 `make test` 里测**：这条判据住在 `commands/fs.rs`，
/// 而那一整个模块只在 `--features gui` 下编译（`design/0039` §7 第 6 条）。
///
/// ⚠️⚠️ 第一个参数必须是 `s.grants.root_generation()`（**当前**的值）。
/// 拿返回值里的 `generation` 去比是**永远相等**的——那是请求侧的值
/// （`design/0039` §6 的"最怕的第三种"，这条注释就是防它）。
/// ⭐ 纪元同理：第三/四个参数必须是**当刻** `s.disk.epoch` 与扫描起点捕获的那个。
///
/// ⭐ 纪元不等时的失败**不是换根**（`INV-DISK-09` 末条）：调用方要把它报成
/// `reason = "rev"` 而不是 `"gen"`——两者的前端处置不同（换根要清树、换修订要保留旧视图重试）。
pub fn should_commit(
    current_generation: u64,
    current_epoch: u64,
    result_generation: u64,
    result_epoch: u64,
    ticket_ok: bool,
) -> bool {
    current_generation == result_generation
        && current_epoch == result_epoch
        && ticket_ok
}

// ─────────────────────────────────────────────────────────────────────────
// 递归索引 + 模糊匹配（`design/0009-文件名模糊搜索.md`，2026-10-14 已通过）
// ─────────────────────────────────────────────────────────────────────────

/// 命中上限（`design/0009` §2.1 ③）。
///
/// ⚠️ **200 是有来处的**：唯一一份一手对照是 VS Code 的
/// `UE.MAX_RESULTS = 512`（`research/notes/0010` §2 末）⇒ 我们取更保守的值。
/// ⛔ 别"顺手调大"：一个 `design` 能命中 12 500 条，全渲染是**前端**的代价。
pub const MATCH_LIMIT: usize = 200;

/// 递归深度上限（`design/0009` §2.1 ①）。
///
/// ⚠️ **纯粹是"别把进程递爆栈"的安全网**——递归爆栈是**进程级 abort**，
/// 不是一条能返回给前端的错误。⛔ 它**不是**产品语义：
/// 界面上那一层层级上限是 `versions.js` 的 **32**（`design/0003` §2.1）。
/// 取 64 = 它的一倍，正常目录树够不着。
const MAX_DEPTH: usize = 64;

/// 索引里的一份文件。
///
/// ⚠️ 三条路径**各有各的用处**，⛔ 不要互相替换：
/// `real_path` 交给 `open_document`（它自己会再过一次 `check_readable`）；
/// `rel` 显示用；`name` 匹配与排序用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexEntry {
    /// 这条属于哪个 root（**已规范化**）。多 root 时前端分组用。
    pub root: String,
    /// 绝对真实路径。
    pub real_path: String,
    /// 相对 root 的路径（显示用）。
    pub rel: String,
    /// 文件名（**不含路径**）。
    pub name: String,
}

/// 一次索引遍历的统计。
///
/// ⭐ 它是 §7 的**日志判据**（与 [`ScanStats`] 同形）：要证明遍历
/// ① 没进 `.git`、② 没进 `node_modules`、③ 没跟软链、④ 跳过了被拒的子树，
/// 靠的就是把这些计数摆出来。⚠️ 全部跳过的项都**必然搜不到**——
/// 这正是 `INV-SEARCH-02` 要的"语义一致"。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct IndexStats {
    /// 真的 `read_dir` 过的目录数。
    pub dirs: usize,
    /// 所有层 `read_dir` 读到的条目总数。
    pub scanned: usize,
    /// ① 点开头 → 隐藏。
    pub skipped_dot: usize,
    /// ② 忽略清单 → 灰显，⛔ 不进入子项。
    pub ignored: usize,
    /// 软链 → 不跟随即不产生。
    pub skipped_symlink: usize,
    /// 既不是目录、扩展名也不是 `.md`。
    pub skipped_other: usize,
    /// ⭐ 子树被**拒**（`check_readable` 不通过、`is_inside_roots` 为假、或 `read_dir` 失败）。
    ///
    /// ⚠️ 这是 `INV-SEARCH-01` 的**可观测出口**：它不为零 = 遍历真的撞上过
    /// "这个子树已经不在授权里了"（换目录、软链逃逸、权限不足）。
    pub skipped_denied: usize,
    /// 撞上 [`MAX_DEPTH`] 的子树（安全网，正常为 0）。
    pub skipped_deep: usize,
    /// 整趟遍历耗时（毫秒）。
    pub scan_ms: f64,
}

/// ⭐ **未走完的子树**（`design/0041` §2.1.1，R1）。
///
/// ⚠️ 它存在的唯一理由：`build_index` 撞上"读不出来 / 太深 / 单项出错"时**跳过子树
/// 但仍然返回 `Ok`**。聚合计数（[`IndexStats::skipped_denied`] 等）能说明"发生过"，
/// **不能说明"发生在哪"**——而"哪些目录子树无 md"这条判据**必须知道位置**，
/// 否则会把"未知"当成"确认没有"，静默藏掉一个只是暂时不可读的目录。
///
/// ⚠️ `reason` 只有三种，界面文案与测试都按它分支：
/// `"denied"`（校验/`read_dir` 失败）、`"deep"`（撞 [`MAX_DEPTH`]）、
/// `"other"`（单项 `file_type` 失败之类，风险只落在这个目录本身）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IncompleteNode {
    /// 没走完的那个目录（**绝对路径**，来自已规范化的父层）。
    pub path: String,
    /// 原因（见类型注释）。
    pub reason: String,
}

/// ⭐ **全树文件清单**（`design/0009` §2.1 ②）。
///
/// ⚠️ 它是**内存态**：随进程消失，⛔ 不落盘、⛔ 不写 `config.json`（§8 的回滚因此是"删掉就完"）。
///
/// ⚠️ **`roots_gen` 只回答"授权变没变"，回答不了"目录里有没有新文件"**
/// （`INV-SEARCH-06`）：用户不切根、只新建一个文件，代次不会变。
/// ⇒ 内容新鲜度另有一条**明确的**重建时机（浮层打开 / `Cmd+R`），见 [`FileIndex::is_fresh`]。
///
/// ⭐ `design/0041` 起它同时供**文件名搜索**与**文档列表 / 空目录过滤**使用
/// （`INV-DOCS-01`：一份清单）。为此多了四个字段：`rev` / `complete` /
/// `incomplete` / `ignored_dirs`——⚠️ 前两个之外，后两个是**路径**，不是计数（R1）。
#[derive(Debug)]
pub struct FileIndex {
    /// 建这份索引时的授权代次。
    pub roots_gen: u64,
    /// ⭐ 建这份索引时的**磁盘纪元**（`design/0050`，`INV-DISK-09`）。
    ///
    /// ⚠️ `roots_gen` 只说"授权没变"，**它挡不住"同一个根里内容变了"**
    /// （同一会话里新建/删除文件，代次不动）。⇒ 过滤清单与树能不能"同一条索引修订"
    /// 全靠这个字段：纪元一变，旧的 `keep_dirs` 与旧树**不是同一次观测**。
    pub disk_epoch: u64,
    /// 建这份索引的时刻。⭐ 用来回答"它多久没更新了"（[`FileIndex::age_ms`]）。
    pub built_at: Instant,
    /// ⭐ **发布版本号**（`design/0041` §2.1.2，R2）：由**发布方**在写入
    /// `AppState.index` 时 +1。⚠️ 同代次内可以有多份在途构建，代次挡不住
    /// "旧的晚完成覆盖新的"——判据是发布点的票号，不是这个值本身。
    /// ⚠️ 不是发布方填的索引（单测里直接 `build_index` 的）一律为 **0**。
    pub rev: u64,
    /// 覆盖的 root（**已规范化**，显示与分组用）。
    pub roots: Vec<String>,
    /// 全部条目。⚠️ **⛔ 不预先排序**：排序是每次查询按命中排名做的
    /// （文档列表的排序走 [`sort_docs`]，也在**派生视图**上做，⛔ 不改这里）。
    pub entries: Vec<IndexEntry>,
    /// 遍历统计（日志判据）。
    pub stats: IndexStats,
    /// ⭐ 这棵树**是否被完整走过**（`= incomplete.is_empty()`）。
    /// ⚠️ 它回答的是"清单的收录范围完整吗"，⛔ 不是"条目够不够多"。
    pub complete: bool,
    /// ⭐ 没走完的子树（[`IncompleteNode`]）。`complete == false ⇔ 非空`。
    pub incomplete: Vec<IncompleteNode>,
    /// ⭐ **按产品规则有意排除**的目录（过滤清单命中，`design/0003` §2.3 ②）。
    ///
    /// ⚠️ 与 [`incomplete`](Self::incomplete) **必须分开**：前者是"我们知道这里有什么，
    /// 故意不进去"（灰显可见），后者是"我们不知道"（保守视为非空）。⛔ 不许合成一个模糊说法。
    pub ignored_dirs: Vec<String>,
}

impl FileIndex {
    /// ⭐ 这份索引对**当刻**的授权还新鲜吗。
    ///
    /// 判据三条，缺一不可（`design/0009` §2.1 ② 末 ＋ `design/0050` `INV-DISK-09`）：
    /// ① `roots_gen` 与当刻代次相同；② 覆盖的 root 集合与当刻授权**逐项一致**；
    /// ③ `disk_epoch` 与当刻纪元相同。
    ///
    /// ⚠️ ② 不是 ① 的推论：代次只在 `roots` 变化时 +1，
    /// 但**它是单调计数**——真要比对"覆盖的是不是当刻这几个目录"，就得比集合。
    /// 代价是一次 N 元比较（`roots` 通常只有一项）。
    ///
    /// ⚠️ ③ 也不是 ① 的推论（`design/0050` 的 `INV-DISK-01`）：同一会话里在根下
    /// 新建一个文件，代次**一个字节不动**，而清单已经缺了一条。
    ///
    /// ⚠️⚠️ ③ 只回答"**这份索引**还对应当刻观测吗"，⛔ 不回答"盘上真的没变"——
    /// 我们只能靠监视信号得知变化；监视坏掉时会降级并**明示**（`INV-DISK-11`），
    /// ⛔ 不许把这句读成"没收到信号就是没变"。
    pub fn is_fresh(&self, generation: u64, epoch: u64, roots: &[PathBuf]) -> bool {
        if self.roots_gen != generation || self.disk_epoch != epoch || self.roots.len() != roots.len()
        {
            return false;
        }
        roots.iter().all(|r| {
            let s = r.display().to_string();
            self.roots.iter().any(|x| *x == s)
        })
    }

    /// 这份索引是多久以前扫出来的（毫秒）。
    pub fn age_ms(&self) -> u64 {
        self.built_at.elapsed().as_millis().min(u64::MAX as u128) as u64
    }

    /// 条目数（日志与单测用）。
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// ⭐ **树过滤的判据集合**（`design/0041` §2.1.3 / §2.2）。
    ///
    /// 一条目录**只有**落在这个集合里，前端才允许按"子树无 md"把它隐藏。
    /// 集合 = 三部分的**自身 ＋ 祖先闭包**（都截到 root 为止）：
    ///
    /// 1. 每条 md 条目的各级父目录（⇒ "有 md"）；
    /// 2. [`ignored_dirs`](Self::ignored_dirs)——按产品规则有意排除，但仍要**可达**；
    /// 3. [`incomplete`](Self::incomplete)——⚠️ **未知一律保留**（R1 / `INV-DOCS-08`）。
    ///
    /// ⚠️ **故意不返回 `dirs_with_md` 与 `keep_dirs` 两份**：前端只需要一个
    /// "要不要显示"的布尔判据；给两份等于把"哪一个优先"变成前端的第二份真值。
    ///
    /// ⚠️ 结果是**绝对路径字符串**，与 `list_dir` 回来的 `TreeEntry::path` 同一形状
    /// （都来自已规范化的父目录），⛔ 不在这里再做一次 `canonicalize`（那是读盘）。
    ///
    /// ⚠️ **为什么不用再筛一次 `.md`**：索引本身就只收 `.md`——`classify()` 把
    /// "扩展名不是 `.md`"的普通文件判成 `Class::Other`（不列、不进入），这一条
    /// 与树、搜索共用（`INV-SEARCH-02`）。⛔ 在这里补第二个后缀判据 = 第二份真值。
    pub fn keep_dirs(&self) -> Vec<String> {
        let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

        // ① md 条目：`rel` 的各级父目录拼回绝对路径
        for e in &self.entries {
            let mut cur = Path::new(&e.rel).parent();
            while let Some(rel_dir) = cur {
                if rel_dir.as_os_str().is_empty() {
                    break;
                }
                set.insert(Path::new(&e.root).join(rel_dir).to_string_lossy().into_owned());
                cur = rel_dir.parent();
            }
        }

        // ②③ 有意排除的目录、未走完的子树：自身 + 到 root 为止的祖先链
        for p in self.ignored_dirs.iter().chain(self.incomplete.iter().map(|n| &n.path)) {
            push_self_and_ancestors(&mut set, p, &self.roots);
        }

        set.into_iter().collect()
    }
}

/// 把 `path` 与它的祖先收进 `set`，**截到最近的 root 为止**。
///
/// ⚠️ 找不到任何 root（不该发生：路径来自 `walk`，而 `walk` 从 root 出发）
/// ⇒ **只加它自己**，⛔ 不往文件系统根走——那会给前端一张与授权无关的路径表。
fn push_self_and_ancestors(
    set: &mut std::collections::BTreeSet<String>,
    path: &str,
    roots: &[String],
) {
    let p = Path::new(path);
    let mut boundary: Option<&Path> = None;
    for r in roots {
        let rp = Path::new(r);
        if p.starts_with(rp) {
            // 多 root 时取**最长**的那个（嵌套 root 的情形）
            let better = match boundary {
                Some(b) => rp.as_os_str().len() > b.as_os_str().len(),
                None => true,
            };
            if better {
                boundary = Some(rp);
            }
        }
    }
    let Some(root) = boundary else {
        set.insert(path.to_string());
        return;
    };
    let mut cur = Some(p);
    while let Some(c) = cur {
        set.insert(c.to_string_lossy().into_owned());
        if c == root {
            break;
        }
        cur = c.parent();
    }
}

/// ⭐ **递归建索引**（`design/0009` §2.1 ①）。
///
/// ⚠️ **它必须在会话锁之外跑**（§2.1 ②.2）：热盘 8.9 ms / 71 k 项看着不多，
/// 但冷盘或网络盘会退化，而 `open_document` 用的是**同一把锁**——
/// 遍历持锁的代价是"用户此刻要打开的文档被它挡住"。
/// 调用方（`commands::fs::search_files`）因此走**三段式**：
/// 持锁取快照 → **放锁**遍历（就是这个函数）→ 持锁核对代次后再发布。
///
/// ⚠️ **根读不出来 = 整条命令失败**；某个**子目录**读不出来则跳过并计数
/// （§2.1 ②.2：根没了通常是授权没了或目录被删，静默返回"0 条命中"
/// 会让用户以为这个目录里本来就没有）。
/// ⭐ `design/0050` 起多一个 `epoch` 参数（`INV-DISK-09`）：索引必须**记住自己是哪一刻的观测**。
/// ⚠️ 不传的话，调用方只能事后盖章，而"盖章点"与"遍历起点"之间的事件就会被算进这份清单里
/// ——那正是"用旧 `keep_dirs` 提交新树"那条缺陷的同款。
pub fn build_index(grants: &SessionGrants, ignore: &[String], epoch: u64) -> Result<FileIndex, Denied> {
    let t0 = Instant::now();
    let mut idx = FileIndex {
        roots_gen: grants.root_generation(),
        disk_epoch: epoch,
        built_at: t0,
        rev: 0,
        roots: Vec::new(),
        entries: Vec::new(),
        stats: IndexStats::default(),
        complete: true,
        incomplete: Vec::new(),
        ignored_dirs: Vec::new(),
    };

    for root in grants.roots() {
        let real = grants.check_readable(root)?;
        if !real.is_dir() {
            return Err(Denied::not_found(root));
        }
        let root_str = real.display().to_string();
        walk(grants, &real, &real, &root_str, 0, ignore, &mut idx);
        idx.roots.push(root_str);
    }

    idx.complete = idx.incomplete.is_empty();
    idx.stats.scan_ms = t0.elapsed().as_secs_f64() * 1000.0;
    Ok(idx)
}

/// 递归走一棵子树。⭐ **每一层 `read_dir` 之前都过唯一校验入口**（`INV-SEARCH-01`）。
///
/// ⛔ 不靠"从规范化 root 出发 + 不跟软链 ⇒ 走过的路径**必然**在 root 内"那种推导
/// （`design/0009` §2.1 ① 已撤回）：父层 `read_dir` 到我们下一次 `read_dir` 之间，
/// 这个目录可以被换成指向 root 外的软链——那样就会**列举出未授权目录里的文件名**，
/// 就算正文最终被 `open_document` 拒掉，**文件名已经泄露了**。
///
/// ⚠️ 残余窗口如实写在这：`check_readable` 返回的 `real` 是**当下**解完软链的路径，
/// 拿它去 `read_dir` 之间仍有一个极短窗口。⭐ 这与既有 `list_dir` **完全同源**，
/// 不是本次放宽了标准；要收紧应当在 `check_readable` 里收紧（⛔ 不在这条路上打补丁）。
fn walk(
    grants: &SessionGrants,
    dir: &Path,
    root_real: &Path,
    root_str: &str,
    depth: usize,
    ignore: &[String],
    idx: &mut FileIndex,
) {
    if depth > MAX_DEPTH {
        idx.stats.skipped_deep += 1;
        // ⭐ 记**路径**而不只是计数：这份子树对 0041 来说是"未知"，不是"空"（R1）
        idx.incomplete.push(IncompleteNode {
            path: dir.to_string_lossy().into_owned(),
            reason: "deep".to_string(),
        });
        return;
    }
    // ⭐ 唯一的校验入口。⛔ 用返回的 `real` 去 `read_dir`，不用传进来那个串（TOCTOU）。
    let real = match grants.check_readable(dir) {
        Ok(p) => p,
        Err(_) => {
            idx.stats.skipped_denied += 1;
            idx.incomplete.push(IncompleteNode {
                path: dir.to_string_lossy().into_owned(),
                reason: "denied".to_string(),
            });
            return;
        }
    };
    // ⚠️ 校验通过之后**再确认一次"它还在 root 之内"**——上面那句推导被撤回，
    //    靠的就是这一刀（软链逃逸的子树在这里被整个跳过，"宁少不越权"）。
    if !grants.is_inside_roots(&real) {
        idx.stats.skipped_denied += 1;
        idx.incomplete.push(IncompleteNode {
            path: real.to_string_lossy().into_owned(),
            reason: "denied".to_string(),
        });
        return;
    }
    let Ok(rd) = std::fs::read_dir(&real) else {
        // 权限不足 / IO 错误 / 刚被删：**跳过这棵子树**，⛔ 不整份失败
        idx.stats.skipped_denied += 1;
        idx.incomplete.push(IncompleteNode {
            path: real.to_string_lossy().into_owned(),
            reason: "denied".to_string(),
        });
        return;
    };
    idx.stats.dirs += 1;

    for item in rd {
        let Ok(item) = item else {
            idx.stats.skipped_other += 1;
            idx.incomplete.push(IncompleteNode {
                path: real.to_string_lossy().into_owned(),
                reason: "other".to_string(),
            });
            continue;
        };
        idx.stats.scanned += 1;

        let name = item.file_name().to_string_lossy().into_owned();
        let Ok(ft) = item.file_type() else {
            idx.stats.skipped_other += 1;
            idx.incomplete.push(IncompleteNode {
                path: real.to_string_lossy().into_owned(),
                reason: "other".to_string(),
            });
            continue;
        };
        if ft.is_symlink() {
            // ⭐ `INV-SEARCH-05`：不跟随即不产生——**顺带**保证"循环软链不会挂死"
            idx.stats.skipped_symlink += 1;
            continue;
        }

        let is_dir = ft.is_dir();
        // ⭐ 与单层扫描**同一个谓词**（`INV-SEARCH-02`）
        match classify(&name, is_dir, ignore) {
            Class::Hidden => idx.stats.skipped_dot += 1,
            Class::Ignored => {
                idx.stats.ignored += 1; // ② 类：⛔ 绝不进入子项
                // ⭐ 记**目录路径**（`design/0041` R1）：它是有意排除，不是漏扫——
                //    树里要让它（以及通往它的祖先）继续可达，⛔ 不许被"无 md 就隐藏"顺手藏掉。
                if is_dir {
                    idx.ignored_dirs.push(item.path().to_string_lossy().into_owned());
                }
            }
            Class::Other => idx.stats.skipped_other += 1,
            Class::Normal => {
                let child = item.path();
                if is_dir {
                    walk(grants, &child, root_real, root_str, depth + 1, ignore, idx);
                } else {
                    // ⚠️ `child` 的父目录是 `real`（**已规范化**）⇒ 它本身就是真实路径，
                    //    ⛔ 不是"拼出来的猜测"（`INV-TREE-01` 的同一条精神）。
                    let rel = match child.strip_prefix(root_real) {
                        Ok(p) => p.to_string_lossy().into_owned(),
                        Err(_) => name.clone(),
                    };
                    idx.entries.push(IndexEntry {
                        root: root_str.to_string(),
                        real_path: child.to_string_lossy().into_owned(),
                        rel,
                        name,
                    });
                }
            }
        }
    }
}

/// 文档列表的条数上限（`design/0041` §2.1.3）。
///
/// ⚠️ **它约束的是 IPC 载荷，不是渲染**：实际渲染成本已实测（`notes/0032` §4.1），
/// 1 276 行 29 ms、5 000 行 124 ms ⇒ 渲染侧的可见上限是前端那个 `MAX_RENDER`。
/// ⛔ 截断**只影响"发什么"**，不影响"判什么"：`keep_dirs` 永远来自完整索引。
pub const MAX_DOCS: usize = 10_000;

/// 一次 `list_documents` **整份 IPC 载荷**的字节预算（`design/0041` §2.1.3，R7）。
///
/// ⚠️ **与 [`MAX_DOCS`] 是两条尺子**：条数上限管"发多少条"，这条管"整份 JSON 多大"。
/// 只按条数算会漏掉两处——`keep_dirs` 是**路径表**（不随 `entries` 截断）、
/// 每条路径长度随目录深度增长。⭐ 实测字节数在 `文档列表载荷预算` 那条测试的输出里。
pub const MAX_DOCLIST_JSON_BYTES: usize = 24 * 1024 * 1024;

/// 响应里最多列出多少条"未走完的子树"（`design/0041` §2.1.3）。
///
/// ⚠️ 这只是**展示上限**：`keep_dirs` 用的是完整列表，⛔ 不跟着截。
pub const MAX_INCOMPLETE_REPORT: usize = 100;

/// ⭐ 文档列表的**派生视图**（`design/0041` §2.1.3）。
///
/// ⚠️ `entries` 是**排好序、已截断**的副本；`keep_dirs` 与 `total` 来自**完整索引**。
/// ⛔ 不就地改 [`FileIndex::entries`] 的顺序——那份 `Arc` 还被搜索与树过滤共用（R6）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocListView {
    /// 排好序、已截断的条目。
    pub entries: Vec<IndexEntry>,
    /// **截断前**的真值条数。
    pub total: usize,
    /// 是否被 [`MAX_DOCS`] 截断（前端必须把它显示出来）。
    pub truncated: bool,
    /// 树过滤的判据集合（见 [`FileIndex::keep_dirs`]）。
    pub keep_dirs: Vec<String>,
}

/// 从一份索引派生文档列表视图（`design/0041` §2.3）。
///
/// ⚠️ 顺序固定：**先排序、后截断**（R6）——截断必须作用在稳定序的尾部，
/// 否则"截到前 N 条"会变成"先随机丢再排"。
///
/// ⚠️ **索引里全是 `.md`**（`classify()` 在 `walk` 那侧挡掉了其它扩展名，
/// `INV-SEARCH-02`）⇒ 这里⛔ **不需要也不许**再筛一次后缀：`entries` 就是文档集。
/// 同理 [`FileIndex::keep_dirs`] 的"有 md"判据直接来自这张表。
pub fn doc_list_view(idx: &FileIndex) -> DocListView {
    let mut entries = sort_docs(&idx.entries);
    let total = entries.len();
    let truncated = total > MAX_DOCS;
    if truncated {
        entries.truncate(MAX_DOCS);
    }
    DocListView { entries, total, truncated, keep_dirs: idx.keep_dirs() }
}

/// ⭐ **文档列表的排序**（`design/0041` §2.3，R6）。
///
/// 键是**显式的路径分量元组**，⛔ 不是"两次 stable sort"：
///
/// 1. 父路径的**每一级目录名**逐个用自然序比较（`a/z.md` < `b/a.md`）；
/// 2. 父路径全相等时比文件名（同一个比较器）；
/// 3. 仍相等（同名同目录，理论上不可能）按 `real_path` 字节序定案
///    ⇒ 结果与输入顺序无关、可复现。
///
/// ⚠️ 父路径**按分量比**而不是当整串比：整串比较会把 `a/b` 与 `ab` 的相对次序
/// 交给字符折叠，而不是目录层级。
/// ⚠️ 键**一次性建好**再排序（`order::NameKey` 的规矩：5000 项不能造十万个 `NSString`）。
pub fn sort_docs(items: &[IndexEntry]) -> Vec<IndexEntry> {
    if items.len() < 2 {
        return items.to_vec();
    }
    // ⚠️ pool 必须先于键声明（`NameKey` 的 `release` 要在 pool 弹出之前发生）
    let _pool = order::Pool::new();

    let parents: Vec<Vec<order::NameKey>> = items
        .iter()
        .map(|e| match Path::new(&e.rel).parent() {
            Some(p) if !p.as_os_str().is_empty() => {
                p.iter().map(|c| order::name_key(&c.to_string_lossy())).collect()
            }
            _ => Vec::new(),
        })
        .collect();
    let names: Vec<order::NameKey> = items.iter().map(|e| order::name_key(&e.name)).collect();

    let mut order_idx: Vec<usize> = (0..items.len()).collect();
    order_idx.sort_by(|&i, &j| {
        let (pa, pb) = (&parents[i], &parents[j]);
        for k in 0..pa.len().min(pb.len()) {
            match order::compare_keys(&pa[k], &pb[k]) {
                std::cmp::Ordering::Equal => {}
                other => return other,
            }
        }
        match pa.len().cmp(&pb.len()) {
            std::cmp::Ordering::Equal => {}
            other => return other,
        }
        match order::compare_keys(&names[i], &names[j]) {
            std::cmp::Ordering::Equal => {}
            other => return other,
        }
        items[i].real_path.cmp(&items[j].real_path)
    });

    order_idx.into_iter().map(|i| items[i].clone()).collect()
}

/// 一条命中。⚠️ 字段名与 `design/0009` §2.1 ②.1 的响应契约**逐字对应**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchHit {
    /// 这条属于哪个 root（多 root 时前端分组用）。
    pub root: String,
    /// 规范化后的真实路径——**直接交给 `open_document`**。
    pub real_path: String,
    /// 相对 root 的路径（显示用）。
    pub rel: String,
    /// 文件名。
    pub name: String,
    /// ⭐ 命中区间：**原 `name` 上的 UTF-8 字节区间**，扁平数组 `[s0,e0,s1,e1,…]`
    /// （`INV-SEARCH-03`）。⚠️ 前端负责把它换算成 UTF-16（`document/search.rs` 同一份契约）。
    ///
    /// ⚠️ 用扁平数组而不是对象数组：5 万个候选里 200 条命中、每条 1–3 段，
    /// 对象数组的 JSON 体积约是它的 3 倍（`design/0009` §2.1 ②.1，⚠️ **未实测**）。
    #[serde(rename = "match")]
    pub match_spans: Vec<u32>,
}

/// `search_files` 的返回值（`design/0009` §2.1 ②.1）。
///
/// ⛔ 响应里**不回条目的内容**——这条命令只碰**文件名**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchResult {
    /// 当刻 `root_generation`（前端提交前比对）。
    pub generation: u64,
    /// 原样回显（`INV-VER-01` 同族）。
    pub req: u64,
    /// 本份索引覆盖的 root（规范化后），用于分组显示。
    pub roots: Vec<String>,
    /// 命中的条目（已粗排、已截断）。
    pub entries: Vec<SearchHit>,
    /// 命中总数（**截断前**的真值）。
    pub total_hits: usize,
    /// 是否被 [`MATCH_LIMIT`] 截断。
    pub truncated: bool,
    /// ⭐ **索引年龄（毫秒）**。⚠️ 名字沿用设计的 `built_at_ms`，语义是"这份索引
    /// 是多久以前扫出来的"——`Instant` 没有纪元，所以**只能是年龄，⛔ 不是时间戳**。
    pub built_at_ms: u64,
}

/// ⭐ `list_documents` 的返回值（`design/0041` §2.1.3）。
///
/// ⚠️ **身份三件套 ＋ 完整性两件套**都是契约的一部分，⛔ 不是调试字段：
/// `gen` / `req` / `index_rev` 是前端提交判据（R2/R3）；
/// `complete` / `incomplete` 是"收录范围"的诚实出口（R1）——
/// 它们与 [`truncated`](Self::truncated) **必须分开说**：一个是"没看全"，一个是"没发全"。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DocListResult {
    /// 回显当刻 `root_generation`（前端提交前比对）。
    #[serde(rename = "gen")]
    pub generation: u64,
    /// 回显请求号（前端提交前比对）。
    pub req: u64,
    /// 这份清单的发布版本（同代次内单调递增，前端据此拒绝更旧的清单）。
    pub index_rev: u64,
    /// 索引年龄（毫秒）。⚠️ 只说明"多久前扫的"，⛔ **不代替版本**（R2）。
    pub age_ms: u64,
    /// 收录是否完整（= 没有任何未走完的子树）。
    pub complete: bool,
    /// 未走完的子树（**最多 [`MAX_INCOMPLETE_REPORT`] 条**）。
    pub incomplete: Vec<IncompleteNode>,
    /// `incomplete` 是否被展示上限截断。
    pub incomplete_truncated: bool,
    /// 本份索引覆盖的 root。
    pub roots: Vec<String>,
    /// 排好序、已截断的条目。
    pub entries: Vec<IndexEntry>,
    /// 树过滤的判据集合（**来自完整索引，不受 `entries` 截断影响**）。
    pub keep_dirs: Vec<String>,
    /// 截断前的条目总数。
    pub total: usize,
    /// 是否被 [`MAX_DOCS`] 截断。
    pub truncated: bool,
    /// 本次生效的条数上限（前端文案用它，⛔ 不抄常量）。
    pub max_docs: usize,
    /// 遍历统计（日志与"为什么没收录全"的判据）。
    pub stats: IndexStats,
}

impl DocListResult {
    /// 从一份已发布的索引组装响应。
    ///
    /// ⚠️ `keep_dirs` / `total` 走**完整索引**；只有 `entries` 受 [`MAX_DOCS`] 约束。
    pub fn from_index(idx: &FileIndex, req: u64) -> Self {
        let view = doc_list_view(idx);
        let incomplete_truncated = idx.incomplete.len() > MAX_INCOMPLETE_REPORT;
        let mut incomplete = idx.incomplete.clone();
        incomplete.truncate(MAX_INCOMPLETE_REPORT);
        Self {
            generation: idx.roots_gen,
            req,
            index_rev: idx.rev,
            age_ms: idx.age_ms(),
            complete: idx.complete,
            incomplete,
            incomplete_truncated,
            roots: idx.roots.clone(),
            entries: view.entries,
            keep_dirs: view.keep_dirs,
            total: view.total,
            truncated: view.truncated,
            max_docs: MAX_DOCS,
            stats: idx.stats.clone(),
        }
    }
}

/// 一次匹配的结果（还没套上 `req`/`generation`——那是命令层的事）。
#[derive(Debug, Clone)]
pub struct SearchOutcome {
    /// 已粗排、已截断的命中。
    pub hits: Vec<SearchHit>,
    /// 截断前的命中总数。
    pub total_hits: usize,
    /// 是否被截断。
    pub truncated: bool,
}

/// 排序用的候选。⚠️ **它存在的唯一理由是省内存**：
/// 5 万个条目全命中时，直接建 [`SearchHit`] 要 clone 三份 `String` × 5 万，
/// 而真正进结果的只有 [`MATCH_LIMIT`] 条。⇒ 候选只带**下标**与排名。
#[derive(Debug, Clone)]
struct Cand {
    /// 在 `index.entries` 里的下标。
    i: usize,
    /// 段：`0` = 连续子串命中，`1` = 子序列命中。
    rank: u8,
    /// 名字的**字符数**（⛔ 不是字节数——`design/0009` §2.1 ③ 点名过这件事）。
    chars: usize,
    /// 命中区间（原串 UTF-8 字节，已合并相邻）。
    segs: Vec<(u32, u32)>,
}

/// ⭐ **逐字符 1:1 折叠**（`INV-SEARCH-03`）。
///
/// ⛔ **不用 `to_lowercase()`**：它会**改变字符数**（`İ` → `i` + 组合点，1 个字符变 2 个），
/// 折叠后的下标就**回不到原串**了——高亮会静默错位（`notes/0011` §4 的实测反例）。
/// ✅ 只折 ASCII 大小写 ⇒ 折叠是**双射**，下标恒等。
fn fold_char(c: char) -> char {
    c.to_ascii_lowercase()
}

/// 在**原串**上做一次子序列匹配，返回命中区间（已把相邻命中字符合并成极大段）。
///
/// ⚠️ 合并是**本次实施的取舍**（`design/0009` 只说"区间"）：`abc` 连续命中三个字符
/// 若各占一段，前端要多开两个 `<span>` 而视觉上毫无区别。
/// ⭐ 顺带带来一个漂亮的判据：`segs.len() == 1` ⇔ **连续子串命中**——
/// 粗排的第一段（§2.1 ③）不需要另写一遍"连不连续"的判断。
///
/// ⚠️ 贪心匹配（第一个能配上的就配）：V1 **刻意不引入打分权重表**
/// （§2.1 ③，⛔ 那是调参黑洞，"更聪明"也无法验收）。
fn match_name(name: &str, pat: &[char]) -> Option<Vec<(u32, u32)>> {
    if pat.is_empty() {
        return None;
    }
    let mut segs: Vec<(u32, u32)> = Vec::new();
    let mut pi = 0usize;
    for (b, c) in name.char_indices() {
        if pi >= pat.len() {
            break;
        }
        if fold_char(c) != pat[pi] {
            continue;
        }
        pi += 1;
        let s = b as u32;
        let e = (b + c.len_utf8()) as u32;
        match segs.last_mut() {
            // 与上一段**首尾相接** ⇒ 并进去（这就是"连续子串"）
            Some(last) if last.1 == s => last.1 = e,
            _ => segs.push((s, e)),
        }
    }
    if pi == pat.len() { Some(segs) } else { None }
}

/// ⭐ 在一份索引上做匹配 + 粗排 + 截断（`design/0009` §2.1 ③）。
///
/// 粗排三级，**全是为"可解释"服务的**（⛔ 没有权重表）：
/// ① 连续子串命中 → ② 子序列命中；同段内按**名字字符数**升序；
/// 再同则按树里的**自然序**（`fs/order.rs`）。
///
/// ⚠️ 自然序那一级只做在**会进结果的窗口**上（见下面那两段注释）——
/// 全量自然序要建 N 个 `NSString`，而 5 万条命中时那是白花的钱。
pub fn search(index: &FileIndex, pattern: &str) -> SearchOutcome {
    let pat: Vec<char> = pattern.trim().chars().map(fold_char).collect();
    if pat.is_empty() {
        // ⚠️ 空输入**什么都不显示**（`design/0009` §4：空列表不是"最近文件"）
        return SearchOutcome { hits: Vec::new(), total_hits: 0, truncated: false };
    }

    let mut cands: Vec<Cand> = Vec::new();
    for (i, e) in index.entries.iter().enumerate() {
        if let Some(segs) = match_name(&e.name, &pat) {
            cands.push(Cand {
                i,
                rank: if segs.len() == 1 { 0 } else { 1 },
                chars: e.name.chars().count(),
                segs,
            });
        }
    }
    let total = cands.len();

    // ①② 用**整数键**排序：便宜，且 `sort_by_key` 是稳定排序（可复现）
    cands.sort_by_key(|c| (c.rank, c.chars));

    let keep = cands.len().min(MATCH_LIMIT);
    // ⚠️ 窗口右端要含**边界那一组的全部成员**：只取前 `keep` 个的话，
    //    第 200 名与第 201 名同段同长度时，"谁被截掉"就取决于 readdir 顺序了
    //    ——那是同一个查询在不同时刻给出不同结果。
    let mut end = keep;
    if keep > 0 {
        let k = (cands[keep - 1].rank, cands[keep - 1].chars);
        while end < cands.len() && (cands[end].rank, cands[end].chars) == k {
            end += 1;
        }
    }

    // ③ 自然序：逐个"同段同长度"的极大组各排一次（`order::sorted` 会预建键）
    if end >= 2 {
        let head: Vec<Cand> = cands[..end].to_vec();
        let mut out: Vec<Cand> = Vec::with_capacity(head.len());
        let mut s = 0;
        while s < head.len() {
            let k = (head[s].rank, head[s].chars);
            let mut e = s + 1;
            while e < head.len() && (head[e].rank, head[e].chars) == k {
                e += 1;
            }
            if e - s == 1 {
                out.push(head[s].clone());
            } else {
                out.extend(order::sorted(head[s..e].to_vec(), |c| {
                    (false, index.entries[c.i].name.clone())
                }));
            }
            s = e;
        }
        cands = out;
    }
    cands.truncate(keep);

    let hits = cands
        .into_iter()
        .map(|c| {
            let e = &index.entries[c.i];
            SearchHit {
                root: e.root.clone(),
                real_path: e.real_path.clone(),
                rel: e.rel.clone(),
                name: e.name.clone(),
                match_spans: c.segs.iter().flat_map(|(a, b)| [*a, *b]).collect(),
            }
        })
        .collect();

    SearchOutcome { hits, total_hits: total, truncated: total > keep }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 出厂过滤清单（测试默认）：本文件绝大多数用例不关心"清单里有什么"，
    /// 只关心**判定与扫描**；自定义清单的用例显式传自己的那份（`design/0040`）。
    fn ign() -> Vec<String> {
        crate::fs::tree::default_ignore_dirs()
    }
    use std::fs;

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(tag: &str) -> Self {
            let base =
                std::env::temp_dir().join(format!("rmd-tree-{}-{tag}", std::process::id()));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(&base).unwrap();
            TestDir { path: fs::canonicalize(&base).unwrap() }
        }

        fn dir(&self, rel: &str) -> PathBuf {
            let p = self.path.join(rel);
            fs::create_dir_all(&p).unwrap();
            p
        }

        fn file(&self, rel: &str) -> PathBuf {
            let p = self.path.join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, "x").unwrap();
            p
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn grants_for(root: &Path) -> SessionGrants {
        let mut g = SessionGrants::new();
        g.authorize_root(root).unwrap();
        g
    }

    /// ⭐ §7 步骤 5 的判据：**① 类完全不出现在树里**。
    #[test]
    fn 点开头的条目完全隐藏且不扫描() {
        let t = TestDir::new("dot");
        let root = t.dir("root");
        t.dir("root/.git");
        t.file("root/.git/config");
        t.file("root/.hidden.md");
        t.file("root/visible.md");

        let g = grants_for(&root);
        let r = list_dir(&g, &root, g.root_generation(), 0, 1, &ign()).unwrap();

        let names: Vec<&str> = r.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["visible.md"], "① 类必须完全找不到");
        assert_eq!(r.stats.skipped_dot, 2, ".git 与 .hidden.md 都算 ① 类");
        // ⚠️ `scanned` 只数**这一层**读到的 3 项（`.git` / `.hidden.md` / `visible.md`）。
        //    若真进了 `.git`，它会多出 `config` ⇒ 变成 4
        assert_eq!(r.stats.scanned, 3, "scanned 只含本层，证明没有进入子项");
    }

    /// ⭐ §7 步骤 5 的另一半：**② 类可见、灰显、不可展开，且不扫描**。
    #[test]
    fn 忽略清单里的目录可见但灰显且不扫描() {
        let t = TestDir::new("ignore");
        let root = t.dir("root");
        t.dir("root/node_modules");
        for i in 0..50 {
            t.file(&format!("root/node_modules/pkg{i}.js"));
        }
        t.dir("root/docs");
        t.file("root/a.md");

        let g = grants_for(&root);
        let r = list_dir(&g, &root, g.root_generation(), 0, 1, &ign()).unwrap();

        let nm = r.entries.iter().find(|e| e.name == "node_modules").expect("② 类要看得见");
        assert!(nm.is_dir);
        assert!(nm.ignored, "② 类必须带 ignored 标记（前端据此灰显 + 不可展开）");
        assert_eq!(r.stats.ignored, 1);
        // ⚠️ 只读到了 root 这一层的 3 项（node_modules / docs / a.md）。
        //    若进了 node_modules 的子项，scanned 会变成 53
        assert_eq!(r.stats.scanned, 3, "⛔ 绝不进入 ② 类的子项");
        assert_eq!(r.entries.len(), 3);
    }

    #[test]
    fn 只列目录与_md_文件() {
        let t = TestDir::new("kinds");
        let root = t.dir("root");
        t.dir("root/sub");
        t.file("root/a.md");
        t.file("root/README.MD");
        t.file("root/b.markdown");
        t.file("root/c.txt");
        t.file("root/d"); // 无扩展名

        let g = grants_for(&root);
        let r = list_dir(&g, &root, g.root_generation(), 0, 1, &ign()).unwrap();
        let names: Vec<&str> = r.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["sub", "a.md", "README.MD"]);
        // ⚠️ `.markdown` / `.txt` / 无扩展名都被"其它"挡掉——V1 只认 `.md`
        assert_eq!(r.stats.skipped_other, 3);
    }

    #[test]
    fn 目录在前_同层内自然排序() {
        let t = TestDir::new("order");
        let root = t.dir("root");
        t.dir("root/zdir");
        t.dir("root/adir");
        t.file("root/file10.md");
        t.file("root/file2.md");
        t.file("root/笔记10.md");
        t.file("root/笔记2.md");

        let g = grants_for(&root);
        let r = list_dir(&g, &root, g.root_generation(), 0, 1, &ign()).unwrap();
        let names: Vec<&str> = r.entries.iter().map(|e| e.name.as_str()).collect();

        // ⭐ 与首选语言**无关**的两条：目录在前、同层内数字段按自然序。
        assert!(r.entries[0].is_dir && r.entries[1].is_dir, "目录必须在最前");
        let pos = |n: &str| names.iter().position(|x| *x == n);
        assert!(pos("file2.md") < pos("file10.md"), "file2.md 应在 file10.md 前：{names:?}");
        assert!(pos("笔记2.md") < pos("笔记10.md"), "笔记2.md 应在 笔记10.md 前：{names:?}");

        // ⚠️ 中文名的**位置**随首选语言变（`docs/kb/0029`，2026-10-23 首轮 GitHub Actions
        //    实测：`en-US` runner 上中文名排在 ASCII **之后**，本机 `zh` 下排在**之前**）。
        //    ⛔ 别按直觉把某一种当成"对的那种"。
        #[cfg(target_os = "macos")]
        let lang = crate::fs::order::foundation::preferred_language().unwrap_or_default();
        #[cfg(not(target_os = "macos"))]
        let lang = String::new();
        let expected: Option<Vec<&str>> = if lang.starts_with("zh") {
            Some(vec!["adir", "zdir", "笔记2.md", "笔记10.md", "file2.md", "file10.md"])
        } else if lang.starts_with("en") {
            Some(vec!["adir", "zdir", "file2.md", "file10.md", "笔记2.md", "笔记10.md"])
        } else {
            None
        };
        match expected {
            Some(e) => assert_eq!(names, e, "首选语言 = {lang}"),
            None => eprintln!(
                "⚠️ 跳过整表：首选语言 = {lang:?}（本仓只实测过 zh / en，见 kb/0029）；实际顺序 = {names:?}"
            ),
        }
    }

    #[test]
    fn 符号链接不产生() {
        let t = TestDir::new("symlink");
        let root = t.dir("root");
        t.dir("root/real");
        t.file("root/a.md");
        std::os::unix::fs::symlink(root.join("real"), root.join("link-dir")).unwrap();
        std::os::unix::fs::symlink(root.join("a.md"), root.join("link.md")).unwrap();

        let g = grants_for(&root);
        let r = list_dir(&g, &root, g.root_generation(), 0, 1, &ign()).unwrap();
        let names: Vec<&str> = r.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["real", "a.md"], "软链不跟随 = 不产生");
        assert_eq!(r.stats.skipped_symlink, 2);
    }

    #[test]
    fn 代次不符立即返回_stale_且不做任何工作() {
        let t = TestDir::new("stale");
        let root = t.dir("root");
        t.file("root/a.md");
        let g = grants_for(&root);
        let cur = g.root_generation();

        match list_dir(&g, &root, cur.wrapping_sub(1), 0, 1, &ign()) {
            Err(Denied::Stale { got, expected }) => {
                assert_eq!(expected, cur);
                assert_ne!(got, cur);
            }
            other => panic!("应当 Stale，实得 {other:?}"),
        }
    }

    #[test]
    fn 未授权的目录被拒() {
        let t = TestDir::new("denied");
        let root = t.dir("root");
        let other = t.dir("other");
        t.file("other/a.md");
        let g = grants_for(&root);

        match list_dir(&g, &other, g.root_generation(), 0, 1, &ign()) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应当 NotAuthorized，实得 {other:?}"),
        }
    }

    #[test]
    fn 对一个文件调用_list_dir_归_not_found() {
        let t = TestDir::new("file-as-dir");
        let root = t.dir("root");
        let f = t.file("root/a.md");
        let g = grants_for(&root);
        match list_dir(&g, &f, g.root_generation(), 0, 1, &ign()) {
            Err(Denied::NotFound { .. }) => {}
            other => panic!("应当 NotFound，实得 {other:?}"),
        }
    }

    #[test]
    fn 缓存键带代次_切根不会命中上一代的结果() {
        let t = TestDir::new("cache");
        let root = t.dir("root");
        t.file("root/a.md");
        let c = TreeCache::new();

        let stamp = c.begin(1, 0, &root);
        assert!(c.commit(1, 0, &root, stamp, vec![]));
        assert!(c.hit(1, 0, &root).is_some());
        // ⭐ 同一路径、下一代：必须是未命中（裸 path 做键就会在这里出错）
        assert!(c.hit(2, 0, &root).is_none());
        assert_eq!(c.len(), 1);

        let stamp2 = c.begin(2, 0, &root);
        assert!(c.commit(2, 0, &root, stamp2, vec![]));
        c.retain_gen(2);
        assert_eq!(c.len(), 1, "旧代被清掉");
        assert!(c.hit(1, 0, &root).is_none());
        assert!(c.hit(2, 0, &root).is_some());
    }

    // ── 提交票（`design/0039` §7 的 6 条）────────────────────────────

    /// 造一条能认出来的条目（票号判据只关心"写进去的是哪一份"）。
    fn ent(name: &str) -> TreeEntry {
        TreeEntry {
            name: name.to_string(),
            path: format!("/x/{name}"),
            is_dir: false,
            ignored: false,
        }
    }

    fn names_at(c: &TreeCache, generation: u64, epoch: u64, path: &Path) -> Vec<String> {
        c.hit(generation, epoch, path)
            .map(|v| v.into_iter().map(|e| e.name).collect())
            .unwrap_or_default()
    }

    /// 1️⃣ `begin` 之后 `commit` ⇒ 写入，`hit` 命中。
    #[test]
    fn 票有效时提交成功且能命中() {
        let c = TreeCache::new();
        let p = Path::new("/tmp/a");
        assert!(c.hit(1, 0, p).is_none(), "前提：一开始没有");
        let stamp = c.begin(1, 0, p);
        assert!(c.commit(1, 0, p, stamp, vec![ent("a.md")]));
        assert_eq!(names_at(&c, 1, 0, p), vec!["a.md"]);
    }

    /// 2️⃣ **R1 的主交错**：`begin(A)` → `invalidate` → `begin(B)` → `commit(B)` 成功、
    /// `commit(A)` **失败**。⛔ 这条正是"迟到的旧扫描覆盖新缓存"的判据。
    #[test]
    fn 旧票在作废后提交不进去() {
        let c = TreeCache::new();
        let p = Path::new("/tmp/b");
        let a = c.begin(1, 0, p);
        // 有人 fresh / 作废了这一层
        c.invalidate(1, 0, p);
        let b = c.begin(1, 0, p);
        assert!(c.commit(1, 0, p, b, vec![ent("新.md")]), "后发的票必须能写");
        assert!(!c.commit(1, 0, p, a, vec![ent("旧.md")]), "⭐ 先发的票必须再也写不进去");
        assert_eq!(names_at(&c, 1, 0, p), vec!["新.md"], "缓存里留下的必须是新那份");
    }

    /// 3️⃣ 顺序反过来：A 先提交，B 再作废 ⇒ 条目没了；B 提交后留下的是 B 的。
    #[test]
    fn 作废在提交之后仍能清掉条目() {
        let c = TreeCache::new();
        let p = Path::new("/tmp/c");
        let a = c.begin(2, 0, p);
        assert!(c.commit(2, 0, p, a, vec![ent("A.md")]));
        assert_eq!(names_at(&c, 2, 0, p), vec!["A.md"]);

        c.invalidate(2, 0, p);
        assert!(c.hit(2, 0, p).is_none(), "作废要真的删条目");
        assert!(!c.commit(2, 0, p, a, vec![ent("A.md")]), "作废也把 A 的票作废了");

        let b = c.begin(2, 0, p);
        assert!(c.commit(2, 0, p, b, vec![ent("B.md")]));
        assert_eq!(names_at(&c, 2, 0, p), vec!["B.md"]);
    }

    /// 4️⃣ 同键两次 `begin` 且中间无作废 ⇒ **晚发者赢**（与前端 `layerSeq` 同语义）。
    #[test]
    fn 同键两次领票时晚发者赢() {
        let c = TreeCache::new();
        let p = Path::new("/tmp/d");
        let first = c.begin(3, 0, p);
        let second = c.begin(3, 0, p);
        assert!(c.commit(3, 0, p, second, vec![ent("后.md")]));
        assert!(!c.commit(3, 0, p, first, vec![ent("先.md")]));
        assert_eq!(names_at(&c, 3, 0, p), vec!["后.md"]);
    }

    /// 5️⃣ `retain_gen` 之后**旧代的票表与条目都不命中**。
    #[test]
    fn 换根清掉旧代的票与条目() {
        let c = TreeCache::new();
        let old = Path::new("/tmp/old");
        let new = Path::new("/tmp/new");
        let old_ticket = c.begin(1, 0, old);
        assert!(c.commit(1, 0, old, old_ticket, vec![ent("旧.md")]));
        let new_ticket = c.begin(2, 0, new);
        assert!(c.commit(2, 0, new, new_ticket, vec![ent("新.md")]));

        c.retain_gen(2);
        assert!(c.hit(1, 0, old).is_none(), "旧代条目要清掉");
        assert!(!c.commit(1, 0, old, old_ticket, vec![ent("旧.md")]), "旧代票表也要清掉");
        assert_eq!(names_at(&c, 2, 0, new), vec!["新.md"], "新代不受影响");
    }

    /// 5️⃣b `sweep` 之后**旧纪元的条目与票都不命中**，且只留当前这一档（`INV-DISK-09`）。
    #[test]
    fn 纪元前进清掉旧纪元的票与条目() {
        let c = TreeCache::new();
        let dir = Path::new("/tmp/d");
        let other = Path::new("/tmp/e");

        let t1 = c.begin(1, 0, dir);
        assert!(c.commit(1, 0, dir, t1, vec![ent("一.md")]));
        let t2 = c.begin(1, 1, other);
        assert!(c.commit(1, 1, other, t2, vec![ent("二.md")]));
        assert_eq!(c.len(), 2, "前提：两档都在");

        let swept = c.sweep(1, 2);
        assert_eq!(swept.len(), 2, "两档都被摘下来（⚠️ 由调用方在锁外 drop）");
        drop(swept);

        assert_eq!(c.len(), 0, "只留恰好 (代次, 纪元) 那一档 ⇒ 没提交过的纪元 2 是空的");
        assert!(c.hit(1, 0, dir).is_none());
        assert!(c.hit(1, 1, other).is_none());
        // ⚠️ 旧纪元的票也必须失效 —— 在飞扫描回来时⛔ 不许写进新纪元
        assert!(!c.commit(1, 0, dir, t1, vec![ent("迟到.md")]), "旧纪元的票要一起清掉");
        assert!(!c.commit(1, 1, other, t2, vec![ent("迟到.md")]));

        // 新纪元自己照常工作
        let t3 = c.begin(1, 2, dir);
        assert!(c.commit(1, 2, dir, t3, vec![ent("三.md")]));
        assert_eq!(names_at(&c, 1, 2, dir), vec!["三.md"]);
    }

    /// 5️⃣c `sweep` 也会顺手清掉**非当前代**（换根之后不必再单独 `retain_gen`）。
    #[test]
    fn 纪元清扫顺带清掉旧代() {
        let c = TreeCache::new();
        let p = Path::new("/tmp/p");
        let t_old = c.begin(1, 4, p);
        assert!(c.commit(1, 4, p, t_old, vec![ent("旧代.md")]));
        let t_new = c.begin(2, 0, p);
        assert!(c.commit(2, 0, p, t_new, vec![ent("新代.md")]));

        drop(c.sweep(2, 0));
        assert!(c.hit(1, 4, p).is_none(), "旧代（哪怕纪元对不上）一律清");
        assert_eq!(names_at(&c, 2, 0, p), vec!["新代.md"]);
    }


    /// ⭐ A5 末条：`sweep` 搬走的是**值**（整块 `Vec` 搬移），⛔ **不是**逐条 `clone`。
    ///
    /// ⚠️ 这条为什么值得一个判据：它是 `INV-DISK-13` 的**性能承诺**——10 万条那一层
    /// 若在锁内被逐条拷贝，临界区里就会多出一次"复制 10 万个 `String`"，
    /// 而**行为上完全看不出来**（结果一样、只有 RT 变差）。指针相等是这里唯一能测的判据。
    #[test]
    fn 纪元清扫搬走的是值_不拷贝内容() {
        let c = TreeCache::new();
        let dir = Path::new("/tmp/d");
        let t = c.begin(1, 0, dir);
        assert!(c.commit(1, 0, dir, t, vec![ent("一.md"), ent("二.md")]));

        // ⚠️ 取的是**那块 Vec 的堆缓冲**地址（guard 已经 drop，缓冲仍归 map 所有）
        let before = c.lock().entries.get(&(1u64, 0u64, dir.to_path_buf())).unwrap().as_ptr();

        let swept = c.sweep(1, 1);
        assert_eq!(swept.len(), 1);
        assert_eq!(c.len(), 0, "旧纪元那一档已经被摘走");
        let after = swept.layers[0].as_ptr();
        assert_eq!(before, after, "sweep 必须搬移整块 Vec（⛔ 逐条 clone 会换缓冲）");
        assert_eq!(swept.layers[0].len(), 2);
    }

    #[test]
    fn 代次与纪元都一致的票才允许提交() {
        assert!(should_commit(7, 1, 7, 1, true));
        // ⭐ 代次变了（换根）：⛔ 不写缓存、不结果回前端
        assert!(!should_commit(8, 1, 7, 1, true));
        // ⭐⭐ 纪元变了（同一代内盘上内容变了）：同样⛔ 不许提交 —— `0050` 之前这里是绿的
        assert!(!should_commit(7, 2, 7, 1, true), "内容修订失效 ≠ 换根，但一样不许提交");
        // 票失效：⛔ 不写缓存
        assert!(!should_commit(7, 1, 7, 1, false));
        assert!(!should_commit(8, 1, 7, 1, false));
        assert!(!should_commit(7, 2, 7, 1, false));
    }

    // ── 递归索引与模糊匹配（`design/0009` §7 的单测清单）──────────────

    /// 命中里有没有这个名字。
    fn has(out: &SearchOutcome, name: &str) -> bool {
        out.hits.iter().any(|h| h.name == name)
    }

    /// 按名字取那一条命中（取不到就 panic，⚠️ 报的是全部命中名，便于定位）。
    fn hit_of<'a>(out: &'a SearchOutcome, name: &str) -> &'a SearchHit {
        out.hits
            .iter()
            .find(|h| h.name == name)
            .unwrap_or_else(|| panic!("没命中 {name}；实得 {:?}", names_of(out)))
    }

    fn names_of(out: &SearchOutcome) -> Vec<&str> {
        out.hits.iter().map(|h| h.name.as_str()).collect()
    }

    /// ⭐ `INV-SEARCH-02`：**过滤与树同一份判定**——三档里被挡掉的，搜索也搜不到。
    #[test]
    fn 索引与树用同一份过滤_隐藏与忽略与非md都搜不到() {
        let t = TestDir::new("idx-filter");
        let root = t.dir("root");
        t.file("root/要的.md");
        t.file("root/.hidden.md");
        t.dir("root/.git");
        t.file("root/.git/里面的.md");
        t.dir("root/node_modules");
        t.file("root/node_modules/foo.md");
        t.file("root/img0001.png");

        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();

        // 只有那一份 `.md` 进了索引
        assert_eq!(idx.entries.len(), 1);
        assert_eq!(idx.entries[0].name, "要的.md");
        assert_eq!(idx.entries[0].rel, "要的.md");
        assert_eq!(idx.roots.len(), 1);
        // ① / ② / 其它 各自的计数（§7 的日志判据）
        assert_eq!(idx.stats.skipped_dot, 2, ".hidden.md 与 .git（`.git` 那一层不进入）");
        assert_eq!(idx.stats.ignored, 1, "node_modules 只算一次（不进子项）");
        assert_eq!(idx.stats.skipped_other, 1, "png");
        assert_eq!(idx.stats.dirs, 1, "只 read_dir 了 root 一层：忽略目录与点开头都不进入");

        // ⛔ 一个都不许搜得出来（这是"看起来能用、实则语义错"的那一类）
        assert!(!has(&search(&idx, "hidden"), ".hidden.md"));
        assert!(!has(&search(&idx, "里面的"), "里面的.md"));
        assert!(!has(&search(&idx, "foo"), "foo.md"));
        assert!(!has(&search(&idx, "img"), "img0001.png"));
    }

    /// ⭐ `INV-SEARCH-03` 的反例那一半：`İ` 折叠后**仍是 `İ`**（逐字符 1:1）
    /// ⇒ 它**不命中**，⛔ 不是"命中但高亮错位"。
    #[test]
    fn 折叠是逐字符_1对1_i_不算_i() {
        let t = TestDir::new("idx-fold");
        let root = t.dir("root");
        t.file("root/İstanbul.md"); // `İ` 是单字符（U+0130）
        t.file("root/istanbul.md");

        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();
        let out = search(&idx, "istanbul");

        // ⚠️ 若用 `to_lowercase()` 折叠，`İ` 会变成 `i` + 组合点（**两个**字符），
        //    于是它**命中**、而区间落在原串的两个字节中间——那才是错的。
        assert_eq!(names_of(&out), vec!["istanbul.md"], "İ 不许被折成 i");
    }

    /// 中文名的命中区间**逐字节**正确（§7 步骤 7 的机器那半）。
    #[test]
    fn 中文命中区间是原串上的字节区间() {
        let t = TestDir::new("idx-cjk");
        let root = t.dir("root");
        t.file("root/会议纪要.md");

        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();
        let out = search(&idx, "纪要");
        let h = hit_of(&out, "会议纪要.md");

        // 「会」「议」各 3 字节 ⇒ 「纪」从第 6 字节起，到第 12 字节结束（右开）
        assert_eq!(h.match_spans, vec![6, 12]);
        assert_eq!(&h.name[6..12], "纪要", "区间必须切出正好那两个字");
    }

    /// 粗排三级：① 子串 → ② 子序列；同段按名字**字符数**；再同按**自然序**。
    #[test]
    fn 粗排_子串优先_再按名字长度_最后自然序() {
        let t = TestDir::new("idx-rank");
        let root = t.dir("root");
        t.file("root/p-l-a-i-n.md"); // 子序列
        t.file("root/x-plain.md"); // 子串，9 字符
        t.file("root/plain.md"); // 子串，8 字符
        t.file("root/a10x.md"); // 与下一项同段同长度 ⇒ 只能靠自然序分
        t.file("root/a2x.md");

        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();
        let out = search(&idx, "plain");
        // ⭐ 子串命中（"plain.md" / "x-plain.md"）整段排在子序列命中之前，
        //    段内按字符数升序 ⇒ "plain.md"(8) 在 "x-plain.md"(9) 之前
        assert_eq!(names_of(&out), vec!["plain.md", "x-plain.md", "p-l-a-i-n.md"]);

        let out2 = search(&idx, "x");
        // ⚠️ `a2x.md` 在 `a10x.md` 之前是**自然序**（`kb/0008` 的实测）——
        //    按 UTF-8 字节比会反过来（"1" < "2"）。这一格抓的就是那个静默的错。
        assert_eq!(names_of(&out2), vec!["a2x.md", "a10x.md", "x-plain.md"]);
    }

    /// §7 步骤 1 的形状：`xlpla` 靠**子序列**命中 `XL-plain.md`。
    #[test]
    fn 子序列命中是大小写折叠的() {
        let t = TestDir::new("idx-subseq");
        let root = t.dir("root");
        t.file("root/XL-plain.md");
        t.file("root/别的.md");

        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();
        let out = search(&idx, "xlpla");
        assert_eq!(names_of(&out), vec!["XL-plain.md"]);
        let h = hit_of(&out, "XL-plain.md");
        // `x l` 连在一起（0..2），`p l a` 连在一起（3..6）⇒ 两段
        assert_eq!(h.match_spans, vec![0, 2, 3, 6]);
        assert_eq!(out.total_hits, 1);
        assert!(!out.truncated);
    }

    /// 空模式什么都不显示（§4：⛔ 不是"最近文件"）。
    #[test]
    fn 空模式与纯空白不命中任何东西() {
        let t = TestDir::new("idx-empty");
        let root = t.dir("root");
        t.file("root/a.md");
        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();
        assert_eq!(search(&idx, "").total_hits, 0);
        assert_eq!(search(&idx, "   ").total_hits, 0);
    }

    /// 上限 200 + `truncated`（`design/0009` §2.1 ③）。
    #[test]
    fn 命中上限是200_且带_truncated() {
        let t = TestDir::new("idx-limit");
        let root = t.dir("root");
        for i in 0..(MATCH_LIMIT + 50) {
            t.file(&format!("root/日{i:04}.md"));
        }
        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();
        let out = search(&idx, "日");
        assert_eq!(out.total_hits, MATCH_LIMIT + 50, "total_hits 是**截断前**的真值");
        assert_eq!(out.hits.len(), MATCH_LIMIT);
        assert!(out.truncated);
    }

    /// ⭐ `INV-SEARCH-06`：**内容新鲜度与代次解耦**——
    /// 同一代次下新建的文件，旧索引搜不到、强制重建后搜得到。
    #[test]
    fn 内容新鲜度与代次解耦_重建才看得见新文件() {
        let t = TestDir::new("idx-fresh");
        let root = t.dir("root");
        t.file("root/旧方案.md");
        let g = grants_for(&root);
        let generation = g.root_generation();

        let old = build_index(&g, &ign(), 0).unwrap();
        assert!(old.is_fresh(generation, 0, g.roots()), "刚建的就是新鲜的");

        // 别的进程新建一份（代次**不会**变）
        t.file("root/新方案.md");
        assert_eq!(g.root_generation(), generation, "新建文件不该动代次");
        assert!(
            old.is_fresh(generation, 0, g.roots()),
            "⚠️ 代次没变 ⇒ 索引仍然'新鲜'——这正是那条要写的断言"
        );
        // ⭐ `design/0050`：这一句是上面那条的**解药**，也是它现在的边界——
        //    同一个根、同一个代次，**只有纪元能让它失效**。而纪元只能由
        //    "收到了监视信号"来推进（`DiskState::request`）⇒ 本函数看不见盘。
        //    所以这句不是"多余的第二道闸"，而是"唯一能失效的那一道"。
        assert!(
            !old.is_fresh(generation, 1, g.roots()),
            "纪元一变 ⇒ 旧索引立刻不新鲜（INV-DISK-09）"
        );

        // ⛔ 缓存里的那份搜不到（用户会以为"这个文件不存在"）
        assert!(!has(&search(&old, "新方案"), "新方案.md"));
        // ✅ 重建之后搜得到（浮层打开 / Cmd+R 走的就是这一步）
        let new = build_index(&g, &ign(), 1).unwrap();
        assert!(has(&search(&new, "新方案"), "新方案.md"));
        // ⚠️ 改名那半（§7 步骤 6c）：旧名字**不再**命中
        fs::remove_file(root.join("新方案.md")).unwrap();
        t.file("root/旧方案2.md");
        let renamed = build_index(&g, &ign(), 2).unwrap();
        assert!(!has(&search(&renamed, "新方案"), "新方案.md"));
    }

    /// 代次、纪元与 root 集合：`is_fresh` 的三条判据都要真的判。
    #[test]
    fn 索引新鲜度同时看代次纪元与_root_集合() {
        let t = TestDir::new("idx-gen");
        let a = t.dir("a");
        let b = t.dir("b");
        t.file("a/x.md");
        t.file("b/x.md");
        let mut g = grants_for(&a);
        let idx = build_index(&g, &ign(), 3).unwrap();

        assert!(idx.is_fresh(g.root_generation(), 3, g.roots()));
        assert!(!idx.is_fresh(g.root_generation() + 1, 3, g.roots()), "代次变了必须不新鲜");
        assert!(!idx.is_fresh(g.root_generation(), 4, g.roots()), "纪元变了必须不新鲜");
        // ⚠️ 切根：代次也变了，这里两项同时变——下面单独把"集合不同但代次相同"那半钉住
        g.authorize_root(&b).unwrap();
        assert!(!idx.is_fresh(g.root_generation(), 3, g.roots()));
        // 造一个"代次相同、root 集合不同"的输入：这正是只比代次会漏掉的那种
        assert!(!idx.is_fresh(idx.roots_gen, 3, &[b.clone()]), "集合不同必须不新鲜");
        assert!(idx.is_fresh(idx.roots_gen, 3, &[a.clone()]), "同一代 + 同一纪元 + 同一集合 = 新鲜");
    }

    /// ⭐ `INV-SEARCH-05` + 终止性：循环软链既**不进入**，遍历也就不会挂死。
    #[test]
    fn 不跟随软链_循环软链不会挂死() {
        let t = TestDir::new("idx-symlink");
        let root = t.dir("root");
        let sub = t.dir("root/sub");
        t.file("root/sub/里面.md");
        t.file("root/顶.md");
        // root/sub/loop → root（指回祖先：真跟进去就是无限递归）
        std::os::unix::fs::symlink(&root, sub.join("loop")).unwrap();
        // root/外面.md → root 之外的那份文件（软链**文件**同样不产生）
        let outside = t.file("outside/秘密.md");
        std::os::unix::fs::symlink(&outside, root.join("外面.md")).unwrap();

        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();
        let mut names: Vec<&str> = idx.entries.iter().map(|e| e.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["里面.md", "顶.md"], "软链两边都不该多出来东西");
        assert_eq!(idx.stats.skipped_symlink, 2, "循环软链与外指软链都不产生");
        assert!(outside.exists(), "构造本身要成立");
        assert!(!idx.entries.iter().any(|e| e.name == "秘密.md"));
    }

    /// ⭐ `INV-SEARCH-01`（评审 R2）：**每一层**都过校验入口——
    /// 一个被拒的子树整个跳过（⛔ 不 panic、⛔ 不列出它的内容）。
    #[test]
    fn 未授权与逃出_root_的子树被跳过() {
        let t = TestDir::new("idx-denied");
        let root = t.dir("root");
        t.dir("root/ok");
        t.file("root/ok/看得见.md");
        let outside = t.dir("outside");
        t.file("outside/秘密.md");
        // 把 root/偷看 换成指向 root 外的软链
        std::os::unix::fs::symlink(&outside, root.join("偷看")).unwrap();

        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();
        assert!(has(&search(&idx, "看得见"), "看得见.md"));
        assert!(!has(&search(&idx, "秘密"), "秘密.md"), "⛔ 软链逃脱不许被列出来");
        // 它走的是"软链不产生"那一档（父层就看出来了），而不是 read_dir 才发现
        assert_eq!(idx.stats.skipped_symlink, 1);

        // ⭐ 再直接对 walk 喂一个**在 root 之外**的目录：走的是 `is_inside_roots` 那一刀。
        //    ⚠️ 这一条防的是一条 TOCTOU——父层 `file_type()` 说是普通目录，
        //    到我们 `read_dir` 之前被换成了指向 root 外的软链（`design/0009` §2.1 ①）。
        let mut idx2 = FileIndex {
            roots_gen: g.root_generation(),
            disk_epoch: 0,
            built_at: Instant::now(),
            rev: 0,
            roots: vec![root.display().to_string()],
            entries: Vec::new(),
            stats: IndexStats::default(),
            complete: true,
            incomplete: Vec::new(),
            ignored_dirs: Vec::new(),
        };
        walk(&g, &outside, &root, &root.display().to_string(), 0, &ign(), &mut idx2);
        assert!(idx2.entries.is_empty(), "⛔ root 之外的目录一个条目都不许进来");
        assert_eq!(idx2.stats.skipped_denied, 1);
        assert_eq!(idx2.stats.dirs, 0, "连 read_dir 都不该做");
    }

    /// 空授权 ⇒ 索引为空（⛔ 不是"顺手扫一遍磁盘"）；根读不出来 ⇒ **整条失败**。
    #[test]
    fn 空授权得到空索引_根读不出来整条失败() {
        let t = TestDir::new("idx-root");
        let root = t.dir("root");
        t.file("root/a.md");

        let empty = SessionGrants::new();
        let idx = build_index(&empty, &ign(), 0).unwrap();
        assert!(idx.entries.is_empty() && idx.roots.is_empty());
        assert_eq!(idx.roots_gen, 0);

        // 根被删掉（授权还在）：canonicalize 失败 ⇒ NotFound，⛔ 不是"0 条命中"
        let g = grants_for(&root);
        assert!(build_index(&g, &ign(), 0).is_ok(), "构造本身要成立：先能建出来");
        fs::remove_dir_all(&root).unwrap();
        match build_index(&g, &ign(), 0) {
            Err(Denied::NotFound { .. }) => {}
            other => panic!("根读不出来应当是 NotFound，实得 {other:?}"),
        }
    }

    /// ⭐ 评审 R4：**一个子目录读不出来不影响整份索引**，跳过并计入 `stats`。
    #[test]
    fn 部分目录失败不影响整份索引() {
        use std::os::unix::fs::PermissionsExt;

        let t = TestDir::new("idx-partial");
        let root = t.dir("root");
        t.dir("root/公开");
        t.file("root/公开/看得见.md");
        let shut = t.dir("root/锁着");
        t.file("root/锁着/看不见.md");
        let body = t.file("root/正文.md");

        let g = grants_for(&root);
        fs::set_permissions(&shut, fs::Permissions::from_mode(0o000)).unwrap();
        let idx = build_index(&g, &ign(), 0).unwrap();
        // ⚠️ 别把自己锁死：先恢复权限再断言（否则 TestDir::drop 清不掉）
        fs::set_permissions(&shut, fs::Permissions::from_mode(0o755)).unwrap();

        assert!(idx.entries.iter().any(|e| e.name == "看得见.md"), "其它目录照常");
        assert!(idx.entries.iter().any(|e| e.name == "正文.md"));
        assert!(!idx.entries.iter().any(|e| e.name == "看不见.md"));
        assert_eq!(idx.stats.skipped_denied, 1, "跳过的那一棵记在 stats 里");
        assert!(body.exists());
    }

    /// 索引条目的三条路径各就各位（`rel` 是相对 root 的）。
    #[test]
    fn 索引条目带_root_与相对路径() {
        let t = TestDir::new("idx-entry");
        let root = t.dir("root");
        t.dir("root/a/b");
        t.file("root/a/b/deep.md");

        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();
        assert_eq!(idx.entries.len(), 1);
        let e = &idx.entries[0];
        assert_eq!(e.name, "deep.md");
        assert_eq!(e.rel, "a/b/deep.md");
        assert_eq!(e.root, fs::canonicalize(&root).unwrap().display().to_string());
        assert_eq!(e.real_path, fs::canonicalize(root.join("a/b/deep.md")).unwrap().display().to_string());
        // ⭐ `real_path` 直接喂给 `open_document` 是**能用**的（它还会再过一次校验）
        assert!(e.real_path.starts_with(&e.root));
    }


    /// ⭐ `design/0041` §7 步骤 0 第二项：**产品** `build_index` 在真实工作区上的
    /// 耗时与载荷字节（⛔ 不是日常闸门，默认 `#[ignore]`）。
    ///
    /// ⚠️ **不启动窗口、不抢焦点、不合成按键**——它只是一个只读的 `cargo test --ignored`。
    /// ⛔ 只读目标目录（不建、不删、不写）。
    ///
    /// ⚠️ `scan_ms` 是**函数内**统计（含每层 `check_readable`）；`wall_ms` 还包含
    /// 夹具构造与序列化。⛔ 两者**都不等于** `⌘P` 的端到端耗时（不含 IPC / 渲染）——
    /// 那一半在 `make probe-doclist`。
    ///
    /// 跑法：
    /// ```text
    /// make probe-index                 # 默认扫仓库上一级（kumustone 工作区）
    /// make probe-index DIR=/some/dir   # 换目标
    /// ```
    #[test]
    #[ignore = "步骤 0 取证：只读扫描 RMD_INDEX_PROBE_DIR，不在日常闸门里"]
    fn 索引探针_产品构建耗时与载荷字节() {
        const ROUNDS: usize = 3;
        let dir = std::env::var("RMD_INDEX_PROBE_DIR")
            .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string());
        let root = fs::canonicalize(&dir).expect("探测目录必须存在");
        let g = grants_for(&root);

        println!("夹具：{}", root.display());
        for round in 0..ROUNDS {
            let t0 = Instant::now();
            let idx = build_index(&g, &ign(), 0).unwrap();
            let wall = t0.elapsed().as_secs_f64() * 1000.0;
            let r = DocListResult::from_index(&idx, 1);
            let bytes = serde_json::to_vec(&r).unwrap().len();
            println!(
                "round {round}: scan_ms={:.2}（函数内）/ {wall:.2}（墙钟）｜目录 {}｜扫过 {} 项｜md {}｜complete {}｜未完成 {}｜忽略目录 {}｜keep_dirs {}｜载荷 {} 字节（{:.2} MiB，上限 {:.0} MiB）",
                idx.stats.scan_ms,
                idx.stats.dirs,
                idx.stats.scanned,
                r.total,
                r.complete,
                r.incomplete.len(),
                idx.ignored_dirs.len(),
                r.keep_dirs.len(),
                bytes,
                bytes as f64 / (1024.0 * 1024.0),
                MAX_DOCLIST_JSON_BYTES as f64 / (1024.0 * 1024.0)
            );
        }
    }

    /// ⭐ `design/0034` §7.0 步骤 0 的取证（⛔ 不是日常闸门，默认 `#[ignore]`）。
    ///
    /// 量的是**冷路径**：`tree::list_dir` 本身不碰 `TreeCache`（缓存在
    /// `commands/fs.rs`），所以直接调它 ≡ `list_dir(fresh = true)`。
    ///
    /// 跑法：
    /// ```text
    /// cd src-tauri && cargo test --release --offline -- --ignored --nocapture 步骤0
    /// ```
    /// ⚠️ 每跑一次现造 1 万个文件（约 1 s），判据是设计里那条
    /// **p50 < 50 ms、p95 < 100 ms**，⛔ 不挑最好的一轮。
    #[test]
    #[ignore = "步骤 0 取证：现造 1 万个文件，耗时长，不在日常闸门里"]
    fn 步骤0_一万条目的重列耗时() {
        const N: usize = 10_000;
        const ROUNDS: usize = 3;
        const PER_ROUND: usize = 20;

        let t = TestDir::new("step0-flat");
        let root = t.dir("root");
        let t_make = Instant::now();
        for i in 0..N {
            fs::write(root.join(format!("f{i:05}.md")), b"# x\n").unwrap();
        }
        println!("fixture: {N} 个 .md 一层，造好耗时 {} ms", t_make.elapsed().as_millis());

        let g = grants_for(&root);
        let generation = g.root_generation();
        let mut rounds: Vec<(u64, u64)> = Vec::new();
        for round in 0..ROUNDS {
            let mut us: Vec<u64> = Vec::with_capacity(PER_ROUND);
            for i in 0..PER_ROUND as u64 {
                let t0 = Instant::now();
                let r = list_dir(&g, &root, generation, 0, (round as u64) * 1000 + i + 1, &ign()).unwrap();
                us.push(t0.elapsed().as_micros() as u64);
                assert_eq!(r.entries.len(), N, "过滤后应当正好 {N} 条");
            }
            us.sort_unstable();
            // 20 个样本的 p50 = 第 10 个；p95 最近秩 = 第 19 个
            let p50 = us[9];
            let p95 = us[18];
            println!(
                "round {round}: p50={p50}us p95={p95}us max={}us",
                us[PER_ROUND - 1]
            );
            rounds.push((p50, p95));
        }
        for (i, (p50, p95)) in rounds.iter().enumerate() {
            assert!(*p50 < 50_000, "第 {i} 轮 p50 {p50} us 超 50 ms");
            assert!(*p95 < 100_000, "第 {i} 轮 p95 {p95} us 超 100 ms");
        }
    }

    /// ⭐ `design/0039` §7 步骤 2：**树侧基准**（⛔ 不是日常闸门，默认 `#[ignore]`）。
    ///
    /// 量四件设计点名的东西：扫描/过滤耗时、自然排序耗时（含在里面）、条目数、
    /// 以及 **JSON 序列化后的字节数**（§1 里"序列化在锁外"那条讨论的输入）。
    ///
    /// 跑法（两种）：
    /// ```text
    /// # ① 现造夹具（默认 1 000 个 .md，一层）
    /// cd src-tauri && cargo test --release --offline -- --ignored --nocapture 树侧基准
    /// # ② 指定已有目录（⛔ 只读它，不建不删）
    /// RMD_TREE_BENCH_DIR=/path/to/dir cargo test --release -- --ignored --nocapture 树侧基准
    /// ```
    /// 条数用 `RMD_TREE_BENCH_N` 调（`100` / `1000` / `10000` / `100000`）。
    ///
    /// ⚠️ **不做断言**：这是一份测量，不是闸门。判据在 `benchmarks/results/` 的历史文件里。
    #[test]
    #[ignore = "树侧基准：现造夹具或读 RMD_TREE_BENCH_DIR，耗时长，不在日常闸门里"]
    fn 树侧基准_条目数与序列化字节() {
        const SAMPLES: usize = 7;

        let explicit = std::env::var("RMD_TREE_BENCH_DIR").ok();
        let n: usize = std::env::var("RMD_TREE_BENCH_N")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1_000);

        // ⚠️ 现造的那份由 `TestDir` 在 drop 时删掉；指定目录**一律不动**。
        let scratch;
        let (root, made_ms) = match &explicit {
            Some(d) => (PathBuf::from(d), None),
            None => {
                scratch = TestDir::new(&format!("bench-{n}"));
                let root = scratch.dir("root");
                let t0 = Instant::now();
                for i in 0..n {
                    fs::write(root.join(format!("f{i:06}.md")), b"# x\n").unwrap();
                }
                (root, Some(t0.elapsed().as_millis()))
            }
        };

        let g = grants_for(&root);
        let generation = g.root_generation();
        let mut us: Vec<u64> = Vec::with_capacity(SAMPLES);
        let mut last = None;
        for i in 0..SAMPLES as u64 {
            let t0 = Instant::now();
            let r = list_dir(&g, &root, generation, 0, i + 1, &ign()).unwrap();
            us.push(t0.elapsed().as_micros() as u64);
            last = Some(r);
        }
        let r = last.unwrap();
        let json_bytes = serde_json::to_string(&r).unwrap().len();
        us.sort_unstable();
        println!(
            "bench dir={} made_ms={} entries={} json_bytes={} p50_us={} p95_us={} max_us={}",
            root.display(),
            made_ms.map(|v| v.to_string()).unwrap_or_else(|| "—".into()),
            r.entries.len(),
            json_bytes,
            us[SAMPLES / 2],
            us[SAMPLES * 95 / 100],
            us[SAMPLES - 1],
        );
    }

    /// ⭐ 文件名搜索的**索引规模基准**（⛔ 不是日常闸门，默认 `#[ignore]`）。
    ///
    /// 量的是 `⌘P` 与侧边栏搜索共用的那一段：**已建好的索引上的查询耗时**
    /// （`search()` 的扫描 + 粗排 + 自然序 + 截断），以及建这份索引要多久。
    ///
    /// 跑法：
    /// ```text
    /// cd src-tauri && cargo test --release --offline -- --ignored --nocapture 搜索基准
    /// RMD_SEARCH_BENCH_N=10000 cargo test --release --offline -- --ignored --nocapture 搜索基准
    /// RMD_SEARCH_BENCH_DIR=/some/dir cargo test --release -- --ignored --nocapture 搜索基准
    /// ```
    ///
    /// ⚠️ 默认夹具是**现造的临时目录**（跑完即删）；`RMD_SEARCH_BENCH_DIR` 指定的目录
    /// **一律只读**（⛔ 不建、不删、不写）。
    /// ⚠️ `p50`/`p95` 单位是 **微秒**，21 轮取样；`hits` 是截断后条数（上限 `MATCH_LIMIT`），
    /// `total_hits` 是**截断前**的真值。
    /// ⛔ 这不是端到端耗时：**不含 IPC 序列化与前端渲染**（那一半见 `make probe-doclist`）。
    /// ⚠️ **不做断言**：这是一份测量，不是闸门；数字落 `benchmarks/results/`。
    #[test]
    #[ignore = "搜索基准：现造夹具并建索引，耗时长，不在日常闸门里"]
    fn 搜索基准_索引条目与查询耗时() {
        const ROUNDS: usize = 21;
        const PER_DIR: usize = 500;
        // 名字混中文与 ASCII、带序号——贴近真实文档名，且保证"高命中"与"零命中"都能量到。
        const PREFIXES: [&str; 6] =
            ["设计文档", "readme", "api-bizagg-go", "会议纪要", "release-notes", "ADR"];
        let n: usize = std::env::var("RMD_SEARCH_BENCH_N")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(100_000);
        let explicit = std::env::var("RMD_SEARCH_BENCH_DIR").ok().filter(|s| !s.is_empty());

        // ⚠️ 现造的那份由 `TestDir` 在 drop 时删掉；指定目录**一律不动**。
        let scratch;
        let (root, made_ms) = match &explicit {
            Some(d) => (fs::canonicalize(d).expect("探测目录必须存在"), None),
            None => {
                scratch = TestDir::new(&format!("search-bench-{n}"));
                let root = scratch.dir("root");
                let t_make = Instant::now();
                for i in 0..n {
                    if i % PER_DIR == 0 {
                        fs::create_dir_all(root.join(format!("g{:03}", i / PER_DIR))).unwrap();
                    }
                    let d = root.join(format!("g{:03}", i / PER_DIR));
                    let p = PREFIXES[i % PREFIXES.len()];
                    fs::write(d.join(format!("{p}-{i:06}.md")), b"# x\n").unwrap();
                }
                (root, Some(t_make.elapsed().as_millis()))
            }
        };

        let g = grants_for(&root);
        let t0 = Instant::now();
        let idx = build_index(&g, &ign(), 0).unwrap();
        let index_ms = t0.elapsed().as_secs_f64() * 1000.0;
        println!(
            "search-bench: dir={} n={n} entries={} dirs={} scanned={} made_ms={} index_ms={index_ms:.2}",
            root.display(),
            idx.entries.len(),
            idx.stats.dirs,
            idx.stats.scanned,
            made_ms.map(|v| v.to_string()).unwrap_or_else(|| "—".into()),
        );

        // 四个口径：高命中（要排序+截断）/ 中文子序列 / ASCII 子串 / 零命中（仍要扫全量）
        for pat in ["0", "设计", "readme", "zzzzzz"] {
            let mut us: Vec<u64> = Vec::with_capacity(ROUNDS);
            let mut hits = 0usize;
            let mut total = 0usize;
            let mut truncated = false;
            for _ in 0..ROUNDS {
                let t0 = Instant::now();
                let out = search(&idx, pat);
                us.push(t0.elapsed().as_micros() as u64);
                hits = out.hits.len();
                total = out.total_hits;
                truncated = out.truncated;
            }
            us.sort_unstable();
            println!(
                "search-bench: pattern={pat:?} p50_us={} p95_us={} max_us={} hits={hits} total_hits={total} truncated={truncated}",
                us[ROUNDS / 2],
                us[ROUNDS * 95 / 100],
                us[ROUNDS - 1],
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ⭐ `design/0040`：过滤清单来自配置，⛔ 不再读常量
    // ─────────────────────────────────────────────────────────────────────

    /// 谓词吃的是**传进来的**那份清单：同一名字在不同清单下可以是两个档。
    #[test]
    fn 谓词使用传入的清单() {
        let custom = vec!["vendor".to_string()];
        assert_eq!(classify("vendor", true, &custom), Class::Ignored);
        assert_eq!(classify("target", true, &custom), Class::Normal, "不在自定义清单里就必须正常");
        // ⛔ 同名**文件**永不受影响（清单只管目录，`INV-FILTER-02`）：
        //    `vendor.md` 照常列；无后缀的 `vendor` 文件落 `Other`（非 md 不列），
        //    ⚠️ 但它**绝不是 `Ignored`**——两者在树里结果相同、含义不同。
        assert_eq!(classify("vendor.md", false, &custom), Class::Normal);
        assert_eq!(classify("vendor", false, &custom), Class::Other);
        // ⛔ 空清单 ≠ 放开 ① 类
        assert_eq!(classify(".git", true, &[]), Class::Hidden);
        // 逐字、大小写敏感（`INV-FILTER-02`）
        assert_eq!(classify("Vendor", true, &custom), Class::Normal);
    }

    /// 端到端：自定义清单下 `vendor` 灰显、`node_modules` 变回可展开的普通目录。
    #[test]
    fn 自定义清单改变灰显项() {
        let t = TestDir::new("custom-ignore");
        let root = t.dir("root");
        t.dir("root/vendor");
        t.dir("root/node_modules");
        t.file("root/a.md");

        let g = grants_for(&root);
        let custom = vec!["vendor".to_string()];
        let r = list_dir(&g, &root, g.root_generation(), 0, 1, &custom).unwrap();

        let ignored: Vec<&str> =
            r.entries.iter().filter(|e| e.ignored).map(|e| e.name.as_str()).collect();
        assert_eq!(ignored, vec!["vendor"]);
        assert_eq!(r.stats.ignored, 1, "只有 vendor 算 ② 类");
        assert!(r.entries.iter().any(|e| e.name == "node_modules" && !e.ignored),
            "替换默认清单后 node_modules 必须回到正常档：{:?}",
            r.entries.iter().map(|e| (&e.name, e.ignored)).collect::<Vec<_>>());
    }

    /// 空清单 ⇒ 一个都不忽略（仍不列点开头）。
    #[test]
    fn 空清单不忽略任何目录() {
        let t = TestDir::new("empty-ignore");
        let root = t.dir("root");
        t.dir("root/node_modules");
        t.dir("root/.git");
        t.file("root/a.md");

        let g = grants_for(&root);
        let r = list_dir(&g, &root, g.root_generation(), 0, 1, &[]).unwrap();
        assert_eq!(r.stats.ignored, 0);
        assert_eq!(r.stats.skipped_dot, 1, "① 类与清单无关，永远隐藏");
        assert!(r.entries.iter().all(|e| !e.ignored));
    }

    /// 索引与树共用同一份清单（`INV-SEARCH-02` / `INV-FILTER-01`）：
    /// 自定义清单下 `node_modules` **里的 `.md` 会被索引到**，而 `vendor` 里的不会。
    #[test]
    fn 索引跟随同一份清单() {
        let t = TestDir::new("custom-ignore-index");
        let root = t.dir("root");
        t.file("root/vendor/in-vendor.md");
        t.file("root/node_modules/in-nm.md");
        t.file("root/top.md");

        let g = grants_for(&root);
        let custom = vec!["vendor".to_string()];
        let idx = build_index(&g, &custom, 0).unwrap();
        let names: Vec<&str> = idx.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"in-nm.md"), "不在清单里的目录必须被索引：{names:?}");
        assert!(!names.contains(&"in-vendor.md"), "清单里的目录⛔ 不许被索引：{names:?}");
        assert!(names.contains(&"top.md"));
    }

    // ── `design/0041`：完整性协议、过滤判据与列表排序 ──────────────────────

    /// 造一份**合成索引**（不碰磁盘）：只给相对路径，root 固定。
    ///
    /// ⚠️ 用它测的是 `keep_dirs` / `sort_docs` / 截断这些**纯派生**逻辑；
    /// 需要真实"读不出来"的用例仍走 `build_index`（见下面那两条）。
    fn synth(
        root: &str,
        rels: &[&str],
        incomplete: &[&str],
        ignored: &[&str],
    ) -> FileIndex {
        let entries = rels
            .iter()
            .map(|rel| IndexEntry {
                root: root.to_string(),
                real_path: format!("{root}/{rel}"),
                rel: rel.to_string(),
                name: Path::new(rel)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            })
            .collect();
        FileIndex {
            roots_gen: 1,
            disk_epoch: 0,
            built_at: Instant::now(),
            rev: 7,
            roots: vec![root.to_string()],
            entries,
            stats: IndexStats::default(),
            complete: incomplete.is_empty(),
            incomplete: incomplete
                .iter()
                .map(|p| IncompleteNode {
                    path: p.to_string(),
                    reason: "denied".to_string(),
                })
                .collect(),
            ignored_dirs: ignored.iter().map(|p| p.to_string()).collect(),
        }
    }

    /// ⭐ R1 的主判据：**读不出来的目录 = 未知，⛔ 不是空**。
    ///
    /// 这条用例直接跑 `build_index`（真 `chmod 000`），因为要证的正是
    /// "`walk` 跳过子树却仍返回 `Ok`"——合成索引证明不了这一点。
    #[test]
    fn 读不出来的目录记为_denied_且保持可达() {
        use std::os::unix::fs::PermissionsExt;

        let t = TestDir::new("idx-incomplete");
        let root = t.dir("root");
        t.file("root/有.md");
        let shut = t.dir("root/不可读");
        t.file("root/不可读/藏着的.md");

        let g = grants_for(&root);
        fs::set_permissions(&shut, fs::Permissions::from_mode(0o000)).unwrap();
        let idx = build_index(&g, &ign(), 0).unwrap();
        fs::set_permissions(&shut, fs::Permissions::from_mode(0o755)).unwrap();

        // 整体仍然成功（`Ok`），但**不完整**
        assert!(!idx.complete, "跳过子树必须让 complete 变 false");
        assert_eq!(idx.incomplete.len(), 1, "跳过几棵就记几条：{:?}", idx.incomplete);
        let n = &idx.incomplete[0];
        assert_eq!(Path::new(&n.path), fs::canonicalize(&shut).unwrap());
        assert_eq!(n.reason, "denied");
        assert_eq!(idx.stats.skipped_denied, 1);

        // ⭐ 关键：这个目录（以及通往它的祖先）必须留在判据集合里，
        //    ⛔ 不许被"子树无 md ⇒ 隐藏"顺手藏掉（否则用户看不到也进不去）
        let keep = idx.keep_dirs();
        assert!(keep.iter().any(|p| Path::new(p) == fs::canonicalize(&shut).unwrap()));
        assert!(keep.iter().any(|p| Path::new(p) == fs::canonicalize(&root).unwrap()));
    }

    /// 撞 `MAX_DEPTH` 的子树同样记成"未知"，理由是 `deep`（⛔ 与 `denied` 混为一谈）。
    #[test]
    fn 超深子树记为_deep_且保持可达() {
        let t = TestDir::new("idx-deep");
        let root = t.dir("root");
        // 建到 MAX_DEPTH + 2 层：`depth > MAX_DEPTH` 那一支一定会被踩到
        let mut deep = root.clone();
        for i in 0..(MAX_DEPTH + 2) {
            deep = deep.join(format!("d{i}"));
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("够不到.md"), "x").unwrap();
        t.file("root/顶.md");

        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();

        assert!(!idx.complete);
        assert_eq!(idx.incomplete.len(), 1, "{:?}", idx.incomplete);
        assert_eq!(idx.incomplete[0].reason, "deep");
        assert!(idx.entries.iter().any(|e| e.name == "顶.md"), "浅层照常收录");
        assert!(!idx.entries.iter().any(|e| e.name == "够不到.md"), "深处那棵没走过");
        // 未走完那条路径的**祖先链**要可达（否则在树上点不到）
        let keep = idx.keep_dirs();
        assert!(keep.iter().any(|p| p == &idx.incomplete[0].path));
    }

    /// ⭐ 正常空目录（走完了、确实没有 md）**不进**判据集合 ⇒ 前端会隐藏它。
    #[test]
    fn 正常空目录不进_keep_dirs() {
        let t = TestDir::new("idx-empty-dir");
        let root = t.dir("root");
        t.dir("root/空目录");
        t.dir("root/有内容");
        t.file("root/有内容/a.md");
        t.file("root/根.md");

        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();
        assert!(idx.complete, "都能读，必须完整");

        let empty = fs::canonicalize(root.join("空目录")).unwrap();
        let keep = idx.keep_dirs();
        assert!(!keep.iter().any(|p| Path::new(p) == empty), "空目录必须可隐藏：{keep:?}");
        assert!(keep.iter().any(|p| Path::new(p) == fs::canonicalize(root.join("有内容")).unwrap()));
    }

    /// ⭐ 索引只收 `.md`（`classify()` 的作用，`INV-SEARCH-02`）⇒
    /// "只有图片的目录"天然不在判据集合里，列表也不会出现 `.png`。
    /// ⚠️ 这条同时守住"⛔ 别在列表侧再写一遍后缀判据"。
    #[test]
    fn 索引只收_md_所以列表与判据都不必二次过滤() {
        let t = TestDir::new("idx-only-md");
        let root = t.dir("root");
        t.file("root/只有图/a.png");
        t.file("root/有文档/b.md");
        t.file("root/c.txt");

        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();
        assert_eq!(idx.entries.len(), 1, "非 md 在 classify 那一档就被挡掉");
        assert_eq!(idx.stats.skipped_other, 2, "png 与 txt");

        let view = doc_list_view(&idx);
        assert_eq!(view.total, 1);
        assert_eq!(view.entries[0].name, "b.md");

        let keep = idx.keep_dirs();
        assert!(keep.iter().any(|p| Path::new(p) == fs::canonicalize(root.join("有文档")).unwrap()));
        assert!(
            !keep.iter().any(|p| Path::new(p) == fs::canonicalize(root.join("只有图")).unwrap()),
            "只有非 md 文件的目录必须可隐藏：{keep:?}"
        );
    }

    /// ⭐ 过滤清单命中的目录（以及通往它的祖先）**保持可达**——它是有意排除，
    /// ⛔ 不是漏扫（R1 的"两种不完整"必须分开）。
    #[test]
    fn 忽略目录及其祖先保持可达() {
        let t = TestDir::new("idx-ignored-keep");
        let root = t.dir("root");
        t.file("root/深/node_modules/x.js");
        t.dir("root/别的");

        let g = grants_for(&root);
        let idx = build_index(&g, &ign(), 0).unwrap();
        let nm = fs::canonicalize(root.join("深/node_modules")).unwrap();
        assert!(idx.ignored_dirs.iter().any(|p| Path::new(p) == nm), "{:?}", idx.ignored_dirs);
        // 忽略不是"不完整"：它没走这棵子树，但我们**知道**那里的东西按规则不列
        assert!(idx.complete, "有意排除 ⛔ 不许让 complete 变 false");

        let keep = idx.keep_dirs();
        assert!(keep.iter().any(|p| Path::new(p) == nm), "忽略目录本身要可达");
        assert!(
            keep.iter().any(|p| Path::new(p) == fs::canonicalize(root.join("深")).unwrap()),
            "通往它的祖先也要可达：{keep:?}"
        );
    }

    /// 多级根下的 `keep_dirs`：md 的各级父目录都在里面（截到 root 为止，⛔ 不到 `/`）。
    #[test]
    fn keep_dirs_含每一级父目录且截到_root() {
        let idx = synth("/r", &["a/b/c.md"], &[], &[]);
        let keep = idx.keep_dirs();
        assert_eq!(keep, vec!["/r/a".to_string(), "/r/a/b".to_string()]);
        assert!(!keep.iter().any(|p| p == "/"), "⛔ 不许走到文件系统根");
        assert!(!keep.iter().any(|p| p == "/r"), "root 由界面自己显示，不靠这张表");
    }

    /// 未走完的路径在**多 root** 时截到**最长**的那个 root（嵌套授权的情形）。
    #[test]
    fn 未知路径按最长_root_截断() {
        let mut idx = synth("/r", &[], &["/r/inner/locked"], &[]);
        idx.roots = vec!["/r".to_string(), "/r/inner".to_string()];
        let keep = idx.keep_dirs();
        assert!(keep.contains(&"/r/inner/locked".to_string()));
        assert!(keep.contains(&"/r/inner".to_string()));

        // 路径与任何 root 都无关（不该发生）：只加它自己，⛔ 不往祖先走
        let mut idx2 = synth("/r", &[], &["/elsewhere/x"], &[]);
        idx2.roots = vec!["/r".to_string()];
        assert_eq!(idx2.keep_dirs(), vec!["/elsewhere/x".to_string()]);
    }

    // ── 排序（R6）──────────────────────────────────────────────────────

    fn rels_of(items: &[IndexEntry]) -> Vec<&str> {
        items.iter().map(|e| e.rel.as_str()).collect()
    }

    /// 根目录的条目在前，其余按**父路径分量**逐个比较，再比文件名。
    #[test]
    fn 文档列表按目录分量排序() {
        let idx = synth("/r", &["b/a.md", "a/z.md", "a/b.md", "top.md"], &[], &[]);
        let out = sort_docs(&idx.entries);
        assert_eq!(rels_of(&out), vec!["top.md", "a/b.md", "a/z.md", "b/a.md"]);
    }

    /// ⭐ 父路径**按分量**比，⛔ 不当整串比：整串比较会把 `a/b` 与 `ab` 的相对次序
    /// 交给字符折叠（`ab` 会排在 `a/b` 前），而不是目录层级。
    #[test]
    fn 父路径按分量比而非整串() {
        let idx = synth("/r", &["ab/x.md", "a/b/y.md"], &[], &[]);
        let out = sort_docs(&idx.entries);
        // 第一级分量 `a` < `ab` ⇒ `a/b/y.md` 在前
        assert_eq!(rels_of(&out), vec!["a/b/y.md", "ab/x.md"]);
    }

    /// 同一父目录内按自然序（`file2` < `file10`），且**与输入顺序无关**。
    #[test]
    fn 文件名按自然序且与输入顺序无关() {
        let a = synth("/r", &["d/file10.md", "d/file2.md"], &[], &[]);
        let b = synth("/r", &["d/file2.md", "d/file10.md"], &[], &[]);
        let out_a = sort_docs(&a.entries);
        let out_b = sort_docs(&b.entries);
        assert_eq!(rels_of(&out_a), vec!["d/file2.md", "d/file10.md"]);
        assert_eq!(rels_of(&out_a), rels_of(&out_b), "输入顺序⛔ 不许影响结果");
    }

    /// 完全同名的两条（同目录同名、`real_path` 不同——理论上不该有）也要**可复现**。
    #[test]
    fn 同名条目按_real_path_定案() {
        let mut idx = synth("/r", &["d/x.md", "d/x.md"], &[], &[]);
        idx.entries[0].real_path = "/r/d/x.md#b".to_string();
        idx.entries[1].real_path = "/r/d/x.md#a".to_string();
        let out = sort_docs(&idx.entries);
        assert_eq!(out[0].real_path, "/r/d/x.md#a");
        assert_eq!(out[1].real_path, "/r/d/x.md#b");
    }

    /// ⭐ `INV-DOCS-01` 的资源面：共用那份 `Arc` **⛔ 不许被就地改序**（R6）。
    #[test]
    fn 列表排序不改共享索引的顺序() {
        let idx = synth("/r", &["b.md", "a.md"], &[], &[]);
        let before: Vec<String> = idx.entries.iter().map(|e| e.rel.clone()).collect();
        let _ = doc_list_view(&idx);
        let after: Vec<String> = idx.entries.iter().map(|e| e.rel.clone()).collect();
        assert_eq!(before, after, "共享索引必须保持原样");
    }

    // ── 截断与载荷预算（R7）────────────────────────────────────────────

    /// ⭐ **先排序、后截断**；且 `keep_dirs` / `total` 来自**完整索引**。
    #[test]
    fn 截断只作用于_entries_而判据来自完整索引() {
        // 造 MAX_DOCS + 1 条：目录名决定谁被截掉（`z*` 排最后）
        let rels: Vec<String> = (0..=MAX_DOCS)
            .map(|i| {
                if i == MAX_DOCS {
                    format!("zzz/被截掉{i}.md")
                } else {
                    format!("aaa/f{i:05}.md")
                }
            })
            .collect();
        let refs: Vec<&str> = rels.iter().map(|s| s.as_str()).collect();
        let idx = synth("/r", &refs, &[], &[]);
        let view = doc_list_view(&idx);

        assert_eq!(view.total, MAX_DOCS + 1, "total 是截断前的真值");
        assert!(view.truncated);
        assert_eq!(view.entries.len(), MAX_DOCS);
        assert!(!view.entries.iter().any(|e| e.name.starts_with("被截掉")), "截的是尾部");
        assert!(
            view.keep_dirs.contains(&"/r/zzz".to_string()),
            "⭐ 被截掉的条目所在目录仍必须可判定（⛔ 不许跟着截）"
        );
    }

    /// 边界：正好 `MAX_DOCS` 条不算截断。
    #[test]
    fn 正好到上限不算截断() {
        let rels: Vec<String> = (0..MAX_DOCS).map(|i| format!("d/f{i:05}.md")).collect();
        let refs: Vec<&str> = rels.iter().map(|s| s.as_str()).collect();
        let view = doc_list_view(&synth("/r", &refs, &[], &[]));
        assert_eq!(view.total, MAX_DOCS);
        assert!(!view.truncated);
        assert_eq!(view.entries.len(), MAX_DOCS);
    }

    /// ⭐ R7 的另一条尺子：**整份 JSON** 的字节预算。
    ///
    /// 认的是"最深一层目录 + 长文件名"这种真实形状（`notes/0032` 的夹具里
    /// 平均 15 个文件/目录、最多 6 层）。实测字节数打进输出，⛔ 别抄这里的中文注释。
    #[test]
    fn 文档列表载荷预算() {
        let rels: Vec<String> = (0..MAX_DOCS)
            .map(|i| {
                format!(
                    "projects/work/2026/quarter-{:02}/module-{:03}/文档-{:05}-说明.md",
                    i % 12,
                    i % 200,
                    i
                )
            })
            .collect();
        let refs: Vec<&str> = rels.iter().map(|s| s.as_str()).collect();
        let idx = synth("/Users/someone/workspace/notes", &refs, &[], &[]);
        let json = serde_json::to_vec(&DocListResult::from_index(&idx, 1)).unwrap();
        println!(
            "载荷预算：{MAX_DOCS} 条 ⇒ {} 字节（{:.2} MiB），上限 {:.0} MiB；keep_dirs {} 条",
            json.len(),
            json.len() as f64 / (1024.0 * 1024.0),
            MAX_DOCLIST_JSON_BYTES as f64 / (1024.0 * 1024.0),
            idx.keep_dirs().len()
        );
        assert!(
            json.len() < MAX_DOCLIST_JSON_BYTES,
            "整份载荷 {} 字节超预算 {MAX_DOCLIST_JSON_BYTES}",
            json.len()
        );
    }

    /// `incomplete` 的**展示**上限是 100 条，但判据集合用的是**完整列表**。
    #[test]
    fn 未完成报告有上限而判据不受影响() {
        let paths: Vec<String> = (0..MAX_INCOMPLETE_REPORT + 1)
            .map(|i| format!("r/locked{i:03}"))
            .collect();
        let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        let idx = synth("r", &[], &refs, &[]);

        let r = DocListResult::from_index(&idx, 9);
        assert!(!r.complete);
        assert_eq!(r.incomplete.len(), MAX_INCOMPLETE_REPORT, "响应里最多 100 条");
        assert!(r.incomplete_truncated, "被截了就必须说出来");
        // ⭐ 判据集合一条都不许少（每条未知路径自身 ＋ 到 root 的祖先链；
        //    这里所有路径的父目录都是 root 本身，所以 = 101 条路径 ＋ 1 个 root）
        assert_eq!(r.keep_dirs.len(), paths.len() + 1, "完整列表，⛔ 不跟着 100 条截");
        for p in &paths {
            assert!(r.keep_dirs.contains(p), "缺了 {p}");
        }
        assert_eq!(r.index_rev, 7, "发布版本原样回显");
        assert_eq!(r.req, 9, "请求号原样回显");
    }

    /// 完整性两件套与截断两件套**互不冒充**：没截断 ≠ 收录完整。
    #[test]
    fn 完整与截断是两件事() {
        let idx = synth("/r", &["a.md"], &["/r/locked"], &[]);
        let r = DocListResult::from_index(&idx, 1);
        assert!(!r.complete, "有未知子树");
        assert!(!r.truncated, "但没超条数上限");
        assert_eq!(r.total, 1);
        assert_eq!(r.max_docs, MAX_DOCS);
    }
}
