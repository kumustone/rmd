//! 新建文件 / 文件夹（`design/0034` §2.1 B）。
//!
//! # 三条结构性规则
//!
//! 1. **名字判据只有一份**，就在本文件的 [`validate_name`]。前端⛔ 不写第二份
//!    （`INV-TREE-07`）：输入行只负责提交 / 取消，错误文案全部来自后端返回的 `reason`。
//! 2. **存在性与创建是同一次系统调用**（`INV-FS-07`）：`create_new` / `create_dir`，
//!    ⛔ 不先 `exists()` 再创建（那是 TOCTOU，也是第二份存在性判据）。
//!    ⚠️ 它只保证**最终目标**不被覆盖，⛔ **不证明父链**在检查与创建之间没变（§4）。
//! 3. **创建后复核 containment**：父目录再 `canonicalize` 一次，出了 root 就报
//!    [`Denied::CreatedOutsideRoot`]，⛔ **不删除**已建条目——删它是第二条写路径，
//!    而且无法证明"删的就是我刚建的那个"。
//!
//! ⚠️ 本模块**不依赖 Tauri**：`make test`（默认构建）要能跑名字矩阵与创建路径。
//! ⚠️ 它确实**是写入口**——这是 `fs` 模块里唯一的例外，`design/0034` §4 已登记；
//! `INV-FS-02` 的"`fs` 不为树提供写入口"仍然成立：这里只服务**用户显式发起**的
//! 新建命令，⛔ 没有删除 / 重命名 / 移动。

use std::fs::OpenOptions;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{Denied, InvalidNameReason};
use crate::fs::grants::SessionGrants;
use crate::fs::tree::{self, Class};

/// 新建什么。⚠️ serde 枚举，⛔ 不是 `String`：未知值在 IPC 反序列化就失败
/// （前端归 `other`），⛔ 不"猜一个默认值"——猜成文件会造出用户没要的东西。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreateKind {
    File,
    Dir,
}

/// 创建成功后回给前端的东西。前端用 `path` 选中新行，用 `name` 显示最终名字
/// （⚠️ 可能被补过 `.md`）。
#[derive(Debug, Clone, Serialize)]
pub struct CreatedEntry {
    pub path: String,
    pub name: String,
    pub kind: CreateKind,
}

/// ⭐ **名字判据的唯一实现**。判定顺序即优先级（`design/0034` §2.1 B 那张表）。
///
/// 返回**最终落盘的名字**（文件可能被补 `.md`）。
///
/// ⚠️ 原样保留用户输入（⛔ 不 trim 后落盘）：只有"空不空"用 trim 判，
/// 前后空格是用户自己写的名字的一部分。
///
/// ⭐ `design/0040` 起 `ignore` 由调用方传入（来源 = `config.ignore_dirs`）：
/// 第 ⑥ 步"目录名不能叫忽略名"跟着配置走，⛔ 不再读常量。
pub fn validate_name(
    name: &str,
    kind: CreateKind,
    ignore: &[String],
) -> Result<String, Denied> {
    // ① 空 / 全空白
    if name.trim().is_empty() {
        return Err(Denied::invalid_name(name, InvalidNameReason::Empty));
    }
    // ② 路径分隔符、冒号（Finder 把它映射成 `/`）、NUL 与控制字符
    if name
        .chars()
        .any(|c| c == '/' || c == '\\' || c == ':' || c == '\0' || c.is_control())
    {
        return Err(Denied::invalid_name(name, InvalidNameReason::Separator));
    }
    // ③ `.` / `..`
    if name == "." || name == ".." {
        return Err(Denied::invalid_name(name, InvalidNameReason::Reserved));
    }

    // ④ 文件补后缀。⭐ 判据用 `tree::is_markdown`：`.MD` 已经是 markdown ⇒ ⛔ 不再补
    let final_name = match kind {
        CreateKind::File if !tree::is_markdown(name) => format!("{name}.md"),
        _ => name.to_string(),
    };

    // ⑤ 补完之后以 `.` 开头（树里根本不列点开头的条目）
    if final_name.starts_with('.') {
        return Err(Denied::invalid_name(name, InvalidNameReason::Hidden));
    }
    // ⑥ 目录名在忽略清单里（⚠️ 精确、大小写敏感，与树一致）
    if kind == CreateKind::Dir && matches!(tree::classify(&final_name, true, ignore), Class::Ignored) {
        return Err(Denied::invalid_name(name, InvalidNameReason::Ignored));
    }
    // ⑦ **补完之后**量长度：否则 255 字节的名字补成 256 字节，
    //    检查通过、`create_new` 在 IO 层报 ENAMETOOLONG，用户拿到一句 `io`。
    if final_name.len() > 255 {
        return Err(Denied::invalid_name(name, InvalidNameReason::TooLong));
    }

    Ok(final_name)
}

