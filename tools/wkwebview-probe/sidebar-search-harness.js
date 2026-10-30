// rmd · 「侧边栏常驻文件名搜索」的**离屏接线闸门**（`design/0042` §7）
//
// ⭐ 跑的是**产品那几份源码**（`services/{i18n,versions,chunked,doclists,search,sidebarsearch,
//    dirsession,tauri,session,keymap}.js` ＋ `components/{Sidebar,SidebarSearch}.js`）
//    与**产品那几张样式表**（`styles/{tokens,themes,typography,sidebar}.css`）
//    ⇒ 算覆盖面：判据 A–H 进**退出码**（`.claude/rules/tests.md` 的四层划分）。
//
// # 它回答什么
//
// 这个搜索框必须与 `⌘P` **逐条同源**（`design/0042` §2.1）：同一份 Rust 匹配、同一套
// `req`/代次竞态判据、同一条"第一次输入重建索引"的时机。这些判据在纯逻辑单测里
// （`tests/js/sidebarsearch.test.js`）验不到 —— 那里没有 DOM、没有 `session.searchFiles`、
// 也没有两个异步回包的先后。⇒ 本文件把**产品组件真的装起来**，用真事件驱动：
//
//   A 初始态：目录未就绪时输入框不出现；就绪后出现，且树仍占着面板
//   B 中文查询：结果层盖住树（树只切 `hidden`）、高亮片段是**那两个字**、说明行有条数
//   C 重建时机：从"没在搜"进入 ⇒ `rebuild=true`；继续敲 ⇒ `false`（`INV-SEARCH-06` 同一条）
//   D 清空：树回来，**且没被卸载**（同一个节点还在原处，`design/0041` R4/R5）
//   F 竞态：先发的回包**后到**不得覆盖后发的（`INV-VER-01` / `search.js::commitDecision`）
//   G 点行：回传那一行的 `real_path`，并退出搜索（否则全局键被可编辑焦点挡着）
//   H 刷新键：**从后端那张表里认**（`INV-SET-01`）；空模式刷新只重建、不显示结果层
//   （⭐ 判据 **E**「没抢前台」由 `doclist-probe.swift` 自证，写在 JSON 的 `环境` 里）
//
// # ⚠️ 两条口径
//
// 1. **假后端**（`window.__TAURI__.core.invoke` 由本文件装）⇒ 不含真 IPC、不含真读盘；
//    这里验的是**接线与竞态**，⛔ 不是性能。
// 2. 驱动一律用**真事件**（`input` / `click` / `keydown`）——⛔ 不直接调组件内部函数，
//    否则"事件没绑上"这类问题一条都测不出来。

