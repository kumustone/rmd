// SidebarSearch（`src/components/SidebarSearch.js`）组件层回归用例。
//
// 三分支（清空 / 查询且首次重建 / 只查不重建）与选中移动的**接线**在这里守；
// 纯判据本体在 `services/sidebarsearch.js`（另有 services 族用例）。
// 后端 `searchFiles` 用假实现，⛔ 不启动 app、不联网。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const read = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };
function loadInto(win, rel) {
  new Function('window', 'module', 'require', read(rel))(win, undefined, undefined);
}

// ── 最小假 DOM ────────────────────────────────────────────────────────────

let doc = null;

function classSet() {
  const set = new Set();
  return {
    add: function (c) { set.add(c); },
    remove: function (c) { set.delete(c); },
    contains: function (c) { return set.has(c); },
    toggle: function (c, on) { if (on) set.add(c); else set.delete(c); },
    _set: set,
  };
}
function matchOne(node, sel) {
  if (!node || node.nodeType !== 1) return false;
  const m = /^([a-zA-Z0-9-]+)?((?:\.[a-zA-Z0-9_-]+)*)(\[[a-zA-Z0-9_-]+\])?$/.exec(String(sel).trim());
  if (!m) return false;
  const tag = (m[1] || '').toLowerCase();
  if (tag && node.tagName.toLowerCase() !== tag) return false;
  const cls = (m[2] || '').split('.').filter(Boolean);
  for (let i = 0; i < cls.length; i++) if (!node.classList.contains(cls[i])) return false;
  if (m[3] && !node.hasAttribute(m[3].slice(1, -1))) return false;
  return true;
}
function makeTextNode(text) {
  return {
    nodeType: 3, nodeName: '#text', nodeValue: String(text == null ? '' : text),
    parentNode: null, childNodes: [],
    get textContent() { return this.nodeValue; },
    set textContent(v) { this.nodeValue = String(v); },
    remove: function () { if (this.parentNode) this.parentNode.removeChild(this); },
  };
}
function makeElement(tag) {
  const n = {
    nodeType: 1, tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(),
    style: {}, hidden: false, value: '', id: '', tabIndex: -1,
    _attrs: Object.create(null), _listeners: Object.create(null), childNodes: [], parentNode: null,
    blurCalls: 0,
  };
  n.classList = classSet();
  n.dataset = new Proxy(n._attrs, {
    get: function (t, prop) {
      if (typeof prop !== 'string') return undefined;
      return t['data-' + prop.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); })];
    },
    set: function (t, prop, v) {
      if (typeof prop === 'string') {
        t['data-' + prop.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); })] = String(v);
      }
      return true;
    },
    deleteProperty: function (t, prop) {
      if (typeof prop === 'string') {
        delete t['data-' + prop.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); })];
      }
      return true;
    },
  });
  Object.defineProperty(n, 'className', {
    get: function () { return Array.from(n.classList._set).join(' '); },
    set: function (v) {
      n.classList._set.clear();
      String(v == null ? '' : v).split(/\s+/).forEach(function (c) { if (c) n.classList._set.add(c); });
    },
  });
  Object.defineProperty(n, 'children', {
    get: function () { return n.childNodes.filter(function (c) { return c.nodeType === 1; }); },
  });
  Object.defineProperty(n, 'textContent', {
    get: function () { return n.childNodes.map(function (c) { return c.textContent; }).join(''); },
    set: function (v) {
      const s = String(v == null ? '' : v);
      for (let i = 0; i < n.childNodes.length; i++) n.childNodes[i].parentNode = null;
      n.childNodes.length = 0;
      if (s !== '') n.appendChild(makeTextNode(s));
    },
  });
  n.appendChild = function (c) {
    if (c.parentNode) c.remove();
    c.parentNode = n; n.childNodes.push(c); return c;
  };
  n.removeChild = function (c) {
    const i = n.childNodes.indexOf(c);
    if (i >= 0) n.childNodes.splice(i, 1);
    c.parentNode = null; return c;
  };
  n.remove = function () { if (n.parentNode) n.parentNode.removeChild(n); };
  n.setAttribute = function (k, v) { n._attrs[k] = String(v); };
  n.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(n._attrs, k) ? n._attrs[k] : null; };
  n.hasAttribute = function (k) { return Object.prototype.hasOwnProperty.call(n._attrs, k); };
  n.removeAttribute = function (k) { delete n._attrs[k]; };
  n.addEventListener = function (type, fn) {
    const list = n._listeners[type] || (n._listeners[type] = []);
    if (list.indexOf(fn) < 0) list.push(fn);
  };
  n.removeEventListener = function (type, fn) {
    const list = n._listeners[type] || []; const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  n.fire = function (type, ev) {
    const e = ev || {};
    if (typeof e.preventDefault !== 'function') e.preventDefault = function () { e.defaultPrevented = true; };
    if (typeof e.stopPropagation !== 'function') e.stopPropagation = function () { e._stopped = true; };
    if (typeof e.defaultPrevented !== 'boolean') e.defaultPrevented = false;
    const list = (n._listeners[type] || []).slice();
    for (let i = 0; i < list.length; i++) list[i](e);
    return e;
  };
  n.contains = function (x) { let p = x; while (p) { if (p === n) return true; p = p.parentNode; } return false; };
  n.closest = function (sel) { let p = n; while (p) { if (matchOne(p, sel)) return p; p = p.parentNode; } return null; };
  n.querySelectorAll = function (sel) {
    const out = [];
    (function walk(x) {
      for (let i = 0; i < x.childNodes.length; i++) {
        const c = x.childNodes[i];
        if (c.nodeType === 1) { if (matchOne(c, sel)) out.push(c); walk(c); }
      }
    })(n);
    return out;
  };
  n.querySelector = function (sel) { const all = n.querySelectorAll(sel); return all.length ? all[0] : null; };
  n.focus = function () { if (doc) doc.activeElement = n; };
  n.blur = function () {
    n.blurCalls += 1;
    if (doc && doc.activeElement === n) doc.activeElement = doc.body;
  };
  return n;
}

