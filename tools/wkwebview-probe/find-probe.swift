// rmd · 「正文内查找」的可行性探针（`design/0011` §7 步骤 0a / 0c）
//
// ⚠️ 这是**设计期取证工具**，不是产品代码。产物进 `docs/research/notes/0015`。
//
// 用法：
//   swift -O tools/wkwebview-probe/find-probe.swift            # 1 轮
//   ROUNDS=3 swift -O tools/wkwebview-probe/find-probe.swift   # 3 轮（本设计用的口径）
//
// 回答三件事：
//   0a 本机 WKWebView 有没有 CSS Custom Highlight API（`CSS.highlights` / `Highlight` / `::highlight()`）？
//      ⇒ 决定高亮走「零 DOM 变更」还是「包装 <mark>」。⚠️ 判据是**设进去再读回来**，⛔ 不是看构造函数
//        （`kb/0003` 的教训：`observe({type})` 对不支持的 type **不抛错**，所以 try/catch 探不了支持性）。
//   0c 在真窗口里、在一个**合成的大 DOM** 上，建索引 / 一次查询 / 造 Range / 高亮各要多久？
//      ⇒ `design/0011` §7 那两条自定闸门（首次 ⌘F ≤ 200 ms、每次刷新 ≤ 50 ms）的前提。
//
// 合成规模按批 2 实测的 `XL-tables`（495 216 元素 / 1 485 646 全树节点）取四档，**看线性度**，
// ⛔ 不从一档外推。⭐ 最后一档（50 万元素）就是 `XL-tables` 的元素量级。
// ⚠️ 本探针**故意**是「每个文本节点各走一遍祖先链」的**直白实现**——`拆解_` 那半同时量一个
//    memoize 版做对照，用来区分「结构性成本」与「实现没优化」。⛔ 别把直白版的数读成实现上限。

import Cocoa
import WebKit

// ─────────────────────────── 0a · 能力探测 ───────────────────────────
private let JS_CAP = """
(() => {
  const out = {};
  const h = {};
  h.hasCSSHighlights = (typeof CSS !== "undefined") && !!CSS.highlights;
  h.hasHighlightCtor = (typeof Highlight !== "undefined");
  h.registryHasSet = h.hasCSSHighlights && (typeof CSS.highlights.set === "function");
  h.cssSupportsPseudo = (() => {
    try { return CSS.supports("selector(::highlight(x))"); } catch (e) { return "throw: " + e.name; }
  })();
  if (h.hasCSSHighlights && h.hasHighlightCtor) {
    try {
      const r = document.createRange();
      const tn = document.createTextNode("abcdefghij");
      document.body.appendChild(tn);
      r.setStart(tn, 1); r.setEnd(tn, 4);
      const hl = new Highlight(r);
      hl.priority = 1;
      CSS.highlights.set("rmd-probe", hl);
      h.setThenGetOk = (CSS.highlights.get("rmd-probe") === hl);
      h.sizeAfterSet = CSS.highlights.size;
      h.highlightHasSize = (typeof hl.size === "number") ? hl.size : null;
      h.rangeApis = {
        getBoundingClientRect: typeof Range.prototype.getBoundingClientRect === "function",
        getClientRects: typeof Range.prototype.getClientRects === "function",
        scrollIntoView: typeof Element.prototype.scrollIntoView === "function",
      };
      // 大数组能不能直接 spread 进构造器（这条决定高亮上限怎么实现）
      try {
        const many = [];
        for (let i = 0; i < 5000; i++) { const rr = document.createRange(); rr.setStart(tn, 0); rr.setEnd(tn, 1); many.push(rr); }
        const hl2 = new Highlight(...many);
        h.spread5000Ok = (typeof hl2.size === "number") ? hl2.size : "?";
      } catch (e) { h.spread5000Ok = "throw: " + e.name + ": " + e.message; }
      CSS.highlights.delete("rmd-probe");
      h.sizeAfterDelete = CSS.highlights.size;
    } catch (e) { h.roundTrip = "throw: " + e.name + ": " + e.message; }
  }
  out.customHighlight = h;
  out.userAgent = navigator.userAgent;
  return JSON.stringify(out);
})()
"""

