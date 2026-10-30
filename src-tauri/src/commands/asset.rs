//! 图片 / 附件。**读取命令**（⛔ 不改授权，`INV-FS-04`）。
//!
//! # 为什么图片要过一次 IPC（`design/0003` §2.1.2 (3) 的路线 A）
//!
//! | | 路线 A ✅ **V1 采用** | 路线 B 🔜 备选 |
//! |---|---|---|
//! | 做法 | `read_asset` → `check_readable_asset` → 返回 `data:` URL | 开 `protocol-asset`，前端 `convertFileSrc` |
//! | 授权真值 | **只有一个**（`SessionGrants`） | ⚠️ **两个**，必须严格同步，同步靠人记得 |
//! | 撤销 | 清 `roots` 即完成 | ⚠️ 必须记得再调 `forbid_directory` |
//! | 开销 | ⚠️ 过一次 IPC + base64 膨胀（≈ +33%） | ✅ 原生流式，零拷贝 |
//!
//! 选 A 的唯一理由是 R2 要的「**统一入口**」：B 把授权变成两个真值，
//! 而"两个真值必须同步"**没有自动化防线**。
//! ⚠️ 代价（IPC + base64）是**可量化**的，正是 **U6** 要量的东西——
//! 若图片密集文档上路线 A 明显拖慢首屏，再切 B（`questions.md` Q15）。
//!
//! # ⛔ 前端**不得**自己拼路径（§2.1.2 (3) 的"图片基准路径"）
//!
//! 本命令收的是**文档里那个原始 `src` 字符串**，由**后端**用
//! `doc_dir.join(src)` 解析。⚠️ 前端唯一能拿到的东西就是那个字符串，
//! 它连"文档在哪"都不该自己算。
//!
//! ⚠️ **远程图片**（`https://…`）**不走这里**：它走 WebView 自身的网络，
//! 绕开全部授权模型。本设计建议 V1 **不加载**（占位 + 可点开），
//! 已由 2026-10-13 评审通过（§9）。前端在 [`ImageView`] 那一侧处理它，
//! ⛔ 别在这里为它开一条网络路径。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::AppState;
use crate::error::Denied;

/// 单张图片的大小上限（字节）。
///
/// ⚠️ 这是**运行期保护**，不是产品取值：`data:` URL 会把字节数膨胀 ~33%，
/// 而整张图要在内存里过两遍（原始 + base64）。没有上限时，
/// 一份"不小心拖进来一张 500 MB 的扫描件"的文档会把进程顶爆。
/// 超限时给出**明确文案**，⛔ 不是静默裂图。
pub const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;

/// `read_asset` 的返回值。
#[derive(Debug, Serialize)]
pub struct AssetPayload {
    /// 文档里那个原始 `src`（原样回显，前端据此把结果对回是哪张图）。
    pub src: String,
    /// **规范化后**的真实路径（`check_readable` 的返回值）。
    pub real_path: String,
    /// 字节数。
    pub bytes: usize,
    /// MIME 类型。
    pub mime: String,
    /// `data:` URL。
    pub data_url: String,
}

