//! 文件树相关的命令（`design/0003` §3 的 `commands/fs.rs`）。
//!
//! 这个文件里**授权命令与读取命令混在一起**，所以每条命令的头一行注释
//! 必须写清它是哪一类（见 [`super`] 模块头的表）。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

use crate::commands::{snapshot, AppState, Mode, Session, SessionSnapshot};
use crate::error::Denied;
use crate::fs::grants::SessionGrants;
use crate::fs::tree::{self, DocListResult, ListDirResult, SearchResult};

/// 进入一个目录时，授权从哪来（`design/0038` §2.4）。
///
/// ⚠️ 只有这两种来源，而两者的**校验强度不同**：
/// [`Picked`](AuthSource::Picked) 是用户在系统面板里亲手确认的（`authorize_root`）；
/// [`Recorded`](AuthSource::Recorded) 只是"后端记过的那个串"（`authorize_root_recorded`，
/// 多一道"规范化结果必须逐字等于记录值"的约束）。
enum AuthSource<'a> {
    /// 系统面板选中的：走 `authorize_root`（`design/0003` 以来的行为）。
    Picked(&'a Path),
    /// 启动页点行 / 侧边栏「上次的目录」：走 `authorize_root_recorded`。
    ///
    /// ⚠️ 里面那个路径既是**请求**也是**记录值**——调用方已证明前端传来的串
    /// **逐字**出现在"后端记过的候选集"里，所以两者本来就是一个字符串。
    Recorded(&'a Path),
}

/// ⭐ **换根的唯一实现**（`INV-START-03`）：`choose_directory` 与
/// `open_recent_directory` 都调它，⛔ 不许复制粘贴。
///
/// ⚠️ **锁内只做内存转换**：授权 ＋ 树缓存淘汰 ＋ 配置更新。⛔ 不接收 `AppHandle`、
/// ⛔ 不重挂监视——那两件事必须在 `state.with` 之外（`kb/0020`：摘监视会起线程
/// 停 notify/去抖，不能放进会话锁）。
///
/// ⚠️ 授权失败 ⇒ 直接返回错误，⛔ 不动任何界面状态（缓存、配置、日志都不留痕）。
fn enter_directory(s: &mut Session, auth: AuthSource<'_>) -> Result<PathBuf, Denied> {
    // ① 先授权（唯一的写入点），失败就直接返回
    let real = match auth {
        AuthSource::Picked(dir) => s.grants.authorize_root(dir)?,
        AuthSource::Recorded(recorded) => s.grants.authorize_root_recorded(recorded, recorded)?,
    };
    // ⚠️ 这里**不设** mode：`Session::mode()` 是从 `roots` 推导的
    //    （授权成功 ⇒ 它自然变成 `Directory`），⛔ 不存第二个真值。
    // ② 旧代的树缓存没有意义了（键里的代次已经变）
    s.tree.retain_gen(s.grants.root_generation());
    // ⭐ `design/0050`：换根 ⇒ 磁盘状态整体重置（⚠️ `watch_id` **不归零**：
    //    它必须单调，否则旧监视的迟到结果会与新实例撞号，`INV-DISK-07` 末项）。
    s.disk.reset_roots();
    // ⭐ 索引同理：丢旧 `Arc` **并且涨票号**（`design/0041` R2）——
    //    在途的旧构建回来时票号不符，⛔ 不许把旧根的清单复活
    s.invalidate_index();
    // ⚠️ 只把**路径**记进配置，⛔ 不把授权记进去（INV-FS-03）
    s.config.set_last_directory(&real);
    if let Err(e) = s.config.save(&s.config_path) {
        diag_stderr!("⚠️ last_directory 存不下来：{e}");
        diag_file!(
            "⚠️ last_directory 存不下来 err_class={} err_len={}",
            crate::logging::err_class(&e),
            e.to_string().len()
        );
    }
    diag!("▶ 授权目录 {}（代次 → {}）", real.display(), s.grants.root_generation());
    Ok(real)
}

/// **授权命令** · 用户在系统目录选择器里确认一个目录。
///
/// 成功后：`roots = [选中的]`、`root_generation += 1`、树缓存丢旧代、记进 `last_directory`。
#[tauri::command]
pub async fn choose_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, Denied> {
    // ⭐ 把**上次打开的目录**预置到系统对话框里（§2.1.1 第 4 条）。
    //    ⚠️ 这只是"对话框打开时停在哪"，⛔ **不是授权**——用户仍需按确认，
    //    授权仍然只由 `authorize_root` 产生（`INV-FS-04`）。
    //    ⚠️ 预置的是**配置里那个字符串**：它可能已经不存在了
    //    （用户删了目录、换机器），失败时对话框会自己退到默认位置。
    let initial = state.with(|s| s.config.last_directory.clone());
    let Some(dir) = pick(&app, true, initial.as_deref()).await else {
        // ⚠️ 用户取消**不是错误**：返回当前快照，界面什么都不变。
        //    ⚠️ 闭包写法（不是 `with(snapshot)`）的理由见 `super::get_session`。
        return Ok(state.with(|s| snapshot(s)));
    };

    state
        .with(|s| {
            enter_directory(s, AuthSource::Picked(&dir))?;
            Ok(snapshot(s))
        })
        .inspect(|_| {
            // ⭐ 换根 ⇒ 旧的目录监视作废、新的盯着新根（`design/0034` §2.1 A 的生命周期）。
            // ⚠️ 放在 `with` **之外**：摘旧监视会起线程停 notify/去抖，
            //    ⛔ 不把这件事放进会话锁的临界区（`kb/0020`）。
            restart_tree_watch(&app, &state);
        })
}

/// **授权命令** · 进入一个**后端自己记过的**目录（`design/0038`）。
///
/// # 它是 `INV-FS-04` 的第四处写入点，收紧条件是 `INV-START-02`
///
/// ① 白名单 = `config.dir_sessions` 的键 ∪ `{last_directory}`，**字面比较**，
///    ⛔ 候选集不 canonicalize（两侧都规范化会让"软链被换掉"同时发生在比较两边）；
/// ② 命中之后由 [`SessionGrants::authorize_root_recorded`] 做完剩下的校验
///    （`canonicalize` → 是目录 → **与记录值原字节相等**）**再**写授权。
/// ⇒ 拒绝时 grants / 代次 / 树缓存 / 配置 / 监视身份**一个字节不变**。
///
/// ⚠️ 白名单查询与授权写入在**同一个 `state.with` 里**：中间不留出
/// "查完白名单、写之前配置被别处改掉"的缝隙。
///
/// ⚠️ 与 `⌘O` 选中同一个目录**完全等效**：代次 +1、树重挂、`last_directory` 更新、
/// 前端的 `dirRestorer` 自动恢复上次那份文档（`design/0020`）。
#[tauri::command]
pub async fn open_recent_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    root: String,
) -> Result<SessionSnapshot, Denied> {
    let result = state.with(|s| enter_recorded_directory(s, &root));

    match &result {
        Ok(snap) => diag!(
            "▶ 进入最近目录（代次 {}）：{}",
            snap.generation,
            snap.roots.first().map(String::as_str).unwrap_or("—")
        ),
        Err(e) => {
            // ⚠️ 日志只打路径与分类，⛔ 不打用户输入以外的任何内容
            diag_stderr!("▶ 进入最近目录被拒（{root}）：{}（{e}）", e.label());
            diag_file!(
                "▶ 进入最近目录被拒 label={} err_len={}",
                e.label(),
                e.to_string().len()
            );
        }
    }

    result.inspect(|_| {
        // ⚠️ 同 `choose_directory`：重挂监视在 `with` 之外（`kb/0020`）
        restart_tree_watch(&app, &state);
    })
}

/// [`open_recent_directory`] 的**锁内整段**（`design/0038` §2.4 第 0–5 步）。
///
/// ⚠️ 抽成独立函数不是为了好看：命令层要 `AppHandle`，而这一整段是**纯 `Session` 状态机**
/// ⇒ 抽出来之后八种白名单情形（`design/0038` §7 第 2 条）能在单测里跑，
/// ⛔ 不用去凑一个 `AppHandle`（与 `commit_rename` 用闭包注入"起监视"同一条理由）。
///
/// 判定顺序（**顺序就是判据**）：
/// 0. 白名单 = `config.dir_sessions` 的键 ∪ `{last_directory}`；
/// 1. `root` **逐字**等于其中一条，否则 `not_authorized`；
/// 2–5. 交 [`SessionGrants::authorize_root_recorded`]（canonicalize → 是目录 →
///      与记录值**原字节**相等 → 才写授权）。
///
/// ⚠️ 白名单查询与授权写入在**同一次 `state.with` 里**：中间不留出
/// "查完白名单、写之前配置被别处改掉"的缝隙。
fn enter_recorded_directory(s: &mut Session, root: &str) -> Result<SessionSnapshot, Denied> {
    // 0–1. 字面比较（⛔ 不 canonicalize 候选集——见 `INV-START-02` 的理由）
    let known =
        s.config.dir_session(root).is_some() || s.config.last_directory.as_deref() == Some(root);
    if !known {
        return Err(Denied::not_authorized(Path::new(root)));
    }
    // 2–5. 校验全部在写 `roots` 之前；拒绝时一个字节不动
    enter_directory(s, AuthSource::Recorded(Path::new(root)))?;
    Ok(snapshot(s))
}

/// **授权命令** · 用户在系统文件选择器里确认一个文件。
///
/// ⚠️ 它**只**把文件加进 `files`，⛔ 不动 `roots`、⛔ 不动代次（§2.1.4 的时序）。
/// "是不是外部文件"由 `open_document` 用 `path ∉ roots` **当场判定**。
#[tauri::command]
pub async fn choose_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, Denied> {
    let Some(file) = pick(&app, false, None).await else {
        return Ok(state.with(|s| snapshot(s)));
    };

    state.with(|s| {
        let real = s.grants.authorize_file(&file)?;
        // ⚠️ 这里**不**改 `mode`：要不要切成单文件模式由 `open_document`
        //    的 §2.1.4 时序决定（第 ③ 步），⛔ 不提前到这里。
        //    它只记下"接下来该开哪份文档"。
        s.startup_document = Some(real.clone());
        diag!("▶ 授权文件 {}", real.display());
        Ok(snapshot(s))
    })
}

/// ⭐ **授权命令** · 打开一条**收藏**（`design/0043` §2.4，`INV-FS-04` 的第五处写入点）。
///
/// # 判定顺序（⭐ 顺序就是判据）
///
/// 0. `path` 必须是**绝对路径**，且**原串逐字**等于 `config.favorites` 里某一条 ⇒ 得 `recorded`；
/// 1. `canonicalize(path)` 失败 ⇒ `NotFound`；
/// 2. ⭐ `real != recorded` ⇒ `not_authorized`（**记录侧不再次 canonicalize**）；
/// 3. 目录 ⇒ [`enter_directory`]（`authorize_root_recorded` ＋ 既有收尾）；
///    文件 ＋ Markdown 后缀 ⇒ [`SessionGrants::authorize_file_recorded`] ＋ `startup_document`；
///    其它后缀 ⇒ `not_authorized`；都不是 ⇒ `NotFound`。
///
/// ⚠️⚠️ **第 0 步必须在第 1 步之前**（复评 P1）：若先 `canonicalize` 再拿新算的 `real`
/// 去匹配收藏表，那么"收藏 A/B、A 后来被换成指向 B 的软链"时，点 A 会被当成 B 打开；
/// 相对路径与未记录的别名也能命中。协议是**点击哪条就复核哪条记录**。
/// ⚠️ 收尾复用既有流程（复评 §5）：目录走 `enter_directory`（`INV-START-03`），
/// **不扩** `enter_recorded_directory` 的白名单，⛔ 不加任何"打开所在目录"降级。
/// ⚠️ 监视重挂仍在会话锁**之外**（`kb/0020`）；⛔ 只收藏/移除/排序不经过这里，
/// 它们也不切根、不刷新正文、不改代次。
#[tauri::command]
pub async fn open_favorite(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<SessionSnapshot, Denied> {
    let result = state.with(|s| open_favorite_recorded(s, &path));

    match &result {
        Ok(snap) => diag!(
            "▶ 打开收藏（模式={} 代次 {}）：{}",
            snap.mode, snap.generation, path
        ),
        Err(e) => {
            diag_stderr!("▶ 打开收藏被拒（{path}）：{}（{e}）", e.label());
            diag_file!(
                "▶ 打开收藏被拒 label={} err_len={}",
                e.label(),
                e.to_string().len()
            );
        }
    }

    // ⚠️ 只有**进了目录**才需要重挂树监视（与 `open_recent_directory` 同形）；
    //    文件收藏不动 `roots`，与 `choose_file` 一样不碰监视。
    if matches!(&result, Ok(snap) if snap.mode == "directory") {
        restart_tree_watch(&app, &state);
    }
    result
}

/// [`open_favorite`] 的**锁内整段**（抽出来只为可测：命令层要 `AppHandle`）。
fn open_favorite_recorded(s: &mut Session, path: &str) -> Result<SessionSnapshot, Denied> {
    // 0. 绝对路径 ＋ 原串逐字命中（⛔ 不先 canonicalize 再匹配收藏表）
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err(Denied::not_authorized(requested));
    }
    let Some(recorded) = s
        .config
        .favorites
        .iter()
        .find(|f| f.as_str() == path)
        .map(PathBuf::from)
    else {
        return Err(Denied::not_authorized(requested));
    };

    // 1. 解析请求侧
    let real = std::fs::canonicalize(&recorded).map_err(|_| Denied::not_found(&recorded))?;
    // 2. ⭐ 记录目标复核（⛔ 记录侧不 canonicalize）
    if real != recorded {
        return Err(Denied::not_authorized(&recorded));
    }

    // 3. 按**当前**类型分派（收藏时是文件、现在是目录 ⇒ 按目录打开；反之亦然）
    if real.is_dir() {
        // ⚠️ 传 `recorded` 当请求：两者本来就是同一个字符串，
        //    `authorize_root_recorded` 会再做一次 canonicalize ＋ `real == recorded`。
        enter_directory(s, AuthSource::Recorded(&recorded))?;
        return Ok(snapshot(s));
    }
    if real.is_file() {
        // ⚠️ 后缀判据是全项目唯一那份（`link::is_markdown`，⛔ 不复用只认 `.md` 的 tree 版）
        if !crate::commands::link::is_markdown(&real) {
            return Err(Denied::not_authorized(&recorded));
        }
        let authorized = s.grants.authorize_file_recorded(&recorded, &recorded)?;
        // ⚠️ 与 `choose_file` 同形：只记下"接下来该开哪份"，⛔ 不改 mode
        //    （模式由 `open_document` 的 §2.1.4 时序决定）。
        s.startup_document = Some(authorized.clone());
        diag!("▶ 授权收藏文件 {}", authorized.display());
        return Ok(snapshot(s));
    }
    Err(Denied::not_found(&recorded))
}

