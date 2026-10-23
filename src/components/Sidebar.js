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

    let collapsed = false;
    let tocItems = [];

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
      for (const t of [['tree', els.tabTree], ['toc', els.tabToc]]) {
        const on = t[0] === name;
        t[1].classList.toggle('active', on);
        t[1].setAttribute('aria-selected', on ? 'true' : 'false');
        t[1].tabIndex = on ? 0 : -1;
      }
      els.paneTree.hidden = name !== 'tree';
      els.paneToc.hidden = name !== 'toc';
      onTabChange(name, els.sidebar.scrollTop);
    }

    /** ⭐ 未授权态（§2.1.4 的那张表，逐行实现）。 */
    function showUnauthorized(info) {
      els.paneTree.textContent = '';
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

      els.paneTree.appendChild(box);
    }

    /**
     * ⭐ **空会话**（`rmd` 裸跑）时要画的东西：一个入口，外加"上次打开的目录"这条提示。
     *
     * ⚠️ 这份提示是 `design/0003` §2.1.1 第 4 条的**唯一**消费者：
     * 后端一直在把它写进配置（`config/mod.rs` 的 `last_directory`），
     * 而在此之前**没有任何界面读它**——那就是"记了也没用"。
     *
     * ⛔ **它只是提示，不是授权**：按钮走的是同一条 `choose_directory`
     * （系统对话框 + 用户确认），⛔ 不因为"配置里记着"就自动可读（`INV-FS-03`）。
     */
    function showNoDirectory(info) {
      const last = info && info.lastDirectory;
      els.paneTree.textContent = '';
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
        again.addEventListener('click', function () { opts.onChooseDirectory(); });
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

      els.paneTree.appendChild(box);
    }

    /** ⛔ 目录授权被收回 / 什么都没打开时，也**不是一个残缺的树**。 */
    function showEmpty(text) {
      els.paneTree.textContent = '';
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
      els.paneTree.appendChild(box);
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
    els.collapseBtn.addEventListener('click', function () { setCollapsed(true); });
    els.expandBtn.addEventListener('click', function () { setCollapsed(false); });
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

    return {
      setTab,
      setCollapsed,
      isCollapsed: function () { return collapsed; },
      showUnauthorized,
      showNoDirectory,
      showEmpty,
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
