// `design/0059` 阶段 C：**渲染同源的位置映射**隔离原型（页面侧）。
//
// ⭐ 本文件只跑在离屏 WKWebView 里（`posmap-probe.sh` 组装的页面），⛔ 不进产品：
//    产品侧一个字节都不改，⛔ 不加 DTO / 命令 / HTML schema。
//
// # 它回答的问题
//
// 「源码偏移 ↔ 产品渲染出来的 DOM 位置」到底能做到哪一档。三档的定义写死在
// `design/0059` 阶段 C：`exact` / `snapped` / `unmappable`。
//
// # 它**不**造第二份 Markdown 语义真相
//
// HTML 只来自 `tools/live-probe --render-json` 的**真实产品渲染**
// （`document/render.rs::to_html_with_stats`）。本文件只做两件事：
// ① 在**实际 DOM** 上建一份由这次渲染**派生**的文本索引（游程 + 双向字符表）；
// ② 按写死的规则把每个源码边界归到三档之一。
//
// # 对齐规则（⛔ 不许在这里"猜得更好看"）
//
// 含字文本节点按 DOM 顺序**单调**匹配源码里的**逐字**同一段（`indexOf` 从游标起），
// 且搜索被限制在**该节点所属顶层块**的源码区间内——块由「顶层元素第 i 个 ↔
// 第 i 个会出元素的块」配对得到（`HtmlBlock` 产品默认整段省略，不出元素）。
// ⛔ 匹配不上就是匹配不上（`unmappable`），⛔ 不模糊匹配、⛔ 不做编辑距离。
//
// # 边界三档的判据（这是本原型要交的那个契约）
//
// 设 `L` = 左邻字符映射到的 DOM 位置 + 1，`R` = 右邻字符映射到的 DOM 位置：
//
// | 情形 | 档 | 说明 |
// |---|---|---|
// | `L`、`R` 都有且相等 | `exact` | 两侧一致，位置无歧义 |
// | 都有但不等 | `snapped` | 两侧给了不同的 DOM 位置（如 `<br>` 两侧），按声明规则取左 |
// | 只有一侧 | `snapped` | 吸附到有映射的那一侧（规则：**左优先**） |
// | 都没有 | `unmappable` | ⛔ 不返回任何 DOM 位置 |
//
// ⚠️ 边界永远不"猜"：`unmappable` 的返回值里没有 DOM 位置这一项。

