// chunked 的自动化用例（`tests/auto/js/services-b/`）。
//
// 覆盖：默认调度（空闲回调带 200 ms 超时，缺了就退 setTimeout）、首批同步 500、
// 后续分片、每片开头复检代次并整批回滚、onDone 恰好一次（含回调抛错隔离）。
// ⚠️ 依赖 `versions.js`：按 `index.html` 的加载顺序先装它，再装 chunked。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadChunked() {
  const win = {};
  for (const rel of ['src/services/versions.js', 'src/services/chunked.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    new Function('window', src)(win);
  }
  return { V: win.rmd.versions, C: win.rmd.chunked };
}

const { V, C } = loadChunked();

function nodes(from, to) {
  const out = [];
  for (let i = from; i < to; i++) out.push({ i: i });
  return out;
}

function harness(opts) {
  const o = opts || {};
  const built = [];
  const appended = [];
  const removed = [];
  const queue = [];
  let gen = o.gen === undefined ? 1 : o.gen;
  const done = [];
  const app = C.createChunkAppender({
    total: o.total === undefined ? 1200 : o.total,
    gen: gen,
    currentGen: function () { return gen; },
    build: function (from, to) { built.push([from, to]); return nodes(from, to); },
    append: function (ns) { appended.push(ns.slice()); },
    remove: function (ns) { removed.push(ns.slice()); },
    schedule: o.schedule || function (fn) { queue.push(fn); },
    step: o.step,
    onDone: function (state) { done.push(state); },
  });
  return {
    app: app,
    built: built,
    appended: appended,
    removed: removed,
    queue: queue,
    done: done,
    setGen: function (v) { gen = v; },
  };
}

function drain(h) {
  while (h.queue.length) h.queue.shift()();
}

// ── 默认调度 ─────────────────────────────────────────────────────

test('defaultSchedule：有空闲回调时带 200 ms 超时，否则可能永远不派', () => {
  const saved = globalThis.requestIdleCallback;
  let got = null;
  globalThis.requestIdleCallback = function (fn, opts) { got = { fn: fn, opts: opts }; };
  try {
    let called = 0;
    C.defaultSchedule(function () { called += 1; });
    assert.deepStrictEqual(got.opts, { timeout: 200 });
    got.fn();
    assert.strictEqual(called, 1);
  } finally {
    if (saved === undefined) delete globalThis.requestIdleCallback;
    else globalThis.requestIdleCallback = saved;
  }
});

test('defaultSchedule：没有空闲回调时退回 setTimeout，异步执行', async () => {
  const saved = globalThis.requestIdleCallback;
  delete globalThis.requestIdleCallback;
  try {
    let called = 0;
    C.defaultSchedule(function () { called += 1; });
    assert.strictEqual(called, 0, '默认调度不能同步执行回调');
    await new Promise(function (r) { setTimeout(r, 10); });
    assert.strictEqual(called, 1);
  } finally {
    if (saved !== undefined) globalThis.requestIdleCallback = saved;
  }
});

// ── 分片节奏 ─────────────────────────────────────────────────────

test('start：首批同步追加，其余排进调度器', () => {
  const h = harness();
  h.app.start();
  assert.deepStrictEqual(h.built, [[0, 500]]);
  assert.strictEqual(h.appended.length, 1);
  assert.strictEqual(h.appended[0].length, 500);
  assert.strictEqual(h.app.state.next, 500);
  assert.strictEqual(h.app.state.batches, 1);
  assert.strictEqual(h.app.state.stopped, false);
  assert.strictEqual(h.queue.length, 1);
  assert.strictEqual(h.done.length, 0);
});

test('后续分片按 500 一段推进，最后一片可以不满', () => {
  const h = harness({ total: 1201 });
  h.app.start();
  drain(h);
  assert.deepStrictEqual(h.built, [[0, 500], [500, 1000], [1000, 1201]]);
  assert.deepStrictEqual(h.appended.map(function (b) { return b.length; }), [500, 500, 201]);
  assert.strictEqual(h.app.state.next, 1201);
  assert.strictEqual(h.app.state.batches, 3);
});

test('step 只作用于后续分片：首批固定按 CHUNK_FIRST', () => {
  const h = harness({ total: 600, step: 200 });
  h.app.start();
  drain(h);
  assert.deepStrictEqual(h.built, [[0, 500], [500, 600]]);
});

test('总数不超过 CHUNK_FIRST 时首批即全部，不排后续', () => {
  const h = harness({ total: 400 });
  h.app.start();
  assert.deepStrictEqual(h.built, [[0, 400]]);
  assert.strictEqual(h.queue.length, 0);
  assert.strictEqual(h.app.state.reason, 'done');
});

test('总数恰好 1000：两批结束，没多排一次', () => {
  const h = harness({ total: 1000 });
  h.app.start();
  drain(h);
  assert.deepStrictEqual(h.built, [[0, 500], [500, 1000]]);
  assert.strictEqual(h.queue.length, 0);
});

