//! 打开 / 重载 / 监视一份文档。**读取命令**（⛔ 不改授权，`INV-FS-04`）。
//!
//! ⚠️ 与批 1 的差别只有一处，但它是根本性的：**这里接路径参数了**。
//! 批 1 的"前端永不传路径"被 `design/0003` §2.1.2 (2) 换成授权模型——
//! 路径可以传，但**每一条**都必须过 [`SessionGrants::check_readable`]，
//! 而 [`super`] 模块头说明了为什么这同样是结构性的（没有第二条读盘入口）。
//!
//! # 三段计时（`design/0002` §7.3.2）
//!
//! T1 读盘 / T2 解析 / T3 渲染，口径与 CLI `bench` **逐段一致**（`INV-SINGLE-01`）。
//! ⚠️ 行偏移索引**没有编号**（设计漏了），这里不计时、也不还给前端——
//! 只为让分段与 CLI `bench` 对齐。
//!
//! # ⭐ 三段式锁（`design/0006` §2.1 ⑤ / `INV-EXT-08`）
//!
//! `open_document` / `reload_document` **都是 `async fn`**，而且各自的体内
//! **持锁 → 放锁 → 再持锁**：
//!
//! ```text
//! ① 持锁：查代次 → check_readable → 记下要读的那份路径      （只有内存操作）
//! ② 放锁：读盘 + 解析 + 渲染                                （3.4 s 的那一段）
//! ③ 持锁：核对代次 + 请求号 + 身份 → 提交
//! ```
//!
//! 三件事各自解决一个真问题，⛔ 少一件都不行：
//!
//! 1. **为什么必须 `async`**：同步命令**不被 spawn**，直接在
//!    Tauri 的主线程上跑完（`docs/kb/0018`）⇒ 一次 10 MB 的渲染 = **全窗口卡死 3.4 s**，
//!    连侧边栏都点不动。
//! 2. **为什么光 `async` 不够**：`async` 只换线程、**不解除锁**（`docs/kb/0018`）。
//!    渲染若仍在临界区里，卡住的就不是界面而是**整条 IPC**——
//!    连 `notify` 的回调都得排队等它（回调要取同一把锁，见 `external::watch::on_change`）。
//! 3. **为什么第三段还要再查一次**：放锁那几秒里，世界会变——
//!    授权可能被收回（代次变了）、用户可能又开了另一份文档（请求号变了）、
//!    同根下可能切了文档（代次没变，但 `current_document` 变了，`INV-EXT-07`）。
//!    ⛔ **只靠第一段那一次检查是典型的 TOCTOU**。
//!
//! ⚠️ 提交失败返回 [`Denied::Stale`]，前端**静默丢弃**——那是正常竞态，不是错误。

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;

use crate::commands::{AppState, Session};
use crate::document::envelope::Envelope;
use crate::document::parser::ParseOpts;
use crate::document::{loader, offset::LineIndex, parser, render, toc};
use crate::error::Denied;
use crate::external;
use crate::external::watch::WatchInfo;

/// 批 1 的渲染选项。
///
/// ⚠️ **刻意与 CLI 的 `bench` 默认不同**：`render_sourcepos` 开不开，
/// 是 `design/0002` §7.0 步骤 2/3 量出来的取舍（实测会 +89.4% 体积，见 `kb/0002`）。
/// ⛔ 别因为"反正要开"就现在打开——那会让批 2 的 T5 建立在一个还没定案的口径上。
///
/// ⚠️ 这里**不能用 `..Default::default()`**（`const` 里没有它），所以每个字段都要显式写出来。
/// 加字段时编译器会在这里报错——这正是想要的（⛔ 不要改成 `static` + 运行时读默认值，
/// 那会把"新增选项忘了在这里表态"从编译错误降级成静默行为）。
pub const GUI_OPTS: ParseOpts = ParseOpts {
    render_sourcepos: false,
    sourcepos_chars: false,
    heading_ids: true,
    // ⭐ **GUI 这条路上公式是开的**（= `ParseOpts::default()`，`design/0007` §2.1.2）。
    //    ⚠️ 与 `cli/bench.rs` 的 `false` 不是矛盾：基准关掉它是为了**跨日期可比**
    //    （`benchmarks/results/` 里那批数字是在没有这个选项时跑的），
    //    而这里面对的是用户真在看的那份文档（§4 已把两处可见变化列为**接受的代价**）。
    math_dollars: true,
    // ⭐ **单换行断行在 GUI 这条路上也是开的**（= `ParseOpts::default()`，`design/0008` §9.3 第 1 条）。
    //    ⚠️ 与 `cli/bench.rs` 的 `false` 同样不矛盾：基准关掉它是为了**跨日期可比**。
    hardbreaks: true,
};

