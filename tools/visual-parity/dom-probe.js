/*!
 * tools/visual-parity/dom-probe.js
 *
 * 端侧对照的 rmd 侧 DOM 度量探针。注入页面后调用
 *     window.__PARITY_DOM.collect()
 * 返回一个可 JSON.stringify 的纯对象。
 *
 * 出处（唯一口径来源）：
 *   docs/design/0063-Mardo-端侧对照测试.md
 *     · §2.6「双路显示行模型（D1）」：rmd 侧 L2-DOM 的「显示行」= DOM 行盒数；
 *       对 .doc 内每个文本节点取 Range.getClientRects()，只保留 width > 0 的 rect，
 *       按 top 去重合并；块内空行（0 宽 rect）不计数。
 *     · §2.8「量法目录（M1–M8）」：M5 = L2-DOM 结构（getComputedStyle / 属性 / 标签序列），
 *       ROI 必须是 .doc 的 content box，⛔ 不是 getBoundingClientRect 的 border box。
 *     · §7.0 P-ENV-06：全文唯一做「DOM 行盒数 == 预期显示行」相等判定的地方。
 *
 * 硬约束（本文件自身）：
 *   1. 纯经典脚本 + IIFE。产品前端是经典脚本按顺序加载，本探针不引入 ES module。
 *   2. 只读 DOM / computed style，不写页面、不发事件、不联网。
 *   3. 所有几何量一律用 CSS px 原样输出，⛔ 不换算成 pt。
 *   4. 缺元素时给 null（不是 0），并在顶层 diagnostics 里说明缺什么。
 *   5. 每个量都带 source（computed style / getBoundingClientRect / Range），
 *      便于区分「浏览器默认值」与「产品样式」。
 *
 * 自检：见 tools/visual-parity/DOM-PROBE.md「自检」一节。
 */
