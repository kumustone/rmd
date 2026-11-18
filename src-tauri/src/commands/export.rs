//! 导出（`design/0076`）：**保存为单文件 HTML** 与 **打印为 PDF**。
//!
//! # 它属于哪一类命令
//!
//! 与 [`super::edit::save_document`] 同类——**写命令**：⛔ 不新增任何**可读**路径
//! （`INV-FS-04` 一个字没松），⛔ 但**会改用户的磁盘**。
//! 唯一的写点是用户在**系统保存面板**里当次点下的那一个文件名；
//! 落点闸门是 [`SessionGrants::check_export_target`]，它**不写 `roots`/`files`**，
//! 也不落任何配置（`design/0076` §2.1.5）。
//!
//! # 三段式（同 `open_document` / `list_dir` 的形状）
//!
//! ```text
//! ① 持锁：快照（当前文档的真实路径、目录、文件名主名、doc_seq、grants.clone()、外观兜底值）
//! ② 放锁：保存面板（异步）→ check_export_target（只做一次 canonicalize）
//! ③ 放锁：spawn_blocking —— 读盘 + 渲染 + 内联 + 拼装 + 原子替换
//! ```
//!
//! ⚠️ **解析与渲染必须与屏幕同源**：这里调的是 [`render_file`]，
//! 也就是打开 / 重载那条路用的同一份实现（`INV-SINGLE-01` 的同族）。
//! ⛔ 别在这里另写一遍 `loader::load` + `render_source`——"导出与屏幕是不是同一份"
//! 就只能靠人记得同步。
//!
//! # 取消不是失败
//!
//! 保存面板取消 ⇒ `Ok(None)`，**一个文件都不建**、不写日志、不触发失败条
//! （`design/0076` §2.1.1）。⛔ 取消不许包成 `Denied`。
//!
//! # 日志口径
//!
//! ⛔ 只记路径、字节数、图片计数；**不记正文**（`design/0076` §2.1.2 末条）。

use std::path::{Path, PathBuf};

use tauri_plugin_dialog::DialogExt;

use crate::commands::{AppState, Session};
use crate::config::Appearance;
use crate::document::export::{
    compose_page, inline_images, AppearanceIn, ExportOutcome, ImageCounts, InlineAsset,
    MAX_INLINE_IMAGE_BYTES,
};
use crate::error::{Denied, ExportReason};
use crate::fs::grants::SessionGrants;

/// 一次导出的**只读快照**（`design/0076` §2.1.2 步骤 ①）。
///
/// ⚠️ 它把放锁那一段需要的东西**一次带全**：`spawn_blocking` 里⛔ 不再碰 `Session`
/// （同 `list_dir` 的快照形态）。`grants` 是 **clone**，所以"克隆之后被撤权"
/// 只会让导出多读一张刚被撤的图——导出是只读，最坏结果可接受（设计 §2.1.2 明写）。
pub(crate) struct ExportSnapshot {
    /// 当前文档的**真实路径**（后端提交时存的那一份，已规范化）。
    pub real: PathBuf,
    /// 相对图片的解析基准（`asset::resolve` 的第一个参数）。
    pub doc_dir: PathBuf,
    /// 文件名主名（导出的 `<title>` 与面板里的默认文件名都用它）。
    pub title: String,
    /// 文档序号，只进日志（取消/竞态排查用，⛔ 不参与任何判定）。
    pub doc_seq: u64,
    /// 授权快照。
    pub grants: SessionGrants,
    /// 前端没传 / 传了越界值时，外观**兜底**用配置里的这一份（`design/0076` §2.1.3）。
    pub fallback: Appearance,
}

impl ExportSnapshot {
    /// 从会话里取一次快照。没有当前文档 ⇒ `None`（调用方翻成 `NoDocument`）。
    fn take(s: &Session) -> Option<Self> {
        let real = s.current_document.clone()?;
        let doc_dir = s
            .doc_dir
            .clone()
            .or_else(|| real.parent().map(Path::to_path_buf))?;
        // ⚠️ 主名只用于展示与默认文件名：非 UTF-8 文件名用 `to_string_lossy` 降级，
        //    ⛔ 不因此拒绝导出（拒绝的理由只能是"写不进去"）。
        let title = real
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        Some(ExportSnapshot {
            real,
            doc_dir,
            title,
            doc_seq: s.doc_seq,
            grants: s.grants.clone(),
            fallback: s.config.appearance(),
        })
    }
}

