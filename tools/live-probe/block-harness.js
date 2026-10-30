// ⭐ `design/0047` §7.2 第 6 条（`make probe-live-block`）的**页面侧判据**。
//
// 它跑的是**真应用**：`src/index.html` ＋ 全部 `src/**`（含 `main.js` 与 `src/live/**`），
// 后端是 `fake-tauri.js`（回 Stage A 用真 comrak 导出的载荷）。
// ⇒ 驱到的是真的 `onLiveDocDown` / `makeLiveView` / `swapLiveView`，⛔ 不是第二份实现。
//
// 判据覆盖（逐条列在这里，⛔ 别只在代码里）：
//   A 启动：真应用起得来、`#doc` 的 DOM 与夹具 HTML 逐字相同、块表与 DOM 数量对得上
//   B 逐块（F5 三段 ＋ Prep/Swap 几何 ＋ 退出逐像素恢复），对**每一个**块各一条
//     ⭐ `-3c` 是装饰层**唯一**的判据：非活动行的 Markdown 标记必须藏掉
//        （2026-10-26 的真缺陷：`createField` 只返回 `StateField`、没接
//        `EditorView.decorations.from(field)` ⇒ 一个标记都没藏，而**任何几何判据都看不见**）
//     ⚠️ `-3a/-3b` 取代了"|ΔH| ≤ 0.5"那一条单判据：视图里**光标行显示源码**、
//        只剩 `>` 的空行在渲染态里是**段间距** ⇒ 这些差是**结构性的**，不是量错。
//        ⭐ `design/0052` U6 起 `-3b` 判的是**锚点**（被点那一行的行顶不位移），
//        上界那条判据已废（`INV-KERNEL-05`：块永远进得去）——结构差只由
//        `live/decorations.js::layoutSlack()` 记账印在说明里，⛔ 不再拦人。
//   C 结构块（`editable=0`）：点了**不进**覆盖层，且**不调** `begin_edit`
//   D F6 四段的**可自动那半**：① 组合期零位移（含活动块高度冻结）② 上屏只改一处
//     ③ 软换行只在折行那一下动 ④ 显式换行只动一行
//     ＋ ⭐ **D12–D16 删除五连**（2026-10-27，`bugs/0014`）：敲字落进文档 / `⌫` 删回原样 /
//       `⌦` 前向 / `⌘A ＋ ⌫` 清空 / `⌘Z` 收回原文。⚠️⚠️ 这一段**此前一条删除判据都没有**，
//       "删不掉"在纯几何判据下与"什么都没发生"长得一模一样 ⇒ 缺陷直达用户。⛔ 别再把它省掉；
//       shell 端 `D-覆盖` 已把它列进覆盖表（少产出即失败）。
//   G 长代码行（§7.1 `0d`）：块内真溢出 / `.cm-line` 与源码行 1:1（⇒ 没装 `lineWrapping`）/
//     页面 `scrollWidth` 不变 / 高度按 F5 口径 / 退出逐像素恢复。
//     ⚠️ 只在**真有超宽 `<pre>`** 的夹具上产判据；其余记 `摘要.G = {适用:false}`，
//        **既不记通过也不记跳过**（记跳过 = 整轮退出码恒为 2）⇒ 由 `block-probe.sh` 的 `G-覆盖` 把关。
//   H 纵向链路（§7.1 `0h`）：进入→敲字→`⌘S`→合回→重渲，跨三层（CM6 视图 → 行模型 → IPC）。
//     ⚠️ 判的是**调用了谁、载荷是什么字节**：`⌘S` 必须经真键位表认出来（假后端 `get_shortcuts`
//        回 `gui::SHORTCUTS` 的导出），否则"按了没反应"与"产品没接线"输出一模一样。
//   E 无改动退出**不重渲**（`render_preview` 一次都不调 ⇒ `INV-EDIT-12` ① 的 live 版）
//   L 主线程键入代价（§7.1 `0f`）：200 / 800 / 2000 行块里各敲 125 个字符，量
//     `input` → CM6 事务 → 装饰层重算 → DOM 补丁 → **一次强制同步布局** 的 p50/p95，
//     并核对 p95 ≤ 16 ms（设计给的进场上限）。
//     ⚠️⚠️ **⛔ 不是端到端输入延迟**：不含系统键事件、合成/光栅化、CM6 延到 rAF 的测量，
//     也不含提交后的整篇重渲（假后端不渲染）——口径写在该段注释与 shell 的 `口径` 里。
//   N 行级排版（`bugs/0015`，**2026-10-27 新增**）：挑**第一个标题块**，进入后量
//     ① 首行是标题尺度（基准）② **回车出来的新行 == 正文字号**（用户报的那件事）
//     ③ 新行不粗 ④ 首行没被拽下去 ⑤ 行首敲 `# ` 之后那一行**变回**标题尺度（"由我来控制"）
//     ⑥ ⌘Z 收回原文 ＋ 退出逐像素恢复。
//     ⚠️ 根因是**块级**文字层（`live/box.js::applyBox` 把 `h2` 的 24.5px/700 搬成 host 行内样式）
//        ⇒ 块里长出来的每一行都继承它；修法是 `Decoration.line` 逐行贴类，尺度跟源码走。
//     ⚠️ 只在**有标题块**的夹具上产判据；其余记 `摘要.N = {适用:false}`，**既不记通过也不记跳过**
//        ⇒ 由 `block-probe.sh` 的 `N-覆盖` 把关。
//   V 任务项就地打勾（`design/0051`）：载荷 ↔ DOM 配对（数量 / `checked` / 非任务项零方框）、
//     点一下只动**那一处**（逐行逐字符比对整篇）、翻转方向对、行数不变、写盘 == 提交、
//     状态条、再点一次逐字节回原样，最后**每个**任务项逐个翻转并翻回。
//     ⚠️ 只在载荷里真有 `task_items` 的夹具上产判据；其余记 `摘要.V = {适用:false}`，
//        **既不记通过也不记跳过** ⇒ 由 `block-probe.sh` 的 `V-覆盖` 把关。
//     ⚠️⚠️ 方框用 `querySelectorAll('input.task-list-item-checkbox')` **独立发现**，
//        ⛔ 不调 `src/live/task.js`——否则产品错、判据跟着错（那是第二份实现）。
//   W `⌘↵` **新起一段**（`design/0052` U7 / `bugs/0024`，⭐ **2026-10-28 按用户更正整段重写**）：
//     `⌘↵` ＝ 跳出这一块 → 在它**后面**插三行空行 → 光标落进新段落 → **仍留在编辑态**
//     （旧的一套"退出到阅读态 ＋ 自绘 `.rmd-caret-hint` ＋ 等按键"是**错误需求**，⛔ 已撤回）。
//     判据：仍在编辑态且焦点在离屏 `textarea`／光标在新段落段首／三行空行**插在这一块之后**
//     （整篇逐行比）／新宿主紧跟原块／**一次 `⌘Z` 同时恢复正文与光标**／中文组合期零字节变动、
//     上屏后逐字落进新段落／敲字之后要 `⌘Z` **两次**（⛔ 一次不跨层）／裸 `Enter` 仍留在这个块里。
//     ⭐ oracle 只取**两样**：`render_preview` 的入参 `text`（提交进会话的正文）与 `#doc` 的孩子次序。
//     ⚠️⚠️ 它**必须排在"任何一次提交"之前**（现为 O 之后、Z1 之前）：假后端不渲染 Markdown，
//        一旦 P/Q/V 提交过，`#doc` 与 `__FIXTURE.text` 就分属两个世界 ⇒ 这里会自造假红。
//     ⚠️ 本段自己把正文逐行改回原样（W6 核对）。只在**可编辑、且后面还有正文**的夹具上产判据；
//        其余记 `摘要.W = {适用:false}`，**既不记通过也不记跳过** ⇒ 由 `block-probe.sh` 的 `W-覆盖` 把关。
//   R 鼠标拖选（`bugs/0031`，**2026-10-28 新增**）：双击真的选中一个词／双击之后**继续拖**
//     选区跟手（锚点不动、头往前）／拖到窗口下边缘**页面真的滚了**、松开即停。
//     ⚠️ 只判**块内**那一半；跨块选择是 `design/0047` 单块视图的结构性后果，走 `design/0053`。
//     ⚠️ 只在**有 ≥ 4 字符可编辑块**的夹具上产判据；其余记 `摘要.R = {适用:false}`，
//        **既不记通过也不记跳过** ⇒ 由 `block-probe.sh` 的 `R-覆盖` 把关（还要求整轮至少一份真滚了）。
//   F 自证：没有未预期的 IPC 命令；前台自证在 swift 那一侧（见 probe.swift）
//
// ⚠️⚠️ **F6 的另外半截（可见首帧闪不闪源码）离屏验不了**（`design/0047` §7.1 0c-②）
//    ⇒ 那条**如实留在人工那一档**，⛔ 本文件不假装验过它。
//
// ⚠️ 容差：**0.5 px**（与 `src/live/index.js::HEIGHT_TOLERANCE` 同一个口径）。
//    ⛔ 不逐位断言历史小数——那些数属于 `notes/0036`/`0037` 的取证，不是合同。
(function () {
  'use strict';

  const TOL = 0.5;
  const HOST_SEL = '.cm-rmd-liveHost';
  const INPUT_SEL = 'textarea.cm-rmd-input';

  const out = {
    判据: [],
    环境: {},
    摘要: {},
    文档: (window.__FIXTURE && window.__FIXTURE.name) || '?',
  };

  function 记(id, ok, msg) {
    out.判据.push({ id: id, ok: ok === 'skip' ? 'skip' : !!ok, msg: String(msg || '') });
  }
  function 跳过(id, msg) { 记(id, 'skip', msg); }

  // ── 基础工具 ──────────────────────────────────────────────────────
  function docEl() { return document.getElementById('doc'); }

  // ⚠️⚠️ **rAF 要有兜底**：离屏（`alphaValue = 0`）窗口在某些状态下会被 WebKit 节流，
  //    这时 `requestAnimationFrame` 的回调**一直不来**。没有兜底的表现是"等满 180 秒、
  //    一行 JSON 都没有"——与"页内真的挂死"**一模一样**（2026-10-26 实测踩到）。
  //    ⇒ 兜底后判据照样能跑：几何量的是**同步布局**，不需要真的画过一帧；
  //      但"帧序稳定性"那几条（D1/D9）就不再承重 ⇒ 兜底次数记进 `环境`，⛔ 不隐瞒。
  let rAF兜底 = 0;
  const 兜底毫秒 = 300;

  function frame() {
    return new Promise(function (r) {
      let done = false;
      const fin = function (v) {
        if (done) return;
        done = true;
        r(v);
      };
      try { window.requestAnimationFrame(function () { fin('raf'); }); } catch (e) { void e; }
      // ⚠️ 计数只在**真的兜底**时才加（`done` 已置位说明 rAF 赢过了）——否则这个数
      //    等于帧数，读起来像"rAF 全被节流"，而那是另一回事。
      setTimeout(function () {
        if (done) return;
        rAF兜底++;
        fin('timeout');
      }, 兜底毫秒);
    });
  }

  async function frames(n) {
    for (let i = 0; i < n; i++) await frame();
  }

  /**
   * ⭐⭐ **帧健康闸门**（2026-10-27 真踩过，`design/0052` U6 收尾那一轮）。
   *
   * 屏幕锁上 / 显示器睡眠时 WebKit **停掉显示链路**：`requestAnimationFrame` 不再回调，
   * 于是 `frame()` 每一帧都走 300 ms 兜底 ⇒ 一整轮几千帧从十几秒变成十几分钟，
   * 运行器的 180 秒兜底**先到**，输出是「⛔ 180 秒没拿到结果」——看上去像**产品挂死**，
   * 实际是**这一轮的数字全部作废**（同一轮 `block-probe.sh` 的 E 自证也打了一行
   * `前台应用从「iTerm2」变成了「loginwindow」`，那行就是同一个事实的另一个面）。
   *
   * ⇒ 判法：连测 8 帧，`requestAnimationFrame` **一次都没赢**就判"页面不可见"，整轮收工。
   * ⚠️ 阈值 8 帧不是随手取的：正常情况 rAF 约 16 ms 一次、8 帧 ~130 ms 肯定至少赢一次；
   *    而"锁屏"是**完全**不回调，不是变慢 ⇒ 8 帧 0 胜是**二分边界**，不是拍的容差。
   * ⚠️ ⛔ 不许把它写成判据（`记`）：它判的不是产品，是**环境**。
   */
  async function 帧健康() {
    let raf = 0;
    for (let i = 0; i < 8; i++) {
      if ((await frame()) === 'raf') raf++;
    }
    return { 胜: raf, 共: 8 };
  }

  /** 等一个条件成立；超时返回 `null`（⛔ 不抛：失败要能记成一条判据而不是整体炸掉）。 */
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

  /**
   * `#doc` 每一个直接孩子的**纵向几何**（相对 `#doc` 自己）。
   * ⚠️ 相对量：离屏窗口不会滚，但「相对 `#doc`」让判据与滚动无关。
   */
  function 几何() {
    const d = docEl();
    const base = d.getBoundingClientRect().top;
    const arr = [];
    for (let i = 0; i < d.children.length; i++) {
      const el = d.children[i];
      const r = el.getBoundingClientRect();
      arr.push({
        top: 四舍(r.top - base),
        h: 四舍(r.height),
        tag: String(el.tagName || '').toLowerCase(),
        host: !!(el.classList && el.classList.contains('cm-rmd-liveHost')),
      });
    }
    return arr;
  }
  function 四舍(x) { return Math.round(x * 1000) / 1000; }

  function 几何相等(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i].top - b[i].top) > 0.01) return false;
      if (Math.abs(a[i].h - b[i].h) > 0.01) return false;
    }
    return true;
  }

  function 下游最大位移(a, b, from) {
    let m = 0;
    for (let i = from; i < Math.min(a.length, b.length); i++) {
      m = Math.max(m, Math.abs(a[i].top - b[i].top));
    }
    return 四舍(m);
  }

  /**
   * 元素里**第一个可见字符**的字形顶（视口坐标）；没有文字则 `null`。
   * ⚠️ 与产品 `main.js::首行盒` **必须同义**（`INV-KERNEL-07`：同一把尺）——
   *    拿"元素顶边 ＋ padding"当基线在代码块上会差 16.38 px，产品对了也判红。
   * ⚠️ 用 `Range` 取一个字符：它给的是字形盒，与 CSS `line-height` 无关。
   */
  function 首字顶(root) {
    if (!root) return null;
    try {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let t = w.nextNode();
      let i = 0;
      while (t) {
        const s = t.nodeValue || '';
        let k = 0;
        while (k < s.length && (s[k] === '\n' || s[k] === '\r')) k += 1;
        if (k < s.length) { i = k; break; }
        t = w.nextNode();
      }
      if (!t) return null;
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + 1);
      const b = r.getBoundingClientRect();
      if (!b || !(b.height > 0)) return null;
      return b.top;
    } catch (e) { void e; }
    return null;
  }

  function 滚动量() {
    const ev = document.scrollingElement || document.documentElement;
    const b = document.body;
    return Math.max(ev ? ev.scrollTop : 0, b ? b.scrollTop : 0);
  }

  /**
   * 这一页还能往下滚多少 px（`0` ⇒ 锚定补不了，⛔ 别拿"补不动"当产品的锅）。
   * ⚠️ **`html` 与 `body` 都要看**：`style.css` 给两者都写了 `height:100%; overflow-y:auto`
   *    ⇒ 真正在滚的常常是 **`body`**（它自己撑满一屏、内容在它里面滚），
   *    `document.scrollingElement` 的 `scrollHeight` 却恒等于一屏（2026-10-27 实测：
   *    只看根元素时，加了两千像素的尾巴仍报"可滚余量 0"）。
   */
  function 滚动上限() {
    const ev = document.scrollingElement || document.documentElement;
    const b = document.body;
    const 根 = ev ? ev.scrollHeight - ev.clientHeight : 0;
    const 体 = b ? b.scrollHeight - b.clientHeight : 0;
    return Math.max(0, 根, 体);
  }

  /**
   * 整个页面**真的**滚到哪儿了（滚动手势的判据要用）。
   *
   * ⚠️ 与 `滚动上限()` 同一个理由：`style.css` 里 `html, body { height:100%; overflow-y:auto }`
   *    ⇒ 真正在滚的是 **`body`**，而标准模式下 `document.scrollingElement` 是 **`<html>`**
   *    （它自己不溢出不滚，`scrollTop` 恒 0）⇒ 只读一处会恒得"没滚"。
   */
  function 滚动位置() {
    const ev = document.scrollingElement || document.documentElement;
    const b = document.body;
    return Math.max(ev ? ev.scrollTop : 0, b ? b.scrollTop : 0);
  }

  function 点(el) {
    const r = el.getBoundingClientRect();
    // ⚠️ 点在**块的第一行**（离顶 8px），⛔ 不是块中心：
    //    ① 活动块多行的度量才可复现——"哪一行是活动行"直接决定装饰层的输出（规则 2）；
    //    ② 判据 `B{i}-3c` 拿 `markers(text,{activeLines:[0]})` 算期望，活动行必须是 0。
    const x = r.left + Math.min(8, Math.max(2, r.width / 2));
    const y = r.top + Math.min(8, r.height / 2);
    const ev = new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      clientX: Math.round(x), clientY: Math.round(y), view: window,
    });
    el.dispatchEvent(ev);
    return ev;
  }

  /**
   * 点在这一块**第一行的行尾**——`bugs/0015` 的 N 段专用。
   *
   * ⚠️⚠️ 为什么不能用 `点()`：它在块的**左上角**（离顶 8 px、离左 8 px），
   *    产品把那个坐标映射成"第 0 行第 0 列"⇒ 回车会插在 `#` **前面**，
   *    原来的标题行被挤到第 1 行，于是 `N4`（首行没被拽下去）会红——**红的不是产品**。
   *    用户报的场景是"光标停在标题行**末尾**，按 Enter 进下一行"。
   *    ⇒ 坐标取**第一行右侧**（`posAtCoords` 会夹到该行末），仍然是真 `mousedown`、
   *      仍然走产品的 `onLiveDocDown → live.begin({point})`，⛔ 探针不直接改视图选区。
   */
  function 点末(el) {
    const r = el.getBoundingClientRect();
    const ev = new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      clientX: Math.round(r.right - 6), clientY: Math.round(r.top + Math.min(8, r.height / 2)),
      view: window,
    });
    el.dispatchEvent(ev);
    return ev;
  }

  /** 这一块的**源码**（`fullText` 的行区间切片，恒 LF）。 */
  function 块源(i) {
    const p = window.__rmd && window.__rmd.payload;
    const w = p && p.blocks ? p.blocks[i] : null;
    if (!w) return '';
    const all = String((window.__FIXTURE || {}).text || '').split('\n');
    return all.slice(w[1] - 1, w[2]).join('\n');
  }

  // ⚠️ 这里原本有一个 `去掉(src, ranges)`：把 `markers()` 给的区间摘掉，当 B-3c 的期望值。
  //    2026-10-27（`design/0052` U3）连同调用点一起删了 —— 那是**拿产品给产品打分**
  //    （`INV-KERNEL-07` / `docs/bugs/0025`）：装饰层藏错、`markers()` 自己算错，两边一起错、
  //    判据恒绿。⛔ 别再把它加回来，期望值只许来自 `期望可见行()`。

  /**
   * ⭐ 用**产品同一个解析器**给一段源码造树（`design/0052` U3 起 `markers()` 的唯一判据来源）。
   * ⚠️ `markdownLanguage` 是 A 栏导出（`tools/cm6/entry.mjs`）——用它而**不是**另装一份
   *    `@lezer/markdown`，否则方言与产品就不是同一个了。
   */
  function 造树(文) {
    try {
      const CM6 = window.rmdCM6;
      const L = CM6 && CM6.markdownLanguage;
      if (!L || !L.parser || typeof L.parser.parse !== 'function') return null;
      return L.parser.parse(String(文));
    } catch (e) { void e; return null; }
  }

  /**
   * ⭐⭐ **与产品实现无关的 oracle**：这一段源码在**非活动行**上应该显示成什么样。
   *
   * ⚠️⚠️ 为什么必须自己写一遍（`INV-KERNEL-07`，`docs/bugs/0025`）：
   *    B-3c 从前拿 `markers()` 算期望 —— 那是**拿产品给产品打分**，
   *    装饰层把标记藏错、或者 `markers()` 自己算错，两边一起错，判据**恒绿**。
   *    这一段只认源码文本，⛔ 一次都不调 `markers()`。
   *
   * ⚠️ 它**不是**第二份实现，只覆盖**夹具里真有的**那几种构造（标题 / 引用 / 强调 / 删除线 /
   *    行内代码 / 链接图片）；围栏行与围栏内部、以及 `原样行` 里点名的行**原样返回**。
   *    遇到不认识的构造它只会"少藏"，判据随即变红——那是**该红的**，⛔ 别在这里补宽容。
   *
   * @param {string} 源
   * @param {{原样行?:number[]}} [opts] `原样行`：光标所在的行（规则 2，显示源码）
   * @returns {string[]} 逐行的期望可见文本
   */
  function 期望可见行(源, opts) {
    const 原样 = {};
    ((opts && opts.原样行) || []).forEach(function (n) { 原样[n] = true; });
    const lines = String(源 === undefined || 源 === null ? '' : 源).split('\n');
    const out = [];
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      const isFence = t.slice(0, 3) === '```' || t.slice(0, 3) === '~~~';
      if (isFence) {
        // ⭐ `design/0052` U5：围栏行在**非活动**时整行塌掉 ⇒ 可见文本是**空串**
        //    （⛔ 不是"留下 ```"——那是 U3/U4 的旧口径）。活动行照规矩显示源码。
        out.push(原样[i] ? line : '');
        fence = fence === null ? t.slice(0, 1) : (t.slice(0, 1) === fence ? null : fence);
        continue;
      }
      if (fence !== null) { out.push(line); continue; }   // 围栏内部：一个字都不动
      if (原样[i]) { out.push(line); continue; }          // 活动行：显示源码
      let s = line;
      // 引用前缀：每一层 `>` ＋ 可选一个空格
      s = s.replace(/^(?:>[ \t]?)+/, '');
      // 标题：`#{1,6}` ＋ 可选一个空格（空的 `##` 也是标题，`bugs/0016`）
      s = s.replace(/^#{1,6}(?:[ \t]|$)/, '');
      out.push(藏行内标记(s));
    }
    return out;
  }

  /** `期望可见行` 的行内那半：代码段 → 链接图片 → 删除线 → 强调（强在弱前）。 */
  function 藏行内标记(s) {
    let out = String(s);
    // 行内代码：反引号串成对，内容原样（⛔ 里面的 `**` 不当强调）
    out = out.replace(/(\x60+)([\s\S]*?)\1/g, '$2');
    // 图片 / 链接：留下文字
    out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    // 删除线
    out = out.replace(/~~([^~]+)~~/g, '$1');
    // 强调：先强后弱（`__` / `_` 要两侧不是字母数字，CommonMark 的 intraword 规则）
    out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
    out = out.replace(/(^|[^0-9A-Za-z_])__([^_]+)__(?![0-9A-Za-z_])/g, '$1$2');
    out = out.replace(/\*([^*]+)\*/g, '$1');
    out = out.replace(/(^|[^0-9A-Za-z_])_([^_]+)_(?![0-9A-Za-z_])/g, '$1$2');
    return out;
  }

  // ⚠️ 这里曾有一个 `有标记的行数()` —— 它给 B-3b 的上界多加了一项产品没有的允许量
  //    （`docs/bugs/0025`：探针比产品宽 ⇒ 探针全绿推不出用户点得进去）。2026-10-27 已删：
  //    允许量**只许**来自 `live/decorations.js::layoutSlack()`，⛔ 别再在这里加第二项。
  //    `tests/js/live-wiring.test.js` 有一条源码级闸门盯着它。

  function 主机() { return docEl().querySelector(HOST_SEL); }
  function 输入框() { return document.querySelector(INPUT_SEL); }

  // ⚠️ 这里原有三个只服务于「阅读态续写光标」的帮手（`续写光标()` / `末字盒()` / `滚动元素()`）。
  //    2026-10-28 用户更正了 `⌘↵` 的语义（`bugs/0024` §4）：它是"跳出这一块、在块后新起一段、
  //    光标落进新段落、**仍留在编辑态**"，⛔ 不是"退出到阅读态画一根假光标再等按键"。
  //    ⇒ 那三个帮手连同它们喂的 9 条判据**整体撤回**（W 段已按新语义重写）。
  //    ⚠️ `滚动上限()` 留着：X 段（锚定故障注入）在用。


  /** 视图里选区的头（UTF-16 偏移，相对**这一块**）；读不到 ⇒ `-1`。 */
  function 选区头(host) {
    try {
      const CM6 = window.rmdCM6;
      const V = CM6 && CM6.EditorView && CM6.EditorView.findFromDOM
        ? CM6.EditorView.findFromDOM(host)
        : null;
      if (V && V.state && V.state.selection) return V.state.selection.main.head;
    } catch (e) { void e; }
    return -1;
  }

  /**
   * 活动块**渲染出来的文本**（把 `.cm-line` 逐个接起来）。
   * ⚠️ 它是 `textContent`，藏起来的 Markdown 标记不在里面 ⇒ ⛔ 不能拿它跟源串比字面；
   *    但**它的用途是"变没变"**：一旦有事务插进了文档，这里必然变。
   * ⚠️ 为什么需要它：只量几何**判不出**"组合期文档被改了但恰好没换行"
   *    ——那正是 `M2` 那种失效的形态（下一行 `D1b` 就是为此存在的）。
   */
  function 块内文本(host) {
    const lines = host.querySelectorAll('.cm-line');
    const out = [];
    for (let i = 0; i < lines.length; i++) out.push(lines[i].textContent || '');
    return out.join('\n');
  }

  /**
   * 块内的**整篇**源码（⛔ 不是 `块内文本`）。
   *
   * ⚠️⚠️ 为什么必须有这一个（2026-10-26 实测）：CM6 只渲染**窗口内**的行 ⇒ `块内文本` 拿到的是
   *    "当前视口那 ~130 行"，与块多大**无关**：bigblock 的 202 / 802 / 2000 行三块量出来
   *    都是 **5145** 字。拿它判"撤销回位"，判的是"视口里那几行对不对"，而撤销会让视口
   *    跟着重算 ⇒ **同样一份内容也能比出不等**（三块全红，而产品其实已经撤回原样）。
   *    ⇒ 判据要读 `view.state.doc`（与视口无关）。读不到才退回 `块内文本`（并如实记在说明里）。
   */
  function 块全文(host) {
    try {
      const CM6 = window.rmdCM6;
      const V = CM6 && CM6.EditorView && CM6.EditorView.findFromDOM
        ? CM6.EditorView.findFromDOM(host)
        : null;
      if (V && V.state && V.state.doc) return V.state.doc.toString();
    } catch (e) { void e; }
    return 块内文本(host);
  }

  /**
   * 宿主视图里**此刻有几行**（`1` = 一行都没换过）。
   * ⚠️ 读 `块全文()` 切行，⛔ 不读视口 DOM：CM6 只渲染窗口内的行，而"这一格里有几个 `\n`"
   *    是**文档**属性，与滚到哪儿无关（与 `块全文` 同一个理由）。
   */
  function 视图行数(host) {
    return String(块全文(host)).split('\n').length;
  }

  /**
   * 宿主里那个 CM6 视图（读**视图自己的选区**用）。
   * ⚠️ 判"光标动没动"必须读它，⛔ 不许读 `main.js` 内部那个 `sel`——那正是一处
   *    可能陈旧的镜像（`live-wiring.test.js` 有源码级闸门盯着它必须由 `updateListener` 同步）。
   * 读不到就返回 `null`，调用方如实记红，⛔ 不拿"读不到"当通过。
   */
  function 视图(host) {
    try {
      const CM6 = window.rmdCM6;
      if (!CM6 || !CM6.EditorView || typeof CM6.EditorView.findFromDOM !== 'function') return null;
      return CM6.EditorView.findFromDOM(host) || null;
    } catch (e) { return null; }
  }

  /**
   * 「同一串字放在**这一格**里，阅读态会占多高（内容高，不含格子内边距）」——
   * 一条**与编辑视图无关**的 oracle。
   *
   * ⚠️ 为什么必须有它：假后端**不渲染 Markdown**（`fake-tauri.js` 只重算载荷，
   *    ⛔ 不回 HTML）⇒ 提交之后 `#doc` 里那张表还是**夹具原文**，
   *    "阅读态格高"读出来是**旧内容**的高。2026-10-28 真踩过：`Q21` 报
   *    「格高 阅读 36 → 编辑 99 px」——那个 36 px 来自夹具里那句短话，与长文无关，
   *    判红判绿都是假信号。
   * ⚠️ 做法：往同一张表**临时**追加一行，格里放一个装着这串字的 `div`，量完**立刻摘掉**。
   *    用的是同一张表、同一份产品样式、同一组列宽（`table-layout: fixed` 下新行沿用列宽）
   *    ⇒ 这就是真渲染会算出来的折行结果，⛔ 没有第二份假设。
   * ⚠️⚠️ **量内容高、⛔ 不量 `<td>` 的高**：`<td>` 的高是**整行**的高（同一行别的格子更高就更高），
   *    拿它和编辑视图比会把"邻居格子高"当成"这一格不对"。对照方是
   *    `host.getBoundingClientRect().height`——宿主就是内容高（`.cm-rmd-cell` 是 `height:auto`）。
   * ⛔ 不许改成"另建一个 div 抄一份 font/padding"：那要抄数字，抄错了就是第二份实现。
   * ⚠️ 临时行**同步**追加、**同步**摘掉（中间没有 `await`）⇒ 一声布局抖动，且⛔ 不进任何一帧。
   */
  function 阅读态量(td, 文本) {
    if (!td) return { 高: 0, 宽: 0, 格宽: 0 };
    const 行 = td.parentElement;
    const 块 = 行 && 行.parentElement;
    if (!块) return { 高: 0, 宽: 0, 格宽: 0 };
    // ⚠️⚠️ **先把这一格真实的「内容宽」量下来，再往表里塞东西**。
    //    临时行一挂上去就参与**列宽分配**（`table-layout: auto`）：一串长文会把这一列
    //    **撑宽到能一行排下**，于是量到的永远是"1 行"——那条 oracle 恒等于**低估**，
    //    而"低估"的表现与"编辑态真的偏高"**输出一模一样**。
    //    2026-10-28 实测：这一格真宽 **125 px**（编辑态排 4 行 = 84 px），
    //    oracle 却报 **430 px → 21 px**，`Q14b`/`Q21` 一起红，`M23`/`M25`/`M26` 因此失去承重。
    const cs = getComputedStyle(td);
    const 框 = td.getBoundingClientRect().width
      - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
      - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0);
    const 盒 = document.createElement('div');
    // ⭐ `bugs/0035`（2026-10-28）：格内换行的**存储**形态是 `<br>`（`cell.js::encode`），
    //    渲染出来就是一个硬换行 ⇒ oracle 必须按**同一个渲染结果**排：`\n` → `<br>`。
    //    ⚠️ 别直接 `textContent = 文本`——HTML 会把 `\n` 折成一个空格，
    //    于是"两行"被算成"一行"，这条 oracle 会**系统性低估**（与它的前几个坑同族）。
    const 行文 = String(文本).split('\n');
    for (let i = 0; i < 行文.length; i++) {
      if (i > 0) 盒.appendChild(document.createElement('br'));
      盒.appendChild(document.createTextNode(行文[i]));
    }
    const 用宽 = (isFinite(框) && 框 > 1) ? 框 : 0;
    if (用宽) {
      // ⚠️ 写死宽 ⇒ 盒的折行与**列宽撑不撑开**无关；`border-box` 保证写进去的就是内容宽。
      盒.style.boxSizing = 'border-box';
      盒.style.width = 用宽 + 'px';
    }
    // ⚠️⚠️ **整行照抄**（同列数、同 `colspan`、同 class/内联宽度）：只塞一个格子的临时行
    //    会让那一格落到**第 1 列**，并在 `table-layout: auto` 下**重新分配列宽**
    //    ⇒ 量到的是"另一个格子的宽"，与这一格无关。2026-10-28 实测就是这么红的：
    //    这一格只有 ~一百多 px（长文排 4 行 = 84 px），oracle 那条临时行拿到的是**整表宽**
    //    ⇒ 32 个汉字算成 1 行 = 21 px，`Q14b`/`Q21` 一起红，连带 `M23`/`M25`/`M26` 失去承重。
    const 临时行 = 行.cloneNode(false);
    let 仿格 = null;
    for (let i = 0; i < 行.children.length; i++) {
      const c = 行.children[i];
      const 仿 = c.cloneNode(false);
      if (c === td) { 仿.appendChild(盒); 仿格 = 仿; }
      临时行.appendChild(仿);
    }
    if (!仿格) return { 高: 0, 宽: 0, 格宽: 0 };
    块.appendChild(临时行);
    try {
      const r = 盒.getBoundingClientRect();
      return { 高: r.height, 宽: r.width, 格宽: 仿格.getBoundingClientRect().width };
    } finally {
      块.removeChild(临时行);
    }
  }

  /**
   * 只要高度那一半（其余调用点保持原签名）。
   * @returns {number}
   */
  function 阅读态内容高(td, 文本) {
    return 阅读态量(td, 文本).高;
  }

  function 键(el, key, mods) {
    const o = { key: key, bubbles: true, cancelable: true };
    if (mods && mods.meta) o.metaKey = true;
    if (mods && mods.shift) o.shiftKey = true;
    if (mods && mods.alt) o.altKey = true;
    el.dispatchEvent(new KeyboardEvent('keydown', o));
  }

  function 打字(el, 字) {
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, data: 字, inputType: 'insertText',
    }));
  }

  function 组合(el, type, data) {
    el.dispatchEvent(new CompositionEvent(type, {
      bubbles: true, cancelable: true, data: data || '',
    }));
  }

  function 计数(cmd) {
    const c = (window.__FAKE && window.__FAKE.counts) || {};
    return c[cmd] || 0;
  }

  /** 最近一次某命令的调用（`{cmd, args}`）；没调过 ⇒ `null`。 */
  function 最近一次(cmd) {
    const all = window.__IPC || [];
    for (let i = all.length - 1; i >= 0; i--) if (all[i].cmd === cmd) return all[i];
    return null;
  }

  /** 状态条文本——产品进不去 / 进去之后发现问题时**它自己会说明原因**（`status.live-*` 那一族）。 */
  function 状态条() {
    const el = document.getElementById('status');
    return String((el && el.textContent) || '').slice(0, 160);
  }

  /**
   * ⭐ 等版面**真的稳下来**再量基线（2026-10-27 实测踩到）。
   *
   * ⚠️⚠️ 起因：`blocks.md` 里那个**会折行的列表项**判据在两次跑之间一红一绿——
   *    有一次基线的 `h5` 量到 **142.781**，而从 B0 起一直是 **118.984**（差一行 23.797 px）。
   *    那是**启动期还在排版**（字体/CSS/侧边栏宽度落地），⛔ 不是产品把列表改矮了：
   *    板面一稳，值从头到尾没再动过。
   * ⚠️ 用"几何连续 3 帧完全相同"当稳定判据，⛔ 不是固定 `sleep(N)`：离屏 rAF 会被节流，
   *    固定等待在慢机器上照样不够、在快机器上白等。
   * @returns {Promise<boolean>} `false` = 到上限也没稳（调用方照常继续，⛔ 不据此判红）
   */
  async function 等版面稳定(最多帧) {
    const 上限 = 最多帧 || 120;
    let 上次 = null;
    let 相同 = 0;
    for (let i = 0; i < 上限; i++) {
      await frame();
      const 现 = JSON.stringify(几何());
      if (现 === 上次) {
        相同++;
        if (相同 >= 3) return true;
      } else {
        相同 = 0;
        上次 = 现;
      }
    }
    return false;
  }

  // ── 启动 ───────────────────────────────────────────────────────────
  async function 等启动() {
    const p = await waitFor(function () { return window.__rmd && window.__rmd.payload; }, 15000);
    if (!p) return null;
    console.error('· 载荷就绪（块 ' + (p.blocks || []).length + '），等两帧…');
    // 再等两帧：`noteLive` 是同步在 `mountDocument` 里跑的，但给首帧一点余量。
    await frames(2);
    // ⚠️ 字体没就绪时量出来的行高是**回退字体**的（换行点也不同）⇒ 先等它。
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    } catch (e) { void e; }
    const 稳 = await 等版面稳定();
    console.error('· 版面' + (稳 ? '已稳定' : '⚠️ 到上限仍没稳（基线可能不准）'));
    return window.__rmd.payload;
  }

  // ── 单块一轮：进入 → 量 → 退出 → 量 ────────────────────────────────
  async function 跑一块(i, block, base, 摘要) {
    const d = docEl();
    const node = d.children[i];
    // ⚠️ 进度日志走 `console.error`（`probe.swift` 把它转进 stderr）：
    //    ⛔ 少了它，"卡在哪一块"与"卡在哪一步"只能靠 180 秒超时去猜。
    console.error('· 块 ' + i + ' ' + String(node && node.tagName));
    // ⚠️⚠️ ⭐ `design/0052` U6：**先把这一块滚进视口，再量、再点**。
    //    理由不是"好看"：`-3b` 判的是"用户点的那一行没跑"，而用户**只可能点看得见的那一行**。
    //    屏幕外的块 CM6 压根没渲染（它只测量视口窗口内的行），`coordsAtPos` 给的是估算——
    //    拿估算去判"锚得准不准"，量的是外部依赖的误差，⛔ 不是量产品。
    //    ⚠️ 用 `block:'start'`（⛔ 不是 `center`）：高过一屏的块（bigblock 的 2000 行）
    //    居中之后**第一行**跑到视口外面去了，而 `点()` 永远点第一行。
    try { node.scrollIntoView({ block: 'start', inline: 'nearest' }); } catch (e) { void e; }
    await frames(1);
    const 前滚 = 滚动量();
    const 前begin = 计数('begin_edit');
    const 前end = 计数('end_edit');

    // ⚠️ `design/0052` U6 的锚点基线：**被点那一行的行顶**（视口坐标）。
    //    `点()` 永远点在块的第一行 ⇒ 行顶 ＝ 块的**内容顶边**（＝ border top ＋ padding-top）。
    //    ⚠️ 必须在这一行取：`点()` 之后产品随时可能 swap，`node` 会被换掉。
    const 锚点0 = (function () {
      // ⚠️ 基线取**第一个可见字符的字形顶**（与产品 `main.js::首行盒` 同一把尺）：
      //    ⛔ 不能拿"块顶边 ＋ 它自己的 padding"——代码块的内边距住在内层 `code` 上，
      //    那样算出来的基线比文字真实位置高 16.38 px，于是**产品做对了也判红**
      //    （2026-10-27 实测：四块代码块全红在这里，而差异一分不差地等于那个 padding）。
      const g = 首字顶(node);
      if (g !== null) return 四舍(g);
      const r = node.getBoundingClientRect();
      const pad = parseFloat(window.getComputedStyle(node).paddingTop) || 0;
      return 四舍(r.top + pad);
    })();
    // ⚠️ **prep 期零位移**：dispatch 之后**同步**量一次（`begin` 的第一段是 `await beginEdit`，
    //    所以在这一行之前视图一定还没 swap）。
    const ev = 点(node);
    const 同步几何 = 几何();
    const prep位移 = 下游最大位移(base, 同步几何, 0);

    记('B' + i + '-0 点击被接管',
      !!ev.defaultPrevented,
      ev.defaultPrevented ? '' : '没能 preventDefault（说明 onLiveDocDown 没走到"进入"那一支）');
    记('B' + i + '-1 prep 期零位移',
      prep位移 <= 0.01,
      '最大位移 ' + prep位移 + ' px');

    const host = await waitFor(主机, 4000);
    if (!host) {
      记('B' + i + '-2 进入覆盖层', false,
        '等不到 ' + HOST_SEL + '（begin 被拒或失败）；状态条：' + 状态条());
      摘要['块' + i] = { 进入: false, 状态条: 状态条() };
      // ⚠️ **不 break**：一块进不去不等于后面都进不去，⛔ 别让第一个失败把 13 块藏掉。
      await frames(2);
      return 'rejected';
    }
    // ⚠️ 产品的锚定**要复查 2–3 帧**才落定（`main.js::anchorAt`：CM6 的测量可能晚一帧）
    //    ⇒ 这里一次等够，⛔ 别看第一帧的中间态（那是"补了一半"的样子）。
    await frames(3);

    const now = 几何();
    const got = now[i] || { top: NaN, h: NaN };
    const dh = 四舍(Math.abs(got.h - base[i].h));
    const dtop = 四舍(Math.abs(got.top - base[i].top));
    const 下游 = 下游最大位移(base, now, i + 1);
    const 滚动差 = 四舍(Math.abs(滚动量() - 前滚));

    记('B' + i + '-2 进入覆盖层', true, '');
    // ── F5：进入前后的**可见几何**（⚠️ 这是用户在屏幕上看得到的那个数）─────────
    //
    // ⚠️⚠️ 三条，各判一件事（口径 2026-10-26 / 2026-10-27 两次实测定下来的）：
    //    ① **不许变矮**——变矮意味着字号/行高/内边距搬丢了（`h1` −7 px 那一类，一分不让）；
    //       ⚠️ U6 起它**只告警**（`INV-KERNEL-05`），但探针仍然判红：那是排版缺陷，不是"进不去"；
    //    ② **锚点不位移**——`design/0052` U6 取代了"变高有上界"这条旧判据；
    //    ③ **装饰层真的在干活**（非活动行的标记必须藏掉，逐字比对独立 oracle）。
    // ⚠️ 变高**不再有上界**：过一屏的块实测恒定 **+20.141 px**（CM6 只测量视口内的行，视口外
    //    的塌行在高度表里仍按整行计），那是外部依赖的行为，⛔ 不是产品能收紧的量。
    const 源 = 块源(i);
    const LM = window.rmd && window.rmd.liveMarks;
    // ⭐⭐ `design/0052` U3：期望值改由**与产品无关的 oracle** 给（`期望可见行`）。
    //    ⚠️ 从前这里是 `去掉(源, markers(源,{activeLines:[0]}).ranges)` —— 拿产品给产品打分：
    //    藏错、算错两边一起错，判据**恒绿**（`INV-KERNEL-07` / `docs/bugs/0025`）。
    // ⚠️ 期望仍按**活动行 = 0** 算（`点()` 点的是块的第一行）：源码那一行按规则 2
    //    **原样显示**，⛔ 不能拿"全藏"当期望——那会把"按设计显示源码"判成"装饰层没生效"
    //    （2026-10-26 第一次跑就红在这一点上）。
    const wantLines = 期望可见行(源, { 原样行: [0] });
    // ⚠️ 结构差**只记账、不拦人**（`design/0052` U6 / `INV-KERNEL-05`）：产品不再有上界，
    //    这里也只是把"本该高出多少"印进判据说明，⛔ 别把它变回一条判据。
    const 结构差 = LM && typeof LM.layoutSlack === 'function'
      ? LM.layoutSlack(源)
      : { fences: 0, blanks: 0, softWraps: 0 };
    const 记账行数 = 结构差.fences + 结构差.blanks + (结构差.softWraps || 0) + 1;
    const 变矮 = base[i].h - got.h;

    // ⚠️ `design/0052` U6 起这条**不再拦人**（`INV-KERNEL-05`），但"变矮"本身仍是排版缺陷
    //    （字号 / 行高 / 内边距搬丢了）。⇒ 判据改成：**变矮就必须有告警**
    //    （状态条那句"比原来矮"，产品唯一的用户可见通道；⛔ 不许静默丢排版）。
    //    ⚠️ 已知的结构性变矮：松散列表（`bugs/0021`）少的是每一项的段间距，`U4` 那半没做
    //    ⇒ 它靠告警如实告知；⛔ 也不许把这条放宽成"永远通过"来藏掉它。
    const 变矮告警 = 状态条().indexOf('比原来矮') >= 0;
    记('B' + i + '-3a F5 变矮必须告警（⛔ 不许静默丢排版）', 变矮 <= TOL || 变矮告警,
      '矮了 ' + 四舍(Math.max(0, 变矮)) + ' px（原 ' + base[i].h + ' / 视 ' + got.h + '）'
        + '；状态条：' + (状态条() || '（空）'));
    // ⭐⭐ `design/0052` U6：上界判据**换成锚点**（用户拍板「体验为先」）——
    //    块永远进得去，用户真正在意的是"我点的那一行别跑"。判据是**块顶不动**：
    //    `点()` 永远点在**第一行**（离块顶 8 px），⇒ 块的顶边与那一行的行顶是同一个锚。
    //    ⚠️ 产品的锚定（`main.js::anchorAt`）补的是 `scrollTop`，它**只改滚动量**，
    //    ⛔ 不改块内布局 ⇒ 收尾的 `E` 段（退出逐像素恢复）仍然承重。
    //    ⚠️ 不再有"变高上界"：高过一屏的块实测**恒定 +20.141 px**（CM6 只测量视口内的行，
    //    视口外的围栏塌行在高度表里仍按整行计）——U5 之后 `slack` 是 0，那道闸门会
    //    **永远拒收** bigblock 的三块，而这正是 U6 要废掉的东西。
    const 锚点1 = (function () {
      const ln = host.querySelector('.cm-line');
      if (!ln) return NaN;
      const g = 首字顶(ln);
      return 四舍(g !== null ? g : ln.getBoundingClientRect().top);
    })();
    记('B' + i + '-3b F5 锚点不位移（被点那一行的行顶 ±' + 四舍(TOL) + ' px）',
      Math.abs(锚点1 - 锚点0) <= TOL,
      '行顶 ' + 锚点0 + ' → ' + 锚点1 + ' px（Δ ' + 四舍(锚点1 - 锚点0) + '）'
        + '；块顶 Δ ' + dtop + ' px；ΔH ' + 四舍(got.h - base[i].h) + ' px（结构差记账 '
        + 记账行数 + ' 行：围栏 ' + 结构差.fences + ' ＋ 空行 ' + 结构差.blanks
        + ' ＋ 合并段 ' + (结构差.softWraps || 0) + ' ＋ 活动行 1，⛔ 不再拦人）'
        + '；滚动差 ' + 滚动差 + ' px');
    记('B' + i + '-3c 非活动行的标记真的藏掉了（逐字对齐独立 oracle）', (function () {
      // ⚠️⚠️ CM6 **只渲染窗口内的行** ⇒ 高过一屏的块，`块内文本(host)` 只有**头部那几十行**
      //    （bigblock 的 202 / 802 / 2000 行三块都只有 ~130 行）。拿它跟**整块**源码逐字比，
      //    判的是"字符数一样"，而字符数天生不一样 ⇒ 三块全红，产品其实是好的。
      //    ⇒ ① 整块都渲染出来时仍比**整串**（那才是"一个字符都不差"）；
      //      ② 只渲染了一部分时**逐行比头部那些行**（⛔ 不拿 `slice` 截期望——隐藏区间可能
      //         正好压在切点上，截出来的前缀与渲染前缀会差几个字）。
      //    ⚠️ 由此 -3c 对**代码块**天然是弱判据（代码块里没有被藏的标记）；
      //       它真正承重的是段落/标题/列表/引用那几块，⛔ 别把这条当成"装饰层整体没有防线"。
      const gotLines = 块内文本(host).split('\n');
      if (!gotLines.length || !gotLines[0]) return false;
      if (gotLines.length >= wantLines.length) return 块内文本(host) === wantLines.join('\n');
      for (let k = 0; k < gotLines.length; k++) if (gotLines[k] !== wantLines[k]) return false;
      return true;
    })(),
    (function () {
      const gotLines = 块内文本(host).split('\n');
      const 渲染 = gotLines.length + ' / 全块 ' + wantLines.length + ' 行';
      for (let k = 0; k < Math.min(gotLines.length, wantLines.length); k++) {
        if (gotLines[k] !== wantLines[k]) {
          return 渲染 + '，第 ' + (k + 1) + ' 行不同：期望「' + wantLines[k].slice(0, 40)
            + '」/ 实际「' + gotLines[k].slice(0, 40) + '」';
        }
      }
      return 渲染;
    })());
    记('B' + i + '-4 块自身 top 不动', dtop <= TOL, 'Δtop ' + dtop + ' px');
    // ⚠️ **块外零位移的判据要扣掉"这一块自己长高了多少"**：块变高 Δ ⇒ 下游整体下移 Δ，
    //    那是**同一件事**，⛔ 不是"另有一处版面变了"。所以上界是 `max(0, ΔH) + 0.5`
    //    （M1 那种"盒子没搬"的形态：块高不变、下游却跳 15.4px ⇒ 照样红）。
    //    ⚠️ **变矮**同理（下游整体上移 |Δ|）⇒ 用绝对值，⛔ 不是 `max(0, ΔH)`。
    记('B' + i + '-5 块外零位移（按块自身高度变化解释后）',
      下游 <= Math.abs(got.h - base[i].h) + TOL,
      '下游最大位移 ' + 下游 + ' px / 块自身变化 ' + 四舍(got.h - base[i].h) + ' px');
    // ⚠️ `design/0052` U6 起**产品会主动补滚动**（`main.js::anchorAt`，`INV-KERNEL-05` 的落点）
    //    ⇒ "scrollTop 不动"不再成立；而且补偿量与块自身增高**不再是同一个数**（CM6 测量态
    //    与渲染态的行高不是一套数，实测差几 px）。这里只守产品自己的硬上限：
    //    **一次不许多于一屏**（`anchorAt` 里 `|delta| > innerHeight ⇒ 放弃`，"宁可不补，也不乱补"）。
    记('B' + i + '-6 锚点补偿不超过一屏',
      滚动差 <= Math.max(1, window.innerHeight || 0),
      'ΔscrollTop ' + 滚动差 + ' px / 一屏 ' + (window.innerHeight || 0) + ' px');

    摘要['块' + i] = { ΔH: dh, Δtop: dtop, 下游: 下游, 结构差行: 记账行数, 锚点: [锚点0, 锚点1] };

    // 退出：`Esc` = 提交并退出（⚠️ 走的是**真键位分发**，⛔ 不直接调控制器）
    const ta = 输入框();
    if (!ta) {
      记('B' + i + '-7 退出', false, '找不到离屏 textarea');
      return 'fail';
    }
    键(ta, 'Escape');
    const gone = await waitFor(function () { return !主机(); }, 4000);
    if (!gone) {
      记('B' + i + '-7 退出', false, 'Esc 之后 ' + HOST_SEL + ' 还在');
      return 'fail';
    }
    await frames(2);
    const after = 几何();
    记('B' + i + '-7 退出后逐像素恢复', 几何相等(base, after),
      几何相等(base, after) ? '' : '差异 ' + JSON.stringify(差异(base, after)));
    记('B' + i + '-8 授权归还',
      计数('begin_edit') - 前begin === 1 && 计数('end_edit') - 前end >= 1,
      'begin_edit +' + (计数('begin_edit') - 前begin)
        + ' / end_edit +' + (计数('end_edit') - 前end));
    return 'ok';
  }

  function 差异(a, b) {
    const out = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || {};
      const y = b[i] || {};
      if (Math.abs((x.top || 0) - (y.top || 0)) > 0.01 || Math.abs((x.h || 0) - (y.h || 0)) > 0.01) {
        out.push({ i: i, 前: [x.top, x.h], 后: [y.top, y.h] });
      }
    }
    return out.slice(0, 4);
  }

  // ── F6 四段（可自动那半）────────────────────────────────────────────
  async function 跑F6(i, base, 摘要) {
    const d = docEl();
    const node = d.children[i];
    点(node);
    const host = await waitFor(主机, 4000);
    if (!host) {
      记('D0 F6 进入覆盖层', false, '等不到 ' + HOST_SEL);
      return false;
    }
    await frames(1);
    const ta = 输入框();
    if (!ta) { 记('D0 F6 进入覆盖层', false, '找不到离屏 textarea'); return false; }
    记('D0 F6 进入覆盖层', true, '');

    // —— ⭐ 删除（2026-10-27：用户报「实时编辑，无法执行删除操作」）———
    //  ⚠️⚠️ 这一段**此前一条判据都没有**：462 条里既没有 `Backspace` 也没有 `Delete`
    //     （`键()` 只按过 `Enter` / `Escape` / `⌘Z`），而"删不掉"与"删了没落进文档"
    //     在纯几何判据下**长得一模一样**（块没变高也没变矮）。
    //  ⚠️ 判据判的是**块全文**（`view.state.doc`），⛔ 不是 `块内文本`——后者只有视口那 ~130 行。
    const 全文0 = 块全文(host);
    const 长度0 = 全文0.length;

    // ① 先证明敲得进去：否则"删不掉"分不清是**删除坏了**还是**输入坏了**
    打字(ta, 'a');
    await frames(1);
    const 插后 = 块全文(host);
    记('D12 敲一个字符能落进文档', 插后.length === 长度0 + 1,
      '长度 ' + 长度0 + ' → ' + 插后.length);

    // ② Backspace（真键位，走 `onKeyDown` 那条路）
    键(ta, 'Backspace');
    await frames(1);
    const 退后 = 块全文(host);
    记('D13 Backspace 删回原样', 退后 === 全文0,
      '长度 ' + 插后.length + ' → ' + 退后.length
      + (退后 === 全文0 ? '' : '；文本「' + 退后.slice(0, 24) + '」'));

    // ③ Delete（前向）：先插一个字再左移，保证插入符右边一定有字
    打字(ta, 'b');
    await frames(1);
    键(ta, 'ArrowLeft');
    await frames(1);
    键(ta, 'Delete');
    await frames(1);
    记('D14 Delete（前向）删回原样', 块全文(host) === 全文0,
      '长度 ' + 块全文(host).length);

    // ④ 选区删除：⌘A 之后 Backspace（这是另一条分支：`deleteRange` 的选区优先）
    打字(ta, 'c');
    await frames(1);
    键(ta, 'a', { meta: true });
    await frames(1);
    键(ta, 'Backspace');
    await frames(1);
    记('D15 选区删除（⌘A ＋ Backspace）清空', 块全文(host) === '',
      '长度 ' + 块全文(host).length);

    // ⑤ 收回基线：⛔ 不让这一段污染后面那几段的对照文本
    let 收回 = 0;
    while (块全文(host) !== 全文0 && 收回 < 80) {
      键(ta, 'z', { meta: true });
      收回++;
      await frames(1);
    }
    记('D16 删除段能被 ⌘Z 收回原文', 块全文(host) === 全文0,
      '按了 ' + 收回 + ' 次；长度 ' + 块全文(host).length
      + (块全文(host) === 全文0 ? '' : '（与基线不同 ⇒ 后面几段没有共同基线，直接停）'));
    if (块全文(host) !== 全文0) return false;

    const 起 = 几何();
    const h0 = 起[i].h;

    // —— ① 组合期：文档一个字节都不动，活动块高度冻结，下游不推 ——
    let 组合最差 = 0;
    let 组合高度最差 = 0;
    const 文本0 = 块内文本(host);
    let 文本变了 = '';
    组合(ta, 'compositionstart', '');
    const 串 = ['n', 'ni', 'nih', 'niha', 'nihao'];
    for (let k = 0; k < 串.length; k++) {
      组合(ta, 'compositionupdate', 串[k]);
      await frames(1);
      const g = 几何();
      组合最差 = Math.max(组合最差, 下游最大位移(起, g, i + 1));
      组合高度最差 = Math.max(组合高度最差, Math.abs(g[i].h - h0));
      if (!文本变了 && 块内文本(host) !== 文本0) 文本变了 = '第 ' + (k + 1) + ' 个中间态';
    }
    记('D1 组合期下游零位移', 组合最差 <= 0.01, '最大 ' + 四舍(组合最差) + ' px');
    // ⚠️ **承重的那条是 D1b**：只量几何判不出"改了文档但恰好没换行"（F6 强需求的原话是
    //    「只有输入在动」——组合期的中间态连文档都不许动）。
    记('D1b 组合期块内文本不变', 文本变了 === '',
      文本变了 ? ('已经从「' + 文本0.slice(0, 12) + '…」变成「' + 块内文本(host).slice(0, 12) + '…」（' + 文本变了 + '）') : '');
    记('D2 组合期活动块高度冻结', 组合高度最差 <= 0.01, '最大 ΔH ' + 四舍(组合高度最差) + ' px');
    const pre = host.querySelector('.cm-rmd-preedit');
    记('D3 组合串画在覆盖层上（⛔ 不进文档）',
      !!pre && (pre.textContent || '').indexOf('nihao') >= 0,
      pre ? ('覆盖层文本「' + (pre.textContent || '').slice(0, 20) + '」') : '没有 .cm-rmd-preedit');

    // —— ② 上屏：只改一处，下游在行宽容得下时零位移 ——
    const before2 = 几何();
    组合(ta, 'compositionend', '你好');
    await frames(2);
    const after2 = 几何();
    const 上屏位移 = 下游最大位移(before2, after2, i + 1);
    记('D4 上屏（compositionend）下游零位移', 上屏位移 <= TOL, '最大 ' + 上屏位移 + ' px');
    // ⚠️ 配对判据：D4 单独看会被"上屏压根没发生"混过去（位移也是 0）⇒ 必须证明它真落进了文档。
    记('D4b 上屏确实落进文档', 块内文本(host).indexOf('你好') >= 0,
      块内文本(host).slice(0, 24));
    记('D5 上屏后覆盖层已清空',
      (function () {
        const p2 = host.querySelector('.cm-rmd-preedit');
        return !p2 || (p2.textContent || '') === '';
      })(), '');
    摘要.上屏位移 = 上屏位移;

    // —— ③ 软换行：折行之前每一步都零位移；折行那一步**恰好一次**，量级 ≈ 一行 ——
    const 行高 = (function () {
      const line = host.querySelector('.cm-line');
      return line ? line.getBoundingClientRect().height : 0;
    })();
    // ⚠️ 用**全角字**（`中`，约 14px/字）而不是 `x`（约 8px/字）：短段落里 60 个 `x` 折不动
    //    （`blankmd` 的 F6 段落只有 ~154px，60 × 8 还差一点 ⇒ 2026-10-26 实测"折行 0 次"），
    //    而每多敲一个字就多一步撤销——两头的代价都落在这一处。
    let 折行次数 = 0;
    let 折行前最大位移 = 0;
    let 折行步位移 = 0;
    let prev = 几何();
    for (let k = 0; k < 200; k++) {
      打字(ta, '中');
      await frames(1);
      const g = 几何();
      const moved = 下游最大位移(prev, g, i + 1);
      const grew = g[i].h - prev[i].h > 0.5;
      if (grew) { 折行次数++; 折行步位移 = Math.max(折行步位移, moved); }
      else 折行前最大位移 = Math.max(折行前最大位移, moved);
      prev = g;
      if (grew) break;
    }
    摘要.折行尝试 = 折行前最大位移;
    记('D6 软换行：折行前零位移', 折行前最大位移 <= TOL, '最大 ' + 四舍(折行前最大位移) + ' px');
    记('D7 软换行：折行只发生一次且位移 ≈ 一行',
      折行次数 === 1 && 折行步位移 > TOL && (行高 <= 0 || 折行步位移 <= 行高 * 1.6 + TOL),
      '折行 ' + 折行次数 + ' 次 / 位移 ' + 四舍(折行步位移) + ' px / 行高 ' + 四舍(行高) + ' px');

    // —— ④ 显式换行：只动一行，且之后不再动 ——
    const before4 = 几何();
    const 换行前文本 = 块内文本(host);
    键(ta, 'Enter');
    await frames(2);
    const after4 = 几何();
    const 换行位移 = 下游最大位移(before4, after4, i + 1);
    await frames(3);
    const after4b = 几何();
    // ⚠️ 判据是"**多一行就只动一行**"，⛔ 不是"位移必须 > 0"：在一段已经被软换行占据
    //    两行的段落里按 Enter，源码多一行而视觉总行数不变 ⇒ 位移**本来就是 0**。
    //    真正证明"Enter 落进文档"的是下面那条配对判据 `D8b`。
    记('D8 显式换行只动一行（≤ 一行高）',
      行高 <= 0 || 换行位移 <= 行高 * 1.6 + TOL,
      '位移 ' + 换行位移 + ' px / 行高 ' + 四舍(行高) + ' px');
    // ⚠️ 配对判据：上面那条只量几何 —— "Enter 被吞掉、而位移恰好由别的原因产生" 会混过去。
    //    文档必须真的**多了一行**（`Enter` 在块内换行 = 源码多一个 `\n`）。
    记('D8b 换行确实落进文档（多一行）',
      块内文本(host).split('\n').length === 换行前文本.split('\n').length + 1,
      '行数 ' + 换行前文本.split('\n').length + ' → ' + 块内文本(host).split('\n').length);
   记('D9 换行之后不再抖', 几何相等(after4, after4b),
      '后续帧 ' + JSON.stringify(差异(after4, after4b)));

    // —— 撤销回原文（⚠️ 用 ⌘Z 走真键位）——
    // ⚠️⚠️ 判据是**文本**，⛔ 不是几何：视图里光标那一行本来就显示源码，
    //     所以"高度回到基线"既可能早到（还没撤完）、也可能永远不到（活动行仍多折一行）
    //     —— 拿它当判据会把"撤销没撤干净"判成绿、把正常形态判成红。
    let 次数 = 0;
    let 回到基线 = false;
    // ⚠️ 上限要**大于前面敲进去的字符数**（每个字符是一步撤销）：60 的上限配上 60 个字符
    //    会让"撤不完"与"上限太小"长得一模一样。
    for (let k = 0; k < 400; k++) {
      if (块内文本(host) === 文本0) { 回到基线 = true; break; }
      键(ta, 'z', { meta: true });
      次数++;
      await frames(1);
    }
    const 几何回位 = Math.abs(几何()[i].h - base[i].h) <= TOL
      && Math.abs(几何()[i].top - base[i].top) <= TOL;
    记('D10 ⌘Z 能撤回原文（块内文本逐字回到起点）', 回到基线,
      回到基线
        ? ('按了 ' + 次数 + ' 次；几何同步回位=' + 几何回位)
        : ('按满 400 次仍未回到起点文本：「' + 块内文本(host).slice(0, 40) + '」'));

    // 退出（此时应无改动 ⇒ 不提交、不重渲）
    键(ta, 'Escape');
    const gone = await waitFor(function () { return !主机(); }, 4000);
    记('D11 F6 退出干净', !!gone && 几何相等(base, 几何()), gone ? '' : 'host 还在');
    摘要.F6 = { 组合最差: 四舍(组合最差), 上屏位移: 上屏位移, 折行步位移: 折行步位移, 撤销次数: 次数 };
    return true;
  }

  // ── G 段：`design/0047` §7.1 步骤 **0d**（长代码行）──────────────────────
  //
  // 判据出自 §4.4：视图**不装** `EditorView.lineWrapping`，长行由**这一块**自己横滚
  // （`live.css` 给 `.cm-rmd-code` 的 `overflow-x: auto`）⇒ **整篇不横移**。
  //
  // ⚠️ 四条判据各自能杀掉的形态，⛔ 少一条就有一种静默退化没人管：
  //   · `G2` 每条源码行 == **一个**视觉行 ⇒ 杀掉"哪天顺手装了 lineWrapping"
  //     （装了之后 `.cm-line` **条数不变**、但长行变成多倍高 ⇒ 只有量行高才看得见）；
  //   · `G3` host 内**真的**有横向溢出 ⇒ 否则下一条"页面不横移"是空的（没溢出当然不横移）；
  //   · `G4` 页面 `scrollWidth` 与进入前**逐像素相同** ⇒ 杀掉"横滚跑到整篇上"；
  //   · `G5` 高度仍按 F5 口径（**不矮**；变高只记账，`INV-KERNEL-05` 之后没有上界）。
  // ⚠️ 只在夹具里**真有**超宽 `<pre>` 时才产判据；否则 `摘要.G = {适用:false}` 且
  //    **既不记通过也不记跳过** —— "本轮到底验没验 0d"由 `block-probe.sh` 的 `G-覆盖` 把关。
  async function 跑长代码行(base, 摘要) {
    const d = docEl();
    const ev0 = document.scrollingElement || document.documentElement;
    const 页宽0 = ev0 ? ev0.scrollWidth : 0;
    const 页视0 = ev0 ? ev0.clientWidth : 0;
    let idx = -1;
    for (let i = 0; i < d.children.length; i++) {
      const el = d.children[i];
      if (String(el.tagName || '').toLowerCase() !== 'pre') continue;
      // ⚠️ 判据是**渲染态就溢出**：`pre` 自己 `overflow-x:auto` ⇒ `scrollWidth` 才是内容宽。
      if (el.scrollWidth > el.clientWidth + 1) { idx = i; break; }
    }
    if (idx < 0) {
      // ⚠️ **不记判据**：这份夹具里根本没有超宽代码行，0d 对它不适用。
      //    ⛔ 既不记"通过"（那是把没跑读成绿），也不记"跳过"（那会让整轮退出码恒为 2）。
      //    ⇒ 由 `block-probe.sh` 的 **G-覆盖** 统一要求"本轮至少有一份夹具真的跑了 G"。
      摘要.G = { 适用: false, 原因: '这份夹具里没有横向溢出的 <pre>' };
      return;
    }
    const node = d.children[idx];
    const 源行数 = 块源(idx).split('\n').length;
    const ev = 点(node);
    记('G0 长代码行：进入覆盖层', !!ev.defaultPrevented, ev.defaultPrevented ? '' : '点击没被接管');
    const host = await waitFor(主机, 4000);
    if (!host) {
      记('G1 长代码行：视图真的挂上来了', false, '等不到 ' + HOST_SEL + '；状态条：' + 状态条());
      摘要.G = { 块: idx, 进入: false, 状态条: 状态条() };
      return;
    }
    await frames(1);

    const lines = host.querySelectorAll('.cm-line');
    let 最矮 = Infinity;
    let 最高 = 0;
    for (let i = 0; i < lines.length; i++) {
      // ⭐ `design/0052` U5：围栏行**故意**塌成 0 高（`cm-rmd-fence`）⇒ 它不参与"行高齐不齐"，
      //    否则这一条会以"行高 0–20.141"的形式红，而红的是 U5 的正常形态（真踩过）。
      if (lines[i].classList.contains('cm-rmd-fence')) continue;
      const h = lines[i].getBoundingClientRect().height;
      if (h < 最矮) 最矮 = h;
      if (h > 最高) 最高 = h;
    }
    if (最矮 === Infinity) 最矮 = 0;
    const 首行 = (function () {
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].classList.contains('cm-rmd-fence')) return lines[i];
      }
      return null;
    })();
    const 行高 = 首行 ? 首行.getBoundingClientRect().height : 0;
    const 视0 = host.getBoundingClientRect();
    const 内滚动 = host.scrollWidth - host.clientWidth;
    const 页宽1 = (document.scrollingElement || document.documentElement).scrollWidth;
    const now = 几何()[idx] || { h: NaN, top: NaN };
    const LM = window.rmd && window.rmd.liveMarks;
    // ⚠️ 与 B-3b **同一个算式**（`docs/bugs/0025`）：`fences + blanks + softWraps + 1`，
    //    行高取**计算值**。⛔ 别在这里写第三个版本。
    //    ⚠️ `design/0052` U6 起它**只记账、不拦人**（`INV-KERNEL-05`：块永远进得去）。
    const slack = LM && typeof LM.layoutSlack === 'function'
      ? LM.layoutSlack(块源(idx))
      : { fences: 0, blanks: 0, softWraps: 0 };
    const 记账行数 = slack.fences + slack.blanks + (slack.softWraps || 0) + 1;

    记('G1 长代码行：视图真的挂上来了', true,
      '块 ' + idx + '（' + 源行数 + ' 行源码）');
    记('G2 长代码行：一条源码行就一个视觉行（没装 lineWrapping）',
      lines.length === 源行数 && 最高 - 最矮 <= TOL && 最高 <= 行高 * 1.5,
      '`.cm-line` ' + lines.length + ' / 源码行 ' + 源行数
        + '；行高 ' + 四舍(最矮) + '–' + 四舍(最高) + '（基准 ' + 四舍(行高) + '）');
    记('G3 长代码行：块内**真的**横向溢出（否则下面两条是空的）', 内滚动 > 1,
      'scrollWidth − clientWidth = ' + 四舍(内滚动) + ' px');
    记('G4 长代码行：横滚在块内，整篇不横移',
      页宽1 <= 页视0 + 1 && Math.abs(页宽1 - 页宽0) <= 1,
      '页面 scrollWidth ' + 页宽0 + ' → ' + 页宽1 + '（视口 ' + 页视0 + '）');
    // ⚠️ `design/0052` U6 起**没有上界**（`INV-KERNEL-05`）：只判"不矮"，变高的量记账。
    记('G5 长代码行：高度按 F5 口径（不矮；变高只记账）',
      base[idx].h - now.h <= TOL,
      '原 ' + base[idx].h + ' / 视 ' + now.h + ' px（ΔH ' + 四舍(now.h - base[idx].h)
        + ' px；结构差记账 ' + 记账行数 + ' 行，⛔ 不再拦人）');
    摘要.G = { 适用: true, 块: idx, 源码行: 源行数, 行高: 四舍(行高), 最矮: 四舍(最矮), 最高: 四舍(最高),
      内滚动: 四舍(内滚动), 页宽: [页宽0, 页宽1], 高: [base[idx].h, now.h] };

    const ta = 输入框();
    if (!ta) {
      记('G6 长代码行：退出', false, '找不到离屏 textarea');
      return;
    }
    键(ta, 'Escape');
    const gone = await waitFor(function () { return !主机(); }, 4000);
    记('G6 长代码行：退出后逐像素恢复', !!gone && 几何相等(base, 几何()),
      gone ? '几何没回原样：' + JSON.stringify(差异(base, 几何())) : 'host 还在');
  }

  // ── N 段：行级排版（`bugs/0015`）────────────────────────────────────────
  //
  // ⚠️ 用户原话：「从标题行，按 Enter 键进入下一行后，下面一行一直是标题状态，无法进入正文状态。
  //    正常应该是，默认进入正文状态，我输入 `#` 之后，才会是标题状态，由我来控制的。」
  //
  // 根因（本轮取证）：`live/box.js::applyBox` 搬的是**块级**文字层（字号/行高/字重），
  // 它量的是**被换掉的那一个元素**——`h2` 量出来就是 24.5px/700 ⇒ 块里长出来的每一行
  // **都**继承它。于是"回车之后一直是标题"。
  //
  // 判据为什么必须在**真 DOM** 里量：字号是 `getComputedStyle` 的事，
  // `markers()` 只回答"该给哪些行贴类"，⛔ 回答不了"贴上去以后算出来是几号字"。
  //
  // ⚠️ 九条判据（`N1`/`N2` 是**同一块的前后两行**，缺一条就分不清"回落了"与"标题也掉了"）：
  //   · `N0` / `N0b` 点得进、视图真的挂上来（否则后面全在量空气）；
  //   · `N0c` 光标停在**标题行末尾**（用户报的那个起点；⛔ 点左上角会让回车插在 `#` 前面）；
  //   · `N1` 进入标题块：第一行是标题尺度（否则后面的对照没有基准）；
  //   · `N2` 回车之后第二行 == 正文字号（**这条就是用户报的那个缺陷**）；
  //   · `N3` 第二行不是粗体（字号对了、字重没回落，屏幕上仍然是"标题的样子"）；
  //   · `N4` 第一行**没变**（回落⛔ 不许把标题一起拽下去）；
  //   · `N5` 在正文行首敲出 `# ` 之后，那一行**变回**标题尺度（用户要的"由我来控制"）；
  //   · `N6a`/`N6b` 撤销回原文 + 退出后逐像素恢复（⛔ 不许靠"改了不还原"混过上面几条）。
  //
  // ⭐ 2026-10-29 追加两条（用户实测「在标题下面一行输入的时候，拼音落地的字体虽然是正文，
  //    正常，但是拼音的字很大」）：`N1b` 标题行上的拼音 == **标题尺度**（负对照）、
  //    `N3b` 正文行上的拼音 == **那一行**的尺度。覆盖层 `.cm-rmd-preedit` 挂在 host 上、
  //    继承的是 `live/box.js` 搬来的**块级**文字层 ⇒ 标题块里第二行（`cm-rmd-body`）
  //    上屏是正文、组合期却是标题字号。⚠️ 这两条只有真 DOM 量得到：`D3` 只判"覆盖层有文本"。
  function 正文字号() {
    const p = document.querySelector('#doc p');
    if (p) return parseFloat(getComputedStyle(p).fontSize) || 0;
    // 兜底：夹具里一段正文都没有（`blankmd` 那种）⇒ 读 token（仍是样式表那一份）。
    const v = getComputedStyle(document.documentElement).getPropertyValue('--reader-font-size');
    return parseFloat(v) || 0;
  }

  async function 跑行级排版(base, 摘要) {
    const d = docEl();
    let idx = -1;
    for (let i = 0; i < d.children.length; i++) {
      if (window.rmd.liveBox.headingLevelOf(d.children[i]) > 0) { idx = i; break; }
    }
    if (idx < 0) {
      // ⚠️ 同 G/L：**既不记通过也不记跳过**（记跳过会让整轮退出码恒为 2），
      //    由 `block-probe.sh` 的 **N-覆盖** 统一要求"本轮至少有一份夹具真的跑了 N"。
      摘要.N = { 适用: false, 原因: '这份夹具里没有标题块' };
      return;
    }
    const 正文 = 正文字号();
    const node = d.children[idx];
    // ⚠️ 必须点**行尾**：用户报的是"光标停在标题行末，按 Enter 进下一行"。
    //    点在左上角会让回车插在 `#` 前面 ⇒ 首行被挤走，`N4` 红的是**探针的起点**，不是产品。
    const ev = 点末(node);
    记('N0 行级排版：进入标题块', !!ev.defaultPrevented, ev.defaultPrevented ? '' : '点击没被接管');
    const host = await waitFor(主机, 4000);
    if (!host) {
      记('N0b 行级排版：视图真的挂上来了', false, '等不到 ' + HOST_SEL + '；状态条：' + 状态条());
      摘要.N = { 适用: true, 块: idx, 进入: false, 状态条: 状态条() };
      return;
    }
    await frames(1);
    const ta = 输入框();
    if (!ta) {
      记('N0b 行级排版：视图真的挂上来了', false, '找不到离屏 textarea');
      摘要.N = { 适用: true, 块: idx, 进入: false };
      return;
    }
    const 行字号 = function (el) { return el ? parseFloat(getComputedStyle(el).fontSize) || 0 : 0; };
    const 行字重 = function (el) { return el ? parseFloat(getComputedStyle(el).fontWeight) || 0 : 0; };
    /**
     * 组合一个串，**量下覆盖层的排版权重**，再用空 `compositionend` 取消（⛔ 不落进文档）。
     *
     * ⭐ 为什么必须量真 DOM：拼音画在 `.cm-rmd-preedit` 上，它的字号**没有任何行为判据**
     * 碰得到——`D3` 只判"覆盖层有文本"，字号错了照样绿。
     * ⚠️ 用户 2026-10-29 实测：标题块的第二行是**正文**尺度，而覆盖层挂在 host 上
     * （host 搬的是**块级**文字层 = 标题尺度）⇒ 拼音 28px、上屏 14px。
     */
    function 量拼音(串) {
      组合(ta, 'compositionstart', '');
      for (let k = 0; k < 串.length; k++) 组合(ta, 'compositionupdate', 串.slice(0, k + 1));
      const pre = host.querySelector('.cm-rmd-preedit');
      const out = {
        有: !!pre,
        字号: pre ? parseFloat(getComputedStyle(pre).fontSize) || 0 : 0,
        字重: pre ? parseFloat(getComputedStyle(pre).fontWeight) || 0 : 0,
      };
      组合(ta, 'compositionend', '');
      return out;
    }
    let lines = host.querySelectorAll('.cm-line');
    if (!lines.length) {
      记('N0b 行级排版：视图真的挂上来了', false, '一条 `.cm-line` 都没有');
      摘要.N = { 适用: true, 块: idx, 进入: false };
      return;
    }
    记('N0b 行级排版：视图真的挂上来了', true, '块 ' + idx + '（' + (node.tagName || '?') + '）');

    const 标题字号 = 行字号(lines[0]);
    // ⚠️ 基线取**这一块**的全文（⛔ 不是整篇 `__FIXTURE.text`）：撤销要逐字回到进入时的那一份。
    const 全文0 = 块全文(host);
    // ⭐ 前提自证：光标必须落在**第 0 行末尾**——否则下面"回车"的位置就不是用户那个位置，
    //    红/绿都不说明产品（⛔ 别把"起点没建立"读成"判据不敏感"）。
    let 光标 = -1;
    let 行末 = -1;
    try {
      const CM6 = window.rmdCM6;
      const V = CM6.EditorView.findFromDOM(host);
      if (V && V.state) {
        光标 = V.state.selection.main.head;
        行末 = V.state.doc.line(1).to;
      }
    } catch (e) { void e; }
    记('N0c 光标停在标题行末尾（用户报的那个起点）', 光标 >= 0 && 光标 === 行末,
      'anchor ' + 光标 + ' / 第 0 行末 ' + 行末);
    记('N1 进入标题块：第一行是标题尺度（对照的基准）',
      正文 > 0 && 标题字号 > 正文 + 0.5,
      '标题行 ' + 四舍(标题字号) + ' px / 正文 ' + 四舍(正文) + ' px');

    // ⭐ **负对照**：在标题行上组合，拼音就必须是标题尺度。
    //    ⚠️ 它⛔ 不是正题（标题行上 host 与行同尺度，改之前也是绿的）；它钉的是
    //    "⛔ 别为了修 N3b 就把覆盖层钉成固定的正文字号"——那样标题行的拼音会缩成正文。
    const 标题拼音 = 量拼音('nihao');
    记('N1b ⭐ 组合串的排版跟**标题行**走（负对照）',
      标题拼音.有 && Math.abs(标题拼音.字号 - 标题字号) <= 0.5
        && Math.abs(标题拼音.字重 - 行字重(lines[0])) <= 50,
      标题拼音.有
        ? ('拼音 ' + 四舍(标题拼音.字号) + ' px/' + 四舍(标题拼音.字重)
          + ' · 标题行 ' + 四舍(标题字号) + ' px/' + 四舍(行字重(lines[0])))
        : '没有 .cm-rmd-preedit');

    // —— 用户的操作：在标题行末尾按 Enter ——
    键(ta, 'Enter');
    await frames(2);
    lines = host.querySelectorAll('.cm-line');
    const 新行 = lines[lines.length - 1];
    const 新字号 = 行字号(新行);
    记('N2 ⭐⭐ 回车出来的新行 == 正文字号（bugs/0015 的正题）',
      正文 > 0 && Math.abs(新字号 - 正文) <= 0.5,
      '新行 ' + 四舍(新字号) + ' px / 正文 ' + 四舍(正文) + ' px'
        + (Math.abs(新字号 - 正文) <= 0.5 ? '' : '（还是标题尺度 ⇒ 用户看到"进不了正文"）'));
    记('N3 新行不是粗体（字号回落了字重也要回落）',
      行字重(新行) <= 500,
      'font-weight ' + 四舍(行字重(新行)));
    记('N4 第一行仍是标题尺度（⛔ 回落不许把标题一起拽下去）',
      Math.abs(行字号(lines[0]) - 标题字号) <= 0.5,
      '标题行 ' + 四舍(标题字号) + ' → ' + 四舍(行字号(lines[0])) + ' px');

    // ⭐⭐ **正题**（用户 2026-10-29 实测）：「在标题下面一行输入的时候，拼音落地的字体
    //    虽然是正文，正常，但是拼音的字很大。」⇒ 覆盖层挂在 host 上、继承的是**块级**
    //    文字层（标题尺度），而上屏那一行是 `cm-rmd-body`（正文尺度）。
    const 正文拼音 = 量拼音('nihao');
    记('N3b ⭐⭐ 组合串的排版跟**正文行**走（拼音不许比落地的字大）',
      正文拼音.有 && 正文 > 0 && Math.abs(正文拼音.字号 - 新字号) <= 0.5
        && Math.abs(正文拼音.字重 - 行字重(新行)) <= 50,
      正文拼音.有
        ? ('拼音 ' + 四舍(正文拼音.字号) + ' px/' + 四舍(正文拼音.字重)
          + ' · 正文行 ' + 四舍(新字号) + ' px/' + 四舍(行字重(新行)))
          + (Math.abs(正文拼音.字号 - 新字号) <= 0.5 ? '' : '（拼音按标题尺度画 ⇒ 用户看到"拼音的字很大"）')
        : '没有 .cm-rmd-preedit');

    // —— 用户要的反向：正文行首敲出 `# `，那一行就**变成**标题 ——
    打字(ta, '#');
    打字(ta, ' ');
    打字(ta, '小标题');
    await frames(2);
    lines = host.querySelectorAll('.cm-line');
    const 敲出行 = lines[lines.length - 1];
    const 敲出字号 = 行字号(敲出行);
    // ⚠️ 期望值必须取**同一份样式表**算出来的 `h1` 尺度：
    //    ① 原文档里有 `<h1>`（大多数夹具）⇒ 直接量它；
    //    ② 夹具里没有 `h1`（例如 `longcode`，那一块是唯一的标题）⇒ 用**同一个 token**
    //       `--reader-scale-h1` × 正文字号。⚠️ 早先退化成 `正文 × 1.2` 是**错的倍数**
    //       （`design/0046` 的 h1 字阶是 **2.00**）⇒ `N5` 在 `longcode` 上假红过一次。
    const h1 = document.querySelector('#doc h1');
    let 期望 = h1 ? parseFloat(getComputedStyle(h1).fontSize) || 0 : 0;
    if (!(期望 > 0)) {
      const sc = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--reader-scale-h1'));
      if (sc > 0) 期望 = 正文 * sc;
    }
    if (!(期望 > 0)) 期望 = 正文 * 2;
    记('N5 ⭐ 行首敲出 `# ` 之后那一行变成标题尺度（“由我来控制”）',
      敲出字号 > 正文 + 0.5 && Math.abs(敲出字号 - 期望) <= 0.5 && 行字重(敲出行) > 500,
      '字号 ' + 四舍(敲出字号) + ' px（期望 ' + 四舍(期望) + '）；font-weight ' + 四舍(行字重(敲出行)));

    // —— 收回基线：撤销 ＋ 退出（⛔ 不许靠"改了不还原"混过上面几条）——
    let 收回 = 0;
    while (块全文(host) !== 全文0 && 收回 < 200) {
      键(ta, 'z', { meta: true });
      收回++;
      await frames(1);
    }
    记('N6a ⌘Z 能收回原文', 块全文(host) === 全文0,
      '按了 ' + 收回 + ' 次；长度 ' + 块全文(host).length + ' / 基线 ' + 全文0.length);
    键(ta, 'Escape');
    const gone = await waitFor(function () { return !主机(); }, 4000);
    记('N6b 行级排版：退出后逐像素恢复', !!gone && 几何相等(base, 几何()),
      gone ? '几何没回原样：' + JSON.stringify(差异(base, 几何())) : 'host 还在');
    摘要.N = {
      适用: true, 块: idx, 标签: String(node.tagName || ''),
      正文: 四舍(正文), 标题行: 四舍(标题字号), 新行: 四舍(新字号),
      敲出行: 四舍(敲出字号), 撤销次数: 收回,
      拼音标题行: 四舍(标题拼音.字号), 拼音正文行: 四舍(正文拼音.字号),
    };
  }

  // ── O 段：**操作 × 不变量**（e2e 探测器，2026-10-27）────────────────────
  //
  // 为什么有这一段（用户原话：「已经出了两个简单的、一下就看出来的 bug，有没有举一反三。
  // 或者想办法自己做 e2e 测试，来发现新的 bug」）：
  //   `bugs/0014`（删除键静默空转）与 `bugs/0015`（回车之后一直是标题）的**共同形态**是
  //   「用户做一个**显而易见的动作**，屏幕上是错的、或者什么都没发生」，而探针此前是
  //   **按设计者想到的条目逐条验** ⇒ 没被想到的那一类动作**一条判据都没有**。
  // ⇒ 这一段换一种写法：**枚举用户真能做的动作**（回车 / 敲 `# ` / 再删回去 / 全选删除 /
  //   撤销 / 退出再进），每个动作之后用**与产品实现无关的 oracle** 重算"屏幕上该是什么"。
  //
  // ⭐ oracle **不是第二份实现**，是**浏览器对产品样式表自己算出来的值**：
  //   建一个隐藏的 `.doc` 影子容器，每种元素各放一个，`getComputedStyle` 取尺度。
  //   ⇒ 期望值永远跟着 `--reader-*` 走，⛔ 没有任何写死的数字（`INV-LIVE-07` 仍成立）。
  // ⭐ "这一行是几级标题"由**独立正则 ＋ 围栏/引用前缀状态机**判，
  //   ⛔ 不调产品的 `markers()`——否则产品算错了 oracle 跟着错，判据恒绿。
  //
  // ⚠️ 边界（如实登记）：只挑**源码 ≤ 60 行**的块。CM6 只渲染视口内那几十行，
  //    `块全文()` 与 DOM 行数对不上时这一段会**如实记红并说明**，⛔ 不假装通过。
  // ⚠️ 它**不验**观感（颜色深浅、间距好不好看）——那仍归人工。

  let ORACLE = null;

  /** 隐藏的 `.doc` 影子容器：渲染态尺度的**唯一**来源。 */
  function oracle() {
    if (ORACLE) return ORACLE;
    const box = document.createElement('div');
    box.className = 'doc';
    box.setAttribute('aria-hidden', 'true');
    // ⚠️ `visibility:hidden` 保住布局与计算样式，且**一个像素都不画**；
    //    `left:-99999px` 只是别让它挤进可视区（这里不量几何，所以不像 Prep 位那样有害）。
    box.style.cssText = 'position:absolute;left:-99999px;top:0;width:800px;'
      + 'visibility:hidden;pointer-events:none;';
    box.innerHTML = '<h1>x</h1><h2>x</h2><h3>x</h3><h4>x</h4><h5>x</h5><h6>x</h6>'
      + '<p>x</p><ul><li>x</li></ul><blockquote><p>x</p></blockquote><pre><code>x</code></pre>';
    document.body.appendChild(box);
    const 量 = function (sel) {
      const el = box.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        字号: parseFloat(cs.fontSize) || 0,
        行高: parseFloat(cs.lineHeight) || 0,
        字重: parseFloat(cs.fontWeight) || 0,
      };
    };
    const m = { h1: 量('h1'), h2: 量('h2'), h3: 量('h3'), h4: 量('h4'),
      h5: 量('h5'), h6: 量('h6'), p: 量('p'), li: 量('li'),
      quote: 量('blockquote p'), code: 量('pre code') };
    ORACLE = m;
    return m;
  }

  /** 块的顶层标签 → 影子容器里的对照键。`null` = 这一种不参与（表格 / 图这一类结构块）。 */
  function 基线键(tag) {
    const t = String(tag || '').toLowerCase();
    if (t === 'p') return 'p';
    if (t === 'ul' || t === 'ol') return 'li';
    if (t === 'blockquote') return 'quote';
    if (t === 'pre') return 'code';
    // ⚠️ 标题块的基线是标题，但**它的非标题行**该按正文尺度 ⇒ 对照 `p`。
    if (/^h[1-6]$/.test(t)) return 'p';
    return null;
  }

  /** 剥掉 `>` 引用前缀（最多 8 层，⛔ 不为了一个畸形文档写死循环）。 */
  function 去引用前缀(t) {
    let s = String(t);
    for (let k = 0; k < 8; k++) {
      const m = /^ {0,3}>[ ]?/.exec(s);
      if (!m) break;
      s = s.slice(m[0].length);
    }
    return s;
  }

  /**
   * 独立 oracle：源码每一行在**渲染态**是什么品种（`h1`–`h6` / `body` / `code` / `fence`）。
   * ⚠️ 围栏内部一律 `code`；围栏行**自己**是 `fence`——它有两个合法形态
   *    （`design/0052` U5：非活动 ⇒ 整行塌成 0 高；活动 ⇒ 原样显示源码、按 `code` 比），
   *    由 `逐行对照()` 分开判，⛔ 别把它并进 `code`（那样塌掉和"字号丢了"分不开）。
   */
  function 行品种(源) {
    const 行s = String(源).split('\n');
    const out = [];
    let fence = null;
    for (let i = 0; i < 行s.length; i++) {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(行s[i]);
      if (f) {
        fence = fence === null ? f[1].charAt(0) : null;
        out.push('fence');
        continue;
      }
      if (fence !== null) { out.push('code'); continue; }
      const h = /^ {0,3}(#{1,6})(\s|$)/.exec(去引用前缀(行s[i]));
      out.push(h ? ('h' + h[1].length) : 'body');
    }
    return out;
  }

  /** 一行该长成什么样（⛔ 不读任何产品状态）。 */
  function 期望样式(品种, 键) {
    const O = oracle();
    if (品种 && 品种.charAt(0) === 'h') return O[品种] || null;
    if (品种 === 'code') return O.code;
    return O[键] || null;
  }

  function 比样式(el, 期望) {
    const cs = getComputedStyle(el);
    const 号 = parseFloat(cs.fontSize) || 0;
    const 高 = parseFloat(cs.lineHeight) || 0; // `normal` ⇒ NaN ⇒ 0（那就不比行高）
    const 重 = parseFloat(cs.fontWeight) || 0;
    const bad = [];
    if (期望.字号 > 0 && Math.abs(号 - 期望.字号) > 0.5) {
      bad.push('字号 ' + 四舍(号) + '≠' + 四舍(期望.字号));
    }
    if (期望.行高 > 0 && 高 > 0 && Math.abs(高 - 期望.行高) > 0.5) {
      bad.push('行高 ' + 四舍(高) + '≠' + 四舍(期望.行高));
    }
    if ((期望.字重 >= 600) !== (重 >= 600)) {
      bad.push('字重 ' + 四舍(重) + '≠' + 四舍(期望.字重));
    }
    return bad;
  }

  /**
   * 逐行把**屏幕上这一行**跟 oracle 比一遍。
   * @returns {{ok:boolean, msg:string, 行数:number}}
   */
  function 逐行对照(host, 键) {
    const 源 = 块全文(host);
    const 品种 = 行品种(源);
    const lines = host.querySelectorAll('.cm-line');
    if (lines.length !== 品种.length) {
      return { ok: false, 行数: lines.length,
        msg: '`.cm-line` ' + lines.length + ' 行 ≠ 源码 ' + 品种.length + ' 行（视口裁剪或折行 ⇒ 这一条不承重）' };
    }
    const bad = [];
    for (let i = 0; i < lines.length; i++) {
      // ⭐ `design/0052` U5：围栏行有两个合法形态——非活动 ⇒ 整行塌成 0 高（字号 0）；
      //    活动 ⇒ 原样显示源码，按 `code` 的尺度比。⛔ 一边都不占就记红。
      if (品种[i] === 'fence') {
        const 号 = parseFloat(getComputedStyle(lines[i]).fontSize) || 0;
        if (号 <= 0.5) continue;
        const d = 比样式(lines[i], 期望样式('code', 键));
        if (d.length) bad.push('第' + (i + 1) + '行(fence·活动) ' + d.join('／'));
        continue;
      }
      const 期 = 期望样式(品种[i], 键);
      if (!期) continue;
      const d = 比样式(lines[i], 期);
      if (d.length) bad.push('第' + (i + 1) + '行(' + 品种[i] + ') ' + d.join('／'));
    }
    return { ok: bad.length === 0, 行数: lines.length, msg: bad.slice(0, 3).join('；') };
  }

  /** 第 `n` 行（0-based）的 `.cm-line`；越界 ⇒ `null`。 */
  function 行节点(host, n) {
    return host.querySelectorAll('.cm-line')[n] || null;
  }

  /** 光标所在行（0-based）；读不到 ⇒ `-1`。 */
  function 光标行(host) {
    try {
      const CM6 = window.rmdCM6;
      const V = CM6 && CM6.EditorView ? CM6.EditorView.findFromDOM(host) : null;
      if (V && V.state) return V.state.doc.lineAt(V.state.selection.main.head).number - 1;
    } catch (e) { void e; }
    return -1;
  }

  /**
   * 一类块跑一整套**用户动作**。每个动作之后都重新对照一次 oracle。
   * @returns {object} 这一类的摘要（⛔ 不是判据，判据已经 `记()` 进去了）
   */
  async function 跑一类块(base, i, 基键, 标签, 摘要) {
    const d = docEl();
    const node = d.children[i];
    const 全文0 = 块源(i);
    const 行0 = 全文0.split('\n').length;
    const ev = 点末(node);
    记('O-' + 标签 + '-0 点得进去', !!ev.defaultPrevented, ev.defaultPrevented ? '' : '点击没被接管');
    const host = await waitFor(主机, 4000);
    if (!host) {
      记('O-' + 标签 + '-0 点得进去', false, '等不到 ' + HOST_SEL + '；状态条：' + 状态条());
      return { 进入: false, 状态条: 状态条() };
    }
    await frames(1);
    const ta = 输入框();
    if (!ta) {
      记('O-' + 标签 + '-0 点得进去', false, '找不到离屏 textarea');
      return { 进入: false };
    }
    const r = { 进入: true, 块: i, 标签: 标签, 行: 行0 };

    // ① 进入时：屏幕上每一行都必须已经跟渲染态一致（0015 那一类的**通用**形式）
    r.进入时 = 逐行对照(host, 基键);
    记('O-' + 标签 + '-1 进入时逐行样式 ≡ 渲染态', r.进入时.ok, r.进入时.msg);

    // ② ⭐ 回车：新行必须是**它自己源码**该有的样子（正文块就是正文，代码块就是代码）
    // ⚠️⚠️ `点末` 点的是**第一行右侧** ⇒ 回车插在**第 1 行之后**，⛔ 不是块末。
    //    早先这一段按"末行"取节点 ⇒ 多行块（`ul` 5 行）取到的是**原来那一行**，
    //    于是 `-4` 判的是"没被敲过的行"，红的是**探针的取行**而不是产品。
    const 前行 = 光标行(host);
    键(ta, 'Enter');
    await frames(2);
    r.回车后行数 = 块全文(host).split('\n').length;
    r.回车行 = 光标行(host);
    记('O-' + 标签 + '-2 回车确实长出一行（且光标落在新行上）',
      r.回车后行数 === 行0 + 1 && r.回车行 === 前行 + 1,
      '行数 ' + 行0 + ' → ' + r.回车后行数 + '；光标行 ' + 前行 + ' → ' + r.回车行);
    r.回车后 = 逐行对照(host, 基键);
    记('O-' + 标签 + '-3 ⭐ 回车长出的新行样式 ≡ 渲染态（0015 的通用形式）',
      r.回车后.ok, r.回车后.msg);

    // ③ 在**光标那一行**敲 `## 小标题`：样式仍必须等于 oracle
    //    （非围栏块 → h2 尺度；代码块里这是**代码**，⛔ 不该变标题）
    // ⚠️⚠️ 判"以它开头"而**不是**"等于它"：`点末()` 点的是**第一视觉行**的右缘，
    //    段落/引用这类会折行的块上 `posAtCoords` 只能落到**折行点**⇒ 回车把那一段**从中间劈开**，
    //    敲进去的字落在下半行**行首**，后面还跟着原来那半句（如 `## 小标题类行内元素。…`）。
    //    那⛔ 不是产品的错——产品在这条路径上做的正是"在一行开头插入"。
    //    样式那半边才是承重的：`## x` 起头 ⇒ 整行（含被并进来的旧文字）都该是 h2。
    打字(ta, '#');
    打字(ta, '#');
    打字(ta, ' ');
    打字(ta, '小标题');
    await frames(2);
    r.敲标题后 = 逐行对照(host, 基键);
    const 敲入行 = 光标行(host);
    const 敲入文 = 敲入行 >= 0 ? String(块全文(host).split('\n')[敲入行] || '') : '';
    const 敲入节点 = 行节点(host, 敲入行);
    const 敲入号 = 敲入节点 ? parseFloat(getComputedStyle(敲入节点).fontSize) || 0 : 0;
    记('O-' + 标签 + '-4 敲出 `## 小标题` 后：文字落进那一行，样式仍 ≡ 渲染态',
      r.敲标题后.ok && 敲入文.indexOf('## 小标题') === 0,
      '该行源码「' + 敲入文 + '」；字号 ' + 四舍(敲入号) + ' px；' + r.敲标题后.msg);

    // ④ 先只删 4 个 ⇒ 单行块上这一行**正好只剩 `##`**
    //    ⚠️ 它**不是**"半截标题"，CommonMark 里那是**空 ATX 标题**（comrak 实测 `h2 L1`）
    //    ⇒ 排版必须仍然跟着**它自己的品种**走（`bugs/0016` 就是这里少了 `|$`，
    //    编辑态显示 14px 正文、渲染态却是空 h2）。折行的块上这一行会是 `##类行内元素。…`，
    //    那反而不是标题（`#` 后面紧跟非空白）——两种都由 `行品种()` 独立判，⛔ 不写死。
    for (let k = 0; k < 4; k++) 键(ta, 'Backspace');
    await frames(2);
    r.删到井号 = 逐行对照(host, 基键);
    const 井号行 = 光标行(host);
    const 井号文 = 井号行 >= 0 ? String(块全文(host).split('\n')[井号行] || '') : '';
    记('O-' + 标签 + '-5 删到只剩 `##` 时仍按**它自己的品种**排版（空 ATX 标题那一档）',
      r.删到井号.ok && 井号文.indexOf('##') >= 0,
      '该行源码「' + 井号文 + '」；' + r.删到井号.msg);

    // ⑤ 再把井号也删干净 ⇒ 那一行**必须**回落到基线尺度（④ 的对称面，`bugs/0015` 的用户动作）
    键(ta, 'Backspace');
    键(ta, 'Backspace');
    await frames(2);
    r.删回后 = 逐行对照(host, 基键);
    const 删后行 = 光标行(host);
    const 删后文 = 删后行 >= 0 ? String(块全文(host).split('\n')[删后行] || '') : '';
    记('O-' + 标签 + '-5b 标记删干净之后那一行回落到基线尺度（④ 的对称面）',
      r.删回后.ok && 删后文.charAt(0) !== '#',
      '该行源码「' + 删后文 + '」；' + r.删回后.msg);

    // ⑤b 粘贴：走**真实事件路径**（`onPaste` → `machine.handle('paste')` → 事务 → 文档）。
    //    ⚠️ 为什么它非得在这一层：`live-input.test.js` 压的是**状态机**、`live-wiring.test.js`
    //    只问"三个监听器在不在"——两者之间的那段（事件 → 状态机 → 事务 → 视图）**没人看**，
    //    而 `bugs/0014` 恰恰就死在那一段。
    //    ⚠️ `ClipboardEvent` ＋ `DataTransfer` 的构造在 WebKit 上未必可用：造不出来就**如实记失败**
    //    （⛔ 不记跳过——那会让整轮退出码恒为 2），说明里写明"探针合成不了"以便与"产品没收下"区分。
    const 粘贴前 = 块全文(host);
    const 粘贴前行 = 粘贴前.split('\n').length;
    let 粘贴说明 = '';
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', '粘贴的第一行\n粘贴的第二行');
      ta.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true,
      }));
    } catch (e) { 粘贴说明 = '⚠️ 探针合成不了 ClipboardEvent／DataTransfer：' + (e && e.message); }
    await frames(2);
    const 粘贴后 = 块全文(host);
    const 粘贴增行 = 粘贴后.split('\n').length - 粘贴前行;
    r.粘贴后 = 逐行对照(host, 基键);
    // ⚠️ 期望**正好多 1 行**：粘的是 `A\nB` 两行文字，而"行数"是数 `\n` 的个数加一
    //    ⇒ 插进一个位置只多出一个换行（早先写 `=== 2` 是我把"两行字"当成了"两个换行"，假红）。
    记('O-' + 标签 + '-5c 粘贴两行走真实 `paste` 事件：文字落进文档且逐行 ≡ 渲染态',
      粘贴增行 === 1 && 粘贴后.indexOf('粘贴的第一行') >= 0 && 粘贴后.indexOf('粘贴的第二行') >= 0
        && r.粘贴后.ok,
      '行数 ' + 粘贴前行 + ' → ' + (粘贴前行 + 粘贴增行) + '；' + r.粘贴后.msg + (粘贴说明 ? '；' + 粘贴说明 : ''));

    // ⑥ 撤销：⛔ 不许靠"改了不还原"混过上面几条
    let 收回 = 0;
    while (块全文(host) !== 全文0 && 收回 < 200) {
      键(ta, 'z', { meta: true });
      收回++;
      await frames(1);
    }
    记('O-' + 标签 + '-6 ⌘Z 逐字收回原文', 块全文(host) === 全文0,
      '按了 ' + 收回 + ' 次；长度 ' + 块全文(host).length + ' / 基线 ' + 全文0.length);
    r.撤销次数 = 收回;

    // ⑥ 未捕获异常（产品在处理器里抛错时，屏幕上"什么都没发生"——它与"按键没接线"同形）
    r.异常 = (window.__ERR || []).slice();

    // ⑦ 退出 + 几何恢复
    键(ta, 'Escape');
    const gone = await waitFor(function () { return !主机(); }, 4000);
    记('O-' + 标签 + '-7 退出后逐像素恢复', !!gone && 几何相等(base, 几何()),
      gone ? '几何没回原样：' + JSON.stringify(差异(base, 几何())) : 'host 还在');
    return r;
  }

  /** O 段入口：每类块各挑**第一个**（源码 ≤ 60 行）跑一遍。 */
  async function 跑操作矩阵(base, 摘要) {
    const d = docEl();
    const p = window.__rmd && window.__rmd.payload;
    if (!p) { 摘要.O = { 适用: false, 原因: '没有载荷' }; return; }
    const 挑 = [];
    const seen = {};
    for (let i = 0; i < d.children.length && i < p.blocks.length; i++) {
      const wire = p.blocks[i];
      if (!wire || wire[3] !== 1) continue;
      const tag = String(d.children[i].tagName || '');
      const 键 = 基线键(tag);
      if (!键 || seen[键 + tag]) continue;
      const 源 = 块源(i);
      if (源.split('\n').length > 60) continue; // ⚠️ 视口裁剪 ⇒ 逐行对照不承重
      seen[键 + tag] = true;
      挑.push({ i: i, 键: 键, 标签: tag.toLowerCase() });
    }
    if (!挑.length) { 摘要.O = { 适用: false, 原因: '没有 ≤60 行的可编辑块' }; return; }
    const 明细 = [];
    for (let k = 0; k < 挑.length; k++) {
      const c = 挑[k];
      明细.push(await 跑一类块(base, c.i, c.键, c.标签, 摘要));
      // ⚠️ 一类失败后**不中断**：其余几类正是要说明"是不是只有这一类有问题"。
      if (!几何相等(base, 几何())) {
        记('O-' + c.标签 + '-8 基线仍然一致', false, '这一类退出后几何没回到原样');
        break;
      }
    }
    摘要.O = { 适用: true, 类数: 挑.length, 明细: 明细 };
  }

  // ── H 段：`design/0047` §7.1 步骤 **0h**（最小纵向链路）──────────────────
  //
  // 取基线 → 进入 → 输入 → 合回 → 保存 → 重新渲染，**端到端一条**（评审指定的探针）。
  // ⚠️ 这条链路**跨三层**（CM6 视图 → 会话行模型 → `render_preview` / `save_document`），
  //    任何一层接错都是**静默的**：视图能打字、状态条说"已保存"，而写下去的字节是旧的。
  //    `B`/`D` 只量位移，看不见它；`tests/js/**` 里没有 IPC，也看不见它。
  //
  // ⚠️⚠️ 边界（如实登记）：假后端**不渲染 Markdown** ⇒ 本段判的是「**调用了谁、载荷是什么字节**」，
  //    ⛔ 不判重渲出来的 HTML 对不对。真 HTML 归 `make fidelity`（Rust 侧写盘逐字节）
  //    与 `make probe-live-commit`（提交无损），可见首帧归人工（`0c-②`）。
  // ⚠️ 说"字节"就必须真的数字节：`String.length` 是 **UTF-16 码元**，
  //    中文一个字算 1 而 UTF-8 占 3 ⇒ 拿 `.length` 当字节会**系统性少报**（这里踩过一次）。
  const 编码 = new TextEncoder();
  function 字节数(s) { return 编码.encode(String(s)).length; }

  async function 跑纵向链路(段落, base, 摘要) {
    const s0 = 计数('save_document');
    const r0 = 计数('render_preview');
    const o0 = 计数('open_document');
    const b0 = 计数('begin_edit');
    const e0 = 计数('end_edit');
    const 文本0 = String((window.__FIXTURE || {}).text || '');
    // ⚠️ 判据「去掉这个词就回到基线」要求基线里**本来没有**它，否则前置不成立。
    const 词 = '纵向链路';
    if (文本0.indexOf(词) >= 0) {
      记('H0 纵向链路：基线里没有「' + 词 + '」（判据前置）', false,
        '词已存在 ⇒ 无法用"去掉它就回到基线"判断插入点');
      return false;
    }

    // —— ① 进入 → **一个字都不改** → 退出（§7.1 `0e` 的"不改"那半）——
    点(docEl().children[段落]);
    const host = await waitFor(主机, 4000);
    if (!host) {
      记('H0 纵向链路：进入覆盖层', false, '等不到 ' + HOST_SEL + '：' + 状态条());
      return false;
    }
    记('H0 纵向链路：进入覆盖层', true, '块 ' + 段落);
    键(输入框(), 'Escape');
    await waitFor(function () { return !主机(); }, 4000);
    await frames(2);
    记('H1 进入→不改→退出：不写盘、不重渲、几何逐像素回原样',
      计数('save_document') === s0 && 计数('render_preview') === r0
        && 计数('open_document') === o0 && 几何相等(base, 几何()),
      'save +' + (计数('save_document') - s0) + ' / render +' + (计数('render_preview') - r0)
        + ' / open +' + (计数('open_document') - o0)
        + ' / 几何差 ' + JSON.stringify(差异(base, 几何())));

    // —— ② 进入 → 输入 → `⌘S`：合回与写盘必须是"基线 ＋ 刚敲的那几个字" ——
    点(docEl().children[段落]);
    const host2 = await waitFor(主机, 4000);
    if (!host2) {
      记('H2 纵向链路：第二次进入', false, '等不到 ' + HOST_SEL + '：' + 状态条());
      return false;
    }
    const ta = 输入框();
    if (!ta) { 记('H2 纵向链路：第二次进入', false, '找不到离屏 textarea'); return false; }
    记('H2 纵向链路：第二次进入', true, '');
    // ⚠️ 走的是**真键位表**（假后端回的是 `gui::SHORTCUTS` 导出的那一份）＋ 真 `forwardShim`：
    //    空表会让"按了没反应"与"产品没接线"输出一模一样。
    打字(ta, 词);
    await frames(2);
    键(ta, 's', { meta: true });
    await waitFor(function () { return 计数('save_document') > s0; }, 5000);
    await frames(2);

    const 保存 = 最近一次('save_document');
    const 渲染 = 最近一次('render_preview');
    记('H3 ⌘S 经真键位表认出来并走到 save_document', !!保存,
      保存 ? '' : ('save_document 没被调；状态条「' + 状态条() + '」'));
    const 写 = 保存 ? String(保存.args.text || '') : '';
    const 渲 = 渲染 ? String(渲染.args.text || '') : '';
    const 去词 = 写.split(词).join('');
    记('H4 写下去的全文 = 基线 ＋ 刚敲的字（逐字节）',
      !!保存 && 写 !== 文本0 && 去词 === 文本0 && 写.split(词).length === 2,
      '写盘 ' + 字节数(写) + ' 字节 / 基线 ' + 字节数(文本0) + ' 字节'
        + (!!保存 && 写 === 文本0 ? '（写下去的**就是基线**：提交没进全文）' : '')
        + (!!保存 && 去词 !== 文本0 && 写 !== 文本0 ? '（除插入点之外还有差异）' : ''));
    记('H5 合回与写盘是**同一份字节**（render_preview ≡ save_document）',
      !!渲染 && !!保存 && 渲 === 写 && 渲 !== '',
      'render ' + 字节数(渲) + ' 字节 / save ' + 字节数(写) + ' 字节');
    记('H6 重新渲染经 render_preview（⛔ 不是重新 open_document）',
      计数('render_preview') - r0 >= 1 && 计数('open_document') === o0,
      'render +' + (计数('render_preview') - r0) + ' / open +' + (计数('open_document') - o0));

    // —— ③ 无改动再按一次 `⌘S` ⇒ 短路，不写盘（`INV-EDIT-12` ①）——
    const s1 = 计数('save_document');
    键(ta, 's', { meta: true });
    await frames(4);
    记('H7 无改动再按 ⌘S 不再写盘', 计数('save_document') === s1,
      'save_document +' + (计数('save_document') - s1));

    // —— ④ 退出 ⇒ 写授权收回（`INV-LIVE-11`：写授权只在覆盖层活着时持有）——
    键(ta, 'Escape');
    const gone = await waitFor(function () { return !主机(); }, 4000);
    const 进 = 计数('begin_edit') - b0;
    const 出 = 计数('end_edit') - e0;
    记('H8 退出后写授权收回（begin_edit / end_edit 配平）', !!gone && 进 === 出,
      'host ' + (gone ? '已摘' : '还在') + ' / begin_edit +' + 进 + ' · end_edit +' + 出);
    摘要.H = { 基线字节: 字节数(文本0), 写盘字节: 字节数(写), render: 计数('render_preview') - r0,
      open: 计数('open_document') - o0, begin: 进, end: 出 };
    return true;
  }


  // ── L 段：`design/0047` §7.1 步骤 **0f**（键入的主线程代价 vs 块大小）──────────
  //
  // ⭐ 要回答的是 §7.1 那一行的问题：**一次键入在一块视图里要付多少主线程代价**，
  //    从而给 `LIVE_LIMITS.maxBlockLines` / `maxBlockBytes`（现在是外推初值）找实测依据。
  //    闸门口径照抄设计：**p95 < 16 ms** 才允许这个尺寸的块进入 live。
  //
  // 量的那一段是**同步**的、完全在页内：
  //   `input` 派发 → CM6 更新事务 → 装饰层 `StateField` 重算（`markers()` 是 O(块大小)）
  //   → DOM 补丁 → 一次强制同步布局（`void host.offsetHeight`）。
  //
  // ⚠️⚠️ 口径边界（⛔ 别把它读成"端到端输入延迟"）：
  //   · **不含** OS 键事件 → WebView、合成/光栅化，也不含 CM6 延到 rAF 的那轮测量；
  //     它量的是 16 ms 帧预算里**由我们控制**的那一块。
  //   · ⛔ **不含**提交后的整篇重渲：假后端不渲染 Markdown（那一半归 `probe-live-commit`、
  //     `make fidelity` 与人工可见首帧 `0c-②`）。
  //   · ⚠️ WebKit 把 `performance.now()` 截到 **1 ms** ⇒ 单次代价常被量化成 0/1；
  //     所以同时报**批量均值**（一次计时 20 连击）作为精度补充。p95 在 16 ms 这个量级上仍然可信。
  //   · ⚠️ **单线程顺序执行**：不带任何后台负载，⛔ 别当成"用户在跑别的程序时"的数字。
  //
  // ⚠️ 只对**≥ 200 行**的可编辑块产判据；其余夹具记 `摘要.L = {适用:false}` 且
  //    **既不记通过也不记跳过**（记跳过会让整轮退出码恒为 2）⇒ 由 shell 端 `L-覆盖` 把关。
  const L预算 = 16;

  function 分位(样本, p) {
    const s = 样本.slice().sort(function (a, b) { return a - b; });
    if (!s.length) return 0;
    const i = Math.max(0, Math.min(s.length - 1, Math.ceil(p * s.length) - 1));
    return s[i];
  }

  async function 跑键入延迟(摘要) {
    const d = docEl();
    const p = window.__rmd.payload;
    const 候选 = [];
    for (let i = 0; i < d.children.length && i < p.blocks.length; i++) {
      if (p.blocks[i][3] !== 1) continue;
      const 源 = 块源(i);
      const 行 = 源 === '' ? 0 : 源.split('\n').length;
      if (行 >= 200) 候选.push({ i: i, 行: 行, 字节: 字节数(源) });
    }
    if (!候选.length) {
      摘要.L = { 适用: false, 原因: '这份夹具里没有 ≥200 行的可编辑块' };
      return;
    }
    const 明细 = [];
    const 每批 = 20;
    const 采样 = 60;
    const 预热 = 5;
    const 应有 = 预热 + 每批 * 3 + 采样;

    for (let k = 0; k < 候选.length; k++) {
      const c = 候选[k];
      const tag = 'L' + c.行;
      console.error('· L 段：' + c.行 + ' 行块（' + c.字节 + ' 字节）');
      const node = d.children[c.i];
      点(node);
      const host = await waitFor(主机, 8000);
      if (!host) {
        记(tag + '-1 键入延迟：' + c.行 + ' 行块进得去', false,
          '等不到 ' + HOST_SEL + '：' + 状态条());
        明细.push({ 行: c.行, 字节: c.字节, 进入: false, 状态条: 状态条() });
        continue;
      }
      记(tag + '-1 键入延迟：' + c.行 + ' 行块进得去', true, c.字节 + ' 字节');
      await frames(2);
      const ta = 输入框();
      if (!ta) {
        记(tag + '-2 键入延迟：' + c.行 + ' 行块', false, '找不到离屏 textarea');
        continue;
      }
      const 文本0 = 块全文(host);

      // 预热：JIT ＋ CM6 首帧测量。⛔ 不预热的话第一个样本会把"冷启动"记成"键入代价"。
      for (let w = 0; w < 预热; w++) { 打字(ta, 'a'); await frames(1); }

      // ① 批量均值（对抗 1 ms 时钟分辨率）
      const 批均值 = [];
      for (let b = 0; b < 3; b++) {
        const tb0 = performance.now();
        for (let n = 0; n < 每批; n++) 打字(ta, 'a');
        void host.offsetHeight;
        const tb1 = performance.now();
        批均值.push(四舍((tb1 - tb0) / 每批));
      }
      // ② 单次采样（p50/p95；⚠️ `t1-t0` 只是 CPU 处理，`t2-t0` 含一次强制同步布局）
      const 处理 = [];
      const 含布局 = [];
      for (let n = 0; n < 采样; n++) {
        const t0 = performance.now();
        打字(ta, 'a');
        const t1 = performance.now();
        void host.offsetHeight;
        const t2 = performance.now();
        处理.push(四舍(t1 - t0));
        含布局.push(四舍(t2 - t0));
      }
      // ⚠️ 配对判据：上面那些数字若来自"一个字符都没进去"，会静默变成"零代价"。
      const 长1 = 块全文(host).length;
      记(tag + '-2 键入确实落进文档（+' + 应有 + ' 字）', 长1 === 文本0.length + 应有,
        '块内文本 ' + 文本0.length + ' → ' + 长1);

      const 均 = 四舍(批均值.reduce(function (a, b) { return a + b; }, 0) / 批均值.length);
      const p50 = 分位(含布局, 0.5);
      const p95 = 分位(含布局, 0.95);
      记(tag + '-3 键入代价 p95 ≤ ' + L预算 + ' ms（含一次强制同步布局）', p95 <= L预算,
        'p50 ' + p50 + ' ms / p95 ' + p95 + ' ms / 批量均值 ' + 均 + ' ms'
          + '（处理 ' + 分位(处理, 0.5) + '/' + 分位(处理, 0.95)
          + '；' + 采样 + ' 次采样 ＋ 3×' + 每批 + ' 连击）');

      // 撤销回原文：⛔ 不给下一块与退出路径留任何改动（改了就会触发提交＋整篇重渲）
      let 撤 = 0;
      for (let n = 0; n < 400; n++) {
        if (块全文(host) === 文本0) break;
        键(ta, 'z', { meta: true });
        撤++;
        await frames(1);
      }
      const 回位 = 块全文(host) === 文本0;
      记(tag + '-4 撤销回到起点（不给退出留改动）', 回位,
        回位 ? ('按了 ' + 撤 + ' 次') : ('按满 400 次仍未回位：「' + 块全文(host).slice(0, 40) + '」'));
      const s0 = 计数('save_document');
      const r0 = 计数('render_preview');
      键(ta, 'Escape');
      const gone = await waitFor(function () { return !主机(); }, 6000);
      记(tag + '-5 退出后覆盖层摘掉且不写盘不重渲',
        !!gone && 计数('save_document') === s0 && 计数('render_preview') === r0,
        'host ' + (gone ? '已摘' : '还在') + ' / save +' + (计数('save_document') - s0)
          + ' / render +' + (计数('render_preview') - r0));
      明细.push({ 行: c.行, 字节: c.字节, 进入: true, p50: p50, p95: p95, 均值: 均,
        处理p50: 分位(处理, 0.5), 处理p95: 分位(处理, 0.95), 撤销: 撤, 回位: 回位 });
    }

    // ⭐ 取证（⛔ 不是判据，只进摘要）：装饰层单独随块大小怎么涨。
    //    为什么要它：`LIVE_LIMITS` 的**上界该定在哪**需要一条趋势；而超过上限的块
    //    产品**根本不让进**（那是对的），于是只能在页内直接压 `markers()` 取样。
    const 规模 = {};
    const LM = window.rmd && window.rmd.liveMarks;
    if (LM && typeof LM.markers === 'function') {
      // ⚠️ 每行必须**真有标记**（`**` / 反引号 / 链接）：第一版用的是纯代码行，`markers()`
      //    扫出来的区间是 **0 个**（0/0/1 ms）——那测的是"没有标记时的函数调用开销"，
      //    ⛔ 不是"O(块大小) 的扫描代价"，拿它当趋势依据等于没量。
      const 每行 = '**粗体** 与 `代码` 与 [链接](https://example.com) —— 第 0 行的取证样本';
      const 阶梯 = [2000, 4000, 8000];
      for (let i = 0; i < 阶梯.length; i++) {
        const n = 阶梯[i];
        const 文 = new Array(n).fill(每行).join('\n');
        // ⚠️ `design/0052` U3 起 `markers()` 的判据是**语法树** ⇒ **建树也是这条路的成本**，
        //    两段分开量。⛔ 把建树挪到计时外面就变成"只量藏、不量认"，趋势会凭空好看，
        //    而真实编辑路径上 `treeOf()` 每次都要拿到树才藏得掉（拿不到就整块降级）。
        const a0 = performance.now();
        const tree = 造树(文);
        const a1 = performance.now();
        const r = LM.markers(文, { activeLines: [0], tree: tree });
        const a2 = performance.now();
        规模[String(n)] = {
          建树毫秒: 四舍(a1 - a0), 标记毫秒: 四舍(a2 - a1),
          区间: r.ranges.length, 有树: !!tree,
        };
      }
    }
    摘要.L = { 适用: true, 预算毫秒: L预算, 样本: 明细, 装饰层: 规模 };
  }


  //
  // ⚠️ 只有当 `block-probe.sh --diag` 把页面副本里 `live/index.js` 的几何闸门关掉之后
  //    才跑得通（否则被拒的块根本没有视图可量）。它量的是**同一份真产品**，只是不设闸。
  function 样式(el) {
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      高: 四舍(r.height),
      宽: 四舍(r.width),
      字号: cs.fontSize,
      行高: cs.lineHeight,
      字重: cs.fontWeight,
      字体: cs.fontFamily,
      内上: cs.paddingTop,
      内下: cs.paddingBottom,
      内左: cs.paddingLeft,
      外上: cs.marginTop,
      外下: cs.marginBottom,
      边框左: cs.borderLeftWidth,
      底色: cs.backgroundColor,
    };
  }

  // ── W 段：`⌘↵` **跳出这一块、在它后面新起一段、光标落进去**（`design/0052` U7 / `bugs/0024`）──
  //
  // ⚠️⚠️ **整段 2026-10-28 重写**。旧的一套（`⌘↵` 退出到阅读态 ＋ 自绘一根 `.rmd-caret-hint`
  //    ＋ 敲字再进来）**是错误需求的实现，已按用户更正整体撤回**。用户原话（逐字）：
  //    「`⌘Enter` 表示跳出当前引用块，在块后创建新的正文段落，并将真实编辑光标放到该段落，
  //      保持编辑状态与输入焦点；不是退出到阅读态后等待按键重新进入。`Enter` 继续引用。」
  //    ⇒ 验收因此必须覆盖三件用户点名的事：① **中文输入**；② **后面已经有正文**时的插入位置；
  //    ③ **一次撤销**恢复「操作前的内容**与光标**」。
  //
  // ⭐ oracle **只用两样**，两样都不会被"假后端不渲染 Markdown"带歪：
  //    ① IPC 载荷 —— `render_preview` 的入参 `text` 是**提交进会话的正文**（唯一真值）；
  //    ② DOM 顺序 —— 新段落那根临时 `<p>` 宿主播在 `#doc` 的第几个孩子上。
  //    ⛔ 不读 `#doc` 里的文字：一提交它就是 Stage A 的原件（`fake-tauri.js` 文件头）。
  //
  // ⚠️ **提交那一步的逐字断言不在这里**（中文那一路的"落进文档"由
  //    `tests/js/live-controller.test.js` 判：节点测试拿得到会话文本，探针拿不到，
  //    而假后端又不渲染 ⇒ 探针只判"提交进会话的正文"这一层 = `render_preview` 的载荷）。
  //
  // ⚠️ 本段自己把正文改回原样（W2/W4 用 ⌘Z，W5 收尾 ⌘Z ＋ Esc），W6 再逐行核对一次 ——
  //    因为**排在它后面的 X 段**要按 `#doc` 与块表干活。
  // ⚠️ 只在**可编辑、且后面还有正文**的夹具上产判据；其余记 `摘要.W = {适用:false}`，
  //    **既不记通过也不记跳过** ⇒ 由 `block-probe.sh` 的 `W-覆盖` 把关。
  async function 跑新起段落(base, 摘要) {
    const d = docEl();
    const p = window.__rmd && window.__rmd.payload;

    /** 会话此刻的正文：**最后一次提交进 `render_preview` 的那一份**；一次都没提交过 ⇒ 夹具原文。 */
    function 当前全文() {
      const r = 最近一次('render_preview');
      return r && r.args && typeof r.args.text === 'string'
        ? r.args.text
        : String((window.__FIXTURE || {}).text || '');
    }

    /** 逐行比两份正文，返回**第一处**不同的说明；相等 ⇒ `''`。 */
    function 差在哪(a, b) {
      const x = String(a === null || a === undefined ? '' : a).split('\n');
      const y = String(b === null || b === undefined ? '' : b).split('\n');
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) {
        if (x[i] !== y[i]) {
          return '第 ' + (i + 1) + ' 行：「' + x[i].slice(0, 36) + '」≠「' + y[i].slice(0, 36) + '」';
        }
      }
      return x.length === y.length ? '' : ('行数 ' + x.length + ' ≠ ' + y.length);
    }

    const 全文前 = 当前全文();
    const 行 = 全文前.split('\n');
    const 可选 = [];
    for (let i = 0; i < p.blocks.length && i < d.children.length; i++) {
      const w = p.blocks[i];
      if (w[3] !== 1) continue; // 不可编辑
      if (String(p.block_kinds[w[0]] || '') === 'Table') continue; // 表格走 `0049` 那条路
      // ⭐ **后面还有正文**：用户点名要覆盖的正是"块后头还接着东西"这一种插入位置。
      if (!行.slice(w[2]).some(function (l) { return l.trim() !== ''; })) continue;
      可选.push(i);
    }
    // ⭐ 优先**引用块**（用户的原话就是"跳出当前引用块"）；没有就退到任意可编辑块——
    //    产品那条实现与块品种无关，断言逐条相同。
    let 块 = -1;
    for (let k = 0; k < 可选.length; k++) {
      if (String(p.block_kinds[p.blocks[可选[k]][0]] || '') === 'BlockQuote') { 块 = 可选[k]; break; }
    }
    let 品种 = 'BlockQuote';
    if (块 < 0 && 可选.length) {
      块 = 可选[0];
      品种 = String(p.block_kinds[p.blocks[块][0]] || '');
    }
    // ⚠️ `blocks` 的坐标是 **1-based 含两端**（`blocks.rs`）：`[2]` = 末行号，
    //    它正好等于 0-based 的"块后那一行"（＝插入点）。
    const insertAt = 块 >= 0 ? p.blocks[块][2] : -1;
    摘要.W = {
      适用: 块 >= 0,
      可编辑块: 可选.length,
      块: 块,
      品种: 品种,
      插入点: insertAt,
      段: 'O 之后 / Z1 之前',
    };
    if (块 < 0) return;

    const 源块文本 = 行.slice(p.blocks[块][1] - 1, p.blocks[块][2]).join('\n');

    /** 期望正文：在 `insertAt` 处插三行空行，再把中间那一行换成 `中行`（不给就留空）。 */
    function 期望(中行) {
      const a = 行.slice(0, insertAt).concat(['', '', ''], 行.slice(insertAt));
      if (typeof 中行 === 'string') a[insertAt + 1] = 中行;
      return a.join('\n');
    }
    const 期望插入后 = 期望();

    /** 点这一块**第一行的行尾**并等**新的**宿主（`leave()` 是异步的，旧宿主还挂在树上）。 */
    async function 进入() {
      const 旧 = 主机();
      // ⚠️ 点**行尾**而不是左上角：光标要落在一个**非 0** 的偏移上，否则
      //    W2b（撤销恢复光标）就退化成"恢复成 0 也对"，判不出东西。
      点末(d.children[块]);
      const 新 = await waitFor(function () {
        const h = 主机();
        return h && h !== 旧 ? h : null;
      }, 4000);
      // ⚠️⚠️ 光靠 `点末()` 建立不了这个前提（2026-10-28 实测）：引用块与列表项都有自己的
      //    **上内边距**，`top + 8` 可能落在文字上方 ⇒ `posAtCoords` 夹回第 0 个位置
      //    （`blocks` / `tasks` 两份夹具就是这样停在 0 的）。⇒ 再按一次 **`End`**（真按键，
      //    走产品自己那条 `End → lineEnd`），把光标确定地推到**首行行尾**。
      //    ⛔ 别改成直接改视图选区——那会绕开被验的那条路。
      if (新) {
        键(输入框() || document.body, 'End');
        await frames(1);
      }
      return 新;
    }

    /** 等**另一个**宿主出现（`⌘↵` 之后新段落是临时 `<p>` 里的新视图）。 */
    async function 等新段落(旧宿主) {
      return await waitFor(function () {
        const h = 主机();
        return h && h !== 旧宿主 ? h : null;
      }, 6000);
    }

    /** 节点是 `#doc` 的第几个孩子；不在 ⇒ `-1`。 */
    function 下标(el) {
      for (let i = 0; i < d.children.length; i++) if (d.children[i] === el) return i;
      return -1;
    }

    // ── W1 `⌘↵`：仍在编辑态、光标在新段落段首、宿主紧跟原块、三行空行插在它之后 ──
    let host = await 进入();
    if (!host) {
      记('W1 ⌘↵ 之后仍在编辑态、光标落在新段落段首', false, '进不去；状态条：' + 状态条());
      return;
    }
    await frames(1);
    const 光标0 = 选区头(host);
    const 提交0 = 计数('render_preview');
    键(输入框() || document.body, 'Enter', { meta: true });
    const 段1 = await 等新段落(host);
    await frames(2);
    const ta1 = 输入框();
    const 文1 = 段1 ? 块全文(段1) : null;
    const 光标1 = 段1 ? 选区头(段1) : -1;
    记('W1 ⌘↵ 之后仍在编辑态、光标落在新段落段首', !!段1 && 文1 === '' && 光标1 === 0
      && !!ta1 && document.activeElement === ta1,
    !段1
      ? ('按了 ⌘↵ 之后没有出现新段落的视图（状态条：' + 状态条() + '；旧宿主'
        + (host.isConnected ? '还挂在树上' : '已撤下') + '）')
      : ('新段落内容「' + 文1 + '」（必须为空）／光标 ' + 光标1 + '（必须是 0）／焦点「'
        + String((document.activeElement
          && (document.activeElement.className || document.activeElement.tagName)) || 'null')
        + '」（必须是 ' + INPUT_SEL + '）'));

    const r1 = 最近一次('render_preview');
    const 提交1 = r1 && r1.args && typeof r1.args.text === 'string' ? r1.args.text : null;
    记('W1b 三行空行插在**这一块之后**（后面原有的正文逐字不变）',
      计数('render_preview') === 提交0 + 1 && 提交1 === 期望插入后,
      计数('render_preview') !== 提交0 + 1
        ? ('没有恰好多一次 render_preview（+' + (计数('render_preview') - 提交0) + '）')
        : ('提交的正文与期望不符：' + 差在哪(提交1, 期望插入后)
          + '；插入点 = 第 ' + (insertAt + 1) + ' 行之前（1-based，＝这一块的末行号）'));

    记('W1c 新段落宿主在 DOM 里紧跟刚离开那一块', !!段1 && d.children[块 + 1] === 段1,
      '它是 `#doc` 的第 ' + (段1 ? 下标(段1) : '?') + ' 个孩子（0-based）／期望第 ' + (块 + 1) + ' 个');

    // ── W2 一次 `⌘Z`：内容与光标**一起**回到操作前（用户点名的第三条验收）────────
    const 提交2 = 计数('render_preview');
    键(输入框() || document.body, 'z', { meta: true });
    const 回块 = await waitFor(function () {
      const h = 主机();
      return h && h !== 段1 ? h : null;
    }, 6000);
    await frames(2);
    const 文2 = 回块 ? 块全文(回块) : null;
    const 光标2 = 回块 ? 选区头(回块) : -1;
    记('W2 一次 ⌘Z 把正文恢复到操作前', 计数('render_preview') === 提交2 + 1 && 当前全文() === 全文前,
      计数('render_preview') !== 提交2 + 1
        ? ('撤销没有触发一次提交（render_preview +' + (计数('render_preview') - 提交2) + '）')
        : ('正文与操作前不符：' + 差在哪(当前全文(), 全文前)));
    记('W2b 一次 ⌘Z 把光标放回操作前那一处', !!回块 && 光标0 > 0 && 光标2 === 光标0,
      !回块
        ? ('撤销之后没有回到原来那一块的视图（状态条：' + 状态条() + '）')
        : (光标0 > 0
          ? ('光标 ' + 光标2 + ' / 操作前 ' + 光标0)
          : '⚠️ 前提没建立：进入时光标就在 0（这一条判不出"恢复光标"）'));
    记('W2c 撤销之后宿主回到原来那一块（临时 <p> 已不在）', !!回块 && d.children[块] === 回块,
      '宿主是第 ' + (回块 ? 下标(回块) : '?') + ' 个孩子／期望第 ' + 块 + ' 个');

    // ── W3 中文输入：组合期**一个字节都不动**，上屏之后逐字落进**新段落** ────────
    // ⚠️ 从"已经回到原来那一块"的状态再按一次 `⌘↵`（W2 已把正文与光标都恢复）。
    const 提交3 = 计数('render_preview');
    键(输入框() || document.body, 'Enter', { meta: true });
    const 段3 = await 等新段落(回块);
    await frames(1);
    const r3 = 最近一次('render_preview');
    const 提交3文 = r3 && r3.args && typeof r3.args.text === 'string' ? r3.args.text : null;
    let 组合干净 = false;
    let 组合说明 = '第二次 ⌘↵ 没有开出新段落';
    let 文3 = null;
    let 光标3 = -1;
    if (段3) {
      const ta3 = 输入框() || document.body;
      const 前文 = 块全文(段3);
      组合(ta3, 'compositionstart', '');
      const 串 = ['n', 'ni', 'nih', 'niha', 'nihao'];
      for (let k = 0; k < 串.length; k++) {
        组合(ta3, 'compositionupdate', 串[k]);
        await frames(1);
      }
      const 后文 = 块全文(段3);
      组合干净 = 后文 === 前文 && 计数('render_preview') === 提交3 + 1 && 提交3文 === 期望插入后;
      组合说明 = '组合期新段落内容「' + 后文 + '」（原文「' + 前文 + '」）／render_preview +'
        + (计数('render_preview') - 提交3 - 1) + '（必须 +0，即只有 ⌘↵ 那一次）／'
        + (提交3文 === 期望插入后 ? '插入位置对' : ('插入位置不对：' + 差在哪(提交3文, 期望插入后)));
      // ⭐ 上屏：组合串这时才落进文档
      组合(ta3, 'compositionend', '你好');
      await frames(2);
      文3 = 块全文(段3);
      光标3 = 选区头(段3);
    }
    记('W3 中文组合期间新段落里一个字节都不动', !!段3 && 组合干净, 组合说明);
    记('W3b 中文上屏之后逐字落进新段落（光标在 2）', 文3 === '你好' && 光标3 === 2,
      段3 ? ('新段落内容「' + 文3 + '」（必须是「你好」）／光标 ' + 光标3 + '（必须是 2）')
        : '第二次进不去；状态条：' + 状态条());

    // ── W4 ⭐ 敲完字之后再 `⌘Z` 两次：先撤字、再撤「新起一段」这一步（⛔ 一次不跨层）──
    // ⚠️ 这一条**既是判据也是收尾**：正文必须在离开本段之前逐行回到操作前。
    const 提交4 = 计数('render_preview');
    键(输入框() || document.body, 'z', { meta: true });
    await frames(2);
    const 文4 = 主机() ? 块全文(主机()) : null;
    键(输入框() || document.body, 'z', { meta: true });
    const 回块4 = await waitFor(function () {
      const h = 主机();
      return h && h !== 段3 ? h : null;
    }, 6000);
    await frames(2);
    记('W4 敲字之后 ⌘Z 两次：先撤字、再撤「新起一段」（⛔ 一次不跨层）',
      !!段3 && 文4 === '' && !!回块4 && 当前全文() === 全文前,
      !段3 ? '前提没建立：第二次 ⌘↵ 没有开出新段落'
        : (文4 === ''
          ? (回块4 ? (当前全文() === 全文前 ? '' : ('正文与操作前不符：' + 差在哪(当前全文(), 全文前)))
            : ('第二次 ⌘Z 之后没有回到原来那一块（`render_preview` +'
              + (计数('render_preview') - 提交4) + '）'))
          : ('第一次 ⌘Z 没有撤掉刚上屏的字（新段落内容「' + 文4 + '」）')));

    // ── W5 裸 `Enter`：**继续待在这一块里**（"`Enter` 继续引用"），不重渲、不换宿主 ──
    const 回块5 = 主机();
    const 提交5 = 计数('render_preview');
    const 文5前 = 回块5 ? 块全文(回块5) : null;
    // ⚠️ 期望值用**此刻真实的光标**（⛔ 不用 W1 之前记的 `光标0`）：这一条判的是
    //    "Enter 在光标处插一个换行、仍留在这一块"，⛔ 不该连带把"撤销恢复光标"也算进它
    //    的成败——那是 W2b 的事，两条判据耦合会让 M20 那种单点变异红两格。
    const 光标5 = 回块5 ? 选区头(回块5) : -1;
    键(输入框() || document.body, 'Enter');
    await frames(2);
    const 文5后 = 主机() ? 块全文(主机()) : null;
    const 期望5 = 文5前 === null || 光标5 < 0
      ? null
      : (文5前.slice(0, 光标5) + '\n' + 文5前.slice(光标5));
    记('W5 裸 Enter 继续留在这个块里（只多一个换行）',
      !!回块5 && 主机() === 回块5 && 计数('render_preview') === 提交5
        && 文5前 === 源块文本 && 文5后 === 期望5,
    !回块5 ? '前提没建立：W4 之后没有视图'
      : (主机() !== 回块5 ? '按了 Enter 之后宿主换了（＝退出又重进了）'
        : (计数('render_preview') !== 提交5 ? '按了 Enter 就触发了一次重渲'
          : (文5前 !== 源块文本
            ? ('W4 之后这一块的内容不是它的源码：' + 差在哪(文5前, 源块文本))
            : (光标5 < 0
              ? '前提没建立：读不到光标'
              : ('内容「' + String(文5后).slice(0, 40) + '」／期望「'
                + String(期望5).slice(0, 40) + '」（光标 ' + 光标5 + '）'))))));

    // 收尾：撤掉那个换行再退出（撤销之后 == 源码 ⇒ 不提交、不重渲）
    键(输入框() || document.body, 'z', { meta: true });
    await frames(1);
    键(输入框() || document.body, 'Escape');
    await waitFor(function () { return !主机(); }, 4000);
    await frames(2);
    记('W6 整段跑完之后正文逐行回到操作前', 当前全文() === 全文前,
      (当前全文() === 全文前 ? '' : ('收尾没回到原样：' + 差在哪(当前全文(), 全文前))));
  }

  // ── P 段：**退出覆盖层的每一条路**（`bugs/0018`）──────────────────────────
  //
  // 2026-10-27 用户实测：「这里执行 cmd + enter 应该退出标签模式，进入正文模式。
  // 一旦进入标签模式，就出不来」——而 B 段几百条判据**一条都没红**，因为 B 段只有一种
  // 退出方式：`键(ta, 'Escape')`。它同时假定两件没验过的事：
  //   ① 焦点一定在离屏 textarea 上（它**直接往 `ta` 派发事件**，判不了焦点在哪）；
  //   ② `Esc` 这一条路一定通（其余四条：`⌘↵` / 点空白 / 点结构块 / 点另一块，一条都没跑）。
  // ⇒ 这一段专门量"焦点前提 ＋ 其余退出路"，⛔ 它不替代 B 段，只补 B 段结构上够不着的那半边。
  async function 跑退出通道(base, 摘要) {
    const d = docEl();
    const p = window.__rmd && window.__rmd.payload;
    const 数 = d.children.length;
    const 可编辑 = [];
    for (let i = 0; i < p.blocks.length && i < 数; i++) if (p.blocks[i][3] === 1) 可编辑.push(i);
    摘要.P = { 适用: 可编辑.length >= 1, 可编辑块: 可编辑.length };
    if (!可编辑.length) return;

    /** 退出后收尾：⛔ 别把失败留在屏幕上，后面还有 Z1 要看异常。 */
    async function 收尾() {
      const ta = 输入框();
      if (主机()) 键(ta || document.body, 'Escape');
      await waitFor(function () { return !主机(); }, 4000);
      await frames(1);
    }

    /**
     * 点第 `i` 块并等一个**新**宿主。
     *
     * ⚠️⚠️ 必须等"新"的：`主机()` 是 `#doc` 下**任意深度**的第一个 `.cm-rmd-liveHost`。
     *    直接在点完之后 `waitFor(主机)` 会**立刻**返回**上一个**宿主（它还挂在树上，`leave()`
     *    是异步的）⇒ `P5` 会假绿、`P7` 会拿一个**脱树**的旧宿主去比下标（实测就是那样红的）。
     */
    async function 进入(i) {
      const 旧 = 主机();
      点(d.children[i]);
      return await waitFor(function () {
        const h = 主机();
        return h && h !== 旧 ? h : null;
      }, 4000);
    }

    const 第一 = 可编辑[0];
    const 第二 = 可编辑.length >= 2 ? 可编辑[1] : -1;

    // ── P1 进入之后，焦点**真的**在离屏 textarea 上 ────────────────────────
    // ⚠️ 这是覆盖层**所有**键盘的前提（`onKeyDown` 只挂在那一个元素上）：
    //    焦点不在它身上时，`Esc` / `⌘S` / `⌘Z` / 打字**一条都不进**，
    //    而屏幕上覆盖层好端端地开着 —— 用户看到的就是"卡住了"。
    let host = await 进入(第一);
    if (!host) {
      记('P1 进入后焦点在离屏 textarea 上', false,
        '等不到 ' + HOST_SEL + '；状态条：' + 状态条());
      return;
    }
    await frames(1);
    let ta = 输入框();
    const ae = document.activeElement;
    记('P1 进入后焦点在离屏 textarea 上', !!ta && ae === ta,
      'activeElement = ' + String((ae && (ae.className || ae.tagName)) || 'null'));

    // ── P2 `⌘↵`：⭐ 2026-10-28 按用户更正改了语义（`bugs/0024` §4）────────────
    //    ⛔ **它不再是"提交并退出"**，而是「跳出这一块、在它后面新起一段、光标落进去、
    //    **仍留在编辑态**」（判据在 W 段）。这里只判"两条路都不许卡住"——因为 P 段要对
    //    **任何**夹具成立：单元格形态里 `newParagraph()` 返回 false ⇒ `main.js` 退回
    //    "提交并退出"。⇒ ① 出现新宿主＝新段落（仍在编辑态）；② 覆盖层没了＝兜底退出；
    //    ③ 两条都不成立 ⇒ **红**——那正是 `bugs/0018`「一旦进入标签模式，就出不来」的形态。
    //    ⭐ 之后一律再按一次 `Esc` ＋ `收尾()`：`⌘↵` 改语义之后，"仍然退得出去"这条保证
    //    只剩这里看着（`W 段` 也用 `Esc` 收尾，但那是另一份夹具、另一条路）。
    const 之前 = 主机();
    键(ta || document.body, 'Enter', { meta: true });
    const 去向 = await waitFor(function () {
      const h = 主机();
      if (!h) return '退出';
      return h !== 之前 ? '新段落' : null;
    }, 6000);
    await frames(1);
    let 详情 = '';
    if (去向 === '新段落') {
      const ta2 = 输入框();
      const 文 = 主机() ? 块全文(主机()) : null;
      const 光标 = 主机() ? 选区头(主机()) : -1;
      详情 = '新段落「' + 文 + '」／光标 ' + 光标 + '／焦点「'
        + String((document.activeElement
          && (document.activeElement.className || document.activeElement.tagName)) || 'null') + '」';
      // ⚠️ 新段落必须是空的、焦点必须在离屏 textarea 上 —— 否则"仍在编辑态"是假的
      //    （屏幕上看得到光标，一敲字什么都不进，`bugs/0018` 就是这种形态）。
      if (文 !== '' || 光标 !== 0 || !ta2 || document.activeElement !== ta2) 去向 = '异常';
    } else if (去向 === '退出') {
      详情 = '覆盖层没了（单元格 / 不可用的兜底路径）';
    } else {
      详情 = '按了 ⌘↵ 之后既没有新段落也没有退出（状态条：' + 状态条() + '）';
    }
    记('P2 ⌘↵ 之后有新段落（仍编辑）或正常退出，⛔ 不许卡住',
      去向 === '新段落' || 去向 === '退出', 详情);
    // ⭐ 不管走哪条路，都必须**仍然退得出去**
    键(输入框() || document.body, 'Escape');
    let gone = await waitFor(function () { return !主机(); }, 4000);
    记('P2b ⌘↵ 之后 Esc 仍然退得出去（`bugs/0018` 的那条底线）', !!gone,
      gone ? '' : ('`Esc` 之后覆盖层还开着；状态条：' + 状态条()));
    await 收尾();

    // ── P3 点正文**空白处**（`#doc` 自己）也要退出 ────────────────────────
    host = await 进入(第一);
    if (host) {
      // ⚠️ 直接往 `#doc` 派发 ⇒ `ev.target` 就是它自己，`topChildOf` 恒 null，
      //    正是"点在块与块之间的空白上"那一种。
      点(d);
      gone = await waitFor(function () { return !主机(); }, 4000);
      记('P3 点正文空白处退出覆盖层', !!gone, gone ? '' : '点空白之后覆盖层还在');
    } else {
      记('P3 点正文空白处退出覆盖层', false, '第二次进不去；状态条：' + 状态条());
    }
    await 收尾();

    // ── P4 焦点**不在** textarea 上时，`Esc` 仍然退得出去 ─────────────────
    // ⚠️ 这一条量的是 `main.js::onLiveGlobalKey` 那条兜底：用户点过侧边栏 / 顶栏之后，
    //    焦点已经不在离屏输入框上，而覆盖层还开着 —— 没有兜底就**没有任何键能退出**。
    host = await 进入(第一);
    if (host) {
      ta = 输入框();
      try { if (ta) ta.blur(); } catch (e) { void e; }
      await frames(1);
      const ae2 = document.activeElement;
      const 已离开 = ae2 !== ta;
      键(document.body, 'Escape');
      gone = await waitFor(function () { return !主机(); }, 4000);
      记('P4 焦点离开输入框后 Esc 仍能退出', !!gone,
        (已离开 ? '' : '⚠️ 前提没建立：blur 之后焦点还停在 textarea 上；')
        + (gone ? '' : '按了 Esc 之后覆盖层还在'));
    } else {
      记('P4 焦点离开输入框后 Esc 仍能退出', false, '进不去；状态条：' + 状态条());
    }
    await 收尾();

    // ── P5/P6 提交之后点另一块 ──────────────────────────────────────────
    // ⚠️⚠️ 这一对量的是 `begin()` 里"先 `leave()` 再进入"那一段：`leave()` 会提交 ⇒
    //    `render_preview` ⇒ `mountDocument` ⇒ `#doc.innerHTML` **整棵换掉**
    //    ⇒ 调用方手里的块与节点**在那一刻就过期了**。
    if (第二 < 0) {
      摘要.P.切换 = '跳过（可编辑块不足 2 个）';
      return;
    }
    host = await 进入(第一);
    if (!host) {
      记('P5 提交之后点另一块：进得去', false, '第一块进不去；状态条：' + 状态条());
      return;
    }
    ta = 输入框();
    // ⚠️ **只敲一个字符、不敲换行**：行数不变 ⇒ 块表区间不动，后面拿"被点那一块"的源码
    //    做对照才成立（敲了换行，第二块的起始行就漂了，判据会红成"探针自己造成的"）。
    打字(ta, 'x');
    await frames(1);
    const 改后数 = d.children.length;
    const 旧host = 主机();
    点(d.children[第二]); // 这一下内部会先提交并重渲
    // ⚠️⚠️ 必须等**新的**那个：`leave()` 是异步的，旧的宿主此刻还挂在树上，
    //    直接 `waitFor(主机)` 会立刻把它交回来 ⇒ P5 假绿、P7 拿脱树节点比下标。
    const h2 = await waitFor(function () {
      const h = 主机();
      return h && h !== 旧host ? h : null;
    }, 4000);
    记('P5 提交之后点另一块：进得去', !!h2,
      h2 ? '' : ('状态条：' + 状态条() + '（修复前：脱树节点 ⇒ 几何闸门必拒 / 宿主挂不上去）'));
    // ⭐⭐ 多余节点：`swap.undo()` 记着的 `parent` 是 `#doc` 自己（不随 innerHTML 消失），
    //    `next` 却已脱树 ⇒ 走 `appendChild` 分支，把**旧块节点**追加到文末。
    //    ⚠️ 这条只有"改了字再退出"才看得见：不改 ⇒ 不提交 ⇒ 不重渲（B 段正是那样）。
    记('P6 提交重渲之后没有多余节点', d.children.length === 数,
      '孩子数 ' + 数 + ' → ' + d.children.length
      + (改后数 !== 数 ? '（敲字那一步就已经变了 ' + 改后数 + '）' : '')
      + (d.children.length === 数 ? '' : '——多出来的就是"旧块节点被追加到文末"'));
    // ⭐ 进去的必须是**被点的那一块**（不是第一块的残留、不是文末那份）。
    //    `#doc` 的孩子与 `p.blocks` 是 1:1 的（见 `诊断()` 的取法），所以直接比身份就够了。
    //    ⚠️ 这条在"节点过期"那一面是 P5 的补充：P5 只问"进不进得去"，
    //    过期节点也可能进得去（几何闸门碰巧放行），但进去的会是**错的那一块**。
    记('P7 进去的是被点的那一块', !!h2 && d.children[第二] === h2,
      '孩子[' + 第二 + '] ' + (d.children[第二] === h2 ? '就是宿主' : '≠ 宿主')
      + '；宿主实际下标 ' + Array.prototype.indexOf.call(d.children, h2)
      + '；宿主父链 ' + (function (n) {
        const out = [];
        for (let k = 0; n && k < 4; k++) {
          out.push(String(n.tagName || '?') + (n.id ? '#' + n.id : '')
            + (n.className ? '.' + String(n.className).split(' ').join('.') : ''));
          n = n.parentNode;
        }
        return out.join(' < ');
      })(h2)
      + '；孩子数 ' + d.children.length
      + '；孩子[' + 第二 + '] 的 class = "' + String((d.children[第二] && d.children[第二].className) || '') + '"'
      + '；宿主里首行「' + String((h2 && 块内文本(h2).split('\n')[0]) || '').slice(0, 30) + '」'
      + ' / 该块源首行「' + String(块源(第二).split('\n')[0] || '').slice(0, 30) + '」');

    await 收尾();
  }

  // ── Q 段：表格单元格（`design/0049`）──────────────────────────────────
  //
  // 答的是「点一格能不能改那**一格**」——这四类失效**全都上屏看不出来**：
  //   · 改的是**别的**格子（载荷区间与 DOM 错位一格）⇒ 屏幕上只是一格字变了；
  //   · 整行被重拼（两侧填充空格 / 相邻格子一起被写）⇒ 源码是另一份；
  //   · 竖线没转义 / 多转义一层 ⇒ 整张表下次解析就散架；
  //   · 列宽重算 ⇒ 表格跳一下，而等高校验量的是**块**（这里根本不在块级）。
  // ⇒ 每一条都要在**载荷字节**上判，⛔ 不是看屏幕上像不像。
  //
  // ⚠️ 只在夹具里**真有** Table 块时才产判据；否则 `摘要.Q = {适用:false}` 且
  //    **既不记通过也不记跳过**——"本轮到底验没验表格"由 `block-probe.sh` 的 `Q-覆盖` 把关。
  async function 跑单元格(base, 摘要) {
    const d = docEl();
    const p = window.__rmd.payload;
    const 原 = String((window.__FIXTURE || {}).text || '');

    let 表 = -1;
    for (let i = 0; i < p.blocks.length; i++) {
      if (p.block_kinds[p.blocks[i][0]] === 'Table') { 表 = i; break; }
    }
    if (表 < 0) { 摘要.Q = { 适用: false }; return; }

    /** 这张表在载荷里的格子区间：[line, from, to, writable]（行主序，与 DOM 同序）。 */
    let 区间 = null;
    const all = p.table_cells || [];
    for (let i = 0; i < all.length; i++) if (all[i][0] === 表) 区间 = all[i][1];
    摘要.Q = { 适用: true, 块: 表, 有区间: !!区间 };
    if (!区间) {
      // ⭐ 这条本身就是判据：载荷没带区间 ⇒ 产品会把整张表拒成"这一格改不了"。
      记('Q0 载荷里带着这张表的格子区间', false, 'table_cells 里没有块 ' + 表);
      return;
    }
    记('Q0 载荷里带着这张表的格子区间', true, 区间.length + ' 格');

    function 格() {
      const t = d.children[表];
      const out = [];
      if (!t || !t.rows) return out;
      for (let r = 0; r < t.rows.length; r++) {
        for (let c = 0; c < t.rows[r].cells.length; c++) out.push(t.rows[r].cells[c]);
      }
      return out;
    }
    function 单元格宿主() {
      const h = 主机();
      return h && h.classList && h.classList.contains('cm-rmd-cell') ? h : null;
    }
    function 列宽() { return 格().map(function (el) { return 四舍(el.getBoundingClientRect().width); }); }
    function 表高() { return 四舍(d.children[表].getBoundingClientRect().height); }
    /** 最近一次提交发给后端的全文（`render_preview` 的 `text` 参数）。 */
    function 提交文本() {
      const r = 最近一次('render_preview');
      return r && r.args && typeof r.args.text === 'string' ? r.args.text : null;
    }
    // ⚠️⚠️ **基线不是夹具原文**：Q 段排在 D/N/O/H/P 之后，那几段**真的**改过正文并提交过
    //    ⇒ 拿 `__FIXTURE.text` 当"旧文"，第一次提交就会多报一条"第 1 行变了"
    //    （2026-10-27 实测 `变行 [1,39]`：第 1 行是 H 段敲进去的字，与这一格无关）。
    //    ⇒ 基线 = **进入这一格之前**最近一次提交的全文；一次都没提交过才是夹具原文。
    const 底文 = 提交文本() || 原;
    function 原行(n) { return String(底文.split('\n')[n - 1] || ''); }

    const 宽0 = 列宽();
    const 高0 = 表高();
    const 下游0 = 几何();

    // ── ① 进入 ────────────────────────────────────────────────────
    const 格0 = 格();
    // ⚠️ 进入**之前**量那一格自己的高度：`Q2b` 量的是整张表，而"表高不变"可以被
    //    同一行别的格子撑着（2026-10-28 实测踩过）⇒ 逐格量才看得见那一格真的长高了。
    const 格高0 = 格0[0].getBoundingClientRect().height;
    点(格0[0]);
    const h1 = await waitFor(单元格宿主, 4000);
    if (!h1) {
      记('Q1 点格子进得去', false, '等不到 .cm-rmd-cell；状态条「' + 状态条() + '」');
      摘要.Q.进入 = false;
      return;
    }
    await frames(2);
    记('Q1 点格子进得去（宿主挂在那一格里）', h1.parentElement === 格0[0],
      h1.parentElement === 格0[0] ? '' : ('宿主父节点 ' + String(h1.parentElement && h1.parentElement.tagName)));

    // ⭐⭐ 2026-10-28 **用户实测之后补上的两条**：这一格现在还**看得见**吗。
    //    ⚠️⚠️ `Q1` 只判 `parentElement` —— `visibility: hidden` 的宿主**照样满足它**。
    //    真缺陷正是这一条：`swapLiveCell` 换进 `<td>` 时没有摘掉 `cm-rmd-offscreen`
    //    （`position: fixed; visibility: hidden; z-index: -1; pointer-events: none`）
    //    ⇒ 点一下，**格子里的字整片消失**、光标也画在离屏层里 ⇒ 用户的原话是
    //    「数据会消失，无法选中，无法编辑」。
    //    ⚠️ 它对 `Q2`/`Q2b` **结构性隐身**：列宽已被冻结（`table-layout: fixed` ＋ 逐列写死宽度）、
    //    同一行别的格子照常撑着行高 ⇒ 两条都绿。`Q3`–`Q5d` 读的是 `.cm-content` 的文本，
    //    离屏的视图**文本一模一样** ⇒ 也全绿。
    const 宿主样式 = window.getComputedStyle(h1);
    记('Q1b 宿主换进文档流后不再离屏（那一格看得见）',
      宿主样式.visibility === 'visible' && 宿主样式.position !== 'fixed'
        && h1.getBoundingClientRect().height > 0,
      'visibility=' + 宿主样式.visibility + ' position=' + 宿主样式.position
        + ' 高=' + 四舍(h1.getBoundingClientRect().height) + ' px');
    // ⚠️ 第二条走**几何**而不是 `innerText`：`visibility: hidden` 的元素**照样有布局盒**，
    //    `innerText` 在 Blink/WebKit 里会把它算进去 ⇒ 拿它判会把这一条做成**恒绿**的假判据
    //    （"判据不敏感"与"产品没坏"输出一模一样，`tests.md` 变异那一段的第一种坑）。
    //    ⇒ 量宿主**画在哪**：离屏形态是 `position: fixed; top:0; left:0`
    //    （⇒ 盒子的视口坐标恒在左上角，与 `<td>` 的盒子不重叠）；换进文档流之后它落在 `<td>` 里。
    //    ⚠️ 与滚动位置无关（两条都是视口坐标），所以表格滚出视口也不会假红。
    const rt = 格0[0].getBoundingClientRect();
    const rh = h1.getBoundingClientRect();
    const 在格内 = rh.width > 0 && rh.height > 0
      && rh.top >= rt.top - 1 && rh.top < rt.bottom
      && rh.left >= rt.left - 1 && rh.left < rt.right;
    记('Q1c 宿主真的画在那一格里（⛔ 不是画在视口左上角）', 在格内,
      '宿主 rect=' + JSON.stringify({ t: 四舍(rh.top), l: 四舍(rh.left), w: 四舍(rh.width) })
        + ' / 格子 rect=' + JSON.stringify({ t: 四舍(rt.top), l: 四舍(rt.left), w: 四舍(rt.width) }));

    // ⭐ `Q1d`：**那一格自己**的高度不许变（`INV-CELL-04`）。
    //    ⚠️ `Q2b` 量的是整张表 ⇒ 同一行**别的格子**会把行高撑住，这一格长高了它也绿
    //    （2026-10-28 首次真跑就是这样：表高 **+12 px** 是 `Q2b` 抓到的，而"哪一格长的"
    //     只有逐格量才知道）。⇒ 两条并存，⛔ 别拿 `Q2b` 替代它。
    const 格高1 = 格0[0].getBoundingClientRect().height;
    记('Q1d 那一格自身的高度不变（宿主的行盒与文字行等高）', Math.abs(格高1 - 格高0) <= 1,
      '格高 ' + 四舍(格高0) + ' → ' + 四舍(格高1) + ' px；宿主 display=' + 宿主样式.display
        + ' vertical-align=' + 宿主样式.verticalAlign
        + ' 高=' + 四舍(rh.height) + ' 行高=' + 宿主样式.lineHeight
        + ' / 格 line-height=' + window.getComputedStyle(格0[0]).lineHeight);

    // ── ② 布局逐像素不跳（`INV-CELL-04`）──────────────────────────
    const 宽1 = 列宽();
    let 最大宽差 = 0;
    for (let i = 0; i < Math.max(宽0.length, 宽1.length); i++) {
      最大宽差 = Math.max(最大宽差, Math.abs((宽0[i] || 0) - (宽1[i] || 0)));
    }
    记('Q2 进入后每列宽度逐像素不变', 最大宽差 <= 1,
      最大宽差 <= 1 ? ('最大 ΔW ' + 四舍(最大宽差) + ' px') : ('最大 ΔW ' + 四舍(最大宽差) + ' px；前 ' + JSON.stringify(宽0) + ' 后 ' + JSON.stringify(宽1)));
    const 高1 = 表高();
    // ⚠️ 诊断行：`.doc table` 是 `display:block; overflow-x:auto`，而 `style.css` 有一条
    //    **全局经典滚动条** `::-webkit-scrollbar { height: 12px }` ⇒ 只要表比格子宽出一点点，
    //    就会长出一条**吃掉 12 px 高**的横向滚动条（`clientHeight` 不含它、`offsetHeight` 含）。
    //    这一行就是用来把"是滚动条还是行盒"一次分开的。
    const 表盒 = d.children[表];
    // ⚠️ 这行诊断把「高度差」拆成两件事：`clientH`（内容高度）与 `offsetH`（边框盒，
    //    含横向滚动条）。二者差 12 px ＝ `style.css` 那条全局 `::-webkit-scrollbar { height: 12px }`
    //    被分配给了 `.doc table`（`overflow-x: auto`）——`bugs/0027` 就是它。
    //    ⛔ 不要在这里**改 DOM 再量**（比如临时 `display:none` 二分子树）：那会强制重排，
    //    把"滞留的滚动条"清掉，量出来的就不是用户看到的那一帧了（2026-10-28 踩过）。
    const 表诊断 = ' table clientW ' + 表盒.clientWidth + ' scrollW ' + 表盒.scrollWidth
      + ' clientH ' + 表盒.clientHeight + ' offsetH ' + 表盒.offsetHeight
      + ' overflowX ' + window.getComputedStyle(表盒).overflowX
      + ' box-sizing ' + window.getComputedStyle(表盒).boxSizing
      + ' style.width "' + 表盒.style.width + '"'
      + ' 宿主 overflow ' + 宿主样式.overflowX + '/' + 宿主样式.overflowY;
    记('Q2b 进入后表格高度不变', Math.abs(高1 - 高0) <= 1,
      'ΔH ' + 四舍(高1 - 高0) + ' px（前 ' + 高0 + ' / 后 ' + 高1 + '）' + 表诊断);
    const 下游1 = 下游最大位移(下游0, 几何(), 表 + 1);
    记('Q2c 表格之后的块零位移', 下游1 <= TOL, '最大 ' + 四舍(下游1) + ' px');
    记('Q2d 列宽真的被冻结了（table-layout: fixed）',
      String(d.children[表].style.tableLayout) === 'fixed',
      'table.style.tableLayout = "' + String(d.children[表].style.tableLayout) + '"');

    const ta = 输入框();
    if (!ta) { 记('Q3 离屏输入框在', false, '找不到 ' + INPUT_SEL); return; }

    // ── ③ 视图里那行源码 == 载荷区间切出来的那一格 ──────────────────
    // ⚠️ 这一条把「后端算的列」与「前端拿到的那一格」钉在一起：错一格这里必红。
    const span = 区间[0];
    const 视0 = 块全文(h1);
    const 应0 = 原行(span[0]).slice(span[1], span[2]);
    记('Q3 格子里就是那一格的源码（区间与 DOM 同序）', 视0 === 应0,
      '视图「' + 视0.slice(0, 24) + '」/ 区间切出「' + 应0.slice(0, 24) + '」');

    // ── ④ 组合期：文档一个字节都不动 ⊕ 组合串画在覆盖层上 ─────────────
    let 组合变了 = '';
    组合(ta, 'compositionstart', '');
    const 串 = ['n', 'ni', 'nih'];
    for (let k = 0; k < 串.length; k++) {
      组合(ta, 'compositionupdate', 串[k]);
      await frames(1);
      if (!组合变了 && 块全文(h1) !== 视0) 组合变了 = '第 ' + (k + 1) + ' 个中间态';
    }
    记('Q4 组合期格子源码一个字节不动', 组合变了 === '',
      组合变了 ? ('已经从「' + 视0.slice(0, 16) + '」变成「' + 块全文(h1).slice(0, 16) + '」（' + 组合变了 + '）') : '');
    const pre = h1.querySelector('.cm-rmd-preedit');
    记('Q4b 组合串画在覆盖层上', !!pre && (pre.textContent || '').indexOf('nih') >= 0,
      pre ? ('覆盖层文本「' + (pre.textContent || '').slice(0, 16) + '」') : '没有 .cm-rmd-preedit');
    // ⚠️ 取消组合（⛔ 不落进文档）：否则下面那条"提交"会带上这半截串。
    组合(ta, 'compositionend', '');
    await frames(1);

    // ── ⑤ 打字 ＋ ⌘↵ 提交：**只**改那一行的那一格 ────────────────────
    const 提交前 = 块全文(h1);
    打字(ta, '甲');
    await frames(1);
    const 打字后 = 块全文(h1);
    记('Q5 打的字落进格子视图', 打字后 !== 提交前, '长度 ' + 提交前.length + ' → ' + 打字后.length);
    const 次0 = 计数('render_preview');
    键(ta, 'Enter', { meta: true });
    const 走1 = await waitFor(function () { return !主机(); }, 4000);
    const 等到1 = await waitFor(function () { return 计数('render_preview') > 次0; }, 4000);
    记('Q5b ⌘↵ 退出并提交', !!走1 && !!等到1 && !!提交文本(),
      '宿主 ' + (走1 ? '已摘' : '还在') + ' / render_preview +' + (计数('render_preview') - 次0));
    if (提交文本()) {
      const 新 = 提交文本().split('\n');
      // ⚠️ 与 `底文` 比（⛔ 不是夹具原文）：前面那些段已经改过正文，见 `底文` 的注释。
      const 旧 = 底文.split('\n');
      const 变行 = [];
      for (let i = 0; i < Math.max(新.length, 旧.length); i++) if (新[i] !== 旧[i]) 变行.push(i + 1);
      const 应行 = 旧[span[0] - 1].slice(0, span[1]) + 打字后 + 旧[span[0] - 1].slice(span[2]);
      记('Q5c 提交只动了那一行', 变行.length === 1 && 变行[0] === span[0] && 新.length === 旧.length,
        变行.length === 1 && 变行[0] === span[0] && 新.length === 旧.length
          ? '' : ('变行 ' + JSON.stringify(变行) + ' / 行数 ' + 旧.length + ' → ' + 新.length
            + ' / 期望第 ' + span[0] + ' 行'));
      记('Q5d 改的正是那一格（两侧填充逐字节不变）', 新[span[0] - 1] === 应行,
        '得到「' + String(新[span[0] - 1] || '').slice(0, 60) + '」/ 期望「' + 应行.slice(0, 60) + '」');
    }
    // ⚠️ 假后端不渲染 Markdown ⇒ 提交之后 DOM 回到**原件**（那是探针的限制）。
    //    ⇒ 后面的判据一律**重新取节点**，⛔ 不要拿 `h1` / `格0` 再来一次。

    // ── ⑥ `|` 转义（`INV-CELL-02`）：敲一个竖线提交出去必须带反斜杠 ─────
    const 格6 = 格();
    if (格6.length) {
      点(格6[0]);
      const h6 = await waitFor(单元格宿主, 4000);
      if (!h6) {
        记('Q6 `|` 转义', false, '第二次进不去：' + 状态条());
      } else {
        await frames(1);
        const 次6 = 计数('render_preview');
        打字(输入框(), 'x|y');
        await frames(1);
        键(输入框(), 'Enter', { meta: true });
        const 走6 = await waitFor(function () { return !主机() && 计数('render_preview') > 次6; }, 4000);
        const 文6 = 提交文本();
        const 行6 = 文6 ? String(文6.split('\n')[span[0] - 1] || '') : '';
        记('Q6 竖线提交出去是 `\\|`（⛔ 不撑坏表格）', !!走6 && 行6.indexOf('x\\|y') >= 0,
          走6 ? ('那一行「' + 行6.slice(0, 60) + '」') : '提交没发生');
      }
    }

    // ── ⑦ Tab：同一行往右一格（⛔ 不环绕）────────────────────────────
    const 格7 = 格();
    if (格7.length >= 2) {
      点(格7[0]);
      const h7 = await waitFor(单元格宿主, 4000);
      if (!h7) {
        记('Q7 Tab 走格', false, '进不去：' + 状态条());
      } else {
        await frames(1);
        键(输入框(), 'Tab');
        const 到1 = await waitFor(function () {
          const h = 单元格宿主();
          return h && h.parentElement === 格()[1];
        }, 4000);
        const hh = 单元格宿主();
        记('Q7 Tab 走到右边那一格（同一行）', !!到1,
          到1 ? '' : ('宿主现在在 ' + String(hh && hh.parentElement && hh.parentElement.tagName)
            + ' cellIndex=' + String(hh && hh.parentElement && hh.parentElement.cellIndex)));
        // ── ⑧ Enter：**格内换行**（`bugs/0035`，2026-10-28 用户需求变更）──────────
        //  ⚠️⚠️ 这里原先判的是"走到下一行的同一列"（`design/0049` §4 的旧口径）。
        //     用户原话「表格编辑还是不能换行，enter 键无法换到下一行，直接到表格的下一行中了」
        //     ⇒ 现在 `Enter` 换行、`Tab` 走格。审查判据若不跟着改，"按 Enter 走格"这个
        //     **已经不需要的行为**会继续被当成正确，真缺陷反而绿着。
        if (到1) {
          const h8 = 单元格宿主();
          const 前格8 = h8 && h8.parentElement;
          const 行0 = 视图行数(h8);
          键(输入框(), 'Enter');
          await frames(2);
          const h8b = 单元格宿主();
          const 行1b = 视图行数(h8b);
          记('Q8 Enter 在格内换行（视图 2 行、⛔ 不走到下一行）',
            !!h8b && h8b.parentElement === 前格8 && 行1b === 行0 + 1,
            '视图行数 ' + 行0 + ' → ' + 行1b
              + '；宿主换格了=' + String(!h8b || h8b.parentElement !== 前格8));
          // 复原：⌘Z 把这次换行撤掉，后面的判据仍在"一行"的格子上跑
          键(输入框(), 'z', { meta: true });
          await frames(2);
        }
        // ── ⑨ 最后一格按 Tab ⇒ 退出覆盖层（端点⛔ 不环绕）──────────────
        const 格9 = 格();
        点(格9[格9.length - 1]);
        const h9 = await waitFor(单元格宿主, 4000);
        if (!h9) {
          记('Q9 最后一格 Tab 退出', false, '进不去最后一格：' + 状态条());
        } else {
          await frames(1);
          键(输入框(), 'Tab');
          const 走了 = await waitFor(function () { return !主机(); }, 4000);
          记('Q9 最后一格按 Tab 退出覆盖层（⛔ 不环绕）', !!走了, 走了 ? '' : '宿主还在');
        }
      }
    }

    // ── ⑨b 删除 / 粘贴 / 复制 / 剪切 / 撤销 ──────────────────────────────
    //
    // ⭐ 2026-10-28 用户「举一反三，把表格相关的编辑，删除，复制，换行等功能，重点测试」。
    //
    // ⚠️ 为什么这一组必须存在：`0052` U0 的能力矩阵里**表格格**那一列在
    //    「`⌫` 删除」「`⌦` 前向删除」「选区 ＋ 删除」「粘贴多行」四行上全是 `未测`——
    //    Q 段此前只测「打的字落进格子」（`Q5`）与「`|` 转义」（`Q6`）。
    //    而删除／粘贴恰恰是**唯一能让写回跨出这一格**的动作：越界一个字节，
    //    屏幕上这一格的字**照样正常**（`INV-CELL-01` 的失效形态）。
    // ⚠️ 判据一律落在**提交出去的字节**上（⛔ 不看屏幕上像不像），并且每条都同时判
    //    「只有这一行变了」「行数没变」——粘进来一个换行会把表格行拆成两行。
    // ⚠️⚠️ 每条判据都自己进格、自己退出：提交之后 DOM 是新的，⛔ 不许复用上一个 `host`。

    /** 最近一次提交的全文（一次都没提交过 ⇒ 夹具原文）。 */
    function 全文() { return 提交文本() || 底文; }

    /**
     * ⭐ 一行表格的**格子内容区间**：**直接调假后端那一份**（`fake-tauri.js::切格`）。
     *
     * ⚠️ 为什么不在这里再写一遍：`Q` 段要判"这一格在一行里是第几个"，而同一行里
     *    `单元格` 出现三次 ⇒ `indexOf` 恒取第一处、判据会判到**隔壁格**上去；
     *    而"切法"与假后端重算列用的必须是**同一个函数**，否则两处口径漂了以后
     *    「判据说红了」与「探针自己算歪了」输出一模一样（`tests.md` 变异那一段的第一种坑）。
     */
    function 行格区间(行号) {
      const 行 = String(全文().split('\n')[行号 - 1] || '');
      const 切 = window.__FAKE && window.__FAKE.切格;
      return { 行: 行, 格们: 切 ? 切(行, 行格数(行号)) : [] };
    }

    /** 载荷里**这一行**有几格（行主序的扁平数组里数同行的）。 */
    function 行格数(行号) {
      let n = 0;
      for (let i = 0; i < 区间.length; i++) if (区间[i][0] === 行号) n++;
      return n;
    }

    /**
     * 那一格**此刻**在当前全文里的列区间。
     * ⚠️ 不能用载荷里的 `区间[idx]`：`Q5`/`Q6` 已经改过格子内容，列偏移早就漂了
     *    （`INV-CELL` 那一族的偏移风险正是从这里来的）。⇒ 在当前行的文本上**重算**。
     */
    function 现区间(idx) {
      const 行号 = 区间[idx][0];
      let k = 0;
      for (let i = 0; i < idx; i++) if (区间[i][0] === 行号) k++;
      const { 行, 格们 } = 行格区间(行号);
      const g = 格们[k];
      if (!g) return null;
      return { line: 行号, from: g[0], to: g[1], text: 行.slice(g[0], g[1]), 行: 行 };
    }

    /** 进第 `idx` 格；拿不到宿主／输入框 ⇒ `null`（调用方如实记失败，⛔ 不跳过）。 */
    async function 进格(idx) {
      const g = 格();
      if (!g.length || idx < 0 || idx >= g.length) return null;
      const 次 = 计数('render_preview');
      点(g[idx]);
      const host = await waitFor(单元格宿主, 4000);
      if (!host) return null;
      await frames(1);
      const ta = 输入框();
      return ta ? { host: host, ta: ta, 次: 次, idx: idx } : null;
    }

    /** `⌘↵` 提交并退出。返回 `{走, 提交}`（`提交` = 这一下真的多发了几次 `render_preview`）。 */
    async function 提交退出(t) {
      键(t.ta, 'Enter', { meta: true });
      const 走 = await waitFor(function () { return !主机(); }, 4000);
      await frames(1);
      return { 走: !!走, 提交: 计数('render_preview') - t.次 };
    }

    /**
     * ⭐⭐ **测试替身的那一笔账**（2026-10-28）：假后端本来不回重算后的 `table_cells`。
     *
     * 真后端在打开与 `render_preview` 两条路上都会**重算**格子区间
     * （`commands/document.rs` 与 `commands/edit.rs` 同口径，`blocks::table_cells`）；
     * 假后端只把 Stage A 导出的那份原件再回一遍 ⇒ 一旦 Q 段改了一格，
     * **同一行后面那些格子的列区间就全错位**，下一次进格读到的就是隔壁的字节。
     * 首次真跑的形态：`Q12` 里"格首 ⌫"明明一个字节都没删，提交出去的全文却变了——
     * 那是**探针**的错位，⛔ 不是产品的。
     *
     * ✅ 修法在**假后端那一侧**（`fake-tauri.js::重算格子`）：`render_preview` 拿到请求里的
     *    `text` 就按它重算列区间——与真后端**同一个触发点**。
     *    ⚠️ ⛔ 别改回"由 harness 在每次提交后自己补一遍"：那样 Q 段里**每一处**提交
     *    （`Q5b`/`Q6`/`Q7`/`Q8`/`Q9` 都提交）都得记得补，漏一处就静默错位——
     *    判据读起来仍然是"产品把字写错了"。
     */

    /** 一次编辑动作之后，在字节层核对"只有这一行变了、而且只变了这一格"。 */
    function 字节核对(前文, 区, 应格文, 说明) {
      if (!区) return { ok: false, msg: '定位不到那一格的列区间' };
      const 新 = 全文().split('\n');
      const 旧 = 前文.split('\n');
      const 应行 = 区.行.slice(0, 区.from) + 应格文 + 区.行.slice(区.to);
      const 变行 = [];
      for (let i = 0; i < Math.max(新.length, 旧.length); i++) if (新[i] !== 旧[i]) 变行.push(i + 1);
      const 行数同 = 新.length === 旧.length;
      const 只这行 = 变行.length === 0 || (变行.length === 1 && 变行[0] === 区.line);
      const 行对 = String(新[区.line - 1] || '') === 应行;
      return {
        ok: 行数同 && 只这行 && 行对,
        msg: (行对 ? '' : ('得到「' + String(新[区.line - 1] || '').slice(0, 60)
          + '」/ 期望「' + 应行.slice(0, 60) + '」'))
          + (行数同 ? '' : (' / 行数 ' + 旧.length + ' → ' + 新.length))
          + (只这行 ? '' : (' / 变行 ' + JSON.stringify(变行)))
          + (说明 ? '；' + 说明 : ''),
      };
    }

    // ── `Q11` 选区 ＋ 删除：`⌘A` ＋ `⌫` 只清空**这一格** ────────────────
    {
      const t = await 进格(0);
      if (!t) {
        记('Q11 格内 ⌘A ＋ ⌫ 清空这一格', false, '进不去：' + 状态条());
      } else {
        const 区 = 现区间(0);
        const 前文 = 全文();
        键(t.ta, 'a', { meta: true });
        await frames(1);
        键(t.ta, 'Backspace');
        await frames(1);
        const 视图空 = 块全文(t.host) === '';
        const r = await 提交退出(t);
        const 核 = 字节核对(前文, 区, '', '提交 +' + r.提交);
        记('Q11 格内 ⌘A ＋ ⌫ 只清空**这一格**（两侧填充与隔壁格逐字节不变）',
          视图空 && !!r.走 && 核.ok,
          (视图空 ? '' : ('视图没清空，还剩「' + 块全文(主机() || t.host).slice(0, 24) + '」'))
            + (r.走 ? '' : '；宿主没摘掉') + (核.msg ? '；' + 核.msg : ''));
      }
    }

    // ── `Q12` 格首 `⌫`、`Q13` 格尾 `⌦`：**⛔ 不越界** ─────────────────────
    //  ⚠️ 这是"跨出这一格"最容易发生的一处：真按下去，左边那根 `|` 或隔壁格的末字
    //     会少一个字节，而屏幕上这一格看起来**一切正常**。
    for (const 项 of [
      { id: 'Q12', 键名: 'Home', 删键: 'Backspace', 名: '格首 ⌫ 不越界（⛔ 不吃掉左边那根竖线／隔壁格）' },
      { id: 'Q13', 键名: 'End', 删键: 'Delete', 名: '格尾 ⌦ 不越界（⛔ 不吃掉右边那根竖线／隔壁格）' },
    ]) {
      const t = await 进格(1);
      if (!t) {
        记(项.id + ' ' + 项.名, false, '进不去：' + 状态条());
      } else {
        const 前文 = 全文();
        const 区 = 现区间(1);
        const 视0b = 块全文(t.host);
        键(t.ta, 项.键名);
        await frames(1);
        键(t.ta, 项.删键);
        await frames(1);
        const 视图未变 = 块全文(t.host) === 视0b;
        const r = await 提交退出(t);
        记(项.id + ' ' + 项.名, 视图未变 && 全文() === 前文,
          (视图未变 ? '' : ('视图变了：「' + 视0b + '」→「' + 块全文(主机() || t.host) + '」'))
            + (全文() === 前文 ? '' : '；提交出去的全文变了')
            + (r.走 ? '' : '；宿主没摘掉'));
      }
    }

    // ── `Q14` 粘贴多行：格内**保留**两行，提交成 `<br>` ──────────────────
    //  ⚠️⚠️ **2026-10-28 用户需求变更**（`bugs/0035`，原话「表格编辑还是不能换行，enter 键
    //     无法换到下一行，直接到表格的下一行中了」）：单元格**不再是单行**。
    //     视图里是 `\n`、源码里是 `<br>`（`cell.js::encode`/`decode` 一对逆变换）。
    //  ⚠️ 旧判据（「粘贴两行 ⇒ 折成一行」＋「这一格高度不变」）**已整体作废**：
    //     它把"格内不能换行"钉死，而那正是用户要推翻的那件事。留着会让真缺陷绿着。
    //  ⚠️ 现在的判据回答三个不同的问题：
    //     ① 视图里**两行都真的在**（`input.js` 的 `CELL.text` 是恒等 ⇒ 入口不许再折）；
    //     ② 排出来的高度 == **同一串字（带 `<br>`）在阅读态**的高度（oracle 与产品无关）；
    //     ③ 提交出去的是 **一个 `<br>`**（⛔ 不是空格、⛔ 不是把表格行拆成两行），
    //        并且**再点进这一格仍是两行**——那一条专盯 `decode`（少了它，用户会看到字面的 `<br>`）。
    {
      const t = await 进格(1);
      if (!t) {
        记('Q14 粘贴两行仍保留两行（格内可换行）', false, '进不去：' + 状态条());
      } else {
        const 区 = 现区间(1);
        const 前文 = 全文();
        const 格盒 = t.host.parentElement;
        const 高0b = t.host.getBoundingClientRect().height;
        键(t.ta, 'End');
        await frames(1);
        let 合成说明 = '';
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', '甲\n乙');
          t.ta.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt, bubbles: true, cancelable: true,
          }));
        } catch (e) { 合成说明 = '⚠️ 探针合成不了 ClipboardEvent／DataTransfer：' + (e && e.message); }
        await frames(2);
        const 视文 = 块全文(t.host);
        const 编高 = t.host.getBoundingClientRect().height;
        const 量 = 阅读态量(格盒, 视文);
        const 应高 = 量.高;
        const 应视 = (区 ? 区.text : '') + '甲\n乙';
        记('Q14b 粘贴两行：视图里**两行都在**，且高度 == 同一串字在阅读态的高度'
          + '（⛔ 不是折成一行、也不是先排出两行再缩回）',
          视文 === 应视 && 应高 > 0 && Math.abs(编高 - 应高) <= 1,
          '内容高 编辑 ' + 四舍(编高) + ' / 阅读形态 ' + 四舍(应高) + ' px'
            + '（宽 编辑 ' + 四舍(t.host.getBoundingClientRect().width)
            + ' / 阅读 ' + 四舍(量.宽) + '，格 ' + 四舍(量.格宽) + '）'
            + '（粘贴前 ' + 四舍(高0b) + '；视图行数 ' + 视图行数(t.host) + '）'
            + '；视图「' + 视文.replace(/\n/g, '⏎').slice(0, 32) + '」'
            + (视文 === 应视 ? '' : '（应「' + 应视.replace(/\n/g, '⏎').slice(0, 32) + '」）')
            + (合成说明 ? '；' + 合成说明 : ''));
        const r = await 提交退出(t);
        const 核 = 字节核对(前文, 区, (区 ? 区.text : '') + '甲<br>乙', '提交 +' + r.提交);
        记('Q14 粘贴两行 ⇒ 提交成一个 `<br>`（⛔ 不是空格，⛔ 不把表格行拆开）',
          !!r.走 && 核.ok, (r.走 ? '' : '宿主没摘掉；') + 核.msg
            + (合成说明 ? '；' + 合成说明 : ''));
        // ⭐ 再点进同一格：源码是 `<br>`、视图必须还原成换行（`cell.js::decode` 的承重点）
        const t2 = await 进格(1);
        const 复视 = t2 ? 块全文(t2.host) : null;
        if (t2) { 键(t2.ta, 'Escape'); await waitFor(function () { return !主机(); }, 4000); }
        await frames(1);
        记('Q14c 提交之后再点进这一格：视图仍是**两行**（⛔ 不是字面的 `<br>`）',
          !!t2 && 复视 === 应视,
          t2 ? ('视图「' + String(复视).replace(/\n/g, '⏎').slice(0, 32) + '」'
            + (复视 === 应视 ? '' : '（应「' + 应视.replace(/\n/g, '⏎') + '」）'))
            : ('再进不去：' + 状态条()));
      }
    }

    // ── `Q15` 连续两次提交：列区间**跟着内容走**（陈旧区间会把字写重） ─────
    //  ⚠️ 失效形态：提交后不更新 `a.cell.to` ⇒ `stillDirty` 判"还脏" ⇒ 补一次提交时
    //     拿旧区间去 splice 新内容 ⇒ 这一格末尾的字**被写两遍**。屏幕上照样正常。
    {
      const t = await 进格(1);
      if (!t) {
        记('Q15 连提两次（区间跟内容走）', false, '进不去：' + 状态条());
      } else {
        const 区 = 现区间(1);
        const 前文 = 全文();
        键(t.ta, 'End');
        await frames(1);
        打字(t.ta, '甲乙丙');
        await frames(2);
        // ⚠️ `Tab` 会**先提交再进下一格**（`main.js::navigateCell` → `live.begin`）
        键(t.ta, 'Tab');
        await frames(3);
        const 核 = 字节核对(前文, 区, (区 ? 区.text : '') + '甲乙丙', '');
        记('Q15 Tab 走格时先提交：连提两次也不把字写重（区间跟着内容走）', 核.ok, 核.msg);
        // 收尾：Tab 之后停在下一格（或已退出）⇒ 明确退出，⛔ 别把编辑态留给 `Q10`
        const hh = 单元格宿主();
        if (hh) {
          const ta2 = 输入框();
          if (ta2) { 键(ta2, 'Escape'); await waitFor(function () { return !主机(); }, 4000); }
        }
        await frames(1);
      }
    }

    // ── `Q16` 复制：带出去的是**这一格**的字，且文档一个字节不动 ────────────
    {
      const t = await 进格(0);
      if (!t) {
        记('Q16 格内 ⌘A ＋ 复制', false, '进不去：' + 状态条());
      } else {
        const 前文 = 全文();
        const 应文 = 块全文(t.host);
        键(t.ta, 'a', { meta: true });
        await frames(1);
        let 带走 = null;
        let 合成说明 = '';
        try {
          const dt = new DataTransfer();
          t.ta.dispatchEvent(new ClipboardEvent('copy', {
            clipboardData: dt, bubbles: true, cancelable: true,
          }));
          带走 = dt.getData('text/plain');
        } catch (e) { 合成说明 = '⚠️ 探针合成不了 ClipboardEvent／DataTransfer：' + (e && e.message); }
        await frames(1);
        const 次0c = 计数('render_preview');
        键(t.ta, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
        记('Q16 格内 ⌘A ＋ 复制带走的是**这一格**的字，且文档一个字节不动',
          带走 === 应文 && 全文() === 前文 && 计数('render_preview') === 次0c,
          '带走「' + String(带走 === null ? '（读不到）' : 带走).slice(0, 32) + '」/ 应为「'
            + 应文.slice(0, 32) + '」' + (全文() === 前文 ? '' : '；文档被改了')
            + (计数('render_preview') === 次0c ? '' : '；复制竟然触发了提交（render_preview +'
              + (计数('render_preview') - 次0c) + '）')
            + (合成说明 ? '；' + 合成说明 : ''));
      }
    }

    // ── `Q17` 剪切：带走这一格的字 ＋ 只清空这一格 ────────────────────────
    {
      const t = await 进格(0);
      if (!t) {
        记('Q17 格内 ⌘A ＋ 剪切', false, '进不去：' + 状态条());
      } else {
        const 区 = 现区间(0);
        const 前文 = 全文();
        const 应文 = 块全文(t.host);
        键(t.ta, 'a', { meta: true });
        await frames(1);
        let 带走 = null;
        let 合成说明 = '';
        try {
          const dt = new DataTransfer();
          t.ta.dispatchEvent(new ClipboardEvent('cut', {
            clipboardData: dt, bubbles: true, cancelable: true,
          }));
          带走 = dt.getData('text/plain');
        } catch (e) { 合成说明 = '⚠️ 探针合成不了 ClipboardEvent／DataTransfer：' + (e && e.message); }
        await frames(1);
        const 视图空 = 块全文(t.host) === '';
        const r = await 提交退出(t);
        const 核 = 字节核对(前文, 区, '', '提交 +' + r.提交);
        记('Q17 格内 ⌘A ＋ 剪切：带走原来的字，且只清空这一格',
          带走 === 应文 && 视图空 && !!r.走 && 核.ok,
          '带走「' + String(带走 === null ? '（读不到）' : 带走).slice(0, 32) + '」/ 应为「'
            + 应文.slice(0, 32) + '」' + (视图空 ? '' : '；视图没清空')
            + (核.msg ? '；' + 核.msg : '') + (合成说明 ? '；' + 合成说明 : ''));
      }
    }

    // ── `Q18` 格内撤销：`⌘Z` 之后提交出去必须是**原样** ────────────────────
    {
      const t = await 进格(0);
      if (!t) {
        记('Q18 格内 ⌘Z', false, '进不去：' + 状态条());
      } else {
        const 前文 = 全文();
        const 区 = 现区间(0);
        const 原样 = 块全文(t.host);
        键(t.ta, 'End');
        await frames(1);
        打字(t.ta, '甲');
        await frames(1);
        const 变过 = 块全文(t.host) !== 原样;
        键(t.ta, 'z', { meta: true });
        await frames(2);
        const 收回 = 块全文(t.host) === 原样;
        const r = await 提交退出(t);
        记('Q18 格内 ⌘Z 收回原样，提交出去也逐字节是原样',
          变过 && 收回 && !!r.走 && 全文() === 前文,
          (变过 ? '' : '打字没落进视图') + (收回 ? '' : ('；没收回来：「' + 块全文(主机() || t.host).slice(0, 32) + '」'))
            + (全文() === 前文 ? '' : '；提交出去的全文变了') + (r.走 ? '' : '；宿主没摘掉'));
      }
    }

    // ── `Q19` 方向键：←/→ **连续**移动（⛔ 只动一次就卡住）────────────────────
    //  ⚠️ 2026-10-28 用户实测：「表格内的输入无法换行，上下左右箭头，也没有用」。
    //    此前 Q 段**一条方向键判据都没有**：`Q12`/`Q13` 里按的 `Home`/`End` 只当"把光标
    //    挪到边上"的准备工作，它们**做了什么**从来没被量过 ⇒ 那两个键按下去毫无反应，
    //    判据照样绿。
    //  ⚠️⚠️ 必须**连按两次**：`main.js` 里方向键走的是模块内那个 `sel` 镜像，
    //    它由 `EditorView.updateListener` 的 `afterUpdate()` 同步——一旦哪次改动把那条
    //    同步打断，形态就是"第一次动一格、之后再也不动"（陈旧 `sel` 每次都算出同一个目标）。
    //    ⛔ 只按一次判不出来。
    {
      const t = await 进格(1);
      if (!t) {
        记('Q19 格内 ←/→ 连续移动光标', false, '进不去：' + 状态条());
      } else {
        const V = 视图(t.host);
        const 读头 = function () {
          return V && V.state && V.state.selection ? V.state.selection.main.head : -1;
        };
        键(t.ta, 'End');
        await frames(1);
        const h0 = 读头();
        键(t.ta, 'ArrowLeft');
        await frames(1);
        const h1 = 读头();
        键(t.ta, 'ArrowLeft');
        await frames(1);
        const h2 = 读头();
        键(t.ta, 'ArrowRight');
        await frames(1);
        const h3 = 读头();
        键(t.ta, 'Home');
        await frames(1);
        const h4 = 读头();
        const 够长 = h0 >= 3;
        记('Q19 格内 ←/→ **连续**移动光标（⛔ 只动一次就卡住）；Home 真的回到格首',
          够长 && h1 === h0 - 1 && h2 === h0 - 2 && h3 === h0 - 1 && h4 === 0,
          'End→' + h0 + '，←→' + h1 + '，←→' + h2 + '，→→' + h3 + '，Home→' + h4
            + '；应为 ' + h0 + '/' + (h0 - 1) + '/' + (h0 - 2) + '/' + (h0 - 1) + '/0'
            + (够长 ? '' : '（这一格内容太短，判不了 ←/→：' + h0 + ' 个码元）'));
        键(t.ta, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
      }
    }

    // ── `Q20` 长内容：**在格子里软换行**，光标始终看得见 ──────────────────
    //  ⚠️ 2026-10-28 用户原话「表格内的输入无法换行」：单元格视图此前**故意不装软换行**
    //    （`makeLiveView` 的 `if (!code && !isCell)`），而 `.cm-rmd-cell` 又
    //    `overflow-x: clip` ⇒ 比列宽的那串字**在右边缘被整段切断**，光标跑出去之后
    //    连"我现在打到哪儿"都看不见——用户说的既是"不换行"，也是"箭头没用"
    //    （箭头其实在动，动到看不见的地方去了）。
    //  ⚠️ 判据落在**三件独立的事实**上，⛔ 不看"屏幕上像不像"：
    //    ① 视觉行数 ≥ 2（`Range.getClientRects()` 数的是**行盒**，`getBoundingClientRect()`
    //       对块元素永远只返回一个矩形，早在 2026-10-26 就踩过这个坑）；
    //    ② 光标矩形**落在这一格的矩形里**（被切断时它跑到 `<td>` 外面）；
    //    ③ 收回之后提交出去**逐字节是原样**（本段不许把长文本真的写进文档——
    //       那会让 ⑩ 的"逐像素回原样"把后来才变高的表**误判成没还原**）。
    {
      const t = await 进格(0);
      if (!t) {
        记('Q20 长内容在格子里软换行、光标看得见', false, '进不去：' + 状态条());
      } else {
        const 格盒 = t.host.parentElement;
        const 原样 = 块全文(t.host);
        const 前文 = 全文();
        键(t.ta, 'End');
        await frames(1);
        打字(t.ta, '这是一段故意写得比列宽长得多的中文，用来逼出软换行与光标可见性');
        await frames(3);
        const 行 = t.host.querySelector('.cm-line');
        let 行盒 = 0;
        if (行) {
          const rg = document.createRange();
          rg.selectNodeContents(行);
          行盒 = rg.getClientRects().length;
        }
        const 格距 = 格盒.getBoundingClientRect();
        const 光标 = t.host.querySelector('.cm-rmd-caret');
        const 光距 = 光标 ? 光标.getBoundingClientRect() : null;
        const 格内 = !!光距 && 光距.right <= 格距.right + 1 && 光距.left >= 格距.left - 1;
        const 视文 = 块全文(t.host);
        记('Q20 比列宽长的内容在格子里**软换行**，光标始终落在这一格内（⛔ 被右边缘切断）',
          行盒 >= 2 && 格内 && 视文 === 原样 + '这是一段故意写得比列宽长得多的中文，用来逼出软换行与光标可见性',
          '视觉行盒 ' + 行盒 + '；光标 ' + (光距
            ? (Math.round(光距.left) + '–' + Math.round(光距.right) + ' / 格 ' + Math.round(格距.left) + '–' + Math.round(格距.right))
            : '（没有 .cm-rmd-caret）') + '；视图「' + 视文.slice(-18) + '」');
        // 收回：⛔ 别把这段长文本提交进文档（⑩ 逐像素回原样会因此误判）
        键(t.ta, 'z', { meta: true });
        await frames(2);
        const 收回 = 块全文(t.host) === 原样;
        const r = await 提交退出(t);
        记('Q20b 长内容收回之后提交出去逐字节是原样',
          收回 && !!r.走 && 全文() === 前文,
          (收回 ? '' : ('没收回来：「' + 块全文(主机() || t.host).slice(-18) + '」'))
            + (r.走 ? '' : '；宿主没摘掉') + (全文() === 前文 ? '' : '；提交出去的全文变了'));
      }
    }

    // ── ⑩ 退出之后表格逐像素回原样（冻结被还原，⛔ 不是永久钉死）────────
    const 宽末 = 列宽();
    let 末差 = 0;
    for (let i = 0; i < Math.max(宽0.length, 宽末.length); i++) {
      末差 = Math.max(末差, Math.abs((宽0[i] || 0) - (宽末[i] || 0)));
    }
    记('Q10 退出后每列宽度回原样', 末差 <= 1, '最大 ΔW ' + 四舍(末差) + ' px');
    记('Q10b 退出后表格高度回原样', Math.abs(表高() - 高0) <= 1, 'ΔH ' + 四舍(表高() - 高0) + ' px');
    摘要.Q.列宽 = 宽0;

    // ── `Q21` 长内容提交之后：**编辑态高度 == 阅读态高度** ────────────────
    //  ⚠️ `Q20` 判的是"编辑期间软换行 ＋ 光标看得见"；这一条判的是**换行之后不许把表格撑高**：
    //    阅读态的 `<td>` 本来就软换行 ⇒ 同一串字两边必须一样高，差出来的那一截
    //    就是"一点进去表格跳一下"（`INV-CELL-04`）。此前它只被**短格子**验过
    //    （`Q1d`/`Q2b` 的夹具格子都短），长格子那一半一条判据都没有。
    //  ⚠️⚠️ 必须排在 ⑩ 之后：这一段**真的把长文本提交进文档**（表从此变高），
    //    放在 ⑩ 之前会把 `Q10b 退出后表格高度回原样` 判红——那一条拿 Q 段开始时的表高当基线。
    {
      const 长文 = '这一格故意写得很长，用来验证软换行之后编辑态与阅读态的高度一致';
      let t = await 进格(0);
      if (!t) {
        记('Q21 长内容：编辑态高度与阅读态一致', false, '进不去：' + 状态条());
      } else {
        键(t.ta, 'End');
        await frames(1);
        打字(t.ta, 长文);
        await frames(2);
        const r = await 提交退出(t);
        await frames(2);
        // ⚠️⚠️ **⛔ 不能读 `格()[0].getBoundingClientRect()` 当"阅读态高度"**：
        //    假后端不渲染 Markdown ⇒ 提交之后那张表还是夹具原文（旧内容），
        //    读出来的是**与长文无关**的数（2026-10-28 实测 36 px，长文其实要三行）。
        //    ⇒ 用 `阅读态内容高` 这条 oracle：同一张表、同一组列宽、同一份产品样式，
        //    问的是"这串字放在这一格里会排多高"，与后端渲不渲染无关。
        const 量 = 格()[0] ? 阅读态量(格()[0], 长文) : { 高: 0, 宽: 0, 格宽: 0 };
        const 读高 = 四舍(量.高);
        t = await 进格(0);
        if (!t) {
          记('Q21 长内容：编辑态高度与阅读态一致', false,
            (r.走 ? '' : '第一次提交没退出；') + '第二次进不去：' + 状态条());
        } else {
          await frames(2);
          const 编高 = 四舍(t.host.getBoundingClientRect().height);
          const V = 视图(t.host);
          const 视图文 = V && V.state ? V.state.doc.toString() : '';
          const 行 = t.host.querySelector('.cm-line');
          let 行盒 = 0;
          if (行) {
            const rg = document.createRange();
            rg.selectNodeContents(行);
            行盒 = rg.getClientRects().length;
          }
          记('Q21 长内容（提交之后）：编辑态高度与阅读态一致（⛔ 一点进去表格就跳）',
            !!r.走 && 读高 > 0 && Math.abs(编高 - 读高) <= 1 && 视图文 === 长文,
            '内容高 阅读形态 ' + 读高 + ' → 编辑 ' + 编高 + ' px（视觉行盒 ' + 行盒 + '）'
              + '；宽 阅读 ' + 四舍(量.宽) + ' / 编辑 ' + 四舍(t.host.getBoundingClientRect().width)
              + '（格 ' + 四舍(量.格宽) + '）；视图「'
              + 视图文.slice(0, 12) + '…」' + (视图文 === 长文 ? '' : '（进格拿到的不是这一格的字）')
              + (r.走 ? '' : '；第一次提交没退出'));
          键(t.ta, 'Escape');
          await waitFor(function () { return !主机(); }, 4000);
          await frames(1);
        }
      }
    }

    // ── `Q22` 上下箭头走**视觉行**（⛔ 一按就跳到整块的末尾/开头）────────────
    //  ⚠️ 用户那句「上下左右箭头，也没有用」的**上下**落在这里：`LSel.move` 的
    //    `lineUp/lineDown` 是按**逻辑行**算的，而单元格里永远只有 1 个逻辑行
    //    ⇒ 旧实现里 ↑ 直接跳 `0`、↓ 直接跳到 `doc.length`（整格末尾）。
    //    ⭐ 给格子装上软换行之后，一个逻辑行会排成好几个**视觉行** ⇒ 必须按视觉行走。
    //  ⚠️ 判据同时读**偏移**与**几何**：只判偏移的话，"跳到一个恰好也在上面的位置"
    //    也能蒙混过去（`Q20` 那条老教训：屏幕上像不像不算证据）。
    {
      const t = await 进格(0);
      const V = t ? 视图(t.host) : null;
      if (!t || !V) {
        记('Q22 格内 ↑/↓ 走视觉行', false, '进不去或读不到视图：' + 状态条());
      } else {
        键(t.ta, 'End');
        await frames(1);
        const 头0 = V.state.selection.main.head;
        const 坐0 = V.coordsAtPos(头0, -1);
        键(t.ta, 'ArrowUp');
        await frames(1);
        const 头1 = V.state.selection.main.head;
        const 坐1 = V.coordsAtPos(头1, -1);
        键(t.ta, 'ArrowDown');
        await frames(1);
        const 头2 = V.state.selection.main.head;
        const 坐2 = V.coordsAtPos(头2, -1);
        记('Q22 格内 ↑/↓ 走**视觉行**（⛔ 一按就跳到 0 / 整格末尾）',
          头1 > 0 && 头1 < 头0 && !!坐1 && !!坐0 && 坐1.top < 坐0.top - 1
            && 头2 > 头1 && !!坐2 && 坐2.top > 坐1.top + 1,
          'End→' + 头0 + '（y ' + (坐0 ? 四舍(坐0.top) : '?') + '），↑→' + 头1
            + '（y ' + (坐1 ? 四舍(坐1.top) : '?') + '），↓→' + 头2
            + '（y ' + (坐2 ? 四舍(坐2.top) : '?') + '）'
            + (头1 <= 0 ? '；↑ 跳到了格首（旧形态）' : ''));
        键(t.ta, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
      }
    }

    // ── `Q23`–`Q25`：2026-10-28 表格编辑评审的三条（P1 ＋ P2×2）────────────
    //
    //  ⚠️ 这三条的共同点：**输入、序列化、呈现三处的特殊约束没有统一封闭**。
    //     格子直接复用了块级编辑的那套逻辑 ⇒ 块级的语义漏进了格子里。
    //     三条都**上屏看不出来**（除了 `Q25` 的字号），所以判据全落在字节与类名上。

    /**
     * 按**反斜杠转义规则**切一行表格（两侧空白修剪）。
     *
     * ⚠️ 这是判据用的 **oracle**，⛔ 不是产品的第二份实现：它只回答"写完之后这一行
     *   还切得出几格、每格是什么"，与 `cell.js` 的编码决策无关。
     * ⚠️ 规则取的是 comrak 的事实（`comrak-0.56.0/src/scanners.re:405` 的 re2c
     *    **最长匹配**）：`\` 吃掉**紧跟的后一个字节**，所以 `z\\|y` 里那个 `|` 也被吃掉
     *    ⇒ `|z\|y|` 与 `|z\\|y|` 都只有 **1 格**，只有 `|z\ |y|` 才是 2 格。
     */
    function 按反斜杠切格(行) {
      const s = String(行 === undefined || 行 === null ? '' : 行);
      const out = [];
      let 起 = -1;
      for (let i = 0; i < s.length; i++) {
        const ch = s.charAt(i);
        if (ch === '\\') { i++; continue; }
        if (ch !== '|') continue;
        if (起 >= 0) out.push(s.slice(起 + 1, i));
        起 = i;
      }
      if (起 >= 0) out.push(s.slice(起 + 1));
      if (out.length && out[0].trim() === '') out.shift();
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      return out.map(function (x) { return x.trim(); });
    }

    // ── `Q23` 末尾反斜杠：提交之后**格数与右邻格都不变**（评审 P1）────────────
    //  ⚠️ 为什么非得在**真链路**里跑：`cell.js::padFor` 的返回值能由纯逻辑单测证明，
    //    "提交出去的那一行真的是它拼出来的"证明不了——中间还隔着 `commitCell` 的拼接、
    //    `session.commit` 的一行替换、以及 `a.cell.to` 的区间跟随。
    //  ⚠️ 判据⛔ 不看"屏幕上像不像"：两侧修剪之后**第 2 格的字**才是证据。
    //    带这个缺陷的形态（`|z\|y|`）里第 2 格是**空的**、第 1 格是 `z|y`。
    {
      // 挑一格：它右边还有一格、而且两格**都有字**（右邻格被吃掉才看得出来）。
      let 目标 = -1;
      let 应格数 = 0;
      for (let i = 0; i + 1 < 区间.length; i++) {
        if (区间[i + 1][0] !== 区间[i][0]) continue;
        const a = 现区间(i);
        const b = 现区间(i + 1);
        if (a && b && a.text.trim() && b.text.trim()) {
          目标 = i;
          应格数 = 行格数(区间[i][0]);
          break;
        }
      }
      if (目标 < 0) {
        记('Q23 末尾反斜杠：提交后格数与右邻格都不变', false,
          '找不到"有右邻格且两格都有字"的一行（夹具形状不支持这条判据）');
      } else {
        const t = await 进格(目标);
        if (!t) {
          记('Q23 末尾反斜杠：提交后格数与右邻格都不变', false, '进不去：' + 状态条());
        } else {
          const 区 = 现区间(目标);
          const 邻 = 现区间(目标 + 1);
          const 前文 = 全文();
          // 清空这一格再键入 `z\`（末尾一个**裸反斜杠**——正是评审那条）
          键(t.ta, 'a', { meta: true });
          键(t.ta, 'Backspace');
          await frames(1);
          打字(t.ta, 'z\\');
          await frames(1);
          const r = await 提交退出(t);
          const 行 = String((全文().split('\n')[区.line - 1]) || '');
          const 切 = 按反斜杠切格(行);
          const 邻字 = 邻 ? 邻.text.trim() : '';
          const ok = r.走 && 切.length === 应格数 && 切[0] === 'z\\'
            && 邻字 !== '' && 切[1] === 邻字 && 全文() !== 前文;
          记('Q23 末尾反斜杠提交之后：**格数不变、右邻格的字一个字不变**',
            ok,
            '行「' + 行.slice(0, 60) + '」⇒ ' + JSON.stringify(切)
              + '（应 ' + 应格数 + ' 格，第 2 格应仍是「' + 邻字 + '」）'
              + (r.走 ? '' : '；⌘↵ 没退出'));
        }
      }
    }

    // ── `Q24` 格内 ⇧↵ / ⌥↵：**同样换行**，且 ⌘Z 能收回 ────────────────────
    //  ⚠️⚠️ **2026-10-28 需求变更**（`bugs/0035`）：用户要的是"格内能换行"，修饰键不例外。
    //     旧判据（「⇧↵/⌥↵ ⛔ 不许插进真实换行」＋「提交字节逐字不变」）是 `bugs/0033` 的口径，
    //     它守的是"折成空格"那个已经作废的契约 ⇒ **现在判反过来才对**：
    //     ① `⇧↵` 之后视图多一行；② `⌘Z` 逐字回到原样；③ `⌥↵` 同样；④ 退出并提交之后
    //     **全文逐字回到操作前**（⛔ 不许偷偷留下一个 `<br>`）。
    //  ⚠️ 为什么仍要 ⌘Z 那两条：换行的**载体**是 `\n`（提交时变 `<br>`），
    //     撤销若只回滚了视图、没回滚文档模型，屏幕上"看着回去了"而提交出去的字节多一个
    //     `<br>` —— 这正是这一类缺陷唯一的可见性。
    {
      const t = await 进格(0);
      if (!t) {
        记('Q24 格内 ⇧↵ / ⌥↵ 同样换行（⌘Z 能收回）', false, '进不去：' + 状态条());
      } else {
        const 前文 = 全文();
        const 视0 = 块全文(t.host);
        const 行0 = 视图行数(t.host);
        // ① ⇧↵
        键(t.ta, 'Enter', { shift: true });
        await frames(2);
        const 行1 = 视图行数(主机() || t.host);
        // ② ⌘Z 收回
        键(输入框() || t.ta, 'z', { meta: true });
        await frames(2);
        const 视撤1 = 块全文(主机() || t.host);
        // ③ ⌥↵
        键(输入框() || t.ta, 'Enter', { alt: true });
        await frames(2);
        const 行2 = 视图行数(主机() || t.host);
        键(输入框() || t.ta, 'z', { meta: true });
        await frames(2);
        const 视撤2 = 块全文(主机() || t.host);
        // ④ 退出（未改动 ⇒ 提交短路）＋ 字节层核对
        const ta3 = 输入框();
        if (ta3) 键(ta3, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
        记('Q24 格内 ⇧↵ / ⌥↵ 同样换行（视图各 +1 行），⌘Z 逐字收回，'
          + '提交出去的字节一个都不多',
          行1 === 行0 + 1 && 视撤1 === 视0 && 行2 === 行0 + 1 && 视撤2 === 视0
            && 全文() === 前文,
          '视图行数 ' + 行0 + ' → ' + 行1 + ' →（撤）→ ' + 行2
            + '；撤销后回到原样=' + (视撤1 === 视0) + ' / ' + (视撤2 === 视0)
            + '；提交后全文变了=' + (全文() !== 前文));
      }
    }

    // ── `Q25` 格内写 `# 普通格子` ⛔ 不是标题（评审 P2-③）──────────────────
    //  ⚠️ 带缺陷的形态：格子的文本被当成**独立 Markdown 文档**解析 ⇒ 套上 `cm-rmd-h1`，
    //    字号与行高都跳一级，而**阅读态里它就是普通文本**。
    //  ⇒ 判据要**两头都判**：① 没有标题类；② 那一行的字号 == 正文字号（±0.5 px）。
    //    ⛔ 只判类名不够：类名换个写法（比如把尺度直接写在 `style` 上）就漏了。
    {
      const t = await 进格(0);
      if (!t) {
        记('Q25 格内 `# 普通格子` 不是标题', false, '进不去：' + 状态条());
      } else {
        键(t.ta, 'a', { meta: true });
        键(t.ta, 'Backspace');
        await frames(1);
        打字(t.ta, '# ');
        await frames(1);
        打字(t.ta, '普通格子');
        await frames(2);
        const 类 = t.host.querySelector(
          '.cm-rmd-h1, .cm-rmd-h2, .cm-rmd-h3, .cm-rmd-h4, .cm-rmd-h5, .cm-rmd-h6');
        const 行元素 = t.host.querySelector('.cm-line');
        const 字号 = 行元素 ? (parseFloat(getComputedStyle(行元素).fontSize) || 0) : 0;
        const 正文 = 正文字号();
        const 同一号 = 正文 > 0 && 字号 > 0 && Math.abs(字号 - 正文) <= 0.5;
        记('Q25 格子里写 `# 普通格子` ⛔ 不是标题（无标题类，字号 == 正文）',
          !类 && 同一号,
          '标题类=' + (类 ? 类.className : '无')
            + '；字号 ' + 四舍(字号) + ' px / 正文 ' + 四舍(正文) + ' px');
        // 收尾：清空这一格并退出（⛔ 不把 `# 普通格子` 留在文档里）
        键(t.ta, 'a', { meta: true });
        键(t.ta, 'Backspace');
        await frames(1);
        await 提交退出(t);
      }
    }
  }

  // ── R 段：**鼠标拖选**（`bugs/0031` 的块内那一半）──────────────────────────
  //
  // 回答的是「双击选了个词之后再拖，选区跟不跟手；拖到屏幕边缘页面滚不滚」。
  // ⚠️ 为什么必须新开一段：`D`/`O` 段的选区**全是键盘造的**（`⇧`＋方向键、`⌘A`），
  //    `Q` 段在格子内也只按键盘 ⇒ "鼠标拖拽"这条路一条判据都没有——
  //    而用户 2026-10-28 的原话正是「文本选择功能极不顺畅」。
  // ⚠️ 只判**块内**那一半：跨块选择是 `design/0047` 单块视图的结构性后果，
  //    走 `design/0053`（`待评审`），`R3` 在那里，⛔ 本段不假装验过。
  // ⚠️ 只在**有源码 ≥ 4 字符的可编辑块**的夹具上产判据；其余记 `摘要.R = {适用:false}`，
  //    **既不记通过也不记跳过** ⇒ 由 `block-probe.sh` 的 `R-覆盖` 把关。
  async function 跑鼠标拖选(base, 摘要) {
    const d = docEl();
    const p = window.__rmd && window.__rmd.payload;
    const 数 = d.children.length;
    const 可编辑 = [];
    for (let i = 0; i < p.blocks.length && i < 数; i++) {
      if (p.blocks[i][3] === 1 && 块源(i).length >= 4) 可编辑.push(i);
    }
    if (!可编辑.length) {
      摘要.R = { 适用: false, 原因: '没有源码 ≥ 4 字符的可编辑块' };
      return;
    }
    // 挑一块**有东西可以双击**的：ASCII 词优先（双击选词才有"一个词"），
    // 其次汉字（`wordStop` 把汉字当单字 ⇒ 双击选一个字也是非空选区），并列取最长的一块。
    let 挑 = 可编辑[0];
    let 分数 = -1;
    for (let k = 0; k < 可编辑.length; k++) {
      const i = 可编辑[k];
      const s = 块源(i);
      const 有词 = /[0-9A-Za-z_]{2,}/.test(s) ? 2 : (/[㐀-䶿一-鿿]/.test(s) ? 1 : 0);
      const 分 = 有词 * 1e6 + s.length;
      if (分 > 分数) { 分数 = 分; 挑 = i; }
    }
    摘要.R = { 适用: true, 块: 挑 };

    /** 往 `target` 派一次鼠标事件（页内 DOM 事件，⛔ 不是系统级合成按键）。 */
    function 派(target, type, x, y, 附加) {
      const o = {
        bubbles: true, cancelable: true, view: window,
        clientX: Math.round(x), clientY: Math.round(y),
      };
      if (type !== 'mouseup') { o.button = 0; o.buttons = 1; }
      if (附加) for (const k in 附加) o[k] = 附加[k];
      target.dispatchEvent(new MouseEvent(type, o));
    }

    /** 退出编辑态并等宿主摘掉（⛔ 别把失败留在屏幕上）。 */
    async function 收尾() {
      const ta = 输入框();
      if (主机()) 键(ta || document.body, 'Escape');
      await waitFor(function () { return !主机(); }, 4000);
      await frames(1);
    }

    // 进块：⚠️ 必须等**新**宿主（`leave()` 异步，旧宿主还挂在树上 ⇒ 会拿到上一个）。
    const 旧 = 主机();
    点(d.children[挑]);
    const host = await waitFor(function () {
      const h = 主机();
      return h && h !== 旧 ? h : null;
    }, 4000);
    const V = host ? 视图(host) : null;
    if (!host || !V) {
      记('R0 点进一个可编辑块并拿到视图', false,
        (host ? '读不到 CM6 视图' : '等不到新宿主') + '；状态条：' + 状态条());
      await 收尾();
      return;
    }
    await frames(1);
    // ⚠️ `R0` 是**后面三条的前提**，必须**成功也产出**：只在失败分支记它的话，
    //    一份夹具跑通了反而"缺 R0"，`R-覆盖` 会把整轮判红（2026-10-28 真踩过）。
    记('R0 点进一个可编辑块并拿到 CM6 视图', V.state.doc.length > 0,
      '块 ' + 挑 + '；源码 ' + V.state.doc.length + ' 字符');
    const ta = 输入框();

    // 双击位：ASCII 词**中间**（词首 + 1）；没有 ASCII 词就取第一个汉字；再没有就放弃这一份夹具。
    const 文 = V.state.doc.toString();
    let 词起 = -1;
    let 词长 = 0;
    const m = /[0-9A-Za-z_]{2,}/.exec(文);
    if (m && m.index + m[0].length < 文.length) { 词起 = m.index; 词长 = m[0].length; }
    if (词起 < 0) {
      const c = /[㐀-䶿一-鿿]/.exec(文.slice(0, Math.max(0, 文.length - 1)));
      if (c) { 词起 = c.index; 词长 = 1; }
    }
    // ⚠️ 还要求**词后面至少还有 2 个字符**：没有的话"往后拖"拖不出更大的选区，
    //    `R1b` 就会把"块太短"判成"不跟手"（红得没道理）。
    if (词起 < 0 || 文.length < 词起 + 词长 + 2) {
      摘要.R = { 适用: false, 原因: '这一块里没有可双击、且后面还有字的片段' };
      await 收尾();
      return;
    }
    const 双击位 = 词起 + (词长 > 1 ? 1 : 0);
    const c0 = V.coordsAtPos(双击位, 1);
    if (!c0) {
      记('R1 双击选中一个词', false, '取不到偏移 ' + 双击位 + ' 的几何（coordsAtPos 返回 null）');
      await 收尾();
      return;
    }
    const y0 = (c0.top + c0.bottom) / 2;
    const x0 = c0.left;

    // ── R1 双击选词 ────────────────────────────────────────────────
    //  ⚠️ 必须派到 **`V.dom`**（CM6 自己的根），⛔ 不是 `.cm-rmd-liveHost`：
    //    `host` 是产品自己那个 div（`main.js::makeLiveView`），`installMouse` 挂的是
    //    `view.dom` 上的 **capture** 监听 —— 打在 `host` 上的事件**根本到不了它**
    //    （capture 是从外往里，target 在 host 时 view.dom 不在路径上）。
    //  ⚠️ `detail: 2` 才走产品 `installMouse::down()` 的双击分支；只发 `click` 是**另一条路**。
    派(V.dom, 'mousedown', x0, y0, { detail: 2 });
    await frames(1);
    const 选1 = V.state.selection.main;
    const 选中词 = 选1.from < 选1.to
      && 选1.from <= 双击位 && 双击位 <= 选1.to
      && (选1.to - 选1.from) >= 词长;
    记('R1 双击真的选中了一个词（⛔ 不是只放了个光标）', 选中词,
      '双击位 ' + 双击位 + '（词 ' + 词起 + '…' + (词起 + 词长) + '）→ 选区 '
        + 选1.from + '…' + 选1.to + '；块内「' + 文.slice(0, 16) + '…」');

    // ── R1b 双击之后**继续拖** ─────────────────────────────────────
    //  ⚠️ 拖到"词末尾再往后几个字符"的几何上，⛔ 不是拖到块末尾：块可能有好几屏，
    //    块末尾的几何在视口外（`coordsAtPos` 取不到）。
    const 目标位 = Math.min(文.length, 词起 + 词长 + 4);
    const c1 = V.coordsAtPos(目标位, 1);
    const 拖x = c1 ? c1.left : Math.min(window.innerWidth - 8, x0 + 90);
    const 拖y = c1 ? (c1.top + c1.bottom) / 2 : y0;
    派(V.dom, 'mousemove', 拖x, 拖y, { detail: 0 });
    await frames(2);
    const 选2 = V.state.selection.main;
    记('R1b 双击之后**继续拖**，选区跟着走（锚点不动、头往前）',
      选2.anchor === 选1.anchor && 选2.head > 选1.head,
      '头 ' + 选1.head + ' → ' + 选2.head + '；锚点 ' + 选1.anchor + ' → ' + 选2.anchor
        + `（拖到偏移 ${目标位} 的几何 x=${Math.round(拖x)} y=${Math.round(拖y)}）`);

    // ── R2 拖到窗口下边缘 ⇒ 自动滚动 ───────────────────────────────
    //  ⚠️ 前提是**页面可滚**；不可滚的夹具记 `摘要.R.自动滚动 = false` 且⛔ 不产判据
    //    （"页面本来就没得滚"与"自动滚动不工作"输出一模一样 ⇒ 不能记通过，也不能记跳过）。
    摘要.R.自动滚动 = 滚动上限() > 1;
    if (摘要.R.自动滚动) {
      const 前 = 滚动位置();
      派(V.dom, 'mousemove', 拖x, window.innerHeight - 2, { detail: 0 });
      await frames(12);
      const 后 = 滚动位置();
      记('R2 拖到窗口下边缘 ⇒ 页面真的滚了（⛔ 不是光标走到边缘就不动）', 后 > 前 + 1,
        '滚动位置 ' + 四舍(前) + ' → ' + 四舍(后) + ' px（可滚余量 ' + 四舍(滚动上限()) + ' px）');
      派(V.dom, 'mouseup', 拖x, window.innerHeight - 2, { detail: 1 });
      await frames(2);
      const 停1 = 滚动位置();
      await frames(10);
      const 停2 = 滚动位置();
      记('R2b 松开之后不再滚', 停2 === 停1,
        '松开后 ' + 四舍(停1) + ' → ' + 四舍(停2) + ' px');
      // 收尾：把页面滚回原处——X 段（锚定注入）要用**没被这一段挪过**的布局。
      if (document.body) document.body.scrollTop = 前;
      if (document.documentElement) document.documentElement.scrollTop = 前;
      await frames(1);
    } else {
      // 页面没得滚也必须松开：不松开的话产品的 rAF 循环会一直转下去。
      派(V.dom, 'mouseup', 拖x, 拖y, { detail: 1 });
      await frames(1);
    }

    await 收尾();
  }

  // ── V 段：**任务项就地打勾**（`design/0051`）────────────────────────────
  //
  // 回答的是「点一下方框，源码里到底动了几个字节、动的是哪一处」。
  // ⚠️ 打勾的三类后果**都不上屏**：改到别的行 / 把行尾或两侧文字吃掉 /
  //    拿陈旧的列区间去套一个已经不是符号的位置——写下去就是**另一份源码**，
  //    只有字节层看得见（与 Q 段同一条理由，`INV-TASK-01/02`）。
  //
  // ⚠️ 只在载荷里**真有** `task_items` 的夹具上产判据；否则 `摘要.V = {适用:false}` 且
  //    **既不记通过也不记跳过**——"本轮到底验没验打勾"由 `block-probe.sh` 的 `V-覆盖` 把关。
  // ⚠️ 基线**不是夹具原文**：V 段排在 D/N/O/H/L 之后，H 段真的改过正文并写盘
  //    ⇒ 基线 = **进入这一段之前**最近一次提交的全文；一次都没提交过才是夹具原文。
  //    （与 Q 段同一条坑，2026-10-27 实测过。）
  async function 跑任务项(base, 摘要) {
    const d = docEl();
    const p = window.__rmd.payload;
    const 原 = String((window.__FIXTURE || {}).text || '');
    const 表 = p.task_items || [];
    if (!表.length) { 摘要.V = { 适用: false, 原因: '载荷里没有 task_items' }; return; }

    // 挑任务项最多的那一块（并列取先出现的那一块）——项越多越能暴露"点这个勾那个"。
    let 挑 = 表[0];
    for (let i = 0; i < 表.length; i++) {
      if ((表[i][1] || []).length > (挑[1] || []).length) 挑 = 表[i];
    }
    const 块 = 挑[0];
    const 区间 = 挑[1] || [];
    if (!d.children[块] || !区间.length) {
      摘要.V = { 适用: false, 原因: '块 ' + 块 + ' 不在 DOM 里，或区间为空' };
      return;
    }

    function 方框() {
      const n = d.children[块];
      if (!n) return [];
      return Array.prototype.slice.call(n.querySelectorAll('input.task-list-item-checkbox'));
    }
    function 提交文本() {
      const r = 最近一次('render_preview');
      return r && r.args && typeof r.args.text === 'string' ? r.args.text : null;
    }
    function 盘文本() {
      const r = 最近一次('save_document');
      return r && r.args && typeof r.args.text === 'string' ? r.args.text : null;
    }
    /** 逐行逐字符的差异：`[{行, 列, 旧, 新}]`（行数不等时也多记一条）。 */
    function 差异(旧, 新) {
      const a = String(旧).split('\n');
      const b = String(新).split('\n');
      const 出 = [];
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i];
        const y = b[i];
        if (x === y) continue;
        if (x === undefined || y === undefined) {
          出.push({ 行: i + 1, 列: -1, 旧: x === undefined ? '' : x, 新: y === undefined ? '' : y });
          continue;
        }
        for (let k = 0; k < Math.max(x.length, y.length); k++) {
          if (x.charAt(k) !== y.charAt(k)) 出.push({ 行: i + 1, 列: k, 旧: x.charAt(k), 新: y.charAt(k) });
        }
      }
      return 出;
    }
    /**
     * 把 `文案` 里 `sp` 指的那一处换成"往返之后的规范形态"。
     * ⚠️⚠️ 大写 `X` 取消后再勾上会变成小写 `x`——`toggleLine` **不记原写法**
     *    （三选一只认 `' '`/`'x'`/`'X'`，无状态可存）。这是**有意的规范化**，写进
     *    `design/0051` §5 `INV-TASK-02`；⛔ 不是缺陷，且**只动那一个字节**。
     */
    function 归一(文案, sp) {
      const a = String(文案).split('\n');
      const L = a[sp[0] - 1];
      if (typeof L === 'string' && L.charAt(sp[1]) === 'X') {
        a[sp[0] - 1] = L.slice(0, sp[1]) + 'x' + L.slice(sp[1] + 1);
      }
      return a.join('\n');
    }
    /** 取第 `i` 行；越界回 `''`（⛔ 不许抛——产品把整篇改短时这里必须**记失败**而不是让整轮崩）。 */
    function 行(i, s) {
      const a = String(s).split('\n');
      return typeof a[i] === 'string' ? a[i] : '';
    }
    /**
     * 真点一下方框。
     * ⚠️ 两步都要：`mousedown` 时产品记下"点之前是不是勾着"（`INV-TASK-03` 的配对判据），
     *    而 `checked` 的翻转发生在 `click` **派发之前**（HTML 的 pre-click activation steps）；
     *    `.click()` 才会跑那一步——直接派发 `MouseEvent('click')` 不跑，`checked` 不翻，
     *    产品拿到的"点之前"就是错的（那样判据测的是探针自己造的假象）。
     */
    async function 点方框(box) {
      点(box);
      box.click();
    }

    const 底文 = 提交文本() || 原;
    摘要.V = { 适用: true, 块: 块, 项数: 区间.length };

    // ── ① 载荷 ↔ DOM 配对（`INV-TASK-03`）────────────────────────────
    const 框0 = 方框();
    记('V0 载荷里的任务项数与 DOM 方框数一致', 框0.length === 区间.length,
      '载荷 ' + 区间.length + ' / DOM ' + 框0.length);
    let 错配 = '';
    for (let i = 0; i < Math.min(框0.length, 区间.length); i++) {
      const 载荷勾 = 区间[i][3] === 1 || 区间[i][3] === true;
      if ((框0[i].checked === true) !== 载荷勾) {
        错配 += '第 ' + i + ' 个：DOM ' + 框0[i].checked + ' / 载荷 ' + 区间[i][3] + '；';
      }
    }
    记('V0b 每个方框的勾选状态与载荷一致（DOM 没有陈旧）', 错配 === '', 错配);

    // ⚠️ 直系判据用 `closest('li')` 认领：嵌套在「普通项」下面的任务项**不该**算到外层头上。
    const 所有项 = Array.prototype.slice.call(d.children[块].querySelectorAll('li'));
    let 多的 = 0;
    let 少的 = 0;
    let 普通 = 0;
    for (let i = 0; i < 所有项.length; i++) {
      const isTask = 所有项[i].classList.contains('task-list-item');
      const 直系 = 所有项[i].querySelectorAll('input.task-list-item-checkbox');
      let n = 0;
      for (let k = 0; k < 直系.length; k++) if (直系[k].closest('li') === 所有项[i]) n++;
      if (!isTask) 普通++;
      if (!isTask && n > 0) 多的++;
      if (isTask && n === 0) 少的++;
    }
    // ⭐ 这一条盯的是「看着像但不是任务项」的行（`- []` / `- [ ]` 后面没空格）：
    //    载荷里没有它们 ⇒ 产品⛔ 不许给它们造方框，也⛔ 不许漏掉真任务项的方框。
    记('V0c 非任务项的列表行没有方框（看着像的那些）', 多的 === 0 && 少的 === 0,
      '多出方框 ' + 多的 + ' 项 / 少了方框 ' + 少的 + ' 项 / 本块普通项 ' + 普通);

    // ── ② 点第一个方框：只该动那一处 ────────────────────────────────
    const 框1 = 方框();
    if (!框1.length) { 记('V1 点方框发出一次提交', false, '这一块一个方框都没有'); return; }
    const r1 = 计数('render_preview');
    const s1 = 计数('save_document');
    点方框(框1[0]);
    const 进编辑了 = !!主机();
    const 到1 = await waitFor(function () { return 计数('render_preview') > r1; }, 4000);
    记('V1 点方框发出一次提交（render_preview ＋1）', !!到1,
       '状态条「' + 状态条() + '」');
    记('V1b 点方框不进入就地编辑（不出现 ' + HOST_SEL + '）', !进编辑了 && !主机(),
       '点下去当刻 ' + (进编辑了 ? '进了覆盖层' : '没有覆盖层') + ' / 之后 ' + (主机() ? '有一个' : '没有'));

    const 文1 = 提交文本();
    const sp0 = 区间[0];
    const 差1 = 文1 ? 差异(底文, 文1) : [];
    const 只一处 = 差1.length === 1 && 差1[0].行 === sp0[0] && 差1[0].列 === sp0[1];
    记('V2 提交只改那一处（逐行逐字符比对）', 只一处,
       '差异 ' + JSON.stringify(差1.slice(0, 4)) + ' / 载荷区间 第 ' + sp0[0] + ' 行第 ' + sp0[1] + ' 列');
    const 旧字 = 行(sp0[0] - 1, 底文).charAt(sp0[1]);
    const 新字 = 文1 ? 行(sp0[0] - 1, 文1).charAt(sp0[1]) : '';
    const 应新 = 旧字 === ' ' ? 'x' : ' ';
    记('V2b 那一个字节按预期翻转（` ` ↔ `x`）', 新字 === 应新,
      '旧「' + 旧字 + '」新「' + 新字 + '」期望「' + 应新 + '」');
    记('V2c 行数不变（同长度替换）', !!文1 && 文1.split('\n').length === 底文.split('\n').length,
      '行数 ' + 底文.split('\n').length + ' → ' + (文1 ? 文1.split('\n').length : '?'));

    // ── ③ 写盘 == 提交（`INV-TASK-06`：打勾即落盘）──────────────────
    await waitFor(function () { return 计数('save_document') > s1; }, 4000);
    const 盘1 = 盘文本();
    记('V3 写盘与提交是同一份字节', !!盘1 && 盘1 === 文1,
      '写盘 ' + (盘1 ? 盘1.length + ' 字符' : '没调 save_document') +
      '；状态条「' + 状态条() + '」' +
      '⚠️ 若状态条是「已改在内存里（未保存）」，说明点之前会话**已经脏**——' +
      '产品按 `INV-TASK-06` 后半条**故意**不顺手保存（⛔ 那不是缺陷，是这一段排错了位置）');
    const 应状态 = 应新 === 'x' ? '已勾选（已保存）' : '已取消勾选（已保存）';
    记('V3b 状态条说的是「' + 应状态 + '」', 状态条().indexOf(应状态) >= 0, '状态条「' + 状态条() + '」');

    // ── ④ 再点一次：逐字节回到原样 ──────────────────────────────────
    const 框2 = 方框();
    if (框2.length) {
      const r2 = 计数('render_preview');
      const s2 = 计数('save_document');
      点方框(框2[0]);
      await waitFor(function () { return 计数('render_preview') > r2; }, 4000);
      await waitFor(function () { return 计数('save_document') > s2; }, 4000);
      const 文2 = 提交文本();
      const 期望回 = 归一(底文, sp0);
      记('V4 再点一次逐字节回到原样（大写 `X` 按规范形态）', !!文2 && 文2 === 期望回,
        '差异 ' + JSON.stringify(差异(期望回, 文2 || '').slice(0, 4)));
      const 反状态 = 应新 === 'x' ? '已取消勾选（已保存）' : '已勾选（已保存）';
      记('V4b 第二次的状态条是「' + 反状态 + '」', 状态条().indexOf(反状态) >= 0,
        '状态条「' + 状态条() + '」');
    } else {
      记('V4 再点一次逐字节回到原样', false, '重渲之后一个方框都没有（`armTaskBoxes` 没接上）');
      记('V4b 第二次的状态条', false, '同上');
    }

    // ── ⑤ **每一个**任务项逐个翻转并翻回（本节的主判据）───────────────
    //  ⚠️ 逐个走一遍的理由：只点第一个只能证明"那一个对"；块内第 3 个之后的
    //     区间错一位（先序 vs 层级、嵌套列表）在单个样本上完全看不出来。
    let 全程 = 'ok';
    let 期望 = 底文;
    for (let i = 0; i < 区间.length; i++) {
      const 前 = 提交文本() || 底文;
      // 这一趟往返之后，整篇应当变成什么样（只有大写 `X` 会规范化，见 `归一`）。
      期望 = 归一(期望, 区间[i]);
      const 框 = 方框();
      if (!框[i]) { 全程 = '第 ' + i + ' 个方框不见了'; break; }
      const r = 计数('render_preview');
      const s = 计数('save_document');
      点方框(框[i]);
      const 到 = await waitFor(function () { return 计数('render_preview') > r && 计数('save_document') > s; }, 4000);
      if (!到) { 全程 = '第 ' + i + ' 个：点下去没有提交或没有写盘'; break; }
      const 后 = 提交文本();
      const 差 = 差异(前, 后);
      const sp = 区间[i];
      if (差.length !== 1 || 差[0].行 !== sp[0] || 差[0].列 !== sp[1]) {
        全程 = '第 ' + i + ' 个：差异 ' + JSON.stringify(差.slice(0, 3)) + ' / 区间 第 ' + sp[0] + ' 行第 ' + sp[1] + ' 列';
        break;
      }
      const 应 = 行(sp[0] - 1, 前).charAt(sp[1]) === ' ' ? 'x' : ' ';
      if (行(sp[0] - 1, 后).charAt(sp[1]) !== 应) { 全程 = '第 ' + i + ' 个：翻转方向不对'; break; }

      const 框回 = 方框();
      const r回 = 计数('render_preview');
      const s回 = 计数('save_document');
      点方框(框回[i]);
      const 回来了 = await waitFor(function () {
        return 计数('render_preview') > r回 && 计数('save_document') > s回;
      }, 4000);
      if (!回来了) { 全程 = '第 ' + i + ' 个：点回来没有提交或没有写盘'; break; }
      if (提交文本() !== 期望) { 全程 = '第 ' + i + ' 个：点回来整篇没有回到期望（差异 ' + JSON.stringify(差异(期望, 提交文本() || '').slice(0, 3)) + '）'; break; }
    }
    记('V5 每个任务项逐个翻转并翻回，每次只动它自己那一处', 全程 === 'ok', 全程);
    // ⭐ 收尾一句话把"大写 `X` 会规范成小写"这件事**显式钉住**（`INV-TASK-02`）：
    //    其余字节一个都不许差；夹具里没有大写 `X` 时它退化成"逐字节回到基线"。
    记('V5b 收尾整篇 == 基线（大写 `X` 按规范形态）', (提交文本() || '') === 期望,
      '差异 ' + JSON.stringify(差异(期望, 提交文本() || '').slice(0, 4)) +
      (期望 === 底文 ? '' : '（本夹具里有大写 `X`，往返后规范成小写 `x`）'));
    摘要.V.提交数 = 计数('render_preview');
    摘要.V.收尾回到期望 = 提交文本() === 期望;
    摘要.V['有大写X（往返会规范成小写）'] = 期望 !== 底文;
  }

  async function 诊断() {
    const p = await 等启动();
    if (!p) return { 致命: '应用没起来', 加载期错误: window.__LOADERR || [] };
    const d = docEl();
    const rows = [];
    for (let i = 0; i < d.children.length; i++) {
      const el = d.children[i];
      const wire = p.blocks[i] || [];
      const row = {
        i: i,
        标签: String(el.tagName || '').toLowerCase(),
        品种: p.block_kinds[wire[0]] || '?',
        可编辑: wire[3] === 1,
        原: 样式(el),
      };
      if (!row.可编辑) { rows.push(row); continue; }
      点(el);
      const host = await waitFor(主机, 3000);
      if (!host) {
        row.说明 = '进不去：' + 状态条();
        rows.push(row);
        continue;
      }
      await frames(1);
      const sc = host.querySelector('.cm-scroller');
      const cn = host.querySelector('.cm-content');
      row.视 = 样式(host);
      row.视scroller = 样式(sc);
      row.视content = 样式(cn);
      row.行数 = host.querySelectorAll('.cm-line').length;
      // ⚠️ 诊断要能分辨「标记藏了没有」：藏掉之后 `textContent` 里就没有那些字符了。
      //    ⛔ 这不是判据，只是给"这块为什么高了 23.8 像素"取证用。
      row.块内文本 = 块内文本(host).slice(0, 200);
      // ⚠️ 与上面那条配对：**产品自己的** `markers()` 对这块源码算出几个要藏的区间。
      //    `隐藏区间=0` 而 `块内文本` 里却有 `#` / `**` ⇒ 装饰层压根没生效（接线断了），
      //    ⛔ 不是"这块本来就没有标记"。
      row.隐藏区间 = (function () {
        try {
          const LM = window.rmd && window.rmd.liveMarks;
          if (!LM || typeof LM.markers !== 'function') return '没有 liveMarks';
          const all = String((window.__FIXTURE || {}).text || '').split('\n');
          const body = all.slice(wire[1] - 1, wire[2]).join('\n');
          // ⚠️ `design/0052` U3 起不传树就**一个都不藏**（可见降级）⇒ 不补这一句，
          //    诊断会恒报 `隐藏区间=0`，而屏幕上明明藏掉了。
          return LM.markers(body, { activeLines: [], tree: 造树(body) }).ranges.length;
        } catch (e) {
          return '抛错：' + e;
        }
      })();
      row.Δ高 = 四舍((row.视 && row.视.高) - row.原.高);
      rows.push(row);
      键(输入框(), 'Escape');
      await waitFor(function () { return !主机(); }, 3000);
      await frames(2);
    }
    return {
      诊断: rows,
      文档: p.path,
      doc: 样式(d),
      摘要: { 块数: p.blocks.length, 行数: p.line_count },
      环境: { 有焦点: document.hasFocus(), 未预期命令: (window.__UNKNOWN || []).slice(0, 8) },
    };
  }

  // ── 主流程 ─────────────────────────────────────────────────────────
  /**
   * ⭐ **X 段：锚定补偿的端到端对照**（`design/0052` U6 / `INV-KERNEL-05` / `INV-KERNEL-07`）。
   *
   * ⚠️⚠️ 为什么必须有这一段：`B*-3b` 判的是"进块前后被点那一行的行顶没动"，
   *    而**盒子搬对之后大多数块本来就不动**（2026-10-27 实测：整轮 96 条 `滚动差 0 px`）
   *    ⇒ 产品里 `scrollTop += delta` 那一支**一次都没被执行到**。那样的判据对
   *    "锚定整条坏了"是**结构性失明**的：`main.js::anchorAt` 全删掉，B 段照样全绿
   *    （`INV-KERNEL-07` 的病根正是"判据看起来在判、其实没承重"）。
   *
   * ⭐ 办法是**故障注入**（不是把产品改坏）：给活的宿主加 40 px 上内边距，
   *    于是"这一块一进去第一行必然下移 40 px"。产品若真的在锚定，就得把滚动补回 40 px
   *    才可能让那一行留在原地。两条判据各自承重：
   *    ① `X1` 行顶不位移 —— 补对了**方向**；
   *    ② `X2` 滚动量与注入量**同量级** —— 补对了**量级**（⛔ 不是"随手滚一下"、⛔ 不是滚一屏）。
   *    ⚠️ 容差是 **1 px**（⛔ 不是 `B-3b` 的 0.5）：产品自己的停止阈值就是 `|delta| ≤ 1`，
   *    而且 WebKit 的 `scrollTop` 赋值会被取整到整像素 ⇒ 残留 ≤ 1 px 是**物理下界**，
   *    再收紧只会让这条判据恒红（2026-10-27 实测残留 **0.719 px**）。
   *    ⚠️ 注入的样式**只作用于 `.cm-rmd-liveHost`**，渲染态那一侧量不到它 ⇒ `锚点0` 不受影响。
   *
   * ⚠️ 前置：夹具比窗口短，页面**本来就滚不动**（实测 `scrollHeight == clientHeight == 1600`）
   *    ⇒ 先补一段 2000 px 的尾巴把它变成"能滚的页面"（真实文档几乎总比窗口长）。
   *    ⚠️ 尾巴必须挂在 `#doc` **外面**：`几何()` 只数 `#doc` 的孩子，塞进去会把块表对不上。
   */
  async function 跑锚定对照(摘要) {
    const d = docEl();
    const p = window.__rmd && window.__rmd.payload;
    if (!p) { 摘要.X = { 适用: false, 原因: '没有载荷' }; return; }
    let k = -1;
    for (let i = 0; i < p.blocks.length && i < d.children.length; i++) {
      if (p.blocks[i][3] === 1) { k = i; break; }
    }
    if (k < 0) { 摘要.X = { 适用: false, 原因: '没有可编辑块' }; return; }
    摘要.X = { 适用: true, 块: k };

    const tail = document.createElement('div');
    tail.id = '__rmd_probe_tail';
    tail.setAttribute('aria-hidden', 'true');
    tail.style.height = '2000px';
    document.body.appendChild(tail);
    await frames(2);
    const 余量 = 滚动上限();
    记('X0 对照前页面真的能滚（否则锚定无从验证）', 余量 > 0, '可滚余量 ' + 余量 + ' px');
    if (!余量) { document.body.removeChild(tail); 摘要.X = { 适用: false, 原因: '加尾巴后仍滚不动' }; return; }

    // 故障注入：活的宿主多 40 px 上内边距 ⇒ 一进去第一行必然下移 40 px
    const st = document.createElement('style');
    st.id = '__rmd_probe_shift';
    st.textContent = '.cm-rmd-liveHost .cm-content { padding-top: 40px !important; }';
    document.head.appendChild(st);

    const node = d.children[k];
    try { node.scrollIntoView({ block: 'start', inline: 'nearest' }); } catch (e) { void e; }
    await frames(1);
    const 滚动前 = 滚动量();
    const 锚点0 = 首字顶(node);

    const ev = 点(node);
    记('X0b 点击被接管', !!ev.defaultPrevented, ev.defaultPrevented ? '' : '没走到"进入"那一支');
    const host = await waitFor(主机, 4000);
    await frames(3);
    const 行 = host ? host.querySelector('.cm-line') : null;
    const 锚点1 = 行 ? 首字顶(行) : null;
    if (!host || 锚点1 === null) {
      记('X1 注入 40 px 上内边距 ⇒ 行顶仍不位移', false,
        '进不去覆盖层（状态条：' + 状态条() + '）');
      记('X2 补的滚动量 ≈ 40 px', false, '同上');
    } else {
      const 移 = 四舍(Math.abs(锚点1 - 锚点0));
      const 补 = 四舍(滚动量() - 滚动前);
      记('X1 注入 40 px 上内边距 ⇒ 被点那一行仍不位移（补偿真的在起作用）',
        移 <= 1, '行顶 ' + 四舍(锚点0) + ' → ' + 四舍(锚点1) + ' px（Δ ' + 移
          + '；容差 1 px ＝ 产品停止阈值 `|delta| ≤ 1` ＋ `scrollTop` 取整）');
      记('X2 补的滚动量与注入量同量级（不是"随手滚一下"、也不是滚一屏）',
        补 >= 20 && 补 <= 60, 'ΔscrollTop ' + 补 + ' px（注入 40 px；实测的位移 '
          + 移 + ' px 已由补偿接住 ⇒ 真正被补掉的是 ' + 四舍(补 + 移) + ' px）');
      摘要.X = { 适用: true, 块: k, 位移: 移, 补偿: 补 };
    }

    // 退出并清场（⚠️ 顺序：先退出、再撤样式、最后撤尾巴——样式在退出的那一帧还要参与布局）
    const ta = 输入框();
    if (ta) 键(ta, 'Escape');
    await waitFor(function () { return !主机(); }, 4000);
    await frames(1);
    document.head.removeChild(st);
    document.body.removeChild(tail);
    await frames(2);
    记('X3 对照后清场干净（没有覆盖层、没有注入样式、没有尾巴）',
      !主机() && !document.getElementById('__rmd_probe_shift')
        && !document.getElementById('__rmd_probe_tail'),
      'host=' + !!主机() + ' style=' + !!document.getElementById('__rmd_probe_shift')
        + ' tail=' + !!document.getElementById('__rmd_probe_tail'));
  }

  async function run() {
    // ⭐ **先判环境，再跑任何判据**（见 `帧健康()`）：页面不可见时跑出来的几何与时序
    //    数字都是废数，而"跑满 180 秒再超时"会把废数伪装成产品挂死。
    const 帧 = await 帧健康();
    if (帧.胜 === 0) {
      out.环境有效 = false;
      out.环境.帧健康 = 帧;
      out.环境.说明 = '连续 8 帧 requestAnimationFrame 一次都没触发'
        + '（屏幕已锁 / 显示器睡眠 / 页面被 WebKit 冻结）⇒ 本轮几何与时序数字全部作废。'
        + '解锁后重跑。⛔ 这不是产品缺陷。';
      return out;
    }
    out.环境.帧健康 = 帧;
    const p = await 等启动();
    if (!p) {
      记('A0 应用启动', false,
        '等不到 window.__rmd.payload；加载期错误：' + JSON.stringify(window.__LOADERR || []));
      return out;
    }
    const D = window.__FIXTURE;
    const d = docEl();

    记('A0 应用启动', true, '');
    // ⚠️ 比的是**解析后的 DOM**，⛔ 不是两段字符串字面相等：`innerHTML` 会重新序列化
    //    （属性引号、自闭合、实体转义都可能换写法），拿字符串比会红在"WebKit 的重写规则"上，
    //    与"正文挂错了"分不开。两侧都过一遍 DOM ⇒ 序列化差异被抵消掉。
    // ⚠️⚠️ 两侧还要按**武装之前**的口径比（`design/0051` §2.3）：`#doc` 挂上来之后
    //    `armTaskBoxes()` 会给每个任务项方框**摘 `disabled`、加 `tabindex="-1"`**（那是
    //    有意为之的改写，WebKit 不给 `disabled` 控件派发鼠标事件）。不比之前先抹掉这两项，
    //    A1 就会红在一条**正确**的行为上（2026-10-27 实测：blocks 差 8 字符、tasks 差 14）。
    function 规范(html) {
      const t = document.createElement('div');
      t.innerHTML = html;
      const 框 = t.querySelectorAll('input.task-list-item-checkbox');
      for (let i = 0; i < 框.length; i++) {
        框[i].removeAttribute('disabled');
        框[i].removeAttribute('tabindex');
      }
      return t.innerHTML;
    }
    const 期望 = 规范(D.html);
    const 实际 = 规范(d.innerHTML);
    记('A1 正文与夹具 HTML 解析后相同', 实际 === 期望,
      实际 === 期望 ? '' : ('长度 ' + 实际.length + ' vs ' + 期望.length));
    记('A2 块表与 DOM 数量对得上', d.children.length === p.blocks.length,
      'DOM ' + d.children.length + ' / 块表 ' + p.blocks.length);
    记('A3 开关来自快照（live_edit=true）', 计数('begin_edit') === 0,
      '启动时不该有 begin_edit（有 ' + 计数('begin_edit') + ' 次）');
    记('A4 启动时没有覆盖层', !主机(), '');

    const base = 几何();
    out.摘要.块数 = p.blocks.length;
    out.摘要.DOM数 = d.children.length;

    // —— B 段：逐块进入/退出（editable 的块）；C 段：结构块 ——
    const 可编辑 = [];
    for (let i = 0; i < p.blocks.length && i < d.children.length; i++) {
      const wire = p.blocks[i];
      const editable = wire[3] === 1;
      if (!editable) {
        const 前 = 计数('begin_edit');
        点(d.children[i]);
        await frames(2);
        const 有host = !!主机();
        记('C' + i + ' 结构块不进覆盖层', !有host && 计数('begin_edit') === 前,
          有host ? '竟然进了覆盖层' : ('begin_edit +' + (计数('begin_edit') - 前)));
        continue;
      }
      可编辑.push(i);
      const st = await 跑一块(i, p.blocks[i], base, out.摘要);
      if (st === 'fail') break;
      // 每块之后再校一次基线（前一块的恢复是下一块的前置）
      if (!几何相等(base, 几何())) {
        记('B' + i + '-9 基线仍然一致', false, '前一块退出后几何没回到原样');
        break;
      }
    }
    out.摘要.可编辑块 = 可编辑.length;

    // —— D 段：F6（挑**第一个段落块**）——
    let 段落 = -1;
    for (let i = 0; i < 可编辑.length; i++) {
      const k = 可编辑[i];
      if (p.block_kinds[p.blocks[k][0]] === 'Paragraph') { 段落 = k; break; }
    }
    if (段落 < 0) 跳过('D0 F6 进入覆盖层', '夹具里没有可编辑的段落块');
    else await 跑F6(段落, base, out.摘要);

    // —— N 段：`bugs/0015`（行级排版跟着源码走）——
    // ⚠️ 必须排在 D 之后、G 之前：D 段会往文里敲字再撤销，N 段自己也会撤销并退出，
    //    两者都以"几何回到基线"收尾 ⇒ 谁先谁后都不互相污染；而 G/E 那两段要求"未改动"的基线。
    await 跑行级排版(base, out.摘要);

    // —— O 段：**操作 × 不变量**（e2e 探测器）——
    // ⚠️ 必须排在 D/N 之后、G 之前：它也会改动文档（回车 / 敲字 / 删除），
    //    但每一类都以「⌘Z 逐字收回 ＋ Escape」收尾 ⇒ 与 G/E 那两段"未改动"的前提不冲突。
    await 跑操作矩阵(base, out.摘要);

    // —— W 段：`⌘↵` **新起一段**（`design/0052` U7 / `bugs/0024`）——
    // ⚠️⚠️ **必须排在"任何一次提交"之前**（这里在 O 之后、Z1 / G / E1 / H 之前）：
    //    假后端不渲染 Markdown，P/Q/V/H 段一旦提交过，`#doc` 就是**旧 HTML** 而会话正文
    //    已经前进 ⇒ 本段的两个 oracle 分属两个世界，会自己造出假红。
    // ⚠️⚠️ **但本段自己会提交**（`⌘↵` 就是一次提交；撤销也是一次）⇒ 它把 `render_preview`
    //    从 0 推上去，**E1 的口径必须跟着改成"W 之前零重渲 ∧ W 之后零重渲"**（见 E1 那一行）。
    //    本段收尾逐行回到原样（`W6`），所以排在它后面的 G 段看到的仍是基线正文。
    const 重渲_入W = 计数('render_preview');
    await 跑新起段落(base, out.摘要);
    const 重渲_出W = 计数('render_preview');

    // —— 全程未捕获异常：产品处理器里抛错时，屏幕上"什么都没发生"，
    //    与"按键没接线"**同形** ⇒ 必须单独记一条，⛔ 别指望别的判据看得出来。——
    记('Z1 全程没有未捕获异常', (window.__ERR || []).length === 0,
      (window.__ERR || []).length === 0 ? ''
        : JSON.stringify((window.__ERR || []).slice(0, 4)));

    // —— G 段：§7.1 步骤 0d（长代码行：块内横滚、整篇不横移）——
    await 跑长代码行(base, out.摘要);

    // —— E 段：无改动退出不重渲 ——
    // ⚠️ 2026-10-28 原地改口径（⛔ 不是新加一条）：W 段**故意**提交（`⌘↵` ＋ 撤销各一次），
    //    所以「整轮一次都没重渲」不再成立。改成两句**一起**判：
    //    ① `重渲_入W === 0` —— W 段之前（A–O）确实一次都没重渲（这就是原来那条的意思）；
    //    ② `计数() === 重渲_出W` —— W 段之后到现在（G 段也跑完了）**没有再重渲一次**。
    //    ⛔ 别把它写成 `计数() === 0`：那会把 W 的正当提交判成失败；
    //    ⛔ 也别把它整个删掉：那样"退出却提交了"这条缺陷就没人看着了。
    记('E1 无改动退出不重渲（W 段之前 0 次、之后 0 次）',
      重渲_入W === 0 && 计数('render_preview') === 重渲_出W,
      'W 段之前 ' + 重渲_入W + ' 次（必须 0）／W 段自身 ' + (重渲_出W - 重渲_入W)
        + ' 次／W 段之后 ' + (计数('render_preview') - 重渲_出W) + ' 次（必须 0）');

    // —— H 段：§7.1 步骤 0h（最小纵向链路）——
    // ⚠️ **必须排在 E1 之后**：E1 判的是"整轮到目前为止一次都没重渲"，而 H 段**故意**会
    //    触发一次真正的提交（`render_preview` ＋ `save_document`）。
    if (段落 < 0) 跳过('H0 纵向链路：进入覆盖层', '夹具里没有可编辑的段落块');
    else await 跑纵向链路(段落, base, out.摘要);

    // —— L 段：§7.1 步骤 0f（键入的主线程代价 vs 块大小）——
    // ⚠️ **必须排在 H 之后**：H 段故意提交一次改动（写盘 ＋ 重渲），那之后 `fullText` 与
    //    假后端回的载荷不再逐字一致；L 段自己会撤销、也不写盘，但排在它后面才不会让
    //    L 的键入污染 H 的计数（`save_document` / `render_preview` 的增量）。
    await 跑键入延迟(out.摘要);

    // —— V 段：**任务项就地打勾**（`design/0051`）——
    // ⚠️⚠️ **必须排在 E1 / H / L 之后、P / Q 之前**，顺序是有理由的：
    //    ① E1 判"整轮到目前为止一次都没重渲"、H 判 `save_document` 的增量 ⇒ 排在它们前面会判红；
    //    ② ⭐ **必须是干净会话**：`INV-TASK-06` 后半条明令「进来之前已经脏就不替你顺手保存」，
    //       而 P 段与 Q 段都会**故意**提交（退出通道要换块、单元格要写回）⇒ 排到它们后面，
    //       `wasDirty` 恒真 ⇒ 打勾永远不写盘，`V3`/`V3b`/`V4b` 跟着红——**那是顺序造成的假红**。
    //       这一段自己收尾时逐字节回到基线（`V5`），所以排在 P/Q 前面不会污染它们。
    await 跑任务项(base, out.摘要);

    // —— P 段：**退出通道**（`bugs/0018`）——
    // ⚠️ **必须排在 E1 / H 之后**：这一段会**故意**提交并重渲（点另一块 ⇒ 先提交再进入），
    //    E1 判的是"整轮一次都没重渲"，排在它前面会把 E1 判红。
    // ⚠️ 与 B 段不重复：B 段只走「`键(ta,'Escape')`」一条路，且**直接往 `ta` 派发**（判不了焦点在哪）；
    //    这一段补的是"焦点前提 ＋ 其余四条退出路 ＋ 提交后重渲那一面"。
    await 跑退出通道(base, out.摘要);

    // —— Q 段：**表格单元格**（`design/0049`）——
    // ⚠️ **必须排在 E1 / H 之后**：这一段会**故意**提交两次（每次一次 `render_preview`），
    //    E1 判的是"整轮一次都没重渲"。
    await 跑单元格(base, out.摘要);

    // —— R 段：**鼠标拖选**（`bugs/0031` 的块内那一半）——
    // ⚠️ **必须排在 X 之前**（X 会注入 40 px 内边距并改页面滚动余量，且它必须最后）。
    // ⚠️ 这一段**只造选区、不改正文** ⇒ 不产生 `render_preview`，E1 的口径不受影响。
    await 跑鼠标拖选(base, out.摘要);

    // —— X 段：**锚定补偿的端到端对照**（故障注入，`design/0052` U6）——
    // ⚠️ 必须排在最后：它会临时把页面变成"能滚的"并注入 40 px 内边距，
    //    虽然 X3 会清场，但排在 G/E/H/L/V/P/Q 之后才不需要证明"清场对它们无影响"。
    await 跑锚定对照(out.摘要);

    // —— F 段：自证 ——
    out.环境.未预期命令 = (window.__UNKNOWN || []).slice(0, 8);
    out.环境.IPC调用数 = (window.__IPC || []).length;
    out.环境.有焦点 = document.hasFocus();
    // ⚠️ **兜底次数要如实记**：`> 0` 说明这台机器上离屏窗口的 rAF 被节流了，
    //    于是"帧序稳定性"（D1/D9）与"帧间"那几条**不承重**——⛔ 别把它们读成绿。
    out.环境.rAF兜底次数 = rAF兜底;
    out.环境.前台文本 = String((document.getElementById('status') || {}).textContent || '').slice(0, 120);
    return out;
  }

  window.__RUN = window.__DIAG === true ? 诊断 : run;
})();