// ─────────────────── 0c · 分档计时（索引 / 查询 / Range / 高亮） ───────────────────
// 参数从 %ROWS% / %CELLS% 注入。**每一档是一次独立的 evaluateJavaScript**——
// 某一档炸掉不会把前面已经拿到的结果一起丢掉。
private let JS_INDEX = """
(() => {
  const ROWS = %ROWS%, CELLS = %CELLS%;
  const out = {};
  const now = () => performance.now();
  const r2 = (x) => Math.round(x * 100) / 100;

  const BLOCK = new Set(["P","DIV","LI","TD","TH","H1","H2","H3","H4","H5","H6",
                         "BLOCKQUOTE","PRE","DD","DT","FIGCAPTION","SECTION","ARTICLE"]);
  const WORDS = "索引 回滚 超时 渲染 分块 授权 目录 高亮";

  const t0 = now();
  let s = "";
  for (let r = 0; r < ROWS; r++) {
    s += "<tr>";
    for (let c = 0; c < CELLS; c++) s += "<td>单元格 " + r + "-" + c + " " + WORDS + "</td>";
    s += "</tr>";
  }
  const host = document.createElement("div");
  host.id = "doc";
  const table = document.createElement("table");
  host.appendChild(table);
  document.body.appendChild(host);
  table.innerHTML = s;
  const tBuild = now();

  void host.offsetHeight;          // 强制布局一次，⛔ 不算进索引
  const tLayout = now();

  // ── 建索引：按块级祖先切段（直白版，每节点各走一遍祖先链） ──
  const segs = [];
  const byBlock = new Map();
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      let p = n.parentElement;
      while (p && p !== host) {
        if (p.tagName === "SVG" || p.tagName === "MATH") return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let nodes = 0, n;
  while ((n = w.nextNode())) {
    nodes++;
    let b = n.parentElement;
    while (b && b !== host && !BLOCK.has(b.tagName)) b = b.parentElement;
    if (!b) b = host;
    let seg = byBlock.get(b);
    if (!seg) { seg = { text: "", pieces: [] }; byBlock.set(b, seg); segs.push(seg); }
    seg.pieces.push({ node: n, startChars: seg.text.length });
    seg.text += n.data;
  }
  const tIdx = now();

  function query(q) {
    const hits = [];
    for (let i = 0; i < segs.length; i++) {
      const t = segs[i].text;
      let from = 0, k;
      while ((k = t.indexOf(q, from)) !== -1) { hits.push({ seg: i, start: k, end: k + q.length }); from = k + q.length; }
    }
    return hits;
  }
  const hits = query("索引");
  const tQ1 = now();
  const hits2 = query("回滚");
  const tQ2 = now();
  const hits3 = query("不存在的词zzz");     // ⭐ 0 命中 ⇒ 纯扫描成本
  const tQ3 = now();

  // 段内字符偏移 → {node, offset}；边界落在字符中间就丢掉整段（`INV-SEARCH-03` 的同族）
  function locate(seg, chars) {
    if (chars === seg.text.length && seg.pieces.length) {
      const last = seg.pieces[seg.pieces.length - 1];
      return { node: last.node, offset: last.node.data.length };
    }
    for (let i = 0; i < seg.pieces.length; i++) {
      const p = seg.pieces[i];
      const len = p.node.data.length;
      const local = chars - p.startChars;
      if (local >= 0 && local <= len) {
        if (local === len && i !== seg.pieces.length - 1) continue;
        return { node: p.node, offset: local };
      }
    }
    return null;
  }
  const ranges = [];
  for (const hit of hits) {
    const seg = segs[hit.seg];
    const a = locate(seg, hit.start), b = locate(seg, hit.end);
    if (!a || !b) continue;
    const rr = document.createRange();
    rr.setStart(a.node, a.offset); rr.setEnd(b.node, b.offset);
    ranges.push(rr);
  }
  const tRange = now();

  let hlKind = "none", hlCount = null, hlMs = null, hlErr = null;
  try {
    if (typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined") {
      const hl = new Highlight(...ranges);
      CSS.highlights.set("rmd-find", hl);
      hlKind = "css.highlights";
      hlCount = hl.size;
    } else {
      hlKind = "mark";
      for (let i = ranges.length - 1; i >= 0; i--) {
        const m = document.createElement("mark");
        try { ranges[i].surroundContents(m); } catch (e) {}
      }
      hlCount = document.querySelectorAll("mark").length;
    }
  } catch (e) { hlErr = e.name + ": " + e.message; }
  const tHl = now();

  out.档 = ROWS + "行x" + CELLS + "格";
  out.元素数 = host.querySelectorAll("*").length;
  out.文本节点数 = nodes;
  out.段数 = segs.length;
  out.建DOM字符串_ms = r2(tBuild - t0);
  out.强制布局_ms = r2(tLayout - tBuild);
  out.建索引_ms = r2(tIdx - tLayout);
  out.查询1_ms = r2(tQ1 - tIdx);
  out.查询2_ms = r2(tQ2 - tQ1);
  out.查询_零命中_ms = r2(tQ3 - tQ2);
  out.造Range_ms = r2(tRange - tQ2);
  out.高亮方式 = hlKind;
  out.高亮数 = hlCount;
  out.高亮_ms = r2(tHl - tRange);
  out.高亮异常 = hlErr;
  out.命中数 = hits.length;
  out.首查到可交互_ms = r2(tQ1 - tLayout);

  if (typeof CSS !== "undefined" && CSS.highlights) CSS.highlights.delete("rmd-find");
  host.remove();
  return JSON.stringify(out);
})()
"""

// ─────────── 0c 补充 · 「建索引」的成本拆解 + 高亮上限 2000 的效力 ───────────
// 两个问题：
//   (A) 那 350 ms 是 TreeWalker 遍历、段拼接、还是祖先判定？⇒ 祖先判定是**实现问题**（memoize 能救），
//       段拼接是**结构性成本**（要跨行内元素的命中就必须拼）。
//   (B) `design/0011` §9.1 第 6 条那个「高亮上限 2000」**真的**把每次刷新压进 50 ms 吗？
private let JS_BREAKDOWN = """
(() => {
  const ROWS = %ROWS%, CELLS = %CELLS%;
  const out = {};
  const now = () => performance.now();
  const r2 = (x) => Math.round(x * 100) / 100;

  const BLOCK = new Set(["P","DIV","LI","TD","TH","H1","H2","H3","H4","H5","H6",
                         "BLOCKQUOTE","PRE","DD","DT","FIGCAPTION","SECTION","ARTICLE"]);
  const WORDS = "索引 回滚 超时 渲染 分块 授权 目录 高亮";

  let s = "";
  for (let r = 0; r < ROWS; r++) {
    s += "<tr>";
    for (let c = 0; c < CELLS; c++) s += "<td>单元格 " + r + "-" + c + " " + WORDS + "</td>";
    s += "</tr>";
  }
  const host = document.createElement("div");
  host.id = "doc";
  const table = document.createElement("table");
  host.appendChild(table);
  document.body.appendChild(host);
  table.innerHTML = s;
  void host.offsetHeight;

  // ── A-1 直白版：每个文本节点各走一遍祖先链（与 JS_INDEX 同口径，作为对照） ──
  {
    const tA = now();
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        let p = n.parentElement;
        while (p && p !== host) {
          if (p.tagName === "SVG" || p.tagName === "MATH") return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n;
    while ((n = w.nextNode())) nodes.push(n);
    const tWalk = now();
    const byBlock = new Map();
    const segs = [];
    for (const node of nodes) {
      let b = node.parentElement;
      while (b && b !== host && !BLOCK.has(b.tagName)) b = b.parentElement;
      if (!b) b = host;
      let seg = byBlock.get(b);
      if (!seg) { seg = { text: "", pieces: [] }; byBlock.set(b, seg); segs.push(seg); }
      seg.pieces.push({ node, startChars: seg.text.length });
      seg.text += node.data;
    }
    const tGroup = now();
    out.直白_TreeWalker_ms = r2(tWalk - tA);
    out.直白_分组拼接_ms = r2(tGroup - tWalk);
    out.直白_合计_ms = r2(tGroup - tA);
    out.文本节点数 = nodes.length;
    out.段数 = segs.length;
  }

  // ── A-2 memoize 版：祖先判定与 svg/math 判定各缓存一份（WeakMap） ──
  {
    const skip = new WeakMap();
    const blockOf = new WeakMap();
    function inSvgMath(el) {
      let v = skip.get(el);
      if (v !== undefined) return v;
      v = (el.tagName === "SVG" || el.tagName === "MATH") ? true
        : (el === host || !el.parentElement) ? false
        : inSvgMath(el.parentElement);
      skip.set(el, v);
      return v;
    }
    function nearestBlock(el) {
      let v = blockOf.get(el);
      if (v !== undefined) return v;
      v = (el === host || !el.parentElement) ? null
        : BLOCK.has(el.tagName) ? el
        : nearestBlock(el.parentElement);
      blockOf.set(el, v);
      return v;
    }
    const tA = now();
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => inSvgMath(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    let n;
    while ((n = w.nextNode())) nodes.push(n);
    const tWalk = now();
    const byBlock = new Map();
    const segs = [];
    for (const node of nodes) {
      const b = nearestBlock(node.parentElement) || host;
      let seg = byBlock.get(b);
      if (!seg) { seg = { text: "", pieces: [] }; byBlock.set(b, seg); segs.push(seg); }
      seg.pieces.push({ node, startChars: seg.text.length });
      seg.text += node.data;
    }
    const tGroup = now();
    out.memo_TreeWalker_ms = r2(tWalk - tA);
    out.memo_分组拼接_ms = r2(tGroup - tWalk);
    out.memo_合计_ms = r2(tGroup - tA);

    // ── B 高亮上限的效力：全部命中 vs 只前 2000 处 vs 只当前一处 ──
    function locate(seg, chars) {
      if (chars === seg.text.length && seg.pieces.length) {
        const last = seg.pieces[seg.pieces.length - 1];
        return { node: last.node, offset: last.node.data.length };
      }
      for (let i = 0; i < seg.pieces.length; i++) {
        const p = seg.pieces[i]; const len = p.node.data.length; const local = chars - p.startChars;
        if (local >= 0 && local <= len) {
          if (local === len && i !== seg.pieces.length - 1) continue;
          return { node: p.node, offset: local };
        }
      }
      return null;
    }
    function run(q, cap) {
      const tq = now();
      const hits = [];
      for (let i = 0; i < segs.length; i++) {
        const t = segs[i].text; let from = 0, k;
        while ((k = t.indexOf(q, from)) !== -1) {
          hits.push({ seg: i, start: k, end: k + q.length });
          from = k + q.length;
          if (cap && hits.length >= cap) break;
        }
        if (cap && hits.length >= cap) break;
      }
      const tHit = now();
      const ranges = [];
      for (const hit of hits) {
        const seg = segs[hit.seg];
        const a = locate(seg, hit.start), b = locate(seg, hit.end);
        if (!a || !b) continue;
        const rr = document.createRange(); rr.setStart(a.node, a.offset); rr.setEnd(b.node, b.offset);
        ranges.push(rr);
      }
      const tRange = now();
      CSS.highlights.delete("rmd-find");
      const hl = new Highlight(...ranges);
      CSS.highlights.set("rmd-find", hl);
      const tHl = now();
      CSS.highlights.delete("rmd-find");
      return { 命中: hits.length, 扫描: r2(tHit - tq), 造Range: r2(tRange - tHit), 高亮: r2(tHl - tRange),
               刷新合计: r2(tHl - tq) };
    }
    out.全量高亮 = run("索引", null);
    out.限2000处 = run("索引", 2000);
    out.只当前一处 = run("索引", 1);
    out.零命中 = (() => { const t = now(); let c = 0;
      for (let i = 0; i < segs.length; i++) if (segs[i].text.indexOf("不存在的词zzz") !== -1) c++;
      return { 命中: c, 刷新合计: r2(now() - t) }; })();
  }

  out.档 = ROWS + "行x" + CELLS + "格";
  out.元素数 = host.querySelectorAll("*").length;
  host.remove();
  return JSON.stringify(out);
})()
"""

