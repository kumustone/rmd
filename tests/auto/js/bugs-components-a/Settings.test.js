// 设置覆盖层组件层（`src/components/Settings.js`）的纯逻辑与可观察决策。
//
// # 这一层守什么
//
// 设置覆盖层有三条硬约束（文件头 `INV-SET-03/06/07`），每一条都能坏得**没有错误**：
//   · **每个值都从 `theme.applied` 现读**——攒副本的症状是"打开设置看到的是改之前的值"；
//   · **写只经 `theme.setX`**——自己调 IPC / 摸 DOM 主题就会多出第二个写者；
//   · **同一时刻至多一个覆盖层、焦点只有一个主人**——两个浮层叠着开，
//     焦点落点与 `Esc` 归谁就都说不清（`bugs/0036` 的同族）。
//
// ⚠️ 最小假 DOM：只实现 Settings 真正用到的选择器（`FOCUSABLE` 那串）与属性。
//    ⛔ 不为凑条数伪造整棵文档；断言都落在"用户看得见的值"或"交给依赖的调用"上。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

// ─────────────────────────────────────────────────────────────────────────
// 最小假 DOM（含 Settings 需要的那几个选择器）
// ─────────────────────────────────────────────────────────────────────────

function classTokens(s) { return String(s == null ? '' : s).split(/\s+/).filter(Boolean); }

class FNode {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this._attrs = Object.create(null);
    this._classes = new Set();
    this._listeners = Object.create(null);
    this._text = '';
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.title = '';
    this.placeholder = '';
    this.tabIndex = -1;
    this._tabIndexSet = false;
    this._styleProps = Object.create(null);
    this.style = {
      display: '',
      setProperty: (k, v) => { this._styleProps[k] = String(v); },
      getPropertyValue: (k) => this._styleProps[k] || '',
    };
    this._rect = { left: 0, top: 0, bottom: 20, right: 200, width: 200, height: 20 };
  }

  get classList() {
    const self = this;
    if (!this._classList) {
      this._classList = {
        add: function () { for (const c of arguments) if (c) self._classes.add(c); },
        remove: function () { for (const c of arguments) self._classes.delete(c); },
        contains: function (c) { return self._classes.has(c); },
        toggle: function (c, force) {
          const on = force === undefined ? !self._classes.has(c) : !!force;
          if (on) self._classes.add(c); else self._classes.delete(c);
          return on;
        },
      };
    }
    return this._classList;
  }

  get className() { return Array.from(this._classes).join(' '); }
  set className(v) {
    this._classes.clear();
    for (const c of classTokens(v)) this._classes.add(c);
  }

  setAttribute(k, v) {
    k = String(k);
    this._attrs[k] = String(v);
    if (k === 'class') this.className = v;
    else if (k === 'id') this.id = String(v);
    else if (k === 'tabindex') { this._tabIndexSet = true; this.tabIndex = Number(v); }
    else if (k === 'hidden') this.hidden = true;
    else if (k === 'placeholder') this.placeholder = String(v);
  }
  getAttribute(k) {
    k = String(k);
    if (k === 'class') return this.className || null;
    if (k === 'tabindex') return this._tabIndexSet ? String(this.tabIndex) : null;
    if (k === 'value') return this.value !== '' ? String(this.value) : (k in this._attrs ? this._attrs[k] : null);
    return k in this._attrs ? this._attrs[k] : null;
  }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  removeAttribute(k) {
    delete this._attrs[String(k)];
    if (k === 'tabindex') this._tabIndexSet = false;
  }

  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  removeChild(n) {
    const i = this.children.indexOf(n);
    if (i >= 0) { this.children.splice(i, 1); n.parentNode = null; }
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children.find((c) => c.nodeType === 1) || null; }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = String(v == null ? '' : v);
  }

  get offsetParent() {
    if (this.hidden) return null;
    let n = this.parentNode;
    while (n) {
      if (n.hidden || (n.style && n.style.display === 'none')) return null;
      n = n.parentNode;
    }
    return this.parentNode;
  }

  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }

  addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); }
  removeEventListener(type, fn) {
    const a = this._listeners[type];
    if (!a) return;
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  dispatch(type, extra) {
    const e = Object.assign({
      type: type,
      target: this,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault: function () { e.defaultPrevented = true; },
      stopPropagation: function () { e.propagationStopped = true; },
    }, extra || {});
    const a = this._listeners[type];
    if (a) for (const fn of a.slice()) fn(e);
    if (extra) {
      extra.defaultPrevented = !!extra.defaultPrevented || e.defaultPrevented;
      extra.propagationStopped = !!extra.propagationStopped || e.propagationStopped;
    }
    return !e.defaultPrevented;
  }

  focus() { this.ownerDocument.activeElement = this; }
  click() { this.dispatch('click', {}); }
  getBoundingClientRect() { return Object.assign({}, this._rect); }
  querySelectorAll(sel) { return queryAll(this, sel); }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
}

function walkNodes(node, fn) {
  for (const c of node.children) {
    if (c.nodeType !== 1) continue;
    fn(c);
    walkNodes(c, fn);
  }
}

