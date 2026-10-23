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
//!    | ② | 名字在 [`IGNORE_DIRS`] 里 | **灰显 + 不可展开** | ❌ |
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

/// ② 类：**灰显 + 不可展开 + 不扫描**的目录名。
///
/// ⚠️ **这是本项目的自创，业界找不到先例**（`design/0003` §2.3 ②：扫遍 Typora 的
/// CSS 与配置都没有忽略目录的痕迹）。**⛔ 不得引"业界都这样"为据。**
/// 正当理由是**面向场景不同**：Typora 面向写作者（目录里通常只有 `.md`），
/// 本项目面向**读代码仓文档的人**（目录里有 `node_modules`）。
///
/// ⚠️ **不读 `.gitignore`**：那需要实现 gitignore 的匹配语义
/// （否定规则、目录规则、嵌套 `.gitignore`），成本与收益不成比例（§2.1）。
/// 清单里要能加东西，但**不做成配置**。
pub const IGNORE_DIRS: &[&str] = &["node_modules", "target", "dist", "build"];

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
    /// 在 [`IGNORE_DIRS`] 里：**可见但点不动**（灰显、不展开）。
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
/// ⚠️ 判据里**只有名字与"是不是目录"**，⛔ 不含 `file_type()` 失败、软链
/// 这两种"读不出来"的情形——它们的落点在调用方（各自的 `stats` 计数不同）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Class {
    /// ① 名字以 `.` 开头 → **完全隐藏**、⛔ 不进入子项。
    Hidden,
    /// ② 目录名在 [`IGNORE_DIRS`] 里 → **灰显**、⛔ 不进入子项。
    /// ⚠️ 只有**目录**会落进这一档：同名的普通文件不受影响（现状如此，⛔ 别顺手改）。
    Ignored,
    /// ③ 其余目录 + `.md` 文件 → 正常。
    Normal,
    /// 既不是目录、扩展名也不是 `.md` → 不列、不进入。
    Other,
}

