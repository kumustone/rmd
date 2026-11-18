// 文件树组件层（`src/components/FileTree.js`）的纯逻辑与可观察决策。
//
// # 这一层守什么
//
// `FileTree` 的大部分判据被有意拆到了 `services/treerefresh.js` / `dirsession.js`
// （那份能直接 `require`，`tests/auto/js/services-*` 已覆盖）。留在本文件里的，
// 是「只有把组件装起来才看得见」的那一半：
//   · 路径范围判据（树只认根下的路径，前缀陷阱不能漏）；
//   · 行渲染前的转义（文件名是用户数据）；
//   · 展开集合 / 刷新事务 / fresh 的调用形状（`bugs/0019`）；
//   · 键盘与焦点的落点（`bugs/0036` 的邻居问题：焦点不许莫名其妙跑到看不见的行）；
//   · 新建 / 重命名只把值交给 session，不自己拼 IPC 载荷（`bugs/0088`）。
//
// ⚠️ 这里用**最小假 DOM**，只实现本组件真正调用的那几个属性 / 选择器。
//    ⛔ 不为凑条数伪造整棵文档；断言都落在「用户看得见的结果」或「传给依赖的值」上。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

// ─────────────────────────────────────────────────────────────────────────
// 最小假 DOM（只覆盖 FileTree.js 用到的面）
// ─────────────────────────────────────────────────────────────────────────

function classTokens(s) { return String(s == null ? '' : s).split(/\s+/).filter(Boolean); }

class FText {
  constructor(text, doc) {
    this.nodeType = 3;
    this.ownerDocument = doc;
    this.parentNode = null;
    this._text = String(text == null ? '' : text);
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v == null ? '' : v); }
  get isConnected() { return connected(this); }
}

function connected(n) {
  let x = n;
  while (x) {
    if (x.ownerDocument && (x === x.ownerDocument.body || x === x.ownerDocument.documentElement)) return true;
    x = x.parentNode;
  }
  return false;
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
    this._styleProps = Object.create(null);
    this._rect = { top: 0, left: 0, bottom: 20, right: 200, width: 200, height: 20 };
    this.dataset = {};
    this.id = '';
    this.title = '';
    this.value = '';
    this.href = undefined;
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.readOnly = false;
    this.tabIndex = -1;
    this._tabIndexSet = false;
    this.type = '';
    this.scrollTop = 0;
    this.style = {
      display: '',
      setProperty: (k, v) => { this._styleProps[k] = String(v); },
      getPropertyValue: (k) => this._styleProps[k] || '',
    };
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
        get length() { return self._classes.size; },
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
    else if (k === 'id') { this.id = String(v); this.ownerDocument._byId.set(this.id, this); }
    else if (k === 'tabindex') { this._tabIndexSet = true; this.tabIndex = Number(v); }
    else if (k === 'hidden') this.hidden = true;
    else if (k === 'href') this.href = String(v);
  }

  getAttribute(k) {
    k = String(k);
    if (k === 'class') return this.className || null;
    if (k === 'id') return this.id || null;
    if (k === 'tabindex') return this._tabIndexSet ? String(this.tabIndex) : null;
    if (k === 'value') return this.value !== '' ? String(this.value) : (k in this._attrs ? this._attrs[k] : null);
    if (k === 'href') return this.href !== undefined ? String(this.href) : (k in this._attrs ? this._attrs[k] : null);
    return k in this._attrs ? this._attrs[k] : null;
  }

  hasAttribute(k) { return this.getAttribute(k) !== null; }

  removeAttribute(k) {
    k = String(k);
    delete this._attrs[k];
    if (k === 'id') { this.ownerDocument._byId.delete(this.id); this.id = ''; }
    if (k === 'tabindex') this._tabIndexSet = false;
    if (k === 'hidden') this.hidden = false;
    if (k === 'href') this.href = undefined;
  }

  appendChild(n) {
    if (!n) return n;
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.children.push(n);
    return n;
  }

  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = this.children.indexOf(ref);
    n.parentNode = this;
    this.children.splice(i < 0 ? this.children.length : i, 0, n);
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
  get childElementCount() { return this.children.filter((c) => c.nodeType === 1).length; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get isConnected() { return connected(this); }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = String(v == null ? '' : v);
  }

  getClientRects() {
    let n = this;
    while (n) {
      if (n.hidden) return [];
      if (n.style && n.style.display === 'none') return [];
      n = n.parentNode;
    }
    return [{ width: this._rect.width, height: this._rect.height }];
  }

  getBoundingClientRect() { return Object.assign({}, this._rect); }

  get offsetParent() {
    if (this.hidden) return null;
    let n = this.parentNode;
    while (n) {
      if (n.hidden || (n.style && n.style.display === 'none')) return null;
      n = n.parentNode;
    }
    return this.parentNode;
  }

  focus() { this.ownerDocument.activeElement = this; }
  select() { this._selected = true; }
  setSelectionRange(a, b) { this._selection = [a, b]; }
  scrollIntoView() { this._scrolled = true; }
  click() { this.dispatch('click', {}); }

  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }

  closest(sel) {
    for (let x = this; x; x = x.parentNode) {
      if (x.nodeType === 1 && matches(x, sel)) return x;
    }
    return null;
  }

  querySelectorAll(sel) {
    const out = [];
    walkNodes(this, (n) => { if (matches(n, sel)) out.push(n); });
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  addEventListener(type, fn) {
    (this._listeners[type] || (this._listeners[type] = [])).push(fn);
  }
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
    let node = this;
    while (node && !e.propagationStopped) {
      const a = node._listeners && node._listeners[e.type];
      if (a) for (const fn of a.slice()) fn(e);
      node = node.parentNode;
    }
    return !e.defaultPrevented;
  }
}

function walkNodes(node, fn) {
  for (const c of node.children) {
    if (c.nodeType !== 1) continue;
    fn(c);
    walkNodes(c, fn);
  }
}