function attrVal(n, name) {
  if (name === 'disabled') return n.disabled ? '' : (name in n._attrs ? n._attrs[name] : null);
  if (name === 'tabindex') {
    if (n._tabIndexSet) return String(n.tabIndex);
    return name in n._attrs ? n._attrs[name] : null;
  }
  if (name === 'value') return n.value !== '' ? String(n.value) : (name in n._attrs ? n._attrs[name] : null);
  if (name.indexOf('data-') === 0) {
    const key = name.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
    return Object.prototype.hasOwnProperty.call(n.dataset, key) ? String(n.dataset[key]) : null;
  }
  return name in n._attrs ? n._attrs[name] : null;
}

function matchesSimple(n, part) {
  let rest = String(part || '').trim();
  if (!rest) return false;
  const tagM = /^[A-Za-z][A-Za-z0-9-]*/.exec(rest);
  if (tagM) {
    if (n.tagName !== tagM[0].toUpperCase()) return false;
    rest = rest.slice(tagM[0].length);
  }
  // ⚠️ 先把 `[...]`（含 `:not([...])`）整块摘出去再找 class：
  //    否则 `[value="1.6"]` 里的那个点会被当成 `.6`（本文件第一版就是被它坑的）。
  const nots = [];
  rest = rest.replace(/:not\(\[[^\]]+\]\)/g, function (m) {
    nots.push(m.slice(6, -2)); // `:not([` 六字符起，去掉 `])`
    return '\u0002';
  });
  const attrs = [];
  rest = rest.replace(/\[[^\]]+\]/g, function (m) {
    attrs.push(m.slice(1, -1));
    return '\u0003';
  });
  let m;
  const classRe = /\.([A-Za-z0-9_-]+)/g;
  while ((m = classRe.exec(rest))) if (!n._classes.has(m[1])) return false;
  rest = rest.replace(/\.([A-Za-z0-9_-]+)/g, '').replace(/[\u0002\u0003]/g, '');
  if (rest.trim()) return false;
  for (const inner of nots) {
    const av = /^([^=]+)(?:="([^"]*)")?$/.exec(inner);
    if (!av) return false;
    const val = attrVal(n, av[1]);
    if (av[2] === undefined) { if (val !== null) return false; }
    else if (val === av[2]) return false;
  }
  for (const inner of attrs) {
    const av = /^([^=]+)(?:="([^"]*)")?$/.exec(inner);
    if (!av) return false;
    const val = attrVal(n, av[1]);
    if (av[2] === undefined) { if (val === null) return false; }
    else if (val !== av[2]) return false;
  }
  return true;
}

function matches(n, sel) {
  return String(sel).split(',').some(function (one) {
    const parts = one.split('>').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return false;
    if (!matchesSimple(n, parts[parts.length - 1])) return false;
    let p = n.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (p && (p.nodeType !== 1 || !matchesSimple(p, parts[i]))) p = p.parentNode;
      if (!p) return false;
      p = p.parentNode;
    }
    return true;
  });
}

function queryAll(root, sel) {
  const out = [];
  walkNodes(root, (n) => { if (matches(n, sel)) out.push(n); });
  return out;
}