(function (global) {
  'use strict';

  var SCHEMA = 'rmd-parity-dom-probe/1';
  var PROBE_VERSION = '1.0.0';

  /**
   * 全局行盒去重容差（CSS px）。
   * 同一视觉行上的多个文本节点，Range 给的 top 通常逐位相同；留 0.5 px
   * 是为了吸收 WKWebView / Chrome 的浮点抖动，避免把同一行算成两行。
   * ⚠️ 这不是「合并相邻行」的容差：正文行距按 14px × 1.6 ≈ 22.4px，量级相差 40 倍。
   */
  var DEFAULT_TOP_TOLERANCE_PX = 0.5;

  var SOURCE = {
    computed: 'computed style',
    rect: 'getBoundingClientRect',
    range: 'Range.getClientRects',
    client: 'clientWidth'
  };

  /* ────────────────────────────── 小工具 ────────────────────────────── */

  function toArray(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** 四舍五入到 4 位小数；非有限值 → null。 */
  function r4(v) {
    return isNum(v) ? Math.round(v * 10000) / 10000 : null;
  }

  /** 解析 "14px" / 14 / "14" → 数值；无法解析 → null。 */
  function parsePx(v) {
    if (v == null || v === '') return null;
    if (isNum(v)) return v;
    var n = parseFloat(String(v));
    return isFinite(n) ? n : null;
  }

  function pxR4(v) {
    var n = parsePx(v);
    return n == null ? null : r4(n);
  }

  /** computed line-height 可能是 "normal"：那不输出 0，输出 null + 诊断。 */
  function lineHeightPx(cs) {
    if (!cs || !cs.lineHeight || cs.lineHeight === 'normal') return null;
    return pxR4(cs.lineHeight);
  }

  function rectOf(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    var r = el.getBoundingClientRect();
    return {
      top: r4(r.top),
      left: r4(r.left),
      right: r4(r.right),
      bottom: r4(r.bottom),
      width: r4(r.width),
      height: r4(r.height)
    };
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function classesOf(el) {
    if (!el) return [];
    var c = el.className;
    if (typeof c === 'string') {
      return c.trim().split(/\s+/).filter(function (x) { return !!x; });
    }
    // SVG 元素的 className 是 SVGAnimatedString
    if (c && typeof c.baseVal === 'string') {
      return c.baseVal.trim().split(/\s+/).filter(function (x) { return !!x; });
    }
    return [];
  }

  /**
   * 生成便于定位的路径，例如
   *   .doc > ul:nth-of-type(2) > li:nth-of-type(3) > p
   * 同名兄弟只有一个时不加 nth-of-type。
   */
  function pathOf(el, doc) {
    var parts = [];
    var cur = el;
    var guard = 0;
    while (cur && cur.nodeType === 1 && cur !== doc && guard++ < 64) {
      var tag = cur.tagName ? cur.tagName.toLowerCase() : '?';
      var cls = classesOf(cur);
      if (cls.length) tag += '.' + cls.join('.');
      var parent = cur.parentElement;
      if (parent) {
        var same = 0;
        var idx = 0;
        for (var i = 0; i < parent.children.length; i++) {
          var c = parent.children[i];
          if (c.tagName === cur.tagName) {
            same++;
            if (c === cur) idx = same;
          }
        }
        if (same > 1) tag += ':nth-of-type(' + idx + ')';
      }
      parts.unshift(tag);
      cur = parent;
    }
    return '.doc' + (parts.length ? ' > ' + parts.join(' > ') : '');
  }

  function median(nums) {
    if (!nums.length) return null;
    var a = nums.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function diag(diagnostics, code, category, message) {
    diagnostics.push({ code: code, category: category, message: message });
  }

  /** computed display 是否形成「块」——用于把文本节点归到最近的块容器。 */
  function isBlockDisplay(display) {
    return (
      display === 'block' ||
      display === 'flow-root' ||
      display === 'list-item' ||
      display === 'inline-block' ||
      display === 'table' ||
      display === 'table-row' ||
      display === 'table-row-group' ||
      display === 'table-header-group' ||
      display === 'table-footer-group' ||
      display === 'table-cell' ||
      display === 'table-caption' ||
      display === 'flex' ||
      display === 'grid'
    );
  }

  /**
   * 对一个元素的内容取 Range.getClientRects()，返回并集（墨迹盒）。
   * ⭐ 只保留 width > 0 的 rect —— 与 §2.6 的行盒口径同一条规则。
   */
  function rangeInkOf(el) {
    if (!el) return null;
    var rects;
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      rects = range.getClientRects();
      if (range.detach) range.detach();
    } catch (e) {
      return null;
    }
    var top = Infinity;
    var left = Infinity;
    var right = -Infinity;
    var bottom = -Infinity;
    var used = 0;
    var zero = 0;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (!(r.width > 0)) {
        zero++;
        continue;
      }
      used++;
      if (r.top < top) top = r.top;
      if (r.left < left) left = r.left;
      if (r.right > right) right = r.right;
      if (r.bottom > bottom) bottom = r.bottom;
    }
    if (!used) {
      return {
        top: null, left: null, right: null, bottom: null,
        width: null, height: null,
        rect_count: 0, zero_width_rects: zero,
        source: SOURCE.range
      };
    }
    return {
      top: r4(top),
      left: r4(left),
      right: r4(right),
      bottom: r4(bottom),
      width: r4(right - left),
      height: r4(bottom - top),
      rect_count: used,
      zero_width_rects: zero,
      source: SOURCE.range
    };
  }

  /* ─────────────────────────── 环境三字段 ─────────────────────────── */

  /**
   * §2.8 / §7.1：字号、行高、正文内容列宽。
   * ⛔ content box 用 clientWidth − paddingLeft − paddingRight；⛔ 不用 border box。
   */
  function readEnv(doc) {
    var cs = global.getComputedStyle(doc);
    var rect = doc.getBoundingClientRect();
    var padL = pxR4(cs.paddingLeft);
    var padR = pxR4(cs.paddingRight);
    var padT = pxR4(cs.paddingTop);
    var padB = pxR4(cs.paddingBottom);
    var borL = pxR4(cs.borderLeftWidth);
    var borR = pxR4(cs.borderRightWidth);
    var borT = pxR4(cs.borderTopWidth);
    var borB = pxR4(cs.borderBottomWidth);
    var clientW = typeof doc.clientWidth === 'number' ? doc.clientWidth : null;

    var contentW = null;
    if (clientW != null && padL != null && padR != null) contentW = clientW - padL - padR;

    // 交叉核对用（⛔ 不是主口径）：rect 是 border box，要再减边框与内边距。
    var contentCross = null;
    if (rect.width != null && borL != null && borR != null && padL != null && padR != null) {
      contentCross = rect.width - borL - borR - padL - padR;
    }

    var contentLeft = null;
    if (rect.left != null && borL != null && padL != null) contentLeft = rect.left + borL + padL;
    var contentRight = null;
    if (rect.right != null && borR != null && padR != null) contentRight = rect.right - borR - padR;

    // §2.8 M1 的 ROI 是 `.doc` 的 content box，纵向同样要用 content box 上下沿；
    // 只给 left/right 会让取像把画布上方的界面文字并进正文行带（bug 0165）。
    var contentTop = null;
    if (rect.top != null && borT != null && padT != null) contentTop = rect.top + borT + padT;
    var contentBottom = null;
    if (rect.bottom != null && borB != null && padB != null) contentBottom = rect.bottom - borB - padB;

    return {
      font_size_px: pxR4(cs.fontSize),
      line_height_px: lineHeightPx(cs),
      line_height_raw: cs.lineHeight || null,
      content_box_width_px: r4(contentW),
      client_width_px: clientW,
      padding_left_px: padL,
      padding_right_px: padR,
      padding_top_px: padT,
      padding_bottom_px: padB,
      border_left_px: borL,
      border_right_px: borR,
      border_box_width_px: r4(rect.width),
      content_box_crosscheck_px: r4(contentCross),
      content_box_left_px: r4(contentLeft),
      content_box_right_px: r4(contentRight),
      content_box_top_px: r4(contentTop),
      content_box_bottom_px: r4(contentBottom),
      border_top_px: borT,
      border_bottom_px: borB,
      source: {
        font_size_px: SOURCE.computed,
        line_height_px: SOURCE.computed,
        line_height_raw: SOURCE.computed,
        content_box_width_px: 'clientWidth − paddingLeft − paddingRight（computed style）',
        client_width_px: SOURCE.client,
        padding_left_px: SOURCE.computed,
        padding_right_px: SOURCE.computed,
        padding_top_px: SOURCE.computed,
        padding_bottom_px: SOURCE.computed,
        border_left_px: SOURCE.computed,
        border_right_px: SOURCE.computed,
        border_box_width_px: SOURCE.rect,
        content_box_crosscheck_px: SOURCE.rect + ' − borderLeft − borderRight − paddingLeft − paddingRight',
        content_box_left_px: SOURCE.rect + '.left + borderLeft + paddingLeft',
        content_box_right_px: SOURCE.rect + '.right − borderRight − paddingRight',
        content_box_top_px: SOURCE.rect + '.top + borderTop + paddingTop',
        content_box_bottom_px: SOURCE.rect + '.bottom − borderBottom − paddingBottom',
        border_top_px: SOURCE.computed,
        border_bottom_px: SOURCE.computed
      }
    };
  }

  /* ───────────────────── DOM 行盒数（P-ENV-06 唯一口径） ───────────────────── */

  /**
   * 按 top 去重合并 rect 列表。返回「行盒」数组（内部还带 _top 锚点）。
   * ⚠️ 合并只按 top；left/right/bottom 取并集（同一行上的多个文本节点）。
   */
  function dedupeByTop(rects, tol) {
    var sorted = rects.slice().sort(function (a, b) {
      return (a.top - b.top) || (a.left - b.left);
    });
    var lines = [];
    var last = null;
    for (var i = 0; i < sorted.length; i++) {
      var r = sorted[i];
      if (last && Math.abs(r.top - last._top) <= tol) {
        if (r.bottom > last.bottom) last.bottom = r.bottom;
        if (r.left < last.left) last.left = r.left;
        if (r.right > last.right) last.right = r.right;
        last.rect_count += 1;
        if (last.blocks) {
          var seen = false;
          for (var b = 0; b < last.blocks.length; b++) {
            if (last.blocks[b] === r.blockIndex) {
              seen = true;
              break;
            }
          }
          if (!seen) last.blocks.push(r.blockIndex);
        }
      } else {
        last = {
          _top: r.top, // 合并锚点：该行盒第一条 rect 的 top（不序列化）
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          rect_count: 1,
          blocks: typeof r.blockIndex === 'number' ? [r.blockIndex] : null
        };
        lines.push(last);
      }
      last.height = last.bottom - last.top;
      last.width = last.right - last.left;
    }
    return lines;
  }

  function serializeLine(l, withBlocks) {
    var o = {
      top: r4(l.top),
      bottom: r4(l.bottom),
      left: r4(l.left),
      right: r4(l.right),
      width: r4(l.width),
      height: r4(l.height),
      rect_count: l.rect_count
    };
    if (withBlocks) o.blocks = l.blocks ? l.blocks.slice() : null;
    return o;
  }

  /**
   * §2.6 的 rmd 侧「DOM 行盒数」。
   *   ① TreeWalker 遍历 .doc 内每个文本节点；
   *   ② Range.selectNodeContents(text).getClientRects()；
   *   ③ 只保留 width > 0 的 rect（块内空行 / 纯空白 → 0 宽 → 不计数）；
   *   ④ 按 top 去重合并（容差见 DEFAULT_TOP_TOLERANCE_PX）。
   * 同时给「按块分组」的明细：最近块容器 = 文本节点向上第一个 block-ish 元素。
   */
  function collectLineBoxes(doc, tol, diagnostics) {
    var blockDisplayCache = typeof Map === 'function' ? new Map() : null;

    function displayOf(el) {
      if (!el) return null;
      if (blockDisplayCache && blockDisplayCache.has(el)) return blockDisplayCache.get(el);
      var d = global.getComputedStyle(el).display;
      if (blockDisplayCache) blockDisplayCache.set(el, d);
      return d;
    }

    function nearestBlockElement(el) {
      var cur = el;
      var guard = 0;
      while (cur && cur !== doc && cur.nodeType === 1 && guard++ < 64) {
        if (isBlockDisplay(displayOf(cur))) return cur;
        cur = cur.parentElement;
      }
      return doc;
    }

    var blocks = [];
    var blockEls = [];
    var blockRecords = typeof Map === 'function' ? new Map() : null;

    function recordFor(el) {
      if (blockRecords) {
        var hit = blockRecords.get(el);
        if (hit) return hit;
      }
      var rec = { el: el, index: blocks.length, rects: [] };
      blocks.push(rec);
      blockEls.push(el);
      if (blockRecords) blockRecords.set(el, rec);
      return rec;
    }

    var walker = document.createTreeWalker(
      doc,
      (global.NodeFilter && global.NodeFilter.SHOW_TEXT) || 4,
      {
        acceptNode: function (node) {
          var p = node.parentElement;
          if (!p) return (global.NodeFilter && global.NodeFilter.FILTER_REJECT) || 2;
          var tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT') {
            return (global.NodeFilter && global.NodeFilter.FILTER_REJECT) || 2;
          }
          if (!node.nodeValue || node.nodeValue.length === 0) {
            return (global.NodeFilter && global.NodeFilter.FILTER_REJECT) || 2;
          }
          return (global.NodeFilter && global.NodeFilter.FILTER_ACCEPT) || 1;
        }
      },
      false
    );

    var textNodeCount = 0;
    var rectCountTotal = 0;
    var zeroWidthRectCount = 0;
    var allRects = [];
    var node;

    while ((node = walker.nextNode())) {
      textNodeCount++;
      var rects;
      try {
        var range = document.createRange();
        range.selectNodeContents(node);
        rects = range.getClientRects();
        if (range.detach) range.detach();
      } catch (e) {
        rects = [];
      }
      // ⚠️ 先筛出 width > 0 的 rect，再登记块：否则块间的纯空白文本节点
      //    会造出一堆 count = 0 的空块（.doc / ul / table 等），只增噪声。
      var qualifying = [];
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        rectCountTotal++;
        if (!(r.width > 0)) {
          zeroWidthRectCount++;
          continue;
        }
        qualifying.push(r);
      }
      if (!qualifying.length) continue;

      var rec = recordFor(nearestBlockElement(node.parentElement));
      for (var j = 0; j < qualifying.length; j++) {
        var qr = qualifying[j];
        rec.rects.push({
          top: qr.top,
          bottom: qr.bottom,
          left: qr.left,
          right: qr.right,
          width: qr.width,
          height: qr.height,
          text_length: node.nodeValue.length
        });
        allRects.push({
          top: qr.top,
          bottom: qr.bottom,
          left: qr.left,
          right: qr.right,
          width: qr.width,
          height: qr.height,
          blockIndex: rec.index
        });
      }
    }

    var globalLines = dedupeByTop(allRects, tol);
    var byBlockSum = 0;
    var byBlock = [];
    for (var bi = 0; bi < blocks.length; bi++) {
      var brec = blocks[bi];
      var blines = dedupeByTop(brec.rects, tol);
      byBlockSum += blines.length;
      byBlock.push({
        index: brec.index,
        top_level_index: topLevelIndexOf(brec.el, doc),
        tag: brec.el.tagName ? brec.el.tagName.toLowerCase() : null,
        classes: classesOf(brec.el),
        display: displayOf(brec.el),
        path: pathOf(brec.el, doc),
        count: blines.length,
        lines: blines.map(function (l) { return serializeLine(l, false); })
      });
    }

    if (globalLines.length === 0) {
      diag(diagnostics, 'no-line-boxes', 'line_boxes',
        '.doc 里没有宽度 > 0 的文本 rect；页面可能还没挂正文，或正文为空态');
    }

    return {
      count: globalLines.length,
      // 字段名对齐 fixtures-expect.json 的 dom_line_boxes；与 count 是同一个数。
      dom_line_boxes: globalLines.length,
      method: 'Range.getClientRects() 逐个文本节点；只保留 width > 0；按 top 去重合并',
      top_tolerance_px: tol,
      source: SOURCE.range,
      text_node_count: textNodeCount,
      rect_count_total: rectCountTotal,
      zero_width_rects: zeroWidthRectCount,
      by_block_sum: byBlockSum,
      lines: globalLines.map(function (l) { return serializeLine(l, true); }),
      by_block: byBlock
    };
  }

  function topLevelIndexOf(el, doc) {
    var cur = el;
    var guard = 0;
    while (cur && cur.parentElement && cur.parentElement !== doc && guard++ < 64) {
      cur = cur.parentElement;
    }
    if (!cur || cur === doc) return null;
    var kids = doc.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] === cur) return i;
    }
    return null;
  }

  /* ────────────────────────────── 标题 ────────────────────────────── */

  function headingInfo(el, level, index, doc) {
    var cs = global.getComputedStyle(el);
    return {
      index: index,
      level: level,
      text: truncate(el.textContent, 160),
      path: pathOf(el, doc),
      font_size_px: pxR4(cs.fontSize),
      line_height_px: lineHeightPx(cs),
      line_height_raw: cs.lineHeight || null,
      font_weight: cs.fontWeight || null,
      ink: rangeInkOf(el),
      box: rectOf(el),
      margin_top_px: pxR4(cs.marginTop),
      margin_bottom_px: pxR4(cs.marginBottom),
      source: {
        font_size_px: SOURCE.computed,
        line_height_px: SOURCE.computed,
        font_weight: SOURCE.computed,
        'ink.*': SOURCE.range,
        'box.*': SOURCE.rect,
        margin_top_px: SOURCE.computed,
        margin_bottom_px: SOURCE.computed
      }
    };
  }

  function collectHeadings(doc, diagnostics) {
    var out = {};
    for (var level = 1; level <= 6; level++) {
      var tag = 'h' + level;
      var els = toArray(doc.querySelectorAll(tag));
      if (!els.length) {
        out[tag] = null;
        diag(diagnostics, 'missing-element', 'headings.' + tag, '.doc 内没有 <' + tag + '>');
        continue;
      }
      out[tag] = els.map(function (el, i) { return headingInfo(el, level, i, doc); });
    }
    return out;
  }

  /* ────────────────────────────── 列表 ────────────────────────────── */

  function ancestorListCount(el, doc) {
    var n = 0;
    var cur = el.parentElement;
    var guard = 0;
    while (cur && cur !== doc && guard++ < 64) {
      var t = cur.tagName;
      if (t === 'UL' || t === 'OL') n++;
      cur = cur.parentElement;
    }
    return n;
  }

  function collectLists(doc, contentLeft, diagnostics) {
    var items = toArray(doc.querySelectorAll('li'));
    if (!items.length) {
      diag(diagnostics, 'missing-element', 'lists', '.doc 内没有 <li>');
      return null;
    }
    var rows = items.map(function (el, i) {
      var cs = global.getComputedStyle(el);
      var rect = rectOf(el);
      var indent = (rect && rect.left != null && contentLeft != null) ? rect.left - contentLeft : null;
      return {
        index: i,
        level: ancestorListCount(el, doc),
        path: pathOf(el, doc),
        parent_list_tag: el.parentElement && el.parentElement.tagName
          ? el.parentElement.tagName.toLowerCase() : null,
        list_style_type: cs.listStyleType || null,
        rect: rect,
        indent_px: r4(indent),
        source: {
          'rect.left': SOURCE.rect,
          indent_px: SOURCE.rect + ' − .doc content box 左缘',
          list_style_type: SOURCE.computed
        }
      };
    });

    // 逐层汇总：同一层级的缩进应当一致。
    var byLevel = {};
    for (var i = 0; i < rows.length; i++) {
      var lv = rows[i].level;
      if (!byLevel[lv]) byLevel[lv] = [];
      if (rows[i].indent_px != null) byLevel[lv].push(rows[i].indent_px);
    }
    var levels = Object.keys(byLevel).map(function (k) {
      var arr = byLevel[k];
      return {
        level: Number(k),
        count: arr.length,
        indent_px_min: arr.length ? r4(Math.min.apply(null, arr)) : null,
        indent_px_max: arr.length ? r4(Math.max.apply(null, arr)) : null,
        indent_px_median: r4(median(arr))
      };
    }).sort(function (a, b) { return a.level - b.level; });

    return {
      count: rows.length,
      items: rows,
      levels: levels,
      reference: '缩进 = li.getBoundingClientRect().left − .doc content box 左缘（CSS px）',
      source: {
        items: 'getBoundingClientRect + computed style',
        levels: '由 items[].indent_px 汇总'
      }
    };
  }

  /* ────────────────────────────── 引用块 ────────────────────────────── */

  function readPseudo(el, which) {
    var cs;
    try {
      cs = global.getComputedStyle(el, which);
    } catch (e) {
      return null;
    }
    if (!cs) return null;
    var content = cs.content;
    var rendered = !(content === 'none' || content === 'normal' || content === '');
    return {
      content: content || null,
      display: cs.display || null,
      rendered: rendered,
      width_px: pxR4(cs.width),
      height_px: pxR4(cs.height),
      source: SOURCE.computed
    };
  }

  function collectBlockquotes(doc, diagnostics) {
    var els = toArray(doc.querySelectorAll('blockquote'));
    if (!els.length) {
      diag(diagnostics, 'missing-element', 'blockquotes', '.doc 内没有 <blockquote>');
      return null;
    }
    var items = els.map(function (el, i) {
      var cs = global.getComputedStyle(el);
      var borderWidth = pxR4(cs.borderLeftWidth);
      var pseudo = readPseudo(el, '::before');
      // 产品当前用 border-left 画引用条；若某天改成伪元素，这里也能读到。
      var effective = null;
      if (borderWidth != null && borderWidth > 0) effective = borderWidth;
      else if (pseudo && pseudo.rendered && pseudo.width_px != null) effective = pseudo.width_px;
      var depth = 0;
      var cur = el.parentElement;
      while (cur && cur !== doc) {
        if (cur.tagName === 'BLOCKQUOTE') depth++;
        cur = cur.parentElement;
      }
      var brect = rectOf(el);
      // bug 0163：`IND_quote` = 引用**内容**左缘 − 正文左缘；只给 padding-left
      // 会漏掉引用条本身。这里同时给出条色与内容左缘，供 l2-run 按设计取量。
      var contentLeft = null;
      if (brect && brect.left != null && borderWidth != null && cs.paddingLeft != null) {
        var padL = pxR4(cs.paddingLeft);
        if (padL != null) contentLeft = brect.left + borderWidth + padL;
      }
      return {
        index: i,
        path: pathOf(el, doc),
        depth: depth,
        bar: {
          effective_width_px: effective,
          border_left_width_px: borderWidth,
          border_left_style: cs.borderLeftStyle || null,
          border_left_color: cs.borderLeftColor || null,
          pseudo_before: pseudo
        },
        background_color: cs.backgroundColor || null,
        color: cs.color || null,
        padding_left_px: pxR4(cs.paddingLeft),
        padding_right_px: pxR4(cs.paddingRight),
        content_left_px: r4(contentLeft),
        line_height_px: lineHeightPx(cs),
        rect: brect,
        source: {
          'bar.border_left_width_px': SOURCE.computed,
          'bar.border_left_color': SOURCE.computed,
          'bar.pseudo_before': SOURCE.computed,
          background_color: SOURCE.computed,
          color: SOURCE.computed,
          padding_left_px: SOURCE.computed,
          padding_right_px: SOURCE.computed,
          content_left_px: SOURCE.rect + '.left + borderLeftWidth + paddingLeft',
          line_height_px: SOURCE.computed,
          rect: SOURCE.rect
        }
      };
    });
    return { count: items.length, items: items };
  }

  /* ────────────────────────────── 代码块 ────────────────────────────── */

  function collectCodeBlocks(doc, diagnostics) {
    var pres = toArray(doc.querySelectorAll('pre'));
    if (!pres.length) {
      diag(diagnostics, 'missing-element', 'code_blocks', '.doc 内没有 <pre>');
      return null;
    }
    var items = pres.map(function (pre, i) {
      var preCs = global.getComputedStyle(pre);
      var code = pre.querySelector('code');
      var codeCs = code ? global.getComputedStyle(code) : null;
      var cs = codeCs || preCs; // 字号 / 行高住内层 code（见 typography.css）
      return {
        index: i,
        path: pathOf(pre, doc),
        pre_padding: {
          top: pxR4(preCs.paddingTop),
          right: pxR4(preCs.paddingRight),
          bottom: pxR4(preCs.paddingBottom),
          left: pxR4(preCs.paddingLeft)
        },
        code_padding: codeCs ? {
          top: pxR4(codeCs.paddingTop),
          right: pxR4(codeCs.paddingRight),
          bottom: pxR4(codeCs.paddingBottom),
          left: pxR4(codeCs.paddingLeft)
        } : null,
        font_size_px: pxR4(cs.fontSize),
        line_height_px: lineHeightPx(cs),
        line_height_raw: cs.lineHeight || null,
        font_family: cs.fontFamily || null,
        white_space: preCs.whiteSpace || null,
        // bug 0163/0167：`PAD_code` 要「底色上边」而不是 padding-top；
        // 底色与文字色也是 `C_*` 观测量。像素侧再拿 `background_top_px` 与首行墨迹上沿相减。
        background_color: preCs.backgroundColor || null,
        color: cs.color || null,
        background_top_px: preCs.borderTopWidth != null
          ? r4((rectOf(pre) || {}).top + (pxR4(preCs.borderTopWidth) || 0))
          : null,
        pre_rect: rectOf(pre),
        code_rect: code ? rectOf(code) : null,
        source: {
          'pre_padding.*': SOURCE.computed,
          'code_padding.*': SOURCE.computed,
          font_size_px: SOURCE.computed,
          line_height_px: SOURCE.computed,
          white_space: SOURCE.computed,
          background_color: SOURCE.computed,
          color: SOURCE.computed,
          background_top_px: SOURCE.rect + '.top + borderTopWidth',
          pre_rect: SOURCE.rect,
          code_rect: SOURCE.rect
        }
      };
    });
    return { count: items.length, items: items };
  }

  /* ────────────────────────────── 表格 ────────────────────────────── */

  function tableInfo(table, index, doc) {
    var rows = table.rows ? toArray(table.rows) : toArray(table.querySelectorAll('tr'));
    var colCount = 0;
    for (var i = 0; i < rows.length; i++) {
      var n = rows[i].cells ? rows[i].cells.length : rows[i].querySelectorAll('th,td').length;
      if (n > colCount) colCount = n;
    }

    var headerRow = null;
    if (table.tHead && table.tHead.rows && table.tHead.rows.length) {
      headerRow = table.tHead.rows[0];
    }
    if (!headerRow) {
      for (var ri = 0; ri < rows.length; ri++) {
        if (rows[ri].querySelector && rows[ri].querySelector('th')) {
          headerRow = rows[ri];
          break;
        }
      }
    }
    var measureRow = headerRow || rows[0] || null;
    var cells = measureRow && measureRow.cells
      ? toArray(measureRow.cells)
      : (measureRow ? toArray(measureRow.querySelectorAll('th,td')) : []);

    var widths = [];
    var sum = 0;
    for (var ci = 0; ci < cells.length; ci++) {
      var w = cells[ci].getBoundingClientRect().width;
      widths.push(w);
      sum += w;
    }
    var columns = cells.map(function (cell, j) {
      return {
        index: j,
        width_px: r4(widths[j]),
        ratio: sum > 0 ? r4(widths[j] / sum) : null,
        // bug 0137：§2.2 `W_tblcol` 的定义是「列 1 为 1」的比值，
        // 不是 w_i / Σw。两种都给，采集侧不改判据语义。
        ratio_to_first: widths.length && widths[0] > 0 ? r4(widths[j] / widths[0]) : null,
        header_text: truncate(cell.textContent, 80),
        colspan: typeof cell.colSpan === 'number' ? cell.colSpan : null,
        source: SOURCE.rect
      };
    });

    // bug 0169：§2.2 的 `H_table` 是**数据行**高（设计 L321），表头行高另算。
    var dataRows = rows.filter(function (row) { return row !== headerRow; });
    var dataHeights = dataRows.map(function (row) {
      return r4(row.getBoundingClientRect().height);
    }).filter(function (h) { return h != null; });

    // bug 0169：`P-TBL-02-SPEC` 要 `th` 的计算 `text-align`，`P-TBL-01` 要字重；
    // 采集侧只负责如实取值，判据归 l2-run / preflight。
    var headerCells = cells.map(function (cell, j) {
      var hcs = global.getComputedStyle(cell);
      var hrect = cell.getBoundingClientRect();
      return {
        index: j,
        tag: cell.tagName ? cell.tagName.toLowerCase() : null,
        text: truncate(cell.textContent, 80),
        width_px: r4(hrect.width),
        height_px: r4(hrect.height),
        font_weight: hcs.fontWeight || null,
        font_size_px: pxR4(hcs.fontSize),
        text_align: hcs.textAlign || null,
        style_text_align: (cell.style && cell.style.textAlign) || null,
        background_color: hcs.backgroundColor || null,
        color: hcs.color || null,
        source: {
          font_weight: SOURCE.computed,
          font_size_px: SOURCE.computed,
          text_align: SOURCE.computed,
          style_text_align: 'element.style.textAlign（内联值，可能为空）',
          background_color: SOURCE.computed,
          color: SOURCE.computed,
          width_px: SOURCE.rect,
          height_px: SOURCE.rect
        }
      };
    });

    // `LH_table`（表格内相邻显示行带中心差）按设计必须由**像素**出（§2.3 T4），
    // 这里只交出首个数据格的矩形，供像素侧按格取样；⛔ 不拿 DOM 行盒顶替。
    var firstDataRow = dataRows.length ? dataRows[0] : null;
    var firstDataCell = firstDataRow && firstDataRow.cells && firstDataRow.cells.length
      ? firstDataRow.cells[0] : null;

    return {
      index: index,
      path: pathOf(table, doc),
      row_count: rows.length,
      data_row_count: dataRows.length,
      column_count: colCount,
      header_row_height_px: headerRow ? r4(headerRow.getBoundingClientRect().height) : null,
      data_row_heights_px: dataHeights.length ? dataHeights : null,
      data_row_height_px: dataHeights.length ? r4(median(dataHeights)) : null,
      header_cells: headerCells.length ? headerCells : null,
      first_data_cell_rect: firstDataCell ? rectOf(firstDataCell) : null,
      header_measured_from: headerRow
        ? (headerRow.parentElement && headerRow.parentElement.tagName
          ? headerRow.parentElement.tagName.toLowerCase() : 'tr')
        : null,
      table_rect: rectOf(table),
      columns: columns,
      source: {
        row_count: 'table.rows',
        data_row_count: 'table.rows 去掉表头行',
        column_count: '各行 cells 数的最大值',
        header_row_height_px: SOURCE.rect,
        data_row_heights_px: SOURCE.rect + '（非表头行）',
        data_row_height_px: 'data_row_heights_px 的中位数',
        'header_cells[].*': 'getComputedStyle + getBoundingClientRect',
        first_data_cell_rect: SOURCE.rect,
        'columns[].width_px': SOURCE.rect,
        'columns[].ratio': 'columns[].width_px / 测量行 cell 宽度之和',
        table_rect: SOURCE.rect
      }
    };
  }

  function collectTables(doc, diagnostics) {
    var tables = toArray(doc.querySelectorAll('table'));
    if (!tables.length) {
      diag(diagnostics, 'missing-element', 'tables', '.doc 内没有 <table>');
      return null;
    }
    return {
      count: tables.length,
      items: tables.map(function (t, i) { return tableInfo(t, i, doc); })
    };
  }

  /* ────────────────────────────── 任务项 ────────────────────────────── */

  function collectTaskItems(doc, diagnostics) {
    var boxes = toArray(doc.querySelectorAll('li.task-list-item input[type="checkbox"], li.task-list-item input[type=checkbox]'));
    if (!boxes.length) {
      // 兼容：有些渲染器只给 input 不给 li 的 class
      var fallback = toArray(doc.querySelectorAll('input[type="checkbox"], input[type=checkbox]'));
      boxes = fallback.filter(function (el) {
        var p = el.parentElement;
        while (p && p !== doc) {
          if (p.tagName === 'LI') return true;
          p = p.parentElement;
        }
        return false;
      });
    }
    if (!boxes.length) {
      diag(diagnostics, 'missing-element', 'task_items', '.doc 内没有任务列表复选框（li.task-list-item input[type=checkbox]）');
      return null;
    }
    var items = boxes.map(function (el, i) {
      var rect = rectOf(el);
      var cs = global.getComputedStyle(el);
      // bug 0152：判「任务项是否在多级列表里」必须看 DOM 嵌套深度，
      // 不能拿类名/路径做子串计数（`li.task-list-item` 里就含 "li"）。
      var li = el.closest ? el.closest('li') : null;
      var listLevel = li ? ancestorListCount(li, doc) : null;
      return {
        index: i,
        path: pathOf(el, doc),
        list_level: listLevel,
        in_multi_level_list: listLevel == null ? null : listLevel >= 2,
        checked: !!el.checked,
        disabled: !!el.disabled,
        rect: rect,
        width_px: rect ? rect.width : null,
        height_px: rect ? rect.height : null,
        margin_right_px: pxR4(cs.marginRight),
        source: {
          'rect.*': SOURCE.rect,
          width_px: SOURCE.rect,
          height_px: SOURCE.rect,
          checked: 'DOM property',
          disabled: 'DOM property',
          margin_right_px: SOURCE.computed,
          list_level: '祖先 UL/OL 计数（closest(li) 起，不含自身）',
          in_multi_level_list: 'list_level >= 2'
        }
      };
    });
    return { count: items.length, items: items };
  }

  /* ────────────────────────────── 图片 ────────────────────────────── */

  function collectImages(doc, diagnostics) {
    var imgs = toArray(doc.querySelectorAll('img'));
    if (!imgs.length) {
      diag(diagnostics, 'missing-element', 'images', '.doc 内没有 <img>');
      return null;
    }
    var items = imgs.map(function (el, i) {
      var rect = rectOf(el);
      return {
        index: i,
        path: pathOf(el, doc),
        src: el.currentSrc || el.getAttribute('src') || null,
        alt: el.getAttribute('alt'),
        rect: rect,
        natural_width_px: typeof el.naturalWidth === 'number' ? el.naturalWidth : null,
        natural_height_px: typeof el.naturalHeight === 'number' ? el.naturalHeight : null,
        complete: !!el.complete,
        source: {
          'rect.*': SOURCE.rect,
          natural_width_px: 'HTMLImageElement.naturalWidth',
          natural_height_px: 'HTMLImageElement.naturalHeight',
          complete: 'HTMLImageElement.complete'
        }
      };
    });
    return { count: items.length, items: items };
  }

  /* ────────────────────────── 行内语法 ────────────────────────── */

  function inlineInfo(el, index, doc) {
    var cs = global.getComputedStyle(el);
    return {
      index: index,
      tag: el.tagName ? el.tagName.toLowerCase() : null,
      text: truncate(el.textContent, 120),
      path: pathOf(el, doc),
      rect: rectOf(el),
      font_size_px: pxR4(cs.fontSize),
      line_height_px: lineHeightPx(cs),
      source: {
        'rect.*': SOURCE.rect,
        font_size_px: SOURCE.computed,
        line_height_px: SOURCE.computed
      }
    };
  }

  function inlineGroup(els, doc, diagnostics, category, extra) {
    if (!els.length) {
      diag(diagnostics, 'missing-element', category, '.doc 内没有 ' + category + ' 元素');
      return null;
    }
    return els.map(function (el, i) {
      var info = inlineInfo(el, i, doc);
      if (extra) extra(info, el);
      return info;
    });
  }

  function collectInline(doc, diagnostics) {
    var codes = toArray(doc.querySelectorAll('code')).filter(function (el) {
      return !el.closest || !el.closest('pre');
    });

    var links = toArray(doc.querySelectorAll('a'));

    return {
      code: inlineGroup(codes, doc, diagnostics, 'inline.code', null),
      em: inlineGroup(toArray(doc.querySelectorAll('em')), doc, diagnostics, 'inline.em', null),
      strong: inlineGroup(toArray(doc.querySelectorAll('strong')), doc, diagnostics, 'inline.strong', null),
      del: inlineGroup(toArray(doc.querySelectorAll('del')), doc, diagnostics, 'inline.del', null),
      links: inlineGroup(links, doc, diagnostics, 'inline.links', function (info, el) {
        info.href = truncate(el.getAttribute('href'), 200);
      })
    };
  }

  /* ────────────────────────── 硬换行 / 水平线 ────────────────────────── */

  function collectBreaks(doc, diagnostics) {
    var brs = toArray(doc.querySelectorAll('br'));
    if (!brs.length) {
      diag(diagnostics, 'missing-element', 'breaks', '.doc 内没有 <br>');
      return null;
    }
    var items = brs.map(function (el, i) {
      var rect = rectOf(el);
      return {
        index: i,
        path: pathOf(el, doc),
        parent_path: el.parentElement ? pathOf(el.parentElement, doc) : null,
        rect: rect,
        top_px: rect ? rect.top : null,
        left_px: rect ? rect.left : null,
        height_px: rect ? rect.height : null,
        source: { 'rect.*': SOURCE.rect }
      };
    });
    return { count: items.length, items: items };
  }

  function collectRules(doc, diagnostics) {
    var hrs = toArray(doc.querySelectorAll('hr'));
    if (!hrs.length) {
      diag(diagnostics, 'missing-element', 'rules', '.doc 内没有 <hr>');
      return null;
    }
    var items = hrs.map(function (el, i) {
      var cs = global.getComputedStyle(el);
      var rect = rectOf(el);
      return {
        index: i,
        path: pathOf(el, doc),
        rect: rect,
        height_px: rect ? rect.height : null,
        border_top_width_px: pxR4(cs.borderTopWidth),
        border_top_style: cs.borderTopStyle || null,
        border_top_color: cs.borderTopColor || null,
        background_color: cs.backgroundColor || null,
        color: cs.color || null,
        margin_top_px: pxR4(cs.marginTop),
        margin_bottom_px: pxR4(cs.marginBottom),
        source: {
          'rect.*': SOURCE.rect,
          height_px: SOURCE.rect,
          border_top_width_px: SOURCE.computed,
          border_top_color: SOURCE.computed,
          background_color: SOURCE.computed,
          color: SOURCE.computed,
          margin_top_px: SOURCE.computed,
          margin_bottom_px: SOURCE.computed
        }
      };
    });
    return { count: items.length, items: items };
  }

  /* ────────────────────────────── 主入口 ────────────────────────────── */

  function emptyDocResult() {
    return {
      found: false,
      selector: '.doc',
      tag: null,
      id: null,
      classes: null,
      rect: null,
      env: null,
      line_boxes: null,
      headings: null,
      lists: null,
      blockquotes: null,
      code_blocks: null,
      tables: null,
      task_items: null,
      images: null,
      inline: null,
      breaks: null,
      rules: null
    };
  }

  /**
   * 收集全部度量。返回 plain JSON 对象（可 JSON.stringify）。
   *
   * @param {{topTolerancePx?: number}} [options]
   *   topTolerancePx：行盒按 top 去重的容差，默认 0.5 CSS px。
   */
  function collect(options) {
    var opts = options || {};
    var tol = isNum(opts.topTolerancePx) ? opts.topTolerancePx : DEFAULT_TOP_TOLERANCE_PX;

    var diagnostics = [];
    var result = {
      schema: SCHEMA,
      probe_version: PROBE_VERSION,
      collected_at: new Date().toISOString(),
      viewport: {
        inner_width_px: r4(global.innerWidth),
        inner_height_px: r4(global.innerHeight),
        device_pixel_ratio: isNum(global.devicePixelRatio) ? global.devicePixelRatio : null,
        source: {
          inner_width_px: 'window.innerWidth',
          inner_height_px: 'window.innerHeight',
          device_pixel_ratio: 'window.devicePixelRatio'
        }
      },
      doc: null,
      diagnostics: diagnostics
    };

    var doc = document.querySelector('.doc');
    if (!doc) {
      result.doc = emptyDocResult();
      diag(diagnostics, 'doc-missing', 'doc', '找不到 .doc 元素；正文尚未挂载，或页面不是 rmd 阅读态');
      return result;
    }

    var env = readEnv(doc);
    if (env.line_height_px == null) {
      diag(diagnostics, 'line-height-normal', 'env.line_height_px',
        '.doc 的 computed line-height 是 "' + env.line_height_raw + '"（无法给出 px）');
    }
    if (env.content_box_width_px == null) {
      diag(diagnostics, 'content-width-unavailable', 'env.content_box_width_px',
        '无法从 clientWidth / padding 得到 content box 宽');
    } else if (env.content_box_width_px <= 0) {
      diag(diagnostics, 'content-width-nonpositive', 'env.content_box_width_px',
        'content box 宽 = ' + env.content_box_width_px + ' px，环境无效');
    }
    if (doc.querySelector('.doc-empty')) {
      diag(diagnostics, 'doc-empty-state', 'doc',
        '.doc 里挂着 .doc-empty（启动页/空态），不是正文');
    }

    var lineBoxes = collectLineBoxes(doc, tol, diagnostics);
    var headings = collectHeadings(doc, diagnostics);
    var lists = collectLists(doc, env.content_box_left_px, diagnostics);
    var blockquotes = collectBlockquotes(doc, diagnostics);
    var codeBlocks = collectCodeBlocks(doc, diagnostics);
    var tables = collectTables(doc, diagnostics);
    var taskItems = collectTaskItems(doc, diagnostics);
    var images = collectImages(doc, diagnostics);
    var inline = collectInline(doc, diagnostics);
    var breaks = collectBreaks(doc, diagnostics);
    var rules = collectRules(doc, diagnostics);

    result.doc = {
      found: true,
      selector: '.doc',
      tag: doc.tagName ? doc.tagName.toLowerCase() : null,
      id: doc.id || null,
      classes: classesOf(doc),
      rect: rectOf(doc),
      env: env,
      line_boxes: lineBoxes,
      headings: headings,
      lists: lists,
      blockquotes: blockquotes,
      code_blocks: codeBlocks,
      tables: tables,
      task_items: taskItems,
      images: images,
      inline: inline,
      breaks: breaks,
      rules: rules
    };

    return result;
  }

  global.__PARITY_DOM = {
    schema: SCHEMA,
    version: PROBE_VERSION,
    DEFAULT_TOP_TOLERANCE_PX: DEFAULT_TOP_TOLERANCE_PX,
    collect: collect
  };
})(typeof window !== 'undefined' ? window : this);
