//! ⭐ **会话授权对象**：本项目唯一的读取入口（`design/0003` §2.1.2，`adr/0007`）。
//!
//! # 这个文件为什么是安全核心
//!
//! Tauri **不替我们校验路径**（一手依据见 `docs/kb/0004` 事实一：官方文档写明
//! "scope 要由应用自己定义并自己在命令实现里执行校验"）。所以
//! `INV-FS-01` 的防线**全部**落在本文件的 [`SessionGrants::check_readable`] 上，
//! 而它的**唯一自动化防线**是本文件末尾那张判定矩阵（`design/0003` §7）。
//!
//! # 三条容易写错的地方（`design/0003` §2.1.2 (1) 的注意点，逐条落地）
//!
//! 1. ⛔ **用 `Path::starts_with`，不是字符串的 `starts_with`**——
//!    前者**按路径分量**比较，所以 `/a/rootfoo` **不**匹配 `/a/root`。
//!    字符串比较会匹配，于是 `rootfoo` 被当成 `root` 的子目录（经典前缀陷阱）。
//! 2. **`canonicalize` 失败一律归 [`Denied::NotFound`]**，⛔ 不区分"权限不足"与"不存在"
//!    ——差别化会让越权尝试变成一次目录探测。
//! 3. **`real == *f` 而不是 `real.ends_with(*f)`**：`files` 是**逐个文件**的授权，
//!    同目录下的**另一个**文件必须被拒。
//!
//! # 授权只由授权命令产生（`INV-FS-04`）
//!
//! [`SessionGrants`] 的写入点只有三个方法：[`authorize_root`](SessionGrants::authorize_root)、
//! [`authorize_file`](SessionGrants::authorize_file)、[`revoke_roots`](SessionGrants::revoke_roots)，
//! 而它们只被**授权命令**（`choose_directory` / `choose_file` / 启动 argv）调用。
//! ⛔ 读取命令（`open_document` / `list_dir` / `read_asset`）**永不**调用它们——
//! 不做隐式提权、不接受前端传来的"来源"标志。
//!
//! ⚠️ **授权不落盘、不跨重启**（`INV-FS-03`，刻意与官方推荐的 `persisted-scope` 相反）。

use std::path::{Path, PathBuf};

use crate::error::Denied;

/// 会话级授权。只在本进程生命周期内存在，⛔ 不落盘、⛔ 不跨重启。
#[derive(Debug, Default, Clone)]
pub struct SessionGrants {
    /// 用户通过「目录选择器」或启动参数明确确认过的根目录（**已 canonicalize**）。
    roots: Vec<PathBuf>,
    /// 用户通过「文件选择器」或启动参数明确确认过的单个文件（**已 canonicalize**）。
    files: Vec<PathBuf>,
    /// 根目录代次。**每次 `roots` 变化 +1**（`design/0003` §2.1.3）。
    ///
    /// ⚠️ 它只随 `roots` 变化，⛔ 不随 `files` 变化——单文件模式下的自动重载
    /// 不该空转一次代次递增（§2.1.4 第 ③ 步的触发条件）。
    root_generation: u64,
}

impl SessionGrants {
    /// 空的授权集（什么都不许读）。
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前根目录代次。
    pub fn root_generation(&self) -> u64 {
        self.root_generation
    }

    /// 已授权的根目录（**已规范化**）。
    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// 已授权的单个文件（**已规范化**）。
    pub fn files(&self) -> &[PathBuf] {
        &self.files
    }

    /// 当前有没有已授权的根目录。
    ///
    /// ⚠️ 前端第 ③ 步的触发条件要用它（§2.1.4）——
    /// 若把"单文件模式"误判成"有 root"，每次自动重载都会空转一次代次递增。
    pub fn has_roots(&self) -> bool {
        !self.roots.is_empty()
    }

    /// ⭐ **唯一的校验入口**。所有读路径**无条件**经过它，⛔ 没有旁路。
    ///
    /// 返回**规范化后的真实路径**，调用方**必须**用它去打开文件——
    /// ⛔ 不得回退到请求里那个未规范化的字符串（那是一次 TOCTOU：
    /// 校验完到打开之间，`root/link` 可能被换成别的东西）。
    ///
    /// # 为什么 `canonicalize` 先于比较就是软链逃逸的防线
    ///
    /// `root/link → /etc` 被解析成 `/etc`，不再 `starts_with(root)` → 拒绝。
    /// ⚠️ 这**不解决** macOS 大小写不敏感文件系统上的大小写问题
    /// （Tauri 自己的 `FsScope::is_allowed` 同样不解决，见 `kb/0004`）——
    /// 已计入单测矩阵，⛔ **不列入"已解决"**。
    pub fn check_readable(&self, requested: &Path) -> Result<PathBuf, Denied> {
        let real = std::fs::canonicalize(requested)
            .map_err(|_| Denied::not_found(requested))?;

        if self.is_readable_real(&real) {
            return Ok(real);
        }
        Err(Denied::not_authorized(requested))
    }

