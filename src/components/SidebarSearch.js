// 侧边栏底部的**常驻文件名搜索框** —— `design/0042-侧边栏文件名搜索.md`（2026-10-24）。
//
// # 它是什么 / 不是什么
//
// ⭐ 一个**常驻**的输入框（文件页的最下方），结果就地画在侧边栏里，**覆盖**当前
// 树 / 列表所占的那块面积——两个原面板都**不卸载**（切 `hidden`，`design/0041` R4/R5：
// 树的展开态与滚动位置、列表的分片进度都原样留着）。
// ⛔ 它**不是** `design/0009` §2.2 备选 B 那条"只过滤已展开项"的侧栏过滤框：
// 那份否决理由是"用户要找的正是**不知道在哪一层**的文件"，而这里搜的是**全量索引**
// （`session.searchFiles` → `fs/tree.rs::search`，与 `⌘P` 同一份实现）⇒ 否决理由不成立。
// 留痕与边界见 `design/0042` §2.2。
//
// # ⭐ 与 `⌘P` 逐条同源
//
// | 这件事 | 谁做 |
// |---|---|
// | 匹配与排序 | Rust `fs/tree.rs::search`（`INV-SINGLE-01`） |
// | 字节区间 → UTF-16 | `services/search.js::segments`（`INV-SEARCH-03`） |
// | 竞态（先发后回 / 切根） | `session.js::searchFiles` 的 `req` ＋ 代次 |
// | 第一次输入时重建索引 | `services/sidebarsearch.js::planQuery`（`INV-SEARCH-06` 同一条时机） |
// | 刷新键 | **从后端那张表里认**（`INV-SET-01`）——本文件里⛔ 没有键位字面量 |
//
// # ⛔ 这里不做的三件事
//
// ① **不匹配**（同上）；② **不建第二份索引**：第一次输入时 `rebuild=true`，
//    之后只查不重建——与 `⌘P` 浮层"打开时重建一次"同一条时机。
//    每次都重建 ⇒ 每个键都等一次全树遍历；从不重建 ⇒ 新文件永远搜不到。
// ③ **不抢全局键盘**：本层的 `keydown` 只挂在输入框上（⛔ 不是 `document` capture），
//    因为输入框是常驻的、用户要能随时把焦点移走；`↑`/`↓`/`Enter`/`Esc` 只在这里解释。
//    ⚠️ 输入框有焦点时，全局分发器按"可编辑焦点"把全局键全部挡下（`INV-SET-05`）——
//    那是**要的**：在搜索框里敲字不该触发别的动作。