/// **授权命令** · 关闭当前目录（收起整棵树 + 收回授权）。
///
/// ⭐ 前端在 §2.1.4 的**第 ③ 步**调用它：正文提交之后，若发现打开的是一份
/// **外部**文件（`roots` 非空 且 `path ∉ roots`），就收回旧 root。
///
/// ⚠️ 为什么必须是**提交之后**：`roots.clear()` 会让代次 +1，
/// 若提前做，刚拿到的那份正文会被自己的版本检查判为陈旧——
/// **一次必然失败的自我否定**（§2.1.4 的"顺序不能换"）。
///
/// ⚠️ `files` **不动**：收回目录不该把用户正在读的那份文档也变成不可读
/// （§6 失败模型的最后一行）。
#[tauri::command]
pub fn close_directory(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> SessionSnapshot {
    let snap = state.with(|s| {
        s.grants.revoke_roots();
        s.tree.retain_gen(s.grants.root_generation());
        // ⭐ `design/0050`：没有根 ⇒ 没有"盘上的观测"这回事（epoch/forced/健康一起归零）。
        s.disk.reset_roots();
        s.invalidate_index();
        // ⚠️ 同样**不设** mode：收回 roots 之后，`Session::mode()` 会自己从
        //    `Directory` 变成 `SingleFile`（有文档）或 `Empty`（没有）——
        //    而这正是"关闭目录后正在读的那份文档仍然可读"该有的样子。
        diag!("▶ 收回目录授权（代次 → {}）", s.grants.root_generation());
        snapshot(s)
    });
    // ⭐ 没有根就没有目录监视（`design/0034` §2.1 A）。⚠️ 在 `with` 之外做：
    //    摘监视要起线程停 notify/去抖，⛔ 不放进去会话锁的临界区。
    restart_tree_watch(&app, &state);
    snap
}

/// ⭐ **重建目录监视**（`design/0034` §2.1 A 的生命周期）。
///
/// 调用点：`choose_directory`（换根）、`close_directory`（收回）、
/// 启动参数授权完之后、Apple Event 授权了目录之后。
///
/// 语义是"**让监视与当前 `roots` 一致**"：没有根 ⇒ 不监视；有根 ⇒ 盯那一个。
/// ⚠️ 幂等（每次都先摘旧的），所以调用方**不需要**先判断"根变没变"——
/// 而"根没变时多重建一次"的代价是毫秒级（`watch()` 会重启一条递归流）。
///
/// ⚠️ 失败**不是致命**：`tree_watch = None` 只意味着"这一轮没有自动刷新"，
/// 右键「刷新」仍然在（§2.1 D）。
pub(crate) fn restart_tree_watch(app: &tauri::AppHandle, state: &AppState) {
    // ① 摘旧的。⚠️ **先在锁里 `take`，再在锁外 drop**：
    //    `DirWatch::drop` 会起线程 + 叫醒去抖线程，虽然不阻塞，但没必要压在临界区里。
    let old = state.with(|s| s.tree_watch.take());
    drop(old);

    // ② 取当前**唯一**的授权根与代次，并**发一个新的监视实例号**（最终约束 3）。
    //    ⚠️ 发号必须在**建立之前**：回调里每条信号都要带上它做 fencing，
    //    而"先建后发"的窗口里发生的事件会带着 0 号进来（谁都不认）。
    let (root, generation, watch_id) = state.with(|s| {
        let root = s.grants.roots().first().cloned();
        if root.is_some() {
            let id = s.disk.next_watch_id();
            (root, s.grants.root_generation(), id)
        } else {
            (None, s.grants.root_generation(), s.disk.watch_id)
        }
    });
    let Some(root) = root else {
        diag!("▶ 目录监视：没有授权根 ⇒ 不监视（手动刷新仍可用）");
        return;
    };

    match crate::external::watch::start_tree_watch(app, &root, generation, watch_id) {
        Ok(w) => {
            // ⚠️ 建立期间代次可能又变了（并发换根）⇒ 这份监视盯着一个**已经不授权**的根。
            //    代次核对放在存进去的那一刻，⛔ 不假设"上面两次 `with` 之间什么都没发生"。
            let mut slot = Some(w);
            let stored = state.with(|s| {
                if s.grants.root_generation() == generation && s.disk.watch_id == watch_id {
                    s.tree_watch = slot.take();
                    true
                } else {
                    false
                }
            });
            if stored {
                diag!("▶ 目录监视已建立：{}（代次 {generation}，实例 {watch_id}）", root.display());
                // ⭐ 重建成功 **不等于**已经知道盘上是什么（最终约束 2）：
                //    排一次核对，**等它成功**才撤掉持久档降级。
                //    ⚠️ 顺序固定：先推纪元（`Reattach` 会 `forced = epoch`），
                //    再把"要等哪个目标"记在 `awaiting` 上——反了就会记一个
                //    **已经完成过的**目标，`watcher` 当场被洗白。
                state.with(|s| {
                    s.disk.request(crate::disk::ReconcileCause::Reattach);
                    let target = s.disk.forced;
                    s.disk.note_rewatch_ok(watch_id, target);
                });
                kick_reconcile(app, state);
                emit_disk_view(app, state);
            } else {
                diag!("⚠️ 目录监视：建立期间代次变了 ⇒ 丢弃这份（换根的那次会自己重建）");
            }
        }
        Err(e) => {
            // ⚠️ **响亮但不致命**：静默失败的表现是"树再也不自动刷新"，
            //    与"目录里什么都没发生"在界面上完全一样。
            // ⭐ `design/0050` 起它还**必须**进健康状态：用户要能看到"重试"入口，
            //    而不是等到某天发现树不刷新。
            state.with(|s| {
                if s.grants.root_generation() == generation && s.disk.watch_id == watch_id {
                    s.disk.note_rewatch_failed();
                }
            });
            diag_stderr!("⚠️ 目录监视没建起来（{e}）⇒ 自动刷新不可用，手动刷新仍可用");
            diag_file!(
                "⚠️ 目录监视没建起来 label={} err_len={}",
                e.label(),
                e.to_string().len()
            );
            emit_disk_view(app, state);
        }
    }
}

/// ⭐ **把当前的派生健康发一次**（`design/0050` §2.3.3）。
///
/// ⚠️ 发的是 [`crate::disk::DiskView`]：**全是身份元数据**（⛔ 无路径、⛔ 无事件类型）。
/// 前端拿到它只做两件事：按 `revision` 丢弃倒退的包、把 `reason` 显示成一行提示。
///
/// ⚠️ 去重键是 [`Session::last_disk_rev`]——**同一个派生状态不重复发**。
/// 调用方可以是 notify 回调线程 / 去抖线程 / 命令线程，所以这段必须短：
/// 它只在会话锁里读一份快照。
pub(crate) fn emit_disk_view(app: &tauri::AppHandle, state: &AppState) {
    use tauri::Emitter;
    let view = state.with(|s| {
        let v = s.disk.view();
        if v.revision == s.last_disk_rev {
            return None;
        }
        s.last_disk_rev = v.revision;
        Some(v)
    });
    let Some(view) = view else { return };
    if let Err(e) = app.emit(crate::external::watch::DIR_WATCH_EVENT, view) {
        // ⚠️ 发不出去**不致命**，但⛔ 不许静默：它坏了的表现是"监视坏了但界面不吭声"，
        //    而那正是 `design/0050` 要消灭的那一类静默。
        diag_stderr!("⚠️ 磁盘状态事件发不出去：{e}");
        diag_file!(
            "⚠️ 磁盘状态事件发不出去 err_class={} err_len={}",
            crate::logging::err_class(&e),
            e.to_string().len()
        );
    }
}

/// ⭐ **起一趟核对**（单飞 ＋ 尾随重跑，`design/0050` 最终约束 1）。
///
/// 三条纪律：
/// 1. **单飞**：已经有人在跑就不再起第二个线程（`Session::reconcile_inflight`）；
/// 2. **尾随重跑**：跑完一轮**再看一眼** `pending()`——核对在途时又来的请求
///    会留在 `forced > attempted` 上，这一眼就是它不被漏掉的地方；
/// 3. ⛔ **同一目标不原地重跑**（`bugs/0039`）：`pending()` 看的是**已尝试**的目标，
///    失败的一轮也会把它推进 ⇒ 循环自然结束，`reconcile_failed` 承担"还没核对成功"这件事。
///    仍为 `true` 只剩一种来由——这一轮**什么都没观测到**（遍历期间纪元 / 代次又变了），
///    而那正是"再跑一次结果会不同"的情形。
///
/// ⚠️ 它的调用点全在**锁外**（notify 回调 / 去抖线程 / 命令线程）：
/// 起线程本身很快，但核对要读整棵树，⛔ 绝不能占用 FSEvents 的回调线程。
pub(crate) fn kick_reconcile(app: &tauri::AppHandle, state: &AppState) {
    let start = state.with(|s| {
        if s.reconcile_inflight || !s.disk.pending() {
            return false;
        }
        s.reconcile_inflight = true;
        true
    });
    if !start {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("rmd-disk-reconcile".into()).spawn(move || {
        use tauri::Manager;
        // ⚠️ `try_state` 拿不到 AppState 时我们**连那个位子都碰不到**（状态已被丢弃），
        //    这里什么也不做是对的——不是"此后永远不核对"，是那个会话已经结束了。
        let Some(state) = app.try_state::<AppState>() else { return };
        // ⚠️ 兜底：`reconcile_once` panic 时也要把单飞位还回去（否则此后这台机器
        //    再也不核对，而且没有任何外部症状）。见 `InflightGuard`。
        let mut guard = InflightGuard::new(&state);
        let mut rounds = 0usize;
        loop {
            reconcile_once(&app, &state);
            rounds += 1;
            // ⚠️ "还要不要跑"与"归还单飞位"必须在**同一个锁内**判完（与 `start` 同口径）：
            //    分开做的话，两步之间来的请求会看到 `inflight == true` 被挡掉，
            //    而我们已经决定不再起 —— 那个请求就再也没人跑了（丢唤醒）。
            let again = state.with(|s| {
                if crate::disk::DiskState::wants_trailing_round(
                    s.disk.pending(),
                    rounds,
                    MAX_TRAILING_ROUNDS,
                ) {
                    true
                } else {
                    s.reconcile_inflight = false;
                    false
                }
            });
            if !again {
                break;
            }
            diag!("▶ 核对：跑完一轮后仍有没试过的目标（尾随重跑，第 {rounds} 轮之后）");
        }
        guard.finished = true;
    });
    if let Err(e) = spawned {
        // ⚠️ 起不来 ⇒ 必须**把单飞位放回去**，否则此后永远不再核对（静默）
        state.with(|s| s.reconcile_inflight = false);
        diag_stderr!("⚠️ 核对线程起不来：{e}");
        diag_file!("⚠️ 核对线程起不来 err_len={}", e.to_string().len());
    }
}

/// 一趟 `kick_reconcile` 里最多连续跑几轮核对（**尾随重跑的上限**）。
///
/// ⚠️ 正常情况一轮就结束（见 [`kick_reconcile`] 第 3 条纪律）。这个上限挡的是**事件风暴**：
/// 纪元一直在动 ⇒ 每轮都在遍历期间撞上 `stale_revision` ⇒ 每轮都白扫一遍。
/// 撞到上限 ⇒ **留着 `pending` 退出**，下一次去抖窗口 / 用户动作会再起一轮
/// （`design/0050` §2.3.2 第 5 条「⛔ 饿死、⛔ 忙循环」——两头都不许）。
///
/// ⚠️ 2026-10-29 评审第 8 条：**判据本身搬进了 `disk.rs`**
/// （[`DiskState::wants_trailing_round`](crate::disk::DiskState::wants_trailing_round)），这里只留常量。
/// 搬走的理由是"什么时候停"此前只活在这段循环里，而循环要真起线程才跑得到；
/// 现在它是纯函数，真值表在 `make test` 里。
const MAX_TRAILING_ROUNDS: usize = 4;

/// ⭐ **单飞位的兜底**：`reconcile_once` panic 时也要把它还回去。
///
/// ⚠️ 不还的表现是此后**这台机器再也不核对**（`reconcile_once` 的注释点名过的
/// "最坏的静默"），而它没有任何外部症状——"树不刷新"与"目录里什么都没发生"长得一样。
struct InflightGuard<'a> {
    state: &'a AppState,
    /// 正常收尾时置 `true`（循环里已经**在锁内**还过位子了）。
    finished: bool,
}

impl<'a> InflightGuard<'a> {
    fn new(state: &'a AppState) -> Self {
        Self { state, finished: false }
    }
}

impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        // ⚠️ 走到这里 = 展开（panic）。⛔ 不静默：这是我们代码的缺陷，不是用户的目录。
        diag_stderr!("⚠️ 核对线程异常退出（panic）⇒ 归还单飞位，下一次请求会重新起一趟");
        diag_file!("⚠️ 核对线程异常退出（panic）⇒ 归还单飞位");
        self.state.with(|s| s.reconcile_inflight = false);
    }
}

/// ⭐ **一趟核对**：把整棵树的索引按**当刻修订**重扫一遍并记账。
///
/// 它做的四件事（顺序固定）：
/// 1. 锁内取 `(代次, 修订, 监视实例, 目标)`，**摘掉旧纪元的树缓存**（锁内 `take`、锁外 drop）；
/// 2. 走 [`obtain_index`]（≡ 唯一的构建入口 `INV-DOCS-01`）：锁外读盘（`INV-TREE-11`）
///    ＋ 锁内按 `(代次, 修订, 票号)` 发布（[`publish_index`]）；⭐ 同一纪元已有新鲜索引 ⇒ 直接复用；
/// 3. **不论成败**记账（[`DiskState::complete`]）：`FileIndex.complete == false`
///    ⇒ 有子树没走完 ⇒ **不算**核对成功（最终约束 2 第 3 条）；
/// 4. 顺带看一眼当前文档的指纹（[`reconcile_current_document`]）。
///
/// ⚠️ 第 3 条必须**无条件**执行（"这一轮作废"那一支除外，见下）：核对失败时若直接
/// `return`，`pending()` 永远为真、`reconcile_inflight` 永远是 `true`——此后这台机器
/// **再也不核对**（最坏的静默）。⭐ `bugs/0039` 起 `pending()` 用的是**已尝试**的目标，
/// 所以"失败"本身也会让调度结束；`stale` / `stale_revision` 那一支**故意不记账**
/// （它不是故障，而是"这一轮没观测到盘"），由尾随重跑（有上限）接住。
fn reconcile_once(app: &tauri::AppHandle, state: &AppState) {
    let Some((generation, epoch, watch_id, target)) = state.with(|s| {
        let target = s.disk.target()?;
        Some((s.grants.root_generation(), s.disk.epoch, s.disk.watch_id, target))
    }) else {
        return;
    };

    diag!("▶ 核对：开始（代次 {generation}，修订 {epoch}，目标 {target}，实例 {watch_id}）");
    let t0 = std::time::Instant::now();

    // ⭐ **旧纪元的缓存层与在途票先摘掉**（最终约束 7 的"锁内 `take`、锁外 drop"）：
    //    摘下来的是**整层条目**（10 万条的那种），⛔ 不能让它落在会话锁的临界区里。
    let swept = state.with(|s| s.tree.sweep(generation, epoch));
    diag!("▶ 核对：清掉旧纪元的树缓存 {} 层", swept.len());
    drop(swept);

    // ── ② ＋ ③ 锁外读盘、锁内凭票发布 ──
    // ⚠️⚠️ **必须走 [`obtain_index`]，⛔ 不许在这里再调一次 `tree::build_index`**：
    //    `INV-DOCS-01` 的源码闸门要求索引**只有一个构建入口**（`tests/js/doclist-source.test.js`），
    //    两份构建点迟早会分叉——而分叉的表现是"树按新盘画、过滤按旧盘判"，
    //    两边单独看都对（`design/0050` §2.1 ⑤）。
    //    ⭐ 它同时兑现最终约束 6 的"同一纪元最多建一次"：纪元刚被推高时缓存不新鲜 ⇒ 真扫一遍；
    //    而尾随重跑时若已有同纪元的新鲜索引 ⇒ 直接复用，⛔ 不重复扫盘。
    let built = obtain_index(state, true);
    let (ok, complete, entries, dirs, skipped) = match &built {
        Ok(ix) => (true, ix.complete, ix.len(), ix.stats.dirs, ix.stats.skipped_denied),
        Err(_) => (false, false, 0, 0, 0),
    };
    if let Err(e) = &built {
        diag_stderr!("⚠️ 核对：索引没建出来（{}）", e.label());
        diag_file!("⚠️ 核对：索引没建出来 label={}", e.label());
    }
    // ⭐ **这一轮什么都没观测到 ⇒ 不记账**（`bugs/0039` 的第二面）。
    //    来由有两种，都**不是故障**：遍历期间换根（`stale`）/ 遍历期间盘上又有事件
    //    （`stale_revision`）。⚠️ 把它们喂给 `complete(…, false)` 会被翻成 `Io`
    //    ⇒ 界面报「读写失败」并要求点重试，而下一轮自己就好（误报也是**静默**的一种：
    //    用户从此分不清"监视管道坏了"与"刚才恰好有文件在动"）。
    //    ⛔ 也不能记成功：这一时刻的盘我们确实没拿到。
    let void = matches!(&built, Err(Denied::Stale { .. } | Denied::StaleRevision { .. }));
    let succeeded = !void && ok && complete;
    if void {
        diag!("▶ 核对：这一轮没观测到盘（换根 / 内容修订又变了）⇒ 不记账，留待重跑");
    } else {
        // ── ④ 记账（**不论成败**）──    // ⚠️ `complete=false` 的两种来由**分别**可见：
        //    建不出来（真 IO）/ 有子树没走完。它们对用户是同一件事（"我还不知道盘上是什么"），
        //    对排错是两件事。
        //    ⭐ 最终约束 2 第 3 条：**发布成功 ≠ 核对完整**——`complete=false` 一律不算成功，
        //    否则一次"只走了一半"的扫描会把监视健康洗白成"没问题"。
        let changed = state.with(|s| s.disk.complete(target, watch_id, succeeded));
        if changed {
            emit_disk_view(app, state);
        }
    }
    diag!(
        "▶ 核对：结束（{:.1} ms，{} 条/{} 目录，跳过受权 {}）⇒ {}",
        t0.elapsed().as_secs_f64() * 1000.0,
        entries,
        dirs,
        skipped,
        if void {
            "这一轮作废（换根 / 内容修订又变了）"
        } else if succeeded {
            "完成"
        } else if !ok {
            "索引没建出来"
        } else {
            "部分子树没走完"
        }
    );

    // ── ⑤ 当前文档也拉进同一条通道（最终约束 5 末三句）──
    reconcile_current_document(app, state);
}

