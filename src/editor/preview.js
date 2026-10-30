// 预览的**调度状态机**（`design/0012` §2.6）——纯逻辑，⛔ 无 DOM、⛔ 无 IPC、⛔ 无真计时器。
//
// # 为什么它必须单独一个文件、而且是纯的
//
// §2.6 的三档降级、单飞、独立 `req`、陈旧可见，全是**时序**性质的东西——
// 而时序性质**只能靠确定性单测**守住（`tests/js/editor.test.js`）。
// 把它们与 DOM/IPC 揉在一起，唯一能测的形态就变成"开个窗口敲几下看看"，
// 而本项目对那种验证有一个明确的判词：**不算验证**（`design/0002` §7.0）。
//
// # ⚠️ 必须理解的一件事（§2.6-1，这是决策 6 的原话）
//
// `render_preview` 是 `async` ⇒ **解析**不占主线程；但结果回来之后
// `mountDocument()` 的 **`innerHTML`** 与紧随其后的**强制布局**仍然在 WebView 主线程上，
// 那期间**输入是排队的**。⇒ ⛔ **debounce 只降低频率，不能缩短单次长布局**。
// 三档降级里 C 档"⛔ 不自动重渲"正是承认这一点：既然一次就要一秒以上，
// 那就**别在用户打字时**去付这笔钱，改成一个用户自己决定的按钮。
//
// ⚠️ 与 `src/services/reload.js` 一样：⛔ 纯逻辑、可 `node --test`、**必须**包 IIFE。
(function () {
  'use strict';

  /**
   * ⭐ **三档的阈值**（§2.6-2 的表）。
   *
   * ⚠️⚠️ **这两个数是外推初值，⛔ 不是既成事实**：§1.3(a) 量的是**阅读路径的全量重渲**
   * （1 MB 91 ms → 5 MB 454 ms → 10 MB 0.9–6.2 s），**编辑路径的端到端成本尚未测**。
   * ⇒ §7 步骤 **0f** 的实测出来之后**原地改下面这两个数**，⛔ 不许另开一份"实测版"。
   *    ⚠️ 这正是 `design/0006` 的 126× 教训的用法：**按实测延迟分档，⛔ 不按文件大小**。
   */
  const A_MS = 150;   // 端到端 < 150 ms ⇒ 档 A（自动、300 ms）
  const C_MS = 1000;  // 端到端 > 1 s   ⇒ 档 C（⛔ 不自动重渲）

  /** 停止输入之后等多久才重渲。⚠️ B 档那 1 s 是"两次重渲至少隔 1 s"的**同一个数**。 */
  const DEBOUNCE_MS = { A: 300, B: 1000 };

  /** 按**实测的端到端毫秒**分档（`t1+t2+t3` 之外的 `innerHTML` ＋ 强制布局也算在里面）。 */
  function tierFor(ms) {
    if (!(ms >= 0)) return 'A';   // ⚠️ 没量到（NaN/undefined）⇒ 按最快的档起步，别一上来就卡用户
    if (ms < A_MS) return 'A';
    if (ms <= C_MS) return 'B';
    return 'C';
  }

  /**
   * 建一个调度器。
   *
   * @param {object} opts
   * @param {Function} opts.render     `(req) => Promise<{ms: number}>` —— **由调用方**发 IPC、
   *                                   量端到端耗时、挂 DOM。⚠️ 它返回的 `ms` 是**下一个**档位的判据。
   * @param {Function} opts.onStale    `(stale: boolean, tier: string) => void` —— ⭐
   *                                   **陈旧状态条的唯一写入点**（`INV-EDIT-11`）。
   * @param {Function} [opts.now]      注入时钟（单测用）
   * @param {Function} [opts.setTimer] 注入 `setTimeout`（单测用）
   * @param {Function} [opts.clearTimer] 注入 `clearTimeout`（单测用）
   * @param {number}   [opts.initialMs] 起始档位的依据（见 `prime`）
   */
  function createScheduler(opts) {
    const now = opts.now || function () { return Date.now(); };
    const setTimer = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    const clearTimer = opts.clearTimer || function (h) { clearTimeout(h); };
    const render = opts.render;
    const onStale = opts.onStale || function () {};

    /**
     * ⭐ **两个序号，而不是"两份文本"**。
     *
     * 比较两份 10 MB 字符串在每次敲键时都是 O(n)（§1.3(a)：10 MB 档本来就要 0.9–6.2 s，
     * 别在上面再加一笔）；而"缓冲改过几次 / 预览是基于第几次改的"是 O(1)。
     * ⇒ 陈旧 ⟺ `editSeq !== renderSeq`。⚠️ 与"内容级基线"（§2.4-3，后端那份）**不是一回事**：
     * 那边要的是**逐字节**，这边要的是"界面该不该提示"，两者判据故意不同。
     */
    let editSeq = 0;
    let renderSeq = -1;

    /** `req` 计数器：⭐ **独立**于 `session.latestReq`（`INV-EDIT-07`）。⛔ 不复用。 */
    let reqSeq = 0;
    /** ⭐ 已发出的请求里最大的那个——回包 `req < 它` ⇒ **整份丢弃**（⛔ 不注入 DOM）。 */
    let latestReq = 0;

    let tier = tierFor(opts.initialMs);
    let inflight = false;
    /** 在途期间又改了 ⇒ 只置这个标记，⛔ **不发起第二个请求**（§2.6-3）。 */
    let pending = false;
    let timer = null;
    let lastRenderAt = -Infinity;
    let renders = 0;
    let staleShown = null;

    function isStale() { return editSeq !== renderSeq; }

    /** ⭐ **陈旧状态条的写入点只有这一个** ⇒ 两级真值（调度器 / 界面）不可能脱节。 */
    function syncStale() {
      const s = isStale();
      if (s === staleShown) return;
      staleShown = s;
      onStale(s, tier);
    }

    function cancel() {
      if (timer !== null) { clearTimer(timer); timer = null; }
    }

    /** 下一次该在多久之后动手（⛔ 不真的动手，只算）。 */
    function nextDelay() {
      if (tier === 'C') return null;               // ⛔ 不自动重渲
      const base = DEBOUNCE_MS[tier] || DEBOUNCE_MS.A;
      if (tier !== 'B') return base;
      // ⭐ B 档多一条：**两次重渲之间至少隔 1 s**（§2.6-2）。
      //    ⚠️ 少了它，"敲一个字停一下"会让每一次停顿都触发一次一秒级的卡顿。
      const earliest = lastRenderAt + DEBOUNCE_MS.B - now();
      return Math.max(base, earliest);
    }

    function schedule() {
      cancel();
      if (!isStale()) return;
      const d = nextDelay();
      if (d === null) { syncStale(); return; }     // 档 C：只把"过期"显示出来，等用户点
      if (inflight) return;                        // 在途 ⇒ 收工时不看这个，看 `pending`
      timer = setTimer(function () { timer = null; fire(false); }, d);
    }

    /** 缓冲变了（⛔ 只有 `updateListener` 的 `docChanged` 会调它，见 `editor/main.js`）。 */
    function markEdited() {
      editSeq += 1;
      if (inflight) { pending = true; syncStale(); return; }
      schedule();
      syncStale();
    }

    /** ⭐ 保存成功**不**推进 `renderSeq`：§2.4 明写"清脏标记后 ⛔ 不触发预览重渲"。 */
    function markSaved() { /* 刻意空着——留这个函数是为了让"这里什么都不做"是个**决定**而不是遗漏 */ }

    /** 手动「更新预览」（按钮 / 将来的 `:w` 预览刷新）—— ⛔ 不受档位限制。 */
    function requestNow() { cancel(); return fire(true); }

    async function fire(manual) {
      if (inflight) { pending = true; return null; }         // ⛔ 不排队、⛔ 不发第二个
      if (opts.isMounted && !opts.isMounted()) return null;  // ⛔ 退编辑态之后不许再渲染
      if (!manual && tier === 'C') return null;
      const mySeq = editSeq;
      const myReq = ++reqSeq;
      latestReq = myReq;
      inflight = true;
      lastRenderAt = now();
      let out = null;
      try {
        out = await render(myReq);
        // ⭐ **陈旧 ⇒ 整份丢弃**（⛔ 不注入 DOM）。⚠️ 结构上少见（单飞保证同时只有一个在飞），
        //    但**跨路径**的那一瞬间是真实的：`begin_edit` 的刷新与它撞上时就走到这里。
        if (myReq !== latestReq) return null;
        renderSeq = mySeq;
        renders += 1;
        if (out && typeof out.ms === 'number') {
          const t = tierFor(out.ms);
          // ⚠️ 档位**降**下来（C→A）也要立刻生效，否则用户改小了文档还得受一次卡。
          if (t !== tier) { tier = t; }
        }
      } finally {
        inflight = false;
        syncStale();
        if (pending) {
          pending = false;
          if (isStale()) schedule();
        }
      }
      return out;
    }

    return {
      tierFor: tierFor,
      markEdited: markEdited,
      markSaved: markSaved,
      requestNow: requestNow,
      cancel: cancel,
      isStale: isStale,
      isInflight: function () { return inflight; },
      tier: function () { return tier; },
      /** ⚠️ 只为单测与回报：发过多少次 `render_preview`。 */
      renders: function () { return renders; },
      latestReq: function () { return latestReq; },
      /** ⚠️ 只为回报（`report_status` 的 `preview_stale`）。 */
      stale: isStale,
      /** ⚠️ **只为单测**：把两个序号露出来核对（产品代码⛔ 不靠它们做判断）。 */
      _editSeq: function () { return editSeq; },
      _renderSeq: function () { return renderSeq; },
      /** ⭐ **只为单测**：注入那个定时器"到点了"。 */
      _fireNow: function (manual) { return fire(!!manual); },
    };
  }

  const api = {
    A_MS: A_MS,
    C_MS: C_MS,
    DEBOUNCE_MS: DEBOUNCE_MS,
    tierFor: tierFor,
    createScheduler: createScheduler,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).editorPreview = api;
})();