/// 一条大纲项。
///
/// ⚠️ `span` 仍然**不出去**（"跳转到源码行"直接要 `line`；
/// 字节区间是批 3 的搜索才需要的，那件事还没立项）。
///
/// ⭐ **2026-10-16 起多带 `line`**（`design/0012` §11.2）：滚动同步要一条
/// "源码行号 ↔ 右侧像素"的锚点，而**这个数本来就已经算好了**（`TocEntry.line`，
/// 由 `sourcepos.start.line` 来）——只是此前没序列化。
/// ⚠️ 加它**⛔ 不动 `GUI_OPTS`**：`render_sourcepos` 保持 `false`，
/// 阅读态的 HTML 一个字节不变（`design/0002` 的 `html_bytes` 口径因此不受影响）。
#[derive(Debug, Clone, Serialize)]
pub struct TocItem {
    /// 标题级别 1–6。
    pub level: u8,
    /// 标题纯文本。
    pub text: String,
    /// 文档内唯一的锚点 ID（`adr/0003`：文档级统一分配）。
    pub id: String,
    /// ⭐ 标题所在行的 **1-based** 行号（`TocEntry.line` 原样带出）。
    /// ⚠️ 前端拿它当**滚动同步的锚点**（`design/0012` §11.3），
    /// ⛔ 不是"可信的光标位置"——预览落后于缓冲时它是**上一份渲染**的行号。
    pub line: usize,
}

/// `open_document` 的返回值。
///
/// ⚠️ 字段名用 `*_ms` / `*_bytes` 是为了让前端**一眼看出单位**——
/// 这个项目最容易出的错就是"这个数是秒还是毫秒"（`design/0002` §5 `INV-TIMING-01`）。
#[derive(Debug, Serialize)]
pub struct DocumentPayload {
    /// ⭐ **回显请求里那一对版本号**（`design/0003` §2.1.3：「请求与响应都**原样携带**这一对」）。
    ///
    /// ⛔ 少这两个字段的后果**不是报错，而是正文永远不出现**：
    /// 前端的提交点 ① 比对 `resp.gen`／`resp.req`，拿到 `undefined` 就判成陈旧，
    /// 于是**静默丢弃**每一份成功的响应。⚠️ 这正是"看起来正常的错"的典型形态——
    /// 后端日志里 `open_document` 明明成功了。
    #[serde(rename = "gen")]
    pub generation: u64,
    /// 前端生成的那个 `request_id`，**后端不解释它，只回显**。
    pub req: u64,
    /// 请求里的那个路径（原样回显，只用于显示）。
    pub path: String,
    /// ⭐ **规范化后**的真实路径。⚠️ 它就是 `check_readable` 的返回值——
    /// 前端**不得**回退到 `path`，那是 TOCTOU（`INV-FS-01`）。
    pub real_path: String,
    /// 该文档所在目录（**已规范化**）。相对图片的解析基准（§2.1.2 (3)）。
    /// ⛔ 前端的职责只是把它显示出来，**不得**用它自己拼路径。
    pub doc_dir: String,

    /// 整篇 HTML。
    pub html: String,
    /// 大纲（侧边栏的「大纲」视图）。
    pub toc: Vec<TocItem>,

    /// ⭐ §2.1.4 第 ③ 步的**判据**：`roots` 非空 且 这份文档不在任何 root 之下。
    ///
    /// ⚠️ 由**后端**算（用 `Path::starts_with`），⛔ 不让前端拼字符串比前缀——
    /// JS 里的 `startsWith` 正是 `design/0003` §2.1.2 (1) 点名的前缀陷阱。
    pub outside_roots: bool,
    /// `roots` 当前是否非空。与上面那个一起构成第 ③ 步的**完整**触发条件
    /// （只有 `outside_roots` 会让单文件模式下的每次自动重载空转一次代次递增）。
    pub roots_nonempty: bool,

    /// T1 读盘：`fs::read` + UTF-8 校验 + 剥 BOM。
    pub t1_ms: f64,
    /// T2 解析：建 arena + comrak。
    pub t2_ms: f64,
    /// T3 渲染：AST → HTML。
    pub t3_ms: f64,

    /// 源字节数（已剥 BOM）。
    pub source_bytes: usize,
    /// HTML 字节数。
    pub html_bytes: usize,
    /// AST 节点数（`design/0002` §7.2 第 9 条）。
    pub ast_nodes: usize,
    /// 目录项数。
    pub toc_entries: usize,
    /// 是否剥掉了 BOM。⚠️ 偏移口径与它绑定（`kb/0002`），所以要显式报出来。
    pub had_bom: bool,

    /// ⭐ **Q22 规模闸门**：这一篇里有几个代码块**真的高亮了**
    /// （`design/0007` 文末「Q22 代码高亮规模闸门」追加节）。
    ///
    /// ⚠️ 它与 `t1_ms` / `ast_nodes` 这些是**同一类**——后端算好、前端只显示。
    /// ⛔ 与 [`DocRendered::stats`] 那个 `RenderStats` **不是**一回事：
    /// 后者是**后端自己的观测量**（§3.1，`report_status` 打它），刻意不进 `payload`；
    /// 这里只把**要讲给用户听的那两个数**挑出来送过来（理由见下一条）。
    pub code_highlighted: usize,
    /// ⭐ 因**规模限制**没能高亮的代码块数 = `code_oversize + code_budget_exhausted`。
    ///
    /// ⚠️ Q22 原话要求「渲染统计报告"部分代码未高亮（规模限制）"，界面提供**轻量可见说明**」
    /// ——`report_status` 那条 stderr 前端看不见，所以必须另送一份。
    ///
    /// ⚠️ **两个来源合成一个数**是刻意的：「这一块太大」与「整篇额度用完了」
    /// 在**用户那一侧是同一件事**（这几块没颜色），分两行说反而要用户先学会区分它们。
    /// ⭐ 前端判据只有一条：**这个数 > 0 才加那一句**——
    /// 正常文档的状态条上一个字都不会多出来。
    pub code_unhighlighted: usize,

