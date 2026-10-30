// rmd · **根头（`design/0044`）＋ 启动页收藏段（`design/0043`）**的真 DOM 离屏探针。
//
// # 为什么这两件事必须进探针（纯逻辑单测到不了）
//
// 0044 的失效形态是**结构性的**：根头和原树若共用一个容器，
// `FileTree.commitRefresh` 的 `textContent = ''` 会把根头**删掉**、
// `openInput` 的 `insertBefore(host.firstChild)` 会把新建输入行**顶到根头上面**。
// 这两件事在源码里都只差一个变量名（`host` vs `host.parentNode`），
// `tests/js/favorites-rootheader.test.js` 只能核对"写的是哪个"，**跑不出**行为。
//
// 0043 的失效形态是**顺序性的**：两段编号随条数漂移（按 `2` 打开的是另一条）、
// 焦点在两张表之间走不动、`Escape` 把焦点丢给 `body`、失效行再也操作不了。
// 这些都要真 DOM ＋ 真事件。
//
// ⭐ 跑的是**产品那几份**，原样拷进页面（⛔ 探针不抄第二份实现）：
//    `components/{Sidebar,FileTree,StartScreen}.js`
//    ＋ `services/{i18n,versions,chunked,dirsession,tauri,search,keymap,session,start,treerefresh,clipboard}.js`。
//    `main.js` 那层接线不进探针页，本探针**不镜像**它——只按 `main.js` 的**调用顺序**驱动公开行为。
//
// ⚠️ 假后端只下沉到 `window.__TAURI__.core.invoke`：只有"磁盘里有什么"是假的，
//    `session.js` 的提交判据、`FileTree` 的刷新事务、`Sidebar` 的显隐、`StartScreen` 的键盘模型全都真跑。
// ⚠️ 离屏安全形态：只改**自己页面里的 DOM**、只在页面内 `dispatchEvent` / `click()`
//    （不可信事件，⛔ 不点亮任何系统级输入）；窗口由 `.swift` 那边 `alphaValue = 0` ＋ `orderBack` 建成。
// ⚠️ 剪贴板同样是**记账桩子**（菜单里那一项本探针不点，但换掉它才能保证一次都不碰真的）。
//
// 约定：`window.__RUN()` 返回 `{环境, 夹具, 检查, 结论}`；判据在**退出码**上（`.sh` 聚合）。
(function () {
  'use strict';

  // ⚠️ file:// 下 WebKit 只报一句 "Script error."（没有文件名/行号）⇒ 自己把栈留下，
  //    否则"harness 没跑起来"会与"某份产品脚本没加载"长得一模一样。
  try {

  const S = window.rmd.session;
  const CLIP = window.rmd.clipboard;
  const FT = window.rmd.fileTree;
  const SB = window.rmd.sidebar;
  const SS = window.rmd.startScreen;
  const I18N = window.rmd.i18n;
  const t = I18N ? I18N.t : function (k) { return k; };

  const ROOT = '/probe/wiki';
  const OTHER = '/probe/other';
  const $ = function (id) { return document.getElementById(id); };

  const host = $('tree-host');
  const header = $('tree-root-header');
  const wrap = document.querySelector('.tree-root-wrap');

  // ── 假文件系统：只有「磁盘里有什么」是假的 ─────────────────────────────
  const FS = Object.create(null);
  /**
   * ⭐ **后端 `TreeCache` 的行为模拟**（`design/0039` §2.1 ＋ `design/0050` §2.2.4：
   * 键 = (代次, **磁盘内容修订（纪元）**, 规范化路径)）。
   *
   * ⚠️⚠️ 这一份是**判据 12 的前提**，⛔ 别当成多余的复杂度：真实后端在 `fresh: false` 时
   * **命中旧层直接返回**（`commands/fs.rs::list_dir_three_stage` 的 `First::Cached`），
   * 而"目录里多了一个文件"**不动代次**。假后端若每次都回当前 `FS`，
   * 那「刷新事务忘了带 `fresh`」这条缺陷在这里就**永远看不见**——
   * 2026-10-27 用户实测「其他程序在目录里加了一个文档，目录树里没展示」正是从那个缺口漏出去的。
   *
   * ⭐ `design/0050` 起键里多一个**纪元**分量：磁盘内容真的变了（`bumpEpoch()`，对应后端
   * `disk::reaction` 推高 `revision`）⇒ 旧纪元那一层**命中不到**，即便调用方忘了 `fresh`。
   * ⇒ `design/0050` §7.5 的两条变异因此是**一正一反**：
   *   · `M10`（`fresh` 打回 `false`）现在**必须仍绿**——由红转绿，证明兜底不是"恰好绿"；
   *   · `M11`（纪元**不前进** ＋ `fresh: false`）**必须红**——证明 `M1` 的栅栏真在承重。
   * ⛔ 别把 `bumpEpoch()` 加进"经产品新建入口"的路径：那条路本来就是 `fresh: true`，
   * 加了只会让 `M11` 失去意义。
   */
  const TREE_CACHE = Object.create(null);
  let cacheEpoch = 1;
  function cacheKey(gen, p) { return cacheEpoch + '\u0000' + gen + '\u0000' + p; }
  /** ⭐ 磁盘内容变了（**外部程序**写的）⇒ 纪元前进。对应 `disk.rs` 的 `revision`。 */
  function bumpEpoch() { cacheEpoch += 1; }
  function ensureDir(p) { if (!FS[p]) FS[p] = []; return p; }
  function add(parent, name, isDir, ignored) {
    ensureDir(parent);
    const path = parent + '/' + name;
    FS[parent].push({ path: path, name: name, is_dir: !!isDir, ignored: !!ignored });
    if (isDir) ensureDir(path);
    return path;
  }
  function buildFixture() {
    for (const k in FS) delete FS[k];
    // ⚠️ 夹具换了 ⇒ 后端那份缓存也必须换（判据 12 的模拟缓存，见 `TREE_CACHE`）。
    for (const k in TREE_CACHE) delete TREE_CACHE[k];
    ensureDir(ROOT);
    add(ROOT, 'a.md', false);
    add(ROOT, 'b.md', false);
    const docs = add(ROOT, 'docs', true);
    add(docs, 'x.md', false);
    const deep = add(docs, 'deep', true);
    add(deep, 'y.md', false);
    add(ROOT, 'vendor', true, true);
    ensureDir(OTHER);
    add(OTHER, 'other.md', false);
  }
  buildFixture();

  // ── 假 IPC ────────────────────────────────────────────────────────────
  /** ⚠️ 每条判据前都按这份重建（`fresh()`），否则 B3 那种"清空最近"会漏到下一条。 */
  function defaultRecent() {
    return [
      { root: '/Users/liubo/workspace/rmd', last_file: null, updated_at: 9, last: true },
      { root: '/opt/notes', last_file: 'README.md', updated_at: 5, last: false },
    ];
  }
  const FAKE = {
    root: ROOT,
    gen: 1,
    favorites: ['/Users/liubo/中文目录', '/opt/docs'],
    recent: defaultRecent(),
    /** ⭐ `design/0045`：`last_directory` 也归后端（`recent_apply` 会把它一起清掉）。 */
    lastDirectory: ROOT,
    /** `list_dir` 失败的那个路径（判据 6 用；`null` = 都读得出来）。 */
    unreadable: null,
  };

  const calls = Object.create(null);
  function bump(cmd) { calls[cmd] = (calls[cmd] || 0) + 1; }

  function snapshot(mode) {
    return {
      generation: FAKE.gen,
      mode: mode || 'directory',
      roots: [FAKE.root],
      files: [],
      pending_directory: null,
      startup_document: null,
      sidebar_width: 280,
      last_directory: FAKE.lastDirectory,
      reading_progress: {},
      doc_seq: 0,
      dir_session: null,
      // ⚠️ 两个列表都从这一份快照来（`INV-START-05`）：⛔ 探针不给第二条来源。
      recent: FAKE.recent,
      favorites: FAKE.favorites,
    };
  }

  function copyEntry(e) {
    return { path: e.path, name: e.name, is_dir: e.is_dir, ignored: e.ignored };
  }

  function fakeInvoke(cmd, args) {
    bump(cmd);
    const a = args || {};
    const st = S && S.state ? S.state : { generation: 1 };
    if (cmd === 'get_session') return Promise.resolve(snapshot());
    if (cmd === 'list_dir') {
      if (FAKE.unreadable && a.path === FAKE.unreadable) {
        return Promise.reject({ kind: 'io', path: a.path, message: 'probe 故意的读盘失败' });
      }
      const list = FS[a.path];
      if (!list) {
        return Promise.reject({ kind: 'not_found', path: a.path, message: 'probe 里没有 ' + a.path });
      }
      // ⭐ 缓存语义照后端：`fresh` ⇒ 作废重扫；否则命中就用**当时那一份**（见 `TREE_CACHE`）。
      const key = cacheKey(st.generation, a.path);
      if (!a.fresh && TREE_CACHE[key]) {
        bump('list_dir:cached');
        return Promise.resolve({ gen: st.generation, req: a.req, entries: TREE_CACHE[key].map(copyEntry) });
      }
      bump('list_dir:scan');
      TREE_CACHE[key] = list.map(copyEntry);
      return Promise.resolve({ gen: st.generation, req: a.req, entries: list.map(copyEntry) });
    }
    if (cmd === 'set_dir_session') return Promise.resolve({ status: 'ok', entry: null, evicted: [] });
    // ⭐ `design/0045`：最近目录的删除 / 清空。⚠️ 语义照后端
    //    （`commands/mod.rs::apply_recent_op`）：**逐字**命中才删，且删/清都要
    //    把 `last_directory` 一起清掉——否则 `recent_dirs()` 会把它重新插回队首。
    if (cmd === 'recent_apply') {
      const op = a.op || {};
      if (op.kind === 'clear') {
        FAKE.recent = [];
        FAKE.lastDirectory = null;
      } else if (op.kind === 'remove') {
        const before = FAKE.recent.length;
        FAKE.recent = FAKE.recent.filter(function (r) { return r.root !== op.path; });
        if (FAKE.recent.length !== before && FAKE.lastDirectory === op.path) FAKE.lastDirectory = null;
      }
      return Promise.resolve(snapshot());
    }
    // ⚠️ 其余一律显式拒：静默 resolve 会让"接错了命令名"永远查不出来。
    return Promise.reject({ kind: 'not_found', message: 'probe 没实现命令 ' + cmd });
  }

  window.__TAURI__ = { core: { invoke: fakeInvoke } };

  // ── 假剪贴板（菜单里那一项不点，但保底**一次都不碰真剪贴板**）─────────
  CLIP.defaultCopier = function () {
    return CLIP.createCopier({
      win: { isSecureContext: false, navigator: {} },
      doc: document,
      env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: false },
    });
  };

  // ── 装配（顺序照 `main.js`）──────────────────────────────────────────
  const log = {
    opened: [],
    openedFavorite: [],
    unfavorite: [],
    move: [],
    errors: [],
    rootMenu: [],
    // ⭐ `design/0045`：最近目录的两条"忘掉历史"（清空那张表按次数数）
    forget: [],
    clear: [],
  };

  const els = {
    sidebar: $('sidebar'),
    tabTree: $('tab-tree'),
    tabToc: $('tab-toc'),
    paneTree: $('pane-tree'),
    paneToc: $('pane-toc'),
    paneDoclist: $('pane-doclist'),
    paneSearch: $('pane-search'),
    searchBar: $('sidebar-search'),
    resizer: $('sidebar-resizer'),
    collapseBtn: $('btn-collapse'),
    expandBtn: $('btn-expand'),
    btnFileView: $('btn-file-view'),
    treeHost: host,
    treeRootHeader: header,
    treeRootName: header.querySelector('.tree-root-name'),
    treeRootIcon: header.querySelector('.node-icon'),
    treeRootMore: $('tree-root-more'),
  };

  const tree = FT.createFileTree({
    host: host,
    onOpenFile: function () {},
    onError: function () {},
    onStateChange: function () {},
    onUserToggle: function () {},
    getEditorState: function () { return { editing: false, dirty: false }; },
    isFavorite: function (p) { return S.isFavorite(p); },
    onToggleFavorite: function (p) { log.toggled = (log.toggled || []).concat([p]); },
  });

  const sidebar = SB.createSidebar({
    els: els,
    tree: tree,
    onTabChange: function () {},
    onToggleFileView: function () {},
    onChooseDirectory: function () {},
    onRootMenu: function (at) {
      log.rootMenu.push({ x: at.x, y: at.y, hasReturnFocus: typeof at.returnFocus === 'function' });
      tree.openRootMenu(at.x, at.y, { returnFocus: at.returnFocus });
    },
  });

  const screen = SS.createStartScreen({
    onOpen: function (root) { log.opened.push(root); return Promise.resolve(); },
    onOpenFavorite: function (p) {
      log.openedFavorite.push(p);
      const fail = log.failNextFavorite;
      log.failNextFavorite = null;
      return fail ? Promise.reject({ kind: 'not_found', path: p }) : Promise.resolve();
    },
    onUnfavorite: function (p) { log.unfavorite.push(p); return Promise.resolve(); },
    onMoveFavorite: function (p, d) { log.move.push([p, d]); return Promise.resolve(); },
    // ⭐ `design/0045`：两条"忘掉这条历史"的接线，照 `main.js::forgetRecentFromUi`
    //    / `clearRecentFromUi` 的顺序——**调后端 → 成功后重画启动页**。
    //    ⚠️ 走的是**产品那份** `session.js` 的写者（串行队列 + 只吃两个字段）。
    onForgetRecent: function (root) {
      log.forget.push(root);
      return S.removeRecent(root).then(function (r) { mountStart(); return r; });
    },
    onClearRecent: function () {
      log.clear.push(Date.now());
      return S.clearRecent().then(function (r) { mountStart(); return r; });
    },
    onError: function (e, target) { log.errors.push({ kind: e && e.kind, target: target }); },
    overlayOpen: function () { return false; },
  });

  // ── 观察工具（⛔ 不是产品判据）────────────────────────────────────────
  function tick(n) {
    let p = Promise.resolve();
    for (let i = 0; i < (n || 1); i++) {
      p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
    }
    return p;
  }

  function menuEl() { return document.querySelector('.tree-menu'); }
  function menuItems() {
    const m = menuEl();
    return m ? Array.prototype.slice.call(m.querySelectorAll('.tree-menu-item')) : [];
  }
  function menuLabels() { return menuItems().map(function (b) { return b.textContent; }); }
  function startMenuEl() { return document.querySelector('.start-menu'); }
  function startMenuItems() {
    const m = startMenuEl();
    return m ? Array.prototype.slice.call(m.querySelectorAll('.start-menu-item')) : [];
  }
  function nodeByPath(p) {
    const all = host.querySelectorAll('.node');
    for (let i = 0; i < all.length; i++) if (all[i].dataset.path === p) return all[i];
    return null;
  }
  function rowByPath(p) {
    const n = nodeByPath(p);
    return n ? n.firstElementChild : null;
  }
  function depths() {
    return Array.prototype.slice.call(host.querySelectorAll('.node')).map(function (n) {
      return Number(n.dataset.depth);
    });
  }
  function key(target, name, mods) {
    const m = mods || {};
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: name, bubbles: true, cancelable: true,
      shiftKey: !!m.shift, metaKey: !!m.meta, ctrlKey: !!m.ctrl, altKey: !!m.alt,
    }));
  }
  function rightClickAt(el, x, y) {
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x || 40, clientY: y || 50,
    }));
  }
  function startRows() {
    return Array.prototype.slice.call(document.querySelectorAll('.start-fav-row'));
  }
  function recentRows() {
    const list = document.querySelector('.start-list:not(.start-fav-list)');
    return list ? Array.prototype.slice.call(list.querySelectorAll('.start-row')) : [];
  }

  /** 每条判据前重建：树 + 根头 + 启动页 + 菜单，全部回到"刚打开一个目录"。 */
  async function fresh() {
    FAKE.root = ROOT;
    FAKE.gen = 1;
    FAKE.unreadable = null;
    FAKE.favorites = ['/Users/liubo/中文目录', '/opt/docs'];
    FAKE.recent = defaultRecent();
    FAKE.lastDirectory = ROOT;
    buildFixture();
    tree.reset(null);
    document.querySelectorAll('.tree-menu, .start-menu').forEach(function (n) { n.remove(); });
    screen.clear();
    const doc = $('doc');
    if (doc) doc.textContent = '';
    await S.refresh();
    await tree.showRoot(ROOT);
    sidebar.setRootHeader(ROOT);
    sidebar.setFileView('tree');
    sidebar.setTab('tree');
    log.opened.length = 0;
    log.openedFavorite.length = 0;
    log.unfavorite.length = 0;
    log.move.length = 0;
    log.errors.length = 0;
    log.rootMenu.length = 0;
    log.forget.length = 0;
    log.clear.length = 0;
    log.failNextFavorite = null;
  }

  // ── 判据记录的公共形状 ──────────────────────────────────────────────
  const checks = [];
  function rec(id, name, ok, criterion, value) {
    checks.push({ id: String(id), 名: name, 结果: ok ? '通过' : '失败', 判据: criterion, 值: value });
  }

  // ════════════════════════════════════════════════════════════════════
  // 1–9 · 根头（`design/0044`）
  // ════════════════════════════════════════════════════════════════════

  // 1：根头在、名字对、且**不是** `#tree-host` 的孩子
  async function c1() {
    await fresh();
    const kids = tree.nodeCount();
    const ok = header.hidden === false &&
      header.dataset.root === ROOT &&
      els.treeRootName.textContent === 'wiki' &&
      header.title === ROOT.replace(/^\/Users\/[^/]+/, '~') &&
      header.parentNode === wrap &&
      !host.contains(header) &&
      wrap.children[0] === header && wrap.children[1] === host &&
      kids > 0;
    return {
      ok: ok,
      criterion: '根头可见 ∧ data-root = 当前根 ∧ 名字 = 最后一段 ∧ 它是 `#tree-host` 的**兄弟**（在树之前）',
      value: {
        hidden: header.hidden, dataRoot: header.dataset.root, title: header.title,
        名字: els.treeRootName.textContent, 父节点: header.parentNode && header.parentNode.className,
        在树里: host.contains(header), wrap子节点: Array.prototype.map.call(wrap.children, function (n) { return n.id; }),
        节点数: kids,
      },
    };
  }

  // 2：**重新列根层**（就是 `showRoot` 那句 `host.textContent = ''`）之后根头还在
  async function c2() {
    await fresh();
    const before = { hidden: header.hidden, root: header.dataset.root };
    await tree.showRoot(ROOT, true);            // ← 事务里第一句就是 `host.textContent = ''`
    await tree.refreshVisible();                // ← 走刷新事务（离屏构建 + 原子换上去）
    const ok = header.isConnected &&
      header.hidden === false &&
      header.dataset.root === ROOT &&
      header.parentNode === wrap &&
      tree.nodeCount() > 0 &&
      before.hidden === false;
    return {
      ok: ok,
      criterion: '`showRoot(fresh)` 与 `refreshVisible()` 都把 `#tree-host` 清空重画 ⇒ 根头**仍在**、属性不变、树也重画了',
      value: { 连接在文档里: header.isConnected, hidden: header.hidden, dataRoot: header.dataset.root,
        父节点: header.parentNode && header.parentNode.className, 节点数: tree.nodeCount(), 之前: before },
    };
  }

  // 3：**新建输入行的落点**——必须进 `#tree-host`，且排在根头**之后**（⛔ 不许顶到根头上面）
  async function c3() {
    await fresh();
    // 走真实链路：`⋯` → Sidebar 报坐标 → FileTree 开菜单 → 点「新建文件」
    els.treeRootMore.click();
    await tick(1);
    const items = menuItems();
    const newFile = items.filter(function (b) { return b.textContent === t('tree.menu.new-file'); })[0];
    if (!newFile) {
      return { ok: false, criterion: '根头菜单里必须有「新建文件」', value: { 菜单项: menuLabels() } };
    }
    newFile.click();
    await tick(1);
    const row = host.querySelector('.tree-input-row');
    const inputEl = host.querySelector('.tree-input');
    const pos = header.compareDocumentPosition(row || document.createElement('span'));
    const FOLLOWING = 4;
    const ok = !!row && !!inputEl &&
      host.contains(row) &&
      row.parentNode === host &&            // 根层 ⇒ 直接挂在 `#tree-host` 里
      host.firstElementChild === row &&     // 插在层首，但在**树容器内部**
      (pos & FOLLOWING) !== 0 &&
      header.hidden === false;
    // 收尾：让输入行自己关掉（⛔ 别把状态带到下一条判据）
    if (inputEl) key(inputEl, 'Escape');
    await tick(1);
    return {
      ok: ok,
      criterion: '根头「新建文件」⇒ 输入行在 `#tree-host` **内部**（根层首行）∧ 文档序在根头**之后** ∧ 根头仍可见',
      value: {
        有输入行: !!row, 有输入框: !!inputEl,
        父节点: row && row.parentNode && (row.parentNode.id || row.parentNode.className),
        容器首子: host.firstElementChild && (host.firstElementChild.className || host.firstElementChild.id),
        在根头之后: (pos & FOLLOWING) !== 0, 根头可见: header.hidden === false,
        收尾关掉了: !host.querySelector('.tree-input-row'),
      },
    };
  }

  // 4：换根 ⇒ 根头跟着换（名字/属性），不残留旧根
  async function c4() {
    await fresh();
    FAKE.root = OTHER;
    FAKE.gen = 2;
    await S.refresh();
    await tree.showRoot(OTHER);
    sidebar.setRootHeader(OTHER);
    const ok = header.hidden === false &&
      header.dataset.root === OTHER &&
      els.treeRootName.textContent === 'other' &&
      nodeByPath(OTHER + '/other.md') !== null &&
      nodeByPath(ROOT + '/a.md') === null;
    return {
      ok: ok,
      criterion: '换根 ⇒ 根头的 `data-root`／名字换成新根 ∧ 树里只剩新根的内容',
      value: { dataRoot: header.dataset.root, 名字: els.treeRootName.textContent,
        新根有节点: !!nodeByPath(OTHER + '/other.md'), 旧根残留: !!nodeByPath(ROOT + '/a.md') },
    };
  }

  // 5：空态（裸跑/关掉目录）⇒ 根头藏起来，提示框画进 `#tree-host`
  async function c5() {
    await fresh();
    sidebar.showEmpty('拖一个文件进来');
    const note = host.querySelector('.unauth');
    const ok = header.hidden === true &&
      header.isConnected &&                     // ⛔ 不是被删掉，是隐藏
      header.dataset.root === undefined &&
      header.title === '' &&
      !!note && host.contains(note) &&
      note.textContent.indexOf('拖一个文件进来') >= 0 &&
      wrap.children[0] === header;
    return {
      ok: ok,
      criterion: '空态 ⇒ 根头 `hidden` ∧ 摘掉 data-root/title ∧ 提示框画在 `#tree-host` 里（根头没被删）',
      value: { hidden: header.hidden, 还在文档里: header.isConnected, dataRoot: header.dataset.root,
        title: header.title, 有提示: !!note, wrap子节点: wrap.children.length },
    };
  }

  // 6：读失败 / 未授权态 ⇒ 同样隐藏根头，状态框进 `#tree-host`
  async function c6() {
    await fresh();
    FAKE.unreadable = ROOT;
    const r = await tree.showRoot(ROOT, true);
    sidebar.showUnauthorized({ directory: ROOT, file: ROOT + '/a.md', filePath: ROOT + '/a.md' });
    const box = host.querySelector('[data-unauthorized]');
    const ok = header.hidden === true &&
      header.isConnected &&
      !!box && host.contains(box) &&
      r.ok === false;
    // 还原：下一条判据还要用一棵好树
    FAKE.unreadable = null;
    return {
      ok: ok,
      criterion: '根层读不出来 ＋ 未授权态 ⇒ 根头隐藏（仍留在文档里）∧ 状态框画在 `#tree-host` 里',
      value: { 读根结果: r, hidden: header.hidden, 在文档里: header.isConnected,
        有未授权框: !!box, 提示文本: host.textContent.slice(0, 80) },
    };
  }

  // 7：树 / 列表切换 ⇒ 根头与树都**不卸载**（`0041` 的 R4/R5 同一条纪律）
  async function c7() {
    await fresh();
    const before = tree.nodeCount();
    const expandedBefore = tree.expandedPaths().length;
    sidebar.setFileView('list');
    const listState = { hidden: header.hidden, 在树里: !!nodeByPath(ROOT + '/a.md') };
    sidebar.setFileView('tree');
    const ok = listState.hidden === false &&
      !!nodeByPath(ROOT + '/a.md') &&
      tree.nodeCount() === before &&
      tree.expandedPaths().length === expandedBefore &&
      header.parentNode === wrap;
    return {
      ok: ok,
      criterion: '切到列表再切回来 ⇒ 根头始终可见 ∧ 树节点一个不少（切换只改 `hidden`，⛔ 不卸载）',
      value: { 列表态根头hidden: listState.hidden, 列表态树还在: listState.在树里,
        节点数: { 前: before, 后: tree.nodeCount() }, 展开数: tree.expandedPaths().length },
    };
  }

  // 8：`⋯` 与根头右键**同一份动作清单**（含白名单：⛔ 无重命名/删除）
  async function c8() {
    await fresh();
    els.treeRootMore.click();
    await tick(1);
    const viaMore = menuLabels();
    const moreFocus = log.rootMenu.map(function (x) { return x.hasReturnFocus; });
    tree.reset(null);                       // 关菜单（`reset` 里会 closeMenu）
    await tree.showRoot(ROOT);
    sidebar.setRootHeader(ROOT);
    log.rootMenu.length = 0;                // ⚠️ 两路各看一次，别把上一路的记录带过来
    rightClickAt(header, 30, 40);
    await tick(1);
    const viaRight = menuLabels();
    const rightFocus = log.rootMenu.map(function (x) { return x.hasReturnFocus; });
    tree.reset(null);

    const expected = [
      t('tree.menu.new-file'), t('tree.menu.new-folder'),
      t('tree.menu.copy-path'), t('tree.menu.reveal'), t('tree.menu.favorite'),
      t('tree.menu.refresh'),
    ];
    // ⚠️ 全仓**没有**「移到废纸篓」这个键（那是 ⌘⌫，不是树菜单项）⇒ 这里只钉「重命名」，
    //    另外用中英两本字典里都存在的两个词根兜一下"有人新加了一个危险项"（见 `危险词`）。
    const banned = [t('tree.menu.rename')];
    const 危险词 = ['废纸篓', 'Trash', '删除', 'Delete'];
    const hasDanger = viaMore.some(function (s) {
      return 危险词.some(function (w) { return s.indexOf(w) >= 0; });
    });
    const ok = viaMore.length === expected.length &&
      viaMore.join('|') === expected.join('|') &&
      viaRight.join('|') === expected.join('|') &&
      banned.every(function (b) { return viaMore.indexOf(b) < 0; }) &&
      !hasDanger &&
      moreFocus.join(',') === 'true' && rightFocus.join(',') === 'true';
    return {
      ok: ok,
      criterion: '`⋯` 与根头右键 ⇒ **逐项相同**的菜单（新建文件/新建文件夹/复制路径/在访达中显示/收藏/刷新）∧ 无重命名/删除 ∧ 两路都带了 returnFocus',
      value: { '⋯': viaMore, 右键: viaRight, 期望: expected, 禁用项: banned, 有危险词: hasDanger,
        带returnFocus: { '⋯': moreFocus, 右键: rightFocus } },
    };
  }

  // 9：根头的键盘模型 —— `Shift+F10` 开菜单、`Escape` 把焦点**还给根头**
  async function c9() {
    await fresh();
    header.focus();
    const before = document.activeElement === header;
    key(header, 'F10', { shift: true });
    await tick(1);
    const opened = !!menuEl() && menuLabels().length > 0;
    key(menuEl() || document, 'Escape');
    await tick(1);
    const ok = before && opened &&
      !menuEl() &&
      document.activeElement === header;
    // Enter 也要开同一份菜单（根头是一行，不是按钮）
    key(header, 'Enter');
    await tick(1);
    const enterOpened = !!menuEl() && menuLabels().join('|') === [
      t('tree.menu.new-file'), t('tree.menu.new-folder'),
      t('tree.menu.copy-path'), t('tree.menu.reveal'), t('tree.menu.favorite'),
      t('tree.menu.refresh'),
    ].join('|');
    key(menuEl() || document, 'Escape');
    await tick(1);
    return {
      ok: ok && enterOpened && document.activeElement === header,
      criterion: '`Shift+F10` / `Enter` 都开同一份根头菜单 ∧ `Escape` 关掉后焦点**回到根头**（⛔ 掉到 body）',
      value: { 根头原本有焦点: before, ShiftF10开了菜单: opened,
        Escape后焦点在根头: document.activeElement === header,
        Enter开了同一份: enterOpened },
    };
  }

  // 10：**深度没有下压**——顶层仍是 0 层，根自己**不是**一个节点
  async function c10() {
    await fresh();
    const top = depths().slice(0, 4);
    const rootAsNode = nodeByPath(ROOT);
    const docsNode = nodeByPath(ROOT + '/docs');
    docsNode.firstElementChild.click();          // 展开 docs
    await tick(3);
    const childDepth = nodeByPath(ROOT + '/docs/x.md');
    const ok = top.join(',') === '0,0,0,0' &&        // a.md / b.md / docs / vendor
      rootAsNode === null &&
      !!childDepth && Number(childDepth.dataset.depth) === 1;
    return {
      ok: ok,
      criterion: '顶层四行的 `data-depth` 全是 `0` ∧ 根自己不是一个节点 ∧ 子层是 `1`（根头**不占一层**）',
      value: { 顶层深度: top, 根是节点吗: !!rootAsNode,
        子层深度: childDepth && childDepth.dataset.depth,
        全部深度: depths() },
    };
  }

  // 11：**展开态跨重建恢复**（`0020` 的 `restoreExpanded`）＋ 根头不受影响
  async function c11() {
    await fresh();
    nodeByPath(ROOT + '/docs').firstElementChild.click();   // 展开 docs
    await tick(3);
    const saved = tree.expandedPaths();
    // 换根再换回来（= 重新打开同一个目录），然后按记录恢复
    await tree.showRoot(OTHER);
    sidebar.setRootHeader(OTHER);
    FAKE.root = ROOT;
    FAKE.gen += 1;
    await S.refresh();
    await tree.showRoot(ROOT);
    sidebar.setRootHeader(ROOT);
    await tree.restoreExpanded(saved);
    await tick(3);
    const restored = nodeByPath(ROOT + '/docs');
    const ok = saved.indexOf(ROOT + '/docs') >= 0 &&
      !!restored &&
      restored.classList.contains('expanded') &&
      !!nodeByPath(ROOT + '/docs/x.md') &&
      header.hidden === false &&
      header.dataset.root === ROOT &&
      tree.nodeCount() > 0;
    return {
      ok: ok,
      criterion: '展开 docs ⇒ 换根再换回 ⇒ `restoreExpanded(快照)` 后 docs 仍展开、子项还在 ∧ 根头照旧可见',
      value: { 快照: saved, 恢复后expanded: !!(restored && restored.classList.contains('expanded')),
        子项在: !!nodeByPath(ROOT + '/docs/x.md'), 根头: { hidden: header.hidden, root: header.dataset.root } },
    };
  }

  // 12：⭐ **外部程序"在目录里加了一个文档"之后，刷新事务真的能看见它**
  //   （2026-10-27 用户实测「在目录树结构中，如果其他程序目录中增加了一个文档，目录树中并没有展示」）
  //
  //   根因不是监视没建起来（日志里 `目录监视已建立` 在），而是**刷新事务的离屏构建没带 `fresh`**：
  //   后端 `TreeCache` 的键是 (代次, 路径)，"多了一个文件"不动代次 ⇒ `fresh: false` 直接命中旧层，
  //   离屏重建出**一模一样**的树，提交后界面上什么都没变（右键「刷新」同样没用）。
  //   日志铁证：每次刷新都是 `list_dir … 代次 2**·缓存**… 0.00 ms`，条目数不变。
  //
  //   ⚠️ 判据**逐层**都要：根层与"已展开的子层"各加一个新文件——只修根层会漏掉深一层。
  //   ⭐ `design/0050` 起还有**第二道**防线：外部变更让纪元前进 ⇒ 旧层命中不到（`bumpEpoch()`）。
  //   本条判据仍然按**最严**的口径判（要求 `fresh` 真的传到了后端，"零缓存命中"），
  //   那是 `bugs/0019` 的正面修复；纪元的兜底由变异 `M10`/`M11` 一正一反地钉住。
  async function c12() {
    await fresh();
    const docs = nodeByPath(ROOT + '/docs');
    if (docs) { docs.firstElementChild.click(); await tick(3); }   // 让子层也进"要重建的层"
    const before = tree.nodeCount();
    // ⚠️ **外部程序写的**：只动"磁盘"，⛔ 不经产品的新建入口（那条路本来就是 fresh 的）
    const 新根 = add(ROOT, 'external.md', false);
    const 新深 = add(ROOT + '/docs', 'deep-new.md', false);
    bumpEpoch();   // ⭐ 后端 `reaction()` 该做的事：盘上变了 ⇒ 内容修订前进
    const beforeCached = calls['list_dir:cached'] || 0;
    const r = await tree.refreshVisible();
    await tick(2);
    const afterCached = calls['list_dir:cached'] || 0;
    const seen = { 根层新文件: !!nodeByPath(新根), 子层新文件: !!nodeByPath(新深) };
    const ok = !!r && r.committed === true &&
      seen.根层新文件 && seen.子层新文件 &&
      tree.nodeCount() === before + 2 &&
      afterCached === beforeCached;   // 刷新那一趟**一条缓存命中都不许有**
    return {
      ok: ok,
      criterion: '外部新增两个文件（根层一个、已展开子层一个）⇒ `refreshVisible()` 之后两行都在树上、' +
        '节点数 +2，且这一趟 `list_dir` **没有一次命中缓存**（`fresh` 真的传到了后端）',
      value: { 提交: r && r.committed, 原因: r && r.reason, 看到: seen,
        节点数: { 之前: before, 之后: tree.nodeCount() },
        缓存命中: { 刷新前: beforeCached, 刷新后: afterCached } },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // B1–B7 · 启动页收藏段（`design/0043` §2.3 / §2.6）
  // ════════════════════════════════════════════════════════════════════

  function mountStart() {
    const doc = $('doc');
    screen.render(doc, S.state.recent, S.state.favorites);
    return doc;
  }

  // B1：两段都画出来，⭐ **收藏在上、最近在下**；**收藏行没有数字**，最近行有；
  //     显示的路径是 `~` 缩写、`title` 是原串
  async function b1() {
    await fresh();
    mountStart();
    const rec = recentRows();
    const fav = startRows();
    const nums = document.querySelectorAll('.start-num');
    // ⭐ `design/0045`（用户 2026-10-25 点题：「收藏的，要放到最近打开目录的上面」）：
    //    ⚠️ 判**文档序**（不是 class 名、也不是 `allEls()` 的顺序）——视觉顺序才是用户看到的那一个。
    const boxEl = document.querySelector('.start');
    const kids = boxEl ? Array.prototype.slice.call(boxEl.children) : [];
    const favList = document.querySelector('.start-fav-list');
    const recList = document.querySelector('.start-list:not(.start-fav-list)');
    const favIdx = kids.indexOf(favList);
    const recIdx = kids.indexOf(recList);
    const orderOk = favIdx >= 0 && recIdx > favIdx;
    const ok = rec.length === 2 && fav.length === 2 &&
      nums.length === 2 &&
      fav.every(function (r) { return r.querySelector('.start-num') === null; }) &&
      rec.every(function (r) { return r.querySelector('.start-num') !== null; }) &&
      fav[0].title === '/Users/liubo/中文目录' &&
      fav[0].querySelector('.start-path').textContent === '~/中文目录' &&
      fav[0].querySelector('.start-name').textContent === '中文目录' &&
      document.querySelectorAll('.start-fav-list').length === 1 &&
      orderOk;
    return {
      ok: ok,
      criterion: '两段都在 ∧ **收藏段排在最近段之前** ∧ 数字只出现在最近行（收藏行 0 个）∧ 收藏行 title=原串、显示=~ 缩写',
      value: {
        最近行: rec.length, 收藏行: fav.length, 数字个数: nums.length,
        收藏段序: favIdx, 最近段序: recIdx, 顺序对: orderOk,
        收藏首行: { title: fav[0] && fav[0].title, 显示: fav[0] && fav[0].querySelector('.start-path').textContent },
      },
    };
  }

  // B2：数字键只映射最近表（`INV-FAV-05`）——收藏也在屏上时按 `2` 打开的是**第二条最近**
  async function b2() {
    await fresh();
    mountStart();
    key(document, '2');
    await tick(2);
    const ok = log.opened.join('|') === '/opt/notes' && log.openedFavorite.length === 0;
    return {
      ok: ok,
      criterion: '屏上同时有最近与收藏时按 `2` ⇒ 打开**第二条最近**目录 ∧ 一条收藏都没被打开',
      value: { 打开最近: log.opened, 打开收藏: log.openedFavorite },
    };
  }

  // B3：只有收藏、没有最近时，数字键**什么都不做**（⛔ 收藏不编号）
  async function b3() {
    await fresh();
    FAKE.recent = [];
    await S.refresh();
    mountStart();
    key(document, '1');
    await tick(2);
    const ok = recentRows().length === 0 && startRows().length === 2 &&
      log.opened.length === 0 && log.openedFavorite.length === 0;
    return {
      ok: ok,
      criterion: '只有收藏时按 `1` ⇒ 什么都不打开（数字只认最近表）',
      value: { 最近行: recentRows().length, 收藏行: startRows().length,
        打开: log.opened, 打开收藏: log.openedFavorite },
    };
  }

  // B4：点收藏行 ⇒ 回传的是**后端记录的原串**（⛔ 不是屏幕上那个 `~` 缩写）
  async function b4() {
    await fresh();
    mountStart();
    startRows()[1].click();
    await tick(2);
    const ok = log.openedFavorite.length === 1 && log.openedFavorite[0] === '/opt/docs' &&
      log.opened.length === 0;
    return {
      ok: ok,
      criterion: '点第二条收藏 ⇒ `onOpenFavorite` 收到 `/opt/docs`（屏幕上的 `~` 缩写 ⛔ 不回传）',
      value: { 收到: log.openedFavorite, 最近: log.opened },
    };
  }

  // B5：右键菜单 —— 三项、首行「上移」置灰、末行「下移」置灰；动作带**原串**与方向
  async function b5() {
    await fresh();
    mountStart();
    const rows = startRows();

    rightClickAt(rows[0], 20, 30);
    await tick(1);
    const first = startMenuItems();
    const firstDisabled = first.map(function (b) { return b.disabled; });
    const firstLabels = first.map(function (b) { return b.textContent; });
    first[2].click();                       // 下移
    await tick(1);

    rightClickAt(rows[1], 20, 30);
    await tick(1);
    const last = startMenuItems();
    const lastDisabled = last.map(function (b) { return b.disabled; });
    last[0].click();                        // 取消收藏
    await tick(1);
    const menuGone = !startMenuEl();

    const ok = firstLabels.join('|') === [
      t('start.menu.unfavorite'), t('start.menu.move-up'), t('start.menu.move-down'),
    ].join('|') &&
      firstDisabled.join(',') === 'false,true,false' &&
      lastDisabled.join(',') === 'false,false,true' &&
      log.move.length === 1 && log.move[0].join('|') === '/Users/liubo/中文目录|1' &&
      log.unfavorite.join('|') === '/opt/docs' &&
      menuGone;
    return {
      ok: ok,
      criterion: '收藏行菜单 = 取消收藏/上移/下移 ∧ 首行「上移」灰、末行「下移」灰 ∧ 上移下移带原串与 ±1 ∧ 点完菜单关掉',
      value: {
        首行菜单: firstLabels, 首行置灰: firstDisabled, 末行置灰: lastDisabled,
        移动: log.move, 取消收藏: log.unfavorite, 菜单已关: menuGone,
      },
    };
  }

  // B6：`Shift+F10` 开菜单（焦点进第一项）、`Escape` 关掉并把焦点**还给那一行**
  async function b6() {
    await fresh();
    mountStart();
    const rows = startRows();
    rows[1].focus();
    const focused = document.activeElement === rows[1];
    key(rows[1], 'F10', { shift: true });
    await tick(1);
    const items = startMenuItems();
    const opened = items.length === 3;
    const inMenu = document.activeElement === items[0];
    key(document, 'Escape');
    await tick(1);
    const ok = focused && opened && inMenu && !startMenuEl() &&
      document.activeElement === rows[1];
    return {
      ok: ok,
      criterion: '`Shift+F10` ⇒ 菜单开 ∧ 焦点进第一项；`Escape` ⇒ 菜单关 ∧ 焦点回到**那一行**',
      value: { 行先有焦点: focused, 菜单项数: items.length,
        焦点在第一项: inMenu, 菜单已关: !startMenuEl(),
        焦点回到行: document.activeElement === rows[1] },
    };
  }

  // B7：`↑`/`↓` 在**两张表之间**连续走。⚠️ `design/0045` 起顺序是**收藏 → 最近**
  //     （视觉顺序与 `allEls()` 同源），所以"跨段"的方向也反过来：收藏末行 ↓ 进最近首行。
  async function b7() {
    await fresh();
    mountStart();
    const rec = recentRows();
    const fav = startRows();
    fav[1].focus();
    key(fav[1], 'ArrowDown');
    await tick(1);
    const intoRecent = document.activeElement === rec[0];
    key(rec[0], 'ArrowDown');
    await tick(1);
    const toNextRecent = document.activeElement === rec[1];
    key(rec[1], 'ArrowDown');
    await tick(1);
    const atEnd = document.activeElement === rec[1];
    key(rec[1], 'ArrowUp');
    await tick(1);
    const back = document.activeElement === rec[0];
    // ⚠️ 先把焦点放回**第一条收藏行**再按 ↑：`move()` 读的是 `document.activeElement`，
    //    只把事件派给 `fav[0]`（不聚焦）测到的是"从下一段再走一步"（探针自己写错过一次）。
    fav[0].focus();
    key(fav[0], 'ArrowUp');
    await tick(1);
    const atTop = document.activeElement === fav[0];
    const ok = intoRecent && toNextRecent && atEnd && back && atTop;
    return {
      ok: ok,
      criterion: '收藏末行 ↓ ⇒ 进最近首行；最近内 ↓↑ 连续；两端不越界（焦点留在原地）',
      value: { 进最近: intoRecent, 最近间移动: toNextRecent, 末端不动: atEnd,
        向上回来: back, 顶端不动: atTop },
    };
  }

  // B8：失效行 —— 打开失败要**可见**（`data-missing` ＋ 一句提示），且**仍然可管理**
  async function b8() {
    await fresh();
    mountStart();
    log.failNextFavorite = true;
    const row = startRows()[0];
    row.click();
    await tick(3);
    const missing = row.dataset.missing === '1';
    const title = row.title;
    const err = log.errors[0];
    // 失效行仍能打开管理菜单（Remove/Move 不要求可达）
    rightClickAt(row, 20, 30);
    await tick(1);
    const items = startMenuItems();
    const canManage = items.length === 3 && items[0].disabled === false;
    items[0].click();
    await tick(1);
    const ok = missing && title === t('start.fav-missing') &&
      !!err && err.kind === 'not_found' && err.target === '/Users/liubo/中文目录' &&
      canManage && log.unfavorite.join('|') === '/Users/liubo/中文目录';
    return {
      ok: ok,
      criterion: '收藏打不开 ⇒ 行标 `data-missing` ∧ title 是「找不到」那句 ∧ 界面层收到 (kind, 原串) ∧ 失效行**仍能**取消收藏',
      value: { dataMissing: row.dataset.missing, title: title,
        期望title: t('start.fav-missing'), 报给界面层: err,
        菜单项数: items.length, 取消收藏: log.unfavorite },
    };
  }

  // B9：重画（收藏被移除 / 换语言后 `repaintStart`）⇒ 菜单先关、旧行全换、不留孤儿菜单
  async function b9() {
    await fresh();
    mountStart();
    rightClickAt(startRows()[1], 20, 30);
    await tick(1);
    const hadMenu = !!startMenuEl();
    FAKE.favorites = ['/opt/docs'];
    await S.refresh();
    mountStart();                            // ← `main.js::repaintStart` 的那一下
    const ok = hadMenu &&
      !startMenuEl() &&
      startRows().length === 1 &&
      startRows()[0].title === '/opt/docs' &&
      document.querySelectorAll('.start-menu').length === 0;
    return {
      ok: ok,
      criterion: '收藏少一条后重画 ⇒ 菜单先关 ∧ 只剩一行且内容是新的 ∧ 页面里没有孤儿菜单',
      value: { 重画前有菜单: hadMenu, 现在有菜单: !!startMenuEl(),
        行数: startRows().length, 首行title: startRows()[0] && startRows()[0].title },
    };
  }

  // B10：⭐ `design/0045`（隐私）：「清空」**第一下只上膛、第二下才真清**，
  //      且清完最近段整段消失、收藏段不受影响。
  async function b10() {
    await fresh();
    mountStart();
    const btn0 = document.querySelector('.start-clear');
    const label0 = btn0 ? btn0.textContent : null;
    if (!btn0) {
      return { ok: false, criterion: '最近段标题右边必须有「清空」按钮', value: { 有按钮: false } };
    }
    btn0.click();
    await tick(2);
    const armedBtn = document.querySelector('.start-clear');
    const armed = !!armedBtn && armedBtn.dataset.armed === '1';
    const label1 = armedBtn ? armedBtn.textContent : null;
    const firedAfterFirst = log.clear.length;
    const recentAfterFirst = recentRows().length;

    btn0.click();                              // ← 同一个节点再点一下（窗口内第二下）
    await tick(4);
    const firedAfterSecond = log.clear.length;
    const recentAfterSecond = recentRows().length;
    const headGone = !document.querySelector('.start-head');
    const favStill = startRows().length;
    const ok = label0 === t('start.recent-clear') &&
      armed && label1 === t('start.recent-clear-confirm') &&
      firedAfterFirst === 0 && recentAfterFirst === 2 &&
      firedAfterSecond === 1 && recentAfterSecond === 0 &&
      headGone && favStill === 2;
    return {
      ok: ok,
      criterion: '第一下：按钮变「确认清空？」、行一条不少、⛔ 不回调；第二下：`onClearRecent` 恰好 1 次、最近段整段消失、收藏段仍在',
      value: {
        原文案: label0, 期望: t('start.recent-clear'),
        上膛: armed, 上膛文案: label1,
        第一下后: { 回调: firedAfterFirst, 最近行: recentAfterFirst },
        第二下后: { 回调: firedAfterSecond, 最近行: recentAfterSecond },
        段落头消失: headGone, 收藏行: favStill,
      },
    };
  }

  // B11：⭐ `design/0045`：最近行的右键 / `Shift+F10` ⇒「从列表移除」，带**原串**，
  //      且只删那一条（收藏一条不动）。
  async function b11() {
    await fresh();
    mountStart();
    const rec = recentRows();
    rightClickAt(rec[1], 20, 30);
    await tick(1);
    const items = startMenuItems();
    const labels = items.map(function (b) { return b.textContent; });
    const disabled = items.map(function (b) { return b.disabled; });
    const hadFocus = document.activeElement;   // ⚠️ 右键不开车焦点（与 `Shift+F10` 区分）
    items[0] && items[0].click();
    await tick(4);
    const ok = labels.length === 1 && labels[0] === t('start.menu.forget') &&
      disabled.join(',') === 'false' &&
      log.forget.join('|') === '/opt/notes' &&
      recentRows().length === 1 &&
      recentRows()[0].title === '/Users/liubo/workspace/rmd' &&
      startRows().length === 2 &&
      !startMenuEl() && hadFocus !== items[0];
    return {
      ok: ok,
      criterion: '最近行菜单只有「从列表移除」∧ 回传**后端原串** `/opt/notes` ∧ 只删那一条（收藏 2 条不动）∧ 点完菜单关掉',
      value: {
        菜单项: labels, 置灰: disabled, 移除: log.forget,
        剩余最近: recentRows().map(function (r) { return r.title; }),
        收藏行: startRows().length, 菜单已关: !startMenuEl(),
      },
    };
  }

  // B12：最近行也吃 `Shift+F10`（与收藏行同一条入口）⇒ 菜单开、焦点进第一项、
  //      `Escape` 把焦点还给**那一行**（⛔ 掉到 `body`）。
  async function b12() {
    await fresh();
    mountStart();
    const rec = recentRows();
    rec[1].focus();
    const focused = document.activeElement === rec[1];
    key(rec[1], 'F10', { shift: true });
    await tick(1);
    const items = startMenuItems();
    const opened = items.length === 1;
    const inMenu = document.activeElement === items[0];
    key(document, 'Escape');
    await tick(1);
    const ok = focused && opened && inMenu && !startMenuEl() &&
      document.activeElement === rec[1] && log.forget.length === 0;
    return {
      ok: ok,
      criterion: '最近行 `Shift+F10` ⇒ 菜单开（1 项）∧ 焦点进第一项；`Escape` ⇒ 关 ∧ 焦点回到那一行 ∧ ⛔ 没有任何回调被触发',
      value: { 行先有焦点: focused, 菜单项数: items.length, 焦点在第一项: inMenu,
        菜单已关: !startMenuEl(), 焦点回到行: document.activeElement === rec[1],
        回调: log.forget },
    };
  }

  // ── 总装 ────────────────────────────────────────────────────────────
  window.__RUN = async function () {
    const t0 = Date.now();
    const 判据 = [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12,
      b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12];
    const IDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
      'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12'];
    for (let i = 0; i < 判据.length; i++) {
      let r;
      try {
        r = await 判据[i]();
      } catch (e) {
        r = { ok: false, criterion: '判据自己抛了异常', value: { 错误: String(e && (e.stack || e)) } };
      }
      rec(IDS[i], NAMES[IDS[i]] || '', !!r.ok, r.criterion, r.value);
    }
    document.querySelectorAll('.tree-menu, .start-menu').forEach(function (n) { n.remove(); });
    screen.clear();
    return {
      环境: {
        加载期错误: window.__LOADERR || [],
        用户代理: navigator.userAgent,
        I18N语言: I18N && I18N.lang ? I18N.lang() : null,
      },
      夹具: {
        根: ROOT,
        另一个根: OTHER,
        收藏: FAKE.favorites,
        最近: FAKE.recent.map(function (r) { return r.root; }),
        树节点数: tree.nodeCount(),
        IPC次数: JSON.parse(JSON.stringify(calls)),
      },
      检查: checks,
      结论: {
        通过: checks.filter(function (c) { return c.结果 === '通过'; }).length,
        失败: checks.filter(function (c) { return c.结果 === '失败'; }).length,
        毫秒: Date.now() - t0,
      },
    };
  };

  const NAMES = {
    '1': '根头：可见、属性对、与树是两个 host',
    '2': '根头：清空重画 / 刷新事务之后仍在',
    '3': '根头：新建输入行落在 `#tree-host` 内、根头**下方**',
    '4': '根头：换根后跟着换、无旧根残留',
    '5': '根头：空态隐藏（不是删除），提示框进 `#tree-host`',
    '6': '根头：根层读失败 / 未授权态同样隐藏',
    '7': '根头：树/列表切换不卸载根头与树',
    '8': '根头：`⋯` 与右键同一份菜单（白名单，无重命名/删除）',
    '9': '根头：`Shift+F10`/`Enter` 开菜单，`Escape` 焦点回根头',
    '10': '深度：顶层仍是 0 层，根头不占一层',
    '11': '展开态：换根再换回后 `restoreExpanded` 恢复原样',
    '12': '磁盘外部变更：新增文件后刷新事务能看到它（每一层都不许吃缓存）',
    'B1': '启动页：两段都在，数字只在最近行，收藏回传原串',
    'B2': '启动页：数字键只映射最近表',
    'B3': '启动页：只有收藏时数字键什么都不做',
    'B4': '启动页：点收藏回传后端原串',
    'B5': '启动页：菜单三项、首末置灰、动作方向与原串',
    'B6': '启动页：`Shift+F10` 开菜单、`Escape` 焦点回行',
    'B7': '启动页：`↑`/`↓` 跨两段连续走、两端不越界',
    'B8': '启动页：失效行可见且仍可取消收藏',
    'B9': '启动页：重画时菜单先关、不留孤儿',
    'B10': '启动页：`清空` 两下才清、清完最近段消失',
    'B11': '启动页：最近行菜单「从列表移除」带原串、只删一条',
    'B12': '启动页：最近行 `Shift+F10` 开菜单、`Escape` 焦点回行',
  };

  } catch (e) {
    // ⚠️ 顶部那段 `try` 的兜底：装配期抛错时也要给出一份可读的 JSON（否则只剩 "Script error."）。
    window.__RUN = async function () {
      return {
        致命: String(e && (e.stack || e)),
        加载期错误: (window.__LOADERR || []),
        检查: [],
        结论: { 通过: 0, 失败: 1 },
      };
    };
  }
})();