/// 判定顺序即优先级：① 在 ② 之前，② 在 ③ 之前（模块头那张表）。
pub(crate) fn classify(name: &str, is_dir: bool) -> Class {
    if name.starts_with('.') {
        return Class::Hidden;
    }
    if is_dir {
        return if IGNORE_DIRS.contains(&name) { Class::Ignored } else { Class::Normal };
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
pub fn list_dir(
    grants: &SessionGrants,
    requested: &Path,
    generation: u64,
    req: u64,
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
        match classify(&name, is_dir) {
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
/// ⭐ **键是 `(root_generation, path)`**，⛔ 不是裸 `path`：
/// 切根之后回到同一个目录，裸 `path` 会命中**上一代的陈旧结果**。
#[derive(Debug, Default)]
pub struct TreeCache {
    map: Mutex<HashMap<(u64, PathBuf), Vec<TreeEntry>>>,
}

impl TreeCache {
    /// 新建。
    pub fn new() -> Self {
        Self::default()
    }

    /// 取一层（未命中返回 `None`）。
    pub fn get(&self, generation: u64, path: &Path) -> Option<Vec<TreeEntry>> {
        self.lock().get(&(generation, path.to_path_buf())).cloned()
    }

    /// 存一层。
    pub fn put(&self, generation: u64, path: &Path, entries: Vec<TreeEntry>) {
        self.lock().insert((generation, path.to_path_buf()), entries);
    }

    /// 丢掉**非当前代**的全部缓存。
    ///
    /// ⚠️ 不这么做的话，切根 N 次就留下 N 份再也命不中的结果——
    /// 它们不会造成错误，只会让内存随浏览历史单调增长。
    pub fn retain_gen(&self, generation: u64) {
        self.lock().retain(|(g, _), _| *g == generation);
    }

    /// ⭐ **作废某一层**的缓存（`design/0009` §2.1 ⑤，本次新增的最小接口）。
    ///
    /// 用途只有一处：搜索浮层回车后，若要定位的那份文件**不在**这一层已缓存的
    /// 子节点里（索引刚重建过、而这一层是更早缓存的），前端会重新列一次这一层——
    /// 那之前必须先把旧结果丢掉，否则重列只会**命中同一份陈旧结果**
    /// （表现是"树死活不动"，`INV-SEARCH-07`）。
    ///
    /// ⚠️ 键里带代次，所以别代的条目**不必**清理：它们本来就命不中
    /// （代次一变，`retain_gen` 会清掉它们）。
    pub fn invalidate(&self, generation: u64, path: &Path) {
        self.lock().remove(&(generation, path.to_path_buf()));
    }

    /// 当前缓存了多少层（诊断用）。
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(u64, PathBuf), Vec<TreeEntry>>> {
        match self.map.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }
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
#[derive(Debug, Clone, PartialEq, Eq)]
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
#[derive(Debug, Clone, Default, PartialEq)]
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

/// ⭐ **全树文件清单**（`design/0009` §2.1 ②）。
///
/// ⚠️ 它是**内存态**：随进程消失，⛔ 不落盘、⛔ 不写 `config.json`（§8 的回滚因此是"删掉就完"）。
///
/// ⚠️ **`roots_gen` 只回答"授权变没变"，回答不了"目录里有没有新文件"**
/// （`INV-SEARCH-06`）：用户不切根、只新建一个文件，代次不会变。
/// ⇒ 内容新鲜度另有一条**明确的**重建时机（浮层打开 / `Cmd+R`），见 [`FileIndex::is_fresh`]。
#[derive(Debug)]
pub struct FileIndex {
    /// 建这份索引时的授权代次。
    pub roots_gen: u64,
    /// 建这份索引的时刻。⭐ 用来回答"它多久没更新了"（[`FileIndex::age_ms`]）。
    pub built_at: Instant,
    /// 覆盖的 root（**已规范化**，显示与分组用）。
    pub roots: Vec<String>,
    /// 全部条目。⚠️ **⛔ 不预先排序**：排序是每次查询按命中排名做的。
    pub entries: Vec<IndexEntry>,
    /// 遍历统计（日志判据）。
    pub stats: IndexStats,
}

impl FileIndex {
    /// ⭐ 这份索引对**当刻**的授权还新鲜吗。
    ///
    /// 判据两条，缺一不可（`design/0009` §2.1 ② 末）：
    /// ① `roots_gen` 与当刻代次相同；② 覆盖的 root 集合与当刻授权**逐项一致**。
    ///
    /// ⚠️ ② 不是 ① 的推论：代次只在 `roots` 变化时 +1，
    /// 但**它是单调计数**——真要比对"覆盖的是不是当刻这几个目录"，就得比集合。
    /// 代价是一次 N 元比较（`roots` 通常只有一项）。
    pub fn is_fresh(&self, generation: u64, roots: &[PathBuf]) -> bool {
        if self.roots_gen != generation || self.roots.len() != roots.len() {
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
pub fn build_index(grants: &SessionGrants) -> Result<FileIndex, Denied> {
    let t0 = Instant::now();
    let mut idx = FileIndex {
        roots_gen: grants.root_generation(),
        built_at: t0,
        roots: Vec::new(),
        entries: Vec::new(),
        stats: IndexStats::default(),
    };

    for root in grants.roots() {
        let real = grants.check_readable(root)?;
        if !real.is_dir() {
            return Err(Denied::not_found(root));
        }
        let root_str = real.display().to_string();
        walk(grants, &real, &real, &root_str, 0, &mut idx);
        idx.roots.push(root_str);
    }

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
    idx: &mut FileIndex,
) {
    if depth > MAX_DEPTH {
        idx.stats.skipped_deep += 1;
        return;
    }
    // ⭐ 唯一的校验入口。⛔ 用返回的 `real` 去 `read_dir`，不用传进来那个串（TOCTOU）。
    let real = match grants.check_readable(dir) {
        Ok(p) => p,
        Err(_) => {
            idx.stats.skipped_denied += 1;
            return;
        }
    };
    // ⚠️ 校验通过之后**再确认一次"它还在 root 之内"**——上面那句推导被撤回，
    //    靠的就是这一刀（软链逃逸的子树在这里被整个跳过，"宁少不越权"）。
    if !grants.is_inside_roots(&real) {
        idx.stats.skipped_denied += 1;
        return;
    }
    let Ok(rd) = std::fs::read_dir(&real) else {
        // 权限不足 / IO 错误 / 刚被删：**跳过这棵子树**，⛔ 不整份失败
        idx.stats.skipped_denied += 1;
        return;
    };
    idx.stats.dirs += 1;

    for item in rd {
        let Ok(item) = item else {
            idx.stats.skipped_other += 1;
            continue;
        };
        idx.stats.scanned += 1;

        let name = item.file_name().to_string_lossy().into_owned();
        let Ok(ft) = item.file_type() else {
            idx.stats.skipped_other += 1;
            continue;
        };
        if ft.is_symlink() {
            // ⭐ `INV-SEARCH-05`：不跟随即不产生——**顺带**保证"循环软链不会挂死"
            idx.stats.skipped_symlink += 1;
            continue;
        }

        let is_dir = ft.is_dir();
        // ⭐ 与单层扫描**同一个谓词**（`INV-SEARCH-02`）
        match classify(&name, is_dir) {
            Class::Hidden => idx.stats.skipped_dot += 1,
            Class::Ignored => idx.stats.ignored += 1, // ② 类：⛔ 绝不进入子项
            Class::Other => idx.stats.skipped_other += 1,
            Class::Normal => {
                let child = item.path();
                if is_dir {
                    walk(grants, &child, root_real, root_str, depth + 1, idx);
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
        let r = list_dir(&g, &root, g.root_generation(), 1).unwrap();

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
        let r = list_dir(&g, &root, g.root_generation(), 1).unwrap();

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
        let r = list_dir(&g, &root, g.root_generation(), 1).unwrap();
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
        let r = list_dir(&g, &root, g.root_generation(), 1).unwrap();
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
        let r = list_dir(&g, &root, g.root_generation(), 1).unwrap();
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

        match list_dir(&g, &root, cur.wrapping_sub(1), 1) {
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

        match list_dir(&g, &other, g.root_generation(), 1) {
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
        match list_dir(&g, &f, g.root_generation(), 1) {
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

        c.put(1, &root, vec![]);
        assert!(c.get(1, &root).is_some());
        // ⭐ 同一路径、下一代：必须是未命中（裸 path 做键就会在这里出错）
        assert!(c.get(2, &root).is_none());
        assert_eq!(c.len(), 1);

        c.put(2, &root, vec![]);
        c.retain_gen(2);
        assert_eq!(c.len(), 1, "旧代被清掉");
        assert!(c.get(1, &root).is_none());
        assert!(c.get(2, &root).is_some());
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
        let idx = build_index(&g).unwrap();

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
        let idx = build_index(&g).unwrap();
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
        let idx = build_index(&g).unwrap();
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
        let idx = build_index(&g).unwrap();
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
        let idx = build_index(&g).unwrap();
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
        let idx = build_index(&g).unwrap();
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
        let idx = build_index(&g).unwrap();
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

        let old = build_index(&g).unwrap();
        assert!(old.is_fresh(generation, g.roots()), "刚建的就是新鲜的");

        // 别的进程新建一份（代次**不会**变）
        t.file("root/新方案.md");
        assert_eq!(g.root_generation(), generation, "新建文件不该动代次");
        assert!(
            old.is_fresh(generation, g.roots()),
            "⚠️ 代次没变 ⇒ 索引仍然'新鲜'——这正是那条要写的断言"
        );

        // ⛔ 缓存里的那份搜不到（用户会以为"这个文件不存在"）
        assert!(!has(&search(&old, "新方案"), "新方案.md"));
        // ✅ 重建之后搜得到（浮层打开 / Cmd+R 走的就是这一步）
        let new = build_index(&g).unwrap();
        assert!(has(&search(&new, "新方案"), "新方案.md"));
        // ⚠️ 改名那半（§7 步骤 6c）：旧名字**不再**命中
        fs::remove_file(root.join("新方案.md")).unwrap();
        t.file("root/旧方案2.md");
        let renamed = build_index(&g).unwrap();
        assert!(!has(&search(&renamed, "新方案"), "新方案.md"));
    }

    /// 代次与 root 集合：`is_fresh` 的两条判据都要真的判。
    #[test]
    fn 索引新鲜度同时看代次与_root_集合() {
        let t = TestDir::new("idx-gen");
        let a = t.dir("a");
        let b = t.dir("b");
        t.file("a/x.md");
        t.file("b/x.md");
        let mut g = grants_for(&a);
        let idx = build_index(&g).unwrap();

        assert!(idx.is_fresh(g.root_generation(), g.roots()));
        assert!(!idx.is_fresh(g.root_generation() + 1, g.roots()), "代次变了必须不新鲜");
        // ⚠️ 切根：代次也变了，这里两项同时变——下面单独把"集合不同但代次相同"那半钉住
        g.authorize_root(&b).unwrap();
        assert!(!idx.is_fresh(g.root_generation(), g.roots()));
        // 造一个"代次相同、root 集合不同"的输入：这正是只比代次会漏掉的那种
        assert!(!idx.is_fresh(idx.roots_gen, &[b.clone()]), "集合不同必须不新鲜");
        assert!(idx.is_fresh(idx.roots_gen, &[a.clone()]), "同一代 + 同一集合 = 新鲜");
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
        let idx = build_index(&g).unwrap();
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
        let idx = build_index(&g).unwrap();
        assert!(has(&search(&idx, "看得见"), "看得见.md"));
        assert!(!has(&search(&idx, "秘密"), "秘密.md"), "⛔ 软链逃脱不许被列出来");
        // 它走的是"软链不产生"那一档（父层就看出来了），而不是 read_dir 才发现
        assert_eq!(idx.stats.skipped_symlink, 1);

        // ⭐ 再直接对 walk 喂一个**在 root 之外**的目录：走的是 `is_inside_roots` 那一刀。
        //    ⚠️ 这一条防的是一条 TOCTOU——父层 `file_type()` 说是普通目录，
        //    到我们 `read_dir` 之前被换成了指向 root 外的软链（`design/0009` §2.1 ①）。
        let mut idx2 = FileIndex {
            roots_gen: g.root_generation(),
            built_at: Instant::now(),
            roots: vec![root.display().to_string()],
            entries: Vec::new(),
            stats: IndexStats::default(),
        };
        walk(&g, &outside, &root, &root.display().to_string(), 0, &mut idx2);
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
        let idx = build_index(&empty).unwrap();
        assert!(idx.entries.is_empty() && idx.roots.is_empty());
        assert_eq!(idx.roots_gen, 0);

        // 根被删掉（授权还在）：canonicalize 失败 ⇒ NotFound，⛔ 不是"0 条命中"
        let g = grants_for(&root);
        assert!(build_index(&g).is_ok(), "构造本身要成立：先能建出来");
        fs::remove_dir_all(&root).unwrap();
        match build_index(&g) {
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
        let idx = build_index(&g).unwrap();
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
        let idx = build_index(&g).unwrap();
        assert_eq!(idx.entries.len(), 1);
        let e = &idx.entries[0];
        assert_eq!(e.name, "deep.md");
        assert_eq!(e.rel, "a/b/deep.md");
        assert_eq!(e.root, fs::canonicalize(&root).unwrap().display().to_string());
        assert_eq!(e.real_path, fs::canonicalize(root.join("a/b/deep.md")).unwrap().display().to_string());
        // ⭐ `real_path` 直接喂给 `open_document` 是**能用**的（它还会再过一次校验）
        assert!(e.real_path.starts_with(&e.root));
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
                let r = list_dir(&g, &root, generation, (round as u64) * 1000 + i + 1).unwrap();
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
}
