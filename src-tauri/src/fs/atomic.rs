//! 同目录**原子替换**写盘（`design/0076` §2.1.6，从 `commands/edit.rs` 抽出）。
//!
//! # 为什么它是独立模块
//!
//! `design/0012` 的保存与 `design/0076` 的 HTML 导出要的是**同一个**写盘形态：
//! 同目录临时文件 → `create_new` ＋ `write_all` → 设权限 → `rename`。
//! 两处各抄一份的代价不是"重复几行"，而是**语义会漂**——某天有人只给导出加了
//! `fsync`，或只把临时文件名的长度上限改掉，另一处就静默地不同了。
//! ⭐ 所以这里只有**一份实现**，`commands/edit.rs` 的保存也改成调它。
//!
//! # 三条与 `design/0012` §2.4 逐字相同的口径
//!
//! 1. **必须同目录**：`rename` 只在同一个文件系统内是原子的，而 `/tmp` 很可能是另一个卷。
//! 2. **`create_new(true)` 而不是 `create(true)`**：后者会**悄悄截断**一个已存在的同名文件。
//!    虽然那个名字理论上只有我们能产生（`pid` ＋ 单调计数器 ＋ 纳秒），
//!    但"理论上不会撞"不是不检查的理由——撞上就是删掉别人的文件。
//! 3. ⭐ **不留下 `*.rmd-tmp-*` 残骸**（`INV-EDIT-05`）：任何一步失败都删临时文件，
//!    原目标此刻**一个字节没变**（我们只碰过 tmp），失败是"什么都没发生"。
//!
//! ⚠️ **不做 `sync_all`**（`design/0012` §6 明写接受）：`fsync` 的代价在大文件上
//! 不可忽略，而 `.md` 与导出的 HTML 都不是事务日志。⚠️ 磁盘满仍然能在 `write_all`
//! 上被抓住（`File` 是无缓冲的，`ENOSPC` 当场返回）——省掉的只是"崩溃时的持久性"。
//!
//! ⚠️ 本模块**不依赖 Tauri**：`make test`（默认构建）要能直测它。
//! 默认构建里除测试外没有使用者 ⇒ 统一豁免 `dead_code`（与 `fs/mod.rs` 不 re-export 同一条理由）。

#![cfg_attr(not(feature = "gui"), allow(dead_code))]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 临时文件路径：`<同目录>/<name>.rmd-tmp-<pid>-<seq>-<ns>`。
///
/// ⚠️ **必须同目录**：`rename` 只在同一个文件系统内是原子的，而 `/tmp` 很可能是另一个卷。
/// ⚠️ 三段随机化（pid ＋ 进程内单调计数 ＋ 纳秒）是为了"同一进程内两次写"与
/// "两个 rmd 实例同时写同一份文件"都不撞。
/// ⚠️ 原文件名**截断到 100 字符**：文件名上限（macOS/Linux 都是 255 字节）是按**字节**算的，
/// 一个 250 字节的中文长文件名再拼上后缀就会 `ENAMETOOLONG`——
/// 那会表现为"这个文件莫名其妙存不了"，而真正的原因是我们的文件名拼得太长。
pub(crate) fn tmp_path(target: &Path) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let ns = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let name = target.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let short: String = name.chars().take(100).collect();
    target.with_file_name(format!("{short}.rmd-tmp-{}-{n}-{ns}", std::process::id()))
}

