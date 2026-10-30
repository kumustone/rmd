// 文件名搜索浮层 —— `design/0009-文件名模糊搜索.md` §2.1 ④⑤⑥（2026-10-14 已通过）。
//
// # 它是什么
//
// 一个**瞬时**浮层：`⌘P` 出来、选中回车打开、`Esc` 走。
// ⭐ 形态取自**业界三家一致的做法**（VS Code 的 quick input / Obsidian 的 quick
// switcher / Typora 的 Open Quickly 全是浮层，`research/notes/0010` §1），
// ⛔ **不是**侧边栏里的一个常驻过滤框——那条路"只过滤已展开项"，
// 而用户要找的正是**不知道在哪一层**的文件（§2.2 备选 B 的否决理由）。
//
// # 它与 `design/0010` 的关系（⛔ 不是"另挂一套键盘"）
//
// · `⌘P`（打开）与 `⌘R`（刷新索引）**登记在 Rust 那张唯一表里**（`INV-SET-01`），
//   ⛔ 本文件里**没有**任何键位字面量：刷新键靠 `K.matchEvent(keymap.bindings, e)`
//   从表里认出来，与全局分发器**同一份匹配算法**。
// · 面板内的 `↑`/`↓`/`Enter`/`Esc`/`Tab` 是**组件自己的**键盘处理——
//   它们只在浮层拿到焦点时存在，与全局分发器不重叠（`INV-SET-04` 的两个维度）。
//   ⚠️ 这也顺带解释了"为什么全局分发器不干活"：输入框有焦点 ⇒
//   `INV-SET-05` 的可编辑焦点判据会把**所有**全局键挡下来（那是**要的**：
//   在搜索框里敲字不该把侧边栏收起来）。
// · 与设置覆盖层**互斥**：两边都注册进 `Settings.registerOverlay`（`INV-SET-07`），
//   开一个就关另一个——⛔ 不叠成两层（焦点主人只能有一个）。
//
// # ⛔ 这里不做的两件事
//
// ① **不匹配**。匹配与排序在 Rust 侧（`fs/tree.rs::search`），
//    前端只把命中的字节区间换算成 UTF-16 再画出来（`services/search.js`）。
// ② **不做持久化**。没有"最近打开"、没有搜索历史——那要先有持久化历史
//    （`design/0009` §4 明确 V1 不做）。

