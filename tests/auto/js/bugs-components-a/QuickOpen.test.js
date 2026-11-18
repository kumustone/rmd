// 文件名快速打开浮层（`src/components/QuickOpen.js`）的纯逻辑与可观察决策。
//
// # 这一层守什么
//
// 浮层本身不匹配、不排序（匹配在 Rust 侧），前端只做四件事：
//   ① 打开时 `rebuild: true`（`design/0009` §2.1 ② / `INV-SEARCH-06`）；
//   ② 把 `search()` 回来的 `decision` 翻成"提交 / 清空 / 什么都不做"；
//   ③ 选中项在结果表里环绕移动，回车先关浮层再打开文件；
//   ④ 浮层自己的键盘（↑↓ Enter Esc Tab ＋ 刷新键）只在它拿到焦点时存在。
//
// ⚠️ 这里加载的是**产品那三份真文件**：`keymap.js`（认刷新键）、`search.js`
//    （切命中片段 / 写说明行）、`Settings.js`（覆盖层登记处）。浮层的 `search`
//    与 `onPick` 是注入的假后端——本文件不认识 IPC。
// ⚠️ 最小假 DOM 只实现本组件用到的选择器与节点方法，⛔ 不伪造整棵文档来凑条数。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

// ─────────────────────────────────────────────────────────────────────────
// 最小假 DOM
// ─────────────────────────────────────────────────────────────────────────

function classTokens(s) { return String(s == null ? '' : s).split(/\s+/).filter(Boolean); }

class FText {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
    this.parentNode = null;
  }
}

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
    this.type = '';
    this.title = '';
    this.placeholder = '';
    this.tabIndex = -1;
    this._tabIndexSet = false;
    this.isContentEditable = false;
    this.style = { display: '', setProperty: function () {}, getPropertyValue: function () { return ''; } };
    this._rect = { left: 0, top: 0, bottom: 20, right: 200, width: 200, height: 20 };
    this.scrolls = 0;
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
    else if (k === 'value') this.value = String(v);
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

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = String(v == null ? '' : v);
  }

  get offsetParent() { return this.hidden ? null : (this.parentNode || null); }
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
  scrollIntoView() { this.scrolls += 1; }
  closest(sel) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) {
      if (matches(n, sel)) return n;
    }
    return null;
  }
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

