//! GUI 入口（Tauri 2）。批 1 起窗口，**`design/0003`（已通过）起有侧边栏**。
//!
//! # 这个模块的边界
//!
//! 1. ⚠️ **批 1 的那条结构性保证已被 `design/0003` 取代**。
//!    原来是「前端永不传路径」——读盘入口只有启动 argv，`open_document` 不接参数。
//!    现在树里点一份文件**必须**能传路径，所以那条保证换成了
//!    **授权模型**：每条读取命令都要过 `SessionGrants::check_readable`，
//!    而命令层（`crate::commands`）是唯一能到达文件系统的地方。
//!    ⛔ **没有任何一条读盘路径绕过它**（`INV-FS-01`）。
//! 2. ⛔ **解析只有一份实现**（`INV-SINGLE-01`）：本模块不写任何解析/渲染，
//!    只把窗口、状态与命令装配起来。文档的读取与渲染全在
//!    `crate::commands::document`，而它只调 `crate::document::*`。
//! 3. ⛔ **不预设分块渲染、不预设虚拟列表**——那是批 2/批 3 要用数字回答的问题
//!    （`adr/0004`）。侧边栏的**分片追加**是 `design/0003` §2.1 明确要的
//!    （单层超 500 项时按帧分摊），与正文的分块渲染**不是同一件事**。
//!
//! # 时间轴（`design/0002` §7.3.2）
//!
//! CLI 侧报 T1/T2/T3；**T4 起全是前端的**，且必须单独列。
//! `open_document` 把 T1/T2/T3 作为**返回值**带给前端，前端只做减法求残差
//! `R = T4 − (T1+T2+T3)`。⚠️ `Instant` 与 `performance.now()` 的**纪元不同**，
//! ⛔ 绝不可混进同一个变量。

use std::ffi::OsString;
use std::io::IsTerminal;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu};
// ⭐ `design/0033`：「安装命令行工具…」那个落点框。⚠️ 只在 **Rust 侧**用——
//    前端没有 `dialog:*` 权限（`commands/fs.rs::pick` 的先例），对话框的返回值
//    因此不可能被前端改写。
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

use crate::cli_tool;
use crate::commands::{
    self, asset, document, edit, fs as fs_cmd, link as link_cmd, AppState, Mode, Session,
};
use crate::config::{self, Appearance, Config};
use crate::fs::grants::SessionGrants;
use crate::fs::tree::TreeCache;
use crate::logging;

/// ⭐ **窗口的初始包装色**（`design/0004` §7 步骤 2 的「无白屏帧」）。
///
/// ⚠️ 这一层是**兜底**，不是主手段：真正管用的是下面那份**注入脚本**——
/// 它在 HTML 还没解析时就把 `data-theme` 写上了，于是**首帧就是对的**。
/// 这里管的是**更早**的一小段：WebView 还没来得及画出任何东西时，
/// 窗口自己的背影（默认是白的）。
///
/// ⚠️ `system` 档走去读系统的当前外观（`fs::order::system_prefers_dark`，
/// 走的是本项目**唯一**那份 ObjC FFI）。⚠️ 这**不是**第二个真值：
/// 页面侧仍由注入脚本的 `matchMedia` 决定，两者读的是同一个 OS 状态。
/// 拿不到系统外观时当浅色——退化成"可能闪一下"，⛔ 不是"窗口起不来"。
fn window_backdrop(mode: &str) -> Option<tauri::window::Color> {
    match mode {
        "light" => Some(tauri::window::Color(248, 249, 250, 255)),
        "dark" => Some(tauri::window::Color(30, 30, 30, 255)),
        "warm" => Some(tauri::window::Color(250, 245, 234, 255)),
        "system" => Some(if crate::fs::order::system_prefers_dark() {
            tauri::window::Color(30, 30, 30, 255)
        } else {
            tauri::window::Color(248, 249, 250, 255)
        }),
        // ⛔ 不该走到这里：模式已经过 `config::THEMES` 白名单夹取
        _ => None,
    }
}

/// ⭐ **在页面脚本之前跑的那段脚本**（`design/0004` §2.1.3）。
///
/// ⚠️ 它存在的**唯一**理由是「无白屏帧」：等 `main.js` 拿到 `get_session`
/// 再设 `data-theme` 的话，用户会看到一次浅色→深色的跳变。
///
/// ⚠️ **`system` 在页面里解析，不在 Rust 里**：`matchMedia` 只有 WebView 有。
/// 这样 `system` 与三个显式主题走的是同一条路，⛔ 不需要两套机制。
///
/// ⛔ **不在这里写死颜色**：只写 `data-theme` 与三个尺度变量，
/// 颜色全部由 `tokens.css` / `themes.css` 决定（`INV-THEME-02`）。
/// ⛔ 也不解析任何用户输入：模式已经过 [`config::THEMES`] 白名单夹取。
fn init_script(a: &Appearance, measure: bool, lang: crate::lang::Lang) -> String {
    format!(
        r#"(function () {{
  try {{
    var mode = "{mode}";
    var theme = (mode === "system")
      ? ((window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light")
      : mode;
    var root = document.documentElement;
    root.setAttribute("data-theme", theme);
    var s = root.style;
    s.setProperty("--reader-font-size", "{fs}px");
    s.setProperty("--reader-line-height", "{lh}");
    s.setProperty("--reader-content-width", "{cw}");
  }} catch (e) {{ /* 注入失败不致命：main.js 拿到快照后会补一次 */ }}
  // ⭐ 批次 2：**在页面脚本之前**把测量开关写进全局（`design/0002` §10.4 批 2）。
  //    ⚠️ 必须是注入而不是"跑起来以后设"——`measure.js` 的观察器与 `rmd:boot` 那个 mark
  //    都要**从最早一刻起**就位（`main.js` 的开头注释写了这条），
  //    晚一步设等于把首屏之前的那一段观测丢掉。
  try {{ window.__rmdMeasure = {measure}; }} catch (e) {{}}
  // ⭐ `design/0025`：**首帧的界面语言**（评审 #6）。走的正是上面那条既有的注入通道。
  //    ⚠️⚠️ 为什么非得注入：`i18n.js` 在**加载期**就要定下第一份字典
  //    （`data-i18n` 的元素在 `main.js` 跑之前就已经在 DOM 里）——
  //    等会话快照回来再设，首帧会**先闪一遍另一种语言**。
  //    ⛔ 也**不许**前端自己读 `navigator.language`（`INV-I18N-07`：裁定语言的只有后端）。
  //    ⚠️ 值只有 `"zh"` / `"en"` 两种，而且**来自 Rust 的枚举**（⛔ 不是拼出来的用户输入）。
  try {{ window.__rmdLang = "{lang}"; }} catch (e) {{}}
}})();"#,
        mode = a.mode,
        fs = a.font_size,
        lh = a.line_height,
        cw = if a.content_width == 0.0 {
            "none".to_string()
        } else {
            format!("{}px", a.content_width)
        },
        measure = if measure { "true" } else { "false" },
        // ⚠️ `tag()` 只给 `zh` / `en`（`lang.rs` 那条单测钉着）——⛔ 别在这里写 `zh-CN`，
        //    那会让前端查不到字典（`services/i18n.js` 的 `DICT` 就这两个键）。
        lang = lang.tag(),
    )
}

// ─────────────────────────────────────────────────────────────────────────
// 快捷键（`design/0010`，2026-10-14 已通过）
// ─────────────────────────────────────────────────────────────────────────

/// 快捷键**由谁处理**。
///
/// ⚠️ 两组**不允许重叠**（`INV-SET-04`）——重叠的表现是
/// 「按一下收起来又弹回去」（两边都响应了同一个键）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Owner {
    /// AppKit 在事件送达 key window **之前**吞掉它
    /// （`NSMenu.performKeyEquivalent:`）⇒ ⛔ 前端**一个字节都不许**监听这个键。
    ///
    /// ⚠️ **这一条依赖一个 `design/0010` §4 自己标为"未真机验证"的机制**。
    /// 若实测发现 AppKit **不吃**自定义菜单项的加速键，`§9.3 T6` 的退路是：
    /// **同一项改 `Owner::Web`，菜单保留但摘掉原生加速键**——
    /// ⛔ 不继续依赖"吞键"假设，也⛔ 不许两套监听并存。
    Menu,
    /// ⛔ 不给它设菜单加速键，由前端 `keymap.js` 监听。
    ///
    /// ⭐ 但**可以**在菜单里出现（普通项、无加速键）——
    /// 「菜单是否显示」与「键由谁处理」是**两个维度**（`design/0010` §3 接口 4）。
    Web,
}

/// 一项快捷键。
///
/// ⭐ **这是唯一的事实来源**（`INV-SET-01`）：菜单加速键、设置界面那一列、
/// 前端的键匹配器**全部由这一张表派生**。⛔ 前端源码里不出现任何按键字面量。
///
/// ⚠️ **本项目自创**（`design/0010` §2.1 ①）：VS Code / Obsidian / Typora / MarkEdit
/// **4 家都没有独立的键位数据文件**（`research/notes/0012` §1.3）⇒ ⛔ 不写成"业界都这样"。
/// 理由只有一条：rmd 的**菜单是 Rust 建的**，表放前端则菜单加速键必然有第二份。
struct Shortcut {
    /// 动作 id。⭐ 前端 `ACTIONS` 注册表按它查 handler。
    id: &'static str,
    /// 中文文案（菜单项与设置界面那一列）。
    ///
    /// ⭐ `design/0025` 起**一份表装两门语言**——⛔ 不是两张表：
    /// 两张表会分叉（加一条忘了加另一张），而这里 `Shortcut` 是**一条记录**，
    /// 少写一门语言**编译不过**。
    /// ⚠️ 取用一律走 [`Shortcut::label`]，⛔ 别在调用侧写 `if lang == … { self.label_zh }`。
    label_zh: &'static str,
    /// 英文文案。
    label_en: &'static str,
    /// **规范形式**（muda 语法）。⭐ 显示串由它派生（[`display`]），⛔ 不存第二份。
    accel: &'static str,
    /// 前端**还接受**的别名。
    ///
    /// ⚠️ **它们是刻意的，⛔ 不是漂移**（`design/0010` §2.1 ①）：现状匹配的是
    /// `e.key`，即「按出来**之后**」的字符——`⇧=` 给的是 `+` 而不是 `=`。
    /// 删掉它们等于**静默**地让一个已经能用的键失效（没有任何报错）。
    ///
    /// ⚠️⚠️ **别名是"前端匹配器语法"，⛔ 不喂给 muda**：`muda 0.20.0` 的键名表里
    /// **没有** `_` 与 `+` 两个键（`accelerator/mod.rs:278-296` 只有 `","` / `"="` /
    /// `"-"` / 数字 / 字母），`"Cmd+_"` 在它那里是 `Err`。
    /// ⇒ 下面那条"每个 `accel` 都能解析"的单测**只对 `accel`**，⛔ 不扩到别名。
    aliases: &'static [&'static str],
    owner: Owner,
}

impl Shortcut {
    /// 这一条在**当前界面语言**下的文案。
    ///
    /// ⭐ **唯一取文案的入口**（菜单装配、菜单重贴、`get_shortcuts` 的 DTO 都走它）：
    /// ⛔ 别在调用侧再写一次 `if lang == …`——三处各写一份的表现是
    /// "菜单换了、设置界面那一列没换"（或反过来），而那**没有任何报错**。
    fn label(&self, lang: crate::lang::Lang) -> &'static str {
        match lang {
            crate::lang::Lang::Zh => self.label_zh,
            crate::lang::Lang::En => self.label_en,
        }
    }
}

/// ⭐ V1 的表（`design/0010` §2.1 ①）。
///
/// ✅ `design/0009` 的 `file.quick-open`（`⌘P`）与 `file.refresh-index`（`⌘R`）
/// **2026-10-14 已加**，见下表末尾两项。⚠️ 加它们的**前置条件**是"表里有、代码里也有
/// handler"（`INV-SET-02`②）——`⌘R` 那一条的 handler **故意是空的**，
/// 理由写在那两项的注释里（键的真实归属是浮层，⛔ 不占全局）。
///
/// ✅ `design/0006` 的 `file.open-external-editor` **2026-10-14 已加**，
/// 见下表：`owner = Web` + [`PLAIN_MENU_ITEM_IDS`] 里各占一份。
/// ⚠️ **它的加速键 2026-10-16 从 `⌘E` 改成 `⇧⌘E`**——`⌘E` 让给了 `0012` 的
/// `edit.toggle`（分栏编辑），它是本表里**唯一换过主人的键**，留痕在下表那两项的注释里。
/// ✅ `design/0012` 的 `edit.toggle`（`⌘E`）与 `file.save`（`⌘S`）同日已在表内，
/// ⛔ 它们**不进菜单**（`design/0012` §2.2 ⑤ 的可见控件是顶栏 `#btn-edit` 那个按钮）。
const SHORTCUTS: &[Shortcut] = &[
    Shortcut {
        id: MENU_SETTINGS_ID,
        label_zh: "设置…",
        label_en: "Settings…",
        accel: "Cmd+,",
        aliases: &[],
        owner: Owner::Menu,
    },
    Shortcut {
        id: MENU_SIDEBAR_ID,
        label_zh: "显示/隐藏侧边栏",
        label_en: "Show/Hide Sidebar",
        accel: "Cmd+B",
        aliases: &[],
        owner: Owner::Menu,
    },
    // ⭐ `design/0037`（2026-10-23，用户点题「这一排的展示应该可以折叠，隐藏」）：
    //    **折叠 / 收回顶栏**。与上面那条相邻是刻意的——两条都是"把界面让给正文"。
    //
    // ⚠️ **`owner = Web` 且 ⛔ 不进菜单**，与 `edit.toggle`（`⌘E`）同形：
    //    界面状态全在前端（一个 `body` class），Rust 侧一个字节都不参与，
    //    ⇒ 没有"AppKit 在送达 key window 之前就吞掉"的理由。
    //    ⭐ 它**仍然**是这张表的义务：设置覆盖层里那份键位列表就是本表现算的，
    //    那是这个键**唯一**的展示处（`INV-SET-01`：⛔ 不许在前端另写一份键位文案）。
    // ⚠️ 前端那边**没有** handler 就会是"按下去没反应"且**不报错**——
    //    `main.js` 的 `keymap.register('view.toggle-chrome', …)` 与 `checkActions`
    //    是这一条的两道防线（`INV-SET-02`②）。
    Shortcut {
        id: "view.toggle-chrome",
        label_zh: "显示/隐藏顶栏",
        label_en: "Show/Hide Top Bar",
        accel: "Shift+Cmd+B",
        aliases: &[],
        owner: Owner::Web,
    },
    Shortcut {
        id: "file.open-directory",
        label_zh: "打开目录…",
        label_en: "Open Folder…",
        accel: "Cmd+O",
        aliases: &["Ctrl+O"],
        owner: Owner::Web,
    },
    Shortcut {
        id: "file.open-file",
        label_zh: "打开文件…",
        label_en: "Open File…",
        accel: "Shift+Cmd+O",
        aliases: &["Shift+Ctrl+O"],
        owner: Owner::Web,
    },
    Shortcut {
        id: "reader.font-inc",
        label_zh: "放大字号",
        label_en: "Increase Font Size",
        accel: "Cmd+=",
        aliases: &["Cmd++", "Ctrl+=", "Ctrl++"],
        owner: Owner::Web,
    },
    Shortcut {
        id: "reader.font-dec",
        label_zh: "缩小字号",
        label_en: "Decrease Font Size",
        accel: "Cmd+-",
        aliases: &["Cmd+_", "Ctrl+-", "Ctrl+_"],
        owner: Owner::Web,
    },
    Shortcut {
        id: "reader.font-reset",
        label_zh: "复位字号",
        label_en: "Reset Font Size",
        accel: "Cmd+0",
        aliases: &["Ctrl+0"],
        owner: Owner::Web,
    },
    // ⭐ `design/0012`（窗口内编辑，2026-10-15 已通过）：保存。
    //
    // ⚠️ **owner = Web**，与 `⌘E`（`edit.toggle`）**同形**（§2.3-3 那张归属表：这批键都在前端接）。
    //    ⛔ 但**不要**因此以为"加一行就够了"：编辑区聚焦时 `keymap.js` 的
    //    `handleKeydown`/`dispatch` 会整体 `return false`（`keymap.js:216`/`:239`）
    //    ⇒ ⭐ 这一行**同时还进** §2.3-4 的**转发白名单**（判据 `owner=web ∧ accel 含 cmd
    //    ∧ accel 不含 ctrl` ⇒ 它自动被包含），由 `src/editor/keys.js` 转发回应用分发器。
    //    ⚠️ 这正是"表是唯一来源"的第二个用处：转发白名单**派生**自本表，⛔ 不是第二份清单。
    //
    // ⚠️ **没有 Ctrl 别名**（表里其余 `file.*` 都有，这是刻意的例外）：
    //    ① `Ctrl+S` 在 macOS 上没有任何惯例来源（`Ctrl+O`/`Ctrl+E` 是从跨平台肌肉记忆来的）；
    //    ② 更要紧的是 §2.3-4 已经点名了"带 Ctrl 的别名在本期编辑区里**不生效**"，
    //       再加一条只会把那份代价清单悄悄拉长，换来一个实际没人按的组合。
    // ⚠️ `⌘S` 会被前端 `preventDefault` 掉——这**必须**如此：WKWebView 上它的默认动作是
    //    「存储网页」（`⌘S` 的 WebKit 默认行为），不拦就会同时触发一次"保存这个页面"。
    Shortcut {
        id: "file.save",
        label_zh: "保存",
        label_en: "Save",
        accel: "Cmd+S",
        aliases: &[],
        owner: Owner::Web,
    },
    // ⭐ `design/0012`：**进入 / 退出分栏编辑态**（`⌘E`）。
    //
    // ⚠️⚠️ **这个键原本属于 `file.open-external-editor`，2026-10-16 换了主人**
    //    （用户裁定，见下面那一条的留痕）。原因是一句很直白的期望错配：
    //    V2 有了窗口内编辑之后，`⌘E` 在用户心里就是"Edit"、就是**就地编辑**；
    //    而它实际弹出的是**外部编辑器**（`adr/0006` 的 V1 方案）。
    //    ⇒ 分栏编辑此前**只有一个入口**：顶栏那个 `#btn-edit` 按钮，⛔ 没有键、⛔ 没有菜单项。
    //    一个 V2 的头等功能只挂在鼠标上，而"编辑"这个词最顺手的那个键被 V1 的替代方案占着。
    //
    // ⚠️ **owner = Web**，与表里其余 `0012`/`0011` 的键同形：编辑态的整个生命周期在前端
    //    （CM6 实例、脏标记、预览调度都在 DOM 里），Rust 侧一个字节都不参与。
    //    ⛔ 因此**它不进菜单**：`design/0012` §2.2 ⑤ 要的"可见控件"由顶栏 `#btn-edit` 满足
    //    （那个按钮的 `title` 就是它的说明书），再加一个菜单项属于扩大改动面。
    // ⚠️ **没有 `Ctrl` 别名以外的东西**：`Ctrl+E` 与 `Ctrl+O` 同源（跨平台肌肉记忆），
    //    保留它是为了与 `file.open-external-editor` 换键之后**行为对称**。
    //
    // ⚠️ 它的 handler 是**有副作用的**（进/出编辑态），⛔ 不是 `file.refresh-index` 那种
    //    "登记进表、全局空实现"的样子——`main.js` 里那条必须真的调 `toggleEdit()`。
    // ⚠️ 同一族先例：`file.save`（`⌘S`）。两者**都**要进 §2.3-4 的转发白名单，
    //    否则编辑区聚焦时按下去会被 CM6 自己吃掉（判据同见 `file.save` 那一段）。
    Shortcut {
        id: "edit.toggle",
        label_zh: "进入/退出编辑",
        label_en: "Toggle Editing",
        accel: "Cmd+E",
        aliases: &["Ctrl+E"],
        owner: Owner::Web,
    },
    // ⭐ `design/0006`：外部编辑器打开（`adr/0006` 裁定 V1 用外部编辑器替代窗口内编辑）。
    // ⚠️ **owner = Web**（§9.3 第 2 条：它是前端接的、菜单里另有一个**无加速键**的普通项）。
    //    理由有两条：① AppKit 的"吞键"假设只有 `⌘B`/`⌘,` 两条被真机验过，
    //    为一个新键去赌第三次不值得；② 它触发的动作本身就在前端（要用当前会话的
    //    `currentPath` 去调命令），走 Web 少一层转发。
    //
    // ⚠️⚠️ **加速键 2026-10-16 从 `Cmd+E` 挪到 `Shift+Cmd+E`**（别名同理 `Shift+Ctrl+E`）——
    //    用户裁定把 `⌘E` 让给上面那条 `edit.toggle`（分栏编辑），外部编辑器退一位。
    //    ⛔ **这不是"把它挪走"**：`design/0006` 定的两件事一件没变——
    //    ① 它仍是 `Owner::Web`；② `File ▸ 用外部编辑器打开` 那个**无加速键**的菜单项原样保留
    //    （[`PLAIN_MENU_ITEMS`] 里 `position: 1` 那一项，⛔ 一个字没动）。
    //    ⇒ 菜单里点得着、只是不显示快捷键字形——与 `⌘F`/`⌘S` 完全同形。
    //    ⚠️ `⇧⌘E` 在改之前**是空闲的**（全表扫过），⛔ 没有抢任何人的键。
    //    ⚠️ 换键的代价已登记：`design/0012` §2.2 ⑤ 那句「⛔ **不变**」被原地改并留痕，
    //    `docs/bugs/0005`（历史记录）里那条"空会话按 `⌘E`"的目视判据现在读作 `⇧⌘E`。
    Shortcut {
        id: "file.open-external-editor",
        label_zh: "用外部编辑器打开",
        label_en: "Open in External Editor",
        accel: "Shift+Cmd+E",
        aliases: &["Shift+Ctrl+E"],
        owner: Owner::Web,
    },
    // ⭐ `design/0009`：文件名模糊搜索的浮层（`⌘P`，VS Code 同键）。
    // ⚠️ **owner = Web**：浮层的生命周期整个在前端（它甚至不是 Rust 建的窗口），
    //    而且它**只在目录模式**才该有反应（单文件模式下按了什么都不做）。
    // ⚠️ `Cmd+P` 在 macOS 上本是"打印"，而 rmd **没有打印**——
    //    `⌘O`/`⌘⇧O` 已被占掉，这是唯一"与 VS Code 对齐且不撞现有键"的选择
    //    （`design/0009` §2.3 第 5 条；将来要加打印就得重分配，已列 §9.1 S6）。
    Shortcut {
        id: "file.quick-open",
        label_zh: "按文件名搜索…",
        label_en: "Search by File Name…",
        accel: "Cmd+P",
        aliases: &[],
        owner: Owner::Web,
    },
    // ⭐ `design/0009`：重建文件名索引（`⌘R`）。
    //
    // ⚠️⚠️ **它是"登记进表、但全局什么都不做"的一种（本表里唯一一个）**，
    //    两个理由缺一不可：
    //    ① **登记**是为了 `INV-SET-01`：键位只有这一个来源，前端⛔ 不许写
    //       `'r'`/`metaKey` 那种字面量（那是"第二份表"的形态，改了键没人发现）。
    //       浮层拿 `accel` 去喂 `matchAccel`，与全局分发器**同一份匹配算法**。
    //    ② **全局不做事**是因为设计把它定为**浮层内的局部键**（`design/0009` §2.1 ②
    //       的重建时机表末行：⛔ 不占全局）——没开浮层时重建索引没有意义，
    //       而它是一次全树遍历（热盘 8.9 ms / 71 k 项，冷盘更差，`notes/0011`）。
    //       ⛔ 所以 `main.js` 里那条 handler **故意是空的**（`INV-SET-02`② 要它存在）。
    //    ⚠️ 顺带一个**必须知道**的后果：`⌘R` 从此会被前端 `preventDefault` 掉。
    //       macOS 的 Tauri 窗口上它本来不绑任何东西（`Menu::default` 的
    //       macOS 分支没有 Reload，`kb/0016` §2 读过），所以没有东西被抢走。
    Shortcut {
        id: "file.refresh-index",
        label_zh: "刷新文件名索引",
        label_en: "Refresh File Index",
        accel: "Cmd+R",
        aliases: &[],
        owner: Owner::Web,
    },
    // ⭐ `design/0011`（正文内查找 `⌘F`，2026-10-14 已通过）：三项一起加。
    //
    // ⚠️ **owner = Web**（§9.1 第 2 条的建议，§9.4 记了"按推荐值放行"）：
    //    ① 步骤 0b 真机实测 **`⌘F` 没被 WKWebView 吞**（`research/notes/0015` §7b）
    //       ——这正是"改走菜单加速键"那条备选出路的**触发条件不成立**；
    //    ② 查找的整个生命周期在前端（浮层 + 索引 + 高亮都在 DOM 上），Rust 侧**一个字节都不参与**。
    //    ⭐ 它**同时**在 [`PLAIN_MENU_ITEMS`] 里占一项（`Edit ▸ 查找…`，**⛔ 无加速键**）——
    //       与 `0006` 的 `文件 ▸ 用外部编辑器打开` **完全同形**（`Owner::Web` ＋
    //       [`PLAIN_MENU_ITEMS`] 里一个无加速键的项），所以 `MENU_ITEM_IDS` 不动、`INV-SET-04` 不受影响。
    // ⚠️ **它只挂在 `Edit` 菜单里**（`⌘F` 在 macOS 上就是"查找"），⛔ 不进 `File`。
    Shortcut {
        id: "edit.find",
        label_zh: "查找…",
        label_en: "Find…",
        accel: "Cmd+F",
        aliases: &[],
        owner: Owner::Web,
    },
    // ⭐ `⌘G` / `⇧⌘G`（§9.1 第 5 条的建议：**做**）。
    //
    // ⚠️⚠️ **浮层没开时它们是明确的 no-op**（⛔ 不顺手把浮层打开）——
    //    理由只有一个，而且它是**产品行为**问题：`⌘G` 这个词离开"查找中"就没有意义，
    //    而在浏览状态下按一下弹出一个空浮层是**抢焦点**（用户按 `⌘G` 多半是想做别的）。
    //    ⭐ 它们在**浮层开着**时由 `FindBar.js` 本地匹配（浮层里焦点在 `<input>` 上，
    //    全局分发器被 `isEditableElement` 挡掉 ⇒ ⛔ 走不到 `main.js` 那两条 handler）。
    // ⚠️ `⌘G` 在 macOS 上**本来就是"再次查找"**（`findAgain:`），所以这里与平台惯例一致；
    //    `⌘R`（`file.refresh-index`）是先例：**登记进表 + 全局 handler 故意空着**。
    Shortcut {
        id: "edit.find-next",
        label_zh: "查找下一个",
        label_en: "Find Next",
        accel: "Cmd+G",
        aliases: &[],
        owner: Owner::Web,
    },
    Shortcut {
        id: "edit.find-prev",
        label_zh: "查找上一个",
        label_en: "Find Previous",
        accel: "Shift+Cmd+G",
        aliases: &[],
        owner: Owner::Web,
    },
    // ⭐⭐ `⌘A` **全选正文**（`bugs/0036`，2026-10-29 用户实测：
    //    「cmd + A 全文选中有问题，有时候只能选中一个模块，有时候把侧边栏和菜单栏都选进去了」）。
    //
    // ⚠️⚠️ 在它之前这张表里**没有** `⌘A`，于是这个键有**两个各管一半**的主人，而且都不是"正文"：
    //    ① `Menu::default` 自带的**预定义 `Select All`**（muda 给它的是 `Cmd+A` ＋
    //       `selectAll:`，见 `muda-0.20.0/src/platform_impl/macos/mod.rs:931`）——
    //       它的范围是**整页**，侧边栏文件名与顶栏状态条一起被选进去；
    //    ② 就地编辑态由 `main.js::makeLiveView` 自己接住，把选区钉在**当前这一块**。
    //    ⇒ 本条把口径收到一句话：**`⌘A` 选的是「你正在读/写的那份正文」，⛔ 永远不含 chrome**。
    //
    // ⚠️ **`owner = Web`**：作用于 DOM 选区，Rust 侧一个字节都不参与。
    // ⛔ **不进菜单**：macOS 的 `Edit ▸ Select All` 是 `Menu::default` 给的**系统项**，
    //    与本表无关（本轮**不删**它——见 `bugs/0036` §5 的两层防线。
    //    ⚠️ 别在这里再加一条 `PLAIN_MENU_ITEMS`：那会让菜单里出现**两个「全选」**）。
    //
    // ⚠️ 它是**转发白名单**里的一员（`src/editor/keys.js` 收所有 `owner=web` 的项）
    //    ⇒ 分栏编辑态里它会被转发到前端 handler，**必须**在那边给落点（否则编辑区按 `⌘A` 变成 no-op）。
    Shortcut {
        id: "edit.select-all",
        label_zh: "全选正文",
        label_en: "Select All Text",
        accel: "Cmd+A",
        aliases: &[],
        owner: Owner::Web,
    },
];

