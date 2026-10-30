//! Tauri 的 build script（`design/0002` §10.4 批 1；`design/0003` §3 起列全命令）。
//!
//! # 为什么要 `#[cfg]` 包一层
//!
//! `tauri_build::build()` 会读 `tauri.conf.json`、校验 `capabilities/`、
//! 并把 Context 写进 `OUT_DIR`。这一切**只有链 Tauri 时才需要**。
//! CLI 构建（`rmd probe` / `rmd bench`）不该被 `tauri.conf.json` 的内容牵住——
//! 配置文件写错一个字，`cargo test` 也跟着挂掉，那种耦合没有收益。
//!
//! ⚠️ **代价要说清楚**：`tauri-build` 是 build-dependency，**无法做成 optional**
//! （Cargo 不支持 build-dependency 的 optional）。所以 CLI 构建**仍然会编译它**，
//! 只是不运行。省掉的是"运行 + 被配置牵住"，不是编译时间。
//!
//! ⚠️ 另一个容易踩的点：`tauri::generate_context!()` **不要**和
//! `tauri::tauri_build_context!()` 同时用（Tauri 源码 `src/lib.rs:300-304` 明写
//! "Do not use both at the same time"）。本仓库用前者，所以 `build.rs` 里
//! **不能**再调 `CodegenContext::Assets` 那条路。
//!
//! # ⭐ `app_manifest` 这一块（`design/0003` U1b，依据 `docs/kb/0007`）
//!
//! Tauri 2 的 ACL 闸门是**条件生效**的：只要 `plugin_command.is_some()`
//! **或**存在 app 级 ACL 清单 **或** 后端不是本地，就会强制校验。
//! 也就是说——**本仓库此前"没有 ACL"只是因为没踩到闸门**，不是没有这道闸。
//!
//! 一旦我们声明了 app 级清单（本函数就是），闸门就打开，**没列进
//! capability 的命令会直接被拒**。所以这里与 `capabilities/default.json`
//! 必须是**同一份名单**，且**同一次提交**改动（`docs/kb/0007` §3 的落地要求）。
//!
//! ⛔ 名字是 **snake_case**（Rust 函数名），别写成权限 id 的 kebab——
//! 两者不同（`list_dir` ↔ `allow-list-dir`），这是 `kb/0007` 里记下的坑。

