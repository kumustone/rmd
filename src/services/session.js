// 会话状态 + ⭐ **三个提交点**（`design/0003` §2.1.3）。
//
// # 这个文件是 R5（乱序响应 / 陈旧分片）的实现落点
//
// 「提交」= **真正改变界面状态的那一刻**。本项目里只有三处，全部在这里：
//
// | # | 提交动作 | 判据 |
// |---|---|---|
// | 1 | 挂正文 / 更新当前项高亮 / 重置滚动 | `gen` 相等 **且** `req` 是最新发出的那个 |
// | 2 | 往树里追加一批分片节点 | `gen` 相等（不等 → 丢掉本批**及剩余全部**，并**移除已追加的**） |
// | 3 | 展开某层、把 `list_dir` 结果写进树 | 同 ② |
//
// ⛔ **每次提交前检查，不是"发请求前检查一次"**。请求发出后世界会变——
// 这是这类 bug 的全部成因（`design/0003` §2.1.3 规则 1）。
//
// # 授权
//
// 本模块**没有**任何"新增可读路径"的能力。`openDocument` 只是把路径**递过去**，
// 能不能读由后端的 `check_readable` 说了算（`INV-FS-04`：
// ⛔ 读取命令永不提权，⛔ 不接受前端传来的"来源"标志）。

