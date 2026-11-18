// `⌘O` 打开面板 —— `design/0071` §3（阶段 2，2026-11-14 已通过）。
//
// # 它是什么
//
// 一个**只选、不输入**的浮层：`⌘O` 出来、`↑`/`↓` 在「最近」里移动、`Enter` 打开、
// `Esc` 走。下面固定两行「浏览目录…」「浏览文件…」——即"目录入口搬进了面板"
// （§3.2：`⌘O` 不再是直接弹系统目录面板）。`⇧⌘O` 仍是系统文件面板，⛔ 不动。
//
// # 为什么是 DOM 面板而不是系统面板
//
// 「最近」是 rmd 自己的状态（`config.dir_sessions`），系统面板不认识它；
// 而 `§3.1` 要求第一屏就是最近 ⇒ 系统面板只能接第二个动作，用户还得多点一下。
//
// # 它与 `design/0010` / `INV-SET-07` 的关系
//
// · `⌘O` 登记在 Rust 那张唯一表里（`INV-SET-01`），本文件**没有键位字面量**；
//   `↑`/`↓`/`Enter`/`Esc` 是**面板自己的**键盘模型，只在它开着时生效。
// · 与设置 / 搜索 / 查找 / 图片**互斥**：注册进 `Settings.registerOverlay`，
//   开一个就关另一个（焦点主人只能有一个）。
//
// # 数据只有一份（`INV-OPEN-05`）
//
// ⛔ 本组件**不缓存**快照：每次 `open()` 现取一次（调用方给的是 `S.state.recent`，
// 与启动页同一个字段）。「在启动页删掉一条最近目录，面板同步消失」这条验收
// 靠的就是这一点——两处各缓存一份的话它们迟早显示不同。
(function () {
  'use strict';

  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) ||
    (typeof module !== 'undefined' && module.exports ? require('../services/i18n.js') : null);
  const t = I18N ? I18N.t : function (key) { return key; };

  const K = (typeof module !== 'undefined' && module.exports) ? require('../services/keymap.js') : window.rmd.keymap;
  const OP = (typeof module !== 'undefined' && module.exports) ? require('../services/openpanel.js') : window.rmd.openpanel;
  const St = (typeof module !== 'undefined' && module.exports) ? require('./Settings.js') : window.rmd.settings;

  /** 覆盖层名（登记处的键，也是 `closeOtherOverlays` 认得的名字）。 */
  const NAME = 'open-panel';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * 建面板。⚠️ DOM 由本文件建（⛔ 不在 `index.html` 里写死——两份要同步的东西
   * 迟早分叉，与设置覆盖层 / `QuickOpen` 同一条理由）。
   *
   * @param {object} opts
   * @param {() => Array} opts.recent ⭐ 现取「最近」（`S.state.recent`，⛔ 不缓存）
   * @param {(row:object) => void} opts.onPick 选中之后干什么（行原样递出去）
   */
  function createOpenPanel(opts) {
    const getRecent = opts.recent || function () { return []; };
    const onPick = opts.onPick || function () {};

    let opened = false;
    let restoreTo = null;
    /** 当刻的全部可选中行（最近行 + 两条浏览行；⛔ 不含小标题/分隔线）。 */
    let items = [];
    let selected = -1;

    // ── DOM ──────────────────────────────────────────────────────────
    const root = el('div', 'openpanel-layer');
    root.hidden = true;
    const scrim = el('div', 'openpanel-scrim');
    const panel = el('div', 'openpanel-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'openpanel-title');
    panel.tabIndex = -1;

    const title = el('h2', 'openpanel-title', t('open.title'));
    title.id = 'openpanel-title';
    title.setAttribute('data-i18n', 'open.title');

    const list = el('ul', 'openpanel-list');
    list.id = 'openpanel-list';
    list.setAttribute('role', 'listbox');
    // ⚠️ 焦点在**面板本身**（不是某一行）：这一层没有输入框，
    //    行是 `option`、由 `aria-selected` 与 `aria-activedescendant` 表达选中。
    panel.setAttribute('aria-controls', 'openpanel-list');

    panel.appendChild(title);
    panel.appendChild(list);
    root.appendChild(scrim);
    root.appendChild(panel);
    document.body.appendChild(root);

    // ── 渲染 ─────────────────────────────────────────────────────────

    /** 一行的可读名字（`aria-label` 与浏览行正文共用一个来源）。 */
    function rowLabel(row) {
      if (row.kind === 'browse') {
        return row.target === 'dir' ? t('open.browse-dir') : t('open.browse-file');
      }
      if (row.kind === 'file') return t('open.row-file', { name: row.name });
      return t('open.row-dir', { name: row.name });
    }

    function buildItemRow(row, i) {
      const li = el('li', 'openpanel-item');
      li.id = 'openpanel-item-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === selected ? 'true' : 'false');
      if (i === selected) li.classList.add('selected');
      // ⭐ 行名走 `aria-label`：目录行与文件行的正文里都有"名字 + 路径"两段，
      //    读屏一口气念两遍路径没有意义（名字 + 一句"打开 …"才是动作）。
      li.setAttribute('aria-label', rowLabel(row));

      if (row.kind === 'browse') {
        li.classList.add('openpanel-browse');
        li.appendChild(el('span', 'openpanel-name', rowLabel(row)));
        return li;
      }

      const kind = el('span', 'openpanel-kind', row.kind === 'file' ? '·' : '▸');
      kind.setAttribute('aria-hidden', 'true');
      li.appendChild(kind);
      // ⚠️ 路径与文件名是**用户数据**，只走 `textContent`（与 `FileTree`/`QuickOpen` 同一条纪律）。
      li.appendChild(el('span', 'openpanel-name', row.name));
      li.appendChild(el('span', 'openpanel-dir', row.dir));
      if (row.last) li.appendChild(el('span', 'openpanel-last', t('start.last-mark')));
      return li;
    }

    function renderList() {
      list.textContent = '';
      // ⚠️ 分两段取：小标题/空态只在**最近行**为空与否上分支，浏览行恒定存在。
      const recentRows = items.filter(function (r) { return r.kind !== 'browse'; });
      if (recentRows.length) {
        const head = el('li', 'openpanel-section', t('open.recent'));
        head.setAttribute('role', 'presentation');
        list.appendChild(head);
        for (let i = 0; i < items.length; i++) {
          if (items[i].kind === 'browse') break;
          list.appendChild(buildItemRow(items[i], i));
        }
        const sep = el('li', 'openpanel-sep');
        sep.setAttribute('role', 'presentation');
        list.appendChild(sep);
      } else {
        // ⭐ 空态：一句说明 + 下面就是两条浏览行（`§3.1`）。焦点由 `selected = 0` 落在
        //    「浏览目录…」上——空列表里回车不该什么也不发生。
        const empty = el('li', 'openpanel-empty', t('open.empty'));
        empty.setAttribute('role', 'presentation');
        list.appendChild(empty);
      }
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== 'browse') continue;
        list.appendChild(buildItemRow(items[i], i));
      }
      if (selected >= 0) panel.setAttribute('aria-activedescendant', 'openpanel-item-' + selected);
      else panel.removeAttribute('aria-activedescendant');
    }

    /** 只改选中项（⛔ 不重建整张表：重建会丢滚动位置）。 */
    function renderSelection() {
      const rows = list.querySelectorAll('.openpanel-item');
      for (let i = 0; i < rows.length; i++) {
        const on = i === selected;
        rows[i].classList.toggle('selected', on);
        rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
      }
      if (selected >= 0) {
        panel.setAttribute('aria-activedescendant', 'openpanel-item-' + selected);
        const row = rows[selected];
        if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
      } else {
        panel.removeAttribute('aria-activedescendant');
      }
    }

    // ── 键盘（本层自己的，⛔ 与全局分发器不重叠）────────────────────

    function move(delta) {
      if (!items.length) return;
      selected = OP.move(selected, delta, items.length);
      renderSelection();
    }

    function pick(i) {
      const row = items[i];
      if (!row) return;
      // ⚠️ 先关再打开：打开可能要几百毫秒（授权 + 读盘），面板挡在上面会让人以为没反应
      //    （与 `QuickOpen` 同一条）。失败由 `main.js` 走 `#fail-bar`，⛔ 不在面板里报。
      close();
      onPick(row);
    }

    function onKeydown(e) {
      if (!opened) return;
      // ⭐ 组合态先挡（`INV-SET-05`）：输入法候选窗开着时回车是"上屏"。
      if (K.isComposingEvent(e)) return;

      // ⭐ 按键 → 动作的判据在 `services/openpanel.js`（纯函数、可单测）；
      //    本文件只负责"拦下 + 干活"。⛔ 别在这里另写一份 `if`。
      const act = OP.actionForKey(e);
      if (!act) return;                 // 其余键放行：全局键由 `main.js` 的分发器管
      e.preventDefault();
      e.stopPropagation();
      if (act === 'close') { close(); return; }
      if (act === 'down') { move(1); return; }
      if (act === 'up') { move(-1); return; }
      if (act === 'pick') { pick(selected); return; }
      if (act === 'focus') { panel.focus(); return; }  // 焦点陷阱：本层没有可聚焦子元素
    }

    // ⚠️ 用 **capture**（与 `QuickOpen`/`FindBar` 同一条）：`Esc`/方向键/回车都得在
    //    页面其余部分看到之前拦下；挂在 `document` 上 ⇒ 焦点万一跑掉，`Esc` 仍能关。
    // ⭐ 切语言：小标题、空态、行名与「上次打开」标记全是现算的 ⇒ 整张表重画。
    if (I18N) {
      I18N.subscribe(function () {
        if (!opened) return;
        renderList();
      });
    }

    document.addEventListener('keydown', onKeydown, true);
    list.addEventListener('click', function (e) {
      const row = e.target && e.target.closest ? e.target.closest('.openpanel-item') : null;
      if (!row) return;
      const rows = Array.prototype.slice.call(list.querySelectorAll('.openpanel-item'));
      pick(rows.indexOf(row));
    });
    list.addEventListener('mousemove', function (e) {
      const row = e.target && e.target.closest ? e.target.closest('.openpanel-item') : null;
      if (!row) return;
      const rows = Array.prototype.slice.call(list.querySelectorAll('.openpanel-item'));
      const i = rows.indexOf(row);
      if (i >= 0 && i !== selected) { selected = i; renderSelection(); }
    });
    scrim.addEventListener('click', function () { close(); });

    // ── 开 / 关 ──────────────────────────────────────────────────────

    /**
     * 打开面板。⭐ **每次打开都现取一次 `recent`**（`INV-OPEN-05`）——
     * ⛔ 不在 `create*` 时缓存，否则启动页那边删掉一条之后面板里还在。
     */
    function open() {
      if (opened) return true;
      // ⭐ 开一个就关另一个（`INV-SET-07`）。
      St.closeOtherOverlays(NAME);
      restoreTo = document.activeElement;
      opened = true;
      const recent = getRecent();
      items = OP.buildRows(recent).concat(OP.browseRows());
      selected = OP.initialSelection(items);
      renderList();
      root.hidden = false;
      document.body.classList.add('openpanel-open');
      panel.focus();
      return true;
    }

    function close() {
      if (!opened) return;
      opened = false;
      root.hidden = true;
      document.body.classList.remove('openpanel-open');
      // ⭐ 把焦点还给它打开前的那个元素（`INV-SET-07`）——不还的话焦点掉到 `body` 上，
      //    键盘用户下次按 Tab 要重新找一遍。
      const back = restoreTo;
      restoreTo = null;
      if (back && typeof back.focus === 'function' && document.contains(back)) {
        try { back.focus(); } catch (e) { /* 已不可聚焦就作罢，⛔ 不抛 */ }
      }
      if (St.currentFocusOwner() === NAME) St.releaseFocusOwner(NAME);
    }

    const handle = {
      open: open,
      close: close,
      isOpen: function () { return opened; },
      /** ⚠️ 给离屏探针 / 冒烟用：现在有几行、选中的是第几行。 */
      count: function () { return items.length; },
      selected: function () { return selected; },
      destroy: function () {
        document.removeEventListener('keydown', onKeydown, true);
        if (root.parentNode) root.parentNode.removeChild(root);
      },
    };

    // ⭐ 注册进**唯一那个**登记处（与设置 / 搜索 / 查找 / 图片共用，`INV-SET-07`）。
    St.registerOverlay(NAME, handle);
    return handle;
  }

  const api = { createOpenPanel: createOpenPanel, NAME: NAME };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).openPanel = api;
})();