function makeDocument() {
  const body = makeElement('body');
  const d = {
    body: body, documentElement: makeElement('html'), activeElement: body,
    createElement: makeElement, createTextNode: makeTextNode,
    contains: function (n) { return body.contains(n); },
    querySelector: function (sel) { return body.querySelector(sel); },
    querySelectorAll: function (sel) { return body.querySelectorAll(sel); },
    addEventListener: function () {}, removeEventListener: function () {},
  };
  body.parentNode = d;
  return d;
}

function fresh() {
  doc = makeDocument();
  global.document = doc;
  const win = {
    rmd: {}, __rmdLang: 'zh', document: doc,
    innerWidth: 1000, innerHeight: 700,
    addEventListener: function () {}, removeEventListener: function () {},
  };
  loadInto(win, 'src/services/i18n.js');
  loadInto(win, 'src/services/keymap.js');
  loadInto(win, 'src/services/search.js');
  loadInto(win, 'src/services/sidebarsearch.js');
  loadInto(win, 'src/components/SidebarSearch.js');
  return win;
}

/** 假 `search(pattern, rebuild)`：测试决定何时回包。 */
function makeSearch() {
  const calls = [];
  const pending = [];
  function search(pattern, rebuild) {
    const call = { pattern: pattern, rebuild: !!rebuild };
    calls.push(call);
    return new Promise(function (resolve, reject) {
      pending.push({ call: call, resolve: resolve, reject: reject });
    });
  }
  return { calls: calls, pending: pending, search: search };
}

