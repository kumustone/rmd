// 侧边栏组件层（`src/components/Sidebar.js`）的纯逻辑与可观察决策。
//
// # 这一层守什么
//
// 侧边栏自己做三件"看不见就会错"的事：
//   · **面板可见性只在一个函数里算**（`applyPanes`）——树 / 列表 / 搜索 / 大纲四者
//     互斥但**都不卸载**，算错一格就会出现"点了搜索树还在""大纲页还显示文件按钮"；
//   · **收起不等于 `display:none`**：位移 + `inert` + `visibility` 的组合，
//     收起后还必须不可聚焦（`bugs/0036` 的同族：焦点/选区不许跑进看不见的 chrome）；
//   · **空会话 / 未授权 / 空目录**三个态各自是一张表，按钮接错就是"承诺一件事、做了另一件"。
//
// ⚠️ 最小假 DOM：只实现 Sidebar 真正摸到的属性。⛔ 不为凑条数伪造整棵文档。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

// ─────────────────────────────────────────────────────────────────────────
// 最小假 DOM
// ─────────────────────────────────────────────────────────────────────────

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
    this.title = '';
    this.textContent_ = '';
    this.href = undefined;
    this.scrollTop = 0;
    this._rect = { left: 10, top: 20, bottom: 40, right: 210, width: 200, height: 20 };
    this.style = { setProperty: function () {}, getPropertyValue: function () { return ''; } };
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
    for (const c of String(v == null ? '' : v).split(/\s+/).filter(Boolean)) this._classes.add(c);
  }

  setAttribute(k, v) {
    this._attrs[String(k)] = String(v);
    if (k === 'class') this.className = v;
    if (k === 'inert') this.inert = true;
  }
  getAttribute(k) { return String(k) in this._attrs ? this._attrs[String(k)] : null; }
  hasAttribute(k) { return String(k) in this._attrs; }
  removeAttribute(k) {
    delete this._attrs[String(k)];
    if (k === 'inert') this.inert = false;
    if (k === 'title') this.title = '';
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
  scrollIntoView() { this._scrolled = true; }
  setPointerCapture(id) { this._captured = id; }
  releasePointerCapture(id) {
    if (this._releaseThrows) throw new Error('已释放');
    this._captured = null;
  }
  getBoundingClientRect() { return Object.assign({}, this._rect); }
}

function makeDoc() {
  const doc = {};
  doc.body = new FNode('body', doc);
  doc.documentElement = new FNode('html', doc);
  doc.documentElement.appendChild(doc.body);
  doc._byId = new Map();
  doc.activeElement = doc.body;
  doc.createElement = (t) => new FNode(t, doc);
  doc.getElementById = (id) => doc._byId.get(id) || null;
  doc.documentElement.style = {
    _props: Object.create(null),
    setProperty: function (k, v) { this._props[k] = String(v); },
    getPropertyValue: function (k) { return this._props[k] || ''; },
  };
  return doc;
}

function loadInto(win, rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', 'document', 'module', 'require', src)(win, undefined, undefined, undefined);
}

function loadSidebar(win) {
  const src = fs.readFileSync(path.join(ROOT, 'src/components/Sidebar.js'), 'utf8');
  new Function('window', 'document', 'module', 'require', src)(win, undefined, undefined, undefined);
}

function walk(n, fn) {
  for (const c of n.children) {
    if (c.nodeType !== 1) continue;
    fn(c);
    walk(c, fn);
  }
}
function findAll(n, cls) {
  const out = [];
  walk(n, (x) => { if (x._classes.has(cls)) out.push(x); });
  return out;
}
function findOne(n, cls) { return findAll(n, cls)[0] || null; }

function fakeI18n(over) {
  return Object.assign({
    t: function (key, vars) {
      if (vars === undefined) return key;
      const parts = [];
      for (const k of Object.keys(vars)) parts.push(k + '=' + vars[k]);
      return key + '(' + parts.join(',') + ')';
    },
    lang: function () { return 'zh'; },
  }, over || {});
}

