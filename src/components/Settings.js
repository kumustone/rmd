// 设置覆盖层 —— `design/0010-设置界面与快捷键.md` §2.1 ④④.1⑤（2026-10-14 已通过）。
//
// # 它是什么，以及为什么不是一个窗口
//
// ⭐ **同一份文档里的一个覆盖层**，⛔ 不开第二个 Tauri 窗口。
// 理由不是"好看"，是 `INV-THEME-05` 的**单写者**：
// `theme.js` 那条写盘队列天然只有一条，覆盖层与顶栏**共用同一个服务实例**
// ⇒ "两个表面同时改外观"这件事在结构上就不存在。
// ⚠️ 独立窗口**并非**架构上必然错（`design/0010` §2.1 ④ 已就地收敛过这句），
// 它只是要多付"跨窗口消息通道 + 谁来持有 `Appearance` 的 UI 状态"。
//
// # 三条硬约束
//
// 1. ⭐ **每一个值都从 `theme.applied` 现读**（`INV-SET-03`），⛔ 本文件不攒副本。
//    违反的表现是"覆盖层显示的是我改之前的值"——第二份快照的典型症状。
// 2. ⭐ **写只经 `theme.setX`**（`INV-SET-06`）。⛔ 这里不碰 DOM 主题、⛔ 不写 CSS 变量、
//    ⛔ 不自己调 `tauri.invoke`。
// 3. ⭐ **同一时刻至多一个覆盖层，焦点只有一个主人**（`INV-SET-07`）。
//    `design/0009` 的搜索浮层要**注册进同一个登记处**（`registerOverlay`），
//    ⛔ 不靠"各自都做了焦点陷阱"。
//
// # 中英双语（`design/0025` §2.5.1 层①–③，2026-10-21）
//
// 本文件的界面是 **JS 建的**，所以三层都要各自落实：
// ① **静态节点**（标题、分组名、行标签、说明段、预设选项）建的那一刻就带上
//    `data-i18n*`，工厂文案取 `t()`——`i18n.applyDom()` 换语言时重贴它们；
// ② **只能现算的文案**（「自定义 1200」、快捷键名）一律在 `relabel()` 里现取
//    `theme.applied` / `i18n.lang()`，⛔ **不许缓存字符串**；
// ③ `relabel()` 挂在 `i18n.subscribe()` 上，而且 ⚠️ **不判 `opened`**——
//    关着也要重贴，否则「切语言 → 再打开设置」看到的是上一次的旧字
//    （`design/0025` §2.5.1 末，逐字）。
//
// ⚠️ 语言这一格**⛔ 不走 `theme.js` 的写盘队列**（`design/0025` §2.6）：
//    改语言要连带改**菜单**，只有后端命令能做 ⇒ 它是一条**注入进来的依赖**
//    （`opts.language = { get, set }`），没有注入时**整行不渲染**（node 里也能 `require` 本文件）。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**（经典脚本共享全局词法作用域，
// 顶层 `const` 撞名会让整个文件不执行 —— 见 `FileTree.js` 的详细说明）。
(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────
  // i18n（`design/0025`）
  // ────────────────────────────────────────────────────────────────

  /**
   * ⚠️ **惰性取**（⛔ 不在加载期存成常量）：本文件在 `index.html` 里排在 `services/i18n.js`
   * 之后，但**加载期取值**正是 `design/0009` §10.3 那一族坑的形态；
   * 惰性取一次也不多花什么，却让"顺序被人挪了"的后果变成"文案是 key"这种**看得见**的样子。
   */
  function i18nApi() {
    return (typeof window !== 'undefined' && window && window.rmd && window.rmd.i18n) || null;
  }

  /** 取一句话。⚠️ 没有 i18n 时回落 **key 本身**（可见、不静默）。 */
  function T(key, vars) {
    const api = i18nApi();
    return api ? api.t(key, vars) : key;
  }

  /** 当前语言（`'zh'` / `'en'`）。⚠️ 唯一裁定点在 Rust，这里只读它同步下来的那份。 */
  function currentLang() {
    const api = i18nApi();
    return api ? api.lang() : 'zh';
  }

  /**
   * 给节点贴上字典键：**工厂文案 + 运行时重贴属性**（§2.5.1 层①）。
   * @param {Element} node
   * @param {string} key 字典键
   * @param {string} [kind] `data-i18n`（默认，写 `textContent`）/ `data-i18n-title` /
   *                        `data-i18n-placeholder` / `data-i18n-aria-label`
   */
  function tag(node, key, kind) {
    const attr = kind || 'data-i18n';
    node.setAttribute(attr, key);
    const text = T(key);
    if (attr === 'data-i18n') node.textContent = text;
    else if (attr === 'data-i18n-title') node.title = text;
    else if (attr === 'data-i18n-placeholder') node.placeholder = text;
    else if (attr === 'data-i18n-aria-label') node.setAttribute('aria-label', text);
    return node;
  }

  // ────────────────────────────────────────────────────────────────
  // 覆盖层登记处（`INV-SET-07`）
  // ────────────────────────────────────────────────────────────────

  /** ⭐ name → `{ close }`。**进程内唯一**一份，两个覆盖层共用。 */
  const overlays = Object.create(null);

  /** 谁是当刻的焦点主人（最后打开的那个）。 */
  let focusOwner = null;

  /**
   * 注册一个覆盖层。
   * @param {string} name 唯一名字（`settings` / `quick-open` …）
   * @param {{close: Function}} handle
   * @returns {Function} 注销
   */
  function registerOverlay(name, handle) {
    overlays[name] = handle;
    return function () {
      if (overlays[name] === handle) delete overlays[name];
      if (focusOwner === name) focusOwner = null;
    };
  }

  /** ⭐ **开一个就关另一个**（`INV-SET-07`）。⛔ 不叠成两层。 */
  function closeOtherOverlays(name) {
    Object.keys(overlays).forEach(function (k) {
      if (k === name) return;
      try { overlays[k].close(); } catch (e) { console.error('关覆盖层 ' + k + ' 出错：', e); }
    });
    focusOwner = name;
  }

  /** 谁持有焦点。⚠️ 给 `0009` 与调试用。 */
  function currentFocusOwner() { return focusOwner; }

  /** 交出焦点主人——**只有当前主人自己**关掉时才该调（⛔ 不是"别人也可以抢"）。 */
  function releaseFocusOwner(name) {
    if (focusOwner === name) focusOwner = null;
  }

  // ────────────────────────────────────────────────────────────────
  // 焦点（可 Tab 的元素）
  // ────────────────────────────────────────────────────────────────

  const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]),' +
    ' input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusables(root) {
    const list = root.querySelectorAll(FOCUSABLE);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      // ⚠️ `offsetParent === null` 是"被隐藏"的廉价判据（`display:none` 的子树）。
      //    `hidden` 属性单独查一次——两者不一定同时成立。
      if (!list[i].hidden && list[i].offsetParent !== null) out.push(list[i]);
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────────
  // 组件
  // ────────────────────────────────────────────────────────────────

  /**
   * 复用顶栏那几档预设。⚠️ 与 `ThemeSwitcher.js` 是**同一些值**（`0005` §2.1.6）。
   *
   * ⚠️ **2026-10-21（`design/0025`）由 `label` 改成 `key`**：
   * 字符串在**建节点那一刻**就固化了，换语言后不会变（`INV-I18N-01` 的形态）。
   * 现在 `key` 既是工厂文案的来源，也是 `data-i18n` 的值，两条路同一份真值。
   * ⚠️ 导出名不变（`CW_PRESETS` / `LH_PRESETS` / `THEME_LABELS`）——
   * 已核实 `src/` 之外没有消费者（只有 `ThemeSwitcher.js` 那份**同源副本**）。
   */
  const CW_PRESETS = [
    { v: 0, key: 'typo.width.full' },
    { v: 1200, key: 'typo.width.wide' },
    { v: 900, key: 'typo.width.medium' },
    { v: 720, key: 'typo.width.narrow' }
  ];
  const LH_PRESETS = [
    { v: 1.4, key: 'typo.line-height.tight' },
    { v: 1.6, key: 'typo.line-height.normal' },
    { v: 1.8, key: 'typo.line-height.loose' }
  ];
  const THEME_LABELS = {
    system: 'theme.system',
    light: 'theme.light',
    dark: 'theme.dark',
    warm: 'theme.warm'
  };

  /**
   * 建一个元素。`key` 给了就同时写工厂文案与 `data-i18n`（§2.5.1 层①）。
   * ⚠️ 纯装饰性的文字（`−` / `+` / ` px`）**不传 key**——它们没有语言之分，
   *    硬塞进字典只会让那两本字典多出两个永远不该被翻译的键。
   */
  function el(tagName, cls, key) {
    const n = document.createElement(tagName);
    if (cls) n.className = cls;
    if (key != null) tag(n, key);
    return n;
  }

  /** 建一个 `<option>`：值 + 字典键。 */
  function option(value, key) {
    const o = el('option', null, key);
    o.value = String(value);
    return o;
  }

  /**
   * 建设置覆盖层。⚠️ 调用方只需 `open()`；DOM 由本文件建（⛔ 不在 `index.html` 里写死——
   * 那样就有两份需要同步的东西）。
   *
   * @param {object} opts
   * @param {object} opts.theme `services/theme.js` 的服务（**同一个实例**，见模块头）
   * @param {Array} opts.shortcuts 后端 `get_shortcuts` 的**真表**
   * @param {{get: Function, set: Function}} [opts.language]
   *        ⭐ `design/0025` §2.6：语言的读写口。**没有它就不渲染那一行**——
   *        ⛔ 本文件不认识 `tauri.invoke`，也不碰 `theme.js` 的写盘队列（语言要改菜单，
   *        只有后端命令能落地）。
   */
  function createSettings(opts) {
    const theme = opts.theme;
    const shortcuts = opts.shortcuts || [];
    const language = opts.language || null;
    // ⚠️ 订阅要在**建 UI 之前**拿到 API（本文件排在 `i18n.js` 之后，这里一定取得到）；
    //    取不到就退化成"不订阅"，⛔ 不是抛。
    const I18N = i18nApi();

    // ⚠️ 打开前的焦点，关闭时要还回去（`INV-SET-07`）
    let restoreTo = null;
    let opened = false;

    const root = el('div', 'settings-layer');
    root.hidden = true;
    const scrim = el('div', 'settings-scrim');
    const panel = el('div', 'settings-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'settings-title');
    // ⚠️ 面板自己可聚焦：万一里面一个可 Tab 的元素都没有（不该发生，
    //    但"不该发生"不等于"不会"），焦点至少有个落点，⛔ 不会掉到 `body` 上。
    panel.tabIndex = -1;

    const head = el('div', 'settings-head');
    const title = el('h2', 'settings-title', 'settings.title');
    title.id = 'settings-title';
    const closeBtn = el('button', 'settings-close', 'settings.close');
    closeBtn.type = 'button';
    head.appendChild(title);
    head.appendChild(closeBtn);

    // ── 外观（四个控件；⚠️ 与顶栏是**同一批**值，`0004`/`0005` 一个都没改）──
    const secLook = el('section', 'settings-section');
    secLook.appendChild(el('h3', 'settings-h3', 'settings.group.appearance'));

    const themeSel = el('select', 'settings-control');
    Object.keys(THEME_LABELS).forEach(function (m) {
      themeSel.appendChild(option(m, THEME_LABELS[m]));
    });
    secLook.appendChild(row('settings.theme', themeSel));

    const fsDec = el('button', 'settings-btn');
    fsDec.textContent = '−';
    fsDec.type = 'button';
    // ⚠️⚠️ **第三个参数是字典键，⛔ 不传 `''`**（2026-10-21，`design/0025` §7.2 的探针抓到）：
    //    `el(…, '')` 会让 `tag()` 给这个 span 贴上 `data-i18n=""`，
    //    于是 ① 工厂文案被写成 `(i18n: empty key)`；② **每次换语言** `applyDom()`
    //    还会再贴一次，而 `render()` 只在 `open()` 时跑 ⇒ 开着设置改语言，
    //    字号那个数字就变成那串 ASCII 标记。这一格的值由 `render()` 现算。
    const fsVal = el('span', 'settings-value');
    const fsInc = el('button', 'settings-btn');
    fsInc.textContent = '+';
    fsInc.type = 'button';
    const fsBox = el('div', 'settings-inline');
    fsBox.appendChild(fsDec);
    fsBox.appendChild(fsVal);
    fsBox.appendChild(fsInc);
    secLook.appendChild(row('settings.font-size', fsBox));

    const lhSel = el('select', 'settings-control');
    LH_PRESETS.forEach(function (p) { lhSel.appendChild(option(p.v, p.key)); });
    secLook.appendChild(row('settings.line-height', lhSel));

    const cwSel = el('select', 'settings-control');
    CW_PRESETS.forEach(function (p) { cwSel.appendChild(option(p.v, p.key)); });
    secLook.appendChild(row('settings.content-width', cwSel));

    // ⭐ `design/0025` §2.6：**语言**（外观组末尾）。
    // ⚠️ 三项的**值**是配置里的偏好串（`system` / `zh` / `en`），⛔ 不是 `'zh-CN'`
    //    那种生效标签——"跟随系统"是一种**偏好**，生效值是后端算出来的另一件事。
    // ⚠️ 它**不走** `theme.setX`：换语言要连带重贴菜单（Rust 侧），
    //    而 `theme.js` 那条队列只管 `Appearance` 那五个键。
    let langSel = null;
    if (language && typeof language.get === 'function' && typeof language.set === 'function') {
      langSel = el('select', 'settings-control');
      langSel.appendChild(option('system', 'settings.lang.system'));
      langSel.appendChild(option('zh', 'settings.lang.zh'));
      langSel.appendChild(option('en', 'settings.lang.en'));
      secLook.appendChild(row('settings.language', langSel));
    }

    // ── 编辑（⭐ `design/0014` 裁定 (a)：Vim 开关 —— **本设计的唯一新设置项**）──
    //
    // ⚠️⚠️ **这是 `design/0010` 那句「V1 不新增设置项」的第一次范围扩展**
    //    （用户 2026-10-16 拍板：那句话是**当次范围**，⛔ 不是永久禁止；
    //    留痕在 `design/0010` 与 `design/0014` §3.6，⛔ 冻结正文一字不改）。
    //
    // ⚠️ 它为什么**必须**在这里而不是只在编辑面里：这个开关**没进编辑态时也要能勾**
    //    （用户是先想好了再进去）。状态住在 `theme.applied.vimMode`（`theme.js` 的
    //    `setVimMode` 是**全应用唯一**的写入口），编辑面只是它的一个订阅者。
    const secEdit = el('section', 'settings-section');
    secEdit.appendChild(el('h3', 'settings-h3', 'settings.group.editing'));
    // ⚠️ 控件外面套一层 `<label>`：点文字也能勾上（⛔ 只给一个孤零零的方框，
    //    用户得精确地打在 13px 的格子里）。
    const vimBox = el('label', 'settings-inline settings-check');
    const vimChk = el('input', 'settings-checkbox');
    vimChk.type = 'checkbox';
    vimBox.appendChild(vimChk);
    vimBox.appendChild(el('span', 'settings-check-label', 'settings.vim-toggle'));
    secEdit.appendChild(row('settings.vim', vimBox));
    secEdit.appendChild(el('p', 'settings-note', 'settings.vim-note'));

    // ── 快捷键（**只读**；⛔ V1 不做自定义，见设计 §4）──
    const secKeys = el('section', 'settings-section');
    secKeys.appendChild(el('h3', 'settings-h3', 'settings.group.shortcuts'));
    secKeys.appendChild(el('p', 'settings-note', 'settings.shortcuts-note'));
    const keyList = el('dl', 'settings-keys');
    // ⚠️ 每行的 `<dt>` 文字**来自后端那张表**（`get_shortcuts`），⛔ 不是字典键：
    //    它是**数据**，不是界面文案。⭐ `design/0025` §2.3 起后端同时送
    //    `label_zh` / `label_en`，这里按**当前语言**挑一个（见 `shortcutLabel()`）。
    const shortcutDts = [];
    shortcuts.forEach(function (s) {
      const dt = el('dt', 'settings-key-label');
      const dd = el('dd', 'settings-key-combo');
      const kbd = el('kbd');
      kbd.textContent = s.display;
      dd.appendChild(kbd);
      // ⚠️ `accel` 是**规范形式**，别名（`⌘_` / `⌘+`）**不列**——
      //    列出来等于告诉用户"`Ctrl` 也是快捷键"，而 macOS 上那是错的直觉
      //    （`design/0010` §2.1 ① 末）。⚠️ 但它们**仍然生效**，这是刻意的。
      keyList.appendChild(dt);
      keyList.appendChild(dd);
      shortcutDts.push({ node: dt, s: s });
    });
    secKeys.appendChild(keyList);

    panel.appendChild(head);
    panel.appendChild(secLook);
    panel.appendChild(secEdit);
    panel.appendChild(secKeys);
    root.appendChild(scrim);
    root.appendChild(panel);
    document.body.appendChild(root);

    /** 静态行：标签带 `data-i18n`，换语言时由 `applyDom` 重贴。 */
    function row(labelKey, control) {
      const r = el('div', 'settings-row');
      r.appendChild(el('span', 'settings-label', labelKey));
      r.appendChild(control);
      return r;
    }

    /** ⚠️ 配置可以被手改（明文 JSON）⇒ 取值不在预设里时要补一个"自定义"项，
        ⛔ 不假装它就是某个预设（`ThemeSwitcher.js` 的同一条理由）。 */
    function ensureOption(sel, value, label) {
      const key = String(value);
      if (sel.querySelector('option[value="' + key + '"]')) return;
      const o = el('option');
      o.textContent = label;
      o.value = key;
      o.dataset.custom = '1';
      // ⚠️ "自定义 N" 带占位符，**没法用 `data-i18n`**（那只能贴无参的句子）
      //    ⇒ 它归 `relabel()` 管（§2.5.1 层②）。
      sel.appendChild(o);
    }

    /**
     * ⭐ **只能现算的那两格**（§2.5.1 层②）：「自定义 N」与快捷键名。
     * ⚠️ 它**不判 `opened`**：关着也要重贴，否则下次打开是旧字。
     */
    function relabel() {
      const a = theme.applied;

      lhSel.querySelectorAll('option[data-custom]').forEach(function (o) { o.remove(); });
      ensureOption(lhSel, a.lineHeight, T('settings.custom', { value: a.lineHeight }));
      lhSel.value = String(a.lineHeight);

      cwSel.querySelectorAll('option[data-custom]').forEach(function (o) { o.remove(); });
      ensureOption(cwSel, a.contentWidth,
        a.contentWidth === 0 ? T('typo.width.full') : T('settings.custom', { value: a.contentWidth }));
      cwSel.value = String(a.contentWidth);

      // ⚠️ 快捷键名按**当前语言**挑；后端还没送双语时回落老字段 `label`
      //    （`design/0025` §2.3：加字段与改前端同一批，但载荷必须能容忍旧后端）。
      const en = currentLang() === 'en';
      for (let i = 0; i < shortcutDts.length; i++) {
        const s = shortcutDts[i].s;
        let text = s && s.label;
        if (s && en && typeof s.label_en === 'string' && s.label_en) text = s.label_en;
        else if (s && typeof s.label_zh === 'string' && s.label_zh) text = s.label_zh;
        else if (s && typeof s.label === 'string') text = s.label;
        else text = '';
        shortcutDts[i].node.textContent = text;
      }

      // 语言下拉的当前值也现读——后端可能夹取/归一过偏好串。
      if (langSel) {
        let pref = 'system';
        try { pref = language.get() || 'system'; } catch (e) { pref = 'system'; }
        langSel.value = pref;
      }
    }

    /**
     * ⭐ **每一步都从 `theme.applied` 现读**（`INV-SET-03`）。
     * ⚠️ 关着的时候直接返回——省掉一堆看不见的 DOM 写。
     * ⚠️ 但"关着也要对"的那一半**已经不在这里**（挪去 `relabel()` 了）：
     *    `relabel` 只碰**动态的两格**，`render` 碰的是"用户要看的那个面板"。
     */
    function render() {
      if (!opened) return;
      const a = theme.applied;

      themeSel.value = a.mode;

      lhSel.querySelectorAll('option[data-custom]').forEach(function (o) { o.remove(); });
      ensureOption(lhSel, a.lineHeight, T('settings.custom', { value: a.lineHeight }));
      lhSel.value = String(a.lineHeight);

      cwSel.querySelectorAll('option[data-custom]').forEach(function (o) { o.remove(); });
      ensureOption(cwSel, a.contentWidth,
        a.contentWidth === 0 ? T('typo.width.full') : T('settings.custom', { value: a.contentWidth }));
      cwSel.value = String(a.contentWidth);

      fsVal.textContent = a.fontSize + ' px';
      fsDec.disabled = a.fontSize <= theme.FONT_SIZE_MIN;
      fsInc.disabled = a.fontSize >= theme.FONT_SIZE_MAX;

      // ⭐ `design/0014`：Vim 开关也**现读**（`INV-SET-03`）。
      //    ⚠️ 用 `=== true` 而不是 `!!`——与 `theme.js::reset` 同一条纪律：
      //    后端漏发这个键时它必须是**关**的（"Vim 自己开了"用户第一反应是键盘坏了）。
      vimChk.checked = a.vimMode === true;

      if (langSel) {
        let pref = 'system';
        try { pref = language.get() || 'system'; } catch (e) { pref = 'system'; }
        langSel.value = pref;
      }
    }

    // ⚠️ 所有写入都走 `theme.setX`（`INV-SET-06`）——本文件不认识"磁盘"这件事。
    themeSel.addEventListener('change', function () { theme.setMode(themeSel.value); });
    lhSel.addEventListener('change', function () { theme.setLineHeight(Number(lhSel.value)); });
    cwSel.addEventListener('change', function () { theme.setContentWidth(Number(cwSel.value)); });
    fsDec.addEventListener('click', function () { theme.setFontSize(theme.applied.fontSize - 1); });
    fsInc.addEventListener('click', function () { theme.setFontSize(theme.applied.fontSize + 1); });
    // ⭐ `design/0014`：`setVimMode` 也是 `theme` 的 setter 之一 ⇒ 同一个单写者队列。
    //    ⚠️ 读的是**控件的值**而不是 `theme.applied`：`change` 事件之后两者相同，
    //    但控件那份是"用户刚点出来的"，语义更直接（⛔ 别在这里做自己的状态机）。
    vimChk.addEventListener('change', function () { theme.setVimMode(vimChk.checked); });

    if (langSel) {
      // ⭐ 唯一一条**不经过 `theme.js`** 的写路径（`design/0025` §2.6）。
      // ⚠️ 失败**不回滚下拉框**：`relabel()` / `render()` 都从 `language.get()` 现读，
      //    下一轮订阅（或下次打开）会把它摆回真实值。回滚只会造第二份状态。
      langSel.addEventListener('change', function () {
        const want = langSel.value;
        try {
          const p = language.set(want);
          // ⚠️ 命令是异步的：成功后后端会推新的生效语言（`i18n.setLang`），
          //    那条路会走 `relabel()`；这里只把**拒绝**记下来（⛔ 不静默吞）。
          if (p && typeof p.then === 'function') {
            p.then(function () { relabel(); }, function (e) {
              console.error('⛔ 切换语言失败：', e);
              relabel();
            });
          }
        } catch (e) {
          console.error('⛔ 切换语言失败：', e);
          relabel();
        }
      });
    }

    const unsubscribe = theme.subscribe(render);
    // ⭐ §2.5.1 层③：静态那半 `setLang` 已经用 `applyDom` 贴过了（在订阅者之前），
    //    这里只补**只能现算**的那两格。⚠️ **不判 `opened`**（见模块头）。
    const unsubscribeI18n = I18N
      ? I18N.subscribe(function () { relabel(); })
      : function () {};

    // ── 焦点：`Esc` 关闭 + `Tab` 圈在面板里 ──
    function onKeydown(e) {
      if (!opened) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables(panel);
      if (list.length === 0) return;
      const first = list[0], last = list[list.length - 1];
      const active = document.activeElement;
      // ⚠️ 焦点跑到面板外（比如刚打开还没落进去）时也拉回来，⛔ 不放它溜走。
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }

    // ⚠️ 用 **capture**：`Esc` 与 `Tab` 都得在页面其余部分看到之前拦下。
    document.addEventListener('keydown', onKeydown, true);

    closeBtn.addEventListener('click', close);
    scrim.addEventListener('click', close);

    function open() {
      if (opened) return;
      // ⭐ 开一个就关另一个（`INV-SET-07`）——`0009` 的浮层若开着，先关它。
      closeOtherOverlays('settings');
      restoreTo = document.activeElement;
      opened = true;
      // ⚠️ **先** render 再显示：反过来的话会有一帧空白面板。
      render();
      root.hidden = false;
      document.body.classList.add('settings-open');
      const list = focusables(panel);
      (list.length ? list[0] : panel).focus();
    }

    function close() {
      if (!opened) return;
      opened = false;
      root.hidden = true;
      document.body.classList.remove('settings-open');
      // ⭐ **把焦点还给它打开前的那个元素**（`INV-SET-07`）——
      //    不还的话焦点会掉到 `body` 上，键盘用户下次按 `Tab` 要重新找一遍。
      const back = restoreTo;
      restoreTo = null;
      if (back && typeof back.focus === 'function' && document.contains(back)) {
        try { back.focus(); } catch (e) { /* 元素已不可聚焦就作罢，⛔ 不抛 */ }
      }
      if (currentFocusOwner() === 'settings') {
        // ⛔ 这里**不**调 `closeOtherOverlays(null)`——那会把还没关的别的覆盖层
        //    也一起关掉，而本条只该"交出我自己的焦点主人身份"。
        releaseFocusOwner('settings');
      }
    }

    const handle = {
      open: open,
      close: close,
      toggle: function () { if (opened) close(); else open(); },
      isOpen: function () { return opened; },
      render: render,
      // ⭐ 给探针/调试用的显式入口（`make probe-i18n` 在换语言后可以再叫一次，
      //    不必依赖订阅链是否接上）。⚠️ 它与订阅走的是**同一个** `relabel`。
      relabel: relabel,
      destroy: function () {
        unsubscribe();
        unsubscribeI18n();
        document.removeEventListener('keydown', onKeydown, true);
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };

    // ⭐ 注册进唯一那个登记处——`0009` 的浮层要**注册到同一个地方**（`INV-SET-07`）。
    registerOverlay('settings', handle);
    // ⚠️ 建完就先贴一次动态那两格：语言可能在**本组件创建之前**就被切过
    //    （例如恢复会话比建 UI 早），而 `applyDom` 管不到「自定义 N」与快捷键名。
    relabel();
    return handle;
  }

  const api = {
    createSettings: createSettings,
    registerOverlay: registerOverlay,
    closeOtherOverlays: closeOtherOverlays,
    currentFocusOwner: currentFocusOwner,
    releaseFocusOwner: releaseFocusOwner,
    CW_PRESETS: CW_PRESETS,
    LH_PRESETS: LH_PRESETS,
    THEME_LABELS: THEME_LABELS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).settings = api;
})();