function itemsOf(names, rels) {
  return names.map(function (name, i) {
    const rel = rels && rels[i] != null ? rels[i] : '';
    return { name: name, rel: rel, realPath: '/r/' + name, spans: [] };
  });
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function mounted(over) {
  const win = fresh();
  const bar = makeElement('div');
  const input = makeElement('input');
  const pane = makeElement('div');
  bar.appendChild(input);
  doc.body.appendChild(bar);
  doc.body.appendChild(pane);
  const stub = makeSearch();
  const calls = { picks: [], active: [], errors: [] };
  const opts = Object.assign({
    els: { bar: bar, input: input, pane: pane },
    search: stub.search,
    onPick: function (p) { calls.picks.push(p); },
    onActiveChange: function (on) { calls.active.push(on); },
    onError: function (e) { calls.errors.push(e); },
    keymap: { bindings: [{ id: 'files.refresh', accel: 'Cmd+R', display: '⌘R' }] },
    refreshId: 'files.refresh',
  }, over || {});
  const ss = win.rmd.sidebarSearch.createSidebarSearch(opts);
  return {
    win: win, doc: doc, bar: bar, input: input, pane: pane,
    stub: stub, ss: ss, calls: calls, opts: opts,
  };
}

function rowEls(pane) { return pane.querySelectorAll('.sidebar-search-item'); }
function noteText(pane) { return pane.querySelector('.sidebar-search-note').textContent; }
function type(m, value) {
  m.input.value = value;
  m.input.fire('input', {});
}
function key(m, k, extra) {
  return m.input.fire('keydown', Object.assign({ key: k }, extra || {}));
}
function commitPayload(entries, over) {
  return {
    result: Object.assign({
      entries: entries || [],
      totalHits: (entries || []).length,
      truncated: false,
      builtAtMs: undefined,
    }, over && over.result || {}),
    decision: Object.assign({ commit: true, reason: null }, over && over.decision || {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0019（其他程序在目录里新增文档，目录树里不出现（手动刷新也没用））
// 教训：第一次输入必须强制重建索引，之后只查不重建；三分支错一个都是静默的。
// ═══════════════════════════════════════════════════════════════════════════

test('首次输入：先进入搜索态，并向后端要 rebuild=true', function () {
  const m = mounted({});
  type(m, 'rea');
  assert.strictEqual(m.ss.isActive(), true);
  assert.deepStrictEqual(m.stub.calls, [{ pattern: 'rea', rebuild: true }]);
  assert.deepStrictEqual(m.calls.active, [true]);
  assert.strictEqual(noteText(m.pane), '正在建索引…');
});

test('持续输入：只查不重建（⛔ 每键一次全树遍历）', function () {
  const m = mounted({});
  type(m, 'r');
  type(m, 're');
  type(m, 'rea');
  assert.deepStrictEqual(m.stub.calls.map(function (c) { return c.rebuild; }), [true, false, false]);
});

test('输入被清空：不发 IPC，退出搜索态', function () {
  const m = mounted({});
  type(m, 'r');
  type(m, '');
  assert.strictEqual(m.stub.calls.length, 1);
  assert.strictEqual(m.ss.isActive(), false);
  assert.deepStrictEqual(m.calls.active, [true, false]);
});

test('纯空白同样收起（与空串同一条判据）', function () {
  const m = mounted({});
  type(m, '   ');
  assert.strictEqual(m.stub.calls.length, 0);
  assert.strictEqual(m.ss.isActive(), false);
});

test('清空之后重新输入：又是一次 rebuild=true', function () {
  const m = mounted({});
  type(m, 'a');
  type(m, '');
  type(m, 'b');
  assert.deepStrictEqual(m.stub.calls.map(function (c) { return c.rebuild; }), [true, true]);
});

test('setActive 幂等：同一个值不重复通知', function () {
  const m = mounted({});
  m.ss.setActive(true);
  m.ss.setActive(true);
  m.ss.setActive(false);
  m.ss.setActive(false);
  assert.deepStrictEqual(m.calls.active, [true, false]);
});

test('setActive(false) 清空结果、选中与说明', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  assert.strictEqual(rowEls(m.pane).length, 1);
  m.ss.setActive(false);
  assert.strictEqual(rowEls(m.pane).length, 0);
  assert.strictEqual(m.ss.count(), 0);
  assert.strictEqual(m.ss.selected(), -1);
  assert.strictEqual(noteText(m.pane), '');
});

test('setActive(true) 本身不发查询、也不画行', function () {
  const m = mounted({});
  m.ss.setActive(true);
  assert.strictEqual(m.stub.calls.length, 0);
  assert.strictEqual(rowEls(m.pane).length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
// 教训：迟到的回包只许“什么都不做”；是否落地由 decision 说了算。
// ═══════════════════════════════════════════════════════════════════════════

test('commit：渲染全部条目，默认选中第一条', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md', 'ab.md'])));
  await flush();
  const rows = rowEls(m.pane);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(m.ss.count(), 2);
  assert.strictEqual(m.ss.selected(), 0);
  assert.strictEqual(rows[0].getAttribute('aria-selected'), 'true');
  assert.strictEqual(rows[1].getAttribute('aria-selected'), 'false');
  assert.strictEqual(m.input.getAttribute('aria-activedescendant'), 'sidebar-search-item-0');
});

test('commit：说明行给出条数', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md', 'ab.md'])));
  await flush();
  assert.strictEqual(noteText(m.pane), '2 条');
});

test('commit：截断时说明“显示前 X 条（共 Y 条）”', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md']), { result: { totalHits: 9, truncated: true } }));
  await flush();
  assert.strictEqual(noteText(m.pane), '显示前 1 条（共 9 条）');
});

test('commit：索引年龄跟在说明后面（结果可能过期的可见提示）', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md']), { result: { builtAtMs: 500 } }));
  await flush();
  assert.strictEqual(noteText(m.pane), '1 条 · 索引 刚刚');
});

test('commit：没有任何命中 ⇒ 空态一句，选中 -1', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload([]));
  await flush();
  assert.strictEqual(rowEls(m.pane).length, 0);
  assert.strictEqual(m.ss.selected(), -1);
  assert.strictEqual(m.pane.querySelector('.sidebar-search-empty').textContent, '没有匹配的文件名');
  assert.strictEqual(m.input.getAttribute('aria-activedescendant'), null);
  assert.strictEqual(noteText(m.pane), '没有匹配的文件名');
});

test('commit：重新查询后选中项回到第一条（⛔ 留在旧下标）', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md', 'b.md', 'c.md'])));
  await flush();
  key(m, 'ArrowDown');
  key(m, 'ArrowDown');
  assert.strictEqual(m.ss.selected(), 2);
  type(m, 'ab');
  m.stub.pending[1].resolve(commitPayload(itemsOf(['ab.md'])));
  await flush();
  assert.strictEqual(m.ss.selected(), 0);
});