function makeEls(doc, over) {
  const o = over || {};
  const els = Object.assign({
    sidebar: doc.createElement('aside'),
    tabTree: doc.createElement('button'),
    tabToc: doc.createElement('button'),
    paneTree: doc.createElement('div'),
    paneToc: doc.createElement('div'),
    paneDoclist: o.noDoclist ? undefined : doc.createElement('div'),
    paneSearch: o.noSearch ? undefined : doc.createElement('div'),
    searchBar: o.noSearchBar ? undefined : doc.createElement('div'),
    btnFileView: o.noFileView ? undefined : doc.createElement('button'),
    collapseBtn: doc.createElement('button'),
    expandBtn: doc.createElement('button'),
    resizer: doc.createElement('div'),
    treeRootHeader: o.noRootHeader ? undefined : doc.createElement('div'),
    treeRootName: doc.createElement('span'),
    treeRootIcon: doc.createElement('span'),
    treeRootMore: o.noRootMore ? undefined : doc.createElement('button'),
    treeHost: doc.createElement('div'),
  }, o.els || {});
  // 照 index.html 的静态壳：除树以外的面板、根头、展开按钮初始都是 hidden。
  if (els.paneToc) els.paneToc.hidden = true;
  if (els.paneDoclist) els.paneDoclist.hidden = true;
  if (els.paneSearch) els.paneSearch.hidden = true;
  if (els.searchBar) els.searchBar.hidden = true;
  if (els.expandBtn) els.expandBtn.hidden = true;
  if (els.treeRootHeader) els.treeRootHeader.hidden = true;
  return els;
}

function makeSidebar(over) {
  const o = over || {};
  const doc = makeDoc();
  const win = {
    rmd: {},
    matchMedia: function () { return { matches: !!o.reducedMotion }; },
  };
  loadInto(win, 'src/services/keymap.js');
  win.rmd.i18n = fakeI18n(o.i18nOver);
  win.rmd.session = Object.assign({
    setSidebarWidth: async function (w) { return Math.max(180, Math.min(420, w)); },
  }, o.session || {});
  win.rmd.fileTree = {
    svgIcon: function (kind) {
      const svg = doc.createElement('svg');
      svg.dataset.icon = kind;
      return svg;
    },
  };
  loadSidebarInto(win, doc);
  const els = makeEls(doc, o);
  const calls = {
    tab: [],
    toggle: [],
    rootMenu: [],
    choose: 0,
    openLast: [],
  };
  const sidebar = win.rmd.sidebar.createSidebar(Object.assign({
    els: els,
    tree: o.tree || {},
    onTabChange: function (name, top) { calls.tab.push([name, top]); },
    onToggleFileView: function () { calls.toggle.push(1); },
    onRootMenu: function (arg) { calls.rootMenu.push(arg); },
    onChooseDirectory: function () { calls.choose += 1; },
    onOpenLastDirectory: o.noOpenLast ? undefined : function (last) {
      calls.openLast.push(last);
      return o.openLastResult === undefined ? Promise.resolve() : o.openLastResult;
    },
    keyText: o.keyText,
  }, o.opts || {}));
  return { doc: doc, win: win, els: els, sidebar: sidebar, calls: calls };
}

function loadSidebarInto(win, doc) {
  const src = fs.readFileSync(path.join(ROOT, 'src/components/Sidebar.js'), 'utf8');
  new Function('window', 'document', 'module', 'require', src)(win, doc, undefined, undefined);
}

// 简便：只要一个能跑的侧边栏
function mk() { return makeSidebar(); }

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0036（⌘A 全选选中了侧边栏与顶栏）
//
// 同族问题：侧边栏是 chrome，不是正文。它的显示/焦点/选中边界必须清楚：
// 收起后不可聚焦（inert），面板互斥，当前在哪一页只有一处判据。
// ─────────────────────────────────────────────────────────────────────────

test('tilde：只把开头的 /Users/<name> 缩成 ~，其余一个字都不改', function () {
  const A = mk().win.rmd.sidebar;
  assert.strictEqual(A.tilde('/Users/example/notes'), '~/notes');
  assert.strictEqual(A.tilde('/Users/example'), '~');
  assert.strictEqual(A.tilde('/Users/example/'), '~/');
  assert.strictEqual(A.tilde('/Users/example/a/b.md'), '~/a/b.md');
});

test('tilde：其他路径原样返回（⛔ 不猜、不改写）', function () {
  const A = mk().win.rmd.sidebar;
  assert.strictEqual(A.tilde('/tmp/x'), '/tmp/x');
  assert.strictEqual(A.tilde('relative/x'), 'relative/x');
  assert.strictEqual(A.tilde('/home/example/x'), '/home/example/x');
});

test('tilde：非字符串返回空串（⛔ 不抛、不 String() 出怪值）', function () {
  const A = mk().win.rmd.sidebar;
  assert.strictEqual(A.tilde(null), '');
  assert.strictEqual(A.tilde(undefined), '');
  assert.strictEqual(A.tilde(7), '');
  assert.strictEqual(A.tilde({}), '');
});