// ⚠️⚠️ **每个文件都包一层 IIFE**——这**不是**风格问题，是必须的。
// 经典脚本的顶层 `const` **共用一个全局词法作用域**：两个文件都写 `const api = …`
// 时，后加载的那个文件**整个不执行**（解析期 `SyntaxError`），
// 而错误只出现在 WebView 的控制台里——本项目看不到它。
(function () {
  'use strict';

  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) ||
    (typeof module !== 'undefined' && module.exports ? require('../services/i18n.js') : null);
  const t = I18N ? I18N.t : function (key) { return key; };

  const K = (typeof module !== 'undefined' && module.exports)
    ? require('../services/keymap.js') : window.rmd.keymap;
  const Se = (typeof module !== 'undefined' && module.exports)
    ? require('../services/search.js') : window.rmd.search;
  const SS = (typeof module !== 'undefined' && module.exports)
    ? require('../services/sidebarsearch.js') : window.rmd.sidebarsearch;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * 建一个常驻搜索框。
   *
   * @param {object} opts
   * @param {{bar:HTMLElement, input:HTMLInputElement, pane:HTMLElement}} opts.els
   *        `bar` = 输入框那一行（底部），`pane` = 结果面板（与树/列表互斥的那一个）
   * @param {(pattern:string, rebuild:boolean) => Promise<{result:object|null, decision:object}>} opts.search
   *        ⭐ 由 `main.js` 转接 `session.searchFiles`（本文件不认识 IPC）
   * @param {(realPath:string) => void} opts.onPick 选中之后干什么（打开 + 树定位）
   * @param {(active:boolean) => void} [opts.onActiveChange] 结果层显隐变了（`main.js` 据此停/续列表分片）
   * @param {(e:object) => void} [opts.onError]
   * @param {object} opts.keymap ⭐ **只为读 `bindings`**（刷新键从表里认）
   * @param {string} opts.refreshId 刷新索引那个动作 id
   */
  function createSidebarSearch(opts) {
    const els = opts.els;
    const search = opts.search;
    const onPick = opts.onPick;
    const onActiveChange = opts.onActiveChange || function () {};
    const onError = opts.onError || function () {};
    const keymap = opts.keymap;
    const refreshId = opts.refreshId;

    /** 结果层现在显示着吗。⚠️ 面板的 `hidden` **不归本文件管**（`Sidebar.applyPanes` 是唯一计算处）。 */
    let active = false;
    let items = [];
    let selected = -1;
    /** 说明行的重绘闭包（切语言时现算，⛔ 不存译文）。 */
    let noteRepaint = null;

    // ── 结果面板的 DOM（⚠️ 由本文件建：`index.html` 只给一个空容器）────────
    const note = el('p', 'sidebar-search-note');
    const list = el('ul', 'sidebar-search-list');
    list.id = 'sidebar-search-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('sidebar.search-label'));
    els.pane.appendChild(note);
    els.pane.appendChild(list);

    function setNote(v) {
      noteRepaint = (typeof v === 'function') ? v : null;
      note.textContent = noteRepaint ? noteRepaint() : (v == null ? '' : String(v));
    }

    function renderList() {
      list.textContent = '';
      if (!items.length) {
        // ⚠️ "没有匹配的文件名"与 `⌘P` / `main.js` 是**同一句** ⇒ 复用那条键，
        //    ⛔ 不另立一条同文（两份同文迟早漂，而漂的是用户读的那一半）。
        if (active && els.input.value.trim().length > 0) {
          const empty = el('li', 'sidebar-search-empty', t('search.none'));
          empty.setAttribute('aria-disabled', 'true');
          list.appendChild(empty);
        }
        els.input.removeAttribute('aria-activedescendant');
        return;
      }
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const row = el('li', 'sidebar-search-item');
        row.id = 'sidebar-search-item-' + i;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', i === selected ? 'true' : 'false');
        if (i === selected) row.classList.add('selected');

        const nameEl = el('span', 'sidebar-search-name');
        // ⭐ 命中片段由 `services/search.js` 换算成 UTF-16 区间后切出来
        //    （Rust 给的是**字节**区间，⛔ 直接拿它切片在中英文混排下会错位）。
        const segs = Se.segments(it.name, it.spans);
        for (let k = 0; k < segs.length; k++) {
          if (segs[k].hit) nameEl.appendChild(el('mark', 'sidebar-search-hit', segs[k].text));
          else nameEl.appendChild(document.createTextNode(segs[k].text));
        }
        row.appendChild(nameEl);

        // ⚠️ 相对路径用 `textContent`——文件路径是用户数据，⛔ 绝不用 `innerHTML` 拼。
        if (it.rel && it.rel !== it.name) row.appendChild(el('span', 'sidebar-search-rel', it.rel));
        list.appendChild(row);
      }
      if (selected >= 0) els.input.setAttribute('aria-activedescendant', 'sidebar-search-item-' + selected);
      else els.input.removeAttribute('aria-activedescendant');
    }

    /** 只改选中项（⛔ 不重建整张表：重建会丢滚动位置）。 */
    function renderSelection() {
      const rows = list.querySelectorAll('.sidebar-search-item');
      for (let i = 0; i < rows.length; i++) {
        const on = i === selected;
        rows[i].classList.toggle('selected', on);
        rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
      }
      if (selected >= 0) {
        els.input.setAttribute('aria-activedescendant', 'sidebar-search-item-' + selected);
        const row = rows[selected];
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      } else {
        els.input.removeAttribute('aria-activedescendant');
      }
    }

    // ── 显隐 ─────────────────────────────────────────────────────────

    /**
     * 进 / 出"正在搜"这个状态。
     * ⚠️ 面板可见性由 `Sidebar.applyPanes` 统一计算 ⇒ 这里只改自己的状态并**通知**。
     */
    function setActive(on) {
      const next = !!on;
      if (active === next) return;
      active = next;
      if (!active) {
        items = [];
        selected = -1;
        renderList();
        setNote('');
      }
      onActiveChange(active);
    }

    /** 清空输入并退出搜索（Esc / 选中一条之后）。 */
    function clear() {
      if (els.input.value !== '') els.input.value = '';
      setActive(false);
    }

    // ── 查询 ─────────────────────────────────────────────────────────

    /**
     * 发一次查询并把结果落地。
     *
     * ⚠️ **不 debounce**：与 `⌘P` 同一条实测依据（`research/notes/0011`：
     * 5 万个名字的匹配 1.6–2.2 ms，比一次 IPC 往返还小）。
     * ⛔ 而"这份响应该不该显示"由 `session.js` 按 `req`/代次判（§2.1 ⑥），
     * 这里⛔ 不另存一份序号——两个机制判同一件事，迟早会分叉。
     */
    async function run(pattern, rebuild) {
      let out;
      try {
        out = await search(pattern, !!rebuild);
      } catch (e) {
        if (!active) return;
        items = [];
        selected = -1;
        renderList();
        const why = (e && (e.wording || e.message)) || e;
        setNote(function () { return t('qo.error', { msg: why }); });
        onError(e);
        return;
      }
      // 期间清空了 / 退出了 / 切到了别的页 ⇒ ⛔ 不往一个不该显示的面板里写
      if (!active) return;
      const d = out.decision || {};
      if (d.commit) {
        items = out.result.entries;
        selected = items.length ? 0 : -1;
        renderList();
        setNote(function () { return Se.summaryText(out.result); });
      } else if (d.reason === 'gen' || d.reason === 'empty' || d.reason === 'shape') {
        // ⭐ `gen` = 切根了 ⇒ **清空**（§2.1 ⑥ 明文要求：不是"留着旧的"）
        items = [];
        selected = -1;
        renderList();
        setNote('');
      }
      // ⚠️ `req` 那一支**什么都不做**：更新的一次请求已经在路上，
      //    它回来时会覆盖（现在清空只会闪一下）。
    }

    /** 输入框里发生了变化之后的**唯一**入口（三分支判据在 `sidebarsearch.js`）。 */
    function onInput() {
      const plan = SS.planQuery(active, els.input.value);
      if (plan.kind === 'clear') {
        // ⚠️ 空/纯空白 ⇒ **不发 IPC**，直接收起结果、恢复原视图。
        setActive(false);
        return;
      }
      if (!active) {
        setActive(true);
        // ⭐ 第一次从"没在搜"进入"在搜"：这一趟**强制重建索引**
        //    （与 `⌘P` 浮层打开时同一条时机，`INV-SEARCH-06`）。
        setNote(function () { return t('qo.building'); });
      }
      run(els.input.value, plan.rebuild);
    }

    // ── 键盘（本层自己的；⛔ 不注册到全局分发器）────────────────────

    function pick(i) {
      const it = items[i];
      if (!it) return;
      // ⚠️ 顺序：先清空并退出搜索（面板回到树/列表）→ 再把焦点交出去 → 才打开。
      //    ② 的目的是让**全局键**立刻恢复（`INV-SET-05` 的可编辑焦点判据会把它们全挡住）。
      clear();
      try { els.input.blur(); } catch (e) { /* 不可 blur 就作罢，⛔ 不抛 */ }
      onPick(it.realPath);
    }

    function onKeydown(e) {
      // ⭐ 组合态先挡（`INV-SET-05` 的同一条精神）：输入法正在组合时，
      //    回车是"上屏"而不是"打开"，上下键是"翻候选"。
      if (K && K.isComposingEvent && K.isComposingEvent(e)) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        if (els.input.value !== '' || active) clear();
        else els.input.blur();
        return;
      }
      if (e.key === 'ArrowDown') {
        if (!active || !items.length) return;
        e.preventDefault();
        selected = SS.moveSelection(selected, items.length, 1);
        renderSelection();
        return;
      }
      if (e.key === 'ArrowUp') {
        if (!active || !items.length) return;
        e.preventDefault();
        selected = SS.moveSelection(selected, items.length, -1);
        renderSelection();
        return;
      }
      if (e.key === 'Enter') {
        if (!active || selected < 0) return;
        e.preventDefault();
        pick(selected);
        return;
      }
      // ⚠️ `Tab` **不拦**（与 `⌘P` 相反）：这是常驻框，用户要能正常把焦点移走。
      // ⭐ 刷新键：**从后端那张表里认**（`INV-SET-01`）——本文件里没有键位字面量。
      const id = K ? K.matchEvent(keymap ? keymap.bindings : [], e) : null;
      if (id && id === refreshId) {
        e.preventDefault();
        setNote(function () { return t('qo.rebuilding'); });
        if (!active && els.input.value.trim() === '') {
          // 空模式刷新 = 只重建索引（下一次输入就不用再等一趟全树遍历）
          search('', true).catch(function (err) { onError(err); });
          return;
        }
        if (!active) setActive(true);
        run(els.input.value, true);
      }
    }

    els.input.addEventListener('input', onInput);
    els.input.addEventListener('keydown', onKeydown);
    list.addEventListener('click', function (e) {
      const row = e.target && e.target.closest ? e.target.closest('.sidebar-search-item') : null;
      if (!row) return;
      pick(Array.prototype.indexOf.call(list.querySelectorAll('.sidebar-search-item'), row));
    });
    list.addEventListener('mousemove', function (e) {
      const row = e.target && e.target.closest ? e.target.closest('.sidebar-search-item') : null;
      if (!row) return;
      const i = Array.prototype.indexOf.call(list.querySelectorAll('.sidebar-search-item'), row);
      if (i >= 0 && i !== selected) { selected = i; renderSelection(); }
    });

    // ⭐ 切语言：说明行（现算）＋ 空态那句（`renderList` 里）＋ 列表的 aria-label 重贴。
    //    ⚠️ 占位符与输入框的 aria-label 是静态 `data-i18n*`，由 `setLang()` 的 `applyDom` 管。
    if (I18N) {
      I18N.subscribe(function () {
        if (noteRepaint) note.textContent = noteRepaint();
        list.setAttribute('aria-label', t('sidebar.search-label'));
        renderList();
      });
    }

    /**
     * ⭐ 这个搜索框现在**该不该在**（文件页 + 目录模式）。
     *
     * ⚠️ 它**不碰 `hidden`**：那一行与结果面板的可见性由 `Sidebar.applyPanes` **唯一**计算
     * （否则"切到大纲页"与"目录被收回"两个写者会各说各话，表现是搜索框留在大纲页上）。
     * 这里只负责：从"该在"变成"不该在"时**连带清掉**进行中的搜索——
     * 否则回到目录时结果层会突然盖住一棵用户没搜过的树。
     */
    function setAvailable(on) {
      if (!on) clear();
    }

    return {
      setAvailable,
      setActive,
      clear,
      /** 给冒烟 / 编排用。 */
      isActive: function () { return active; },
      count: function () { return items.length; },
      selected: function () { return selected; },
      /** ⭐ 清空之后要让搜索框消失（选中一条、或目录会话没了）。 */
      reset: function () {
        els.input.value = '';
        clear();
      },
      destroy: function () {
        els.input.removeEventListener('input', onInput);
        els.input.removeEventListener('keydown', onKeydown);
        if (els.pane) els.pane.textContent = '';
      },
    };
  }

  const api = { createSidebarSearch: createSidebarSearch };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).sidebarSearch = api;
})();
