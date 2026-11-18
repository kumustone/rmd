// measure 的自动化用例（`tests/auto/js/services-b/`）。
//
// 覆盖：观测能力探测（必须读 supportedEntryTypes，⛔ 不能靠 try/catch）、
// paint / LCP 取样、残差 R、min/中位数/max、时钟分辨率、以及测量器的装配与断开。
// ⚠️ 全部注入假 `performance` / `PerformanceObserver`，⛔ 不读真实时钟（除纯函数默认分支）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadMeasure() {
  const win = {};
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'measure.js'), 'utf8');
  new Function('window', src)(win);
  return win.rmd.measure;
}

const M = loadMeasure();

// ── 能力探测 ─────────────────────────────────────────────────────

test('OBSERVABLE：只列本平台真有的四类，⛔ 不含 longtask', () => {
  assert.deepStrictEqual(M.OBSERVABLE, ['paint', 'largest-contentful-paint', 'event', 'first-input']);
});

test('probeEntryTypes：取到 WebKit 的静态列表，返回副本', () => {
  const types = ['paint', 'largest-contentful-paint'];
  const w = { PerformanceObserver: { supportedEntryTypes: types } };
  const got = M.probeEntryTypes(w);
  assert.deepStrictEqual(got, types);
  got.push('longtask');
  assert.deepStrictEqual(types, ['paint', 'largest-contentful-paint'], '不能把副本改动写回平台属性');
});

test('probeEntryTypes：没有对象 / 列表不是数组 / 读属性抛错时返回空', () => {
  assert.deepStrictEqual(M.probeEntryTypes({}), []);
  assert.deepStrictEqual(M.probeEntryTypes(null), []);
  assert.deepStrictEqual(M.probeEntryTypes({ PerformanceObserver: {} }), []);
  assert.deepStrictEqual(M.probeEntryTypes({ PerformanceObserver: { supportedEntryTypes: 'paint' } }), []);
  const w = {};
  Object.defineProperty(w, 'PerformanceObserver', {
    get: function () { throw new Error('被禁止读取'); },
  });
  assert.deepStrictEqual(M.probeEntryTypes(w), []);
});

test('isSupported：只有数组里真的含有这个 type 才算支持', () => {
  assert.strictEqual(M.isSupported(['paint'], 'paint'), true);
  assert.strictEqual(M.isSupported(['paint'], 'longtask'), false);
  assert.strictEqual(M.isSupported([], 'paint'), false);
  assert.strictEqual(M.isSupported('paint', 'paint'), false);
  assert.strictEqual(M.isSupported(null, 'paint'), false);
});

// ── 取样 ─────────────────────────────────────────────────────────

test('pickPaint：同名条目取最后一个，且跳过 null 项', () => {
  const entries = [
    null,
    { name: 'first-paint', startTime: 1 },
    { name: 'first-contentful-paint', startTime: 2 },
    { name: 'first-contentful-paint', startTime: 3 },
  ];
  assert.strictEqual(M.pickPaint(entries, 'first-contentful-paint').startTime, 3);
  assert.strictEqual(M.pickPaint(entries, 'nope'), null);
  assert.strictEqual(M.pickPaint([], 'first-contentful-paint'), null);
});

test('pickLast：取最后一条 LCP，空列表给 null', () => {
  assert.strictEqual(M.pickLast([{ startTime: 1 }, { startTime: 2 }]).startTime, 2);
  assert.strictEqual(M.pickLast([]), null);
  assert.strictEqual(M.pickLast(null), null);
});

test('residual：R = T4 − (T1+T2+T3)', () => {
  assert.strictEqual(M.residual(100, 10, 20, 30), 40);
  assert.strictEqual(M.residual(100, 100, 0, 0), 0);
});

// ── 统计 ─────────────────────────────────────────────────────────

test('stats：空输入给全 0 的 n=0 结果', () => {
  const zero = { n: 0, min: 0, median: 0, max: 0 };
  assert.deepStrictEqual(M.stats([]), zero);
  assert.deepStrictEqual(M.stats(null), zero);
  assert.deepStrictEqual(M.stats(['5', NaN, Infinity, null]), zero);
});

test('stats：奇数个取正中，偶数个取中间两个的均值', () => {
  assert.deepStrictEqual(M.stats([3, 1, 2]), { n: 3, min: 1, median: 2, max: 3 });
  assert.deepStrictEqual(M.stats([4, 1, 2, 3]), { n: 4, min: 1, median: 2.5, max: 4 });
  assert.deepStrictEqual(M.stats([7]), { n: 1, min: 7, median: 7, max: 7 });
});