    /// ⭐ **图片专用的读校验**（`design/0036`，2026-10-23 按用户当轮授权实施）。
    ///
    /// 与 [`check_readable`](Self::check_readable) **同一套规范化与同一套比较语义**，
    /// 只多一条：**以单文件方式授权的那份文档，它所在目录（含子目录）里的文件可读**。
    ///
    /// # 为什么不是"把整个目录加进 `roots`"
    ///
    /// 那正是 `design/0003` §2.1.4 否决过的替代方案：`roots` 是**树 / 搜索 / 打开文档**
    /// 共用的读取范围，加进去等于用户只选了一个文件、却把整个目录的浏览权也交出去。
    /// 本方法只服务 `read_asset` 一个调用点，⛔ 不改变 `check_readable` 的任何判定。
    ///
    /// # 边界
    ///
    /// - 只放宽到**授权文件父目录的子树**，`../` 逃出去照样被 `canonicalize` 判掉；
    /// - 软链先被 `canonicalize` 解掉再比前缀，`docs/pic.png → /etc/passwd` 仍被拒；
    /// - 前缀按**路径分量**比较（`/a/docs` 不含 `/a/docs2`）。
    ///
    /// # 它换来了什么，代价是什么
    ///
    /// 换取的是阅读器最基本的预期：`rmd README.md` 就能看见同一目录（及其子树）里的图片，
    /// 不必先"打开目录"再点文件。代价是：**被打开的那份文档**可以让 rmd 读取它
    /// 同目录子树里的任意文件，并以 `data:` URL 放进 DOM。
    /// ⚠️ 由于本项目**不执行文档里的脚本**（`INV-SEC-01`）、远端图片也**不自动加载**，
    /// 这条读取不构成外发通道；它最多把同目录文件当成"显示不出来的图片"呈现。
    pub fn check_readable_asset(&self, requested: &Path) -> Result<PathBuf, Denied> {
        let real = std::fs::canonicalize(requested)
            .map_err(|_| Denied::not_found(requested))?;

        if self.is_readable_real(&real) {
            return Ok(real);
        }
        // ⭐ 单文件授权 ⇒ 它的父目录（及其子树）供图片读取。
        //    ⚠️ 父目录从**已规范化的** `files` 里取，⛔ 不从请求路径里推。
        if self
            .files
            .iter()
            .filter_map(|f| f.parent())
            .any(|dir| real.starts_with(dir))
        {
            return Ok(real);
        }
        Err(Denied::not_authorized(requested))
    }

    /// `roots` / `files` 这套**主授权面**是否允许一个（已规范化的）路径。
    ///
    /// ⚠️ 抽出来只为让 [`check_readable`](Self::check_readable) 与
    /// [`check_readable_asset`](Self::check_readable_asset) **共用同一份比较语义**——
    /// ⛔ 不是第二个授权面：图片那一条额外规则写在 `check_readable_asset` 里。
    fn is_readable_real(&self, real: &Path) -> bool {
        // ⚠️ 这一行必须是 `Path::starts_with`（按分量），见模块头第 1 条
        if self.roots.iter().any(|r| real.starts_with(r)) {
            return true;
        }
        // ⚠️ `==` 而不是 `ends_with`，见模块头第 3 条
        self.files.iter().any(|f| real == *f)
    }

    /// 这个（**已规范化**的）路径是不是落在某个已授权 root 之下。
    ///
    /// ⚠️ 与 [`check_readable`](Self::check_readable) 同一套比较语义——
    /// 前端 §2.1.4 第 ③ 步的判定由后端算，⛔ 不让前端自己拼前缀
    /// （JS 里的字符串比较正是那个前缀陷阱）。
    pub fn is_inside_roots(&self, real: &Path) -> bool {
        self.roots.iter().any(|r| real.starts_with(r))
    }

    /// ⭐ **唯一的写侧判定**（`design/0012` §2.4-1 / `INV-EDIT-02`）。
    ///
    /// # 它**与 `check_readable` 同源**，⛔ 不是第二套判定
    ///
    /// 前半段就是把 [`check_readable`](Self::check_readable) **原样调一遍**
    /// （同一个 `canonicalize`、同一套 `roots` / `files` 语义、同一个
    /// [`Denied::NotFound`] 归并口径）——⭐ 这样"可写"永远是"可读"的**子集**，
    /// ⛔ 结构上不可能出现"读不了但写得动"。
    ///
    /// # 后半段只有一条：**恒等于"当前这一份"**
    ///
    /// ⚠️ 用 `==` 而不是 `starts_with` / `ends_with`：授权 root 下的
    /// **兄弟文件**必须被拒——编辑器只能写**它正在显示的那一份**
    /// （`features/0012` 的「不改别人的东西」）。
    ///
    /// ⚠️ `current` 是**参数**而不是从 `self` 里读：`current_document` 是
    /// [`Session`](crate::commands::Session) 的状态，⛔ 不是授权的状态
    /// （读侧引用的"要写哪个文件"这个决定不该混进授权对象）。传进来还顺带
    /// 让本函数**纯**——§7 那张判定矩阵能在无锁、无命令层的环境里跑。
    ///
    /// ⚠️ `current` 为 `None`（没有当前文档）也归 [`Denied::NotAuthorized`]，
    /// ⛔ 不归 `NotFound`：后者的文案是"文件不存在"，在这里是**假话**，
    /// 而两种情形的正确用户动作是同一个——先把一份文档打开。
    pub fn check_writable(&self, requested: &Path, current: Option<&Path>) -> Result<PathBuf, Denied> {
        // ⭐ 前半段：**同源**。⛔ 别在这里另写一遍 canonicalize + roots/files
        let real = self.check_readable(requested)?;
        match current {
            Some(cur) if real == *cur => Ok(real),
            _ => Err(Denied::not_authorized(requested)),
        }
    }