function matchesSimple(n, part) {
  let rest = String(part || '').trim();
  if (!rest) return false;
  const tagM = /^[A-Za-z][A-Za-z0-9-]*/.exec(rest);
  if (tagM) {
    if (n.tagName !== tagM[0].toUpperCase()) return false;
    rest = rest.slice(tagM[0].length);
  }
  let m;
  const idRe = /#([A-Za-z0-9_-]+)/g;
  while ((m = idRe.exec(rest))) if (n.id !== m[1]) return false;
  rest = rest.replace(/#([A-Za-z0-9_-]+)/g, '');
  const classRe = /\.([A-Za-z0-9_-]+)/g;
  while ((m = classRe.exec(rest))) if (!n._classes.has(m[1])) return false;
  rest = rest.replace(/\.([A-Za-z0-9_-]+)/g, '');
  return rest.trim() === '';
}

function matches(n, sel) {
  return String(sel).split(',').some((one) => matchesSimple(n, one.trim()));
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
  doc.createTextNode = (t) => new FText(t);
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
// 加载：i18n（假）→ keymap（真）→ search（真）→ Settings（真）→ QuickOpen
// ─────────────────────────────────────────────────────────────────────────

function fakeI18n(over) {
  const dict = Object.create(null);
  const subs = [];
  const api = Object.assign({
    t: function (key, vars) {
      let base = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
      if (vars === undefined) return base;
      const parts = [];
      for (const k of Object.keys(vars)) parts.push(k + '=' + vars[k]);
      return base + '(' + parts.join(',') + ')';
    },
    lang: function () { return 'zh'; },
    subscribe: function (fn) {
      subs.push(fn);
      return function () { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
    },
    emit: function () { for (const fn of subs.slice()) fn(); },
    set: function (key, text) { dict[key] = text; },
    _dict: dict,
    _subs: subs,
  }, over || {});
  return api;
}

function loadFile(win, doc, rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', 'document', 'module', 'require', src)(win, doc, undefined, undefined);
}

function loadModule(over) {
  const o = over || {};
  const doc = makeDoc();
  const i18n = o.i18n || fakeI18n();
  const win = { rmd: { i18n: i18n } };
  loadFile(win, doc, 'src/services/keymap.js');
  loadFile(win, doc, 'src/services/search.js');
  loadFile(win, doc, 'src/components/Settings.js');
  loadFile(win, doc, 'src/components/QuickOpen.js');
  return {
    doc: doc, win: win, i18n: i18n,
    api: win.rmd.quickOpen,
    keymap: win.rmd.keymap,
    search: win.rmd.search,
    settings: win.rmd.settings,
  };
}

function entry(name, rel, realPath, spans) {
  return {
    name: name,
    rel: rel === undefined ? name : rel,
    realPath: realPath === undefined ? '/' + name : realPath,
    spans: spans || [],
  };
}

function response(entries, decision, extra) {
  const list = entries || [];
  return {
    result: Object.assign({
      entries: list,
      totalHits: list.length,
      truncated: false,
      builtAtMs: 0,
    }, extra || {}),
    decision: decision || { commit: true },
  };
}

function fakeSearch(defaultResp) {
  const calls = [];
  const search = function (pattern, rebuild) {
    calls.push([pattern, rebuild]);
    if (search.hang) {
      return new Promise(function (resolve) { search.pending.push(resolve); });
    }
    const next = search.queue.length ? search.queue.shift() : search.defaultResp;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  search.calls = calls;
  search.queue = [];
  search.pending = [];
  search.hang = false;
  search.defaultResp = defaultResp || response([]);
  return search;
}

function tick() { return new Promise(function (r) { setImmediate(r); }); }

function makeQuick(over) {
  const o = over || {};
  const mod = loadModule(o);
  const search = o.search || fakeSearch(o.defaultResp);
  const picked = [];
  const errors = [];
  let allowed = o.available !== false;
  const q = {};
  q.mod = mod;
  q.doc = mod.doc;
  q.i18n = mod.i18n;
  q.search = search;
  q.picked = picked;
  q.errors = errors;
  q.available = function (v) { if (v !== undefined) allowed = !!v; return allowed; };
  q.handle = mod.api.createQuickOpen({
    search: search,
    onPick: function (p) {
      picked.push({ path: p, open: q.handle ? q.handle.isOpen() : null });
      if (o.onPick) o.onPick(p);
    },
    onError: function (e) { errors.push(e); },
    keymap: { bindings: o.bindings || [{ id: 'refresh-index', accel: 'Cmd+R' }] },
    refreshId: 'refresh-index',
    keyText: o.keyText || function () { return ''; },
    isAvailable: function () { return allowed; },
  });
  q.root = mod.doc.body.children[mod.doc.body.children.length - 1];
  q.panel = q.root.querySelector('.quickopen-panel');
  q.input = q.root.querySelector('.quickopen-input');
  q.note = q.root.querySelector('.quickopen-note');
  q.list = q.root.querySelector('.quickopen-list');
  q.rows = function () { return q.list.querySelectorAll('.quickopen-item'); };
  q.empty = function () { return q.list.querySelector('.quickopen-empty'); };
  q.noteText = function () { return q.note.textContent; };
  q.type = function (v) { q.input.value = v; q.input.dispatch('input', {}); };
  q.key = function (ev) { q.doc.dispatch('keydown', ev); return ev; };
  q.clickRow = function (i, extra) {
    const rows = q.rows();
    return q.list.dispatch('click', Object.assign({ target: rows[i] }, extra || {}));
  };
  q.moveTo = function (i) {
    const rows = q.rows();
    return q.list.dispatch('mousemove', { target: rows[i] });
  };
  return q;
}

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
//
// 浮层不是"打开时读一次缓存"：**每次打开都 rebuild**，浮层里的刷新键也 rebuild。
// 否则界面上的"刷新提示"就成了假话——用户按了也看不到新文件。
// ─────────────────────────────────────────────────────────────────────────

test('常量：覆盖层名是登记处认得的 quick-open', function () {
  assert.strictEqual(loadModule().api.NAME, 'quick-open');
});

test('open：首次打开用空模式并 rebuild=true（⛔ 吃旧索引）', async function () {
  const q = makeQuick();
  assert.strictEqual(q.handle.open(), true);
  await tick();
  assert.deepStrictEqual(q.search.calls, [['', true]]);
});

test('open：单文件模式不可用时返回 false，且不触发查询', function () {
  const q = makeQuick({ available: false });
  assert.strictEqual(q.handle.open(), false);
  assert.strictEqual(q.handle.isOpen(), false);
  assert.strictEqual(q.search.calls.length, 0);
  assert.strictEqual(q.root.hidden, true);
});

test('open：可用时返回 true，显示浮层、加 body 类、焦点进输入框', function () {
  const q = makeQuick();
  q.handle.open();
  assert.strictEqual(q.handle.isOpen(), true);
  assert.strictEqual(q.root.hidden, false);
  assert.strictEqual(q.doc.body.classList.contains('quickopen-open'), true);
  assert.strictEqual(q.doc.activeElement, q.input);
});

test('open：幂等——第二次不再清空、也不再发查询', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  q.input.value = 'abc';
  q.handle.open();
  await tick();
  assert.strictEqual(q.input.value, 'abc');
  assert.deepStrictEqual(q.search.calls, [['', true]]);
});

test('open：先关掉设置覆盖层（同一时刻只留一层）', function () {
  const q = makeQuick();
  let closed = 0;
  q.mod.settings.registerOverlay('settings', { close: function () { closed += 1; } });
  q.handle.open();
  assert.strictEqual(closed, 1);
  assert.strictEqual(q.mod.settings.currentFocusOwner(), 'quick-open');
});

test('open：清空上一轮的输入、结果与选中（⛔ 上次搜的词还在）', async function () {
  const q = makeQuick({ defaultResp: response([entry('a')]) });
  q.handle.open();
  await tick();
  assert.strictEqual(q.handle.count(), 1);
  q.handle.close();
  q.input.value = 'old';
  q.handle.open();
  await tick();
  assert.strictEqual(q.input.value, '', 'open 主动清空输入');
  assert.strictEqual(q.handle.selected(), 0, '新一轮结果的第一条被选中');
});

test('刷新键：从 keymap 绑定表里认出 Cmd+R，并带 rebuild=true 重查', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  const ev = q.key({ key: 'r', metaKey: true });
  await tick();
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(ev.propagationStopped, true);
  assert.deepStrictEqual(q.search.calls, [['', true], ['', true]]);
});

test('刷新键：Ctrl+R 不是同一个键（不偷别名）', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  const ev = q.key({ key: 'r', ctrlKey: true });
  await tick();
  assert.strictEqual(ev.defaultPrevented, false);
  assert.strictEqual(q.search.calls.length, 1);
});

test('刷新键：按下期间说明行写"重建索引中"', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  q.search.hang = true;
  q.key({ key: 'r', metaKey: true });
  assert.strictEqual(q.noteText(), 'qo.rebuilding');
});

