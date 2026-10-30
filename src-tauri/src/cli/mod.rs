//! CLI 入口。**只做参数解析与分发**，不带任何业务逻辑——
//! 解析逻辑全在 `crate::document`，这样 GUI 与 CLI 共用同一份（`INV-SINGLE-01`）。

mod bench;
mod probe;

use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "rmd",
    version,
    about = "rmd —— macOS 优先的只读 Markdown 阅读器（性能原型）",
    long_about = "只读、不做编辑。原型阶段的唯一目的：用实测数字回答 \
                  「大文档到底要不要分块渲染」。见 docs/design/0002。"
)]
struct Cli {
    /// 要打开的文件。**给路径 = 进 GUI**（`design/0002` §10.4 批 1）。
    ///
    /// ⚠️ 这是 **GUI 唯一的读盘入口**：路径只从 argv 来，
    /// `open_document` 命令**不接路径参数**——见 `gui` 模块头第 1 条。
    #[arg(value_name = "文件")]
    path: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Debug, Subcommand)]
enum Cmd {
    /// 步骤 0 · 技术风险先行：复现 comrak 的位置粒度、量 `data-sourcepos` 的
    /// HTML 膨胀、校验 (行,列) → 全局字节偏移 的换算。
    Probe(probe::ProbeArgs),

    /// 步骤 1 · CLI 基准：读盘 / 解析 / 渲染 的耗时与内存。
    Bench(bench::BenchArgs),
}

/// macOS 经 LaunchServices 启动时，历史上可能塞进 `-psn_0_12345` 这种
/// 进程序列号参数（10.9 之后新 SDK 基本不再传，但系统的行为不是合同）。
///
/// ⚠️ clap 见到它会**直接报错退出**——表现是"双击图标没反应、stderr 一行 usage"。
/// ⇒ 解析前过滤掉。⛔ 这不是"支持一个新参数"，只是不让系统参数打断启动。
///
/// ⭐ `design/0022` 起**两处共用这一份**：CLI 解析前（这里）与自我分离时给子进程
/// 拼的 argv（`gui::child_args`）。⛔ 别在 `gui` 里抄第二份——抄了就会与 CLI 分叉。
pub(crate) fn is_system_arg(a: &std::ffi::OsStr) -> bool {
    a.to_string_lossy().starts_with("-psn_")
}

/// 跑起来。返回进程退出码。
pub fn run() -> i32 {
    let cli = Cli::parse_from(
        std::env::args_os().filter(|a| !is_system_arg(a)),
    );
    match (cli.cmd, cli.path) {
        // 子命令优先：`rmd bench x.md` 里的 `x.md` 是 bench 自己的参数
        (Some(Cmd::Probe(a)), _) => probe::run(&a),
        (Some(Cmd::Bench(a)), _) => bench::run(&a),
        (None, path) => gui_or_usage(path),
    }
}

/// 没有子命令、也没有文件 = 用法提示。
///
/// ⚠️ **故意**报错退出而不是"什么都不做"：静默成功会让人以为窗口起来了。
///
/// ⚠️ 带 `gui` feature 时它用不到（裸跑会去起窗口），但**必须留着**：
/// 不带 `gui` 的构建（`make build`、`cargo test`）里它就是"不带参数"的答复，
/// 而那正是**默认**构建——删掉它会让默认构建下的 `rmd` 什么都不打印就退 2。
#[cfg_attr(feature = "gui", allow(dead_code))]
fn usage() -> i32 {
    eprintln!("rmd —— 只读 Markdown 阅读器（性能原型）");
    eprintln!();
    eprintln!("用法：");
    eprintln!("  rmd <文件>   打开一个窗口（批 1，需要 --features gui 构建）");
    eprintln!("  rmd <目录>   打开目录并在侧边栏显示文件树（批 3，`design/0003`）");
    eprintln!("  rmd          不带参数 = 空窗口，从里面选目录（批 3）");
    eprintln!("  rmd probe    步骤 0 · 技术风险先行");
    eprintln!("  rmd bench    步骤 1 · CLI 基准");
    eprintln!();
    eprintln!("⚠️ 以上 GUI 三条都需要 --features gui 构建（make build-gui）。");
    2
}

/// 进 GUI 模式（有参数 = 打开它，没参数 = 空会话）。
#[cfg(feature = "gui")]
fn gui_or_usage(path: Option<PathBuf>) -> i32 {
    crate::gui::run(path)
}

/// 没编 GUI feature 时的诚实失败。
///
/// ⚠️ 这条**必须保留**：`cargo build` 默认不带 `gui`，
/// 若这里静默返回 0，用户会以为"跑成功了只是没窗口"。
/// 而 `make dev` 用的正是带 `--features gui` 的那条命令。
#[cfg(not(feature = "gui"))]
fn gui_or_usage(path: Option<PathBuf>) -> i32 {
    match path {
        None => usage(),
        Some(path) => {
            eprintln!("⛔ 这个二进制没有编译 GUI（design/0002 §10.4 批 1）。");
            eprintln!("   收到的文件：{}", path.display());
            eprintln!();
            eprintln!("   请用带 gui feature 的构建：");
            eprintln!("     make dev FILE=<文件>");
            eprintln!("   或：cargo run --release --features gui -- <文件>");
            eprintln!();
            eprintln!("   （CLI 子命令不受影响：rmd probe / rmd bench 照常可用）");
            2
        }
    }
}
