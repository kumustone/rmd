// DocList（`src/components/DocList.js` ＋ `src/services/doclists.js`）回归用例。
//
// 守的四件事：① 回包判据（gen / req / index_rev）三条同时成立；
// ② 视图不算数时旧分片要整批回滚，⛔ 不留“500 行旧内容”；
// ③ 收录不完整 ≠ 显示截断，两句说明分开说；
// ④ 点一行回传的是后端原串 `real_path`。
// 后端用假 `session`，⛔ 不启动 app、不联网。
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
    style: {}, hidden: false, title: '', type: '', tabIndex: -1,
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
    deleteProperty: function (t, prop) {
      if (typeof prop === 'string') {
        delete t['data-' + prop.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); })];
      }
      return true;
    },
  });
  Object.defineProperty(n, 'title', {
    get: function () { return Object.prototype.hasOwnProperty.call(n._attrs, 'title') ? n._attrs.title : ''; },
    set: function (v) { n._attrs.title = String(v == null ? '' : v); },
    configurable: true,
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
  n.addEventListener = function (type, fn) {
    const list = n._listeners[type] || (n._listeners[type] = []);
    if (list.indexOf(fn) < 0) list.push(fn);
  };
  n.fire = function (type, ev) {
    const e = ev || {};
    if (typeof e.preventDefault !== 'function') e.preventDefault = function () { e.defaultPrevented = true; };
    if (typeof e.stopPropagation !== 'function') e.stopPropagation = function () { e._stopped = true; };
    const list = (n._listeners[type] || []).slice();
    for (let i = 0; i < list.length; i++) list[i](e);
    return e;
  };
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
  loadInto(win, 'src/services/versions.js');
  loadInto(win, 'src/services/chunked.js');
  loadInto(win, 'src/services/doclists.js');
  win.rmd.session = makeSession(1);
  loadInto(win, 'src/components/DocList.js');
  return win;
}

/** 假后端：每次 `listDocuments` 记一条待回包；测试自己决定何时/怎么回。 */
function makeSession(generation) {
  const s = {
    generation: generation == null ? 1 : generation,
    latestDocListReq: 0,
    calls: [],
    pending: [],
    listDocuments: function (rebuild) {
      const req = ++s.latestDocListReq;
      const generationAtCall = s.generation;
      s.calls.push({ req: req, generation: generationAtCall, rebuild: !!rebuild });
      return new Promise(function (resolve, reject) {
        s.pending.push({
          req: req, generation: generationAtCall, resolve: resolve, reject: reject,
        });
      });
    },
    currentDocList: function () {
      return { generation: s.generation, latestDocListReq: s.latestDocListReq };
    },
  };
  return s;
}

function result(over) {
  return Object.assign({
    gen: 1,
    index_rev: 1,
    entries: [],
    keep_dirs: [],
    complete: true,
    incomplete: [],
    incomplete_truncated: false,
    truncated: false,
    total: 0,
  }, over || {});
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}
function entry(name, rel, real) {
  return { name: name, rel: rel, real_path: real };
}

/** 建一个已挂载、默认可见的文档列表。 */
function mounted(over) {
  const win = fresh();
  const host = makeElement('div');
  doc.body.appendChild(host);
  const calls = { opened: [], results: [], errors: [] };
  const opts = Object.assign({
    host: host,
    onOpenFile: function (p) { calls.opened.push(p); },
    onResult: function (r, keepDirs) { calls.results.push({ result: r, keepDirs: keepDirs }); },
    onError: function (e) { calls.errors.push(e); },
    keyText: function (id) { return id === 'file.quick-open' ? 'Cmd+P' : ''; },
  }, over || {});
  const dl = win.rmd.docList.createDocList(opts);
  return { win: win, session: win.rmd.session, host: host, dl: dl, calls: calls, opts: opts };
}

/** 让第 n 个在途请求回包。 */
function reply(session, n, payload) {
  const p = session.pending[n];
  assert.ok(p, '没有第 ' + n + ' 个在途请求');
  const body = payload || { result: result(), req: p.req, stale: false };
  // 真实后端把应答的 `gen` / `req` 也回声进 result（提交判据就比这几个字段）。
  if (body.result && body.result.req == null) body.result.req = body.req;
  p.resolve(body);
  return p;
}

function rows(host) { return host.querySelectorAll('.doclist-row'); }
function notes(host) { return host.querySelectorAll('.doclist-note'); }

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0019（其他程序在目录里新增文档，目录树里不出现（手动刷新也没用））
// 教训：清单/索引是快照；迟到或陈旧的快照不许覆盖新的，也不许在屏上留半截。
// ═══════════════════════════════════════════════════════════════════════════

test('refresh：把 rebuild 原样传给后端', async function () {
  const { session, dl } = mounted({});
  dl.refresh(true);
  dl.refresh(false);
  assert.strictEqual(session.calls[0].rebuild, true);
  assert.strictEqual(session.calls[1].rebuild, false);
  await flush();
});

test('第一份回包落到屏上，并回调 onResult', async function () {
  const { session, host, dl, calls } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, { result: result({ entries: [entry('a.md', 'a.md', '/r/a.md')] }), req: 1, stale: false });
  await flush();
  assert.strictEqual(rows(host).length, 1);
  assert.strictEqual(calls.results.length, 1);
});

