// ImageViewer（`src/components/ImageViewer.js`）的组件层回归用例。
//
// 缩放数学在 `services/imagezoom.js`（另有 services 族用例）；本文件守的是
// **组件把那些数学接进打开事务、键盘分层、指针拖动、背景隔离**这条链路。
// 只把 `document` 换成一个最小假 DOM；图片的 `naturalWidth` 等由夹具直接给。
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
  const m = /^([a-zA-Z0-9-]+)?((?:\.[a-zA-Z0-9_-]+)*)(\[[a-zA-Z0-9_-]+\])?$/.exec(String(sel).trim());
  if (!m) return false;
  const tag = (m[1] || '').toLowerCase();
  if (tag && node.tagName.toLowerCase() !== tag) return false;
  const cls = (m[2] || '').split('.').filter(Boolean);
  for (let i = 0; i < cls.length; i++) if (!node.classList.contains(cls[i])) return false;
  if (m[3] && !node.hasAttribute(m[3].slice(1, -1))) return false;
  return true;
}
function zeroRect() {
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
    style: {}, hidden: false, title: '', type: '', value: '',
    tabIndex: -1, naturalWidth: 0, naturalHeight: 0, complete: true,
    _attrs: Object.create(null), _listeners: Object.create(null), childNodes: [], parentNode: null,
  };
  n.classList = classSet(n);
  // ⚠️ 真实 DOM 里 `dataset.fooBar` 与 `data-foo-bar` 是同一份数据；这里也做双向映射，
  //    否则产品代码写的 `dataset.act` 在 `closest('button[data-act]')` 里看不见。
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
  });
  // `alt` / `src` / `href` 在真实 DOM 里是反射属性；标题取的是 `getAttribute('alt')`。
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
  n.addEventListener = function (type, fn) { (n._listeners[type] || (n._listeners[type] = [])).push(fn); };
  n.removeEventListener = function (type, fn) {
    const list = n._listeners[type] || []; const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  n.fire = function (type, ev) {
    const e = ev || {};
    if (typeof e.preventDefault !== 'function') e.preventDefault = function () { e.defaultPrevented = true; };
    if (typeof e.stopPropagation !== 'function') e.stopPropagation = function () { e._stopped = true; };
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
  n.getBoundingClientRect = function () { return n._rect || zeroRect(); };
  n.setPointerCapture = function () {};
  n.releasePointerCapture = function () {};
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
    innerWidth: 1200, innerHeight: 800,
    _listeners: Object.create(null),
  };
  win.addEventListener = function (type, fn) {
    (win._listeners[type] || (win._listeners[type] = [])).push(fn);
  };
  win.removeEventListener = function (type, fn) {
    const list = win._listeners[type] || []; const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  win.fire = function (type, ev) {
    const e = ev || {};
    if (typeof e.preventDefault !== 'function') e.preventDefault = function () { e.defaultPrevented = true; };
    if (typeof e.stopPropagation !== 'function') e.stopPropagation = function () { e._stopped = true; };
    const list = (win._listeners[type] || []).slice();
    for (let i = 0; i < list.length; i++) list[i](e);
    return e;
  };
  loadInto(win, 'src/services/i18n.js');
  loadInto(win, 'src/services/imagezoom.js');
  loadInto(win, 'src/services/keymap.js');
  loadInto(win, 'src/components/Settings.js');
  loadInto(win, 'src/components/ImageViewer.js');
  return win;
}

function stageRect(w, h) {
  return { width: w, height: h, top: 0, bottom: h, left: 0, right: w };
}

function image(opts) {
  const img = makeElement('img');
  img.className = 'rmd-zoomable';
  img.setAttribute('src', (opts && opts.src) || 'data:image/png;base64,AAAA');
  img.naturalWidth = opts && Object.prototype.hasOwnProperty.call(opts, 'w') ? opts.w : 2000;
  img.naturalHeight = opts && Object.prototype.hasOwnProperty.call(opts, 'h') ? opts.h : 1500;
  img.complete = opts && Object.prototype.hasOwnProperty.call(opts, 'complete') ? opts.complete : true;
  if (opts && opts.alt) img.setAttribute('alt', opts.alt);
  if (opts && opts.realPath) img.dataset.realPath = opts.realPath;
  if (opts && opts.appended !== false) doc.body.appendChild(img);
  return img;
}

function viewerWith(win, w, h) {
  const v = win.rmd.imageViewer.createImageViewer();
  const stage = doc.body.querySelector('.image-viewer-stage');
  stage._rect = stageRect(w || 800, h || 600);
  const img = doc.body.querySelector('.image-viewer-img');
  return { v: v, stage: stage, viewImg: img };
}
function btnByAct(act) {
  const all = doc.body.querySelectorAll('button');
  for (let i = 0; i < all.length; i++) if (all[i].dataset.act === act) return all[i];
  return null;
}
/** 假 DOM 没有冒泡：工具条的处理挂在容器上，所以要在容器上 fire、target 给按钮。 */
function clickAct(act) {
  const btn = btnByAct(act);
  assert.ok(btn, '找不到工具按钮：' + act);
  doc.body.querySelector('.image-viewer-controls').fire('click', { target: btn });
  return btn;
}
function scaleText() { return doc.body.querySelector('.image-viewer-scale').textContent; }
function transform() { return doc.body.querySelector('.image-viewer-img').style.transform; }

function near(a, b, eps) {
  assert.ok(Math.abs(a - b) <= (eps == null ? 1e-9 : eps), a + ' 不等于 ' + b);
}

/** `mapState` 用到的关键状态：从 transform 里读回平移与比例。 */
function decodedTransform() {
  const m = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)$/.exec(transform());
  assert.ok(m, 'transform 格式不对：' + transform());
  return { tx: Number(m[1]), ty: Number(m[2]), scale: Number(m[3]) };
}

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0068（图里的字比正文大两三倍，而且只有部分图这样）
// 教训：图片显示尺寸必须由“图片自然尺寸 × 布局”算出来，⛔ 不能拿像素值当布局值。
// 这里守预览层的“适应/初始比例/上限下界”真的由 imagezoom 那一份数学决定。
// ═══════════════════════════════════════════════════════════════════════════