// ───────── A-3 · 换一种取段文本的方式：⛔ 不靠 JS 逐个拼接，改问元素要（native `textContent`） ─────────
// 同一套「最近的块级祖先」分段，只是**段文本怎么来**不同：
//   A-1 / A-2：逐片 `seg.text += node.data` —— 40 万次**字符串拼接**（JS 层）
//   A-3：      `seg.text = el.textContent` —— 每段**一次**、走 C++；`pieces` 改成**只对命中的段按需建**
// ⇒ 段划分**完全一样**，所以这是一次干净的 A/B。⚠️ 但 `textContent` 会把 `svg`/`math` 子树里的文本
//    也带进来（§4 的取舍是"跳过"）⇒ 真要走这条路线必须另行排除，见 `notes/0015` §7 的限制。
private let JS_TEXTIDX = """
(() => {
  const ROWS = %ROWS%, CELLS = %CELLS%;
  const out = {};
  const now = () => performance.now();
  const r2 = (x) => Math.round(x * 100) / 100;

  const BLOCK = new Set(["P","DIV","LI","TD","TH","H1","H2","H3","H4","H5","H6",
                         "BLOCKQUOTE","PRE","DD","DT","FIGCAPTION","SECTION","ARTICLE"]);
  const WORDS = "索引 回滚 超时 渲染 分块 授权 目录 高亮";

  let s = "";
  for (let r = 0; r < ROWS; r++) {
    s += "<tr>";
    for (let c = 0; c < CELLS; c++) s += "<td>单元格 " + r + "-" + c + " " + WORDS + "</td>";
    s += "</tr>";
  }
  const host = document.createElement("div");
  host.id = "doc";
  const table = document.createElement("table");
  host.appendChild(table);
  document.body.appendChild(host);
  table.innerHTML = s;
  void host.offsetHeight;

  const tA = now();
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      let p = n.parentElement;
      while (p && p !== host) {
        if (p.tagName === "SVG" || p.tagName === "MATH") return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const byBlock = new Map();     // ⛔ 只记「这个块下有几个文本节点」，一个字符都不拼
  let n, nodes = 0;
  while ((n = w.nextNode())) {
    nodes++;
    let b = n.parentElement;
    while (b && b !== host && !BLOCK.has(b.tagName)) b = b.parentElement;
    if (!b) b = host;
    byBlock.set(b, (byBlock.get(b) || 0) + 1);
  }
  const tGroup = now();

  const els = Array.from(byBlock.keys());
  const segs = [];
  let textLen = 0;
  for (let i = 0; i < els.length; i++) {
    const t = els[i].textContent;     // ⭐ 每段一次，native
    textLen += t.length;
    segs.push(t);
  }
  const tText = now();

  const tQ0 = now();
  const hits = [];
  for (let i = 0; i < segs.length; i++) {
    const t = segs[i]; let from = 0, k;
    while ((k = t.indexOf("索引", from)) !== -1) { hits.push({ seg: i, start: k, end: k + 2 }); from = k + 2; }
  }
  const tQ = now();

  // ⭐ 按需建 pieces：**只对命中的段**走一次树，⛔ 索引期一次都不走
  const tP0 = now();
  const el = els[hits.length ? hits[0].seg : 0];
  const pieces = [];
  const w2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (x) => {
      let p = x.parentElement;
      while (p && p !== el) {
        if (p.tagName === "SVG" || p.tagName === "MATH") return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let m;
  while ((m = w2.nextNode())) pieces.push(m);
  const tP = now();

  out.档 = ROWS + "行x" + CELLS + "格";
  out.元素数 = host.querySelectorAll("*").length;
  out.文本节点数 = nodes;
  out.段数 = segs.length;
  out.A3_归组_ms = r2(tGroup - tA);
  out.A3_取textContent_ms = r2(tText - tGroup);
  out.A3_合计_ms = r2(tText - tA);
  out.A3_文本总长 = textLen;
  out.A3_查询_ms = r2(tQ - tQ0);
  out.A3_命中数 = hits.length;
  out.A3_单块建pieces_ms = r2(tP - tP0);
  out.A3_首段pieces数 = pieces.length;
  out.A3_首次可交互_ms = r2(tText - tA + (tQ - tQ0));   // 建索引 + 一次查询（⛔ '只建命中段的 pieces' 不算在内）

  host.remove();
  return JSON.stringify(out);
})()
"""

