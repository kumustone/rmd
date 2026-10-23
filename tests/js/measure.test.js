// `design/0002` §7.3 的 JS 单测：**批 2 的测量件**。
//
// ⭐ 为什么这些必须测——批 2 的数字是「V1 要不要分块渲染」的**唯一依据**
//    （`adr/0004`），而它最容易错在**口径**上，不在代码上：
//
//   ① `INV-MEASURE-01`：本机 WKWebView **没有 `longtask`**，而
//      `observe({type})` 对不支持的 type **静默接受、不抛错**（`docs/kb/0003` 实测）
//      ⇒ ⛔ `try/catch` 探测不了支持性。少一次 `supportedEntryTypes` 判断，
//      T6/T6b 会**永远是 `null`**，而报告里那只是两个空格，看不出是"没采到"还是"没有"。
//   ② 残差 `R = T4 − (T1+T2+T3)` 是**推导值**。Rust 的 `Instant` 与 WebView 的
//      `performance.now()` **纪元不同**（§7.3.2）——把它们混进那条减法之外的地方，
//      得到的是一个看起来像数字、实际无意义的值。
//   ③ 中位数在**偶数个**样本时要取中间两个的均值。§7.3.1 要求多轮取中位数，
//      错成"取大的那个"会让结论偏向"更慢"。
//
// 跑法：`make test-js`（= `node --test tests/js/`）。
// ⚠️ 放在仓库根的 `tests/js/` 而不是 `src/`——后者会在编译期嵌进二进制。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const M = require('../../src/services/measure.js');

/** 可控时钟：`now()` 只在 `advance()`/`set()` 时前进。⚠️ ⛔ 不用真时钟——那会让断言飘。 */
function fakeClock() {
  let t = 0;
  const marks = {};
  return {
    now: function () { return t; },
    advance: function (d) { t += d; },
    mark: function (n) { marks[n] = t; },
    getEntriesByName: function (n) { return (n in marks) ? [{ startTime: marks[n] }] : []; },
  };
}

/**
 * 假的 `PerformanceObserver`。
 *
 * ⭐ 两件事都要记下来：
 * - `log` **每一次 `observe()`**——这是 `INV-MEASURE-01` 的判据：
 *   没被 observe 的 type 就永远不会有条目（而 WebKit **不会**为此报错）。
 * - `instances` 每一个观察器——这样测试能**手工喂条目**，⛔ 不依赖真 WebKit。
 */
function fakePO(supported, log) {
  function PO(cb) { this.cb = cb; this.disconnected = false; PO.instances.push(this); }
  PO.supportedEntryTypes = supported;
  PO.instances = [];
  PO.prototype.observe = function (o) { log.push(o); };
  PO.prototype.disconnect = function () { this.disconnected = true; };
  PO.prototype.report = function (entries) { this.cb({ getEntries: function () { return entries; } }); };
  return PO;
}

/** 临时把 `window` 摆到全局上（`probeEntryTypes` 读的是**全局** `window`，⛔ 不吃参数）。 */
function withGlobalWindow(win, fn) {
  const had = Object.prototype.hasOwnProperty.call(global, 'window');
  const old = global.window;
  global.window = win;
  try { return fn(); } finally {
    if (had) global.window = old; else delete global.window;
  }
}

// —— ① 支持性探测（`INV-MEASURE-01`）——

test('isSupported_只认列表里真有的_type', () => {
  const s = ['paint', 'largest-contentful-paint', 'event', 'first-input'];
  assert.equal(M.isSupported(s, 'paint'), true);
  // ⭐ 本条是 `INV-MEASURE-01` 的核心：`longtask` 在本机**不存在**，
  //    而 `observe` 照样会"接受"它 ⇒ 唯一的判据就是这张列表。
  assert.equal(M.isSupported(s, 'longtask'), false);
  assert.equal(M.isSupported(s, 'element'), false);
  assert.equal(M.isSupported(null, 'paint'), false);
  assert.equal(M.isSupported('paint', 'paint'), false); // 传字符串不算"列表"
});

test('探测_没有_PerformanceObserver_时返回空数组而不是抛', () => {
  assert.deepEqual(withGlobalWindow({}, () => M.probeEntryTypes()), []);
});

test('探测_有_PerformanceObserver_时返回它那一份的副本', () => {
  const PO = fakePO(['paint'], []);
  const got = withGlobalWindow({ PerformanceObserver: PO }, () => M.probeEntryTypes());
  assert.deepEqual(got, ['paint']);
  got.push('x'); // ⚠️ 必须是**副本**——改它不该动到 WebKit 那个只读属性
  assert.deepEqual(PO.supportedEntryTypes, ['paint']);
});

// —— ② 条目挑选 ——

test('paint_取的是_first_contentful_paint_不是_first_paint', () => {
  const es = [
    { name: 'first-paint', startTime: 10 },
    { name: 'first-contentful-paint', startTime: 42 },
  ];
  assert.equal(M.pickPaint(es, 'first-contentful-paint').startTime, 42);
});

