//! `rmd` 原型入口。
//!
//! **同一个二进制，两个模式**（`docs/design/0002` §3）：
//! - 带子命令 → CLI：`rmd probe …` / `rmd bench …`
//! - 不带子命令、给一个文件 → GUI：`rmd <文件>`
//!
//! ⛔ 两个模式**共用** `document::` 下的同一份解析实现（`INV-SINGLE-01`）。
//! 各写一份的话，两边的性能数字不可比，而"口径一致"是这个原型存在的全部理由。
//!
//! ⚠️ `gui` 模块在 `--features gui` 之外**根本不存在**——这样
//! `rmd probe` / `rmd bench` / `cargo test` 都不必编译整棵 Tauri 依赖树。
//!
//! ⭐ 但 `fs` / `error` / `config` / `external` **不门控**（`design/0003` §5 `INV-FS-01`）：
//! `check_readable` 的判定矩阵是授权边界的**唯一自动化防线**，
//! 而 `make test` 跑的是**不带 gui** 的默认构建——把它门控掉等于那条防线没有测试。
//! `external` 同理（`design/0006` §3）：它的 argv 构造是 `INV-EXT-01`（命令注入）的落点，
//! 只有 notify/AppHandle 那一半才需要 `--features gui`。

// ⭐ `design/0016`：本机日志。⚠️ **⛔ 不门控到 `--features gui`**——
// `external.rs` / `config/mod.rs` 在默认构建里也要能调用 `diag_stderr!`（它只是 eprintln），
// 而 `diag!` 在**未初始化**时只写 stderr，所以 `cargo test` / CLI 的行为逐字不变。
// ⚠️⚠️ **`#[macro_use]` 不能省**：`diag!` / `diag_stderr!` / `diag_file!` 是裸名字调用，
//    而 `#[macro_export]` 只把它们放到 crate 根（要用 `crate::diag!` 那样的路径）；
//    少了这一行，`config/` / `external.rs` 会报 "cannot find macro"。
#[macro_use]
mod logging;

mod cli;
mod config;
mod document;
mod error;
mod external;
mod fs;

// ⭐ `design/0025`：界面语言的**唯一裁定点**。
// ⚠️ **⛔ 不门控**，理由与上面 `fs`/`error`/`config`/`external` 逐字同源：
//    `make test` 跑的是**不带 gui** 的默认构建，而 `resolve` / `parse_apple_languages`
//    那张真值表是"中文系统首启是不是中文界面"的**唯一**自动化防线
//    （评审 #2 那个坑就是三段标签解析不出来）⇒ 门控掉等于那条防线没有测试。
// ⚠️ 需要 `AppHandle` 的那半（菜单重贴、`set_language`）仍在 `gui/mod.rs`。
mod lang;

// ⭐ `design/0026`：文档内链接的**分类 / 编码 / 系统唤起**。
// ⚠️ **⛔ 不门控**，理由同上：`is_app_entry`（导航闸门）、`classify`、`browser_argv`
//    （`INV-LINK-01`/`04`/`09`）是这一族安全判定的**唯一自动化防线**，
//    而 `make test` 跑的是不带 gui 的默认构建。⚠️ 需要 Tauri/文件系统的两半
//    （`commands/link.rs` 与 `gui/mod.rs` 的两条 handler）仍在 `--features gui` 下。
mod link;

// ⭐ `design/0033`：应用内安装命令行工具。
// ⚠️ **⛔ 不门控**（`INV-CLI` 那一族）：所有权判定 `shape()`、写盘前的包名判据
//    `target_ok()`、探测协议 `parse_probe`/`classify_with`、提权命令构造
//    `osascript_args` 都是安全判据，而 `make test` 跑的是不带 gui 的默认构建
//    ⇒ 门控掉等于这一族一条测试都跑不到（`INV-LINK-09` 同族）。
//    ⚠️ 需要菜单/原生框/`emit` 的那半在 `gui/mod.rs`。
// ⚠️ `allow(dead_code)` 只因为**默认构建里 IO 那半只被单测调用**（`install`/`uninstall`/
//    `osascript_args` 的产品调用点在 `gui/mod.rs`，那是 `--features gui`）。
#[allow(dead_code)]
mod cli_tool;

#[cfg(feature = "gui")]
mod commands;

#[cfg(feature = "gui")]
mod gui;

fn main() {
    // ⭐ `design/0016` §7.2 第 9 条的验证通道：**任何 CLI 解析之前**。
    // ⚠️ 它⛔ 不是第二条产品入口——不设这个变量时行为与今天逐字相同；
    // 设置时只初始化 Sink、写若干行、退出 0，⛔ 不建窗口、不读文档。
    // ⚠️ 每行带 pid ⇒ 两个并发进程各自的标记都能在轮转后的文件里找回来。
    if let Some(dir) = std::env::var_os("RMD_LOG_TEST_DIR") {
        let lines: usize = std::env::var("RMD_LOG_TEST_LINES")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let pad = "x".repeat(512);
        let _ = logging::init(&std::path::PathBuf::from(dir));
        for i in 0..lines {
            diag!("RMD_LOG_TEST pid={} i={} {}", std::process::id(), i, pad);
        }
        std::process::exit(0);
    }
    std::process::exit(cli::run());
}
