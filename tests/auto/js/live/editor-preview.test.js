// 预览三档调度：档位阈值、防抖 / B 档最小间隔、单飞、在途合并、陈旧条去重与手动越过 C 档。
// 守的是 `design/0012` §2.6 与 `INV-EDIT-11`「陈旧只由一个写入点播报」。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load() {
  const src = fs.readFileSync(path.join(ROOT, 'src/editor/preview.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.rmd.editorPreview;
}

const P = load();

function tick() {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(function (res, rej) {
    resolve = res;
    reject = rej;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

function makeClock() {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: function () { return t; },
    setTimer: function (fn, ms) {
      const id = nextId++;
      timers.set(id, { fn: fn, at: t + ms });
      return id;
    },
    clearTimer: function (id) {
      timers.delete(id);
    },
    advance: function (ms) {
      t += ms;
      const due = [];
      timers.forEach(function (v, k) {
        if (v.at <= t) due.push(k);
      });
      due.sort(function (a, b) { return a - b; });
      for (const id of due) {
        const item = timers.get(id);
        timers.delete(id);
        if (item) item.fn();
      }
    },
    size: function () { return timers.size; },
    nowMs: function () { return t; },
    setNow: function (v) { t = v; },
  };
}

function setup(over) {
  const o = over || {};
  const clock = makeClock();
  const asked = [];
  const cleared = [];
  const renders = [];
  const stale = [];
  const state = { mounted: o.mounted === undefined ? true : o.mounted };
  const scheduler = P.createScheduler({
    render: async function (req) {
      renders.push(req);
      if (o.render) return o.render(req);
      return { ms: 0 };
    },
    onStale: function (s, tier) {
      stale.push([s, tier]);
    },
    now: clock.now,
    setTimer: function (fn, ms) {
      asked.push(ms);
      return clock.setTimer(fn, ms);
    },
    clearTimer: function (id) {
      cleared.push(id);
      clock.clearTimer(id);
    },
    initialMs: o.initialMs,
    isMounted: function () { return state.mounted; },
  });
  return {
    s: scheduler,
    clock: clock,
    asked: asked,
    cleared: cleared,
    renders: renders,
    stale: stale,
    state: state,
  };
}

test('三个档位常量与设计表一致', () => {
  assert.strictEqual(P.A_MS, 150);
  assert.strictEqual(P.C_MS, 1000);
  assert.deepStrictEqual(P.DEBOUNCE_MS, { A: 300, B: 1000 });
});

test('tierFor 的边界：<150 A、150–1000 B、>1000 C', () => {
  assert.strictEqual(P.tierFor(0), 'A');
  assert.strictEqual(P.tierFor(149.9), 'A');
  assert.strictEqual(P.tierFor(150), 'B');
  assert.strictEqual(P.tierFor(999.9), 'B');
  assert.strictEqual(P.tierFor(1000), 'B');
  assert.strictEqual(P.tierFor(1000.1), 'C');
  assert.strictEqual(P.tierFor(Infinity), 'C');
});

test('tierFor 对没量到的耗时按最快的 A 档起步', () => {
  assert.strictEqual(P.tierFor(undefined), 'A');
  assert.strictEqual(P.tierFor(NaN), 'A');
  assert.strictEqual(P.tierFor(-1), 'A');
  assert.strictEqual(P.tierFor('nope'), 'A');
});

test('调度器初始序号是 0 / -1（未渲染⇒脏），但不播报、不飞、档位来自 initialMs', () => {
  const a = setup();
  assert.strictEqual(a.s.isStale(), true);
  assert.strictEqual(a.s._editSeq(), 0);
  assert.strictEqual(a.s._renderSeq(), -1);
  assert.strictEqual(a.s.isInflight(), false);
  assert.strictEqual(a.s.tier(), 'A');
  assert.strictEqual(a.s.renders(), 0);
  assert.strictEqual(a.s.latestReq(), 0);
  assert.deepStrictEqual(a.stale, []);

  assert.strictEqual(setup({ initialMs: 500 }).s.tier(), 'B');
  assert.strictEqual(setup({ initialMs: 5000 }).s.tier(), 'C');
  assert.strictEqual(setup({ initialMs: undefined }).s.tier(), 'A');
});

test('markEdited 推进序号、置脏、播报一次并排一个 A 档 300ms 定时器', () => {
  const a = setup();
  a.s.markEdited();
  assert.strictEqual(a.s.isStale(), true);
  assert.strictEqual(a.s._editSeq(), 1);
  assert.strictEqual(a.s._renderSeq(), -1);
  assert.deepStrictEqual(a.stale, [[true, 'A']]);
  assert.deepStrictEqual(a.asked, [300]);
  assert.strictEqual(a.clock.size(), 1);
});

test('连续编辑只播报一次脏，但仍重置定时器', () => {
  const a = setup();
  a.s.markEdited();
  a.s.markEdited();
  assert.deepStrictEqual(a.stale, [[true, 'A']]);
  assert.deepStrictEqual(a.asked, [300, 300]);
  assert.strictEqual(a.cleared.length, 1);
  assert.strictEqual(a.clock.size(), 1);
  assert.strictEqual(a.s._editSeq(), 2);
});

test('定时器到点后渲染一次，序号追平、脏标记撤下并回报档位', () => {
  return (async function () {
    const a = setup();
    a.s.markEdited();
    a.clock.advance(300);
    assert.strictEqual(a.s.isInflight(), true);
    await tick();
    assert.deepStrictEqual(a.renders, [1]);
    assert.strictEqual(a.s.renders(), 1);
    assert.strictEqual(a.s.latestReq(), 1);
    assert.strictEqual(a.s.isStale(), false);
    assert.deepStrictEqual(a.stale, [[true, 'A'], [false, 'A']]);
  })();
});

test('markSaved 刻意什么都不做：不推进渲染序号、不清脏、不取消定时器', () => {
  const a = setup();
  a.s.markEdited();
  const seq = a.s._editSeq();
  a.s.markSaved();
  assert.strictEqual(a.s._editSeq(), seq);
  assert.strictEqual(a.s.isStale(), true);
  assert.strictEqual(a.clock.size(), 1);
});

test('在途期间再编辑只置 pending，不排第二个请求；落地后补排一次', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({
      render: function () {
        return gate.promise;
      },
    });
    a.s.markEdited();
    a.clock.advance(300);
    assert.strictEqual(a.s.isInflight(), true);
    const askedBefore = a.asked.length;
    a.s.markEdited();
    assert.strictEqual(a.s.isInflight(), true);
    assert.strictEqual(a.asked.length, askedBefore);
    assert.strictEqual(a.s.isStale(), true);

    gate.resolve({ ms: 0 });
    await tick();
    assert.strictEqual(a.s.renders(), 1);
    assert.strictEqual(a.s.isStale(), true);
    assert.strictEqual(a.asked.length, askedBefore + 1);
    a.clock.advance(300);
    await tick();
    assert.strictEqual(a.s.renders(), 2);
    assert.strictEqual(a.s.isStale(), false);
  })();
});

