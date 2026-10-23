//! ⭐ **编辑面**：`design/0012` 的三条命令 ＋ **本项目唯一的写盘路径**。
//!
//! # 命令一览（⛔ 少一条都不行，多一条也不行）
//!
//! | 命令 | 类别 | 干什么 |
//! |---|---|---|
//! | [`begin_edit`] | **授权命令**（唯一！） | 进入/刷新编辑态 ＝ **产生写授权** ＋ 把文本交给编辑器 |
//! | [`end_edit`] | **授权命令**（唯一！） | 退出编辑态 ＝ **撤销写授权** |
//! | [`render_preview`] | 读取命令 | 缓冲文本 → `DocumentPayload`（⛔ 不读盘、⛔ 不写会话状态） |
//! | [`save_document`] | ⭐ **写命令** | 唯一的写盘入口（`INV-EDIT-10`） |
//!
//! ⚠️ 与 `commands/mod.rs` 模块头那张"两类命令"的表**不矛盾**：
//! 那张表说的是"只有授权命令能改 [`SessionGrants`]"（`INV-FS-04`），
//! 而**写授权不是 [`SessionGrants`] 的一部分**——它是
//! [`Session::edit_target`] 这个**会话级、随进程消亡、不落盘**的字段
//! （`INV-EDIT-02`：⛔ 不许把写授权并进 `roots`/`files`）。
//! ⇒ [`SessionGrants`] 的三个写入点**一个字不动**，`INV-FS-04` 完好。
//!
//! # 为什么写授权需要一个**动作**，而不是一个"能力"
//!
//! `INV-EDIT-02` 的后半句：**写授权只能由「进入编辑态」这个显式动作产生**。
//! ⛔ 「这个文件被读过了」≠「可以写它」——读是用户点开看的，
//! 写是**改动用户的磁盘**，两者对用户的含义完全不同（`features/0012` 的「不改别人的东西」）。
//! ⇒ 形态上就是 [`begin_edit`] 这一条命令：没有它，[`save_document`] 在任何输入下都写不出去。
//!
//! # ⭐ 基线的生产者只有 [`begin_edit`]（这一条与设计原文的措辞有别）
//!
//! `design/0012` §2.4-3 写的是"打开文件时记下 `baseline_bytes`"，本实现把它**挪到了
//! [`begin_edit`]**，理由是它让"基线"的语义变成一句能判对错的话：
//!
//! > **基线的定义 = 编辑器手里那个缓冲是基于哪份磁盘内容来的。**
//!
//! ⚠️ 这个挪动的收益很具体，不是措辞偏好：
//!
//! 1. **文本与基线在同一个动作里成对产生**（都在 [`begin_edit`]）⇒ 结构上不可能出现
//!    "编辑器拿着 A 的文本、基线却是 B"的错配。
//! 2. ⭐ 于是**编辑态下收到外部修改**那条路（`INV-EDIT-06`）**不需要新命令**：
//!    前端问过用户、用户接受之后重新调一次 [`begin_edit`]，
//!    文本与基线**同时**换新。若基线在"打开时"落，这条路就要求前端先
//!    `end_edit` 再想办法拿新文本——而 `reload_document` 只回 HTML，拿不到文本。
//! 3. 会话里那份基线的**生命周期**缩到"只在编辑态存在"（10 MB 文档不再全程驻留两份）。
//!
//! ⚠️ 代价与边界：进入编辑态时**多读一次盘**（毫秒级，`design/0012` §1.3(d)），
//! 而它换来的是"我看到的确实是磁盘现在这份"。⚠️ 这条偏离已登记在
//! `design/0012` §10 实施记录里。
//!
//! # ⛔ 唯一写路径（`INV-EDIT-10`）
//!
//! `⌘S`、工具栏「保存」按钮、将来的 `:w` **都走 [`save_document`]**。
//! ⛔ 不许再开第二条：那不是风格问题，`design/0017` 的「两条路径说同一件事」
//! 是用一次真金白银的事故换来的教训。
//! ⚠️ 反过来说，本文件的 `std::fs::write` / `rename` 出现次数就是判据：
//! **写盘只允许出现在 [`write_off_lock`] 一处**。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::commands::document::{render_source, DocumentPayload};
use crate::commands::AppState;
use crate::document::envelope::Envelope;
use crate::document::loader;
use crate::error::Denied;

// ─────────────────────────────────────────────────────────────────────
// ① 进入 / 退出编辑态（**写授权的两个写入点**）
// ─────────────────────────────────────────────────────────────────────

/// [`begin_edit`] 的返回：**写授权 ＋ 编辑器要的那份文本**（一次往返办两件事）。
///
/// ⚠️ **为什么把文本放在这里，而不是让前端自己去要**：
/// `DocumentPayload` 只带 HTML（`adr/0003`：Rust 出 HTML 不出 AST）；
/// 若让前端每次敲键都回传一遍整篇文本来换预览，那是 §2.6 已经要付的成本——
/// 但**进入编辑态这一次**必须拿到文本，而它只可能由后端给（前端没有第二份原文）。
/// ⛔ 也**不许**为了它新开一条"读文件"的命令：那会变成第二条读盘路径
/// （`INV-FS-01` 的防线是**每一条**读盘都要过 `check_readable`，
/// 而"能拿文本的地方只有一个"比"每处都记得校验"更强）。
#[derive(Debug, Serialize)]
pub struct EditGrant {
    /// 规范路径（`check_writable` 的返回值）——⛔ 前端不得回退到别的写法。
    pub real_path: String,
    /// ⭐ **规范化后的源码**：恒为 LF、无 BOM（`INV-EDIT-12`）。
    /// ⚠️ 它**不是**磁盘原文的字节——行尾与 BOM 由 [`EditGrant::envelope`] 描述，
    /// 保存时由 `Envelope::restore` 还回去。
    pub text: String,
    /// ⭐ **信封**：这份文件的 BOM 与行尾。
    /// ⚠️ 前端用它显示那条常驻提示（`lossy == true` ⇒「此文件行尾不统一，保存后将统一为 LF」）。
    pub envelope: Envelope,
}