/// **读取命令** · 读一张图并返回 `data:` URL。
///
/// ⚠️ 前端**只在图片被拒绝时**才拿得到 [`Denied`]，而那时它要区分
/// `not_authorized`（→ 显示"未授权其所在目录" + 一键授权）与
/// `not_found`（→ 显示"文件不存在"）。**两者的用户含义完全不同**：
/// 用词错了会把我们的安全策略说成 bug（`design/0003` §7 步骤 18）。
#[tauri::command]
pub fn read_asset(
    state: tauri::State<'_, AppState>,
    src: String,
    generation: u64,
    req: u64,
) -> Result<AssetPayload, Denied> {
    let _ = req;
    let result = state.with(|s| {
        let current = s.grants.root_generation();
        if generation != current {
            return Err(Denied::stale(generation, current));
        }
        let Some(doc_dir) = s.doc_dir.clone() else {
            // 还没有已提交的文档 → 没有解析基准，按"找不到"处理
            return Err(Denied::not_found(&src));
        };
        let requested = resolve(&doc_dir, &src);
        // ⭐ `design/0036`：图片用**图片专用**的那条校验——比 `check_readable` 多一条
        //    「单文件授权 ⇒ 其父目录子树可读」，⛔ 不改 `roots` / 树 / 搜索的范围。
        let real = s.grants.check_readable_asset(&requested)?;

        // ⚠️ 大小检查放在**读之前**：`read` 一个 500 MB 的文件再拒绝，代价一样大
        let meta = std::fs::metadata(&real).map_err(|e| Denied::io(&real, e))?;
        if meta.len() > MAX_ASSET_BYTES {
            return Err(Denied::io(
                &real,
                format!(
                    "图片 {:.1} MB，超过上限 {} MB",
                    meta.len() as f64 / 1024.0 / 1024.0,
                    MAX_ASSET_BYTES / 1024 / 1024
                ),
            ));
        }

        let bytes = std::fs::read(&real).map_err(|e| Denied::io(&real, e))?;
        let mime = mime_of(&real);
        Ok(AssetPayload {
            src,
            real_path: real.display().to_string(),
            bytes: bytes.len(),
            mime: mime.clone(),
            data_url: format!("data:{mime};base64,{}", base64(&bytes)),
        })
    });

    match &result {
        Ok(a) => diag!("▶ read_asset {}（{} B, {}）", a.real_path, a.bytes, a.mime),
        Err(e) => {
            diag_stderr!("▶ read_asset 被拒：{}（{}）", e.label(), e);
            diag_file!(
                "▶ read_asset 被拒 label={} err_len={}",
                e.label(),
                e.to_string().len()
            );
        }
    }
    result
}

/// 把文档里写的 `src` 解析成一个**待校验**的路径。
///
/// ⚠️ 这里**不做任何授权判断**——它的产物一定要交给 `check_readable`。
/// ⛔ 别在这里"顺手判断它是不是在 root 下"：那就是第二条校验路径。
///
/// 处理三件在真实 Markdown 里一定会遇到的事（`vision/0001` §8.2 点名要求）：
/// 1. **`#锚点` / `?查询`**：`![x](pic.png#a)` 里那个 `#a` 不是文件名的一部分；
/// 2. **URL 编码**：`![x](a%20b.png)` 指向的是 `a b.png`；
/// 3. **绝对路径**：`/Users/x/p.png` 与 `../../p.png` 都要能表达。
pub fn resolve(doc_dir: &Path, src: &str) -> PathBuf {
    // ⭐ `design/0026` §2.4：渲染前的 AST 改写会把 `file:` 写成受控标记
    //    （`rmd-file:<pct(绝对路径)>[#<pct(fragment)>]`）——这里**解回绝对路径**。
    //    ⚠️⚠️ **它是编码，不是信任**（`INV-LINK-10`）：作者可以手写同样的标记，
    //    ⇒ 解出来的路径**照样**要交给 `check_readable`（调用方那一步一个字节都没变）。
    //    ⚠️ 只切 `#`（标记里不会有 query——改写时带 query 的一律判成不支持了）。
    if let Some(rest) = src.strip_prefix(crate::link::MARKER_FILE) {
        let cut = rest.find('#').unwrap_or(rest.len());
        let raw = crate::link::percent_decode(&rest[..cut]);
        let p = Path::new(&raw);
        return if p.is_absolute() { p.to_path_buf() } else { doc_dir.join(p) };
    }
    // ⚠️ `rmd-unsupported:` 这类标记**不特殊处理**：它会走下面的相对路径分支，
    //    在 `check_readable` 那里失败 ⇒ 前端显示既有的"图片读不出来"占位。
    //    ⛔ 别在这里为它开一条"静默跳过"的支路（那会造出第二条判定）。

    // ① 去掉 fragment 与 query
    let cut = src.find(['#', '?']).unwrap_or(src.len());
    let raw = percent_decode(&src[..cut]);
    let p = Path::new(&raw);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        // ⚠️ 相对路径**相对当前文档所在目录**，⛔ 不相对进程 cwd、⛔ 不相对 root
        doc_dir.join(p)
    }
}

/// `%XX` 解码。非法序列**原样保留**（不报错）——它更可能是文件名里
/// 真有一个 `%`，而不是谁写错了编码。
///
/// ⚠️ `design/0026` 起**唯一实现在 [`crate::link::percent_decode`]**（它在默认构建里，
/// 因为链接分类也要用它）；这里只**转调**，⛔ 不留第二份。
pub use crate::link::percent_decode;