test('刷新键：没有任何绑定命中时放行普通字符（要能正常输入）', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  const ev = q.key({ key: 'a' });
  assert.strictEqual(ev.defaultPrevented, false);
  assert.strictEqual(ev.propagationStopped, false);
  assert.strictEqual(q.search.calls.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0058（Cmd-点击链接不打开）
//
// 列表行只有"点中了哪一行"这一个判据：⛔ 不判修饰键、⛔ 不另开一条
// "⌘+点击在新窗口打开"的路（本应用没有标签页/窗口语义）。
// ─────────────────────────────────────────────────────────────────────────

test('点击：点结果行先关浮层，再把 realPath 交给 onPick（⛔ 挡着等打开）', async function () {
  const q = makeQuick({
    defaultResp: response([
      entry('a', 'dir/a', '/r/dir/a'),
      entry('b', 'dir/b', '/r/dir/b'),
    ]),
  });
  q.handle.open();
  await tick();
  q.clickRow(1);
  assert.deepStrictEqual(q.picked, [{ path: '/r/dir/b', open: false }]);
  assert.strictEqual(q.handle.isOpen(), false);
});

test('点击：⌘+点击结果行仍是普通打开（列表行不分支修饰键）', async function () {
  const q = makeQuick({ defaultResp: response([entry('a', 'a', '/r/a')]) });
  q.handle.open();
  await tick();
  const ev = { target: q.rows()[0], metaKey: true };
  q.list.dispatch('click', ev);
  assert.strictEqual(ev.defaultPrevented, false, '列表行不抢原生点击语义');
  assert.deepStrictEqual(q.picked, [{ path: '/r/a', open: false }]);
});

test('点击：点在行外是空操作（⛔ 按 index=-1 去打开）', async function () {
  const q = makeQuick({ defaultResp: response([entry('a')]) });
  q.handle.open();
  await tick();
  q.list.dispatch('click', { target: q.note });
  assert.strictEqual(q.picked.length, 0);
  assert.strictEqual(q.handle.isOpen(), true);
});

test('悬停：移到第 2 行只改选中项，不重建整张表', async function () {
  const q = makeQuick({
    defaultResp: response([entry('a'), entry('b'), entry('c')]),
  });
  q.handle.open();
  await tick();
  const rows = q.rows();
  q.moveTo(2);
  assert.strictEqual(q.handle.selected(), 2);
  assert.strictEqual(rows[2].classList.contains('selected'), true);
  assert.strictEqual(rows[0].classList.contains('selected'), false);
  assert.strictEqual(rows[2].getAttribute('aria-selected'), 'true');
  assert.strictEqual(rows[0].getAttribute('aria-selected'), 'false');
  assert.strictEqual(q.input.getAttribute('aria-activedescendant'), 'quickopen-item-2');
});

test('悬停：同一行重复移入不重复滚动（renderSelection 有变化才做）', async function () {
  const q = makeQuick({ defaultResp: response([entry('a'), entry('b')]) });
  q.handle.open();
  await tick();
  const rows = q.rows();
  q.moveTo(1);
  const first = rows[1].scrolls;
  q.moveTo(1);
  assert.strictEqual(rows[1].scrolls, first, '同一行不该再次 scrollIntoView');
});

test('悬停：移出行外不改选中项', async function () {
  const q = makeQuick({ defaultResp: response([entry('a'), entry('b')]) });
  q.handle.open();
  await tick();
  q.list.dispatch('mousemove', { target: q.note });
  assert.strictEqual(q.handle.selected(), 0);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0107（编辑面的静默失败）
//
// 同一条纪律：失败必须有可见说法；迟到的响应不许写进已经关掉的界面。
// ─────────────────────────────────────────────────────────────────────────

test('出错：说明行写 qo.error 的可见理由，并上报给 onError', async function () {
  const q = makeQuick();
  q.search.defaultResp = new Error('索引读不出来');
  q.handle.open();
  await tick();
  assert.strictEqual(q.noteText(), 'qo.error(msg=索引读不出来)');
  assert.strictEqual(q.errors.length, 1);
  assert.strictEqual(q.errors[0].message, '索引读不出来');
});

test('出错：没有 message 时退回 error 本身（⛔ 写 undefined）', async function () {
  const q = makeQuick();
  const boom = new Error('');
  boom.message = '';
  q.search.defaultResp = boom;
  q.handle.open();
  await tick();
  assert.strictEqual(q.noteText(), 'qo.error(msg=Error)');
});

test('出错：已经有结果的旧列表不会被清空（只有说明行变红）', async function () {
  const q = makeQuick({ defaultResp: response([entry('a')]) });
  q.handle.open();
  await tick();
  q.search.queue.push(new Error('第二次失败'));
  q.type('a');
  await tick();
  assert.strictEqual(q.handle.count(), 1, '旧结果留着，等用户重试');
  assert.strictEqual(q.handle.selected(), 0);
});

test('关闭后到达的成功响应不写进隐藏浮层', async function () {
  const q = makeQuick();
  q.search.hang = true;
  q.handle.open();
  q.handle.close();
  q.search.pending.shift()(response([entry('a')]));
  await tick();
  assert.strictEqual(q.handle.count(), 0);
  assert.strictEqual(q.rows().length, 0);
});

test('关闭后到达的失败响应不弹提示、也不写说明行', async function () {
  const q = makeQuick();
  q.search.hang = true;
  q.handle.open();
  const before = q.noteText();
  q.handle.close();
  q.search.pending.shift()(Promise.reject(new Error('迟到')));
  await tick();
  assert.strictEqual(q.errors.length, 0);
  assert.strictEqual(q.noteText(), before);
});

// ─────────────────────────────────────────────────────────────────────────
// 提交 / 丢弃：`decision` 的四种分支
// ─────────────────────────────────────────────────────────────────────────

test('commit：结果落入列表，第一条自动选中并写 aria-activedescendant', async function () {
  const q = makeQuick({
    defaultResp: response([entry('alpha', 'dir/alpha', '/r/dir/alpha'), entry('beta')]),
  });
  q.handle.open();
  await tick();
  assert.strictEqual(q.handle.count(), 2);
  assert.strictEqual(q.handle.selected(), 0);
  const rows = q.rows();
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].id, 'quickopen-item-0');
  assert.strictEqual(rows[0].getAttribute('role'), 'option');
  assert.strictEqual(rows[0].getAttribute('aria-selected'), 'true');
  assert.strictEqual(rows[0].classList.contains('selected'), true);
  assert.strictEqual(q.input.getAttribute('aria-activedescendant'), 'quickopen-item-0');
});

test('commit：命中区间切成 mark，其余是纯文本', async function () {
  const q = makeQuick({ defaultResp: response([entry('abcd', 'abcd', '/r/abcd', [[1, 3]])]) });
  q.handle.open();
  await tick();
  const name = q.rows()[0].querySelector('.quickopen-name');
  assert.strictEqual(name.textContent, 'abcd');
  const marks = name.querySelectorAll('.quickopen-hit');
  assert.strictEqual(marks.length, 1);
  assert.strictEqual(marks[0].textContent, 'bc');
  assert.strictEqual(name.children[0].textContent, 'a');
  assert.strictEqual(name.children[2].textContent, 'd');
});

test('commit：相对路径只在不同于文件名时显示（⛔ 重复两遍）', async function () {
  const q = makeQuick({
    defaultResp: response([
      entry('a', 'dir/a', '/r/dir/a'),
      entry('b', 'b', '/r/b'),
    ]),
  });
  q.handle.open();
  await tick();
  const rows = q.rows();
  assert.strictEqual(rows[0].querySelector('.quickopen-rel').textContent, 'dir/a');
  assert.strictEqual(rows[1].querySelector('.quickopen-rel'), null);
});

test('commit：0 条且输入为空时显示「输入以搜索」空态，不报"没搜到"', async function () {
  const q = makeQuick({ defaultResp: response([]) });
  q.handle.open();
  await tick();
  assert.strictEqual(q.rows().length, 0);
  assert.strictEqual(q.empty().textContent, 'qo.empty-hint');
  assert.strictEqual(q.input.getAttribute('aria-activedescendant'), null);
});

test('commit：0 条且已有输入时显示 search.none（与搜索面同一句）', async function () {
  const q = makeQuick({ defaultResp: response([]) });
  q.handle.open();
  await tick();
  q.input.value = 'zzz';
  q.type('zzz');
  await tick();
  assert.strictEqual(q.empty().textContent, 'search.none');
});

test('gen（切根）：清空旧结果与选中，⛔ 留着上一个根的文件', async function () {
  const q = makeQuick({ defaultResp: response([entry('a'), entry('b')]) });
  q.handle.open();
  await tick();
  q.search.queue.push(response([], { commit: false, reason: 'gen' }));
  q.type('a');
  await tick();
  assert.strictEqual(q.handle.count(), 0);
  assert.strictEqual(q.handle.selected(), -1);
  assert.strictEqual(q.rows().length, 0);
});

test('empty（空模式）：清空旧结果，不把它当"没搜到"', async function () {
  const q = makeQuick({ defaultResp: response([entry('a')]) });
  q.handle.open();
  await tick();
  q.search.queue.push(response([], { commit: false, reason: 'empty' }));
  q.type('');
  await tick();
  assert.strictEqual(q.handle.count(), 0);
  assert.strictEqual(q.handle.selected(), -1);
  assert.strictEqual(q.empty().textContent, 'qo.empty-hint');
});

test('shape（响应读不懂）：清空，但也不假装有结果', async function () {
  const q = makeQuick({ defaultResp: response([entry('a')]) });
  q.handle.open();
  await tick();
  q.search.queue.push(response([], { commit: false, reason: 'shape' }));
  q.type('a');
  await tick();
  assert.strictEqual(q.handle.count(), 0);
  assert.strictEqual(q.handle.selected(), -1);
  assert.strictEqual(q.rows().length, 0);
});

test('req（旧请求）：结果保持不动，等新请求回来覆盖', async function () {
  const q = makeQuick({ defaultResp: response([entry('a'), entry('b')]) });
  q.handle.open();
  await tick();
  q.search.queue.push(response([], { commit: false, reason: 'req' }));
  q.type('a');
  await tick();
  assert.strictEqual(q.handle.count(), 2);
  assert.strictEqual(q.handle.selected(), 0);
});

test('未知 reason：同样什么都不做（⛔ 清空兜底）', async function () {
  const q = makeQuick({ defaultResp: response([entry('a')]) });
  q.handle.open();
  await tick();
  q.search.queue.push(response([], { commit: false, reason: '???' }));
  q.type('a');
  await tick();
  assert.strictEqual(q.handle.count(), 1);
});

// ─────────────────────────────────────────────────────────────────────────
// 说明行：条数 / 索引年龄 / 刷新提示，都现算
// ─────────────────────────────────────────────────────────────────────────

test('说明行：有输入时用 search.summaryText 报条数与索引年龄', async function () {
  const q = makeQuick({
    defaultResp: response([entry('a'), entry('b')], { commit: true }, { builtAtMs: 0 }),
  });
  q.handle.open();
  await tick();
  q.input.value = 'a';
  q.type('a');
  await tick();
  assert.strictEqual(q.noteText(), 'search.count(n=2) · search.index-age(age=search.age-now)');
});

test('说明行：空输入时不报"没搜到"，仅报索引已备好', async function () {
  const q = makeQuick({ defaultResp: response([], { commit: true }, { builtAtMs: 0 }) });
  q.handle.open();
  await tick();
  assert.strictEqual(q.noteText(), 'qo.index-ready(age=search.age-now)');
});

test('说明行：刷新键提示来自 keyText，⛔ 本文件不写键位字面量', async function () {
  const q = makeQuick({ keyText: function () { return '⌘R'; } });
  q.handle.open();
  await tick();
  assert.strictEqual(q.noteText(), 'qo.index-ready(age=search.age-now) · qo.refresh-hint(key=⌘R)');
});

test('说明行：keyText 返回空串时不出现空提示段', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  assert.strictEqual(q.noteText(), 'qo.index-ready(age=search.age-now)');
});

test('说明行：查询还没回来、也没有上一轮结果时显示"建索引中"', function () {
  const q = makeQuick();
  q.search.hang = true;
  q.handle.open();
  assert.strictEqual(q.noteText(), 'qo.building');
});

test('输入：每次 input 都发一次查询，rebuild=false（不重建索引）', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  q.type('abc');
  await tick();
  assert.deepStrictEqual(q.search.calls, [['', true], ['abc', false]]);
});