/// ⭐ **进入（或刷新）编辑态**——`design/0012` §2.4-1 的「进入编辑」按钮。
///
/// 三件事，**按这个顺序**（详见模块头那段"基线的生产者"）：
/// ① 持锁：`check_writable`（**同源**的写侧判定 ＋ 恒等于当前这一份）；
/// ② 放锁：读盘（`loader::load`，它会剥 BOM 并做严格 UTF-8 校验）；
/// ③ 持锁：核对代次与身份 → 落 `edit_target` ＋ `baseline_bytes` → 回带文本。
///
/// ⚠️ **已经是编辑态时再调 = 刷新**，不是错误：这正是"外部修改被用户接受之后"
/// 那条路要的语义（重新 begin ⇒ 文本与基线一起换新，`INV-EDIT-06`）。
/// ⚠️ 但它**不是**"回到上一次的缓冲"——旧的未保存内容**不会**被保留，
/// 所以前端**只有在打算丢弃它**时才允许调（那是 `INV-EDIT-06` 那道闸的另一半）。
#[tauri::command]
pub async fn begin_edit(
    state: tauri::State<'_, AppState>,
    generation: u64,
) -> Result<EditGrant, Denied> {
    let t_start = Instant::now();

    // —— 第一段（持锁）：授权。⛔ 这里只有内存操作 ——
    let real = state.with(|s| -> Result<PathBuf, Denied> {
        let current = s.grants.root_generation();
        if generation != current {
            return Err(Denied::stale(generation, current));
        }
        // ⭐ 判据零：必须**有**当前文档（`begin_edit` 不接受路径参数，理由同 `reload_document`）
        let Some(target) = s.current_document.clone() else {
            return Err(Denied::NoDocument);
        };
        // ⭐ 判据一：**同源**的写侧判定（`check_readable` 原样调一遍）
        //    ＋ 恒等于"当前这一份"。⛔ 别在这里另写一遍 canonicalize + roots/files
        //    （`INV-EDIT-02` 前半句）。
        s.grants.check_writable(&target, s.current_document.as_deref())
    })?;

    // —— 第二段（放锁）：读盘 ——
    let real_for_err = real.clone();
    let join = tauri::async_runtime::spawn_blocking({
        let p = real.clone();
        move || loader::load(&p).map_err(|e| Denied::io(&p, e))
    })
    .await;
    let loaded = match join {
        Ok(r) => r?,
        // ⚠️ 与 `render_off_lock` 同一条规矩：线程没了 ≠ 文件读不出来
        Err(e) => return Err(Denied::io(&real_for_err, format!("读取线程没能跑完：{e}"))),
    };

    // ⭐ **信封从字节判定，缓冲从基线产出**——两条都落在**同一份字节**上
    //    （`envelope.rs` 模块头那条"结构性的一致保证"）。
    //    ⚠️ 顺序不能反：先有基线，再有缓冲。若从 `source` 直接做 `normalize`，
    //    那两者就成了"两条会分叉的路"（它们的等价性只能靠单测钉）。
    let envelope = Envelope::detect(&loaded.source, loaded.had_bom);
    let baseline = Envelope::raw_bytes(loaded.source, loaded.had_bom);
    let text = envelope
        .normalize_bytes(&baseline)
        // ⚠️ 结构上不可达（基线出自 `&str`）；写成 `?` 而不是 `unwrap`：
        //    真发生时这里给出的是一条说得清的日志＋可区分的错误，而不是 panic。
        .map_err(|e| Denied::io(&real_for_err, format!("基线不是合法 UTF-8：{e}")))?;

    // —— 第三段（持锁）：核对后**落写授权** ——
    let generation_now = state.with(|s| s.grants.root_generation());
    let grant = state.with(|s| -> Option<EditGrant> {
        if s.grants.root_generation() != generation {
            return None;
        }
        // ⭐ **身份**（与 `reload_document` 同一族判据）：放锁那几毫秒里
        //    用户可能已经切到另一份文档了 ⇒ 这份 `text` **不许**落进会话。
        if s.current_document.as_deref() != Some(real.as_path()) {
            return None;
        }
        s.edit_target = Some(real.clone());
        s.baseline_bytes = Some(baseline);
        Some(EditGrant { real_path: real.display().to_string(), text, envelope })
    });
    let Some(grant) = grant else {
        diag!(
            "▶ begin_edit {} ⚠️ **未提交**（代次 {} vs {} 或身份已变）",
            real.display(),
            generation,
            generation_now
        );
        // ⚠️ 归 `Stale`（⛔ 不是 `Io`）：这是**正常竞态**，前端应当静默丢弃。
        return Err(Denied::stale(generation, generation_now));
    };

    diag!(
        "▶ begin_edit {}（{} 字节，行尾 {:?}{}，整段 {:.1} ms）· ⭐ 写授权已授予",
        grant.real_path,
        grant.text.len(),
        grant.envelope.eol,
        if grant.envelope.bom { "，带 BOM" } else { "" },
        t_start.elapsed().as_secs_f64() * 1000.0
    );
    // ⚠️ 行尾不统一 ⇒ **必须显式提示**（`INV-EDIT-12` ② / §6）。这一行是日志侧的出口，
    //    界面侧由 `envelope.lossy` 驱动那条常驻提示。⛔ 两处都不能省：
    //    日志里没有它，事后就分不清"用户被告知了"和"我们静默规范化了"。
    if grant.envelope.is_lossy() {
        diag!("⚠️ 该文件行尾不统一（含混合行尾或裸 CR）⇒ 保存后将统一为 LF（已在界面常驻提示）");
    }
    Ok(grant)
}

/// ⭐ **退出编辑态**——撤销写授权（`design/0012` §2.4-1 的「退出编辑」按钮）。
///
/// ⚠️ 不返回错误：退一个本来就不在的编辑态**不是错误**
/// （`drop_watch` / 换文档 / 保存失败后的复位都会走到这里，重复调用是常态）。
/// ⛔ 尤其**不许**让"没在编辑态"变成一个前端要处理的失败分支——
/// 那会诱使前端把 `end_edit` 塞进 `try/catch` 里忽略，而它**是**一道安全动作。
#[tauri::command]
pub fn end_edit(state: tauri::State<'_, AppState>) {
    let was = state.with(|s| {
        let was = s.edit_target.is_some();
        // ⚠️ 只清编辑态那一组字段，⛔ 不碰 `current_document` / `watch`
        //    （那是 `drop_watch` 的活儿；两者混起来就是"退编辑顺手把文档也关了"）。
        s.end_edit();
        was
    });
    diag!("▶ end_edit：{}", if was { "写授权已撤销" } else { "本来就不在编辑态" });
}

// ─────────────────────────────────────────────────────────────────────
// ② 预览
// ─────────────────────────────────────────────────────────────────────