test('decision.reason=req（旧请求）⇒ 什么都不做（不清空、不闪）', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  type(m, 'ab');
  m.stub.pending[1].resolve({ result: null, decision: { commit: false, reason: 'req' } });
  await flush();
  assert.strictEqual(m.ss.count(), 1);
  assert.strictEqual(rowEls(m.pane).length, 1);
  assert.strictEqual(noteText(m.pane), '1 条');
});

test('decision.reason=gen ⇒ 清空旧结果（切根了）', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  type(m, 'ab');
  m.stub.pending[1].resolve({ result: null, decision: { commit: false, reason: 'gen' } });
  await flush();
  assert.strictEqual(m.ss.count(), 0);
  assert.strictEqual(rowEls(m.pane).length, 0);
  assert.strictEqual(noteText(m.pane), '');
});

test('decision.reason=empty ⇒ 清空旧结果', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  type(m, 'ab');
  m.stub.pending[1].resolve({ result: null, decision: { commit: false, reason: 'empty' } });
  await flush();
  assert.strictEqual(m.ss.count(), 0);
});

test('decision.reason=shape ⇒ 清空旧结果', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  type(m, 'ab');
  m.stub.pending[1].resolve({ result: null, decision: { commit: false, reason: 'shape' } });
  await flush();
  assert.strictEqual(m.ss.count(), 0);
});

test('回包到达时已经退出搜索 ⇒ 不往隐藏面板里写', async function () {
  const m = mounted({});
  type(m, 'a');
  m.ss.clear();
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  assert.strictEqual(rowEls(m.pane).length, 0);
  assert.strictEqual(noteText(m.pane), '');
});

// ⚠️ 疑似缺陷：`gen` 分支清空后仍调用 `renderList()`；此时输入框非空且 active，
//    于是列表里会出现“没有匹配的文件名”——但这一支的真实含义是“刚切根，新结果还没到”，
//    把它显示成确定的“没有匹配”会误导用户。钉住现状，待产品确认。
test('⚠️ 疑似缺陷：gen 清空时仍显示“没有匹配的文件名”', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  type(m, 'ab');
  m.stub.pending[1].resolve({ result: null, decision: { commit: false, reason: 'gen' } });
  await flush();
  assert.strictEqual(m.pane.querySelector('.sidebar-search-empty').textContent, '没有匹配的文件名');
});

test('搜索失败：可见说明 + onError + 清空结果', async function () {
  const err = new Error('IPC 断了');
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].reject(err);
  await flush();
  assert.strictEqual(rowEls(m.pane).length, 0);
  assert.strictEqual(noteText(m.pane), '搜索失败：IPC 断了');
  assert.deepStrictEqual(m.calls.errors, [err]);
});

