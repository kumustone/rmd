//! 持久化配置。`design/0003` §2.1.1 第 3、4 条：**侧边栏宽度**与**上次打开的目录**。
//!
//! # 三条约束
//!
//! 1. ⭐ **单一真源**：`design/0004` 的 `INV-THEME-03` 要求"配置只有一个来源"，
//!    它在**文件层级**上的对应就是——本文件是**唯一**那份配置，
//!    `0004` 的主题键将来也写进它，⛔ **不要另起一份**。
//!    为此本结构对**未知键做保留**（`extra`）：`0004` 先落盘 `{"theme":"dark"}`，
//!    这里读进来再写回去时不会把它抹掉。
//! 2. ⛔ **只存路径，不存授权**：`last_directory` 是给"一键恢复"用的**提示**，
//!    重启后仍需用户在对话框里确认一次（`INV-FS-03` / §2.1.4）。
//!    把它读回来就自动授权，等于把 `persisted-scope` 的效果**用手写代码实现一遍**。
//! 3. ⚠️ **任何失败都降级成默认值**，⛔ 不 panic、⛔ 不拦住启动：
//!    用户配置坏了不该让阅读器打不开。坏文件**不自动删除**（那是用户的数据），
//!    只是下次保存时会被覆盖掉。

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 配置文件名。⚠️ 放在 Tauri 的 `app_config_dir()` 之下
/// （macOS 上是 `~/Library/Application Support/io.github.kumustone.rmd/`）。
pub const FILE_NAME: &str = "config.json";

/// 侧边栏宽度的默认值（逻辑像素）。
///
/// ⚠️ **不是 `design/0004` 的取值**（那份还没评审）：这里只是一个"能看"的起点。
/// 实测里 Typora 本机的 `sidebar-width` 是 `282`（`kb/0008` 的姊妹条目
/// `research/products/0001`），取 280 与之接近，但**不构成对齐**——
/// 它是本文件的自创默认值，`0004` 通过后要回来对。
pub const DEFAULT_SIDEBAR_WIDTH: f64 = 280.0;

/// 侧边栏宽度的下限/上限（拖动时夹住）。
/// ⚠️ 纯交互约束（再窄就看不见文件名、再宽就吃掉正文），不是排版取值。
pub const MIN_SIDEBAR_WIDTH: f64 = 160.0;
/// 见 [`MIN_SIDEBAR_WIDTH`]。
pub const MAX_SIDEBAR_WIDTH: f64 = 640.0;

// ─────────────────────────────────────────────────────────────────────────
// 外观（主题 + 阅读设置）——`design/0004` / `design/0005`（均 2026-10-13 已通过）
// ─────────────────────────────────────────────────────────────────────────

/// 主题模式。⚠️ 存的是**模式**，不是解析后的主题名——
/// 「跟随系统」本身是一个合法的用户选择（`0004` §9.1 B3），
/// 它解析成哪一套取决于启动那一刻的系统偏好。
pub const THEMES: [&str; 4] = ["system", "light", "dark", "warm"];

/// ⭐ **界面语言的三档偏好**（`design/0025` §2.4，2026-10-21）。
///
/// ⚠️ 与 [`THEMES`] 同形：存的是**偏好**，⛔ 不是解析后的语言。
/// 「跟随系统」是一个合法的用户选择，它解析成 `zh` / `en` 的**唯一裁定点**
/// 在 [`crate::lang`]（`INV-I18N-07`：前端⛔ 不读 `navigator.language`）。
pub const LANGS: [&str; 3] = ["system", "zh", "en"];

/// 把任意输入归一成 [`LANGS`] 之一。
///
/// ⚠️ `None`（没写过）与**任何认不出来的串**（手改配置拼成 `"fr"` / `"中文"`）
/// 一律落 `"system"`——与 [`Appearance::clamped`] 对未知主题名的处置**同一条口径**：
/// 配置可以被手改，一个拼错的词不该让阅读器打不开，也⛔ 不该让它突然变成英文界面。
pub fn normalize_language(pref: Option<&str>) -> &'static str {
    match pref.map(str::trim) {
        Some(p) if p.eq_ignore_ascii_case("zh") => "zh",
        Some(p) if p.eq_ignore_ascii_case("en") => "en",
        _ => "system",
    }
}

/// 正文基准字号（`design/0005` §2.1.1 的唯一绝对锚点）。
pub const DEFAULT_FONT_SIZE: f64 = 14.0;
/// 字号下限。⚠️ 低于它中文笔画会糊在一起。
pub const MIN_FONT_SIZE: f64 = 12.0;
/// 字号上限。见 [`MIN_FONT_SIZE`]。
pub const MAX_FONT_SIZE: f64 = 28.0;

/// 行高（`0005` A1 的结论：跟基准 `1.6`）。
pub const DEFAULT_LINE_HEIGHT: f64 = 1.6;
/// 行高下限。
pub const MIN_LINE_HEIGHT: f64 = 1.2;
/// 行高上限。
pub const MAX_LINE_HEIGHT: f64 = 2.0;

/// 内容宽度上限的默认值（`0005` A4 的结论：**铺满 + 一个宽松上限**）。
pub const DEFAULT_CONTENT_WIDTH: f64 = 1200.0;
/// 见 [`DEFAULT_CONTENT_WIDTH`]。
pub const MIN_CONTENT_WIDTH: f64 = 480.0;
/// 见 [`DEFAULT_CONTENT_WIDTH`]。
pub const MAX_CONTENT_WIDTH: f64 = 2400.0;

/// ⭐ **编辑态 Vim 键位的出厂档：关闭**（`design/0014` §9.1 裁定 (a)）。
///
/// ⚠️ 用户逐字裁的是「**可切换，默认关闭**」——**别**因为"装都装了"就默认打开：
/// Vim 键位一旦开着，`Esc`/`hjkl` 就从"输入字符"变成"移动光标"，
/// 而**打不开 Vim 的人根本不知道要按 `i` 才能打字**（那是"键盘坏了"的观感）。
pub const DEFAULT_VIM_MODE: bool = false;

/// ⭐ **外观**：主题 + 三个可调尺度。
///
/// ⚠️ 这三样**共用同一个写请求**（`INV-THEME-05`）：写的是"取当前 applied 全量"，
/// ⛔ 不是"发请求那一刻的快照"。所以它们在**类型上**就是一条记录，
/// 而不是四个可以各自乱序落盘的键。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Appearance {
    /// `"system"` / `"light"` / `"dark"` / `"warm"`。
    #[serde(default = "default_theme")]
    pub mode: String,
    /// 正文基准字号（px）。
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    /// 行高倍数（无单位）。
    #[serde(default = "default_line_height")]
    pub line_height: f64,
    /// 内容宽度上限（px）。⚠️ **`0` = 铺满（无上限）**，⛔ 不是"宽度为零"。
    #[serde(default = "default_content_width")]
    pub content_width: f64,
    /// ⭐ **编辑态 Vim 键位**（`design/0014` 裁定 (a)：可切换、**默认关闭**）。
    ///
    /// ⚠️ 它**不是外观**（不碰颜色、也不碰尺度，`INV-THEME-04` 与它无关），
    /// 住在这儿纯粹是因为它要**搭同一条写盘队列**（`INV-THEME-05`）：
    /// 独立落盘会造出**第二个写者**，而"500 ms 内改字号 + 顺手切一次 Vim"
    /// 就会变成两次并发写、各自带一份旧快照。
    #[serde(default = "default_vim_mode")]
    pub vim_mode: bool,
}

/// 没写过配置时的默认模式。
///
/// ⭐ **`"system"`，不是 `"light"`**（`design/0004` §9.1 B3 的结论：
/// 「应用层实现，但**默认提供"跟随系统"这一档**」）。
/// 判据是**不做选择的那个用户**：一台深色模式的 Mac 上开箱即白屏，
/// 是"这个阅读器不跟随系统"给人的第一印象，而那正是 B3 要避免的。
///
/// ⚠️ 它同时是**未知主题名的回落目标**（见 [`Appearance::clamped`]）——
/// 那条路也走 `system` 是刻意的：手改配置拼错一个字，
/// 回落到"跟随系统"比回落到一个写死的浅色更接近用户的真实意图。
fn default_theme() -> String { "system".to_string() }
fn default_font_size() -> f64 { DEFAULT_FONT_SIZE }
fn default_line_height() -> f64 { DEFAULT_LINE_HEIGHT }
fn default_content_width() -> f64 { DEFAULT_CONTENT_WIDTH }
fn default_vim_mode() -> bool { DEFAULT_VIM_MODE }

impl Default for Appearance {
    fn default() -> Self {
        Appearance {
            mode: default_theme(),
            font_size: DEFAULT_FONT_SIZE,
            line_height: DEFAULT_LINE_HEIGHT,
            content_width: DEFAULT_CONTENT_WIDTH,
            vim_mode: DEFAULT_VIM_MODE,
        }
    }
}

impl Appearance {
    /// 把每个字段都夹进合法范围，⛔ 不 panic（前端传来什么都得能承受）。
    pub fn clamped(self) -> Appearance {
        Appearance {
            // ⚠️ 未知主题名**回落**而不是报错：配置文件可以被手改，
            //    一个拼错的 "drak" 不该让阅读器打不开（模块头第 3 条）。
            mode: if THEMES.contains(&self.mode.as_str()) {
                self.mode
            } else {
                default_theme()
            },
            font_size: clamp_num(self.font_size, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_FONT_SIZE),
            line_height: clamp_num(
                self.line_height,
                MIN_LINE_HEIGHT,
                MAX_LINE_HEIGHT,
                DEFAULT_LINE_HEIGHT,
            ),
            content_width: clamp_content_width(self.content_width),
            // ⚠️ `vim_mode` **不夹**（`bool` 没有越界这回事）——列在这儿只是提醒
            //    下一个人"`clamped` 必须原样带着它走"：漏了这一行的话
            //    `set_appearance` 会把每一次外观写入都**顺手关掉 Vim 模式**，
            //    表现是"切一次主题，Vim 就自己关了"。
            vim_mode: self.vim_mode,
        }
    }
}

/// 通用数值夹取（NaN / 无穷 → 默认值）。
pub fn clamp_num(v: f64, lo: f64, hi: f64, fallback: f64) -> f64 {
    if !v.is_finite() {
        return fallback;
    }
    v.clamp(lo, hi)
}

/// 内容宽度的夹取。⚠️ **`0` 是合法值**（铺满），⛔ 不能被"钳到最小宽度"吃掉——
/// 那会把用户选的"铺满"静默改成一个窄栏。
pub fn clamp_content_width(v: f64) -> f64 {
    if !v.is_finite() {
        return DEFAULT_CONTENT_WIDTH;
    }
    if v == 0.0 {
        return 0.0;
    }
    v.clamp(MIN_CONTENT_WIDTH, MAX_CONTENT_WIDTH)
}

// ─────────────────────────────────────────────────────────────────────────
// ⭐ 阅读进度（`design/0017`，2026-10-19 已通过）
//
// ⚠️ 三条边界先摆在这儿（改本段前先读）：
//   ① **不是授权**（`INV-PROG-01`）：删掉整张表，读写能力一个字节都不变；
//   ② **只存位置元数据**（`INV-PROG-02`）：标题 id / 偏移 / 比例 / 源字节 / 时间戳，
//      ⛔ 不存正文、搜索词、选区；
//   ③ **有界**（`INV-PROG-03`）：≤ 200 条，超了按 `(updated_at, 路径)` 淘汰。
//
// ⚠️ 它**不是** [`Appearance`] 的一部分：外观是"一条记录一次写完"（`INV-THEME-05`），
//    而进度是**另一条**记录。两者共用 `Config` 与同一个会话锁，⛔ 不共用那个形状。
// ─────────────────────────────────────────────────────────────────────────

/// 进度表最多保留多少条（`INV-PROG-03`）。
pub const MAX_PROGRESS_ENTRIES: usize = 200;

/// 标题 id 的长度上限（**字符数**，不是字节）。
///
/// ⭐ 超限时**整个 id 丢弃**（`ratio` 保留），⛔ **不截断成前缀**——
/// 截出来的前缀可能**恰好匹配另一个标题**，把"回标题"变成"回错标题"
/// （`design/0017` 评审非阻塞①）。
pub const MAX_PROGRESS_ID_CHARS: usize = 256;

/// 一份文档的阅读位置。⚠️ 它**不是**授权凭据（`INV-PROG-01`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadingProgress {
    /// 最近一个位于视口顶部之上的标题 id（`reload.js` 的 `anchor.id`）。
    #[serde(default)]
    pub id: Option<String>,
    /// 从该标题到视口顶部的像素偏移。⚠️ 当前宿主**不滚动**时恒为 0。
    #[serde(default)]
    pub offset: f64,
    /// 文内比例 0..1；不可滚动时 `None`。
    #[serde(default)]
    pub ratio: Option<f64>,
    /// 记录时那份文档的源字节数（已剥 BOM）。
    /// ⚠️ **恢复路径不读它**——只用于排查"这个位置是哪一版文件记下的"。
    #[serde(default)]
    pub source_bytes: u64,
    /// 后端盖章的 Unix 秒。⭐ **前端传来的值一律忽略**（`INV-PROG-09`）。
    #[serde(default)]
    pub updated_at: u64,
}

impl Default for ReadingProgress {
    fn default() -> Self {
        ReadingProgress { id: None, offset: 0.0, ratio: None, source_bytes: 0, updated_at: 0 }
    }
}

