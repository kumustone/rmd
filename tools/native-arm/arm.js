// rmd · 「编辑选区与输入能力复用」隔离对照臂 —— 页面侧驱动与判据。
//
// ⛔ 这不是产品代码：本文件只由 `tools/native-arm/probe.sh` 拷进 `$TMPDIR` 的页面里跑，
//    不进 `src/**`、不进二进制、不被 `index.html` 引用。
//
// # 三条臂（⭐ 只变「选区绘制 / 鼠标 / 输入」这三件里的一件或两件）
//
//   N（原生臂）：CM6 自己的 `drawSelection()` ＋ 原生 mousedown（CM6 自己 `view.focus()`）
//                ＋ `defaultKeymap`/`historyKeymap` ＋ 可编辑可聚焦的 `contentDOM`。
//   S（自建臂）：复用**产品那两份**（`src/live/selection.js` 的 `createLayer` / `installMouse`）
//                ＋ `contentDOM` 不可编辑、不聚焦（`INV-LIVE-12` 的现行形态）。
//   H（混合臂）：`drawSelection()` 画选区与光标 ＋ **产品那份 R1 输入层**
//                （`src/live/input.js` 的状态机 ＋ 离屏 `textarea`）＋ **自研鼠标**
//                （`installMouse`）＋ `contentDOM` 仍不可编辑、不聚焦。
//                ⭐ 它只回答一件事：**「绘制」能不能单独交还**（2026-10-29 用户指定的第 1 步）。
//   HM（交还鼠标臂）：H 的**逐字复刻**，只把 `installMouse` 摘掉、换成 CM6 自己的
//                `handlers.mousedown` ＋ `basicMouseSelection`（view dist **4996** / **5055**）。
//                ⭐ 它只回答一件事：**「鼠标」能不能单独交还**（用户指定的第 2 步：
//                「再替换鼠标处理（验只读视图、内置拖选与焦点交还，失败记录事件链）」）。
//                ⚠️ 它是**第四条臂**，⛔ 不并入 H 的 26 条矩阵（那样 26 条的对照会变双变量）。
//
// ⭐ 其余一切各臂逐字相同：同一份夹具文本、同一个 `EditorView` 构造参数、同一份 CSS、
//    同一宽度、同一个窗口。⛔ 一次只改一个变量（H → HM 只动「鼠标」这一件）。
//
// # 判据的三件套（用户 2026-10-29 明令：⛔ 不能只判 anchor/head）
//
//   ① **实际选区** → 换算成**选中的文本**（`sliceDoc`），与写死的期望串逐字比；
//   ② **复制内容** → 真派发 `copy` 事件读 `clipboardData`（⛔ 不碰系统剪贴板）；
//   ③ **可见高亮覆盖** → 画出的小方块与**与实现无关的 oracle**（逐字符 `coordsAtPos`
//      推出的视觉行跨度）比面积比。⭐ 这一条专打 `bugs/0043`（跨软换行只画 4px 竖条）。

