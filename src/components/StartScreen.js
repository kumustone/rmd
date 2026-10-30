// 启动页 —— `#doc` 空态里那两张表：「最近的目录」与「收藏」（`design/0038` §2.1 ／ `design/0043` §2.6）。
//
// # 它是什么 / 不是什么
//
// 用户 2026-10-24 点题：「打开最近目录不应该去唤醒 mac 本身的 finder，交互体验并不好。
// 我觉得 rmd 启动的时候，可以参考 vim startify 插件的展示。」
// ⇒ 本文件**只画表**，点一行由 `opts.onOpen` / `opts.onOpenFavorite` 去调后端命令
//   （**授权**那一半全在后端，`INV-START-02` / `INV-FAV-03`）。⛔ 本文件不碰 `fetch`/`invoke`、
//   ⛔ 不读 `config.json`、⛔ 不排序（排序与截断都在后端，见 `services/start.js` 模块头）。
//
// # 两个必须一起读的约束
//
// · **`INV-START-01`**：启动页只活在 `#doc` 的空态里。挂载点是 `main.js::showDocEmpty`
//   ——那是**唯一**的空态入口（三个 `showDocEmpty*` 都经过它）⇒ ⛔ 别在别处 `appendChild`
//   一张 `.start-list`：有文档时它必须**不存在**（否则正文被挤开或盖住）。
// · **`INV-START-04`**：本地键盘模型必须先放行五种情形（树/浮层已处理、组合态、
//   覆盖层开着、可编辑焦点、带修饰键）。⚠️ 判据本体在 `services/start.js::guard`，
//   本文件只负责**当场算**那五项事实——⛔ 别在这里另写一份 `if`。
//
// # ⭐ 两段的顺序（`design/0045`，2026-10-25 用户点题）
//
// **收藏在前、最近的目录在后**（用户原话：「收藏的，要放到最近打开目录的上面。」）。
// ⚠️ 版式顺序与 `allEls()` 的焦点顺序**必须同源**——两处各写一份，
// 表现是"↓ 从最后一行跳到看不见的地方"。
//
// # ⭐ 收藏段（`design/0043`）
//
// · **数字键只映射最近表**（`INV-FAV-05`）：两段编号会随收藏条数漂移。
// · 收藏行的动作在**右键菜单**里：取消收藏 / 上移 / 下移（首末行各有一项置灰）。
//   ⚠️ 失效行**同样可操作**——这三个动作都不查可达性（它们只改 `config.json`）。
// · `Shift+F10` 打开同一份菜单。⚠️ 它**过得了** `guard`：`keymap.hasModifier` 只认
//   ⌘/⌃/⌥，⛔ 不认 ⇧（见 `services/keymap.js`）——所以这里不必绕开那道闸门。
//
// # ⭐ 最近段的删除（`design/0045`，隐私）
//
// · 段标题右边一个「清空」：**两步确认**（第一下变「确认清空？」，3 秒内再点才真清）；
//   ⛔ 不用原生 `confirm()`——模态窗口会打断用户，而且离屏探针够不到
//   （判据在 `services/start.js::clearConfirm`，纯逻辑）。
// · 每一行右键 / `Shift+F10` ⇒「从列表移除」（只删这一条历史，⛔ 不删磁盘上的目录）。
// · ⚠️ 两件事都**只改 `config.json` 的 `dir_sessions` ＋ `last_directory`**
//   （后端 `recent_apply`）：⛔ 不删文件、⛔ 不动授权、⛔ 不动收藏。