/// [`render_preview`] 第一段取到的那几样（**只读**会话）。
struct PreviewPre {
    /// 规范路径（同时也当 `path` 回显——预览没有"请求里的那个路径"）。
    real_path: String,
    doc_dir: String,
    envelope: Envelope,
    outside_roots: bool,
    roots_nonempty: bool,
    /// ⭐ `design/0017`：这份预览属于哪一次打开（**只读回显**，⛔ 不加号）。
    doc_seq: u64,
}

/// ⭐ **读取命令** · 用编辑缓冲渲染右侧预览（`design/0012` §2.1 ② / §2.6）。
///
/// # 它**不碰**会话状态（这一条是 `INV-EDIT-07` 的一半）
///
/// ⛔ 不写 `current_document` / `watch` / `latest_doc_req` / `last_render_stats`，
/// ⛔ 也不读盘。**它只读**三样东西：当前文档的路径（回显用）、信封、两个越权判据。
/// ⚠️ 于是"预览"与"打开/重载"这两条路**不会互相取消对方的渲染**——
/// 它们各自有各自的 `req` 计数器。
///
/// # 为什么它要求"必须在编辑态"
///
/// ⛔ 它**不是**一个"把这段字符串渲染成 HTML"的通用接口（那种接口存在的唯一后果
/// 是给出一条绕过编辑态的渲染路径）。要求 `edit_target == current_document`
/// 之后，它天然只服务于"我正在编辑这一份"这一个场景。
///
/// # 计时口径
///
/// ⚠️ `t1_ms` **恒为 0**：这条路上**没有读盘**（T1 的语义就是"读盘花了多久"）。
/// ⛔ 别把"从前端收文本"的时间算进去充当 T1——那会让两份 payload 的同一字段
/// 含义不同，而 `INV-TIMING-01` 要的正是"一眼看出单位与口径"。
#[tauri::command]
pub async fn render_preview(
    state: tauri::State<'_, AppState>,
    text: String,
    generation: u64,
    req: u64,
) -> Result<DocumentPayload, Denied> {
    let t_start = Instant::now();

    // —— 第一段（持锁）：**只读**取快照 ——
    let pre = state.with(|s| -> Result<PreviewPre, Denied> {
        let current = s.grants.root_generation();
        if generation != current {
            return Err(Denied::stale(generation, current));
        }
        let Some(real) = s.current_document.clone() else {
            return Err(Denied::NoDocument);
        };
        // ⭐ 必须在编辑态，且编辑的就是当前这一份（见上"为什么"）
        if s.edit_target.as_deref() != Some(real.as_path()) {
            return Err(Denied::not_authorized(&real));
        }
        // ⭐ 信封**从基线判定**（⛔ 不让前端回传一个"它以为的信封"）：
        //    这样"预览显示的行尾提示"与"保存时实际会写出的行尾"**必然是同一个来源**。
        let Some(baseline) = s.baseline_bytes.as_ref() else {
            // 编辑态在、基线不在 ⇒ 状态被改坏了。⛔ 不猜一个默认值，直接说"没有当前文档"。
            return Err(Denied::NoDocument);
        };
        let envelope = Envelope::detect_raw(baseline);
        Ok(PreviewPre {
            real_path: real.display().to_string(),
            doc_dir: real.parent().unwrap_or(Path::new("")).display().to_string(),
            envelope,
            outside_roots: s.grants.has_roots() && !s.grants.is_inside_roots(&real),
            roots_nonempty: s.grants.has_roots(),
            doc_seq: s.doc_seq,
        })
    })?;

    // —— 第二段（放锁）：渲染。⚠️ 10 MB 档 0.9–6.2 s，⛔ 不许占着异步运行时的 worker ——
    let source_bytes = text.len();
    let join =
        tauri::async_runtime::spawn_blocking(move || render_source(&text)).await;
    let r = match join {
        Ok(r) => r,
        Err(e) => {
            return Err(Denied::io(&pre.real_path, format!("渲染线程没能跑完：{e}")));
        }
    };

    // ⚠️ 公式计数**每次预览都打**（含全零），理由同 `open_document`：
    //    日志里"没有这一行"与"这一行全是零"必须是两件事（`INV-MATH-05`）。
    //    ⚠️ 但预览**不写** `last_render_stats`——那是"提交过的文档渲染"的观测量，
    //    让预览去覆盖它会让 `report_status` 报出一个从未上屏的数（`INV-EDIT-07`）。
    diag!(
        "▶ render_preview {}（T2 {:.1} / T3 {:.1} ms，整段 {:.1} ms，{} 字节）· 公式 {}",
        pre.real_path,
        r.t2_ms,
        r.t3_ms,
        t_start.elapsed().as_secs_f64() * 1000.0,
        source_bytes,
        r.stats.summary()
    );

    Ok(DocumentPayload {
        generation,
        req,
        // ⚠️ 预览没有"请求里的那个路径"（它不收路径参数）⇒ `path` 与 `real_path` 同值。
        path: pre.real_path.clone(),
        real_path: pre.real_path,
        doc_dir: pre.doc_dir,
        html: r.html,
        toc: r.toc,
        outside_roots: pre.outside_roots,
        roots_nonempty: pre.roots_nonempty,
        // ⚠️ **恒 0**：这条路上没有读盘（见上"计时口径"）
        t1_ms: 0.0,
        t2_ms: r.t2_ms,
        t3_ms: r.t3_ms,
        source_bytes,
        html_bytes: r.html_bytes,
        ast_nodes: r.ast_nodes,
        toc_entries: r.toc_entries,
        had_bom: pre.envelope.bom,
        // ⭐ Q22 规模闸门的两个数。⚠️ 预览这一侧同样要送——
        //    编辑态下用户正盯着的就是这一栏，"预览里那几块为什么没颜色"
        //    是同一个问题，⛔ 不能只在打开那条路上答。
        code_highlighted: r.stats.code_highlighted,
        code_unhighlighted: r.stats.code_unhighlighted(),
        doc_seq: pre.doc_seq,
        envelope: pre.envelope,
    })
}

// ─────────────────────────────────────────────────────────────────────
// ③ 保存（⭐ 唯一的写路径）
// ─────────────────────────────────────────────────────────────────────