test('输入：前端不 trim（空模式由后端裁定，⛔ 两份判据）', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  q.type('   ');
  await tick();
  assert.deepStrictEqual(q.search.calls[1], ['   ', false]);
});

// ─────────────────────────────────────────────────────────────────────────
// 键盘：↑↓ 环绕、Enter、Esc、Tab（本层自己的，⛔ 与全局分发器重叠）
// ─────────────────────────────────────────────────────────────────────────

test('↓：从最后一条绕回第一条', async function () {
  const q = makeQuick({ defaultResp: response([entry('a'), entry('b')]) });
  q.handle.open();
  await tick();
  q.key({ key: 'ArrowDown' });
  assert.strictEqual(q.handle.selected(), 1);
  q.key({ key: 'ArrowDown' });
  assert.strictEqual(q.handle.selected(), 0, '环绕');
});

test('↑：从第一条绕到最后一条', async function () {
  const q = makeQuick({ defaultResp: response([entry('a'), entry('b'), entry('c')]) });
  q.handle.open();
  await tick();
  q.key({ key: 'ArrowUp' });
  assert.strictEqual(q.handle.selected(), 2);
});

test('↑↓：吃掉事件并阻止冒泡（树也处理方向键）', async function () {
  const q = makeQuick({ defaultResp: response([entry('a'), entry('b')]) });
  q.handle.open();
  await tick();
  const ev = q.key({ key: 'ArrowDown' });
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(ev.propagationStopped, true);
});