test('大图打开时初始比例是“适应”，⛔ 不是 100% 把图裁掉', async function () {
  const win = fresh();
  const { v } = viewerWith(win, 400, 300);
  const img = image({ w: 2000, h: 1500 });
  assert.strictEqual(v.open(img), true);
  const st = decodedTransform();
  assert.ok(st.scale > 0 && st.scale < 1, '大图初始比例不是缩小后的 fit：' + st.scale);
  assert.strictEqual(scaleText(), Math.round(st.scale * 100) + '%');
  v.close();
});

test('小图打开时初始比例是 100%，⛔ 不放大到铺满', async function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({ w: 100, h: 80 });
  assert.strictEqual(v.open(img), true);
  assert.strictEqual(decodedTransform().scale, 1);
  assert.strictEqual(scaleText(), '100%');
  v.close();
});

test('“实际大小”把比例钉回 1，且 mode 变成手动（resize 不再被 fit 顶走）', async function () {
  const win = fresh();
  const { v, stage } = viewerWith(win, 400, 300);
  const img = image({ w: 2000, h: 1500 });
  v.open(img);
  clickAct('actual');
  near(decodedTransform().scale, 1);
  stage._rect = stageRect(800, 600);
  win.fire('resize', {});
  near(decodedTransform().scale, 1, 1e-9);
  v.close();
});

test('“适应”会把小图放大到铺满（与打开时的 100% 是两件事）', async function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({ w: 100, h: 80 });
  v.open(img);
  clickAct('fit');
  assert.ok(decodedTransform().scale > 1, '“适应”没有放大铺满');
  v.close();
});

test('放大有绝对上限：连点 20 次不超过 800%', async function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({ w: 100, h: 80 });
  v.open(img);
  for (let i = 0; i < 20; i++) clickAct('zoom-in');
  assert.strictEqual(decodedTransform().scale, 8);
  assert.strictEqual(scaleText(), '800%');
  v.close();
});

