//! 重命名（`design/0035` §3.3）：**一次**原子的"不覆盖"改名。
//!
//! # 三条结构性规则
//!
//! 1. ⭐ **存在性与改名是同一次系统调用**（`INV-RENAME-01`）：
//!    `renamex_np(src, dst, RENAME_EXCL)`。⛔ `exists()` + `rename()` 冒充安全实现——
//!    前者是 TOCTOU，后者（`std::fs::rename`）在 Unix 上**会静默覆盖**目标。
//! 2. ⛔ **不退化**：底层报 `ENOTSUP` / `EINVAL`（网络卷 / 非 APFS 的实现差异）时
//!    如实说「这个位置不支持安全改名」，**不许**改调 `std::fs::rename` 兜底——
//!    那一步会把"不覆盖"这条判据**静默丢掉**（§3.3.5）。
//! 3. ⛔ **没有任何「改回去」的代码路径**（`INV-RENAME-05`）。FS 成功之后
//!    只有"降级"（`degraded`），没有"回滚"：并发期间别人可能已经建出了同名条目，
//!    反向改名会撞上它（§3.3.6 / §3.6）。
//!
//! ⚠️ 本模块**不依赖 Tauri**：`make test`（默认构建）要能跑 errno 映射与真卷上的改名。
//! ⚠️ 它确实**是写入口**——`fs` 模块的第二个例外（`design/0035` §4 已登记）；
//! `INV-FS-02` 的"`fs` 不为树提供写入口"仍成立：这里只服务**用户显式发起**的重命名，
//! ⛔ 不支持目录、批量、移动或撤销。
//!
//! # 一手依据
//!
//! | 依据 | 位置 |
//! |---|---|
//! | `RENAME_EXCL = 0x00000004` | macOS SDK `usr/include/sys/stdio.h:37` |
//! | `int renamex_np(const char *, const char *, unsigned int)`，macOS 10.12+ | 同文件 `:52` |
//! | `libc::renamex_np` / `libc::RENAME_EXCL` | `libc-0.2.190/src/unix/bsd/apple/mod.rs:5009` / `:3552` |
//! | `libc` 是**直接依赖**（⛔ 不是"lock 里有就能用"） | `src-tauri/Cargo.toml` |

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use serde::Serialize;

use crate::error::Denied;

/// `degraded` 的一项：**FS 已成功、watcher 没能重启**（`design/0035` §3.6）。
pub const DEGRADED_WATCH: &str = "watch";
/// `degraded` 的一项：**FS 已成功、落点复核没能确认还在已授权根内**（§3.3.6）。
pub const DEGRADED_PATH_CHECK: &str = "path_check";

/// 改名成功后回给前端的东西。
///
/// ⚠️ `degraded` **不是失败通道**：空数组 = 全部完成；非空 = FS 成功但后续降级，
/// 界面必须把每一项说出来（`design/0035` §3.6，`INV-EXT-04` 同族）。
#[derive(Debug, Clone, Serialize)]
pub struct RenamedEntry {
    /// 新路径（**规范化后的父目录** + 最终名字）。
    pub path: String,
    /// 最终名字（可能被 `validate_name` 补过 `.md`）。
    pub name: String,
    /// 改之前的路径（前端用它迁移"当前文档"身份）。
    pub old_path: String,
    /// 改的是不是**当前打开的文档**（前端据此决定是否迁移 `currentPath`）。
    pub current_moved: bool,
    /// ⭐ 改名后**新监视的代号**（`0` = 没有迁移 / 新监视没起来）。
    ///
    /// ⚠️ 这一项是设计 §3.5 那张表的**必要补充**：后端在 `rename_entry` 里重启了
    /// watcher 并取了**新** `seq`，而前端的事件判据是 `ev.seq === state.watchSeq`
    /// （`reload.js::acceptEvent`）——不把新 `seq` 交回去，改名之后每一条事件都会被
    /// 判成"不是我这轮监视的"而**静默丢弃**，自动重载看起来"好好的"但再也不工作。
    /// ⇒ 由前端拿它覆盖 `watchSeq`，⛔ 不让前端再发一次 `watch_document`（那会起第二份监视）。
    pub watch_seq: u64,
    /// 降级项，取值只有 [`DEGRADED_WATCH`] / [`DEGRADED_PATH_CHECK`]。
    pub degraded: Vec<&'static str>,
}

/// ⭐ **改名后的落点复核**（`design/0035` §3.3.6）。
///
/// 与 [`create`](crate::fs::create) 的复核**看的是同一件事**（父链再 `canonicalize`
/// 一次、还在不在已授权根内），但**出路刻意相反**：那边可以删掉刚建的东西，
/// 这边 ⛔ 不能反向改名 ⇒ 复核失败只降级成 `degraded: ["path_check"]`，
/// ⛔ 不返回 `Denied`。
///
/// ⚠️ `false` 也涵盖"canonicalize 失败"（刚改完就被人删了 / 父链断了）——
/// 那同样属于"我们没法确认真实位置"，⛔ 不是"改名失败"。
pub fn still_inside(grants: &crate::fs::grants::SessionGrants, to: &Path) -> bool {
    std::fs::canonicalize(to).map(|p| grants.is_inside_roots(&p)).unwrap_or(false)
}