/// 把 `bytes` **原子地**写进 `target`。
///
/// `mode`：
/// - `Some(m)` ⇒ 目标**已存在**，沿用它原来的权限位（`m` 只取低 12 位）；
/// - `None` ⇒ 目标**是新建**，落成 `0o600`（与文档写盘同一档，不新开策略）。
///
/// ⚠️ 先按 `0600` 建，**再** `set_permissions`：反过来的话，从建文件到改权限
/// 那一瞬里，临时文件比原文件**更宽**（原文件可能是一份 `0600` 的私密笔记）。
/// ⛔ 这个窗口只有微秒级，但它是一条**内容泄露**的窗口，而修它不要钱。
///
/// ⚠️ 失败时**删除临时文件**再把原错误回给调用方；⛔ 不把 `remove_file` 的错误
/// 盖在原始失败上（清理失败意味着"多了一份残骸"，而真正该说的是写盘为什么失败）。
pub(crate) fn replace_atomic(target: &Path, bytes: &[u8], mode: Option<u32>) -> std::io::Result<()> {
    let tmp = tmp_path(target);
    let wrote = write_tmp(&tmp, bytes, mode).and_then(|()| std::fs::rename(&tmp, target));
    if let Err(e) = wrote {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// 建临时文件并写入 ＋ 按 `mode` 设权限位。
fn write_tmp(tmp: &Path, bytes: &[u8], mode: Option<u32>) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(tmp)?;
    f.write_all(bytes)?;
    drop(f);

    #[cfg(unix)]
    if let Some(m) = mode {
        use std::os::unix::fs::PermissionsExt;
        // ⚠️ 只取权限位：`metadata.permissions().mode()` 可能带着文件类型位，
        //    把它原样喂给 `chmod` 虽然通常被忽略，但那是靠平台行为，⛔ 不靠它。
        std::fs::set_permissions(tmp, std::fs::Permissions::from_mode(m & 0o7777))?;
    }
    // 非 unix：没有"权限位"这东西，`mode` 只表示"目标已存在"这一事实（无需动作）。
    #[cfg(not(unix))]
    let _ = mode;

    Ok(())
}

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
            let base = std::env::temp_dir().join(format!("rmd-atomic-{}-{tag}", std::process::id()));
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

    /// 目录里还剩几个 `*.rmd-tmp-*`（`INV-EDIT-05` 的判据）。
    fn 残骸数(dir: &Path) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".rmd-tmp-"))
            .count()
    }

    #[test]
    fn 替换新建文件_内容正确且权限是_0600() {
        let t = TestDir::new("new");
        let p = t.path.join("a.html");
        replace_atomic(&p, b"hello", None).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"hello");
        assert_eq!(残骸数(&t.path), 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&p).unwrap().permissions().mode() & 0o7777;
            assert_eq!(mode, 0o600, "新建文件必须是 0600（与文档写盘同一档）");
        }
    }

    #[test]
    fn 替换已有文件_沿用原权限位() {
        let t = TestDir::new("keep-mode");
        let p = t.path.join("a.md");
        fs::write(&p, b"old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();
        }
        replace_atomic(&p, b"new", Some(0o640)).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"new");
        assert_eq!(残骸数(&t.path), 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&p).unwrap().permissions().mode() & 0o7777;
            assert_eq!(mode, 0o640, "已有文件的权限位必须原样继承");
        }
    }

    #[test]
    fn 目标不存在时替换成功且不碰别的东西() {
        let t = TestDir::new("sibling");
        let other = t.path.join("keep.txt");
        fs::write(&other, b"keep").unwrap();
        let p = t.path.join("a.html");
        replace_atomic(&p, b"x", None).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"x");
        assert_eq!(fs::read(&other).unwrap(), b"keep", "替换只许动目标");
        assert_eq!(残骸数(&t.path), 0);
    }

    /// ⭐ `INV-EDIT-05`：失败路径**不留临时文件**，且目标保持原样。
    ///
    /// ⚠️ 用"目标的父目录不存在"制造失败：它在任何用户下都必然失败，
    /// 不依赖 root 是否无视 `0555`（`edit.rs` 那两条只读用例要靠跳过来兜底）。
    #[test]
    fn 失败时不留残骸() {
        let t = TestDir::new("fail");
        let missing_parent = t.path.join("nope");
        let p = missing_parent.join("a.html");
        let err = replace_atomic(&p, b"x", None).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound, "失败原因要原样回给调用方");
        assert_eq!(残骸数(&t.path), 0, "失败路径不许留下 *.rmd-tmp-*");
        assert!(!p.exists());
    }

    /// 临时文件名：同目录、带 `rmd-tmp` 三段、原名截到 100 字符。
    #[test]
    fn 临时文件名形如_同目录的_rmd_tmp() {
        let t = TestDir::new("tmp-name");
        let long = "中".repeat(300);
        let p = t.path.join(format!("{long}.md"));
        let tmp = tmp_path(&p);
        assert_eq!(tmp.parent(), Some(t.path.as_path()), "临时文件必须与目标同目录");
        let name = tmp.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.contains(".rmd-tmp-"), "{name}");
        // 三段：pid / seq / ns
        assert!(name.rsplit(".rmd-tmp-").next().unwrap().split('-').count() >= 3, "{name}");
        // 原名截到 100 字符（按字符，不是字节）
        let short: String = name.chars().take(100).collect();
        assert_eq!(short, "中".repeat(100), "原名必须截到 100 字符");
    }
}