/// ⭐ **本设计新装进菜单的两项**（`design/0010` §2.1 ③）。
///
/// ⚠️ 提出来当常量是为了让 [`tests`] 能断言「**设了原生加速键的必须是 `Owner::Menu`**」
/// ——那是 §2.1 ② 静态层的**反向**那一半。
/// ⛔ 这不是被评审 R3 否掉的"伪互锁"：那条讲的是**两份跨语言的冻结字面清单**，
/// 而这里是同一份 Rust 表内部的自洽断言。
const MENU_SETTINGS_ID: &str = "settings.open";
const MENU_SIDEBAR_ID: &str = "view.toggle-sidebar";

/// ⭐ 装进菜单、**且设了原生加速键**的那几项，**按插入顺序**。
///
/// ⚠️ 它必须**恰好等于**表里 `owner == Owner::Menu` 的 id 集（顺序也一致）——
/// `install_menu` 每次启动都会核对一次，对不上就**响亮拒绝装菜单**。
/// ⛔ 这与被评审 R3 否掉的那条**不是一回事**：那条讲的是"Rust 表 == 一份跨语言的
/// **冻结字面清单**"（两边各改各自的期望就同时绿，是伪证明）；
/// 这里是**同一张表内部**的反向断言（`INV-SET-04` 的后半句）。
///
/// ⚠️⚠️ **本常量的语义在 `design/0006` 落地时被收窄过一次**（2026-10-14）：
/// 原来是宽泛的"装进菜单的项"，现在专指**带原生加速键**的那些。
/// 起因是 `design/0006` §9.3 第 2 条要在 `File` 里加一个**无加速键**的普通项，
/// 而它按表是 `Owner::Web`——若仍用旧语义，那条"`Owner::Web` 的 id ⛔ 不许出现在
/// 菜单里"的断言会**对着一个正确的改动报红**，然后被人当成"改了断言就绿了"。
/// ⇒ 拆成两个常量：**带键的**（这里）与**不带键的**（[`PLAIN_MENU_ITEM_IDS`]）。
const MENU_ITEM_IDS: &[&str] = &[MENU_SETTINGS_ID, MENU_SIDEBAR_ID];

/// ⭐ 装进菜单、**⛔ 没有原生加速键**的一项（`design/0006` §9.3 第 2 条）。
///
/// ⚠️ 它们必须是 `Owner::Web`：**没有键可吞**，所以"AppKit 吞键"那条假设
/// 在这里根本不适用——这正是当初把外部编辑器那个键留在 Web 一侧的退路形态
/// （`design/0010` §4 给 `⌘B` 准备的那条退路，这里直接采用）。
/// ⚠️ 判据是两个方向的：本清单里的必须是 `Owner::Web`，
/// 而它们⛔ 不许同时出现在 [`MENU_ITEM_IDS`] 里（那会变成"装了键又归 Web"）。
///
/// ⚠️⚠️ **2026-10-14（`design/0011`）从"一张扁平清单"泛化成本结构**：
/// 原先是 `&[&str]`、装配时**全部插进 `File`**。加 `⌘F` 时那条路走不通了——
/// 它按 macOS 惯例该落在 **`Edit ▸ 查找…`**，而 `Edit` 的插入位置是**末尾**、
/// `File` 的是 0，⛔ 两者共用一个 `plain_count++` 会直接把项插错地方
/// （表现是「`⌘F` 的菜单项跑到 `File` 里去了」，**不报错**）。
/// 我们要碰的三个一级子菜单：**英文标题（`Menu::default` 给的）＋ 中文标题（重贴之后）**。
///
/// # 为什么必须两份都记着（`design/0025`）
///
/// 启动那一刻 `Menu::default` 装出来的标题**必然是英文**——上游那份默认菜单是
/// 硬编码英文字面量（`kb/0016` §1 逐行读过），不跟随系统语言。
/// 而**菜单重贴**（切语言）会把它们改成中文；此后再切回来、或再切一次中文，
/// 就**必须还能按中文标题找回来**。
///
/// ⛔ **只认一个标题的形态是"第一次切成功、第二次失败"**——而用户看到的
/// 只是"菜单没变"（`menu_updated=false`），看起来像是小毛病。
///
/// ⚠️ 应用子菜单（`rmd`）**不在这张表里**：它的标题是 `pkg_info.name`，
/// 是**产品名**，两门语言下都叫 `rmd`（⛔ 不翻译）。
const SUBMENU_TITLES: &[(&str, [&str; 2])] = &[
    ("File", ["File", "文件"]),
    ("Edit", ["Edit", "编辑"]),
    ("View", ["View", "视图"]),
];

/// 某个一级子菜单**两种标题都认**的列表（给 [`find_submenu`]）。
///
/// ⚠️ 没登记过的英文名返回空表 ⇒ `find_submenu` 返回 `None` ⇒ 调用点**响亮报错**。
/// 那是刻意的：静默退化成"这一项没装上"会让设置界面打不开而**没有任何线索**。
fn submenu_titles(en: &str) -> &'static [&'static str] {
    match SUBMENU_TITLES.iter().find(|(k, _)| *k == en) {
        Some((_, both)) => &both[..],
        None => &[],
    }
}

/// 某个一级子菜单**在指定语言下的标题**（给重贴计划用）。
fn submenu_title(en: &str, lang: crate::lang::Lang) -> &'static str {
    let both = submenu_titles(en);
    match lang {
        crate::lang::Lang::Zh => both[1],
        crate::lang::Lang::En => both[0],
    }
}

struct PlainMenuItem {
    /// 子菜单**标题**。
    ///
    /// ⚠️ 只能按标题找：Tauri 默认菜单的 id 是**进程内自增计数器**，⛔ 不是稳定名字
    /// （`kb/0016` §1 实测过；`install_menu` 里前两次插入也吃同一个亏）。
    submenu: &'static str,
    /// 插在这个下标处（`Submenu::insert` 的语义：插完它**就在这个下标上**）。
    position: usize,
    /// 分隔线放在这一项的哪一侧。⚠️ 两处惯例**方向相反**，所以不能压成一个常量。
    sep: SepSide,
    /// 动作 id。⚠️ 必须在 [`SHORTCUTS`] 里、且是 `Owner::Web`（[`tests`] 里那条断言管这个）。
    id: &'static str,
}

/// 分隔线相对它所服务的那一项的位置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SepSide {
    /// 线在**上**、项在**下**：`Edit ▸ … Select All ｜ ― ｜ 查找…`。
    Before,
    /// 项在**上**、线在**下**：`File ▸ 用外部编辑器打开 ｜ ― ｜ Close Window`。
    After,
    /// ⭐ **没有线**（`design/0038`）：该项与它后面那一项**连成一串**。
    ///
    /// ⚠️ 它存在的唯一理由是「`打开目录… / 打开文件… / 快速打开…` 三连，只在最后一条后
    /// 放一条分隔线」——`Before`/`After` 表达不出这个形态（每条各带一条线）。
    None,
}

/// ⭐ 装进菜单、**⛔ 没有原生加速键**的那些项（`design/0006` §9.3 第 2 条 ＋ `design/0011` §9.1 第 2 条）。
///
/// ⚠️ `position` 的语义**不是**"原菜单里的下标"：它是**排在这一项前面的「非分隔线元素」个数**
/// （原菜单项 ＋ 本组里已插入的项）。⚠️ 2026-10-24（`design/0038`）之前它恰好等于
/// "原菜单下标"，两读法在只有一条分隔线的组里同值 ⇒ 当时看不出差别；
/// 加了 `SepSide::None` 之后必须按"非分隔线条数"读——见 [`placements`] 的算法。
const PLAIN_MENU_ITEMS: &[PlainMenuItem] = &[
    // ⭐ `design/0038` §2.3：`File` 顶部三个打开入口（**都无加速键**，`⌘O`/`⇧⌘O`/`⌘P`
    //    仍归前端 `keymap.js`）。⚠️ 它们是**同一串**：前两条之间、第二条与第三条之间都没有线，
    //    只有 `快速打开…` 之后有一条（`SepSide::After`）⇒ `SepSide::None`。
    // ⚠️ 文案全部来自 `SHORTCUTS` 的 `file.open-directory` / `file.open-file` / `file.quick-open`
    //    （`menu_label` 就这么查），⛔ 这里一个字面量都没有（`INV-START-06`）。
    PlainMenuItem {
        submenu: "File",
        position: 0,
        sep: SepSide::None,
        id: "file.open-directory",
    },
    PlainMenuItem {
        submenu: "File",
        position: 1,
        sep: SepSide::None,
        id: "file.open-file",
    },
    PlainMenuItem {
        submenu: "File",
        position: 2,
        sep: SepSide::After,
        id: "file.quick-open",
    },
    // ⭐ `design/0012`：`File ▸ 保存`（**无加速键**，与下面 `用外部编辑器打开` 同形；`⌘S` 由前端接）。
    //
    // ⚠️ 2026-10-24（`design/0038`）它从位置 0 **顺延到 3**：上面多了三条打开入口。
    //    按"前面有几个非分隔线元素"数 = 三个打开项 ⇒ 3。
    PlainMenuItem {
        submenu: "File",
        position: 3,
        sep: SepSide::After,
        id: "file.save",
    },
    // ⚠️ 2026-10-24（`design/0038`）从位置 1 **顺延到 4**（前面有 4 个非分隔线元素）。
    //    ⚠️ 最终是 `File ▸ [打开目录…, 打开文件…, 快速打开…, ―, 保存, ―, 用外部编辑器打开, ―, 关闭窗口]`。
    //
    //    ⚠️ **键换过、菜单项没动**（2026-10-16）：它对应的 `file.open-external-editor`
    //       加速键已从 `⌘E` 挪到 `⇧⌘E`（`⌘E` 让给 `edit.toggle`）。⭐ 而**这一项一个字没改**——
    //       它本来就是**无加速键**的，换键前后都只负责把动作送到前端。
    PlainMenuItem {
        submenu: "File",
        position: 4,
        sep: SepSide::After,
        id: "file.open-external-editor",
    },
    // ⚠️ 位置 **7**：macOS 的 `Edit` 是 `Undo / Redo / ― / Cut / Copy / Paste / Select All`
    //    共 **7** 项（`kb/0016` §1 那张表）⇒ 排在这一项前面的是 7 个非分隔线元素。
    //    ⭐ 这不是随手挑的数：Apple 的 `Edit ▸ Find` 就在 `Select All` 之后，
    //       而且**要有一条分隔线**（`sep: Before` ⇒ 插完是 `[… Select All, ―, 查找…]`）。
    PlainMenuItem {
        submenu: "Edit",
        position: 7,
        sep: SepSide::Before,
        id: "edit.find",
    },
];

/// 本表里的动作 id 集。
///
/// ⭐ **派生自 [`PLAIN_MENU_ITEMS`]，⛔ 不是第二份字面清单**——
/// 两份清单并存正是被评审 R3 否掉的"伪互锁"的形态（`MENU_ITEM_IDS` 的注释里也记着这条）。
fn plain_menu_ids() -> Vec<&'static str> {
    PLAIN_MENU_ITEMS.iter().map(|p| p.id).collect()
}

// ─────────────────────────────────────────────────────────────────────────
// 应用子菜单里的两项（`design/0033`）
// ─────────────────────────────────────────────────────────────────────────
//
// ⭐ 为什么**不开一张 `SHORTCUTS` 行**：那张表要求 `accel` 非空（`送到前端的每一项都带
//    accel 与 display` 那条断言盯着），而这两项按设计**没有快捷键**——
//    "装一条命令"不是一个值得占一个全局组合键的动作。硬塞进去还会让
//    `Owner::Menu ⊻ Owner::Web` 那条自洽断言（`INV-SET-04`）多一个假成员。
// ⚠️ 于是它们**不在 `SHORTCUTS` 里**，也就**不在** `MENU_ITEM_IDS` / `plain_menu_ids()`
//    里——`handle_menu_event` 开头那句"不在表里就 `return`"会**先**把它们挡掉，
//    所以那一处必须**在早退之前**认这两个 id（见 `handle_menu_event`）。
// ⚠️ 但**重贴计划必须覆盖它们**（`relabel_plan` 与它那条集合相等的测试），
//    否则切一次语言后这两行永远停在旧语言——与 `design/0025` 那条"少一项就静默"同形。

const APP_MENU_INSTALL_ID: &str = "cli.install";
const APP_MENU_UNINSTALL_ID: &str = "cli.uninstall";

/// 装进**应用子菜单**（`rmd` ▸ …）的项。⚠️ 顺序 = 插入顺序。
///
/// ⭐ 「安装」的文案**带省略号**：点下去会先弹一个原生框问落点；「卸载」**不带**（不弹框）。
struct AppMenuItem {
    id: &'static str,
    label_zh: &'static str,
    label_en: &'static str,
}

impl AppMenuItem {
    fn label(&self, lang: crate::lang::Lang) -> &'static str {
        match lang {
            crate::lang::Lang::Zh => self.label_zh,
            crate::lang::Lang::En => self.label_en,
        }
    }
}

const APP_MENU_ITEMS: &[AppMenuItem] = &[
    AppMenuItem {
        id: APP_MENU_INSTALL_ID,
        label_zh: "安装命令行工具…",
        label_en: "Install Command Line Tool…",
    },
    AppMenuItem {
        id: APP_MENU_UNINSTALL_ID,
        label_zh: "卸载命令行工具",
        label_en: "Uninstall Command Line Tool",
    },
];

fn app_menu_ids() -> Vec<&'static str> {
    APP_MENU_ITEMS.iter().map(|i| i.id).collect()
}

fn app_menu_item(id: &str) -> Option<&'static AppMenuItem> {
    APP_MENU_ITEMS.iter().find(|i| i.id == id)
}

fn app_menu_label(id: &str, lang: crate::lang::Lang) -> Option<&'static str> {
    app_menu_item(id).map(|i| i.label(lang))
}

/// 菜单里某一项的文案：**快捷键表与非快捷键表都查**。
///
/// ⚠️ 抽出来是为了让 [`relabel_plan`] 不再假设"菜单项的 id 一定在 `SHORTCUTS` 里"。
fn menu_label(id: &str, lang: crate::lang::Lang) -> Option<&'static str> {
    shortcut(id).map(|s| s.label(lang)).or_else(|| app_menu_label(id, lang))
}

/// 一项要插的**两个格子**：它的分隔线在哪、它自己在哪。
///
/// ⚠️ `sep_at == None` ⇒ 这一项**不带分隔线**（[`SepSide::None`]，`design/0038`）。
#[derive(Debug, PartialEq, Eq)]
struct Placement {
    sep_at: Option<usize>,
    item_at: usize,
}

/// ⭐ **同一子菜单里每一项的落点**（`install_menu` 用；**纯函数**，`&[&PlainMenuItem]` 进、下标出）。
///
/// # 为什么它是一个独立函数、而不是循环里的两行加法
///
/// ⚠️ 因为这里的算法一旦错，**症状是静默的**：`muda` 对越界的 `position` **不报错**
/// （插到末尾），而菜单照样能点、加速键照样生效 ⇒ 只有人拉开菜单才看得出顺序不对
/// （`同一子菜单里的插入位置互不相同` 那条测试的注释里写着同一件事）。
/// 抽成纯函数之后，"给定这张表，菜单最终长什么样"变成可断言的
/// （见 `无加速键项插完之后的菜单顺序`）。
///
/// # 算法
///
/// `position` 的语义是「**排在这一项前面的非分隔线元素个数**」（原菜单项 ＋ 本组已插入的项）。
/// 分隔线是**我们新插的**、本来不在那份计数里，所以每插一条线，后面的落点都要 +1
/// ⇒ `at = position + offset`，而 **`offset` 数线、⛔ 不数项**。
///
/// ⚠️⚠️ **这个方向与 2026-10-15 那版相反，是 `design/0038` 加的 `SepSide::None` 逼出来的**：
/// 旧版 `offset` 数**项**，那是因为在"每组一条线"的形态下两种数法同值、而数项那版的
/// `position` 读作"原菜单下标"（`File` 只有 1 项时它只能是 0 或 1）。
/// 现在 `File` 顶部要连放 **5** 个项，`position` 只能按"前面的非分隔线元素"数（0–4）。
/// ⭐ 两种读法对**原有那三行**逐字节同值（`保存` 0／`用外部编辑器打开` 1／`查找…` 7），
/// 所以这次换算法**没有动老行的落点**——`无加速键项插完之后的菜单顺序` 那条夹具同时守着这一点。
fn placements(group: &[&PlainMenuItem]) -> Vec<Placement> {
    let mut offset = 0usize;
    group
        .iter()
        .map(|p| {
            let at = p.position + offset;
            let place = match p.sep {
                SepSide::Before => Placement { sep_at: Some(at), item_at: at + 1 },
                SepSide::After => Placement { sep_at: Some(at + 1), item_at: at },
                // ⚠️ 只占项那一格，⛔ 不占线那一格、⛔ 也不给后面的项加偏移
                SepSide::None => Placement { sep_at: None, item_at: at },
            };
            if p.sep != SepSide::None {
                offset += 1;
            }
            place
        })
        .collect()
}

/// 按 id 查一项。⚠️ 查不到返回 `None`——调用方**必须**响亮处理，⛔ 不静默跳过。
fn shortcut(id: &str) -> Option<&'static Shortcut> {
    SHORTCUTS.iter().find(|s| s.id == id)
}

/// 把一个 `accel` 切成「修饰键 / 键名」。
///
/// ⭐ **照 `muda` 的规则来**（`accelerator/mod.rs:202-226`）：`rfind('+')` 切分，
/// 且「键名本身就是 `+`」时把分隔符那一支单独处理（`"Cmd++"` → 修饰 `Cmd`、键 `+`）。
/// ⛔ **别自己发明一套**——两份规则一旦不同，设置界面显示的键就会与真正装上去的不一致。
fn split_accel(accel: &str) -> (&str, &str) {
    let a = accel.trim();
    match a.rfind('+') {
        Some(pos) => {
            let key = &a[pos + 1..];
            if key.trim().is_empty() {
                (a[..pos].trim_end_matches('+'), "+")
            } else {
                (&a[..pos], key.trim())
            }
        }
        None => ("", a),
    }
}

/// ⭐ 由 `accel` **派生**显示串（`design/0010` §2.1 ①）。⛔ 不存两份。
///
/// 修饰键顺序按 **Apple 的 `⌃⌥⇧⌘`**（所以 `Shift+Cmd+O` → `⇧⌘O`，⛔ 不是 `⌘⇧O`），
/// 键名照写（`","` / `"="` / `"-"` / `"0"` 原样，字母大写）。
///
/// ⚠️ 它**只对 `accel`** 用，⛔ 不送给别名——别名是给匹配器的，不是给人看的
/// （`design/0010` §2.1 ①：设置界面里**不列** `Ctrl` 别名）。
fn display(accel: &str) -> String {
    let (mods, key) = split_accel(accel);
    let (mut ctrl, mut alt, mut shift, mut cmd) = (false, false, false, false);
    for t in mods.split('+') {
        match t.trim().to_ascii_uppercase().as_str() {
            "CONTROL" | "CTRL" => ctrl = true,
            "OPTION" | "ALT" => alt = true,
            "SHIFT" => shift = true,
            "COMMAND" | "CMD" | "SUPER" | "META" => cmd = true,
            _ => {}
        }
    }
    let mut out = String::new();
    if ctrl {
        out.push('⌃');
    }
    if alt {
        out.push('⌥');
    }
    if shift {
        out.push('⇧');
    }
    if cmd {
        out.push('⌘');
    }
    out.push_str(&key.to_ascii_uppercase());
    out
}

/// ⭐ 菜单有没有装成功（`design/0010` §7 步骤 12 的 `菜单=` 判据）。
///
/// ⚠️ 这是**进程内的启动结果**，⛔ 不是配置 ⇒ **不进 `config.json`**
/// （`design/0010` §3「明确不动」第 1 条：一个字段都不加）。
static MENU_INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 在 `Menu::default` 的基础上，**按位置**插入两项（`design/0010` §2.1 ③）。
///
/// ⭐ **起点用上游的**（`Menu::default(app)`），只做增量：⛔ 不手搭整棵。
/// 它的确切构成已在 `docs/kb/0016` §2 里一行行读过（app 子菜单拿 `pkg_info.name`
/// 当标题**同时也是 id**；`View` 在 macOS 上只有 Full Screen），
/// 但那次读证明的只是「今天长这样」——照抄一份等于把它冻进我们的仓库。
///
/// ⚠️ **找不到子菜单时必须响亮**：`eprintln!` + 返回 `Err`，
/// ⛔ **不静默退化成"少两项"**——那会让设置界面打不开而**没有任何线索**。
/// ⭐ 在根菜单的**一级项**里按**标题**找一个子菜单。
///
/// # 为什么按标题，⛔ 不按 id
///
/// ⚠️⚠️ **`Menu::default` 造出来的子菜单根本没有"有意义的 id"**——这是 2026-10-14
/// 实施时**真机冒烟撞出来的**（原稿按 `kb/0016` §2 写的"app 子菜单拿 `pkg_info.name`
/// 当标题**同时也是 id**"，那句**是错的**，已在 `kb/0016` 里原地改正并留痕）：
///
/// ```text
/// tauri-2.12.3/src/menu/menu.rs:151  Submenu::with_items(app_handle, pkg_info.name.clone(), true, &[…])
///                → menu.rs:225       Self::new(manager, text, enabled)
///                → submenu.rs:98     muda::Submenu::new(text, enabled)
///                → items/submenu.rs:113  Self::new_inner(None, text, enabled)
///                → util.rs:22        util::next_id(None)  ⇒  MenuId(全局计数器自增的 "0"/"1"/…)
/// ```
///
/// ⇒ 一级子菜单（应用 / `File` / `Edit` / `View`）的 id 是**一个进程内自增的数字**，
/// 而 `util.rs:15` 那个 `ID_COUNTER` 是**全局的**（连 `Window`/`Help` 之外
/// 我们自己在别处建的项也会吃掉号）——它**既不确定也不稳定**，
/// 换一次 Tauri 版本、或在它之前多建一个子菜单，号就变了。
/// ⚠️ 正因如此 Tauri 才给 `Window`/`Help` 单列了两个常量 id
/// （`menu.rs:15-18` 的 `WINDOW_SUBMENU_ID`/`HELP_SUBMENU_ID`）——那恰好说明其余几个**没有**。
///
/// ⭐ **标题**才是那个"两边都由同一个常量决定"的东西：
/// 应用子菜单的标题就是 `pkg_info.name`（`menu.rs:161`），`View` 就是字面量 `"View"`
/// （`menu.rs:229`）。按它查，则"Tauri 改了标题"与"我们找不到"是**同一件事**，
/// 而那件事**会响亮报错**（下面每个 `None` 都写进了返回值）。
/// ⚠️⚠️ **`design/0025` 起 `titles` 是一个列表，⛔ 不是一个字符串**：
/// 菜单重贴（切语言）之后 `"File"` 叫 `"文件"`、`"View"` 叫 `"视图"`，
/// 而**下一次重贴还要能找回来**（切回英文、或再切一次中文）。
/// 只认一个标题的表现是"第一次切语言成功、第二次就报错"，而**切换本身看起来是好的**。
fn find_submenu(menu: &Menu<tauri::Wry>, titles: &[&str]) -> Option<Submenu<tauri::Wry>> {
    let items = match menu.items() {
        Ok(v) => v,
        Err(e) => {
            diag_stderr!("⛔ 读一级菜单项失败：{e}");
            diag_file!(
                "⛔ 读一级菜单项失败 err_class={} err_len={}",
                logging::err_class(&e),
                e.to_string().len()
            );
            return None;
        }
    };
    for item in items {
        if let MenuItemKind::Submenu(sub) = item {
            // ⚠️ `text()` 是 `run_item_main_thread!` 的（`submenu.rs:362`），
            //    读失败就当"不是它"继续找——⛔ 不 panic（那时连报错都出不去了）。
            if let Ok(t) = sub.text() {
                if titles.iter().any(|want| *want == t) {
                    return Some(sub);
                }
            }
        }
    }
    None
}