test('↑↓：没有结果时不动选中（-1 保持 -1）', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  const ev = q.key({ key: 'ArrowDown' });
  assert.strictEqual(q.handle.selected(), -1);
  assert.strictEqual(ev.defaultPrevented, true, '仍然吃掉，避免下层误动');
});

test('Enter：先关浮层再 onPick 选中的那条', async function () {
  const q = makeQuick({ defaultResp: response([entry('a', 'a', '/r/a'), entry('b', 'b', '/r/b')]) });
  q.handle.open();
  await tick();
  q.key({ key: 'ArrowDown' });
  const ev = q.key({ key: 'Enter' });
  assert.strictEqual(ev.defaultPrevented, true);
  assert.deepStrictEqual(q.picked, [{ path: '/r/b', open: false }]);
  assert.strictEqual(q.handle.isOpen(), false);
});

test('Enter：没有选中项时不打开任何东西，也不关浮层', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  q.key({ key: 'Enter' });
  assert.strictEqual(q.picked.length, 0);
  assert.strictEqual(q.handle.isOpen(), true);
});

test('Esc：关浮层、吃掉事件', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  const ev = q.key({ key: 'Escape' });
  assert.strictEqual(q.handle.isOpen(), false);
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(ev.propagationStopped, true);
});

test('Tab：始终把焦点收回输入框（这一层只有它可聚焦）', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  const outside = q.doc.createElement('button');
  q.doc.body.appendChild(outside);
  outside.focus();
  const ev = q.key({ key: 'Tab' });
  assert.strictEqual(q.doc.activeElement, q.input);
  assert.strictEqual(ev.defaultPrevented, true);
});

