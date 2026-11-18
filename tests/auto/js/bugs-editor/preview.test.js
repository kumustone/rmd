// 预览三档调度：档位阈值、防抖 / B 档最小间隔、单飞、在途合并、陈旧条唯一写入点。
// 本文件从 docs/bugs 的历史缺陷出发，守住「预览停在旧内容却没有任何痕迹 / 旧回包改写新状态」。
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
  return new Promise(function (resolve) { setImmediate(resolve); });
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
    clearTimer: function (id) { timers.delete(id); },
    advance: function (ms) {
      t += ms;
      const due = [];
      timers.forEach(function (v, k) { if (v.at <= t) due.push(k); });
      due.sort(function (a, b) { return a - b; });
      for (const id of due) {
        const item = timers.get(id);
        timers.delete(id);
        if (item) item.fn();
      }
    },
    setNow: function (v) { t = v; },
    size: function () { return timers.size; },
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
    onStale: function (s, tier) { stale.push([s, tier]); },
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

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0004（编辑态改了字，预览不会自动跟上，界面上也没有任何提示）
// ——————————————————————————————————————————————————————————————

test('markEdited 是唯一推进 editSeq 的入口：它一响就变脏', () => {
  const a = setup();
  assert.strictEqual(a.s.isStale(), true);
  assert.strictEqual(a.s._editSeq(), 0);
  a.s.markEdited();
  assert.strictEqual(a.s._editSeq(), 1);
});

test('每一次编辑都重排防抖：脏了之后继续改仍然重置定时器（0004 的根因形态）', () => {
  const a = setup();
  a.s.markEdited();
  a.s.markEdited();
  a.s.markEdited();
  assert.strictEqual(a.s._editSeq(), 3);
  assert.deepStrictEqual(a.asked, [300, 300, 300]);
  assert.strictEqual(a.clock.size(), 1);
});

test('连续编辑只把「已过期」播报一次，避免提示条每键翻一次（0006 的抖动面）', () => {
  const a = setup();
  a.s.markEdited();
  a.s.markEdited();
  a.s.markEdited();
  assert.deepStrictEqual(a.stale, [[true, 'A']]);
});

test('渲染追上之后播报一次「不再过期」，之后继续编辑再播报一次', () => {
  return (async function () {
    const a = setup();
    a.s.markEdited();
    a.clock.advance(300);
    await tick();
    a.s.markEdited();
    assert.deepStrictEqual(a.stale, [[true, 'A'], [false, 'A'], [true, 'A']]);
  })();
});

test('markSaved 刻意不推进 renderSeq、不清脏、不取消定时器（保存不是预览刷新）', () => {
  const a = setup();
  a.s.markEdited();
  const before = a.s._editSeq();
  a.s.markSaved();
  assert.strictEqual(a.s._editSeq(), before);
  assert.strictEqual(a.s.isStale(), true);
  assert.strictEqual(a.clock.size(), 1);
});

test('初始化时不播报「已过期」：界面在第一次改动之前不该有提示条', () => {
  const a = setup();
  assert.strictEqual(a.s.isStale(), true);
  assert.deepStrictEqual(a.stale, []);
});

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
// ——————————————————————————————————————————————————————————————

test('在途时再编辑只置 pending，不发起第二个请求（旧包无机会覆盖新包）', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({ render: function () { return gate.promise; } });
    a.s.markEdited();
    a.clock.advance(300);
    assert.strictEqual(a.s.isInflight(), true);
    const before = a.asked.length;
    a.s.markEdited();
    assert.strictEqual(a.asked.length, before);
    assert.strictEqual(a.s.isStale(), true);
    gate.resolve({ ms: 0 });
    await tick();
    assert.strictEqual(a.s.renders(), 1);
    assert.strictEqual(a.asked.length, before + 1);
  })();
});

test('在途期间多次编辑合并成一次补渲（不是每个键一个请求）', () => {
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
  })();
});

test('在途时 requestNow 也返回 null 并只置 pending，不发第二个请求', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({ render: function () { return gate.promise; } });
    a.s.markEdited();
    a.clock.advance(300);
    assert.strictEqual(await a.s.requestNow(), null);
    assert.strictEqual(a.renders.length, 1);
    gate.resolve({ ms: 0 });
    await tick();
    assert.strictEqual(a.s.renders(), 1);
  })();
});

test('单飞让「旧包到达」这条分支在本调度器里不可达（⚠️ 疑似缺陷：防御分支是死代码）', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({ render: function () { return gate.promise; } });
    a.s.markEdited();
    a.clock.advance(300);
    const reqWhileInflight = a.s.latestReq();
    // 任何主动请求都会被 inflight 挡住，latestReq 不可能在回包前被推大。
    a.s.requestNow();
    a.s._fireNow(true);
    a.s.markEdited();
    assert.strictEqual(a.s.latestReq(), reqWhileInflight);
    gate.resolve({ ms: 0 });
    await tick();
    assert.strictEqual(a.s.renders(), 1);
    assert.strictEqual(a.s.latestReq(), reqWhileInflight);
  })();
});