test('初始面板：树可见，大纲/列表/搜索都收起，形态按钮在文件页', function () {
  const s = mk();
  s.sidebar.setTab('tree');
  assert.strictEqual(s.els.paneTree.hidden, false);
  assert.strictEqual(s.els.paneToc.hidden, true);
  assert.strictEqual(s.els.paneDoclist.hidden, true);
  assert.strictEqual(s.els.paneSearch.hidden, true);
  assert.strictEqual(s.els.searchBar.hidden, true);
  assert.strictEqual(s.els.btnFileView.hidden, false);
});

test('setTab(toc)：只显示大纲，文件形态按钮与搜索框都收起', function () {
  const s = mk();
  s.sidebar.setTab('toc');
  assert.strictEqual(s.els.paneToc.hidden, false);
  assert.strictEqual(s.els.paneTree.hidden, true);
  assert.strictEqual(s.els.paneDoclist.hidden, true);
  assert.strictEqual(s.els.btnFileView.hidden, true);
  assert.strictEqual(s.els.searchBar.hidden, true);
});

test('setTab：页签的 aria-selected 与 tabIndex 跟着走，且回报滚动位置', function () {
  const s = mk();
  s.els.sidebar.scrollTop = 42;
  s.sidebar.setTab('toc');
  assert.strictEqual(s.els.tabToc.getAttribute('aria-selected'), 'true');
  assert.strictEqual(s.els.tabTree.getAttribute('aria-selected'), 'false');
  assert.strictEqual(s.els.tabToc.tabIndex, 0);
  assert.strictEqual(s.els.tabTree.tabIndex, -1);
  assert.deepStrictEqual(s.calls.tab, [['toc', 42]]);
});

test('setTab：未知页名不会让两个面板同时显示（宁可不显示）', function () {
  const s = mk();
  s.sidebar.setTab('nope');
  assert.strictEqual(s.els.paneToc.hidden, true);
  assert.strictEqual(s.els.paneTree.hidden, true);
  assert.strictEqual(s.els.paneDoclist.hidden, true);
});

test('setFileView(list)：列表层显示、树层收起，两者都不清空（只改 hidden）', function () {
  const s = mk();
  const treeBefore = s.els.paneTree.children.length;
  s.sidebar.setFileView('list');
  assert.strictEqual(s.els.paneDoclist.hidden, false);
  assert.strictEqual(s.els.paneTree.hidden, true);
  assert.strictEqual(s.els.paneTree.children.length, treeBefore, '切形态不许卸载树');
  assert.strictEqual(s.sidebar.fileView(), 'list');
});

test('setFileView：非法值一律归一到 tree', function () {
  const s = mk();
  s.sidebar.setFileView('list');
  s.sidebar.setFileView('grid');
  assert.strictEqual(s.sidebar.fileView(), 'tree');
  assert.strictEqual(s.els.paneTree.hidden, false);
  assert.strictEqual(s.els.paneDoclist.hidden, true);
});

test('setFileView：形态按钮文案说的是「点下去会切成什么」', function () {
  const s = mk();
  s.sidebar.setFileView('list');
  assert.strictEqual(s.els.btnFileView.textContent, 'fileView.tree');
  assert.strictEqual(s.els.btnFileView.title, 'fileView.to-tree');
  assert.strictEqual(s.els.btnFileView.getAttribute('aria-label'), 'fileView.to-tree');
  s.sidebar.setFileView('tree');
  assert.strictEqual(s.els.btnFileView.textContent, 'fileView.list');
  assert.strictEqual(s.els.btnFileView.title, 'fileView.to-list');
  assert.strictEqual(s.els.btnFileView.getAttribute('aria-label'), 'fileView.to-list');
});

test('setFileView：没有形态按钮时也不炸（可选元素）', function () {
  const s = makeSidebar({ noFileView: true });
  assert.doesNotThrow(function () { s.sidebar.setFileView('list'); });
  assert.strictEqual(s.sidebar.fileView(), 'list');
});

test('setSearchActive(true)：搜索结果层盖住树与列表，二者都还留在 DOM 里', function () {
  const s = mk();
  s.sidebar.setFileView('list');
  s.sidebar.setSearchActive(true);
  assert.strictEqual(s.els.paneSearch.hidden, false);
  assert.strictEqual(s.els.paneTree.hidden, true);
  assert.strictEqual(s.els.paneDoclist.hidden, true);
  assert.strictEqual(s.sidebar.isSearchActive(), true);
  assert.ok(s.els.paneDoclist, '列表层不能被卸载');
});

