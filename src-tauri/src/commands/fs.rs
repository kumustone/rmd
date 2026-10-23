//! 文件树相关的命令（`design/0003` §3 的 `commands/fs.rs`）。
//!
//! 这个文件里**授权命令与读取命令混在一起**，所以每条命令的头一行注释
//! 必须写清它是哪一类（见 [`super`] 模块头的表）。

use std::path::{Path, PathBuf};

use tauri_plugin_dialog::DialogExt;

use crate::commands::{snapshot, AppState, Mode, SessionSnapshot};
use crate::error::Denied;
use crate::fs::grants::SessionGrants;
use crate::fs::tree::{self, ListDirResult, SearchResult};

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

    state.with(|s| {
        // ① 先授权（唯一的写入点），失败就直接返回，⛔ 不动任何界面状态
        let real = s.grants.authorize_root(&dir)?;
        // ⚠️ 这里**不设** mode：`Session::mode()` 是从 `roots` 推导的
        //    （授权成功 ⇒ 它自然变成 `Directory`），⛔ 不存第二个真值。
        // ② 旧代的树缓存没有意义了（键里的代次已经变）
        s.tree.retain_gen(s.grants.root_generation());
        // ⚠️ 只把**路径**记进配置，⛔ 不把授权记进去（INV-FS-03）
        s.config.set_last_directory(&real);
        if let Err(e) = s.config.save(&s.config_path) {
            diag_stderr!("⚠️ last_directory 存不下来：{e}");
            diag_file!("⚠️ last_directory 存不下来 err_class={} err_len={}", crate::logging::err_class(&e), e.to_string().len());
        }
        diag!("▶ 授权目录 {}（代次 → {}）", real.display(), s.grants.root_generation());
        Ok(snapshot(s))
    })
    .inspect(|_| {
        // ⭐ 换根 ⇒ 旧的目录监视作废、新的盯着新根（`design/0034` §2.1 A 的生命周期）。
        // ⚠️ 放在 `with` **之外**：摘旧监视会起线程停 notify/去抖，
        //    ⛔ 不把这件事放进会话锁的临界区（`kb/0020`）。
        restart_tree_watch(&app, &state);
    })
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

    // ② 取当前**唯一**的授权根与代次（侧边栏只有一棵树，§2.1.4 的理由 1）
    let (root, generation) = state.with(|s| {
        (s.grants.roots().first().cloned(), s.grants.root_generation())
    });
    let Some(root) = root else {
        diag!("▶ 目录监视：没有授权根 ⇒ 不监视（手动刷新仍可用）");
        return;
    };

    match crate::external::watch::start_tree_watch(app, &root, generation) {
        Ok(w) => {
            // ⚠️ 建立期间代次可能又变了（并发换根）⇒ 这份监视盯着一个**已经不授权**的根。
            //    代次核对放在存进去的那一刻，⛔ 不假设"上面两次 `with` 之间什么都没发生"。
            let mut slot = Some(w);
            let stored = state.with(|s| {
                if s.grants.root_generation() == generation {
                    s.tree_watch = slot.take();
                    true
                } else {
                    false
                }
            });
            if stored {
                diag!("▶ 目录监视已建立：{}（代次 {generation}）", root.display());
            } else {
                diag!("⚠️ 目录监视：建立期间代次变了 ⇒ 丢弃这份（换根的那次会自己重建）");
            }
        }
        Err(e) => {
            // ⚠️ **响亮但不致命**：静默失败的表现是"树再也不自动刷新"，
            //    与"目录里什么都没发生"在界面上完全一样。
            diag_stderr!("⚠️ 目录监视没建起来（{e}）⇒ 自动刷新不可用，手动刷新仍可用");
            diag_file!(
                "⚠️ 目录监视没建起来 label={} err_len={}",
                e.label(),
                e.to_string().len()
            );
        }
    }
}