// ───────── A-4 · ⭐ 把两条已知更省的路合起来：memoize 的祖先判定 ＋ native `textContent` ─────────
// A-1/A-2 说「祖先判定 memoize 之后快 2×」，A-3 说「取文本改 native 只要 30 ms 而不是 105–160 ms」。
// 既然两条互不相干，合起来量一次 —— 这是本探针里**最快**的一条路线，也可能把 §7 步骤 0c 的第 ① 条
// 闸门（首次 ⌘F ≤ 200 ms）从"不成立"变回"成立"。
// ⚠️ 代价（⛔ 必须写进设计、不能忘）：`el.textContent` 会把 **`svg`/`math` 子树里的文本也带进来**，
//    而段文本按 §4 的取舍是要**跳过**它们的 ⇒ 两者的偏移在一个含公式/图的段里**对不齐**。
//    本探针采取的规则是：**命中的段按"逐节点（跳过 svg/math）拼出来的文本"复核一遍，
//    复核不到就整段丢掉**（`INV-SEARCH-03` 的同族：宁可丢，⛔ 不就近取整）。
private let JS_TEXTIDX2 = """
(() => {
  const ROWS = %ROWS%, CELLS = %CELLS%;
  const out = {};
  const now = () => performance.now();
  const r2 = (x) => Math.round(x * 100) / 100;

  const BLOCK = new Set(["P","DIV","LI","TD","TH","H1","H2","H3","H4","H5","H6",
                         "BLOCKQUOTE","PRE","DD","DT","FIGCAPTION","SECTION","ARTICLE"]);
  const WORDS = "索引 回滚 超时 渲染 分块 授权 目录 高亮";

  let s = "";
  for (let r = 0; r < ROWS; r++) {
    s += "<tr>";
    for (let c = 0; c < CELLS; c++) s += "<td>单元格 " + r + "-" + c + " " + WORDS + "</td>";
    s += "</tr>";
  }
  const host = document.createElement("div");
  host.id = "doc";
  const table = document.createElement("table");
  host.appendChild(table);
  document.body.appendChild(host);
  table.innerHTML = s;
  void host.offsetHeight;

  const skip = new WeakMap();
  const blockOf = new WeakMap();
  function inSvgMath(el) {
    let v = skip.get(el);
    if (v !== undefined) return v;
    v = (el.tagName === "SVG" || el.tagName === "MATH") ? true
      : (el === host || !el.parentElement) ? false
      : inSvgMath(el.parentElement);
    skip.set(el, v);
    return v;
  }
  function nearestBlock(el) {
    let v = blockOf.get(el);
    if (v !== undefined) return v;
    v = (el === host || !el.parentElement) ? null
      : BLOCK.has(el.tagName) ? el
      : nearestBlock(el.parentElement);
    blockOf.set(el, v);
    return v;
  }

  const t0 = now();
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => inSvgMath(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const byBlock = new Map();
  let n, nodes = 0;
  while ((n = w.nextNode())) {
    nodes++;
    const b = nearestBlock(n.parentElement) || host;
    byBlock.set(b, (byBlock.get(b) || 0) + 1);   // ⛔ 不拼字符串
  }
  const tGroup = now();
  const els = Array.from(byBlock.keys());
  const segs = [];
  for (let i = 0; i < els.length; i++) segs.push(els[i].textContent);
  const tText = now();
  const tIdx = now();

  // ── 查询（计数全量：这是 §5 的 `INV-FIND-05` 要的"真实总数"） ──
  function scan(q, cap) {
    const hits = [];
    for (let i = 0; i < segs.length; i++) {
      const t = segs[i]; let from = 0, k;
      while ((k = t.indexOf(q, from)) !== -1) {
        hits.push({ seg: i, start: k, end: k + q.length });
        from = k + q.length;
        if (cap && hits.length >= cap) break;
      }
      if (cap && hits.length >= cap) break;
    }
    return hits;
  }
  const tQ0 = now();
  const allHits = scan("索引", null);
  const tQ = now();

  // ── 刷新（每键）：上限 2000，**含**对命中段按需建 pieces + 复核 + 造 Range + 高亮 ──
  const CAP = 2000;
  const tR0 = now();
  const hits = scan("索引", CAP);
  const cache = new Map();          // ⭐ 同一个命中段只建一次 pieces（一次查询里多命中同段很常见）
  function piecesOf(i) {
    if (cache.has(i)) return cache.get(i);
    const el = els[i];
    const w2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (x) => {
        let p = x.parentElement;
        while (p && p !== el) {
          if (p.tagName === "SVG" || p.tagName === "MATH") return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const ps = []; let text = ""; let m;
    while ((m = w2.nextNode())) { ps.push({ node: m, startChars: text.length }); text += m.data; }
    const v = { pieces: ps, text };
    cache.set(i, v);
    return v;
  }
  function locate(pieces, chars) {
    if (chars === pieces[pieces.length - 1].startChars + pieces[pieces.length - 1].node.data.length) {
      const last = pieces[pieces.length - 1];
      return { node: last.node, offset: last.node.data.length };
    }
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]; const len = p.node.data.length; const local = chars - p.startChars;
      if (local >= 0 && local <= len) {
        if (local === len && i !== pieces.length - 1) continue;
        return { node: p.node, offset: local };
      }
    }
    return null;
  }
  const ranges = [];
  let dropped = 0;
  for (const hit of hits) {
    const seg = piecesOf(hit.seg);
    // ⭐ 复核：`textContent` 里的偏移在"跳过 svg/math 的文本"上还找得到吗？找不到就丢掉整段
    const k = seg.text.indexOf("索引");
    if (k === -1) { dropped++; continue; }
    const a = locate(seg.pieces, k), b = locate(seg.pieces, k + 2);
    if (!a || !b) { dropped++; continue; }
    const rr = document.createRange(); rr.setStart(a.node, a.offset); rr.setEnd(b.node, b.offset);
    ranges.push(rr);
  }
  CSS.highlights.delete("rmd-find");
  CSS.highlights.set("rmd-find", new Highlight(...ranges));
  CSS.highlights.delete("rmd-find");
  const tR = now();

  out.档 = ROWS + "行x" + CELLS + "格";
  out.元素数 = host.querySelectorAll("*").length;
  out.文本节点数 = nodes;
  out.段数 = segs.length;
  out.A4_归组_ms = r2(tGroup - t0);
  out.A4_取textContent_ms = r2(tText - tGroup);
  out.A4_合计_ms = r2(tIdx - t0);
  out.A4_计数查询_ms = r2(tQ - tQ0);
  out.A4_命中数 = allHits.length;
  out.A4_刷新限2000_ms = r2(tR - tR0);
  out.A4_丢了几个 = dropped;
  out.A4_首次可交互_ms = r2(tIdx - t0 + (tQ - tQ0));
  out.A4_段内建pieces数 = cache.size;

  host.remove();
  return JSON.stringify(out);
})()
"""

