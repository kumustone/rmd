// rmd · 中英双语的**真 DOM 离屏探针**（跑 `design/0025` §7.2 的 `make probe-i18n`）
//
// ⭐ 它加载的是**真 `src/index.html`**（`.sh` 只剥 `<script>`，一行布局都不改），
//    再叠上**产品那份** `src/components/Settings.js` 建出真实的设置覆盖层。
//    ⛔ 探针不抄第二份实现、不抄第二份样式。
//
// ⚠️⚠️ **一处与 `design/0025` §7.2 的字面不同**（已登记在其 §10）：
//    原稿写「剥掉除 `i18n.js` 外的全部 `<script>`」，而设置覆盖层**不在 `index.html` 里**
//    ——它是 `components/Settings.js` 在运行时建的。要量判据 ② 就**必须**让那份产品代码跑起来，
//    ⇒ `.sh` 在剥离之后**额外注入** `settings.js`（产品的 Settings.js）与 `harness.js`，
//    并断言"剥掉的条数 > 0 ∧ 留下来的恰好是 `i18n.js` 一条"。
//
// ⚠️ 判据 ①②要量的东西在静态 HTML 里**一半是 `hidden`**（保存按钮 / 保存失败提示 /
//    重载条 / 预览条 / 决策条），⇒ 量之前**强制打开**（设计 §7.2 末的评审 #9），
//    否则"英文 ＋ 保存 ＋ 失败提示同时可见"那个**最坏宽度永远量不到**。
//
// ⚠️ 离屏的安全形态（根 `CLAUDE.md` 工作约定 4）：本文件只改**自己页面里的 DOM**、
//    从不 `focus()` 任何系统级东西、不派发任何按键事件。窗口由 `.swift` 那边
//    `alphaValue = 0` ＋ `orderBack` ＋ `.prohibited` 建成。
//
// 约定：`window.__RUN()` 返回 `{环境, 夹具, 检查, 结论}`；判据在**退出码**上（`.sh` 聚合）。
(function () {
  'use strict';

  const I = (window.rmd && window.rmd.i18n) || null;
  const ST = (window.rmd && window.rmd.settings) || null;

  const checks = [];
  const errors = [];

  function rec(id, name, ok, criterion, value) {
    checks.push({ id: id, 名: name, 结果: ok ? '通过' : '失败', 判据: criterion, 值: value });
  }

  function t(k, v) { return I ? I.t(k, v) : '{' + k + '}'; }

  /** 四类 `data-i18n*` → 目标属性（与 `services/i18n.js::ATTRS` 同一张表，逐字）。 */
  const KINDS = [
    { attr: 'data-i18n', prop: 'textContent' },
    { attr: 'data-i18n-title', prop: 'title' },
    { attr: 'data-i18n-placeholder', prop: 'placeholder' },
    { attr: 'data-i18n-aria-label', prop: 'aria-label' }
  ];

  // ⚠️ 只认**汉字本体**（⛔ 不含全角标点）：`…` `·` `：` 在英文文案里也会出现，
  //    把它们算进"汉字"会让判据 ④ 永远红。
  const CJK = /[㐀-䶿一-鿿豈-﫿]/;

  // ⭐ 允许在**英文界面**里出现汉字的键——**只有一条**：语言名用本语言写。
  //    ⚠️ 这不是"漏翻"，是语言选择器的通行做法（`中文` 在英文界面里就该写 `中文`）。
  const CJK_ALLOW = { 'settings.lang.zh': true };

  function desc(n) {
    if (!n || !n.tagName) return '?';
    let s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    const cls = typeof n.className === 'string' ? n.className.trim() : '';
    if (cls) s += '.' + cls.split(/\s+/).slice(0, 2).join('.');
    return s;
  }

  function read(node, spec) {
    if (spec.prop === 'textContent') {
      return String(node.textContent == null ? '' : node.textContent).trim();
    }
    return String(node.getAttribute(spec.prop) || '').trim();
  }

  /** 当前 DOM 里**所有** (节点 × 类别) 组合，按文档顺序。 */
  function targets() {
    const out = [];
    for (let i = 0; i < KINDS.length; i++) {
      const spec = KINDS[i];
      const list = document.querySelectorAll('[' + spec.attr + ']');
      for (let j = 0; j < list.length; j++) {
        out.push({ node: list[j], spec: spec, key: list[j].getAttribute(spec.attr) });
      }
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────────
  // 设置覆盖层：用**产品那份** `components/Settings.js` 建出来
  // ⚠️ 依赖三条，全部是注入的桩（本探针不连后端）：
  //    · `theme`：判据 ② 只需要 `applied` 与 `subscribe`；
  //    · `shortcuts`：由 `.sh` 从 `gui/mod.rs` 的 `SHORTCUTS` **现读**（⛔ 不抄第二份表）；
  //    · `language`：语言下拉那一行只有注入时才渲染（`design/0025` §2.6）。
  // ────────────────────────────────────────────────────────────────
  const applied = { mode: 'system', fontSize: 14, lineHeight: 1.6, contentWidth: 900, vimMode: false };
  const themeSubs = [];
  const themeStub = {
    applied: applied,
    FONT_SIZE_MIN: 12,
    FONT_SIZE_MAX: 28,
    subscribe: function (fn) { themeSubs.push(fn); return function () {}; },
    setMode: function (v) { applied.mode = v; },
    setLineHeight: function (v) { applied.lineHeight = v; },
    setContentWidth: function (v) { applied.contentWidth = v; },
    setFontSize: function (v) { applied.fontSize = v; },
    setVimMode: function (v) { applied.vimMode = v === true; }
  };

  let settingsHandle = null;

  function buildOverlay() {
    const shortcuts = window.__SHORTCUTS || [];
    settingsHandle = ST.createSettings({
      theme: themeStub,
      shortcuts: shortcuts,
      language: { get: function () { return 'system'; }, set: function () { return null; } }
    });
    return { 覆盖层: 'components/Settings.js（产品原样）', 快捷键条数: shortcuts.length };
  }

  // ────────────────────────────────────────────────────────────────
  // 判据
  // ────────────────────────────────────────────────────────────────

  /** 0：页面隔离自证——探针页里**只有** i18n ＋ settings，⛔ 不是整个应用。 */
  function t0_isolated() {
    const keys = Object.keys(window.rmd || {}).sort();
    const srcs = [];
    const list = document.querySelectorAll('script[src]');
    for (let i = 0; i < list.length; i++) srcs.push(list[i].getAttribute('src'));
    const bad = [];
    if (keys.join(',') !== 'i18n,settings') bad.push('window.rmd 的键 = ' + JSON.stringify(keys));
    if (typeof window.__TAURI__ !== 'undefined') bad.push('window.__TAURI__ 还在（没剥干净）');
    if (srcs.join(',') !== 'services/i18n.js,components/Settings.js,__harness.js') {
      // ⚠️ 期望值里有**三条**：`i18n.js` 是唯一留下来的产品脚本（路径原封不动），
      //    另两条是 `.sh` 注入的（产品 `Settings.js` ＋ 本探针）。
      //    ⇒ 多一条就意味着"`.sh` 没剥干净"，少一条就意味着"覆盖层/夹具没上场"。
      bad.push('剩下的 <script src> = ' + JSON.stringify(srcs));
    }
    return {
      ok: bad.length === 0,
      value: { 'window.rmd': keys, 'script src': srcs, 反例: bad }
    };
  }

  /**
   * ③：每个 `data-i18n*` 在**两种语言下**都非空，且⛔ 不许显示成 key 本身；
   *     ⭐ 附加判据：**属性值本身不许是空串**（`data-i18n=""` 永远是缺陷，见下）。
   */
  function t3_nonEmpty() {
    const bad = [];
    let seen = 0;
    // ⭐⭐ **空属性值**单独查：`data-i18n=""` 不是"没有键"，是"给了一个空键"——
    //    `t('')` 按 `INV-I18N-02` 返回 `(i18n: empty key)`，于是那句 ASCII 会被**贴进界面**，
    //    而且 `applyDom()` 每次换语言都再贴一次。
    //    ⚠️ 2026-10-21 本探针第一次跑就靠这一格抓到了 `Settings.js` 的
    //    `el('span','settings-value','')`（开着设置改语言 ⇒ 字号变 `(i18n: empty key)`）。
    for (let i = 0; i < KINDS.length; i++) {
      const spec = KINDS[i];
      const list = document.querySelectorAll('[' + spec.attr + ']');
      for (let j = 0; j < list.length; j++) {
        const k = list[j].getAttribute(spec.attr);
        if (!String(k == null ? '' : k).trim()) {
          bad.push({ 元素: desc(list[j]), 属性: spec.attr, 键: k, 问题: '属性值是空串（空字典键）' });
        }
      }
    }
    const langs = ['zh', 'en'];
    for (let i = 0; i < langs.length; i++) {
      I.setLang(langs[i]);
      const list = targets();
      for (let j = 0; j < list.length; j++) {
        const it = list[j];
        seen += 1;
        const v = read(it.node, it.spec);
        if (!v) {
          bad.push({ lang: langs[i], 元素: desc(it.node), 键: it.key, 问题: '空' });
        } else if (v === it.key) {
          // `t()` 的最后一个回退档：两本字典都没有 ⇒ 显示 key。
          // ⚠️ 那**不是空串**，但对用户就是一串 `sidebar.tab-files` ⇒ 同样算失败。
          bad.push({ lang: langs[i], 元素: desc(it.node), 键: it.key, 问题: '显示成 key（两本字典都缺）' });
        }
      }
    }
    return {
      ok: bad.length === 0,
      value: { 检查组合数: seen, 反例: bad.slice(0, 12), 反例总数: bad.length }
    };
  }

  /** ④：`lang=en` 之后，每个 `data-i18n*` 的取值里**不许有汉字**（一条 allow-list）。 */
  function t4_noCJK() {
    I.setLang('en');
    const bad = [];
    const list = targets();
    let allowHit = 0;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const v = read(it.node, it.spec);
      if (!CJK.test(v)) continue;
      if (CJK_ALLOW[it.key]) { allowHit += 1; continue; }
      bad.push({ 元素: desc(it.node), 键: it.key, 值: v });
    }
    return {
      ok: bad.length === 0,
      value: {
        反例: bad.slice(0, 12),
        反例总数: bad.length,
        'allow-list 命中': allowHit,
        'allow-list': Object.keys(CJK_ALLOW)
      }
    };
  }

  /** ④（反面判据）：切换之后**至少 N 个**取值真的变了——证明"真的切了"，⛔ 不是没生效。 */
  function t5_reallySwitched() {
    I.setLang('zh');
    const before = targets().map(function (it) { return read(it.node, it.spec); });
    // ⭐ 顺带钉一条：`zh → zh` 必须是**幂等**的（`applyDom` 返回 0）。
    //    它不幂等意味着"同一句话每贴一次都算改了一次"，切换计数就失去意义。
    const idem = I.applyDom();
    I.setLang('en');
    const after = targets().map(function (it) { return read(it.node, it.spec); });
    let changed = 0;
    const n = Math.min(before.length, after.length);
    for (let i = 0; i < n; i++) if (before[i] !== after[i]) changed += 1;
    const aligned = before.length === after.length;
    const N = 20;
    return {
      ok: aligned && idem === 0 && changed >= N,
      value: {
        变化数: changed, 阈值: N, 组合数: after.length,
        '对齐': aligned,
        'zh→zh_幂等返回': idem
      }
    };
  }

  /** ⑤：`<html lang>` 跟着变（出厂 `zh-CN` → `en` → `zh-CN`）。 */
  function t6_htmlLang() {
    const root = document.documentElement;
    const seq = [];
    const bad = [];
    const expect = [['zh', 'zh-CN'], ['en', 'en'], ['zh', 'zh-CN']];
    for (let i = 0; i < expect.length; i++) {
      I.setLang(expect[i][0]);
      const got = root.getAttribute('lang');
      seq.push({ set: expect[i][0], lang: got });
      if (got !== expect[i][1]) bad.push({ set: expect[i][0], 期望: expect[i][1], 实际: got });
    }
    return { ok: bad.length === 0, value: { 序列: seq, 反例: bad } };
  }

  // ── 几何：横向溢出 ────────────────────────────────────────────────

  /**
   * 量一个容器的**横向溢出**。
   *
   * ⚠️ 两个数都要看，⛔ 别只信一个：
   *   · `scrollWidth - clientWidth` 在"容器自己有滚动"时最准；
   *   · **后代右缘超过容器右缘多少**——对 `overflow: visible` 的容器，
   *     各引擎对 `scrollWidth` 的口径不完全一致，而 rect 不受这个口径影响。
   */
  function overflowX(el) {
    if (!el) return { 缺: true };
    const base = el.getBoundingClientRect();
    let worstRight = base.right;
    let worstNode = '';
    const all = el.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      // `getClientRects().length === 0` = 自己和祖先都没有布局盒（`display:none` 一族）
      if (!n.getClientRects().length) continue;
      if (getComputedStyle(n).visibility === 'hidden') continue;
      const r = n.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > worstRight + 0.5) { worstRight = r.right; worstNode = desc(n); }
    }
    return {
      宽: Math.round(base.width * 100) / 100,
      滚动超宽: Math.round(el.scrollWidth - el.clientWidth),
      最右超出: Math.round((worstRight - base.right) * 100) / 100,
      最右元素: worstNode
    };
  }

  /**
   * 把 `.topbar` 里**静态 `hidden` 的那几条强制打开**（设计 §7.2 的评审 #9）。
   * ⚠️ 动态文案全部取自**字典**（⛔ 不自造句子）——挑的是产品真会写进那几格的长句。
   */
  function forceShowTopbar() {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return { 缺: '.topbar' };
    const opened = [];
    const hid = topbar.querySelectorAll('[hidden]');
    for (let i = 0; i < hid.length; i++) { hid[i].hidden = false; opened.push(desc(hid[i])); }

    const status = document.getElementById('status');
    if (status) {
      status.textContent = t('status.summary', {
        path: '/Users/you/Documents/long-folder-name/meeting-notes-2026-10-21.md',
        src: 10485760, html: 20971520, ast: 12345, toc: 42,
        total: 8, loaded: 6, unauthorized: 1, remote: 1, missing: 0,
        t1: 12.3, t2: 45.6, t3: 789.0
      });
    }
    const reloadText = document.getElementById('reload-text');
    if (reloadText) reloadText.textContent = t('reload.paused', { mb: '12.3' });
    const previewText = document.getElementById('preview-text');
    // 档 C 的那句是全字典里最长的一条英文（实测 ≈ 100 字符）
    if (previewText) previewText.textContent = t('edit.preview-stale-c');
    const promptText = document.getElementById('edit-prompt-text');
    if (promptText) promptText.textContent = t('edit.external-changed');
    const promptActs = document.getElementById('edit-prompt-actions');
    if (promptActs && !promptActs.childNodes.length) {
      ['edit.act-reload-disk', 'edit.act-keep-mine'].forEach(function (k) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = t(k);
        promptActs.appendChild(b);
      });
    }
    return { 强制打开: opened, 条数: opened.length };
  }

  /** ①：`lang=en` 之后 `.topbar`（阅读态最坏宽度）不横向溢出。 */
  function t1_topbarReading() {
    document.body.classList.remove('editing');
    I.setLang('en');
    const open = forceShowTopbar();
    const bar = overflowX(document.querySelector('.topbar'));
    const tool = overflowX(document.querySelector('.toolbar'));
    const ok = !bar['缺'] && bar['最右超出'] <= 0.5 && bar['滚动超宽'] <= 0
      && !tool['缺'] && tool['最右超出'] <= 0.5 && tool['滚动超宽'] <= 0;
    return {
      ok: ok,
      value: { topbar: bar, toolbar: tool, ...open }
    };
  }

  /**
   * ②：`body.editing` 下同样不溢出。
   * ⚠️ 为什么单独量：`#preview-bar` 只有 `body.editing` 时才 `display:flex`
   *    （阅读态它是 `display:none`，`hidden=false` 也压不动）⇒ 编辑态才是它的最坏宽度。
   */
  function t2_topbarEditing() {
    document.body.classList.add('editing');
    I.setLang('en');
    forceShowTopbar();
    const bar = overflowX(document.querySelector('.topbar'));
    const tool = overflowX(document.querySelector('.toolbar'));
    const ok = !bar['缺'] && bar['最右超出'] <= 0.5 && bar['滚动超宽'] <= 0
      && !tool['缺'] && tool['最右超出'] <= 0.5 && tool['滚动超宽'] <= 0;
    const editing = { ok: ok, value: { topbar: bar, toolbar: tool } };
    document.body.classList.remove('editing');
    return editing;
  }

  /** ③（设计 §7.2 的 ②）：设置覆盖层在英文下不横向溢出。 */
  function t3_overlay() {
    if (!settingsHandle) return { ok: false, value: { 致命: '覆盖层没建出来' } };
    I.setLang('en');
    settingsHandle.open();
    settingsHandle.relabel();
    const panel = document.querySelector('.settings-panel');
    if (!panel) {
      settingsHandle.close();
      return { ok: false, value: { 缺: '.settings-panel' } };
    }
    // ⚠️⚠️ `open()` 会把焦点交给第一个可聚焦元素，而**程序性 `focus()` 可能带滚动**
    //    （面板是 `overflow-y: auto` ⇒ 横向也成了 `auto`）⇒ 量之前**先把 scrollLeft 归零**，
    //    否则"面板自己滚了一下"会**抵消**掉真实的超宽，判据就成了绿得没道理的那一种。
    const 归零前 = panel.scrollLeft;
    panel.scrollLeft = 0;
    const r = overflowX(panel);
    // 面板自己是 `overflow-y: auto` ⇒ 横向也成了 auto，`scrollWidth` 这一格是可用的。
    const ok = r['最右超出'] <= 0.5 && r['滚动超宽'] <= 0;
    const out = { ok: ok, value: { panel: r, '焦点带动的横向滚动': 归零前 } };
    settingsHandle.close();
    return out;
  }

  /** 覆盖层语言行：三项 ＋ 文案跟随语言（也顺带把 allow-list 那一条量出来）。 */
  function t7_langRow() {
    I.setLang('zh');
    const sels = document.querySelectorAll('.settings-panel select');
    let sel = null;
    for (let i = 0; i < sels.length; i++) {
      if (sels[i].querySelector('option[value="en"]')) { sel = sels[i]; break; }
    }
    if (!sel) return { ok: false, value: { 缺: '语言下拉（opts.language 没注入？）' } };
    const vals = [];
    const zh = [];
    const opts = sel.querySelectorAll('option');
    for (let i = 0; i < opts.length; i++) { vals.push(opts[i].value); zh.push(opts[i].textContent); }
    I.setLang('en');
    const en = [];
    for (let i = 0; i < opts.length; i++) en.push(opts[i].textContent);
    const want = ['system', 'zh', 'en'];
    const ok = vals.join(',') === want.join(',')
      && zh.join('|') === '跟随系统|中文|English'
      && en.join('|') === 'System|中文|English';
    return { ok: ok, value: { 值: vals, zh: zh, en: en } };
  }

  // ────────────────────────────────────────────────────────────────
  // 入口
  // ────────────────────────────────────────────────────────────────
  window.__RUN = async function () {
    const t0 = Date.now();

    if (!I) return { 致命: 'window.rmd.i18n 不在——i18n.js 没加载或被剥掉了' };
    if (!ST) return { 致命: 'window.rmd.settings 不在——components/Settings.js 没加载' };

    let fixture;
    try {
      fixture = buildOverlay();
    } catch (e) {
      return { 致命: '覆盖层建不出来：' + String((e && e.stack) || e) };
    }

    const tests = [
      ['0', '页面隔离自证（只有 i18n ＋ settings）', t0_isolated],
      ['3', '每个 data-i18n* 键非空、两种语言下都有字', t3_nonEmpty],
      ['4', '英文界面里没有汉字（一条 allow-list）', t4_noCJK],
      ['5', '切换后真的变了（≥ 20 处 ＋ zh→zh 幂等）', t5_reallySwitched],
      ['6', '<html lang> 跟着变（zh-CN → en → zh-CN）', t6_htmlLang],
      ['1', '阅读态 .topbar 无横向溢出（hidden 强制打开）', t1_topbarReading],
      ['2', '编辑态 .topbar 无横向溢出（预览条登场）', t2_topbarEditing],
      ['7', '设置覆盖层无横向溢出（英文）', t3_overlay],
      ['8', '覆盖层语言行：三项且文案跟随语言', t7_langRow]
    ];

    for (let i = 0; i < tests.length; i++) {
      const id = tests[i][0];
      const name = tests[i][1];
      const fn = tests[i][2];
      try {
        const r = await fn();
        rec(id, name, !!r.ok, name, r.value);
      } catch (e) {
        errors.push({ id: id, error: String((e && e.stack) || e) });
        rec(id, name, false, '抛错', String((e && e.message) || e));
      }
    }

    // 收尾把语言摆回出厂（⛔ 别让后续看页面的人拿到一个半英文的 DOM）
    try { I.setLang('zh'); } catch (e) { /* 收尾失败不影响判据 */ }

    return {
      环境: {
        加载期错误: window.__LOADERR || [],
        视口: {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          docScrollWidth: document.documentElement.scrollWidth
        },
        字典: {
          zh键数: Object.keys(I.DICT.zh).length,
          en键数: Object.keys(I.DICT.en).length,
          't() 回落过的键': I.missing(),
          't() 缺过的参数': I.missingVars()
        },
        墙钟秒: Math.round((Date.now() - t0) / 10) / 100,
        错误: errors
      },
      夹具: {
        页面: '真 src/index.html（.sh 剥掉除 i18n.js 外的全部 <script> 并断言条数）',
        覆盖层: fixture['覆盖层'],
        快捷键条数: fixture['快捷键条数'],
        '⚠️ 快捷键的取值': 'display 用的是 gui/mod.rs 里的 accel 串（⛔ 不是 ⌘ 字形）'
          + ' ⇒ kbd 比产品里更宽，是**偏严**的口径',
        '⚠️ 视口': '1280 × 820（< 13 英寸 MacBook 的 1440 逻辑宽 ⇒ 比真实屏幕更严）',
        '⚠️ 语言': '初始 zh（⛔ 不读 navigator.language，INV-I18N-07）'
      },
      检查: checks,
      结论: {
        通过: checks.filter(function (c) { return c.结果 === '通过'; }).length,
        失败: checks.filter(function (c) { return c.结果 === '失败'; }).length,
        跳过: 0
      }
    };
  };

  window.__READY = true;
})();
