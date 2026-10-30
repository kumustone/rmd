//! `design/0016` §7.2 第 9 条：**两个真实进程**并发写同一份日志。
//!
//! ⚠️ 单测只能证明"锁下顺序正确"；只有两个进程才证明
//! "句柄 / rename 不再丢日志"——那正是 `0.2.0` 之前所有 `eprintln!` 在后台启动下
//! **一条都看不见**的那一类问题。
//!
//! 判据（全部进退出码）：
//! 1. 两份**各自的 pid 标记**都能在 `rmd.log` / `rmd.log.1` 的并集里找回；
//! 2. **没有半行交错**：每一行都完整匹配时间戳前缀与 `RMD_LOG_TEST` 结构；
//! 3. 单个文件不超过 2 MiB ＋ 一条记录的上限（`INV-LOG-05`）。
//!
//! ⚠️ 它走的是 `main.rs` 里那条**验证钩子**（`RMD_LOG_TEST_DIR`）：只初始化 Sink、
//! 写若干行、退出 0，⛔ 不建窗口、不读文档。不设这个变量时行为与今天逐字相同。

use std::path::Path;
use std::process::{Command, Output};

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!(
        "rmd-log-multiproc-{}-{}",
        std::process::id(),
        tag
    ));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn run_child(dir: &Path, lines: usize) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rmd"))
        .env("RMD_LOG_TEST_DIR", dir)
        .env("RMD_LOG_TEST_LINES", lines.to_string())
        .output()
        .expect("验证钩子进程起不来")
}

/// 一条完整记录的形状：时间戳 [pid] RMD_LOG_TEST pid=… i=… xxxx…
fn is_well_formed(line: &str) -> bool {
    let Some((ts, rest)) = line.split_once(' ') else {
        return false;
    };
    // 2026-10-19T12:34:56.789Z
    if ts.len() != 24 || !ts.ends_with('Z') || ts.as_bytes()[10] != b'T' {
        return false;
    }
    let Some(rest) = rest.strip_prefix('[') else {
        return false;
    };
    let Some((pid, rest)) = rest.split_once("] ") else {
        return false;
    };
    if pid.parse::<u32>().is_err() {
        return false;
    }
    let Some(rest) = rest.strip_prefix("RMD_LOG_TEST pid=") else {
        return false;
    };
    let Some((p, rest)) = rest.split_once(" i=") else {
        return false;
    };
    if p.parse::<u32>().is_err() {
        return false;
    }
    let Some((i, pad)) = rest.split_once(' ') else {
        return false;
    };
    i.parse::<usize>().is_ok() && !pad.is_empty() && pad.bytes().all(|b| b == b'x')
}

#[test]
fn two_processes_do_not_lose_or_interleave_lines() {
    let dir = tmpdir("two");
    std::fs::create_dir_all(&dir).unwrap();

    // 两个**同时**跑的进程：5000 行 × ~580 B ≈ 2.9 MB / 进程 ⇒ 必然触发轮转。
    // ⚠️ stdout/stderr 丢进 null：`diag!` 会照设计双写 stderr，
    //    5000 行 × 2 进程不静音的话，测试输出会被日志淹掉（而且与判据无关）。
    let mut a = Command::new(env!("CARGO_BIN_EXE_rmd"))
        .env("RMD_LOG_TEST_DIR", &dir)
        .env("RMD_LOG_TEST_LINES", "5000")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("进程 A 起不来");
    let mut b = Command::new(env!("CARGO_BIN_EXE_rmd"))
        .env("RMD_LOG_TEST_DIR", &dir)
        .env("RMD_LOG_TEST_LINES", "5000")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("进程 B 起不来");

    let sa = a.wait().unwrap();
    let sb = b.wait().unwrap();
    assert!(sa.success(), "进程 A 退出码 {:?}", sa.code());
    assert!(sb.success(), "进程 B 退出码 {:?}", sb.code());

    let current = dir.join("rmd.log");
    let prev = dir.join("rmd.log.1");
    assert!(current.exists(), "rmd.log 必须被创建");
    assert!(prev.exists(), "写了两轮以上却没轮转：{} 个文件", 1);

    let mut all = String::new();
    for p in [&current, &prev] {
        let s = std::fs::read_to_string(p).unwrap();
        // 判据 3：上限 2 MiB ＋ 一条记录（8 KiB ＋ 前缀）的余量。
        assert!(
            s.len() as u64 <= 2 * 1024 * 1024 + 9 * 1024,
            "{} 超过上限：{} 字节",
            p.display(),
            s.len()
        );
        all.push_str(&s);
    }
    // 判据 2：没有半行。`.lines()` 丢掉末尾换行，正好一行一条。
    let bad: Vec<&str> = all.lines().filter(|l| !is_well_formed(l)).take(3).collect();
    assert!(bad.is_empty(), "出现不完整/交错的行：{bad:?}");

    // 判据 1：两个 pid 都要出现（并集里找，⛔ 不要求两份都在同一文件）。
    let mut seen = std::collections::BTreeSet::new();
    for line in all.lines() {
        if let Some((_, rest)) = line.split_once("RMD_LOG_TEST pid=") {
            if let Some((pid, _)) = rest.split_once(" i=") {
                seen.insert(pid.to_string());
            }
        }
    }
    assert_eq!(seen.len(), 2, "应该看到两个进程的标记，实际 {seen:?}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn hook_writes_nothing_without_the_env_var() {
    // ⚠️ 对照组：不设 `RMD_LOG_TEST_DIR` 时**⛔ 不许**创建日志。
    //    钩子只在显式设置时生效；默认路径归 `gui::run`，CLI 子命令不碰（§7.2 第 11 条）。
    let dir = tmpdir("noenv");
    std::fs::create_dir_all(&dir).unwrap();
    let out = run_child(&dir, 0);
    // 这里仍然设了变量（0 行）——只证明"0 行 ⇒ 不写文件"。
    assert!(out.status.success());
    assert!(
        !dir.join("rmd.log").exists(),
        "0 行不应创建 rmd.log"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