/// [`save_document`] 的返回。
#[derive(Debug, Serialize)]
pub struct SaveOutcome {
    /// 写的是哪一份（规范路径）。
    pub path: String,
    /// ⭐ `false` = **no-op 短路**（还原后的字节与磁盘原文逐字节相同 ⇒ ⛔ 没写盘）。
    ///
    /// ⚠️ 用户看得见这件事（界面文案是「无改动」而不是「已保存」）：
    /// 两者对用户的含义不同——后者会让人以为文件的时间戳动了。
    pub written: bool,
    /// 写出的字节数（`written == false` 时＝磁盘原有字节数）。
    pub bytes: usize,
    /// 回显请求号（前端用它丢弃迟到的响应）。
    pub req: u64,
    /// 整段耗时（毫秒）。
    pub ms: f64,
}

/// 第一段（持锁）取到的、第二段要用的那几样。
struct SavePre {
    real: PathBuf,
    /// ⭐ **内容级基线**（§2.4-3）：第二段的冲突检查比的就是它。
    baseline: Vec<u8>,
    /// 信封（由基线判定，见 `envelope.rs` 模块头）。
    envelope: Envelope,
}

/// 第二段（放锁）的产物。
///
/// ⚠️ `Debug` 是给测试用的（`unwrap_err` 要求 `Ok` 那侧可打印）——
/// `bytes` 里可能有整份文档，但这条 `Debug` **只在测试失败信息里**出现。
#[derive(Debug)]
struct WriteDone {
    written: bool,
    bytes: Vec<u8>,
    /// ⭐ **刚写下去那份的指纹**（`written == false` 时是 `None`：没写就没有"自写"可言）。
    ///
    /// ⚠️ 它在**放锁的那一段**里、紧跟着 `rename` 之后取——这是 §2.1 ④a 的时序要求：
    /// 实测"事件到达"比 `rename` 晚 3.4–11.6 ms，而登记越早越安全（`kb/0020`）。
    finger: Option<(u64, i64)>,
}

/// ⭐ **写命令** · 保存当前编辑缓冲。**本项目唯一的写盘入口**（`INV-EDIT-10`）。
///
/// # 时序就是设计本身（`design/0012` §2.4-2）
///
/// ```text
/// ① 持锁：check_writable ＋ 编辑态判据 ＋ 单飞闸 → 置 save_inflight（**开始**就置）
/// ② 放锁：a 重读磁盘 → 与基线逐字节比对    ← 冲突检查
///         b 关信封（LF → Eol/BOM）
///         c no-op 短路
///         d 写 <同目录>/<name>.rmd-tmp-<rand>
///         e set_permissions → fs::rename
/// ③ 持锁：登记 self_write、清 save_inflight、基线 ← 本次写出的字节
/// ```
///
/// ⛔ **`reviews` 第 3 条点名的那件事**：上面**所有"要不要写"的判断**
/// （①②③a③b③c）**都发生在 `rename` 之前**。`rename` 之后只登记事实，
/// **⛔ 不再做任何检查**——"写完了再复核身份"在结构上阻止不了错误落盘，
/// 它只会让失败看起来像成功。
///
/// ⚠️ 第三段**必须无条件跑到**（成功/失败都清 `save_inflight`）——
/// 所以它的形态是"先清标记，再看结果"，⛔ 不是 `?` 一路短路出去。
#[tauri::command]
pub async fn save_document(
    state: tauri::State<'_, AppState>,
    text: String,
    generation: u64,
    req: u64,
) -> Result<SaveOutcome, Denied> {
    let t_start = Instant::now();

    // —— 第一段（持锁）：判据 → 落"在途"标记 ——
    let pre = state.with(|s| -> Result<SavePre, Denied> {
        let current = s.grants.root_generation();
        if generation != current {
            return Err(Denied::stale(generation, current));
        }
        // ⚠️ `save_document` **不收路径参数**：目标恒等于 `current_document`
        //    （`INV-EDIT-02` 前半句）。⛔ 路径一旦由前端再传一次，就有两个说法。
        let Some(target) = s.current_document.clone() else {
            return Err(Denied::NoDocument);
        };
        // 判据一：**同源**的写侧判定 ＋ 恒等于当前这一份
        let real = s.grants.check_writable(&target, s.current_document.as_deref())?;
        // ⭐ 判据二：**用户确实在编辑它**（`edit_target` 由 `begin_edit` 产生）。
        //    ⛔ 两道判据都要，⛔ 不许合并：第一道管"这条路径本来就授权过吗"，
        //    第二道管"用户现在真的在编辑它吗"（`INV-EDIT-02`）。
        if s.edit_target.as_deref() != Some(real.as_path()) {
            return Err(Denied::not_authorized(&real));
        }
        // ⭐ 判据三：**单飞**（§2.4-4）：已有保存在途 ⇒ 直接拒，⛔ 不排队。
        //    排队 = 两次写、两份 `rename`，而第二份的内容可能基于**已被第一份改掉的**基线。
        if s.inflight_active() {
            return Err(Denied::save_in_flight(&real));
        }
        let Some(baseline) = s.baseline_bytes.clone() else {
            // 编辑态在、基线不在 ⇒ 状态被改坏了。⛔ 宁可不写，也不拿一个错的参照物去比。
            return Err(Denied::NoDocument);
        };
        let envelope = Envelope::detect_raw(&baseline);
        // ⭐ **在"开始"就置**（§2.1 ④a 第 1 条）——⛔ 不是写完才置：
        //    它同时是"给 watcher 的延迟复核窗口"，而那个窗口必须在 `rename` **之前**就打开。
        s.save_inflight = Some(Instant::now());
        Ok(SavePre { real, baseline, envelope })
    })?;

    let real = pre.real.clone();

    // —— 第二段（放锁）：⛔ 这里是**唯一**动磁盘的地方 ——
    let join = tauri::async_runtime::spawn_blocking(move || {
        write_off_lock(&pre.real, &pre.baseline, pre.envelope, &text)
    })
    .await;
    let result = match join {
        Ok(r) => r,
        Err(e) => Err(Denied::io(&real, format!("写盘线程没能跑完：{e}"))),
    };

    // —— 第三段（持锁）：登记事实 ＋ 收尾。⚠️ 成功失败都走到这里 ——
    let ms = t_start.elapsed().as_secs_f64() * 1000.0;
    let out = state.with(move |s| -> Result<SaveOutcome, Denied> {
        // ⭐ **先清在途标记**（§2.4-2 ④：成功失败都清）。
        //    ⚠️ 它不是"要不要写"的判断，是**登记事实**，所以放在所有分支之前。
        //    漏清它的后果不是丢数据（`INFLIGHT_MAX` 会给它封顶），
        //    而是那 10 s 内真正的外部修改要多走一次延迟复核。
        s.save_inflight = None;

        let done = match result {
            Ok(d) => d,
            // ⚠️ 失败：⛔ **不动基线、不动 self_write**（原文件一个字节没变，
            //    基线仍然准确）。只把错误原样交上去——前端按 `kind` 分支
            //    （`conflict` / `io` / `not_authorized` 的文案各不相同，`design/0012` §6）。
            Err(e) => return Err(e),
        };

        // ⭐ `rename` **之后**只剩登记。⚠️ 但"这份结果还算不算数"仍要判——
        //    放锁那几毫秒里，授权可能被收回、用户可能已经切走了。
        //    ⚠️ 注意这里与"要不要写"是**两件事**：写已经发生了，
        //    我们判的只是"要不要把这件事实记进会话 / 要不要让前端以为它成功了"。
        let identity_ok = s.grants.root_generation() == generation
            && s.current_document.as_deref() == Some(real.as_path());
        if !identity_ok {
            // ⚠️ 文件**已经写出去了**，但会话已经不认这一份。
            //    ⇒ 基线**不能**更新（它属于一份我们不再显示的文档），
            //    并按 `Stale` 让前端静默丢弃这次结果（与 `reload_document` 同一条处置）。
            s.baseline_bytes = None;
            return Err(Denied::stale(generation, s.grants.root_generation()));
        }

        if let Some(f) = done.finger {
            // ⭐ **登记自写指纹**（§2.1 ④）：watcher 收到自己的事件时靠它少做一次重载。
            //    ⚠️ 它**只**服务这件事，⛔ 不承担"是否被外部修改"的判定（那个在冲突检查里）。
            s.self_write = Some(f);
        }
        let bytes = done.bytes.len();
        // ⭐ **基线 ← 本次写出的字节**（`INV-EDIT-04` ①）：下一次保存要比的参照物
        //    必须换成我们刚写下去的东西，否则用户第二次 `⌘S` 会撞上一个假冲突。
        s.baseline_bytes = Some(done.bytes);

        Ok(SaveOutcome {
            path: real.display().to_string(),
            written: done.written,
            bytes,
            req,
            ms,
        })
    })?;

    diag!(
        "▶ save_document {}（{}，{} 字节，整段 {:.1} ms）· 自写指纹已登记",
        out.path,
        if out.written { "已写出" } else { "**无改动**（no-op 短路，⛔ 没动磁盘）" },
        out.bytes,
        out.ms
    );
    Ok(out)
}