test('后端判代次不符（stale）⇒ 不画、不报错、不回调', async function () {
  const { session, host, dl, calls } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, { result: null, req: 1, stale: true });
  await flush();
  assert.strictEqual(host.querySelector('.doclist-items'), null);
  assert.deepStrictEqual(calls.results, []);
  assert.deepStrictEqual(calls.errors, []);
});

test('回包没有 result ⇒ 当成正常路径忽略', async function () {
  const { session, host, dl, calls } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, { result: null, req: 1, stale: false });
  await flush();
  assert.strictEqual(host.querySelector('.doclist-items'), null);
  assert.deepStrictEqual(calls.results, []);
  assert.deepStrictEqual(calls.errors, []);
});

test('两次 refresh：第一份迟到回包不许落地（令牌已前进）', async function () {
  const { session, host, dl, calls } = mounted({});
  dl.setActive(true);
  dl.refresh();
  dl.refresh();
  reply(session, 0, {
    result: result({ entries: [entry('old.md', 'old.md', '/r/old.md')] }), req: 1, stale: false,
  });
  reply(session, 1, {
    result: result({ entries: [entry('new.md', 'new.md', '/r/new.md')], index_rev: 2 }), req: 2, stale: false,
  });
  await flush();
  const rs = rows(host);
  assert.strictEqual(rs.length, 1);
  assert.strictEqual(rs[0].dataset.path, '/r/new.md');
  assert.strictEqual(calls.results.length, 1);
});

test('index_rev 倒退的回包被拒（同代次里旧构建不许覆盖新索引）', async function () {
  const { session, host, dl, calls } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({ entries: [entry('new.md', 'new.md', '/r/new.md')], index_rev: 5 }), req: 1, stale: false,
  });
  await flush();
  dl.refresh();
  reply(session, 1, {
    result: result({ entries: [entry('old.md', 'old.md', '/r/old.md')], index_rev: 4 }), req: 2, stale: false,
  });
  await flush();
  const rs = rows(host);
  assert.strictEqual(rs.length, 1);
  assert.strictEqual(rs[0].dataset.path, '/r/new.md');
  assert.strictEqual(calls.results.length, 1);
});

test('同一份索引可以回两次（index_rev 相等不算倒退）', async function () {
  const { session, dl, calls } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, { result: result({ index_rev: 5 }), req: 1, stale: false });
  await flush();
  dl.refresh();
  reply(session, 1, { result: result({ index_rev: 5 }), req: 2, stale: false });
  await flush();
  assert.strictEqual(calls.results.length, 2);
});

test('gen 与当前授权代次不符 ⇒ 丢弃（切根后的旧回包）', async function () {
  const { session, host, dl, calls } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, { result: result({ gen: 99, entries: [entry('x.md', 'x.md', '/x.md')] }), req: 1, stale: false });
  await flush();
  assert.strictEqual(rows(host).length, 0);
  assert.deepStrictEqual(calls.results, []);
});