test('setSearchActive：大纲页上没有可搜的文件 ⇒ 结果层也不显示', function () {
  const s = mk();
  s.sidebar.setTab('toc');
  s.sidebar.setSearchActive(true);
  assert.strictEqual(s.els.paneSearch.hidden, true);
  assert.strictEqual(s.els.paneToc.hidden, false);
});

test('setSearchActive(false)：回到当前文件形态（列表仍是列表）', function () {
  const s = mk();
  s.sidebar.setFileView('list');
  s.sidebar.setSearchActive(true);
  s.sidebar.setSearchActive(false);
  assert.strictEqual(s.els.paneSearch.hidden, true);
  assert.strictEqual(s.els.paneDoclist.hidden, false);
  assert.strictEqual(s.els.paneTree.hidden, true);
});

test('setSearchAvailable：搜索框只在文件页出现；大纲页永远收起', function () {
  const s = mk();
  s.sidebar.setSearchAvailable(true);
  assert.strictEqual(s.els.searchBar.hidden, false);
  s.sidebar.setTab('toc');
  assert.strictEqual(s.els.searchBar.hidden, true);
  s.sidebar.setTab('tree');
  assert.strictEqual(s.els.searchBar.hidden, false);
  s.sidebar.setSearchAvailable(false);
  assert.strictEqual(s.els.searchBar.hidden, true);
});

test('isFilesVisible：收起 / 大纲页 / 搜索结果层任一成立就不算可见', function () {
  const s = mk();
  assert.strictEqual(s.sidebar.isFilesVisible(), true);
  s.sidebar.setCollapsed(true);
  assert.strictEqual(s.sidebar.isFilesVisible(), false);
  s.sidebar.setCollapsed(false);
  s.sidebar.setTab('toc');
  assert.strictEqual(s.sidebar.isFilesVisible(), false);
  s.sidebar.setTab('tree');
  s.sidebar.setSearchActive(true);
  assert.strictEqual(s.sidebar.isFilesVisible(), false);
});

test('setCollapsed(true)：位移收起，body/sidebar 都带类，展开按钮出现', function () {
  const s = mk();
  s.sidebar.setCollapsed(true);
  assert.strictEqual(s.sidebar.isCollapsed(), true);
  assert.strictEqual(s.doc.body.classList.contains('sidebar-collapsed'), true);
  assert.strictEqual(s.els.sidebar.classList.contains('collapsed'), true);
  assert.strictEqual(s.els.expandBtn.hidden, false);
});

test('setCollapsed(false)：立刻摘掉 inert（焦点要能马上进侧边栏）', function () {
  const s = mk();
  s.els.sidebar.setAttribute('inert', '');
  s.sidebar.setCollapsed(false);
  assert.strictEqual(s.els.sidebar.hasAttribute('inert'), false);
  assert.strictEqual(s.els.expandBtn.hidden, true);
});

test('收起 + 减少动态效果：没有 transitionend 也必须设上 inert', function () {
  const s = makeSidebar({ reducedMotion: true });
  s.sidebar.setCollapsed(true);
  assert.strictEqual(s.els.sidebar.hasAttribute('inert'), true);
});

test('收起（有动画）：inert 等 transitionend(left) 才设，且只认 sidebar 这个目标', function () {
  const s = mk();
  s.sidebar.setCollapsed(true);
  assert.strictEqual(s.els.sidebar.hasAttribute('inert'), false, '动画中设会让动画跳');
  s.els.sidebar.dispatch('transitionend', { target: s.els.sidebar, propertyName: 'width' });
  assert.strictEqual(s.els.sidebar.hasAttribute('inert'), false, '不是 left 的过渡不算');
  s.els.sidebar.dispatch('transitionend', { target: s.els.paneTree, propertyName: 'left' });
  assert.strictEqual(s.els.sidebar.hasAttribute('inert'), false, '别的元素冒泡上来的不算');
  s.els.sidebar.dispatch('transitionend', { target: s.els.sidebar, propertyName: 'left' });
  assert.strictEqual(s.els.sidebar.hasAttribute('inert'), true);
});

test('收起后再展开：动画结束时也不会把 inert 又设回去', function () {
  const s = mk();
  s.els.sidebar.setAttribute('inert', '');
  s.sidebar.setCollapsed(false);
  s.els.sidebar.dispatch('transitionend', { target: s.els.sidebar, propertyName: 'left' });
  assert.strictEqual(s.els.sidebar.hasAttribute('inert'), false);
});