    /// ⭐ **打开会话号**（`design/0017` §2.2 ①）：这份响应属于哪一次打开。
    ///
    /// ⚠️ 前端把它记在当前文档上，写阅读进度时原样带回；后端用
    /// `(current_document, doc_seq)` 双判据判断"这条写入还属不属于当前这份"。
    /// ⭐ `reload_document` 回带**同一个数**——自动重载不是新会话。
    pub doc_seq: u64,

    /// ⭐ **信封**：这份文档在磁盘上的 BOM 与行尾（`design/0012` §2.4-5 / `INV-EDIT-12`）。
    ///
    /// ⚠️ 它**从打开时判定的 `had_bom` 与正文**得出，⛔ 不是"预览时重新猜一次"——
    /// 行尾在编辑期间**不会变**（要变只能是外部改写，而那会被 §2.4-3 的基线拦住）。
    /// ⭐ 送到前端的是三个键（`bom` / `eol` / `lossy`），见 `document/envelope.rs`。
    pub envelope: Envelope,
}

/// 第一段（持锁）取到的、第二段（放锁）要用的那几样。
///
/// ⚠️ 它**只装"读盘前的判断"的结果**，⛔ 不装任何渲染产物——
/// 那正是"放锁期间可以变的东西"与"我们决定要读的东西"的边界。
#[derive(Debug, Clone)]
struct PreRead {
    /// 请求里那个路径（原样回显，只用于显示）。
    requested: String,
    /// `check_readable` 返回的规范路径。**第二段的读盘目标就是它**。
    real: PathBuf,
    /// §2.1.4 第 ③ 步的判据之一（在授权那一刻算，⛔ 不在渲染后算）。
    outside_roots: bool,
    /// §2.1.4 第 ③ 步的判据之二。
    roots_nonempty: bool,
}

/// **读取命令** · 打开一份文档。
///
/// 顺序是 **① 查代次 → ② 查授权 → ③ 记请求号**（全在第一段里，持锁），
/// 代次不符时**不做任何工作**（§2.1.3 规则 2：一份 10 MB 文档的解析
/// 不该为一次已被放弃的切换发生）。
/// ⚠️ 三段式锁的理由见模块头——别把它改回同步命令。
#[tauri::command]
pub async fn open_document(
    state: tauri::State<'_, AppState>,
    path: String,
    generation: u64,
    req: u64,
) -> Result<DocumentPayload, Denied> {
    // ⚠️ 后端**不解释** `request_id`，只由前端在提交点比对——它在这里的用途有两个：
    //    原样回显（`DocumentPayload.req`），以及**在第三段用它判断自己是不是最新的**。
    let t_start = Instant::now();

    // —— 第一段：持锁取快照 ——
    let pre = state.with(|s| -> Result<PreRead, Denied> {
        let current = s.grants.root_generation();
        if generation != current {
            return Err(Denied::stale(generation, current));
        }
        let real = s.grants.check_readable(Path::new(&path))?;
        // ⭐ 记下"后端见过的最大请求号"。⚠️ 取 `max` 而不是直接赋值：
        //    异步命令的第一段**不保证按到达顺序跑**（每个都是 spawn 出来的任务），
        //    直接赋值会让一个跑得快的旧请求把号拉回去，第三段于是误判。
        s.latest_doc_req = s.latest_doc_req.max(req);
        Ok(PreRead {
            outside_roots: s.grants.has_roots() && !s.grants.is_inside_roots(&real),
            roots_nonempty: s.grants.has_roots(),
            requested: path,
            real,
        })
    })?;

    let real = pre.real.clone();

    // —— 第二段：放锁干活（最重的一段）——
    let (mut payload, stats) = render_off_lock(pre, generation, req).await?;

    // —— 第三段：持锁核对后提交 ——
    // ⭐ 返回 `Some(doc_seq)` = 真的提交了；`None` = 被版本/请求号判成陈旧。
    //    ⚠️ **会话号在这里一并取回**（⛔ 不在闭包外再读一次）：中间若又有一次打开，
    //    再读一次会把"下一次的号"贴到这一份响应上（`design/0017` 评审 R2）。
    let committed_seq = state.with(|s| commit_open(s, generation, req, &real, stats));

    // ⚠️ 从会话里**再读回来**，而不是让闭包多返回一个值：这样"日志里打的那份"
    //    与"`report_status` 里打的那份"**必然是同一个数**（同一处赋值）。
    //    ⚠️ 但**没提交**时那个数是**上一份文档**的 ⇒ 分开打，别让它冒充本次（见下）。
    let Some(seq) = committed_seq else {
        let current = state.with(|s| s.grants.root_generation());
        diag!(
            "▶ open_document {}（T1 {:.1} / T2 {:.1} / T3 {:.1} ms）· ⚠️ **未提交**（代次 {} vs {} 或已有更新的请求 {req}）",
            payload.real_path, payload.t1_ms, payload.t2_ms, payload.t3_ms, generation, current
        );
        return Err(Denied::stale(generation, current));
    };
    payload.doc_seq = seq;
    let stats_summary = state.with(|s| s.last_render_stats.summary());
    // ⚠️ 公式计数**每次打开都打**（含全零）——这一行是 `INV-MATH-05` 那条
    //    "累计触顶必须可观测"在**日志**这一侧的出口。⛔ 不要为了"少打点字"改成
    //    「非零才打」：那样冒烟脚本就分不清"没触顶"和"这一版根本没接上计数"。
    diag!(
        "▶ open_document {}（T1 {:.1} / T2 {:.1} / T3 {:.1} ms，整段 {:.1} ms）· 公式 {}",
        payload.real_path,
        payload.t1_ms,
        payload.t2_ms,
        payload.t3_ms,
        t_start.elapsed().as_secs_f64() * 1000.0,
        stats_summary
    );
    Ok(payload)
}