(function () {
  'use strict';

  var EXACT = 'exact';
  var SNAPPED = 'snapped';
  var UNMAPPABLE = 'unmappable';

  /** 单调递增的渲染实例号：**重渲一次就换一个**，旧映射据此被拒。 */
  var instanceSeq = 0;

  /** 确定性伪随机（⛔ 不用 Math.random：成本数字要能在两份报告间复现）。 */
  function lcg(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // ── 源码侧：行号 / 块区间（全部来自 Rust 给的换算表）──────────────────────

  function lineStarts(doc) {
    var out = new Array(doc.lines.length);
    for (var i = 0; i < doc.lines.length; i++) {
      out[doc.lines[i].line - 1] = doc.lines[i].utf16_start;
    }
    return out;
  }

  /**
   * 顶层块 → 源码 UTF-16 半开区间 `[from, to)`。
   * ⚠️ 行尾那个 `\n` 不算块内容（`to` = 下一行起点 − 1）。
   */
  function blockRanges(doc) {
    var starts = lineStarts(doc);
    return doc.blocks.map(function (b) {
      var from = starts[b.start_line - 1];
      var to = b.end_line < starts.length ? starts[b.end_line] - 1 : doc.text.length;
      return { index: b.index, kind: b.kind, from: from, to: to };
    });
  }

  // ── DOM 侧：文本段落（含纯空白，位置口径要连续）──────────────────────────

  function domSegments(root) {
    var segs = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var acc = 0;
    var node;
    while ((node = walker.nextNode())) {
      var len = node.data.length;
      var inPre = !!(node.parentElement && node.parentElement.closest('pre'));
      // ⭐ 生成树里的文本（MathML / SVG）**不是**源码文字：它是从别的东西算出来的。
      //    仍然计入 DOM 位置口径（否则后面的节点会整体错位），但 ⛔ 不参与逐字匹配。
      var generated = !!(node.parentElement && node.parentElement.closest('math, svg'));
      segs.push({ node: node, start: acc, len: len, inPre: inPre, generated: generated });
      acc += len;
    }
    return { segs: segs, len: acc };
  }

  /** 这个节点所属的**顶层元素**（`root` 的直接子元素）；直接挂在 `root` 下的文本返回 null。 */
  function topLevelOf(node, root) {
    var n = node;
    while (n && n.parentNode !== root) n = n.parentNode;
    return n && n.nodeType === 1 ? n : null;
  }

  /**
   * 顶层元素 → 块：按顺序配对，**跳过 `HtmlBlock`**（产品默认整段省略，不出元素）。
   * ⚠️ 这是一条**声明过的假设**：除 `HtmlBlock` 外每个顶层块都恰好出一个顶层元素。
   *    `FootnoteDefinition` 渲染在文末，会打破单调性 ⇒ 本原型不认这个夹具
   *    （`0059` 阶段 C 的夹具清单里没有脚注块，这条限制写进交付结论）。
   */
  function pairElements(root, ranges) {
    var map = new Map();
    var kids = Array.prototype.slice.call(root.childNodes).filter(function (n) {
      return n.nodeType === 1;
    });
    var bi = 0;
    for (var i = 0; i < kids.length; i++) {
      while (bi < ranges.length && ranges[bi].kind === 'HtmlBlock') bi++;
      if (bi >= ranges.length) break;
      map.set(kids[i], ranges[bi]);
      bi++;
    }
    return map;
  }

  // ── 索引构建：源码 UTF-16 下标 → DOM 全局下标（以及反向）────────────────

  function buildMapping(doc, root) {
    var t0 = performance.now();
    var src = doc.text;
    var srcLen = src.length;
    var ranges = blockRanges(doc);
    var dom = domSegments(root);
    var elemBlock = pairElements(root, ranges);

    var chars = new Int32Array(srcLen);
    chars.fill(-1);
    var srcOfDom = new Int32Array(dom.len + 1);
    srcOfDom.fill(-1);
    // 渲染文本（全部文本节点按序拼接）：校验 DOM 位置时**按全局位置**取邻字，
    // ⚠️ 不按单个节点取——边界可能正好落在两个文本节点之间。
    var rendered = dom.segs.map(function (s) { return s.node.data; }).join('');

    var cursor = 0;
    var runs = 0;
    var matchedRuns = 0;
    var unmatchedRuns = 0;

    for (var i = 0; i < dom.segs.length; i++) {
      var seg = dom.segs[i];
      var text = seg.node.data;
      if (text.length === 0) continue;
      if (seg.generated) continue; // MathML / SVG 生成文本：⛔ 不参与逐字匹配
      // 块与块之间的排版空白不是内容；`<pre>` 里的空白**是**内容。
      if (text.trim() === '' && !seg.inPre) continue;
      runs++;

      var block = elemBlock.get(topLevelOf(seg.node, root)) || null;
      var from = block ? Math.max(cursor, block.from) : cursor;
      var to = block ? block.to : srcLen;
      var idx = from <= to ? src.indexOf(text, from) : -1;
      if (idx < 0 || idx + text.length > to) {
        unmatchedRuns++;
        continue;
      }
      matchedRuns++;
      cursor = idx + text.length;
      for (var k = 0; k < text.length; k++) {
        chars[idx + k] = seg.start + k;
        srcOfDom[seg.start + k] = idx + k;
      }
    }

    var buildMs = performance.now() - t0;

    return {
      doc: doc,
      root: root,
      identity: {
        renderId: doc.renderId,
        renderInstance: instanceSeq,
        docSeq: 0,
        revision: 0,
      },
      srcLen: srcLen,
      domLen: dom.len,
      segs: dom.segs,
      chars: chars,
      srcOfDom: srcOfDom,
      ranges: ranges,
      buildMs: buildMs,
      runs: runs,
      matchedRuns: matchedRuns,
      unmatchedRuns: unmatchedRuns,
      rendered: rendered,
      indexBytes: chars.byteLength + srcOfDom.byteLength,
    };
  }

  // ── 查询：一个源码**边界** → 三档之一 ─────────────────────────────────────

  /** DOM 全局下标 → `{node, offset}`（段落是连续的，落在边界上归右段）。 */
  function domPoint(m, global) {
    var segs = m.segs;
    if (global < 0 || global > m.domLen || segs.length === 0) return null;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (global >= s.start && global < s.start + s.len) {
        return { node: s.node, offset: global - s.start };
      }
    }
    // 文末：最后一个文本段的末尾。
    var last = segs[segs.length - 1];
    return global === m.domLen ? { node: last.node, offset: last.len } : null;
  }

  /**
   * 分类一个边界。⭐⭐ `live` 是**当前**渲染的身份；与建索引时不一致 ⇒ `stale`，
   * ⛔ 不返回任何 DOM 位置（旧映射不许静默复用）。
   */
  function classifyBoundary(m, p, live) {
    if (live && (live.renderInstance !== m.identity.renderInstance
      || live.renderId !== m.identity.renderId
      || live.docSeq !== m.identity.docSeq
      || live.revision !== m.identity.revision)) {
      return { ok: false, why: 'stale' };
    }
    var chars = m.chars;
    var srcLen = m.srcLen;
    var leftMapped = p > 0 && chars[p - 1] >= 0;
    var rightMapped = p < srcLen && chars[p] >= 0;
    var left = leftMapped ? chars[p - 1] + 1 : -1;
    var right = rightMapped ? chars[p] : -1;

    var tier;
    var bias;
    if (leftMapped && rightMapped) {
      if (left === right) {
        tier = EXACT;
        bias = 'both';
      } else {
        tier = SNAPPED;
        bias = 'both-ambiguous';
      }
    } else if (leftMapped) {
      tier = SNAPPED;
      bias = 'left';
    } else if (rightMapped) {
      tier = SNAPPED;
      bias = 'right';
    } else {
      return { ok: true, p: p, tier: UNMAPPABLE, bias: null, dom: -1, point: null };
    }

    // 声明过的吸附规则：左优先。
    var dom = bias === 'right' ? right : left;
    var point = domPoint(m, dom);
    return {
      ok: true,
      p: p,
      tier: tier,
      bias: bias,
      dom: dom,
      point: point,
      left: left,
      right: right,
    };
  }

  /** DOM 边界 → 源码边界（严格往返的反向那一半）。 */
  function domToSourceBoundary(m, dom) {
    if (dom >= 0 && dom <= m.domLen && m.srcOfDom[dom] >= 0) return m.srcOfDom[dom];
    if (dom > 0 && m.srcOfDom[dom - 1] >= 0) return m.srcOfDom[dom - 1] + 1;
    return -1;
  }

  // ── 统计 ─────────────────────────────────────────────────────────────────

  function graphemeInfo(src) {
    if (typeof Intl === 'undefined' || !Intl.Segmenter) {
      return { supported: false, clusters: 0, inside: 0 };
    }
    var seg = new Intl.Segmenter('zh', { granularity: 'grapheme' });
    var clusters = 0;
    var inside = 0;
    var iter = seg.segment(src);
    var at = 0;
    for (var it = iter[Symbol.iterator](), r = it.next(); !r.done; r = it.next()) {
      clusters++;
      var s = r.value.index;
      var e = s + r.value.segment.length;
      if (s > at) inside += s - at; // 上一个簇之后、这一簇之前 ⇒ 落在簇中间
      at = e;
    }
    return { supported: true, clusters: clusters, inside: inside };
  }

  function analyse(doc) {
    var host = document.createElement('div');
    host.className = 'rendered';
    host.setAttribute('data-doc', doc.name);
    var t0 = performance.now();
    host.innerHTML = doc.html;
    var domMs = performance.now() - t0;
    document.getElementById('stage').appendChild(host);

    instanceSeq++;
    var m = buildMapping(doc, host);
    // ⭐ 分类用的 `live` 就是**这次建索引**的身份——不是外面传进来的。
    var live = {
      renderInstance: m.identity.renderInstance,
      renderId: m.identity.renderId,
      docSeq: 0,
      revision: 0,
    };

    // ⭐ 产品渲染**真的**出了对应结构吗？（判据 7/8：⛔ 只看文件名不算数）
    var domChecks = {
      p: host.querySelectorAll('p').length,
      heading: host.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
      li: host.querySelectorAll('li').length,
      blockquote: host.querySelectorAll('blockquote').length,
      pre: host.querySelectorAll('pre').length,
      table: host.querySelectorAll('table').length,
      th: host.querySelectorAll('th').length,
      checkbox: host.querySelectorAll('input[type="checkbox"]').length,
      img: host.querySelectorAll('img').length,
      math: host.querySelectorAll('math').length,
      // 产品默认省略裸 HTML 块 ⇒ 夹具里那个 `.box` ⛔ 不该出现（INV-SEC-01 的可观察面）。
      rawBox: host.querySelectorAll('.box').length,
      hlSpan: host.querySelectorAll('pre span[class]').length,
    };

    var stats = { exact: 0, snapped: 0, unmappable: 0, total: doc.text.length + 1 };
    var charStats = { mapped: 0, hidden: 0, total: doc.text.length };
    var snapBias = { left: 0, right: 0, 'both-ambiguous': 0 };
    var badPoints = [];
    var badRoundTrip = [];
    var neighborBad = [];
    var badCharRoundTrip = [];
    var deltaHist = new Map();

    for (var c = 0; c < m.srcLen; c++) {
      if (m.chars[c] >= 0) {
        charStats.mapped++;
        if (m.srcOfDom[m.chars[c]] !== c) {
          if (badCharRoundTrip.length < 5) badCharRoundTrip.push(c);
        }
      } else {
        charStats.hidden++;
      }
    }

    for (var p = 0; p <= m.srcLen; p++) {
      var r = classifyBoundary(m, p, live);
      if (!r.ok) {
        if (badPoints.length < 5) badPoints.push({ p: p, why: '活映射被判成 stale' });
        continue;
      }
      stats[r.tier]++;
      if (r.tier === UNMAPPABLE) {
        if (r.dom !== -1) badPoints.push({ p: p, why: 'unmappable 却给了 DOM 位置' });
        continue;
      }
      if (r.tier === SNAPPED) {
        snapBias[r.bias]++;
        if (!r.point) {
          if (badPoints.length < 5) badPoints.push({ p: p, why: 'snapped 的 DOM 位置不在任何文本节点里' });
          continue;
        }
        // 规则校验：重复查询必须给同一个 DOM 位置（稳定性）。
        var again = classifyBoundary(m, p, live);
        if (again.dom !== r.dom) {
          if (badPoints.length < 5) badPoints.push({ p: p, why: '重复查询得到不同位置' });
        }
        var back = domToSourceBoundary(m, r.dom);
        var d = back < 0 ? 'none' : back - p;
        deltaHist.set(d, (deltaHist.get(d) || 0) + 1);
        continue;
      }
      // exact：严格往返。
      var rt = domToSourceBoundary(m, r.dom);
      if (rt !== p && badRoundTrip.length < 5) {
        badRoundTrip.push({ p: p, dom: r.dom, back: rt });
      }
      // ⭐ 绝对校验（⛔ 不是自洽校验）：DOM 位置两侧的**字**必须就是源码两侧的字。
      //    往返一致只能证明表是自洽的——整体错位 k 个字符也能一致。
      var aroundOk = true;
      if (p > 0) aroundOk = aroundOk && m.rendered[r.dom - 1] === doc.text[p - 1];
      if (p < m.srcLen) aroundOk = aroundOk && m.rendered[r.dom] === doc.text[p];
      if (!aroundOk && neighborBad.length < 5) neighborBad.push({ p: p, dom: r.dom });
    }

    // 每类块的比例（边界按块半开区间分桶；最后一个边界归给包含它的块）。
    var perBlock = m.ranges.map(function (r) {
      return {
        index: r.index,
        kind: r.kind,
        exact: 0,
        snapped: 0,
        unmappable: 0,
        chars: 0,
        mappedChars: 0,
      };
    });
    for (var q = 0; q < m.ranges.length; q++) {
      var rg = m.ranges[q];
      var end = q === m.ranges.length - 1 ? m.srcLen : rg.to;
      for (var b = rg.from; b < end; b++) {
        var c2 = classifyBoundary(m, b, live);
        perBlock[q][c2.tier]++;
      }
      for (var cc = rg.from; cc < rg.to; cc++) {
        perBlock[q].chars++;
        if (m.chars[cc] >= 0) perBlock[q].mappedChars++;
      }
    }

    // 查询成本：确定性采样的边界。
    var rnd = lcg(20261103);
    var samples = [];
    for (var s = 0; s < 2000; s++) samples.push(Math.floor(rnd() * (m.srcLen + 1)));
    var t1 = performance.now();
    var checked = 0;
    for (var si = 0; si < samples.length; si++) {
      var res = classifyBoundary(m, samples[si], live);
      if (res.ok) checked++;
    }    var queryMs = performance.now() - t1;

    // 字素簇：区分三种单位用。
    var gra = graphemeInfo(doc.text);
    var unitMap = doc.unitMap || [];
    var bytesOk = unitMap.length === doc.text.length + 1
      && unitMap[unitMap.length - 1] === doc.cost.text_bytes;

    return {
      name: doc.name,
      identity: {
        renderId: doc.renderId,
        renderInstance: m.identity.renderInstance,
      },
      stats: {
        boundaries: stats,
        chars: charStats,
        snapBias: snapBias,
        graphemes: gra,
        units: {
          utf16: doc.text.length,
          utf8: doc.cost.text_bytes,
          unitMapOk: bytesOk,
        },
        blockCount: doc.blocks.length,
        /** 顶层块种类（判据 7 用它验"每类块都有真实渲染产物"，⛔ 只看文件名不算）。 */
        kinds: Array.from(new Set(doc.blocks.map(function (b) { return b.kind; }))).sort(),
      },
      perBlock: perBlock,
      domChecks: domChecks,
      roundTrip: {
        exactChecked: stats.exact,
        bad: badRoundTrip,
        neighborBad: neighborBad,
        charBad: badCharRoundTrip,
        charsChecked: charStats.mapped,
        snapDelta: Array.from(deltaHist.entries()).sort(function (a, b) { return b[1] - a[1]; }),
      },
      snapPointsBad: badPoints,
      cost: {
        rustParseMs: doc.cost.parse_ms,
        rustRenderMs: doc.cost.render_ms,
        htmlBytes: doc.cost.html_bytes,
        domSetMs: domMs,
        buildMs: m.buildMs,
        queryMs: queryMs,
        queryCount: checked,
        runs: m.runs,
        matchedRuns: m.matchedRuns,
        unmatchedRuns: m.unmatchedRuns,
        indexBytes: m.indexBytes,
      },
      _mapping: m,
      _host: host,
    };
  }

  // ── 陈旧判定：重渲 / DOM 被改 ⇒ 旧映射作废 ───────────────────────────────

  function staleChecks() {
    var rendered = window.__RENDER__;
    var doc = null;
    for (var i = 0; i < rendered.docs.length; i++) {
      if (rendered.docs[i].name.indexOf('paragraph') >= 0) { doc = rendered.docs[i]; break; }
    }
    if (!doc) doc = rendered.docs[0];
    var out = { doc: doc.name, steps: [] };

    // ⚠️ 真实重渲 = **同一个容器**里换掉整段内容（产品 `#doc` 就是这么做的）
    //    ⇒ 旧索引里的文本节点会**脱离文档**。⛔ 不是"在旁边再挂一个容器"——
    //    那样旧节点还连着，变异判据就会被一次假阳性放过。
    var stage = document.createElement('div');
    stage.className = 'rendered';
    document.getElementById('stage').appendChild(stage);
    function rerender() {
      stage.innerHTML = doc.html;
      instanceSeq++;
      return instanceSeq;
    }

    var inst1 = rerender();
    var m = buildMapping(doc, stage);
    var live = { renderInstance: inst1, renderId: doc.renderId, docSeq: 0, revision: 0 };
    var before = classifyBoundary(m, 5, live);
    out.steps.push({
      name: '建索引后立即查询',
      ok: before.ok && before.tier !== 'unmappable',
      tier: before.tier,
    });

    // ① 重渲（同内容、新实例）⇒ 必须 stale。
    var inst2 = rerender();
    var live2 = { renderInstance: inst2, renderId: doc.renderId, docSeq: 0, revision: 0 };
    var after = classifyBoundary(m, 5, live2);
    out.steps.push({ name: '重渲后旧映射', ok: after.ok === false && after.why === 'stale', got: after });

    // ② 变异：绕过身份判据直接拿旧位置 ⇒ 必须落在**已脱离文档**的节点上。
    var unsafe = classifyBoundary(m, 5, null);
    var detached = !unsafe.point || !unsafe.point.node.isConnected;
    out.steps.push({
      name: '变异：绕开身份判据',
      ok: detached,
      point: unsafe.point
        ? { offset: unsafe.point.offset, connected: unsafe.point.node.isConnected }
        : null,
      note: '旧索引的节点已随重渲脱离文档 ⇒ 不拦就会把光标放到一个看不见的位置',
    });

    // ③ 文档修订变了（内容不同 ⇒ renderId 不同）⇒ 必须 stale。
    rerender();
    var live3 = { renderInstance: instanceSeq, renderId: doc.renderId + '-changed', docSeq: 0, revision: 0 };
    var rev = classifyBoundary(m, 5, live3);
    out.steps.push({ name: '修订标签变了', ok: rev.ok === false && rev.why === 'stale', got: rev });

    out.ok = out.steps.every(function (s) { return s.ok; });
    return out;
  }

  // ── 入口 ─────────────────────────────────────────────────────────────────

  window.__RUN = function () {
    var rendered = window.__RENDER__;
    if (!rendered || !rendered.docs) {
      return { 致命: '页面没拿到 --render-json 的输出（window.__RENDER__ 缺失）' };
    }
    var docs = [];
    var cover = {};
    for (var i = 0; i < rendered.docs.length; i++) {
      var r = analyse(rendered.docs[i]);
      // ⚠️ 返回前把内部句柄摘掉（DOM 节点不能 JSON 序列化）。
      var out = Object.assign({}, r);
      delete out._mapping;
      delete out._host;
      docs.push(out);
      for (var k = 0; k < r.perBlock.length; k++) cover[r.perBlock[k].kind] = true;
    }
    return {
      环境: {
        文档数: rendered.docs.length,
        docCountDeclared: rendered.count,
        ua: navigator.userAgent,
      },
      文档: docs,
      夹具覆盖: Object.keys(cover).sort(),
      陈旧: staleChecks(),
    };
  };
})();
