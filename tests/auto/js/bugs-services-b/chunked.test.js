// chunked 的缺陷回归用例（`tests/auto/js/bugs-services-b/`）。
//
// 覆盖：首批同步追加、分片边界、代次在分片中途变化时的整批回滚、
// onDone 只调一次、以及调度器缺省行为。全部注入依赖，不碰 DOM。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadChunked() {
  const win = {};
  new Function('window', fs.readFileSync(path.join(ROOT, 'src', 'services', 'versions.js'), 'utf8'))(win);
  new Function('window', fs.readFileSync(path.join(ROOT, 'src', 'services', 'chunked.js'), 'utf8'))(win);
  return { C: win.rmd.chunked, V: win.rmd.versions };
}

const { C, V } = loadChunked();

/** 注入一个同步队列调度器，便于逐步驱动分片。 */
function makeQueue() {
  const q = [];
  return {
    q: q,
    schedule: function (fn) { q.push(fn); },
    drain: function () {
      let guard = 0;
      while (q.length) {
        if (++guard > 1000) throw new Error('调度队列没有收敛');
        q.shift()();
      }
    },
    runOne: function () { return q.shift()(); },
  };
}

/**
 * 造一个追加器。返回记录 build / append / remove 的数组。
 * @param {object} over
 */
function makeAppender(over) {
  const o = Object.assign({
    total: 1200, gen: 7, step: 500,
  }, over || {});
  const calls = { build: [], append: [], remove: [], done: [] };
  const queue = makeQueue();
  let genNow = o.gen;
  const app = C.createChunkAppender({
    total: o.total,
    gen: o.gen,
    currentGen: function () {
      return typeof o.currentGen === 'function' ? o.currentGen() : genNow;
    },
    build: function (from, to) {
      calls.build.push([from, to]);
      const out = [];
      for (let i = from; i < to; i++) out.push('n' + i);
      return out;
    },
    append: function (nodes) { calls.append.push(nodes.slice()); },
    remove: function (nodes) { calls.remove.push(nodes.slice()); },
    schedule: queue.schedule,
    step: o.step,
    onDone: function (st) { calls.done.push(st); },
  });
  return {
    app: app, calls: calls, queue: queue,
    setGen: function (g) { genNow = g; },
  };
}

