// 侧边栏 —— 两个视图（文件树 / 大纲）、**未授权态**、收起/展开、宽度拖拽。
//
// # 收起用位移，⛔ 不用 `display:none`（§2.1.1 第 1 条，⚠️ 理由已修正）
//
// 选位移**只**因为两件事：① 过渡动画（`display` 不可过渡）② **保住树的滚动位置**
// （`display:none` 后元素脱离布局，`scrollTop` 归零）。
// ⛔ 原设计写的"展开状态也会丢"是**错的**，已删：状态在 `FileTree` 的 `expanded: Set` 里，
// 两种隐藏方式都不会丢。`contain:strict` 是位移隐藏的**必要配套**（元素仍在布局树里）。
//
// # ⭐ 收起后必须不可聚焦、不可被辅助技术读到（`INV-TREE-02`）
//
// 位移隐藏的元素**仍在 DOM 且仍可聚焦**——用户按 `Tab` 焦点会进一个看不见的侧边栏。
// 处理是**两件事分工，不是二选一**（§2.1.1 的组合）：
//
// | 手段 | 管什么 | 何时设 |
// |---|---|---|
// | `inert` | **焦点 + a11y 树** | `transitionend`（动画中设会让动画"跳"） |
// | `visibility` | **过渡期的可见性** | 与 `left` 同一条 `transition` 里延迟切换 |
//
// ✅ `inert` 在本机 WKWebView 是完整支持（`kb/0009`，实测焦点确实被挡住）。
// ⚠️ 但 `kb/0009` 只验了**焦点**，a11y（VoiceOver）那一侧**没观测**
// ⇒ §7 步骤 17 的人工验收仍然必须做。

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

  const S = (typeof module !== 'undefined' && module.exports) ? require('../services/session.js') : window.rmd.session;
  // ⭐ `design/0044` §2.2：根头的 Tab 模型要判"带不带修饰键 / 是不是组合态"——
  //    这两条判据**只有一份**（`services/keymap.js`），⛔ 不在这里另写 `e.metaKey || …`。
  const K = (typeof module !== 'undefined' && module.exports) ? require('../services/keymap.js') : window.rmd.keymap;
  // ⭐ `design/0025`：可见文案走字典（浏览器取 `window.rmd.i18n`，`node --test` 走 `require`）。
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) ||
    (typeof module !== 'undefined' && module.exports ? require('../services/i18n.js') : null);
  const t = I18N ? I18N.t : function (key) { return key; };

  /** 把 `/Users/xxx/...` 缩成 `~/...`。⚠️ **只用于显示**，⛔ 绝不据此拼路径。 */
  function tilde(p) {
    if (typeof p !== 'string') return '';
    return p.replace(/^\/Users\/[^/]+/, '~');
  }

  function createSidebar(opts) {
    const els = opts.els;
    const tree = opts.tree;
    const onTabChange = opts.onTabChange || function () {};
    // ⭐ `design/0041` §2.3：形态切换的**消费点**（写盘与列表加载都在 `main.js` 那一侧）。
    const onToggleFileView = opts.onToggleFileView || function () {};
    // ⭐ `design/0044` §2.2：根头的 `⋯` 与右键都只**报坐标**，菜单本体在 `FileTree`。
    const onRootMenu = opts.onRootMenu || function () {};

    let collapsed = false;
    let tocItems = [];
    let tab = 'tree';
    /** ⭐ 侧边栏形态：`"tree"` / `"list"`（真值在会话快照，这里是显示镜像）。 */
    let fileView = 'tree';
    /** ⭐ `design/0042`：底部常驻搜索**结果层**是否正显示着（覆盖树/列表，但两者都不卸载）。 */
    let searchActive = false;
    /** ⭐ `design/0042`：搜索框现在该不该出现（目录模式才有东西可搜）。 */
    let searchAvailable = false;

    /** 收起时的收尾：动画结束后才设 `inert`（动画中设会让动画"跳"）。 */
    function onTransitionEnd(e) {
      if (e.target !== els.sidebar || e.propertyName !== 'left') return;
      if (collapsed) els.sidebar.setAttribute('inert', '');
    }

    function setCollapsed(next) {
      collapsed = next;
      document.body.classList.toggle('sidebar-collapsed', collapsed);
      els.sidebar.classList.toggle('collapsed', collapsed);
      els.expandBtn.hidden = !collapsed;
      if (!collapsed) {
        // 展开时**立刻**恢复：焦点要能马上进去
        els.sidebar.removeAttribute('inert');
      } else if (prefersReducedMotion()) {
        // 没有过渡时 `transitionend` 不会来 —— ⛔ 别让 `inert` 永远设不上
        els.sidebar.setAttribute('inert', '');
      }
    }

    function prefersReducedMotion() {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (e) {
        return false;
      }
    }

    /** 切 tab。⚠️ 切换**不得**影响树的展开状态（`INV-TREE-02` 后半句，`expanded` 在数据层）。 */
    function setTab(name) {
      tab = name;
      for (const t of [['tree', els.tabTree], ['toc', els.tabToc]]) {
        const on = t[0] === name;
        t[1].classList.toggle('active', on);
        t[1].setAttribute('aria-selected', on ? 'true' : 'false');
        t[1].tabIndex = on ? 0 : -1;
      }
      applyPanes();
      onTabChange(name, els.sidebar.scrollTop);
    }

    /**
     * ⭐ 面板可见性**唯一**的计算处（`design/0041` §2.3，`design/0042` §2.2 扩到四个面板）。
     *
     * ⚠️ `#pane-tree` / `#pane-doclist` / `#pane-search` **互斥但不卸载**：切换只改 `hidden`
     * ⇒ 树的展开态（数据层 `expanded`）与滚动位置、列表的分片进度都原样留着（R4/R5）。
     * ⛔ 别在这里 `textContent = ''`：那是"卸载"，而设计明确要求"树不卸载"。
     *
     * ⭐ `design/0042`：底部搜索框**只出现在文件页**（树与列表两种形态都算），
     * 大纲页上没有可搜的文件；结果层盖住的是**当前那一种文件形态**，同样不卸载。
     */
    function applyPanes() {
      const onFiles = tab === 'tree';
      const list = fileView === 'list';
      const searching = onFiles && searchActive;
      els.paneToc.hidden = tab !== 'toc';
      els.paneTree.hidden = !(onFiles && !list && !searching);
      if (els.paneDoclist) els.paneDoclist.hidden = !(onFiles && list && !searching);
      if (els.paneSearch) els.paneSearch.hidden = !searching;
      // ⚠️ 搜索框与结果层同属"文件页"：切到大纲页时输入框也一起收起来
      //    （⛔ 否则它会在一个不知道该搜什么的面板上继续显示上一个查询）。
      if (els.searchBar) els.searchBar.hidden = !(onFiles && searchAvailable);
      // ⚠️ 形态按钮只在**文件**那一页有意义：大纲页上它没有可切换的对象。
      if (els.btnFileView) els.btnFileView.hidden = !onFiles;
    }

    /** 贴按钮的两句文案（⚠️ 都表示**点下去会切成什么**，不是"现在是什么"）。 */
    function relabelFileView() {
      if (!els.btnFileView) return;
      const toList = fileView !== 'list';
      const labelKey = toList ? 'fileView.list' : 'fileView.tree';
      const titleKey = toList ? 'fileView.to-list' : 'fileView.to-tree';
      els.btnFileView.textContent = t(labelKey);
      els.btnFileView.title = t(titleKey);
      els.btnFileView.setAttribute('aria-label', t(titleKey));
    }

    /**
     * ⭐ 承认一个形态（来自会话快照 / 写盘返回值）。
     * ⚠️ 它**不写盘**——写盘与列表加载都在 `main.js`（`Sidebar` 不认识 IPC）。
     */
    function setFileView(view) {
      fileView = view === 'list' ? 'list' : 'tree';
      relabelFileView();
      applyPanes();
    }

    // ── 根头（`design/0044`）────────────────────────────────────────────
    //
    // ⚠️⚠️ **根头与原树是两个 host**（§2.4）：`FileTree` 只碰 `#tree-host`
    //   ——它的 `commitRefresh` 会 `textContent = ''` 再重画，`openInput` 又插在
    //   自己 `host.firstChild` 之前。根头若和树共用一个容器，这两件事会分别
    //   **删掉根头**和**把新建输入框顶到根头上面**（用户 2026-10-25 复评点名）。
    //   所以结构写在 `index.html` 的静态壳里：`.tree-root-wrap > (#tree-root-header + #tree-host)`。

    /** 树真正该画的容器。⚠️ 回落 `paneTree` 只是老测试夹具没给 `treeHost` 时的护栏。 */
    function treeSlot() { return els.treeHost || els.paneTree; }

    /** 清空树容器（⛔ 不碰 `.tree-root-wrap`，那层是静态壳）。 */
    function clearTreeSlot() {
      const slot = treeSlot();
      if (slot) slot.textContent = '';
      return slot;
    }

    /**
     * ⭐ 承认"当前根是哪个目录"（`null` = 没有根 ⇒ 整行隐藏）。
     * ⚠️ **只改这几个属性/文本，⛔ 不重画外层**：`renderSidebar` 的频率跟刷新走。
     * ⚠️ 目录名用最后一段、`title` 给全路径——与启动页/树行同一条口径
     *   （`tilde` 只用于显示，见本文件头）。
     */
    function setRootHeader(root) {
      const header = els.treeRootHeader;
      if (!header) return;
      if (typeof root !== 'string' || root === '') {
        header.hidden = true;
        header.removeAttribute('title');
        header.removeAttribute('data-root');
        return;
      }
      header.hidden = false;
      header.title = tilde(root); // ⚠️ 显示用缩写，完整串在 `data-root`（测试读）
      header.dataset.root = root;
      const name = els.treeRootName;
      if (name) name.textContent = basename(root);
      const icon = els.treeRootIcon;
      // ⭐ 图标复用 `FileTree` 那一份 `svgIcon('folder')`：⛔ 不在这里画第二棵 `<svg>`
      //   （两份路径迟早分叉，表现是根头和树里的文件夹长得不一样）。
      if (icon && !icon.firstChild) {
        const treeApi = (typeof window !== 'undefined' && window.rmd && window.rmd.fileTree) || null;
        const svg = treeApi && typeof treeApi.svgIcon === 'function' ? treeApi.svgIcon('folder') : null;
        if (svg) icon.appendChild(svg);
      }
    }

    /** 取路径最后一段（与 `services/start.js::basename` 同一条口径）。 */
    function basename(p) {
      if (typeof p !== 'string' || p === '') return '';
      const s = p.replace(/\/+$/, '');
      if (s === '') return '/';
      const i = s.lastIndexOf('/');
      return i >= 0 ? s.slice(i + 1) : s;
    }

    /** ⭐ 菜单关掉后焦点要能**回到根头**（⛔ 别掉到 `body`）。 */
    function focusRootHeader() {
      const header = els.treeRootHeader;
      if (header && !header.hidden) header.focus();
    }

    /** `⋯` / 右键 / `Shift+F10` 三条路只算坐标，动作清单在 `FileTree::openRootMenu`。 */
    function openRootMenuAt(x, y) {
      const header = els.treeRootHeader;
      if (!header || header.hidden) return;
      onRootMenu({ x: x, y: y, returnFocus: focusRootHeader });
    }

    /** ⭐ 未授权态（§2.1.4 的那张表，逐行实现）。 */
    function showUnauthorized(info) {
      setRootHeader(null);
      const slot = clearTreeSlot();
      const box = document.createElement('div');
      box.className = 'unauth';
      box.dataset.unauthorized = '1';

      const title = document.createElement('p');
      title.className = 'unauth-title';
      // ⚠️ 这句是**说明文字**，不是错误——所以不用 `.status-error` 那种红。
      title.textContent = t('sidebar.unauth-title');
      box.appendChild(title);

      const dir = document.createElement('p');
      dir.className = 'unauth-dir';
      // ⚠️ 这个字符串来自**用户自己刚选中的那个文件**的父目录，
      //    后端本来就有（`open_document` 收到的参数），**没有读取任何目录内容**。
      dir.textContent = t('sidebar.unauth-dir', { dir: tilde(info.directory || t('sidebar.unknown')) });
      box.appendChild(dir);

      if (info.file) {
        const item = document.createElement('div');
        item.className = 'unauth-file current';
        item.textContent = info.file;
        item.title = info.filePath || '';
        box.appendChild(item);
      }

      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = t('sidebar.open-this-dir');
      btn.addEventListener('click', function () { opts.onChooseDirectory(); });
      box.appendChild(btn);

      const hint = document.createElement('p');
      hint.className = 'unauth-hint';
      hint.textContent = t('sidebar.unauth-hint');
      box.appendChild(hint);

      slot.appendChild(box);
    }

    /**
     * ⭐ **空会话**（`rmd` 裸跑）时要画的东西：一个入口，外加"上次打开的目录"这条提示。
     *
     * ⚠️ 这份提示是 `design/0003` §2.1.1 第 4 条的**唯一**消费者：
     * 后端一直在把它写进配置（`config/mod.rs` 的 `last_directory`），
     * 而在此之前**没有任何界面读它**——那就是"记了也没用"。
     *
     * ⛔ **它只是提示，不是授权**：两个按钮都**不会**因为"配置里记着"就自动可读
     * （`INV-FS-03`）。⭐ `design/0038` 起它们分岔了：
     *   · 「打开上次的目录」⇒ `opts.onOpenLastDirectory(last)` ⇒ 后端
     *     `open_recent_directory`，**逐字比对后端自己记过的那个串**后才授权
     *     （`INV-START-02`），⛔ 不弹面板；
     *   · 「选另一个目录」⇒ 仍是 `choose_directory`（系统对话框 + 用户当场确认）。
     */
    function showNoDirectory(info) {
      const last = info && info.lastDirectory;
      setRootHeader(null);
      const slot = clearTreeSlot();
      const box = document.createElement('div');
      box.className = 'unauth';
      // ⭐ 冒烟要判"这条提示有没有真的画出来"，所以给个稳定的钩子
      box.dataset.noDirectory = '1';

      const title = document.createElement('p');
      title.className = 'unauth-title';
      title.textContent = t('sidebar.no-dir-title');
      box.appendChild(title);

      if (last) {
        const dir = document.createElement('p');
        dir.className = 'unauth-dir';
        dir.textContent = t('sidebar.last-dir', { dir: tilde(last) });
        dir.title = last;
        box.appendChild(dir);

        const again = document.createElement('button');
        again.className = 'btn primary';
        again.textContent = t('sidebar.open-last-dir');
        // ⭐ `design/0038` §2.1 ⑤：「上次的目录」这个按钮**不该再弹系统面板**——
        //    它是「最近目录」那张启动页的**第二个入口**，两处行为必须同形。
        //    ⚠️ 在此之前它和「选另一个目录」走同一条 `onChooseDirectory`，
        //    于是"按钮承诺的（打开这个）"与"实际做的（让你再选一次）"不符。
        //    ⭐ 判据是 `onOpenLastDirectory` **存不存在**（`main.js` 接线时才给）：
        //    没接线 ⇒ 退回老行为（弹面板），⛔ 不静默什么都不做。
        again.addEventListener('click', function () {
          if (again.dataset.busy === '1') return; // 双击保护（一次点击 = 一次授权命令）
          if (!opts.onOpenLastDirectory) { opts.onChooseDirectory(); return; }
          again.dataset.busy = '1';
          // ⚠️ 失败**不在这里静默吞**：可见提示由界面层做（启动页/状态条那一条）。
          //    这里只负责不让拒绝变成未处理的 Promise。
          Promise.resolve(opts.onOpenLastDirectory(last)).then(
            function () { again.dataset.busy = '0'; },
            function () { again.dataset.busy = '0'; }
          );
        });
        box.appendChild(again);
        box.dataset.lastDirOffer = '1';
      }

      const btn = document.createElement('button');
      btn.className = last ? 'btn' : 'btn primary';
      btn.textContent = last ? t('sidebar.choose-other-dir') : t('sidebar.open-dir-menu');
      btn.addEventListener('click', function () { opts.onChooseDirectory(); });
      box.appendChild(btn);

      const hint = document.createElement('p');
      hint.className = 'unauth-hint';
      // ⭐ 键位**从后端那张表现取**（`INV-SET-01`）：`opts.keyText` 是个**函数**，
      //    因为侧边栏在后端表到手**之前**就建好了，⛔ 不能把当时的值抄下来。
      // ⚠️ 拿不到表时**整句不提键位**——⛔ 不退成手写的 `Cmd+Shift+O`，
      //    那正是"第二份表"，改一次键就静默说错话。
      const openFileKey = opts.keyText ? opts.keyText('file.open-file') : '';
      // ⚠️ 两句是**两条键**（`design/0025` §2.2.1）：带键位那句是模板，⛔ 不在源码里拼。
      hint.textContent = openFileKey
        ? t('sidebar.hint-open-key', { key: openFileKey })
        : t('sidebar.hint-open');
      box.appendChild(hint);

      slot.appendChild(box);
    }

    /** ⛔ 目录授权被收回 / 什么都没打开时，也**不是一个残缺的树**。 */
    function showEmpty(text) {
      setRootHeader(null);
      const slot = clearTreeSlot();
      const box = document.createElement('div');
      box.className = 'unauth';
      const p = document.createElement('p');
      p.className = 'unauth-title';
      p.textContent = text;
      box.appendChild(p);
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = t('sidebar.open-dir-menu');
      btn.addEventListener('click', function () { opts.onChooseDirectory(); });
      box.appendChild(btn);
      slot.appendChild(box);
    }

    /** 大纲视图（复用文档里已有的标题 ID，⛔ 不重新生成）。 */
    function setToc(items) {
      tocItems = items || [];
      els.paneToc.textContent = '';
      if (tocItems.length === 0) {
        const p = document.createElement('p');
        p.className = 'unauth-title';
        p.textContent = t('sidebar.toc-empty');
        els.paneToc.appendChild(p);
        return;
      }
      for (const it of tocItems) {
        const a = document.createElement('a');
        a.className = 'toc-item toc-l' + it.level;
        a.href = '#' + it.id;
        a.textContent = it.text || t('sidebar.untitled');
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          const target = document.getElementById(it.id);
          // ⛔ 不 `window.location.hash = ...`：那会真的导航一次（本项目最怕的"整页重载"）
          if (target) target.scrollIntoView({ block: 'start' });
        });
        els.paneToc.appendChild(a);
      }
    }

    // —— 宽度拖拽（§2.1.1 第 3 条）——
    let dragging = false;
    let pending = 0;
    function onPointerDown(e) {
      dragging = true;
      els.resizer.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
      e.preventDefault();
    }
    function onPointerMove(e) {
      if (!dragging) return;
      const w = Math.round(e.clientX);
      document.documentElement.style.setProperty('--sidebar-width', w + 'px');
      pending = w;
    }
    async function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      try { els.resizer.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
      document.body.classList.remove('resizing');
      if (pending > 0) {
        // ⚠️ 后端会夹取（`MIN/MAX_SIDEBAR_WIDTH`），并以返回值回写——
        //    所以这里用的是**后端给的那个数**，⛔ 不是我们拖到的像素值。
        const applied = await S.setSidebarWidth(pending);
        document.documentElement.style.setProperty('--sidebar-width', applied + 'px');
      }
    }

    /** 把宽度写进 CSS 变量（`--sidebar-width` 模式，取值来自后端配置）。 */
    function applyWidth(width) {
      document.documentElement.style.setProperty('--sidebar-width', width + 'px');
    }

    els.tabTree.addEventListener('click', function () { setTab('tree'); });
    els.tabToc.addEventListener('click', function () { setTab('toc'); });
    // ⭐ `design/0041` §2.3：形态切换**只是一次点击**——写盘与列表加载在 `main.js`
    //    （它才知道会话状态与 IPC）。
    if (els.btnFileView) {
      els.btnFileView.addEventListener('click', function () { onToggleFileView(); });
    }
    els.collapseBtn.addEventListener('click', function () { setCollapsed(true); });
    els.expandBtn.addEventListener('click', function () { setCollapsed(false); });

    // ⭐ `design/0044` §2.2：根头三个入口（`⋯` 点击 / 右键 / `Shift+F10`）**共用同一份动作清单**
    //   ——清单只在 `FileTree::openRootMenu` 里写一次，这里是纯粹的"报坐标"。
    if (els.treeRootMore) {
      els.treeRootMore.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const rect = els.treeRootMore.getBoundingClientRect();
        openRootMenuAt(rect.left, rect.bottom);
      });
    }
    if (els.treeRootHeader) {
      els.treeRootHeader.addEventListener('contextmenu', function (ev) {
        if (ev.defaultPrevented) return;
        ev.preventDefault();
        openRootMenuAt(ev.clientX, ev.clientY);
      });
      els.treeRootHeader.addEventListener('keydown', function (ev) {
        // ⚠️ 组合态与带修饰键一律让路（`INV-SET-05`）；⇧ 不进 `hasModifier`，
        //    所以 `Shift+F10` 照样到得了下面那一句。
        if (ev.defaultPrevented || K.isComposingEvent(ev) || K.hasModifier(ev)) return;
        const isMenuKey = ev.key === 'F10' && ev.shiftKey;
        if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar' && !isMenuKey) return;
        ev.preventDefault();
        const rect = els.treeRootHeader.getBoundingClientRect();
        openRootMenuAt(rect.left + 8, rect.bottom);
      });
    }
    els.sidebar.addEventListener('transitionend', onTransitionEnd);
    els.resizer.addEventListener('pointerdown', onPointerDown);
    els.resizer.addEventListener('pointermove', onPointerMove);
    els.resizer.addEventListener('pointerup', onPointerUp);
    els.resizer.addEventListener('pointercancel', onPointerUp);

    // ⛔ **这里曾经有一段 `Cmd+B` 的 `keydown`，`design/0010` 起已删除。**
    //
    // 那个键的**所有权移交给了菜单**（`owner = Menu`，`INV-SET-04`）：
    // AppKit 在事件送达 key window **之前**就吞掉它（`NSMenu.performKeyEquivalent:`），
    // 所以这里再监听一次**根本收不到**；反过来若它真收到了，就是"一个键两个响应"
    // ——表现是**按一下收起来又弹回去**。
    //
    // ⭐ 现在由 `keymap.js` 按后端那张表统一分发；`view.toggle-sidebar` 的 handler
    // 注册在 `main.js` 里，⛔ 本文件不再认识任何按键。
    // ⚠️ 原来那段还欠着两个保护（没挡 `isComposing`、没挡可编辑焦点）——
    // 那两个现在由 `keymap.js` 的 `dispatch` 统一提供（`INV-SET-05`）。

    /** ⭐ `design/0042`：承认"结果层显示着 / 收起了"（组件那边的状态由它自己管）。 */
    function setSearchActive(on) {
      searchActive = !!on;
      applyPanes();
    }

    /** ⭐ `design/0042`：承认"现在有没有可搜的目录"（单文件 / 空会话 ⇒ 收起输入框）。 */
    function setSearchAvailable(on) {
      searchAvailable = !!on;
      applyPanes();
    }

    return {
      setTab,
      setCollapsed,
      isCollapsed: function () { return collapsed; },
      /** ⭐ `design/0041`：承认一个形态（⛔ 不写盘；真值在会话快照）。 */
      setFileView,
      /** ⭐ `design/0042`：搜索结果层显隐 / 搜索框可用性（面板可见性仍由 `applyPanes` 算）。 */
      setSearchActive,
      setSearchAvailable,
      /** ⭐ `design/0042`：结果层盖着文件页时，树/列表都**不算可见**（`0041` 的时机⑤要据此停手）。 */
      isSearchActive: function () { return searchActive; },
      /** ⭐ 文件那一页**当前看得见**吗（`design/0041` §2.2 的时机 ⑤ 要用它）。 */
      isFilesVisible: function () { return !collapsed && tab === 'tree' && !searchActive; },
      /** ⭐ 当期形态（`"tree"` / `"list"`）。 */
      fileView: function () { return fileView; },
      /** ⭐ 换语言之后重贴形态按钮（`applyDom` 只会贴回出厂那句）。 */
      relabelFileView,
      showUnauthorized,
      showNoDirectory,
      showEmpty,
      /** ⭐ `design/0044`：承认当前根（`null` 隐藏根头）。 */
      setRootHeader,
      /** ⭐ `design/0044`：菜单关掉后把焦点还给根头。 */
      focusRootHeader,
      setToc,
      applyWidth,
      tree,
      els,
    };
  }

  const api = { createSidebar, tilde };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).sidebar = api;
})();