    /// ⭐ **重命名的条目闸门**（`design/0035` §3.3.2 / `INV-RENAME-06`）。
    ///
    /// 六步，顺序即优先级。返回**规范化后的真实路径**，改名目标 = 它的父目录 + 新名字。
    ///
    /// 1. 走 [`check_readable`](Self::check_readable)（规范化 + `roots`/`files` 同一套语义）；
    /// 2. `real` 必须落在某个 **root 之内或等于它**——⛔ 只凭 `files` 授权的单文件**不能改名**
    ///    （单文件授权说的是"读这一份"，不是"在这里搬东西"）；
    /// 3. ⚠️⭐ **请求的那一条本身不能是软链**：判据打在**请求路径**上
    ///    （`symlink_metadata(requested)`）。⛔ 不能拿 `real` 判——它已经被
    ///    `canonicalize` 解掉了链接，那里看到的永远是**目标**，永远不会是软链；
    /// 4. 必须是**普通文件**且 `tree::is_markdown`（否则 [`Denied::NotRenamable`]）；
    /// 5. ⛔ 不能是 root 本身；
    /// 6. 父目录走 [`check_creatable`](Self::check_creatable)（⭐ 复用逐段 `classify`，
    ///    ⛔ 不抄第二份），然后复核 `parent_real.join(old_name) == real`——
    ///    其中 `old_name` 取**请求 `from` 的最后一个分量**（⛔ 不是 `real.file_name()`，
    ///    那样这一条恒真、等于没判）。
    ///
    /// ⚠️ **状态类拦截不在这里**（"编辑态 / 保存在途"要读 `Session`）
    /// ⇒ 在 `Session::rename_guard`（`design/0035` §3.3.7）。
    ///
    /// ⚠️ 第 6 步的大小写：`real` 与 `parent_real` 都来自 `canonicalize`（盘上真名），
    /// 而 `old_name` 来自请求。树节点的路径本来就来自 `list_dir`（盘上真名），
    /// 所以正常路径上逐字节相等；⛔ 若前端传来大小写不同的路径，这里会拒
    /// （`Symlink`）——那是**安全侧**，⛔ 不放宽成"大小写不敏感比较"。
    pub fn check_renamable(&self, requested: &Path) -> Result<PathBuf, Denied> {
        // ① 同源校验（规范化 + roots/files）
        let real = self.check_readable(requested)?;

        // ② 必须在某个 root 之内（含根本身）
        let Some(root) = self.roots.iter().find(|r| real.starts_with(r)) else {
            return Err(Denied::not_authorized(requested));
        };

        // ③ ⭐ 软链判据：**请求路径**，⛔ 不是 `real`
        let meta = std::fs::symlink_metadata(requested)
            .map_err(|_| Denied::not_found(requested))?;
        if meta.file_type().is_symlink() {
            return Err(Denied::not_renamable(&real, crate::error::RenameRefusal::Symlink));
        }

        // ④ 普通文件 + Markdown。⚠️ 名字取**请求**的最后一段（与第 6 步同一个口径）
        let old_name = requested
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| {
                Denied::not_renamable(&real, crate::error::RenameRefusal::NotMarkdown)
            })?;
        if !meta.is_file() || !crate::fs::tree::is_markdown(old_name) {
            return Err(Denied::not_renamable(&real, crate::error::RenameRefusal::NotMarkdown));
        }

        // ⑤ 根自身不能改名（目录 ⇒ 上面已经拒了；这一行是**显式**的，⛔ 不靠上一步的副作用）
        if real == *root {
            return Err(Denied::not_renamable(&real, crate::error::RenameRefusal::NotMarkdown));
        }

        // ⑥ 父目录闸门 + 复核
        let parent = real
            .parent()
            .ok_or_else(|| Denied::not_renamable(&real, crate::error::RenameRefusal::NotMarkdown))?;
        let parent_real = self.check_creatable(parent)?;
        if parent_real.join(old_name) != real {
            // ⭐ 软链的**第二道**防线（若第 ③ 步将来失效，这里会因对不上被拒）
            return Err(Denied::not_renamable(&real, crate::error::RenameRefusal::Symlink));
        }

        Ok(real)
    }


    ///
    /// 四步，顺序即优先级：
    ///
    /// 1. 走 [`check_readable`](Self::check_readable)（规范化 + `roots`/`files` 同一套语义）；
    /// 2. `real` 必须**落在某个 root 之内或等于它**——⛔ 只靠 `files` 授权的条目
    ///    不能当父目录（单文件授权说的是"读这一份"，不是"在这里造东西"）；
    /// 3. 必须是个目录（`real` 已规范化，判的是**目标**，不是链接）；
    /// 4. ⭐ **逐段复用 [`tree::classify`]**：从**根的子项**开始，每一段都必须是
    ///    `Normal`。⚠️ **根自身豁免**——用户显式打开的就是它，它叫 `.config` 也合法。
    ///
    /// ⚠️ 第 4 步⛔ **不抄第二份谓词**（与 `INV-SEARCH-02` 同一条理由）：
    /// 树里看不见 / 不可展开的位置，这里也必须建不了，两侧的判据必须是同一个函数。
    ///
    /// 返回**规范化后的父目录**，创建目标 = `real.join(最终名字)`。
    pub fn check_creatable(&self, parent: &Path) -> Result<PathBuf, Denied> {
        let real = self.check_readable(parent)?;

        // ② 必须落在某个 root 之内（含根本身）
        let Some(root) = self.roots.iter().find(|r| real.starts_with(r)) else {
            return Err(Denied::not_authorized(parent));
        };

        // ③ 必须是目录
        if !real.is_dir() {
            return Err(Denied::not_found(parent));
        }

        // ④ 逐段过滤语义。⚠️ `strip_prefix` 之后不会出现 `..`（real 已规范化）
        let rel = real.strip_prefix(root).unwrap_or(Path::new(""));
        for seg in rel.components() {
            let std::path::Component::Normal(name) = seg else {
                // 规范化后的相对路径不该出现其它分量；出现就按不可用处理（安全侧）
                return Err(Denied::unusable_parent(&real));
            };
            let name = name.to_string_lossy();
            // ⚠️ `is_dir = true`：父链上的每一段都必须是目录
            if !matches!(crate::fs::tree::classify(&name, true), crate::fs::tree::Class::Normal) {
                return Err(Denied::unusable_parent(&real));
            }
        }

        Ok(real)
    }

    // ─────────────────────────────────────────────────────────────────
    // 以下三个是**授权命令专用**的写入点（`INV-FS-04`）。
    // ⛔ 读取命令永远不许调它们。
    // ─────────────────────────────────────────────────────────────────

    /// ⭐ 授权一个根目录。**替换**（不是追加）`roots`，并 `root_generation += 1`。
    ///
    /// 返回**已规范化**的根，调用方要用它去显示（⛔ 不是用户给的原始字符串）。
    ///
    /// ⚠️ 替换而不是追加：侧边栏只有**一棵**树（§2.1.4 的理由 1），
    /// 而两份 `roots` 会让"当前项高亮"无处安放。
    pub fn authorize_root(&mut self, dir: &Path) -> Result<PathBuf, Denied> {
        let real = std::fs::canonicalize(dir).map_err(|_| Denied::not_found(dir))?;
        if !real.is_dir() {
            return Err(Denied::not_found(dir));
        }
        self.roots = vec![real.clone()];
        self.root_generation += 1;
        Ok(real)
    }

    /// 授权一个单文件（`choose_file` / 启动参数）。**追加**，⛔ 不动 `roots`、⛔ 不动代次。
    ///
    /// ⚠️ 这里"不动代次"是 **§2.1.4 时序**的要求：`choose_file` 只把文件加进来，
    /// "是不是外部文件"由 `open_document` 用 `path ∉ roots` **当场判定**，
    /// ⛔ 不需要任何额外状态。
    pub fn authorize_file(&mut self, file: &Path) -> Result<PathBuf, Denied> {
        let real = std::fs::canonicalize(file).map_err(|_| Denied::not_found(file))?;
        if !real.is_file() {
            return Err(Denied::not_found(file));
        }
        if !self.files.contains(&real) {
            self.files.push(real.clone());
        }
        Ok(real)
    }

    /// 收回**全部**目录授权并 `root_generation += 1`（关闭目录 / 打开外部单文件）。
    ///
    /// ⚠️ `files` 不动——单文件授权与目录授权是两件事，
    /// 收回目录不该把用户刚打开的那份文档也变成不可读（§6 失败模型的最后一行）。
    pub fn revoke_roots(&mut self) {
        self.roots.clear();
        self.root_generation += 1;
    }
}