test('页签点击：树/大纲按钮各自切到对应页', function () {
  const s = mk();
  s.els.tabToc.dispatch('click', {});
  assert.strictEqual(s.calls.tab[s.calls.tab.length - 1][0], 'toc');
  s.els.tabTree.dispatch('click', {});
  assert.strictEqual(s.calls.tab[s.calls.tab.length - 1][0], 'tree');
});

test('收起 / 展开按钮：各按各的方向，⛔ 不会互相顶掉', function () {
  const s = mk();
  s.els.collapseBtn.dispatch('click', {});
  assert.strictEqual(s.sidebar.isCollapsed(), true);
  s.els.expandBtn.dispatch('click', {});
  assert.strictEqual(s.sidebar.isCollapsed(), false);
});

test('形态按钮：点击只上报「用户切了形态」，⛔ 不自己改状态（写盘在 main）', function () {
  const s = mk();
  s.els.btnFileView.dispatch('click', {});
  assert.strictEqual(s.calls.toggle.length, 1);
  assert.strictEqual(s.sidebar.fileView(), 'tree', 'Sidebar 不该自己认形态');
});

test('applyWidth：只写 CSS 变量，取值来自后端给的数', function () {
  const s = mk();
  s.sidebar.applyWidth(360);
  assert.strictEqual(s.doc.documentElement.style.getPropertyValue('--sidebar-width'), '360px');
});

// ─────────────────────────────────────────────────────────────────────────
// 宽度拖拽：拖到的像素不是真值，落盘的是后端夹取后的返回值
// ─────────────────────────────────────────────────────────────────────────

test('拖拽：按下即上捕获、进入 resizing，并吃掉默认行为', function () {
  const s = mk();
  const e = { pointerId: 3, preventDefault: function () { e.defaultPrevented = true; } };
  s.els.resizer.dispatch('pointerdown', e);
  assert.strictEqual(s.els.resizer._captured, 3);
  assert.strictEqual(s.doc.body.classList.contains('resizing'), true);
  assert.strictEqual(e.defaultPrevented, true);
});

test('拖拽：未按下时移动不写宽度（⛔ 不凭空改布局）', function () {
  const s = mk();
  s.els.resizer.dispatch('pointermove', { clientX: 300 });
  assert.strictEqual(s.doc.documentElement.style.getPropertyValue('--sidebar-width'), '');
});

test('拖拽：移动时按取整像素写 CSS 变量', function () {
  const s = mk();
  s.els.resizer.dispatch('pointerdown', { pointerId: 1, preventDefault: function () {} });
  s.els.resizer.dispatch('pointermove', { clientX: 281.6 });
  assert.strictEqual(s.doc.documentElement.style.getPropertyValue('--sidebar-width'), '282px');
});

test('拖拽：松手以后端返回值回写（夹取后的结果才是真值）', async function () {
  const seen = [];
  const s = makeSidebar({
    session: { setSidebarWidth: async function (w) { seen.push(w); return 420; } },
  });
  s.els.resizer.dispatch('pointerdown', { pointerId: 1, preventDefault: function () {} });
  s.els.resizer.dispatch('pointermove', { clientX: 900 });
  s.els.resizer.dispatch('pointerup', { pointerId: 1 });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, [900]);
  assert.strictEqual(s.doc.documentElement.style.getPropertyValue('--sidebar-width'), '420px');
  assert.strictEqual(s.doc.body.classList.contains('resizing'), false);
});

test('拖拽：释放捕获抛错被吞掉（已经释放过不算故障）', async function () {
  const s = mk();
  s.els.resizer._releaseThrows = true;
  s.els.resizer.dispatch('pointerdown', { pointerId: 1, preventDefault: function () {} });
  s.els.resizer.dispatch('pointermove', { clientX: 250 });
  assert.doesNotThrow(function () { s.els.resizer.dispatch('pointerup', { pointerId: 1 }); });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(s.doc.body.classList.contains('resizing'), false);
});

// ─────────────────────────────────────────────────────────────────────────
// 根头 / 未授权态 / 空会话 / 空目录：承诺什么就做什么
// ─────────────────────────────────────────────────────────────────────────

test('setRootHeader：null / 空串 / 非字符串都隐藏并清掉标题与 data-root', function () {
  const s = mk();
  s.sidebar.setRootHeader('/Users/x/notes');
  s.sidebar.setRootHeader(null);
  assert.strictEqual(s.els.treeRootHeader.hidden, true);
  assert.strictEqual(s.els.treeRootHeader.getAttribute('title'), null);
  assert.strictEqual(s.els.treeRootHeader.getAttribute('data-root'), null);
  s.sidebar.setRootHeader('/a/b');
  s.sidebar.setRootHeader('');
  assert.strictEqual(s.els.treeRootHeader.hidden, true);
  s.sidebar.setRootHeader('/a/b');
  s.sidebar.setRootHeader(7);
  assert.strictEqual(s.els.treeRootHeader.hidden, true);
});