test('paint_同名多条时取最后一条', () => {
  const es = [
    { name: 'first-contentful-paint', startTime: 42 },
    { name: 'first-contentful-paint', startTime: 99 },
  ];
  assert.equal(M.pickPaint(es, 'first-contentful-paint').startTime, 99);
  assert.equal(M.pickPaint(es, 'nope'), null);
});

test('lcp_取最后一个_因为它是持续更新的', () => {
  assert.equal(M.pickLast([{ startTime: 1 }, { startTime: 2 }]).startTime, 2);
  assert.equal(M.pickLast([]), null);
  assert.equal(M.pickLast(null), null);
});

// —— ③ 残差 `R`（推导值）——

test('残差_是_t4_减掉后端三段之和', () => {
  // ⚠️ 三个后端数**只作为时长**参与——这不是"两个时间戳相减"。
  assert.equal(M.residual(100, 10, 20, 30), 40);
});

test('残差_后端三段为零时退化成一个纯前端的值', () => {
  assert.equal(M.residual(12.5, 0, 0, 0), 12.5);
});

test('残差_可能为负_且不许被夹成零', () => {
  // ⚠️ 前端的 T4 里包着后端的 T1/T2/T3；时钟精度与"提交点判定"都可能让它略小。
  //    夹成 0 会把"这一轮后端比前端量的还慢"这个**真实信号**抹掉。
  assert.ok(M.residual(10, 4, 4, 4) < 0);
});

// —— ④ 统计（§7.3.1 要求多轮取中位数）——

test('统计_空样本返回零值而不是_NaN', () => {
  assert.deepEqual(M.stats([]), { n: 0, min: 0, median: 0, max: 0 });
  assert.deepEqual(M.stats(null), { n: 0, min: 0, median: 0, max: 0 });
});

test('统计_奇数个样本的中位数是中间那个', () => {
  assert.deepEqual(M.stats([5, 1, 3]), { n: 3, min: 1, median: 3, max: 5 });
});

test('统计_偶数个样本的中位数是中间两个的均值', () => {
  // ⚠️ 取"上中位"会让 17 文件的矩阵整体偏慢——这是最容易写错的一处。
  assert.deepEqual(M.stats([1, 2, 3, 4]), { n: 4, min: 1, median: 2.5, max: 4 });
});

test('统计_过滤掉_NaN_与_Infinity_且不改动入参', () => {
  const input = [3, NaN, 1, Infinity, 2];
  assert.deepEqual(M.stats(input), { n: 3, min: 1, median: 2, max: 3 });
  assert.equal(input.length, 5); // ⛔ 不就地 filter：调用方还要用它
});

// —— ⑤ `round` ——

test('取整_默认三位小数', () => {
  assert.equal(M.round(1.23456), 1.235);
  assert.equal(M.round(1.23456, 1), 1.2);
  assert.equal(M.round(1.5, 0), 2);
});

// —— ⑥ 测量器本身 ——

test('测量器_不支持的_type_一个观察器都不建', () => {
  const log = [];
  const PO = fakePO(['element'], log); // ⛔ 列表里**没有** paint / lcp
  const m = withGlobalWindow({ PerformanceObserver: PO }, () =>
    M.createMeasure({ window: { PerformanceObserver: PO, performance: fakeClock() } }));
  assert.deepEqual(m.watching, { paint: false, lcp: false });
  assert.equal(log.length, 0); // ⭐ 一次 `observe()` 都没发出去
  assert.equal(PO.instances.length, 0);
});

test('测量器_支持的_type_才会_observe_且带_buffered', () => {
  const log = [];
  const PO = fakePO(['paint', 'largest-contentful-paint'], log);
  const m = withGlobalWindow({ PerformanceObserver: PO }, () =>
    M.createMeasure({ window: { PerformanceObserver: PO, performance: fakeClock() } }));
  assert.deepEqual(m.watching, { paint: true, lcp: true });
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((o) => o.type).sort(), ['largest-contentful-paint', 'paint']);
  // ⚠️ `buffered: true` 不能少：批 2 是在文档已经打开**之后**才建测量器的，
  //    没有它就拿不到建之前已经发生的那次首屏绘制。
  assert.ok(log.every((o) => o.buffered === true));
});

test('测量器_span_返回动作的返回值与同步耗时', () => {
  const clock = fakeClock();
  const m = M.createMeasure({
    window: { performance: clock, PerformanceObserver: undefined },
    performance: clock, PerformanceObserver: undefined,
  });
  const r = m.span(function () { clock.advance(3.5); return 42; });
  assert.equal(r.value, 42);
  assert.equal(M.round(r.ms, 1), 3.5);
});