test('stats：过滤非法样本，且不改动入参数组顺序', () => {
  const input = [3, NaN, 1, 'x', 2, Infinity];
  assert.deepStrictEqual(M.stats(input), { n: 3, min: 1, median: 2, max: 3 });
  assert.deepStrictEqual(input, [3, NaN, 1, 'x', 2, Infinity]);
});

test('round：默认三位小数，可指定位数', () => {
  assert.strictEqual(M.round(1.23456), 1.235);
  assert.strictEqual(M.round(1.23456, 1), 1.2);
  assert.strictEqual(M.round(2.25, 1), 2.3);
  assert.strictEqual(M.round(3.6, 0), 4);
});

// ── 时钟分辨率 ───────────────────────────────────────────────────

test('clockResolutionMs：取最小的非零间隔', () => {
  let t = 0;
  const perf = { now: function () { const v = t; t += 1; return v; } };
  assert.strictEqual(M.clockResolutionMs(perf, 2, 10), 1);
});

test('clockResolutionMs：一次都没量到非零间隔时返回 null（不冒充 0）', () => {
  const perf = { now: function () { return 5; } };
  assert.strictEqual(M.clockResolutionMs(perf, 1, 2), null);
});

test('clockResolutionMs：拿不到 now 时返回 null', () => {
  assert.strictEqual(M.clockResolutionMs({}, 2, 2), null);
});

// ── 测量器装配 ───────────────────────────────────────────────────

function fakePerformance(opts) {
  const o = opts || {};
  let t = o.start === undefined ? 0 : o.start;
  const step = o.step === undefined ? 1 : o.step;
  const marks = [];
  return {
    now: function () { const v = t; t += step; return v; },
    mark: function (name) {
      if (o.markThrows) throw new Error('mark 不允许');
      marks.push(name);
    },
    getEntriesByName: function () {
      if (o.entriesThrows) throw new Error('取不到');
      if (o.entriesMissing) return [];
      return [{ startTime: o.markTime === undefined ? 100 : o.markTime }];
    },
    marks: marks,
  };
}

function makePO(opts) {
  const o = opts || {};
  const observers = [];
  function PO(cb) {
    if (o.ctorThrows) throw new Error('构造失败');
    const obs = {
      cb: cb,
      observed: [],
      disconnected: 0,
      observe: function (arg) {
        if (o.observeThrows) throw new Error('observe 失败');
        obs.observed.push(arg);
      },
      disconnect: function () {
        obs.disconnected += 1;
        if (o.disconnectThrows) throw new Error('断开失败');
      },
    };
    observers.push(obs);
    // ⚠️ 构造器 return 一个对象会覆盖 `new` 的默认 this——
    //    否则 instance 上没有 observe/disconnect，观察器根本装不上。
    return obs;
  }
  PO.supportedEntryTypes = o.types === undefined
    ? ['paint', 'largest-contentful-paint']
    : o.types;
  return { PO: PO, observers: observers };
}

function measureEnv(opts) {
  const o = opts || {};
  const perf = fakePerformance(o.perf);
  const po = makePO(o.po);
  const win = { performance: perf, PerformanceObserver: po.PO };
  const m = M.createMeasure({ window: win, performance: perf, PerformanceObserver: po.PO });
  return { m: m, perf: perf, po: po };
}

function feed(observer, entries) {
  observer.cb({ getEntries: function () { return entries; } });
}

test('createMeasure：只 observe 平台支持的 type，并带 buffered:true', () => {
  const h = measureEnv();
  assert.deepStrictEqual(h.m.supported, ['paint', 'largest-contentful-paint']);
  assert.deepStrictEqual(h.m.watching, { paint: true, lcp: true });
  assert.strictEqual(h.po.observers.length, 2);
  assert.deepStrictEqual(h.po.observers[0].observed, [{ type: 'paint', buffered: true }]);
  assert.deepStrictEqual(h.po.observers[1].observed, [{ type: 'largest-contentful-paint', buffered: true }]);
});

test('createMeasure：平台只支持 paint 时不给 LCP 建观察器', () => {
  const h = measureEnv({ po: { types: ['paint'] } });
  assert.deepStrictEqual(h.m.watching, { paint: true, lcp: false });
  assert.strictEqual(h.po.observers.length, 1);
});

test('createMeasure：平台什么都不支持时两个都不观察（⛔ 不静默假成功）', () => {
  const h = measureEnv({ po: { types: [] } });
  assert.deepStrictEqual(h.m.watching, { paint: false, lcp: false });
  assert.strictEqual(h.po.observers.length, 0);
});

test('createMeasure：PerformanceObserver 不是函数时不观察', () => {
  const perf = fakePerformance();
  const m = M.createMeasure({
    window: { performance: perf, PerformanceObserver: { supportedEntryTypes: ['paint'] } },
    performance: perf,
    PerformanceObserver: null,
  });
  assert.deepStrictEqual(m.watching, { paint: false, lcp: false });
});