/* eslint-disable */
(function () {
  'use strict';

  var CM = window.__ARM_CM6;
  var LSel = (window.rmd || {}).liveSelection;
  var LIn = (window.rmd || {}).liveInput;

  if (!CM) {
    window.__RUN = function () { return { 致命: '未加载 arm-cm6.js（先跑 probe.sh）' }; };
    return;
  }
  if (!LSel) {
    window.__RUN = function () { return { 致命: '未加载 selection.js（自建臂需要产品那一份）' }; };
    return;
  }
  if (!LIn) {
    window.__RUN = function () { return { 致命: '未加载 input.js（混合臂需要产品那份 R1 输入状态机）' }; };
    return;
  }

  // ── 夹具 ────────────────────────────────────────────────────────────────
  // ⚠️ 纯文本**不挂 markdown 语言扩展**：两条臂都不解析 Markdown ⇒ 标题/引用/围栏/表格
  //    在视图里都是普通字符。这样"跨段落/跨标题/跨代码块"退化成"跨行"，**两种臂都一样**，
  //    变量没有被偷偷改掉。⛔ 因此本夹具**不能**当作"产品里跨块/跨表格选择"的证据。
  var LINES = [
    '第一段：中文与 English 混排，标点（，。！）与 Emoji 😀 以及组合字符 é 都在这里。',
    '',
    'Second paragraph with "quotes", commas, and words two three four.',
    '',
    '# 一级标题',
    '',
    '> 引用块的第一行',
    '> 引用块的第二行',
    '',
    '- 列表项一',
    '- 列表项二',
    '',
    '```',
    'const x = 1;',
    '```',
    '',
    '| 表头A | 表头B |',
    '| --- | --- |',
    '| 单元1 | 单元2 |',
    '',
    '长段落（软换行测试）：AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH IIII JJJJ KKKK LLLL MMMM NNNN OOOO PPPP QQQQ RRRR SSSS TTTT UUUU VVVV WWWW XXXX YYYY ZZZZ',
    ''
  ];
  // 填充行：只为了让页面**真的能滚**（超一屏那一条要用），⛔ 不参与任何锚点查找。
  for (var fi = 0; fi < 40; fi++) LINES.push('填充行 ' + fi + '：lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.');
  var TEXT = LINES.join('\n');

  /** 夹具里的**唯一**子串起点。找不到 ⇒ 夹具与判据脱钩，直接抛。 */
  function at(sub, from) {
    var i = TEXT.indexOf(sub, from || 0);
    if (i < 0) throw new Error('夹具里找不到锚点：' + sub);
    return i;
  }

  // ── 基础工具 ────────────────────────────────────────────────────────────
  function frame() {
    return new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
  }
  async function frames(n) { for (var i = 0; i < n; i++) await frame(); }

  function fire(target, type, x, y, opt) {
    var o = opt || {};
    var ev = new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      detail: o.detail || 1,
      shiftKey: !!o.shiftKey
    });
    target.dispatchEvent(ev);
    return ev;
  }

  /**
   * 派发一次**页内** `keydown`（⛔ 不是系统级合成按键）：CM6 的 keymap 就挂在 `contentDOM` 上。
   * ⚠️ 返回 `defaultPrevented`，即「这个键被处理了没有」——⛔ 不能只看选区变没变。
   */
  function keyOn(target, k, opt) {
    var o = opt || {};
    var ev = new KeyboardEvent('keydown', {
      key: k, bubbles: true, cancelable: true, view: window,
      shiftKey: !!o.shiftKey, metaKey: !!o.metaKey, altKey: !!o.altKey, ctrlKey: !!o.ctrlKey
    });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  /** 键盘事件的**落点**按臂取：N 是 `contentDOM`（CM6 的 keymap），H / HM 是离屏 `textarea`（R1 输入层）。 */
  function keyTarget(v, kind) {
    if (kind === 'H' || kind === 'HM') return v.__input || v.contentDOM;
    return v.contentDOM;
  }

  function key(v, k, opt, kind) { return keyOn(keyTarget(v, kind || 'N'), k, opt); }

  /** `pos` 处**那个字符的左边缘**（+1px，确保落在这个字符里而不是上边界上）。 */
  function xy(v, pos, side) {
    var c = v.coordsAtPos(pos, side || 1);
    if (!c) return { x: 0, y: 0 };
    return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
  }

  /**
   * 一次真鼠标拖拽（两条臂**同一份**）。
   * ⚠️ `mousedown` 派到 `contentDOM`（CM6 的 handler 在它身上），而 `mousemove`/`mouseup`
   *    派到 `document`（两条臂都挂在 document 上）。事件会先经过祖先的 capture 阶段
   *    ⇒ 自建臂在 `view.dom` 上拦得住。
   */
  async function drag(v, from, to, opt) {
    var o = opt || {};
    var a = xy(v, from, o.sideFrom);
    var b = xy(v, to, o.sideTo);
    var detail = o.detail || 1;
    var downEv = fire(v.contentDOM, 'mousedown', a.x, a.y, { detail: detail });
    await frame();
    var steps = o.steps || 6;
    for (var i = 1; i <= steps; i++) {
      fire(document, 'mousemove',
        a.x + (b.x - a.x) * i / steps,
        a.y + (b.y - a.y) * i / steps, { detail: detail });
      await frame();
    }
    if (!o.hold) {
      fire(document, 'mouseup', b.x, b.y, { detail: detail });
      await frames(2);
    }
    return { a: a, b: b, down: downEv, end: { x: b.x, y: b.y }, detail: detail };
  }

  // ── 三件套：选区 / 复制 / 可见高亮 ───────────────────────────────────────

  function selection(v) {
    var s = v.state.selection.main;
    return { from: s.from, to: s.to, anchor: s.anchor, head: s.head, empty: s.empty };
  }

  function selectedText(v) {
    var s = v.state.selection.main;
    return v.state.sliceDoc(s.from, s.to);
  }

  /**
   * 真派发一次 `copy`：读事件里的 `clipboardData`，⛔ 不碰系统剪贴板。
   * ⚠️ WebKit 若不接受构造参数里的 `clipboardData`，这里会如实记 `未测`，
   *    ⛔ 不拿"状态切片"冒充"复制内容"。
   * ⭐ **落点按臂取**：H 臂的复制必须落在离屏 `textarea` 上（产品的 `selectedText` 读状态切片）——
   *    落在 `contentDOM` 上反而是一条**可测的负判据**：CM6 的 `handlers.copy`（view dist **5221**）
   *    第一句就 `hasSelection(view.contentDOM, view.observer.selectionRange)`，DOM 选区不在
   *    `contentDOM` 里 ⇒ `return false` ⇒ **不接管**。
   */
  function copyViaEvent(v, kind) {
    var target = (kind === 'H' || kind === 'HM') ? (v.__input || v.contentDOM) : v.contentDOM;
    try {
      var dt = new DataTransfer();
      var ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      var t = dt.getData('text/plain');
      return { ok: true, text: t, why: t ? '' : '事件已派发但 clipboardData 为空' };
    } catch (e) {
      return { ok: false, text: '', why: String((e && e.message) || e) };
    }
  }

  /**
   * **与实现无关**的期望矩形：逐字符取 `coordsAtPos`，按 `top` 变化切视觉行。
   * ⛔ 不调 `rectsFor`、不调 `drawSelection` —— 那是被测对象。
   */
  function oracleSpans(v, from, to) {
    var spans = [];
    var cap = Math.min(to, from + 600);
    var cur = null;
    for (var p = from; p < cap; p++) {
      if (v.state.doc.sliceString(p, p + 1) === '\n') { cur = null; continue; }
      // ⚠️ `coordsAtPos(p, 1)` = 位置贴在**后面那个字符**那一侧（⇒ 就是字符 p 自己的盒子）；
      //    `coordsAtPos(p + 1, -1)` = 贴在**前面那个字符**那一侧（⇒ 字符 p 的右边缘）。
      //    ⭐ 只有这一对取法在软折点上也成立（换行处的字符属于**上一**视觉行）。
      var a = v.coordsAtPos(p, 1);
      var b = v.coordsAtPos(p + 1, -1);
      if (!a || !b) continue;
      var top = Math.min(a.top, b.top), bot = Math.max(a.bottom, b.bottom);
      var left = Math.min(a.left, a.left), right = Math.max(b.right, a.left);
      if (!cur || Math.abs(cur.top - top) > 1) {
        cur = { left: left, right: right, top: top, bottom: bot };
        spans.push(cur);
      } else {
        if (right > cur.right) cur.right = right;
        if (left < cur.left) cur.left = left;
        if (bot > cur.bottom) cur.bottom = bot;
      }
    }
    return spans;
  }

  function paintedRects(v, kind) {
    // ⭐ N / H 都是 CM6 的 `drawSelection()` 画的；只有 S 是产品自绘层。
    var sel = kind === 'S' ? '.cm-rmd-selectionRange' : '.cm-selectionLayer .cm-selectionBackground';
    var list = v.dom.querySelectorAll(sel);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) continue;
      out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, cls: list[i].className, style: (list[i].getAttribute('style') || '').slice(0, 80) });
    }
    return out;
  }

  function area(list) {
    var s = 0;
    for (var i = 0; i < list.length; i++) s += Math.max(0, list[i].right - list[i].left) * Math.max(0, list[i].bottom - list[i].top);
    return s;
  }

  /**
   * 点采样：矩形集合**内部**按网格取点（每块按面积自适应步长，总点数有上限）。
   * ⚠️ 为什么不用面积比：两臂都会在**软折点**画一条**整行宽**的过渡带
   *   （CM6 是 `RectangleMarker.forRange` 的块标记，产品是 `rectsFor` 的同款），
   *   那条带子是**共同的视觉约定**、不是缺陷 ⇒ 面积比会被它放大到 4–14 倍。
   *   所以判据拆成两条：**覆盖率**（选中的字有没有被画到）与**越界率**（画到别处去了没有）。
   */
  function points(rects, budget) {
    var total = 0, i;
    for (i = 0; i < rects.length; i++) total += Math.max(0, rects[i].right - rects[i].left) * Math.max(0, rects[i].bottom - rects[i].top);
    var step = Math.max(3, Math.sqrt(total / (budget || 3000)));
    var out = [];
    for (i = 0; i < rects.length; i++) {
      var r = rects[i];
      for (var y = r.top + step / 2; y < r.bottom; y += step)
        for (var x = r.left + step / 2; x < r.right; x += step) out.push([x, y]);
    }
    return out;
  }

  function hits(pts, rects) {
    var n = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      for (var j = 0; j < rects.length; j++) {
        var r = rects[j];
        if (p[0] >= r.left && p[0] < r.right && p[1] >= r.top && p[1] < r.bottom) { n++; break; }
      }
    }
    return n;
  }

  /** 覆盖：覆盖率（选中区域的点被画到的比例）＋ 越界率 ＋ 上下边界差。 */
  function coverage(v, kind, from, to) {
    var o = oracleSpans(v, from, to);
    var p = paintedRects(v, kind);
    var oa = area(o), pa = area(p);
    var oTop = o.length ? Math.min.apply(null, o.map(function (r) { return r.top; })) : null;
    var oBot = o.length ? Math.max.apply(null, o.map(function (r) { return r.bottom; })) : null;
    var pTop = p.length ? Math.min.apply(null, p.map(function (r) { return r.top; })) : null;
    var pBot = p.length ? Math.max.apply(null, p.map(function (r) { return r.bottom; })) : null;
    var oPts = points(o), pPts = points(p);
    var 覆盖率 = oPts.length ? Math.round((hits(oPts, p) / oPts.length) * 1000) / 1000 : null;
    // ⚠️ oracle 逐字符采样只到 600 字符：超出的区间「越界」无从判断 ⇒ 记 null（⛔ 不报一个假数）
    var capped = to - from > 600;
    var 越界率 = (!capped && pPts.length) ? Math.round(((1 - hits(pPts, o) / pPts.length)) * 1000) / 1000 : null;
    return {
      矩形数: p.length, 期望块数: o.length,
      画面积: Math.round(pa), 期望面积: Math.round(oa),
      明细_画: p.map(function (r) { return [Math.round(r.left), Math.round(r.top), Math.round(r.right - r.left), Math.round(r.bottom - r.top), r.cls, r.style]; }),
      明细_期望: o.map(function (r) { return [Math.round(r.left), Math.round(r.top), Math.round(r.right - r.left), Math.round(r.bottom - r.top)]; }),
      覆盖率: 覆盖率,
      越界率: 越界率,
      top差: oTop !== null && pTop !== null ? Math.round((pTop - oTop) * 10) / 10 : null,
      bottom差: oBot !== null && pBot !== null ? Math.round((pBot - oBot) * 10) / 10 : null
    };
  }

  // ── 三件套的独立通过值（⭐ 2026-10-29 复评 P2-1）─────────────────────────
  //
  // ⛔ 旧口径的缺陷：`符合期望` 只判**选区范围**，而 `复制` 与 `高亮覆盖率` 只是被记录
  //    ⇒ 覆盖率 0、复制整段文字，报告仍能退出 0。现在四个量**各判各的**。
  //
  // 每个值是四种之一：`true` / `false` / `'未测'` / `'不判'`
  //   - `'未测'`：这条量本臂**不支持或没量到** ⇒ ⛔ 不记通过（⛔ 也不记失败）
  //   - `'不判'`：这类动作**本来就没有这个量**（折叠光标 / 非选区行 / 观测行）
  //
  // ⚠️ 两个默认上限都是**实测口径**，不是拍脑袋（证据 `.na-work/arm-probe-2026-10-29-161702-HM.json`）：
  //    覆盖率实测**恒 1**（软折处不缺画）；越界率的合法值最高 **0.928**（A12 引用块多行）、
  //    **0.795**（A3 反向折返）、**0.756**（A3 的 S 臂）—— 那是**整行宽过渡带**这条
  //    三条臂共同的视觉约定（`coverage()` 的注释），⛔ 不是缺陷。
  //    ⇒ 默认上限 0.95；某一行动作确实更宽/更窄时，用 `期望.覆盖至少` / `期望.越界至多` 显式写死。
  var 覆盖下限 = 0.95;
  var 越界上限 = 0.95;

  /** 范围判据（⛔ 不含复制/覆盖/越界）。`null` = 观测 / 策略差异 / 不判。 */
  function judgeRange(o) {
    var e = o.期望;
    if (!e || e.观测 || e.策略差异) return null;
    if (typeof e.pass === 'boolean') return e.pass;
    var s = o.选区;
    if (!s) return false;
    var f = Math.min(s[0], s[1]), t = Math.max(s[0], s[1]);
    if (e.选区) return f === Math.min(e.选区[0], e.选区[1]) && t === Math.max(e.选区[0], e.选区[1]);
    if (e.至少包含 && !(f <= e.至少包含[0] && t >= e.至少包含[1])) return false;
    if (e.至多覆盖 && !(f >= e.至多覆盖[0] && t <= e.至多覆盖[1])) return false;
    return true;
  }

  /**
   * 四个独立通过值。
   * @param {object} o   snap 造出来的那一行（选区 / 文本 / 复制 / 高亮 / 期望）
   * @param {{有复制路径?: boolean}} [opt] `false` = 本臂的夹具里**没有**复制路径（S 臂）
   */
  function subJudgments(o, opt) {
    var e = o.期望 || {};
    var 观测 = !!(e.观测 || e.策略差异);
    var out = { 范围: '不判', 复制: '不判', 覆盖: '不判', 越界: '不判' };
    if (观测) return out;
    var r = judgeRange(o);
    out.范围 = (r === null) ? '不判' : r;
    var s = o.选区;
    if (!s) return out;                         // 这一路根本没量到选区 ⇒ 后三条无从判
    if (s[0] === s[1]) return out;              // 折叠光标：复制/覆盖/越界 都不适用
    if (opt && opt.有复制路径 === false) out.复制 = '未测';
    else if (e.复制 === '不判') out.复制 = '不判';
    else if (typeof o.复制 === 'string' && o.复制.indexOf('未测：') === 0) out.复制 = '未测';
    else out.复制 = (o.复制 === (o.文本 || ''));
    var hi = o.高亮;
    if (!hi) { out.覆盖 = '未测'; out.越界 = '未测'; return out; }
    var c = hi.覆盖率, w = hi.越界率;
    out.覆盖 = (c === null || c === undefined)
      ? '未测' : (c >= (typeof e.覆盖至少 === 'number' ? e.覆盖至少 : 覆盖下限));
    out.越界 = (w === null || w === undefined)
      ? '未测' : (w <= (typeof e.越界至多 === 'number' ? e.越界至多 : 越界上限));
    return out;
  }

  /** 四个独立值 → 这一行**唯一**的结论。⛔ 别拿其中一个冒充整行。 */
  function 结论of(判定) {
    var vals = [判定.范围, 判定.复制, 判定.覆盖, 判定.越界];
    for (var i = 0; i < vals.length; i++) if (vals[i] === false) return 'fail';
    if (判定.范围 === '不判') return '观测';
    for (var j = 0; j < vals.length; j++) if (vals[j] === '未测') return '未测';
    return 'pass';
  }

  // ── 建臂 ────────────────────────────────────────────────────────────────
  var CSS = [
    'html, body { height: 100%; overflow-y: auto; }',
    'body { margin: 0; font: 16px/1.6 -apple-system, "PingFang SC", sans-serif; }',
    // ⚠️ `block` ＋ 固定 660px：三臂**纵向叠放**、每臂内容宽 640px ⇒ 软折点逐字相同。
    //    总高远超 1000px 窗口，`reset()` 每次把本臂 `scrollIntoView` 到视口顶部。
    '.armSpacer { height: 200px; }',
    '.armWrap { display: block; width: 660px; margin: 8px 12px 24px 12px; }',
    '.armTitle { font: 700 13px/2 monospace; color: #555; }',
    '.armHost { width: 640px; }',
    '.armHost .cm-editor { width: 640px; }',
    '.armHost .cm-content { font: 16px/1.6 -apple-system, "PingFang SC", sans-serif; padding: 0; }',
    '.armHost .cm-line { padding: 0; }',
    // 三条臂的高亮都要看得见：各给一个不透明底色
    '.armHost .cm-selectionLayer .cm-selectionBackground { background: #b3d4fc; }',
    '.armHost .cm-rmd-selectionRange { position: absolute; background: #b3d4fc; }',
    '.armHost .cm-rmd-selectionLayer { position: absolute; top: 0; left: 0; pointer-events: none; }',
    '.armHost .cm-rmd-caret { position: absolute; width: 1px; background: #333; }',
    // ⭐ 混合臂：CM6 默认主题里 `.cm-cursor { display: none }`，只有 `.cm-focused` 下
    //    才 `display: block`（view dist 6958）⇒ 不聚焦也要看得见光标，就补这一行。
    '.armHost .cm-cursor { display: block; }',
    // ⭐ 混合臂的离屏输入框：照抄产品 `src/styles/live.css:280-297` 的那一份。
    '.cm-rmd-input { position: fixed; top: 0; left: 0; width: 1px; height: 1em; margin: 0; padding: 0;'
      + ' border: 0; outline: none; resize: none; overflow: hidden; opacity: 0; z-index: -1;'
      + ' color: transparent; background: transparent; caret-color: transparent; }',
    // ⭐ 子实验专用：把编辑器约束成「自己是滚动容器」
    '.armFixed { height: 320px; overflow: hidden; }',
    '.armFixed .cm-editor { height: 100%; }',
    '.armFixed .cm-scroller { overflow: auto; }'
  ].join('\n');

  function makeView(kind, host, docText) {
    var 正文 = typeof docText === 'string' ? docText : TEXT;
    var state = CM.EditorState.create({ doc: 正文, extensions: [] });
    var exts = [CM.EditorView.lineWrapping, CM.history()];
    var layer = null;
    var hyb = null;

    if (kind === 'N') {
      exts.push(CM.drawSelection());
      exts.push(CM.keymap.of([].concat(CM.defaultKeymap, CM.historyKeymap)));
      exts.push(CM.EditorView.updateListener.of(function () { /* 原生臂自带重绘 */ }));
    } else if (kind === 'H' || kind === 'HM') {
      // ⭐ 混合臂 / 交还鼠标臂：**绘制交还 CM6**，输入仍走产品那条路。
      //    ⚠️ HM 与 H 的差别只有一处：`setupHybrid` 不装自研鼠标（见函数体）。
      exts.push(CM.drawSelection());
      exts.push(CM.EditorView.editable.of(false));
      exts.push(CM.EditorView.contentAttributes.of({ tabindex: '-1', 'aria-hidden': 'true' }));
      exts.push(CM.EditorView.updateListener.of(function (u) {
        if (hyb && (u.docChanged || u.selectionSet)) hyb.syncSel();
      }));
    } else {
      // `INV-LIVE-12` 的现行形态：不可编辑、不可聚焦、aria 隐藏
      exts.push(CM.EditorView.editable.of(false));
      exts.push(CM.EditorView.contentAttributes.of({ tabindex: '-1', 'aria-hidden': 'true' }));
      exts.push(CM.EditorView.updateListener.of(function () { if (layer) layer.refresh(); }));
    }

    var view = new CM.EditorView({
      state: CM.EditorState.create({ doc: 正文, extensions: exts }),
      parent: host
    });
    void state;

    if (kind === 'S') {
      layer = LSel.createLayer(view, CM);
      view.__uninstallMouse = LSel.installMouse(view, {
        onSelect: function () { layer.refresh(); },
        focus: function () { /* 产品把焦点给离屏 textarea；对照臂不建那玩意 */ }
      });
    }
    if (kind === 'H') hyb = setupHybrid(view, { mouse: true });
    if (kind === 'HM') hyb = setupHybrid(view, { mouse: false });
    return view;
  }

  // ── 混合臂 H：绘制归 CM6，输入仍走 R1（离屏 textarea ＋ **产品那份**状态机）──────
  //
  // ⭐ 它要证伪的那条旧结论是「绘制与离屏输入**结构互斥**」。
  //    这里**只换绘制**：`contentDOM` 依旧不可编辑 / 不聚焦（`INV-LIVE-12` 不动），
  //    输入事件全部落在 `textarea` 上，由 `src/live/input.js` 的 `createInputMachine` 产出事务。
  //
  // ⚠️ **本臂的接线是"产品那条路的同构复刻"**：状态机、鼠标、事务口径都直接拷产品，
  //    但接线代码本身在 `main.js`（依赖整个应用），⛔ 本夹具抽不出来 ⇒ 这一半是**重写的薄适配层**。
  //    判据因此只认 `input.js` 的行为（组合期不动文档 / 上屏一条事务 / 重复 insert 被吃掉）。
  function setupHybrid(view, opts) {
    // ⭐ HM 臂：`mouse: false` ⇒ **不装产品那份 `installMouse`**，鼠标交给 CM6 自己。
    //    ⛔ 其余每一行都与 H 逐字相同（离屏 textarea、状态机、键/剪贴板处理器）。
    var withMouse = !(opts && opts.mouse === false);
    var input = document.createElement('textarea');
    input.className = 'cm-rmd-input';
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('tabindex', '-1');
    input.setAttribute('aria-hidden', 'true');
    document.body.appendChild(input);

    var sel = { anchor: 0, head: 0 };
    var goal = null;
    /** 上屏 / 插入之后光标应在的位置（`caretAfterComposition` 同口径：UTF-16 码元）。 */
    var machine = LIn.createInputMachine(onTransaction);

    function clampPos(n) {
      if (!Number.isInteger(n)) return 0;
      return Math.max(0, Math.min(n, view.state.doc.length));
    }

    /** ⭐ 状态机的唯一出口：**已归一化**的 `{from, to, next}` → 一条 CM6 事务（同产品）。 */
    function onTransaction(tx) {
      var from = clampPos(tx.from);
      var to = Math.max(from, clampPos(tx.to));
      var insert = (tx.next || []).join('\n');
      view.dispatch({
        changes: { from: from, to: to, insert: insert },
        selection: { anchor: from + insert.length }
      });
      goal = null;
    }

    function syncSel() {
      var m = view.state.selection.main;
      sel = { anchor: m.anchor, head: m.head };
    }

    function currentRange() { return LSel.range(sel); }

    function clearInput() {
      if (input.value !== '') input.value = '';
      try { input.selectionStart = 0; input.selectionEnd = 0; } catch (e) { void e; }
    }

    function onKeyDown(ev) {
      if (machine.state.composing || ev.isComposing === true) return;
      var mods = { shift: ev.shiftKey === true, meta: ev.metaKey === true, alt: ev.altKey === true };
      if (mods.meta && (ev.key === 'a' || ev.key === 'A')) {
        ev.preventDefault();
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        return;
      }
      if (mods.meta && (ev.key === 'z' || ev.key === 'Z')) {
        ev.preventDefault();
        if (mods.shift) CM.redo(view); else CM.undo(view);
        return;
      }
      var doc = view.state.doc;
      var cmd = null;
      switch (ev.key) {
        // ⚠️ macOS 习惯：`⌘←/⌘→` = **行首/行尾**（`⌘↑/⌘↓` 才是文首/文末），
        //    `⌥←/⌥→` = 按词。⛔ 别把 `⌘←` 当 charLeft——那样 `⇧⌘←` 只扩一个字。
        case 'ArrowLeft': cmd = mods.meta ? 'lineStart' : (mods.alt ? 'wordLeft' : 'charLeft'); break;
        case 'ArrowRight': cmd = mods.meta ? 'lineEnd' : (mods.alt ? 'wordRight' : 'charRight'); break;
        case 'ArrowUp': cmd = mods.meta ? 'docStart' : 'lineUp'; break;
        case 'ArrowDown': cmd = mods.meta ? 'docEnd' : 'lineDown'; break;
        case 'Home': cmd = mods.meta ? 'docStart' : 'lineStart'; break;
        case 'End': cmd = mods.meta ? 'docEnd' : 'lineEnd'; break;
        default: break;
      }
      if (cmd === 'lineUp' || cmd === 'lineDown') {
        ev.preventDefault();
        var cur = view.state.selection.main;
        var next = view.moveVertically(cur, cmd === 'lineDown');
        if (next && Number.isInteger(next.head) && next.head !== cur.head) {
          view.dispatch({ selection: { anchor: mods.shift ? cur.anchor : next.head, head: next.head } });
          goal = null;
        }
        return;
      }
      if (cmd) {
        ev.preventDefault();
        var mv = LSel.move(doc, sel, cmd, { extend: mods.shift, goal: goal, pageLines: 10 });
        if (mv) {
          goal = mv.goal === undefined ? null : mv.goal;
          view.dispatch({ selection: { anchor: mv.anchor, head: mv.head } });
        }
        return;
      }
      if (ev.key === 'Backspace' || ev.key === 'Delete') {
        ev.preventDefault();
        var forward = ev.key === 'Delete';
        var r = LSel.deleteRange(doc, sel, { forward: forward, byWord: mods.alt, byLine: mods.meta });
        if (r.to > r.from) {
          machine.handle({
            type: 'beforeinput',
            inputType: forward ? 'deleteContentForward' : 'deleteContentBackward',
            from: r.from, to: r.to
          });
        }
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        var e = currentRange();
        machine.handle({ type: 'beforeinput', inputType: 'insertLineBreak', data: '\n', from: e.from, to: e.to });
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        machine.handle({ type: 'cancel' });
        clearInput();
        return;
      }
    }

    function onInput(ev) {
      if (machine.state.composing || ev.isComposing === true) return;
      var data = ev.data;
      clearInput();
      if (data === null || data === undefined) return;
      var r = currentRange();
      machine.handle({ type: 'input', data: data, from: r.from, to: r.to });
    }

    function onBeforeInput(ev) {
      var t = ev.inputType || '';
      if (t.slice(0, 6) === 'delete' || t.slice(0, 6) === 'format'
        || t === 'insertLineBreak' || t === 'insertParagraph' || t === 'insertFromDrop') {
        ev.preventDefault();
      }
    }

    /** 产品的复制路径：读**状态切片**，⛔ 不读 DOM 选区。 */
    function selectedText() {
      var r = LSel.range(sel);
      if (r.from === r.to) return '';
      return view.state.doc.sliceString(r.from, r.to);
    }

    function onCopy(ev) {
      var t = selectedText();
      if (!t) return;
      ev.preventDefault();
      if (ev.clipboardData) ev.clipboardData.setData('text/plain', t);
    }

    function onCut(ev) {
      if (!selectedText()) return;
      onCopy(ev);
      var r = currentRange();
      machine.handle({ type: 'beforeinput', inputType: 'deleteContentBackward', from: r.from, to: r.to });
    }

    function onPaste(ev) {
      ev.preventDefault();
      var r = currentRange();
      var t = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
      machine.handle({ type: 'paste', text: t, from: r.from, to: r.to });
    }

    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('beforeinput', onBeforeInput);
    input.addEventListener('input', onInput);
    input.addEventListener('compositionstart', function () {
      var r = currentRange();
      machine.handle({ type: 'compositionstart', from: r.from, to: r.to });
    });
    input.addEventListener('compositionupdate', function (ev) {
      // ⚠️ **本臂不画 preedit 覆盖层**（那是呈现层，与"绘制能不能交还"无关）
      //    ⇒ 组合期文档一个字节都不动这一条仍然可判。
      machine.handle({ type: 'compositionupdate', data: ev.data });
    });
    input.addEventListener('compositionend', function (ev) {
      machine.handle({ type: 'compositionend', data: ev.data });
      clearInput();
    });
    input.addEventListener('copy', onCopy);
    input.addEventListener('cut', onCut);
    input.addEventListener('paste', onPaste);

    var uninstallMouse = withMouse ? LSel.installMouse(view, {
      onSelect: function (s) { sel = { anchor: s.anchor, head: s.head }; },
      focus: function () {
        try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
      }
    }) : function () { /* HM 臂：鼠标归 CM6，本臂不装自研鼠标 */ };

    view.__input = input;
    view.__machine = machine;
    view.__uninstallHybrid = function () {
      uninstallMouse();
      input.removeEventListener('keydown', onKeyDown);
      input.removeEventListener('beforeinput', onBeforeInput);
      input.removeEventListener('input', onInput);
      input.removeEventListener('copy', onCopy);
      input.removeEventListener('cut', onCut);
      input.removeEventListener('paste', onPaste);
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    return { syncSel: syncSel };
  }

  /**
   * 页面里**真的在滚**的那个元素。
   * ⚠️ `html, body { height:100%; overflow-y:auto }` ⇒ 真正滚的是 **`body`**，
   *    而 `document.scrollingElement` 是 `<html>`（产品 `滚动容器()` 踩过同一个坑，
   *    `bugs/0031`）。这里按"可滚余量大"挑，⛔ 不写死。
   */
  function pageScroller() {
    var cands = [document.body, document.documentElement];
    var best = null;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!c) continue;
      var room = c.scrollHeight - c.clientHeight;
      if (room > 1 && (!best || room > best.room)) best = { el: c, room: room };
    }
    return best ? best.el : null;
  }

  /**
   * ⭐ 本臂顶对齐到视口下方 `头部留白` px，⛔ 不是对齐到 0。
   *
   * ⚠️⚠️ **实测踩过**：产品的自动滚动带是上下各 **28 px**（`src/live/selection.js::步进()`），
   *    而本臂的**第一行**就在臂顶 ⇒ A3/A10/A11 拖到第一行时指针落在上边缘带里，
   *    产品把**整页**往上推（它滚的是 `body`），本臂被推出视口、`posAtCoords` 掉到 0。
   *    A3 就是这样变成 `[0, 63]` 的：坐标 `[402, 13]` 与 N 臂**逐字相同且有效**，
   *    差异全在被推走的那几像素上 ⇒ ⛔ 它不是产品行为差异，是**夹具的**布局副作用。
   * ⇒ 留 120 px（> 28 px 带 ＋ CM6 的 `dragScrollMargin` 6 px），把"拖到第一行"移出滚动带。
   * ⚠️ 代价：页面顶部要有留白，否则第一臂 `scrollTop` 到不了正数（见 `__RUN` 的垫片）。
   */
  var 头部留白 = 120;

  function reset(v) {
    // ⚠️ 先前那几条会改文档（A14 插入 / A15 连打 / K3 剪切）——⛔ 不还原的话，
    //    后面所有 `at()` 坐标都对着**旧的** TEXT，选区会整体漂。
    if (v.state.doc.length !== TEXT.length || v.state.sliceDoc() !== TEXT) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: TEXT } });
    }
    v.dispatch({ selection: { anchor: 0, head: 0 } });
    // ⚠️ 三臂纵向叠放，总高远超 1000 px 窗口 ⇒ `posAtCoords` 对窗口外的坐标会失败。
    //    每次动作前把**本臂**顶到视口下方 `头部留白` px 处（离屏窗口里动的是 `body` 的滚动，
    //    ⛔ 不抢任何焦点）。
    var page = pageScroller();
    if (page && v.dom) {
      var r = v.dom.getBoundingClientRect();
      page.scrollTop = page.scrollTop + r.top - 头部留白;
    }
    var sc = v.scrollDOM;
    if (sc) sc.scrollTop = 0;
    // 混合臂：离屏 `textarea` 里的残留会让下一次 `input` 的 `data` 判断错位。
    if (v.__input && v.__input.value !== '') v.__input.value = '';
  }

  // ── 动作矩阵 ────────────────────────────────────────────────────────────
  //
  // ⭐⭐ 期望值**写死在这里**（用户 2026-10-29：「先固定验收动作，再运行」）。
  //      每条给出：动作、期望选中的文本、以及是否要求高亮覆盖。
  //      ⛔ 不拿"跑出来的结果"回头当期望。

  async function matrix(kind, v) {
    var out = [];
    var cells = {
      P: {
        title: at('Second paragraph'),
        four: at('four.'),
        two: at('two three'),
        english: at('English'),
        cjk: at('中文与'),
        emoji: at('😀'),
        comma: at('，。'),
        line0: at('第一段'),
        line2end: at('four.') + 5,
        quote: at('> 引用块的第一行'),
        list: at('- 列表项二'),
        code: at('const x = 1;'),
        table: at('| 单元1 | 单元2 |'),
        long: at('长段落（软换行测试）')
      }
    };
    var c = cells.P;
    var longLen = LINES[21].length;
    var paraLen = LINES[2].length;

    async function row(id, name, fn) {
      reset(v);
      await frames(2);
      var r;
      try {
        r = await fn();
      } catch (e) {
        r = { 选区: null, 文本: '⛔ 抛错：' + ((e && e.message) || e), 复制: '', 高亮: null };
      }
      r.id = id;
      r.动作 = name;
      out.push(r);
      return r;
    }

    /**
     * 期望是**写死**的（`期望: {选区:[a,b]} | {至少包含:[a,b]} | {至多覆盖:[a,b]} | {观测:true}`）。
     * ⛔ 不拿跑出来的结果回头当期望；`{观测}` 与 `{策略差异}` 不判通过与失败。
     * ⚠️ 这里只判**范围**；复制/覆盖/越界由 `subJudgments()` 各判各的。
     */
    function judge(o) {
      return judgeRange(o);
    }

    function snap(extra) {
      var s = selection(v);
      var cp = copyViaEvent(v, kind);
      var cov = s.empty ? null : coverage(v, kind, s.from, s.to);
      var o = {
        选区: [s.from, s.to],
        方向: s.anchor < s.head ? '正向' : (s.anchor > s.head ? '反向' : '折叠'),
        文本: selectedText(v),
        复制: cp.ok ? cp.text : ('未测：' + cp.why),
        高亮: cov
      };
      if (extra) for (var kk in extra) o[kk] = extra[kk];
      o.判定 = subJudgments(o, { 有复制路径: kind !== 'S' });
      o.结论 = 结论of(o.判定);
      o.符合期望 = judge(o);
      return o;
    }

    // A1 首拖正向：同一行内，从段首拖到 "four" 之前
    await row('A1', '正文第一次按下即拖动（同一视觉行，正向）', async function () {
      await drag(v, c.title, c.four);
      return snap({ 期望: { 选区: [c.title, c.four] } });
    });

    // A2 反向：从 "four" 拖到段首（从右往左）
    await row('A2', '反向拖动（从右往左）', async function () {
      await drag(v, c.four, c.title);
      return snap({ 期望: { 选区: [c.title, c.four] } });
    });

    // A3 越过起点折返：在词中间按下 → 往右拖 → 再折回**越过按下点**继续往左
    //    ⭐ 判据是 anchor 始终停在按下点，head 跑到按下点左边（方向翻成反向）。
    await row('A3', '越过按下点折返（方向应翻成反向，anchor 不动）', async function () {
      var press = c.title + 10;
      await drag(v, press, c.four, { hold: true });
      var pb = xy(v, c.title - 20);
      var pa = xy(v, c.four);
      for (var i = 1; i <= 8; i++) {
        fire(document, 'mousemove', pa.x + (pb.x - pa.x) * i / 8, pa.y + (pb.y - pa.y) * i / 8);
        await frame();
      }
      fire(document, 'mouseup', pb.x, pb.y);
      await frames(2);
      // ⚠️ 坐标是**几何前提**：`xy()` 在 `coordsAtPos` 返回 null 时给 `{0,0}`，
      //    而 `{0,0}` 在三条臂上都会解析成文档位置 0 ⇒ 判据会退化成"拖到了文首"。
      //    ⇒ 把它记下来，⛔ 别让夹具的几何缺陷伪装成行为差异。
      return snap({
        按下点: press, 折返点: c.title - 20,
        折返xy: [Math.round(pb.x), Math.round(pb.y)],
        坐标有效: !!(v.coordsAtPos(c.title - 20, 1)),
        期望: { 选区: [c.title - 20, press] }
      });
    });

    // A4 软换行：长段落里跨视觉行
    await row('A4', '跨软换行（`bugs/0043` 的形态）', async function () {
      await drag(v, c.long, c.long + 90);
      return snap({ 期望: { 选区: [c.long, c.long + 90] } });
    });

    // A5 跨真实换行：从第一段中间拖到第二段中间
    await row('A5', '跨真实换行（两个段落之间）', async function () {
      await drag(v, c.line0 + 10, c.title + 25);
      return snap({ 期望: { 选区: [c.line0 + 10, c.title + 25] } });
    });

    // A6 双击选词
    await row('A6', '双击选词（词中）', async function () {
      var p = xy(v, c.two + 2);
      fire(v.contentDOM, 'mousedown', p.x, p.y, { detail: 2 });
      fire(document, 'mouseup', p.x, p.y, { detail: 2 });
      await frames(2);
      return snap({ 期望: { 至少包含: [c.two, c.two + 3], 至多覆盖: [c.two - 1, c.two + 4] } });
    });

    // A7 双击后向右拖
    await row('A7', '双击之后继续向右拖', async function () {
      var p = xy(v, c.two + 1);
      fire(v.contentDOM, 'mousedown', p.x, p.y, { detail: 2 });
      await frame();
      var q = xy(v, c.four);
      for (var i = 1; i <= 6; i++) {
        fire(document, 'mousemove', p.x + (q.x - p.x) * i / 6, p.y);
        await frame();
      }
      fire(document, 'mouseup', q.x, q.y, { detail: 2 });
      await frames(2);
      // ⚠️ **行为差异，不判缺陷**（2026-10-29 用户复核后收窄）：「macOS 文本视图双击后按词扩展」
      //    这一条**未核实**（⛔ 没取到 mac 原生一手证据）⇒ 本行从**写死期望**降为**观测**，
      //    ⛔ 不再计入"不符"；等用户期望固定之后再判。
      return snap({ 期望: { 观测: true } });
    });

    // A8 双击后**反向**拖（`bugs/0044` 的形态）
    await row('A8', '双击之后反向拖（原选中词必须留在选区里）', async function () {
      var p = xy(v, c.two + 1);
      fire(v.contentDOM, 'mousedown', p.x, p.y, { detail: 2 });
      await frame();
      var q = xy(v, c.title);
      for (var i = 1; i <= 6; i++) {
        fire(document, 'mousemove', p.x + (q.x - p.x) * i / 6, p.y + (q.y - p.y) * i / 6);
        await frame();
      }
      fire(document, 'mouseup', q.x, q.y, { detail: 2 });
      await frames(2);
      return snap({ 期望: { 至少包含: [c.title, c.two + 3] } });
    });

    // A9 三击选行
    await row('A9', '三击选整行', async function () {
      var p = xy(v, c.title + 10);
      fire(v.contentDOM, 'mousedown', p.x, p.y, { detail: 3 });
      fire(document, 'mouseup', p.x, p.y, { detail: 3 });
      await frames(2);
      return snap({ 期望: { 至少包含: [c.title, c.title + paraLen], 至多覆盖: [c.title, c.title + paraLen + 1] } });
    });

    // A10 三击后反向拖
    await row('A10', '三击之后反向拖（两行都要在）', async function () {
      var p = xy(v, c.title + 10);
      fire(v.contentDOM, 'mousedown', p.x, p.y, { detail: 3 });
      await frame();
      var q = xy(v, c.line0 + 5);
      for (var i = 1; i <= 6; i++) {
        fire(document, 'mousemove', p.x + (q.x - p.x) * i / 6, p.y + (q.y - p.y) * i / 6);
        await frame();
      }
      fire(document, 'mouseup', q.x, q.y, { detail: 3 });
      await frames(2);
      return snap({ 期望: { 至少包含: [c.line0, c.title + paraLen] } });
    });

    // A11 双击边界：ASCII 词 / 标点 / 汉字 / Emoji
    for (var k = 0; k < 4; k++) {
      var targets = [
        ['A11a', '双击 ASCII 词（中英混排里）', c.english + 2, { 至少包含: [c.english, c.english + 7], 至多覆盖: [c.english - 1, c.english + 8] }],
        ['A11b', '双击全角标点', c.comma, { 至少包含: [c.comma, c.comma + 3], 至多覆盖: [c.comma - 1, c.comma + 4] }],
        ['A11c', '双击汉字（⭐ 已知口径差异，见上面那张表）', c.cjk - 3, { 策略差异: true }],
        ['A11d', '双击 Emoji（组合字符）', c.emoji, { 策略差异: true }]
      ];
      await (async function (t) {
        await row(t[0], t[1], async function () {
          var p = xy(v, t[2]);
          fire(v.contentDOM, 'mousedown', p.x, p.y, { detail: 2 });
          fire(document, 'mouseup', p.x, p.y, { detail: 2 });
          await frames(2);
          return snap({ 期望: t[3] });
        });
      })(targets[k]);
    }

    // A12 跨结构块的连续选区（纯文本下＝跨多行）
    await row('A12', '跨引用块 / 列表 / 代码围栏 / 表格源码（纯文本下只验连续性）', async function () {
      await drag(v, c.quote + 2, c.table + 6);
      return snap({ 期望: { 至少包含: [c.quote + 2, c.table + 6] } });
    });

    // A13 失焦 / 窗口外松开后拖动必须终止
    await row('A13', '松开之后（窗口外）再移动鼠标不得继续改选区', async function () {
      await drag(v, c.title, c.title + 12);
      var before = selectedText(v);
      var p = xy(v, c.title + 30);
      fire(document, 'mouseup', 0, 0);              // 在窗口外松开
      fire(document, 'mousemove', p.x, p.y);        // 之后再晃
      await frames(2);
      return snap({ 拖动前: before, 期望: { 选区: [c.title, c.title + 12] } });
    });

    // A14 输入之后选区映射（事务级，两臂同一份）
    await row('A14', '插入字符之后插入符仍紧跟其后', async function () {
      v.dispatch({ selection: { anchor: c.title, head: c.title } });
      v.dispatch({ changes: { from: c.title, insert: 'X' }, selection: { anchor: c.title + 1 }, userEvent: 'input.type' });
      await frames(2);
      return snap({ 期望: { 选区: [c.title + 1, c.title + 1] } });
    });

    // A15 撤销分组（`history()` 两臂同一份）
    await row('A15', '连打三个字符后一次 ⌘Z 全部收回（同一历史组）', async function () {
      var base = c.title;
      v.dispatch({ selection: { anchor: base, head: base } });
      for (var i = 0; i < 3; i++) {
        v.dispatch({ changes: { from: base + i, insert: 'abc'[i] }, selection: { anchor: base + i + 1 }, userEvent: 'input.type' });
      }
      await frame();
      var typed = v.state.sliceDoc(base, base + 3);
      CM.undo(v);
      await frames(2);
      return snap({ 打字后: typed, 撤销后: v.state.sliceDoc(base, base + 3), 期望: { 选区: [base, base] } });
    });

    // A16 自动滚动时拖动（超一屏）
    await row('A16', '拖到窗口下边缘：滚动容器是否真的滚了（超一屏）', async function () {
      var start = xy(v, c.line0 + 2);
      var sc = (document.body.scrollHeight > document.body.clientHeight) ? document.body
        : (document.documentElement.scrollHeight > document.documentElement.clientHeight ? document.documentElement : null);
      var before = sc ? sc.scrollTop : 0;
      fire(v.contentDOM, 'mousedown', start.x, start.y);
      await frame();
      var yBand = window.innerHeight - 10;
      for (var i = 0; i < 30; i++) {
        fire(document, 'mousemove', start.x + 40, yBand);
        await frame();
      }
      var after = sc ? sc.scrollTop : 0;
      fire(document, 'mouseup', start.x + 40, yBand);
      await frames(2);
      return snap({ 滚动容器: sc ? (sc === document.body ? 'body' : 'html') : '无', 滚动前: Math.round(before), 滚动后: Math.round(after), 期望: { 观测: true } });
    });

    // ── K 键盘路径 ────────────────────────────────────────────────────────
    // N（CM6 keymap）与 H（产品 R1 输入层的 keydown）**各有一条驱动器** ⇒ 这两臂可比。
    // ⛔ S 臂：产品的键盘路径是「隐藏 textarea ＋ `services/keymap.js`」，本夹具**故意不接线**
    //    （那会同时改两个变量）⇒ 只记「未测」，⛔ 不冒充已比较。
    async function keyRow(id, name, exp, fn) {
      await row(id, name, async function () {
        if (kind === 'S') {
          return {
            选区: null, 方向: null, 文本: '', 复制: '', 高亮: null, 符合期望: null,
            期望: exp, 未测: '产品键盘路径（隐藏 textarea ＋ keymap.js）本夹具不接线'
          };
        }
        return fn();
      });
    }

    await keyRow('K1', 'Shift+→ 扩选一个字（单臂：原生臂）', { 选区: [c.two, c.two + 1] }, async function () {
      v.dispatch({ selection: { anchor: c.two, head: c.two } });
      await frames(2);
      var handled = key(v, 'ArrowRight', { shiftKey: true }, kind);
      await frames(2);
      return snap({ 键被处理: handled, 期望: { 选区: [c.two, c.two + 1] } });
    });

    await keyRow('K2', '→ 收起选区（折叠到 head 一侧）', { 选区: [c.four, c.four] }, async function () {
      v.dispatch({ selection: { anchor: c.two, head: c.four } });
      await frames(2);
      var handled = key(v, 'ArrowRight', {}, kind);
      await frames(2);
      return snap({ 键被处理: handled, 期望: { 至少包含: [c.four, c.four], 至多覆盖: [c.four, c.four] } });
    });

    await keyRow('K3', '剪切选中文本（cliboardData ＋ 文档变短 ＋ ⌘Z 恢复）', { 观测: true }, async function () {
      v.dispatch({ selection: { anchor: c.two, head: c.two + 3 } });
      await frames(2);
      var before = v.state.sliceDoc(c.two, c.two + 3);
      var dt = new DataTransfer();
      var ev = new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true });
      // ⭐ 落点按臂取：H 的剪切由产品 `onCut` 接（读状态切片）；⛔ N 落 `contentDOM`。
      (kind === 'H' ? (v.__input || v.contentDOM) : v.contentDOM).dispatchEvent(ev);
      await frames(2);
      var cutText = dt.getData('text/plain');
      var after = v.state.sliceDoc(c.two, c.two + 3);
      var lenAfter = v.state.doc.length;
      CM.undo(v);
      await frames(2);
      return {
        选区: [c.two, c.two + 3], 方向: '正向',
        文本: before, 复制: cutText, 高亮: null, 期望: { 观测: true }, 符合期望: null,
        剪切前: before, 剪切后原处: after, 剪切后长度: lenAfter, 撤销后: v.state.sliceDoc(c.two, c.two + 3)
      };
    });

    await keyRow('K4', '⇧⌘← 扩选到行首（单臂：原生臂）', { 选区: [c.title, c.four] }, async function () {
      v.dispatch({ selection: { anchor: c.four, head: c.four } });
      await frames(2);
      var handled = key(v, 'ArrowLeft', { shiftKey: true, metaKey: true }, kind);
      await frames(2);
      return snap({ 键被处理: handled, 期望: { 选区: [c.title, c.four] } });
    });

    await keyRow('K5', '⌘A 全选（单臂：原生臂）', { 选区: [0, TEXT.length] }, async function () {
      var handled = key(v, 'a', { metaKey: true }, kind);
      await frames(2);
      return snap({ 键被处理: handled, 期望: { 选区: [0, TEXT.length] } });
    });

    // ── H 段：混合臂独有 ───────────────────────────────────────────────────
    //
    // ⭐ 用户 2026-10-29 指定的**第 1 步**：「只替换绘制：使用 `drawSelection`，接入真实 R1
    //    输入层，验证高亮、光标、复制和中文输入。」⇒ 这一段的每一条都在回答那四件事。
    // ⛔ 它**不**回答"内置鼠标能不能用"（那是第 2 步，本臂用的是产品自研鼠标）。
    if (kind === 'H') {
      var ta = v.__input;

      await row('H1', '不聚焦、不可编辑的 contentDOM 上，drawSelection 仍画出高亮', async function () {
        // 用**产品自研鼠标**拖一段（第 1 步不动鼠标，只换绘制）
        await drag(v, c.title, c.four);
        await frames(2);
        var s = selection(v);
        var cov = coverage(v, 'H', s.from, s.to);
        return {
          选区: [s.from, s.to], 方向: '正向', 文本: selectedText(v), 复制: '', 高亮: cov,
          contentDOM可编辑: v.contentDOM.getAttribute('contenteditable'),
          焦点在contentDOM: document.activeElement === v.contentDOM,
          焦点在离屏输入框: document.activeElement === ta,
          期望: { 观测: true }
        };
      });

      await row('H2', '光标层几何：`.cm-cursor` 与 head 处的字符盒对齐', async function () {
        var p = c.four;
        v.dispatch({ selection: { anchor: p, head: p } });
        await frames(2);
        var el = v.dom.querySelector('.cm-cursorLayer .cm-cursor');
        var r = el ? el.getBoundingClientRect() : null;
        var co = v.coordsAtPos(p, 1);
        // ⚠️ CM6 默认主题里 `.cm-cursor { display: none }`（view dist **6922**），
        //    只有 `&.cm-focused …` 才 block（**6958**）⇒ 本夹具补了一行 CSS 才看得见。
        return {
          选区: [p, p], 方向: '折叠', 文本: '', 复制: '', 高亮: null,
          光标元素: !!el,
          光标宽高: r ? [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10] : null,
          光标左: r ? Math.round(r.left * 10) / 10 : null,
          字符左: co ? Math.round(co.left * 10) / 10 : null,
          字符高: co ? Math.round((co.bottom - co.top) * 10) / 10 : null,
          display: el ? getComputedStyle(el).display : null,
          期望: { 观测: true }
        };
      });

      await row('H3', '复制走离屏 textarea（产品 selectedText 读状态切片）', async function () {
        v.dispatch({ selection: { anchor: c.two, head: c.two + 3 } });
        await frames(2);
        var cp = copyViaEvent(v, 'H');
        return {
          选区: [c.two, c.two + 3], 方向: '正向', 文本: selectedText(v),
          复制: cp.ok ? cp.text : ('未测：' + cp.why), 高亮: coverage(v, 'H', c.two, c.two + 3),
          期望: { 观测: true }
        };
      });

      await row('H3b', '⛔ 负判据：CM6 的 contentDOM copy 不接管（DOM 选区不在 contentDOM 里）', async function () {
        v.dispatch({ selection: { anchor: c.two, head: c.two + 3 } });
        await frames(2);
        var cp = copyViaEvent(v, 'N');   // 故意派到 `contentDOM`
        return {
          选区: [c.two, c.two + 3], 方向: '正向', 文本: selectedText(v),
          复制: cp.ok ? cp.text : ('未测：' + cp.why), 高亮: null,
          期望: { 观测: true }
        };
      });

      await row('H4', '中文组合：组合期文档一个字节都不动', async function () {
        var p = c.title + 5;
        v.dispatch({ selection: { anchor: p, head: p } });
        await frames(2);
        var len0 = v.state.doc.length;
        ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
        await frames(2);
        ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'n', bubbles: true }));
        await frames(2);
        ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ni', bubbles: true }));
        await frames(2);
        var lenMid = v.state.doc.length;
        var sameMid = v.state.sliceDoc() === TEXT;
        var composing = (v.__machine.state || {}).composing;
        return {
          选区: [p, p], 方向: '折叠', 文本: '', 复制: '', 高亮: null,
          组合期文档长度: lenMid, 与夹具逐字相同: sameMid, 组合态标志: composing,
          期望: { 观测: true }
        };
      });

      await row('H5', '中文上屏：compositionend 落一条事务，逐字进文档，光标在后', async function () {
        var p = c.title + 5;
        v.dispatch({ selection: { anchor: p, head: p } });
        await frames(2);
        var len0 = v.state.doc.length;
        ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
        await frames(1);
        ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ni', bubbles: true }));
        await frames(1);
        ta.dispatchEvent(new CompositionEvent('compositionend', { data: '你', bubbles: true }));
        await frames(2);
        return {
          选区: [p, p], 方向: '折叠',
          文本: v.state.sliceDoc(p, p + 1), 复制: '', 高亮: null,
          文档长度增量: v.state.doc.length - len0,
          光标: v.state.selection.main.head,
          期望: { 观测: true }
        };
      });

      await row('H6', '组合结束后那一发重复 input 被吃掉（⛔ 不许插两遍）', async function () {
        var p = c.title + 5;
        v.dispatch({ selection: { anchor: p, head: p } });
        await frames(2);
        ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
        await frames(1);
        ta.dispatchEvent(new CompositionEvent('compositionend', { data: '你', bubbles: true }));
        await frames(2);
        var before = v.state.doc.length;
        ta.dispatchEvent(new InputEvent('input', { data: '你', inputType: 'insertText', bubbles: true, cancelable: true }));
        await frames(2);
        return {
          选区: [p, p], 方向: '折叠', 文本: v.state.sliceDoc(p, p + 1), 复制: '', 高亮: null,
          重复前长度: before, 重复后长度: v.state.doc.length,
          期望: { 观测: true }
        };
      });

      await row('H7', '组合被取消（compositionend 空结果）：文档不动', async function () {
        var p = c.title + 5;
        v.dispatch({ selection: { anchor: p, head: p } });
        await frames(2);
        var len0 = v.state.doc.length;
        ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
        await frames(1);
        ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'zzz', bubbles: true }));
        await frames(1);
        ta.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
        await frames(2);
        return {
          选区: [p, p], 方向: '折叠', 文本: '', 复制: '', 高亮: null,
          文档长度增量: v.state.doc.length - len0, 与夹具逐字相同: v.state.sliceDoc() === TEXT,
          期望: { 观测: true }
        };
      });

      await row('H8', '⌘A 全选（R1 的 keydown 分支，⌘ 系归宿主、不归 CM6）', async function () {
        var handled = keyOn(ta, 'a', { metaKey: true });
        await frames(2);
        var s = selection(v);
        return {
          选区: [s.from, s.to], 方向: '正向', 文本: '', 复制: '', 高亮: null,
          键被处理: handled,
          期望: { 观测: true }
        };
      });
    }

    // ── R 段：取消 / 失败 / 重入 / 焦点变化 ────────────────────────────────
    //
    // ⭐ 2026-10-29 用户扩展评审（1×P1 ＋ 4×P2）的结论是**共性**：
    //    「接管了入口，却没完整接管取消、失败、重入和焦点变化。」
    //    ⇒ 这一段不新增能力，只把**这四类**落到可复跑的行上，回答"交还给 CM6 之后
    //    这些形态还存不存在"。⛔ 本段**不改 `src/live/**` 一个字节**。
    //
    // ⚠️ R1–R3 只有 H 臂产出：它们压的是**产品那份 `src/live/input.js`**（原样拷进 `.na-work/`），
    //    原生臂里**没有这个状态机**（CM6 自己观察 DOM 变更，合成事件驱动不了它）
    //    ⇒ 记「不可比」，⛔ 不伪造一条原生臂的绿灯。
    // ⚠️ R4/R5 两条臂都跑。

    await keyRow('R4', '⇧⌘→ 扩选到行尾（macOS 习惯：⌘→ = 行尾，⛔ 不是"右移一个字符"）', { 选区: [c.four, c.line2end] }, async function () {
      v.dispatch({ selection: { anchor: c.four, head: c.four } });
      await frames(2);
      var handled = key(v, 'ArrowRight', { shiftKey: true, metaKey: true }, kind);
      await frames(2);
      // ⚠️ **本条只测驱动端**：产品的 `main.js:3242` 是 `mods.alt ? 'wordRight' : 'charRight'`
      //    ——⌘ 修饰被忽略、又被 `preventDefault` 吃掉 ⇒ `⇧⌘→` 在真机上只扩**一个字符**。
      //    ⛔ 本行绿**不代表**产品已修：混合臂走的是本夹具自己的适配层。
      return snap({ 键被处理: handled, 期望: { 选区: [c.four, c.line2end] } });
    });

    await keyRow('R5', '把光标滚进视野：`EditorView.scrollIntoView` 与 `window.scrollBy` 各滚了谁', { 观测: true }, async function () {
      var page = pageScroller();
      var y0 = page ? page.scrollTop : 0;
      // ① 产品 `main.js:3030::ensureVisible` 的写法。⚠️ 本臂此时通常已经在**滚动上限**
      //    （三臂纵向叠放、H 是最后一臂）⇒ 往**上**滚 240 px，否则"滚不动"是夹具造成的假象。
      window.scrollBy(0, -240);
      await frames(2);
      var y1 = page ? page.scrollTop : 0;
      var w1 = window.scrollY;
      // ② CM6 的公开 API：把**视口外**的一个位置滚回来
      var far = at('填充行 30');
      v.dispatch({ effects: CM.EditorView.scrollIntoView(far) });
      await frames(3);
      var y2 = page ? page.scrollTop : 0;
      var box = v.coordsAtPos(far, 1);
      var inView = !!box && box.top >= 0 && box.bottom <= window.innerHeight;
      return {
        选区: [far, far], 方向: '折叠', 文本: '', 复制: '', 高亮: null,
        期望: { 观测: true }, 符合期望: null,
        滚动容器: page ? (page === document.body ? 'body' : 'documentElement') : null,
        可滚余量: page ? Math.round(page.scrollHeight - page.clientHeight) : null,
        'window.scrollBy生效': Math.round(y1) !== Math.round(y0),
        window滚动后: Math.round(w1),
        容器前: Math.round(y0), 容器window后: Math.round(y1), 容器CM6后: Math.round(y2),
        'CM6.scrollIntoView生效': Math.round(y2) !== Math.round(y1),
        目标行在视口内: inView
      };
    });

    // ── H 段第二部：产品输入状态机的取消 / 重入语义（⛔ 不改产品，只把它钉成回归行） ──
    if (kind === 'H') {
      var ta2 = v.__input;

      await row('R1', '组合期粘贴 → 组合被取消（⛔ 粘贴内容不许丢，也不许留到下一次输入）', async function () {
        var p = c.title + 5;
        v.dispatch({ selection: { anchor: p, head: p } });
        await frames(2);
        var len0 = v.state.doc.length;
        ta2.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
        await frames(1);
        ta2.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'zhong', bubbles: true }));
        await frames(1);
        var dt = new DataTransfer();
        dt.setData('text/plain', 'PASTED');
        ta2.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        await frames(2);
        var lenAfterPaste = v.state.doc.length;
        // 组合被取消（空结果）
        ta2.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
        await frames(2);
        var 取消后 = v.state.sliceDoc();
        var 取消后次数 = 取消后.split('PASTED').length - 1;
        var 取消后长度增量 = v.state.doc.length - len0;
        // ⭐ 用户报的形态：队列没清，下一处输入时旧内容突然出现
        var q = c.four;
        v.dispatch({ selection: { anchor: q, head: q } });
        await frames(2);
        ta2.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
        await frames(1);
        ta2.dispatchEvent(new CompositionEvent('compositionend', { data: '好', bubbles: true }));
        await frames(2);
        var 最终 = v.state.sliceDoc();
        var 最终次数 = 最终.split('PASTED').length - 1;
        var 落点 = 最终.indexOf('PASTED');
        // 期望写死：**组合取消不许吞掉粘贴内容**（用户规则：吞内容最不能接受），
        // 且它必须落在**当初粘贴的那一处**（⛔ 不是下一次输入的位置）。
        var ok = 取消后次数 === 1 && 取消后长度增量 === 6 && 最终次数 === 1 && 落点 === p;
        // ⚠️ 收尾把残留队列排干，⛔ 否则它会漏进后面的行（这正是本条要钉的那条缺陷）。
        v.__machine.handle({ type: 'cancel' });
        return {
          选区: [p + 6, p + 6], 方向: '折叠', 文本: '', 复制: '', 高亮: null,
          期望: { 观测: false }, 符合期望: ok,
          粘贴后长度增量: lenAfterPaste - len0,
          取消后PASTED次数: 取消后次数, 取消后长度增量: 取消后长度增量,
          第二次组合后PASTED次数: 最终次数, 落点: 落点, 应在: p,
          判: '组合取消后粘贴内容仍在原处一次（取消不许吞内容，也不许留到下一次输入）'
        };
      });

      await row('R2', '组合输入同一个字两次（中间删掉）不得被当成重复吞掉', async function () {
        var p = c.title + 5;
        v.dispatch({ selection: { anchor: p, head: p } });
        await frames(2);
        var len0 = v.state.doc.length;
        ta2.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
        await frames(1);
        ta2.dispatchEvent(new CompositionEvent('compositionend', { data: 'a', bubbles: true }));
        await frames(2);
        var 第一次 = v.state.sliceDoc(p, p + 1);
        // 删掉它
        keyOn(ta2, 'Backspace');
        await frames(2);
        var 删除后长度 = v.state.doc.length - len0;
        // 再输入同一个字（⛔ 这是**真输入**，不是 WebKit 的补发）
        ta2.dispatchEvent(new InputEvent('input', { data: 'a', inputType: 'insertText', bubbles: true, cancelable: true }));
        await frames(2);
        var 第二次 = v.state.sliceDoc(p, p + 1);
        var 最终长度 = v.state.doc.length - len0;
        // 期望写死：真输入必须落进文档（吞内容不可接受）
        var ok = 第一次 === 'a' && 删除后长度 === 0 && 第二次 === 'a' && 最终长度 === 1;
        v.__machine.handle({ type: 'cancel' });
        return {
          选区: [p + 1, p + 1], 方向: '折叠', 文本: '', 复制: '', 高亮: null,
          期望: { 观测: false }, 符合期望: ok,
          第一次上屏: 第一次, 删除后长度增量: 删除后长度, 重新输入后: 第二次, 最终长度增量: 最终长度,
          判: '组合上屏 → 删掉 → 再输入同一个字：第三次必须真的落进文档'
        };
      });

      await row('R3', '剪切：没确认剪贴板写成功，正文不得先删（`main.js:3399` 的形态）', async function () {
        v.dispatch({ selection: { anchor: c.two, head: c.two + 3 } });
        await frames(2);
        var before = v.state.sliceDoc(c.two, c.two + 3);
        // ⚠️ 合成 `cut` **不带 clipboardData**：模拟"剪贴板拿不到"这一支。
        var ev = new ClipboardEvent('cut', { bubbles: true, cancelable: true });
        ta2.dispatchEvent(ev);
        await frames(2);
        var after = v.state.sliceDoc(c.two, c.two + 3);
        var ok = after === before;   // 没写进剪贴板 ⇒ 不许删
        v.__machine.handle({ type: 'cancel' });
        return {
          选区: [c.two, c.two + 3], 方向: '正向', 文本: before, 复制: '', 高亮: null,
          期望: { 观测: false }, 符合期望: ok,
          事件里的剪贴板: ev.clipboardData ? '有' : '无',
          剪切后原处: after, 文档长度增量: v.state.doc.length - TEXT.length,
          说明: '⚠️ 合成 ClipboardEvent 与真机剪贴板不是一回事：本条只钉「未确认写入即删」这条**结构**，⛔ 不替代真机复制粘贴验收',
          判: '剪贴板没拿到内容时，正文必须原样不动'
        };
      });
    }

    void longLen;
    return out;
  }

  // ── 交还鼠标臂 HM：**只换鼠标**之后发生了什么（M1–M7）──────────────────────
  //
  // ⭐ 用户 2026-10-29 指定的**第 2 步**原话：「再替换鼠标处理（验只读视图、内置拖选与
  //    焦点交还，失败记录事件链）」⇒ 下面逐项回答，⛔ 一条也不回头改产品的自研鼠标。
  //
  // ⚠️ 本段是**第四条臂**，⛔ 不并入 H 的 26 条矩阵：那 26 条的「两臂只差绘图」前提会被破坏。
  //    与 N 臂的同动作对照由每行的 `对应` 字段给出（A1 / A5 / A6），在 `__RUN` 里按 id 配对。
  //
  // ⚠️ 合成事件的边界：`mousedown` 是**页内合成**的，但本臂的焦点变化**不是**浏览器默认行为
  //    带来的 —— 它由 CM6 自己的 `focusPreventScroll(view.contentDOM)`（view dist **5013**）
  //    显式触发 ⇒ 这一条**可以**用合成事件判（⛔ 与"合成按键造不出 IME 组合态"不同类）。
  async function mouseMatrix(v) {
    var out = [];
    var c = {
      title: at('Second paragraph'),
      four: at('four.'),
      two: at('two three'),
      line0: at('第一段'),
      cjk: at('中文与'),
      emoji: at('😀')
    };

    /** 产品形态：键盘落在离屏 `textarea` 上。 */
    function focusInput() {
      try { v.__input.focus({ preventScroll: true }); }
      catch (e) { v.__input.focus(); }
    }

    /** `document.activeElement` 的**可读名字**——事件链里只认这几个。 */
    function 落点(el) {
      var a = el === undefined ? document.activeElement : el;
      if (!a) return 'null';
      if (a === v.__input) return '离屏textarea';
      if (a === v.contentDOM) return 'contentDOM';
      if (v.dom && v.dom.contains(a)) return '编辑器内部';
      if (a === document.body) return 'body';
      return String(a.nodeName || a).toLowerCase();
    }

    async function row(id, name, fn) {
      reset(v);
      await frames(2);
      var r;
      try {
        r = await fn();
      } catch (e) {
        r = { 选区: null, 文本: '⛔ 抛错：' + ((e && e.message) || e), 复制: '', 高亮: null,
              期望: { pass: false } };
      }
      r.id = id;
      r.动作 = name;
      out.push(r);
      return r;
    }

    /**
     * ⚠️ 本臂的期望有三种形状：
     *   `{ pass: bool }` —— 非选区类判据（焦点、输入是否落进文档），由行自己算；
     *   `{ 选区 | 至少包含 | 至多覆盖 }` —— 与 `matrix()` 同口径；
     *   `{ 观测: true }` —— ⛔ 不判对错（诊断行）。
     * ⚠️ 这里只判**范围**；复制/覆盖/越界由 `subJudgments()` 各判各的。
     */
    function judge(o) {
      return judgeRange(o);
    }

    function snap(extra) {
      var s = selection(v);
      var cp = copyViaEvent(v, 'HM');
      var cov = s.empty ? null : coverage(v, 'HM', s.from, s.to);
      var o = {
        选区: [s.from, s.to],
        方向: s.anchor < s.head ? '正向' : (s.anchor > s.head ? '反向' : '折叠'),
        文本: selectedText(v),
        复制: cp.ok ? cp.text : ('未测：' + cp.why),
        高亮: cov
      };
      if (extra) for (var kk in extra) o[kk] = extra[kk];
      o.判定 = subJudgments(o, { 有复制路径: true });
      o.结论 = 结论of(o.判定);
      o.符合期望 = judge(o);
      return o;
    }

    // M1 只读视图：`EditorView.editable.of(false)` **不**阻止 CM6 的 `MouseSelection`
    //    —— 它只挡输入，不挡选区（`basicMouseSelection` 里没有任何 editable 判断，dist 5055）。
    await row('M1', '只读视图（editable=false）单击：仍然给出折叠光标', async function () {
      focusInput();
      var p = xy(v, c.four);
      fire(v.contentDOM, 'mousedown', p.x, p.y);
      fire(document, 'mouseup', p.x, p.y);
      await frames(2);
      return snap({
        期望: { 至多覆盖: [c.four - 2, c.four + 2] },
        只读: v.state.facet(CM.EditorView.editable) === false,
        点击处: c.four,
        说明: '⚠️ 容差 ±2：落点由 `posAtCoords` 按字形边缘给，⛔ 本行不判左右半字'
      });
    });

    // M2 内置拖选：A1 的同一动作（同一视觉行、正向）
    await row('M2', '内置拖选（同一行，A1 的同一动作）', async function () {
      focusInput();
      var g = await drag(v, c.title, c.four);
      return snap({
        期望: { 选区: [c.title, c.four] },
        对应: 'A1',
        按下被接管: !!g.down.defaultPrevented,
        说明: '`defaultPrevented` = CM6 的 `handlers.mousedown` 返回了 true（dist 5021）'
      });
    });

    // M2b 内置拖选跨真实换行（A5 的同一动作）
    await row('M2b', '内置拖选跨真实换行（A5 的同一动作）', async function () {
      focusInput();
      await drag(v, c.line0 + 10, c.title + 25);
      return snap({ 期望: { 选区: [c.line0 + 10, c.title + 25] }, 对应: 'A5' });
    });

    // M3 焦点交还：⭐ 本段的**核心判据**。
    //    CM6 的 `handlers.mousedown`（dist 5009–5017）：
    //      `mustFocus = !view.hasFocus` ⇒ `focusPreventScroll(view.contentDOM)`，
    //      再把"不在 contentDOM 里"的 activeElement `blur()` 掉。
    //    产品形态要求键盘落在离屏 `textarea` 上 ⇒ 焦点被抢走 = 输入层从此收不到任何键。
    await row('M3', '焦点交还：点击之后输入层是否仍持有焦点', async function () {
      focusInput();
      var before = 落点();
      var p = xy(v, c.four);
      fire(v.contentDOM, 'mousedown', p.x, p.y);
      await frame();
      var mid = 落点();
      fire(document, 'mouseup', p.x, p.y);
      await frames(2);
      var after = 落点();
      return snap({
        期望: { pass: after === '离屏textarea' },
        焦点_点击前: before,
        焦点_mousedown后: mid,
        焦点_mouseup后: after,
        view_hasFocus: v.hasFocus,
        document_hasFocus: document.hasFocus(),
        说明: '⚠️ 离屏窗口不是 key ⇒ `document.hasFocus()` 恒 false ⇒ `view.hasFocus` 恒 false '
          + '⇒ `mustFocus` 每按必真。真窗口里第一次点击同样为真（contentDOM 从不被聚焦过）'
      });
    });

    // M4 点击之后真打字：⭐ 把「焦点被抢」翻译成**可判的功能后果**。
    //    键盘事件派到**此刻真正的焦点**上（⛔ 不是强行派给 textarea —— 那样是假绿）。
    await row('M4', '点击之后打字：字符必须落进文档（键派给真实焦点）', async function () {
      focusInput();
      var p = xy(v, c.four);
      fire(v.contentDOM, 'mousedown', p.x, p.y);
      fire(document, 'mouseup', p.x, p.y);
      await frames(2);
      var tgt = document.activeElement || document.body;
      var len0 = v.state.doc.length;
      keyOn(tgt, 'x');
      tgt.dispatchEvent(new InputEvent('input', {
        data: 'x', inputType: 'insertText', bubbles: true, cancelable: true
      }));
      await frames(2);
      var delta = v.state.doc.length - len0;
      return snap({
        期望: { pass: delta === 1 },
        键盘落点: 落点(tgt),
        文档长度增量: delta,
        说明: '真实链路的替代：先 keydown、再 input，两者都派到**当时真的持有焦点**的那个元素'
      });
    });

    // M5 事件链 ⭐ 用户点名的「失败记录事件链」：诊断行，⛔ 不判对错。
    await row('M5', '焦点变化的事件链（⛔ 诊断行，不判对错）', async function () {
      focusInput();
      var chain = [];
      function onOut(e) { chain.push('focusout:' + 落点(e.target) + '→' + 落点(e.relatedTarget)); }
      function onIn(e) { chain.push('focusin:' + 落点(e.target)); }
      document.addEventListener('focusout', onOut, true);
      document.addEventListener('focusin', onIn, true);
      chain.push('前置:active=' + 落点());
      var p = xy(v, c.four);
      var down = fire(v.contentDOM, 'mousedown', p.x, p.y);
      chain.push('mousedown:' + 落点(down.target) + (down.defaultPrevented ? '·已接管' : '·未接管'));
      await frame();
      fire(document, 'mouseup', p.x, p.y);
      await frames(2);
      document.removeEventListener('focusout', onOut, true);
      document.removeEventListener('focusin', onIn, true);
      chain.push('收尾:active=' + 落点());
      return snap({ 期望: { 观测: true }, 事件链: chain, 链条条数: chain.length });
    });

    // M6 双击选词（只读视图下，A6 的同一动作）
    await row('M6', '只读视图双击选词（A6 的同一动作）', async function () {
      focusInput();
      var p = xy(v, c.two + 2);
      fire(v.contentDOM, 'mousedown', p.x, p.y, { detail: 2 });
      fire(document, 'mouseup', p.x, p.y, { detail: 2 });
      await frames(2);
      return snap({
        期望: { 至少包含: [c.two, c.two + 3], 至多覆盖: [c.two - 1, c.two + 4] },
        对应: 'A6'
      });
    });

    // M7 「口径」能否全走**公开面**（A7 / A11c / A11d 那三处差异的替代方案）：
    //    `EditorView.mouseSelectionStyle` 是**公开 facet**（dist 8901）⇒ 自定义口径不需要 fork。
    //    这里只证明**可达**，⛔ 不裁定该不该改（口径本身仍未判，见 §3.2）。
    out.push(await mouseStyleExperiment());
    // ⭐ 复评 P2-4：三项具体选择策略（按词拖动 / CJK / 字素）——⛔ 不并入 M7 那一条
    var 词策略 = await wordStrategyExperiment();
    for (var wi = 0; wi < 词策略.length; wi++) out.push(词策略[wi]);

    return out;
  }

  // ── 焦点交还的**适配候选**（⭐ 2026-10-29 复评 P2-3）─────────────────────────
  //
  // ⚠️ M3/M4 只是**负对照**：不做任何适配时，CM6 的 `handlers.mousedown`
  //    （view dist **5009–5017**）把焦点从离屏 `textarea` 抢到 `contentDOM` 且**不还**
  //    ⇒ 点击后打字 0 字符。⛔ 这只能证明"直接替换鼠标不够"，
  //    **不能**据此断言"鼠标交还必须连键盘一起迁移"。
  //
  // 这里补**四个最小公开事件适配**候选（各用新视图，⛔ 不碰 CM6 内部、⛔ 不改 `src/**`）：
  //    F0 不适配（⭐ 负对照：期望**重现**缺陷，所以它的两条 fail 是这一臂成立的证据）
  //    F1 `contentDOM.focus()` 置空 —— CM6 的 `focusPreventScroll`（dist 5013）落不到实处
  //    F2 `contentDOM` 上听 `focusin`，立刻把焦点还给离屏 `textarea`
  //    F3 `mouseup` 时同步还焦（复评点名的"最小句"，先跑一遍看它够不够）
  //    F4 = F2＋F3，整个手势期间都按在 `textarea` 上（专治"mousedown 那一刻失焦 ⇒ IME 中止"）
  // 每个候选跑**同一组**动作，按复评点名的四档比较：
  //    拖动中 / 松开后（含外部松开）/ 组合输入中点击 / 点击后复制（＋"点击后打字"这条功能后果）。
  // ⚠️ 候选失败时**必须留下具体事件序列**——每行都有 `事件链` 或分档的焦点快照。
  async function focusAdaptationExperiment() {
    var out = [];
    var c = {
      title: at('Second paragraph'),
      two: at('two three'),
      four: at('four.')
    };
    var 候选 = [
      {
        // ⚠️ 负对照的期望**是反的**：它就该重现缺陷（焦点被抢走、点击后打字 0）。
        //    ⛔ 别把"F0 两条 fail"读成产品缺陷又冒出来了 —— 那是这一臂**成立的证据**。
        id: 'F0', 名: '不适配（负对照，与 M3/M4 同一形态）', 负对照: true,
        装: function () { return function () {}; }
      },
      {
        id: 'F1', 名: '适配 A：把 `contentDOM.focus()` 置空',
        装: function (v) {
          var orig = v.contentDOM.focus;
          v.contentDOM.focus = function () { /* 故意不聚焦 */ };
          return function () { v.contentDOM.focus = orig; };
        }
      },
      {
        id: 'F2', 名: '适配 B：`focusin` 立刻回焦离屏 `textarea`',
        装: function (v) {
          var h = function () {
            try { v.__input.focus({ preventScroll: true }); } catch (e) { v.__input.focus(); }
          };
          v.contentDOM.addEventListener('focusin', h);
          return function () { v.contentDOM.removeEventListener('focusin', h); };
        }
      },
      {
        // ⭐ 复评原话：「不预设 mouseup 直接 focus 一句就能解决全部问题」⇒ 把它当候选 F3 真跑一遍。
        //    ⚠️ 这是**最小句**（同步、capture 相、监听在 document 上）：合上"焦点归还/点击后打字"，
        //       但它把 copy 也一起从 `contentDOM` 挪走 ⇒ 复制路径必须由产品自己接管。
        id: 'F3', 名: '适配 C（复评点名的"最小句"）：`mouseup` 时同步把焦点还给离屏 `textarea`',
        装: function (v) {
          var h = function () { 聚焦输入(v); };
          document.addEventListener('mouseup', h, true);
          return function () { document.removeEventListener('mouseup', h, true); };
        }
      },
      {
        // ⭐ F4 = F2 ＋ F3：**整个手势期间**都把焦点按在离屏 `textarea` 上。
        //    动机很具体：F3 的合成链显示焦点在 `mousedown` 那一刻仍被 CM6 抢到 `contentDOM`、
        //    到 `mouseup` 才还回来 —— 真机 WebKit 就是在**失焦那一刻**中止组合输入的。
        //    F4 把这段空窗压掉（合成事件只能证明"没有那次 focusout"，⛔ 证不了 WebKit 不中止）。
        id: 'F4', 名: '适配 D：`focusin` 回焦 ＋ `mouseup` 再兜一次（F2＋F3）',
        装: function (v) {
          var 回焦 = function () { 聚焦输入(v); };
          v.contentDOM.addEventListener('focusin', 回焦);
          document.addEventListener('mouseup', 回焦, true);
          return function () {
            v.contentDOM.removeEventListener('focusin', 回焦);
            document.removeEventListener('mouseup', 回焦, true);
          };
        }
      }
    ];

    function 谁是焦点(v) {
      var a = document.activeElement;
      if (!a) return 'null';
      if (a === v.__input) return '离屏textarea';
      if (a === v.contentDOM) return 'contentDOM';
      if (v.dom && v.dom.contains(a)) return '编辑器内部';
      if (a === document.body) return 'body';
      return String(a.nodeName || a).toLowerCase();
    }
    function 聚焦输入(v) {
      try { v.__input.focus({ preventScroll: true }); } catch (e) { v.__input.focus(); }
    }
    /** 派 copy 到**指定的**元素（⛔ 不按臂写死——这一组要测"焦点在谁那儿"的后果）。 */
    function copyOn(target) {
      try {
        var dt = new DataTransfer();
        var ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return { ok: true, text: dt.getData('text/plain') };
      } catch (e) { return { ok: false, text: '', 错: String((e && e.message) || e) }; }
    }
    function 快照(v, extra) {
      var s = selection(v);
      var cp = copyViaEvent(v, 'HM');
      var cov = s.empty ? null : coverage(v, 'HM', s.from, s.to);
      var o = {
        选区: [s.from, s.to],
        方向: s.anchor < s.head ? '正向' : (s.anchor > s.head ? '反向' : '折叠'),
        文本: selectedText(v),
        复制: cp.ok ? cp.text : ('未测：' + cp.why),
        高亮: cov
      };
      if (extra) for (var kk in extra) o[kk] = extra[kk];
      o.判定 = subJudgments(o, { 有复制路径: true });
      o.结论 = 结论of(o.判定);
      o.符合期望 = judgeRange(o);
      return o;
    }

    for (var ci = 0; ci < 候选.length; ci++) {
      var cand = 候选[ci];
      var host = document.createElement('div');
      host.className = 'armHost';
      // ⚠️ 同 `mouseStyleExperiment`：必须落在**视口内**，否则 `coordsAtPos` 量不到
      host.style.position = 'fixed';
      host.style.left = '0px';
      host.style.top = '0px';
      host.style.width = '520px';
      host.style.background = '#fff';
      host.style.zIndex = '9998';
      document.body.appendChild(host);

      var v = makeView('HM', host);
      await frames(3);
      var 卸载 = cand.装(v);
      var 前文 = '候选 ' + cand.id + '（' + cand.名 + '）：';

      async function r(tag, 名, fn) {
        // ⚠️ 每一行都从**同一份文档**起跑：F3/F5 会真的往文档里落字，
        //    不清回去的话后面几行的锚点（`at()` 算的是夹具原文的位置）全部作废。
        if (v.state.doc.toString() !== TEXT) {
          v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: TEXT } });
        }
        v.dispatch({ selection: { anchor: 0, head: 0 } });
        await frames(2);
        var o;
        try {
          o = await fn();
        } catch (e) {
          o = { 选区: null, 文本: '⛔ 抛错：' + ((e && e.message) || e), 复制: '', 高亮: null,
                期望: { pass: false } };
        }
        o.id = cand.id + tag;
        o.动作 = 前文 + 名;
        o.判定 = o.判定 || subJudgments(o, { 有复制路径: true });
        o.结论 = o.结论 || 结论of(o.判定);
        out.push(o);
        return o;
      }

      // F*1 拖动中：⛔ 不松手就记录（焦点归属与选区是否都在跟着走）
      await r('1', '拖动中：选区随 mousemove 更新，焦点归属逐档记录', async function () {
        聚焦输入(v);
        var before = 谁是焦点(v);
        var a = xy(v, c.title), b = xy(v, c.four);
        fire(v.contentDOM, 'mousedown', a.x, a.y);
        await frame();
        var afterDown = 谁是焦点(v);
        fire(document, 'mousemove', (a.x + b.x) / 2, (a.y + b.y) / 2);
        await frame();
        var mid = selection(v);
        var midFocus = 谁是焦点(v);
        fire(document, 'mousemove', b.x, b.y);
        await frame();
        var o = 快照(v, { 期望: { 选区: [c.title, c.four] } });
        o.焦点_按下前 = before;
        o.焦点_mousedown后 = afterDown;
        o.焦点_拖动中 = midFocus;
        o.半途选区 = [mid.from, mid.to];
        fire(document, 'mouseup', b.x, b.y);
        await frames(2);
        o.焦点_松开后 = 谁是焦点(v);
        return o;
      });

      // F*2 松开后：适配候选必须把焦点还给离屏 `textarea`；负对照 F0 则**应该还不了**
      await r('2', '松开后：焦点回到离屏 `textarea`（负对照 F0 的期望相反）', async function () {
        聚焦输入(v);
        var p = xy(v, c.four);
        fire(v.contentDOM, 'mousedown', p.x, p.y);
        await frame();
        var mid = 谁是焦点(v);
        fire(document, 'mouseup', p.x, p.y);
        await frames(2);
        var after = 谁是焦点(v);
        var 期望焦点 = cand.负对照 ? 'contentDOM' : '离屏textarea';
        var o = 快照(v, {
          期望: { pass: after === 期望焦点 },
          期望焦点: cand.负对照 ? 'contentDOM（负对照：缺陷应重现）' : '离屏textarea'
        });
        o.焦点_mousedown后 = mid;
        o.焦点_松开后 = after;
        return o;
      });

      // F*3 功能后果：点击之后打一个字（键派给**当时真的持有焦点**的那个元素）
      await r('3', '点击之后打字：字符落进文档（负对照 F0 的期望相反）', async function () {
        聚焦输入(v);
        var p = xy(v, c.four);
        fire(v.contentDOM, 'mousedown', p.x, p.y);
        fire(document, 'mouseup', p.x, p.y);
        await frames(2);
        var tgt = document.activeElement || document.body;
        var len0 = v.state.doc.length;
        keyOn(tgt, 'x');
        tgt.dispatchEvent(new InputEvent('input', {
          data: 'x', inputType: 'insertText', bubbles: true, cancelable: true
        }));
        await frames(2);
        var delta = v.state.doc.length - len0;
        return 快照(v, {
          期望: { pass: cand.负对照 ? delta === 0 : delta === 1 },
          期望增量: cand.负对照 ? '0（负对照：缺陷应重现）' : '1',
          键盘落点: 谁是焦点(v),
          文档长度增量: delta
        });
      });

      // F*4 外部松开：`mouseup` **不在编辑器上**（派到 body）时，选区是否仍然成立
      await r('4', '外部松开（mouseup 派到 body）：选区仍应成立', async function () {
        聚焦输入(v);
        var a = xy(v, c.title), b = xy(v, c.four);
        fire(v.contentDOM, 'mousedown', a.x, a.y);
        await frame();
        fire(document, 'mousemove', b.x, b.y);
        await frame();
        fire(document.body, 'mouseup', b.x, b.y);
        await frames(2);
        var o = 快照(v, { 期望: { 选区: [c.title, c.four] } });
        o.焦点_外部松开后 = 谁是焦点(v);
        return o;
      });

      // F*5 组合输入中点击：⭐ 真正危险的一档（真实 WebKit 会中止组合）
      await r('5', '组合输入中点击：文档只应落上屏那一个字', async function () {
        聚焦输入(v);
        var p = xy(v, c.four);
        var len0 = v.state.doc.length;
        var chain = [];
        function onOut() { chain.push('focusout→' + 谁是焦点(v)); }
        function onIn() { chain.push('focusin→' + 谁是焦点(v)); }
        document.addEventListener('focusout', onOut, true);
        document.addEventListener('focusin', onIn, true);
        v.__input.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
        await frame();
        v.__input.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ni', bubbles: true }));
        await frame();
        chain.push('组合中:焦点=' + 谁是焦点(v));
        fire(v.contentDOM, 'mousedown', p.x, p.y);
        await frame();
        chain.push('点击后:焦点=' + 谁是焦点(v));
        fire(document, 'mouseup', p.x, p.y);
        await frames(2);
        v.__input.dispatchEvent(new CompositionEvent('compositionend', { data: '你', bubbles: true }));
        await frames(2);
        document.removeEventListener('focusout', onOut, true);
        document.removeEventListener('focusin', onIn, true);
        var delta = v.state.doc.length - len0;
        var o = 快照(v, {
          期望: { pass: delta === 1 },
          文档长度增量: delta,
          事件链: chain
        });
        o.说明 = '⚠️ 合成事件造不出"WebKit 因失焦中止组合"这一形态 ⇒ 本行只钉'
          + '「组合中点击不许把文档搞乱」，真机中止行为仍在「未测」';
        return o;
      });

      // F*6 点击之后复制：copy 派给**当时真的持有焦点**的元素（⛔ 不按臂写死）
      await r('6', '点击之后复制：copy 派给真实焦点，内容应等于选区文本', async function () {
        聚焦输入(v);
        await drag(v, c.two, c.two + 3);
        var want = selectedText(v);
        var tgt = document.activeElement || document.body;
        var cp = copyOn(tgt);
        var o = 快照(v, {
          期望: { 选区: [c.two, c.two + 3] },
          复制落点: 谁是焦点(v),
          事件里读到的复制: cp.ok ? cp.text : ('未测：' + cp.错),
          期望文本: want
        });
        // ⚠️ `快照()` 自己已经派过一次 copy（⛔ 恒派给离屏 `textarea`）⇒ 这一行要的是
        //    "**真实焦点**在谁那儿、copy 落到那儿拿到什么"，所以在这里**覆盖**掉那一条判定。
        o.判定.复制 = cp.ok ? (cp.text === want && want === 'two') : '未测';
        o.结论 = 结论of(o.判定);
        o.说明 = 'copy 派给 `activeElement`：F0 是 `contentDOM`（CM6 的 handlers.copy，'
          + 'dist 5221 第一句就判 DOM 选区在不在 `contentDOM` 里）；F1/F2 实测落在 `body`'
          + '（合成 mousedown 不跑浏览器默认聚焦，CM6 的显式 `.focus()` 又被取消了）；'
          + 'F3 落在离屏 `textarea` ⇒ CM6 的 copy 处理够不着，复制路径必须由产品自己接管'
          + '（产品 `main.js::selectedText` 就是那条路，本夹具没接 ⇒ ⛔ 不能拿这一行否定 F3）';
        return o;
      });

      卸载();
      if (host.parentNode) host.parentNode.removeChild(host);
    }
    return out;
  }

  /**
   * M7：用一个**只走公开面**的自定义 `mouseSelectionStyle` 换掉双击口径。
   * ⭐ 正面：双击汉字 ⇒ 选整行（自定义规则生效）；⭐ 负对照：单击 ⇒ 自定义返回 null ⇒ 仍走默认。
   */
  async function mouseStyleExperiment() {
    var host = document.createElement('div');
    host.className = 'armHost';
    // ⚠️ 必须落在**视口内**：追加到文末的话 rect 在窗口外 ⇒ 鼠标坐标量不到（同 `autoScrollExperiment`）
    host.style.position = 'fixed';
    host.style.left = '0px';
    host.style.top = '0px';
    host.style.width = '520px';
    host.style.zIndex = '9999';
    document.body.appendChild(host);

    var called = 0;
    var diag = { 工厂: [], get: [] };
    var v2 = new CM.EditorView({
      state: CM.EditorState.create({
        doc: TEXT,
        extensions: [
          CM.EditorView.lineWrapping,
          CM.drawSelection(),
          CM.EditorView.editable.of(false),
          CM.EditorView.contentAttributes.of({ tabindex: '-1', 'aria-hidden': 'true' }),
          CM.EditorView.mouseSelectionStyle.of(function (view2, down) {
            called++;
            try {
              if (down.detail !== 2) { diag.工厂.push('非双击⇒null'); return null; }
              var pos = view2.posAtCoords({ x: down.clientX, y: down.clientY });
              if (pos == null) { diag.工厂.push('posAtCoords=null'); return null; }
              var line = view2.state.doc.lineAt(pos);
              diag.工厂.push('pos=' + pos + ' line=[' + line.from + ',' + line.to + ']');
              return {
                // ⚠️ `update` **必须**有：`MouseSelection.update` 无条件调 `this.style.update(update)`
                //    （view dist 4862）—— 少了它，选中后那一次 `dispatch` 会在更新流水线里抛
                //    `TypeError`，而 DOM 事件派发会**吞掉**异常 ⇒ 屏幕上表现为"选区纹丝不动"。
                update: function () { return false; },
                get: function () {
                  // ⚠️⚠️ 必须给 **`EditorSelection`**（有 `.ranges`），⛔ 不是 `EditorSelection.range()`
                  //    返回的那**单个** `SelectionRange`（state dist 1364：`SelectionRange.create` 的别名）。
                  //    给错了 `skipAtomsForSelection`（view dist 3783）读 `sel.ranges.length` 会抛
                  //    `TypeError`，而 DOM 事件派发**吞掉**异常 ⇒ 屏幕上只表现为"选区纹丝不动"，
                  //    连 `window.onerror` 都只剩一句 `Script error.`（实测踩过）。
                  var r = CM.EditorSelection.single(line.from, line.to);
                  var m = r.main;
                  diag.get.push(m.from + '..' + m.to);
                  return r;
                }
              };
            } catch (e) {
              diag.工厂.push('抛错：' + ((e && e.message) || e));
              return null;
            }
          })
        ]
      }),
      parent: host
    });
    await frames(4);

    var r;
    var errs = [];
    var 派发 = [];
    function onErr(e) { errs.push(String((e && e.message) || e)); }
    window.addEventListener('error', onErr);
    // ⚠️ WebKit 对页内 `error` 只给一句 `Script error.` ⇒ 把 `dispatch` 包一层拿栈
    //    （⭐ 正是它揪出了「返回了 `SelectionRange` 而不是 `EditorSelection`」那次静默失败）。
    var origDispatch = v2.dispatch.bind(v2);
    v2.dispatch = function (spec) {
      try {
        var rv = origDispatch(spec);
        var s = v2.state.selection.main;
        派发.push('选区→' + s.from + '..' + s.to);
        return rv;
      } catch (e) {
        派发.push('抛错：' + String((e && e.stack) || e).split('\n')[0]);
        throw e;
      }
    };
    try {
      // ① 双击汉字 ⇒ 自定义口径：整行
      var p1 = xy(v2, at('中文与') + 1);
      fire(v2.contentDOM, 'mousedown', p1.x, p1.y, { detail: 2 });
      var sel_down = [v2.state.selection.main.from, v2.state.selection.main.to];
      fire(document, 'mouseup', p1.x, p1.y, { detail: 2 });
      var sel_up = [v2.state.selection.main.from, v2.state.selection.main.to];
      await frames(2);
      var s1 = v2.state.selection.main;

      // ② 负对照：单击 ⇒ 自定义返回 null，走 CM6 默认（折叠）
      var p2 = xy(v2, at('four.'));
      fire(v2.contentDOM, 'mousedown', p2.x, p2.y);
      fire(document, 'mouseup', p2.x, p2.y);
      await frames(2);
      var s2 = v2.state.selection.main;

      var lineLen = LINES[0].length;
      r = {
        选区: [s1.from, s1.to],
        文本: v2.state.sliceDoc(s1.from, s1.to),
        复制: '',
        高亮: null,
        期望: { pass: called >= 2 && s1.from === 0 && s1.to === lineLen && s2.from === s2.to },
        facet被调用次数: called,
        双击汉字: [s1.from, s1.to],
        单击负对照: [s2.from, s2.to],
        mousedown后: sel_down,
        mouseup后: sel_up,
        第一行长度: lineLen,
        文档长度: v2.state.doc.length,
        点击坐标: [Math.round(p1.x), Math.round(p1.y)],
        诊断_工厂: diag.工厂,
        诊断_get: diag.get,
        诊断_派发: 派发,
        页内错误: errs,
        说明: '自定义 `mouseSelectionStyle` 只走公开 API（`posAtCoords` / `doc.lineAt` / `EditorSelection.range`）；'
          + '⛔ 不改 `@codemirror/view` 一个字节'
      };
    } catch (e) {
      r = { 选区: null, 文本: '⛔ 抛错：' + ((e && e.message) || e), 复制: '', 高亮: null,
            期望: { pass: false }, 页内错误: errs };
    }
    window.removeEventListener('error', onErr);
    v2.destroy();
    host.remove();
    r.符合期望 = r.期望 && typeof r.期望.pass === 'boolean' ? r.期望.pass : null;
    r.id = 'M7';
    r.动作 = '口径能否全走公开面：自定义 `mouseSelectionStyle`（A7 / A11c / A11d 的替代方案）';
    return r;
  }

  // ── M8–M10：⭐ 2026-10-29 复评 P2-4「三项具体选择策略」──────────────────────
  //
  // 复评原话：「M7 只证明公开扩展口能工作……下一步只在公开扩展候选中补齐三组真实动作和
  // 明确期望，验证方向折返、词边界、字素边界，不复制 CM6 内部鼠标实现，不改生产自研鼠标。」
  //
  // ⭐ 候选策略**全部由公开面写成**，一行内部实现都没抄：
  //    `EditorView.mouseSelectionStyle`（公开 facet；`MouseSelectionStyle.get` 的**声明**就是
  //    `(curEvent: MouseEvent, extend, multiple) => EditorSelection`，dist d.ts 621 行）
  //    ＋ `view.posAtCoords` ＋ `view.state.doc` 的文本 ＋ **`Intl.Segmenter`（平台分词/字素）**。
  // ⛔ 没动 `@codemirror/view` 的 `basicMouseSelection` / `MouseSelection`；
  // ⛔ 没动产品 `src/live/selection.js` 的 `installMouse`（复评明确禁止"改自研鼠标来追平对照"）。
  //
  // ⚠️ 这三行判的是**候选策略本身**（既不是产品、也不是 CM6 默认口径）：
  //    它们回答"公开扩展口**够不够**写出这三种策略"，⛔ 不是"产品该不该这么改"。
  // ⚠️ 视图里**没有复制路径**（独立视图没接产品输入层，DOM 选区也不在 `contentDOM` 里）
  //    ⇒ 「复制」这一栏一律 `不判`，⛔ 不记通过。

  /** 平台分词器。⭐ 词边界与字素边界都由它给，⛔ 不自造一套规则。 */
  var 词段器 = (function () {
    try { return new Intl.Segmenter('zh', { granularity: 'word' }); } catch (e) { return null; }
  })();

  /**
   * `pos` 所在**非空白词段**的 `{from,to}`。
   * 落在空白里 ⇒ 朝 `dir` 找最近的词（到行边就反向找一次）—— 「Emoji 两侧的空格」就靠这条。
   */
  function 词边界(doc, pos, dir) {
    var line = doc.lineAt(pos);
    var list = Array.from(词段器.segment(line.text));
    var off = Math.max(0, Math.min(line.length, pos - line.from));
    var i = -1;
    for (var k = 0; k < list.length; k++) {
      var s = list[k];
      if (off >= s.index && off < s.index + s.segment.length) { i = k; break; }
    }
    if (i < 0) i = list.length - 1;                    // 行尾
    if (i < 0) return { from: line.from, to: line.from };
    if (!list[i].segment.trim()) {                     // 落进空白 ⇒ 朝 dir 找词
      var j = i + dir;
      while (j >= 0 && j < list.length && !list[j].segment.trim()) j += dir;
      if (j < 0 || j >= list.length) {                 // 到边 ⇒ 反向找一次
        j = i - dir;
        while (j >= 0 && j < list.length && !list[j].segment.trim()) j -= dir;
      }
      if (j >= 0 && j < list.length) i = j;
    }
    var seg = list[i];
    return { from: line.from + seg.index, to: line.from + seg.index + seg.segment.length };
  }

  /** 「双击起手 ＋ 按词扩展 ＋ 可折返」的候选样式。⛔ 只走公开 facet 与公开方法。
   *  @param 边界 词边界函数（默认 `词边界`；⭐ 变异对照会传一个**故意写坏**的进来）
   *  @param 计数 可选计数器：`{工厂, get}` —— 用来证明"是这段策略在答，⛔ 不是 CM6 默认口径" */
  function 造词样式(边界, 计数) {
    var B = 边界 || 词边界;
    return CM.EditorView.mouseSelectionStyle.of(function (view2, down) {
      if ((down.detail || 1) !== 2) return null;        // 非双击 ⇒ 退回 CM6 默认（负对照仍在 M7）
      var p0 = view2.posAtCoords({ x: down.clientX, y: down.clientY });
      if (p0 == null) return null;
      if (计数) 计数.工厂 = (计数.工厂 || 0) + 1;
      var 锚 = B(view2.state.doc, p0, 1);
      return {
        // ⚠️ `update` 必须有：`MouseSelection.update` 无条件调 `style.update`（dist 4862）。
        update: function () { return false; },
        get: function (cur) {
          if (计数) 计数.get = (计数.get || 0) + 1;
          var p1 = view2.posAtCoords({ x: cur.clientX, y: cur.clientY });
          if (p1 == null) p1 = p0;
          if (p1 >= p0) {                              // 向右拖 ⇒ anchor 钉在种子词首
            var 右 = B(view2.state.doc, p1, 1);
            return CM.EditorSelection.single(锚.from, Math.max(右.to, 锚.to));
          }
          var 左 = B(view2.state.doc, p1, -1);          // 折返 ⇒ anchor 钉在种子词尾
          return CM.EditorSelection.single(锚.to, Math.min(左.from, 锚.from));
        }
      };
    });
  }

  /** ⭐ 变异对照用的**故意写坏**的边界：只取光标那一个字符（即"没有词边界"）。
   *  ⚠️ 它必须让 M8 的期望**打红** —— 否则说明判据本身对词边界不敏感。 */
  function 坏边界(doc, pos) {
    var line = doc.lineAt(pos);
    var off = Math.max(0, Math.min(line.length - 1, pos - line.from));
    return { from: line.from + off, to: line.from + off + 1 };
  }

  async function wordStrategyExperiment() {
    var out = [];
    if (!词段器) {
      out.push({
        id: 'M8', 动作: '三项具体选择策略（按词 / CJK / 字素）',
        选区: null, 文本: '未测：本机没有 Intl.Segmenter', 复制: '', 高亮: null,
        不再单列: 'M9 / M10 同因未跑', 未测: '本机没有 `Intl.Segmenter` ⇒ 三条策略一律不判'
      });
      return out;
    }

    function 记步(v2, steps, 名, 期望) {
      var s = selection(v2);
      var t = v2.state.doc.sliceString(s.from, s.to);
      var good = (typeof 期望 === 'function') ? !!期望(t) : (t === 期望);
      steps.push({
        步: 名, 选区: [s.from, s.to], 文本: t,
        期望: (typeof 期望 === 'function') ? '谓词：非空且首尾无空白' : 期望,
        ok: good
      });
      return t;
    }

    function 收尾(v2, steps) {
      var s = selection(v2);
      var cov = s.from === s.to ? null : coverage(v2, 'H', s.from, s.to);
      var 全对 = steps.every(function (x) { return x.ok; });
      var r = {
        选区: [s.from, s.to],
        方向: s.anchor < s.head ? '正向' : (s.anchor > s.head ? '反向' : '折叠'),
        文本: v2.state.doc.sliceString(s.from, s.to),
        复制: '不判',
        高亮: cov,
        步骤: steps,
        分段器: 'Intl.Segmenter("zh", {granularity:"word"})',
        说明: '候选策略只走公开面（`mouseSelectionStyle` / `posAtCoords` / `Intl.Segmenter`）；'
          + '⛔ 未改 CM6 内部鼠标、⛔ 未改产品 `installMouse`；独立视图没有复制路径 ⇒ 复制 `不判`'
      };
      r.判定 = {
        范围: 全对,
        复制: '不判',
        覆盖: !cov ? '不判' : (cov.覆盖率 === null ? '未测' : cov.覆盖率 >= 覆盖下限),
        越界: !cov ? '不判' : (cov.越界率 === null ? '未测' : cov.越界率 <= 越界上限)
      };
      r.结论 = 结论of(r.判定);
      r.期望 = { pass: 全对 };
      return r;
    }

    async function 跑(id, 名, doc, fn, 样式, 计数) {
      var host = document.createElement('div');
      host.className = 'armHost';
      // ⚠️ 同 `mouseStyleExperiment`：必须落在**视口内**，否则 `coordsAtPos` 量不到
      host.style.position = 'fixed';
      host.style.left = '0px';
      host.style.top = '0px';
      host.style.width = '520px';
      host.style.background = '#fff';
      host.style.zIndex = '9997';
      document.body.appendChild(host);
      var v2 = new CM.EditorView({
        state: CM.EditorState.create({
          doc: doc,
          extensions: [
            CM.EditorView.lineWrapping,
            CM.drawSelection(),
            CM.EditorView.editable.of(false),
            CM.EditorView.contentAttributes.of({ tabindex: '-1', 'aria-hidden': 'true' }),
            (样式 || 造词样式)(计数)
          ]
        }),
        parent: host
      });
      await frames(4);
      var r;
      try {
        r = await fn(v2);
      } catch (e) {
        r = {
          选区: null, 文本: '⛔ 抛错：' + ((e && e.message) || e), 复制: '', 高亮: null,
          判定: { 范围: false, 复制: '不判', 覆盖: '不判', 越界: '不判' }, 结论: 'fail'
        };
      }
      v2.destroy();
      if (host.parentNode) host.parentNode.removeChild(host);
      r.id = id;
      r.动作 = 名;
      if (计数) r.样式被调用 = 计数;
      r.符合期望 = judgeRange(r);
      out.push(r);
      return r;
    }

    // ── M8（A7）：双击起手 ⇒ 按词向右扩展 ⇒ 折返越过锚点 ──────────────────
    await 跑('M8', '⭐ 按词拖动扩展 ＋ 方向折返（A7）', TEXT, async function (v2) {
      var steps = [];
      var p0 = xy(v2, at('two three') + 1);
      var p1 = xy(v2, at('four.') + 1);
      var p2 = xy(v2, at('words two') + 1);
      fire(v2.contentDOM, 'mousedown', p0.x, p0.y, { detail: 2 });
      await frames(2);
      记步(v2, steps, '双击「two」⇒ 种子词', 'two');
      fire(document, 'mousemove', p1.x, p1.y);
      await frames(2);
      记步(v2, steps, '拖到「four」⇒ 按词向右扩展', 'two three four');
      fire(document, 'mousemove', p2.x, p2.y);
      await frames(2);
      记步(v2, steps, '折返到「words」⇒ 越过锚点改由左侧扩展', 'words two');
      fire(document, 'mouseup', p2.x, p2.y);
      await frames(2);
      return 收尾(v2, steps);
    });

    // ── M9（A11c）：CJK 词边界 —— 整词 vs 单字，以及跨中英混排的按词扩展 ─────
    await 跑('M9', '⭐ CJK 词边界（A11c）：双击整词 ＋ 跨中英混排按词扩展', TEXT, async function (v2) {
      var steps = [];
      async function 双击(pos) {
        var p = xy(v2, pos);
        fire(v2.contentDOM, 'mousedown', p.x, p.y, { detail: 2 });
        await frames(2);
        fire(document, 'mouseup', p.x, p.y, { detail: 2 });
        await frames(2);
      }
      await 双击(at('中文与') + 1);
      记步(v2, steps, '双击「中文」⇒ 两字词整取', '中文');
      await 双击(at('中文与') + 2);
      记步(v2, steps, '双击「与」⇒ 单字成词', '与');
      await 双击(at('标点') + 1);
      记步(v2, steps, '双击「标点」⇒ 两字词整取', '标点');
      var a = xy(v2, at('中文与') + 1), b = xy(v2, at('标点') + 1);
      fire(v2.contentDOM, 'mousedown', a.x, a.y, { detail: 2 });
      await frames(2);
      fire(document, 'mousemove', b.x, b.y);
      await frames(2);
      记步(v2, steps, '从「中文」拖到「标点」⇒ 跨中英混排按词扩展',
        '中文与 English 混排，标点');
      fire(document, 'mouseup', b.x, b.y);
      await frames(2);
      return 收尾(v2, steps);
    });

    // ── M10（A11d）：Emoji ＋ 两侧空格 ＋ 字素边界 ───────────────────────────
    //    ⚠️ 刻意用**独立短文档**：字素样例必须逐字在视口内，长夹具里那几行会被
    //    CM6 的视口虚拟化挡在渲染区外 ⇒ `coordsAtPos` 量不到（那就变成了"环境不成立"，
    //    ⛔ 不是"策略不符"）。策略本身只看文本，与夹具无关。
    var 家族 = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
    var 组合 = 'é';
    var 字素文档 = '字素：Emoji 😀 以及 ' + 组合 + ' 与 ' + 家族 + ' 结束。\n第二行占位。';
    await 跑('M10', '⭐ Emoji 与两侧空格 ＋ 字素边界（A11d）', 字素文档, async function (v2) {
      var steps = [];
      var iEmoji = 字素文档.indexOf('😀');
      var i组合 = 字素文档.indexOf(组合);
      var i家族 = 字素文档.indexOf(家族);
      async function 双击(pos) {
        var p = xy(v2, pos);
        fire(v2.contentDOM, 'mousedown', p.x, p.y, { detail: 2 });
        await frames(2);
        fire(document, 'mouseup', p.x, p.y, { detail: 2 });
        await frames(2);
      }
      await 双击(iEmoji);
      记步(v2, steps, '双击 😀 ⇒ 独立成一个单位、不吞空格', '😀');
      await 双击(iEmoji - 1);
      记步(v2, steps, '双击「😀 左侧空格」⇒ 退到右边那个词', '😀');
      await 双击(iEmoji + 2);
      记步(v2, steps, '双击「😀 右侧空格」⇒ 非空且首尾无空白', function (t) {
        return t.length > 0 && t.trim() === t;
      });
      await 双击(i组合);
      记步(v2, steps, '双击组合字符 e＋U+0301 ⇒ 整簇取走（字素边界）', 组合);
      await 双击(i家族);
      记步(v2, steps, '双击 ZWJ 家族 👨‍👩‍👧‍👦 ⇒ 整簇取走（字素边界）', 家族);
      return 收尾(v2, steps);
    });

    // ── M8m：⭐ **变异对照**（⛔ 不是第四个候选）───────────────────────────
    //    「没做过变异测试的断言不算数」：把 `词边界` 换成**只取一个字符**的坏实现，
    //    重跑 M8 那三步 ⇒ 判据**必须**打红。打不红说明 M8 的通过是判据不敏感（或 CM6 默认口径
    //    本来就这样），⛔ 那三行就不能算证据。
    //    ⚠️ 这一行的状态是 `观测`（`期望.观测`），⛔ 不参与退出码：变异命中才是期望结果。
    await 跑('M8m',
      '⭐ 变异对照（⛔ 不是候选）：同组动作换**写坏的词边界**，判据必须打红',
      TEXT,
      async function (v2) {
        var steps = [];
        var p0 = xy(v2, at('two three') + 1);
        var p1 = xy(v2, at('four.') + 1);
        var p2 = xy(v2, at('words two') + 1);
        fire(v2.contentDOM, 'mousedown', p0.x, p0.y, { detail: 2 });
        await frames(2);
        记步(v2, steps, '双击「two」⇒ 坏边界只给一个字符', 'two');
        fire(document, 'mousemove', p1.x, p1.y);
        await frames(2);
        记步(v2, steps, '拖到「four」⇒ 坏边界不按词扩展', 'two three four');
        fire(document, 'mousemove', p2.x, p2.y);
        await frames(2);
        记步(v2, steps, '折返到「words」⇒ 坏边界无折返规则', 'words two');
        fire(document, 'mouseup', p2.x, p2.y);
        await frames(2);
        var r = 收尾(v2, steps);
        r.变异命中 = steps.some(function (s) { return !s.ok; });
        r.期望 = { 观测: true };
        r.判定 = { 范围: r.变异命中, 复制: '不判', 覆盖: '不判', 越界: '不判' };
        r.结论 = 结论of(r.判定);
        r.说明 = '变异对照：`坏边界` 只取光标下一个字符。'
          + '⭐ 变异命中 = true 才说明 M8 那三行**量到了词边界**（⛔ 不是 CM6 默认口径自己给的）；'
          + '命中 false ⇒ M8/M9/M10 的通过作废，先修判据';
        return r;
      },
      function (计数) { return 造词样式(坏边界, 计数); },
      {});

    return out;
  }

  // ── E4：文档级集成原型（⭐ 用户三步走的**第 3 步**）─────────────────────────
  //
  // 判据（`notes/0041` §5 的 E4 行）：**跨块拖选 / 跨块复制内容 / 块间 ⌘Z 的连续性 /
  // 一次保存的字节**。⚠️ 这一节回答的是"单块视图的边界是不是跨块失败的根"，
  // ⛔ 不是"产品该不该改成整篇一份 EditorState"。
  //
  // 两个对象并排比：
  //   · **DD**（文档级）：整篇一份 `EditorState` 的 CM6 视图，形态同 HM 臂
  //     （`drawSelection` ＋ 产品 `input.js` 的离屏输入 ＋ CM6 自带鼠标），⛔ 不装自研鼠标。
  //   · **DB**（单块负对照）：**每块一个视图**（产品现行形态，S 臂形态），跑同一组动作。
  //
  // ⚠️「保存」只比**字节**：`TextEncoder` 序列化结果 vs `e4-doc.md` 的**磁盘字节**
  //    （由 `probe.sh` 用 node 读盘后写成 `window.__E4.b64`）⇒ ⛔ 不是"页面里的字符串跟它自己比"。
  //    ⛔ 真写盘（Rust 侧 `fs` 那条路）不在本夹具，已记「未测」。
  async function documentLevelExperiment() {
    var out = [];
    var src = window.__E4;
    if (!src || typeof src.doc !== 'string' || !src.b64) {
      out.push({
        id: 'D0', 动作: '文档级集成原型（E4）',
        选区: null, 文本: '未测：页面没拿到 `e4-bytes.js`', 复制: '', 高亮: null,
        判定: { 范围: '未测', 复制: '未测', 覆盖: '未测', 越界: '未测' },
        结论: '未测', 期望: { pass: false },
        说明: '`probe.sh` 没生成 `e4-bytes.js`（`e4-doc.md` 读盘失败）⇒ 字节比对**不成立**，⛔ 不记通过'
      });
      return out;
    }

    var 全文 = src.doc;

    /** 按**空行**切块（与本夹具的文档形态一致：块之间恰好一个空行）。 */
    function 切块(doc) {
      var out2 = [], re = /\n[ \t]*\n/g, start = 0, m;
      while ((m = re.exec(doc)) !== null) {
        out2.push({ from: start, to: m.index });
        start = m.index + m[0].length;
      }
      out2.push({ from: start, to: doc.length });
      return out2;
    }
    /** `pos` 落在第几块（0 起）。 */
    function 块号(blocks, pos) {
      for (var i = 0; i < blocks.length; i++) {
        if (pos <= blocks[i].to) return i;
      }
      return blocks.length - 1;
    }
    function 全真(j) {
      for (var k in j) {
        if (j[k] !== true && j[k] !== '不判') return false;
      }
      return true;
    }
    function 收(r, 判定, 说明) {
      r.判定 = 判定;
      r.结论 = 结论of(r.判定);
      r.期望 = { pass: 全真(判定) };
      r.说明 = 说明;
      out.push(r);
      return r;
    }
    /** 派 copy 到指定元素，读 `clipboardData`（⛔ 不写系统剪贴板）。 */
    function copyOn(target) {
      try {
        var dt = new DataTransfer();
        var ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return { ok: true, text: dt.getData('text/plain') };
      } catch (e) { return { ok: false, text: '', 错: String((e && e.message) || e) }; }
    }

    var blocks = 切块(全文);

    // ── DD：整篇一份 EditorState ────────────────────────────────────────────
    var hostDD = document.createElement('div');
    hostDD.className = 'armHost';
    hostDD.style.position = 'fixed';
    hostDD.style.left = '0px';
    hostDD.style.top = '0px';
    hostDD.style.width = '520px';
    hostDD.style.background = '#fff';
    hostDD.style.zIndex = '9996';
    document.body.appendChild(hostDD);
    var vDD = makeView('HM', hostDD, 全文);
    await frames(4);

    var 起 = 全文.indexOf('第一段') + 3;      // 第 2 块内部
    var 止 = 全文.indexOf('引用块') + 3;      // 第 5 块内部

    // D1 跨块拖选
    try {
      var a1 = xy(vDD, 起), b1 = xy(vDD, 止);
      fire(vDD.contentDOM, 'mousedown', a1.x, a1.y);
      await frame();
      fire(document, 'mousemove', (a1.x + b1.x) / 2, (a1.y + b1.y) / 2);
      await frame();
      fire(document, 'mousemove', b1.x, b1.y);
      await frames(2);
      var s1 = selection(vDD);
      fire(document, 'mouseup', b1.x, b1.y);
      await frames(2);
      var 文本1 = vDD.state.doc.sliceString(s1.from, s1.to);
      var 覆盖块 = [];
      for (var bi = 0; bi < blocks.length; bi++) {
        if (s1.to > blocks[bi].from && s1.from < blocks[bi].to) 覆盖块.push(bi + 1);
      }
      var cov1 = s1.empty ? null : coverage(vDD, 'HM', s1.from, s1.to);
      var 起块 = 块号(blocks, s1.from) + 1, 止块 = 块号(blocks, s1.to) + 1;
      var 范围ok = Math.abs(s1.from - 起) <= 2 && Math.abs(s1.to - 止) <= 2
        && 起块 === 2 && 止块 === 5 && 覆盖块.join(',') === '2,3,4,5'
        && (文本1.match(/\n\n/g) || []).length === 3;   // 块间分隔符**完整保留**
      收({
        id: 'D1',
        动作: '跨块拖选：从第 2 块拖到第 5 块',
        选区: [s1.from, s1.to], 文本: 文本1,
        方向: s1.anchor < s1.head ? '正向' : (s1.anchor > s1.head ? '反向' : '折叠'),
        块数: blocks.length, 起块: 起块, 止块: 止块, 覆盖块: 覆盖块,
        块间分隔符: (文本1.match(/\n\n/g) || []).length,
        期望区间: [起, 止],
        复制: '不判',
        高亮: cov1
      }, {
        范围: 范围ok,
        复制: '不判',
        覆盖: !cov1 ? '不判' : (cov1.覆盖率 === null ? '未测' : cov1.覆盖率 >= 覆盖下限),
        越界: !cov1 ? '不判' : (cov1.越界率 === null ? '未测' : cov1.越界率 <= 越界上限)
      }, '整篇一份 `EditorState` ⇒ 选区天然跨块；判据里**块间分隔符必须原样保留**（3 个空行）——'
        + '那是"每块各选各的"结构上拼不出来的东西');
    } catch (e) {
      收({ id: 'D1', 动作: '跨块拖选', 选区: null, 文本: '⛔ 抛错：' + ((e && e.message) || e) },
        { 范围: false, 复制: '不判', 覆盖: '不判', 越界: '不判' }, '拖选抛错');
    }

    // D2 跨块复制（copy 派给**真实焦点**）
    try {
      var tgt2 = document.activeElement || document.body;
      var cp2 = copyOn(tgt2);
      var 选中2 = vDD.state.doc.sliceString(
        vDD.state.selection.main.from, vDD.state.selection.main.to);
      var 复制ok = cp2.ok && cp2.text === 选中2 && 选中2.length > 0
        && (选中2.match(/\n\n/g) || []).length === 3;
      收({
        id: 'D2',
        动作: '跨块复制：`copy` 派给真实焦点，内容应逐字节等于跨块选区',
        复制落点: tgt2 === vDD.__input ? '离屏textarea'
          : (tgt2 === vDD.contentDOM ? 'contentDOM'
            : (tgt2 === document.body ? 'body' : String(tgt2.nodeName || tgt2))),
        复制: cp2.ok ? cp2.text : ('未测：' + cp2.错),
        选区文本: 选中2,
        文本一致: cp2.ok ? (cp2.text === 选中2) : false,
        块间分隔符: (选中2.match(/\n\n/g) || []).length,
        高亮: null
      }, {
        范围: 选中2.length > 0,
        复制: 复制ok,
        覆盖: '不判',
        越界: '不判'
      }, '跨块复制靠的是**读状态切片**（产品 `main.js::selectedText` 的同形实现）；'
        + '⛔ 副本不写系统剪贴板，只读事件里的 `clipboardData`');
    } catch (e) {
      收({ id: 'D2', 动作: '跨块复制', 选区: null, 文本: '⛔ 抛错：' + ((e && e.message) || e) },
        { 范围: false, 复制: false, 覆盖: '不判', 越界: '不判' }, '复制抛错');
    }

    // D4 保存字节（⭐ 在**编辑之前**比：这一行要的是"没动过的文档序列化 == 磁盘字节"）
    try {
      var got = new TextEncoder().encode(vDD.state.doc.toString());
      var raw = atob(src.b64);
      var want = new Uint8Array(raw.length);
      for (var ri = 0; ri < raw.length; ri++) want[ri] = raw.charCodeAt(ri);
      var 首个不符 = -1;
      var n = Math.min(got.length, want.length);
      for (var gi = 0; gi < n; gi++) {
        if (got[gi] !== want[gi]) { 首个不符 = gi; break; }
      }
      var 字节相同 = 首个不符 === -1 && got.length === want.length;
      收({
        id: 'D4',
        动作: '保存字节：整篇序列化（UTF-8）与 `e4-doc.md` 的磁盘字节逐字节相同',
        序列化字节数: got.length, 磁盘字节数: want.length, 首个不符字节: 首个不符,
        字节相同: 字节相同, 文本: '', 复制: '不判', 高亮: null, 选区: null
      }, {
        范围: 字节相同,
        复制: '不判',
        覆盖: '不判',
        越界: '不判'
      }, '磁盘字节由 `probe.sh` 用 node 读 `e4-doc.md` 生成 ⇒ ⛔ 不是自比；'
        + '⛔ 真写盘（Rust 侧）不在夹具内，已记「未测」');
    } catch (e) {
      收({ id: 'D4', 动作: '保存字节', 选区: null, 文本: '⛔ 抛错：' + ((e && e.message) || e) },
        { 范围: false, 复制: '不判', 覆盖: '不判', 越界: '不判' }, '字节比对抛错');
    }

    // D3 块间撤销连续性（⭐ 会改文档，放在字节比对**之后**）
    try {
      var p甲 = 全文.indexOf('一次覆盖多段。') + '一次覆盖多段。'.length;
      var p乙 = 全文.indexOf('按文档顺序退回。') + '按文档顺序退回。'.length;
      vDD.dispatch({ changes: { from: p甲, insert: '甲' }, selection: { anchor: p甲 + 1 } });
      vDD.dispatch({ changes: { from: p乙 + 1, insert: '乙' }, selection: { anchor: p乙 + 2 } });
      await frames(2);
      var 深 = CM.undoDepth(vDD.state);
      var 两处都在 = vDD.state.doc.toString().indexOf('甲') > 0
        && vDD.state.doc.toString().indexOf('乙') > 0;
      CM.undo(vDD);
      await frames(2);
      var 一退 = vDD.state.doc.toString();
      var 先退乙 = 一退.indexOf('乙') < 0 && 一退.indexOf('甲') > 0;
      CM.undo(vDD);
      await frames(2);
      var 二退 = vDD.state.doc.toString();
      var 再退甲 = 二退.indexOf('甲') < 0 && 二退 === 全文;
      收({
        id: 'D3',
        动作: '块间撤销：第 2 块插入「甲」、第 5 块插入「乙」⇒ ⌘Z 两次按文档顺序退回',
        撤销深度: 深, 两处都在: 两处都在, 一次撤销后: 先退乙 ? '只剩「甲」' : (一退 === 全文 ? '两处都退了' : '顺序不对'),
        两次撤销后回到原文: 再退甲,
        文本: 二退.slice(p甲 - 4, p甲 + 6), 复制: '不判', 高亮: null, 选区: null
      }, {
        范围: 深 >= 2 && 两处都在 && 先退乙 && 再退甲,
        复制: '不判',
        覆盖: '不判',
        越界: '不判'
      }, '整篇一份 `history()` ⇒ 撤销**按文档顺序**退；⚠️ 两次编辑是**程序化派发**的，'
        + '⛔ 不是真键盘，但它走的正是产品 `input.js` → `view.dispatch` 的同一出口');
    } catch (e) {
      收({ id: 'D3', 动作: '块间撤销', 选区: null, 文本: '⛔ 抛错：' + ((e && e.message) || e) },
        { 范围: false, 复制: '不判', 覆盖: '不判', 越界: '不判' }, '撤销抛错');
    }

    if (vDD.__uninstallHybrid) vDD.__uninstallHybrid();
    vDD.destroy();
    if (hostDD.parentNode) hostDD.parentNode.removeChild(hostDD);

    // ── DB：单块负对照（产品现行形态：每块一个视图）────────────────────────
    //    ⚠️ 期望**是反的**（与 F0 同构）：它就该重现"单块边界的代价"——
    //       跨块选区**拼不出来**、⌘Z **不按文档顺序**。
    var hostA = document.createElement('div'), hostB = document.createElement('div');
    [hostA, hostB].forEach(function (h, i) {
      h.className = 'armHost';
      h.style.position = 'fixed';
      h.style.top = '0px';
      h.style.left = (i === 0 ? 0 : 560) + 'px';
      h.style.width = '520px';
      h.style.background = '#fff';
      h.style.zIndex = '9995';
      document.body.appendChild(h);
    });
    var 块2 = 全文.slice(blocks[1].from, blocks[1].to);
    var 块5 = 全文.slice(blocks[4].from, blocks[4].to);
    var vA = makeView('S', hostA, 块2);
    var vB = makeView('S', hostB, 块5);
    await frames(4);
    try {
      vA.dispatch({ selection: { anchor: 0, head: vA.state.doc.length } });
      vB.dispatch({ selection: { anchor: 0, head: vB.state.doc.length } });
      await frames(2);
      var 选区A = vA.state.doc.sliceString(vA.state.selection.main.from, vA.state.selection.main.to);
      var 选区B = vB.state.doc.sliceString(vB.state.selection.main.from, vB.state.selection.main.to);
      // ① 跨块选区拼不出来：两个 `EditorState` 之间没有共享的选择对象，⌘A 各选各块
      var 跨块选区 = 选区A === 块2 && 选区B === 块5
        && 选区A.indexOf(块5) < 0 && 选区B.indexOf(块2) < 0;
      // ② 撤销不连续：在 A 编辑、在 B 编辑，在 B 上 ⌘Z 只退 B
      vA.dispatch({ changes: { from: 0, insert: '甲' } });
      vB.dispatch({ changes: { from: 0, insert: '乙' } });
      await frames(2);
      CM.undo(vB);
      await frames(2);
      var B退了 = vB.state.doc.toString().indexOf('乙') < 0;
      var A没退 = vA.state.doc.toString().indexOf('甲') >= 0;
      var 单块局限 = 跨块选区 && B退了 && A没退;
      收({
        id: 'D5',
        动作: '负对照（单块视图）：跨块选区与文档顺序撤销**应当重现局限**',
        每块一个视图: '是（产品现行形态）',
        各块全选文本: [选区A, 选区B],
        跨块选区可再生: 跨块选区 ? '否（两个 EditorState 之间没有共享选择对象）' : '是（⚠️ 判据不成立）',
        在A编辑后在B撤销: (B退了 && A没退) ? '只退了 B，A 仍含「甲」' : '⚠️ 出现了跨视图撤销',
        局限重现: 单块局限,
        文本: vA.state.doc.toString().slice(0, 8), 复制: '不判', 高亮: null, 选区: null
      }, {
        范围: 单块局限,
        复制: '不判',
        覆盖: '不判',
        越界: '不判'
      }, '⭐ **负对照的期望是反的**：`范围=true` 表示"单块边界的两个代价都重现了"，'
        + '⛔ 不是"产品坏了"；它和 D1–D4 一起回答"跨块失败是不是单块视图的根"');
    } catch (e) {
      收({ id: 'D5', 动作: '单块负对照', 选区: null, 文本: '⛔ 抛错：' + ((e && e.message) || e) },
        { 范围: false, 复制: '不判', 覆盖: '不判', 越界: '不判' }, '负对照抛错');
    }
    if (vA.__uninstallMouse) vA.__uninstallMouse();
    if (vB.__uninstallMouse) vB.__uninstallMouse();
    vA.destroy(); vB.destroy();
    [hostA, hostB].forEach(function (h) { if (h.parentNode) h.parentNode.removeChild(h); });

    out.sort(function (x, y) { return x.id < y.id ? -1 : (x.id > y.id ? 1 : 0); });
    return out;
  }

  // ── 成本采样（⚠️ 参考数字，⛔ 不是闸门） ────────────────────────────────
  async function cost(kind, host) {
    var big = [];
    for (var i = 0; i < 2000; i++) big.push('第 ' + i + ' 行：' + '内容内容内容内容内容内容内容内容内容内容');
    var t0 = performance.now();
    var st = CM.EditorState.create({
      doc: big.join('\n'),
      extensions: kind === 'N'
        ? [CM.EditorView.lineWrapping, CM.drawSelection(), CM.history()]
        : [CM.EditorView.lineWrapping, CM.history(), CM.EditorView.editable.of(false)]
    });
    var v = new CM.EditorView({ state: st, parent: host });
    var t1 = performance.now();
    var layer = kind === 'S' ? LSel.createLayer(v, CM) : null;
    var un = kind === 'S' ? LSel.installMouse(v, { onSelect: function () { layer.refresh(); }, focus: function () {} }) : null;
    await frames(3);
    var t2 = performance.now();
    // 一次拖拽手势的每步成本（只量 posAtCoords + dispatch）
    var t3 = performance.now();
    for (var k = 0; k < 20; k++) {
      v.dispatch({ selection: { anchor: k, head: k + 50 } });
      await frame();
    }
    var t4 = performance.now();
    var r = {
      行数: 2000,
      建视图ms: Math.round((t1 - t0) * 10) / 10,
      首次布局ms: Math.round((t2 - t1) * 10) / 10,
      每步选区ms: Math.round(((t4 - t3) / 20) * 100) / 100
    };
    if (un) un();
    if (layer) layer.destroy();
    v.destroy();
    return r;
  }

  // ── 子实验：把编辑器约束成「自己是滚动容器」之后，CM6 内建自动滚动是否生效 ────
  //
  // ⭐ A16 里原生臂 `滚动后 = 0`，原因是**布局**：编辑器不约束高度、由页面滚，
  //    而 CM6 的 `MouseSelection` 滚的是 `view.scrollDOM`（`.cm-scroller`），它当时不溢出。
  //    这一条把布局换掉（`.cm-editor { height: 100% }` ＋ 固定高宿主），只回答一个问题：
  //    **内建自动滚动本身是不是好的？** ⛔ 它不参与 A1–A16 的两臂对照（那会把变量变成两个）。
  async function autoScrollExperiment() {
    var host = document.createElement('div');
    host.className = 'armHost armFixed';
    document.body.appendChild(host);
    // ⚠️ 必须落在**视口内**：追加到文末的话 rect.bottom 在窗口外 ⇒ 鼠标坐标量不到
    host.style.position = 'fixed';
    host.style.left = '0px';
    host.style.top = '0px';
    host.style.width = '520px';
    host.style.zIndex = '9999';
    var v = new CM.EditorView({
      state: CM.EditorState.create({
        doc: TEXT,
        extensions: [CM.EditorView.lineWrapping, CM.drawSelection(), CM.history(), CM.EditorView.editable.of(false)]
      }),
      parent: host
    });
    await frames(4);
    var start = xy(v, at('第一段') + 2);
    var sc = v.scrollDOM;
    var before = sc.scrollTop;
    fire(v.contentDOM, 'mousedown', start.x, start.y);
    await frame();
    var box = host.getBoundingClientRect();
    // ⚠️ CM6 只在鼠标**越过滚动容器边缘** 6 px 才滚（`dragScrollMargin`），
    //    而且在**它自己的** `scrollParents.y` 上滚 ⇒ 必须落到容器下沿之外、窗口之内
    var yBand = Math.min(window.innerHeight - 4, Math.round(box.bottom) + 24);
    for (var i = 0; i < 40; i++) {
      fire(document, 'mousemove', start.x + 40, yBand);
      await frame();
    }
    var after = sc.scrollTop;
    fire(document, 'mouseup', start.x + 40, yBand);
    await frames(2);
    var s = selection(v);
    var r = {
      结论: after > before + 1 ? 'CM6 内建自动滚动**生效**（滚动容器是 .cm-scroller）' : '⛔ 没滚动',
      滚动前: Math.round(before), 滚动后: Math.round(after),
      选中字符数: s.to - s.from,
      落点: [s.from, s.to]
    };
    v.destroy();
    host.remove();
    return r;
  }

  // ── 入口 ────────────────────────────────────────────────────────────────
  window.__RUN = async function () {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // ⚠️ 顶部垫片：`reset()` 要把本臂顶到视口下方 `头部留白` px，第一臂上面没有任何东西
    //    ⇒ 不加垫片它的 `scrollTop` 只能到 0，第一行又落回自动滚动带里（见 `头部留白` 注释）。
    var spacer = document.createElement('div');
    spacer.className = 'armSpacer';
    document.body.insertBefore(spacer, document.body.firstChild);

    var hostN = document.getElementById('armN');
    var hostS = document.getElementById('armS');
    var hostH = document.getElementById('armH');
    var hostHM = document.getElementById('armHM');

    var vN = makeView('N', hostN);
    var vS = makeView('S', hostS);
    var vH = makeView('H', hostH);
    var vHM = makeView('HM', hostHM);
    await frames(4);

    var rN = await matrix('N', vN);
    await frames(2);
    var rS = await matrix('S', vS);
    await frames(2);
    var rH = await matrix('H', vH);
    await frames(2);
    // ⭐ 第四条臂：**只换鼠标**（用户第 2 步）。⛔ 不并入上面 26 条矩阵。
    var rHM = await mouseMatrix(vHM);
    await frames(2);
    // ⭐ 复评 P2-3：焦点交还的**适配候选**（F0 负对照 / F1–F4），各自新视图、⛔ 不并入上表。
    var rF = await focusAdaptationExperiment();
    await frames(2);
    // ⭐ 用户三步走的**第 3 步**：文档级集成原型（跨块选择 / 复制 / 撤销 / 保存字节）。
    var rD = await documentLevelExperiment();
    await frames(2);

    // 逐条对照 —— ⭐ **两条对照线**：
    //   ① N ↔ S：绘制 / 鼠标 / 输入都换掉（原来的整臂对照）
    //   ② N ↔ H：**只换绘制**（用户 2026-10-29 指定的第 1 步）——⭐ 这一条才是本轮的新证据
    function compare(ra, rb, ka, kb) {
      var 行 = [];
      var n = Math.max(ra.length, rb.length);
      for (var i = 0; i < n; i++) {
        var a = ra[i], b = rb[i];
        if (!a || !b) continue;
        var 不可比 = !!(a.未测 || b.未测);
        var 同文本 = 不可比 ? null : a.文本 === b.文本;
        var na = (a.高亮 || {}).画面积, sa = 不可比 ? null : (b.高亮 || {}).画面积;
        var nc = (a.高亮 || {}).覆盖率, sc = (b.高亮 || {}).覆盖率;
        var 同高亮 = 不可比 ? null : (nc === null || nc === undefined) && (sc === null || sc === undefined)
          ? true
          : (typeof nc === 'number' && typeof sc === 'number' && Math.abs(nc - sc) <= 0.05 && nc >= 0.95 && sc >= 0.95);
        var o = {
          id: a.id, 动作: a.动作,
          两臂选中文本相同: 同文本,
          两臂高亮覆盖相近: 同高亮,
          [ka + '符合期望']: a.符合期望 === undefined ? null : a.符合期望,
          [kb + '符合期望']: 不可比 ? null : (b.符合期望 === undefined ? null : b.符合期望),
          不可比: 不可比,
          画面积比: (na && sa) ? Math.round((sa / na) * 1000) / 1000 : null,
          [ka]: a, [kb]: b
        };
        // ⚠️ 只有 N↔H 才逐条比高亮矩形（两条都出自 `drawSelection` ⇒ 形状应当一致）；
        //    N↔S 是两套绘制实现，形状差异是**已知口径差**，⛔ 别当成回归。
        行.push(o);
      }
      return 行;
    }

    var 检查 = compare(rN, rS, 'N', 'S');
    var 检查H = compare(rN, rH, 'N', 'H');

    // ── N ↔ HM：**按 id 配对**（⛔ 不按下标——HM 只跑自己那几条，下标对不上） ──
    //    ⭐ 只配 `对应` 字段点名的那几条同动作行（A1 / A5 / A6）。
    var byIdN = {};
    for (var bi = 0; bi < rN.length; bi++) byIdN[rN[bi].id] = rN[bi];
    var 检查HM = [];
    for (var hi = 0; hi < rHM.length; hi++) {
      var rb = rHM[hi];
      if (!rb.对应 || !byIdN[rb.对应]) continue;
      var ra0 = byIdN[rb.对应];
      var na0 = (ra0.高亮 || {}).画面积, sa0 = (rb.高亮 || {}).画面积;
      var ncv = (ra0.高亮 || {}).覆盖率, scv = (rb.高亮 || {}).覆盖率;
      检查HM.push({
        id: rb.对应 + '↔' + rb.id,
        动作: rb.动作,
        两臂选中文本相同: ra0.文本 === rb.文本,
        两臂高亮覆盖相近: (ncv === null || ncv === undefined) && (scv === null || scv === undefined)
          ? true
          : (typeof ncv === 'number' && typeof scv === 'number' && Math.abs(ncv - scv) <= 0.05 && ncv >= 0.95 && scv >= 0.95),
        不可比: false,
        画面积比: (na0 && sa0) ? Math.round((sa0 / na0) * 1000) / 1000 : null,
        N符合期望: ra0.符合期望 === undefined ? null : ra0.符合期望,
        M符合期望: rb.符合期望 === undefined ? null : rb.符合期望,
        N: ra0, M: rb
      });
    }

    function 计数(list, key) {
      return list.filter(function (x) { return x[key]; }).length;
    }
    function 期望统计(list, prefix) {
      return {
        符合: list.filter(function (x) { return x[prefix + '符合期望'] === true; }).length,
        不符: list.filter(function (x) { return x[prefix + '符合期望'] === false; }).length,
        不判: list.filter(function (x) { return x[prefix + '符合期望'] === null || x[prefix + '符合期望'] === undefined; }).length
      };
    }
    /** ⭐ 统一 status 的计数（`结论` 是四个独立通过值的合取，见 `结论of()`）。 */
    function 结论统计(list, prefix) {
      var out = { pass: 0, fail: 0, 未测: 0, 观测: 0, 未知: 0 };
      for (var i = 0; i < list.length; i++) {
        var c = list[i][prefix] || list[i] || {};
        var s;
        if (c.未测) s = '未测';
        else if (typeof c.结论 === 'string') s = c.结论;
        else if (c.符合期望 === true) s = 'pass';
        else if (c.符合期望 === false) s = 'fail';
        else if ((c.期望 || {}).观测 || (c.期望 || {}).策略差异) s = '观测';
        else s = '未知';
        if (out[s] === undefined) out[s] = 0;
        out[s] += 1;
      }
      return out;
    }

    var autoScroll = await autoScrollExperiment();
    var costN = await cost('N', buildCostHost());
    var costS = await cost('S', buildCostHost());

    function buildCostHost() {
      var d = document.createElement('div');
      d.className = 'armHost';
      d.style.height = '120px';
      d.style.overflow = 'hidden';
      document.body.appendChild(d);
      return d;
    }

    return {
      判据: 检查,
      '⭐说明': '判据 = N↔S；混合臂对照 = N↔H；混合臂独有 = H 段（只在本臂产出）；'
        + '交还鼠标对照 = N↔HM（按 id 配对）；交还鼠标独有 = HM 段（M1–M7）；'
        + '焦点适配 = F0/F1/F2/F3/F4 五个候选各自 6 条（⭐ 复评 P2-3；F0 负对照的期望是反的）；'
        + '文档级 = D1–D4 ＋ 单块负对照 D5（⭐ 三步走的第 3 步；D5 期望也是反的）',
      混合臂对照: 检查H,
      混合臂独有: rH.filter(function (x) { return /^[HR]/.test(x.id); }),
      交还鼠标对照: 检查HM,
      交还鼠标独有: rHM,
      焦点适配: rF,
      文档级: rD,
      摘要: {
        条数: 检查.length,
        两臂文本相同: 计数(检查, '两臂选中文本相同'),
        两臂高亮相近: 计数(检查, '两臂高亮覆盖相近'),
        期望_N: 期望统计(检查, 'N'),
        期望_S: 期望统计(检查, 'S'),
        结论_N: 结论统计(检查, 'N'),
        结论_S: 结论统计(检查, 'S'),
        混合臂: {
          条数: 检查H.length,
          N符合: 期望统计(检查H, 'N'),
          H符合: 期望统计(检查H, 'H'),
          结论_N: 结论统计(检查H, 'N'),
          结论_H: 结论统计(检查H, 'H'),
          文本相同: 计数(检查H, '两臂选中文本相同'),
          高亮相近: 计数(检查H, '两臂高亮覆盖相近'),
          独有行数: rH.filter(function (x) { return /^[HR]/.test(x.id); }).length
        },
        交还鼠标: {
          条数: rHM.length,
          配对数: 检查HM.length,
          配对文本相同: 计数(检查HM, '两臂选中文本相同'),
          期望: 期望统计(rHM, ''),
          结论: 结论统计(rHM, ''),
          对照_N: 期望统计(检查HM, 'N'),
          对照_M: 期望统计(检查HM, 'M')
        },
        成本: { N: costN, S: costS },
        焦点适配: {
          条数: rF.length,
          候选: ['F0', 'F1', 'F2', 'F3', 'F4'],
          结论: 结论统计(rF, ''),
          分候选: ['F0', 'F1', 'F2', 'F3', 'F4'].map(function (p) {
            return {
              候选: p,
              结论: 结论统计(rF.filter(function (x) { return x.id.indexOf(p) === 0; }), '')
            };
          })
        },
        自动滚动子实验_原生臂: autoScroll,
        夹具行数: LINES.length,
        夹具字符: TEXT.length,
        未测: [
          '⭐ **S 臂的复制**：产品的复制路径在 `main.js::selectedText`，本夹具没有抽出它' +
            '（抽出会同时改两个变量）⇒ S 臂的「复制」一栏一律记 **未测**，⛔ 不记通过',
          '中文 IME 组合（必须真人敲，⛔ 不合成系统输入）—— 混合臂的合成 `CompositionEvent` 只证结构，不证 WebKit 真实组合行为',
          '真实系统剪贴板写入（只读了事件里的 clipboardData）',
          '表格单元格选择（三条臂都是纯文本，⛔ 不能当作 `0049` 的证据）',
          '阅读态 → 编辑态的首按交接（`bugs/0042` 需要真应用，本夹具没有两态切换）',
          '混合臂的接线是**重写的薄适配层**（`main.js` 抽不出来）⇒ 判据只认 `input.js` 的行为，不认接线本身',
          '⭐ HM 臂交还鼠标之后**再交还键盘**（CM6 的 `keymap`）—— 用户第 2 步只点名鼠标，键盘未换',
          'HM 臂的 `mousedown` 是页内合成事件：⚠️ 但本臂的焦点变化由 CM6 的显式 `.focus()` 触发'
            + '（dist 5013），⛔ 不走浏览器默认行为 ⇒ 焦点那半可判；真实指针的 `pointerdown`/拖拽阈值未验',
          '⭐ 焦点交还的**真机那半**：合成 `CompositionEvent` 造不出「WebKit 因失焦中止组合」这一形态'
            + ' ⇒ F*5 只钉「组合中点击不许把文档搞乱」，**中止行为本身仍未测**（只能真人 IME 验收）',
          '焦点适配 F1/F2/F3/F4 只是**四个最小候选**：⛔ 它们不进产品代码，也不代表"焦点问题已解决"；'
            + '⚠️ 合成 `mousedown` **不跑浏览器的默认聚焦行为**（只有可信事件才跑）⇒ F1/F2 里'
            + '「焦点落在 body」有一部分是夹具形态所致，真机默认聚焦仍会把焦点交给 contenteditable；'
            + '这条只有把候选装进真应用才测得准（真机验收）',
          '真机上的拖选手感（速度、边缘滚动带、双击判定窗口）—— ⛔ 只能人工验收',
          '⭐ 文档级（D1–D5）的**真写盘**：只比了"整篇序列化 == `e4-doc.md` 磁盘字节"，'
            + 'Rust 侧 `fs` 那条路（授权 / 原子写 / 失败回滚）不在夹具内 ⇒ ⛔ 不算验过',
          '⭐ 文档级（D3）的**真键盘 ⌘Z**：两次编辑是 `view.dispatch` 程序化派发的'
            + '（与产品 `input.js` 同一出口），⛔ 不是真按键 ⇒ 键位映射那半未验',
          '⭐ 文档级只用了一份 **5 块 / 230 字节**的小样本：大文档的视口虚拟化、跨块拖选的自动滚动、'
            + '块映射在数千块下的开销**均未测**'
        ]
      }
    };
  };
})();