// ═══════════ 反例组 · 真 DOM 里的段边界（`design/0011` §7 那张表，10 条） ═══════════
//
// # 为什么必须真 DOM
//
// `tests/js/find.test.js` 是**纯逻辑**（`node --test`，⛔ 没有 DOM）：它能钉住四条截断点的**判据**，
// 钉不住"`Range.toString()` 到底读出了什么"。而本设计里**唯一**能证明"偏移没错位"的东西
// 就是它——中文与 Emoji 的偏移写错了，段落照样切对、计数照样对，只有把 `Range` 读回来才露馅。
//
// # ⭐⭐ 注入的是**真的** `src/services/find.js` 与 `src/components/FindBar.js`
//
// ⛔ **绝不在探针里重写一份段构造**。理由就是本项目已经踩过的那条（`INV-SEARCH-02` 的"共用谓词"）：
// 探针里另写一份 = 第三份判据，而它**分叉时不会有任何症状**——探针全绿，产品代码另有其事。
// 探针要当的是"**同一份代码在真 DOM 上的运行结果**"，不是"另一份实现的答案"。
// ⇒ 两个文件在**加载期**从磁盘读进来，当普通经典脚本塞进页面；只补两个**桩**
//    （`rmd.settings` 的覆盖层登记处、`rmd.keymap` 的两个纯函数），
//    ⛔ 这两个桩**不参与**被验的那条路径（查找不经过它们）。
//
// # 驱动的顺序（⚠️ 为什么不在一条 JS 里跑完）
//
// `open()` 之后的建索引是**分段**的、让出主线程走 `requestAnimationFrame`（`§9.4` 第 8 条）。
// ⇒ 一次性 `evaluateJavaScript` 里跑不完，必须留出**帧的时间**。
// ⭐ Swift 这一侧就是那个泵：每个用例「PREP（建 DOM + 开浮层）→ 等 0.25 s → CHECK（读结果）」。
// ⚠️ 由此也**必须让窗口可见**：`alphaValue = 0` 的窗口里 WebKit **可能根本不发 rAF**
//    （本探针原来的三组是同步的，看不见这件事）。⇒ 反例组跑在一个真窗口里。
// ⚠️ 搜索一律走**输入框 + `input` 事件**（⛔ 不调内部函数）——那正是用户敲字的路径。

/// 一条反例：夹具 + 一串搜索 + 每步期望的命中数。
private struct SegCase {
    let name: String
    let html: String
    /// 依次搜的词；`nil` = **清空**（搜空串）。
    let seq: [String?]
    /// 每个 step 期望的命中数（与 `seq` 一一对应）。
    let wants: [Int]
    /// `[后, 前]`：这两步的 `total`/`current`/高亮文本必须**逐项相等**（`R2` 的"第三次才错"）。
    let pairs: [[Int]]
    /// ⚠️ `true` = 强制走 `<mark>` 回退路线（`R2`：⛔ 不把回退写成"本机走不到就不测"）。
    let fallback: Bool
    /// 期望的段数（`nil` = 不查）。
    let wantSegs: Int?
}

private let SEG_CASES: [SegCase] = [
    // ① `R1`：`<br>` 是屏幕上的一次换行 ⇒ 必须切开，否则拼出**屏幕上不存在**的词。
    SegCase(name: "br 两侧必须切开", html: "<p>甲<br>乙</p>",
            seq: ["甲乙", "甲", "乙"], wants: [0, 1, 1], pairs: [], fallback: false, wantSegs: 2),
    // ② `R1` 的原例：`乙` 是**离开 `<p>` 回到 `<li>`** 才该切 ⇒ 段数必须是 3。
    //    ⚠️ 按"进入了块级容器"切会得到 `中乙` 一段、`甲中间` 反而命中 —— 那正是首轮评审点名的假命中。
    SegCase(name: "嵌套块的离开也要切", html: "<li>甲<p>中间</p>乙</li>",
            seq: ["甲中间", "甲", "乙", "中间"], wants: [0, 1, 1, 1], pairs: [], fallback: false, wantSegs: 3),
    // ③ `R1`+`R5`：被排除子树**两侧都要切**。夹具刻意让公式里也有 `甲`/`乙`，
    //    这样"只剪枝不切缝"与"只切缝不剪枝"**两种错法都会露馅**。
    SegCase(name: "公式两侧切开且公式本身不进段",
            html: "<p>甲<math><mi>甲</mi><mi>乙</mi></math>乙</p>",
            seq: ["甲乙", "甲", "乙"], wants: [0, 1, 1], pairs: [], fallback: false, wantSegs: 2),
    // ④ `R5`：⛔ 不是"含公式的整段丢弃"——`索引`/`回滚` 照常可搜（`INV-FIND-10`）。
    SegCase(name: "含公式的段里普通文字照常可搜",
            html: "<p>索引<math><mi>x</mi></math>回滚</p>",
            seq: ["索引", "回滚"], wants: [1, 1], pairs: [], fallback: false, wantSegs: 2),
    // ⑤ 单元格是块级容器 ⇒ 每格各自成段。
    SegCase(name: "单元格边界",
            html: "<table><tr><td>甲</td><td>乙</td></tr></table>",
            seq: ["甲乙", "甲", "乙"], wants: [0, 1, 1], pairs: [], fallback: false, wantSegs: 2),
    // ⑥ comrak 会在标签之间写换行（`html.rs` 的 `cr()`/`lf()`）⇒ 那些空白**不进段**。
    //    ⚠️ 判据取"搜 `甲 乙` 不命中"而**不是**设计原文的"搜 `' '` 命中 0 处"——
    //    后者会被 `normalizeQuery`（只有空白 = 没输入）**平凡地**满足，一个字都没验到。
    //    ⚠️⚠️ **这一条比原稿弱，原因是探针撞上的一处硬限制**（见 §10 与 `notes/0015` §10）：
    //    搜索一律走真 `<input>`，而 `<input type="search">` 的 value 清洗**会把 `\n` 剥掉**
    //    ⇒ 任何含换行的关键词**根本进不了查找栏**。原稿那句 `"甲\n"` 到不了页面
    //    （会被输入框变成 `"甲"`、于是命中 1），所以它**不是**"判据不成立"，
    //    是**这条路径上问不出那个问题**。
    //    ⇒ 降到"结构空白既不影响命中数、也不影响段数"：`甲 乙` 0 处 ∧ 段数 = 2（每格一段）。
    //    ⛔ 别把它改回 `"甲\n"`——那是让一个**永假**的期望去撞输入框的清洗。
    SegCase(name: "表格结构空白不进段",
            html: "<table>\n<tr>\n<td>甲</td>\n<td>乙</td>\n</tr>\n</table>",
            seq: ["甲 乙", "甲", "乙"], wants: [0, 1, 1], pairs: [], fallback: false, wantSegs: 2),
    // ⑦ `<pre>` 里的换行是**可见内容**（`white-space` 保留它）⇒ ⛔ 不是排版空白。
    //    ⚠️⚠️ **夹具必须是"独立的全空白文本节点"**，⛔ 不是 `<code>a\n\nb</code>` 那一整块。
    //    理由两条，都经变异测试验过：
    //      ① `isLayoutWhitespace` 判的是"**整段**全空白"——`"a\n\nb"` 本来就返回 false，
    //         拿它当夹具的话，"忽略 `inPre`"这个变异**一条都测不出来**（实跑：变红 0 条）；
    //      ② 真实的 `comrak` 输出**正是**这种形状：开了语法高亮之后代码被包进 `<span>`，
    //         行间的空行就成了**自己的一个全空白文本节点**（`design/0007`）。
    //    ⇒ 判据仍是**段数 = 1**（`\n\n` 若被当成截断点，`a` 与 `b` 会分成两段）。
    SegCase(name: "pre 里的换行是内容",
            html: "<pre><code><span>a</span>\n\n<span>b</span></code></pre>",
            seq: ["a", "b"], wants: [1, 1], pairs: [], fallback: false, wantSegs: 1),
    // ⑧ ⛔ 这一条**不能被截断点误伤**：`<strong>` 是行内元素，不切。
    SegCase(name: "跨行内元素仍是一段",
            html: "<p>rmd <strong>打开快</strong>，索引与回滚</p>",
            seq: ["打开快", "rmd 打开快"], wants: [1, 1], pairs: [], fallback: false, wantSegs: 1),
    // ⑨ `R2` + `INV-FIND-01`：清空 → 再搜同一词，**命中集合逐项相等**（强制走回退路线）。
    SegCase(name: "回退路线_清空再搜同一词",
            html: "<p>rmd 打开快，索引与回滚</p>",
            seq: ["打开快", nil, "打开快"], wants: [1, 0, 1], pairs: [[2, 0]], fallback: true, wantSegs: 1),
    // ⑩ `R2`：A → B → 清空 → A，⛔ 不出现"第三次才错"的累积漂移（同一个文本节点里 A 有 2 处）。
    //    ⚠️ `回滚` 在这句里**也是 2 处**（`与回滚：` / `，回滚是乙`）——
    //    初版这里写 1 是**数错了**，探针当场把它判红（见 §10）；⛔ 不是实现的问题。
    SegCase(name: "回退路线_A到B到A不漂移",
            html: "<p>索引与回滚：索引是甲，回滚是乙</p>",
            seq: ["索引", "回滚", nil, "索引"], wants: [2, 2, 0, 2], pairs: [[3, 0]], fallback: true, wantSegs: 1),
]

