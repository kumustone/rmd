// 分片追加 —— `design/0003` §2.1（阈值 N）与 §2.1.3（分片中断规则）的**纯逻辑**部分。
//
// # 为什么分片的是"渲染"，不是"扫描"
//
// `research/notes/0006` 实测：单层 **5200 项**的扫描只要 **2.4 ms**——
// 比解析一份 100 KB 文档还快一个量级。⇒ ⛔ **不许拿"扫描太慢"当分片的理由**，
// 理由只能是"一帧内往 DOM 里插 5000 个节点"。
// ⚠️ 而这个理由**目前还没有数字**（渲染半留批 3）——`CHUNK_FIRST = 500` 是**待测的初始值**。
//
// # ⭐ 中断规则（R5 点名的"分片中途切根"）
//
// 每个分片回调**开头**比对 `root_generation`，不等即：
// **停止调度剩余分片 + 把已追加的那部分一并从 DOM 移除**。
// ⛔ **不能只"停止追加"**——那会留下一棵**半截的旧树**，看起来像
// "目录里真只有这么多文件"，是**静默的错误内容**，比崩溃更糟（`INV-VER-01`）。
//
// 这个文件不碰 DOM、不碰 Tauri：`build` / `append` / `remove` / `schedule` 全部注入，
// 于是"生成到第 3 批时代次变了"这种场景可以用假实现精确复现（`tests/js/`）。

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

  const V = (typeof module !== 'undefined' && module.exports)
    ? require('./versions.js')
    : window.rmd.versions;

  /** 默认调度：`requestIdleCallback`，没有就退回 `setTimeout`。 */
  function defaultSchedule(fn) {
    if (typeof requestIdleCallback === 'function') {
      // ⚠️ `timeout` 是必须的：目录项少的时候浏览器可能长时间不派空闲回调，
      //    树会停在半截**而没有任何错误**——这正是我们最不想要的失败形态。
      requestIdleCallback(fn, { timeout: 200 });
    } else {
      setTimeout(fn, 0);
    }
  }

  /**
   * 建一个分片追加器。
   *
   * @param {object} opts
   * @param {number} opts.total     这一层共多少项
   * @param {number} opts.gen       这批分片属于哪个 `root_generation`
   * @param {() => number} opts.currentGen 现取当前代次的函数（⛔ 不是建的时候那一份）
   * @param {(from:number, to:number) => any[]} opts.build 造 `[from,to)` 区间的节点
   * @param {(nodes:any[]) => void} opts.append 追加进 DOM
   * @param {(nodes:any[]) => void} opts.remove 从 DOM 移除（陈旧时整批回滚）
   * @param {(fn:Function) => void} [opts.schedule] 调度（测试里注入一个同步的）
   * @param {number} [opts.step]    每片多少项
   * @param {(state:object) => void} [opts.onDone] ⭐ **这一层结束**时调一次
   *        （`done` 或整批回滚都算）。`design/0009` §2.1 ⑤ 要的"`expand()` 能被**等到**
   *        本层全渲染完"就是靠它——⛔ 不靠轮询 DOM。⚠️ **保证只调一次**。
   * @returns {{start: () => void, state: object}}
   */
  function createChunkAppender(opts) {
    const build = opts.build;
    const append = opts.append;
    const remove = opts.remove;
    const schedule = opts.schedule || defaultSchedule;
    const gen = opts.gen;
    const currentGen = opts.currentGen;
    const step = opts.step || V.CHUNK_STEP;
    const total = opts.total;

    // ⚠️ 状态（含"已追加了哪些节点"）放**数据层**，⛔ 不靠读 DOM 反推。
    //    这条同时是 `design/0003` §2.1.1 那个"被修正掉的论据"的可证形式：
    //    正因为状态在数据层，收起/展开侧边栏根本不可能影响它。
    const state = {
      appended: [],
      next: Math.min(total, V.CHUNK_FIRST),
      stopped: false,
      stale: false,
      reason: null, // 'done' | 'gen'
      batches: 0,
    };

    /** ⭐ 唯一的"收尾"入口。⚠️ `done` 标记保证 `onDone` **只被调一次**——
        少了它就是"完成回调发了两次"，而调用方（`FileTree.expand`）会因此
        把一个已经 resolve 的 Promise 再 resolve 一次（无害但会让人怀疑状态）。 */
    let done = false;
    function finish(reason) {
      if (done) return;
      done = true;
      state.stopped = true;
      state.reason = reason;
      if (typeof opts.onDone === 'function') {
        try { opts.onDone(state); } catch (e) { console.error('分片收尾回调出错：', e); }
      }
    }

    function rollback(reason) {
      state.stale = true;
      if (state.appended.length) remove(state.appended.slice());
      // ⛔ 清空引用：留着会让"已追加"这个词骗到下一个读它的人
      state.appended.length = 0;
      finish(reason);
    }

    function run() {
      if (state.stopped) return;
      // ⭐ 检查点在**每个分片的开头**，⛔ 不是"发请求时查过一次"
      if (currentGen() !== gen) return rollback('gen');

      const from = state.next;
      const to = Math.min(from + step, total);
      if (from >= to) return finish('done');
      const nodes = build(from, to);
      append(nodes);
      for (let i = 0; i < nodes.length; i++) state.appended.push(nodes[i]);
      state.next = to;
      state.batches += 1;

      if (to < total) schedule(run);
      else finish('done');
    }

    return {
      /** 首批同步追加，其余排进空闲回调。 */
      start() {
        if (state.next > 0) {
          if (currentGen() !== gen) return rollback('gen');
          const nodes = build(0, state.next);
          append(nodes);
          for (let i = 0; i < nodes.length; i++) state.appended.push(nodes[i]);
          state.batches += 1;
        }
        if (state.next >= total) return finish('done');
        schedule(run);
      },
      state,
    };
  }

  const api = { defaultSchedule, createChunkAppender };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).chunked = api;
})();
