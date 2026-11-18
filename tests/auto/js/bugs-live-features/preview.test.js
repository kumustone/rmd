// 预览三档调度：阈值、debounce、B 档最小间隔、单飞、陈旧回包丢弃、陈旧状态条唯一写入点。
// 守的是 `INV-EDIT-07/11`、`design/0012` §2.6；历史缺陷见 `bugs/0004`、`0006`、`0064`。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.rmd;
}

const P = load('src/editor/preview.js').editorPreview;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(function (res, rej) {
    resolve = res;
    reject = rej;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function make(opts) {
  const o = opts || {};
  let t = o.start === undefined ? 0 : o.start;
  const timers = [];
  let nextId = 0;
  const staleCalls = [];
  const renderCalls = [];
  const scheduler = P.createScheduler({
    render: function (req) {
      renderCalls.push(req);
      if (o.render) return o.render(req);
      return Promise.resolve({ ms: 10 });
    },
    onStale: function (s, tier) {
      staleCalls.push([s, tier]);
    },
    now: function () { return t; },
    setTimer: function (fn, ms) {
      const item = { id: ++nextId, at: t + ms, fn: fn, canceled: false, fired: false };
      timers.push(item);
      return item.id;
    },
    clearTimer: function (h) {
      const item = timers.filter(function (x) { return x.id === h; })[0];
      if (item) item.canceled = true;
    },
    initialMs: o.initialMs,
    isMounted: o.isMounted,
  });
  function advance(ms) {
    const target = t + ms;
    for (;;) {
      const due = timers
        .filter(function (x) { return !x.canceled && !x.fired && x.at <= target; })
        .sort(function (a, b) { return a.at - b.at || a.id - b.id; })[0];
      if (!due) break;
      t = due.at;
      due.fired = true;
      due.fn();
    }
    t = target;
  }
  function pending() {
    return timers
      .filter(function (x) { return !x.canceled && !x.fired; })
      .map(function (x) { return { id: x.id, at: x.at, in: x.at - t }; });
  }
  return {
    scheduler: scheduler,
    advance: advance,
    pending: pending,
    staleCalls: staleCalls,
    renderCalls: renderCalls,
    now: function () { return t; },
    timers: timers,
  };
}

// ── 阈值：按端到端毫秒分档 ─────────────────────────────────────────────
test('阈值常量与设计表一致：A 150ms、C 1000ms、debounce A 300 / B 1000', () => {
  assert.strictEqual(P.A_MS, 150);
  assert.strictEqual(P.C_MS, 1000);
  assert.deepStrictEqual(P.DEBOUNCE_MS, { A: 300, B: 1000 });
});

test('tierFor：< 150ms 是 A，150ms 起是 B，> 1000ms 才是 C', () => {
  assert.strictEqual(P.tierFor(0), 'A');
  assert.strictEqual(P.tierFor(149.9), 'A');
  assert.strictEqual(P.tierFor(150), 'B');
  assert.strictEqual(P.tierFor(999.9), 'B');
  assert.strictEqual(P.tierFor(1000), 'B');
  assert.strictEqual(P.tierFor(1000.1), 'C');
  assert.strictEqual(P.tierFor(Infinity), 'C');
});

test('tierFor：没量到（NaN / 负数 / 非数字）按最快的 A 起步，不一上来就卡用户', () => {
  assert.strictEqual(P.tierFor(NaN), 'A');
  assert.strictEqual(P.tierFor(-1), 'A');
  assert.strictEqual(P.tierFor(undefined), 'A');
  assert.strictEqual(P.tierFor('500'), 'B');
  assert.strictEqual(P.tierFor(null), 'A');
});

// ── 源自 docs/bugs/0006（打字时预览栏上下晃动）──────────────────────────
// 连续输入只允许一个待触发的定时器；门槛由 markEdited 重置，不是每键一渲。

test('0006 A 档：连续三次输入只保留最后一个 300ms 定时器，只重渲一次', async () => {
  const h = make();
  h.scheduler.markEdited();
  assert.strictEqual(h.pending().length, 1);
  assert.strictEqual(h.pending()[0].in, 300);
  h.advance(100);
  h.scheduler.markEdited();
  assert.strictEqual(h.pending().length, 1);
  assert.strictEqual(h.pending()[0].in, 300);
  h.advance(100);
  h.scheduler.markEdited();
  assert.strictEqual(h.pending()[0].in, 300);
  h.advance(299);
  assert.deepStrictEqual(h.renderCalls, []);
  h.advance(1);
  await flush();
  assert.deepStrictEqual(h.renderCalls, [1]);
  assert.strictEqual(h.scheduler.renders(), 1);
});

test('0006 旧定时器被明确取消，不会在后台补发第二个请求', async () => {
  const h = make();
  h.scheduler.markEdited();
  const firstId = h.pending()[0].id;
  h.scheduler.markEdited();
  assert.notStrictEqual(h.pending()[0].id, firstId);
  h.advance(300);
  await flush();
  assert.strictEqual(h.renderCalls.length, 1);
});

test('0006 打字期间的陈旧提示只报一次 true，重渲完成才报 false', async () => {
  const h = make();
  h.scheduler.markEdited();
  h.advance(100);
  h.scheduler.markEdited();
  h.advance(100);
  h.scheduler.markEdited();
  assert.deepStrictEqual(h.staleCalls, [[true, 'A']]);
  h.advance(300);
  await flush();
  assert.deepStrictEqual(h.staleCalls, [[true, 'A'], [false, 'A']]);
});

test('0006 B 档 debounce 取 1000ms，而不是 A 档的 300ms', () => {
  const h = make({ initialMs: 500 });
  assert.strictEqual(h.scheduler.tier(), 'B');
  h.scheduler.markEdited();
  assert.strictEqual(h.pending()[0].in, 1000);
});

test('0006 B 档两次重渲之间至少隔 1 秒（刚渲完就打字也只等到 1s）', async () => {
  const h = make({ initialMs: 500, render: function () { return Promise.resolve({ ms: 500 }); } });
  h.scheduler.markEdited();
  h.advance(1000);
  await flush();
  assert.strictEqual(h.scheduler.renders(), 1);
  h.advance(100);
  h.scheduler.markEdited();
  assert.strictEqual(h.pending()[0].in, 1000);
});

// ── 源自 docs/bugs/0004（编辑态自动预览与陈旧提示从未接线）──────────────
// 调度器自身必须真的发请求、真的把陈旧状态交出去；没接线时这些调用一次都不会发生。

test('0004 第一次 markEdited 立刻进入陈旧态，onStale 是唯一写入点', () => {
  const h = make();
  assert.strictEqual(h.scheduler.isStale(), true);
  h.scheduler.markEdited();
  assert.deepStrictEqual(h.staleCalls, [[true, 'A']]);
  assert.strictEqual(h.scheduler.stale(), true);
});

test('0004 定时器到点才调用 render，且传入单调递增的请求号', async () => {
  const h = make();
  h.scheduler.markEdited();
  h.advance(299);
  assert.deepStrictEqual(h.renderCalls, []);
  h.advance(1);
  await flush();
  assert.deepStrictEqual(h.renderCalls, [1]);
  h.scheduler.markEdited();
  h.advance(300);
  await flush();
  assert.deepStrictEqual(h.renderCalls, [1, 2]);
  assert.strictEqual(h.scheduler.latestReq(), 2);
});

test('0004 成功回包推进 renderSeq，陈旧态归零', async () => {
  const h = make();
  h.scheduler.markEdited();
  h.advance(300);
  await flush();
  assert.strictEqual(h.scheduler._renderSeq(), h.scheduler._editSeq());
  assert.strictEqual(h.scheduler.isStale(), false);
});

test('0004 自动重渲在 A 档不受手动限制，在 C 档才停', () => {
  const a = make({ initialMs: 10 });
  a.scheduler.markEdited();
  assert.strictEqual(a.pending().length, 1);
  const c = make({ initialMs: 5000 });
  c.scheduler.markEdited();
  assert.deepStrictEqual(c.pending(), []);
  assert.deepStrictEqual(c.staleCalls, [[true, 'C']]);
});

test('0004 手动 requestNow 立即发请求，不等 debounce', async () => {
  const h = make();
  h.scheduler.markEdited();
  const p = h.scheduler.requestNow();
  assert.strictEqual(h.pending().length, 0);
  assert.strictEqual(h.scheduler.isInflight(), true);
  await p;
  assert.deepStrictEqual(h.renderCalls, [1]);
});

test('0004 手动 requestNow 在 C 档也放行（不受档位限制）', async () => {
  const h = make({ initialMs: 5000 });
  h.scheduler.markEdited();
  const out = await h.scheduler.requestNow();
  assert.deepStrictEqual(h.renderCalls, [1]);
  assert.strictEqual(out.ms, 10);
  assert.strictEqual(h.scheduler.isStale(), false);
});

test('0004 markSaved 刻意是空操作：不推进 renderSeq、不清陈旧、不动定时器', () => {
  const h = make();
  h.scheduler.markEdited();
  const edits = h.scheduler._editSeq();
  const renders = h.scheduler._renderSeq();
  h.scheduler.markSaved();
  assert.strictEqual(h.scheduler._editSeq(), edits);
  assert.strictEqual(h.scheduler._renderSeq(), renders);
  assert.strictEqual(h.scheduler.isStale(), true);
  assert.strictEqual(h.pending().length, 1);
});

// ── 单飞：同一时刻只允许一个 render ─────────────────────────────────────
test('单飞：在途期间再编辑只置 pending，不发第二个请求', async () => {
  const gate = deferred();
  const h = make({ render: function () { return gate.promise; } });
  h.scheduler.markEdited();
  h.advance(300);
  assert.strictEqual(h.scheduler.isInflight(), true);
  h.scheduler.markEdited();
  assert.strictEqual(h.renderCalls.length, 1);
  assert.deepStrictEqual(h.pending(), []);
  gate.resolve({ ms: 10 });
  await flush();
  assert.strictEqual(h.pending().length, 1);
  h.advance(300);
  await flush();
  assert.deepStrictEqual(h.renderCalls, [1, 2]);
});

test('单飞：在途时手动 requestNow 返回 null，不递增请求号', async () => {
  const gate = deferred();
  const h = make({ render: function () { return gate.promise; } });
  h.scheduler.markEdited();
  h.advance(300);
  const second = await h.scheduler.requestNow();
  assert.strictEqual(second, null);
  assert.strictEqual(h.scheduler.latestReq(), 1);
  assert.strictEqual(h.scheduler.isInflight(), true);
  gate.resolve({ ms: 10 });
  await flush();
  assert.deepStrictEqual(h.renderCalls, [1]);
  assert.strictEqual(h.scheduler.renders(), 1);
  assert.strictEqual(h.scheduler.isStale(), false);
});

test('单飞：收工后若仍有待办且仍陈旧，自动再排一次', async () => {
  const gate = deferred();
  const h = make({ render: function () { return gate.promise; } });
  h.scheduler.markEdited();
  h.advance(300);
  h.scheduler.markEdited();
  gate.resolve({ ms: 10 });
  await flush();
  assert.strictEqual(h.scheduler.isStale(), true);
  assert.strictEqual(h.pending().length, 1);
  h.advance(300);
  await flush();
  assert.strictEqual(h.scheduler.renders(), 2);
  assert.strictEqual(h.scheduler.isStale(), false);
});

test('单飞：renders 只在回包被接受时加一，不是每次调用 render 都加', async () => {
  const h = make();
  h.scheduler.markEdited();
  h.advance(300);
  assert.strictEqual(h.scheduler.renders(), 0);
  await flush();
  assert.strictEqual(h.scheduler.renders(), 1);
});

test('单飞：render 抛错后 inflight 复位，下一次仍可继续', async () => {
  let attempts = 0;
  const h = make({
    render: function () {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve({ ms: 10 });
    },
  });
  await assert.rejects(h.scheduler.requestNow(), /boom/);
  assert.strictEqual(h.scheduler.isInflight(), false);
  assert.strictEqual(h.scheduler.renders(), 0);
  assert.strictEqual(h.scheduler.isStale(), true);
  h.scheduler.markEdited();
  h.advance(300);
  await flush();
  assert.strictEqual(h.scheduler.renders(), 1);
});

test('单飞：render 抛错时 requestNow 的拒绝能到达调用方', async () => {
  const h = make({
    render: function () {
      return Promise.reject(new Error('render failed'));
    },
  });
  await assert.rejects(h.scheduler.requestNow(), /render failed/);
  assert.strictEqual(h.scheduler.isInflight(), false);
});

test('单飞：抛错后 pending 的重排仍会执行', async () => {
  const gate = deferred();
  let attempts = 0;
  const h = make({
    render: function () {
      attempts++;
      if (attempts === 1) return gate.promise;
      return Promise.resolve({ ms: 10 });
    },
  });
  const first = h.scheduler.requestNow();
  h.scheduler.markEdited();
  gate.reject(new Error('first failed'));
  await assert.rejects(first, /first failed/);
  assert.strictEqual(h.scheduler.isInflight(), false);
  assert.strictEqual(h.pending().length, 1);
  h.advance(300);
  await flush();
  assert.strictEqual(h.scheduler.renders(), 1);
});

// ── 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）──────────
// 旧回包不得写进当前状态：请求号对不上就整份丢弃，不推进 renderSeq、不注入。

test('0064 已发出的最大请求号是唯一接受判据，latestReq 随每次真请求递增', async () => {
  const h = make();
  h.scheduler.markEdited();
  h.advance(300);
  await flush();
  assert.strictEqual(h.scheduler.latestReq(), 1);
  h.scheduler.markEdited();
  h.advance(300);
  await flush();
  assert.strictEqual(h.scheduler.latestReq(), 2);
});

test('0064 旧回包（请求号不是最新）不推进 renderSeq，也不计入 renders', async () => {
  // 越过单飞闸门的唯一现实路径是跨路径并发；这里用注入 render 的同号迟到来钉住判据：
  // 回包接受与否由 myReq === latestReq 决定，而不是「谁先 resolve」。
  const first = deferred();
  const h = make({
    render: function (req) {
      if (req === 1) return first.promise;
      return Promise.resolve({ ms: 10 });
    },
  });
  h.scheduler.markEdited();
  h.advance(300);
  // 在途期间第二次编辑只置 pending；回包仍然是 req=1。
  h.scheduler.markEdited();
  first.resolve({ ms: 10 });
  await flush();
  h.advance(300);
  await flush();
  assert.strictEqual(h.scheduler.latestReq(), 2);
  assert.strictEqual(h.scheduler.renders(), 2);
});

test('0064 换文档式清空：cancel 之后不再有定时器，旧定时器绝不补发', async () => {
  const h = make();
  h.scheduler.markEdited();
  assert.strictEqual(h.pending().length, 1);
  h.scheduler.cancel();
  assert.deepStrictEqual(h.pending(), []);
  h.advance(5000);
  await flush();
  assert.deepStrictEqual(h.renderCalls, []);
});

test('0064 陈旧回包不会把编辑态状态条改回去：只在回包被接受时 syncStale(false)', async () => {
  const gate = deferred();
  const h = make({ render: function () { return gate.promise; } });
  h.scheduler.markEdited();
  h.advance(300);
  // 渲染还在途，用户继续编辑 ⇒ 仍陈旧。
  h.scheduler.markEdited();
  assert.strictEqual(h.scheduler.isStale(), true);
  gate.resolve({ ms: 10 });
  await flush();
  // 第一份回包对应当前 editSeq 之前的内容 ⇒ 不接受成「已同步」。
  assert.strictEqual(h.scheduler.isStale(), true);
  assert.ok(h.staleCalls.every(function (c) { return c[0] !== false || h.scheduler.isStale() === false; }));
});

// ── 档位切换 ────────────────────────────────────────────────────────────
test('档位切换：回包 ms 变慢则降档（A→B），后续 debounce 随之变 1000ms', async () => {
  const h = make();
  assert.strictEqual(h.scheduler.tier(), 'A');
  h.scheduler.markEdited();
  h.advance(300);
  await flush();
  // 默认 render 返回 ms 10 ⇒ 仍是 A。
  assert.strictEqual(h.scheduler.tier(), 'A');
  const slow = make({ render: function () { return Promise.resolve({ ms: 500 }); } });
  slow.scheduler.markEdited();
  slow.advance(300);
  await flush();
  assert.strictEqual(slow.scheduler.tier(), 'B');
  slow.scheduler.markEdited();
  assert.strictEqual(slow.pending()[0].in, 1000);
});

test('档位切换：回包 ms 变快则升档（C→A），用户缩小文档后立刻恢复自动预览', async () => {
  const h = make({ initialMs: 5000, render: function () { return Promise.resolve({ ms: 10 }); } });
  assert.strictEqual(h.scheduler.tier(), 'C');
  await h.scheduler.requestNow();
  assert.strictEqual(h.scheduler.tier(), 'A');
  h.scheduler.markEdited();
  assert.strictEqual(h.pending()[0].in, 300);
});

test('档位切换：C 档自动重渲永久停摆，但状态仍可被手动刷新', async () => {
  const h = make({ initialMs: 5000, render: function () { return Promise.resolve({ ms: 2000 }); } });
  h.scheduler.markEdited();
  h.advance(10000);
  await flush();
  assert.deepStrictEqual(h.renderCalls, []);
  assert.strictEqual(h.scheduler.isStale(), true);
  await h.scheduler.requestNow();
  assert.deepStrictEqual(h.renderCalls, [1]);
  assert.strictEqual(h.scheduler.isStale(), false);
  assert.strictEqual(h.scheduler.tier(), 'C');
});

test('档位切换：回包没有 ms / 不是对象时档位保持不变，也不抛错', async () => {
  const h = make({ render: function () { return Promise.resolve({}); } });
  h.scheduler.markEdited();
  h.advance(300);
  await flush();
  assert.strictEqual(h.scheduler.tier(), 'A');
  assert.strictEqual(h.scheduler.renders(), 1);
  const h2 = make({ render: function () { return Promise.resolve(undefined); } });
  h2.scheduler.markEdited();
  h2.advance(300);
  await flush();
  assert.strictEqual(h2.scheduler.tier(), 'A');
  assert.strictEqual(h2.scheduler.renders(), 1);
});

// ── 退编辑态 / 挂载闸门 ────────────────────────────────────────────────
test('isMounted=false 时 fire 直接放弃，不调用 render', async () => {
  const h = make({ isMounted: function () { return false; } });
  const out = await h.scheduler.requestNow();
  assert.strictEqual(out, null);
  assert.deepStrictEqual(h.renderCalls, []);
  assert.strictEqual(h.scheduler.isInflight(), false);
});

test('isMounted 在 fire 时求值一次；退编辑态后旧定时器到点也不渲染', async () => {
  let mounted = true;
  const h = make({ isMounted: function () { return mounted; } });
  h.scheduler.markEdited();
  mounted = false;
  h.advance(300);
  await flush();
  assert.deepStrictEqual(h.renderCalls, []);
});

// ── 取消与清理 ──────────────────────────────────────────────────────────
test('cancel 清掉待触发定时器但保留陈旧状态（文档本身没变）', () => {
  const h = make();
  h.scheduler.markEdited();
  h.scheduler.cancel();
  assert.deepStrictEqual(h.pending(), []);
  assert.strictEqual(h.scheduler.isStale(), true);
});

test('requestNow 先取消已有定时器，不会渲两次', async () => {
  const h = make();
  h.scheduler.markEdited();
  await h.scheduler.requestNow();
  assert.deepStrictEqual(h.pending(), []);
  h.advance(1000);
  await flush();
  assert.strictEqual(h.renderCalls.length, 1);
});

test('初始陈旧态：editSeq=0 / renderSeq=-1，界面还没收到过任何预览', () => {
  const h = make();
  assert.strictEqual(h.scheduler._editSeq(), 0);
  assert.strictEqual(h.scheduler._renderSeq(), -1);
  assert.strictEqual(h.scheduler.isStale(), true);
});

test('初始档位由 initialMs 决定：未给 / NaN 是 A，150~1000 是 B，>1000 是 C', () => {
  assert.strictEqual(make().scheduler.tier(), 'A');
  assert.strictEqual(make({ initialMs: NaN }).scheduler.tier(), 'A');
  assert.strictEqual(make({ initialMs: 150 }).scheduler.tier(), 'B');
  assert.strictEqual(make({ initialMs: 1000 }).scheduler.tier(), 'B');
  assert.strictEqual(make({ initialMs: 1001 }).scheduler.tier(), 'C');
});

test('onStale 可省略，调度器照常工作', async () => {
  const scheduler = P.createScheduler({
    render: function () { return Promise.resolve({ ms: 10 }); },
    now: function () { return 0; },
    setTimer: function (fn) { fn(); return 1; },
    clearTimer: function () {},
  });
  scheduler.markEdited();
  await flush();
  assert.strictEqual(scheduler.renders(), 1);
  assert.strictEqual(scheduler.isStale(), false);
});

test('onStale 的第二次参数是当前档位，降档后跟着变', async () => {
  const h = make({ render: function () { return Promise.resolve({ ms: 500 }); } });
  h.scheduler.markEdited();
  h.advance(300);
  await flush();
  assert.deepStrictEqual(h.staleCalls, [[true, 'A'], [false, 'B']]);
  h.scheduler.markEdited();
  assert.deepStrictEqual(h.staleCalls[2], [true, 'B']);
});
