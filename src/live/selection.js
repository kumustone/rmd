// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// 自绘光标 ＋ 自绘选区 ＋ 光标移动的**纯逻辑** —— `design/0047` §2.7（`F6` 的落点）。
//
// # 为什么必须自己画（⛔ 不是"想画得更漂亮"）
//
// `INV-LIVE-12`：`contentDOM` **永远不被聚焦**（输入走离屏 `textarea`，否则 WebKit 会自己排版
// 组合串 ⇒ `F6` 直接失守）。后果有两条，两条都是**屏幕上看不见**的：
//   ① 没有焦点 ⇒ **没有原生插入符**（`caret-color` 再对也不会出现）；
//   ② `drawSelection` **不在** `INV-LIVE-11` ② 的白名单里 ⇒ **没有 `.cm-selectionBackground`**。
// ⇒ 不自己画，"能打字但看不见光标、选了但看不见选区"。
//
// # 本文件的三块
//
// 1. ⭐ **移动判据（纯函数）**：`move(doc, sel, cmd, opts)`。
//    它只认一个**适配器**（`lines` / `length` / `lineAt(pos)`）——CM6 的 `Text` 本身就满足它，
//    而测试里塞一个假适配器就能跑（`tests/js/live-selection.test.js`）。
//    ⚠️ 这就是 `INV-LIVE-17` 要的"函数级判据"，⛔ 不许把移动语义留在真视图里只能手敲。
// 2. **测量层**：`createLayer(view)` 一帧一次算矩形（绝对定位的小方块），⛔ 不用 `Decoration`
//    ——选区是**几何**，不是文档结构；走装饰会让每次移动都重建 `DecorationSet`。
// 3. **鼠标**：`installMouse(view, hooks)`。
//    ⭐ 必须挂在 **capture** 阶段并 `preventDefault()`：CM6 自己的 mousedown 会 `focus()`
//    `contentDOM`（读它的源码可知），那正好破 `INV-LIVE-12`。
//
// ⚠️ 光标位置**只在这里**算"点在哪" → `view.posAtCoords` ⇒ 失败返回 `null`，
//    ⛔ **不猜**（猜错的形态是"点一下跳到别处"，用户会以为丢内容）。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，顶层 `const` 撞名会让
// **整个文件不执行**（窗口空白、stderr 全静默）。理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  /** 选区归一化：`{anchor, head}` → `{from, to}`（半开，0-based 行内偏移同口径）。 */
  function range(sel) {
    const a = sel && Number.isInteger(sel.anchor) ? sel.anchor : 0;
    const h = sel && Number.isInteger(sel.head) ? sel.head : a;
    return { from: Math.min(a, h), to: Math.max(a, h) };
  }

  /**
   * 光标线宽（px）。⚠️ 必须与 `styles/live.css` 的 `.cm-rmd-caret { width }` 一致——
   * 这里只用它算"夹回可见区"的右端，写错的表现是行末光标仍然被切掉 1 px。
   */
  const CARET_W = 2;

  /**
   * 把光标夹回**能被看见的那块盒子**里（`bugs/0085`）。
   *
   * ⭐ 为什么需要它：单元格宿主 `.cm-rmd-cell` 是 `display: inline-block` ＋ `overflow-x: clip`，
   * 宽度**收缩到内容宽**；而 `coordsAtPos(head, 1)` 在**行末**给出的 `left` 正好等于内容右边界
   * ⇒ 那 2 px 整个落在裁剪盒之外，**屏幕上一根都看不见**（实测剩余可见宽 `0`）。
   * 用户看到的是「光标到最后一行就突然没了」，而 `getBoundingClientRect()` 照样有值
   * ⇒ 只看矩形量不到这个缺陷，必须量**裁切链的剩余宽**。
   *
   * ⚠️ 只夹**光标**：选区矩形足够宽、被切掉 2 px 看不出来，而夹它会让高亮少画一段。
   * ⚠️ 盒子宽读不到（`0`）或宽得离谱时**原样返回**——⛔ 宁可少夹一次，不把光标搬到别处。
   *
   * @param {number} left 光标左边界（相对这一层，px）
   * @param {number} boxW 这一层的可见宽（px）
   * @param {number} w 光标线宽（px）
   * @returns {number}
   */
  function 夹回可见区(left, boxW, w) {
    if (!isFinite(left) || !isFinite(boxW) || !isFinite(w)) return left;
    if (!(boxW > 0) || !(w > 0)) return left;
    const 最大 = boxW - w;
    if (最大 < 0) return left;
    return left > 最大 ? 最大 : left;
  }

  function clamp(doc, pos) {
    const n = doc.length || 0;
    if (pos < 0) return 0;
    if (pos > n) return n;
    return pos;
  }

  /** `pos` 所在行（适配器口径：CM6 `Text` 与测试夹具都满足）。 */
  function lineOf(doc, pos) {
    return doc.lineAt(clamp(doc, pos));
  }

  /** 位置上的一个 UTF-16 码元（越界 ⇒ 空串）。 */
  function charAt(doc, pos) {
    if (pos < 0 || pos >= (doc.length || 0)) return '';
    const l = lineOf(doc, pos);
    const i = pos - l.from;
    return i < 0 || i >= l.text.length ? '' : l.text.charAt(i);
  }

  /**
   * 词字符：ASCII 标识符那一族。
   *
   * ⚠️ **CJK 单独一类**（见 [`CJK`]）：中文没有空格，把一整段汉字当一个词会让
   * `⌥→` 一次跳到段尾——所以汉字**逐字**跳。⛔ 这条**本项目自定**，没有通用标准（引它时按 §1.5 标⚠️）。
   */
  const WORD = /[0-9A-Za-z_]/;
  const CJK = /[㐀-䶿一-鿿]/;

  /**
   * 词边界：先跨过分隔符，再跨过**同一类**的一段
   * （ASCII 词整段、汉字**只走一个字**）。
   */
  function wordStop(doc, head, dir) {
    let pos = clamp(doc, head);
    const isW = function (p) {
      const c = charAt(doc, p);
      return WORD.test(c);
    };
    const isC = function (p) {
      return CJK.test(charAt(doc, p));
    };
    const step = function () {
      pos = clamp(doc, pos + dir);
    };
    if (dir < 0) {
      while (pos > 0 && !isW(pos - 1) && !isC(pos - 1)) step();
      if (pos > 0 && isC(pos - 1)) {
        step();
        return pos;
      }
      while (pos > 0 && isW(pos - 1)) step();
      return pos;
    }
    while (pos < doc.length && !isW(pos) && !isC(pos)) step();
    if (pos < doc.length && isC(pos)) {
      step();
      return pos;
    }
    while (pos < doc.length && isW(pos)) step();
    return pos;
  }

  /**
   * ⭐ **点击命中词**（双击用，`bugs/0045`）—— ⛔ 与 [`wordStop`] 的"按词移动"不是一回事。
   *
   * ⚠️ 为什么必须分开（2026-10-29 实测）：`wordStop` 的语义是"从当前位置跳到**下一个**
   *    词边界"（先跨分隔符、再跨一整段同类）。双击 `two` 的**第一个字母**时，
   *    它往左走的第一件事是跨过 `two` 左边那个空格、进入 `one` ⇒ 一次选中两个词。
   *
   * 口径（与 `wordStop` 的三分类一致）：ASCII 词取整段、**汉字逐字**（本项目自定，§1.5 标⚠️）、
   * 分隔符取其连续段；`pos` 落在词末分隔符上时取**左边**那个词（⛔ 不吞两个词）。
   * ⛔ 不跨行。
   *
   * @param {object} doc 适配器（`length` / `lineAt(pos)`）
   * @param {number} pos
   * @returns {{from:number, to:number}} 半开区间，恒落在同一逻辑行内
   */
  function wordAt(doc, pos) {
    const p = clamp(doc, pos);
    const l = lineOf(doc, p);
    const text = l.text;
    const i = p - l.from;
    const cls = function (k) {
      return k < 0 || k >= text.length ? 0 : classOf(text.charAt(k));
    };
    // ① 命中的是什么：优先 `pos` 处；它落在分隔符/行尾就改看左边那个字（词末边界）。
    let c = cls(i);
    if (c === 0 && i > 0) c = cls(i - 1);
    if (c === 0) {
      // ② 整段都是分隔符：给**这一段**（⛔ 不给空区间，否则双击等于没选中）。
      let a = i;
      let b = i;
      while (a > 0 && cls(a - 1) === 0) a--;
      while (b < text.length && cls(b) === 0) b++;
      return { from: l.from + a, to: l.from + b };
    }
    if (c === 2) {
      // ③ 汉字：只取一个字（与 `wordStop` 的自定口径一致）。
      const at = cls(i) === 2 ? i : i - 1;
      return { from: l.from + at, to: l.from + at + 1 };
    }
    // ④ ASCII 词：向两侧扩到同类边界。
    let a = i;
    let b = i;
    while (a > 0 && cls(a - 1) === 1) a--;
    while (b < text.length && cls(b) === 1) b++;
    return { from: l.from + a, to: l.from + b };
  }

  /** 字符类别：1 = ASCII 词字符、2 = 汉字、0 = 其它（分隔符 / 行尾）。 */
  function classOf(ch) {
    if (!ch) return 0;
    if (WORD.test(ch)) return 1;
    if (CJK.test(ch)) return 2;
    return 0;
  }

  /** 词单位拖动的**右吸附**：`p` 落在词上 ⇒ 该词右端；否则原位。 */
  function wordRightEdge(doc, pos) {
    const p = clamp(doc, pos);
    if (classOf(charAt(doc, p)) === 0) return p;
    return Math.max(p, wordAt(doc, p).to);
  }

  /** 词单位拖动的**左吸附**：`p - 1` 落在词上 ⇒ 该词左端；否则原位。 */
  function wordLeftEdge(doc, pos) {
    const p = clamp(doc, pos);
    if (p <= 0) return 0;
    if (classOf(charAt(doc, p - 1)) === 0) return p;
    return Math.min(p, wordAt(doc, p - 1).from);
  }

  /**
   * ⭐ 拖拽中"这一轮该选出什么"（`bugs/0044`）—— `installMouse` 与自动滚动**共用**这一处。
   *
   * ⚠️⚠️ 词 / 行单位**不能以某一端为固定锚**：双击选中 `two` 之后往回拖，
   *    若仍把 anchor 钉在初选的**左**端，头往左走就把 `two` 挤出了选区
   *    （2026-10-29 实测：`one two three` 双击 `two` 左拖到 1 ⇒ `"one "`，`two` 没了）。
   * ⇒ 支点是**初选区间**：往右扩锚左端、往左扩锚右端，回到区间内**原样保留**（⛔ 不缩成一点）。
   *
   * @param {object} doc
   * @param {number} unit 1 = 字符 / 2 = 词 / 3 = 行
   * @param {{from:number,to:number}|null} base 初选区间（单位 1 传 `{from:anchor,to:anchor}`）
   * @param {number} p 指针位置
   * @returns {{anchor:number, head:number}}
   */
  function dragRange(doc, unit, base, p) {
    const at = clamp(doc, p);
    const b = (base && Number.isInteger(base.from) && Number.isInteger(base.to))
      ? { from: Math.min(base.from, base.to), to: Math.max(base.from, base.to) }
      : { from: at, to: at };
    if (unit === 3) {
      if (at >= b.to) return { anchor: b.from, head: Math.max(b.to, doc.lineAt(at).to) };
      if (at <= b.from) return { anchor: b.to, head: Math.min(b.from, doc.lineAt(at).from) };
      return { anchor: b.from, head: b.to };
    }
    if (unit === 2) {
      if (at >= b.to) return { anchor: b.from, head: Math.max(b.to, wordRightEdge(doc, at)) };
      if (at <= b.from) return { anchor: b.to, head: Math.min(b.from, wordLeftEdge(doc, at)) };
      return { anchor: b.from, head: b.to };
    }
    return { anchor: b.from, head: at };
  }

  /** 码元是不是代理对的一半（没有 `Intl.Segmenter` 时至少不拆这两个）。 */
  function isHighSurrogate(code) { return code >= 0xd800 && code <= 0xdbff; }
  function isLowSurrogate(code) { return code >= 0xdc00 && code <= 0xdfff; }

  /** 字素簇分割器（懒建；没有 `Intl.Segmenter` 的引擎拿到 `null`）。 */
  let segmenter;
  function segmenterOf() {
    if (segmenter !== undefined) return segmenter;
    try {
      segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
    } catch (e) {
      segmenter = null;
    }
    return segmenter;
  }

  /**
   * 分割窗口（码元数）。
   * ⚠️ 只在窗口里分割：`Intl.Segmenter` 对整块（最多 256 KiB）做一次分割，
   *    每按一次键都跑，代价完全没有必要。
   * ⚠️ 但窗口**太短会切在字素中间**：ZWJ 序列（👨‍👩‍👧‍👦）能有十几个码元，
   *    切过去之后"最后一个字素"是半截 ⇒ 两端各留一次翻倍的机会再说。
   */
  const GRAPHEME_WINDOW = 32;
  const GRAPHEME_WINDOW_MAX = 256;

  /** 没有分割器时的退化：只避开代理对（⛔ 不拆出半个字符）。 */
  function surrogateBack(doc, pos) {
    if (pos <= 0) return 0;
    const c = charAt(doc, pos - 1).charCodeAt(0);
    if (isLowSurrogate(c) && pos >= 2 && isHighSurrogate(charAt(doc, pos - 2).charCodeAt(0))) return pos - 2;
    return pos - 1;
  }

  function surrogateForward(doc, pos) {
    const n = doc.length || 0;
    if (pos >= n) return n;
    if (pos < 0) return 0;
    if (isHighSurrogate(charAt(doc, pos).charCodeAt(0))
      && pos + 1 < n && isLowSurrogate(charAt(doc, pos + 1).charCodeAt(0))) return pos + 2;
    return pos + 1;
  }

  /**
   * 后退**一个完整字素簇**（emoji / 组合字符）。
   * @param {object} doc 适配器（比 `move` 多要一个 `sliceString(from, to)`）
   */
  function graphemeBack(doc, pos) {
    if (pos <= 0) return 0;
    const seg = segmenterOf();
    if (!seg || typeof doc.sliceString !== 'function') return surrogateBack(doc, pos);
    let win = GRAPHEME_WINDOW;
    for (;;) {
      const from = Math.max(0, pos - win);
      const chunk = doc.sliceString(from, pos);
      let last = 0;
      for (const it of seg.segment(chunk)) last = it.index;
      // ⚠️ `last === 0 && from > 0`：最后一个字素可能**被窗口左边界切过**
      //    （组合标记落在 chunk 开头时会自成一个段）⇒ 窗口不够，翻倍再看。
      if (!(last === 0 && from > 0) || win >= GRAPHEME_WINDOW_MAX || from === 0) return from + last;
      win *= 2;
    }
  }

  /**
   * 前进**一个完整字素簇**（`bugs/0046`：`⇧→` 与 `⌦` 原先直接 `+1`，能选中半个 Emoji）。
   * @param {object} doc 适配器（同 `graphemeBack`）
   */
  function graphemeForward(doc, pos) {
    const n = doc.length || 0;
    if (pos >= n) return n;
    if (pos < 0) return 0;
    const seg = segmenterOf();
    if (!seg || typeof doc.sliceString !== 'function') return surrogateForward(doc, pos);
    let win = GRAPHEME_WINDOW;
    for (;;) {
      const to = Math.min(n, pos + win);
      const chunk = doc.sliceString(pos, to);
      let first = null;
      for (const it of seg.segment(chunk)) { first = it; break; }
      const len = first ? first.segment.length : 0;
      if (len <= 0) return Math.min(n, pos + 1);
      // ⚠️ 第一个字素**吃满了整个窗口**且窗口还没到文末 ⇒ 右边可能切在字素中间。
      const complete = len < chunk.length || to >= n;
      if (complete || win >= GRAPHEME_WINDOW_MAX) return Math.min(n, pos + len);
      win *= 2;
    }
  }

  /**
   * ⭐ **合法落点**（`design/0061` L2）：`pos` 落在某个隐藏区间**内部**时，按方向吸附到端点。
   *
   * ⚠️ 判据是**严格内部**（`h.from < pos < h.to`）：区间端点本身是合法的可见边界
   *    （`**` 之前 / 之后），光标停在那里是正常的，⛔ 不推开。
   * ⚠️ 区间数组必须**已排序、互不重叠**（`markers().ranges` 与 `hiddenRanges()` 都保证）；
   *    这里用二分查找，O(log n)。
   * ⚠️ 非整数 / 非法输入**原样返回**：调用方（点击换算、键盘结果）自己会夹到 `[0, length]`，
   *    本函数不猜文档长度。
   * ⚠️ 「不可见行」（围栏行）的跨行处理由 DOM 侧封装把整行编成一个隐藏区间来完成
   *    （见 `legalHiddenOfPlan`），⛔ 本函数不认识"行"。
   *
   * @param {{from:number,to:number}[]} hidden 已排序、互不重叠的隐藏区间（绝对偏移）
   * @param {number} pos
   * @param {-1|1} dir  -1 = 向左/向前，+1 = 向右/向后
   * @returns {number}
   */
  function legalEdge(hidden, pos, dir) {
    if (!Number.isInteger(pos)) return pos;
    const hs = hidden || [];
    let lo = 0;
    let hi = hs.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (hs[mid].from <= pos) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (i < 0) return pos;
    const h = hs[i];
    if (pos > h.from && pos < h.to) return dir < 0 ? h.from : h.to;
    return pos;
  }

  /**
   * 无方向的合法落点：落在隐藏区间内部时取**较近**的端点（等距取左）。
   * ⚠️ 点击换算没有天然的"方向"（`posAtCoords` 给的是一个点），但也不能随便选一边：
   *    取较近的那一端，光标才不会在视觉上跳很远。⚠️ 与 `legalEdge` 分开是为了让
   *    纯逻辑判据（方向吸附）保持**只有一条**规则，⛔ 不把"最近"混进方向语义。
   * @param {{from:number,to:number}[]} hidden
   * @param {number} pos
   * @returns {number}
   */
  function legalNearest(hidden, pos) {
    if (!Number.isInteger(pos)) return pos;
    const hs = hidden || [];
    let lo = 0;
    let hi = hs.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (hs[mid].from <= pos) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (i < 0) return pos;
    const h = hs[i];
    if (!(pos > h.from && pos < h.to)) return pos;
    return (pos - h.from) <= (h.to - pos) ? h.from : h.to;
  }

  /**
   * 这一份 `markers()` 结果的隐藏区间（**不含**围栏行）——“删除保护”用的那一组
   * （`design/0061` L3：隐藏标记只能在整段被覆盖时一起删）。
   * @param {object|null} plan `decorations.markers()` 的返回值
   * @returns {{from:number,to:number}[]}
   */
  const RANGE_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;
  function hiddenOfPlan(plan) {
    if (!plan) return [];
    if (RANGE_CACHE) {
      const got = RANGE_CACHE.get(plan);
      if (got) return got;
    }
    const out = [];
    const rs = plan.ranges || [];
    for (let i = 0; i < rs.length; i++) out.push({ from: rs[i].from, to: rs[i].to });
    if (RANGE_CACHE) RANGE_CACHE.set(plan, out);
    return out;
  }

  const PREFIX_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;
  /**
   * 这一份 `markers()` 结果的**块前缀**区间（列表标记 / 任务框 / 引用 / 标题 / 续行缩进），
   * 相邻者已合并（`bugs/0111` A6：块前缀与**成对行内标记**是两个集合，⛔ 不能并成一条链）。
   *
   * ⚠️ `plan.prefixRanges` 缺失（老 plan / 单测手写的计划）⇒ 返回 `null`，调用方必须
   *    **回落到 `hidden`**（fail-closed）：宁可沿用旧口径，⛔ 不要把成对行内标记当块前缀删。
   * @param {object|null} plan
   * @returns {{from:number,to:number}[]|null}
   */
  function prefixOfPlan(plan) {
    if (!plan || !Array.isArray(plan.prefixRanges)) return null;
    if (PREFIX_CACHE) {
      const got = PREFIX_CACHE.get(plan);
      if (got !== undefined) return got;
    }
    const raw = [];
    for (let i = 0; i < plan.prefixRanges.length; i++) {
      const r = plan.prefixRanges[i];
      if (r && r.to > r.from) raw.push({ from: r.from, to: r.to });
    }
    sortRanges(raw);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      const last = out[out.length - 1];
      if (last && r.from <= last.to) {
        if (r.to > last.to) last.to = r.to;
      } else {
        out.push({ from: r.from, to: r.to });
      }
    }
    if (PREFIX_CACHE) PREFIX_CACHE.set(plan, out);
    return out;
  }

  const LEVELS_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;
  /**
   * 这一份 `markers()` 结果的**块前缀分层**区间（`bugs/0111` K3）。
   *
   * 与 `prefixOfPlan` 同源，但⛔ **不合并相邻层**：每个元素是一层块前缀（引用每层 `>` 一段、
   * 列表标记＋任务框＋行首缩进一段、标题标记一段、续行缩进一段）。
   * `wholeLineMark` 的反向档靠它把 `> - ` 的删除跨度收窄到"只退一层"。
   *
   * ⚠️ `plan.prefixLevels` 缺失（老 plan / 单测手写的计划）⇒ 返回 `null`，调用方必须
   *    **回落到旧行为**（fail-closed）：宁可一次删整条前缀链，⛔ 不要凭空劈出新跨度。
   * @param {object|null} plan
   * @returns {{from:number,to:number}[]|null}
   */
  function levelsOfPlan(plan) {
    if (!plan || !Array.isArray(plan.prefixLevels)) return null;
    if (LEVELS_CACHE) {
      const got = LEVELS_CACHE.get(plan);
      if (got !== undefined) return got;
    }
    const out = [];
    for (let i = 0; i < plan.prefixLevels.length; i++) {
      const r = plan.prefixLevels[i];
      if (r && r.to > r.from) out.push({ from: r.from, to: r.to });
    }
    // ⚠️ 只排序，⛔ 不合并：每层之间的边界正是"退一层"要用的落点。
    sortRanges(out);
    if (LEVELS_CACHE) LEVELS_CACHE.set(plan, out);
    return out;
  }

  /**
   * 合法落点用的隐藏集合 = 标记区间 ＋ **每一条围栏行**（`design/0061` L2）。
   *
   * ⚠️ 围栏行在屏幕上整行塌成 0 高（`cm-rmd-fence`）⇒ 行内**每一个**光标位置都看不见。
   *    把整行编成一个伪区间 `[行首-1, 行末+1]`，`legalEdge` 的"严格内部"就正好覆盖
   *    `行首..行末` 的全部整数位置，吸附结果落在**上一行末**（向左）或**下一行首**（向右）。
   *    ⚠️ 首行 / 末行不夹到 `[0, length]`：`-1` 与 `length+1` 只会作为吸附目标出现，
   *    调用方 `snapCaret` 再夹回文档，⛔ 不会成为真实选区。
   *    ⚠️ 这里的**合并**只服务落点判定的**最终集合**（`legalEdge` / `legalNearest` 要求
   *    已排序、互不重叠）；⛔ 不许把它当成 `mapHidden` 的映射输入（`bugs/0317`：映射必须用
   *    未合并的 `plan.rawRanges`，否则相邻区间之间的边界会被抹掉）。
   * @param {object|null} plan
   * @returns {{from:number,to:number}[]}
   */
  /**
   * 按 `(from, to)` 升序**原地**排区间。
   * ⚠️ 刻意不用 `Array#sort`：`tests/js/doclist-source.test.js` 把 `.sort(` 限制在
   *    "需要第二份顺序"的白名单文件里；这里只是给最多几十个区间排个序，插入排序更直白，
   *    ⛔ 不要因为"更短"改回去（会让 `make test-js` 红）。
   * @param {{from:number,to:number}[]} rs
   * @returns {{from:number,to:number}[]}
   */
  function sortRanges(rs) {
    for (let i = 1; i < rs.length; i++) {
      const x = rs[i];
      let j = i - 1;
      while (j >= 0 && (rs[j].from > x.from || (rs[j].from === x.from && rs[j].to > x.to))) {
        rs[j + 1] = rs[j];
        j--;
      }
      rs[j + 1] = x;
    }
    return rs;
  }

  const LEGAL_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;
  function legalHiddenOfPlan(plan) {
    if (!plan) return [];
    if (LEGAL_CACHE) {
      const got = LEGAL_CACHE.get(plan);
      if (got) return got;
    }
    const raw = hiddenOfPlan(plan).slice();
    // ⚠️ 塌成 0 高的行（围栏行 / Setext 下划线行）编一个**跨整行**的伪区间：光标落在里面
    //    就"消失"了（行高 0），必须让 `legalEdge` 把它跨过去（`design/0061` L2）。
    const fs = plan.fenceLines || [];
    for (let i = 0; i < fs.length; i++) {
      raw.push({ from: fs[i].from - 1, to: fs[i].to + 1 });
    }
    const cs = plan.collapsedLines || [];
    for (let i = 0; i < cs.length; i++) {
      raw.push({ from: cs[i].from - 1, to: cs[i].to + 1 });
    }
    sortRanges(raw);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      const last = out[out.length - 1];
      if (last && r.from <= last.to) {
        if (r.to > last.to) last.to = r.to;
      } else {
        out.push({ from: r.from, to: r.to });
      }
    }
    if (LEGAL_CACHE) LEGAL_CACHE.set(plan, out);
    return out;
  }

  /** 取当前视图的 `markers()` 结果（由 `main.js` 的 `createField({onPlan})` 发布）。 */
  function planOf(view, opts) {
    void view;
    if (!opts || typeof opts.plan !== 'function') return null;
    try {
      return opts.plan() || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 当前视图的隐藏区间（**标记**，不含围栏行）——删除保护用。
   * @param {object} view CM6 视图（只用其 `state` 语义；plan 已经与它同坐标）
   * @param {{plan?:() => object|null, cellContext?:boolean}} [opts]
   * @returns {{from:number,to:number}[]}
   */
  function hiddenRanges(view, opts) {
    return hiddenOfPlan(planOf(view, opts));
  }

  /** 当前视图的合法落点集合（标记 ＋ 围栏行）——光标吸附用。 */
  function legalRanges(view, opts) {
    return legalHiddenOfPlan(planOf(view, opts));
  }

  /**
   * 当前视图的**块前缀**区间（列表标记 / 任务框 / 引用 / 标题 / 续行缩进）——
   * `deleteRange` 的整行标记那一档用（`bugs/0111` A6）。
   *
   * 与 `hiddenRanges` 同形；⚠️ `plan` 没有 `prefixRanges` 时返回 `null`，调用方必须回落到
   * `hidden`（fail-closed，见 `prefixOfPlan`）。
   * @param {object} view CM6 视图（只用其 `state` 语义；plan 已经与它同坐标）
   * @param {{plan?:() => object|null, cellContext?:boolean}} [opts]
   * @returns {{from:number,to:number}[]|null}
   */
  function prefixRanges(view, opts) {
    return prefixOfPlan(planOf(view, opts));
  }

  /**
   * 当前视图的**块前缀分层**区间（`bugs/0111` K3）——`deleteRange` 的"一次退一层"用。
   *
   * 与 `hiddenRanges` 同形；⚠️ `plan` 没有 `prefixLevels` 时返回 `null`，调用方必须
   * 回落到旧行为（fail-closed，见 `levelsOfPlan`）。
   * @param {object} view CM6 视图（只用其 `state` 语义；plan 已经与它同坐标）
   * @param {{plan?:() => object|null, cellContext?:boolean}} [opts]
   * @returns {{from:number,to:number}[]|null}
   */
  function prefixLevels(view, opts) {
    return levelsOfPlan(planOf(view, opts));
  }

  const PROTECT_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;
  /**
   * 删除保护用的隐藏集合 = **标记区间 ＋ 围栏行的伪区间**（`design/0061` L3 / `bugs/0087`）。
   *
   * ⚠️ `hiddenRanges()` 只有标记；围栏行整行塌成 0 高、恒定隐藏，它**自己的换行**
   *    一旦被删，下一行可见内容就被并进这条看不见的行里（屏幕上代码凭空消失）。
   *    ⇒ 与 `legalHiddenOfPlan` 同一种伪区间 `[行首-1, 行末+1]`，`deleteRange` 会整段
   *    跨过围栏、删到相邻的**可见**字素；⛔ 不允许只吃掉围栏行的换行。
   * @param {object|null} plan
   * @returns {{from:number,to:number}[]}
   */
  function protectedOfPlan(plan) {
    if (!plan) return [];
    if (PROTECT_CACHE) {
      const got = PROTECT_CACHE.get(plan);
      if (got) return got;
    }
    const base = hiddenOfPlan(plan);
    const raw = [];
    for (let i = 0; i < base.length; i++) raw.push({ from: base[i].from, to: base[i].to });
    const fs = plan.fenceLines || [];
    for (let i = 0; i < fs.length; i++) raw.push({ from: fs[i].from - 1, to: fs[i].to + 1 });
    sortRanges(raw);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      const last = out[out.length - 1];
      if (last && r.from <= last.to) {
        if (r.to > last.to) last.to = r.to;
      } else {
        out.push({ from: r.from, to: r.to });
      }
    }
    if (PROTECT_CACHE) PROTECT_CACHE.set(plan, out);
    return out;
  }

  /**
   * 当前视图的删除保护集合（**标记 ＋ 围栏行**）——`deleteRange` 用。
   * @param {object} view CM6 视图（只用其 `state` 语义；plan 已经与它同坐标）
   * @param {{plan?:() => object|null, cellContext?:boolean}} [opts]
   * @returns {{from:number,to:number}[]}
   */
  function protectedRanges(view, opts) {
    return protectedOfPlan(planOf(view, opts));
  }

  /**
   * 有隐藏集合时的吸附本体（`snapCaret` 与 `legalFilter` 共用）。
   * @param {{from:number,to:number}[]} hidden
   * @param {number|null} n 文档长度（`null` = 不知道，不夹）
   * @param {number} pos
   * @param {-1|0|1} dir
   * @returns {number}
   */
  function snapPos(hidden, n, pos, dir) {
    if (!Number.isInteger(pos) || !hidden.length) {
      return n === null ? pos : Math.max(0, Math.min(n, pos));
    }
    let r = dir === 0 ? legalNearest(hidden, pos) : legalEdge(hidden, pos, dir < 0 ? -1 : 1);
    if (n !== null) {
      if (r < 0) r = 0;
      if (r > n) r = n;
    }
    // ⚠️ 文档边界本身就在隐藏行里（整篇只有一条围栏）：夹回之后仍可能落在内部。
    //    取反方向的端点再夹一次；仍无可见位置（整篇都不可见）则返回夹好的值。
    if (legalNearest(hidden, r) !== r) {
      r = legalEdge(hidden, r, dir < 0 ? 1 : -1);
      if (n !== null) r = Math.max(0, Math.min(n, r));
    }
    return r;
  }

  /**
   * ⭐ 列表行的**正文起点**（`bugs/0092`，2026-11-05）：列表标记与行首缩进恒藏之后，
   * `from`（行首）在文档里**是一个合法位置**（不在任何隐藏区间内部），但那里没有可见字符
   * ——光标停在行首敲字会插到 `- ` **之前**，把列表结构写坏（点缩进带、按 Home、程序化
   * dispatch 都能到那儿）。⇒ 折叠选区落在某条列表行的行首时，一律吸到正文起点。
   *
   * @param {object|null} plan `markers()` 的结果
   * @param {number} pos
   * @returns {number} 正文起点；不是列表行行首时返回 `-1`
   */
  function listContentStart(plan, pos) {
    return listStartsAt(plan && plan.listLines, pos);
  }

  /**
   * 一组列表行记录里，`pos` 是不是某一条列表行的**行首**。
   * @param {Array<{from:number,contentFrom?:number,kind:string}>|null} ls
   * @param {number} pos
   * @returns {number} 正文起点；不是列表行行首时返回 `-1`
   */
  function listStartsAt(ls, pos) {
    if (!ls || !ls.length) return -1;
    for (let i = 0; i < ls.length; i++) {
      const li = ls[i];
      if (li && li.from === pos && li.kind !== 'plain'
        && typeof li.contentFrom === 'number' && li.contentFrom > pos) {
        return li.contentFrom;
      }
    }
    return -1;
  }

  /**
   * 把「列表行首 → 正文起点」这张表按一次文档变更**映射**到新坐标。
   *
   * ⚠️⚠️ 为什么必须映射（2026-11-05 实测，`bugs/0084` 的同一族）：
   *    这张表的坐标是**变更前**那一份源码里的行首，而 `legalFilter` 要判的是**新文档**里的
   *    位置。不映射就等于拿"A 行在这里"去判"B 行"——而列表行的行首到处都是合法位置，
   *    命中一次就吸错一次。实测：在列表第 1 行末按回车，新空行的行首**恰好等于**变更前第 2 行
   *    （列表项）的行首 ⇒ 光标被吸进第 2 行的 `- ` 里（`- ` 是隐藏区间），接着敲的
   *    `## 小标题` 落成 `-# # 小标题…`，`O-ul-2/4/5`、`O-ol-*`、`O-blockquote-*` 六条同红。
   * @param {Array<{from:number,contentFrom?:number,kind:string}>|null} ls
   * @param {object} changes CM6 `ChangeSet`
   * @returns {Array<{from:number,contentFrom?:number,kind:string}>}
   */
  function mapListLines(ls, changes) {
    if (!ls || !ls.length || !changes || typeof changes.mapPos !== 'function') return ls || [];
    const L = typeof changes.length === 'number' ? changes.length : Infinity;
    const out = [];
    for (let i = 0; i < ls.length; i++) {
      const li = ls[i];
      if (!li || typeof li.from !== 'number' || typeof li.contentFrom !== 'number') continue;
      // ⚠️ `assoc=+1`：插入正好压在行首（或正文起点）上时，行首在插入文本**之后**。
      const from = changes.mapPos(Math.max(0, Math.min(L, li.from)), 1);
      const c = changes.mapPos(Math.max(0, Math.min(L, li.contentFrom)), 1);
      // 标记被删掉（或被删得只剩空）⇒ 这一行不再是"标记后面还有正文"的列表行。
      if (c > from) out.push({ from: from, contentFrom: c, kind: li.kind });
    }
    return out;
  }

  /**
   * 折叠选区的吸附（隐藏区间 ＋ 列表行首 → 正文起点）。
   *
   * ⚠️ **方向不同、去处不同**（2026-11-05，`bugs/0092`）：
   *   · 无方向（点击 / 中央兜底 / Home）⇒ 行首吸到**正文起点**（标记右边看不见，落在行首
   *     等于把光标放进缩进带，而且敲的字会插到 `- ` 之前）；
   *   · 向左（`←`／`⌥←` 等）⇒ 行首**不停**，直接跨过整条标记落到上一行行末（`from - 1`）。
   *     ⛔ 不能也吸到正文起点：那样 `←` 在正文起点会**按了不动**。
   */
  function snapPoint(plan, hidden, n, pos, dir, starts) {
    const r = snapPos(hidden, n, pos, dir);
    const c = listStartsAt(starts || (plan && plan.listLines), r);
    if (c < 0) return r;
    if (dir >= 0) return c;
    const p = Math.max(0, r - 1);
    return n === null ? p : Math.max(0, Math.min(n, p));
  }

  /**
   * ⭐ **DOM 侧落点封装**（`design/0061` L2）：读 `view.state` ＋ 装饰层发布的 `plan`。
   *
   * @param {object} view CM6 视图
   * @param {number} pos 候选落点（绝对偏移）
   * @param {-1|0|1} dir 0 = 无方向（取较近端点）；±1 = 按方向吸附
   * @param {{plan?:() => object|null, cellContext?:boolean}} [opts]
   * @returns {number}
   */
  function snapCaret(view, pos, dir, opts) {
    const n = (view && view.state && view.state.doc && typeof view.state.doc.length === 'number')
      ? view.state.doc.length : null;
    const plan = planOf(view, opts);
    return snapPoint(plan, legalHiddenOfPlan(plan), n, pos, dir);
  }

  /**
   * 选区两端的合法化：`from` 向左、`to` 向右（保持 anchor/head 的朝向）。
   * @param {object} view
   * @param {{anchor:number, head:number}} sel
   * @param {{plan?:() => object|null, cellContext?:boolean}} [opts]
   * @returns {{anchor:number, head:number}}
   */
  function snapRange(view, sel, opts) {
    if (!sel || !Number.isInteger(sel.anchor) || !Number.isInteger(sel.head)) return sel;
    const hidden = legalHiddenOfPlan(planOf(view, opts));
    if (!hidden.length) return sel;
    const n = (view && view.state && view.state.doc && typeof view.state.doc.length === 'number')
      ? view.state.doc.length : null;
    const a = sel.anchor;
    const h = sel.head;
    if (a === h) {
      const p = snapPoint(planOf(view, opts), hidden, n, a, 0);
      return { anchor: p, head: p };
    }
    const from = Math.min(a, h);
    const to = Math.max(a, h);
    const nf = snapPos(hidden, n, from, -1);
    const nt = snapPos(hidden, n, to, 1);
    return a <= h ? { anchor: nf, head: nt } : { anchor: nt, head: nf };
  }

  /**
   * 把一组隐藏区间按一次文档变更**映射**到新坐标（中央兜底用）。
   * ⚠️ `from` 用 `assoc=+1`、`to` 用 `assoc=-1`：边界上的插入落在区间**外**
   *    （插入的可见字符不该被当成隐藏），删除则自然收拢。映射后重新排序合并。
   *    ⚠️ 方向不能反（`bugs/0086`）：反了会把新插入的可见字符划进隐藏区间，
   *    随后 `legalFilter` 把光标吸回区间左端 ⇒ 连打两字倒序、回车落回上一行。
   * @param {{from:number,to:number}[]} hidden
   * @param {object} changes CM6 `ChangeSet`
   * @returns {{from:number,to:number}[]}
   */
  function mapHidden(hidden, changes) {
    if (!hidden || !hidden.length || !changes || typeof changes.mapPos !== 'function') return hidden || [];
    // ⚠️⚠️ **必须夹到 changeset 的坐标域**（2026-11-05 实测，`design/0061` L2）：
    //    `legalHiddenOfPlan` 给围栏行编的伪区间是 `[行首-1, 行末+1]`，文档**首/末**
    //    那条围栏的端点因此会落到 `-1` / `length+1`。`legalEdge`/`legalNearest` 只拿它们
    //    当吸附目标（结果会再夹回文档），但 `ChangeSet.mapPos` **越界就抛**
    //    （"Position N is out of range for changeset of length L"）⇒ 整个事务在白屏外
    //    静默作废：回车不长行、敲字不落文档，而屏幕上与"按键没接线"**一模一样**。
    //    ⭐ 夹取是安全的：`-1`/`length+1` 本来就只用来把"首/末行内部"的落点推开。
    const L = typeof changes.length === 'number' ? changes.length : Infinity;
    const raw = [];
    for (let i = 0; i < hidden.length; i++) {
      const a = changes.mapPos(Math.max(0, Math.min(L, hidden[i].from)), 1);
      const b = changes.mapPos(Math.max(0, Math.min(L, hidden[i].to)), -1);
      if (b > a) raw.push({ from: a, to: b });
    }
    sortRanges(raw);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      const last = out[out.length - 1];
      if (last && r.from <= last.to) {
        if (r.to > last.to) last.to = r.to;
      } else {
        out.push({ from: r.from, to: r.to });
      }
    }
    return out;
  }

  /**
   * ⭐ `legalFilter` 专用的"**变更后**合法落点集合" = `legalHiddenOfPlan` 的带变更版本。
   *
   * ⚠️⚠️ 为什么不能直接 `mapHidden(legalHiddenOfPlan(plan), changes)`（`bugs/0312`，
   *    2026-11-11 实测）：围栏行 / Setext 下划线行的伪区间是 `[行首-1, 行末+1]`，**故意**
   *    跨过两侧的换行。变更把它映射过去之后，那两条"多出来的位置"就可能压到**相邻行**
   *    的行首/行末上——而那一行在变更后已经**不再塌高**了：
   *
   *    实测（离屏探针，段落里现敲列表）：`##地方金额` 是不带空格的段落，下一行敲 `-`
   *    ⇒ Lezer 把它解析成 Setext 下划线行（伪区间 `[6,9]`，横跨 `\n-\n`）；再敲一个空格
   *    `- ` 当场把它变成列表项（那一行恢复可见），可过滤器手里还是**变更前**那份伪区间，
   *    映射后成了 `[6,10]` ⇒ 落在 9（空项行末）的落点被吸到 10 —— **下一行的行首**。
   *    接着敲的字就全粘到下一段前面去了。
   *
   * ⇒ 判据：**变更碰到的行**，它的伪区间这一发一律不用——那一行正在被编辑，是不是塌高
   *    还没有定论；光标本来也不该被自己正在敲的这一行弹走。只丢"被碰到"的那几条，
   *    其余照常映射：敲别的行时围栏/下划线的保护一点没少。
   *
   * ⚠️ 没有 `iterChanges` 的假 changeset（单测）⇒ 一条都不丢，退回旧行为。
   * @param {object} plan 变更**前**发布的 `markers()` 结果
   * @param {object} changes CM6 `ChangeSet`
   * @returns {{from:number,to:number}[]}
   */
  function legalHiddenMapped(plan, changes) {
    // ⭐⭐ `bugs/0317`（2026-11-12）：映射的输入必须是**未合并**的区间（`plan.rawRanges`）。
    //    合并后的 `ranges` 把 `2. ` 与开反引号并成 `[0,4)`；在 3 处插一个字后
    //    `mapHidden` 得到 `[0,5)`，`legalNearest` 把产品给的锚点 4 吸到 5 ⇒ 第二个字
    //    落到反引号之后。未合并时两段各自映射成 `[0,3)` / `[4,5)`，锚点 4 正好在边界上。
    //    ⚠️ 字段缺失（老 plan / 单测手写计划）⇒ 回落到合并集合（fail-closed）。
    //    ⚠️ 映射之后**照旧**排序合并（`legalEdge` / `legalNearest` 的二分前提是已排序、
    //    互不重叠，⛔ 别把重叠区间喂给它们）。
    const src = plan && plan.rawRanges ? plan.rawRanges : hiddenOfPlan(plan);
    const ranges = [];
    for (let i = 0; i < src.length; i++) ranges.push({ from: src[i].from, to: src[i].to });
    /** @type {{from:number, to:number, lineFrom:number, lineTo:number}[]} */
    const 伪 = [];
    const fs = plan.fenceLines || [];
    for (let i = 0; i < fs.length; i++) {
      伪.push({ from: fs[i].from - 1, to: fs[i].to + 1, lineFrom: fs[i].from, lineTo: fs[i].to });
    }
    const cs = plan.collapsedLines || [];
    for (let i = 0; i < cs.length; i++) {
      伪.push({ from: cs[i].from - 1, to: cs[i].to + 1, lineFrom: cs[i].from, lineTo: cs[i].to });
    }
    const 改动 = [];
    if (changes && typeof changes.iterChanges === 'function') {
      try {
        changes.iterChanges(function (fromA, toA) { 改动.push([fromA, toA]); });
      } catch (e) { void e; }
    }
    const kept = [];
    for (let i = 0; i < 伪.length; i++) {
      const p = 伪[i];
      let 碰到 = false;
      for (let k = 0; k < 改动.length; k++) {
        // 插入是 `fromA === toA`（0 长度）；判定用**闭区间相交**：压在行首/行末那一格也算。
        if (改动[k][0] <= p.lineTo && 改动[k][1] >= p.lineFrom) { 碰到 = true; break; }
      }
      if (!碰到) kept.push({ from: p.from, to: p.to });
    }
    return mapHidden(ranges.concat(kept), changes);
  }

  /**
   * ⭐⭐ **中央兜底**（`design/0061` L2）：用 CM6 的 `transactionFilter` 保证
   * 「任何事务产生的新选区两端都不在隐藏区间内部」（`INV-LIVE-15`）。
   *
   * ⚠️ 为什么是中央而不是逐个入口：撤销/重做、程序化 `dispatch`、输入法提交都不经过
   *    我们那几条键盘路径；只补入口一定会漏，而漏掉的形态是"光标停在看不见的 `**` 里"
   *    （按键没反应，再按跳两格）。⭐ `transactionFilter` 是 CM6 给所有事务的唯一收口。
   *
   * ⚠️⚠️ **为什么不会自激**：`fixing` 是一次**同步重入**的闸门——吸附后的选区会通过
   *    `startState.update()` 重新走一遍过滤器，此时 `fixing === true` 直接原样放行；
   *    `update()` 是同步调用，返回前闸门不会落下。即便没有闸门，吸附结果也是**幂等**的
   *    （端点已不在严格内部 ⇒ 第二轮不再改写），所以最坏也只是多一次解析，⛔ 不会成环。
   *
   * @param {object} CM6 `window.rmdCM6`
   * @param {{plan?:() => object|null, cellContext?:boolean}} opts
   * @returns {Array} extension 数组（没有 `transactionFilter` 时是空数组 = 可见降级）
   */
  function legalFilter(CM6, opts) {
    if (!CM6 || !CM6.EditorState || !CM6.EditorState.transactionFilter
      || typeof CM6.EditorState.transactionFilter.of !== 'function'
      || !CM6.EditorSelection || typeof CM6.EditorSelection.create !== 'function'
      || typeof CM6.EditorSelection.range !== 'function') {
      return [];
    }
    let fixing = false;
    return [CM6.EditorState.transactionFilter.of(function (tr) {
      if (fixing || !tr) return tr;
      // ⚠️ **全选必须覆盖整块源码**（`design/0061` L2）：块尾若是围栏行，文档末位置
      //    正在那条 0 高行的"内部"；按 L2 吸附会让全选漏掉结尾的 ```（替换正文后
      //    留下半截标记）。`⌘A` 显式打这个标注，中央兜底放行。
      if (typeof tr.isUserEvent === 'function' && tr.isUserEvent('select.all')) return tr;
      const plan = planOf(null, opts);
      if (!plan) return tr;
      let hidden = legalHiddenOfPlan(plan);
      if (!hidden.length) return tr;
      // ⚠️⚠️ 变更后的隐藏区间与**列表行首表**都必须跟着这一次变更走（`mapHidden` /
      //    `mapListLines`）。⛔ 不能拿变更前的坐标去比新文档里的落点：列表行首到处都是，
      //    命中一次就把光标吸进别的行的 `- ` 里（`bugs/0084` 的同一族，见 `mapListLines`）。
      /** @type {Array<{from:number, contentFrom?:number, kind:string}>} */
      let listLines = plan.listLines;
      if (tr.docChanged) {
        // ⭐ 伪区间（围栏 / Setext 下划线）走 `legalHiddenMapped` 的"碰到就丢"口径
        //    （`bugs/0312`）：直接 `mapHidden` 会把跨换行的那两个位置映射到相邻行上。
        hidden = legalHiddenMapped(plan, tr.changes);
        listLines = mapListLines(plan.listLines, tr.changes);
      }
      if (!hidden.length) return tr;
      const sel = tr.newSelection;
      if (!sel || !sel.ranges) return tr;
      const n = tr.newDoc ? tr.newDoc.length : null;
      let changed = false;
      const ranges = [];
      for (let i = 0; i < sel.ranges.length; i++) {
        const r = sel.ranges[i];
        const anchor = r.anchor;
        const head = r.head;
        let a;
        let h;
        if (anchor === head) {
          a = h = snapPoint(plan, hidden, n, anchor, 0, listLines);
        } else {
          const from = Math.min(anchor, head);
          const to = Math.max(anchor, head);
          const nf = snapPos(hidden, n, from, -1);
          const nt = snapPos(hidden, n, to, 1);
          if (anchor <= head) { a = nf; h = nt; } else { a = nt; h = nf; }
        }
        if (n !== null) {
          a = Math.max(0, Math.min(n, a));
          h = Math.max(0, Math.min(n, h));
        }
        if (a !== anchor || h !== head) changed = true;
        ranges.push(CM6.EditorSelection.range(a, h));
      }
      if (!changed) return tr;
      fixing = true;
      try {
        return tr.startState.update({
          changes: tr.changes,
          selection: CM6.EditorSelection.create(ranges, sel.mainIndex),
          effects: tr.effects,
          annotations: tr.annotations,
          scrollIntoView: tr.scrollIntoView,
        });
      } finally {
        fixing = false;
      }
    })];
  }

  /** 方向删除时**跳过紧邻的整个隐藏区间**（`design/0061` L3）：`h.to === pos`（向左）
   *  或 `h.from === pos`（向右）⇒ 直接跨到另一侧，⛔ 不逐字节吃标记。 */
  function skipHiddenBack(hidden, pos) {
    let p = pos;
    for (let guard = 0; guard < 64; guard++) {
      let hit = false;
      for (let i = hidden.length - 1; i >= 0; i--) {
        if (hidden[i].to === p) { p = hidden[i].from; hit = true; break; }
      }
      if (!hit) break;
    }
    return p;
  }

  function skipHiddenForward(hidden, pos) {
    let p = pos;
    for (let guard = 0; guard < 64; guard++) {
      let hit = false;
      for (let i = 0; i < hidden.length; i++) {
        if (hidden[i].from === p) { p = hidden[i].to; hit = true; break; }
      }
      if (!hit) break;
    }
    return p;
  }

  /** 候选删除区间**部分覆盖**了某个隐藏区间 ⇒ 向外扩到整个区间（`INV-LIVE-16`）。 */
  function expandOverHidden(hidden, from, to) {
    let a = from;
    let b = to;
    if (b <= a) return { from: a, to: b };
    for (let guard = 0; guard < 64; guard++) {
      let moved = false;
      for (let i = 0; i < hidden.length; i++) {
        const h = hidden[i];
        if (h.from < a && a < h.to) { a = h.from; moved = true; }
        if (h.from < b && b < h.to) { b = h.to; moved = true; }
      }
      if (!moved) break;
    }
    return { from: a, to: b };
  }

  /**
   * 选区删除时把**部分覆盖**的隐藏区间留在原地（只删可见字节）。
   * ⚠️ 只可能有两个区间被部分覆盖——选区是一段连续区间，中间那些要么全在、要么全不在。
   *    两端各向内收到隐藏区间的外侧端点；收窄之后若已交叉（整段选区都在同一个隐藏区间里）
   *    ⇒ 没有可见字节可删，返回折叠区间（调用方不必区分）。
   * ⚠️ 完全被覆盖的隐藏区间照删（`design/0061` L3：整结构被覆盖才一起删）。
   */
  function shrinkOverPartialHidden(hidden, from, to) {
    let a = from;
    let b = to;
    for (let i = 0; i < hidden.length; i++) {
      const h = hidden[i];
      if (h.from < a && a < h.to) a = h.to;
      if (h.from < b && b < h.to) b = h.from;
    }
    if (b < a) b = a;
    return { from: a, to: b };
  }

  /**
   * 从 `pos` 往回把**紧贴着它、逐段相接**的隐藏区间整链走完。
   *
   * ⚠️ 同一条行首标记可能是**几段连在一起**的隐藏区间（`- [x] ` ＝ `ListMark` 的
   *    `[行首, 2)` ＋ `TaskMarker` 的 `[2, 6)`）——它们逐个 `to === 起`，必须整链一起认。
   * @param {{from:number,to:number}[]} hidden 已排序、互不重叠
   * @param {number} pos 起点（光标）
   * @returns {{start:number, n:number}} `n` = 链上走了几段（`0` ⇒ `pos` 前面没有隐藏标记）
   */
  function hiddenChainBack(hidden, pos) {
    let start = pos;
    let n = 0;
    for (let guard = 0; guard < 16; guard++) {
      let 前 = -1;
      for (let i = 0; i < hidden.length; i++) {
        if (hidden[i].to === start && hidden[i].from < start) { 前 = hidden[i].from; break; }
      }
      if (前 < 0) break;
      start = 前;
      n++;
    }
    return { start: start, n: n };
  }

  /**
   * ⭐ 折叠删除的「**整行标记**」那一档（`design/0061` L3 的边界，2026-11-05 实测补）。
   *
   * 光标紧贴一个隐藏区间的**行首**一侧时（反向：区间以光标结尾且从行首开始；
   * 正向：区间以光标开头且到行末结束），要删的是**标记本身**，⛔ 不是跳过它去删隔壁。
   *
   * ⚠️⚠️ 为什么必须补这一档：`skipHiddenBack` 的职责是"别把标记半截删掉"，但
   *    「跳过 ⇒ 删紧邻的可见字素」在空标记这一档会退化成**吃换行**——`##` 空标题的
   *    标记 `## ` 左边只剩那个 `\n` ⇒ 退格把上一行并了进来，标记却还在（用户看到的
   *    是"退格没删字，反而把两行黏在一起"）。而这一刻用户的意图**就是删掉这个标记**
   *    （判据 `O-*-5b`：标记删干净后那一行回落正文尺度）。
   *
   * ⭐⭐ 2026-11-12（`bugs/0111` A6）：**块前缀**与**成对行内标记**是两个集合。
   *    反向分支的"链"只在 `prefix`（缺省回落 `hidden`）上走 ⇒ `- ` 与 `**` 不再被并成
   *    一条链，一次 ⌫ 不会同时删掉块前缀和成对标记的开半边（`- **甲**` ⇒ `**甲**`）。
   *    ⚠️ `prefix` 缺省（老 plan / 单测）⇒ 与今天逐字节一致；`prefix` 是**空数组**表示
   *    "这一行没有块前缀"（`**读者**：…`）⇒ 成对标记原地不动。
   * @param {{from:number,to:number}[]} hidden 已排序、互不重叠
   * @param {object} doc 适配器（`lineAt(pos) -> {from, to}`）
   * @param {number} pos 光标（折叠选区）
   * @param {boolean} forward `Delete` 方向
   * @param {{from:number,to:number}[]|null} [prefix] 块前缀集合（`prefixOfPlan`）；
   *   缺省 / `null` ⇒ 回落到 `hidden`（fail-closed）
   * @param {{from:number,to:number}[]|null} [levels] 块前缀**分层**集合（`levelsOfPlan`，
   *   `bugs/0111` K3）。只改反向分支 ①：链顶到行首时删"**离 `pos` 最近、且 `to === pos`**"
   *   的那一层；缺省 / `null` ⇒ 与旧行为逐字节一致（fail-closed）。
   * @returns {{from:number,to:number}|null} `null` = 不属于这一档，走原来的"跳过"语义
   */
  function wholeLineMark(hidden, doc, pos, forward, prefix, levels) {
    const hasDoc = !!(doc && typeof doc.lineAt === 'function');
    if (forward) {
      for (let i = 0; i < hidden.length; i++) {
        const h = hidden[i];
        if (h.from !== pos) continue;
        if (!hasDoc || doc.lineAt(h.from).to !== h.to) continue;
        return { from: h.from, to: h.to };
      }
      return null;
    }
    if (!hidden.length) return null;
    // ⚠️ `prefix` 缺省 ⇒ 旧口径：`hidden` 同时充当"块前缀集合"。
    const pre = (prefix === undefined || prefix === null) ? hidden : prefix;
    // ① 光标紧贴行首块前缀链 ⇒ 删 [链首, pos]（`- ` / `- [ ] ` / `## ` / `> ` 等）。
    const ch = hiddenChainBack(pre, pos);
    if (ch.n > 0 && hasDoc && doc.lineAt(ch.start).from === ch.start) {
      // ⭐⭐ `bugs/0111` K3：链顶到行首时，若调用方给了**分层**视图，就只删"离 `pos`
      //    最近、且以 `pos` 结尾"的那一层 ⇒ `> - 正文` 第一次 ⌫ 只删 `- `（留下 `> `），
      //    再按一次才删 `> `。找不到这样的层（老 plan / 分层与链不一致）⇒ 退回旧跨度。
      if (levels) {
        let 最近 = null;
        for (let i = 0; i < levels.length; i++) {
          const lv = levels[i];
          if (lv.to !== pos) continue;
          if (!最近 || lv.from > 最近.from) 最近 = lv;
        }
        if (最近) return { from: 最近.from, to: pos };
      }
      return { from: ch.start, to: pos };
    }
    if (prefix !== undefined && prefix !== null && hasDoc) {
      // ② 块前缀**不与**该行内标记相邻：`- **甲**` 的块前缀是 `[0,2)`，`**` 从 2 起。
      //    从行首把逐段相接的块前缀走完得到 `end`；若 `[end, pos)` 整段都在隐藏集合里
      //    ⇒ 只删块前缀 `[行首, end]`，⛔ 不碰成对行内标记的开半边。
      //    ⚠️ `**读者**：…` 的块前缀为空 ⇒ `end === 行首`，**不走这一档**（见 ④）。
      const 行 = doc.lineAt(pos);
      const fw = hiddenChainForward(pre, 行.from);
      const end = fw.n > 0 ? fw.end : 行.from;
      if (end > 行.from && pos >= end) {
        let 覆盖 = -1;
        for (let i = 0; i < hidden.length; i++) {
          const h = hidden[i];
          if (h.from > end) break;
          if (h.from <= end && end < h.to) { 覆盖 = h.to; break; }
        }
        if (覆盖 >= pos) return { from: 行.from, to: end };
      }
    }
    // ③ 光标紧贴一段从行首开始的块前缀 ⇒ 删这一段（旧路径；`prefix` 缺省时 `pre === hidden`）。
    for (let i = 0; i < pre.length; i++) {
      const h = pre[i];
      if (h.to !== pos) continue;
      if (!hasDoc || doc.lineAt(h.from).from !== h.from) continue;
      return { from: h.from, to: h.to };
    }
    // ④ ⭐ 光标贴着的隐藏区间从行首开始、但它**不是块前缀**（成对行内标记）⇒ 原地不动。
    //    只在 `prefix` 明确给出时生效；缺省的老口径仍走 ③ 的"整段删"。
    if (prefix !== undefined && prefix !== null) {
      for (let i = 0; i < hidden.length; i++) {
        const h = hidden[i];
        if (h.to !== pos) continue;
        if (!hasDoc || doc.lineAt(h.from).from !== h.from) continue;
        return { from: pos, to: pos };
      }
    }
    return null;
  }

  /**
   * ⭐⭐ 2026-11-10（`bugs/0305`）：**列表项行首**按 ⌫，而上一行是空行 ⇒ 删掉那条空行。
   *
   * ⚠️⚠️ 为什么必须排在 `wholeLineMark` **前面**：列表中间被回车敲出一条空行之后
   *    （`input.js::lineBreakAction` 分支 ③），列表项之间当场多出**一整行**空白
   *    （`design/0066` 模型 A 起：空行照排，一行源码 = 一个行高；此前那套
   *    `cm-rmd-li-gap-after` / `cm-rmd-li-sep` 的段距模拟已随该设计删除，
   *    ⛔ 别再按"松散列表段距"来描述这件事）。用户想删掉它时，光标自然停在**下一项的行首**
   *    ——那一档正是 `wholeLineMark`：它把 `- ` 整链删掉、空行原地不动，空白还在
   *    （实测：`- 丙项` → `丙项`，那条空白一行不少，于是"行间距变大、而且删不掉"）。
   *    ⇒ 行首 ⌫ 的**第一语义**是"并到上一行"；上一行本来就是空行时，并过去就是删空行。
   *
   * ⚠️ 只认**列表行**（源码行首就是 `- ` / `1. ` 这类标记）：标题 / 引用块前面那条空行
   *    是**正常结构**，在那里按 ⌫ 的意图常常是"去掉这个标记"（`wholeLineMark` 那一档），
   *    ⛔ 不能被这条规则改写。
   * ⚠️ 上一行必须是**真空行**（只有空白）：不然并进去会删掉正文，那是另一档语义。
   * ⚠️ 只看**上一行自己的源码**，⛔ 不读隐藏集合里的品种（那一份是行级装饰的判据）。
   *
   * @param {object} doc 适配器（`lineAt(pos) -> {from, to, text}`）
   * @param {{from:number,to:number}[]} hidden 已排序、互不重叠
   * @param {number} pos 光标（折叠选区，已吸附）
   * @returns {{from:number,to:number}|null} `null` = 不属于这一档
   */
  function backOverBlankLine(doc, hidden, pos) {
    if (!doc || typeof doc.lineAt !== 'function') return null;
    const 行 = doc.lineAt(pos);
    if (!行 || 行.from <= 0) return null;
    if (!/^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/.test(String(行.text || ''))) return null;
    // 光标得在这一行的**第一个可见位置**：行首本身，或紧跟着从行首开始的整条标记链。
    const 链 = hidden.length ? hiddenChainBack(hidden, pos) : { start: pos, n: 0 };
    const 在行首 = pos === 行.from || (链.n > 0 && 链.start === 行.from);
    if (!在行首) return null;
    const 上 = doc.lineAt(行.from - 1);
    if (!上 || String(上.text || '').trim() !== '') return null;
    return { from: 行.from - 1, to: 行.from };
  }

  /**
   * ⭐ **在"光标最前面"按回车时，新行该插在哪**（`bugs/0105`，2026-11-06 用户报告）。
   *
   * 用户原话：「在光标的最前面换行，变成后面那个样子，`**` 被留在了上一行，不符合预期。」
   * 那一行是 `**读者**：…`，可见光标落在"读"的前面——它**实际上是** `**` 之后（开场标记
   * 全藏）。回车按原样在那里插 `\n` ⇒ 源码变成 `**\n读者**：…`：开场标记独占一行、
   * 正文与闭合标记在下一行，Markdown 的强调当场断成两半。
   *
   * ⇒ 判据：光标前面是**从行首开始的整条隐藏标记链**（`**` / `- [x] ` / `## ` / `> ` …）
   * 时，插入点退到这条链的**起点**（行首），整块标记跟着正文一起下移，⛔ 不劈开。
   * ⚠️ 链没有顶到行首（句子中间的 `**`）⇒ 返回 `-1`，按原样插：那里回车本来就是在
   *    可见处断行，用户要的也是断行，而不是"把强调搬到下一段"。
   * ⚠️⚠️ 链后面没有**可见内容**（`pos >= 行.to`，或链终点到行末只剩空白）⇒ 同样 `-1`
   *    （2026-11-08，`bugs/0115`／`blocks/W5` 探针实测）：这条规则保护的是"标记后面
   *    **还有**将被劈开的正文"；`> 第一段\n>` 的光标停在孤立 `>` 之后按回车，退到链首
   *    会把换行插到 `>` **之前** ⇒ `>` 变成下一行的孤儿（空行跑到标记上方）。
   *
   * @param {{from:number,to:number}[]} hidden 已排序、互不重叠
   * @param {object} doc 适配器（`lineAt(pos) -> {from, to, text?}`；⛔ `text` 缺失时只按行尾判）
   * @param {number} pos 折叠光标
   * @returns {number} 插入点；`-1` = 不是"行首标记链之后"，按原样插
   */
  function lineStartInsertPoint(hidden, doc, pos) {
    if (!Number.isInteger(pos) || !hidden || !hidden.length) return -1;
    if (!doc || typeof doc.lineAt !== 'function') return -1;
    const ch = hiddenChainBack(hidden, pos);
    if (ch.n === 0) return -1;
    const 行 = doc.lineAt(ch.start);
    if (行.from !== ch.start) return -1;
    // ⚠️ 链后面必须还有**可见内容**（`bugs/0115`）：整行只剩标记、或只剩尾随空白时
    //    "别劈开标记"的前提不存在——退到链首只会把标记甩到新行**下面**。
    if (pos >= 行.to) return -1;
    if (typeof 行.text === 'string' && !/\S/.test(行.text.slice(pos - 行.from))) return -1;
    return ch.start;
  }

  /**
   * 从 `pos` 往**文末**方向把紧贴着它、逐段相接的隐藏区间整链走完。
   * `hiddenChainBack` 的正向镜像（同一族的理由见它）。
   * @param {{from:number,to:number}[]} hidden 已排序、互不重叠
   * @param {number} pos 起点（光标）
   * @returns {{end:number, n:number}} `n` = 链上走了几段（`0` ⇒ `pos` 后面没有隐藏标记）
   */
  function hiddenChainForward(hidden, pos) {
    let end = pos;
    let n = 0;
    for (let guard = 0; guard < 16; guard++) {
      let 后 = -1;
      for (let i = 0; i < hidden.length; i++) {
        if (hidden[i].from === end && hidden[i].to > end) { 后 = hidden[i].to; break; }
      }
      if (后 < 0) break;
      end = 后;
      n++;
    }
    return { end: end, n: n };
  }

  /**
   * ⭐⭐ `bugs/0308`（2026-11-11 用户报告）：「`**内容**` 之后，在行尾按 Enter 键，
   * 变成下面的样子，不符合预期。」`lineStartInsertPoint` 的**行尾镜像**。
   *
   * ⚠️ `design/0061` L1 下标记恒藏 ⇒ 光标停在闭合 `**` **之前**与**之后**在屏幕上
   * 完全一样（都在可见正文末尾）。停在之前时原样插 `\n` 会写成 `**正文\n**`：
   * 开场标记独在上一行、闭合标记掉到下一行，强调当场断成两半。
   * ⇒ 判据（与行首方向对称）：光标后面是一条**逐段相接、一直顶到行末**的隐藏标记链，
   * 且光标**前面还有可见内容**（这一行不是"只有标记"）⇒ 插入点移到行末（链尾）。
   * 标记本身不动，只是 `\n` 落到整条链之后。
   *
   * ⚠️ 反向边界（`bugs/0115` 的对称形态）：`**` / `>` 独占一行时**不挪**——
   * 行内光标之前没有可见内容，挪到链尾会把标记甩到新行**上面**。
   * ⚠️ 链后只允许**尾随空白**：后面还有可见内容 ⇒ 光标本来就在可见处，原样插。
   * @param {{from:number,to:number}[]} hidden 已排序、互不重叠
   * @param {object} doc 适配器（`lineAt(pos) -> {from, to, text}`）
   * @param {number} pos 光标（折叠选区）
   * @returns {number} 插入点；`-1` = 不属于这一档（原样插）
   */
  function lineEndInsertPoint(hidden, doc, pos) {
    if (!Number.isInteger(pos) || !hidden || !hidden.length) return -1;
    if (!doc || typeof doc.lineAt !== 'function') return -1;
    const ch = hiddenChainForward(hidden, pos);
    if (ch.n === 0) return -1;
    const 行 = doc.lineAt(pos);
    // 链后必须只剩空白（或正好顶到行末）。
    if (typeof 行.text !== 'string') return -1;
    if (!/^\s*$/.test(行.text.slice(ch.end - 行.from))) return -1;
    // 光标前面必须还有**可见内容**——整行只剩标记时不挪（见上面 `bugs/0115` 那条）。
    if (!/\S/.test(行.text.slice(0, pos - 行.from))) return -1;
    return 行.to;
  }

  /**
   * ⭐ 一次**插入**之后光标该落在哪（`bugs/0313`，2026-11-11 用户报告）。
   *
   * 用户原话：「在光标的最前面换行…接着敲一个字标记就被劈开」。行首回车时事务出口
   * 原来无条件写 `from + insert.length` ⇒ 光标落到**新行行首**；接着敲的字插在 `\n`
   * 与原标记之间 ⇒ `\n新# 标题`，标题 / 强调标记当场变成行中普通字符。
   *
   * 判据全部来自**这次事务本身**（⛔ 不猜 `data` 的语义、⛔ 不另存状态）：
   * - 纯插入（`to === from`）、插入文本以 `\n` 开头、插入点在**变更前**那一行的行首；
   * - 且那一行**非空**。⭐ 为什么必须要求非空：空行上"插入换行"的前后两个位置在
   *   屏幕上是同一处；若也把光标停在插入的换行**之前**，光标会落到**上一行行尾**
   *   （表现成"回车没建出新行"）⇒ 空行一律维持 `from + insert.length`。
   *
   * ⇒ 命中时返回 `from`（光标停在插入的换行**之前**，新行建在它上面）；否则维持
   * `from + insert.length`。
   * @param {object} doc 变更**前**的文档适配器（`lineAt(pos) -> {from, to}`）
   * @param {number} from 插入点
   * @param {number} to 被替换区间的右端（`to === from` ⇒ 纯插入）
   * @param {string} insert 插入文本
   * @returns {number} 插入之后的光标偏移
   */
  function caretAfterInsert(doc, from, to, insert) {
    const text = typeof insert === 'string' ? insert : '';
    const f = Number.isInteger(from) ? from : 0;
    const t = Number.isInteger(to) ? to : f;
    const 末尾 = f + text.length;
    if (t !== f || text.length === 0 || text.charAt(0) !== '\n') return 末尾;
    if (!doc || typeof doc.lineAt !== 'function') return 末尾;
    const 行 = doc.lineAt(f);
    if (!行 || 行.from !== f) return 末尾;        // 不在行首（行尾 / 行中）
    if (!(行.to > f)) return 末尾;                 // 空行：停在换行之前会跑到上一行行尾
    return f;
  }

  /**
   * 一次删除动作要删掉的**区间**（半开 `[from, to)`）。
   *
   * ⭐ 方向与粒度由**键位**决定（`⌫` / `⌦` / `⌥` / `⌘`），⛔ 不按 `inputType` 反猜。
   * ⚠️⚠️ **折叠选区的插入符就是 `range()` 的 `from`（也等于 `to`）**——
   *    `range()` 只返回 `{from, to}`，**⛔ 没有 `head`**（`live-selection.test.js` 用
   *    `deepStrictEqual` 钉死了这个形状）。2026-10-27 的缺陷正是这里读了 `r.head`：
   *    `undefined` ⇒ `NaN` ⇒ `r.to > r.from` 恒假 ⇒ **一个字符都不删**，而选区那一支
   *    （提前 return `{from, to}`）照常能用 ⇒ 看起来像"只有光标处删不掉"。
   * @param {object} doc 适配器（同 `graphemeBack`）
   * @param {{anchor:number, head:number}} sel
   * @param {{forward?:boolean, byWord?:boolean, byLine?:boolean,
   *   hidden?:Array<{from:number,to:number}>,
   *   prefix?:Array<{from:number,to:number}>|null,
   *   levels?:Array<{from:number,to:number}>|null}} [opts]
   *   `hidden`：当前视图的隐藏标记区间（`hiddenRanges(view)`，**已排序、互不重叠**）。
   *   `prefix`：块前缀区间（`prefixRanges(view)`；⛔ 不含成对行内标记），**只给**
   *   `wholeLineMark` 的反向档（`bugs/0111` A6）。⚠️ 缺省 / `null` ⇒ 回落 `hidden`
   *   （老 plan 与今天逐字节一致）。
   *   `levels`：块前缀**分层**区间（`prefixLevels(view)`，`bugs/0111` K3）。同样只给
   *   `wholeLineMark` 的反向档；缺省 / `null` ⇒ 旧跨度（一次删整条前缀链）。
   *   ⚠️ `design/0061` L3：折叠删除先**跨过**紧邻的隐藏区间再删一个可见字素；
   *   选区删除只删可见字节，**部分覆盖**的隐藏标记留在原地（`INV-LIVE-16`）。
   * @returns {{from:number, to:number}} `from === to` ⇒ 没有可删的（调用方不必区分）
   */
  function deleteRange(doc, sel, opts) {
    const o = opts || {};
    const hidden = o.hidden || [];
    const prefix = o.prefix;
    const levels = o.levels;
    const r = range(sel);
    if (r.from !== r.to) {
      // ⭐ 选区删除：只删可见字节（`design/0061` L3）。完全被覆盖的隐藏区间照删。
      const z = shrinkOverPartialHidden(hidden, r.from, r.to);
      return { from: z.from, to: Math.max(z.from, z.to) };
    }
    // ⚠️ 合法落点本应已由 L2 保证；这里再吸附一次是防御（撤销/迟到事务可能留下
    //    旧坐标），方向取这次删除的方向。
    const head = r.from;
    const 起点 = hidden.length ? legalEdge(hidden, head, o.forward === true ? 1 : -1) : head;
    if (o.byLine === true) {
      const l = doc.lineAt(起点);
      const raw = o.forward !== true
        ? { from: l.from === 起点 ? Math.max(0, 起点 - 1) : l.from, to: 起点 }
        : { from: 起点, to: l.to === 起点 ? Math.min(doc.length, 起点 + 1) : l.to };
      return expandOverHidden(hidden, raw.from, raw.to);
    }
    if (o.byWord === true) {
      // ⚠️ 与字符删除一样**先跨过紧邻的隐藏区间**：`` `x` `` 末尾按 ⌥⌫ 删的是 `x`，
      //    不是把闭合反引号一起吞掉（隐藏标记只能整体删，⛔ 不该被"词"顺带带走）。
      if (o.forward === true) {
        const p = hidden.length ? skipHiddenForward(hidden, 起点) : 起点;
        return { from: p, to: Math.max(p, wordStop(doc, p, 1)) };
      }
      const p = hidden.length ? skipHiddenBack(hidden, 起点) : 起点;
      return { from: Math.min(p, wordStop(doc, p, -1)), to: p };
    }
    if (o.forward === true) {
      // ⚠️ 无隐藏集合时保留**原来那一行**（探针的变异靶子按它定位，⛔ 别合并成一句）。
      if (!hidden.length) return { from: head, to: graphemeForward(doc, head) };
      // ⭐ 光标左边/右边**只剩这一行自己的标记** ⇒ 删标记本体（见 `wholeLineMark`）。
      const 整行正 = wholeLineMark(hidden, doc, 起点, true);
      if (整行正) return 整行正;
      const p = skipHiddenForward(hidden, 起点);
      return expandOverHidden(hidden, p, graphemeForward(doc, p));
    }
    // ⭐⭐ 2026-11-10（`bugs/0305`）：列表项行首 ＋ 上一行空行 ⇒ 删的是**那条空行**，
    //    ⛔ 不是列表标记链（否则列表仍是松的，段距删不掉）。必须排在 `wholeLineMark` 前面。
    const 空行反 = backOverBlankLine(doc, hidden, 起点);
    if (空行反) return 空行反;
    const 整行反 = hidden.length ? wholeLineMark(hidden, doc, 起点, false, prefix, levels) : null;
    if (整行反) return 整行反;
    const p = hidden.length ? skipHiddenBack(hidden, 起点) : 起点;
    return expandOverHidden(hidden, graphemeBack(doc, p), p);
  }

  /**
   * 移动。⭐ 返回 `{anchor, head, goal}`；`goal` 是"目标列"（`lineUp`/`lineDown` 要留住它，
   * 否则上下移动会在短行处**永久丢失列位置**，用户来回按一次就回不到原处）。
   *
   * @param {object} doc 适配器：`{length, lines, lineAt(pos) -> {number, from, to, text}}`
   * @param {{anchor:number, head:number}} sel
   * @param {string} cmd `charLeft|charRight|wordLeft|wordRight|lineUp|lineDown|lineStart|lineEnd|docStart|docEnd|pageUp|pageDown`
   * @param {{extend?:boolean, goal?:number|null, pageLines?:number}} [opts]
   * @returns {{anchor:number, head:number, goal:number|null}|null} `null` = 这个命令不认识（⛔ 不臆造）
   */
  function move(doc, sel, cmd, opts) {
    const o = opts || {};
    const extend = o.extend === true;
    const r = range(sel);
    const anchor = sel && Number.isInteger(sel.anchor) ? sel.anchor : 0;
    const head = sel && Number.isInteger(sel.head) ? sel.head : anchor;
    const keep = function (pos, goal) {
      return { anchor: extend ? anchor : pos, head: pos, goal: goal === undefined ? null : goal };
    };

    switch (cmd) {
      case 'charLeft':
        // ⚠️ 不按 Shift 且**有选区** ⇒ 收起到选区左端（macOS / 浏览器的标准行为）。
        if (!extend && r.from !== r.to) return keep(r.from);
        // ⚠️ **按字素簇走**（`bugs/0046`）：直接 `head - 1` 会把 emoji / 组合字符
        //    切成两半 ⇒ `⇧←` 能选中一个孤立代理项，`⌘C` 拿到的是 `\uDE00`。
        return keep(graphemeBack(doc, head));

      case 'charRight':
        if (!extend && r.from !== r.to) return keep(r.to);
        return keep(graphemeForward(doc, head));

      case 'lineStart': {
        const l = lineOf(doc, head);
        // ⚠️ 已经在行首 ⇒ 去**上一行**行首（与系统一致：再按一次才换行）。
        if (head === l.from && l.number > 1) return keep(doc.lineAt(l.from - 1).from);
        return keep(l.from);
      }

      case 'lineEnd': {
        const l = lineOf(doc, head);
        if (head === l.to && l.number < doc.lines) return keep(doc.lineAt(l.to + 1).to);
        return keep(l.to);
      }

      case 'docStart':
        return keep(0);

      case 'docEnd':
        return keep(clamp(doc, doc.length));

      case 'lineUp':
        return vertical(doc, head, -1, keep, o.goal);

      case 'lineDown':
        return vertical(doc, head, 1, keep, o.goal);

      case 'pageUp':
        return vertical(doc, head, -Math.max(1, o.pageLines || 10), keep, o.goal);

      case 'pageDown':
        return vertical(doc, head, Math.max(1, o.pageLines || 10), keep, o.goal);

      case 'wordLeft':
        return keep(wordStop(doc, head, -1));

      case 'wordRight':
        return keep(wordStop(doc, head, 1));

      default:
        return null;
    }
  }

  /**
   * 上下移动：先记"目标列"（UTF-16 列，⛔ 不是像素），再落到目标行的 `min(goal, 行长)`。
   * ⚠️ 目标列**跨多次按键保持**（`goal` 由调用方带回来）——这是"上下穿过短行还能回原列"的关键。
   */
  function vertical(doc, head, delta, keep, goalIn) {
    const l = lineOf(doc, head);
    const goal = Number.isInteger(goalIn) ? goalIn : head - l.from;
    const target = l.number + delta;
    if (target < 1) return keep(0, goal);
    if (target > doc.lines) return keep(clamp(doc, doc.length), goal);
    const tl = doc.lineAt(lineFromNumber(doc, target));
    const col = Math.min(goal, tl.text.length);
    return keep(tl.from + col, goal);
  }

  /** 第 n 行（1-based）的起点偏移。⚠️ 只用于 `vertical`，⛔ 不用它算任何"行号 → 字节"。 */
  function lineFromNumber(doc, n) {
    // 适配器只承诺 `lineAt(pos)` ⇒ 从当前位置线性找（块视图只有一块，代价可接受）。
    let pos = 0;
    for (let i = 1; i < n; i++) {
      const l = doc.lineAt(pos);
      if (l.number >= n) return l.from;
      pos = l.to + 1;
      if (pos > doc.length) return doc.length;
    }
    return doc.lineAt(pos).from;
  }

  // ── 测量层（真 DOM；⛔ 纯逻辑测试不碰这一半）──────────────────────────

  /**
   * ⭐ **区间 → 视觉矩形**（`bugs/0043`）。
   *
   * ⚠️⚠️ 必须优先用**浏览器自己的**矩形（`Range.getClientRects`）：软换行、隐藏标记、
   *    双向文字都归它管。此前按"逻辑行 ＋ 两个端点"去推，端点落在不同视觉行时
   *    退化成一个 **4 px 方块** —— 屏幕上看着只选了一个字符，`⌘C` 出来是**一整段**。
   *
   * ⚠️ 兜底只画**两端同视觉行**的那一半，跨行**不画**：
   *    一条与实际区间无关的宽度比"少画"更容易让人误判（少画至少不会声称"只选了这么点"）。
   *    ⚠️ 正常跑不到这一条 —— 真机上 `domAtPos` ＋ `createRange` 必定可用。
   *
   * @param {{from:number, to:number}} r 半开区间
   * @param {object} geo `{textRects(from,to), coordsAtPos(pos,side), lineAt(pos)}`
   * @returns {Array<{left:number, top:number, w:number, h:number}>} 客户端坐标
   */
  function rectsFor(r, geo) {
    if (geo && typeof geo.textRects === 'function') {
      let got = null;
      try { got = geo.textRects(r.from, r.to); } catch (e) { got = null; }
      if (got && got.length) {
        const out = [];
        for (let i = 0; i < got.length; i++) {
          const q = got[i];
          // ⚠️ 零面积：折点 / 行尾处会给出，画出来是看不见却占位的线。
          if (!q || !(q.w > 0) || !(q.h > 0)) continue;
          out.push({ left: q.left, top: q.top, w: q.w, h: q.h });
        }
        if (out.length) return out;
      }
    }
    const out = [];
    if (!geo || typeof geo.coordsAtPos !== 'function' || typeof geo.lineAt !== 'function') return out;
    let pos = r.from;
    while (pos <= r.to) {
      const l = geo.lineAt(pos);
      const s = Math.max(pos, l.from);
      const e = Math.min(r.to, l.to);
      const a = geo.coordsAtPos(s, 1);
      const b = e > s ? geo.coordsAtPos(e, -1) : null;
      if (a && b && Math.abs(a.top - b.top) < 1) {
        out.push({ left: a.left, top: a.top, w: Math.max(1, b.left - a.left), h: a.bottom - a.top });
      }
      if (l.to >= r.to) break;
      pos = l.to + 1;
    }
    return out;
  }

  /**
   * 一帧一次地画光标与选区。
   *
   * @param {object} view CM6 `EditorView`
   * @param {object} CM6 `window.rmdCM6`（只用来判"是不是同一个实例"没用上，留着给调用方一致）
   * @returns {{destroy:function, refresh:function}}
   */
  function createLayer(view, CM6) {
    void CM6;
    const layer = document.createElement('div');
    layer.className = 'cm-rmd-selectionLayer';
    // ⚠️ 挂在 `scrollDOM` 内部（与 CM6 自己的 cursorLayer 同层）：坐标是**内容坐标**，
    //    挂在 `view.dom` 上就得再补 `scrollTop`/`scrollLeft` 的偏移，那一层最容易差一。
    const host = view.scrollDOM || view.dom;
    host.appendChild(layer);

    /**
     * 用 DOM Range 取**视觉矩形**（客户端坐标）。取不到 ⇒ `null`（⛔ 不猜）。
     * @param {number} from
     * @param {number} to
     * @returns {Array<{left:number, top:number, w:number, h:number}>|null}
     */
    function textRects(from, to) {
      const doc = view.dom && view.dom.ownerDocument;
      if (!doc || typeof doc.createRange !== 'function' || typeof view.domAtPos !== 'function') return null;
      try {
        const a = view.domAtPos(from);
        const b = view.domAtPos(to);
        const rng = doc.createRange();
        rng.setStart(a.node, a.offset);
        rng.setEnd(b.node, b.offset);
        const list = rng.getClientRects();
        const out = [];
        for (let i = 0; i < list.length; i++) {
          out.push({ left: list[i].left, top: list[i].top, w: list[i].width, h: list[i].height });
        }
        return out;
      } catch (e) {
        return null;
      }
    }

    /** ⭐ 只在 **read** 阶段量几何（`write` 阶段读布局会强制同步重排，那是每帧一次抖动）。 */
    function measure() {
      const sel = view.state.selection.main;
      const r = range({ anchor: sel.anchor, head: sel.head });
      const base = layer.getBoundingClientRect();

      if (r.from === r.to) {
        const c = view.coordsAtPos(sel.head, 1);
        if (c) return [{ caret: true, left: c.left - base.left, top: c.top - base.top, h: c.bottom - c.top }];
        return [];
      }
      const rects = rectsFor(r, {
        textRects: textRects,
        coordsAtPos: function (pos, side) { return view.coordsAtPos(pos, side); },
        lineAt: function (pos) { return view.state.doc.lineAt(pos); },
      });
      for (let i = 0; i < rects.length; i++) {
        rects[i].left -= base.left;
        rects[i].top -= base.top;
      }
      return rects;
    }

    function paint(rects) {
      layer.textContent = '';
      // ⚠️ `clientWidth` 每次 `paint()` 读一次：它是**这一层自己**的宽（＝格子内容宽），
      //    叶子里的行末位置正好压在它的右边界上（见 `夹回可见区` 的注释）。
      const 层宽 = layer.clientWidth || 0;
      for (let i = 0; i < rects.length; i++) {
        const q = rects[i];
        const d = document.createElement('div');
        d.className = q.caret ? 'cm-rmd-caret' : 'cm-rmd-selectionRange';
        let left = Math.round(q.left);
        // ⭐ 行末的光标会压在这一层的右边界上 ⇒ 被 `.cm-rmd-cell` 的 `overflow-x: clip`
        //    整个裁掉、屏幕上**一根都看不见**（`bugs/0085`）。只夹光标，⛔ 不动选区（它足够宽）。
        if (q.caret) left = 夹回可见区(left, 层宽, CARET_W);
        d.style.left = left + 'px';
        d.style.top = Math.round(q.top) + 'px';
        d.style.height = Math.round(q.h) + 'px';
        if (!q.caret) d.style.width = Math.round(q.w) + 'px';
        layer.appendChild(d);
      }
    }

    function schedule() {
      view.requestMeasure({ read: measure, write: paint });
    }

    const win = view.dom.ownerDocument.defaultView;
    win.addEventListener('resize', schedule);
    schedule();

    return {
      /** 文档/选区/几何变了 ⇒ 重画（`index.js` 在 `updateListener` 里调）。 */
      refresh: schedule,
      destroy: function () {
        win.removeEventListener('resize', schedule);
        if (layer.parentNode) layer.parentNode.removeChild(layer);
      },
    };
  }

  /**
   * 鼠标：点 / 拖 / 双击选词 / 三击选段。
   *
   * ⚠️⚠️ **必须 capture ＋ `preventDefault`**：CM6 自己的 `mousedown` handler 会
   * `view.focus()`（把焦点给 `contentDOM`）⇒ 正好破 `INV-LIVE-12`（组合串进 contenteditable）。
   *
   * ⚠️⚠️ **2026-10-28 补三条**（用户原话「文本选择功能极不顺畅」，`bugs/0031`）：
   *   ① 双击 / 三击之后**继续拖**要跟手（此前那两个分支直接 `return`，拖拽态根本没建立
   *      ⇒ 用户看到的是"双击选了个词，再拖就不动了"）；
   *   ② 拖到窗口上/下边缘要**自动滚动**（否则选一段超过一屏的文字时，光标走到屏幕边缘
   *      就再也不前进 —— 那也是"不顺畅"的一半）；
   *   ③ 双击后拖动按**词**扩展、三击后按**行**扩展（与原生选区的习惯一致），
   *      ⛔ 不是一律按字符。
   *
   * ⚠️ **⛔ 跨块选择仍然做不到**（每个块一个视图，`view.state.selection` 出不了这一块；
   *    `posAtCoords` 纵向越界是**钳制**，`cm6.bundle.js:7323-7326`）——
   *    那一条是 `0047` 的结构性后果，走 `design/0053`，⛔ 别在这里"顺手"打补丁。
   *
   * @param {object} view
   * @param {{onSelect:(sel:{anchor:number,head:number})=>void, focus:function,
   *          hitArea?:object|null,
   *          hidden?:{plan?:() => object|null, cellContext?:boolean},
   *          gesture?:{clientX:number, clientY:number, shiftKey:boolean, detail:number,
   *                    at:number, released:boolean}}} hooks
   *   `gesture` = 宿主替我们记下的那次按下（`bugs/0042`）：阅读态点一下就进编辑态时，
   *   真正的 `mousedown` 落在旧 DOM 上，本视图**收不到**；宿主把那一按连同坐标传进来，
   *   由 `moveHandler` 的续接分支接手，⛔ 否则第一次拖选整段丢失。
   *   ⭐ `released === true` 的那一类**不再丢弃**（`bugs/0333`）：松手早于视图就绪时拖拽
   *   确实不可能了，但**多击**（双击 = 词、三击 = 行）仍要落出那个选区——否则阅读态里
   *   双击一段文字只会得到"进去了、只有一个插入符"，用户拿不到那个词（引用/代码块尤其稳现，
   *   因为整块是一次更重的 `live.begin`）。
   *   `hitArea` = 按下的监听面（`bugs/0069`）：单元格形态传那一格的 `<td>`，
   *   让格内右侧空白（CM6 之外）也走"同步挪光标"，⛔ 不冒泡成一次新的进入。不传 ⇒ `view.dom`。
   *   `hidden` = 装饰层发布的隐藏区间（`design/0061` L2）：点击落点与拖选端点都过
   *   `snapCaret` / `snapRange`，⛔ 不停在看不见的标记里。
   * @returns {function} 卸除
   */
  function installMouse(view, hooks) {
    // ⭐ **按下的监听面**默认是 `view.dom`；单元格形态由 `main.js` 传 `hitArea`（那一格的 `<td>`）。
    //    ⚠️ 为什么格子要放宽到 `<td>`（`bugs/0069`）：格子里的内容只有文字那么宽，
    //    右侧一大片空白**属于 `<td>`、⛔ 不属于 CM6**。监听面只有 `view.dom` 时，
    //    那一片的 mousedown 会冒泡到 `#doc` 的 `onLiveDocDown`，被当成**一次新的进入**
    //    ⇒ `live.begin()` 走 `leave('switch')`：提交 ＋ 整篇重渲 ＋ 重新申请写授权 ＋ 换宿主，
    //    而光标落点要等重渲之后**重新**映射屏幕坐标 ⇒ 实测停在**最后一个字之前**
    //    （用户 2026-11-04：「行尾无法插入光标」「使用 → 无法走到行尾」）。
    //    放宽之后这一下就是一次**同步**的 `posAtCoords` ＋ 改选区：⛔ 没有 IPC、⛔ 没有重渲。
    const dom = (hooks && hooks.hitArea) || view.dom;
    let dragging = false;
    /** 这个视图**正在被拆掉**（`uninstall` 第一句就置上）：`up()` 里的多击落地据此让路。 */
    let 卸了 = false;
    /** 这一轮拖拽的**单位**：1 字符 / 2 词 / 3 行（双击后拖动按词，三击后按行）。 */
    let dragUnit = 1;
    /** 字符级拖拽的锚点。⚠️ ⛔ 不读 `view.state.selection`：反向拖时它自己会变。 */
    let dragAnchor = 0;
    /** 词 / 行单位拖拽的**初选区间**（`bugs/0044`）：往两侧扩展都以它为准。 */
    let dragBase = null;
    /** 最后一次 `mousemove` 的坐标：自动滚动每帧要用它重新换算位置。 */
    let dragEv = null;
    let scrollRaf = 0;
    /**
     * ⭐ **阅读态那一次按下**（`bugs/0042`）：`live.begin` 是异步的，那次 `mousedown`
     * 的事件路径早已走完 ⇒ 新视图的 `down()` 永远收不到它。
     * `main.js` 把 `{clientX, clientY, detail, shiftKey, at, released}` 带过来，
     * 由下面 `moveHandler` 的第一个 `mousemove` **接手**。
     */
    let pending = (hooks && hooks.gesture && hooks.gesture.released !== true) ? hooks.gesture : null;
    /**
     * ⭐ **松手早于视图就绪的多击手势**（`bugs/0333`）：`released === true` ⇒ 拖拽没得接，
     * 但双击/三击的"选一个词 / 一行"仍然要实现。⚠️ 与 `pending` 分开存：
     * `pending` 由**第一次 `mousemove`** 接手（要判 `buttons`），这一份由定时器**当场**落地
     * （此刻用户早就松手了，等不到也没必要等一个 `mousemove`）。
     */
    /** @type {null | {clientX:number, clientY:number, shiftKey:boolean, detail:number, at:number, released:boolean}} */
    let multiClick = null;
    /**
     * 多击落地的重试定时器（⚠️ 布局没就绪时重试，有界：25 × 16 ms）。
     * ⚠️ 类型取 `ReturnType<typeof setTimeout>`：浏览器里是 number，`@types/node` 在场时是
     * `Timeout`，写死 `number` 会过不了 `make typecheck`（`design/0052` U8）。
     * @type {ReturnType<typeof setTimeout> | 0}
     */
    let multiClickTimer = 0;
    let multiClickTries = 0;
    {
      const g = hooks && hooks.gesture;
      if (g && g.released === true && (g.detail || 1) >= 2) multiClick = g;
    }

    function posAt(ev) {
      // ⚠️ `posAtCoords` 有一次几何测量；失败返回 `null` ⇒ ⛔ 不改选区（不猜）。
      // ⚠️ 纵向越界时它是**钳制**到首/尾的（不是返回 `null`）⇒ 拖出块外只会停在边界，
      //    这一点由 `design/0053` 统一处理，⛔ 别在这里当成"没取到位置"。
      const p = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
      if (!Number.isInteger(p)) return null;
      // ⭐ 行尾的零宽尾巴必须与**首次点击**（`main.js::focusAt`）同一口径（`bugs/0094`）：
      //    编辑态内再次点击同一个视觉点时，`posAtCoords` 同样会取左边那个零宽边界，
      //    ⛔ 不能只让 `focusAt` 吸到行末，否则同一格点两次得到两个落点。
      const t = snapHiddenTail(view, p);
      // ⭐ 换算歪了就按**真实字形坐标**扳回最近的边界（`bugs/0084` 第三面）。
      const q = snapClickX(view, t, ev.clientX);
      // ⭐ 点在文字右边（格内右侧空白 / 行尾）⇒ 吸到行末（`bugs/0069`，同 `main.js::focusAt`）。
      // ⭐ 最后再过一次合法落点（`design/0061` L2）：零宽标记 / 围栏行上的点
      //    ⇒ 吸附到最近的可见边界，⛔ 不让光标停在看不见的字符里。
      return snapCaret(view, snapLineEnd(view, q, ev.clientX), 0, hooks && hooks.hidden);
    }

    function set(sel) {
      // ⭐ 拖选端点也过 `snapRange`（`design/0061` L2）：跨过围栏行 / 零宽标记时
      //    端点落在隐藏区间内部，看起来就像"选区多吞了一段空白"。
      view.dispatch({ selection: snapRange(view, sel, hooks && hooks.hidden) });
      if (hooks && hooks.onSelect) hooks.onSelect(view.state.selection.main);
    }

    /** 头部位置按**当前拖拽单位**吸附 —— 见 `dragRange`（支点是初选区间，⛔ 不是某一端）。 */
    function currentDrag(p) {
      const base = dragUnit === 1 ? { from: dragAnchor, to: dragAnchor } : dragBase;
      return dragRange(view.state.doc, dragUnit, base, p);
    }

    /**
     * ⭐ **点击单位表**：`detail >= 3` 整行 / `2` 词 / 其余给 `null`（字符位由调用方处理）。
     * ⚠️ 只有这一份：`startDrag`（真拖拽）与 `落多击`（松手早于视图就绪的多击，`bugs/0333`）
     *    都从这里取——两套单位表的后果是"双击选中什么取决于点从哪条路进来的"。
     * ⚠️ 词用 `wordAt`（点击命中词），⛔ 不是 `wordStop`（按词移动）——`bugs/0045`。
     * @param {{lineAt:(pos:number)=>object}} doc
     * @param {number} p0 按下的位置
     * @param {number} detail 点击次数
     * @returns {{from:number, to:number, unit:number}|null}
     */
    function clickRange(doc, p0, detail) {
      if (detail >= 3) {
        const l = doc.lineAt(p0);
        return { from: l.from, to: l.to, unit: 3 };
      }
      if (detail === 2) {
        const w = wordAt(doc, p0);
        return { from: w.from, to: w.to, unit: 2 };
      }
      return null;
    }

    /**
     * 建立一次拖拽态。⭐ `down()` 与"接过来的手势"**共用这一处**（⛔ 不各写一份单位表）。
     * @param {number} p0 按下的位置
     * @param {number} detail 点击次数（1 字符 / 2 词 / 3 行）
     * @param {{shiftKey?:boolean}} [opts]
     */
    function startDrag(p0, detail, opts) {
      const o = opts || {};
      const doc = view.state.doc;
      dragEv = null;
      const hit = clickRange(doc, p0, detail);
      if (hit) {
        dragBase = { from: hit.from, to: hit.to };
        dragUnit = hit.unit;
        set({ anchor: dragBase.from, head: dragBase.to });
      } else {
        dragBase = null;
        dragUnit = 1;
        dragAnchor = o.shiftKey === true ? view.state.selection.main.anchor : p0;
        set({ anchor: dragAnchor, head: p0 });
      }
      dragging = true;
    }

    /**
     * ⭐ 落地一次**已经松手**的多击（`bugs/0333`）：只改选区，⛔ **不建拖拽态**。
     *
     * ⚠️ 为什么不复用 `startDrag`：它会把 `dragging` 置 `true`，而这一路**没有按下**
     *    （用户两次点击都已经完成）⇒ 之后任何一次不带键的 `mousemove` 都会走
     *    `moveHandler` 的扩展分支，选区跟着鼠标乱长——那是另一种可见缺陷。
     * ⭐ 单位表与 `startDrag` 同一处（`clickRange`），⛔ 不另立一份。
     * @param {number} p0 按下的位置
     * @param {number} detail 点击次数
     */
    function 落多击(p0, detail) {
      const hit = clickRange(view.state.doc, p0, detail);
      if (hit) set({ anchor: hit.from, head: hit.to });
    }

    /**
     * ⭐ 把多击手势落到新视图上（`bugs/0333`）。⛔ 同步调用做不到：
     *    `installMouse` 跑在 `makeView` 里，而**定插入符的那一下**（`index.js` 的
     *    `view.focusAt(point)`）在 `makeView` **返回之后** ⇒ 当场改选区会被它覆盖。
     *    ⇒ 交给一次 `setTimeout(0)`，那时 `focusAt` 已经跑完、`readMeasured()` 也已经量过；
     *    布局还没就绪（`posAt` 给 `null`）就**有界重试**，⛔ 不无限挂着、⛔ 不猜一个位置。
     */
    function 接多击() {
      multiClickTimer = 0;
      if (!multiClick) return;
      // 用户早就松手了、块才建起来 ⇒ 作废（与 `moveHandler` 里 1500 ms 同一口径）。
      if (multiClick.at && Date.now() - multiClick.at > 1500) { multiClick = null; return; }
      try { if (typeof view.readMeasured === 'function') view.readMeasured(); } catch (e) { void e; }
      const p0 = posAt(multiClick);
      if (p0 !== null) {
        const g = multiClick;
        multiClick = null;
        落多击(p0, g.detail || 2);
        return;
      }
      if (++multiClickTries < 25) multiClickTimer = setTimeout(接多击, 16);
      else multiClick = null;
    }

    /**
     * 拖拽时的**滚动容器**：从宿主往上找第一个**真的在滚**的祖先；
     * 都没有就在 `body` / `documentElement` 里挑**可滚余量大**的那个。
     * ⚠️ 本仓库的正文滚的是 **`body`**（`style.css` 的 `html, body { height:100%; overflow-y:auto }`），
     *    而标准模式下 `document.scrollingElement` 是 **`<html>`** —— 它自己不溢出不滚，
     *    `scrollTop` 恒 0。2026-10-28 实测踩过：只看 `scrollingElement` 会得到"滚不动"，
     *    而屏幕上的真实滚动条在 `body` 上（`design/0052` U6 的 X 段也是同一条）。
     */
    function 滚动容器() {
      let el = dom.parentElement;
      while (el && el !== document.body && el !== document.documentElement) {
        const st = getComputedStyle(el);
        if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1) return el;
        el = el.parentElement;
      }
      let 最好 = null;
      const 候选 = [document.body, document.documentElement];
      for (let i = 0; i < 候选.length; i++) {
        const c = 候选[i];
        if (!c) continue;
        const 余 = c.scrollHeight - c.clientHeight;
        if (余 > 1 && (!最好 || 余 > 最好.余)) 最好 = { el: c, 余: 余 };
      }
      return 最好 ? 最好.el : (document.scrollingElement || document.body);
    }

    /**
     * 自动滚动：指针进入离窗口上/下边缘 `边` px 的带子 ⇒ 每帧把容器推一点，
     * **推完立刻按新的几何重算头部位置**（块在指针底下移动，位置才会继续前进）。
     * ⚠️ 只 `scrollTop`，⛔ 不碰视口 / 焦点 / `scrollIntoView`。
     */
    function 步进() {
      scrollRaf = 0;
      if (!dragging || !dragEv) return;
      const 边 = 28;
      const y = dragEv.clientY;
      const vh = window.innerHeight;
      let d = 0;
      if (y < 边) d = -Math.ceil((边 - y) / 2);
      else if (y > vh - 边) d = Math.ceil((y - (vh - 边)) / 2);
      if (d !== 0) {
        const c = 滚动容器();
        const 前 = c.scrollTop;
        c.scrollTop = 前 + d;
        if (c.scrollTop !== 前) {
          const p = posAt(dragEv);
          if (p !== null) set(currentDrag(p));
        }
      }
      scrollRaf = requestAnimationFrame(步进);
    }

    function down(ev) {
      if (ev.button !== 0) return;
      // ⚠️ 新的按下 ⇒ 上一份"待接手"的手势作废（⛔ 同一个视图里建两个拖拽态）。
      pending = null;
      // ⚠️ 同一条也管多击：用户已经在**这个**视图里重新按下了 ⇒ 那一击的落点由 `down()` 自己算。
      multiClick = null;
      if (multiClickTimer) { clearTimeout(multiClickTimer); multiClickTimer = 0; }
      const p = posAt(ev);
      if (p === null) return;
      // 拦住 CM6：它一 `focus()` 就把组合串交回浏览器。
      ev.preventDefault();
      ev.stopPropagation();
      if (hooks && hooks.focus) hooks.focus();
      startDrag(p, ev.detail || 1, { shiftKey: ev.shiftKey === true });
      dragEv = ev;
    }

    function moveHandler(ev) {
      if (!dragging) {
        // ⭐ **手势交接**（`bugs/0042`）：从阅读态那一次按下开始拖的，`mousedown` 打在
        //    `#doc` 上，而本视图是 `live.begin` 异步建出来的 —— 那次事件永远到不了 `down()`。
        //    这里用**第一次 `mousemove`** 接手：先按记下的坐标建拖拽态，再按本次 move 扩展。
        // ⛔ 不启动悬空拖动：`buttons` 已经放开 / 早松手（`released`）/ 超时 ⇒ 直接丢弃。
        if (!pending) return;
        if (ev.buttons !== undefined && (ev.buttons & 1) === 0) { pending = null; return; }
        if (pending.at && Date.now() - pending.at > 1500) { pending = null; return; }
        const p0 = posAt(pending);
        // ⚠️ 布局还没就绪（`posAtCoords` 拿不到整数）⇒ **保留记录**，下一次 move 再试。
        //    ⛔ 不回落成 0：那会把光标钉到段首，用户会以为整段被选中了。
        if (p0 === null) return;
        const g = pending;
        pending = null;
        startDrag(p0, g.detail || 1, { shiftKey: g.shiftKey === true });
      }
      const p = posAt(ev);
      if (p === null) return;
      ev.preventDefault();
      dragEv = ev;
      set(currentDrag(p));
      // ⚠️ 循环只在"滚动带"里真的动起来：`步进` 每帧自己判 `d`，不滚就空转一帧。
      if (!scrollRaf) scrollRaf = requestAnimationFrame(步进);
    }

    function up() {
      // ⭐ 松手这一刻才建好视图（`bugs/0333` 的第三种时序）：按下时是双击/三击的
      //    **第 N 下**（`detail >= 2`）、而从没有过 `mousemove` ⇒ 拖拽没得接手，
      //    但"选一个词 / 一行"仍然要实现。⛔ 不能只把 `pending` 丢掉：
      //    那一份手势只在 `mousemove` 上被接手，松手之后**不会再有** move 来了。
      const 没拖过 = !dragging;
      const 待落地 = pending;
      dragging = false;
      dragUnit = 1;
      dragBase = null;
      dragAnchor = 0;
      dragEv = null;
      pending = null;
      if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
      // ⚠️ 卸载（`uninstall` 会调这里）时⛔ 不往一个正在拆掉的视图里写选区。
      if (没拖过 && 待落地 && !卸了 && (待落地.detail || 1) >= 2) {
        if (待落地.at && Date.now() - 待落地.at > 1500) return;
        const p0 = posAt(待落地);
        // 布局还没就绪 ⇒ 交给 `接多击` 那套**有界重试**（同一条路，⛔ 不另写一份）。
        if (p0 !== null) 落多击(p0, 待落地.detail || 2);
        else multiClick = 待落地;
      }
    }

    dom.addEventListener('mousedown', down, true);
    dom.ownerDocument.addEventListener('mousemove', moveHandler, true);
    dom.ownerDocument.addEventListener('mouseup', up, true);
    // ⭐ 已松手的多击（`bugs/0333`）：等一拍再落（见 `接多击`——`focusAt` 还在后面跑）。
    if (multiClick) multiClickTimer = setTimeout(接多击, 0);

    return function uninstall() {
      卸了 = true;
      up();
      multiClick = null;
      if (multiClickTimer) { clearTimeout(multiClickTimer); multiClickTimer = 0; }
      dom.removeEventListener('mousedown', down, true);
      dom.ownerDocument.removeEventListener('mousemove', moveHandler, true);
      dom.ownerDocument.removeEventListener('mouseup', up, true);
    };
  }

  /**
   * ⭐ **点在文字右边 ⇒ 吸到行末**（`bugs/0069`）。
   *
   * ⚠️ 为什么需要：`posAtCoords` 是按 CM6 **自己的**行高/字宽表换算列宽的，
   *    刚 swap 那一帧（尤其单元格）那张表还是估值 ⇒ 换算结果可能少一个字符。
   *    用户看到的是"点了行尾，光标却停在最后一个字**之前**"，接着按 → 也只是在同一个
   *    位置打转（2026-11-04 原话：「行尾无法插入光标」「使用 → 无法走到行尾」）。
   * ⭐ 判"点是不是在文字右边"用**实时 DOM**（`contentDOM` 的矩形，`getBoundingClientRect`
   *    强制布局后是准的），⛔ 不用 CM6 的布局表。
   * ⚠️ 只吸到**那一行的行末**，⛔ 不跨行、⛔ 不改换行判定。
   *
   * @param {object} view CM6 视图
   * @param {number|null|undefined} pos `posAtCoords` 的结果（非整数 ⇒ 原样返回）
   * @param {number} x 视口坐标（`event.clientX`）
   * @returns {number|null|undefined}
   */
  function snapLineEnd(view, pos, x) {
    if (!Number.isInteger(pos)) return pos;
    if (!view || !view.state || !view.state.doc) return pos;
    const content = view.contentDOM;
    if (!content || typeof content.getBoundingClientRect !== 'function') return pos;
    if (typeof x !== 'number' || !isFinite(x)) return pos;
    const r = content.getBoundingClientRect();
    if (!r || typeof r.right !== 'number') return pos;
    if (!(x > r.right + 0.5)) return pos;
    return view.state.doc.lineAt(pos).to;
  }

  /**
   * ⭐ **行尾那些看不见的字符 ⇒ 光标吸到行末**（`bugs/0084` 的第二个面）。
   *
   * ⚠️ 为什么需要：阅读态把 Markdown 标记 `Decoration.replace` 成**零宽**，于是
   *    "最后一个可见字之后"与"闭合标记之后"在屏幕上是**同一个点**。CM6 的
   *    `posAtCoords` 走的是 DOM 边界 ⇒ 取**左边**那个（实测 ``中等长度的 `内容` ``：
   *    点最后一个字的右半得到 `9/10`）⇒ 光标停在「容」与「`」之间，行末永远差一步，
   *    用户看到的就是「无法移动到单元格文字末尾」（2026-11-04 第二次报）。
   * ⭐ 判据：`pos` 之后到**行末**的每个插入符坐标都与 `pos` **相同**（同 x 同 y）
   *    ⇒ 这一段在屏幕上根本不存在 ⇒ 取行末。
   * ⚠️⛔ **不能在中段往前推**：`**粗**` 两侧的零宽位置在语义上不是同一个落点
   *    （落在 `**` 里面打字会变成粗体），所以只认"一直到行末都一样"这一种。
   * ⚠️ 读不到坐标、或者下一个点的 `top` 变了（折行到下一视觉行）⇒ **原样返回**：
   *    宁可少吸一次，⛔ 不把光标推到别处。
   *
   * @param {object} view CM6 视图
   * @param {number|null|undefined} pos `posAtCoords` 的结果（非整数 ⇒ 原样返回）
   * @returns {number|null|undefined}
   */
  function snapHiddenTail(view, pos) {
    if (!Number.isInteger(pos)) return pos;
    if (!view || !view.state || !view.state.doc) return pos;
    if (typeof view.coordsAtPos !== 'function') return pos;
    const line = view.state.doc.lineAt(pos);
    if (pos >= line.to) return pos;
    const a = view.coordsAtPos(pos);
    if (!a || typeof a.left !== 'number' || typeof a.top !== 'number') return pos;
    let q = pos;
    while (q < line.to) {
      const b = view.coordsAtPos(q + 1);
      if (!b || typeof b.left !== 'number' || typeof b.top !== 'number') return pos;
      if (Math.abs(b.left - a.left) > 0.5 || Math.abs(b.top - a.top) > 0.5) return pos;
      q++;
    }
    return q;
  }

  /**
   * ⭐⭐ **点在哪，光标就落在最近的边界上**（`bugs/0084` 第三面，2026-11-05）。
   *
   * ⚠️ 为什么还要这一道：`posAtCoords` 的换算依赖 CM6 自己那张布局表，本仓实测到
   *    "同一个点、同一行、换算出来的列少了两个字符"——12 个字的格子里点在末字右沿，
   *    落点却是 **10/12**（按 12 px／字反推，它用的字宽约 **1.2 倍**）。用户看到的
   *    就是「光标无法触达这一行的末尾」，而按 → 也只是从同一个位置挪一格。
   * ⭐ 判据只用**真实字形坐标**：`coordsAtPos` 走的是 DOM Range，量的是真排出来的字。
   *    从 `pos` 出发，**相邻边界只要比当前这条离点更近就挪一格**；`top` 变了（跨视觉行）
   *    立刻停。⇒ 换算准的时候它一步都不动（恒等），换算歪的时候它把落点扳回来。
   * ⚠️ ⛔ 不跨视觉行：折行的段落里"点在第一行右边"就该落在第一行末，⛔ 不是整段末
   *    （整段末由 `snapLineEnd` 管，那条只在点越出内容框时生效）。
   * ⚠️ 零宽标记位（几个边界同一个 x）不会被它推开：距离不变 ⇒ 不走。
   * ⚠️ 走到行边界即止（`line.from` / `line.to`）：⛔ 不跨行，那是 `move` 的职责。
   *
   * @param {object} view CM6 视图
   * @param {number|null|undefined} pos `posAtCoords` 的结果（非整数 ⇒ 原样返回）
   * @param {number} x 视口坐标（`event.clientX`）
   * @returns {number|null|undefined}
   */
  function snapClickX(view, pos, x) {
    if (!Number.isInteger(pos)) return pos;
    if (!view || !view.state || !view.state.doc) return pos;
    if (typeof x !== 'number' || !isFinite(x)) return pos;
    if (typeof view.coordsAtPos !== 'function') return pos;
    const 取 = function (p, side) {
      try {
        const c = view.coordsAtPos(p, side);
        if (!c || typeof c.left !== 'number' || typeof c.top !== 'number') return null;
        return c;
      } catch (e) {
        return null;
      }
    };
    const line = view.state.doc.lineAt(pos);
    let 位 = pos;
    let 当前 = 取(pos, 1);
    if (!当前) return pos;
    const 距 = function (c) {
      return Math.abs(c.left - x);
    };
    // ⚠️ 每一步都必须**严格更近**且**同一视觉行** ⇒ 单调、必停；上界只是防意外。
    let 步 = 0;
    while (位 < line.to && 步 < 512) {
      const b = 取(位 + 1, 1);
      if (!b || Math.abs(b.top - 当前.top) > 1) break;
      if (!(距(b) + 0.01 < 距(当前))) break;
      位 += 1;
      当前 = b;
      步 += 1;
    }
    while (位 > line.from && 步 < 1024) {
      const b = 取(位 - 1, 1);
      if (!b || Math.abs(b.top - 当前.top) > 1) break;
      if (!(距(b) + 0.01 < 距(当前))) break;
      位 -= 1;
      当前 = b;
      步 += 1;
    }
    return 位;
  }

  const api = {
    range: range,
    charAt: charAt,
    wordStop: wordStop,
    wordAt: wordAt,
    graphemeBack: graphemeBack,
    graphemeForward: graphemeForward,
    dragRange: dragRange,
    rectsFor: rectsFor,
    snapLineEnd: snapLineEnd,
    snapHiddenTail: snapHiddenTail,
    snapClickX: snapClickX,
    // ⭐ `design/0061` L2：合法落点（纯函数 ＋ DOM 侧封装 ＋ 中央事务兜底）。
    legalEdge: legalEdge,
    legalNearest: legalNearest,
    hiddenRanges: hiddenRanges,
    legalRanges: legalRanges,
    // ⭐ `bugs/0087`：删除保护必须连**围栏行的换行**一起守住，⛔ 只给标记。
    protectedRanges: protectedRanges,
    // ⭐ `bugs/0111` A6：块前缀与成对行内标记分属两个集合（⛔ 不并成一条链）。
    prefixRanges: prefixRanges,
    // ⭐ `bugs/0111` K3：块前缀的**分层**视图（一次退格只退一层）。
    prefixLevels: prefixLevels,
    snapCaret: snapCaret,
    snapRange: snapRange,
    listContentStart: listContentStart,
    legalFilter: legalFilter,
    // ⭐ 行末光标被格子裁掉那一条（`bugs/0085`）：纯函数进导出面，宁可有判据。
    caretClamp: 夹回可见区,
    deleteRange: deleteRange,
    // ⭐ `bugs/0105`：行首标记链之后按回车时，插入点退到整链起点（⛔ 不劈开 `**`）。
    lineStartInsertPoint: lineStartInsertPoint,
    // ⭐ `bugs/0308`：行尾标记链之前按回车时，插入点挪到整链末尾（⛔ 不把闭合 `**` 劈到下一行）。
    lineEndInsertPoint: lineEndInsertPoint,
    // ⭐ `bugs/0313`：行首回车后光标停在插入的换行**之前**（⛔ 不落到新行行首、劈开标记）。
    caretAfterInsert: caretAfterInsert,
    move: move,
    createLayer: createLayer,
    installMouse: installMouse,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveSelection = api;
})();