/// 按扩展名给 MIME。⛔ 不读文件头（那是另一件事，且 `0003` 没要求）。
/// 认不出来时给 `application/octet-stream`——浏览器仍会当二进制处理，
/// 至少不会因为空 MIME 而拒绝显示。
pub fn mime_of(p: &Path) -> String {
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
    .to_string()
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 标准 base64（带 `=` 填充）。
///
/// ⚠️ 手写而不是加一个 crate：这是本项目里**唯一**需要 base64 的地方，
/// 而它只有 20 行。⛔ 但别在此基础上扩张（要 URL-safe 变体时该换库了）。
pub fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_与已知值一致() {
        // RFC 4648 的测试向量 + 三种填充长度
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // 中文（UTF-8 三字节一组）
        assert_eq!(base64("中".as_bytes()), "5Lit");
    }

    #[test]
    fn 相对路径相对文档目录解析() {
        let dir = Path::new("/Users/x/notes");
        assert_eq!(resolve(dir, "pic.png"), PathBuf::from("/Users/x/notes/pic.png"));
        assert_eq!(resolve(dir, "./sub/pic.png"), PathBuf::from("/Users/x/notes/./sub/pic.png"));
        assert_eq!(
            resolve(dir, "../../../../etc/passwd"),
            PathBuf::from("/Users/x/notes/../../../../etc/passwd")
        );
    }

    #[test]
    fn 锚点与查询串不是文件名的一部分() {
        let dir = Path::new("/d");
        assert_eq!(resolve(dir, "pic.png#section"), PathBuf::from("/d/pic.png"));
        assert_eq!(resolve(dir, "pic.png?raw=1"), PathBuf::from("/d/pic.png"));
    }

    #[test]
    fn url_编码会被解码_非法序列原样保留() {
        assert_eq!(percent_decode("a%20b.png"), "a b.png");
        assert_eq!(percent_decode("%E4%B8%AD.png"), "中.png");
        // ⚠️ 非法序列不报错：它更可能是文件名里真有个 `%`
        assert_eq!(percent_decode("100%.png"), "100%.png");
        assert_eq!(percent_decode("%zz.png"), "%zz.png");
        assert_eq!(resolve(Path::new("/d"), "a%20b.png"), PathBuf::from("/d/a b.png"));
    }

    #[test]
    fn 绝对路径不被拼到文档目录下() {
        assert_eq!(resolve(Path::new("/d"), "/etc/x.png"), PathBuf::from("/etc/x.png"));
    }

    #[test]
    fn 中英混排的_src_解码后仍是合法路径() {
        let got = resolve(Path::new("/d"), "%E4%B8%AD%E6%96%87%20pic.png");
        assert_eq!(got, PathBuf::from("/d/中文 pic.png"));
    }

    // —— `design/0026` §2.4：受控标记 ——

    #[test]
    fn 标记解回绝对路径() {
        let dir = Path::new("/d");
        assert_eq!(
            resolve(dir, "rmd-file:/tmp/a%20b.png"),
            PathBuf::from("/tmp/a b.png")
        );
        // 锚点不是文件名的一部分（与普通 src 同一口径）
        assert_eq!(
            resolve(dir, "rmd-file:/tmp/%E4%B8%AD.png#frag"),
            PathBuf::from("/tmp/中.png")
        );
        // ⚠️ 标记里的相对路径仍以文档目录为基准（改写层只写绝对路径，这是防御）
        assert_eq!(resolve(dir, "rmd-file:rel.png"), PathBuf::from("/d/rel.png"));
    }

    #[test]
    fn 伪造的标记不享受任何特权() {
        // ⚠️ `INV-LINK-10`：`resolve` **只解码、不做授权** ⇒ 产物必须原样交给 `check_readable`。
        //    这条钉的是"它没有被当成可信路径直接读"。
        assert_eq!(
            resolve(Path::new("/d"), "rmd-file:/etc/passwd"),
            PathBuf::from("/etc/passwd")
        );
    }

    #[test]
    fn 不支持标记走普通相对路径_在授权层失败() {
        // 不在 `resolve` 里开第二条判定：它就是一段怪文件名
        assert_eq!(
            resolve(Path::new("/d"), "rmd-unsupported:javascript"),
            PathBuf::from("/d/rmd-unsupported:javascript")
        );
    }
}
