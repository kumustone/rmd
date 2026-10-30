//! `fs` —— 文件系统的**读取**侧 ＋ 一条**受控的新建**路径。
//!
//! ⛔ `INV-FS-02`：本模块**不为树提供写操作入口**。文件树仍是只读的
//! （不重命名 / 不删除 / 不移动，`design/0003` §4）。
//!
//! ⭐ **两个受控的写入口**：[`create`]（`design/0034`）与 [`rename`]（`design/0035`）。
//! 前者只写**父目录下一个新名字**（`create_new` / `create_dir`），后者只做
//! **同目录内的一次原子改名**（`renamex_np(..., RENAME_EXCL)`）。
//! ⛔ 两者都不接受删除 / 移动，⛔ 都不覆盖已有条目。⚠️ `INV-FS-02` 的原文已在
//! `design/0006`/`features` 里原地标注过（`INV-EXT-02` 的同一批），此处只补模块级说明，
//! ⛔ 没删任何旧约束。
//!
//! 五个子模块各管一件事：
//!
//! | 模块 | 管什么 |
//! |---|---|
//! | [`grants`] | ⭐ **会话授权 + 唯一的校验入口** `check_readable`（安全核心）＋ `check_creatable` ＋ `check_renamable` |
//! | [`tree`] | 单层扫描、三集合过滤、缓存 |
//! | [`order`] | 排序（目录在前 + Finder 那套自然排序） |
//! | [`create`] | ⭐ 名字判据（唯一一份）＋ 原子创建 ＋ 创建后复核（`design/0034`） |
//! | [`rename`] | ⭐ 原子"不覆盖"改名 ＋ errno 映射（`design/0035`） |
//!
//! ⚠️ 五者都**不依赖 Tauri**——`make test`（默认构建，不带 `gui`）要能跑
//! `check_readable` 的判定矩阵与名字矩阵，那是 `INV-FS-01` / `INV-TREE-07`
//! 唯一的自动化防线。

pub mod create;
pub mod grants;
pub mod order;
pub mod rename;
pub mod tree;

/// ⭐ **自写指纹**：`(字节数, mtime 纳秒)`（`design/0012` §2.1 ④）。
///
/// # 为什么它有**两个**调用点，而这两个必须是同一个实现
///
/// | 调用点 | 干什么 |
/// |---|---|
/// | `commands/edit.rs` 保存的**第三段** | **登记**刚写下去的那份的指纹 |
/// | `external.rs::watch` 的回调 | 事件到达时**比对**：相等 ⇒ 这次事件是自己写的 |
///
/// ⚠️ 两边只要有一处换了口径（一处用秒、一处用纳秒；一处 `metadata`、
/// 一处 `symlink_metadata`），判据就**永远不成立**——而它的表现是
/// "自己保存后也触发一次自动重载"，看起来像 FSEvents 的怪癖，不像是 bug。
/// ⇒ 所以本函数是本项目里这两样东西的**唯一定义**。
///
/// # 口径
///
/// - mtime 取**纳秒**（`i64`）：秒级分辨率下"同一秒内两次写"会撞，
///   而 §2.1 ④b 那句"碰撞概率极低"的前提正是纳秒。
///   ⚠️ 2026 年的纳秒时间戳约 `1.8e18`，`i64` 上限 `9.2e18` ⇒ 装得下。
/// - ⛔ **不是** `symlink_metadata`：这里要的是"读出来的那份内容"的身份，
///   而打开路径上 `check_readable` 已经 canonicalize 过一次了。
///
/// # 为什么返回 `Option` 而不是 `Result`
///
/// 两个调用点遇到"stat 不出来"时该做的事**恰好相同**：**不登记 / 不认为相等**，
/// 于是事件落回"当外部修改"那一侧。⭐ 那是**安全的一侧**
/// （最坏是多一次无谓的重载，⛔ 不是"漏掉一次外部修改"）。
/// 拿一个 `Result` 回来只会让两个调用点各写一遍 `if let Err(_) => 忽略`。
///
/// ⚠️ `INV-FS-02` 不受影响：这是一次**读** stat，本模块仍然没有任何写入口
/// （真正的写只在 `commands/edit.rs`）。
///
/// ⚠️ `#[cfg(feature = "gui")]` 不是装饰：两个调用点都在 gui 门控之下，
/// 而本文件在**默认构建**（`make test`）里也编译——不加这一行，
/// bin crate 会因为"没有任何使用者"报 `dead_code`（与上面那段注释同一条理由）。
#[cfg(feature = "gui")]
pub fn finger(path: &std::path::Path) -> Option<(u64, i64)> {
    let m = std::fs::metadata(path).ok()?;
    let len = m.len();
    let mtime_ns = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i64)
        // ⚠️ 时间戳取不到 ⇒ `0`：它仍然是一个**确定**的值，
        //    比"跳过登记 / 当作相等"都好——两个调用点都把它当普通值比对。
        .unwrap_or(0);
    Some((len, mtime_ns))
}

// ⚠️ 这里**刻意不做** `pub use` 再导出。理由不是洁癖：
//    `commands/` 只在 `--features gui` 下编译，而 `make test`（默认构建）
//    不带 gui。若这里再导出，默认构建下这些名字**没有任何使用者** →
//    bin crate 会报 `unused_imports`（lib crate 才不报）。
//    ⇒ 引用方一律写全路径（`crate::fs::grants::SessionGrants`），
//    两种构建下都干净。