/// 带锁的会话状态由 `commands::AppState` 提供（那层依赖 Tauri，被 feature 门控）。
/// ⚠️ 本文件刻意**不含锁**：§7 那张判定矩阵要在单线程里跑，锁只会让测试多一层噪声。

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 一次性测试目录。⛔ 不引入 `tempfile` 依赖（本项目钉版本、少依赖）。
    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(tag: &str) -> Self {
            // ⚠️ 用进程 id + 参数名做唯一性，避免同一个测试二进制里的并行测试互撞
            let base = std::env::temp_dir()
                .join(format!("rmd-grants-{}-{tag}", std::process::id()));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(&base).unwrap();
            TestDir { path: fs::canonicalize(&base).unwrap() }
        }

        fn dir(&self, rel: &str) -> PathBuf {
            let p = self.path.join(rel);
            fs::create_dir_all(&p).unwrap();
            p
        }

        fn file(&self, rel: &str, body: &str) -> PathBuf {
            let p = self.path.join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, body).unwrap();
            p
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    /// §7 判定矩阵：**`check_readable` 是 `INV-FS-01`/`INV-FS-04` 的唯一自动化防线。**
    #[test]
    fn 判定矩阵_root_下的文件允许且返回规范化路径() {
        let t = TestDir::new("matrix-allow");
        let root = t.dir("root");
        let f = t.file("root/a/b.md", "hi");

        let mut g = SessionGrants::new();
        let authorized = g.authorize_root(&root).unwrap();
        assert_eq!(authorized, root, "authorize_root 必须回带规范化后的真实路径");

        let got = g.check_readable(&f).unwrap();
        // ⭐ 返回的必须是**规范化后**的真实路径
        assert_eq!(got, fs::canonicalize(&f).unwrap());
        assert!(got.is_absolute());
    }

    #[test]
    fn 判定矩阵_点斜杠逃出_root_被拒() {
        let t = TestDir::new("matrix-dotdot");
        let root = t.dir("root");
        t.dir("outside");
        let escape = t.file("outside/b.md", "secret");

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        // `root/../outside/b.md` 规范化后落在 root 之外
        let sneaky = root.join("../outside/b.md");
        assert!(sneaky.exists(), "构造本身要成立");
        match g.check_readable(&sneaky) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应当拒绝，实得 {other:?}"),
        }
        // 而且直接给真身也必须拒（不能靠"绕过写法的多样性"来防）
        assert!(matches!(g.check_readable(&escape), Err(Denied::NotAuthorized { .. })));
    }

    #[test]
    fn 判定矩阵_绝对路径_etc_passwd_被拒() {
        let t = TestDir::new("matrix-etc");
        let root = t.dir("root");

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        // ⚠️ `/etc/passwd` 在 macOS 与 Linux 上都存在，所以这里拒绝的原因是
        //    **未授权**，不是"找不到"——正是 §2.1.2 注意点 2 要保住的区别
        match g.check_readable(Path::new("/etc/passwd")) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应当 NotAuthorized，实得 {other:?}"),
        }
    }

    #[test]
    fn 判定矩阵_软链逃出_root_被拒() {
        let t = TestDir::new("matrix-symlink");
        let root = t.dir("root");
        // root/link-to-etc → /etc
        std::os::unix::fs::symlink("/etc", root.join("link-to-etc")).unwrap();

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        // ⭐ canonicalize 先解符号链接再比前缀 —— 这就是软链逃逸的防线
        match g.check_readable(&root.join("link-to-etc/passwd")) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应当拒绝，实得 {other:?}"),
        }
    }

    #[test]
    fn 判定矩阵_前缀陷阱_rootfoo_不是_root_的子目录() {
        let t = TestDir::new("matrix-prefix");
        let root = t.dir("root");
        let rootfoo = t.dir("rootfoo");
        let f = t.file("rootfoo/a.md", "hi");

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        // ⭐⭐ 这一格只有用**按路径分量比较**的 `Path::starts_with` 才能过。
        //    字符串 `starts_with`（`"/x/rootfoo/a.md".starts_with("/x/root")`）会返回 true，
        //    于是 rootfoo 被当成了 root 的子目录。
        assert!(
            f.to_string_lossy().starts_with(&*root.to_string_lossy()),
            "构造本身要成立：rootfoo 的路径**以** root 的字符串开头（这正是陷阱所在）"
        );
        assert!(!f.starts_with(&root), "Path::starts_with 按分量比较，必须为 false");
        match g.check_readable(&f) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应当拒绝（前缀陷阱），实得 {other:?}"),
        }
        drop(rootfoo);
    }

    #[test]
    fn 判定矩阵_大小写差异按平台记录实测() {
        let t = TestDir::new("matrix-case");
        let root = t.dir("root");
        let f = t.file("root/a.md", "hi");

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        // 把路径整体换成大写（root 这一段的真实大小写会被 canonicalize 还原）
        let upper = PathBuf::from(f.to_string_lossy().to_uppercase());

        // ⚠️ §7 明写：**不要断言"统一行为"**——macOS（大小写不敏感 APFS）允许，
        //    Linux 拒绝。这里按平台分别断言，把实测结果固定下来。
        #[cfg(target_os = "macos")]
        {
            let got = g.check_readable(&upper);
            println!("[实测] macOS 大小写差异：{upper:?} → {got:?}");
            assert!(got.is_ok(), "macOS 上应当允许（canonicalize 还原了真实大小写）");
        }
        #[cfg(not(target_os = "macos"))]
        {
            let got = g.check_readable(&upper);
            println!("[实测] 非 macOS 大小写差异：{upper:?} → {got:?}");
            assert!(got.is_err(), "大小写敏感文件系统上应当拒绝");
        }
    }

    #[test]
    fn 判定矩阵_files_里的那个文件允许_同目录的另一个文件被拒() {
        let t = TestDir::new("matrix-files");
        let one = t.file("notes/a.md", "a");
        let two = t.file("notes/b.md", "b");

        let mut g = SessionGrants::new();
        g.authorize_file(&one).unwrap();

        assert_eq!(g.check_readable(&one).unwrap(), fs::canonicalize(&one).unwrap());
        // ⭐ `files` 是**逐个文件**的授权，不是目录
        match g.check_readable(&two) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应当拒绝，实得 {other:?}"),
        }
    }

    #[test]
    fn 判定矩阵_空授权全部拒绝() {
        let t = TestDir::new("matrix-empty");
        let f = t.file("a.md", "hi");

        let g = SessionGrants::new();
        assert!(matches!(g.check_readable(&f), Err(Denied::NotAuthorized { .. })));
        assert!(matches!(
            g.check_readable(Path::new("/etc/passwd")),
            Err(Denied::NotAuthorized { .. })
        ));
    }

    #[test]
    fn 判定矩阵_不存在的路径归_not_found_而不是_not_authorized() {
        let t = TestDir::new("matrix-missing");
        let root = t.dir("root");
        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        // ⚠️ root 之内但不存在的路径 → NotFound（前端的文案是"文件不存在"）
        assert!(matches!(
            g.check_readable(&root.join("nope.md")),
            Err(Denied::NotFound { .. })
        ));
        // ⚠️ root 之外的绝对路径若不存在，同样是 NotFound——⛔ 不泄露"它是否存在"
        assert!(matches!(
            g.check_readable(Path::new("/definitely/not/here.md")),
            Err(Denied::NotFound { .. })
        ));
    }

    // ── 代次（`design/0003` §2.1.3）─────────────────────────────────

    #[test]
    fn 代次只随_roots_变化() {
        let t = TestDir::new("generation");
        let root = t.dir("root");
        let f = t.file("notes/a.md", "a");

        let mut g = SessionGrants::new();
        assert_eq!(g.root_generation(), 0);
        assert!(!g.has_roots(), "单文件模式下 roots 是空的");

        g.authorize_root(&root).unwrap();
        assert_eq!(g.root_generation(), 1);
        assert!(g.has_roots());

        // ⭐ choose_file 只加文件，⛔ 不动代次（§2.1.4：否则自动重载会空转代次）
        g.authorize_file(&f).unwrap();
        assert_eq!(g.root_generation(), 1, "授权文件不该递增代次");

        g.revoke_roots();
        assert_eq!(g.root_generation(), 2);
        assert!(!g.has_roots());
        // ⚠️ 收回目录**不动** files：用户刚打开的那份文档不该因此不可读
        assert_eq!(g.files().len(), 1);
    }

    #[test]
    fn 授权_root_替换而不是追加_且回带规范化路径() {
        let t = TestDir::new("replace-root");
        let a = t.dir("a");
        let b = t.dir("b");

        let mut g = SessionGrants::new();
        g.authorize_root(&a).unwrap();
        g.authorize_root(&b).unwrap();

        assert_eq!(g.roots(), &[fs::canonicalize(&b).unwrap()]);
        assert_eq!(g.root_generation(), 2);
    }

    #[test]
    fn 授权目录时给一个文件会被拒() {
        let t = TestDir::new("authorize-file-as-root");
        let f = t.file("a.md", "hi");
        let mut g = SessionGrants::new();
        assert!(matches!(g.authorize_root(&f), Err(Denied::NotFound { .. })));
        assert_eq!(g.root_generation(), 0, "失败不该改变代次");
    }

    // ─────────────────────────────────────────────────────────────────
    // ⭐ `check_writable`（`design/0012` §7 单测表那一行）
    // ─────────────────────────────────────────────────────────────────

    /// ① 授权内的**当前**文件 ✅
    #[test]
    fn 写侧_授权内的当前文件允许且返回规范化路径() {
        let t = TestDir::new("write-allow");
        let root = t.dir("root");
        let f = t.file("root/a.md", "hi");
        let real = fs::canonicalize(&f).unwrap();

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        assert_eq!(g.check_writable(&f, Some(&real)).unwrap(), real);
        // ⚠️ 走非规范化的写法也必须过（同源的 `canonicalize` 在这里）
        let sneaky = root.join("./a.md");
        assert_eq!(g.check_writable(&sneaky, Some(&real)).unwrap(), real);
    }

    /// ② 授权内但**非当前** —— ⛔ 拒。
    ///
    /// ⭐ **这就是那条变异测试**：把 `check_writable` 里
    /// `Some(cur) if real == *cur` 那一句删掉（或改成 `starts_with`），
    /// 本条立刻变红。它守的是 `INV-EDIT-02` 的「只对当前这一份文件」。
    #[test]
    fn 写侧_同一_root_下的兄弟文件被拒() {
        let t = TestDir::new("write-sibling");
        let root = t.dir("root");
        let a = t.file("root/a.md", "a");
        let b = t.file("root/b.md", "b");
        let real_a = fs::canonicalize(&a).unwrap();

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        // ✅ 当前那一份
        assert!(g.check_writable(&a, Some(&real_a)).is_ok());
        // ⛔ 兄弟文件：**可读**（`check_readable` 让它过），但**不可写**
        assert!(g.check_readable(&b).is_ok(), "构造前提：兄弟文件是可读的");
        assert!(matches!(
            g.check_writable(&b, Some(&real_a)),
            Err(Denied::NotAuthorized { .. })
        ));
    }

    /// ③ 授权外 ⛔ ／ ④ 未授权目录 ⛔
    #[test]
    fn 写侧_授权外与空授权都被拒() {
        let t = TestDir::new("write-denied");
        let root = t.dir("root");
        let inside = t.file("root/a.md", "a");
        let outside = t.file("outside/x.md", "x");
        let real_inside = fs::canonicalize(&inside).unwrap();

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();
        // ③ 授权外：即使"就是当前这一份"也不行
        assert!(matches!(
            g.check_writable(&outside, Some(&real_inside)),
            Err(Denied::NotAuthorized { .. })
        ));

        // ④ 空授权（未授权目录 / 裸跑会话）：全拒
        let empty = SessionGrants::new();
        assert!(matches!(
            empty.check_writable(&inside, Some(&real_inside)),
            Err(Denied::NotAuthorized { .. })
        ));
    }

    /// ⚠️ 没有当前文档 ⇒ 拒，且**归 `NotAuthorized` 而不是 `NotFound`**。
    #[test]
    fn 写侧_没有当前文档归_not_authorized_而不是_not_found() {
        let t = TestDir::new("write-no-current");
        let root = t.dir("root");
        let f = t.file("root/a.md", "a");
        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        match g.check_writable(&f, None) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应归 NotAuthorized（文件明明存在），实得 {other:?}"),
        }
        // ⚠️ 对照：**不存在**的路径仍然归 `NotFound`（那才是它的正确文案）
        let ghost = root.join("nope.md");
        assert!(matches!(g.check_writable(&ghost, None), Err(Denied::NotFound { .. })));
    }

    /// ⑤ 路径带中文 / 空格 ✅
    #[test]
    fn 写侧_路径带中文与空格允许() {
        let t = TestDir::new("write-cjk");
        let root = t.dir("root");
        let f = t.file("root/我的 笔记.md", "正文");
        let real = fs::canonicalize(&f).unwrap();

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();
        assert_eq!(g.check_writable(&f, Some(&real)).unwrap(), real);
    }

    /// ⑥ **与 `check_readable` 的判定集合逐条对照**。
    ///
    /// ⭐ 判据是**包含关系而不是相等**：写侧判"过"的路径必须**全部**被读侧判过
    /// （⇒ "可写" ⊆ "可读"），反之不要求（可读的兄弟文件不可写，见上一条）。
    /// ⚠️ 这条一旦变红，说明有人给写侧另造了一套判定（`INV-EDIT-02` 的前半点）。
    #[test]
    fn 写侧判定集合是读侧的子集() {
        let t = TestDir::new("write-subset");
        let root = t.dir("root");
        t.dir("other");
        let cases = vec![
            t.file("root/a.md", "a"),
            t.file("root/sub/b.md", "b"),
            t.file("root/我的 笔记.md", "c"),
            t.file("other/x.md", "x"),
            root.join("nonexistent.md"),
            root.join("../root/a.md"), // 绕一圈回到授权内
            PathBuf::from("/etc/hosts"),
        ];

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();
        let current = fs::canonicalize(t.file("root/a.md", "a")).unwrap();

        for c in &cases {
            // ⚠️ 写侧"过"时，读侧**必须**也过
            if let Ok(real) = g.check_writable(c, Some(&current)) {
                assert!(
                    g.check_readable(c).is_ok(),
                    "{c:?} 写侧放行（{real:?}）但读侧不放行 ⇒ 写侧已经另成一套判定"
                );
            }
        }
    }

    // ── `design/0034` §2.1 B：`check_creatable` 的判定矩阵 ──────────────

    #[test]
    fn 可建_根自身豁免过滤且深层正常目录放行() {
        let t = TestDir::new("creatable-ok");
        let root = t.dir("root");
        let deep = t.dir("root/a/b");
        t.dir("root/a/b/c");

        let mut g = SessionGrants::new();
        let real_root = g.authorize_root(&root).unwrap();

        // ⭐ 根自身不检查：哪怕它叫 `.config` / `node_modules` 也能新建
        assert_eq!(g.check_creatable(&root).unwrap(), real_root);
        assert_eq!(g.check_creatable(&deep).unwrap(), fs::canonicalize(&deep).unwrap());
        // ⚠️ 大小写敏感：`Target` 在树里正常，这里也必须能建
        let target_upper = t.dir("root/Target");
        assert!(g.check_creatable(&target_upper).is_ok());
    }

    #[test]
    fn 可建_点开头的祖先归_unusable_parent() {
        let t = TestDir::new("creatable-hidden");
        let root = t.dir("root");
        let hidden = t.dir("root/.secret");
        let deeper = t.dir("root/.secret/inner");

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        for p in [&hidden, &deeper] {
            match g.check_creatable(p) {
                Err(Denied::UnusableParent { .. }) => {}
                other => panic!("{p:?} 应当 UnusableParent，实得 {other:?}"),
            }
        }
    }

    #[test]
    fn 可建_忽略目录祖先归_unusable_parent() {
        let t = TestDir::new("creatable-ignored");
        let root = t.dir("root");
        let nm = t.dir("root/node_modules");
        let deeper = t.dir("root/node_modules/pkg");

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        for p in [&nm, &deeper] {
            match g.check_creatable(p) {
                Err(Denied::UnusableParent { .. }) => {}
                other => panic!("{p:?} 应当 UnusableParent，实得 {other:?}"),
            }
        }
    }

    #[test]
    fn 可建_根目录自己叫_node_modules_仍然放行() {
        let t = TestDir::new("creatable-root-ignored");
        let root = t.dir("node_modules");

        let mut g = SessionGrants::new();
        let real = g.authorize_root(&root).unwrap();
        // ⚠️ 根自身豁免：否则"打开一个 node_modules 目录"就永远不能新建，是功能倒退
        assert_eq!(g.check_creatable(&root).unwrap(), real);
    }

    #[test]
    fn 可建_只靠_files_授权的父目录被拒() {
        let t = TestDir::new("creatable-files");
        let dir = t.dir("docs");
        let f = t.file("docs/a.md", "x");

        let mut g = SessionGrants::new();
        g.authorize_file(&f).unwrap();

        // ⭐ 单文件授权说的是"读这一份"，⛔ 不是"在这里造东西"
        match g.check_creatable(&dir) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应当 NotAuthorized，实得 {other:?}"),
        }
    }

    #[test]
    fn 可建_父路径是文件归_not_found() {
        let t = TestDir::new("creatable-file-parent");
        let root = t.dir("root");
        let f = t.file("root/a.md", "x");

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        match g.check_creatable(&f) {
            Err(Denied::NotFound { .. }) => {}
            other => panic!("应当 NotFound，实得 {other:?}"),
        }
    }

    #[test]
    fn 可建_不存在的父目录归_not_found() {
        let t = TestDir::new("creatable-missing");
        let root = t.dir("root");

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        match g.check_creatable(&root.join("no-such-dir")) {
            Err(Denied::NotFound { .. }) => {}
            other => panic!("应当 NotFound，实得 {other:?}"),
        }
    }

    #[test]
    fn 可建_根内软链可以当父目录_根外软链不行() {
        let t = TestDir::new("creatable-symlink");
        let root = t.dir("root");
        let inside = t.dir("root/real-sub");
        std::os::unix::fs::symlink(&inside, root.join("link-in")).unwrap();
        std::os::unix::fs::symlink("/etc", root.join("link-out")).unwrap();

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        // ⭐ 根内软链：canonicalize 后仍在 root 内，且那几段都是 Normal ⇒ 允许
        let ok = g.check_creatable(&root.join("link-in")).unwrap();
        assert_eq!(ok, fs::canonicalize(&inside).unwrap());

        // ⛔ 根外软链：与 `check_readable` 同口径 ⇒ NotAuthorized
        match g.check_creatable(&root.join("link-out")) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应当 NotAuthorized，实得 {other:?}"),
        }
    }

    // ── `design/0035` 的 `check_renamable` 判定矩阵（B5） ────────────

    /// 只判"`check_renamable` 给了哪个结论"，⛔ 不在这里改盘。
    fn renamable(g: &SessionGrants, p: &Path) -> Result<PathBuf, Denied> {
        g.check_renamable(p)
    }

    #[test]
    fn 改名_根内普通md允许且返回规范化路径() {
        let t = TestDir::new("ren-ok");
        let root = t.dir("root");
        let f = t.file("root/a.md", "x");
        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        let got = renamable(&g, &f).unwrap();
        assert_eq!(got, fs::canonicalize(&f).unwrap());
    }

    #[test]
    fn 改名_根自身被拒() {
        let t = TestDir::new("ren-root");
        let root = t.dir("root");
        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();
        match renamable(&g, &root) {
            Err(Denied::NotRenamable { reason: crate::error::RenameRefusal::NotMarkdown, .. }) => {}
            other => panic!("应当 NotRenamable{{NotMarkdown}}，实得 {other:?}"),
        }
    }

    #[test]
    fn 改名_只凭单文件授权的文件不能改名() {
        let t = TestDir::new("ren-single");
        let f = t.file("a.md", "x");
        let mut g = SessionGrants::new();
        g.authorize_file(&f).unwrap();
        // 授权本身成立（读得到）
        assert!(g.check_readable(&f).is_ok());
        match renamable(&g, &f) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应当 NotAuthorized，实得 {other:?}"),
        }
    }

    /// ⭐ `design/0035` B13 的**后端那一半**：换根之后，旧根里的路径不再可改名。
    ///
    /// ⚠️ 这里验的是**判据的位置**（唯一的校验入口先于任何写盘），⛔ 不是"复现了并发交错"：
    /// `rename_entry` 的判据、`renamex_np`、状态迁移在同一个 `Mutex<Session>` 闭包里，
    /// 而换根要拿同一把锁 ⇒ 要么改名先完成、要么换根先完成（那时这条判据就成立）。
    /// ⚠️ 实测的拒绝 kind 是 `not_authorized`，⛔ 不是设计 §3.6 写的 `Stale`——
    /// 后端**没有**前端"菜单打开那一刻"的代次可比较（签名里没有 `gen`），
    /// 它只能如实说"这个路径现在不在授权内"。保证（盘上一个字节都没动）不变；
    /// 差异登记在 `docs/design/0035` §10。
    #[test]
    fn 换根之后旧根内的路径不再可改名() {
        let t = TestDir::new("ren-swap");
        let root = t.dir("root");
        let other = t.dir("other");
        let f = t.file("root/a.md", "A");

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();
        assert!(renamable(&g, &f).is_ok());

        // 换根：`roots` 被**整体替换**（`authorize_root` 的既有语义）
        g.authorize_root(&other).unwrap();
        match renamable(&g, &f) {
            Err(Denied::NotAuthorized { .. }) => {}
            got => panic!("应当 NotAuthorized，实得 {got:?}"),
        }
        // ⭐ 判据在**唯一的校验入口**就挡住了 ⇒ 盘上两份都没动
        assert_eq!(fs::read(&f).unwrap(), b"A");
        assert!(!root.join("b.md").exists());
    }

    /// ⭐⭐ 这一条是本设计自查轮修掉的那个洞：`real` 已被 `canonicalize` 解掉链接，
    /// 软链判据**必须**打在请求路径上。
    #[test]
    fn 改名_根内软链指向根内文件也拒_symlink() {
        let t = TestDir::new("ren-link-in");
        let root = t.dir("root");
        let real = t.file("root/real.md", "x");
        let link = root.join("link.md");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();
        // ⚠️ 读是通过的（解链接后仍在 root 内）——所以拒绝必须来自第 ③ 步
        assert!(g.check_readable(&link).is_ok());
        match renamable(&g, &link) {
            Err(Denied::NotRenamable { reason: crate::error::RenameRefusal::Symlink, .. }) => {}
            other => panic!("应当 NotRenamable{{Symlink}}，实得 {other:?}"),
        }
    }

    #[test]
    fn 改名_指向根外的软链被拒() {
        let t = TestDir::new("ren-link-out");
        let root = t.dir("root");
        std::os::unix::fs::symlink("/etc/hosts", root.join("link.md")).unwrap();
        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();
        // 第 ① 步（check_readable）就会因解链接后落在根外而拒
        match renamable(&g, &root.join("link.md")) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应当 NotAuthorized，实得 {other:?}"),
        }
    }

    #[test]
    fn 改名_非markdown文件被拒() {
        let t = TestDir::new("ren-ext");
        let root = t.dir("root");
        let f = t.file("root/a.txt", "x");
        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();
        match renamable(&g, &f) {
            Err(Denied::NotRenamable { reason: crate::error::RenameRefusal::NotMarkdown, .. }) => {}
            other => panic!("应当 NotRenamable{{NotMarkdown}}，实得 {other:?}"),
        }
    }

    #[test]
    fn 改名_目录被拒() {
        let t = TestDir::new("ren-dir");
        let root = t.dir("root");
        let d = t.dir("root/sub");
        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();
        match renamable(&g, &d) {
            Err(Denied::NotRenamable { reason: crate::error::RenameRefusal::NotMarkdown, .. }) => {}
            other => panic!("应当 NotRenamable{{NotMarkdown}}，实得 {other:?}"),
        }
    }

    #[test]
    fn 改名_父链含忽略目录被拒() {
        let t = TestDir::new("ren-ignored");
        let root = t.dir("root");
        let f = t.file("root/node_modules/a.md", "x");
        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();
        // ⚠️ 读是通过的（忽略清单只影响树与新建），改名走父目录闸门 ⇒ 拒
        assert!(g.check_readable(&f).is_ok());
        match renamable(&g, &f) {
            Err(Denied::UnusableParent { .. }) => {}
            other => panic!("应当 UnusableParent，实得 {other:?}"),
        }
    }

    #[test]
    fn 改名_不存在的路径归_找不到() {
        let t = TestDir::new("ren-missing");
        let root = t.dir("root");
        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();
        match renamable(&g, &root.join("nope.md")) {
            Err(Denied::NotFound { .. }) => {}
            other => panic!("应当 NotFound，实得 {other:?}"),
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ⭐ 图片专用校验（`design/0036`）
    // ─────────────────────────────────────────────────────────────────────

    /// 单文件授权 ⇒ 同目录及其子树里的图片可读，而**主授权面一点都不放宽**。
    ///
    /// ⚠️ 后半句是这条设计的全部理由：`check_readable` 仍必须拒绝同一张图。
    #[test]
    fn 图片_单文件授权的同目录与子目录可读_主授权面不放宽() {
        let t = TestDir::new("asset-sibling");
        let doc = t.file("docs/readme.md", "# hi");
        let pic = t.file("docs/pic.png", "png");
        let deep = t.file("docs/screenshots/a.png", "png");

        let mut g = SessionGrants::new();
        g.authorize_file(&doc).unwrap();

        assert_eq!(g.check_readable_asset(&pic).unwrap(), fs::canonicalize(&pic).unwrap());
        assert_eq!(g.check_readable_asset(&deep).unwrap(), fs::canonicalize(&deep).unwrap());

        // ⭐ 主授权面（树 / 搜索 / 打开文档）**原样**：只认那一个文件
        assert!(g.check_readable(&doc).is_ok());
        assert!(matches!(g.check_readable(&pic), Err(Denied::NotAuthorized { .. })));
        assert!(matches!(g.check_readable(&deep), Err(Denied::NotAuthorized { .. })));
    }

    /// 父目录的**兄弟目录**不算"同目录"（`../outside`）。
    #[test]
    fn 图片_父目录之外的兄弟目录仍被拒() {
        let t = TestDir::new("asset-outside");
        let doc = t.file("docs/readme.md", "# hi");
        let outside = t.file("outside/pic.png", "png");

        let mut g = SessionGrants::new();
        g.authorize_file(&doc).unwrap();

        match g.check_readable_asset(&outside) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应当 NotAuthorized，实得 {other:?}"),
        }
        // `../outside/pic.png` 也没用：先规范化再比前缀
        let sneaky = t.path.join("docs/../outside/pic.png");
        assert!(matches!(g.check_readable_asset(&sneaky), Err(Denied::NotAuthorized { .. })));
    }

    /// 前缀按路径分量比较：`/a/docs` 不含 `/a/docs2`。
    #[test]
    fn 图片_名字前缀相似的目录不算同目录() {
        let t = TestDir::new("asset-prefix");
        let doc = t.file("docs/readme.md", "# hi");
        let other = t.file("docs2/pic.png", "png");

        let mut g = SessionGrants::new();
        g.authorize_file(&doc).unwrap();

        assert!(matches!(g.check_readable_asset(&other), Err(Denied::NotAuthorized { .. })));
    }

    /// 软链仍被 `canonicalize` 解掉：`docs/pic.png → /etc/passwd` 落在同目录之外。
    #[test]
    fn 图片_同目录里的软链逃逸仍被拒() {
        let t = TestDir::new("asset-symlink");
        let doc = t.file("docs/readme.md", "# hi");
        std::os::unix::fs::symlink("/etc/passwd", t.path.join("docs/pic.png")).unwrap();

        let mut g = SessionGrants::new();
        g.authorize_file(&doc).unwrap();

        match g.check_readable_asset(&t.path.join("docs/pic.png")) {
            Err(Denied::NotAuthorized { .. }) => {}
            other => panic!("应当 NotAuthorized，实得 {other:?}"),
        }
    }

    /// 目录模式没有"单文件父目录"这条放宽：仍然只认 `roots`。
    #[test]
    fn 图片_目录模式仍只认授权根() {
        let t = TestDir::new("asset-root-only");
        let root = t.dir("root");
        let inside = t.file("root/pic.png", "png");
        let outside = t.file("outside/pic.png", "png");

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();

        assert!(g.check_readable_asset(&inside).is_ok());
        assert!(matches!(g.check_readable_asset(&outside), Err(Denied::NotAuthorized { .. })));
    }
}