/// 在**已通过 [`SessionGrants::check_creatable`] 的**父目录里新建一项。
///
/// ⚠️ `parent` 必须是那个函数返回的**规范化路径**；本函数不再做授权判定
/// （那是第二条真值）。它只做三件事：创建、映射 `AlreadyExists`、复核 containment。
pub fn create_in(
    grants: &SessionGrants,
    parent: &Path,
    final_name: &str,
    kind: CreateKind,
) -> Result<CreatedEntry, Denied> {
    let target = parent.join(final_name);

    match kind {
        CreateKind::File => {
            // ⭐ 存在性与创建是同一次调用（`INV-FS-07`）
            match OpenOptions::new().write(true).create_new(true).open(&target) {
                Ok(_fh) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    return Err(Denied::already_exists(&target))
                }
                Err(e) => return Err(Denied::io(&target, e)),
            }
        }
        CreateKind::Dir => match std::fs::create_dir(&target) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(Denied::already_exists(&target))
            }
            Err(e) => return Err(Denied::io(&target, e)),
        },
    }

    // ⚠️ 复核：父链在 check 与 create 之间可能被换掉（本机进程就能做到）。
    //    ⛔ 失败/越界都**不删除**刚建的东西（见模块头第 3 条）。
    let parent_real = target.parent().and_then(|p| std::fs::canonicalize(p).ok());
    if parent_real.as_deref().is_none_or(|p| !grants.is_inside_roots(p)) {
        return Err(Denied::created_outside_root(&target));
    }

    Ok(CreatedEntry {
        path: target.display().to_string(),
        name: final_name.to_string(),
        kind,
    })
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
    use std::path::PathBuf;

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(tag: &str) -> Self {
            let base =
                std::env::temp_dir().join(format!("rmd-create-{}-{tag}", std::process::id()));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(&base).unwrap();
            TestDir { path: fs::canonicalize(&base).unwrap() }
        }

        fn dir(&self, rel: &str) -> PathBuf {
            let p = self.path.join(rel);
            fs::create_dir_all(&p).unwrap();
            p
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn reason(name: &str, kind: CreateKind) -> InvalidNameReason {
        match validate_name(name, kind, &ign()) {
            Err(Denied::InvalidName { reason, .. }) => reason,
            other => panic!("{name:?} 期望 InvalidName，实际 {other:?}"),
        }
    }

    // ── ① 空 / 空白 ──────────────────────────────────────────────

    #[test]
    fn 空串与全空白都归_empty() {
        for name in ["", " ", "   ", "\t", "\n"] {
            assert_eq!(reason(name, CreateKind::File), InvalidNameReason::Empty, "{name:?}");
            assert_eq!(reason(name, CreateKind::Dir), InvalidNameReason::Empty, "{name:?}");
        }
    }

    // ── ② 分隔符与控制字符 ──────────────────────────────────────

    #[test]
    fn 分隔符冒号控制字符都归_separator() {
        for name in ["a/b", "a\\b", "a:b", "a\0b", "a\nb", "a\tb", "../x", "a/../b"] {
            assert_eq!(reason(name, CreateKind::File), InvalidNameReason::Separator, "{name:?}");
        }
    }

    /// ⚠️ 这条是**边界**：空格不是控制字符，`a b` 是合法名字。
    #[test]
    fn 普通空格不是分隔符() {
        assert_eq!(validate_name("a b", CreateKind::File, &ign()).unwrap(), "a b.md");
    }

    // ── ③ 保留名 ────────────────────────────────────────────────

    #[test]
    fn 点与双点归_reserved() {
        assert_eq!(reason(".", CreateKind::File), InvalidNameReason::Reserved);
        assert_eq!(reason("..", CreateKind::Dir), InvalidNameReason::Reserved);
    }

    // ── ④ 后缀 ──────────────────────────────────────────────────

    #[test]
    fn 文件按_is_markdown_决定补不补后缀() {
        // 不是 markdown ⇒ 补
        assert_eq!(validate_name("notes", CreateKind::File, &ign()).unwrap(), "notes.md");
        assert_eq!(validate_name("a.txt", CreateKind::File, &ign()).unwrap(), "a.txt.md");
        // ⭐ 已经是 markdown（含大小写）⇒ ⛔ 不再补
        assert_eq!(validate_name("a.md", CreateKind::File, &ign()).unwrap(), "a.md");
        assert_eq!(validate_name("a.MD", CreateKind::File, &ign()).unwrap(), "a.MD");
        assert_eq!(validate_name("a.Md", CreateKind::File, &ign()).unwrap(), "a.Md");
        // 目录⛔ 不补
        assert_eq!(validate_name("notes", CreateKind::Dir, &ign()).unwrap(), "notes");
    }

    // ── ⑤ 隐藏 ──────────────────────────────────────────────────

    #[test]
    fn 补完之后点开头归_hidden() {
        assert_eq!(reason(".hidden", CreateKind::File), InvalidNameReason::Hidden);
        assert_eq!(reason(".git", CreateKind::Dir), InvalidNameReason::Hidden);
        // ⚠️ 补后缀不会把非隐藏变成隐藏；反过来也不会
        assert_eq!(reason("..x", CreateKind::File), InvalidNameReason::Hidden);
    }

    // ── ⑥ 忽略目录 ──────────────────────────────────────────────

    #[test]
    fn 忽略清单只挡目录且大小写敏感() {
        assert_eq!(reason("node_modules", CreateKind::Dir), InvalidNameReason::Ignored);
        assert_eq!(reason("target", CreateKind::Dir), InvalidNameReason::Ignored);
        // ⭐ 大小写敏感：`Target` 在树里是正常目录，这里也必须能建
        assert_eq!(validate_name("Target", CreateKind::Dir, &ign()).unwrap(), "Target");
        // ⭐ 同名的**文件**不受影响（树里 `node_modules.md` 是正常文件）
        assert_eq!(
            validate_name("node_modules", CreateKind::File, &ign()).unwrap(),
            "node_modules.md"
        );
    }

    // ── ⑦ 长度（补后缀之后量） ──────────────────────────────────

    #[test]
    fn 长度按补后缀之后算_边界两侧各一条() {
        // 252 + ".md" = 255 ⇒ 放行
        let ok = "a".repeat(252);
        assert_eq!(validate_name(&ok, CreateKind::File, &ign()).unwrap().len(), 255);
        // 253 + ".md" = 256 ⇒ 拒绝（⚠️ 前一步已经通过：253 字节本身没超 255）
        let bad = "a".repeat(253);
        assert_eq!(reason(&bad, CreateKind::File), InvalidNameReason::TooLong);
        // 目录不补后缀，255 放行、256 拒绝
        assert!(validate_name(&"a".repeat(255), CreateKind::Dir, &ign()).is_ok());
        assert_eq!(reason(&"a".repeat(256), CreateKind::Dir), InvalidNameReason::TooLong);
        // ⭐ 多字节按**字节**量：84 个汉字 = 252 字节 + 3 = 255 放行；85 个 = 258 拒绝
        assert!(validate_name(&"中".repeat(84), CreateKind::File, &ign()).is_ok());
        assert_eq!(reason(&"中".repeat(85), CreateKind::File), InvalidNameReason::TooLong);
    }

    // ── 创建路径 ────────────────────────────────────────────────

    fn grants_for(root: &Path) -> SessionGrants {
        let mut g = SessionGrants::new();
        g.authorize_root(root).unwrap();
        g
    }

    #[test]
    fn 新建文件是空文件且返回最终名字() {
        let t = TestDir::new("file");
        let root = t.dir("root");
        let g = grants_for(&root);
        let parent = g.check_creatable(&root, &ign()).unwrap();

        let r = create_in(&g, &parent, "notes.md", CreateKind::File).unwrap();
        assert_eq!(r.name, "notes.md");
        assert_eq!(r.kind, CreateKind::File);
        let p = PathBuf::from(&r.path);
        assert!(p.is_file());
        assert_eq!(fs::read(&p).unwrap(), b"", "新建的是空文件");
    }

    #[test]
    fn 新建目录是真的目录() {
        let t = TestDir::new("dir");
        let root = t.dir("root");
        let g = grants_for(&root);
        let parent = g.check_creatable(&root, &ign()).unwrap();

        let r = create_in(&g, &parent, "子目录", CreateKind::Dir).unwrap();
        assert!(PathBuf::from(&r.path).is_dir());
        assert_eq!(r.kind, CreateKind::Dir);
    }

    #[test]
    fn 同名第二次归_already_exists_且不覆盖() {
        let t = TestDir::new("dup");
        let root = t.dir("root");
        let g = grants_for(&root);
        let parent = g.check_creatable(&root, &ign()).unwrap();

        let r = create_in(&g, &parent, "a.md", CreateKind::File).unwrap();
        fs::write(&r.path, "原内容").unwrap();
        let err = create_in(&g, &parent, "a.md", CreateKind::File).unwrap_err();
        assert!(matches!(err, Denied::AlreadyExists { .. }), "{err:?}");
        // ⭐ 原子创建 ⇒ 原文件一个字节都没动
        assert_eq!(fs::read(&r.path).unwrap(), "原内容".as_bytes());
    }

    /// ⭐ 复核 branch 的**确定性**用例：故意越过 `check_creatable` 用一个根外父目录。
    ///
    /// ⚠️ 这**不是**"父链替换窗口"的复现（那件事没有稳定用例，`design/0034` §9.2
    /// 未闭合项 3 已如实登记）；它只证明**复核这一跳真的在看授权范围**。
    #[test]
    fn 复核发现根外父目录时归_created_outside_root() {
        let t = TestDir::new("outside");
        let root = t.dir("root");
        let outside = t.dir("outside");
        let g = grants_for(&root);
        // ⚠️ 绕过 grants 的父目录闸门，直接调 create_in：文件会先被建出来
        let err = create_in(&g, &outside, "x.md", CreateKind::File).unwrap_err();
        assert!(matches!(err, Denied::CreatedOutsideRoot { .. }), "{err:?}");
        // ⭐ **不删除**：文件在盘上，由用户自己判断
        assert!(outside.join("x.md").is_file(), "越界创建后⛔ 不许自动删除");
    }

    /// ⭐ `design/0040`：第 ⑥ 步"目录名不能叫忽略名"跟随**传入的**清单。
    #[test]
    fn 新建目录名跟随传入的清单() {
        let custom = vec!["vendor".to_string()];
        // 默认清单：node_modules 被拒、vendor 放行
        assert!(matches!(
            validate_name("node_modules", CreateKind::Dir, &ign()),
            Err(Denied::InvalidName { .. })
        ));
        assert_eq!(validate_name("vendor", CreateKind::Dir, &ign()).unwrap(), "vendor");
        // 自定义清单：反过来
        assert!(matches!(
            validate_name("vendor", CreateKind::Dir, &custom),
            Err(Denied::InvalidName { .. })
        ));
        assert_eq!(
            validate_name("node_modules", CreateKind::Dir, &custom).unwrap(),
            "node_modules"
        );
        // ⛔ 空清单：两个都放行；且**文件**永远不受清单影响
        assert_eq!(validate_name("vendor", CreateKind::Dir, &[]).unwrap(), "vendor");
        assert_eq!(
            validate_name("vendor", CreateKind::File, &custom).unwrap(),
            "vendor.md"
        );
    }
}