/// **读取命令** · 重载当前文档（`design/0006` §2.1 ②）。
///
/// ⛔ **不收路径参数**：后端用自己那份 `current_document`。
/// 理由见 `Session::current_document` 的注释（"两个说法"）。
///
/// ⚠️ 它与 `open_document` 是**同一套三段式锁**（§9.3 第 1 条），
/// 只差三处：目标来源、第三段的**身份**判据、以及不重设 `latest_doc_req` 以外的状态。
#[tauri::command]
pub async fn reload_document(
    state: tauri::State<'_, AppState>,
    generation: u64,
    req: u64,
) -> Result<DocumentPayload, Denied> {
    let t_start = Instant::now();

    // —— 第一段 ——
    let pre = state.with(|s| -> Result<PreRead, Denied> {
        let current = s.grants.root_generation();
        if generation != current {
            return Err(Denied::stale(generation, current));
        }
        let Some(p) = s.current_document.clone() else {
            return Err(Denied::NoDocument);
        };
        // ⭐ `INV-EXT-03`：自动重载的**每一次**读盘都要重新过授权。
        //    ⛔ 不许因为"这份文档上一次读过"就跳过——文件可能刚被挪出 root、
        //    被删、或者软链指向被改了。这里也**只有**这一条入口（`INV-FS-01`）。
        let real = s.grants.check_readable(&p)?;
        s.latest_doc_req = s.latest_doc_req.max(req);
        Ok(PreRead {
            outside_roots: s.grants.has_roots() && !s.grants.is_inside_roots(&real),
            roots_nonempty: s.grants.has_roots(),
            requested: real.display().to_string(),
            real,
        })
    })?;

    let real = pre.real.clone();

    // —— 第二段 ——
    let (mut payload, stats) = render_off_lock(pre, generation, req).await?;

    // —— 第三段：代次 **+ 请求号 + 身份** ——
    // ⭐ 返回**当前** `doc_seq`（不 +1）：自动重载不是新会话（`design/0017` §2.2 ①）。
    let committed_seq = state.with(|s| commit_reload(s, generation, req, &real, stats));
    let Some(seq) = committed_seq else {
        let current = state.with(|s| s.grants.root_generation());
        diag!(
            "▶ reload_document {} ⚠️ **未提交**（代次 {} vs {}／身份已变／已有更新的请求 {req}）",
            payload.real_path, generation, current
        );
        return Err(Denied::stale(generation, current));
    };
    payload.doc_seq = seq;
    let stats_summary = state.with(|s| s.last_render_stats.summary());
    diag!(
        "▶ reload_document {}（T1 {:.1} / T2 {:.1} / T3 {:.1} ms，整段 {:.1} ms）· 公式 {}",
        payload.real_path,
        payload.t1_ms,
        payload.t2_ms,
        payload.t3_ms,
        t_start.elapsed().as_secs_f64() * 1000.0,
        stats_summary
    );
    Ok(payload)
}

/// ⭐ `open_document` 的**第三段提交**（持锁）。
///
/// 返回 `Some(doc_seq)` = 真的提交了；`None` = 被代次 / 请求号判成陈旧。
/// ⚠️ 拆成具名函数只为**可测**（`design/0017` §7.2 #9 要求能断言
/// "被 `latest_doc_req` 丢弃的那次不加号"）——命令体里那层闭包拿不到 `Session`。
fn commit_open(
    s: &mut Session,
    generation: u64,
    req: u64,
    real: &Path,
    stats: render::RenderStats,
) -> Option<u64> {
    if s.grants.root_generation() != generation {
        return None;
    }
    // ⭐ **最新请求号**：放锁那几秒里前端可能又发起了一次打开，
    //    这份结果即使代次没变也已经不是最新的了（§2.1 ⑤）。
    if s.latest_doc_req != req {
        return None;
    }
    // ⭐ `INV-MATH-05` 的"可观测"出口：把这次渲染的计数留给 `report_status`
    //    （`design/0007` §3.1）。⚠️ 它现在在**第三段**——只有真正提交了才记，
    //    "渲染了但被丢弃"不再污染那个数（比批 1 更准）。
    s.last_render_stats = stats;
    // ⚠️ 记下"当前文档的所在目录"给 `read_asset` 用。
    //    诚实说明其边界：真正的"提交"发生在前端，这里只是**尽力**跟上；
    //    若前端最终丢弃了这份响应，图片基准会短暂指错——但那种情况下
    //    前端也不会去要图片（它会切到别的文档并重新设基准）。
    s.doc_dir = real.parent().map(|d| d.to_path_buf());
    s.startup_document = Some(real.to_path_buf());
    // ⭐ **换文档 ⇒ 编辑态结束**（`design/0012` §2.4-1：退出编辑态即撤销写授权）。
    //    ⚠️ 这里**必须**清：新文档的正文与旧文档的基线/授权毫无关系，
    //    留着就等于让「刚切过来的这份」带着上一份的写授权。
    //    ⭐ 注意 §2.4-3 的**基线不在这里落**——它的唯一生产者是
    //    `commands::edit::begin_edit`（见那里的模块头：基线的语义是
    //    "编辑器手里那个缓冲是基于哪份磁盘内容来的"）。
    s.end_edit();
    // ⭐ **打开会话号自增的唯一一处**（`design/0017` §2.2 ①）：
    //    与上面几个字段**同批**提交，⛔ 不在别处 +1（重载不算新会话）。
    s.doc_seq += 1;
    Some(s.doc_seq)
}