test('读取失败 ⇒ 屏上一条错误说明，并回调 onError', async function () {
  const err = new Error('磁盘掉了');
  const { session, host, dl, calls } = mounted({});
  dl.setActive(true);
  dl.refresh();
  session.pending[0].reject(err);
  await flush();
  const note = host.querySelector('.doclist-error');
  assert.ok(note, '失败没有可见说明');
  assert.strictEqual(note.textContent, '读取文档列表失败：磁盘掉了');
  assert.deepStrictEqual(calls.errors, [err]);
});

test('读取失败优先用后端的 wording（不是 JS message）', async function () {
  const err = new Error('js');
  err.wording = '权限不足';
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  session.pending[0].reject(err);
  await flush();
  assert.strictEqual(host.querySelector('.doclist-error').textContent, '读取文档列表失败：权限不足');
});

test('已经发过新请求时，旧请求的失败也不许上屏', async function () {
  const { session, host, dl, calls } = mounted({});
  dl.setActive(true);
  dl.refresh();
  dl.refresh();
  session.pending[0].reject(new Error('旧请求'));
  await flush();
  assert.strictEqual(host.querySelector('.doclist-error'), null);
  assert.deepStrictEqual(calls.errors, []);
});

test('destroy 之后迟到的回包不回屏', async function () {
  const { session, host, dl, calls } = mounted({});
  dl.setActive(true);
  dl.refresh();
  dl.destroy();
  reply(session, 0, { result: result({ entries: [entry('a.md', 'a.md', '/a.md')] }), req: 1, stale: false });
  await flush();
  assert.strictEqual(rows(host).length, 0);
  assert.deepStrictEqual(calls.results, []);
});

test('destroy 之后 refresh 不再发请求', async function () {
  const { session, dl } = mounted({});
  dl.destroy();
  dl.refresh();
  assert.strictEqual(session.calls.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
// 同族：迟到回包只许“什么都不做”，⛔ 不许拿旧状态改当前界面。
// ═══════════════════════════════════════════════════════════════════════════

test('切走（setActive(false)）清空容器并停掉在途分片', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, { result: result({ entries: [entry('a.md', 'a.md', '/a.md')] }), req: 1, stale: false });
  await flush();
  assert.strictEqual(rows(host).length, 1);
  dl.setActive(false);
  assert.strictEqual(rows(host).length, 0);
});

test('切回（setActive(true)）用最近一份清单补画，⛔ 不再拉一次', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, { result: result({ entries: [entry('a.md', 'a.md', '/a.md')] }), req: 1, stale: false });
  await flush();
  const before = session.calls.length;
  dl.setActive(false);
  dl.setActive(true);
  assert.strictEqual(rows(host).length, 1);
  assert.strictEqual(session.calls.length, before);
});

test('还没拿到过清单时切回 ⇒ 不画、也不发请求', function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  assert.strictEqual(rows(host).length, 0);
  assert.strictEqual(session.calls.length, 0);
});

test('setActive 传同一个值不重画', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, { result: result({ entries: [entry('a.md', 'a.md', '/a.md')] }), req: 1, stale: false });
  await flush();
  const row = rows(host)[0];
  dl.setActive(true);
  assert.strictEqual(rows(host)[0], row, '同一状态重画了 DOM');
});

test('隐藏期间的回包仍然回调 onResult（树过滤需要判据集合）', async function () {
  const { session, host, dl, calls } = mounted({});
  dl.setActive(false);
  dl.refresh();
  reply(session, 0, {
    result: result({ keep_dirs: ['/r/sub'], entries: [entry('a.md', 'sub/a.md', '/r/sub/a.md')] }),
    req: 1, stale: false,
  });
  await flush();
  assert.strictEqual(rows(host).length, 0, '隐藏容器里画了行');
  assert.strictEqual(calls.results.length, 1);
});