test('缩小有绝对下界，比例恒为正有限数', async function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({ w: 100, h: 80 });
  v.open(img);
  for (let i = 0; i < 20; i++) clickAct('zoom-out');
  const st = decodedTransform();
  assert.strictEqual(st.scale, 1 / 64);
  assert.ok(isFinite(st.tx) && isFinite(st.ty));
  v.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0001（点击文档里的链接，整个应用会重载一遍）
// 教训：图片预览的点击委托必须排在链接委托之前，并把事件吃掉（preventDefault）。
// ═══════════════════════════════════════════════════════════════════════════

test('zoomTarget：直接点 img.rmd-zoomable 命中它自己', function () {
  const win = fresh();
  const img = image({});
  assert.strictEqual(win.rmd.imageViewer.zoomTarget(img), img);
});

test('zoomTarget：点包着图的链接，命中的是里面的图（看图优先）', function () {
  const win = fresh();
  const a = makeElement('a');
  a.setAttribute('href', 'other.md');
  const img = image({ appended: false });
  a.appendChild(img);
  doc.body.appendChild(a);
  assert.strictEqual(win.rmd.imageViewer.zoomTarget(a), img);
});

test('zoomTarget：普通链接（里面没有可缩放图）返回 null', function () {
  const win = fresh();
  const a = makeElement('a');
  a.setAttribute('href', 'other.md');
  a.appendChild(makeTextNode('普通链接'));
  doc.body.appendChild(a);
  assert.strictEqual(win.rmd.imageViewer.zoomTarget(a), null);
});

test('zoomTarget：不可缩放的 img（没有 rmd-zoomable）不接管', function () {
  const win = fresh();
  const img = makeElement('img');
  img.setAttribute('src', 'https://example.com/a.png');
  doc.body.appendChild(img);
  assert.strictEqual(win.rmd.imageViewer.zoomTarget(img), null);
});

test('zoomTarget：嵌套在 span 里的图也能从链接上找到', function () {
  const win = fresh();
  const a = makeElement('a');
  a.setAttribute('href', 'x.md');
  const span = makeElement('span');
  const img = image({ appended: false });
  span.appendChild(img); a.appendChild(span); doc.body.appendChild(a);
  assert.strictEqual(win.rmd.imageViewer.zoomTarget(a), img);
});

test('zoomTarget：null / 纯文本节点 / 无 closest 的输入不抛', function () {
  const win = fresh();
  assert.strictEqual(win.rmd.imageViewer.zoomTarget(null), null);
  assert.strictEqual(win.rmd.imageViewer.zoomTarget(makeTextNode('x')), null);
  assert.strictEqual(win.rmd.imageViewer.zoomTarget({}), null);
});

test('installDelegation：点图时 preventDefault + stopPropagation，然后 open', function () {
  const win = fresh();
  const docEl = makeElement('div');
  doc.body.appendChild(docEl);
  const img = image({ appended: false });
  docEl.appendChild(img);
  const opened = [];
  const off = win.rmd.imageViewer.installDelegation(docEl, function () {
    return { open: function (x) { opened.push(x); } };
  });
  const ev = docEl.fire('click', { target: img });
  assert.strictEqual(ev.defaultPrevented, true, '图片点击没有吃掉链接的默认行为');
  assert.strictEqual(ev._stopped, true);
  assert.deepStrictEqual(opened, [img]);
  off();
});

test('installDelegation：点普通文本不 preventDefault、不打开', function () {
  const win = fresh();
  const docEl = makeElement('div');
  doc.body.appendChild(docEl);
  docEl.appendChild(makeTextNode('正文'));
  let called = 0;
  win.rmd.imageViewer.installDelegation(docEl, function () { return { open: function () { called++; } }; });
  const ev = docEl.fire('click', { target: docEl.childNodes[0] });
  assert.strictEqual(ev.defaultPrevented, undefined);
  assert.strictEqual(called, 0);
});

test('installDelegation：键盘 Enter / Space 落在图上也能打开', function () {
  const win = fresh();
  const docEl = makeElement('div');
  doc.body.appendChild(docEl);
  const img = image({ appended: false });
  docEl.appendChild(img);
  const opened = [];
  win.rmd.imageViewer.installDelegation(docEl, function () { return { open: function (x) { opened.push(x); } }; });
  docEl.fire('keydown', { key: 'Enter', target: img });
  docEl.fire('keydown', { key: ' ', target: img });
  assert.deepStrictEqual(opened, [img, img]);
});

test('installDelegation：其他键不吞', function () {
  const win = fresh();
  const docEl = makeElement('div');
  doc.body.appendChild(docEl);
  const img = image({ appended: false });
  docEl.appendChild(img);
  let called = 0;
  win.rmd.imageViewer.installDelegation(docEl, function () { return { open: function () { called++; } }; });
  const ev = docEl.fire('keydown', { key: 'a', target: img });
  assert.strictEqual(ev.defaultPrevented, undefined);
  assert.strictEqual(called, 0);
});

test('installDelegation：卸载之后点击不再接管', function () {
  const win = fresh();
  const docEl = makeElement('div');
  doc.body.appendChild(docEl);
  const img = image({ appended: false });
  docEl.appendChild(img);
  let called = 0;
  const off = win.rmd.imageViewer.installDelegation(docEl, function () { return { open: function () { called++; } }; });
  off();
  docEl.fire('click', { target: img });
  assert.strictEqual(called, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0059（点正文里的链接会进入编辑状态）
// 同族：看图/点链接/进编辑三件事的先后判据。预览层只认“真的能预览”的图。
// ═══════════════════════════════════════════════════════════════════════════

test('open()：远程图 ⛔ 不进预览层（零新增网络请求）', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({ src: 'https://example.com/a.png' });
  assert.strictEqual(v.open(img), false);
  assert.strictEqual(v.isOpen(), false);
});

test('open()：blob: / file: / data:text 都不算可预览', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  ['blob:https://x/y', 'file:///tmp/a.png', 'data:text/html,<b>x</b>'].forEach(function (src) {
    const img = image({ src: src });
    assert.strictEqual(v.open(img), false, src + ' 被当成了可预览图');
  });
});

test('open()：data:image 大小写与首尾空白都接受', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({ src: '  DATA:IMAGE/PNG;base64,AAAA  ' });
  assert.strictEqual(v.open(img), true);
  v.close();
});

test('open()：图片还没解码成功（naturalWidth=0）⇒ 不打开', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({ w: 0, h: 1500 });
  assert.strictEqual(v.open(img), false);
});

