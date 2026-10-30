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
   * @param {{forward?:boolean, byWord?:boolean, byLine?:boolean}} [opts]
   * @returns {{from:number, to:number}} `from === to` ⇒ 没有可删的（调用方不必区分）
   */
  function deleteRange(doc, sel, opts) {
    const o = opts || {};
    const r = range(sel);
    if (r.from !== r.to) return { from: r.from, to: r.to };
    const head = r.from;
    if (o.byLine === true) {
      const l = doc.lineAt(head);
      if (o.forward !== true) return { from: l.from === head ? Math.max(0, head - 1) : l.from, to: head };
      return { from: head, to: l.to === head ? Math.min(doc.length, head + 1) : l.to };
    }
    if (o.byWord === true) {
      const a = wordStop(doc, head, o.forward === true ? 1 : -1);
      return { from: Math.min(a, head), to: Math.max(a, head) };
    }
    if (o.forward === true) return { from: head, to: graphemeForward(doc, head) };
    return { from: graphemeBack(doc, head), to: head };
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
      for (let i = 0; i < rects.length; i++) {
        const q = rects[i];
        const d = document.createElement('div');
        d.className = q.caret ? 'cm-rmd-caret' : 'cm-rmd-selectionRange';
        d.style.left = Math.round(q.left) + 'px';
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
   *          gesture?:{clientX:number, clientY:number, shiftKey:boolean, detail:number,
   *                    at:number, released:boolean}}} hooks
   *   `gesture` = 宿主替我们记下的那次按下（`bugs/0042`）：阅读态点一下就进编辑态时，
   *   真正的 `mousedown` 落在旧 DOM 上，本视图**收不到**；宿主把那一按连同坐标传进来，
   *   由 `moveHandler` 的续接分支接手，⛔ 否则第一次拖选整段丢失。
   * @returns {function} 卸除
   */
  function installMouse(view, hooks) {
    const dom = view.dom;
    let dragging = false;
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

    function posAt(ev) {
      // ⚠️ `posAtCoords` 有一次几何测量；失败返回 `null` ⇒ ⛔ 不改选区（不猜）。
      // ⚠️ 纵向越界时它是**钳制**到首/尾的（不是返回 `null`）⇒ 拖出块外只会停在边界，
      //    这一点由 `design/0053` 统一处理，⛔ 别在这里当成"没取到位置"。
      const p = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
      return Number.isInteger(p) ? p : null;
    }

    function set(sel) {
      view.dispatch({ selection: sel });
      if (hooks && hooks.onSelect) hooks.onSelect(view.state.selection.main);
    }

    /** 头部位置按**当前拖拽单位**吸附 —— 见 `dragRange`（支点是初选区间，⛔ 不是某一端）。 */
    function currentDrag(p) {
      const base = dragUnit === 1 ? { from: dragAnchor, to: dragAnchor } : dragBase;
      return dragRange(view.state.doc, dragUnit, base, p);
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
      if (detail >= 3) {
        const l = doc.lineAt(p0);
        dragBase = { from: l.from, to: l.to };
        dragUnit = 3;
        set({ anchor: dragBase.from, head: dragBase.to });
      } else if (detail === 2) {
        // ⚠️ 用 `wordAt`（点击命中词），⛔ 不是 `wordStop`（按词移动）——`bugs/0045`。
        const w = wordAt(doc, p0);
        dragBase = { from: w.from, to: w.to };
        dragUnit = 2;
        set({ anchor: w.from, head: w.to });
      } else {
        dragBase = null;
        dragUnit = 1;
        dragAnchor = o.shiftKey === true ? view.state.selection.main.anchor : p0;
        set({ anchor: dragAnchor, head: p0 });
      }
      dragging = true;
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
      dragging = false;
      dragUnit = 1;
      dragBase = null;
      dragAnchor = 0;
      dragEv = null;
      pending = null;
      if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
    }

    dom.addEventListener('mousedown', down, true);
    dom.ownerDocument.addEventListener('mousemove', moveHandler, true);
    dom.ownerDocument.addEventListener('mouseup', up, true);

    return function uninstall() {
      up();
      dom.removeEventListener('mousedown', down, true);
      dom.ownerDocument.removeEventListener('mousemove', moveHandler, true);
      dom.ownerDocument.removeEventListener('mouseup', up, true);
    };
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
    deleteRange: deleteRange,
    move: move,
    createLayer: createLayer,
    installMouse: installMouse,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveSelection = api;
})();