test('测量器_绘制时刻是相对_rmd_boot_那个_mark_的', () => {
  const clock = fakeClock();
  const log = [];
  const PO = fakePO(['paint', 'largest-contentful-paint'], log);

  clock.advance(300); // 启动地板：`rmd:boot` 之前已经过去了 300 ms
  const m = withGlobalWindow({ PerformanceObserver: PO }, () =>
    M.createMeasure({
      window: { PerformanceObserver: PO, performance: clock },
      performance: clock, PerformanceObserver: PO,
    }));
  assert.equal(PO.instances.length, 2);
  clock.advance(200);

  // 手工喂条目。⚠️ `instances[0]` 是 paint、`[1]` 是 lcp（`observeType` 的调用顺序）。
  PO.instances[0].report([{ name: 'first-contentful-paint', startTime: 520 }]);
  PO.instances[1].report([{ startTime: 590 }]);

  const p = m.paints();
  // ⚠️ 减的是 **mark（300）** 而不是 `timeOrigin`（0）——所以是 220 / 290，不是 520 / 590。
  //    这条区别是 `research/notes/0007` 那个"0.5 s 地板"能被扣掉的前提。
  assert.equal(p.fcp_ms, 220);
  assert.equal(p.lcp_ms, 290);
});

test('测量器_采不到绘制条目时是_null_不是零', () => {
  const clock = fakeClock();
  const PO = fakePO(['paint'], []);
  const m = withGlobalWindow({ PerformanceObserver: PO }, () =>
    M.createMeasure({ window: { PerformanceObserver: PO, performance: clock }, performance: clock, PerformanceObserver: PO }));
  const p = m.paints();
  // ⛔ 填 0 会让人读成"零毫秒就画出来了"，而真相是"这一轮没采到"。
  assert.equal(p.fcp_ms, null);
  assert.equal(p.lcp_ms, null);
});

test('测量器_stop_会把观察器全部断开', () => {
  const log = [];
  const PO = fakePO(['paint'], log);
  const m = withGlobalWindow({ PerformanceObserver: PO }, () =>
    M.createMeasure({ window: { PerformanceObserver: PO, performance: fakeClock() } }));
  assert.equal(PO.instances.length, 1);
  m.stop();
  assert.equal(PO.instances[0].disconnected, true);
});

// —— ⑤ 前端时钟的**刻度**（2026-10-14 落地批 2 时补）——
//
// ⭐ 为什么它值得三条测试：本机实测**前端那几个数（T4/T5/T5b/FCP/LCP）全是整数**，
//    而 Rust 侧的 `t1/t2/t3` 带小数——差别就是 WebKit 对高精度时钟的**粗化**。
//    ⇒ `t5_ms = 0` 的真实含义是「**不到一个刻度**」，⛔ 不是「零成本」。
//    没有这个数，"0"在报告里就是一个会被读错的 0。

/** 按脚本出值的时钟：`now()` 依次返回 `values`，用完了就重复最后一个。 */
function scriptedClock(values) {
  let i = 0;
  return {
    now: function () {
      const v = values[Math.min(i, values.length - 1)];
      i++;
      return v;
    },
  };
}

test('前端时钟刻度_取的是最小非零间隔而不是均值', () => {
  // 三次忙等分别跨过 3 / 7 / 7 —— 最小值 3，均值 5.67。
  // ⚠️ 均值会被调度噪声抬高，得到一个"从来不是刻度"的数。
  const p = scriptedClock([0, 3, 10, 17, 20, 27]);
  assert.equal(M.clockResolutionMs(p, 3, 10), 3);
});

test('前端时钟刻度_忙等太短量不到时会逐级加长再量', () => {
  // ⭐ 这一条守的是**实测踩到的缺陷**（2026-10-14 批次 2 首跑）：固定 2000 次加法
  // 只有约 2 µs，跨不过 1 ms 的刻度 ⇒ 大部分轮次返回 null，`clock_ms` 时有时无。
  // 脚本：前 4 次调用（第 1 级的 2 轮）全 0 ⇒ 该级失败；第 5 次起给出 5/10 的台阶。
  const p = scriptedClock([0, 0, 0, 0, 5, 10, 10, 10]);
  assert.equal(M.clockResolutionMs(p, 2, 10), 5);
});

test('前端时钟刻度_一次非零都量不到时是_null_不是零', () => {
  // 时钟完全不动（相当于刻度比忙等还粗）⇒ ⛔ 不许返回 0：
  // 0 会被下游读成"分辨率无穷高"，正好与真相相反。
  const p = scriptedClock([0]);
  assert.equal(M.clockResolutionMs(p, 4, 10), null);
});

test('前端时钟刻度_给了对象但它没有_now_是_null', () => {
  // ⚠️ 两个输入**形状一样、含义不同**，这正是本条存在的理由：
  //   · `null` / 不传 —— **回落到本模块的全局 `performance`**（与 `createMeasure(env)`
  //     同一套约定）；Node 里那个全局是真的（微秒级），所以它**不是** null。
  //     ⭐ 初版把这一条写成"传 null 应当得 null"，一跑就红（实得 0.000208）——
  //     **错的是断言不是实现**：这里测的是"回落的开关"，不是"有没有时钟"。
  //   · 显式给一个对象 —— 就**用那一个**，⛔ 不回落到全局。给了个没有 `now` 的
  //     对象说明调用方在用假时钟，此时**绝不能**偷偷换回真时钟（那样测出来的是
  //     本机 Node 的时钟，与假的 busy-loop 混在一起，数看着还挺像真的）。
  assert.equal(M.clockResolutionMs({}, 2, 10), null);
  assert.equal(M.clockResolutionMs({ now: 123 }, 2, 10), null, 'now 不是函数也算没有');
});
