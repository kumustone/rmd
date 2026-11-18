// measure 的缺陷回归用例（`tests/auto/js/bugs-services-b/`）。
//
// 覆盖：只读 supportedEntryTypes 的探针（⛔ 不靠 try/catch）、
// T6/T6b 的取值与"取不到就是 null"、残差、统计与取整、时钟分辨率探测。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'measure.js'), 'utf8');

function loadMeasure() {
  const win = {};
  new Function('window', SRC)(win);
  return win.rmd.measure;
}

const M = loadMeasure();

function close(actual, expected, eps) {
  assert.ok(Math.abs(actual - expected) <= (eps === undefined ? 1e-9 : eps),
    actual + ' 与 ' + expected + ' 相差超过 ' + eps);
}

/** 一个按给定序列返回的假 `performance`。 */
function fakePerf(seq, extra) {
  let i = 0;
  return Object.assign({
    now: function () {
      const v = seq[Math.min(i, seq.length - 1)];
      i += 1;
      return v;
    },
    mark: function () {},
    getEntriesByName: function () { return []; },
  }, extra || {});
}

/** 造一个记录 observe / disconnect 的假 PerformanceObserver。 */
function makePO(types) {
  const log = { observed: [], disconnected: 0, instances: [] };
  function PO(cb) {
    this.cb = cb;
    this.observe = function (arg) {
      log.observed.push(arg);
      log.instances.push(this);
    };
    this.disconnect = function () { log.disconnected += 1; };
  }
  PO.supportedEntryTypes = types;
  return { PO: PO, log: log };
}

// ── 常量 ────────────────────────────────────────────────────────────

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('只观测四类，⛔ longtask 不在名单里（本平台没有它）', () => {
  assert.deepStrictEqual(M.OBSERVABLE, ['paint', 'largest-contentful-paint', 'event', 'first-input']);
  assert.strictEqual(M.OBSERVABLE.indexOf('longtask'), -1);
});