// ── 常量与缺省调度 ────────────────────────────────────────────────

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('默认每片 500（与 versions.CHUNK_STEP 同源）', () => {
  assert.strictEqual(V.CHUNK_STEP, 500);
  const h = makeAppender({ total: 1200, step: undefined });
  assert.strictEqual(h.app.state.next, 500);
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('defaultSchedule：没有 requestIdleCallback 时退回 setTimeout(fn, 0)', async () => {
  const old = global.requestIdleCallback;
  delete global.requestIdleCallback;
  try {
    let called = 0;
    C.defaultSchedule(function () { called += 1; });
    assert.strictEqual(called, 0);
    await new Promise(function (r) { setTimeout(r, 10); });
    assert.strictEqual(called, 1);
  } finally {
    if (old !== undefined) global.requestIdleCallback = old;
  }
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('defaultSchedule：有 requestIdleCallback 时带 200ms timeout（⛔ 不许永远等空闲）', () => {
  const old = global.requestIdleCallback;
  const seen = [];
  global.requestIdleCallback = function (fn, opts) { seen.push([fn, opts]); };
  try {
    const fn = function () {};
    C.defaultSchedule(fn);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0][0], fn);
    assert.deepStrictEqual(seen[0][1], { timeout: 200 });
  } finally {
    if (old === undefined) delete global.requestIdleCallback;
    else global.requestIdleCallback = old;
  }
});

// ── 首批与状态初值 ────────────────────────────────────────────────

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('state 初值：appended 空、next=min(total,500)、未停、无原因', () => {
  const h = makeAppender({ total: 1200 });
  assert.deepStrictEqual(h.app.state.appended, []);
  assert.strictEqual(h.app.state.next, 500);
  assert.strictEqual(h.app.state.stopped, false);
  assert.strictEqual(h.app.state.stale, false);
  assert.strictEqual(h.app.state.reason, null);
  assert.strictEqual(h.app.state.batches, 0);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('total 小于 500 时 next 就是 total', () => {
  assert.strictEqual(makeAppender({ total: 120 }).app.state.next, 120);
  assert.strictEqual(makeAppender({ total: 500 }).app.state.next, 500);
  assert.strictEqual(makeAppender({ total: 0 }).app.state.next, 0);
});

// ── start：首批同步 ───────────────────────────────────────────────

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('total=0：start 直接 done，不 build 不 append', () => {
  const h = makeAppender({ total: 0 });
  h.app.start();
  assert.deepStrictEqual(h.calls.build, []);
  assert.deepStrictEqual(h.calls.append, []);
  assert.strictEqual(h.app.state.stopped, true);
  assert.strictEqual(h.app.state.reason, 'done');
  assert.strictEqual(h.calls.done.length, 1);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('total 不超过 500：一次同步追加完，不排后续分片', () => {
  const h = makeAppender({ total: 300 });
  h.app.start();
  assert.deepStrictEqual(h.calls.build, [[0, 300]]);
  assert.strictEqual(h.calls.append.length, 1);
  assert.strictEqual(h.calls.append[0].length, 300);
  assert.strictEqual(h.queue.q.length, 0);
  assert.strictEqual(h.app.state.batches, 1);
  assert.strictEqual(h.app.state.reason, 'done');
  assert.strictEqual(h.app.state.stopped, true);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('total=500 恰好一批：不排后续分片', () => {
  const h = makeAppender({ total: 500 });
  h.app.start();
  assert.deepStrictEqual(h.calls.build, [[0, 500]]);
  assert.strictEqual(h.queue.q.length, 0);
  assert.strictEqual(h.app.state.reason, 'done');
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('1200 项：首批 500 同步，剩余两批排队，最终覆盖 [0,1200)', () => {
  const h = makeAppender({ total: 1200 });
  h.app.start();
  assert.deepStrictEqual(h.calls.build, [[0, 500]]);
  assert.strictEqual(h.queue.q.length, 1);

  h.queue.drain();
  assert.deepStrictEqual(h.calls.build, [[0, 500], [500, 1000], [1000, 1200]]);
  assert.strictEqual(h.app.state.batches, 3);
  assert.strictEqual(h.app.state.next, 1200);
  assert.strictEqual(h.app.state.appended.length, 1200);
  assert.strictEqual(h.app.state.reason, 'done');
  assert.strictEqual(h.calls.done.length, 1);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('自定义步长从第二批起生效，边界仍是 [from,to)', () => {
  const h = makeAppender({ total: 507, step: 3 });
  h.app.start();
  h.queue.drain();
  assert.deepStrictEqual(h.calls.build, [[0, 500], [500, 503], [503, 506], [506, 507]]);
  assert.strictEqual(h.app.state.appended.length, 507);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('step=0 被当成缺省 500（⛔ 不死循环）', () => {
  const h = makeAppender({ total: 600, step: 0 });
  assert.strictEqual(h.app.state.next, 500);
  h.app.start();
  h.queue.drain();
  assert.deepStrictEqual(h.calls.build, [[0, 500], [500, 600]]);
});

// ── 代次变化：整批回滚 ────────────────────────────────────────────

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('start 之前代次就变了：不 build，直接 rollback(gen)', () => {
  const h = makeAppender({ total: 1200, currentGen: function () { return 8; } });
  h.app.start();
  assert.deepStrictEqual(h.calls.build, []);
  assert.deepStrictEqual(h.calls.append, []);
  assert.deepStrictEqual(h.calls.remove, []);
  assert.strictEqual(h.app.state.stale, true);
  assert.strictEqual(h.app.state.reason, 'gen');
  assert.strictEqual(h.app.state.stopped, true);
  assert.strictEqual(h.calls.done.length, 1);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('首批之后代次变化：回滚移除已追加的全部节点，⛔ 不留半截旧树', () => {
  const h = makeAppender({ total: 1200 });
  h.app.start();
  assert.strictEqual(h.app.state.appended.length, 500);

  h.setGen(8);
  h.queue.runOne();

  assert.strictEqual(h.calls.build.length, 1, '代次变了不许再造新分片');
  assert.strictEqual(h.calls.remove.length, 1);
  assert.strictEqual(h.calls.remove[0].length, 500);
  assert.strictEqual(h.calls.remove[0][0], 'n0');
  assert.strictEqual(h.calls.remove[0][499], 'n499');
  assert.deepStrictEqual(h.app.state.appended, []);
  assert.strictEqual(h.app.state.stale, true);
  assert.strictEqual(h.app.state.reason, 'gen');
  assert.strictEqual(h.app.state.stopped, true);
  assert.strictEqual(h.app.state.batches, 1);
  assert.strictEqual(h.queue.q.length, 0, '回滚后不再排剩余分片');
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('第三批时才发现代次变化：前两批一起回滚', () => {
  const h = makeAppender({ total: 2000 });
  h.app.start();
  h.queue.runOne(); // 追加 [500,1000)
  assert.strictEqual(h.app.state.appended.length, 1000);
  h.setGen(99);
  h.queue.runOne();
  assert.strictEqual(h.calls.remove[0].length, 1000);
  assert.deepStrictEqual(h.app.state.appended, []);
  assert.strictEqual(h.calls.build.length, 2);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('回滚给 remove 的是副本：之后清空 appended 不会改到它', () => {
  const h = makeAppender({ total: 1200 });
  h.app.start();
  h.setGen(8);
  h.queue.runOne();
  assert.strictEqual(h.calls.remove[0].length, 500);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('onDone 只调一次：done 与 rollback 都走同一个收尾口', () => {
  const h = makeAppender({ total: 1200 });
  h.app.start();
  h.setGen(8);
  h.queue.runOne();
  assert.strictEqual(h.calls.done.length, 1);
  assert.strictEqual(h.calls.done[0].reason, 'gen');
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('收尾之后残留的调度回调不做事（stopped 闸）', () => {
  const h = makeAppender({ total: 600 });
  h.app.start();
  const late = h.queue.q[0];
  // 手动把状态推到已收尾，再执行那个残留回调
  h.app.state.stopped = true;
  late();
  assert.strictEqual(h.calls.build.length, 1);
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('onDone 抛错被吞并记日志，不影响状态', () => {
  const old = console.error;
  const logs = [];
  console.error = function () { logs.push([].slice.call(arguments).join(' ')); };
  try {
    const queue = makeQueue();
    const app = C.createChunkAppender({
      total: 10, gen: 1, currentGen: function () { return 1; },
      build: function (a, b) { return [a, b]; },
      append: function () {},
      remove: function () {},
      schedule: queue.schedule,
      onDone: function () { throw new Error('回调坏了'); },
    });
    app.start();
    assert.strictEqual(app.state.reason, 'done');
    assert.strictEqual(logs.length, 1);
  } finally {
    console.error = old;
  }
});

// ── 边界 / 畸形输入 ───────────────────────────────────────────────

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('total 为负数：start 直接 done，不 build', () => {
  const h = makeAppender({ total: -5 });
  assert.strictEqual(h.app.state.next, -5);
  h.app.start();
  assert.deepStrictEqual(h.calls.build, []);
  assert.strictEqual(h.app.state.reason, 'done');
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('total 为 NaN：start 会排一次分片并 build(NaN,NaN)', () => {
  // ⚠️ 疑似缺陷：NaN 没被拦在入口，分片器会以 NaN 区间调 build。
  const h = makeAppender({ total: NaN });
  h.app.start();
  h.queue.drain();
  assert.deepStrictEqual(h.calls.build, [[NaN, NaN]]);
  assert.strictEqual(h.app.state.reason, 'done');
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('build 返回空数组时仍推进 next，不会卡死（但实际什么都没追加）', () => {
  const queue = makeQueue();
  const calls = [];
  const app = C.createChunkAppender({
    total: 1200, gen: 1, currentGen: function () { return 1; },
    build: function (from, to) { calls.push([from, to]); return []; },
    append: function () {},
    remove: function () {},
    schedule: queue.schedule,
  });
  app.start();
  queue.drain();
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(app.state.next, 1200);
  assert.strictEqual(app.state.batches, 3);
  assert.strictEqual(app.state.reason, 'done');
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('start 被调用两次会重复追加首批（现状如此）', () => {
  // ⚠️ 疑似缺陷：没有 started 闸，重复 start 会把首批再 build/append 一次。
  const h = makeAppender({ total: 1200 });
  h.app.start();
  h.app.start();
  assert.deepStrictEqual(h.calls.build, [[0, 500], [0, 500]]);
  assert.strictEqual(h.app.state.batches, 2);
  assert.strictEqual(h.app.state.next, 500);
});