//
// # 焦点纪律
//
// ⚠️ **不预选、不抢焦点**（§2.1 第 4 条）：`render()` 一行都不 `.focus()`。
// 启动页出现时自动聚焦第一行 ⇒ 用户随手敲个回车就替他把目录打开了。
// 焦点只在用户**自己按 `↑`/`↓`** 时才移动（两张表共用一个顺序）。
//
// # 生命周期
//
// `render(host, recent, favorites)` 可以在同一份 DOM 上反复调（`relabelDynamic()` 换语言、
// 收藏增删后会重画），每次都会**重建行**并复用同一个 `document` 级 keydown 监听；`clear()` 摘监听。
// ⚠️ 监听挂在 `document` 而**不是**宿主节点上：宿主是 `<div>`，不可聚焦，
// 挂在它上面等于永远收不到键（除非用户先点一下它）。
(function () {
  'use strict';

  const Start = (typeof module !== 'undefined' && module.exports)
    ? require('../services/start.js')
    : window.rmd.start;
  const K = (typeof module !== 'undefined' && module.exports)
    ? require('../services/keymap.js')
    : window.rmd.keymap;
  // ⭐ `design/0025`：可见文案走字典（浏览器取 `window.rmd.i18n`，`node --test` 走 `require`）。
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) ||
    (typeof module !== 'undefined' && module.exports ? require('../services/i18n.js') : null);
  const t = I18N ? I18N.t : function (key) { return key; };

  /**
   * @param {object} opts
   *   · `onOpen(root)` —— 必填，返回 Promise（拒绝 ⇒ 这一行标成"打不开"）
   *   · `onOpenFavorite(path)` —— 可选，打开一条收藏（缺省 = 收藏行不响应点击）
   *   · `onUnfavorite(path)` —— 可选，收藏行菜单「取消收藏」
   *   · `onMoveFavorite(path, delta)` —— 可选，收藏行菜单「上移 / 下移」（`delta` = ∓1）
   *   · ⭐ `onForgetRecent(root)` —— 可选，最近行菜单「从列表移除」（`design/0045`）
   *   · ⭐ `onClearRecent()` —— 可选，「清空」第二下确认之后（`design/0045`）
   *   · `onError(err, target)` —— 可选，界面层通报（状态栏一句，`INV-START-07`）
   *   · `overlayOpen()` —— 必填，任一覆盖层开着吗（`Settings`/`QuickOpen`/`FindBar`/`ImageViewer`）
   */
  function createStartScreen(opts) {
    const onOpen = opts.onOpen;
    const onOpenFavorite = opts.onOpenFavorite || function () { return null; };
    const onUnfavorite = opts.onUnfavorite || function () {};
    const onMoveFavorite = opts.onMoveFavorite || function () {};
    const onForgetRecent = opts.onForgetRecent || function () {};
    const onClearRecent = opts.onClearRecent || function () {};
    const onError = opts.onError || function () {};
    const overlayOpen = opts.overlayOpen || function () { return false; };

    /** 当前挂载的容器（`null` = 没显示）。 */
    let box = null;
    /** 与 `rowEls` 一一对应的数据（`services/start.js::rows` 的产物，**最近表**）。 */
    let data = [];
    let rowEls = [];
    /** 收藏段的数据与行（`services/start.js::favoriteRows` 的产物）。 */
    let favData = [];
    let favEls = [];
    /**
     * 行菜单（两张表共用，`design/0043` §2.3 ／ `design/0045`）。
     * ⚠️ 网页里的一层，⛔ 不是原生菜单——探针要能读到它。
     */
    let rowMenu = null;
    let rowMenuCleanup = null;
    /** 打开菜单的那一行（`Escape` 要把焦点还给它，⛔ 不还成 `body`）。 */
    let rowMenuOwner = null;
    /** ⭐ 「清空」的第一下是什么时候按的（`0` = 没有待确认的那一下）。 */
    let clearArmedAt = 0;
    /** 武装态的自动复位定时器（⚠️ 重画 / 卸载时必须清掉，否则它会去改一行已删除的按钮）。 */
    let clearTimer = null;
    /** 监听是否已挂——⚠️ 只挂一次，重画不重挂。 */
    let bound = false;

    /**
     * 两张表共用的焦点顺序：**收藏在前、最近在后**（`design/0045`，与版式同源）。
     * ⚠️ ⛔ 别写 `rowEls.concat(favEls)`——那是上一版的顺序，用户明确要求收藏在上。
     */
    function allEls() { return favEls.concat(rowEls); }

    // ── 键盘模型（§2.1 第 4 条）─────────────────────────────────────────

    function onKeyDown(e) {
      if (!box) return;
      // ⚠️ 五项**当场现算**：`defaultPrevented` 必须在别的处理器已经跑过之后才准
      //   （⭐ 这正是"给 `FileTree` 让路"的判据，⛔ 别缓存它）。
      const ignore = Start.guard({
        defaultPrevented: e.defaultPrevented,
        modifier: K.hasModifier(e),
        composing: K.isComposingEvent(e),
        overlay: overlayOpen(),
        editable: K.isEditableElement(document.activeElement),
      });
      if (ignore) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        move(e.key === 'ArrowDown' ? 1 : -1, e);
        return;
      }
      // ⭐ `design/0043` §2.3 ／ `design/0045`：两张表的行菜单键。⚠️ ⇧ 不是 `hasModifier`
      //   认的修饰键 ⇒ 这个键**过得了**上面那道闸门，不必为它破例。
      if (e.key === 'F10' && e.shiftKey) {
        const favAt = favEls.indexOf(document.activeElement);
        if (favAt >= 0) {
          e.preventDefault();
          openFavMenu(favAt, null, null);
          return;
        }
        const recAt = rowEls.indexOf(document.activeElement);
        if (recAt >= 0) {
          e.preventDefault();
          openRecentMenu(recAt, null, null);
        }
        return;
      }
      const idx = Start.digitIndex(e.key);
      if (idx >= 0 && idx < rowEls.length) {
        e.preventDefault();
        activate(idx);
      }
    }

    /**
     * `↑`/`↓` 移焦点。⚠️ 逻辑是"**在行之间**走"（最近表 → 收藏表连续），不是"列表滚动"——
     * 所以只在**真的移动了**焦点时才 `preventDefault`（到边界就让键继续走，
     * 万一哪天 `#doc` 出现了滚动条，用户还能用方向键滚）。
     */
    function move(delta, e) {
      const els = allEls();
      if (els.length === 0) return;
      const at = els.indexOf(document.activeElement);
      // 没有焦点时：↓ 进第一行、↑ 进最后一行（⛔ 不预选的反面：只有用户按了才动）
      let next;
      if (at < 0) next = delta > 0 ? 0 : els.length - 1;
      else {
        next = at + delta;
        if (next < 0 || next >= els.length) return;
      }
      e.preventDefault();
      els[next].focus();
    }

    /**
     * 打开最近表第 `i` 行。⚠️ `busy` 是**双触发保护**：点一下 + 键盘敲同一个数字
     * （或双击）会让后端收到两条授权命令，代次 +2、树重挂两次——
     * 症状是"点一次，侧边栏闪两下"（功能没坏，但看着像卡了）。
     */
    function activate(i) {
      const el = rowEls[i];
      const r = data[i];
      if (!el || !r || el.dataset.busy === '1') return;
      el.dataset.busy = '1';
      runOpen(el, r.root, function () { return onOpen(r.root); });
    }

    /** 打开收藏表第 `i` 行（同一条双触发保护与失败可见，`INV-START-07`）。 */
    function activateFavorite(i) {
      const el = favEls[i];
      const r = favData[i];
      if (!el || !r || el.dataset.busy === '1') return;
      el.dataset.busy = '1';
      runOpen(el, r.path, function () { return onOpenFavorite(r.path); });
    }

    function runOpen(el, target, call) {
      let p;
      try {
        p = call();
      } catch (err) {
        fail(el, err, target);
        return;
      }
      Promise.resolve(p).catch(function (err) { fail(el, err, target); });
    }

    /**
     * ⭐ `INV-START-07`：打不开必须**可见**——行标 `data-missing`（变灰 ＋ 一句提示），
     * 外加交给界面层的那一句（状态栏）。
     * ⚠️ 不清 `data-busy`：这一行点过一次就维持"不可用"直到下一次重画——
     * 目标可能只是**暂时**不可达（外置盘没插），重画（换语言/刷新）会再来一次。
     */
    function fail(el, err, target) {
      el.dataset.missing = '1';
      el.title = favEls.indexOf(el) >= 0 ? t('start.fav-missing') : t('start.row-missing');
      onError(err, target);
    }

    // ── 行菜单（`design/0043` §2.3 收藏行 ／ `design/0045` 最近行）───────────

    /**
     * 打开一层行菜单——**两张表共用这一份构造**（菜单项与顺序由调用方给）。
     * ⚠️ 复制两段（一段给收藏、一段给最近）会分叉出两种"关闭方式"，
     *    而其中一种总会漏掉 `Escape` 还焦点那一步。
     *
     * @param {HTMLElement} owner 打开菜单的那一行（`Escape` 要把焦点还给它）
     * @param {Array<{key:string, run:function, disabled:boolean}>} items 菜单项（`key` 走字典）
     * @param {number|null} x 视口坐标；`null` = 键盘触发，落在那一行的左下角
     * @param {number|null} y
     */
    function openRowMenu(owner, items, x, y) {
      if (!owner) return;
      closeRowMenu(false);
      const menu = document.createElement('div');
      menu.className = 'start-menu';
      menu.setAttribute('role', 'menu');

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'start-menu-item';
        b.setAttribute('role', 'menuitem');
        b.tabIndex = -1;
        b.textContent = t(it.key);
        if (it.disabled) {
          b.disabled = true;
          b.classList.add('disabled');
        } else {
          b.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            closeRowMenu(false);
            it.run();
          });
        }
        menu.appendChild(b);
      }

      menu.style.left = '0px';
      menu.style.top = '0px';
      document.body.appendChild(menu);
      const boxRect = menu.getBoundingClientRect();
      const at = owner.getBoundingClientRect();
      const px = typeof x === 'number' ? x : at.left + 8;
      const py = typeof y === 'number' ? y : at.bottom;
      menu.style.left = Math.max(4, Math.min(px, window.innerWidth - boxRect.width - 4)) + 'px';
      menu.style.top = Math.max(4, Math.min(py, window.innerHeight - boxRect.height - 4)) + 'px';

      rowMenu = menu;
      rowMenuOwner = owner;
      const onDown = function (ev) { if (!rowMenu || !rowMenu.contains(ev.target)) closeRowMenu(false); };
      const onKey = function (ev) {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        // ⭐ 设计 §2.3：`Escape` 关闭并把焦点**还给那一行**（否则焦点掉到 `body`）。
        closeRowMenu(true);
      };
      const onScroll = function () { closeRowMenu(false); };
      const onResize = function () { closeRowMenu(false); };
      setTimeout(function () {
        if (rowMenu !== menu) return;
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
      }, 0);
      rowMenuCleanup = function () {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
      };
      if (typeof x !== 'number') {
        // 键盘触发：焦点进菜单第一项（可发现性），⛔ 不抢——用户刚按的就是这个键。
        const first = menu.querySelector('.start-menu-item');
        if (first) first.focus();
      }
    }

    /**
     * 收藏行的菜单：取消收藏 / 上移 / 下移。
     * @param {number} i 收藏行下标
     */
    function openFavMenu(i, x, y) {
      const el = favEls[i];
      const r = favData[i];
      if (!el || !r) return;
      openRowMenu(el, [
        { key: 'start.menu.unfavorite', run: function () { onUnfavorite(r.path); } },
        // ⚠️ 「上移 / 下移」的**目标下标**由 `session.js` 在队首执行时现算，
        //    这里只表达"往哪个方向"——两处各算一份就会分叉。
        {
          key: 'start.menu.move-up',
          run: function () { onMoveFavorite(r.path, -1); },
          disabled: i === 0,
        },
        {
          key: 'start.menu.move-down',
          run: function () { onMoveFavorite(r.path, 1); },
          disabled: i === favData.length - 1,
        },
      ], x, y);
    }

    /**
     * 最近行的菜单（`design/0045`）：只有「从列表移除」。
     * ⚠️ 传的是**后端给的原串** `r.root`（⛔ 不是屏幕上那个 `~` 缩写）。
     */
    function openRecentMenu(i, x, y) {
      const el = rowEls[i];
      const r = data[i];
      if (!el || !r) return;
      openRowMenu(el, [
        { key: 'start.menu.forget', run: function () { onForgetRecent(r.root); } },
      ], x, y);
    }

    /** @param {boolean} restoreFocus `true` = 把焦点还给打开菜单的那一行（`Escape` 用）。 */
    function closeRowMenu(restoreFocus) {
      const owner = rowMenuOwner;
      if (rowMenuCleanup) { rowMenuCleanup(); rowMenuCleanup = null; }
      if (rowMenu && rowMenu.parentNode) rowMenu.parentNode.removeChild(rowMenu);
      rowMenu = null;
      rowMenuOwner = null;
      if (restoreFocus && owner && owner.isConnected) owner.focus();
    }

    // ── 渲染 ────────────────────────────────────────────────────────────

    /**
     * 把启动页画进 `host`（`main.js` 建的 `.doc-empty`）。
     * ⚠️ 两张表都为空 ⇒ **什么都不画**（与今天逐字节相同，§2.1 第 2 条）——
     * `host` 里那句提示语是 `main.js` 写的，本文件⛔ 不动它。
     */
    function render(host, recent, favorites) {
      data = Start.rows(recent);
      favData = Start.favoriteRows(favorites);
      clearDom();
      if (!host || (data.length === 0 && favData.length === 0)) {
        box = null;
        rowEls = [];
        favEls = [];
        unbind();
        return;
      }
      box = document.createElement('div');
      box.className = 'start';

      // ⭐ `design/0045`（用户 2026-10-25 点题）：「收藏」在**上面**、「最近的目录」在下面。
      //    ⚠️ 视觉顺序与 `allEls()` 必须同源，⛔ 别只改这里（`B7` 判据就是这一条）。
      //    ⚠️ `.start-fav-title` 这个类**留着**是给探针认段用的，样式已不再靠它加间距。
      if (favData.length) {
        const title = document.createElement('p');
        title.className = 'start-title start-fav-title';
        title.textContent = t('start.fav-title');
        box.appendChild(title);

        const list = document.createElement('div');
        list.className = 'start-list start-fav-list';
        list.setAttribute('role', 'list');
        favEls = [];
        for (let i = 0; i < favData.length; i++) {
          const r = favData[i];
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'start-row start-fav-row';
          btn.setAttribute('role', 'listitem');
          btn.title = r.path;
          // ⚠️ ⛔ 这里不画数字：两段编号会随收藏条数漂移（`INV-FAV-05`）。
          btn.addEventListener('click', (function (idx) {
            return function () { activateFavorite(idx); };
          })(i));
          // 右键 / `Shift+F10` 的同一个入口（两个来源共用一份动作清单）
          btn.addEventListener('contextmenu', (function (idx) {
            return function (ev) {
              if (ev.defaultPrevented) return;
              ev.preventDefault();
              openFavMenu(idx, ev.clientX, ev.clientY);
            };
          })(i));

          const name = document.createElement('span');
          name.className = 'start-name';
          name.textContent = r.name;
          btn.appendChild(name);

          const path = document.createElement('span');
          path.className = 'start-path';
          path.textContent = r.tilded;
          btn.appendChild(path);

          list.appendChild(btn);
          favEls.push(btn);
        }
        box.appendChild(list);
      }

      if (data.length) {
        // ⭐ `design/0045`：段标题右边一个「清空」（两步确认，见 `onClearClick`）。
        // ⚠️ 它是 `<button>` 而不是 `<a href="#">`：原生可聚焦、`Enter`/`Space` 原生触发。
        const head = document.createElement('div');
        head.className = 'start-head';

        const title = document.createElement('p');
        title.className = 'start-title';
        title.textContent = t('start.recent-title');
        head.appendChild(title);

        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'start-clear';
        // ⚠️ 文案与 `title` 都是**翻译过的**⇒ 只留在字典里，⛔ 不进 `data-*`（`INV-I18N-04`）
        clear.textContent = t('start.recent-clear');
        clear.title = t('start.recent-clear-hint');
        clear.addEventListener('click', onClearClick);
        head.appendChild(clear);

        box.appendChild(head);

        const list = document.createElement('div');
        list.className = 'start-list';
        list.setAttribute('role', 'list');
        rowEls = [];
        for (let i = 0; i < data.length; i++) {
          const r = data[i];
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'start-row';
          btn.setAttribute('role', 'listitem');
          // ⭐ 原生 `title` 给全路径：行里显示的是 `~` 缩写，悬停能看全
          btn.title = r.root;
          // ⚠️ `data-*` 只放**机器读**的标记（`last` / `missing` / `busy`），
          //    ⛔ 不放翻译后的文案（`INV-I18N-04`）。
          if (r.last) btn.dataset.last = '1';
          // ⚠️ 路径**不进 DOM 属性**：它已经在 `title` 里，再存一份就是第二个真值
          //    （有人改了 `title` 忘了这里，点击就打向旧路径）。
          btn.addEventListener('click', (function (idx) {
            return function () { activate(idx); };
          })(i));
          // ⭐ `design/0045`：右键 / `Shift+F10` ⇒「从列表移除」（只删这条历史）。
          btn.addEventListener('contextmenu', (function (idx) {
            return function (ev) {
              if (ev.defaultPrevented) return;
              ev.preventDefault();
              openRecentMenu(idx, ev.clientX, ev.clientY);
            };
          })(i));

          // ① 数字（与键盘映射同一套口径，⛔ 不写成"第 n 行"）
          if (i < 9) {
            const num = document.createElement('span');
            num.className = 'start-num';
            num.textContent = String(i + 1);
            btn.appendChild(num);
          }
          // ② 目录名
          const name = document.createElement('span');
          name.className = 'start-name';
          name.textContent = r.name;
          btn.appendChild(name);
          // ③ 路径（`~` 缩写）
          const path = document.createElement('span');
          path.className = 'start-path';
          path.textContent = r.path;
          btn.appendChild(path);
          // ④ 上次读的文件名（有才画）
          if (r.file) {
            const file = document.createElement('span');
            file.className = 'start-file';
            file.textContent = r.file;
            btn.appendChild(file);
          }
          // ⑤ 「上次打开」标记（⚠️ 只有那一条有）
          if (r.last) {
            const mark = document.createElement('span');
            mark.className = 'start-last';
            mark.textContent = t('start.last-mark');
            btn.appendChild(mark);
          }

          list.appendChild(btn);
          rowEls.push(btn);
        }
        box.appendChild(list);
      }

      host.appendChild(box);
      bind();
    }

    // ── 「清空」的两步确认（`design/0045`）─────────────────────────────

    /** 把按钮恢复成"没武装"的样子（复位文案与 `data-armed`）。 */
    function resetClearButton(btn) {
      if (!btn) return;
      delete btn.dataset.armed;
      btn.textContent = t('start.recent-clear');
    }

    /** 取消武装态并清掉定时器（重画 / 卸载 / 已执行时调）。 */
    function disarmClear() {
      if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
      clearArmedAt = 0;
    }

    /**
     * 「清空」按钮的点击：**第一下只武装，第二下才真清**（判据在 `Start.clearConfirm`）。
     * ⚠️ 定时器必须兜底复位：留一个"确认清空？"在屏上，用户可能过一阵才回来点它，
     *    那时他早忘了自己按过第一下。
     */
    function onClearClick(ev) {
      const btn = ev.currentTarget;
      const r = Start.clearConfirm(clearArmedAt, Date.now());
      clearArmedAt = r.nextArmedAt;
      if (!r.fire) {
        btn.dataset.armed = '1';
        btn.textContent = t('start.recent-clear-confirm');
        if (clearTimer) clearTimeout(clearTimer);
        clearTimer = setTimeout(function () {
          clearTimer = null;
          clearArmedAt = 0;
          resetClearButton(btn);
        }, Start.CLEAR_CONFIRM_MS);
        return;
      }
      disarmClear();
      resetClearButton(btn);
      // ⚠️ 失败**不在这里吞**：`onClearRecent` 的实现负责给状态栏那句话
      //    （与 `onUnfavorite` 同一条纪律）；这里只保证不额外抛到 window。
      try {
        const p = onClearRecent();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (err) {
        console.error('清空最近目录失败：', err);
      }
    }

    /** 只摘本文件建的那块（`host` 里别的节点是 `main.js` 的）。 */
    function clearDom() {
      closeRowMenu(false);
      disarmClear();
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null;
    }

    function bind() {
      if (bound) return;
      document.addEventListener('keydown', onKeyDown);
      bound = true;
    }

    function unbind() {
      if (!bound) return;
      document.removeEventListener('keydown', onKeyDown);
      bound = false;
    }

    /** 摘干净（`main.js` 在正文挂上时调；⚠️ 空态被重画时由 `render` 自己收）。 */
    function clear() {
      clearDom();
      data = [];
      rowEls = [];
      favData = [];
      favEls = [];
      unbind();
    }

    /** 现在有几行最近目录（冒烟/测试读它，⛔ 别拿 DOM 数量去猜）。 */
    function count() { return data.length; }

    /** 现在有几行收藏（同上）。 */
    function favoriteCount() { return favData.length; }

    /** 现在是不是正挂着（空态重画前要判它，⛔ 别拿 `count()` 顶替：只收藏时它也是 0）。 */
    function visible() { return !!box; }

    return {
      render: render,
      clear: clear,
      count: count,
      favoriteCount: favoriteCount,
      visible: visible,
    };
  }

  const api = { createStartScreen: createStartScreen };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).startScreen = api;
})();