/// 把任意字符串变成**合法的 JS 字面量**（走 JSON，换行/引号/中文都由它负责）。
private func jsLiteral(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [s])
    let arr = String(data: data, encoding: .utf8)!
    return String(arr.dropFirst().dropLast())
}

/// 两个**桩**（⚠️ 都不在被验的那条路径上，见文件头）。
private let JS_SEG_STUBS = """
window.rmd.keymap = {
  bindings: [],
  isComposingEvent: function () { return false; },
  matchEvent: function () { return null; },
};
window.rmd.settings = {
  registerOverlay: function () {},
  closeOtherOverlays: function () {},
  currentFocusOwner: function () { return null; },
  releaseFocusOwner: function () {},
};
"""

/// 建 DOM + 建浮层 + 打开（⛔ 搜索留给 CHECK，那要等索引建完）。
private func segPrepJS(_ i: Int) -> String {
    let c = SEG_CASES[i]
    let seq = "[" + c.seq.map { $0 == nil ? "null" : jsLiteral($0!) }.joined(separator: ",") + "]"
    let wants = "[" + c.wants.map(String.init).joined(separator: ",") + "]"
    let pairs = "[" + c.pairs.map { "[" + $0.map(String.init).joined(separator: ",") + "]" }.joined(separator: ",") + "]"
    return """
    (() => {
      if (window.__fb) { try { window.__fb.destroy(); } catch (e) {} window.__fb = null; }
      const doc = document.getElementById("doc");
      doc.innerHTML = \(jsLiteral(c.html));
      window.__snap = doc.textContent;
      window.__fb = window.rmd.findBar.createFindBar({
        getDoc: function () { return document.getElementById("doc"); },
        keymap: window.rmd.keymap,
        keyText: function () { return ""; },
        nextId: "edit.find-next",
        prevId: "edit.find-prev",
        isAvailable: function () { return true; },
        forceFallback: \(c.fallback ? "true" : "false"),
      });
      window.__out = { name: \(jsLiteral(c.name)), seq: \(seq), wants: \(wants), pairs: \(pairs),
                       fallback: \(c.fallback ? "true" : "false"), wantSegs: \(c.wantSegs.map(String.init) ?? "null"),
                       segments: 0, customHighlight: null, steps: [], stale: 0, rescan: 0 };
      window.__fb.open();
      return JSON.stringify({ name: window.__out.name, opened: window.__fb.isOpen() });
    })()
    """
}