test('onResult 抛错不挡住绘制（回调是旁路，不是前置条件）', async function () {
  const realErr = console.error;
  console.error = function () {};
  try {
    const m = mounted({
      onResult: function () { throw new Error('树过滤炸了'); },
    });
    const session = m.session;
    const host = m.host;
    const dl = m.dl;
    dl.setActive(true);
    dl.refresh();
    reply(session, 0, { result: result({ entries: [entry('a.md', 'a.md', '/a.md')] }), req: 1, stale: false });
    await flush();
    assert.strictEqual(rows(host).length, 1);
  } finally {
    console.error = realErr;
  }
});

test('onResult 拿到的是完整索引的 keep_dirs（不受 entries 截断影响）', async function () {
  const { session, dl, calls } = mounted({});
  dl.refresh();
  reply(session, 0, {
    result: result({
      keep_dirs: ['/r/a', '/r/b'],
      entries: [entry('a.md', 'a.md', '/r/a.md')],
      truncated: true,
      total: 9999,
    }),
    req: 1, stale: false,
  });
  await flush();
  const keep = calls.results[0].keepDirs;
  assert.ok(keep instanceof Set);
  assert.deepStrictEqual(Array.from(keep).sort(), ['/r/a', '/r/b']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0068（图里的字比正文大两三倍，而且只有部分图这样）
// 同族：界面上的“看起来有多少”必须由真实数量与上限算出来，⛔ 不能拿估算冒充。
// ═══════════════════════════════════════════════════════════════════════════

test('空清单画“没有文档”，并且没有别的说明', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, { result: result(), req: 1, stale: false });
  await flush();
  assert.strictEqual(host.querySelector('.doclist-empty').textContent, '没有找到 Markdown 文档。');
  assert.strictEqual(notes(host).length, 1);
});

test('正常清单不画任何说明行', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({ entries: [entry('a.md', 'a.md', '/r/a.md')] }), req: 1, stale: false,
  });
  await flush();
  assert.strictEqual(notes(host).length, 0);
});

test('后端截断 ⇒ 一条“已显示 X / Y”的说明（含搜索键字形）', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({
      entries: [entry('a.md', 'a.md', '/r/a.md')],
      truncated: true, total: 9000,
    }),
    req: 1, stale: false,
  });
  await flush();
  const note = host.querySelector('.doclist-note-truncated');
  assert.ok(note);
  assert.strictEqual(note.textContent, '已显示 1 / 9000 条，可用 Cmd+P 搜索');
});

test('没有键字形时用“已显示 X / Y”那条（⛔ 留一个空括号）', async function () {
  const { session, host, dl } = mounted({ keyText: function () { return ''; } });
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({ entries: [entry('a.md', 'a.md', '/r/a.md')], truncated: true, total: 3 }),
    req: 1, stale: false,
  });
  await flush();
  assert.strictEqual(host.querySelector('.doclist-note-truncated-nokey').textContent, '已显示 1 / 3 条');
});

test('收录不完整 ⇒ 单独一条（⛔ 与截断合并成一句）', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({
      entries: [entry('a.md', 'a.md', '/r/a.md')],
      complete: false, incomplete: ['/r/x', '/r/y'],
    }),
    req: 1, stale: false,
  });
  await flush();
  assert.strictEqual(host.querySelector('.doclist-note-incomplete').textContent,
    '清单未完整收录（2 处子树不可读）');
});

test('收录不完整且“可能更多” ⇒ 用“至少”那一句', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({
      entries: [entry('a.md', 'a.md', '/r/a.md')],
      complete: false, incomplete: ['/r/x'], incomplete_truncated: true,
    }),
    req: 1, stale: false,
  });
  await flush();
  assert.strictEqual(host.querySelector('.doclist-note-incomplete-more').textContent,
    '清单未完整收录（至少 1 处子树不可读）');
});

test('两件事同时发生 ⇒ 两条说明都在（顺序：不完整在前）', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({
      entries: [entry('a.md', 'a.md', '/r/a.md')],
      complete: false, incomplete: ['/r/x'], truncated: true, total: 8,
    }),
    req: 1, stale: false,
  });
  await flush();
  const ns = notes(host);
  assert.strictEqual(ns.length, 2);
  assert.ok(ns[0].classList.contains('doclist-note-incomplete'));
  assert.ok(ns[1].classList.contains('doclist-note-truncated'));
});