test('total=0：不 build、不 append，直接 done', () => {
  const h = harness({ total: 0 });
  h.app.start();
  assert.deepStrictEqual(h.built, []);
  assert.strictEqual(h.appended.length, 0);
  assert.strictEqual(h.app.state.reason, 'done');
  assert.strictEqual(h.done.length, 1);
});

test('每片开头都现取一次当前代次（不是建时那一份）', () => {
  let calls = 0;
  const q = [];
  const app = C.createChunkAppender({
    total: 1200,
    gen: 1,
    currentGen: function () { calls += 1; return 1; },
    build: nodes,
    append: function () {},
    remove: function () {},
    schedule: function (fn) { q.push(fn); },
  });
  app.start();
  while (q.length) q.shift()();
  assert.strictEqual(calls, 3);
});

test('state.appended 记下每一批节点，供回滚使用', () => {
  const h = harness({ total: 1200 });
  h.app.start();
  drain(h);
  assert.strictEqual(h.app.state.appended.length, 1200);
  assert.strictEqual(h.app.state.appended[0].i, 0);
  assert.strictEqual(h.app.state.appended[1199].i, 1199);
});

// ── 中断与回滚 ───────────────────────────────────────────────────

test('分片中途代次变化：整批已追加节点从 DOM 移除', () => {
  const h = harness({ total: 1200 });
  h.app.start();
  assert.strictEqual(h.appended[0].length, 500);
  h.setGen(2);
  drain(h);
  assert.strictEqual(h.removed.length, 1);
  assert.strictEqual(h.removed[0].length, 500);
  assert.strictEqual(h.app.state.appended.length, 0);
  assert.strictEqual(h.app.state.stale, true);
  assert.strictEqual(h.app.state.reason, 'gen');
  assert.strictEqual(h.app.state.stopped, true);
  assert.deepStrictEqual(h.built, [[0, 500]], '代次变了之后不许再造节点');
});

test('start 时代次已变：一个节点都不造，也不调 remove', () => {
  const h = harness({ total: 1200, gen: 1 });
  h.setGen(2);
  h.app.start();
  assert.deepStrictEqual(h.built, []);
  assert.strictEqual(h.appended.length, 0);
  assert.strictEqual(h.removed.length, 0);
  assert.strictEqual(h.app.state.stale, true);
  assert.strictEqual(h.app.state.reason, 'gen');
});

test('回滚后 onDone 仍然恰好一次，且带 stale 状态', () => {
  const h = harness({ total: 1200 });
  h.app.start();
  h.setGen(9);
  drain(h);
  assert.strictEqual(h.done.length, 1);
  assert.strictEqual(h.done[0].stale, true);
  assert.strictEqual(h.done[0].reason, 'gen');
});

test('正常完成时 onDone 恰好一次并带 done 状态', () => {
  const h = harness({ total: 1200 });
  h.app.start();
  drain(h);
  assert.strictEqual(h.done.length, 1);
  assert.strictEqual(h.done[0], h.app.state);
  assert.strictEqual(h.done[0].reason, 'done');
  assert.strictEqual(h.done[0].stale, false);
});

test('onDone 不会被同一批的收尾调用两次（start 再调一次也不重复）', () => {
  const h = harness({ total: 0 });
  h.app.start();
  h.app.start();
  assert.strictEqual(h.done.length, 1);
});

test('onDone 抛错被拦下：不炸调用方，只落到 console.error', () => {
  const old = console.error;
  const logs = [];
  console.error = function () { logs.push([].slice.call(arguments).join(' ')); };
  try {
    const app = C.createChunkAppender({
      total: 0,
      gen: 1,
      currentGen: function () { return 1; },
      build: nodes,
      append: function () {},
      remove: function () {},
      schedule: function () {},
      onDone: function () { throw new Error('回调炸了'); },
    });
    assert.doesNotThrow(function () { app.start(); });
    assert.strictEqual(logs.length, 1);
    assert.ok(logs[0].indexOf('分片收尾') >= 0, logs[0]);
  } finally {
    console.error = old;
  }
});

test('不传 onDone 时正常跑完不抛', () => {
  const app = C.createChunkAppender({
    total: 500,
    gen: 1,
    currentGen: function () { return 1; },
    build: nodes,
    append: function () {},
    remove: function () {},
    schedule: function () {},
  });
  assert.doesNotThrow(function () { app.start(); });
  assert.strictEqual(app.state.reason, 'done');
});

test('CHUNK_FIRST / CHUNK_STEP 来自 versions，两处口径一致', () => {
  assert.strictEqual(V.CHUNK_FIRST, 500);
  assert.strictEqual(V.CHUNK_STEP, 500);
  const h = harness({ total: 1000 });
  h.app.start();
  drain(h);
  assert.strictEqual(h.built[0][1] - h.built[0][0], V.CHUNK_FIRST);
  assert.strictEqual(h.built[1][1] - h.built[1][0], V.CHUNK_STEP);
});
