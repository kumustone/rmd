// 批量 2 的测量件（`design/0002` §7.3 的计时协议）。
//
// # 这个文件只做三件事
//
// 1. ⭐ **运行时探测观测能力**（`INV-MEASURE-01`）。⚠️ 这不是"稳妥起见"：
//    本机 WKWebView 的 `PerformanceEntry::Type` 只有 8 个成员、**没有 `longtask`**，
//    而 `observe({type:'longtask'})` **不抛错、静默接受**（批 0 实测，`docs/kb/0003`）
//    ⇒ ⛔ **`try/catch` 探测不了支持性**，必须先读 `supportedEntryTypes`。
// 2. 把 `paint` / `largest-contentful-paint` 条目收下来（`T6` / `T6b`）。
// 3. 算**残差 `R = T4 − (T1+T2+T3)`**。
//    ⚠️ 它是**推导值**，不是量出来的：`R = 序列化 + IPC 往返 + 反序列化`
//    （`design/0002` §7.3.2）。⛔ 且 `Instant`（Rust）与 `performance.now()`（WebView）
//    的**纪元不同**——Rust 的三个数只能当"时长"参与减法，⛔ 绝不与前端时间戳混进同一变量。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**（经典脚本共享全局词法作用域，顶层 `const` 撞名
//     会让整个文件不执行——见 `FileTree.js` 的详细说明）。
(function () {
  'use strict';

  /** 只在这四类里观测。⛔ 不把 `longtask` 列进来——本平台没有它（`kb/0003`）。 */
  const OBSERVABLE = ['paint', 'largest-contentful-paint', 'event', 'first-input'];

  /**
   * `supportedEntryTypes` 是 WebKit 自己的静态只读属性（`kb/0003` §④）。取不到就返回空。
   *
   * ⚠️ **守卫与取值必须来自同一个对象**。写成
   * `window.PerformanceObserver && PerformanceObserver.supportedEntryTypes`
   * 在浏览器里**恰好**对（两者是同一个东西），但它在任何**另有一个全局
   * `PerformanceObserver`** 的地方都会读错——Node 就有（`dns`/`gc`/`http`…）。
   * 单测实测踩到：探到的是 Node 那一份，于是"支持 paint"判成 false，
   * T6/T6b **静默地永远是 null**，正是本文件开头那条失败形态。
   */
  function probeEntryTypes(w) {
    const g = w || (typeof window !== 'undefined' ? window : null);
    if (!g) return [];
    try {
      const PO = g.PerformanceObserver;
      const t = PO && PO.supportedEntryTypes;
      return Array.isArray(t) ? t.slice() : [];
    } catch (e) {
      return [];
    }
  }

  /** 某个 type 能不能 `observe`。⛔ 唯一的正确判据（`INV-MEASURE-01`）。 */
  function isSupported(supported, type) {
    return Array.isArray(supported) && supported.indexOf(type) >= 0;
  }

  /** 取**最后一个**同名的 `paint` 条目（`first-contentful-paint` 只会有一条）。 */
  function pickPaint(entries, name) {
    let hit = null;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i] && entries[i].name === name) hit = entries[i];
    }
    return hit;
  }

  /** 取**最后一个** LCP 条目。⚠️ LCP 会随内容变化反复派发，最后一次才是"最大的那个"。 */
  function pickLast(entries) {
    return entries && entries.length ? entries[entries.length - 1] : null;
  }

  /**
   * ⭐ **残差 R**。`design/0002` §7.3.2 把它定义为 `T4 − (T1+T2+T3)`。
   *
   * ⚠️ 三个 Rust 分段**只作为时长**参与；前端那个 `t4` 是**另一个纪元**的绝对时刻。
   * 相减得到的是"T4 期间后端没算进去的那部分"，即序列化 + IPC 往返 + 反序列化。
   */
  function residual(t4, t1, t2, t3) {
    return t4 - (t1 + t2 + t3);
  }

  /** 一组样本的 min / 中位数 / max。⚠️ 中位数在偶数个时取中间两个的均值。 */
  function stats(samples) {
    const a = (samples || []).filter(function (x) { return typeof x === 'number' && isFinite(x); });
    if (!a.length) return { n: 0, min: 0, median: 0, max: 0 };
    const s = a.slice().sort(function (x, y) { return x - y; });
    const mid = s.length >> 1;
    const median = (s.length % 2) ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    return { n: s.length, min: s[0], median: median, max: s[s.length - 1] };
  }

  /**
   * ⭐ **这台机器上 `performance.now()` 的分辨率**（毫秒）。
   *
   * ⚠️ 这不是"锦上添花"，它决定另外几个数怎么读：WebKit 出于 Spectre 缓解会把
   * 高精度时钟**粗化**，粗化到 1 ms 时，`T5 = 0` 的真实含义是
   * 「**不到 1 ms**」，⛔ 而不是「零成本」——两者在报告里长得一模一样。
   * 本项目量到的前端数（`T4`/`T5`/`T5b`/`FCP`/`LCP`）**全是整数**，
   * 而 `t1/t2/t3`（Rust 侧）带小数，两者的差别正是这个粗化。
   *
   * 做法：反复做一小段**忙等**，取"最小的**非零**间隔"。⛔ 取最小值而不是均值——
   * 均值被调度噪声抬高，会得到一个从来不是刻度的数。
   * 一次都没量到非零间隔（粗化到比忙等还大）时返回 `null`，⛔ 不返回 0。
   *
   * ⚠️ **忙等的长度必须自适应**，这是实测踩到的：固定 3000 次加法只有约 **2 µs**，
   * 而本机刻度是 **1 ms** ⇒ 24 轮里**常常一次都跨不过刻度**，于是这个数
   * **时有时无**（2026-10-14 的批次 2 首跑：三个文件里 `clock_ms` 只有 1–2 轮采到，
   * `mixed` 一次都没有）。⚠️ 它一 `null`，"`T5 = 0` 该怎么读"在那一轮就没了依据。
   * ⇒ 逐级加长忙等（×8，最多 5 级），哪一级量到非零就取哪一级。
   */
  function clockResolutionMs(perf, rounds, spin) {
    const p = perf || (typeof performance !== 'undefined' ? performance : null);
    if (!p || typeof p.now !== 'function') return null;
    const n = rounds || 24;
    let k = spin || 2000;
    for (let attempt = 0; attempt < 5; attempt++) {
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        const a = p.now();
        let s = 0;
        for (let j = 0; j < k; j++) s += j;
        const d = p.now() - a;
        if (s === -1) return null; // 永不成立：只为让上面那个循环不被优化掉
        if (d > 0 && d < best) best = d;
      }
      // ⚠️ 只有在**整级都量不到**时才加长：量到的那一级里最小值就是刻度，
      //    换更长的一级会把它抬高（忙等本身变长 ⇒ 更容易跨两格）。
      if (isFinite(best)) return best;
      k *= 8;
    }
    return null;
  }

  /** 保留 `d` 位小数。⚠️ 全项目统一用 `*_ms` 命名，⛔ 不出现裸的 `t4`。 */
  function round(n, d) {
    const f = Math.pow(10, d === undefined ? 3 : d);
    return Math.round(n * f) / f;
  }

  /**
   * 建一个测量器。⚠️ **不碰 DOM、不改状态**——它只读时钟与性能条目。
   *
   * @param {object} [env] 注入用（node 测试时传假 `performance` / `PerformanceObserver`）
   */
  function createMeasure(env) {
    const win = (env && env.window) ||
      (typeof window !== 'undefined' ? window : null) || {};
    const perf = (env && env.performance) || win.performance;
    const PO = (env && env.PerformanceObserver) ||
      (win && win.PerformanceObserver);

    const supported = probeEntryTypes(win);
    const paints = [];
    const lcps = [];
    const observers = [];

    // ⭐ 只 observe **确实支持**的 type。⚠️ 不支持的也照样"接受"而不报错，
    //    所以这里少一个判断，T6/T6b 就会**静默地永远是 null**（`kb/0003` 实测）。
    function observeType(type, sink) {
      if (!isSupported(supported, type) || typeof PO !== 'function') return false;
      try {
        const o = new PO(function (list) {
          const es = list.getEntries();
          for (let i = 0; i < es.length; i++) sink.push(es[i]);
        });
        o.observe({ type: type, buffered: true });
        observers.push(o);
        return true;
      } catch (e) {
        return false;
      }
    }

    const watching = {
      paint: observeType('paint', paints),
      lcp: observeType('largest-contentful-paint', lcps),
    };

    /** 起点标记。⚠️ `T6 = FCP.startTime − 这个 mark`（§7.3.2）。 */
    let markName = 'rmd:boot';
    try { perf.mark(markName); } catch (e) { markName = null; }

    return {
      supported: supported,
      watching: watching,

      /** 现在（WebView 时间轴）。 */
      now: function () { return perf.now(); },

      /**
       * 把一次同步动作量成耗时。⭐ `T5`（`innerHTML`）与 `T5b`（强制布局）
       * 都走它——⚠️ 口径必须写成"**这一段代码的同步耗时**"，
       * ⛔ 不是"浏览器认定的 long task"（两者不是同一个量，§7.3.3）。
       */
      span: function (fn) {
        const a = perf.now();
        const r = fn();
        const b = perf.now();
        return { ms: b - a, value: r };
      },

      /** `T6` / `T6b`：首屏绘制 / 主内容绘制。⚠️ 取不到就是 `null`，⛔ 不填 0 冒充。 */
      paints: function () {
        const fcp = pickPaint(paints, 'first-contentful-paint');
        const lcp = pickLast(lcps);
        let markT = 0;
        if (markName) {
          try {
            const ms = perf.getEntriesByName(markName);
            if (ms && ms.length) markT = ms[0].startTime;
          } catch (e) { /* 拿不到 mark 就按 0 算，等价于"从时间原点起" */ }
        }
        return {
          fcp_ms: fcp ? round(fcp.startTime - markT) : null,
          lcp_ms: lcp ? round(lcp.startTime - markT) : null,
        };
      },

      /** 读完就断开。⚠️ 不 disconnect 的话 LCP 观察器会一直留着条目。 */
      stop: function () {
        for (let i = 0; i < observers.length; i++) {
          try { observers[i].disconnect(); } catch (e) { /* 已断开 */ }
        }
        observers.length = 0;
      },
    };
  }

  const api = {
    OBSERVABLE: OBSERVABLE,
    probeEntryTypes: probeEntryTypes,
    isSupported: isSupported,
    pickPaint: pickPaint,
    pickLast: pickLast,
    residual: residual,
    stats: stats,
    round: round,
    clockResolutionMs: clockResolutionMs,
    createMeasure: createMeasure,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).measure = api;
})();
