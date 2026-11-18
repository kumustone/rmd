// `design/0070` §7 第 6/7 条：启动页的**分段归因**。
//
// # 这一格守的是什么
//
// 打开一行是三段（收藏授权 / 打开文档 / 刷新列表），`StartScreen.runOpen` 对**整条链**
// 一个 `catch` 会把"刷新失败"说成"这条收藏打不开"（`bugs/0319`）。屏幕表现只是
// "提示里那句话不对"，没有任何浏览器报错 ⇒ 只能靠这里的假 DOM 咬死：
//
// ① `failedAt:'favorite'` ⇒ 行标灰 ＋ 段内联出现；
// ② `failedAt:'document'` ⇒ 行**不**标灰，仍然段内联（归因不串台）；
// ③ `failedAt:'refresh'` ⇒ 行不变、**不**出段内联，只有中性提示出口；
// ④ `note === null`（`openDocument` 已报过）⇒ 一个字节都不动；
// ⑤ `data-busy` 在**成功与失败**两条路上都清掉；
// ⑥ 打开成功 / 段重画 / 离开启动页 ⇒ 提示收起。
//
// ⚠️ ②③ 是变异敏感的那两条：把 `runOpen` 改回"单一 catch ＋ 一律标灰"，② 必红。

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const SS = require('../../src/components/StartScreen.js');
const I18N = require('../../src/services/i18n.js');

// ────────────────────────────────────────────────────────────────
// 假 DOM（只够 `StartScreen.render` 用到的那一小块）
// ────────────────────────────────────────────────────────────────

function El(tag) {
  this.tagName = String(tag).toUpperCase();
  this.className = '';
  this.textContent = '';
  this.title = '';
  this.type = '';
  this.hidden = false;
  this.disabled = false;
  this.dataset = {};
  this.children = [];
  this.listeners = {};
  this.parentNode = null;
  this._attrs = {};
}

El.prototype.appendChild = function (c) {
  if (c.parentNode) c.parentNode.removeChild(c);
  c.parentNode = this;
  this.children.push(c);
  return c;
};

El.prototype.insertBefore = function (c, ref) {
  if (c.parentNode) c.parentNode.removeChild(c);
  c.parentNode = this;
  const i = ref ? this.children.indexOf(ref) : -1;
  if (i < 0) this.children.push(c);
  else this.children.splice(i, 0, c);
  return c;
};

El.prototype.removeChild = function (c) {
  const i = this.children.indexOf(c);
  if (i >= 0) this.children.splice(i, 1);
  c.parentNode = null;
  return c;
};

El.prototype.addEventListener = function (type, fn) {
  (this.listeners[type] || (this.listeners[type] = [])).push(fn);
};

El.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
El.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
};
El.prototype.contains = function () { return false; };
El.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
};

Object.defineProperty(El.prototype, 'nextSibling', {
  get: function () {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i >= 0 ? (this.parentNode.children[i + 1] || null) : null;
  },
});

function installDocument() {
  global.document = {
    createElement: function (tag) { return new El(tag); },
    addEventListener: function () {},
    removeEventListener: function () {},
    body: new El('body'),
    activeElement: null,
  };
}

function walk(node, out) {
  out = out || [];
  (node.children || []).forEach(function (c) { out.push(c); walk(c, out); });
  return out;
}

function byClass(root, cls) {
  return walk(root).filter(function (el) {
    return String(el.className).split(/\s+/).indexOf(cls) >= 0;
  });
}