/// **写命令** · 保存为单文件 HTML（`design/0076` §2.1.2）。
///
/// 返回 `Ok(None)` 表示**用户取消**——不是错误，前端什么都不做。
#[tauri::command]
pub async fn export_html(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow,
    appearance: AppearanceIn,
) -> Result<Option<ExportOutcome>, Denied> {
    // ── ① 持锁：快照（只有内存操作）──────────────────────────────────
    // ⭐ 多窗口：快照取自**发起导出的那个窗口**的会话（`design/0068` §2.1）。
    let Some(snap) = state.with(window.label(), |s| ExportSnapshot::take(s)) else {
        // 前端本应先挡（`status.export-no-document`），这是**纵深第二道**
        return Err(Denied::export(ExportReason::NoDocument));
    };

    // ── ② 保存面板（放锁；取消 ⇒ Ok(None)，⛔ 不建任何文件）───────────
    let Some(candidate) =
        pick_export_target(&app, "保存为单文件 HTML", format!("{}.html", snap.title), "HTML", "html")
            .await
    else {
        return Ok(None);
    };

    // ── ③ 落点闸门（只做结构校验；⛔ 不动 roots/files）────────────────
    let (target, mode) = snap.grants.check_export_target(&candidate, Some(&snap.real))?;

    // ── ④ 放锁：读盘 + 渲染 + 内联 + 拼装 + 原子替换 ─────────────────
    // ⚠️ `doc_seq` 只进日志（取消 / 迟到结果的排查线索），⛔ 不参与任何判定。
    let seq = snap.doc_seq;
    let target_for_err = target.clone();
    let join = tauri::async_runtime::spawn_blocking(move || {
        export_to(&snap, &target, mode, &appearance)
    })
    .await;

    match join {
        Ok(Ok(outcome)) => {
            diag!(
                "▶ export_html {}（{} B，图片 内联 {} / 保留 {} / 占位 {}，seq {seq}）",
                outcome.path,
                outcome.bytes,
                outcome.images_inlined,
                outcome.images_kept,
                outcome.images_placeholder
            );
            Ok(Some(outcome))
        }
        Ok(Err(e)) => {
            // ⚠️ `e` 里可能带路径与系统文本 ⇒ 只进 stderr；文件里只留类别与长度。
            diag_stderr!("▶ export_html 被拒：{}（{}）", e.label(), e);
            diag_file!("▶ export_html 被拒 label={} err_len={}", e.label(), e.to_string().len());
            Err(e)
        }
        Err(e) => Err(Denied::worker_lost(&target_for_err, "导出线程没能跑完", e)),
    }
}