test('setRootHeader：标题用 ~ 缩写，data-root 存完整路径，名字取最后一段', function () {
  const s = mk();
  s.sidebar.setRootHeader('/Users/example/workspace/notes');
  assert.strictEqual(s.els.treeRootHeader.hidden, false);
  assert.strictEqual(s.els.treeRootHeader.title, '~/workspace/notes');
  assert.strictEqual(s.els.treeRootHeader.dataset.root, '/Users/example/workspace/notes');
  assert.strictEqual(s.els.treeRootName.textContent, 'notes');
});

test('setRootHeader：尾斜杠不算名字的一部分；根自己叫 "/"', function () {
  const s = mk();
  s.sidebar.setRootHeader('/a/b/');
  assert.strictEqual(s.els.treeRootName.textContent, 'b');
  s.sidebar.setRootHeader('/');
  assert.strictEqual(s.els.treeRootName.textContent, '/');
});

test('setRootHeader：图标只挂一次（⛔ 每次承认根都再长一棵 SVG）', function () {
  const s = mk();
  s.sidebar.setRootHeader('/a');
  s.sidebar.setRootHeader('/b');
  assert.strictEqual(s.els.treeRootIcon.children.length, 1);
  assert.strictEqual(s.els.treeRootIcon.children[0].dataset.icon, 'folder');
});

test('setRootHeader：没有根头元素时静默返回（可选元素）', function () {
  const s = makeSidebar({ noRootHeader: true });
  assert.doesNotThrow(function () { s.sidebar.setRootHeader('/a'); });
});

test('focusRootHeader：根头可见才给焦点，隐藏时不抢', function () {
  const s = mk();
  s.sidebar.setRootHeader('/a');
  s.sidebar.focusRootHeader();
  assert.strictEqual(s.doc.activeElement, s.els.treeRootHeader);
  s.sidebar.setRootHeader(null);
  s.doc.activeElement = s.doc.body;
  s.sidebar.focusRootHeader();
  assert.strictEqual(s.doc.activeElement, s.doc.body);
});

test('根头菜单的 returnFocus：关菜单后焦点回到根头，⛔ 不掉到 body', function () {
  const s = mk();
  s.sidebar.setRootHeader('/a');
  s.els.treeRootMore.dispatch('click', {});
  assert.strictEqual(s.calls.rootMenu.length, 1);
  s.doc.activeElement = s.doc.body;
  s.calls.rootMenu[0].returnFocus();
  assert.strictEqual(s.doc.activeElement, s.els.treeRootHeader);
});

test('根头隐藏时 ⋯ 不报菜单（⛔ 弹一个没有根的菜单）', function () {
  const s = mk();
  s.sidebar.setRootHeader(null);
  s.els.treeRootMore.dispatch('click', {});
  assert.strictEqual(s.calls.rootMenu.length, 0);
});

test('根头 ⋯ 点击：报在按钮左下角，并吃掉冒泡', function () {
  const s = mk();
  s.sidebar.setRootHeader('/a');
  const e = { defaultPrevented: false };
  s.els.treeRootMore.dispatch('click', e);
  assert.strictEqual(e.defaultPrevented, true);
  assert.deepStrictEqual([s.calls.rootMenu[0].x, s.calls.rootMenu[0].y], [10, 40]);
});

test('根头右键：没被别处处理时才弹菜单，坐标取事件坐标', function () {
  const s = mk();
  s.sidebar.setRootHeader('/a');
  s.els.treeRootHeader.dispatch('contextmenu', { clientX: 5, clientY: 6, defaultPrevented: true });
  assert.strictEqual(s.calls.rootMenu.length, 0);
  s.els.treeRootHeader.dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.strictEqual(s.calls.rootMenu.length, 1);
  assert.deepStrictEqual([s.calls.rootMenu[0].x, s.calls.rootMenu[0].y], [5, 6]);
});

