// FindBar（`src/components/FindBar.js`）的组件层回归用例。
//
// 这里跑的是**真的产品文件**：`FindBar.js` 的四类切缝、计数、导航与生命周期，
// 只把 `document` 换成一个按 W3C 顺序走树的**最小假 DOM**（⛔ 不是整棵假页面）。
// 段边界的纯判据在 `services/find.js`（另有 services 族用例）；
// 本文件守的是"那些判据被组件正确接进建索引/搜索/计数/导航"这条链路。
//
// ⚠️ 高亮走 `CSS.highlights` 首选路线（零 DOM 变更）；`<mark>` 回退路线要真
// WebKit 的 `splitText`/`normalize`，归离屏探针，本文件不伪造它。
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
//
// 只实现 FindBar 真正用到的接口：元素/文本节点、TreeWalker（含 FILTER_REJECT
// 剪枝）、Range、`querySelectorAll`、`contains`、事件监听。⛔ 没有 CSS 布局、
// 没有 HTML 解析器——那两样不是本文件要验的对象。

const NF = {
  SHOW_ELEMENT: 1, SHOW_TEXT: 4,
  FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
};
global.NodeFilter = NF;

let doc = null;
const highlights = new Map();
global.CSS = { highlights: highlights };
global.Highlight = class Highlight {
  constructor() { this.ranges = Array.prototype.slice.call(arguments); }
  add() {}
};

function classSet(n) {
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
  let m = /^([a-zA-Z0-9-]+)?((?:\.[a-zA-Z0-9_-]+)*)(\[[a-zA-Z0-9_-]+\])?$/.exec(sel.trim());
  if (!m) return false;
  const tag = (m[1] || '').toLowerCase();
  if (tag && node.tagName.toLowerCase() !== tag) return false;
  const classes = (m[2] || '').split('.').filter(Boolean);
  for (let i = 0; i < classes.length; i++) if (!node.classList.contains(classes[i])) return false;
  const attrExpr = m[3];
  if (attrExpr) {
    const attr = attrExpr.slice(1, -1);
    if (!node.hasAttribute(attr)) return false;
  }
  return true;
}
function matchSel(node, sel) {
  const parts = String(sel || '').split(',');
  for (let i = 0; i < parts.length; i++) if (matchOne(node, parts[i])) return true;
  return false;
}

function makeTextNode(text) {
  const n = {
    nodeType: 3,
    nodeName: '#text',
    nodeValue: String(text == null ? '' : text),
    parentNode: null,
    childNodes: [],
    get textContent() { return n.nodeValue; },
    set textContent(v) { n.nodeValue = String(v); },
    appendChild: function () { throw new Error('文本节点不能 appendChild'); },
    remove: function () {
      const p = n.parentNode;
      if (!p) return;
      const i = p.childNodes.indexOf(n);
      if (i >= 0) p.childNodes.splice(i, 1);
      n.parentNode = null;
    },
    contains: function (x) { return x === n; },
    getBoundingClientRect: function () { return zeroRect(); },
    addEventListener: function () {},
    removeEventListener: function () {},
  };
  return n;
}

