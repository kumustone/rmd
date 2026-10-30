// ⭐ **提交重渲的文档级成本闸门**（2026-10-29 代码评审第 5 条）。
//
// # 它解决的是什么
//
// 就地编辑的提交只有一个出口：`mountDocument` 里 `#doc.innerHTML = payload.html`
// ＋ 紧跟一次强制布局（`design/0047` `INV-LIVE-14` 要求所有路都走它）。⇒ 单块上限
// （`LIVE_MAX_LINES` = 2000 行 / 256 KiB）管的是"这一块多大"，而用户**感知**到的
// 延迟是"这份文档多大"：实测 `t5b` 在 XL 三份语料上是 **1245 / 2660 / 3745 ms**
// （`L-plain` 也有 **401 ms**）⇒ 大文档里每离开一块就卡 0.4–3.7 s。
//
// # 选了哪条路（⛔ 不是"加一个硬上限"）
//
// **不拒绝提交**：拒绝就等于"这份文档读得了、改不了"，而定位是「阅读是目的，
// 编辑是阅读的自然延续」（`vision/0001` §2.1）——半路上把用户刚打的字判死，
// 比慢严重。⇒ 走**可见降级**：超过阈值就在状态条上说清"这一次重渲花了多少"。
//
// ⚠️ 阈值与文案都放在这里（⛔ 不内联在 `main.js`）：`main.js` 不进 `tests/js/`，
// 写在那儿的判据**测试碰不到**，而它的失效形态恰好是静默的（那句话永远不出现、
// 屏幕上一切正常）。同族先例：`services/renderstat.js`（Q22）。
//
// ⚠️ **不依赖任何 `window.rmd.*`**（字典由调用方注入）⇒ 位置本来没有自由度；
// 放 `services/renderstat.js` 旁边是**同族归置**，唯一硬约束是**排在根 `main.js` 之前**
// ——后者在**加载期**把 `window.rmd.renderbudget` 取成常量（`RB`）。
(function () {
  'use strict';

  /**
   * 超过它就算"这一次提交明显慢"。标定口径：
   * - 一次 UI 操作在 **≥ 300 ms** 之后才回到可响应，人才会开始觉得卡（远在
   *   `design/0052` 的 16 ms 一帧预算之外）；
   * - 已有一手数字：`L-plain` 的 `t5b` **401 ms**、`XL-headings` **1245 ms**、
   *   `XL-code` **2660 ms**、`XL-tables` **3745 ms**（`design/0002` 批 2 的 GUI 基准）
   *   ⇒ 这几份**全部**会触发，而普通文档（几十毫秒级）不会。
   * ⚠️ 这个数**不是**"性能目标"，是"什么时候值得告诉用户"那条线；⛔ 别拿去当预算。
   */
  const SLOW_MS = 300;

  /** 中文兜底模板（字典里 `status.commit-slow` 那条与之逐字相同）。 */
  const DEFAULT_TPL = ' · 本次重渲整篇 {ms} ms（文档越大越慢）';

  /** `t5`（`innerHTML`）＋ `t5b`（强制布局）＝这次挂载的**同步**代价。 */
  function costOf(timing) {
    const a = Number(timing && timing.t5_ms);
    const b = Number(timing && timing.t5b_ms);
    const t5 = Number.isFinite(a) && a > 0 ? a : 0;
    const t5b = Number.isFinite(b) && b > 0 ? b : 0;
    return t5 + t5b;
  }

  /**
   * 该不该说、说什么。
   *
   * @param {{t5_ms?:number, t5b_ms?:number, html_bytes?:number, rerender?:boolean}} timing
   *   `rerender` = 这一次挂载是不是**提交后的重渲**（`opts.keepScroll`）。
   *   ⚠️ 打开文档那一次（`rerender: false`）⛔ 不走这条：它是**一次性**代价，
   *   而且状态条上已经有 T1/T2/T3；在那条路上再叠一句"重渲很久"只会误导
   *   （用户会以为是编辑引起的）。
   * @param {(key: string, vars: object) => string} [tr] 翻译函数（`design/0025`）
   * @returns {{slow:boolean, ms:number, kb:number, text:string}} `text` 为空串 = 不说话
   */
  function judge(timing, tr) {
    const ms = Math.round(costOf(timing));
    const bytes = Number(timing && timing.html_bytes);
    const kb = Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024) : 0;
    const rerender = !!(timing && timing.rerender);
    const slow = rerender && ms >= SLOW_MS;
    if (!slow) return { slow: false, ms: ms, kb: kb, text: '' };
    const vars = { ms: ms, kb: kb };
    const text =
      typeof tr === 'function'
        ? tr('status.commit-slow', vars)
        : DEFAULT_TPL.replace(/\{(\w+)\}/g, function (m, name) {
            return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : '';
          });
    return { slow: true, ms: ms, kb: kb, text: text };
  }

  /** 只要那一句（状态条拼接用）；不该说时是**空串**（⛔ 不是 `undefined`）。 */
  function notice(timing, tr) {
    return judge(timing, tr).text;
  }

  (window.rmd || (window.rmd = {})).renderbudget = {
    SLOW_MS: SLOW_MS,
    DEFAULT_TPL: DEFAULT_TPL,
    judge: judge,
    notice: notice,
  };
})();