test('根头键盘：Enter / 空格 / Shift+F10 开菜单；F10 无 Shift 不开', function () {
  const s = mk();
  s.sidebar.setRootHeader('/a');
  const press = function (extra) {
    const e = Object.assign({ preventDefault: function () { e.defaultPrevented = true; } }, extra);
    s.els.treeRootHeader.dispatch('keydown', e);
    return e;
  };
  press({ key: 'Enter' });
  press({ key: ' ' });
  press({ key: 'F10', shiftKey: true });
  assert.strictEqual(s.calls.rootMenu.length, 3);
  press({ key: 'F10', shiftKey: false });
  press({ key: 'a' });
  assert.strictEqual(s.calls.rootMenu.length, 3);
});

test('根头键盘：带修饰键或组合态一律让路（⛔ 抢走 ⌘ 组合）', function () {
  const s = mk();
  s.sidebar.setRootHeader('/a');
  const press = function (extra) {
    const e = Object.assign({ preventDefault: function () { e.defaultPrevented = true; } }, extra);
    s.els.treeRootHeader.dispatch('keydown', e);
    return e;
  };
  press({ key: 'Enter', metaKey: true });
  press({ key: 'Enter', isComposing: true });
  assert.strictEqual(s.calls.rootMenu.length, 0);
});

test('showUnauthorized：清空树槽、隐藏根头，并画出目录与文件', function () {
  const s = mk();
  s.els.treeHost.appendChild(s.doc.createElement('div'));
  s.sidebar.setRootHeader('/a');
  s.sidebar.showUnauthorized({ directory: '/Users/example', file: 'a.md', filePath: '/Users/example/a.md' });
  assert.strictEqual(s.els.treeHost.children.length, 1, '旧的树槽内容必须清掉');
  assert.strictEqual(s.els.treeRootHeader.hidden, true);
  const box = s.els.treeHost.children[0];
  assert.strictEqual(box.dataset.unauthorized, '1');
  const file = findOne(box, 'unauth-file');
  assert.strictEqual(file.textContent, 'a.md');
  assert.strictEqual(file.title, '/Users/example/a.md');
});

test('showUnauthorized：没有文件时不画文件行；目录显示用 ~ 缩写', function () {
  const s = mk();
  s.sidebar.showUnauthorized({ directory: '/Users/example/x' });
  const box = s.els.treeHost.children[0];
  assert.strictEqual(findOne(box, 'unauth-file'), null);
  const dir = findOne(box, 'unauth-dir');
  assert.match(dir.textContent, /dir=~\/x/);
});

test('showUnauthorized 的「打开这个目录」只调 onChooseDirectory', function () {
  const s = mk();
  s.sidebar.showUnauthorized({ directory: '/x' });
  const btn = findOne(s.els.treeHost.children[0], 'primary');
  btn.dispatch('click', {});
  assert.strictEqual(s.calls.choose, 1);
});

test('showNoDirectory：没有上次目录时是「打开目录」入口，且不带 lastDirOffer', function () {
  const s = mk();
  s.sidebar.showNoDirectory({});
  const box = s.els.treeHost.children[0];
  assert.strictEqual(box.dataset.noDirectory, '1');
  assert.strictEqual(box.dataset.lastDirOffer, undefined);
  const btn = findOne(box, 'primary');
  assert.strictEqual(btn.textContent, 'sidebar.open-dir-menu');
  assert.strictEqual(s.els.treeRootHeader.hidden, true);
});

test('showNoDirectory：有上次目录时显示它，并把「打开上次」与「另选」分开', function () {
  const s = mk();
  s.sidebar.showNoDirectory({ lastDirectory: '/Users/example/notes' });
  const box = s.els.treeHost.children[0];
  assert.strictEqual(box.dataset.lastDirOffer, '1');
  const dir = findOne(box, 'unauth-dir');
  assert.strictEqual(dir.title, '/Users/example/notes');
  assert.match(dir.textContent, /dir=~\/notes/);
  const buttons = findAll(box, 'btn');
  assert.strictEqual(buttons.length, 2);
  assert.strictEqual(buttons[1].textContent, 'sidebar.choose-other-dir');
});

test('「打开上次的目录」走专门入口，⛔ 不再弹系统面板', async function () {
  const s = mk();
  s.sidebar.showNoDirectory({ lastDirectory: '/r' });
  const box = s.els.treeHost.children[0];
  const again = findAll(box, 'btn')[0];
  again.dispatch('click', {});
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(s.calls.openLast, ['/r']);
  assert.strictEqual(s.calls.choose, 0);
});

