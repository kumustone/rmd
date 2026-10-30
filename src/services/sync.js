// 左右滚动同步（`design/0012` §11）。
//
// 分两层，**别混**：
//
// | 层 | 内容 | 能不能在 node 里跑 |
// |---|---|---|
// | ⭐ **纯逻辑**（本文件上半） | `pairAnchors` / `buildKnots` / `mapValue` / `createGuard` | ✅ 35 条断言（`tests/js/sync.test.js`） |
// | ⭐ **接线**（本文件下半，`createDriver`） | 监听、观察器、rAF 合流、代数 | ❌ 要真 DOM ⇒ 离屏探针（§11.7） |
//
// ⭐ **接线那半的判据在 `tools/wkwebview-probe/scroll-sync-harness.js`**
//    （`make probe-scroll-sync`）：它把**这一份** `sync.js` 与产品那份 CM6 bundle
//    原样拷进一个离屏页面，跑 15 条检查（含环境自证 E1/E2，⛔ 环境不成立时记「跳过」
//    而不是「失败」）。⛔ 它不抄第二份实现；⚠️ 它手搭预览 DOM
//    ⇒ 结论只对**本文件这一层**有效，⛔ 不覆盖 comrak 的排版高度。
//
// ⭐ **接线为什么在这个文件里、⛔ 不在 `src/main.js`**：`main.js` 是根脚本、
//    **不进 `tests/js/`**，写在那一层的接线**任何断言都碰不到**——
//    而"两端各写一半的契约"在本仓库已有三个成员（`docs/bugs/0003`/`0004`/`0005`），
//    形态每次都是"两边各自都有测试，断的正是中间那一跳"。
//    ⇒ 接线放这儿，探针就能把**真的那一份**跑起来。
//
// ⭐ **坐标系只有一个：像素**。两侧的"锚点"都是**内容坐标**（标题在自己的滚动容器
//    内容里的 top），而"内容坐标"同时就是**滚动位置**——把源码栏滚到 `X`
//    就是把内容 `X` 送到视口顶部，右侧同理。⇒ 映射的是**同一个内容的两个滚动位置**。
//    ⚠️ `TocItem.line`（§11.2）**不进纯逻辑那一层**：它在 `createDriver` 里
//    由调用方给的 `lineTop` 换成源码栏的像素（`view.lineBlockAt(doc.line(n).from).top`），
//    换算完就没了。
//
// ⚠️ 与 `reload.js` / `versions.js` / `chunked.js` 一样：⛔ **纯逻辑那半**可 `node --test`、
//    且**必须**包 IIFE（经典脚本共享全局词法作用域，见 `session.js` 顶部那段）。
//
// ⚠️ **为什么它不复用 `reload.js` 的三级锚点**：那三条回答的是"**重载之后**，
//    怎么把阅读位置找回来"（一次性、单向、由 `captureAnchor` 主动存）。
//    这里是"**两栏之间持续跟随**"，要的是折线插值与来源闸——两者判据不同，
//    ⛔ 合并会让任一边的边界被另一边的假设带偏（§8 禁止同一判据两份实现，
//    但也禁止把两个判据硬凑成一个）。
(function () {
  'use strict';

  /** 夹取到 `[lo, hi]`。⚠️ `lo > hi` 时返回 `lo`（不会倒挂成 hi）。 */
  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  /** 有限非负数才收，否则回落到 `fallback`。 */
  function 非负(x, fallback) {
    if (typeof x !== 'number' || !isFinite(x) || x < 0) return fallback;
    return x;
  }

  /**
   * ⭐ 把大纲项与右侧标题位置配成锚点对（`design/0012` §11.2 事实①③）。
   *
   * @param {Array<{id: string, line: number}>} toc 后端给的 `payload.toc`。
   * @param {Array<{id: string, top: number}>} tops `headingPositions()` 的产物。
   * @param {Function} lineTop `(line: number) => number|null` —— 源码行 → 源码栏像素。
   * @returns {Array<{a: number, b: number}>} `a` = 源码栏内容像素，`b` = 预览栏内容像素。
   *
   * ⚠️⚠️ **按 `id` 配对，⛔ 不按序号**：`headingPositions()` 查不到的 id 会
   *    `continue`（它自己的注释写着"查不到就跳过"）⇒ 右侧那张表**可能比 `toc` 短**。
   *    按序号配的话，从缺失那一条起**后面全错位**，而且错得**静默**
   *    （看起来"同步在动，只是不太准"）。
   *
   * ⚠️ **重复标题不是问题**：`adr/0003` 保证文档内 id 唯一（`intro` / `intro-1`），
   *    所以按 id 配**天然**分得开——⭐ 前提正是 id 来自后端、⛔ 前端不自造。
   *
   * ⚠️ **跳级标题（h1 → h3）同样不是问题**：它们只是普通锚点，
   *    ⛔ 这个文件里没有"层级"这个概念，也不该有。
   *
   * ⚠️ 拿不到 `lineTop`（行号越界 / 换算失败）的那一条**整条丢掉**，⛔ 不补 0：
   *    "没有位置"与"位置在第 0 像素"是两件事（与 `reload.js` 那条同族）。
   */
  function pairAnchors(toc, tops, lineTop) {
    const list = Array.isArray(toc) ? toc : [];
    const 表 = Object.create(null);
    for (const t of (Array.isArray(tops) ? tops : [])) {
      if (!t || typeof t.id !== 'string' || !t.id) continue;
      if (typeof t.top !== 'number' || !isFinite(t.top)) continue;
      表[t.id] = t.top;
    }
    const out = [];
    if (typeof lineTop !== 'function') return out;
    for (const t of list) {
      if (!t || typeof t.id !== 'string' || !t.id) continue;
      if (!(t.id in 表)) continue;
      const line = t.line;
      if (typeof line !== 'number' || !isFinite(line) || line < 1) continue;
      let a;
      try { a = lineTop(line); } catch (e) { a = null; }
      if (typeof a !== 'number' || !isFinite(a) || a < 0) continue;
      out.push({ a: a, b: 表[t.id] });
    }
    return out;
  }

  /**
   * ⭐ 把锚点对编成一条**单调的折线**（`design/0012` §11.3）。
   *
   * @param {Array<{a: number, b: number}>} pairs [`pairAnchors`] 的产物（顺序无所谓）。
   * @param {number} maxA 源码栏的**可滚动上界**（`scrollHeight − clientHeight`）。
   * @param {number} maxB 预览栏的可滚动上界。
   * @returns {Array<{a: number, b: number}>} 从 `(0, 0)` 起、两轴都**严格递增**的折线。
   *
   * ⭐ **两端各补一个点，这正是 §11.7 那两条边界**：
   *    · **首标题之前** ⇒ 从 `(0, 0)` 到第一个锚点之间线性插值
   *      （`(0,0)` 的含义是"两侧都在内容的开头"，⛔ 不是硬凑的）；
   *    · **末标题之后** ⇒ 从最后一个锚点到 `(maxA, maxB)`。
   * ⭐ **无标题文档** ⇒ `pairs` 为空 ⇒ 折线只剩 `[(0,0), (maxA,maxB)]`
   *    ⇒ 退化成**按比例**（这是能给出的最好的答案，且**不假装**它精确）。
   *
   * ⚠️⚠️ **两轴都必须严格递增**，否则那一段要么除零、要么**倒挂**
   *    （倒挂 = `mapValue` 不再可逆，"滚下去另一栏却往上走"）——
   *    所以任何不满足的锚点**整条丢掉**，⛔ 不是夹一下留下（夹了会造出零长段）。
   *    ⚠️ 丢掉是**安全**的：它只是让那一段退回线性近似。
   *
   * ⚠️ **夹取**：`a`/`b` 都先夹进 `[0, max]`。⚠️ 内容变短时浏览器会把
   *    `scrollTop` 弹回去，量到的 `top` 可能**大于**当前上界。
   *
   * @param {number} maxA
   * @param {number} maxB
   */
  function buildKnots(pairs, maxA, maxB) {
    const A = 非负(maxA, 0);
    const B = 非负(maxB, 0);
    const 中间 = [];
    for (const p of (Array.isArray(pairs) ? pairs : [])) {
      if (!p) continue;
      if (typeof p.a !== 'number' || !isFinite(p.a) || p.a < 0) continue;
      if (typeof p.b !== 'number' || !isFinite(p.b) || p.b < 0) continue;
      中间.push({ a: clamp(p.a, 0, A), b: clamp(p.b, 0, B) });
    }
    // ⚠️ 先按 `a` 排（`a` 相同时按 `b`）——折线要求按轴有序，而调用方的顺序
    //    来自 `toc` 的文档序，**不保证**在像素轴上单调（生成的 DOM 顺序与
    //    视觉顺序会分叉，`reload.js::pickAnchor` 那条注释讲过同一件事）。
    中间.sort(function (x, y) { return x.a - y.a || x.b - y.b; });

    const out = [{ a: 0, b: 0 }];
    for (const p of 中间) {
      const last = out[out.length - 1];
      // ⚠️ 严格递增：`<=` 一律丢（含"和上一点重合"）。两轴都要判——
      //    只判 `a` 会放过"同一像素位置但 b 倒退"的倒挂。
      if (p.a <= last.a || p.b <= last.b) continue;
      // ⚠️ 触到任一边界的锚点也丢：它们与尾部那个 `(A, B)` 是同一个意思，
      //    留着只会造出一个零长段（下一句就不会再 push 尾点了）。
      if (p.a >= A || p.b >= B) continue;
      out.push(p);
    }
    const last = out[out.length - 1];
    // ⭐ 尾点只在**两轴都还有余量**时才补。⚠️ 否则（某一栏已到顶 / 不可滚动）
    //    折线**到此饱和**——那正是要的："另一栏到底了，这一栏就别再往下推"。
    if (A > last.a && B > last.b) out.push({ a: A, b: B });
    return out;
  }

  /**
   * ⭐ 在折线上取值（`design/0012` §11.3 第 3–5 步）。
   *
   * @param {Array<{a: number, b: number}>} knots [`buildKnots`] 的产物。
   * @param {number} v 输入值。
   * @param {'a'|'b'} axis 输入在哪个轴上。
   * @returns {number} 另一轴上的值（**已夹在折线的值域内**）。
   *
   * ⭐ **段内线性插值**：源码那边的行高恒定、渲染那边的块高不等 ⇒
   *    这是**故意**不精确的那一半（§11.7）。⛔ 不许把它说成"逐行对齐"。
   *
   * ⚠️ **端点饱和**（⛔ 不外推）：`v` 超出折线两端就取端点的值。
   *    外推会让"内容更短的那一栏"被推出可滚范围，然后浏览器把它弹回来 ⇒ **看着像抖**。
   * ⚠️ `v` 非数时返回 `0`（"没有位置"⇒ 回顶部是**唯一**说得过去的解释），
   *    ⛔ 不返回 `NaN`——那会原样写进 `scrollTop` 并被静默忽略。
   */
  function mapValue(knots, v, axis) {
    const n = Array.isArray(knots) ? knots.length : 0;
    if (n === 0) return 0;
    const 入 = axis === 'b' ? 'b' : 'a';
    const 出 = 入 === 'a' ? 'b' : 'a';
    if (typeof v !== 'number' || !isFinite(v)) return knots[0][出];
    if (n === 1) return knots[0][出];
    const 头 = knots[0][入];
    const 尾 = knots[n - 1][入];
    if (v <= 头) return knots[0][出];
    if (v >= 尾) return knots[n - 1][出];
    // ⚠️ 从后往前找**第一个** `v` 落在它和下一点之间的小段。
    //    折线已保证严格递增，所以命中区间唯一。
    for (let i = n - 2; i >= 0; i--) {
      const lo = knots[i][入];
      const hi = knots[i + 1][入];
      if (v >= lo && v <= hi) {
        const span = hi - lo;
        // ⚠️ `span` 理论上恒 > 0（`buildKnots` 的严格递增保证了）——
        //    但这是**纯函数**，别把不变量当输入校验：真出现零长段就取左端点，
        //    ⛔ 不要除出个 `Infinity` 写进 `scrollTop`。
        if (!(span > 0)) return knots[i][出];
        const t = (v - lo) / span;
        const out = knots[i][出] + t * (knots[i + 1][出] - knots[i][出]);
        return clamp(out, Math.min(knots[i][出], knots[i + 1][出]), Math.max(knots[i][出], knots[i + 1][出]));
      }
    }
    return knots[n - 1][出];
  }

  /** ⭐ 判断"这一格是不是我刚才写进去的位置"时的容差（像素）。 */
  const ECHO_EPS = 1;

  /** ⭐ 记多少条最近写过的值——**回声可能延后到达**（§11.4）。 */
  const ECHO_KEEP = 8;

  /**
   * ⭐ **来源闸**（`design/0012` §11.4 / `INV-EDIT-14`）。
   *
   * 它回答的是：**这一条 `scroll` 事件，是我自己写进去的回声吗？**
   * 是 ⇒ 丢掉（⛔ 不拿它去驱动另一栏，否则两栏互相推 ⇒ 抖 / 滚不动）。
   *
   * ⚠️⚠️ **为什么不是一个"正在写回"的布尔锁**：程序写 `scrollTop` 之后，
   *    浏览器派发 `scroll` 事件是**异步**的——`requestAnimationFrame` 里清的锁、
   *    甚至微任务里清的锁，都可能**早于**那条事件。锁一开，回声就被当成用户滚动
   *    ⇒ 反弹照旧。⚠️ 而且这个失败**不报错**，只表现为"手感不对"。
   *
   * ⭐ 落地判据是**来源 + 期望值**，两件合起来：
   *    ① **来源**：只有"最后主动那一栏"才有资格驱动另一栏；
   *    ② **期望值**：非来源那一栏的 `scroll`，若其值**恰好等于我们写进去的**，
   *       就是回声，丢掉；否则是用户用别的方式（拖滚动条 / 键盘 / 惯性）
   *       动了它 ⇒ **把来源移交给它**。
   *
   * ⚠️⚠️ **判据是"值等不等于我写的那个数"，⛔ 不是"变化量够不够大"**：
   *    快速滚动时用户自己一动就是几十像素，任何"变化量阈值"都会把**真的用户滚动**
   *    误判成回声 ⇒ 症状是"滚快了就不跟了"。等下那条 `accept` 只做**相等**比较。
   *
   * ⚠️ **为什么记一串（`ECHO_KEEP`）而不是只记最后一个**：回声可能**延后**，
   *    而我们可能已经又写过几次了。只记最后一个 ⇒ 迟到的旧回声与当前值不等
   *    ⇒ 被判成"用户接管" ⇒ 来源乱跳。⭐ 记一小串就够（同一帧内不会有几十次写回）。
   *
   * @param {string} aName 源码栏的名字（调用方定，`'src'` / `'dst'`）。
   * @param {string} bName 预览栏的名字。
   */
  function createGuard(aName, bName) {
    const A = aName || 'src';
    const B = bName || 'dst';
    /** ⭐ 当前**有权驱动另一栏**的那一栏；`null` = 还没人滚过。 */
    let origin = null;
    /** 最近写进各栏的值。⚠️ 数组就是那个"一小串"。 */
    const echo = {};
    echo[A] = [];
    echo[B] = [];

    function 档(name) {
      return (name === A || name === B) ? name : null;
    }

    return {
      /** 当前来源（`A` / `B` / `null`）。 */
      origin: function () { return origin; },

      /**
       * ⭐ **显式移交**（`wheel` / `pointerdown` / `touchstart` / 方向键）——
       * 用户一碰哪一栏，来源**立刻**是它。⚠️ 这是"及时移交"那一条的落点：
       * 等 `scroll` 事件来判会慢一拍，而拖滚动条那一族**根本不发 `wheel`**。
       */
      setOrigin: function (name) {
        const n = 档(name);
        if (n) origin = n;
      },

      /** 程序**即将写**某栏：记下这个值，之后拿它认回声。 */
      noteWrite: function (name, value) {
        const n = 档(name);
        if (!n) return;
        if (typeof value !== 'number' || !isFinite(value)) return;
        const q = echo[n];
        q.push(value);
        while (q.length > ECHO_KEEP) q.shift();
      },

      /**
       * 某栏报了一条 `scroll`。
       *
       * @returns {boolean} `true` = **这是源事件，去驱动另一栏**；
       *                    `false` = 这是我自己写的回声，丢掉。
       */
      accept: function (name, value) {
        const n = 档(name);
        if (!n) return false;
        // 还没有来源 ⇒ 谁先动谁是源（用户刚进编辑态、或刚重建过）。
        if (origin === null) { origin = n; return true; }
        if (n === origin) return true;
        // —— 非来源栏 ——
        const q = echo[n];
        const v = (typeof value === 'number' && isFinite(value)) ? value : NaN;
        for (let i = 0; i < q.length; i++) {
          if (Math.abs(v - q[i]) <= ECHO_EPS) return false;   // ⭐ 我的回声
        }
        // ⭐ 与写进去的都不等 ⇒ 用户用别的方式动了它 ⇒ 移交。
        origin = n;
        return true;
      },

      /** 换文档 / 重建折线 / 进出编辑态时清干净。 */
      reset: function () {
        origin = null;
        echo[A].length = 0;
        echo[B].length = 0;
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // ⭐ **接线**（`design/0012` §11.6）——把上面那三件纯逻辑接上两个滚动容器。
  //
  // ⚠️⚠️ 它**故意放在这个文件里**，⛔ 不是写在 `src/main.js` 里：
  //    `main.js` 是根脚本、**不进 `tests/js/`**，写在那一层的东西
  //    **任何断言都碰不到**——而这一族（"两端各写一半的契约"）在本仓库
  //    已经有三个成员（`bugs/0003`/`0004`/`0005`），每一个的形态都是
  //    "两边各自都有测试，断的是中间那一跳"。
  //    ⭐ 放在这儿 ⇒ 离屏探针可以把它**整个**跑起来（真 DOM、真 CM6），
  //    而 `main.js` 只剩"把四个取值器接上去"。
  //
  // ⚠️ 它只碰**宿主给的**那几个元素：⛔ 不 `document.querySelector`、
  //    ⛔ 不读全局。⇒ 探针里那两个容器就是它的全部世界。
  // ═══════════════════════════════════════════════════════════════════

  /** 源码栏 / 预览栏在来源闸里的名字。 */
  const SRC = 'src';
  const DST = 'dst';

  /** 夹到 `[0, max]`。⚠️ `max <= 0`（不可滚）时返回 `0`。 */
  function 夹进(v, max) {
    if (!(max > 0)) return 0;
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : (v > max ? max : v);
  }

  /** 一个滚动容器的可滚上界。⛔ 不假定它可滚。 */
  function 上界(el) {
    if (!el) return 0;
    const h = typeof el.scrollHeight === 'number' ? el.scrollHeight : 0;
    const c = typeof el.clientHeight === 'number' ? el.clientHeight : 0;
    return Math.max(0, h - c);
  }

  /**
   * ⭐ **源码行号 → 源码栏的「内容坐标」**（`design/0012` §11.3 第 2 步）。
   *
   * ⚠️ 用 `lineBlockAt(...).top`，⛔ **不用** `coordsAtPos`：后者给的是**视口坐标**，
   *    与当前滚动位置绑死（每滚一次都要重算一遍），而且它返回 `null` 的时机
   *    （行不在视口内）**正是最需要这个数的时候**。`lineBlockAt` 给的是内容坐标——
   *    与 `scrollTop` 同一把尺子。
   * ⚠️ 越界 / 视图缺件 / `lineBlockAt` 抛 ⇒ `null`（`pairAnchors` 会把那一条
   *    **整条丢掉**，⛔ 不补 0："没有位置"与"位置在第 0 像素"是两件事）。
   * ⭐ **它放在这里而不是 `src/main.js`**：`main.js` 不进 `tests/js/`，
   *    而这一行正是 §11 唯一"押在 CM6 行为上"的假设（`lineBlockAt` 的坐标口径），
   *    也是离屏探针唯一能替我们验的东西（探针用**同一份**这个函数）。
   *    调用方只负责"视图在不在"，⛔ 不重复这段换算。
   */
  function sourceLineTopOf(view, line) {
    if (!view || !view.state || !view.state.doc) return null;
    if (typeof view.lineBlockAt !== 'function') return null;
    const doc = view.state.doc;
    if (typeof doc.lines !== 'number' || typeof doc.line !== 'function') return null;
    const n = typeof line === 'number' ? Math.floor(line) : NaN;
    if (!isFinite(n) || n < 1 || n > doc.lines) return null;
    let blk;
    try { blk = view.lineBlockAt(doc.line(n).from); } catch (e) { return null; }
    if (!blk || typeof blk.top !== 'number' || !isFinite(blk.top)) return null;
    return blk.top;
  }

  /**
   * ⭐ **把两栏接起来**（§11.3/§11.4/§11.6）。
   *
   * @param {object} deps ⚠️ 全部是**取值器**，⛔ 没有一个被缓存下来：
   *        容器、大纲、标题位置**每次现取**——编辑态进出、预览重渲、换文档
   *        都会让它们变成别的对象，缓存一次就会拿旧的去驱动新的（§11.7）。
   * @param {Function} deps.src  `() => Element|null` 源码栏的**滚动容器**。
   * @param {Function} deps.dst  `() => Element|null` 预览栏的滚动容器。
   * @param {Function} deps.lineTop `(line:number) => number|null` 源码行 → 像素。
   * @param {Function} deps.toc  `() => Array<{id:string, line:number}>`。
   * @param {Function} deps.headingTops `() => Array<{id:string, top:number}>`。
   * @param {Function} deps.fresh `() => boolean` —— ⭐ **挂着的渲染是否仍对应当前源码**。
   *        `false` ⇒ 折线降级成按比例（§11.7：那对锚点已经不是同一个东西的位置了）。
   * @param {Function} [deps.onChange] `(cb) => Function` —— 注册"布局可能变了"，
   *        返回退订函数。⚠️ 调用方补的是**观察器看不见**的那些：
   *        字号 / 内容宽 / 分栏拖动 / 窗口尺寸。⛔ 别把 DOM 观察器也写进去，
   *        那两个驱动自己管。
   * @param {Function} [deps.raf] / [deps.cancelRaf]
   */
  function createDriver(deps) {
    const d = deps || {};
    const 取 = function (f) { try { return f ? f() : null; } catch (e) { return null; } };
    const raf = d.raf || function (fn) {
      return (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(fn) : setTimeout(fn, 16);
    };
    const 取消raf = d.cancelRaf || function (h) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h); else clearTimeout(h);
    };

    let guard = createGuard(SRC, DST);
    let knots = null;
    /** ⭐ 折线里**真的用上了**几个锚点吗。`0` = 只有两端点 ⇒ ⛔ 不许当精确位置用。 */
    let exact = false;
    /** 采集到的锚点对个数（⚠️ 与"用上的"不是同一个数，见 `rebuild`）。 */
    let anchorCount = 0;
    /** ⭐ 折线里**真正留下**的锚点个数（去掉补上去的两端）。 */
    let usedCount = 0;
    let rafId = 0;
    /** ⚠️ 代数：`stop()` 之后再迟到的回调（rAF / 观察器）一律作废（§11.7「旧 DOM 的映射不得继续使用」）。 */
    let gen = 0;
    let running = false;
    let domObs = null;
    let sizeObs = null;
    let 退订表 = [];

    function 清退订() {
      for (let i = 0; i < 退订表.length; i++) {
        try { 退订表[i](); } catch (e) { /* ⚠️ 退订失败不该挡住收尾 */ }
      }
      退订表 = [];
    }

    /**
     * ⭐ **重建折线**（§11.3）。**同步**——它读的就是此刻的 DOM。
     *
     * ⚠️⚠️ `fresh()` 为假时**只补两个端点**（按比例）。理由写在第 99 行那段
     *    （无标题文档那条）与 §11.7：那时 `toc` 的 `line` 属于**上一次渲染**的文本，
     *    拿它当当前源码的行号，错得**静默**。
     */
    function rebuild() {
      const sEl = 取(d.src);
      const pEl = 取(d.dst);
      if (!running || !sEl || !pEl) {
        knots = null; exact = false; anchorCount = 0; usedCount = 0; return;
      }
      const maxA = 上界(sEl);
      const maxB = 上界(pEl);
      let pairs = [];
      if (d.fresh && d.fresh()) {
        pairs = pairAnchors(取(d.toc) || [], 取(d.headingTops) || [], d.lineTop);
      }
      knots = buildKnots(pairs, maxA, maxB);
      anchorCount = pairs.length;
      // ⭐⭐ **`exact` 判的是"折线里真的留下了锚点"，⛔ 不是"采集到了锚点"。**
      //    ⚠️⚠️ 两者在**某一栏不可滚**时会分岔：那时 `maxB`（或 `maxA`）是 0，
      //    `buildKnots` 会把**每一个**锚点都丢掉（`p.b <= last.b` 恒成立），
      //    折线只剩 `(0,0)` 一个点——**映射退化成"恒定不动"**。
      //    拿"采集数"当精确性，`make smoke` 那一行会印出
      //    「精确｜锚点 7｜折线 1」，即**一句谎**（这行是给人工看的唯一入口）。
      //    ⚠️ 而"用上的"数法可以精确到点：补上去的只有头 `(0,0)` 与尾 `(A,B)`，
      //    而 `buildKnots` 保证任何锚点都**严格**小于 A 与 B ⇒ 尾点不可能是锚点。
      const A = maxA > 0 ? maxA : 0;
      const B = maxB > 0 ? maxB : 0;
      let 用上 = 0;
      for (let i = 0; i < knots.length; i++) {
        if (i === 0) continue;                                     // 补的起点
        const p = knots[i];
        if (A > 0 && B > 0 && i === knots.length - 1 && p.a === A && p.b === B) continue;  // 补的尾点
        用上 += 1;
      }
      usedCount = 用上;
      exact = 用上 > 0;
    }

    /** ⭐ rAF 合流：一次布局变化会连着来好几个通知，只该重建一次。 */
    function schedule() {
      if (!running || rafId) return;
      const myGen = gen;
      rafId = raf(function () {
        rafId = 0;
        // ⚠️ 代数对不上 = 这是**上一次会话**排的回调（进出编辑态、换文档）。
        //    ⛔ 拿它去重建会把旧容器算进新折线里。
        if (!running || myGen !== gen) return;
        rebuild();
      });
    }

    /** 往某一栏写位置。⭐ **先记后写**，顺序反了回声就认不出来。 */
    function 写入(el, name, y) {
      const v = 夹进(y, 上界(el));
      guard.noteWrite(name, v);
      el.scrollTop = v;
    }

    function 从源码驱动() {
      const sEl = 取(d.src), pEl = 取(d.dst);
      if (!sEl || !pEl || !knots) return;
      写入(pEl, DST, mapValue(knots, sEl.scrollTop, 'a'));
    }

    function 从预览驱动() {
      const sEl = 取(d.src), pEl = 取(d.dst);
      if (!sEl || !pEl || !knots) return;
      写入(sEl, SRC, mapValue(knots, pEl.scrollTop, 'b'));
    }

    /**
     * ⭐ 一栏报了一条 `scroll`。**两条判断各管一件事**：
     *    ① 来源闸（`accept`）判"这是不是我自己写的回声"；
     *    ② 折线（`knots`）判"往哪儿写"。
     * ⚠️ 折线还没建好时⛔ **不能**在这条路上现建：`scroll` 可能连来几十条，
     *    每次重建要读遍所有标题的位置（`headingPositions` 是 BCR 逐条取）。
     */
    function 收到滚动(name, el) {
      if (!running || !guard.accept(name, el.scrollTop)) return;
      if (!knots) rebuild();
      if (name === SRC) 从源码驱动(); else 从预览驱动();
    }

    /** 挂一对"用户碰了它"的监听：⚠️ 拖滚动条**不发 `wheel`**，所以三样都要。 */
    function 挂移交(el, name) {
      const 来 = function () { guard.setOrigin(name); };
      el.addEventListener('wheel', 来, { passive: true });
      el.addEventListener('pointerdown', 来, { passive: true });
      el.addEventListener('touchstart', 来, { passive: true });
      // ⚠️ 源码栏多一个 `keydown`：在源码栏里打字/按方向键**就是"在用源码栏"**，
      //    而光标跟随引起的那次滚动**不是**用户"滚"出来的 ⇒ 只靠 `scroll` 判会慢一拍。
      if (name === SRC) el.addEventListener('keydown', 来);
      退订表.push(function () {
        el.removeEventListener('wheel', 来);
        el.removeEventListener('pointerdown', 来);
        el.removeEventListener('touchstart', 来);
        if (name === SRC) el.removeEventListener('keydown', 来);
      });
    }

    return {
      /** ⭐ 进编辑态 / 探针装配时调一次。⚠️ 重复调是 no-op（不重复挂监听）。 */
      start: function () {
        if (running) return;
        const sEl = 取(d.src), pEl = 取(d.dst);
        if (!sEl || !pEl) return;
        running = true;
        gen += 1;
        guard.reset();
        挂移交(sEl, SRC);
        挂移交(pEl, DST);
        const 收s = function () { 收到滚动(SRC, sEl); };
        const 收p = function () { 收到滚动(DST, pEl); };
        sEl.addEventListener('scroll', 收s, { passive: true });
        pEl.addEventListener('scroll', 收p, { passive: true });
        退订表.push(function () {
          sEl.removeEventListener('scroll', 收s);
          pEl.removeEventListener('scroll', 收p);
        });

        // ⭐ **图片是异步换上去的**（`ImageView` 把占位符换成真 `img`），
        //    而 `#doc` 自己的边框盒**一个像素都没变** ⇒ `ResizeObserver` 看不到它。
        //    ⛔ 也别指望 ImageView 给个回调——它没有，而且那会变成第二个真值。
        if (typeof MutationObserver === 'function') {
          domObs = new MutationObserver(function () { schedule(); });
          domObs.observe(pEl, { childList: true, subtree: true });
        }
        // ⭐ 两个滚动容器的盒子变了（窗口尺寸 / 分栏宽度 / 换主题时的行高）。
        if (typeof ResizeObserver === 'function') {
          sizeObs = new ResizeObserver(function () { schedule(); });
          sizeObs.observe(sEl);
          sizeObs.observe(pEl);
        }
        if (typeof d.onChange === 'function') {
          const 退 = d.onChange(function () { schedule(); });
          if (typeof 退 === 'function') 退订表.push(退);
        }
        rebuild();
      },

      /** ⭐ 退出编辑态 / 探针拆台。⚠️ 顺序：先停、再撤监听、最后作废这一代。 */
      stop: function () {
        if (!running) return;
        running = false;
        if (rafId) { 取消raf(rafId); rafId = 0; }
        if (domObs) { domObs.disconnect(); domObs = null; }
        if (sizeObs) { sizeObs.disconnect(); sizeObs = null; }
        清退订();
        knots = null;
        exact = false;
        anchorCount = 0;
        usedCount = 0;
        guard.reset();
        gen += 1;
      },

      /**
       * ⭐ 布局/文档版本变了 ⇒ 重建。⚠️ **合流的**：连着调多次只建一次。
       * ⭐ **预览提交之后必须调**（那是唯一"锚点与 DOM 同时换掉"的时刻），
       *    而且要在 `fresh()` 已经翻转成 `true` **之后**调。
       */
      schedule: schedule,
      /** ⚠️ 同步重建。探针与"提交后立刻要正确"的场合用它。 */
      rebuild: rebuild,

      /**
       * ⭐ **预览提交之后，由调用方把位置写回去**（`design/0012` §2.6-5 / §11.4）。
       *
       * ⚠️⚠️ **为什么必须走这里，⛔ 不能直接 `doc.scrollTop = y`**：
       *    提交那一刻的这次写**也是一次程序写**，它的 `scroll` 事件与
       *    "用户用别的方式动了预览"**长得一模一样**（来源闸只认"值等不等于我写的"）。
       *    绕过 `写入()` 直接赋值 ⇒ 那事件被判成**用户接管** ⇒ 来源翻到预览栏 ⇒
       *    立刻 `从预览驱动()` 把**源码栏**拽走 ⇒ 两栏互相推一次。
       *    ⚠️ 这条失败**不报错**，只表现为"打字的时候画面在晃"。
       * ⚠️ 夹取按**写的那一刻**的 DOM 算 ⇒ 调用方应当在 `innerHTML` 换完之后再调。
       */
      写入预览: function (y) {
        const pEl = 取(d.dst);
        if (!pEl) return;
        写入(pEl, DST, y);
      },

      /** ⚠️ 只为回报与探针断言。⛔ 产品逻辑不许拿它做判断。 */
      state: function () {
        return {
          running: running,
          knots: knots ? knots.length : 0,
          /** 采集到的锚点对个数。 */
          anchors: anchorCount,
          /** ⭐ 折线里**真正用上**的锚点个数（⛔ 与 `anchors` 不是同一个数）。 */
          used: usedCount,
          exact: exact,
          origin: guard.origin(),
        };
      },
    };
  }

  const api = {
    ECHO_EPS,
    ECHO_KEEP,
    SRC,
    DST,
    pairAnchors,
    buildKnots,
    mapValue,
    createGuard,
    createDriver,
    sourceLineTopOf,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).sync = api;
})();