/// 读结果并**下判断**（⭐ 判据在 JS 里，⛔ 不靠人看输出——与 `smoke-gui.sh` 同一条纪律）。
private let JS_SEG_CHECK = """
(() => {
  const out = window.__out, fb = window.__fb, doc = document.getElementById("doc");
  const F = window.rmd.find;
  const st0 = fb.state();
  out.segments = st0.segments;
  out.customHighlight = st0.customHighlight;

  function marks() { return doc.querySelectorAll("mark.rmd-find-hit, mark.rmd-find-current"); }
  function search(q) {
    const i = document.querySelector(".find-input");
    i.value = q == null ? "" : q;
    i.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function collect() {
    const st = fb.state();
    let texts = [];
    let src = "none";
    let live = true;
    if (st.customHighlight && typeof CSS !== "undefined" && CSS.highlights) {
      const hl = CSS.highlights.get(F.HL_ALL);
      if (hl) { try {
          const rs = Array.from(hl);
          texts = rs.map(function (r) { return r.toString(); });
          src = "highlight";
          // ⭐⭐ **高亮必须落在文档里的节点上**——这是 `R2` 那个缺陷（清完不重建 `pieces`）
          //      **唯一**能看见的地方：`normalize()` 把被合并掉的 Text 从文档里摘走，
          //      而 `Range` 建在**脱离文档**的节点上照样能 `toString()` 出正确的文字
          //      ⇒ "文字对、可是**一处都不亮**"。⚠️ 只比文字**抓不到它**（实测：变异后全绿）。
          for (let k = 0; k < rs.length; k++) {
            if (!doc.contains(rs[k].startContainer) || !doc.contains(rs[k].endContainer)) { live = false; break; }
          }
        } catch (e) { src = "highlight-枚举失败:" + e.name; }
      }
    }
    if (src === "none") { texts = Array.prototype.map.call(marks(), function (m) { return m.textContent; }); src = "mark"; }
    return { total: st.total, current: st.current, texts: texts, src: src, live: live,
             marks: marks().length, stale: st.staleRanges, rescan: st.rescanMisses,
             textSame: doc.textContent === window.__snap };
  }

  for (let i = 0; i < out.seq.length; i++) {
    search(out.seq[i]);
    const r = collect();
    r.q = out.seq[i];
    r.want = out.wants[i];
    out.steps.push(r);
    // ⭐ 这两个计数器**只许是 0**：它们非零就说明回退路线拿废引用/废偏移算过
    //    （`INV-FIND-01` ②、评审 `R2` 的原话）。⚠️ 它比"命中数对不对"**更早**报警。
    if (r.stale !== 0 || r.rescan !== 0) (out.fails || (out.fails = [])).push("step" + i + " 出现废引用");
  }
  out.stale = fb.state().staleRanges;
  out.rescan = fb.state().rescanMisses;

  // ── 判据 ──────────────────────────────────────────────────────────
  const fails = out.fails || [];
  const bad = function (msg) { fails.push(msg); };
  const show = function (a) { return JSON.stringify(a); };

  if (out.wantSegs != null && out.segments !== out.wantSegs)
    bad("段数 " + out.segments + "，期望 " + out.wantSegs);
  if (out.customHighlight === out.fallback) bad("高亮路线不符：customHighlight=" + out.customHighlight);

  for (let i = 0; i < out.steps.length; i++) {
    const s = out.steps[i];
    if (s.total !== s.want) bad("step" + i + "（" + show(s.q) + "）命中 " + s.total + "，期望 " + s.want);
    // ⭐ **高亮所在的那段可见文本 == 关键词**（`design/0011` §7 第 4 步）。
    //    渲染域方案里**唯一**能证明"偏移没错位"的东西；中文/Emoji 全靠它。
    if (s.total > 0) {
      if (s.texts.length !== Math.min(s.total, F.HIGHLIGHT_CAP))
        bad("step" + i + " 报 " + s.total + " 处却只亮出 " + s.texts.length + " 处");
      for (let k = 0; k < s.texts.length; k++)
        if (s.texts[k] !== s.q) bad("step" + i + " 第 " + (k + 1) + " 处读出来是「" + s.texts[k] + "」，期望「" + s.q + "」");
      // ⚠️⚠️ 这条判据**必须分路线**：`CSS.highlights` 那一档**按设计零 DOM 变更**
      //    （`INV-FIND-01` 的落点）⇒ 有命中而 `marks === 0` 是**正确**的。
      //    ⛔ 写成"有命中就必须有 <mark>"会把主路线判成失败——第一版就是这么写的，
      //    10 条反例当场全红（`design/0011` §10 记了这处）。
      //    ⇒ 走 `<mark>` 时才要求看得见标记；走 highlight 时"看得见"由上面那条 `texts` 长度判据管。
      if (s.src === "mark" && s.marks < 1) bad("step" + i + " 走 <mark> 路线却一个标记都没有");
      if (s.src === "highlight" && s.marks !== 0) bad("step" + i + " 走 CSS.highlights 却动了 DOM（" + s.marks + " 个 <mark>）");
      // ⭐ 文字对 ≠ 看得见：`R2` 那个缺陷正是这样躲过"只比文字"的判据的。
      if (!s.live) bad("step" + i + " 的高亮落在**已脱离文档**的节点上（废引用 ⇒ 一处都不亮）");
    } else if (s.q != null && s.marks !== 0) bad("step" + i + " 无命中却留下 " + s.marks + " 个标记");
    if (s.q == null && s.marks !== 0) bad("step" + i + " 清空后仍留下 " + s.marks + " 个标记");
    // ⭐ **正文一个字节都不许变**（`INV-FIND-01`）：`<mark>` 只换包裹，
    //    `textContent` 必须与打开前**逐字节相等**——每个 step 都要成立（含高亮着的时候）。
    if (!s.textSame) bad("step" + i + " 改变了正文文本");
    if (s.current !== (s.total > 0 ? 0 : -1)) bad("step" + i + " 当前下标 " + s.current);
  }
  for (const p of out.pairs) {
    const a = out.steps[p[1]], b = out.steps[p[0]];
    if (a.total !== b.total || a.current !== b.current || show(a.texts) !== show(b.texts))
      bad("step" + p[0] + " 与 step" + p[1] + " 不相等：" + show({ t: b.total, x: b.texts }) + " vs " + show({ t: a.total, x: a.texts }));
  }
  // ⚠️ 回退路线的路线自证：它**必须真的**用了 `<mark>`（否则这 3 条等于没测）。
  if (out.fallback) {
    const used = out.steps.some(function (s) { return s.src === "mark" && s.marks > 0; });
    if (!used) bad("声称走回退路线，却一个 <mark> 都没有");
  }
  out.ok = fails.length === 0;
  out.fails = fails;
  return JSON.stringify(out);
})()
"""

private let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800),
                                configuration: WKWebViewConfiguration())

private func runJS(_ js: String, label: String, then: @escaping () -> Void) {
    runJSResult(js, label: label) { _ in then() }
}

/// 同上一支，但把结果交回调用方（反例组要读 `ok`，⛔ 不靠人看输出）。
private func runJSResult(_ js: String, label: String, then: @escaping (Any?) -> Void) {
    let t = Date()
    webView.evaluateJavaScript(js) { result, error in
        let ms = Int(Date().timeIntervalSince(t) * 1000)
        if let error = error {
            FileHandle.standardError.write("⛔ \(label) 失败（\(ms) ms）：\(error)\n".data(using: .utf8)!)
            exit(1)
        }
        print("[\(label) · 墙钟 \(ms) ms] \(result as? String ?? String(describing: result))")
        fflush(stdout)
        then(result)
    }
}

/// ⚠️ **必须在文件作用域**：`FindProbeDelegate` 里有两个 `webView(_:…)` **方法**，
/// 在类作用域内写 `webView` 解析到的是**方法**（`use of 'webView' refers to instance method`），
/// 而这几行要的是模块级那个 `let webView`。⇒ 绕一层，⛔ 不改成 `main.webView`（那更脆）。
private func probeLoadHTML(_ html: String) {
    webView.loadHTMLString(html, baseURL: URL(string: "https://rmd.local/"))
}

private func js(_ src: String, rows: Int) -> String {
    src.replacingOccurrences(of: "%ROWS%", with: String(rows))
       .replacingOccurrences(of: "%CELLS%", with: "4")
}