test('键盘：浮层关着时全部放行（监听还在，但不动）', async function () {
  const q = makeQuick();
  const ev = q.key({ key: 'Escape' });
  assert.strictEqual(ev.defaultPrevented, false);
  assert.strictEqual(q.handle.isOpen(), false);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0063（组合去重标记跨动作吞掉真实输入）
//
// 同族纪律：IME 正在组合时，回车是"上屏"、方向键是"翻候选"，
// ⛔ 不能当成浮层动作。这条判据住在 keymap 里，浮层只转调。
// ─────────────────────────────────────────────────────────────────────────

test('组合态：isComposing=true 时回车不打开文件', async function () {
  const q = makeQuick({ defaultResp: response([entry('a', 'a', '/r/a')]) });
  q.handle.open();
  await tick();
  const ev = q.key({ key: 'Enter', isComposing: true });
  assert.strictEqual(q.picked.length, 0);
  assert.strictEqual(q.handle.isOpen(), true);
  assert.strictEqual(ev.defaultPrevented, false);
});

test('组合态：老 WebKit 的 keyCode 229 同样挡住方向键', async function () {
  const q = makeQuick({ defaultResp: response([entry('a'), entry('b')]) });
  q.handle.open();
  await tick();
  q.key({ key: 'ArrowDown', keyCode: 229 });
  assert.strictEqual(q.handle.selected(), 0);
});

test('组合态：Esc 也被挡住（先让输入法取消候选）', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  q.key({ key: 'Escape', isComposing: true });
  assert.strictEqual(q.handle.isOpen(), true);
});

// ─────────────────────────────────────────────────────────────────────────
// 开 / 关 / 拆：焦点归还与登记处
// ─────────────────────────────────────────────────────────────────────────

test('close：把焦点还给打开前的元素', async function () {
  const q = makeQuick();
  const before = q.doc.createElement('button');
  q.doc.body.appendChild(before);
  before.focus();
  q.handle.open();
  await tick();
  q.handle.close();
  assert.strictEqual(q.doc.activeElement, before);
});

test('close：摘掉 body 类；没打开时是空操作', async function () {
  const q = makeQuick();
  q.handle.close();
  assert.strictEqual(q.doc.activeElement, q.doc.body);
  q.handle.open();
  q.handle.close();
  assert.strictEqual(q.doc.body.classList.contains('quickopen-open'), false);
});

test('close：只释放自己的焦点主人身份', async function () {
  const q = makeQuick();
  q.handle.open();
  assert.strictEqual(q.mod.settings.currentFocusOwner(), 'quick-open');
  q.handle.close();
  assert.strictEqual(q.mod.settings.currentFocusOwner(), null);
});

test('close：遮罩点击关闭（点面板本身不关）', async function () {
  const q = makeQuick();
  q.handle.open();
  q.panel.dispatch('click', {});
  assert.strictEqual(q.handle.isOpen(), true);
  q.root.querySelector('.quickopen-scrim').dispatch('click', {});
  assert.strictEqual(q.handle.isOpen(), false);
});

test('open：先 render 再显示，首帧不是空白（标题/输入框/列表已挂上）', function () {
  const q = makeQuick();
  q.handle.open();
  assert.strictEqual(q.root.querySelector('.quickopen-title').getAttribute('data-i18n'), 'qo.title');
  assert.strictEqual(q.input.getAttribute('role'), 'combobox');
  assert.strictEqual(q.input.getAttribute('aria-controls'), 'quickopen-list');
  assert.strictEqual(q.list.getAttribute('role'), 'listbox');
});

test('destroy：摘掉 document 上的键盘监听', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  q.handle.destroy();
  q.key({ key: 'Escape' });
  assert.strictEqual(q.handle.isOpen(), true, '监听没摘掉的话这里会被关掉');
});

