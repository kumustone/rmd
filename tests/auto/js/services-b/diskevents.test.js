// diskevents 的自动化用例（`tests/auto/js/services-b/`）。
//
// 覆盖：DiskView 采纳判据（revision 严格更大）、健康档映射（含未知档如实显示）、
// 内容序号 seq 的推进与“健康变化不推 seq”、两条订阅通道的隔离、
// 两条 IPC 的安装（失败可回报）、手动刷新 / 重接监视的回包采纳。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadDiskEvents() {
  const win = {};
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'diskevents.js'), 'utf8');
  new Function('window', src)(win);
  return win.rmd.diskEvents;
}

const DE = loadDiskEvents();

test.beforeEach(function () { DE._reset(); });

function view(over) {
  return Object.assign({ epoch: 0, watch_id: 1, revision: 1, reason: null, pending: false }, over || {});
}

// ── 纯逻辑 ───────────────────────────────────────────────────────

test('事件名与 Rust 侧常量逐字一致', () => {
  assert.strictEqual(DE.TREE_EVENT, 'rmd://tree-changed');
  assert.strictEqual(DE.DISK_EVENT, 'rmd://dir-watch');
});

test('shouldAccept：形状不对（缺 revision / 不是数字）一律不采纳', () => {
  assert.strictEqual(DE.shouldAccept(null, null), false);
  assert.strictEqual(DE.shouldAccept(null, {}), false);
  assert.strictEqual(DE.shouldAccept(null, { revision: '1' }), false);
  assert.strictEqual(DE.shouldAccept(null, { revision: NaN }), true, 'NaN 的 typeof 仍是 number');
});

test('shouldAccept：第一份采纳，之后必须 revision 严格更大', () => {
  assert.strictEqual(DE.shouldAccept(null, view({ revision: 1 })), true);
  assert.strictEqual(DE.shouldAccept(view({ revision: 1 }), view({ revision: 2 })), true);
  assert.strictEqual(DE.shouldAccept(view({ revision: 2 }), view({ revision: 2 })), false);
  assert.strictEqual(DE.shouldAccept(view({ revision: 2 }), view({ revision: 1 })), false);
});

test('healthOf：没有原因时不显示任何东西', () => {
  assert.strictEqual(DE.healthOf(null), null);
  assert.strictEqual(DE.healthOf({}), null);
  assert.strictEqual(DE.healthOf({ reason: '' }), null);
});

test('healthOf：rescan 是临时档，不给重试按钮', () => {
  assert.deepStrictEqual(DE.healthOf({ reason: 'rescan' }), {
    key: 'disk.rescan', retry: false, transient: true,
  });
});

test('healthOf：io / path-not-found / limit / rewatch-failed 都可重试且非临时', () => {
  assert.deepStrictEqual(DE.healthOf({ reason: 'io' }), {
    key: 'disk.io', retry: true, transient: false,
  });
  assert.deepStrictEqual(DE.healthOf({ reason: 'path-not-found' }), {
    key: 'disk.path-not-found', retry: true, transient: false,
  });
  assert.deepStrictEqual(DE.healthOf({ reason: 'limit' }), {
    key: 'disk.limit', retry: true, transient: false,
  });
  assert.deepStrictEqual(DE.healthOf({ reason: 'rewatch-failed' }), {
    key: 'disk.rewatch-failed', retry: true, transient: false,
  });
});

test('healthOf：未知档照实给出（key 为空由展示层退回原文），⛔ 不静默成“没事”', () => {
  assert.deepStrictEqual(DE.healthOf({ reason: 'brand-new' }), {
    key: '', retry: true, transient: false,
  });
});

// ── seq 与订阅 ───────────────────────────────────────────────────

test('bump：seq 同步 +1 并返回新值，订阅者收到 (seq, view)', () => {
  const got = [];
  DE.onChange(function (s, v) { got.push([s, v]); });
  assert.strictEqual(DE.seq(), 0);
  assert.strictEqual(DE.bump(), 1);
  assert.strictEqual(DE.seq(), 1);
  assert.deepStrictEqual(got, [[1, null]]);
});

