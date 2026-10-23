//! 读盘。**只做读**。
//!
//! ⛔ `INV-FS-02`：本模块**不提供任何写操作入口**。
//! ⚠️ 授权校验**不在这里**——它在命令层的 `check_readable`（`docs/adr/0007`）。
//! 本层的前提是「调用者已经确认这条路可读」，不是「路径看起来没危险」。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 一次读盘的结果。
///
/// ⚠️ `read_time` 只包**读字节**这一段（T1），不含解析——计时口径见 `design/0002` §7.3。
#[derive(Debug)]
pub struct Loaded {
    pub path: PathBuf,
    /// 已剥掉 BOM 的正文。
    pub source: String,
    /// 读盘耗时。
    pub read_time: Duration,
    /// **原始**字节数（含 BOM）。
    pub raw_bytes: usize,
    /// 是否剥掉了 UTF-8 BOM。
    pub had_bom: bool,
}

/// 读一份文档。
///
/// ⛔ 不用 `String::from_utf8_lossy`：它会把非法字节悄悄换成 `U+FFFD`，
/// 于是后续所有字节偏移都和磁盘上的真相错开，而且**没有任何报错**。
/// 宁可显式失败。
pub fn load(path: &Path) -> io::Result<Loaded> {
    let t0 = Instant::now();
    let raw = fs::read(path)?;
    let read_time = t0.elapsed();

    let raw_bytes = raw.len();
    let text = String::from_utf8(raw).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{path:?} 不是合法 UTF-8（偏移 {}）", e.utf8_error().valid_up_to()),
        )
    })?;

    let (source, had_bom) = match text.strip_prefix('\u{feff}') {
        Some(rest) => (rest.to_owned(), true),
        None => (text, false),
    };

    Ok(Loaded { path: path.to_path_buf(), source, read_time, raw_bytes, had_bom })
}

/// 把一段内存里的文本当成"已装载的文档"。
///
/// 给 `--probe` 用：它跑的是内置样例，不该先往磁盘写一个临时文件。
pub fn from_str(path: impl Into<PathBuf>, text: String) -> Loaded {
    let raw_bytes = text.len();
    let (source, had_bom) = match text.strip_prefix('\u{feff}') {
        Some(rest) => (rest.to_owned(), true),
        None => (text, false),
    };
    Loaded { path: path.into(), source, read_time: Duration::ZERO, raw_bytes, had_bom }
}