/// **写命令** · 导出为 PDF 文件（`design/0080`，取代 `design/0076` §2.1.7 的 PDF 那半）。
///
/// 与 [`export_html`] **同形**：快照 → 保存面板 → 落点闸门 → 产物 → 原子替换。
/// 差别只在产物那一步：HTML 是本进程渲染字符串；PDF 是**打印作业**（WKWebView 的
/// `printOperationWithPrintInfo:`）静默写到同目录临时文件，再读回来原子替换。
///
/// ⚠️ 仍然是"同一个打印作业"⇒ `print.css` / `@page` / 纸面调色板照旧生效；
/// 变的是**不弹系统打印面板**，用户拿到的直接是 `.pdf`。
/// ⛔ 打印路径**不改任何外观状态**：不切主题、不写 config、不动 `theme.js`。
#[tauri::command]
pub async fn export_pdf(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<ExportOutcome>, Denied> {
    // ── ① 持锁：快照 ────────────────────────────────────────────────
    // 纵深第二道：前端本应先挡（`status.export-no-document`）。
    // ⭐ 多窗口：导出的是**发起命令的那个窗口**的会话与其正文。
    let Some(snap) = state.with(window.label(), |s| ExportSnapshot::take(s)) else {
        return Err(Denied::export(ExportReason::NoDocument));
    };

    // 打印作业只有 macOS 实现（wry 的 `wkwebview` 分支）。
    // ⚠️ 放在保存面板**之前**：先让用户挑一个落点再告诉他"这台机器不行"是白费一步。
    if !cfg!(target_os = "macos") {
        return Err(Denied::export(ExportReason::PrintUnavailable));
    }

    // ── ② 保存面板（取消 ⇒ Ok(None)，⛔ 不建任何文件）───────────────
    let Some(candidate) =
        pick_export_target(&app, "导出为 PDF", format!("{}.pdf", snap.title), "PDF", "pdf").await
    else {
        return Ok(None);
    };

    // ── ③ 落点闸门（只做结构校验；⛔ 不动 roots/files）────────────────
    let (target, mode) = snap.grants.check_export_target(&candidate, Some(&snap.real))?;

    // ── ④ 打印作业写临时文件 → 读回 → 原子替换 ───────────────────────
    let tmp = pdf_tmp_path(&target);
    let seq = snap.doc_seq;
    let outcome = print_window_to_pdf(&window, tmp, target, mode).await?;

    diag!(
        "▶ export_pdf {}（{} B，seq {seq}）",
        outcome.path,
        outcome.bytes
    );
    Ok(Some(outcome))
}

/// 打印作业的等待上限（`design/0080` §6）：主线程迟迟不回调 ⇒ 按失败处理。
///
/// ⚠️ 定成 180 s 是"远大于任何真实文档"，⛔ 不是测量值——它只是**兜底**，
/// 正常路径（`bugs/0324` 之后是**异步**的）由委托回调决定，根本用不到这么久。
const PRINT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// 打印产物的上限：超过就当作业跑飞了，⛔ **不读进内存**。
///
/// ⚠️ 这条不是假想的防御：2026-11-15 真机用同步 `runOperation` 导出时，作业把页数
/// 报成未知（`NSIntegerMax`）⇒ 半分钟内写出 **705 MB / 270 万页**且仍在涨（`bugs/0324`）。
/// 512 MiB 是"任何正常文档都不会到、而跑飞一定撞穿"的量级；撞上时**先删临时文件**再报
/// `PrintFailed`，⛔ 不让一个失控产物把用户磁盘吃光、也⛔ 不把它读进内存。
const MAX_PDF_BYTES: u64 = 512 * 1024 * 1024;

/// 打印作业的落点：**同目录**临时文件，且**名字以 `.pdf` 结尾**。
///
/// ⚠️ 必须同目录：读回之后要走 [`crate::fs::atomic::replace_atomic`]，而它只在同一个
/// 文件系统内 `rename` 才是原子的（同 `design/0076` §2.1.6 的理由）。
/// ⚠️ 结尾补 `.pdf` 是**防御**，不是必须：2026-11-15 离屏探针实测（`NSView` ＋ 同一份
/// `NSPrintInfo` 字典）作业**原样**写到给定的 URL，**不**自动补后缀。但"系统会不会补"
/// 属于 Apple 的外部行为 ⇒ 名字先以 `.pdf` 结尾，两种实现给的都是同一个文件，
/// 也就不会出现"我们读不到、用户目录里却多了一个没人认领的 PDF"。
/// （`fs::atomic::tmp_path` 的尾部是 `.rmd-tmp-…`，正是"看起来没有后缀"的那一支。）
fn pdf_tmp_path(target: &Path) -> PathBuf {
    let mut name = crate::fs::atomic::tmp_path(target).into_os_string();
    name.push(".pdf");
    PathBuf::from(name)
}

/// macOS：把**这个窗口**当刻的页面静默打成 `tmp`，再读回并原子替换到 `target`。
///
/// # 为什么绕一圈 mpsc
///
/// `with_webview` 是把闭包**投递**给事件循环（异步、不阻塞、不返回结果），
/// 而本命令跑在异步运行时线程上 ⇒ ⛔ 不能就地调 AppKit（`INV-PDF-03`）。
/// 所以：闭包里**派发**作业 ＋ 由作业的完成回调把 `bool` 塞进 channel，这里等它。
///
/// ⚠️ 结果**不是**派发时就有的：`runOperationModalForWindow:…` 是异步的
/// （`bugs/0324` —— 同步的 `runOperation` 会把页数报成未知、写出天文数字的 PDF）。
/// 派发这一步只回一个 `bool`：「作业已经挂上去了没有」；真正的成败晚一步由
/// [`crate::fs::order::foundation::print_webview_to_pdf`] 的委托回调送回。
///
/// ⚠️ 等结果用的是 `spawn_blocking` ＋ `recv_timeout`，⛔ 不是在异步线程上 `recv()`——
/// 那会把运行时线程占满一个作业那么久。
#[cfg(target_os = "macos")]
async fn print_window_to_pdf(
    window: &tauri::WebviewWindow,
    tmp: PathBuf,
    target: PathBuf,
    mode: Option<u32>,
) -> Result<ExportOutcome, Denied> {
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    // 交给作业：由委托回调在作业结束时 `send`
    let done = tx.clone();
    // 派发失败时自己 `send(false)`——那时闭包里的那份 `done` 已经被 drop 掉了
    let undispatched = tx.clone();
    let printed_path = tmp.clone();
    let dispatched = window.with_webview(move |pw| {
        // ⚠️ 这里**已经**在事件循环线程上（主线程）。`print_webview_to_pdf` 只做
        //    "建作业 ＋ 挂上去"，立刻返回；作业本体在事件循环里异步跑完。
        if !crate::fs::order::foundation::print_webview_to_pdf(
            pw.inner(),
            &printed_path,
            done,
        ) {
            let _ = undispatched.send(false);
        }
    });
    if let Err(e) = dispatched {
        // ⚠️ 投递失败时闭包已被丢弃 ⇒ 那两份 clone 都 drop 了，不会有人等 channel。
        diag_stderr!("▶ export_pdf 投递主线程失败：{e}");
        diag_file!("▶ export_pdf 投递失败 label=打印失败 err_len={}", e.to_string().len());
        return Err(Denied::export(ExportReason::PrintFailed));
    }

    let target_for_err = target.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // ⚠️ 留住最后一份 `Sender`：作业**永不回调**时（见 `PRINT_TIMEOUT`）
        //    通道一旦全断开，`recv_timeout` 会立刻返回 `Disconnected`，
        //    那就从"等 180 s"变成"立刻判失败"——虽然结果相同，但判据变了样。
        let _alive = tx;
        finish_pdf(rx, tmp, target, mode)
    })
    .await
    .map_err(|e| Denied::worker_lost(&target_for_err, "导出线程没能跑完", e))?
}