/// 第二段：**放锁**的冲突检查 ＋ 原子写。⚠️ 这是全项目**唯一**写盘的地方。
///
/// ⛔ 调用方必须保证：进了这个函数就**不再回头做检查**（见 `save_document` 的时序）。
fn write_off_lock(
    real: &Path,
    baseline: &[u8],
    envelope: Envelope,
    buffer: &str,
) -> Result<WriteDone, Denied> {
    // ── ③a 冲突检查：**内容级**（§2.4-3 / `INV-EDIT-04` ①）──
    let disk = match std::fs::read(real) {
        Ok(b) => b,
        // ⚠️ "保存期间文件被外部删除"归 `NotFound`（§6 那一行）：文案是"文件已不存在，未保存"，
        //    而正确。⛔ 别归成 `Io`——那会让用户去找一个权限问题。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Denied::not_found(real)),
        Err(e) => return Err(Denied::io(real, e)),
    };
    if disk != baseline {
        // ⛔ **不写**。⚠️ 文案是"保存已取消"，⛔ 不许说成"保存失败"——
        //    文件好好的，是我们**拒绝覆盖别人的改动**（§6）。
        return Err(Denied::conflict(real));
    }

    // ── ③b 关信封：缓冲（LF）→ 行尾 ＋ BOM ──
    let bytes = envelope.restore(buffer);

    // ── ③c no-op 短路 ──
    // ⭐ 用户一个字都没改时，**这里就返回了**——⛔ 不写盘。
    //    这是 §2.4-5 那条"`Lf`/`CrLf` 可逐字节回写"的**唯一**判据来源：
    //    能逐字节相等，所以这里能相等；⛔ 不是靠我们相信缓冲。
    if bytes == disk {
        return Ok(WriteDone { written: false, bytes, finger: None });
    }

    // ── ③d 原文件的权限位（原样继承）──
    let meta = std::fs::metadata(real).map_err(|e| Denied::io(real, e))?;
    let perms = meta.permissions();
    if perms.readonly() {
        // ⚠️ 这一条**不是**"OS 会拒绝我们"，而是**我们主动退让**：
        //    POSIX 的 `rename` 只要求**目录**可写 ⇒ 一个 `0444` 的文件
        //    放在可写目录里**是能被原子替换掉的**，替换完仍是 `0444`。
        //    ⛔ 但那是"用户明确标了只读，我们照写"——不做。
        //    ⭐ §6 预期的结果（"保存失败：文件不可写"）由此**结构上**成立，
        //    而不是依赖某个平台上 `rename` 恰好被拒（那个假设不成立，见 §7 步骤 0g）。
        return Err(Denied::io(real, "文件是只读的：保存已取消（去掉只读位后重试）"));
    }

    // ── ③e 写临时文件（**同目录**，原子替换的前提）──
    let tmp = tmp_path(real);
    let wrote = write_tmp(&tmp, &bytes, &perms).and_then(|()| std::fs::rename(&tmp, real));
    if let Err(e) = wrote {
        // ⭐ `INV-EDIT-05`：⛔ **不许留下一份 `*.rmd-tmp-*` 残骸**。
        //    原文件此刻**一个字节没变**（我们只碰过 tmp），失败是"什么都没发生"。
        let _ = std::fs::remove_file(&tmp);
        return Err(write_err(real, e));
    }

    // ── ③f 登记指纹（§2.1 ④a：越早越好，实测"事件到达"比 rename 晚 3.4–11.6 ms）──
    let finger = crate::fs::finger(real);
    Ok(WriteDone { written: true, bytes, finger })
}