test('搜索失败优先用后端 wording', async function () {
  const err = new Error('js');
  err.wording = '索引不可用';
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].reject(err);
  await flush();
  assert.strictEqual(noteText(m.pane), '搜索失败：索引不可用');
});

test('已经退出搜索时，失败也不上屏、不回调 onError', async function () {
  const m = mounted({});
  type(m, 'a');
  m.ss.clear();
  m.stub.pending[0].reject(new Error('旧请求'));
  await flush();
  assert.strictEqual(noteText(m.pane), '');
  assert.deepStrictEqual(m.calls.errors, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0009（编辑态开着 Vim 时，冒号与斜杠的输入框在「主题 ≠ 系统外观」下是隐形的）
// 同族：输入法组合期间，回车是上屏、上下键是翻候选，⛔ 不是打开/移动选中。
// ═══════════════════════════════════════════════════════════════════════════

test('组合态：Enter ⛔ 不打开、不 preventDefault', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  const ev = key(m, 'Enter', { isComposing: true });
  assert.deepStrictEqual(m.calls.picks, []);
  assert.strictEqual(ev.defaultPrevented, false);
  assert.strictEqual(m.ss.isActive(), true);
});

test('keyCode 229 同样按组合态处理', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  key(m, 'Enter', { keyCode: 229 });
  assert.deepStrictEqual(m.calls.picks, []);
});

test('组合态的 Escape 不清空输入', async function () {
  const m = mounted({});
  type(m, 'a');
  key(m, 'Escape', { isComposing: true });
  assert.strictEqual(m.input.value, 'a');
  assert.strictEqual(m.ss.isActive(), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0097（裸 F2 在 macOS 默认媒体键设置下可能到不了应用）
// 同族：本层只在输入框上解释键，Tab 必须放行；刷新键从后端表里认。
// ═══════════════════════════════════════════════════════════════════════════

test('↓ 移动到下一条并更新 aria-activedescendant', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md', 'b.md'])));
  await flush();
  const ev = key(m, 'ArrowDown');
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(m.ss.selected(), 1);
  assert.strictEqual(m.input.getAttribute('aria-activedescendant'), 'sidebar-search-item-1');
  assert.strictEqual(rowEls(m.pane)[1].getAttribute('aria-selected'), 'true');
  assert.strictEqual(rowEls(m.pane)[0].getAttribute('aria-selected'), 'false');
});

test('↓ 在末尾环绕到第一条；↑ 在开头环绕到最后一条', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md', 'b.md', 'c.md'])));
  await flush();
  key(m, 'ArrowUp');
  assert.strictEqual(m.ss.selected(), 2);
  key(m, 'ArrowDown');
  assert.strictEqual(m.ss.selected(), 0);
});

test('没有结果时方向键不拦截默认行为', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload([]));
  await flush();
  const ev = key(m, 'ArrowDown');
  assert.strictEqual(ev.defaultPrevented, false);
  assert.strictEqual(m.ss.selected(), -1);
});

test('未进入搜索时方向键不拦截', function () {
  const m = mounted({});
  const ev = key(m, 'ArrowDown');
  assert.strictEqual(ev.defaultPrevented, false);
});

test('Enter 打开选中项：清空输入、退出搜索、blur、回调 realPath', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md', 'b.md'])));
  await flush();
  key(m, 'ArrowDown');
  const ev = key(m, 'Enter');
  assert.strictEqual(ev.defaultPrevented, true);
  assert.deepStrictEqual(m.calls.picks, ['/r/b.md']);
  assert.strictEqual(m.input.value, '');
  assert.strictEqual(m.ss.isActive(), false);
  assert.strictEqual(m.input.blurCalls, 1);
});

test('没有选中项（空结果）时 Enter 不动作', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload([]));
  await flush();
  const ev = key(m, 'Enter');
  assert.deepStrictEqual(m.calls.picks, []);
  assert.strictEqual(ev.defaultPrevented, false);
});

test('Escape：有输入时清空并退出', function () {
  const m = mounted({});
  type(m, 'abc');
  const ev = key(m, 'Escape');
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(m.input.value, '');
  assert.strictEqual(m.ss.isActive(), false);
});