function zeroRect() {
  return { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
}

function makeElement(tag) {
  const n = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    dataset: {},
    style: {},
    hidden: false,
    title: '',
    type: '',
    value: '',
    tabIndex: -1,
    _attrs: Object.create(null),
    _listeners: Object.create(null),
    childNodes: [],
    parentNode: null,
  };
  n.classList = classSet(n);
  Object.defineProperty(n, 'className', {
    get: function () { return Array.from(n.classList._set).join(' '); },
    set: function (v) {
      n.classList._set.clear();
      String(v == null ? '' : v).split(/\s+/).forEach(function (c) { if (c) n.classList._set.add(c); });
    },
  });
  Object.defineProperty(n, 'children', {
    get: function () { return n.childNodes.filter(function (x) { return x.nodeType === 1; }); },
  });
  Object.defineProperty(n, 'firstChild', { get: function () { return n.childNodes[0] || null; } });
  Object.defineProperty(n, 'lastChild', { get: function () { return n.childNodes[n.childNodes.length - 1] || null; } });
  Object.defineProperty(n, 'textContent', {
    get: function () {
      return n.childNodes.map(function (c) { return c.textContent; }).join('');
    },
    set: function (v) {
      const s = String(v == null ? '' : v);
      for (let i = 0; i < n.childNodes.length; i++) n.childNodes[i].parentNode = null;
      n.childNodes.length = 0;
      if (s !== '') n.appendChild(makeTextNode(s));
    },
  });
  n.appendChild = function (c) {
    if (c.parentNode) c.remove();
    c.parentNode = n;
    n.childNodes.push(c);
    return c;
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
    c.parentNode = null;
    return c;
  };
  n.remove = function () { if (n.parentNode) n.parentNode.removeChild(n); };
  n.setAttribute = function (k, v) { n._attrs[k] = String(v); };
  n.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(n._attrs, k) ? n._attrs[k] : null; };
  n.hasAttribute = function (k) { return Object.prototype.hasOwnProperty.call(n._attrs, k); };
  n.removeAttribute = function (k) { delete n._attrs[k]; };
  n.addEventListener = function (type, fn) {
    (n._listeners[type] || (n._listeners[type] = [])).push(fn);
  };
  n.removeEventListener = function (type, fn) {
    const list = n._listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  n.fire = function (type, ev) {
    const e = ev || {};
    if (typeof e.preventDefault !== 'function') {
      e.preventDefault = function () { e.defaultPrevented = true; };
    }
    if (typeof e.stopPropagation !== 'function') {
      e.stopPropagation = function () { e._stopped = true; };
    }
    const list = (n._listeners[type] || []).slice();
    for (let i = 0; i < list.length; i++) list[i](e);
    return e;
  };
  n.contains = function (x) {
    let p = x;
    while (p) { if (p === n) return true; p = p.parentNode; }
    return false;
  };
  n.closest = function (sel) {
    let p = n;
    while (p) { if (matchOne(p, sel)) return p; p = p.parentNode; }
    return null;
  };
  n.querySelectorAll = function (sel) {
    const out = [];
    (function walk(x) {
      for (let i = 0; i < x.childNodes.length; i++) {
        const c = x.childNodes[i];
        if (c.nodeType === 1) {
          if (matchSel(c, sel)) out.push(c);
          walk(c);
        }
      }
    })(n);
    return out;
  };
  n.querySelector = function (sel) {
    const all = n.querySelectorAll(sel);
    return all.length ? all[0] : null;
  };
  n.focus = function () { if (doc) doc.activeElement = n; };
  n.blur = function () { if (doc && doc.activeElement === n) doc.activeElement = doc.body; };
  n.select = function () {};
  n.getBoundingClientRect = function () { return n._rect || zeroRect(); };
  n.setPointerCapture = function () {};
  n.releasePointerCapture = function () {};
  n.splitText = function (offset) {
    const text = n.nodeValue;
    const tail = makeTextNode(text.slice(offset));
    n.nodeValue = text.slice(0, offset);
    if (n.parentNode) {
      const i = n.parentNode.childNodes.indexOf(n);
      tail.parentNode = n.parentNode;
      n.parentNode.childNodes.splice(i + 1, 0, tail);
    }
    return tail;
  };
  n.normalize = function () {
    let i = 0;
    while (i < n.childNodes.length) {
      const c = n.childNodes[i];
      if (c.nodeType === 3) {
        while (n.childNodes[i + 1] && n.childNodes[i + 1].nodeType === 3) {
          c.nodeValue += n.childNodes[i + 1].nodeValue;
          n.childNodes[i + 1].parentNode = null;
          n.childNodes.splice(i + 1, 1);
        }
      } else if (c.nodeType === 1) {
        c.normalize();
      }
      i++;
    }
  };
  return n;
}

function makeTreeWalker(root, whatToShow, filter) {
  const stack = [];
  function pushChildren(n) {
    for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]);
  }
  pushChildren(root);
  return {
    nextNode: function () {
      while (stack.length) {
        const n = stack.pop();
        const shown = n.nodeType === 1 ? (whatToShow & NF.SHOW_ELEMENT)
          : (n.nodeType === 3 ? (whatToShow & NF.SHOW_TEXT) : 0);
        if (!shown) { pushChildren(n); continue; }
        const verdict = filter ? filter(n) : NF.FILTER_ACCEPT;
        if (verdict === NF.FILTER_REJECT) continue;
        if (verdict === NF.FILTER_SKIP) { pushChildren(n); continue; }
        pushChildren(n);
        return n;
      }
      return null;
    },
  };
}

function makeRange() {
  let sn = null, so = 0, en = null, eo = 0;
  return {
    setStart: function (n, o) { sn = n; so = o; },
    setEnd: function (n, o) { en = n; eo = o; },
    toString: function () {
      if (sn && sn === en) return sn.nodeValue.slice(so, eo);
      return '';
    },
    getBoundingClientRect: function () {
      return { width: 40, height: 16, top: 0, bottom: 16, left: 10, right: 50 };
    },
  };
}