/// 建临时文件并写入 ＋ 继承权限位。
///
/// ⚠️ 用 `create_new(true)` 而不是 `create(true)`：后者会**悄悄截断**一个已存在的同名文件。
/// 虽然那个名字理论上只有我们能产生（`pid` ＋ 单调计数器 ＋ 纳秒），
/// 但"理论上不会撞"不是不检查的理由——撞上就是删掉别人的文件。
///
/// ⚠️ 先按 `0600` 建，**再** `set_permissions`：反过来的话，从建文件到改权限
/// 那一瞬里，临时文件比原文件**更宽**（原文件可能是一份 `0600` 的私密笔记）。
/// ⛔ 这个窗口只有微秒级，但它是一条**内容泄露**的窗口，而修它不要钱。
///
/// ⚠️ **不做 `sync_all`**（`design/0012` §6 明写接受）：`fsync` 的代价在大文件上
/// 不可忽略，而 `.md` 不是事务日志。⚠️ 磁盘满仍然能在 `write_all` 上被抓住
/// （`File` 是无缓冲的，`ENOSPC` 当场返回）——所以这里省掉的只是"崩溃时的持久性"。
fn write_tmp(tmp: &Path, bytes: &[u8], perms: &std::fs::Permissions) -> std::io::Result<()> {
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
    std::fs::set_permissions(tmp, perms.clone())
}

/// 临时文件路径：`<同目录>/<name>.rmd-tmp-<pid>-<seq>-<ns>`。
///
/// ⚠️ **必须同目录**：`rename` 只在同一个文件系统内是原子的，而 `/tmp` 很可能是另一个卷。
/// ⚠️ 三段随机化（pid ＋ 进程内单调计数 ＋ 纳秒）是为了"同一进程内两次保存"与
/// "两个 rmd 实例同时存同一份文件"都不撞。
/// ⚠️ 原文件名**截断到 100 字符**：文件名上限（macOS/Linux 都是 255 字节）是按**字节**算的，
/// 一个 250 字节的中文长文件名再拼上后缀就会 `ENAMETOOLONG`——
/// 那会表现为"这个文件莫名其妙存不了"，而真正的原因是我们的文件名拼得太长。
fn tmp_path(real: &Path) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let ns = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let name = real.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let short: String = name.chars().take(100).collect();
    real.with_file_name(format!("{short}.rmd-tmp-{}-{n}-{ns}", std::process::id()))
}

/// 把写盘的 `io::Error` 翻译成前端拿得到、且**说清了是哪儿**的拒绝。
///
/// ⚠️ §6 明写"**要在提示里说清是『目录不可写』**，否则用户改文件权限怎么试都不行"——
/// 这是原子替换**独有**的失败面（直接覆写不会有）。⭐ 所以这一条不是文案讲究，
/// 它是"用户能不能自己解决"的分界。
fn write_err(real: &Path, e: std::io::Error) -> Denied {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        let dir = real.parent().map(|p| p.display().to_string()).unwrap_or_default();
        Denied::io(real, format!("目录不可写（{dir}）：原子替换需要该目录的写权限（{e}）"))
    } else {
        Denied::io(real, format!("写盘失败：{e}"))
    }
}