function makeDoc() {
  const doc = {};
  doc.body = new FNode('body', doc);
  doc.documentElement = new FNode('html', doc);
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  doc._listeners = Object.create(null);
  doc.createElement = (t) => new FNode(t, doc);
  doc.contains = function (n) {
    for (let x = n; x; x = x.parentNode) {
      if (x === doc.body || x === doc.documentElement) return true;
    }
    return false;
  };
  doc.addEventListener = function (t, fn) { (doc._listeners[t] || (doc._listeners[t] = [])).push(fn); };
  doc.removeEventListener = function (t, fn) {
    const a = doc._listeners[t];
    if (!a) return;
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  doc.dispatch = function (t, extra) {
    const e = Object.assign({
      type: t,
      target: doc,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault: function () { e.defaultPrevented = true; },
      stopPropagation: function () { e.propagationStopped = true; },
    }, extra || {});
    for (const fn of (doc._listeners[t] || []).slice()) fn(e);
    if (extra) {
      extra.defaultPrevented = !!extra.defaultPrevented || e.defaultPrevented;
      extra.propagationStopped = !!extra.propagationStopped || e.propagationStopped;
    }
    return !e.defaultPrevented;
  };
  return doc;
}

// ─────────────────────────────────────────────────────────────────────────
// 加载与夹具
// ─────────────────────────────────────────────────────────────────────────

function fakeI18n(over) {
  return Object.assign({
    t: function (key, vars) {
      if (vars === undefined) return key;
      const parts = [];
      for (const k of Object.keys(vars)) parts.push(k + '=' + vars[k]);
      return key + '(' + parts.join(',') + ')';
    },
    lang: function () { return 'zh'; },
    subscribe: function (fn) {
      const subs = this._subs;
      subs.push(fn);
      return function () { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
    },
    _subs: [],
    emit: function () { for (const fn of this._subs.slice()) fn(); },
  }, over || {});
}

function fakeTheme(over) {
  const subs = [];
  const calls = [];
  const th = {
    applied: Object.assign({
      mode: 'system',
      fontSize: 16,
      lineHeight: 1.6,
      contentWidth: 900,
      vimMode: false,
    }, (over && over.applied) || {}),
    FONT_SIZE_MIN: 12,
    FONT_SIZE_MAX: 24,
    setMode: function (v) { calls.push(['mode', v]); },
    setFontSize: function (v) { calls.push(['fontSize', v]); },
    setLineHeight: function (v) { calls.push(['lineHeight', v]); },
    setContentWidth: function (v) { calls.push(['contentWidth', v]); },
    setVimMode: function (v) { calls.push(['vimMode', v]); },
    subscribe: function (fn) { subs.push(fn); return function () { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
    emit: function () { for (const fn of subs.slice()) fn(); },
    calls: calls,
    subs: subs,
  };
  return th;
}

function loadModule(over) {
  const o = over || {};
  const doc = makeDoc();
  const i18n = o.i18n || fakeI18n();
  const win = { rmd: { i18n: i18n } };
  const src = fs.readFileSync(path.join(ROOT, 'src/components/Settings.js'), 'utf8');
  new Function('window', 'document', 'module', 'require', src)(win, doc, undefined, undefined);
  return { doc: doc, win: win, i18n: i18n, api: win.rmd.settings };
}

function makeSettings(over) {
  const o = over || {};
  const mod = loadModule(o);
  const theme = o.theme || fakeTheme(o.themeOver);
  const language = o.language === undefined
    ? undefined
    : o.language;
  const handle = mod.api.createSettings({
    theme: theme,
    shortcuts: o.shortcuts || [],
    language: language,
  });
  const root = mod.doc.body.children[mod.doc.body.children.length - 1];
  const panel = root.querySelector('.settings-panel');
  const selects = root.querySelectorAll('.settings-control');
  const buttons = root.querySelectorAll('.settings-btn');
  const closeBtn = root.querySelector('.settings-close');
  const scrim = root.querySelector('.settings-scrim');
  const vim = root.querySelector('.settings-checkbox');
  const fsVal = root.querySelector('.settings-value');
  const labels = root.querySelectorAll('.settings-label').map((n) => n.textContent);
  const keyLabels = root.querySelectorAll('.settings-key-label');
  const keyCombos = root.querySelectorAll('.settings-key-combo');
  return {
    doc: mod.doc, win: mod.win, api: mod.api, i18n: mod.i18n,
    theme: theme, handle: handle, root: root, panel: panel,
    selects: selects, buttons: buttons, closeBtn: closeBtn, scrim: scrim,
    vim: vim, fsVal: fsVal, labels: labels,
    keyLabels: keyLabels, keyCombos: keyCombos,
  };
}

function tick() { return new Promise(function (r) { setImmediate(r); }); }

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0002（外观设置永不落盘）与 0007（外观只存住了主题）
//
// 同族纪律：设置界面只认 `theme` 这一个服务实例——读 `theme.applied`、
// 写 `theme.setX`。⛔ 自己调 IPC、⛔ 攒第二份快照。
// ─────────────────────────────────────────────────────────────────────────

test('导出：四档内容宽度、三档行高、四种主题标签顺序固定', function () {
  const api = loadModule().api;
  assert.deepStrictEqual(api.CW_PRESETS.map((p) => p.v), [0, 1200, 900, 720]);
  assert.deepStrictEqual(api.CW_PRESETS.map((p) => p.key),
    ['typo.width.full', 'typo.width.wide', 'typo.width.medium', 'typo.width.narrow']);
  assert.deepStrictEqual(api.LH_PRESETS.map((p) => p.v), [1.4, 1.6, 1.8]);
  assert.deepStrictEqual(api.LH_PRESETS.map((p) => p.key),
    ['typo.line-height.tight', 'typo.line-height.normal', 'typo.line-height.loose']);
  assert.deepStrictEqual(Object.keys(api.THEME_LABELS), ['system', 'light', 'dark', 'warm']);
});

test('建 UI：主题/行高/内容宽度三个下拉的预设值与 data-i18n 都对', function () {
  const s = makeSettings();
  assert.strictEqual(s.selects.length, 3, '没注入语言时不该有语言那一行');
  const themeOpts = s.selects[0].querySelectorAll('option');
  assert.deepStrictEqual(themeOpts.map((o) => o.value), ['system', 'light', 'dark', 'warm']);
  assert.deepStrictEqual(themeOpts.map((o) => o.getAttribute('data-i18n')),
    ['theme.system', 'theme.light', 'theme.dark', 'theme.warm']);
  const lhOpts = s.selects[1].querySelectorAll('option');
  assert.deepStrictEqual(lhOpts.map((o) => o.value), ['1.4', '1.6', '1.8']);
  const cwOpts = s.selects[2].querySelectorAll('option');
  assert.deepStrictEqual(cwOpts.map((o) => o.value), ['0', '1200', '900', '720']);
});

test('建 UI：行标签与分组标题都带字典键（换语言时由 applyDom 重贴）', function () {
  const s = makeSettings();
  assert.deepStrictEqual(s.labels, [
    'settings.theme',
    'settings.font-size',
    'settings.line-height',
    'settings.content-width',
    'settings.vim',
  ]);
  assert.strictEqual(s.root.querySelector('.settings-title').getAttribute('data-i18n'), 'settings.title');
});

test('建 UI：面板是 modal dialog，初始隐藏，未打开时不显示', function () {
  const s = makeSettings();
  assert.strictEqual(s.panel.getAttribute('role'), 'dialog');
  assert.strictEqual(s.panel.getAttribute('aria-modal'), 'true');
  assert.strictEqual(s.panel.getAttribute('aria-labelledby'), 'settings-title');
  assert.strictEqual(s.root.hidden, true);
  assert.strictEqual(s.handle.isOpen(), false);
});

test('open：先把值从 theme.applied 现读一遍，再显示（⛔ 一帧空白）', function () {
  const theme = fakeTheme({ applied: { mode: 'dark', fontSize: 18, lineHeight: 1.8, contentWidth: 720 } });
  const s = makeSettings({ theme: theme });
  s.handle.open();
  assert.strictEqual(s.root.hidden, false);
  assert.strictEqual(s.handle.isOpen(), true);
  assert.strictEqual(s.selects[0].value, 'dark');
  assert.strictEqual(s.selects[1].value, '1.8');
  assert.strictEqual(s.selects[2].value, '720');
  assert.strictEqual(s.fsVal.textContent, '18 px');
});

test('render：字号到上限时「+」禁用、到下限时「−」禁用、中间两都可点', function () {
  const theme = fakeTheme({ applied: { fontSize: 24 } });
  const s = makeSettings({ theme: theme });
  s.handle.open();
  assert.strictEqual(s.buttons[1].disabled, true);
  assert.strictEqual(s.buttons[0].disabled, false);

  theme.applied.fontSize = 12;
  theme.emit();
  assert.strictEqual(s.buttons[0].disabled, true);
  assert.strictEqual(s.buttons[1].disabled, false);

  theme.applied.fontSize = 16;
  theme.emit();
  assert.strictEqual(s.buttons[0].disabled, false);
  assert.strictEqual(s.buttons[1].disabled, false);
});

test('render：行高不在预设里时补一个「自定义」项，并选中它', function () {
  const theme = fakeTheme({ applied: { lineHeight: 1.75 } });
  const s = makeSettings({ theme: theme });
  s.handle.open();
  const custom = s.selects[1].querySelectorAll('option[data-custom]');
  assert.strictEqual(custom.length, 1);
  assert.strictEqual(custom[0].value, '1.75');
  assert.strictEqual(custom[0].textContent, 'settings.custom(value=1.75)');
  assert.strictEqual(s.selects[1].value, '1.75');
});

test('render：配置被改回预设值后，「自定义」项要消失（⛔ 越攒越多）', function () {
  const theme = fakeTheme({ applied: { lineHeight: 1.75 } });
  const s = makeSettings({ theme: theme });
  s.handle.open();
  s.handle.open(); // open 幂等
  theme.applied.lineHeight = 1.6;
  theme.emit();
  assert.strictEqual(s.selects[1].querySelectorAll('option[data-custom]').length, 0);
  assert.strictEqual(s.selects[1].value, '1.6');
  theme.applied.lineHeight = 1.7;
  theme.emit();
  theme.applied.lineHeight = 1.8;
  theme.emit();
  assert.strictEqual(s.selects[1].querySelectorAll('option[data-custom]').length, 0, '重复渲染不许堆叠');
});

test('render：内容宽度 0 的「自定义」标签用「整幅」，⛔ 不写成「自定义 0」', function () {
  const theme = fakeTheme({ applied: { contentWidth: 0 } });
  const s = makeSettings({ theme: theme });
  s.handle.open();
  assert.strictEqual(s.selects[2].value, '0');
  assert.strictEqual(s.selects[2].querySelectorAll('option[data-custom]').length, 0, '0 是预设，不该算自定义');
});

test('render：内容宽度不在预设里时补自定义项', function () {
  const theme = fakeTheme({ applied: { contentWidth: 1000 } });
  const s = makeSettings({ theme: theme });
  s.handle.open();
  const custom = s.selects[2].querySelectorAll('option[data-custom]');
  assert.strictEqual(custom.length, 1);
  assert.strictEqual(custom[0].textContent, 'settings.custom(value=1000)');
  assert.strictEqual(s.selects[2].value, '1000');
});

test('render：Vim 开关严格 === true（"true" / 1 / undefined 都算关）', function () {
  const theme = fakeTheme({ applied: { vimMode: 'true' } });
  const s = makeSettings({ theme: theme });
  s.handle.open();
  assert.strictEqual(s.vim.checked, false, '字符串 "true" 被真值判断读成开 = 键盘坏了');
  theme.applied.vimMode = 1;
  theme.emit();
  assert.strictEqual(s.vim.checked, false);
  theme.applied.vimMode = true;
  theme.emit();
  assert.strictEqual(s.vim.checked, true);
  theme.applied.vimMode = false;
  theme.emit();
  assert.strictEqual(s.vim.checked, false);
});

test('render：关着时不碰面板（open 才现读；⛔ 不在隐藏 DOM 上空转）', function () {
  const theme = fakeTheme({ applied: { mode: 'warm' } });
  const s = makeSettings({ theme: theme });
  theme.emit();
  assert.strictEqual(s.selects[0].value, '', '没打开就不该被渲染过');
  s.handle.open();
  assert.strictEqual(s.selects[0].value, 'warm');
});

test('theme 订阅：applied 变了之后面板跟着重画', function () {
  const theme = fakeTheme();
  const s = makeSettings({ theme: theme });
  s.handle.open();
  theme.applied.mode = 'light';
  theme.applied.fontSize = 20;
  theme.emit();
  assert.strictEqual(s.selects[0].value, 'light');
  assert.strictEqual(s.fsVal.textContent, '20 px');
});

test('theme 订阅：destroy 之后不再响应（⛔ 已拆的 UI 继续被写）', function () {
  const theme = fakeTheme();
  const s = makeSettings({ theme: theme });
  s.handle.open();
  s.handle.destroy();
  assert.strictEqual(theme.subs.length, 0);
  assert.doesNotThrow(function () { theme.emit(); });
});

// ─────────────────────────────────────────────────────────────────────────
// 写入：只经 theme.setX
// ─────────────────────────────────────────────────────────────────────────

test('写入：主题下拉 change 把字符串原样交给 theme.setMode', function () {
  const s = makeSettings();
  s.handle.open();
  s.selects[0].value = 'dark';
  s.selects[0].dispatch('change', {});
  assert.deepStrictEqual(s.theme.calls, [['mode', 'dark']]);
});

test('写入：行高 / 内容宽度下拉把值转成数字再交给 setter', function () {
  const s = makeSettings();
  s.handle.open();
  s.selects[1].value = '1.8';
  s.selects[1].dispatch('change', {});
  s.selects[2].value = '0';
  s.selects[2].dispatch('change', {});
  assert.deepStrictEqual(s.theme.calls, [['lineHeight', 1.8], ['contentWidth', 0]]);
});

test('写入：字号 − / + 基于 applied 的当前值算，⛔ 不回读输入框', function () {
  const theme = fakeTheme({ applied: { fontSize: 18 } });
  const s = makeSettings({ theme: theme });
  s.handle.open();
  s.buttons[0].dispatch('click', {});
  s.buttons[1].dispatch('click', {});
  assert.deepStrictEqual(theme.calls, [['fontSize', 17], ['fontSize', 19]]);
});

test('写入：Vim 开关读控件自己的 checked，交给 setVimMode', function () {
  const s = makeSettings();
  s.handle.open();
  s.vim.checked = true;
  s.vim.dispatch('change', {});
  assert.deepStrictEqual(s.theme.calls, [['vimMode', true]]);
  s.vim.checked = false;
  s.vim.dispatch('change', {});
  assert.deepStrictEqual(s.theme.calls, [['vimMode', true], ['vimMode', false]]);
});

test('写入：设置组件不自己调 IPC（theme 之外没有第二套写路径）', function () {
  const s = makeSettings();
  assert.strictEqual(s.win.rmd.tauri, undefined);
  assert.strictEqual(s.win.rmd.theme, undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0002（外观永不落盘）同族的「语言」注入
//
// 语言不走 theme 队列（要连带改菜单），只能由调用方注入；没注入就整行不渲染。
// ─────────────────────────────────────────────────────────────────────────

test('语言：没有注入 get/set 时整行不渲染', function () {
  const s = makeSettings();
  assert.strictEqual(s.labels.indexOf('settings.language'), -1);
  assert.strictEqual(s.selects.length, 3);
});

test('语言：注入后多一行，三项的值是偏好串 system/zh/en', function () {
  const s = makeSettings({
    language: { get: function () { return 'zh'; }, set: function () { return Promise.resolve(); } },
  });
  assert.deepStrictEqual(s.labels, [
    'settings.theme',
    'settings.font-size',
    'settings.line-height',
    'settings.content-width',
    'settings.language',
    'settings.vim',
  ]);
  assert.strictEqual(s.selects.length, 4);
  assert.deepStrictEqual(s.selects[3].querySelectorAll('option').map((o) => o.value), ['system', 'zh', 'en']);
});

test('语言：render 现读 language.get()，并夹到合法项', function () {
  const s = makeSettings({
    language: { get: function () { return 'en'; }, set: function () { return Promise.resolve(); } },
  });
  s.handle.open();
  assert.strictEqual(s.selects[3].value, 'en');
});

test('语言：get 抛错时回退 system（⛔ 设置面板打不开）', function () {
  const s = makeSettings({
    language: { get: function () { throw new Error('后端未就绪'); }, set: function () { return Promise.resolve(); } },
  });
  s.handle.open();
  assert.strictEqual(s.selects[3].value, 'system');
});

test('语言：get 返回空串时也回退 system', function () {
  const s = makeSettings({
    language: { get: function () { return ''; }, set: function () { return Promise.resolve(); } },
  });
  s.handle.open();
  assert.strictEqual(s.selects[3].value, 'system');
});

test('语言：change 调 language.set(想要的偏好)，成功后重贴动态文案', async function () {
  const seen = [];
  const s = makeSettings({
    language: { get: function () { return 'system'; }, set: function (v) { seen.push(v); return Promise.resolve(); } },
  });
  s.handle.open();
  s.selects[3].value = 'en';
  s.selects[3].dispatch('change', {});
  await tick();
  assert.deepStrictEqual(seen, ['en']);
  assert.strictEqual(s.selects[3].value, 'system', '拒绝/未生效时以 get 的真值为准');
});

test('语言：set 拒绝时记错误并重贴（⛔ 静默吞掉）', async function () {
  const errs = [];
  const old = console.error;
  console.error = function () { errs.push(Array.prototype.slice.call(arguments)); };
  const s = makeSettings({
    language: { get: function () { return 'zh'; }, set: function () { return Promise.reject(new Error('拒绝')); } },
  });
  try {
    s.handle.open();
    s.selects[3].value = 'en';
    s.selects[3].dispatch('change', {});
    await tick();
    assert.strictEqual(errs.length, 1);
    assert.strictEqual(s.selects[3].value, 'zh');
  } finally {
    console.error = old;
  }
});

test('语言：set 同步抛错也记错误并重贴', function () {
  const errs = [];
  const old = console.error;
  console.error = function () { errs.push(1); };
  const s = makeSettings({
    language: { get: function () { return 'zh'; }, set: function () { throw new Error('炸'); } },
  });
  try {
    s.handle.open();
    s.selects[3].value = 'en';
    s.selects[3].dispatch('change', {});
    assert.strictEqual(errs.length, 1);
    assert.strictEqual(s.selects[3].value, 'zh');
  } finally {
    console.error = old;
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0007（外观只存住了主题）同族的「双语重贴」
//
// 动态文案（自定义 N、快捷键名）不许缓存；换语言后即使面板关着也要重贴。
// ─────────────────────────────────────────────────────────────────────────

test('relabel：快捷方式标签按当前语言挑 label_en / label_zh', function () {
  const i18n = fakeI18n();
  const s = makeSettings({
    i18n: i18n,
    shortcuts: [
      { id: 'a', display: '⌘O', label: 'old-A', label_zh: '中文A', label_en: 'English A' },
    ],
  });
  assert.strictEqual(s.keyLabels[0].textContent, '中文A');
  i18n.lang = function () { return 'en'; };
  s.handle.relabel();
  assert.strictEqual(s.keyLabels[0].textContent, 'English A');
});

test('relabel：只有老字段 label 时回落它（载荷要能容忍旧后端）', function () {
  const s = makeSettings({
    shortcuts: [
      { id: 'a', display: '⌘O', label: '老标签' },
      // `label_zh` 是空串时不许遮住更老的 `label`，也不许在中文界面显示英文名
      { id: 'b', display: '⌘S', label: '老标签B', label_zh: '', label_en: 'Only EN' },
    ],
  });
  assert.strictEqual(s.keyLabels[0].textContent, '老标签');
  assert.strictEqual(s.keyLabels[1].textContent, '老标签B');
});

test('relabel：三个标签字段都没有时是空串，⛔ 不是 "undefined"', function () {
  const s = makeSettings({ shortcuts: [{ id: 'x', display: '⌘X' }] });
  assert.strictEqual(s.keyLabels[0].textContent, '');
});

test('快捷键列表：display 原样进 <kbd>，条数跟着后端表', function () {
  const s = makeSettings({
    shortcuts: [
      { id: 'a', display: '⌘O', label: 'A' },
      { id: 'b', display: '⇧⌘O', label: 'B' },
    ],
  });
  assert.strictEqual(s.keyCombos.length, 2);
  assert.deepStrictEqual(s.keyCombos.map((dd) => dd.querySelector('kbd').textContent), ['⌘O', '⇧⌘O']);
});

test('relabel：关着面板也会重贴「自定义 N」（⛔ 下次打开看到旧字）', function () {
  const theme = fakeTheme({ applied: { lineHeight: 1.66 } });
  const s = makeSettings({ theme: theme });
  assert.strictEqual(s.handle.isOpen(), false);
  const custom = s.selects[1].querySelectorAll('option[data-custom]');
  assert.strictEqual(custom.length, 1);
  assert.strictEqual(custom[0].textContent, 'settings.custom(value=1.66)');
});

test('relabel：i18n 订阅回调会重贴动态文案', function () {
  const i18n = fakeI18n();
  const s = makeSettings({
    i18n: i18n,
    shortcuts: [{ id: 'a', display: '⌘O', label_zh: '中文', label_en: 'EN' }],
  });
  i18n.lang = function () { return 'en'; };
  i18n.emit();
  assert.strictEqual(s.keyLabels[0].textContent, 'EN');
});

test('destroy：摘掉 i18n 订阅（⛔ 已拆的节点继续被重贴）', function () {
  const i18n = fakeI18n();
  const s = makeSettings({
    i18n: i18n,
    shortcuts: [{ id: 'a', display: '⌘O', label_zh: '中文', label_en: 'EN' }],
  });
  s.handle.destroy();
  i18n.lang = function () { return 'en'; };
  assert.doesNotThrow(function () { i18n.emit(); });
  assert.strictEqual(s.keyLabels[0].textContent, '中文');
});

// ─────────────────────────────────────────────────────────────────────────
// 焦点 / Esc / Tab（`INV-SET-07`）
// ─────────────────────────────────────────────────────────────────────────

test('open：把焦点放进面板（第一个可 Tab 元素）', function () {
  const s = makeSettings();
  s.handle.open();
  assert.strictEqual(s.doc.activeElement, s.closeBtn);
});

test('open：保存打开前的焦点，close 时还回去（⛔ 掉到 body）', function () {
  const s = makeSettings();
  const before = s.doc.createElement('button');
  s.doc.body.appendChild(before);
  before.focus();
  s.handle.open();
  s.handle.close();
  assert.strictEqual(s.doc.activeElement, before);
});

test('close：没打开时是空操作（⛔ 把焦点乱还）', function () {
  const s = makeSettings();
  const before = s.doc.createElement('button');
  before.focus();
  s.handle.close();
  assert.strictEqual(s.doc.activeElement, before);
  assert.strictEqual(s.handle.isOpen(), false);
});

test('close：清掉 body.settings-open；open 时加上', function () {
  const s = makeSettings();
  s.handle.open();
  assert.strictEqual(s.doc.body.classList.contains('settings-open'), true);
  s.handle.close();
  assert.strictEqual(s.doc.body.classList.contains('settings-open'), false);
});

test('toggle：关着就开、开着就关', function () {
  const s = makeSettings();
  s.handle.toggle();
  assert.strictEqual(s.handle.isOpen(), true);
  s.handle.toggle();
  assert.strictEqual(s.handle.isOpen(), false);
});

test('Esc：关闭面板、吃掉事件（⛔ 让下层也处理一次）', function () {
  const s = makeSettings();
  s.handle.open();
  const ev = { key: 'Escape' };
  s.doc.dispatch('keydown', ev);
  assert.strictEqual(s.handle.isOpen(), false);
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(ev.propagationStopped, true);
});

test('Esc：关着时 keydown 不理（监听还在，但不开着就不动）', function () {
  const s = makeSettings();
  const before = s.doc.createElement('button');
  before.focus();
  s.doc.dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(s.handle.isOpen(), false);
  assert.strictEqual(s.doc.activeElement, before);
});

test('Tab：在最后一个可 Tab 元素上绕回第一个', function () {
  const s = makeSettings();
  s.handle.open();
  s.vim.focus(); // 快捷键列表只读，Vim 开关是最后一个可 Tab 元素
  const ev = { key: 'Tab' };
  s.doc.dispatch('keydown', ev);
  assert.strictEqual(s.doc.activeElement, s.closeBtn);
  assert.strictEqual(ev.defaultPrevented, true);
});

test('Shift+Tab：在第一个可 Tab 元素上绕回最后一个', function () {
  const s = makeSettings();
  s.handle.open();
  s.closeBtn.focus();
  const ev = { key: 'Tab', shiftKey: true };
  s.doc.dispatch('keydown', ev);
  assert.strictEqual(s.doc.activeElement, s.vim);
  assert.strictEqual(ev.defaultPrevented, true);
});

test('Tab：焦点在面板外时被拉回第一个可 Tab 元素（⛔ 溜到 body）', function () {
  const s = makeSettings();
  s.handle.open();
  const outside = s.doc.createElement('button');
  s.doc.body.appendChild(outside);
  outside.focus();
  const ev = { key: 'Tab' };
  s.doc.dispatch('keydown', ev);
  assert.strictEqual(s.doc.activeElement, s.closeBtn);
  assert.strictEqual(ev.defaultPrevented, true);
});

test('Tab：中间位置不拦截（让浏览器自己走）', function () {
  const s = makeSettings();
  s.handle.open();
  s.selects[0].focus();
  const ev = { key: 'Tab' };
  s.doc.dispatch('keydown', ev);
  assert.strictEqual(ev.defaultPrevented, false);
  assert.strictEqual(s.doc.activeElement, s.selects[0], '中间位置不该替浏览器改焦点');
});

test('focusables：禁用 / 隐藏 / tabindex="-1" 的控制不进 Tab 圈', function () {
  const s = makeSettings();
  s.handle.open();
  s.buttons[0].disabled = true;
  s.selects[0].hidden = true;
  const e = {};
  s.doc.dispatch('keydown', Object.assign({ key: 'Tab', shiftKey: true }, e));
  // closeBtn 仍是第一个；Shift+Tab 应该绕到最后一个（Vim），而不是撞上被禁用/隐藏的
  assert.strictEqual(s.doc.activeElement, s.vim);
});

test('close 按钮与遮罩点击都关闭', function () {
  const s = makeSettings();
  s.handle.open();
  s.closeBtn.dispatch('click', {});
  assert.strictEqual(s.handle.isOpen(), false);
  s.handle.open();
  s.scrim.dispatch('click', {});
  assert.strictEqual(s.handle.isOpen(), false);
});

test('destroy：摘掉 document 上的 Esc/Tab 监听', function () {
  const s = makeSettings();
  s.handle.open();
  s.handle.destroy();
  s.doc.dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(s.handle.isOpen(), true, '监听没摘掉的话这里会被关掉');
});

test('destroy：把 DOM 从 body 摘掉', function () {
  const s = makeSettings();
  assert.ok(s.root.parentNode);
  s.handle.destroy();
  assert.strictEqual(s.root.parentNode, null);
});

// ─────────────────────────────────────────────────────────────────────────
// 覆盖层登记处（`INV-SET-07`）：同一时刻至多一层、焦点一个主人
// ─────────────────────────────────────────────────────────────────────────

test('登记处：注册后 closeOtherOverlays 会关掉其他层并接管焦点', function () {
  const mod = loadModule();
  const closed = [];
  mod.api.registerOverlay('quick-open', { close: function () { closed.push('q'); } });
  mod.api.registerOverlay('other', { close: function () { closed.push('o'); } });
  mod.api.closeOtherOverlays('quick-open');
  assert.deepStrictEqual(closed, ['o']);
  assert.strictEqual(mod.api.currentFocusOwner(), 'quick-open');
});

test('登记处：close 抛错的层不会挡住其他层被关', function () {
  const mod = loadModule();
  const closed = [];
  const old = console.error;
  console.error = function () {};
  mod.api.registerOverlay('bad', { close: function () { throw new Error('炸'); } });
  mod.api.registerOverlay('good', { close: function () { closed.push('g'); } });
  try {
    mod.api.closeOtherOverlays('current');
    assert.deepStrictEqual(closed, ['g']);
  } finally {
    console.error = old;
  }
});

test('登记处：注销函数只摘掉自己这一份，不误删后来注册的同名句柄', function () {
  const mod = loadModule();
  const oldHandle = { close: function () {} };
  const newHandle = { close: function () {} };
  const unregisterOld = mod.api.registerOverlay('x', oldHandle);
  mod.api.registerOverlay('x', newHandle);
  unregisterOld();
  let called = 0;
  newHandle.close = function () { called += 1; };
  mod.api.closeOtherOverlays('y');
  assert.strictEqual(called, 1, '同名新句柄必须还在登记处');
});

test('登记处：注销当前焦点主人时把它清掉', function () {
  const mod = loadModule();
  const un = mod.api.registerOverlay('x', { close: function () {} });
  mod.api.closeOtherOverlays('x');
  assert.strictEqual(mod.api.currentFocusOwner(), 'x');
  un();
  assert.strictEqual(mod.api.currentFocusOwner(), null);
});

test('releaseFocusOwner：只有当前主人自己才能交出身份', function () {
  const mod = loadModule();
  mod.api.registerOverlay('x', { close: function () {} });
  mod.api.closeOtherOverlays('x');
  mod.api.releaseFocusOwner('other');
  assert.strictEqual(mod.api.currentFocusOwner(), 'x');
  mod.api.releaseFocusOwner('x');
  assert.strictEqual(mod.api.currentFocusOwner(), null);
});

test('createSettings：打开会先关掉另一个覆盖层（⛔ 两层叠着）', function () {
  const mod = loadModule();
  let closed = 0;
  mod.api.registerOverlay('quick-open', { close: function () { closed += 1; } });
  const s = mod.api.createSettings({ theme: fakeTheme(), shortcuts: [] });
  s.open();
  assert.strictEqual(closed, 1);
  assert.strictEqual(mod.api.currentFocusOwner(), 'settings');
});

test('close：只交出焦点主人身份，不顺手关掉别的覆盖层', function () {
  const mod = loadModule();
  const s = mod.api.createSettings({ theme: fakeTheme(), shortcuts: [] });
  s.open();
  let otherClosed = 0;
  // 设置开着的时候另一个覆盖层被注册/打开（现实中会被 open 拦住，这里只验 close 的边界）
  mod.api.registerOverlay('quick-open', { close: function () { otherClosed += 1; } });
  assert.strictEqual(mod.api.currentFocusOwner(), 'settings');
  s.close();
  assert.strictEqual(mod.api.currentFocusOwner(), null);
  assert.strictEqual(otherClosed, 0);
});

test('open 两次：第二次是空操作（不重复保存 restoreTo）', function () {
  const s = makeSettings();
  const before = s.doc.createElement('button');
  s.doc.body.appendChild(before);
  before.focus();
  s.handle.open();
  s.closeBtn.focus();
  s.handle.open();
  assert.strictEqual(s.handle.isOpen(), true);
  s.handle.close();
  assert.strictEqual(s.doc.activeElement, before, 'restoreTo 仍是打开前那个');
});

test('⚠️ 疑似缺陷：destroy 不注销登记处（之后 closeOtherOverlays 仍会调它的 close）', function () {
  const mod = loadModule();
  const s = mod.api.createSettings({ theme: fakeTheme(), shortcuts: [] });
  let calls = 0;
  const orig = s.close;
  s.close = function () { calls += 1; return orig.apply(this, arguments); };
  s.destroy();
  mod.api.closeOtherOverlays('other');
  assert.strictEqual(calls, 1, '当前实现没有注销；修好后这里应变成 0');
});

test('⚠️ 疑似缺陷：开着时 destroy 不摘 body.settings-open', function () {
  const s = makeSettings();
  s.handle.open();
  s.handle.destroy();
  assert.strictEqual(s.doc.body.classList.contains('settings-open'), true);
});

test('⚠️ 疑似缺陷：destroy 不释放焦点主人身份', function () {
  const mod = loadModule();
  const s = mod.api.createSettings({ theme: fakeTheme(), shortcuts: [] });
  s.open();
  s.destroy();
  assert.strictEqual(mod.api.currentFocusOwner(), 'settings');
});