function makeDocument() {
  const body = makeElement('body');
  const d = {
    body: body,
    documentElement: makeElement('html'),
    activeElement: body,
    _listeners: Object.create(null),
    createElement: makeElement,
    createTextNode: makeTextNode,
    createTreeWalker: makeTreeWalker,
    createRange: makeRange,
    addEventListener: function (type, fn) {
      (d._listeners[type] || (d._listeners[type] = [])).push(fn);
    },
    removeEventListener: function (type, fn) {
      const list = d._listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    fire: function (type, ev) {
      const e = ev || {};
      if (typeof e.preventDefault !== 'function') {
        e.preventDefault = function () { e.defaultPrevented = true; };
      }
      if (typeof e.stopPropagation !== 'function') {
        e.stopPropagation = function () { e._stopped = true; };
      }
      const list = (d._listeners[type] || []).slice();
      for (let i = 0; i < list.length; i++) list[i](e);
      return e;
    },
    querySelector: function (sel) { return body.querySelector(sel); },
    querySelectorAll: function (sel) { return body.querySelectorAll(sel); },
    contains: function (n) { return body.contains(n) || n === d.documentElement; },
  };
  body.parentNode = d;
  return d;
}

function fresh() {
  doc = makeDocument();
  global.document = doc;
  highlights.clear();
  const win = {
    rmd: {},
    __rmdLang: 'zh',
    document: doc,
    innerHeight: 800,
    innerWidth: 1200,
    scrollBy: function () {},
    _listeners: Object.create(null),
  };
  win.addEventListener = function (type, fn) {
    (win._listeners[type] || (win._listeners[type] = [])).push(fn);
  };
  win.removeEventListener = function (type, fn) {
    const list = win._listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  loadInto(win, 'src/services/i18n.js');
  loadInto(win, 'src/services/find.js');
  loadInto(win, 'src/services/keymap.js');
  loadInto(win, 'src/components/Settings.js');
  loadInto(win, 'src/components/FindBar.js');
  return win;
}

/** 造一个正文容器，挂进 `document.body`。 */
function makeDoc(children) {
  const root = makeElement('div');
  root.className = 'doc';
  (children || []).forEach(function (c) { root.appendChild(c); });
  doc.body.appendChild(root);
  return root;
}

function el(tag, cls, kids) {
  const n = makeElement(tag);
  if (cls) n.className = cls;
  (kids || []).forEach(function (c) { n.appendChild(c); });
  return n;
}

function p(kids) { return el('p', '', kids); }

async function drain(n) {
  for (let i = 0; i < (n || 12); i++) {
    await new Promise(function (r) { setTimeout(r, 0); });
  }
}

/** 让 `nowMs()` 每次跳 50 ms，把“分段构建”从同步路径挤出来。 */
function slowClock() {
  const real = global.performance;
  let t = 0;
  global.performance = { now: function () { t += 50; return t; } };
  return function () { global.performance = real; };
}

function findByClass(root, cls) {
  const all = root.querySelectorAll('.' + cls);
  return all.length ? all[0] : null;
}

function makeBar(win, root, extra) {
  const opts = Object.assign({
    getDoc: function () { return root; },
    keymap: {
      bindings: [
        { id: 'find.next', accel: 'Cmd+G' },
        { id: 'find.prev', accel: 'Cmd+Shift+G' },
      ],
    },
    keyText: function (id) { return id === 'find.next' ? '⌘G' : '⇧⌘G'; },
    nextId: 'find.next',
    prevId: 'find.prev',
  }, extra || {});
  return win.rmd.findBar.createFindBar(opts);
}

async function openReady(win, root, extra) {
  const bar = makeBar(win, root, extra);
  assert.strictEqual(bar.open(), true, '前置：有文档时 open() 应当成功');
  for (let i = 0; i < 30 && bar.state().phase !== 'ready'; i++) await drain(1);
  return bar;
}

function type(bar, q) {
  const input = findByClass(doc.body, 'find-input');
  input.value = q;
  input.fire('input', {});
  return input;
}

function countText() {
  return findByClass(doc.body, 'find-count').textContent;
}

function noteText() {
  return findByClass(doc.body, 'find-note').textContent;
}

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0003（make smoke 挂死且零输出——前端回报被后端静默拒收，应用永远不退出）
// 教训：查找链路里的错必须留在**浮层这一层**、看得见，⛔ 不许升级成全局故障。
// ═══════════════════════════════════════════════════════════════════════════

test('构建态计数显示省略号，⛔ 不把“已扫到的部分值”当总数', async function () {
  const win = fresh();
  const kids = [];
  for (let i = 0; i < 400; i++) kids.push(p([makeTextNode('段' + i)]));
  const root = makeDoc(kids);
  const restore = slowClock();
  try {
    const bar = makeBar(win, root);
    bar.open();
    assert.strictEqual(bar.state().phase, 'building');
    assert.strictEqual(countText(), '…', '构建中给了数字 ⇒ 会被误读成“这份文档就这么多命中”');
    await drain(20);
    assert.strictEqual(bar.state().phase, 'ready');
    assert.strictEqual(bar.state().segments, 400);
    bar.destroy();
  } finally {
    restore();
  }
});

test('建索引是“只按需”：open 之前一段都不扫', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')]), p([makeTextNode('乙')])]);
  const bar = makeBar(win, root);
  assert.strictEqual(bar.state().segments, 0, '构造时就建了索引（INV-FIND-08 被违反）');
  assert.strictEqual(bar.state().phase, 'idle');
  bar.destroy();
});

test('open() 后建索引，段数按块级容器计入 state()', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')]), p([makeTextNode('乙')])]);
  const bar = await openReady(win, root);
  assert.strictEqual(bar.state().segments, 2);
  bar.destroy();
});