test('Escape：已经空且没在搜时只失焦', function () {
  const m = mounted({});
  const ev = key(m, 'Escape');
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(m.input.blurCalls, 1);
});

test('Tab ⛔ 不拦（常驻框必须能把焦点移走）', function () {
  const m = mounted({});
  const ev = key(m, 'Tab');
  assert.strictEqual(ev.defaultPrevented, false);
});

test('刷新键（在搜）：说明改成“正在重建”，并 rebuild=true 重查当前模式', async function () {
  const m = mounted({});
  type(m, 'ab');
  key(m, 'r', { metaKey: true });
  assert.strictEqual(noteText(m.pane), '正在重建索引…');
  assert.deepStrictEqual(m.stub.calls[1], { pattern: 'ab', rebuild: true });
});

test('刷新键（没在搜且输入为空）：只重建索引，不进入搜索态', function () {
  const m = mounted({});
  key(m, 'r', { metaKey: true });
  assert.deepStrictEqual(m.stub.calls[0], { pattern: '', rebuild: true });
  assert.strictEqual(m.ss.isActive(), false);
  assert.strictEqual(noteText(m.pane), '正在重建索引…');
});

test('刷新键（没在搜但输入非空）：先进入搜索态再重建', function () {
  const m = mounted({});
  m.input.value = 'ab';
  key(m, 'r', { metaKey: true });
  assert.strictEqual(m.ss.isActive(), true);
  assert.deepStrictEqual(m.stub.calls[0], { pattern: 'ab', rebuild: true });
});

test('刷新键不匹配（少了 ⌘）⇒ 不动作', function () {
  const m = mounted({});
  type(m, 'ab');
  const ev = key(m, 'r');
  assert.strictEqual(ev.defaultPrevented, false);
  assert.strictEqual(m.stub.calls.length, 1);
});

test('刷新键的“空模式重建”失败也走 onError', async function () {
  const err = new Error('重建失败');
  const m = mounted({});
  key(m, 'r', { metaKey: true });
  m.stub.pending[0].reject(err);
  await flush();
  assert.deepStrictEqual(m.calls.errors, [err]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0068（图里的字比正文大两三倍，而且只有部分图这样）
// 同族：显示层只读已经换算好的值；命中切片的边界错一格就是“高亮了没搜的字”。
// ═══════════════════════════════════════════════════════════════════════════

test('行：命中区间画成 mark，未命中的部分保持文本', async function () {
  const m = mounted({});
  type(m, 'rea');
  const it = { name: 'readme.md', rel: '', realPath: '/r/readme.md', spans: [[0, 3]] };
  m.stub.pending[0].resolve(commitPayload([it]));
  await flush();
  const row = rowEls(m.pane)[0];
  const hits = row.querySelectorAll('.sidebar-search-hit');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].textContent, 'rea');
  assert.strictEqual(row.querySelector('.sidebar-search-name').textContent, 'readme.md');
});

test('行：多个命中各自一段 mark', async function () {
  const m = mounted({});
  type(m, 'a');
  const it = { name: 'a-b-a.md', rel: '', realPath: '/r/a-b-a.md', spans: [[0, 1], [4, 5]] };
  m.stub.pending[0].resolve(commitPayload([it]));
  await flush();
  const hits = rowEls(m.pane)[0].querySelectorAll('.sidebar-search-hit');
  assert.deepStrictEqual(hits.map(function (h) { return h.textContent; }), ['a', 'a']);
});

test('行：相对路径与名字相同 ⇒ 不重复画路径', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload([itemsOf(['a.md'])[0]]));
  await flush();
  assert.strictEqual(rowEls(m.pane)[0].querySelector('.sidebar-search-rel'), null);
});

test('行：相对路径不同 ⇒ 画在名字后面', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload([{
    name: 'a.md', rel: 'notes/a.md', realPath: '/r/notes/a.md', spans: [],
  }]));
  await flush();
  assert.strictEqual(rowEls(m.pane)[0].querySelector('.sidebar-search-rel').textContent, 'notes/a.md');
});

