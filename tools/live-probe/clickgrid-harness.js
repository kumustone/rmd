// ⭐ **点击网格扫描**（`docs/tasks.md` T45 提案 ③）——"快速系统地发现 bug"的第二件工具。
//
// 它回答的问题与 `block-harness.js` **不同**：
//   · `block-harness` 验的是**指定动作**（进入 / 退出 / 打勾 / 提交）后的**指定判据**；
//   · 本文件**不预设动作**——它把正文按 x/y 切成一张网格，逐点真点一下，
//     然后检查**五条与动作无关的后置不变量**（T45 提案 ①）：
//       ① 没有未捕获异常；
//       ② 顶层块数不变（变化只允许由"真的提交"解释）；
//       ③ 点完不留覆盖层（`editable=0` 的块更是一条都不许开）；
//       ④ 被点那一块的**文档坐标位置**位移 ≤ 0.5 px（`bugs/0077` 那一族的通用形态；
//          ⚠️ 2026-11-09 由 2 px 收紧，0.5 只当量化下限），且**块高不变**
//          （`INV-LIVE-04` ①：进入瞬间逐像素不动，⛔ 不许再以"块高变了"当免判理由）；
//       ⑤ 没有越界的 IPC（`window.__UNKNOWN` 不许增长）。
//
// ⚠️ **一次页面只点一个点**（`window.__POINT` 由 `__point.js` 注入）：点一下可能进编辑、
//    可能提交、可能改正文，留在同一页里点第二下，测的就是"上一轮改过的那棵树"了。
//    页面由 shell 逐点重开 ⇒ 每个红点都能**单独复现**。
//
// ⚠️ 它跑的是**真应用**（`src/index.html` ＋ 全部 `src/**`），后端是 `fake-tauri.js`
//    （回 Stage A 用真 comrak 导出的载荷）。⛔ 探针不重写 `main.js` / `live/**`。
// ⚠️ 假后端**不渲染 Markdown** ⇒ "提交之后正文长什么样"缺一半；因此本工具只据
//    **几何 / DOM / IPC / 异常**判，⛔ 不判提交后的文本正确性（那是 V 段的事）。
// ⚠️ 离屏、不弹窗、不抢焦点：窗口由 `probe.swift` 那边 `alpha=0` ＋ `.prohibited` 建成，
//    页内只派发不可信 DOM 事件。
(function () {
  'use strict';

  const HOST_SEL = '.cm-rmd-liveHost';
  const INPUT_SEL = 'textarea.cm-rmd-input';
  // ⛔⛔ **2026-11-09：从 2 px 收到 0.5 px**（原注"与 `bugs/0077` §6 同口径"已作废）。
  //    2 px 的来历是"视口位移量一眼看不出来"，而 `INV-LIVE-04` ①（`design/0047` §5）
  //    要求进入瞬间**逐像素不变** ⇒ 2 px 会把真实跳动判绿。0.5 px 只当**量化下限**（同一个像素），
  //    ⛔ 不是"允许半像素漂移"。
  //    ⚠️ 历史结果按 2 px 记的，⛔ 不能拿来当"这一格没问题"的证据；重跑才算。
  const TOL = 0.5;

  const out = { 行: [], 环境: {}, 文档: (window.__FIXTURE && window.__FIXTURE.name) || '?' };

  let 兜底毫秒 = 100;
  let rAF兜底 = 0;
  function frame() {
    return new Promise(function (r) {
      let done = false;
      const fin = function (v) { if (!done) { done = true; r(v); } };
      try { window.requestAnimationFrame(function () { fin('raf'); }); } catch (e) { void e; }
      setTimeout(function () { if (!done) { rAF兜底++; fin('timeout'); } }, 兜底毫秒);
    });
  }
  async function frames(n) { for (let i = 0; i < n; i++) await frame(); }

  async function waitFor(fn, ms) {
    const t0 = performance.now();
    while (performance.now() - t0 < (ms || 3000)) {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await frame();
    }
    return null;
  }

  function docEl() { return document.getElementById('doc'); }
  function 计数(cmd) {
    const c = (window.__FAKE && window.__FAKE.counts) || {};
    return c[cmd] || 0;
  }
  function 主机数(d) { return d.querySelectorAll(HOST_SEL).length; }
  function 输入框数() { return document.querySelectorAll(INPUT_SEL).length; }

  /**
   * 焦点是不是在**编辑面**上。
   * ⚠️ 编辑面有**两处**：CM6 的宿主（`.cm-rmd-liveHost`）与 IME 组合串那个
   *    `textarea.cm-rmd-input`（`bugs/0060`）。后者是宿主的**兄弟**、不在宿主里面
   *    ⇒ 只判 `host.contains(activeElement)` 会把"键盘已经能打字"误判成"点了没反应"
   *    （2026-11-04 实测：进编辑后 `activeElement` 正是 `textarea.cm-rmd-input`）。
   */
  function 在编辑面(el) {
    if (!el || !el.closest) return false;
    if (el.closest(HOST_SEL)) return true;
    return !!(el.matches && el.matches(INPUT_SEL));
  }

  /** 页面当前实际滚到哪儿（⚠️ 阅读态宿主是窗口，`#doc` 也可能是宿主 —— 两处都读）。 */
  function 滚动量(d) {
    const ev = document.scrollingElement || document.documentElement;
    return {
      根: Math.round(ev ? ev.scrollTop : 0),
      体: Math.round(document.body ? document.body.scrollTop : 0),
      文: Math.round(d ? d.scrollTop : 0),
    };
  }

  /**
   * 把载荷里的**线格式块表**摊成"与 `#doc` 顶层子节点一一对应"的 `editable` 数组。
   *
   * ⚠️ 块表是 `[kind_idx, start, end, editable]` 的数组（`document/blocks.rs::to_wire`），
   *    ⛔ 不是对象 —— 写成 `p.blocks[i].editable` 恒得 `undefined`，于是"`editable=0`
   *    的块不许进编辑"这条判据会**恒真**（永远不红）。
   * ⚠️ 唯一会错位的是**脚注定义**：块表按源码顺序排它们，而 comrak 把内容合并到文末
   *    那一个 `<section data-footnotes>` 里 ⇒ 块表里的定义块 `rest` **之后**，
   *    DOM 里对应的却是**最后那一个 section**。这里只做这一处对齐，⛔ 不复刻别的。
   */
  function 块表Editable(p) {
    const kinds = p.block_kinds || [];
    const list = p.blocks || [];
    const rest = [];
    let defs = 0;
    for (let i = 0; i < list.length; i++) {
      if (kinds[list[i][0]] === 'FootnoteDefinition') defs++;
      else rest.push(list[i]);
    }
    return { list: rest, defs: defs };
  }

  /** 版面稳定：连续 3 帧 `#doc` 的 scrollHeight 与块顶序列都不变。 */
  async function 等版面稳定() {
    let last = '';
    for (let i = 0; i < 40; i++) {
      await frame();
      const d = docEl();
      const sig = d.scrollHeight + '|' + 块节点(d).map(function (c) {
        // ⚠️ 注释节点没有盒子 ⇒ 用一个**恒定位**占住它的槽位，⛔ 不把它从序列里删掉
        //    （删了之后签名就与块下标脱钩，前后两次比较的可能是不同的块）。
        return c.nodeType === 1 ? Math.round(c.getBoundingClientRect().top) : 'x';
      }).join(',');
      if (sig === last) return true;
      last = sig;
    }
    return false;
  }

  /**
   * 点总数 = **所有**顶层块 × 3×3。
   * ⚠️ 不是"视口内那几块"：`elementFromPoint` 只对视口内有效，但那是**取坐标之后**
   *    的事——每个点先把这个块 `scrollIntoView` 到视口中央，再取它自己那 3×3。
   *    （旧版只扫视口内 ⇒ 一份 12 块的文档只扫得到 1 块，等于没扫。）
   */
  /**
   * 点总数 = **元素目标**（小目标优先）＋ 所有顶层块 × 3×3。
   *
   * ⭐ **按块交错**（2026-11-04 改）：先是第 0 块自己的元素目标、再是第 0 块的 9 个网格点，
   *    然后第 1 块……⚠️ 旧版把**全部**元素目标排在前面（"小目标优先"），在真文档上退化：
   *    `docs/tasks.md` 那张表的 `td` 就有几百个 ⇒ `--max/--stride` 抽到的**全是表格格**，
   *    一个网格点都扫不到，而报告上看起来"扫了 108 个点"。按块交错之后，**任何连续
   *    前缀都覆盖整篇**，抽样才有意义。
   */
  let 计划缓存 = null;
  function 点计划(d) {
    if (计划缓存 && 计划缓存.d === d) return 计划缓存.list;
    const list = [];
    const 按块 = [];
    const els = 元素集(d);
    for (let i = 0; i < els.length; i++) {
      const b = 块序号(d, els[i]);
      if (b < 0 || b >= 块节点(d).length) continue;
      if (!按块[b]) 按块[b] = [];
      按块[b].push(els[i]);
    }
    const 节点 = 块节点(d);
    for (let b = 0; b < 节点.length; b++) {
      const own = 按块[b] || [];
      for (let i = 0; i < own.length; i++) list.push({ el: own[i], 块: b });
      // ⚠️ 注释节点（`INV-SEC-01` 下的块级原始 HTML）**没有盒子** ⇒ 不排网格点；
      //    给它排 9 个点只会得到 9 条"块滚不到视口里"的跳过，把分母灌水。
      if (节点[b].nodeType !== 1) continue;
      for (let s = 0; s < 9; s++) list.push({ 块: b, sub: s });
    }
    计划缓存 = { d: d, list: list };
    return list;
  }

  function 总点数(d) { return 点计划(d).length; }

  /** 元素目标（`docs/tasks.md` T45 提案 ③ 的后半句："每个块类型按 x ... 与 y ..."）：
   *  3×3 网格会**整片漏掉**小目标——任务方框（`bugs/0077` 就出在那儿）、标题锚点、
   *  链接、图片、`<summary>`、表格格。⇒ 网格之外再逐个点它们的**中心**。 */
  function 元素集(d) {
    const sel = 'input[type=checkbox], a[href], img, summary, td, th';
    const out = [];
    const nodes = d.querySelectorAll(sel);
    for (let i = 0; i < nodes.length; i++) out.push(nodes[i]);
    return out;
  }

  /**
   * `#doc` 的**顶层块节点**：元素 ＋ 注释（`bugs/0080`）。
   *
   * ⚠️⚠️ 块表（`p.blocks`）**含 `HtmlBlock`**，而 `INV-SEC-01` 下它渲染成
   *    `<!-- raw HTML omitted -->` **注释** ⇒ 只数 `d.children` 会让下标从第一个
   *    HTML 块之后整体**错一格**。2026-11-04 实测：`rawhtml` 夹具 18 个假红，
   *    全是「`editable=0` 的块进了编辑」——判到的其实是**下一块**。
   * ⭐ 取法与产品**同源**（`window.rmd.liveBlocks.topNodes`），⛔ 不各写一份。
   */
  function 块节点(d) {
    const LB = window.rmd && window.rmd.liveBlocks;
    if (LB && typeof LB.topNodes === 'function') return LB.topNodes(d);
    const out = [];
    if (!d || !d.childNodes) return out;
    for (let i = 0; i < d.childNodes.length; i++) {
      const n = d.childNodes[i];
      if (n && (n.nodeType === 1 || n.nodeType === 8)) out.push(n);
    }
    return out;
  }

  /** 第 `i` 个**块节点**的视口盒子；注释节点没有 `getBoundingClientRect` ⇒ 回 `null`。 */
  function 块盒(d, i) {
    const n = 块节点(d)[i];
    return n && n.nodeType === 1 ? n.getBoundingClientRect() : null;
  }

  /** 顶层块序号（元素目标用）：元素属于 `#doc` 的哪一个**块节点**（含注释）。 */
  function 块序号(d, el) {
    let n = el;
    while (n && n.parentNode !== d) n = n.parentNode;
    return n ? 块节点(d).indexOf(n) : -1;
  }

  function 述(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '?';
    const cls = el.className && typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/)[0] : '';
    const ty = el.getAttribute && el.getAttribute('type');
    return tag + (ty ? '[type=' + ty + ']' : '') + cls;
  }

  /**
   * 第 `idx` 个点：先滚到那个块，再按它**与视口的交集**切 3×3。
   * ⚠️ 块比视口高时用交集，不用整块 —— 否则算出来的 y 落在视口外，钳回来就点到**别的块**上。
   */
  async function 点坐标(d, idx) {
    const 计划 = 点计划(d);
    const it = 计划[idx];
    if (!it) return { 跳过: '没有第 ' + idx + ' 个点' };
    if (it.el) {
      const el = it.el;
      try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) {
        try { el.scrollIntoView(); } catch (e2) { void e2; }
      }
      await frames(2);
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return { 块: it.块, 目标: 述(el), 跳过: '元素没有可点面积' };
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cy < 0 || cy >= window.innerHeight || cx < 0 || cx >= window.innerWidth) {
        return { 块: it.块, 目标: 述(el), 跳过: '元素滚不到视口里' };
      }
      return { 块: it.块, 目标: 述(el),
        x: Math.round(cx), y: Math.round(cy), 位置: '元素' };
    }
    const bi = it.块;
    const sub = it.sub;
    const el = 块节点(d)[bi];
    if (!el) return { 跳过: '没有第 ' + bi + ' 块' };
    if (el.nodeType !== 1) return { 块: bi, 跳过: '注释节点没有可点盒子（`INV-SEC-01`）' };
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) {
      try { el.scrollIntoView(); } catch (e2) { void e2; }
    }
    await frames(2);
    const r = el.getBoundingClientRect();
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const left = Math.max(r.left, 0);
    const right = Math.min(r.right, window.innerWidth);
    if (bottom - top < 8 || right - left < 8) return { 块: bi, 跳过: '块滚不到视口里' };
    const w3 = (right - left) / 3;
    const h3 = (bottom - top) / 3;
    const xs = [left + Math.min(6, w3), (left + right) / 2, right - Math.min(6, w3)];
    const ys = [top + Math.min(4, h3), (top + bottom) / 2, bottom - Math.min(4, h3)];
    const row = Math.floor(sub / 3);
    return {
      块: bi,
      x: Math.round(Math.min(window.innerWidth - 1, Math.max(0, xs[sub % 3]))),
      y: Math.round(Math.min(window.innerHeight - 1, Math.max(0, ys[row]))),
      位置: 'r' + row + 'c' + (sub % 3),
    };
  }

  /**
   * 点下面**那一个字符**是什么。
   *
   * ⭐ 这是"我点的那一处还在不在原地"的**用户口径**：块顶移动几像素本身不是缺陷
   *    （`INV-KERNEL-05` 允许下方内容移动），**手指下面换成了别的字**才是。
   * ⚠️ WKWebView 有 `caretRangeFromPoint`；别的环境有 `caretPositionFromPoint`，
   *    两样都没有就返回 `null`（⛔ 不猜）。
   */
  function 点处字符(x, y) {
    let r = null;
    try {
      if (document.caretRangeFromPoint) r = document.caretRangeFromPoint(x, y);
      else if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) r = { startContainer: p.offsetNode, startOffset: p.offset };
      }
    } catch (e) { void e; }
    if (!r || !r.startContainer || r.startContainer.nodeType !== 3) return null;
    const t = r.startContainer.data || '';
    const i = r.startOffset;
    const ch = i < t.length ? t.charAt(i) : (i > 0 ? t.charAt(i - 1) : '');
    // ⭐ 这一处的**屏幕纵坐标**：塌缩 range 的矩形就是光标框。它比"字号对不对"精确得多——
    //    同一个字在不同行高下可以落在同一个 y 上，而"手指下面那一处"有没有动只能看矩形。
    let 顶 = null;
    try {
      const g = r.getBoundingClientRect ? r.getBoundingClientRect() : null;
      if (g && (g.height > 0 || g.width > 0)) 顶 = Math.round(g.top * 100) / 100;
    } catch (e) { void e; }
    return { 字符: ch, 偏移: i, 顶: 顶, 上下文: t.slice(Math.max(0, i - 6), i + 6) };
  }

  /**
   * 两个顶层块之间的竖直空隙（点它 = `onLiveDocDown` 的 `leaveAway('blank')` 那一支）。
   *
   * ⚠️⚠️ 必须验 `elementFromPoint` **落回 `#doc` 里面**：顶栏是 `position: sticky`
   *    （`z-index: 10`，`style.css` 的 `.topbar`）⇒ 落在窗口顶部那条缝隙上的点，
   *    命中的是**工具栏**，`onLiveDocDown` 根本不会被调用，覆盖层自然还在。
   *    2026-11-04 实测：真文档里 29 个"点空白后仍留覆盖层"全出自 y≈29–48 这一条
   *    ——是**探针点错了地方**，⛔ 不是产品缺陷。
   */
  function 找空隙(d) {
    const cs = 块节点(d).filter(function (n) { return n.nodeType === 1; });
    for (let i = 0; i + 1 < cs.length; i++) {
      const a = cs[i].getBoundingClientRect();
      const b = cs[i + 1].getBoundingClientRect();
      if (b.top - a.bottom < 6) continue;
      const y = Math.round((a.bottom + b.top) / 2);
      if (y <= 1 || y >= window.innerHeight - 1) continue;
      const xs = [a.left + 40, a.left + 8, (a.left + a.right) / 2];
      for (let k = 0; k < xs.length; k++) {
        const x = Math.round(Math.min(window.innerWidth - 1, Math.max(0, xs[k])));
        if (x <= 1 || x >= window.innerWidth - 1) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && d.contains(hit)) {
          return { x: x, y: y, 命中: 述(hit) };
        }
      }
    }
    return null;
  }

  /**
   * 编辑态里**光标所在那一行**的文本（`null` = 拿不到）。
   *
   * ⚠️ 为什么需要它：⑨ 只知道"点处那个字被推走了"，分不清两种原因——
   *    ① 光标落错了行（`focusAt` 把点映射到上一行），`anchorAt` 忠实地把**那一行**
   *       钉回锚点 ⇒ 整块被推一行，点处文字跟着走；
   *    ② 光标落对了，是**锚点基线**自己差一行。
   *    两者的修法完全不同，所以要把"光标在哪一行"量出来。
   * ⚠️ 只读 `.cm-cursor`（CM6 画的光标）的父行；⛔ 不碰输入框的 `selectionStart`
   *    （那个偏移相对的是**当前行**，语义随实现变，不是稳定真值）。
   */
  /**
   * 编辑态里光标的位置：`{行号, 列, 行文本}`（`null` = 拿不到）。
   *
   * ⚠️ 为什么需要它：⑨ 只知道"点处那个字被推走了"，分不清两种原因——
   *    ① 光标落错了行（`focusAt` 把点映射到上一行），`anchorAt` 忠实地把**那一行**
   *       钉回锚点 ⇒ 整块被推一行，点处文字跟着走；
   *    ② 光标落对了，是**锚点基线**自己差一行。
   *    两者的修法完全不同，所以要把"光标在哪一行"量出来。
   * ⚠️ ⛔ 不读 `.cm-cursor`：`contentDOM` 永不聚焦（`INV-LIVE-12`）⇒ CM6 认为没焦点，
   *    根本不画光标（2026-11-04 实测：一个都没有，`null`）。
   * ⚠️ 走 `EditorView.findFromDOM`（CM6 自带的静态入口），拿的是**真编辑器状态**；
   *    探针因此与产品共用同一个 view，⛔ 不另建一份。
   */
  function 光标信息() {
    try {
      const CM = window.rmdCM6;
      const hostEl = document.querySelector('.cm-rmd-liveHost');
      if (!CM || !CM.EditorView || !hostEl) return null;
      const el = hostEl.querySelector('.cm-editor') || hostEl;
      const V = CM.EditorView.findFromDOM(el);
      if (!V || !V.state) return null;
      const head = V.state.selection.main.head;
      const line = V.state.doc.lineAt(head);
      return { 行号: line.number, 列: head - line.from, 行文本: line.text };
    } catch (e) { void e; }
    return null;
  }

  /** 一次真点：`mousedown` → `mouseup` →（控件走原生 `.click()` 才有 activation）。 */
  function 点一下(el, x, y) {
    const 基 = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, 基)));
    el.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0 }, 基)));
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'label' || tag === 'button' || tag === 'a') el.click();
    else el.dispatchEvent(new MouseEvent('click', 基));
  }

  /**
   * 等到"没有新的 IPC、也没有新的 DOM 变更"连续 200 ms。
   * ⚠️ 不用固定 sleep：`read_asset` / `render_preview` 的往返长短不一，固定值会
   *    要么漏掉迟到的重排，要么让 90 个点跑成几十分钟。
   */
  async function 等静默(ms) {
    const d = docEl();
    let last = performance.now();
    let lastIPC = (window.__IPC || []).length;
    const ob = new MutationObserver(function () { last = performance.now(); });
    ob.observe(d, { subtree: true, childList: true, attributes: true, characterData: true });
    const 起点 = performance.now();
    try {
      while (performance.now() - 起点 < 2500) {
        const n = (window.__IPC || []).length;
        if (n !== lastIPC) { lastIPC = n; last = performance.now(); }
        if (performance.now() - last >= (ms || 200)) break;
        await frame();
      }
    } finally { ob.disconnect(); }
    return performance.now() - 起点;
  }

  window.__RUN = async function () {
    const t0 = performance.now();

    // ── 环境自证：连续 8 帧一次都没来 ⇒ 本轮数字作废（不是产品缺陷） ──
    let raf = 0;
    for (let i = 0; i < 8; i++) if ((await frame()) === 'raf') raf++;
    out.环境.帧健康 = raf + '/8';
    if (raf === 0) {
      out.环境.说明 = 'rAF 一次都没触发（屏幕锁 / 显示器睡眠 / 页面被冻结）⇒ 本轮作废';
      return out;
    }

    const p = await waitFor(function () { return window.__rmd && window.__rmd.payload; }, 15000);
    if (!p) {
      out.致命 = '应用没启动（等不到 window.__rmd.payload）';
      out.环境.加载期错误 = window.__LOADERR || [];
      return out;
    }
    await frames(2);
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { void e; }
    const 稳 = await 等版面稳定();
    out.环境.版面稳定 = 稳;

    const d = docEl();
    const idx = window.__POINT | 0;
    out.共 = 总点数(d);
    out.点序号 = idx;
    if (idx < 0 || idx >= out.共) {
      out.致命 = '点序号越界（共 ' + out.共 + '）';
      return out;
    }
    const pt = await 点坐标(d, idx);
    if (pt.跳过) {
      out.点 = pt;
      out.结果 = { 状态: '跳过', 原因: pt.跳过 };
      return out;
    }
    out.点 = pt;
    if (pt.块 < 0) {
      out.结果 = { 状态: '跳过', 原因: '元素不挂在 #doc 的顶层子节点下' };
      return out;
    }

    const el = document.elementFromPoint(pt.x, pt.y);
    if (!el || !d.contains(el)) {
      out.结果 = { 状态: '跳过', 原因: 'elementFromPoint 没命中正文（点在空白/浮层上）' };
      return out;
    }
    out.命中 = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
      (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/)[0] : '');

    // ── 基线 ──
    const 块表 = 块表Editable(p);
    const 块数0 = 块节点(d).length;
    const 盒0 = 块盒(d, pt.块);
    const y0 = 盒0 ? 盒0.top : NaN;
    const h0 = 盒0 ? 盒0.height : NaN;
    const 滚0 = 滚动量(d);
    const 页高0 = document.documentElement ? document.documentElement.scrollHeight : 0;
    // ⭐ 文档坐标下的块顶：`视口 top ＋ 滚动量`。它**不受滚动影响** ⇒ 能把
    //    "内容在上面重排了"（真位移）与"页面只是滚了一下"（U6 的锚定副作用）分开。
    const 顶0 = isFinite(y0) ? Math.round((y0 + 滚0.体) * 100) / 100 : null;
    const ipc0 = (window.__IPC || []).length;
    const err0 = (window.__ERR || []).length;
    const unk0 = (window.__UNKNOWN || []).length;
    const commit0 = 计数('render_preview');
    const begin0 = 计数('begin_edit');
    // ⚠️ 对不上就是**载荷与 DOM 不是同一份**（脚注对齐那一处之外）⇒ 这一点的判红没有意义，
    //    记为跳过，⛔ 不猜。
    const 块行 = pt.块 < 块表.list.length ? 块表.list[pt.块] : null;
    if (!块行) {
      out.结果 = { 状态: '跳过',
        原因: '点到的顶层节点没有对应块行（块表 ' + 块表.list.length + ' 块 / 脚注定义 ' +
          块表.defs + ' / DOM ' + 块数0 + ' 个）' };
      return out;
    }
    const 块类名 = (p.block_kinds && p.block_kinds[块行[0]]) || '';
    const editable = !!块行[3];
    // ⭐ **例外只开一条**：`Table` 块本身 `editable = 0`，但**单元格编辑是另一条入口**
    //    （`design/0049`；`main.js::onLiveDocDown` 里那段注释写得很明确：⛔ 不是把 Table
    //    挪进白名单）。⇒ 点在 `td/th` 里且块类是 `Table` 时，`begin_edit` 与覆盖层都合法。
    //    ⚠️ 别的结构块（分隔线 / HTML 块 / 代码块之外的）没有这条豁免，仍照常判红。
    const 走单元格 = 块类名 === 'Table' && !!(el.closest && el.closest('td,th'));

    // ── 点 ──
    const 事前 = 点处字符(pt.x, pt.y);
    点一下(el, pt.x, pt.y);
    const 静默ms = await 等静默(200);

    // ── 五条后置不变量 ──
    const 块数1 = 块节点(d).length;
    const 盒1 = 块盒(d, Math.min(pt.块, 块数1 - 1));
    const y1 = 盒1 ? 盒1.top : NaN;
    const h1 = 盒1 ? 盒1.height : NaN;
    const 滚1 = 滚动量(d);
    const 页高1 = document.documentElement ? document.documentElement.scrollHeight : 0;
    const 顶1 = isFinite(y1) ? Math.round((y1 + 滚1.体) * 100) / 100 : null;
    const errD = (window.__ERR || []).slice(err0);
    const unkD = (window.__UNKNOWN || []).slice(unk0);
    const commitD = 计数('render_preview') - commit0;
    const beginD = 计数('begin_edit') - begin0;
    const 覆盖层 = 主机数(d);
    const 输入框 = 输入框数();
    // 点完之后**同一个屏幕坐标**下面是什么 —— 用户会不会"手指位置没动、内容换了"。
    const 事后 = document.elementFromPoint(pt.x, pt.y);
    const 事后块 = 事后 && d.contains(事后) ? 块序号(d, 事后) : -1;
    // ⭐ 点处那个字变没变（用户口径：手指下面还是不是原来那个字）。
    const 词前 = 事前 ? 事前.字符 : null;
    const 词后取 = 点处字符(pt.x, pt.y);
    const 词后 = 词后取 ? 词后取.字符 : null;
    const 字顶0 = 事前 ? 事前.顶 : null;
    const 字顶1 = 词后取 ? 词后取.顶 : null;
    const 文前 = 事前 ? 事前.上下文 : null;
    const 文后 = 词后取 ? 词后取.上下文 : null;
    // ⭐⭐ **文档坐标**下点处文字的位置：`视口顶 ＋ 滚动量`。它把"页面滚了"与"内容重排了"
    //    分开——2026-11-04 实测：`anchorAt` 补的那几次滚动（8/20/21 px）让视口里的字往下走，
    //    而文档坐标**一点没变** ⇒ 那一补**没有任何布局依据**，只是把用户点的字推离了手指。
    const 文档字顶0 = 字顶0 !== null ? 字顶0 + 滚0.体 : null;
    const 文档字顶1 = 字顶1 !== null ? 字顶1 + 滚1.体 : null;
    // ⭐ 光标落在哪一行（见 `光标信息`）：⑨ 判红时用来分"落错行"与"锚点差一行"。
    const 光标 = 光标信息();
    const 光标行 = 光标 ? 光标.行文本 : null;
    const 上下文前 = 文前 ? 文前.trim() : '';
    const 光标行含词 = 光标行 !== null && 上下文前.length > 0
      ? 光标行.indexOf(上下文前) >= 0 : null;

    const 行 = {
      点: pt, 命中: out.命中,
      序号: idx,
      全集: out.共,
      页高: 页高0 + '→' + 页高1,
      文档顶: 顶0 + '→' + 顶1,
      目标: pt.目标 || null,
      块类: (p.block_kinds && p.block_kinds[块行[0]]) || ('#' + 块行[0]),
      块数: 块数0 + '→' + 块数1,
      位移: isFinite(y0) && isFinite(y1) ? Math.round((y1 - y0) * 100) / 100 : null,
      // ⭐ 诊断三件：位移是"块变高了"还是"页面滚了"，靠这两组数分开。
      块高: isFinite(h0) && isFinite(h1) ? Math.round(h0) + '→' + Math.round(h1) : null,
      滚动: JSON.stringify(滚0) + '→' + JSON.stringify(滚1),
      提交: commitD, begin_edit: beginD,
      主机: 覆盖层, 输入框: 输入框,
      焦点在编辑面: 覆盖层 > 0 ? 在编辑面(document.activeElement) : null,
      焦点元素: document.activeElement ? 述(document.activeElement) : null,
      异常: errD.length, 未知IPC: unkD.length,
      editable: editable,
      事后命中: 事后 ? 述(事后) : null,
      事后块: 事后块,
      事前字符: 词前,
      事后字符: 词后,
      点处文字: JSON.stringify(文前) + '→' + JSON.stringify(文后),
      字顶: 字顶0 !== null && 字顶1 !== null ? 字顶0 + '→' + 字顶1 : null,
      光标行: 光标行,
      光标行号: 光标 ? 光标.行号 : null,
      光标列: 光标 ? 光标.列 : null,
      光标行含点处词: 光标行含词,
      静默ms: Math.round(静默ms),
      ipc增量: (window.__IPC || []).length - ipc0,
    };

    // ── 判红（⛔ 全是"与动作无关"的形态） ──
    const 红 = [];
    // ── ④ 被点那一块**在文档坐标里**的顶动了没有 ──
    //    ⚠️⚠️ 只比**视口**顶是不够的（2026-11-04 实测）：一次 `scrollTop` 的改动会让块在
    //    视口里挪 8–21 px，而文档坐标一点没变。⛔⛔ **2026-11-09 起，"锚定补滚动"不再有
    //    豁免**：`INV-LIVE-04` ① 要求进入瞬间逐像素不动（含滚动锚）。⇒ 本行判的是
    //    **内容有没有重排**（文档坐标，`bugs/0077` 那一族），而"没有布局依据的滚动"由下面
    //    第 ⑨ 条独立判红——两条各管一面，⛔ 不许拿"产品故意的"把滚动那一面免掉。
    const 高差 = isFinite(h0) && isFinite(h1) ? Math.round((h1 - h0) * 100) / 100 : 0;
    const 高变 = Math.abs(高差) > TOL;
    const 文档动 = 顶0 !== null && 顶1 !== null ? Math.round((顶1 - 顶0) * 100) / 100 : null;
    行.位移判据 = '比块顶（文档坐标）';
    // ⛔⛔ **2026-11-09**：原先"块高变了 ⇒ 不判位移"是**旧口径的免判**（那时块允许长高）。
    //    按 `INV-LIVE-04` ①（`design/0047` §5），**块高变化本身就是缺陷** ⇒ 不许再用它
    //    把位移判据整个免掉：块高变了判高，块顶的文档坐标变了判位移，两条各自成立。
    if (高变) {
      红.push('被点那一块进入后高度变了（' + h0 + '→' + h1 + '，Δ' + 高差 +
        ' px）⇒ 违反 INV-LIVE-04 ①（进入瞬间逐像素不变）');
    }
    if (errD.length) 红.push('未捕获异常：' + JSON.stringify(errD.slice(0, 2)));
    if (unkD.length) 红.push('未知 IPC：' + JSON.stringify(unkD));
    if (!editable && !走单元格 && beginD > 0) 红.push('editable=0 的块进了编辑（begin_edit ' + beginD + '）');
    if (!editable && !走单元格 && 覆盖层 > 0) 红.push('editable=0 的块留下了覆盖层');
    // ⑥ 进了编辑却没有焦点 ⇒ 键盘打不进字，而屏幕上看着"已进入编辑"（静默没反应的一族）。
    if (覆盖层 > 0 && 行.焦点在编辑面 === false) {
      红.push('进了编辑但焦点不在编辑面（当前 ' + 行.焦点元素 + '）');
    }
    if (块数1 !== 块数0 && commitD === 0) {
      红.push('块数变了（' + 块数0 + '→' + 块数1 + '）却没有任何 render_preview');
    }
    if (文档动 !== null && Math.abs(文档动) > TOL) {
      红.push('被点那一块在文档坐标里移动 ' + 文档动 + ' px（容差 ' + TOL + '，⛔ 不再是免判项）');
    }
    // ── ⑦ 进编辑之后点处还在不在被点那一块 ──
    //    ⚠️ 块高变了（`高变`）时这里不再重复判：块高变化本身已在上面的 ④ 判红，
    //    点落到块外只是它的后果。⛔ 这不是"块变矮是允许的"——`INV-LIVE-04` ① 下它已是缺陷。
    if (覆盖层 > 0 && !高变 && 事后块 !== pt.块) {
      红.push('进编辑后点处已不在被点那一块（' + pt.块 + '→' +
        (事后块 < 0 ? '块间空白' : 事后块) + '）');
    }
    // ── ⑨ ⭐ **进编辑时那次滚动有没有布局依据** ──
    //    ⛔⛔ **2026-11-09 起口径收紧**：进入编辑的瞬间，块高、页高、块的文档坐标本来就
    //    **都不许变**（`INV-LIVE-04` ①）。⇒ 任何滚动的唯一合法量是 0（量化下限 0.5 px）；
    //    旧口径里"布局真动了所以补滚是对的"那条依据**已作废**——布局动本身就是缺陷。
    //    本行仍保留"两个独立判据都没变却滚了"这个形态，是为了把"纯滚动"与"重排+补滚"
    //    分开报（后者已由 ④ 判红，⛔ 不要重复计，但要让人看得出是哪一种）。
    //
    //    ⚠️⚠️ 早先一版用的是"点处那个字在视口里动了、文档坐标没动"，**漏判**（2026-11-04 实测）：
    //    页面一滚，"同一个屏幕坐标下面"就换成了**别的字**（折行段落里正好差一个视觉行）⇒
    //    那个字的文档坐标自然跟着变，判据静默通过。而用户看到的正是"我点的字跑了"。
    //    ⛔ 所以别再拿"点处字符"当锚定判据，它只在页面不滚时才有意义。
    //    ⚠️ 块高变了（`高变`）或块在文档里挪了（④ 已判）时不在这里重复判——
    //    那两种情况下补滚**可能**是对的，交给 ④ 去追重排本身。
    const 视口动 = 字顶0 !== null && 字顶1 !== null ? 字顶1 - 字顶0 : null;
    const 文档字动 = 文档字顶0 !== null && 文档字顶1 !== null
      ? 文档字顶1 - 文档字顶0 : null;
    const 滚差 = isFinite(滚0.体) && isFinite(滚1.体) ? Math.round((滚1.体 - 滚0.体) * 100) / 100 : null;
    const 页高变 = Math.abs((页高1 || 0) - (页高0 || 0)) > TOL;
    行.滚差 = 滚差;
    if (覆盖层 > 0 && 滚差 !== null && Math.abs(滚差) > TOL
      && !高变 && !页高变 && 文档动 !== null && Math.abs(文档动) <= TOL) {
      红.push('进编辑时页面滚了 ' + 滚差 + ' px，而块高、页高与块的文档坐标都没变' +
        '（点处文字在视口里动了 ' + (视口动 === null ? '?' : Math.round(视口动 * 100) / 100) +
        ' px）⇒ 这次补滚没有布局依据');
    }
    // ── 第二阶段（`--two-step`）：点块间空白 = `leaveAway('blank')`，验"退出不留残留" ──
    if (window.__TWO) {
      const 隙 = 找空隙(d);
      if (!隙) {
        行.阶段2 = { 跳过: '找不到块间空隙' };
      } else {
        const 盒2a = 块盒(d, pt.块);
        const y2a = 盒2a ? 盒2a.top : NaN;
        const h2a = 盒2a ? 盒2a.height : NaN;
        const err1 = (window.__ERR || []).length;
        const unk1 = (window.__UNKNOWN || []).length;
        const ipc1 = (window.__IPC || []).length;
        const 目标2 = document.elementFromPoint(隙.x, 隙.y);
        点一下(目标2 || d, 隙.x, 隙.y);
        const ms2 = await 等静默(200);
        const 盒2b = 块盒(d, Math.min(pt.块, 块节点(d).length - 1));
        const y2b = 盒2b ? 盒2b.top : NaN;
        const h2b = 盒2b ? 盒2b.height : NaN;
        const 高2 = isFinite(h2a) && isFinite(h2b) ? Math.round((h2b - h2a) * 100) / 100 : 0;
        行.阶段2 = {
          点: 隙, 命中: 隙.命中 || (目标2 ? 述(目标2) : null),
          静默ms: Math.round(ms2), 块数: 块节点(d).length, 主机: 主机数(d),
          位移: isFinite(y2a) && isFinite(y2b) ? Math.round((y2b - y2a) * 100) / 100 : null,
          块高: isFinite(h2a) && isFinite(h2b) ? Math.round(h2a) + '→' + Math.round(h2b) : null,
          异常: (window.__ERR || []).length - err1,
          未知IPC: (window.__UNKNOWN || []).length - unk1,
          ipc增量: (window.__IPC || []).length - ipc1,
        };
        if (行.阶段2.异常) 红.push('点空白（退出编辑）时抛异常');
        if (行.阶段2.未知IPC) 红.push('点空白时出现未知 IPC');
        if (行.阶段2.主机 > 0) 红.push('点空白之后仍留着覆盖层 ' + 行.阶段2.主机);
        if (Math.abs(高2) <= TOL && 行.阶段2.位移 !== null && Math.abs(行.阶段2.位移) > TOL) {
          红.push('退出编辑时被点那一块位移 ' + 行.阶段2.位移 + ' px');
        }
      }
    }
    行.红 = 红;

    out.耗时秒 = Math.round((performance.now() - t0) / 100) / 10;
    out.结果 = 行;
    return out;
  };

  window.__READY = true;
})();