test('destroy：把 DOM 从 body 摘掉', function () {
  const q = makeQuick();
  assert.ok(q.root.parentNode);
  q.handle.destroy();
  assert.strictEqual(q.root.parentNode, null);
});

test('⚠️ 疑似缺陷：destroy 不注销覆盖层登记处', async function () {
  const q = makeQuick();
  let calls = 0;
  const orig = q.handle.close;
  q.handle.close = function () { calls += 1; return orig.apply(this, arguments); };
  q.handle.destroy();
  q.mod.settings.closeOtherOverlays('other');
  assert.strictEqual(calls, 1, '当前实现没有注销；修好后这里应变成 0');
});

test('⚠️ 疑似缺陷：开着时 destroy 不摘 body.quickopen-open', function () {
  const q = makeQuick();
  q.handle.open();
  q.handle.destroy();
  assert.strictEqual(q.doc.body.classList.contains('quickopen-open'), true);
});

test('⚠️ 疑似缺陷：destroy 不退订 i18n（已拆的节点仍被重画）', function () {
  const q = makeQuick();
  q.search.hang = true;
  q.handle.open();
  assert.strictEqual(q.noteText(), 'qo.building');
  q.handle.destroy();
  q.i18n.set('qo.building', '重建中');
  q.i18n.emit();
  assert.strictEqual(q.noteText(), '重建中', '当前仍被订阅；修好后应保持旧值');
});

test('切语言：说明行按配方现算重贴，⛔ 缓存已经算好的句子', async function () {
  const q = makeQuick({
    keyText: function () { return '⌘R'; },
    defaultResp: response([], { commit: false, reason: 'req' }),
  });
  q.handle.open();
  await tick();
  assert.strictEqual(q.noteText(), 'qo.building · qo.refresh-hint(key=⌘R)');
  q.i18n.set('qo.refresh-hint', 'REFRESH');
  q.i18n.emit();
  assert.strictEqual(q.noteText(), 'qo.building · REFRESH(key=⌘R)');
});

test('切语言：空态那句也给重贴（renderList 的现算文案）', async function () {
  const q = makeQuick();
  q.handle.open();
  await tick();
  assert.strictEqual(q.empty().textContent, 'qo.empty-hint');
  q.i18n.set('qo.empty-hint', '输入点什么');
  q.i18n.emit();
  assert.strictEqual(q.empty().textContent, '输入点什么');
});