/// 装菜单（`design/0010` §2.1 ③）。
///
/// ⚠️ **从 `Menu::default` 出发、按位置插两项**，⛔ 不手搭整棵——
/// 它的确切构成已在 `docs/kb/0016` §2 里一行行读过（`View` 在 macOS 上只有 Full Screen），
/// 但那次读证明的只是「今天长这样」——照抄一份等于把它冻进我们的仓库。
/// ⚠️⚠️ 而 §2 里"应用子菜单的 id 就是 app 名"那半句**是错的**，
/// 2026-10-14 实施时撞出来了（见 [`find_submenu`]），已在 `kb/0016` 原地改正。
///
/// ⚠️ **找不到子菜单时必须响亮**：`eprintln!` + 返回 `Err`，
/// ⛔ **不静默退化成"少两项"**——那会让设置界面打不开而**没有任何线索**。
///
/// ⭐ `design/0025` 起多一个 `lang`：**菜单文案在装配那一刻就按生效语言写死**
/// （⛔ 不装英文再靠重贴改成中文——那会多一次"菜单先闪一下英文"的机会）。
/// ⚠️ 子菜单标题**仍按英文查**：这一刻 `Menu::default` 刚造出来，标题必然是英文
/// （见 [`SUBMENU_TITLES`]）。
fn install_menu(app: &tauri::AppHandle, lang: crate::lang::Lang) -> Result<(), String> {
    // ⚠️ `package_info()` 是 `AppHandle` 的固有方法，⛔ 不需要 `use tauri::Manager`。

    // ⭐ **先验表内自洽**（`INV-SET-04` 的反向）：装了原生加速键的项，必须都是
    //    `Owner::Menu`。⚠️ 这一条**浏览器不会报错、AppKit 也不会**——
    //    真出错的形态是"同一个键被响应两次"（收起来又弹回去），极难从现象倒推。
    let menu_ids: Vec<&str> = SHORTCUTS
        .iter()
        .filter(|s| s.owner == Owner::Menu)
        .map(|s| s.id)
        .collect();
    if menu_ids != MENU_ITEM_IDS {
        diag!(
            "⛔ 表内不自洽：owner=Menu 的 id 是 {menu_ids:?}，而装进菜单的是 {MENU_ITEM_IDS:?}"
        );
        return Err("owner=Menu 的 id 集与 MENU_ITEM_IDS 不一致".to_string());
    }

    let menu = Menu::default(app).map_err(|e| format!("Menu::default 失败：{e}"))?;

    let settings = shortcut(MENU_SETTINGS_ID)
        .ok_or_else(|| format!("快捷键表里没有 {MENU_SETTINGS_ID}"))?;
    let sidebar =
        shortcut(MENU_SIDEBAR_ID)
            .ok_or_else(|| format!("快捷键表里没有 {MENU_SIDEBAR_ID}"))?;

    let settings_item = MenuItemBuilder::with_id(settings.id, settings.label(lang))
        .accelerator(settings.accel)
        .build(app)
        .map_err(|e| format!("建「{}」失败：{e}", settings.label(lang)))?;
    let sidebar_item = MenuItemBuilder::with_id(sidebar.id, sidebar.label(lang))
        .accelerator(sidebar.accel)
        .build(app)
        .map_err(|e| format!("建「{}」失败：{e}", sidebar.label(lang)))?;

    // —— ① 应用子菜单：`About` 之后插「设置…」——
    let app_title = app.package_info().name.clone();
    // ⚠️ 应用子菜单的标题就是产品名，两门语言下都一样 ⇒ 只认它一个。
    match find_submenu(&menu, &[app_title.as_str()]) {
        Some(sub) => {
            // position 1（About 之后）+ position 2 ⇒ 落在 About 与 Services 之间。
            // ⚠️ 分隔线与项**分两次插**，位置按 muda 的语义是"插在这个下标处"。
            let sep = PredefinedMenuItem::separator(app)
                .map_err(|e| format!("建分隔线失败：{e}"))?;
            sub.insert(&sep, 1)
                .map_err(|e| format!("插「设置…」分隔线失败：{e}"))?;
            sub.insert(&settings_item, 2)
                .map_err(|e| format!("插「设置…」失败：{e}"))?;
            // ⭐ `design/0033`：`rmd ▸ 安装命令行工具… / 卸载命令行工具`。
            // ⚠️ 位置 **3、4**＝紧接在「设置…」之后、`Services` 之前；
            //    按序插（3 再 4），⛔ 不要倒着插——`insert` 的下标是**当时那个表状态**下的。
            for (offset, item) in APP_MENU_ITEMS.iter().enumerate() {
                let mi = MenuItemBuilder::with_id(item.id, item.label(lang))
                    .build(app)
                    .map_err(|e| format!("建「{}」失败：{e}", item.label(lang)))?;
                sub.insert(&mi, 3 + offset)
                    .map_err(|e| format!("插「{}」失败：{e}", item.label(lang)))?;
            }
        }
        None => {
            diag!(
                "⛔ 应用子菜单查不到（按标题找的，标题是 {app_title:?}）——Tauri 的默认菜单布局变了？"
            );
            return Err(format!("应用子菜单 {app_title:?} 查不到（它没有稳定的 id，只能按标题找）"));
        }
    }

    // —— ② `View` 子菜单：`Full Screen` **之前**插「显示/隐藏侧边栏」——
    // ⭐ 用**普通项**、⛔ 不用 `CheckMenuItem`：勾选态要求 Rust 知道
    //    `Sidebar.js` 里那个 `collapsed` ⇒ 那等于给 `collapsed` 造**第二个真值来源**
    //    （还要一条新命令回传）。✅ 业界同形：Typora 的 `View → Toggle Sidebar` 就是普通项。
    match find_submenu(&menu, submenu_titles("View")) {
        Some(sub) => {
            sub.insert(&sidebar_item, 0)
                .map_err(|e| format!("插「{}」失败：{e}", sidebar.label(lang)))?;
        }
        None => {
            diag!("⛔ 「View」子菜单查不到（按标题找的）——Tauri 的默认菜单布局变了？");
            return Err("View 子菜单查不到（它没有稳定的 id，只能按标题找）".to_string());
        }
    }

    // —— ③ 无加速键的菜单项：外部编辑器进 `File`（`design/0006`）、`⌘F` 进 `Edit`（`design/0011`）——
    // ⚠️ **按子菜单标题分组**，⛔ 不是"一张扁平清单全塞进同一个子菜单"：
    //    `⌘F` 按 macOS 惯例归 `Edit`，而 `Edit` 的插入位置是**末尾**（7）、`File` 的是 0，
    //    共用一个 `count++` 会把项插错地方（**不报错**，只是菜单里多出一项在怪位置）。
    // ⚠️ **不加 `.accelerator(...)`**：外部编辑器与 `⌘F` 都归前端（表里那两行的注释）。
    //    两条路径都通到同一个动作 id，所以"菜单点了"与"按了键"行为一致（§2.1 ⑧ 的通道）。
    {
        // ⚠️ 分组顺序按**表里的首次出现顺序**（`Vec` + `contains`），⛔ 不用 `BTreeMap`——
        //    那会按标题字典序装菜单，将来加子菜单时"先后"就变成一个隐式约定。
        let mut titles: Vec<&str> = Vec::new();
        for p in PLAIN_MENU_ITEMS {
            if !titles.contains(&p.submenu) {
                titles.push(p.submenu);
            }
        }
        for title in titles {
            let sub = match find_submenu(&menu, submenu_titles(title)) {
                Some(s) => s,
                None => {
                    diag!(
                        "⛔ 「{title}」子菜单查不到（按标题找的）——Tauri 的默认菜单布局变了？"
                    );
                    return Err(format!("{title} 子菜单查不到（它没有稳定的 id，只能按标题找）"));
                }
            };
            let group: Vec<&PlainMenuItem> =
                PLAIN_MENU_ITEMS.iter().filter(|p| p.submenu == title).collect();
            // ⚠️ 落点由 [`placements`] 算（**纯函数**，单测钉得住）——
            //    这里只负责按算出来的下标去插，⛔ 不再自己加一次偏移。
            for (p, place) in group.iter().zip(placements(&group)) {
                let s = shortcut(p.id).ok_or_else(|| format!("快捷键表里没有 {}", p.id))?;
                // ⚠️ 分隔线与项**分两次插**、且顺序由 `sep` 决定：
                //    `Before` 时线的下标在项前面（先插线才不会把它顶走），
                //    `After` 时反过来。⛔ 这不是风格——插错顺序就把线插到了项的另一侧。
                //    ⚠️ `None` 时 `sep_at` 是 `None` ⇒ 一条线都不插（`design/0038`）。
                if p.sep == SepSide::Before {
                    let sep = PredefinedMenuItem::separator(app)
                        .map_err(|e| format!("建「{}」的分隔线失败：{e}", s.label(lang)))?;
                    let at = place.sep_at.expect("Before 一定有 sep_at");
                    sub.insert(&sep, at)
                        .map_err(|e| format!("插「{}」的分隔线失败：{e}", s.label(lang)))?;
                }
                let item = MenuItemBuilder::with_id(s.id, s.label(lang))
                    .build(app)
                    .map_err(|e| format!("建「{}」失败：{e}", s.label(lang)))?;
                sub.insert(&item, place.item_at)
                    .map_err(|e| format!("插「{}」失败：{e}", s.label(lang)))?;
                if p.sep == SepSide::After {
                    let sep = PredefinedMenuItem::separator(app)
                        .map_err(|e| format!("建「{}」的分隔线失败：{e}", s.label(lang)))?;
                    let at = place.sep_at.expect("After 一定有 sep_at");
                    sub.insert(&sep, at)
                        .map_err(|e| format!("插「{}」的分隔线失败：{e}", s.label(lang)))?;
                }
            }
        }
    }

    // ⚠️ macOS 上这一步走 `run_on_main_thread(init_app_menu)`，是 **app 级**的
    //    （`app.rs:997-1006`），与"有没有窗口"无关。
    app.set_menu(menu)
        .map_err(|e| format!("set_menu 失败：{e}"))?;
    MENU_INSTALLED.store(true, std::sync::atomic::Ordering::Relaxed);

    diag!(
        "▶ 菜单：{} 项已装（{}{}｜{}{}｜{}·无键）",
        SHORTCUTS.len(),
        settings.label(lang),
        display(settings.accel),
        sidebar.label(lang),
        display(sidebar.accel),
        plain_menu_ids().join("、")
    );
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// 界面语言：菜单重贴 ＋ `set_language`（`design/0025`）
// ─────────────────────────────────────────────────────────────────────────
//
// ⚠️ 语言**怎么算**（偏好 → 生效语言、`defaults` 的解析、200 ms 有界 spawn）
//    全在 `crate::lang`，那里是**不门控**的（`make test` 跑得到）。
//    本段只有那一半**必须有 `AppHandle` 才能做的事**：把已装上的菜单重贴一遍。
//
// ⭐ 为什么是"重贴"而不是"重建菜单"：重建要 `Menu::default`＋再插一遍＋`set_menu`，
//    那会**换掉菜单对象**——`on_menu_event` 的通道不受影响（它是 app 级的），
//    但用户在菜单开着的时候点一下就会关掉菜单，而且多一次"菜单短暂消失"的机会。
//    `set_text` 是原地改文案，**不动结构**，也就不会打乱任何位置/加速键。

/// 一次菜单重贴要做的事。**纯逻辑**（⛔ 不碰 `AppHandle`）⇒ 单测钉得住。
///
/// ⚠️ `items` 必须**恰好**覆盖「装进菜单的那些项」——[`MENU_ITEM_IDS`] ＋
/// [`plain_menu_ids()`]（顺序也一致），外加 [`SUBMENU_TITLES`] 里那三个子菜单标题。
/// ⛔ **少一项的表现是"切了语言，菜单里那一行还是旧语言"**：没有任何报错，
/// 而菜单的其余部分看起来完全正常 ⇒ `tests` 里那条集合相等的断言就是为这个写的。
#[derive(Debug, PartialEq, Eq)]
struct RelabelPlan {
    /// 动作 id → 目标语言下的文案（顺序 == `MENU_ITEM_IDS` ＋ `plain_menu_ids()`）。
    items: Vec<(&'static str, &'static str)>,
    /// `(英文键, 目标语言下的标题)`——只含 [`SUBMENU_TITLES`] 里那三个。
    submenus: Vec<(&'static str, &'static str)>,
}

fn relabel_plan(lang: crate::lang::Lang) -> RelabelPlan {
    // ⚠️ 三段：带加速键的 → **应用子菜单那两项**（`design/0033`，无加速键也不在
    //    `SHORTCUTS` 里）→ `PLAIN_MENU_ITEMS`。⛔ 漏掉中间那段的表现是
    //    "切了语言，`rmd ▸ 安装命令行工具…` 还是旧语言"，而其余菜单完全正常。
    let ids: Vec<&'static str> = MENU_ITEM_IDS
        .iter()
        .copied()
        .chain(app_menu_ids())
        .chain(plain_menu_ids())
        .collect();
    let items = ids
        .into_iter()
        // ⚠️ 查不到的**跳过**而不是 `unwrap()`：切一次语言不该能把应用弄崩。
        //    （"表里有、菜单里也有"那条自洽由 `install_menu` 的启动断言管着。）
        .filter_map(|id| menu_label(id, lang).map(|text| (id, text)))
        .collect();
    RelabelPlan {
        items,
        submenus: SUBMENU_TITLES
            .iter()
            .map(|(en, _)| (*en, submenu_title(en, lang)))
            .collect(),
    }
}

/// 把**已装上**的菜单重贴成 `lang`。成功返回 `true`。
///
/// ⭐ **诚实的口径**：任何一处失败都返回 `false`，由 [`set_language`] 原样告诉前端
/// （`main.js` 会显示「菜单将在重启后生效」）——⛔ **不谎报"切好了"**。
/// `INV-I18N-05` 就是这么写的：菜单文案只能靠 `set_text`，而它**可能失败**。
///
/// ⚠️ 一处失败**不中断**其余项：查不到某一项不该让另外十项也不换。
/// ⚠️ 失败时前端界面文案**照常切换**（两件事互不依赖）——只是重启前菜单是旧语言。
///
/// ⚠️ 线程：`set_text` 走 `run_item_main_thread!`（`normal.rs:93-97`），
/// 主线程上调用会**就地执行**（`send_user_message` 的 `current_thread` 分支，
/// `tauri-runtime-wry-2.12.1/src/lib.rs:263-280`），别的线程上调用会**阻塞等到主线程做完**
/// ⇒ 本函数返回时文案**真的已经贴上**，⛔ 不是"排进了队列"。
fn relabel_menu(app: &tauri::AppHandle, lang: crate::lang::Lang) -> bool {
    let Some(menu) = app.menu() else {
        diag!("⛔ 菜单重贴：`app.menu()` 是 None（菜单根本没装上）");
        return false;
    };
    // ⚠️ `Menu::get` 只搜**顶层**项（`menu.rs:376-388`），而我们要改的全在子菜单里
    //    ⇒ 自己把一级子菜单捞出来，再逐个 `Submenu::get`（`submenu.rs:341-347`）。
    let subs: Vec<Submenu<tauri::Wry>> = match top_submenus(&menu) {
        Ok(v) => v,
        Err(e) => {
            diag_stderr!("⛔ 菜单重贴：读一级菜单项失败：{e}");
            diag_file!(
                "⛔ 菜单重贴：读一级菜单项失败 err_class={} err_len={}",
                logging::err_class(&e),
                e.to_string().len()
            );
            return false;
        }
    };

    let plan = relabel_plan(lang);
    let mut ok = true;

    // —— ① 动作项 ——
    for (id, text) in &plan.items {
        let mut hit = false;
        for sub in &subs {
            let Some(kind) = sub.get(*id) else { continue };
            hit = true;
            match kind {
                MenuItemKind::MenuItem(it) => {
                    if let Err(e) = it.set_text(text) {
                        diag_stderr!("⛔ 菜单重贴：{id} 改文案失败：{e}");
                        diag_file!(
                            "⛔ 菜单重贴失败 id={id} err_class={} err_len={}",
                            logging::err_class(&e),
                            e.to_string().len()
                        );
                        ok = false;
                    }
                }
                // ⚠️ 类型变了（有人把它换成了 check/icon 项）：⛔ 不 panic，如实记一条。
                _ => {
                    diag!("⛔ 菜单重贴：{id} 不是普通菜单项（类型变了？）");
                    ok = false;
                }
            }
            break;
        }
        if !hit {
            diag!("⛔ 菜单重贴：找不到菜单项 {id}");
            ok = false;
        }
    }

    // —— ② 子菜单标题（`File` / `Edit` / `View`）——
    // ⚠️ **两种标题都认**（`submenu_titles`）：切过一次之后它们就叫「文件/编辑/视图」了，
    //    只认英文的表现是"第一次切成功、第二次失败"。
    for (en, text) in &plan.submenus {
        match find_submenu(&menu, submenu_titles(en)) {
            Some(sub) => {
                if let Err(e) = sub.set_text(text) {
                    diag_stderr!("⛔ 菜单重贴：子菜单 {en} 改标题失败：{e}");
                    diag_file!(
                        "⛔ 菜单重贴：子菜单改标题失败 submenu={en} err_class={} err_len={}",
                        logging::err_class(&e),
                        e.to_string().len()
                    );
                    ok = false;
                }
            }
            None => {
                diag!("⛔ 菜单重贴：找不到子菜单 {en}（两种标题都试过了）");
                ok = false;
            }
        }
    }

    ok
}

/// 一级菜单里的子菜单（⚠️ `Menu::get` 只扫本层，见 [`relabel_menu`] 的说明）。
///
/// ⚠️ 抽成函数是因为 [`menu_probe`] 也要用**同一份**取法：⛔ 探针自己再写一遍
/// 就等于"取证用的链与被证的链不是同一条"（本项目最怕的那种自欺）。
fn top_submenus(menu: &Menu<tauri::Wry>) -> tauri::Result<Vec<Submenu<tauri::Wry>>> {
    Ok(menu
        .items()?
        .into_iter()
        .filter_map(|k| match k {
            MenuItemKind::Submenu(s) => Some(s),
            _ => None,
        })
        .collect())
}

/// 读回某一项的**当前文案**（[`menu_probe`] 用）。
///
/// ⚠️ 找不到 / 类型不对 / `text()` 出错**一律 `None`**——探针要判的是"读得回且对得上"，
/// ⛔ 不是"读的时候会不会 panic"。
fn read_item_text(subs: &[Submenu<tauri::Wry>], id: &str) -> Option<String> {
    for sub in subs {
        if let Some(kind) = sub.get(id) {
            return match kind {
                MenuItemKind::MenuItem(it) => it.text().ok(),
                _ => None,
            };
        }
    }
    None
}

/// ⭐ **`design/0025` §7.1 步骤 0a 的取证入口**（`RMD_MENU_PROBE=1`）。
///
/// # 它回答什么
///
/// §2.3 那条**评审 #1 的更正**：`Menu::get` **只扫本层**，而我们那 5 项在子菜单里。
/// 这条链"能不能改到、能不能读回"在纯逻辑单测里**证不了**（要真的 `AppHandle`），
/// 所以用本仓已有的取证范式：**正常启动 → 装完菜单 → 立刻做一遍 → 判据打印到 stderr
/// → 退出**。
///
/// # 判据（全部进退出码）
///
/// | | 判据 |
/// |---|---|
/// | A | `app.menu()` 有值（菜单真的装上了） |
/// | B | **顶层** `menu.get(id)` 对每一个菜单项都是 `None` —— §2.3 那条更正的**可执行形态** |
/// | C | 每一个菜单项都能在**某个一级子菜单**里 `sub.get(id)` 找到 |
/// | D | [`relabel_menu`] 换到另一种语言返回 `true` |
/// | E | 读回的**每一项文案**与 `relabel_plan(另一种语言)` 逐字相同 |
/// | F | 读回的**三个子菜单标题**同样对得上 |
/// | G | **再切回去**也成功且读得回（钉住"两种标题都认"——只认一种的话这里会红） |
///
/// # 边界
///
/// ⛔ **不建窗口**（调用点在 `win.build()` 之前）、⛔ 不 `activate`、⛔ 不合成按键；
/// 调用方在 macOS 上把它设成 `.prohibited`（`docs/kb/0025`）。
/// ⚠️ 它**只证明"改得到/读得回"**，⛔ 证不了"人眼看起来对不对"——那是人工/目视验收。
fn menu_probe(app: &tauri::AppHandle, startup: crate::lang::Lang) -> i32 {
    use crate::lang::Lang;
    let other = match startup {
        Lang::Zh => Lang::En,
        Lang::En => Lang::Zh,
    };
    let mut ok = true;
    // ⚠️ 每条判据一行，前缀统一 —— 脚本按标记取（⛔ 不按固定行号）。
    let mut say = |name: char, pass: bool, detail: String| {
        if !pass {
            ok = false;
        }
        eprintln!(
            "RMD_MENU_PROBE 判据={name} {} {detail}",
            if pass { "过" } else { "⛔未过" }
        );
    };

    let Some(menu) = app.menu() else {
        say('A', false, "`app.menu()` 是 None".to_string());
        eprintln!("RMD_MENU_PROBE 结论=失败");
        return 1;
    };
    say('A', true, "app.menu() 有值".to_string());

    let plan = relabel_plan(other);

    // —— B：顶层 get 必须全 None（§2.3 那条更正）——
    let top_hits: Vec<&str> = plan
        .items
        .iter()
        .filter(|(id, _)| menu.get(*id).is_some())
        .map(|(id, _)| *id)
        .collect();
    say(
        'B',
        top_hits.is_empty(),
        if top_hits.is_empty() {
            format!("顶层 get 对 {} 个菜单项都是 None", plan.items.len())
        } else {
            format!(
                "顶层 get 命中了 {top_hits:?} —— 与 §2.3 的更正不符（上游 `Menu::get` 变了吗？）"
            )
        },
    );

    let subs = match top_submenus(&menu) {
        Ok(v) => v,
        Err(e) => {
            say('C', false, format!("读一级菜单项失败：{e}"));
            eprintln!("RMD_MENU_PROBE 结论=失败");
            return 1;
        }
    };
    // —— C：每个 id 都落在某个一级子菜单里 ——
    let missing: Vec<&str> = plan
        .items
        .iter()
        .filter(|(id, _)| read_item_text(&subs, id).is_none())
        .map(|(id, _)| *id)
        .collect();
    say(
        'C',
        missing.is_empty(),
        if missing.is_empty() {
            format!("{} 个菜单项都在一级子菜单里找到了", plan.items.len())
        } else {
            format!("在子菜单里找不到：{missing:?}")
        },
    );

    // —— D/E/F：切到另一种语言，再逐项读回 ——
    let switched = relabel_menu(app, other);
    say(
        'D',
        switched,
        format!("relabel_menu({}) → {switched}", other.tag()),
    );
    // ⚠️ 无论如何都把读回做完：D 失败时 E/F 的**具体差异**比"D 红了"有用得多。
    let wrong: Vec<String> = plan
        .items
        .iter()
        .filter_map(|(id, want)| {
            let got = read_item_text(&subs, id);
            if got.as_deref() == Some(*want) {
                None
            } else {
                Some(format!("{id}: want={want:?} got={got:?}"))
            }
        })
        .collect();
    say(
        'E',
        wrong.is_empty(),
        if wrong.is_empty() {
            format!("{} 项文案读回逐字相符", plan.items.len())
        } else {
            wrong.join("; ")
        },
    );
    let bad_sub: Vec<String> = plan
        .submenus
        .iter()
        .filter_map(|(en, want)| {
            let got = find_submenu(&menu, submenu_titles(en)).and_then(|s| s.text().ok());
            if got.as_deref() == Some(*want) {
                None
            } else {
                Some(format!("{en}: want={want:?} got={got:?}"))
            }
        })
        .collect();
    say(
        'F',
        bad_sub.is_empty(),
        if bad_sub.is_empty() {
            format!("{} 个子菜单标题读回相符", plan.submenus.len())
        } else {
            bad_sub.join("; ")
        },
    );

    // —— G：再切回启动时那门语言 ——
    // ⚠️ 这一步**承重**：`find_submenu` 只认一种标题的实现会在这里红
    //    （第一次切成功了，子菜单已经改名，第二次就找不到了）。
    let back_plan = relabel_plan(startup);
    let back_ok = relabel_menu(app, startup);
    let back_wrong: Vec<String> = back_plan
        .items
        .iter()
        .filter_map(|(id, want)| {
            let got = read_item_text(&subs, id);
            (got.as_deref() != Some(*want)).then(|| format!("{id}: want={want:?} got={got:?}"))
        })
        .collect();
    say(
        'G',
        back_ok && back_wrong.is_empty(),
        if back_ok && back_wrong.is_empty() {
            format!("切回 {} 且读回相符", startup.tag())
        } else {
            format!("切回失败：relabel={back_ok} {:?}", back_wrong)
        },
    );

    eprintln!(
        "RMD_MENU_PROBE 结论={} 启动语言={} 试切={}",
        if ok { "全部通过" } else { "有未过项" },
        startup.tag(),
        other.tag()
    );
    if ok {
        0
    } else {
        1
    }
}

/// [`set_language`] 的应答（`design/0025` §2.4）。
///
/// ⚠️ 字段名是前端**逐字**取的那三个（`main.js` 的 `createLanguageDep`）。
#[derive(Debug, serde::Serialize)]
struct SetLanguageReply {
    /// 归一化之后的**偏好**：`"system"` / `"zh"` / `"en"`（⛔ 不是生效语言）。
    preference: &'static str,
    /// **生效**语言：`"zh"` / `"en"`——前端 `I18N.setLang(它)`。
    effective: &'static str,
    /// 菜单**真的**重贴成功了吗。⚠️ 失败时前端会说「将在重启后生效」，⛔ 不谎报。
    menu_updated: bool,
}

/// ⭐ **切换界面语言的唯一入口**（`design/0025` §2.4）。
///
/// # 三件事，顺序承重
///
/// ① **归一化并落盘**：拼错的串（`"fr"`、`""`）在这里被夹成 `"system"`
///    （`config::normalize_language`）——⛔ 不信任前端传来的串。
/// ② **算出生效语言**：显式档**不 spawn**；`system` 档走 `lang::system_language()`
///    那个 `OnceLock` 缓存（启动时问过一次，这里就是一次读）。
/// ③ **重贴菜单**：失败如实回报（见 [`relabel_menu`]）。
///
/// # 为什么必须是**一条**命令
///
/// 偏好、生效语言、菜单是**同一件事的三面**。拆成"写偏好"＋"读语言"＋"重贴菜单"
/// 三条命令，就会出现"写成功了、读回来是旧的"这类**中间态**——
/// 而用户看到的是"设置里选了英文，界面没变"（`design/0025` 评审 #6 那条）。
///
/// # 写盘失败怎么办（⚠️ 诚实边界）
///
/// **不返回 `Err`**：语言在本次运行里**已经生效**（内存里的 `Config` 与界面都改了），
/// 丢给前端一个 rejection 只会让"切换"这件事整个不发生，比"这次没存住"更糟。
/// ⇒ 写盘失败只**响亮记一条**（stderr ＋ 日志文件），代价是**重启后回到旧偏好**。
/// ⚠️ 这与 `set_appearance` 的口径**不同**（那条返回 `Err`，因为前端有 `dirty` 指示器
/// 可以承接它）；语言这一栏目前**没有**那样的指示器，⛔ 别在这里造一个只为一次失败的 UI。
#[tauri::command]
fn set_language(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    preference: String,
) -> SetLanguageReply {
    let (pref, effective, save_err) = state.with(|s| {
        s.config.set_language_preference(&preference);
        let pref = s.config.language_preference();
        // ⚠️ 取系统语言那一步在 `system` 档才发生，且有 200 ms 预算与 `OnceLock` 缓存
        //    （`crate::lang`）——这里**不会**卡住命令。
        let effective = crate::lang::effective(pref);
        let err = s.config.save(&s.config_path).err();
        (pref, effective, err)
    });
    if let Some(e) = save_err {
        diag_stderr!("⚠️ 界面语言存不下来（本次仍然生效，重启后回到旧偏好）：{e}");
        diag_file!(
            "⚠️ 界面语言存不下来 err_class={} err_len={}",
            logging::err_class(&e),
            e.to_string().len()
        );
    }

    let menu_updated = relabel_menu(&app, effective);
    diag!(
        "▶ set_language：偏好={pref} 生效={} 菜单重贴={}",
        effective.tag(),
        if menu_updated { "过" } else { "未过（前端会提示重启后生效）" }
    );
    SetLanguageReply {
        preference: pref,
        effective: effective.tag(),
        menu_updated,
    }
}

/// 送给前端的**一项**快捷键（`design/0010` §3 接口 1）。
///
/// ⚠️ 字段是 `snake_case` 的 Rust 名，前端按同名取——**这是刻意的**：
/// Tauri 的 `serde` 默认不改名，改名要靠 `#[serde(rename_all = "camelCase")]`，
/// 而本仓库**没有这一层**（`FrontendReport` 也是 snake_case）。
/// ⛔ 别只给这一个结构体加 rename——那会让前端出现两套命名习惯。
#[derive(Debug, serde::Serialize)]
struct ShortcutDto {
    id: String,
    /// 中文文案。⭐ `design/0025`：**两门语言一起送**，由前端按当前界面语言挑
    /// （`Settings.js::relabel()`）——⛔ 不在这里按 `Lang` 只送一门：
    /// 设置覆盖层**开着的时候**切语言是支持的，那时它手里那份表也得能立刻重画。
    label_zh: String,
    /// 英文文案。
    label_en: String,
    /// ⭐ **匹配用**的那一份（`muda` 语法，如 `"Cmd+O"`）——前端 `buildBindings` 要的就是它。
    ///
    /// ⚠️⚠️ **它必须送出去，⛔ 不能只送 `display`**（2026-10-14 实施时踩到）：
    /// 前端那台匹配器认的是 `Cmd` / `Ctrl` / `Shift` 这些**词**，
    /// 而 `display` 是给**人**看的 `⌘` / `⇧` **字形**——`MOD_NAMES` 里没有 `⌘`。
    /// ⇒ 只送 `display` 的话，`buildBindings` 会安安静静地**只挂上别名**
    /// （`Ctrl+O` 能开目录、`⌘O` 不能），而**页面上一切正常**：
    /// 菜单里有 `⌘O`、设置界面里写着 `⌘O`、按下去**什么也不发生**。
    /// ⚠️ 这正是 `INV-SET-01` 那句"设置里写的键与实际生效的键漂移"的**原型**，
    /// 也是 §2.1 ① 那张表里 `accel` 一列本来就该跟着表一起走的理由。
    accel: String,
    /// ⭐ 显示串（`⌘,` 这种），**由 `accel` 派生**（`INV-SET-01`）。
    /// ⚠️ 前端**不许**自己再拼一份——那样"菜单上写的"与"设置界面写的"会分叉。
    display: String,
    /// ⚠️ `"menu"` / `"web"`。前端据此决定**要不要**给这个 id 装键监听。
    /// ⛔ 前端不许用"我没有它的 handler"来反推 owner——那是两个维度。
    owner: String,
    /// ⭐ **前端还接受的别名**（`design/0010` §2.1 ① 那张表的第四列）。
    ///
    /// # 为什么别名必须**从这里**发过去，⛔ 不是前端自己写一张
    ///
    /// ⚠️ 别名集**是设计的一部分**（§2.1 ① 末）：「设置界面里写 `⌘-`、可我按 `⇧⌘-`
    /// 也生效」这件事，只有在**别名与 accel 同源**时才说得清。前端自己写一份
    /// ⇒ 又是两份会漂移的数据，而且 §7 的 JS 单测**明令**前端源码里不许出现
    /// `'-'` / `'='` / `'b'` 这类按键字面量（那一半靠 grep 源码文本来测）。
    ///
    /// ⭐ 所以分工是：**数据**在后端（这里），**匹配算法**在前端（`keymap.js`
    /// 的 `matchAccel`，只有一份）。§2.1 ① 说的"匹配规则只有一份"指的是后者。
    ///
    /// ⚠️ 也别把它们想成"等价写法"：`⇧=` 按出来的是 `+` 而**不是** `=`，
    /// 所以 `Cmd++` 是**另一个物理按键**，不是 `Cmd+=` 的排版变体。
    aliases: Vec<String>,
}

/// ⭐ **唯一的事实来源，送到前端**（`INV-SET-01`）。
///
/// # 它送出去的是什么
///
/// ① **全部**动作（含 `Owner::Menu` 的）——设置界面要**列全**，
///    而且 `⌘B` / `⌘,` 也必须在"设置界面里能查到它属于哪个动作"（§7 步骤 8b）。
/// ② ⭐ **含 `aliases`**（见下面那个字段的说明）：别名与 `accel` **同源**，
///    前端那份匹配器只管**算法**、不管数据。⛔ 唯一不送的是 `split_accel` 那种
///    内部派生过程——显示串是后端算好一起给的（`display`）。
///
/// ⚠️ 前端**必须**拿这份表跑一次自检（§2.1 ② 的第三层）：
///    逐项查 `ACTIONS` 里有没有对应 handler，**缺的和多的都要报**。
///    缺 = 表里有、代码忘了接；多 = 代码里接了、表里没有（那就是**没有名字的键**）。
#[tauri::command]
fn get_shortcuts() -> Vec<ShortcutDto> {
    shortcuts_dto()
}

/// [`get_shortcuts`] 的**本体**（同一个函数两份调用点，⛔ 不是两份实现）。
fn shortcuts_dto() -> Vec<ShortcutDto> {
    SHORTCUTS
        .iter()
        .map(|s| ShortcutDto {
            id: s.id.to_string(),
            label_zh: s.label_zh.to_string(),
            label_en: s.label_en.to_string(),
            accel: s.accel.to_string(),
            display: display(s.accel),
            owner: match s.owner {
                Owner::Menu => "menu".to_string(),
                Owner::Web => "web".to_string(),
            },
            aliases: s.aliases.iter().map(|a| a.to_string()).collect(),
        })
        .collect()
}

/// ⭐ **真的**键位表，喂给 `design/0047` 的离屏探针（`make probe-live-block` 的 Stage A）。
///
/// ⚠️ 存在的唯一理由是：纵向链路（§7.1 `0h`）要按 `⌘S`，而探针的假后端若自己写一份键位，
/// 那张表会随产品漂移——漂移后的表现是"某个键按不动"，与**产品没接线**长得一模一样。
/// ⇒ 只此一份，由真表序列化出去（⛔ 探针里不许出现按键字面量）。
pub(crate) fn shortcuts_json() -> serde_json::Value {
    serde_json::to_value(shortcuts_dto()).expect("键位表序列化失败")
}

// ─────────────────────────────────────────────────────────────────────────
// 应用内安装命令行工具（`design/0033`）
// ─────────────────────────────────────────────────────────────────────────
//
// ⭐ 这两项**没有快捷键** ⇒ 不在 `SHORTCUTS` 里、也不进设置界面的键位表（决定 12）。
// ⚠️ 也正因为不在表里，`handle_menu_event` 开头那句"不在表里就 return"会**先把它们挡掉**
//    ⇒ 那两个 id 必须在**早退之前**认（见 `handle_menu_event` 的第一段）。
//
// ⛔ **零新增 `#[tauri::command]`**（决定 5）：对话框由 Rust 侧弹、结果走
//    `emit("rmd://cli-tool")` 到状态条。⇒ `build.rs` / `capabilities/` 一处都不用动。
//
// ⚠️ 判据全在 `crate::cli_tool`（默认构建里也编进去、也有单测）；
//    这里只做三件"需要窗口/线程/对话框"的事：问落点、挪到后台、把结果发出去。

/// `$HOME`。⚠️ 只读环境变量，⛔ 不调 `getpwuid`——GUI 进程里它恒有值（`launchd` 给），
/// 多一条系统调用只多一种失败面。拿不到 ⇒ `None`，调用方**如实报失败**，⛔ 不猜。
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

/// 落点框的三段文案（`design/0033` §2.2 ①、§2.3 ①）。
///
/// ⚠️ **全是常量**，两门语言各一份。⛔ **不许把路径拼进句子再翻译**——
/// 句子里的两个目录名是**给用户看的说明**，不是数据；真正的路径由 `cli_tool` 算。
/// ⚠️ 文案口径（`INV-CLI-06`）：⛔ 不写"所有终端"、⛔ 不承诺"一定能用"，
/// 只说"默认配置的终端一般能找到"，最终以**装后探测**为准。
///
/// ⚠️⚠️ **排版是按 `NSAlert` 的度量倒推的**（2026-10-22 用户报了"中英宽度差得远、按钮被挤成三行"）：
/// ① 每条说明**手动断成两行**（`—— 代价` / `—— 条件`），两个语种的最长行都落在 ~50 西文字符
///    或 ~20 汉字附近 ⇒ 弹窗宽度接近，按钮才排得进**一行**（AppKit 放不下就竖排，那才是"乱"的来源）；
/// ② ⛔ **不解释内部实现**：原文那段"装完会起一个终端探测一次"是给开发者看的，
///    探测结论由**装完之后的状态条**说（`clitool.js`），不占弹窗；
/// ③ 按钮只留**路径 ＋ 一行代价**：路径本身是判据（`cli_tool_install` 按标题文本分派），
///    代价（要不要密码）必须在**点击那一刻**看得见（§2.2 H：⛔ 不让用户被突然的密码框吓一跳）。
struct LocationDialog {
    title: &'static str,
    message: &'static str,
    local: &'static str,
    system: &'static str,
    cancel: &'static str,
}

fn location_dialog(lang: crate::lang::Lang) -> LocationDialog {
    match lang {
        crate::lang::Lang::Zh => LocationDialog {
            title: "安装命令行工具",
            message: "选择 rmd 命令的安装位置。\n\n\
                      ~/.local/bin —— 不需要密码。\n\
                      仅当该目录已在 PATH 里时，新终端才找得到。\n\n\
                      /usr/local/bin —— 需要管理员密码。\n\
                      默认配置的终端一般找得到。",
            local: "~/.local/bin",
            system: "/usr/local/bin（需密码）",
            cancel: "取消",
        },
        crate::lang::Lang::En => LocationDialog {
            title: "Install Command Line Tool",
            message: "Choose where to install the rmd command.\n\n\
                      ~/.local/bin — no password.\n\
                      Works only if this folder is already in your PATH.\n\n\
                      /usr/local/bin — requires an admin password.\n\
                      Terminals with default settings usually find it.",
            local: "~/.local/bin",
            system: "/usr/local/bin (admin)",
            cancel: "Cancel",
        },
    }
}

/// 当前生效的界面语言。⚠️ 拿不到状态（还没 `manage`）时按系统语言算一次，
/// ⛔ 不硬编码中文——那会让英文用户在极少数时序下看到一个中文框。
fn ui_language(app: &tauri::AppHandle) -> crate::lang::Lang {
    use tauri::Manager;
    app.try_state::<AppState>()
        .map(|s| s.with(|s| crate::lang::effective(s.config.language_preference())))
        .unwrap_or_else(|| crate::lang::effective("system"))
}

/// 「安装」：先弹原生框问落点（`design/0033` 决定 2）。
///
/// ⚠️ **判据是按钮文本**，⛔ 不是返回值顺序：`rfd` 的 macOS 后端把
/// `NSAlertFirstButtonReturn/Second/Third` 映射回**各自的标题**
/// （`tauri-plugin-dialog 2.7.3` → `rfd 0.16/0.17`），而 AppKit 会按系统习惯
/// **重排按钮的视觉位置** ⇒ 按"第几个"猜落点会在某些系统设置下装错地方。
fn cli_tool_install(app: &tauri::AppHandle) {
    let d = location_dialog(ui_language(app));
    let (local, system, cancel) =
        (d.local.to_string(), d.system.to_string(), d.cancel.to_string());
    // ⚠️ 两个副本：一个进按钮、一个进判据（`buttons` 把 String 拿走了）。
    let (local_cmp, system_cmp) = (local.clone(), system.clone());
    let app2 = app.clone();
    app.dialog()
        .message(d.message)
        .title(d.title)
        .buttons(MessageDialogButtons::YesNoCancelCustom(local, system, cancel))
        .show_with_result(move |res| {
            let loc = match res {
                MessageDialogResult::Custom(s) if s == local_cmp => Some(cli_tool::Location::Local),
                MessageDialogResult::Custom(s) if s == system_cmp => {
                    Some(cli_tool::Location::System)
                }
                _ => None, // 「取消」（或任何系统给的默认值）⇒ 什么都不做
            };
            match loc {
                Some(l) => cli_tool_run(&app2, Some(l)),
                None => diag!("▶ 命令行工具：用户在落点框点了取消（未写盘）"),
            }
        });
}

/// 跑一次安装（`loc = Some`）或卸载（`None`），**在后台线程**。
///
/// ⚠️ **必须离开主线程**：探测最坏等 3 s，`/usr/local/bin` 那条还要**等人输密码**
/// （§7.3 ⑨ 的观察点就是"点安装到状态条更新之间界面不卡"）。
fn cli_tool_run(app: &tauri::AppHandle, loc: Option<cli_tool::Location>) {
    let action = if loc.is_some() { "install" } else { "uninstall" };
    let Some(home) = home_dir() else {
        diag_stderr!("⛔ 命令行工具：$HOME 不可用，未写盘");
        // ⚠️ 线上形状恒为 `{action, candidates[], verify}`（`INV-CLI-16`）⇒
        //    拿不到 HOME 也要发**一条失败**，⛔ 不发空数组（前端会以为"什么都没发生"）。
        emit_cli_tool(
            app,
            &cli_tool::Payload {
                action,
                candidates: vec![cli_tool::Candidate {
                    path: "~/.local/bin/rmd".to_string(),
                    result: "failed",
                    detail: Some("无法确定主目录（$HOME 不可用）".to_string()),
                }],
                verify: None,
            },
        );
        return;
    };

    let shell = cli_tool::current_shell();
    let exe = std::env::current_exe();
    let app2 = app.clone();
    std::thread::spawn(move || {
        let payload = match loc {
            Some(loc) => match &exe {
                Ok(exe) => cli_tool::install(&home, loc, exe, shell.as_deref()),
                Err(e) => cli_tool::Payload {
                    action: "install",
                    candidates: vec![cli_tool::Candidate {
                        path: loc.dir(&home).join("rmd").display().to_string(),
                        result: "failed",
                        detail: Some(format!("无法确定当前可执行文件：{e}")),
                    }],
                    verify: None,
                },
            },
            None => cli_tool::uninstall(&home),
        };
        log_cli_tool(&payload);
        emit_cli_tool(&app2, &payload);
    });
}

/// 结果 → 前端的**唯一**出口。
///
/// ⚠️ 失败要**响亮**（`.agent/spec.md` 纪律 6）：静默失败的表现是
/// "点了菜单，状态条一个字都不变"，而 stderr 里什么都没有。
fn emit_cli_tool(app: &tauri::AppHandle, payload: &cli_tool::Payload) {
    use tauri::Emitter;
    if let Err(e) = app.emit("rmd://cli-tool", payload.clone()) {
        diag_stderr!("⛔ 命令行工具结果发不到前端：{e}");
        diag_file!(
            "⛔ 命令行工具结果转发失败 err_class={} err_len={}",
            logging::err_class(&e),
            e.to_string().len()
        );
    }
}

/// 落一行日志。⚠️ 只落**结论与路径**（`§4`：路径本来就可以贴，排障离不开它）；
/// ⛔ 不落正文（`INV-LOG-01` 管的是文档内容，这里本来也没有）。
fn log_cli_tool(p: &cli_tool::Payload) {
    let results: Vec<&str> = p.candidates.iter().map(|c| c.result).collect();
    diag!(
        "▶ 命令行工具 action={} 结果={:?} verify={}",
        p.action,
        results,
        p.verify.as_ref().map(|v| v.state).unwrap_or("null")
    );
}

/// ⭐ 菜单事件 → 前端（`design/0010` §2.1 ⑧）。
///
/// # 为什么必须自己转发
///
/// ⚠️ **菜单点击不会自动到达前端**：`tauri-2.12.3/src/manager/menu.rs` 全文
/// **零** `emit`（`kb/0016` §5 的 grep）。菜单是 Rust 建的，事件也只到 Rust。
/// 所以我们自己建这条通道：`on_menu_event` → `emit("rmd://menu", id)` →
/// 前端 `event.listen`。⚠️ 那条 `emit` 走的是 **core 插件命令**，受 ACL 管
/// （`core:event:allow-listen`）——那是步骤 0 要真机验的第一件事。
///
/// # 为什么要把"不认识"的 id 喊出来
///
/// `⌘Q` / `⌘W` / Full Screen 这些**预定义项**的 id 也会走这里
/// （它们是 Tauri 自己的 `MenuId`），它们**本来就不该**被转发。
/// 所以判据是"**在不在本表里**"，⛔ 不是"是不是空的"：
/// 在表里的一定转发；不在表里的**静默忽略**（那是系统项，前端不该知道）。
/// ⚠️ 但表里那一项若**前端没有 handler**，是前端的自检要报的（`INV-SET-02`②）——
/// 后端这里**不替它兜底**，否则那处不一致就永远看不见。
fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
    // ⭐ `design/0033`：应用子菜单那两项**不在 `SHORTCUTS` 里**（它们没有快捷键，
    //    决定 12）⇒ 必须在下面那句早退**之前**认，否则点下去什么都不发生。
    // ⚠️ 它们**不转发给前端**：动作整个在后端（对话框 + 写盘 + 探测），
    //    前端只收结果事件 `rmd://cli-tool`。
    match id {
        APP_MENU_INSTALL_ID => {
            cli_tool_install(app);
            return;
        }
        APP_MENU_UNINSTALL_ID => {
            cli_tool_run(app, None);
            return;
        }
        _ => {}
    }
    if shortcut(id).is_none() {
        return;
    }
    use tauri::Emitter;
    // ⚠️ 失败要**响亮**（`.agent/spec.md` 纪律 6 的同一条精神）：
    //    静默失败的表现是"菜单点下去没反应、stderr 里什么都没有"。
    if let Err(e) = app.emit("rmd://menu", id) {
        diag_stderr!("⛔ 菜单事件转发失败（{id}）：{e}");
        diag_file!(
            "⛔ 菜单事件转发失败 id={id} err_class={} err_len={}",
            logging::err_class(&e),
            e.to_string().len()
        );
    }
}