test('complete 缺省（undefined）不当作不完整', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({ entries: [entry('a.md', 'a.md', '/r/a.md')], complete: undefined }),
    req: 1, stale: false,
  });
  await flush();
  assert.strictEqual(notes(host).length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0001（点击文档里的链接，整个应用会重载一遍）
// 同族：行点击必须回传后端原串 real_path，⛔ 不是显示用的名字/父目录。
// ═══════════════════════════════════════════════════════════════════════════

test('行：名字 + 扩展名两段，父目录相对 root', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({ entries: [entry('readme.md', 'notes/deep/readme.md', '/r/notes/deep/readme.md')] }),
    req: 1, stale: false,
  });
  await flush();
  const row = rows(host)[0];
  assert.strictEqual(row.querySelector('.doclist-name').textContent, 'readme.md');
  assert.strictEqual(row.querySelector('.doclist-ext').textContent, '.md');
  assert.strictEqual(row.querySelector('.doclist-parent').textContent, 'notes/deep');
});

test('行：root 直接下的一层父目录显示 `/`', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({ entries: [entry('a.md', 'a.md', '/r/a.md')] }), req: 1, stale: false,
  });
  await flush();
  assert.strictEqual(rows(host)[0].querySelector('.doclist-parent').textContent, '/');
});

test('行：非 .md 扩展名整串当名字（⛔ 拆一半）', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({ entries: [entry('a.txt', 'a.txt', '/r/a.txt')] }), req: 1, stale: false,
  });
  await flush();
  const name = rows(host)[0].querySelector('.doclist-name');
  assert.strictEqual(name.textContent, 'a.txt');
  assert.strictEqual(name.querySelector('.doclist-ext'), null);
});

test('行点击回传 real_path', async function () {
  const { session, host, dl, calls } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({ entries: [entry('a.md', 'a.md', '/root/真实/a.md')] }), req: 1, stale: false,
  });
  await flush();
  rows(host)[0].fire('click', {});
  assert.deepStrictEqual(calls.opened, ['/root/真实/a.md']);
});

test('行保留后端给的顺序', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({
      entries: [
        entry('z.md', 'z.md', '/r/z.md'),
        entry('a.md', 'a.md', '/r/a.md'),
      ],
    }),
    req: 1, stale: false,
  });
  await flush();
  assert.deepStrictEqual(rows(host).map(function (r) { return r.dataset.path; }), ['/r/z.md', '/r/a.md']);
});

test('行不是 Tab 停靠点（5000 行不把键盘用户困住）', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({ entries: [entry('a.md', 'a.md', '/r/a.md')] }), req: 1, stale: false,
  });
  await flush();
  assert.strictEqual(rows(host)[0].tabIndex, -1);
});

test('列表容器带 role=list，行带 role=listitem', async function () {
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, {
    result: result({ entries: [entry('a.md', 'a.md', '/r/a.md')] }), req: 1, stale: false,
  });
  await flush();
  assert.strictEqual(host.querySelector('.doclist-items').getAttribute('role'), 'list');
  assert.strictEqual(rows(host)[0].getAttribute('role'), 'listitem');
});