test('搜索抛错时错误写在浮层说明行上，⛔ 不静默、也不改变索引状态', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲乙')])]);
  const bar = await openReady(win, root);
  const orig = win.rmd.find.matchAll;
  win.rmd.find.matchAll = function () { throw new Error('matchAll 炸了'); };
  try {
    type(bar, '甲');
    const note = noteText();
    assert.ok(note.indexOf('查找出错') >= 0, '浮层上没有用户看得见的错因：' + note);
    assert.ok(note.indexOf('matchAll 炸了') >= 0, '错因被吞掉了：' + note);
    assert.strictEqual(bar.state().phase, 'ready', '失败不该把索引打成未就绪');
  } finally {
    win.rmd.find.matchAll = orig;
    bar.destroy();
  }
});

test('文档提交成功后的 invalidate() 让旧命中与旧索引一起作废', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('旧文档')])]);
  const bar = await openReady(win, root);
  type(bar, '旧');
  assert.strictEqual(bar.state().total, 1);
  // 模拟自动重载：正文内容被换掉，然后 main.js 调 invalidate()
  root.textContent = '';
  root.appendChild(p([makeTextNode('新文档')]));
  bar.invalidate();
  await drain();
  // 输入框里仍是“旧”，新文档里没有它 ⇒ 0
  assert.strictEqual(bar.state().total, 0, '旧索引/旧命中没有随提交作废');
  bar.destroy();
});

test('invalidate() 后即使关键词还在，也按新正文重跑一次搜索', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('共同词 甲')])]);
  const bar = await openReady(win, root);
  type(bar, '共同词');
  assert.strictEqual(bar.state().total, 1);
  root.textContent = '';
  root.appendChild(p([makeTextNode('共同词 乙')]));
  bar.invalidate();
  await drain();
  assert.strictEqual(bar.state().total, 1, '重载后没有重跑当前输入（用户会看到“搜不到了”）');
  bar.destroy();
});

test('没有已挂载文档时 open() 返回 false，⛔ 不留下打开的浮层', async function () {
  const win = fresh();
  const bar = makeBar(win, null, { isAvailable: function () { return false; } });
  assert.strictEqual(bar.open(), false);
  assert.strictEqual(bar.isOpen(), false);
  bar.destroy();
});

test('toggle()：开着就关、关着就开', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = makeBar(win, root);
  assert.strictEqual(bar.toggle(), true);
  assert.strictEqual(bar.isOpen(), true);
  assert.strictEqual(bar.toggle(), true);
  assert.strictEqual(bar.isOpen(), false);
  bar.destroy();
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0010（make smoke-app 报 FAIL 6b——应用明明正常，是「可滚」判据把小样本判死了）
// 教训：判据要落在“用户真的看得见/输得进去”的那一层，不能靠别的现象反推。
// 这里把“浮层先可输入”与“命中数真实”分开验。
// ═══════════════════════════════════════════════════════════════════════════

test('段数按块级容器切：两个 <p> 之间的词⛔ 不许被拼成一处命中', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')]), p([makeTextNode('乙')])]);
  const bar = await openReady(win, root);
  type(bar, '甲乙');
  assert.strictEqual(bar.state().total, 0, '跨块命中 = 屏幕上不存在的词');
  bar.destroy();
});

test('<br> 是切缝：甲<br>乙 ⛔ 不许命中“甲乙”', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲'), el('br'), makeTextNode('乙')])]);
  const bar = await openReady(win, root);
  type(bar, '甲乙');
  assert.strictEqual(bar.state().total, 0);
  type(bar, '甲');
  assert.strictEqual(bar.state().total, 1, '正常文本被 <br> 误伤');
  bar.destroy();
});

test('<math> 子树被排除：甲<math>乙</math>丙 搜不到“甲乙”也搜不到“乙”', async function () {
  const win = fresh();
  const math = el('math', '', [makeTextNode('乙')]);
  const root = makeDoc([p([makeTextNode('甲'), math, makeTextNode('丙')])]);
  const bar = await openReady(win, root);
  type(bar, '甲乙');
  assert.strictEqual(bar.state().total, 0, '跨被跳过的公式命中');
  type(bar, '乙');
  assert.strictEqual(bar.state().total, 0, '公式内部内容被索引了');
  type(bar, '甲');
  assert.strictEqual(bar.state().total, 1, '公式两侧的正文被整段丢掉（INV-FIND-10）');
  type(bar, '丙');
  assert.strictEqual(bar.state().total, 1, '公式右侧的正文被整段丢掉');
  bar.destroy();
});