/// ⭐ **改名幂等判据**（`design/0035` §3.4）：最终名字（已过 `validate_name`）
/// 与旧名字**逐字节**相同 ⇒ 不碰磁盘，直接报成功。
///
/// ⚠️ 抽出来只为**可断言**：用户只敲主名（`note`）时 `validate_name` 会补成 `note.md`，
/// 与旧名相同——那一次不该算"改名"，也不该因为"目标已存在"被原子拒绝。
/// ⚠️ 比较在**补过 `.md` 之后**：`note` vs `note.md` 不是两个名字。
pub fn same_name(old_name: &str, final_name: &str) -> bool {
    old_name == final_name
}

/// ⭐ **唯一一次原子的"不覆盖"改名**。
///
/// ⚠️ 两个路径都必须是**已经被授权校验规范化**的那一份（调用方给 `real` 与
/// `parent.join(final_name)`）——本函数**不**做任何授权判断。
///
/// 返回的 [`Denied`] 只描述**盘上发生了什么**：
/// `EEXIST` ⇒ 目标被占（原子拒绝，⛔ 不覆盖）；`ENOENT` ⇒ 源已不在原处
/// （外部并发改名 / 删除）；`ENOTSUP` / `EINVAL` ⇒ 这个位置不支持安全改名。
pub fn rename_in(from: &Path, to: &Path) -> Result<(), Denied> {
    let src = cstring(from)?;
    let dst = cstring(to)?;
    // SAFETY: 两个指针都来自刚刚构造、且在本调用期间活着的 `CString`（以 NUL 结尾）；
    // `renamex_np` 只读这块内存，不保留指针。
    let rc = unsafe { libc::renamex_np(src.as_ptr(), dst.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    let errno = err.raw_os_error().unwrap_or(0);
    Err(map_errno(errno, from, &err.to_string()))
}

/// 路径 → `CString`。⚠️ 路径里有 NUL 时**不 panic**：归一次正常的读写失败。
fn cstring(path: &Path) -> Result<CString, Denied> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| Denied::io(path, "路径里有 NUL 字节"))
}