impl ReadingProgress {
    /// 清洗一条进度。返回 `None` = 这条**没有任何可用信息**，不该写。
    ///
    /// ⚠️ 这张表就是 `design/0017` §2.1 ③ 那张表，逐条有单测：
    /// ratio 非有限 → `None`、越界夹到 0..=1；offset 非有限或负 → 0；
    /// 空 id → `None`；超长 id **整个丢弃**（ratio 保留）；两者都没了 → 整条不写。
    pub fn sanitized(self) -> Option<ReadingProgress> {
        let id = self.id.filter(|s| !s.is_empty() && s.chars().count() <= MAX_PROGRESS_ID_CHARS);
        let offset = if self.offset.is_finite() && self.offset >= 0.0 { self.offset } else { 0.0 };
        let ratio = self.ratio.and_then(|r| {
            if r.is_finite() {
                Some(r.clamp(0.0, 1.0))
            } else {
                None
            }
        });
        if id.is_none() && ratio.is_none() {
            return None;
        }
        Some(ReadingProgress { id, offset, ratio, source_bytes: self.source_bytes, updated_at: self.updated_at })
    }
}

/// 一次进度写入的结果（`Config::set_reading_progress` 的返回值）。
///
/// ⭐ `evicted` 必须回到前端：否则那份**运行期恢复表**会一直留着一条
/// 后端已经淘汰的条目，下次打开它还会"恢复"到一个早已不存在的历史
/// （`design/0017` 评审 R1）。
#[derive(Debug, Clone, PartialEq)]
pub struct ProgressWrite {
    /// 清洗并盖章后的条目；`None` = 这次写入没有可用信息（`ignored`）。
    pub entry: Option<ReadingProgress>,
    /// 本次写入触发淘汰的路径（供前端同步删表）。
    pub evicted: Vec<String>,
}

/// 逐条容错的反序列化边界（`design/0017` §2.1 ④ ＋ `design/0020` §2.1 ②）。
///
/// ⚠️ 泛型函数只做**逐条容错 ＋ 逐条清洗**；"清洗后剩下什么算数"由类型自己回答，
/// ⛔ 不在泛型里写 `if V == DirSession` 那种类型分支（`design/0020` §2.1 ②）。
trait TolerantEntry: Sized {
    /// 日志里的人话表名（只用于 stderr / 日志，⛔ 不进配置）。
    const LABEL: &'static str;

    /// 清洗一条：`None` = 这一条**没有可用信息**，加载时丢掉它。
    ///
    /// ⚠️ `key` 是这条在表里的键（阅读进度 = 文件路径；目录会话 = 根目录路径），
    /// 因为两类条目的清洗判据都离不开它（`design/0020` 的"必在该根之下"）。
    fn clean(&self, key: &str) -> Option<Self>;
}

impl TolerantEntry for ReadingProgress {
    const LABEL: &'static str = "进度";

    fn clean(&self, _key: &str) -> Option<Self> {
        // ⚠️ 进度的清洗只看条目本身（它没有"必须在某个根之下"这一层）。
        self.clone().sanitized()
    }
}

/// 逐条容错的中间形状（`design/0017` §2.1 ④，`design/0020` 起泛型化）。
///
/// ⚠️ `#[serde(default)]` 只治**缺字段**，治不了**类型不符**（某个值被手改成字符串）。
/// 而 `Config` 是**整份**反序列化 ⇒ 一条坏条目会让整份配置回落默认，
/// **外观与侧栏宽一起丢**。所以这一层逐条吞：`Known` 收下，`Unknown` 只跳过这一条。
#[derive(Deserialize)]
#[serde(untagged)]
enum MaybeEntry<V> {
    Known(V),
    /// ⭐ 任意形状都吞掉：`IgnoredAny` 不物化值，⛔ 不引入新依赖。
    Unknown(serde::de::IgnoredAny),
}

/// 逐条容错反序列化（`reading_progress` / `dir_sessions` 共用）。
///
/// ⚠️ 整份 JSON 语法坏掉仍是既有口径（`Config::load` 全默认）——本函数⛔ 不改变它。
/// ⚠️ 表级裁剪**不在这里**：它由 [`Config::load`] 按各自的条数上限做
/// （泛型里没有"上限是多少"这回事，⛔ 别为它再加一条类型分支）。
fn de_tolerant_map<'de, D, V>(d: D) -> Result<BTreeMap<String, V>, D::Error>
where
    D: serde::Deserializer<'de>,
    V: Deserialize<'de> + TolerantEntry,
{
    let raw = BTreeMap::<String, MaybeEntry<V>>::deserialize(d)?;
    let mut out = BTreeMap::new();
    for (key, e) in raw {
        match e {
            MaybeEntry::Known(v) => {
                if let Some(c) = v.clean(&key) {
                    out.insert(key, c);
                }
            }
            MaybeEntry::Unknown(_) => {
                // ⚠️ `IgnoredAny` 不带错误信息 ⇒ 这里只知道"形状不对"，
                //    说不出是哪个字段。⛔ 但这已经比"整份配置回落默认"好得多。
                diag_stderr!("⚠️ {}条目类型不对（只跳过这一条）：{key}", V::LABEL);
                diag_file!(
                    "⚠️ {}条目类型不对（只跳过这一条） key={} err_class=serde",
                    V::LABEL,
                    key
                );
            }
        }
    }
    Ok(out)
}

/// 把进度表裁到 [`MAX_PROGRESS_ENTRIES`]，返回被淘汰的路径。
///
/// ⚠️ 次序是 `(updated_at, 路径)` 的**元组**：同一秒写入的多条也有确定的淘汰顺序，
/// ⛔ 不依赖 `BTreeMap` 的偶然遍历顺序（换成 `HashMap` 就会变）。
fn trim_progress(map: &mut BTreeMap<String, ReadingProgress>) -> Vec<String> {
    let mut evicted = Vec::new();
    while map.len() > MAX_PROGRESS_ENTRIES {
        let victim = map
            .iter()
            .min_by(|(pa, a), (pb, b)| {
                (a.updated_at, pa.as_str()).cmp(&(b.updated_at, pb.as_str()))
            })
            .map(|(p, _)| p.clone());
        match victim {
            Some(k) => {
                map.remove(&k);
                evicted.push(k);
            }
            None => break,
        }
    }
    evicted
}

// ─────────────────────────────────────────────────────────────────────────
// ⭐ 目录会话（`design/0020`）
// ─────────────────────────────────────────────────────────────────────────

/// 最多保留多少个目录的会话（`INV-SESS-05`）。
///
/// ⚠️ 这个数是**本项目自定**的：调研（`research/notes/0022`）里 VS Code 无上限、
/// Obsidian 存 vault 内、Typora 只存一条，**没有外部标准**可用（`design/0020` §1.2）。
///
/// ⚠️⚠️ **2026-10-21 由 50 降到 20**——`design/0020` §7.7 的体积预算把它压下来的：
/// 按真实长路径（含中文目录名）构造 50 个目录 × 200 条展开，`config.json` 实测
/// **20 × 200 时 ≈ 480 KiB**，而 50 × 200 是 **≈ 1.15 MiB**（预算 512 KiB）。
/// ⭐ 处置**照设计 §5 写的顺序**执行：第一步降这个上限，⛔ 不改存储格式。
/// ⚠️ 20 个"最近的目录"对单个用户足够（淘汰按 `updated_at`）；实测数字见 `design/0020` §7.7。
pub const MAX_DIR_SESSIONS: usize = 20;

/// 每个目录最多记住多少条展开路径（`INV-SESS-05`）。
///
/// ⚠️ 超出时保**浅**的：浅的那层是深的的前提，先展开祖先才能展开后代。
pub const MAX_EXPANDED_PER_DIR: usize = 200;

/// 单条路径的字符数护栏（`INV-SESS-05`）。超限**整个丢掉**，⛔ 不截断。
pub const MAX_SESSION_PATH_CHARS: usize = 4096;

/// 一个目录的"上次离开时的样子"。⚠️ 它**不是**授权凭据（`INV-SESS-01`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirSession {
    /// 上次读的那一份（规范化真实路径，**必在 key 那个目录之下**）。
    /// ⚠️ 它可能已经不存在了——恢复时由 `open_document` 当场判（`design/0020` §6）。
    #[serde(default)]
    pub last_file: Option<String>,
    /// 用户展开过的目录（规范化真实路径，**全部在该目录之下**，⛔ 不含根自身）。
    /// ⚠️ 存的是**一组路径**，不是树快照：下次恢复时按"由浅到深"逐个展开。
    #[serde(default)]
    pub expanded: Vec<String>,
    /// 后端盖章的 Unix 秒。⭐ **前端传来的值一律忽略**（`INV-SESS-06`）。
    #[serde(default)]
    pub updated_at: u64,
}

impl Default for DirSession {
    fn default() -> Self {
        DirSession { last_file: None, expanded: Vec::new(), updated_at: 0 }
    }
}

impl TolerantEntry for DirSession {
    const LABEL: &'static str = "目录会话";