/// 非 macOS：⛔ 不假装成功（`design/0076` §2.3 的表）。
///
/// ⚠️ 调用方已用 `cfg!` 提前拒过一次；这里是**类型上的兜底**——两个平台的签名必须一致，
/// 否则 `export_pdf` 里那段公共流程编译不过。
#[cfg(not(target_os = "macos"))]
async fn print_window_to_pdf(
    _window: &tauri::WebviewWindow,
    tmp: PathBuf,
    target: PathBuf,
    mode: Option<u32>,
) -> Result<ExportOutcome, Denied> {
    let _ = (tmp, target, mode);
    Err(Denied::export(ExportReason::PrintUnavailable))
}

/// 等打印作业的结果，然后**读回 → 删临时 → 原子替换**（全是阻塞 IO）。
///
/// ⚠️ 四条判据缺一不可（`design/0080` §6 末段 ＋ `bugs/0324`）：
/// ① 作业自报成功；② 临时文件**不是失控体积**（`MAX_PDF_BYTES`，先看 `metadata` 再读，
/// ⛔ 不把 700 MB 拉进内存）；③ 读回的字节**非空**（作业内部报错时 BOOL 仍可能是 YES）；
/// ④ 临时文件**无论成败都删**（`INV-PDF-02`：⛔ 不在用户目录里留 `.rmd-tmp-*`）。
fn finish_pdf(
    rx: std::sync::mpsc::Receiver<bool>,
    tmp: PathBuf,
    target: PathBuf,
    mode: Option<u32>,
) -> Result<ExportOutcome, Denied> {
    let printed = matches!(rx.recv_timeout(PRINT_TIMEOUT), Ok(true));
    let bytes = if printed {
        // ⚠️ 先 `metadata`（不读内容）判体积，再 `read`
        match std::fs::metadata(&tmp) {
            Ok(m) if m.len() > MAX_PDF_BYTES => {
                diag_file!(
                    "▶ export_pdf 产物失控：{} B > {} B，丢弃",
                    m.len(),
                    MAX_PDF_BYTES
                );
                None
            }
            Ok(_) => std::fs::read(&tmp).ok(),
            Err(_) => None,
        }
    } else {
        None
    };
    // ⚠️ 先内存化再删：删掉之后失败路径就是"什么都没发生"，目标一个字节没动。
    let _ = std::fs::remove_file(&tmp);
    let Some(bytes) = bytes.filter(|b| !b.is_empty()) else {
        return Err(Denied::export(ExportReason::PrintFailed));
    };

    crate::fs::atomic::replace_atomic(&target, &bytes, mode).map_err(|e| Denied::io(&target, e))?;
    Ok(ExportOutcome::new(
        target.display().to_string(),
        bytes.len(),
        ImageCounts { inlined: 0, kept: 0, placeholder: 0 },
    ))
}