test('onChange：退订后不再收到；非函数订阅是安全的空操作', () => {
  const got = [];
  const off = DE.onChange(function (s) { got.push(s); });
  DE.bump();
  off();
  DE.bump();
  assert.deepStrictEqual(got, [1]);
  assert.doesNotThrow(function () { DE.onChange(null)(); });
});

test('onChange：一个订阅者抛错不挡住另一个', () => {
  const old = console.error;
  console.error = function () {};
  try {
    const got = [];
    DE.onChange(function () { throw new Error('树消费者坏了'); });
    DE.onChange(function (s) { got.push(s); });
    assert.strictEqual(DE.bump(), 1);
    assert.deepStrictEqual(got, [1]);
  } finally {
    console.error = old;
  }
});

// ── adopt ────────────────────────────────────────────────────────

test('adopt：采纳第一份 DiskView，epoch 不变时不推 seq', () => {
  const v = view({ revision: 1, epoch: 0 });
  assert.strictEqual(DE.adopt(v), true);
  assert.strictEqual(DE.state(), v);
  assert.strictEqual(DE.seq(), 0);
});

test('adopt：epoch 前进推一格 seq，但⛔ 不通知内容订阅者（重列另有安排）', () => {
  const changed = [];
  DE.onChange(function (s) { changed.push(s); });
  assert.strictEqual(DE.adopt(view({ revision: 1, epoch: 0 })), true);
  assert.strictEqual(DE.adopt(view({ revision: 2, epoch: 5 })), true);
  assert.strictEqual(DE.seq(), 1);
  assert.deepStrictEqual(changed, []);
});

test('adopt：revision 相同或倒退的包被丢弃，状态与 seq 都不动', () => {
  DE.adopt(view({ revision: 2, epoch: 0 }));
  const before = DE.state();
  assert.strictEqual(DE.adopt(view({ revision: 2, epoch: 9 })), false);
  assert.strictEqual(DE.adopt(view({ revision: 1, epoch: 9 })), false);
  assert.strictEqual(DE.state(), before);
  assert.strictEqual(DE.seq(), 0);
});

test('adopt：恢复（reason 为 null）也是要采纳的一版', () => {
  const states = [];
  DE.onState(function (v) { states.push(v); });
  DE.adopt(view({ revision: 1, reason: 'io' }));
  DE.adopt(view({ revision: 2, reason: null }));
  assert.strictEqual(DE.state().reason, null);
  assert.strictEqual(states.length, 2);
});

test('adopt：epoch 变化（哪怕倒退）都推 seq——它表示“盘上的时刻变了”', () => {
  DE.adopt(view({ revision: 1, epoch: 5 }));
  assert.strictEqual(DE.seq(), 1);
  DE.adopt(view({ revision: 2, epoch: 3 }));
  assert.strictEqual(DE.seq(), 2);
});

test('onState：只在采纳时收到，退回的包不通知', () => {
  const states = [];
  DE.onState(function (v) { states.push(v.revision); });
  DE.adopt(view({ revision: 2 }));
  DE.adopt(view({ revision: 1 }));
  assert.deepStrictEqual(states, [2]);
});

test('onState：一个订阅者抛错不挡住另一个；退订生效', () => {
  const old = console.error;
  console.error = function () {};
  try {
    const got = [];
    const off = DE.onState(function () { throw new Error('状态条坏了'); });
    DE.onState(function (v) { got.push(v.revision); });
    DE.adopt(view({ revision: 1 }));
    off();
    DE.adopt(view({ revision: 2 }));
    assert.deepStrictEqual(got, [1, 2]);
  } finally {
    console.error = old;
  }
});

// ── 两条 IPC ─────────────────────────────────────────────────────