test('<svg> 与 <math> 同一条排除规则', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲'), el('svg', '', [makeTextNode('图')]), makeTextNode('乙')])]);
  const bar = await openReady(win, root);
  type(bar, '图');
  assert.strictEqual(bar.state().total, 0);
  type(bar, '甲乙');
  assert.strictEqual(bar.state().total, 0, '被排除子树的两侧没有切开');
  bar.destroy();
});

test('排版空白不进段：<p>甲</p> 外面的换行空白⛔ 不造出可命中的空格', async function () {
  const win = fresh();
  // comrak 会在块之间写排版换行；这里直接模拟那些“全空白”文本节点。
  const root = makeDoc([makeTextNode('\n  '), p([makeTextNode('甲')]), makeTextNode('\n  ')]);
  const bar = await openReady(win, root);
  type(bar, '甲');
  assert.strictEqual(bar.state().total, 1);
  type(bar, ' ');
  assert.strictEqual(bar.state().total, 0, '排版空白被当成正文搜到了');
  bar.destroy();
});

test('<pre> 里的空白是可见内容：⛔ 不许被“排版空白”规则删掉', async function () {
  const win = fresh();
  const pre = el('pre', '', [makeTextNode('甲'), makeTextNode(' '), makeTextNode('乙')]);
  const root = makeDoc([pre]);
  const bar = await openReady(win, root);
  type(bar, '甲 乙');
  assert.strictEqual(bar.state().total, 1, '<pre> 内的空格被误当排版空白');
  bar.destroy();
});

test('空文本节点不是切缝：<span>甲</span><span>乙</span> 仍应拼成同一段', async function () {
  const win = fresh();
  const root = makeDoc([p([
    el('span', '', [makeTextNode('甲')]),
    el('span', '', [makeTextNode('')]),
    el('span', '', [makeTextNode('乙')]),
  ])]);
  const bar = await openReady(win, root);
  type(bar, '甲乙');
  assert.strictEqual(bar.state().total, 1, '空节点造出了假段边界');
  bar.destroy();
});

test('列表项离开 <p> 回到 <li> 也切缝：<li>甲<p>中</p>乙</li> 搜不到“中乙”', async function () {
  const win = fresh();
  const li = el('li', '', [makeTextNode('甲'), p([makeTextNode('中')]), makeTextNode('乙')]);
  const root = makeDoc([el('ul', '', [li])]);
  const bar = await openReady(win, root);
  type(bar, '中乙');
  assert.strictEqual(bar.state().total, 0, '按“进入块级容器”切会把中乙拼成一段');
  type(bar, '乙');
  assert.strictEqual(bar.state().total, 1);
  bar.destroy();
});

test('表格每个单元格各自成段：相邻单元格的词⛔ 不许拼起来', async function () {
  const win = fresh();
  const tr = el('tr', '', [
    el('td', '', [makeTextNode('甲')]),
    el('td', '', [makeTextNode('乙')]),
  ]);
  const root = makeDoc([el('table', '', [el('tbody', '', [tr])])]);
  const bar = await openReady(win, root);
  type(bar, '甲乙');
  assert.strictEqual(bar.state().total, 0);
  bar.destroy();
});

test('同一段内多数字符串仍是一个偏移空间（中文不会被切开）', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('中文正文')])]);
  const bar = await openReady(win, root);
  type(bar, '正文');
  assert.strictEqual(bar.state().total, 1);
  type(bar, '中文');
  assert.strictEqual(bar.state().total, 1);
  bar.destroy();
});

test('Emoji 代理对：搜索整颗 Emoji 命中，⛔ 不许从半个代理对切', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('前😀后')])]);
  const bar = await openReady(win, root);
  type(bar, '😀');
  assert.strictEqual(bar.state().total, 1, '整颗 Emoji 没命中 ⇒ 偏移空间错了');
  bar.destroy();
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0019（其他程序在目录里新增文档，目录树里不出现（手动刷新也没用））
// 同族形态：旧内容/旧索引被当成新结果。这里守 FindBar 的“提交即作废”。
// ═══════════════════════════════════════════════════════════════════════════