fn main() {
    #[cfg(feature = "gui")]
    {
        let attributes = tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                // 会话 / 配置
                "get_session",
                // ⭐ `design/0015`：取走 Apple Event 的待打开队列（**读取命令**——
                //    ⛔ 不收路径、⛔ 不改授权；授权在 `gui::handle_open_urls` 里已走完）。
                //    ⚠️ 漏了它 = 双击第二份 `.md` 时后端队列涨了、前端却永远取不到
                //    （ACL 静默拒，表现是"窗口不换文档"，`kb/0007` 的同族形态）。
                "take_pending_open",
                "set_sidebar_width",
                // ⭐ `design/0041`：侧边栏形态（树 / 文档列表）。⚠️ 与 `set_sidebar_width`
                //    同族——**只写 `config.json`**（⛔ 不读文档、⛔ 不改授权），
                //    但 ACL 是静默拒的 ⇒ 漏了它就是"切形态重启后回到树、日志里一行都没有"。
                "set_sidebar_file_view",
                // ⚠️⚠️ **它曾经漏在这里**（`design/0004`/`0005` 落地时，2026-10-14 才发现）：
                //    没有这条，ACL 会**静默拒** `set_appearance` ⇒ 外观永不落盘
                //    （界面上主题照样变——那是乐观更新——重启后全回去）。
                //    详见 `docs/bugs/0002`。
                "set_appearance",
                // ⭐ `design/0025`：切换界面语言（**只写 `config.json` ＋ 重贴菜单**）。
                //    ⚠️ 漏了它 = 设置里选了语言、界面**一点反应都没有**，而日志里
                //    只有"命令没被调到"——ACL 静默拒那一族（`kb/0007`）。
                "set_language",
                // ⭐ 快捷键表（`design/0010`）。⚠️ 漏了它 = 前端 IPC 被 ACL 拒
                //    ⇒ 设置界面里那一列**永远是空的**（看起来像"没有快捷键"）。
                "get_shortcuts",
                // 授权（仅这三个能改授权，另加启动 argv 与 Apple Event 那两次；
                // ⭐ `design/0015` `INV-APP-02`：后两者走同一个 `authorize_startup`）
                "choose_directory",
                "choose_file",
                "close_directory",
                // ⭐ `design/0038`：进入一个**后端记过的**目录（启动页点一行 / 侧边栏
                //    「上次的目录」）。⚠️ 这是 `INV-FS-04` 的第四处授权写入点，
                //    收紧条件 = 白名单字面比较 ＋ 校验全部在写 `roots` 之前（`INV-START-02`）。
                //    ⛔ 漏了它 = 点行**无反应**、控制台一行拒绝，而 `⌘O` 照常（ACL 静默拒）。
                "open_recent_directory",
                // ⭐ `design/0043`：打开一条**收藏**。⚠️ 这是 `INV-FS-04` 的第五处授权写入点，
                //    收紧条件 = 绝对路径 ＋ 原串逐字命中记录 ＋ `canonicalize(请求) == 记录值`
                //    （`INV-FAV-03/08`）。⛔ 漏了它 = 点收藏行**无反应**（ACL 静默拒）。
                "open_favorite",
                // ⭐ `design/0043`：收藏的**唯一写入口**（操作枚举）。⚠️ 它**只写 `config.json`**
                //    （`Add` 先过当刻读取授权，⛔ 不改授权），但 ACL 静默拒 ⇒ 漏了它就是
                //    "右键收藏毫无反应、日志里一行都没有"。
                "favorites_apply",
                // ⭐ `design/0045`：最近目录的**唯一写入口**（删一条 / 清空，隐私）。⚠️ 它
                //    **只写 `config.json` 的 `dir_sessions` ＋ `last_directory`**
                //    （⛔ 不删磁盘上的东西、⛔ 不改授权、⛔ 不动收藏），但 ACL 静默拒 ⇒
                //    漏了它就是"点「清空」毫无反应、日志里一行都没有"（`kb/0007`）。
                "recent_apply",
                // 读取
                "list_dir",
                // ⭐ `design/0009`：文件名模糊搜索。⛔ 漏了它 = 浮层永远搜不出东西
                //    （ACL 静默拒 `invoke`，页面上只表现为"没有结果"）。
                "search_files",
                // ⭐ `design/0041`：文档列表（**读取命令**，与搜索共用同一份索引）。
                //    ⛔ 漏了它 = 列表永远空白（ACL 静默拒）。
                "list_documents",
                // ⭐ `design/0034`：新建文件 / 目录。⛔ 漏了它 = 右键菜单点下去
                //    只有一句"操作失败"（ACL 静默拒），日志里也没有创建记录。
                "create_entry",
                // ⭐ `design/0035`：同一目录内的原子改名。⛔ 漏了它 = 右键「重命名」
                //    点下去只有一句"操作失败"（ACL 静默拒）。
                "rename_entry",
                // ⭐ `design/0048`：文件树右键「在访达中显示」（**读取命令**——
                //    `check_readable` 只判"现在能不能读"，⛔ 不新增可读路径、⛔ 不写盘）。
                //    ⛔ 漏了它 = 右键点下去只弹一句失败（ACL 静默拒），日志里一行都没有。
                "reveal_entry",
                // ⭐ `design/0050`：从盘上核对一次（手动刷新 / 根级重扫的**唯一**后端入口）。
                //    ⚠️ 它是**读取侧**的（⛔ 不改授权、⛔ 不写盘），但 ACL 静默拒 ⇒
                //    漏了它就是"右键刷新、⌘R 都毫无反应，日志里也一行都没有"。
                //    ⚠️ 与 `retry_tree_watch` 是**两件事**：这个说"盘上可能变了"，
                //    那个说"监视坏了，重接一条"。
                "reconcile_disk",
                // ⭐ `design/0050`：重建目录监视（健康提示上那个"重试"）。
                //    ⚠️ 同样⛔ 不改授权；漏了它 = 点「重试」没反应，提示永远挂着。
                "retry_tree_watch",
                "open_document",
                "read_asset",
                // ⭐ 重载 / 监视 / 外部编辑器（`design/0006`）。
                // ⚠️ 这四条**都是读取命令**（⛔ 不改授权，`INV-FS-04`），
                //    但"读取"与"要不要在 ACL 里"是两件事：**每一条** IPC 都要列。
                // ⛔ 漏一条的表现是"那个功能静默不工作"（`kb/0007`：ACL 闸门是条件生效的，
                //    被拒的 `invoke` 只会给前端一个 `Err`）。
                "reload_document",
                "watch_document",
                "unwatch_document",
                "open_in_external_editor",
                // ⭐ `design/0012`：窗口内编辑（`begin_edit`/`end_edit` 是**写授权的两个
                //    写入点**，`render_preview` 是读取，`save_document` 是**唯一的写命令**）。
                // ⚠️⚠️ 这四条**一条都不能漏**：ACL 是**静默拒**的 ⇒ 漏了 `save_document`
                //    的表现是"⌘S 按下去毫无反应、日志里也没有一行"（`kb/0007` 的同族形态；
                //    `docs/bugs/0002` 是一次真实的代价）。⚠️ 名字形状不同：这里是
                //    **snake_case 函数名**，`capabilities/default.json` 那边是 kebab 的 `allow-x-y`。
                "begin_edit",
                "end_edit",
                "render_preview",
                "save_document",
                // ⭐ `design/0017`：阅读进度写盘。⚠️ 它**只写 `config.json`**
                //    （⛔ 不读文档、⛔ 不改授权），但**仍然必须列在这里**——
                //    ACL 是静默拒的，漏了它就是"进度永远存不下来、日志里一行都没有"。
                "set_reading_progress",
                // ⭐ `design/0020`：目录会话写盘。⚠️ 与进度同族——**只写 `config.json`**
                //    （⛔ 不读文档、⛔ 不改授权），但**仍然必须列在这里**：
                //    ACL 是静默拒的，漏了它就是"树展开态永远存不下来、日志里一行都没有"。
                "set_dir_session",
                // ⭐ `design/0026`：文档内链接。⚠️ 它**不写盘、不改授权**，
                //    但**会派发 `/usr/bin/open`**（`INV-LINK-04`）⇒ 漏了这一行，
                //    点击链接就变成"什么都没发生"，日志里同样一行都没有（ACL 静默拒）。
                "open_link",
                // 冒烟脚手架（不是产品功能）
                "report_status",
                // ⭐ 批次 2 的测量回报（`design/0002` §10.4 批 2）。**同样是脚手架**。
                // ⚠️ 它**和 `report_status` 一样必须进这份清单**：漏了它，`invoke` 被
                //    ACL 静默拒 ⇒ `reportMeasure` 只在 `console.warn` 里说一句
                //    ⇒ `tools/measure-gui.sh` 收到**零个样本**，而每一次运行都"正常退出"。
                "report_measure",
            ]),
        );
        tauri_build::try_build(attributes).expect("tauri-build 失败（见上面的输出）");
    }

    // 没开 gui 时 build script 什么都不做——但**必须存在**，
    // 否则 Cargo 会因为声明了 [build-dependencies] 却找不到 build.rs 而报错。
}
