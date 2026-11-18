//! 读盘。**只做读**。
//!
//! ⛔ `INV-FS-02`：本模块**不提供任何写操作入口**。
//! ⚠️ 授权校验**不在这里**——它在命令层的 `check_readable`（`docs/adr/0007`）。
//! 本层的前提是「调用者已经确认这条路可读」，不是「路径看起来没危险」。

use std::fs;
use std::io;
use std::path::Path;

/// 一次读盘的结果。
#[derive(Debug)]
pub struct Loaded {
    /// 已剥掉 BOM 的正文。
    pub source: String,
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
    let raw = fs::read(path)?;

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

    Ok(Loaded { source, raw_bytes, had_bom })
}