/// ⭐ **核对时顺带看一眼当前文档**（`design/0050` 最终约束 5）。
///
/// ⚠️ 存在的理由：文档监视**也可能漏事件**（那正是本设计要治的病）。
/// 手动刷新 / 根级重扫既然如此便宜地带来一次"从盘上重看一遍"的机会，就顺手比一下指纹。
/// 变了就发**同一条** [`CHANGED_EVENT`](crate::external::watch::CHANGED_EVENT)——
/// 前端照旧走 `services/reload.js` 的闸门：**脏缓冲不覆盖、提示不重复**。
/// ⛔ 这里**不读正文、不比内容**：那是 `reload_document` 的事，而它会自己过 `check_readable`。
fn reconcile_current_document(app: &tauri::AppHandle, state: &AppState) {
    use tauri::Emitter;
    let Some((path, seq)) = state.with(|s| {
        let w = s.watch.as_ref()?;
        Some((w.real.clone(), w.seq))
    }) else {
        return;
    };
    let now = crate::fs::finger(&path);
    let stale = state.with(|s| {
        let w = s.watch.as_mut()?;
        if w.seq != seq || w.real != path {
            return None;
        }
        if now == w.seen {
            return None;
        }
        w.seen = now;
        Some(())
    });
    if stale.is_none() {
        return;
    }
    let payload = crate::external::watch::ChangeEvent {
        path: path.display().to_string(),
        seq,
    };
    if let Err(e) = app.emit(crate::external::watch::CHANGED_EVENT, payload) {
        diag_stderr!("⚠️ 核对：当前文档变化事件发不出去：{e}");
        diag_file!(
            "⚠️ 核对：当前文档变化事件发不出去 err_class={} err_len={}",
            crate::logging::err_class(&e),
            e.to_string().len()
        );
    }
}