/// ⭐ **errno → `Denied` 的映射**（`design/0035` §3.3.4 那张表）。
///
/// ⚠️ 抽成纯函数是为了 B4b：`ENOTSUP` / `EINVAL` 那条分支**没法**在测试里
/// 稳定找出一块"不支持安全改名"的文件系统，但可以直接喂 errno。
/// ⛔ 这不改变判据——真实路径上 errno 仍然来自 `last_os_error()`。
///
/// ⚠️ `detail` 只在"其余"那一支用（底层错误文本）；前三种归到**既有变体**上，
/// ⛔ 不给同一个状态造第二套文案（`error.rs` 的 `AlreadyExists` / `NotFound` 早就有了）。
pub fn map_errno(errno: i32, path: &Path, detail: &str) -> Denied {
    match errno {
        libc::EEXIST => Denied::already_exists(path),
        libc::ENOENT => Denied::not_found(path),
        // ⚠️ 固定文案：这两条说的是"**这个位置**做不到"，⛔ 不是"本次读写失败"。
        //    绝不退化成 `std::fs::rename`（见模块头第 2 条）。
        libc::ENOTSUP | libc::EINVAL => Denied::io(path, "这个位置不支持安全改名"),
        _ => Denied::io(path, detail),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::grants::SessionGrants;
    use std::fs;
    use std::path::PathBuf;

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(tag: &str) -> Self {
            let base =
                std::env::temp_dir().join(format!("rmd-rename-{}-{tag}", std::process::id()));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(&base).unwrap();
            TestDir { path: fs::canonicalize(&base).unwrap() }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    // ── B4b：errno 映射 ────────────────────────────────────────────

    #[test]
    fn errno_映射_eeexist_归_目标已存在() {
        let e = map_errno(libc::EEXIST, Path::new("/r/b.md"), "File exists");
        assert!(matches!(e, Denied::AlreadyExists { .. }), "{e:?}");
    }

    #[test]
    fn errno_映射_enoent_归_找不到() {
        let e = map_errno(libc::ENOENT, Path::new("/r/a.md"), "No such file");
        assert!(matches!(e, Denied::NotFound { .. }), "{e:?}");
    }

    #[test]
    fn errno_映射_enotsup_与_einval_都是固定文案且不退化成普通_io() {
        for errno in [libc::ENOTSUP, libc::EINVAL] {
            match map_errno(errno, Path::new("/r/a.md"), "底层文本") {
                Denied::Io { message, .. } => {
                    assert_eq!(message, "这个位置不支持安全改名", "errno={errno}");
                }
                other => panic!("errno={errno} 期望 Io，实际 {other:?}"),
            }
        }
    }

    #[test]
    fn errno_映射_其余沿用底层错误文本() {
        match map_errno(libc::EACCES, Path::new("/r/a.md"), "Permission denied") {
            Denied::Io { message, .. } => assert_eq!(message, "Permission denied"),
            other => panic!("期望 Io，实际 {other:?}"),
        }
    }

    // ── 真卷上的改名（B2 / B3 / B4）──────────────────────────────

    #[test]
    fn 改到不存在的名字成功() {
        let t = TestDir::new("ok");
        let a = t.path.join("a.md");
        fs::write(&a, "内容").unwrap();
        let b = t.path.join("b.md");
        rename_in(&a, &b).unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read(&b).unwrap(), "内容".as_bytes());
    }

    #[test]
    fn 目标已存在时原子拒绝且两份内容都不变() {
        let t = TestDir::new("dup");
        let a = t.path.join("a.md");
        let b = t.path.join("b.md");
        fs::write(&a, "A").unwrap();
        fs::write(&b, "B").unwrap();
        let err = rename_in(&a, &b).unwrap_err();
        assert!(matches!(err, Denied::AlreadyExists { .. }), "{err:?}");
        // ⭐ 两份都原封不动：⛔ 没有被 `fs::rename` 那种覆盖式语义动过
        assert_eq!(fs::read(&a).unwrap(), "A".as_bytes());
        assert_eq!(fs::read(&b).unwrap(), "B".as_bytes());
    }

    #[test]
    fn 同名幂等_只敲主名也判成没改() {
        use crate::fs::create::{validate_name, CreateKind};
        // `validate_name` 会给不带后缀的名字补 `.md`——补完之后与旧名相同
        let finalized = validate_name("note", CreateKind::File).unwrap();
        assert_eq!(finalized, "note.md");
        assert!(same_name("note.md", &finalized), "`note` ⇒ `note.md` 是**没改**，⛔ 不该撞 AlreadyExists");
        let other = validate_name("other", CreateKind::File).unwrap();
        assert!(!same_name("note.md", &other));
        assert!(same_name("note.md", "note.md"));
    }

    #[test]
    fn 源不存在归_找不到() {
        let t = TestDir::new("missing");
        let err = rename_in(&t.path.join("nope.md"), &t.path.join("x.md")).unwrap_err();
        assert!(matches!(err, Denied::NotFound { .. }), "{err:?}");
    }

    #[test]
    fn 只改大小写成功且内容不变() {
        let t = TestDir::new("case");
        let lower = t.path.join("a.md");
        fs::write(&lower, "c").unwrap();
        let upper = t.path.join("A.md");
        // ⚠️ 本机根卷是 APFS、**大小写不敏感**（`design/0035` §3.3.5 实测）。
        //    在**敏感**卷上这条同样成立（两个不同的名字），所以它不挑卷——
        //    但它**只在不敏感卷上**才证明"只改大小写走一次调用能过"。
        rename_in(&lower, &upper).unwrap();
        assert_eq!(fs::read(&upper).unwrap(), "c".as_bytes());
    }

    /// ⭐ `renamex_np` 对软链移动的是**链接本身**（`design/0035` §3.3.4 实测表）。
    ///
    /// ⚠️ 这条测的是**底层事实**，⛔ 不是"允许改名软链"：产品路径上软链在
    /// `check_renamable` 第 3 步就被拒（判据打在**请求路径**上）。
    /// 记在这里是因为它解释了"为什么软链必须拒"——不拒的话用户以为改的是链接，
    /// 实际被搬走的是另一个位置上看得见的那一条。
    #[test]
    fn 底层对软链移动的是链接本身() {
        let t = TestDir::new("link");
        let real = t.path.join("real.md");
        fs::write(&real, "r").unwrap();
        let link = t.path.join("link.md");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let link2 = t.path.join("link2.md");
        rename_in(&link, &link2).unwrap();
        assert_eq!(fs::read(&real).unwrap(), "r".as_bytes(), "被指向的那份⛔ 不许被动");
        assert!(fs::symlink_metadata(&link2).unwrap().file_type().is_symlink());
    }

    /// ⭐ 授权对象只是为了让测试目录看起来像"真实调用现场"，⛔ 不参与 `rename_in` 判据。
    #[test]
    fn rename_in_不做授权判断() {
        let t = TestDir::new("nogrant");
        let a = t.path.join("a.md");
        fs::write(&a, "x").unwrap();
        let g = SessionGrants::new(); // 什么根都没授权
        assert!(!g.has_roots());
        rename_in(&a, &t.path.join("b.md")).unwrap();
    }

    // ── B17：落点复核是"降级判据"，⛔ 不是失败 ──────────────────────

    #[test]
    fn 落点复核_根内为真_根外与不存在都为假() {
        let t = TestDir::new("pathcheck");
        let root = t.path.join("root");
        fs::create_dir_all(&root).unwrap();
        let inside = root.join("a.md");
        fs::write(&inside, "x").unwrap();
        let outside = t.path.join("outside.md");
        fs::write(&outside, "x").unwrap();

        let mut g = SessionGrants::new();
        g.authorize_root(&root).unwrap();
        assert!(still_inside(&g, &inside));
        assert!(!still_inside(&g, &outside), "根外 ⇒ 降级，⛔ 不是改回去");
        assert!(!still_inside(&g, &root.join("gone.md")), "刚被删了 ⇒ 同样只是\"没法确认\"");
    }
}