async function flush() {
  // 多转几圈微任务：`Promise.resolve(p).then(finish)` 里可能还有一层。
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const RECENT = [{ root: '/tmp/rmd-a', last: true }];
const FAVS = ['/tmp/rmd-fav.md'];

/** 建一个挂好两段（收藏 + 最近）的启动页。 */
function mount(handlers) {
  installDocument();
  const host = new El('div');
  const calls = { error: [], open: 0, fav: 0 };
  const screen = SS.createStartScreen({
    onOpen: function (root) {
      calls.open += 1;
      return handlers.onOpen ? handlers.onOpen(root) : { ok: true };
    },
    onOpenFavorite: function (path) {
      calls.fav += 1;
      return handlers.onOpenFavorite ? handlers.onOpenFavorite(path) : { ok: true };
    },
    onError: function (err, target, info) { calls.error.push({ err: err, target: target, info: info }); },
    overlayOpen: function () { return false; },
  });
  screen.render(host, RECENT, FAVS);
  const box = host.children[0];
  const favList = byClass(box, 'start-fav-list')[0];
  // ⚠️ `design/0081` 起有三段 ⇒ 按**显式段名**取，⛔ 别再写"不是收藏表的那个列表"。
  const recentList = byClass(box, 'start-recent-list')[0];
  return { host: host, box: box, screen: screen, calls: calls, favList: favList, recentList: recentList };
}

function click(el) {
  (el.listeners.click || []).forEach(function (fn) { fn({ preventDefault: function () {} }); });
}

/** 提示节点所属的那一段（`insertBefore(list.nextSibling)` ⇒ 它在列表的紧后面）。 */
function noteAfter(list) {
  const next = list.nextSibling;
  return next && String(next.className).indexOf('start-note') >= 0 ? next : null;
}

// ────────────────────────────────────────────────────────────────
// ① 收藏段：行标灰 ＋ 段内联
// ────────────────────────────────────────────────────────────────

test('failedAt:favorite ⇒ 行标灰、data-busy 已清、段内联在收藏表之后（§7-7）', async function () {
  const m = mount({
    onOpenFavorite: function () {
      return {
        ok: false, failedAt: 'favorite', err: new Error('denied'),
        note: {
          key: 'status.favorite-open-failed', vars: { dir: '/tmp/rmd-fav.md' },
          detail: 'denied · /tmp/rmd-fav.md',
          retry: function () { return Promise.resolve(true); },
        },
      };
    },
  });
  const row = m.favList.children[0];
  click(row);
  await flush();

  assert.strictEqual(row.dataset.missing, '1', '这条收藏打不开 ⇒ 行标灰');
  assert.strictEqual(row.dataset.busy, undefined, 'data-busy 必须无条件清掉');
  const note = noteAfter(m.favList);
  assert.ok(note, '段内联必须出现在收藏表之后');
  assert.strictEqual(note.getAttribute('role'), 'status');
  assert.strictEqual(note.getAttribute('aria-live'), 'polite');
  const text = byClass(note, 'start-note-text')[0];
  assert.strictEqual(text.textContent,
    I18N.t('status.favorite-open-failed', { dir: '/tmp/rmd-fav.md' }));
  assert.ok(byClass(note, 'start-note-btn').length >= 1, '至少要有「关闭」');
  assert.strictEqual(m.calls.error.length, 0, '段内联落得下去时不该再走兜底出口');
});

// ────────────────────────────────────────────────────────────────
// ② 文档段：不标灰，但归因仍在"打开"这一段
// ────────────────────────────────────────────────────────────────

test('failedAt:document ⇒ 行**不**标灰、段内联说"打不开这个目录"（变异敏感）', async function () {
  const m = mount({
    onOpen: function () {
      return {
        ok: false, failedAt: 'document',
        note: { key: 'status.recent-not-found', vars: { dir: '/tmp/rmd-a' } },
      };
    },
  });
  const row = m.recentList.children[0];
  click(row);
  await flush();

  assert.strictEqual(row.dataset.missing, undefined, '最近行没有"够不着"这个状态（§2.4）');
  assert.strictEqual(row.dataset.busy, undefined);
  const note = noteAfter(m.recentList);
  assert.ok(note, '归因仍在打开这一段 ⇒ 段内联');
  assert.strictEqual(byClass(note, 'start-note-text')[0].textContent,
    I18N.t('status.recent-not-found', { dir: '/tmp/rmd-a' }));
  assert.strictEqual(m.calls.error.length, 0);
});

// ────────────────────────────────────────────────────────────────
// ③ 刷新段：只出中性提示，行与段都不变
// ────────────────────────────────────────────────────────────────

test('failedAt:refresh ⇒ 行无 data-missing、无段内联、只走中性出口（§7-6）', async function () {
  const m = mount({
    onOpenFavorite: function () {
      return { ok: false, failedAt: 'refresh', err: new Error('refresh boom') };
    },
  });
  const row = m.favList.children[0];
  click(row);
  await flush();

  assert.strictEqual(row.dataset.missing, undefined, '刷新失败与"这条收藏够不着"无关');
  assert.strictEqual(row.dataset.busy, undefined);
  assert.strictEqual(noteAfter(m.favList), null, '列表刷新失败不许占用段内联');
  assert.strictEqual(noteAfter(m.recentList), null);
  assert.strictEqual(m.calls.error.length, 1);
  assert.strictEqual(m.calls.error[0].info.kind, 'refresh');
});

// ────────────────────────────────────────────────────────────────
// ④ 已由别处报告：一个字节都不动
// ────────────────────────────────────────────────────────────────

test('note === null ⇒ 不标灰、不补话、不走兜底（openDocument 已报过）', async function () {
  const m = mount({
    onOpenFavorite: function () {
      return { ok: false, failedAt: 'document', note: null, err: new Error('open failed') };
    },
  });
  const row = m.favList.children[0];
  click(row);
  await flush();

  assert.strictEqual(row.dataset.missing, undefined);
  assert.strictEqual(row.dataset.busy, undefined);
  assert.strictEqual(noteAfter(m.favList), null);
  assert.strictEqual(m.calls.error.length, 0, '同一次失败只许有一个锚点说话');
});

// ────────────────────────────────────────────────────────────────
// ⑤ 意外的拒绝：按"文档打不开"处理（不标灰），但必须可见
// ────────────────────────────────────────────────────────────────

test('拒绝（调用方违约）⇒ 不标灰、走兜底出口、data-busy 照样清', async function () {
  const m = mount({
    onOpen: function () { return Promise.reject(new Error('boom')); },
  });
  const row = m.recentList.children[0];
  click(row);
  await flush();

  assert.strictEqual(row.dataset.missing, undefined);
  assert.strictEqual(row.dataset.busy, undefined);
  assert.strictEqual(m.calls.error.length, 1);
  assert.strictEqual(m.calls.error[0].info.kind, 'document');
});

// ────────────────────────────────────────────────────────────────
// ⑥ 生命周期：打开成功 / 段重画 ⇒ 收起
// ────────────────────────────────────────────────────────────────

test('悬着一条提示时，同一行再打开成功 ⇒ 它收起', async function () {
  let fail = true;
  const m = mount({
    onOpenFavorite: function () {
      if (fail) {
        return {
          ok: false, failedAt: 'favorite',
          note: { key: 'status.favorite-open-failed', vars: { dir: '/tmp/rmd-fav.md' } },
        };
      }
      return { ok: true };
    },
  });
  const row = m.favList.children[0];
  click(row);
  await flush();
  assert.ok(noteAfter(m.favList), '先要有一条');

  fail = false;
  click(row);
  await flush();
  assert.strictEqual(noteAfter(m.favList), null, '打开成功 ⇒ 收起（§2.3.2）');
});

test('段重画 / 离开启动页 ⇒ 提示随 `box` 一起消失', function () {
  const m = mount({});
  assert.strictEqual(m.screen.note('favorite', { key: 'status.favorite-open-failed', vars: { dir: 'x' } }), true);
  assert.ok(noteAfter(m.favList));

  installDocument();
  const host2 = new El('div');
  m.screen.render(host2, RECENT, FAVS);
  assert.strictEqual(byClass(host2, 'start-note').length, 0, '段重画后旧提示不许留下');

  m.screen.note('recent', { key: 'status.recent-clear-failed', vars: { msg: 'x' } });
  m.screen.clear();
  assert.strictEqual(m.screen.note('recent', { key: 'status.recent-clear-failed', vars: { msg: 'x' } }), false,
    '离开启动页之后没有挂载点');
});