    fn clean(&self, key: &str) -> Option<Self> {
        // ⭐ 加载时"清洗后为空"就丢掉这一条（它本来就等于"没有会话"）。
        //    ⚠️ 这与写入时的口径**不同**：写入时空载荷是**合法状态**，语义是删掉该条
        //    （`INV-SESS-12`），由 [`Config::set_dir_session_at`] 落到 `remove_dir_session`。
        let s = self.sanitized(key);
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

impl DirSession {
    /// ⭐ 按 `root` 清洗一条会话。**总是返回一条**（空会话是合法值，`INV-SESS-12`）。
    ///
    /// 这张表就是 `design/0020` §2.1 ③ 那张表，逐条有单测：
    /// `last_file` 越界 / 空 / 超长 → `None`；`expanded` 越界项与根自身 → 丢；
    /// 去重；按**路径深度升序、同深度按字节序**排序；超 200 保**浅**的 200 条。
    pub fn sanitized(&self, root: &str) -> DirSession {
        let last_file = self
            .last_file
            .as_deref()
            .filter(|p| path_len_ok(p) && is_under(root, p))
            .map(|p| p.to_string());

        let mut expanded: Vec<String> = self
            .expanded
            .iter()
            .filter(|p| path_len_ok(p) && is_under(root, p))
            .cloned()
            .collect();
        // ⚠️ 先按 (深度, 字节序) 排，再 `dedup`：相同的串必然相邻。
        expanded.sort_by(|a, b| (path_depth(a), a.as_str()).cmp(&(path_depth(b), b.as_str())));
        expanded.dedup();
        expanded.truncate(MAX_EXPANDED_PER_DIR);

        DirSession { last_file, expanded, updated_at: self.updated_at }
    }

    /// 没有任何可恢复的东西（`INV-SESS-12`：这是**合法状态**，不是"无效输入"）。
    pub fn is_empty(&self) -> bool {
        self.last_file.is_none() && self.expanded.is_empty()
    }
}

/// 单条路径的护栏：非空且不超过 [`MAX_SESSION_PATH_CHARS`] **字符**。
fn path_len_ok(p: &str) -> bool {
    !p.is_empty() && p.chars().count() <= MAX_SESSION_PATH_CHARS
}

/// 路径深度（`/` 的个数）。⚠️ 只用于**排序**，⛔ 不用于任何安全判断。
fn path_depth(p: &str) -> usize {
    p.bytes().filter(|&b| b == b'/').count()
}

/// 根目录的规范形态：去掉尾部 `/`，但 `/` 本身不能被去掉。
fn root_key(root: &str) -> &str {
    let t = root.trim_end_matches('/');
    if t.is_empty() {
        "/"
    } else {
        t
    }
}

/// `p` 是否在 `root` **之下**（按路径分量；⛔ 不是字符串前缀）且不等于根自身。
///
/// ⚠️⚠️ **这是 `INV-FS-01` 那条 `Path::starts_with` 纪律在会话表上的同一条**：
/// 字符串前缀会让 `/a/rootfoo` 通过 `/a/root` 的判断。树里的路径来自后端，
/// 但**手改 config 是预期输入**（`design/0020` §6 最后两行）。
///
/// ⚠️ 这条函数**只做包含过滤**，⛔ 不做规范化、⛔ 不做授权判断
/// （`INV-TREE-01`；真路径已由后端 `check_readable` 给过）。
fn is_under(root: &str, p: &str) -> bool {
    if !p.starts_with('/') || p.split('/').any(|c| c == "." || c == "..") {
        return false;
    }
    let r = root_key(root);
    if p == r {
        return false;
    }
    if r == "/" {
        // 根的直属项是 `/x`（`//x` 不是）；`p == "/"` 已在上面挡掉。
        return p.as_bytes().get(1).is_some_and(|&b| b != b'/');
    }
    p.len() > r.len() && p.starts_with(r) && p.as_bytes().get(r.len()) == Some(&b'/')
}

/// 把会话表裁到 [`MAX_DIR_SESSIONS`]，返回被淘汰的根路径。
///
/// ⚠️ 与 [`trim_progress`] 同一把尺子：次序是 `(updated_at, 根路径)` 的**元组**。
fn trim_dir_sessions(map: &mut BTreeMap<String, DirSession>) -> Vec<String> {
    let mut evicted = Vec::new();
    while map.len() > MAX_DIR_SESSIONS {
        let victim = map
            .iter()
            .min_by(|(ka, a), (kb, b)| (a.updated_at, ka.as_str()).cmp(&(b.updated_at, kb.as_str())))
            .map(|(k, _)| k.clone());
        match victim {
            Some(k) => {
                map.remove(&k);
                evicted.push(k);
            }
            None => break,
        }
    }
    evicted
}

/// 一次会话写入的结果（`Config::set_dir_session` 的返回值）。
#[derive(Debug, Clone, PartialEq)]
pub struct DirSessionWrite {
    /// 清洗并盖章后的条目；⚠️ 它可能是空会话——那表示**该条已被删除**（`cleared`）。
    pub entry: DirSession,
    /// 本次写入触发淘汰的根路径。
    pub evicted: Vec<String>,
}


/// 落盘的配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Config {
    /// ⭐ **目录过滤清单**（`design/0040`，2026-10-24）：**目录名字**，逐字、大小写敏感匹配。
    ///
    /// ⚠️ **出厂值** = 原来的硬编码四个（`tree::DEFAULT_IGNORE_DIRS`）；
    /// ⚠️ **`[]` 是合法值**，表示"一个都不忽略"——与"没写这个键"**不是**一回事。
    ///
    /// 三条口径：
    /// ① **只在启动时读一次**（`Config::load`）；改完要重启应用。
    /// ② **应用运行中手改会被覆盖**：`save` 是**全量写盘**（`INV-THEME-05` 同族），
    ///    下次保存任何偏好都会用内存里这份写回去 ⇒ 先退出再改。
    /// ③ ⚠️ **坏形状只回本键**（`de_ignore_dirs`）：手写成 `"node_modules"` 而不是数组时，
    ///    回落默认四项，⛔ **不**让整份配置（外观/语言/最近目录）一起变默认值——
    ///    这是本键**专供手改**带来的额外收紧（`INV-FILTER-06`）。
    ///
    /// ⚠️ 它**不是**授权：清单为空 ⛔ 不等于能读更多东西（`INV-FILTER-04`）。
    #[serde(
        default = "crate::fs::tree::default_ignore_dirs",
        deserialize_with = "de_ignore_dirs",
        skip_serializing_if = "is_default_ignore_dirs"
    )]
    pub ignore_dirs: Vec<String>,

    /// 侧边栏宽度（逻辑像素）。`None` = 用户没拖过。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_width: Option<f64>,

    /// 上次打开的**目录**（绝对路径字符串）。`None` = 还没有过。
    ///
    /// ⚠️ 只记**目录**，不记文件：它是"未授权态"里那个「打开此目录」按钮的预置值
    /// （§2.1.4）。打开一个文件**不**更新它——那会把"最近目录"变成"最近文件"。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_directory: Option<String>,

    /// ⭐ **主题模式**（`design/0004`）。`None` = 用默认（light）。
    ///
    /// ⚠️ 它**必须**在这儿——`INV-THEME-03`：主题名只有一份真值（配置文件），
    /// ⛔ 不并存 `localStorage` 或 URL 参数等副本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,

    /// 正文基准字号（`design/0005` §2.1.5 的可调项之一）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reader_font_size: Option<f64>,
    /// 行高（可调项之二）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reader_line_height: Option<f64>,
    /// 内容宽度上限（可调项之三）。⚠️ `0` = 铺满。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reader_content_width: Option<f64>,

    /// ⭐ **编辑态 Vim 键位**（`design/0014` 裁定 (a)）。`None` = 没写过 ⇒ 关闭。
    ///
    /// ⚠️ 名字**不是** `reader_*`：它跟阅读排版毫无关系，前面那三个前缀是
    /// `design/0005` 的尺度族。⚠️ 而它与那三个**共用同一条写请求**
    /// （见 [`Config::set_appearance`]）——这是刻意的，理由写在那里。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vim_mode: Option<bool>,

    /// ⭐ **界面语言偏好**（`design/0025` §2.4）：`"system"` / `"zh"` / `"en"`。
    ///
    /// ⚠️ 与 [`THEMES`] 同形——存的是**偏好**，⛔ 不是解析后的语言：
    /// 「跟随系统」是一个合法的用户选择，它解析成 `zh` / `en` 的**唯一裁定点**
    /// 在 [`crate::lang`]（`INV-I18N-07`）。`None` 与 `"system"` **等价**
    /// （老用户的 `config.json` 里没有这个键）。
    ///
    /// ⚠️ 读它一律走 [`Config::language_preference`]：那会把拼错的词归一成 `"system"`，
    /// 而不是让一个手改成 `"fr"` 的键把界面变成第三种状态。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,

    /// ⭐ **外部编辑器的应用名**（`design/0006` §2.1 ④ / §9.3 第 2 条）。    ///
    /// ⚠️ 它是**应用名**（原样交给 `open -a <名字> <路径>` 的那一个参数），
    /// ⛔ **不是**一条命令行、⛔ 不是可执行文件路径——`INV-EXT-01` 禁止任何一层
    /// 去解释它（连它自己也只是一个独立 argv，见 `external::editor_argv`）。
    /// 空 / 全空白 = **没配置** ⇒ 走系统默认文本编辑器（`open -t`）。
    ///
    /// ⚠️ **V1 没有设置界面**（`design/0006` §3 的改动面里没有 `components/`）：
    /// 这个键由用户手改 `config.json` 写入。所以"配置坏掉/拼错"是**预期内的输入**：
    /// 拼错的应用名不 panic，只是 `open` 返回非零 ⇒ 界面上给一条提示（§6 降级）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_editor: Option<String>,

    /// ⭐ **侧边栏的文件形态**（`design/0041` §2.3）：`"tree"` / `"list"`。
    ///
    /// ⚠️ **缺键 = `"tree"`**（出厂与 `0041` 之前逐字节一致）；拼错/未知值同样归 `"tree"`。
    /// ⚠️ 写盘时 `"tree"` **不写**（`skip_serializing_if`）——它等价于"没有这个键"，
    /// 所以"切回树再保存"不会在老配置里留下一个新键。
    /// ⚠️ 它是**偏好**，⛔ 不是会话状态：切形态不换根、不换当前文档（`INV-DOCS-07`）。
    #[serde(default, skip_serializing_if = "is_tree_view")]
    pub sidebar_file_view: Option<String>,

    /// ⭐ **树里隐藏"子树没有 md"的目录**（`design/0041` §2.2）：缺键 = `true`。
    ///
    /// ⚠️ 只影响**列什么**，⛔ 不影响授权、⛔ 不影响搜索/列表的收录范围。
    /// `false` ⇒ 树逐字节回到 `0041` 之前的行为（§8 的回滚开关）。
    /// ⚠️ 本键**没有写命令**：只由人改 `config.json`（与 `external_editor` 同族），
    /// 但**读**是走 `get_session` 快照的（前端要它决定要不要过滤）。
    #[serde(default, skip_serializing_if = "is_default_hide_empty")]
    pub hide_empty_dirs: Option<bool>,

    /// ⭐ **阅读—编辑连续性开关**（`design/0047` §8）：缺键 = `false`。
    ///
    /// ⚠️ **出厂关着是刻意的**，⛔ 不是"还没做完"：打开之后，**单击正文就会进入
    /// 就地编辑**（覆盖层）——那是一条全新的输入路径（离屏 `textarea` ＋ 自绘光标），
    /// 而它要不要默认开着，只能在真机上按手感定。
    /// ⇒ `false` 时前端**一条监听都不挂**，行为逐字回到 `design/0012`。
    ///
    /// ⚠️ 与 `hide_empty_dirs` 同族：**本键没有写命令**，只由人改 `config.json`，
    /// 但**读**走 `get_session` 快照（前端要它决定要不要挂那套监听）。
    /// ⚠️ 默认值**不写盘**（`skip_serializing_if`）⇒ 老用户的 `config.json` 逐字节不变。
    #[serde(default, skip_serializing_if = "is_default_live_edit")]
    pub live_edit: Option<bool>,

    /// ⭐ **阅读进度表**（`design/0017`）：键 = **规范化后的真实路径**，值 = 一份位置。
    ///
    /// ⚠️ 三条边界见 [`ReadingProgress`] 上面的注释块：
    /// 不是授权（`INV-PROG-01`）、只存位置元数据（`INV-PROG-02`）、有界（`INV-PROG-03`）。
    ///
    /// ⚠️ `deserialize_with` 是**逐条容错**：某一条类型不对只跳过它，
    /// ⛔ 不让整份配置回落默认（否则一条坏进度会连外观一起丢，`design/0017` §2.1 ④）。
    /// ⚠️ 空表不写盘：首次启动的 `config.json` 不该多出一个空对象。
    #[serde(
        default,
        deserialize_with = "de_tolerant_map",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub reading_progress: BTreeMap<String, ReadingProgress>,

    /// ⭐ **目录会话表**（`design/0020`）：键 = **后端规范化后的根目录路径**
    /// （`grants.roots()[0]` 那一份），值 = 那个目录"上次离开时的样子"。
    ///
    /// ⚠️ 三条边界见 [`DirSession`] 上面的注释块：
    /// 不是授权（`INV-SESS-01`）、路径必在当前根之下（`INV-SESS-02`）、有界（`INV-SESS-05`）。
    ///
    /// ⚠️ **键必须等于授权根，⛔ 子目录不行**——子目录不是"这一代会话"的键。
    /// ⚠️ 空表不写盘：与 `reading_progress` 同一个理由（老用户升级后文件逐字节不变）。
    #[serde(
        default,
        deserialize_with = "de_tolerant_map",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub dir_sessions: BTreeMap<String, DirSession>,

    /// ⭐ **收藏**（`design/0043`）：**后端规范化后的绝对路径**，数组顺序 = 显示顺序。
    ///
    /// ⚠️ **它不是授权**（`INV-FAV-01`）：这里面的路径过不了 `check_readable`，
    /// 打开必须走 `open_favorite` 的复核。⚠️ 与 `dir_sessions` 的区别在于 provenance：
    /// 那些键只由**一次成功打开**产生，这里的值由用户**钉住**（`favorites_apply` 的
    /// `Add` 仍必须先过当刻读取授权，`INV-FAV-07`）。
    ///
    /// ⚠️ **坏形状只回本键**（`de_favorites`）：手写成 `"a.md"` 而不是数组时，
    /// 收藏段为空，⛔ 不让主题/语言/最近目录一起回落默认（`INV-FILTER-06` 同族）。
    /// ⚠️ 磁盘上的旧值**不规范化、不迁移、不自动清理**——失效项要可见地留着（`INV-FAV-06`）。
    /// ⚠️ 空表不写盘：老用户的 `config.json` 不因为升级多出一个键。
    #[serde(
        default,
        deserialize_with = "de_favorites",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub favorites: Vec<String>,

    /// ⭐ 本模块**不认识**的键，原样保留。
    ///
    /// ⚠️ 这是为了"将来加键时不会把现在的键抹掉"——`design/0004` 之前那些
    /// 主题键就是靠它活着的。⚠️ 现在主题键已经是**具名**字段了，
    /// 但这条保留规则**不撤**：任何一份更新的版本写下的键，
    /// 被这份旧代码读一遍再写回去时都不该消失。
    ///
    /// ⚠️ 用 `BTreeMap` 而不是 `HashMap`：写回去时键的顺序稳定，
    /// 配置文件在 git / 备份里 diff 出来是人读得懂的。
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// 目录过滤清单的**条数上限**（`design/0040`）。
/// ⚠️ 判定是逐项 `==` 比较，清单越长每项判定越贵；64 已经远超"常用中间目录"的规模。
pub const MAX_IGNORE_DIRS: usize = 64;

/// 收藏的**条数上限**（`design/0043` §2.1）。
///
/// ⚠️ 满了是**拒绝并可见提示**，⛔ 不静默淘汰最旧的一条——静默丢用户数据是最坏的一种"省事"。
/// ⚠️ 上限只在**写入口**（`favorites_apply` 的 `Add`）与**解码**两处判定；
/// `Remove` / `Move` / 打开一律不看上限（失效项必须还能删得掉）。
pub const FAVORITES_LIMIT: usize = 50;
/// 单个清单项的长度上限（字节）。与文件名的 255 字节口径一致。
pub const MAX_IGNORE_DIR_NAME_BYTES: usize = 255;

/// ⭐ **过滤清单的归一化**（`design/0040` §2.1 ②，唯一实现）。
///
/// 手改配置是**预期输入**，所以坏项**静默丢弃**而不是报错（与 [`normalize_language`]
/// 对拼错语言词的处置同一条口径：一个写错的项不该让阅读器打不开）。
///
/// 丢弃的四类，各有理由：
/// - 空 / 全空白：手写配置最常见的尾随空格；
/// - 含 `/` `\` `\0` 或控制字符：清单只比**名字**，这类项**永远匹配不上**
///   （留着是"看起来生效了"）；
/// - `.` / `..` 与**以 `.` 开头**：① 类（点开头完全隐藏）优先级更高，这类项永远走不到；
/// - 重复项：判定只有"在不在"，重复纯属噪音。
///
/// ⚠️ **大小写不动**：匹配是逐字的大小写敏感比较（`INV-FILTER-02`），
/// 归一化不替用户做"大小写折叠"——那会让 `Target` 与 `target` 变成一件事，
/// 而它们在 APFS 上确实是**两个目录**。
pub fn normalize_ignore_dirs(raw: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in raw {
        let name = item.trim();
        if name.is_empty() || name.len() > MAX_IGNORE_DIR_NAME_BYTES {
            continue;
        }
        if name.starts_with('.') {
            continue;
        }
        if name.chars().any(|c| c == '/' || c == '\\' || c == '\0' || c.is_control()) {
            continue;
        }
        if out.iter().any(|e| e == name) {
            continue;
        }
        out.push(name.to_string());
        if out.len() >= MAX_IGNORE_DIRS {
            break;
        }
    }
    out
}