test('open()：complete === false ⇒ 不打开（⛔ 用布局占位尺寸冒充已解码）', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({ complete: false });
  assert.strictEqual(v.open(img), false);
});

test('open()：不在文档里的元素 ⇒ 不打开', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({ appended: false });
  assert.strictEqual(v.open(img), false);
});

test('open()：量不到舞台尺寸时回滚，且⛔ 不碰别的覆盖层（事务式）', function () {
  const win = fresh();
  const calls = [];
  win.rmd.settings.closeOtherOverlays = function (name) { calls.push(name); };
  const { v, stage } = viewerWith(win, 0, 0);
  stage._rect = stageRect(0, 0);
  const img = image({});
  assert.strictEqual(v.open(img), false);
  assert.deepStrictEqual(calls, [], '准入失败却先把别的覆盖层关了');
  assert.strictEqual(doc.body.querySelector('.image-viewer-layer').hidden, true, '失败后预览层没有回滚隐藏');
});

test('open()：成功后关闭其他覆盖层（同一时刻至多一层）', function () {
  const win = fresh();
  const calls = [];
  win.rmd.settings.closeOtherOverlays = function (name) { calls.push(name); };
  const { v } = viewerWith(win, 800, 600);
  const img = image({});
  assert.strictEqual(v.open(img), true);
  assert.deepStrictEqual(calls, ['image-viewer']);
  v.close();
});

test('open()：标题优先用 alt，其次用真实路径 basename，最后兜底文案', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const a = image({ alt: '说明文字' });
  v.open(a);
  assert.strictEqual(doc.body.querySelector('.image-viewer-caption').textContent, '说明文字');
  v.close();

  const b = image({ realPath: '/tmp/目录/图.png' });
  v.open(b);
  assert.strictEqual(doc.body.querySelector('.image-viewer-caption').textContent, '图.png');
  v.close();

  const c = image({});
  v.open(c);
  assert.strictEqual(doc.body.querySelector('.image-viewer-caption').textContent, '图片预览');
  v.close();
});

test('open()：预览层 <img> 的 src 用 currentSrc（解码后的地址优先）', function () {
  const win = fresh();
  const { v, viewImg } = viewerWith(win, 800, 600);
  const img = image({ src: 'data:image/png;base64,AAAA' });
  img.currentSrc = 'data:image/png;base64,BBBB';
  v.open(img);
  assert.strictEqual(viewImg.src, 'data:image/png;base64,BBBB');
  v.close();
});

