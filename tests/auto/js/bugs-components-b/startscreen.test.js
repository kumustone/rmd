// StartScreen（`src/components/StartScreen.js` ＋ `src/services/start.js`）回归用例。
//
// 守的东西：两段顺序（收藏在上）、数字键只映射最近表、焦点只在用户按键后移动、
// 五种放行（`INV-START-04`）、打开失败可见（`INV-START-07`）、清空的两步确认。
// 只把 `document` 换成最小假 DOM；⛔ 不启动浏览器、不启动 app。
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
function emptyRect() {
  return { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
}
function makeTextNode(text) {
  return {
    nodeType: 3, nodeName: '#text', nodeValue: String(text == null ? '' : text),
    parentNode: null, childNodes: [],
    get textContent() { return this.nodeValue; },
    set textContent(v) { this.nodeValue = String(v); },
    remove: function () { if (this.parentNode) this.parentNode.removeChild(this); },
    contains: function (x) { return x === this; },
  };
}
function makeElement(tag) {
  const n = {
    nodeType: 1, tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(),
    style: {}, hidden: false, title: '', type: '', value: '', disabled: false,
    tabIndex: -1, isContentEditable: false,
    _attrs: Object.create(null), _listeners: Object.create(null), childNodes: [], parentNode: null,
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
    has: function (t, prop) {
      return typeof prop === 'string' &&
        Object.prototype.hasOwnProperty.call(t, 'data-' + prop.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }));
    },
    deleteProperty: function (t, prop) {
      if (typeof prop === 'string') {
        delete t['data-' + prop.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); })];
      }
      return true;
    },
  });
  ['alt', 'src', 'href', 'title'].forEach(function (name) {
    Object.defineProperty(n, name, {
      get: function () { return Object.prototype.hasOwnProperty.call(n._attrs, name) ? n._attrs[name] : ''; },
      set: function (v) { n._attrs[name] = String(v == null ? '' : v); },
      configurable: true,
    });
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
  Object.defineProperty(n, 'isConnected', {
    get: function () {
      let p = n;
      while (p) { if (p === doc.body) return true; p = p.parentNode; }
      return false;
    },
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
  n.insertBefore = function (c, ref) {
    if (c.parentNode) c.remove();
    const i = n.childNodes.indexOf(ref);
    c.parentNode = n;
    if (i < 0) n.childNodes.push(c); else n.childNodes.splice(i, 0, c);
    return c;
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
    if (list.indexOf(fn) < 0) list.push(fn);       // 真实 DOM 同一处理器只会挂一次
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
    // `currentTarget` 是事件派发时的容器；清空按钮的处理读它。
    if (!e.currentTarget) e.currentTarget = n;
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
  n.blur = function () { if (doc && doc.activeElement === n) doc.activeElement = doc.body; };
  n.getBoundingClientRect = function () { return n._rect || emptyRect(); };
  return n;
}

function makeDocument() {
  const body = makeElement('body');
  const d = {
    body: body, documentElement: makeElement('html'), activeElement: body,
    createElement: makeElement, createTextNode: makeTextNode,
    _listeners: Object.create(null),
    contains: function (n) { return body.contains(n); },
    querySelector: function (sel) { return body.querySelector(sel); },
    querySelectorAll: function (sel) { return body.querySelectorAll(sel); },
    addEventListener: function (type, fn) {
      const list = d._listeners[type] || (d._listeners[type] = []);
      if (list.indexOf(fn) < 0) list.push(fn);
    },
    removeEventListener: function (type, fn) {
      const list = d._listeners[type] || []; const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    fire: function (type, ev) {
      const e = ev || {};
      if (typeof e.preventDefault !== 'function') e.preventDefault = function () { e.defaultPrevented = true; };
      if (typeof e.stopPropagation !== 'function') e.stopPropagation = function () { e._stopped = true; };
      if (typeof e.defaultPrevented !== 'boolean') e.defaultPrevented = false;
      const list = (d._listeners[type] || []).slice();
      for (let i = 0; i < list.length; i++) list[i](e);
      return e;
    },
    listenerCount: function (type) { return (d._listeners[type] || []).length; },
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
    _listeners: Object.create(null),
  };
  win.addEventListener = function (type, fn) {
    const list = win._listeners[type] || (win._listeners[type] = []);
    if (list.indexOf(fn) < 0) list.push(fn);
  };
  win.removeEventListener = function (type, fn) {
    const list = win._listeners[type] || []; const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  win.fire = function (type, ev) {
    const e = ev || {};
    if (typeof e.preventDefault !== 'function') e.preventDefault = function () { e.defaultPrevented = true; };
    if (typeof e.stopPropagation !== 'function') e.stopPropagation = function () { e._stopped = true; };
    if (typeof e.defaultPrevented !== 'boolean') e.defaultPrevented = false;
    const list = (win._listeners[type] || []).slice();
    for (let i = 0; i < list.length; i++) list[i](e);
    return e;
  };
  loadInto(win, 'src/services/i18n.js');
  loadInto(win, 'src/services/start.js');
  loadInto(win, 'src/services/keymap.js');
  loadInto(win, 'src/components/StartScreen.js');
  return win;
}

function recentEntry(root, file, last) {
  return { root: root, last_file: file == null ? '' : file, last: !!last };
}

function allRows(host) {
  return host.querySelectorAll('.start-row');
}
function favRows(host) {
  return allRows(host).filter(function (r) { return r.classList.contains('start-fav-row'); });
}
function actRows(host) {
  return allRows(host).filter(function (r) { return r.classList.contains('start-act-row'); });
}
// ⚠️ `design/0081` 起有三段 ⇒ 最近行必须按**显式类名**选，⛔ 不能再写
// "不是收藏行的都算最近行"（那样会把「开始」段的行算进来）。
function recentRows(host) {
  return allRows(host).filter(function (r) { return r.classList.contains('start-recent-row'); });
}

/** 「开始」段的假文案表：真实环境里这些串来自后端 `SHORTCUTS`（`INV-START-08`）。 */
const LABELS = { 'file.open': '打开…', 'file.open-file': '打开文件…', 'file.quick-open': '快速打开…' };
const KEYS = { 'file.open': '⌘O', 'file.open-file': '⇧⌘O', 'file.quick-open': '⌘P' };

/** 造一个已挂载的启动页；`calls` 收集各回调收到的参数。 */
function mounted(over, recent, favorites) {
  const win = fresh();
  const host = makeElement('div');
  doc.body.appendChild(host);
  const calls = {
    open: [], favorites: [], unfavorite: [], move: [], forget: [], clear: [], errors: [],
    newWindow: [], action: [],
  };
  const opts = {
    onOpen: function (root) { calls.open.push(root); return Promise.resolve(); },
    onOpenFavorite: function (p) { calls.favorites.push(p); return Promise.resolve(); },
    onUnfavorite: function (p) { calls.unfavorite.push(p); },
    onMoveFavorite: function (p, d) { calls.move.push([p, d]); },
    onForgetRecent: function (root) { calls.forget.push(root); },
    onClearRecent: function () { calls.clear.push(1); return Promise.resolve(); },
    // ⭐ `design/0071` §5：菜单项只交出 `(kind, value)`，命令落在 `main.js`。
    onOpenInNewWindow: function (kind, value) { calls.newWindow.push([kind, value]); },
    onError: function (err, target) { calls.errors.push([err, target]); },
    overlayOpen: function () { return false; },
    // ⭐ `design/0081` §2.1 ③：真实环境由 `main.js` 从后端 `SHORTCUTS` 表现取。
    labelText: function (id) { return LABELS[id] || ''; },
    keyText: function (id) { return KEYS[id] || ''; },
    runAction: function (id, source) { calls.action.push([id, source]); return true; },
    canQuickOpen: function () { return false; },
  };
  Object.keys(over || {}).forEach(function (k) { opts[k] = over[k]; });
  const sc = win.rmd.startScreen.createStartScreen(opts);
  sc.render(host, recent == null ? [] : recent, favorites == null ? [] : favorites);
  return { win: win, doc: doc, host: host, sc: sc, calls: calls, opts: opts };
}

const RECENT = [
  recentEntry('/Users/example/proj/a', '/Users/example/proj/a/readme.md', true),
  recentEntry('/Users/example/proj/b', '/Users/example/proj/b/x.md', false),
  recentEntry('/tmp/c', '', false),
];
const FAVS = ['/Users/example/收藏/一', '/tmp/_fav'];

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0097（裸 F2 在 macOS 默认媒体键设置下可能到不了应用）
// 教训：启动页不能假设自己一定能收到键；“收到之前”的那五项判据必须逐条让路。
// ═══════════════════════════════════════════════════════════════════════════

test('guard：五项全为 false 才允许启动页处理', function () {
  const win = fresh();
  assert.strictEqual(win.rmd.start.guard({
    defaultPrevented: false, modifier: false, composing: false, overlay: false, editable: false,
  }), false);
});

test('guard：defaultPrevented 成立 ⇒ 放行给已经处理过它的那一层', function () {
  const win = fresh();
  assert.strictEqual(win.rmd.start.guard({
    defaultPrevented: true, modifier: false, composing: false, overlay: false, editable: false,
  }), true);
});

test('guard：带修饰键（⌘/⌃/⌥）⇒ 放行', function () {
  const win = fresh();
  assert.strictEqual(win.rmd.start.guard({
    defaultPrevented: false, modifier: true, composing: false, overlay: false, editable: false,
  }), true);
});

test('guard：输入法组合中 ⇒ 放行', function () {
  const win = fresh();
  assert.strictEqual(win.rmd.start.guard({
    defaultPrevented: false, modifier: false, composing: true, overlay: false, editable: false,
  }), true);
});

test('guard：覆盖层开着 ⇒ 放行（设置/搜索/查找/图片）', function () {
  const win = fresh();
  assert.strictEqual(win.rmd.start.guard({
    defaultPrevented: false, modifier: false, composing: false, overlay: true, editable: false,
  }), true);
});

test('guard：焦点在可编辑元素里 ⇒ 放行', function () {
  const win = fresh();
  assert.strictEqual(win.rmd.start.guard({
    defaultPrevented: false, modifier: false, composing: false, overlay: false, editable: true,
  }), true);
});

test('guard：缺参一律按“成立”放行（宁可少处理，不吞别人的键）', function () {
  const win = fresh();
  assert.strictEqual(win.rmd.start.guard({}), true);
  assert.strictEqual(win.rmd.start.guard(), true);
  assert.strictEqual(win.rmd.start.guard({
    defaultPrevented: false, modifier: false, composing: false, overlay: false,
  }), true);
});

test('guard 组件接线：defaultPrevented 的键盘事件不移动焦点', function () {
  const { doc } = mounted({}, RECENT, []);
  doc.activeElement = doc.body;
  const ev = doc.fire('keydown', { key: 'ArrowDown', defaultPrevented: true });
  assert.strictEqual(doc.activeElement, doc.body);
  assert.strictEqual(ev.defaultPrevented, true);
});

test('guard 组件接线：⌘ 组合不触发行打开', function () {
  const { doc, calls } = mounted({}, RECENT, []);
  doc.fire('keydown', { key: '1', metaKey: true });
  assert.deepStrictEqual(calls.open, []);
});

test('guard 组件接线：组合态不触发行打开', function () {
  const { doc, calls } = mounted({}, RECENT, []);
  doc.fire('keydown', { key: '1', isComposing: true });
  doc.fire('keydown', { key: '1', keyCode: 229 });
  assert.deepStrictEqual(calls.open, []);
});

test('guard 组件接线：覆盖层开着不触发行打开', function () {
  const { doc, calls } = mounted({ overlayOpen: function () { return true; } }, RECENT, []);
  doc.fire('keydown', { key: '1' });
  assert.deepStrictEqual(calls.open, []);
});

test('guard 组件接线：焦点在输入框里不触发行打开', function () {
  const { doc, calls } = mounted({}, RECENT, []);
  const input = makeElement('input');
  doc.body.appendChild(input);
  doc.activeElement = input;
  doc.fire('keydown', { key: '1' });
  assert.deepStrictEqual(calls.open, []);
});

test('guard 组件接线：contenteditable 焦点同样放行', function () {
  const { doc, calls } = mounted({}, RECENT, []);
  const div = makeElement('div');
  div.isContentEditable = true;
  doc.body.appendChild(div);
  doc.activeElement = div;
  doc.fire('keydown', { key: '1' });
  assert.deepStrictEqual(calls.open, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0003（make smoke 挂死且零输出——前端回报被后端静默拒收，应用永远不退出）
// 同族：启动页“什么都不画 / 画了点什么”必须由数据决定，且失败要看得见。
// ═══════════════════════════════════════════════════════════════════════════

test('两段都空且有动作名 ⇒ 只画「开始」段、键盘监听照挂', function () {
  // ⭐ `design/0081` §2.1 ③ 改变了这一格：空会话**不再什么都不画**——
  //    「开始」段（打开 / 打开文件…）正是空导航页上唯一有意义的入口。
  const { doc, host, sc } = mounted({}, [], []);
  assert.strictEqual(sc.visible(), true);
  assert.strictEqual(sc.count(), 0);
  assert.strictEqual(sc.favoriteCount(), 0);
  assert.strictEqual(sc.actionCount(), 2);
  assert.ok(host.querySelector('.start-act-list'));
  assert.strictEqual(doc.listenerCount('keydown'), 1);
});

test('动作名一个都取不到 ⇒ 回到旧空态（什么都不画、不挂监听）', function () {
  // ⚠️ 表还没到（或语言代号对不上）时 `labelText` 返回空串 ⇒ 该行不画；
  //    全部为空就等于没有「开始」段，⛔ 别画一堆空按钮。
  const { doc, host, sc } = mounted({
    labelText: function () { return ''; },
  }, [], []);
  assert.strictEqual(sc.visible(), false);
  assert.strictEqual(sc.actionCount(), 0);
  assert.strictEqual(host.children.length, 0);
  assert.strictEqual(doc.listenerCount('keydown'), 0);
});

test('只有收藏 ⇒ 可见、最近为 0、收藏计数正确、不画“清空”', function () {
  const { host, sc } = mounted({}, [], FAVS);
  assert.strictEqual(sc.visible(), true);
  assert.strictEqual(sc.count(), 0);
  assert.strictEqual(sc.favoriteCount(), 2);
  assert.strictEqual(host.querySelector('.start-clear'), null);
  assert.strictEqual(host.querySelector('.start-head'), null);
});

test('只有最近 ⇒ 可见、不画收藏段标题', function () {
  const { host, sc } = mounted({}, RECENT, []);
  assert.strictEqual(sc.visible(), true);
  assert.strictEqual(sc.favoriteCount(), 0);
  assert.strictEqual(host.querySelector('.start-fav-title'), null);
  assert.strictEqual(host.querySelector('.start-fav-list'), null);
});

test('三段都有 ⇒ 开始 → 收藏 → 最近（版式顺序与焦点顺序同源）', function () {
  const { host, sc } = mounted({}, RECENT, FAVS);
  const lists = host.querySelectorAll('.start-list');
  assert.strictEqual(lists.length, 3);
  assert.strictEqual(lists[0].classList.contains('start-act-list'), true);
  assert.strictEqual(lists[1].classList.contains('start-fav-list'), true);
  assert.strictEqual(lists[2].classList.contains('start-recent-list'), true);
  const titles = host.querySelectorAll('.start-title');
  assert.strictEqual(titles[0].classList.contains('start-act-title'), true);
  assert.strictEqual(titles[1].classList.contains('start-fav-title'), true);
  assert.strictEqual(sc.actionCount(), 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// `design/0081` §2.1 ③：导航页的「开始」段（用户原话「有点类似 Vscode 的导航页」）。
// 同族：动作名/键位**全部来自后端 `SHORTCUTS` 表**（`INV-START-08`），执行只经
// `runAction` 回到 `keymap.dispatch`（`INV-SET-01`）——本组件⛔ 不认识任何命令。
// ═══════════════════════════════════════════════════════════════════════════

test('「开始」段：动作名与键位都按表里的顺序画', function () {
  const { host } = mounted({}, [], []);
  const rows = actRows(host);
  assert.deepStrictEqual(
    rows.map(function (r) { return r.querySelector('.start-name').textContent; }),
    ['打开…', '打开文件…']);
  assert.deepStrictEqual(
    rows.map(function (r) { return r.querySelector('.start-key').textContent; }),
    ['⌘O', '⇧⌘O']);
});

test('「开始」段：点一行只把 id 交给 runAction（⛔ 不自己执行命令）', function () {
  const { host, calls } = mounted({}, [], []);
  actRows(host)[1].fire('click', {});
  assert.deepStrictEqual(calls.action, [['file.open-file', 'menu']]);
  // ⚠️ 三个别的打开回调一个都不许被误触（它们是"数据行"的路径）。
  assert.deepStrictEqual(calls.open, []);
  assert.deepStrictEqual(calls.favorites, []);
});

test('「快速打开…」只在 canQuickOpen 为真时出现', function () {
  const off = mounted({}, [], []);
  assert.strictEqual(off.sc.actionCount(), 2);
  const on = mounted({ canQuickOpen: function () { return true; } }, [], []);
  assert.strictEqual(on.sc.actionCount(), 3);
  assert.deepStrictEqual(
    actRows(on.host).map(function (r) { return r.dataset.action; }),
    ['file.open', 'file.open-file', 'file.quick-open']);
});

test('没有键位串 ⇒ 不画键位胶囊（⛔ 留一格空白）', function () {
  const { host } = mounted({ keyText: function () { return ''; } }, [], []);
  const row = actRows(host)[0];
  assert.strictEqual(row.querySelector('.start-key'), null);
  assert.strictEqual(row.querySelector('.start-name').textContent, '打开…');
});

test('「开始」段的行不参与数字键 / 行菜单（`INV-FAV-05` 的同一套理由）', function () {
  const { doc, host, calls } = mounted({}, [], []);
  doc.fire('keydown', { key: '1' });
  assert.deepStrictEqual(calls.open, []);
  assert.deepStrictEqual(calls.action, []);
  doc.activeElement = actRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  assert.strictEqual(doc.body.querySelector('.start-menu'), null);
});

test('打开失败（Promise 拒绝）⇒ 行变灰 + 行提示 + onError', async function () {
  const err = new Error('不在');
  const { doc, host, calls } = mounted({
    onOpen: function () { return Promise.reject(err); },
  }, RECENT, []);
  const rows = recentRows(host);
  rows[0].fire('click', {});
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(rows[0].dataset.missing, '1');
  assert.strictEqual(rows[0].title, '这个目录打不开了（可能已被移动或删除）');
  assert.deepStrictEqual(calls.errors, [[err, RECENT[0].root]]);
});

test('打开时同步抛 ⇒ 同样走可见失败路径（⛔ 抛到 window）', function () {
  const err = new Error('炸了');
  const { host, calls } = mounted({
    onOpen: function () { throw err; },
  }, RECENT, []);
  const row = recentRows(host)[1];
  assert.doesNotThrow(function () { row.fire('click', {}); });
  assert.strictEqual(row.dataset.missing, '1');
  assert.deepStrictEqual(calls.errors, [[err, RECENT[1].root]]);
});

test('收藏打不开用的是收藏段那条提示，且回传原路径', async function () {
  const err = new Error('没了');
  const { host, calls } = mounted({
    onOpenFavorite: function () { return Promise.reject(err); },
  }, [], FAVS);
  const row = favRows(host)[0];
  row.fire('click', {});
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(row.dataset.missing, '1');
  assert.strictEqual(row.title, '这条收藏打不开了（可能已被移动、删除或改成了软链）');
  assert.deepStrictEqual(calls.errors, [[err, FAVS[0]]]);
});

test('双触发保护：连点同一行只发一次打开命令', function () {
  const { host, calls } = mounted({}, RECENT, []);
  const row = recentRows(host)[0];
  row.fire('click', {});
  row.fire('click', {});
  row.fire('click', {});
  assert.deepStrictEqual(calls.open, [RECENT[0].root]);
});

test('双触发保护跨来源：点过之后同一个数字键也不再打开', function () {
  const { doc, host, calls } = mounted({}, RECENT, []);
  recentRows(host)[0].fire('click', {});
  doc.activeElement = doc.body;
  doc.fire('keydown', { key: '1' });
  assert.deepStrictEqual(calls.open, [RECENT[0].root]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0097（裸 F2 在 macOS 默认媒体键设置下可能到不了应用）
// 同族：数字键只映射最近表；焦点移动只在用户按了之后发生。
// ═══════════════════════════════════════════════════════════════════════════

test('render 不抢焦点：启动页出现后 activeElement 仍是 body', function () {
  const { doc } = mounted({}, RECENT, FAVS);
  assert.strictEqual(doc.activeElement, doc.body);
});

test('数字键 1–9 打开对应的最近行', function () {
  const many = [];
  for (let i = 0; i < 9; i++) many.push(recentEntry('/tmp/r' + i, '', false));
  const { doc, calls } = mounted({}, many, []);
  doc.fire('keydown', { key: '9' });
  doc.fire('keydown', { key: '1' });
  assert.deepStrictEqual(calls.open, ['/tmp/r8', '/tmp/r0']);
});

test('数字键不映射收藏段（两段编号会漂移）', function () {
  const { doc, calls } = mounted({}, [], FAVS);
  doc.fire('keydown', { key: '1' });
  assert.deepStrictEqual(calls.favorites, []);
  assert.deepStrictEqual(calls.open, []);
});

test('0 键不映射任何行', function () {
  const { doc, calls } = mounted({}, RECENT, []);
  doc.fire('keydown', { key: '0' });
  assert.deepStrictEqual(calls.open, []);
});

test('超出行数的数字键无动作', function () {
  const { doc, calls } = mounted({}, [recentEntry('/tmp/only', '', false)], []);
  doc.fire('keydown', { key: '2' });
  assert.deepStrictEqual(calls.open, []);
});

test('数字键打开时 preventDefault（不让字符落进别处）', function () {
  const { doc } = mounted({}, RECENT, []);
  const ev = doc.fire('keydown', { key: '1' });
  assert.strictEqual(ev.defaultPrevented, true);
});

test('↓ 从无焦点进入「开始」段第一行（顺序与版式同源）', function () {
  // ⭐ `design/0081`：三段里最先的是「开始」段 ⇒ 无焦点时的第一行是它，
  //    ⛔ 不再是收藏第一行（`INV-START-09`：版式顺序与 `allEls()` 同源）。
  const { doc, host } = mounted({}, RECENT, FAVS);
  doc.fire('keydown', { key: 'ArrowDown' });
  assert.strictEqual(doc.activeElement, actRows(host)[0]);
});

test('↓ 依次跨过开始段、收藏段后进入最近第一行', function () {
  const { doc, host } = mounted({}, RECENT, FAVS);
  const acts = actRows(host);
  doc.fire('keydown', { key: 'ArrowDown' });   // act0
  assert.strictEqual(doc.activeElement, acts[0]);
  doc.fire('keydown', { key: 'ArrowDown' });   // act1
  assert.strictEqual(doc.activeElement, acts[1]);
  const favs = favRows(host);
  doc.fire('keydown', { key: 'ArrowDown' });   // fav0
  doc.fire('keydown', { key: 'ArrowDown' });   // fav1
  assert.strictEqual(doc.activeElement, favs[favs.length - 1]);
  doc.fire('keydown', { key: 'ArrowDown' });   // recent0
  assert.strictEqual(doc.activeElement, recentRows(host)[0]);
});

test('↑ 从无焦点进入最近最后一行', function () {
  const { doc, host } = mounted({}, RECENT, FAVS);
  doc.fire('keydown', { key: 'ArrowUp' });
  const rows = recentRows(host);
  assert.strictEqual(doc.activeElement, rows[rows.length - 1]);
});

test('↑ 能跨段回到收藏最后一行', function () {
  const { doc, host } = mounted({}, RECENT, FAVS);
  doc.activeElement = recentRows(host)[0];
  doc.fire('keydown', { key: 'ArrowUp' });
  const favs = favRows(host);
  assert.strictEqual(doc.activeElement, favs[favs.length - 1]);
});

test('边界不 preventDefault：最后一行再按 ↓ 让键继续走', function () {
  const { doc, host } = mounted({}, RECENT, FAVS);
  const rows = recentRows(host);
  doc.activeElement = rows[rows.length - 1];
  const ev = doc.fire('keydown', { key: 'ArrowDown' });
  assert.strictEqual(ev.defaultPrevented, false);
  assert.strictEqual(doc.activeElement, rows[rows.length - 1]);
});

test('边界不 preventDefault：第一行再按 ↑ 让键继续走', function () {
  const { doc, host } = mounted({}, RECENT, FAVS);
  doc.activeElement = actRows(host)[0];
  const ev = doc.fire('keydown', { key: 'ArrowUp' });
  assert.strictEqual(ev.defaultPrevented, false);
});

test('真的移动了才 preventDefault', function () {
  const { doc, host } = mounted({}, RECENT, FAVS);
  doc.activeElement = favRows(host)[0];
  const ev = doc.fire('keydown', { key: 'ArrowDown' });
  assert.strictEqual(ev.defaultPrevented, true);
});

test('一行都没有时方向键不 preventDefault', function () {
  // ⚠️ 有「开始」段就不再是"一行都没有"⇒ 这里特意把动作名清空，才真的没有行。
  const { doc } = mounted({
    labelText: function () { return ''; },
  }, [], []);
  const ev = doc.fire('keydown', { key: 'ArrowDown' });
  assert.strictEqual(ev.defaultPrevented, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0001（点击文档里的链接，整个应用会重载一遍）
// 同族：行点击回传的必须是后端原串，⛔ 不是屏幕上那个 ~ 缩写。
// ═══════════════════════════════════════════════════════════════════════════

test('最近行点击回传 root 原串（不是 ~ 缩写、不是 basename）', function () {
  const { host, calls } = mounted({}, RECENT, []);
  recentRows(host)[1].fire('click', {});
  assert.deepStrictEqual(calls.open, ['/Users/example/proj/b']);
});

test('收藏行点击回传 path 原串', function () {
  const { host, calls } = mounted({}, [], FAVS);
  favRows(host)[1].fire('click', {});
  assert.deepStrictEqual(calls.favorites, ['/tmp/_fav']);
});

test('最近行显示 `~` 缩写，但 title 是全路径', function () {
  const { host } = mounted({}, RECENT, []);
  const row = recentRows(host)[0];
  assert.strictEqual(row.title, '/Users/example/proj/a');
  assert.strictEqual(row.querySelector('.start-path').textContent, '~/proj/a');
});

test('路径不重复存进 data-*（只留 title 一份真值）', function () {
  const { host } = mounted({}, RECENT, []);
  const row = recentRows(host)[0];
  assert.strictEqual(row.getAttribute('data-path'), null);
  assert.strictEqual(row.getAttribute('data-root'), null);
  assert.strictEqual(row.getAttribute('data-real-path'), null);
});

test('最近行：目录名、路径、上次文件名三段齐全', function () {
  const { host } = mounted({}, RECENT, []);
  const row = recentRows(host)[0];
  assert.strictEqual(row.querySelector('.start-name').textContent, 'a');
  assert.strictEqual(row.querySelector('.start-path').textContent, '~/proj/a');
  assert.strictEqual(row.querySelector('.start-file').textContent, 'readme.md');
});

test('没有 last_file ⇒ 不画文件名那一段', function () {
  const { host } = mounted({}, RECENT, []);
  assert.strictEqual(recentRows(host)[2].querySelector('.start-file'), null);
});

test('“上次打开”标记只有那一条有', function () {
  const { host } = mounted({}, RECENT, []);
  const rows = recentRows(host);
  assert.strictEqual(rows[0].dataset.last, '1');
  assert.ok(rows[0].querySelector('.start-last'));
  assert.strictEqual(rows[1].dataset.last, undefined);
  assert.strictEqual(rows[1].querySelector('.start-last'), null);
});

test('最近 1–9 有数字，第 10 行没有', function () {
  const many = [];
  for (let i = 0; i < 10; i++) many.push(recentEntry('/tmp/r' + i, '', false));
  const { host } = mounted({}, many, []);
  const rows = recentRows(host);
  assert.strictEqual(rows.length, 10);
  for (let i = 0; i < 9; i++) {
    assert.strictEqual(rows[i].querySelector('.start-num').textContent, String(i + 1));
  }
  assert.strictEqual(rows[9].querySelector('.start-num'), null);
});

test('收藏行不画数字（`INV-FAV-05`）', function () {
  const { host } = mounted({}, [], FAVS);
  const rows = favRows(host);
  assert.ok(rows.length > 0);
  for (let i = 0; i < rows.length; i++) assert.strictEqual(rows[i].querySelector('.start-num'), null);
});

test('收藏行显示名字与 `~` 缩写，title 是全路径', function () {
  const { host } = mounted({}, [], FAVS);
  const row = favRows(host)[0];
  assert.strictEqual(row.title, '/Users/example/收藏/一');
  assert.strictEqual(row.querySelector('.start-name').textContent, '一');
  assert.strictEqual(row.querySelector('.start-path').textContent, '~/收藏/一');
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0097（裸 F2 在 macOS 默认媒体键设置下可能到不了应用）
// 同族：右键与 Shift+F10 共用一份动作清单；首末行的“上移/下移”必须置灰。
// ⭐ `design/0071` §5（阶段 4）：两个菜单各多一项「在新窗口中打开」。
//    ⚠️ 下面按**文案**找项，⛔ 不按固定下标——新增项插在哪一格是排版自由度，
//    判据只钉"原动作还在、语义没变"（左键/回车行为完全不动）。
// ═══════════════════════════════════════════════════════════════════════════

const 新窗口项 = '在新窗口中打开';

/** 菜单项里按文案找一项（找不到就让它先红，别静默滑过）。 */
function 按文案(items, text) {
  const all = Array.from(items);
  const hit = all.filter(function (x) { return x.textContent === text; })[0];
  assert.ok(hit, '菜单里没有「' + text + '」，实际有：' + all.map(function (x) { return x.textContent; }).join(' / '));
  return hit;
}

test('Shift+F10 在收藏首行：菜单四项，上移置灰、下移可用', function () {
  const { doc, host } = mounted({}, [], FAVS);
  doc.activeElement = favRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  const menu = doc.body.querySelector('.start-menu');
  assert.ok(menu, '没有打开行菜单');
  const items = menu.querySelectorAll('.start-menu-item');
  assert.strictEqual(items.length, 4, '收藏菜单应有 4 项（原 3 项 ＋ 在新窗口中打开）');
  按文案(items, 新窗口项);
  assert.strictEqual(按文案(items, '取消收藏').disabled, false);
  assert.strictEqual(按文案(items, '上移').disabled, true, '首行的“上移”没有置灰');
  assert.strictEqual(按文案(items, '下移').disabled, false);
  assert.strictEqual(doc.activeElement, items[0], '键盘打开菜单后焦点没进第一项');
});

test('Shift+F10 在收藏末行：下移置灰、上移可用', function () {
  const { doc, host } = mounted({}, [], FAVS);
  doc.activeElement = favRows(host)[1];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  const items = doc.body.querySelectorAll('.start-menu-item');
  assert.strictEqual(按文案(items, '上移').disabled, false);
  assert.strictEqual(按文案(items, '下移').disabled, true);
});

test('Shift+F10 在最近行：「从列表移除」＋「在新窗口中打开」两项', function () {
  const { doc, host } = mounted({}, RECENT, []);
  doc.activeElement = recentRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  const items = doc.body.querySelectorAll('.start-menu-item');
  assert.strictEqual(items.length, 2, '最近菜单应有 2 项（原 1 项 ＋ 在新窗口中打开）');
  assert.strictEqual(按文案(items, '从列表移除').textContent, '从列表移除');
  按文案(items, 新窗口项);
});

test('收藏菜单「在新窗口中打开」交出 (favorite, 收藏原路径)', function () {
  const { doc, host, calls } = mounted({}, [], FAVS);
  doc.activeElement = favRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  按文案(doc.body.querySelectorAll('.start-menu-item'), 新窗口项).fire('click', {});
  assert.deepStrictEqual(calls.newWindow, [['favorite', FAVS[0]]],
    '⛔ kind / value 交错了 —— 新窗口会被拿去开另一条');
  // ⚠️ 左键 / 回车的既有行为一个字都不动：点菜单项**不**触发打开。
  assert.deepStrictEqual(calls.favorites, []);
});

test('最近菜单「在新窗口中打开」交出 (recent, root 原串)', function () {
  const { doc, host, calls } = mounted({}, RECENT, []);
  doc.activeElement = recentRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  按文案(doc.body.querySelectorAll('.start-menu-item'), 新窗口项).fire('click', {});
  assert.deepStrictEqual(calls.newWindow, [['recent', '/Users/example/proj/a']],
    '⛔ 传了 ~ 缩写或错 kind —— 后端按原串查表，查不到就静默失败');
  assert.deepStrictEqual(calls.open, []);
});

test('Shift+F10 没有焦点行 ⇒ 不打开菜单', function () {
  const { doc } = mounted({}, RECENT, FAVS);
  doc.activeElement = doc.body;
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  assert.strictEqual(doc.body.querySelector('.start-menu'), null);
});

test('收藏菜单“取消收藏”回传原路径', function () {
  const { doc, host, calls } = mounted({}, [], FAVS);
  doc.activeElement = favRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  const items = doc.body.querySelectorAll('.start-menu-item');
  按文案(items, '取消收藏').fire('click', {});
  assert.deepStrictEqual(calls.unfavorite, [FAVS[0]]);
  assert.strictEqual(doc.body.querySelector('.start-menu'), null, '执行后菜单没关');
});

test('收藏菜单“上移 / 下移”只表达方向（delta = ∓1）', function () {
  const { doc, host, calls } = mounted({}, [], FAVS);
  doc.activeElement = favRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  按文案(doc.body.querySelectorAll('.start-menu-item'), '下移').fire('click', {});
  assert.deepStrictEqual(calls.move, [[FAVS[0], 1]]);
  doc.activeElement = favRows(host)[1];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  按文案(doc.body.querySelectorAll('.start-menu-item'), '上移').fire('click', {});
  assert.deepStrictEqual(calls.move[1], [FAVS[1], -1]);
});

test('置灰的菜单项点击无动作（⛔ 不吞掉一次“上移”）', function () {
  const { doc, host, calls } = mounted({}, [], FAVS);
  doc.activeElement = favRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  按文案(doc.body.querySelectorAll('.start-menu-item'), '上移').fire('click', {});
  assert.deepStrictEqual(calls.move, []);
});

test('最近行菜单回传 root 原串（⛔ 不是 ~ 缩写）', function () {
  const { doc, host, calls } = mounted({}, RECENT, []);
  doc.activeElement = recentRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  按文案(doc.body.querySelectorAll('.start-menu-item'), '从列表移除').fire('click', {});
  assert.deepStrictEqual(calls.forget, ['/Users/example/proj/a']);
});

test('右键最近行打开菜单，并 preventDefault（不弹系统菜单）', function () {
  const { doc, host } = mounted({}, RECENT, []);
  const row = recentRows(host)[1];
  const ev = row.fire('contextmenu', { clientX: 10, clientY: 20 });
  assert.strictEqual(ev.defaultPrevented, true);
  assert.ok(doc.body.querySelector('.start-menu'));
});

test('右键收藏行打开收藏菜单', function () {
  const { doc, host } = mounted({}, [], FAVS);
  favRows(host)[0].fire('contextmenu', { clientX: 10, clientY: 20 });
  assert.strictEqual(doc.body.querySelectorAll('.start-menu-item').length, 4);
});

test('别的处理器已 preventDefault 的 contextmenu ⇒ 不再开菜单', function () {
  const { doc, host } = mounted({}, RECENT, []);
  const ev = recentRows(host)[0].fire('contextmenu', { defaultPrevented: true });
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(doc.body.querySelector('.start-menu'), null);
});

test('Escape 关闭菜单并把焦点还给打开它的那一行', async function () {
  const { doc, host } = mounted({}, RECENT, []);
  const row = recentRows(host)[1];
  doc.activeElement = row;
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  await new Promise(function (r) { setTimeout(r, 0); });
  const ev = doc.fire('keydown', { key: 'Escape' });
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(doc.body.querySelector('.start-menu'), null);
  assert.strictEqual(doc.activeElement, row);
});

test('菜单外 mousedown 关闭菜单，菜单内不关', async function () {
  const { doc, host } = mounted({}, RECENT, []);
  doc.activeElement = recentRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  await new Promise(function (r) { setTimeout(r, 0); });
  const item = doc.body.querySelector('.start-menu-item');
  doc.fire('mousedown', { target: item });
  assert.ok(doc.body.querySelector('.start-menu'), '点菜单内部把菜单关了');
  doc.fire('mousedown', { target: doc.body });
  assert.strictEqual(doc.body.querySelector('.start-menu'), null);
});

test('滚动关闭菜单', async function () {
  const { doc, host } = mounted({}, RECENT, []);
  doc.activeElement = recentRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  await new Promise(function (r) { setTimeout(r, 0); });
  doc.fire('scroll', {});
  assert.strictEqual(doc.body.querySelector('.start-menu'), null);
});

test('窗口 resize 关闭菜单', async function () {
  const { win, doc, host } = mounted({}, RECENT, []);
  doc.activeElement = recentRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  await new Promise(function (r) { setTimeout(r, 0); });
  win.fire('resize', {});
  assert.strictEqual(doc.body.querySelector('.start-menu'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0003（make smoke 挂死且零输出——前端回报被后端静默拒收，应用永远不退出）
// 同族：“清空”是两步确认；失败不许静默，也不许抛到 window。
// ═══════════════════════════════════════════════════════════════════════════

test('清空第一下只武装，不调后端', function () {
  const { host, calls } = mounted({}, RECENT, []);
  const btn = host.querySelector('.start-clear');
  btn.fire('click', {});
  assert.deepStrictEqual(calls.clear, []);
  assert.strictEqual(btn.dataset.armed, '1');
  assert.strictEqual(btn.textContent, '确认清空？');
});

test('清空第二下在同一窗口内 ⇒ 真清并复位按钮', function () {
  const realNow = Date.now;
  let now = 1000;
  Date.now = function () { return now; };
  try {
    const { host, calls } = mounted({}, RECENT, []);
    const btn = host.querySelector('.start-clear');
    btn.fire('click', {});
    now = 2000;
    btn.fire('click', {});
    assert.deepStrictEqual(calls.clear, [1]);
    assert.strictEqual(btn.dataset.armed, undefined);
    assert.strictEqual(btn.textContent, '清空');
  } finally {
    Date.now = realNow;
  }
});

test('超过 3 秒再点 ⇒ 重新武装，⛔ 不把一次迟疑当确认', function () {
  const realNow = Date.now;
  let now = 1000;
  Date.now = function () { return now; };
  try {
    const { host, calls } = mounted({}, RECENT, []);
    const btn = host.querySelector('.start-clear');
    btn.fire('click', {});
    now = 4002;
    btn.fire('click', {});
    assert.deepStrictEqual(calls.clear, []);
    assert.strictEqual(btn.dataset.armed, '1');
  } finally {
    Date.now = realNow;
  }
});

test('时钟倒退 ⇒ 重新武装（⛔ 负窗口算确认）', function () {
  const realNow = Date.now;
  let now = 5000;
  Date.now = function () { return now; };
  try {
    const { host, calls } = mounted({}, RECENT, []);
    const btn = host.querySelector('.start-clear');
    btn.fire('click', {});
    now = 1000;
    btn.fire('click', {});
    assert.deepStrictEqual(calls.clear, []);
    assert.strictEqual(btn.dataset.armed, '1');
  } finally {
    Date.now = realNow;
  }
});

test('武装态 3 秒后自动复位（不留一个“确认清空？”在屏上）', function () {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; };
  global.clearTimeout = function () {};
  try {
    const { host } = mounted({}, RECENT, []);
    const btn = host.querySelector('.start-clear');
    btn.fire('click', {});
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].ms, 3000);
    timers[0].fn();
    assert.strictEqual(btn.dataset.armed, undefined);
    assert.strictEqual(btn.textContent, '清空');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('清空回调同步抛 ⇒ 不冒到 window、按钮已复位', function () {
  const realNow = Date.now;
  let now = 1000;
  Date.now = function () { return now; };
  try {
    const { host } = mounted({
      onClearRecent: function () { throw new Error('落盘失败'); },
    }, RECENT, []);
    const btn = host.querySelector('.start-clear');
    btn.fire('click', {});
    now = 1500;
    assert.doesNotThrow(function () { btn.fire('click', {}); });
    assert.strictEqual(btn.dataset.armed, undefined);
  } finally {
    Date.now = realNow;
  }
});

test('清空回调的 Promise 拒绝被就地吞掉（状态栏那条由实现方负责）', async function () {
  const realNow = Date.now;
  let now = 1000;
  Date.now = function () { return now; };
  try {
    const { host } = mounted({
      onClearRecent: function () { return Promise.reject(new Error('落盘失败')); },
    }, RECENT, []);
    const btn = host.querySelector('.start-clear');
    btn.fire('click', {});
    now = 1500;
    assert.doesNotThrow(function () { btn.fire('click', {}); });
    await Promise.resolve();
  } finally {
    Date.now = realNow;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0019（其他程序在目录里新增文档，目录树里不出现（手动刷新也没用））
// 同族：重画必须换掉旧 DOM、监听只挂一次；否则新旧两份同时响应。
// ═══════════════════════════════════════════════════════════════════════════

test('重画换掉旧 DOM，不会出现两份启动页', function () {
  const { doc, host, sc } = mounted({}, RECENT, []);
  sc.render(host, RECENT, FAVS);
  assert.strictEqual(host.querySelectorAll('.start').length, 1);
  assert.strictEqual(sc.count(), RECENT.length);
  assert.strictEqual(sc.favoriteCount(), FAVS.length);
});

test('重画不重复挂 document keydown 监听', function () {
  const { doc, host, sc } = mounted({}, RECENT, []);
  assert.strictEqual(doc.listenerCount('keydown'), 1);
  sc.render(host, RECENT, []);
  sc.render(host, RECENT, []);
  assert.strictEqual(doc.listenerCount('keydown'), 1);
});

test('重画成空 ⇒ 只剩「开始」段，旧行不再响应数字键', function () {
  const { doc, host, sc, calls } = mounted({}, RECENT, []);
  sc.render(host, [], []);
  // ⭐ `design/0081`：空会话仍有「开始」段 ⇒ 页面还在、监听也还得挂着。
  assert.strictEqual(sc.visible(), true);
  assert.strictEqual(sc.count(), 0);
  assert.strictEqual(sc.actionCount(), 2);
  assert.strictEqual(doc.listenerCount('keydown'), 1);
  doc.fire('keydown', { key: '1' });
  assert.deepStrictEqual(calls.open, []);
});

test('重画成空且没有动作名 ⇒ 摘掉监听，旧行不再响应数字键', function () {
  const { doc, host, sc, calls } = mounted({
    labelText: function () { return ''; },
  }, RECENT, []);
  sc.render(host, [], []);
  assert.strictEqual(sc.visible(), false);
  assert.strictEqual(doc.listenerCount('keydown'), 0);
  doc.fire('keydown', { key: '1' });
  assert.deepStrictEqual(calls.open, []);
});

test('clear() 摘干净：DOM、计数、监听都没了', function () {
  const { doc, host, sc } = mounted({}, RECENT, FAVS);
  sc.clear();
  assert.strictEqual(sc.visible(), false);
  assert.strictEqual(sc.count(), 0);
  assert.strictEqual(sc.favoriteCount(), 0);
  assert.strictEqual(sc.actionCount(), 0);
  assert.strictEqual(host.querySelector('.start'), null);
  assert.strictEqual(doc.listenerCount('keydown'), 0);
});

test('clear() 幂等', function () {
  const { host, sc } = mounted({}, RECENT, []);
  sc.clear();
  assert.doesNotThrow(function () { sc.clear(); });
  assert.strictEqual(host.querySelector('.start'), null);
});

test('打开菜单时重画/清空会先关掉菜单（不留孤儿层）', function () {
  const { doc, host, sc } = mounted({}, RECENT, []);
  doc.activeElement = recentRows(host)[0];
  doc.fire('keydown', { key: 'F10', shiftKey: true });
  assert.ok(doc.body.querySelector('.start-menu'));
  sc.clear();
  assert.strictEqual(doc.body.querySelector('.start-menu'), null);
});

test('host 为 null 时安全降级为“没显示”', function () {
  const { sc } = mounted({}, RECENT, []);
  assert.doesNotThrow(function () { sc.render(null, RECENT, FAVS); });
  assert.strictEqual(sc.visible(), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0019（其他程序在目录里新增文档，目录树里不出现（手动刷新也没用））
// 同族：`rows` / `favoriteRows` 只做展示换算，坏行跳过，不排序、不猜。
// ═══════════════════════════════════════════════════════════════════════════

test('rows：非数组 ⇒ 空（旧空态）', function () {
  const win = fresh();
  assert.deepStrictEqual(win.rmd.start.rows(null), []);
  assert.deepStrictEqual(win.rmd.start.rows({}), []);
  assert.deepStrictEqual(win.rmd.start.rows('x'), []);
});

test('rows：坏行跳过，而不是画一行空白', function () {
  const win = fresh();
  const out = win.rmd.start.rows([
    null, {}, { root: '' }, { root: 7 },
    { root: '/tmp/ok', last_file: '' },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].root, '/tmp/ok');
});

test('rows：最多 10 行（坏行不占名额）', function () {
  const win = fresh();
  const input = [];
  for (let i = 0; i < 15; i++) input.push({ root: '/tmp/' + i });
  input.unshift(null);
  assert.strictEqual(win.rmd.start.rows(input).length, 10);
});

test('rows：不排序，顺序就是后端给的顺序', function () {
  const win = fresh();
  const out = win.rmd.start.rows([
    { root: '/z' }, { root: '/a' }, { root: '/m' },
  ]);
  assert.deepStrictEqual(out.map(function (r) { return r.root; }), ['/z', '/a', '/m']);
});

test('rows：last 只认 === true', function () {
  const win = fresh();
  const out = win.rmd.start.rows([
    { root: '/a', last: true }, { root: '/b', last: 'true' }, { root: '/c', last: 1 },
  ]);
  assert.deepStrictEqual(out.map(function (r) { return r.last; }), [true, false, false]);
});

test('rows：last_file 取文件名，而不是整条路径', function () {
  const win = fresh();
  const out = win.rmd.start.rows([{ root: '/a', last_file: '/a/docs/readme.md' }]);
  assert.strictEqual(out[0].file, 'readme.md');
});

test('rows：last_file 缺失 / 非字符串 ⇒ 空串（界面不画那一格）', function () {
  const win = fresh();
  const out = win.rmd.start.rows([{ root: '/a' }, { root: '/b', last_file: 3 }]);
  assert.strictEqual(out[0].file, '');
  assert.strictEqual(out[1].file, '');
});

test('favoriteRows：非数组 ⇒ 空', function () {
  const win = fresh();
  assert.deepStrictEqual(win.rmd.start.favoriteRows(null), []);
  assert.deepStrictEqual(win.rmd.start.favoriteRows(undefined), []);
});

test('favoriteRows：只保留非空字符串；顺序与条数原样（不截断）', function () {
  const win = fresh();
  const favs = ['/a', '', 7, null, '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i'];
  const out = win.rmd.start.favoriteRows(favs);
  assert.strictEqual(out.length, 9);
  assert.deepStrictEqual(out.map(function (r) { return r.path; }), ['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i']);
});

test('favoriteRows：name / tilded 只用于显示，path 保持原串', function () {
  const win = fresh();
  const out = win.rmd.start.favoriteRows(['/Users/example/x/']);
  assert.strictEqual(out[0].path, '/Users/example/x/');
  assert.strictEqual(out[0].name, 'x');
  assert.strictEqual(out[0].tilded, '~/x/');
});

test('tilde：只缩 `/Users/<用户>` 前缀；其他路径原样', function () {
  const win = fresh();
  assert.strictEqual(win.rmd.start.tilde('/Users/example/a'), '~/a');
  assert.strictEqual(win.rmd.start.tilde('/Users/example'), '~');
  assert.strictEqual(win.rmd.start.tilde('/home/x/a'), '/home/x/a');
  assert.strictEqual(win.rmd.start.tilde(''), '');
  assert.strictEqual(win.rmd.start.tilde(null), '');
});

test('basename：尾部分隔符先剥掉，根回落成 `/`', function () {
  const win = fresh();
  assert.strictEqual(win.rmd.start.basename('/a/b/'), 'b');
  assert.strictEqual(win.rmd.start.basename('/a//'), 'a');
  assert.strictEqual(win.rmd.start.basename('/'), '/');
  assert.strictEqual(win.rmd.start.basename(''), '');
  assert.strictEqual(win.rmd.start.basename('abc'), 'abc');
});

test('digitIndex：只认单字符 1–9', function () {
  const win = fresh();
  assert.strictEqual(win.rmd.start.digitIndex('1'), 0);
  assert.strictEqual(win.rmd.start.digitIndex('9'), 8);
  assert.strictEqual(win.rmd.start.digitIndex('0'), -1);
  assert.strictEqual(win.rmd.start.digitIndex('10'), -1);
  assert.strictEqual(win.rmd.start.digitIndex('a'), -1);
  assert.strictEqual(win.rmd.start.digitIndex(1), -1);
  assert.strictEqual(win.rmd.start.digitIndex(null), -1);
});

test('clearConfirm：第一下武装，窗口内第二下执行', function () {
  const win = fresh();
  const a = win.rmd.start.clearConfirm(0, 1000);
  assert.deepStrictEqual(a, { fire: false, nextArmedAt: 1000 });
  assert.deepStrictEqual(win.rmd.start.clearConfirm(a.nextArmedAt, 3000), { fire: true, nextArmedAt: 0 });
});

test('clearConfirm：恰好 3000ms 仍算确认，3001ms 重新武装', function () {
  const win = fresh();
  assert.strictEqual(win.rmd.start.clearConfirm(1000, 4000).fire, true);
  assert.deepStrictEqual(win.rmd.start.clearConfirm(1000, 4001), { fire: false, nextArmedAt: 4001 });
});

test('clearConfirm：时钟倒退按新的第一下处理', function () {
  const win = fresh();
  assert.deepStrictEqual(win.rmd.start.clearConfirm(5000, 1000), { fire: false, nextArmedAt: 1000 });
});