/// **读取命令** · 列出一层。
///
/// ⛔ 它**不改授权**。授权校验与代次检查都在 [`tree::list_dir`] 里。
#[tauri::command]
pub fn list_dir(
    state: tauri::State<'_, AppState>,
    path: String,
    generation: u64,
    req: u64,
    fresh: bool,
) -> Result<ListDirResult, Denied> {
    let mut cached = None;
    // ⭐ 树缓存现在有多少层（诊断用）。⚠️ 它**是** `fresh` 那条路的判据：
    //    作废之后重列，层数应当**不涨**——涨了说明作废没生效，
    //    而那正是"搜索看到了新文件、树里却定位不到"的根因（§2.1 ⑤）。
    let mut cache_layers = 0usize;
    let result = state.with(|s| {
        match s.grants.check_readable(Path::new(&path)) {
            // ⚠️ 缓存键是 `(root_generation, path)`，且用**规范化后**的路径
            //    （§2.1.3：裸 path 会在切根回到同一目录时命中上一代的结果）
            Ok(real) => {
                cache_layers = s.tree.len();
                if fresh {
                    // ⭐ `design/0009` §2.1 ⑤：搜索浮层回车后定位不到那份文件时，
                    //    **先作废这一层的缓存再重列**——否则重列只会命中同一份陈旧结果
                    //    （索引刚重建过，而这一层是更早缓存的：新建的文件不在里面）。
                    s.tree.invalidate(generation, &real);
                } else if let Some(hit) = s.tree.get(generation, &real) {
                    cached = Some(hit.clone());
                    return Ok(ListDirResult {
                        path: real.display().to_string(),
                        generation,
                        req,
                        entries: hit,
                        stats: tree::ScanStats::default(),
                    });
                }
                match tree::list_dir(&s.grants, &real, generation, req) {
                    Ok(r) => {
                        s.tree.put(r.generation, Path::new(&r.path), r.entries.clone());
                        Ok(r)
                    }
                    Err(e) => Err(e),
                }
            }
            Err(e) => Err(e),
        }
    });

    if let Ok(r) = &result {
        // ⭐ §7 步骤 5 的**日志判据**：把"这一层读到了多少项"摆出来。
        //    ① / ② 类若真被扫描了，`scanned` 会明显大于可见项数。
        diag!(
            "▶ list_dir {}（代次 {}{}，缓存 {} 层）：读到 {} 项 → 目录/文件 {} 项｜隐藏(①) {}｜灰显(②) {}｜软链 {}｜其它 {}｜{:.2} ms",
            r.path,
            r.generation,
            if cached.is_some() { "·缓存" } else { "" },
            cache_layers,
            r.stats.scanned,
            r.entries.len(),
            r.stats.skipped_dot,
            r.stats.ignored,
            r.stats.skipped_symlink,
            r.stats.skipped_other,
            r.stats.scan_ms
        );
    } else if let Err(e) = &result {
        diag_stderr!("▶ list_dir {path} 被拒：{}（{}）", e.label(), e);
        diag_file!("▶ list_dir {path} 被拒 label={} err_len={}", e.label(), e.to_string().len());
    }
    result
}

/// **读取命令** · 文件名模糊搜索（`design/0009` §2.1，2026-10-14 已通过）。
///
/// ⭐ **它只读**：⛔ 不新增任何可读路径、⛔ 不改变授权、⛔ 不收 root 参数
/// （「让前端指定扫哪里」就是一个绕过 `INV-FS-04` 的口子）。
/// 遍历用的 grants 是**后端自己持有的那一份**。
///
/// # 三段式锁（§2.1 ②.2）——⛔ 不把全树遍历放在会话锁里
///
/// `AppState::with` 拿的是 `Mutex<Session>`，而 `open_document` 在**同一把锁**里读盘 + 渲染，
/// `notify` 的回调**在别的线程**上取它（`commands/mod.rs` 的 `with` 注释）。
/// 遍历持锁 9 ms（冷盘可能几十上百毫秒）的代价是"用户此刻要打开的文档被它挡住"。
/// ⇒ 顺序是：**① 持锁取 root 快照 + 代次 → ② 放锁遍历 → ③ 重新持锁、代次未变才发布**。
///
/// ⚠️ 代次在遍历期间变了（用户切了目录）⇒ **丢弃这份索引**并返回 `stale`，
/// 由前端拿新代次重发一次。⛔ 不静默发布一份已经过期的清单。
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
    state: tauri::State<'_, AppState>,
    pattern: String,
    req: u64,
    rebuild: bool,
) -> Result<SearchResult, Denied> {
    // ① 持锁：取一份 grants 快照 + 当刻代次 +（可能还能用的）旧索引。
    //    ⚠️ `grants.clone()` 出来的那份**仍然会**逐层过 `check_readable`
    //    （`design/0009` §2.1 ②.2 的"缓存键要同时核当刻授权"）。
    let (grants, generation, cached) = state.with(|s| {
        (
            s.grants.clone(),
            s.grants.root_generation(),
            if rebuild { None } else { s.index.clone() },
        )
    });
    // ⚠️ 锁在这里就**放掉了**——下面整趟遍历都在锁外跑

    let index = match cached {
        Some(ix) if ix.is_fresh(generation, grants.roots()) => ix,
        _ => {
            let built = tree::build_index(&grants)?;
            let ix = std::sync::Arc::new(built);
            // ③ 再持锁：**代次未变才发布**（变了就丢掉这份，⛔ 不留作下一次的"缓存"）
            let now = state.with(|s| {
                if s.grants.root_generation() == generation {
                    s.index = Some(ix.clone());
                    None
                } else {
                    Some(s.grants.root_generation())
                }
            });
            if let Some(now) = now {
                diag_stderr!(
                    "▶ search_files {pattern:?}：遍历期间代次变了（{generation} → {now}），丢弃这份索引"
                );
                diag_file!(
                    "▶ search_files：遍历期间代次变了（{generation} → {now}），丢弃这份索引 pattern_len={}",
                    pattern.len()
                );
                return Err(Denied::stale(generation, now));
            }
            ix
        }
    };

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
        let real_parent = s.grants.check_creatable(Path::new(&parent))?;
        let final_name = crate::fs::create::validate_name(&name, kind)?;
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
        let real = s.grants.check_renamable(requested)?;
        // ⭐ 两道状态拦截（编辑态 / 保存在途）**必须在碰磁盘之前**
        s.rename_guard(&real)?;

        // ⚠️ 旧名字取**请求**的最后一段（`check_renamable` 的第 6 步也是这个口径）
        let old_name = requested
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| Denied::not_found(requested))?;
        let final_name =
            crate::fs::create::validate_name(&name, crate::fs::create::CreateKind::File)?;
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