test('open() 幂等：已经打开时返回 true，⛔ 不二次隔离背景', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({});
  assert.strictEqual(v.open(img), true);
  const first = doc.body.children.filter(function (n) { return n.hasAttribute('data-viewer-inert'); }).length;
  assert.strictEqual(v.open(img), true);
  const second = doc.body.children.filter(function (n) { return n.hasAttribute('data-viewer-inert'); }).length;
  assert.strictEqual(second, first);
  v.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0058（⌘+点击文档内的链接什么也不发生）
// 教训：模态层的键盘必须分层：有的键只 stop（按钮原生激活），有的键要 preventDefault。
// ═══════════════════════════════════════════════════════════════════════════

test('Escape 关闭预览层并摘掉 window 上的监听', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  v.open(image({}));
  assert.strictEqual((win._listeners.keydown || []).length, 1);
  win.fire('keydown', { key: 'Escape' });
  assert.strictEqual(v.isOpen(), false);
  assert.strictEqual((win._listeners.keydown || []).length, 0, '关闭后 keydown 监听没摘');
});

test('＋ / ＝ / － / ＿ 键分别放大、缩小', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  v.open(image({ w: 100, h: 80 }));
  win.fire('keydown', { key: '+' });
  const up = decodedTransform().scale;
  win.fire('keydown', { key: '-' });
  const down = decodedTransform().scale;
  assert.ok(up > 1);
  assert.ok(down < up);
  win.fire('keydown', { key: '=' });
  assert.ok(decodedTransform().scale > down);
  win.fire('keydown', { key: '_' });
  assert.ok(decodedTransform().scale < 1.25);
  v.close();
});

test('0 键 = 适应，1 键 = 实际大小', function () {
  const win = fresh();
  const { v } = viewerWith(win, 400, 300);
  v.open(image({ w: 2000, h: 1500 }));
  win.fire('keydown', { key: '1' });
  near(decodedTransform().scale, 1);
  win.fire('keydown', { key: '0' });
  const fit = decodedTransform().scale;
  assert.ok(fit < 1, '0 键没有回到适应比例');
  v.close();
});

test('方向键是“滚视口”：← 让图右移，露出左边', function () {
  const win = fresh();
  const { v } = viewerWith(win, 400, 300);
  v.open(image({ w: 2000, h: 1500 }));
  win.fire('keydown', { key: '1' });          // 100%，图大于舞台
  const before = decodedTransform().tx;
  win.fire('keydown', { key: 'ArrowLeft' });
  const after = decodedTransform().tx;
  assert.ok(after > before, '← 的方向反了：' + before + ' → ' + after);
  v.close();
});

test('↑ 让图下移（露出上方），↓ 让图上移', function () {
  const win = fresh();
  const { v } = viewerWith(win, 400, 300);
  v.open(image({ w: 2000, h: 1500 }));
  win.fire('keydown', { key: '1' });
  const y0 = decodedTransform().ty;
  win.fire('keydown', { key: 'ArrowUp' });
  const y1 = decodedTransform().ty;
  assert.ok(y1 > y0);
  win.fire('keydown', { key: 'ArrowDown' });
  assert.ok(decodedTransform().ty < y1);
  v.close();
});

test('组合态：只阻止外传，⛔ 不执行任何动作（中文候选窗）', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  v.open(image({ w: 100, h: 80 }));
  const before = transform();
  const ev = win.fire('keydown', { key: 'Escape', isComposing: true });
  assert.strictEqual(v.isOpen(), true, '组合态的 Escape 把预览关掉了');
  assert.strictEqual(transform(), before);
  assert.strictEqual(ev._stopped, true);
  assert.strictEqual(ev.defaultPrevented, undefined, '组合态不该 preventDefault');
  v.close();
});

test('keyCode 229 同样按组合态处理', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  v.open(image({}));
  win.fire('keydown', { key: 'Escape', keyCode: 229 });
  assert.strictEqual(v.isOpen(), true);
  v.close();
});