test('req 序号按「真的发出去几次」推进，不按编辑次数推进', () => {
  return (async function () {
    const a = setup();
    a.s.markEdited();
    a.s.markEdited();
    a.s.markEdited();
    a.clock.advance(300);
    await tick();
    assert.strictEqual(a.s.latestReq(), 1);
    assert.strictEqual(a.s._editSeq(), 3);
    assert.strictEqual(a.s._renderSeq(), 3);
  })();
});

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0006（在编辑态打一阵字，左右两栏会一起上下抽动）
// ——————————————————————————————————————————————————————————————

test('C 档不排定时器，只把「过期」显示出来（提示条不能反复翻）', () => {
  const a = setup({ initialMs: 5000 });
  a.s.markEdited();
  assert.strictEqual(a.s.tier(), 'C');
  assert.deepStrictEqual(a.asked, []);
  assert.deepStrictEqual(a.stale, [[true, 'C']]);
  assert.strictEqual(a.clock.size(), 0);
});

test('C 档多次编辑仍然只播报一次过期', () => {
  const a = setup({ initialMs: 5000 });
  a.s.markEdited();
  a.s.markEdited();
  a.s.markEdited();
  assert.deepStrictEqual(a.stale, [[true, 'C']]);
});

test('手动 requestNow 越过 C 档直接渲染，并按实测把档位降回来', () => {
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

test('A 档每次编辑都恒定等 300ms，不看上一次渲染的时间', () => {
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

test('B 档首次没有「上一次渲染」也按 1000ms 起算', () => {
  const a = setup({ initialMs: 500 });
  a.s.markEdited();
  assert.deepStrictEqual(a.asked, [1000]);
});

test('B 档刚渲完就编辑仍等满 1000ms（抖动被压在一秒一次）', () => {
  return (async function () {
    const a = setup({ initialMs: 500, render: function () { return { ms: 500 }; } });
    a.s.markEdited();
    a.clock.advance(1000);
    await tick();
    a.clock.setNow(1100);
    a.s.markEdited();
    assert.strictEqual(a.asked[a.asked.length - 1], 1000);
    a.clock.setNow(1200);
    a.s.markEdited();
    assert.strictEqual(a.asked[a.asked.length - 1], 1000);
  })();
});

test('B 档的「最小间隔」在单调时钟下恒等于 base（⚠️ 疑似冗余：clamp 抬不高）', () => {
  return (async function () {
    const a = setup({ initialMs: 500, render: function () { return { ms: 500 }; } });
    a.s.markEdited();
    a.clock.advance(1000);
    await tick();
    // lastRenderAt=1000；只要 now ≥ lastRenderAt，earliest ≤ 1000 ⇒ max 永远是 1000。
    a.clock.setNow(1000);
    a.s.markEdited();
    assert.strictEqual(a.asked[a.asked.length - 1], 1000);
  })();
});

test('档位下降（C→A）立刻生效，不让小文档继续受大文档的卡顿档', () => {
  return (async function () {
    const a = setup({ initialMs: 5000, render: function () { return { ms: 5 }; } });
    a.s.markEdited();
    await a.s.requestNow();
    assert.strictEqual(a.s.tier(), 'A');
    a.s.markEdited();
    assert.strictEqual(a.asked[a.asked.length - 1], 300);
  })();
});

test('档位随渲染实测上升：A→B 后下一次改动的防抖变 1000ms', () => {
  return (async function () {
    const a = setup({ render: function () { return { ms: 500 }; } });
    a.s.markEdited();
    a.clock.advance(300);
    await tick();
    assert.strictEqual(a.s.tier(), 'B');
    a.s.markEdited();
    assert.deepStrictEqual(a.asked, [300, 1000]);
  })();
});

test('档位随渲染实测上升到 C 后不再自动排定时器', () => {
  return (async function () {
    const a = setup({ render: function () { return { ms: 5000 }; } });
    a.s.markEdited();
    a.clock.advance(300);
    await tick();
    assert.strictEqual(a.s.tier(), 'C');
    a.s.markEdited();
    assert.deepStrictEqual(a.asked, [300]);
  })();
});

test('⚠️ 疑似缺陷：档位在「仍旧过期」时从 A 升到 C，onStale 不会再报新档位', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({ render: function () { return gate.promise; } });
    a.s.markEdited();
    a.clock.advance(300);          // 第一次渲染在途，档位 A
    a.s.markEdited();              // 渲染期间又改 ⇒ 仍脏
    gate.resolve({ ms: 5000 });    // 实测把档位推到 C
    await tick();
    assert.strictEqual(a.s.tier(), 'C');
    assert.strictEqual(a.s.isStale(), true);
    // 现状：只在「脏布尔翻转」时播报 ⇒ 界面仍按 A/B 档显示，C 档的「更新预览」按钮不出现。
    assert.deepStrictEqual(a.stale, [[true, 'A']]);
  })();
});

// ——————————————————————————————————————————————————————————————
// tierFor：阈值边界与「没量到按最快档起步」
// ——————————————————————————————————————————————————————————————

test('三档常量与设计表一致：150 / 1000 / 300 / 1000', () => {
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

test('tierFor 对没量到的耗时按最快的 A 档起步，不一上来就卡用户', () => {
  assert.strictEqual(P.tierFor(undefined), 'A');
  assert.strictEqual(P.tierFor(NaN), 'A');
  assert.strictEqual(P.tierFor(-1), 'A');
  assert.strictEqual(P.tierFor('nope'), 'A');
  assert.strictEqual(P.tierFor(null), 'A');
});

test('初始档位来自 initialMs：缺省 A、500 B、5000 C、NaN A', () => {
  assert.strictEqual(setup().s.tier(), 'A');
  assert.strictEqual(setup({ initialMs: 500 }).s.tier(), 'B');
  assert.strictEqual(setup({ initialMs: 5000 }).s.tier(), 'C');
  assert.strictEqual(setup({ initialMs: NaN }).s.tier(), 'A');
});

test('调度器暴露的 tierFor 与模块级是同一个判据', () => {
  const a = setup();
  assert.strictEqual(a.s.tierFor(150), P.tierFor(150));
  assert.strictEqual(a.s.tierFor(150), 'B');
});

// ——————————————————————————————————————————————————————————————
// 时序与失败路径
// ——————————————————————————————————————————————————————————————

test('定时器到点后渲染一次，序号追平、脏标记撤下', () => {
  return (async function () {
    const a = setup();
    a.s.markEdited();
    a.clock.advance(300);
    assert.strictEqual(a.s.isInflight(), true);
    await tick();
    assert.deepStrictEqual(a.renders, [1]);
    assert.strictEqual(a.s.renders(), 1);
    assert.strictEqual(a.s.isStale(), false);
  })();
});

test('cancel 撤掉待触发的定时器，之后推进时钟也不再渲染，脏标记留着', () => {
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

test('手动 requestNow 在干净时也会渲染（按钮是显式动作，不受脏标记限制）', () => {
  return (async function () {
    const a = setup();
    const out = await a.s.requestNow();
    assert.deepStrictEqual(out, { ms: 0 });
    assert.strictEqual(a.s.renders(), 1);
  })();
});

test('退编辑态后自动与手动都不渲染，脏标记留着', () => {
  return (async function () {
    const a = setup({ mounted: false });
    a.s.markEdited();
    a.clock.advance(300);
    await tick();
    assert.strictEqual(a.renders.length, 0);
    assert.strictEqual(a.s.isStale(), true);
    assert.strictEqual(await a.s.requestNow(), null);
    assert.strictEqual(a.s.isInflight(), false);
  })();
});

test('render 抛错时 inflight 复位、脏标记保留、异常照常上抛', () => {
  return (async function () {
    const a = setup({
      render: function () { throw new Error('render-down'); },
    });
    await assert.rejects(a.s._fireNow(true), /render-down/);
    assert.strictEqual(a.s.isInflight(), false);
    assert.strictEqual(a.s.renders(), 0);
    assert.strictEqual(a.s.latestReq(), 1);
    assert.strictEqual(a.s.isStale(), true);
  })();
});

test('渲染失败后仍编辑，重试会拿到下一个 req 序号并成功', () => {
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

test('失败期间积下的 pending 会在失败收尾后补排一次', () => {
  return (async function () {
    const a = setup({
      render: function () { throw new Error('late-fail'); },
    });
    const inflight = a.s._fireNow(true);
    a.s.markEdited(); // 在途 ⇒ 只置 pending
    await assert.rejects(inflight, /late-fail/);
    assert.strictEqual(a.s.isInflight(), false);
    assert.strictEqual(a.asked.length, 1);
    assert.strictEqual(a.asked[0], 300);
    assert.strictEqual(a.s.isStale(), true);
  })();
});

test('失败不会拉低档位：档位只由成功回包的 ms 决定', () => {
  return (async function () {
    const a = setup({
      initialMs: 5000,
      render: function () { throw new Error('nope'); },
    });
    await assert.rejects(a.s._fireNow(true), /nope/);
    assert.strictEqual(a.s.tier(), 'C');
  })();
});

test('cancel 不动在途请求：回包仍然落地并追平序号', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({ render: function () { return gate.promise; } });
    a.s.markEdited();
    a.clock.advance(300);
    a.s.cancel();
    gate.resolve({ ms: 0 });
    await tick();
    assert.strictEqual(a.s.renders(), 1);
    assert.strictEqual(a.s.isStale(), false);
  })();
});

// ——————————————————————————————————————————————————————————————
// 回包形状与计数
// ——————————————————————————————————————————————————————————————

test('回包没有 ms 时保持原档位，不把 undefined 当 0 硬升到 A', () => {
  return (async function () {
    const a = setup({ initialMs: 5000, render: function () { return {}; } });
    await a.s.requestNow();
    assert.strictEqual(a.s.tier(), 'C');
  })();
});

test('回包为 null 时也算一次成功渲染，但不动档位', () => {
  return (async function () {
    const a = setup({ initialMs: 500, render: function () { return null; } });
    await a.s.requestNow();
    assert.strictEqual(a.s.renders(), 1);
    assert.strictEqual(a.s.tier(), 'B');
  })();
});

test('⚠️ 疑似缺陷：回包 ms 是 NaN 时按 A 档处理（契约外输入会悄悄降档）', () => {
  return (async function () {
    const a = setup({ initialMs: 5000, render: function () { return { ms: NaN }; } });
    await a.s.requestNow();
    assert.strictEqual(a.s.tier(), 'A');
  })();
});

test('回包 ms 的边界 150 / 1000 / 1000.1 决定下一档', () => {
  return (async function () {
    const a = setup({ render: function () { return { ms: 150 }; } });
    await a.s.requestNow();
    assert.strictEqual(a.s.tier(), 'B');

    const b = setup({ render: function () { return { ms: 1000 }; } });
    await b.s.requestNow();
    assert.strictEqual(b.s.tier(), 'B');

    const c = setup({ render: function () { return { ms: 1000.1 }; } });
    await c.s.requestNow();
    assert.strictEqual(c.s.tier(), 'C');
  })();
});

test('renders 只数成功回包：失败与在途都不计入', () => {
  return (async function () {
    const gate = deferred();
    let fail = false;
    const a = setup({
      render: function () {
        if (fail) throw new Error('x');
        return gate.promise;
      },
    });
    a.s.markEdited();
    a.clock.advance(300);
    assert.strictEqual(a.s.renders(), 0);
    gate.resolve({ ms: 0 });
    await tick();
    assert.strictEqual(a.s.renders(), 1);
    fail = true;
    await assert.rejects(a.s._fireNow(true), /x/);
    assert.strictEqual(a.s.renders(), 1);
  })();
});

test('latestReq 每次真的发出请求都 +1（手动渲染也占一个序号）', () => {
  return (async function () {
    const a = setup();
    await a.s.requestNow();
    assert.strictEqual(a.s.latestReq(), 1);
    await a.s.requestNow();
    assert.strictEqual(a.s.latestReq(), 2);
    assert.strictEqual(a.s.renders(), 2);
  })();
});

test('requestNow 返回的就是 render 的结果本体', () => {
  return (async function () {
    const payload = { ms: 42 };
    const a = setup({ render: function () { return payload; } });
    assert.strictEqual(await a.s.requestNow(), payload);
  })();
});

test('pending 在渲染成功且序号已追平后不会再排一次定时器', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({ render: function () { return gate.promise; } });
    a.s.markEdited();
    a.clock.advance(300);
    a.s.markEdited();
    gate.resolve({ ms: 0 });
    await tick();
    // 这次回包基于旧 editSeq ⇒ 仍脏，因此补排一次是**正确**的；再推进到点后应回到干净。
    a.clock.advance(300);
    await tick();
    assert.strictEqual(a.s.isStale(), false);
    assert.strictEqual(a.clock.size(), 0);
  })();
});

test('C 档在途期间积下的 pending 不自动补渲，等用户点按钮', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({ initialMs: 5000, render: function () { return gate.promise; } });
    a.s.markEdited();
    const inflight = a.s.requestNow();
    a.s.markEdited();
    gate.resolve({ ms: 5000 });
    await inflight;
    await tick();
    assert.strictEqual(a.s.isStale(), true);
    assert.strictEqual(a.clock.size(), 0);
  })();
});

test('档位 A 的在途期间再编辑：回包后按 A 档补排 300ms', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({ render: function () { return gate.promise; } });
    a.s.markEdited();
    a.clock.advance(300);
    a.s.markEdited();
    gate.resolve({ ms: 0 });
    await tick();
    assert.strictEqual(a.asked[a.asked.length - 1], 300);
  })();
});

test('cancel 与 markEdited 交替时始终最多一个定时器', () => {
  const a = setup();
  a.s.markEdited();
  a.s.cancel();
  a.s.markEdited();
  assert.strictEqual(a.clock.size(), 1);
  a.s.cancel();
  a.s.cancel();
  assert.strictEqual(a.clock.size(), 0);
});