/// `sidebar_file_view` 是不是"树"（= 缺键 / 未知值）。
///
/// ⚠️ 只有**恰好** `"list"` 才算列表：拼错的词、`"LIST"`、空串一律回树。
/// ⇒ "坏配置不该让界面处于第三种状态"（与语言偏好同一条口径）。
fn is_tree_view(v: &Option<String>) -> bool {
    v.as_deref() != Some("list")
}

/// `hide_empty_dirs` 是不是出厂值（`true`）。⚠️ 只有**显式** `false` 才写盘。
fn is_default_hide_empty(v: &Option<bool>) -> bool {
    v != &Some(false)
}

/// 与出厂值（`false`）相等？（`design/0047` §8：`skip_serializing_if` 用它——
/// 老用户的 `config.json` 不因为升级多出一个键；⚠️ 缺键与 `false` 在这里**等价**，
/// 与 `hide_empty_dirs` 的"缺键 = `true`"相反，因为这一条的出厂值就是 `false`）
fn is_default_live_edit(v: &Option<bool>) -> bool {
    v != &Some(true)
}

/// 与出厂清单相等？（`skip_serializing_if` 用它：老用户的 `config.json` 不因为升级多出一个键）
fn is_default_ignore_dirs(v: &[String]) -> bool {    v.len() == crate::fs::tree::DEFAULT_IGNORE_DIRS.len()
        && v.iter().zip(crate::fs::tree::DEFAULT_IGNORE_DIRS).all(|(a, b)| a == b)
}

/// ⭐ **收藏的宽反序列化**（`design/0043` §2.1，`INV-FILTER-06` 同族）。
///
/// 与 [`de_ignore_dirs`] 同一条口径：手改配置是**预期输入**，坏形状⛔ 不许把整份配置拉回默认。
/// 但**清洗强度刻意更低**：
/// - 逐字保留（⛔ 不 `trim`、⛔ 不规范化、⛔ 不去重）——打开时会**原串逐字**匹配记录，
///   一旦解码时改写，用户手写的记录就再也命中不了自己（比"打不开"更难解释）；
/// - 失效项**不删**（`INV-FAV-06`）：它可能只是暂时移走了。
/// 只做一件事：**按 [`FAVORITES_LIMIT`] 截断**——防止手写一份超长数组把 `config.json`
/// 撑过体积预算（与 `normalize_ignore_dirs` 的硬上限同族）。
fn de_favorites<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: serde_json::Value = serde::Deserialize::deserialize(d)?;
    let Some(items) = value.as_array() else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(items.len().min(FAVORITES_LIMIT));
    for item in items {
        let Some(s) = item.as_str() else {
            // 混了非字符串 ⇒ 按"不是字符串数组"处理（⛔ 不猜、⛔ 不报错）
            return Ok(Vec::new());
        };
        out.push(s.to_string());
        if out.len() >= FAVORITES_LIMIT {
            diag_stderr!("⚠️ 收藏超过 {FAVORITES_LIMIT} 条，多出的已忽略");
            break;
        }
    }
    Ok(out)
}

/// ⭐ **宽反序列化**（`design/0040` §2.1 ④ / `INV-FILTER-06`）。
///
/// 默认的 `Vec<String>` 反序列化遇到 `"ignore_dirs": "node_modules"` 会**整个失败**，
/// 而 `Config::load` 的失败粒度是**整份**（模块头第 3 条）⇒ 外观、语言、最近目录一起丢。
/// 本键**专供手改**，所以这里先收成 `Value`：
/// 字符串数组 ⇒ 归一化；**任何其它形状**（含混了非字符串的数组）⇒ 回出厂四项。
/// ⛔ 不返回 `Err`——那是本题要避免的那条路。
fn de_ignore_dirs<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: serde_json::Value = serde::Deserialize::deserialize(d)?;
    let Some(items) = value.as_array() else {
        return Ok(crate::fs::tree::default_ignore_dirs());
    };
    let mut raw = Vec::with_capacity(items.len());
    for item in items {
        match item.as_str() {
            Some(s) => raw.push(s.to_string()),
            // 混了非字符串 ⇒ 按"不是字符串数组"处理（⛔ 不猜、⛔ 不报错）
            None => return Ok(crate::fs::tree::default_ignore_dirs()),
        }
    }
    Ok(normalize_ignore_dirs(raw))
}

impl Default for Config {
    fn default() -> Self {
        Config {
            sidebar_width: None,
            last_directory: None,
            theme: None,
            reader_font_size: None,
            reader_line_height: None,
            reader_content_width: None,
            vim_mode: None,
            language: None,
            external_editor: None,
            sidebar_file_view: None,
            hide_empty_dirs: None,
            live_edit: None,
            ignore_dirs: crate::fs::tree::default_ignore_dirs(),
            reading_progress: BTreeMap::new(),
            dir_sessions: BTreeMap::new(),
            favorites: Vec::new(),
            extra: BTreeMap::new(),
        }
    }
}

impl Config {
    /// 侧边栏宽度（带默认值与夹取）。
    pub fn sidebar_width_or_default(&self) -> f64 {
        clamp_width(self.sidebar_width.unwrap_or(DEFAULT_SIDEBAR_WIDTH))
    }

    /// 把宽度写进配置（已夹取）。
    pub fn set_sidebar_width(&mut self, w: f64) {
        self.sidebar_width = Some(clamp_width(w));
    }

    /// ⭐ 侧边栏形态（`design/0041` §2.3）：只可能是 `"tree"` / `"list"`。
    ///
    /// ⚠️ 读它**一律走这里**：缺键、拼错、大小写不对全部归一成 `"tree"`——
    /// ⛔ 不让一个手改坏的键把界面置于"第三种形态"。
    pub fn sidebar_file_view(&self) -> &'static str {
        if self.sidebar_file_view.as_deref() == Some("list") { "list" } else { "tree" }
    }

    /// 写形态。`"tree"` 存成 `None`（= 删掉这个键，保持老配置逐字节不变）。
    pub fn set_sidebar_file_view(&mut self, view: &str) {
        self.sidebar_file_view = if view == "list" { Some("list".to_string()) } else { None };
    }

    /// ⭐ 树里是否隐藏"子树没有 md"的目录（`design/0041` §2.2）：缺键 = `true`。
    pub fn hide_empty_dirs(&self) -> bool {
        self.hide_empty_dirs.unwrap_or(true)
    }

    /// ⭐ 阅读—编辑连续性是否开着（`design/0047` §8）：缺键 = `false`。
    pub fn live_edit(&self) -> bool {
        self.live_edit.unwrap_or(false)
    }

    /// ⛔ **只记路径**。见模块头第 2 条：它**不是**授权。
    pub fn set_last_directory(&mut self, dir: &Path) {
        self.last_directory = Some(dir.display().to_string());
    }

    /// ⭐ 当前外观（带默认值与夹取）。**冷启动**与 `get_session` 都读它。
    pub fn appearance(&self) -> Appearance {
        Appearance {
            mode: self.theme.clone().unwrap_or_else(default_theme),
            font_size: self.reader_font_size.unwrap_or(DEFAULT_FONT_SIZE),
            line_height: self.reader_line_height.unwrap_or(DEFAULT_LINE_HEIGHT),
            content_width: self.reader_content_width.unwrap_or(DEFAULT_CONTENT_WIDTH),
            // ⭐ `design/0014`：**没写过 ⇒ 关闭**（`DEFAULT_VIM_MODE`）——
            //    ⛔ 别写成 `true`，那是"出厂就开着"。
            vim_mode: self.vim_mode.unwrap_or(DEFAULT_VIM_MODE),
        }
        .clamped()
    }

    /// ⭐ 把一份**全量**外观写进配置（`INV-THEME-05`：写的是取当前 applied 全量）。
    pub fn set_appearance(&mut self, a: &Appearance) {
        let c = a.clone().clamped();
        self.theme = Some(c.mode);
        self.reader_font_size = Some(c.font_size);
        self.reader_line_height = Some(c.line_height);
        self.reader_content_width = Some(c.content_width);
        // ⭐ `design/0014`：**与上面四行同批写**（同一条记录、同一个写请求）。
        //    ⛔ 别把它拆成第二条命令——那正是 `INV-THEME-05` 要挡的"两个写者"。
        self.vim_mode = Some(c.vim_mode);
    }

    /// ⭐ 界面语言偏好，**已归一化**：恒为 [`LANGS`] 之一（`"system"` / `"zh"` / `"en"`）。
    ///
    /// ⚠️ `None`、空串、任何认不出来的词**一律** `"system"`——
    /// 与 [`Appearance::clamped`] 对拼错的主题名同一条口径（`design/0025` §2.4）。
    pub fn language_preference(&self) -> &'static str {
        normalize_language(self.language.as_deref())
    }

    /// 写语言偏好（**归一化后再落盘**，⛔ 不在文件里留一个拼错的词）。
    ///
    /// ⚠️ 归一成 `"system"` 时**存 `None`**（与"从没写过"逐字节相同）：
    /// 这是 `skip_serializing_if` 那一条的自然结果，也让老用户的文件在
    /// 只切了一次语言又切回来之后**逐字节回到原样**。
    pub fn set_language_preference(&mut self, pref: &str) {
        let n = normalize_language(Some(pref));
        self.language = if n == "system" { None } else { Some(n.to_string()) };
    }

    /// ⭐ 外部编辑器的应用名，**已归一化**：空 / 全空白 ⇒ `None`。
    ///
    /// ⚠️ 归一化在**两处**都做（这里与 `external::editor_argv`）是**有意的**：
    /// `editor_argv` 是纯函数，⛔ 它不许假定"调用方已经洗过一遍"——
    /// 那份假设一旦不成立，落到的就是命令注入那条线上。
    pub fn editor_name(&self) -> Option<&str> {
        self.external_editor.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }

    /// 写外部编辑器名（同样归一化，⛔ 不把空串存进文件）。
    pub fn set_external_editor(&mut self, name: Option<&str>) {
        self.external_editor =
            name.map(str::trim).filter(|s| !s.is_empty()).map(|s| s.to_string());
    }

    /// ⭐ 写入一条阅读进度（`design/0017` §2.1）。
    ///
    /// ⚠️ **时间戳由这里盖**（`INV-PROG-09`）：前端传来什么都覆盖掉。
    /// 理由不是防恶意——是**同一时刻的两份文档**在客户端比时钟，
    /// 淘汰次序会变成"谁的表快一点"，而不是"谁更久没被读过"。
    pub fn set_reading_progress(&mut self, path: &str, p: ReadingProgress) -> ProgressWrite {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        self.set_reading_progress_at(path, p, now)
    }

    /// [`Config::set_reading_progress`] 的可注入时钟版本（单测用它，⛔ 不睡真时间）。
    pub fn set_reading_progress_at(
        &mut self,
        path: &str,
        p: ReadingProgress,
        now: u64,
    ) -> ProgressWrite {
        let stamped = ReadingProgress { updated_at: now, ..p };
        let Some(clean) = stamped.sanitized() else {
            // ⚠️ "没有任何可用信息" ⇒ **不写**，也**不淘汰别的条目**——
            //    一次空写入不该挤出别人的进度。
            return ProgressWrite { entry: None, evicted: Vec::new() };
        };
        self.reading_progress.insert(path.to_string(), clean.clone());
        let evicted = trim_progress(&mut self.reading_progress);
        ProgressWrite { entry: Some(clean), evicted }
    }

    /// ⭐ 读一条（只读；⚠️ 它**不是**授权，只是"上次看到哪儿"）。
    pub fn reading_progress_of(&self, path: &str) -> Option<&ReadingProgress> {
        self.reading_progress.get(path)
    }

    /// ⭐ 读某个根目录的会话（只读；⚠️ 它**不是**授权，只是"上次离开时的样子"）。
    pub fn dir_session(&self, root: &str) -> Option<&DirSession> {
        self.dir_sessions.get(root)
    }

    /// ⭐ 写入一条目录会话（`design/0020` §2.1 ③）。
    ///
    /// ⚠️ **时间戳由这里盖**（`INV-SESS-06`）：前端传来什么都覆盖掉。
    /// ⚠️ **空会话是合法状态**：清洗后为空 ⇒ **删掉该条**（`INV-SESS-12`），
    /// ⛔ 不是"忽略、保留旧值"——否则「先展开、再全部折叠」永远存不下来（评审 R4）。
    pub fn set_dir_session(&mut self, root: &str, s: DirSession) -> DirSessionWrite {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        self.set_dir_session_at(root, s, now)
    }

    /// [`Config::set_dir_session`] 的可注入时钟版本（单测用它，⛔ 不睡真时间）。
    pub fn set_dir_session_at(&mut self, root: &str, s: DirSession, now: u64) -> DirSessionWrite {
        let clean = DirSession { updated_at: now, ..s }.sanitized(root);
        if clean.is_empty() {
            self.remove_dir_session(root);
            return DirSessionWrite { entry: clean, evicted: Vec::new() };
        }
        self.dir_sessions.insert(root.to_string(), clean.clone());
        let evicted = trim_dir_sessions(&mut self.dir_sessions);
        DirSessionWrite { entry: clean, evicted }
    }

    /// 删掉一个根目录的会话。返回"原来到底有没有"（⚠️ 空会话落点，幂等）。
    pub fn remove_dir_session(&mut self, root: &str) -> bool {
        self.dir_sessions.remove(root).is_some()
    }

    /// 从磁盘读。**任何失败都返回默认值**（模块头第 3 条）。
    pub fn load(path: &Path) -> Config {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Config::default();
        };
        match serde_json::from_str::<Config>(&text) {
            Ok(c) => {
                // ⚠️ 磁盘上的值也要夹一次：手改过的 3000 会撑爆布局
                let a = c.appearance();
                let mut loaded = Config {
                    sidebar_width: c.sidebar_width.map(clamp_width),
                    theme: Some(a.mode),
                    reader_font_size: Some(a.font_size),
                    reader_line_height: Some(a.line_height),
                    reader_content_width: Some(a.content_width),
                    // ⭐ `design/0014`：手改配置写了个坏值也一样——它是 `bool`，
                    //    JSON 里塞的是 `"yes"` / `1` 的话**整份配置会反序列化失败**
                    //    （serde 不会替我们宽松），落到下面那个 `Err` 分支 ⇒ 全默认值。
                    //    ⚠️ 那**不是**本键特有的行为，是这一层既有的口径（模块头第 3 条
                    //    "坏配置不该让阅读器打不开"），所以这里**只做与别处一致的归一化**。
                    vim_mode: Some(a.vim_mode),
                    // ⭐ `design/0025`：拼错的词归一成 `"system"`（落 `None`，与"没写过"等价）。
                    //    ⚠️ 走 `normalize_language` 而**不是**在这里另写一条 match——
                    //    那是第二份真值，而它分叉的表现是"设置里显示跟随系统、实际是英文界面"。
                    language: match normalize_language(c.language.as_deref()) {
                        "system" => None,
                        n => Some(n.to_string()),
                    },
                    // ⚠️ 手改配置写了个空白串 ⇒ 与"没写"等价（⛔ 别让它变成"应用名叫空格"）
                    external_editor: c
                        .external_editor
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty()),
                    ..c
                };
                // ⭐ 表级裁剪在**加载时**统一做（`design/0017` §7.1 第 14 条、
                //    `design/0020` §7.1 第 9 条）：逐条清洗已在 `de_tolerant_map` 里完成。
                let _ = trim_progress(&mut loaded.reading_progress);
                let _ = trim_dir_sessions(&mut loaded.dir_sessions);
                loaded
            }
            Err(e) => {
                // ⚠️ serde 的错误消息会**引用输入原文** ⇒ 只进 stderr；
                //    文件里只留类别、长度与路径（`INV-LOG-11`）。
                diag_stderr!("⚠️ 配置读不动（用默认值继续）：{}：{e}", path.display());
                diag_file!(
                    "⚠️ 配置读不动（用默认值继续） path={} err_class={} err_len={}",
                    path.display(),
                    crate::logging::err_class(&e),
                    e.to_string().len()
                );
                Config::default()
            }
        }
    }

    /// 写到磁盘。⚠️ 原子替换（先写 `.tmp` 再 `rename`）：
    /// 直接覆盖时进程若在写一半时死掉，留下的是一个**半截 JSON**，
    /// 下次启动就会走"读不动 → 默认值"，用户的宽度设置静默丢失。
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)
    }
}