/// 起窗口。`start` 来自 argv（**文件、目录，或什么都没有**）。
///
/// ⭐ `None` = **裸跑**（`rmd` 不带参数）⇒ 空会话，界面上只给"打开目录 / 打开文件"
/// 两个入口，外加**上次打开的目录**这个提示（§2.1.1 第 4 条）。
/// ⚠️ 那条提示要成立，就必须允许"没有参数也能起窗口"——否则 `last_directory`
/// 记了也没人读得到（这正是 2026-10-13 实施时发现的一处漏做）。
///
/// 返回进程退出码（与 `cli::run` 的约定一致）。
/// 当前可执行文件（路径**可信**：排障必需，§4 已写明"贴日志=公开路径"）。
fn exe_display() -> String {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "未知".to_string())
}

/// `design/0015` 的 `.app` 布局下，向上两级能读到 `Contents/Resources/build-id.txt`；
/// 裸二进制（`~/.local/bin/rmd`）没有 ⇒「未知」。
fn build_id_display() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| logging::build_id_for_exe(&p))
        .unwrap_or_else(|| "未知".to_string())
}

// ─────────────────────────────────────────────────────────────────────────
// 命令行静默启动（`design/0022`）
// ─────────────────────────────────────────────────────────────────────────
//
// 终端里敲 `rmd <文件|目录>` 时，终端里那个进程**不**应该是 GUI 本体：
// 父进程只做一次预检，然后把同一份二进制用同样的 argv 再拉一遍、自己立刻退出。
//
// ⚠️ 判据是 **stdout 与 stderr 都是终端**（`INV-CLI-04`）。⛔ 不是"任一是终端"——
//    那会把 `rmd a.md 2>log` 的诊断静默丢掉（评审 R4）。
// ⚠️ 退出码 0 **只表示子进程创建成功**（`INV-CLI-05`），⛔ 不表示窗口已开。
// ⚠️ `process_group(0)` 只换进程组、**不换会话** ⇒ "关终端后继续运行"是**未验证能力**
//    （`INV-CLI-08`）；⛔ 别把它写成已保证。

/// 分离判定的原因。⚠️ 变体的**书写顺序**就是短路顺序（`INV-CLI-07`），⛔ 别重排。
///
/// ⚠️ 原因要进日志：用户排障时唯一能看见"为什么没分离"的地方就是那一行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DetachDecision {
    /// `RMD_DETACHED` 非空 —— 我就是父进程拉起的那个子进程。
    AlreadyChild,
    /// `RMD_FOREGROUND` 非空 —— 显式要前台（排障/`make open DEV=1`）。
    ForegroundEnv,
    /// `RMD_SMOKE` / `RMD_MEASURE` / `RMD_PANIC_TEST` / `RMD_MENU_PROBE` 任一非空 —— 有人要看诊断。
    DiagEnv,
    /// stdout 与 stderr **不都是**终端 ⇒ 动了 fd 就说明要看输出。
    NoTty,
    /// ⭐ 只有这一支会拉起子进程。
    Detach,
}

impl DetachDecision {
    fn reason(self) -> &'static str {
        match self {
            DetachDecision::AlreadyChild => "RMD_DETACHED：已是被分离出来的子进程",
            DetachDecision::ForegroundEnv => "RMD_FOREGROUND：显式要前台",
            DetachDecision::DiagEnv => {
                "诊断环境变量（RMD_SMOKE/RMD_MEASURE/RMD_PANIC_TEST/RMD_MENU_PROBE）"
            }
            DetachDecision::NoTty => "stdout 与 stderr 不都是终端",
            DetachDecision::Detach => "两个 fd 都是终端",
        }
    }
}

/// 纯函数：判定只看入参，⛔ 不读 env、不碰 fd ⇒ 四象限可以在单测里逐格钉住。
fn decide(
    detached: bool,
    foreground: bool,
    diag_env: bool,
    stdout_tty: bool,
    stderr_tty: bool,
) -> DetachDecision {
    if detached {
        return DetachDecision::AlreadyChild;
    }
    if foreground {
        return DetachDecision::ForegroundEnv;
    }
    if diag_env {
        return DetachDecision::DiagEnv;
    }
    if !(stdout_tty && stderr_tty) {
        return DetachDecision::NoTty;
    }
    DetachDecision::Detach
}

/// 环境变量"算数"的判据 = **非空**。⚠️ `RMD_FOREGROUND=`（空串）等于没设，
/// 与 `config` 里 `external_editor` 的处理一致（⛔ 别改成"只要存在"）。
fn env_set(key: &str) -> bool {
    std::env::var_os(key).map(|v| !v.is_empty()).unwrap_or(false)
}

fn detach_decision() -> DetachDecision {
    let diag_env = ["RMD_SMOKE", "RMD_MEASURE", "RMD_PANIC_TEST", "RMD_MENU_PROBE"]
        .iter()
        .any(|k| env_set(k));
    decide(
        env_set("RMD_DETACHED"),
        env_set("RMD_FOREGROUND"),
        diag_env,
        std::io::stdout().is_terminal(),
        std::io::stderr().is_terminal(),
    )
}

/// 给子进程的那份 argv ＋ env。⚠️ 单独成结构，是为了让"传了什么"能**不启动进程**就断言。
struct ChildSpec {
    exe: PathBuf,
    args: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
}

/// 参数**逐字节**原样转发：丢 argv[0]、丢系统 `-psn_…`，其余一个不动
/// （空格 / 中文 / 非 UTF-8 都在 `OsString` 里，⛔ 不过 shell、⛔ 不重新拼路径）。
fn child_args(raw: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    raw.into_iter()
        .skip(1)
        .filter(|a| !crate::cli::is_system_arg(a))
        .collect()
}

fn child_spec() -> Option<ChildSpec> {
    Some(ChildSpec {
        // ⚠️ 用 `current_exe()`，⛔ 不用 `argv[0]`：经 `PATH` 调起时 argv[0] 可能只是 `rmd`。
        //    实测（2026-10-21）它会**保留符号链接路径**，不解析最后一段。
        exe: std::env::current_exe().ok()?,
        args: child_args(std::env::args_os()),
        env: vec![(OsString::from("RMD_DETACHED"), OsString::from("1"))],
    })
}

/// 真拉起子进程。⚠️ 三个 stdio 全 `null`（终端上不留任何东西）＋ 新进程组。
fn spawn_detached(spec: &ChildSpec) -> std::io::Result<()> {
    let mut cmd = Command::new(&spec.exe);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // ⚠️ `design/0022` §2.7：只换**进程组**，⛔ 不换会话；"关终端后继续运行"未验证。
        .process_group(0);
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    cmd.spawn().map(|_| ())
}

/// 分离的**编排**。三段（判定 / 预检 / 拉起）都可从外面递进来 ⇒ 不用起窗口就能测。
///
/// 返回 `Some(code)` ⇒ 父进程直接以该码退出；`None` ⇒ **回落到今天那条前台路径**。
/// ⚠️ 顺序是承重的：预检**必须**在拉起之前，否则"路径打错"会变成"命令成功了、什么都没发生"。
fn detach_self_with<P, S>(
    decision: DetachDecision,
    start: Option<&Path>,
    preflight: P,
    spawn: S,
) -> Option<i32>
where
    P: FnOnce(Option<&Path>) -> Result<(), String>,
    S: FnOnce(&ChildSpec) -> std::io::Result<()>,
{
    if decision != DetachDecision::Detach {
        return None;
    }
    if let Err(e) = preflight(start) {
        // ⚠️ 这一行**不会**进日志（此刻日志还没初始化）——如实：终端是它唯一的出口。
        eprintln!("⛔ {e}");
        return Some(2);
    }
    let Some(spec) = child_spec() else {
        eprintln!("⚠️ 取不到自身可执行文件路径，按前台启动");
        return None;
    };
    match spawn(&spec) {
        // ⭐ 0 的语义 = **子进程已创建**（`INV-CLI-05`）；⛔ 不表示窗口出现了。
        Ok(()) => Some(0),
        // ⚠️ 诚实回退：拉起失败就自己当前台用，⛔ 不静默成功。
        Err(e) => {
            eprintln!("⚠️ 后台启动失败（{e}），按前台启动");
            None
        }
    }
}