/// ⭐ `reload_document` 的**第三段提交**（持锁）：代次 ＋ 请求号 ＋ **身份**。
///
/// ⭐ 返回**当前** `doc_seq`（⛔ 不 +1）：自动重载不是新会话（`design/0017` §2.2 ①）。
fn commit_reload(
    s: &mut Session,
    generation: u64,
    req: u64,
    real: &Path,
    stats: render::RenderStats,
) -> Option<u64> {
    if s.grants.root_generation() != generation {
        return None;
    }
    // ⭐⭐ **身份**（`INV-EXT-07`）：同根下切文档**代次不变**
    //    （`root_generation` 只随 roots 变，`fs/grants.rs`）。
    //    ⛔ 只比代次会让"用户在放锁那几秒里点了另一份文件"变成
    //    "把旧文档的内容写进新文档的状态位"——而且是静默的。
    if s.current_document.as_deref() != Some(real) {
        return None;
    }
    if s.latest_doc_req != req {
        return None;
    }
    s.last_render_stats = stats;
    s.doc_dir = real.parent().map(|d| d.to_path_buf());
    s.startup_document = Some(real.to_path_buf());
    // ⚠️⛔ **本段刻意不碰编辑态、也不碰基线**（`design/0012` §2.4-3）：
    //    重载的命令做的事是"把**磁盘**现在这份渲染出来"，与"编辑器手里那个缓冲
    //    是基于哪份内容来的"是**两件事**。若在这里顺手把基线换成新读的字节，
    //    就会出现一个窗口：编辑器拿着旧文本、基线却是新内容 ⇒ 下一次保存的
    //    冲突检查**会通过**，于是**静默回退掉别人的修改**。
    //    ⇒ 编辑态下收到外部修改该走的是 `INV-EDIT-06` 那道闸
    //      （前端先问，用户接受就重新 `begin_edit` —— 那时文本与基线在**同一个动作**里
    //       一起换新，没有窗口）。⚠️ 因此编辑态下前端**不该**调本命令。
    Some(s.doc_seq)
}