function attrVal(n, name) {
  if (name === 'disabled') {
    if (n.disabled) return '';
    return name in n._attrs ? n._attrs[name] : null;
  }
  if (name === 'tabindex') {
    if (n._tabIndexSet) return String(n.tabIndex);
    return name in n._attrs ? n._attrs[name] : null;
  }
  if (name === 'value') return n.value !== '' ? String(n.value) : (name in n._attrs ? n._attrs[name] : null);
  if (name === 'href') return n.href !== undefined ? String(n.href) : (name in n._attrs ? n._attrs[name] : null);
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
  let m;
  const classRe = /\.([A-Za-z0-9_-]+)/g;
  while ((m = classRe.exec(rest))) {
    if (!n._classes.has(m[1])) return false;
  }
  rest = rest.replace(/\.([A-Za-z0-9_-]+)/g, '');
  const notRe = /:not\(\[([^\]]+)\]\)/g;
  while ((m = notRe.exec(rest))) {
    const av = /^([^=]+)(?:="([^"]*)")?$/.exec(m[1]);
    if (!av) return false;
    const val = attrVal(n, av[1]);
    if (av[2] === undefined) { if (val !== null) return false; }
    else if (val === av[2]) return false;
  }
  rest = rest.replace(/:not\(\[[^\]]+\]\)/g, '');
  const attrRe = /\[([^\]]+)\]/g;
  while ((m = attrRe.exec(rest))) {
    const av = /^([^=]+)(?:="([^"]*)")?$/.exec(m[1]);
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

function makeDoc() {
  const doc = {};
  doc.body = new FNode('body', doc);
  doc.documentElement = new FNode('html', doc);
  doc.documentElement.appendChild(doc.body);
  doc._byId = new Map();
  doc._listeners = Object.create(null);
  doc.activeElement = doc.body;
  doc.createElement = (t) => new FNode(t, doc);
  doc.createElementNS = (ns, t) => new FNode(t, doc);
  doc.createTextNode = (t) => new FText(t, doc);
  doc.getElementById = (id) => doc._byId.get(id) || null;
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
      preventDefault: function () { e.defaultPrevented = true; },
      stopPropagation: function () {},
    }, extra || {});
    for (const fn of (doc._listeners[t] || []).slice()) fn(e);
    return !e.defaultPrevented;
  };
  doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
  doc.querySelector = (sel) => doc.body.querySelector(sel);
  return doc;
}

// ─────────────────────────────────────────────────────────────────────────
// 加载
// ─────────────────────────────────────────────────────────────────────────

const fakeI18n = {
  t: function (key) { return key; },
  lang: function () { return 'zh'; },
  subscribe: function () { return function () {}; },
};

function makeTimers() {
  const queue = [];
  const set = function (fn, ms) { queue.push({ fn: fn, ms: ms }); return queue.length; };
  set.flush = function () {
    const items = queue.splice(0);
    for (const it of items) it.fn();
  };
  set.pending = function () { return queue.length; };
  return set;
}

function loadInto(win, doc, rel, sandbox) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const sb = sandbox || {};
  const fn = new Function('window', 'document', 'setTimeout', 'clearTimeout', 'module', 'require', src);
  fn(win, doc, sb.setTimeout || setTimeout, sb.clearTimeout || clearTimeout, undefined, undefined);
}

function makeTree(opts) {
  const o = opts || {};
  const doc = makeDoc();
  const timers = makeTimers();
  const win = {
    rmd: {},
    innerWidth: 800,
    innerHeight: 600,
    matchMedia: function () { return { matches: false }; },
    addEventListener: function () {},
    removeEventListener: function () {},
  };
  loadInto(win, doc, 'src/services/versions.js');
  loadInto(win, doc, 'src/services/chunked.js');
  loadInto(win, doc, 'src/services/treerefresh.js');
  loadInto(win, doc, 'src/services/dirsession.js');
  win.rmd.i18n = fakeI18n;
  win.rmd.session = o.session || fakeSession();
  win.rmd.clipboard = {
    defaultCopier: function () { return { copy: function () { return Promise.resolve({ ok: true }); } }; },
  };
  win.rmd.diskEvents = { seq: function () { return o.seq || 0; } };
  loadInto(win, doc, 'src/components/FileTree.js', { setTimeout: timers, clearTimeout: function () {} });
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const opened = [];
  const errors = [];
  const tree = win.rmd.fileTree.createFileTree(Object.assign({
    host: host,
    onOpenFile: function (p) { opened.push(p); },
    onError: function (e) { errors.push(e); },
    onManualRefresh: o.onManualRefresh,
  }, o.opts || {}));
  return { doc: doc, win: win, tree: tree, host: host, opened: opened, errors: errors, timers: timers };
}

function fakeSession(over) {
  return Object.assign({
    state: { generation: 1, currentPath: null },
    listDir: async function () { return { decision: { commit: true }, result: { entries: [] } }; },
    revealEntry: async function () {},
    createEntry: async function () { return { path: '/r/new.md' }; },
    renameEntry: async function () { return { path: '/r/x' }; },
  }, over || {});
}

function entry(p, isDir, extra) {
  return Object.assign({
    path: p,
    name: p.slice(p.lastIndexOf('/') + 1),
    is_dir: !!isDir,
    ignored: false,
  }, extra || {});
}

function tick() { return new Promise(function (resolve) { setImmediate(resolve); }); }

async function settle() { await tick(); await tick(); await tick(); }

function nodeByPath(host, p) {
  const all = host.querySelectorAll('.node');
  for (const n of all) if (n.dataset.path === p) return n;
  return null;
}

function rowOf(host, p) {
  const n = nodeByPath(host, p);
  return n && n.firstChild;
}