// ── probeEntryTypes：守卫与取值必须来自同一个对象 ─────────────────

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('probeEntryTypes 返回 supportedEntryTypes 的副本', () => {
  const types = ['paint', 'event'];
  const { PO } = makePO(types);
  const got = M.probeEntryTypes({ PerformanceObserver: PO });
  assert.deepStrictEqual(got, types);
  assert.notStrictEqual(got, types, '必须复制，⛔ 不把只读属性透出去');
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('probeEntryTypes：没有对象 / 没有 PerformanceObserver / 非数组都退回空', () => {
  assert.deepStrictEqual(M.probeEntryTypes(null), []);
  assert.deepStrictEqual(M.probeEntryTypes({}), []);
  assert.deepStrictEqual(M.probeEntryTypes({ PerformanceObserver: {} }), []);
  assert.deepStrictEqual(M.probeEntryTypes({ PerformanceObserver: { supportedEntryTypes: 'paint' } }), []);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('probeEntryTypes：读 supportedEntryTypes 抛错时退回空，⛔ 不抛', () => {
  const PO = {};
  Object.defineProperty(PO, 'supportedEntryTypes', {
    get: function () { throw new Error('webkit 不让读'); },
  });
  assert.deepStrictEqual(M.probeEntryTypes({ PerformanceObserver: PO }), []);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('probeEntryTypes 只认传入的对象，不读 Node 的全局 PerformanceObserver', () => {
  // 传入的 window 没有 PO：即使 Node 全局有，也必须得到空
  assert.deepStrictEqual(M.probeEntryTypes({}), []);
});

// ── isSupported ───────────────────────────────────────────────────

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('isSupported：数组里逐字匹配才算支持', () => {
  const s = ['paint', 'event'];
  assert.strictEqual(M.isSupported(s, 'paint'), true);
  assert.strictEqual(M.isSupported(s, 'event'), true);
  assert.strictEqual(M.isSupported(s, 'largest-contentful-paint'), false);
  assert.strictEqual(M.isSupported(s, 'Paint'), false);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('isSupported：非数组 / null 一律 false', () => {
  assert.strictEqual(M.isSupported(null, 'paint'), false);
  assert.strictEqual(M.isSupported('paint', 'paint'), false);
  assert.strictEqual(M.isSupported(undefined, 'paint'), false);
});

// ── pickPaint / pickLast ──────────────────────────────────────────

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('pickPaint 取最后一个同名条目，不是第一个', () => {
  const entries = [
    { name: 'first-paint', startTime: 10 },
    { name: 'first-contentful-paint', startTime: 20 },
    { name: 'first-contentful-paint', startTime: 30 },
  ];
  assert.strictEqual(M.pickPaint(entries, 'first-contentful-paint').startTime, 30);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('pickPaint：找不到 / 空数组时返回 null', () => {
  assert.strictEqual(M.pickPaint([], 'first-contentful-paint'), null);
  assert.strictEqual(M.pickPaint([{ name: 'first-paint' }], 'first-contentful-paint'), null);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('pickPaint 跳过空条目', () => {
  const entries = [null, { name: 'x', startTime: 1 }];
  assert.strictEqual(M.pickPaint(entries, 'x').startTime, 1);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('pickLast 取最后一条 LCP；空数组 / null 返回 null', () => {
  const entries = [{ startTime: 1 }, { startTime: 2 }, { startTime: 3 }];
  assert.strictEqual(M.pickLast(entries).startTime, 3);
  assert.strictEqual(M.pickLast([]), null);
  assert.strictEqual(M.pickLast(null), null);
});

// ── residual ──────────────────────────────────────────────────────

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('residual = T4 − (T1+T2+T3)', () => {
  assert.strictEqual(M.residual(100, 10, 20, 30), 40);
  assert.strictEqual(M.residual(100, 0, 0, 0), 100);
  assert.strictEqual(M.residual(10, 20, 0, 0), -10);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('residual 保留浮点差（不做取整）', () => {
  close(M.residual(10.5, 1.1, 2.2, 3.3), 3.9, 1e-12);
});

// ── stats ─────────────────────────────────────────────────────────

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('stats：空 / null / 非数组 ⇒ n=0 的零值对象', () => {
  assert.deepStrictEqual(M.stats([]), { n: 0, min: 0, median: 0, max: 0 });
  assert.deepStrictEqual(M.stats(null), { n: 0, min: 0, median: 0, max: 0 });
  assert.deepStrictEqual(M.stats(undefined), { n: 0, min: 0, median: 0, max: 0 });
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('stats：奇数个取正中，偶数个取中间两数均值', () => {
  assert.deepStrictEqual(M.stats([3, 1, 2]), { n: 3, min: 1, median: 2, max: 3 });
  assert.deepStrictEqual(M.stats([4, 1, 3, 2]), { n: 4, min: 1, median: 2.5, max: 4 });
  assert.deepStrictEqual(M.stats([10, 20]), { n: 2, min: 10, median: 15, max: 20 });
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('stats：按数值排序（10 排在 9 之后，⛔ 不按字符串）', () => {
  assert.deepStrictEqual(M.stats([9, 10, 100]), { n: 3, min: 9, median: 10, max: 100 });
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('stats：过滤 NaN / Infinity / 字符串，但保留 0 与负数', () => {
  assert.deepStrictEqual(
    M.stats([NaN, Infinity, -Infinity, '5', null, 0, -2, 4]),
    { n: 3, min: -2, median: 0, max: 4 }
  );
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('stats：不改动输入数组的顺序', () => {
  const input = [3, 1, 2];
  M.stats(input);
  assert.deepStrictEqual(input, [3, 1, 2]);
});

// ── round：测量取整 ───────────────────────────────────────────────

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('round：缺省保留 3 位小数', () => {
  assert.strictEqual(M.round(1.23456), 1.235);
  assert.strictEqual(M.round(1.2344), 1.234);
  assert.strictEqual(M.round(2), 2);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('round：指定位数，0 位即四舍五入到整数', () => {
  assert.strictEqual(M.round(1.25, 1), 1.3);
  assert.strictEqual(M.round(1.24, 1), 1.2);
  assert.strictEqual(M.round(1.5, 0), 2);
  assert.strictEqual(M.round(1.49, 0), 1);
  assert.strictEqual(M.round(1.23456, 5), 1.23456);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('round：负数与 0 原样', () => {
  assert.strictEqual(M.round(-1.2345, 2), -1.23);
  assert.strictEqual(M.round(0, 3), 0);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('round：NaN / Infinity 保持非有限（⛔ 不变成 0）', () => {
  assert.ok(Number.isNaN(M.round(NaN)));
  assert.strictEqual(M.round(Infinity), Infinity);
});

// ── clockResolutionMs ─────────────────────────────────────────────

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('clockResolutionMs：没有 now 的 perf 对象 ⇒ null；传 null 时回落全局 performance', () => {
  assert.strictEqual(M.clockResolutionMs({}, 2, 1), null);
  assert.strictEqual(M.clockResolutionMs({ now: 'x' }, 2, 1), null);
  // ⚠️ Node 也有全局 performance：传 null 不会得到 null，而是改测 Node 的时钟。
  assert.notStrictEqual(M.clockResolutionMs(null, 2, 1), null);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('clockResolutionMs：规则时钟每次前进 1ms ⇒ 分辨率 1', () => {
  let t = 0;
  const perf = { now: function () { t += 1; return t; } };
  assert.strictEqual(M.clockResolutionMs(perf, 4, 1), 1);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('clockResolutionMs：取同轮里最小的非零间隔', () => {
  const seq = [0, 5, 10, 13, 20, 24];
  const perf = fakePerf(seq);
  assert.strictEqual(M.clockResolutionMs(perf, 3, 1), 3);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('clockResolutionMs：整轮都量不到就加长忙等，下一轮量到即返回', () => {
  let calls = 0;
  const perf = {
    now: function () {
      calls += 1;
      return calls <= 4 ? 0 : calls; // 第一轮（2 次采样 ×2 次 now）全 0
    },
  };
  assert.strictEqual(M.clockResolutionMs(perf, 2, 1), 1);
  assert.ok(calls > 4, '没有进入第二轮');
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('clockResolutionMs：五轮都量不到 ⇒ null，⛔ 不返回 0', () => {
  const perf = { now: function () { return 0; } };
  assert.strictEqual(M.clockResolutionMs(perf, 2, 1), null);
});

// ── createMeasure：只 observe 确实支持的类型 ─────────────────────

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('createMeasure：supported 来自 window 的 PerformanceObserver', () => {
  const { PO } = makePO(['paint', 'event']);
  const m = M.createMeasure({ window: { PerformanceObserver: PO, performance: fakePerf([0]) } });
  assert.deepStrictEqual(m.supported, ['paint', 'event']);
  assert.deepStrictEqual(m.watching, { paint: true, lcp: false });
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('createMeasure：只对支持的 type 调 observe，并带 buffered', () => {
  const { PO, log } = makePO(['paint', 'largest-contentful-paint']);
  M.createMeasure({ window: { PerformanceObserver: PO, performance: fakePerf([0]) } });
  assert.deepStrictEqual(log.observed, [
    { type: 'paint', buffered: true },
    { type: 'largest-contentful-paint', buffered: true },
  ]);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('createMeasure：不支持的 type 一个都不 observe（⛔ 静默接受不等于支持）', () => {
  const { PO, log } = makePO(['event']);
  const m = M.createMeasure({ window: { PerformanceObserver: PO, performance: fakePerf([0]) } });
  assert.deepStrictEqual(log.observed, []);
  assert.deepStrictEqual(m.watching, { paint: false, lcp: false });
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('createMeasure：PerformanceObserver 不是构造函数 ⇒ 不 observe，⛔ 不抛', () => {
  const win = { PerformanceObserver: { supportedEntryTypes: ['paint'] }, performance: fakePerf([0]) };
  const m = M.createMeasure({ window: win });
  assert.deepStrictEqual(m.watching, { paint: false, lcp: false });
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('createMeasure：observe 抛错时该类型记 false', () => {
  function PO() {}
  PO.supportedEntryTypes = ['paint'];
  PO.prototype.observe = function () { throw new Error('拒绝'); };
  PO.prototype.disconnect = function () {};
  const m = M.createMeasure({ window: { PerformanceObserver: PO, performance: fakePerf([0]) } });
  assert.deepStrictEqual(m.watching, { paint: false, lcp: false });
});

// ── now / span ────────────────────────────────────────────────────

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('now 直接转发 performance.now', () => {
  const perf = fakePerf([7, 9]);
  const m = M.createMeasure({ window: { performance: perf } });
  assert.strictEqual(m.now(), 7);
  assert.strictEqual(m.now(), 9);
});

// 源自 docs/bugs/0010（应用冒烟的可滚判据取决于用户外观）
test('span 返回同步耗时与函数返回值', () => {
  const perf = fakePerf([100, 112.5]);
  const m = M.createMeasure({ window: { performance: perf } });
  const got = m.span(function () { return 'ok'; });
  assert.strictEqual(got.ms, 12.5);
  assert.strictEqual(got.value, 'ok');
});

// 源自 docs/bugs/0010（应用冒烟的可滚判据取决于用户外观）
test('span：被量函数抛错时异常原样传出', () => {
  const m = M.createMeasure({ window: { performance: fakePerf([1, 2]) } });
  assert.throws(function () {
    m.span(function () { throw new Error('内部炸了'); });
  }, /内部炸了/);
});

// ── paints：FCP / LCP 相对 mark ──────────────────────────────────

// 源自 docs/bugs/0010（应用冒烟的可滚判据取决于用户外观）
test('paints：FCP / LCP 都相对 boot mark 的 startTime，并保留 3 位', () => {
  const { PO, log } = makePO(['paint', 'largest-contentful-paint']);
  const perf = fakePerf([0], {
    mark: function () {},
    getEntriesByName: function (name) { return name === 'rmd:boot' ? [{ startTime: 20 }] : []; },
  });
  const m = M.createMeasure({ window: { PerformanceObserver: PO, performance: perf } });
  // 依次给两个观察器喂条目
  log.instances[0].cb({ getEntries: function () { return [{ name: 'first-contentful-paint', startTime: 120.4567 }]; } });
  log.instances[1].cb({ getEntries: function () { return [{ startTime: 200 }, { startTime: 300.9876 }]; } });
  assert.deepStrictEqual(m.paints(), { fcp_ms: 100.457, lcp_ms: 280.988 });
});

// 源自 docs/bugs/0010（应用冒烟的可滚判据取决于用户外观）
test('paints：取不到条目就是 null，⛔ 不填 0 冒充', () => {
  const { PO } = makePO(['paint', 'largest-contentful-paint']);
  const m = M.createMeasure({
    window: { PerformanceObserver: PO, performance: fakePerf([0], { getEntriesByName: function () { return []; } }) },
  });
  assert.deepStrictEqual(m.paints(), { fcp_ms: null, lcp_ms: null });
});

// 源自 docs/bugs/0010（应用冒烟的可滚判据取决于用户外观）
test('paints：mark 取不到时按时间原点算', () => {
  const { PO, log } = makePO(['paint']);
  const perf = fakePerf([0], {
    getEntriesByName: function () { throw new Error('没有 mark'); },
  });
  const m = M.createMeasure({ window: { PerformanceObserver: PO, performance: perf } });
  log.instances[0].cb({ getEntries: function () { return [{ name: 'first-contentful-paint', startTime: 50 }]; } });
  assert.deepStrictEqual(m.paints(), { fcp_ms: 50, lcp_ms: null });
});

// 源自 docs/bugs/0010（应用冒烟的可滚判据取决于用户外观）
test('paints：mark 本身抛错也不影响测量，markName 置空', () => {
  const { PO } = makePO(['paint']);
  const perf = fakePerf([0], { mark: function () { throw new Error('mark 不支持'); } });
  const m = M.createMeasure({ window: { PerformanceObserver: PO, performance: perf } });
  assert.deepStrictEqual(m.paints(), { fcp_ms: null, lcp_ms: null });
});

// ── stop ──────────────────────────────────────────────────────────

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('stop 断开所有观察器，重复调用安全', () => {
  const { PO, log } = makePO(['paint', 'largest-contentful-paint']);
  const m = M.createMeasure({ window: { PerformanceObserver: PO, performance: fakePerf([0]) } });
  m.stop();
  assert.strictEqual(log.disconnected, 2);
  assert.doesNotThrow(function () { m.stop(); });
  assert.strictEqual(log.disconnected, 2);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('stop：某个 disconnect 抛错不影响其余观察器', () => {
  let n = 0;
  function PO() {}
  PO.supportedEntryTypes = ['paint', 'largest-contentful-paint'];
  PO.prototype.observe = function () {};
  PO.prototype.disconnect = function () {
    n += 1;
    if (n === 1) throw new Error('已经断了');
  };
  const m = M.createMeasure({ window: { PerformanceObserver: PO, performance: fakePerf([0]) } });
  assert.doesNotThrow(function () { m.stop(); });
  assert.strictEqual(n, 2);
});

// 源自 docs/bugs/0095（三个离屏探针与产品脱节）
test('createMeasure 在完全没有浏览器对象时也能建（supported 空）', () => {
  const m = M.createMeasure({});
  assert.deepStrictEqual(m.supported, []);
  assert.deepStrictEqual(m.watching, { paint: false, lcp: false });
  assert.deepStrictEqual(m.paints(), { fcp_ms: null, lcp_ms: null });
});
