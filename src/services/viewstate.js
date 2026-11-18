// 阅读视图三件套的**纯逻辑**：行号映射、画布缩放档位 —— `design/0079`。
//
// ⚠️ 这一份**不碰 Tauri、不碰定时器、不写 `#doc` 之外的任何东西**：
//    行号的数据源是**后端块表**（`DocumentPayload.blocks`，经 `live/blocks.js` 解包与对齐），
//    ⛔ 本文件不解析 Markdown、⛔ 不按 DOM 结构猜源码行（`INV-SINGLE-01` / `INV-VIEW-01`）。
// ⚠️ `applyLineNumbers` 只写 `data-rmd-line` 与 `#doc` 的 class，⛔ 不插入文本节点、
//    ⛔ 不改块数（`INV-VIEW-03`：`live/blocks.js::topNodes` 的取法必须照样成立）。
// ⚠️ 仍是**经典脚本 + IIFE**（`frontend.md` 第 1、2 条）；`module.exports` 只为 Node 测试。
(function () {
  'use strict';

  /**
   * 画布缩放的**显式档位**（百分比，升序且唯一）。
   *
   * ⚠️ 档位是闭集：放大 / 缩小只在表里走下一档 / 上一档，⛔ 不做任意倍数。
   * ⚠️ 与字号（`reader.font-*`）是两条线：字号改 `--reader-font-size` 且落盘，
   *    这里改的是 `#doc` 的整体 `zoom`，只活在本会话（`design/0079` §2.4）。
   */
  const ZOOM_LEVELS = Object.freeze([50, 67, 80, 90, 100, 110, 125, 150, 175, 200]);

  /** 缩放下界（百分比）。 */
  const ZOOM_MIN = ZOOM_LEVELS[0];
  /** 缩放上界（百分比）。 */
  const ZOOM_MAX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  /** 「实际大小」对应的百分比。 */
  const ZOOM_ACTUAL = 100;

  /**
   * 把一个数夹到档位表里**最近的一档**。
   *
   * ⚠️ 输入非法（`NaN` / 字符串 / `undefined`）⇒ 回 `100`，⛔ 不抛：
   *    缩放是视图辅助，坏一个输入不该让整个挂载流程陪葬。
   * ⚠️ 平局取**较小**那一档（`67.5 → 67`），与"先缩后放不跳档"的直觉一致。
   */
  function normalizeZoom(n) {
    const v = Number(n);
    if (!isFinite(v)) return ZOOM_ACTUAL;
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
    let best = ZOOM_LEVELS[0];
    let bestGap = Math.abs(clamped - best);
    for (let i = 1; i < ZOOM_LEVELS.length; i++) {
      const gap = Math.abs(clamped - ZOOM_LEVELS[i]);
      if (gap < bestGap) {
        best = ZOOM_LEVELS[i];
        bestGap = gap;
      }
    }
    return best;
  }

  /**
   * 下一档 / 上一档。
   *
   * @param {number} current 当前百分比
   * @param {number} dir `> 0` 放大，`< 0` 缩小；`0` 原样
   * @returns {number} 新的百分比（到边界**停住**，⛔ 不循环、⛔ 不越界）
   */
  function zoomNext(current, dir) {
    const base = normalizeZoom(current);
    const d = Number(dir);
    if (!isFinite(d) || d === 0) return base;
    if (d > 0) {
      for (let i = 0; i < ZOOM_LEVELS.length; i++) {
        if (ZOOM_LEVELS[i] > base) return ZOOM_LEVELS[i];
      }
      return ZOOM_MAX;
    }
    for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
      if (ZOOM_LEVELS[i] < base) return ZOOM_LEVELS[i];
    }
    return ZOOM_MIN;
  }

  /** 百分比 → CSS `zoom` 的倍数（`100 → 1`）。 */
  function zoomScale(level) {
    return normalizeZoom(level) / 100;
  }

  /**
   * 从**已经对齐好的**块/节点对里算出"哪个节点标哪一行"。
   *
   * 规则（`design/0079` §2.1 那张表）：
   * - 只标**元素**节点（注释节点是块级原始 HTML 的占位，带不了属性）；
   * - 只标**顶层块首行**（`block.startLine`，1-based）；
   * - **脚注定义不标**：comrak 把全部定义合并到文末唯一的 `<section data-footnotes>`，
   *   那个节点不对应源码里的某一行；
   * - 顺序原样保留；坏输入跳过，⛔ 不抛。
   *
   * @param {Array} slots `live/blocks.js::align()` 返回的 `slots`（`{block,node}`）
   * @returns {Array<{node:any,line:number}>}
   */
  function linePlan(slots) {
    const out = [];
    const list = slots || [];
    for (let i = 0; i < list.length; i++) {
      const slot = list[i];
      if (!slot || !slot.block || !slot.node) continue;
      const node = slot.node;
      if (node.nodeType !== 1) continue;
      const block = slot.block;
      if (block.kind === 'FootnoteDefinition') continue;
      const line = block.startLine;
      if (!Number.isInteger(line) || line < 1) continue;
      out.push({ node: node, line: line });
    }
    return out;
  }

  /**
   * 开 / 关行号列。⭐ 只写属性与 `#doc` 的 class，⛔ 不动正文内容。
   *
   * @param {any} doc `#doc`（或测试里的同形假节点）
   * @param {Array} plan [`linePlan`] 的结果
   * @param {boolean} on 严格 `=== true` 才算开（与仓库里其余布尔口径一致）
   */
  function applyLineNumbers(doc, plan, on) {
    if (!doc) return;
    const want = on === true;
    if (doc.classList && typeof doc.classList.toggle === 'function') {
      doc.classList.toggle('doc-lines', want);
    }
    const list = plan || [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || !item.node || item.node.nodeType !== 1) continue;
      const node = item.node;
      if (want) {
        if (typeof node.setAttribute === 'function') {
          node.setAttribute('data-rmd-line', String(item.line));
        }
      } else if (typeof node.removeAttribute === 'function') {
        node.removeAttribute('data-rmd-line');
      }
    }
  }

  const api = {
    ZOOM_LEVELS: ZOOM_LEVELS,
    ZOOM_MIN: ZOOM_MIN,
    ZOOM_MAX: ZOOM_MAX,
    ZOOM_ACTUAL: ZOOM_ACTUAL,
    normalizeZoom: normalizeZoom,
    zoomNext: zoomNext,
    zoomScale: zoomScale,
    linePlan: linePlan,
    applyLineNumbers: applyLineNumbers,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).viewstate = api;
})();