/// ⭐ **命令** · 从盘上核对一次（`design/0050` 最终约束 5）。
///
/// 它是"手动刷新"的**唯一后端入口**——⛔ 不是第二条读取路径：
/// 它只推内容修订并起一次核对，真正读盘仍走 [`reconcile_once`] → `tree::build_index`
/// （每一层过 `check_readable`，`INV-SEARCH-01`）。
///
/// ⚠️ 与 [`retry_tree_watch`] 的分工**不许混**：
/// 这个说"**盘上可能变了，重看一眼**"（重建监视解决不了）；
/// 那个说"**监视坏了，重接一条**"（它对盘上有没有变一无所知）。
/// 前者是刷新，后者是修管道。⚠️ 两者内部都汇到同一个状态机（`DiskState`）。
#[tauri::command]
pub fn reconcile_disk(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> crate::disk::DiskView {
    let view = state.with(|s| {
        s.disk.request(crate::disk::ReconcileCause::Manual);
        s.disk.view()
    });
    diag!("▶ 手动刷新：内容修订 → {}（目标 {}）", view.epoch, view.epoch);
    // ⚠️ 锁外起线程（它要读整棵树）
    kick_reconcile(&app, &state);
    // ⚠️ 立刻回一份视图：前端据此**马上**显示"正在核对"，⛔ 不等扫描结束
    let _ = emit_disk_view(&app, &state);
    view
}

/// ⭐ **命令** · 重建目录监视（`design/0050` 最终约束 5 的"重试"入口）。
///
/// 语义是"**重接一条监视**"：它修的是**管道**，对"盘上此刻是什么"一无所知。
/// ⚠️⚠️ **但它照样推内容修订**（2026-10-29 代码评审第 9 条，此前这里写的是
/// 「⛔ 不推内容修订」，与实现相反）：重接之前那一段"没人接事件"的窗口里盘上可能
/// 变过，而我们一条事件都没收到 ⇒ 派生快照必须保守失效，否则展开过的子树
/// 用的还是失效窗口里的旧层。⭐ 实现上走 [`ReconcileCause::Reattach`]，
/// ⛔ 不再借 `Manual`（借来的结果对，来的名字错）。
/// 重建成功之后由 `restart_tree_watch` 自己排一次核对——
/// 因为"新管道通了"不等于"我知道盘上是什么"（最终约束 2）。
///
/// ⚠️ 幂等：没有授权根时它就是一条无操作（返回 `null` 状态），⛔ 不报错——
/// 界面上"重试"按钮不该因为"还没打开目录"而变成一次失败提示。
#[tauri::command]
pub fn retry_tree_watch(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> crate::disk::DiskView {
    diag!("▶ 重试目录监视");
    restart_tree_watch(&app, &state);
    state.with(|s| s.disk.view())
}


///
/// ⛔ 它**不改授权**。授权校验在 [`tree::list_dir`] 里（阶段②，用**快照**）。
///
/// # 三段式锁（`design/0039` §2.1）——⛔ 不在会话锁里读盘
///
/// `AppState::with` 拿的是 `Mutex<Session>`，而 `notify` 的回调在**别的线程**上取它
/// （`commands/mod.rs` 的 `with` 注释）。一次大目录列举在锁里读盘 ＋ 排序的代价是
/// "这期间所有会话操作一起排队"——`design/0006` §2.1 ⑤ 那条硬约束说的就是这件事。
///
/// ⇒ 顺序固定，⛔ 不许合并：
/// ① **持锁**只做内存级的事：`check_readable` 取规范化路径（唯一允许的一跳 IO）、
///    命中缓存就返回、`fresh` 则作废、否则**领一张票**并克隆一份授权快照；
/// ② **放锁**在 `spawn_blocking` 里读盘（`tree::list_dir`，参数与返回类型一个字节没变）；
/// ③ **再进锁**：复核**当前**代次 → **凭票提交**（`INV-TREE-10` / `INV-TREE-12`）。
///
/// ⚠️ **票失效**（有人 `fresh` 过、或有更晚的扫描领了票）⇒ 不写缓存，**结果也不回给前端**，
/// 回 [`Denied::ticket_taken`]（前端按 `stale_revision` 的路由"保留旧视图 ＋ 重列一次"）；
/// 代次变了 ⇒ 返回 `stale`，结果不回（前端拿新代次重发）。两者都⛔ 不是"重试"——重试由前端驱动。
///
/// ⚠️⚠️ 上面那句在 `design/0050` 之前写的是「票失效 ⇒ 不写缓存，**结果照回**」。
/// **那已被正面推翻**（见 `0039` §2.1 ③ 的取代记录）：一份说不清"对应哪个修订"的列表
/// 就是来源不明的盘上事实。⛔ 别照旧文档把"照回"改回来。
#[tauri::command]
pub async fn list_dir(
    state: tauri::State<'_, AppState>,
    path: String,
    generation: u64,
    req: u64,
    fresh: bool,
) -> Result<ListDirResult, Denied> {
    let result = list_dir_three_stage(&state, &path, generation, req, fresh).await;

    match &result {
        Ok((r, cached, cache_layers)) => {
            // ⭐ §7 步骤 5 的**日志判据**：把"这一层读到了多少项"摆出来。
            //    ① / ② 类若真被扫描了，`scanned` 会明显大于可见项数。
            diag!(
                "▶ list_dir {}（代次 {}{}，缓存 {} 层）：读到 {} 项 → 目录/文件 {} 项｜隐藏(①) {}｜灰显(②) {}｜软链 {}｜其它 {}｜{:.2} ms",
                r.path,
                r.generation,
                if *cached { "·缓存" } else { "" },
                cache_layers,
                r.stats.scanned,
                r.entries.len(),
                r.stats.skipped_dot,
                r.stats.ignored,
                r.stats.skipped_symlink,
                r.stats.skipped_other,
                r.stats.scan_ms
            );
        }
        Err(e) => {
            diag_stderr!("▶ list_dir {path} 被拒：{}（{}）", e.label(), e);
            diag_file!(
                "▶ list_dir {path} 被拒 label={} err_len={}",
                e.label(),
                e.to_string().len()
            );
        }
    }

    result.map(|(r, _, _)| r)
}

/// **三段式**本体（见 [`list_dir`] 的文档）。返回 `(结果, 是否缓存命中, 命中前的层数)`——
/// 后两项只给日志用，⛔ 不进 IPC 契约。
async fn list_dir_three_stage(
    state: &AppState,
    path: &str,
    generation: u64,
    req: u64,
    fresh: bool,
) -> Result<(ListDirResult, bool, usize), Denied> {
    /// 阶段②要搬进阻塞池的那一份（⛔ 全是**快照**，不借用 `Session`）。
    struct Ticket {
        real: PathBuf,
        grants: SessionGrants,
        ignore: Vec<String>,
        stamp: u64,
        /// ⭐ **扫描起步时的内容修订**（`design/0050`）：第 ③ 段拿它跟当刻比。
        ///
        /// ⚠️ 它在**锁内、与领票同一刻**取值——"票属于哪个修订"这件事因此只有一个答案。
        epoch: u64,
    }

    enum First {
        Cached(ListDirResult),
        Scan(Ticket),
    }

    // ⭐ 树缓存现在有多少层（诊断用）。⚠️ 它**是** `fresh` 那条路的判据：
    //    作废之后重列，层数应当**不涨**——涨了说明作废没生效，
    //    而那正是"搜索看到了新文件、树里却定位不到"的根因（§2.1 ⑤）。
    let mut cache_layers = 0usize;

    // ── ① 持锁：授权 + 命中 / 作废 / 领票 ────────────────────────────
    let first = state.with(|s| -> Result<First, Denied> {
        // ⚠️ 缓存键用**规范化后**的路径（§2.1.3：裸 path 会在切根回到同一目录时
        //    命中上一代的结果）。这一跳 `canonicalize` 是 §2.1 ① 允许的唯一 IO。
        let real = s.grants.check_readable(Path::new(path))?;
        cache_layers = s.tree.len();
        // ⭐ `design/0050`：纪元取**当刻**的。⚠️ ⛔ 不从请求里取——
        //    前端不持有它，让前端传等于给它一份"伪造观测时刻"的权力。
        let epoch = s.disk.epoch;
        if fresh {
            // ⭐ 作废**同时发新票**：在飞的那次扫描就算回来了也提交不进来。
            s.tree.invalidate(generation, epoch, &real);
        } else if let Some(hit) = s.tree.hit(generation, epoch, &real) {
            return Ok(First::Cached(ListDirResult {
                path: real.display().to_string(),
                generation,
                epoch,
                req,
                entries: hit,
                stats: tree::ScanStats::default(),
            }));
        }
        let stamp = s.tree.begin(generation, epoch, &real);
        // ⚠️ 清单也进快照（`design/0040`）：锁外不许再碰 `s.config`。
        Ok(First::Scan(Ticket {
            real,
            grants: s.grants.clone(),
            ignore: s.config.ignore_dirs.clone(),
            stamp,
            epoch,
        }))
    })?;

    let r = match first {
        First::Cached(r) => return Ok((r, true, cache_layers)),
        First::Scan(t) => {
            // ── ② 放锁读盘（阻塞池，⛔ 不占异步运行时的工作线程）──
            let requested_gen = generation;
            let start_epoch = t.epoch;
            let real_for_err = t.real.clone();
            let join = tauri::async_runtime::spawn_blocking(move || {
                let scanned =
                    tree::list_dir(&t.grants, &t.real, requested_gen, start_epoch, req, &t.ignore);
                (scanned, t.real, t.stamp)
            })
            .await;
            let (scanned, real, stamp) = match join {
                Ok(v) => v,
                // ⚠️ 走到这里意味着扫描线程自己没了（panic）。⛔ 别把它与"这个目录读不出来"
                //    用同一句文案——那会把我们代码里的 panic 说成用户目录的问题。
                Err(e) => {
                    return Err(Denied::worker_lost(&real_for_err, "目录扫描线程没能跑完", e))
                }
            };

            match scanned {
                Ok(r) => {
                    // ── ③ 再进锁：复核**当刻**代次与纪元 → 凭票提交 ──
                    let submitted = state.with(|s| -> Result<bool, Denied> {
                        let current = s.grants.root_generation();
                        let current_epoch = s.disk.epoch;
                        // ⚠️ 这里的 `generation` / `start_epoch` 是**请求 / 起步**侧的，
                        //    比较对象必须是当刻值（`design/0039` §6 最怕的第三种）。
                        // ⭐ 两种不符要**分开报**（`INV-DISK-09` 末条）：换根要清树重列，
                        //    内容修订只要保留旧视图重试一次。
                        if current != generation {
                            return Err(Denied::stale(generation, current));
                        }
                        // ⭐ 判据仍是那条**纯函数**（`INV-TREE-12`）：换根与换修订
                        //    都走它，区别只在上面已经把"换根"单独分流成 `stale` 了。
                        if !tree::should_commit(
                            current,
                            current_epoch,
                            generation,
                            start_epoch,
                            true,
                        ) {
                            return Err(Denied::stale_revision(start_epoch, current_epoch));
                        }
                        Ok(s.tree.commit(generation, start_epoch, &real, stamp, r.entries.clone()))
                    });
                    if !submitted? {
                        // ⭐ 票失效：有人 `fresh` 过、或有更晚的扫描领了票。
                        //    ⛔ 不写缓存、⛔ **也不再把结果照回前端**
                        //    （`design/0050` 正面推翻 `0039` §2.1 ③ 那一句：
                        //     一份说不清"对应哪个修订"的列表就是来源不明的盘上事实）。
                        //    前端那条"保留旧视图 ＋ 重试"的路由 `stale_revision` 接住。
                        diag!("▶ list_dir {} 票已失效 ⇒ 不写缓存，也不再回给前端", r.path);
                        return Err(Denied::ticket_taken(start_epoch));
                    }
                    r
                }
                Err(e) => return Err(e),
            }
        }
    };

    Ok((r, false, cache_layers))
}

/// ⭐ **取一份索引：两条读取路径的唯一入口**（`design/0041` §2.1.2，`INV-DOCS-01/10`）。
///
/// 文件名搜索与文档列表都走这里，⛔ 不许各写一份——两份的失效/发布逻辑必然漂移。
///
/// # 三段式锁（`design/0009` §2.1 ②.2）
///
/// ① 持锁只做内存事（取 `grants`/代次/缓存/过滤清单，**未命中时领票**）→
/// ② **锁外**遍历 → ③ 持锁按**代次 ＋ 票号**决定是否发布。
///
/// # 票号协议（last-started-wins，`design/0041` R2）
///
/// ⚠️ 只核代次挡不住**同代次内的并发重建**：A 先起步、B 后起步，B 先发布，
/// A 晚完成时代次没变——只核代次就会让**旧的**覆盖新的。
/// ⇒ 每次"要建"都在锁里 `index_ticket += 1` 领票；发布点要求票号仍等于自己领的那张。
/// 票号不符时：
/// - 当前缓存对**当刻**代次新鲜 ⇒ 返回**它**（更新的一版已经在手上了）；
/// - 否则 ⇒ `stale`，让前端重发（⛔ 不发布一份已经落后的结果）。
///
/// ⚠️ 同根重复 rebuild **不合并、不取消**：各自跑完、晚起步的赢。
/// 代价是可能的重复读盘；收益是不需要跨线程取消机制（`walk` 里也只能在下一层看到取消）。
fn obtain_index(
    state: &AppState,
    rebuild: bool,
) -> Result<std::sync::Arc<tree::FileIndex>, Denied> {
    // ① 持锁：能用的旧索引 / 领票
    let (grants, generation, epoch, cached, ignore, ticket) = state.with(|s| {
        let generation = s.grants.root_generation();
        let epoch = s.disk.epoch;
        // ⭐ `design/0050` 最终约束 6：**同一纪元最多建一次**。
        //    索引的新鲜度现在同时看（代次, 内容修订, root 集合）——
        //    盘上没变过 ⇒ 缓存就是当刻的盘，重建只会白扫一遍。
        //    ⚠️ 这**改了** `design/0009` §2.1 ②.1 「`rebuild` = 强制重建」的字面语义：
        //    真正的"从盘上重来一次"现在是 **`reconcile_disk`**（它推内容修订），
        //    `rebuild` 只剩"确保这份索引对当刻纪元新鲜"。见 `design/0050` §10。
        let cached = s
            .index
            .clone()
            .filter(|ix| ix.is_fresh(generation, epoch, s.grants.roots()));
        let ticket = if cached.is_some() {
            s.index_ticket
        } else {
            s.index_ticket = s.index_ticket.wrapping_add(1);
            s.index_ticket
        };
        (s.grants.clone(), generation, epoch, cached, s.config.ignore_dirs.clone(), ticket)
    });
    // ⚠️ 锁在这里就**放掉了**——下面整趟遍历都在锁外跑
    if let Some(ix) = cached {
        if rebuild {
            diag!("▶ 索引：纪元 {epoch} 已有一份新鲜索引 ⇒ 复用（⛔ 不重复扫盘）");
        }
        return Ok(ix);
    }

    let built = tree::build_index(&grants, &ignore, epoch)?;

    // ③ 再持锁：代次／纪元未变 **且** 票号仍是自己那张，才发布
    state.with(|s| publish_index(s, generation, epoch, ticket, built))
}

/// ⭐ **`obtain_index` 的阻塞池版本**（2026-10-29 代码评审第 12 条）。
///
/// `obtain_index` 是**同步**的：它第 ② 段要跑一整趟递归读盘（实测 10 万条
/// **112.75 ms 热 / 292.25 ms 冷**，`design/0041` 步骤 0）。两条 `async` 命令
/// （[`search_files`] / [`list_documents`]）若直接调它，那几百毫秒就压在
/// **异步运行时的工作线程**上 ⇒ 同一时刻别的命令一起排队。这正是 `list_dir`
/// 用 `spawn_blocking` 的理由（`INV-TREE-11` 的同一条精神），此前只有那一条路径做了。
/// ⛔ 别把它改回同步调用——那在界面上表现为"敲一个字符，别的操作卡一下"。
///
/// ⚠️ **索引的构建入口仍只有 [`obtain_index`] 一处**（`INV-DOCS-01` 的源码闸门）：
/// 这里只替它换一条线程，⛔ 不复制它的三段式。
/// ⚠️ `reconcile_once` **不走这里**：它自己就住在一条专职的 `std::thread` 上
/// （`kick_reconcile`），在那里阻塞正是设计。
async fn obtain_index_async(
    app: &tauri::AppHandle,
    rebuild: bool,
) -> Result<std::sync::Arc<tree::FileIndex>, Denied> {
    use tauri::Manager;
    let app = app.clone();
    let join = tauri::async_runtime::spawn_blocking(move || {
        // ⚠️ 在**阻塞池**里现取状态：`State<'_>` 借的是命令的生命周期，搬不进 'static 闭包。
        let Some(state) = app.try_state::<AppState>() else {
            return Err(Denied::worker_lost("", "索引构建线程拿不到会话状态", "应用正在退出"));
        };
        obtain_index(&state, rebuild)
    })
    .await;
    match join {
        Ok(v) => v,
        // ⚠️ 同 `list_dir`：走到这里是我们自己的线程没了（panic），
        //    ⛔ 不是"目录读不出来"。⚠️ `path` 留空——索引覆盖的是**全部根**，
        //    没有一个"出事的那一条路径"可回显（`Display` 本来也不用它）。
        Err(e) => Err(Denied::worker_lost("", "索引构建线程没能跑完", e)),
    }
}

/// ⭐ **发布点**：索引的唯一写入处（`design/0041` §2.1.2 第 ③ 段）。
///
/// 抽成独立函数不是为了复用，而是为了**能被确定性地测**：两个并发构建没法在单测里
/// 排成固定交错，但"票号过期 / 代次变了 / 缓存新鲜"这三类判据全是纯状态转移，
/// 直接喂 `(Session, 代次, 票号, 构建结果)` 就能把每一种交错钉死。
///
/// 判据**顺序固定**（⛔ 别对调）：
/// 1. **代次**变了 ⇒ `stale`，什么都不写（切根之后旧结果一律作废，票号再对也没用）；
/// 2. **票号**不是最新 ⇒ 手里若有对当刻代次新鲜的索引就返回**它**，否则 `stale`
///    （⛔ 不发布一份已经落后的结果，也⛔ 不把缓存清掉）；
/// 3. 两条都过 ⇒ `index_rev += 1` 写进 `built.rev`，发布 `Arc`。
///
/// ⚠️ 返回的 `Arc` 可能是**别人建的**（第 2 条那一支）：调用方照样能拿它去出结果，
/// 只是这份构建的读盘白做了——这正是"不取消、晚起步的赢"的代价。
fn publish_index(
    s: &mut Session,
    generation: u64,
    epoch: u64,
    ticket: u64,
    mut built: tree::FileIndex,
) -> Result<std::sync::Arc<tree::FileIndex>, Denied> {
    let now = s.grants.root_generation();
    if now != generation {
        diag_stderr!("▶ 索引：遍历期间代次变了（{generation} → {now}），丢弃这份");
        diag_file!("▶ 索引：遍历期间代次变了（{generation} → {now}），丢弃这份");
        return Err(Denied::stale(generation, now));
    }
    // ⭐ `design/0050` 最终约束 6：**索引与树必须提交在同一个内容修订上**。
    //    遍历期间盘上变过 ⇒ 这份索引描述的是一个**已经过去**的时刻，
    //    发出去就等于"树按新盘画、过滤按旧盘判"（§2.1 ⑤ 那条老 bug 的根）。
    let now_epoch = s.disk.epoch;
    if now_epoch != epoch {
        return match s.index.clone().filter(|ix| ix.is_fresh(now, now_epoch, s.grants.roots())) {
            Some(ix) => {
                diag_stderr!(
                    "▶ 索引：遍历期间内容修订变了（{epoch} → {now_epoch}），改用更新的缓存"
                );
                Ok(ix)
            }
            None => {
                // ⚠️ 报 `stale_revision`（⛔ 不是 `stale`）：前端应当**保留旧视图 ＋ 重试**，
                //    而不是把树清掉重列（`INV-DISK-09` 末条）。
                diag_stderr!(
                    "▶ 索引：遍历期间内容修订变了（{epoch} → {now_epoch}），且无可用缓存 ⇒ 重试"
                );
                Err(Denied::stale_revision(epoch, now_epoch))
            }
        };
    }
    if s.index_ticket != ticket {
        // 有更新的构建已经起步：手上有对当刻代次新鲜的索引就用它，否则让前端重发
        return match s.index.clone().filter(|ix| ix.is_fresh(now, now_epoch, s.grants.roots())) {
            Some(ix) => {
                diag_stderr!("▶ 索引：票号已过期（{ticket} ≠ {}），改用更新的缓存", s.index_ticket);
                Ok(ix)
            }
            None => {
                diag_stderr!("▶ 索引：票号已过期（{ticket} ≠ {}），且无可用缓存 ⇒ stale", s.index_ticket);
                Err(Denied::stale(generation, now))
            }
        };
    }
    s.index_rev = s.index_rev.wrapping_add(1);
    built.rev = s.index_rev;
    let ix = std::sync::Arc::new(built);
    s.index = Some(ix.clone());
    Ok(ix)
}

/// **读取命令** · 文件名模糊搜索（`design/0009` §2.1，2026-10-14 已通过）。
///
/// ⭐ **它只读**：⛔ 不新增任何可读路径、⛔ 不改变授权、⛔ 不收 root 参数
/// （「让前端指定扫哪里」就是一个绕过 `INV-FS-04` 的口子）。
/// 遍历用的 grants 是**后端自己持有的那一份**。
///
/// ⚠️ 索引的取用、代次核对与发布票号全在 [`obtain_index`]——本命令只做匹配。
///
/// # 关于 `rebuild`
///
/// ⚠️ **这一项是本次实施对设计的一处偏离**（`design/0009` §2.1 ②.1 冻结的请求是
/// `search_files(pattern, req)`）：§2.1 ② 的重建时机表里有两条**前端必须能表达**的
/// ——「每次浮层打开」与「浮层开着时按 `Cmd+R`」——而只靠"索引不存在时就建"
/// 表达不了它们（第一版索引建好之后，那两条就再也触发不了了）。
/// ⛔ 替它另开一条 `refresh_index` 命令会更糟：那是一条新的读盘命令（§2.1 ⑤ 明令不新增）。
/// ⇒ 加一个**有文档的**布尔量，代价是前端多传一个字段，好处是"
/// 谁在什么时候重建"这件事在协议里**看得见**（stderr 那行日志也打它）。
#[tauri::command]
pub async fn search_files(
    app: tauri::AppHandle,
    pattern: String,
    req: u64,
    rebuild: bool,
) -> Result<SearchResult, Denied> {
    // ⚠️ 走**阻塞池**那一版（评审第 12 条）：整趟递归读盘不许压在异步工作线程上。
    let index = obtain_index_async(&app, rebuild).await?;
    let generation = index.roots_gen;

    // ② 匹配在锁外做（5 万条约 2 ms；放进临界区等于每次按键都堵住 FSEvents 回调）
    let outcome = tree::search(&index, &pattern);
    diag_stderr!(
        "▶ search_files {pattern:?}（代次 {generation}，索引 {} 条/{} 目录，年龄 {} ms，{}）：命中 {} → 显示 {}（① 隐藏 {}｜② 灰显 {}｜软链 {}｜其它 {}｜跳过子树 {}｜{:.2} ms）",
        index.len(),
        index.stats.dirs,
        index.age_ms(),
        if rebuild { "强制重建" } else { "用缓存" },
        outcome.total_hits,
        outcome.hits.len(),
        index.stats.skipped_dot,
        index.stats.ignored,
        index.stats.skipped_symlink,
        index.stats.skipped_other,
        index.stats.skipped_denied,
        index.stats.scan_ms
    );
    // ⚠️ 文件里**不留搜索词**（它是用户输入，`INV-LOG-01`）——只留长度与计数。
    diag_file!(
        "▶ search_files（代次 {generation}，索引 {} 条/{} 目录，年龄 {} ms，{}）：命中 {} → 显示 {}｜pattern_len={}｜{:.2} ms",
        index.len(),
        index.stats.dirs,
        index.age_ms(),
        if rebuild { "强制重建" } else { "用缓存" },
        outcome.total_hits,
        outcome.hits.len(),
        pattern.len(),
        index.stats.scan_ms
    );

    Ok(SearchResult {
        generation,
        req,
        roots: index.roots.clone(),
        entries: outcome.hits,
        total_hits: outcome.total_hits,
        truncated: outcome.truncated,
        built_at_ms: index.age_ms(),
    })
}

/// **读取命令** · 文档列表（`design/0041` §2.1.3，2026-10-24 已通过）。
///
/// ⭐ **只读**，且与 [`search_files`] **共用同一份索引**（[`obtain_index`]，`INV-DOCS-01`）：
/// ⛔ 不新增读盘路径、⛔ 不新增授权面、⛔ 不建第二份清单。
///
/// 返回的是**派生视图**：`entries` 排好序、按 [`tree::MAX_DOCS`] 截断；
/// `keep_dirs`（树过滤判据）与 `total` 来自**完整索引**，⛔ 不跟着截断——
/// 否则"末尾 md 的祖先"会因为显示上限被误藏（R7）。
///
/// ⚠️ `generation` 是前端手上的代次：不符 ⇒ `stale`（与 `search_files` 同款）。
/// ⚠️ `rebuild` 与搜索那个同名参数语义**逐字相同**：重建时机见 `design/0009` §2.1。
#[tauri::command]
pub async fn list_documents(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    generation: u64,
    req: u64,
    rebuild: bool,
) -> Result<DocListResult, Denied> {
    let current = state.with(|s| s.grants.root_generation());
    if generation != current {
        return Err(Denied::stale(generation, current));
    }

    // ⚠️ 同 [`search_files`]：走阻塞池那一版（评审第 12 条）。
    let index = obtain_index_async(&app, rebuild).await?;
    let result = DocListResult::from_index(&index, req);

    diag_stderr!(
        "▶ list_documents（代次 {}，索引 rev {} / {} 条 / {} 目录，年龄 {} ms，{}）：发出 {} / 共 {}（截断 {}）｜keep_dirs {}｜未完成 {} 处｜{:.2} ms",
        result.generation,
        result.index_rev,
        index.len(),
        index.stats.dirs,
        result.age_ms,
        if rebuild { "强制重建" } else { "用缓存" },
        result.entries.len(),
        result.total,
        result.truncated,
        result.keep_dirs.len(),
        result.incomplete.len(),
        index.stats.scan_ms
    );
    diag_file!(
        "▶ list_documents（代次 {}，rev {}，{} 条）：发出 {} / 共 {}（截断 {}）｜keep_dirs {}｜complete {}｜{:.2} ms",
        result.generation,
        result.index_rev,
        index.len(),
        result.entries.len(),
        result.total,
        result.truncated,
        result.keep_dirs.len(),
        result.complete,
        index.stats.scan_ms
    );

    Ok(result)
}

/// 弹一次系统选择器，返回用户确认的路径。
///
/// ⚠️ **回调式**而不是 `blocking_pick_*`：那两个会**阻塞当前线程**，
/// 而 macOS 上的对话框只能在主线程跑——在异步命令里用回调，
/// 让 Tauri 把它派到主线程去，我们在这边 `await`。
///
/// ⚠️ 为什么对话框由 **Rust 侧**弹而不是前端调 `dialog` 插件：
/// 那样要把 `dialog:*` 权限授予前端，而前端的对话框结果就是一个
/// **可伪造的路径字符串**。现在对话框的返回值直接进 `SessionGrants`，
/// 中间不经过任何能被前端改写的东西（`INV-FS-04` 的落点）。
async fn pick(
    app: &tauri::AppHandle,
    directory: bool,
    initial: Option<&str>,
) -> Option<PathBuf> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    let dialog = app.dialog();
    if directory {
        // ⚠️ 只对"选目录"预置：选**文件**时的基准目录是用户上一次的文件位置，
        //    那不是我们记的东西（配置只记目录，见 `config` 模块头第 2 条）。
        let mut b = dialog.file().set_title("选择要阅读的目录");
        if let Some(dir) = initial {
            b = b.set_directory(dir);
        }
        b.pick_folder(move |p| {
            let _ = tx.blocking_send(p);
        });
    } else {
        dialog
            .file()
            .set_title("打开一份 Markdown 文档")
            .add_filter("Markdown", &["md", "markdown"])
            .pick_file(move |p| {
                let _ = tx.blocking_send(p);
            });
    }
    // ⚠️ 用户取消时回调**仍然会**被调用（参数是 `None`），所以这里不会一直挂着
    let picked = rx.recv().await.flatten()?;
    picked.into_path().ok()
}

/// 启动时用的：把 argv 给的路径变成一次授权（`design/0003` §2.1.2 (2) 表的第三行）。
///
/// ⚠️ 启动参数与选择器**同等效力**——它由用户自己启动进程时给出。
/// ⛔ 任何**命令**都不得调它（ACL / 前端拿不到这个入口）。
///
/// ⭐ `design/0015` 起它有两个调用点，**都是"用户动作"而非"命令"**：
/// ① 启动 argv（`gui::run` 的 `setup`）；② macOS Apple Event（`gui::handle_open_urls`）。
/// ⇒ `INV-APP-02` 的措辞是「授权写点只有这两处」，⛔ 不是"只有 argv 一处"。
///
/// 返回**规范化后的真实路径**：`Session::startup_document` 要拿它显示
/// "所在目录"（§2.1.4 的 `pending_directory`），而那个目录必须与
/// `open_document` 之后算出来的一致——否则未授权态会指向一个**同义但不同字面**的路径。
pub fn authorize_startup(grants: &mut SessionGrants, path: &Path) -> Result<(Mode, PathBuf), Denied> {
    let md = std::fs::metadata(path).map_err(|_| Denied::not_found(path))?;
    if md.is_dir() {
        let real = grants.authorize_root(path)?;
        Ok((Mode::Directory, real))
    } else {
        let real = grants.authorize_file(path)?;
        Ok((Mode::SingleFile, real))
    }
}

/// ⭐ **写入命令（新建）** · 在已授权目录里新建一个空文件或一个目录（`design/0034` §2.1 B）。
///
/// # 它是 `fs` 模块里唯一的写入口，而它只做四件事
///
/// ```
/// check_creatable(父) → validate_name(名字) → create_new / create_dir → 复核 containment
/// ```
///
/// ① **父目录闸门** [`SessionGrants::check_creatable`]：`check_readable` 同源 + 必须是
///    真目录 + 逐段复用 `tree::classify`（树里看不见 / 不可展开的位置，这里也建不了）。
/// ② **名字判据**只有一份：`fs::create::validate_name`（`INV-TREE-07`）。
/// ③ **存在性与创建是同一次系统调用**（`create_new` / `create_dir`，`INV-FS-07`）
///    ⇒ 重名**原子地**返回 `already_exists`，⛔ 不覆盖、⛔ 不自动改名。
/// ④ **创建后复核**：父目录再 `canonicalize` 一次，出了根就报 `created_outside_root`，
///    ⛔ **不删除**（`design/0034` §4）。
///
/// # 为什么整个动作在一个 `with` 闭包里
///
/// 与 `authorize_root` / `revoke_roots` **线性化**（同一把 `Mutex<Session>`）：
/// "检查父目录 → 创建"之间不会插进一次换根。
/// ⚠️ 但这**不**与外部进程线性化——本机文件系统没有那个能力，所以最后才要那道复核。
///
/// ⚠️ 前端传来的是**请求**，真值来自 `check_creatable` 返回的**规范化路径**；
/// 返回给前端的也是那个路径（⛔ 不是把请求原样回显）。
///
/// ⛔ **不调用 `authorize_file` / `authorize_root`**：新条目落在授权根下，
/// 本来就过得了 `check_readable`（`INV-FS-06`）。
#[tauri::command]
pub fn create_entry(
    state: tauri::State<'_, AppState>,
    parent: String,
    name: String,
    kind: crate::fs::create::CreateKind,
) -> Result<crate::fs::create::CreatedEntry, Denied> {
    let result = state.with(|s| {
        let real_parent = s.grants.check_creatable(Path::new(&parent), &s.config.ignore_dirs)?;
        let final_name = crate::fs::create::validate_name(&name, kind, &s.config.ignore_dirs)?;
        crate::fs::create::create_in(&s.grants, &real_parent, &final_name, kind)
    });

    match &result {
        // ⚠️ 成功日志只打**路径与类型**，⛔ 不打任何正文（这里是空文件，但口径要一致）。
        Ok(e) => diag!("▶ 新建成功：{}（{:?}）", e.path, e.kind),
        Err(e) => {
            // ⚠️ `label()` 是短的分类（"目标已存在" / "名字为空"…），足够排障，
            //    而 ⛔ 不把用户输入的名字打进日志的"内容"位置——它就是路径的一部分。
            diag_stderr!("▶ 新建被拒（{parent}）：{}（{e}）", e.label());
            diag_file!(
                "▶ 新建被拒 label={} err_len={}",
                e.label(),
                e.to_string().len()
            );
        }
    }
    result
}

/// ⭐ **写入命令（改名）** · 同一目录内把一份普通 Markdown 文件改名（`design/0035` §3.3）。
///
/// # 顺序是硬要求（`INV-RENAME-07`/`08`）
///
/// ```
/// check_renamable(from) → rename_guard(real) → validate_name → renamex_np → 状态迁移
/// ```
///
/// 前四步与状态迁移**全在同一个 `with` 闭包**里（同一把 `Mutex<Session>`）：
///
/// - 保存的①段持锁置 `save_inflight` ⇒ 改名看到它 ⇒ 拒；
/// - 改名的闭包先跑完 ⇒ `current_document` 已是新路径、`edit_target` 是 `None`
///   ⇒ 迟到的保存在①段就 `not_authorized`，**在碰磁盘之前**退出。
///   ⇒ ⛔ 不会出现"保存在旧路径重建文件"那个洞（§3.3.7 R1）。
///
/// # 成功之后只有"降级"，没有"失败"（§3.6）
///
/// `renamex_np` 返回 0 那一刻起，改名**已经成立**。后续任何一步失败都只能进
/// `degraded`：⛔ 不报"改名失败"、⛔ 不反向改名（并发期间别人可能已经建了同名条目）。
///
/// ⚠️ `from` 是**请求**，真值来自 `check_renamable` 的规范化路径；
/// 新名字走**唯一一份**名字判据 `fs::create::validate_name`（`INV-RENAME-02`）。
/// ⛔ 不接受"目标目录"参数：重命名只在原目录内（`INV-RENAME-03`）。
#[tauri::command]
pub fn rename_entry(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    from: String,
    name: String,
) -> Result<crate::fs::rename::RenamedEntry, Denied> {
    let result: Result<crate::fs::rename::RenamedEntry, Denied> = state.with(|s| {
        let requested = Path::new(&from);
        let real = s.grants.check_renamable(requested, &s.config.ignore_dirs)?;
        // ⭐ 两道状态拦截（编辑态 / 保存在途）**必须在碰磁盘之前**
        s.rename_guard(&real)?;

        // ⚠️ 旧名字取**请求**的最后一段（`check_renamable` 的第 6 步也是这个口径）
        let old_name = requested
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| Denied::not_found(requested))?;
        let final_name =
            crate::fs::create::validate_name(&name, crate::fs::create::CreateKind::File, &s.config.ignore_dirs)?;
        let parent = real.parent().ok_or_else(|| Denied::not_found(requested))?;
        let to = parent.join(&final_name);

        let generation = s.grants.root_generation();

        // ── §3.4 幂等：名字没变 ⇒ 成功，⛔ 不调用系统调用（但两道拦截已经判过）──
        if crate::fs::rename::same_name(old_name, &final_name) {
            return Ok(crate::fs::rename::RenamedEntry {
                path: real.display().to_string(),
                name: final_name,
                old_path: real.display().to_string(),
                current_moved: false,
                watch_seq: 0,
                degraded: Vec::new(),
            });
        }

        // ── 唯一不可撤销的那一步（§3.5：FS 先做，状态后迁）──
        crate::fs::rename::rename_in(&real, &to)?;

        // ── 以下每一步失败都只降级 ──────────────────────────────
        let mut degraded: Vec<&'static str> = Vec::new();
        if !crate::fs::rename::still_inside(&s.grants, &to) {
            degraded.push(crate::fs::rename::DEGRADED_PATH_CHECK);
        }

        // 当前文档 / 缓存 / 索引 / 目录会话（§3.5 那张表）。
        // ⚠️ 这整段在 `Session::commit_rename` 里——「起监视」以闭包注入，
        //    ⇒ 迁移矩阵（B6/B7）能在 `--features gui` 下用真 `Session` 单测。
        // ⚠️ 这会是 `current_document` 的**第三个**写入点。
        let (current_moved, watch_seq, mut migrate_degraded) =
            s.commit_rename(&real, &to, |path, seq| {
                // ⚠️ 与 `watch_document` 同款：起新失败 ⇒ 没有监视（降级）。
                match crate::external::watch::start(&app, path, seq, generation) {
                    Ok(w) => crate::commands::WatchRestart::Started(w),
                    Err(e) => {
                        diag_stderr!("⚠️ 改名后重启监视失败（{seq}）：{e}");
                        crate::commands::WatchRestart::Failed
                    }
                }
            });
        degraded.append(&mut migrate_degraded);

        Ok(crate::fs::rename::RenamedEntry {
            path: to.display().to_string(),
            name: final_name,
            old_path: real.display().to_string(),
            current_moved,
            watch_seq,
            degraded,
        })
    });

    match &result {
        // ⚠️ 日志只打**路径与结果**，⛔ 不打正文（`INV-LOG-01`）
        Ok(e) => diag!(
            "▶ 改名成功：{} → {}（当前文档 {}，降级 {:?}）",
            e.old_path,
            e.path,
            if e.current_moved { "是" } else { "否" },
            e.degraded
        ),
        Err(e) => {
            diag_stderr!("▶ 改名被拒（{from}）：{}（{e}）", e.label());
            diag_file!("▶ 改名被拒 label={} err_len={}", e.label(), e.to_string().len());
        }
    }
    result
}