/// 弹系统保存面板，返回用户选择的**候选路径**；取消返回 `None`。
///
/// ⚠️ **回调式**而不是 `blocking_save_file`：后者会阻塞当前线程，而 macOS 的对话框
/// 只能在主线程跑（与 [`super::fs`] 里的 `pick` 同一条理由）。
/// ⚠️ 面板的返回值**直接**进 [`SessionGrants::check_export_target`]，中间不经过前端
/// ——与 `choose_file` 同一信任级（`design/0076` §2.1.5）。
///
/// ⭐ `design/0082` 起也是 `save_untitled`（保存未命名文档）的面板：**同一份**实现，
/// ⛔ 不为"保存为 Markdown"抄第二遍（抄出来的那份迟早与导出那张面板长得不一样）。
pub(super) async fn pick_export_target(
    app: &tauri::AppHandle,
    panel_title: &str,
    default_name: String,
    filter_label: &str,
    ext: &str,
) -> Option<PathBuf> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title(panel_title)
        .set_file_name(default_name)
        .add_filter(filter_label, &[ext])
        .save_file(move |p| {
            let _ = tx.blocking_send(p);
        });
    // ⚠️ 用户取消时回调**仍然会**被调用（参数 `None`），所以这里不会一直挂着。
    rx.recv().await.flatten()?.into_path().ok()
}

/// 导出的**阻塞本体**：读当前文档 → 内联图片 → 拼页面 → 原子写。
///
/// ⭐ 抽成独立函数是为了让单测能直接验它（`design/0076` §7.1：
/// 「`export_to(snapshot, target)` 写出正确字节、返回计数、且不触碰会话」）。
/// ⛔ 它**没有** `AppState`、`Session` 或 Tauri 的参数——"不触碰会话"是**签名保证**的。
pub(crate) fn export_to(
    snap: &ExportSnapshot,
    target: &Path,
    mode: Option<u32>,
    appearance: &AppearanceIn,
) -> Result<ExportOutcome, Denied> {
    // a. 读盘 + 渲染（与打开 / 重载同一份实现）
    let rendered = super::document::render_file(&snap.real)?;

    // b. 只改 `<img>` 的 `src`；预算与计数都在扫描器里（`document/export.rs`）
    let (body, counts) = inline_images(&rendered.doc.html, |src| load_image(snap, src));

    // c. 拼成自足单文件（CSS 在编译期嵌入，外观数字在 Rust 侧重格式化）
    let page = compose_page(&snap.title, &body, appearance, &snap.fallback);
    let bytes = page.as_bytes();

    // d. 同目录原子替换（唯一实现见 `fs::atomic`）
    crate::fs::atomic::replace_atomic(target, bytes, mode).map_err(|e| Denied::io(target, e))?;

    Ok(ExportOutcome::new(target.display().to_string(), bytes.len(), counts))
}