test('在途期间多次编辑合并成一次补渲', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({ render: function () { return gate.promise; } });
    a.s.markEdited();
    a.clock.advance(300);
    a.s.markEdited();
    a.s.markEdited();
    a.s.markEdited();
    gate.resolve({ ms: 0 });
    await tick();
    assert.strictEqual(a.s.renders(), 1);
    assert.strictEqual(a.asked.length, 2);
    a.clock.advance(300);
    await tick();
    assert.strictEqual(a.s.renders(), 2);
    assert.strictEqual(a.s._editSeq(), 4);
    assert.strictEqual(a.s._renderSeq(), 4);
  })();
});

test('在途时 requestNow 也不发第二个请求，只置 pending', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({ render: function () { return gate.promise; } });
    a.s.markEdited();
    a.clock.advance(300);
    const out = await a.s.requestNow();
    assert.strictEqual(out, null);
    assert.strictEqual(a.renders.length, 1);
    gate.resolve({ ms: 0 });
    await tick();
    assert.strictEqual(a.s.renders(), 1);
  })();
});

test('C 档编辑不排定时器，只把陈旧显示出来', () => {
  const a = setup({ initialMs: 5000 });
  a.s.markEdited();
  assert.strictEqual(a.s.tier(), 'C');
  assert.deepStrictEqual(a.asked, []);
  assert.deepStrictEqual(a.stale, [[true, 'C']]);
  assert.strictEqual(a.clock.size(), 0);
});

test('手动 requestNow 越过 C 档直接渲染，并把档位按实测降回来', () => {
  return (async function () {
    const a = setup({ initialMs: 5000 });
    a.s.markEdited();
    const out = await a.s.requestNow();
    assert.deepStrictEqual(out, { ms: 0 });
    assert.strictEqual(a.s.tier(), 'A');
    assert.strictEqual(a.s.renders(), 1);
    assert.strictEqual(a.s.isStale(), false);
    assert.deepStrictEqual(a.stale, [[true, 'C'], [false, 'A']]);
  })();
});

test('渲染回报的耗时决定下一档；档位下降也立刻生效', () => {
  return (async function () {
    const a = setup();
    a.s.markEdited();
    a.clock.advance(300);
    await tick();
    assert.strictEqual(a.s.tier(), 'A');

    const b = setup({ render: function () { return { ms: 500 }; } });
    b.s.markEdited();
    b.clock.advance(300);
    await tick();
    assert.strictEqual(b.s.tier(), 'B');
    b.s.markEdited();
    assert.deepStrictEqual(b.asked, [300, 1000]);

    const c = setup({ render: function () { return { ms: 5000 }; } });
    c.s.markEdited();
    c.clock.advance(300);
    await tick();
    assert.strictEqual(c.s.tier(), 'C');
    c.s.markEdited();
    assert.deepStrictEqual(c.asked, [300]);
  })();
});