/// 把宽度夹进 [`MIN_SIDEBAR_WIDTH`] .. [`MAX_SIDEBAR_WIDTH`]。
///
/// ⚠️ NaN 也要处理：`f64` 从 JSON 里读不出 NaN，但前端传来的可能是
/// `NaN`（`JSON.parse` 不允许，`invoke` 的序列化却可能带过来），
/// 而 `NaN` 会让 `clamp` 直接返回 NaN → CSS 变量写进去就是无效值。
pub fn clamp_width(w: f64) -> f64 {
    if !w.is_finite() {
        return DEFAULT_SIDEBAR_WIDTH;
    }
    w.clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rmd-config-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join(FILE_NAME)
    }

    /// ⭐⭐ **线上形状的对账**（`docs/bugs/0007`）——
    /// 下面这段 JSON **逐字**就是 `src/services/theme.js::toPayload` 的产物。
    ///
    /// ⚠️ 它守的是一条**一次都不报错的**静默丢失：后端 `Appearance` 的字段名是
    /// snake_case，而前端内存里的记录是 camelCase。serde 对**不认识的键**
    /// 默认是**忽略**（不是报错），对**缺失的键**用 `#[serde(default)]`
    /// ⇒ 两边键名不一致时，命令**成功返回**、界面**当场生效**、
    /// `#save-warn` **不亮**，只有磁盘上那几个值悄悄变成出厂值。
    /// ⚠️ 2026-10-16 实测：`{"mode":"dark","fontSize":20,…}` 解出来 `font_size = 14`。
    #[test]
    fn 外观线上形状_前端那份_dto_能被完整识别() {
        let v: Appearance = serde_json::from_str(
            r#"{"mode":"dark","font_size":20.0,"line_height":1.8,"content_width":900.0,"vim_mode":true}"#,
        )
        .unwrap();
        assert_eq!(v.mode, "dark");
        assert_eq!(v.font_size, 20.0, "⚠️ font_size 没被吃进去 —— 前端发的是别的键名？");
        assert_eq!(v.line_height, 1.8, "⚠️ line_height 没被吃进去");
        assert_eq!(v.content_width, 900.0, "⚠️ content_width 没被吃进去");
        assert!(v.vim_mode, "⚠️ vim_mode 没被吃进去 —— 设置里那个开关会永远存不住");
    }

    /// ⚠️ **反面**：serde **不会**替我们做大小写转换。
    ///
    /// ⭐ 这一条钉的是"`toPayload` 为什么必须存在"。它**会在**有人给
    /// `Appearance` 加 `#[serde(rename_all = "camelCase")]` 时变红——
    /// ⭐ **那不是误报，是要的**：那么改的话 `get_session` 回给前端的那一份
    /// 也一起变成 camelCase 了，而 `theme.js::reset` 读的是 `src.font_size`
    /// ⇒ 冷启动会静默用出厂值。**两半必须同批改**，这条断言的作用是
    /// 让"只改了一半"当场可见（`docs/bugs/0007` 的形态）。
    ///
    /// ⚠️ 用它自己的**默认值**做判据，⛔ 不是写死的数字：默认值以后改了这条也不该跟着改。
    #[test]
    fn 外观线上形状_后端不认_camelCase_所以必须有一层翻译() {
        let v: Appearance = serde_json::from_str(r#"{"mode":"warm","fontSize":20}"#).unwrap();
        assert_eq!(v.mode, "warm", "mode 两边恰好同名，它一直是对的（所以这个缺陷才藏得住）");
        assert_eq!(
            v.font_size, DEFAULT_FONT_SIZE,
            "⚠️ 后端居然认出了 camelCase —— 若这是刻意加的 rename_all，\
             请同批改 theme.js::reset / toPayload 与 get_session 那一侧，\
             ⛔ 别只改一半（docs/bugs/0007）"
        );
    }

    /// ⭐ `design/0014` 裁定 (a)：**没写过 ⇒ 关闭**（出厂档）。
    #[test]
    fn vim_mode_没写过时是关的() {
        let c = Config::default();
        assert!(!c.appearance().vim_mode, "出厂档必须是关闭的（裁定 (a)）");
        assert!(
            !DEFAULT_VIM_MODE,
            "DEFAULT_VIM_MODE 被改成了 true —— 那是「出厂就开着 Vim」，与裁定 (a) 相反"
        );
    }

    /// ⚠️ **`clamped()` 必须原样带着 `vim_mode` 走**。
    ///
    /// 漏了它的话，**每一次外观写入**（切主题、改字号…）都会顺手把 Vim 关掉——
    /// 表现是"切一次主题，Vim 就自己关了"，而且**每次单独看都没问题**。
    #[test]
    fn vim_mode_被夹取时不会被顺手关掉() {
        let a = Appearance { mode: "drak（拼错的主题名）".into(), font_size: 999.0, vim_mode: true, ..Default::default() }
            .clamped();
        assert!(a.vim_mode, "⛔ clamped() 把 vim_mode 丢了 —— 切一次主题就会关掉 Vim");
        // ⚠️ 顺带确认它**没管**别的字段的夹取（这一条只管"别丢"）
        assert_eq!(a.mode, "system", "拼错的主题名照旧回落到 system");
        assert_eq!(a.font_size, MAX_FONT_SIZE);
    }

    #[test]
    fn 文件不存在时用默认值() {
        let p = tmp("missing");
        let c = Config::load(&p);
        assert_eq!(c, Config::default());
        assert_eq!(c.sidebar_width_or_default(), DEFAULT_SIDEBAR_WIDTH);
    }

    #[test]
    fn 坏json_不panic也不删文件() {
        let p = tmp("broken");
        std::fs::write(&p, "{ 这不是 json").unwrap();
        let c = Config::load(&p);
        assert_eq!(c.sidebar_width_or_default(), DEFAULT_SIDEBAR_WIDTH);
        assert!(p.exists(), "⛔ 坏文件是用户的数据，不许自动删");
    }

    #[test]
    fn 存取往返() {
        let p = tmp("roundtrip");
        let mut c = Config::default();
        c.set_sidebar_width(320.0);
        c.set_last_directory(Path::new("/Users/x/notes"));
        c.save(&p).unwrap();

        let back = Config::load(&p);
        assert_eq!(back.sidebar_width, Some(320.0));
        assert_eq!(back.last_directory.as_deref(), Some("/Users/x/notes"));
    }

    /// ⭐ 外部编辑器名（`design/0006`）：存取往返 + **空白归一化**。
    ///
    /// ⚠️ 后半条是关键：手改配置写 `"external_editor": "   "` 必须与"没写"等价。
    /// 若让它活下来，`editor_argv` 会拿到一个非空串 ⇒ 走 `open -a "   "` ⇒
    /// `open` 找不到那个应用 ⇒ **默认编辑器这条路被一条看不见的空格堵死**。
    #[test]
    fn 外部编辑器名_往返与空白归一化() {
        let p = tmp("editor");
        let mut c = Config::default();
        assert_eq!(c.editor_name(), None);
        c.set_external_editor(Some("  Typora  "));
        assert_eq!(c.editor_name(), Some("Typora"), "两头空白该被修掉");
        c.set_external_editor(Some("   "));
        assert_eq!(c.editor_name(), None, "全空白 == 没配置");
        assert_eq!(c.external_editor, None, "⛔ 空串不许落盘");

        c.set_external_editor(Some("Typora"));
        c.save(&p).unwrap();
        assert_eq!(Config::load(&p).editor_name(), Some("Typora"));

        // 手改文件：空白串读进来也要归一化
        std::fs::write(&p, r#"{"external_editor":"   "}"#).unwrap();
        assert_eq!(Config::load(&p).editor_name(), None);
    }

    #[test]
    fn 未知键被原样保留() {
        let p = tmp("extra");
        std::fs::write(
            &p,
            r#"{"theme":"dark","sidebar_width":300,"nested":{"a":1}}"#,
        )
        .unwrap();

        let mut c = Config::load(&p);
        assert_eq!(c.sidebar_width, Some(300.0));
        c.set_last_directory(Path::new("/tmp"));
        c.save(&p).unwrap();

        // ⭐ 0004 的主题键必须还在——否则"单一真源"会变成"互相覆盖"
        let text = std::fs::read_to_string(&p).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["nested"]["a"], 1);
        assert_eq!(v["last_directory"], "/tmp");
    }

    #[test]
    fn 磁盘上的越界宽度会被夹回来() {
        let p = tmp("clamp");
        std::fs::write(&p, r#"{"sidebar_width":99999}"#).unwrap();
        assert_eq!(Config::load(&p).sidebar_width, Some(MAX_SIDEBAR_WIDTH));

        let p2 = tmp("clamp-nan");
        std::fs::write(&p2, r#"{"sidebar_width":0}"#).unwrap();
        assert_eq!(Config::load(&p2).sidebar_width, Some(MIN_SIDEBAR_WIDTH));
        assert_eq!(clamp_width(f64::NAN), DEFAULT_SIDEBAR_WIDTH);
    }

    // ── 外观（design/0004 + design/0005）────────────────────────────────

    #[test]
    fn 外观的默认值() {
        let a = Config::default().appearance();
        // ⭐ 出厂档是「跟随系统」（B3），⛔ 不是写死的浅色
        assert_eq!(a.mode, "system");
        assert_eq!(a.font_size, DEFAULT_FONT_SIZE);
        assert_eq!(a.line_height, DEFAULT_LINE_HEIGHT);
        assert_eq!(a.content_width, DEFAULT_CONTENT_WIDTH);
    }

    #[test]
    fn 外观存取往返() {
        let p = tmp("appearance");
        let mut c = Config::default();
        c.set_appearance(&Appearance {
            mode: "dark".into(),
            font_size: 18.0,
            line_height: 1.8,
            content_width: 900.0,
            // ⭐ `design/0014` 裁定 (a)：`vim_mode` **并入这条记录**（⛔ 不是第二个命令、
            //    ⛔ 不是第二份落盘），所以它跟着这里一起往返。
            vim_mode: true,
        });
        c.save(&p).unwrap();

        let back = Config::load(&p);
        assert_eq!(back.appearance().mode, "dark");
        assert_eq!(back.appearance().font_size, 18.0);
        assert_eq!(back.appearance().line_height, 1.8);
        assert_eq!(back.appearance().content_width, 900.0);
        assert!(back.appearance().vim_mode, "⛔ 开了 Vim、存过盘、读回来却是关的");
    }

    #[test]
    fn 手改的越界外观会被夹回来() {
        let p = tmp("appearance-clamp");
        std::fs::write(
            &p,
            r#"{"theme":"warm","reader_font_size":999,"reader_line_height":0.1,"reader_content_width":99999}"#,
        )
        .unwrap();
        let a = Config::load(&p).appearance();
        assert_eq!(a.mode, "warm", "合法主题名要保留");
        assert_eq!(a.font_size, MAX_FONT_SIZE);
        assert_eq!(a.line_height, MIN_LINE_HEIGHT);
        assert_eq!(a.content_width, MAX_CONTENT_WIDTH);
    }

    #[test]
    fn 未知主题名回落而不是报错() {
        // ⚠️ 配置文件是明文，拼错的 "drak" 不该让阅读器打不开（模块头第 3 条）
        // ⭐ 回落目标是**默认模式**（`system`），⛔ 不是写死的 `light`——
        //    否则"拼错一个字"会顺手把用户的跟随系统设置也改掉。
        let p = tmp("appearance-bad-theme");
        std::fs::write(&p, r#"{"theme":"drak"}"#).unwrap();
        assert_eq!(Config::load(&p).appearance().mode, default_theme());
        assert_eq!(default_theme(), "system", "B3：默认这一档是「跟随系统」");
    }

    #[test]
    fn 内容宽度的零是铺满_不是被夹成最小值() {
        // ⭐ A4 的结论是「铺满 + 一个宽松上限」，而"铺满"就是 content_width = 0。
        //    ⛔ 把它当越界值钳到 MIN_CONTENT_WIDTH 会把用户的选择静默改掉。
        assert_eq!(clamp_content_width(0.0), 0.0);
        assert_eq!(clamp_content_width(100.0), MIN_CONTENT_WIDTH);
        assert_eq!(clamp_content_width(f64::NAN), DEFAULT_CONTENT_WIDTH);
    }

    #[test]
    fn 外观全量写入不会留下旧值的残影() {
        // ⭐ INV-THEME-05：「写的是取当前 applied 全量」，⛔ 不是增量打补丁。
        //    这条测的是"改一次主题会不会把字号带着一起写对"。
        // ⭐ `design/0014`：`vim_mode` 走同一条记录 ⇒ 同一条纪律也管它
        //    （⚠️ 对用户的表现：写全量时漏带 Vim ⇒ 切一次主题就把 Vim 关了）。
        let mut c = Config::default();
        c.set_appearance(&Appearance {
            mode: "dark".into(),
            font_size: 20.0,
            vim_mode: true,
            ..Default::default()
        });
        c.set_appearance(&Appearance { mode: "warm".into(), ..Default::default() });
        let a = c.appearance();
        assert_eq!(a.mode, "warm");
        assert_eq!(a.font_size, DEFAULT_FONT_SIZE, "第二次写的是全量，字号该回到默认");
        assert!(!a.vim_mode, "第二次写的是全量，Vim 该回到默认的关闭");
    }

    // ─────────────────────────────────────────────────────────────────
    // ⭐ 阅读进度（`design/0017` §7.1 的 16 条）
    // ─────────────────────────────────────────────────────────────────

    /// 造一条**可用**的进度（改哪一项就在调用处覆盖）。
    fn prog(id: Option<&str>, ratio: Option<f64>) -> ReadingProgress {
        ReadingProgress { id: id.map(str::to_string), ratio, ..Default::default() }
    }

    #[test]
    fn 进度_存取往返五个字段逐个相等() {
        let path = tmp("progress-roundtrip");
        let mut c = Config::default();
        let out = c.set_reading_progress_at(
            "/a/b.md",
            ReadingProgress {
                id: Some("h-12".into()),
                offset: 34.5,
                ratio: Some(0.25),
                source_bytes: 12345,
                updated_at: 999,
            },
            1_700_000_000,
        );
        assert!(out.entry.is_some());
        c.save(&path).unwrap();
        let back = Config::load(&path);
        let e = back.reading_progress_of("/a/b.md").unwrap();
        assert_eq!(e.id.as_deref(), Some("h-12"));
        assert_eq!(e.offset, 34.5);
        assert_eq!(e.ratio, Some(0.25));
        assert_eq!(e.source_bytes, 12345);
        assert_eq!(e.updated_at, 1_700_000_000, "⚠️ 时间戳该是后端盖的那个数");
    }

    #[test]
    fn 进度_缺字段的条目取默认值() {
        let path = tmp("progress-partial");
        std::fs::write(&path, r#"{"reading_progress":{"/x.md":{"id":"h1"}}}"#).unwrap();
        let c = Config::load(&path);
        let e = c.reading_progress_of("/x.md").unwrap();
        assert_eq!(e.id.as_deref(), Some("h1"));
        assert_eq!(e.offset, 0.0);
        assert_eq!(e.ratio, None);
        assert_eq!(e.source_bytes, 0);
        assert_eq!(e.updated_at, 0);
    }

    #[test]
    fn 进度_清洗_ratio_非有限与越界() {
        let none = prog(None, Some(f64::NAN)).sanitized();
        assert!(none.is_none(), "NaN 的 ratio 是「没有 ratio」，且没有 id ⇒ 整条不写");
        let none = prog(None, Some(f64::INFINITY)).sanitized();
        assert!(none.is_none());
        let hi = prog(None, Some(1.5)).sanitized().unwrap();
        assert_eq!(hi.ratio, Some(1.0));
        let lo = prog(None, Some(-0.2)).sanitized().unwrap();
        assert_eq!(lo.ratio, Some(0.0));
        // ⚠️ 有 id 时 ratio 无效只是把它变成 None，条目仍在。
        let keep = prog(Some("h1"), Some(f64::NAN)).sanitized().unwrap();
        assert_eq!(keep.id.as_deref(), Some("h1"));
        assert_eq!(keep.ratio, None);
    }

    #[test]
    fn 进度_清洗_offset与id() {
        let e = ReadingProgress { offset: f64::NAN, ..prog(Some("h1"), None) }.sanitized().unwrap();
        assert_eq!(e.offset, 0.0);
        let e = ReadingProgress { offset: -3.0, ..prog(Some("h1"), None) }.sanitized().unwrap();
        assert_eq!(e.offset, 0.0);
        // 空 id ⇒ None（但 ratio 还在，所以条目留下）
        let e = prog(Some(""), Some(0.5)).sanitized().unwrap();
        assert_eq!(e.id, None);
        assert_eq!(e.ratio, Some(0.5));
        // ⭐ 300 字符 ⇒ **整个丢弃**（⛔ 不截成前缀——前缀可能撞上另一个标题）
        let long = "x".repeat(300);
        let e = prog(Some(&long), Some(0.5)).sanitized().unwrap();
        assert_eq!(e.id, None, "超长 id 必须整条丢弃");
        assert_eq!(e.ratio, Some(0.5), "ratio 不受 id 影响");
    }

    #[test]
    fn 进度_无id且无ratio时返回None且旧条目原样保留() {
        let mut c = Config::default();
        c.set_reading_progress_at("/a.md", prog(Some("h1"), Some(0.5)), 100);
        let before = c.reading_progress_of("/a.md").cloned();
        let out = c.set_reading_progress_at("/a.md", prog(None, None), 200);
        assert!(out.entry.is_none());
        assert!(out.evicted.is_empty(), "一次空写入不该淘汰别人");
        assert_eq!(c.reading_progress_of("/a.md").cloned(), before, "旧条目一个字都不许动");
    }

    #[test]
    fn 进度_第201条按最旧淘汰() {
        let mut c = Config::default();
        for i in 0..MAX_PROGRESS_ENTRIES {
            let p = format!("/p{i:03}.md");
            c.set_reading_progress_at(&p, prog(Some("h"), None), 1_000 + i as u64);
        }
        assert_eq!(c.reading_progress.len(), MAX_PROGRESS_ENTRIES);
        let out = c.set_reading_progress_at("/new.md", prog(Some("h"), None), 9_999);
        assert_eq!(c.reading_progress.len(), MAX_PROGRESS_ENTRIES, "总数仍 200");
        assert_eq!(out.evicted, vec!["/p000.md".to_string()], "最旧的先走，且名单要回给前端");
        assert!(c.reading_progress_of("/p000.md").is_none());
        assert!(c.reading_progress_of("/new.md").is_some());
    }

    #[test]
    fn 进度_同一时间戳时按路径字典序确定性淘汰() {
        let mut c = Config::default();
        // 先写满（全部同戳）
        for i in 0..MAX_PROGRESS_ENTRIES {
            let p = format!("/p{i:03}.md");
            c.set_reading_progress_at(&p, prog(Some("h"), None), 5_000);
        }
        // 再写一条同戳的、字典序最小的
        let out = c.set_reading_progress_at("/a.md", prog(Some("h"), None), 5_000);
        assert_eq!(out.evicted, vec!["/a.md".to_string()], "新写的 /a.md 本身就是字典序最小的");
        assert!(c.reading_progress_of("/p000.md").is_some(), "同戳的按路径排，/p000 排在 /a 后面");
    }

    #[test]
    fn 进度_更新已有键不会增长() {
        let mut c = Config::default();
        for i in 0..MAX_PROGRESS_ENTRIES {
            c.set_reading_progress_at(&format!("/p{i:03}.md"), prog(Some("h"), None), 1_000);
        }
        let out = c.set_reading_progress_at("/p000.md", prog(Some("h2"), None), 2_000);
        assert_eq!(c.reading_progress.len(), MAX_PROGRESS_ENTRIES);
        assert!(out.evicted.is_empty());
        assert_eq!(c.reading_progress_of("/p000.md").unwrap().id.as_deref(), Some("h2"));
    }

    #[test]
    fn 进度_空表不写reading_progress键() {
        let path = tmp("progress-empty");
        Config::default().save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("reading_progress"), "空表不该在配置里留一个空对象：{text}");
    }

    #[test]
    fn 进度_旧json没有这个键时map为空且其余字段不受影响() {
        let path = tmp("progress-old");
        std::fs::write(
            &path,
            r#"{"sidebar_width":300.0,"theme":"dark","reader_font_size":18.0}"#,
        )
        .unwrap();
        let c = Config::load(&path);
        assert!(c.reading_progress.is_empty());
        assert_eq!(c.sidebar_width, Some(300.0));
        assert_eq!(c.appearance().mode, "dark");
        assert_eq!(c.appearance().font_size, 18.0);
    }

    #[test]
    fn 进度_前向兼容_不认识的实现把它留在extra里() {
        // ⭐ 模拟"更旧的版本"：它不认识 `reading_progress`，只有 flatten 的 extra。
        #[derive(Serialize, Deserialize)]
        struct OldConfig {
            #[serde(flatten)]
            extra: BTreeMap<String, serde_json::Value>,
        }
        let mut c = Config::default();
        c.set_reading_progress_at("/a.md", prog(Some("h1"), Some(0.5)), 100);
        let text = serde_json::to_string(&c).unwrap();
        let old: OldConfig = serde_json::from_str(&text).unwrap();
        assert!(old.extra.contains_key("reading_progress"), "旧实现必须把它当未知键留下");
        let back = serde_json::to_string(&old).unwrap();
        assert!(back.contains("reading_progress"), "写回去也不许抹掉");
    }

    #[test]
    fn 进度_逐条容错_坏条目只跳过自己() {
        let path = tmp("progress-tolerant");
        std::fs::write(
            &path,
            r#"{
                "sidebar_width": 320.0,
                "theme": "warm",
                "reading_progress": {
                    "/bad.md": {"id": 42},
                    "/good.md": {"id": "h1", "ratio": 0.5}
                }
            }"#,
        )
        .unwrap();
        let c = Config::load(&path);
        assert!(c.reading_progress_of("/bad.md").is_none(), "类型坏的那条被跳过");
        assert!(c.reading_progress_of("/good.md").is_some(), "好的那条照收");
        // ⭐ 关键：一条坏进度**不许**把外观/侧栏宽一起拖回默认
        assert_eq!(c.sidebar_width, Some(320.0));
        assert_eq!(c.appearance().mode, "warm");
    }

    #[test]
    fn 进度_加载时裁到200() {
        let path = tmp("progress-trim-on-load");
        let mut entries = serde_json::Map::new();
        for i in 0..(MAX_PROGRESS_ENTRIES + 1) {
            entries.insert(
                format!("/p{i:03}.md"),
                serde_json::json!({"id": "h", "updated_at": i}),
            );
        }
        let text = serde_json::json!({"reading_progress": entries}).to_string();
        std::fs::write(&path, text).unwrap();
        let c = Config::load(&path);
        assert_eq!(c.reading_progress.len(), MAX_PROGRESS_ENTRIES);
        assert!(c.reading_progress_of("/p000.md").is_none(), "updated_at 最小的那条被裁掉");
        assert!(c.reading_progress_of("/p200.md").is_some());
    }

    #[test]
    fn 进度_返回清洗后的条目与淘汰名单() {
        let mut c = Config::default();
        for i in 0..MAX_PROGRESS_ENTRIES {
            c.set_reading_progress_at(&format!("/p{i:03}.md"), prog(Some("h"), None), 1_000);
        }
        let out = c.set_reading_progress_at(
            "/new.md",
            ReadingProgress {
                id: Some("h1".into()),
                offset: f64::NAN,     // 会被清成 0
                ratio: Some(3.0),     // 会被夹成 1
                source_bytes: 7,
                updated_at: 1,        // 会被 now 覆盖
            },
            4_242,
        );
        let e = out.entry.expect("清洗后仍有可用信息");
        assert_eq!(e.offset, 0.0);
        assert_eq!(e.ratio, Some(1.0));
        assert_eq!(e.updated_at, 4_242, "⭐ 后端盖章，前端传的 1 不算数");
        assert_eq!(out.evicted, vec!["/p000.md".to_string()]);
    }

    // ─────────────────────────────────────────────────────────────────────
    // ⭐ 目录会话（`design/0020` §7.1）
    // ─────────────────────────────────────────────────────────────────────

    fn sess(last_file: Option<&str>, expanded: &[&str]) -> DirSession {
        DirSession {
            last_file: last_file.map(str::to_string),
            expanded: expanded.iter().map(|s| s.to_string()).collect(),
            updated_at: 0,
        }
    }

    #[test]
    fn 目录会话_sanitized_越界项与根自身被丢() {
        // 判据 1：`last_file` 越界 → None；`expanded` 越界项被丢弃
        let s = sess(Some("/other/a.md"), &["/r/a", "/other/b", "/r"]);
        let out = s.sanitized("/r");
        assert_eq!(out.last_file, None);
        assert_eq!(out.expanded, vec!["/r/a".to_string()], "越界项与根自身都丢掉");
    }

    #[test]
    fn 目录会话_sanitized_前缀陷阱不算在根之下() {
        // ⚠️ `/rfoo` 不是 `/r` 之下（`INV-FS-01` 的字符串前缀陷阱）
        let out = sess(Some("/rfoo/a.md"), &["/rfoo/d"]).sanitized("/r");
        assert!(out.is_empty());
    }

    #[test]
    fn 目录会话_sanitized_去重且深度升序同深度按字节序() {
        // 判据 2
        let s = sess(None, &["/r/b/c", "/r/z", "/r/a", "/r/b", "/r/b/c"]);
        assert_eq!(
            s.sanitized("/r").expanded,
            vec![
                "/r/a".to_string(),
                "/r/b".to_string(),
                "/r/z".to_string(),
                "/r/b/c".to_string()
            ]
        );
    }

    #[test]
    fn 目录会话_sanitized_超200保浅的200条() {
        // 判据 3：浅的那层是深的的前提 ⇒ 先保浅的
        let mut expanded: Vec<String> = (0..100).map(|i| format!("/r/a{i:03}")).collect();
        expanded.extend((0..200).map(|i| format!("/r/a{i:03}/b")));
        let s = DirSession {
            last_file: None,
            expanded: expanded.iter().map(|s| s.clone()).collect(),
            updated_at: 0,
        };
        let out = s.sanitized("/r");
        assert_eq!(out.expanded.len(), MAX_EXPANDED_PER_DIR);
        for i in 0..100 {
            assert!(
                out.expanded.contains(&format!("/r/a{i:03}")),
                "浅的第 {i} 条必须留下"
            );
        }
        assert!(
            out.expanded.contains(&"/r/a000/b".to_string()),
            "同深度里字节序靠前的留下来"
        );
        assert!(
            !out.expanded.contains(&"/r/a199/b".to_string()),
            "同深度里字节序靠后的被裁掉"
        );
    }

    #[test]
    fn 目录会话_全空输入返回空会话而不是None() {
        // 判据 4（R4 的核心）：空会话是**合法值**，`sanitized` 总是返回一条
        let out = sess(None, &[]).sanitized("/r");
        assert!(out.is_empty());
        assert_eq!(out, sess(None, &[]));
    }

    #[test]
    fn 目录会话_单条路径超4096字符被丢() {
        // 判据 5：⛔ 不截断，整个丢掉
        let ok = format!("/r/{}", "x".repeat(MAX_SESSION_PATH_CHARS - 3));
        let too_long = format!("/r/{}", "x".repeat(MAX_SESSION_PATH_CHARS - 2));
        assert_eq!(ok.chars().count(), MAX_SESSION_PATH_CHARS);
        assert_eq!(too_long.chars().count(), MAX_SESSION_PATH_CHARS + 1);

        let s = sess(Some(too_long.as_str()), &[ok.as_str(), too_long.as_str()]);
        let out = s.sanitized("/r");
        assert_eq!(out.last_file, None, "超长的 last_file 整个丢掉");
        assert_eq!(out.expanded, vec![ok], "超长的展开项丢掉，恰好 4096 的留下");
    }

    #[test]
    fn 目录会话_后端盖章忽略前端时间戳() {
        // 判据 6
        let mut c = Config::default();
        let mut s = sess(Some("/r/a.md"), &[]);
        s.updated_at = 999_999_999; // 前端塞的"十年后"
        let out = c.set_dir_session_at("/r", s, 4_242);
        assert_eq!(out.entry.updated_at, 4_242, "⭐ 后端盖章，前端传的不算数");
        assert_eq!(c.dir_session("/r").unwrap().updated_at, 4_242);
    }

    #[test]
    fn 目录会话_第51个按最旧淘汰() {
        // 判据 7
        let mut c = Config::default();
        for i in 0..MAX_DIR_SESSIONS {
            let root = format!("/r{i:02}");
            let last = format!("{root}/a.md");
            c.set_dir_session_at(&root, sess(Some(last.as_str()), &[]), 1_000 + i as u64);
        }
        assert_eq!(c.dir_sessions.len(), MAX_DIR_SESSIONS);

        let out = c.set_dir_session_at("/new", sess(Some("/new/a.md"), &[]), 9_999);
        assert_eq!(c.dir_sessions.len(), MAX_DIR_SESSIONS, "总数仍 MAX_DIR_SESSIONS");
        assert_eq!(out.evicted, vec!["/r00".to_string()], "(updated_at, 路径) 最小的先走");
        assert!(c.dir_session("/r00").is_none());
        assert!(c.dir_session("/new").is_some());
    }

    #[test]
    fn 目录会话_加载时坏条目只跳自己() {
        // 判据 8：一条坏会话**不许**把外观 / 侧栏宽一起拖回默认
        let path = tmp("dirsession-tolerant");
        std::fs::write(
            &path,
            r#"{
                "sidebar_width": 320.0,
                "theme": "warm",
                "dir_sessions": {
                    "/bad": "这不是一条会话",
                    "/good": {"last_file": "/good/a.md", "expanded": ["/good/d"]}
                }
            }"#,
        )
        .unwrap();
        let c = Config::load(&path);
        assert!(c.dir_session("/bad").is_none(), "类型坏的那条被跳过");
        let good = c.dir_session("/good").expect("好的那条照收");
        assert_eq!(good.last_file.as_deref(), Some("/good/a.md"));
        assert_eq!(c.sidebar_width, Some(320.0));
        assert_eq!(c.appearance().mode, "warm");
    }

    #[test]
    fn 目录会话_加载时按上限裁剪() {
        // 判据 9：每条 300 条展开 → 200；目录 `MAX_DIR_SESSIONS + 10` 个 → `MAX_DIR_SESSIONS`
        // ⚠️ 条数与那个"最新的"目录**都由常量现算**，⛔ 不写死 `/d59`
        //    （2026-10-21 把 `MAX_DIR_SESSIONS` 由 50 降到 20 时，写死的那份当场就红了）
        let path = tmp("dirsession-trim-on-load");
        let n = MAX_DIR_SESSIONS + 10;
        let mut dirs = serde_json::Map::new();
        for i in 0..n {
            let root = format!("/d{i:02}");
            let expanded: Vec<String> =
                (0..(MAX_EXPANDED_PER_DIR + 100)).map(|j| format!("{root}/e{j:03}")).collect();
            dirs.insert(
                root,
                serde_json::json!({"last_file": null, "expanded": expanded, "updated_at": i}),
            );
        }
        let text = serde_json::json!({"dir_sessions": dirs}).to_string();
        std::fs::write(&path, text).unwrap();
        let c = Config::load(&path);
        assert_eq!(c.dir_sessions.len(), MAX_DIR_SESSIONS);
        assert!(c.dir_session("/d00").is_none(), "updated_at 最小的目录被裁掉");
        let newest = format!("/d{:02}", n - 1);
        let last = c.dir_session(&newest).expect("最新的那条在");
        assert_eq!(last.expanded.len(), MAX_EXPANDED_PER_DIR, "单目录展开裁到 200");
        assert!(last.expanded.contains(&format!("{newest}/e000")));
        assert!(!last.expanded.contains(&format!("{newest}/e299")));
    }

    #[test]
    fn 目录会话_加载时last_file越界置None而expanded保留() {
        // 判据 10
        let path = tmp("dirsession-load-outside");
        std::fs::write(
            &path,
            r#"{"dir_sessions":{"/r":{"last_file":"/out/a.md","expanded":["/r/a"]}}}"#,
        )
        .unwrap();
        let c = Config::load(&path);
        let s = c.dir_session("/r").expect("条目还在");
        assert_eq!(s.last_file, None, "越界的 last_file 置 None");
        assert_eq!(s.expanded, vec!["/r/a".to_string()], "展开项不受牵连");
    }

    #[test]
    fn 目录会话_空表不写dir_sessions键() {
        // 判据 11
        let path = tmp("dirsession-empty-save");
        Config::default().save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("dir_sessions"), "空表不该在配置里留一个空对象：{text}");
    }

    #[test]
    fn 目录会话_空载荷写入删除该键且文件里没有该键() {
        // 判据 13（R4 往返）：先写一条 → 再发空载荷 ⇒ 条目被删除、文件里没有这个键
        let path = tmp("dirsession-cleared-save");
        let mut c = Config::default();
        c.set_dir_session_at("/r", sess(Some("/r/a.md"), &["/r/d"]), 100);
        assert!(c.dir_session("/r").is_some());

        let out = c.set_dir_session_at("/r", sess(None, &[]), 200);
        assert!(out.entry.is_empty(), "回带的是空会话（落点 = cleared）");
        assert!(c.dir_session("/r").is_none(), "清空后该条被删掉");
        c.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("dir_sessions"), "整张表空了就不写这个键：{text}");
    }

    #[test]
    fn 目录会话_删除只影响一个目录() {
        // 判据 14
        let mut c = Config::default();
        c.set_dir_session_at("/a", sess(Some("/a/x.md"), &[]), 100);
        c.set_dir_session_at("/b", sess(Some("/b/y.md"), &[]), 100);
        assert!(c.remove_dir_session("/a"));
        assert!(c.dir_session("/a").is_none());
        assert_eq!(
            c.dir_session("/b").and_then(|s| s.last_file.clone()).as_deref(),
            Some("/b/y.md"),
            "另一个目录一个字都不许动"
        );
        assert!(!c.remove_dir_session("/a"), "再删一次是 no-op（幂等）");
    }

    // ────────────────────────────────────────────────────────────────
    // ⭐ 界面语言偏好（`design/0025` §2.4 ／ §7.2 那一行）
    // ────────────────────────────────────────────────────────────────

    #[test]
    fn 语言_没写过时是跟随系统() {
        let c = Config::default();
        assert_eq!(c.language, None, "出厂不写这个键");
        assert_eq!(c.language_preference(), "system", "没写过 ⇒ 跟随系统");
    }

    #[test]
    fn 语言_往返_zh与en能存住() {
        let path = tmp("lang-roundtrip");
        let mut c = Config::default();
        c.set_language_preference("en");
        assert_eq!(c.language.as_deref(), Some("en"));
        c.save(&path).unwrap();
        let back = Config::load(&path);
        assert_eq!(back.language_preference(), "en", "存过盘、读回来还是 en");
        c.set_language_preference("zh");
        c.save(&path).unwrap();
        assert_eq!(Config::load(&path).language_preference(), "zh");
    }

    #[test]
    fn 语言_归一_认不出来的词一律跟随系统() {
        // ⚠️ 这四条覆盖的是**手改配置**那条路：`config.json` 是明文，
        //    拼成 `"fr"` / `"中文"` / 空串都是**预期内的输入**（模块头第 3 条）。
        for (输入, 期望) in [
            (None, "system"),
            (Some(""), "system"),
            (Some("   "), "system"),
            (Some("fr"), "system"),
            (Some("中文"), "system"),
            (Some("system"), "system"),
            (Some("zh"), "zh"),
            (Some("en"), "en"),
            // ⚠️ 大小写与空白是**宽容**的：`" EN "` 与 `"en"` 逐字等价。
            (Some(" EN "), "en"),
            (Some("Zh"), "zh"),
        ] {
            assert_eq!(normalize_language(输入), 期望, "normalize_language({输入:?})");
        }
        // 归一化后的值**必须落在 LANGS 里**——否则 `set_language_preference` 写出去的东西
        // 前端那个 `<select>` 里没有对应选项（表现是设置里"语言"那一格空着）。
        for 输入 in [None, Some(""), Some("fr"), Some("zh"), Some("en"), Some("system")] {
            assert!(LANGS.contains(&normalize_language(输入)), "{输入:?} 归一后不在 LANGS 里");
        }
    }

    #[test]
    fn 语言_加载时归一_坏值不落盘也不变成第三种状态() {
        let path = tmp("lang-load-normalize");
        std::fs::write(&path, r#"{"language":"fr"}"#).unwrap();
        let c = Config::load(&path);
        assert_eq!(c.language, None, "认不出来的词归一成 None（= 跟随系统、且不写盘）");
        assert_eq!(c.language_preference(), "system");

        // ⚠️ 空白串同理：⛔ 别把它落成一个"应用名是空格"那种形态。
        std::fs::write(&path, r#"{"language":"   "}"#).unwrap();
        assert_eq!(Config::load(&path).language, None);

        // 正常值照旧保留。
        std::fs::write(&path, r#"{"language":"en"}"#).unwrap();
        assert_eq!(Config::load(&path).language_preference(), "en");
    }

    #[test]
    fn 语言_切回跟随系统时文件里不留这个键() {
        // ⚠️ 这条钉的是 `skip_serializing_if` 与 `set_language_preference` 的**配合**：
        //    归一成 `"system"` 就存 `None` ⇒ 只切了一次语言又切回来的用户，
        //    文件**逐字节回到原样**（与 `reading_progress` 空表不写盘同一口径）。
        let path = tmp("lang-back-to-system");
        let mut c = Config::default();
        c.set_language_preference("en");
        c.save(&path).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("language"));

        c.set_language_preference("system");
        assert_eq!(c.language, None);
        c.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("language"), "切回跟随系统后不该留这个键：{text}");
    }

    // ─────────────────────────────────────────────────────────────────────
    // ⭐ `design/0040`：可配置的目录过滤清单
    // ─────────────────────────────────────────────────────────────────────

    /// 缺键 ⇒ 出厂四项（老用户的 `config.json` 逐字节不变的语义基础）。
    #[test]
    fn ignore_dirs_default_when_absent() {
        let path = tmp("ignore-absent");
        std::fs::write(&path, "{}").unwrap();
        let c = Config::load(&path);
        assert_eq!(c.ignore_dirs, crate::fs::tree::default_ignore_dirs());
        assert_eq!(c.ignore_dirs.len(), 4);
    }

    /// ⚠️ `[]` 是**合法值**：与"没写这个键"不是一回事（`INV-FILTER-02` 的反面）。
    #[test]
    fn ignore_dirs_empty_array_is_legal() {
        let path = tmp("ignore-empty");
        std::fs::write(&path, r#"{"ignore_dirs":[]}"#).unwrap();
        let c = Config::load(&path);
        assert!(c.ignore_dirs.is_empty(), "空数组必须原样保留：{:?}", c.ignore_dirs);
    }

    /// ⭐ `INV-FILTER-06`：坏形状**只回本键**，其它配置项一个都不能丢。
    #[test]
    fn ignore_dirs_bad_shape_does_not_wipe_config() {
        let path = tmp("ignore-bad-shape");
        std::fs::write(
            &path,
            r#"{"ignore_dirs":"node_modules","theme":"dark","language":"en","last_directory":"/tmp/x"}"#,
        )
        .unwrap();
        let c = Config::load(&path);
        assert_eq!(c.ignore_dirs, crate::fs::tree::default_ignore_dirs());
        assert_eq!(c.theme.as_deref(), Some("dark"), "坏键⛔ 不许连累外观");
        assert_eq!(c.language.as_deref(), Some("en"), "坏键⛔ 不许连累语言");
        assert_eq!(c.last_directory.as_deref(), Some("/tmp/x"));
    }

    /// 混了非字符串的数组同样按"不是字符串数组"处理。
    #[test]
    fn ignore_dirs_mixed_array_falls_back() {
        let path = tmp("ignore-mixed");
        std::fs::write(&path, r#"{"ignore_dirs":["vendor",42]}"#).unwrap();
        assert_eq!(Config::load(&path).ignore_dirs, crate::fs::tree::default_ignore_dirs());
    }

    /// 归一化：去空白 / 去重 / 丢路径分隔符 / 丢点开头 / 丢超长 / 截到上限。
    #[test]
    fn normalize_ignore_dirs_drops_bad_entries() {
        let raw = vec![
            "  vendor  ".to_string(),
            "vendor".to_string(),          // 重复
            "".to_string(),                // 空
            "   ".to_string(),             // 全空白
            "a/b".to_string(),             // 路径分隔符
            "a\\b".to_string(),            // 路径分隔符
            ".git".to_string(),            // 点开头（① 类优先，永远走不到）
            "..".to_string(),              // 同上
            "x".repeat(MAX_IGNORE_DIR_NAME_BYTES + 1), // 超长
            "build".to_string(),
        ];
        assert_eq!(normalize_ignore_dirs(raw), vec!["vendor".to_string(), "build".to_string()]);
    }

    /// 条数上限：超过就截断（保序）。
    #[test]
    fn normalize_ignore_dirs_caps_count() {
        let raw: Vec<String> = (0..MAX_IGNORE_DIRS + 10).map(|i| format!("d{i}")).collect();
        let out = normalize_ignore_dirs(raw);
        assert_eq!(out.len(), MAX_IGNORE_DIRS);
        assert_eq!(out[0], "d0");
    }

    /// 往返：显式空清单写盘后仍是空；出厂值**不写进文件**（老配置不因升级多出一个键）。
    #[test]
    fn ignore_dirs_round_trip() {
        let path = tmp("ignore-round-trip");

        let mut c = Config::default();
        let _ = c.save(&path);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("ignore_dirs"), "出厂值⛔ 不该写进文件：{text}");

        c.ignore_dirs = Vec::new();
        c.save(&path).unwrap();
        assert_eq!(Config::load(&path).ignore_dirs, Vec::<String>::new());

        c.ignore_dirs = vec!["vendor".to_string()];
        c.save(&path).unwrap();
        assert_eq!(Config::load(&path).ignore_dirs, vec!["vendor".to_string()]);
    }

    // ── `design/0041`：侧边栏形态与空目录开关 ──────────────────────────

    /// 出厂：树、隐藏空目录；**两个键都不写进文件**（升级不改老配置的字节）。
    #[test]
    fn 形态与空目录开关的出厂值不写盘() {
        let path = tmp("view-defaults");
        let c = Config::default();
        assert_eq!(c.sidebar_file_view(), "tree");
        assert!(c.hide_empty_dirs(), "缺键 = 隐藏（0041 的行为）");

        c.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("sidebar_file_view"), "出厂值⛔ 不该写进文件：{text}");
        assert!(!text.contains("hide_empty_dirs"), "出厂值⛔ 不该写进文件：{text}");
    }

    /// 往返：`list` / 显式 `false` 写盘后读回来还是它。
    #[test]
    fn 形态与空目录开关_round_trip() {
        let path = tmp("view-round-trip");
        let mut c = Config::default();
        c.set_sidebar_file_view("list");
        c.hide_empty_dirs = Some(false);
        c.save(&path).unwrap();

        let loaded = Config::load(&path);
        assert_eq!(loaded.sidebar_file_view(), "list");
        assert!(!loaded.hide_empty_dirs());
    }

    /// ⚠️ 拼错的形态 / 类型不对的布尔：**只回落本键**，⛔ 不连累其它字段。
    #[test]
    fn 形态坏值归树且不清掉其它偏好() {
        let path = tmp("view-bad");
        std::fs::write(
            &path,
            r#"{"sidebar_file_view":"grid","hide_empty_dirs":"false","sidebar_width":321,"theme":"dark"}"#,
        )
        .unwrap();
        // `hide_empty_dirs` 类型不对会让**整份** JSON 反序列化失败 ⇒ 走 `load` 的默认值分支。
        // ⚠️ 这不是本键的"逐条容错"（那只有 reading_progress/dir_sessions 有），
        //    而是 `load` 那条"坏 JSON 不 panic、用默认值"的总闸。这里钉的是**不 panic**。
        let c = Config::load(&path);
        assert_eq!(c.sidebar_file_view(), "tree", "未知值归树");
        assert!(c.hide_empty_dirs());
        assert!(c.sidebar_width.is_none(), "整份回落（既有口径：坏 JSON ⇒ 默认值）");

        // 字符串形态的布尔**单独**出现时同样不 panic
        std::fs::write(&path, r#"{"sidebar_file_view":"list"}"#).unwrap();
        let c = Config::load(&path);
        assert_eq!(c.sidebar_file_view(), "list");
        assert!(c.hide_empty_dirs(), "缺键 = 出厂");
    }

    // ── `design/0047`：阅读—编辑连续性开关 ──────────────────────────────

    /// 出厂是**关**；缺键 ⇒ `false`；且出厂值⛔ 不写进文件（升级不改老配置的字节）。
    #[test]
    fn 就地编辑开关出厂关且不写盘() {
        let path = tmp("live-edit-default");
        let c = Config::default();
        assert!(!c.live_edit(), "0047 §8：出厂关（覆盖层是全新输入路径，默认开只能在真机上定）");
        assert!(c.live_edit.is_none(), "缺键与 `false` 在语义上等价，⛔ 别在这里写成 Some(false)");

        c.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("live_edit"), "出厂值⛔ 不该写进文件：{text}");
    }

    /// 显式 `true` 能往返；⚠️ 只有 `true` 才留下这个键。
    #[test]
    fn 就地编辑开关_round_trip() {
        let path = tmp("live-edit-round-trip");
        let mut c = Config::default();
        c.live_edit = Some(true);
        c.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        // ⚠️ 别按 `"live_edit":true` 匹配：`save` 是 **pretty-print** 的（`": true"` 带空格）。
        assert!(text.contains("\"live_edit\""), "显式 true 应当写盘：{text}");
        assert!(Config::load(&path).live_edit());

        // ⚠️ `false` 归回"没有这个键"：与出厂值等价，⛔ 不为它留一行。
        let mut c = Config::default();
        c.live_edit = Some(false);
        c.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("live_edit"), "false 是出厂值，⛔ 不该留下键：{text}");
        assert!(!Config::load(&path).live_edit());
    }

    /// 只有 `list` 会写盘；`tree` / 未知值都归到"没有这个键"。
    #[test]
    fn 只有_list_会留下键() {
        let path = tmp("view-normalize");
        let mut c = Config::default();
        for v in ["list", "tree", "grid", "", "LIST"] {
            c.set_sidebar_file_view(v);
            c.save(&path).unwrap();
            let text = std::fs::read_to_string(&path).unwrap();
            let has_key = text.contains("sidebar_file_view");
            assert_eq!(has_key, v == "list", "输入 {v:?} ⇒ 键存在 = {has_key}");
            assert_eq!(Config::load(&path).sidebar_file_view(), if v == "list" { "list" } else { "tree" });
        }
    }

    // ─────────────────────────────────────────────────────────────
    // ⭐ `design/0043`：favorites 的解码与序列化口径
    // ─────────────────────────────────────────────────────────────

    #[test]
    fn 收藏_缺键为空且不写盘() {
        let path = tmp("fav-absent");
        std::fs::write(&path, "{}").unwrap();
        let c = Config::load(&path);
        assert!(c.favorites.is_empty());

        let mut c = Config::default();
        c.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("favorites"), "空表⛔ 不该写进文件：{text}");
    }

    /// ⭐ 逐字保留（⛔ 不 trim / 不规范化 / 不去重）：打开时要靠**原串**命中记录。
    #[test]
    fn 收藏_解码逐字保留() {
        let path = tmp("fav-verbatim");
        std::fs::write(
            &path,
            r#"{"favorites":["/a/../b.md"," /sp ace.md","/a/../b.md",""]}"#,
        )
        .unwrap();
        let c = Config::load(&path);
        assert_eq!(
            c.favorites,
            vec![
                "/a/../b.md".to_string(),
                " /sp ace.md".to_string(),
                "/a/../b.md".to_string(),
                String::new()
            ],
            "解码⛔ 不改写、⛔ 不去重——记录侧被改写会让原串核对永远失败"
        );
    }

    /// ⭐ 坏形状只回本键（`INV-FILTER-06` 同族）。
    #[test]
    fn 收藏_坏形状不清空其它配置() {
        let path = tmp("fav-bad-shape");
        std::fs::write(
            &path,
            r#"{"favorites":"/a.md","theme":"dark","language":"en","last_directory":"/tmp/x"}"#,
        )
        .unwrap();
        let c = Config::load(&path);
        assert!(c.favorites.is_empty(), "非数组 ⇒ 收藏为空");
        assert_eq!(c.theme.as_deref(), Some("dark"), "坏键⛔ 不许连累外观");
        assert_eq!(c.language.as_deref(), Some("en"));
        assert_eq!(c.last_directory.as_deref(), Some("/tmp/x"));

        // 混了非字符串同样回空
        std::fs::write(&path, r#"{"favorites":["/a.md",42]}"#).unwrap();
        assert!(Config::load(&path).favorites.is_empty());
    }

    /// 手写超长数组按 `FAVORITES_LIMIT` 截断（体积预算），并保序。
    #[test]
    fn 收藏_解码截到上限() {
        let path = tmp("fav-cap");
        let items: Vec<String> = (0..FAVORITES_LIMIT + 7).map(|i| format!("/f{i}.md")).collect();
        let text = serde_json::json!({ "favorites": items }).to_string();
        std::fs::write(&path, text).unwrap();
        let c = Config::load(&path);
        assert_eq!(c.favorites.len(), FAVORITES_LIMIT);
        assert_eq!(c.favorites[0], "/f0.md");
    }

    /// 非空收藏要真的往返（写盘 → 读回逐字相同）。
    #[test]
    fn 收藏_往返() {
        let path = tmp("fav-round-trip");
        let mut c = Config::default();
        c.favorites = vec!["/a.md".to_string(), "/b".to_string()];
        c.save(&path).unwrap();
        assert_eq!(Config::load(&path).favorites, vec!["/a.md".to_string(), "/b".to_string()]);
    }
}