test('install：订阅两条通道并返回成功；树事件同步推进 seq', async () => {
  const handlers = {};
  let listens = 0;
  const T = {
    listen: async function (name, fn) { listens += 1; handlers[name] = fn; },
  };
  const r = await DE.install(T);
  assert.deepStrictEqual(r, { treeOk: true, diskOk: true, note: '' });
  assert.strictEqual(listens, 2);
  assert.strictEqual(typeof handlers[DE.TREE_EVENT], 'function');
  assert.strictEqual(typeof handlers[DE.DISK_EVENT], 'function');

  handlers[DE.TREE_EVENT]();
  assert.strictEqual(DE.seq(), 1);
  handlers[DE.DISK_EVENT]({ payload: view({ revision: 1, epoch: 0 }) });
  assert.strictEqual(DE.state().revision, 1);
});

test('install：已安装过时不重复订阅', async () => {
  let listens = 0;
  const T = { listen: async function () { listens += 1; } };
  await DE.install(T);
  const r = await DE.install(T);
  assert.strictEqual(listens, 2);
  assert.deepStrictEqual(r, { treeOk: true, diskOk: true, note: '' });
});

test('install：树通道订阅失败时回报失败原因，另一条照常装', async () => {
  const T = {
    listen: function (name) {
      if (name === DE.TREE_EVENT) throw new Error('tree down');
      return Promise.resolve();
    },
  };
  const r = await DE.install(T);
  assert.deepStrictEqual(r, { treeOk: false, diskOk: true, note: 'tree:tree down' });
});

test('install：两条都失败时 note 用分号连接（含 wording 形状的错误）', async () => {
  const T = {
    listen: function (name) {
      if (name === DE.TREE_EVENT) throw new Error('tree down');
      throw { wording: 'disk down' };
    },
  };
  const r = await DE.install(T);
  assert.deepStrictEqual(r, { treeOk: false, diskOk: false, note: 'tree:tree down; disk:disk down' });
});

test('refresh：调 reconcile_disk 并采纳回包，返回原值', async () => {
  const v = view({ revision: 3, epoch: 4 });
  const calls = [];
  const T = { call: async function (name) { calls.push(name); return v; } };
  const got = await DE.refresh(T);
  assert.strictEqual(got, v);
  assert.deepStrictEqual(calls, ['reconcile_disk']);
  assert.strictEqual(DE.state(), v);
  assert.strictEqual(DE.seq(), 1);
});

test('refresh：回包为空时不采纳也不抛', async () => {
  const T = { call: async function () { return null; } };
  assert.strictEqual(await DE.refresh(T), null);
  assert.strictEqual(DE.state(), null);
  assert.strictEqual(DE.seq(), 0);
});

test('retryWatch：调 retry_tree_watch 并采纳回包', async () => {
  const v = view({ revision: 1, epoch: 2 });
  const calls = [];
  const T = { call: async function (name) { calls.push(name); return v; } };
  const got = await DE.retryWatch(T);
  assert.strictEqual(got, v);
  assert.deepStrictEqual(calls, ['retry_tree_watch']);
  assert.strictEqual(DE.state(), v);
  assert.strictEqual(DE.seq(), 1, '重接监视的回包推了 epoch ⇒ 在途结果应当作废');
});

test('retryWatch：回包为空时不动状态', async () => {
  const T = { call: async function () { return undefined; } };
  assert.strictEqual(await DE.retryWatch(T), undefined);
  assert.strictEqual(DE.state(), null);
});

test('_reset：清空 seq / 状态 / 两个订阅表与安装标记', async () => {
  const got = [];
  DE.onChange(function (s) { got.push(s); });
  DE.adopt(view({ revision: 1, epoch: 1 }));
  let listens = 0;
  await DE.install({ listen: async function () { listens += 1; } });

  DE._reset();
  assert.strictEqual(DE.seq(), 0);
  assert.strictEqual(DE.state(), null);
  DE.bump();
  assert.deepStrictEqual(got, [], '旧订阅者必须已被清掉');

  await DE.install({ listen: async function () { listens += 1; } });
  assert.strictEqual(listens, 4, '_reset 之后允许重新安装');
});
