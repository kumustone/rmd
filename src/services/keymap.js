// 快捷键分发 —— `design/0010-设置界面与快捷键.md` §2.1 ①②⑤⑦（2026-10-14 已通过）。
//
// # 这个模块存在的唯一理由
//
// 迁移前，按键散在**三段互不知情的 `keydown`** 里（`main.js:443`、`Sidebar.js:275`、
// `ThemeSwitcher.js:96`），而菜单加速键又由 Rust 侧的菜单持有 ⇒
// 「这个键归谁」**没有事实来源**。本模块接住这件事，分工是：
//
//   · **数据**在后端（`get_shortcuts` 返回的表：`accel` + `aliases` + `owner`）；
//   · **算法**在这里（把 `{metaKey, ctrlKey, altKey, shiftKey, key}` 判成某个 id）；
//   · **实现**在调用方（`main.js` 的 `ACTIONS`）。
//
// ⛔ **源码里不许出现按键字面量**（`'b'` / `','` / `'-'` …）——那正是"第二份表"的形态。
//    ⚠️ 这条是可测的：单测把本文件读进来 grep（§7），比"人看一眼"强。
//
// # 两组所有者（`INV-SET-02` / `INV-SET-04`）
//
// `owner = Menu`：AppKit 在事件送达 key window **之前**就吞掉它
//                ⇒ 这里**一个字节都不许**监听，但**必须**有 handler（菜单点击要用）。
// `owner = Web`：**没有**菜单加速键，由这里监听。
// ⚠️ 两组**不允许重叠**：重叠的表现是"按一下收起来又弹回去"。
//
// ⚠️ **每个文件都包一层 IIFE**——经典脚本的顶层 `const` 共享全局词法作用域，
//    撞名会让**整个文件不执行**且 stderr 全静默（2026-10-13 真踩过，见 `theme.js` 的模块头）。
(function () {
  'use strict';

  /** 修饰键的拼写 → 规范名。⚠️ 与 `muda` 认的几种写法对齐（`Command`/`Cmd`/`Super`…）。 */
  const MOD_NAMES = {
    cmd: 'cmd', command: 'cmd', super: 'cmd', meta: 'cmd',
    ctrl: 'ctrl', control: 'ctrl',
    alt: 'alt', option: 'alt', opt: 'alt',
    shift: 'shift'
  };

  /**
   * 把 `accel` 切成 `{mods, key}`。
   *
   * ⭐ **照 `muda` 的规则来**（`accelerator/mod.rs:202-226`）：`rfind('+')` 切，
   * 且"键名本身就是 `+`"时单独处理（`"Cmd++"` → 修饰 `Cmd`、键 `+`）。
   * ⛔ **别自己发明一套**——两份规则一旦分叉，设置界面显示的键
   * 与真正装上去的就**不是同一个**（那是本设计最怕的静默错误之一）。
   */
  function splitAccel(accel) {
    const a = String(accel == null ? '' : accel).trim();
    const pos = a.lastIndexOf('+');
    if (pos < 0) return { mods: [], key: a };
    const tail = a.slice(pos + 1);
    if (tail.trim() === '') {
      // ⚠️ 与 Rust 侧的 `trim_end_matches('+')` 对齐：`"Cmd++"` 的修饰段是 `"Cmd+"`。
      return { mods: splitMods(a.slice(0, pos).replace(/\++$/, '')), key: '+' };
    }
    return { mods: splitMods(a.slice(0, pos)), key: tail.trim() };
  }

  function splitMods(s) {
    const out = [];
    String(s || '').split('+').forEach(function (t) {
      const n = MOD_NAMES[t.trim().toLowerCase()];
      if (n && out.indexOf(n) < 0) out.push(n);
    });
    return out;
  }

  /** 单个 ASCII 字母折成小写（`O` 与 `o` 是同一个键）；其余原样。 */
  function normalizeKey(k) {
    const s = String(k == null ? '' : k);
    return /^[A-Za-z]$/.test(s) ? s.toLowerCase() : s;
  }

  /**
   * ⭐ 这个键名**自己就要求 Shift** 吗（`_` `+` `{` `~` … 与单个字母/数字相对）。
   *
   * # 为什么必须有这条
   *
   * `⇧=` 按出来的 `e.key` 是 `+`，而**不是** `=`——所以别名表里
   * `Cmd++` / `Cmd+_` 这两条**字符串里并没有写 `Shift`**，可物理上它们
   * **非按 Shift 不可**。若一律"声明了 Shift 才要 Shift"，这两条**永远匹配不上**，
   * 表现是「设置界面写着 `⌘-`，可我一直用的 `⇧⌘-` 突然不生效了」——
   * 一个**静默**的既有按键失效。
   *
   * ⇒ 判据：键名是**单个小写字母或数字**时 Shift 由 `accel` 显式声明；
   *    **其余字符**（符号、大写字母归一化后仍非字母数字）Shift 已被字符本身蕴含。
   * ⚠️ 这个判据**只需要字符类，不需要键盘布局表**——`{` 在别的布局上是不是
   * 需要 Shift 与我们无关：我们比对的是 `e.key` 字符，不是物理位置。
   */
  function isShiftImplied(keyPart) {
    return !/^[a-z0-9]$/.test(normalizeKey(keyPart));
  }

  /**
   * `accel` 命中这次按键吗。
   *
   * ⚠️ **修饰键逐项精确比对**，⛔ 没有隐含的 `metaKey || ctrlKey`：
   * 别名表里 `Ctrl+O` 与 `Cmd+O` 是**两条**（`design/0010` §2.1 ① 表），
   * 所以这里如实比对，谁写的算谁的。
   *
   * ⚠️ **Shift 是"精确"的**：`Cmd+O` 不匹配 `⇧⌘O`。
   * 少了这一条，`file.open-file`（`⇧⌘O`）会**顺带**触发 `file.open-directory`——
   * 一个键两个动作，正是 `INV-SET-04` 要守的东西。
   */
  function matchAccel(accel, ev) {
    const parts = splitAccel(accel);
    if (!parts.key) return false;
    const want = parts.mods;
    const wantCmd = want.indexOf('cmd') >= 0;
    const wantCtrl = want.indexOf('ctrl') >= 0;
    const wantAlt = want.indexOf('alt') >= 0;
    if (wantCmd !== !!ev.metaKey) return false;
    if (wantCtrl !== !!ev.ctrlKey) return false;
    if (wantAlt !== !!ev.altKey) return false;
    if (normalizeKey(parts.key) !== normalizeKey(ev.key)) return false;
    if (!isShiftImplied(parts.key) && (want.indexOf('shift') >= 0) !== !!ev.shiftKey) return false;
    return true;
  }

  /** 焦点在**可编辑**元素里吗（`INV-SET-05`）。⚠️ 判据是"这个元素接不接文字"。 */
  function isEditableElement(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return true;
    if (el.isContentEditable === true) return true;
    return false;
  }

  /** ⭐ 组合态：`ev.isComposing` 与 `keyCode === 229`（老 WebKit 只给后者）。 */
  function isComposingEvent(ev) {
    if (!ev) return false;
    if (ev.isComposing === true) return true;
    if (ev.keyCode === 229) return true;
    return false;
  }

  /**
   * ⭐ 这个事件**带不带修饰键**（`⌘` / `⌃` / `⌥`；`⇧` 单按不算——同 `0003` 的口径）。
   *
   * ⚠️ 它存在的理由**是那条源码级闸门**（`tests/js/keymap.test.js`「修饰键标识符
   * 只允许出现在 keymap.js」）：覆盖层想说"模态期间**任何**应用快捷键都不许在背后生效"时，
   * 它需要读这三个标识符，而那正是闸门禁止别处出现的东西。
   * ⇒ ⛔ 别在调用侧再写一遍 `e.metaKey || …`（闸门会红，而且那是第二份判据）；
   *   把它放在这里，**唯一那个匹配器所在的文件**顺带成了唯一的"修饰键认知点"。
   */
  function hasModifier(ev) {
    if (!ev) return false;
    return ev.metaKey === true || ev.ctrlKey === true || ev.altKey === true;
  }

  /**
   * 把后端那张表切成"键 → 动作"的绑定表（**只含 `owner=web`**）。
   *
   * ⚠️⚠️ **没有 `accel` 的 `web` 项要响亮报错，⛔ 不许静默跳过**——它不是"少了一条"，
   * 它是一类**装得像正常**的缺陷（2026-10-14 实施时真踩到了）：
   * 后端只送 `display`（`⌘O` 那种**字形**）时，`splitAccel` 认不出 `⌘`
   * ⇒ 这一项**只剩别名**：`Ctrl+O` 能开目录，`⌘O` **按下去什么都不发生**——
   * 而菜单上写着 `⌘O`、设置界面里也写着 `⌘O`，**没有一处报错**。
   * ⇒ 判据是"这条 `web` 项有没有**能被匹配器读懂**的键"。
   */
  function buildBindings(table) {
    const out = [];
    (table || []).forEach(function (row) {
      if (!row || row.owner !== 'web') return;
      if (!row.accel) {
        console.error('快捷键表：动作「' + row.id + '」是 owner=web 却没有 accel —— 它的规范键会静默失效（只剩别名能用）');
        return;
      }
      const seqs = [row.accel].concat(row.aliases || []);
      seqs.forEach(function (seq) {
        if (seq) out.push({ id: row.id, accel: seq });
      });
    });
    return out;
  }

  /** 给定一次按键，命中哪个 id（⛔ 不看 owner——调用方只拿 `owner=web` 的表来问）。 */
  function matchEvent(bindings, ev) {
    for (let i = 0; i < bindings.length; i++) {
      if (matchAccel(bindings[i].accel, ev)) return bindings[i].id;
    }
    return null;
  }

  /**
   * 建一个分发器。
   *
   * @param {object} opts
   * @param {Array} opts.table 后端 `get_shortcuts` 返回的**真表**（⛔ 不许自己写死）
   * @param {object} [opts.win] 注入的 `window`（单测用）
   * @param {object} [opts.ctx] 注入的上下文（单测用，见下）
   */
  function createKeymap(opts) {
    const table = opts.table || [];
    const win = opts.win || (typeof window !== 'undefined' ? window : null);

    /** ⭐ `ACTIONS`：**动作 id → handler**。⚠️ Menu 与 Web **都在这**——
        菜单点击不走键绑定，但要走**同一个** `dispatch`（`INV-SET-02`）。 */
    const handlers = Object.create(null);

    const bindings = buildBindings(table);

    /** ⭐ 组合态标记：**键盘路径拿得到 `KeyboardEvent`，菜单路径拿不到**，
        所以菜单那条只能靠这个由 `compositionstart/end` 维护的全局标记（§2.1 ⑦）。 */
    const composition = { active: false };

    const ctx = opts.ctx || {
      compositionActive: function () { return composition.active; },
      editable: function () {
        return isEditableElement(win && win.document && win.document.activeElement);
      }
    };

    function register(id, fn) {
      handlers[id] = fn;
      return function unregister() { delete handlers[id]; };
    }

    /**
     * ⭐ **唯一的执行入口**。两条来源都从这儿进：
     * 键（`handleKeydown`）与菜单事件（`main.js` 的 `listen`）。
     *
     * ⚠️ 组合态与可编辑焦点**两条路径都要挡**（`INV-SET-05`）——
     * 只挡键盘那条的话，中文输入法组合中按 `⌘B` 仍会把侧边栏收起来。
     *
     * @param {string} id 动作 id
     * @param {'key'|'menu'} source
     * @returns {boolean} 真的执行了吗
     */
    function dispatch(id, source) {
      const src = source === 'menu' ? 'menu' : 'key';
      if (ctx.compositionActive()) return false;
      if (ctx.editable()) return false;

      const known = table.some(function (r) { return r.id === id; });
      if (!known) {
        // ⚠️ 表外 id：只在"菜单/别的进程塞了个我们不认识的 id"时出现。
        //    响亮报，⛔ 不静默执行一个没有名字的动作。
        console.error('快捷键分发：收到表外的动作 id「' + id + '」（来源 ' + src + '）');
        return false;
      }
      const fn = handlers[id];
      if (typeof fn !== 'function') {
        // ⚠️ 这正是 §6 表里那行"菜单点下去没反应"的**可诊断形态**。
        console.error('快捷键分发：动作「' + id + '」**没有 handler**（表里有、代码没接）');
        return false;
      }
      fn({ id: id, source: src });
      return true;
    }

    /** 键盘路径的入口。⛔ 不直接注册监听器——`attach()` 才注册。 */
    function handleKeydown(ev) {
      if (isComposingEvent(ev)) return false;
      if (composition.active) return false;
      if (ctx.editable()) return false;
      const id = matchEvent(bindings, ev);
      if (!id) return false;
      // ⚠️ 命中才 `preventDefault`。⛔ 提前挡掉会让输入框里正常的按键也失效。
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      return dispatch(id, 'key');
    }

    function attach() {
      if (!win || win.__rmdKeymapAttached) return detach;
      win.__rmdKeymapAttached = true;
      win.addEventListener('keydown', handleKeydown);
      // ⭐ 组合态标记的唯一写入点（§2.1 ⑦）
      win.addEventListener('compositionstart', onCompStart);
      win.addEventListener('compositionend', onCompEnd);
      return detach;
    }

    function onCompStart() { composition.active = true; }
    function onCompEnd() { composition.active = false; }

    function detach() {
      if (!win || !win.__rmdKeymapAttached) return;
      win.__rmdKeymapAttached = false;
      win.removeEventListener('keydown', handleKeydown);
      win.removeEventListener('compositionstart', onCompStart);
      win.removeEventListener('compositionend', onCompEnd);
    }

    /**
     * ⭐⭐ **跨语言自检**（§2.1 ② 的第三层）——本设计里唯一能同时看到
     * Rust 那张表与前端这份 handler 表的地方，所以它**只能在运行时做**。
     *
     * ⚠️ **缺和多余都要报**（评审 R3）：
     *   · 缺 = 表里有、代码没接 ⇒ 界面上列着一个**按不出来的键**；
     *   · 多余 = 代码里接了、表里没有 ⇒ ⭐ **迁移漏删的旧绑定**（R1 那一族）。
     * ⛔ 只报"缺"的话，`ThemeSwitcher.js` 里那段没删干净的 `keydown`
     * 会**继续生效**却**在设置界面里看不见**——最难发现的一种。
     */
    function checkActions() {
      const missing = [], extra = [];
      const ids = Object.create(null);
      table.forEach(function (r) {
        ids[r.id] = true;
        if (typeof handlers[r.id] !== 'function') missing.push(r.id);
      });
      Object.keys(handlers).forEach(function (id) {
        if (!ids[id]) extra.push(id);
      });
      const ok = missing.length === 0 && extra.length === 0;
      let note = '';
      if (missing.length) note += '表里有、没有 handler：' + missing.join('、') + '；';
      if (extra.length) note += '代码里接了、表里没有（多半是迁移漏删）：' + extra.join('、') + '；';
      if (ok) note = '表 ' + table.length + ' 项 / handler ' + Object.keys(handlers).length + ' 个，一一对应';
      return { ok: ok, missing: missing, extra: extra, note: note };
    }

    const api = {
      table: table,
      bindings: bindings,
      composition: composition,
      dispatch: dispatch,
      register: register,
      handleKeydown: handleKeydown,
      attach: attach,
      detach: detach,
      checkActions: checkActions,
      /** ⚠️ 给单测/调试用：现在注册了哪些 id。⛔ 产品代码不要靠它做判断。 */
      actionIds: function () { return Object.keys(handlers); }
    };
    return api;
  }

  const api = {
    createKeymap: createKeymap,
    buildBindings: buildBindings,
    matchEvent: matchEvent,
    matchAccel: matchAccel,
    splitAccel: splitAccel,
    normalizeKey: normalizeKey,
    isShiftImplied: isShiftImplied,
    isEditableElement: isEditableElement,
    isComposingEvent: isComposingEvent,
    hasModifier: hasModifier
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).keymap = api;
})();