test('createMeasure：构造或 observe 抛错时该 type 判为未观察', () => {
  const a = measureEnv({ po: { ctorThrows: true } });
  assert.deepStrictEqual(a.m.watching, { paint: false, lcp: false });
  assert.strictEqual(a.po.observers.length, 0);

  const b = measureEnv({ po: { observeThrows: true } });
  assert.deepStrictEqual(b.m.watching, { paint: false, lcp: false });
  assert.strictEqual(b.po.observers.length, 2, '观察器造出来了，但 observe 失败 ⇒ 不列入 watching');
});

test('createMeasure：启动时打 rmd:boot 标记', () => {
  const h = measureEnv();
  assert.deepStrictEqual(h.perf.marks, ['rmd:boot']);
});

test('now：直接读注入的 performance.now', () => {
  const h = measureEnv({ perf: { start: 42, step: 1 } });
  assert.strictEqual(h.m.now(), 42);
});

test('span：返回这段同步代码的耗时与返回值', () => {
  const h = measureEnv({ perf: { start: 0, step: 5 } });
  const r = h.m.span(function () { return 'value'; });
  assert.strictEqual(r.ms, 5);
  assert.strictEqual(r.value, 'value');
});

test('span：被测代码抛错时错误照常外抛（⛔ 不吞）', () => {
  const h = measureEnv({ perf: { start: 0, step: 1 } });
  assert.throws(function () { h.m.span(function () { throw new Error('炸了'); }); }, /炸了/);
});

test('paints：FCP / LCP 相对 rmd:boot 的差值，保留三位小数', () => {
  const h = measureEnv({ perf: { start: 0, step: 1 }, po: { types: ['paint', 'largest-contentful-paint'] } });
  feed(h.po.observers[0], [
    { name: 'first-paint', startTime: 120 },
    { name: 'first-contentful-paint', startTime: 150.1234 },
  ]);
  feed(h.po.observers[1], [{ startTime: 250 }, { startTime: 300.555 }]);
  assert.deepStrictEqual(h.m.paints(), { fcp_ms: 50.123, lcp_ms: 200.555 });
});

test('paints：没有条目时两项都是 null（⛔ 不填 0 冒充）', () => {
  const h = measureEnv();
  assert.deepStrictEqual(h.m.paints(), { fcp_ms: null, lcp_ms: null });
});

test('paints：mark 失败时从时间原点起算', () => {
  const h = measureEnv({ perf: { markThrows: true }, po: { types: ['paint'] } });
  feed(h.po.observers[0], [{ name: 'first-contentful-paint', startTime: 150 }]);
  assert.deepStrictEqual(h.m.paints(), { fcp_ms: 150, lcp_ms: null });
});

test('paints：取不到 / 取 mark 抛错时也按 0 起算', () => {
  const a = measureEnv({ perf: { entriesMissing: true }, po: { types: ['paint'] } });
  feed(a.po.observers[0], [{ name: 'first-contentful-paint', startTime: 80 }]);
  assert.strictEqual(a.m.paints().fcp_ms, 80);

  const b = measureEnv({ perf: { entriesThrows: true }, po: { types: ['paint'] } });
  feed(b.po.observers[0], [{ name: 'first-contentful-paint', startTime: 90 }]);
  assert.strictEqual(b.m.paints().fcp_ms, 90);
});

test('stop：断开全部观察器，重复调用不抛', () => {
  const h = measureEnv();
  h.m.stop();
  assert.strictEqual(h.po.observers[0].disconnected, 1);
  assert.strictEqual(h.po.observers[1].disconnected, 1);
  assert.doesNotThrow(function () { h.m.stop(); });
  assert.strictEqual(h.po.observers[0].disconnected, 1);
});

test('stop：disconnect 抛错也被吞掉，继续断下一个', () => {
  const h = measureEnv({ po: { disconnectThrows: true } });
  assert.doesNotThrow(function () { h.m.stop(); });
  assert.strictEqual(h.po.observers[0].disconnected, 1);
  assert.strictEqual(h.po.observers[1].disconnected, 1);
});

test('createMeasure：不传 window 时也能用注入的 performance / PO 工作', () => {
  const perf = fakePerformance({ start: 7, step: 2 });
  const po = makePO({ types: ['paint'] });
  const m = M.createMeasure({ performance: perf, PerformanceObserver: po.PO });
  assert.strictEqual(m.now(), 7);
  assert.deepStrictEqual(m.watching, { paint: false, lcp: false }, '没有 window 时 supported 取不到');
  assert.deepStrictEqual(perf.marks, ['rmd:boot']);
});