/// 日志不可用时给终端留一行的兜底（`design/0022` §2.5①）。
///
/// ⚠️ 只在**被分离的子进程**里触发（前台时 stderr 本来就在终端，⛔ 不重复打）。
/// ⚠️ 失败就放弃（fail-open）：没有控制终端时 `/dev/tty` 本来就打不开。
/// ⚠️ 它**本身无法自动验证**（要真终端）⇒ `design/0022` §7.4 第 7 条是人工项。
fn best_effort_tty(msg: &str) {
    use std::io::Write;
    if !env_set("RMD_DETACHED") {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open("/dev/tty") {
        let _ = writeln!(f, "rmd：{msg}");
    }
}

pub fn run(start: Option<PathBuf>) -> i32 {
    // ⭐ `design/0022`：终端里敲 `rmd <路径>` 时先判要不要分离。
    // ⚠️ 必须排在 `generate_context!()` **之前**——那一步 panic 时日志还没起来，
    //    而后台子进程的 stderr 是 null ⇒ 什么都看不见（§2.5 已如实登记，⛔ 别假装能补）。
    let decision = detach_decision();
    if let Some(code) = detach_self_with(
        decision,
        start.as_deref(),
        |p| match p {
            Some(p) => check_startup_path(p),
            None => Ok(()),
        },
        spawn_detached,
    ) {
        return code;
    }

    // ⭐ `design/0016` §2.1 ③：日志初始化必须在**任何**启动分支之前——
    //    "双击没反应"最常见的形态就是启动路径不存在，那一行必须落盘。
    // ⚠️ `generate_context!()` **只调一次**：下面 `.build()` 用同一个。
    let context = tauri::generate_context!();
    let log_dir = logging::default_dir(context.config().identifier.as_str());
    let logging_ok = match &log_dir {
        Some(d) => match logging::init(d) {
            Ok(()) => true,
            Err(e) => {
                // ⚠️ fail-open：只提示，不改变退出码、不阻塞启动（`INV-LOG-02`）。
                diag_stderr!("⚠️ 日志目录建不了（{}）：{e}", d.display());
                // ⭐ `design/0022` §2.5①：分离出来的子进程 stderr 是 null ⇒
                //    这一整段诊断（以及此后所有只写 stderr 的 `diag!`）都会被吞。
                //    唯一能补的是一条 `/dev/tty`。⚠️ 补不了的（`generate_context!()` 的 panic）
                //    已如实登记在 `INV-CLI-02` 里，⛔ 别在这里假装兜住了。
                best_effort_tty(&format!(
                    "日志目录建不了（{}）：{e} —— 本次诊断无处可写，请用 RMD_FOREGROUND=1 重试",
                    d.display()
                ));
                false
            }
        },
        None => {
            // ⚠️ 同样的盲区，原因不同：拿不到 identifier ⇒ 根本没有日志目录。
            best_effort_tty(
                "拿不到日志目录（identifier 不可用）—— 本次诊断无处可写，请用 RMD_FOREGROUND=1 重试",
            );
            false
        }
    };
    if logging_ok {
        logging::install_panic_hook();
    }
    diag!(
        "▶ rmd 启动 version={} exe={} build={}",
        env!("CARGO_PKG_VERSION"),
        exe_display(),
        build_id_display()
    );
    // ⭐ `design/0022` §2.2：**为什么没分离**必须可查——分离与否只影响"终端是否被占住"，
    //    页面上一点差别都没有，用户排障时唯一能看的就是这一行。
    if decision != DetachDecision::Detach {
        diag!("▶ rmd 分离判定：不分离（{}）", decision.reason());
    }
    // ⚠️ 验证钩子（`design/0016` §7.2 第 4/6 条）：与 `RMD_SMOKE` / `RMD_MEASURE` 同类。
    //    ⛔ 不是产品功能；放在建窗口之前 ⇒ 不弹窗、不抢焦点。
    if logging_ok {
        if let Ok(v) = std::env::var("RMD_PANIC_TEST") {
            if !v.is_empty() {
                panic!("RMD_PANIC_TEST {v}");
            }
        }
    }

    // ⚠️ 路径检查放在起窗口**之前**：窗口已经弹出来了再报"文件不存在"，
    //    用户看到的是一个空白窗口加一行 stderr，很难判断发生了什么。
    if let Some(path) = &start {
        if let Err(e) = check_startup_path(path) {
            diag_stderr!("⛔ {e}");
            return 2;
        }
        diag!("▶ rmd 打开 {}", path.display());
    } else {
        diag!("▶ rmd 启动（没有参数：空会话，等用户选）");
    }

    let result = tauri::Builder::default()
        // ⚠️ 对话框插件：**只**由 Rust 侧的授权命令使用。
        //    ⛔ 不给前端 `dialog:*` 权限——前端的对话框结果就是一个
        //    可伪造的路径字符串（`INV-FS-04`）。
        .plugin(tauri_plugin_dialog::init())
        // ⭐ 菜单事件 → 前端（`design/0010` §2.1 ⑧）。⚠️ 挂**一次**、在 builder 上，
        //    ⛔ 不在 setup 里按窗口挂——菜单是 app 级的，窗口可以不止一个。
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .setup(move |app| {
            use tauri::Manager;

            // ⭐ `design/0016` §2.1 ③：拿 Tauri 自己的 `app_log_dir()` 与已初始化的目录**对一次**。
            //    ⚠️ 只对账、**不切换**——初始化早于 Builder，那时拿不到 AppHandle。
            //    这条是 `docs/kb/0024` 那条路径的运行时自证（两边都按同一 identifier 推导）。
            if let Some(expected) = logging::dir() {
                match app.path().app_log_dir() {
                    Ok(actual) => {
                        if actual != expected {
                            diag!(
                                "⚠️ 日志目录与 app_log_dir() 不一致：init={} tauri={}",
                                expected.display(),
                                actual.display()
                            );
                        }
                    }
                    Err(e) => diag!(
                        "⚠️ 取不到 app_log_dir（err_class={}）：继续用 init 的 {}",
                        logging::err_class(&e),
                        expected.display()
                    ),
                }
            }
            let config_path = app
                .path()
                .app_config_dir()
                .map(|d| d.join(config::FILE_NAME))
                .unwrap_or_else(|_| PathBuf::from(config::FILE_NAME));
            // ⚠️ `mut`：目录模式的启动参数要顺手更新 `last_directory`（§2.1.1 第 4 条）
            let mut cfg = Config::load(&config_path);

            // ⭐ 启动参数 = 一次授权（与选择器同等效力，见 `commands::fs::authorize_startup`）
            let mut grants = SessionGrants::new();
            let (mode, startup_document) = match &start {
                Some(path) => match fs_cmd::authorize_startup(&mut grants, path) {
                    Ok((Mode::Directory, real)) => {
                        // ⭐ 记进"上次打开的目录"（§2.1.1 第 4 条）：
                        //    用 `rmd <目录>` 打开与用选择器打开，对用户是同一件事。
                        //    ⛔ 只记**路径**，⛔ 不记授权（`INV-FS-03`）。
                        cfg.set_last_directory(&real);
                        if let Err(e) = cfg.save(&config_path) {
                            diag_stderr!("⚠️ last_directory 存不下来：{e}");
                            diag_file!("⚠️ last_directory 存不下来 err_class={} err_len={}", logging::err_class(&e), e.to_string().len());
                        }
                        // ⚠️ 目录模式下**不**预设启动文档：§2.1 明确要求
                        //    "⛔ 不自动打开第一个文件"。
                        (Mode::Directory, None)
                    }
                    // ⚠️ 存**规范化后的**路径：未授权态要把它的父目录显示出来（§2.1.4），
                    //    而那个字面必须与 `open_document` 之后算出来的一致。
                    Ok((Mode::SingleFile, real)) => (Mode::SingleFile, Some(real)),
                    // ⛔ `authorize_startup` 只会返回那两种模式
                    Ok((Mode::Empty, _)) => unreachable!("authorize_startup 不产生空会话"),
                    Err(e) => {
                        diag_stderr!("⛔ 启动路径不能授权：{e}");
                        diag_file!(
                            "⛔ 启动路径不能授权 err_class={} err_len={}",
                            logging::err_class(&e),
                            e.to_string().len()
                        );
                        app.handle().exit(2);
                        return Ok(());
                    }
                },
                // ⭐ 裸跑：空会话。没有授权、没有文档、没有树
                None => (Mode::Empty, None),
            };

            diag!(
                "▶ 会话：模式={} 授权目录 {} 个／文件 {} 个｜代次 {}｜上次目录 {}｜配置 {}",
                mode.as_str(),
                grants.roots().len(),
                grants.files().len(),
                grants.root_generation(),
                cfg.last_directory.as_deref().unwrap_or("（无）"),
                config_path.display()
            );

            app.manage(AppState::new(Session {
                grants,
                tree: TreeCache::new(),
                config: cfg,
                config_path,
                doc_dir: None,
                startup_document,
                // ⭐ `design/0015`：Apple Event 的待打开队列。**启动时是空的**——
                //    ⚠️ 启动 argv 那条路**不进队列**（它走 `startup_document`，前端引导时
                //    自己开）。两个入口各走各的通道，但共用同一个授权函数（`INV-APP-02`）。
                pending_opens: std::collections::VecDeque::new(),
                // ⚠️ 初值全零：还没渲染过任何东西。`report_status` 会把它打出来，
                //    「零」在那里是**正确的**（空会话就是零个公式），⛔ 不是缺省填充。
                last_render_stats: Default::default(),
                // ⭐ 监视与当前文档（`design/0006`）：**启动时都没有**。
                //    ⚠️ 它们由 `watch_document` 建立（§2.1 ②：监视只在一次
                //    **成功的读取**之后建立）——⛔ 别在这里预置成启动参数里那份文档，
                //    那会造出一个"后端以为在监视、而前端还没读过它"的态。
                current_document: None,
                // ⭐ 打开会话号（`design/0017` §2.2 ①）：启动时还没打开过任何东西，**从 0 开始**。
                //    ⚠️ 只有 `open_document` 第三段提交会 +1（⛔ 重载不算）。
                doc_seq: 0,
                // ⭐ 编辑态那一组（`design/0012`）：**启动时都没有**。
                //    ⚠️ 启动路径上没有任何密钥/写授权行为，这是同一件事的另一面
                //    （与"零密钥启动"同源的取向）。⚠️ 尤其 `baseline_bytes` 与
                //    `edit_target` 是**成对**的：`begin_edit` 一起置，
                //    `end_edit` / 换文档 / 摘监视一起清（⛔ 别在这里预置其中一个）。
                edit_target: None,
                self_write: None,
                save_inflight: None,
                baseline_bytes: None,
                watch: None,
                watch_seq: 0,
                latest_doc_req: 0,
                // ⭐ 文件名搜索的索引（`design/0009`）：启动时**没有**——
                //    它由第一次 `search_files` 建（§2.1 ② 的重建时机表）。
                //    ⛔ 别在这里预建：那是一次没人要的启动期全树遍历。
                index: None,
            index_ticket: 0,
            index_rev: 0,
                // ⭐ 目录监视（`design/0034`）：**启动时还没建**——
                //    它在 `manage` 之后由下面那次 `restart_tree_watch` 建立
                //    （⚠️ 建它在 `manage` 之前是不可能的：它要读 `AppState` 里的授权根）。
                tree_watch: None,
                // ⭐ 根范围的磁盘状态（`design/0050`）：**启动时全零**——
                //    此刻还没有任何授权根，也就没有"盘上的观测"这回事。
                //    ⚠️ `reset_roots()` 不必在这里调：全零本来就是"没有根"的样子
                //    （它只在**换根**时用来把上一个根的账清掉）。
                disk: crate::disk::DiskState::new(),
                reconcile_inflight: false,
                // ⚠️ `u64::MAX` = "还没发过任何一份"：第一份视图永远发得出去。
                last_disk_rev: u64::MAX,
                // ⚠️ 这里**不传 mode**：`Session::mode()` 从 grants / 文档推导
                //    （上面那个 `mode` 只用来决定"要不要记 last_directory"）。
            }));

            // ⭐ 启动 argv 若是**目录**，从这里开始盯它（`design/0034` §2.1 A 的生命周期）。
            //    ⚠️ 只补**启动期**这一次：`choose_directory`（换根）与 `close_directory`
            //    （收回）各自在改动授权之后调用同一个 `restart_tree_watch`；
            //    Apple Event 那条路（`handle_open_urls`）**只接文件、⛔ 不动 roots**，
            //    所以那边不需要（它若打开外部文件，`close_directory` 会自己重建一次）。
            //    ⚠️ 没有授权根时它只打一行日志就返回，⛔ 不是错误。
            fs_cmd::restart_tree_watch(app.handle(), &app.state::<AppState>());

            // ⭐ 冷启动时到达的 Apple Event（见 `EARLY_OPENS`）：`manage` 之后立刻
            //    走**同一条**授权 + 入队路径。⚠️ 放在建窗口**之前** —— 前端引导的
            //    第 4.5 步会主动 `take_pending_open`，先入队就不会漏。
            //    ⚠️ 此刻唤醒事件多半发不出去（监听还没注册），那**不致命**：
            //    队列还在，引导阶段会取走（`main.js` 的 4.5 步）。
            #[cfg(target_os = "macos")]
            {
                let early: Vec<std::path::PathBuf> = EARLY_OPENS
                    .lock()
                    .map(|mut q| std::mem::take(&mut *q))
                    .unwrap_or_default();
                for path in early {
                    match tauri::Url::from_file_path(&path) {
                        Ok(url) => handle_open_urls(app.handle(), vec![url]),
                        // ⚠️ 理论上不会发生（`path` 来自 `to_file_path`）；响了说明
                        //    有人往暂存队列里塞了非文件路径。
                        Err(()) => diag!(
                            "⛔ 冷启动打开请求不是本地文件，丢弃：{}",
                            path.display()
                        ),
                    }
                }
            }

            // ⭐ **生效的界面语言只算一次**（`design/0025` §2.4）：菜单与首帧注入
            //    **必须认同一个答案**——两处各算一次、或一处用系统的、一处用偏好的，
            //    表现就是"菜单中文、界面英文"（而**没有任何报错**）。
            // ⚠️ `lang::effective` 在偏好是 `zh`/`en` 时**根本不 spawn**
            //    （`effective_with` 在取系统语言之前短路），所以这条不拖启动。
            let lang = app.state::<AppState>().with(|s| {
                crate::lang::effective(s.config.language_preference())
            });

            // ⭐ **菜单**（`design/0010`）。⚠️ 放在建窗口**之前**：
            //    窗口一出现就该带上这两项，否则会有"菜单里没有设置"的一段时间。
            // ⚠️ 失败**不让进程退出**——阅读器的主体功能不受影响（树、正文、图片都在），
            //    ⛔ 但**必须响亮**（上面 `install_menu` 里已经 `eprintln!` 过具体原因），
            //    且冒烟判据 `菜单=` 会因此在真机上变红。
            if let Err(e) = install_menu(app.handle(), lang) {
                diag_stderr!("⛔ 菜单没装上：{e}（设置界面仍可从表格里查到，但没有 ⌘, 菜单项）");
                diag_file!("⛔ 菜单没装上 err_len={}", e.len());
            }

            // ⭐ **探针入口（`design/0025` §7.1 步骤 0a）**：装完菜单、建窗口**之前**。
            //    ⚠️ 它跑完就 `exit` ⇒ **不建窗口**、⛔ 不弹窗、⛔ 不抢前台
            //    （macOS 上先设 `.prohibited`，`docs/kb/0025`）。
            //    ⚠️ 判据进**退出码**：`make probe-menu` 只看这个 0/1，⛔ 不去 grep 文案。
            if env_set("RMD_MENU_PROBE") {
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
                std::process::exit(menu_probe(app.handle(), lang));
            }

            // ⭐ **窗口在这里建，⛔ 不在 `tauri.conf.json` 里声明**。
            //
            // 理由只有一条：**注入脚本**。`design/0004` §2.1.3 要求
            // 「在任何样式应用之前」把 `data-theme` 写上——那需要
            // `WebviewWindowBuilder::initialization_script`（已核实可用，见 `kb/0010`），
            // 而 JSON 里声明的窗口**没有**这个口子。
            // ⇒ 本次把 `app.windows` 从配置里删掉，改在这里建，尺寸/标题照搬原值。
            //
            // ⚠️ 建在 `manage` **之后**：页面脚本一起来就要调 `get_session`。
            //    （`main.js` 另有 5 次重试兜底，但那不该是正常路径。）
            let appearance = app.state::<AppState>().with(|s| s.config.appearance());
            let mut win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("rmd")
            .inner_size(1000.0, 800.0)
            .center()
            // ⭐ `design/0026` §2.2 ①：**导航闸门**（`INV-LINK-01`）。
            //    ⛔ 只要不是应用自己的入口页，一律 false ⇒ WebView 不导航。
            //    ⚠️ 这是 `docs/bugs/0001`（点一下链接**整页重载**、甚至被永久导航走）
            //       的结构性防线：判据是**精确入口白名单**，⛔ 不是"后缀黑名单"
            //       （评审 `P1-2`：黑名单挡不住 `tauri://localhost/nope.js`）。
            //    ⚠️ 它**只**管"别导航走"，⛔ 不管"点击要做点什么"——那在前端的委托里。
            .on_navigation(|url| crate::link::is_app_entry(url.as_str()))
            // ⭐ `design/0026` §2.2 ②：`target="_blank"` / 中键 / ⌘点击 会请求新窗口。
            //    ⛔ 一律拒：在应用里开一个**没有地址栏的浏览窗口**既不是产品规则
            //    （外链要交给系统浏览器），也把导航闸门绕过去了。
            .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
            .initialization_script(init_script(
                &appearance,
                std::env::var_os("RMD_MEASURE").is_some(),
                lang,
            ));
            if let Some(c) = window_backdrop(&appearance.mode) {
                win = win.background_color(c);
            }
            win.build()?;
            diag!(
                "▶ 外观：模式={} 字号={}px 行高={} 内容宽={}",
                appearance.mode,
                appearance.font_size,
                appearance.line_height,
                if appearance.content_width == 0.0 {
                    "铺满".to_string()
                } else {
                    format!("{}px", appearance.content_width)
                }
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_session,
            // ⭐ `design/0015`：取走 Apple Event 队列（**读取命令**，⛔ 不收路径、⛔ 不改授权）
            commands::take_pending_open,
            commands::set_sidebar_width,
            // ⭐ `design/0041`：侧边栏形态（树 / 文档列表，**只写 `config.json`**）。
            //    ⚠️ 与另两处清单同批加（`build.rs` / `capabilities/`，`kb/0007`）。
            commands::set_sidebar_file_view,
            commands::set_appearance,
            // ⭐ `design/0025`：界面语言（**只写 `config.json` ＋ 重贴菜单**，
            //    ⛔ 不改授权、⛔ 不读文档）。⚠️ 与另两处清单同批加
            //    （`build.rs` / `capabilities/`，`kb/0007`）。
            set_language,
            get_shortcuts,
            fs_cmd::choose_directory,
            fs_cmd::choose_file,
            fs_cmd::close_directory,
            // ⭐ `design/0038`：进入一个**后端记过的**目录（**授权命令**，`INV-FS-04` 第四处）。
            //    ⚠️ 三处清单同批（`build.rs` / `capabilities/` / 这里，`kb/0007`）。
            fs_cmd::open_recent_directory,
            // ⭐ `design/0043`：打开一条**收藏**（**授权命令**，`INV-FS-04` 第五处）。
            //    ⚠️ 三处清单同批（`build.rs` / `capabilities/` / 这里，`kb/0007`）。
            fs_cmd::open_favorite,
            // ⭐ `design/0043`：收藏的**唯一写入口**（**只写 `config.json`**，操作枚举）。
            commands::favorites_apply,
            // ⭐ `design/0045`：最近目录的**唯一写入口**（删一条 / 清空）。
            //    ⚠️ 三处清单同批（`build.rs` / `capabilities/` / 这里，`kb/0007`）。
            //    ⛔ 它不删磁盘上的东西、不改授权、不动收藏。
            commands::recent_apply,
            fs_cmd::list_dir,
            // ⭐ `design/0009`：文件名模糊搜索（**读取命令**，⛔ 不改授权）
            fs_cmd::search_files,
            // ⭐ `design/0041`：文档列表（**读取命令**，与搜索共用同一份索引）。
            //    ⚠️ 三处清单同批（`build.rs` / `capabilities/` / 这里）。
            fs_cmd::list_documents,
            // ⭐ `design/0034`：新建文件 / 目录（**写入命令**）。⚠️ 与 `build.rs`、
            //    `capabilities/` 同批加（`kb/0007`：漏一处 = ACL 静默拒，前端只看到 Err）。
            fs_cmd::create_entry,
            // ⭐ `design/0035`：同一目录内的原子改名（**写入命令**）。⚠️ 三处同批。
            fs_cmd::rename_entry,
            // ⭐ `design/0048`：文件树右键「在访达中显示」（**读取命令**）。
            //    ⚠️ 三处同批（`build.rs` / `capabilities/` / 这里）。
            fs_cmd::reveal_entry,
            // ⭐ `design/0050`：盘上核对（手动刷新）＋ 重建目录监视（健康提示上的"重试"）。
            //    ⚠️ 两处清单（`build.rs` / `capabilities/default.json`）同时改了——
            //    漏一处的表现是 ACL 静默拒，日志里一行都没有（`kb/0007`）。
            fs_cmd::reconcile_disk,
            fs_cmd::retry_tree_watch,
            document::open_document,
            // ⭐ `design/0006`：重载 / 监视 / 外部编辑器
            document::reload_document,
            document::watch_document,
            document::unwatch_document,
            document::open_in_external_editor,
            asset::read_asset,
            // ⭐ `design/0012`：窗口内编辑。⚠️ `edit::save_document` 是**本项目唯一
            //    会写用户文件的命令**（`INV-EDIT-10`）——加命令时照旧要同批改
            //    `build.rs` 与 `capabilities/`（`kb/0007` 的漏一处就静默失效）。
            edit::begin_edit,
            edit::end_edit,
            edit::render_preview,
            edit::save_document,
            // ⭐ `design/0017`：阅读进度写盘（**只写 `config.json`**，⛔ 不改授权）。
            //    ⚠️ 与另两处清单同批加（`build.rs` / `capabilities/`，`kb/0007`）。
            commands::set_reading_progress,
            // ⭐ `design/0020`：目录会话写盘（**只写 `config.json`**，⛔ 不改授权）。
            //    ⚠️ 与另两处清单同批加（`build.rs` / `capabilities/`，`kb/0007`）。
            commands::set_dir_session,
            // ⭐ `design/0026`：打开文档内链接（**⚠️ 本命令可能派发 `/usr/bin/open`**）。
            //    ⚠️ 与另两处清单同批加（`build.rs` / `capabilities/`，`kb/0007`）。
            link_cmd::open_link,
            report_status,
            // ⭐ 批次 2 的测量回报（`design/0002` §10.4 批 2）。**同样是脚手架**，
            //    ⛔ 不是产品功能；只有 `RMD_MEASURE=1` 时前端才会调它。
            report_measure,
        ])
        // ⭐ `design/0015` §2.1 ④：**必须**用 `.build()` ＋ `App::run(callback)`，
        //    ⛔ 不能再用 `.run(context)`——后者没有事件回调，macOS 的 `odoc`
        //    （双击 `.md` / 默认处理器转来的打开请求）**根本收不到**。
        .build(context);

    let app = match result {
        Ok(app) => app,
        Err(e) => {
            // ⚠️ `{e}` 是任意文本（`tauri::Error` 可能引用路径/URL）⇒ 只进 stderr；
            //    文件里只留类别与长度（`INV-LOG-11`）。
            diag_stderr!("⛔ Tauri 起不来：{e}");
            diag_file!(
                "⛔ Tauri 起不来 err_class={} err_len={}",
                logging::err_class(&e),
                e.to_string().len()
            );
            return 1;
        }
    };

    // ⚠️ 回调里只处理 `Opened`；其余事件原样忽略（tauri 自己会把它们分发给窗口）。
    // ⚠️ 这里**不抢焦点**：收到打开请求后只换文档，⛔ 不调 `set_focus` / 不 activate
    //    （`CLAUDE.md` 工作约定 4 的同一精神；§6 的失败模型已登记这条取舍）。
    app.run(|app_handle, event| {
        // ⭐ `design/0016` §2.1 ④：正常退出留一行。
        // ⚠️ 只记固定文案——退出路径上没有需要带出的字段。
        if matches!(&event, tauri::RunEvent::Exit) {
            diag!("▶ rmd 退出");
            return;
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            handle_open_urls(app_handle, urls);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app_handle, event);
    });
    0
}

/// 冷启动阶段到达的打开请求（`design/0015` §2.1 ④ 的实现细节）。
///
/// ⚠️ macOS 在 `NSApplication` 启动期就可能投递 `application:openURLs:`，
/// **早于** Tauri 的 `setup` 回调 ⇒ 那时 `AppState` 还没 `manage`。
/// `setup` 里登记完状态后会原样搬进 `pending_opens`（见那里的注释）。
#[cfg(target_os = "macos")]
static EARLY_OPENS: std::sync::Mutex<Vec<std::path::PathBuf>> =
    std::sync::Mutex::new(Vec::new());

/// 处理 macOS 的 Apple Event 打开请求（`design/0015` §2.1 ④）。
///
/// 三条纪律：
/// 1. **授权只有一个入口**：每条路径都过 [`fs_cmd::authorize_startup`]——
///    与启动 argv 完全同一条（`INV-APP-02`）。⛔ 前端永远不会拿到新的授权入口。
/// 2. **路径只进后端队列**，事件只当"有新东西"的唤醒信号（`INV-APP-03`）——
///    ⛔ 不把路径塞进 `emit` 的载荷：那会造出第二个真值，而且第一个可伪造。
/// 3. **失败要响**：拒绝/读不到/不是文件都打一行说明，⛔ 不静默丢（§6 失败模型）。
#[cfg(target_os = "macos")]
// ⚠️ 类型写 `tauri::Url`（= `url::Url` 的再导出），⛔ 不写 `url::Url`——
//    `url` 不是本仓库的直接依赖（`Cargo.toml` 里没有），写它**编译不过**（E0433）。
fn handle_open_urls(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    use tauri::{Emitter, Manager};

    if urls.is_empty() {
        return;
    }

    let mut accepted = 0usize;
    for url in urls {
        let path = match url.to_file_path() {
            Ok(p) => p,
            Err(()) => {
                // ⚠️ `url` 是外部输入 ⇒ 不可信，只进 stderr（`INV-LOG-01`）。
                diag_stderr!("⛔ 打开请求不是本地文件：{url}");
                diag_file!("⛔ 打开请求不是本地文件");
                continue;
            }
        };

        // ⛔ 本期只接文档：目录会把整个会话切成"目录模式"，那条路属于应用内的
        //    选择器（要重刷树、改 `last_directory`），而 Apple Event 的
        //    LaunchServices 关联里只有 Markdown 文件（§4 不做多窗口/目录关联）。
        //    ⚠️ 明确拒绝而不是"顺手支持"——半支持会让模式与界面各说各话。
        match std::fs::metadata(&path) {
            Ok(md) if md.is_file() => {}
            Ok(_) => {
                diag!(
                    "⛔ 打开请求是目录或特殊文件，本期只接受文档：{}",
                    path.display()
                );
                continue;
            }
            Err(e) => {
                diag_stderr!("⛔ 打开请求的路径读不到（{e}）：{}", path.display());
                diag_file!(
                    "⛔ 打开请求的路径读不到 err_class={} err_len={} path={}",
                    logging::err_class(&e),
                    e.to_string().len(),
                    path.display()
                );
                continue;
            }
        }

        let Some(state) = app.try_state::<AppState>() else {
            // ⚠️⚠️ **冷启动时 Apple Event 会早于 `setup`**（2026-10-19 实测：系统在
            //    `NSApplication` 启动阶段就投递 `application:openURLs:`）。
            //    此刻 `AppState` 还没 `manage` ⇒ 直接 `app.state()` 会 panic
            //    （`state() called before manage()`），而且是在**不能 unwind** 的
            //    AppKit 回调里 ⇒ 进程直接 abort。
            //    ⭐ 所以先暂存，`setup` 里 `manage` 之后原样搬进 `pending_opens`。
            //    ⛔ 这里**不做任何授权**——授权仍然只有 `authorize_startup` 那一处（INV-APP-02）。
            if let Ok(mut q) = EARLY_OPENS.lock() {
                q.push(path);
            }
            continue;
        };

        let outcome = state.with(|s| {
            fs_cmd::authorize_startup(&mut s.grants, &path).map(|(_mode, real)| {
                // ⚠️ 这一行是**冒烟判据的锚点**（§7.1 第 9 条按标记取），也是排障时
                //    "到底收没收到 Apple Event"的唯一证据。
                diag!("▶ 打开请求（Apple Event）：{}", real.display());
                s.push_pending_open(real);
            })
        });
        match outcome {
            Ok(()) => accepted += 1,
            Err(e) => {
                diag_stderr!("⛔ 打开请求不能授权（{e}）：{}", path.display());
                diag_file!(
                    "⛔ 打开请求不能授权 err_class={} err_len={} path={}",
                    logging::err_class(&e),
                    e.to_string().len(),
                    path.display()
                );
            }
        }
    }

    if accepted == 0 {
        return;
    }
    // ⭐ 唤醒信号**不带路径**（`INV-APP-03`）。前端收到后调 `take_pending_open` 取空队列。
    // ⚠️ 冷启动时事件可能早于监听 ⇒ 前端引导阶段还会**主动 drain 一次**；
    //    这里发不出去也不致命（队列还在），但⛔ 仍然要响。
    if let Err(e) = app.emit("rmd://open-path", ()) {
        diag_stderr!("⛔ 打开请求的唤醒信号发不出去：{e}（队列还在，前端引导时会取走）");
        diag_file!(
            "⛔ 打开请求的唤醒信号发不出去 err_class={} err_len={}",
            logging::err_class(&e),
            e.to_string().len()
        );
    }
}

/// 启动路径的最小检查。
///
/// ⚠️ 它**不是**授权模型——授权在 `authorize_startup` 里做。
/// 这里只把"路径打错"变成**起窗口之前**的显式失败。
fn check_startup_path(path: &Path) -> Result<(), String> {
    let md = std::fs::metadata(path).map_err(|e| format!("打不开 {}：{e}", path.display()))?;
    if !md.is_dir() && !md.is_file() {
        return Err(format!("{} 既不是普通文件也不是目录", path.display()));
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// 冒烟钩子（测试脚手架，不是产品功能）
// ─────────────────────────────────────────────────────────────────────────

/// 前端在**把 HTML 放进 DOM 之后**回报的一句状态。
///
/// # 为什么需要它
///
/// 批 1 的验收是「能显示、能滚动」，批 3 的是「能显示、能滚」——
/// 但这是一个 GUI，**Agent 看不到那个窗口**。没有这条回报，
/// "能显示"就只是"进程没崩"，**等于没验**。
///
/// ⚠️ 它回报的都是**前端自己测出来的**事实（DOM 子元素数、滚动高度、
/// 树里建了多少个节点），不是后端猜的。⛔ 后端的 T1/T2/T3 不从这里走。
///
/// ⚠️ 只在 `RMD_SMOKE=1` 时才会让进程退出；平时它只往 stderr 打一行。
#[derive(Debug, serde::Deserialize)]
struct FrontendReport {
    /// 前端是否成功把 HTML 放进了 DOM。
    ok: bool,
    /// 状态条上那句话（人读的）。⚠️ 只用于打印，不做任何判断。
    summary: String,
    /// `#doc` 的**直接子元素**数。
    ///
    /// ⛔ **这不是 `design/0002` §7.2 第 9 条要的「DOM 节点数」**——
    /// 第 9 条要的是整篇渲染后的节点总数。本字段只数直接子元素，
    /// 两者量级差很远（`XL-tables.md` 这里报 18 548，AST 有 860 837）。
    /// ⚠️ **批次 2 必须换指标**（`design/0002` §10.3 已记）。
    doc_children: usize,
    /// `#doc.scrollHeight`。**"能滚"的直接证据**。
    scroll_height: f64,
    /// 视口高度。
    viewport_height: f64,
    /// `#doc.textContent.length`（UTF-16 码元）。
    text_len: usize,
    /// 正文开头的一小段。⭐ 唯一能证明**中文没乱码**的信号。
    sample: String,
    /// **Tauri 自己的** WKWebView 报出来的 `supportedEntryTypes`（批 0 的尾巴）。
    entry_types: Vec<String>,
    /// `navigator.userAgent`。
    user_agent: String,

    // ── 侧边栏（`design/0003`）的冒烟判据 ──
    /// 侧边栏当前是哪种状态：`directory` / `single-file` / `empty`。
    ///
    /// ⚠️ **它与后端的 `Session.mode` 必须一致**——判定时两边都要查（见 `report_status`）。
    /// 前端这个字符串是**推导**出来的（看 roots / 当前文档），后端那个是**声明**的。
    #[serde(default)]
    sidebar_mode: String,
    /// 树里**建出来的节点数**（含未展开的目录节点）。0 = 树没建出来。
    #[serde(default)]
    tree_nodes: usize,
    /// 树里灰显（忽略清单）的节点数。§7 步骤 5 要它在**界面上**也出现。
    #[serde(default)]
    tree_ignored: usize,
    /// 树里被标记为"当前项"的节点数。⚠️ 必须是 0 或 1，**不能是 2**。
    #[serde(default)]
    tree_current: usize,
    /// 未授权态是不是**显式的**（有说明文字 + 按钮），⛔ 不是一个残缺的树。
    #[serde(default)]
    unauthorized_explicit: bool,
    /// 空会话里**"上次打开的目录"那条提示**有没有真的画出来（§2.1.1 第 4 条）。
    #[serde(default)]
    last_dir_offer: bool,
    /// 正文容器里**是不是真挂了一份文档**。
    ///
    /// ⚠️ 它决定"可滚动"这一条判据算不算数：打开目录但还没点文件时，
    /// 正文区是**空态提示**（这是 `design/0003` §2.1 明确要的"不自动打开第一个文件"），
    /// 那种情形下"内容超出视口"当然不成立，⛔ 但不是失败。
    #[serde(default)]
    doc_loaded: bool,

    // ── 外观（`design/0004` / `design/0005`）的冒烟判据 ──
    /// ⭐ **真正生效的主题名**（`documentElement.dataset.theme`）。
    ///
    /// ⚠️ 它必须是 `light` / `dark` / `warm` 三者之一，⛔ **绝不能是 `system`**——
    /// `data-theme="system"` 在 CSS 里没有对应选择器，等于"没有主题"，
    /// 界面会塌回浏览器默认色（那是一个**看起来像主题没生效**的缺陷）。
    #[serde(default)]
    theme: String,
    /// ⭐ **真正生效的正文字号**（px，`getComputedStyle` 读出来的）。
    ///
    /// ⚠️ 它证明的是"单点派生真的接上了"（`INV-TYPE-02`）：
    /// 如果 `tokens.css` 没被加载、或者注入脚本写错了变量名，
    /// 这里拿到的会是 `0`（解析失败），而不是恰好等于配置值的某个数。
    #[serde(default)]
    reader_font_size: f64,

    // ── 设置界面与快捷键（`design/0010`）的冒烟判据 ──
    /// ⭐ 前端从 `get_shortcuts` 收到并**认下来**的项数。
    ///
    /// ⚠️ 它**必须等于**后端的 `SHORTCUTS.len()`。这条判据的真正价值是
    /// **证明 IPC 往返真的通了**：ACL 少一条 `allow-get-shortcuts` 时，
    /// `invoke` 会被**静默拒绝**，前端只会拿到一个 `Err`，界面上那一列**空着**。
    #[serde(default)]
    shortcuts: usize,
    /// ⭐ 前端那次**跨语言自检**的结果（§2.1 ② 的第三层）：
    /// 表里每个 id 都有 handler，且没有**表外的** handler。
    #[serde(default)]
    actions_ok: bool,
    /// 自检的明细（缺了什么 / 多了什么）。⚠️ 只为打印，⛔ 不参与判定。
    #[serde(default)]
    actions_note: String,
    /// ⭐ **菜单事件通道订阅成了吗**（§2.1 ⑧）。
    ///
    /// ⚠️ 它只走 `core:event:allow-listen` **一条**权限，而缺它的表现是
    /// 「**菜单点下去没反应**」——页面上看不出任何异样，`console.error` 也没人看
    /// （`kb/0007` 的 ACL 坑：权限是"有条件生效"的，漏一条就静默拒）。
    /// ⛔ 所以它必须是**进回报的一条判据**，⛔ 不是"在控制台里喊一句"。
    #[serde(default)]
    listen_ok: bool,
    /// 订阅失败的原因。⚠️ 只为打印，⛔ 不参与判定（判定看 `listen_ok`）。
    #[serde(default)]
    listen_note: String,

    // ── 文件监视与自动重载（`design/0006`）的冒烟判据 ──
    /// ⭐ **前端这一侧认下的监视代号**（`watch_document` 回来那个）。
    ///
    /// ⚠️ 与后端 `Session.watch` 那个是**两处真值**，故意的：它们不一致本身就是缺陷
    /// （前端以为在监视 A、后端在监视 B）⇒ 判据是"两边说的 `seq` 要相等"。
    /// `0` = 前端认为没有监视。
    #[serde(default)]
    watch_seq: u64,
    /// ⭐ 前端**丢弃过多少条变化事件**（`design/0006` §2.1 ② 要求丢弃要**计数**）。
    ///
    /// ⚠️ 它是排障用的观测量，⛔ 不参与判定：非零**不一定**是缺陷
    /// （换来换去本来就会产生迟到的事件），但"一直涨"就说明判据写错了。
    #[serde(default)]
    watch_dropped: u64,
    /// ⭐ **监视失败 / 已停止**的说明（`INV-EXT-04`：降级要显式告知）。
    ///
    /// ⚠️ 空 = 一切正常。非空时它**已经显示在界面上**（那才是"显式"），
    /// 这里只是让日志也看得到——否则这条降级只有盯着屏幕的人知道。
    #[serde(default)]
    watch_note: String,
    /// ⭐ `design/0011` §3 的**前端自证**：查找这条路真的能走通吗。
    ///
    /// ⚠️ 它判的是**两条一起**（设计里写死的形状）：拿正文第一段自己的文本当关键词，
    /// ① 命中数 ≥ 1 **且** 那个命中区间读出来**逐字等于**关键词；
    /// ② 再搜一个**一定搜不到**的哨兵，命中数 = 0。
    /// ⛔ 只判 ① 会被一个"永远返回全部段"的实现骗过；只判 ② 会被"什么都不搜"骗过。
    ///
    /// ⚠️ 只在 `doc_loaded` 时才要求它——空会话与目录模式里没有已挂载的正文，
    /// "没跑"（`find_hits = -1`）**不是失败**。
    #[serde(default)]
    find_ok: bool,
    /// 自证失败的说明。⚠️ 只为打印，⛔ 不参与判定（判定看 `find_ok`）。
    #[serde(default)]
    find_note: String,
    /// 索引建出来的**段数**（`INV-FIND-03` 的观测量）。
    ///
    /// ⚠️ 它是**排障用**的，⛔ 不设"应该等于几"的断言：段数与文档结构有关，
    /// 写死一个数就等于把某一份语料当成标准。⚠️ `0` 配上 `find_ok=false` 才有意义。
    #[serde(default)]
    find_segments: u64,
    /// 探测词命中的处数。⚠️ `-1` = **这一轮没跑**（没有已挂载的文档），⛔ 不是 0 处。
    #[serde(default)]
    find_hits: i64,
    /// 哨兵词的命中处数（**必须是 0**）。同上，`-1` = 没跑。
    #[serde(default)]
    find_miss: i64,

    // ── 窗口内编辑（`design/0012`）的冒烟判据 ──
    /// ⭐ **前端自证**：编辑这条路真的能走通吗（`design/0011` 的 `find_ok` 同族）。
    ///
    /// ⚠️ 判的是**三件事一起**，缺一条都可能被一个"看起来能编辑"的空壳骗过：
    /// ① CM6 的全局在（`src/vendor/cm6.bundle.js` 真的加载了）；
    /// ② 用一个**临时容器**建出 `EditorView`、`dispatch` 一段文本、再读回来**逐字相等**
    ///    （建不出来 / 读不回来 / 文本丢了，三者都在这里露出来）；
    /// ③ **转发白名单非空且含 `Mod-s`**（§2.3-4 的派生真的产出了东西——
    ///    派生判据写错一个字，白名单会**静默变成空数组**，而那时编辑区里所有应用键都失效）。
    ///
    /// ⚠️ 它**不依赖有没有打开文档**（建一个 `EditorView` 不需要正文）⇒ 空会话/目录模式
    /// 下同样要过。⛔ 也不进编辑态、⛔ 不碰用户的任何文件。
    #[serde(default)]
    edit_ok: bool,
    /// 自证的明细 / 失败原因。⚠️ 只为打印，⛔ 不参与判定。
    #[serde(default)]
    edit_note: String,
    /// ⭐ **编辑面现在是不是活的**（真进了编辑态、`EditorView` 挂在 `#editor` 里）。
    ///
    /// ⚠️ 冒烟窗口里**没人点「编辑」**⇒ 正常就是 `false`，⛔ 它不是判据
    /// （它是给排障看的：出事时能一眼分清"没进编辑态"与"进了但坏了"）。
    #[serde(default)]
    editor_mounted: bool,
    /// 编辑缓冲有没有**未保存**的改动（`INV-EDIT-06` 的那道闸靠它）。
    #[serde(default)]
    editor_dirty: bool,
    /// 前端发过多少次 `render_preview`（§2.6 的三档调度）。
    ///
    /// ⚠️ 它是**排障观测量**，⛔ 不设"应该等于几"的断言（按文档大小与打字速度而定）。
    ///
    /// ⚠️⚠️ **`-1` = 这一轮没渲染过**（`editorPreview` 还是 `null`，一次都没发出去），
    /// ⛔ 不是"发了 0 次"——同上一条 `find_hits`。**必须是 `i64`**：
    /// Tauri 在**进命令体之前**反序列化，`-1` 撞 `u64` 会让**整条 `report_status` 失败**，
    /// 而前端两个调用点都把它吞在 `try/catch` 里 ⇒ 回报永远到不了这半，
    /// `RMD_SMOKE` 收不到 `FrontendReport` ⇒ **`make smoke` 挂死且零输出**
    /// （`docs/bugs/0003`：0012 加字段时照抄了 `find_segments: u64`，
    /// 却没跟着 `find_hits`/`find_miss` 那条 `-1` 契约走）。
    #[serde(default)]
    preview_req: i64,
    /// 预览是不是**落后于**编辑缓冲（`INV-EDIT-11`：陈旧必须始终可见）。
    ///
    /// ⚠️ 它必须是**界面上看得见**的那种状态（提示条），⛔ 不是一个只在日志里的数
    /// ——所以这里报的是"前端此刻认为陈不陈旧"，用来核对两级真值没脱节。
    #[serde(default)]
    preview_stale: bool,
    /// ⭐ 左右滚动同步**这一刻的状态**（`design/0012` §11.7），给冒烟打一行。
    ///
    /// ⚠️⚠️ **它是排障观测量，⛔ 不参与 `pass`**——理由不是"不重要"，而是
    /// **冒烟窗口里没人会进编辑态**（`tools/smoke-gui.sh` 只开窗、不按键，
    /// 见 `main.js::report()` 那段"为什么不让冒烟去按键"）⇒ 这里**正常就是**
    /// 「编辑态未起」。把它写进 `pass` 只会造出一条**恒真**的判据。
    ///
    /// ⭐ 那它为什么还要存在：因为它把
    /// 「**同步真的挂上了没有**」从一句推断变成一个**可直接读的数**——
    /// 进编辑态之后它是 `精确｜锚点 7/7｜折线 7｜来源 src`，而
    /// ⛔ 同步**整个没接上**时那句注释里说的 `syncDriver === null` 会**照旧**印成
    /// 「编辑态未起」——⚠️ 这两种"看着一样"的形态**只有把 `编辑面` 那一栏一起读**
    /// 才分得开（编辑面=活的 而 这一栏=编辑态未起 ⇒ 接线断了）。
    /// ⚠️ 所以下一回要把它变成判据，**必须**先让冒烟真的走一遍编辑态。
    #[serde(default)]
    sync_state: String,
}

/// 前端把上面那条报回来。
///
/// ⚠️ 判定要**同时**用后端的状态（`Session.mode` / `last_directory`）与前端量到的事实，
/// ⛔ 不能只看前端报的 `sidebar_mode`：那个字符串是前端自己推导的，
/// 用"启动参数是文件、但前端根本没挂上文档"这种失败去测它，它会**推导成 `empty`**，
/// 于是"单文件必须显示出来"这条判据就被绕过去了（2026-10-13 实测放过一次假 PASS）。
#[tauri::command]
fn report_status(app: tauri::AppHandle, report: FrontendReport) -> Result<(), String> {
    use tauri::Manager;
    // ⚠️ 第一行就打一条：**"到了这里"本身就是一份证据**。
    //    若这条不出现，说明前端根本没走到回报——问题是前端的，不是判据的。
    diag!("▶ report_status 收到回报（ok={}）", report.ok);
    let scrollable = report.scroll_height > report.viewport_height * 1.5;
    diag!(
        "  前端回报：ok={} DOM 子元素={} 文字 {:.1}k 字符 滚动高度={:.0} 视口={:.0} 可滚={}",
        report.ok,
        report.doc_children,
        report.text_len as f64 / 1000.0,
        report.scroll_height,
        report.viewport_height,
        scrollable
    );
    // ⚠️ `sample` / `summary` 是**正文与任意文本** ⇒ 只进 stderr；文件里只留长度
    //    （`INV-LOG-01`，`design/0016` §7.2 第 7 条）。
    diag_stderr!("  开头：{}", report.sample);
    diag_file!("  开头：长度={} 字节", report.sample.len());
    diag_stderr!("  状态条：{}", report.summary);
    diag_file!("  状态条：长度={} 字节", report.summary.len());
    let backend_mode = {
        use tauri::Manager;
        app.state::<AppState>().with(|s| s.mode().as_str())
    };
    diag_stderr!(
        "  侧边栏：{}（后端声明 {}）｜树节点 {}（灰显 {}）｜当前项 {}｜未授权态显式={}｜已挂文档={}｜上次目录提示={}",
        report.sidebar_mode,
        backend_mode,
        report.tree_nodes,
        report.tree_ignored,
        report.tree_current,
        report.unauthorized_explicit,
        report.doc_loaded,
        report.last_dir_offer
    );
    diag_file!(
        "  侧边栏：后端声明 {}｜树节点 {}（灰显 {}）｜当前项 {}｜未授权态显式={}｜已挂文档={}｜上次目录提示={}",
        backend_mode,
        report.tree_nodes,
        report.tree_ignored,
        report.tree_current,
        report.unauthorized_explicit,
        report.doc_loaded,
        report.last_dir_offer
    );

    // ⭐ **渲染统计**（`design/0007` §3.1 / `INV-MATH-05`）：`math_budget` 非零 =
    //    有一批公式因为累计触顶退回了源码。⚠️ 它是**后端**算的（后端渲染的那一份），
    //    ⛔ 不是前端报的——所以这一行**不出现在 `FrontendReport` 里**。
    //    ⚠️ 这个数**允许是零**（没有公式就是零），⛔ 别把它读成"计数器没接上"——
    //    真没接上的话这一行**根本不会出现**。
    //    ⭐ **2026-10-15（Q22）**：这一行不再只有公式——代码高亮的四个计数器
    //    也在 `summary()` 里（`code=` / `code_over=` / `code_budget=`）。
    //    ⚠️ **标签随之从 `公式渲染：` 改成 `渲染统计：`**（⛔ 不改成"公式渲染"那样的字面承诺，
    //    那会变成一句假话）；旧的 `公式渲染：` 字样**全项目已无脚本依赖**
    //    （`tools/smoke-gui.sh` 的按标记取那张表里**本来就没有它**），见 `design/0007` §10.8。
    let (render_line, code_note) = app.state::<AppState>().with(|s| {
        let st = s.last_render_stats;
        let over = st.code_unhighlighted();
        let note = if over > 0 {
            // ⭐ Q22 原话要的就是这一句：**说得准确**——
            //    "未高亮"≠"内容丢了/被跳过了"，这几块是**完整、转义的纯文本**。
            format!(
                "  ⛔ 部分代码未高亮（规模限制）：{over} / {} 块，内容完整",
                st.code_highlighted + over
            )
        } else {
            String::new()
        };
        (st.summary(), note)
    });
    diag!("  渲染统计：{render_line}{code_note}");

    // ⭐ 批次 0 的尾巴：Tauri 的 WKWebView 与裸 WKWebView 是不是同一套观测能力
    let longtask = report.entry_types.iter().any(|t| t == "longtask");
    diag!(
        "  Tauri 的 WKWebView：supportedEntryTypes = {} 个 [{}]",
        report.entry_types.len(),
        report.entry_types.join(", ")
    );
    diag!("  ⭐ 有 longtask 吗：{}", if longtask { "有" } else { "没有" });
    // ⚠️ UA 是平台固定串，**可信**（§2.1 ② 的判定表）。
    diag!("  UA：{}", report.user_agent);

    // ── 外观（`design/0004` / `design/0005`）──
    let (want_mode, want_font) = app
        .state::<AppState>()
        .with(|s| (s.config.appearance().mode, s.config.appearance().font_size));
    diag_stderr!(
        "  外观：生效主题={}（配置模式={}）｜生效正文字号={}px（配置值={}px）",
        if report.theme.is_empty() { "（空）" } else { &report.theme },
        want_mode,
        report.reader_font_size,
        want_font
    );
    diag_file!(
        "  外观：配置模式={}｜生效正文字号={}px（配置值={}px）",
        want_mode,
        report.reader_font_size,
        want_font
    );

    // ── 快捷键（`design/0010`）──
    diag!(
        "  快捷键：表 {} 项｜前端认下 {} 项｜动作自检={}｜菜单={}｜菜单事件通道={}",
        SHORTCUTS.len(),
        report.shortcuts,
        if report.actions_ok { "全" } else { "不全" },
        if MENU_INSTALLED.load(std::sync::atomic::Ordering::Relaxed) {
            "ok"
        } else {
            "没了"
        },
        if report.listen_ok {
            "ok"
        } else {
            "没订上（ACL 少了 core:event:allow-listen？）"
        }
    );
    if !report.actions_note.is_empty() {
        diag_stderr!("    动作明细：{}", report.actions_note);
        diag_file!("    动作明细：长度={} 字节", report.actions_note.len());
    }
    if !report.listen_note.is_empty() {
        diag_stderr!("    菜单事件明细：{}", report.listen_note);
        diag_file!("    菜单事件明细：长度={} 字节", report.listen_note.len());
    }

    // ── 文件监视与自动重载（`design/0006`）──
    // ⭐ 后端那一侧的真值：现在监视的是哪份文件。
    let (backend_watch, backend_doc) = app.state::<AppState>().with(|s| {
        (
            s.watch.as_ref().map(|w| (w.seq, w.real.display().to_string())),
            s.current_document.as_ref().map(|p| p.display().to_string()),
        )
    });
    // ⚠️ `watch_note` 是前端拼接的自由文本 ⇒ 只进 stderr；文件里用 seq／路径这些可信字段。
    diag_stderr!(
        "  监视：前端 seq={}（丢弃 {} 条）｜后端 {}｜当前文档 {}｜说明={}",
        report.watch_seq,
        report.watch_dropped,
        match &backend_watch {
            Some((seq, p)) => format!("seq={seq} 盯着 {p}"),
            None => "没有监视".to_string(),
        },
        backend_doc.as_deref().unwrap_or("（无）"),
        if report.watch_note.is_empty() { "（无）" } else { &report.watch_note }
    );
    diag_file!(
        "  监视：前端 seq={}（丢弃 {} 条）｜后端 {}｜当前文档 {}",
        report.watch_seq,
        report.watch_dropped,
        match &backend_watch {
            Some((seq, p)) => format!("seq={seq} 盯着 {p}"),
            None => "没有监视".to_string(),
        },
        backend_doc.as_deref().unwrap_or("（无）")
    );

    // ── 目录监视（`design/0034`）──
    // ⚠️ **只印不判**（与 `滚动同步=` 同类）：冒烟窗口里没有授权目录
    //    ⇒「未建立」本身就是正确状态，⛔ 不该进 `pass`。
    //    ⭐ 排障时要把它与 `▶ 目录监视已建立` 那行 stderr **对着读**：
    //    这里「未建立」而那边有「已建立」⇒ 中途被换根摘掉了（正常）；
    //    两边都没有 ⇒ 建立失败（那一行会写明原因）。
    let tree_watch = app.state::<AppState>().with(|s| {
        s.tree_watch
            .as_ref()
            .map(|w| (w.root.display().to_string(), w.generation))
    });
    diag!(
        "  目录监视：{}",
        match &tree_watch {
            Some((p, g)) => format!("盯着 {p}（代次 {g}）"),
            None => "未建立（没有授权根，或建立失败）".to_string(),
        }
    );

    // ── 正文内查找（`design/0011`）──
    // ⚠️ 那三个数是**前端自证**跑出来的（开浮层 → 建索引 → 搜 → 核对区间 → 搜哨兵 → 关），
    //    ⛔ 不是"我打开窗口看了一眼"。所以这一行在**没人看的冒烟窗口**里也有意义。
    diag!(
        "  查找：段 {}｜探测词命中 {}｜哨兵命中 {}｜自证={}",
        report.find_segments,
        // ⚠️ `-1` 要**看得见**，不能打成 `-1` 以外的东西——"没跑"与"0 处"是两回事。
        report.find_hits,
        report.find_miss,
        if report.find_ok { "过" } else { "未过" }
    );
    if !report.find_note.is_empty() {
        diag_stderr!("    查找明细：{}", report.find_note);
        diag_file!("    查找明细：长度={} 字节", report.find_note.len());
    }

    // ── 窗口内编辑（`design/0012`）──
    // ⭐ 后端那一侧的真值：写授权给没给、基线多大、有没有保存在途、自写指纹记的是什么。
    //    ⚠️ 这四个**只有后端知道**（前端拿到的是"授权成功"这一个事实），
    //    而 §6 那一整张失败模型的排障要的正是它们。
    let (edit_target, baseline_len, inflight, self_write) = app.state::<AppState>().with(|s| {
        (
            s.edit_target.as_ref().map(|p| p.display().to_string()),
            s.baseline_bytes.as_ref().map(|b| b.len()),
            s.inflight_active(),
            s.self_write,
        )
    });
    diag!(
        "  编辑：自证={}｜编辑面={}（脏 {}）｜写授权={}｜基线={}｜保存在途={}｜自写指纹={}｜预览 {} 次（陈旧 {}）",
        if report.edit_ok { "过" } else { "未过" },
        if report.editor_mounted { "活的" } else { "没开" },
        report.editor_dirty,
        edit_target.as_deref().unwrap_or("（无）"),
        match baseline_len {
            Some(n) => format!("{n} 字节"),
            None => "（无）".to_string(),
        },
        if inflight { "是" } else { "否" },
        match self_write {
            Some((len, mtime)) => format!("({len}, {mtime})"),
            None => "（无）".to_string(),
        },
        report.preview_req,
        if report.preview_stale { "是" } else { "否" }
    );
    if !report.edit_note.is_empty() {
        diag_stderr!("    编辑明细：{}", report.edit_note);
        diag_file!("    编辑明细：长度={} 字节", report.edit_note.len());
    }

    // ── 左右滚动同步（`design/0012` §11）──
    // ⚠️⚠️ **它正常就是「编辑态未起」**——冒烟窗口里没人进编辑态（见上面 `report()` 那段）。
    //    ⭐ 所以这一行**不是判据**，它存在的理由是：进编辑态之后这里是
    //    `精确｜锚点 7/7｜折线 7｜来源 src`，而**接线断了**时它照旧是「编辑态未起」
    //    ⇒ 与上一行的 `编辑面=` **对着读**就能分开那两种形态（面是活的而这里是未起 = 断了）。
    // ⚠️ `sync_state` 是前端拼出来的自由文本 ⇒ 只进 stderr（`INV-LOG-01`）。
    diag_stderr!("  滚动同步：{}", report.sync_state);
    diag_file!("  滚动同步：长度={} 字节", report.sync_state.len());

    if std::env::var_os("RMD_SMOKE").is_some() {
        // ⚠️ 冒烟判据（写在代码里，不靠人看）。⭐ **每条判据都必须有一个"做不到就红"的理由**：
        //   ① HTML 真建出了 DOM；② 前端推导的模式与后端声明的模式**一致**；
        //   ③ **单文件启动必须真挂上文档且可滚**——那正是批 1 的验收
        //      （⛔ 不能因为"空态也有文字"就放过）；反过来，目录/空会话允许没挂文档
        //      （§2.1：⛔ 不自动打开第一个文件），但那种情形必须是**显式空态**；
        //   ④ 目录模式下树必须真的建出来了，否则"文件树侧边栏"等于没验；
        //   ⑤ 空会话里若后端记着"上次打开的目录"，界面上就得有那条提示；
        //   ⑥ 当前项高亮**至多一个**（§2.1 的当前项语义）。
        let (mode, last_dir_known) = app
            .state::<AppState>()
            .with(|s| (s.mode(), s.config.last_directory.is_some()));
        let mode_str = mode.as_str();
        let dir_mode = mode == Mode::Directory;
        let doc_ok = if mode == Mode::SingleFile {
            // ⭐ 单文件启动：**必须**真挂上文档。`scrollable` 也在这一条里——
            //    它是批 1「能显示、能滚动」的原判据，不该因为批 3 加了侧边栏而消失。
            report.doc_loaded && report.doc_children > 0 && report.text_len > 0 && scrollable
        } else if report.doc_loaded {
            report.doc_children > 0 && report.text_len > 0 && scrollable
        } else {
            report.doc_children > 0 && report.text_len > 0
        };
        let offer_ok = !(mode == Mode::Empty && last_dir_known) || report.last_dir_offer;

        // ⭐ **外观真的落地了吗**（`design/0004` / `design/0005`）。
        //  ① 生效主题名必须是个**具体主题**，⛔ 不能是 `system`（CSS 里没有那个选择器），
        //     且与配置里的模式一致（`system` 时解析成 light 或 dark 都算对）；
        //  ② 生效字号必须与配置值相等——它证明"单点派生接上了"：
        //     变量名写错或 `tokens.css` 没加载，这里会拿到 0 而不是恰好相等的数。
        let theme_ok = match want_mode.as_str() {
            "light" | "dark" | "warm" => report.theme == want_mode,
            _ => report.theme == "light" || report.theme == "dark",
        };
        let font_ok = (report.reader_font_size - want_font).abs() < 0.01;

        // ⭐ **快捷键**（`design/0010` §7 步骤 12）。四条，各有各的失败形态：
        //  ① `shortcut_ok`：前端收到的项数 == 表长 ⇒ **IPC 真的往返了**。
        //     ⚠️ 它是这次唯一能自动发现"`allow-get-shortcuts` 漏了"的手段——
        //     漏了以后前端只会拿到 `Err`，那一列**空着**，而窗口一切正常。
        //  ② `menu_ok`：菜单装上了。⚠️ 它是**启动结果**（`MENU_INSTALLED`），
        //     不是配置 ⇒ ⛔ 不进 `config.json`。
        //  ③ `actions_ok`：前端那份 handler 注册表与这张表**对上了**（两个方向都查）。
        //     ⚠️ 这是 §2.1 ② 里**必须在运行时**做的那一层：Rust 静态测试看不见
        //     前端源码，前端静态测试看不见这张表。
        //  ④ `listen_ok`：**菜单事件通道订阅成了**（`core:event:allow-listen`）。
        //     ⚠️ 这一条单列，是因为它缺了以后 `shortcut_ok`/`actions_ok` **照样全绿**：
        //     表拿得到、handler 也齐，只有"菜单点下去没反应"——而那是 `0006` 也要
        //     共用同一条权限的地方（§9.3 T8）。
        let shortcut_ok = report.shortcuts == SHORTCUTS.len();
        let menu_ok = MENU_INSTALLED.load(std::sync::atomic::Ordering::Relaxed);
        let actions_ok = report.actions_ok;
        let listen_ok = report.listen_ok;

        // ⭐ **文件监视真的建起来了吗**（`design/0006` §7 的同族判据）。
        // ⚠️ 只在**单文件启动**时判：那是唯一一个"启动就必然挂上一份文档"的入口
        //    （§2.1 ②：监视只在一次**成功的读取**之后建立）。
        //    目录/空会话不判——那种情形"该不该有监视"取决于用户在树里点了什么。
        // ⚠️ 判据是**两边对得上**，⛔ 不是只看一边：后端有、前端认下的 `seq` 却是 0，
        //    意味着"事件到了前端也认不出来"——那与没有监视是同一种下场，
        //    但**两端各自看都正常**。
        // ⭐ 还要 `watch_note` 为空：它装的是"**为什么**自动刷新不工作"
        //    （后端建不起监视 / 事件通道没订上）——⛔ 那两种情况 `seq` 一样对不上，
        //    但它们是**两条完全不同的故障链**，判据不能只落在 `seq` 上。
        let watch_ok = if mode == Mode::SingleFile {
            match &backend_watch {
                Some((seq, _)) => {
                    report.watch_seq == *seq && *seq > 0 && report.watch_note.is_empty()
                }
                None => false,
            }
        } else {
            true
        };

        let pass = report.ok
            && report.sidebar_mode == mode_str
            && doc_ok
            && (!dir_mode || report.tree_nodes > 0)
            && offer_ok
            && report.tree_current <= 1
            && theme_ok
            && font_ok
            && shortcut_ok
            && menu_ok
            && actions_ok
            && listen_ok
            && watch_ok
            // ⭐ 正文内查找（`design/0011` §3）：**只在挂了文档时才判**——
            //    空会话/目录模式里没有正文可搜，`find_ok=false` 是**正常的**
            //    （前端那时也把 `find_hits` 报成 -1 而不是 0）。
            && (!report.doc_loaded || report.find_ok)
            // ⭐ 窗口内编辑（`design/0012`）：**任何模式都要过**——
            //    它验的是"CM6 加载得进来 + 建得出 view + 转发白名单派生出了东西"，
            //    ⛔ 与有没有打开文档无关（建一个 `EditorView` 不需要正文）。
            //    ⚠️ 这一条要挡的是**构建链断掉**那一类：`src/vendor/cm6.bundle.js` 缺失时
            //    界面上一切正常（只读阅读完全不受影响），⛔ 只有点了「编辑」才发现按不动。
            && report.edit_ok;
        // ⭐ 落盘那一份**只含可信字段**：结论与计数。
        //    ⚠️ 下面那条 `RMD_SMOKE` 行（脚本按标记取）里带着 `find_note`/`edit_note`，
        //    它们是自由文本 ⇒ 只进 stderr（`INV-LOG-01`）。
        diag!(
            "RMD_SMOKE 结论={} 后端模式={} 文档={} 树节点={} 查找={} 编辑={} 监视={}",
            if pass { "PASS" } else { "FAIL" },
            mode_str,
            report.doc_loaded,
            report.tree_nodes,
            if report.doc_loaded { if report.find_ok { "过" } else { "未过" } } else { "不适用" },
            if report.edit_ok { "过" } else { "未过" },
            if watch_ok { "ok" } else { "对不上" }
        );
        diag_stderr!(
            "RMD_SMOKE {} 后端模式={} DOM 子元素={} 文字={} 字符 滚动高度={:.0} 视口={:.0} 侧边栏={} 树节点={} 灰显={} 当前项={} 已挂文档={} 上次目录提示={} 主题={} 字号={}px 快捷键={} 菜单={} 动作={} 菜单事件={} 监视={} 查找={} 编辑={}",
            if pass { "PASS" } else { "FAIL" },
            mode_str,
            report.doc_children,
            report.text_len,
            report.scroll_height,
            report.viewport_height,
            report.sidebar_mode,
            report.tree_nodes,
            report.tree_ignored,
            report.tree_current,
            report.doc_loaded,
            report.last_dir_offer,
            report.theme,
            report.reader_font_size,
            report.shortcuts,
            if menu_ok { "ok" } else { "没了" },
            if actions_ok { "全" } else { "不全" },
            if listen_ok { "ok" } else { "没订上" },
            format!("前端 {}｜后端 {}", report.watch_seq, match &backend_watch {
                Some((seq, _)) => seq.to_string(),
                None => "无".to_string(),
            }),
            // ⚠️ 没挂文档时打 `不适用`（⛔ 不是 `没过`）：两者要能一眼分开。
            if !report.doc_loaded { "不适用".to_string() }
            else if report.find_ok { "过".to_string() }
            else { format!("没过（{}）", if report.find_note.is_empty() { "无说明" } else { &report.find_note }) },
            // ⚠️ 编辑自证**不打"不适用"**：它与有没有正文无关（见判据处那段注释）。
            if report.edit_ok { "过".to_string() }
            else { format!("没过（{}）", if report.edit_note.is_empty() { "无说明" } else { &report.edit_note }) }
        );
        if !report.edit_ok {
            diag_stderr!(
                "  ⛔ 编辑自证没过：{} —— 多半是 `src/vendor/cm6.bundle.js` 没构建（`make cm6`）\
                 或没随 Web 资源一起发出",
                if report.edit_note.is_empty() { "（无说明）" } else { &report.edit_note }
            );
        }
        if report.doc_loaded && !report.find_ok {
            diag_stderr!(
                "  ⛔ 正文内查找自证没过：段 {}｜探测词命中 {}｜哨兵命中 {}｜{}",
                report.find_segments,
                report.find_hits,
                report.find_miss,
                if report.find_note.is_empty() { "（无说明）" } else { &report.find_note }
            );
        }
        if !watch_ok {
            diag_stderr!(
                "  ⛔ 监视对不上：前端 seq={}（说明={}），后端 {} —— 自动重载会**永远不发生**",
                report.watch_seq,
                if report.watch_note.is_empty() { "（无）" } else { &report.watch_note },
                match &backend_watch {
                    Some((seq, p)) => format!("seq={seq} 盯着 {p}"),
                    None => "没有监视".to_string(),
                }
            );
        }
        if !shortcut_ok {
            diag!(
                "  ⛔ 快捷键条数对不上：前端认下 {} 项，表里 {} 项（多半是 ACL 少了 allow-get-shortcuts）",
                report.shortcuts,
                SHORTCUTS.len()
            );
        }
        if !actions_ok {
            diag_stderr!("  ⛔ 动作自检没过：{}", report.actions_note);
        }
        if !listen_ok {
            diag_stderr!(
                "  ⛔ 菜单事件没订上（多半是 capability 少了 core:event:allow-listen）：{}",
                report.listen_note
            );
        }
        app.exit(if pass { 0 } else { 3 });
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// 批次 2 的测量回报（`design/0002` §10.4 批 2、§7.3 的计时协议）
// ─────────────────────────────────────────────────────────────────────────

/// 前端 `reportMeasure()` 装上来的那一个样本。
///
/// ⚠️ **字段名逐字照抄前端**（`src/main.js` 的 `reportMeasure`）——这里不是"重新设计
/// 一份 schema"，而是给那条已经存在的载荷加一层类型。⛔ 改一边不改另一边，
/// 表现是**反序列化失败**：`invoke` 返回 `Err`，而 `reportMeasure` 只在
/// `console.warn` 里说一句，**结果文件里那片数字直接缺席**——正是本项目最怕的静默。
///
/// ⭐ **三种"取不到"必须区别于零**（`INV-MEASURE-01` 同族）：
/// `r_ms` / `t6_fcp_ms` / `t6b_lcp_ms` 都是 `Option`，`null` 是**合法且必须保留**的值
/// （LCP 在 WebKit 上真的可能没有；`watching.lcp == false` 时它**永远**是 null）。
/// ⛔ 不许 `unwrap_or(0.0)` 把它们变成 0：那会让"没采到"看起来像"快到 0 毫秒"。
///
/// ⚠️ 后端的 `t1/t2/t3` 与前端的时间戳**不同纪元**，这里**只当"时长"收下来**
/// （§7.3.2：它们只参与那条减法，⛔ 不与前端时间戳混进同一个变量）。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct MeasureSample {
    /// 文档的真实路径（后端给的，⛔ 不是前端拼的）。
    file: String,
    source_bytes: u64,
    html_bytes: u64,
    ast_nodes: u64,
    toc_entries: u64,
    had_bom: bool,

    // —— 后端口径（Rust `Instant`）——
    t1_ms: f64,
    t2_ms: f64,
    t3_ms: f64,
    // —— 前端口径（WebView 时间轴）——
    t4_ms: f64,
    t5_ms: f64,
    t5b_ms: f64,
    /// 残差 `R = T4 − (T1+T2+T3)`，**推导值**。⚠️ 可以为负（时钟与调度噪声）。
    r_ms: Option<f64>,
    /// 首屏绘制 / 主内容绘制，相对 `rmd:boot` 那个 mark。⚠️ 采不到是 `null`。
    t6_fcp_ms: Option<f64>,
    t6b_lcp_ms: Option<f64>,

    /// ⭐ **滚动那半**（`design/0002` §10.5.3）：**打开时付过的 `T5b`，滚到底要不要再付一次**。
    ///
    /// ⚠️ **三者口径各不相同，⛔ 不许相加**：
    /// `t5c_ms` / `t5d_ms` 是**同步分段**（跳到底 + 强制布局 / 「回顶再到底」再强制布局），
    /// `t5e_ms` 是**异步**（到滚动后那一帧的回调，含绘制、且被帧率量化到 ≈16.7 ms 一档）。
    ///
    /// ⚠️ 它们**不在 §7.3.2 那六个量里**——是批 2 收尾时补的第七个问题，
    /// 所以**只与同一份结果文件比**，⛔ 不与 `2026-10-14-Mac14,9-gui.json` 混读。
    /// `t5e_ms` 同理是 `Option`（采不到就是 `null`，⛔ 不填 0）。
    t5c_ms: f64,
    t5d_ms: f64,
    t5e_ms: Option<f64>,
    /// 实际选中的滚动容器、它的 `scrollHeight` 与 `clientHeight`、
    /// 以及**这一跳实际滚到的位置**。
    ///
    /// ⚠️⚠️ **2026-10-14 实测更正**：前三项原只报 `scrollingElement.scrollHeight`——
    /// **那是错的而且量不出东西**。`document.scrollingElement` 返回 `html`，而本项目
    /// `html, body { height:100%; overflow-y:auto }` 让 `html` 的高度**恰好等于视口**
    /// ⇒ 它从不溢出、`window.scrollTo()` 一次都没滚，而 `scroll_height` 会安静地
    /// 等于**视口高度**（实测 0.1 MB 与 10 MB 都是 769）——一份**看起来漂亮的空测量**。
    /// 真正在滚的是 **`body`** ⇒ 前端改为运行时挑真正溢出的那个，并把
    /// `scroll_top` 报上来当**自证**：它必须 ≈ `scroll_height − client_height`，
    /// **为 0 就说明这次没滚成**，`t5c`/`t5d` 那两个 0 **不是结论**。
    scroll_height: f64,
    client_height: f64,
    scroll_top: f64,
    scroll_el: String,
    /// ⭐ **前端时钟的分辨率**（ms，`measure.js::clockResolutionMs`）。
    ///
    /// ⚠️ 它决定上面那几个前端数怎么读：WebKit 把高精度时钟粗化过，
    /// 本机实测**粗化到 1 ms**（T4/T5/T5b/FCP/LCP 全是整数，而 Rust 侧带小数）
    /// ⇒ `t5_ms = 0` 的含义是「**不到 1 ms**」，⛔ 不是「零成本」。
    /// 这一条不写下来的话，报告里"0"会被当成"不用管"。
    clock_ms: Option<f64>,

    /// `#doc` 里的元素数（`querySelectorAll('*')`）与含文本节点的全树节点数。
    /// ⭐ 这两个才是 §7.2 第 9 条要的"DOM 节点数"（⛔ `childElementCount` 不是，§10.3）。
    doc_elements: u64,
    doc_nodes_total: i64,

    /// 观测能力真值（`kb/0003`）与"观察器建起来了吗"。
    entry_types: Vec<String>,
    watching: serde_json::Value,
    /// 生效主题 / 正文字号。⚠️ 它们让"这次量的是哪套配色"不进推测。
    theme: String,
    reader_font_size: f64,
    user_agent: String,
}

/// 前端把批次 2 的样本报回来。
///
/// ⚠️ 这条命令**只在 `RMD_MEASURE=1` 时会被调用**（前端那个分支，
/// `main.js` 的 `if (MEASURE)`），而且**收到就退出**——它的全部用途是
/// 让 `tools/measure-gui.sh` 能一文件一进程地采一轮，⛔ 不是产品功能。
///
/// ⭐ 交付方式有两条，**同时**走：① stdout 上打一行带标记的 JSON
/// （`RMD_MEASURE_SAMPLE `，脚本按标记取，⛔ 不按固定行号——新增 `eprintln!` 会让
/// 行号漂移，`tools/smoke-gui.sh` 里已经吃过一次这个亏）；
/// ② 若设了 `RMD_MEASURE_OUT` 就**追加**一行到那个文件
/// （一个文件一行 JSON，回合之间不需要互相踩）。
///
/// ⚠️ `RMD_MEASURE_HOLD_MS`：报完之后**再多活一会儿**（默认 0）。
/// 它的唯一目的是让脚本有时间采样 WebView 进程的内存——**这不属于任何一段被测耗时**
/// （数字在这一行打印时就已经定型了）。
#[tauri::command]
fn report_measure(app: tauri::AppHandle, sample: MeasureSample) -> Result<(), String> {
    let line = serde_json::to_string(&sample).map_err(|e| format!("序列化测量样本失败：{e}"))?;
    println!("RMD_MEASURE_SAMPLE {line}");
    // ⚠️ 一并打一条人读的：脚本只按标记取机器那份，这一条是给排障用的。
    diag!(
        "▶ report_measure：{} · 源 {} B → HTML {} B · T1/2/3={:.1}/{:.1}/{:.1} ms · T4={:.1} ms · R={} ms · T5={:.1} T5b={:.1} · 滚动 T5c={:.1} T5d={:.1} 帧={} 容器={} {:.0}/{:.0} 滚到={:.0} · FCP={} LCP={} · 前端时钟刻度={} ms · DOM 元素 {} 节点 {}",
        if sample.file.is_empty() { "（无路径）" } else { &sample.file },
        sample.source_bytes,
        sample.html_bytes,
        sample.t1_ms,
        sample.t2_ms,
        sample.t3_ms,
        sample.t4_ms,
        match sample.r_ms {
            Some(v) => format!("{v:.1}"),
            None => "（无）".to_string(),
        },
        sample.t5_ms,
        sample.t5b_ms,
        sample.t5c_ms,
        sample.t5d_ms,
        match sample.t5e_ms {
            Some(v) => format!("{v:.1}"),
            None => "（无）".to_string(),
        },
        sample.scroll_height,
        sample.scroll_el,
        sample.client_height,
        sample.scroll_top,
        match sample.t6_fcp_ms {
            Some(v) => format!("{v:.1}"),
            None => "（无）".to_string(),
        },
        match sample.t6b_lcp_ms {
            Some(v) => format!("{v:.1}"),
            None => "（无）".to_string(),
        },
        match sample.clock_ms {
            Some(v) => format!("{v}"),
            None => "（没量到）".to_string(),
        },
        sample.doc_elements,
        sample.doc_nodes_total,
    );

    if let Some(path) = std::env::var_os("RMD_MEASURE_OUT") {
        use std::io::Write;
        let path = std::path::PathBuf::from(path);
        match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            Ok(mut f) => {
                if let Err(e) = writeln!(f, "{line}") {
                    // ⚠️ 写不进去**不致命**：stdout 那一份还在，脚本能兜住。
                    //    ⛔ 但也⛔ 不许静默——降级要显式（`INV-EXT-04` 的同一条精神）。
                    diag_stderr!("⚠️ RMD_MEASURE_OUT 写不进去（{}）：{e}", path.display());
                    diag_file!(
                        "⚠️ RMD_MEASURE_OUT 写不进去 path={} err_class={} err_len={}",
                        path.display(),
                        logging::err_class(&e),
                        e.to_string().len()
                    );
                }
            }
            Err(e) => {
                diag_stderr!("⚠️ 打不开 RMD_MEASURE_OUT（{}）：{e}", path.display());
                diag_file!(
                    "⚠️ 打不开 RMD_MEASURE_OUT path={} err_class={} err_len={}",
                    path.display(),
                    logging::err_class(&e),
                    e.to_string().len()
                );
            }
        }
    }

    // ⭐ 给脚本留出采样内存的窗口。⚠️ **在这之前数字就已经定型**，
    //    所以"多活一会儿"不会污染任何一个被测分段。
    //
    // ⚠️ 两条都走 `app.exit(0)`，⛔ **不用 `std::process::exit`**：
    //    stdout 是**管道**时（脚本里就是）它是块缓冲的，`process::exit` 会直接
    //    丢掉还没刷出去的那行 JSON——**量到最后什么都没落盘**，而退出码是 0。
    //    这里先显式 flush 一次，再把退出的动作交给正常的关闭路径。
    let _ = std::io::Write::flush(&mut std::io::stdout());
    let hold = std::env::var("RMD_MEASURE_HOLD_MS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if hold > 0 {
        // ⚠️ 起一条线程去睡，⛔ 不在这条命令里 `sleep`：这条命令跑在 IPC 的调度线程上，
        //    阻塞它会让"退出"这个动作本身也晚掉（那时脚本看到的就不是我们想控制的那一刻）。
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(hold));
            handle.exit(0);
        });
    } else {
        app.exit(0);
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// 单测（`design/0010` §7）
// ⚠️ 本模块在 `--features gui` 之外不存在 ⇒ 这些测试要用
//    `cargo test --release --features gui` 跑，⛔ `make test` 看不到它们。
// ⛔ **别为了"让 make test 跑得到"把表挪去别的模块**（`.agent/spec.md` 纪律 2）。
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// id 不许重复。⚠️ 重复的表现是**设置界面里那一条查不到 / 点不动**
    /// （`shortcut(id)` 只返回第一个），而按键照旧生效——静默的错误内容。
    #[test]
    fn 表中_id_两两不同() {
        for (i, a) in SHORTCUTS.iter().enumerate() {
            for b in &SHORTCUTS[i + 1..] {
                assert_ne!(a.id, b.id, "id 重复：{}", a.id);
            }
        }
    }

    /// ⭐ **同一个键只能有一个主人**（`INV-SET-04`）。这条是本次能自动守住的核心。
    ///
    /// ⚠️ 判据是 **`accel` 规范化之后的字符串相等**，⛔ 不是 `aliases`——
    /// 别名（`Cmd+_` / `Cmd++`）本来就与 `accel` **指向同一个动作**，不算冲突。
    /// 冲突只可能出现在**两个不同动作**之间。
    #[test]
    fn 表中_accel_两两不同() {
        for (i, a) in SHORTCUTS.iter().enumerate() {
            for b in &SHORTCUTS[i + 1..] {
                assert_ne!(
                    split_accel(a.accel),
                    split_accel(b.accel),
                    "两个动作共用同一个键：{} 与 {} 都是 {}",
                    a.id,
                    b.id,
                    a.accel
                );
            }
        }
    }

    /// ⭐ **每个 `accel` 都真的能解析**（`design/0010` §7）。
    ///
    /// # 为什么这一条比它看起来重要
    ///
    /// `MenuItemBuilder::accelerator` 内部是 `s.as_ref().parse().ok()`
    /// （`tauri-2.12.3/src/menu/normal.rs:34`）——**解析失败会被静默丢掉**。
    /// ⇒ 表里一个拼错的键会变成一个**没有快捷键的菜单项**，
    /// 编译过、运行过、菜单也在，**就是不响应**。这个测试是唯一能在 CI 里发现它的地方。
    ///
    /// ⛔ **只测 `accel`，不测 `aliases`**：别名的键名里有 `_` 与 `+` 两个
    /// `muda` 的键名表**根本不认**的键（`accelerator/mod.rs:278-296`），
    /// 把它们喂进来必然 `Err`——那不是缺陷，是别名**本来就只给前端匹配器用**。
    #[test]
    fn 每个_accel_都能被_muda_解析() {
        // ⚠️ 路径是 `muda::accelerator::Accelerator`——⛔ **不是** `muda::Accelerator`：
        //    `muda` 的 crate 根只 re-export 了菜单那几件（`Menu`/`MenuItem`/`MenuId`…），
        //    `Accelerator` 在 `accelerator` 子模块里（`muda-0.20.0/src/lib.rs:81` 的用例也这么写）。
        for s in SHORTCUTS {
            let parsed: Result<muda::accelerator::Accelerator, _> = s.accel.parse();
            assert!(
                parsed.is_ok(),
                "{} 的 accel {:?} 解析不了（{:?}）——它会被静默丢成一个没有快捷键的菜单项",
                s.id,
                s.accel,
                parsed.err()
            );
        }
    }

    /// 显示串**由 `accel` 派生**（`INV-SET-01`），顺序按 Apple 的 `⌃⌥⇧⌘`。
    #[test]
    fn display_按_apple_的修饰键顺序派生() {
        assert_eq!(display("Cmd+,"), "⌘,");
        assert_eq!(display("Cmd+B"), "⌘B");
        // ⚠️ `⇧⌘O` 而不是 `⌘⇧O`——顺序是**规定**的，不是"看着顺眼"。
        assert_eq!(display("Shift+Cmd+O"), "⇧⌘O");
        assert_eq!(display("Cmd+0"), "⌘0");
        assert_eq!(display("Cmd+-"), "⌘-");
        assert_eq!(display("Cmd+="), "⌘=");
        assert_eq!(display("Ctrl+Alt+Shift+Cmd+X"), "⌃⌥⇧⌘X");
        // ⚠️ 别名长什么样**不归它管**：设置界面里列的是 `accel`，⛔ 不列 `Ctrl` 别名。
        assert_eq!(display("Cmd+Ctrl+Z"), "⌃⌘Z");
    }

    /// ⭐ `split_accel` 必须**照 muda 的规则**切（`rfind('+')` + 空键名 ⇒ `"+"`）。
    ///
    /// ⚠️ 这一条守的是"**别自己发明一套**"：两份规则一旦分叉，
    /// 设置界面显示的键就会与真正装上去的**不是同一个**。
    #[test]
    fn split_accel_与_muda_同规则() {
        assert_eq!(split_accel("Cmd+,"), ("Cmd", ","));
        assert_eq!(split_accel("Shift+Cmd+O"), ("Shift+Cmd", "O"));
        // ⭐ 难点在这里：`"+"` 自己就是键名，`rfind` 切出来右边是空的。
        assert_eq!(split_accel("Cmd++"), ("Cmd", "+"));
        assert_eq!(split_accel("Cmd+-"), ("Cmd", "-"));
        // ⚠️ 没有修饰键时左边是空串（`muda` 允许裸键，本表里没有，但函数要自洽）
        assert_eq!(split_accel("F5"), ("", "F5"));
    }

    /// ⭐ **设了菜单加速键的 = `Owner::Menu` 的**（`INV-SET-04` 的两个方向）。
    ///
    /// ⚠️ `install_menu` 每次启动也核对一次同一件事；这里是**静态**那一半。
    #[test]
    fn 装进菜单的项恰好是_owner_menu_的那些() {
        let menu_ids: Vec<&str> = SHORTCUTS
            .iter()
            .filter(|s| s.owner == Owner::Menu)
            .map(|s| s.id)
            .collect();
        assert_eq!(
            menu_ids, MENU_ITEM_IDS,
            "owner=Menu 的 id 与 MENU_ITEM_IDS 不一致 ⇒ 要么有项被设了原生加速键却归 Web，\
             要么反过来（后者会让键**按不动**）"
        );
        // ⛔ 反向也要成立：`Owner::Web` 的项**一个都不许**出现在**带键**的那份清单里——
        // 否则 AppKit 会先吞掉它，前端那条监听**永远收不到**（`INV-SET-04`）。
        // ⚠️ 注意别把这条读成"Web 的项不许进菜单"：`design/0006` 起
        //    `PLAIN_MENU_ITEM_IDS`（**无**加速键）就是专门给 Web 项准备的，
        //    两者不是一回事（那份由下面那条测试单独管）。
        for s in SHORTCUTS.iter().filter(|s| s.owner == Owner::Web) {
            assert!(
                !MENU_ITEM_IDS.contains(&s.id),
                "{} 是 Owner::Web，却被设了菜单加速键 ⇒ 按下去会被 AppKit 吞掉，前端听不见",
                s.id
            );
        }
    }

    /// ⭐ **无加速键的菜单项**（`design/0006` §9.3 第 2 条）的两个方向。
    ///
    /// ⚠️ 这一条是 2026-10-14 拆出来的：`MENU_ITEM_IDS` 的语义被收窄成
    /// "**带原生加速键**的"，于是无加速键那半边**没有测试就会漂**——
    /// 最常见的一种漂法是把一个 `Owner::Menu` 的项写进来（那会让它在菜单里
    /// **丢掉加速键**：菜单还能点，但 `⌘X` 突然不灵了，而没有任何报错）。
    #[test]
    fn 无加速键的菜单项必须是_owner_web_且不在带键清单里() {
        for id in plain_menu_ids() {
            let s = shortcut(id).unwrap_or_else(|| panic!("{} 不在快捷键表里", id));
            assert_eq!(
                s.owner,
                Owner::Web,
                "{} 归 Owner::Menu ⇒ 它在菜单里会**丢掉加速键**（`install_menu` 不设它）",
                id
            );
            assert!(
                !MENU_ITEM_IDS.contains(&id),
                "{} 同时在两份清单里 ⇒ 同一项被要求「有键」又「没键」",
                id
            );
            // ⚠️ 它仍然**必须**有一个 `accel`：菜单项不设它，但前端那条监听要用它
            //    （`⇧⌘E`/`⌘F` 都是靠这个字段送到前端的，见 `ShortcutDto::accel`）。
            assert!(!s.accel.trim().is_empty(), "{} 没有 accel ⇒ 前端那条监听无从建起", id);
        }
    }

    /// ⭐ **无加速键项的插入位置必须落在它那个子菜单的真实范围内**（2026-10-14 加）。
    ///
    /// ⚠️ **为什么值得一条测试**：`install_menu` 用的是 `Submenu::insert(item, position)`，
    /// 而 `muda` 对**越界的 `position` 不报错**（插到末尾）。
    /// ⇒ 写错一个数（比如把 `Edit` 的 7 写成 17）的表现是
    /// 「菜单项**静默**跑到 `Select All` 后面老远」——⛔ 而启动、点击、键盘路径**全都正常**，
    /// 只有人打开菜单才看得出来。这正是本项目最怕的形态（不报错的数）。
    ///
    /// ⚠️ 2026-10-24（`design/0038`）口径改成「`position` = 排在这一项前面的**非分隔线元素**个数」：
    /// 上限 = **原菜单项数 ＋ 本组里排在它前面的项数**（原来写成"≤ 原菜单项数"，
    /// 那在 `File` 只有 1 项、却要连放 5 个新项之后就不成立了）。
    /// ⭐ 另外**同一组里必须严格递增**：不递增时后一项会被插到前一项**前面**去（静默）。
    #[test]
    fn 无加速键项的插入位置在子菜单的已知范围内() {
        // `kb/0016` §1：macOS 上 Tauri 默认菜单这两个子菜单的确切构成（真机读出来的）。
        // ⚠️ 数字**会随 Tauri 升级变**——变了就该在这里红一次，然后人去读一遍新布局。
        let known: &[(&str, usize)] = &[("File", 1), ("Edit", 7)];
        for p in PLAIN_MENU_ITEMS {
            let n = known
                .iter()
                .find(|(t, _)| *t == p.submenu)
                .unwrap_or_else(|| {
                    panic!(
                        "「{}」不在已知子菜单表里 ⇒ 先按标题读一遍它的构成（kb/0016 §1 那把读法）",
                        p.submenu
                    )
                })
                .1;
            let group: Vec<&PlainMenuItem> =
                PLAIN_MENU_ITEMS.iter().filter(|q| q.submenu == p.submenu).collect();
            let i = group.iter().position(|q| q.id == p.id).expect("自己总在组里");
            assert!(
                p.position <= n + i,
                "「{}」里的 {} 想插在 {}，而该子菜单原菜单 {} 项 ＋ 本组在它之前的 {} 项 ⇒ 会**静默**插到末尾",
                p.submenu,
                p.id,
                p.position,
                n,
                i
            );
            if i > 0 {
                assert!(
                    group[i - 1].position < p.position,
                    "「{}」里 {} 的位置 {} 没有大于前一项 {} 的 {} ⇒ 会被插到它**前面**（静默）",
                    p.submenu,
                    p.id,
                    p.position,
                    group[i - 1].id,
                    group[i - 1].position
                );
            }
        }
    }

    /// ⭐⭐ **插完之后菜单长什么样**（2026-10-15，`design/0012` 加）。
    ///
    /// ⚠️ 上面那条只证"下标在范围内"，⛔ 证不了"落点对"。而落点错了**没有报错**：
    /// `muda` 对越界下标会插到末尾，菜单照样能用。⭐ 这条把"这张表 ⇒ 最终的项序"
    /// 变成可断言的（`placements` 是纯函数，就是为它抽的）。
    ///
    /// ⚠️ 模拟的是 `Vec::insert` 的语义（`Submenu::insert` 同义），
    /// 并且**必须按 `install_menu` 的插入顺序**逐个插：下标是**当时那个表状态**下的下标
    /// （`sep: Before` 先插线、`After` 先插项），⛔ 换个顺序插就落到别处去。
    /// ⇒ 空字符串代表分隔线。
    #[test]
    fn 无加速键项插完之后的菜单顺序() {
        // `kb/0016` §1：macOS 上 Tauri 默认菜单的确切构成（真机读出来的）。
        // ⚠️ 空字符串代表**上游本来就有的**分隔线（`Edit` 那条 `Cut` 之前就有一条）。
        let originals: &[(&str, &[&str])] = &[
            ("File", &["Close Window"]),
            ("Edit", &["Undo", "Redo", "", "Cut", "Copy", "Paste", "Select All"]),
        ];
        let want: &[(&str, &[&str])] = &[
            // ⭐ `File`（`design/0038` §2.3）：三个打开入口连成一串，只有最后一条带线；
            //    然后才是 `保存`、`用外部编辑器打开`（各自带一条下分隔线）
            ("File", &[
                "file.open-directory",
                "file.open-file",
                "file.quick-open",
                "",
                "file.save",
                "",
                "file.open-external-editor",
                "",
                "Close Window",
            ]),
            // ⭐ `Edit`：`查找…` 在 `Select All` 之后，带一条上分隔线（Apple 的惯例）
            ("Edit", &[
                "Undo", "Redo", "", "Cut", "Copy", "Paste", "Select All", "", "edit.find",
            ]),
        ];
        for (title, expected) in want {
            let orig = originals.iter().find(|(t, _)| t == title).expect("子菜单要在表里").1;
            let mut list: Vec<&str> = orig.to_vec();
            let group: Vec<&PlainMenuItem> =
                PLAIN_MENU_ITEMS.iter().filter(|p| p.submenu == *title).collect();
            for (p, place) in group.iter().zip(placements(&group)) {
                // ⚠️ 复刻 `install_menu` 的插入顺序（`None` 一条线都没有）
                match p.sep {
                    SepSide::Before => {
                        list.insert(place.sep_at.expect("Before"), "");
                        list.insert(place.item_at, p.id);
                    }
                    SepSide::After => {
                        list.insert(place.item_at, p.id);
                        list.insert(place.sep_at.expect("After"), "");
                    }
                    SepSide::None => {
                        assert!(place.sep_at.is_none(), "SepSide::None 不该算出 sep_at");
                        list.insert(place.item_at, p.id);
                    }
                }
            }
            assert_eq!(&list[..], *expected, "「{title}」插完之后的顺序不对");
        }
    }

    /// ⭐ 同一子菜单里的项，**插入位置不许重复**（2026-10-14 加）。
    /// ⚠️ 重复的表现不是崩溃，是"两项挤在一起、顺序取决于表里的先后"——
    /// 菜单还能用，只是与你写的字面不一致。⇒ 判据只能是"位置唯一"。
    #[test]
    fn 同一子菜单里的插入位置互不相同() {
        for (i, a) in PLAIN_MENU_ITEMS.iter().enumerate() {
            for b in &PLAIN_MENU_ITEMS[i + 1..] {
                if a.submenu != b.submenu {
                    continue;
                }
                assert_ne!(
                    a.position, b.position,
                    "「{}」里的 {} 与 {} 都插在 {}",
                    a.submenu, a.id, b.id, a.position
                );
            }
        }
    }

    /// ⚠️ 每条都要有给人看的文案，且不许与 id 抄成同一个。
    ///
    /// ⭐ `design/0025` 起**两门语言各查一遍**：`label_zh` / `label_en` 是**两条独立**的
    /// 字段，只查一门的话另一门空着也能过——而空的英文文案在菜单里就是**一行没有字的菜单项**，
    /// 点得到、也点得动，只是没人知道它是什么。
    /// ⚠️ 唯一性**按语言分别判**：中英两门之间重复是正常的（`查找…` / `Find…` 本就不必不同）。
    #[test]
    fn 每项都有两门文案且同一门里没有重复() {
        for (i, a) in SHORTCUTS.iter().enumerate() {
            assert!(!a.label_zh.trim().is_empty(), "{} 没有中文文案", a.id);
            assert!(!a.label_en.trim().is_empty(), "{} 没有英文文案", a.id);
            // ⚠️ 拿 id 当文案同样是"空着一行"的变体：屏幕上显示 `file.save` 这种东西。
            assert_ne!(a.label_zh, a.id, "{} 的中文文案抄成了 id", a.id);
            assert_ne!(a.label_en, a.id, "{} 的英文文案抄成了 id", a.id);
            for b in &SHORTCUTS[i + 1..] {
                assert_ne!(a.label_zh, b.label_zh, "两条用了同一句中文文案：{}", a.label_zh);
                assert_ne!(a.label_en, b.label_en, "两条用了同一句英文文案：{}", a.label_en);
            }
        }
    }

    // ── `design/0025` §7.2：菜单重贴计划的链形状 ─────────────────────────
    //
    // ⚠️ 这一族的判据是**集合与文案**，⛔ 不是"真的改到了菜单"——后者要 `AppHandle`，
    //    由 `RMD_MENU_PROBE=1`（§7.1 步骤 0a，`menu_probe`）取证。
    //    ⚠️ 两半**互补**：这里守"该改哪几项、改成什么"，探针守"改得到、读得回"。

    /// ⭐ **重贴集合恰好是 `MENU_ITEM_IDS` ＋ `app_menu_ids()` ＋ `plain_menu_ids()`**
    /// （`design/0025` 评审 #5；`design/0033` 加了中间那一段）。
    ///
    /// ⚠️ 少一项的表现是"切了语言，菜单里那一行还是旧语言"——**没有任何报错**，
    /// 菜单其余部分看起来完全正常 ⇒ 这条等式是唯一能自动发现它的地方。
    /// ⚠️ 顺带钉住**顺序**：`relabel_plan` 用 `filter_map` 收窄，一旦有人改成先排序，
    /// 计划与菜单的对应关系就没人保证了。
    #[test]
    fn 菜单重贴计划恰好覆盖装进菜单的全部项() {
        let want: Vec<&str> = MENU_ITEM_IDS
            .iter()
            .copied()
            .chain(app_menu_ids())
            .chain(plain_menu_ids())
            .collect();
        for lang in [crate::lang::Lang::Zh, crate::lang::Lang::En] {
            let plan = relabel_plan(lang);
            let got: Vec<&str> = plan.items.iter().map(|(id, _)| *id).collect();
            assert_eq!(
                got, want,
                "{} 的重贴计划与「带键清单＋无键清单」不一致 —— \
                 差集里的项会**静默**留旧语言",
                lang.tag()
            );
            // ⚠️ 三个子菜单标题一个都不能少（`File`/`Edit`/`View`）。
            let subs: Vec<&str> = plan.submenus.iter().map(|(en, _)| *en).collect();
            assert_eq!(subs, vec!["File", "Edit", "View"], "子菜单标题集合不对");
        }
    }

    /// ⭐ 计划里的文案**逐条来自表**（⛔ 不是另抄一份）。
    ///
    /// ⚠️ 两门语言必须给出**不同的**计划：如果 `label(lang)` 被写成"总是取 `label_zh`"，
    /// 集合那条照样绿，而切英文时菜单**一个字都不会变** —— 这条就是为它写的。
    #[test]
    fn 菜单重贴计划的文案来自表且两门不同() {
        let zh = relabel_plan(crate::lang::Lang::Zh);
        let en = relabel_plan(crate::lang::Lang::En);
        for ((id, text), (_, text_en)) in zh.items.iter().zip(en.items.iter()) {
            // ⚠️ 两张表都查：`SHORTCUTS`（带键）与 `APP_MENU_ITEMS`（应用子菜单那两项）。
            let want_zh =
                menu_label(id, crate::lang::Lang::Zh).unwrap_or_else(|| panic!("{id} 不在任何菜单表里"));
            let want_en =
                menu_label(id, crate::lang::Lang::En).unwrap_or_else(|| panic!("{id} 不在任何菜单表里"));
            assert_eq!(*text, want_zh, "{id} 的中文文案不是从表里取的");
            assert_eq!(*text_en, want_en, "{id} 的英文文案不是从表里取的");
            assert_ne!(text, text_en, "{id} 两门文案相同 ⇒ 切语言时这一行不会变");
        }
        assert_ne!(zh, en, "两门语言的重贴计划整体相同");
    }

    /// ⭐ 应用子菜单那两项的**表内自洽**（`design/0033`）。
    ///
    /// ⚠️ 它们不在 `SHORTCUTS` 里 ⇒ 上面那条"每项都有两门文案"**覆盖不到它们**。
    /// 而一条没有文案的菜单项照样点得动，只是没人知道它是什么。
    #[test]
    fn 应用子菜单两项的文案与身份自洽() {
        assert_eq!(app_menu_ids(), vec![APP_MENU_INSTALL_ID, APP_MENU_UNINSTALL_ID]);
        for item in APP_MENU_ITEMS {
            assert!(!item.label_zh.trim().is_empty(), "{} 没有中文文案", item.id);
            assert!(!item.label_en.trim().is_empty(), "{} 没有英文文案", item.id);
            assert_ne!(item.label_zh, item.label_en, "{} 两门文案相同", item.id);
            // ⛔ 它们的 id 不许混进那两张"在 SHORTCUTS 里"的清单——
            //    那会让 `handle_menu_event` 的早退判据与 `install_menu` 的自洽断言对不上。
            assert!(shortcut(item.id).is_none(), "{} 不该在快捷键表里", item.id);
            assert!(!MENU_ITEM_IDS.contains(&item.id));
            assert!(!plain_menu_ids().contains(&item.id));
        }
        // ⭐ 「安装」带省略号（会弹框问落点），「卸载」不带（不弹框）。
        assert!(app_menu_label(APP_MENU_INSTALL_ID, crate::lang::Lang::Zh).unwrap().ends_with('…'));
        assert!(app_menu_label(APP_MENU_INSTALL_ID, crate::lang::Lang::En).unwrap().ends_with('…'));
        assert!(!app_menu_label(APP_MENU_UNINSTALL_ID, crate::lang::Lang::Zh).unwrap().ends_with('…'));
        assert!(!app_menu_label(APP_MENU_UNINSTALL_ID, crate::lang::Lang::En).unwrap().ends_with('…'));
    }

    /// ⭐ **子菜单标题必须接受两种写法**（`design/0025` §2.3 末与 §6 的失败模型）。
    ///
    /// ⚠️ 只认英文的表现是"**第一次**切成功、**第二次**失败"——因为第一次之后
    /// 子菜单就叫「文件/编辑/视图」了，再按 `File` 找就是 `None`。
    /// ⚠️ 反过来也必须认：**英文是两个词**（`File` 与 `文件`），认错了就漏。
    #[test]
    fn 子菜单标题两种写法都认且按语言取() {
        for (en, zh) in [("File", "文件"), ("Edit", "编辑"), ("View", "视图")] {
            let both = submenu_titles(en);
            assert!(both.contains(&en), "{en} 的英文标题不在可认清单里");
            assert!(both.contains(&zh), "{en} 的中文标题不在可认清单里");
            assert_eq!(both.len(), 2, "{en} 的可认标题应当恰好两种");
            assert_eq!(submenu_title(en, crate::lang::Lang::Zh), zh);
            assert_eq!(submenu_title(en, crate::lang::Lang::En), en);
        }
        // ⚠️ 认不出来的键 ⇒ **空清单**。`find_submenu` 用的是 `any()`，
        //    空清单天然不匹配 —— ⛔ 别把它改成 `unwrap_or(&[en])` 那种"兜底"，
        //    那会让一个拼错的键悄悄匹配上别的子菜单。
        assert!(submenu_titles("Nope").is_empty());
    }

    /// ⭐ **送到前端的每一项都必须带 `accel`**（2026-10-14 实施时踩出来的）。
    ///
    /// ⚠️ **为什么这条值得单独立一个测试**：`display` 是 `⌘O` 这种**字形**，
    /// 前端那台匹配器认的是 `Cmd` / `Ctrl` 这些**词**。只送 `display` 时，
    /// 前端 `buildBindings` 拿不到可匹配的键 ⇒ **只挂上别名**：
    /// `Ctrl+O` 能开目录、`⌘O` **按下去什么都不发生**——而菜单上写着 `⌘O`、
    /// 设置界面里也写着 `⌘O`，**没有任何一处报错**。
    ///
    /// ⛔ 所以判据不能是"能不能编译"，只能是"**这一格有没有值**"。
    /// 前端侧的对偶（`buildBindings` 遇到没 `accel` 的 `web` 项要**响亮报错**）
    /// 在 `tests/js/keymap.test.js` 里。
    #[test]
    fn 送到前端的每一项都带_accel_与_display() {
        let dtos = get_shortcuts();
        assert_eq!(dtos.len(), SHORTCUTS.len());
        for d in &dtos {
            assert!(!d.accel.trim().is_empty(), "{} 没有 accel —— 前端的规范键会静默失效", d.id);
            assert!(!d.display.trim().is_empty(), "{} 没有 display", d.id);
            // ⭐ `design/0025`：**两门文案一起送**（设置覆盖层开着时也能切语言）。
            assert!(!d.label_zh.trim().is_empty(), "{} 没有 label_zh", d.id);
            assert!(!d.label_en.trim().is_empty(), "{} 没有 label_en", d.id);
            // ⚠️ `accel` 必须是 **muda 词法**（字母），⛔ 不许把 `display` 抄过来 ——
            //    抄过来的话前端 `MOD_NAMES` 认不出 `⌘`，症状与"没送 accel"**一模一样**。
            assert!(
                !d.accel.contains('⌘') && !d.accel.contains('⇧') && !d.accel.contains('⌃') && !d.accel.contains('⌥'),
                "{} 的 accel 里出现了显示字形：{}",
                d.id,
                d.accel
            );
            for s in SHORTCUTS.iter().filter(|s| s.id == d.id) {
                assert_eq!(d.accel, s.accel, "{} 的 accel 与表不一致", d.id);
                assert_eq!(d.display, display(s.accel), "{} 的 display 不是由 accel 派生的", d.id);
                assert_eq!(d.label_zh, s.label_zh, "{} 的 label_zh 与表不一致", d.id);
                assert_eq!(d.label_en, s.label_en, "{} 的 label_en 与表不一致", d.id);
            }
        }
    }

    /// ⭐ **前端的回报一定收得下**——每一个**计数器**都得能吃下 `-1`。
    ///
    /// # 为什么必须有这一条（`docs/bugs/0003`）
    /// 前端把 `-1` 当作"**这一轮没跑**"的哨兵（`find_hits`/`find_miss`＝没有已挂载的文档，
    /// `preview_req`＝还没发过 `render_preview`），这与"跑了但是 0"是**两种不同的状态**，
    /// ⛔ 不能合并成 0。而 Tauri 在**进命令体之前**反序列化：
    /// 只要有一个计数器被声明成无符号，那一次的 `report_status` 就**整条失败**，
    /// 命令体的 `eprintln!` **一行都不会执行**——`RMD_SMOKE` 也就永远等不到回报。
    ///
    /// ⚠️⚠️ 而前端两个调用点（`report()` / `reportFatal()`）都把它吞在 `try/catch` 里
    /// ⇒ 表现是 **`make smoke` 挂死、零输出、`make test` 全绿**。
    /// `design/0012` 加 `preview_req` 时照抄了旁边 `find_segments: u64` 的写法，
    /// 却没跟着 `find_hits`/`find_miss` 那条 `-1` 契约走，**当场就是这个形态**。
    ///
    /// ⛔ 所以判据不是"字段类型看起来对不对"，而是**真的反序列化一次**——
    /// 把 `-1` 送进去，看能不能读回来。少了这一条，下一回加计数器还会踩同一个坑。
    #[test]
    fn 每个计数器都吃得下_负一_哨兵() {
        // ⚠️ 载荷形状照 `src/main.js::report()` 抄**最小**一份：必填那九个 + 全部计数器。
        //    ⛔ 别把它写成"完整的一份"——那种字面量会漂移，而漂移之后的绿是假的。
        let payload = serde_json::json!({
            // ── 九个**没有** `#[serde(default)]` 的必填项 ──
            "ok": true,
            "summary": "测试",
            "doc_children": 0,
            "scroll_height": 0.0,
            "viewport_height": 0.0,
            "text_len": 0,
            "sample": "",
            "entry_types": [],
            "user_agent": "test",
            // ── 逐条计数器：全部按"这一轮没跑"送 `-1` ──
            "find_segments": 0,     // ⚠️ 它没有 `-1` 语义（段数只可能 ≥ 0）
            "find_hits": -1,        // design/0011 §3
            "find_miss": -1,        // design/0011 §3
            "preview_req": -1,      // design/0012 §2.6-2 ← **本条的出事点**
            // ── 其余整型观测量：空会话里都是 0 ──
            "tree_nodes": 0,
            "tree_ignored": 0,
            "tree_current": 0,
            "shortcuts": 0,
            "watch_seq": 0,
            "watch_dropped": 0,
        });

        let r: FrontendReport = serde_json::from_value(payload).unwrap_or_else(|e| {
            panic!(
                "前端的回报收不下：{e}\n\
                 ⇒ 多半是某个计数器被声明成了**无符号**，而前端按契约送的是 `-1`。\n\
                 ⇒ 后果不是「这个字段读出来是 0」，而是**整条 `report_status` 失败**、\
                 `make smoke` 挂死且零输出（`docs/bugs/0003`）。"
            )
        });

        // ⚠️ 读回来还得**真是 -1**：`#[serde(default)]` 会在**缺字段**时给 0，
        //    把 -1 悄悄变成 0 就等于把"没跑"读成"跑了 0 处"——那是另一类静默错误。
        assert_eq!(r.find_hits, -1, "find_hits 的 -1 哨兵没保住");
        assert_eq!(r.find_miss, -1, "find_miss 的 -1 哨兵没保住");
        assert_eq!(r.preview_req, -1, "preview_req 的 -1 哨兵没保住");
    }

    /// ⭐ 对偶：**缺字段**时（旧前端）必须能收下，靠的是 `#[serde(default)]`。
    ///
    /// ⚠️ 判据是"发版后新旧两端可以各自升级"——前端的回报少了 0012 那几个字段时，
    /// 后端⛔ **不能**因此拒收整条回报（那就又是"挂死且零输出"）。
    /// ⛔ 但必填那九个**不许**被放宽：它们是"这份回报是不是真的"的底。
    #[test]
    fn 缺了可选字段的旧回报也收得下() {
        let payload = serde_json::json!({
            "ok": true, "summary": "", "doc_children": 0,
            "scroll_height": 0.0, "viewport_height": 0.0, "text_len": 0,
            "sample": "", "entry_types": [], "user_agent": "",
        });
        let r: FrontendReport = serde_json::from_value(payload)
            .expect("0012/0011 那几个字段缺着时也该收得下");
        assert_eq!(r.preview_req, 0, "缺字段时 `default` 给的应是 0（⛔ 不是 -1）");
        assert!(r.preview_stale == false);
        // ⭐ `design/0012` §11：滚动同步那一个字串同理——旧前端不发它时收成空串。
        assert!(r.sync_state.is_empty(), "缺字段时 `sync_state` 应是空串（⛔ 不是 panic）");

        // ⚠️ 反过来：必填项缺了**必须**报错，⛔ 别让它也静默变默认值。
        let 缺必填 = serde_json::json!({ "summary": "", "user_agent": "" });
        assert!(
            serde_json::from_value::<FrontendReport>(缺必填).is_err(),
            "必填项缺了还收得下 ⇒ `ok`/`doc_children` 这些会静默变成 false/0，判据全废"
        );
    }

    // ── `design/0022` §7.2：16 条无窗口判据 ──────────────────────────────
    //
    // ⚠️ 这一族**一条都不建窗口**：`decide` 是纯函数，`detach_self_with` 的
    //    预检与拉起都是注入进来的 ⇒ "创建失败"与"退出码"能在这里断言。
    //    ⛔ 真 GUI 启动 / 前台激活 / 关终端后存活**不在**这里（§7.4 人工）。

    use std::cell::Cell;
    use std::os::unix::ffi::OsStringExt;

    #[test]
    fn 只有两个_fd_都是终端才分离() {
        assert_eq!(
            decide(false, false, false, true, true),
            DetachDecision::Detach,
            "四象限①：这就是用户原话的形态"
        );
        assert_eq!(
            decide(false, false, false, true, false),
            DetachDecision::NoTty,
            "⚠️ `2>log` ⇒ 不分离：否则用户明确要捕获的诊断会被 stdio=null 吞掉（评审 R4）"
        );
        assert_eq!(
            decide(false, false, false, false, true),
            DetachDecision::NoTty,
            "四象限③：动了 stdout 同理"
        );
        assert_eq!(
            decide(false, false, false, false, false),
            DetachDecision::NoTty,
            "四象限④：所有自动化闸门都是这个形态 ⇒ 行为必须与今天逐字相同"
        );
    }

    #[test]
    fn 开关优先级是短路的且原因可断言() {
        assert_eq!(
            decide(false, true, false, true, true),
            DetachDecision::ForegroundEnv
        );
        assert_eq!(decide(false, false, true, true, true), DetachDecision::DiagEnv);
        assert_eq!(
            decide(true, false, false, true, true),
            DetachDecision::AlreadyChild
        );
        // ⭐ 全部为真时也必须报**最先命中**的那个 —— 顺序若被人重排，这条立刻红。
        assert_eq!(
            decide(true, true, true, true, true),
            DetachDecision::AlreadyChild
        );
    }

    #[test]
    fn 参数逐字节转发且丢掉_argv0_与系统参数() {
        let args = child_args(vec![
            OsString::from("/tmp/rmd"),
            OsString::from("-psn_0_12345"),
            OsString::from("我的 文档.md"),
            OsString::from_vec(vec![b'a', 0xff, b'b']),
            OsString::from("--看起来像选项"),
        ]);
        assert_eq!(
            args,
            vec![
                OsString::from("我的 文档.md"),
                OsString::from_vec(vec![b'a', 0xff, b'b']),
                OsString::from("--看起来像选项"),
            ],
            "空格/中文/非 UTF-8 都得原样；`-psn_` 走共用那份谓词"
        );
        assert_eq!(args.len(), 3, "⛔ 不许按空格切分、⛔ 不许丢 `--` 开头的参数");
    }

    #[test]
    fn 子进程规格带_分离标记且不碰其它环境变量() {
        let spec = child_spec().expect("测试进程自己的可执行文件路径应当取得到");
        assert_eq!(
            spec.env,
            vec![(OsString::from("RMD_DETACHED"), OsString::from("1"))],
            "只许加这一个变量 —— 多一个就是偷偷改用户环境"
        );
        assert!(!spec.args.iter().any(|a| a == "-psn_0_1"));
    }

    #[test]
    fn 判定不分离时根本不拉起子进程() {
        for d in [
            DetachDecision::AlreadyChild,
            DetachDecision::ForegroundEnv,
            DetachDecision::DiagEnv,
            DetachDecision::NoTty,
        ] {
            let spawned = Cell::new(0u32);
            let preflighted = Cell::new(0u32);
            let got = detach_self_with(
                d,
                None,
                |_| {
                    preflighted.set(preflighted.get() + 1);
                    Ok(())
                },
                |_| {
                    spawned.set(spawned.get() + 1);
                    Ok(())
                },
            );
            assert_eq!(got, None, "{d:?} 必须回落到前台路径");
            assert_eq!(spawned.get(), 0, "{d:?} 竟然拉起了子进程 —— 会开出两扇窗");
            assert_eq!(preflighted.get(), 0, "{d:?} 连预检都不该跑");
        }
    }

    #[test]
    fn 预检失败以_2_退出且不拉起子进程() {
        let spawned = Cell::new(0u32);
        let got = detach_self_with(
            DetachDecision::Detach,
            Some(Path::new("/definitely/not/here.md")),
            |_| Err("打不开 /definitely/not/here.md".to_string()),
            |_| {
                spawned.set(spawned.get() + 1);
                Ok(())
            },
        );
        assert_eq!(got, Some(2), "路径打错必须是**终端里**立刻可见的失败");
        assert_eq!(spawned.get(), 0);
    }

    #[test]
    fn 拉起成功只退出_0_且不等子进程() {
        let spawned = Cell::new(0u32);
        let got = detach_self_with(DetachDecision::Detach, None, |_| Ok(()), |spec| {
            spawned.set(spawned.get() + 1);
            assert!(
                spec.env.iter().any(|(k, v)| k == "RMD_DETACHED" && v == "1"),
                "子进程没带分离标记 ⇒ 它会再分离一次（无限递归）"
            );
            Ok(())
        });
        assert_eq!(got, Some(0), "0 的语义 = 子进程已创建（⛔ 不是窗口已开）");
        assert_eq!(spawned.get(), 1, "⛔ 最多分离一次");
    }

    #[test]
    fn 拉起失败回落到前台而不是静默成功() {
        let got = detach_self_with(DetachDecision::Detach, None, |_| Ok(()), |_| {
            Err(std::io::Error::new(std::io::ErrorKind::NotFound, "没了"))
        });
        assert_eq!(got, None, "拉起失败必须自己当前台用（诚实回退）");
    }

    #[test]
    fn 预检确实拿到了启动路径() {
        let seen = Cell::new(false);
        let _ = detach_self_with(
            DetachDecision::Detach,
            Some(Path::new("/tmp/示例.md")),
            |p| {
                seen.set(p == Some(Path::new("/tmp/示例.md")));
                Err("停在这里就够".to_string())
            },
            |_| Ok(()),
        );
        assert!(seen.get(), "预检拿不到路径 ⇒ 它什么都没在检查");
    }

    /// 落点框的文案是**判据**，不只是给人看的（`cli_tool_install` 按**按钮标题**分派）。
    ///
    /// ⚠️ 这条挡的是三种"改文案改坏逻辑/改坏口径"的形态：
    /// ① 两个按钮的标题被改成**同一串** ⇒ 第二个永远点不中（分派只认第一个相等）；
    /// ② 标题里**丢了路径** ⇒ 用户看不懂装到哪，而代码仍然照常工作；
    /// ③ 两门语言**有一条漏了"密码"** ⇒ §2.2 H 那条"点之前就知道要不要密码"没了。
    /// ⛔ 它**不**断言句式与排版——那归人工观感（`design/0033` §10.5）。
    #[test]
    fn 落点框两门语言的路径与代价都在() {
        for (lang, tag, msg_word, btn_word) in [
            (crate::lang::Lang::Zh, "中文", "密码", "密码"),
            // ⚠️ 英文按钮用 `admin`（不是 `password`）：`/usr/local/bin (admin password)` 太长，
            //    会把三个按钮挤出**一行**（那正是用户报的"排版乱"）。`admin` 在 macOS 语境里
            //    就等于"会弹管理员密码框"，说明段里仍完整写着 `requires an admin password`。
            (crate::lang::Lang::En, "英文", "password", "admin"),
        ] {
            let d = location_dialog(lang);
            assert!(
                d.local.starts_with("~/.local/bin"),
                "{tag}：第一个按钮标题必须带路径（它是分派判据）"
            );
            assert!(
                d.system.starts_with("/usr/local/bin"),
                "{tag}：第二个按钮标题必须带路径（它是分派判据）"
            );
            assert_ne!(d.local, d.system, "{tag}：两个按钮标题相同 ⇒ 第二个永远点不中");
            for (what, s) in [("local", d.local), ("system", d.system), ("cancel", d.cancel)] {
                assert!(!s.is_empty(), "{tag}：{what} 标题是空的");
            }
            assert!(
                d.message.contains("~/.local/bin") && d.message.contains("/usr/local/bin"),
                "{tag}：说明里必须点出两个目录"
            );
            assert!(d.message.contains("PATH"), "{tag}：说明里必须提到 PATH");
            assert!(
                d.message.contains(msg_word) && d.system.contains(btn_word),
                "{tag}：要不要密码必须在**点之前**看得见（说明与按钮各一处）"
            );
        }
    }
}