test('Tab / Shift+Tab 在五个工具按钮之间循环，焦点不逃到背景', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  v.open(image({}));
  doc.activeElement = doc.body;
  win.fire('keydown', { key: 'Tab' });
  assert.strictEqual(doc.activeElement.dataset.act, 'zoom-out');
  for (let i = 0; i < 4; i++) win.fire('keydown', { key: 'Tab' });
  assert.strictEqual(doc.activeElement.dataset.act, 'close');
  win.fire('keydown', { key: 'Tab' });
  assert.strictEqual(doc.activeElement.dataset.act, 'zoom-out', 'Tab 没有环绕');
  win.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.strictEqual(doc.activeElement.dataset.act, 'close', 'Shift+Tab 没有反向环绕');
  v.close();
});

test('Enter / Space 落在工具按钮上：放行默认激活，只拦外传', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  v.open(image({ w: 100, h: 80 }));
  const btn = btnByAct('zoom-in');
  const ev = win.fire('keydown', { key: 'Enter', target: btn });
  assert.strictEqual(ev.defaultPrevented, undefined, '按钮的原生激活被 preventDefault 挡掉了');
  assert.strictEqual(ev._stopped, true);
  win.fire('keydown', { key: ' ', target: btn });
  v.close();
});

test('带修饰键的组合在模态内不执行任何应用动作', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  v.open(image({ w: 100, h: 80 }));
  const before = transform();
  const ev = win.fire('keydown', { key: 'f', metaKey: true });
  assert.strictEqual(transform(), before, '模态内执行了 ⌘F');
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(ev._stopped, true);
  v.close();
});