test('作废后旧索引立刻不可见，重建期间不会拿旧 segs 继续用', async function () {
  const win = fresh();
  const kids = [];
  for (let i = 0; i < 400; i++) kids.push(p([makeTextNode('段' + i)]));
  const root = makeDoc(kids);
  const restore = slowClock();
  try {
    const bar = makeBar(win, root);
    bar.open();
    assert.strictEqual(bar.state().phase, 'building');
    bar.invalidate();               // 构建还没跑完就作废
    assert.strictEqual(bar.state().segments, 0, '作废后旧 segs 还挂着');
    assert.strictEqual(bar.state().phase, 'building', '作废后必须重新开始建');
    await drain(20);
    assert.strictEqual(bar.state().phase, 'ready');
    assert.strictEqual(bar.state().segments, 400);
    bar.destroy();
  } finally {
    restore();
  }
});

test('浮层开着时 invalidate() 会立刻重建，⛔ 不留“搜不到了”的空窗', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  root.textContent = '';
  root.appendChild(p([makeTextNode('乙')]));
  bar.invalidate();
  // 小文档会在一轮同步扫描里就绪；关键是它**没有停在旧索引上**。
  await drain();
  assert.strictEqual(bar.state().phase, 'ready');
  assert.strictEqual(bar.state().segments, 1);
  type(bar, '乙');
  assert.strictEqual(bar.state().total, 1, '重建后的索引里没有新正文');
  bar.destroy();
});

test('浮层关着时 invalidate() 只作废、不偷偷建索引', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  bar.close();
  bar.invalidate();
  await drain();
  assert.strictEqual(bar.state().phase, 'idle');
  assert.strictEqual(bar.state().segments, 0);
  bar.destroy();
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0001（点击文档里的链接，整个应用会重载一遍）
// 同族形态：一个组件的失败逃到全局通道。FindBar 的 guard() 就是为此存在的。
// ═══════════════════════════════════════════════════════════════════════════

test('输入事件里的异常被 guard 接住，浮层仍在、状态仍可读', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  const orig = win.rmd.find.normalizeQuery;
  win.rmd.find.normalizeQuery = function () { throw new Error('归一化炸了'); };
  try {
    type(bar, '甲');
    assert.strictEqual(bar.isOpen(), true);
    assert.ok(noteText().indexOf('归一化炸了') >= 0);
  } finally {
    win.rmd.find.normalizeQuery = orig;
    bar.destroy();
  }
});

test('关闭路径的异常也落到浮层说明行，⛔ 不升级成全局故障', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  const origF = win.rmd.find.HL_ALL;
  Object.defineProperty(win.rmd.find, 'HL_ALL', { configurable: true, get: function () { throw new Error('HL_ALL 炸了'); } });
  try {
    const close = findByClass(doc.body, 'find-close');
    close.fire('click', {});
    assert.ok(noteText().indexOf('HL_ALL 炸了') >= 0, '关闭路径的异常没有落到浮层说明行');
    assert.strictEqual(bar.isOpen(), false, 'close() 已经从“打开”退出来了');
  } finally {
    Object.defineProperty(win.rmd.find, 'HL_ALL', { configurable: true, value: origF });
    bar.destroy();
  }
});

test('destroy() 摘掉 document 级 keydown，⛔ 不留全局监听', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const before = (doc._listeners.keydown || []).length;
  const bar = await openReady(win, root);
  assert.strictEqual((doc._listeners.keydown || []).length, before + 1);
  bar.destroy();
  assert.strictEqual((doc._listeners.keydown || []).length, before);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0009（编辑态开着 Vim 时，冒号与斜杠的输入框在「主题 ≠ 系统外观」下是隐形的）
// 教训：中文组合态里 Enter/↑↓ 属于输入法，⛔ 不能被应用当成动作。
// ═══════════════════════════════════════════════════════════════════════════

test('组合态下 Enter 不移动命中（中文候选窗的上屏键）', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲甲')])]);
  const bar = await openReady(win, root);
  type(bar, '甲');
  assert.strictEqual(bar.state().total, 2);
  assert.strictEqual(bar.state().current, 0);
  doc.fire('keydown', { key: 'Enter', isComposing: true });
  assert.strictEqual(bar.state().current, 0, '组合态的 Enter 被当成“下一处”');
  bar.destroy();
});

test('keyCode 229 也算组合态（老 WebKit 只给这个）', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲甲')])]);
  const bar = await openReady(win, root);
  type(bar, '甲');
  doc.fire('keydown', { key: 'ArrowDown', keyCode: 229 });
  assert.strictEqual(bar.state().current, 0);
  bar.destroy();
});

