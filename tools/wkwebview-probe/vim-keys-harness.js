// rmd · 编辑态 Vim 键位探针（页面侧，`docs/design/0014` §7 步骤 0：0b/0c/0d-①/0e/0f）
//
// ⭐ **它跑的是产品那几份**（`.sh` 从仓库里原样拷进来）：
//    · `src/vendor/cm6.bundle.js`      —— `make cm6` 的产物（⛔ 不是 node_modules）
//    · `src/services/keymap.js`        —— 分发器（`createKeymap` / `splitAccel`）
//    · `src/editor/keys.js`            —— 转发白名单的**唯一**派生处
//    · `src/styles/{tokens,themes,editor}.css` —— 真样式表（0e 全靠它们）
//    · `gui/mod.rs` 的 `SHORTCUTS`     —— `.sh` 用 python **现读**生成 `window.__SHORTCUTS`
//    ⛔ 探针不抄第二份键位表、不抄第二份白名单、不抄第二份样式。
//
// ⚠️⚠️ **诚实性边界（写在最前面，⛔ 别在结论里读丢了）**：
//    `new KeyboardEvent(…)` + `dispatchEvent` 造出的是**不可信事件**，
//    WebKit ⛔ **不会**为它执行任何默认编辑行为。⇒ 本探针能答的只有
//    「**页内谁处理了这个键**（`defaultPrevented` ＋ 谁的 handler 响了）」，
//    ⛔ **答不了**「WebKit 会改什么」。后者的**真按键**证据在
//    `benchmarks/results/editor-key-2026-10-16-Mac14,9.json`（`design/0012` §2.3-4：
//    `⌃O`/`⌃K`/`⌃D`/`⌃H` 把文本改成 71→72 / 51 / 70 / 70）——本文件**引用它，不复现它**。
//
// ⚠️ 另一条同族边界：**离屏窗口里 DOM 选区改动落不下来**（`editor-keyprobe` 的判别器实测）。
//    ⇒ 「移光标」那一族在本形态下结构性测不出 ⇒ 本探针**不测** `⌃A/⌃B/⌃E/⌃F/⌃N/⌃P`，
//    那六个的数只能取前台变体（同族边界已在 `tests.md` 登记）。
//
// ⚠️ 所有判据**进退出码**（`.sh` 汇总）。⚠️ 环境不成立的那些记**「跳过」**，
//    ⛔ 不是「失败」——"环境不成立"与"实现坏了"是两件事，混起来会得到一条会骗人的红。