// ── 把**真的**两个前端文件从磁盘读进来（路径由 `#filePath` 推，⛔ 不硬编码用户名）──
private let REPO_ROOT = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

private func readSrc(_ rel: String) -> String {
    let url = REPO_ROOT.appendingPathComponent(rel)
    guard let s = try? String(contentsOf: url, encoding: .utf8) else {
        FileHandle.standardError.write("⛔ 读不到 \(url.path)\n".data(using: .utf8)!); exit(1)
    }
    return s
}

/// 反例组跑的那张页：`#doc` ＋ 真 `find.js` ＋ 两个桩 ＋ 真 `FindBar.js`。
/// ⚠️ 顺序是硬要求（`FindBar.js` 在**加载期**把三个东西取成常量），与 `index.html` 同一条纪律。
private func segPage() -> String {
    """
    <!doctype html><meta charset="utf-8">
    <body style="font:14px -apple-system;margin:0">
    <div id="doc"></div>
    <script>window.rmd = {};</script>
    <script>\(readSrc("src/services/find.js"))</script>
    <script>\(JS_SEG_STUBS)</script>
    <script>\(readSrc("src/components/FindBar.js"))</script>
    </body>
    """
}

/// 反例组的失败计数（⭐ 进**退出码**：这条闸门要能被 `make` 辨认，⛔ 不是"打出来给人看"）。
private var segFailures = 0

private final class FindProbeDelegate: NSObject, WKNavigationDelegate {
    // ⚠️ 与批 2 同口径：**一档一次、多轮取中位数**（单轮的低频噪声在这台机器上不小）
    private let tiers = [2000, 8000, 25000, 100000]
    /// 反例组要不要跑（`SEGS=0` 关掉，只跑 0a/0c 那三组）。
    private let runSegs = (ProcessInfo.processInfo.environment["SEGS"] ?? "1") != "0"
    /// ⚠️ 反例组要 `#doc` 与真前端文件 ⇒ 它跑在**另一张页**上；
    ///    而换页会**再一次**触发 `didFinish` ⇒ 没有这个旗标，性能链会无限重跑。
    private var stage = 0

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        FileHandle.standardError.write("· didFinish（stage=\(stage)）\n".data(using: .utf8)!)
        if stage == 1 { segCase(0); return }
        stage = 1
        let rounds = Int(ProcessInfo.processInfo.environment["ROUNDS"] ?? "1") ?? 1
        runJS(JS_CAP, label: "0a 能力") { self.tier(1, 0, rounds) }
    }

    // ── 0c：分档计时（三组，同步 JS，与 `alphaValue` 无关）─────────────────
    private func tier(_ r: Int, _ i: Int, _ rounds: Int) {
        guard r <= rounds else { return finishPerf() }
        guard i < tiers.count else { return breakdown(r, rounds) }
        runJS(js(JS_INDEX, rows: tiers[i]), label: "0c-\(tiers[i])行 r\(r)") { self.tier(r, i + 1, rounds) }
    }
    private func breakdown(_ r: Int, _ rounds: Int) {
        runJS(js(JS_BREAKDOWN, rows: 100000), label: "拆解-100000行 r\(r)") { self.textIdx(r, rounds) }
    }
    private func textIdx(_ r: Int, _ rounds: Int) {
        runJS(js(JS_TEXTIDX, rows: 100000), label: "A3-textContent-100000行 r\(r)") { self.textIdx2(r, rounds) }
    }
    private func textIdx2(_ r: Int, _ rounds: Int) {
        runJS(js(JS_TEXTIDX2, rows: 100000), label: "A4-memo+textContent-100000行 r\(r)") {
            if r < rounds { self.tier(r + 1, 0, rounds) } else { self.finishPerf() }
        }
    }

    /// 性能三组跑完：换到反例组那张页（`SEGS=0` 时直接收工）。
    private func finishPerf() {
        guard runSegs else { exit(0) }
        // ⭐ 反例组跑在**可见**窗口里（与 0a/0c 那三组不同）：
        //    WebKit 在 `alphaValue = 0` 的窗口里**可能根本不发 rAF**，而分段构建正靠它。
        //    ⚠️ 换页触发的 `didFinish` 会带着 `stage=1` 回来，走上面那一支。
        window.alphaValue = 1
        probeLoadHTML(segPage())
    }

    // ── 反例组：PREP（建 DOM + 开浮层）→ 等一帧 → CHECK（读结果 + 判据）──
    // ⚠️ 那 0.25 s 就是"让 `requestAnimationFrame` 的**分段构建**跑完"。
    private func segCase(_ i: Int) {
        guard i < SEG_CASES.count else {
            FileHandle.standardError.write(
                (segFailures == 0 ? "✅ 反例组 \(SEG_CASES.count)/\(SEG_CASES.count) 通过\n"
                                  : "⛔ 反例组 \(segFailures)/\(SEG_CASES.count) 条没过\n").data(using: .utf8)!)
            exit(segFailures == 0 ? 0 : 1)
        }
        let n = i + 1
        runJS(segPrepJS(i), label: "反例\(n)-PREP \(SEG_CASES[i].name)") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                runJSResult(JS_SEG_CHECK, label: "反例\(n)-CHECK") { r in
                    // ⭐ 判据在 JS 里（⛔ 不靠人看输出），这里只把 `ok` 收进退出码。
                    if let s = r as? String, let data = s.data(using: .utf8),
                       let obj = try? JSONSerialization.jsonObject(with: data),
                       let d = obj as? [String: Any], (d["ok"] as? Bool) == false {
                        segFailures += 1
                    }
                    self.segCase(n)
                }
            }
        }
    }

    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) {
        FileHandle.standardError.write("⛔ 导航失败：\(e)\n".data(using: .utf8)!); exit(1)
    }
}

let app = NSApplication.shared
// ⚠️⚠️ **`.prohibited`，⛔ 不是 `.accessory`**（`kb/0025` ＋ 2026-10-21 实测）：
//    `.accessory` 只是"没有 Dock 图标"，**仍会被激活**——从正在前台的终端里起进程时，
//    实测 `frontmostApplication` 会从 `iTerm2` 变成探针自己。本探针不依赖焦点/键盘，
//    ⇒ 换 `.prohibited`（结构上不允许被激活），代价为零。
_ = app.setActivationPolicy(.prohibited)
private let delegate = FindProbeDelegate()
webView.navigationDelegate = delegate
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                      styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView
window.alphaValue = 0
webView.loadHTMLString("<!doctype html><meta charset=\"utf-8\"><body style=\"font:14px -apple-system\"><p>探测中…</p></body>", baseURL: nil)
DispatchQueue.main.asyncAfter(deadline: .now() + 600) {
    FileHandle.standardError.write("⛔ 600 秒兜底\n".data(using: .utf8)!); exit(1)
}
// ⚠️ 探针自己带兜底，所以不需要外层 `timeout`（macOS 也没有那东西，是 `gtimeout`）
app.run()