test('行的 id / role 按顺序给，列表是 listbox', function () {
  const m = mounted({});
  assert.strictEqual(m.pane.querySelector('.sidebar-search-list').getAttribute('role'), 'listbox');
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md', 'b.md'])));
  return flush().then(function () {
    const rows = rowEls(m.pane);
    assert.strictEqual(rows[0].id, 'sidebar-search-item-0');
    assert.strictEqual(rows[1].id, 'sidebar-search-item-1');
    assert.strictEqual(rows[0].getAttribute('role'), 'option');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0001（点击文档里的链接，整个应用会重载一遍）
// 同族：列表点击/悬停认的是“哪一行”，不是坐标；选中只改样式，不重建表。
// ═══════════════════════════════════════════════════════════════════════════

test('点击某一行：打开它的 realPath 并退出搜索', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md', 'b.md'])));
  await flush();
  const rows = rowEls(m.pane);
  const list = m.pane.querySelector('.sidebar-search-list');
  list.fire('click', { target: rows[1] });
  assert.deepStrictEqual(m.calls.picks, ['/r/b.md']);
  assert.strictEqual(m.ss.isActive(), false);
  assert.strictEqual(m.input.value, '');
});

test('点击列表空白不动作', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  m.pane.querySelector('.sidebar-search-list').fire('click', { target: m.pane });
  assert.deepStrictEqual(m.calls.picks, []);
});

test('mousemove 只移动选中，不重建表（滚动位置不丢）', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md', 'b.md', 'c.md'])));
  await flush();
  const list = m.pane.querySelector('.sidebar-search-list');
  const rows = rowEls(m.pane);
  list.fire('mousemove', { target: rows[2] });
  assert.strictEqual(m.ss.selected(), 2);
  assert.strictEqual(rowEls(m.pane)[2], rows[2], '悬停重建了行 DOM');
  assert.strictEqual(rows[2].classList.contains('selected'), true);
});

test('mousemove 到同一行不重复改（保持原状）', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md', 'b.md'])));
  await flush();
  const list = m.pane.querySelector('.sidebar-search-list');
  const rows = rowEls(m.pane);
  list.fire('mousemove', { target: rows[0] });
  assert.strictEqual(m.ss.selected(), 0);
  list.fire('mousemove', { target: rows[0] });
  assert.strictEqual(m.ss.selected(), 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0003（make smoke 挂死且零输出——前端回报被后端静默拒收，应用永远不退出）
// 同族：生命周期必须收干净；不可用时连带清掉进行中的搜索。
// ═══════════════════════════════════════════════════════════════════════════

test('setAvailable(false)：进行中的搜索被清掉并退出', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  m.ss.setAvailable(false);
  assert.strictEqual(m.ss.isActive(), false);
  assert.strictEqual(m.ss.count(), 0);
  assert.strictEqual(m.input.value, '');
});

test('setAvailable(true) 不主动进入搜索态', function () {
  const m = mounted({});
  m.ss.setAvailable(true);
  assert.strictEqual(m.ss.isActive(), false);
  assert.strictEqual(m.stub.calls.length, 0);
});

test('reset()：清输入并退出搜索', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  m.ss.reset();
  assert.strictEqual(m.input.value, '');
  assert.strictEqual(m.ss.isActive(), false);
  assert.strictEqual(m.ss.count(), 0);
});

test('destroy()：摘掉输入框监听并清空面板', function () {
  const m = mounted({});
  type(m, 'a');
  m.ss.destroy();
  assert.strictEqual(m.pane.textContent, '');
  assert.strictEqual(m.input._listeners.input.length, 0);
  assert.strictEqual(m.input._listeners.keydown.length, 0);
});

test('destroy() 之后按 Enter 不再打开任何东西', async function () {
  const m = mounted({});
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md'])));
  await flush();
  m.ss.destroy();
  key(m, 'Enter');
  assert.deepStrictEqual(m.calls.picks, []);
});

test('isActive / count / selected 三个观察口与 DOM 同步', async function () {
  const m = mounted({});
  assert.strictEqual(m.ss.isActive(), false);
  assert.strictEqual(m.ss.count(), 0);
  assert.strictEqual(m.ss.selected(), -1);
  type(m, 'a');
  m.stub.pending[0].resolve(commitPayload(itemsOf(['a.md', 'b.md'])));
  await flush();
  assert.strictEqual(m.ss.isActive(), true);
  assert.strictEqual(m.ss.count(), 2);
  assert.strictEqual(m.ss.selected(), 0);
});