test('B 档两次重渲至少隔 1s：刚渲完就编辑也等满 1000ms', () => {
  return (async function () {
    const a = setup({ initialMs: 500, render: function () { return { ms: 500 }; } });
    a.s.markEdited();
    a.clock.advance(1000);
    await tick();
    assert.strictEqual(a.s.tier(), 'B');
    a.clock.setNow(1100);
    a.s.markEdited();
    assert.strictEqual(a.asked[a.asked.length - 1], 1000);
    a.clock.setNow(1200);
    a.s.markEdited();
    assert.strictEqual(a.asked[a.asked.length - 1], 1000);
    a.clock.setNow(2500);
    a.s.markEdited();
    assert.strictEqual(a.asked[a.asked.length - 1], 1000);
  })();
});

test('A 档恒等 300ms，不看两次渲染的间隔', () => {
  return (async function () {
    const a = setup();
    a.s.markEdited();
    a.clock.advance(300);
    await tick();
    a.clock.setNow(1);
    a.s.markEdited();
    assert.deepStrictEqual(a.asked, [300, 300]);
  })();
});

test('cancel 撤掉待触发的定时器，之后推进时钟也不再渲染', () => {
  const a = setup();
  a.s.markEdited();
  a.s.cancel();
  assert.strictEqual(a.clock.size(), 0);
  a.clock.advance(10000);
  assert.strictEqual(a.renders.length, 0);
  assert.strictEqual(a.s.isStale(), true);
});

test('手动 requestNow 先撤掉排队中的自动重渲，再立刻发', () => {
  return (async function () {
    const a = setup();
    a.s.markEdited();
    await a.s.requestNow();
    assert.strictEqual(a.s.renders(), 1);
    assert.strictEqual(a.clock.size(), 0);
    a.clock.advance(1000);
    assert.strictEqual(a.s.renders(), 1);
  })();
});

test('isMounted 为 false 时自动与手动都不渲染，脏标记留着', () => {
  return (async function () {
    const a = setup({ mounted: false });
    a.s.markEdited();
    a.clock.advance(300);
    await tick();
    assert.strictEqual(a.renders.length, 0);
    assert.strictEqual(a.s.isStale(), true);
    assert.strictEqual(await a.s.requestNow(), null);
    assert.strictEqual(a.renders.length, 0);
    assert.strictEqual(a.s.isInflight(), false);
  })();
});

test('render 抛错时 inflight 复位、脏标记保留，异常照常上抛', () => {
  return (async function () {
    const a = setup({
      render: function () {
        throw new Error('render-down');
      },
    });
    await assert.rejects(a.s._fireNow(true), /render-down/);
    assert.strictEqual(a.s.isInflight(), false);
    assert.strictEqual(a.s.renders(), 0);
    assert.strictEqual(a.s.latestReq(), 1);
    assert.strictEqual(a.s.isStale(), true);
  })();
});

test('渲染失败后仍编辑，重试会拿到下一个 req 序号', () => {
  return (async function () {
    let n = 0;
    const a = setup({
      render: function () {
        n++;
        if (n === 1) throw new Error('first');
        return { ms: 0 };
      },
    });
    await assert.rejects(a.s._fireNow(true), /first/);
    a.s.markEdited();
    a.clock.advance(300);
    await tick();
    assert.deepStrictEqual(a.renders, [1, 2]);
    assert.strictEqual(a.s.renders(), 1);
    assert.strictEqual(a.s.isStale(), false);
  })();
});

test('onStale 只在布尔值变化时写：脏 → 再脏不重报 → 干净 → 再脏', () => {
  return (async function () {
    const a = setup();
    a.s.markEdited();
    a.s.markEdited();
    a.clock.advance(300);
    await tick();
    a.s.markEdited();
    assert.deepStrictEqual(a.stale, [[true, 'A'], [false, 'A'], [true, 'A']]);
  })();
});

test('调度器暴露的 tierFor 与模块级是同一个判据', () => {
  const a = setup();
  assert.strictEqual(a.s.tierFor(150), P.tierFor(150));
  assert.strictEqual(a.s.tierFor(150), 'B');
});

test('markEdited 在干净且定时器已排队时也先撤旧再排新，不叠加', () => {
  const a = setup();
  a.s.markEdited();
  const first = a.asked.length;
  a.s.markEdited();
  a.s.markEdited();
  assert.strictEqual(a.asked.length, first + 2);
  assert.strictEqual(a.cleared.length, 2);
  assert.strictEqual(a.clock.size(), 1);
});