/** 焦点所在行的路径（路径在行的父 `.node` 上，不在 `.row` 上）。 */
function activePath(t) {
  const a = t.doc.activeElement;
  const n = a && a.parentElement;
  return n && n.dataset ? n.dataset.path : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
//
// 同一条树渲染路径上的范围判据、文件名转义与图标形态。刷新/缓存的承重判据
// 在本文件后半段，这里先把「哪些路径算这棵树」「文件名怎么落到 DOM」钉住。
// ─────────────────────────────────────────────────────────────────────────

test('isInside：相等、父子、尾斜杠都算在根下', function () {
  const A = makeTree().win.rmd.fileTree;
  assert.strictEqual(A.isInside('/a', '/a'), true);
  assert.strictEqual(A.isInside('/a', '/a/b'), true);
  assert.strictEqual(A.isInside('/a/', '/a/b'), true);
  assert.strictEqual(A.isInside('/', '/a'), true);
  assert.strictEqual(A.isInside('/a/b', '/a/b/c/d'), true);
});

test('isInside：rootfoo 不算在 root 里（前缀陷阱）', function () {
  const A = makeTree().win.rmd.fileTree;
  assert.strictEqual(A.isInside('/a', '/ab'), false);
  assert.strictEqual(A.isInside('/a', '/a-b'), false);
  assert.strictEqual(A.isInside('/a/b', '/a/bc'), false);
});

test('isInside：兄弟目录不算在里面', function () {
  const A = makeTree().win.rmd.fileTree;
  assert.strictEqual(A.isInside('/a/b', '/a/c'), false);
  assert.strictEqual(A.isInside('/a/b/', '/a/c/d'), false);
});

test('isInside：空值一律为假，⛔ 不把空串当根', function () {
  const A = makeTree().win.rmd.fileTree;
  assert.strictEqual(A.isInside('', '/a'), false);
  assert.strictEqual(A.isInside('/a', ''), false);
  assert.strictEqual(A.isInside(null, '/a'), false);
  assert.strictEqual(A.isInside('/a', null), false);
});

// ⚠️ 疑似缺陷：`isInside` 对非字符串参数不做类型护栏，会抛 TypeError
//    （`prefix.endsWith` / `p.startsWith` 不存在）。公开导出的辅助函数按说该一律
//    返回 false；当前调用方都传字符串，所以先钉住现状。
test('isInside：非字符串会抛 TypeError（现状，⚠️ 疑似缺陷）', function () {
  const A = makeTree().win.rmd.fileTree;
  assert.throws(function () { A.isInside(7, '/a'); }, TypeError);
  assert.throws(function () { A.isInside('/a', 7); }, TypeError);
  assert.throws(function () { A.isInside({}, '/a'); }, TypeError);
});

test('safeName：普通文件名原样保留（含空格与中文）', function () {
  const A = makeTree().win.rmd.fileTree;
  assert.strictEqual(A.safeName('笔记 01.md'), '笔记 01.md');
  assert.strictEqual(A.safeName('a-b_c.d'), 'a-b_c.d');
});

test('safeName：C0 控制字符全部替换成 U+FFFD', function () {
  const A = makeTree().win.rmd.fileTree;
  assert.strictEqual(A.safeName('a\u0000b'), 'a�b');
  assert.strictEqual(A.safeName('a\u0001b'), 'a�b');
  assert.strictEqual(A.safeName('a\nb'), 'a�b');
  assert.strictEqual(A.safeName('a\tb'), 'a�b');
});

test('safeName：DEL（U+007F）也替换', function () {
  const A = makeTree().win.rmd.fileTree;
  assert.strictEqual(A.safeName('a\u007Fb'), 'a�b');
});

test('safeName：双向控制字符替换（防视觉伪装）', function () {
  const A = makeTree().win.rmd.fileTree;
  // U+202A..U+202E 与 U+2066..U+2069 是正则覆盖的那两段。
  assert.strictEqual(A.safeName('a‪b'), 'a�b');
  assert.strictEqual(A.safeName('a‫b'), 'a�b');
  assert.strictEqual(A.safeName('a‮b'), 'a�b');
  assert.strictEqual(A.safeName('a⁦b'), 'a�b');
  assert.strictEqual(A.safeName('a⁩b'), 'a�b');
});

test('safeName：多个坏字符逐个替换，好字符不动', function () {
  const A = makeTree().win.rmd.fileTree;
  assert.strictEqual(A.safeName('x\u0000y‮z'), 'x�y�z');
});

test('safeName：非字符串走 String()，空串仍为空串', function () {
  const A = makeTree().win.rmd.fileTree;
  assert.strictEqual(A.safeName(7), '7');
  assert.strictEqual(A.safeName(''), '');
});

test('svgIcon：文件夹与文件用不同路径，文件多一条折角', function () {
  const A = makeTree().win.rmd.fileTree;
  const folder = A.svgIcon('folder');
  const file = A.svgIcon('file');
  assert.strictEqual(folder.tagName, 'SVG');
  assert.strictEqual(file.tagName, 'SVG');
  assert.strictEqual(folder.children.filter((c) => c.tagName === 'PATH').length, 1);
  assert.strictEqual(file.children.filter((c) => c.tagName === 'PATH').length, 2);
  const folderD = folder.children[0].getAttribute('d');
  const fileD = file.children[0].getAttribute('d');
  assert.notStrictEqual(folderD, fileD);
  assert.match(folderD, /^M2 12\.6/);
  assert.match(fileD, /^M4\.3 2\.4/);
});

test('svgIcon：颜色跟随 currentColor，不写死色值', function () {
  const A = makeTree().win.rmd.fileTree;
  const svg = A.svgIcon('folder');
  assert.strictEqual(svg.getAttribute('stroke'), 'currentColor');
  assert.strictEqual(svg.getAttribute('fill'), 'none');
  assert.strictEqual(svg.getAttribute('stroke-width'), '1.3');
  assert.strictEqual(svg.getAttribute('viewBox'), '0 0 16 16');
});

test('showRoot：没有根时返回 no-root 且一行都不画', async function () {
  const t = makeTree();
  const r = await t.tree.showRoot('', true);
  assert.deepStrictEqual(r, { ok: false, reason: 'no-root' });
  assert.strictEqual(t.tree.nodeCount(), 0);
});

test('showRoot：按后端返回的 path 建节点，前端不拼路径', async function () {
  const S = fakeSession({
    listDir: async function () {
      return { decision: { commit: true }, result: { entries: [entry('/r/a', true), entry('/r/b.md')] } };
    },
  });
  const t = makeTree({ session: S });
  const r = await t.tree.showRoot('/r', true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(t.tree.nodeCount(), 2);
  assert.deepStrictEqual(
    t.host.querySelectorAll('.node').map((n) => n.dataset.path).sort(),
    ['/r/a', '/r/b.md']
  );
});

test('makeNode：目录行带 dir/twisty，文件行不带', async function () {
  const S = fakeSession({
    listDir: async function () {
      return { decision: { commit: true }, result: { entries: [entry('/r/a', true), entry('/r/b.md')] } };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  const a = nodeByPath(t.host, '/r/a');
  const b = nodeByPath(t.host, '/r/b.md');
  assert.strictEqual(a.classList.contains('dir'), true);
  assert.strictEqual(a.dataset.dir, '1');
  assert.strictEqual(a.dataset.depth, '0');
  assert.strictEqual(a.firstChild.querySelector('.twisty').textContent, '▸');
  assert.strictEqual(b.classList.contains('dir'), false);
  assert.strictEqual(b.dataset.dir, '0');
  assert.strictEqual(b.firstChild.querySelector('.twisty').textContent, '');
});

test('makeNode：文件名走 safeName 后再写进 textContent', async function () {
  const S = fakeSession({
    listDir: async function () {
      return { decision: { commit: true }, result: { entries: [entry('/r/a\u0000b.md')] } };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  const n = nodeByPath(t.host, '/r/a\u0000b.md');
  assert.ok(n);
  assert.strictEqual(n.firstChild.querySelector('.name').textContent, 'a�b.md');
});

test('makeNode：ignored 条目可见但带 ignored 类，且不挂展开/打开监听', async function () {
  const S = fakeSession({
    listDir: async function () {
      return { decision: { commit: true }, result: { entries: [entry('/r/node_modules', true, { ignored: true })] } };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  const n = nodeByPath(t.host, '/r/node_modules');
  assert.ok(n);
  assert.strictEqual(n.classList.contains('ignored'), true);
  assert.strictEqual(t.tree.ignoredCount(), 1);
  assert.strictEqual(n.firstChild.getAttribute('role'), null, '被忽略的目录不该是可交互行');
});

test('setCurrent：至多一个当前项，重复设置会先摘掉旧的', async function () {
  const S = fakeSession({
    listDir: async function () {
      return { decision: { commit: true }, result: { entries: [entry('/r/a.md'), entry('/r/b.md')] } };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  t.tree.setCurrent('/r/a.md');
  assert.strictEqual(t.tree.currentCount(), 1);
  t.tree.setCurrent('/r/b.md');
  assert.strictEqual(t.tree.currentCount(), 1);
  assert.strictEqual(nodeByPath(t.host, '/r/a.md').classList.contains('current'), false);
  assert.strictEqual(nodeByPath(t.host, '/r/b.md').classList.contains('current'), true);
});

test('setCurrent：null / 找不到的路径只会清空旧的', async function () {
  const S = fakeSession({
    listDir: async function () {
      return { decision: { commit: true }, result: { entries: [entry('/r/a.md')] } };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  t.tree.setCurrent('/r/a.md');
  t.tree.setCurrent(null);
  assert.strictEqual(t.tree.currentCount(), 0);
  t.tree.setCurrent('/r/none.md');
  assert.strictEqual(t.tree.currentCount(), 0);
});

test('expandedPaths：返回快照，改返回值不影响内部展开集合', async function () {
  const S = fakeSession({
    listDir: async function (p) {
      return {
        decision: { commit: true },
        result: { entries: p === '/r' ? [entry('/r/a', true)] : [] },
      };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  rowOf(t.host, '/r/a').click();
  await settle();
  const snap = t.tree.expandedPaths();
  assert.deepStrictEqual(snap, ['/r/a']);
  snap.push('/r/fake');
  assert.deepStrictEqual(t.tree.expandedPaths(), ['/r/a']);
});

test('reset：切根后节点与展开集合全清空，根换成新值', async function () {
  const S = fakeSession({
    listDir: async function (p) {
      return {
        decision: { commit: true },
        result: { entries: p === '/r' ? [entry('/r/a', true)] : [] },
      };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  rowOf(t.host, '/r/a').click();
  await settle();
  t.tree.reset('/other');
  assert.strictEqual(t.tree.nodeCount(), 0);
  assert.deepStrictEqual(t.tree.expandedPaths(), []);
  assert.strictEqual(t.tree.failed.size, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
//
// 刷新事务的承重判据：离屏重建的每一层都必须 `fresh`，否则后端缓存命中，
// 外部新增的文件永远不会出现在树上（以及「手动刷新也没用」）。
// ─────────────────────────────────────────────────────────────────────────

function refreshSession(calls) {
  let phase = 'old';
  let base = [entry('/r/a', true, { children: [] }), entry('/r/b.md')];
  const session = fakeSession({
    state: { generation: 1, currentPath: null },
    listDir: async function (p, fresh) {
      calls.push({ path: p, fresh: !!fresh });
      if (p === '/r') {
        return {
          decision: { commit: true },
          result: {
            entries: phase === 'new'
              ? base.concat([entry('/r/new.md')])
              : base,
          },
        };
      }
      if (p === '/r/a') {
        return {
          decision: { commit: true },
          result: {
            entries: phase === 'new'
              ? [entry('/r/a/child.md'), entry('/r/a/new-child.md')]
              : [entry('/r/a/child.md')],
          },
        };
      }
      return { decision: { commit: true }, result: { entries: [] } };
    },
  });
  session.setPhase = function (p) { phase = p; };
  return session;
}

test('expand：首次点目录会列这一层，展开集合记下路径', async function () {
  const calls = [];
  const t = makeTree({ session: refreshSession(calls) });
  await t.tree.showRoot('/r', true);
  calls.length = 0;
  rowOf(t.host, '/r/a').click();
  await settle();
  assert.deepStrictEqual(t.tree.expandedPaths(), ['/r/a']);
  assert.deepStrictEqual(calls, [{ path: '/r/a', fresh: true }]);
  assert.strictEqual(t.tree.nodeCount(), 3);
});

test('expand：折叠不会重新读盘；再展开直接显示已有子节点', async function () {
  const calls = [];
  const t = makeTree({ session: refreshSession(calls) });
  await t.tree.showRoot('/r', true);
  rowOf(t.host, '/r/a').click();
  await settle();
  calls.length = 0;

  rowOf(t.host, '/r/a').click(); // 折叠
  await settle();
  assert.deepStrictEqual(t.tree.expandedPaths(), []);
  assert.deepStrictEqual(calls, [], '折叠不该读盘');
  assert.strictEqual(nodeByPath(t.host, '/r/a')._kids.style.display, 'none');

  rowOf(t.host, '/r/a').click(); // 再展开
  await settle();
  assert.deepStrictEqual(calls, [], '已有子节点时不该重扫（§7 步骤 3）');
  assert.strictEqual(nodeByPath(t.host, '/r/a')._kids.style.display, '');
  assert.deepStrictEqual(t.tree.expandedPaths(), ['/r/a']);
});

test('noteTreeChanged：刷新事务对根层与每个展开层都传 fresh=true（0019 的根因）', async function () {
  const calls = [];
  const S = refreshSession(calls);
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  rowOf(t.host, '/r/a').click();
  await settle();
  calls.length = 0;
  S.setPhase('new');

  const r = await t.tree.noteTreeChanged();
  assert.deepStrictEqual(r, { committed: true, reason: 'ok' });
  assert.deepStrictEqual(
    calls.map((c) => c.path).sort(),
    ['/r', '/r/a']
  );
  for (const c of calls) assert.strictEqual(c.fresh, true, '缓存命中会让外部新增永远不出现');
});

test('noteTreeChanged：外部新增的根层文件与已展开子层文件都出现在树上', async function () {
  const calls = [];
  const S = refreshSession(calls);
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  rowOf(t.host, '/r/a').click();
  await settle();
  assert.strictEqual(t.tree.nodeCount(), 3);

  S.setPhase('new');
  await t.tree.noteTreeChanged();
  await settle();

  assert.strictEqual(t.tree.nodeCount(), 5, '根层 +1、已展开子层 +1');
  assert.ok(nodeByPath(t.host, '/r/new.md'));
  assert.ok(nodeByPath(t.host, '/r/a/new-child.md'));
  assert.ok(nodeByPath(t.host, '/r/a/child.md'), '旧文件不能在外面新增时被删掉');
});

test('noteTreeChanged：刷新之后展开态保持不变', async function () {
  const calls = [];
  const S = refreshSession(calls);
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  rowOf(t.host, '/r/a').click();
  await settle();
  S.setPhase('new');
  await t.tree.noteTreeChanged();
  await settle();
  assert.deepStrictEqual(t.tree.expandedPaths(), ['/r/a']);
  assert.strictEqual(nodeByPath(t.host, '/r/a').classList.contains('expanded'), true);
  assert.strictEqual(nodeByPath(t.host, '/r/a')._kids.style.display, '');
});

test('noteTreeChanged：没有根时不发 IPC，直接 no-root', async function () {
  const calls = [];
  const t = makeTree({ session: refreshSession(calls) });
  calls.length = 0;
  const r = await t.tree.noteTreeChanged();
  assert.deepStrictEqual(r, { committed: false, reason: 'no-root' });
  assert.deepStrictEqual(calls, []);
});

async function clickRefresh(t) {
  t.tree.openRootMenu(10, 10);
  const menu = t.doc.body.querySelector('.tree-menu');
  assert.ok(menu);
  const btn = menu.querySelectorAll('.tree-menu-item')
    .find((b) => b.textContent === 'tree.menu.refresh');
  assert.ok(btn, '根菜单里必须有「刷新」');
  btn.click();
  for (let i = 0; i < 8; i++) await tick();
}

test('manualRefresh：先对账、再重列；对账失败也照样重列（0019 的「手动刷新也没用」）', async function () {
  const order = [];
  const calls = [];
  const S = refreshSession(calls);
  const t = makeTree({
    session: S,
    onManualRefresh: function () {
      order.push('reconcile');
      return Promise.resolve();
    },
  });
  await t.tree.showRoot('/r', true);
  calls.length = 0;
  await clickRefresh(t);
  assert.strictEqual(order[0], 'reconcile');
  assert.ok(calls.length > 0, '对账之后必须真的重列');
  assert.ok(calls.some((c) => c.fresh === true));
});

test('manualRefresh：对账抛错时不吞、仍然重列', async function () {
  const calls = [];
  const S = refreshSession(calls);
  const errs = [];
  const oldError = console.error;
  console.error = function () { errs.push(Array.prototype.slice.call(arguments)); };
  const t = makeTree({
    session: S,
    onManualRefresh: function () { return Promise.reject(new Error('对账失败')); },
  });
  try {
    await t.tree.showRoot('/r', true);
    calls.length = 0;
    await clickRefresh(t);
    assert.ok(calls.length > 0);
    assert.strictEqual(errs.length, 1, '失败要留下痕迹，⛔ 不许静默');
  } finally {
    console.error = oldError;
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0036（⌘A 全选选中了侧边栏与顶栏）
//
// 同族问题：键盘/焦点必须落在明确的一行上，⛔ 不许「看起来在树里、实际焦点在别处」。
// 这里钉住树自己的方向键模型与焦点归还。
// ─────────────────────────────────────────────────────────────────────────

async function twoLevelTree() {
  const S = fakeSession({
    state: { generation: 1, currentPath: null },
    listDir: async function (p) {
      return {
        decision: { commit: true },
        result: {
          entries: p === '/r'
            ? [entry('/r/a', true), entry('/r/b.md'), entry('/r/c.md')]
            : [entry('/r/a/x.md')],
        },
      };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  return t;
}

test('keydown：容器拿到焦点时，第一次 ↓ 落在第一行', async function () {
  const t = await twoLevelTree();
  t.host.focus();
  t.host.dispatch('keydown', { key: 'ArrowDown' });
  assert.strictEqual(activePath(t), '/r/a');
});

test('keydown：↑/↓ 在可见行之间移动，不越界成 undefined', async function () {
  const t = await twoLevelTree();
  rowOf(t.host, '/r/a').focus();
  t.doc.activeElement.dispatch('keydown', { key: 'ArrowDown' });
  assert.strictEqual(activePath(t), '/r/b.md');
  t.doc.activeElement.dispatch('keydown', { key: 'ArrowUp' });
  assert.strictEqual(activePath(t), '/r/a');
});

test('keydown：Home / End 落到首尾行', async function () {
  const t = await twoLevelTree();
  rowOf(t.host, '/r/b.md').focus();
  t.doc.activeElement.dispatch('keydown', { key: 'End' });
  assert.strictEqual(activePath(t), '/r/c.md');
  t.doc.activeElement.dispatch('keydown', { key: 'Home' });
  assert.strictEqual(activePath(t), '/r/a');
});

test('keydown：→ 展开目录，再按一次进入第一个子行', async function () {
  const t = await twoLevelTree();
  rowOf(t.host, '/r/a').focus();
  t.doc.activeElement.dispatch('keydown', { key: 'ArrowRight' });
  await settle();
  assert.deepStrictEqual(t.tree.expandedPaths(), ['/r/a']);
  assert.strictEqual(activePath(t), '/r/a');
  t.doc.activeElement.dispatch('keydown', { key: 'ArrowRight' });
  assert.strictEqual(activePath(t), '/r/a/x.md');
});

test('keydown：← 收起已展开目录；对文件则跳到父目录行', async function () {
  const t = await twoLevelTree();
  rowOf(t.host, '/r/a').focus();
  t.doc.activeElement.dispatch('keydown', { key: 'ArrowRight' });
  await settle();
  t.doc.activeElement.dispatch('keydown', { key: 'ArrowLeft' });
  assert.deepStrictEqual(t.tree.expandedPaths(), []);

  rowOf(t.host, '/r/a/x.md').focus();
  t.doc.activeElement.dispatch('keydown', { key: 'ArrowLeft' });
  assert.strictEqual(activePath(t), '/r/a');
});

test('keydown：Enter / Space 等价于点击当前行（文件会打开）', async function () {
  const t = await twoLevelTree();
  rowOf(t.host, '/r/b.md').focus();
  t.doc.activeElement.dispatch('keydown', { key: 'Enter' });
  assert.deepStrictEqual(t.opened, ['/r/b.md']);
  t.doc.activeElement.dispatch('keydown', { key: ' ' });
  assert.deepStrictEqual(t.opened, ['/r/b.md', '/r/b.md']);
});

test('keydown：目录被点开的瞬间先报「用户接管」，恢复事务才不会继续开旧文件', async function () {
  let toggles = 0;
  const S = fakeSession({
    state: { generation: 1, currentPath: null },
    listDir: async function (p) {
      return { decision: { commit: true }, result: { entries: p === '/r' ? [entry('/r/a', true)] : [] } };
    },
  });
  const t = makeTree({ session: S, opts: { onUserToggle: function () { toggles += 1; } } });
  await t.tree.showRoot('/r', true);
  rowOf(t.host, '/r/a').click();
  await settle();
  assert.strictEqual(toggles, 1);
  rowOf(t.host, '/r/a').click();
  await settle();
  assert.strictEqual(toggles, 2);
});

test('note：树顶只留一行灰字，新的一句替换旧的而不是堆叠', function () {
  const t = makeTree();
  const s1 = t.tree.note('第一句');
  assert.strictEqual(s1, 1);
  assert.strictEqual(t.host.querySelectorAll('.note-reveal').length, 1);
  const s2 = t.tree.note('第二句');
  assert.strictEqual(s2, 2);
  assert.strictEqual(t.host.querySelectorAll('.note-reveal').length, 1);
  assert.strictEqual(t.host.querySelector('.note-reveal').textContent, '第二句');
});

test('note：空串清除那行灰字，序号继续递增', function () {
  const t = makeTree();
  t.tree.note('一句');
  const s = t.tree.note('');
  assert.strictEqual(s, 2);
  assert.strictEqual(t.host.querySelector('.note-reveal'), null);
});

test('flash：到点只清自己那一句；期间被别的话顶掉则不动别人的句子', async function () {
  const t = await twoLevelTree();
  const clickRoot = function (key) {
    t.tree.openRootMenu(10, 10);
    const btn = t.doc.body.querySelector('.tree-menu').querySelectorAll('.tree-menu-item')
      .find((b) => b.textContent === key);
    assert.ok(btn, '根菜单缺项：' + key);
    btn.click();
  };

  clickRoot('tree.menu.copy-path');
  await tick();
  assert.strictEqual(t.host.querySelector('.note-reveal').textContent, 'tree.copy.ok');
  t.timers.flush();
  assert.strictEqual(t.host.querySelector('.note-reveal'), null);

  clickRoot('tree.menu.copy-path');
  await tick();
  t.tree.note('定位失败');
  t.timers.flush();
  assert.strictEqual(t.host.querySelector('.note-reveal').textContent, '定位失败', '别把别人的话顺手抹掉');
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
//
// 定位（revealPath）与恢复（restoreExpanded）：失败必须区分原因，成功必须展开祖先。
// 这两件事在 0019 之后尤其重要——缓存/刷新错了时，用户第一反应是「搜索定位」。
// ─────────────────────────────────────────────────────────────────────────

test('revealPath：根外路径返回 outside（这不是失败提示的对象）', async function () {
  const t = await twoLevelTree();
  assert.deepStrictEqual(await t.tree.revealPath('/other/x.md'), { ok: false, reason: 'outside' });
});

test('revealPath：根自己视为成功且不展开任何东西', async function () {
  const t = await twoLevelTree();
  assert.deepStrictEqual(await t.tree.revealPath('/r'), { ok: true, reason: null });
  assert.deepStrictEqual(t.tree.expandedPaths(), []);
});

test('revealPath：已渲染的根层文件能定位并挂上当前项', async function () {
  const t = await twoLevelTree();
  assert.deepStrictEqual(await t.tree.revealPath('/r/b.md'), { ok: true, reason: null });
  assert.strictEqual(t.tree.currentCount(), 1);
  assert.strictEqual(nodeByPath(t.host, '/r/b.md').classList.contains('current'), true);
});

test('revealPath：父层没展开时会先展开再定位', async function () {
  const t = await twoLevelTree();
  assert.deepStrictEqual(await t.tree.revealPath('/r/a/x.md'), { ok: true, reason: null });
  assert.deepStrictEqual(t.tree.expandedPaths(), ['/r/a']);
  assert.strictEqual(nodeByPath(t.host, '/r/a/x.md').classList.contains('current'), true);
});

test('revealPath：叶子不存在返回 missing，不误报成功', async function () {
  const t = await twoLevelTree();
  assert.deepStrictEqual(await t.tree.revealPath('/r/nope.md'), { ok: false, reason: 'missing' });
});

test('revealPath：中间层不存在返回 missing-parent', async function () {
  const t = await twoLevelTree();
  assert.deepStrictEqual(await t.tree.revealPath('/r/nope/x.md'), { ok: false, reason: 'missing-parent' });
});

test('revealPath：中间层是文件时返回 not-a-dir', async function () {
  const t = await twoLevelTree();
  assert.deepStrictEqual(await t.tree.revealPath('/r/b.md/x.md'), { ok: false, reason: 'not-a-dir' });
});

test('restoreExpanded：按记录展开已存在的目录，跳过不存在 / 非目录 / 被忽略的项', async function () {
  const S = fakeSession({
    state: { generation: 1, currentPath: null },
    listDir: async function (p) {
      return {
        decision: { commit: true },
        result: {
          entries: p === '/r'
            ? [entry('/r/a', true), entry('/r/f.md'), entry('/r/ign', true, { ignored: true })]
            : [],
        },
      };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  const r = await t.tree.restoreExpanded(['/r/a', '/r/missing', '/r/f.md', '/r/ign', null, '', 7]);
  assert.strictEqual(r.restored, 1);
  assert.strictEqual(r.skipped, 6);
  assert.strictEqual(r.cancelled, false);
  assert.deepStrictEqual(t.tree.expandedPaths(), ['/r/a']);
});

test('restoreExpanded：shouldContinue 为 false 时立刻收手并报告 cancelled', async function () {
  const S = fakeSession({
    state: { generation: 1, currentPath: null },
    listDir: async function (p) {
      return {
        decision: { commit: true },
        result: { entries: p === '/r' ? [entry('/r/a', true), entry('/r/b', true)] : [] },
      };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  let asked = 0;
  const r = await t.tree.restoreExpanded(['/r/a', '/r/b'], function () { asked += 1; return false; });
  assert.deepStrictEqual(r, { restored: 0, skipped: 0, cancelled: true });
  assert.strictEqual(asked, 1);
  assert.deepStrictEqual(t.tree.expandedPaths(), []);
});

test('restoreExpanded：已经展开的目录直接计入 restored，不重复读盘', async function () {
  const calls = [];
  const S = fakeSession({
    state: { generation: 1, currentPath: null },
    listDir: async function (p) {
      calls.push(p);
      return { decision: { commit: true }, result: { entries: p === '/r' ? [entry('/r/a', true)] : [] } };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  rowOf(t.host, '/r/a').click();
  await settle();
  calls.length = 0;
  const r = await t.tree.restoreExpanded(['/r/a']);
  assert.strictEqual(r.restored, 1);
  assert.deepStrictEqual(calls, []);
});

test('restoreExpanded：恢复期间不把「树变了」通知给写者', async function () {
  let changes = 0;
  const S = fakeSession({
    state: { generation: 1, currentPath: null },
    listDir: async function (p) {
      return { decision: { commit: true }, result: { entries: p === '/r' ? [entry('/r/a', true)] : [] } };
    },
  });
  const t = makeTree({ session: S, opts: { onStateChange: function () { changes += 1; } } });
  await t.tree.showRoot('/r', true);
  changes = 0;
  await t.tree.restoreExpanded(['/r/a']);
  await settle();
  assert.strictEqual(changes, 0, '恢复不是用户改的树，写回去会互相追尾');
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0088（三条命令的 IPC 参数键写成 snake_case）
//
// 同一条纪律：组件只把「用户敲的值」交给 session 的命名入口，⛔ 不自己拼 IPC 载荷、
// ⛔ 不自造键名。这里钉住 create / rename 的调用形状与失败保留。
// ─────────────────────────────────────────────────────────────────────────

async function treeWithInputSession(over) {
  const calls = { create: [], rename: [] };
  const S = fakeSession({
    state: { generation: 1, currentPath: null },
    listDir: async function (p) {
      return {
        decision: { commit: true },
        result: { entries: p === '/r' ? [entry('/r/a', true), entry('/r/b.md')] : [entry('/r/a/x.md')] },
      };
    },
    createEntry: async function (dir, name, kind) {
      calls.create.push({ dir: dir, name: name, kind: kind });
      if (over && over.rejectCreate) throw over.rejectCreate;
      return { path: dir + '/' + name + (kind === 'folder' ? '' : '.md') };
    },
    renameEntry: async function (from, name) {
      calls.rename.push({ from: from, name: name });
      if (over && over.rejectRename) throw over.rejectRename;
      return { path: '/r/a/' + name, current_moved: false, degraded: [] };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  return { t: t, calls: calls };
}

test('openInput：未展开的目录拒绝开输入行（⛔ 插到看不见的层里）', async function () {
  const ctx = await treeWithInputSession();
  // 目录 /r/a 还没展开：右键它并点「新建文件」不该产生输入行。
  const row = rowOf(ctx.t.host, '/r/a');
  row.dispatch('contextmenu', { clientX: 5, clientY: 5, target: row });
  const menu = ctx.t.doc.body.querySelector('.tree-menu');
  assert.ok(menu);
  menu.querySelectorAll('.tree-menu-item')[0].click(); // tree.menu.new-file
  assert.strictEqual(ctx.t.host.querySelector('.tree-input'), null);
  assert.strictEqual(ctx.calls.create.length, 0);
});

test('openInput：新建输入行默认名来自字典，且输入框拿到焦点', async function () {
  const ctx = await treeWithInputSession();
  ctx.t.tree.openRootMenu(10, 10);
  const item = ctx.t.doc.body.querySelector('.tree-menu').querySelectorAll('.tree-menu-item')[0];
  item.click();
  const input = ctx.t.host.querySelector('.tree-input');
  assert.strictEqual(input.value, 'tree.default-file-name');
  assert.strictEqual(ctx.t.doc.activeElement, input);
  assert.strictEqual(input.getAttribute('aria-label'), 'tree.menu.new-file');
});

test('openInput：重命名初值是文件名，只选主名（.md 留在选区外）', async function () {
  const ctx = await treeWithInputSession();
  // 直接从树行菜单进入重命名：/r/b.md 是文件行
  rowOf(ctx.t.host, '/r/b.md').dispatch('contextmenu', { clientX: 5, clientY: 5, target: rowOf(ctx.t.host, '/r/b.md') });
  const menu = ctx.t.doc.body.querySelector('.tree-menu');
  assert.ok(menu);
  const labels = menu.querySelectorAll('.tree-menu-item').map((b) => b.textContent);
  assert.ok(labels.indexOf('tree.menu.rename') >= 0);
  const ren = menu.querySelectorAll('.tree-menu-item').find((b) => b.textContent === 'tree.menu.rename');
  ren.click();
  const input = ctx.t.host.querySelector('.tree-input');
  assert.strictEqual(input.value, 'b.md');
  assert.deepStrictEqual(input._selection, [0, 1], '只选主名 b，别让人一敲就把后缀打掉');
});

test('submitInput：新建把 dir / 用户输入 / kind 原样交给 session（不自拼 IPC）', async function () {
  const ctx = await treeWithInputSession();
  ctx.t.tree.openRootMenu(10, 10);
  ctx.t.doc.body.querySelector('.tree-menu').querySelectorAll('.tree-menu-item')[0].click();
  const input = ctx.t.host.querySelector('.tree-input');
  input.value = '新笔记';
  input.dispatch('keydown', { key: 'Enter' });
  await settle();
  assert.deepStrictEqual(ctx.calls.create, [{ dir: '/r', name: '新笔记', kind: 'file' }]);
  assert.strictEqual(ctx.t.host.querySelector('.tree-input'), null, '成功后输入行收起');
});

test('submitInput：重命名把旧路径 / 新名字原样交给 session', async function () {
  const ctx = await treeWithInputSession();
  rowOf(ctx.t.host, '/r/b.md').dispatch('contextmenu', { clientX: 5, clientY: 5, target: rowOf(ctx.t.host, '/r/b.md') });
  const ren = ctx.t.doc.body.querySelector('.tree-menu').querySelectorAll('.tree-menu-item')
    .find((b) => b.textContent === 'tree.menu.rename');
  ren.click();
  const input = ctx.t.host.querySelector('.tree-input');
  input.value = 'c.md';
  input.dispatch('keydown', { key: 'Enter' });
  await settle();
  assert.deepStrictEqual(ctx.calls.rename, [{ from: '/r/b.md', name: 'c.md' }]);
});

test('submitInput：失败保留输入行与原值，并把后端原因写进错误行', async function () {
  const ctx = await treeWithInputSession({ rejectCreate: Object.assign(new Error('名字重复'), { wording: '名字重复' }) });
  ctx.t.tree.openRootMenu(10, 10);
  ctx.t.doc.body.querySelector('.tree-menu').querySelectorAll('.tree-menu-item')[0].click();
  const input = ctx.t.host.querySelector('.tree-input');
  input.value = '重复';
  input.dispatch('keydown', { key: 'Enter' });
  await settle();
  assert.ok(ctx.t.host.querySelector('.tree-input'), '失败必须保留输入行');
  assert.strictEqual(ctx.t.host.querySelector('.tree-input').value, '重复');
  const err = ctx.t.host.querySelector('.tree-error');
  assert.strictEqual(err.hidden, false);
  assert.strictEqual(err.textContent, '名字重复');
});

test('submitInput：连按两次 Enter 只发一次命令', async function () {
  const ctx = await treeWithInputSession();
  ctx.t.tree.openRootMenu(10, 10);
  ctx.t.doc.body.querySelector('.tree-menu').querySelectorAll('.tree-menu-item')[0].click();
  const input = ctx.t.host.querySelector('.tree-input');
  input.value = '一次';
  input.dispatch('keydown', { key: 'Enter' });
  input.dispatch('keydown', { key: 'Enter' });
  await settle();
  assert.strictEqual(ctx.calls.create.length, 1);
});

test('openRootMenu：没有根时什么都不画（⛔ 弹一个什么都不能点的菜单）', async function () {
  const t = makeTree();
  t.tree.openRootMenu(10, 10);
  assert.strictEqual(t.doc.body.querySelector('.tree-menu'), null);
});

test('contextmenu：没有根时不拦截系统菜单', function () {
  const t = makeTree();
  const e = { clientX: 1, clientY: 1, target: t.host, defaultPrevented: false, preventDefault: function () { e.defaultPrevented = true; } };
  t.host.dispatch('contextmenu', e);
  assert.strictEqual(e.defaultPrevented, false);
});

test('contextmenu：忽略清单里的目录不给自制菜单', async function () {
  const S = fakeSession({
    state: { generation: 1, currentPath: null },
    listDir: async function () {
      return { decision: { commit: true }, result: { entries: [entry('/r/ign', true, { ignored: true })] } };
    },
  });
  const t = makeTree({ session: S });
  await t.tree.showRoot('/r', true);
  const row = rowOf(t.host, '/r/ign');
  row.dispatch('contextmenu', { clientX: 5, clientY: 5, target: row });
  assert.strictEqual(t.doc.body.querySelector('.tree-menu'), null);
});

test('openRootMenu：根菜单包含新建 / 复制路径 / 在访达中显示 / 收藏 / 刷新', async function () {
  const t = await twoLevelTree();
  t.tree.openRootMenu(10, 10);
  const menu = t.doc.body.querySelector('.tree-menu');
  assert.ok(menu);
  const labels = menu.querySelectorAll('.tree-menu-item').map((b) => b.textContent);
  assert.deepStrictEqual(labels, [
    'tree.menu.new-file',
    'tree.menu.new-folder',
    'tree.menu.copy-path',
    'tree.menu.reveal',
    'tree.menu.favorite',
    'tree.menu.refresh',
  ]);
});

test('openRootMenu：菜单坐标被夹在视口内（右下角不会跑出去）', async function () {
  const t = await twoLevelTree();
  t.win.innerWidth = 300;
  t.win.innerHeight = 200;
  t.tree.openRootMenu(9999, 9999);
  const menu = t.doc.body.querySelector('.tree-menu');
  assert.strictEqual(menu.style.left, '96px');  // 300 - 200 - 4
  assert.strictEqual(menu.style.top, '176px');  // 200 - 20 - 4
});