/// ⭐ **读取命令** · 监视当前文档（`design/0006` §2.1 ②）。
///
/// ⚠️ 它**是**读取命令，不是授权命令：⛔ 不新增任何可读路径（`INV-FS-04`），
/// 而且**必须**过 `check_readable`（`INV-EXT-03`）——它是 `current_document`
/// 的**唯一**写入点之一，绕过它就等于让 `⌘E` / 重载能打向一条没授权过的路径。
///
/// ⚠️ 顺序上有一处**与 §2.1 ② 的原文不同**：原书写"②停旧 ④起新"，
/// 这里是"**先起新、再停旧**"。理由是失败时不自伤——起新失败就直接 `Err`，
/// 旧的那份监视与 `current_document` 原封不动（否则会落到"没有监视、也没有当前文档"
/// 这个比降级更差的态）。⚠️ 副作用是同一份文件可能**短暂**有两个 watcher，
/// 但旧的 `seq` 已经过期，前端会丢掉它的所有事件（`design/0006` §2.1 ② 的 `seq` 判据）。
#[tauri::command]
pub fn watch_document(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<WatchInfo, Denied> {
    state.with(|s| {
        // ⭐ `INV-EXT-03`：这是允许监视哪一条路径的**唯一**判据。
        let real = s.grants.check_readable(Path::new(&path))?;
        let generation = s.grants.root_generation();
        let seq = s.next_watch_seq();
        // ⚠️ `start` 会**同步**起一个 watcher（含一条 FSEventStream）——几十微秒量级，
        //    在锁里可以接受；⛔ 但别在这里加更多活儿。
        let w = external::watch::start(&app, &real, seq, generation)?;
        // ⚠️ 摘旧的走 `drop_watch`（顺带清 `current_document`），然后立刻重新写上。
        //    ⛔ 不许把 `s.watch = None` 写在别处——那会绕过"两个字段一起改"这条不变量。
        let old = s.drop_watch();
        s.current_document = Some(real.clone());
        s.watch = Some(w);
        drop(old); // ⚠️ 异步停，不会在本线程 join（见 `external::watch` 模块头）
        diag!("▶ watch_document seq={seq} {}（代次 {generation}）", real.display());
        Ok(WatchInfo { seq, path: real.display().to_string(), generation })
    })
}

/// **读取命令** · 停止监视（`design/0006` §2.1 ②）。
///
/// ⚠️ 停止是**异步**完成的（`Watch::drop`）⇒ 返回后可能还有一两条事件在路上，
/// 它们会被前端按 `seq` 丢掉（⛔ 别因此以为"停止没生效"）。
///
/// # ⭐ 为什么收 `seq`（这是 §10.5 点名"实施时才要定"的那一处）
///
/// 前端只有一个调用点：**它自己发现代次变了、于是判定监视已经失效**的时候
/// （`session.js::applySnapshot`，`INV-EXT-09`）。那一瞬间它**知道**后端手里是哪一个
/// `seq`（就是它自己存着的那个）。
///
/// ⛔ **无条件停是错的**：那条"我知道它失效了"的消息发出去之后，
/// 用户可能已经点开了下一份文档（`watch_document` 已经建好了新的监视），
/// 而这条迟到的停止会**把新的那个摘掉**——表现是"换文档之后自动刷新再也不触发"，
/// 且双方日志各自都正常。带上 `seq` 之后这种交错**结构上不可能**发生。
///
/// ⚠️ `seq` 不符**不是错误**（多半是监视已经自己失效/被换了），只记一行日志。
///
/// ⚠️ 与之相对，「**关窗 / 退出**」**不需要**清理点（§10.5 的同一处）：
/// 最后一条监视随进程消亡，而 `Watch::drop` 是异步的（起一次性线程去停），
/// ⛔ 不会拖住退出。⇒ 前端**没有** `beforeunload` 钩子，这是有意的。
#[tauri::command]
pub fn unwatch_document(state: tauri::State<'_, AppState>, seq: u64) {
    state.with(|s| {
        if s.watch.as_ref().map(|w| w.seq) != Some(seq) {
            diag!("▶ unwatch_document(seq={seq})：当前不是它（可能已失效）——不动");
            return;
        }
        if let Some(w) = s.drop_watch() {
            diag!("▶ unwatch_document（seq={}）", w.seq);
            drop(w);
        }
    })
}

/// ⭐ **读取命令** · 用外部编辑器打开当前文档（`design/0006` §2.1 ② / `INV-EXT-01`）。
///
/// ⛔ **不收路径参数**：目标是后端那份 `current_document`。
/// ⚠️ 每一条"把路径交给另一个程序"的路都必须在**发出去之前**再过一次
/// `check_readable`：`current_document` 是几分钟前记下的，那时它可读，
/// **现在不一定**（用户可能刚关了那个目录）。
///
/// ⚠️ 它是 `async fn` 的原因很具体：`open` 要 ~97 ms 才返回（`kb/0019`），
/// 而我们需要它的**退出码**来判断"应用名拼错了"（`INV-EXT-04` 的降级要可见）。
/// 那 97 ms ⛔ 不该占着主线程，也⛔ 不该占着异步运行时的工作线程
/// ⇒ 交给 `spawn_blocking`。
#[tauri::command]
pub async fn open_in_external_editor(state: tauri::State<'_, AppState>) -> Result<(), Denied> {
    // —— 持锁取"要打开的那份路径 + 配置里的编辑器名" ——
    let (real, editor, editor_for_log) = state.with(|s| -> Result<_, Denied> {
        let Some(p) = s.current_document.clone() else {
            return Err(Denied::NoDocument);
        };
        let real = s.grants.check_readable(&p)?;
        let editor = s.config.editor_name().map(|e| e.to_string());
        Ok((real, editor.clone(), editor))
    })?;

    let real_for_err = real.clone();
    let join = tauri::async_runtime::spawn_blocking(move || {
        external::spawn_editor(editor.as_deref(), &real)
    })
    .await;
    match join {
        Ok(Ok(())) => {
            diag_stderr!(
                "▶ open_in_external_editor {}（编辑器={}）",
                real_for_err.display(),
                editor_for_log.as_deref().unwrap_or("系统默认")
            );
            diag_file!(
                "▶ open_in_external_editor path={} editor_len={}",
                real_for_err.display(),
                editor_for_log.as_deref().map(|e| e.len()).unwrap_or(0)
            );
            Ok(())
        }
        // ⭐ 降级要**显式告知**（`INV-EXT-04`）：应用名拼错时 `open` 返回非零，
        //    这里把它变成一个前端拿得到的错误（kind=io），⛔ 不静默。
        Ok(Err(e)) => Err(Denied::io(&real_for_err, e)),
        Err(e) => Err(Denied::io(&real_for_err, format!("启动线程没能跑完：{e}"))),
    }
}

/// 第二段：**放锁**读盘 + 解析 + 渲染。
///
/// ⚠️ 它跑在 `spawn_blocking` 的**阻塞工作线程**上，⛔ 不是异步运行时的工作线程：
/// 一次 10 MB 渲染是 3.4 s 的纯 CPU，占着一个 runtime worker 会让别的命令
/// （`get_session`、`report_status`）排队（`design/0006` §9.3 第 1 条）。
async fn render_off_lock(
    pre: PreRead,
    generation: u64,
    req: u64,
) -> Result<(DocumentPayload, crate::document::render::RenderStats), Denied> {
    let real_for_err = pre.real.clone();
    let join = tauri::async_runtime::spawn_blocking(move || {
        read_and_render(
            &pre.requested,
            &pre.real,
            generation,
            req,
            pre.outside_roots,
            pre.roots_nonempty,
        )
    })
    .await;
    match join {
        Ok(r) => r,
        // ⚠️ 走到这里意味着渲染**线程自己没了**（panic / 运行时关停）。
        //    ⛔ 别把它并进 `Ok(r)` 的 `Err` 里用同一个文案——那会把"我们代码里
        //    有个 panic"说成"这个文件读不出来"（`design/0003` §7 步骤 18 的同族要求）。
        Err(e) => Err(Denied::io(&real_for_err, format!("渲染线程没能跑完：{e}"))),
    }
}

/// ⭐ **源码 → HTML ＋ 大纲 ＋ 计数**——**打开与预览共用的唯一一条渲染链**
/// （`design/0012` §2.4-6：预览"复用同一条链"这件事必须**结构上**成立，
/// ⛔ 不是靠"记得别换参数"）。
///
/// ⚠️ **共用的是解析与渲染参数**（[`GUI_OPTS`]，含 `hardbreaks` / `math_dollars`
/// ——它们直接影响输出字节），⛔ **不共用计时口径**：预览没有 T1 读盘，
/// 所以 T1 由调用方给（那个字段的语义是"读盘花了多久"）。
pub(crate) struct DocRendered {
    pub html: String,
    pub toc: Vec<TocItem>,
    pub t2_ms: f64,
    pub t3_ms: f64,
    pub ast_nodes: usize,
    pub toc_entries: usize,
    pub html_bytes: usize,
    pub stats: crate::document::render::RenderStats,
}

/// ⭐ 真正的那条链：**索引 → 解析 → 渲染 → 大纲 → 计数**。
///
/// ⚠️ 行偏移索引**没有编号**（设计漏了），这里不计时、也不还给前端——
/// 只为让分段与 CLI `bench` 对齐（并进 T2 会让两边不可比）。
/// ⚠️ 顺序是**有意义**的：`toc::build` 要用 `index`，而 `ast_nodes` 在 `roots` 被消费前后都成立。
pub(crate) fn render_source(src: &str) -> DocRendered {
    let index = LineIndex::new(src);

    // —— T2 解析 ——
    let t0 = Instant::now();
    let arena = comrak::Arena::new();
    let root = parser::parse(&arena, src, &GUI_OPTS);
    let t2 = t0.elapsed();

    // —— T3 渲染 ——
    let t0 = Instant::now();
    // ⚠️ 用 `to_html_with_stats`（⛔ 不是 `to_html`）：这一条路上的公式计数
    //    就是 `INV-MATH-05` 要求"不许静默"的那个数（`design/0007` §3.1）。
    let (html, stats) = render::to_html_with_stats(root, &GUI_OPTS);
    let t3 = t0.elapsed();

    // 规模数：AST 节点（§7.2 第 9 条）与目录项
    let tocs = toc::build(root, src, &index, GUI_OPTS.col_unit());
    let ast_nodes = root.descendants().count();
    let toc_entries = tocs.len();
    let html_bytes = html.len();
    let toc = tocs
        .into_iter()
        .map(|t| TocItem { level: t.level, text: t.text, id: t.id, line: t.line })
        .collect();

    DocRendered {
        html,
        toc,
        t2_ms: t2.as_secs_f64() * 1000.0,
        t3_ms: t3.as_secs_f64() * 1000.0,
        ast_nodes,
        toc_entries,
        html_bytes,
        stats,
    }
}

/// 真读 + 解析 + 渲染。**这里没有任何授权判断**——调用方已经查过了。
///
/// ⚠️ 返回 `(payload, stats)` 两件，`stats` **不进** `payload`：
/// 它是后端自己的观测量（`design/0007` §3.1 要的是它能被 `report_status` 打出来），
/// ⛔ 不是给前端用的数据。
fn read_and_render(
    requested: &str,
    real: &Path,
    generation: u64,
    req: u64,
    outside_roots: bool,
    roots_nonempty: bool,
) -> Result<(DocumentPayload, crate::document::render::RenderStats), Denied> {
    // —— T1 读盘 ——
    let t0 = Instant::now();
    let loaded = loader::load(real).map_err(|e| Denied::io(real, e))?;
    let t1 = t0.elapsed();
    let src = loaded.source;
    let had_bom = loaded.had_bom;

    let r = render_source(&src);

    Ok((
        DocumentPayload {
            generation,
            req,
            path: requested.to_string(),
            real_path: real.display().to_string(),
            doc_dir: parent_string(real),
            html: r.html,
            toc: r.toc,
            outside_roots,
            roots_nonempty,
            t1_ms: t1.as_secs_f64() * 1000.0,
            t2_ms: r.t2_ms,
            t3_ms: r.t3_ms,
            source_bytes: src.len(),
            html_bytes: r.html_bytes,
            ast_nodes: r.ast_nodes,
            toc_entries: r.toc_entries,
            had_bom,
            // ⭐ Q22 规模闸门的两个数（见 `DocumentPayload` 上那两条注释）。
            code_highlighted: r.stats.code_highlighted,
            code_unhighlighted: r.stats.code_unhighlighted(),
            // ⚠️ 占位：真正的值在**第三段提交**时由调用方填（`design/0017` §2.2 ①）。
            //    渲染与提交是两个时刻，这里拿到的任何号都可能是"上一次打开"的。
            doc_seq: 0,
            // ⭐ 信封由**打开这一瞬**正文的字节判定（`detect` 而不是 `detect_raw`：
            //    这里手上是 `source` ＋ `had_bom` 这两样，见 `loader.rs`）。
            envelope: Envelope::detect(&src, had_bom),
        },
        r.stats,
    ))
}

fn parent_string(p: &Path) -> String {
    p.parent().unwrap_or(Path::new("")).display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::grants::SessionGrants;
    use crate::fs::tree::TreeCache;
    use std::collections::VecDeque;

    fn session() -> Session {
        Session {
            grants: SessionGrants::new(),
            tree: TreeCache::new(),
            config: Default::default(),
            config_path: std::env::temp_dir().join("rmd-doc-seq-unused.json"),
            doc_dir: None,
            startup_document: None,
            pending_opens: VecDeque::new(),
            last_render_stats: Default::default(),
            current_document: None,
            doc_seq: 0,
            edit_target: None,
            self_write: None,
            save_inflight: None,
            baseline_bytes: None,
            watch: None,
            watch_seq: 0,
            latest_doc_req: 0,
            index: None,
            // ⚠️ 目录监视（`design/0034`）在这批测试里**永远是 None**：
            //    它要 `AppHandle` 与真 FSEvents，而这里的关注点是会话号。
            tree_watch: None,
        }
    }

    #[test]
    fn 打开提交后会话号加一() {
        let mut s = session();
        s.latest_doc_req = 5;
        let seq = commit_open(&mut s, 0, 5, Path::new("/a.md"), Default::default());
        assert_eq!(seq, Some(1));
        assert_eq!(s.doc_seq, 1);
        // ⚠️ 真实流程里第一段会把 `latest_doc_req` 抬到本次请求号，这里补上同一步。
        s.latest_doc_req = 6;
        let seq = commit_open(&mut s, 0, 6, Path::new("/b.md"), Default::default());
        assert_eq!(seq, Some(2), "每次成功提交都 +1");
        assert_eq!(s.doc_seq, 2);
    }
    #[test]
    fn 被请求号丢弃的打开不加号() {
        let mut s = session();
        s.latest_doc_req = 9; // 后端见过的最大请求号已经更大
        let seq = commit_open(&mut s, 0, 5, Path::new("/a.md"), Default::default());
        assert_eq!(seq, None);
        assert_eq!(s.doc_seq, 0, "⚠️ 渲染了但没提交 ≠ 打开过");
    }

    #[test]
    fn 代次不符的打开不加号() {
        let mut s = session();
        s.latest_doc_req = 5;
        let seq = commit_open(&mut s, 1, 5, Path::new("/a.md"), Default::default());
        assert_eq!(seq, None);
        assert_eq!(s.doc_seq, 0);
    }

    #[test]
    fn 重载回带同一个会话号() {
        let mut s = session();
        s.latest_doc_req = 5;
        s.current_document = Some(PathBuf::from("/a.md"));
        s.doc_seq = 4;
        let seq = commit_reload(&mut s, 0, 5, Path::new("/a.md"), Default::default());
        assert_eq!(seq, Some(4), "自动重载不是新会话");
        assert_eq!(s.doc_seq, 4);
    }

    #[test]
    fn 重载时身份不符不提交() {
        let mut s = session();
        s.latest_doc_req = 5;
        s.current_document = Some(PathBuf::from("/b.md"));
        s.doc_seq = 4;
        let seq = commit_reload(&mut s, 0, 5, Path::new("/a.md"), Default::default());
        assert_eq!(seq, None);
        assert_eq!(s.doc_seq, 4);
    }

    /// ⭐ `design/0035` B6b：改名**不会**让在途的旧路径快照顶上来。
    ///
    /// 场景：`reload_document` 的第一段已经按**旧路径**读好并放锁渲染，
    /// 这期间用户把当前文档改了名（`current_document` 迁到新路径、`doc_seq` 不变）。
    /// 提交段比的是**身份**（`current_document == real`），⛔ 不是只比 `doc_seq`——
    /// 否则旧内容会静默盖到新路径上（`INV-EXT-07`）。
    #[test]
    fn 改名之后在途的旧路径重载不提交() {
        let mut s = session();
        s.latest_doc_req = 9;
        s.doc_seq = 5;
        // 改名的结果：身份已经搬到新路径，会话号**没有**变
        s.current_document = Some(PathBuf::from("/b.md"));
        s.doc_dir = Some(PathBuf::from("/"));
        s.startup_document = Some(PathBuf::from("/b.md"));
        let seq = commit_reload(&mut s, 0, 9, Path::new("/a.md"), Default::default());
        assert_eq!(seq, None, "旧路径的快照必须被身份判据丢弃");
        assert_eq!(s.doc_seq, 5);
        assert_eq!(s.current_document, Some(PathBuf::from("/b.md")));
        assert_eq!(s.startup_document, Some(PathBuf::from("/b.md")));
        assert_eq!(s.doc_dir, Some(PathBuf::from("/")));
    }
}