// ⚠️⚠️ **每个文件都包一层 IIFE**——这**不是**风格问题，是必须的。
//
// 经典脚本（⛔ 不是 ES module）的顶层 `const` **共用一个全局词法作用域**：
// 两个文件都写 `const api = …`（或 `const V` / `const S` / `const T`）时，
// 后加载的那个文件**整个不执行**（解析期 `SyntaxError`），
// 而错误只出现在 WebView 的控制台里——本项目看不到它。
//
// 表现：**一个永远开着的空白窗口**，stderr 里连一条错误都没有。
// 2026-10-13 实施 `design/0003` 时真踩到了：7 个模块几乎全被
// `const V` / `const api` 撞掉，冒烟挂在那里一动不动。
//
// ⇒ 双导出（浏览器挂 `window.rmd.*` / node 挂 `module.exports`）**必须在 IIFE 里**。
(function () {
  'use strict';

  const T = (typeof module !== 'undefined' && module.exports) ? require('./tauri.js') : window.rmd.tauri;
  const V = (typeof module !== 'undefined' && module.exports) ? require('./versions.js') : window.rmd.versions;
  // ⭐ `design/0009`：搜索的**纯逻辑**（字节→UTF-16 换算 + 提交判据）。
  //    ⚠️ 本文件只负责"发出去 / 收回来"，⛔ 不在这里做换算（那是可单测的部分）。
  //    ⚠️⚠️ 下面这一行是在**加载期**取值的 ⇒ `index.html` 里 `search.js`
  //    **必须排在 `session.js` 之前**（⛔ 别挪到后面）。取成 `undefined` 的后果是
  //    **运行时**才炸，而且不在启动路径上：浮层能开、索引能建（那次是空模式的
  //    `rebuild`，不走 `shouldQuery`），**敲下第一个字符时才报**。
  //    2026-10-14 实测（AX 驱动浮层）：`搜索失败：undefined is not an object
  //    (evaluating 'Search.shouldQuery')`。⇒ 已加源码级闸门守顺序。
  const Search = (typeof module !== 'undefined' && module.exports) ? require('./search.js') : window.rmd.search;
  // ⭐ `design/0020`：目录会话的**唯一**身份判据（`R1`）。⚠️ 与 `Search` 同一条纪律——
  //    加载期取值 ⇒ `index.html` 里 `dirsession.js` **必须排在 `session.js` 之前**。
  //    ⚠️ 它本身**无 `window.rmd.*` 依赖**，所以排在哪两个之间都不会造出别的加载期环。
  const D = (typeof module !== 'undefined' && module.exports) ? require('./dirsession.js') : window.rmd.dirSession;
  // ⭐ `design/0050`：盘上变更的**前端唯一入口**（内容修订 `seq` / 监视健康 / 两条窄命令）。
  //    ⚠️ 与 `Search` / `D` 同一条纪律：**加载期取值** ⇒ `index.html` 里
  //    `diskevents.js` **必须排在 `session.js` 之前**（⛔ 别挪到后面）。
  //    ⚠️ 这里只读它的 `seq()` 与 `adopt()`，⛔ 不在本文件里订阅任何事件
  //    （订阅点只有 `diskevents.install` 一处，`tests/js/tree-fresh.test.js` 钉着）。
  const DE = (typeof module !== 'undefined' && module.exports) ? require('./diskevents.js') : window.rmd.diskEvents;

  /**
   * 会话状态。**单一真源在前端这一侧就是它**。
   *
   * ⚠️ `generation` 是**后端**的值，前端只在两处改它：`refresh()` 与后端命令的返回值。
   * ⛔ 前端**不许**自己 `generation += 1` 猜——那正是 §2.1.4 第 ③ 步要按顺序做的动作，
   * 猜错会制造出一份"看起来对但其实对不上"的代次。
   */
  const state = {
    generation: 0,
    mode: 'single-file',
    roots: [],
    files: [],
    pendingDirectory: null,
    startupDocument: null,
    sidebarWidth: 280,
    lastDirectory: null,
    /**
     * ⭐ **文档视图**的请求序号：**已发出但尚未提交的请求里最新**的那个。
     *
     * ⚠️ 它与树用的是**两个**计数器，这不是啰嗦，是一个真 bug 的边界：
     * 提交点 ① 要求 `resp.req == 最新发出的那个`，而树展开/分片随时会发 `list_dir`。
     * 若两者共用一个计数器，用户一边等大文档、一边展开目录时，
     * **那份文档会被树的请求判成陈旧而静默丢掉**——正文永远不出现。
     * §2.1.3 的表里两行本来就分得很清楚：`request_id` 是"**同一目标**的多次请求"之间的先后。
     */
    latestReq: 0,
    /** **树**的请求序号。它只用于回显；树的提交判据只有 `gen`（§2.1.3 提交点 ②③）。 */
    latestTreeReq: 0,
    /**
     * ⭐ **搜索**的请求序号（`design/0009` §2.1 ⑥）。
     *
     * ⚠️ 这是**第三个**计数器，理由与前两个各自分开是同一条：
     * 提交判据问的是"**同一个目标**的多次请求里，我是不是最新的那个"。
     * 文档、树、搜索结果三个目标的生命周期互不相干（用户可以一边敲搜索、
     * 一边展开目录），共用一个计数器会让它们互相判死。
     */
    latestSearchReq: 0,
    /**
     * ⭐ **文档列表**的请求序号（`design/0041` §2.3 的组合令牌）。
     *
     * ⚠️ 第四个计数器，理由与上面三个各自分开**逐字相同**：提交判据问的是
     * "**同一个目标**的多次请求里，我是不是最新的那个"。搜索浮层开着的同时
     * 侧边栏在拉列表是常态，共用一个计数器会让它们互相判死。
     * ⚠️ 它只管"哪份回包算数"；**分片该不该继续**归 `doclists.js::createToken`。
     */
    latestDocListReq: 0,
    /**
     * ⭐ **侧边栏形态**（`design/0041` §2.3）：`"tree"` / `"list"`。
     * ⚠️ 真值来自后端快照（`config.sidebar_file_view`，缺键 = `"tree"`）；
     * 前端这份是**只读镜像 + 乐观更新**，写盘失败会回滚（见 `setSidebarFileView`）。
     */
    sidebarFileView: 'tree',
    /** ⭐ 树里是否隐藏"子树没有 md"的目录（`design/0041` §2.2），出厂 `true`。 */
    hideEmptyDirs: true,
    /**
     * ⭐ **阅读—编辑连续性开关**（`design/0047` §8），出厂 **`false`**。
     * ⚠️ 关着时 `main.js::setupLive` **一条监听都不挂**（⛔ 不是"半开着"）——
     * 单击不进覆盖层，行为逐字回到 `design/0012`。真值来自后端快照。
     */
    liveEdit: false,
    /**
     * ⭐ 形态**存盘失败**过（R5：让界面说实话，⛔ 不假装存下了）。
     * ⚠️ 失败时**不回滚** `sidebarFileView`：后端已经在内存里改成了新形态，
     * 回滚只会让前后端两份真值分叉（下一次快照又会翻回来，用户看到"自己变回去"）。
     */
    fileViewDirty: false,
    /** 已提交正文的 `request_id`（0 = 还没提交过任何文档）。 */
    committedReq: 0,
    /** 当前已提交的文档（后端返回值，含 `real_path` / `doc_dir`）。 */
    currentDoc: null,
    /** 树里被标记为"当前项"的路径（**已规范化的真实路径**）。 */
    currentPath: null,

    // ── 文件监视与自动重载（`design/0006`）──────────────────────────────
    /**
     * ⭐ **监视代号**（`design/0006` §2.1 ②）：后端在 `watch_document` 里回带。
     *
     * ⚠️ `0` = **没有监视**，而这不是"没建起来"的同义词——它也是
     * "监视因授权改变而失效"的状态（那时 `watchStopped` 为真）。
     * ⛔ 事件判据（`reload.js::acceptEvent`）**必须**看它，⛔ 不许"反正只有一份文档"就不看：
     * 换文档后上一份的迟到事件正好会在这一份上生效。
     */
    watchSeq: 0,
    /** 后端正在监视的那个**规范**路径（`watch_document` 回带，⛔ 不是请求里那个字符串）。 */
    watchPath: null,
    /** ⭐ 监视是不是**因授权改变而停止**了（`INV-EXT-09` 的"可见"那一半）。 */
    watchStopped: false,
    /** 被丢掉的变化事件数（§2.1 ② 要求丢弃要**计数**并进回报）。 */
    watchDropped: 0,
    /** 监视失败 / 已停止的说明（`INV-EXT-04`：降级要显式告知）。空 = 一切正常。 */
    watchNote: '',
    /**
     * ⭐ 上一条的**可见渲染依据**（`design/0025` §2.2 一料两出口）。
     *
     * ⚠️ `watchNote` 是**诊断**文案（进 `report_status` 的 `watch_note`，`make smoke`
     * 按它取数）——⛔ 它必须与用户语言无关，否则冒烟明细会随语言漂移。
     * 而同一句话又是**屏幕上的那一行**（`syncReloadBar`）⇒ 那里按这两个字段现翻。
     * `key` 为空 = 没有话要说。
     */
    watchNoteKey: '',
    /** 上面那个键的插值（`{note}`）。 */
    watchNoteArg: '',

    // ── 阅读进度（`design/0017`）───────────────────────────────────────
    /**
     * ⭐ **运行期恢复表**：`real_path -> ReadingProgress`。
     *
     * ⚠️ 它不是第二个真值——真值在 `config.json`（后端）。这一份是
     * ①启动快照的**只读镜像** ＋ ②保存成功后的**增量回写**（`progress.js::mergeWrite`）。
     * ⛔ 别在这里直接改单个键，走 `mergeWrite`（它同时消费 `evicted`）。
     */
    readingProgress: {},
    /**
     * ⭐ **打开会话号**（`design/0017` §2.2 ①）：后端每次成功提交 `open_document` +1。
     * ⚠️ 写进度的 IPC 要带它；后端用它区分"同一路径的两次打开"。
     */
    docSeq: 0,

    // ── 目录会话（`design/0020`）───────────────────────────────────────
    /**
     * ⭐ **启动页那张「最近目录」表**（`design/0038` §2.1 ①）。
     *
     * ⚠️ 它是**后端派生量**（`commands/mod.rs::recent_dirs`）：已排序、已截到 10 条、
     *    已标好 `last`，前端⛔ **不再排序也不再加条目**——两份派生规则迟早分叉。
     * ⚠️ 形状：`[{root, last_file, updated_at, last}]`，永远是数组（不是 `null`）。
     */
    recent: [],
    /**
     * ⭐ **收藏**（`design/0043` §2.1）：后端 `config.favorites` 的只读镜像。
     *
     * ⚠️ 顺序就是显示顺序，⛔ 前端不排序；⛔ 也不并存 `localStorage`
     *    （`INV-FAV-02`：只有一份数据源）。写入只走 `favorites_apply` 的回包
     *    （§2.8 的串行写者），⛔ 别在别处改这个数组。
     */
    favorites: [],
    /**
     * ⭐ 当前目录的会话**只读镜像**（真值在 `config.json`，由后端整理/夹取）。
     * ⚠️ 形状：`{last_file, expanded, updated_at}` 或 `null`。
     * ⛔ 别在这里直接改单个字段——写入只有 `setDirSession` 的回包
     *    （`dirsession.js::createWriter` 的三重闸），多一处就是第二个真值。
     */
    dirSession: null,
    /** 上面那份镜像**属于哪一代**（`R5`：迟到的 A 响应不许倒灌进 B）。 */
    dirSessionGen: 0,
    /** ⭐ **这一代已经恢复过**（幂等标记，⛔ 不是第二个"上次文件"）。 */
    restoredGen: 0,
    /**
     * ⭐ `design/0041` R4：**这一代还有一条 `expanded` 记录没被消费**（`0` = 没有）。
     *
     * 列表形态启动时恢复器只打开 `last_file`，**刻意不展开树**（用户此刻看不见树）
     * ⇒ 把代次记在这里；切回树形态时按它补做一次展开恢复，然后清掉。
     * ⚠️ 换代时清空（见 `applySnapshot`）——它和 `restoredGen` 一样**只对一代有效**。
     */
    treeRestorePending: 0,
    /**
     * ⭐ 正在跑的那次恢复（`null` = 没有）。
     * ⚠️ 与 `dirsession.js::createRestorer` 里的 `current` **是同一个对象**——
     * 恢复流程与写者都读它：写者在它活着时**挂起**（`INV-SESS-09`）。
     * ⚠️ **不跨代存活**：`applySnapshot` 换代时清空。
     */
    restoreToken: null,
  };

  const listeners = [];
  function onChange(fn) { listeners.push(fn); }
  function emit() { for (const fn of listeners) { try { fn(state); } catch (e) { console.error(e); } } }

  /** 现在这一刻的版本真值。⛔ 调用方必须在**提交的那一刻**现取。 */
  function current() {
    return { generation: state.generation, latestReq: state.latestReq };
  }

  function applySnapshot(snap) {
    // ⭐⭐ **授权变了 ⇒ 监视在后端已经失效**（`INV-EXT-09`）。
    //    后端那一半是**结构性的**（`SessionGrants::root_generation` 一变，
    //    回调自己就把监视摘了，见 `external::watch::on_change`）；
    //    ⛔ 但"结构上没了"与"用户知道"是两件事，后者必须在这里补上。
    //
    // ⚠️ 判据放在 `applySnapshot` 里而不是每个授权命令里：调用点有四个
    //    （`chooseDirectory` / `chooseFile` / `closeDirectory` / `refresh`），
    //    而"代次变了"这个事实**只有快照本身知道**。写在这里就没有漏掉的可能。
    const genChanged = typeof snap.generation === 'number' && snap.generation !== state.generation;
    if (genChanged && state.watchSeq !== 0) {
      const staleSeq = state.watchSeq;
      state.watchSeq = 0;
      state.watchPath = null;
      state.watchStopped = true;
      // ⚠️ 两出口（`design/0025` §2.2）：这句进报告要稳定 ⇒ 留中文；屏幕那行按 key 现翻。
      state.watchNote = '文件监视已停止（授权已改变）';
      state.watchNoteKey = 'reload.watch-stopped';
      state.watchNoteArg = '';
      // ⭐ **顺手让后端也放下它**——⛔ 这不是"清理"，是**对账**。
      //    后端的失效规则是**事件驱动**的（`external::watch::on_change` 收到一条事件
      //    才发现代次变了），而事件**不保证会来**：用户可能再也不碰那个文件。
      //    ⇒ 不补这一句，"后端还握着旧监视、而前端已经认定它没了"可以无限期存在，
      //    期间 `⌘E` 与重载会打向一份**旧文档**（那些路仍会过 `check_readable`，
      //    所以不是漏洞，但它是个静默的旧真值）。
      //    ⚠️ **带上 `seq`**：这条消息发出去之后用户可能已经开了下一份文档，
      //    无条件停会**把新的那个摘掉**（`unwatch_document` 的文档里写了这个交错）。
      //    ⚠️ 不 `await`——`applySnapshot` 是同步的，而调用方**不该**为一次对账多等一趟 IPC。
      //    失败只往 stderr 说：前端本地真值已经清了，最坏是多留一会儿（下一次换文档会换掉）。
      Promise.resolve()
        .then(function () { return T.call('unwatch_document', { seq: staleSeq }); })
        .catch(function (e) { console.error('让后端放下陈旧监视失败：', e); });
    }
    state.generation = snap.generation;
    state.mode = snap.mode;
    state.roots = snap.roots || [];
    state.files = snap.files || [];
    state.pendingDirectory = snap.pending_directory || null;
    state.startupDocument = snap.startup_document || null;
    state.sidebarWidth = snap.sidebar_width;
    // ⭐ `design/0041` §2.3：形态与空目录开关也走这一趟快照（⛔ 不新增"读配置"命令）。
    //    ⚠️ 字段名是 **snake_case**——与 `dir_session` / `reading_progress` 同一条纪律：
    //    写成 camelCase 会被**静默丢弃**（`docs/bugs/0007`）。
    state.sidebarFileView = snap.sidebar_file_view === 'list' ? 'list' : 'tree';
    state.hideEmptyDirs = snap.hide_empty_dirs !== false;
    // ⭐ `design/0047` §8：阅读—编辑连续性的开关。⚠️ 字段名是 **snake_case**（`live_edit`）
    //    ——与 `hide_empty_dirs` 同一条纪律，写成 camelCase 会被**静默丢弃**（`docs/bugs/0007`）。
    //    ⚠️ **严格 `=== true`**：缺键 / `"false"` 这类坏值一律当**关**（回滚路径必须是默认）。
    state.liveEdit = snap.live_edit === true;
    state.lastDirectory = snap.last_directory || null;
    // ⭐ `design/0038` §2.1 ①：启动页那张表**只认快照**（排序/截断/`last` 标记全在后端）。
    //    ⚠️ 字段名是 **snake_case**（`recent`）——与 `dir_session` 同一条纪律：
    //    写成 camelCase 会被**静默丢弃**（`docs/bugs/0007`）。
    state.recent = snap.recent || [];
    // ⭐ `design/0043` §2.1：收藏也在同一趟快照里。⚠️ 字段名是 **snake_case**
    //    （`favorites`）——与 `recent` 同一条纪律，写成 camelCase 会被**静默丢弃**（`docs/bugs/0007`）。
    //    ⚠️ 这里只**镜像**；收藏操作的回包**不走** `applySnapshot`（见 `enqueueFavorite`）。
    state.favorites = Array.isArray(snap.favorites) ? snap.favorites.slice() : [];
    // ⭐ `design/0017` §2.3 ①：进度全表只有**这一个**入口（启动 / 授权变化时随快照来）。
    //    ⚠️ 字段名是 **snake_case**——后端原样返回（`docs/bugs/0007` 的教训：
    //    camelCase 会被**静默丢弃**，不会报错）。
    state.readingProgress = snap.reading_progress || {};
    state.docSeq = snap.doc_seq || 0;

    // ⭐ `design/0020` §2.3 ②：镜像与代次**成对**赋值。
    //    ⚠️ 字段名是 **snake_case**（`dir_session`）——后端原样返回，
    //    写成 camelCase 会被**静默丢弃**（`docs/bugs/0007` 的同族）。
    //
    // ⚠️⚠️ **`restoreToken` 必须在这里清空**：一次旧恢复的 `alive()` 判据里有
    //    `st.generation === token.generation`，但**代次可能绕回来**
    //    （A → B → A 之后 `generation` 未必与那次 token 相同，可"同一个对象还挂在
    //    state 上"这件事本身就是残留）。清零点在这里只有一处，⛔ 别指望恢复自己收尾。
    state.dirSession = snap.dir_session || null;
    state.dirSessionGen = snap.generation;
    state.restoreToken = null;
    // ⭐ `design/0050` §2.3.3：监视健康也在同一趟快照里（字段名 **`disk`**，
    //    ⚠️ snake_case 那条纪律对它同样成立）。⚠️ 只**镜像**成一个状态，
    //    ⛔ 不是"待消费的队列"——重复读一百次结果一样。
    //    ⚠️ 顺手让它按 `revision` 自己丢弃倒退的包（换根时后端 `reset_roots`
    //    会把 `epoch` 归零，而 `revision` 是单调的 ⇒ 那里由 `genChanged` 兜底）。
    if (snap.disk && typeof DE.adopt === 'function') DE.adopt(snap.disk);
    // ⭐ `design/0041` R4：待补的展开记录**只对一代有效**——换了根，那条记录
    //    里的路径也不再属于当前树。⚠️ 它记的是代次而不是布尔值，正是为了这里能判"过期"。
    if (genChanged) state.treeRestorePending = 0;

    // ⭐⭐ **R1 / `INV-SESS-10`：文档身份只在当前根之内算数。**
    //
    // 没有这一段时，"A 读文件 → 打开 B"之后 `currentDoc` / `currentPath` **仍是 A 的**
    // （B 是目录授权，不改文档状态），而恢复流程会把它当成"B 里已经有当前文档了"
    // ⇒ B 记录里的 `last_file` **永远打不开**，界面上看起来像"记住了但没恢复"。
    //
    // ⚠️ 判据必须用 `D.isInside`（⛔ 不是另一份 `startsWith`）：`rootfoo` 前缀陷阱
    //    在这里的后果是"把 A 的文件当成 B 树里的当前项"，正文栏显示的与树高亮的对不上。
    // ⚠️ 只在**有唯一根**时判：单文件模式（`roots` 为空）里 `currentPath` 是合法的，
    //    那是 `design/0003` §2.1.4 ② 的正常状态，⛔ 别一起清掉。
    // ⚠️ 清 `docSeq` 是**故意**的：它是"打开会话号"（`0017`），旧文档的迟到进度写
    //    会因它被后端判 `stale` —— 不清的话，一次切目录能把 A 的滚动位置写进 B 的记录。
    if (state.roots.length && state.currentPath && !D.isInside(state.roots[0], state.currentPath)) {
      state.currentDoc = null;
      state.currentPath = null;
      state.docSeq = 0;
    }

    emit();
    // ⭐ 返回**后端那份原始快照**（字段名就是 serde 的名字：`startup_document` /
    //    `sidebar_width` / `pending_directory`…），⛔ **不是**内部的 `state`。
    //
    // ⚠️ 2026-10-13 实测踩到：头一版 `return state`，于是调用方写
    //    `snap.startup_document` 拿到的是 `undefined`——启动时那份文档
    //    **静默地不打开**，界面上只剩一句"用 Cmd+O 打开…"，
    //    而后端日志一切正常（`open_document` 压根没被调用过）。
    //    两种字段名（`startup_document` vs `startupDocument`）都能跑通编译，
    //    只能靠"返回哪一份"这条约定来分——所以在这里写死。
    return snap;
  }

  /** 问后端"现在是什么状态"。前端启动时必调一次（⛔ 不猜、不拼路径，`INV-TREE-01`）。 */
  async function refresh() {
    return applySnapshot(await T.call('get_session'));
  }

  /**
   * ⭐ **取走 Apple Event 送来的打开请求**（`design/0015` §2.1 ④）。
   *
   * ⚠️ 它只是转发：⛔ 不收路径参数、⛔ 不改授权——后端在收到 `odoc` 的那一刻
   * 就已经走完 `authorize_startup`（`INV-APP-02`）。前端拿到的每条路径都已授权。
   * ⚠️ 与既有封装同形：判据（先开哪个 / 怎么开）一律不在这一层。
   *
   * @returns {Promise<string[]>} 规范化后的真实路径，可能为空
   */
  async function takePendingOpen() {
    const paths = await T.call('take_pending_open');
    return Array.isArray(paths) ? paths : [];
  }

  /**
   * ⭐ 提交点 ① · 打开一份文档。
   *
   * @returns {{payload: object|null, decision: object}} `decision.commit === false` 时
   *          `payload` 是 `null`，调用方**什么都不做**（⛔ 不提示、⛔ 不回滚界面）。
   */
  async function openDocument(path) {
    const req = ++state.latestReq;
    const generation = state.generation;

    let payload;
    try {
      payload = await T.call('open_document', { path, generation, req });
    } catch (e) {
      // ⚠️ `stale` 是**正常路径**（§2.1.3）：一个更新的请求已经赢了这个位置，
      //    这里静默返回 `null`，⛔ 不改界面、⛔ 不打错误到状态条。
      if (T.isStale(e)) return { payload: null, decision: { commit: false, reason: 'gen' } };
      throw e;
    }

    // ⭐ 提交那一刻现取真值（⛔ 不是发请求时那一份）
    const decision = V.docCommitDecision(payload, current());
    if (!decision.commit) return { payload: null, decision };

    state.currentDoc = payload;
    state.committedReq = req;
    // ⭐ 这**是**从后端来的规范化真实路径。⛔ 不许回退成请求里那个字符串（TOCTOU，`INV-FS-01`）。
    state.currentPath = payload.real_path;
    emit();

    // ⭐ §2.1.4 第 ③ 步——**必须在正文提交之后**。顺序换一下就是
    //    "刚拿到的那份正文被自己的版本检查判为陈旧"：一次**必然失败**的自我否定。
    let closed = null;
    if (V.step3Needed(payload)) closed = await closeDirectory();
    return { payload, decision, closed };
  }

  /**
   * ⭐ 提交点 ②③ · 列出一层。
   *
   * ⚠️ 返回的 `result` 是否需要**丢弃**由调用方在追加时决定（分片是异步的，
   * 判断必须落在每个分片开头——见 `chunked.js`）。这里只做入口的那次检查，
   * 目的是**不做白工**：代次不符就别读了（§2.1.3 规则 2 的后端那一半也在做同一件事）。
   *
   * @param {string} path
   * @param {boolean} [fresh] ⭐ `design/0009` §2.1 ⑤：**先作废后端那一层的缓存再列**。
   *        ⛔ 不是"绕过缓存"，是"承认这份缓存可能是旧的"——搜索索引刚重建过，
   *        而某一层的树缓存是更早的，新建的文件不在里面（`invalidate` 的落点）。
   */
  async function listDir(path, fresh) {
    const req = ++state.latestTreeReq;
    const generation = state.generation;
    // ⭐ `design/0050`：**观测起点**的内容修订。⚠️ 必须在发请求**之前**取，
    //    而且要在**返回时**再取一次比——不是"发请求前检查一次"（§2.1.3 规则 1 的同一条）。
    const seq0 = DE.seq();
    try {
      const result = await T.call('list_dir', { path, generation, req, fresh: !!fresh });
      // ⭐ 树的提交判据**只有** `gen`（§2.1.3 提交点 ②③ 的检查列）。
      //    ⛔ 不要顺手把 `req` 也加进来：树是逐层懒加载的，多个 `list_dir`
      //    同时在路上是**常态**（展开父层时子层的请求已经在发），
      //    加 `req` 会让正常的并发互相判死。
      if (result.gen !== state.generation) return { result, decision: { commit: false, reason: 'gen' } };
      // ⭐⭐ `design/0050` 最终约束 4 的**提交点那一半**：代次没变，但**内容修订**在
      //    读盘期间前进了 ⇒ 这一份描述的是"刚才那个时刻的盘"。
      //    ⚠️ 处置与 `gen` **相反**：那个必须放弃（整棵树都换了），这个必须**重列**
      //    （同一棵树，只是盘上新了一点）。⇒ 用**不同的 reason**，⛔ 别并成一个 `stale`。
      if (DE.seq() !== seq0) return { result, decision: { commit: false, reason: 'rev' } };
      return { result, decision: { commit: true, reason: null } };
    } catch (e) {
      // ⭐ 后端在提交点也复核了内容修订（`tree::should_commit`）：它给的
      //    `stale_revision` 与这里那次比较是**同一件事的两端**，同样按"重列"处置。
      if (T.isStaleRevision && T.isStaleRevision(e)) {
        return { result: null, decision: { commit: false, reason: 'rev' } };
      }
      if (T.isStale(e)) return { result: null, decision: { commit: false, reason: 'gen' } };
      throw e;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ⭐ 文件名搜索（`design/0009`）
  // ─────────────────────────────────────────────────────────────────────────

  /** 搜索那一刻的版本真值。⛔ 调用方必须在**提交的那一刻**现取。 */
  function currentSearch() {
    return { generation: state.generation, latestSearchReq: state.latestSearchReq };
  }

  /**
   * ⭐ **发一次搜索**（`design/0009` §2.1 ②⑥）。
   *
   * ⚠️ **没有 `root` 参数**：索引覆盖全部已授权 root，由后端决定扫哪些
   * （让前端指定"扫哪里"就是一个绕过 `INV-FS-04` 的口子）。
   * ⚠️ **`rebuild`** 是"强制重建索引"：浮层打开时与浮层内按刷新键时传 `true`
   * （§2.1 ② 的重建时机表）。⛔ 别把它理解成缓存开关——后端不缓存**结果**，
   * 缓存的只有那份按代次失效的**清单**。
   *
   * ⚠️ 空模式**不发 IPC**（除非这次同时要重建索引）：后端对空模式返回空结果，
   * 发一趟只是白跑。⚠️ 但要重建索引时空模式**必须发**——索引的建立与模式无关。
   *
   * @returns {{result: object|null, decision: object}}
   */
  async function searchFiles(pattern, rebuild) {
    const force = !!rebuild;
    const req = ++state.latestSearchReq;
    const generation = state.generation;

    if (!force && !Search.shouldQuery(pattern)) {
      // ⛔ 也要占一个序号：否则"先敲一个字、再删空"会让前一次的结果
      // 因为 `req` 仍相等而通过提交判据，把一份已经不该显示的结果画出来。
      return { result: null, decision: { commit: false, reason: 'empty' } };
    }

    let raw;
    try {
      raw = await T.call('search_files', { pattern: pattern, req: req, rebuild: force });
    } catch (e) {
      // ⚠️ `stale` 是**正常路径**（代次在遍历期间变了，§2.1 ②.2）：
      //    后端已经把那份索引丢掉了，这里静默返回，由调用方决定要不要重发。
      if (T.isStale(e)) return { result: null, decision: { commit: false, reason: 'gen' } };
      throw e;
    }

    const result = Search.normalizeResult(raw);
    // ⭐ 提交那一刻现取真值（⛔ 不是发请求时那一份）
    const decision = Search.commitDecision(result, currentSearch());
    return { result: result, decision: decision };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ⭐ 文档列表（`design/0041`）
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * ⭐ **拉一次文档列表**（`design/0041` §2.1.3）——薄封装，⛔ 判据不在这里。
   *
   * ⚠️ 它与 `search_files` **共用后端同一份索引**（`INV-DOCS-01`）。
   * `rebuild` 的语义与搜索那个同名参数**逐字相同**（"强制重建"，⛔ 不是缓存开关）。
   *
   * ⚠️ **不在这里算提交判据**：`shouldApply` 还要比 `index_rev` 与组件自己的
   * `appliedRev`，那是 `components/DocList.js` 的状态（`doclists.js::shouldApply` 只做纯判断）。
   * 这里只把"这次用的请求号"原样带回，调用方拿它跟 `latestDocListReq` 对齐。
   *
   * @param {boolean} [rebuild]
   * @returns {Promise<{result:object|null, req:number, stale:boolean}>}
   *   `stale` = 后端判代次不符（切根后的在途请求，**正常路径**，⛔ 不是错误）
   */
  async function listDocuments(rebuild) {
    const req = ++state.latestDocListReq;
    const generation = state.generation;
    try {
      const result = await T.call('list_documents', {
        generation: generation,
        req: req,
        rebuild: !!rebuild,
      });
      return { result: result, req: req, stale: false };
    } catch (e) {
      if (T.isStale(e)) return { result: null, req: req, stale: true };
      throw e;
    }
  }

  /** 列表提交那一刻的版本真值。⛔ 调用方必须在**提交的那一刻**现取。 */
  function currentDocList() {
    return { generation: state.generation, latestDocListReq: state.latestDocListReq };
  }

  /**
   * ⭐ **写侧边栏形态**（`design/0041` §2.3 / R5）。
   *
   * ⚠️ 与 `setSidebarWidth` 的差别是**失败语义**：形态是用户显式选的模式，
   * 存不下来要让他知道（后端回 `Err`，这里**照样抛**，由调用方置 dirty 并提示）。
   * 而宽度存不下来不值得打断。
   *
   * ⚠️ 乐观更新**只在前端这一层**：先改 `state` 再发 IPC。
   * ⚠️⚠️ 存盘失败**⛔ 不回滚**（与 `setSidebarWidth` 的"存不下来不值得打断"不同族）：
   * 后端在**内存里已经改了**，只是写盘失败 ⇒ 回滚会让前后端两份真值分叉。
   * 这里只置 `fileViewDirty` 并抛出，由界面说一句"这次的选择未能保存"（R5）。
   * @returns {Promise<'tree'|'list'>} 后端**实际生效**的形态（⛔ 不是请求里那个）
   */
  async function setSidebarFileView(view) {
    const want = view === 'list' ? 'list' : 'tree';
    state.sidebarFileView = want;
    state.fileViewDirty = false;
    emit();
    try {
      const applied = await T.call('set_sidebar_file_view', { view: want });
      state.sidebarFileView = applied === 'list' ? 'list' : 'tree';
      emit();
      return state.sidebarFileView;
    } catch (e) {
      state.fileViewDirty = true;
      emit();
      throw e;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 文件监视与自动重载（`design/0006`）
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * ⭐ **建立监视**（`INV-EXT-06`：**只在一次成功的提交之后**调）。
   *
   * ⚠️ 三种失败**必须区分**，因为用户要做的事不同：
   * ① 后端拒绝（`not_authorized` / `not_found`）——文件真的不能看了；
   * ② ACL 少了一条 `allow-watch-document`——`invoke` 被静默拒，界面上完全没有线索；
   * ③ 后端说这个路径不能监视（`io`）。
   * ⛔ 三种都不许静默：`watchNote` 会进状态条与回报（`INV-EXT-04`）。
   *
   * @param {string} path 已提交文档的 `real_path`（⛔ 不是请求里那个字符串）。
   */
  async function watchDocument(path) {
    try {
      const info = await T.call('watch_document', { path });
      state.watchSeq = info.seq;
      state.watchPath = info.path;
      state.watchStopped = false;
      state.watchNote = '';
      state.watchNoteKey = '';
      state.watchNoteArg = '';
      emit();
      return info;
    } catch (e) {
      // ⚠️ 起不来**不是**致命错误：正文照样能读，只是不会自动刷新。
      state.watchSeq = 0;
      state.watchPath = null;
      state.watchNote = '自动刷新不可用：' + ((e && e.message) || e);
      state.watchNoteKey = 'reload.watch-start-failed';
      state.watchNoteArg = String((e && e.message) || e);
      emit();
      return null;
    }
  }

  /**
   * 停止监视（⛔ 不清正文、⛔ 不碰授权）。
   *
   * ⚠️ 唯一的调用点是 `applySnapshot` 里那次**对账**（授权变了 ⇒ 监视在后端也作废）。
   * ⛔ **不做关窗钩子**：最后一条监视随进程消亡，而停止本身是异步的，
   * 不会拖住退出（`design/0006` §10.5 的那一处已定，理由写在 Rust 那个命令上）。
   *
   * ⚠️ 带上 `seq`，⛔ 不是无条件停：这条消息可能比"用户已经开了下一份文档"
   * 慢一步，无条件停会把**新**的那个摘掉，且双方日志都正常。
   */
  async function unwatchDocument(seq) {
    if (!seq) return;
    try {
      await T.call('unwatch_document', { seq });
    } catch (e) {
      // ⚠️ 停不下来**只往 stderr 说**：本地真值已经清了，前端不会再接受事件，
      //    最坏情况是后端多监视一会儿（下次 `watch_document` 会换掉它）。
      console.error('unwatch_document 失败：', e);
    }
  }

  /** 记一条被丢掉的事件（§2.1 ② 的"丢弃要计数"）。 */
  function noteDroppedEvent() {
    state.watchDropped += 1;
  }

  /**
   * ⭐ **重载当前文档**（`design/0006` §2.1 ②：⛔ 不收路径参数）。
   *
   * ⚠️ 它**不是** `openDocument(path)` 的别名，两处不同是本质的：
   * ① 目标由**后端**的 `current_document` 决定 ⇒ 前端那一份"我以为在显示什么"的意见
   *    不参与决定；
   * ② 提交判据多一条**身份**（`INV-EXT-07`）：代次相同**不足以**说明还是同一份文档
   *    （同根下切文档不改代次），所以还要比对 `real_path`。
   *
   * @returns {{payload: object|null, decision: object}} 与 `openDocument` 同形。
   */
  async function reloadDocument() {
    const req = ++state.latestReq;
    const generation = state.generation;
    // ⭐ **发起那一刻**的身份。⚠️ 必须现取：提交时要拿它核对，
    //    而这中间可能已经发生了"用户点了另一份文件"。
    const identity = state.currentPath;

    let payload;
    try {
      payload = await T.call('reload_document', { generation, req });
    } catch (e) {
      if (T.isStale(e)) return { payload: null, decision: { commit: false, reason: 'gen' } };
      throw e;
    }

    const decision = V.docCommitDecision(payload, current());
    if (!decision.commit) return { payload: null, decision };
    // ⭐ `INV-EXT-07` 的后半句：**代次挡不住同根切文档**。
    //    ⛔ 少了这一条，"用户在我读盘那几秒里点了另一份文件"会把
    //    旧文档的内容写进新文档的状态位——两份内容都不带错，
    //    只是**显示的那份**与**记下来的那份**不是同一个。
    if (payload.real_path !== identity) {
      return { payload: null, decision: { commit: false, reason: 'identity' } };
    }

    state.currentDoc = payload;
    state.committedReq = req;
    state.currentPath = payload.real_path;
    emit();
    return { payload, decision };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ⭐ 窗口内编辑的四个 IPC 封装（`design/0012` §2.4 / §2.6）
  //
  // ⚠️ 它们**都是薄封装**（照 `openDocument` / `reloadDocument` 的形态）：
  //    ⛔ 这里不做判据、⛔ 不排队、⛔ 不管单飞。那些全在**纯逻辑**那一侧
  //    （`src/editor/{save,preview}.js`，可 `node --test`）——
  //    把判据写进本文件会让它们变成"只能在真窗口里验"的东西（`design/0002` §7.0）。
  //
  // ⭐ **`req` 由调用方给**：预览那个计数器是**独立**于 `latestReq` / `latestTreeReq`
  //    / 搜索那一个的**第四个**（`INV-EDIT-07`）。⚠️ 别在这里 `++state.latestReq`——
  //    那正是 `design/0003` §2.1.3 明文禁止的那种"共用计数器"，
  //    它会让"我在等大文档"与"我在等预览"互相把对方判成陈旧。
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * ⭐ **进入（或刷新）编辑态**：拿写授权 ＋ 一份规范化后的源码（`EditGrant`）。
   *
   * ⚠️⚠️ **已经是编辑态时再调 = 刷新**：后端会把文本与基线**一起换新**，
   * 而**旧的未保存内容不会被保留** ⇒ ⛔ 前端**只有在打算丢弃它的时候**才允许调它
   * （`INV-EDIT-06`：有脏标记时那道闸管的就是这件事）。
   */
  async function beginEdit() {
    return T.call('begin_edit', { generation: state.generation });
  }

  /**
   * ⭐ **退出编辑态**：撤销写授权。
   *
   * ⚠️ 后端**不返回错误**（重复调用是常态）⇒ 这里也⛔ 不包 `try/catch` 去忽略什么：
   * 它**不是**一个"可失败的动作"，把它写成可以失败的样子会诱使调用方吞掉真正的失败。
   */
  async function endEdit() {
    return T.call('end_edit');
  }

  /**
   * ⭐ 用编辑缓冲渲染右侧预览（`design/0012` §2.1 ②）。
   *
   * ⚠️ **不读盘、不碰会话状态**（`INV-EDIT-07`）⇒ 它不会与 `open_document` / `reload_document`
   * 互相取消对方的渲染。⚠️ `git` 侧没有"路径"参数——`render_preview` 只认文本，
   * 它**结构上**读不了任何文件。
   *
   * ⭐ `design/0054`：`verify` 是**可选**的「同一趟顺带验一下候选」请求
   * （`INV-EDITOBJ-03` 的落地形态，⛔ 不新开命令）。它只影响回包里的 `verify` 字段，
   * ⛔ 不改变渲染本身——**失败也照样渲染**（`INV-SINGLE-01`：不为失败路径开只解析的分叉）。
   * ⚠️ 传 `null` 时要**显式**带这个键：靠"缺键"表达"不校验"会让两侧口径不一致。
   */
  async function renderPreview(text, req, verify) {
    return T.call('render_preview', {
      text: text,
      generation: state.generation,
      req: req,
      verify: verify || null,
    });
  }

  /**
   * ⭐ **唯一的保存入口**（`INV-EDIT-10`）。⚠️ 目标恒等于后端的 `current_document`——
   * 这里⛔ 不传路径（传了就有两个说法，`INV-EDIT-02`）。
   */
  async function saveDocument(text, req) {
    return T.call('save_document', { text: text, generation: state.generation, req: req });
  }

  /**
   * ⭐ **记录阅读位置**（`design/0017` §2.2 ②）。
   *
   * ⚠️ 它**只写 `config.json`**：⛔ 不读文档、⛔ 不改授权、⛔ 不是第二条可读路径。
   * ⚠️ `docSeq` 由调用方在**捕获那一刻**取好并原样带回——后端用它区分
   * "同一路径的两次打开"（A→B→A 之后，A 的迟到写入必须落不进去）。
   */
  async function setReadingProgress(path, docSeq, progress) {
    return T.call('set_reading_progress', {
      path: path,
      doc_seq: docSeq,
      progress: progress,
    });
  }

  /**
   * ⭐ **记录目录会话**（`design/0020` §2.3 ②b）。
   *
   * ⚠️ 它**只写 `config.json`**：⛔ 不读文档、⛔ 不改授权、⛔ 不是第二条可读路径。
   * ⚠️ `generation` 由调用方在**发请求那一刻**取好并原样带回——后端用它判
   * "这次写的是不是当前这一代的目录"（`INV-SESS-12`，不匹配回 `stale`）。
   * ⚠️ 返回值形状：`{status, entry, evicted}`，`status ∈ ok|cleared|stale|persist_failed`。
   *    ⭐ **`cleared` 是合法成功状态**（空会话 = 用户把树全折了，记录就该消失）。
   */
  async function setDirSession(root, generation, lastFile, expanded) {
    return T.call('set_dir_session', {
      root: root,
      generation: generation,
      // ⚠️ 字段名 snake_case：后端 `last_file` / `expanded`（`docs/bugs/0007` 的教训）。
      last_file: lastFile,
      expanded: expanded,
    });
  }

  /**
   * ⭐ `design/0034`：**新建文件 / 目录**（`create_entry`）的薄封装。
   *
   * ⚠️ 这里⛔ **不校验名字、⛔ 不补 `.md`、⛔ 不判父目录**——规则只有后端一份
   * （`INV-TREE-07`：`fs/create.rs::validate_name` ＋ `check_creatable`）。
   * 前端把**用户原样的单段名字**递过去，拿回来的 `name` 才是最终名字（可能补了 `.md`）。
   *
   * @param {string} parent 父目录（后端会规范化；⛔ 前端不拼新路径）
   * @param {string} name 用户输入（原样，⛔ 不 trim）
   * @param {'file'|'dir'} kind
   * @returns {Promise<{path:string, name:string, kind:'file'|'dir'}>}
   */
  async function createEntry(parent, name, kind) {
    return T.call('create_entry', { parent: parent, name: name, kind: kind });
  }

  /**
   * ⭐ `design/0035` §3：**重命名一个普通 Markdown 文件**（`rename_entry`）的薄封装。
   *
   * ⚠️ 这里⛔ **不校验名字、⛔ 不拼目标路径、⛔ 不判扩展名**——规则只有后端一份
   * （`check_renamable` ＋ `validate_name`）。目标**只能在原目录内**，
   * 所以调用方只给"从哪一份"和"新名字"。
   *
   * ⭐ 成功后做**身份迁移**（§3.5 那张表的前端那两行）：
   * - `currentPath` / `currentDoc.real_path`：**仅当后端说 `current_moved`**；
   * - `watchSeq` / `watchPath`：后端改名时**重启了** watcher 并取了新 `seq`，
   *   不覆盖的话 `acceptEvent` 会把之后每一条事件都判成"不是我这轮监视的"而**静默丢弃**
   *   （症状 = 自动重载"看起来正常"但再也不触发）。⚠️ ⛔ 不走"再发一次 `watch_document`"：
   *   那会白白再起一份监视、再换一次 seq。
   * - `watch_seq === 0` 且 `current_moved` ⇒ 后端那次 restart 失败了：置成"没有监视"
   *   并**说出来**（`INV-EXT-04`）。
   *
   * ⚠️ 阅读进度的旧键**不迁移**（`design/0035` §3.5 的明确限制）：它是一张按路径
   * 自然淘汰的缓存，不为了它新增一条"删键"命令。
   *
   * @param {string} from 树里那一行的路径（后端会规范化；⛔ 前端不拼新路径）
   * @param {string} name 用户输入的新名字（原样，⛔ 不 trim）
   * @returns {Promise<{path:string, name:string, old_path:string, current_moved:boolean,
   *                    watch_seq:number, degraded:string[]}>}
   */
  async function renameEntry(from, name) {
    // ⭐ **调用前捕获会话身份**（`design/0035` §10.6 处置）：
    //    - `generation` = 根代次（换根 / 换目录会变）；
    //    - `docSeq` = 打开会话号（切走再切回来也会变）；
    //    - `currentDoc` = 那一份已提交正文的**对象身份**；
    //    - `currentPath` = 当时树里高亮的那一份。
    // ⚠️⚠️ **路径相等不能代替会话相等**：切根后重开同一路径、切到别的文档再切回来，
    //    `currentPath` 都可能又恰好是同一个字符串，但 `currentDoc` / `docSeq` 已是新会话的。
    const before = {
      generation: state.generation,
      docSeq: state.docSeq,
      currentPath: state.currentPath,
      doc: state.currentDoc,
    };
    const res = await T.call('rename_entry', { from: from, name: name });
    if (!res || !res.current_moved) return res;

    // ⚠️ 改名在飞期间用户可能已经打开了别的文档（或换根）：那时 `currentPath`
    //    **已经不是**被改的那一份，后端 `current_moved` 说的是"我搬的时候它还是当前文档"。
    //    ⇒ 只在**会话、根代次、文档身份**都对得上时迁移，⛔ 别把新文档的路径 / 监视 seq
    //    覆盖成旧文档的。
    // ⚠️ 身份对不上时**仍然把 `res` 原样交回去**：盘上的改名已经成功，
    //    调用方要拿 `res.path` 去重列那一层。⛔ 不在这里抛错、⛔ 不改 `res` 的字段
    //    （那会让"前端放弃提交"被误报成"改名失败"）。
    const sameSession =
      state.generation === before.generation &&
      state.docSeq === before.docSeq &&
      state.currentDoc === before.doc &&
      state.currentPath === before.currentPath &&
      before.currentPath === res.old_path;
    if (!sameSession) return res;

    state.currentPath = res.path;
    if (state.currentDoc && state.currentDoc.real_path === res.old_path) {
      state.currentDoc.real_path = res.path;
    }
    if (typeof res.watch_seq === 'number' && res.watch_seq > 0) {
      state.watchSeq = res.watch_seq;
      state.watchPath = res.path;
      state.watchStopped = false;
      state.watchNote = '';
      state.watchNoteKey = '';
      state.watchNoteArg = '';
    } else {
      // ⚠️ 两出口（`design/0025` §2.2）：诊断留中文、屏幕那行按 key 现翻。
      state.watchSeq = 0;
      state.watchPath = null;
      state.watchNote = '自动刷新不可用：改名后没能重建监视';
      state.watchNoteKey = 'reload.watch-rename-failed';
      state.watchNoteArg = '';
    }
    emit();
    return res;
  }

  /**
   * ⭐ `design/0048`：**在访达中显示**（`reveal_entry`）的薄封装。
   *
   * ⚠️ 这里⛔ 不判路径、⛔ 不判类型、⛔ 不拼路径——`is_dir` 只是**提示**，
   * 后端按 `check_readable` 返回的**规范路径**自己判（软链、同名换种类都算那种情况）。
   * ⚠️ 它也⛔ **不碰会话状态**：那是**读取命令**（`INV-FS-04`），
   * 授权集合 / 代次 / 当前文档 / 树缓存一个字节都不变 ⇒ 回来后不需要 `emit()`。
   *
   * @param {string} path 树里那一行的路径（原样，⛔ 不 trim、⛔ 不转义）
   * @returns {Promise<{path:string, is_dir:boolean}>} `path` 是**规范绝对路径**
   */
  async function revealEntry(path) {
    return T.call('reveal_entry', { path: path });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 授权命令（⭐ 只有这三个 + 启动参数能改授权）
  // ─────────────────────────────────────────────────────────────────────────

  /** 打开一个目录。用户取消时后端返回当前快照，界面什么都不变。 */
  async function chooseDirectory() {
    return applySnapshot(await T.call('choose_directory'));
  }

  /**
   * 打开一个单文件。
   *
   * ⚠️ 它**不切模式**、⛔ **不动 `roots`**（`design/0003` §2.1.4：要不要收回旧 root
   * 由 `open_document` 在**提交之后**当场判定）。这里只把文件加进授权并记下"接下来开它"。
   */
  async function chooseFile() {
    const snap = applySnapshot(await T.call('choose_file'));
    return snap;
  }

  /**
   * 收回目录授权（§2.1.4 第 ③ 步）。
   *
   * ⚠️ 它会让 `root_generation += 1`，所以**只能在正文提交之后**调——
   * 提前调会让刚拿到的那份正文被版本检查判为陈旧。
   */
  async function closeDirectory() {
    return applySnapshot(await T.call('close_directory'));
  }

  /**
   * ⭐ 进入一个**后端记过的**目录（`design/0038` §2.4）——启动页点一行 / 侧边栏
   * 「上次的目录」都走这里，**⛔ 不弹系统面板**。
   *
   * ⚠️ 白名单判定**完全在后端**（`open_recent_directory`）：前端递的 `root` 只是个
   *    **候选串**，后端逐字比对 `dir_sessions` 的键与 `last_directory`，然后再
   *    `canonicalize` + 与记录值比较。⛔ 前端**不许**先自己过滤一遍"这行还存不存在"——
   *    那是第二份判据，而它分叉的表现是"明明记着却点不进去"。
   * ⚠️ 拒绝（`NotAuthorized` / `NotFound`）会 **throw**，由调用方决定怎么告知用户
   *    （`INV-START-07`：失败必须可见）。
   */
  async function openRecentDirectory(root) {
    return applySnapshot(await T.call('open_recent_directory', { root: root }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ⭐ 收藏（`design/0043` §2.2 / §2.8）
  //
  // ⚠️ 载荷是**一条命令 + 操作枚举**（`favorites_apply(op)`），⛔ 前端不提交整份列表：
  //    "改哪一项"由用户动作决定、"其它项是什么"由后端当刻状态决定。
  // ⚠️ 但**后端有序不等于前端不会被旧快照覆盖**（复评 §3）⇒ 这一层还欠三件事：
  //    ① 发送**串行**（一个回包到了才发下一个）；② 上移/下移的目标下标在**队首执行时**
  //    现算；③ 回包**只取 `favorites` 一个字段**，并丢弃旧号 / 旧代次的回包。
  // ─────────────────────────────────────────────────────────────────────────

  /** 收藏操作的请求号（⭐ 第五个计数器，理由与其他四个逐字相同：另一个目标的生命周期）。 */
  let favReq = 0;
  /** 已经提交进 `state.favorites` 的最大请求号（迟到回包的判据之一）。 */
  let favApplied = 0;
  /** 串行队列：⚠️ 一次失败只断那一环，后面的操作照常排。 */
  let favChain = Promise.resolve();

  function favoriteSnapshot() { return state.favorites.slice(); }

  /**
   * 把一次收藏操作排进串行队列（**唯一的写入口**）。
   *
   * @param {function():({op:object}|{applied:false, reason:string})} build
   *   ⚠️ 它在**队首真正轮到时**才执行 ⇒ 上移/下移的 `to` 算在**最新**的 `state.favorites`
   *   上（§2.8「目标在最新快照上算」）。参数为 `{applied:false}` = 本地就判定无操作，
   *   **不发 IPC**（例如已经在首行还要上移）。
   * @returns {Promise<{applied:boolean, reason:string|null, favorites:string[]}>}
   *   ⚠️ 后端拒绝（未授权 / 达上限 / 写盘失败）会 **throw**，由调用方做可见提示。
   */
  function enqueueFavorite(build) {
    const req = ++favReq;
    const generation = state.generation;
    const run = favChain.then(async function () {
      const step = build();
      if (!step || !step.op) {
        return { applied: false, reason: (step && step.reason) || 'noop', favorites: favoriteSnapshot() };
      }
      const snap = await T.call('favorites_apply', { op: step.op });
      // ⭐ 迟到回包：旧号（理论上串行队列里不会出现，但结构上留一道）或**代次已经变了**
      //    （切根 / 打开文档之后）⇒ 整份丢弃：⛔ 不改状态、⛔ 不报错。
      if (req <= favApplied) return { applied: false, reason: 'stale', favorites: favoriteSnapshot() };
      if (generation !== state.generation) return { applied: false, reason: 'gen', favorites: favoriteSnapshot() };
      favApplied = req;
      // ⭐ **只提交收藏字段**：⛔ 不对这份回包 `applySnapshot`——它是整份 `SessionSnapshot`，
      //    无条件套上去会把"这期间已经切换的会话状态"带回来（复评 §3 点名的失败形态）。
      state.favorites = Array.isArray(snap && snap.favorites) ? snap.favorites.slice() : [];
      emit();
      return { applied: true, reason: null, favorites: favoriteSnapshot() };
    });
    // ⚠️ 队列**不因一次失败就断**：成功/失败都只推进队列，调用方拿到的仍是原始 Promise。
    favChain = run.then(function () {}, function () {});
    return run;
  }

  /** 收藏一项（后端会先过 `check_readable`，⛔ 前端不判可达性）。 */
  function addFavorite(path) {
    return enqueueFavorite(function () { return { op: { kind: 'add', path: path } }; });
  }

  /** 取消收藏（缺项由后端当幂等成功）。 */
  function removeFavorite(path) {
    return enqueueFavorite(function () { return { op: { kind: 'remove', path: path } }; });
  }

  /** 树行 / 根头的「收藏 ⇄ 取消收藏」：**判断也在队首执行时**做，避免两次点击互相打架。 */
  function toggleFavorite(path) {
    return enqueueFavorite(function () {
      return { op: { kind: state.favorites.indexOf(path) >= 0 ? 'remove' : 'add', path: path } };
    });
  }

  /**
   * 上移 / 下移一位（`delta` = `-1` / `+1`）。
   * ⚠️ 边界（首行上移 / 末行下移）**本地就判无操作**：后端也允许这种无操作成功，
   *    但少发一趟 IPC，也免得"点了一下什么都没变"看起来像没响应。
   */
  function moveFavorite(path, delta) {
    return enqueueFavorite(function () {
      const from = state.favorites.indexOf(path);
      if (from < 0) return { applied: false, reason: 'missing' };
      const to = from + (delta < 0 ? -1 : 1);
      if (to < 0 || to >= state.favorites.length) return { applied: false, reason: 'edge' };
      return { op: { kind: 'move', path: path, to: to } };
    });
  }

  /** 这一项现在收藏着吗（菜单文案用；⚠️ 只读，⛔ 不据此向后端断言什么）。 */
  function isFavorite(path) { return state.favorites.indexOf(path) >= 0; }

  /**
   * ⭐ **打开一条收藏**（`design/0043` §2.4，`INV-FS-04` 的**第五处**授权写入点）。
   *
   * ⚠️ 白名单与目标复核**完全在后端**（`open_favorite`）：前端只递**记录里的原串**
   *    （`INV-FAV-03` 要逐字命中），⛔ 不拼路径、⛔ 不先规范化、⛔ 不自己判存在性——
   *    那是第二份判据，分叉的表现是"明明收藏着却点不进去"。
   * ⚠️ 它回的是整份快照 ⇒ 这条路上**该**走 `applySnapshot`（那是一次真正的打开：
   *    根 / 代次 / `startup_document` 都可能变）。
   */
  async function openFavorite(path) {
    return applySnapshot(await T.call('open_favorite', { path: path }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ⭐ 最近目录的删除（`design/0045`，隐私：「最近打开的目录也可以清空，删除」）
  //
  // ⚠️ 与收藏那条写者逐条同形（§2.8 的三件事）：**串行**、回包**只吃 `recent` 与
  //    `last_directory` 两个字段**、旧号 / 旧代次的回包**直接丢**。
  // ⚠️ 为什么单独一条队列而不是复用 `favChain`：两者改的是 `config.json` 的**不同键**，
  //    共用队列只会让"清空最近"排在"收藏"后面白等；而**各自串行**就足够——
  //    后端每次都在**候选配置**上应用并整份保存，两条队列交错也丢不了更新。
  // ⚠️ 这两条动作⛔ **不删磁盘上的任何东西**、⛔ 不动授权、⛔ 不动收藏。
  // ─────────────────────────────────────────────────────────────────────────

  /** 最近目录操作的请求号（第六个计数器）。 */
  let recentReq = 0;
  /** 已经提交进 `state.recent` 的最大请求号。 */
  let recentApplied = 0;
  /** 串行队列：一次失败只断那一环，后面的操作照常排。 */
  let recentChain = Promise.resolve();

  /**
   * 把一次"最近目录"操作排进串行队列（**唯一的写入口**）。
   *
   * @param {function():object} build 返回 `{op}`（`{kind:'remove',path}` / `{kind:'clear'}`）
   * @returns {Promise<{applied:boolean, reason:string|null}>}
   *   ⚠️ 后端拒绝（写盘失败）会 **throw**，由调用方做可见提示。
   */
  function enqueueRecent(build) {
    const req = ++recentReq;
    const generation = state.generation;
    const run = recentChain.then(async function () {
      const step = build();
      const snap = await T.call('recent_apply', { op: step.op });
      if (req <= recentApplied) return { applied: false, reason: 'stale' };
      if (generation !== state.generation) return { applied: false, reason: 'gen' };
      recentApplied = req;
      // ⭐ **只提交这两个字段**：⛔ 不对这份回包 `applySnapshot`——它带着根 / 代次 /
      //    当前文档，无条件套上去会把"这期间已经切换的会话状态"带回来。
      //    ⚠️ `last_directory` 必须一起更新：侧边栏「打开上次的目录」读的就是它，
      //    只清 `recent` 会让那句提示指向一个"已经删掉的历史"。
      state.recent = Array.isArray(snap && snap.recent) ? snap.recent.slice() : [];
      state.lastDirectory = (snap && snap.last_directory) || null;
      emit();
      return { applied: true, reason: null };
    });
    recentChain = run.then(function () {}, function () {});
    return run;
  }

  /**
   * 从「最近的目录」里删掉一条。
   * ⚠️ 传的是**后端给的原串**（启动页那一行的 `root`）——后端逐字匹配，⛔ 不规范化。
   */
  function removeRecent(root) {
    return enqueueRecent(function () { return { op: { kind: 'remove', path: root } }; });
  }

  /** 清空整份「最近的目录」（含 `last_directory`）。 */
  function clearRecent() {
    return enqueueRecent(function () { return { op: { kind: 'clear' } }; });
  }

  /** 侧边栏宽度（唯一的配置写入点；⛔ 不碰授权）。 */
  async function setSidebarWidth(width) {
    state.sidebarWidth = await T.call('set_sidebar_width', { width });
    emit();
    return state.sidebarWidth;
  }

  /** 读一张图片/附件（路径由**后端**用 `doc_dir` 解析，前端只递原始 `src`）。 */
  async function readAsset(src) {
    const generation = state.generation;
    // ⚠️ `req` 用**文档**那一个：图片是正文的一部分，不参与树的并发。
    return T.call('read_asset', { src, generation, req: state.latestReq });
  }

  /**
   * ⭐ **打开文档内的一条链接**（`design/0026` §2.2 ③）——薄封装，判据全在别处。
   *
   * ⚠️ 前端只递 **`href` 原文**（`getAttribute('href')` 那个）＋ **`doc_seq`**：
   *    ⛔ 不递路径、⛔ 不递基准目录——那两样只有后端拿得到（`INV-LINK-03`）。
   * ⚠️ `doc_seq` 由调用方在**点击那一刻**取好并原样带回：后端在**读 `doc_dir` 的同一把锁**
   *    里核对它（`INV-LINK-11`），对不上就回 `stale` 且**什么都不做**。
   * @returns {Promise<object>} `{kind, href, path?, fragment?, message?}`（见 `commands/link.rs`）
   */
  async function openLink(href, docSeq) {
    return T.call('open_link', { href: href, doc_seq: docSeq });
  }

  const api = {
    state,
    onChange,
    current,
    refresh,
    // ⭐ `design/0015`：Apple Event 队列的出口（读取命令，⛔ 不改授权）
    takePendingOpen,
    openDocument,
    listDir,
    // `design/0009`
    searchFiles,
    currentSearch,
    // ⭐ `design/0041`：文档列表（**读取命令**，与搜索共用同一份索引）
    listDocuments,
    currentDocList,
    setSidebarFileView,
    chooseDirectory,
    chooseFile,
    closeDirectory,
    // ⭐ `design/0038`：进入**后端记过的**目录（`INV-FS-04` 的第四处授权写入点）。
    openRecentDirectory,
    // ⭐ `design/0043`：收藏（一条命令 + 操作枚举的串行写者）与它的打开入口
    //    （`open_favorite` 是 `INV-FS-04` 的**第五处**授权写入点）。
    addFavorite,
    removeFavorite,
    toggleFavorite,
    moveFavorite,
    isFavorite,
    openFavorite,
    // ⭐ `design/0045`：最近目录的删除 / 清空（**只写 `config.json`** 的那两个键，
    //    ⛔ 不删磁盘、⛔ 不改授权）。走**独立**的串行队列，只提交 `recent` + `last_directory`。
    removeRecent,
    clearRecent,
    setSidebarWidth,
    readAsset,
    // ⭐ `design/0026`：文档内链接（⛔ 不改授权；可能派发系统浏览器 / Finder）
    openLink,
    // `design/0006`
    watchDocument,
    unwatchDocument,
    noteDroppedEvent,
    reloadDocument,
    // ⭐ `design/0012` §3.2：编辑面的四个 IPC 薄封装。
    //    ⚠️ §3.2 那张表当时只列了**两个**（`begin_edit` / `save_document`）——
    //       `end_edit` 与 `render_preview` 是实施时补的，理由写在那两个函数上方。
    //    ⚠️ 它们**只是转发**：判据（脏不脏 / 第几档 / 陈旧）一律不在这一层
    //       （与前面几个封装同一条纪律）。
    beginEdit,
    endEdit,
    renderPreview,
    saveDocument,
    // ⭐ `design/0017`：阅读进度（**只写 `config.json`**，⛔ 不改授权）。
    setReadingProgress,
    // ⭐ `design/0020`：目录会话（同上，**只写 `config.json`**）。
    setDirSession,
    // ⭐ `design/0034`：新建文件 / 目录（**写入命令**；名字与父目录的判据全在后端）。
    createEntry,
    // ⭐ `design/0035`：重命名普通 `.md` 文件（同上；⛔ 不动授权、⛔ 不换目录）。
    renameEntry,
    // ⭐ `design/0048`：在访达中显示（**读取命令**——⛔ 不新增可读路径、⛔ 不写盘）。
    revealEntry,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).session = api;
})();