/// 给 [`inline_images`] 的加载器：解析 → 授权 → 读盘。
///
/// ⚠️ 返回 `None` 的**每一条**理由（读失败 / 未授权 / 超单张预算）都让扫描器
/// **原样保留整个标签**并计入 `images_kept`——⛔ 不让整次导出失败
/// （`design/0076` §2.1.4 的表）。
/// ⚠️ 大小先在 `metadata` 上判，再读：读一个 500 MB 的文件再拒绝，代价一样大
/// （同 [`super::asset::read_asset`] 的口径）。
fn load_image(snap: &ExportSnapshot, src: &str) -> Option<InlineAsset> {
    // ⚠️ 解析与 MIME 判定只有一份实现，在 `commands::asset`（`INV-FS-01` 的同族）。
    let requested = super::asset::resolve(&snap.doc_dir, src);
    // ⚠️ `check_readable_asset`：图片专用的那条校验（`design/0036`），⛔ 不改 roots/files。
    let real = snap.grants.check_readable_asset(&requested).ok()?;
    let meta = std::fs::metadata(&real).ok()?;
    if meta.len() > MAX_INLINE_IMAGE_BYTES {
        return None;
    }
    let bytes = std::fs::read(&real).ok()?;
    let mime = super::asset::mime_of(&real);
    Some(InlineAsset { bytes, mime })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 一次性测试目录（与本仓其他模块同形：⛔ 不引入 `tempfile`）。
    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(tag: &str) -> Self {
            let base =
                std::env::temp_dir().join(format!("rmd-export-{}-{tag}", std::process::id()));
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

    /// 一份带本地图片的文档 ＋ 目录授权。
    fn fixture(tag: &str) -> (TestDir, ExportSnapshot) {
        let t = TestDir::new(tag);
        fs::write(t.path.join("doc.md"), "# 标题\n\n正文。\n\n![图](pic.png)\n").unwrap();
        fs::write(t.path.join("pic.png"), b"\x89PNG\r\n\x1a\nfake").unwrap();

        let mut grants = SessionGrants::default();
        grants.authorize_root(&t.path).unwrap();

        let real = fs::canonicalize(t.path.join("doc.md")).unwrap();
        let snap = ExportSnapshot {
            doc_dir: real.parent().unwrap().to_path_buf(),
            title: "doc".to_string(),
            real,
            doc_seq: 1,
            grants,
            fallback: Appearance::default(),
        };
        (t, snap)
    }

    #[test]
    fn 导出写出正确字节_内联本地图片且计数正确() {
        let (t, snap) = fixture("inline");
        let target = t.path.join("out.html");
        let outcome = export_to(&snap, &target, None, &AppearanceIn::default()).unwrap();

        assert_eq!(outcome.path, target.display().to_string());
        assert_eq!(outcome.images_inlined, 1);
        assert_eq!(outcome.images_kept, 0);
        assert_eq!(outcome.images_placeholder, 0);

        let written = fs::read(&target).unwrap();
        assert_eq!(written.len(), outcome.bytes, "回报的字节数必须等于真正写下的字节数");
        let text = String::from_utf8(written).unwrap();
        assert!(text.starts_with("<!DOCTYPE html>"), "{text}");
        assert!(text.contains("<main id=\"doc\" class=\"doc\">"), "{text}");
        assert!(text.contains("data:image/png;base64,"), "本地图片必须内联：{text}");
        assert!(!text.contains("# 标题"), "正文已被渲染，不应出现 Markdown 源");
        assert!(text.contains("<h1"), "正文应带标题元素：{text}");
    }

    #[test]
    fn 导出不触碰会话_授权快照原样() {
        let (t, snap) = fixture("no-session");
        let roots_before = snap.grants.roots().to_vec();
        let files_before = snap.grants.files().to_vec();
        let _ = export_to(&snap, &t.path.join("out.html"), None, &AppearanceIn::default()).unwrap();
        assert_eq!(snap.grants.roots(), roots_before.as_slice());
        assert_eq!(snap.grants.files(), files_before.as_slice());
        // 目标只是**写**，⛔ 没有变成可读路径
        assert!(!snap.grants.roots().iter().any(|r| r.ends_with("out.html")));
    }

    #[test]
    fn 目标写不进去时报_io_错误且不留残骸() {
        let (_t, snap) = fixture("io");
        let target = Path::new("/definitely/not/a/dir/out.html");
        let err = export_to(&snap, target, None, &AppearanceIn::default()).unwrap_err();
        assert!(matches!(err, Denied::Io { .. }), "{err:?}");
    }

    // ─────────────────────────────────────────────────────────────────
    // `finish_pdf`：打印**结束之后**那段逻辑（`bugs/0324` 起多了一道体积闸门）
    //
    // ⚠️ 这几条**不碰 AppKit**：`finish_pdf` 只做"等通道 → 判体积 → 读回 → 原子替换"，
    //    打印本身在别处。所以它们能跑在任何线程、任何测试进程里。
    // ─────────────────────────────────────────────────────────────────

    /// 造一个"打印作业已经写好临时文件"的现场。
    fn pdf_fixture(tag: &str, payload: &[u8]) -> (TestDir, PathBuf, PathBuf) {
        let t = TestDir::new(tag);
        let tmp = t.path.join("doc.pdf.rmd-tmp-1-0-0.pdf");
        let target = t.path.join("doc.pdf");
        fs::write(&tmp, payload).unwrap();
        (t, tmp, target)
    }

    #[test]
    fn 打印成功后原子替换且不留临时文件() {
        const PAYLOAD: &[u8] = b"%PDF-1.7\nfake body\n";
        let (_t, tmp, target) = pdf_fixture("pdf-ok", PAYLOAD);
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(true).unwrap();
        let outcome = finish_pdf(rx, tmp.clone(), target.clone(), None).unwrap();
        assert_eq!(fs::read(&target).unwrap(), PAYLOAD);
        assert_eq!(outcome.bytes, PAYLOAD.len(), "回报的字节数必须等于真正写下的字节数");
        assert!(!tmp.exists(), "⛔ 导出成功后不能在用户目录里留 `.rmd-tmp-*`（INV-PDF-02）");
    }

    #[test]
    fn 作业自报失败时目标一个字节不动且删临时文件() {
        let (_t, tmp, target) = pdf_fixture("pdf-fail", b"%PDF-1.7\nhalf\n");
        // 目标先放一份"用户已有的文件"：失败路径⛔ 不许碰它
        fs::write(&target, b"old").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(false).unwrap();
        let err = finish_pdf(rx, tmp.clone(), target.clone(), None).unwrap_err();
        assert!(matches!(err, Denied::Export { reason: ExportReason::PrintFailed }), "{err:?}");
        assert_eq!(fs::read(&target).unwrap(), b"old", "失败时覆盖了用户的旧文件");
        assert!(!tmp.exists(), "失败时留下了临时文件（INV-PDF-02）");
    }

    #[test]
    fn 读出零字节按失败处理() {
        let (_t, tmp, target) = pdf_fixture("pdf-empty", b"");
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(true).unwrap();
        let err = finish_pdf(rx, tmp.clone(), target.clone(), None).unwrap_err();
        assert!(matches!(err, Denied::Export { reason: ExportReason::PrintFailed }), "{err:?}");
        assert!(!target.exists(), "0 字节也被落盘了");
        assert!(!tmp.exists());
    }

    /// `bugs/0324` 的兜底：产物失控时**不读进内存**、不留残骸、目标不动。
    ///
    /// ⚠️ 用稀疏文件（`set_len`）造一个超过上限的体积：立刻生效、不真占磁盘，
    /// ⛔ 别真去写 512 MiB（那会让这条单测慢到没人愿意跑）。
    #[test]
    fn 产物超过上限时丢弃且不落盘() {
        let (_t, tmp, target) = pdf_fixture("pdf-oversize", b"x");
        let f = std::fs::OpenOptions::new().write(true).open(&tmp).unwrap();
        f.set_len(MAX_PDF_BYTES + 1).unwrap();
        drop(f);
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(true).unwrap();
        let err = finish_pdf(rx, tmp.clone(), target.clone(), None).unwrap_err();
        assert!(matches!(err, Denied::Export { reason: ExportReason::PrintFailed }), "{err:?}");
        assert!(!target.exists(), "失控产物被落盘了");
        assert!(!tmp.exists(), "失控产物没被删掉（占着用户的磁盘）");
    }

    /// 反面判据：**刚好等于**上限不算失控（闸门是 `> MAX`，不是 `>=`）。
    ///
    /// ⚠️ 这条防的是"手滑写成 `>=`"那种改动 —— 它会让一份恰好 512 MiB 的合法文档
    /// 被判成失控，而没人会在真机上造一份正好 512 MiB 的 PDF 来试。
    #[test]
    fn 体积恰好等于上限不算失控() {
        let (_t, tmp, target) = pdf_fixture("pdf-at-limit", b"x");
        let f = std::fs::OpenOptions::new().write(true).open(&tmp).unwrap();
        f.set_len(MAX_PDF_BYTES).unwrap();
        drop(f);
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(true).unwrap();
        let outcome = finish_pdf(rx, tmp.clone(), target.clone(), None).unwrap();
        assert_eq!(outcome.bytes as u64, MAX_PDF_BYTES);
        assert!(target.exists());
    }
}