// ⚠️⚠️ **每个文件都包一层 IIFE**——这**不是**风格问题，是必须的。
//
// 经典脚本（⛔ 不是 ES module）的顶层 `const` **共用一个全局词法作用域**：
// 两个文件都写 `const api = …`（或 `const V` / `const S`）时，
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

  // ⭐ `design/0025`：可见文案走字典（浏览器取 `window.rmd.i18n`，`node --test` 走 `require`）。
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) ||
    (typeof module !== 'undefined' && module.exports ? require('../services/i18n.js') : null);
  const t = I18N ? I18N.t : function (key) { return key; };

  const K = (typeof module !== 'undefined' && module.exports) ? require('../services/keymap.js') : window.rmd.keymap;
  const Se = (typeof module !== 'undefined' && module.exports) ? require('../services/search.js') : window.rmd.search;
  const St = (typeof module !== 'undefined' && module.exports) ? require('./Settings.js') : window.rmd.settings;

  /** 覆盖层名（登记处的键，也是 `closeOtherOverlays` 认得的名字）。 */
  const NAME = 'quick-open';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * 建浮层。⚠️ DOM 由本文件建（⛔ 不在 `index.html` 里写死——
   * 那样就有两份要同步的东西，与设置覆盖层同一条理由）。
   *
   * @param {object} opts
   * @param {(pattern:string, rebuild:boolean) => Promise<{result:object|null, decision:object}>} opts.search
   *        ⭐ 由 `main.js` 转接 `session.searchFiles`（本文件不认识 IPC）
   * @param {(realPath:string) => void} opts.onPick 选中之后干什么（打开 + 树定位）
   * @param {(e:object) => void} [opts.onError] 出错时的提示（⛔ 不弹全局错误框）
   * @param {object} opts.keymap ⭐ `design/0010` 的分发器句柄——**只为读 `bindings`**
   *        （刷新键从表里认出来，⛔ 不是本文件写一个 `⌘R`）
   * @param {string} opts.refreshId 刷新索引那个动作 id
   * @param {(id:string) => string} opts.keyText ⭐ 键位显示串（⛔ 不自己拼，`INV-SET-01`）
   * @param {() => boolean} [opts.isAvailable] 现在能不能用（目录模式才有意义）
   */
  function createQuickOpen(opts) {
    const search = opts.search;
    const onPick = opts.onPick;
    const onError = opts.onError || function () {};
    const keymap = opts.keymap;
    const refreshId = opts.refreshId;
    const keyText = opts.keyText || function () { return ''; };
    const isAvailable = opts.isAvailable || function () { return true; };

    let opened = false;
    let restoreTo = null;
    /** ⭐ 当刻显示的那些结果（`services/search.js` 归一化之后的形状）。 */
    let items = [];
    let selected = -1;
    /** 上一次成功提交的结果（只用来写那一行说明）。 */
    let lastResult = null;

    // ── DOM ──────────────────────────────────────────────────────────
    const root = el('div', 'quickopen-layer');
    root.hidden = true;
    const scrim = el('div', 'quickopen-scrim');
    const panel = el('div', 'quickopen-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'quickopen-title');
    panel.tabIndex = -1;

    const title = el('h2', 'quickopen-title', t('qo.title'));
    title.id = 'quickopen-title';
    title.setAttribute('data-i18n', 'qo.title');

    const input = el('input', 'quickopen-input');
    input.type = 'search';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'quickopen-list');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('data-i18n-placeholder', 'qo.placeholder');
    input.setAttribute('placeholder', t('qo.placeholder'));

    // ⚠️ 这一格的文字由 `noteRepaint` 现算 ⇒ ⛔ 不传字典键（空串会被贴成 `data-i18n=""`，
    //    换语言时 `applyDom()` 会把它写成 `(i18n: empty key)`）。
    const note = el('div', 'quickopen-note');
    // ⭐ 这一行有三种来源（查询说明 / 出错 / 建索引中），切语言时**没有谁会重画它**
    //    ⇒ 存"怎么算出这一行"的配方（`design/0025` §2.5.1 ②），⛔ 不缓存算好的句子。
    let noteRepaint = null;
    /** 写说明行，并把"重画配方"记下来。 */
    function setNote(fn) {
      noteRepaint = fn;
      note.textContent = fn();
    }

    const list = el('ul', 'quickopen-list');
    list.id = 'quickopen-list';
    list.setAttribute('role', 'listbox');

    panel.appendChild(title);
    panel.appendChild(input);
    panel.appendChild(note);
    panel.appendChild(list);
    root.appendChild(scrim);
    root.appendChild(panel);
    document.body.appendChild(root);

    // ── 渲染 ─────────────────────────────────────────────────────────

    /** 那一行说明：条数 / 截断 / 索引年龄 + **刷新键的提示**（⛔ 键位从表里取）。 */
    function noteText() {
      const parts = [];
      const typed = input.value.trim().length > 0;
      if (lastResult) {
        // ⚠️ 空模式那次查询**不是搜索**（后端对空模式返回空结果），
        //    所以⛔ 不能报"没有匹配的文件名"——那是"搜了但没搜到"的说法。
        if (typed) parts.push(Se.summaryText(lastResult));
        else {
          const age = Se.ageText(lastResult.builtAtMs);
          if (age) parts.push(t('qo.index-ready', { age: age }));
        }
      } else if (!items.length) parts.push(t('qo.building'));
      const key = keyText(refreshId);
      // ⭐ `design/0009` §2.1 ② 明确要求这条提示**看得见**：
      //    "浮层开着时别的进程新建的文件要按刷新键才出现"是**接受的代价**，
      //    而代价必须说出来（⛔ 不是让人以为搜索坏了）。
      if (key) parts.push(t('qo.refresh-hint', { key: key }));
      return parts.filter(function (s) { return !!s; }).join(' · ');
    }

    function renderList() {
      list.textContent = '';
      if (!items.length) {
        // ⚠️ "没有匹配的文件名"与 `main.js`/`search.js` 是**同一句** ⇒ 复用那条键，
        //    ⛔ 不另立一条同文（两份同文迟早漂，而漂的是用户读的那一半）。
        const empty = el('li', 'quickopen-empty',
          input.value ? t('search.none') : t('qo.empty-hint'));
        empty.setAttribute('aria-disabled', 'true');
        list.appendChild(empty);
        input.removeAttribute('aria-activedescendant');
        return;
      }
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const row = el('li', 'quickopen-item');
        row.id = 'quickopen-item-' + i;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', i === selected ? 'true' : 'false');
        if (i === selected) row.classList.add('selected');

        const nameEl = el('span', 'quickopen-name');
        // ⭐ 命中片段由 `services/search.js` 换算成 UTF-16 区间后切出来
        //    （Rust 给的是**字节**区间，⛔ 直接拿它切片在中英文混排下会错位）。
        const segs = Se.segments(it.name, it.spans);
        for (let k = 0; k < segs.length; k++) {
          if (segs[k].hit) nameEl.appendChild(el('mark', 'quickopen-hit', segs[k].text));
          else nameEl.appendChild(document.createTextNode(segs[k].text));
        }
        row.appendChild(nameEl);

        // ⚠️ 相对路径那一列用 `textContent`——文件路径是用户数据，
        //    ⛔ 绝不用 `innerHTML` 拼（与 `FileTree.js` 同一条纪律）。
        if (it.rel && it.rel !== it.name) row.appendChild(el('span', 'quickopen-rel', it.rel));
        list.appendChild(row);
      }
      input.setAttribute('aria-activedescendant', 'quickopen-item-' + selected);
    }

    /** 只改选中项（⛔ 不重建整张表：200 条重建一次会丢滚动位置）。 */
    function renderSelection() {
      const rows = list.querySelectorAll('.quickopen-item');
      for (let i = 0; i < rows.length; i++) {
        const on = i === selected;
        rows[i].classList.toggle('selected', on);
        rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
      }
      if (selected >= 0) {
        input.setAttribute('aria-activedescendant', 'quickopen-item-' + selected);
        const row = rows[selected];
        if (row) row.scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    // ── 查询 ─────────────────────────────────────────────────────────

    /**
     * 发一次查询并把结果落地。
     *
     * ⚠️ **不 debounce**：`research/notes/0011` 实测 5 万个名字的匹配是
     * **1.6–2.2 ms**（`Mac14,9` / macOS 27.0 / `rustc -O` / 11 轮 median），
     * 比一次 IPC 往返还小 ⇒ 加 debounce 只会让人觉得"卡了一下才出结果"。
     * ⛔ 而"要不要丢弃这份响应"由 `session.js` 按 `req`/代次判（§2.1 ⑥），
     * 这里⛔ 不另存一份序号——两个机制判同一件事，迟早会分叉。
     */
    async function run(pattern, rebuild) {
      let out;
      try {
        out = await search(pattern, !!rebuild);
      } catch (e) {
        if (!opened) return;
        lastResult = null;
        const why = (e && (e.wording || e.message)) || e;
        setNote(function () { return t('qo.error', { msg: why }); });
        onError(e);
        return;
      }
      if (!opened) return;              // 期间关掉了 ⇒ ⛔ 不往一个隐藏的浮层里写
      const d = out.decision || {};
      if (d.commit) {
        items = out.result.entries;
        lastResult = out.result;
        selected = items.length ? 0 : -1;
        renderList();
      } else if (d.reason === 'gen' || d.reason === 'empty' || d.reason === 'shape') {
        // ⭐ `gen` = 切根了 ⇒ **清空**（§2.1 ⑥ 明文要求：不是"留着旧的"）
        //    `empty` = 空模式，这次本来就没打算搜
        //    `shape` = 响应读不懂 ⇒ ⛔ 显示不了任何东西，但也不装作有结果
        items = [];
        lastResult = null;
        selected = -1;
        renderList();
      }
      // ⚠️ `req` 那一支**什么都不做**：更新的一次请求已经在路上，
      //    它回来时会覆盖（现在清空只会闪一下）。
      setNote(noteText);
    }

    // ── 键盘（本层自己的，⛔ 与全局分发器不重叠）────────────────────

    function move(delta) {
      if (!items.length) return;
      const n = items.length;
      // ⚠️ 环绕：从最后一条按 ↓ 回到第一条（长列表里比"卡在底部"好用）
      selected = ((selected + delta) % n + n) % n;
      renderSelection();
    }

    function pick(i) {
      const it = items[i];
      if (!it) return;
      // ⚠️ 先关再打开：`onPick` 会去调 `open_document` + 树定位，
      //    那可能要几百毫秒；浮层挡在上面只会让人以为没反应。
      close();
      onPick(it.realPath);
    }

    function onKeydown(e) {
      if (!opened) return;
      // ⭐ 组合态先挡（`INV-SET-05` 的同一条精神）：输入法正在组合时，
      //    回车是"上屏"而不是"打开"，上下键是"翻候选"。
      if (K.isComposingEvent(e)) return;

      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(-1); return; }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pick(selected); return; }
      // ⚠️ 焦点陷阱：这一层里可聚焦的只有输入框，所以 Tab 一律收回输入框。
      //    ⛔ 不用 `inert` 兜底（`design/0009` §2.1 ④：要显式做）。
      if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); input.focus(); return; }

      // ⭐ 刷新键：**从后端那张表里认**（`INV-SET-01`）——本文件里没有键位字面量。
      const id = K.matchEvent(keymap ? keymap.bindings : [], e);
      if (id === refreshId) {
        e.preventDefault();
        e.stopPropagation();
        lastResult = null;            // ⚠️ 年龄那一段要重新算
        setNote(function () { return t('qo.rebuilding'); });
        run(input.value, true);
        return;
      }
      // 其余按键一律放行：`Cmd+O` 之类会被全局分发器按"可编辑焦点"挡下，
      // 而普通字符要正常进输入框。
    }

    // ⚠️ 用 **capture**：`Esc` / 方向键 / 回车都得在页面其余部分看到之前拦下
    //    （`FileTree.js` 的容器也可聚焦、也有方向键处理，⛔ 不拦就会同时动两处）。
    //    ⚠️ 挂在 `document` 上而不是输入框上：焦点万一跑到面板/`body` 上
    //    （`Cmd+Tab` 回来、页面上别的东西抢了焦点），`Esc` 仍然要能关掉它。
    // ⭐ 切语言：说明行（现算）＋ 空态那两句（`renderList` 里）重贴。
    //    ⚠️ 标题与占位符是静态 `data-i18n*`，由 `setLang()` 的 `applyDom` 管。
    if (I18N) {
      I18N.subscribe(function () {
        if (noteRepaint) note.textContent = noteRepaint();
        renderList();
      });
    }

    document.addEventListener('keydown', onKeydown, true);
    input.addEventListener('input', function () { run(input.value, false); });
    list.addEventListener('click', function (e) {
      const row = e.target && e.target.closest ? e.target.closest('.quickopen-item') : null;
      if (!row) return;
      const rows = Array.prototype.slice.call(list.querySelectorAll('.quickopen-item'));
      pick(rows.indexOf(row));
    });
    list.addEventListener('mousemove', function (e) {
      const row = e.target && e.target.closest ? e.target.closest('.quickopen-item') : null;
      if (!row) return;
      const rows = Array.prototype.slice.call(list.querySelectorAll('.quickopen-item'));
      const i = rows.indexOf(row);
      if (i >= 0 && i !== selected) { selected = i; renderSelection(); }
    });
    scrim.addEventListener('click', function () { close(); });

    // ── 开 / 关 ──────────────────────────────────────────────────────

    /**
     * 打开浮层。
     * @returns {boolean} 真的打开了吗（单文件模式下**按了没反应**，§2.1 ④ 末）
     */
    function open() {
      if (opened) return true;
      if (!isAvailable()) return false;
      // ⭐ 开一个就关另一个（`INV-SET-07`）——设置覆盖层开着的话先关它。
      St.closeOtherOverlays(NAME);
      restoreTo = document.activeElement;
      opened = true;
      items = [];
      selected = -1;
      lastResult = null;
      input.value = '';
      setNote(function () { return t('qo.building'); });
      renderList();
      root.hidden = false;
      document.body.classList.add('quickopen-open');
      input.focus();
      // ⭐ **每次打开都重建索引**（`design/0009` §2.1 ② 的重建时机表第一行）：
      //    代次只回答"授权变没变"，回答不了"目录里有没有新文件"（`INV-SEARCH-06`）。
      run('', true);
      return true;
    }

    function close() {
      if (!opened) return;
      opened = false;
      root.hidden = true;
      document.body.classList.remove('quickopen-open');
      // ⭐ 把焦点还给它打开前的那个元素（`INV-SET-07`）——不还的话焦点掉到
      //    `body` 上，键盘用户下次按 Tab 要重新找一遍。
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
      /** ⚠️ 给冒烟回报用（`design/0009` §7）：现在显示了几条、选中的是第几条。 */
      count: function () { return items.length; },
      selected: function () { return selected; },
      destroy: function () {
        document.removeEventListener('keydown', onKeydown, true);
        if (root.parentNode) root.parentNode.removeChild(root);
      },
    };

    // ⭐ 注册进**唯一那个**登记处（与设置覆盖层共用，`INV-SET-07`）
    St.registerOverlay(NAME, handle);
    return handle;
  }

  const api = { createQuickOpen: createQuickOpen, NAME: NAME };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).quickOpen = api;
})();