// ─────────────────────────────────────────────────────────────────────
// 测试（⚠️ 这一段是 `design/0012` §7 步骤 **0e** 的自动那一半）
// ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // ⚠️ 本模块只在 `--features gui` 下编译 ⇒ 跑法：
    //    `cargo test --release --features gui commands::edit`
    //    （`tools/editor-fidelity.sh` 就是这句话的包装＋标记断言）。

    /// 一次性测试目录。⛔ 不引入 `tempfile` 依赖（本项目钉版本、少依赖）。
    ///
    /// ⚠️ 这是本仓库的**第三份**拷贝（另两份在 `fs/grants.rs` / `fs/tree.rs` 的测试模块里）。
    /// ⭐ 刻意**不做**公共测试工具模块：那三份各自跟着自己在测的东西走
    /// （这份多两个"要不要写盘"的用法：权限位、目录权限），
    /// 抽公共层会让"某个测试想多建一个子目录"变成改公共 API。
    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(tag: &str) -> Self {
            // ⚠️ 用进程 id + 参数名做唯一性，避免同一个测试二进制里的并行测试互撞
            let base = std::env::temp_dir().join(format!("rmd-edit-{}-{tag}", std::process::id()));
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

    /// 跑一遍**真实保存路径的第二段**，回到"磁盘上现在是什么"。
    ///
    /// ⚠️ 它**不是**模拟：调的就是 [`write_off_lock`]（唯一写盘的那个函数）。
    /// 前后两件事（读原文、判定信封）也走 [`begin_edit`] 的同一条路
    /// （`loader::load` → `detect` / `raw_bytes` / `normalize_bytes`）。
    fn round_trip(real: &Path, edit: impl FnOnce(&str) -> String) -> Result<WriteDone, Denied> {
        let l = loader::load(real).expect("测试夹具必须能读");
        let envelope = Envelope::detect(&l.source, l.had_bom);
        let baseline = Envelope::raw_bytes(l.source, l.had_bom);
        let buffer = envelope.normalize_bytes(&baseline).expect("基线必然是合法 UTF-8");
        let edited = edit(&buffer);
        write_off_lock(real, &baseline, envelope, &edited)
    }

    /// 目录里还剩几个 `*.rmd-tmp-*`（`INV-EDIT-05` 的判据）。
    ///
    /// ⚠️ 它按**名字**找，⛔ 不是"数文件个数"——那样守不住
    /// "失败时清理的是**哪一个**"这件事。
    fn 残骸数(dir: &Path) -> usize {
        fs::read_dir(dir)
            .map(|it| {
                it.filter_map(Result::ok)
                    .filter(|e| e.file_name().to_string_lossy().contains(".rmd-tmp-"))
                    .count()
            })
            .unwrap_or(0)
    }

    // ── ⭐ 0e 主体：7 类样本 ──

    /// 一类样本的**期望**，⚠️ 全部**手写**——⛔ 不用被测代码算期望值。
    struct Fid {
        name: &'static str,
        /// 磁盘原文。
        raw: &'static [u8],
        /// 改一个字之后的**期望字节**。
        ///
        /// ⚠️ `None` = 这一档（`Eol::Other`）**不承诺逐字节**（§2.4-5），
        /// 那时改判"必须收敛成纯 LF"（下面的断言分两支）。
        after_edit: Option<&'static [u8]>,
    }

    /// 7 类样本。⚠️ 改动口径是**统一的**：把缓冲的**第一个字符**换成 `A`
    /// （空文件那一类没有字符可换，就**插入**一个 `A`）——这样期望值可以说是
    /// "原文的前 1 个字符变了"，而打印出来一眼能看出是**哪一处**变了。
    const FID: &[Fid] = &[
        Fid { name: "lf", raw: b"a\nb\n", after_edit: Some(b"A\nb\n") },
        // ⭐ 改的是**一个字**，而期望值里那些 `\r` 必须还在
        Fid { name: "crlf", raw: b"a\r\nb\r\n", after_edit: Some(b"A\r\nb\r\n") },
        Fid {
            name: "bom+crlf",
            raw: b"\xEF\xBB\xBFa\r\nb\r\n",
            // ⭐ BOM 三个字节必须原样带回来
            after_edit: Some(b"\xEF\xBB\xBFA\r\nb\r\n"),
        },
        Fid {
            // ⚠️ 这一条同时压三件事：无尾换行、多字节字符、`Lf` 档不走 `normalize` 的快路径
            name: "no-trailing-newline",
            raw: b"# \xe6\xa0\x87\xe9\xa2\x98\n\xe6\xad\xa3\xe6\x96\x87",
            after_edit: Some(b"A \xe6\xa0\x87\xe9\xa2\x98\n\xe6\xad\xa3\xe6\x96\x87"),
        },
        // ⭐ 边界：空文件改一个字（⛔ 没有行尾可谈）
        Fid { name: "empty", raw: b"", after_edit: Some(b"A") },
        Fid { name: "mixed", raw: b"a\r\nb\nc", after_edit: None },
        Fid { name: "bare-cr", raw: b"a\rb", after_edit: None },
    ];

    /// ⭐⭐ **0e**：7 类样本各跑一遍「打开 → 改一个字 → 保存」，前 5 类**逐字节**。
    ///
    /// ⚠️ 判据的两支**必须分开**（`INV-EDIT-12` ①/②）：
    /// - `Lf` / `CrLf`：期望值**逐字节**相等——这是"不改用户的文件"这句承诺的全部内容；
    /// - `Other`：⛔ **不要求**相等，但**必须**（a）没有裸 `\r`（b）文本内容 = LF 规范化后的缓冲。
    ///   ⚠️ 把它们也写成"逐字节相等"是最容易犯的错——那会让这条测试**恒绿且恒假**。
    ///
    /// ⭐ 每一类**打一行 `RMD_FIDELITY`**（要 `--nocapture` 才看得到）：它的用处是让
    /// `tools/editor-fidelity.sh` **数得出 7 类都在**——⛔ 否则"某个样本被静默跳过"
    /// 与"全部通过"在输出上长得一模一样（本仓库为这件事吃过亏，见 `tools.md`）。
    #[test]
    fn 七类样本改一个字之后的逐字节保真() {
        let t = TestDir::new("fidelity");
        for s in FID {
            let p = t.path.join(format!("{}.md", s.name));
            fs::write(&p, s.raw).unwrap();
            // "把第一个字符换成 A"（空缓冲则插入一个 A，见 FID 的文档）
            let done = round_trip(&p, |buf| match buf.chars().next() {
                Some(_) => format!("A{}", &buf[buf.chars().next().unwrap().len_utf8()..]),
                None => "A".to_string(),
            })
            .unwrap_or_else(|e| panic!("样本 {}：保存被拒 {e}", s.name));
            assert!(done.written, "样本 {}：改过字却报成 no-op", s.name);

            let got = fs::read(&p).unwrap();
            match s.after_edit {
                Some(want) => {
                    assert_eq!(
                        got,
                        want,
                        "样本 {}：逐字节不符\n  期望 {:?}\n  实际 {:?}",
                        s.name,
                        String::from_utf8_lossy(want),
                        String::from_utf8_lossy(&got)
                    );
                    eprintln!(
                        "RMD_FIDELITY class={} in={} out={} exact=yes",
                        s.name,
                        s.raw.len(),
                        got.len()
                    );
                }
                None => {
                    assert!(!got.contains(&b'\r'), "样本 {}：`Other` 档写出的字节里出现了 \\r", s.name);
                    // ⭐ 与原文的**字符**内容一致（只差那一个字）
                    let want = String::from_utf8_lossy(s.raw)
                        .replace("\r\n", "\n")
                        .replace('\r', "\n");
                    let rest = &want[want.chars().next().unwrap().len_utf8()..];
                    assert_eq!(
                        String::from_utf8_lossy(&got),
                        format!("A{rest}"),
                        "样本 {}：`Other` 档的字符内容也不该变（只该统一行尾）",
                        s.name
                    );
                    eprintln!(
                        "RMD_FIDELITY class={} in={} out={} exact=no lf_only=yes",
                        s.name,
                        s.raw.len(),
                        got.len()
                    );
                }
            }
            // ⛔ 不留残骸（`INV-EDIT-05` 的另一半）
            assert_eq!(残骸数(&t.path), 0, "样本 {} 留下了临时文件", s.name);
        }
    }

    /// ⭐ no-op 短路（§2.4-2 ③c）：**不改就直接存 ⇒ 一个字节都不许动**。
    ///
    /// ⚠️ 判据不是"返回 `written: false`"就够了——**必须**同时看
    /// ① mtime 没变（证明真没写）② 没有临时文件（证明没走"写了再比"那种假短路）。
    ///
    /// ⚠️ 这一条**同时是保真探针**：`0e` 的原文里那条要求是"磁盘 `md5` 不变"，
    /// 而 mtime 未变**强于** md5 未变（"没写"必然 ⇒ "md5 相同"，反之不然）。
    /// ⭐ 这里不用 md5 是因为"算一份摘要"要**再读一次盘**，
    /// 而 `fs::read` 的结果上面已经逐字节比过了——同一件事算两遍只会让判据更多、不是更准。
    #[test]
    fn 不改动直接保存不碰磁盘() {
        let t = TestDir::new("noop");
        let p = t.path.join("a.md");
        let raw: &[u8] = b"a\r\nb\r\n";
        fs::write(&p, raw).unwrap();
        let before = fs::metadata(&p).unwrap().modified().unwrap();
        let done = round_trip(&p, |buf| buf.to_string()).expect("no-op 不该被拒");
        assert!(!done.written, "没改字却报成写出去了");
        assert_eq!(fs::read(&p).unwrap(), raw);
        let mtime_same = fs::metadata(&p).unwrap().modified().unwrap() == before;
        assert!(
            mtime_same,
            "no-op 短路不该动 mtime —— 动了就说明 ③c 那一步没生效"
        );
        assert_eq!(残骸数(&t.path), 0, "no-op 短路径不该产生临时文件");
        eprintln!(
            "RMD_FIDELITY class=noop in={} out={} written=no bytes_same=yes mtime_same=yes",
            raw.len(),
            done.bytes.len()
        );
    }

    /// ⭐ 冲突（§2.4-3 / `INV-EDIT-04` ①）：磁盘变了 ⇒ **拒写**，且**别人的改动还在**。
    #[test]
    fn 磁盘内容变了就拒写并保留别人的版本() {
        let t = TestDir::new("conflict");
        let p = t.path.join("a.md");
        fs::write(&p, b"baseline\n").unwrap();
        let l = loader::load(&p).unwrap();
        let envelope = Envelope::detect(&l.source, l.had_bom);
        let baseline = Envelope::raw_bytes(l.source, l.had_bom);
        // ⚠️ 模拟"别人在我们编辑期间改了这份文件"
        fs::write(&p, "别人写的\n").unwrap();
        let err = write_off_lock(&p, &baseline, envelope, "我改的\n").unwrap_err();
        assert!(matches!(err, Denied::Conflict { .. }), "应当是冲突，实际 {err}");
        assert_eq!(fs::read(&p).unwrap(), "别人写的\n".as_bytes(), "⛔ 别人的改动被覆盖了");
        assert_eq!(残骸数(&t.path), 0);
    }

    /// ⭐ 只读文件（`chmod 444`）：⛔ **拒绝**，且原文件一个字节不变（`INV-EDIT-05`）。
    ///
    /// ⚠️ 这一条**不能指望 POSIX 拦住我们**：`rename` 只要求**目录**可写，
    /// 所以一个 `0444` 的文件放在可写目录里**是能被原子替换掉的**——
    /// 拒绝是 [`write_off_lock`] 里那次**显式**的 `perms.readonly()` 判定。
    /// （§7 步骤 0g 要在真机上把这条"本来能写"的观察记下来。）
    #[test]
    fn 只读文件被拒且原文件不变() {
        use std::os::unix::fs::PermissionsExt;
        let t = TestDir::new("readonly-file");
        let p = t.path.join("a.md");
        fs::write(&p, b"a\n").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o444)).unwrap();
        let Err(err) = round_trip(&p, |_| "A\n".to_string()) else {
            // ⚠️ 以 root 跑测试时这一条测不出来（root 无视权限位）。**如实说，⛔ 不静默跳过。**
            eprintln!("⚠️ 只读文件那条跳过了：本次以 root 运行（root 无视 0444）");
            return;
        };
        assert!(err.to_string().contains("只读"), "提示必须说清是『文件只读』，实际 {err}");
        assert_eq!(fs::read(&p).unwrap(), b"a\n", "只读文件被改了");
        assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o444);
        assert_eq!(残骸数(&t.path), 0, "失败路径必须清掉临时文件");
    }

    /// ⭐ 只读**目录**（文件本身可写）：提示必须说清是**目录**不可写（§6 点名的那一条）。
    #[test]
    fn 只读目录的提示要说清是目录不可写() {
        use std::os::unix::fs::PermissionsExt;
        let t = TestDir::new("readonly-dir");
        let d = t.path.join("sub");
        fs::create_dir(&d).unwrap();
        let p = d.join("a.md");
        fs::write(&p, b"a\n").unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o555)).unwrap();
        let r = round_trip(&p, |_| "A\n".to_string());
        // ⚠️ **先**把权限还回去，否则 `TestDir::drop` 删不掉这个目录（下一轮测试会撞上残留）
        fs::set_permissions(&d, fs::Permissions::from_mode(0o755)).unwrap();
        let Err(err) = r else {
            eprintln!("⚠️ 只读目录那条跳过了：本次以 root 运行（root 无视 0555）");
            return;
        };
        let msg = err.to_string();
        assert!(
            msg.contains("目录不可写"),
            "提示必须说清是『目录』不可写（否则用户只会去改文件权限，怎么试都不行），实际 {msg}"
        );
        assert_eq!(fs::read(&p).unwrap(), b"a\n", "失败路径不该动原文件");
    }

    /// ⭐ 「保存期间文件被外部删除」归 `NotFound`（§6 那一行）。
    ///
    /// ⚠️ 归 `Io` 会让用户去找一个**权限问题**，而真正的事是"文件没了"。
    #[test]
    fn 保存期间文件被删掉归为找不到() {
        let t = TestDir::new("vanished");
        let p = t.path.join("a.md");
        fs::write(&p, b"a\n").unwrap();
        let l = loader::load(&p).unwrap();
        let envelope = Envelope::detect(&l.source, l.had_bom);
        let baseline = Envelope::raw_bytes(l.source, l.had_bom);
        fs::remove_file(&p).unwrap();
        let err = write_off_lock(&p, &baseline, envelope, "A\n").unwrap_err();
        assert!(matches!(err, Denied::NotFound { .. }), "应当是找不到，实际 {err}");
        assert_eq!(残骸数(&t.path), 0, "文件没了也不该留下我们的临时文件");
    }

    /// ⭐ 权限位**继承**（§2.4-2 ③e）：`0640` 的文件存完还是 `0640`。
    ///
    /// ⚠️ 少了 `set_permissions` 那一步，表现是"保存一次之后权限变成 `0600`"——
    /// 而 `0600` 恰好更严，所以**不会有人报 bug**，直到某个同步/备份工具读不动它。
    #[test]
    fn 写出的新文件继承原来的权限位() {
        use std::os::unix::fs::PermissionsExt;
        let t = TestDir::new("perms");
        let p = t.path.join("a.md");
        fs::write(&p, b"a\n").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();
        round_trip(&p, |_| "A\n".to_string()).expect("应当写得进去");
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o640,
            "权限位没继承 —— 换了个文件就等于顺手改了它的权限"
        );
    }

    /// ⭐ 临时文件的名字**不出现在**目标目录里被用户看见的那一份旁边？
    /// ⇒ 反过来问：写成功之后目录里**只剩**原文件那一份。⚠️ 与 `残骸数` 一起构成
    /// "我们不往用户的目录里留东西"这条判据（`INV-EXT-02` 的替代口径，见 `design/0012` §10）。
    #[test]
    fn 写成功之后目录里不多出文件() {
        let t = TestDir::new("no-litter");
        let p = t.path.join("a.md");
        fs::write(&p, b"a\n").unwrap();
        round_trip(&p, |_| "A\n".to_string()).expect("应当写得进去");
        let names: Vec<String> = fs::read_dir(&t.path)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["a.md".to_string()], "目录里多出了东西：{names:?}");
    }
}