(function () {
  'use strict';

  const CM6 = window.rmdCM6;
  const K = window.rmd.keymap;
  const EK = window.rmd.editorKeys;
  // ⭐ 由 `.sh` 从 `src-tauri/src/gui/mod.rs` 的 `SHORTCUTS` **现读**生成（⛔ 无第二份表）
  const TABLE = window.__SHORTCUTS;

  // ══════════════ 小工具 ══════════════

  /** 数值 → 两位小数（⛔ 非数一律落 `null`：桥只吃 JSON 类型）。 */
  function 数(x) {
    return (typeof x === 'number' && isFinite(x)) ? Math.round(x * 100) / 100 : null;
  }
  function 歇(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  /** 轮询到条件成立或超时。返回是否成立。 */
  function 等(cond, ms) {
    return new Promise(function (res) {
      const t0 = performance.now();
      (function 试() {
        let ok = false;
        try { ok = !!cond(); } catch (e) { ok = false; }
        if (ok) return res(true);
        if (performance.now() - t0 > ms) return res(false);
        setTimeout(试, 16);
      })();
    });
  }
  /** 一个元素的**计算值**（`getComputedStyle` 的取值器，⛔ 不用 `.style`：那读的是行内）。 */
  function 计算(el, prop) {
    if (!el) return null;
    try { return getComputedStyle(el)[prop]; } catch (e) { return '⛔ ' + String(e); }
  }
  /** 颜色串规范化：`rgb(26, 26, 26)` 与 `rgb(26,26,26)` 要能相等。 */
  function 色(s) { return typeof s === 'string' ? s.replace(/\s+/g, '') : s; }

  // ══════════════ 合成键盘事件 ══════════════

  /**
   * `accel` 里的字符 → `keyCode`。
   *
   * ⚠️⚠️ **为什么非补不可**：CM6 的 `keyName(event)`（产物 `:12015` 那一段）在
   * **mac ∧ metaKey ∧ shiftKey ∧ !ctrlKey ∧ !altKey** 时**整块忽略 `event.key`**，
   * 改用 `(shiftKey ? shiftTbl : baseTbl)[event.keyCode]`。
   * 而 `new KeyboardEvent(…)` 在 WebKit 里 `keyCode` 恒为 **0** ⇒ `⇧⌘O` 这类行
   * **一次都匹配不上**，探针会静默地少测一半（`0c-R1a` 会假红）。
   * ⇒ 补 `keyCode`，让两条路径（`event.key` 与 `keyCode` 表）**都指向同一个字符**。
   *    字母用大写 charCode（CM6 的 `shift[]` 表就是这么给的），其余按美式布局。
   */
  const 码 = {
    ',': 188, '.': 190, '/': 191, ';': 186, "'": 222, '[': 219, ']': 221,
    '\\': 220, '-': 189, '=': 187, '`': 192, ' ': 32, '+': 187, '_': 189, ':': 186,
  };
  function 键码(key) {
    if (!key) return 0;
    if (key.length === 1) {
      const c = key.charCodeAt(0);
      if (c >= 97 && c <= 122) return c - 32;          // 'a' → 65
      if (c >= 48 && c <= 57) return c;
      if (码[key] != null) return 码[key];
      return c;
    }
    // 具名键（Vim 那几族要用）
    const 名 = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8, Delete: 46, ' ': 32 };
    return 名[key] || 0;
  }

  /**
   * 把「`Cmd+Shift+O` 这种词」或「`{key,ctrl,alt,meta,shift}` 这种对象」变成事件参数。
   *
   * ⚠️ `splitAccel` **是产品那份**（`services/keymap.js`）——⛔ 探针不自己切字符串。
   */
  function 事件参数(accelOrSpec) {
    if (accelOrSpec && typeof accelOrSpec === 'object') {
      const o = accelOrSpec;
      return {
        key: o.key, code: o.code || '',
        ctrlKey: !!o.ctrl, altKey: !!o.alt, metaKey: !!o.meta, shiftKey: !!o.shift,
        isComposing: !!o.isComposing,
        keyCode: o.keyCode != null ? o.keyCode : 键码(o.key),
      };
    }
    const p = K.splitAccel(accelOrSpec);
    const m = p.mods || [];
    const shift = m.indexOf('shift') >= 0;
    let key = p.key;
    // ⚠️ macOS 上 `⇧⌘O` 的 `event.key` 是 **'O'**（Shift 已经反映在字符上），
    //    而 `⌘=` 的 `event.key` 是 **'='**（不用按 Shift）⇒ 只有"字母/数字"那一类要跟着 Shift 变大写。
    if (shift && key && key.length === 1 && /[a-z]/.test(key)) key = key.toUpperCase();
    return {
      key: key, code: '',
      ctrlKey: m.indexOf('ctrl') >= 0,
      altKey: m.indexOf('alt') >= 0,
      metaKey: m.indexOf('cmd') >= 0,
      shiftKey: shift,
      isComposing: false,
      keyCode: 键码(key),
    };
  }

  /**
   * 在某个 `EditorView` 的 `contentDOM` 上分发一条 `keydown`。
   *
   * ⚠️ `bubbles: true` **是必须的**：
   *   · CM6 的 `eventBelongsToEditor`（产物 `:8208`）在 `event.bubbles` 为假时直接放行，
   *     但它的父链循环以 `view.contentDOM` 为终点 ⇒ 目标是 contentDOM 本身才走通；
   *   · `keymap.js` 那个分发器挂在 **`window`** 上 ⇒ 不冒泡就到不了它。
   * ⚠️ ⛔ **不设 `synthetic`**：CM6 的 `ignoreDuringComposition`（`:8000`）里
   *   `event.synthetic` 为真会**整块跳过组合态守卫** —— 那是 CM6 给自己内部重发用的标记，
   *   页面造的事件**没有**它（实测 `undefined`）⇒ 设上去等于绕过被测对象。
   */
  function 发键到(目标, 参数) {
    const ev = new KeyboardEvent('keydown', {
      key: 参数.key, code: 参数.code, bubbles: true, cancelable: true,
      ctrlKey: 参数.ctrlKey, altKey: 参数.altKey,
      metaKey: 参数.metaKey, shiftKey: 参数.shiftKey,
      isComposing: 参数.isComposing,
    });
    // ⚠️ `keyCode`/`which` 只在构造器里传不进去（WebKit 会忽略）⇒ 用 `defineProperty` 补。
    //    它们必须是**只读**的实例属性，否则 CM6 读到的还是 0。
    try {
      Object.defineProperty(ev, 'keyCode', { value: 参数.keyCode, configurable: true });
      Object.defineProperty(ev, 'which', { value: 参数.keyCode, configurable: true });
    } catch (e) { /* 补不上就如实记（`0c` 的判据会因此变红，正是要的） */ }
    目标.dispatchEvent(ev);
    return ev;
  }

  /** 在某个 `EditorView` 的 `contentDOM` 上分发一条 `keydown`（最常用的一支）。 */
  function 发键(view, 参数) {
    return 发键到(view.contentDOM, 参数);
  }

  // ══════════════ 夹具文档 ══════════════

  const 文档 = '## 标题\n\nalpha beta gamma\n\nsecond line here\n\nthird 行中文\n';
  /** 逐字符比较用（⛔ 不靠长度：等长替换也是改动）。 */
  function 文本(view) { return view.state.doc.toString(); }

  // ══════════════ 视图装配 ══════════════

  /**
   * 按**产品那条链**装一个 `EditorView`。
   *
   * ⚠️ 前 6 项与 `src/editor/main.js::extensions()` **逐项同形**（⛔ 顺序也一样）——
   * 顺序是 `design/0012` §2.1① 的封闭白名单，动它就是改设计。
   * ⭐ 第 7 项 `vimExt`、第 8 项 `forwardExt`：`design/0014` §7.2 要求
   * **`vimExt` 的位置必须早于 `forwardExt`**（探针照做，并把真实生效顺序测出来 → `0b-4`）。
   */
  function 建视图(host, 选项) {
    const o = 选项 || {};
    const exts = [
      CM6.EditorView.lineWrapping,
      CM6.lineNumbers(),
      CM6.history(),
      CM6.keymap.of(CM6.historyKeymap),
      CM6.markdown(),
      CM6.EditorView.updateListener.of(function () {}),
    ];
    if (o.vimExt) exts.push(o.vimExt);
    if (o.forwardExt) exts.push(o.forwardExt);
    const view = new CM6.EditorView({
      state: CM6.EditorState.create({ doc: o.doc != null ? o.doc : 文档, extensions: exts }),
      parent: host,
    });
    return view;
  }

  /** 真 CM6 在离屏窗口里**可能拿不到 DOM 焦点**（实测 `document.hasFocus() === false`）。 */
  function 设焦点(view, on) {
    let 补类 = false;
    try { if (on) view.focus(); else view.contentDOM.blur(); } catch (e) { /* 记在下面 */ }
    const 该有 = view.dom.classList.contains('cm-focused');
    // ⚠️ 拿不到真焦点时**手动补类**（`edit-chrome-probe` 的既有做法），
    //    但**如实记**这一步有没有发生 —— 否则"焦点态那条规则生效了"这件事
    //    可能只是被补出来的类掩盖的。反向对照见 `0e-反向`.
    if (!!on !== 该有) { view.dom.classList.toggle('cm-focused', !!on); 补类 = true; }
    return {
      '补过类': 补类,
      'activeElement_就是contentDOM': document.activeElement === view.contentDOM,
      'activeElement_可编辑': document.activeElement ? !!document.activeElement.isContentEditable : null,
      hasFocus: view.hasFocus,
      document_hasFocus: document.hasFocus(),
    };
  }

  // ══════════════ 上游状态读数（⛔ 不猜，⛔ 不从 DOM 反推） ══════════════

  /**
   * Vim 的内部状态。
   *
   * ⭐ 读得到的原因是上游自己把 CM5 适配器挂在 view 上：
   *    `getCM(view)` 那条路最终用 `view.cm`（`vimPlugin.destroy` 里 `delete this.view.cm`）。
   *    ⇒ `view.cm.state.vim`（模式/键缓冲）与 `view.cm.state.vimPlugin`（
   *    `lastKeydown` / `useNextTextInput` / `compositionText`）都是**真值**。
   * ⚠️ 这是**只读**用途（⛔ 探针不改它们）——它们比"看 `defaultPrevented`"能多回答
   *    「**哪个守卫挡的**」，而 `0d-①` 要的正是那个形状。
   */
  function vim状态(view) {
    try {
      const cm = view && view.cm;
      const vim = cm && cm.state && cm.state.vim;
      const 插件 = cm && cm.state && cm.state.vimPlugin;
      return {
        '在': !!vim,
        '插入模式': vim ? !!vim.insertMode : null,
        '覆盖模式': vim ? !!vim.overwrite : null,
        '键缓冲': vim && vim.inputState ? String((vim.inputState.keyBuffer || []).join('')) : null,
        '状态串': vim ? String(vim.status || '') : null,
        '插件_lastKeydown': 插件 ? String(插件.lastKeydown) : null,
        '插件_useNextTextInput': 插件 ? !!插件.useNextTextInput : null,
        '插件_compositionText': 插件 ? String(插件.compositionText || '') : null,
      };
    } catch (e) { return { '读不到': String((e && e.message) || e) }; }
  }

  // ══════════════ 主流程 ══════════════

  window.__RUN = async function () {
    const 记 = [];
    function 存(id, 名, 判据, 结果, 值) {
      记.push({ id: id, '名': 名, '判据': 判据, '结果': 结果, '值': 值 || null });
    }
    function 致命(为什么) { return { '致命': 为什么, '检查': 记 }; }

    // ── E1 · 页面骨架（⛔ 缺一样就说明 .sh 与夹具对不上了） ──
    const hostA = document.getElementById('host-a');
    const hostB = document.getElementById('host-b');
    const hostC = document.getElementById('host-c');
    const hostP = document.getElementById('host-p');
    // ⭐⭐ `design/0014` 裁定 (d) 落地后（2026-10-16）：0e 那个"被测对象 ＋ 反向对照开关"
    //    已经**不再是探针自己那份候选规则**，而是**产品** `src/styles/editor.css`
    //    （`.sh` 把它逐字节内联成 `<style id="editor-css">`，理由见那边 ③ 那段）。
    const 产品表 = document.getElementById('editor-css');
    if (!hostA || !hostB || !hostC || !hostP) return 致命('页面里缺 host-a/b/c/p —— .sh 与夹具对不上');
    if (!CM6 || typeof CM6.EditorView !== 'function') return 致命('window.rmdCM6 不在 —— 先跑 make cm6，并确认 bundle.js 拷进来了');
    if (!K || typeof K.createKeymap !== 'function') return 致命('window.rmd.keymap 不在 —— src/services/keymap.js 没拷进来？');
    if (!EK || typeof EK.deriveWhitelist !== 'function') return 致命('window.rmd.editorKeys 不在 —— src/editor/keys.js 没拷进来？');
    if (!TABLE || !TABLE.length) return 致命('window.__SHORTCUTS 是空的 —— .sh 没从 gui/mod.rs 里解析出表');
    if (!产品表 || !产品表.sheet) return 致命('页面里没有 #editor-css 样式表 —— 0e 要读**产品** editor.css 的规则原文（它由 .sh 内联进来）');

    // ── 转发链（⭐ 与产品同一条：白名单**派生**自真表 ＋ 真 shim ＋ 真 buildBindings） ──
    const SPY = { log: [] };                       // ⭐ 应用 handler 的**探针桩**
    let forwardExt = null;
    let 派生 = null;
    let km = null;
    try {
      派生 = EK.deriveWhitelist(TABLE);
      const shim = EK.createForwardShim();
      km = K.createKeymap({ table: TABLE, ctx: shim.ctx });
      // ⭐ 给**每一条**表内动作挂桩（含 `owner = Menu` 的）：
      //    这样"某个键落到了应用 handler"与"落到了一条**不该**到这里的键"**都能看见**。
      TABLE.forEach(function (r) { km.register(r.id, function () { SPY.log.push(r.id); return true; }); });
      shim.bind(km);
      km.attach();                                  // ⚠️ 组合态标记的唯一写入点（`keymap.js:257`）
      forwardExt = EK.buildBindings(CM6, 派生.specs, shim.forward);
    } catch (e) {
      return 致命('转发链装不上：' + String((e && e.message) || e));
    }

    // ── 四份 vim 扩展：三种组合（A: vim+转发 / B: 只有转发 / C: 只有 vim） ＋ P: 带状态面板 ──
    let vimExt = null, vimExtStatus = null;
    try {
      // ⚠️⚠️ **不包 `Prec`**：`design/0012`/`0014` 稿里写的"Vim 插槽 = `Prec.higher`"是**两重错**——
      //   ① `Prec` 的成员**只有** `highest|high|default|low|lowest`（`@codemirror/state@6.7.6`
      //      的 `dist/index.d.ts:699-719`，本机 npm 装的那一份），**没有 `higher`**
      //      ⇒ 包一下就是 `TypeError`（本探针第一版正是这么挂的，`CM6.Prec.higher is not a function`）；
      //   ② 更要紧的是**它本来也轮不到**：`vimPlugin` 走 `domEventHandlers`（0b-3/0b-4 两条实测），
      //      而 `Prec` 只排 `keymap` facet ⇒ 包不包都一样。
      //    ⇒ 正确做法是**按扩展位置**（＝`view.plugins` 序）决定谁先拿到键，⛔ 不是包 `Prec`。
      vimExt = CM6.vim();
      vimExtStatus = CM6.vim({ status: true });
    } catch (e) {
      return 致命('CM6.vim() 调不出来：' + String((e && e.message) || e));
    }
    const viewA = 建视图(hostA, { vimExt: vimExt, forwardExt: forwardExt });  // ⭐ 产品形态
    const viewB = 建视图(hostB, { forwardExt: forwardExt });                  // 关掉开关 = 今天的样子
    // viewC：只有 vim（⛔ 不含转发扩展）⇒ 用来问"**没有我们的键位**时，`⌘`-系会落到谁手里"。
    //        ⚠️ 基线那 6 项照旧含 `historyKeymap` ⇒ `⌘Z` **仍**会被上游接手（见 0c-R2 的口径）。
    const viewC = 建视图(hostC, { vimExt: CM6.vim() });
    const viewP = 建视图(hostP, { vimExt: vimExtStatus });
    await 歇(60);

    // ══════════════ E2 · rAF 自证（⭐ 块光标靠 measure 循环才画得出来） ══════════════
    let e2;
    {
      let 帧 = 0;
      const t0 = performance.now();
      await new Promise(function (res) {
        let done = false;
        function 收() { if (!done) { done = true; res(); } }
        setTimeout(收, 1200);                        // ⚠️ 唯一与帧无关的出口
        (function 步() { if (done) return; 帧 += 1; if (performance.now() - t0 > 900) return 收(); requestAnimationFrame(步); })();
      });
      e2 = { '实测帧数': 帧, '用时': 数(performance.now() - t0) };
      e2.在跑 = 帧 >= 10;
    }
    存('E2', '离屏窗口里 rAF 在跑（块光标要它才画得出来）', '900 ms 内 ≥ 10 帧',
      e2.在跑 ? '通过' : '失败', e2);
    const 有raf = e2.在跑;

    // ══════════════ E3 · 编辑区是 activeElement（⭐ 转发链在承重的**前提**） ══════════════
    //
    // ⚠️⚠️ **这条不过，`0c-R1a` 就是一句空话**：`ctx.editable()` 读的是
    //    `document.activeElement`（`keymap.js::isEditableElement`）⇒ 焦点不在 contentDOM 上时
    //    `dispatch` 本来就放行，"转发链把它救回来了"这件事就**无从判定**（会假绿）。
    //    ⇒ 不成立时 `0c-R1a` 记**跳过**，⛔ 不记通过。
    const 焦点A = 设焦点(viewA, true);
    await 歇(30);
    const e3ok = !!(焦点A.activeElement_就是contentDOM && 焦点A.activeElement_可编辑);
    存('E3', '编辑区是 activeElement（⇒ ctx.editable() 为真）',
      'document.activeElement === view.contentDOM ∧ isContentEditable —— 转发链在承重的前提',
      e3ok ? '通过' : '跳过', 焦点A);

    // ── E4 · 块光标画得出来吗（normal 模式 ＋ 非空文档 ⇒ 应当有） ──
    //
    // ⚠️⚠️ **这里要分清"环境不成立"与"实现没画"**（那是两件完全不同的事）：
    //    · 布局为零（元素没量出来）或 rAF 不来 ⇒ **跳过**；
    //    · 布局正常、rAF 在跑，却一个 `.cm-fat-cursor` 都没有 ⇒ **失败**（真缺陷）。
    //    ⛔ 混起来会让一条"块光标根本没出现"的缺陷被 12 格"跳过"埋掉。
    const 布局ok = (function () {
      try {
        const r = viewA.dom.getBoundingClientRect();
        return r.width > 10 && r.height > 10 && viewA.contentDOM.offsetHeight > 0;
      } catch (e) { return false; }
    })();
    const 有块光标 = await 等(function () {
      return viewA.dom.querySelectorAll('.cm-fat-cursor').length > 0;
    }, 有raf ? 3000 : 800);
    const 块可判 = 有raf && 布局ok;
    存('E4', 'Normal 模式下块光标画出来了（0e 那 12 格的**前提**）',
      '`.cm-fat-cursor` 至少一个；⚠️ 布局为 0 或 rAF 不来时记**跳过**（环境），⛔ 不是失败',
      !块可判 ? '跳过' : (有块光标 ? '通过' : '失败'),
      { '有块光标': 有块光标, '布局为零吗': !布局ok, rAF: 有raf,
        '视图尺寸': (function () { try { const r = viewA.dom.getBoundingClientRect(); return { w: 数(r.width), h: 数(r.height) }; } catch (e) { return null; } })(),
        'vim状态': vim状态(viewA),
        '⚠️': '布局正常且 rAF 在跑却查不到块光标 = **真缺陷**（上游 `measureCursor` 在 '
          + '`vim && (!insertMode || overwrite)` 时该产一个）。' });
    const 块能测 = 块可判 && 有块光标;

    // ══════════════ 0b · `vim()` 到底带进来哪几件 ══════════════
    {
      const a = CM6.vim();                 // ⚠️ 新调一次（⛔ 不复用 vimExt 里那个实例）
      const b = CM6.vim({ status: true });
      function 形状(x) {
        if (x == null) return null;
        const c = x.constructor ? x.constructor.name : typeof x;
        const 键 = [];
        for (const k in x) { if (Object.prototype.hasOwnProperty.call(x, k)) 键.push(k); }
        return { '构造器': c, '自有键': 键, '有domEventHandlers': !!(x.domEventHandlers), id: (typeof x.id === 'number' ? x.id : null) };
      }
      const 各件 = a.map(形状);
      const 四件 = a.length === 4;
      const 第4项随status变 = a[3] !== b[3];
      存('0b', '`vim()` 恰好 4 项，形状与 §1.3 ① 一致',
        'length === 4 ∧ [0]=PrecExtension ∧ [1]=带 domEventHandlers 的 ViewPlugin ∧ [2]=PrecExtension ∧ [3] 是面板',
        四件 ? '通过' : '失败',
        { '长度': a.length, '各件': 各件, '第4项_默认': String(a[3] && a[3].constructor && a[3].constructor.name),
          '第4项_带status': String(b[3] && b[3].constructor && b[3].constructor.name), '第4项随status变': 第4项随status变 });
    }
    {
      // ⭐⭐ **结构性**结论：`vimPlugin` 走 `EditorView` 的原生事件表 ⇒
      //    `Prec.higher`（那个"Vim 插槽"）**对它不起作用** —— 它压根不在 `keymap` facet 里。
      const 插件 = CM6.vim()[1];
      const 事件 = 插件 && 插件.domEventHandlers ? Object.keys(插件.domEventHandlers) : [];
      存('0b-3', 'vimPlugin 走 domEventHandlers（⇒ Prec 对它无效）',
        '`vim()[1].domEventHandlers.keydown` 是函数 ∧ 事件清单含 compositionstart/keypress',
        (事件.indexOf('keydown') >= 0 && typeof 插件.domEventHandlers.keydown === 'function') ? '通过' : '失败',
        { '事件清单': 事件, 'keydown是函数': typeof (插件.domEventHandlers || {}).keydown === 'function' });
    }
    {
      // ⭐⭐ **实测**事件处理顺序：`computeHandlers`（产物 `:8044`）按 **`view.plugins` 顺序**
      //    收集 `domEventHandlers`，`runHandlers`（`:7932`）**第一个返回真的赢**。
      //    ⇒ 谁是"第一个拿到键的"，就是这张表说了算 —— ⛔ 不是 `Prec` 那句设计话说了算。
      function 插件们(view) {
        return view.plugins.map(function (p) {
          const pl = p.spec && p.spec.plugin;
          const h = pl && pl.domEventHandlers;
          return h ? { id: pl.id, '事件': Object.keys(h).join('+') } : null;
        }).filter(Boolean);
      }
      const A = 插件们(viewA);
      const vimId = CM6.vim()[1].id;
      const keydown们 = A.filter(function (x) { return x.事件.split('+').indexOf('keydown') >= 0; });
      const 位置 = keydown们.findIndex(function (x) { return x.id === vimId; });
      存('0b-4', '⭐ 谁先拿到 keydown：domEventHandlers 的**真实**顺序',
        '如实记录（`view.plugins` 顺序 ＝ `runHandlers` 的顺序，第一个返回真者赢）',
        '通过',
        { '带keydown的插件': keydown们, 'vimPlugin的id': vimId, 'vim在其中的序号': 位置,
          '受keydown的插件总数': keydown们.length,
          '⚠️说明': '序号 0 的那个插件**先**拿到键。keymap 那两个 = 上游 historyKeymap / 我们的转发扩展，'
                + '它们由 `keymap.of()` 的 `enables` 带出来；`vimPlugin` 是独立插件。' });
    }
    {
      存('0b-5', '转发白名单从真表派生（⛔ 无第二份清单）',
        '`deriveWhitelist(真表)` 的 specs 逐条都对得上表里 owner=web∧含cmd∧不含ctrl 的行；skipped 空',
        (派生.specs.length > 0 && 派生.skipped.length === 0) ? '通过' : '失败',
        { '表长': TABLE.length,
          specs: 派生.specs.map(function (r) { return r.id + '：' + r.accel + ' → ' + r.spec; }),
          skipped: 派生.skipped.map(function (r) { return r.id + '（' + r.why + '）'; }),
          notes: 派生.notes.map(function (r) { return r.id + '（' + r.why + '）'; }) });
    }

    // ══════════════ 按键分发的小框架 ══════════════
    //
    // ⚠️ `defaultPrevented` **只能在分发之后**读，而事件对象不可序列化
    //    ⇒ 由这个 `finalize()` 在每个测项收尾时补上（同 `editor-keyprobe` 的做法）。
    let 捕获 = [];
    window.addEventListener('keydown', function (e) {
      捕获.push({ key: e.key, keyCode: e.keyCode, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey,
                  shift: e.shiftKey, isComposing: e.isComposing, '事件': e });
    }, true);

    function 发一条(view, 参数) {
      const 桩前 = SPY.log.length;
      const 文前 = 文本(view);
      const 态前 = vim状态(view);
      捕获 = [];
      const ev = 发键(view, 参数);
      // ⚠️ `preventDefault` 是**同步**发生的（CM6 的 `runHandlers` 里就地调）⇒ 这里读得到。
      //    `keymap.js` 那条路径也是同步的（它自己调 `ev.preventDefault()`）。
      const 排 = 捕获.filter(function (x) { return x.事件 === ev; });
      return {
        '参数': { key: 参数.key, keyCode: 参数.keyCode,
               '修饰': [参数.ctrlKey ? 'ctrl' : '', 参数.altKey ? 'alt' : '',
                    参数.metaKey ? 'meta' : '', 参数.shiftKey ? 'shift' : ''].filter(Boolean).join('+') },
        prevented: ev.defaultPrevented,
        '应用到': SPY.log.slice(桩前),
        '文变了': 文本(view) !== 文前,
        '文本': 文本(view).replace(/\n/g, '⏎'),
        '态前': 态前, '态后': vim状态(view),
        '捕获条数': 排.length,
      };
    }

    /** 让一个 view 回到初始态（文档 ＋ 光标 0 ＋ 退出插入/可视模式）。 */
    function 复位(view) {
      try {
        const 该换 = view.state.doc.toString() !== 文档;
        view.dispatch({
          changes: 该换 ? { from: 0, to: view.state.doc.length, insert: 文档 } : undefined,
          // ⚠️ 光标也归零：`x` / `dd` 那几条判的是"光标**下面**那个字符"，位置不定就判不准。
          selection: { anchor: 0 },
        });
      } catch (e) { /* 如实记不了就让它自己红 */ }
      // ⚠️ 退出插入/可视模式：Esc 是唯一**不改文档**的路。
      try { 发键(view, { key: 'Escape', keyCode: 27 }); } catch (e) { /* 同上 */ }
    }

    // ══════════════ 0c-R1 · ⌘-系应用键在编辑区落不落到应用 handler ══════════════
    //
    // ⚠️⚠️ **判据在这里**（`design/0014` §7.1 那一行）：⭐「`⌘`-系**落到应用 handler**」。
    //    ⛔ **不是** `defaultPrevented === false` —— §7.1 原话写的是「`defaultPrevented === false`
    //    且落到应用 handler」，而**转发链在承重时** `prevented` **必然为 true**
    //    （`keys.js::buildBindings` 的 `run` 恒返回 `true` ⇒ CM6 的 `runHandlers` 会
    //    `preventDefault()`；`editor-keyprobe` 也实测到这一点）。
    //    ⇒ 那半句的本义只能由 **viewC（没有转发链）** 来承担（见 `0c-R2`）。
    //    本条如实记录 `prevented` 的**真值**，判据只压在"落到应用 handler"上。
    {
      const 行 = [];
      for (const r of TABLE) {
        复位(viewA);
        设焦点(viewA, true);
        const 参 = 事件参数(r.accel);
        const o = 发一条(viewA, 参);
        行.push({ id: r.id, accel: r.accel, owner: r.owner, spec: (派生.specs.find(function (s) { return s.id === r.id; }) || {}).spec || null,
                   prevented: o.prevented, '应用到': o.应用到, '文变了': o.文变了 });
      }
      const web行 = 行.filter(function (x) { return x.owner === 'web'; });
      const menu行 = 行.filter(function (x) { return x.owner !== 'web'; });
      // ⭐ 判据：每一条 owner=web 的行都必须落到自己的 handler 上；
      //    且**不许**落到别的 id 上（"按一次动两次"在单键层面的形态）。
      const web不合 = web行.filter(function (x) { return x.应用到.indexOf(x.id) < 0 || x.应用到.length !== 1; });
      存('0c-R1a', '⭐ owner=web 的 `⌘`-系：每一条都落到**自己**的应用 handler',
        '∀ owner=web 行：`应用到 === [该 id]`（视图 = 产品形态：vim + 转发链，编辑区聚焦）',
        (!e3ok) ? '跳过' : (web不合.length === 0 ? '通过' : '失败'),
        { '前提_E3': e3ok, '条数': web行.length, '不合规': web不合, '全表': 行 });
      // ⭐ 判据：owner=Menu 的行**一条都不许**被转发（`INV-SET-04` 的落点；
      //    `editor-keyprobe` 在真按键下也验过一次：⌘B/⌘, 各只动一次、页面侧没绑定）。
      const menu脏 = menu行.filter(function (x) { return x.应用到.length > 0; });
      存('0c-R1b', '⭐ owner=Menu 的 `⌘`-系：**一条都不**被转发',
        '∀ owner≠web 行：`应用到 === []`（菜单加速键由 AppKit 吃，前端⛔ 不许再绑一遍）',
        menu脏.length === 0 ? '通过' : '失败',
        { '条数': menu行.length, '脏': menu脏, '明细': menu行 });
    }
    {
      // ⭐ 反面控制：① 表外的 `⌘Y` 不许落进任何 handler；
      //    ② `⌘Z` 由上游 `historyKeymap` 接手（undo 真的执行）——即"转发链**不是**一张全通过网"。
      //    ⚠️ 夹具：先用 Vim 的 `dd` 造一条**确定的**改动（⛔ 不靠 `复位` 那次 dispatch ——
      //       它自己有 `selection` 而无 `changes`，在"文档本来就对"时**什么都不做**，
      //       于是 `⌘Z` 就没有东西可退，判据会假红）。
      复位(viewA); 设焦点(viewA, true); await 歇(30);
      发键(viewA, { key: 'd' }); await 歇(20);
      发键(viewA, { key: 'd' }); await 歇(40);
      const 改后 = 文本(viewA);
      const o1 = 发一条(viewA, { key: 'y', meta: true });
      const o2 = 发一条(viewA, 事件参数({ key: 'z', meta: true }));
      await 歇(30);
      存('0c-R1c', '反面控制：表外键不转发、`⌘Z` 由上游接手',
        '`⌘Y`（表外）：应用到 === []；`⌘Z`：`prevented === true` ∧ 上游 `historyKeymap` 真的把 `dd` 退回去了（文本逐字符回到原样）',
        (o1.应用到.length === 0 && o2.prevented === true && 文本(viewA) === 文档) ? '通过' : '失败',
        { 'dd后首行': 改后.split('\n')[0], '⌘Y': { '应用到': o1.应用到, prevented: o1.prevented },
          '⌘Z': { '应用到': o2.应用到, prevented: o2.prevented, '文变了': o2.文变了 },
          '⌘Z后逐字符回到原样': 文本(viewA) === 文档,
          '⚠️': '`⌘Z` 的 spec 在 mac 上归一到 **`Meta-z`**（CM6 的 `keyName` 在 `isChar && meta` 时'
            + '走 `base[keyCode]` 那一支 ⇒ 小写），而 `historyKeymap` 注册的正是 `Mod-z` ⇒ 对得上。' });
    }
    {
      // ⭐⭐ `0c-R2`：**Vim 自己**折不折 `⌘`-系（§1.3 那个"读代码推出来的"结论，本条是**实测**）。
      //    用 viewC（有 vim、⛔ **没有**转发扩展）才能把它与我们的链分开。
      //    ⚠️⚠️ 口径（第一版判据写错过一次，如实记着）：基线那 6 项**含 `historyKeymap`**，
      //       它注册了 `Mod-z` ⇒ **`⌘Z` 被 `prevented` 是上游 `historyKeymap` 干的，⛔ 不是 Vim 吞的**
      //       （`0c-R1c` 已单独验过它真的 undo 了一次）。所以"Vim 吞"这件事的判据是
      //       **另外那 7 键** ⇒ 它们必须 `prevented === false`。`⌘Z` 如实记录、⛔ 不计入。
      //    ⭐ 另外 8 键**都不许**落到应用 handler（`应用到 === []`）——那是"Vim 把 ⌘-系喂给了我们的表"。
      const 键 = ['Cmd+S', 'Cmd+F', 'Cmd+P', 'Cmd+C', 'Cmd+V', 'Cmd+X', 'Cmd+A', 'Cmd+Z'];
      const 行 = [];
      for (const a of 键) {
        复位(viewC); 设焦点(viewC, true);
        const o = 发一条(viewC, 事件参数(a));
        行.push({ '键': a, prevented: o.prevented, '文变了': o.文变了, '应用到': o.应用到, '态后': o.态后 });
      }
      const 非Z = 行.filter(function (x) { return x.键 !== 'Cmd+Z'; });
      const 被吞 = 非Z.filter(function (x) { return x.prevented || x.文变了; });
      const 落应用 = 行.filter(function (x) { return x.应用到.length > 0; });
      存('0c-R2', '⭐ Vim **自己**不吞 `⌘`-系（7 键；`⌘Z` 由基线里的 `historyKeymap` 接手）',
        '除 `⌘Z` 外 7 键：`prevented === false` ∧ 文档不变 ∧ **8 键都不落应用 handler**'
        + '（⇒ §1.3 的 `undefined` 放行是**实测**的；`⌘Z` 的 `prevented` 属于 `historyKeymap`，⛔ 不算 Vim 吞）',
        (被吞.length === 0 && 落应用.length === 0) ? '通过' : '失败',
        { '被吞': 被吞, '落应用': 落应用, '明细': 行 });
    }
    {
      // ⭐⭐ `0c-R2b`：**插入模式**下再扫一遍 `owner=web` 的 `⌘`-系。
      //    ⚠️ 为什么必须另扫：`0c-R1a`（视图 A、**normal** 模式）只证明了一件事的一半 ——
      //       而上游 `vimPlugin` 的 keydown 分支是**按模式**走的（`insertMode` 下走另一条路）。
      //       本条要挡的是一个**会卡死用户**的形态：敲着中文（插入模式）按 `⌘E`（`edit.toggle`）
      //       却被 Vim 吞掉 ⇒ 退不出编辑态。
      //    ⚠️ 判据与 `0c-R1a` **同形**（每一条落到**自己**的 handler 上），⛔ 不发明第二套。
      复位(viewA); 设焦点(viewA, true); await 歇(30);
      发键(viewA, { key: 'i' });
      const 进插入 = await 等(function () { return vim状态(viewA).插入模式 === true; }, 1200);
      const 行2 = [];
      for (const r of TABLE) {
        设焦点(viewA, true);
        const o = 发一条(viewA, 事件参数(r.accel));
        行2.push({ id: r.id, accel: r.accel, owner: r.owner, prevented: o.prevented,
                   '应用到': o.应用到, '仍在插入模式': o.态后.插入模式 });
      }
      const web行2 = 行2.filter(function (x) { return x.owner === 'web'; });
      const 不合2 = web行2.filter(function (x) { return x.应用到.indexOf(x.id) < 0 || x.应用到.length !== 1; });
      存('0c-R2b', '⭐ 插入模式下 `owner=web` 的 `⌘`-系**同样**落到应用 handler',
        '∀ owner=web 行：`应用到 === [该 id]`（⚠️ 打字打到一半按 `⌘E`/`⌘F` 也必须到得了应用）',
        (!进插入 || !e3ok) ? '跳过' : (不合2.length === 0 ? '通过' : '失败'),
        { '进了插入模式': 进插入, '前提_E3': e3ok, '条数': web行2.length, '不合规': 不合2, '全表': 行2 });
      复位(viewA); await 歇(20);
    }

    // ══════════════ 0c-C · `⌃O`/`⌃K`/`⌃D`/`⌃H`（裁定 (e) 的基线） ══════════════
    //
    // ⚠️⚠️ **本层只能答"页内谁处理了它"，⛔ 答不了"WebKit 会改什么"**（见文件头的诚实性边界）。
    //    「WebKit 会改什么」的真按键实测在 `design/0012` §2.3-4（71→72 / 51 / 70 / 70）
    //    ＋ `benchmarks/results/editor-key-2026-10-16-Mac14,9.json` —— ⭐ 引用它，⛔ 不复现它。
    {
      const 键 = ['Ctrl+O', 'Ctrl+K', 'Ctrl+D', 'Ctrl+H'];
      const 开 = [];
      for (const a of 键) {
        复位(viewA); 设焦点(viewA, true);
        const o = 发一条(viewA, 事件参数(a));
        // ⭐ 裁定 (e)：判据是「**改了什么 ＋ 退得回去吗**」（⛔ 只看 prevented 不算数）。
        let 退回 = null;
        if (o.文变了) {
          发键(viewA, 事件参数({ key: 'z', meta: true }));
          await 歇(20);
          退回 = 文本(viewA) === 文档;
        }
        开.push({ '键': a, prevented: o.prevented, '文变了': o.文变了, '应用到': o.应用到,
                  '⌘Z_能精确退回': 退回, '态前': o.态前.插入模式, '态后': o.态后, '文本': o.文本 });
      }
      const 关 = [];
      for (const a of 键) {
        复位(viewB); 设焦点(viewB, true);
        const o = 发一条(viewB, 事件参数(a));
        关.push({ '键': a, prevented: o.prevented, '文变了': o.文变了, '应用到': o.应用到 });
      }
      const 关_被处理 = 关.filter(function (x) { return x.prevented || x.应用到.length > 0; });
      存('0c-C-开', '⭐ Vim 开着时 `⌃O/⌃K/⌃D/⌃H` 的基线（改了什么 ＋ 退得回去吗）',
        '如实记录：逐条 ① `prevented` ② 文档前后 ③ `⌘Z` 能不能**精确**退回（⛔ 只看 prevented 不算数）',
        '通过', { '明细': 开,
          '⚠️引用': 'WebKit 侧的默认行为（真按键）见 design/0012 §2.3-4 ＋ '
                + 'benchmarks/results/editor-key-2026-10-16-Mac14,9.json（71→72 / 51 / 70 / 70）；'
                + '合成事件下它**不可观察**，⛔ 别把 prevented=false 读成"WebKit 不会改"' });
      存('0c-C-关', 'Vim 关着时 `⌃O/⌃K/⌃D/⌃H`：页内**没人**处理（⇒ WebKit 默认照旧适用）',
        '∀ 4 键：`prevented === false` ∧ 应用到 === [] ∧ 文档不变（这是**关掉开关**回落到今天的样子）',
        关_被处理.length === 0 ? '通过' : '失败', { '明细': 关 });
    }
    {
      // ⚠️ `⌃H` 的**两种可能**（§7.1 `0c` 那一行点名要区分的）：
      //    ① 系统把它当 `deleteBackward` ⇒ `e.key` 可能是 `'Backspace'`（`specialKey` 会翻成 `<BS>`）；
      //    ② `e.key` 就是 `'h'`（⇒ `<C-h>`，正是 Vim 的插入模式退格）。
      //    ⇒ 两条都发一遍，看 Vim 各认成什么。⚠️ `e.key` 的**真值**仍只能取 `editor-keyprobe`。
      复位(viewA); 设焦点(viewA, true);
      const a = 发一条(viewA, 事件参数({ key: 'h', ctrl: true }));
      复位(viewA); 设焦点(viewA, true);
      const b = 发一条(viewA, 事件参数({ key: 'Backspace', ctrl: true, keyCode: 8 }));
      存('0c-C-H-两形态', '`⌃H` 的两种 `e.key` 形态（如实记录）',
        '两种写法各发一次，记录 `prevented` / 文档变化 / Vim 认成了什么（`vimKeyFromEvent` 的产物）',
        '通过', { e_key_h: a, e_key_Backspace: b,
          '⚠️说明': '真按键下 `e.key` 到底是哪一个，只能取 `editor-keyprobe` 的 e.key 原始记录 —— '
                + '合成事件造不出"WebKit 先做了系统级替换"这一步。' });
    }
    {
      // ⭐⭐ `⌥x`（§1.4 那条反例）：mac 上 `A-` 前缀被上游**剥掉** ⇒ 键变成裸 `x` ⇒
      //    normal 模式下**执行 vim 的 `x`＝删一个字符**。⚠️ 判据是"真的改了文档"，⛔ 不是"看起来没反应"。
      复位(viewA); 设焦点(viewA, true);
      const 长前 = 文本(viewA).length;
      const o = 发一条(viewA, { key: 'x', alt: true });
      const o2 = 发一条(viewA, { key: '≈', alt: true });
      存('0c-Alt-x', '⭐ `⌥x` 在 normal 模式下被当成 `x`（改文档）',
        '`{altKey, key:"x"}`：`prevented` ∧ 文档长度 **-1** ∧ 落到 0 个应用 handler',
        (o.prevented === true && 文本(viewA).length === 长前 - 1 && o.应用到.length === 0) ? '通过' : '失败',
        { '长前': 长前, x: o, '长后': 文本(viewA).length, '近似号变体': o2,
          '⚠️影响面': 'normal 模式本来就不打字、中文拼音不用 ⌥ ⇒ 实际很窄，但**必须登记**：'
                  + '它不在"逐条过 SHORTCUTS 表"那道闸的覆盖范围内（⌥-系键根本不在表里）' });
    }

    // ══════════════ 0c-V · Vim 基本动作（hjkl / dd / u / : / 模式类名） ══════════════
    {
      复位(viewA); 设焦点(viewA, true);
      // 先把光标挪到第 3 行中段（`h`/`l` 两个方向都要看得见）
      const 修 = viewA.state.doc.line(3).from + 5;
      viewA.dispatch({ selection: { anchor: 修 } });
      await 歇(20);
      const 起 = viewA.state.selection.main.head;
      发键(viewA, { key: 'h' }); await 歇(20);
      const 左 = viewA.state.selection.main.head;
      发键(viewA, { key: 'l' }); await 歇(20);
      const 右 = viewA.state.selection.main.head;
      存('0c-V-hjkl', '`h`/`l` 移动光标且**不改文档**',
        '`h` ⇒ head −1；`l` ⇒ head 回到原处；两次文档都不变',
        (左 === 起 - 1 && 右 === 起 && 文本(viewA) === 文档) ? '通过' : '失败',
        { '起': 起, '按h后': 左, '按l后': 右 });
    }
    {
      复位(viewA); 设焦点(viewA, true);
      await 歇(20);
      const 行数前 = viewA.state.doc.lines;
      发键(viewA, { key: 'd' }); await 歇(20);
      发键(viewA, { key: 'd' }); await 歇(40);
      const 删后 = 文本(viewA);
      const 行数后 = viewA.state.doc.lines;
      发键(viewA, { key: 'u' }); await 歇(60);
      const 还原 = 文本(viewA) === 文档;
      存('0c-V-dd-u', '⭐ `dd` 删一行 ＋ `u` **精确**还原（Vim 的撤销走 CM6 history）',
        '`dd` ⇒ 行数 -1 ∧ 文本变了；`u` ⇒ 文本**逐字符**回到原样',
        (行数后 === 行数前 - 1 && 删后 !== 文档 && 还原) ? '通过' : '失败',
        { '行数前': 行数前, '行数后': 行数后, 'dd后首行': 删后.split('\n')[0], 'u后逐字符相等': 还原 });
    }
    {
      // ⭐ `.cm-vimMode` 只在 **normal/overwrite** 模式存在（上游 `updateClass`，产物 `:1406`）
      //    ——它是上游遮蔽原生插入符那条规则的**开关**，也是本探针 0e③ 的支点。
      复位(viewA); 设焦点(viewA, true); await 歇(40);
      const normal = { '类': viewA.scrollDOM.classList.contains('cm-vimMode'), '插入模式': vim状态(viewA).插入模式 };
      发键(viewA, { key: 'i' }); await 歇(40);
      const insert = { '类': viewA.scrollDOM.classList.contains('cm-vimMode'), '插入模式': vim状态(viewA).插入模式 };
      复位(viewA); await 歇(40);
      存('0c-V-模式类名', '⭐ `.cm-vimMode` 只在 normal 模式存在（上游 `updateClass`）',
        'normal ⇒ 有该类 ∧ 插入模式=false；按 `i` ⇒ 类消失 ∧ 插入模式=true',
        (normal.类 === true && normal.插入模式 === false && insert.类 === false && insert.插入模式 === true) ? '通过' : '失败',
        { normal: normal, insert: insert,
          '⚠️为什么重要': '上游那句 `caret-color: transparent !important` 挂在 `.cm-vimMode .cm-line` 上 ⇒ '
                     + '它**只在 normal 模式生效**；insert 模式下 editor.css 的 `caret-color: var(--ui-text)` 照常赢' });
    }
    {
      // ⭐ 裁定 (b)：`:q` / `:wq` **不做就是不做** —— 但上游**自带**可见回显，
      //    我们要验的是它真的走到 `openNotification`（DOM 里出现），⛔ **不是** `alert()` 回落。
      let alert数 = 0;
      const 原alert = window.alert;
      window.alert = function () { alert数 += 1; };
      function 屏幕文本() { return viewA.dom.textContent || ''; }
      // ⚠️ `发键` 是同步的，而 `:` 面板的 DOM 更新要**一轮 frame** ⇒ 每步之间必须 `歇`。
      //    ⇒ 读屏这一步因此**不能**写在同步函数里（那会造出 `await` 出现在非 async 函数里的语法错，
      //    本文件第一版就是这么挂的）——统一走下面那个 `async` 的 `跑冒号命令`，⛔ 不留第二份。
      复位(viewA); 设焦点(viewA, true); await 歇(30);
      const 冒号前 = 屏幕文本();
      发键(viewA, { key: ':' }); await 歇(60);
      const 冒号后 = 屏幕文本();
      const 面板节点 = Array.prototype.map.call(
        viewA.dom.querySelectorAll('.cm-vim-panel, .cm-vim-message, .cm-dialog, [class*="vim"]'),
        function (e) { return { '类': String(e.className), '文本': (e.textContent || '').slice(0, 60) }; });
      存('0c-V-冒号', '⭐ 按 `:` 出现上游**自己**的输入行（不自研第二套指示器）',
        '按 `:` 后 DOM 里出现一个新的、类名含 vim 的节点（或既有节点文本从空变非空）',
        (面板节点.length > 0 || 冒号后 !== 冒号前) ? '通过' : '失败',
        { '前后文本差': (冒号前 === 冒号后) ? '无变化' : '有变化', '面板节点': 面板节点,
          '⚠️': '上游 `vim()` 默认走 `vimPanelState`（StateField）；`{status:true}` 那一档才带 `.cm-vim-panel` 常显条（见 0c-V-状态面板）' });

      /**
       * ⭐⭐ 跑一条 `:` 命令并**读回屏幕**。⛔ **不**靠"逐字符 `发键`"敲进命令 ——
       * ⚠️⚠️ 上游的 `:` 命令行是**真 `<input>`**（本机实测：`makePrompt()` 造
       * `div>span(prefix)+input[type=text]`，`openDialog()` 里 `inp.focus()`，在 `inp` 上听
       * `input`/`keydown`/`keyup`/`blur`，`e.keyCode == 13` 才 `callback(inp.value)`）。
       * 而页面里 `dispatchEvent` 造的是**不可信事件** ⇒ WebKit ⛔ **不会**为它把字符插进
       *   `<input>` 的 value 里（同"不可信事件没有默认编辑行为"那条边界）⇒ 逐字符敲出来的
       *   命令**根本提交不到**，面板只显示一个 `:`（本探针第一版就是这么假的）。
       * ⭐ 所以这里**直接写 `inp.value` 再补一条 `input` 事件** —— 与"粘贴"等价，
       *   ⛔ 不是在验"浏览器会不会往 input 里插字"，而是让上游拿到一份**它自己会读到**的值，
       *   再去验**上游对 `:q` / `:w` 怎么处置**（那才是本格的被测对象）。
       * ⚠️ 反馈里如实带 `有input` 与 `输入值`：命令没提交成时，读的人要能一眼看出来。
       */
      async function 跑冒号命令(命令) {
        复位(viewA); 设焦点(viewA, true); await 歇(30);
        发键(viewA, { key: ':' }); await 歇(60);
        const inp = viewA.dom.querySelector('.cm-vim-panel input')
                 || viewA.dom.querySelector('input[type="text"]')
                 || viewA.dom.querySelector('.cm-vim-panel input, .cm-dialog input');
        if (inp) {
          inp.value = 命令;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          发键到(inp, { key: 'Enter', keyCode: 13 });
        }
        await 歇(120);
        return { '屏幕': 屏幕文本(), '有input': !!inp, '输入值': inp ? inp.value : null,
                 '面板': viewA.dom.querySelector('.cm-vim-panel') ? String(viewA.dom.querySelector('.cm-vim-panel').textContent).slice(0, 80) : null };
      }
      const q后 = await 跑冒号命令('q');
      const q节点 = Array.prototype.map.call(
        viewA.dom.querySelectorAll('*'),
        function (e) { return { '类': String(e.className), '文本': (e.textContent || '').slice(0, 80) }; })
        .filter(function (x) { return /not (an )?editor command|is not implemented|not implemented/i.test(x.文本); });
      存('0c-V-冒号q', '⭐ `:q` 报"未实现"且**可见**（上游自带，⛔ 不是 alert）',
        '`有input` 为真（命令真的提交到了上游）∧ DOM 里出现含 `Not an editor command` 的节点'
        + ' ∧ `window.alert` 一次都没被调',
        (q后.有input && q节点.length > 0 && alert数 === 0) ? '通过' : '失败',
        { '命中节点': q节点, 'alert调用次数': alert数, '有input': q后.有input, '输入值': q后.输入值,
          '面板': q后.面板, '屏幕文本末段': q后.屏幕.slice(-160) });

      const wq后 = await 跑冒号命令('wq');
      const wq节点 = Array.prototype.map.call(
        viewA.dom.querySelectorAll('*'),
        function (e) { return { '类': String(e.className), '文本': (e.textContent || '').slice(0, 80) }; })
        .filter(function (x) { return /not (an )?editor command|is not implemented|not implemented/i.test(x.文本); });
      存('0c-V-冒号wq', '⭐ `:wq` 与 `:q` 同形（未实现且可见）',
        '`有input` 为真 ∧ DOM 里出现含 `Not an editor command` 的节点 ∧ `window.alert` 零次',
        (wq后.有input && wq节点.length > 0 && alert数 === 0) ? '通过' : '失败',
        { '命中节点': wq节点, 'alert调用次数': alert数, '有input': wq后.有input, '输入值': wq后.输入值,
          '面板': wq后.面板, '屏幕文本末段': wq后.屏幕.slice(-160) });

      // ⭐⭐ 基线：上游 `exCommands.write` 的默认实现是**静默 no-op**
      //    （`core/vim.js` 那段 `if (CM.commands.save) …` 在 rmd 里永远不成立）
      //    ⇒ 本格钉住"**静默**"这个性质本身：⛔ 它不该报"未实现"（那就说明走的是另一条路）。
      //    ⚠️ 实现（`vim.js` 注册 `:w`）之后这一格**应当翻红** ⇒ 那时把判据改成
      //    "走既有保存入口 ＋ 成功前不显示已保存"（`design/0014` §7.2 的 `vim-save.test.js`）。
      const w后 = await 跑冒号命令('w');
      const w节点 = Array.prototype.map.call(
        viewA.dom.querySelectorAll('*'),
        function (e) { return { '类': String(e.className), '文本': (e.textContent || '').slice(0, 80) }; })
        .filter(function (x) { return /not (an )?editor command|is not implemented|not implemented/i.test(x.文本); });
      存('0c-V-冒号w', '基线：`:w` 现在是**静默** no-op（下游必须把它接上）',
        '`有input` 为真（命令真的到了上游）∧ `:w` 之后 DOM 里**没有**任何报错节点'
        + ' ∧ `window.alert` 零次 ⇒ 证明"静默"这个性质本身存在',
        (w后.有input && w节点.length === 0 && alert数 === 0) ? '通过' : '失败',
        { '命中节点': w节点, 'alert调用次数': alert数, '有input': w后.有input, '输入值': w后.输入值,
          '面板': w后.面板, '屏幕文本末段': w后.屏幕.slice(-160),
          '⚠️交付时': '本格是**实现前基线**。接上 `:w` 之后它会翻红 —— 那是**预期的**，'
                  + '届时按 design/0014 §7.2 的 `vim-save.test.js` 改写判据（⛔ 不是把断言删掉）' });
      window.alert = 原alert;
    }
    {
      // ⭐ 裁定 (c)：用**上游**的模式面板，⛔ 不自研第二套指示器 ⇒ 先把它的 DOM 看清楚
      //    （它进不进布局、多高、在哪个容器里 —— 都是 §7.3 那条"有效视口对齐"的输入）。
      设焦点(viewP, true); await 歇(120);
      const 面板 = viewP.dom.querySelector('.cm-vim-panel');
      const 父 = 面板 && 面板.parentElement;
      存('0c-V-状态面板', '⭐ `vim({status:true})` 的模式面板真的画出来了（裁定 (c) 的支点）',
        '`.cm-vim-panel` 存在 ∧ 文本含模式名 ∧ 它在 `.cm-editor` 之内（⇒ 会影响布局，必须在滚动同步里算进去）',
        (面板 && /NORMAL|INSERT|VISUAL/i.test(面板.textContent || '')) ? '通过' : '失败',
        { '存在': !!面板, '文本': 面板 ? String(面板.textContent).slice(0, 40) : null,
          '父类名': 父 ? String(父.className) : null,
          '在编辑器内': !!(面板 && viewP.dom.contains(面板)),
          '高': 面板 ? 数(面板.getBoundingClientRect().height) : null,
          '⚠️': '面板的显/隐与切模式**必须纳入布局与滚动同步**（裁定 (c)），'
            + '§7.3 的判据是"两栏**有效视口**对齐"（⛔ 不是"高度差=0"）' });
    }

    // ══════════════ 0d-① · 组合态（中文 IME）的形状 ══════════════
    //
    // ⚠️⚠️ **合成事件的边界**（同文件头）：这里造得出 `compositionstart/update/end` 与
    //    带 `isComposing` 的 keydown，⛔ 造不出 IME 真实的 input 记录流
    //    （WebKit 只为**可信**输入发 `beforeinput`/`input`）⇒ ⚠️ CM6 的 `inputState.composing`
    //    停在 **0**（`compositionstart` 只置 0，`>0` 要 `beforeinput` 抬）⇒
    //    ⚠️ `ignoreDuringComposition` 那条 `composing > 0` 的守卫**在本形态下不会被触发**。
    //    ⇒ 本层测的是"**页内 Vim 自己**的守卫"，⛔ 测不到 CM6 那一层 —— 如实写进结论。
    //    ⭐ 真实 IME 下的观感仍归 `0d-②`（人工，`make verify-0d` 同族）。
    {
      const 事件 = [];
      function 记(e) { 事件.push(e); }
      function 发组合(type, 详情) {
        const ev = new CompositionEvent(type, Object.assign({ bubbles: true }, 详情 || {}));
        viewA.contentDOM.dispatchEvent(ev);
        return ev;
      }
      复位(viewA); 设焦点(viewA, true); await 歇(40);
      发键(viewA, { key: 'i' }); await 歇(40);           // 进插入模式（IME 只在这里打字）
      const 插入 = vim状态(viewA).插入模式;

      // ① `key:'Process'`（真实 IME 的第一步）
      发组合('compositionstart', { data: '' });
      await 歇(20);
      const 组合态标记 = !!(km.composition && km.composition.active);
      const cm6组合态 = (function () { try { return { composing: viewA.inputState.composing, view_composing: !!viewA.composing }; } catch (e) { return { '读不到': String(e) }; } })();
      const o1 = 发一条(viewA, { key: 'Process', keyCode: 229, isComposing: true });
      // ② 真实 IME 的第二步：**普通字符键**（`isComposing` 为真）
      const o2 = 发一条(viewA, { key: 'n', keyCode: 229, isComposing: true });
      // ③ 组合期间的应用键（`INV-SET-05` 在编辑态仍要成立）
      const o3 = 发一条(viewA, 事件参数({ key: 's', meta: true }));
      发组合('compositionupdate', { data: 'ni' });
      发组合('compositionend', { data: '你' });
      await 歇(20);
      const 组合态标记_后 = !!(km.composition && km.composition.active);
      // ④ 组合结束后紧接的那一瞬 —— ⚠️⚠️ 这是全探针**最容易假红**的一格（第一版就是这么红的，
      //    如实记着）：第一版这里先 `复位(viewA)` 再发两个 `x`，结果**两个 `x` 一个都没删**。
      //    当时看起来像"组合态把 Vim 弄坏了"，⭐ 追下去是**一手根因**（`@codemirror/view`
      //    `dist/index.js`，本机 node_modules）：
      //    ```js
      //    ignoreDuringComposition(event) {
      //      if (!/^key/.test(event.type) || event.synthetic) return false;
      //      if (this.composing > 0) return true;
      //      if (browser.safari && !browser.ios && this.compositionPendingKey
      //          && Date.now() - this.compositionEndedAt < 100) {
      //        this.compositionPendingKey = false; return true; }   // ← **一次性**（吞完自清）
      //      return false; }
      //    ```
      //    `observers.compositionend` 写 `composing = -1; compositionEndedAt = Date.now();
      //    compositionPendingKey = true`，而 `handleEvent` 在跑**任何** handler **之前**先调它
      //    ⇒ ⭐ **`compositionend` 之后 100 ms 内的「第一键」被 CM6 吞掉**，且**只吞这一个**。
      //    ⇒ 第一版那条 `复位`（内部发 Escape）**正好**是那个被吞掉的"第一键" ⇒ 没退出插入模式，
      //      后面两个 `x` 落在插入模式里 ⇒ 什么都不删。**⛔ 不是产品缺陷，也没动 CM6 一行。**
      //    ⚠️ 这是**外部依赖的行为**，但对 `0d-②`（人工中文 IME）有一条**用户可感的结论**：
      //      真实输入法上屏后立刻按的第一个键**可能要按两次**才生效。
      //    ⇒ 本格分两段，把「窗口内被吞」与「越过窗口后一切正常」**分开如实记**。
      const o4 = 发一条(viewA, { key: 'x' });            // ① 100 ms 窗口**内**的第一键
      const 窗内吞了 = (o4.prevented === false && o4.文变了 === false);
      await 歇(150);                                      // ② 越过那个 100 ms 窗口
      复位(viewA); await 歇(40);
      const 复位后 = vim状态(viewA).插入模式 === false;     //    ⇒ 这一次 Escape 必须真的生效
      const o5 = 发一条(viewA, { key: 'x' });
      const o6 = 发一条(viewA, { key: 'x' });
      const 文4 = 文本(viewA);

      存('0d-1', '组合期间 `key:"Process"` **不进** Vim（上游 `lastKeydown` 守卫）',
        '`prevented === false` ∧ 文档不变 ∧ `插件_useNextTextInput` 为真',
        (o1.prevented === false && o1.文变了 === false && o1.态后.插件_useNextTextInput === true) ? '通过' : '失败',
        { '结果': o1, 'cm6组合态': cm6组合态, '组合态标记': 组合态标记, '插入模式': 插入 });
      存('0d-2', '⭐ 组合期间**普通字符键**（`isComposing:true`）会不会进 Vim',
        '应当在 Vim 的**插入模式**下不被当命令（`prevented === false`）；⚠️ 命中了就是 `#178` 的形态 ⇒ 交付前上报',
        (o2.prevented === false && o2.文变了 === false) ? '通过' : '失败',
        { '结果': o2,
          '⚠️若红': '⚠️⚠️ 这就是 `#178` 的形态：上游的 keydown 守卫只看 `e.key == "Unidentified"/"Process"/"Dead"`，'
                + '**不看** `isComposing`、**不看** `keyCode 229` ⇒ 组合中的真实字符键会被当 Vim 命令。'
                + '⚠️ 但要注意本形态下 `handleKey` 仍可能因"插入模式里没有这个绑定"而放行 —— '
                + '要区分"守卫挡住了"与"插入模式本来就不认这个键"（看 `态后.插件_lastKeydown`）。' });
      存('0d-3', '组合期间 `⌘S` **落不到**应用 handler（`INV-SET-05` 在编辑态仍成立）',
        '`应用到 === []`（`keymap.js::dispatch` 被 `compositionActive()` 挡）',
        o3.应用到.length === 0 ? '通过' : '失败',
        { '结果': o3, '组合态标记': 组合态标记, '组合态标记_结束前': 组合态标记_后 });
      存('0d-4', '⭐ 组合结束后 **100 ms 内**的第一键被 CM6 吞掉（Safari 一次性守卫）',
        '窗口内：`prevented === false` ∧ 文档不变（＝**如实记**这条外部依赖的行为）；'
        + '⛔ 本格**不判**"该不该吞"——那是 `@codemirror/view` 的既定行为，本项目一行没改',
        窗内吞了 ? '通过' : '失败',
        { '窗口内的第一键': o4, '窗内吞了': 窗内吞了,
          '⚠️根因': 'CM6 `ignoreDuringComposition()`：`compositionPendingKey && '
                 + 'Date.now() - compositionEndedAt < 100` ⇒ 吞掉**并且只吞这一个**'
                 + '（`@codemirror/view` `dist/index.js`，本机 node_modules 一手）',
          '⚠️对 0d-② 人工验收的结论': '真实中文输入法上屏后**立刻**按的第一个键可能**要按两次**才生效 —— '
                            + '⛔ 不是本项目的缺陷，但用户看得见 ⇒ 人工验收时要**专门试一下**这个形态' });
      存('0d-4b', '⭐ 越过 100 ms 窗口之后：Escape 真的退插入模式，且两键都进 Vim',
        '`复位` 后 `插入模式 === false` ∧ 两个 `x` 各删一个字符（文档少 2 个字符）；⛔ 不许只认第一个',
        (复位后 && o5.prevented === true && o6.prevented === true && 文4.length === 文档.length - 2) ? '通过' : '失败',
        { '复位后仍在插入模式': !复位后, '第一键': o5, '第二键': o6,
          '文档长度': [文档.length, 文4.length] });
    }

    // ══════════════ 0e · 块光标与其颜色（裁定 (d)：四个面 × 三套主题） ══════════════
    //
    // ⚠️⚠️ 判据压在**打印出来的规则原文**上（用户口述：「具体选择器由锁定版本的真实样式验证，
    //    ⛔ 不把 (0,4,0) 当通用保证」），而且**每格都配一次反向对照**：
    //    把**产品那张表**（`<style id="editor-css">`，内容 = `src/styles/editor.css` 逐字节）
    //    `disabled = true` 之后，同一格必须**回到上游的写死色** ——
    //    这才是"我们的规则真的赢了"的**证据**（⛔ 不是"我看了一眼觉得对"）。
    //    ⚠️ 这正是裁定 (d) 落地之后**比原来更强**的一点：停用的是**产品表本身**，
    //    ⛔ 探针再也不可能用自己那份规则把这一格"凑绿"。
    {
      // ── 先量"主题变量本身"（用两个量色块，⛔ 不解析字符串里的 var()） ──
      function 变量色() {
        return {
          '--ui-text': 色(计算(document.getElementById('sw-text'), 'color')),
          '--ui-bg':   色(计算(document.getElementById('sw-bg'), 'backgroundColor')),
          '--ui-accent': 色(计算(document.getElementById('sw-accent'), 'color')),
          // ⭐ 探针要验的主角：它是**产品新加的那个旋钮**（`tokens.css` 的 `:root`），
          //    靠 `var()` 链指到 `--ui-text` ⇒ 这里必须能读到，否则产品那两条用的
          //    就是个**未定义变量**（会静默失效，屏幕上表现为"块光标还是上游的粉"）。
          '--ui-caret': 色(计算(document.getElementById('sw-caret'), 'color')),
          '--ui-caret-text': 色(计算(document.getElementById('sw-caret-text'), 'backgroundColor')),
        };
      }
      const 主题们 = ['light', 'dark', 'warm'];
      const 矩阵 = [];
      const 上游块色 = 'rgb(255,150,150)';             // `#ff9696`（三个分量都是十进制）

      async function 一块(主题) {
        document.documentElement.setAttribute('data-theme', 主题);
        复位(viewA); 设焦点(viewA, true);
        // ⚠️ 切模式（Esc）与改属性之后，块光标要**下一轮 measure** 才回来
        //    ⇒ 等它，⛔ 不拿固定 sleep 赌（离屏窗口的帧率不稳，赌错就是假红）。
        const 块回来了 = await 等(function () {
          return viewA.dom.querySelectorAll('.cm-fat-cursor').length > 0;
        }, 块能测 ? 2000 : 200);
        const 变量 = 变量色();
        const 块 = viewA.dom.querySelector('.cm-fat-cursor');
        const 行 = viewA.dom.querySelector('.cm-line');
        // ⭐ 反向对照：临时停用**产品那张表**（`src/styles/editor.css` 逐字节内联的那一份）
        function 取值() {
          const 块2 = viewA.dom.querySelector('.cm-fat-cursor');
          const 行2 = viewA.dom.querySelector('.cm-line');
          const 自有层 = viewA.dom.querySelector('.cm-cursorLayer:not(.cm-vimCursorLayer)');
          return {
            '块_背景': 色(计算(块2, 'backgroundColor')),
            '块_字色': 色(计算(块2, 'color')),
            '块_轮廓': 色(计算(块2, 'outlineColor')),
            '块_轮廓样式': 计算(块2, 'outlineStyle'),
            '块_数': viewA.dom.querySelectorAll('.cm-fat-cursor').length,
            '行_插入符色': 色(计算(行2, 'caretColor')),
            '行_文本色': 色(计算(行2, 'color')),
            '自有光标层_display': 计算(自有层, 'display'),
            '块_位置': 计算(块2, 'position'),
          };
        }
        // 焦点态
        设焦点(viewA, true); await 歇(30);
        const 开_焦点 = 取值();
        const 关_焦点 = (function () { 产品表.sheet.disabled = true; const v = 取值(); 产品表.sheet.disabled = false; return v; })();
        // 失焦态
        设焦点(viewA, false); await 歇(30);
        const 开_失焦 = 取值();
        const 关_失焦 = (function () { 产品表.sheet.disabled = true; const v = 取值(); 产品表.sheet.disabled = false; return v; })();
        // 插入态（⭐ 上游的 `caret-color: transparent` 在此**不该**生效）
        复位(viewA); 设焦点(viewA, true); 发键(viewA, { key: 'i' }); await 歇(80);
        // ⚠️ 进插入模式要等 Vim 自己把状态翻过去，⛔ 不赌固定 sleep。
        await 等(function () { return vim状态(viewA).插入模式 === true; }, 1200);
        const 插入态 = {
          'cm_vimMode类': viewA.scrollDOM.classList.contains('cm-vimMode'),
          '插入模式': vim状态(viewA).插入模式,
          '行_插入符色': 色(计算(viewA.dom.querySelector('.cm-line'), 'caretColor')),
          '块_数': viewA.dom.querySelectorAll('.cm-fat-cursor').length,
        };
        设焦点(viewA, true); await 歇(30);
        return { '主题': 主题, '变量': 变量, '焦点': 开_焦点, '焦点_关掉我们的表': 关_焦点,
                 '失焦': 开_失焦, '失焦_关掉我们的表': 关_失焦, '插入态': 插入态,
                 '块回来了': 块回来了, '上游块色': 上游块色 };
      }

      for (const t of 主题们) 矩阵.push(await 一块(t));
      document.documentElement.setAttribute('data-theme', 'light');

      // ── 逐格判定：4 个面 × 3 套主题 ──
      //
      // ⚠️⚠️ **前提不成立时记「跳过」，⛔ 不是「通过」也不是「失败」**：
      //    块光标没画出来（E4 已单独判过一次）⇒ 这一格**测不了**。
      //    ⛔ 这条不是"为了凑绿"：E4 会把"布局正常却没块光标"判成**失败**，
      //    所以真缺陷仍然响亮；这里挡的只是"拿一个空对象去比色值"那种**假红**。
      const 全块在 = 块能测 && 矩阵.every(function (m) { return m.块回来了; });
      function 判(m, ok) { return (!块能测 || !m.块回来了) ? '跳过' : (ok ? '通过' : '失败'); }
      for (const m of 矩阵) {
        // ① Normal 块光标
        存('0e-' + m.主题 + '-块光标', m.主题 + '：Normal 块光标用主题变量',
          '`background-color` ≡ `--ui-caret` ∧ `--ui-caret` ≡ `--ui-text`（别名链解得开）'
          + ' ∧ ≠ `rgb(255,150,150)` ∧ 只有**一个**可见块光标',
          判(m, m.焦点.块_背景 === m.变量['--ui-caret']
               && m.变量['--ui-caret'] === m.变量['--ui-text']
               && m.焦点.块_背景 !== m.上游块色 && m.焦点.块_数 === 1),
          { '实测': m.焦点.块_背景, '变量_ui_caret': m.变量['--ui-caret'], '变量_ui_text': m.变量['--ui-text'],
            '上游写死': m.上游块色, '块数': m.焦点.块_数, '字色': m.焦点.块_字色,
            '字色_期望': m.变量['--ui-caret-text'], '关掉我们的表': m.焦点_关掉我们的表.块_背景 });
        // ② Insert 插入符
        存('0e-' + m.主题 + '-插入符', m.主题 + '：Insert 插入符用主题变量',
          '插入模式下 `.cm-line` 的 `caret-color` ≡ `--ui-text`（⛔ 不是透明、⛔ 不是默认黑）∧ `.cm-vimMode` 不在',
          判(m, m.插入态.行_插入符色 === m.变量['--ui-text'] && m.插入态.cm_vimMode类 === false),
          m.插入态);
        // ③ 焦点态
        存('0e-' + m.主题 + '-焦点', m.主题 + '：焦点态',
          '拿到焦点时 ① 的取值成立 ∧ `normal` 下**不得**同时看见"块光标 ＋ 原生闪烁插入符"（`.cm-line` 的 caret-color 必须透明）',
          判(m, m.焦点.块_背景 === m.变量['--ui-caret'] && 色(m.焦点.行_插入符色) === 'rgba(0,0,0,0)'),
          { '块_背景': m.焦点.块_背景, '变量_ui_caret': m.变量['--ui-caret'],
            '行_插入符色': m.焦点.行_插入符色, '上游条_关掉我们的表': m.焦点_关掉我们的表.行_插入符色,
            '自有光标层_display': m.焦点.自有光标层_display });
        // ④ 失焦态
        存('0e-' + m.主题 + '-失焦', m.主题 + '：失焦态不出现残留色块',
          '`background-color` 透明 ∧ `outline-color` ≡ `--ui-caret` ∧ 轮廓仍是 `solid`（⛔ 不是实心块）',
          判(m, 色(m.失焦.块_背景) === 'rgba(0,0,0,0)' && m.失焦.块_轮廓 === m.变量['--ui-caret'] && m.失焦.块_轮廓样式 === 'solid'),
          { '失焦': m.失焦, '变量_ui_caret': m.变量['--ui-caret'], '上游条_关掉我们的表': m.失焦_关掉我们的表,
            '⚠️': '上游失焦态另有规则（`&:not(.cm-focused) .cm-fat-cursor{background:none;outline:solid 1px #ff9696;color:transparent!important}`）'
              + ' —— ⛔ 我们只**改它的颜色**，没有把"失焦变空心"这件事一起覆盖掉' });
      }

      // ── 规则原文（⭐ 判据的另一半：证明选中的就是那条） ──
      //
      // ⚠️ 顺序**要一起记**：CM6 的样式是**运行时注入 `<head>`** 的（`StyleModule`），
      //    它排在**全部** `<link>`／`<style>` **之后** ⇒ "谁在文档后面"这件事本身**不可靠**，
      //    赢的方式必须是**特异性**。把 `表序` 打出来，读的人才能自己核对这一点
      //    （`design/0012` §10.13 那条纪律：**特权**赢，⛔ 不是顺序赢）。
      //    ⭐ 这一次顺序是**实测出来**的：`#editor-css`（产品表）在表清单里的序号**小于**
      //    上游那个运行时注入的 `<style>`，而我们的规则**照样赢**。
      const 命中 = [];
      const 表清单 = [];
      for (let i = 0; i < document.styleSheets.length; i++) {
        const sh = document.styleSheets[i];
        const 名 = (sh.ownerNode && sh.ownerNode.id) ? ('#' + sh.ownerNode.id)
                 : (sh.href ? String(sh.href).split('/').pop() : '(内联)');
        表清单.push({ '序': i, '名': 名 });
        let 规则;
        try { 规则 = sh.cssRules; } catch (e) { 表清单[表清单.length - 1].读不到 = String(e); continue; }
        for (const r of 规则) {
          const s = r.selectorText || '';
          if (!s) continue;
          if (/fat-cursor|cm-vimMode|cm-content|cm-line|cm-cursorLayer/.test(s) && /caret|background|outline/i.test(r.style && r.style.cssText ? r.style.cssText : '')) {
            命中.push({ '表': 名, '表序': i, '选择器': s, '原文': r.cssText.slice(0, 240) });
          }
        }
      }
      const 见上游粉 = 命中.some(function (x) { return /255,\s*150,\s*150/.test(x.原文); });
      const 见上游透 = 命中.some(function (x) { return /caret-color:\s*transparent/i.test(x.原文); });
      // ⭐ **我们那两条**（`design/0014` 裁定 (d) 落地后，它们在**产品**表里）。
      //    ⚠️ 判据**按属性名**压，⛔ 不是"随便命中了就算"（`kb/0014` 那条教训）：
      //    焦点那条要出现 `background-color` ＋ `--ui-caret`，
      //    失焦那条要出现 `outline-color` ＋ `--ui-caret`。
      //    ⚠️ 表名认的是 `<style id="editor-css">`（`.sh` 内联的产品 `editor.css`），
      //    ⛔ 不是任何探针自己写的副本 —— 那份副本 2026-10-16 已经删掉了。
      const 我们的块光标 = 命中.filter(function (x) { return x.表 === '#editor-css' && /cm-fat-cursor/.test(x.选择器); });
      const 见我们的 =
        我们的块光标.some(function (x) { return /--ui-caret/.test(x.原文) && /background-color/.test(x.原文); })
        && 我们的块光标.some(function (x) { return /--ui-caret/.test(x.原文) && /outline-color/.test(x.原文); });
      存('0e-规则原文', '⭐ 命中的规则原文（`document.styleSheets` 里读出来的，⛔ 不是推的）',
        '三样都要看得见：上游 `.cm-fat-cursor{background:#ff9696}`、'
        + '上游 `.cm-vimMode .cm-line{caret-color:transparent!important}`、'
        + '**产品表**（`#editor-css`）里我们那两条（焦点 `background-color` ＋ 失焦 `outline-color`，都取 `--ui-caret`）',
        (见上游粉 && 见上游透 && 见我们的) ? '通过' : '失败',
        { '见上游粉': 见上游粉, '见上游透': 见上游透, '见我们的': 见我们的,
          '我们的块光标条数': 我们的块光标.length,
          '表清单': 表清单, '命中条数': 命中.length, '规则': 命中,
          '⚠️': '我们的规则**不能靠文档顺序**赢 —— CM6 是运行时注入 `<head>` 的、它永远排在最后；'
            + '赢的方式必须写在**特异性**上（见 0e-反向对照那条实证）' });
      // ── 反向对照总表（⭐ "我们的规则真的赢了"的**证据**） ──
      const 对照 = 矩阵.map(function (m) {
        return { '主题': m.主题,
                 '块_我们的表开': m.焦点.块_背景, '块_我们的表关': m.焦点_关掉我们的表.块_背景,
                 '上游写死': m.上游块色,
                 '失焦_轮廓_我们的表开': m.失焦.块_轮廓, '失焦_轮廓_我们的表关': m.失焦_关掉我们的表.块_轮廓 };
      });
      const 对照成立 = 对照.every(function (x) { return x.块_我们的表开 !== x.块_我们的表关; });
      存('0e-反向对照', '⭐ 关掉**产品那张表** ⇒ 值**必须**回到上游写死的粉',
        '每套主题：`块_我们的表开 ≠ 块_我们的表关`，且关掉之后 === `rgb(255,150,150)`',
        !全块在 ? '跳过' : ((对照成立 && 对照.every(function (x) { return x.块_我们的表关 === 上游块色; })) ? '通过' : '失败'),
        { '对照': 对照, '⚠️': '这就是"我们的规则真的赢了"的判据 —— ⛔ 不是"特异性我算过，够高"；'
          + '⭐ 停用的是**产品表本身**（`src/styles/editor.css` 逐字节），所以这一格不可能被探针自己那份规则凑绿' });
      // ── 块光标不占布局（`position:absolute`） ──
      //
      // ⚠️⚠️ **前提要先建立**（第一版这格就是这么假红的，如实记着）：主题矩阵那个 `for` 循环的
      //    **最后一步是"插入模式"**（一轮流程：正常 → 焦点 → 失焦 → 插入）⇒ 循环结束时 viewA
      //    **停在插入模式**，而块光标（`.cm-fat-cursor`）**只在 normal 模式存在**
      //    ⇒ `querySelector` 得到 `null` ⇒ `块_position` 是 `null` ⇒ 判据必红。
      //    ⚠️ 那不是"块光标占了布局"，是**在量一个根本没有的东西**。
      //    ⇒ 先 `复位`（退出插入模式）＋ 等块光标**真的回来**再量；等不到就**如实记「跳过」**
      //      （⛔ 不是通过、也不是失败）——"拿空对象去比矩形"会造出一个假的失败。
      const 块回来了_布局 = await (async function () {
        复位(viewA); 设焦点(viewA, true);
        return await 等(function () { return viewA.dom.querySelectorAll('.cm-fat-cursor').length > 0; },
                       块能测 ? 2000 : 200);
      })();
      const 布局 = await (async function () {
        const 行0 = viewA.dom.querySelector('.cm-line');
        const 内容0 = viewA.dom.querySelector('.cm-content');
        const a = 行0 ? JSON.stringify(行0.getBoundingClientRect()) : null;
        const b = 内容0 ? JSON.stringify(内容0.getBoundingClientRect()) : null;
        const 块 = viewA.dom.querySelector('.cm-fat-cursor');
        const 档 = 块 ? 计算(块, 'position') : null;
        // 把块光标拿掉再量一次（`display:none` 不改布局 ⇒ 应当**完全一样**）
        let c = null, d = null;
        if (块) {
          块.style.display = 'none';
          c = 行0 ? JSON.stringify(行0.getBoundingClientRect()) : null;
          d = 内容0 ? JSON.stringify(内容0.getBoundingClientRect()) : null;
          块.style.display = '';
        }
        return { '块_position': 档, '行_有块': a, '行_无块': c, '内容_有块': b, '内容_无块': d,
                 '块回来了': 块回来了_布局 };
      })();
      存('0e-不占布局', '块光标是 `position:absolute` ⇒ 不改变正文的行盒',
        '`position === "absolute"` ∧ 有块/无块时 `.cm-line` 与 `.cm-content` 的矩形**逐值相同**',
        (!全块在 || !块回来了_布局) ? '跳过'
          : ((布局.块_position === 'absolute' && 布局.行_有块 === 布局.行_无块
              && 布局.内容_有块 === 布局.内容_无块) ? '通过' : '失败'),
        布局);
    }

    // ══════════════ 0f · 上游"没实现"的功能在静默失效吗 ══════════════
    {
      const 文本们 = 记.filter(function (x) { return x.值; }).map(function (x) { return JSON.stringify(x.值); }).join('\n');
      // ⚠️⚠️ **归一化必须先做**，这是第一版假红的根因（如实记着）：`JSON.stringify` 会把消息里的
      //    `"` 写成 `\"`，而第一版用 `[^"]*` 去捞 ⇒ **在反斜杠处截断**，捞到的是
      //    `Not an editor command \` —— 一个**谁也没写过的字符串**，于是它当然"不在已知集合里"。
      //    ⛔ 那不是放宽判据，是把**读法**修对（判据本身一个字没改：命中的命令仍须 ⊆ {q, wq}）。
      const 归一 = 文本们.replace(/\\"/g, '"');
      // ⭐ 上游文案真身（`src/vendor/cm6.bundle.js` 一手，`showConfirm` 那条）：
      //    `'Not an editor command ":' + input + '"'` ⇒ 实际是 `Not an editor command ":q"`。
      //    ⚠️ 同时保留旧形态（`Not an editor command: q`）的匹配，免得上游哪天改了写法就静默漏记。
      const 命令命中 = Array.from(new Set(
        (归一.match(/Not an editor command "?:\s*[A-Za-z][\w-]*/g) || [])
          .map(function (s) { return s.replace(/.*:\s*/, ''); })));
      // ⭐ `is not implemented` 那一族：上游**任何一个**都算意外（裁定 (b) 只放行 `:q`/`:wq`）
      const 未实现 = Array.from(new Set(归一.match(/[A-Za-z][\w -]*is not implemented[^"]*/gi) || []));
      // ⭐ 判据：命中的**命令** ⊆ {`q`, `wq`} ∧ 没有任何 `is not implemented` 字样。
      //    ⛔ 出现第三个"未实现"就是发现 ⇒ 逐条登记，不修上游、但不假装它有。
      const 意外 = 命令命中.filter(function (s) { return s !== 'q' && s !== 'wq'; }).concat(未实现);
      存('0f', '上游"未实现"项登记（`:q`/`:wq` 之外不许再有）',
        '命中的命令 ⊆ {`q`, `wq`} ∧ 一条 `is not implemented` 都没有（裁定 (b) 的已知集合）'
        + ' ∧ ⛔ 至少命中一个（否则说明「未实现」这句话根本没进 DOM ⇒ 本格在空转）',
        (意外.length === 0 && 命令命中.length > 0) ? '通过' : '失败',
        { '命中命令': 命令命中, '未实现字样': 未实现, '意外': 意外,
          '⚠️': '⛔ 不修上游；但发现新的静默失效项必须在交付前上报（本探针只负责不漏记）' });
    }

    // ══════════════ 0h · 可视模式（`v` / `V`）与**选区渲染** ══════════════
    //
    // ⚠️ 2026-10-21 用户报障：「vim 为什么没有实现 shift + V 单行选中」。
    //    这一格先只做**诊断**（读 `visualMode` / `visualLine` 与选中范围），
    //    判据是否收成闸门由结论定——⛔ 不先写一条"看起来对"的断言。
    if (typeof viewA !== 'undefined' && viewA) {
      function 读行选区(v) {
        const s = v.state.selection.main;
        return { from: s.from, to: s.to, 空: s.empty,
                 文本: v.state.sliceDoc(s.from, s.to).replace(/\n/g, '⏎').slice(0, 60),
                 anchor: s.anchor, head: s.head };
      }
      function 读可视态(v) {
        try {
          const vim = v.cm && v.cm.state && v.cm.state.vim;
          return { 在: !!vim, visualMode: !!(vim && vim.visualMode),
                   visualLine: !!(vim && vim.visualLine), insertMode: !!(vim && vim.insertMode) };
        } catch (e) { return { '读不到': String((e && e.message) || e) }; }
      }
      /** ⭐ DOM 那半：用户**看得见**的东西。状态对而这里空 ⇒ 症状正是"按了没反应"。 */
      function 读DOM选区(v) {
        let selText = null, ranges = 0, anchorNode = null;
        try {
          const s = window.getSelection();
          ranges = s ? s.rangeCount : 0;
          selText = s ? String(s.toString()).replace(/\n/g, '⏎').slice(0, 60) : null;
          anchorNode = s && s.anchorNode ? String(s.anchorNode.nodeName) : null;
        } catch (e) { selText = '读不到：' + String((e && e.message) || e); }
        const 层 = v.dom.querySelector('.cm-cursorLayer');
        // ⭐⭐ **画出来的**选区：`drawSelection` 会建 `.cm-selectionLayer` 并在里面放
        //     `.cm-selectionBackground`。⛔ 没有这两样 ⇒ 状态里选着、屏幕上一片空白。
        //     ⚠️ 上游 `hideNativeSelection`（`dist/index.js:1215`）把
        //     `.cm-vimMode .cm-line ::selection` 的底色**强制透明** ⇒ 少了这一层就**什么都没了**。
        const 选区层 = v.dom.querySelector('.cm-selectionLayer');
        return {
          getSelection: selText, rangeCount: ranges, anchorNode: anchorNode,
          cm_focused: v.dom.classList.contains('cm-focused'),
          fat光标数: v.dom.querySelectorAll('.cm-fat-cursor').length,
          vimMode类: !!(v.scrollDOM && v.scrollDOM.classList.contains('cm-vimMode')),
          cursorLayer类: 层 ? String(层.className) : null,
          selectionLayer: !!选区层,
          selectionBackground数: v.dom.querySelectorAll('.cm-selectionBackground').length,
        };
      }
      const 结果表 = {};
      // ⭐ 端到端那半：`V` 之后按 `d` 必须**删掉整行**（＝"可视行 + 行级操作符"真的串起来了）。
      {
        复位(viewA);
        设焦点(viewA, true);
        await 歇(20);
        const 行前 = 文本(viewA).split('\n');
        发一条(viewA, { key: 'V', shift: true, keyCode: 86 });
        发一条(viewA, { key: 'd', keyCode: 68 });
        const 行后 = 文本(viewA).split('\n');
        结果表['端到端：V 然后 d'] = {
          首行前: 行前[0], 首行后: 行后[0], 行数: { 前: 行前.length, 后: 行后.length },
          '预期': '首行「## 标题」被整行删掉',
        };
        复位(viewA);
      }
      const 情形们 = [
        { 名: 'Shift+V（key=V, shiftKey=true）', 参数: { key: 'V', shift: true, keyCode: 86 } },
        { 名: 'V（key=V, shiftKey=false，退化对照）', 参数: { key: 'V', shift: false, keyCode: 86 } },
        { 名: 'v（小写，可视字符态对照）', 参数: { key: 'v', shift: false, keyCode: 86 } },
        { 名: 'V（key=v, shiftKey=true，另一种真实形态）', 参数: { key: 'v', shift: true, keyCode: 86 } },
      ];
      for (const 情形 of 情形们) {
        复位(viewA);
        设焦点(viewA, true);
        await 歇(20);
        const 前 = 读可视态(viewA);
        const 按键 = 发一条(viewA, 情形.参数);
        const 后 = 读可视态(viewA);
        const 选 = 读行选区(viewA);
        结果表[情形.名] = { 前: 前, prevented: 按键.prevented, 应用到: 按键.应用到,
                         后: 后, 选中: 选, 文本变: 按键.文变了, DOM: 读DOM选区(viewA) };
        // ⚠️ 每次收尾都复位，免得上一种情形污染下一种（`V` 会留在可视态里）。
        复位(viewA);
      }
      // ⭐ 再测**动态开**那条路（`INV-VIM-08` 的 `Compartment.reconfigure`）：
      //    用户是**先进编辑态、再点顶栏开关**的——上面那几种情形（一开始就带 Vim）
      //    **证明不了**那条路。⚠️ `hostC` 已被 `viewC` 占着，这里另起一个容器。
      {
        const 宿主 = document.createElement('div');
        document.body.appendChild(宿主);
        const 格 = new CM6.Compartment();
        const 动态视图 = new CM6.EditorView({
          state: CM6.EditorState.create({
            doc: 文档,
            extensions: [
              CM6.EditorView.lineWrapping, CM6.lineNumbers(), CM6.history(),
              CM6.keymap.of(CM6.historyKeymap), CM6.markdown(),
              CM6.EditorView.updateListener.of(function () {}),
              格.of([]), forwardExt,
            ],
          }),
          parent: 宿主,
        });
        设焦点(动态视图, true);
        await 歇(20);
        const 开前 = 读可视态(动态视图);
        动态视图.dispatch({ effects: 格.reconfigure(CM6.vim({ status: true })) });
        await 歇(20);
        const 开后 = 读可视态(动态视图);
        发一条(动态视图, { key: 'V', shift: true, keyCode: 86 });
        await 歇(20);
        结果表['动态开（Compartment.reconfigure）后按 V'] = {
          开前: 开前, 开后: 开后, 按键后: 读可视态(动态视图),
          选中: 读行选区(动态视图), DOM: 读DOM选区(动态视图),
        };
        复位(动态视图);
        动态视图.destroy();
        宿主.remove();
      }
      // ⭐ 级联取证：把所有 `::selection` 规则摊开（谁在抢这个底色）。
      //    ⚠️ 这一招**可靠**——`getComputedStyle(el, '::selection')` 在 WebKit 上未必真读得到，
      //    所以两条都打，谁有效看数据。
      function 选区规则() {
        const out = [];
        for (const sheet of Array.prototype.slice.call(document.styleSheets)) {
          let rules = null;
          try { rules = sheet.cssRules; } catch (e) { continue; }
          if (!rules) continue;
          for (const r of Array.prototype.slice.call(rules)) {
            if (r.selectorText && r.selectorText.indexOf('::selection') >= 0) {
              out.push({ sel: r.selectorText,
                         bg: r.style.getPropertyValue('background-color'),
                         imp: r.style.getPropertyPriority('background-color'),
                         来源: sheet.href ? String(sheet.href).split('/').pop() : '运行时注入' });
            }
          }
        }
        return out;
      }
      function 选区底色(v) {
        try {
          const line = v.dom.querySelector('.cm-line');
          if (!line) return '没有 .cm-line';
          const sel = getComputedStyle(line, '::selection');
          return { '::selection': sel ? sel.backgroundColor : null,
                   元素本身: getComputedStyle(line).backgroundColor };
        } catch (e) { return '读不到：' + String((e && e.message) || e); }
      }
      结果表['级联取证'] = {
        'Vim 视图的 ::selection': 选区底色(viewA),
        '非 Vim 视图的 ::selection（对照）': 选区底色(viewB),
        '全部 ::selection 规则': 选区规则(),
      };
      // ⭐ 顺带验一件事：WKWebView 在 `::selection` 里**认不认 `var()`**。
      //    ⚠️ 修法要靠主题变量给底色（`INV-THEME-02` 禁字面色值）⇒ 这里不认，修法就得换。
      try {
        const 试验 = document.createElement('div');
        试验.textContent = '选区试验';
        const st = document.createElement('style');
        st.textContent = ':root #rmd-sel-test::selection { background-color: var(--reader-selection-bg) !important; }';
        document.head.appendChild(st);
        document.body.appendChild(试验);
        试验.id = 'rmd-sel-test';
        const rr = document.createRange();
        rr.selectNodeContents(试验);
        const ss = window.getSelection();
        ss.removeAllRanges(); ss.addRange(rr);
        const cs = getComputedStyle(试验, '::selection');
        结果表['var() 在 ::selection 里'] = {
          '解析出的底色': cs ? cs.backgroundColor : '读不到',
          '元素自身底色': getComputedStyle(试验).backgroundColor,
          '规则': st.textContent,
        };
        ss.removeAllRanges();
        试验.remove();
        st.remove();
      } catch (e) { 结果表['var() 在 ::selection 里'] = '试不出来：' + String((e && e.message) || e); }

      // ══════════ 0h 的四条判据（2026-10-21 由"只登记"收成闸门） ══════════
      //
      // ⚠️ 编号是 `0h` 而**不是** `0g`：`0014` §7.1 表里的 **`0g` 是「回归面」那一行**
      //    （`make test` / `fidelity` / `smoke`），两件事同名会读串。
      //
      // ⚠️ 背景：用户报障「vim 为什么没有实现 shift + V 单行选中」。
      //    查下来**功能是好的、只是看不见**——见 `docs/bugs/0008`。
      //    所以这里一半的判据盯的**不是**状态，而是"**画出来了没有**"。
      const 文档首行 = 文档.split('\n')[0];

      // ── 0h-1：`Shift+V` 真的进了「可视行」，选中的是**整行**，且没有改文档 ──
      const 行态 = 结果表['Shift+V（key=V, shiftKey=true）'] || null;
      const 行态OK = !!(行态 && 行态.后 && 行态.后.visualMode && 行态.后.visualLine
                        && !行态.后.insertMode && 行态.prevented && !行态.文本变
                        && 行态.选中 && !行态.选中.空 && 行态.选中.文本 === 文档首行);
      存('0h-1', '`Shift+V` → 可视行（`visualLine`）且选中整行',
        '`visualMode ∧ visualLine ∧ ¬insertMode` ∧ 事件被 `preventDefault` ∧ 文档**未变** ∧ '
        + '状态选区恰好是首行（`' + 文档首行 + '`）',
        行态OK ? '通过' : '失败',
        { '首行': 文档首行, '四种事件形态': 结果表,
          '⚠️': '四种写法（`key=V/shift`、`key=V`、`key=v`、`key=v/shift`）都登记了，'
            + '判据压在**键盘真的会发出的那一种**上；另外三种只作对照（上游 `vimKeyFromEvent` 只看修饰前缀与长度）' });

      // ── 0h-2：`V` 之后 `d` ⇒ 整行被删（可视行 ＋ 行级操作符串起来了） ──
      const 端到端 = 结果表['端到端：V 然后 d'] || null;
      const 端到端OK = !!(端到端 && 端到端.行数.后 === 端到端.行数.前 - 1 && 端到端.首行后 === '');
      存('0h-2', '`V` 然后 `d` → 整行被删（端到端）',
        '行数恰好 −1 ∧ 首行变空 ∧ 首行原本是 `' + 文档首行 + '`',
        端到端OK ? '通过' : '失败', { 端到端: 端到端 });

      // ── 0h-3：⭐ **选中的东西看得见**（这条才是用户报障的那个面） ──
      //
      // ⚠️ `getComputedStyle(el, '::selection')` 在 WKWebView 上是**能读的**（0h-4 的反证也靠它）：
      //    它读到的是**级联结果**，⛔ 不是"浏览器画了没有"。所以判据分两半：
      //    ① 级联上不是透明（上游那条 `transparent !important` 被我们的规则赢了）；
      //    ② 产品表里**确实有**那条规则、且用的是语义变量（⛔ 不是碰巧继承了别处的颜色）。
      let 选区看得见 = null, 解析底色 = null, 产品选区规则 = [];
      {
        复位(viewA);
        设焦点(viewA, true);
        await 歇(20);
        // ⚠️ 派的是**同一种真实形态**（`V`），这一格只看"画"，所以不重复判状态。
        发一条(viewA, { key: 'V', shift: true, keyCode: 86 });
        await 歇(20);
        const 行 = viewA.dom.querySelector('.cm-line');
        try { 选区看得见 = 行 ? getComputedStyle(行, '::selection').backgroundColor : '没有 .cm-line'; }
        catch (e) { 选区看得见 = '读不到：' + String((e && e.message) || e); }
        // ⭐ `--reader-selection-bg` 的**解析值**：`getPropertyValue` 拿到的是 `var(--p-blue-100)`
        //    那种**未解析**形态，⛔ 不能直接比 ⇒ 拿一个临时元素让浏览器算一遍。
        try {
          const 探 = document.createElement('div');
          探.style.backgroundColor = 'var(--reader-selection-bg)';
          document.body.appendChild(探);
          解析底色 = getComputedStyle(探).backgroundColor;
          探.remove();
        } catch (e) { 解析底色 = '读不到：' + String((e && e.message) || e); }
        try {
          const 规则 = 产品表.sheet.cssRules;
          for (let i = 0; i < 规则.length; i++) {
            const s = 规则[i].selectorText || '';
            if (s.indexOf('::selection') >= 0) 产品选区规则.push(规则[i].cssText.slice(0, 240));
          }
        } catch (e) { 产品选区规则.push('读不到：' + String((e && e.message) || e)); }
        复位(viewA);
      }
      const 透明样式 = /rgba\(0,\s*0,\s*0,\s*0\)|transparent/i;
      const 看得见OK = !!(typeof 选区看得见 === 'string' && !透明样式.test(选区看得见)
                          && 选区看得见 === 解析底色
                          && 产品选区规则.length > 0
                          && 产品选区规则.every(function (t) { return t.indexOf('--reader-selection-bg') >= 0; }));
      存('0h-3', '⭐ 可视模式的选区**看得见**（`::selection` 底色不是透明的）',
        '`getComputedStyle(首行, ::selection).backgroundColor` ≠ 透明 ∧ 等于 `--reader-selection-bg` 的解析值 ∧ '
        + '产品 `editor.css` 里那条规则引用的是**语义变量**（`INV-THEME-02`）',
        看得见OK ? '通过' : '失败',
        { '读到的 ::selection 底色': 选区看得见, '--reader-selection-bg 解析值': 解析底色,
          '产品表里的 ::selection 规则': 产品选区规则,
          '⚠️': '这一条只证**级联**（谁赢），⛔ 证不了浏览器**真的刷了那一块像素**——'
            + '后一半在 WKWebView 里没有可读的接口，已如实登记为「目视」项（`docs/bugs/0008` §6）' });

      // ── 0h-4：反向对照 —— 关掉**产品那张表**，同一格必须掉回透明 ──
      //
      // ⭐ 与 0e-反向对照 同一个手法：证明"现在看得见"**是因为我们那条规则**，
      //    ⛔ 不是因为别的什么（比如浏览器默认就把 ::selection 画成某个色）。
      let 关掉后 = null;
      try {
        产品表.disabled = true;
        const 行2 = viewA.dom.querySelector('.cm-line');
        关掉后 = 行2 ? getComputedStyle(行2, '::selection').backgroundColor : '没有 .cm-line';
      } catch (e) {
        关掉后 = '读不到：' + String((e && e.message) || e);
      } finally {
        产品表.disabled = false;     // ⚠️ 必须还原：后面的格子还要用这张表
      }
      存('0h-4', '反向对照：关掉产品表 ⇒ 选区底色掉回透明',
        '同一格在 `#editor-css` 停用后必须读到透明（证明 0h-3 里那个颜色**来自我们那条规则**）',
        (typeof 关掉后 === 'string' && 透明样式.test(关掉后)) ? '通过' : '失败',
        { '关掉产品表后': 关掉后, '开着时（0h-3）': 选区看得见,
          '⚠️': '停用后立刻还原；本格只读样式，⛔ 不改文档状态' });

      // ══════════ 0j-1：⭐ 插入模式下上游**根本不藏**原生选区（2026-10-21 复审新增） ══════════
      //
      // ⚠️ 这一条纠正的是**文档里的一句错话**，⛔ 不是新功能：
      //    `docs/bugs/0008` 复审前写着「插入态的鼠标拖选也看不见」。
      //    上游 `vimPlugin.updateClass()`（`dist/index.js:1407-1412`）在
      //    `state.vim.insertMode && !overwrite` 时把 `cm-vimMode` 从 scroller 上**摘掉**
      //    ⇒ `hideNativeSelection` 那两条透明规则**不匹配** ⇒ 插入态从来没被藏过。
      //
      // ⚠️ 口径：**判「有没有藏选区的规则真的命中这一行」**，⛔ 不拿 `::selection` 的
      //    计算值判——实测**一条规则都没命中时它也读作透明**（UA 那一层不暴露），
      //    那个读数没有判别力（这里只作登记）。
      {
        复位(viewA);
        设焦点(viewA, true);
        发一条(viewA, { key: 'i', keyCode: 73 });
        await 歇(30);
        const 态 = vim状态(viewA);
        const 滚动 = viewA.dom.querySelector('.cm-scroller');
        const 有类 = !!(滚动 && 滚动.classList.contains('cm-vimMode'));
        const 行 = viewA.dom.querySelector('.cm-line');
        const 藏选区的命中 = [];
        const 全部选区规则 = [];
        try {
          for (let s = 0; s < document.styleSheets.length; s++) {
            let 规则组;
            try { 规则组 = document.styleSheets[s].cssRules; } catch (e) { continue; }
            for (let k = 0; k < 规则组.length; k++) {
              const 组 = 规则组[k];
              // ⚠️ 不下钻分组规则（`@media` 之类）——本页面实测没有，⛔ 不假装处理了
              const 选 = 组.selectorText || '';
              if (选.indexOf('::selection') < 0) continue;
              const 底 = 组.style ? (组.style.getPropertyValue('background-color') || '') : '';
              const 藏 = /transparent|rgba\(0,\s*0,\s*0,\s*0\)/i.test(底);
              全部选区规则.push({ 选择器: 选.slice(0, 140), 底色: 底, 藏: 藏 });
              if (!藏 || !行) continue;
              const 元素部分 = 选.split('::selection')[0].trim();
              let 命中 = false;
              try { 命中 = 元素部分 ? 行.matches(元素部分) : false; } catch (e) { 命中 = false; }
              if (命中) 藏选区的命中.push(选.slice(0, 140));
            }
          }
        } catch (e) { /* 读不到就让它自己红 */ }
        let 插入态选区色 = null;
        try { 插入态选区色 = 行 ? getComputedStyle(行, '::selection').backgroundColor : '没有 .cm-line'; }
        catch (e) { 插入态选区色 = '读不到：' + String((e && e.message) || e); }
        存('0j-1', '插入模式下 `cm-vimMode` 被摘掉 ⇒ 没有任何规则在藏原生选区',
          '`插入模式` ∧ scroller **没有** `cm-vimMode` ∧ **没有一条**「把选区设成透明」的规则命中该行 '
          + '（⇒ `docs/bugs/0008` 原写"插入态拖选也看不见"**是错的**，已原地更正）',
          (!!(态 && 态['插入模式']) && !有类 && 藏选区的命中.length === 0) ? '通过' : '失败',
          { '插入模式': !!(态 && 态['插入模式']), 'scroller 有 cm-vimMode': 有类,
            '藏选区的规则命中': 藏选区的命中, '全部 ::selection 规则': 全部选区规则,
            '::selection 计算值（⚠️ 无判别力，只作登记）': 插入态选区色 });
        复位(viewA);
      }

      // ══════════ 0i：`:` / `/` 的命令行输入框（2026-10-21 复审新增） ══════════
      //
      // ⚠️ 背景（`docs/bugs/0009`）：上游 `vimStyle` **不给** `.cm-vim-panel input`
      //    任何 `color` / `font` ⇒ 那几个值全是 UA 的——`fieldtext` 跟 **`color-scheme`**
      //    走，⛔ 不跟我们的 `data-theme`。主题与系统外观相反时，敲进去的字**看不见**。
      // ⭐ 判据一律拿**语义变量的解析值**比（与 0h-3 同一手法），⛔ 不比字面量。
      {
        const 规范 = function (s) { return String(s).replace(/\s+/g, ''); };
        const 解析色 = function (变量) {
          const 探 = document.createElement('div');
          探.style.color = 'var(' + 变量 + ')';
          document.body.appendChild(探);
          const 值 = getComputedStyle(探).color;
          探.remove();
          return 值;
        };
        const 原主题 = document.documentElement.getAttribute('data-theme');
        // ⚠️ 取 `dark`：离屏窗口的 `color-scheme` 是默认的**浅色** ⇒ 这一格正是
        //    "深色主题 + 浅色系统"那个会瞎的组合（⛔ 不是挑一个舒服的组合来验）。
        document.documentElement.setAttribute('data-theme', 'dark');
        let 读数 = {}, 关掉后 = null, 还原后 = null;
        try {
          复位(viewA);
          设焦点(viewA, true);
          await 歇(20);
          发一条(viewA, { key: ':', keyCode: 186 });
          await 歇(60);
          const 条 = viewA.dom.querySelector('.cm-vim-panel');
          const 入 = 条 ? 条.querySelector('input') : null;
          const 滚动 = viewA.dom.querySelector('.cm-scroller');
          const 入样式 = 入 ? getComputedStyle(入) : null;
          const 条样式 = 条 ? getComputedStyle(条) : null;
          const 滚样式 = 滚动 ? getComputedStyle(滚动) : null;
          读数 = {
            '输入框 color': 入样式 ? 入样式.color : '没有输入框',
            '输入框 caret-color': 入样式 ? 入样式.caretColor : '没有输入框',
            '输入框 font-family': 入样式 ? 入样式.fontFamily : '没有输入框',
            '输入框 font-size': 入样式 ? 入样式.fontSize : '没有输入框',
            '面板 color': 条样式 ? 条样式.color : '没有面板',
            '面板 font-family': 条样式 ? 条样式.fontFamily : '没有面板',
            '面板 font-size': 条样式 ? 条样式.fontSize : '没有面板',
            '源码栏 font-family': 滚样式 ? 滚样式.fontFamily : '没有源码栏',
            '源码栏 font-size': 滚样式 ? 滚样式.fontSize : '没有源码栏',
            '--ui-text 解析值': 解析色('--ui-text'),
          };
          // ⭐ 反向对照：停掉产品表，同一格必须掉回 UA 的值（证明上面那个色**来自我们那条规则**）
          try {
            产品表.disabled = true;
            关掉后 = 入 ? getComputedStyle(入).color : '没有输入框';
          } finally {
            产品表.disabled = false;
            还原后 = 入 ? getComputedStyle(入).color : '没有输入框';
          }
        } finally {
          // ⚠️ 关面板必须把 `Escape` 打到**输入框**上（`:` 对话框只认它自己的 keydown）；
          //    发到 `contentDOM` 的话对话框开着不走，后面的 0j 会被它挡掉（2026-10-21 实测踩过）。
          try {
            const 还开着 = viewA.dom.querySelector('.cm-vim-panel input');
            if (还开着) 发键到(还开着, { key: 'Escape', keyCode: 27 });
          } catch (e) { /* 关不掉就让后面的格自己红 */ }
          复位(viewA);
          if (原主题) document.documentElement.setAttribute('data-theme', 原主题);
          else document.documentElement.removeAttribute('data-theme');
        }
        const 该色 = 规范(读数['--ui-text 解析值']);
        存('0i-1', '命令行输入框的字色跟**主题**（⛔ 不是 UA 的 color-scheme）',
          '深色主题 + 浅色系统：`color` === `--ui-text` 的解析值 ∧ ≠ `rgb(0, 0, 0)`',
          (规范(读数['输入框 color']) === 该色 && 规范(读数['输入框 color']) !== 'rgb(0,0,0)') ? '通过' : '失败',
          { 读数: 读数,
            '⚠️': '上游 `dist/index.js:1304-1319` 的 `.cm-vim-panel input` 只给 border/outline/'
              + 'backgroundColor，⛔ 没有 color ⇒ UA 的 `fieldtext` 跟 `color-scheme` 走。'
              + '⚠️ 本页**不加载 `style.css`** ⇒ 「面板 color」这一格读到的是 UA 的黑，'
              + '⛔ 别把它读成缺陷：真应用里 `body { color: var(--ui-text) }`，面板（div）继承得到；'
              + '**`<input>` 不继承**，那才是 `docs/bugs/0009` 指的东西' });
        存('0i-2', '命令行输入框的**插入符**也跟着主题',
          '`caret-color` === `--ui-text` 的解析值（否则深色主题下敲字看不见光标在哪）',
          (规范(读数['输入框 caret-color']) === 该色) ? '通过' : '失败',
          { '输入框 caret-color': 读数['输入框 caret-color'], '--ui-text 解析值': 读数['--ui-text 解析值'],
            '⚠️': '`caret-color` 在 `<input>` 上**不继承**，必须显式给' });
        存('0i-3', '命令行输入框的字体/字号与**源码栏**一致（⛔ 不是 UA 的 11px 系统字体）',
          '`font-family` 与 `font-size` 逐字等于 `.cm-scroller` 的（同一个 `--reader-*` 派生）',
          (规范(读数['输入框 font-family']) === 规范(读数['源码栏 font-family'])
           && 规范(读数['输入框 font-size']) === 规范(读数['源码栏 font-size'])) ? '通过' : '失败',
          { 读数: 读数,
            '⚠️': 'UA 表单控件的默认是 11px + `-webkit-small-control` 那一套系统字体；'
              + '上游只给面板 `fontFamily: monospace`、⛔ 面板与 input 的 `font-size` 都不给' });
        存('0i-4', '反向对照：关掉产品表 ⇒ 输入框字色掉回 UA 的值',
          '`#editor-css` 停用后 `color` ≠ `--ui-text` 的解析值，且**还原后等于**（证明 0i-1 的颜色来自本表）',
          (typeof 关掉后 === 'string' && 规范(关掉后) !== 该色 && 规范(还原后) === 该色) ? '通过' : '失败',
          { '关掉产品表后': 关掉后, '还原后': 还原后, '--ui-text 解析值': 读数['--ui-text 解析值'],
            '⚠️': '停用后立刻还原；本格只读样式，⛔ 不改文档状态' });
      }

    }

    // ══════════════ 汇总 ══════════════
    const 失败 = 记.filter(function (x) { return x.结果 === '失败'; }).length;
    const 跳过 = 记.filter(function (x) { return x.结果 === '跳过'; }).length;
    // ⚠️ 收工前把窗口状态还给"没动过"的样子（探针自己的页面，⛔ 不碰用户的东西）
    try { viewA.destroy(); viewB.destroy(); viewC.destroy(); viewP.destroy(); } catch (e) { /* 记在下面 */ }
    return {
      '环境': {
        '文档可见性': document.visibilityState,
        '文档有焦点': document.hasFocus(),
        UA: navigator.userAgent,
        rAF: e2,
        activeElement: document.activeElement ? String(document.activeElement.className || document.activeElement.tagName) : null,
        '块光标出现过': 有块光标,
        'E3_编辑区是activeElement': e3ok,
      },
      '夹具': {
        '文档行数': 文档.split('\n').length,
        '表长': TABLE.length,
        '白名单条数': 派生.specs.length,
        '块光标可测': 块能测,
        '⚠️': '文档与表都是**探针自己**的；表是 .sh 从 gui/mod.rs 现读的，⛔ 不是第二份手抄',
      },
      '检查': 记,
      '结论': { '通过': 记.length - 失败 - 跳过, '失败': 失败, '跳过': 跳过,
              '总判定': 失败 > 0 ? '失败' : (跳过 > 0 ? '未判定' : '通过') },
    };
  };
})();