/// 一次「在访达中显示」的结果（`design/0048`）。
///
/// ⚠️ 回给前端的是**规范的绝对路径**（`check_readable` 的返回值），⛔ 不是请求原样回显。
#[derive(Debug, Clone, Serialize)]
pub struct RevealOutcome {
    pub path: String,
    pub is_dir: bool,
}

/// ⭐ **读取命令（在访达中显示）** · 把一个**已授权**的条目交给 Finder（`design/0048`）。
///
/// # 为什么它是**读取**命令
///
/// `check_readable` 只回答"这个路径**现在**可不可读"，⛔ 不新增任何可读路径
/// （`INV-FS-04`）、⛔ 不改授权代次、⛔ 不动树缓存、⛔ 不写盘。
/// 它把路径交给**系统**（与 `open_link` 同一类动作），⛔ 不是 rmd 去读那份文件。
///
/// # 两条硬要求
///
/// - 文件 ⇒ `open -R`（定位并选中）；目录 ⇒ `open <dir>`（直接打开那个目录）。
/// - `spawn` **可注入**：生产传 `crate::link::spawn_detached`，单测传记录器
///   ⇒ **一个字节都不真的派发**（与 `commands/link.rs::open_link` 同款手法）。
#[tauri::command]
pub fn reveal_entry(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<RevealOutcome, Denied> {
    let result = state.with(|s| {
        reveal_entry_in(s, Path::new(&path), &mut crate::link::spawn_detached)
    });
    match &result {
        // ⚠️ 日志只打**路径与类型**（⛔ 不打正文，`INV-LOG-01`）
        Ok(o) => diag!("▶ 在访达中显示：{}（目录 {}）", o.path, o.is_dir),
        Err(e) => {
            diag_stderr!("▶ 在访达中显示被拒（{path}）：{}（{e}）", e.label());
            diag_file!(
                "▶ 在访达中显示被拒 label={} err_len={}",
                e.label(),
                e.to_string().len()
            );
        }
    }
    result
}

/// [`reveal_entry`] 的**锁内整段**（命令层只要 `AppState`，判据全在这里）。
///
/// ⚠️ 顺序是判据的一部分：**先过 `check_readable` 拿到规范路径**，再判类型、
/// 再组 argv、最后才派发。⛔ 不许拿请求里那个未规范化的字符串去 `open`
/// （那正是 `INV-FS-01` 说的 TOCTOU）。
fn reveal_entry_in(
    s: &Session,
    requested: &Path,
    spawn: &mut dyn FnMut(&[OsString]) -> std::io::Result<()>,
) -> Result<RevealOutcome, Denied> {
    let real = s.grants.check_readable(requested)?;
    // ⚠️ 类型看**规范路径**（软链已经解开）：`check_readable` 保证它存在
    let is_dir = real.is_dir();
    let argv = crate::link::reveal_or_open_argv(&real, is_dir)
        .ok_or_else(|| Denied::not_found(&real))?;
    spawn(&argv).map_err(|e| Denied::io(&real, e))?;
    Ok(RevealOutcome { path: real.display().to_string(), is_dir })
}

#[cfg(test)]
mod tests {
    //! ⭐ `design/0038` §7 第 2 条：`open_recent_directory` 的白名单**八种情形**。
    //!
    //! ⚠️ 这里测的是**锁内整段** [`enter_recorded_directory`]，⛔ 不是命令本身——
    //! 命令层要 `AppHandle`，而全部判据都在这一段里（`INV-START-02`）。
    //! ⚠️ **每一条拒绝情形都另断言"状态一个字节不变"**：`roots` / 代次 / `files` /
    //! 树缓存 / 配置 / 监视代号——`design/0038` §2.4 第 5 步承诺的就是这三条里的前两条。

    use super::*;
    use crate::commands::Session;
    use crate::config::{Config, DirSession};
    use crate::fs::tree::TreeEntry;
    use std::collections::VecDeque;

    /// 一次性测试目录。⚠️ **`canonicalize` 之后返回**：`/var` 与 `/private/var`
    /// 在 macOS 上是两个字符串——记录值必须是真正的那个，否则每条用例都先输在"非规范"上。
    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!("rmd-recent-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).unwrap();
            TestDir { path: std::fs::canonicalize(&base).unwrap() }
        }

        fn p(&self) -> &Path {
            &self.path
        }

        fn dir(&self, name: &str) -> PathBuf {
            let d = self.path.join(name);
            std::fs::create_dir_all(&d).unwrap();
            d
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn session(config_path: PathBuf) -> Session {
        Session {
            grants: SessionGrants::new(),
            tree: crate::fs::tree::TreeCache::new(),
            config: Config::default(),
            config_path,
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
            index_ticket: 0,
            index_rev: 0,
            tree_watch: None,
            // ⭐ `design/0050`：磁盘状态由 FSEvents 驱动，这批测试够不到 ⇒ 用初值
            //    （那几条命令只关心授权与最近表，⛔ 不在这里伪造纪元推进）。
            disk: Default::default(),
            last_disk_rev: 0,
            reconcile_inflight: false,
        }
    }

    /// 给会话塞一条**非空**的目录会话（空会话会被 `set_dir_session` 当场删掉，
    /// `INV-SESS-12`——那是另一件事，别在这里踩）。
    fn record_dir(s: &mut Session, root: &str) {
        s.config.set_dir_session(
            root,
            DirSession {
                last_file: Some(format!("{root}/a.md")),
                expanded: Vec::new(),
                updated_at: 0,
            },
        );
    }

    /// 把"拒绝时不许变"的那几样一次性冻住。
    ///
    /// ⚠️ 树缓存里**先塞一层**：`len()` 恒为 0 时"没变"这个断言是空的。
    fn freeze(s: &mut Session) -> (Vec<PathBuf>, u64, Vec<PathBuf>, Option<String>, usize, u64, std::collections::BTreeMap<String, DirSession>) {
        s.tree.seed(
            s.grants.root_generation(),
            s.disk.epoch,
            Path::new("/whatever"),
            vec![TreeEntry {
                name: "a.md".to_string(),
                path: "/whatever/a.md".to_string(),
                is_dir: false,
                ignored: false,
            }],
        );
        (
            s.grants.roots().to_vec(),
            s.grants.root_generation(),
            s.grants.files().to_vec(),
            s.config.last_directory.clone(),
            s.tree.len(),
            s.watch_seq,
            s.config.dir_sessions.clone(),
        )
    }

    #[test]
    fn 最近目录_命中dir_sessions的键() {
        let t = TestDir::new("hit-session");
        let dir = t.dir("notes");
        let real = std::fs::canonicalize(&dir).unwrap().display().to_string();
        let mut s = session(t.p().join("config.json"));
        record_dir(&mut s, &real);

        let snap = enter_recorded_directory(&mut s, &real).expect("记过的路径必须放行");
        assert_eq!(snap.roots, vec![real.clone()]);
        assert_eq!(s.grants.root_generation(), 1, "换根要 +1");
        assert_eq!(s.config.last_directory.as_deref(), Some(real.as_str()), "要记进 last_directory");
        assert!(t.p().join("config.json").exists(), "收尾要真的落盘");
    }

    #[test]
    fn 最近目录_只命中last_directory的旧配置() {
        let t = TestDir::new("hit-last");
        let dir = t.dir("notes");
        let real = std::fs::canonicalize(&dir).unwrap().display().to_string();
        let mut s = session(t.p().join("config.json"));
        // ⚠️ 只有 last_directory、没有 DirSession —— 只点过一次面板的旧配置就长这样
        s.config.set_last_directory(Path::new(&real));
        assert!(s.config.dir_session(&real).is_none());

        let snap = enter_recorded_directory(&mut s, &real).expect("last_directory 也在白名单里");
        assert_eq!(snap.roots, vec![real]);
        assert_eq!(s.grants.root_generation(), 1);
    }

    #[test]
    fn 最近目录_未记录的路径一律拒绝且状态不变() {
        let t = TestDir::new("unrecorded");
        let dir = t.dir("notes");
        let real = std::fs::canonicalize(&dir).unwrap().display().to_string();
        let mut s = session(t.p().join("config.json"));
        record_dir(&mut s, &real);
        let before = freeze(&mut s);

        let err = enter_recorded_directory(&mut s, "/definitely/not/recorded")
            .expect_err("白名单外的路径必须拒绝");
        assert!(matches!(err, Denied::NotAuthorized { .. }), "白名单拒绝是 NotAuthorized：{err:?}");
        assert_eq!(before, freeze(&mut s), "拒绝时 roots/代次/files/缓存/配置/监视代号一个字节不变");
        assert!(!t.p().join("config.json").exists(), "拒绝不许写盘");
    }

    #[test]
    fn 最近目录_记录但已删除时not_found且状态不变() {
        let t = TestDir::new("gone");
        let dir = t.dir("notes");
        let real = std::fs::canonicalize(&dir).unwrap().display().to_string();
        let mut s = session(t.p().join("config.json"));
        record_dir(&mut s, &real);
        let before = freeze(&mut s);
        std::fs::remove_dir_all(&dir).unwrap();

        let err = enter_recorded_directory(&mut s, &real).expect_err("目录没了要拒");
        assert!(matches!(err, Denied::NotFound { .. }), "目录没了是 NotFound：{err:?}");
        assert_eq!(before, freeze(&mut s), "拒绝时状态一个字节不变");
        assert!(!t.p().join("config.json").exists());
    }

    /// ⭐⭐ **`design/0038` 二次复评 R2-1 的确定性夹具**：
    /// 记录目录在**点击之前**被挪走、原路径换成一条指向外部的软链。
    ///
    /// ⚠️ 若第 4 步写成 `canonicalize(recorded)`，两侧会**稳定地一起**解析到外部目录
    /// ⇒ 比较永远相等 ⇒ 越权（这条用例就是复评给的那四行输出的机械化）。
    #[test]
    fn 最近目录_记录目录在点击前被换成外部软链时拒绝() {
        let t = TestDir::new("swapped");
        let dir = t.dir("notes");
        let outside = t.dir("outside");
        let recorded = std::fs::canonicalize(&dir).unwrap().display().to_string();
        let mut s = session(t.p().join("config.json"));
        record_dir(&mut s, &recorded);
        let before = freeze(&mut s);

        // —— 点击之前：把记录目录挪走，原路径放一条指向外部的软链 ——
        std::fs::rename(&dir, t.p().join("moved")).unwrap();
        std::os::unix::fs::symlink(&outside, &dir).unwrap();

        let err = enter_recorded_directory(&mut s, &recorded)
            .expect_err("目标已经不是记录的那个目录了 ⇒ 必须拒绝");
        assert!(
            matches!(err, Denied::NotAuthorized { .. }),
            "换过目标的记录值是 NotAuthorized（⛔ 不是 NotFound）：{err:?}"
        );
        assert_eq!(before, freeze(&mut s), "拒绝时状态一个字节不变");
        assert!(
            !s.grants.roots().iter().any(|r| r == &outside),
            "⛔ 外部目录一个字节都不许进 roots"
        );
    }

    #[test]
    fn 最近目录_记录值是非规范字符串时拒绝() {
        let t = TestDir::new("noncanonical");
        let dir = t.dir("notes");
        let real = std::fs::canonicalize(&dir).unwrap().display().to_string();
        // 旧配置 / 手改 config：多一个 `/.`，`canonicalize` 之后才等于真路径
        let recorded = format!("{real}/.");
        let mut s = session(t.p().join("config.json"));
        record_dir(&mut s, &recorded);
        let before = freeze(&mut s);

        let err = enter_recorded_directory(&mut s, &recorded)
            .expect_err("非规范记录一律判不等 ⇒ 拒绝，让用户用 Cmd+O 重新授权");
        assert!(matches!(err, Denied::NotAuthorized { .. }), "{err:?}");
        assert_eq!(before, freeze(&mut s));
    }

    #[test]
    fn 最近目录_记录值是软链路径时拒绝() {
        let t = TestDir::new("symlink-recorded");
        let dir = t.dir("notes");
        std::os::unix::fs::symlink(&dir, t.p().join("link")).unwrap();
        let recorded = t.p().join("link").display().to_string();
        let mut s = session(t.p().join("config.json"));
        record_dir(&mut s, &recorded);
        let before = freeze(&mut s);

        let err = enter_recorded_directory(&mut s, &recorded)
            .expect_err("解析结果 ≠ 记录值本身 ⇒ 拒绝");
        assert!(matches!(err, Denied::NotAuthorized { .. }), "{err:?}");
        assert_eq!(before, freeze(&mut s));
    }

    #[test]
    fn 最近目录_前缀陷阱doc2不等于doc() {
        let t = TestDir::new("prefix");
        let doc = t.dir("doc");
        let doc2 = t.dir("doc2");
        let recorded = std::fs::canonicalize(&doc).unwrap().display().to_string();
        let other = std::fs::canonicalize(&doc2).unwrap().display().to_string();
        assert!(other.starts_with(&recorded), "前提：doc2 的字符串确实以 doc 开头");
        let mut s = session(t.p().join("config.json"));
        record_dir(&mut s, &recorded);
        let before = freeze(&mut s);

        let err = enter_recorded_directory(&mut s, &other)
            .expect_err("白名单是字面相等，⛔ 不是前缀");
        assert!(matches!(err, Denied::NotAuthorized { .. }), "{err:?}");
        assert_eq!(before, freeze(&mut s));
    }

    // ── `design/0041`：索引发布票号（R2）──────────────────────────────────

    /// 造一份**属于当前代次与 root** 的合成索引（不读盘）。
    fn fake_index(s: &Session) -> tree::FileIndex {
        tree::FileIndex {
            roots_gen: s.grants.root_generation(),
            // ⭐ `design/0050` 最终约束 6：索引必须记下它描述的那个**内容修订**
            //    ——`is_fresh` 的第二个判据就是它（⚠️ 漏了这个字段就编不过测试）。
            disk_epoch: s.disk.epoch,
            built_at: std::time::Instant::now(),
            rev: 0,
            roots: s.grants.roots().iter().map(|p| p.display().to_string()).collect(),
            entries: Vec::new(),
            stats: Default::default(),
            complete: true,
            incomplete: Vec::new(),
            ignored_dirs: Vec::new(),
        }
    }

    /// 领一张"当前有效"的票（与 `obtain_index` 第 ① 段同一动作）。
    fn take_ticket(s: &mut Session) -> u64 {
        s.index_ticket = s.index_ticket.wrapping_add(1);
        s.index_ticket
    }

    /// 推高一次**内容修订**（普通事件：只 `bump`，⛔ 不排核对）。
    ///
    /// ⚠️ 代次**不动**——这正是 `design/0050` 最终约束 6 说的那条缝：
    /// `roots_gen` 隔着"同一个根里内容变了"。
    fn bump_epoch(s: &mut Session) {
        s.disk.request(crate::disk::ReconcileCause::Signal(crate::disk::reaction(
            crate::disk::DiskSignal::Event,
        )));
    }

    /// ⭐ 正常路径：票号仍是最新 ⇒ 发布，`rev` 单调 +1，缓存指向它。
    #[test]
    fn 票有效时发布并递增版本() {
        let t = TestDir::new("pub-ok");
        let root = t.dir("root");
        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();

        let ticket = take_ticket(&mut s);
        let generation = s.grants.root_generation();
        let built = fake_index(&s);
        let ix = publish_index(&mut s, generation, 0, ticket, built).unwrap();
        assert_eq!(ix.rev, 1, "首次发布 rev = 1");
        assert_eq!(s.index_rev, 1);
        assert!(std::sync::Arc::ptr_eq(&ix, s.index.as_ref().unwrap()));

        let ticket2 = take_ticket(&mut s);
        let built = fake_index(&s);
        let ix2 = publish_index(&mut s, generation, 0, ticket2, built).unwrap();
        assert_eq!(ix2.rev, 2, "版本单调递增");
        assert!(ix2.rev > ix.rev);
    }

    /// ⭐ R2 的主交错：A 先领票、B 后领票（并先发布）⇒ **A 晚完成也写不进去**。
    #[test]
    fn 旧票晚完成不覆盖新索引() {
        let t = TestDir::new("pub-late");
        let root = t.dir("root");
        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let generation = s.grants.root_generation();

        let a = take_ticket(&mut s); // A 起步
        let b = take_ticket(&mut s); // B 起步（更晚）

        // B 先完成并发布
        let built = fake_index(&s);
        let new = publish_index(&mut s, generation, 0, b, built).unwrap();
        assert_eq!(new.rev, 1);

        // A 晚完成：票过期 ⇒ 拿到的必须是 B 那一份，⛔ 不许覆盖
        let built = fake_index(&s);
        let got = publish_index(&mut s, generation, 0, a, built).unwrap();
        assert!(std::sync::Arc::ptr_eq(&got, &new), "返回的必须是已经发布的那一份");
        assert_eq!(s.index_rev, 1, "被拒的一方⛔ 不许动版本号");
        assert!(std::sync::Arc::ptr_eq(s.index.as_ref().unwrap(), &new));
    }

    /// 票过期 **且** 手上没有新鲜缓存 ⇒ `stale`（让前端重发），⛔ 不发布旧结果。
    #[test]
    fn 旧票且无可用缓存返回_stale() {
        let t = TestDir::new("pub-stale-ticket");
        let root = t.dir("root");
        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let generation = s.grants.root_generation();

        let a = take_ticket(&mut s);
        let _b = take_ticket(&mut s); // 有更新的构建起步了，但还没发布
        let built = fake_index(&s);
        let err = publish_index(&mut s, generation, 0, a, built).expect_err("必须 stale");
        assert!(matches!(err, Denied::Stale { .. }), "{err:?}");
        assert!(s.index.is_none(), "⛔ 不许把落后的结果写进去");
        assert_eq!(s.index_rev, 0);
    }

    /// ⭐ 代次变了 ⇒ `stale`，**票号再对也不发布**（判据顺序固定）。
    #[test]
    fn 切根后旧构建晚回来一律作废() {
        let t = TestDir::new("pub-generation");
        let root = t.dir("root");
        let other = t.dir("other");
        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let generation = s.grants.root_generation();
        let ticket = take_ticket(&mut s);

        // 用户在构建途中换了根：代次 +1，旧索引作废、票号也涨（`invalidate_index`）
        s.grants.authorize_root(&other).unwrap();
        s.invalidate_index();
        let built = fake_index(&s); // 它属于**新**代次与**新** root

        let err = publish_index(&mut s, generation, 0, ticket, built).expect_err("代次不符必须 stale");
        assert!(matches!(err, Denied::Stale { .. }), "{err:?}");
        assert!(s.index.is_none(), "切根后 ⛔ 不许把任何索引写回去");
    }

    /// ⭐ A3（`design/0050` 最终约束 6）：遍历期间**内容修订**变了 ⇒ 这一份描述的是一个
    /// **已经过去**的时刻，且手上没有当纪元的缓存 ⇒ `stale_revision`。
    ///
    /// ⚠️ 必须是 `StaleRevision` 而**不是** `Stale`：前者让前端**保留旧视图 + 重试**，
    /// 后者会把它清掉重列（`INV-DISK-09` 末条）。两者的 `KIND_KEY` 也不同。
    #[test]
    fn 纪元前进后旧构建返回_stale_revision() {
        let t = TestDir::new("pub-epoch");
        let root = t.dir("root");
        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let generation = s.grants.root_generation();

        let epoch = s.disk.epoch;
        let ticket = take_ticket(&mut s);
        // 扫描在途中盘上变了（⚠️ 代次不动 ⇒ 只有纪元能挡住这份结果）
        bump_epoch(&mut s);
        assert_ne!(s.disk.epoch, epoch);
        assert_eq!(s.grants.root_generation(), generation, "前提：代次没变");

        let mut built = fake_index(&s);
        built.disk_epoch = epoch; // 它是**旧**纪元那一份
        let err = publish_index(&mut s, generation, epoch, ticket, built)
            .expect_err("纪元不符且无缓存必须 stale_revision");
        assert!(matches!(err, Denied::StaleRevision { .. }), "{err:?}");
        assert!(s.index.is_none(), "⛔ 不许把旧纪元的结果写进去");
        assert_eq!(s.index_rev, 0, "⛔ 被拒的一方不许动版本号");
    }

    /// ⭐ A3 的另一半：纪元不符、但手上**有当纪元的新鲜缓存** ⇒ 直接用它（⛔ 不白等一次重建）。
    #[test]
    fn 纪元前进后旧构建改用当纪元的缓存() {
        let t = TestDir::new("pub-epoch-cache");
        let root = t.dir("root");
        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let generation = s.grants.root_generation();

        let epoch_old = s.disk.epoch;
        let a = take_ticket(&mut s); // A 在旧纪元起步
        bump_epoch(&mut s);
        let b = take_ticket(&mut s); // B 在当纪元起步，并先发布
        let epoch_now = s.disk.epoch;
        let built_now = fake_index(&s);
        let published = publish_index(&mut s, generation, epoch_now, b, built_now).unwrap();
        assert_eq!(published.rev, 1);

        // A 晚完成：纪元不符 ⇒ 用 B 那一份，⛔ 不发布、⛔ 不动版本号
        let mut built = fake_index(&s);
        built.disk_epoch = epoch_old;
        let got = publish_index(&mut s, generation, epoch_old, a, built)
            .expect("当纪元有新鲜缓存 ⇒ 必须用它");
        assert!(std::sync::Arc::ptr_eq(&got, &published), "返回的必须是当纪元那一份");
        assert_eq!(s.index_rev, 1, "⛔ 被拒的一方不许动版本号");
        assert!(std::sync::Arc::ptr_eq(s.index.as_ref().unwrap(), &published));
    }

    /// ⭐ 无效化必须涨票（`design/0041` §2.1.2）：不涨票的话，"先领票 → 被作废 →
    /// 晚完成"这一串在同代次内会让旧结果**复活**。
    #[test]
    fn 无效化会让在途的票失效() {
        let t = TestDir::new("pub-invalidate");
        let root = t.dir("root");
        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let generation = s.grants.root_generation();

        let ticket = take_ticket(&mut s);
        s.invalidate_index(); // 关目录 / 换根那一类动作，代次不变
        assert_ne!(s.index_ticket, ticket, "无效化⛔ 不许只清缓存、不涨票");

        let built = fake_index(&s);
        let err = publish_index(&mut s, generation, 0, ticket, built)
            .expect_err("票已作废必须 stale");
        assert!(matches!(err, Denied::Stale { .. }), "{err:?}");
        assert!(s.index.is_none());
    }

    /// 票过期但**缓存对当刻代次新鲜** ⇒ 返回缓存（不白等一次重建），版本不动。
    #[test]
    fn 旧票有新鲜缓存时改用缓存() {
        let t = TestDir::new("pub-cache");
        let root = t.dir("root");
        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let generation = s.grants.root_generation();

        let a = take_ticket(&mut s);
        let b = take_ticket(&mut s);
        let built = fake_index(&s);
        let published = publish_index(&mut s, generation, 0, b, built).unwrap();
        assert_eq!(s.index_rev, 1);

        let built = fake_index(&s);
        let got = publish_index(&mut s, generation, 0, a, built).unwrap();
        assert!(std::sync::Arc::ptr_eq(&got, &published));
        assert_eq!(got.rev, 1);
        assert_eq!(s.index_rev, 1);
    }

    /// `obtain_index` 命中缓存时**不领票**（否则每次读列表都会让在途构建白跑）。
    #[test]
    fn 命中新鲜缓存不领票() {
        let t = TestDir::new("pub-hit");
        let root = t.dir("root");
        std::fs::write(root.join("a.md"), "x").unwrap();
        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let state = AppState::new(s);

        let first = obtain_index(&state, false).unwrap();
        let ticket_after_first = state.with(|s| s.index_ticket);
        let second = obtain_index(&state, false).unwrap();
        assert!(std::sync::Arc::ptr_eq(&first, &second), "第二次必须复用同一份");
        assert_eq!(state.with(|s| s.index_ticket), ticket_after_first, "缓存命中⛔ 不领票");
        assert_eq!(first.rev, 1);

        // ⭐ `design/0050` 最终约束 6 **改了 `rebuild` 的语义**：同一纪元最多建一次。
        //    ⇒ 纪元没变时 `rebuild = true` 也复用（⛔ 不重复扫盘）；真正"从盘上重来一次"
        //    现在是 `reconcile_disk`（它推内容修订），见 `design/0050` §10 的偏离记录。
        let third = obtain_index(&state, true).unwrap();
        assert!(
            std::sync::Arc::ptr_eq(&first, &third),
            "同一纪元下 `rebuild` 也必须复用"
        );
        assert_eq!(state.with(|s| s.index_ticket), ticket_after_first, "复用⛔ 不领票");
        assert_eq!(third.rev, 1);

        // 纪元被推高之后 `rebuild = true` 才真扫一遍 ⇒ 领新票、版本 +1
        state.with(|s| {
            s.disk.request(crate::disk::ReconcileCause::Signal(crate::disk::reaction(
                crate::disk::DiskSignal::Event,
            )))
        });
        let fourth = obtain_index(&state, true).unwrap();
        assert_eq!(fourth.rev, 2, "纪元变了 ⇒ 旧索引不再是当刻的盘");
        assert!(state.with(|s| s.index_ticket) > ticket_after_first, "重建必须领新票");
        let _ = s;
    }

    // ─────────────────────────────────────────────────────────────
    // ⭐ `design/0043` §2.4：`open_favorite`（`INV-FAV-03/05`）
    //    ⚠️ 与 `0038` 同形：先**原串逐字**命中记录，再 `canonicalize(请求侧)`，
    //    然后 `real == recorded`（记录侧⛔ 不再规范化）。
    // ─────────────────────────────────────────────────────────────

    /// 造一份"目录里放着一个 markdown"的会话，返回（会话、记录用的真实路径串）。
    fn fav_case(t: &TestDir, name: &str) -> String {
        std::fs::canonicalize(t.dir(name)).unwrap().display().to_string()
    }

    #[test]
    fn 收藏打开_未记录的字符串一律拒绝且状态不变() {
        let t = TestDir::new("open-fav-unrecorded");
        let dir = t.dir("notes");
        let mut s = session(t.p().join("config.json"));
        let before = freeze(&mut s);

        let err = open_favorite_recorded(&mut s, &dir.display().to_string())
            .expect_err("没收藏过的路径必须拒绝");
        assert!(matches!(err, Denied::NotAuthorized { .. }), "未记录是 NotAuthorized：{err:?}");
        assert_eq!(before, freeze(&mut s), "拒绝时状态一个字节不变");
        assert!(s.startup_document.is_none());
        assert!(!t.p().join("config.json").exists(), "拒绝不许写盘");
    }

    /// ⭐ 「原串逐字命中」的另一半：**相对路径**即使字面出现在收藏里也要拒。
    #[test]
    fn 收藏打开_相对路径拒绝() {
        let t = TestDir::new("open-fav-relative");
        let _dir = t.dir("notes");
        let mut s = session(t.p().join("config.json"));
        s.config.favorites = vec!["notes".to_string()];
        let before = freeze(&mut s);

        let err = open_favorite_recorded(&mut s, "notes").expect_err("相对路径不是收藏的形状");
        assert!(matches!(err, Denied::NotAuthorized { .. }), "相对路径是 NotAuthorized：{err:?}");
        assert_eq!(before, freeze(&mut s));
    }

    #[test]
    fn 收藏打开_目录走既有收尾_记进roots并落盘() {
        let t = TestDir::new("open-fav-dir");
        let real = fav_case(&t, "notes");
        let mut s = session(t.p().join("config.json"));
        s.config.favorites = vec![real.clone()];

        let snap = open_favorite_recorded(&mut s, &real).expect("收藏过的目录必须能开");
        assert_eq!(snap.mode, "directory");
        assert_eq!(snap.roots, vec![real.clone()], "复用 enter_directory 的记账");
        assert_eq!(s.grants.root_generation(), 1, "换根要 +1");
        assert_eq!(s.config.last_directory.as_deref(), Some(real.as_str()), "与 ⌘O 同一条收尾");
        assert_eq!(snap.favorites, vec![real.clone()], "快照要带回收藏表");
        assert!(t.p().join("config.json").exists(), "收尾要真的落盘");
    }

    #[test]
    fn 收藏打开_markdown文件只授权这一个文件且不外扩到父目录() {
        let t = TestDir::new("open-fav-file");
        let dir = t.dir("notes");
        let md = dir.join("a.md");
        std::fs::write(&md, "# x").unwrap();
        let recorded = std::fs::canonicalize(&md).unwrap().display().to_string();
        let mut s = session(t.p().join("config.json"));
        s.config.favorites = vec![recorded.clone()];

        let snap = open_favorite_recorded(&mut s, &recorded).expect("收藏过的 markdown 必须能开");
        assert_eq!(snap.mode, "single-file");
        assert_eq!(s.startup_document.as_deref(), Some(Path::new(&recorded)), "交给既有提交流程");
        assert_eq!(s.grants.files(), &[PathBuf::from(&recorded)], "只授权这一份文件");
        assert!(s.grants.roots().is_empty(), "⛔ 不许顺手把父目录加进 roots");
        assert_eq!(s.grants.root_generation(), 0, "文件授权不动树的代次");
    }

    #[test]
    fn 收藏打开_非markdown文件拒绝() {
        let t = TestDir::new("open-fav-txt");
        let dir = t.dir("notes");
        let txt = dir.join("a.txt");
        std::fs::write(&txt, "x").unwrap();
        let recorded = std::fs::canonicalize(&txt).unwrap().display().to_string();
        let mut s = session(t.p().join("config.json"));
        s.config.favorites = vec![recorded.clone()];
        let before = freeze(&mut s);

        let err = open_favorite_recorded(&mut s, &recorded).expect_err("非 markdown 不许开");
        assert!(matches!(err, Denied::NotAuthorized { .. }), "非 markdown 是 NotAuthorized：{err:?}");
        assert_eq!(before, freeze(&mut s), "拒绝时状态一个字节不变");
        assert!(s.startup_document.is_none());
    }

    #[test]
    fn 收藏打开_记录项已删除时not_found且状态不变() {
        let t = TestDir::new("open-fav-gone");
        let dir = t.dir("notes");
        let real = std::fs::canonicalize(&dir).unwrap().display().to_string();
        let mut s = session(t.p().join("config.json"));
        s.config.favorites = vec![real.clone()];
        let before = freeze(&mut s);
        std::fs::remove_dir_all(&dir).unwrap();

        let err = open_favorite_recorded(&mut s, &real).expect_err("没了要拒");
        assert!(matches!(err, Denied::NotFound { .. }), "没了是 NotFound：{err:?}");
        assert_eq!(before, freeze(&mut s));
        assert_eq!(s.config.favorites, vec![real.clone()], "⛔ 打开失败不许顺手删收藏");
    }

    /// ⭐⭐ 复评点名的确定性夹具：**A、B 都已收藏**，A 被换成指向 B 的软链。
    /// B 在收藏表里 ⇒ 若实现拿 `canonicalize(A)` 去比对**表里任意一条**，
    /// 就会把 A 这条路放行到 B 上；这里要求它仍按**A 自己的记录值**判 ⇒ 拒绝。
    #[test]
    fn 收藏打开_A与B都已收藏后A被换成指向B的软链仍须拒绝() {
        let t = TestDir::new("open-fav-ab");
        let dir = t.dir("notes");
        let a = dir.join("a.md");
        let b = dir.join("b.md");
        std::fs::write(&a, "# a").unwrap();
        std::fs::write(&b, "# b").unwrap();
        let rec_a = std::fs::canonicalize(&a).unwrap().display().to_string();
        let rec_b = std::fs::canonicalize(&b).unwrap().display().to_string();
        assert_ne!(rec_a, rec_b);

        let mut s = session(t.p().join("config.json"));
        s.config.favorites = vec![rec_a.clone(), rec_b.clone()];
        let before = freeze(&mut s);

        std::fs::remove_file(&a).unwrap();
        std::os::unix::fs::symlink(&b, &a).unwrap();

        let err = open_favorite_recorded(&mut s, &rec_a)
            .expect_err("A 已经不是记录的那个对象了 ⇒ 必须拒绝");
        assert!(
            matches!(err, Denied::NotAuthorized { .. }),
            "换过目标要 NotAuthorized（⛔ 不是 NotFound）：{err:?}"
        );
        assert_eq!(before, freeze(&mut s), "拒绝时状态一个字节不变");
        assert!(s.startup_document.is_none(), "⛔ 不许把 B 当成 A 打开");

        // 对照组：B 自己的记录仍然照常可开（拒绝的是 A 这条路，不是整表失效）
        let snap = open_favorite_recorded(&mut s, &rec_b).expect("B 自己的记录没受影响");
        assert_eq!(s.startup_document.as_deref(), Some(Path::new(&rec_b)));
        assert_eq!(snap.favorites.len(), 2, "收藏表原样");
    }

    /// 祖先目录被换成软链：原串仍命中记录，但 `canonicalize` 出去的 real 与原值不等。
    #[test]
    fn 收藏打开_祖先目录被换成软链时拒绝() {
        let t = TestDir::new("open-fav-ancestor");
        let dir = t.dir("notes");
        let outside = t.dir("outside");
        let recorded = std::fs::canonicalize(&dir).unwrap().display().to_string();
        let mut s = session(t.p().join("config.json"));
        s.config.favorites = vec![recorded.clone()];
        let before = freeze(&mut s);

        std::fs::rename(&dir, t.p().join("moved")).unwrap();
        std::os::unix::fs::symlink(&outside, &dir).unwrap();

        let err = open_favorite_recorded(&mut s, &recorded).expect_err("祖先换过就要拒");
        assert!(matches!(err, Denied::NotAuthorized { .. }), "{err:?}");
        assert_eq!(before, freeze(&mut s));
        assert!(!s.grants.roots().iter().any(|r| r == &outside), "⛔ 外部目录不许进 roots");
    }

    /// 同一路径换了**种类**：原收藏的是目录，现在那里是一个 markdown 文件 ⇒ 按当前种类分派，
    /// 只授权这一份文件（⛔ 不是按"当年收藏的是什么"分派）。
    #[test]
    fn 收藏打开_同路径换种类后按当前种类分派() {
        let t = TestDir::new("open-fav-kind");
        let dir = t.dir("entry.md");
        let recorded = std::fs::canonicalize(&dir).unwrap().display().to_string();
        let mut s = session(t.p().join("config.json"));
        s.config.favorites = vec![recorded.clone()];

        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::write(&dir, "# now a file").unwrap();

        let snap = open_favorite_recorded(&mut s, &recorded).expect("路径没变、种类变了照开");
        assert_eq!(snap.mode, "single-file");
        assert_eq!(s.grants.files(), &[PathBuf::from(&recorded)]);
        assert!(s.grants.roots().is_empty(), "⛔ 不许为它补一个父目录授权");
    }

    /// 同路径换成**非 markdown** 文件 ⇒ 拒绝（种类分派之后仍要过后缀闸）。
    #[test]
    fn 收藏打开_同路径换成非markdown文件时拒绝() {
        let t = TestDir::new("open-fav-kind-txt");
        let dir = t.dir("entry");
        let recorded = std::fs::canonicalize(&dir).unwrap().display().to_string();
        let mut s = session(t.p().join("config.json"));
        s.config.favorites = vec![recorded.clone()];

        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::write(&dir, "x").unwrap();

        let err = open_favorite_recorded(&mut s, &recorded).expect_err("不是目录也不是 markdown");
        assert!(matches!(err, Denied::NotAuthorized { .. }), "{err:?}");
        assert!(s.grants.files().is_empty());
    }

    // —— `design/0048`：文件树右键「在访达中显示」——

    /// 派发记录器：**一个字节都不真的交给 `open`**（与 `commands/link.rs` 同款手法）。
    struct Spawner {
        calls: Vec<Vec<String>>,
        fail: Option<String>,
    }

    impl Spawner {
        fn new() -> Self {
            Spawner { calls: Vec::new(), fail: None }
        }

        fn spawner(&mut self) -> impl FnMut(&[OsString]) -> std::io::Result<()> + '_ {
            move |argv| {
                self.calls
                    .push(argv.iter().map(|a| a.to_string_lossy().into_owned()).collect());
                match &self.fail {
                    Some(m) => Err(std::io::Error::other(m.clone())),
                    None => Ok(()),
                }
            }
        }
    }

    fn canonical_str(p: &Path) -> String {
        std::fs::canonicalize(p).unwrap().display().to_string()
    }

    /// 授权内的**文件** ⇒ `open -R <规范路径>`，且这是**只读**命令：
    /// 授权集合与代次一个字节不动（`INV-FS-04`）。
    #[test]
    fn 在访达中显示_授权内文件只派发一次且不动授权() {
        let t = TestDir::new("reveal-file");
        let root = t.dir("root");
        let f = root.join("a.md");
        std::fs::write(&f, "# a").unwrap();

        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let gen_before = s.grants.root_generation();
        let roots = s.grants.roots().to_vec();

        let mut sp = Spawner::new();
        let out = reveal_entry_in(&s, &f, &mut sp.spawner()).expect("授权内应当放行");

        assert!(!out.is_dir);
        assert_eq!(out.path, canonical_str(&f), "回给前端的是**规范路径**，⛔ 不是请求原样");
        assert_eq!(sp.calls.len(), 1, "只派发一次");
        assert_eq!(sp.calls[0][0], "/usr/bin/open");
        assert_eq!(sp.calls[0][1], "-R", "文件要的是「选中」，⛔ 不是「打开」");
        assert_eq!(sp.calls[0][2], canonical_str(&f), "路径是**一个独立元素**");

        assert_eq!(s.grants.roots().to_vec(), roots, "⛔ 读取命令不许新增可读路径");
        assert_eq!(s.grants.root_generation(), gen_before, "⛔ 也不许动代次");
    }

    /// 授权内的**目录** ⇒ `open <规范路径>`（不加 `-R`：要的是打开这个目录）。
    #[test]
    fn 在访达中显示_授权内目录直接打开() {
        let t = TestDir::new("reveal-dir");
        let root = t.dir("root");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();

        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();

        let mut sp = Spawner::new();
        let out = reveal_entry_in(&s, &sub, &mut sp.spawner()).expect("授权内应当放行");

        assert!(out.is_dir);
        assert_eq!(sp.calls.len(), 1);
        assert_eq!(sp.calls[0].len(), 2, "目录不加 -R");
        assert_eq!(sp.calls[0][0], "/usr/bin/open");
        assert_eq!(sp.calls[0][1], canonical_str(&sub));
    }

    /// 授权外 / 不存在的路径 ⇒ 拒绝，而且**一次都不派发**（失败无副作用）。
    #[test]
    fn 在访达中显示_未授权与不存在一律不派发() {
        let t = TestDir::new("reveal-denied");
        let root = t.dir("root");
        let outside = t.dir("outside");
        let inside = root.join("a.md");
        std::fs::write(&inside, "# a").unwrap();
        let doomed = outside.join("x.md");
        std::fs::write(&doomed, "# x").unwrap();

        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();

        let mut sp = Spawner::new();
        for p in [&doomed, &root.join("missing.md")] {
            let err = reveal_entry_in(&s, p, &mut sp.spawner())
                .expect_err("授权外 / 不存在都必须拒");
            assert!(
                matches!(err, Denied::NotAuthorized { .. } | Denied::NotFound { .. }),
                "{err:?}"
            );
        }
        assert!(sp.calls.is_empty(), "拒绝路径⛔ 不许派发任何东西");
    }

    /// 派发失败 ⇒ `Denied::Io`（⛔ 不吞掉、⛔ 不谎报成功）。
    #[test]
    fn 在访达中显示_派发失败如实报错() {
        let t = TestDir::new("reveal-io");
        let root = t.dir("root");
        let f = root.join("a.md");
        std::fs::write(&f, "# a").unwrap();

        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();

        let mut sp = Spawner { calls: Vec::new(), fail: Some("没有 Finder".to_string()) };
        let err = reveal_entry_in(&s, &f, &mut sp.spawner()).expect_err("派发失败必须报错");
        assert!(matches!(err, Denied::Io { .. }), "{err:?}");
        assert_eq!(sp.calls.len(), 1, "失败前那一次确实尝试过");
    }

    // ══════════════════════════════════════════════════════════════════════
    // ⭐ `design/0050` §7.3：**五组成本与收敛实测**
    //
    // ⛔ **不是日常闸门**：六条全部 `#[ignore]`，只在显式点名时跑（`make` 里没有它们）。
    //
    // 跑法：
    //   cd src-tauri && cargo test --release --features gui --offline \
    //       -- --ignored --nocapture 基准_
    //
    // ⚠️ 计时口径照 §7.3 逐字：
    //   · 去抖上限 1 s **从我们收到信号开始**（⛔ 不含内核投递延迟——那一侧我们量不到）；
    //   · **收敛延迟** = 最后一条**我们收到**的信号 → 索引提交（含扫描、排队），
    //     ⛔ **不含**前端绘制（那一段在本闸门之外，`probe-live-block` / 真窗口才有）；
    //   · 内存 = `ps -o rss=` 读本进程 RSS，量纪元切换前后的**峰值差**，⛔ 不用槽数替代。
    //
    // ⚠️ 这些是**本机夹具数字**：临时目录、本机 FSEvents ⇒ ⛔ 别当成某类真实项目的值。
    // ⚠️ 数字落 `benchmarks/results/disk-consistency-<日期>-<机型>.json`（⛔ 拒绝覆盖）。
    // ══════════════════════════════════════════════════════════════════════

    /// 百分位（样本已经就地排序）。
    fn pct(sorted: &[f64], p: f64) -> f64 {
        if sorted.is_empty() {
            return f64::NAN;
        }
        let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
        sorted[idx.min(sorted.len() - 1)]
    }

    /// 本进程 RSS（KiB）。⚠️ 只读查询，⛔ 不动任何系统状态。
    fn rss_kb() -> Option<u64> {
        let pid = std::process::id().to_string();
        let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &pid]).output().ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }

    fn bench_ent(name: &str, dir: &Path, is_dir: bool) -> TreeEntry {
        TreeEntry {
            name: name.to_string(),
            path: dir.join(name).display().to_string(),
            is_dir,
            ignored: false,
        }
    }

    /// 一层 `n` 条的假条目（⚠️ 名字带序号，长度贴近真实中文文件名）。
    fn bench_layer(n: usize, dir: &Path) -> Vec<TreeEntry> {
        (0..n).map(|i| bench_ent(&format!("文档-{i:06}.md"), dir, false)).collect()
    }

    /// ⭐ **第 1 组**：10k / 100k 条的层缓存 —— 一次纪元切换的 `sweep` 耗时 ＋ 会话锁持有 p50/p95。
    ///
    /// 判据口径（§7.3）：锁内只做 `take`，代价应与**同规模一次 `hit`** 同量级 ——
    /// ⇒ 这里同时量一次 `hit`（同样在锁内）当作对照。
    #[test]
    #[ignore = "design/0050 §7.3 第 1 组：10k/100k 层缓存的 sweep 与锁持有，耗时长，不在日常闸门里"]
    fn 基准_层缓存_纪元切换的sweep与锁持有() {
        const ROUNDS: usize = 7;
        let t = TestDir::new("bench-sweep");
        let a = t.dir("a");
        let b = t.dir("b");

        for n in [10_000usize, 100_000] {
            let mut sweep_us = Vec::new();
            let mut hold_us = Vec::new();
            let mut hit_us = Vec::new();
            let mut slots_after = 0usize;
            let rss_before = rss_kb();

            let mut s = session(t.p().join("config.json"));
            let mut peak = rss_before;
            for round in 0..ROUNDS {
                // 每轮都重新铺两档（⚠️ 用户手上的量级是"两代共存"：旧纪元 ＋ 当纪元）
                s.tree.seed(1, 0, &a, bench_layer(n, &a));
                s.tree.seed(1, 0, &b, bench_layer(n, &b));
                if round == 0 {
                    peak = rss_kb();
                }
                let lock = std::sync::Mutex::new(s);

                // ① `sweep` 本体（锁内，与生产同形：`state.with(|s| s.tree.sweep(..))`）
                let t0 = std::time::Instant::now();
                let swept = lock.lock().unwrap().tree.sweep(1, 1);
                sweep_us.push(t0.elapsed().as_secs_f64() * 1e6);
                slots_after = swept.len();
                // ⚠️ 释放必须在**锁外**（最终约束 7）：这里刻意先放锁再 drop
                drop(swept);

                // ② 同规模的 `hit`（对照：§7.3 说锁内代价应与它同量级）
                let t1 = std::time::Instant::now();
                let _hit = lock.lock().unwrap().tree.hit(1, 1, &a);
                hit_us.push(t1.elapsed().as_secs_f64() * 1e6);

                // ③ 锁持有（lock → sweep → 取回 swept → 放锁）
                let t2 = std::time::Instant::now();
                {
                    let g = lock.lock().unwrap();
                    let _ = g.tree.sweep(1, 2);
                }
                hold_us.push(t2.elapsed().as_secs_f64() * 1e6);

                s = lock.into_inner().unwrap();
                // 每轮收尾把两档重新铺回去（下一轮开头会再铺，这里只为让 RSS 不掉得太抖）
            }
            let rss_after = rss_kb();
            peak = peak.max(rss_after);
            sweep_us.sort_by(|x, y| x.partial_cmp(y).unwrap());
            hit_us.sort_by(|x, y| x.partial_cmp(y).unwrap());
            hold_us.sort_by(|x, y| x.partial_cmp(y).unwrap());
            println!(
                "BENCH {}",
                serde_json::json!({
                    "组": "层缓存·纪元切换",
                    "条目数": n * 2,
                    "轮数": ROUNDS,
                    "sweep_p50_us": pct(&sweep_us, 0.5).round(),
                    "sweep_p95_us": pct(&sweep_us, 0.95).round(),
                    "锁持有_p50_us": pct(&hold_us, 0.5).round(),
                    "锁持有_p95_us": pct(&hold_us, 0.95).round(),
                    "对照hit_p50_us": pct(&hit_us, 0.5).round(),
                    "对照hit_p95_us": pct(&hit_us, 0.95).round(),
                    "sweep后摘下的层数": slots_after,
                    "rss_before_kb": rss_before,
                    "rss_peak_kb": peak,
                    "rss_delta_kb": peak.zip(rss_before).map(|(a, b)| a.saturating_sub(b)),
                })
            );
        }
    }

    /// 百分位；样本为空 ⇒ `None`（⚠️ 空样本写成 `0 ms` 会被读成"很快"）。
    fn pct_opt(sorted: &[f64], p: f64) -> Option<f64> {
        if sorted.is_empty() {
            None
        } else {
            Some((pct(sorted, p) * 10.0).round() / 10.0)
        }
    }

    /// ⭐ **第 2 组**：连续保存（每 100 ms 写一次文件，30 s）。
    ///
    /// §7.3 的判据：**纪元净增 == 批次数**，且**扫描次数不随原始事件数线性涨**。
    /// ⚠️ 这里的"扫描"是**真扫**（`tree::build_index` 跑在去抖回调里），不是数数。
    ///
    /// ⚠️ 两条通道分工照生产：`on_signal` **只在内存里**记一个时刻（⛔ 不读盘），
    /// `on_emit` 才是"安静下来之后"的那一次扫描。收敛口径因此是
    /// **最后一条我们收到的信号 → 索引构建完成**（⛔ 不含内核投递、⛔ 不含前端绘制）。
    #[test]
    #[ignore = "design/0050 §7.3 第 2 组：连续保存 30 s，⛔ 不在日常闸门里"]
    fn 基准_连续保存_批次数与扫描次数() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};

        const WRITES: usize = 300;
        const INTERVAL_MS: u64 = 100;

        let t = TestDir::new("bench-saves");
        let root = t.dir("root");
        let f = root.join("doc.md");
        std::fs::write(&f, "# 基线\n").unwrap();

        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let grants = s.grants.clone();
        let ignore = s.config.ignore_dirs.clone();

        let signals = Arc::new(AtomicUsize::new(0));
        let batches = Arc::new(AtomicUsize::new(0));
        let scans = Arc::new(AtomicUsize::new(0));
        let last_sig = Arc::new(Mutex::new(None::<std::time::Instant>));
        let last_done = Arc::new(Mutex::new(None::<std::time::Instant>));

        let sg = Arc::clone(&signals);
        let ls = Arc::clone(&last_sig);
        let b2 = Arc::clone(&batches);
        let sc = Arc::clone(&scans);
        let ld = Arc::clone(&last_done);
        let w = crate::external::watch::watch_dir_signals(
            &root,
            move |_sig| {
                // ⚠️ 生产不变式的镜像：信号通道**只做内存操作**（⛔ 不读盘、⛔ 不发 IPC）
                sg.fetch_add(1, Ordering::SeqCst);
                *ls.lock().unwrap() = Some(std::time::Instant::now());
            },
            move |_r| {
                b2.fetch_add(1, Ordering::SeqCst);
                // ⚠️ 真扫一遍（这才是"扫描次数"；⛔ 不数数糊弄）
                let _ = tree::build_index(&grants, &ignore, 0);
                sc.fetch_add(1, Ordering::SeqCst);
                *ld.lock().unwrap() = Some(std::time::Instant::now());
            },
        )
        .expect("建立目录监视");

        let t_start = std::time::Instant::now();
        for i in 0..WRITES {
            std::fs::write(&f, format!("# 第 {i} 次保存\n")).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(INTERVAL_MS));
        }
        let last_write = std::time::Instant::now();
        // 等收敛（静默窗口 300 ms ＋ 一次扫描，给 3 s 余量）
        std::thread::sleep(std::time::Duration::from_millis(3000));
        drop(w);

        let n_signals = signals.load(Ordering::SeqCst);
        let n_batches = batches.load(Ordering::SeqCst);
        let n_scans = scans.load(Ordering::SeqCst);
        let wait = last_done
            .lock()
            .unwrap()
            .zip(*last_sig.lock().unwrap())
            .map(|(d, s0)| d.duration_since(s0).as_secs_f64() * 1000.0);
        println!(
            "BENCH {}",
            serde_json::json!({
                "组": "连续保存",
                "原始写入": WRITES,
                "间隔_ms": INTERVAL_MS,
                "耗时_ms": (last_write - t_start).as_millis(),
                "原始信号数": n_signals,
                "批次数": n_batches,
                "扫描次数": n_scans,
                "纪元净增": n_batches, // 收到即失效：每个去抖批次推一格（与生产同一处 `reaction`）
                "最后一批收敛_ms": wait.map(|v| (v * 10.0).round() / 10.0),
                "⚠️": "收敛 = 最后一条我们收到的信号 → 索引构建完成；⛔ 不含内核投递与前端绘制",
            })
        );
        assert!(n_signals > 0, "整轮一条原始信号都没有 ⇒ 真 watcher 没接到事件");
        assert!(n_batches > 0, "整轮一条通知都没发 ⇒ 去抖线程没跑");
        assert!(
            n_batches * 4 < n_signals.max(WRITES),
            "批次 {n_batches} 相对原始信号 {n_signals} 没有压缩 ⇒ 去抖失效"
        );
        assert_eq!(n_scans, n_batches, "每个批次恰好一次扫描（⛔ 不是每个原始事件一次）");
    }

    /// ⭐ **第 3 组**：批量增删（1000 个文件一次建 / 一次删）。
    ///
    /// 量**收敛延迟** p50/p95：最后一条我们收到的信号 → 索引提交。
    #[test]
    #[ignore = "design/0050 §7.3 第 3 组：1000 文件批量增删，⛔ 不在日常闸门里"]
    fn 基准_批量增删_收敛延迟() {
        use std::sync::{Arc, Mutex};

        const N: usize = 1000;
        const ROUNDS: usize = 5;

        let t = TestDir::new("bench-bulk");
        let root = t.dir("root");

        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let grants = s.grants.clone();
        let ignore = s.config.ignore_dirs.clone();

        // (最后一条原始信号, 该批构建完成, 条目数)
        let log: Arc<Mutex<Vec<(Option<std::time::Instant>, std::time::Instant, usize)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let last_sig: Arc<Mutex<Option<std::time::Instant>>> = Arc::new(Mutex::new(None));
        let ls = Arc::clone(&last_sig);
        let lg = Arc::clone(&log);
        let w = crate::external::watch::watch_dir_signals(
            &root,
            move |_sig| {
                *ls.lock().unwrap() = Some(std::time::Instant::now());
            },
            move |_r| {
                let built = tree::build_index(&grants, &ignore, 0);
                let done = std::time::Instant::now();
                let sig = *last_sig.lock().unwrap();
                let len = built.map(|ix| ix.len()).unwrap_or(0);
                lg.lock().unwrap().push((sig, done, len));
            },
        )
        .expect("建立目录监视");

        let mut lats: Vec<(String, f64)> = Vec::new();
        for round in 0..ROUNDS {
            for tag in ["增", "删"] {
                for i in 0..N {
                    let p = root.join(format!("r{round}-{i:04}.md"));
                    if tag == "增" {
                        std::fs::write(&p, b"# x\n").unwrap();
                    } else if p.exists() {
                        std::fs::remove_file(&p).unwrap();
                    }
                }
                // 等这一批收敛（静默 300 ms ＋ 扫描 ＋ 余量）
                std::thread::sleep(std::time::Duration::from_millis(2000));
                let known = log.lock().unwrap().len();
                let snap = log.lock().unwrap().clone();
                if let Some((Some(sig), done, _len)) = snap.iter().take(known).last() {
                    lats.push((tag.to_string(), done.duration_since(*sig).as_secs_f64() * 1000.0));
                }
            }
        }
        drop(w);
        std::thread::sleep(std::time::Duration::from_millis(300));

        let all = log.lock().unwrap().clone();
        let mut ms: Vec<f64> = lats.iter().map(|(_, v)| *v).collect();
        ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "BENCH {}",
            serde_json::json!({
                "组": "批量增删",
                "每批文件数": N,
                "轮数": ROUNDS,
                "样本": lats.iter().map(|(t, v)| serde_json::json!({"动作": t, "收敛_ms": (v * 10.0).round() / 10.0})).collect::<Vec<_>>(),
                "收敛_p50_ms": pct_opt(&ms, 0.5),
                "收敛_p95_ms": pct_opt(&ms, 0.95),
                "批次数": all.len(),
                "条目数区间": [all.iter().map(|x| x.2).min().unwrap_or(0), all.iter().map(|x| x.2).max().unwrap_or(0)],
                "⚠️": "收敛 = 最后一条原始信号 → 该批索引构建完成；⛔ 不含内核投递与前端绘制",
            })
        );
        assert!(!all.is_empty(), "整轮没有批次 ⇒ 真 watcher 没接到事件");
        assert!(all.iter().any(|x| x.2 >= N), "从未见到 {N} 条的规模 ⇒ 扫描没真跑");
        assert_eq!(lats.len(), ROUNDS * 2, "每一批都要有自己的收敛样本");
    }

    /// ⭐ **第 4 组**：`git checkout` 换分支（**真 git**，本地临时仓库）。
    #[test]
    #[ignore = "design/0050 §7.3 第 4 组：git checkout 换分支，⛔ 不在日常闸门里"]
    fn 基准_git_checkout_收敛与内存() {
        use std::sync::{Arc, Mutex};

        let git = |dir: &Path, args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_AUTHOR_NAME", "bench")
                .env("GIT_AUTHOR_EMAIL", "bench@example.invalid")
                .env("GIT_COMMITTER_NAME", "bench")
                .env("GIT_COMMITTER_EMAIL", "bench@example.invalid")
                .output()
        };
        let ok = git(Path::new("."), &["--version"]).map(|o| o.status.success()).unwrap_or(false);
        if !ok {
            println!("BENCH {}", serde_json::json!({"组": "git checkout", "跳过": "本机没有 git"}));
            return;
        }

        let t = TestDir::new("bench-git");
        let root = t.dir("repo");
        assert!(git(&root, &["init", "-q"]).unwrap().status.success());
        // A 分支：200 个 .md
        for i in 0..200 {
            std::fs::write(root.join(format!("a{i:03}.md")), b"# A\n").unwrap();
        }
        assert!(git(&root, &["add", "-A"]).unwrap().status.success());
        assert!(git(&root, &["commit", "-q", "-m", "A"]).unwrap().status.success());

        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let grants = s.grants.clone();
        let ignore = s.config.ignore_dirs.clone();

        let log: Arc<Mutex<Vec<(Option<std::time::Instant>, std::time::Instant, usize)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let last_sig: Arc<Mutex<Option<std::time::Instant>>> = Arc::new(Mutex::new(None));
        let ls = Arc::clone(&last_sig);
        let lg = Arc::clone(&log);
        let w = crate::external::watch::watch_dir_signals(
            &root,
            move |_sig| {
                *ls.lock().unwrap() = Some(std::time::Instant::now());
            },
            move |_r| {
                let built = tree::build_index(&grants, &ignore, 0);
                let done = std::time::Instant::now();
                let sig = *last_sig.lock().unwrap();
                lg.lock().unwrap().push((sig, done, built.map(|ix| ix.len()).unwrap_or(0)));
            },
        )
        .expect("建立目录监视");

        // 造第二条分支：删 200 个、加 300 个（文件集合大幅不同）
        // ⚠️ 基分支名**问 git 要**：`init.defaultBranch` 因机器而异，⛔ 别硬写 main/master
        let base_branch = String::from_utf8_lossy(
            &git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().stdout,
        )
        .trim()
        .to_string();
        assert!(git(&root, &["checkout", "-q", "-b", "other"]).unwrap().status.success());
        for i in 0..200 {
            std::fs::remove_file(root.join(format!("a{i:03}.md"))).unwrap();
        }
        for i in 0..300 {
            std::fs::write(root.join(format!("b{i:03}.md")), b"# B\n").unwrap();
        }
        assert!(git(&root, &["add", "-A"]).unwrap().status.success());
        assert!(git(&root, &["commit", "-q", "-m", "B"]).unwrap().status.success());
        assert!(git(&root, &["checkout", "-q", &base_branch]).unwrap().status.success());
        std::thread::sleep(std::time::Duration::from_millis(3000));

        let rss_before = rss_kb();
        let known = log.lock().unwrap().len();
        let t0 = std::time::Instant::now();
        let out = git(&root, &["checkout", "-q", "other"]).unwrap();
        assert!(out.status.success(), "切分支失败：{}", String::from_utf8_lossy(&out.stderr));
        let checkout_done = std::time::Instant::now();
        std::thread::sleep(std::time::Duration::from_millis(4000));
        let rss_after = rss_kb();
        drop(w);

        let all = log.lock().unwrap().clone();
        assert!(
            all.iter().skip(known).any(|(at, _, _)| at.is_some()),
            "checkout 之后没有任何批次 ⇒ 真 watcher 没接到事件"
        );
        let last = all.iter().skip(known).last();
        let conv = last
            .and_then(|(sig, done, _)| sig.map(|s0| done.duration_since(s0).as_secs_f64() * 1000.0));
        println!(
            "BENCH {}",
            serde_json::json!({
                "组": "git checkout",
                "仓库文件数": [200, 300],
                "git_checkout_ms": checkout_done.duration_since(t0).as_secs_f64() * 1000.0,
                "收敛_ms": conv.map(|v| (v * 10.0).round() / 10.0),
                "本轮批次数": all.len() - known,
                "每批条目数": all.iter().skip(known).map(|x| x.2).collect::<Vec<_>>(),
                "rss_before_kb": rss_before,
                "rss_after_kb": rss_after,
                "rss_delta_kb": rss_after.zip(rss_before).map(|(a, b)| a.saturating_sub(b)),
                "⚠️": "收敛 = 最后一条原始信号 → 该批索引完成；⛔ 不含内核投递与前端绘制",
            })
        );
    }

    /// ⭐ **第 5 组**：隐藏 → 可见。
    ///
    /// 判据（§7.3）：**隐藏期间零扫描**；展开时**一次 `read_dir`**。
    /// ⚠️ "隐藏"在这个仓库里就是"这一层不在屏幕上"（树是单层懒加载，`INV-TREE-01`）——
    /// 判据因此是 `TreeCache::hit` 的 `Some`/`None`：命中 ⇒ 一个字节的盘都没读。
    /// ⭐ 另按 §2.2.2 显式量那条**已知代价**：保存一个 md 之后，展开一个**已缓存**的目录
    /// ⇒ 多一次 `read_dir`（⛔ 不许写成"零开销"）。
    #[test]
    #[ignore = "design/0050 §7.3 第 5 组：隐藏→可见的零扫描与单次 read_dir，⛔ 不在日常闸门里"]
    fn 基准_隐藏到可见_零扫描与单次read_dir() {
        const N: usize = 10_000;
        let t = TestDir::new("bench-hidden");
        let root = t.dir("root");
        for i in 0..N {
            std::fs::write(root.join(format!("d{i:05}.md")), b"# x\n").unwrap();
        }
        let mut s = session(t.p().join("config.json"));
        s.grants.authorize_root(&root).unwrap();
        let g0 = s.grants.root_generation();
        let epoch0 = s.disk.epoch;

        // ① 先真正展开一次（冷）：这一次本来就要读盘
        let t0 = std::time::Instant::now();
        let cold = tree::list_dir(&s.grants, &root, g0, epoch0, 1, &s.config.ignore_dirs).unwrap();
        let cold_ms = t0.elapsed().as_secs_f64() * 1000.0;
        // 把它按生产的形状提交进缓存
        let stamp = s.tree.begin(g0, epoch0, &root);
        assert!(s.tree.commit(g0, epoch0, &root, stamp, cold.entries.clone()));

        // ② 隐藏期间（用户切到别的标签、这一层不在屏幕上）：反复"再看一眼"必须零扫描
        let t1 = std::time::Instant::now();
        let mut hits = 0;
        for _ in 0..1000 {
            if s.tree.hit(g0, epoch0, &root).is_some() {
                hits += 1;
            }
        }
        let hidden_us = t1.elapsed().as_secs_f64() * 1e6 / 1000.0; // 每次访问的平均 µs
        let hidden_scans = 1000 - hits;

        // ③ 保存一个文件 ⇒ 内容修订前进 ⇒ 旧层作废（`sweep` 只留当纪元）
        s.disk.request(crate::disk::ReconcileCause::Signal(crate::disk::reaction(
            crate::disk::DiskSignal::Event,
        )));
        let epoch1 = s.disk.epoch;
        drop(s.tree.sweep(g0, epoch1));
        let after_hit = s.tree.hit(g0, epoch1, &root).is_some();

        // ④ 再展开：一次 `read_dir`（这就是 §2.2.2 明写的那条已知代价）
        let t2 = std::time::Instant::now();
        let warm = tree::list_dir(&s.grants, &root, g0, epoch1, 2, &s.config.ignore_dirs).unwrap();
        let warm_ms = t2.elapsed().as_secs_f64() * 1000.0;

        println!(
            "BENCH {}",
            serde_json::json!({
                "组": "隐藏→可见",
                "一层条目数": N,
                "隐藏期间访问次数": 1000,
                "隐藏期间命中": hits,
                "隐藏期间扫描": hidden_scans,
                "隐藏期间单次耗时_us": hidden_us.round(),
                "保存后旧层仍命中": after_hit,
                "冷展开_ms": (cold_ms * 10.0).round() / 10.0,
                "保存后再展开_ms": (warm_ms * 10.0).round() / 10.0,
                "两次条目数": [cold.entries.len(), warm.entries.len()],
                "⚠️": "隐藏 = 这一层不在屏幕上；判据是 hit 命中（⇒ 一个字节的盘都没读）",
            })
        );
        assert_eq!(hidden_scans, 0, "隐藏期间一次盘都不许读");
        assert!(!after_hit, "内容修订前进后旧层必须查不到（否则读到的是过去的盘）");
        assert_eq!(cold.entries.len(), N);
    }
}