test('非组合态 Enter 才移动，Shift+Enter 反向', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲甲甲')])]);
  const bar = await openReady(win, root);
  type(bar, '甲');
  doc.fire('keydown', { key: 'Enter', isComposing: false });
  assert.strictEqual(bar.state().current, 1);
  doc.fire('keydown', { key: 'Enter', shiftKey: true, isComposing: false });
  assert.strictEqual(bar.state().current, 0, 'Shift+Enter 没有反向');
  bar.destroy();
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0003（make smoke 挂死且零输出——前端回报被后端静默拒收，应用永远不退出）
// 另半条：`probe()` 必须自己走完整条路径，且失败要写在返回对象里。
// ═══════════════════════════════════════════════════════════════════════════

test('probe()：有正文时命中 ≥1、哨兵命中 0、高亮区间读出来等于探测词', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('可探测的中文正文')])]);
  const bar = makeBar(win, root);
  const out = await bar.probe();
  assert.strictEqual(out.open, true);
  assert.ok(out.hits >= 1, '探测词没命中：' + JSON.stringify(out));
  assert.strictEqual(out.miss, 0, '哨兵词应当命中 0 处');
  assert.strictEqual(out.text_ok, true, '高亮区间读出来与探测词不一致（偏移错位）');
  assert.strictEqual(out.building, false);
  assert.strictEqual(bar.isOpen(), false, 'probe 收尾必须关掉浮层');
  bar.destroy();
});

test('probe()：没有已挂载文档时返回 open=false 并说明原因', async function () {
  const win = fresh();
  const bar = makeBar(win, null, { isAvailable: function () { return false; } });
  const out = await bar.probe();
  assert.strictEqual(out.open, false);
  assert.ok(out.note.indexOf('没有已挂载的文档') >= 0);
  assert.strictEqual(bar.isOpen(), false);
  bar.destroy();
});

test('probe()：正文只有空白时响亮地说“探测不了”', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('    ')])]);
  const bar = makeBar(win, root);
  const out = await bar.probe();
  assert.strictEqual(out.open, true);
  assert.strictEqual(out.seg, 0, '排版空白被当成了段');
  assert.ok(out.note.indexOf('找不到可用的非空白词') >= 0, out.note);
  bar.destroy();
});

test('probe() 的失败不许把异常抛给调用方（它是仪表，不是被测物）', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = makeBar(win, root);
  const orig = win.rmd.find.probeQueryText;
  win.rmd.find.probeQueryText = function () { throw new Error('探测件坏了'); };
  try {
    const out = await bar.probe();
    assert.strictEqual(out.open, true);
    assert.ok(out.note.indexOf('探测件坏了') >= 0, out.note);
    assert.strictEqual(bar.isOpen(), false, '异常路径也必须收尾关浮层');
  } finally {
    win.rmd.find.probeQueryText = orig;
    bar.destroy();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0009（编辑态开着 Vim 时，冒号与斜杠的输入框在「主题 ≠ 系统外观」下是隐形的）
// 同族：浮层自己那套键的归属。Esc / Tab / ↑↓ / ⌘G 各走各的路。
// ═══════════════════════════════════════════════════════════════════════════

test('Esc 关闭浮层，并清掉高亮', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  type(bar, '甲');
  assert.strictEqual(highlights.has('rmd-find'), true);
  doc.fire('keydown', { key: 'Escape' });
  assert.strictEqual(bar.isOpen(), false);
  assert.strictEqual(highlights.has('rmd-find'), false, '关闭后高亮没清干净');
  bar.destroy();
});

test('↓/↑ 移动命中并环绕', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲甲')])]);
  const bar = await openReady(win, root);
  type(bar, '甲');
  doc.fire('keydown', { key: 'ArrowDown' });
  assert.strictEqual(bar.state().current, 1);
  doc.fire('keydown', { key: 'ArrowDown' });
  assert.strictEqual(bar.state().current, 0, '↓ 没有环绕');
  doc.fire('keydown', { key: 'ArrowUp' });
  assert.strictEqual(bar.state().current, 1, '↑ 没有环绕');
  bar.destroy();
});

test('Tab 把焦点送回输入框', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  const input = findByClass(doc.body, 'find-input');
  doc.activeElement = doc.body;
  doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(doc.activeElement, input);
  bar.destroy();
});

test('⌘G / ⇧⌘G 从后端 bindings 认出来（⛔ 不在组件里写字面量）', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲甲')])]);
  const bar = await openReady(win, root);
  type(bar, '甲');
  doc.fire('keydown', { key: 'g', metaKey: true });
  assert.strictEqual(bar.state().current, 1);
  doc.fire('keydown', { key: 'g', metaKey: true, shiftKey: true });
  assert.strictEqual(bar.state().current, 0);
  bar.destroy();
});

test('浮层没开时 next()/prev() 是明确的 no-op，⛔ 不顺手打开浮层', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  bar.close();
  assert.strictEqual(bar.next(), false);
  assert.strictEqual(bar.prev(), false);
  assert.strictEqual(bar.isOpen(), false);
  bar.destroy();
});

