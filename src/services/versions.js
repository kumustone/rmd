// 版本与提交判据 —— `design/0003` §2.1.3 / §2.1.4 的**纯逻辑**部分。
//
// ⭐ 这个文件的存在理由：`INV-VER-01` 是**唯一**一条「看起来正常的错」型不变量
// （慢的 A 请求覆盖快的 B、切根后旧分片继续追加）。它在小文件上永远复现不了，
// 只在大文件上偶发，且用户的描述通常是"有时候打开的是上一篇"。
// ⇒ 它必须有一份**能直跑、不依赖 WebView**的判据，`node --test` 一跑就绿/红。
//
// ⛔ 这里**不许出现 DOM、Tauri、定时器**。任何"什么时候检查"的调度都不在这一层
// （那是 `chunked.js` 与 `session.js` 的事）。
//
// 双导出（浏览器挂 `window.rmd.versions` / node 挂 `module.exports`）**必须**包在 IIFE 里，
// 理由见下面那段注释——那是实测踩出来的，不是风格偏好。

// ⚠️⚠️ **每个文件都包一层 IIFE**——这**不是**风格问题，是必须的。
//
// 经典脚本（⛔ 不是 ES module）的顶层 `const` **共用一个全局词法作用域**：
// 两个文件都写 `const api = …`（或 `const V` / `const S` / `const T`）时，
// 后加载的那个文件**整个不执行**（解析期 `SyntaxError`），
// 而错误只出现在 WebView 的控制台里——本项目看不到它。
//
// 表现：**一个永远开着的空白窗口**，stderr 里连一条错误都没有。
// 2026-10-13 实施 `design/0003` 时真踩到了：7 个模块几乎全被
// `const V` / `const api` 撞掉，冒烟挂在那里一动不动。
//
// ⇒ 双导出（浏览器挂 `window.rmd.*` / node 挂 `module.exports`）**必须在 IIFE 里**。
(function () {
  'use strict';

  /** 请求 / 响应里那个版本对。字段名与后端 `ListDirResult` / `DocumentPayload` 一致。 */
  function versionOf(resp) {
    return { gen: resp.gen, req: resp.req };
  }

  /**
   * ⭐ 提交点 ①（文档）与 ②③（树）的**同一个**判据。
   *
   * `current` 是**当前**的版本（调用方现取，⛔ 不是发请求时那一份）。
   * 返回值是"为什么不能提交"，`null` = 可以提交。
   *
   * ⚠️ `req` 比的是**最新发出的那个**，不是"已接受的最大值"。
   * 两者在"连点 A→B"上等价（B 一定比 A 新），而前者对"最新那个请求自己失败了"
   * 这种情形仍然正确——它不会让一个更旧的响应因为"没人成功过"而变成合法。
   *
   * @param {{gen:number, req:number}} resp 响应里带回的版本
   * @param {{generation:number, latestReq:number}} current 当前真值
   * @returns {'gen'|'req'|null} 不符的原因
   */
  function staleReason(resp, current) {
    if (resp.gen !== current.generation) return 'gen';
    if (resp.req !== current.latestReq) return 'req';
    return null;
  }

  /** 提交点 ① 的完整判决（`INV-VER-01`）。 */
  function docCommitDecision(resp, current) {
    const reason = staleReason(resp, current);
    if (reason) return { commit: false, reason };
    return { commit: true, reason: null };
  }

  /**
   * §2.1.4 第 ③ 步的触发条件：**`roots` 非空 且 这份文档不在任何 root 之下**。
   *
   * ⚠️ 两个条件缺一不可，且理由不同：
   * - 少了 `roots_nonempty`：单文件模式下每次自动重载都会**空转**一次
   *   `root_generation += 1`（不造成错误，但让代次这个调试数字没法读）；
   * - 少了 `outside_roots`：在 root 内正常导航会把用户自己的树清掉。
   */
  function step3Needed(payload) {
    return !!payload.roots_nonempty && !!payload.outside_roots;
  }

  /** 深度上限（`design/0003` §6：> 32 层明确显示「层级过深」，⛔ 不静默截断）。 */
  const MAX_DEPTH = 32;

  /** 第 `depth` 层（从 0 数）允不允许展开它的子项。 */
  function depthAllowed(depth) {
    return depth < MAX_DEPTH;
  }

  /** 单层超过这个数就分片追加（§2.1 的阈值 N）。⚠️ 这是**待测的初始值**，不是结论。 */
  const CHUNK_FIRST = 500;
  const CHUNK_STEP = 500;

  /** 首批渲染多少项。 */
  function firstChunkSize(total) {
    return Math.min(total, CHUNK_FIRST);
  }

  /**
   * 分片计划：`[[0,500), [500,1000), …]`，最后一片可能不满。
   * ⚠️ 只有**渲染**分片，扫描从来都是整层一次（`research/notes/0006` 实测 5200 项 2.4 ms）。
   */
  function chunkPlan(total) {
    const plan = [];
    for (let start = 0; start < total; start += CHUNK_STEP) {
      plan.push([start, Math.min(start + CHUNK_STEP, total)]);
    }
    return plan;
  }

  const api = {
    MAX_DEPTH,
    CHUNK_FIRST,
    CHUNK_STEP,
    versionOf,
    staleReason,
    docCommitDecision,
    step3Needed,
    depthAllowed,
    firstChunkSize,
    chunkPlan,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).versions = api;
})();