test('「打开上次的目录」双击只发一次；回包后解除忙碌', async function () {
  let resolveIt;
  const s = makeSidebar({
    noOpenLast: true,
    opts: {
      onOpenLastDirectory: function (last) {
        s.calls.openLast.push(last);
        return new Promise(function (res) { resolveIt = res; });
      },
    },
  });
  s.sidebar.showNoDirectory({ lastDirectory: '/r' });
  const again = findAll(s.els.treeHost.children[0], 'btn')[0];
  again.dispatch('click', {});
  again.dispatch('click', {});
  assert.strictEqual(s.calls.openLast.length, 1);
  assert.strictEqual(again.dataset.busy, '1');
  resolveIt();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(again.dataset.busy, '0');
});

test('「打开上次的目录」失败也会解除忙碌（⛔ 卡死在 busy）', async function () {
  const s = makeSidebar({
    opts: {
      onOpenLastDirectory: function () { return Promise.reject(new Error('拒绝')); },
    },
  });
  s.sidebar.showNoDirectory({ lastDirectory: '/r' });
  const again = findAll(s.els.treeHost.children[0], 'btn')[0];
  again.dispatch('click', {});
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(again.dataset.busy, '0');
});

test('没有 onOpenLastDirectory 时退回「选目录」，⛔ 不静默什么都不做', function () {
  const s = makeSidebar({ noOpenLast: true });
  s.sidebar.showNoDirectory({ lastDirectory: '/r' });
  const again = findAll(s.els.treeHost.children[0], 'btn')[0];
  again.dispatch('click', {});
  assert.strictEqual(s.calls.choose, 1);
});

test('提示语：拿得到键位才提键位，拿不到就退回不提键位那句', function () {
  const withKey = makeSidebar({ keyText: function (id) { return id === 'file.open-file' ? 'Cmd+Shift+O' : ''; } });
  withKey.sidebar.showNoDirectory({});
  const h1 = findOne(withKey.els.treeHost.children[0], 'unauth-hint');
  assert.match(h1.textContent, /^sidebar\.hint-open-key/);
  assert.match(h1.textContent, /key=Cmd\+Shift\+O/);

  const noKey = makeSidebar({ keyText: function () { return ''; } });
  noKey.sidebar.showNoDirectory({});
  const h2 = findOne(noKey.els.treeHost.children[0], 'unauth-hint');
  assert.strictEqual(h2.textContent, 'sidebar.hint-open');
});

test('showEmpty：给一句说明 + 一个打开目录入口，并清掉根头', function () {
  const s = mk();
  s.sidebar.setRootHeader('/a');
  s.sidebar.showEmpty('这里没有东西');
  const box = s.els.treeHost.children[0];
  assert.strictEqual(findOne(box, 'unauth-title').textContent, '这里没有东西');
  assert.strictEqual(s.els.treeRootHeader.hidden, true);
  findOne(box, 'btn').dispatch('click', {});
  assert.strictEqual(s.calls.choose, 1);
});

test('setToc：空目录给「无标题」占位，且清掉上一次的条目', function () {
  const s = mk();
  s.sidebar.setToc([{ level: 1, id: 'a', text: 'A' }]);
  s.sidebar.setToc([]);
  assert.strictEqual(s.els.paneToc.children.length, 1);
  assert.strictEqual(s.els.paneToc.children[0].textContent, 'sidebar.toc-empty');
});

test('setToc：锚点类名带层级、href 是 #id、空标题有兜底文案', function () {
  const s = mk();
  s.sidebar.setToc([
    { level: 1, id: 'one', text: '标题一' },
    { level: 3, id: 'three', text: '' },
  ]);
  const items = s.els.paneToc.children;
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].className, 'toc-item toc-l1');
  assert.strictEqual(items[0].href, '#one');
  assert.strictEqual(items[0].textContent, '标题一');
  assert.strictEqual(items[1].className, 'toc-item toc-l3');
  assert.strictEqual(items[1].textContent, 'sidebar.untitled');
});

test('setToc 点击：滚动到已有元素，⛔ 不真的导航（不写 hash）', function () {
  const s = mk();
  const target = s.doc.createElement('h2');
  s.doc._byId.set('one', target);
  s.sidebar.setToc([{ level: 1, id: 'one', text: '一' }]);
  const a = s.els.paneToc.children[0];
  const e = { preventDefault: function () { e.defaultPrevented = true; } };
  a.dispatch('click', e);
  assert.strictEqual(e.defaultPrevented, true);
  assert.strictEqual(target._scrolled, true);
});

test('setToc 点击：目标不存在时安静收手（⛔ 抛错打断整页）', function () {
  const s = mk();
  s.sidebar.setToc([{ level: 1, id: 'missing', text: '一' }]);
  assert.doesNotThrow(function () {
    s.els.paneToc.children[0].dispatch('click', { preventDefault: function () {} });
  });
});
