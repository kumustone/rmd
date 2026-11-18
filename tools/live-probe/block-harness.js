// ⭐ `design/0047` §7.2 第 6 条（`make probe-live-block`）的**页面侧判据**。
//
// 它跑的是**真应用**：`src/index.html` ＋ 全部 `src/**`（含 `main.js` 与 `src/live/**`），
// 后端是 `fake-tauri.js`（回 Stage A 用真 comrak 导出的载荷）。
// ⇒ 驱到的是真的 `onLiveDocDown` / `makeLiveView` / `swapLiveView`，⛔ 不是第二份实现。
//
// 判据覆盖（逐条列在这里，⛔ 别只在代码里）：
//   A 启动：真应用起得来、`#doc` 的 DOM 与夹具 HTML 逐字相同、块表与 DOM 数量对得上
//   B 逐块（F5 三段 ＋ Prep/Swap 几何 ＋ 退出逐像素恢复），对**每一个**块各一条
//     ⭐ `-3c` 是装饰层**唯一**的判据：Markdown 标记在编辑态必须**恒定**藏掉
//        （2026-10-26 的真缺陷：`createField` 只返回 `StateField`、没接
//        `EditorView.decorations.from(field)` ⇒ 一个标记都没藏，而**任何几何判据都看不见**）。
//        ⭐ `design/0061` L1（2026-11-05）：**没有"活动行"**了——点进哪一行都照样藏。
//     ⚠️ `-3a/-3b` 取代了"|ΔH| ≤ 0.5"那一条单判据：视图里只剩 `>` 的空行在渲染态里是
//        **段间距** ⇒ 这些差是**结构性的**，不是量错。
//        ⭐ `design/0052` U6 起 `-3b` 判的是**锚点**（被点那一行的行顶不位移），
//        上界那条判据已废（`INV-KERNEL-05`：块永远进得去）——结构性的高度来源只由
//        `live/decorations.js::layoutSlack()` 数出**处数**印在说明里，⛔ 它不是允许量：
//        2026-11-09 起目标值为 0 处，有就是缺陷（`design/0047` §10 尾注）。
//     ⭐ `-10` **光标移动零位移**（用户 2026-11-11 裁定）：进入编辑态后把光标逐位移动
//        （块首 / 行中 / 行尾 / 末行 / 块尾 ＋ 一次选区），**每一行的行顶与行高、块顶与块高**
//        都必须逐项不变。⚠️ 本条此前不存在——B 段只验"点进去那一下"，光标走位的格式影响从没量过。
//   C 结构块（`editable=0`）：点了**不进**覆盖层，且**不调** `begin_edit`
//   LNK 链接（`design/0047` §4.2 / `bugs/0059`）：点正文里的 `<a href>` **不进**覆盖层、
//     **不调** `begin_edit`，且那一次 `mousedown` **没有被 `preventDefault`**（否则跳转被挡）。
//     ⚠️ 只在真有链接的夹具上产判据；其余记 `摘要.LNK = {适用:false}`，⛔ 不记通过。
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
//   U 列表项上的**多输入序列**（2026-11-11 用户要求「自己执行多输入测试」）：无序／有序／任务
//     三种列表行各进一次块，每步都拿**上一步的期望全文**当基准，比对全文＋光标＋行号：
//     `U1` 行尾逐字键入／`U2` 回车续项（标记按种类续：`- ` / 编号＋1 / `- [ ] `）／
//     `U3` 空项再回车**删标记退列表**／`U4` 组合期零字节、上屏逐字落进正文／
//     `U5` 正文中间插入只多一个字符／`U6` 每个场景 `⌘Z` 逐字撤回基线／
//     `U7` 退出后会话正文与 IPC 计数**零变化**／`U7b` 几何回到基线。
//     ⚠️⚠️ 为什么必须比**全文**：`bugs/0312` 里每一步单独看都合法（选区合法、事务合法），
//        整条序列却把文字写进了**别的行**——单步判据看上去全绿。
//     ⚠️ 列表行的种类/前缀来自**源码独立 oracle**（不读 `data-rmd-li`）；引用块里的列表跳过。
//     ⚠️ 只在**含可测列表行的可编辑块**上产判据；其余记 `摘要.U = {适用:false}`，
//        **既不记通过也不记跳过** ⇒ 由 `block-probe.sh` 的 `U-覆盖` 把关。
//   W `⌘↵` **新起一段**（`design/0052` U7 / `bugs/0024`，⭐ **2026-10-28 按用户更正整段重写**）：
//     `⌘↵` ＝ 跳出这一块 → 在它**后面**插三行空行 → 光标落进新段落 → **仍留在编辑态**
//     （旧的一套"退出到阅读态 ＋ 自绘 `.rmd-caret-hint` ＋ 等按键"是**错误需求**，⛔ 已撤回）。
//     判据：仍在编辑态且焦点在离屏 `textarea`／光标在新段落段首／三行空行**插在这一块之后**
//     （整篇逐行比）／新宿主紧跟原块／**一次 `⌘Z` 同时恢复正文与光标**／中文组合期零字节变动、
//     上屏后逐字落进新段落／敲字之后要 `⌘Z` **两次**（⛔ 一次不跨层）／裸 `Enter` 仍留在这个块里。
//     ⭐ `bugs/0300`（2026-11-09）：列表项行尾回车还判 `W7e`（光标偏移 == 新行正文起点、
//       **画出的插入符在方框之后**）／`W7f`（回车后**立刻**敲字落进新行正文，⛔ 不是标记前）／
//       `W7h`（嵌套任务项 `depth ≥ 2` 上重跑）。⚠️ 只判偏移/字节在缺陷上恒绿——离屏实测
//       `side: 1` 与 `side: -1` 的字节逐字相同，差别只是插入符画在方框左缘还是右缘之后。
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
//   Y 进入编辑态恒等（`design/0061` §5 `INV-LIVE-14`，**2026-11-05 新增**）：挑一块**首行带行内标记**
//     的可编辑块，阅读态记下每一**视觉行**的 top / height / 可见文本，点进编辑态后逐行比：
//     ⭐ `Q35` 活动行**也不许**露源码标记（`Q35b` 是负对照：源码里确有此标记）；
//     ⭐ `Q36` 行数相同、每行**块内相对 top**/height 差 ≤ 0.5 px、可见文本逐行相同，
//        **绝对 top 也不许动**（`INV-LIVE-04` ①：进入瞬间逐像素不动，含滚动锚；
//        ⚠️ 2026-11-09 收紧——旧注里"整块在视口里移动是允许的（`anchorAt`）"已作废）。
//     ⚠️⚠️ **判"可见"必须按 `Range` 逐字矩形的宽高 > 0**，⛔ 不能用 `textContent`——
//        `Decoration.replace` 藏掉的字符仍可能在 DOM 文本里，用它判会**恒绿**。
//     ⚠️ 阅读态没有 `.cm-line` ⇒ "行"取视觉行（两边同一把尺）；没有可用的块时记
//        `摘要.Y = {适用:false}`，**既不记通过也不记跳过** ⇒ 由 `block-probe.sh` 的 `Y-覆盖` 把关。
//   T 块贴**视口下沿**时进入编辑（`INV-LIVE-04` ①，**2026-11-09 新增**）：B 段每块都先
//     `scrollIntoView({block:'start'})` ⇒ 只覆盖"块贴视口顶"这一种摆放，而用户报的形态
//     （`bugs/0297`，非最大化窗口里点表格）发生在块靠近下沿时。本段把一块的底边挪到
//     视口下沿内侧 24 px，点**块的下部**，判 `T2` ΔH ≤ 0.5 px / `T3` 块顶文档坐标 Δ ≤ 0.5 px /
//     `T4` ΔscrollTop ≤ 0.5 px（⛔ 不许补滚把重排藏起来）。`T0` 先证明摆放真的做到了。
//   F 自证：没有未预期的 IPC 命令；前台自证在 swift 那一侧（见 probe.swift）
//
// ⚠️⚠️ **F6 的另外半截（可见首帧闪不闪源码）离屏验不了**（`design/0047` §7.1 0c-②）
//    ⇒ 那条**如实留在人工那一档**，⛔ 本文件不假装验过它。
//
// ⚠️ 容差：**0.5 px**（与 `src/live/index.js::HEIGHT_TOLERANCE` 同一个口径）。
//    ⛔ 不逐位断言历史小数——那些数属于 `notes/0036`/`0037` 的取证，不是合同。
//    ⛔⛔ **2026-11-09**：`TOL` 的语义**只有一个：量化下限（同一个像素）**。
//    它不是"允许半像素的布局变化"，⛔ 也不是"结构差容得下"。⇒
//    ① 判据里凡是用 `TOL` 兜住一个**算得出来的结构差**（围栏行、空 `>` 行、光标行显示源码）
//       的，一律作废——那些是缺陷，不是允差（见 `BUGS` 里 0298/0021/0091/0102/0299）；
//    ② 进入瞬间的判据（`B{i}-3a/3b/4/5/6`、`Q41`、`X1`）都必须能说清"差的是同一个像素"；
//    ③ ⛔ 不许为了让某条判据变绿而调大 `TOL`（用户 2026-11-09：「用户体验第一，
//       先不过于考虑实现成本」）。
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
    // ⭐ 把"正在判哪一条"记到 `window.__PHASE`：`Z1` 抓到未捕获异常时，页面副本的
    //    `error` 钩子会把当时的阶段一并记下。⚠️ `file://` 下的未捕获异常消息恒为
    //    `Script error.`（跨源，拿不到文件名/行号）⇒ 没有这个标记就只能知道"抛过"。
    try { window.__PHASE = String(id); } catch (e) { void e; }
    out.判据.push({ id: id, ok: ok === 'skip' ? 'skip' : !!ok, msg: String(msg || '') });
  }
  function 跳过(id, msg) { 记(id, 'skip', msg); }

  // ── 探针侧异常陷阱 ────────────────────────────────────────────────
  //
  // ⚠️⚠️ **为什么需要它**（2026-11-05 实测）：页面副本的 `window.onerror` 在 `file://` 下
  //    拿到的恒是 `Script error.`（跨源 ⇒ 消息/文件名/行号/栈全被抹掉），而产品在事件
  //    处理器里抛异常时**不会**让 `dispatchEvent` 抛出来 ⇒ 探针看到的是「按了没反应」，
  //    与「按键没接线」**长得一模一样**。`design/0061` L2/L3 落地那一轮就卡在这里：
  //    O 段"回车不长行 / 敲字不落文档"，五条判据同时红，却一个字的原因都没有。
  // ⭐ 办法：给**产品模块**的每一个函数套一层 try/catch，消息与栈记进 `window.__THREW`，
  //    然后**原样重抛**（行为不变）。⛔ 不改产品文件、⛔ 不吞异常、⛔ 不改变返回值。
  //    ⚠️ `EditorView.prototype.dispatch/update` 也套：它是所有文本变更的唯一出口。
  const 抛出 = [];
  try { window.__THREW = 抛出; } catch (e) { void e; }
  function 记录抛出(名, e) {
    if (抛出.length >= 12) return;
    const msg = String((e && e.message) || e);
    // ⚠️ 同一个函数每帧都抛 ⇒ 同一条只留一次（否则 12 条全被它占满）。
    for (let i = 0; i < 抛出.length; i++) {
      if (抛出[i].名 === 名 && 抛出[i].消息 === msg) return;
    }
    抛出.push({
      名: 名, 消息: msg,
      栈: String((e && e.stack) || '').split('\n').slice(0, 4).join(' | '),
    });
  }
  function 套陷阱(前缀, 对象) {
    if (!对象 || typeof 对象 !== 'object') return;
    let keys = [];
    try { keys = Object.keys(对象); } catch (e) { return; }
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = 对象[k];
      if (typeof v !== 'function') continue;
      对象[k] = function () {
        try { return v.apply(this, arguments); }
        catch (e) { 记录抛出(前缀 + '.' + k, e); throw e; }
      };
    }
  }
  (function 装陷阱() {
    const r = window.rmd || {};
    let ks = [];
    try { ks = Object.keys(r); } catch (e) { void e; }
    for (let i = 0; i < ks.length; i++) 套陷阱('rmd.' + ks[i], r[ks[i]]);
    const CM6 = window.rmdCM6;
    const p = CM6 && CM6.EditorView && CM6.EditorView.prototype;
    if (p) {
      ['dispatch', 'update'].forEach(function (k) {
        const orig = p[k];
        if (typeof orig !== 'function') return;
        p[k] = function () {
          try { return orig.apply(this, arguments); }
          catch (e) { 记录抛出('EditorView.' + k, e); throw e; }
        };
      });
    }
  })();

  // ── 基础工具 ──────────────────────────────────────────────────────
  function docEl() { return document.getElementById('doc'); }

  /**
   * `#doc` 的**顶层块节点**：元素 ＋ 注释，按文档顺序。
   *
   * ⭐ 这里 ⛔ **不自己过滤**：直接问产品那份实现（`live/blocks.js::topNodes`，`bugs/0080`）。
   *    探针与产品各写一份过滤，症状与"块表对不上"一模一样，而单测只盖住其中一份。
   * ⚠️ **块下标一律用它**（`p.blocks[i]` ↔ `块节点()[i]`）：`INV-SEC-01` 下块级原始 HTML
   *    渲染成 `<!-- raw HTML omitted -->` **注释**，用 `d.children` 取会把 HTML 块之后的
   *    每一个块**错位一格**。而"可点/可量"的循环仍用 `d.children`——注释节点没有几何，
   *    点它的中心会落到别人身上。
   */
  function 块节点() {
    const d = docEl();
    const LB = window.rmd && window.rmd.liveBlocks;
    return d && LB && typeof LB.topNodes === 'function' ? LB.topNodes(d) : [];
  }

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
    const 表 = 块节点();
    const arr = [];
    for (let i = 0; i < 表.length; i++) {
      const el = 表[i];
      // ⚠️⚠️ 下标必须与**块表**对齐（`bugs/0080`）：注释节点（`INV-SEC-01` 下的块级原始 HTML）
      //    没有 `getBoundingClientRect`，但⛔ 也不能把它剔掉——一剔，`B{i}-4` 量到的就是
      //    **下一块**（2026-11-04 实测：rawhtml 的块 3 量到块 5，Δtop 0.532 px 假红）。
      //    ⇒ 给一个与块下标对齐的零几何占位，两边一致 ⇒ 比较仍是"同一块"。
      if (!el || el.nodeType !== 1) {
        arr.push({ top: -1, h: 0, tag: '#comment', host: false });
        continue;
      }
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

  /** 区间 `[from, to)` 内**块顶**的最大位移（`D1` 用它量"活动块之上的块"）。 */
  function 区间最大位移(a, b, from, to) {
    let m = 0;
    for (let i = from; i < Math.min(a.length, b.length, to); i++) {
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

  /**
   * 宿主里**第一行真有字形**的行顶（视口坐标）；一行字都没有则 `null`。
   * ⭐ `design/0061` L1 起块首可能是**恒定塌掉**的围栏行（0 高、一个字都不画）
   *    ⇒ 直接用"第一个 `.cm-line`"会落到行盒顶边，比真字形顶高约 2.6 px（假位移）。
   */
  function 首行字顶(host) {
    if (!host) return null;
    const 行们 = host.querySelectorAll('.cm-line');
    for (let k = 0; k < 行们.length; k++) {
      const g = 首字顶(行们[k]);
      if (g !== null) return g;
    }
    return null;
  }

  function 滚动量() {    const ev = document.scrollingElement || document.documentElement;
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
    //    多行的块里，"点在哪一行"决定光标落在哪——不落在同一行，几何/文本的基线就对不上。
    //    ⭐ `design/0061` L1 之后**不再有"活动行"**（点哪行都不改变可见文本），
    //    这个约束只剩"点得可复现"这一条。
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
   * ⭐⭐ **与产品实现无关的 oracle**：这一段源码在编辑态应该显示成什么样。
   *
   * ⚠️⚠️ 为什么必须自己写一遍（`INV-KERNEL-07`，`docs/bugs/0025`）：
   *    B-3c 从前拿 `markers()` 算期望 —— 那是**拿产品给产品打分**，
   *    装饰层把标记藏错、或者 `markers()` 自己算错，两边一起错，判据**恒绿**。
   *    这一段只认源码文本，⛔ 一次都不调 `markers()`。
   *
   * ⚠️ 它**不是**第二份实现，只覆盖**夹具里真有的**那几种构造（标题 / 引用 / 强调 / 删除线 /
   *    行内代码 / 链接图片）；围栏行与围栏内部**按各自规则**处理。
   *    遇到不认识的构造它只会"少藏"，判据随即变红——那是**该红的**，⛔ 别在这里补宽容。
   *
   * ⭐ `design/0061` L1（2026-11-05）：**没有"活动行"这回事**了——隐藏集合是源码的纯函数，
   *    点进哪一行都不改变可见文本。⇒ 本函数 **不接受** `原样行` 参数（从前那个"光标所在行
   *    显示源码"的口径已被设计取代，⛔ 别再加回来）。
   *
   * @param {string} 源
   * @param {Object<number, boolean>|null} [续行] 行号 → 这一行是**列表项的续行**
   *   （`bugs/0102`：编辑态把行首缩进也当标记藏掉，阅读态由 `<li>` 的内容列决定起点）。
   *   ⚠️ 只由调用方在**编辑态那行确实带 `data-rmd-li` ∧ oracle 自己判为续行**时置位；
   *   ⛔ 不对普通正文行剥行首空白（否则这条判据会被"永远对齐"废掉）。
   * @returns {string[]} 逐行的期望可见文本
   */
  function 期望可见行(源, 续行) {
    const lines = String(源 === undefined || 源 === null ? '' : 源).split('\n');
    const out = [];
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // ⚠️ 引用里的围栏（`> ```）与围栏内部：先剥 `>` 前缀再认 / 再比。
      //    ⛔ 别只剥围栏行不剥内容行——编辑态的 `QuoteMark` 是藏掉的，内容行不该带 `> `。
      const 无引用 = 去引用前缀(line);
      const t = 无引用.trim();
      const isFence = t.slice(0, 3) === '```' || t.slice(0, 3) === '~~~';
      if (isFence) {
        // ⭐ `design/0052` U5 ＋ `0061` L1：围栏行**恒整行塌掉** ⇒ 可见文本是**空串**
        //    （⛔ 不是"留下 ```"——那是 U3/U4 的旧口径）。
        out.push('');
        fence = fence === null ? t.slice(0, 1) : (t.slice(0, 1) === fence ? null : fence);
        continue;
      }
      if (fence !== null) { out.push(无引用); continue; }   // 围栏内部：一个字都不动
      let s = line;
      // 引用前缀：每一层 `>` ＋ 可选一个空格
      s = s.replace(/^(?:>[ \t]?)+/, '');
      // ⭐ Setext 的下划线行（`bugs/0089`）：阅读态里它是标题的一部分，**不存在这一行**
      //    （编辑态由 `cm-rmd-collapsed` 塌成 0 高）⇒ 期望可见文本是空串。
      //    ⚠️ 只在**上一行是非空的正文行**时才算下划线：空行之后的 `---` 是分隔线（`<hr>`），
      //    列表项之后的 `-` 是空条目——那两种都不是 Setext。
      const 上 = i > 0 ? lines[i - 1].replace(/^(?:>[ \t]?)+/, '').trim() : '';
      if (i > 0 && 上 !== ''
          && !/^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.test(上)
          && !/^#{1,6}(?:[ \t]|$)/.test(上)
          && /^[ \t]*(?:=+|-+)[ \t]*$/.test(s)) {
        out.push('');
        continue;
      }
      // ⭐ 列表标记与行首缩进（`bugs/0092`）：渲染态画在缩进带里，**不占正文宽度**。
      s = s.replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/, '');
      // ⭐ 任务标记：渲染态是方框（`<input>`），方框之后的正文才是可见文本。
      s = s.replace(/^\[[ xX]\](?:[ \t]+|$)/, '');
      // 标题：`#{1,6}` ＋ 可选一个空格（空的 `##` 也是标题，`bugs/0016`）
      s = s.replace(/^#{1,6}(?:[ \t]|$)/, '');
      // ⭐ 列表项**续行**的行首缩进（`bugs/0102`）：阅读态由 `<li>` 内容列决定起点
      //    （HTML 把行首空白折叠掉），编辑态由装饰层把"行首到第一个非空白"一并藏掉。
      //    ⚠️ 前置条件由调用方给：那一行在编辑态带 `data-rmd-li` **且** oracle 自己判出
      //    "行首有空白、且没有自己的列表标记" ⇒ 才剥。⛔ 普通正文行的空白一个都不剥。
      if (续行 && 续行[i] === true && /^[ \t]/.test(s)) s = s.replace(/^[ \t]+/, '');
      // ⭐ 硬换行（`bugs/0093`）：`\` 与行尾空格都不可见。
      //    反斜杠要**奇数个**才算硬换行（`\\` 是两个转义字符，不是换行标记）。
      out.push(藏行内标记(s).replace(/[ \t]+$/, '').replace(/\\+$/, function (m) {
        return m.length % 2 === 1 ? m.slice(0, -1) : m;
      }));
    }
    return out;
  }

  /**
   * ⭐ **这一行源码在编辑态有没有 `.cm-line`**（`design/0061` L1 ＋ `bugs/0298`）。
   *
   * `design/0052` U5/`0061` L1 起围栏分隔行整行塌掉；`bugs/0298`（2026-11-12）之后它
   * 走的是**块级 `Decoration.replace` ＋ `estimatedHeight = 0` 的 widget** ⇒ 那两行在
   * DOM 里**连 `.cm-line` 都没有**（此前是"有行盒、字号 0"的旧形态）。
   * Setext 下划线行同族（`bugs/0089`，`cm-rmd-collapsed`）。
   * ⇒ 任何"`.cm-line` 与源码行一一对应"的判据都必须先扣掉这些行，否则围栏一多就整族假红。
   * ⚠️ 这里只认**源码形状**（围栏分隔 / Setext 下划线），⛔ 不读产品 plan。
   * @param {string} 源
   * @returns {Array<'none'|'fence'|'setext'>} 与源码行一一对应
   */
  function 塌行表(源) {
    const lines = String(源 === undefined || 源 === null ? '' : 源).split('\n');
    const out = [];
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const 无引用 = 去引用前缀(lines[i]);
      // ⚠️ 与 `行品种()` **同一条**围栏判据（`^ {0,3}` ＋ ≥3 个 `` ` ``/`~`）：
      //    两边认法不一致时，同一行会出现"品种说 code、塌行表说 fence" ⇒ `逐行对照` 的
      //    行数断言假红。⛔ 别在这里用 `trim()` 后的前 3 个字符（会把缩进代码块里的 ``` 认成围栏）。
      const fm = /^ {0,3}(`{3,}|~{3,})/.exec(无引用);
      if (fm) {
        out.push('fence');
        const 符 = fm[1].charAt(0);
        fence = fence === null ? 符 : (符 === fence ? null : fence);
        continue;
      }
      if (fence !== null) { out.push('none'); continue; }
      // 与 `期望可见行` 同一条 Setext 判据（空行后 / 列表项后 / 标题后的 `---` 都不是下划线）
      const 上 = i > 0 ? 去引用前缀(lines[i - 1]).trim() : '';
      const 是下划线 = i > 0 && 上 !== ''
        && !/^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.test(上)
        && !/^#{1,6}(?:[ \t]|$)/.test(上)
        && /^[ \t]*(?:=+|-+)[ \t]*$/.test(无引用);
      out.push(是下划线 ? 'setext' : 'none');
    }
    return out;
  }

  /** `期望可见行` 的行内那半：代码段 → 链接图片 → 删除线 → 强调（强在弱前）。 */
  function 藏行内标记(s) {
    let out = String(s);
    // 行内代码：反引号串成对，内容原样（⛔ 里面的 `**` 不当强调）。
    // ⚠️⚠️ 代码段必须**先摘出去**再做后面的替换（2026-11-16 实测）：直接 `$2` 留在原串里，
    //    下面那几条强调正则会继续扫它的内容 ⇒ `` `B*-3a` `` 被算成强调、期望可见文本少了 `*`
    //    （`bugs/0318` 的夹具文字踩到，B26-3c 假红：期望「B-3a」/ 实际「B*-3a」，而**产品是对的**）。
    //    占位符用私用区字符：⛔ 不是数字/字母，既不会被强调/删除线正则咬到，也不会改变
    //    那条 `intraword` 判据的邻接关系。
    const 码段 = [];
    out = out.replace(/(\x60+)([\s\S]*?)\1/g, function (m, ticks, inner) {
      void m; void ticks;
      码段.push(inner);
      return '\u0000' + String.fromCharCode(0xe000 + 码段.length - 1) + '\u0000';
    });
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
    // 代码段原样放回（内容一个字符都不改）。
    out = out.replace(/\u0000([\uE000-\uF8FF])\u0000/g, function (m, c) {
      void m;
      return 码段[c.charCodeAt(0) - 0xe000];
    });
    return out;
  }

  // ⚠️ 这里曾有一个 `有标记的行数()` —— 它给 B-3b 的上界多加了一项产品没有的允许量
  //    （`docs/bugs/0025`：探针比产品宽 ⇒ 探针全绿推不出用户点得进去）。2026-10-27 已删。
  //    ⛔ **2026-11-09 起连"允许量"这个概念都没了**（`INV-LIVE-04` ①）：探针里**不许**出现
  //    任何"这个差值是允许的"算式；`layoutSlack()` 的输出只当诊断印进说明，目标恒为 0。

  /**
   * ⭐⭐ **"可见"的尺子**：把一棵子树里**真的看得见**的字符按**视觉行**归带。
   *
   * ⚠️⚠️ **⛔ 不能用 `textContent`**（`design/0061` §7 第 3 条）：`Decoration.replace` 藏掉的
   *    标记字符**仍可能在 DOM 文本里**（零宽替换/零字号），`textContent` 照样把它们数进去
   *    ⇒ "标记藏掉了"与"标记还在"输出一模一样，`Q35` 会变成一条恒绿的废话。
   * ⭐ 判法：**逐字符**造一个 `Range`，取 `getBoundingClientRect()`；`width > 0 && height > 0`
   *    才算"看得见"。这正是用户眼睛的那条判据（零字号 `cm-rmd-fence` 的高度是 0，
   *    被 `display:none` 摘掉的节点连矩形都没有）。
   * ⚠️ 之所以用**视觉行**而不是 `.cm-line`：阅读态根本没有 `.cm-line`（它是产品渲染出来的
   *    `<p>`/`<h1>`/…），只有"按字盒**竖直重叠**归出来的视觉行"是两边都存在的公共尺子。
   *    编辑态一个 `.cm-line` 折成两行时，这里同样归成两带 ⇒ 与阅读态逐带对得上。
   * ⚠️⚠️ 归带的尺子是**竖直重叠**，⛔ 不是"top 相等"：行内代码的字盒比正文高 1 px 以上
   *    （实测 1.36 px），按 top 归会把同一行劈成两带（2026-11-05 实测踩到）。
   * ⚠️ 组合串（`.cm-rmd-preedit`）是行内 widget，**不属于正文**：整棵子树跳过。
   *
   * @param {Element|null} root
   * @returns {Array<{top:number, height:number, text:string}>} 自上而下的视觉行
   */
  function 可见行带(root) {
    if (!root) return [];
    // —— ① 逐字取矩形：`width > 0 && height > 0` 才算"看得见" ——
    const 字 = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const rg = document.createRange();
    let t;
    let seq = 0;
    while ((t = w.nextNode())) {
      const p = t.parentNode;
      if (p && p.closest && p.closest('.cm-rmd-preedit')) continue;
      const s = t.nodeValue || '';
      for (let i = 0; i < s.length; i++) {
        const c = s.charAt(i);
        // ⚠️ 源码里的换行不是可见字符；制表符在有 `tab-size` 时占宽，但正文里不该出现。
        if (c === '\n' || c === '\r' || c === '\t') continue;
        let box = null;
        try {
          rg.setStart(t, i);
          rg.setEnd(t, i + 1);
          const rs = rg.getClientRects();
          for (let k = 0; k < rs.length; k++) {
            // ⚠️ 宽或高为 0 ⇒ **看不见**（`Decoration.replace` 零宽替换的形态就在这里被筛掉）。
            if (rs[k].width > 0 && rs[k].height > 0) { box = rs[k]; break; }
          }
        } catch (e) { void e; }
        if (!box) continue;
        字.push({ c: c, top: box.top, left: box.left, right: box.right, bottom: box.bottom, seq: seq++ });
      }
    }
    // —— ② 归带：**竖直重叠**超过较矮那一段的一半 ⇒ 同一视觉行 ——
    //    ⚠️⚠️ 不能按"字矩形 top 相等（±0.5 px）"归：同一个视觉行里，行内代码/等宽字体的
    //    字盒 `top` 会比正文高 1 px 以上（2026-11-05 实测 1.36 px）⇒ 一行被劈成两带，
    //    `Q36` 会量到 0.5–1.6 px 的假 Δtop（第一次实现就踩到了）。
    //    也⛔ 不能用整块 `Range.getClientRects()` 取行盒：WebKit 对跨行 Range 返回的是
    //    **整个块的一个外接矩形**（实测 2 行被合成 1 带、文字交错）——那是行**块**不是行。
    //    按字盒**竖直重叠**聚类对两者都稳：同行的行内元素互相重叠，相邻行几乎不重叠。
    字.sort(function (a, b) { return (a.top - b.top) || (a.left - b.left) || (a.seq - b.seq); });
    const 带 = [];
    for (let i = 0; i < 字.length; i++) {
      const x = 字[i];
      let b = null;
      for (let k = 0; k < 带.length; k++) {
        const y = 带[k];
        const 重叠 = Math.min(y.bottom, x.bottom) - Math.max(y.top, x.top);
        const 薄 = Math.min(y.bottom - y.top, x.bottom - x.top);
        if (薄 > 0 && 重叠 > 0.5 * 薄) { b = y; break; }
      }
      if (!b) {
        b = { top: x.top, bottom: x.bottom, 字: [] };
        带.push(b);
      } else {
        if (x.top < b.top) b.top = x.top;
        if (x.bottom > b.bottom) b.bottom = x.bottom;
      }
      b.字.push(x);
    }
    // —— ③ 行内按 left 排（DOM 顺序会被 `<strong>`/`<code>` 的嵌套打乱）——
    const 出 = [];
    for (let k = 0; k < 带.length; k++) {
      const b = 带[k];
      b.字.sort(function (a, c) { return (a.left - c.left) || (a.seq - c.seq); });
      const text = b.字.map(function (x) { return x.c; }).join('');
      if (!text) continue; // ⚠️ 没有可见字的行（空行 / 整行被藏）不参与"可见行"比较
      出.push({ top: b.top, bottom: b.bottom, text: text, 字: b.字 });
    }
    出.sort(function (a, b) { return a.top - b.top; });
    return 出.map(function (b) {
      // ⚠️ `width` 是**这一行最后一字的右缘减第一字的左缘**（折行诊断用）：
      //    "同一块宽、每行差一个字"必须能看出是行宽不同还是字宽不同。
      const 首字 = b.字[0];
      const 末字 = b.字[b.字.length - 1];
      const w = (首字 && 末字 && typeof 末字.right === 'number')
        ? 四舍(末字.right - 首字.left) : null;
      return { top: 四舍(b.top), height: 四舍(b.bottom - b.top), text: b.text, width: w };
    });
  }

  /**
   * 这一行源码里**真的会被藏掉**的标记记号（`Q35` 的负对照）。
   *
   * ⚠️ 只认"源码里有、独立 oracle 的可见行里没有"的记号：像 `C#` 这种把 `#` 当正文的
   *    行，oracle 不会把它藏掉 ⇒ 这里也不会把 `#` 当标记（否则 `Q35` 会**假红**）。
   * ⚠️ 覆盖 `design/0061` 夹具里真出现的那几类：标题／引用前缀、加粗、删除线、行内代码、链接。
   *    遇到不认识的构造宁可"少判"（漏报），⛔ 别在这里补宽容把真标记也放过。
   *
   * @param {string} 源行
   * @param {string} 期望行 独立 oracle（`期望可见行`）给的同一条可见行
   * @returns {string[]}
   */
  function 标记记号(源行, 期望行) {
    const 候选 = [];
    if (/^\s{0,3}#{1,6}(?:[ \t]|$)/.test(源行)) 候选.push('#');
    if (/^\s{0,3}>/.test(源行)) 候选.push('>');
    // ⭐ 列表标记与任务标记（`bugs/0092`）：判的是**整段标记**（`- ` / `1. ` / `[ ] `），
    //    不是单个 `-` —— 单个连字符在正文里太常见，会把真可见的 `-` 误判成"没藏"。
    const 列 = /^\s{0,3}((?:[-*+]|\d{1,9}[.)])[ \t]+)/.exec(源行);
    if (列) 候选.push(列[1]);
    const 任 = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+(\[[ xX]\][ \t]+)/.exec(源行);
    if (任) 候选.push(任[1]);
    if (源行.indexOf('**') >= 0) 候选.push('**');
    if (源行.indexOf('~~') >= 0) 候选.push('~~');
    if (/`+[^`]+`+/.test(源行)) 候选.push('`');
    if (/\[[^\]]*\]\([^)]*\)/.test(源行)) 候选.push('](');
    // ⭐ 硬换行（`bugs/0093`）：行尾的反斜杠。
    if (/\\$/.test(源行)) 候选.push('\\');
    return 候选.filter(function (t) { return String(期望行).indexOf(t) < 0; });
  }

  /**
   * 挑一块**首行带行内标记**的可编辑块（`Q35`/`Q36` 的靶块）。
   *
   * ⚠️ 优先段落：段落是用户日常"点进去改字"的形态（`design/0061` L1 之后标题块与段落
   *    在隐藏语义上没有区别，这里只是取最常见的那种）；
   *    都没有段落时才退到别的可编辑块。
   * ⚠️ 没有这样的块 ⇒ 调用方记 `摘要.Y.适用 = false`（**既不记通过也不记跳过**），
   *    由 `block-probe.sh` 的 `Y-覆盖` 保证整轮至少有一份夹具真的跑过。
   */
  function 挑标记块() {
    const p = window.__rmd && window.__rmd.payload;
    if (!p || !p.blocks) return null;
    const 表 = 块节点();
    let 退路 = null;
    for (let i = 0; i < p.blocks.length && i < 表.length; i++) {
      if (p.blocks[i][3] !== 1) continue;
      const node = 表[i];
      if (!node || node.nodeType !== 1) continue;
      const 源 = 块源(i);
      const 行0 = String(源).split('\n')[0] || '';
      const 期望0 = 期望可见行(源)[0] || '';
      const 记号 = 标记记号(行0, 期望0);
      if (!记号.length) continue;
      const 候选 = { i: i, node: node, 源: 源, 期望0: 期望0, 记号: 记号 };
      const 种类 = (p.block_kinds && p.block_kinds[p.blocks[i][0]]) || '';
      if (种类 === 'Paragraph') return 候选;
      if (!退路) 退路 = 候选;
    }
    return 退路;
  }

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
    for (let i = 0; i < lines.length; i++) {
      // ⚠️⚠️ 组合串是**行内 widget**（`.cm-rmd-preedit`，2026-11-02 起）：它**不在文档里**，
      //    却就住在 `.cm-line` **里面** ⇒ 直接读 `textContent` 会把拼音算成正文，
      //    `D1b`（组合期块内文本不变）就恒红。⇒ 摘掉它再读。
      //    ⚠️ 任务框 widget（`.cm-rmd-taskbox-wrap`，`bugs/0106`）同族：它里面的
      //    `<input>` 与**那个字面空格**都是装饰层——空格是 comrak 阅读态
      //    `html.rs` 无条件写出的那一个（两态排版由同一个字符产生），⛔ 不属于正文文本。
      //    不摘掉的话 `B*-3c` 的独立 oracle（"藏掉标记后的源码"）会恒差一个前导空格，
      //    看起来像产品多写了一个字。
      //    ⚠️ 走快路径：只有真的要摘时才克隆（bigblock 一次几百行，别每行都克隆一遍）。
      //
      // ⭐ `bugs/0304` 候选 ④（2026-11-12）：**行内代码的反引号留在字符流里、只压成
      //    `font-size: 0`**（`.cm-rmd-zw`，与围栏行同族）。它**看得见吗**由计算样式说了算——
      //    样式真的生效（字号 ≤ 0.5 px）才算"藏掉了"，⛔ 不能只认类名（类在、样式没生效
      //    的情况要和"标记露出来"一样判红，这是 fail-closed 的那一侧）。
      let el = lines[i];
      const 要摘 = el.querySelector('.cm-rmd-preedit, .cm-rmd-taskbox-wrap, .cm-rmd-zw');
      if (要摘) {
        const 零宽序 = [];
        const zws = el.querySelectorAll('.cm-rmd-zw');
        for (let k = 0; k < zws.length; k++) {
          const 号 = parseFloat(getComputedStyle(zws[k]).fontSize) || 0;
          if (号 <= 0.5) 零宽序.push(k);
        }
        el = el.cloneNode(true);
        const ps = el.querySelectorAll('.cm-rmd-preedit, .cm-rmd-taskbox-wrap');
        for (let k = 0; k < ps.length; k++) ps[k].parentNode.removeChild(ps[k]);
        if (零宽序.length) {
          const czws = el.querySelectorAll('.cm-rmd-zw');
          for (let k = 零宽序.length - 1; k >= 0; k--) {
            const z = czws[零宽序[k]];
            if (z && z.parentNode) z.parentNode.removeChild(z);
          }
        }
      }
      out.push(el.textContent || '');
    }
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
   * 源码与编辑视图在**换行这一点上**同形？（返回布尔）
   *
   * ⚠️⚠️ 单元格的存储形态是 `<br>`、编辑视图里是 `\n`（`design/0049` 的约定；`bugs/0035`
   *    之后格内可换行）⇒ 直接拿**源码**当视图的期望值，遇上格内换行就假红。
   *    2026-11-03 实测：`Q31` 拿到「列二甲⏎乙甲乙丙」/ 期望「列二甲&lt;br&gt;乙甲乙丙」，
   *    两串只差"换行怎么写"——那是夹具被前面的 `Q14` 写脏了，⛔ 不是产品缺陷。
   * ⚠️ 这里只做这一个**规范级**映射，⛔ 不复刻 `cell.js::decode` 的整条转义规则
   *    （`\|` 之类仍按字面比）；视图里若残留字面的 `<br>`，本条照样红。
   */
  function 换行同形(源码, 视图) {
    return String(源码).replace(/<br\s*\/?>/gi, '\n') === String(视图);
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
   * **`<td>` 的内容盒宽**（＝编辑宿主能用的那一整条宽）。
   *
   * ⚠️⚠️ **⛔ 不许用「`rect.width` − 计算样式的 padding − 计算样式的 border」手算**
   *    （2026-11-03 定位：`Q14b` 从 2026-10-30 起红了四天，`bugs/0047` §9 记的
   *    「未定位是 oracle 量窄了还是产品真的宽 1 px」就是它）：
   *    这张表是 `border-collapse: collapse`，**计算样式里的 border 是 1 px 每边，
   *    但真正占掉的是 0.5 px 每边**（折线是画在格子共用的那条格线上、两半分摊）。
   *    手算于是每边多减 0.5 px ⇒ 合计**少 1 px**（实测 40.688 对真值 41.688），
   *    而"少 1 px"恰好让 `列二甲` 这种卡在折行边界上的内容多折一行 ⇒
   *    高度对不上，看着像"编辑态偏高"，其实是 **oracle 自己量窄了**。
   * ⭐ 做法：临时把这一格变成定位容器，塞一个**脱流**的探针块（`left:0; right:0`）
   *    —— 百分比定位对**padding 盒**解析 ⇒ 量到的就是"格宽减去真实 border"，
   *    与折线怎么分摊无关；再减掉两个 padding 就是内容宽。
   *    ⚠️ 探针 `height:0; visibility:hidden` 且**脱流**，不参与该格的换行/撑高。
   * ⚠️ 同步改、同步还原（中间没有 `await`）⇒ 不进任何一帧；`finally` 保证异常也还原。
   * @param {Element} td
   * @returns {number}
   */
  function 内容宽(td) {
    const 原 = td.style.position;
    const 探 = document.createElement('div');
    try {
      td.style.position = 'relative';
      探.style.cssText = 'position:absolute;left:0;right:0;top:0;height:0;margin:0;'
        + 'padding:0;border:0;visibility:hidden;';
      td.appendChild(探);
      const 内宽 = 探.getBoundingClientRect().width;
      const cs = getComputedStyle(td);
      const 宽 = 内宽 - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      // ⚠️ 量不到就**如实返回 0**（调用方据此判"读不到"），⛔ 不从别处编一个数出来。
      return (isFinite(宽) && 宽 > 1) ? 宽 : 0;
    } finally {
      if (探.parentNode) 探.parentNode.removeChild(探);
      td.style.position = 原;
    }
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
    const 框 = 内容宽(td);
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
    // ⚠️⚠️ **`keyup` 也必须派**（2026-11-16 实测，`Q26`／`Q26b` 的归因）：
    //    真实键盘一定成对产生 `keydown→keyup`，而**浮动格式栏**（`design/0061` L4 ／
    //    `design/0078` 的紧凑「⋯」）正是靠 `document` 上的 `keyup` 重算可见性。
    //    只派 `keydown` ⇒ 按 `Escape` 退出编辑态之后栏**永远停在上一次的位置**（实测
    //    `可见[587,1242 37×36]`，正好盖住表格行尾死区里那一格），下一次"按下"就被它吃掉，
    //    `Q26` 报"没进去"而产品其实没毛病。⛔ 别改成只给 `Escape` 补——每个键都该成对。
    el.dispatchEvent(new KeyboardEvent('keyup', o));
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

  /**
   * ⭐ **光标零位移**（用户 2026-11-11 裁定，逐字见 `vision/0001` §2.1）：
   * 「编辑的时候，或者插入光标的时候，除了插入的数据外，其他格式绝对不能发生变化。」
   *
   * 判法：宿主**已经在编辑态**时，把光标依次放到若干个位置（在**当前渲染出来的行**里取
   * 首 / 1/3 / 2/3 / 末四处，每处行首 / 行中 / 行尾），最后再做一个行内选区；每放一次都量
   * **每一行的文档坐标与行高 ＋ 块顶 ＋ 块高**，与上一次逐项比，任何一项变了就是违反。
   *
   * ⚠️ 为什么量**行**而不只量块：块高不变而内部行错位（围栏行塌陷后重排、某一行被
   *    WebKit 重分配上下半高）在块级判据里**完全看不见**——`Q36` 那 0.016 px 就是这么漏的。
   * ⚠️ 为什么只取**渲染出来的行**：跳到远处会让 CM6 把视口滚过去，渲染行数 105 → 106，
   *    那是"换了看哪一段"，⛔ 不是格式变了（2026-11-11 实测踩到）。⇒ 会滚动的位点**跳过**
   *    并计数，⛔ 既不记红也不记绿。
   * ⚠️ 为什么不派发方向键：方向键会顺带滚动与"光标可见性"补滚，那是合法的另一件事。
   *    本条只问"光标本身改不改格式"。⚠️ 几何一律取**文档坐标**（相对 `#doc` 顶），
   *    与滚动位置无关 ⇒ 块内横滚不会假红。
   * ⚠️ 走 `view.dispatch` 仍然过产品的 `transactionFilter`（`legalFilter` 落点钳制），
   *    ⛔ 这不是绕过产品的第二条路径；⛔ 也不触碰任何文件或授权面。
   * ⚠️ 文档长度变了就不判本条（那是 `D` 段的账）：先记成违反，免得"事务改了正文"
   *    被读成"光标很干净"。
   * @returns {Promise<{ok: boolean, 说明: string}>}
   */
  async function 光标零位移(host) {
    const CM6 = window.rmdCM6;
    const V = CM6 && CM6.EditorView && CM6.EditorView.findFromDOM
      ? CM6.EditorView.findFromDOM(host)
      : null;
    if (!V || !V.state) return { ok: false, 说明: '拿不到 EditorView ⇒ 光标移动无从验证' };
    const docTop = docEl().getBoundingClientRect().top;

    /**
     * 行级快照：`{top, h, 文}` 逐行 ＋ 块顶 / 块高（几何是相对 `#doc` 的文档坐标）。
     * ⚠️⚠️ **`文` 不是装饰**（2026-11-11 实测补上）：只比几何时，一个**不折行**的行
     *    露出 `#` / `**` 既不改变行顶也不改变行高（标记顶掉的是行内左缩进）⇒ 几何全绿，
     *    而屏幕上那一行的字**整体右移了**、标记也露出来了。`M59` 首跑正是这样：
     *    `B0-10`/`B5-10` 仍绿，只有会折行/塌行的那两块（`B6-10`/`B11-10`）红。
     *    ⇒ 可见文本必须进快照：光标移动到哪，那一行的**可见文本一个字都不许变**。
     *    （`​` 是 CM6 给 widget 补的零宽占位，与用户可见内容无关，抹掉再比。）
     */
    function 快照() {
      const lines = host.querySelectorAll('.cm-line');
      const arr = [];
      for (let k = 0; k < lines.length; k++) {
        const r = lines[k].getBoundingClientRect();
        arr.push({
          top: 四舍(r.top - docTop),
          h: 四舍(r.height),
          文: (lines[k].textContent || '').replace(/​/g, ''),
        });
      }
      const hr = host.getBoundingClientRect();
      return { top: 四舍(hr.top - docTop), h: 四舍(hr.height), lines: arr };
    }
    /** 两份快照的**第一处**差异；完全相同 ⇒ 空串。 */
    function 首差(a, b) {
      if (a.lines.length !== b.lines.length) {
        return '渲染行数 ' + a.lines.length + ' → ' + b.lines.length;
      }
      for (let k = 0; k < a.lines.length; k++) {
        const dt = 四舍(a.lines[k].top - b.lines[k].top);
        const dh = 四舍(a.lines[k].h - b.lines[k].h);
        if (Math.abs(dt) > 0.01 || Math.abs(dh) > 0.01) {
          return '第 ' + (k + 1) + ' 行行顶 ' + a.lines[k].top + ' → ' + b.lines[k].top
            + ' px（Δ ' + dt + '）、行高 ' + a.lines[k].h + ' → ' + b.lines[k].h
            + ' px（Δ ' + dh + '）';
        }
        if (a.lines[k].文 !== b.lines[k].文) {
          return '第 ' + (k + 1) + ' 行可见文本 ' + JSON.stringify(a.lines[k].文)
            + ' → ' + JSON.stringify(b.lines[k].文);
        }
      }
      const dtop = 四舍(a.top - b.top);
      const dh2 = 四舍(a.h - b.h);
      if (Math.abs(dtop) > 0.01) return '块顶 ' + a.top + ' → ' + b.top + ' px（Δ ' + dtop + '）';
      if (Math.abs(dh2) > 0.01) return '块高 ' + a.h + ' → ' + b.h + ' px（Δ ' + dh2 + '）';
      return '';
    }
    async function 稳快照() {
      // ⚠️ 与 `等版面稳定` 同口径：连续 3 帧几何不变才算稳（离屏 rAF 被节流，
      //    固定 `sleep` 在慢机器上不够）。⚠️ 只用 8 帧上限：本条要跑十几次，⛔ 别把探针拖垮。
      let 前 = JSON.stringify(快照());
      for (let k = 0; k < 8; k++) {
        await frame();
        const 现 = JSON.stringify(快照());
        if (现 === 前) return 快照();
        前 = 现;
      }
      return 快照();
    }

    const doc = V.state.doc;
    const n = doc.length;
    /** 两个滚动量（页面 / 块内）。任何一个动了 ⇒ 视口换了，行集合**不可比**。 */
    function 滚动() {
      const d = document.scrollingElement || document.documentElement;
      return [d ? 四舍(d.scrollTop) : 0, 四舍(host.scrollTop || 0)];
    }
    // ⚠️⚠️ **只取当前渲染出来的行**（2026-11-11 实测踩到）：把光标跳到文档末尾会让 CM6
    //    把视口滚过去，渲染出来的行数 105 → 106 —— 那是"换了看哪一段"，
    //    ⛔ 不是"格式变了"。快照按**渲染行集合**逐行比，跨视口天然不可比 ⇒
    //    本条只在**不滚动**的前提下判，会滚动的位点直接跳过并计数。
    //    ⚠️ 块高过一屏时这等于**有意放弃**"滚到远处再放光标"那一半：那一半的用户可见后果
    //    是滚动，已由 `B{i}-6`（进入瞬间不改滚动量）与 `R` 段各自管。
    const 可见 = [];
    const 行元素 = host.querySelectorAll('.cm-line');
    for (let k = 0; k < 行元素.length; k++) {
      try {
        const p = V.posAtDOM(行元素[k], 0);
        if (typeof p === 'number' && p >= 0) 可见.push(p);
      } catch (e) { void e; }
    }
    if (!可见.length) return { ok: false, 说明: '宿主里一行都没渲染出来 ⇒ 光标移动无从验证' };
    // 位点：在**可见行**里取 4 处（首 / 1/3 / 2/3 / 末），每处取行首、行中、行尾。
    // ⚠️ 位点跨多个结构（围栏行、正文行、末行都在其中），而不是只瞄第一行。
    const 位 = [];
    const 挑 = [0, Math.floor(可见.length / 3), Math.floor(可见.length * 2 / 3), 可见.length - 1];
    for (let k = 0; k < 挑.length; k++) {
      const L = doc.lineAt(可见[挑[k]]);
      位.push(L.from, L.from + Math.floor(L.length / 2), L.to);
    }
    const 去重 = [];
    for (let k = 0; k < 位.length; k++) {
      if (去重.indexOf(位[k]) < 0 && 位[k] >= 0 && 位[k] <= n) 去重.push(位[k]);
    }
    去重.sort(function (a, b) { return a - b; });

    let 前 = await 稳快照();
    let 判 = 0;
    let 跳过 = 0;
    for (let k = 0; k < 去重.length; k++) {
      const p = 去重[k];
      const 滚0 = 滚动();
      try {
        V.dispatch({ selection: { anchor: p } });
      } catch (e) {
        return { ok: false, 说明: '光标落到 ' + p + ' 时 dispatch 抛出：' + String(e && e.message || e) };
      }
      const 后 = await 稳快照();
      if (V.state.doc.length !== n) {
        return { ok: false, 说明: '光标落到 ' + p + ' 时文档长度 ' + n + ' → ' + V.state.doc.length };
      }
      const 滚1 = 滚动();
      if (滚1[0] !== 滚0[0] || 滚1[1] !== 滚0[1]) {
        // 视口被滚过去了 ⇒ 这一位点不可比（⛔ 不记红、也不记绿）。
        跳过++;
        前 = 后;
        continue;
      }
      const d = 首差(前, 后);
      if (d) return { ok: false, 说明: '光标落到 ' + p + '（共 ' + n + '）时 ' + d };
      判++;
      前 = 后;
    }
    // ⭐ 选区变化也归同一条判据（用户原话「或者插入光标的时候」含选区）。
    if (n >= 4) {
      const 起 = 可见[0];
      const 滚0 = 滚动();
      try {
        V.dispatch({ selection: { anchor: 起, head: Math.min(n, 起 + 3) } });
      } catch (e) {
        return { ok: false, 说明: '选区变化 dispatch 抛出：' + String(e && e.message || e) };
      }
      const 后 = await 稳快照();
      const 滚1 = 滚动();
      if (滚1[0] === 滚0[0] && 滚1[1] === 滚0[1]) {
        const d = 首差(前, 后);
        if (d) return { ok: false, 说明: '选区 [' + 起 + ',' + Math.min(n, 起 + 3) + ') 时 ' + d };
      } else {
        跳过++;
      }
    }
    if (!判) return { ok: false, 说明: '每一位点都要滚动 ⇒ 一次都没判到（' + 跳过 + ' 处跳过）' };
    return {
      ok: true,
      说明: 判 + ' / ' + 去重.length + ' 个光标位 ＋ 1 次选区变化，行几何逐项不变'
        + (跳过 ? '（' + 跳过 + ' 处会滚动，按"视口换了"跳过，⛔ 不计入）' : '')
        + '；' + n + ' 字符',
    };
  }

  // ── 单块一轮：进入 → 量 → 退出 → 量 ────────────────────────────────
  async function 跑一块(i, block, base, 摘要) {
    const node = 块节点()[i];
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
    // ⚠️ 块高对不上时，光有 ΔH 说不清"哪一行变了"。阅读态的**逐行可见文本**必须在这
    //    一行取：`点()` 之后阅读节点脱离文档，`Range.getBoundingClientRect()` 返回全 0，
    //    事后补量只会得到空表（`Q36` 也踩过同一个坑）。⚠️ 逐字造 `Range` 很贵，
    //    bigblock（2000 行）按源长跳过——那一块的红已由 `bugs/0298` 定性。
    const 前带 = String(块源(i)).length <= 4000 ? 可见行带(node) : null;
    // ⚠️ 同理，**块的内容盒宽**也必须在进入前取：折行点差一个字符时，先要分清是
    //    "可用宽度不同"还是"行内元素占宽不同"，⛔ 别拿逐行文本反推。
    const 前宽 = node.getBoundingClientRect().width;
    // ⚠️ 排版相关的计算样式也必须在进入前取（节点脱离文档后 `getComputedStyle` 只返回空串）。
    const 前排 = (function () {
      const cs = window.getComputedStyle(node);
      return { 字族: cs.fontFamily, 字号: cs.fontSize, 字距: cs.letterSpacing,
        词距: cs.wordSpacing, 折行: cs.lineBreak, 断词: cs.wordBreak,
        溢词: cs.overflowWrap, 白空: cs.whiteSpace, 对齐: cs.textAlign };
    })();
    // ⚠️ 行内元素**逐个**量宽（这是"同一块宽、每行差一个字"唯一说得通的来源）。
    //    阅读态是 `<code>`，编辑态是 `.cm-rmd-code`；两边都按外接矩形宽取。
    const 前码宽 = (function () {
      const a = [];
      const es = node.querySelectorAll('code');
      for (let k = 0; k < es.length; k++) a.push(四舍(es[k].getBoundingClientRect().width));
      return a;
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
    //    ② **锚点不位移**——`design/0052` U6 取代了"变高有上界"这条旧判据；
    //    ③ **装饰层真的在干活**（所有行的标记必须藏掉，逐字比对独立 oracle）。
    // ⚠️ **2026-11-09 用户裁定按最高体验执行** ⇒ 这里的三条口径一并收紧：
    //    变矮不再"只告警"、变高不再"没有上界"、块外位移不再按块高增量解释。
    //    `design/0052` U6 的"体验为先、允许下面的内容移动几行"与"高过一屏 +20.141 px 属外部依赖"
    //    两条豁免**全部作废**（`INV-LIVE-04`，2026-11-02 版已被取代）；`+20.141 px` 按缺陷处理。
    const 源 = 块源(i);
    const LM = window.rmd && window.rmd.liveMarks;
    // ⭐⭐ `design/0052` U3：期望值改由**与产品无关的 oracle** 给（`期望可见行`）。
    //    ⚠️ 从前这里是 `去掉(源, markers(源,{activeLines:[0]}).ranges)` —— 拿产品给产品打分：
    //    藏错、算错两边一起错，判据**恒绿**（`INV-KERNEL-07` / `docs/bugs/0025`）。
    // ⭐ `design/0061` L1（2026-11-05）：**没有"活动行"**了——点进块里，第一行也照样藏标记。
    //    ⚠️ 这里从前传 `{ 原样行: [0] }`（"点的是第一行 ⇒ 它显示源码"），那个口径已被设计取代；
    //    ⛔ 别再传回去，否则会把"标记恒定隐藏"判成"装饰层没生效"。
    // ⭐ `bugs/0102`（2026-11-08）：列表项的**续行**在编辑态连行首缩进也被藏掉
    //    （`decorations.js` 的"续行补深度"）。期望值必须认识这一品种，否则"产品藏对了"
    //    与"产品多藏了"输出一模一样。⚠️ 只认**两个条件同时成立**的行：
    //    ① 编辑态那一行由产品标成列表行（`data-rmd-li`）；
    //    ② 独立 oracle 判出它是**续行**（行首有空白、且没有自己的列表标记）。
    //    ⛔ 普通正文行行首的空白一个都不剥——那是正文，不是标记。
    const 源行表 = String(源).split('\n');
    // ⚠️ 2026-11-12（`bugs/0298`）：围栏行没有 `.cm-line` ⇒ 渲染序 k 与源码行号**不再相等**。
    //    先把"哪几条源码行有行元素"列出来，再按它翻译；⛔ 别拿 k 直接当源码行号。
    const 塌表3c = 塌行表(源);
    const 渲染源序 = [];
    for (let k = 0; k < 源行表.length; k++) if (塌表3c[k] !== 'fence') 渲染源序.push(k);
    const 编行表 = host.querySelectorAll('.cm-line');
    const 续行表 = {};
    for (let k = 0; k < 编行表.length && k < 渲染源序.length; k++) {
      if (!编行表[k].hasAttribute('data-rmd-li')) continue;
      const 源行k = 源行表[渲染源序[k]];
      if (源行k === undefined) continue;
      const 去引k = 源行k.replace(/^(?:>[ \t]?)+/, '');
      if (/^[ \t]/.test(去引k)
          && !/^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.test(去引k)) {
        续行表[渲染源序[k]] = true;
      }
    }
    const wantLines = 期望可见行(源, 续行表);
    // 围栏行不产出 `.cm-line` ⇒ 逐字对照的期望侧也只取**渲染得出来的**那些源码行。
    const want渲染行 = [];
    for (let k = 0; k < wantLines.length; k++) if (塌表3c[k] !== 'fence') want渲染行.push(wantLines[k]);
    // ⛔⛔ **2026-11-09 起 `layoutSlack` 不再是"允许量"**（`design/0047` §10 尾注：上界整条作废）：
    //    下面这个数只回答一件事——"这一块里还有几处结构性来源（围栏行 / 空行 / 合并段）在
    //    制造高度差"。**目标值是 0**：差存在就是缺陷（`bugs/0298/0021/0091/0102/0299`），
    //    ⛔ 不许再把它写成"高多少是允许的"。`design/0061` L1 起"活动行会展开"那一项已不存在。
    const 结构差 = LM && typeof LM.layoutSlack === 'function'
      ? LM.layoutSlack(源)
      : { fences: 0, blanks: 0, softWraps: 0 };
    const 结构源行数 = 结构差.fences + 结构差.blanks + (结构差.softWraps || 0);

    // ⛔ **2026-11-09 用户裁定按最高体验执行**（`INV-LIVE-04`，2026-11-02 的"允许正常重排"作废）：
    //    进入编辑的**瞬间**活动块自身也不许长高/变矮。此前的"变矮只告警"（`design/0052` U6）
    //    与"块高增量可解释"两种放宽**一并作废** —— 已知的松散列表变矮（`bugs/0021`）按缺陷
    //    处理，⛔ 不再靠状态条告警记绿。`变矮告警` 只留作诊断信息印进说明。
    const 变矮告警 = 状态条().indexOf('比原来矮') >= 0;
    const Δ高 = Math.abs(got.h - base[i].h);
    // ⚠️ 只在**红的时候**算编辑态逐行（同样是逐字 `Range`，不是免费的）：
    //    "少了一行"和"多了一行"必须能一眼看出是**哪一行**，否则只能猜（`bugs/0316` 的教训）。
    let 行诊断 = '';
    if (Δ高 > TOL && 前带) {
      const 摘 = function (带) {
        return 带.map(function (x) {
          return x.text.length + '|' + x.text.slice(0, 8) + '…' + x.text.slice(-8)
            + '@' + x.width;
        });
      };
      行诊断 = '；逐行（字数|尾 12 字）阅读 ' + JSON.stringify(摘(前带))
        + ' / 编辑 ' + JSON.stringify(摘(可见行带(主机())))
        + '；块宽 阅读 ' + 四舍(前宽) + ' / 编辑 ' + 四舍(主机().getBoundingClientRect().width)
        + '；行内码宽 阅读 ' + JSON.stringify(前码宽)
        + ' / 编辑 ' + JSON.stringify((function () {
          const a = [];
          const es = 主机().querySelectorAll('.cm-rmd-code');
          for (let k = 0; k < es.length; k++) a.push(四舍(es[k].getBoundingClientRect().width));
          return a;
        })())
        + '；排版 阅读 ' + JSON.stringify(前排)
        + ' / 编辑 ' + JSON.stringify((function () {
          const cs = window.getComputedStyle(主机());
          return { 字族: cs.fontFamily, 字号: cs.fontSize, 字距: cs.letterSpacing,
            词距: cs.wordSpacing, 折行: cs.lineBreak, 断词: cs.wordBreak,
            溢词: cs.overflowWrap, 白空: cs.whiteSpace, 对齐: cs.textAlign };
        })());
    }
    记('B' + i + '-3a 进入后块高逐像素不变（最高体验；⛔ 不再接受"变矮告警"）', Δ高 <= TOL,
      'ΔH ' + 四舍(got.h - base[i].h) + ' px（原 ' + base[i].h + ' / 视 ' + got.h + '）'
        + '；状态条：' + (状态条() || '（空）')
        + (变矮告警 ? '；⚠️ 产品已报"比原来矮"' : '')
        + 行诊断);
    // ⭐ 锚点判据（`design/0052` U6 提出，**2026-11-09 收紧**）：`点()` 永远点在**第一行**
    //    （离块顶 8 px），⇒ 块的顶边与那一行的行顶是同一个锚。"我点的那一行别跑"是最低要求，
    //    **不是**合规的全部：`INV-LIVE-04` ① 要求进入瞬间逐像素不动，块高与块顶单独判
    //    （`-3a` / `-4` / `-5` / `-6`），本条只负责"被点那一行的行顶"这一面。
    //    ⚠️ 产品的锚定（`main.js::anchorAt`）是**兜底**：布局动了以后把光标钉回来。
    //    ⛔ 它不能让 `-6`（滚动量）变绿——进入瞬间本来就不许滚。
    //    ⛔ **2026-11-09 起"高过一屏 +20.141 px 属外部依赖"的豁免作废**（用户按最高体验裁定）：
    //    这个量按缺陷处理，`B{i}-3a/5` 会如实打红，修好之前不得记绿。
    const 锚点1 = (function () {
      // ⚠️⚠️ **⛔ 不返回 `NaN`**（2026-11-03 实测）：`NaN` 进 `摘要` 会让 Swift 那边
      //    `NSJSONSerialization` 直接抛 `Invalid number value (NaN)` ⇒ **整份夹具的
      //    几百条判据一条都拿不到**，而报错里只有一句 JSON 写失败。
      //    ⛔ 也不返回 `0` 冒充"锚点在顶上"——那是把"没量到"写成"量到了 0"。
      // ⭐ 取**第一行真有字的**行（块首可能是塌掉的围栏行，见 `首行字顶`）。
      const g = 首行字顶(host);
      return g === null ? null : 四舍(g);
    })();
    记('B' + i + '-3b F5 锚点不位移（被点那一行的行顶 ±' + 四舍(TOL) + ' px）',
      锚点1 !== null && Math.abs(锚点1 - 锚点0) <= TOL,
      (锚点1 === null
        ? '⚠️ 进块了但宿主里一行可见字都没有 ⇒ 锚点无从量起'
        : '行顶 ' + 锚点0 + ' → ' + 锚点1 + ' px（Δ ' + 四舍(锚点1 - 锚点0) + '）')
        + '；块顶 Δ ' + dtop + ' px；ΔH ' + 四舍(got.h - base[i].h) + ' px（结构性来源 '
        + 结构源行数 + ' 行：围栏 ' + 结构差.fences + ' ＋ 空行 ' + 结构差.blanks
        + ' ＋ 合并段 ' + (结构差.softWraps || 0) + '，⛔ 目标 0 行、它们就是缺陷来源）'
        + '；滚动差 ' + 滚动差 + ' px');
    记('B' + i + '-3c 所有行的标记真的藏掉了（逐字对齐独立 oracle）', (function () {
      // ⚠️⚠️ CM6 **只渲染窗口内的行** ⇒ 高过一屏的块，`块内文本(host)` 只有**头部那几十行**
      //    （bigblock 的 202 / 802 / 2000 行三块都只有 ~130 行）。拿它跟**整块**源码逐字比，
      //    判的是"字符数一样"，而字符数天生不一样 ⇒ 三块全红，产品其实是好的。
      //    ⇒ ① 整块都渲染出来时仍比**整串**（那才是"一个字符都不差"）；
      //      ② 只渲染了一部分时**逐行比头部那些行**（⛔ 不拿 `slice` 截期望——隐藏区间可能
      //         正好压在切点上，截出来的前缀与渲染前缀会差几个字）。
      //    ⚠️ 由此 -3c 对**代码块**天然是弱判据（代码块里没有被藏的标记）；
      //       它真正承重的是段落/标题/列表/引用那几块，⛔ 别把这条当成"装饰层整体没有防线"。
      const gotLines = 块内文本(host).split('\n');
      // ⚠️ 判"宿主里一个字都没有"要整块判，⛔ 别只看第一行：代码块的第一行是**围栏行**，
      //    它在 `design/0061` L1 下**恒塌成 0 高**（`Decoration.line` ＋ `live.css`），
      //    `textContent` 就是空串 ⇒ 旧写法 `!gotLines[0]` 会在**产品完全正确**时直接返回 false
      //    （2026-11-05 实测：`B11-3c` 只印一句"9 / 全块 9 行"、一行差异都没有）。
      if (!gotLines.length || !块内文本(host)) return false;
      if (gotLines.length >= want渲染行.length) return 块内文本(host) === want渲染行.join('\n');
      for (let k = 0; k < gotLines.length; k++) if (gotLines[k] !== want渲染行[k]) return false;
      return true;
    })(),
    (function () {
      const gotLines = 块内文本(host).split('\n');
      const 渲染 = gotLines.length + ' / 全块 ' + wantLines.length + ' 行（渲染得出来 '
        + want渲染行.length + ' 行，围栏行无行元素）';
      for (let k = 0; k < Math.min(gotLines.length, want渲染行.length); k++) {
        if (gotLines[k] !== want渲染行[k]) {
          // ⚠️ 报**源码行号**（`渲染源序`），不是渲染序——围栏行没有行元素，两套编号不等。
          return 渲染 + '，源码第 ' + ((渲染源序[k] || 0) + 1) + ' 行不同：期望「'
            + want渲染行[k].slice(0, 40) + '」/ 实际「' + gotLines[k].slice(0, 40) + '」';
        }
      }
      return 渲染;
    })());
    记('B' + i + '-4 块自身 top 不动', dtop <= TOL, 'Δtop ' + dtop + ' px');
    // ⛔ **2026-11-09 起不再扣"这一块自己长高了多少"**（用户裁定按最高体验执行，
    //    `INV-LIVE-04` 的"允许正常重排"作废）：进入编辑的**瞬间**活动块都不许变高，
    //    下游自然也不许动。旧口径 `下游 <= |ΔH| + 0.5` 会让"整块重排、下游跟着走"
    //    这类缺陷一直绿着（`bugs/0297` 就是这么漏掉的）。
    记('B' + i + '-5 块外零位移（进入瞬间，⛔ 不接受"块高增量可解释"）',
      下游 <= TOL,
      '下游最大位移 ' + 下游 + ' px / 块自身变化 ' + 四舍(got.h - base[i].h) + ' px');
    // ⚠️ `design/0052` U6 起**产品会主动补滚动**（`main.js::anchorAt`，`INV-KERNEL-05` 的落点）。
    // ⛔ **2026-11-09 起"一次不许多于一屏"这个上界作废**（用户按最高体验裁定）：进入编辑的
    //    瞬间块本身不动、下游不动 ⇒ **滚动量也不许动**。旧判据只守"一屏"，实测里 6 px 的
    //    补滚动就是这么混过去的，而用户看到的是"我点的那一行往上跳了一下"。
    记('B' + i + '-6 进入瞬间不改滚动量（⛔ 不再只守"一屏"上限）',
      滚动差 <= TOL,
      'ΔscrollTop ' + 滚动差 + ' px / 一屏 ' + (window.innerHeight || 0) + ' px');

    摘要['块' + i] = { ΔH: dh, Δtop: dtop, 下游: 下游, 结构源行: 结构源行数, 锚点: [锚点0, 锚点1] };

    // ⭐⭐ `B{i}-10 光标移动零位移`（用户 2026-11-11 裁定，`vision/0001` §2.1）：
    //    「编辑的时候，**或者插入光标的时候**，除了插入的数据外，其他格式绝对不能发生变化。」
    //    ⚠️ 这一条**此前根本不存在**：B 段只验"进入编辑"那一下，进入之后光标怎么走、
    //    走到哪一行会让哪一行的高度/位置变，从来没人量过（`design/0061` §10 同日注已记号）。
    //    ⚠️ 它必须排在退出之前、且排在 `D`/`N`/`O` 之前——那些段都会改正文。
    const 光 = await 光标零位移(host);
    记('B' + i + '-10 光标移动零位移（点击后逐位移动，2026-11-11 裁定）', 光.ok, 光.说明);

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

  // ── T 段：**块贴着视口下沿时进入编辑**（2026-11-09 新增）───────────────
  /**
   * ⭐ 为什么要有这一段：B 段每一块都先 `scrollIntoView({block:'start'})` 再点 ⇒ 只覆盖
   *    "块贴着视口顶"这一种摆放。用户报的形态（`bugs/0297`：**没有最大化**的窗口里点表格）
   *    发生在块**靠近视口下沿**的时候：CM6 只测量视口内的行，窗口越矮、块下半部分越可能
   *    还没被量过 ⇒ 进入编辑时补测量会把版面挤一下。B 段永远看不到这种摆放。
   *
   * 判据（`INV-LIVE-04` ①，进入瞬间逐像素不动）：
   *    `T0` 摆放真的做到了（块底距视口下沿 ≤ 120 px）——⛔ 做不到就不产后面的判据，
   *         免得"块其实贴顶"却冒充"下沿"；
   *    `T1` 覆盖层真的开了（否则后面三条无从判）；
   *    `T2` 块高 ΔH ≤ 0.5 px；
   *    `T3` 块顶的**文档坐标** Δ ≤ 0.5 px（`几何()` 量的是相对 `#doc`，与滚动无关）；
   *    `T4` `scrollTop` Δ ≤ 0.5 px（⛔ 不许"补滚一下"把重排藏起来）；
   *    `T5` 退出后逐像素回基线（含 `#doc` 垫层与滚动量的清场）。
   *
   * ⚠️ 点的是**块的下部**（离底 8 px），⛔ 不是第一行——第一行已由 B 段覆盖。
   * ⚠️ 摆放靠"滚 ＋ 补 `#doc` 上内边距"两手（见函数头注释）：短夹具整篇不足一屏，
   *    只靠滚动**摆不出来**；⛔ 但补垫只加在页面外层，被测那一个块的盒子一个像素都不动。
   */
  async function 跑下沿进入(base, 摘要) {
    const p = window.__rmd && window.__rmd.payload;
    // ⚠️ 摆放有两种手段，缺一不可（2026-11-09 首跑就是只在"滚"这一条上栽的）：
    //    ① 块底在视口**下方** ⇒ 往下滚就能把它贴到下沿；
    //    ② 块太靠上（短夹具整篇都不够一屏）⇒ 滚到 0 也够不着，只能给 `#doc` **补上内边距**
    //       把它推下去。只写 ① 时七份夹具里只有一份摆得成（实测 T0 全红、T-覆盖 跟着红）。
    //    ⛔ 两种手段都**不碰这一块自己的盒子**——改的是页面垫层，不是被测的那一坨。
    const 视高 = window.innerHeight || 0;
    const 原滚 = 滚动量();                              // 收尾要还回去：后面几段都假设"页面没被本段滚过"
    const ev = document.scrollingElement || document.documentElement;
    const doc = docEl();
    const 原垫 = doc ? doc.style.paddingTop : '';

    function 清场() {
      if (doc) doc.style.paddingTop = 原垫;
      还滚动(ev, 原滚);
    }

    还滚动(ev, 0);                                      // 先回顶：让"文档坐标"与视口坐标的推理只有一种
    await frames(2);

    const 表 = 块节点();
    let 选 = -1;
    for (let i = 0; i < 表.length && i < (p ? p.blocks.length : 0); i++) {
      const w = p.blocks[i];
      if (!w || !w[3]) continue;                       // 只挑可编辑块
      if (!表[i] || 表[i].nodeType !== 1) continue;
      if (表[i].getBoundingClientRect().height >= 60) { 选 = i; break; }
    }
    if (选 < 0) {
      摘要.T = { 适用: false, 原因: '没有 ≥60 px 的可编辑块' };
      清场();
      return;
    }

    // ① 往下滚（块底在视口下方时才有意义）
    const 目标底 = 视高 - 24;
    let rr = 表[选].getBoundingClientRect();
    if (rr.bottom > 目标底) {
      还滚动(ev, Math.min(rr.bottom - 目标底, 滚动上限()));
      await frames(2);
      rr = 块节点()[选].getBoundingClientRect();
    }
    // ② 还差就补内边距（把这一块整体往下推）
    // ⚠️⚠️ **2026-11-12**：一次算准是不够的——给 `#doc` 加 `padding-top` 会**止住首个子块
    //    的上外边距塌陷**，块下移量 ≠ 补垫量（760 宽实测：补垫 710.047 px、结果块底反而
    //    掉到视口下 6.797 px，`T0` 假红）。⇒ 每轮**重新量**再补，最多 3 轮，
    //    允许往回缩（负修正），补垫量始终按"相对原垫层的总增量"记。
    let 注入 = 0;
    if (doc) {
      const 原垫数 = parseFloat(getComputedStyle(doc).paddingTop) || 0;
      for (let 轮 = 0; 轮 < 3; 轮++) {
        const 距 = 四舍(视高 - rr.bottom);
        if (距 >= 0 && 距 <= 120) break;                 // 已达标（与 `T0` 同一口径）
        const 差 = 四舍(目标底 - rr.bottom);
        const 现 = parseFloat(getComputedStyle(doc).paddingTop) || 0;
        const 新垫 = Math.max(0, Math.min(现 + 差, 原垫数 + 视高 * 3));
        if (Math.abs(新垫 - 现) < 0.5) break;
        doc.style.paddingTop = 新垫 + 'px';
        await frames(2);
        rr = 块节点()[选].getBoundingClientRect();
        注入 = 四舍(新垫 - 原垫数);
      }
    }

    const 距下沿 = 四舍(视高 - rr.bottom);
    if (!(距下沿 >= 0 && 距下沿 <= 120)) {
      摘要.T = { 适用: false, 原因: '滚到上限 ＋ 补内边距之后仍摆不到视口下沿（0–120 px）' };
      记('T0 摆放成立：块底贴着视口下沿（0–120 px）', false,
        '距下沿 ' + 距下沿 + ' px（视口 ' + 视高 + ' px，块高 ' + 四舍(rr.height)
          + ' px，补垫 ' + 注入 + ' px，可滚上限 ' + 四舍(滚动上限()) + ' px）');
      清场();
      await frames(2);
      return;
    }
    摘要.T = { 适用: true, 块: 选, 距下沿: 距下沿, 块高: 四舍(rr.height), 补垫: 注入 };
    记('T0 摆放成立：块底贴着视口下沿（0–120 px）', true,
      '距下沿 ' + 距下沿 + ' px（视口 ' + 视高 + ' px，块高 ' + 四舍(rr.height)
        + ' px' + (注入 ? '，补垫 ' + 注入 + ' px' : '') + '）');

    const 基 = 几何()[选] || { top: NaN, h: NaN };
    const 滚0 = 滚动量();

    // 点在**块的下部**（离底 8 px）：坐标落在哪一行由产品自己的 `posAtCoords` 解。
    const 节点 = 块节点()[选];
    rr = 节点 && 节点.nodeType === 1 ? 节点.getBoundingClientRect() : rr;
    const x = rr.left + Math.min(8, Math.max(2, rr.width / 2));
    const y = Math.max(rr.top + 8, rr.bottom - 8);
    const 目标点 = document.elementFromPoint(Math.round(x), Math.round(y));
    const 事件 = new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      clientX: Math.round(x), clientY: Math.round(y), view: window,
    });
    (目标点 && docEl().contains(目标点) ? 目标点 : 节点).dispatchEvent(事件);

    const host = await waitFor(主机, 4000);
    if (!host) {
      记('T1 下沿进入：覆盖层开了', false, '等不到 ' + HOST_SEL + '；状态条：' + 状态条());
      摘要.T.进入 = false;
      清场();
      await frames(2);
      return;
    }
    await frames(3);
    记('T1 下沿进入：覆盖层开了', true, '');
    const 后 = 几何()[选] || { top: NaN, h: NaN };
    const 滚1 = 滚动量();
    记('T2 下沿进入：块高逐像素不变', Math.abs(后.h - 基.h) <= TOL,
      '原 ' + 基.h + ' / 视 ' + 后.h + ' px（ΔH ' + 四舍(后.h - 基.h) + '）');
    记('T3 下沿进入：块顶的文档坐标不动', Math.abs(后.top - 基.top) <= TOL,
      '原 ' + 基.top + ' / 视 ' + 后.top + ' px（Δ ' + 四舍(后.top - 基.top) + '）');
    记('T4 下沿进入：不改滚动量（⛔ 不许补滚）', Math.abs(滚1 - 滚0) <= TOL,
      'ΔscrollTop ' + 四舍(滚1 - 滚0) + ' px');
    摘要.T.读数 = { 前: 基, 后: 后, 滚: [四舍(滚0), 四舍(滚1)] };

    const ta = 输入框();
    if (ta) 键(ta, 'Escape');
    await waitFor(function () { return !主机(); }, 4000);
    // ⚠️ **先清场再比几何**：`#doc` 的垫层与滚动都是本段自己加的，留着会让 T5 假红。
    清场();
    await frames(2);
    记('T5 下沿退出后逐像素回到基线', 几何相等(base, 几何()),
      几何相等(base, 几何()) ? '' : '差异 ' + JSON.stringify(差异(base, 几何())));
  }

  // html 与 body 都写（`bugs/0031` §5.1：真正滚的常常是 `body`）。
  function 还滚动(ev, y) {
    if (ev) ev.scrollTop = y;
    if (document.body) document.body.scrollTop = y;
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
    const node = 块节点()[i];
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
    // ⭐ "一行是多少 px"：`D2` 的上限与 `D7` 的量级都用它。
    const 行高 = (function () {
      const line = host.querySelector('.cm-line');
      return line ? line.getBoundingClientRect().height : 0;
    })();
    // ⭐⭐ 组合串是**行内**的（2026-11-02，`bugs/0060` 第二版，对齐 Mardo）⇒ 它**占版面**：
    //    当前行会被撑长、右边的字被推开、行满就折行。`INV-LIVE-04` / `F6` 的原文是
    //    「编辑期间**除当前行外**每行屏幕位置不变」——当前行本来就排除在外。
    //    ⇒ 组合期要钉的是三件事（⛔ 不再是"下游零位移"）：
    //    ① 活动块**之上**的块零位移；② 活动块只**长高**、且 ≤ 一行；
    //    ③ 下游的位移**恰好等于**活动块长高的那一点（⛔ 不许有别的东西跟着跳）。
    const DV = 视图(host);
    const 插入点 = (function () {
      try { return DV && DV.state ? DV.state.selection.main.head : -1; } catch (e) { return -1; }
    })();
    const 行末 = (function () {
      try { return DV && DV.state ? DV.state.doc.lineAt(插入点).to : -1; } catch (e) { return -1; }
    })();
    const 行末0 = (function () {
      try { return DV && DV.coordsAtPos ? DV.coordsAtPos(行末, 1) : null; } catch (e) { return null; }
    })();
    // ⚠️ **2026-11-12**：`行末` 是**源码行**的末尾。段落折行时它是**最后一个视觉行**的末端，
    //    而组合串插在**光标处**——只要那个尾巴短到左对齐、且插串没把它顶到下一行，
    //    `行末` 的坐标就**一动不动**（实测 `bigblock` 在 760 宽：段落高 95 px、ΔH 0 px、
    //    行尾坐标 0 位移）⇒ 旧口径判不出"占没占版面"，红的是判据不是产品。
    //    ⇒ 再量**紧邻光标的下一个字**（`插入点+1`）：同一视觉行上它必须被推右，折行则顶下移。
    const 后继点 = (function () {
      try {
        if (!DV || !DV.state) return -1;
        const L = DV.state.doc.length;
        return 插入点 >= 0 && 插入点 + 1 <= L ? 插入点 + 1 : -1;
      } catch (e) { return -1; }
    })();
    const 后继0 = (function () {
      try { return DV && DV.coordsAtPos && 后继点 >= 0 ? DV.coordsAtPos(后继点, 1) : null; }
      catch (e) { return null; }
    })();

    // —— ① 组合期：文档一个字节都不动，只有"当前行"这一块可以长 ——
    let 上方位移 = 0;
    let 高度增量 = 0;
    let 下游对不上 = 0;
    let 占版面 = '';
    let 诊断3b = '';
    const 文本0 = 块内文本(host);
    let 文本变了 = '';
    组合(ta, 'compositionstart', '');
    const 串 = ['n', 'ni', 'nih', 'niha', 'nihao'];
    for (let k = 0; k < 串.length; k++) {
      组合(ta, 'compositionupdate', 串[k]);
      await frames(1);
      const g = 几何();
      const 增 = Math.max(0, g[i].h - h0);
      上方位移 = Math.max(上方位移, 区间最大位移(起, g, 0, i));
      高度增量 = Math.max(高度增量, 增);
      下游对不上 = Math.max(下游对不上, Math.abs(下游最大位移(起, g, i + 1) - 增));
      if (!文本变了 && 块内文本(host) !== 文本0) 文本变了 = '第 ' + (k + 1) + ' 个中间态';
      // ⭐ `D3b` 的实测：行尾坐标。同一视觉行 ⇒ 必须被**推右**（≈ 组合串宽度）；
      //    折了行 ⇒ 必须落到**下一行**。两条都证明"它占了版面"。
      //    ⚠️ 用 CM6 自己的 `coordsAtPos`（与产品同一把尺），⛔ 不抓 DOM 节点：
      //    装饰一变 CM6 会把那一行重建成别的节点，旧引用当场失效。
      const 末 = (function () {
        try { return DV && DV.coordsAtPos ? DV.coordsAtPos(行末, 1) : null; } catch (e) { return null; }
      })();
      const 后继 = (function () {
        try { return DV && DV.coordsAtPos && 后继点 >= 0 ? DV.coordsAtPos(后继点, 1) : null; }
        catch (e) { return null; }
      })();
      if (!占版面) {
        const p = host.querySelector('.cm-rmd-preedit');
        const 宽 = p ? p.getBoundingClientRect().width : 0;
        // ① 紧邻光标的下一个字被推右 / 顶到下一行（首选：与光标同一条视觉行，长度再长也不受折行干扰）
        if (后继0 && 后继 && 宽 > 0) {
          if (Math.abs(后继.top - 后继0.top) <= 1 && (后继.left - 后继0.left) >= 宽 * 0.8 - 1) {
            占版面 = '后一个字右移 ' + 四舍(后继.left - 后继0.left) + ' px（串宽 ' + 四舍(宽) + '）';
          } else if (后继.top > 后继0.top + 1) {
            占版面 = '整行折到下一行（y ' + 四舍(后继0.top) + ' → ' + 四舍(后继.top) + '）';
          }
        }
        // ② 退路：整条源码行的末尾（只在短行上灵敏，见上面 2026-11-12 的注）
        if (!占版面 && 行末0 && 末) {
          if (Math.abs(末.top - 行末0.top) <= 1 && 宽 > 0 && (末.left - 行末0.left) >= 宽 * 0.8 - 1) {
            占版面 = '行尾右移 ' + 四舍(末.left - 行末0.left) + ' px（串宽 ' + 四舍(宽) + '）';
          } else if (末.top > 行末0.top + 1) {
            占版面 = '整行折到下一行（y ' + 四舍(行末0.top) + ' → ' + 四舍(末.top) + '）';
          }
        }
        // ③ 还没认出来 ⇒ 把两把尺的读数都留在说明里（红时要能一眼判"产品没占版面"还是"尺子不灵"）
        if (!占版面) {
          诊断3b = '串宽 ' + 四舍(宽)
            + '；后继字 ' + (后继0 && 后继
              ? ('Δleft ' + 四舍(后继.left - 后继0.left) + ' / Δtop ' + 四舍(后继.top - 后继0.top))
              : '测不到')
            + '；行末 ' + (行末0 && 末
              ? ('Δleft ' + 四舍(末.left - 行末0.left) + ' / Δtop ' + 四舍(末.top - 行末0.top))
              : '测不到');
        }
      }
    }
    记('D1 组合期：活动块**之上**的块零位移（F6 的"除当前行外"）',
      上方位移 <= 0.01, '最大 ' + 四舍(上方位移) + ' px');
    // ⚠️ **承重的那条是 D1b**：只量几何判不出"改了文档但恰好没换行"（F6 强需求的原话是
    //    「只有输入在动」——组合期的中间态连文档都不许动）。
    记('D1b 组合期块内文本不变', 文本变了 === '',
      文本变了 ? ('已经从「' + 文本0.slice(0, 12) + '…」变成「' + 块内文本(host).slice(0, 12) + '…」（' + 文本变了 + '）') : '');
    记('D2 组合期：活动块只长高、且 ≤ 一行（组合串占版面）',
      高度增量 <= 行高 * 1.05 + TOL,
      'ΔH ' + 四舍(高度增量) + ' px / 行高 ' + 四舍(行高) + ' px');
    记('D1c 组合期：下游位移 == 活动块长高的那一点（⛔ 没有别的东西跟着跳）',
      下游对不上 <= TOL, '差 ' + 四舍(下游对不上) + ' px');
    const pre = host.querySelector('.cm-rmd-preedit');
    const 在行内 = !!(pre && pre.closest && pre.closest('.cm-line'));
    记('D3 组合串是**行内** widget（在 `.cm-line` 里、⛔ 不进文档）',
      !!pre && 在行内 && (pre.textContent || '').indexOf('nihao') >= 0
        && (getComputedStyle(pre).position || '') !== 'absolute'
        && 块全文(host).indexOf('nihao') < 0,
      pre
        ? ('文本「' + (pre.textContent || '').slice(0, 20) + '」· position '
          + getComputedStyle(pre).position + ' · 文档里'
          + (块全文(host).indexOf('nihao') >= 0 ? '有拼音（⛔ 进文档了）' : '没有拼音'))
        : '没有 .cm-rmd-preedit');
    // ⭐⭐ `D3b`（`bugs/0060` 第二版，2026-11-02 用户「按照 mardo 来修改」）：
    //    组合串必须**占版面**——⛔ 不是画在文字上面的覆盖层。判据是**几何**：
    //    行尾要么被推右（≈ 串宽），要么整段折到下一行。两条都做不到 ⇒ 它没进排版。
    记('D3b 组合串占版面（行尾被推右 / 或整段折行）', 占版面 !== '',
      占版面 || ('行尾坐标没动' + (诊断3b ? '；' + 诊断3b : '')));
    // ⭐⭐ `D3c`：组合串必须画在**插入点**上（⛔ 不是块首、⛔ 不是块尾）。
    //    ⚠️ 用 `view.posAtDOM(widget)` 判，⛔ 不用坐标：坐标会被折行/滚动搅进来，
    //    而"这个 widget 在文档的哪个偏移上"是**结构**问题，与版面无关。
    记('D3c 组合串画在插入点上（posAtDOM == 选区头）',
      !!pre && !!DV && typeof DV.posAtDOM === 'function'
        && (function () { try { return DV.posAtDOM(pre) === 插入点; } catch (e) { return false; } })(),
      pre ? ('widget @ ' + (function () { try { return DV.posAtDOM(pre); } catch (e) { return '?'; } })()
        + ' / 插入点 ' + 插入点) : '没有 .cm-rmd-preedit');

    /** 产品 `paint()` 会把光标的 `left` 取整并夹回可见区 ⇒ 判据要看得见这两步的痕迹。 */
    function caretR3d_of(el) {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    }

    /**
     * `D3d` 红时的补充读数：`coordsAtPos` 的两侧、自绘光标的行内 `left`、所在层的宽。
     * ⚠️ 2026-11-16 加：`pb0312` 上 `caret.left - 串右 = -0.777 px` 稳定复现（两次逐位相同），
     *    需要区分"产品画在左缘（真缺陷）"与"取整/夹回可见区造成的亚像素"。
     */
    function 诊断3d(el) {
      const 读 = function (pos, side) {
        try { return DV && DV.coordsAtPos ? 四舍(DV.coordsAtPos(pos, side).left) : 'n/a'; }
        catch (e) { return 'n/a'; }
      };
      const 层 = el && el.parentElement ? el.parentElement.getBoundingClientRect() : null;
      const 层宽 = el && el.parentElement ? el.parentElement.clientWidth : 0;
      return 'coordsAtPos(插入点,-1)=' + 读(插入点, -1)
        + ' / (插入点,1)=' + 读(插入点, 1)
        + '；自绘 caret inline-left=' + (el ? el.style.left : 'n/a')
        + ' width=' + (el ? el.style.width : 'n/a')
        + '；层 clientWidth=' + 层宽
        + (层 ? (' 右缘 ' + 四舍(层.right)) : '');
    }

    // ⭐⭐ `D3d`（2026-11-14 用户报告）：组合期自绘插入符必须画在组合串**之后**（右缘），
    //    ⛔ 不是串的左缘。「内容在光标的后面，等按了 Enter 真正输入之后，光标变成在内容的
    //    后面，产生跳动」——`side: 1` 时 caret.left == 串左缘，上屏后跳到串右缘。
    //    与 `bugs/0300`（`W7e`）同一条规律；⚠️ 两者**文档字节与光标偏移逐字相同**，
    //    只判偏移的判据在缺陷上恒绿 ⇒ 必须判**画出来的几何**。
    //    ⚠️ 右缘那侧留 **1 px**（不是 `TOL`）：产品 `paint()` 把光标的 `left` **取整**到
    //    整数 px，而串的右缘是亚像素 → 实测 `pb0312` 上 `caret.left 324 / 串右 324.777`
    //    ⇒ 差 −0.777 px 是取整造成的（`coordsAtPos` 两侧分别是 324.777 / 324，见 `诊断3d`）。
    //    ⛔ 左缘那侧**不放宽**：`side: 1` 那个缺陷把光标画在串左缘（差约 −35 px），
    //    1 px 的容差碰不到它（`bugs/0329` 记了这次判据调整的实测依据）。
    const 光标取整 = 1;
    const caret3d = host.querySelector('.cm-rmd-selectionLayer .cm-rmd-caret');
    const preR3d = pre ? pre.getBoundingClientRect() : null;
    const caretR3d = caret3d ? caretR3d_of(caret3d) : null;
    const d3d = !!preR3d && !!caretR3d && preR3d.width > 0
      && caretR3d.left >= preR3d.right - 光标取整
      && caretR3d.left > preR3d.left + TOL;
    记('D3d 组合期插入符画在组合串**之后**（⛔ 不是串的左缘）', d3d,
      preR3d && caretR3d
        ? ('caret.left ' + 四舍(caretR3d.left) + ' / 串 [' + 四舍(preR3d.left) + ', '
          + 四舍(preR3d.right) + ']，caret.left - 串右 = ' + 四舍(caretR3d.left - preR3d.right) + ' px'
          + (d3d ? '' : ('；' + 诊断3d(caret3d))))
        : (preR3d ? '没有 .cm-rmd-caret（自绘光标没画出来）' : '没有 .cm-rmd-preedit'));

    // —— ② 上屏：只改一处，下游只跟着**这一块的高度**走 ——
    // ⚠️⛔ 不能再要求"下游零位移"：组合串占 5 个 ASCII 宽、上屏的 `你好` 只占 2 个全角
    //    ⇒ 这一块可能少折回来一行，下游**本来就该**跟着上移。要钉的是"没有别的东西乱动"。
    const before2 = 几何();
    组合(ta, 'compositionend', '你好');
    await frames(2);
    const after2 = 几何();
    const 上屏位移 = 下游最大位移(before2, after2, i + 1);
    const 块Δ = after2[i].h - before2[i].h;
    记('D4 上屏（compositionend）：下游只跟着这一块的高度走（⛔ 没有别的东西跟着跳）',
      Math.abs(上屏位移 - Math.abs(块Δ)) <= TOL,
      '下游 ' + 四舍(上屏位移) + ' px / 块 ΔH ' + 四舍(块Δ) + ' px');
    记('D4c 上屏之后这一块的高度 ≤ 基线 + 一行',
      after2[i].h - h0 <= 行高 * 1.05 + TOL,
      'ΔH ' + 四舍(after2[i].h - h0) + ' px / 行高 ' + 四舍(行高) + ' px');
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
    // ⚠️⚠️ 判据是**文本**，⛔ 不是几何：几何随折行/测量时机变化，
    //     拿它当判据会把"撤销没撤干净"判成绿、把正常形态判成红。
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
    // ⭐ 第二版（2026-11-02）：组合串改成**行内占位**之后，摘要里不再记"组合期下游零位移"
    //    （那个量现在**本来就该**等于活动块长高的那一点），改记三个真正有意义的分量。
    摘要.F6 = {
      上方位移: 四舍(上方位移),
      高度增量: 四舍(高度增量),
      下游对不上: 四舍(下游对不上),
      上屏位移: 上屏位移,
      折行步位移: 折行步位移,
      撤销次数: 次数,
    };
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
  //   · `G5` 进入前后块高**逐像素不变**（2026-11-09 起变矮与变高都判红，`INV-LIVE-04` ①）。
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
    const 源行 = 块源(idx).split('\n');
    const 源行数 = 源行.length;
    // ⭐ 2026-11-12（`bugs/0298` 候选 1b）：围栏行现在是 `Decoration.replace({block:true})`
    //    的 block widget（`height: 0`），**不再是 `.cm-line`** ⇒ 视觉行数 = 源码行 − 围栏行。
    //    ⛔ 别再把 `lines.length === 源行数` 当"没装 lineWrapping"：那条口径已被 1b 取代
    //    （实测 `longcode/G2`：`.cm-line` 1 / 源码行 3，红的不是产品而是判据）。
    const 围栏行数 = 源行.filter(function (s) {
      return /^ {0,3}(?:`{3,}|~{3,})/.test(s);
    }).length;
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
    // ⚠️ 与 B-3b **同一个算式**（`docs/bugs/0025`）：`fences + blanks + softWraps`，
    //    行高取**计算值**。⛔ 别在这里写第三个版本。
    // ⛔ **2026-11-09 起"变高只记账"作废**（`INV-LIVE-04` ①）：进入瞬间块高逐像素不变，
    //    变矮（−7 px 那一族）与变高（长代码行的 20.141 px 那一族）都是缺陷。
    //    `slack` 只留作"结构性来源在哪"的诊断，目标 0 行。
    const slack = LM && typeof LM.layoutSlack === 'function'
      ? LM.layoutSlack(块源(idx))
      : { fences: 0, blanks: 0, softWraps: 0 };
    const 结构源行数 = slack.fences + slack.blanks + (slack.softWraps || 0);

    记('G1 长代码行：视图真的挂上来了', true,
      '块 ' + idx + '（' + 源行数 + ' 行源码）');
    记('G2 长代码行：一条源码行就一个视觉行（没装 lineWrapping）',
      lines.length === 源行数 - 围栏行数 && 最高 - 最矮 <= TOL && 最高 <= 行高 * 1.5,
      '`.cm-line` ' + lines.length + ' / 源码行 ' + 源行数
        + '（围栏 ' + 围栏行数 + ' 行已塌成 block widget，不计视觉行）'
        + '；行高 ' + 四舍(最矮) + '–' + 四舍(最高) + '（基准 ' + 四舍(行高) + '）');
    记('G3 长代码行：块内**真的**横向溢出（否则下面两条是空的）', 内滚动 > 1,
      'scrollWidth − clientWidth = ' + 四舍(内滚动) + ' px');
    记('G4 长代码行：横滚在块内，整篇不横移',
      页宽1 <= 页视0 + 1 && Math.abs(页宽1 - 页宽0) <= 1,
      '页面 scrollWidth ' + 页宽0 + ' → ' + 页宽1 + '（视口 ' + 页视0 + '）');
    // ⛔ **2026-11-09 起不矮＋不变高**（`INV-LIVE-04` ①）：ΔH 一律 ≤ 0.5 px（量化下限）。
    const ΔH长行 = Math.abs(now.h - base[idx].h);
    记('G5 长代码行：进入前后块高逐像素不变（⛔ 不再"变高只记账"）',
      ΔH长行 <= TOL,
      '原 ' + base[idx].h + ' / 视 ' + now.h + ' px（ΔH ' + 四舍(now.h - base[idx].h)
        + ' px；结构性来源 ' + 结构源行数 + ' 行，目标 0）');
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
  //    `N3b` 正文行上的拼音 == **那一行**的尺度。当时的组合串挂在 host 上、继承的是
  //    `live/box.js` 搬来的**块级**文字层 ⇒ 标题块里第二行（`cm-rmd-body`）上屏是正文、
  //    组合期却是标题字号。⭐ 2026-11-02 改成**行内 widget** 之后它住在 `.cm-line` 里，
  //    这两条变成"继承"的回归闸门（⛔ 别当成死判据：有人把它挪回绝对定位就会红）。
  //    ⚠️ 这两条只有真 DOM 量得到：`D3` 只判"组合串在行内"。
  function 正文字号() {
    const p = document.querySelector('#doc p');
    if (p) return parseFloat(getComputedStyle(p).fontSize) || 0;
    // 兜底：夹具里一段正文都没有（`blankmd` 那种）⇒ 读 token（仍是样式表那一份）。
    const v = getComputedStyle(document.documentElement).getPropertyValue('--reader-font-size');
    return parseFloat(v) || 0;
  }

  async function 跑行级排版(base, 摘要) {
    const d = docEl();
    const 表 = 块节点();
    let idx = -1;
    for (let i = 0; i < 表.length; i++) {
      if (window.rmd.liveBox.headingLevelOf(表[i]) > 0) { idx = i; break; }
    }
    if (idx < 0) {
      // ⚠️ 同 G/L：**既不记通过也不记跳过**（记跳过会让整轮退出码恒为 2），
      //    由 `block-probe.sh` 的 **N-覆盖** 统一要求"本轮至少有一份夹具真的跑了 N"。
      摘要.N = { 适用: false, 原因: '这份夹具里没有标题块' };
      return;
    }
    const 正文 = 正文字号();
    const node = 表[idx];
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
     * 组合一个串，**量下组合串的排版权重**，再用空 `compositionend` 取消（⛔ 不落进文档）。
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

  // ── S 段：**行内上标的行盒**（`bugs/0303`）────────────────────────────────
  //
  // 用户看到的形态：段落里提到脚注的那一行**比上下的行离得远一点**（不是字大了，是那一行的
  // **行盒**高了）；同时点进这一块编辑，整块**矮 3.94 px**（B 段 `-3a` 就是在这里红的）。
  //
  // 机理：`<sup>` 的 `vertical-align` 走 UA 默认的 `super`（把元素盒整体抬高），而它的
  // `line-height` 仍是 `normal` ⇒ 抬高后的**行内盒**超出本行 strut ⇒ 行盒按"最高/最低的行内盒"
  // 算 ⇒ 该行从 23.80 涨到 27.73 px（14 px × 1.7）。修法是把**行内盒对行盒高度的贡献**归零
  // （`.doc sup { line-height: 0 }`），⛔ 不是改字号、也不是在编辑态补 3.94 px。
  //
  // ⚠️ 为什么必须在**真 DOM** 里量：这条缺陷在样式表里只有一行声明，源码级判据（`lint-theme`、
  //    `typography.test.js`）都扫不到"行盒高了"这件事——它只在排版引擎里成立。
  // ⚠️ 量的口径：段内**除 `<sup>` 以外**的文字节点，用 `Range.getClientRects()` 取**每条视觉行**
  //    的矩形顶边（⛔ 块级元素的 `getBoundingClientRect()` 只给一个盒子，数不出视觉行），
  //    相邻顶边之差就是**行距**。上标自己的矩形**不参与**——它本来就比正文行高，参与的话
  //    修好之后仍会因为"上标盒顶比正文高"而假红。
  function 行顶表(el) {
    const 顶 = [];
    const 走 = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = 走.nextNode())) {
      const v = String(n.nodeValue || '');
      if (!v.trim()) continue;
      const p = n.parentNode;
      // ⚠️ `closest` 在文本节点的**父元素**上调：`<sup>` 里那个 `1` 就是这么排除掉的。
      if (p && p.closest && p.closest('sup')) continue;
      const rg = el.ownerDocument.createRange();
      rg.selectNodeContents(n);
      const rs = rg.getClientRects();
      for (let k = 0; k < rs.length; k++) {
        const r = rs[k];
        if (!r || r.height <= 0 || r.width <= 0) continue;
        // 聚簇容差 2.5 px：同一视觉行里**行内代码/等宽字体**的字盒比正文高 1 px 以上
        // （`可见行带` 那条注释实测 1.36 px）——容差 ⛔ 不能小于它，否则一行被劈成两行、
        // "行距"里凭空多出 0 px。
        // ⚠️ 也⛔ 别放大到行距的量级（脚注区最小 21.4 px / 正文 23.8 px）——那样相邻两行会被
        // 并成一行，判据恒绿。
        let 已 = false;
        for (let m = 0; m < 顶.length; m++) {
          if (Math.abs(顶[m] - r.top) < 2.5) { 已 = true; break; }
        }
        if (!已) 顶.push(r.top);
      }
    }
    顶.sort(function (a, b) { return a - b; });
    return 顶;
  }

  async function 跑脚注行盒(摘要) {
    const d = docEl();
    // ⚠️ 只认 **GFM 的脚注引用**：锚点是 `a[data-footnote-ref]`（`<sup class="footnote-ref"><a
    //    data-footnote-ref>1</a></sup>`）。⛔ 别按 `sup.footnote-ref` 抓——文末那条**回跳箭头**
    //    也是 `<sup class="footnote-ref">`（`…↩<sup class="footnote-ref">2</sup>`），会把
    //    "脚注定义这一段"当成引用块，而它是**松散列表**（`<li><p>`）⇒ `S1` 恒红（2026-11-10 实测
    //    `最差 15.391 px`，差值全是当时 `bugs/0021` 的列表段距，与上标无关；
    //    `design/0066` 起列表内段距已删，但"⛔ 别按标签选脚注引用"这条仍然成立）。
    const 引用 = d ? Array.prototype.map.call(d.querySelectorAll('a[data-footnote-ref]'), function (a) {
      return a.closest('sup') || a;
    }) : [];
    if (!引用.length) {
      摘要.S = { 适用: false, 原因: '这份夹具里没有被引用的脚注（没被引用 ⇒ `<sup>` 不物化）' };
      return;
    }
    const 块表 = [];
    for (let i = 0; i < 引用.length; i++) {
      // 取**块的容器**：段落 / 列表项 / 格 / 引用块 / 标题。
      //   ⚠️ 取到 `li` 而不是 `ul`：要量的是**这一项**的行距，不是整张列表的行距。
      const b = 引用[i].closest('li, p, td, th, blockquote, h1, h2, h3, h4, h5, h6');
      if (b && 块表.indexOf(b) < 0) 块表.push(b);
    }
    let 最差 = 0;
    let 量到 = 0;
    const 明细 = [];
    for (let i = 0; i < 块表.length; i++) {
      const 顶 = 行顶表(块表[i]);
      // 单视觉行 ⇒ 没有"行距"可判（例如引用落在只剩一行的格里）：
      //   ⛔ 不记通过，如实写进说明，由 `S-覆盖` 判"这一轮到底有没有量到"。
      if (顶.length < 2) {
        明细.push({ 标签: String(块表[i].tagName || ''), 视觉行: 顶.length, 行距: null });
        continue;
      }
      const 距 = [];
      for (let k = 1; k < 顶.length; k++) 距.push(四舍(顶[k] - 顶[k - 1]));
      const 差 = 四舍(Math.max.apply(null, 距) - Math.min.apply(null, 距));
      最差 = Math.max(最差, 差);
      量到++;
      明细.push({ 标签: String(块表[i].tagName || ''), 视觉行: 顶.length, 行距: 距, 差: 差 });
    }
    记('S1 阅读态：带脚注引用的块里每条视觉行的**行距**相同（≤ ' + 四舍(TOL) + ' px；`bugs/0303`）',
      量到 > 0 && 最差 <= TOL,
      '量了 ' + 量到 + ' 块，最差 ' + 四舍(最差) + ' px'
        + (量到 > 0 ? '' : '（引用只落在单视觉行的块里 ⇒ 没有行距可判，⛔ 不算通过）')
        + '；' + JSON.stringify(明细));
    摘要.S = { 适用: true, 引用块: 块表.length, 量到: 量到, 最差: 四舍(最差), 明细: 明细 };
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
  /** 影子容器的 DOM 引用（`刷新oracle()` 用它把旧的那一份摘掉，⛔ 不留在页面上叠盒子）。 */
  let ORACLE_盒 = null;

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
      + '<p>x</p><ul><li>x</li></ul><blockquote><p>x</p></blockquote><pre><code>x</code></pre>'
      // ⭐ `design/0066` 模型 A：列表内的空行在阅读态**占一个行高**（`render.rs` 写
      //    `data-blanks` ⇒ `margin-top: n × --reader-line-height × 1em`）。这里放一条
      //    与渲染侧同形的 `<li data-blanks="1">` ⇒ 期望值仍由**产品自己的样式表**算出，
      //    ⛔ 不抄 `1.7 × 字号` 这个算法（`INV-LIVE-07`）。
      + '<ul><li data-blanks="1" style="--rmd-blanks:1">x</li></ul>'
      // ⭐ `design/0085` C3：**引用里**的空行按该语境的行高（世界里是 `--reader-quote-lh`），
      //    与上面那条全局行高**不是一个值**。它必须单独量一份，⛔ 不能拿全局那份冒充。
      + '<blockquote><ul><li data-blanks="1" style="--rmd-blanks:1">x</li></ul></blockquote>';
    document.body.appendChild(box);
    const 量 = function (sel) {
      const el = box.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        字号: parseFloat(cs.fontSize) || 0,
        行高: parseFloat(cs.lineHeight) || 0,
        字重: parseFloat(cs.fontWeight) || 0,
        // ⭐ `design/0085` C5：标题在阅读态比正文**深一档**（`typography.css:63`）。
        //    期望值仍由产品自己的样式表算（`INV-LIVE-07`），⛔ 不抄色值。
        字色: cs.color || '',
        // ⭐ `design/0085` C2：下外边距也是"随根字号重解析"的那一半（`box.js` 写的是
        //    `calc(var(--reader-font-size) * k ± b)`）。⛔ 不抄 px，值由样式表算。
        外边距: parseFloat(cs.marginBottom) || 0,
      };
    };
    const m = { h1: 量('h1'), h2: 量('h2'), h3: 量('h3'), h4: 量('h4'),
      h5: 量('h5'), h6: 量('h6'), p: 量('p'), li: 量('li'),
      quote: 量('blockquote p'), code: 量('pre code') };
    // 列表内一条空行在阅读态的高度（`design/0066` 模型 A）＝ `li[data-blanks="1"]` 的
    // `margin-top`（它自己那行的行高由内容给出，空行只加这一截）。
    try {
      const 空 = box.querySelector('li[data-blanks]');
      m.空行高 = 空 ? (parseFloat(getComputedStyle(空).marginTop) || 0) : 0;
      // ⭐ `design/0085` C3：引用语境里那一条（`bugs/0318` 的两态都等于**该处**一行高）。
      const 引空 = box.querySelector('blockquote li[data-blanks]');
      m.引用空行高 = 引空 ? (parseFloat(getComputedStyle(引空).marginTop) || 0) : 0;
    } catch (e) { m.空行高 = 0; m.引用空行高 = 0; }
    // ⚠️ 这里**曾经**还量过"松散列表两项之间的段距"（`bugs/0021`）。`design/0066`
    //    （2026-11-11）起列表内没有段距（`.doc li > p { margin: 0 }`）⇒ 那个量恒为 0，
    //    而且从来没有消费者，已随模型 A 一并删除。⛔ 别再按"阅读态有一段段距"写判据。
    ORACLE = m;
    ORACLE_盒 = box;
    return m;
  }

  /**
   * ⭐ `design/0085` C2：**根字号变了，oracle 必须重算**。
   *
   * oracle 的每个值都是"产品样式表在当前根变量下算出来的结果"，而 `oracle()` 有缓存
   * ⇒ 改完 `--reader-font-size` 不刷新，`逐行对照` 会拿旧字号当期望（判据恒绿）。
   * 刷新 = 摘掉旧影子盒子 + 重新量（⛔ 不手改任何数字）。
   */
  function 刷新oracle() {
    if (ORACLE_盒 && ORACLE_盒.parentElement) ORACLE_盒.parentElement.removeChild(ORACLE_盒);
    ORACLE = null;
    ORACLE_盒 = null;
    return oracle();
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
   * ⚠️ 围栏内部一律 `code`；围栏行**自己**是 `fence`——`design/0052` U5 ＋ `0061` L1 之后
   *    它只剩**一种**合法形态：整行塌成 0 高。由 `逐行对照()` 判，⛔ 别把它并进 `code`
   *    （那样塌掉和"字号丢了"分不开）。
   */
  function 行品种(源) {
    const 行s = String(源).split('\n');
    const out = [];
    let fence = null;
    for (let i = 0; i < 行s.length; i++) {
      // ⚠️ **引用里的围栏**（`> ```）也算围栏**：先剥 `>` 前缀再认，否则这一行被当成正文
      //    ⇒ `逐行对照` 用正文 oracle（字号 14）去量围栏行（塌成 0）/代码行（12.6）
      //    ⇒ `O-blockquote-*` 整族假红（2026-11-12 `shapes.md` 实测）。
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(去引用前缀(行s[i]));
      if (f) {
        fence = fence === null ? f[1].charAt(0) : null;
        out.push('fence');
        continue;
      }
      if (fence !== null) { out.push('code'); continue; }
      // ⚠️ **列表项里的标题**（2026-11-12 实测）：`2. ## 小标题…` 在 CommonMark 里合法，
      //    comrak 渲染成 `<ol><li><h2>…</h2></li></ol>`（`/tmp/fx-probe` 小夹具实测）。
      //    旧实现只剥 `>` 前缀 ⇒ 这条按 body（14 px）去量 24.5 px 的标题行，
      //    `tasks/O-ol-4`、`O-ol-5c` 假红（2026-11-12 窄视口 760 打字造出这种行）。
      //    ⇒ 标题判定前再把**列表标记**剥掉（最多 4 层，够嵌套用）。
      //    ⚠️ **任务框不剥**：`- [ ] ## 小标题` 在 comrak 里**不是**标题——勾选框是行内
      //    内容，`##` 只是跟在它后面的字面量（`/tmp/fx-probe` 实测 `<li><input> ## 小标题`）。
      //    剥掉 `[ ] ` 会把这种行误判成 h2（2026-11-12 实测：`tasks/O-ul-4`、`O-blockquote-4`
      //    反向假红——产品 14 px 是对的）。
      let 标题候选 = 去引用前缀(行s[i]);
      for (let k = 0; k < 4; k++) {
        const m = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]*/.exec(标题候选);
        if (!m || !m[0]) break;
        标题候选 = 标题候选.slice(m[0].length);
      }
      const h = /^ {0,3}(#{1,6})(\s|$)/.exec(标题候选);
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
   *
   * ⭐ `bugs/0090` 的**引文空行**（`cm-rmd-quote-gap`）不是"字号错了"，它在阅读态里
   *    **根本没有这一行**，只是一段段距 ⇒ 按行判字号/行高必然假红。这里给它一条**等价几何**
   *    判据：行盒高 == 进编辑态前从**阅读态 DOM 实测**的"下一段 top − 上一段 bottom"。
   *    ⛔ 不拿 `--reader-gap-block` 的值当 oracle（那等于把产品算法抄第二遍）；
   *    `引文段距` 由 `量阅读态段距()` 在换进编辑态**之前**量好。
   *
   * @param {Element} host
   * @param {string} 键
   * @param {number[]|null} [引文段距] 阅读态相邻两段的实测间距（自上而下）
   * @param {(number|undefined)[]|null} [引用缩进] 阅读态第 1/2/3 层的文字左缘（`design/0085` C4）
   * @returns {{ok:boolean, msg:string, 行数:number}}
   */
  function 逐行对照(host, 键, 引文段距, 引用缩进) {
    const 源 = 块全文(host);
    const 源行们 = 源.split('\n');
    const 品种 = 行品种(源);
    const 塌 = 塌行表(源);
    const lines = host.querySelectorAll('.cm-line');
    // ⭐⭐ 2026-11-12（`bugs/0298`）：围栏分隔行走**块级 `Decoration.replace` ＋ 零高
    //    widget** ⇒ 它在 DOM 里**连 `.cm-line` 都没有**。⇒ `.cm-line` 与源码行**不再**
    //    一一对应，必须先把围栏行从源码侧扣掉再按序对。
    //    ⚠️ 只扣 `fence`：Setext 下划线、`cm-rmd-collapsed`、`cm-rmd-quote-gap` 都**仍是**
    //    带 `.cm-line` 的普通行（前者高 0，后者承载段距），由各自的支路判。⛔ 别一并扣掉，
    //    那会让"这一行整条消失"和"它塌成 0 高"分不开。
    const 应有 = [];
    for (let i = 0; i < 品种.length; i++) if (塌[i] !== 'fence') 应有.push(i);
    if (lines.length !== 应有.length) {
      return { ok: false, 行数: lines.length,
        msg: '`.cm-line` ' + lines.length + ' 行 ≠ 源码 ' + 品种.length + ' 行扣掉 '
          + (品种.length - 应有.length) + ' 条围栏行后的 ' + 应有.length
          + '（视口裁剪或折行 ⇒ 这一条不承重）' };
    }
    const bad = [];
    let 引文序 = 0;
    for (let k = 0; k < 应有.length; k++) {
      const i = 应有[k];            // 源行号（0-based）——⛔ 不是渲染序
      const el = lines[k];
      // ⭐ 引文空行（`bugs/0090`）：它承载的是**段距**，不是一整行正文。
      if (el.classList && el.classList.contains('cm-rmd-quote-gap')) {
        const 序 = 引文序++;
        // ⭐⭐ 2026-11-12（`bugs/0318`）：`design/0066` 起**列表内的空行在阅读态占恰好
        //    一行高**（`render.rs::写空行属性` → `data-blanks` → `margin-top = n × 行高`），
        //    不是段距。⇒ 空引用行**两侧都是列表项**时，"阅读态量不到段距"是**正常**的，
        //    期望值改问 body 的行高（同一份独立 oracle，⛔ 不读产品 CSS 变量）。
        //    ⚠️ 先看有没有可量的段距；有就仍按段距判（段落之间的引用空行，`bugs/0090`）。
        if (!引文段距 || !引文段距.length) {
          const 前 = i > 0 ? 源行们[i - 1] : '';
          const 后 = i + 1 < 源行们.length ? 源行们[i + 1] : '';
          const 是列表行 = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
          // ⚠️ 这里要的是**阅读态那条空行自己的高度**（`data-blanks` 的 margin），
          //    ⛔ 不是块基线的行高（引用块里基线行高是 1.45 倍，而空行用的是 1.7 倍）。
          //    ⭐ `design/0085` C3 起，引用语境里的那份**也是 1.45 倍**（`bugs/0318`）⇒
          //    取 `引用空行高`（同一个独立 oracle，仍⛔ 不读产品算法）。
          const 期行高 = (是列表行.test(前) && 是列表行.test(后))
            ? ((oracle().引用空行高) || 0) : 0;
          if (!(期行高 > 0)) {
            bad.push('第' + (i + 1) + '行(quote-gap) 阅读态量不到段距（oracle 缺失）');
          } else {
            const 实高 = el.getBoundingClientRect().height;
            if (Math.abs(实高 - 期行高) > 0.5) {
              bad.push('第' + (i + 1) + '行(quote-gap，两侧都是列表项 ⇒ 应占一行高 '
                + '`design/0066`) 行盒高 ' + 四舍(实高) + '≠阅读态行高 ' + 四舍(期行高));
            }
          }
        } else if (序 >= 引文段距.length) {
          bad.push('第' + (i + 1) + '行(quote-gap) 阅读态只有 ' + 引文段距.length + ' 处段距');
        } else {
          const 实高 = el.getBoundingClientRect().height;
          if (Math.abs(实高 - 引文段距[序]) > 0.5) {
            bad.push('第' + (i + 1) + '行(quote-gap) 行盒高 ' + 四舍(实高)
              + '≠阅读态段距 ' + 四舍(引文段距[序]));
          }
        }
        continue;
      }
      // ⚠️ 这里**曾经**有一条 `cm-rmd-li-sep` 支路（`bugs/0021` 的「列表段距」空行）。
      //    `design/0066`（2026-11-11）之后列表内不再有段距 ⇒ 那类行不存在了，支路删除。
      //    ⭐ 新的判据**不在这里**：模型 A 下空行就是普通一行高，它由 `W8L-*` 的
      //    「项距 ≡ 源码行数 × 行高」与 `B*-3a` 的「两态块高逐像素相同」承重——
      //    ⛔ 别再补一条"看到某个类就放行"的支路。
      // ⭐⭐ 2026-11-10（`bugs/0307` ②）：**连续多条**多余空行在阅读态**没有行盒**
      //    （它们只是两个块之间的空隙）⇒ 编辑态塌成 0 高。判据是**量出来的行盒高 ≈ 0**，
      //    ⛔ 不是"看到这个类就放行"（那样把它改成一整行高也照样绿）。
      //    ⚠️ 这个类在 `bugs/0090`/`0021` 时代就有，但此前没有一份夹具带**连续两条**
      //    列表内空行 ⇒ 这一支从来没有被判过。
      if (el.classList && el.classList.contains('cm-rmd-collapsed')) {
        const 实高 = el.getBoundingClientRect().height;
        if (实高 > 0.5) bad.push('第' + (i + 1) + '行(collapsed) 行盒高 ' + 四舍(实高) + '≠0');
        continue;
      }
      // ⚠️ 围栏行**走不到这里**：`bugs/0298` 之后它是块级 widget，DOM 里没有 `.cm-line`，
      //    已经在上面按源码扣掉了。它"塌没塌"由 `B*-3a` 的块高与下面的行数断言承重；
      //    ⛔ 别在这里补一条"字号 ≤ 0.5 就放行"的支路（那等于允许它重新长出 `.cm-line`）。
      // ⭐ `design/0085` C4：**嵌套引用的第二层起**，行级盒子必须把该层补齐
      //    （`data-rmd-qdepth` ⇒ `live.css` 的 `border-left` ＋ `padding-left`）。
      //    判据两条，**都独立于产品**：
      //    ① 属性值 == 源码层数 − 1（宿主已搬第一层；⛔ 不读 `decorations.js` 的计数）；
      //    ② 这一行**文字的绝对左缘** == 阅读态同一层的实测左缘（`量阅读态引用缩进`）。
      //    ⚠️ 第 ① 条抓"层数算错 / 少挂一层"，第 ② 条抓"盒子的宽度不对"——只判属性
      //    存在与否会被"挂上了但宽度为 0"骗过（`INV-LIVE-24` 的那类退化）。
      //    ⚠️ 只判**正文行**：列表项的文字左缘由 `margin-left` 叠出来，标题行另有
      //    `heading-space` 内边距，都不属于引用盒（它们各有自己的判据）。
      if (引用缩进 && 键 === 'quote' && 品种[i] === 'body') {
        const 层 = 行引用层数(源行们[i]);
        const 去引 = 去引用前缀(源行们[i]);
        const 是列表行 = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.test(去引);
        const 有字 = 去引.trim() !== '';
        if (层 >= 1 && !是列表行 && 有字) {
          const 实attr = el.getAttribute ? el.getAttribute('data-rmd-qdepth') : null;
          // 层 1 的盒子在宿主上（`box.js` 搬了顶层元素）⇒ 行级属性只补**多出来的**几层；
          // 产品把层数封顶到 3（`decorations.js` 的 `Math.min(补, 3)`）。
          const 期望attr = 层 === 1 ? null : String(Math.min(层 - 1, 3));
          if ((实attr || null) !== 期望attr) {
            bad.push('第' + (i + 1) + '行 引用层 ' + 层 + ' 的 `data-rmd-qdepth` 是 '
              + (实attr === null ? '（没有）' : '「' + 实attr + '」') + '，应为 '
              + (期望attr === null ? '（没有）' : '「' + 期望attr + '」'));
          } else if (层 >= 2 && 层 <= 3) {
            const 期望左 = 引用缩进[层 - 1];
            const 宿主 = host.getBoundingClientRect();
            let 实左 = null;
            try {
              const rg = document.createRange();
              rg.selectNodeContents(el);
              const rr = rg.getBoundingClientRect();
              if (rr.width > 0) 实左 = rr.left - 宿主.left;
            } catch (e) { void e; }
            if (typeof 期望左 !== 'number') {
              bad.push('第' + (i + 1) + '行 阅读态量不到第 ' + 层 + ' 层引用的文字左缘（oracle 缺失）');
            } else if (实左 === null) {
              bad.push('第' + (i + 1) + '行 编辑态量不到文字左缘');
            } else if (Math.abs(实左 - 期望左) > 1) {
              // ⚠️ 容差 1 px：每层条宽会被浏览器吸附到整设备像素，而编辑态是**一条**
              //    叠加后的边框、阅读态是**逐层各一条**（`design/0085` §10 的 C4 差异）。
              bad.push('第' + (i + 1) + '行（引用第 ' + 层 + ' 层）文字左缘 '
                + 四舍(实左) + '≠阅读态 ' + 四舍(期望左));
            }
          }
        }
      }
      const 期 = 期望样式(品种[i], 键);
      if (!期) continue;
      const d = 比样式(el, 期);
      // ⭐ `design/0085` C5：**标题字色**必须与阅读态同色（阅读态 `.doc hN` 比正文深一档）。
      //    ⚠️ `比样式` 只比字号/行高/字重（正文与代码的字色受内联代码、链接等影响，
      //    行级比对会把"这一行里有链接"当成错）⇒ 字色只对**标题行**判，口径与 C5 一致。
      //    ⛔ 别扩到 body/code：那两类没有"整行一个色"的语义。
      if (/^h[1-6]$/.test(品种[i]) && 期.字色) {
        const 实色 = getComputedStyle(el).color || '';
        if (实色 !== 期.字色) d.push('字色 ' + 实色 + '≠' + 期.字色);
      }
      if (d.length) bad.push('第' + (i + 1) + '行(' + 品种[i] + ') ' + d.join('／'));
    }
    return { ok: bad.length === 0, 行数: lines.length, msg: bad.slice(0, 3).join('；') };
  }

  /**
   * ⭐ **阅读态实测的"段与段之间"间距**（`bugs/0090` 的等价几何 oracle）。
   *
   * 只在**换进编辑态之前**调用：宿主替换之后阅读态那块节点就不在树上了（rect 全 0）。
   * 取法：这一块（引用块）的直接元素子节点，按文档顺序量 `下一段.top − 上一段.bottom`；
   * 它把 `--reader-gap-block`、相邻段的外边距折叠等**样式表算出来的结果**一起量进来，
   * ⛔ 不照抄任何 CSS 变量的值（那等于把产品算法抄第二遍）。
   *
   * @param {Element|null} el 阅读态的顶层块节点
   * @returns {number[]|null} 自上而下的段距；不是引用块 ⇒ `null`
   */
  function 量阅读态段距(el) {
    if (!el || String(el.tagName || '').toLowerCase() !== 'blockquote') return null;
    const 子 = [];
    for (let i = 0; i < el.children.length; i++) {
      const c = el.children[i];
      if (!c.getClientRects || c.getClientRects().length === 0) continue;
      子.push(c);
    }
    const 间 = [];
    for (let i = 0; i + 1 < 子.length; i++) {
      const a = 子[i].getBoundingClientRect();
      const b = 子[i + 1].getBoundingClientRect();
      const g = b.top - a.bottom;
      if (isFinite(g) && g >= 0) 间.push(g);
    }
    return 间;
  }

  /**
   * ⭐ `design/0085` C4 的**独立 oracle**：阅读态里第 1/2/3 层引用的**文字左缘**
   * （相对本块 border-box 左缘）。
   *
   * 取法：引用块里每个 `<p>` 往上数它在**本块之内**有几层 `<blockquote>`，层数 = 嵌套数 + 1；
   * 左缘 = 该段 `rect.left − 本块 rect.left`。它把每层各自的 `border-left` 与 `padding`
   * **一层层量进来**（浏览器还会把每层的条宽吸附到整设备像素）⇒ ⛔ 不存在"层数 × 一个常数"
   * 这种算法，也不读任何产品变量。
   *
   * ⚠️ 列表项里的段落左缘由 `margin-left` 叠出来，**不参与**（C4 判的是引用盒）；
   * 同一层只取第一段（同层正文段左缘相同）。
   *
   * @param {Element|null} el 阅读态的顶层块节点
   * @returns {(number|undefined)[]|null} 下标 = 层数 − 1；不是引用块 ⇒ `null`
   */
  function 量阅读态引用缩进(el) {
    if (!el || String(el.tagName || '').toLowerCase() !== 'blockquote') return null;
    const 外 = el.getBoundingClientRect();
    if (!外.width) return null;
    const 表 = [];
    const ps = el.querySelectorAll('p');
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      let 层 = 0;
      let 有列表 = false;
      let n = p.parentElement;
      while (n && n !== el) {
        const t = String(n.tagName || '').toLowerCase();
        if (t === 'blockquote') 层 += 1;
        if (t === 'li') 有列表 = true;
        n = n.parentElement;
      }
      if (n !== el) continue;
      层 += 1;                       // 本块自己是第一层
      if (有列表 || 层 < 1 || 层 > 3) continue;
      const r = p.getBoundingClientRect();
      if (!r.width) continue;
      if (表[层 - 1] === undefined) 表[层 - 1] = r.left - 外.left;
    }
    for (let i = 0; i < 表.length; i++) if (typeof 表[i] === 'number') return 表;
    return null;
  }

  /** 一行源码的引用层数（`> > x` ⇒ 2）；⛔ 不读产品的 `引用层` 计数。 */
  function 行引用层数(行) {
    const m = /^ {0,3}((?:>[ \t]?)+)/.exec(String(行));
    return m ? (m[1].match(/>/g) || []).length : 0;
  }

  /**
   * 第 `n` 个**源码行**（0-based，与 `光标行()` / `doc.line` 同一套编号）的 `.cm-line`；
   * 该行没有行元素（围栏行块级 widget，`bugs/0298`）或越界 ⇒ `null`。
   *
   * ⚠️ 2026-11-12：旧实现是 `.cm-line[n]`——**渲染序**。围栏行不再有 `.cm-line` 之后
   *    两套编号就错开了，`O-*-4` 会去量**上面某一行**还照样"看起来对"（假绿风险）。
   *    ⇒ 改成问 CM6 要那一行行首的 DOM 位置，再往上爬到行元素；读不到就 `null`，
   *    由调用方如实记红，⛔ 不退回按渲染序数。
   */
  function 行节点(host, n) {
    if (!(n >= 0)) return null;
    const V = 视图(host);
    if (!V || !V.state) return null;
    try {
      const doc = V.state.doc;
      if (n >= doc.lines) return null;
      const p = V.domAtPos(doc.line(n + 1).from);
      let el = p && p.node ? (p.node.nodeType === 1 ? p.node : p.node.parentElement) : null;
      while (el && !(el.classList && el.classList.contains('cm-line'))) el = el.parentElement;
      return el || null;
    } catch (e) { return null; }
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
    const node = 块节点()[i];
    // ⚠️ 必须在点击**之前**量：宿主换上来之后阅读态那个节点就不在树上了。
    const 引文段距 = 量阅读态段距(node);
    const 引用缩进 = 量阅读态引用缩进(node);
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
    r.进入时 = 逐行对照(host, 基键, 引文段距, 引用缩进);
    记('O-' + 标签 + '-1 进入时逐行样式 ≡ 渲染态', r.进入时.ok, r.进入时.msg);

    // ② ⭐ 回车：新行必须是**它自己源码**该有的样子（正文块就是正文，代码块就是代码）
    // ⚠️⚠️ `点末` 点的是**第一行右侧** ⇒ 回车插在**第 1 行之后**，⛔ 不是块末。
    //    早先这一段按"末行"取节点 ⇒ 多行块（`ul` 5 行）取到的是**原来那一行**，
    //    于是 `-4` 判的是"没被敲过的行"，红的是**探针的取行**而不是产品。
    const 前行 = 光标行(host);
    // ⭐ `bugs/0313`（2026-11-12）：**行首**回车时插入的换行在光标**之后**、光标停在新建的
    //    空行上（原行内容整体下移）⇒ 光标行号**不**前进。⇒ 先记下回车前的行内偏移，
    //    再按两类分别判。⛔ 不能一律要求 `前行 + 1`（那会把 0313 的正确形态判红）。
    const 前偏 = (function () {
      try {
        const V = 视图(host);
        if (!V || !V.state) return -1;
        const h = V.state.selection.main.head;
        return h - V.state.doc.lineAt(h).from;
      } catch (e) { return -1; }
    })();
    键(ta, 'Enter');
    await frames(2);
    r.回车后行数 = 块全文(host).split('\n').length;
    r.回车行 = 光标行(host);
    // ⭐ 2026-11-12：把**光标在行内的偏移**也记下来——"回车续标记后光标落在行首还是正文起点"
    //    是判"下一次退格删的是换行还是标记"的唯一线索（760 宽折行块上实测过两种读法都说得通）。
    const 视图O = (function () {
      try {
        const CM6 = window.rmdCM6;
        return CM6 && CM6.EditorView && CM6.EditorView.findFromDOM
          ? CM6.EditorView.findFromDOM(host) : null;
      } catch (e) { return null; }
    })();
    const 行内偏 = (function () {
      try {
        if (!视图O || !视图O.state) return -1;
        const h = 视图O.state.selection.main.head;
        return h - 视图O.state.doc.lineAt(h).from;
      } catch (e) { return -1; }
    })();
    const 行首回车 = 前偏 === 0;
    记('O-' + 标签 + '-2 回车确实长出一行（且光标落在新行上）',
      r.回车后行数 === 行0 + 1 && (行首回车 ? r.回车行 === 前行 : r.回车行 === 前行 + 1),
      '行数 ' + 行0 + ' → ' + r.回车后行数 + '；光标行 ' + 前行 + ' → ' + r.回车行
        + '；回车前行内偏移 ' + 前偏 + '；光标偏移 ' + 行内偏 + '（0 = 行首）'
        + (行首回车 ? '；行首回车（`bugs/0313`）：新空行建在光标处、原行内容下移' : ''));
    r.回车后 = 逐行对照(host, 基键, 引文段距, 引用缩进);
    记('O-' + 标签 + '-3 ⭐ 回车长出的新行样式 ≡ 渲染态（0015 的通用形式）',
      r.回车后.ok, r.回车后.msg);

    // ⭐ `bugs/0108`（2026-11-07）起，**列表项行尾回车续标记**（Mardo 同款）⇒ 新行是
    //    `- ` / `4. ` 这样的**空列表项**。本节 ③④⑤ 判的是"敲出 `## 小标题` 之后样式
    //    ≡ 渲染态"，前提必须是**正文行**：在空项上按一次退格＝删标记退列表
    //    （`input.js::lineBreakAction` 的空项分支，Typora/Obsidian 通用惯例），
    //    之后敲标题才是本节要量的事。⛔ 不是弱化判据——③④⑤ 的样式对照一个字没改；
    //    "回车续标记"本身由 W7 段承重。
    //    ⚠️⚠️ **2026-11-12（760 宽实测）**：`点末()` 点的是**第一视觉行**的右缘，折行段落上
    //    `posAtCoords` 解出的位置可能在**源码行中** ⇒ 回车把有序项从中间劈开，新行是
    //    **带内容的**列表项（`2. `TaskItem`…`），⛔ 不是空项。此时再按一次退格删掉的是
    //    **那个换行**（两行并回一行、`2. ` 留在行中）——`O-*-4` 随即假红（实测源码
    //    「1. …会物化 2. ## 小标题`TaskItem`…」）。⇒ 只有**空列表项**才按退格退列表；
    //    行中劈开的情形照实记成"跳过"并在 ④⑤ 说明原因，⛔ 不拿"合并两行"冒充"退出列表"。
    const 回车行0 = 行节点(host, r.回车行);
    const 回车行0文 = r.回车行 >= 0 ? String(块全文(host).split('\n')[r.回车行] || '') : '';
    // ⚠️ **2026-11-12 第二轮实测**：`> ` 引用前缀也算"空项前面那点东西"。只认
    //    `- ` / `1. ` 时，引用里的空列表项（源码 `> - `）被判成"行中劈开" ⇒
    //    退格那一步被跳过，③ 直接在 `> - ` 后面敲出 `> - ## 小标题`（行内代码里的标题），
    //    `O-blockquote-4/5c` 假红。⇒ 前缀里允许 `>` 与空白任意组合。
    const 是空项 = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]*$/.test(回车行0文);
    let 行中劈开 = false;
    if (回车行0 && 回车行0.hasAttribute('data-rmd-li')) {
      if (是空项) {
        键(ta, 'Backspace');
        await frames(2);
        r.回车后行数 = 块全文(host).split('\n').length;
      } else {
        行中劈开 = true;
      }
    }

    // ③ 在**光标那一行**敲 `## 小标题`：样式仍必须等于 oracle
    //    （非围栏块 → h2 尺度；代码块里这是**代码**，⛔ 不该变标题）
    // ⚠️⚠️ 判"以它开头"而**不是**"等于它"：`点末()` 点的是**第一视觉行**的右缘，
    //    段落/引用这类会折行的块上，`posAtCoords` 的列估计未必落在真正的行端 ⇒ 回车可能把那一段
    //    **从中间劈开**，敲进去的字落在下半行**行首**，后面还跟着原来那半句
    //    （如 `## 小标题类行内元素。…`）。
    //    那⛔ 不是产品的错——产品在这条路径上做的正是"在一行开头插入"。
    //    样式那半边才是承重的：`## x` 起头 ⇒ 整行（含被并进来的旧文字）都该是 h2。
    //    ⭐ 2026-11-05（`bugs/0084` 第三面）起 `snapClickX` 会把落点扳到离点**最近的边界**，
    //    所以这段折行块上量到的常常是"正好只剩 `##`"那一档（空 ATX 标题）——两种都合法，
    //    判据只认"以 `## ` 开头 + 样式 ≡ 品种"，⛔ 别按某一种写死。
    打字(ta, '#');
    打字(ta, '#');
    打字(ta, ' ');
    打字(ta, '小标题');
    await frames(2);
    r.敲标题后 = 逐行对照(host, 基键, 引文段距, 引用缩进);
    const 敲入行 = 光标行(host);
    const 敲入文 = 敲入行 >= 0 ? String(块全文(host).split('\n')[敲入行] || '') : '';
    const 敲入节点 = 行节点(host, 敲入行);
    const 敲入号 = 敲入节点 ? parseFloat(getComputedStyle(敲入节点).fontSize) || 0 : 0;
    // ⚠️ **2026-11-12 窄视口（760）实测**：折行块上的落点由 `posAtCoords` 估，回车可能把
    //    **有序列表项**从中间劈开、新行照产品语义续出 `2. ` ⇒ 敲进去的 `## 小标题` 落在
    //    **正文起点**而不是行首（源码「1. …会物化 2. ## 小标题`TaskItem`…」）。那同样满足
    //    "文字落进那一行"，标记本身由 W 段承重，⛔ 不该按"行首"判红。
    //    ⇒ 只把**行首已有的块前缀链**剥掉再比：正文必须从 `## 小标题` 起。
    // ⚠️ **2026-11-12 第二次修正**：前缀链不止"一个列表标记"。760 宽实测还有
    //    `> - [ ] ## 小标题`（引用＋列表＋任务框）与 `- [ ] ## 小标题` 两种形态，
    //    只剥一层 `- ` 会把 `[ ] ` 留在前面 ⇒ 假红（`tasks/O-blockquote-4`、`O-ul-4`）。
    //    ⇒ 判据改成「`## 小标题` 之前那一段**只由块前缀构成**」，比逐种形态穷举稳。
    // ⚠️ 2026-11-12：`##` 后面的空白**不止一个**也合法（`edges.md` 的 `##  小标题空格…`
    //    就是两个空格；ATX 开标记吸收其后全部空白，`O-p-4` 实测）⇒ 用正则找，⛔ 别用
    //    `indexOf('## 小标题')`（只有一个空格时匹配不上，产品正确也判红）。
    const 井 = /##[ \t]+小标题/.exec(敲入文);
    const 前 = 井 ? 井.index : -1;
    const 前缀段 = 前 >= 0 ? 敲入文.slice(0, 前) : '';
    const 前缀合法 = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])?[ \t]*(?:\[[ xX]\][ \t]*)?$/.test(前缀段);
    记('O-' + 标签 + '-4 敲出 `## 小标题` 后：文字落进那一行，样式仍 ≡ 渲染态',
      r.敲标题后.ok && 前 >= 0 && 前缀合法,
      '该行源码「' + 敲入文 + '」；字号 ' + 四舍(敲入号) + ' px；' + r.敲标题后.msg);

    // ④ 先删掉 3 个**可见**字（`小标题`）⇒ 这一行只剩空 ATX 标题的标记 `## `
    //    ⚠️ 它**不是**"半截标题"，CommonMark 里那是**空 ATX 标题**（comrak 实测 `h2 L1`）
    //    ⇒ 排版必须仍然跟着**它自己的品种**走（`bugs/0016` 就是这里少了 `|$`，
    //    编辑态显示 14px 正文、渲染态却是空 h2）。折行的块上这一行会是 `##类行内元素。…`，
    //    那反而不是标题（`#` 后面紧跟非空白）——两种都由 `行品种()` 独立判，⛔ 不写死。
    //    ⚠️⚠️ **为什么是 3 而不是 4**（2026-11-05，`design/0061` L3 实测）：标记从
    //    `design/0061` L1 起**恒定隐藏**，光标进不到 `##` 里面 ⇒ 删不动半个标记；
    //    可见字删完之后光标正好贴在隐藏区间**行首那一侧**，再按一次删的是**整个标记**
    //    （`selection.js::wholeLineMark`，`INV-LIVE-16` 只允许整体删）。旧口径的"第 4 个
    //    退格删掉那个空格"在这个形态下**不存在**——那一格在屏幕上本来就是空的。
    if (行中劈开) {
      // ⚠️ 行中劈开时那一行仍是**带内容的列表项** ⇒ ④⑤（"空 ATX 标题 / 删掉标记回基线"）
      //    的前提不成立，⛔ 不判（判了只会红在前提上）；`O-*-4` 已按其正文起点判过。
      跳过('O-' + 标签 + '-5 删到只剩空 ATX 标题的标记时仍按**它自己的品种**排版',
        '回车落在源码行中（折行块的落点由 `posAtCoords` 解），新行是带内容的列表项 ⇒ ④⑤ 前提不成立');
      跳过('O-' + 标签 + '-5b 标记整体删掉之后那一行回落到基线尺度（④ 的对称面）',
        '同上：新行不是空列表项');
    } else {
    const 删迹4 = [];
    for (let k = 0; k < 3; k++) {
      const 前4 = (function () {
        try {
          const V = 视图(host);
          if (!V || !V.state) return -1;
          const h = V.state.selection.main.head;
          return [V.state.doc.lineAt(h).number, h - V.state.doc.lineAt(h).from];
        } catch (e) { return -1; }
      })();
      键(ta, 'Backspace');
      await frames(2);
      const 后4 = (function () {
        try {
          const V = 视图(host);
          if (!V || !V.state) return -1;
          const h = V.state.selection.main.head;
          return [V.state.doc.lineAt(h).number, h - V.state.doc.lineAt(h).from];
        } catch (e) { return -1; }
      })();
      const 行4 = String(块全文(host).split('\n')[光标行(host)] || '');
      删迹4.push('#' + (k + 1) + ' ' + JSON.stringify(前4) + '→' + JSON.stringify(后4)
        + ' 「' + 行4.slice(0, 12) + '」');
    }
    await frames(2);
    r.删到井号 = 逐行对照(host, 基键, 引文段距, 引用缩进);
    const 井号行 = 光标行(host);
    const 井号文 = 井号行 >= 0 ? String(块全文(host).split('\n')[井号行] || '') : '';
    记('O-' + 标签 + '-5 删到只剩空 ATX 标题的标记时仍按**它自己的品种**排版',
      r.删到井号.ok && 井号文.indexOf('##') >= 0,
      '该行源码「' + 井号文 + '」；' + r.删到井号.msg + '｜④ 删迹 ' + 删迹4.join(' , '));

    // ⑤ 继续退格 ⇒ 那一行**必须**不再以 `#` 起头、且回落到基线尺度（④ 的对称面）
    //    ⚠️⚠️ **2026-11-12 实测（`blocks/O-pre-5b`）**：这一块是代码块，③ 的标题行是**在
    //    起始围栏行的上面**敲出来的 ⇒ 它的下一行就是围栏行。围栏行 / 塌行在
    //    `selection.js::legalHiddenOfPlan` 里被编成 `[行首−1, 行末+1]` 的伪区间，而空 ATX
    //    标题的标记区间 `[0,3)` 与它**相邻** ⇒ 合并成一段不可见跨度。删掉最后一个可见字之后
    //    光标落在 3，正处在这段跨度的**严格内部** ⇒ `legalNearest` 把它吸到**左端 0**（离
    //    左 3 px、离右 13 px）。那是 `design/0061` L2 的既定行为，⛔ 不是"退格没删对"。
    //    ⇒ 这种形状下 ⑤ 的前提（能继续退回标记）结构上不成立，如实记跳过并写明原因；
    //    ⛔ 别为了让它绿去放宽判据，也别把它记成产品通过。
    //    ⚠️⚠️ 步数是**自适应**的，⛔ 不能写死成 1（2026-11-05 实测）：
    //    · 标题块里 `## ` 是**标记**（`design/0061` L1 起恒定隐藏）⇒ 一次退格整体删掉，
    //      循环第一轮就退出；
    //    · 围栏块里同一串 `## ` 是**字面文本**（它是代码，不是标题标记）⇒ 要按 3 次
    //      （空格、`#`、`#`）才删干净。写死 1 次的话那一类块恒红，而源码是「##fn main() {」
    //      ——看起来像产品没删对，其实是我把两种语义当成了同一种。
    //    ⚠️ 上限 6：再多就不是"删掉刚敲的标记"了，宁可红着让人看源码。
    const 五源行们 = 块全文(host).split('\n');
    const 五塌 = 塌行表(块全文(host));
    const 五是围栏邻行 = 井号行 >= 0 && 井号行 + 1 < 五源行们.length
      && 五塌[井号行 + 1] === 'fence';
    let 删卫 = 0;
    let 删后文 = '';
    const 删迹 = [];
    while (!五是围栏邻行 && 删卫 < 6) {
      const 删前偏 = (function () {
        try {
          const V = 视图(host);
          if (!V || !V.state) return -1;
          const h = V.state.selection.main.head;
          return [V.state.doc.lineAt(h).number, h - V.state.doc.lineAt(h).from];
        } catch (e) { return -1; }
      })();
      键(ta, 'Backspace');
      删卫++;
      await frames(2);
      const 删后行 = 光标行(host);
      删后文 = 删后行 >= 0 ? String(块全文(host).split('\n')[删后行] || '') : '';
      const 删后偏 = (function () {
        try {
          const V = 视图(host);
          if (!V || !V.state) return -1;
          const h = V.state.selection.main.head;
          return [V.state.doc.lineAt(h).number, h - V.state.doc.lineAt(h).from];
        } catch (e) { return -1; }
      })();
      删迹.push('#' + 删卫 + ' ' + JSON.stringify(删前偏) + '→' + JSON.stringify(删后偏)
        + ' 「' + 删后文.slice(0, 12) + '」');
      if (删后文.charAt(0) !== '#') break;
    }
    r.删回后 = 逐行对照(host, 基键, 引文段距, 引用缩进);
    const 删偏 = (function () {
      try {
        const V = 视图(host);
        if (!V || !V.state) return -1;
        const h = V.state.selection.main.head;
        return h - V.state.doc.lineAt(h).from;
      } catch (e) { return -1; }
    })();
    if (五是围栏邻行) {
      跳过('O-' + 标签 + '-5b 标记整体删掉之后那一行回落到基线尺度（④ 的对称面）',
        '前提不成立：空 ATX 标题行的下一行是围栏行（0 高）⇒ `selection.js::legalHiddenOfPlan` '
        + '把它编成跨行伪区间、与标题标记区间合并；光标删到 3 时就在合并后的跨度内部，'
        + '被 `legalNearest` 吸到左端（`design/0061` L2）。⛔ 不是产品没删对');
    } else
    记('O-' + 标签 + '-5b 标记整体删掉之后那一行回落到基线尺度（④ 的对称面）',
      r.删回后.ok && 删后文.charAt(0) !== '#',
      '退格 ' + 删卫 + ' 次；该行源码「' + 删后文 + '」；光标行 ' + 光标行(host)
        + ' 偏移 ' + 删偏 + '；' + r.删回后.msg + '｜删迹 ' + 删迹.join(' , '));
    }

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
    r.粘贴后 = 逐行对照(host, 基键, 引文段距, 引用缩进);
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

    // ⑥′ C2（`design/0085` §2.2）：改根字号后，**已挂载**的块必须跟着重解析。
    //    ⚠️ 只改根变量，⛔ 不调 `theme.setFontSize`（那会把偏好写进用户 config）。
    //    判据两条：① 逐行字号/行高 ≡ **新**根字号下的 oracle（oracle 必须先刷新，
    //    否则它拿旧值当期望 ⇒ 恒绿）；② 宿主的下外边距 == oracle 的 `p` 外边距
    //    （`box.js` 写的是 `calc(var(--reader-font-size) * k ± b)`，不是 swap 时的 px 快照）。
    //    ⚠️ 只在**段落块、≤20 行**上做：字号放大 25% 后长块会超出视口，
    //    `逐行对照` 会把"没渲染出来"记成红——那不是 C2 的症状。
    if (标签 === 'p' && 行0 <= 20) {
      const 根 = document.documentElement;
      const 旧字串 = (根.style.getPropertyValue('--reader-font-size')
        || getComputedStyle(根).getPropertyValue('--reader-font-size')).trim();
      const 旧号 = parseFloat(旧字串) || 14;
      const 新号 = Math.round(旧号 * 1.25 * 100) / 100;
      let c2 = null;
      let 宿主边距 = null;
      let 期边距 = 0;
      try {
        根.style.setProperty('--reader-font-size', 新号 + 'px');
        await frames(2);
        const O2 = 刷新oracle();
        c2 = 逐行对照(host, 基键, 引文段距, 引用缩进);
        宿主边距 = parseFloat(getComputedStyle(host).marginBottom) || 0;
        期边距 = (O2[基键] && O2[基键].外边距) || 0;
      } finally {
        if (旧字串) 根.style.setProperty('--reader-font-size', 旧字串);
        else 根.style.removeProperty('--reader-font-size');
        await frames(2);
        刷新oracle();
      }
      const 边距ok = 期边距 > 0 && 宿主边距 !== null && Math.abs(宿主边距 - 期边距) <= 0.5;
      记('O-' + 标签 + '-6b 改根字号后已挂载的块跟着重解析（C2）',
        !!(c2 && c2.ok && 边距ok),
        '字号 ' + 四舍(旧号) + ' → ' + 四舍(新号)
          + '；' + (c2 ? c2.msg || '逐行全对' : '逐行对照没跑起来')
          + '；宿主下边距 ' + (宿主边距 === null ? '?' : 四舍(宿主边距))
          + ' / oracle ' + 四舍(期边距));
    }

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
    const 节点表 = 块节点();
    for (let i = 0; i < 节点表.length && i < p.blocks.length; i++) {
      const wire = p.blocks[i];
      if (!wire || wire[3] !== 1) continue;
      const tag = String(节点表[i].tagName || '');
      const 键 = 基线键(tag);
      if (!键 || seen[键 + tag]) continue;
      const 源 = 块源(i);
      if (源.split('\n').length > 60) continue; // ⚠️ 视口裁剪 ⇒ 逐行对照不承重
      seen[键 + tag] = true;
      挑.push({ i: i, 键: 键, 标签: tag.toLowerCase() });
    }
    // ⭐ `design/0085` C4：第一类引用块往往**没有嵌套**（`data-rmd-qdepth` 无人命中
    //    ⇒ 横向判据"量了个没有"且不会自己报缺覆盖）。⇒ 再点一个**含嵌套引用**的引用块，
    //    单独跑一套（`O-blockquote2-*`），⛔ 不改上面那条"每类第一个"的挑选口径。
    for (let i = 0; i < 节点表.length && i < p.blocks.length; i++) {
      const wire = p.blocks[i];
      if (!wire || wire[3] !== 1) continue;
      const el = 节点表[i];
      if (String(el.tagName || '').toLowerCase() !== 'blockquote') continue;
      if (!el.querySelector || !el.querySelector('blockquote')) continue;
      if (挑.some(function (c) { return c.i === i; })) continue;
      if (块源(i).split('\n').length > 60) continue;
      挑.push({ i: i, 键: 'quote', 标签: 'blockquote2' });
      break;
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
    点(块节点()[段落]);
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
    点(块节点()[段落]);
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
    const 节点表 = 块节点();
    for (let i = 0; i < 节点表.length && i < p.blocks.length; i++) {
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
      const node = 块节点()[c.i];
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
        // ⚠️ `design/0061` L1 起 `activeLines` 已不存在（隐藏集合是源码的纯函数）。
        const a0 = performance.now();
        const tree = 造树(文);
        const a1 = performance.now();
        const r = LM.markers(文, { tree: tree });
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
    const 节点表 = 块节点();
    for (let i = 0; i < p.blocks.length && i < 节点表.length; i++) {
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

    /**
     * 期望正文：在 `insertAt` 处插空行，再把**新段落那一行**换成 `中行`（不给就留空）。
     *
     * ⭐ 插几行看**块后有没有现成的块间空行**（`bugs/0079`；与 `live/index.js::newParagraph`
     * 同一条判据）：有（常态）⇒ 只插 **2** 行（上分隔 ＋ 新段落），原来那行当新段落的下分隔；
     * 没有（文档末尾 / 块后紧贴下一块）⇒ 插 **3** 行。
     * ⚠️ 2026-11-04 之前这里硬编码 3 行，于是修完产品之后 W1b / W3 在**六份夹具上全红**——
     * 那正是这条判据承重的证据，⛔ 别把它改回字面量。
     */
    function 期望(中行) {
      const 后面已有分隔行 = insertAt < 行.length && String(行[insertAt]).trim() === '';
      const 空行数 = 后面已有分隔行 ? 2 : 3;
      const 插入 = [];
      for (let i = 0; i < 空行数; i++) 插入.push('');
      const a = 行.slice(0, insertAt).concat(插入, 行.slice(insertAt));
      if (typeof 中行 === 'string') a[insertAt + 1] = 中行;
      return a.join('\n');
    }
    const 期望插入后 = 期望();

    /** 点这一块**第一行的行尾**并等**新的**宿主（`leave()` 是异步的，旧宿主还挂在树上）。 */
    async function 进入(哪块) {
      const 旧 = 主机();
      // ⚠️ 点**行尾**而不是左上角：光标要落在一个**非 0** 的偏移上，否则
      //    W2b（撤销恢复光标）就退化成"恢复成 0 也对"，判不出东西。
      点末(块节点()[哪块 === undefined ? 块 : 哪块]);
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
      const 表 = 块节点();
      for (let i = 0; i < 表.length; i++) if (表[i] === el) return i;
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
    记('W1b 空行插在**这一块之后**（块后已有分隔行 ⇒ 只插 2 行；后面原有正文逐字不变）',
      计数('render_preview') === 提交0 + 1 && 提交1 === 期望插入后,
      计数('render_preview') !== 提交0 + 1
        ? ('没有恰好多一次 render_preview（+' + (计数('render_preview') - 提交0) + '）')
        : ('提交的正文与期望不符：' + 差在哪(提交1, 期望插入后)
          + '；插入点 = 第 ' + (insertAt + 1) + ' 行之前（1-based，＝这一块的末行号）'));

    记('W1c 新段落宿主在 DOM 里紧跟刚离开那一块', !!段1 && 块节点()[块 + 1] === 段1,
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
    记('W2c 撤销之后宿主回到原来那一块（临时 <p> 已不在）', !!回块 && 块节点()[块] === 回块,
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
    let 光标5 = 回块5 ? 选区头(回块5) : -1;
    // ⭐ `bugs/0108`（2026-11-07 用户报告）：行尾回车在**列表项**上会续标记
    //    （`\n- ` / `\n> - ` / 编号 +1 …）——那是下面 W7 段的判据；W5 判的是
    //    "裸 Enter 只多一个换行"，前提必须是**正文行**。
    //    ⇒ 光标所在行是列表项时，移到这一块**第一个正文行**（点行尾 ＋ 真 `End`，
    //       ⛔ 不改视图选区）；整块没有正文行 ⇒ 跳过 W5（⛔ 不是通过）。
    // 只在**判红时**补充说明：把产品自己的 `markers()` 在这一行给出的 `quoteLines`
    // 记录打印出来（⛔ 它不参与期望值计算，只回答"编辑动作有没有拿到那条记录"）。
    const 诊断5 = function (文, 行首) {
      try {
        const M = window.rmd && window.rmd.liveMarks;
        if (!M || typeof M.markers !== 'function') return '；诊断：拿不到 `liveMarks.markers`';
        const plan = M.markers(文);
        const qs = (plan && plan.quoteLines) || [];
        const 命 = qs.filter(function (q) { return q.from === 行首; });
        return '；诊断 quoteLines 命中 ' + 命.length + ' 条：'
          + JSON.stringify(命.length ? 命[0] : qs.slice(0, 3));
      } catch (e) { return '；诊断：markers() 抛错 ' + String(e && e.message || e); }
    };
    let W5没做 = false;
    let W5挪迹 = '';
    if (回块5 && 光标5 >= 0 && 文5前 !== null) {
      const W5行号 = 文5前.slice(0, 光标5).split('\n').length - 1;
      // ⚠️ 2026-11-12（`bugs/0298`）：围栏行没有 `.cm-line` ⇒ 渲染序 ≠ 源码行号。
      //    ⛔ 别用 `.cm-line` 列表按下标取"光标那一行"，那会取到上面某一行。
      // ⭐ 2026-11-12：前提是**正文行**。⚠️ 除了列表项（W7 段的事），**空白行**同样不成立：
      //    光标落在 `> ` 这种只有前缀的行上时，`lineBreakAction` ⑤ 的"行首到正文起点切片"
      //    长度等于整行、产物不确定（实测是裸 `\n`），本判据拿它当"正文行"会误红。
      //    ⇒ 两种都先挪到这一块第一个**真有正文**的行（⛔ 不改视图选区，走点行尾 ＋ `End`）。
      const W5源行们 = 文5前.split('\n');
      const W5是正文行 = function (s) {
        const 余 = String(s == null ? '' : s).replace(/^(?:[ \t]*>[ \t]?)+/, '');
        if (!/\S/.test(余)) return false;                                        // 空白行
        if (/^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.test(余)) return false; // 列表项
        if (/^[ \t]*(?:`{3,}|~{3,})/.test(余)) return false;                    // 围栏行
        return true;
      };
      // ⚠️ 判据**只看源码**：空引用行会塌成 0 高、未必有 `.cm-line`（`行节点` 可能返回 null），
      //    所以⛔ 不能把它当"光标行是不是正文行"的前提。
      if (光标5 >= 0 && !W5是正文行(W5源行们[W5行号])) {
        let W5plain = null;
        for (let i = 0; i < W5源行们.length; i++) {
          if (i === W5行号 || !W5是正文行(W5源行们[i])) continue;
          // ⚠️ 围栏行/视口裁剪都可能没有 `.cm-line`：按**源码行号**取节点，取不到就换下一行。
          const el = 行节点(回块5, i);
          if (el) { W5plain = el; break; }
        }
        if (!W5plain) {
          记('W5 裸 Enter 继续留在这个块里（只多一个换行）', 'skip',
            '前提没建立：这一块没有正文行（整块都是列表项或空白行）；列表项行尾回车续标记是 W7 段的事');
          W5没做 = true;
        } else {
          // ⚠️ **2026-11-12 实测**：`点末()` 自己就把光标放在那一行的**行末**（37 → 点 35，
          //    正好是行 0 的末尾）；再按 `End` 反而把它带到**下一行**的行末（35 → 37，
          //    那一行是 0 高的空引用行）⇒ ⛔ 别再补 `End`，只信点击落点。
          const 挪前 = 光标5;
          点末(W5plain);
          await frames(1);
          光标5 = 选区头(回块5);
          if (光标5 < 0) W5挪迹 = '；挪位 ' + 挪前 + ' →点 ' + 光标5;
        }
      }
    }
    if (!W5没做) {
      键(输入框() || document.body, 'Enter');
      await frames(2);
      const 文5后 = 主机() ? 块全文(主机()) : null;
      // ⭐ `bugs/0111` A1（2026-11-12）：引用段落里裸 `Enter` **续 `> `**（`input.js::lineBreakAction`
      //    ⑤：新行 = `\n` ＋ 行首到正文起点那段源码切片）。⇒ 期望值不再是"只多一个换行"，
      //    而是"多一个换行 ＋ **光标那一行自己的**引用前缀"。⛔ 不写死 `> `：多层的 `> > `、
      //    带缩进的 `  > ` 都由源码切片原样给出（`plan.quoteLines.contentFrom` 同一段）。
      //    ⚠️ 普通段落（无引用前缀）切片为空 ⇒ 仍等价于"只多一个换行"。
      const 行首5 = 文5前 === null || 光标5 < 0
        ? -1 : (文5前.lastIndexOf('\n', Math.max(0, 光标5 - 1)) + 1);
      // ⚠️ 2026-11-12（M20 负对照）：前缀取**整行行首**的引用前缀，⛔ 不取"行首→光标"那段——
      //    撤销不恢复光标时（M20 变异态 `caretPos: 0`）光标可能正好落在行首，那一段为空、
      //    期望会算成"只多一个换行"，而产品按 `lineBreakAction` ⑤ 仍会续 `> ` ⇒ 误红。
      //    产品 ⑤ 切的是**行首到正文起点**，与光标在行内哪个位置无关。
      const 引用5 = 行首5 < 0 ? ''
        : (/^(?:[ \t]*>[ \t]?)+/.exec(文5前.slice(行首5)) || [''])[0];
      const 期望5 = 文5前 === null || 光标5 < 0
        ? null
        : (文5前.slice(0, 光标5) + '\n' + 引用5 + 文5前.slice(光标5));
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
                  + String(期望5).slice(0, 40) + '」（光标 ' + 光标5 + '，行首 '
                  + 行首5 + '，引用前缀「' + 引用5 + '」，该行源码「'
                  + String(文5前).slice(行首5, 光标5 + 1) + '」）'
                  + 诊断5(文5前, 行首5) + W5挪迹))))));
    }

    // ══ W7 ⭐ `bugs/0108`（2026-11-07 用户报告）：列表项行尾回车**续列表标记** ══
    //    用户原话：「item 项目，输入完一行之后，Enter 之后，应该还是 item」；Mardo §2.6 的
    //    `linePrefix`（`- ` / `> ` / 编号）是**特性声明的数据**，⛔ 不是撒在键盘处理里的 if。
    //    判据：续出同品种、圆点/编号绝对左缘对齐（≤ 0.5 px）、主机不变、
    //    字节恰好多「\n ＋ 前缀」、0 重渲。
    //    ⚠️ 前缀用**源行剥可见内容**算（克隆行、摘 preedit/taskbox 后取 textContent）——
    //       ⛔ 不重新实现装饰层的标记规则（判据⛔ 复制产品算法）。
    摘要.W.列表项 = 回块5 ? !!回块5.querySelector('.cm-line[data-rmd-li]') : false;
    /** 一行的**可见文本**：摘掉组合串与任务框 widget（两者都不在文档里，见 `块内文本`）。 */
    function 可见文本(el) {
      let e = el;
      if (el.querySelector('.cm-rmd-preedit, .cm-rmd-taskbox-wrap')) {
        e = el.cloneNode(true);
        const ps = e.querySelectorAll('.cm-rmd-preedit, .cm-rmd-taskbox-wrap');
        for (let k = 0; k < ps.length; k++) ps[k].parentNode.removeChild(ps[k]);
      }
      return String(e.textContent || '');
    }
    /**
     * 挑一条**可见内容能当作源行后缀**的列表行 —— W7 判据的前提（`bugs/0108` §6）。
     *
     * ⚠️ 为什么⛔ 直接拿第一条（2026-11-07 实测）：带链接/强调的行里隐藏区间在**行中间**
     *    （`[文字](url)` 藏掉 `](url)`），可见文本不是源行后缀 ⇒ 前缀剥不出来。
     *    ARCHITECTURE 夹具的列表项就是这样全部 skip 的（用户测试用的正是这份文件）。
     *    ⇒ 逐行试，挑**第一条**能剥的；⛔ 不为它放宽"后缀"这个独立 oracle
     *    （放宽就等于把产品算法抄进判据）。
     */
    function 挑列表行(host, 全文) {
      if (!host) return null;
      const 源行 = String(全文 === undefined || 全文 === null ? '' : 全文).split('\n');
      // ⚠️ 2026-11-12（`bugs/0298`）：围栏行没有 `.cm-line` ⇒ 先按"有行元素的源码行"建映射，
      //    再拿渲染序 i 去查源码行。⛔ 别把 i 当源码行号（围栏一多就整段错位）。
      const 塌7 = 塌行表(源行.join('\n'));
      const 源序7 = [];
      for (let k = 0; k < 源行.length; k++) if (塌7[k] !== 'fence') 源序7.push(k);
      const 行表 = host.querySelectorAll('.cm-line');
      for (let i = 0; i < 行表.length; i++) {
        const el = 行表[i];
        if (!el.hasAttribute('data-rmd-li')) continue;
        const 见 = 可见文本(el);
        const si = 源序7[i];
        if (见.length > 0 && si !== undefined && 源行[si] !== undefined
            && 源行[si].slice(-见.length) === 见) return el;
      }
      return null;
    }
    const 项5 = 回块5 ? 挑列表行(回块5, 块全文(回块5)) : null;
    if (回块5 && 摘要.W.列表项 === true && !项5) {
      // ⚠️ 必须**逐条产出**（缺了会被 `W7-覆盖` 读成"没跑"）：这一块的列表项全是带
      //    行内隐藏标记的（链接/强调在行中间），没有一条能独立剥出前缀。
      跳过('W7 列表项行尾回车续出同品种标记（主机不变）',
        '前提没建立：没有一条列表行的可见内容能当作源行后缀（全是行内置标记的项）');
      跳过('W7b 续出的前缀与字节恰如期望（只多 `\\n ＋ 前缀`，0 重渲）', '前提没建立：同上');
      if (回块5.querySelector('.cm-line[data-rmd-li="ordered"]')) {
        跳过('W7c 有序项续出「下一编号」', '前提没建立：同上');
      }
      if (回块5.querySelector('.cm-line[data-rmd-li="task"]')) {
        跳过('W7d 任务项续出空框（⛔ 已勾选的跟着续下去）', '前提没建立：同上');
      }
    }
    if (项5 && 回块5) {
      const 提交7 = 计数('render_preview');
      const 文7前 = 块全文(回块5);
      const 种7 = 项5.getAttribute('data-rmd-li');
      let 项行号7 = -1;
      const 行表7前 = 回块5.querySelectorAll('.cm-line');
      for (let i = 0; i < 行表7前.length; i++) {
        if (行表7前[i] === 项5) { 项行号7 = i; break; }
      }
      点末(项5);
      await frames(1);
      键(输入框() || document.body, 'End');
      await frames(1);
      const 光标7 = 选区头(回块5);
      const 源行7 = 文7前 === null || 光标7 < 0
        ? ''
        : 文7前.slice(0, 光标7).split('\n').pop();
      // 前缀 = 源行剥掉**可见内容**：可见内容必须是源行的**后缀**，剥不出 ⇒ 前提没建立。
      const 克隆7 = 项5.cloneNode(true);
      const 摘7 = 克隆7.querySelectorAll('.cm-rmd-preedit, .cm-rmd-taskbox-wrap');
      for (let i = 0; i < 摘7.length; i++) {
        const w = 摘7[i];
        if (w.parentNode) w.parentNode.removeChild(w);
      }
      const 可见7 = String(克隆7.textContent || '');
      const 前缀7 = 可见7.length > 0 && 源行7.slice(-可见7.length) === 可见7
        ? 源行7.slice(0, 源行7.length - 可见7.length)
        : null;
      if (光标7 < 0 || 前缀7 === null || 种7 === null) {
        const why7 = 光标7 < 0 ? '读不到光标'
          : (前缀7 === null ? '从源行剥不出前缀（可见内容不是源行后缀）' : '读不到行品种');
        跳过('W7 列表项行尾回车续出同品种标记（主机不变）', '前提没建立：' + why7);
        跳过('W7b 续出的前缀与字节恰如期望（只多 `\\n ＋ 前缀`，0 重渲）', '前提没建立：' + why7);
        if (种7 === 'ordered') 跳过('W7c 有序项续出「下一编号」', '前提没建立：' + why7);
        if (种7 === 'task') 跳过('W7d 任务项续出空框（⛔ 已勾选的跟着续下去）', '前提没建立：' + why7);
      } else {
        let 期望前缀 = 前缀7;
        if (种7 === 'ordered') {
          期望前缀 = 前缀7.replace(/\d{1,9}(?=[.)][ \t]*$)/, function (m) {
            return String(parseInt(m, 10) + 1);
          });
        } else if (种7 === 'task') {
          期望前缀 = 前缀7.replace(/\[[xX ]\]/, '[ ]');
        }
        键(输入框() || document.body, 'Enter');
        await frames(2);
        const 后7 = 主机();
        const 文7后 = 后7 ? 块全文(后7) : null;
        const 期望7 = 文7前 === null
          ? null
          : (文7前.slice(0, 光标7) + '\n' + 期望前缀 + 文7前.slice(光标7));
        // ⚠️ 新行在文本里紧跟光标那一行，DOM 里紧跟 项5 之后（下标 项行号7 + 1）。
        const 行表7 = 后7 ? 后7.querySelectorAll('.cm-line') : null;
        const 新行7 = 行表7 && 项行号7 >= 0 ? (行表7[项行号7 + 1] || null) : null;
      // 左缘对齐（`design/0084` 起标记由 UA 的 `::marker` 画，⛔ 没有 `::before` 可量）：
      // 两行必须同一个 `display: list-item` ＋ 同一个 `list-style-type` ＋ 同一个
      // `margin-left` —— 剩下的由 UA 用**同一段代码**从同一个盒子摆出来。
      let 对齐7 = null;
      if (新行7 && 项5) {
        const csA = getComputedStyle(项5);
        const csB = getComputedStyle(新行7);
        const 同形 = csA.display === 'list-item' && csB.display === 'list-item'
          && csA.listStyleType === csB.listStyleType;
        // ⚠️ 不同形记 `NaN`（下面的 `<= TOL` 必假 ⇒ 红），⛔ 不记 null（那是"量不到"）。
        对齐7 = 同形
          ? Math.abs(parseFloat(csA.marginLeft) - parseFloat(csB.marginLeft))
          : NaN;
      }
        记('W7 列表项行尾回车续出同品种标记（主机不变）',
          !!后7 && 后7 === 回块5 && !!新行7
            && String(新行7.getAttribute('data-rmd-li') || '') === 种7
            && 对齐7 !== null && 对齐7 <= TOL,
          !后7 || 后7 !== 回块5
            ? '按了 Enter 之后宿主换了（＝退出又重进了）'
            : (!新行7
              ? '没有续出新行'
              : (String(新行7.getAttribute('data-rmd-li') || '') !== 种7
                ? ('续行品种「' + 新行7.getAttribute('data-rmd-li') + '」≠ 原「' + 种7 + '」')
                : (对齐7 === null ? '量不到左缘对齐'
                  : ('左缘差 ' + 对齐7.toFixed(2) + ' px（容差 ' + TOL + '）')))));
        记('W7b 续出的前缀与字节恰如期望（只多 `\\n ＋ 前缀`，0 重渲）',
          !!后7 && 后7 === 回块5 && 计数('render_preview') === 提交7 && 文7后 === 期望7,
          !后7 || 后7 !== 回块5 ? '按了 Enter 之后宿主换了'
            : (计数('render_preview') !== 提交7 ? '按了 Enter 就触发了一次重渲'
              : ('内容「' + String(文7后).slice(0, 40) + '」／期望「'
                + String(期望7).slice(0, 40) + '」')));
        if (种7 === 'ordered') {
          // `design/0084`：编号不再写成 `data-rmd-marker`，而是行内 `counter-reset: list-item (N-1)`
          // ⇒ 续出的下一项必须是 `N`（＝旧值 + 1）。
          const 记数 = function (el) {
            const m = el ? /counter-reset:\s*list-item\s+(\d+)/.exec(el.getAttribute('style') || '') : null;
            return m ? parseInt(m[1], 10) : NaN;
          };
          const 旧7 = 记数(项5);
          const 新7 = 记数(新行7);
          记('W7c 有序项续出「下一编号」',
            !!新行7 && isFinite(旧7) && 新7 === 旧7 + 1,
            !新行7 ? '没有续出新行' : ('旧 `counter-reset: ' + 旧7 + '` → 新 `' + 新7 + '`'));
        }
        if (种7 === 'task') {
          const 框7 = 新行7 ? 新行7.querySelector('.cm-rmd-taskbox') : null;
          记('W7d 任务项续出空框（⛔ 已勾选的跟着续下去）',
            !!框7 && 框7.checked === false,
            !新行7 ? '没有续出新行'
              : (框7 ? ('新行任务框 checked = ' + 框7.checked) : '新行里没有任务框'));
        }
        // 撤掉 W7 这一个换行（W5 的换行归收尾那一下 ⌘Z）
        键(输入框() || document.body, 'z', { meta: true });
        await frames(1);
      }
    }

    // ══ W7e/W7f/W7h ⭐ `bugs/0300`（2026-11-09 用户报告）════════════════════════
    //    用户原话：「Enter 之后，光标处于 todo 框的前面，而且无法往后移动。」
    //
    //    ⚠️⚠️ **为什么只判"光标偏移 / 字节"不够**（2026-11-09 离屏实测）：回车之后文档偏移
    //    **本来就是对的**（`光标后 === 新行起 + 新行正文起点`：顶层 62/62、嵌套 166/166），
    //    错的是**光标被画在方框左缘**——任务框是 `t.pos === contentFrom` 上的 widget，
    //    `side` 决定同一点上光标落在它**左边还是右边**：
    //      `side: 1`（缺陷值）⇒ `.cm-rmd-caret` 的 left == `.cm-rmd-taskbox-wrap` 的 left
    //        （离屏：309/309、337/337），方框在光标右边 22 px ⇒ 看起来"光标在框前"；
    //      `side: -1`（修后）⇒ caret.left == wrap.right - 0.18；
    //    两者**文档字节与光标偏移逐字相同** ⇒ 只判偏移/字节的判据在缺陷上恒绿
    //    （这正是它从 W7 里漏过去的原因）。⇒ W7e/W7f 必须**同时**判"画出来的插入符在方框之后"。
    //
    //    ⚠️ 嵌套项和顶层项**一样**（C 假设不成立）；新行前缀的尾随空格**没被吃掉**
    //    （B 假设不成立）——这两条由下面的字节断言与 `W7b` 一起钉住。
    //
    //    ⚠️ 用户还报了"字符被打在方框左边"：离屏**没有复现**（两种 side 下键入的字都渲染在
    //    方框右缘之后，源码都是 `- [ ] x`）⇒ 这里只钉"字落进新行正文"这一半；真实 IME /
    //    可见窗口下的呈现如实留人工验收（`.claude/rules/tests.md` 的「不干扰用户」）。

    /** 任务行正文起点（相对行首的 UTF-16 偏移）。独立正则 oracle，⛔ 不读 `markers()`。 */
    function 任务正文起点30(行) {
      const m = /^(\s*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]*)/.exec(String(行));
      return m ? m[1].length : -1;
    }
    /** 源码行的行首缩进长度——判"嵌套"的独立 oracle（⛔ 不读产品 `depth`）。 */
    function 行首缩进30(行) {
      const m = /^[ \t]*/.exec(String(行));
      return m ? m[0].length : 0;
    }
    /**
     * 挑一条可用的**任务行**：产品标了 `task`、可见文本是源行后缀、且源行能被
     * `任务正文起点30` 独立解析（排除引用块里的 `> - [ ]` 这类本段不判的形状）。
     * 取**最后一条**（用户报的是"最后一条正常任务项"下面新起的那一行）。
     * @param {boolean} 要嵌套 true = 只取嵌套项（行首有缩进），false = 只取顶层项
     * @returns {object|null}
     */
    function 挑任务行30(host, 全文, 要嵌套) {
      if (!host) return null;
      const 源行 = String(全文 === undefined || 全文 === null ? '' : 全文).split('\n');
      const 行表 = host.querySelectorAll('.cm-line');
      let 选中 = null;
      for (let i = 0; i < 行表.length; i++) {
        const el = 行表[i];
        if (String(el.getAttribute('data-rmd-li') || '') !== 'task') continue;
        if (i >= 源行.length) continue;
        if (任务正文起点30(源行[i]) < 0) continue;
        const 见 = 可见文本(el);
        if (!见.length || 源行[i].slice(-见.length) !== 见) continue;
        const 嵌套 = 行首缩进30(源行[i]) > 0;
        if (嵌套 !== 要嵌套) continue;
        选中 = { el: el, 行号: i, 源行: 源行[i], 可见: 见 };
      }
      return 选中;
    }
    /**
     * 在一条任务行上：点行尾 → 真 `End` → 真 `Enter` →（量）→ **立刻**敲 `x` →（量）→ `⌘Z` ×2。
     * ⚠️ 敲字前⛔ 不按 `→`：顶层项后面还有行，`→` 会跨过下一行的隐藏标记链、把字插到下一行去
     *    （2026-11-09 实测：顶层 `→` 走了 62→69）——那测的就不是"回车后立刻打字"了。
     * @returns {object} 原始事实；带 `致命` ⇒ 前提没建立。
     */
    async function 任务回车敲字30(host, 任) {
      const ta = 输入框() || document.body;
      const 文30前 = 块全文(host);
      // 这一行在块内的起止（0-based 偏移，行末不含 `\n`）。
      const 行起30 = 任.行号 === 0
        ? 0
        : String(文30前).split('\n').slice(0, 任.行号).join('\n').length + 1;
      const 行末30 = 行起30 + 任.源行.length;
      点末(任.el);
      await frames(1);
      let 光标30前 = 选区头(host);
      // ⚠️⚠️ `End` **只在光标还没停在这一行行尾时才按**（2026-11-09 实测）：`点末` 本身
      //    就落在行尾（`posAtCoords` 把点夹到该行末），此时再按 End，CM6 的
      //    `cursorLineBoundaryForward` 会前进到**下一行**行尾（任务夹具实测 69→86）⇒
      //    回车续出的品种变成下一行那条（`- [X] …` 下面那行是 `- 普通列表项`，新行只有
      //    `- `），W7e/W7f 假红。⛔ 别改回无条件 `End`。
      if (光标30前 !== 行末30) {
        键(ta, 'End');
        await frames(1);
        光标30前 = 选区头(host);
      }
      if (光标30前 < 0 || 文30前 === null) return { 致命: '读不到光标/正文' };
      if (光标30前 !== 行末30) {
        return { 致命: '光标没落到任务行行尾（光标 ' + 光标30前 + ' / 行尾 ' + 行末30 + '）' };
      }
      // 前缀 = 源行剥掉可见内容（与 W7b 同一把独立 oracle：有序 +1、任务换空框）
      const 前缀30 = 任.源行.slice(0, 任.源行.length - 任.可见.length);
      let 期前缀30 = 前缀30;
      if (任.el.getAttribute('data-rmd-li') === 'ordered') {
        期前缀30 = 前缀30.replace(/\d{1,9}(?=[.)][ \t]*$)/, function (m) {
          return String(parseInt(m, 10) + 1);
        });
      } else {
        期前缀30 = 前缀30.replace(/\[[xX ]\]/, '[ ]');
      }
      const 行号30 = 文30前.slice(0, 光标30前).split('\n').length - 1;
      // ── 回车 ──
      键(ta, 'Enter');
      await frames(3);
      const 后30 = 主机();
      if (!后30 || 后30 !== host) return { 致命: '回车之后宿主换了（＝退出又重进了）' };
      const 光标30后 = 选区头(后30);
      const 文30后 = 块全文(后30);
      const 行后表30 = String(文30后).split('\n');
      const 新行30 = 行后表30[行号30 + 1];
      const 新行起30 = 行后表30.slice(0, 行号30 + 1).join('\n').length + 1;
      const 正文起30 = 新行30 === undefined ? -1 : 任务正文起点30(新行30);
      const 行表30后 = 后30.querySelectorAll('.cm-line');
      const 新行El30 = 行表30后[行号30 + 1] || null;
      const 框W30 = 新行El30 ? 新行El30.querySelector('.cm-rmd-taskbox-wrap') : null;
      const 框30 = 新行El30 ? 新行El30.querySelector('.cm-rmd-taskbox') : null;
      const caret30 = 后30.querySelector('.cm-rmd-selectionLayer .cm-rmd-caret');
      const wrapR30 = 框W30 ? 框W30.getBoundingClientRect() : null;
      const caretR30 = caret30 ? caret30.getBoundingClientRect() : null;
      const 实30 = {
        文前: 文30前, 光标前: 光标30前, 行号: 行号30, 源行: 任.源行, 期望前缀: 期前缀30,
        光标后: 光标30后, 文后: 文30后,
        新行: 新行30, 新行起: 新行起30, 正文起点: 正文起30,
        新行品种: 新行El30 ? String(新行El30.getAttribute('data-rmd-li') || '') : '',
        有框: !!框30, 框宽: 框30 ? 框30.getBoundingClientRect().width : -1,
        wrap左: wrapR30 ? wrapR30.left : null,
        wrap右: wrapR30 ? wrapR30.right : null,
        caret左: caretR30 ? caretR30.left : null,
      };
      // ── 立刻敲一个字符（⛔ 不先按 →）──
      打字(ta, 'x');
      await frames(6);
      const 文30打 = 块全文(后30);
      const 光标30打 = 选区头(后30);
      const 打行表30 = 后30.querySelectorAll('.cm-line');
      const 打行El30 = 打行表30[行号30 + 1] || null;
      const 打框W30 = 打行El30 ? 打行El30.querySelector('.cm-rmd-taskbox-wrap') : null;
      const 打框30 = 打行El30 ? 打行El30.querySelector('.cm-rmd-taskbox') : null;
      const 打caret30 = 后30.querySelector('.cm-rmd-selectionLayer .cm-rmd-caret');
      const 打wrapR30 = 打框W30 ? 打框W30.getBoundingClientRect() : null;
      const 打caretR30 = 打caret30 ? 打caret30.getBoundingClientRect() : null;
      // 键入字符的**真实 DOM 矩形**（⛔ 不用 coordsAtPos：同一点上有 widget，返回的是 widget 的几何）
      let 字左30 = null;
      let 字右30 = null;
      if (打行El30) {
        for (let i = 0; i < 打行El30.childNodes.length; i++) {
          const n = 打行El30.childNodes[i];
          if (n.nodeType !== 3 || String(n.textContent || '').indexOf('x') < 0) continue;
          try {
            const rg = 打行El30.ownerDocument.createRange();
            rg.selectNodeContents(n);
            const rs = rg.getClientRects();
            if (rs.length) { 字左30 = rs[0].left; 字右30 = rs[rs.length - 1].right; }
          } catch (e) { void e; }
        }
      }
      实30.敲字 = {
        文: 文30打, 光标: 光标30打,
        新行: 文30打 === null ? null : String(文30打).split('\n')[行号30 + 1],
        新行品种: 打行El30 ? String(打行El30.getAttribute('data-rmd-li') || '') : '',
        有框: !!打框30, 框宽: 打框30 ? 打框30.getBoundingClientRect().width : -1,
        wrap右: 打wrapR30 ? 打wrapR30.right : null,
        字左: 字左30, 字右: 字右30,
        caret左: 打caretR30 ? 打caretR30.left : null,
      };
      // 撤两次：先撤字、再撤回车（"⛔ 一次不跨层"的同一口径，见 W4）
      键(ta, 'z', { meta: true });
      await frames(1);
      键(ta, 'z', { meta: true });
      await frames(2);
      实30.撤回后 = 块全文(后30);
      return 实30;
    }
    /** 期望正文：回车只多 `\n ＋ 前缀`；再敲 `x` 落在**新行正文起点**。 */
    function 期望30(实, 加字) {
      if (实.文前 === null || 实.光标前 < 0) return null;
      return 实.文前.slice(0, 实.光标前) + '\n' + 实.期望前缀
        + (加字 ? 'x' : '') + 实.文前.slice(实.光标前);
    }
    /** W7e 本体（顶层 / 嵌套共用）：偏移 == 正文起点（≠ 行首）∧ **画出的插入符在方框之后**。 */
    function 判W7e30(实) {
      const 偏 = 实.光标后 === 实.新行起 + 实.正文起点 && 实.正文起点 > 0;
      const 方 = 实.wrap右 !== null && 实.caret左 !== null && 实.caret左 >= 实.wrap右 - TOL;
      let msg = '光标 ' + 实.光标后 + ' / 新行起 ' + 实.新行起 + ' + 正文起点 ' + 实.正文起点;
      if (!实.有框 || 实.框宽 <= 0) msg += '；新行里没有任务框（宽 ' + 实.框宽 + '）';
      else if (!偏) msg += '；偏移不等于正文起点（或正文起点 ≤ 0）';
      else if (!方) {
        msg += '；画出的插入符在方框**左/内**：caret.left ' + 实.caret左
          + ' / wrap.right ' + 实.wrap右 + '（差 ' + (实.caret左 - 实.wrap右).toFixed(2) + ' px）';
      } else msg += '；caret.left - wrap.right = ' + (实.caret左 - 实.wrap右).toFixed(2)
        + ' px（≤ ' + TOL + '）';
      return { ok: 实.有框 && 实.框宽 > 0 && 偏 && 方, msg: msg };
    }
    /** W7f 本体：敲的字落进**新行正文**（⛔ 不是标记前），渲染在方框右缘之后、光标在字后、可撤销。 */
    function 判W7f30(实) {
      const 期文 = 期望30(实, true);
      const 打 = 实.敲字 || {};
      const 落对 = 期文 !== null && 打.文 === 期文;
      const 行对 = typeof 打.新行 === 'string'
        && 打.新行.slice(0, 实.正文起点) === 实.期望前缀
        && 打.新行.slice(实.正文起点) === 'x';
      const 字在框后 = 打.字左 !== null && 打.wrap右 !== null && 打.字左 >= 打.wrap右 - TOL;
      const 光标在字后 = 打.光标 === 实.新行起 + 实.正文起点 + 1;
      const 还原 = 实.撤回后 === 实.文前;
      let msg = '新行「' + String(打.新行 === null || 打.新行 === undefined ? '?' : 打.新行) + '」';
      if (!落对) msg += '；正文不是"多 \\n ＋ 前缀 ＋ x"';
      else if (!行对) msg += '；x 不在新行正文起点（期望前缀「' + 实.期望前缀 + '」）';
      else if (!字在框后) {
        msg += '；键入的字没渲染在方框右缘之后（字左 ' + 打.字左 + ' / wrap.right ' + 打.wrap右 + '）';
      } else if (!光标在字后) {
        msg += '；光标 ' + 打.光标 + ' ≠ 正文起点 + 1（' + (实.新行起 + 实.正文起点 + 1) + '）';
      } else if (!还原) msg += '；⌘Z ×2 之后正文没回到回车前';
      else msg += ' x 落在正文起点 ' + 实.正文起点 + '，方框右缘 ' + 打.wrap右 + '，字左 ' + 打.字左;
      return { ok: 落对 && 行对 && 字在框后 && 光标在字后 && 还原, msg: msg };
    }
    // ⚠️ 只在**真有这种任务行**的夹具上产判据；没有就**既不记通过也不记跳过**
    //    （skip 会让整轮退出码恒为 2，见 `W-覆盖` 那条注释），由 `摘要.W` 的
    //    `任务项` / `嵌套任务项` 两个旗标交给 `block-probe.sh::W-覆盖` 把关。
    //    ⚠️⚠️ 执行段**不在这里**，在 W6 之后：W 段主流程优先挑**引用块**（见上面的
    //    `块` 选择），而 `tasks` 夹具里那一块只有 `> - [x] …`——行首是引用标记，
    //    `任务正文起点30` 咬不住，首版实测一条判据都没产出（`摘要.W.任务项 = false`）。
    //    用户报的是**普通列表里的任务项** ⇒ 执行段自己去 `p.blocks` 里找含"裸任务行"
    //    的可编辑块，进块、量完、撤销、退出（见 W6 之后的那一段）。
    摘要.W.任务项 = false;
    摘要.W.嵌套任务项 = false;
    // ⭐ `bugs/0300` 现象二 / `bugs/0302` 的两个旗标（执行段在 W6 之后，同 `量任务组30`）：
    //    `源码续行` = 真有"列表项下面那条缩进的普通行"；`长词任务` = 真有"首词比一行还长"
    //    的任务项。⚠️ 与 `任务项` 同一口径：没有就不记判据，由 `block-probe.sh::W7-覆盖` 把关。
    摘要.W.源码续行 = false;
    摘要.W.长词任务 = false;
    // ⚠️ `长词任务松散` 与 `长词任务` 同一口径（没有就不记判据），由 `W7-覆盖` 把关：
    //    紧凑项与松散项的首行是**两条规则**（`bugs/0302`），只覆盖一种等于漏一半。
    摘要.W.长词任务松散 = false;
    // ⚠️⚠️ **2026-11-12**：`长词任务` 是"**任一**项（紧凑或松散）首词超宽"，而 `W11r` 只对
    //    **紧凑**项产出 ⇒ 覆盖闸门拿 `长词任务` 去要求 `W11r`，在"只有松散项超宽"的夹具上
    //    必然报缺。窄视口实测：760 宽下 `loosetasks` 的松散项首词也超宽了 ⇒ `W7-覆盖` 报
    //    `缺 loosetasks/W11r`（假红，产品与判据都没问题）。⇒ 另记"有紧凑项超宽"这一条。
    摘要.W.长词任务紧凑 = false;

    // 收尾：撤掉 W5 那个换行（W7 的已在段内撤掉）再退出（撤销之后 == 源码 ⇒ 不提交、不重渲）
    键(输入框() || document.body, 'z', { meta: true });
    await frames(1);
    键(输入框() || document.body, 'Escape');
    await waitFor(function () { return !主机(); }, 4000);
    await frames(2);
    记('W6 整段跑完之后正文逐行回到操作前', 当前全文() === 全文前,
      (当前全文() === 全文前 ? '' : ('收尾没回到原样：' + 差在哪(当前全文(), 全文前))));

    // ══ W7e/W7f/W7h 的**执行段** ⭐ `bugs/0300`（函数体见 W7 段后面的声明）══════════
    //    ⚠️ 放在 W6 之后：此刻整篇已撤销回操作前、也没有宿主，这一段自己挑块、进块、
    //    量完撤销、退出；W8 紧接着会自己 `进入()`，不依赖这一步的宿主。

    /** 找一块含**裸任务行**的可编辑顶层块（`要嵌套` 定有无行首缩进）；没有 ⇒ -1。 */
    function 找任务块30(要嵌套) {
      const 行30 = String(当前全文()).split('\n');
      const 节点30 = 块节点();
      for (let bi = 0; bi < p.blocks.length && bi < 节点30.length; bi++) {
        const w = p.blocks[bi];
        if (w[3] !== 1) continue;
        const 源行们 = 行30.slice(w[1] - 1, w[2]);
        for (let i = 0; i < 源行们.length; i++) {
          // ⚠️ `任务正文起点30` 不认引用前缀（`> - [ ]`）——那正是主流程挑中引用块时
          //    一条判据都产不出的原因；这里只找**裸任务行**，与用户报的形状一致。
          if (任务正文起点30(源行们[i]) < 0) continue;
          if ((行首缩进30(源行们[i]) > 0) === 要嵌套) return bi;
        }
      }
      return -1;
    }
    /** 进第 `bi` 个块，返回**新的**宿主；先把当前宿主正常退出（真 `Escape` 走产品自己的路）。 */
    async function 进任务块30(bi) {
      const 旧 = 主机();
      if (旧) {
        键(输入框() || document.body, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
      }
      点末(块节点()[bi]);
      const h = await waitFor(function () {
        const n = 主机();
        return n && n !== 旧 ? n : null;
      }, 5000);
      await frames(2);
      return h;
    }
    /** 在一类任务行上跑「回车 → 立刻敲字 → 撤销」，产出 W7e/W7f（顶层）或 W7h（嵌套）。 */
    async function 量任务组30(要嵌套) {
      const bi = 找任务块30(要嵌套);
      if (bi < 0) return;
      const host = await 进任务块30(bi);
      const 任 = host ? 挑任务行30(host, 块全文(host), 要嵌套) : null;
      if (要嵌套) 摘要.W.嵌套任务项 = !!任;
      else 摘要.W.任务项 = !!任;
      if (!任) {
        // ⚠️ 找不到就**不记判据**（skip 会让整轮退出码恒为 2），由 `W-覆盖` 把关。
        if (host) {
          键(输入框() || document.body, 'Escape');
          await waitFor(function () { return !主机(); }, 4000);
        }
        return;
      }
      const 实 = await 任务回车敲字30(host, 任);
      if (实.致命) {
        const 说明 = '前提没建立：' + 实.致命;
        if (要嵌套) 记('W7h 嵌套任务项（depth ≥ 2）上重跑 W7e/W7f', false, 说明);
        else {
          记('W7e 回车后光标偏移 == 新行正文起点（≠ 行首），且**画出的插入符在方框之后**', false, 说明);
          记('W7f 回车后立刻敲一个字：落在 `前缀 ＋ x`（⛔ 不是 `x ＋ 前缀`），且渲染在方框之后', false, 说明);
        }
      } else if (要嵌套) {
        const 判he = 判W7e30(实);
        const 判hf = 判W7f30(实);
        记('W7h 嵌套任务项（depth ≥ 2）上重跑 W7e/W7f', 判he.ok && 判hf.ok,
          '嵌套行「' + 任.源行 + '」／W7e：' + 判he.msg + '／W7f：' + 判hf.msg);
      } else {
        const 判e = 判W7e30(实);
        const 判f = 判W7f30(实);
        记('W7e 回车后光标偏移 == 新行正文起点（≠ 行首），且**画出的插入符在方框之后**',
          判e.ok, '任务行「' + 任.源行 + '」／' + 判e.msg);
        记('W7f 回车后立刻敲一个字：落在 `前缀 ＋ x`（⛔ 不是 `x ＋ 前缀`），且渲染在方框之后',
          判f.ok, '任务行「' + 任.源行 + '」／' + 判f.msg);
      }
      await frames(2);
      if (主机()) {
        键(输入框() || document.body, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
      }
    }
    // ── W10/W11 的执行段 ⭐ `bugs/0300` 现象二 / `bugs/0302`（2026-11-09 用户报告）──────
    //    W10：「最后一行，输入 enter 之后，还是没有继承上一行的 todo Item」——源码**续行**
    //         （列表项下面那条缩进的普通行）回车必须续出**它所属项**的品种。
    //    W11：「如果输出超过一行，所有的内容都到第二行去了」——任务项的首个词比一行还长时，
    //         首行必须**从方框后面**开始排，⛔ 不是整段掉到第二行、首行只剩一个方框。
    //    两条都只在**真有那种行**的夹具上产出判据；没有就一条都不记，覆盖由 `W7-覆盖` 把关。
    /** 列表项前缀长度（独立正则 oracle：`- ` / `1. ` / `- [ ] ` 之后）；不是列表行 ⇒ -1。 */
    function 列表前缀长31(行) {
      const m = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)/.exec(String(行));
      return m ? m[1].length : -1;
    }
    /** 一行属于哪个品种（独立 oracle，⛔ 不读产品的 `data-rmd-li`）。 */
    function 品种31(行) {
      const s = String(行);
      if (任务正文起点30(s) >= 0) return 'task';
      if (/^[ \t]*\d{1,9}[.)][ \t]+/.test(s)) return 'ordered';
      if (/^[ \t]*[-*+][ \t]+/.test(s)) return 'bullet';
      return '';
    }
    /** 续出的前缀（与 W7 同一口径：有序 +1、任务换空框）。 */
    function 续前缀31(源行, 种) {
      let p = 种 === 'task'
        ? 源行.slice(0, 任务正文起点30(源行))
        : 源行.slice(0, 列表前缀长31(源行));
      if (种 === 'ordered') {
        p = p.replace(/\d{1,9}(?=[.)][ \t]*$)/, function (m) {
          return String(parseInt(m, 10) + 1);
        });
      } else if (种 === 'task') {
        p = p.replace(/\[[xX ]\]/, '[ ]');
      }
      return p;
    }
    /**
     * 找一条**源码续行**：第 i 行不是列表项、缩进比第 i-1 行（列表项）深、且不空。
     * ⚠️ 围栏代码块整段跳过——代码行回车必须是裸 `\n`（`input.js` 用 `code` 标记排除它）。
     */
    function 找续行31() {
      const 行 = String(当前全文()).split('\n');
      const 节点 = 块节点();
      for (let bi = 0; bi < p.blocks.length && bi < 节点.length; bi++) {
        if (p.blocks[bi][3] !== 1) continue;
        const 源 = 行.slice(p.blocks[bi][1] - 1, p.blocks[bi][2]);
        let 围栏 = false;
        for (let i = 1; i < 源.length; i++) {
          if (/^[ \t]*(```|~~~)/.test(源[i])) { 围栏 = !围栏; continue; }
          if (围栏) continue;
          if (!String(源[i]).trim()) continue;
          const 种 = 品种31(源[i - 1]);
          if (!种) continue;
          if (品种31(源[i])) continue;            // 自己也是列表项 ⇒ 不是续行
          if (行首缩进30(源[i]) <= 行首缩进30(源[i - 1])) continue;
          return { 块: bi, 行号: i, 上行: 源[i - 1], 种: 种, 续行: 源[i] };
        }
      }
      return null;
    }
    /** 一行的**第一个词**的 Range（第一个非空白字符 → 下一个空白）；没有 ⇒ null。 */
    function 首词范围31(根) {
      const 走 = document.createTreeWalker(根, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = 走.nextNode())) {
        const v = String(n.nodeValue || '');
        let i = 0;
        while (i < v.length && /\s/.test(v[i])) i++;
        if (i >= v.length) continue;
        let j = i;
        while (j < v.length && !/\s/.test(v[j])) j++;
        const rg = document.createRange();
        rg.setStart(n, i);
        rg.setEnd(n, j);
        return rg;
      }
      return null;
    }
    /**
     * 是**松散**任务项吗：`<li>` 的直接子元素里有 `<p>`（comrak 对松散列表的写法）。
     * ⚠️ 判据是**结构**（直接子元素），⛔ 不是 `querySelector('p')`——嵌套列表里的段落
     *    也会被后者选中，而它不属于这一项的首段。
     */
    function 有直接子段(li) {
      for (let i = 0; i < li.children.length; i++) {
        if (String(li.children[i].tagName || '').toUpperCase() === 'P') return true;
      }
      return false;
    }
    /**
     * 量「方框与正文首字在不在同一条视觉行上」。
     * ⭐ 判据不是"方框在那儿"：用户报的是**首行只剩方框** ⇒ 量方框与首字的**纵向关系**，
     *    并用首个词的 `getClientRects()` 段数 ≥ 2 认定"这个词真比一行还长"（⛔ 不按字数猜）。
     * @returns {{同线:boolean,超宽:boolean,框顶:number,字顶:number,行高:number,段:number}|null}
     */
    function 量首字31(根, 框选择器) {
      const 框 = 根.querySelector(框选择器);
      const rg = 首词范围31(根);
      if (!框 || !rg) return null;
      const b = 框.getBoundingClientRect();
      const 首 = document.createRange();
      首.setStart(rg.startContainer, rg.startOffset);
      首.setEnd(rg.startContainer, rg.startOffset + 1);
      const f = 首.getBoundingClientRect();
      if (!(f.width > 0 || f.height > 0)) return null;
      const cs = getComputedStyle(根);
      const 行高 = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
      const 重叠 = !(f.bottom <= b.top || f.top >= b.bottom);
      const 同线 = 重叠 || Math.abs(f.top - b.top) <= 行高 * 0.5;
      const 段 = Array.prototype.slice.call(rg.getClientRects())
        .filter(function (r) { return r.width > 0.5; }).length;
      return { 同线: 同线, 超宽: 段 >= 2, 框顶: b.top, 字顶: f.top, 行高: 行高, 段: 段 };
    }
    /** W11 阅读态 ＋ 编辑态。 */
    async function 量长词任务31() {
      const lis = document.querySelectorAll('#doc li.task-list-item');
      const 候选 = [];
      for (let i = 0; i < lis.length; i++) {
        const m = 量首字31(lis[i], 'input[type="checkbox"]');
        if (!m || !m.超宽) continue;
        // ⭐ 松散项的正文包在 `<p>` 里（comrak：`<li class="task-list-item"><p>…</p></li>`），
        //    紧凑项直接装在 `<li>` 里。两者走的是**两条不同**的首行规则
        //    （`li::first-line` / `li > p:first-of-type::first-line`，`bugs/0302`）⇒ 分开判。
        候选.push({ el: lis[i], 量: m, 松散: 有直接子段(lis[i]) });
      }
      摘要.W.长词任务 = 候选.length > 0;
      摘要.W.长词任务松散 = 候选.some(function (c) { return c.松散; });
      摘要.W.长词任务紧凑 = 候选.some(function (c) { return !c.松散; });
      if (!候选.length) return;
      const 说明 = function (m) {
        return '首词折成 ' + m.段 + ' 段／方框顶 ' + m.框顶.toFixed(2)
          + ' / 首字顶 ' + m.字顶.toFixed(2) + '（行高 ' + m.行高.toFixed(2) + '）';
      };
      /** 判一组候选，全同线才通过；说明里给出**最差**那一条的几何。 */
      const 判一组 = function (id, 组, 名) {
        if (!组.length) return;
        let 同线数 = 0;
        let 最差 = 组[0];
        for (let k = 0; k < 组.length; k++) {
          const m = 组[k].量;
          if (m.同线) 同线数++;
          if (Math.abs(m.字顶 - m.框顶) > Math.abs(最差.量.字顶 - 最差.量.框顶)) 最差 = 组[k];
        }
        记(id, 同线数 === 组.length,
          名 + ' ' + 组.length + ' 条／同线 ' + 同线数 + ' 条／最差：' + 说明(最差.量));
      };
      判一组('W11r 阅读态：**紧凑**任务项首个词比一行还长时，首行仍从方框**后面**起排（⛔ 方框独占首行）',
        候选.filter(function (c) { return !c.松散; }), '紧凑项');
      判一组('W11p 阅读态：**松散**任务项（正文在 `<p>` 里）首个词比一行还长时，首行仍从方框**后面**起排',
        候选.filter(function (c) { return c.松散; }), '松散项');
      const 节点 = 块节点();
      let 选中 = null;
      let bi = -1;
      // ⚠️ 编辑态只能验**可编辑块**里那一条：取**文档顺序第一个**落在可编辑块里的候选。
      for (let k = 0; k < 候选.length && bi < 0; k++) {
        for (let i = 0; i < 节点.length && i < p.blocks.length; i++) {
          if (p.blocks[i][3] !== 1) continue;
          if (!节点[i] || 节点[i].nodeType !== 1) continue;
          if (节点[i].contains(候选[k].el)) { 选中 = 候选[k]; bi = i; break; }
        }
      }
      if (!选中) {
        记('W11l 编辑态：同一条任务项进入编辑后首行仍从方框后起排', false,
          '前提没建立：超宽任务项都不在任何可编辑的顶层块里');
        return;
      }
      const host = await 进任务块30(bi);
      if (!host) {
        记('W11l 编辑态：同一条任务项进入编辑后首行仍从方框后起排', false,
          '前提没建立：进不去编辑态');
        return;
      }
      const 行表 = host.querySelectorAll('.cm-line[data-rmd-li="task"]');
      // ⚠️⚠️ 必须量**块内全部**超宽任务行，⛔ 不能像 2026-11-09 初版那样"取第一条就 break"：
      //    夹具里第一条超宽项是**中文长句**（断行机会多，缺陷态也照样在方框后起排），
      //    长单词那条根本没被量 ⇒ 判据在缺陷态**恒绿**，把一条真规则误判成死代码
      //    （`bugs/0302` §3.3）。判据的敏感度靠"全量 + 取最差"来保证。
      const 超宽 = [];
      for (let i = 0; i < 行表.length; i++) {
        const m = 量首字31(行表[i], '.cm-rmd-taskbox');
        if (m && m.超宽) 超宽.push(m);
      }
      let 最差 = null;
      let 同线数 = 0;
      for (let i = 0; i < 超宽.length; i++) {
        if (超宽[i].同线) 同线数++;
        if (!最差 || Math.abs(超宽[i].字顶 - 超宽[i].框顶) > Math.abs(最差.字顶 - 最差.框顶)) 最差 = 超宽[i];
      }
      记('W11l 编辑态：**每一条**首词超宽的任务行进入编辑后首字仍在方框后（⛔ 整段掉到第二行）',
         !!最差 && 同线数 === 超宽.length,
         最差 ? ('超宽任务行 ' + 超宽.length + ' 条／同线 ' + 同线数 + ' 条／最差：' + 说明(最差))
              : '编辑态里找不到"首词超宽"的任务行（进入后重排 / 该行没渲染）');
      if (主机()) {
        键(输入框() || document.body, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
      }
    }
    /** W10 源码续行回车。 */
    async function 量续行回车31() {
      const 选 = 找续行31();
      摘要.W.源码续行 = !!选;
      if (!选) return;
      const 旧 = 主机();
      if (旧) {
        键(输入框() || document.body, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
      }
      const host = await 进任务块30(选.块);
      if (!host) {
        记('W10 源码续行回车继承所属列表项（bugs/0300 现象二）', false,
          '前提没建立：进不去编辑态');
        return;
      }
      const ta = 输入框() || document.body;
      const 文前 = 块全文(host);
      const 源行 = String(文前).split('\n');
      /** 撤回到进块时的正文，再退出。 */
      const 收尾 = async function () {
        let 撤 = 0;
        while (撤 < 4 && 主机() && 块全文(主机()) !== 文前) {
          键(输入框() || document.body, 'z', { meta: true });
          await frames(1);
          撤++;
        }
        if (主机()) {
          键(输入框() || document.body, 'Escape');
          await waitFor(function () { return !主机(); }, 4000);
        }
        await frames(1);
      };
      // ⚠️ 2026-11-12（`bugs/0298`）：`选.行号` 是**源码行号**，渲染序与它不再相等
      //    （围栏行没有 `.cm-line`）⇒ 走 `行节点` 问 CM6 要那一行，⛔ 别按下标数。
      const el = 行节点(host, 选.行号);
      if (!el) {
        记('W10 源码续行回车继承所属列表项（bugs/0300 现象二）', false,
          '编辑态里没有第 ' + 选.行号 + ' 条 CM6 行');
        await 收尾();
        return;
      }
      const 行起 = 选.行号 === 0 ? 0 : 源行.slice(0, 选.行号).join('\n').length + 1;
      const 行末 = 行起 + 选.续行.length;
      点末(el);
      await frames(1);
      let 光标 = 选区头(host);
      if (光标 !== 行末) {
        键(ta, 'End');
        await frames(1);
        光标 = 选区头(host);
      }
      if (光标 !== 行末) {
        记('W10 源码续行回车继承所属列表项（bugs/0300 现象二）', false,
          '光标没落到续行行尾（光标 ' + 光标 + ' / 行尾 ' + 行末 + '）');
        await 收尾();
        return;
      }
      const 前缀 = 续前缀31(选.上行, 选.种);
      const 期望 = 文前.slice(0, 行末) + '\n' + 前缀 + 文前.slice(行末);
      键(ta, 'Enter');
      await frames(3);
      const 后 = 主机();
      const 文后 = 后 ? 块全文(后) : null;
      const 行后 = 后 ? 后.querySelectorAll('.cm-line') : [];
      const 新 = 行后[选.行号 + 1] || null;
      const 品种后 = 新 ? String(新.getAttribute('data-rmd-li') || '') : '';
      const 判 = !!后 && 后 === host && 文后 === 期望 && 品种后 === 选.种;
      记('W10 源码续行回车继承所属列表项（bugs/0300 现象二）', 判,
        !后 ? '回车之后宿主没了'
          : (后 !== host ? '回车之后宿主换了（＝退出又重进了）'
            : (文后 !== 期望
              ? ('内容「' + String(文后).slice(0, 60) + '」／期望「'
                + String(期望).slice(0, 60) + '」')
              : (!新 ? '没有续出新行'
                : '新行品种「' + 品种后 + '」' + (判 ? '（与期望一致）' : '≠「' + 选.种 + '」')))));
      await 收尾();
    }
    await 量任务组30(false);
    await 量任务组30(true);
    await 量长词任务31();
    await 量续行回车31();

    // ══ W8 ⭐ `bugs/0109`（2026-11-07 用户报告）：「输入的时候缩进还是不对，输入完了最终的缩进是对的」
    //    两半判据，量的都是**实际几何**，⛔ 不重算产品那套 calc：
    //    ① 编辑态列表项**正文左缘** == 阅读态同一个 `<li>` 的正文左缘（≤ 0.5 px）；
    //    ② 续行之后**输入全程**（Enter → 敲 2 字 → 停手）正文/圆点左缘逐帧不跳。
    //
    // ══ W9 ⭐ `bugs/0110`（同日）：「已经写好的 Item，再次编辑换行的时候，Item 没有了」
    //    ——在**已写好**的列表项正文**中间**按回车，必须仍续出同品种项（拆成两项），
    //    ⛔ 不是裸换行把新行退成正文。⚠️ W7 只测**行尾**回车 ⇒ 行中这一半此前零判据。
    const W列表 = 摘要.W.列表项 === true;
    const taW = function () { return 输入框() || document.body; };
    // ⚠️ 这两把尺**提到 W8/W8t 的 if/else 之外**：`W8L`（`design/0065` P1）要对**每一块**列表
    //    量两态几何，而它必须对"W 段没挑中列表"的夹具也成立 ⇒ 不能挂在 `else` 里面。
    /** 编辑态一行的**正文左缘**（行盒左缘 ＋ `padding-left`；标记零宽藏掉 ⇒ 正文从那儿起）。 */
    function 正文左缘(el) {
      return el.getBoundingClientRect().left + (parseFloat(getComputedStyle(el).paddingLeft) || 0);
    }
    /** 编辑态一行**标记的锚点**（诊断量）：`design/0084` 起标记由 UA 的 `::marker` 画，
     *  `getComputedStyle(el, '::before')` 已无意义；标记落在行的边框盒左侧那一段
     *  `margin-left` 里 ⇒ 两态这一格相等时，UA 从同一个盒子出发画标记。 */
    function 圆点左缘(el) {
      return el.getBoundingClientRect().left;
    }
    if (!W列表) {
      跳过('W8 编辑态列表项正文左缘 == 阅读态（≤ 0.5 px）', '前提没建立：这一块没有列表项');
      跳过('W8b 续行后输入全程正文/圆点不跳', '前提没建立：这一块没有列表项');
      跳过('W9 已写好的列表项在正文中间回车仍续出同品种项', '前提没建立：这一块没有列表项');
    } else {
      /** 编辑态一行**最后一个可见字符的右缘**。W9 的点击落点用它，⛔ 不用行盒右缘——
          行盒铺满编辑器宽度，按行盒比例算的落点会全部落到行尾（`bugs/0110` 的 W9 就这样
          连跳了四次「点不进正文中间」）。剥掉尾随空白：点到空白里同样会被夹到行末。 */
      function 文字右缘(el) {
        const 走 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let 末 = null;
        let n;
        while ((n = 走.nextNode())) {
          if (/\S/.test(n.nodeValue || '')) 末 = n;
        }
        if (!末) return null;
        const s = String(末.nodeValue).replace(/\s+$/, '');
        if (s.length === 0) return null;
        const rg = document.createRange();
        rg.setStart(末, s.length - 1);
        rg.setEnd(末, s.length);
        const r = rg.getBoundingClientRect();
        return r.width > 0 || r.right > 0 ? r.right : null;
      }
      /** 行首前缀 = 源行剥掉**可见内容**（与 W7 同一条独立 oracle）。剥不出 ⇒ `null`。 */
      function 剥前缀(源行, 见) {
        return 见.length > 0 && 源行.slice(-见.length) === 见
          ? 源行.slice(0, 源行.length - 见.length)
          : null;
      }

      // —— 阅读态基线：**进编辑态之前**量（W6 刚退出，块节点是渲染态那个元素）——
      let 读项 = null;
      const 读块 = 块节点()[块];
      if (读块) {
        const lis = 读块.querySelectorAll('li');
        for (let i = 0; i < lis.length; i++) {
          // ⚠️ 取第一个 `<li>`：它和编辑态第一条同类行是同一条列表的首项（同一把尺）。
          读项 = lis[i]; break;
        }
      }
      // ⚠️ 比的是**内容盒左缘**（不是第一个可见字符）：任务项的 `<input>` 与编辑态的
      //    任务框 widget 都在同一个内容盒里往右推 ⇒ 任务项与普通项**同样可比**，
      //    ⛔ 不必排除（排除会让"整块都是任务项"的夹具把 W8 整列 skip 掉）。
      const 读品种 = 读项
        ? (读项.classList.contains('task-list-item') ? 'task'
          : (读项.parentNode && 读项.parentNode.tagName === 'OL' ? 'ordered' : 'bullet'))
        : null;
      const 读左 = 读项 ? 读项.getBoundingClientRect().left : null;

      const host8 = await 进入();
      const 行表8 = host8 ? host8.querySelectorAll('.cm-line') : [];
      let 对齐行8 = null; // W8a：与阅读态**同品种**的第一行（只有它比得出几何）
      let 首项8 = null;   // 编辑态第一个列表行（任意品种）⇒ 定 W8b/W9 的品种基准
      let 目标品种 = null;
      let 末项8 = null;
      let 末号8 = -1;
      // ⭐ 2026-11-11：W8b 的"续行"基线不能取**空列表项**——在空项上按 `Enter` 是
      //    **退出列表**（去向归 K 段 / `bugs/0111` A2），不会在下一行续出同品种项。
      //    `edges` 实测：`> - 引用里的列表项⏎> -` 在末项（空）上回车后块全文变成
      //    `> - 引用里的列表项⏎Hi` ⇒ 行数不增、`末号+1` 不存在，W8b 假红。
      //    ⇒ 取**最后一条有可见正文的**同类项；一条都没有时才走"前提没建立"。
      const 可见正文 = function (el) {
        return 可见行带(el).map(function (x) { return x.text; }).join('').trim();
      };
      for (let i = 0; i < 行表8.length; i++) {
        const k = 行表8[i].getAttribute('data-rmd-li');
        if (!k) continue;
        if (读品种 && k === 读品种 && !对齐行8) 对齐行8 = 行表8[i];
        if (目标品种 === null) { 目标品种 = k; 首项8 = 行表8[i]; }
        if (k === 目标品种 && 可见正文(行表8[i])) { 末项8 = 行表8[i]; 末号8 = i; }
      }
      const 编左 = 对齐行8 ? 正文左缘(对齐行8) : null;
      if (!host8) {
        记('W8 编辑态列表项正文左缘 == 阅读态（≤ 0.5 px）', false,
          '进不去编辑态；状态条：' + 状态条());
        跳过('W8b 续行后输入全程正文/圆点不跳', '前提没建立：进不去编辑态');
        跳过('W9 已写好的列表项在正文中间回车仍续出同品种项', '前提没建立：进不去编辑态');
      } else if (读左 === null || 编左 === null) {
        跳过('W8 编辑态列表项正文左缘 == 阅读态（≤ 0.5 px）',
          '前提没建立：' + (读左 === null
            ? '阅读态这一块里没有非任务的 `<li>`（整块都是任务项）'
            : '编辑态里没有与阅读态同品种（' + 读品种 + '）的列表行'));
        // ⚠️ 几何基线（阅读态）拿不到时 W8 跳过，但 W8b/W9 只依赖**编辑态自己**的品种，
        //    任务项块同样要验（`bugs/0110` 在任务项上一模一样）。
        await 跑续行与行中回车(末项8, 末号8, 目标品种);
      } else {
        记('W8 编辑态列表项正文左缘 == 阅读态（≤ 0.5 px）',
          Math.abs(编左 - 读左) <= 0.5,
          '编辑态 ' + 编左.toFixed(2) + ' / 阅读态 ' + 读左.toFixed(2)
            + '（差 ' + Math.abs(编左 - 读左).toFixed(2) + '，容差 0.5）');
        await 跑续行与行中回车(末项8, 末号8, 目标品种);
      }

      // ── W8t ⭐ `bugs/0113` C1（2026-11-07）：**顶层**列表的编辑态左缘 ──────────
      // ⚠️ W8 只量 W 段挑中的那一块（优先 BlockQuote）⇒ **顶层**列表的缩进从来没被量过。
      //    `0113` C1 声称"顶层列表会多缩进 28 px（host 搬 `<ul>` 的 2em ＋ 行级 depth 再来一次）"，
      //    而 `0112` B1 的既有度量（阅读/编辑 309/309）与它相反 ⇒ 必须补一把独立的尺，
      //    ⛔ 不拿两边的推导互相当证据。
      //    尺子：同一个 `<ul>` 的阅读态 `<li>` 左缘 vs 编辑态列表行正文左缘（与 W8 同口径）。
      let 顶块 = -1;
      const 表T = 块节点();
      for (let i = 0; i < 表T.length; i++) {
        const t = 表T[i] && 表T[i].tagName ? String(表T[i].tagName).toLowerCase() : '';
        if (t === 'ul' || t === 'ol') { 顶块 = i; break; }
      }
      if (顶块 < 0) {
        跳过('W8t 顶层列表：编辑态正文左缘 == 阅读态（≤ 0.5 px）',
          '前提没建立：这份夹具没有顶层列表块');
      } else {
        const t读li = 表T[顶块].querySelector('li');
        const t读左 = t读li ? t读li.getBoundingClientRect().left : null;
        const hostT = await 进入(顶块);
        let t编左 = null;
        if (hostT) {
          const 行T = hostT.querySelector('.cm-line[data-rmd-li]');
          if (行T) t编左 = 正文左缘(行T);
        }
        if (!hostT || t读左 === null || t编左 === null) {
          跳过('W8t 顶层列表：编辑态正文左缘 == 阅读态（≤ 0.5 px）',
            '前提没建立：' + (!hostT ? '进不去编辑态'
              : (t读左 === null ? '阅读态这块里没有 <li>' : '编辑态里没有 .cm-line[data-rmd-li]')));
        } else {
          记('W8t 顶层列表：编辑态正文左缘 == 阅读态（≤ 0.5 px）',
            Math.abs(t编左 - t读左) <= 0.5,
            '编辑态 ' + t编左.toFixed(2) + ' / 阅读态 ' + t读左.toFixed(2)
              + '（差 ' + (t编左 - t读左).toFixed(2) + '，容差 0.5）');
        }
        键(taW(), 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
        记('W8t-c 顶层列表量完之后正文回到操作前', 当前全文() === 全文前,
          (当前全文() === 全文前 ? '' : ('收尾没回到原样：' + 差在哪(当前全文(), 全文前))));
      }

      /**
       * W8b（续行后输入全程不跳）＋ W9（已写好的项正文中间回车）——两段共用一份夹具状态。
       * ⚠️ 无论 `末项` 有没有，**收尾（撤销 + Escape + W8c）都在这里做**：
       *    进过编辑态就必须退出来，否则后面的段落会踩在一个开着的宿主上。
       */
      async function 跑续行与行中回车(末项, 末号, 品种) {
        if (!末项) {
          跳过('W8b 续行后输入全程正文/圆点不跳',
            '前提没建立：编辑态里没有**有正文的**列表行（空项的 Enter 去向归 K 段/`bugs/0111` A2）');
          跳过('W9 已写好的列表项在正文中间回车仍续出同品种项', '前提没建立：同上');
        } else {
        const 基准字 = 正文左缘(末项);
        const 基准点 = 圆点左缘(末项);
        // ⚠️⚠️ 2026-11-11：这里原来用 `点末`（行盒右缘 − 6）。行盒横跨整栏，
        //    而正文只占左边一小段 ⇒ 点在文字右侧的空白里，CM6 把光标放到了**块末**
        //    （`edges` 实测：光标 15 ＝ 末行行末，越过被选的项落到空项上）。
        //    ⇒ 改点**最后一个可见字符的右缘**；取不到才退回 `点末`。
        const 右8 = 文字右缘(末项);
        const r8 = 末项.getBoundingClientRect();
        if (右8 !== null && 右8 > r8.left) {
          末项.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, cancelable: true, button: 0, buttons: 1,
            clientX: Math.round(右8 - 2),
            clientY: Math.round(r8.top + Math.min(8, r8.height / 2)),
            view: window,
          }));
        } else {
          点末(末项);
        }
        // ⚠️ 现场证据：末项**是哪一行**、光标落在哪个偏移、回车前块源是什么。
        //    「没有续行 / 续行变成 plain」时没有这三样就只能猜。
        const 末项见 = 可见正文(末项);
        const 光点8 = 主机() ? 选区头(主机()) : -1;
        // ⭐⭐ 2026-11-11：产品语义——**已经在行尾**时再按 `End` 会跳到**下一行行尾**
        //    （`src/live/selection.js::lineEnd`，与 `lineStart` 的"再按一次去上一行"对称）。
        //    ⇒ 只有光标不在行尾时才按。W8b 原来无条件按，点在行尾上（这里正好是行尾）
        //    ⇒ 光标跑到**下一行（空项）行末**，回车的是空项 —— 那是 K4 的面，不是"续行"。
        const 文点8 = 主机() ? 块全文(主机()) : null;
        const 行末8 = (function () {
          if (光点8 < 0 || 文点8 === null) return -1;
          const e = 文点8.indexOf('\n', 光点8);
          return e < 0 ? 文点8.length : e;
        })();
        if (光点8 >= 0 && 光点8 !== 行末8) {
          键(taW(), 'End');
          await frames(1);
        }
        const 光前8 = 主机() ? 选区头(主机()) : -1;
        const 源前8 = 主机() ? 块全文(主机()) : null;
        键(taW(), 'Enter');
        await frames(2);
        /** 采一帧：续行（`末号 + 1`）还在不在、几何多少。 */
        function 采8(标签) {
          const h = 主机();
          const ls = h ? h.querySelectorAll('.cm-line') : [];
          const el = ls[末号 + 1] || null;
          return {
            标签: 标签,
            同主: !!h && h === host8,
            行数: ls.length,
            行: !!el,
            品种: el ? el.getAttribute('data-rmd-li') : null,
            正文: el ? 正文左缘(el) : null,
            圆点: el ? 圆点左缘(el) : null,
            // ⚠️ 「没有续行」时必须知道 Enter 到底做了什么（换成正文？回到上一行？）——
            //    只报"没有"会让下一次排查又从零开始。
            文: h ? 块全文(h) : null,
          };
        }
        const 样本8 = [采8('续行')];
        打字(taW(), 'H');
        await frames(1);
        样本8.push(采8('敲 1 字'));
        打字(taW(), 'i');
        await frames(1);
        样本8.push(采8('敲 2 字'));
        await frames(8);
        样本8.push(采8('停手后'));
        const 不跳 = 样本8.every(function (s) {
          return s.同主 && s.行 && s.品种 === 品种
            && s.正文 !== null && Math.abs(s.正文 - 基准字) <= 0.5
            && (基准点 === null || (s.圆点 !== null && Math.abs(s.圆点 - 基准点) <= 0.5));
        });
        记('W8b 续行后输入全程正文/圆点不跳（== 停手后的终态）', 不跳,
          (样本8.map(function (s) {
            return s.标签 + '：' + (s.行
              ? ('品种 ' + s.品种 + ' / 正文 '
                + (s.正文 === null ? '?' : s.正文.toFixed(2)) + ' / 圆点 '
                + (s.圆点 === null ? '?' : s.圆点.toFixed(2)))
              : '没有续行');
          }).join('；') + '／基线：正文 ' + 基准字.toFixed(2) + ' / 圆点 '
            + (基准点 === null ? '?' : 基准点.toFixed(2))
            + (不跳 ? '' : '／末项第 ' + 末号 + ' 行「' + 末项见 + '」／点后光标 '
              + 光点8 + ' → End 后 ' + 光前8 + '／回车前块源「' + String(源前8) + '」／停手后块全文「'
              + String(样本8[样本8.length - 1].文) + '」（行数 '
              + 样本8[样本8.length - 1].行数 + '）')));

        // ── W9 已写好的项，在**正文中间**回车（`bugs/0110`）──────────────────────
        // 先把 W8b 敲进去的东西撤干净（CM6 会把相近的事务并进同一个撤销组，次数不定）。
        let 撤8 = 0;
        while (撤8 < 6 && 主机() && 块全文(主机()) !== 源块文本) {
          键(taW(), 'z', { meta: true });
          await frames(1);
          撤8++;
        }
        const host9 = 主机();
        const 文9前 = host9 ? 块全文(host9) : null;
        const 源行9 = String(文9前 === null ? '' : 文9前).split('\n');
        const 行表9 = host9 ? host9.querySelectorAll('.cm-line') : [];
        let 项9 = null;
        let 号9 = -1;
        let 前缀9 = null;
        for (let i = 0; i < 行表9.length; i++) {
          if (行表9[i].getAttribute('data-rmd-li') !== 品种) continue;
          const 见 = 可见文本(行表9[i]);
          const pr = 剥前缀(源行9[i] === undefined ? '' : 源行9[i], 见);
          // ⚠️ 至少要 3 个字：更短的项点不进"正文中间"（点在哪都夹到行界）
          if (pr !== null && 见.length >= 3) { 项9 = 行表9[i]; 号9 = i; 前缀9 = pr; break; }
        }
        let 光标9 = -1;
        let 文9 = null;
        // ⚠️ 这两个值在 skip 文案里也要用 ⇒ 声明在 `if` 之外（块内 const 会在 skip 分支
        //    ReferenceError，整段变 A0 致命——2026-11-07 已踩过一次同形的坑）。
        let 左9 = null;
        let 界9 = null;
        // 点**可见正文的中段**：比例从右往左试，要求光标落在"正文起点之后、行末之前"。
        const 比分 = [0.62, 0.45, 0.8, 0.3];
        if (host9 && 项9) {
          左9 = 正文左缘(项9);
          const 右9 = 文字右缘(项9);
          const r9 = 项9.getBoundingClientRect();
          // 落点按**可见正文**的宽度排布（右界 = 最后一个可见字符的右缘）；
          // 量不到文字时退回行盒，并如实记进 skip 文案。
          界9 = 右9 !== null && 右9 > 左9 ? 右9 : r9.right;
          for (let k = 0; k < 比分.length; k++) {
            const x = Math.round(左9 + (界9 - 左9) * 比分[k]);
            const y = Math.round(r9.top + Math.min(8, r9.height / 2));
            项9.dispatchEvent(new MouseEvent('mousedown', {
              bubbles: true, cancelable: true, button: 0, buttons: 1,
              clientX: x, clientY: y, view: window,
            }));
            await frames(1);
            const h = 主机();
            const c = h ? 选区头(h) : -1;
            const t = h ? 块全文(h) : null;
            if (t !== 文9前) break; // 退让：点出了别的事（不该发生）⇒ 不在脏状态上判
            if (c < 0) continue;
            const 起 = t.lastIndexOf('\n', c - 1) + 1;
            const 换 = t.indexOf('\n', c);
            const 末 = 换 < 0 ? t.length : 换;
            const 内容起 = 起 + 前缀9.length;
            if (c > 内容起 && c < 末) { 光标9 = c; 文9 = t; break; }
          }
        }
        if (!host9 || !项9) {
          跳过('W9 已写好的列表项在正文中间回车仍续出同品种项',
            '前提没建立：' + (!host9 ? '撤销之后没有视图了'
              : '没有一条"可见内容能当源行后缀且 ≥3 字"的列表行'));
        } else if (光标9 < 0 || 文9 === null) {
          跳过('W9 已写好的列表项在正文中间回车仍续出同品种项',
            '前提没建立：点不进正文中间（' + 比分.length + ' 个落点都夹到了行界；正文 '
              + (typeof 左9 === 'number' ? 左9.toFixed(2) : '?') + ' → '
              + (typeof 界9 === 'number' ? 界9.toFixed(2) : '?') + '）');
        } else {
          const 行起9 = 文9.lastIndexOf('\n', 光标9 - 1) + 1;
          const 后换9 = 文9.indexOf('\n', 光标9);
          const 行末9 = 后换9 < 0 ? 文9.length : 后换9;
          const 内容起9 = 行起9 + 前缀9.length;
          const at9 = Math.max(光标9, 内容起9);
          const 行号9 = 文9.slice(0, 光标9).split('\n').length - 1;
          // 期望前缀与 W7 同一口径（独立 oracle，⛔ 不抄产品算法）：有序 +1、任务换空框
          let 期望前缀9 = 前缀9;
          if (品种 === 'ordered') {
            期望前缀9 = 前缀9.replace(/\d{1,9}(?=[.)][ \t]*$)/, function (m) {
              return String(parseInt(m, 10) + 1);
            });
          } else if (品种 === 'task') {
            期望前缀9 = 前缀9.replace(/\[[xX ]\]/, '[ ]');
          }
          const 期望9 = 文9.slice(0, at9) + '\n' + 期望前缀9 + 文9.slice(at9);
          键(taW(), 'Enter');
          await frames(2);
          const 后9 = 主机();
          const 文9后 = 后9 ? 块全文(后9) : null;
          const 行表9后 = 后9 ? 后9.querySelectorAll('.cm-line') : [];
          const 新行9 = 行表9后[行号9 + 1] || null;
          const 品种后9 = 新行9 ? 新行9.getAttribute('data-rmd-li') : null;
          const 判9 = !!后9 && 后9 === host9 && 文9后 === 期望9
            && 品种后9 === 品种;
          记('W9 已写好的列表项在正文中间回车仍续出同品种项', 判9,
            !后9 ? '回车之后宿主没了'
              : (后9 !== host9 ? '回车之后宿主换了（＝退出又重进了）'
                : (文9后 !== 期望9
                  ? ('内容「' + String(文9后).slice(0, 60) + '」／期望「'
                    + String(期望9).slice(0, 60) + '」（光标 ' + 光标9 + '，正文起点 '
                    + 内容起9 + '，行末 ' + 行末9 + '）')
                  : (!新行9 ? '没有续出新行'
                    : ('新行品种「' + 品种后9 + '」'
                      + (判9 ? '（与期望一致）' : '≠「' + 品种 + '」'))))));
        }
        } // —— 有列表项的那一半（W8b + W9）

        // —— 收尾：撤掉 W9 那个换行，退出，正文逐行回到操作前 ——
        let 撤9 = 0;
        while (撤9 < 4 && 主机() && 块全文(主机()) !== 源块文本) {
          键(taW(), 'z', { meta: true });
          await frames(1);
          撤9++;
        }
        键(taW(), 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(2);
        记('W8c W8/W9 之后正文逐行回到操作前', 当前全文() === 全文前,
          (当前全文() === 全文前 ? '' : ('收尾没回到原样：' + 差在哪(当前全文(), 全文前))));
      }
    }
      // ── W8L ⭐ `design/0065` P1（2026-11-10 用户批准）🔥 全部列表块的两态几何对照 ──
      //  ⚠️ 为什么还要新加一段：`W8` 只量 W 段挑中的那一块（优先 BlockQuote），
      //     `W8t` 只量**第一份**顶层列表 ⇒ 其余列表块的缩进从来没被任何判据量过。
      //     `bugs/0305` ① 就出在这个缝里：宿主不是 `<ul>` 时那格缩进没有来源。
      //  尺子与 `W8`/`W8t` 完全同口径（正文左缘 ＝ 行盒左缘 ＋ `padding-left`），
      //     ⛔ 不重算产品那套 `calc(depth × indent)`。
      //  ⛔ 逐块**进一次编辑态、量完就退**；任何一块进不去都记红或跳过并在明细里点名，
      //     不允许"没跑到"被当成通过（`W8L-覆盖` 兜底）。
      {
        const 块表L = 块节点();
        // 只量**可编辑**的块：载荷第 4 位是"可编辑"标志（与 P 段同一判据）。
        // ⚠️ 不可编辑的块压根进不了编辑态 ⇒ 把它算进覆盖率只会制造假红，
        //    所以先在**名单**上剔除，而不是"进去失败再记红"。
        const 载荷L = (window.__rmd && window.__rmd.payload) || null;
        const 可编L = function (i) {
          return !!(载荷L && 载荷L.blocks && 载荷L.blocks[i] && 载荷L.blocks[i][3] === 1);
        };
        const 列表块L = [];
        for (let i = 0; i < 块表L.length; i++) {
          const n = 块表L[i];
          if (!n || typeof n.querySelectorAll !== 'function') continue;
          if (!可编L(i)) continue;
          // 顶层就是列表 ⇒ 算一块；引用/段落/标题里**嵌着**列表 ⇒ 也算一块
          //   （`bugs/0305` ① 的反例正是"块品种不是列表"这一种）。
          if (n.querySelector('li')) 列表块L.push(i);
        }
        摘要.W.列表块 = 列表块L;
        const 量到L = [];
        for (let k = 0; k < 列表块L.length; k++) {
          const 序 = 列表块L[k];
          const 名 = 'W8L-' + 序 + ' 列表块两态正文左缘 / 项距 / 块内高逐项相等（≤ 0.5 px）';
          const 读块L = 块节点()[序];
          const 读行L = [];
          if (读块L && typeof 读块L.querySelectorAll === 'function') {
            const lis = 读块L.querySelectorAll('li');
            for (let j = 0; j < lis.length; j++) {
              const r = lis[j].getBoundingClientRect();
              const pl = parseFloat(getComputedStyle(lis[j]).paddingLeft) || 0;
              读行L.push({ 左: r.left + pl, 高: r.height, 顶: r.top, 底: r.bottom });
            }
          }
          if (读行L.length === 0) {
            跳过(名, '前提没建立：这一块在阅读态里没有 `<li>`');
            continue;
          }
          const hostL = await 进入(序);
          const 编行L = [];
          let 续行数L = 0;
          let 编首顶L = null;
          let 编末底L = null;
          if (hostL) {
            const ls = hostL.querySelectorAll('.cm-line[data-rmd-li]');
            // ⚠️ 编辑态**一行源码 = 一个 `.cm-line`**，而阅读态**一个 `<li>` 可以占多行源码**
            //    （懒续行 / 松列表的空行 / 折行内容）⇒ 直接按下标逐行配会全部"行数不等"。
            //    配对口径改成"**列表项起点行**"：用块源码做独立 oracle，只认 `^\s*([-*+]|\d+[.)])\s`
            //    的行，续行跳过并在明细里报数。⛔ 不用产品那套 `data-rmd-li` 标记反推——
            //    那样等于拿被验对象当 oracle。
            const 源行L = String(块全文(hostL) || '').split('\n');
            // ⚠️⚠️ `ls` 是**过滤过**的（只有带 `data-rmd-li` 的行），它的下标 ≠ 源码行号。
            //    引用块里"先一段正文、再一个列表"时，前几行不带 `data-rmd-li` ⇒ 按下标取源码
            //    会把项起点认成续行（2026-11-12 `shapes.md` 实测：阅读态 2 个 `<li>` /
            //    编辑态"1 个项起点 + 2 条续行"，W8L-3 假红）。⇒ 用整份 `.cm-line` 序列还原行号。
            const 全部行L = hostL.querySelectorAll('.cm-line');
            const 行号L = new Map();
            for (let j = 0; j < 全部行L.length; j++) 行号L.set(全部行L[j], j);
            const 是项起点 = function (s) {
              // ① 引用块里的列表：先剥掉任意层 `>` 前缀（`> - 项` 在阅读态就是一个 `<li>`）；
              // ② 缩进**不设上限**：嵌套项相对父项缩进，超过 3 格是常态
              //    （`ARCHITECTURE.md` 的三级有序项缩进 5 格，卡 `{0,3}` 会把它误判成续行）。
              let t = String(s == null ? '' : s).replace(/^\s*(?:>\s?)+/, '');
              if (/^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(t)) return true;
              // ③ 原始 HTML 列表块：`<li>` 行本身就是项起点。
              if (/^\s*<li[\s>]/i.test(t)) return true;
              return false;
            };
            for (let j = 0; j < ls.length; j++) {
              const j源 = 行号L.has(ls[j]) ? 行号L.get(ls[j]) : j;
              const 源 = 源行L[j源] == null ? null : 源行L[j源];
              if (源 !== null && !是项起点(源)) { 续行数L++; continue; }
              编行L.push({
                左: 正文左缘(ls[j]),
                点: 圆点左缘(ls[j]),
                高: ls[j].getBoundingClientRect().height,
                顶: ls[j].getBoundingClientRect().top,
                底: ls[j].getBoundingClientRect().bottom,
                源: 源 === null ? '(源码越界)' : String(源).slice(0, 24),
              });
            }
            // ⚠️ **块内高要连续行一起算**：阅读态的 `<li>` 盒子本来就含它的续行，
            //    只拿"项起点那一行"的底去比，带续行的项会凭空少一行（`bugs/0307` 的
            //    夹具实测 −23.80 px 假红）。这里记的是整块列表行的首顶与末底。
            // ⚠️⚠️ 但**引文空行**（`cm-rmd-quote-gap`）不能算进末底（2026-11-12 `shapes.md`
            //    实测）：`> - 甲⏎> - 乙⏎>⏎> ```…` 里那条 `>` 空行也带 `data-rmd-li`
            //    （它夹在列表与围栏之间），它的行盒高 15.39 px 承载的是**段距**，阅读态
            //    那段距在最后一个 `<li>` **外面** ⇒ 直接拿 `ls[末].bottom` 会多算 15.39 px
            //    （两态逐项 top/底 完全相同，只有"末底"取错行）。
            if (ls.length) {
              编首顶L = ls[0].getBoundingClientRect().top;
              for (let j = ls.length - 1; j >= 0; j--) {
                const cl = ls[j].classList;
                if (cl && (cl.contains('cm-rmd-quote-gap') || cl.contains('cm-rmd-collapsed'))) continue;
                编末底L = ls[j].getBoundingClientRect().bottom;
                break;
              }
            }
          }
          键(taW(), 'Escape');
          await waitFor(function () { return !主机(); }, 4000);
          await frames(1);
          量到L.push(序);
          if (当前全文() !== 全文前) {
            记(名, false, '量完没回到原样：' + 差在哪(当前全文(), 全文前));
            continue;
          }
          if (!hostL) {
            记(名, false, '进不去编辑态；状态条：' + 状态条());
            continue;
          }
          if (编行L.length !== 读行L.length) {
            记(名, false, '项数不等：阅读态 ' + 读行L.length + ' 个 `<li>` / 编辑态 '
              + 编行L.length + ' 个列表项起点（另跳过 ' + 续行数L + ' 条续行）—— 两态不是同一批项，⛔ 不能比值');
            continue;
          }
          let 最差 = 0;
          let 最差序 = -1;
          for (let j = 0; j < 读行L.length; j++) {
            const 差 = Math.abs(编行L[j].左 - 读行L[j].左);
            if (差 > 最差) { 最差 = 差; 最差序 = j; }
          }
          // ⭐⭐ 行高（`design/0065` §2.2④）：⚠️ ⛔ 不能逐项比 `高`——阅读态的 `<li>` 与
          //    编辑态的 `.cm-line` 是两种盒子，同样的间距可能分别落在盒子内 / 盒子外
          //    （`bugs/0021` 时代阅读态把段距折在 `<li>` 外面、编辑态做成行内 `padding-bottom`）。
          //    `design/0066` 起列表内没有段距，但**这条口径仍然成立**：两态能比的量是
          //    **项距**（每项相对首项的偏移）与**块内内容高**（末项底 − 首项顶）。
          //    `bugs/0307` 的 239.3 px 差就落在这两个量上——只量左缘时它一声不响地漏了三周。
          const 读距 = 读行L.map(function (x) { return x.顶 - 读行L[0].顶; });
          const 编距 = 编行L.map(function (x) { return x.顶 - 编行L[0].顶; });
          let 距差 = 0;
          let 距序 = -1;
          for (let j = 0; j < 读距.length; j++) {
            const d = Math.abs(编距[j] - 读距[j]);
            if (d > 距差) { 距差 = d; 距序 = j; }
          }
          const 读内高 = 读行L[读行L.length - 1].底 - 读行L[0].顶;
          const 编内高 = 编首顶L === null ? 0 : 编末底L - 编首顶L;
          const 高差 = Math.abs(编内高 - 读内高);
          const 全绿 = 最差 <= 0.5 && 距差 <= 0.5 && 高差 <= 0.5;
          记(名, 全绿,
            全绿
              ? ('共 ' + 读行L.length + ' 项（跳过 ' + 续行数L + ' 条续行），左缘最大差 '
                + 最差.toFixed(2) + '、项距最大差 ' + 距差.toFixed(2) + '、块内高 '
                + 编内高.toFixed(2) + ' / ' + 读内高.toFixed(2))
              : (最差 > 0.5
                ? ('左缘第 ' + (最差序 + 1) + ' 项：编辑态 ' + 编行L[最差序].左.toFixed(2)
                  + ' / 阅读态 ' + 读行L[最差序].左.toFixed(2)
                  + '（差 ' + (编行L[最差序].左 - 读行L[最差序].左).toFixed(2) + '，容差 0.5）'
                  + '；圆点 ' + (编行L[最差序].点 === null ? 'null' : 编行L[最差序].点.toFixed(2))
                  + '；该行源码「' + 编行L[最差序].源 + '」')
                : (距差 > 0.5
                  ? ('项距第 ' + (距序 + 1) + ' 项：编辑态顶 +' + 编距[距序].toFixed(2)
                    + ' / 阅读态顶 +' + 读距[距序].toFixed(2)
                    + '（差 ' + (编距[距序] - 读距[距序]).toFixed(2) + '，容差 0.5）；该行源码「'
                    + 编行L[距序].源 + '」')
                  : ('块内高：编辑态 ' + 编内高.toFixed(2) + ' / 阅读态 ' + 读内高.toFixed(2)
                    + '（差 ' + (编内高 - 读内高).toFixed(2) + '，容差 0.5）'
                    // ⚠️ 红的时候光有总数说不清"差在哪一项"（与 `B{i}-3a` 的红时诊断同一条纪律）：
                    //    列出两态**逐项的顶/底**，一眼能看出是某一项的行盒不同还是项距不同。
                    + '；阅读项 ' + 读行L.map(function (x) {
                      return '[' + x.顶.toFixed(2) + '→' + x.底.toFixed(2) + ']';
                    }).join('')
                    + '；编辑项 ' + 编行L.map(function (x) {
                      return '[' + x.顶.toFixed(2) + '→' + x.底.toFixed(2) + ']';
                    }).join('')
                    + '；编辑首顶 ' + (编首顶L === null ? 'null' : 编首顶L.toFixed(2))
                    + ' / 末底 ' + (编末底L === null ? 'null' : 编末底L.toFixed(2))))))
        }
        摘要.W.列表块量到 = 量到L;
        记('W8L-覆盖 每份夹具里每一个列表块都量过',
          量到L.length === 列表块L.length,
          '列表块 ' + 列表块L.length + ' / 量到 ' + 量到L.length
            + (列表块L.length === 0 ? '（这份夹具没有列表块）' : ''));
      }

  }

  // ── U/K 两段共用的"进块 / 放光标 / 撤回"小工具 ──────────────────────────
  //
  // ⚠️ 放在模块作用域是因为 **U 段与 K 段都要用**；写两份会在改判据时只改一份
  //    （`docs/bugs/0025` 那族"两份实现，只有一份有调用方"）。
  function 视图(host) {
    const CM6 = window.rmdCM6;
    return CM6 && CM6.EditorView ? CM6.EditorView.findFromDOM(host) : null;
  }
  /** 放光标（走产品的事务过滤器；⛔ 不改正文）。 */
  function 设光标(host, 偏移) {
    const V = 视图(host);
    if (!V || !V.state) return false;
    V.dispatch({ selection: { anchor: 偏移 } });
    return true;
  }
  function 行起(文, 行号) {
    const a = String(文).split('\n');
    let s = 0;
    for (let i = 0; i < 行号; i++) s += a[i].length + 1;
    return s;
  }
  function 截(s) {
    const t = String(s == null ? '' : s).replace(/\n/g, '⏎');
    return t.length > 72 ? t.slice(0, 72) + '…' : t;
  }
  /** 会话此刻的正文（最后一次 `render_preview`；没提交过 ⇒ 夹具原文）。 */
  function 当前全文() {
    const r = 最近一次('render_preview');
    return r && r.args && typeof r.args.text === 'string'
      ? r.args.text
      : String((window.__FIXTURE || {}).text || '');
  }
  async function 进入块(i) {
    const 旧 = 主机();
    点末(块节点()[i]);
    const h = await waitFor(function () {
      const x = 主机();
      return x && x !== 旧 ? x : null;
    }, 4000);
    await frames(1);
    return h;
  }
  /** `⌘Z` 直到回到基线；返回真实撤销次数（⛔ 不写死步数）。 */
  async function 撤回基线(host, 基线) {
    let 次 = 0;
    while (块全文(host) !== 基线 && 次 < 40) {
      键(输入框() || document.body, 'z', { meta: true });
      await frames(2);
      次++;
    }
    return { 回: 块全文(host) === 基线, 次: 次 };
  }

  // ── U 段：**列表项上的多输入序列**（2026-11-11 用户要求：「想办法自己执行多输入测试，
  //    已经在项目项的背景下」）────────────────────────────────────────────────
  //
  // 为什么需要它：B/O/W/V 那几段是「一个动作 → 一条判据」，序列里**某一步把字写到别处**
  //   时后面的单动作判据仍然可能全绿——`bugs/0312` 就是这么漏的：敲 `-` 再敲空格，
  //   光标被旧的 Setext 伪区间弹到下一行，随后打的字全部并进**下一段**，而"列表项续标记"
  //   那一族看的是新行前缀，一个字节都不差。
  // ⇒ 本段用**一条脚本驱动多步输入**，每一步都拿"上一步的期望正文"当基准，逐字节比
  //   **整块全文** ＋ 光标偏移 ＋ 光标行。任何一步写错位置，下一步立刻红并点名第几步。
  //
  // ⚠️ 全部走**产品自己的事件路径**（`input` / `keydown` / `composition*` 派发到离屏
  //   textarea）；只有**放光标**用 `view.dispatch`（与 `光标零位移` 同口径——它照样过
  //   `transactionFilter`），⛔ 不绕过输入机直接改正文。
  // ⚠️ 每个场景收尾都 `⌘Z` 逐字撤回基线，**如实记撤销次数**；撤不回去就是红，
  //   ⛔ 不许带着脏文本进下一个场景（那样后面的判据全是假的）。
  // ⚠️ 真机 IME / 可见窗口的观感仍需人工（`.claude/rules/tests.md`）；这里判的是
  //   **事件序列 → 事务 → 正文/光标**这条链。
  async function 跑多输入序列(base, 摘要) {
    const p = window.__rmd && window.__rmd.payload;
    if (!p || !p.blocks) { 摘要.U = { 适用: false, 原因: '没有载荷' }; return; }
    const 表 = 块节点();
    const 可编 = function (i) { return !!(p.blocks[i] && p.blocks[i][3] === 1); };
    /** 独立 oracle：从**源码**认列表行（⛔ 不读产品 `data-rmd-li`）。 */
    function 行种(源行) {
      const s = String(源行 == null ? '' : 源行);
      // ⛔ 引用块里的列表（`> - x`）不测：本段的行起/行号按纯源码算，`>` 是另一种形状。
      if (/^[ \t]*>/.test(s)) return null;
      let m = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]*)/.exec(s);
      if (m) return { 种: 'task', 前缀: m[1] };
      m = /^([ \t]*\d{1,9}[.)][ \t]+)/.exec(s);
      if (m) return { 种: 'ordered', 前缀: m[1] };
      m = /^([ \t]*[-*+][ \t]+)/.exec(s);
      if (m) return { 种: 'bullet', 前缀: m[1] };
      return null;
    }
    /** 回车之后新行该有的前缀（与 `W7b` 同一口径的独立 oracle）。 */
    function 期前缀(种, 原前缀) {
      if (种 === 'ordered') {
        return 原前缀.replace(/(\d{1,9})([.)][ \t]*)$/, function (m, n, 尾) {
          return String(parseInt(n, 10) + 1) + 尾;
        });
      }
      if (种 === 'task') return 原前缀.replace(/\[[xX ]\]/, '[ ]');
      return 原前缀;
    }
    /** 只有"行尾有正文"的项才可测（空项回车走的是删标记那条路）。 */
    function 可测(源行) {
      const 形 = 行种(源行);
      if (!形) return null;
      const 正文 = String(源行).slice(形.前缀.length);
      if (正文.replace(/[ \t]/g, '') === '') return null;
      return 形;
    }
    // 每种品种挑**第一份**含可测行的可编辑块（一次夹具里把无序/有序/任务都覆盖到）。
    const 选 = {};
    for (let i = 0; i < 表.length && i < p.blocks.length; i++) {
      if (!可编(i)) continue;
      const 源 = 块源(i).split('\n');
      for (let n = 0; n < 源.length; n++) {
        const 形 = 可测(源[n]);
        if (!形 || 选[形.种]) continue;
        选[形.种] = { 块: i, 行号: n, 行: 源[n], 前缀: 形.前缀, 种: 形.种 };
      }
      if (选.bullet && 选.ordered && 选.task) break;
    }
    const 品种 = ['bullet', 'ordered', 'task'].filter(function (k) { return !!选[k]; });
    if (!品种.length) { 摘要.U = { 适用: false, 原因: '没有含可测列表行的可编辑块' }; return; }
    摘要.U = { 适用: true, 品种: 品种, 逐种: {} };

    const 输入 = function () { return 输入框() || document.body; };

    // ── 五个场景：每个都从**基线**出发，自己不管收尾（driver 统一撤回）──
    async function 场景逐字(host, 基线, info) {
      const 行末 = 行起(基线, info.行号) + info.行.length;
      if (!设光标(host, 行末)) return { 致命: '拿不到 EditorView' };
      await frames(1);
      if (选区头(host) !== 行末) return { 致命: '光标没落到行尾（' + 选区头(host) + ' / ' + 行末 + '）' };
      const 字 = '甲A乙B';
      let 已 = '';
      const 步 = [];
      for (let k = 0; k < 字.length; k++) {
        const ch = 字.charAt(k);
        打字(输入(), ch);
        await frames(2);
        已 += ch;
        const 期 = 基线.slice(0, 行末) + 已 + 基线.slice(行末);
        const 实文 = 块全文(host);
        const 实光 = 选区头(host);
        步.push({ 第: k + 1, 字: ch, 文对: 实文 === 期,
          光标: 实光, 期望光标: 行末 + 已.length, 行: 光标行(host), 期望行: info.行号 });
      }
      const 坏 = 步.filter(function (s) {
        return !s.文对 || s.光标 !== s.期望光标 || s.行 !== s.期望行;
      });
      return {
        ok: 坏.length === 0,
        说明: 坏.length === 0
          ? ('4 个字符逐步落进行尾（光标 ' + 行末 + '→' + (行末 + 4) + '）')
          : ('第 ' + 坏[0].第 + ' 步（「' + 坏[0].字 + '」）不对：文对=' + 坏[0].文对
            + ' 光标 ' + 坏[0].光标 + '/' + 坏[0].期望光标
            + ' 行 ' + 坏[0].行 + '/' + 坏[0].期望行
            + '；全文「' + 截(块全文(host)) + '」'),
      };
    }

    async function 场景回车续项(host, 基线, info) {
      const 行末 = 行起(基线, info.行号) + info.行.length;
      if (!设光标(host, 行末)) return { 致命: '拿不到 EditorView' };
      await frames(1);
      if (选区头(host) !== 行末) return { 致命: '光标没落到行尾（' + 选区头(host) + ' / ' + 行末 + '）' };
      const 行数0 = 基线.split('\n').length;
      const 前缀 = 期前缀(info.种, info.前缀);
      const 期1 = 基线.slice(0, 行末) + '\n' + 前缀 + 基线.slice(行末);
      const 正文起 = 行末 + 1 + 前缀.length;
      键(输入(), 'Enter');
      await frames(3);
      const 实1 = 块全文(host);
      const 光1 = 选区头(host);
      const 回车 = {
        文对: 实1 === 期1, 光标: 光1, 期望光标: 正文起,
        行数: 实1.split('\n').length, 期望行数: 行数0 + 1,
        行: 光标行(host), 期望行: info.行号 + 1,
      };
      if (!回车.文对) {
        return { ok: false, 说明: '回车之后全文不对（期望「' + 截(期1) + '」，实际「' + 截(实1) + '」）' };
      }
      const 字 = '新行';
      let 已 = '';
      const 步 = [];
      for (let k = 0; k < 字.length; k++) {
        const ch = 字.charAt(k);
        打字(输入(), ch);
        await frames(2);
        已 += ch;
        const 期 = 期1.slice(0, 正文起) + 已 + 期1.slice(正文起);
        const 实文 = 块全文(host);
        const 实光 = 选区头(host);
        步.push({ 第: k + 1, 字: ch, 文对: 实文 === 期,
          光标: 实光, 期望光标: 正文起 + 已.length, 行: 光标行(host), 期望行: info.行号 + 1 });
      }
      const 坏 = 步.filter(function (s) {
        return !s.文对 || s.光标 !== s.期望光标 || s.行 !== s.期望行;
      });
      const 全对 = 回车.光标 === 回车.期望光标 && 回车.行数 === 回车.期望行数
        && 回车.行 === 回车.期望行 && 坏.length === 0;
      return {
        ok: 全对,
        说明: 全对
          ? ('续出「' + 前缀 + '」，光标 ' + 正文起 + '；随后 2 个字逐步落进新行正文')
          : ('回车：光标 ' + 回车.光标 + '/' + 回车.期望光标 + ' 行数 ' + 回车.行数 + '/'
            + 回车.期望行数 + ' 行 ' + 回车.行 + '/' + 回车.期望行
            + (坏.length ? ('；第 ' + 坏[0].第 + ' 步（「' + 坏[0].字 + '」）文对=' + 坏[0].文对
              + ' 光标 ' + 坏[0].光标 + '/' + 坏[0].期望光标) : '')),
      };
    }

    async function 场景空项退出(host, 基线, info) {
      const 行末 = 行起(基线, info.行号) + info.行.length;
      if (!设光标(host, 行末)) return { 致命: '拿不到 EditorView' };
      await frames(1);
      if (选区头(host) !== 行末) return { 致命: '光标没落到行尾（' + 选区头(host) + ' / ' + 行末 + '）' };
      const 前缀 = 期前缀(info.种, info.前缀);
      const 期1 = 基线.slice(0, 行末) + '\n' + 前缀 + 基线.slice(行末);
      键(输入(), 'Enter');
      await frames(3);
      if (块全文(host) !== 期1) {
        return { ok: false, 说明: '第一次回车没有续出空项（实际「' + 截(块全文(host)) + '」）' };
      }
      // 空项行尾再回车 ⇒ `lineBreakAction` ③ 删掉标记、退出列表，只剩一个空行。
      const 空项起 = 行末 + 1;
      if (!设光标(host, 空项起 + 前缀.length)) return { 致命: '空项上放不了光标' };
      await frames(1);
      键(输入(), 'Enter');
      await frames(3);
      const 期2 = 基线.slice(0, 行末) + '\n' + 基线.slice(行末);
      const 实2 = 块全文(host);
      const 光2 = 选区头(host);
      const 退出 = { 文对: 实2 === 期2, 光标: 光2, 期望光标: 行末 + 1,
        行: 光标行(host), 期望行: info.行号 + 1 };
      if (!退出.文对) {
        return { ok: false, 说明: '空项再回车没有退出列表（期望「' + 截(期2) + '」，实际「' + 截(实2) + '」）' };
      }
      const 字 = '续写';
      let 已 = '';
      const 步 = [];
      for (let k = 0; k < 字.length; k++) {
        const ch = 字.charAt(k);
        打字(输入(), ch);
        await frames(2);
        已 += ch;
        const 期 = 期2.slice(0, 行末 + 1) + 已 + 期2.slice(行末 + 1);
        const 实文 = 块全文(host);
        const 实光 = 选区头(host);
        步.push({ 第: k + 1, 字: ch, 文对: 实文 === 期,
          光标: 实光, 期望光标: 行末 + 1 + 已.length, 行: 光标行(host), 期望行: info.行号 + 1 });
      }
      const 坏 = 步.filter(function (s) {
        return !s.文对 || s.光标 !== s.期望光标 || s.行 !== s.期望行;
      });
      const 全对 = 退出.光标 === 退出.期望光标 && 退出.行 === 退出.期望行 && 坏.length === 0;
      return {
        ok: 全对,
        说明: 全对
          ? ('空项再回车删标记退列表，光标 ' + (行末 + 1) + '；随后 2 个字落进新行')
          : ('退列表：光标 ' + 退出.光标 + '/' + 退出.期望光标 + ' 行 ' + 退出.行 + '/'
            + 退出.期望行
            + (坏.length ? ('；第 ' + 坏[0].第 + ' 步（「' + 坏[0].字 + '」）文对=' + 坏[0].文对) : '')),
      };
    }

    async function 场景组合(host, 基线, info) {
      const 行末 = 行起(基线, info.行号) + info.行.length;
      if (!设光标(host, 行末)) return { 致命: '拿不到 EditorView' };
      await frames(1);
      if (选区头(host) !== 行末) return { 致命: '光标没落到行尾（' + 选区头(host) + ' / ' + 行末 + '）' };
      const 文0 = 块全文(host);
      const 串 = ['地', '地方', '地方金'];
      const 更新 = [];
      组合(输入(), 'compositionstart', '');
      for (let k = 0; k < 串.length; k++) {
        组合(输入(), 'compositionupdate', 串[k]);
        await frames(1);
        更新.push({ 段: 串[k], 文不变: 块全文(host) === 文0 });
      }
      组合(输入(), 'compositionend', '地方金');
      await frames(3);
      const 期 = 基线.slice(0, 行末) + '地方金' + 基线.slice(行末);
      const 实文 = 块全文(host);
      const 实光 = 选区头(host);
      const 组合期全静 = 更新.every(function (x) { return x.文不变; });
      const 全对 = 组合期全静 && 实文 === 期 && 实光 === 行末 + 3 && 光标行(host) === info.行号;
      return {
        ok: 全对,
        说明: 全对
          ? ('组合期 3 次 update 正文不动；上屏「地方金」逐字落进行尾（光标 ' + (行末 + 3) + '）')
          : ('组合期正文不变=' + 组合期全静 + '；上屏文对=' + (实文 === 期)
            + ' 光标 ' + 实光 + '/' + (行末 + 3) + ' 行 ' + 光标行(host) + '/' + info.行号
            + '；全文「' + 截(实文) + '」'),
      };
    }

    /**
     * 从 `[起, 止)` 里挑**第一个真能落住光标**的偏移。
     *
     * ⚠️⚠️ 正文里的行内标记（`**粗体**`、`` `代码` ``、链接……）在渲染态是**折叠**的，
     *    往标记内部放光标会被 `selection.js` 的 `legalFilter` 挪出来——那是**产品对的行为**。
     *    ⇒ 本场景要验的是"在正文中间敲一个字，只多那一个字"，⛔ 不是"产品接受任意偏移"；
     *    硬写 `正文起 + 1` 会在以 `**` 开头的那种列表项上假红（tasks.md 的有序项就是）。
     *    ⛔ 这里挑的只是**起点**，判据仍是"全文 = 基线在这一点插入 Z"，不读产品算法。
     */
    async function 可落点(host, 起, 止) {
      for (let p = 起; p < 止 && p - 起 < 24; p++) {
        if (!设光标(host, p)) continue;
        await frames(1);
        if (选区头(host) === p) return p;
      }
      return -1;
    }

    async function 场景行中(host, 基线, info) {
      if (选区头(host) === -1) return { 致命: '拿不到 EditorView' };
      const 行起号 = 行起(基线, info.行号);
      const 正文起 = 行起号 + info.前缀.length;
      const 行末 = 行起号 + String((基线.split('\n')[info.行号]) || '').length;
      const 目 = await 可落点(host, 正文起 + 1, 行末);
      if (目 < 0) return { 致命: '这一行正文里找不到能落光标的位置（' + 正文起 + '…' + 行末 + '）' };
      打字(输入(), 'Z');
      await frames(2);
      const 期 = 基线.slice(0, 目) + 'Z' + 基线.slice(目);
      const 实文 = 块全文(host);
      const 实光 = 选区头(host);
      const 全对 = 实文 === 期 && 实光 === 目 + 1 && 光标行(host) === info.行号;
      return {
        ok: 全对,
        说明: 全对
          ? ('在正文中间插入 `Z`（偏移 ' + 目 + '，正文起 ' + 正文起 + '），前后行一个字节都没动')
          : ('文对=' + (实文 === 期) + ' 光标 ' + 实光 + '/' + (目 + 1)
            + ' 行 ' + 光标行(host) + '/' + info.行号 + '；全文「' + 截(实文) + '」'),
      };
    }

    // ── 驱动：每种品种进一次块，五个场景各跑一遍，每场景之后 `⌘Z` 撤回基线 ──
    const 场景表 = [
      ['U1', '逐字键入', 场景逐字],
      ['U2', '回车续项', 场景回车续项],
      ['U3', '空项退列表', 场景空项退出],
      ['U4', '组合上屏', 场景组合],
      ['U5', '行中插入', 场景行中],
    ];
    const r0 = 计数('render_preview');
    const s0 = 计数('save_document');
    const 全文0 = 当前全文();
    for (let k = 0; k < 品种.length; k++) {
      const 种 = 品种[k];
      const info = 选[种];
      const h = await 进入块(info.块);
      if (!h) {
        记('U0-' + 种 + ' 进入含可测列表行的块', false, '等不到宿主；状态条：' + 状态条());
        continue;
      }
      const 基线 = 块全文(h);
      const 源 = 块源(info.块);
      const 基线对 = 基线 === 源;
      记('U0-' + 种 + ' 进入后视图正文 ≡ 块源码', 基线对,
        基线对 ? ('块 ' + info.块 + '，' + 基线.split('\n').length + ' 行') :
          ('实际「' + 截(基线) + '」≠ 源码「' + 截(源) + '」'));
      const 本种 = { 块: info.块, 行号: info.行号, 场景: [] };
      摘要.U.逐种[种] = 本种;
      if (!基线对) {
        键(输入(), 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
        continue;
      }
      let 撤不净 = '';
      for (let s = 0; s < 场景表.length; s++) {
        const r = await 场景表[s][2](h, 基线, info);
        const 判 = r && !r.致命 && r.ok === true;
        记(场景表[s][0] + '-' + 种 + ' ' + 场景表[s][1], 判,
          r && r.致命 ? r.致命 : (r && r.说明) || '没有产出');
        const 回 = await 撤回基线(h, 基线);
        本种.场景.push({ 场: 场景表[s][1], 红: !判, 撤: 回.次, 回: 回.回 });
        if (!回.回) {
          撤不净 = ('「' + 场景表[s][1] + '」之后撤了 ' + 回.次 + ' 次仍没回到基线：'
            + '「' + 截(块全文(h)) + '」');
          break;
        }
      }
      记('U6-' + 种 + ' 每个场景都能用 ⌘Z 逐字撤回基线', 撤不净 === '', 撤不净);
      // 退出：正文必须回到进入前 ⇒ 提交短路、⛔ 不写盘不重渲
      键(输入(), 'Escape');
      const 走 = await waitFor(function () { return !主机(); }, 4000);
      await frames(1);
      const 报文 = 全文0 === 当前全文();
      const 无提交 = 计数('render_preview') === r0 && 计数('save_document') === s0;
      const 几何回 = 几何相等(base, 几何());
      记('U7-' + 种 + ' 退出后会话正文未变（无提交、无重渲）',
         !!走 && 报文 && 无提交,
        '退出=' + !!走 + ' 正文未变=' + 报文
          + ' render_preview +' + (计数('render_preview') - r0)
          + ' save_document +' + (计数('save_document') - s0));
      记('U7b-' + 种 + ' 退出后几何回到基线', 几何回, 几何回 ? '' : '退出后几何没回到原样');
      if (!走) break;
    }
  }

  // ── K 段：**编辑边界的多输入序列**（2026-11-11 长任务：继续找编辑＋渲染的缺陷）────
  //
  // U 段钉的是"列表项上的常规序列"（行尾回车 / 空项退出 / 组合上屏 / 行中插入）。
  // 本段补的是**现有单测结构上够不着**的那一圈边界：单测只钉了纯函数在某一个偏移的
  //   返回值，而"回车/退格之后**光标落在哪**、下一步打字写到哪一行"要真视图才看得见。
  //
  // 每一条都对应一个**已登记或明确可推导**的期望：
  //   K1  标题行首回车 ⇒ 新行在标题**上方**，接着打的字进新行（`bugs/0105` 的语义：
  //       标记跟正文一起下移，⛔ 不许把 `##` 劈成行中的普通字符）。
  //   K1b 行内强调行首回车 ⇒ 同上（`bugs/0105` 的原场景；单测只钉了插入点 = 0）。
  //   K2  列表项行尾 `⌦` ⇒ 与下一项**合并成一个项**（下一项的标记被整条吃掉）。
  //       对照：下一行是正文时产品就是合并成 `- 甲乙`（`C3d` 的纯逻辑读数），⛔ 不许
  //       把 `- ` 留在行中当普通字符（隐藏标记不许在用户没打字时变成可见正文）。
  //   K3  引用内列表项行首 `⌫` ⇒ **只退一层**（删列表标记，`> ` 引用标记留下）。
  //   K4  引用内空列表项回车 ⇒ 退出列表但**留在引用里**（`> ` 不能一起被删）。
  //   K5a 续行行首回车 ⇒ ⛔ 不许留下**只有空白的行**（虚幻空行；`bugs/0300` 的续行族）。
  //   K6  九位有序编号回车 ⇒ **方案 B：编号到顶 fail-closed 到裸 `\n`**（`docs/bugs/0315` §5-B）：
  //       新行是普通正文段落，⛔ 不写任何十位编号（十位数字不是列表标记，阅读态会退化成正文）。
  //
  // ⚠️ 期望值全部来自**源码字面 + 设计语义**，⛔ 不拿产品函数反算期望（`bugs/0025`）。
  // ⚠️ 场景只在**真有那种形状的夹具**上跑；没有就记「不适用」，⛔ 不算通过。
  //   `edges.md` 专门造齐了这几条形状；覆盖闸门 `K-覆盖` 要求七条**都在某一份夹具上真跑过**。
  async function 跑边界序列(base, 摘要) {
    const p = window.__rmd && window.__rmd.payload;
    if (!p || !p.blocks) { 摘要.K = { 适用: false, 原因: '没有载荷' }; return; }
    const 节点 = 块节点();
    const 源缓存 = {};
    function 源(i) {
      if (!(i in 源缓存)) 源缓存[i] = 块源(i);
      return 源缓存[i];
    }
    /** 按源码形状找第一个可编辑块（⛔ 不读 `data-rmd-*`；只看源码字面）。 */
    function 找(判) {
      for (let i = 0; i < 节点.length && i < p.blocks.length; i++) {
        if (!p.blocks[i] || p.blocks[i][3] !== 1) continue;
        const s = 源(i);
        if (!s || s.split('\n').length > 40) continue;
        const 附 = 判(s);
        if (附) return { i: i, 源: s, 附: 附 };
      }
      return null;
    }

    const 结果 = {};
    const 观察 = {};
    摘要.K = { 适用: false, 场景: 结果, 观察: 观察 };

    /** 收尾：撤回基线 → `Esc` 退出（⛔ 带着脏文本进下一个场景）。 */
    async function 收尾(h, 基线) {
      const 回 = await 撤回基线(h, 基线);
      if (!回.回) {
        记('K0 场景收尾能撤回基线', false,
          '撤了 ' + 回.次 + ' 次仍没回到基线：「' + 截(块全文(h)) + '」');
      }
      键(输入() || document.body, 'Escape');
      await waitFor(function () { return !主机(); }, 4000);
      await frames(1);
    }

    /**
     * 跑一个场景。
     * @param {string} id 判据前缀（同时是覆盖闸门的键）
     * @param {string} 名
     * @param {function(string):(object|null)} 判 从源码认形状；返回偏移等附件
     * @param {function(object,string,object):Promise<{ok:boolean,说明:string}>} 体
     */
    async function 走(id, 名, 判, 体) {
      const 命 = 找(判);
      if (!命) { 结果[id] = { 适用: false, 原因: '这份夹具没有这种形状' }; return; }
      结果[id] = { 适用: true, 块: 命.i };
      const h = await 进入块(命.i);
      if (!h) {
        结果[id].致命 = '等不到宿主';
        记(id + ' ' + 名, false, '等不到宿主；状态条：' + 状态条());
        return;
      }
      const 基线 = 块全文(h);
      if (基线 !== 命.源) {
        结果[id].致命 = '进入后正文 ≠ 源码';
        记(id + ' ' + 名, false,
          '进入后正文「' + 截(基线) + '」≠ 源码「' + 截(命.源) + '」');
        await 收尾(h, 基线);
        return;
      }
      let r;
      try { r = await 体(h, 基线, 命); } catch (e) {
        r = { ok: false, 说明: '场景抛错：' + ((e && e.message) || e) };
      }
      记(id + ' ' + 名, !!(r && r.ok), (r && r.说明) || '没有产出');
      结果[id].ok = !!(r && r.ok);
      结果[id].说明 = (r && r.说明) || '';
      await 收尾(h, 基线);
    }

    /** 只记录、不判——给"期望本身还需要裁定的形态"留证据（⛔ 别当成通过）。 */
    async function 观(id, 判, 体) {
      const 命 = 找(判);
      if (!命) { 观察[id] = { 适用: false }; return; }
      const h = await 进入块(命.i);
      if (!h) { 观察[id] = { 适用: false, 原因: '等不到宿主' }; return; }
      const 基线 = 块全文(h);
      if (基线 !== 命.源) {
        观察[id] = { 适用: false, 原因: '进入后正文 ≠ 源码' };
        await 收尾(h, 基线);
        return;
      }
      let r;
      try { r = await 体(h, 基线, 命); } catch (e) {
        r = { 说明: '场景抛错：' + ((e && e.message) || e) };
      }
      观察[id] = Object.assign({ 适用: true, 块: 命.i }, r || {});
      await 收尾(h, 基线);
    }

    /** 行尾偏移（行内最后一个可见字节之后）。 */
    function 行末(文, 行号) {
      const L = String(文).split('\n')[行号] || '';
      return 行起(文, 行号) + L.length;
    }
    const 输入 = function () { return 输入框() || document.body; };
    /** 放光标并等一帧（产品的落点吸附可能异步回写）。 */
    async function 光标落(h, 偏移) {
      if (!设光标(h, 偏移)) return false;
      await frames(1);
      return 选区头(h) === 偏移;
    }

    // ── K1：标题行首回车，然后打一个字 ──────────────────────────────────────
    await 走('K1', '标题行首回车后打一个字：标题不被拆开', function (s) {
      const m = /^(#{1,6})([ \t]+)\S/.exec(s.split('\n')[0]);
      return m ? { 起: m[1].length + m[2].length } : null;
    }, async function (h, 基线, 命) {
      const 起 = 命.附.起;
      await frames(1);
      if (!await 光标落(h, 起)) {
        return { ok: false, 说明: '光标没落到标题正文起点（' + 选区头(h) + ' / ' + 起 + '）' };
      }
      键(输入(), 'Enter');
      await frames(3);
      const 期1 = '\n' + 基线;
      const 实1 = 块全文(h);
      const 光1 = 选区头(h);
      // ⚠️ 光标不对也**继续打字**：用户看到的是"打了一个字，标题没了"，只有把字打进去
      //    才能给出那条可见证据；⛔ 不在这里提前 return 把真正后果藏掉。
      打字(输入(), '新');
      await frames(2);
      const 期2 = '新' + 期1;
      const 实2 = 块全文(h);
      const 光2 = 选区头(h);
      const 行2 = 光标行(h);
      const 全对 = 实1 === 期1 && 光1 === 0 && 实2 === 期2 && 光2 === 1 && 行2 === 0;
      return {
        ok: 全对,
        说明: 全对
          ? ('新行在标题上方，`新` 落进新行（@1）')
          : ('回车后「' + 截(实1) + '」@' + 光1 + '（期望 @0）；再打 `新` ⇒ 「' + 截(实2)
            + '」@' + 光2 + ' 行 ' + 行2 + '（期望「' + 截(期2) + '」@1 行 0）'
            + '；`##` 被劈成行中普通字符 ⇒ 标题当场退化'),
      };
    });

    // ── K1b：行内强调行首回车，然后打一个字（`bugs/0105` 的原场景）─────────
    await 走('K1b', '强调行首回车后打一个字：`**` 不被劈开', function (s) {
      const m = /^\*\*([^*\n]+)\*\*/.exec(s.split('\n')[0]);
      return m ? { 起: 2 } : null;
    }, async function (h, 基线, 命) {
      const 起 = 命.附.起;
      await frames(1);
      if (!await 光标落(h, 起)) {
        return { ok: false, 说明: '光标没落到强调正文起点（' + 选区头(h) + ' / ' + 起 + '）' };
      }
      键(输入(), 'Enter');
      await frames(3);
      const 期1 = '\n' + 基线;
      const 实1 = 块全文(h);
      const 光1 = 选区头(h);
      打字(输入(), '新');
      await frames(2);
      const 期2 = '新' + 期1;
      const 实2 = 块全文(h);
      const 光2 = 选区头(h);
      const 全对 = 实1 === 期1 && 光1 === 0 && 实2 === 期2 && 光2 === 1 && 光标行(h) === 0;
      return {
        ok: 全对,
        说明: 全对
          ? '新行在强调上方，`新` 落进新行（@1）'
          : ('回车后「' + 截(实1) + '」@' + 光1 + '（期望 @0）；再打 `新` ⇒ 「' + 截(实2)
            + '」@' + 光2 + '（期望「' + 截(期2) + '」@1）；开场 `**` 被劈到行中'),
      };
    });

    // ── K2（**只记录**）：列表项行尾 `⌦` 与下一项合并 ─────────────────────
    //
    // ⚠️ 期望本身**还没有裁定**：`design/0061` L3 只说"折叠删除先跨过紧邻的隐藏区间
    //    再删一个可见字素"，光标与下一行 `- ` 之间隔着 `\n`（不是紧邻）⇒ 现行实现删
    //    换行、把 `- ` 留成普通字符，与这条规则**不矛盾**；而"把下一项的标记一起吃掉"
    //    依据的是行形语义（列表项是结构、不是字面），两条都说得通。
    //    参照产品（Mardo）在**删除边界**上的逐键行为也**未取证**（`research/products/0005`
    //    只写了 atoms 按不可分割单元删，⛔ 没写"跨行合并时标记跟不跟"）。
    // ⇒ 记证据、⛔ 不 gate：裁定归用户（`docs/bugs/0313` 的"观察"一栏与 `0314` 同批呈报）。
    await 观('相邻列表项行尾合并', function (s) {
      const 行 = s.split('\n');
      for (let k = 0; k + 1 < 行.length; k++) {
        const a = /^([-*+][ \t]+)(\S.*)$/.exec(行[k]);
        const b = /^([-*+][ \t]+)(\S.*)$/.exec(行[k + 1]);
        if (a && b) return { 行: k, 前缀2: b[1] };
      }
      return null;
    }, async function (h, 基线, 命) {
      const k = 命.附.行;
      const 位 = 行末(基线, k);
      await frames(1);
      if (!await 光标落(h, 位)) return { 说明: '光标没落到第一项行尾' };
      键(输入(), 'Delete');
      await frames(3);
      const 实 = 块全文(h);
      return {
        实测: 截(实),
        光标: 选区头(h),
        按行形合并的形态: 截(基线.slice(0, 位) + 基线.slice(位 + 1 + 命.附.前缀2.length)),
      };
    });

    // ── K3：引用内列表项行首 `⌫` 只退一层 ─────────────────────────────────
    await 走('K3', '引用内列表项行首 `⌫`：只删列表标记、引用标记留下', function (s) {
      const m = /^([ \t]*>[ \t]+)([-*+][ \t]+)(\S.*)$/.exec(s.split('\n')[0]);
      if (!m) return null;
      // ⚠️ **任务项不在本条的判据面里**（2026-11-11 实测）：`> - [x] 正文` 的"正文起点"
      //    在 `[x] ` **之后**（`- ` 与 `[x] ` 同属隐藏链，光标落不到两者之间），
      //    而本条假定起点是"引用前缀＋列表标记"之后 ⇒ 期望值 4 是个**非法落点**，
      //    产品把光标吸到 8 是**对的**，判红只会掩盖真正的缺陷。
      //    任务项在引用里的回车/退格归 `bugs/0111` A5 与 K4 族，⛔ 不在这里重复判。
      if (/^\[[ xX]\][ \t]/.test(m[3])) return null;
      return { 引用长: m[1].length, 列表长: m[2].length };
    }, async function (h, 基线, 命) {
      const 引 = 命.附.引用长;
      const 列 = 命.附.列表长;
      const 位 = 引 + 列;
      await frames(1);
      if (!await 光标落(h, 位)) {
        return { ok: false, 说明: '光标没落到列表项正文起点（' + 选区头(h) + ' / ' + 位 + '）' };
      }
      const 期 = 基线.slice(0, 引) + 基线.slice(位);
      键(输入(), 'Backspace');
      await frames(3);
      const 实 = 块全文(h);
      const 光 = 选区头(h);
      const 全对 = 实 === 期 && 光 === 引;
      return {
        ok: 全对,
        说明: 全对
          ? ('只删列表标记 ⇒ 「' + 截(期) + '」@' + 引)
          : ('期望「' + 截(期) + '」@' + 引 + '，实际「' + 截(实) + '」@' + 光
            + '（一次退格把引用层也删了）'),
      };
    });

    // ── K4：引用内空列表项回车，退出列表但留在引用里 ──────────────────────
    await 走('K4', '引用内空列表项回车：退列表、留在引用里', function (s) {
      const 行 = s.split('\n');
      for (let k = 0; k < 行.length; k++) {
        const m = /^([ \t]*>[ \t]+)([-*+][ \t]*)$/.exec(行[k]);
        if (m) return { 行: k, 引用: m[1] };
      }
      return null;
    }, async function (h, 基线, 命) {
      const k = 命.附.行;
      const 引用 = 命.附.引用;
      const 起 = 行起(基线, k);
      const L = 基线.split('\n')[k];
      const 位 = 起 + L.length;
      await frames(1);
      if (!await 光标落(h, 位)) {
        return { ok: false, 说明: '光标没落到空项行尾（' + 选区头(h) + ' / ' + 位 + '）' };
      }
      const 期1 = 基线.slice(0, 起 + 引用.length) + 基线.slice(起 + L.length);
      键(输入(), 'Enter');
      await frames(3);
      const 实1 = 块全文(h);
      const 光1 = 选区头(h);
      if (实1 !== 期1 || 光1 !== 起 + 引用.length) {
        return {
          ok: false,
          说明: '回车后：期望「' + 截(期1) + '」@' + (起 + 引用.length)
            + '，实际「' + 截(实1) + '」@' + 光1 + '（引用标记 `' + 引用 + '` 被一起删了）',
        };
      }
      打字(输入(), '续');
      await frames(2);
      const 期2 = 期1.slice(0, 起 + 引用.length) + '续' + 期1.slice(起 + 引用.length);
      const 实2 = 块全文(h);
      const 光2 = 选区头(h);
      const 全对 = 实2 === 期2 && 光2 === 起 + 引用.length + 1;
      return {
        ok: 全对,
        说明: 全对
          ? ('退出列表后仍在引用里，`续` 落在「' + 截(期2) + '」')
          : ('续写期望「' + 截(期2) + '」@' + (起 + 引用.length + 1)
            + '，实际「' + 截(实2) + '」@' + 光2),
      };
    });

    // ── K5a：续行行首回车不留"只有空白的行" ───────────────────────────────
    await 走('K5a', '续行行首回车：⛔ 不留只有空白的幻行', function (s) {
      const 行 = s.split('\n');
      for (let k = 0; k + 1 < 行.length; k++) {
        const a = /^([-*+][ \t]+(?:\[[ xX]\][ \t]+)?)\S/.exec(行[k])
          || /^(\d{1,9}[.)][ \t]+)\S/.exec(行[k]);
        if (!a) continue;
        const c = /^([ \t]+)(\S.*)$/.exec(行[k + 1]);
        if (!c) continue;
        // 下一行是**另一个列表项**（含空项 `-`）⇒ 不是续行
        if (/^([-*+]([ \t]|$)|\d{1,9}[.)]([ \t]|$))/.test(c[2])) continue;
        return { 行: k, 缩进: c[1], 文: c[2] };
      }
      return null;
    }, async function (h, 基线, 命) {
      const k = 命.附.行;
      const 缩进 = 命.附.缩进;
      const 位 = 行起(基线, k + 1) + 缩进.length;
      await frames(1);
      if (!await 光标落(h, 位)) {
        return { ok: false, 说明: '光标没落到续行正文起点（' + 选区头(h) + ' / ' + 位 + '）' };
      }
      键(输入(), 'Enter');
      await frames(3);
      const 实 = 块全文(h);
      const 幻 = String(实).split('\n')
        .map(function (l, i) { return { i: i, 白: /^[ \t]+$/.test(l) }; })
        .filter(function (x) { return x.白; });
      const 无幻 = 幻.length === 0;
      // ⭐ 续行正文必须**原样留在原来的缩进下**（`bugs/0314`）：行首回车只该把它下移，
      //     ⛔ 不该把它提成同级列表项、也不该改动它的缩进。
      const 续行在 = String(实).split('\n').some(function (l) {
        return l.slice(0, 缩进.length) === 缩进 && l.slice(缩进.length) === 命.附.文;
      });
      const 全对 = 无幻 && 续行在;
      return {
        ok: 全对,
        说明: 全对
          ? ('回车后没有空白行（' + String(实).split('\n').length + ' 行），续行仍在原缩进下')
          : (!无幻 && ('第 ' + (幻[0].i + 1) + ' 行只剩空白 ⇒ 屏幕上多一条空行；')
            ) + (续行在 ? '' : '续行正文「' + 命.附.文 + '」不再位于「' + 缩进 + '」之后（被提成列表项？）；')
            + '全文「' + 截(实) + '」',
      };
    });

    // ── K6：九位有序编号回车，编号到顶 fail-closed 到裸 `\n` ────────────────
    //
    // 用户裁定方案 B（`docs/bugs/0315` §5-B）：`999999999.` 已是 CommonMark 允许的上界，
    // 回车按"退出列表"处理、只插裸换行，⛔ 不写十位编号 ⇒ 新行两态一致都是正文段落。
    await 走('K6', '九位有序编号回车：编号到顶 fail-closed 到裸换行（⛔ 不写十位编号）', function (s) {
      const m = /^(\d{9})([.)][ \t]+)\S/.exec(s.split('\n')[0]);
      return m ? { 位: m[1].length + m[2].length, 号: m[1], 标: m[2] } : null;
    }, async function (h, 基线, 命) {
      const 位 = 行末(基线, 0);
      await frames(1);
      if (!await 光标落(h, 位)) {
        return { ok: false, 说明: '光标没落到行尾（' + 选区头(h) + ' / ' + 位 + '）' };
      }
      // 方案 B：末尾只留**裸换行**（⛔ 任何编号前缀都不写），光标停在换行之后。
      const 期 = 基线 + '\n';
      键(输入(), 'Enter');
      await frames(3);
      const 实 = 块全文(h);
      const 光 = 选区头(h);
      const 全对 = 实 === 期 && 光 === 期.length;
      return {
        ok: 全对,
        说明: 全对
          ? ('编号到顶（' + 命.附.号 + '）⇒ 裸 `\\n` 后的正文段落 @' + 期.length
            + '（⛔ 没写十位编号）')
          : ('期望「' + 截(期) + '」@' + 期.length + '，实际「' + 截(实) + '」@' + 光
            + '（方案 B：裸 `\\n`，⛔ 不写十位编号）'),
      };
    });

    // ── K7：引用段落行尾回车，新行留在引用里（`bugs/0111` A1）──────────────
    //
    // ⚠️ 引用段落**不是列表行** ⇒ `lineBreakAction` 只认 `plan.listLines`，退回裸 `\n`
    //    （`input.js:440-444`）。`bugs/0108`/`0110` 确立的契约是"回车按**行前缀**续行"，
    //    而 `> ` 这个前缀根本没进数据层 ⇒ 新行落到引用外，接着打的字不在引用里。
    //    判据依据：`bugs/0111` A1（已判缺陷，Mardo `linePrefix` 含 `> `）。
    await 走('K7', '引用段落行尾回车：新行仍带 `> `', function (s) {
      const m = /^([ \t]*>[ \t]+)(?![-*+][ \t]|\d{1,9}[.)][ \t])\S/.exec(s.split('\n')[0]);
      return m ? { 引用: m[1] } : null;
    }, async function (h, 基线, 命) {
      const 引用 = 命.附.引用;
      const 位 = 行末(基线, 0);
      await frames(1);
      if (!await 光标落(h, 位)) {
        return { ok: false, 说明: '光标没落到引用段落行尾（' + 选区头(h) + ' / ' + 位 + '）' };
      }
      // ⚠️ 2026-11-12：期望**在光标处插入**，⛔ 不是"追加到块末"。引用块里第 0 行之后
      //    通常还有别的行（`edges.md` 的引用段落不止一行）⇒ 旧写法 `基线 + '\n' + 引用`
      //    判的是"整个块被追加"，把正确的新行判红、把"删掉后文"判绿。
      const 期文 = 基线.slice(0, 位) + '\n' + 引用 + 基线.slice(位);
      const 期光 = 位 + 1 + 引用.length;
      键(输入(), 'Enter');
      await frames(3);
      const 实 = 块全文(h);
      const 光 = 选区头(h);
      const 全对 = 实 === 期文 && 光 === 期光;
      return {
        ok: 全对,
        说明: 全对
          ? ('新行仍在引用里：「' + 截(期文) + '」@' + 期光)
          : ('期望「' + 截(期文) + '」@' + 期光 + '，实际「' + 截(实) + '」@' + 光
            + '（新行没有 `' + 引用 + '` 或光标没落到新行正文起点）'),
      };
    });

    // ── 只记录、不判的形态（期望本身还要用户裁定，⛔ 不冒充通过）───────────
    await 观('空标题行合并', function (s) {
      const 行 = s.split('\n');
      for (let k = 0; k + 1 < 行.length; k++) {
        if (/^#{1,6}[ \t]*$/.test(行[k])) return { 行: k };
      }
      return null;
    }, async function (h, 基线, 命) {
      const k = 命.附.行;
      const 位 = 行末(基线, k);
      await frames(1);
      if (!await 光标落(h, 位)) return { 说明: '光标没落到空标题行尾' };
      键(输入(), 'Delete');
      await frames(3);
      return { 实测: 截(块全文(h)), 光标: 选区头(h) };
    });

    await 观('链接选区删除', function (s) {
      const m = /\[([^\]\n]+)\]\(([^)\n]+)\)/.exec(s.split('\n')[0]);
      return m ? { 起: m.index, 长: m[0].length, 行末: s.split('\n')[0].length } : null;
    }, async function (h, 基线, 命) {
      const V = 视图(h);
      if (!V) return { 说明: '拿不到 EditorView' };
      const 头 = 命.附.起;
      const 长 = 命.附.长;
      const 尾 = 头 + 长;
      // 四种选区：只选可见文字 / 从可见文字选到行尾（越过隐藏的 `)` 直到 `后`）/
      // 连开括号一起选 / 只选链接正文。⛔ 不判红——"该删成什么样"没有用户裁定。
      const 段 = [
        { 名: '可见文字→闭合括号', a: 头 + 1, b: 尾 - 1 },
        { 名: '可见文字→行尾', a: 头 + 1, b: 命.附.行末 },
        { 名: '整条链接（含开括号）', a: 头, b: 尾 },
        { 名: '只选链接文字', a: 头 + 1, b: 头 + 2 },
      ];
      const 明细 = [];
      for (const g of 段) {
        V.dispatch({ selection: { anchor: g.a, head: g.b } });
        await frames(1);
        键(输入(), 'Backspace');
        await frames(3);
        明细.push({ 段: g.名, 选区: [g.a, g.b], 实测: 截(块全文(h)) });
        const 回 = await 撤回基线(h, 基线);
        if (!回.回) { 明细.push({ 段: g.名, 撤回: false }); break; }
      }
      return { 明细: 明细 };
    });

    await 观('空嵌套项带子项', function (s) {
      const 行 = s.split('\n');
      for (let k = 0; k + 1 < 行.length; k++) {
        const m = /^([ \t]+)[-*+][ \t]*$/.exec(行[k]);
        if (!m) continue;
        const n = /^([ \t]+)[-*+][ \t]+\S/.exec(行[k + 1]);
        if (n && n[1].length > m[1].length) return { 行: k };
      }
      return null;
    }, async function (h, 基线, 命) {
      const k = 命.附.行;
      const 位 = 行末(基线, k);
      await frames(1);
      if (!await 光标落(h, 位)) return { 说明: '光标没落到空嵌套项行尾' };
      键(输入(), 'Enter');
      await frames(3);
      return { 实测: 截(块全文(h)), 光标: 选区头(h) };
    });

    摘要.K.适用 = Object.keys(结果).some(function (k) { return 结果[k].适用; });
    if (!摘要.K.适用) 摘要.K.原因 = '这份夹具没有 K 段需要的形状';
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
    // ⚠️ 块下标对 `块节点()`（元素 ＋ 注释），⛔ 不是 `d.children`（`bugs/0080`）：
    //    后者会把 HTML 块之后的可编辑块整体漏掉，判据于是"没跑"而不是"通过"。
    const 数 = 块节点().length;
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
      点(块节点()[i]);
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
    const 改后数 = 块节点().length;
    const 旧host = 主机();
    点(块节点()[第二]); // 这一下内部会先提交并重渲
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
    记('P6 提交重渲之后没有多余节点', 块节点().length === 数,
      '孩子数 ' + 数 + ' → ' + 块节点().length
      + (改后数 !== 数 ? '（敲字那一步就已经变了 ' + 改后数 + '）' : '')
      + (块节点().length === 数 ? '' : '——多出来的就是"旧块节点被追加到文末"'));
    // ⭐ 进去的必须是**被点的那一块**（不是第一块的残留、不是文末那份）。
    //    `#doc` 的孩子与 `p.blocks` 是 1:1 的（见 `诊断()` 的取法），所以直接比身份就够了。
    //    ⚠️ 这条在"节点过期"那一面是 P5 的补充：P5 只问"进不进得去"，
    //    过期节点也可能进得去（几何闸门碰巧放行），但进去的会是**错的那一块**。
    记('P7 进去的是被点的那一块', !!h2 && 块节点()[第二] === h2,
      '孩子[' + 第二 + '] ' + (块节点()[第二] === h2 ? '就是宿主' : '≠ 宿主')
      + '；宿主实际下标 ' + 块节点().indexOf(h2)
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
      + '；孩子[' + 第二 + '] 的 class = "' + String((块节点()[第二] && 块节点()[第二].className) || '') + '"'
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
  // ⭐ **夹具可以声明"这张表不归 Q 段"**：正文里出现 `Q 段不适用` 这几个字即视为声明
  //    （目前只有 `fixtures/wraptasks.md`：它那张 2×2 表只是脚注引用的落脚点，
  //    见该文件第 17 行那段说明）。记 `适用:false` ⇒ 与"这份没有表格"同一档，
  //    ⛔ 不是记通过；`blocks.md`／`tasks.md` 照样覆盖 `Q-覆盖`。
  //    ⚠️ 不加这个开关的后果是实测过的：`Q26`–`Q34` 一片"夹具形状不支持"的红落进**基线**。
  async function 跑单元格(base, 摘要) {
    const d = docEl();
    const p = window.__rmd.payload;
    const 原 = String((window.__FIXTURE || {}).text || '');

    if (原.indexOf('Q 段不适用') >= 0) { 摘要.Q = { 适用: false, 原因: '夹具声明' }; return; }

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
      const t = 块节点()[表];
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
    /**
     * `el` 里**最后一个字形**的右边界（`Range.getClientRects()` 量，⛔ 不靠估计）。
     * ⚠️ 只在"文字是纯文本"的场景用（表格单元格）；正文块里有隐藏的 Markdown 标记，⛔ 别拿它当行宽。
     * @returns {{right:number, top:number, bottom:number}|null}
     */
    function 文本右界(el) {
      if (!el) return null;
      const 走 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let last = null;
      while (走.nextNode()) { if (走.currentNode.length) last = 走.currentNode; }
      if (!last) return null;
      const rg = document.createRange();
      rg.setStart(last, last.length - 1);
      rg.setEnd(last, last.length);
      const rs = rg.getClientRects();
      if (!rs.length) return null;
      return { right: rs[rs.length - 1].right, top: rs[0].top, bottom: rs[0].bottom };
    }
    /**
     * 表格的**外盒**：编辑期间产品会套一层 `.rmd-table-freeze` 临时外壳接住横向滚动
     * （`bugs/0297`）——12 px 的经典滚动条在**外壳**上，不在表格上 ⇒ 量高度必须量外壳，
     * 否则修好之后这一条反而每次都 −12。
     */
    function 表外盒() {
      const t = 块节点()[表];
      const par = t && t.parentNode;
      return par && par.classList && par.classList.contains('rmd-table-freeze') ? par : t;
    }
    function 表高() { return 四舍(表外盒().getBoundingClientRect().height); }
    /**
     * 表格**横向滚动条的厚度**（`offsetHeight − clientHeight`，经典滚动条占布局位）。
     *
     * ⭐ 为什么单立一条量：`bugs/0027` 的 12 px **不是内容变高**，是 WebKit 给滚动容器
     *    分配了一条经典横向滚动条（`style.css` 的 `::-webkit-scrollbar { height: 12px }`）。
     *    量高度会被"内容本身变了"污染（`bugs/0299`：这一格的内容在 `Q14`/`Q15` 里被改过），
     *    量滚动条厚度则与内容无关 ⇒ 进入前后**差 0** 才是干净的判据。
     * ⚠️ 外壳与表格都可能持有滚动条（阅读态在 `table` 上，编辑期在 `.rmd-table-freeze`
     *    外壳上，见 `表外盒()`）⇒ 一律量**当前持有溢出的那个盒子**。
     */
    function 滚动条厚() {
      const b = 表外盒();
      return b ? Math.max(0, b.offsetHeight - b.clientHeight) : 0;
    }
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
        + ' / 格 line-height=' + window.getComputedStyle(格0[0]).lineHeight
        // ⭐ `bugs/0316` 的前置取证：`.cm-rmd-cell` 在 `live.css` 里声明了 `white-space: pre-wrap`，
        //    但 CM6 的 `lineWrapping()` 把 `break-spaces` 写在 `.cm-content` 的**内联 style** 上。
        //    这一格打出 `.cm-line` 的**计算值**，用来回答"类规则到底有没有压过内联样式"
        //    ⇒ 决定"改 `white-space` 这条路在产品里是否走得通"。⛔ 只读，不改 DOM。
        + ' 白空=' + String((function () {
          const ln = h1.querySelector && h1.querySelector('.cm-line');
          return ln ? window.getComputedStyle(ln).whiteSpace : '(无 .cm-line)';
        })())
        + ' 宿主白空=' + String(宿主样式.whiteSpace)
        + ' 内联白空=' + String(((h1.querySelector && h1.querySelector('.cm-content') || {}).style || {}).whiteSpace || '(无)'));

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
    // ⭐ `bugs/0297` 之后：编辑期间滚动条挪到了 `.rmd-table-freeze` 外壳上、表格改成
    //    `display: table` ⇒ 表格自己 `offsetH` 不再含 12 px，**外壳含**。两边的数都打出来。
    const 表盒 = 块节点()[表];
    const 外盒 = 表外盒();
    // ⚠️ 这行诊断把「高度差」拆成两件事：`clientH`（内容高度）与 `offsetH`（边框盒，
    //    含横向滚动条）。二者差 12 px ＝ `style.css` 那条全局 `::-webkit-scrollbar { height: 12px }`
    //    被分配给了滚动容器——`bugs/0027` 就是它，`bugs/0297` 之后容器是临时外壳。
    //    ⛔ 不要在这里**改 DOM 再量**（比如临时 `display:none` 二分子树）：那会强制重排，
    //    把"滞留的滚动条"清掉，量出来的就不是用户看到的那一帧了（2026-10-28 踩过）。
    const 表诊断 = (外盒 !== 表盒
      ? ' 外壳 clientW ' + 外盒.clientWidth + ' scrollW ' + 外盒.scrollWidth
        + ' clientH ' + 外盒.clientHeight + ' offsetH ' + 外盒.offsetHeight
        + ' overflowX ' + window.getComputedStyle(外盒).overflowX
      : '')
      + ' table clientW ' + 表盒.clientWidth + ' scrollW ' + 表盒.scrollWidth
      + ' clientH ' + 表盒.clientHeight + ' offsetH ' + 表盒.offsetHeight
      + ' display ' + window.getComputedStyle(表盒).display
      + ' overflowX ' + window.getComputedStyle(表盒).overflowX
      + ' box-sizing ' + window.getComputedStyle(表盒).boxSizing
      + ' style.width "' + 表盒.style.width + '"'
      + ' 宿主 overflow ' + 宿主样式.overflowX + '/' + 宿主样式.overflowY;
    记('Q2b 进入后表格高度不变', Math.abs(高1 - 高0) <= 1,
      'ΔH ' + 四舍(高1 - 高0) + ' px（前 ' + 高0 + ' / 后 ' + 高1 + '）' + 表诊断);
    const 下游1 = 下游最大位移(下游0, 几何(), 表 + 1);
    记('Q2c 表格之后的块零位移', 下游1 <= TOL, '最大 ' + 四舍(下游1) + ' px');
    // ⭐ `bugs/0297`：只判 `table-layout: fixed` 是不够的——`.doc table` 是 `display:block`，
    //    真正排版的匿名内表**不继承** `table-layout` ⇒ 第一版就是"判据全绿、屏幕照跳"。
    //    产品修法把表格改成 `display: table` 并套临时外壳 ⇒ 两条一起判。
    记('Q2d 列宽真的被冻结了（`display: table` ＋ `table-layout: fixed`）',
      String(表盒.style.tableLayout) === 'fixed' && String(表盒.style.display) === 'table',
      'table.style.tableLayout = "' + String(表盒.style.tableLayout) + '"'
        + ' / display = "' + String(表盒.style.display) + '"');

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
    记('Q4b 组合串出现在格子里（行内 widget）', !!pre && (pre.textContent || '').indexOf('nih') >= 0,
      pre ? ('组合串文本「' + (pre.textContent || '').slice(0, 16) + '」') : '没有 .cm-rmd-preedit');
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
        // ⚠️⚠️ **这条判据红了四天没人能定位**（2026-10-30 → 11-03，`bugs/0047` §9
        //    「未定位是 oracle 量窄了还是 `.cm-rmd-cell` 真的比 `<td>` 内容盒宽 1 px」）：
        //    差别只有 **1 px**，而"oracle 少减了一层盒模型"与"产品真的宽 1 px"
        //    在旧的说明串里**输出完全一样**（两个宽度都只是结果，不是来源）。
        //    ⇒ 把**两边各自的盒模型**打出来：格盒的 border/padding、编辑宿主与
        //    `.cm-line` 的真实左右沿。谁跟谁对不上，一眼能看出来。
        const 格述 = (function () {
          if (!格盒) return '格盒缺失';
          const cs = getComputedStyle(格盒);
          const r = 格盒.getBoundingClientRect();
          const 边 = ['borderLeftWidth', 'borderRightWidth', 'paddingLeft', 'paddingRight']
            .map(function (k) { return k.replace('Width', '') + ' ' + (parseFloat(cs[k]) || 0); });
          return '格盒 ' + 四舍(r.left) + '…' + 四舍(r.right) + '（宽 ' + 四舍(r.width)
            + '；' + 边.join('/') + '）';
        })();
        const 宿主述 = (function () {
          if (!t.host) return '宿主缺失';
          const r = t.host.getBoundingClientRect();
          const ln = t.host.querySelector('.cm-line');
          const lr = ln ? ln.getBoundingClientRect() : null;
          return '宿主 ' + 四舍(r.left) + '…' + 四舍(r.right)
            + (lr ? '；.cm-line ' + 四舍(lr.left) + '…' + 四舍(lr.right) : '；⛔ 没有 .cm-line');
        })();
        记('Q14b 粘贴两行：视图里**两行都在**，且高度 == 同一串字在阅读态的高度'
          + '（⛔ 不是折成一行、也不是先排出两行再缩回）',
          视文 === 应视 && 应高 > 0 && Math.abs(编高 - 应高) <= 1,
          '内容高 编辑 ' + 四舍(编高) + ' / 阅读形态 ' + 四舍(应高) + ' px'
            + '（宽 编辑 ' + 四舍(t.host.getBoundingClientRect().width)
            + ' / 阅读 ' + 四舍(量.宽) + '，格 ' + 四舍(量.格宽) + '）'
            + '；' + 格述 + '；' + 宿主述
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
        // ⚠️⚠️ **光标必须先到「全文末」，⛔ 不能只按 `End`**（2026-11-02）。
        //    格内自 `bugs/0035` 起可以有多行 ⇒ `End` 只到**当前这一视觉行**的行末，
        //    而 `进格()` 是点在格子中心：两行的格里落第 1 行还是第 2 行取决于格高，
        //    于是这条判据量到的会变成"点在了哪儿"，⛔ 不是"区间跟不跟内容走"。
        //    实测（2026-11-02）：上一轮的 `Q14b` 把这一格留成两行，`End` 停在第 1 行末
        //    ⇒ 得到「列二甲甲乙丙<br>乙」/ 期望「列二甲<br>乙甲乙丙」，看着像产品写重，其实是探针插错了位置。
        //    走 CM6 的 `dispatch` 而不是再合成一个键：不依赖产品 keymap 里装没装 `Mod-ArrowDown`。
        const v = 视图(t.host);
        if (v && v.state && v.state.doc) v.dispatch({ selection: { anchor: v.state.doc.length } });
        else 键(t.ta, 'End');
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
        // ⚠️ `进格` 可能拿到**已经被摘掉的旧宿主**（上一次退出没摘干净 / 视图被 swap 过）：
        //    它的 `parentElement` 是 `null`，继续量会抛异常 ⇒ 整份夹具的判据全丢。
        //    ⛔ 不静默跳过：记一条失败，并放弃本段（后面的 Q20b 都依赖同一个宿主）。
        if (!格盒) {
          记('Q20 长内容在格子里软换行、光标看得见', false,
            '宿主没有父节点（进格拿到的是已摘掉的旧宿主；上一次退出可能没走干净）');
          return;
        }
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

    // ── `Q37` 方向键跨格（`bugs/0104`，2026-11-06 用户复报 ↓ 仍不跨）────────
    //  ⚠️ 判据读**宿主真的换到了哪个单元格**（`td/th` 的 `rowIndex`/`cellIndex`），
    //     ⛔ 不看状态条、也不看光标偏移——那两样在"没跨"和"跨了但落点一样"时长得相同。
    //  ⚠️ 这一段的表格来自夹具 `blocks.md`（3 列 × 表头＋2 行）。
    {
      const t = await 进格(0);
      if (!t) {
        记('Q37 末视觉行按 ↓ ⇒ 进下一行同一列', false, '进不去：' + 状态条());
      } else {
        const td0 = t.host.closest('td,th');
        const tr0 = td0 ? td0.parentElement : null;
        const r0 = tr0 && typeof tr0.rowIndex === 'number' ? tr0.rowIndex : -1;
        const c0 = td0 && typeof td0.cellIndex === 'number' ? td0.cellIndex : -1;
        const V = 视图(t.host);
        const 状态前 = 状态条();
        const 抛前 = (window.__THREW || []).length;
        // ⚠️ `file://` 下 `window.onerror` 只给 `Script error.`（跨源），但**本页自己注册的**
        //    `unhandledrejection` 拿得到真实 `reason` ⇒ 用它把"为什么跨不过去"钉出来。
        let 捕 = '';
        const 捕rej = function (e) {
          const r = e && e.reason;
          捕 += '[rejection] ' + String((r && (r.stack || r.message)) || r).slice(0, 200) + '\n';
        };
        const 捕err = function (e) {
          捕 += '[error] ' + String((e && (e.message || e.error)) || e).slice(0, 200) + '\n';
        };
        window.addEventListener('unhandledrejection', 捕rej);
        window.addEventListener('error', 捕err);
        const 活 = window.rmd && window.rmd.liveController;
        const 读格 = function () {
          try {
            const a = 活 && typeof 活.activeCell === 'function' ? 活.activeCell() : null;
            return a ? ('flat=' + a.flat + ' block=' + a.blockIndex) : '不在格';
          } catch (e) { return 'activeCell 抛：' + String((e && e.message) || e); }
        };
        const 格前 = 读格();
        键(t.ta, 'End');
        await frames(1);
        const 头0 = V ? V.state.selection.main.head : -1;
        const 行数0 = V ? V.state.doc.lines : -1;
        键(t.ta, 'ArrowDown');
        await frames(4);
        window.removeEventListener('unhandledrejection', 捕rej);
        window.removeEventListener('error', 捕err);
        const host1 = 单元格宿主();
        const td1 = host1 ? host1.closest('td,th') : null;
        const tr1 = td1 ? td1.parentElement : null;
        const r1 = tr1 && typeof tr1.rowIndex === 'number' ? tr1.rowIndex : -1;
        const c1 = td1 && typeof td1.cellIndex === 'number' ? td1.cellIndex : -1;
        const 抛 = (window.__THREW || []).slice(抛前).map(function (x) {
          return (x.名 || '?') + ': ' + (x.消息 || '') + ' @ ' + String(x.栈 || '').slice(0, 120);
        }).join(' ; ');
        const 诊断 = '进入 (' + r0 + ',' + c0 + ') ' + 格前 + ' 文本行数 ' + 行数0 + ' End→' + 头0
          + '；按 ↓ 后 (' + r1 + ',' + c1 + ') ' + 读格() + '，状态条「' + 状态条() + '」'
          + (状态前 !== 状态条() ? '（按前「' + 状态前 + '」）' : '')
          + (捕 ? '，捕获：' + 捕 : '，未捕获异常')
          + (抛 ? '，__THREW：' + 抛 : '')
          + (window.__DBG_KEY ? '，DBG：' + String(window.__DBG_KEY).slice(0, 300) : '');
        记('Q37 末视觉行按 ↓ ⇒ 进下一行同一列（Mardo 行为）',
          !!host1 && r1 === r0 + 1 && c1 === c0, 诊断);
        键(t.ta, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
      }
    }

    // ── `Q38`–`Q40` 方向键跨格的另外一个方向（`bugs/0104`，2026-11-06）────────
    //  ⚠️ 与 `Q37`（↓）同一条口径：判据只看**宿主换到了哪个单元格**
    //     （`td/th` 的 `rowIndex`/`cellIndex`），⛔ 不看状态条、也不看光标偏移——
    //     "没跨"与"跨了但落点相同"在这两样上长得一模一样。
    //  ⚠️ 每条都是**真按键**：进格 → `Home`/`End` 把光标送到格内文本首/末（`↑` 送到
    //     首视觉行）→ 再按一次方向键。产品的跨格分支（`main.js::crossCellHorizontal` /
    //     `crossCellVertical`）只在"这一下没走动"时触发 ⇒ 预备键没到位时判据必须
    //     **红**并写明 head 在哪，⛔ 不许静默跳过（那会把"没跑"读成"通过"）。
    //  ⭐ 负对照：`Q22`（格内 ↑/↓ 走视觉行）。跨格判据红而 `Q22` **也**红 ⇒ 是
    //     **格内移动**坏了（根本没走到首/末视觉行），⛔ 不是跨格方向错了；两者必须能分开读。
    //  ⚠️ 变异覆盖：现有变异里**没有一条**打 `crossCellHorizontal`（←/→ 的 delta），
    //     所以 `Q38`/`Q39` 暂时**没有专属变异**；要钉它们得另造"delta 取反"一条。
    //     `Q37`（↓）由 `M43` 承重（它把 `crossCellVertical(view, cmd === 'lineDown')`
    //     的参数钉成 `false`：↓ 传成 ↑ 的语义）。`Q40`（↑）在 `M43` 下**依旧落在上一行**
    //     ⇒ 仍绿、不承重；它只会在 `M26`（关掉整段视觉行分支）下连带变红，而 `M26` 的
    //     断言目标是 `Q22`，⛔ 不能把那条算成 `Q40` 的专属证据。
    //     ⛔ 本次不新增跑不动的变异段。
    /**
     * 一条跨格真按键探针。
     * @param {string} id 判据编号（`Q38`/`Q39`/`Q40`）
     * @param {string} 标题 判据名
     * @param {[number, number]} 起格 进入的单元格 `[rowIndex, cellIndex]`
     * @param {'Home'|'End'} 预备键 把光标送到跨格边界的那一下
     * @param {'start'|'end'|'firstLine'} 边界 预备键之后光标应处的边界
     * @param {string} 方向键 `ArrowLeft`/`ArrowRight`/`ArrowUp`
     * @param {[number, number]} 应格 跨格之后宿主应落的单元格
     */
    async function 跨格探针(id, 标题, 起格, 预备键, 边界, 方向键, 应格) {
      // ⚠️ 先清掉上一条留下的活动格：`Q37` 跨格之后按的是**已经销毁**的旧输入框
      //    （`onKeyDown` 的 `destroyed` 守卫会直接 return）⇒ 它那句 `Escape` 不生效。
      //    不先关掉的话，下面 `进格` 的 `waitFor(单元格宿主)` 会立刻拿到**旧**宿主
      //    （新格是点击之后异步建的）⇒ 读成"进格落错了格"，那是探针状态，⛔ 不是产品。
      if (主机()) {
        const 旧 = 输入框();
        if (旧) 键(旧, 'Escape');
        const 关了 = await waitFor(function () { return !主机(); }, 4000);
        if (!关了) {
          记(id + ' ' + 标题, false,
            '清不掉上一条留下的活动格（对当前输入框按 Escape 没生效）；'
              + '未跑本判据，状态条「' + 状态条() + '」');
          return;
        }
        await frames(1);
      }
      const g = 格();
      let flat = -1;
      for (let i = 0; i < g.length; i++) {
        const td = g[i];
        const tr = td && td.parentElement;
        if (tr && tr.rowIndex === 起格[0] && td.cellIndex === 起格[1]) { flat = i; break; }
      }
      if (flat < 0) {
        记(id + ' ' + 标题, false,
          '夹具里没有 (' + 起格[0] + ',' + 起格[1] + ') 格：这条判据至少要求 2 列 × 2 行；'
            + '状态条「' + 状态条() + '」');
        return;
      }
      const t = await 进格(flat);
      if (!t) {
        记(id + ' ' + 标题, false,
          '进不去 (' + 起格[0] + ',' + 起格[1] + ')：' + 状态条());
        return;
      }
      const td0 = t.host.closest('td,th');
      const tr0 = td0 ? td0.parentElement : null;
      const r0 = tr0 && typeof tr0.rowIndex === 'number' ? tr0.rowIndex : -1;
      const c0 = td0 && typeof td0.cellIndex === 'number' ? td0.cellIndex : -1;
      const V = 视图(t.host);
      const 诊断头 = '进格成功 (' + r0 + ',' + c0 + ')，期望 (' + 起格[0] + ',' + 起格[1] + ')';
      /** 收尾：`Escape` 并等宿主消失（与 `Q37` 同一顺序）。
       *  ⚠️ 跨格之后旧 `t.ta` 已经随旧视图销毁（它的 `keydown` 监听里有 `destroyed` 守卫），
       *     所以这里取**当前**那个输入框；⛔ 别对着已销毁的那份按。 */
      const 收尾 = async function () {
        键(输入框() || t.ta, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
      };
      if (!V) {
        记(id + ' ' + 标题, false, 诊断头 + '；进格后读不到视图，状态条「' + 状态条() + '」');
        await 收尾();
        return;
      }
      if (r0 !== 起格[0] || c0 !== 起格[1]) {
        记(id + ' ' + 标题, false, 诊断头 + '（进格落错了格，未按方向键）');
        await 收尾();
        return;
      }
      const 状态前 = 状态条();
      键(t.ta, 预备键);
      await frames(1);
      const 头前 = V.state.selection.main.head;
      const 长 = V.state.doc.length;
      const 坐前 = V.coordsAtPos(头前, -1);
      const 首坐 = V.coordsAtPos(0, -1);
      let 在边界 = false;
      if (边界 === 'start') 在边界 = 头前 === 0;
      else if (边界 === 'end') 在边界 = 头前 === 长;
      else 在边界 = !!坐前 && !!首坐 && Math.abs(坐前.top - 首坐.top) <= 1;
      if (!在边界) {
        const 边界名 = 边界 === 'start' ? '格内文本最前'
          : 边界 === 'end' ? '格内文本最末' : '首视觉行';
        记(id + ' ' + 标题, false,
          诊断头 + '；按 ' + 预备键 + ' 后 head=' + 头前 + '/' + 长 + '（y '
            + (坐前 ? 四舍(坐前.top) : '?') + '，首行 y ' + (首坐 ? 四舍(首坐.top) : '?') + '）'
            + '，没到' + 边界名 + '；未按 ' + 方向键 + '，状态条「' + 状态条() + '」');
        await 收尾();
        return;
      }
      键(t.ta, 方向键);
      await frames(4);
      const host1 = 单元格宿主();
      const td1 = host1 ? host1.closest('td,th') : null;
      const tr1 = td1 ? td1.parentElement : null;
      const r1 = tr1 && typeof tr1.rowIndex === 'number' ? tr1.rowIndex : -1;
      const c1 = td1 && typeof td1.cellIndex === 'number' ? td1.cellIndex : -1;
      const 诊断 = 诊断头 + '，' + 预备键 + '→head=' + 头前 + '/' + 长
        + '；按 ' + 方向键 + ' 后 (' + r1 + ',' + c1 + ')，期望 (' + 应格[0] + ',' + 应格[1] + ')'
        + (host1 ? '' : '（按键后没有活动格）')
        + '，状态条「' + 状态条() + '」'
        + (状态前 !== 状态条() ? '（按前「' + 状态前 + '」）' : '')
        + (window.__DBG_KEY ? '，DBG：' + String(window.__DBG_KEY).slice(0, 300) : '');
      记(id + ' ' + 标题, !!host1 && r1 === 应格[0] && c1 === 应格[1], 诊断);
      await 收尾();
    }

    await 跨格探针('Q38', '格内文本最前再按 ← ⇒ 进左边一格', [0, 1], 'Home', 'start',
      'ArrowLeft', [0, 0]);
    await 跨格探针('Q39', '格内文本最末再按 → ⇒ 进右边一格', [0, 0], 'End', 'end',
      'ArrowRight', [0, 1]);
    await 跨格探针('Q40', '首视觉行再按 ↑ ⇒ 进上一行同一列', [1, 0], 'Home', 'firstLine',
      'ArrowUp', [0, 0]);

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

    // ── `Q26`–`Q30`：**命中测试**（`bugs/0066`，2026-11-03）──────────────
    //
    //  ⚠️ 为什么单独成段：`Q1` 点的是**格子左上角**（`点()` 的固定坐标），
    //    而用户报的缺陷恰好落在**行尾那一像素**——`.doc table` 是 `display: block`
    //    （`overflow-x: auto` 生效的必要条件）⇒ 块盒子铺满正文宽度，里面那张匿名表
    //    按内容收缩 ⇒ 最后一格右边那一大片**命中的是 `<table>` 元素本身**，
    //    `cellFromTarget` 一步都走不动（`bugs/0066` §3 的实测坐标）。
    //  ⇒ 这里每一次按下都按**真实坐标**派发（目标取自 `document.elementFromPoint`）：
    //    与用户那一下走同一条路 `onLiveDocDown → cellFromTarget → cellAtPoint`。
    //  ⚠️ 判据必须**两头都有**：行尾进得去（Q26/Q28/Q29）＋ 更外面⛔ 不隔空抢点击（Q27）。
    //    只判前者 ⇒ "把整块都当最后一格"也能过；只判后者 ⇒ 什么都不做也能过。
    //  ⚠️ 走这个入口的**只有**"目标不是格子"的那一半：正常命中路径由 `Q1`–`Q25` 守着。

    /**
     * 元素的一句话描述（`TAG.class#id「文本」`）。
     * ⚠️ 命中测试的失败说明里**只有 `TAG` 不够**：`BUTTON` 可能是格式栏、也可能是状态条上的
     *    动作钮（2026-11-16 实测 `Q26` 就因为"命中 BUTTON"而没有可归因的信息）。
     */
    function 元素简述(el) {
      if (!el) return 'null';
      const cls = (el.getAttribute && (el.getAttribute('class') || '')) || '';
      const id = el.id ? ('#' + el.id) : '';
      const txt = String(el.textContent || '').trim().slice(0, 24);
      return String(el.tagName) + (cls ? '.' + cls.split(/\s+/).join('.') : '') + id
        + (txt ? '「' + txt + '」' : '');
    }

    /** 按视口坐标派一次「按下-松开」；目标 = 那一刻**真的**落在那个点上的元素。 */
    function 按在(x, y) {
      const target = document.elementFromPoint(x, y) || 格()[0];
      const mk = function (type, buttons) {
        return new MouseEvent(type, {
          bubbles: true, cancelable: true, button: 0, buttons: buttons,
          clientX: Math.round(x), clientY: Math.round(y), view: window,
        });
      };
      target.dispatchEvent(mk('mousedown', 1));
      // ⚠️ 松开也要派：`noteDownGesture` 在文档级挂了一次性 `mouseup`，
      //    不松开就会把"按下还在进行"带进下一条判据（那会走 `bugs/0042` 的续接分支）。
      target.dispatchEvent(mk('mouseup', 0));
      return target;
    }

    /** 退出编辑态并等宿主摘掉（⛔ 别把上一轮的编辑态留进下一条判据）。 */
    async function 退格() {
      if (主机()) 键(输入框() || document.body, 'Escape');
      await waitFor(function () { return !主机(); }, 4000);
      await frames(1);
    }

    /**
     * 在 (x,y) 按一下，`ms` 内进得去哪一格；进不进都先退出来。
     * @returns {Promise<{落: object|null, 目标: object, 状态: string, 提交: number}>}
     */
    async function 点看进哪(x, y, ms) {
      await 退格();
      const 次 = 计数('render_preview');
      const 栏前 = 浮栏快照();
      const 目标 = 按在(x, y);
      const host = await waitFor(单元格宿主, ms || 2500);
      const 落 = host ? host.parentElement : null;
      const 状态 = host ? '' : 状态条();
      await 退格();
      await frames(3);
      const 栏后 = 浮栏快照();
      return {
        落: 落, 目标: 目标, 状态: 状态, 提交: 计数('render_preview') - 次,
        栏前: 栏前, 栏后: 栏后,
      };
    }

    /**
     * 浮动格式栏的**可见性与盒**（`design/0061` L4 ／ `design/0078` 紧凑模式）。
     * ⚠️ 2026-11-16 加：`Q26` 在 `blocks` 上量到 `+8 px` 命中的是
     *    `BUTTON.live-formatbar-more` ⇒ 需要证明"按下那一刻它到底可不可见、
     *    退出编辑态之后它是不是还挂着"。⛔ 不改任何产品状态，只读。
     */
    function 浮栏快照() {
      const el = document.getElementById('live-formatbar');
      if (!el) return '无栏';
      const r = el.getBoundingClientRect();
      return (el.hidden ? 'hidden' : '可见')
        + '[' + Math.round(r.left) + ',' + Math.round(r.top) + ' '
        + Math.round(r.width) + '×' + Math.round(r.height) + ']';
    }

    {
      const 表节点 = 块节点()[表];
      // ⚠️ 探针前提，⛔ 不是产品行为：`elementFromPoint` 对**视口外**的点恒返回 `null`。
      //    ⚠️ 正文真正在滚的是 `body`（`style.css`），`scrollIntoView` 会自己找到它。
      表节点.scrollIntoView({ block: 'center' });
      await frames(2);

      const 行们 = [];
      for (let r = 0; r < 表节点.rows.length; r++) 行们.push(表节点.rows[r]);
      const 首行 = 行们[0];
      const 末行 = 行们[行们.length - 1];
      const 首行末格 = 首行.cells[首行.cells.length - 1];
      const 末格 = 末行.cells[末行.cells.length - 1];
      const 表盒 = 表节点.getBoundingClientRect();
      const 末格盒 = 末格.getBoundingClientRect();
      /** 最后一格右边那片"属于 `<table>` 本身"的死区有多宽（这一段的适用前提）。 */
      const 空带 = 表盒.right - 末格盒.right;
      const 并列y = Math.round(末格盒.top + Math.max(3, Math.min(8, (末格盒.bottom - 末格盒.top) / 2)));
      摘要.Q.命中 = { 空带: 四舍(空带), 行数: 行们.length, 列数: 首行.cells.length };

      // ── `Q26` 行尾 `+0/+8/+16 px` 都进**最后一格**（`bugs/0066` 的正判据）────
      const 偏 = [0, 8, 16];
      const 详情 = [];
      let 行尾全中 = true;
      let 真在死区 = true;
      for (let i = 0; i < 偏.length; i++) {
        // ⚠️⚠️ `按在()` 派发时把坐标取整，而 `末格盒.right` 常带小数 ⇒ 同一个"+16 px"
        //    在 `right = 597.75` 时**实际离格右 16.25 px**，越过产品 16 px 的容差
        //    （`live/cell.js` 的 `EDGE_SLOP = 16`）⇒ 这条判据就变成在量**亚像素取整**，
        //    而不是产品行为（2026-11-04 实测踩过：夹具给第三列加了个行内代码，
        //    死区 388.531 → 381.25，`+16px` 当场红，而 `+0/+8` 全绿）。
        //    ⚠️ 起点也必须**在格外**：`Math.round(495.109)` = 495 落在格子**里面**，
        //    `Q26b`（"这几次按下的目标真的是 `<table>`"）当场红——那是取整把点挪进了格。
        //    ⇒ 起点 = 格右之外第一个整数（`floor(right) + 1`），三档都夹在
        //    `floor(right + 16)` 以内（`EDGE_SLOP` 的容差边）。
        const 右外 = Math.floor(末格盒.right) + 1;
        const x = Math.min(右外 + 偏[i], Math.floor(末格盒.right + 16));
        const r = await 点看进哪(x, 并列y, 3000);
        const 中 = r.落 === 末格;
        if (!中) 行尾全中 = false;
        if (r.目标 !== 表节点) 真在死区 = false;
        详情.push('+' + 偏[i] + 'px → ' + (中 ? '末格' : (r.落 ? String(r.落.tagName) : ('没进去「' + r.状态 + '」')))
          + '（命中 ' + 元素简述(r.目标) + '；浮栏 按前=' + r.栏前 + ' 按后=' + r.栏后 + '）');
      }
      记('Q26 点行尾（+0/+8/+16 px）进**最后一格**（死区不是"你点错地方了"）',
        行尾全中,
        '死区宽 ' + 四舍(空带) + ' px；' + 详情.join('；'));
      // ⚠️ 这一条**单独**判：死区里的按下必须真的落在 `<table>` 上。
      //    它防的是"CSS 改成 `fit-content` 之后 Q26 变成空判据"——那时点 +8 命中的是
      //    正文空白，图纸上仍然是"没进格子"，⛔ 与产品修好了长得一模一样。
      记('Q26b 行尾那几次按下的目标真的是 `<table>`（死区存在，Q26 不是空判据）',
        真在死区,
        '目标：' + 详情.join('；') + '；表盒右 ' + 四舍(表盒.right) + ' / 末格右 ' + 四舍(末格盒.right));

      // ── `Q27` 死区更外面（+64 px）⛔ 不隔空抢点击（负对照）─────────────
      //  ⚠️ 判据必须与 Q26 同一个"按下"入口：否则"把整个块盒子都当最后一格"也能让 Q26 全绿。
      if (空带 < 80) {
        记('Q27 死区更外侧（+64 px）⛔ 不隔空抢点击', false,
          '死区只有 ' + 四舍(空带) + ' px，夹具形状不支持这条判据（需要 ≥ 80 px）');
      } else {
        const r = await 点看进哪(末格盒.right + 64, 并列y, 1500);
        记('Q27 死区更外侧（+64 px）⛔ 不隔空抢点击（负对照）',
          !r.落 && r.提交 === 0,
          (r.落 ? ('进了 ' + String(r.落.tagName)) : '没进任何格子')
            + '；命中 ' + String(r.目标 && r.目标.tagName)
            + '；提交 ' + r.提交 + ' 次');
      }

      // ── `Q28` 表头行尾同样进得去（`<th>` 那一路）──────────────────────
      const 首末盒 = 首行末格.getBoundingClientRect();
      const 首y = Math.round(首末盒.top + Math.max(3, Math.min(8, (首末盒.bottom - 首末盒.top) / 2)));
      const r28 = await 点看进哪(首末盒.right + 8, 首y, 3000);
      记('Q28 表头行尾（+8 px）进**表头最后一格**（`<th>` 与 `<td>` 同一条路）',
        r28.落 === 首行末格,
        (r28.落 ? ('进了 ' + String(r28.落.tagName)) : ('没进去「' + r28.状态 + '」'))
          + '；命中 ' + String(r28.目标 && r28.目标.tagName)
          + '；死区宽 ' + 四舍(表盒.right - 首末盒.right) + ' px');

      // ── `Q29` 行尾按下之后**继续拖进格内**：选区跟着走（手势没丢）──────────
      //  ⚠️ 这条是 `bugs/0066` 与 `bugs/0042` 的**交叉面**：按下发生在阅读态的 `<table>`
      //    死区里，而视图是 `live.begin` **异步**建出来的 ⇒ 真正建拖拽态的是
      //    `selection.js::moveHandler` 接手 `pending` 那条分支。读代码证明不了它接上了。
      //  ⚠️ 为什么**不复用** `按在()`：它按下就松手，松手会把 `pending.released` 标成
      //    `true` ⇒ 交接那条分支直接丢弃手势（那是**正确**行为，但这一条判的正是"没松手"）。
      //  ⇒ 按下 → 等视图 → 移动 → 再松手，与用户一次真实拖拽同一个顺序。
      //  ⚠️ 负对照就是它自己：`M35` 摘掉几何兜底之后这里根本进不了格，判据必红。
      {
        await 退格();
        const 按x = 末格盒.right + 8;
        const 按目标 = document.elementFromPoint(按x, 并列y) || 表节点;
        const mk = function (type, x, y, buttons) {
          return new MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, buttons: buttons,
            clientX: x, clientY: y, view: window, detail: 1,
          });
        };
        按目标.dispatchEvent(mk('mousedown', 按x, 并列y, 1));
        const host29 = await waitFor(单元格宿主, 3000);
        let ok29 = false;
        let 详情29 = '';
        if (!host29) {
          详情29 = '按下行尾没进格（状态「' + 状态条() + '」）';
        } else {
          await frames(1);
          const V29 = 视图(host29);
          // 往格子里拖一段：x 落在同一格左内侧，y 不动。
          const 移x = 末格盒.left + Math.max(3, Math.min(8, (末格盒.right - 末格盒.left) / 4));
          const 移目标 = document.elementFromPoint(移x, 并列y) || host29;
          移目标.dispatchEvent(mk('mousemove', 移x, 并列y, 1));
          await frames(1);
          const sel = V29 ? V29.state.selection.main : null;
          ok29 = !!sel && sel.head !== sel.anchor;
          详情29 = V29
            ? ('选区 ' + (sel ? sel.anchor + '→' + sel.head : '读不到')
              + '（拖向 x=' + 四舍(移x) + '）')
            : '进格了但读不到 CM6 视图';
        }
        document.dispatchEvent(mk('mouseup', 末格盒.left, 并列y, 0));
        await 退格();
        记('Q29 行尾按下后继续拖进格内：手势交接成功、选区非空',
          ok29, 详情29 + '；目标 ' + String(按目标 && 按目标.tagName));
      }

      // ── `Q30` `⇧Tab` 在**第一格**退出（与 `Q9` 最后一格 Tab 对称）──────────
      //  ⚠️ `Q9` 只判了右端；左端若退化成"绕回最后一格"，用户按 `⇧Tab` 会**跳到表尾**。
      const t30 = await 进格(0);
      if (!t30) {
        记('Q30 第一格 `⇧Tab` 退出编辑（⛔ 不绕回最后一格）', false, '进不去：' + 状态条());
      } else {
        const 前文30 = 全文();
        const 次30 = 计数('render_preview');
        键(t30.ta, 'Tab', { shift: true });
        const 走30 = await waitFor(function () { return !主机(); }, 4000);
        await frames(1);
        const 新宿主 = 单元格宿主();
        const 提交了 = 计数('render_preview') - 次30;
        记('Q30 第一格 `⇧Tab` 退出编辑（⛔ 不绕回最后一格）',
          !!走30 && !新宿主 && 全文() === 前文30,
          (走30 ? '退出了' : '还留在编辑态')
            + '；新宿主=' + (新宿主 ? '有（绕回去了）' : '无')
            + '；提交 ' + 提交了 + ' 次；全文变了=' + (全文() !== 前文30));
        await 退格();
      }

      // ── `Q31` 编辑中点**另一格**：先提交这一格，再进那一格（`P5`/`P7` 的格子版）──
      //  ⚠️⚠️ 此前 `Q` 段每一条都从"**已经进去了**"起算，「点另一格」这条路一条判据都没有：
      //     块级有 `P5`（点另一块进得去）/ `P7`（进的是被点那一块），而格子走的是
      //     **另一条**取值口（`d.cellNodeOf`）＋ `live/index.js::begin()` 里那段
      //     「提交之后按新表 / 新树重取」（`M13` 就是把它整个停掉）。漏了格子那一半的
      //     表现是「点另一格，进不去 / 进去的还是原来那块」——屏幕上看不出来，而
      //     `Q` 段其余判据照样全绿。
      //  ⭐ 承重证据 = 既有变异 `M13`（`if (switched)` → `if (false)`）：块级由 `P7` 打红，
      //     格子这条路只有本条看得见。
      {
        const t31 = await 进格(0);
        if (!t31) {
          记('Q31 编辑中点另一格：先提交这一格，再进那一格', false, '进不去：' + 状态条());
        } else {
          const 前文31 = 全文();
          const 区0 = 现区间(0);
          const 次31 = 计数('render_preview');
          // ⚠️⚠️ **光标必须先到这一格末尾**再敲：`进格()` 点的是格子**左上角**，
          //    光标落在第 0 个字符之前 ⇒ 直接敲字会得到「甲单元格」而期望写成「单元格甲」。
          //    （同一个坑在 `Q15` 那里已经踩过一次，见那一段的注释。）
          const v31 = 视图(t31.host);
          if (v31 && v31.state && v31.state.doc) {
            v31.dispatch({ selection: { anchor: v31.state.doc.length } });
          }
          await frames(1);
          const 视图0 = 块全文(t31.host);
          打字(t31.ta, '甲');
          await frames(2);
          // ⭐ 真的按坐标点下去（⛔ 不是往 `<td>` 派事件）：走的是 `onLiveDocDown` 的
          //    `Table` 分支 ＋ `cellFromTarget`，与用户点另一格是同一条路。
          const 盒1 = 格()[1].getBoundingClientRect();
          const 目标31 = 按在(盒1.left + 盒1.width / 2, 盒1.top + 盒1.height / 2);
          // ⚠️ 等的是**换了一个**宿主：`leave()` 是异步的，旧宿主还挂在树上 ⇒
          //    只判"有宿主"会拿到上一个（`R` 段同一处坑，见 `跑鼠标拖选` 里那段）。
          const 宿主31 = await waitFor(function () {
            const h = 单元格宿主();
            return h && h !== t31.host ? h : null;
          }, 4000);
          await frames(2);
          const 新格 = 格();
          const 落对 = !!宿主31 && !!新格[1] && 宿主31.parentElement === 新格[1];
          const 视图1 = 宿主31 ? 块全文(宿主31) : null;
          // ⚠️⚠️ 期望值取**进入编辑之前**那一格的源码，比较时用 `换行同形`：本段是流水线，
          //    前面的 `Q14`/`Q15` 已经往这一格里写过换行 ⇒ 源码此刻是 `列二甲<br>乙甲乙丙`
          //    而视图是两行。⛔ 别以为"夹具里这一格是纯汉字"（2026-11-03 假红过一次）。
          //    ⛔ 也不用产品自己的 `decode` 当 oracle。
          const 应1 = (现区间(1) || {}).text;
          const 核31 = 字节核对(前文31, 区0, 视图0 + '甲', '点另一格时的提交');
          const 提交31 = 计数('render_preview') - 次31;
          记('Q31 编辑中点另一格：先提交这一格、再进那一格（⛔ 不把上一格的字带过去）',
            落对 && 视图1 !== null && 换行同形(应1, 视图1) && 核31.ok && 提交31 === 1,
            (落对 ? '进了第二格'
              : '进的不是第二格（宿主父='
                + String((宿主31 && 宿主31.parentElement && 宿主31.parentElement.tagName) || '无宿主') + '）')
              + (视图1 === null ? '；没进新格'
                : ('；新格视图「' + String(视图1).replace(/\n/g, '⏎').slice(0, 24) + '」'
                  + (换行同形(应1, 视图1) ? ''
                    : '（应「' + String(应1).replace(/\n/g, '⏎').slice(0, 24) + '」）')))
              + '；' + (核31.ok ? '上一格提交对' : 核31.msg)
              + '；提交 ' + 提交31 + ' 次；按下命中 ' + String(目标31 && 目标31.tagName));
          if (宿主31) {
            键(输入框() || document.body, 'Escape');
            await waitFor(function () { return !主机(); }, 4000);
          }
          await frames(1);
          await 退格();
        }
      }

      // ── `Q32` 在**正在编辑的那一格**里再点一下：⛔ 不重新进格 ───────────────
      //  ⚠️⚠️ 这条防的是**一条只在格子上成立的静默回归**：`onLiveDocDown` 里那道
      //     `node.classList.contains('cm-rmd-liveHost')` 闸判的是**块顶节点**，
      //     而单元格那颗宿主挂在 `<td>` **里面** ⇒ 闸对格子**不生效**；
      //     真正拦住"在格子里点一下 = 又进一次"的是**两道**拦截（纵深防御）：
      //     ① `selection.js::down()`（capture 期，挂在 `view.dom` 上）的
      //        `preventDefault()` ＋ `stopPropagation()`；
      //     ② `main.js::onLiveDocDown` 的 `if (ev.defaultPrevented) return;`。
      //     少了任何一道，事件冒泡到 `#doc` 就会被当成一次**新的进入** ⇒ 重新
      //     `begin_edit`、换一个新宿主 ⇒ 光标、选区、IME 组合串全丢
      //     （用户侧的表现是"点一下字就跳"）。
      //  ⭐ 承重证据 = 变异 `M36`（**两处一起摘**）：块级的 `P*` 一条都不受影响，
      //     只有本条会红——这也正是"块级有闸、格子没有"这件事的证词。
      //     ⚠️⚠️ 只摘 ①（那是 M36 的第一版，2026-11-03）**本条仍然全绿**：事件下潜到
      //     CM6 自己的 `mousedown` 处理，它 `preventDefault()`，② 就把它挡掉了。
      //     ⇒ 判据与变异都要求"两处一起摘"，只摘一处不算变异生效。
      {
        const t32 = await 进格(0);
        if (!t32) {
          记('Q32 正在编辑时再点这一格：⛔ 不重新进格（不重申请编辑授权、不换宿主）',
            false, '进不去：' + 状态条());
        } else {
          const 次授权 = 计数('begin_edit');
          const 次提交 = 计数('render_preview');
          const 原宿主 = t32.host;
          const 盒32 = 原宿主.getBoundingClientRect();
          // ⚠️ 点在**这一格里**（宿主内部）：命中 `.cm-line` / `.cm-content`，事件路径
          //    先到 `selection.js` 的 capture 监听器（`view.dom`）。
          按在(盒32.left + 盒32.width / 2, 盒32.top + 盒32.height / 2);
          // ⚠️ 不是 1 帧：`live.begin` 是异步的，要给它足够时间**真的**重新进一次
          //    （变异形态下那件事发生在微任务 + IPC 之后）——否则这条会把
          //    "还没来得及重复进入"读成"没有重复进入"。
          await frames(5);
          const 现宿主 = 单元格宿主();
          记('Q32 正在编辑时再点这一格：⛔ 不重新进格（不重申请编辑授权、不换宿主）',
            现宿主 === 原宿主 && 计数('begin_edit') === 次授权
              && 计数('render_preview') === 次提交,
            '宿主换了=' + (现宿主 !== 原宿主)
              + '；begin_edit +' + (计数('begin_edit') - 次授权)
              + '；提交 +' + (计数('render_preview') - 次提交)
              + '；宿主还在=' + !!现宿主);
          await 退格();
        }
      }

      // ── `Q33`/`Q33b`/`Q33c` 正在编辑时点 / 拖**格内右侧空白**（`bugs/0069`，2026-11-04）──
      //
      //  ⚠️⚠️ 用户原话：「行尾无法插入光标的问题，还是有问题。……这个地方无法插入行尾光标。」
      //     「使用 → 无法走到行尾。」两条都长在这条路径上。
      //
      //  ⭐ 那一片空白**属于 `<td>`、⛔ 不属于 CM6**：`Q32` 点的是宿主**内部**（走
      //     `selection.js::down()` 的 capture 监听器，挂在 `view.dom` 上），而格内右侧空白的
      //     mousedown 会一路冒泡到 `#doc` 的 `onLiveDocDown` ⇒ 被当成**一次新的进入**：
      //     `leave('switch')` → 提交 ＋ 整篇重渲 ＋ 重新 `begin_edit` ＋ 换宿主，而光标落点
      //     还要在重渲之后**重新**把屏幕坐标映射回新布局 ⇒ 实测停在最后一个字**之前**
      //     （用户截图里那根光标就卡在 `不` 与 `动` 之间）。
      //
      //  ⭐ 修法两层，两层各有独立职责，判据也分开承重：
      //     ① `installMouse` 收 `hitArea`（那一格的 `<td>`）⇒ 格内空白**当场**接走：
      //        同步 `posAtCoords` ＋ 改选区（⛔ 没有 IPC），而且**能接着拖选** ⇒ `Q33`/`Q33c`；
      //     ② `onLiveDocDown` 里"点的就是活动的那一格 ⇒ 只挪光标，⛔ 不 `begin()`"
      //        ⇒ 管 `bugs/0066` 那 16 px 死区（`<td>` 之外、`<table>` 块盒子之内）⇒ `Q33b`。
      //     ⚠️ `Q31`（点**另一格**）是这两条的负对照：⛔ 不许把"换格"一起吃掉。
      //     ⚠️⚠️ `Q33` 在"只摘 ①"或"只摘 ②"时**仍然绿**（另一层顶上）——这是纵深防御的
      //        必然形态，⛔ 别把它读成"某一条不承重"；单层的证据分别由 `Q33c`（M37）
      //        与 `Q33b`（M38）承担。
      {
        const 表节点33 = 块节点()[表];
        // ⭐ 挑「最后一列里文字最短的那一行」：列宽由这一列最长的那一格决定 ⇒
        //    这一格的**格内右侧空白最大**，正是用户那张表的形状
        //    （`ARCHITECTURE.md` 第 72 行：`失败不发布 | 校验失败 ⇒ …都不动`）。
        //    ⚠️ 跳过表头行：`th` 未必可写（`writable` 由后端判，⛔ 探针不替它决定）。
        let 挑格 = null;
        let 挑空 = -Infinity;
        let 挑y = 0;
        let 挑文右 = 0;
        let 挑序 = -1;
        {
          let k = 0;
          for (let r = 0; r < 表节点33.rows.length; r++) {
            const cells = 表节点33.rows[r].cells;
            for (let c = 0; c < cells.length; c++, k++) {
              if (r === 0 || c !== cells.length - 1) continue;
              const cell = cells[c];
              const rb = cell.getBoundingClientRect();
              const tr = 文本右界(cell);
              if (!tr) continue;
              if (rb.right - tr.right > 挑空) {
                挑空 = rb.right - tr.right;
                挑格 = cell;
                挑序 = k;
                挑文右 = tr.right;
                挑y = Math.round((tr.top + tr.bottom) / 2);
              }
            }
          }
        }
        // ⚠️ **前提**：这一列里得真的有一格"文字右边留白"。列宽由最长格决定，
        //    所以只有短格才有留白（`blocks.md` 的 `列三`：`单元格` vs `中等长度的内容`）。
        //    ⚠️ `tasks.md` 那张表**每列都由它自己唯一那一格定宽** ⇒ 格内没有留白
        //    （`~7 px` 全是 `td` 的 `padding-right`）⇒ 这三条**不适用**，⛔ 不许记成通过，
        //    也不许记成失败；由 `block-probe.sh` 的 `Q-覆盖` 按 `摘要.Q.格内空白.不适用` 放行。
        const 有空白33 = !!(挑格 && 挑空 >= 16);
        const t33 = 有空白33 ? await 进格(挑序) : null;
        if (!t33) {
          if (有空白33) {
            // 前提成立却进不去 ⇒ 这是**真红**（⛔ 不能拿"不适用"盖过去）。
            记('Q33 正在编辑时点**格内右侧空白**：挪光标，⛔ 不重进（不换宿主、不重申请授权）',
              false, '进不去这一格');
            记('Q33b 正在编辑时点**格外死区**（`<td>` 外 8 px）：同样只挪光标', false, '进不去那一格');
            记('Q33c 格内空白处按下再拖 ⇒ 真的拖出选区', false, '进不去那一格');
          } else {
            摘要.Q.格内空白 = {
              不适用: true,
              最大空白: 四舍(挑空 === -Infinity ? 0 : 挑空),
              原因: '这张表的最后一列由它自己那一格定宽 ⇒ 格内没有留白（⛔ 这三条测不了）',
            };
          }
        } else {
          const 宿主33 = t33.host;
          await frames(1);
          const 格盒33 = 挑格.getBoundingClientRect();
          const 宿主盒33 = 宿主33.getBoundingClientRect();
          const 文右33 = 文本右界(宿主33);
          const x33 = Math.round(格盒33.right - 8);
          // ⚠️ `y` **必须在编辑态重算**：进格前后块的上下位置会变（⛔ 别用阅读态那个 `挑y`，
          //    否则按下的那一下可能落在隔壁行，判据读起来像"产品没挪对光标"）。
          const y33 = 文右33 ? Math.round((文右33.top + 文右33.bottom) / 2) : 挑y;
          // ⚠️ 前提（不是产品行为）：按下点必须真的落在**宿主之外**，否则这一条测的还是 Q32。
          const 在格外 = x33 > 宿主盒33.right + 4;
          摘要.Q.格内空白 = {
            格宽: 四舍(格盒33.width), 宿主右: 四舍(宿主盒33.right),
            按下x: x33, 按下y: y33, 在宿主之外: 在格外,
          };

          // ① `Q33` 编辑中点格内右侧空白
          键(t33.ta, 'Home');
          await frames(1);
          const 授权33 = 计数('begin_edit');
          const 提交33 = 计数('render_preview');
          const 目标33 = 按在(x33, y33);
          await frames(6);
          const 现宿主33 = 单元格宿主();
          const 头33 = 现宿主33 ? 选区头(现宿主33) : -1;
          const 长33 = 现宿主33 ? String(块全文(现宿主33)).length : -1;
          const 光标左33 = (function () {
            const q = 现宿主33 && 现宿主33.querySelector('.cm-rmd-caret');
            if (!q) return null;
            return 四舍(q.getBoundingClientRect().left);
          })();
          const 末字右33 = (function () {
            const tr = 现宿主33 ? 文本右界(现宿主33) : null;
            return tr ? 四舍(tr.right) : null;
          })();
          记('Q33 正在编辑时点**格内右侧空白**：挪光标到行末，⛔ 不重进（不换宿主、不重申请授权）',
            在格外 && 现宿主33 === 宿主33 && 计数('begin_edit') === 授权33
              && 计数('render_preview') === 提交33
              && 头33 === 长33 && 光标左33 !== null && 末字右33 !== null
              && Math.abs(光标左33 - 末字右33) <= 2,
            '按下点' + (在格外 ? '在宿主之外' : '**落在宿主内**（前提不成立）')
              + '；宿主换了=' + (现宿主33 !== 宿主33)
              + '；begin_edit +' + (计数('begin_edit') - 授权33)
              + '；提交 +' + (计数('render_preview') - 提交33)
              + '；光标' + 头33 + '/' + 长33 + '（应为行末）'
              + '；光标层左' + 光标左33 + '，末字右' + 末字右33
              + '；按下命中 ' + String(目标33 && 目标33.tagName));

          // ② `Q33b` 编辑中点**格外死区**（`<td>` 右边界外 8 px，`bugs/0066` 的 16 px 容差内）

          键(t33.ta, 'Home');
          await frames(1);
          const 授权33b = 计数('begin_edit');
          const 提交33b = 计数('render_preview');
          const x33b = Math.round(格盒33.right + 8);
          const 目标33b = 按在(x33b, y33);
          await frames(6);
          const 现宿主33b = 单元格宿主();
          const 头33b = 现宿主33b ? 选区头(现宿主33b) : -1;
          const 长33b = 现宿主33b ? String(块全文(现宿主33b)).length : -1;
          记('Q33b 正在编辑时点**格外死区**（`<td>` 右边界外 8 px）：同样只挪光标，⛔ 不重进',
            目标33b !== 挑格 && 现宿主33b === 宿主33 && 计数('begin_edit') === 授权33b
              && 计数('render_preview') === 提交33b && 头33b === 长33b,
            '按下命中 ' + String(目标33b && 目标33b.tagName)
              + (目标33b === 挑格 ? '（命中的还是这一格 ⇒ 死区不存在，前提不成立）' : '')
              + '；宿主换了=' + (现宿主33b !== 宿主33)
              + '；begin_edit +' + (计数('begin_edit') - 授权33b)
              + '；提交 +' + (计数('render_preview') - 提交33b)
              + '；光标' + 头33b + '/' + 长33b + '（应为行末）');

          // ③ `Q33c` 格内空白处**按下再拖** ⇒ 真的拖出选区（`hitArea` 的独立职责）
          //    ⚠️ 只靠 `Q33b` 那道守卫是拖不动的：`moveHandler` 要靠 `down()` 建立的拖拽态，
          //    而 `down()` 只有在监听面覆盖到 `<td>`（`hitArea`）时才会被叫到。
          //    ⚠️⚠️ **这条只能在 `Q33b` 之后跑，因此它不能当 M38 的负对照**（2026-11-04 实测）：
          //       `Q33b` 在 M38 下会真的重进一次格、把原宿主摘掉；这条拿 `视图(宿主33)`
          //       去读那个已经 detach 的宿主 ⇒ 恒为 `-1..-1`，**与 `hitArea` 有没有职责无关**。
          //       （退回 `bugs/0078` 的改动后一模一样红，已排除产品改动的影响。）
          //       ⇒ M38 的负对照只取 `Q33`；`Q33c` 的承重证据在 M37 那一条里（必须红）。
          //    ⚠️ 也不能提到前面去：它那次拖选＋`退格`会改掉格内文字，`Q33`/`Q33b`
          //       跟在后面跑时会变成"重新进格"（2026-11-04 实测 `宿主换了=true`）⇒ 顺序是死的。
          键(t33.ta, 'Home');
          await frames(1);
          const V33 = 视图(宿主33);
          const mk33 = function (type, buttons, x) {
            return new MouseEvent(type, {
              bubbles: true, cancelable: true, button: 0, buttons: buttons,
              clientX: Math.round(x), clientY: y33, view: window,
            });
          };
          const xB33 = Math.round(宿主盒33.left + 4);
          const 目标33c = document.elementFromPoint(x33, y33) || 挑格;
          目标33c.dispatchEvent(mk33('mousedown', 1, x33));
          await frames(1);
          document.dispatchEvent(mk33('mousemove', 1, x33 - 24));
          await frames(1);
          document.dispatchEvent(mk33('mousemove', 1, xB33));
          await frames(2);
          document.dispatchEvent(mk33('mouseup', 0, xB33));
          await frames(2);
          const 选33 = (V33 && V33.state && V33.state.selection) ? V33.state.selection.main : null;
          const 选起 = 选33 ? Math.min(选33.anchor, 选33.head) : -1;
          const 选终 = 选33 ? Math.max(选33.anchor, 选33.head) : -1;
          记('Q33c 格内空白处**按下再拖** ⇒ 真的拖出选区（`hitArea` 的独立职责，⛔ 只挪光标不算）',
            !!选33 && 选终 > 选起 && 选起 <= 2,
            '按下命中 ' + String(目标33c && 目标33c.tagName)
              + '；选区 ' + 选起 + '..' + 选终 + '（应为 0 起、非空）');
          await 退格();
        }

        // ── `Q34`/`Q34b` **阅读态**点「格内最后一个字的右半」⇒ 光标必须落在格末（`bugs/0084`）──
        //
        //  ⚠️⚠️ 用户 2026-11-04 第二次报：「光标无法移动到单元格文字末尾的情况，还是没有修改。」
        //     这一条与 `Q33*`（编辑态点格内空白）**不是同一件事**：那三条判的是"点由谁接、
        //     会不会重进"，落点从来没有被判过。这里的落点是错的，而且错在**换算坐标用的那张排版**：
        //     ⚠️ **当时**（`bugs/0084`，2026-11-04）的成因是"进入编辑态时选区在 0 ⇒ 活动行
        //     按规则 2 显示源码 ⇒ 格内的反引号/星号露出来"，排版比用户点的那一屏（阅读态，
        //     标记藏起来）宽出那几个字符 ⇒ `posAtCoords` 少算那几个字符（实测 `head=25/27`）。
        //     ⭐ `design/0061` L1（2026-11-05）把"活动行"整个删掉了 ⇒ **那个成因已不存在**；
        //     这条判据保留为**回归闸门**：量的仍是"阅读态点格末 ⇒ 光标在格末"这个用户可见结果。
        //     ⚠️ `snapLineEnd` 管不到这一条：它只在 x 越过 `contentDOM` 右界时才夹到行末，
        //        而用户点的位置在**最后一个字里面**。
        //     ⚠️⚠️ **只判"阅读态那一下"**：已经在编辑时再点同一处是对的（那时点的就是展开后的排版），
        //        那一种是 `Q32` 的地盘。
        //  ⭐ **前提**：这一格带行内标记（`` `code` `` / `**粗**`）——没有标记，展开前后一样宽，
        //     这条判据**恒绿**（⛔ 那种绿没有承重价值）。夹具 `blocks.md` 的第三列第二行
        //     ``中等长度的 `内容` `` 就是为它准备的。
        //     ⚠️ 整张表都没有这种格子 ⇒ 记 `摘要.Q.格末.不适用`（⛔ 不记通过、也不算失败），
        //     由 `block-probe.sh` 的 `Q-覆盖` 按这个键放行，并要求**至少一份夹具真的跑过**。
        //  ⚠️ 负对照取"同一格的**左端**"：它证明这条判据不是"点什么都在格末"。
        {
          // 先把 `Q33*` 那一格退回阅读态：这一条要的就是**阅读态**的那一下点击。
          if (单元格宿主()) {
            键(输入框() || document.body, 'Escape');
            await waitFor(function () { return !主机(); }, 4000);
            await frames(2);
          }
          const 格们34 = 格();
          let 格34 = null;
          // ⚠️⚠️ 判"这一格有没有行内标记"⛔ 不能读 `textContent` 找反引号/星号：
          //    阅读态里标记被 `Decoration.replace` 换掉了，**它们根本不在 DOM 文本里**
          //    （2026-11-04 实测踩过：夹具明明写着 ``中等长度的 `内容` ``，这里仍判
          //    "没有行内标记" ⇒ `Q34` 静默变成"不适用"，`M39` 因此没有基线、`Q-覆盖` 红）。
          //    ⇒ 看**渲染结果**：格内有 `<code>/<strong>/<em>/<del>/<a>` ⇔ 源文本里必有标记。
          const 标记选择器 = 'code, strong, em, del, s, a';
          for (let k = 0; k < 格们34.length; k++) {
            const el = 格们34[k];
            if (!el.querySelector) continue;
            let 有 = false;
            try { 有 = !!el.querySelector(标记选择器); } catch (e) { void e; }
            if (有) { 格34 = el; break; }
          }
          if (!格34) {
            摘要.Q.格末 = {
              不适用: true,
              原因: '这张表的格子里没有行内标记 ⇒ 展开前后一样宽，这条测不了',
            };
          } else {
            /** 派一次按下（页内 DOM 事件，⛔ 不是系统级合成按键）。 */
            function 按34(x, y) {
              const 目标 = document.elementFromPoint(x, y);
              if (!目标) return null;
              const ev = new MouseEvent('mousedown', {
                bubbles: true, cancelable: true, button: 0, buttons: 1,
                clientX: Math.round(x), clientY: Math.round(y), view: window,
              });
              目标.dispatchEvent(ev);
              return 目标;
            }
            const 末34 = 文本右界(格34);
            const 盒34 = 格34.getBoundingClientRect();
            // ⚠️ 落点 = **最后一个字右边界往内 1 px**：用户"点行尾"的那一下就在这儿。
            //    ⛔ 别用 `td.right - 8`（那是 `Q33` 的"文字右边空白"，另一条通路）。
            //    ⚠️ 量不到字（夹具/样式变了）就退回格盒右下 —— 那一下必然落不到"最后一个字的右半"，
            //    判据会如实变红，⛔ 别让它抛异常把整轮探针打成"致命"。
            const x34 = Math.round((末34 ? 末34.right : 盒34.right) - 1);
            const y34 = 末34
              ? Math.round((末34.top + 末34.bottom) / 2)
              : Math.round(盒34.top + 盒34.height / 2);
            const 目标34 = 按34(x34, y34);
            const 宿主34 = 目标34 ? await waitFor(单元格宿主, 4000) : null;
            await frames(2);
            const 头34 = 宿主34 ? 选区头(宿主34) : -1;
            const 文34 = 宿主34 ? String(块全文(宿主34)) : '';
            记('Q34 阅读态点**格内最后一个字的右半** ⇒ 光标落在格末（⛔ 不许少算隐藏标记那几个字）',
              头34 === 文34.length && 文34.length > 0,
              '按下 x=' + x34 + ' y=' + y34 + ' 命中 ' + String(目标34 && 目标34.tagName)
                + '；光标 ' + 头34 + '/' + 文34.length + '（应为格末）'
                + '；格文本 ' + JSON.stringify(文34.slice(0, 48)));

            // ⭐ `Q34c`（`bugs/0085`）：行末光标**还看得见吗**。
            //    ⚠️⚠️ 这一条**不能用 `getBoundingClientRect()` 代替**：格子 `.cm-rmd-cell` 是
            //    `inline-block`（宽收缩到内容宽）＋ `overflow-x: clip`，行末光标的左边界正好
            //    等于裁剪盒的右边界 ⇒ 2 px **全部被裁掉**，而矩形照样有值。
            //    ⇒ 判据必须量**剩余可见宽**（自己的框 ∩ 每一层裁切祖先的框）。
            //    ⚠️⚠️ **夹具必须是"纯文本格"**（没有 `code`/`strong` 等行内元素）：
            //      带行内标记的格子末尾是内联元素，自带左右内边距（实测 ~3 px）⇒ 行末光标
            //      仍落在裁剪盒里面，**摘掉夹取也绿** —— 2026-11-05 实测它是一条空判据
            //      （M40 变异后 `Q34c` 依旧通过，`blocks.md` 三列里 `中等长度的 \`内容\``
            //      的宿主右沿 590.3 vs 末字右沿 587.1）。纯文本格的 `.cm-rmd-cell` 收缩到
            //      文字宽，末字右沿 == 裁剪盒右沿（实测都是 414）⇒ 剩余可见宽 0.03 px。
            //    → 所以另起一次点击，落在**另一格**：见下面 `Q34c` 段。

            // 负对照：同一格**左端**再点一下 ⇒ 光标必须**不在**格末。
            // ⚠️ 点了左端之后仍是编辑态（宿主还在），所以直接在同一次进入里按。
            const x34b = Math.round(盒34.left + 4);
            const 目标34b = 按34(x34b, y34);
            await frames(2);
            const 头34b = 宿主34 ? 选区头(宿主34) : -1;
            记('Q34b 负对照：同一格**左端**的点 ⇒ 光标⛔ 不在格末',
              宿主34 !== null && 目标34b !== null && 头34b >= 0 && 头34b < 文34.length,
              '按下 x=' + x34b + ' 命中 ' + String(目标34b && 目标34b.tagName)
                + '；光标 ' + 头34b + '/' + 文34.length);

            // ⭐ `Q34c`（`bugs/0085`）—— **换一格量**：纯文本格。
            //    理由见上面那段注释（带行内元素的格子有 ~3 px 内边距当缓冲，是空判据）。
            //    ⚠️ 判据本身没变：行末光标的**剩余可见宽 ≥ 1 px**；
            //    变的是夹具 —— `长一点的单元格内容` 这种纯文本格，宿主右沿 == 末字右沿。
            {
              // 先把 `Q34`/`Q34b` 那一格退回阅读态：这一条同样要"阅读态点进去"的那一下。
              if (单元格宿主()) {
                键(输入框() || document.body, 'Escape');
                await waitFor(function () { return !主机(); }, 4000);
                await frames(2);
              }
              const 格们C = 格();
              let 格C = null;
              for (let k = 0; k < 格们C.length; k++) {
                const el = 格们C[k];
                let 文C = '';
                try { 文C = String(el.textContent || '').trim(); } catch (e) { void e; }
                let 有标记 = false;
                try { 有标记 = !!(el.querySelector && el.querySelector(标记选择器)); } catch (e) { void e; }
                if (文C && !有标记) { 格C = el; break; }
              }
              if (!格C) {
                // ⛔ 不记通过：没有纯文本格就测不了，红着让人看见。
                记('Q34c 行末光标仍**看得见**（剩余可见宽 ≥ 1 px，⛔ 不许被格子的水平裁剪切光）',
                  false, '这张表的格子里没有**纯文本格**（都带行内标记/为空）⇒ 这条测不了');
              } else {
                const 末C = 文本右界(格C);
                const 盒C = 格C.getBoundingClientRect();
                const xC = Math.round((末C ? 末C.right : 盒C.right) - 1);
                const yC = 末C
                  ? Math.round((末C.top + 末C.bottom) / 2)
                  : Math.round(盒C.top + 盒C.height / 2);
                const 目标C = 按34(xC, yC);
                const 宿主C = 目标C ? await waitFor(单元格宿主, 4000) : null;
                await frames(2);
                const 光标C = 宿主C ? 宿主C.querySelector('.cm-rmd-caret') : null;
                let 剩C = -1;
                let 裁C = '';
                if (光标C) {
                  const cb = 光标C.getBoundingClientRect();
                  剩C = cb.width;
                  for (let n2 = 光标C.parentElement; n2; n2 = n2.parentElement) {
                    const cs = getComputedStyle(n2);
                    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
                    const nb = n2.getBoundingClientRect();
                    const w = Math.min(cb.right, nb.right) - Math.max(cb.left, nb.left);
                    if (w < 剩C) {
                      剩C = w;
                      裁C = String(n2.tagName) + '.' + String(n2.className || '');
                    }
                  }
                }
                记('Q34c 行末光标仍**看得见**（剩余可见宽 ≥ 1 px，⛔ 不许被格子的水平裁剪切光）',
                  光标C !== null && 剩C >= 1,
                  '纯文本格 ' + JSON.stringify(String(格C.textContent || '').trim().slice(0, 24))
                    + '；按下 x=' + xC + ' 命中 ' + String(目标C && 目标C.tagName)
                    + '；光标框 ' + (光标C ? JSON.stringify([
                      Math.round(光标C.getBoundingClientRect().left),
                      Math.round(光标C.getBoundingClientRect().right),
                    ]) : 'null')
                    + '；剩余可见宽 ' + 剩C + ' px；裁它的是 ' + JSON.stringify(裁C));
                if (单元格宿主()) {
                  键(输入框() || document.body, 'Escape');
                  await waitFor(function () { return !主机(); }, 4000);
                }
              }
            }

            // 收尾：退回阅读态（⛔ 别把"某一格还在编辑"留给后面的段）。
            if (单元格宿主()) {
              键(输入框() || document.body, 'Escape');
              await waitFor(function () { return !主机(); }, 4000);
            }
          }
        }
      }
    }

    // ── Q41 逐格扫描：**每一格**进出，表格几何必须逐像素不动（`bugs/0297`）──────
    //
    // ⚠️ 为什么必须有这一段：`Q1`–`Q3` 只点 (0,0) 那一格，`Q21` 的合成长内容又总是最宽的
    //    那一格 ⇒ "换入宿主比原内容**窄**、那一列按内容重算"这条路一条判据都碰不到。
    //    2026-11-09 实测（未修、非最大化窗口、正文宽 446 px）：别的格子会把整表撑高
    //    **+21 / −12 / +63 px**、列宽 **−6 / −80 / −18 px**，下面的块跟着位移。
    // ⚠️ 只进出、不打字：这条判的是"布局冻结"，不是"提交"（Q5/Q6 管那个）。
    //
    // ⚠️⚠️ **基线必须忠实**（`bugs/0299`，2026-11-10 改）：假后端**不渲染 Markdown**
    //    （`fake-tauri.js` 文件头），而 P 段与 Q 段前面那些判据**都提交过**⇒ `#doc` 里
    //    这张表还是**夹具原文**渲出来的，源文却已经往前走了。拿"旧内容的阅读态"去比
    //    "新内容的编辑态"，差的就是两行字、而不是布局 ⇒ 实测假红 **ΔH 42 / 21 px**
    //    （那一版是 `Q14` 往格里写过换行之后）。
    //    ⇒ 逐格比**源文**：`现区间(k)`（按当前全文重算）与 `原区间(k)`（夹具原文）
    //    相同的格才是"阅读态与源文一致"的格，**只有这些格**判 ΔH 与下游位移；
    //    源文改过的格只判 ΔW（`table-layout: fixed` 下列宽与内容无关，且"进出同一刻"
    //    前后对照本身是自洽的）。⛔ 不是调 TOL、⛔ 也不是只扫单行格。
    //    ⚠️ 一格都没剩下就**判红**（"可判 0 格"是覆盖缺口，⛔ 不是通过）。
    {
      const 格们 = 格();
      let 最坏高 = 0;
      let 最坏列 = 0;
      let 最坏顶 = 0;
      let 最坏条 = 0;
      let 最坏格 = '';
      let 最坏条格 = '';
      let 试过 = 0;
      let 可判高 = 0;
      let 落伍 = 0;
      const 落伍格 = [];
      /** 夹具原文里第 `idx` 格的字（`区间` 的行号与列序都取自**加载时**的载荷）。 */
      function 原区间(idx) {
        const 行号 = 区间[idx][0];
        const 行 = String(原.split('\n')[行号 - 1] || '');
        let k = 0;
        for (let i = 0; i < idx; i++) if (区间[i][0] === 行号) k++;
        const 切 = window.__FAKE && window.__FAKE.切格;
        const gs = 切 ? 切(行, 行格数(行号)) : [];
        const g = gs[k];
        return g ? 行.slice(g[0], g[1]) : null;
      }
      for (let k = 0; k < 格们.length; k++) {
        // 上一格必须真的退干净，否则"前"量到的是别人留下的编辑态。
        if (单元格宿主()) {
          键(输入框() || document.body, 'Escape');
          await waitFor(function () { return !主机(); }, 4000);
          await frames(2);
        }
        const 格k = 格()[k];
        if (!格k) continue;
        // ⚠️ 源文与夹具原文不同的格 ⇒ 这一格的阅读态 DOM 已经落后（假后端不重渲）。
        //    ⚠️ 取不到两边任何一边（前面的段落提交挪过行号）**同样按落伍算**：那是
        //    "这一格对不上"，⛔ 不是"这一格没问题"——宁可少判一格，也不给假红开门。
        const 现 = 现区间(k);
        const 铸 = 原区间(k);
        const 这格落伍 = !现 || 铸 === null || 现.text !== 铸;
        const 前高 = 表高();
        const 前列 = 列宽();
        const 前几 = 几何();
        const 前条 = 滚动条厚();
        点(格k);
        const hk = await waitFor(单元格宿主, 2000);
        if (!hk) continue;
        await frames(2);
        试过++;
        const 后高 = 表高();
        const 后条 = 滚动条厚();
        const 后列 = 列宽();
        const 后顶 = 下游最大位移(前几, 几何(), 表 + 1);
        const 文字k = String(格k.textContent || '').trim().slice(0, 12);
        键(输入框() || document.body, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
        await frames(2);
        let d列 = 0;
        for (let i = 0; i < Math.max(前列.length, 后列.length); i++) {
          d列 = Math.max(d列, Math.abs((前列[i] || 0) - (后列[i] || 0)));
        }
        const d高 = Math.abs(后高 - 前高);
        const d条 = Math.abs(后条 - 前条);
        if (这格落伍) { 落伍++; 落伍格.push(k); }
        else 可判高++;
        // ⭐ 落伍格只把**列宽**记进最坏值：ΔH / 下游在旧内容基线上没有意义（见上）。
        const 计高 = 这格落伍 ? 0 : d高;
        const 计顶 = 这格落伍 ? 0 : 后顶;
        if (计高 > 最坏高 || d列 > 最坏列 || 计顶 > 最坏顶) {
          最坏格 = '第 ' + k + ' 格「' + 文字k + '」：'
            + (这格落伍 ? '（源文已改，ΔH/下游不判）' : '')
            + 'ΔH ' + 四舍(d高) + ' / ΔW ' + 四舍(d列) + ' / Δ下游 ' + 四舍(后顶) + ' px';
        }
        if (d条 > 最坏条) {
          最坏条格 = '第 ' + k + ' 格「' + 文字k + '」：Δ滚动条 '
            + 四舍(后条 - 前条) + ' px（前 ' + 四舍(前条) + ' / 后 ' + 四舍(后条) + '）';
        }
        最坏高 = Math.max(最坏高, 计高);
        最坏列 = Math.max(最坏列, d列);
        最坏顶 = Math.max(最坏顶, 计顶);
        最坏条 = Math.max(最坏条, d条);
      }
      记('Q41 逐格进入编辑：表格高度 / 列宽 / 下游位置逐像素不动（`bugs/0297`）',
        试过 > 0 && 试过 === 格们.length && 可判高 > 0
          && 最坏高 <= 1 && 最坏列 <= 1 && 最坏顶 <= TOL,
        '扫了 ' + 试过 + '/' + 格们.length + ' 格；'
          + '可判高度 ' + 可判高 + ' 格'
          + (落伍 ? '（' + 落伍 + ' 格源文已改、假后端不重渲 ⇒ 只判列宽：' + 落伍格.join(',') + '）' : '')
          + '；最坏 ΔH ' + 四舍(最坏高) + ' px / ΔW ' + 四舍(最坏列)
          + ' px / Δ下游 ' + 四舍(最坏顶) + ' px'
          + (最坏格 ? '；' + 最坏格 : ''));
      // ⭐ 与 `Q41` 分开立一条：`Q41` 量"表高"，会被**这一格自己的内容变了**污染
      //    （`bugs/0299`：`Q14`/`Q15` 往格里写过换行，假后端不重渲 ⇒ 拿旧内容的阅读态当基线），
      //    而这里量的是**滚动条厚度**，与内容无关。`bugs/0027` 的 12 px 只可能是它。
      记('Q41b 逐格进入编辑：⛔ 不新分配横向滚动条（`bugs/0027` 的 12 px 只可能长在这里）',
        试过 > 0 && 试过 === 格们.length && 最坏条 <= 0.5,
        '扫了 ' + 试过 + '/' + 格们.length + ' 格；最坏 Δ滚动条 ' + 四舍(最坏条) + ' px'
          + (最坏条格 ? '；' + 最坏条格 : ''));
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
    const 数 = 块节点().length;
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
    // ⚠️⚠️ **先把挑中的块滚进视口**（与 B 段同一条理由，2026-11-11 实测）：R 段从前没做这一步，
    //    bigblock 的 2000 行代码块可以在**屏幕外**被点中 ⇒ `coordsAtPos` 返回估算几何
    //    （实测双击行 y=20474.96、视口高 1600），拖点被夹进视口后落到**上一行**，
    //    `R1b` 的选区退化成 6…11 反向 ⇒ 台架假红（不是产品不跟手）。
    try { 块节点()[挑].scrollIntoView({ block: 'start', inline: 'nearest' }); } catch (e) { void e; }
    await frames(1);
    const 旧 = 主机();
    点(块节点()[挑]);
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
    const 文 = V.state.doc.toString();

    // ── 取词面（`bugs/0098`）：**只从可见区间里取** ────────────────────────
    //
    // ⚠️⚠️ 为什么要先算可见区间：`design/0061` L1 之后围栏行**恒定塌成 0 高**，
    //    而块源码以 ```js 开头时，全文第一个 ASCII 词是围栏的 **info string**（`js`）。
    //    旧写法直接取它 ⇒ `coordsAtPos` 给出的是**下一行**的几何，双击选中的是 `const` / `fn`，
    //    `R1`/`R1b` 假红（2026-11-05 实测 bigblock / blankmd / longcode 五条）。
    //
    // ⭐ "哪些位置不可见"**只由产品自己那份计划回答**：
    //    `liveMarks.markers()` 给出计划（`ranges` 标记区间 ＋ `fenceLines` / `collapsedLines`），
    //    `liveSelection.legalRanges()` 再把围栏行 / Setext 行编成 `[行首-1, 行末+1]` 的伪区间
    //    —— **与产品落点吸附用的是同一份集合** ⇒ ⛔ 本函数不另立"哪一行是围栏"的规则。
    //    ⚠️ 产品把隐藏算错时 `R1` 会**跟着红**：那是**该红的**（本条只修探针取词面）。
    const LM = window.rmd && window.rmd.liveMarks;
    const LS = window.rmd && window.rmd.liveSelection;
    let 隐藏 = null;
    const 树 = 造树(文);
    if (树 && LM && LS && typeof LM.markers === 'function' && typeof LS.legalRanges === 'function') {
      try {
        const 计划 = LM.markers(文, { tree: 树 });
        if (计划 && Array.isArray(计划.ranges)) {
          隐藏 = LS.legalRanges(V, { plan: function () { return 计划; } }) || [];
        }
      } catch (e) { void e; 隐藏 = null; }
    }
    if (!隐藏) {
      摘要.R = { 适用: false, 原因: '取不到产品 markers()/legalRanges()，无法判断可见区间' };
      await 收尾();
      return;
    }
    /** 半开区间 `[from, to)` 与任一隐藏区间相交吗（伪区间多出的 ±1 只会**更保守**）。 */
    function 在隐藏里(from, to) {
      for (let i = 0; i < 隐藏.length; i++) {
        if (from < 隐藏[i].to && to > 隐藏[i].from) return true;
      }
      return false;
    }
    /** 旧写法（`bugs/0098` 之前）会取到的那一个词：全文第一个 ASCII 词。只用于反向自证。 */
    function 旧取词() {
      const m0 = /[0-9A-Za-z_]{2,}/.exec(文);
      if (!m0 || m0.index + m0[0].length >= 文.length) return null;
      return { 起: m0.index, 长: m0[0].length, 文本: m0[0] };
    }
    // ① 优先**可见的 ASCII 词**（双击才会选中"一个词"）：
    //    跳过隐藏区间里的命中（围栏 info string 就是这样被排除的）。
    let 词起 = -1;
    let 词长 = 0;
    const 词式 = /[0-9A-Za-z_]{2,}/g;
    let mm;
    while ((mm = 词式.exec(文)) !== null) {
      const 起0 = mm.index;
      const 长0 = mm[0].length;
      if (在隐藏里(起0, 起0 + 长0)) continue;
      if (文.length < 起0 + 长0 + 2) continue;   // 后面还得有字可拖（见下）
      词起 = 起0; 词长 = 长0;
      break;
    }
    // ② 没有可见 ASCII 词就退回汉字分支（`wordAt` 对汉字只取一个字）。
    if (词起 < 0) {
      const 汉式 = /[㐀-䶿一-鿿]/g;
      let c;
      while ((c = 汉式.exec(文)) !== null) {
        const 起0 = c.index;
        if (在隐藏里(起0, 起0 + 1)) continue;
        if (文.length < 起0 + 1 + 2) continue;
        词起 = 起0; 词长 = 1;
        break;
      }
    }
    if (词起 < 0) {
      摘要.R = { 适用: false, 原因: '这一块里没有可双击的**可见**片段（隐藏区间/围栏行已排除）' };
      await 收尾();
      return;
    }
    const 双击位 = 词起 + (词长 > 1 ? 1 : 0);
    const 新词 = { 起: 词起, 长: 词长, 文本: 文.slice(词起, 词起 + 词长), 双击位: 双击位 };

    // ⭐ 反向自证（`bugs/0098` §6 第 2 条）：旧写法取到的第一个 ASCII 词若在隐藏区间里，
    //    今天这条取词**必须没选它** —— 把取词改回"先命中围栏 info string"时这里当场红。
    //    ⚠️ 旧写法本来就没命中隐藏区间时（无围栏的夹具）本条只如实记录，⛔ 不算"验过"。
    const 旧词 = 旧取词();
    const 旧隐藏 = !!旧词 && 在隐藏里(旧词.起, 旧词.起 + 旧词.长);
    const 自证该红 = 旧隐藏 ? (旧词.起 === 词起) : false;
    记('R1-取词自证 取词避开了隐藏区间（旧写法命中围栏 info string 时必红）',
      !自证该红 && !在隐藏里(词起, 词起 + 词长),
      '旧写法首个 ASCII 词 ' + (旧词 ? '「' + 旧词.文本 + '」@' + 旧词.起 + '…' + (旧词.起 + 旧词.长) : '无')
        + '；在隐藏区间里=' + 旧隐藏 + '；今天取 ' + JSON.stringify(新词)
        + '；隐藏区间数 ' + 隐藏.length);

    let c0 = V.coordsAtPos(双击位, 1);
    if (!c0) {
      记('R1 双击选中一个词', false, '取不到偏移 ' + 双击位 + ' 的几何（coordsAtPos 返回 null）');
      await 收尾();
      return;
    }
    // ⚠️⚠️ **取词那一行要离窗口上沿远一点**（2026-11-10）：`selection.js::步进` 把
    //    指针进入窗口上/下 **28 px** 的带子判成"自动滚动"⇒ 它只滚容器、再按滚动后的
    //    几何重算头部，指针底下还是同一行 ⇒ **头一步都不前进**，`R1b` 假红
    //    （实测：块被滚到视口顶、拖点 y=2 ⇒ 头 202 → 202、锚点 88 → 88）。
    //    ⇒ 这一行离顶不足 80 px 时先把容器往上推一点，再重取几何；⛔ 不改判据。
    if (c0.top < 80) {
      const 差 = 80 - c0.top;
      const 体 = document.body;
      const 根 = document.scrollingElement || document.documentElement;
      if (体) 体.scrollTop = Math.max(0, 体.scrollTop - 差);
      if (根 && 根 !== 体) 根.scrollTop = Math.max(0, 根.scrollTop - 差);
      await frames(1);
      c0 = V.coordsAtPos(双击位, 1) || c0;
    }
    const y0 = (c0.top + c0.bottom) / 2;
    const x0 = c0.left;
    // ⭐ R3/R3b 要在**退出编辑态之后**再点同一处（`bugs/0333`）。⚠️ 绝对坐标在那时已经不可信：
    //    退出会重建 DOM，本段前面几个小节还可能滚过页面（`R2` 会把块滚进视口）——`edges`
    //    实测块顶从 96 挪到了 356 ⇒ 同一个 `x0,y0` 落到**别的块**上，判据假红。
    //    ⇒ 记下**点位相对块盒的偏移**，落地前按新块盒换算回绝对坐标。
    const 框R0 = 块节点()[挑] ? 块节点()[挑].getBoundingClientRect() : null;
    const 偏R = 框R0 ? { dx: x0 - 框R0.left, dy: y0 - 框R0.top } : null;

    // ── R1 双击选词 ────────────────────────────────────────────────
    //  ⚠️ 必须派到 **`V.dom`**（CM6 自己的根），⛔ 不是 `.cm-rmd-liveHost`：
    //    `host` 是产品自己那个 div（`main.js::makeLiveView`），`installMouse` 挂的是
    //    `view.dom` 上的 **capture** 监听 —— 打在 `host` 上的事件**根本到不了它**
    //    （capture 是从外往里，target 在 host 时 view.dom 不在路径上）。
    //  ⚠️ `detail: 2` 才走产品 `installMouse::down()` 的双击分支；只发 `click` 是**另一条路**。
    派(V.dom, 'mousedown', x0, y0, { detail: 2 });
    await frames(1);
    const 选1 = V.state.selection.main;
    // ⭐ 严格口径（`bugs/0098` §5 第 2 条）：选区**恰好等于该可见词的边界**。
    //    旧口径（"包含双击位且长度 ≥ 词长"）把"期望值"和"几何"拆开 ⇒ 隐藏行上会假绿/假红。
    const 选中词 = 选1.from === 词起 && 选1.to === 词起 + 词长;
    记('R1 双击真的选中了一个词（⛔ 不是只放了个光标）', 选中词,
      '双击位 ' + 双击位 + '（可见词「' + 新词.文本 + '」 ' + 词起 + '…' + (词起 + 词长)
        + '，' + (旧隐藏 ? '旧写法会取到隐藏的「' + 旧词.文本 + '」' : '旧写法同样取这个词')
        + '）→ 选区 ' + 选1.from + '…' + 选1.to + '；块内「' + 文.slice(0, 16) + '…」');

    // ── R1b 双击之后**继续拖** ─────────────────────────────────────
    //  ⚠️ 拖到"词末尾再往后几个字符"的几何上，⛔ 不是拖到块末尾：块可能有好几屏，
    //    块末尾的几何在视口外（`coordsAtPos` 取不到）。
    const 目标位 = Math.min(文.length, 词起 + 词长 + 4);
    const c1 = V.coordsAtPos(目标位, 1);
    const 拖x = c1 ? c1.left : Math.min(window.innerWidth - 8, x0 + 90);
    // ⚠️ 同样的 28 px 带子：⛔ 别让拖点落进去（落进去就是"自动滚动"，不是"拖选"）。
    const 拖y = Math.min(Math.max(c1 ? (c1.top + c1.bottom) / 2 : y0, 40), window.innerHeight - 40);
    派(V.dom, 'mousemove', 拖x, 拖y, { detail: 0 });
    await frames(2);
    const 选2 = V.state.selection.main;
    记('R1b 双击之后**继续拖**，选区跟着走（锚点＝可见词左界、头越过词右界）',
      选2.anchor === 词起 && 选2.head > 词起 + 词长,
      '头 ' + 选1.head + ' → ' + 选2.head + '；锚点 ' + 选1.anchor + ' → ' + 选2.anchor
        + `（锚点应停在可见词左界 ${词起}；拖到偏移 ${目标位} 的几何 x=${Math.round(拖x)} y=${Math.round(拖y)}；`
        + '双击的是可见词「' + 新词.文本 + '」 ' + 新词.起 + '…' + (新词.起 + 新词.长) + '）'
        // ⚠️ 三个几何同时记：拖点被**夹进视口**（`innerHeight - 40`）时，若目标行本来就在
        //    视口下沿之外，夹完的 y 落到**上一行** ⇒ 选区退化成"没有前进"。
        //    没有这三个数，"台架夹取"与"产品不跟手"输出一模一样。
        + '；几何 双击行 y=' + 四舍(y0) + ' / 目标行 y=' + (c1 ? 四舍((c1.top + c1.bottom) / 2) : 'null')
        + ' / 视口高 ' + window.innerHeight + ' / 夹取后 y=' + 四舍(拖y));

    // ── R2 拖到窗口下边缘 ⇒ 自动滚动 ───────────────────────────────
    //  ⚠️ 前提是**页面可滚**；不可滚的夹具记 `摘要.R.自动滚动 = false` 且⛔ 不产判据
    //    （"页面本来就没得滚"与"自动滚动不工作"输出一模一样 ⇒ 不能记通过，也不能记跳过）。
    摘要.R.自动滚动 = 滚动上限() > 1;
    if (摘要.R.自动滚动) {
      // ⚠️ **下边缘之外得有滚的余地**（2026-11-11 实测）：R 段进来时会把挑中的块
      //    `scrollIntoView({block:'start'})`（见上面那条，修 `bigblock/R1b`），短夹具上
      //    这一滚可能**直接到底**——`edges` 只有 17 px 余量、位置已经贴在上限 ⇒ 拖到下边缘
      //    也没得滚，`R2` 会假红成"产品不自动滚"（实测 滚动位置 17 → 17）。
      //    ⇒ 已在底部附近时先滚回顶部：本条只问"拖到下边缘会不会滚"，⛔ 不问从哪一格出发。
      if (滚动上限() - 滚动位置() < 80) {
        if (document.body) document.body.scrollTop = 0;
        if (document.documentElement) document.documentElement.scrollTop = 0;
        await frames(1);
      }
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

    // ── R3 阅读态双击（`bugs/0333`）──────────────────────────────────────
    //
    // ⭐ 用户 2026-11-18 原话：「引用模块中的内容，双击没有办法选中整段。」
    //    病根不在词表、也不是几何：阅读态那一下 `mousedown` 已经 `preventDefault` 掉了原生词选
    //    （`INV-LIVE-12`），而 `live.begin` 是异步建视图的 ⇒ **双击的两次点击往往都在视图
    //    就绪之前完成**，宿主记下的手势带着 `released === true` 到达 `installMouse`；
    //    旧代码只让"第一次 `mousemove`"接手拖拽 ⇒ 纯双击没有 move，**那个词一个字节都没选上**。
    //    ⇒ 这里把**同一块**退回阅读态，在**同一个词**的屏幕坐标上派一次双击（`detail: 2`），
    //      等新宿主建好，检查选区是否**恰好**是该可见词。
    //    ⚠️ 坐标**不能沿用 R1 的绝对值**（页面前面可能滚过、退出还会重建 DOM）：
    //      按记下的**块内偏移**换算到新块盒上，并核对它仍落在这块里。
    //    ⚠️ 两次点击**同步连着派**：这正是"第二次点击早于视图就绪"的形态；整条链
    //      （`#doc` 的 mousedown → `noteDownGesture` → `live.begin` → `installMouse`）
    //      全是产品自己的代码，⛔ 探针不碰选区。
    if (主机()) 键(输入框() || document.body, 'Escape');
    const 退出2 = await waitFor(function () { return !主机(); }, 4000);
    await frames(1);
    const 节点2 = 块节点()[挑];
    const 框2 = 节点2 ? 节点2.getBoundingClientRect() : null;
    /** 按块内偏移换算回绝对点位；没有偏移记录就退回 R1 的绝对值。 */
    const 点R = function (框) {
      if (!框) return null;
      if (!偏R) return { x: x0, y: y0 };
      return { x: 框.left + 偏R.dx, y: 框.top + 偏R.dy };
    };
    const 点2 = 点R(框2);
    if (!退出2 || !节点2 || !框2 || !点2
      || 点2.x < 框2.left || 点2.x > 框2.right || 点2.y < 框2.top - 1 || 点2.y > 框2.bottom + 1) {
      // ⚠️ 前置不成立 ⇒ `跳过`（⛔ 不改记通过，也⛔ 不记失败）：这条问的是"双击选中一个词"，
      //    连"同一块、同一处"都摆不出来时它验不了任何东西。
      跳过('R3 阅读态双击选中一个词（`bugs/0333`）',
        '前置不成立：' + (!退出2 ? '退出编辑态超时' : !框2 ? '块节点不见了'
          : '点位 ' + 四舍(点2 ? 点2.x : x0) + ',' + 四舍(点2 ? 点2.y : y0)
          + ' 不在块 ' + 挑 + ' 的盒子里（' + 四舍(框2.left) + '…' + 四舍(框2.right) + ' × '
          + 四舍(框2.top) + '…' + 四舍(框2.bottom) + '）'));
    } else {
      const 双击 = function (type) {
        return new MouseEvent(type, {
          bubbles: true, cancelable: true, button: 0, view: window,
          buttons: type === 'mouseup' ? 0 : 1,
          clientX: Math.round(点2.x), clientY: Math.round(点2.y), detail: 2,
        });
      };
      节点2.dispatchEvent(双击('mousedown'));
      节点2.dispatchEvent(双击('mouseup'));
      const host2 = await waitFor(function () {
        const h = 主机();
        return h && h !== host ? h : null;
      }, 4000);
      const V2 = host2 ? 视图(host2) : null;
      if (!V2) {
        记('R3 阅读态双击选中一个词（`bugs/0333`）', false, '双击之后等不到新宿主');
      } else {
        await frames(3);
        const 选3 = V2.state.selection.main;
        const 原样 = V2.state.doc.toString() === 文;
        记('R3 阅读态双击选中一个词（`bugs/0333`）', 原样 && 选3.from === 词起 && 选3.to === 词起 + 词长,
          '双击位 ' + 双击位 + '（可见词「' + 新词.文本 + '」 ' + 词起 + '…' + (词起 + 词长) + '）→ 选区 '
            + 选3.from + '…' + 选3.to
            + (原样 ? '' : '；⚠️ 退出再进来之后块文本变了 ⇒ 词区间不可比'));
        // 收尾：退出这一个（⛔ 别把失败留在屏幕上）
        if (主机()) 键(输入框() || document.body, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
      }
    }

    // ── R3b **完整双击**（两次按下 ＋ 两次松开，`bugs/0333`）─────────────────
    //
    // ⭐ R3 只派"第二次点击"；真实的双击是**两对**事件，而**每一次** `mousedown` 都会
    //    各排一次 `live.begin`（`liveSerial` 串行）⇒ 第一个 begin 建好视图之后，第二个
    //    begin 还会走 `leave('switch')`：提交 ＋ 整篇重渲 ＋ 换宿主。如果那一路把
    //    R3 刚落下的词选冲掉，用户看到的仍然是"双击没选中"。
    //    ⇒ 这一段必须派**两对**且**同步连着派**（最坏形态：两次点击都在视图就绪之前）。
    await frames(1);
    const 节点3 = 块节点()[挑];
    // ⚠️ 与 R3 同一条：绝对坐标已经不可信，按块内偏移换算（`点R`）。
    const 框3 = 节点3 ? 节点3.getBoundingClientRect() : null;
    const 点3 = 点R(框3);
    if (!节点3 || !框3 || !点3
      || 点3.x < 框3.left || 点3.x > 框3.right || 点3.y < 框3.top - 1 || 点3.y > 框3.bottom + 1) {
      跳过('R3b 完整双击（两次点击都在视图就绪之前）仍然选中那个词',
        !节点3 ? '块节点不见了'
          : '前置不成立：点位 ' + 四舍(点3 ? 点3.x : x0) + ',' + 四舍(点3 ? 点3.y : y0)
            + ' 不在块 ' + 挑 + ' 的盒子里');
    } else {
      const 一击 = function (type, detail) {
        return new MouseEvent(type, {
          bubbles: true, cancelable: true, button: 0, view: window,
          buttons: type === 'mouseup' ? 0 : 1,
          clientX: Math.round(点3.x), clientY: Math.round(点3.y), detail: detail,
        });
      };
      节点3.dispatchEvent(一击('mousedown', 1));
      节点3.dispatchEvent(一击('mouseup', 1));
      节点3.dispatchEvent(一击('mousedown', 2));
      节点3.dispatchEvent(一击('mouseup', 2));
      // ⚠️ 要把**第二次** `begin` 也等完：先等宿主出现，再多给若干帧让它换掉。
      await waitFor(function () { return !!主机(); }, 4000);
      await frames(20);
      const host3 = 主机();
      const V3 = host3 ? 视图(host3) : null;
      if (!V3) {
        记('R3b 完整双击（两次点击都在视图就绪之前）仍然选中那个词', false, '双击之后等不到视图');
      } else {
        const 选4 = V3.state.selection.main;
        const 原样3 = V3.state.doc.toString() === 文;
        记('R3b 完整双击（两次点击都在视图就绪之前）仍然选中那个词',
          原样3 && 选4.from === 词起 && 选4.to === 词起 + 词长,
          '双击位 ' + 双击位 + '（可见词「' + 新词.文本 + '」 ' + 词起 + '…' + (词起 + 词长) + '）→ 选区 '
            + 选4.from + '…' + 选4.to
            + (原样3 ? '' : '；⚠️ 块文本变了 ⇒ 词区间不可比')
            + '；begin_edit 调用 ' + (window.__IPC || []).filter(function (x) {
              return x && x.cmd === 'begin_edit';
            }).length + ' 次');
        // 收尾：退出这一个（⛔ 别把失败留在屏幕上）
        if (主机()) 键(输入框() || document.body, 'Escape');
        await waitFor(function () { return !主机(); }, 4000);
      }
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
    if (!块节点()[块] || !区间.length) {
      摘要.V = { 适用: false, 原因: '块 ' + 块 + ' 不在 DOM 里，或区间为空' };
      return;
    }

    function 方框() {
      const n = 块节点()[块];
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
    const 所有项 = Array.prototype.slice.call(块节点()[块].querySelectorAll('li'));
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
    const 表 = 块节点();
    const rows = [];
    for (let i = 0; i < 表.length; i++) {
      const el = 表[i];
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
      // ⭐ 折行判据真正依赖的就是这三个属性（`bugs/0302`）：⛔ 别只看类名猜。
      row.排版 = (function () {
        const cs = getComputedStyle(cn);
        const ln = host.querySelector('.cm-line');
        const ls = ln ? getComputedStyle(ln) : null;
        return {
          content类: String(cn.className || ''),
          ws: cs.whiteSpace, ow: cs.overflowWrap, wb: cs.wordBreak, shrink: cs.flexShrink,
          行ws: ls ? ls.whiteSpace : null, 行ow: ls ? ls.overflowWrap : null, 行wb: ls ? ls.wordBreak : null,
        };
      })();
      // ⚠️ 诊断要能分辨「标记藏了没有」：藏掉之后 `textContent` 里就没有那些字符了。
      //    ⛔ 这不是判据，只是给"这块为什么高了 23.8 像素"取证用。
      row.块内文本 = 块内文本(host).slice(0, 200);
      // ⭐ 2026-11-09（`bugs/0302` 取证）：**换行与任务框的几何**。
      //    ⛔ 不是判据，只是回答"长任务项为什么把字全挤到第二行、续行为什么跑到方框下面"。
      //    ⚠️ 用 `Range` 取**每一视觉行**的矩形（块级元素的 `getClientRects()` 只给一个盒子）。
      row.行几何 = Array.prototype.map.call(host.querySelectorAll('.cm-line'), function (ln) {
        const rg = document.createRange();
        rg.selectNodeContents(ln);
        const rs = rg.getClientRects();
        const 段 = [];
        for (let i = 0; i < rs.length; i++) {
          const r = rs[i];
          if (!r || (r.width === 0 && r.height === 0)) continue;
          const last = 段[段.length - 1];
          if (last && Math.abs(last[1] - r.top) < 1) {
            last[2] = 四舍(Math.max(last[0] + last[2], r.left + r.width) - last[0]);
          } else {
            段.push([四舍(r.left), 四舍(r.top), 四舍(r.width)]);
          }
        }
        return { 文: String(ln.textContent || '').slice(0, 24), 视觉: 段 };
      });
      row.框几何 = Array.prototype.map.call(host.querySelectorAll('.cm-rmd-taskbox-wrap'), function (w) {
        const b = w.getBoundingClientRect();
        const ln = w.closest('.cm-line');
        let 首字 = null;
        // ⚠️⚠️ 2026-11-09（`bugs/0302` 取证）：**⛔ 别只读 `w.nextSibling`**——方框后面
        //    可能夹着空文本节点 / 隐藏标记层，那个兄弟不一定是正文 ⇒ 诊断恒报 `首字: null`
        //    （当天的诊断日志四行全是 null，与判据 `W11l` 量到的几何对不上）。
        //    改为在整行里找**第一个非空白字符**，与判据 `量首字31` 同一把尺。
        if (ln) {
          const 走 = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT, null);
          let n;
          while ((n = 走.nextNode())) {
            if (w.contains(n)) continue;
            const v = String(n.nodeValue || '');
            let i = 0;
            while (i < v.length && /\s/.test(v[i])) i++;
            if (i >= v.length) continue;
            const rg = document.createRange();
            rg.setStart(n, i);
            rg.setEnd(n, i + 1);
            const r0 = rg.getBoundingClientRect();
            首字 = [四舍(r0.left), 四舍(r0.top)];
            break;
          }
        }
        return {
          框: [四舍(b.left), 四舍(b.top), 四舍(b.width), 四舍(b.height)],
          行左: ln ? 四舍(ln.getBoundingClientRect().left) : null,
          行宽: ln ? 四舍(ln.getBoundingClientRect().width) : null,
          首字: 首字,
        };
      });
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
          // ⚠️ `design/0061` L1 起隐藏集合与选区无关（`activeLines` 已删除）。
          return LM.markers(body, { tree: 造树(body) }).ranges.length;
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
      doc: 样式(docEl()),
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
   * ⛔ **2026-11-09 定位变更**：X 段现在**只**证明"兜底那一支没坏"，⛔ 不再证明"锚定补偿是正确行为"。
   *    按 `INV-LIVE-04` ① 与 ②（`design/0047` §5），进入瞬间下游根本不该位移，也就**不该有**
   *    需要补偿的量。⇒ ① 本段保留，作为"万一还有位移，至少别让它把人带到别处"的回归网；
   *    ② **真正的判据是 `B{i}-3a`（块高不动）/`B{i}-4`（自身 top）/`B{i}-5`（下游）/`B{i}-6`（滚动）**；
   *    ③ 每一条"靠补偿接住"的实录（`摘要.X.补偿 > 0`）在缺陷账上都算**待修事实**
   *    （`bugs/0298` / `bugs/0021`），⛔ 不许当作"功能正常"的证据。
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
    const 数 = 块节点().length;
    for (let i = 0; i < p.blocks.length && i < 数; i++) {
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

    const node = 块节点()[k];
    try { node.scrollIntoView({ block: 'start', inline: 'nearest' }); } catch (e) { void e; }
    await frames(1);
    const 滚动前 = 滚动量();
    const 锚点0 = 首字顶(node);

    const ev = 点(node);
    记('X0b 点击被接管', !!ev.defaultPrevented, ev.defaultPrevented ? '' : '没走到"进入"那一支');
    const host = await waitFor(主机, 4000);
    await frames(3);
    const 锚点1 = 首行字顶(host);
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

  // ── Y 段：**进入编辑态不显示源码、不改变行几何**（`design/0061` §5 `INV-LIVE-14`）──
  /**
   * ⭐ `design/0061` 的核心承诺：**阅读态点进编辑态，画面不重排**。
   *
   * 两条判据各判一面，⛔ 不合并：
   *   ① `Q35` —— 活动行**也不许**把 Markdown 源码露出来（旧形态是"光标那几行显示源码"）；
   *      负对照 `Q35b` 证明这一块的源码里**真的有标记**，否则 `Q35` 恒绿、没有承重价值。
   *   ② `Q36` —— 进入前后**逐视觉行**比**块内相对 top** / `height` / 可见文本（容差 0.5 px），
   *      **绝对 top 也判**（⛔ 2026-11-09 起：进入瞬间逐像素不动，含滚动锚，见 `INV-LIVE-04` ①）。
   *      ⚠️ 旧注说"整块在视口里移动是**允许的**（`anchorAt`）"——那是把**兜底手段**读成合规，
   *      已作废：`anchorAt` 只在布局真的动了之后把光标钉回来，而布局动本身就是缺陷。
   *      块**之外**的位移仍归 `D2` / `B*-5`，这里只判这一块自己的绝对落点与滚动量。
   *
   * ⚠️⚠️ 判"可见"必须按 `Range` 矩形的**宽高 > 0**（见 `可见行带()` 的注释）：
   *    拿 `textContent` 判会把 `Decoration.replace` 藏掉的字符也数进去 ⇒ 恒绿。
   * ⚠️ 阅读态没有 `.cm-line` ⇒ "行"取**视觉行**（两边同一把尺），编辑态的折行同样归带。
   * ⚠️ 没有"首行带行内标记的可编辑块"时记 `摘要.Y.适用 = false`：
   *    **既不记通过也不记跳过**（记跳过会让整轮退出码恒为 2）。
   */
  async function 跑编辑态恒等(base, 摘要) {
    const 选 = 挑标记块();
    if (!选) {
      摘要.Y = { 适用: false, 原因: '没有首行带行内标记的可编辑块（Q35 的负对照不成立）' };
      return;
    }
    摘要.Y = { 适用: true, 块: 选.i, 标记: 选.记号 };

    const node = 选.node;
    // ⚠️ 与 `跑一块` 同一条理由：先滚进视口再量（屏幕外的行 CM6 只给估算）。
    try { node.scrollIntoView({ block: 'start', inline: 'nearest' }); } catch (e) { void e; }
    await frames(1);

    // —— 进入**之前**：阅读态这一块的视觉行（top / height / 可见文本）——
    const 前 = 可见行带(node);
    // ⭐ 2026-11-11：行内代码的**盒宽**曾是被怀疑的折行点差异源（实测两态逐项相同，
    //    已排除；真因是折行点上的空格，`bugs/0316`）。这份度量留着——下次再怀疑
    //    "某个行内盒把折行点推走"时，先看这里的四个数字，⛔ 别再从头推一遍。
    const 码尺 = function (root, sel) {
      const out = [];
      if (!root || typeof root.querySelectorAll !== 'function') return out;
      const els = root.querySelectorAll(sel);
      for (let i = 0; i < els.length && out.length < 3; i++) {
        const el = els[i];
        if (el.closest && el.closest('pre')) continue;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out.push({ 宽: 四舍(r.width), 高: 四舍(r.height), 字号: cs.fontSize,
          左内: cs.paddingLeft, 右内: cs.paddingRight, 字距: cs.letterSpacing,
          字族: String(cs.fontFamily).slice(0, 24) });
      }
      return out;
    };
    // ⭐ 2026-11-11：两态的**换行模型**（阅读态 `normal` vs CM6 `lineWrapping` 的
    //    `break-spaces`）决定"折行点上的空格挂不悬挂"。一行差一个字的根因就在这里
    //    （`bugs/0316`），所以把它和几何一起记进 `Q36` 的诊断（⛔ 不判红：
    //    单看声明值不能定罪，`Q36` 的文本比较才是判据）。
    const 换行模型 = function (el) {
      if (!el) return null;
      // ⚠️ 阅读态节点可能来自**另一个 document**（探针的注入页 vs 应用页），
      //    用本页的 `getComputedStyle` 取它只会得到空串 ⇒ 先借节点自己的 window。
      const w = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const cs = w.getComputedStyle(el);
      // ⚠️ 取不到时把节点名带上——否则空串看起来像"阅读态没设白空格"，那是误读。
      return { 节点: el.nodeName, 白空: cs.whiteSpace || '(未取到)', 断词: cs.wordBreak || '(未取到)',
        溢词: cs.overflowWrap || '(未取到)' };
    };
    // ⚠️ 必须在**进入编辑之前**取：块一旦被换成宿主，阅读态那个节点就脱离文档，
    //    `getComputedStyle` 对它只返回空串（实测）。
    const 前码 = 码尺(node, 'code');
    const 前式 = 换行模型(node);
    // —— Q35b：负对照（源码里确有标记）——
    //   ⚠️ 它**只依赖源码**，所以在"进不去覆盖层"时也必须产出——否则那一份夹具的
    //      "标记确实存在"就没人证，`Y-覆盖` 会把"进不去"重复记一次（那是 Q35/Q36 的账）。
    记('Q35b 负对照：这一块的源码首行真的有标记（否则 Q35 恒绿）', 选.记号.length > 0,
      '标记 ' + JSON.stringify(选.记号) + '；独立 oracle 的可见首行「'
        + String(选.期望0).slice(0, 60) + '」');

    const 滚动前 = 滚动位置();
    const ev = 点(node);
    const host = await waitFor(主机, 4000);
    if (!host) {
      记('Q35 进入编辑态后不显示 Markdown 源码', false,
        '等不到 ' + HOST_SEL + '（begin 被拒或失败）；状态条：' + 状态条());
      记('Q36 进入编辑态不改变行几何', false, '同上：进不去覆盖层');
      摘要.Y.进入 = false;
      return;
    }
    // ⚠️ 与 `B*-3b` 同一个等待口径：产品的锚定要 2–3 帧才落定。
    await frames(3);
    const 后 = 可见行带(host);
    const 后码 = 码尺(host, '.cm-rmd-code');
    const 滚动后 = 滚动位置();
    摘要.Y.滚动 = [四舍(滚动前), 四舍(滚动后)];

    // —— Q35：活动行的源码标记**一个都不许露**（只判首视觉行＝被点的那一行）——
    const 首 = 后.length ? 后[0].text : '';
    const 露 = 选.记号.filter(function (t) { return 首.indexOf(t) >= 0; });
    const 阅读首 = 前.length ? 前[0].text : '';
    记('Q35 进入编辑态后不显示 Markdown 源码（活动行也藏）', 露.length === 0,
      '源码第 1 行的标记 ' + JSON.stringify(选.记号) + ' ⇒ 编辑态首视觉行「'
        + 首.slice(0, 60) + '」' + (露.length ? '里露出 ' + JSON.stringify(露) : '里一个都没有')
        + '；阅读态同行为「' + 阅读首.slice(0, 60) + '」'
        + '；可见性按 Range 逐字矩形的宽高 > 0 判（⛔ 不是 textContent）');
    摘要.Y.标记露没露 = 露;

    // —— Q36：逐视觉行比几何与可见文本（⭐ 块内相对 ＋ 绝对落点，**两样都判**）——
    //    ⚠️⚠️ 比两块：
    //    ① **块内相对 top**（各视觉行相对"这一块第一视觉行"的偏移）——抓"块内部重排了没有"；
    //    ② **绝对 top**（视口坐标）——抓"这一块在屏幕上挪了没有"。
    //    ⛔⛔ **2026-11-09 起 ② 不再是"只记不判"**：旧注写"产品会做滚动锚定（`anchorAt`）⇒
    //    整块在视口里移动是允许的"，那是把兜底读成合规。`INV-LIVE-04` ① 要求进入瞬间
    //    逐像素不动（含滚动锚）⇒ 绝对 top 动了就是缺陷，与"排版有没有变"无关。
    //    滚动量仍单列进摘要，用来区分"只是滚了"（② 红、① 绿）与"重排了"（①② 都红）。
    const 相对 = function (带) {
      const b = 带.length ? 带[0].top : 0;
      return 带.map(function (x) { return 四舍(x.top - b); });
    };
    const 前相 = 相对(前);
    const 后相 = 相对(后);
    const 同数 = 前.length === 后.length;
    let 最大相对顶差 = 0;
    let 最大绝对顶差 = 0;
    let 最大高差 = 0;
    const 文不同 = [];
    // ⚠️ 逐行比的是**去掉首尾空白之后**的文本（2026-11-10）：换行点上的那个空格是
    //    **悬挂**的——阅读态（CSS 行盒）把它留在上一行行尾、编辑态（CM6 的 `.cm-line`）
    //    偶尔把它画在下一行的行首。同一个字、同一个位置，只是"归到哪一行"由排版引擎决定。
    //    ⇒ 不剥掉时 `Q36` 会红在"第 2 行多一个前导空格"上，而两边的 top/height 差 0.016 px。
    //    ⛔ 只剥首尾：行**中间**的空格照旧参与比较（`a b` 与 `ab` 必须判出不同）。
    const 比 = function (x) { return String(x).trim(); };
    for (let k = 0; k < Math.min(前.length, 后.length); k++) {
      最大相对顶差 = Math.max(最大相对顶差, Math.abs(前相[k] - 后相[k]));
      最大绝对顶差 = Math.max(最大绝对顶差, Math.abs(前[k].top - 后[k].top));
      最大高差 = Math.max(最大高差, Math.abs(前[k].height - 后[k].height));
      if (比(前[k].text) !== 比(后[k].text)) 文不同.push(k);
    }
    最大相对顶差 = 四舍(最大相对顶差);
    最大绝对顶差 = 四舍(最大绝对顶差);
    最大高差 = 四舍(最大高差);
    // ⭐ 2026-11-11：折行点差分时，光看"首个不同"看不出**整段**偏移。
    //    把两侧每条视觉行的字数与尾 12 字一起印出来（⛔ 只诊断，不判红）。
    const 行摘要 = function (带) {
      return 带.map(function (x, i) {
        const t = String(x.text);
        return (i + 1) + '[' + t.length + ']' + t.slice(-12);
      });
    };
    const 不同说明 = (function () {
      // ⚠️ 只把**第一条不同**印出来（bigblock 那种块会刷屏）；最多 60 字。
      for (let k = 0; k < Math.min(前.length, 后.length); k++) {
        if (比(前[k].text) !== 比(后[k].text)) {
          const a = String(前[k].text);
          const b = String(后[k].text);
          // ⭐ 2026-11-11：先报**第一个不同的字符偏移**（长段落的前 40 字往往一模一样，
          //    只看开头会以为是同一个字符串 ⇒ 看不到折行点差了几个字）。
          let d = 0;
          while (d < a.length && d < b.length && a.charAt(d) === b.charAt(d)) d++;
          return '第 ' + (k + 1) + ' 行：首个不同在第 ' + d + ' 字（长 '
            + a.length + ' / ' + b.length + '）阅读「' + a.slice(Math.max(0, d - 10), d + 10)
            + '」/ 编辑「' + b.slice(Math.max(0, d - 10), d + 10) + '」';
        }
      }
      return '';
    })();
    记('Q36 进入编辑态不改变行几何（行数 / 块内相对 top / 绝对 top / height / 可见文本逐行相同）',
      同数 && 最大相对顶差 <= TOL && 最大绝对顶差 <= TOL && 最大高差 <= TOL
        && 文不同.length === 0,
      '行数 ' + 前.length + ' → ' + 后.length
        + '；最大 Δ(块内相对 top) ' + 最大相对顶差 + ' px；最大 Δ(绝对 top) ' + 最大绝对顶差
        + ' px；最大 Δheight ' + 最大高差 + ' px（容差 ' + 四舍(TOL) + '，量化下限）'
        + '；可见文本不同的行 ' + (文不同.length ? JSON.stringify(文不同.slice(0, 5)) : '无')
        + (不同说明 ? '；' + 不同说明 : '')
        + '；逐行（字数十尾 12 字）阅读 ' + JSON.stringify(行摘要(前))
        + ' / 编辑 ' + JSON.stringify(行摘要(后))
        + '；换行模型 阅读 ' + JSON.stringify(前式)
        + ' / 编辑 ' + JSON.stringify(换行模型(host.querySelector('.cm-content')))
        + '；行内码 阅读 ' + JSON.stringify(前码) + ' / 编辑 ' + JSON.stringify(后码)
        + '；滚动 ' + JSON.stringify([滚动前, 滚动后])
        + '（⛔ 2026-11-09 起绝对 top 也判：`INV-LIVE-04` ① 进入瞬间逐像素不动，含滚动锚）');
    摘要.Y.行数 = [前.length, 后.length];
    摘要.Y.最大相对顶差 = 最大相对顶差;
    摘要.Y.最大绝对顶差 = 最大绝对顶差;
    摘要.Y.最大高差 = 最大高差;
    摘要.Y.文不同 = 文不同.length;
    摘要.Y.行顶前 = 前.map(function (x) { return x.top; });
    摘要.Y.行顶后 = 后.map(function (x) { return x.top; });

    // —— 退出并确认几何回到基线（后面的 D/N/O 段都以基线为前提）——
    const ta = 输入框();
    if (ta) 键(ta, 'Escape');
    await waitFor(function () { return !主机(); }, 4000);
    await frames(2);
    记('Y0 退出后逐像素回到基线', 几何相等(base, 几何()),
      几何相等(base, 几何()) ? '' : '差异 ' + JSON.stringify(差异(base, 几何())));
  }

  async function runBody() {
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
    // ⚠️ 这里比的是**元素 ＋ 注释**（`bugs/0080`）：只数元素会把块级原始 HTML 漏掉，
    //    在带 `<div>` / 顶格注释的文档上**假红**，而产品其实对得上。
    // ⚠️⚠️ **脚注定义在 DOM 侧会合并**（`bugs/0303` 夹具踩到）：comrak 把**所有**
    //    `FootnoteDefinition` 渲染进文末**同一个** `<section class="footnotes">`
    //    ⇒ 块表里 N 个定义、DOM 里只有 1 个节点。⛔ 这不是"块表与 DOM 对不上"，
    //    而是渲染层的既定合并（`blocks.rs` 把它们切出来单独 parse 得 0 块那件事的另一面）。
    //    ⇒ 期望数按 N−1 折算，N ≤ 1 时不折算（一个定义也是那一个 section）。
    let 脚注定义数 = 0;
    for (let i = 0; i < p.blocks.length; i++) {
      if (String(p.block_kinds[p.blocks[i][0]] || '') === 'FootnoteDefinition') 脚注定义数++;
    }
    const 期望块数 = p.blocks.length - Math.max(0, 脚注定义数 - 1);
    记('A2 块表与 DOM 数量对得上', 块节点().length === 期望块数,
      'DOM（元素＋注释）' + 块节点().length + ' / 块表 ' + p.blocks.length +
      (脚注定义数 > 1 ? '（' + 脚注定义数 + ' 个脚注定义合并成 1 个节点 ⇒ 期望 ' + 期望块数 + '）' : ''));
    记('A3 开关来自快照（live_edit=true）', 计数('begin_edit') === 0,
      '启动时不该有 begin_edit（有 ' + 计数('begin_edit') + ' 次）');
    记('A4 启动时没有覆盖层', !主机(), '');

    // —— LNK 段：点正文里的**链接 / 图片**⛔ 不进编辑（`design/0047` §4.2 / `bugs/0059`）——
    //    ⚠️ 用 `#doc` 里**真实存在**的那个 `<a>`（`blocks.md` 第 7 行的段落里就有一条），
    //    没有链接的夹具记 `适用:false`，⛔ 不记通过。
    //    ⚠️ 判据是**三样**：没进覆盖层、没发起 `begin_edit`、那一次按下**没有被我们拦**
    //    （拦了就等于把链接跳转/看图一起挡掉）。
    //    ⚠️ "守卫是**选择性**的"由随后的 B 段负责：同一个段落块在 B 段里必须照常进得去。
    {
      const 链接 = d.querySelector('a[href]');
      if (!链接) {
        out.摘要.LNK = { 适用: false };
      } else {
        const 前 = 计数('begin_edit');
        const ev = 点(链接);
        await frames(2);
        记('LNK1 点正文链接不进覆盖层', !主机() && 计数('begin_edit') === 前,
          'host=' + !!主机() + ' begin_edit +' + (计数('begin_edit') - 前));
        记('LNK2 点链接那一击没有被 preventDefault（否则跳转被挡）', ev.defaultPrevented === false,
          ev.defaultPrevented ? '被 preventDefault 了' : '');
        out.摘要.LNK = { 适用: true, 链接文本: (链接.textContent || '').slice(0, 24) };
      }
    }

    const base = 几何();
    out.摘要.块数 = p.blocks.length;
    out.摘要.DOM数 = d.children.length;

    // —— S 段：**行内上标的行盒**（`bugs/0303`）——
    //    ⚠️ 必须在**任何一块被点开之前**量：这是纯阅读态的量，一旦有覆盖层挂上来，
    //    `#doc` 里那一块就换人了（`main.js::swapLiveCell` 把原块摘下去）。
    await 跑脚注行盒(out.摘要);

    // —— B 段：逐块进入/退出（editable 的块）；C 段：结构块 ——
    const 可编辑 = [];
    // ⚠️ 循环上界是**块表**，⛔ 不是 `d.children.length`：comrak 把 N 个脚注定义渲染进文末
    //    **同一个** `<section>` ⇒ DOM 比块表少 N−1 个节点（`A2` 同一口径）。旧写法按 DOM
    //    数量截断，超出那几个块**整块跳过** ⇒ `B-覆盖` 报"缺 [8]"，缺的其实是这一条。
    for (let i = 0; i < p.blocks.length; i++) {
      const wire = p.blocks[i];
      const editable = wire[3] === 1;
      if (!块节点()[i] && String(p.block_kinds[wire[0]] || '') === 'FootnoteDefinition') {
        记('C' + i + ' 脚注定义与前一个共用文末那个 <section>（comrak 合并渲染）', true,
          '块表第 ' + i + ' 项；DOM 只有 ' + 块节点().length + ' 个节点（与 A2 同口径）');
        continue;
      }
      if (!editable) {
        const 前 = 计数('begin_edit');
        // ⭐ `design/0049`（2026-11-03 评审修正）：**表格块不是"结构块不能进"**——
        //    点格子就是要进**单元格**编辑，`Table` 块本身仍 `editable = 0`，这是两条入口。
        //    ⚠️⚠️ 旧判据把这一下算成红（`C13 结构块不进覆盖层`），而它**不只报错**：
        //    C 段原先**不退出**（结构块本来就进不去，没什么可退的）⇒ 单元格宿主一路挂到
        //    后面每一块，B 段 `主机()` 抓到的不是自己那一块 ⇒ `.cm-line` 读不到 ⇒
        //    锚点算成 `NaN` ⇒ 整份 JSON 序列化抛异常、**这一份夹具的几百条判据全丢**。
        //    症状是 `make probe-live-block` 在 `tasks.md` 上直接崩掉（2026-11-03 实测）。
        //  ⇒ 表格按"进单元格 ⇒ 判哪一格 ⇒ 退出"走；其余结构块照旧。
        const 是表 = p.block_kinds[p.blocks[i][0]] === 'Table';
        // ⚠️ 注释节点（`INV-SEC-01` 下的块级原始 HTML）**没有几何**：点它的中心会落到
        //    邻居段落上、合法地进入编辑。那不是"结构块进了覆盖层"，而是**点了别的东西**
        //    （`bugs/0080` 的夹具上实测：C2/C4 假红，还留下一段没收尾的编辑态）。
        //    ⇒ 这类块没有"用户能点到它"这回事，⛔ 不记通过也不记跳过。
        const 该块节点 = 块节点()[i];
        if (!该块节点 || 该块节点.nodeType !== 1) {
          记('C' + i + ' 结构块没有可点盒子（注释节点，`INV-SEC-01`）', true,
            'nodeType ' + (该块节点 ? 该块节点.nodeType : 'null') + '；不计入覆盖层判据');
          continue;
        }
        点(该块节点);
        await frames(2);
        const 有host = !!主机();
        if (是表) {
          const 宿主 = 主机();
          const 父 = 宿主 ? 宿主.parentElement : null;
          const 父tag = String((父 && 父.tagName) || '').toUpperCase();
          记('C' + i + ' 表格块点下去进的是**单元格**编辑（`design/0049`，⛔ 不是"结构块不能进"）',
            !!宿主 && (父tag === 'TD' || 父tag === 'TH') && 计数('begin_edit') > 前,
            '宿主=' + (宿主 ? String(宿主.className) : '无')
              + '；父节点=' + (父tag || '无')
              + '；begin_edit +' + (计数('begin_edit') - 前));
          // ⚠️ 必须退出：留在编辑态会污染后面每一块（见上面那段 ⚠️⚠️）。
          const ta = 输入框();
          if (ta) 键(ta, 'Escape');
          await waitFor(function () { return !主机(); }, 4000);
          await frames(1);
        } else {
          记('C' + i + ' 结构块不进覆盖层', !有host && 计数('begin_edit') === 前,
            有host ? '竟然进了覆盖层' : ('begin_edit +' + (计数('begin_edit') - 前)));
        }
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

    // —— T 段：**块贴视口下沿时进入编辑**（2026-11-09 新增，`INV-LIVE-04` ①）——
    // ⚠️ 必须排在 Y 之前：本段会把页面滚到别处（本来就要求"块在下沿"），
    //    而 Y 段自己会重新 `scrollIntoView`，两段不共享滚动状态；本段收尾只要求
    //    `几何()`（相对 `#doc`）回到基线，⛔ 不要求滚动位置复原。
    await 跑下沿进入(base, out.摘要);

    // —— Y 段：**进入编辑态不显示源码 / 不改变行几何**（`design/0061` §5 `INV-LIVE-14`）——
    // ⚠️ 必须排在 D/N/O **之前**、任何一次提交之前：它要的是"点的这一下"本身，
    //    正文与几何都得是基线（D/N/O 都会改字再收回，虽然收尾回到基线，但没必要让
    //    Q36 去承担它们收尾是否干净的账）。
    await 跑编辑态恒等(base, out.摘要);

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
        // ⭐ `file://` 下 `__ERR` 的消息恒为 `Script error.`（跨源）⇒ 真正的原因只在
        //    探针侧陷阱里（见 `装陷阱`）。⛔ 别删这一段——没有它，这条判据红起来
        //    只剩"抛过异常"四个字。
        : JSON.stringify((window.__ERR || []).slice(0, 4))
          + (抛出.length ? '；探针陷阱：' + JSON.stringify(抛出.slice(0, 6)) : ''));

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

    // —— U 段：**列表项上的多输入序列**（2026-11-11 用户要求「自己执行多输入测试」）——
    // ⚠️ 必须排在 E1 / H / L / V 之后：本段会把字打进去再 `⌘Z` 撤回，**一次都不许提交**
    //    （`U7` 自己判 `render_preview` / `save_document` 零增量）；排在 P / Q 之前
    //    是为了不让它们的"故意提交"污染 U7 的计数口径。
    await 跑多输入序列(base, out.摘要);

    // —— K 段：**编辑边界的多输入序列**（2026-11-11 长任务：继续找编辑＋渲染缺陷）——
    // 与 U 段同口径：顺序在 P / Q 之前（⛔ 不让它们的故意提交污染收尾判据），
    // 每个场景自己 `⌘Z` 撤回基线再退出。
    await 跑边界序列(base, out.摘要);

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

  // ⭐⭐ **探针自己崩了也要交卷**（2026-11-05 实测）：此前表格段某个 `null` 让
  //    `callAsyncJavaScript` 直接抛异常 ⇒ 运行器拿不到 JSON ⇒ `run_round` 判"跑不起来"，
  //    而**这一份夹具里已经跑出来的几百条判据全部丢失**，真正红的那一条（B8-7 退出失败）
  //    连影子都看不到。异常本身仍然记成一条**失败判据**（⛔ 不是静默放行）。
  async function run() {
    try {
      return await runBody();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      out.致命 = '探针异常：' + msg
        + (e && e.stack ? '；' + String(e.stack).split('\n').slice(0, 3).join(' / ') : '');
      记('Z0 探针全程没有异常', false, out.致命);
      out.环境.前台文本 = String((document.getElementById('status') || {}).textContent || '').slice(0, 120);
      return out;
    }
  }

  window.__RUN = window.__DIAG === true ? 诊断 : run;
})();