(function () {
  'use strict';

  const ROOT = '/Users/probe/workspace';
  /** 自造超时：探针⛔ 不许无限挂住。 */
  const WAIT_MS = 3000;

  const SS = window.rmd.sidebarsearch;

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function tick() { return sleep(0); }

  /** 轮询到条件成立（返回 false = 超时）。 */
  async function until(fn, ms) {
    const t0 = performance.now();
    while (performance.now() - t0 < (ms || WAIT_MS)) {
      let ok = false;
      try { ok = !!fn(); } catch (e) { ok = false; }
      if (ok) return true;
      await sleep(10);
    }
    return false;
  }

  function deferred() {
    let resolve;
    const promise = new Promise(function (res) { resolve = res; });
    return { promise: promise, resolve: resolve };
  }

  // ── 假后端 ───────────────────────────────────────────────────────────
  //
  // ⚠️ 形状必须与 Rust 侧一致（`src-tauri/src/fs/tree.rs::SearchHit` / `SearchResult`）：
  //    `real_path` / `rel` 是 **snake_case**，命中的 `match` 是**原文件名上的 UTF-8 字节**区间。

  const FILES = [
    { name: '设计文档-001.md', rel: 'docs/设计文档-001.md' },
    { name: '设计文档-002.md', rel: 'docs/设计文档-002.md' },
    { name: '侧边栏搜索说明.md', rel: 'docs/侧边栏搜索说明.md' },
    { name: 'README.md', rel: 'README.md' },
    { name: '图片-截图.png', rel: 'assets/图片-截图.png' },
  ];

  const backend = {
    calls: [],
    /** 挂住**下一次** `search_files` 的回包（制造"先发后回"的窗口）。 */
    holdNext: null,
    reset: function () { backend.calls = []; backend.holdNext = null; },
  };

  function utf8Len(s) { return new TextEncoder().encode(s).length; }

  /** 造一份 `SearchResult`（`pattern` 只做子串匹配 ⇒ 与真实算法无关，只求确定）。 */
  function mkPayload(args) {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    const entries = [];
    if (pattern.trim() !== '') {
      for (let i = 0; i < FILES.length; i++) {
        const f = FILES[i];
        const at = f.name.indexOf(pattern);
        if (at < 0) continue;
        const start = utf8Len(f.name.slice(0, at));
        const end = start + utf8Len(pattern);
        entries.push({
          root: ROOT,
          real_path: ROOT + '/' + f.rel,
          rel: f.rel,
          name: f.name,
          match: [start, end],
        });
      }
    }
    return {
      generation: 1,
      req: args.req,
      roots: [ROOT],
      entries: entries,
      total_hits: entries.length,
      truncated: false,
      // ⭐ 索引年龄（⛔ 不是时间戳）：1.2 秒 ⇒ 说明行里会出现"索引 N 秒前"。
      built_at_ms: 1200,
    };
  }

  function snapshot() {
    return {
      generation: 1,
      mode: 'directory',
      roots: [ROOT],
      files: [],
      pending_directory: null,
      sidebar_width: 280,
      last_directory: ROOT,
      reading_progress: {},
      dir_session: null,
      doc_seq: 1,
      sidebar_file_view: 'tree',
      hide_empty_dirs: true,
    };
  }

  function installBackend() {
    window.__TAURI__ = window.__TAURI__ || {};
    window.__TAURI__.core = {
      invoke: function (cmd, args) {
        if (cmd === 'get_session') return Promise.resolve(snapshot());
        if (cmd === 'search_files') {
          backend.calls.push({
            pattern: args.pattern,
            rebuild: args.rebuild === true,
            req: args.req,
          });
          const payload = mkPayload(args);
          const hold = backend.holdNext;
          backend.holdNext = null;
          if (hold) return hold.promise.then(function () { return payload; });
          return Promise.resolve(payload);
        }
        // ⚠️ 其余命令一律显式报错：静默 resolve 会让"接错了命令名"永远查不出来。
        return Promise.reject(new Error('未预料的命令：' + cmd));
      },
    };
  }

  // ── 装配产品组件 ─────────────────────────────────────────────────────

  const log = { picked: [], activeChanges: [] };

  function mount() {
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
    };

    // ⚠️ 树在这里是**桩子**（本探针不验树），但要一个稳定节点来验"没被卸载"。
    const marker = document.createElement('div');
    marker.id = 'tree-marker';
    marker.textContent = '树还在这里';
    els.paneTree.appendChild(marker);

    const sidebar = window.rmd.sidebar.createSidebar({
      els: els,
      tree: { refreshVisible: function () {} },
      onTabChange: function () {},
      onToggleFileView: function () {},
      onChooseDirectory: function () {},
      keyText: function () { return ''; },
    });

    // ⭐ `main.js` 的接线逐条照搬：结果层显隐交给 `Sidebar.applyPanes`，
    //    搜索走 `session.searchFiles`（与 `⌘P` 同一条路径），选中走同一条打开路径。
    const search = window.rmd.sidebarSearch.createSidebarSearch({
      els: { input: $('sidebar-search-input'), pane: els.paneSearch },
      search: function (pattern, rebuild) {
        return window.rmd.session.searchFiles(pattern, rebuild);
      },
      onPick: function (realPath) { log.picked.push(realPath); },
      onActiveChange: function (on) {
        log.activeChanges.push(!!on);
        sidebar.setSearchActive(on);
      },
      onError: function (e) { log.error = String(e && (e.message || e)); },
      // ⚠️ 假表：只为验"键从表里认"（真表由后端 `get_shortcuts` 给）。
      keymap: { bindings: [{ id: 'file.refresh-index', accel: 'Cmd+R' }] },
      refreshId: 'file.refresh-index',
    });

    // 形态先落地一次（`applyPanes` 的初值），与 `main.js::renderSidebar` 同序。
    sidebar.setFileView('tree');

    // ⚠️ 驱动侧只要这几个：输入框、结果层、树、搜索框那一行（⛔ 别把 Sidebar 的整份 els 传出去，
    //    它里面没有 `input`——第一版就是这么把一个 undefined 喂进了 `type()`）。
    return {
      sidebar: sidebar,
      search: search,
      marker: marker,
      els: {
        input: $('sidebar-search-input'),
        paneSearch: els.paneSearch,
        paneTree: els.paneTree,
        searchBar: els.searchBar,
      },
    };
  }

  // ── 驱动 ─────────────────────────────────────────────────────────────

  function type(els, value) {
    els.input.value = value;
    els.input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function key(els, init) {
    els.input.dispatchEvent(new KeyboardEvent('keydown', Object.assign({
      bubbles: true, cancelable: true,
    }, init)));
  }

  function rows(els) {
    return els.paneSearch.querySelectorAll('.sidebar-search-item');
  }
  function noteText(els) {
    const n = els.paneSearch.querySelector('.sidebar-search-note');
    return n ? (n.textContent || '') : '';
  }
  function hitTexts(els) {
    return Array.prototype.map.call(
      els.paneSearch.querySelectorAll('.sidebar-search-hit'),
      function (m) { return m.textContent; }
    );
  }
  function names(els) {
    return Array.prototype.map.call(rows(els), function (r) {
      const n = r.querySelector('.sidebar-search-name');
      return n ? n.textContent : '';
    });
  }
  function visible(el) { return !!el && el.hidden === false; }

  /** 等结果层画出来（或说明行为"没有匹配"）。 */
  async function settle(els) {
    await until(function () {
      return rows(els).length > 0
        || els.paneSearch.querySelector('.sidebar-search-empty') !== null
        || noteText(els).indexOf('出错') >= 0;
    });
    await tick();
  }

  // ── 主流程 ───────────────────────────────────────────────────────────

  async function run() {
    installBackend();
    await window.rmd.session.refresh();

    const m = mount();
    const els = m.els;
    const out = { 环境: {}, 判据: [] };
    function judge(name, ok, extra) {
      const o = { 判据: name, ok: !!(ok) };
      if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
      out.判据.push(o);
    }

    // ── A 初始态 ──────────────────────────────────────────────────────
    // 目录还没就绪（`main.js` 只在 directory 分支调 `setSearchAvailable(true)`）。
    const barHiddenBefore = els.searchBar.hidden === true;
    m.sidebar.setSearchAvailable(true);
    const barShownAfter = visible(els.searchBar);
    const treeStillOn = visible(els.paneTree);
    const searchPaneOff = els.paneSearch.hidden === true;
    judge('A 初始态：未就绪时输入框不出现；就绪后出现且树仍可见',
      barHiddenBefore && barShownAfter && treeStillOn && searchPaneOff,
      { 就绪前: barHiddenBefore, 就绪后: barShownAfter, 树可见: treeStillOn, 结果层隐藏: searchPaneOff });

    // ── A2 大纲页：输入框跟着收起（文件页之外没有可搜的东西）───────────
    m.sidebar.setTab('toc');
    const barOnToc = els.searchBar.hidden === true;
    m.sidebar.setTab('tree');
    const barBackOnTree = visible(els.searchBar);
    judge('A2 切到大纲页时输入框收起，切回文件页再出现',
      barOnToc && barBackOnTree, { 大纲页隐藏: barOnToc, 回文件页可见: barBackOnTree });

    // ── B 中文查询（高亮片段 / 结果层盖住树）────────────────────────────
    backend.reset();
    type(els, '文档');
    await settle(els);
    const namesB = names(els);
    const marksB = hitTexts(els);
    const noteB = noteText(els);
    judge('B 中文查询：结果层盖住树，命中片段是"文档"两个字',
      visible(els.paneSearch) && els.paneTree.hidden === true
        && namesB.length === 2 && marksB.length === 2
        && marksB[0] === '文档' && marksB[1] === '文档'
        && noteB.indexOf('2') >= 0,
      { 行数: namesB.length, 高亮: marksB.join('|'), 说明行: noteB });

    // ── C 重建时机：第一次 true，继续敲 false ──────────────────────────
    type(els, '文档-0');
    await settle(els);
    const c1 = backend.calls[0] || {};
    const c2 = backend.calls[backend.calls.length - 1] || {};
    judge('C 重建时机：进入搜索时 rebuild=true，之后每次输入 rebuild=false',
      c1.rebuild === true && c2.rebuild === false && c2.pattern === '文档-0',
      { 第一次: JSON.stringify(c1), 第二次: JSON.stringify(c2) });

    // ── D 清空：树回来且**没被卸载** ────────────────────────────────────
    type(els, '');
    await tick();
    judge('D 清空：树恢复显示且节点未被卸载（只切 hidden）',
      visible(els.paneTree) && els.paneSearch.hidden === true
        && m.marker.parentNode === els.paneTree && m.marker.id === 'tree-marker',
      { 树可见: visible(els.paneTree), 结果层隐藏: els.paneSearch.hidden === true, 桩节点在: m.marker.parentNode === els.paneTree });

    // ── F 竞态：先发的回包后到，⛔ 不许覆盖后发的 ────────────────────────
    backend.reset();
    const hold = deferred();
    backend.holdNext = hold;
    type(els, '文档');                    // 第 1 次：被挂住
    await until(function () { return backend.calls.length === 1; });
    type(els, '侧边栏');                  // 第 2 次：立即回
    await settle(els);
    const namesSecond = names(els);
    hold.resolve();
    await sleep(60);
    await settle(els);
    const namesAfterLate = names(els);
    judge('F 竞态：先发的回包后到，不得覆盖后发的结果',
      namesSecond.length === 1 && namesSecond[0].indexOf('侧边栏搜索说明') === 0
        && namesAfterLate.length === 1 && namesAfterLate[0].indexOf('侧边栏搜索说明') === 0,
      { 后发结果: namesSecond.join('|'), 旧回包到达后: namesAfterLate.join('|') });

    // ── G 点行：回传 real_path，并退出搜索 ──────────────────────────────
    const expectPath = ROOT + '/docs/侧边栏搜索说明.md';
    const first = rows(els)[0];
    if (first) first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick();
    judge('G 点行：回传那一行的 real_path，并退出搜索（树恢复）',
      log.picked.length === 1 && log.picked[0] === expectPath
        && visible(els.paneTree) && els.paneSearch.hidden === true
        && els.input.value === '',
      { 回传: log.picked.join('|'), 树可见: visible(els.paneTree), 输入框: els.input.value });

    // ── H 刷新键：从表里认；空模式只重建、不显示结果层 ───────────────────
    backend.reset();
    type(els, '文档');
    await settle(els);
    const beforeRefresh = backend.calls.length;
    key(els, { key: 'r', metaKey: true });
    await until(function () { return backend.calls.length > beforeRefresh; });
    const refreshCall = backend.calls[backend.calls.length - 1] || {};
    const refreshOk = backend.calls.length === beforeRefresh + 1
      && refreshCall.rebuild === true && refreshCall.pattern === '文档';

    type(els, '');
    await tick();
    backend.reset();
    key(els, { key: 'r', metaKey: true });
    await until(function () { return backend.calls.length > 0; });
    const emptyRefresh = backend.calls[0] || {};
    const emptyOk = emptyRefresh.pattern === '' && emptyRefresh.rebuild === true
      && els.paneSearch.hidden === true && visible(els.paneTree);

    judge('H 刷新键：从后端表里认（Cmd+R），有模式时重查、空模式只重建索引',
      refreshOk && emptyOk,
      {
        有模式: JSON.stringify(refreshCall),
        空模式: JSON.stringify(emptyRefresh),
        空模式后结果层隐藏: els.paneSearch.hidden === true,
      });

    judge('I 全程没有报错出口被触发', !log.error, { 错误: log.error || '' });

    out.环境 = {
      userAgent: navigator.userAgent,
      被测源码: [
        'src/services/i18n.js',
        'src/services/versions.js',
        'src/services/chunked.js',
        'src/services/doclists.js',
        'src/services/search.js',
        'src/services/sidebarsearch.js',
        'src/services/dirsession.js',
        'src/services/tauri.js',
        'src/services/session.js',
        'src/services/keymap.js',
        'src/components/Sidebar.js',
        'src/components/SidebarSearch.js',
      ],
      样式: ['styles/tokens.css', 'styles/themes.css', 'styles/typography.css', 'styles/sidebar.css'],
      键位表: '假表（只为验"从表里认"，⛔ 不是真键位）',
      注意: '假后端 ⇒ 不含真 IPC 与真读盘；本探针验接线与竞态，⛔ 不给性能数字',
    };
    return out;
  }

  window.__RUN = run;
  window.__LOADERR = [];
  window.addEventListener('error', function (e) {
    window.__LOADERR.push(String(e.message || e));
  });
})();