test('PageDown / Space 等其余键吞掉默认行为（不滚背景）', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  v.open(image({}));
  ['PageDown', 'PageUp', ' ', 'Home'].forEach(function (key) {
    const ev = win.fire('keydown', { key: key });
    assert.strictEqual(ev.defaultPrevented, true, key + ' 的默认滚动没被挡住');
    assert.strictEqual(ev._stopped, true);
  });
  v.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0068（图里的字比正文大两三倍，而且只有部分图这样）
// 平移/拖动是“看图”的一部分：拖动距离与吸附边界必须可算，⛔ 不能跟手跟丢。
// ═══════════════════════════════════════════════════════════════════════════

test('拖动阈值：累计位移 ≤ 3 px 不算拖动', function () {
  const win = fresh();
  const { v, stage } = viewerWith(win, 400, 300);
  v.open(image({ w: 2000, h: 1500 }));
  win.fire('keydown', { key: '1' });
  const before = transform();
  stage.fire('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  stage.fire('pointermove', { pointerId: 1, clientX: 102, clientY: 101 });
  assert.strictEqual(transform(), before, '3 px 的抖动被当成拖动了');
  v.close();
});

test('拖动超过阈值后跟随，并夹在图像边界内', function () {
  const win = fresh();
  const { v, stage } = viewerWith(win, 400, 300);
  v.open(image({ w: 2000, h: 1500 }));
  win.fire('keydown', { key: '1' });
  const before = decodedTransform();
  stage.fire('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  stage.fire('pointermove', { pointerId: 1, clientX: 80, clientY: 70 });
  const st = decodedTransform();
  near(st.tx - before.tx, -20);
  near(st.ty - before.ty, -30);
  v.close();
});

test('拖过之后的那一次 click 不关预览层，下一次空白点击才关', function () {
  const win = fresh();
  const { v, stage } = viewerWith(win, 400, 300);
  v.open(image({ w: 2000, h: 1500 }));
  stage.fire('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  stage.fire('pointermove', { pointerId: 1, clientX: 80, clientY: 70 });
  stage.fire('pointerup', { pointerId: 1 });
  stage.fire('click', { target: stage });
  assert.strictEqual(v.isOpen(), true, '拖动结束那一下 click 把预览关了');
  stage.fire('click', { target: stage });
  assert.strictEqual(v.isOpen(), false, '空白点击没有关闭');
});

test('点图片本身不关闭；只有点舞台空白才关闭', function () {
  const win = fresh();
  const { v, stage, viewImg } = viewerWith(win, 400, 300);
  v.open(image({ w: 2000, h: 1500 }));
  stage.fire('click', { target: viewImg });
  assert.strictEqual(v.isOpen(), true);
  stage.fire('click', { target: stage });
  assert.strictEqual(v.isOpen(), false);
});

test('非左键按下不启动拖动', function () {
  const win = fresh();
  const { v, stage } = viewerWith(win, 400, 300);
  v.open(image({ w: 2000, h: 1500 }));
  win.fire('keydown', { key: '1' });
  const before = transform();
  stage.fire('pointerdown', { button: 2, pointerId: 1, clientX: 100, clientY: 100 });
  stage.fire('pointermove', { pointerId: 1, clientX: 50, clientY: 50 });
  assert.strictEqual(transform(), before);
  v.close();
});

test('不同 pointerId 的移动被忽略', function () {
  const win = fresh();
  const { v, stage } = viewerWith(win, 400, 300);
  v.open(image({ w: 2000, h: 1500 }));
  win.fire('keydown', { key: '1' });
  stage.fire('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  const before = transform();
  stage.fire('pointermove', { pointerId: 2, clientX: 50, clientY: 50 });
  assert.strictEqual(transform(), before);
  v.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0010（make smoke-app 报 FAIL 6b——应用明明正常，是「可滚」判据把小样本判死了）
// 同族：判据要量用户真正看到的舞台，而不是一个写死的常量。
// ═══════════════════════════════════════════════════════════════════════════

test('轮盘只在舞台内缩放，且滚轮事件永远不许落到背景', function () {
  const win = fresh();
  const { v, stage, viewImg } = viewerWith(win, 800, 600);
  v.open(image({ w: 100, h: 80 }));
  const ev = doc.body.querySelector('.image-viewer-layer').fire('wheel', {
    deltaY: -100, clientX: 400, clientY: 300, target: viewImg,
  });
  assert.strictEqual(ev.defaultPrevented, true);
  assert.ok(decodedTransform().scale > 1, '舞台内滚轮没有缩放');
  v.close();
});

test('轮盘落在工具栏上：只 preventDefault，不缩放', function () {
  const win = fresh();
  const { v, viewImg } = viewerWith(win, 800, 600);
  v.open(image({ w: 100, h: 80 }));
  const caption = doc.body.querySelector('.image-viewer-caption');
  const before = transform();
  const ev = doc.body.querySelector('.image-viewer-layer').fire('wheel', {
    deltaY: -100, target: caption,
  });
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(transform(), before);
  v.close();
});

test('deltaY = 0 的轮盘事件不改变比例', function () {
  const win = fresh();
  const { v, viewImg } = viewerWith(win, 800, 600);
  v.open(image({ w: 100, h: 80 }));
  const before = transform();
  doc.body.querySelector('.image-viewer-layer').fire('wheel', { deltaY: 0, target: viewImg });
  assert.strictEqual(transform(), before);
  v.close();
});

test('窗口 resize：fit 模式跟随新的可用区', function () {
  const win = fresh();
  const { v, stage } = viewerWith(win, 400, 300);
  v.open(image({ w: 2000, h: 1500 }));
  const fit1 = decodedTransform().scale;
  stage._rect = stageRect(800, 600);
  win.fire('resize', {});
  const fit2 = decodedTransform().scale;
  assert.ok(fit2 > fit1, '窗口变大后 fit 没有重算');
  v.close();
});

test('窗口 resize：退化尺寸（0×0）不把比例算成最小值', function () {
  const win = fresh();
  const { v, stage } = viewerWith(win, 400, 300);
  v.open(image({ w: 2000, h: 1500 }));
  const before = transform();
  stage._rect = stageRect(0, 0);
  win.fire('resize', {});
  assert.strictEqual(transform(), before, '隐藏/未布局的 0×0 把比例算坏了');
  v.close();
});

test('窗口 resize：手动比例保持，只被绝对上下界夹', function () {
  const win = fresh();
  const { v, stage } = viewerWith(win, 800, 600);
  v.open(image({ w: 100, h: 80 }));
  win.fire('keydown', { key: '+' });
  const manual = decodedTransform().scale;
  stage._rect = stageRect(300, 200);
  win.fire('resize', {});
  assert.strictEqual(decodedTransform().scale, manual, '手动比例被 resize 改掉了');
  v.close();
});

test('触摸移动在舞台内被挡住，工具栏内放行给按钮', function () {
  const win = fresh();
  const { v, stage, viewImg } = viewerWith(win, 800, 600);
  v.open(image({}));
  const layer = doc.body.querySelector('.image-viewer-layer');
  const inside = layer.fire('touchmove', { target: viewImg });
  assert.strictEqual(inside.defaultPrevented, true);
  const btn = btnByAct('close');
  const outside = layer.fire('touchmove', { target: btn });
  assert.strictEqual(outside.defaultPrevented, undefined);
  v.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0003（make smoke 挂死且零输出——前端回报被后端静默拒收，应用永远不退出）
// 同族：覆盖层的生命周期必须可重入、可卸载；监听不摘就是“下一次才炸”。
// ═══════════════════════════════════════════════════════════════════════════

test('背景隔离只动“我们加过标记的” inert，⛔ 不摘别人设的', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const pre = makeElement('div');
  pre.setAttribute('inert', '');
  doc.body.appendChild(pre);
  const img = image({});
  v.open(img);
  assert.strictEqual(pre.hasAttribute('inert'), true);
  assert.strictEqual(pre.hasAttribute('data-viewer-inert'), false, '别人的 inert 被我们标成了自己的');
  v.close();
  assert.strictEqual(pre.hasAttribute('inert'), true, '关闭时摘掉了别人设的 inert');
});

test('关闭时释放自己加的 inert 与 body 上的打开态类', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({});
  v.open(img);
  assert.strictEqual(img.hasAttribute('data-viewer-inert'), true);
  assert.strictEqual(doc.body.classList.contains('image-viewer-open'), true);
  v.close();
  assert.strictEqual(img.hasAttribute('data-viewer-inert'), false);
  assert.strictEqual(img.hasAttribute('inert'), false);
  assert.strictEqual(doc.body.classList.contains('image-viewer-open'), false);
});

test('关闭后把焦点还给它打开前的元素（无 preventScroll 时也不抛）', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({});
  img.tabIndex = 0;
  assert.strictEqual(v.open(img), true);
  assert.strictEqual(doc.activeElement.dataset.act, 'close', '打开时焦点没有进关闭按钮');
  v.close();
  assert.strictEqual(doc.activeElement, img, '关闭后焦点没有还给图片');
});

test('close({restoreFocus:false}) 不动焦点', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const img = image({});
  img.tabIndex = 0;
  v.open(img);
  const focused = doc.activeElement;
  v.close({ restoreFocus: false });
  assert.strictEqual(doc.activeElement, focused);
});

test('包在链接里的图：焦点还给外层链接（图本身不是焦点停靠点）', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  const a = makeElement('a');
  a.setAttribute('href', 'x.md');
  const img = image({ appended: false });
  a.appendChild(img);
  doc.body.appendChild(a);
  v.open(img);
  v.close();
  assert.strictEqual(doc.activeElement, a);
});

test('close() 幂等；destroy() 摘掉预览层节点', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  v.open(image({}));
  v.close();
  v.close();
  assert.strictEqual(v.isOpen(), false);
  v.destroy();
  assert.strictEqual(doc.body.querySelector('.image-viewer-layer'), null);
});

test('工具条点击只作用于按钮，点空白不动作', function () {
  const win = fresh();
  const { v } = viewerWith(win, 800, 600);
  v.open(image({ w: 100, h: 80 }));
  const controls = doc.body.querySelector('.image-viewer-controls');
  const before = transform();
  controls.fire('click', { target: controls });
  assert.strictEqual(transform(), before);
  const btn = btnByAct('zoom-in');
  const ev = controls.fire('click', { target: btn });
  assert.strictEqual(ev._stopped, true);
  assert.ok(decodedTransform().scale > 1);
  v.close();
});

test('工具条点击不冒泡成“点空白关闭”', function () {
  const win = fresh();
  const { v, stage } = viewerWith(win, 800, 600);
  v.open(image({}));
  const btn = btnByAct('zoom-in');
  const ev = { target: btn, preventDefault: function () {}, stopPropagation: function () { ev._stopped = true; } };
  doc.body.querySelector('.image-viewer-controls').fire('click', ev);
  assert.strictEqual(ev._stopped, true);
  assert.strictEqual(v.isOpen(), true);
  v.close();
});