test('没有命中时 next()/prev() 不抛、不改变 current', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  type(bar, '没有这个词');
  assert.strictEqual(bar.state().total, 0);
  assert.strictEqual(bar.next(), false);   // 没有命中 ⇒ 明确的 no-op
  assert.strictEqual(bar.state().current, -1);
  bar.destroy();
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0003（make smoke 挂死且零输出——前端回报被后端静默拒收，应用永远不退出）
// 计数诚实：上限只截视觉标记，⛔ 不截总数（INV-FIND-05）。
// ═══════════════════════════════════════════════════════════════════════════

test('高亮上限之外：总数仍是真实值，当前那处照样有高亮', async function () {
  const win = fresh();
  const big = 'a'.repeat(2105);            // 2105 处非重叠命中
  const root = makeDoc([p([makeTextNode(big)])]);
  const bar = await openReady(win, root);
  type(bar, 'a');
  assert.strictEqual(bar.state().total, 2105, '计数被高亮上限截断了');
  assert.strictEqual(countText(), '1 / 2 105', '计数文案不是真实总数：' + countText());
  assert.strictEqual(highlights.has('rmd-find'), true);
  assert.strictEqual(highlights.has('rmd-find-current'), true);
  assert.ok(noteText().indexOf('2 000') >= 0, '上限说明里没有“已高亮前 2 000 处”');
  assert.ok(noteText().indexOf('2 105') >= 0, '上限说明里丢掉了真实总数');
  bar.destroy();
});

test('无结果时计数文案是“无结果”，⛔ 不是 0 / 0', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  type(bar, '不存在');
  assert.strictEqual(countText(), '无结果');
  bar.destroy();
});

test('空关键词 / 纯空白关键词 ⇒ 没有命中、没有高亮、计数清空', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  type(bar, '甲');
  assert.strictEqual(bar.state().total, 1);
  type(bar, '   ');
  assert.strictEqual(bar.state().total, 0);
  assert.strictEqual(bar.state().current, -1);
  assert.strictEqual(countText(), '');
  assert.strictEqual(highlights.has('rmd-find'), false);
  bar.destroy();
});

test('千位分隔用空格：1050 处显示 “1 / 1 050”', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('a'.repeat(1050))])]);
  const bar = await openReady(win, root);
  type(bar, 'a');
  assert.strictEqual(countText(), '1 / 1 050');
  bar.destroy();
});

test('搜索范围提示常驻，且是说明行的第一段', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  const note = noteText();
  assert.ok(note.indexOf('范围：渲染后的正文') === 0, '范围提示不在第一段：' + note);
  bar.destroy();
});

test('说明行同时带键位提示，切走关键词也不消失', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  type(bar, '不存在');
  const note = noteText();
  assert.ok(note.indexOf('下一个 ⌘G') >= 0, note);
  assert.ok(note.indexOf('上一个 ⇧⌘G') >= 0, note);
  bar.destroy();
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
// 同族形态：旧请求/旧输入的回包落到新界面上。这里守 runSearch 的“每轮先清”。
// ═══════════════════════════════════════════════════════════════════════════

test('连续两次搜索：上一轮的高亮先清掉，不残留旧关键词的区间', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲甲 乙乙')])]);
  const bar = await openReady(win, root);
  type(bar, '甲');
  const all1 = highlights.get('rmd-find').ranges.length;
  assert.strictEqual(all1, 2);
  type(bar, '乙');
  const all2 = highlights.get('rmd-find').ranges.length;
  assert.strictEqual(all2, 2, '高亮集合被覆盖成了新旧混合');
  bar.destroy();
});

test('搜不到任何东西时旧高亮必须消失', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  type(bar, '甲');
  assert.strictEqual(highlights.has('rmd-find'), true);
  type(bar, '不存在');
  assert.strictEqual(highlights.has('rmd-find'), false, '旧高亮留在了正文上');
  assert.strictEqual(highlights.has('rmd-find-current'), false);
  bar.destroy();
});

test('关闭再打开：输入框里的旧词接得上，命中重新算', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲甲')])]);
  const bar = await openReady(win, root);
  type(bar, '甲');
  assert.strictEqual(bar.state().total, 2);
  bar.close();
  assert.strictEqual(bar.state().current, -1, '关闭后 current 没复位');
  bar.open();
  assert.strictEqual(bar.state().total, 2, '重开后旧词没有接上');
  assert.strictEqual(bar.state().current, 0);
  bar.destroy();
});

test('close() 幂等：关两次不抛', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  bar.close();
  bar.close();
  assert.strictEqual(bar.isOpen(), false);
  bar.destroy();
});

test('open() 幂等：已开时返回 true 且不重复建索引', async function () {
  const win = fresh();
  const root = makeDoc([p([makeTextNode('甲')])]);
  const bar = await openReady(win, root);
  const segs = bar.state().segments;
  assert.strictEqual(bar.open(), true);
  assert.strictEqual(bar.state().segments, segs);
  bar.destroy();
});