test('超过 5000 条只画 5000 行，并常驻一条截断说明', async function () {
  const many = [];
  for (let i = 0; i < 5001; i++) many.push(entry('f' + i + '.md', 'f' + i + '.md', '/r/f' + i + '.md'));
  const { session, host, dl } = mounted({});
  dl.setActive(true);
  dl.refresh();
  reply(session, 0, { result: result({ entries: many, total: 5001 }), req: 1, stale: false });
  await flush();
  // 首批同步 500；余下 9 批走 setTimeout。
  for (let i = 0; i < 30 && rows(host).length < 5000; i++) await sleep(5);
  assert.strictEqual(rows(host).length, 5000);
  assert.ok(host.querySelector('.doclist-note-truncated'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 源自 docs/bugs/0019（其他程序在目录里新增文档，目录树里不出现（手动刷新也没用））
// 同族：纯函数是判据的唯一出处；组件只接线。
// ═══════════════════════════════════════════════════════════════════════════

test('splitName：只拆 .md（大小写不敏感），其余整串', function () {
  const win = fresh();
  const DL = win.rmd.doclists;
  assert.deepStrictEqual(DL.splitName('a.md'), { base: 'a', ext: '.md' });
  assert.deepStrictEqual(DL.splitName('A.MD'), { base: 'A', ext: '.MD' });
  assert.deepStrictEqual(DL.splitName('a.b.md'), { base: 'a.b', ext: '.md' });
  assert.deepStrictEqual(DL.splitName('a.mdx'), { base: 'a.mdx', ext: '' });
  assert.deepStrictEqual(DL.splitName('md'), { base: 'md', ext: '' });
  assert.deepStrictEqual(DL.splitName('.md'), { base: '.md', ext: '' });
  assert.deepStrictEqual(DL.splitName(''), { base: '', ext: '' });
});

test('parentLabel：相对 root 的父目录；顶层是 `/`', function () {
  const win = fresh();
  const DL = win.rmd.doclists;
  assert.strictEqual(DL.parentLabel('a.md'), '/');
  assert.strictEqual(DL.parentLabel('notes/a.md'), 'notes');
  assert.strictEqual(DL.parentLabel('a/b/c.md'), 'a/b');
  assert.strictEqual(DL.parentLabel('/a.md'), '/');
  assert.strictEqual(DL.parentLabel(''), '/');
  assert.strictEqual(DL.parentLabel(null), '/');
});

test('renderedCount：夹在 0…5000，且对非数字不造出负数/NaN', function () {
  const win = fresh();
  const DL = win.rmd.doclists;
  assert.strictEqual(DL.renderedCount(0), 0);
  assert.strictEqual(DL.renderedCount(4999), 4999);
  assert.strictEqual(DL.renderedCount(5000), 5000);
  assert.strictEqual(DL.renderedCount(5001), 5000);
  assert.strictEqual(DL.renderedCount(-3), 0);
  assert.strictEqual(DL.renderedCount(NaN), 0);
  assert.strictEqual(DL.renderedCount('12'), 12);
});

test('notices：null ⇒ 什么都不说', function () {
  const win = fresh();
  assert.deepStrictEqual(win.rmd.doclists.notices(null, 0, ''), []);
});

test('notices：收录不完整与显示截断是两条（⛔ 合并）', function () {
  const win = fresh();
  const out = win.rmd.doclists.notices({
    complete: false, incomplete: ['x'], truncated: true, total: 9, entries: [1],
  }, 1, 'Cmd+P');
  assert.deepStrictEqual(out.map(function (n) { return n.key; }),
    ['doclist.incomplete', 'doclist.truncated']);
  assert.deepStrictEqual(out[0].params, { n: 1 });
  assert.deepStrictEqual(out[1].params, { shown: 1, total: 9, key: 'Cmd+P' });
});

test('notices：incomplete_truncated 换“至少”那一句', function () {
  const win = fresh();
  const out = win.rmd.doclists.notices({
    complete: false, incomplete: ['x'], incomplete_truncated: true,
  }, 0, '');
  assert.strictEqual(out[0].key, 'doclist.incomplete-more');
});

test('notices：前端 5000 上限也触发截断说明（不必等后端 truncated）', function () {
  const win = fresh();
  const entries = new Array(5001);
  const out = win.rmd.doclists.notices({ entries: entries, total: 5001 }, 5000, '');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].key, 'doclist.truncated-nokey');
});

test('notices：complete === true 且未截断 ⇒ 空', function () {
  const win = fresh();
  assert.deepStrictEqual(win.rmd.doclists.notices({
    complete: true, entries: [1, 2], total: 2, truncated: false,
  }, 2, 'Cmd+P'), []);
});

test('createToken：request 推进 seq/key，bump 推进 epoch/key', function () {
  const win = fresh();
  const t = win.rmd.doclists.createToken();
  assert.strictEqual(t.current(), 1);
  const r1 = t.request();
  assert.deepStrictEqual(r1, { epoch: 0, seq: 1, key: 2 });
  assert.strictEqual(t.current(), 2);
  const k = t.bump();
  assert.strictEqual(t.epoch(), 1);
  assert.strictEqual(k, 3);
  assert.strictEqual(t.current(), 3);
  const r2 = t.request();
  assert.deepStrictEqual(r2, { epoch: 1, seq: 2, key: 4 });
});

test('createToken：destroy 之后 current() 恒为 -1（⛔ 误判“还是我”）', function () {
  const win = fresh();
  const t = win.rmd.doclists.createToken();
  t.destroy();
  assert.strictEqual(t.alive(), false);
  assert.strictEqual(t.current(), -1);
  t.bump();
  assert.strictEqual(t.current(), -1);
});

test('shouldApply：gen / req / index_rev 三条同时成立才落地', function () {
  const win = fresh();
  const SA = win.rmd.doclists.shouldApply;
  const cur = { generation: 3, seq: 7, appliedRev: 10 };
  assert.strictEqual(SA({ gen: 3, req: 7, index_rev: 10 }, cur), true);
  assert.strictEqual(SA({ gen: 3, req: 7, index_rev: 11 }, cur), true);
  assert.strictEqual(SA({ gen: 2, req: 7, index_rev: 10 }, cur), false);
  assert.strictEqual(SA({ gen: 3, req: 6, index_rev: 10 }, cur), false);
  assert.strictEqual(SA({ gen: 3, req: 7, index_rev: 9 }, cur), false);
  assert.strictEqual(SA(null, cur), false);
  assert.strictEqual(SA({ gen: 3, req: 7, index_rev: 10 }, null), false);
});

test('visibleEntries：不开“隐藏空目录”时原样返回副本（不改入参）', function () {
  const win = fresh();
  const input = [{ name: 'a', path: '/a', is_dir: true }];
  const out = win.rmd.doclists.visibleEntries(input, new Set(), null, false);
  assert.deepStrictEqual(out, input);
  assert.notStrictEqual(out, input);
});

test('visibleEntries：清单还没到（keepDirs=null）⇒ 全画', function () {
  const win = fresh();
  const input = [{ name: 'a', path: '/a', is_dir: true }];
  assert.deepStrictEqual(win.rmd.doclists.visibleEntries(input, null, null, true), input);
});

test('visibleEntries：文件永远画；忽略目录灰显但保留', function () {
  const win = fresh();
  const input = [
    { name: 'a.md', path: '/a.md', is_dir: false },
    { name: 'node_modules', path: '/node_modules', is_dir: true, ignored: true },
  ];
  assert.deepStrictEqual(win.rmd.doclists.visibleEntries(input, new Set(), null, true), input);
});

test('visibleEntries：确认无 md 的目录藏掉，有新 md 的留下', function () {
  const win = fresh();
  const input = [
    { name: 'keep', path: '/keep', is_dir: true },
    { name: 'drop', path: '/drop', is_dir: true },
  ];
  const out = win.rmd.doclists.visibleEntries(input, new Set(['/keep']), null, true);
  assert.deepStrictEqual(out.map(function (e) { return e.path; }), ['/keep']);
});

test('visibleEntries：本次新建目录是临时例外（R4）', function () {
  const win = fresh();
  const input = [{ name: 'new', path: '/new', is_dir: true }];
  assert.deepStrictEqual(win.rmd.doclists.visibleEntries(input, new Set(), new Set(['/new']), true), input);
});

test('visibleEntries：未知（清单不完整且不在集合里）⇒ 画（R1 的三态）', function () {
  const win = fresh();
  const input = [{ name: 'unknown', path: '/unknown', is_dir: true }];
  // “未知”在接口上就表现为“在 keepDirs 里”；不在集合里表示已确认无 md。
  assert.deepStrictEqual(win.rmd.doclists.visibleEntries(input, new Set(['/unknown']), null, true), input);
});
