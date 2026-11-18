// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// 阅读—编辑连续性的**控制器**：状态机 ＋ Prep→Swap ＋ commit 协议 —— `design/0047` §2.3–§2.6。
//
// # 它是什么、⛔ 不是什么
//
// 它**不碰 DOM、⛔ 不碰 CM6、⛔ 不发 IPC**：那三样全部通过 `deps` 注入（见下面的 `deps` 表）。
// 这样整条"进入 / 提交 / 退出 / 撤销"的顺序判据都能在 node 里跑（`INV-LIVE-17`
// "⛔ 不能把全部正确性验证都归给人工"）。
// ⚠️ 真 DOM 的那半（离屏建视图、等高、交换）在 `main.js` 的注入实现里；观感归人工（§7.3）。
//
// # 三条最容易写错的地方（屏幕都不报错）
//
// 1. ⭐ **行号空间**：块的行区间从 `blocks.js` 出来是 **0-based 半开**，而 `fullText` 的
//    splice 按同一口径；`a`/`b`（1-based 含）只用来**说人话**（状态条 / AT）。
//    ⇒ 换算只有 [`rangeOf`] 一处，⛔ 别在调用点各写一遍（差一行的形态是"改 A 块、坏 B 块"）。
// 2. ⭐ **提交 ≠ 保存**（§2.5）：`commit()` 只改内存里的 `fullText`；写盘只有 `save()`。
//    v1 把两者混成一个动作，是本设计最大的语义更正。
// 3. ⭐ **身份四件套**（`INV-LIVE-20`）：进入时逐条比对，提交回包逐条复核。
//    `line_count` 那条最阴：行号一陈旧，旧块表会**静默指向别的行**（`model.js::acceptReply`）。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，顶层 `const` 撞名会让
// **整个文件不执行**（窗口空白、stderr 全静默）。理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  const LIVE = (function () {
    if (typeof module !== 'undefined' && module.exports) {
      return {
        model: require('./model.js'),
        blocks: require('./blocks.js'),
        cell: require('./cell.js'),
        task: require('./task.js'),
        objects: require('./objects.js'),
        txn: require('./txn.js'),
        // ⭐ `design/0078`：块命令与表格行列操作的纯计划层。
        blockCmd: require('./blockcmd.js'),
        table: require('./table.js'),
      };
    }
    // ⚠️ 加载期取值 ⇒ `index.html` 里 `model.js` / `blocks.js` / `cell.js` / `task.js`
    //    / `objects.js` / `txn.js` / `blockcmd.js` / `table.js` 必须排在**本文件之前**
    //    （`tests/js/keymap.test.js` 的「脚本加载顺序」闸门盯着这一条）。
    return {
      model: window.rmd.liveModel,
      blocks: window.rmd.liveBlocks,
      cell: window.rmd.liveCell,
      task: window.rmd.liveTask,
      objects: window.rmd.liveObjects,
      txn: window.rmd.liveTxn,
      blockCmd: window.rmd.liveBlockCmd,
      table: window.rmd.liveTable,
    };
  })();

  /**
   * ⭐ **行数侧已标定**（`design/0047` §7.1 的 0f，2026-10-26 `make probe-live-block` 的 L 段）：
   * 2000 行块（113 679 B）的键入代价 p50/p95 ＝ **6/6 ms**，仍在 16 ms 帧预算内（余量 2.7×）。
   * ⚠️ **字节侧 `maxBlockBytes = 256 KiB` 仍是外推**（只有装饰层 `markers()` 的线性取证，
   * 没有 256 KiB 的整块样本）。它们的作用是"别让一次点击把 10 MB 的文档搬进 CM6"，
   * ⛔ 不是性能承诺。
   */
  const LIMITS = { maxBlockLines: 2000, maxBlockBytes: 256 * 1024 };

  // ⛔⛔ **2026-11-09**：`LIMITS` 是**成本参数**，⛔ 不是体验口径。它今天的作用是"别让一次点击
  //   把 10 MB 的文档搬进 CM6"，代价是**大块直接进不去编辑**（`INV-LIVE-19` 的拒收分支）——
  //   按 `INV-LIVE-04` ①（`design/0047` §5）与用户 2026-11-09「用户体验第一，先不过于考虑
  //   实现成本」，**"进不去"不许当成合规结果**：它是欠账。⇒ 每一条走到 `editable=false`
  //   ／`超预算退出` 的记录都要单独立账（`design/0059` 阶段 E 的降级策略必须先有用户体验答案）。

  /** 等高容差（§2.3 步骤 ⑤ 写死 0.5 px）。 */
  const HEIGHT_TOLERANCE = 0.5;

  // ⛔⛔ **2026-11-09**：`HEIGHT_TOLERANCE` 只是**测量量化下限**（`getBoundingClientRect()`
  //   报带小数的值，两次独立测量本来就可能差一点点）。⛔ 它不是"允许半像素的布局变化"，
  //   更不是"结构差容得下"——`layoutSlack` 那套上界已经整条作废（`design/0047` §10 尾注）。
  //   ⇒ 见到 `diff > HEIGHT_TOLERANCE` 一律当**缺陷**记（状态条是回归网，不是验收结论）。

  /** 一次 `leave()` 里最多补提交几轮（渲染期间用户还能继续打字）。 */
  const MAX_COMMIT_ROUNDS = 3;

  // ── 小工具（都只在这一层用）────────────────────────────────────────────

  /**
   * **UTF-8 字节数**：`maxBlockBytes` 的口径是**字节**（评审第 17 条）。
   *
   * ⚠️ 以前比的是 `text.length`（UTF-16 码元）——ASCII 上恰好相等，
   * 中文一格 3 字节、非 BMP 一格 4 字节 ⇒ **20 万汉字（约 600 KB）会被判成"没超"**。
   * @param {string} s
   * @returns {number}
   */
  function bytesOf(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s)).length;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        n += 4;
        i += 1;
      } else n += 3;
    }
    return n;
  }

  function sameLines(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** `fullText` 的 `[from, to)` 行（0-based 半开）。 */
  function sliceLines(text, from, to) {
    return LIVE.model.splitLines(text).slice(from, to);
  }

  /**
   * 把一个拒绝/异常翻成**一句人话**（状态条用）。
   *
   * ⚠️⚠️ 2026-11-13（`bugs/0320`）：旧实现是 `e.message || String(e)`，而后端
   * `Denied` 的多数变体（`Stale` / `NoDocument` / `NotAuthorized` / `Conflict` …）
   * **本来就不带 `message`**——`services/tauri.js::normalizeError` 给的形状是
   * `{kind, path, message:'', wording, raw}` ⇒ `String(e)` 落地成 `[object Object]`，
   * 用户看到的是「改不进去: [object Object]」（截图见 `bugs/0320`）。
   * ⇒ 顺序改成：**译文一句 `wording`**（必有的那半）＋ 有细节时接 `：message`；
   *    退化到 `kind`、再到 `JSON.stringify`；⛔ **任何分支都不许落到 `String(对象)`**。
   */
  function msgOf(e) {
    if (!e) return '';
    if (typeof e === 'string') return e;
    if (typeof e !== 'object') return String(e);
    const 话 = typeof e.wording === 'string' ? e.wording : '';
    const 细 = typeof e.message === 'string' ? e.message : '';
    if (话 && 细) return 话 + '：' + 细;
    if (话 || 细) return 话 || 细;
    if (typeof e.kind === 'string' && e.kind) return e.kind;
    try {
      const s = JSON.stringify(e);
      if (s && s !== '{}') return s;
    } catch (err) {
      // 循环引用 / 不可序列化 ⇒ 走下面的兜底，⛔ 别让格式化把原来的错盖掉。
    }
    // ⚠️ 兜底文案**也**要能翻译：它会经 `status.*-failed` 的 `{msg}` 上屏
    //    （`bugs/0320` 之前这里是 `[object Object]`）。⛔ 不写字面量——
    //    `tests/js/i18n.test.js` 的漏翻闸门会把没走 `t()` 的中文抓出来。
    return 未知错误();
  }

  /** `status.unknown-error`（i18n 未加载时退到英文，⛔ 不留中文裸字面量）。 */
  function 未知错误() {
    const i18n = (typeof window !== 'undefined' && window.rmd) ? window.rmd.i18n : null;
    return (i18n && typeof i18n.t === 'function') ? i18n.t('status.unknown-error') : 'Unknown error';
  }

  /** 块 → splice 用的行区间（**唯一的换算点**）。 */
  function rangeOf(block) {
    return { from: block.from, to: block.to };
  }

  /** 后端回包的 `generation` 落在 `gen` 上（`DocumentPayload` 的 serde 名字）⇒ 统一。 */
  function identOfPayload(p) {
    return {
      realPath: String((p && p.real_path) || ''),
      // ⭐ `design/0082`：草稿号（`null` = 真实文档）。⚠️ 草稿的 `realPath` 是**空串**，
      //    而"磁盘上还没有这一份"这件事只能靠这个字段表达（⛔ 别用 `!realPath` 猜：
      //    `ident` 还有"根本没有文档"的那种空值，两者要分开）。
      draft: (p && p.draft) || null,
      generation: p && p.generation !== undefined ? p.generation : p && p.gen,
      docSeq: p && p.doc_seq,
      lineCount: p && p.line_count,
    };
  }

  /** 交给 `model.acceptReply` 的形状（它只认这四个键，多给没用）。 */
  function replyOfPayload(p) {
    const id = identOfPayload(p);
    return {
      real_path: id.realPath,
      generation: id.generation,
      doc_seq: id.docSeq,
      line_count: id.lineCount,
      commit_seq: p && p.commit_seq,
    };
  }

  /** 不可编辑的块：给一句**具体**的 why（⛔ 不笼统说"不能改"）。 */
  function whyNotEditable(kind, t) {
    if (kind === 'HtmlBlock') return t('status.live-why-html');
    if (kind === 'Math') return t('status.live-why-math');
    return t('status.live-why-structural');
  }

  /**
   * 一次事务的**完整载荷**（`design/0058` §2.2 / `design/0059` 阶段 A）。
   *
   * ⚠️ 三个维度**分开**：`mode`（来源模式，今天只有 `live`）/ `operation`（操作种类）/
   *    `objectKind`（对象种类）。⛔ 别拿其中任何一个当"没有回环"的证明——防回环靠
   *    `txId` ＋ 修订比对 ＋ 同步应用标记。
   *
   * @typedef {{status:string, committed:boolean, unchanged:boolean, rejected:boolean,
   *   stale:boolean, failed:boolean, why:string, txId:any, revision:object|null,
   *   selectionBefore:object|null, selectionAfter:object|null, selectionLost:boolean,
   *   entry:any, lines:string[]|null, fullText:string|null, lineCount:number,
   *   identity:object|null, mode:string, operation:string, objectKind:string,
   *   group:string|null}} TxPayload
   */

  /**
   * 交给 [`createController`] 里 `runTransaction` 的**计划**（唯一发布入口的入参）。
   *
   * @typedef {{txId?:string, operation:string, objectKind:string,
   *   range:{from:number, to:number}, next?:string[],
   *   verify?:object|null, apply?:function, onPublish?:function,
   *   selectionBefore?:object|null, selectionAfter?:object|null,
   *   group?:string|null, rejected?:string}} TxPlan
   */

  /**
   * @param {object} deps 全部注入（真实现见 `main.js` 的 `liveDeps`）
   * @param {function} deps.t `services/i18n.js::t`
   * @param {function} deps.report 状态条一行
   * @param {function} [deps.announce] 给 AT 播报（`live/a11y.js::announce`）
   * @param {function} deps.beginEdit `({generation}) -> Promise<{real_path,text,envelope}>`
   * @param {function} deps.endEdit `({discard}) -> Promise`（释放写授权）
   * @param {function} deps.renderPreview `({text,generation,req,verify}) -> Promise<payload>`
   *   ⭐ `design/0054`：`verify` 是**可选**的候选校验请求（`null` = 不校验）。
   *   ⚠️ 实现侧必须**原样透传**到 `render_preview`——丢了它，回包里就没有 `verify`，
   *   而前端会把它读成"这份候选没被验过"⇒ 每次单元格提交都被拒（`verify-missing`）。
   * @param {function} deps.mount `(payload, {keepScroll}) -> void` ——⭐ **唯一提交点**
   * @param {function} deps.saveDisk `({text, envelope, realPath}) -> Promise`
   * @param {function} deps.makeView `({text, lineOffset, el, kind, cell}) -> view`
   *   view = `{dom, lines(), height(), destroy(), focusAt?(point), caret?() -> number}`
   * @param {function} deps.swap `({el, host, view}) -> {undo()}`
   * @param {function} [deps.nodeOf] `(blockIndex) -> node`（块形态的"序号 → 新树节点"）
   * @param {function} [deps.pendingHost] `(prevNode) -> node`（`⌘↵` 新起一段的**临时宿主**，
   *   见 `main.js::pendingHost`；缺了它就⛔ 不开这一段）
   * @param {function} [deps.cellNodeOf] `(blockIndex, flat) -> node`（单元格形态；`design/0049`）
   * @param {function} [deps.heightOf] `(el) -> number`（默认量 **border box 的分数像素**，
   *   见下方那段注释；⛔ 不要用 `offsetHeight`）
   * @param {function} [deps.onStaleDocument] `({why}) -> void`：身份四件套不符时**请上层自动重载**
   *   （`design/0047` §6「身份四件套不符 ⇒ 自动重载」）。⚠️ 只在这条路上调，⛔ 不在
   *   `save()` 的"磁盘被别人改过"路上调——那一条要的是**拒绝覆盖**，不是重载。
   * @param {object} [deps.limits] 覆盖 [`LIMITS`]
   */
  function createController(deps) {
    // ⚠️ `any` 只是为了让 `deps || {}` 里那个 `{}` 不把类型收窄成空对象（`design/0052` U8）。
    //    ⛔ 别把上面那串 `@param {function} deps.xxx` 删掉——那是这个注入包唯一的成文契约。
    const d = /** @type {any} */ (deps || {});
    const t = d.t || function (k) {
      return k;
    };
    const report = d.report || function () {};

    /**
     * 报**错**：状态条标红（评审第 19 条）。
     *
     * ⚠️⚠️ 等级由**调用点**决定，⛔ 不由文案的首字推断——那会让"改一个译文字"变成
     * "改掉界面语义"，而当时没有任何闸门守「所有错误文案都以 `⛔` 开头」这条约定
     * （`status.live-structural` / `status.cell-hint` 就是反例：拒绝类却不以 `⛔` 开头）。
     */
    function fail(msg) {
      report(msg, true);
    }

    /** 报**提示**：不标红（成功、撤销、警告、无事可做）。 */
    function note(msg) {
      report(msg, false);
    }
    const announce = d.announce || function () {};
    const model = d.model || LIVE.model;
    const blocksMod = d.blocks || LIVE.blocks;
    const cellMod = d.cell || LIVE.cell;
    const taskMod = d.task || LIVE.task;
    const txn = d.txn || LIVE.txn;
    const limits = {
      maxBlockLines: d.limits && d.limits.maxBlockLines ? d.limits.maxBlockLines : LIMITS.maxBlockLines,
      maxBlockBytes: d.limits && d.limits.maxBlockBytes ? d.limits.maxBlockBytes : LIMITS.maxBlockBytes,
    };
    // ⚠️ 默认量 **border box 的分数像素**（`getBoundingClientRect().height`），⛔ 不用 `offsetHeight`：
    //    后者**两侧各自四舍五入到整数** ⇒ 与 `deps.height()` 的差最多被虚增 **1 px**，
    //    而闸门容差只有 **0.5** ⇒ "本来就对得上"的块会被判变高越界（`docs/bugs/0013`）。
    //    生产那边由 `main.js` 注入同一口径的函数；这里的默认值只是让"忘了注入"也不至于更糟。
    const heightOf =
      d.heightOf ||
      function (el) {
        if (!el) return 0;
        if (typeof el.getBoundingClientRect === 'function') return el.getBoundingClientRect().height;
        return el.offsetHeight;
      };

    /** `viewing` → `prep` → `editing` ⇄ `committing`（§2.5；新事件必须先在表里有一格）。 */
    let state = 'viewing';
    /** 当前显示文档的身份（四件套里前端能看到的三个 ＋ 行数）。 */
    let ident = null;
    /** 块表（`blocks.fromPayload` 的形状）。 */
    let table = [];
    /** 块表的问题（非空 ⇒ ⛔ 不许进编辑态，`INV-LIVE-06`）。 */
    let issues = [];
    /** ⭐ 表格单元格区间表（`design/0049`；`blocks.js::fromCellPayload` 的形状）。 */
    let cellTable = [];
    /** ⭐ 任务项区间表（`design/0051`；`blocks.js::fromTaskPayload` 的形状）。 */
    let taskTable = [];
    /** 打勾的串行链：连点时严格按顺序提交（每次重新读表与全文，⛔ 不并发改同一份 session）。 */
    let taskChain = Promise.resolve();
    /** 整个**文档会话**的全文模型（提交栈也住在里面，§2.6 的第二层）。 */
    let session = null;
    /** 磁盘基线（`begin_edit` 给的那份文本）——"脏"就是拿它比的。 */
    let baseline = null;
    /** 当前活动块；`null` 以外的每个字段都只在这一层动。 */
    let active = null;
    /** 进入序号：Prep 期间又被点/退出 ⇒ 旧的那次必须自己消失。 */
    let enterSeq = 0;
    /** 渲染序号：旧的提交回包必须**丢**（§2.5「渲染期间新输入」）。 */
    let renderSeq = 0;
    /** `render_preview` 的 `req` 计数（后端只回显，⛔ 不解释）。 */
    let renderReq = 0;
    /**
     * ⭐ **候选校验的 token 计数**（`design/0054` §7 第 4 条）。
     * ⚠️ 它只用于**一致性**：回包里的 token 与本次不符 ⇒ 这一包不是我要的。
     * ⛔ 它**不是**凭证、不是授权——授权仍然由后端的 `check_readable` ＋ 编辑态判定给。
     */
    let verifySeq = 0;
    /**
     * ⭐ **发布段失败的原因**（DOM 挂载异常时非空）：真值已用撤销退回，但这一份**没上屏**。
     * ⚠️ 非空期间 `save()` 必须拒（⛔ 不许把"屏幕上那份"当成要写的内容）。
     */
    let publishFailed = '';
    /**
     * ⭐ **最近一次事务载荷**（`design/0059` 阶段 A 的观测口）。
     * ⚠️ 它由 `txPayload()` 这**唯一构造点**写入，⛔ 不在各调用点各自记——
     *    那样一漏就等于"有的入口有载荷、有的没有"，而判据只会去看有载荷的那几个。
     * ⚠️ 只读观测：⛔ 不参与任何判定，也⛔ 不许拿它当"这次提交成功"的凭证。
     */
    let lastTx = null;
    /**
     * ⭐ 最近一次「`⌘↵` 新起一段」的账（`bugs/0024`）：`blockIndex` = 从哪一块跳出来的，
     * `insertAt` = 那些空行**插在哪一行之前**（撤销时靠它认出栈顶是不是自己那条），
     * `caretBefore` = 操作前的块内光标（撤销要回到这里）。
     */
    let lastNewPara = null;
    /**
     * ⭐ **事务序号**（`design/0058` §2.2 的 `txId`）：只用于**所有权校验**——
     * 回滚句柄拿它对"我是不是这一趟的主人"。⛔ 不是凭证、不是授权。
     */
    let txSeq = 0;

    /** 新的一次事务号（字符串，避免与 `renderSeq` 这类数值混用）。 */
    function newTxId() {
      txSeq += 1;
      return 'tx' + txSeq;
    }

    /**
     * 当前活动目标里的选区（`design/0058` §2.5）：带 `anchor`/`head` **方向**、
     * `space`（块编辑文本 / 格内编辑文本）与 `revision`。
     *
     * ⚠️ `space` ⛔ 不是 `doc`：块/格 CM6 里的偏移是**那段编辑文本**的偏移，
     * 与 LF 规范化全文的偏移不是一回事（前面还有别的行）。把它标成 `doc`
     * 就是"格内偏移裸加源码偏移"的同族缺陷（`INV-MUT-08`）。
     * ⚠️ 视图不提供选区（阅读态 / 合成宿主）⇒ 返回 `null`，⛔ 不伪造 `0`。
     */
    function viewSelection(a) {
      if (!a || !a.view || typeof a.view.selection !== 'function' || !session) return null;
      const s = a.view.selection();
      if (!s) return null;
      return txn.selection({
        anchor: s.anchor,
        head: s.head,
        space: a.cell ? 'cell' : 'block',
        revision: session.revision(),
        objectId: a.cell ? 'cell:' + a.index + ':' + a.cell.flat : 'block:' + a.index,
      });
    }

    /**
     * 事务结果的**完整载荷**（`design/0059` 阶段 A）：五种状态 ＋ 文本/身份/修订/选区
     * ＋ 三个**分开声明**的维度（`mode` / `operation` / `objectKind`）。
     *
     * ⚠️ 同时保留旧的三个布尔，现有调用方与测试照旧能读；但新代码⛔ 别再用
     * "`failed === false`" 推"成功了"——`stale` 与 `unchanged` 也在那里。
     *
     * @param {string} status [`txn.STATUS`]
     * @param {{why?:string, txId?:any, revision?:object|null,
     *   selection?:object|null, selectionBefore?:object|null, selectionAfter?:object|null,
     *   selectionLost?:boolean, entry?:any, lines?:string[], fullText?:string,
     *   lineCount?:number, identity?:object|null, operation?:string, objectKind?:string,
     *   group?:string|null}} [o]
     * @returns {TxPayload}
     */
    function txPayload(status, o) {
      const r = o || {};
      // ⭐⭐ **选前 / 选后是两个字段，⛔ 不许互相顶替**（`design/0059` 阶段 A）：
      //    发布成功时选后选区是**发布那一刻**从活动视图取的（`runTransaction` 里算好传进来）；
      //    其余结果没有改动真值 ⇒ 选区不变，选后就等于选前。
      //    ⚠️ 旧调用点只传一个 `selection`（选前），保持可用；但它**不能**再冒充选后——
      //    那样"选后选区"只是个同义反复，调用方读到的永远是自己进去时的那个。
      const before = r.selectionBefore !== undefined ? r.selectionBefore : (r.selection || null);
      const after = r.selectionAfter !== undefined ? r.selectionAfter : before;
      const payload = {
        status: status,
        committed: status === txn.STATUS.COMMITTED,
        unchanged: status === txn.STATUS.UNCHANGED,
        rejected: status === txn.STATUS.REJECTED,
        stale: status === txn.STATUS.STALE,
        failed: status === txn.STATUS.FAILED,
        why: r.why === undefined || r.why === null ? '' : String(r.why),
        txId: r.txId === undefined ? null : r.txId,
        // ⭐ **修订描述的是"载荷里这份文本是哪一版"**（`design/0059` 阶段 A 的载荷注释），
        //    ⛔ 不是这次事务的**基线**版本。二者在 `committed` 上必然不同：发布让 `commitSeq`
        //    前进了一次。⇒ 默认取当前会话的修订；只有确实要标明另一份文本时才显式传。
        //    ⚠️ 旧写法在调用点传 T0 的 `revision`，于是"成功"的载荷里
        //    `fullText` 是新文本、`revision` 却还是旧文本 ⇒ 谁按修订去取都会取错一份。
        revision: r.revision !== undefined ? r.revision : (session ? session.revision() : null),
        selectionBefore: before,
        selectionAfter: after,
        selectionLost: r.selectionLost === true,
        entry: r.entry === undefined ? null : r.entry,
        lines: r.lines || (session ? session.lines() : null),
        fullText: r.fullText === undefined ? (session ? session.fullText() : null) : r.fullText,
        lineCount: r.lineCount === undefined ? (session ? session.lineCount() : 0) : r.lineCount,
        identity: r.identity || (session ? session.identity() : null),
        mode: 'live',
        operation: r.operation || 'edit',
        objectKind: r.objectKind || 'block',
        group: r.group === undefined ? null : r.group,
      };
      lastTx = payload;
      return payload;
    }

    // ── 身份 / 块表 ────────────────────────────────────────────────────

    /** 每次 `mount` 之后必须调（`main.js` 的提交点里）。 */
    function notePayload(payload) {
      const parsed = blocksMod.fromPayload(payload);
      ident = identOfPayload(payload);
      table = parsed.blocks;
      issues = parsed.issues;
      cellTable = parsed.cells || [];
      taskTable = parsed.tasks || [];
      return { lineCount: parsed.lineCount, blocks: parsed.blocks, issues: parsed.issues };
    }

    /** ⭐ 某个块的单元格区间（`null` ⇒ 没有这张表：老后端 / 非表格文档）。 */
    function cellsOf(index) {
      return blocksMod.cellsOf(cellTable, index);
    }

    /** ⭐ 某个块的任务项区间（`null` ⇒ 没有这张表：老后端 / 非任务文档）。 */
    function tasksOf(index) {
      return blocksMod.tasksOf(taskTable, index);
    }

    /**
     * ⭐⭐ **脏 = 「已提交但没落盘」∨「已输入但没提交」**（2026-10-29 复评 P1-1）。
     *
     * ⚠️ 旧写法只比 `session` 与 `baseline` —— **活动视图里压着的那份输入完全不算**。
     *    于是"点进一格敲字、不先 Esc 就点别的文档"这条路上，调用方在 `leave()` **之前**
     *    问脏不脏，答案是 `false` ⇒ 不问、直接切；`leave()` 随后把字提交进内存，
     *    而那时**没有人再问一次**。屏幕上看起来每一步都正常，用户的输入只活在内存里。
     *
     * ⭐ 三个状态必须分开问（复评点出的共同根因）：
     *    ① **已输入**（视图里）——由 [`stillDirty`] 判，与"提交"那条判据**同一份**；
     *    ② **已提交**（`session` 里有、磁盘没有）——比 `baseline`；
     *    ③ **已写盘**（`baseline` 跟着那次成功写出的**快照**走，见 `save()`）。
     *    `dirty()` 只覆盖 ①∨②；③ 是 `baseline` 自己的事。⛔ 别把三者揉成一个布尔缓存
     *    再跨 `await` 用——`await` 之后世界已经变了。
     *
     * ⚠️ 调用点仍要**在 `leave()`／`await` 之后再核对一次**：`dirty()` 是**当下**的事实，
     *    ⛔ 不是"刚才那一次"的结论（`main.js::openDocument` / `reloadCurrentDocument`）。
     */
    function dirty() {
      if (!session || !baseline) return false;
      if (!sameLines(session.lines(), baseline)) return true;
      // ⭐ 活动视图里还压着没提交的输入 ⇒ 同样是脏（⛔ 别等 `leave()` 才认账）。
      return !!active && stillDirty(active);
    }

    function blockAt(index) {
      for (let i = 0; i < table.length; i++) if (table[i].index === index) return table[i];
      return null;
    }

    /**
     * 按**行**找块（0-based）：取「起点 ≤ 该行」的**最后一块**。
     *
     * ⚠️ 为什么要有一个不走 `index` 的入口（`bugs/0024`，2026-10-28）：`⌘↵` 会**提交并重渲**，
     *    表跟着重排；而"我刚在哪一块里"只能靠行号回答——连续两次 `⌘↵` 时，
     *    第一次新起的那一段已经变成**真块**插在前面那一块之后，旧下标仍然指着**上面**那一块
     *    ⇒ 第二段会被插到第一段**前面**（用户看到"新段落长到了我上一段的上面"）。
     *    行落在块间空行上时也归到上面那一块，⛔ 不返回 `null`。
     */
    function blockAtLine(line) {
      let hit = null;
      for (let i = 0; i < table.length; i++) {
        if (table[i].from <= line && (!hit || table[i].from >= hit.from)) hit = table[i];
      }
      return hit;
    }

    /** 光标在这一块里的**行号**（0-based）；读不到 ⇒ `0`。 */
    function lineOfCaret(view, pos) {
      if (!view || typeof view.lines !== 'function') return 0;
      const lines = view.lines();
      let off = 0;
      for (let i = 0; i < lines.length; i++) {
        const len = String(lines[i]).length;
        if (pos <= off + len) return i;
        off += len + 1;
      }
      return Math.max(0, lines.length - 1);
    }

    // ── 进入：Prep → Swap（§2.3）────────────────────────────────────────

    /**
     * @param {{index?:number, block?:Object, el?:Object, point?:Object,
     *          cell?:{flat:number}, caretPos?:number,
     *          caretEdge?:'start'|'end'}} [req]
     *   `cell` 是**单元格形态**（`design/0049`）：`flat` 是这一块的第几格。
     *   ⭐ `caretPos` 是**落点的块内偏移**（`bugs/0024`，2026-10-28）：`⌘↵` 新起的一段用
     *   `0`（段首，能立刻接着打字）、撤销之后用**操作前记下的那个偏移**（光标回到原处）。
     *   ⭐ `caretEdge`（`bugs/0104`）：方向键跨格，落在目标格文本的**首/末**——目标格的长度
     *   在这一步之前拿不到（视图还没建），所以⛔ 不硬塞一个 `caretPos`。
     *   ⚠️ 一个键都不标成必填：`req || {}` 里那个 `{}` 必须能赋给这个类型
     *   （`design/0052` U8 踩过）；真正的必填性由下面那串 `if (!…)` 判。
     * @returns {Promise<{ok:boolean, why?:string}>}
     */
    async function begin(req) {
      // ⚠️ `any` 只为了让 `req || {}` 不把类型收窄成空对象 —— 逐键契约看上面那段 JSDoc。
      const r = /** @type {any} */ (req || {});

      // 已经在别的块里 ⇒ 先提交并退出（设计 §2.5「点另一块」＝ commit ＋ 进入新块）。
      // ⚠️ 必须在**取序号之前**做：`leave()` 会推进 `enterSeq`，先取就会把自己判成"被打断"。
      // ⭐ `design/0054` §7 第 5 条：那次提交**失败时不许接着换块**——旧块视图还活着
      //    （输入还在里面），这时候把新视图装到旧视图旁边，等于同时有两个"真值"。
      let switched = false;
      if (state === 'editing' || state === 'committing') {
        const left = await leave({ reason: 'switch' });
        if (!left.ok) return { ok: false, why: 'commit-failed' };
        switched = true;
      }
      const my = ++enterSeq;

      const wantCell = !!r.cell;
      let block = r.block || blockAt(r.index);
      let el = r.el;
      // ⚠️⚠️ **上面那次 `leave()` 会提交并整篇重渲**（`runTransaction()` → `mount()` → `#doc.innerHTML`）
      //    ⇒ 调用方手里那个 `block` 与 `el` 在那一刻**都已经过期**：
      //    · `block` 的行区间是**旧表**的（刚提交的块可能多/少了几行 ⇒ 切出来的是别人家的话）；
      //    · `el` 已经**脱树** ⇒ `getComputedStyle` 一颗盒子都读不到、`heightOf` 量成 0、
      //      `el.parentNode` 是 null（宿主挂不上去）。
      //    表现是"点另一块，要么进不去、要么进去的是别处的文字"。
      //    ⇒ 提交之后**按序号从新表 / 新树重取**（`d.nodeOf` 是 `main.js` 的对齐表查询口）。
      if (switched) {
        const fresh = r.index === undefined || r.index === null ? null : blockAt(r.index);
        if (fresh) block = fresh;
        // ⚠️ 单元格要重取的是**那一格**（不是整块）：`d.cellNodeOf` 走"块节点 → 第 n 格"。
        if (wantCell) {
          const cellNode =
            typeof d.cellNodeOf === 'function' && block ? d.cellNodeOf(block.index, r.cell.flat) : null;
          if (cellNode) el = cellNode;
        } else {
          const node = typeof d.nodeOf === 'function' && block ? d.nodeOf(block.index) : null;
          if (node) el = node;
        }
      }
      if (!block) return { ok: false, why: 'no-block' };
      if (!el) return { ok: false, why: 'no-node' };
      if (!ident) return { ok: false, why: 'no-document' };
      if (issues.length > 0) {
        // ⚠️ 块表本身有问题 ⇒ ⛔ 不许进（`INV-LIVE-06`）：行区间不可信，改了会写坏**别处**。
        fail(t('status.live-identity', { why: issues[0] }));
        return { ok: false, why: 'issues' };
      }

      // ⭐ **表格单元格是另一条入口**（`design/0049` §3「没动的地方」）：
      //    `Table` 在块级仍然是 `editable = 0`，这里⛔ 不把 Table 挪进白名单，
      //    而是当调用方明确给了 `cell` 时按**格子**判可写性（`INV-CELL-05`）。
      let span = null;
      if (wantCell) {
        const spans = cellsOf(block.index);
        if (!spans) {
          // 老后端 / 载荷形状不对 ⇒ 如实告知，⛔ 不猜位置（§6 第一行）。
          fail(t('status.cell-unavailable'));
          return { ok: false, why: 'no-cells' };
        }
        span = spans[r.cell.flat];
        if (!span) {
          // ⚠️ 下标越界 = 载荷与 DOM 的格子数对不上（`INV-CELL-06`），⛔ 不部分配对。
          fail(t('status.cell-pairing'));
          return { ok: false, why: 'cell-pairing' };
        }
        if (span.writable !== true) {
          fail(t('status.cell-locked'));
          return { ok: false, why: 'cell-locked' };
        }
      } else if (block.editable !== true) {
        fail(t('status.live-not-editable', { why: whyNotEditable(block.kind, t) }));
        return { ok: false, why: 'not-editable' };
      }

      const range = wantCell ? { from: span.line - 1, to: span.line } : rangeOf(block);
      const lineCount = range.to - range.from;
      // 大小闸门用的是**渲染时的行数**；字节数要等 `begin_edit` 拿到文本才知道。
      if (lineCount > limits.maxBlockLines) {
        fail(t('status.live-block-too-large', { lines: lineCount }));
        return { ok: false, why: 'too-large' };
      }

      state = 'prep';
      let grant;
      try {
        grant = await d.beginEdit({ generation: ident.generation, realPath: ident.realPath });
      } catch (e) {
        state = 'viewing';
        fail(t('status.live-enter-failed', { msg: msgOf(e) }));
        return { ok: false, why: 'begin-edit' };
      }
      if (my !== enterSeq) {
        // Prep 期间用户又点了别处 / 换了文档 ⇒ 这次的结果**作废**，授权归还。
        await safeEndEdit(true);
        return { ok: false, why: 'superseded' };
      }
      if (state !== 'prep') return { ok: false, why: 'superseded' };

      // ② 身份四件套（§2.2）。⚠️ `EditGrant` 只带 `real_path`，另三件要自己算/比对。
      const why = identityMismatch(ident, grant, model);
      if (why) {
        state = 'viewing';
        await safeEndEdit(true);
        // ⭐ §6：**自动重载**（⛔ 只报一句红字就完事）。
        staleDocument(why);
        return { ok: false, why: 'identity' };
      }
      // 行尾不统一 ⇒ ⛔ 不就地改（保存会把整篇行尾统一，那是一次**看不见的**全文改写）。
      if (grant.envelope && grant.envelope.lossy) {
        state = 'viewing';
        await safeEndEdit(true);
        fail(t('status.live-eol'));
        return { ok: false, why: 'eol' };
      }
      // ⭐ 信封的**唯一**来源就是这里（`save()` 要原样还回去）。
      lastEnvelope = grant.envelope || null;

      // 文档会话：首次进入（或换回了磁盘那份 / 换了文档）时建/换基线。
      if (!sameDocumentSession(session, ident)) {
        session = model.createSession({
          text: grant.text,
          realPath: grant.realPath !== undefined ? grant.realPath : ident.realPath,
          generation: ident.generation,
          docSeq: ident.docSeq,
        });
        baseline = model.splitLines(grant.text);
      }

      // ⚠️⚠️ **块内容从文档会话取，⛔ 不从 `grant.text`（磁盘）取**（2026-10-27，`bugs/0017`）：
      //    提交过一块之后，行号与内容都已经是**缓冲**那一份，磁盘要等 ⌘S 才跟上。
      //    拿磁盘文本按缓冲的行区间去切，切出来的是**另一段文字**——而且切得动，
      //    所以屏幕上只会表现为"点了这一块，进去的是别处的内容"。
      //    `grant.text` 在本次进入里的唯一职责是**核对磁盘没变**（见 `identityMismatch`）。
      const body = sliceLines(session.fullText(), range.from, range.to);
      let text = body.join('\n');
      if (wantCell) {
        // ⭐ 只切**这一格**的列区间（`INV-CELL-01`：两侧填充空格与竖线一个字节都不进视图）。
        //    ⚠️ 区间不可信时如实告知，⛔ 不夹取——夹出来的首尾差会让提交写进别人的格子。
        const raw = cellMod.textOf(body[0], span.from, span.to);
        if (raw === null) {
          state = 'viewing';
          await safeEndEdit(true);
          fail(t('status.cell-locked'));
          return { ok: false, why: 'cell-span' };
        }
        // ⭐⭐ **源码里的 `<br>` 还原成视图里的换行**（`bugs/0035`，`cell.js::decode`）。
        //    与 `commitActive` 里的 `encode` 是一对逆变换：视图里始终是 `\n`
        //    ⇒ 再次点进这一格看到的是换行，⛔ 不是字面的四个字符 `<br>`。
        //    ⚠️ 不改 UTF-16 列区间的语义：`span` 说的是**源码**里的位置，
        //    而写回是"整格替换"（`+= encode(...)`），长度变不变都不影响它。
        text = cellMod.decode(raw);
      }
      const bytes = bytesOf(text);
      if (bytes > limits.maxBlockBytes) {
        state = 'viewing';
        await safeEndEdit(true);
        // ⚠️ **这一条说的是字节，⛔ 不是行数**（评审第 17 条）：3 行 / 300 KB 的块
        //    以前会报「太大（3 行）」，用户只会去数行数，然后怀疑软件坏了。
        fail(t('status.live-block-too-large-bytes', { kb: Math.round(bytes / 1024) }));
        return { ok: false, why: 'too-large' };
      }

      // ③ 离屏建视图并量高（Prep 的最后一步；⚠️ 视图**不在文档流里**）。
      let view;
      try {
        // ⚠️ 把**被换掉的那个元素**一起交下去：视图要按它搬盒子（外边距/内边距/左边框/底色）
        //    与品种类（代码块不装软换行）。不给它，等高校验比的是两个盒子形状不同的东西。
        view = d.makeView({ text: text, lineOffset: range.from, el: el, kind: block.kind, cell: wantCell });
      } catch (e) {
        state = 'viewing';
        await safeEndEdit(true);
        fail(t('status.live-enter-failed', { msg: msgOf(e) }));
        return { ok: false, why: 'make-view' };
      }

      const want = heightOf(el);
      const got = view.height();
      // ⭐⭐ **`INV-KERNEL-05`：块永远进得去**（`design/0052` U6）。
      //    几何差**只许告警、只许补滚动，⛔ 不许阻断进入**——用户 2026-10-27 拍板
      //    「U6 以使用体验为先」：宁可"进去之后下面的内容移动几行"，也不许"点了没反应"。
      //
      //    ⛔⛔ **2026-11-09 用户重订 `INV-LIVE-04`（`design/0047` §5）："移动几行"这一半作废。**
      //    进入瞬间**块自身**也不许长高/变矮，块外也不许有位移动；不再有"外部依赖/已知量"豁免。
      //    ⇒ 这里"不阻断进入"只剩**可用性兜底**的意义（点了不能没反应），⛔ 不是几何契约：
      //      ① 走到这个 `note` 的每一块都是**待修缺陷**，探针 `B<i>-3a` 一律判红，
      //         ⛔ 不许拿"状态条报了"当绿；
      //      ② 变高方向同样要修——此前"变高不逐条报"只是因为会淹掉真错误，
      //         不是因为变高可以接受（`bugs/0298` 就是这么漏了整整三周）；
      //      ③ 根因是**编辑态没把阅读态的布局补齐**（段间距、围栏行、边框、嵌套缩进），
      //         修法是把差补齐，⛔ 不是放宽容差、也不是"进得去就算完"。
      //
      //    ⚠️ 为什么"变矮"仍然要报：变矮意味着字号 / 行高 / 内边距**搬丢了**
      //    （`h1` −7 px、`h3` −8.672 px 都是实测过的这一族），它在屏幕上不会报错，
      //    状态条是用户唯一能看见的那一处。⚠️ 但**仍放行**——那是可用性兜底，见上面 ①。
      const diff = got - want;
      if (!wantCell && diff < -HEIGHT_TOLERANCE) {
        note(t('status.live-short', { want: round1(want), got: round1(got) }));
        // ⚠️ 偏差登记：设计写的是"状态条 ＋ `rmd.log`"，而前端**没有**写日志的通道
        //    （`logging.rs` 只由 GUI 启动时写，`INV-LOG-01`；加一条命令要动 `build.rs` 的
        //    清单与 ACL）。⇒ 用 `console.warn` 留痕，离屏探针与开发工具里看得见。
        try {
          console.warn('[rmd] 就地编辑：这一块变矮了 ' + round1(diff) + ' px（'
            + round1(want) + ' → ' + round1(got) + '）');
        } catch (e) { void e; }
      }

      // ④ Swap：⚠️ 这一段**同步**，⛔ 没有 await（"同步块内完成"只约束这里）。
      //    ⭐ `point` 一起交下去：`design/0052` U6 的锚定要拿它当"用户点的那一处"。
      //    ⭐ `block` 也交下去：锚点必须知道这一块跨了**几个源码行**——只跨一行的块
      //    （段落 / 标题 / 单行引用）里，"点击落第几个视觉行"不等于"第几个源码行"
      //    （`bugs/0078`），`swapLiveView` 要按这个区分。
      const swapped = d.swap({ el: el, host: view.dom, view: view, cell: wantCell,
        point: r.point, block: block });
      active = {
        index: block.index,
        el: el,
        view: view,
        swap: swapped,
        a: block.startLine, // 1-based 含
        b: block.endLine, // 1-based 含
        lineOffset: range.from,
        // ⭐ 单元格形态（`null` = 块形态）。`from`/`to` 是**这一行的 UTF-16 列**，
        //    提交时只替换这一段（`INV-CELL-01`）；`to` 会随每次提交按写回文本的长度更新。
        cell: wantCell ? { flat: r.cell.flat, line: span.line, from: span.from, to: span.to } : null,
      };
      state = 'editing';
      // ⭐ 落点（`bugs/0024`）：`caretPos` 优先于 `point`——`⌘↵` 新起一段用 `0`，
      //    撤销之后用**操作前记下的那个偏移**（要回到原来的光标，⛔ 不是上次点的地方）。
      // ⭐⭐ `{ reading: true }`（`bugs/0084`）：这一下点的是**阅读态**那一屏（视图刚建、
      //    活动行还没展开），换算坐标必须按"标记全藏"的排版做。⛔ 别在 `focusPoint`
      //    （已经在编辑时再点）那条路上传它——那时用户点的就是**展开后**的排版。
      // ⭐ `caretEdge`（`bugs/0104`）：方向键跨格时还不知道目标格的长度 ⇒ 按"文本首/末"
      //    定位（`text` 是**这一格视图里的**文本，`<br>` 已由 `decode` 还原成换行）。
      if (view.focusAt && Number.isInteger(r.caretPos)) view.focusAt({ pos: r.caretPos });
      else if (view.focusAt && r.caretEdge === 'start') view.focusAt({ pos: 0 });
      else if (view.focusAt && r.caretEdge === 'end') view.focusAt({ pos: text.length });
      else if (view.focusAt && r.point) view.focusAt(r.point, { reading: true });
      return { ok: true };
    }

    /**
     * 进入时的四件套比对（`EditGrant` 没有 `doc_seq`／`generation`，那两个由调用方保证）。
     *
     * ⚠️⚠️ **行数不从 `ident` 取，从 `baseline` 取**（2026-10-27，`bugs/0017`）：
     *    `ident.lineCount` 来自**最近一次挂载的载荷**，而 `render_preview` 那一份描述的是
     *    **还没写盘的编辑缓冲**（`runTransaction()` 就是拿它 mount 的）⇒ 提交过一块、
     *    行数变了、⛔ 还没按 ⌘S 时，它比磁盘**新**。拿它跟 `begin_edit` 的磁盘文本比，
     *    必然不等 ⇒ **之后每一块都进不去**，而报的还是「正文在打开后被改过」——
     *    把用户**自己**的改动说成了外部改动，且反复点都没有出路。
     *
     *    `baseline` 才是"磁盘上那一份"：它只在 `begin_edit` 建成会话时与**保存成功之后**更新
     *    （`save()` 里那道闸用的就是它，两条判据由此**同源**）。
     *    ⚠️ 所以这条判据要问的是"磁盘还是我们从它出发的那一份吗"，⛔ 不是"载荷新不新"。
     */
    function identityMismatch(id, grant, m) {
      if (!grant || typeof grant.text !== 'string') return t('status.live-why-grant');
      if (grant.real_path !== undefined && grant.real_path !== id.realPath) {
        return t('status.live-why-path', { got: grant.real_path });
      }
      // ⭐ `design/0082`：草稿**磁盘上还没有这一份** ⇒ 没有"被别人改过"这件事可比，
      //    `begin_edit` 回的是一份**空**文本（与"从它出发的基线"无关）。
      //    ⚠️ 不短路的话，第一次提交之后每一块都会撞一条**假的**「正文在打开后被改过」。
      if (id && id.draft) return '';
      const disk = m.splitLines(grant.text);
      // 有会话 ⇒ 按**磁盘基线**比。⚠️ 会话必须属于**同一份文档**，否则 `baseline` 是别人的。
      const base =
        session && baseline && String(session.identity().realPath) === String(id.realPath)
          ? baseline
          : null;
      if (base) {
        if (sameLines(disk, base)) return '';
        return disk.length !== base.length
          ? t('status.live-why-line-count', { want: base.length, got: disk.length })
          : t('status.live-why-content');
      }
      if (disk.length !== id.lineCount) {
        return t('status.live-why-line-count', { want: id.lineCount, got: disk.length });
      }
      return '';
    }

    /**
     * ⭐ 身份四件套不符时的**收场**：请上层**自动重载**，⛔ 不是停在一条红字上。
     *
     * ⚠️⚠️ `design/0047` §6 的原话是「身份四件套不符（换文档/重载/行数变了）⇒
     *    ⛔ 不进编辑态；用户可见「正文已变化，重新载入中」；恢复＝**自动重载**」。
     *    而此前两处入口（`begin` / `toggleTask`）只做了前半句：红字一条、正文不动
     *    ⇒ 用户点下去得到的是一句"改过了，没开始"，**得自己去菜单里重载**，
     *    而重载按钮只在大文件降级时才出现在提示条上（2026-11-03 用户实测报的正是这个）。
     *
     * ⚠️ 为什么**只在这两处**叫重载：它们是"用户点了一下、什么也没发生"的入口。
     *    `save()` 里那条同族判据（`status.live-identity`）⛔ **不叫重载**——
     *    那一条挡的是"覆盖掉别人刚写的内容"，重载会把用户攒着的提交一起丢掉。
     *
     * ⚠️ 没有注入 `onStaleDocument`（老调用方 / 单测）⇒ 退回原来那条红字，⛔ 不假装重载了。
     */
    function staleDocument(why) {
      if (typeof d.onStaleDocument === 'function') {
        // ⚠️ `note`（⛔ 不是 `fail`）：这是**正在自愈**，不是一次失败。
        //    标红会让用户以为出错了，而下一秒正文就会自己刷新。
        note(t('status.live-reloading'));
        try {
          d.onStaleDocument({ why: why });
        } catch (e) {
          // ⚠️ 重载请求炸了也不能把"进不去编辑"这件事吞掉：再报一次原因。
          fail(t('status.live-identity', { why: why }));
        }
        return;
      }
      fail(t('status.live-identity', { why: why }));
    }

    /**
     * ⭐ 提交之后**把同一个视图重新挂到新节点上**（`design/0047` §2.4 步骤 ④ 的后续）。
     *
     * ⚠️⚠️ **为什么必须有这一步**：`commit` 的提交点是 `mountDocument`，它用
     * `doc.innerHTML = payload.html` **整棵换掉** `#doc` 的子节点 ⇒ 活动块原来那个
     * `el` 连同挂在它前面的 `host` 一起脱树。视图（`EditorView`、撤销栈、自绘选区层）
     * 都还活着，但屏幕上看不见它了。
     * ⛔ **不能靠 `swap.undo()` 复原**：那会去动一个已经不在树上的节点。
     * ⇒ 调用方（`main.js::noteLive`）拿**新树里**那个块节点再挂一次。
     *
     * @param {object} el 新树里那个块节点（`#doc` 的直接孩子）
     * @returns {boolean} 挂上了吗（`false` ⇒ 视图已不在编辑态/没给节点）
     */
    function reseat(el) {
      const a = active;
      if (!a || !el) return false;
      // ⚠️ 旧的那个 `swap` 里包着**旧节点**，这里整体换掉（它已经不可撤销了）。
      a.swap = d.swap({ el: el, host: a.view.dom, view: a.view });
      a.el = el;
      return true;
    }

    /**
     * 能不能沿用现有会话。⚠️ 三个都要对上：**同一份文件**（`realPath` ＋ `doc_seq`）、
     * **行数一致**（行号基线）。行数一漂，提交栈里的旧行区间就会指向别的行 ⇒ 宁可清栈。
     */
    function sameDocumentSession(s, id) {
      if (!s || !id) return false;
      const sid = s.identity();
      if (String(sid.realPath) !== String(id.realPath)) return false;
      if (sid.docSeq !== undefined && id.docSeq !== undefined && sid.docSeq !== id.docSeq) return false;
      return s.lineCount() === id.lineCount;
    }

    async function safeEndEdit(discard) {
      try {
        await d.endEdit({ discard: discard !== false });
      } catch (e) {
        // ⚠️ 释放失败 ⛔ 不该打断用户：写授权只影响下一次 `save_document`，它自己会拒。
        //    ⚠️ 但⛔ 不许静默：吞掉之后「授权有没有还回去」在探针里只剩计数对不上，
        //    连"是没调、还是调了失败"都分不清（2026-11-05 `B7-8 end_edit +0` 排查）。
        try {
          console.error('[rmd-live] end_edit 失败：' + (e && e.message ? e.message : String(e)));
        } catch (ignored) { void ignored; }
      }
    }

    // ── 提交（§2.4 ／ `design/0054` `INV-EDITOBJ-03`）────────────────────

    /**
     * ⭐ **候选 → 校验 → 发布** 的唯一入口（`INV-OWN-05`：提交只有一个入口）。
     *
     * ⚠️⚠️ 顺序是**硬要求**（`design/0054` §7 第 4/5 条，2026-10-28 用户复审 P1）：
     *   今天以前是「先 `session.commit` 改真值、再 `renderPreview` 检查」——
     *   被拒的候选**已经进了缓冲**，`⌘S` 还会把它写盘。
     *   现在反过来：
     *   ① **造候选**：从 `session` 的**当前全文**（＝最新已提交全文，⛔ 不是打开时那份）
     *      ＋ 这次编辑算出候选文本，`lines` / 撤销栈 / `ident` / DOM 一个都不动。
     *   ② **校验**：把候选交给后端，由它用**同一份 comrak** 判结构（`verify` 可选；
     *      块级对象只认行区间，⛔ 不伪造一份客户端切格语义）。
     *   ③ **复核**：回包必须对得上 token、身份四件套，且会话在等包期间**没有被别的提交动过**。
     *   ④ **发布**：复核之后的这一段⛔ **没有 `await`** —— 摘宿主 → 提交 → 挂载一气呵成。
     *   ⑤ **失败不污染**：①②③ 任一步失败时 `lines` / 撤销栈 / `ident` / 磁盘**全部原状**，
     *      视图与用户输入都还在（⛔ 不销毁唯一持有输入的东西）。
     *
     * @param {any} a 活动块（`null` = 阅读态 / 无视图的入口）
     * @param {TxPlan} plan
     * @returns {Promise<TxPayload>}
     */
    async function runTransaction(a, plan) {
      const txId = (plan && plan.txId) || newTxId();
      const sess0 = session;
      if (!sess0) return txPayload(txn.STATUS.FAILED, { txId: txId, why: 'no-session' });
      const revision = sess0.revision();
      // ⭐ **载荷必需字段**（`design/0059` 阶段 A 的验收）：缺了就**明确失败**，
      //    ⛔ 不悄悄回退成"没有 operation 的旧发布"。保留输入由调用方负责（视图不动）。
      if (!plan || !plan.operation || !plan.objectKind || !plan.range) {
        fail(t('status.live-verify-plan'));
        return txPayload(txn.STATUS.FAILED, { txId: txId, why: 'plan' });
      }
      // ⭐⭐ **必需性闸门**（2026-10-29 代码评审第 7 条）：`live/objects.js` 声明
      //    `verify: 'structure'` 的对象，写回时**必须**带结构证据。
      //    ⚠️ 在此之前这条只活在"两个调用点各自记得"里：`commitCell` 记得填、
      //    `commitActive` 的块级分支记得填 `null`。新加一类对象时忘了填 ⇒ **静默退化成
      //    只验行区间**（后端照收），而屏幕上一切正常——正是"结构闸门变成可选参数"那个缺陷。
      //    ⇒ 判据放在**唯一入口**上，不放在调用点。
      //    ⚠️ 它排在造候选之前：这时还没动 `state`，⛔ 也不会多算一次 `renderSeq`。
      const pol = LIVE.objects.policyOf({ cell: a && a.cell });
      if (pol.verify === 'structure' && !plan.verify) {
        fail(t('status.live-verify-plan'));
        return txPayload(txn.STATUS.FAILED, { txId: txId, why: 'verify-plan' });
      }
      // ⭐ 入口处已经判定"这段输入在格内无法无损表达" ⇒ `rejected`：
      //    **保留输入、报错、⛔ 不清脏**（`INV-MUT-03`）。
      if (plan.rejected) {
        fail(t('status.cell-inexpressible'));
        return txPayload(txn.STATUS.REJECTED, {
          txId: txId, why: String(plan.rejected),
          selection: viewSelection(a),
        });
      }
      // —— ① 造候选（⛔ 不碰真值）——
      const lines = sess0.lines();
      const range = plan.range;
      const next = plan.next || [];
      if (range.from < 0 || range.to > lines.length || range.from > range.to) {
        return txPayload(txn.STATUS.FAILED, { txId: txId, why: 'range' });
      }
      const candLines = lines.slice(0, range.from).concat(next, lines.slice(range.to));
      const baseText = sess0.fullText();
      const candText = model.joinLines(candLines);
      const selectionBefore = plan.selectionBefore === undefined
        ? viewSelection(a)
        : plan.selectionBefore;
      // ⚠️ 候选与基线逐字相同 ⇒ 没有改动，⛔ 不发 IPC、⛔ 不压撤销条目。
      if (candText === baseText) {
        return txPayload(txn.STATUS.UNCHANGED, {
          txId: txId, selection: selectionBefore,
        });
      }

      const ver = plan.verify || null;
      const token = ver ? 'v' + ++verifySeq : '';
      const my = ++renderSeq;
      const req = ++renderReq;
      const atBuild = sess0.identity();

      // —— T0 快照（⚠️ 在任何 `await` 之前取；`save()` 在 `add()` 那一刻就执行）——
      // ⭐ 覆盖 `design/0058` §2.2 的整张表：全文 ＋ 两侧栈 → `session` 快照；
      //    编辑对象区间 / 宿主状态 → `object`；身份与四张表 → `tables`。
      //    ⚠️ `session` 换成别的对象（`reset()` / 换文档）时**不许**回滚：
      //    那份快照属于旧会话，退回去就是"给新文档塞旧全文"。⇒ 恢复体里抛错，
      //    由 `frame.restore` 记进 `failed[]`（进而 `publishFailed` 拒存）。
      const frame = txn.createFrame({ txId: txId, kind: plan.operation, revision: revision });
      const base = sess0.snapshot();
      frame.add('session', function () {
        return base;
      }, function (v) {
        if (session !== sess0) throw new Error('session-swapped');
        sess0.restore(v);
      });
      if (a) {
        frame.add('object', function () {
          return {
            a: a.a,
            b: a.b,
            detached: a.detached,
            cell: a.cell ? { from: a.cell.from, to: a.cell.to } : null,
          };
        }, function (v) {
          a.a = v.a;
          a.b = v.b;
          a.detached = v.detached;
          if (a.cell && v.cell) {
            a.cell.from = v.cell.from;
            a.cell.to = v.cell.to;
          }
        });
      }
      frame.add('tables', function () {
        return { ident: ident, table: table, issues: issues, cellTable: cellTable, taskTable: taskTable };
      }, function (v) {
        ident = v.ident;
        table = v.table;
        issues = v.issues;
        cellTable = v.cellTable;
        taskTable = v.taskTable;
      });

      const prev = state;
      state = 'committing';
      // ⭐⭐ **状态恢复的归属闸门**（旧回包污染新生命周期，2026-11-03 补测暴露）：
      //    这一笔事务只有在**自己的会话还活着**时才有资格改全局 `state`。
      //    `reset()` / 换文档之后 `session` 已经换成别的对象（或为 `null`），
      //    此时旧包无论 resolve 还是 reject，把 `state` 恢复成发起时的 `prev='editing'`
      //    都会**把新文档打回编辑态**——屏幕上像"莫名进了编辑"，而 `frame` 那边
      //    已经因为 `session !== sess0` 拒绝回滚，两边对不上。
      const restoreState = function () {
        if (session === sess0) state = prev;
      };

      // —— ② 校验（唯一的异步段）——
      let payload;
      try {
        payload = await d.renderPreview({
          text: candText,
          generation: ident ? ident.generation : undefined,
          req: req,
          verify: ver
            ? {
                baseline: baseText,
                token: token,
                block: ver.block,
                line: ver.line,
                cell: ver.cell,
                replacement: ver.replacement,
              }
            : null,
        });
      } catch (e) {
        restoreState();
        fail(t('status.live-commit-failed', { msg: msgOf(e) }));
        return txPayload(txn.STATUS.FAILED, {
          txId: txId, why: msgOf(e), selection: selectionBefore,
        });
      }

      // —— ③ 复核（无 await）——
      if (my !== renderSeq) {
        // 有更新的一次提交在途 ⇒ 这一包**丢**（`§2.5`「渲染期间新输入」）。⛔ 不动任何东西。
        restoreState();
        return txPayload(txn.STATUS.STALE, {
          txId: txId, why: 'stale', selection: selectionBefore,
        });
      }
      if (ver) {
        const v = payload && payload.verify;
        if (!v || v.token !== token) {
          // ⚠️ 缺验证结果（旧后端）⇒ ⛔ **不得发布**，也⛔ 不许读成"通过"。
          restoreState();
          fail(t('status.live-verify-missing'));
          return txPayload(txn.STATUS.FAILED, {
            txId: txId, why: 'verify-missing', selection: selectionBefore,
          });
        }
        if (v.ok !== true) {
          // ⭐ 结构校验**拒绝** ⇒ `rejected`（不是"坏了"）：保留输入、报理由、⛔ 不清脏。
          restoreState();
          fail(t('status.live-verify-failed', { msg: verifyWhy(v) }));
          return txPayload(txn.STATUS.REJECTED, {
            txId: txId, why: String(v.reason || 'rejected'),
            selection: selectionBefore,
          });
        }
      }
      const now = sess0.identity();
      const acc = model.acceptReply(
        {
          docSeq: now.docSeq,
          realPath: now.realPath,
          generation: now.generation,
          lineCount: candLines.length,
          commitSeq: now.commitSeq,
        },
        replyOfPayload(payload)
      );
      if (!acc.ok) {
        restoreState();
        fail(t('status.live-align', { msg: acc.why }));
        return txPayload(txn.STATUS.FAILED, {
          txId: txId, why: acc.why, selection: selectionBefore,
        });
      }
      // ⭐ 会话在等包期间**没有被别的提交动过**：候选是照 `atBuild` 那份文本造的，
      //    现在真值已经变了 ⇒ 这一包作废（⛔ 覆盖、⛔ 回滚、⛔ 重放）。
      if (session !== sess0 || now.commitSeq !== atBuild.commitSeq) {
        restoreState();
        return txPayload(txn.STATUS.STALE, {
          txId: txId, why: 'stale-session', selection: selectionBefore,
        });
      }

      // —— ④ 发布（⚠️ 这一段**没有 `await`**）——
      // ⭐⭐ **回滚由 T0 的 `frame` 成对完成**（`design/0058` §2.2）：发布段里
      //    `plan.onPublish` 会把 `a.a` / `a.b` / `a.cell.to` 改成"跟着新内容走"的新值，
      //    `notePayload` 还会换掉 `ident` 与四张表——而 `d.mount` **可能抛错**。
      //    ⚠️ 旧写法在 catch 里只 `session.undo()`：全文退回去了，**区间没回去**；
      //    下一轮候选就拿一个陈旧的 `from`/`to` 去切新源码，拼出越界或错位的候选。
      //    ⭐ 现在每一处都在 `frame.add(...)` 里，回滚顺序与所有权/幂等由 `txn.js` 管：
      //    旧事务的 `catch` 拿到过期句柄时**什么都不做**（`{why:'not-owner'|'newer'}`）。
      let entry = null;
      try {
        // ⚠️⚠️ 摘宿主必须在 `mount` **之前**（`bugs/0018`：否则 `swap.undo()` 会把旧节点
        //    追加到 `#doc` 末尾，屏幕上多出一段一模一样的文字）。
        //    ⭐ **2026-10-28 实测校正（五条不变量不变，只补口实）**：把这两句挪到 `mount`
        //    **之后**，探针里 `P6`（重渲后没有多余节点）**照样绿**——因为 `mountDocument`
        //    收尾就调 `noteLive → reseatLive → reseat()`，`a.swap` 已经是**新树上的**一个
        //    （实测那一次 `undo()` 读到 `nextInParent=true`、`host在树里=true`）。
        //    ⇒ 这个顺序如今是**纵深防御**，真正承重的是「`reseat` 必须在 `mount` 收尾重建 swap」。
        //    ⛔ 但它**不是**废话：`reseat` 返回 `false` 的那条路（对齐失败 / 块重取不到）
        //    只有这个顺序兜着 ⇒ 别因为"探针打不红"就把它挪走。
        if (a && a.swap && a.swap.undo) {
          a.swap.undo();
          a.detached = true;
        }
        // ⭐ **`apply` 是计划给的"真值变更"**：默认 `session.commit`（编辑/任务/插入），
        //    撤销与重做传 `session.undoEdit()` / `session.redoEdit()`。
        //    ⚠️ 候选**先**算好（T1），这里只负责把它落进真值——⛔ 不再有第二条"先改后查"的路。
        const applied = plan.apply ? plan.apply() : sess0.commit(range, next);
        if (applied && applied.entry) entry = applied.entry;
        // ⚠️ 落地结果必须与校验过的那份候选**逐字相同**：不同 ⇒ 期间会话/栈已经变了，
        //    挂上去的 HTML 会对不上真值。⛔ 不许发布，交给回滚。
        if (sess0.fullText() !== candText) throw new Error('apply-mismatch');
        if (plan.onPublish) plan.onPublish();
        d.mount(payload, { keepScroll: true });
        if (a) a.detached = false;
        notePayload(payload);
        publishFailed = '';
        if (state === 'committing') restoreState();
        note(t('status.live-committed'));
        announce(t('status.live-committed'));
        // ⭐⭐ **选后选区在这一刻取**（`design/0059` 阶段 A）：发布已经把真值/修订换到新版，
        //    而活动视图还活着（`reseat` 只是把它挂回新树，⛔ 不重建它的 `state`）。
        //    ⇒ 这一份就是"调用方实际执行完之后的选区"，⛔ 不是把选前那份抄一遍。
        //    ⚠️ 调用方可以在计划里显式给 `selectionAfter`（例如插入后要落到的位置）；
        //    没给才从视图取。`a === null`（撤销/重做/任务）时没有活动视图 ⇒ `null`，
        //    如实表示"这次变更不携带选后位置"，⛔ 不编一个 `{0,0}` 冒充。
        const selectionAfter = plan.selectionAfter === undefined
          ? viewSelection(a)
          : plan.selectionAfter;
        return txPayload(txn.STATUS.COMMITTED, {
          txId: txId,
          selectionBefore: selectionBefore,
          selectionAfter: selectionAfter,
          entry: entry, lines: sess0.lines(), fullText: candText,
          lineCount: candLines.length, identity: sess0.identity(),
          operation: plan.operation, objectKind: plan.objectKind, group: plan.group,
        });
      } catch (e) {
        // ⚠️ 发布段一半失败（DOM 挂载异常）：按 T0 **逐项退回**，并核对"全文真的回到了
        //    发起前那一份"。核不过 ⇒ 真值里可能留着一份**看不见的改动**，`publishFailed`
        //    非空，`save()` 继续拒（⛔ 不许把屏幕上那份当成要写的内容）。
        //    ⚠️ `claim` 必须带 **T0 那一份修订**（`revision`），⛔ 不是 `sess0.revision()`：
        //    这一段的提交**已经把修订推前了**，拿现在的去比只会得到 `newer`，
        //    于是"该退的一项都不退"——正文停在已提交的新文本上、区间却还是旧的。
        //    判 `newer` 的真正含义是"T0 之后**别人**又提交过"，那时快照才不该盖上去。
        const claim = { txId: txId, revision: revision };
        const back = frame.restore(claim);
        // ⚠️ 无论退没退干净都**必须留标记**：`d.mount` 抛过错 ⇒ 屏幕上那一份是未知状态。
        //    只有下一次**成功的发布**（屏幕与会话重新对上）才许清掉它。
        publishFailed = msgOf(e) + (back.ok ? '' : ' / rollback:' + (back.why || 'partial'));
        if (state === 'committing') restoreState();
        fail(t('status.live-publish-failed', { msg: msgOf(e) }));
        return txPayload(txn.STATUS.FAILED, {
          txId: txId, why: msgOf(e), selection: selectionBefore,
          operation: plan.operation, objectKind: plan.objectKind, group: plan.group,
        });
      }
    }

    /** 校验失败的一句人话（⛔ 前端不重造结构语义，只把后端的理由说清楚）。 */
    function verifyWhy(v) {
      const reason = String((v && v.reason) || '');
      const detail = String((v && v.detail) || '');
      if (reason === 'newline') return t('status.verify-newline');
      if (reason === 'not_writable') return t('status.cell-locked');
      if (reason === 'line_mismatch' || reason === 'baseline_parse') {
        return t('status.live-why-stale-session');
      }
      if (reason === 'cell_content' || reason === 'table_changed' || reason === 'neighbor_changed') {
        return t('status.cell-structure', { msg: detail || reason });
      }
      return detail || reason || t('status.verify-rejected');
    }

    /**
     * 把活动块的内容提交进 `fullText`（候选 → 校验 → 发布）。**不动真值直到发布那一刻。**
     * @returns {Promise<TxPayload>}
     */
    async function commitActive(target) {
      const a = target || active;
      if (!a || !session) {
        return txPayload(txn.STATUS.UNCHANGED, { txId: newTxId(), operation: 'edit' });
      }
      // ⭐ `design/0054` `INV-EDITOBJ-01/02`：**写回校验的种类由对象声明**（`live/objects.js`），
      //    ⛔ 不是在这里再判一次 `a.cell`。`structure` ⇒ 单元格那条（行区间 ＋ 后端结构证据）；
      //    `lines` ⇒ 块级那条（写回校验就是行区间，不带 `verify`）。
      const policy = LIVE.objects.policyOf({ cell: a.cell });
      if (policy.verify === 'structure') return await commitCell(a);

      // ① 造该块的候选：⚠️ 区间外一个字节都不动。
      const range = { from: a.a - 1, to: a.b };
      const next = a.view.lines();
      const cur = session.lines().slice(range.from, range.to);
      if (sameLines(next, cur)) {
        return txPayload(txn.STATUS.UNCHANGED, {
          txId: newTxId(),
          revision: session.revision(),
          selection: viewSelection(a),
          operation: 'edit',
          objectKind: 'block',
        });
      }

      return await runTransaction(a, {
        operation: 'edit',
        objectKind: 'block',
        range: range,
        next: next,
        // 块级对象的写回校验就是**行区间**（`design/0054` §2.1 的表）⇒ 不带 `verify`。
        verify: null,
        onPublish: function () {
          // 视图还活着 ⇒ 块的行区间跟着换（a 不变，b 跟着行数走）。
          a.a = range.from + 1;
          a.b = range.from + next.length;
        },
      });
    }

    /**
     * ⭐ **单元格的提交**（`design/0054` `INV-EDITOBJ-03`）：只替换那一行的**列区间**，
     * 但⛔ **不再"先改真值再检查"**——候选交给后端按结构判决，通过之后才发布。
     *
     * ⚠️⚠️ 三条纪律（`INV-CELL-01/02`）原样有效：
     *    ① 两侧填充空格、两侧竖线、同排其余格子**逐字节不变**；
     *    ② 写回文本里的 `|` 必须转义、换行写成 `<br>`（`bugs/0035`；⚠️ 不是"折成空格"——
     *       那一版已被用户需求变更推翻）；
     *    ③ 越界**抛错、⛔ 不夹取**（`cell.js::splice`）。
     */
    async function commitCell(a) {
      const lines = session.lines();
      const cur = lines[a.cell.line - 1];
      // 区间不可信 ⇒ 建不出绑定 ⇒ `judge` 会判 `rejected`（⛔ 不许读成"没改动"）。
      const binding = cellMod.bind({
        raw: typeof cur === 'string' ? cellMod.textOf(cur, a.cell.from, a.cell.to) : null,
        from: a.cell.from,
        to: a.cell.to,
        objectId: 'cell:' + a.index + ':' + a.cell.flat,
        revision: session.revision(),
      });
      // ⭐⭐ **唯一判据**（`design/0058` §2.1）：`unchanged` / `valid` / `rejected`。
      //    ⚠️ 旧形态是 `isUnchanged` 判"没改"、`needsWrite` 判"要写"——两条各算一遍，
      //    口径靠人记得对齐（`bugs/0047` 就是那么长出来的）。现在只有这一处。
      const verdict = cellMod.judge(binding, typeof cur === 'string' ? cur : '', a.view.lines().join('\n'));
      if (verdict.status === 'unchanged') {
        return txPayload(txn.STATUS.UNCHANGED, {
          txId: newTxId(),
          revision: session.revision(),
          selection: viewSelection(a),
          operation: 'edit',
          objectKind: 'cell',
        });
      }
      if (verdict.status === 'rejected') {
        // ⚠️ `rejected`（⛔ 不是 `unchanged`）：候选不可无损表达 / 区间坏了 ⇒
        //    **保留输入、报错、不清脏**。⛔ 不许为了"能退出"而清空（`INV-MUT-03`）。
        const why = verdict.why || 'rejected';
        fail(why === 'range'
          ? t('status.cell-write-failed', { msg: why })
          : t('status.cell-inexpressible'));
        return txPayload(txn.STATUS.REJECTED, {
          txId: newTxId(),
          revision: session.revision(),
          why: why,
          selection: viewSelection(a),
          operation: 'edit',
          objectKind: 'cell',
        });
      }
      const encoded = verdict.encoded || '';
      const replacement = verdict.replacement || '';
      const nextLine = verdict.nextLine || '';
      const from = a.cell.line - 1;
      return await runTransaction(a, {
        operation: 'edit',
        objectKind: 'cell',
        range: { from: from, to: from + 1 },
        next: [nextLine],
        // ⭐ 结构证据全由后端给（`INV-SINGLE-01`）：目标对象身份 ＋ 预期替换源码。
        verify: {
          block: a.index,
          line: a.cell.line,
          cell: a.cell.flat,
          replacement: replacement,
        },
        onPublish: function () {
          // ⭐ 区间跟着内容走（否则第二次提交会把刚写进去的字又当成"区间外"）。
          a.cell.to = a.cell.from + encoded.length;
          a.a = a.cell.line;
          a.b = a.cell.line;
        },
      });
    }

    /**
     * 公开的"提交当前块"（点另一块 / `⌘F` / `⌘E` / `Esc` 之前都会走它）。
     * ⚠️ 渲染期间用户还能打字 ⇒ 提交完再比一次，最多补 [`MAX_COMMIT_ROUNDS`] 轮。
     *
     * ⭐ `design/0054`：返回值从 `boolean` 改成**结构化结果**——
     * `leave()` / `save()` 必须能区分「没有改动」与「改了但被拒」，
     * ⛔ 不许把失败当成"无改动"混过去。
     *
     * @returns {Promise<{committed:boolean, failed:boolean, why:string}>}
     */
    async function commit() {
      if (!active) return { committed: false, failed: false, why: '' };
      return await commitTarget(active);
    }

    function stillDirty(a) {
      if (!a || !session) return false;
      if (a.cell) {
        const cur = session.lines()[a.cell.line - 1];
        // ⚠️ 区间不可信 ⇒ **脏**（⛔ 不许读成"干净"让 `leave()` 把输入销毁掉）。
        if (typeof cur !== 'string') return true;
        // ⭐ 与 `commitCell` **同一条判据**（`design/0058` §2.1 / `INV-MUT-02`）：
        //    `judge` 的 `unchanged` 才算干净；`valid` 与 `rejected` 都还算脏
        //    （`rejected` 尤其不能读成"没改动"——那会把用户的输入当垃圾丢掉）。
        return cellMod.judge(
          cellMod.bind({
            raw: cellMod.textOf(cur, a.cell.from, a.cell.to),
            from: a.cell.from,
            to: a.cell.to,
          }),
          cur,
          a.view.lines().join('\n')
        ).status !== 'unchanged';
      }
      const cur = session.lines().slice(a.a - 1, a.b);
      return !sameLines(a.view.lines(), cur);
    }

    // ── ⌘↵：块后新起一段（`bugs/0024`）────────────────────────────────

    /**
     * ⭐ `⌘↵` ＝ **结束当前块，在它后面新起一个正文段落，光标落进去，⚠️ 不退出编辑态**。
     *
     * ⚠️⚠️ 这条语义是用户 2026-10-28 逐字更正的（原话见 `bugs/0024` §4）：
     *    「`⌘Enter` 表示跳出当前引用块，在块后创建新的正文段落，并将真实编辑光标放到该段落，
     *      保持编辑状态与输入焦点；不是退出到阅读态后等待按键重新进入。`Enter` 继续引用。」
     *    ⇒ 2026-10-27 那套 `caretHint`（退出到阅读态 ＋ 自绘光标 ＋ 敲字再进来）**已整体撤回**。
     *
     * 三步：
     *   ① [`leave`]：提交当前块（会整篇重渲，`ident` 跟着换成新行数）；
     *   ② 在刚提交那一块之后**插空行**：上分隔 / 新段落（/ 下分隔）。
     *      ⚠️ 为什么必须有上分隔：comrak 把**相邻非空行并进同一段**。少插上面那一侧 ⇒ 用户敲的
     *      第一个字会跟上面的引用或下面的正文**合并**（屏幕上表现为"新写的字跑进了引用块"）。
     *      这是 markdown 的事实，⛔ 不是实现取舍。
     *      ⚠️ 下分隔**看情况**（`bugs/0079`）：块后本来就有一行块间空行（常态）⇒ 只插 2 行，
     *      拿那一行当新段落的下分隔；否则（文档末尾 / 块后紧贴下一块）才插 3 行。
     *   ③ 用一个**临时 `<p>` 宿主**（`d.pendingHost`）＋ 合成块 `begin()`：空行在 comrak 里
     *      **不是块**，所以这一块只存在于"视图开着"的这段时间里。
     *
     * ⚠️ 没敲字就退出 ⇒ [`leave`] 会把它们**原样撤回**（弹掉我们压的那条提交栈条目），
     *    ⛔ 不在用户文件里留空行。
     *
     * @returns {Promise<boolean>} 真的开出了一段新段落
     */
    async function newParagraph() {
      const a = active;
      if (!a || !session || state !== 'editing') return false;
      // ⚠️ 单元格形态（`design/0049`）不走这里：格子里"新起一段"会把表格行拆散。
      if (a.cell) return false;
      if (typeof d.pendingHost !== 'function') return false;
      const fromIndex = a.index;
      // ⚠️ 逐字记下**操作前那个光标**（块内偏移）：撤销之后要回到这里
      //    （用户 2026-10-28 点的验收：「一次撤销恢复操作前内容与光标」）。
      const caretBefore =
        a.view && typeof a.view.caret === 'function' ? a.view.caret() : null;
      // ⭐ 光标所在的**绝对行**（0-based）：提交之后表会重排 ⇒ 回来时按行找块，
      //    ⛔ 不能拿旧下标（连续两次 `⌘↵` 会插到上一段的上面，见 `blockAtLine`）。
      const caretLine = a.lineOffset + lineOfCaret(a.view, Number.isInteger(caretBefore) ? caretBefore : 0);
      // ① 提交并离开（⚠️ 必须真的走 `leave()`：它负责"先还宿主再提交"那条顺序，`bugs/0018` ④）
      const left = await leave({ reason: 'new-paragraph' });
      // ⭐ 2026-10-29 复评 P1-3 之后 `leave()` 会**如实失败**（三轮没收敛 / 被拒）：
      //    那时视图与输入都还在 ⇒ ⛔ 不许在它上面继续插空行（会先插进 `session`、
      //    再被 `begin()` 的第二次 `leave()` 顶掉，用户看到的是一次"凭空多出空行"）。
      if (!left.ok) return false;
      // ② 重取那一块 —— 那次提交会整篇重渲，旧表已过期（`bugs/0018` ⑤）
      const b = blockAtLine(caretLine) || blockAt(fromIndex);
      if (!b) return false;
      const insertAt = b.to;
      // ⭐ 下分隔**不要重复插**（`bugs/0079`）：标准 Markdown 里 `b.to` 那一行本来就是块间空行
      //    ⇒ 再按字面插三行，新段落下方就留下 2 个空行，每按一次多一个。
      //    「那一行已经是空行」⇒ 只插 **上分隔 ＋ 新段落** 两行（原有的空行正好当新段落的下分隔）；
      //    否则（文档末尾、块后紧贴下一块）才插三行。
      //    ⚠️ 不能"先插三行再删一行"：那会多一条撤销条目，破坏 `design/0059` §2.1。
      const 现有行 = session.lines();
      const 后面已有分隔行 =
        insertAt < 现有行.length && String(现有行[insertAt]).trim() === '';
      const 空行数 = 后面已有分隔行 ? 2 : 3;
      const 插入行 = [];
      for (let i = 0; i < 空行数; i++) 插入行.push('');
      // ⚠️ 插入是 `from === to` 的提交（`model.applyEdit` 支持，⛔ 不是特例分支）。
      //    ⭐ 走**同一条事务**（候选 → 校验 → 复核 → 发布）：失败时由 T0 快照成对回滚，
      //    ⛔ 不再"自己 `session.undo()` 补一下"。
      const ins = await runTransaction(null, {
        operation: 'insert',
        objectKind: 'block',
        range: { from: insertAt, to: insertAt },
        next: 插入行,
        // 插入段落是**一个已定义的逻辑动作** ⇒ 这一次的撤销条目归同一组（`design/0059` §2.1）。
        group: 'insert-paragraph',
      });
      if (ins.status !== txn.STATUS.COMMITTED) return false;
      // ③ 临时宿主 ＋ 合成块：`line1` 是**中间**那一行（1-based）
      const line1 = insertAt + 2;
      const prev = typeof d.nodeOf === 'function' ? d.nodeOf(b.index) : null;
      const host = prev ? d.pendingHost(prev) : null;
      if (!host) return false;
      const out = await begin({
        block: {
          index: b.index,
          kind: 'Paragraph',
          startLine: line1,
          endLine: line1,
          from: insertAt + 1,
          to: insertAt + 2,
          editable: true,
        },
        el: host,
        caretPos: 0,
      });
      if (!out || !out.ok) {
        if (host.parentNode) host.parentNode.removeChild(host);
        return false;
      }
      if (active) {
        active.synthetic = { from: insertAt, to: insertAt + 空行数 };
        lastNewPara = {
          blockIndex: b.index,
          insertAt: insertAt,
          // ⚠️ 插了几行（2 或 3），撤销时按它核对栈顶那一条，⛔ 别再写死 3（`bugs/0079`）。
          rows: 空行数,
          caretBefore: caretBefore,
        };
      }
      return true;
    }

    /**
     * ⭐ 一次 `⌘Z` 把 [`newParagraph`] 这**一整步**撤回：内容回到操作前，光标回到
     * 刚离开那一块的**原光标位置**（用户 2026-10-28 点的验收：「一次撤销恢复操作前内容与光标」）。
     *
     * ⚠️ 只有在**新段落视图里、CM6 自己已经没有历史**时才轮到它（`main.js::undoOnce`）——
     *    `resolveUndo` 那条「⛔ 一次 ⌘Z 不跨层」的纪律不变：先撤键级，键级空了才撤提交栈。
     *
     * ⚠️⚠️ 只弹**一条**：`⌘↵` 压的是"那次空行插入"。它**下面**若还有一条"当前块的改动"，
     *    那是用户按 `⌘↵` **之前**敲进去的字 ⇒ ⛔ 连它一起撤掉就等于"撤销把刚写的东西吃掉"。
     *    （2026-10-28 定：先写成"倒回 `stackBefore`"，那正是这个错——块里有字时按 ⌘↵ 再 ⌘Z，
     *    敲的字会一起没；`live-controller.test.js` 有对应判据。）
     * ⚠️ 栈顶不是自己那一条（期间被别的提交动过）⇒ 什么都不做，⛔ 不许乱弹。
     */
    async function undoNewParagraph() {
      const s = lastNewPara;
      if (!s || !session) return false;
      if (!active || !active.synthetic) return false;
      const top = session.stack().peek();
      if (!top || top.from !== s.insertAt || top.after.length !== (s.rows || 3)) return false;
      for (let i = 0; i < top.after.length; i++) {
        if (String(top.after[i]).trim() !== '') return false;
      }
      // ⚠️⚠️ **必须先退出、再撤销**（2026-10-28 修的一处真缺陷）。
      //    下面那次 `begin()` 在 `state === 'editing'` 时会先自己走一遍 `leave({reason:'switch'})`
      //    ⇒ `commitTarget` → `commitActive` 拿 `session.lines().slice(a.a-1, a.b)` 跟视图里的
      //    行比。可**撤销之后**会话里那一段已经不是我们的空行了，而是**后面那一块的真实正文**
      //    ⇒ 比较必然不等 ⇒ 它会把「用户把正文改成了空行」提交回去，**下一块的正文被吃掉**。
      //    （`dropEmptyPending` 也救不了：它按 `lastNewPara` 找自己那条，而栈已经被弹掉了。）
      //    `discard: true` 同时跳过 `commitTarget` 与 `dropEmptyPending`：这个合成块的内容
      //    **本来就要随撤销一起消失**，⛔ 没有任何东西需要提交；宿主也活不过下一次整篇重渲。
      const host = active.el; // 提交失败时把它摘掉（⛔ 在文档里留一个空 `<p>`）
      await leave({ reason: 'undo-new-paragraph', discard: true });
      // ⚠️ 这里用**内部回滚**（`session.undo()`，不往重做栈里记）：这一步是"取消我们自己
      //    刚插的空行"，⛔ 不是用户的一次撤销——记进重做栈会让 `⇧⌘Z` 能把空段落又贴回来。
      const out = await undoTop({ operation: 'undo', pop: true });
      if (!out || out.status !== txn.STATUS.COMMITTED) {
        if (host && host.parentNode) host.parentNode.removeChild(host);
        return false;
      }
      lastNewPara = null;
      // 光标回到操作前那个位置（`caretPos` ⇒ `focusAt({pos})`）
      const b = blockAt(s.blockIndex);
      const node = b && typeof d.nodeOf === 'function' ? d.nodeOf(b.index) : null;
      if (b && node) {
        await begin({
          block: b,
          el: node,
          caretPos: Number.isInteger(s.caretBefore) ? s.caretBefore : 0,
        });
      }
      return true;
    }

    /**
     * 「`⌘↵` 新起一段」里一个字都没敲就退出 ⇒ 撤销那次插入。
     *
     * ⚠️ 只认**栈顶恰好是那次插入**（`from` 对得上、行数与当时插的一致、内容全空）：中间被别的提交
     *    动过就不碰 —— ⛔ 宁可留几个空行，也不许撤掉用户已经写进去的字。
     */
    async function dropEmptyPending(a, viewLines) {
      const s = a && a.synthetic;
      if (!s || !session) return false;
      const empty = !viewLines || (viewLines.length === 1 && String(viewLines[0]).trim() === '');
      if (!empty) return false;
      const top = session.stack().peek();
      // ⚠️ 插了 2 行还是 3 行由当时块后有没有块间空行决定（`bugs/0079`）⇒ 取合成的跨度。
      if (!top || top.from !== s.from || top.after.length !== (s.to - s.from)) return false;
      for (let i = 0; i < top.after.length; i++) {
        if (String(top.after[i]).trim() !== '') return false;
      }
      return await undoTop({ operation: 'undo', pop: true }) !== null;
    }

    /**
     * ⭐ **栈顶那一条**的统一撤销（阅读态 `⌘Z` / 撤回「新起一段」/ 丢弃空段落共用）。
     *
     * 候选**先从 `peekUndo()` 算**（⛔ 不动真值），校验／复核通过后才在 T4 调
     * `session.undoEdit()`（用户撤销，进重做栈）或 `session.undo()`（内部回滚，不进）。
     *
     * @param {{operation?:string, pop?:boolean, group?:string|null}} [o]
     * @returns {Promise<TxPayload|null>} `null` = 没有可撤的条目
     */
    async function undoTop(o) {
      const opts = o || {};
      if (!session) return null;
      const peek = session.peekUndo();
      if (!peek) return null;
      return await runTransaction(null, {
        operation: opts.operation || 'undo',
        objectKind: 'block',
        range: peek.range,
        next: peek.next,
        // ⚠️ 落地时必须**真的做那一次撤销**：候选来自 `peekUndo`，落地来自 `undo*()`。
        //    两者对不上时 `runTransaction` 的 `apply-mismatch` 会把它变成失败并回滚。
        apply: function () {
          const r = opts.pop ? session.undo() : session.undoEdit();
          if (!r) throw new Error('nothing-to-undo');
          return r;
        },
        group: opts.group === undefined ? null : opts.group,
      });
    }

    // ── 退出 ───────────────────────────────────────────────────────────

    /**
     * @param {{reason?:string, discard?:boolean}} [opts]
     *   `discard: true` ⇒ 丢掉视图里的内容（调用方已经过了 0012 的脏提示闸）。
     *   ⚠️ 默认**提交**：脏内容不静默丢（§2.5 的 `Esc` 那行）。
     * @returns {Promise<{ok:boolean, committed:boolean, failed?:boolean, why?:string,
     *   pending?:boolean}>}
     *   ⭐ `design/0054` §7 第 5 条：**失败必须能传出去**（⛔ 不许退化成 `committed:false`）：
     *   `ok === false` ⇒ 视图**没被销毁**、输入还在，调用方（`begin()` / 切文档）⛔ 不许当没事发生。
     */
    async function leave(opts) {
      const o = opts || {};
      const a = active;
      if (!a) {
        state = 'viewing';
        return { ok: true, committed: false };
      }
      // ⚠️⚠️ **先提交、后摘视图**（`design/0054`）：复核失败/结构被拒时视图必须**原样活着**，
      //    否则"拒绝"这两个字就是把用户唯一那份输入一起删掉。
      //    ⚠️ 摘宿主这一步已经挪进 `runTransaction()` 的发布段（紧挨着 `mount`）——
      //    ⛔ 别在这里提前摘（`bugs/0018` 说的顺序是"摘在 mount 之前"，不是"摘在提交之前"）。
      let out = { committed: false, failed: false, why: '' };
      if (!o.discard) out = await commitTarget(a);
      if (out.failed) {
        // ⭐ 输入还在，宿主也还在 ⇒ 什么都不拆、`state` 也不动（仍是 `editing`）。
        //    ⚠️ `active` 从头到尾没被置空：`leave()` 的旧写法"先摘再动"会在这里把输入弄丢。
        //    ⚠️ `committed` 要**如实带出去**（前面几轮可能真的提交进去了）：
        //    写授权退不退、状态条说什么，靠的是"有没有东西真的进了会话"，
        //    ⛔ 不是"这一趟最后成没成"。
        return { ok: false, committed: out.committed, failed: true, why: out.why, pending: true };
      }
      active = null;
      enterSeq++;
      if (a.swap && a.swap.undo && !a.detached) a.swap.undo();
      // ⚠️ `view.lines()` 必须在 `destroy()` **之前**取（销毁之后视图不再回答）。
      const viewLines =
        a.view && typeof a.view.lines === 'function' ? a.view.lines() : null;
      if (a.view && a.view.destroy) a.view.destroy();
      state = 'viewing';
      // ⭐ 「`⌘↵` 新起一段」里一个字都没敲 ⇒ 把那些空行**原样撤回**（⛔ 不留空行，`bugs/0024`）
      if (!o.discard) await dropEmptyPending(a, viewLines);
      if (out.committed) await safeEndEdit(false);
      else await safeEndEdit(true);
      return { ok: true, committed: out.committed };
    }

    /**
     * 给"活动的块"补提交到干净为止（`leave()` / `commit()` 共用）。
     *
     * ⭐⭐ **收敛判据是"视图里真的没字了"，⛔ 不是"这一轮返回成功"**（2026-10-29 复评 P1-3）。
     *    旧写法在每个分支上都把"这一轮没发布"读成 `failed:false`，而 `leave()` 只在
     *    `failed` 时保留视图 ⇒ 三条路会把用户的输入**连同视图一起销毁**：
     *    ① 三轮预算耗尽但期间又打了字（每轮都允许输入，收尾却不再核一次）；
     *    ② `stale`（被更新的一次提交挤掉）；③ `stale-session`（等包期间会话被别的提交动过）。
     *    现形态：**每一轮结束都问一次 `stillDirty(a)`**；只要还脏就不许报成功，
     *    也⛔ 不许靠"再加几轮"掩盖——预算是有界的，耗尽了就**显式失败并留在原地**。
     *
     * @returns {Promise<{committed:boolean, failed:boolean, why:string, rejected?:boolean}>}
     */
    async function commitTarget(a) {
      let any = false;
      for (let round = 0; round < MAX_COMMIT_ROUNDS; round++) {
        const out = await commitActive(a);
        // ⭐ `rejected`（表达不了 / 结构被拒）与 `failed` 一样**不许**让调用方销毁视图：
        //    两者都还留着用户的输入。`stale` 不在这里返回——它下面由 `stillDirty` 兜住。
        if (out.failed || out.rejected) {
          return { committed: any, failed: true, why: out.why };
        }
        if (out.committed) any = true;
        // ⭐ 唯一判据：**视图里还有没有没提交的字**（与 `dirty()` 用的是同一份 `stillDirty`）。
        //    `stale` 若还脏，就走不到这里 ⇒ 落到下面的"没发布却仍脏" ⇒ 显式失败。
        if (!stillDirty(a)) {
          // ⚠️ `why` 要**原样带出去**：`stale`（被更新的一次提交挤掉）与"没有改动"都是
          //    收敛了，但调用方/判据得分得清是哪一种（`design/0054` §7 第 5 条）。
          return { committed: any, failed: false, why: out.why };
        }
        // 这一轮什么都没发布、视图里却还有字 ⇒ 再循环也只是**重复同一份候选**（后端已经拒过一次）。
        if (!out.committed) return notConverged(any, out.why);
      }
      // 预算耗尽 ⇒ **最后再核一次**（⚠️ 旧写法就是漏了这一句）。
      if (stillDirty(a)) return notConverged(any, 'rounds');
      return { committed: any, failed: false, why: '' };
    }

    /**
     * 「没收敛」的唯一出口：**说出来 ＋ 报失败**（⛔ 不许静默返回成功让调用方销毁视图）。
     * @param {boolean} any
     * @param {string} why
     * @returns {{committed:boolean, failed:boolean, why:string, rejected?:boolean}}
     */
    function notConverged(any, why) {
      fail(t('status.live-still-dirty'));
      return { committed: any, failed: true, why: why || 'not-converged' };
    }

    // ── 保存 / 撤销 ────────────────────────────────────────────────────

    /**
     * ⭐⭐ **写盘的单飞/串行入口**（2026-10-29 复评 P1-2 后半条）：
     * 产品里**至少**两条路会调它——`main.js::liveSaveNow`（`⌘S`）与 `doToggleTask`（打勾后自动落盘）——
     * 而它们**不共用** `liveSerial`。两条同时进来会各自从同一份 `baseline` 出发、各写各的全文，
     * 谁后回包谁赢，先回那一次的成功提示说的还是**已经被覆盖的**内容。
     * ⚠️ 串行化放在**控制器里**，⛔ 不是指望调用方记得套 `liveSerial`：入口只要多一条，
     *    "记得包一下"就是一条**没人能自动化检验**的纪律。
     * ⚠️ 链上的拒绝⛔ 不许留下（否则之后每一次保存都短路到 catch），与 `toggleTask` 同一个写法。
     */
    let saveChain = Promise.resolve();

    /**
     * @returns {Promise<boolean>}
     */
    function save() {
      const run = saveChain.then(function () {
        return doSave();
      });
      saveChain = run.then(
        function () {},
        function () {}
      );
      return run;
    }

    /**
     * `⌘S`：先把当前块提交进内存，再写盘。⭐ ⛔ 不触发渲染（`save_document` 不回包 HTML）。
     *
     * ⭐ `design/0054` §7 第 5 条：**提交失败 ⇒ ⛔ 不许继续写盘**。
     *    旧写法 `await commit()` 不看返回值，于是"校验被拒"会被静默当成"没有改动"，
     *    接着把**用户没写进去的那份文本**存盘——既骗了用户，又让失败现场彻底消失。
     *
     * ⭐⭐ **基线绑的是"这一次真正写出去的那份快照"，⛔ 不是 `await` 之后的 `session`**
     *    （2026-10-29 复评 P1-2 前半条）。写盘是异步的，期间用户还能打字、别的动作还能提交：
     *    旧写法 `baseline = session.lines().slice()` 记下的是**那时的最新**（Y），
     *    而磁盘上是**发起时那份**（X）⇒ 之后 `dirty()` 说"不脏"、保存短路、丢稿提示失效。
     *    ⇒ 快照与 `session` / `ident` 一起在**发起时**取，成功后只在**还是同一个会话**时回填；
     *    换了会话（`reset()` / 换文档）⇒ ⛔ 不回填，那份快照已经不是"这一份文件"的基线了。
     *
     * @returns {Promise<boolean>} ⚠️ `false` = 这次保存**没有成立**（⛔ 不是"没改动"）
     */
    async function doSave() {
      // ⚠️ `ident` 与 `session` 同批建立（`mountDocument`）⇒ 少任何一份都说明现在没有文档。
      if (!session || !ident) return false;
      // 上一轮发布段没把内容送上屏 ⇒ 会话真值里有一份"看不见的改动"。
      // ⛔ 先把这句话说清楚，别在它上面继续叠写盘（那会把界面与磁盘彻底对上不了）。
      if (publishFailed) {
        fail(t('status.live-publish-failed', { msg: publishFailed }));
        return false;
      }
      if (state === 'editing' || state === 'committing') {
        const out = await commit();
        if (out.failed) {
          // ⚠️ `commit()` 自己已经报过原因（`status.live-verify-failed` 等），这里⛔ 不重复报。
          return false;
        }
      }
      // ⭐ 快照与身份**同批取**（中间⛔ 不许插 `await`）：这就是"这一次要写出去的那一份"。
      const sess = session;
      const ident0 = ident;
      const snapLines = sess.lines().slice();
      const snapText = sess.fullText();
      const snapRealPath = ident0.realPath;
      if (!baseline || sameLines(snapLines, baseline)) return true; // 没改就不写
      // ⭐⭐ **写授权只在"有活动块"时天然持有**：`leave()` 会把它还回去（与 `0012` 的
      //    "退出编辑态就撤写授权"同一条口径），而 `⌘S` **在退出覆盖层之后仍然要能用**
      //    （用户提交了一块、点出覆盖层、再按保存）。
      //    ⇒ 这里**先把授权要回来**，并顺手核对"磁盘上那一份还是我们从它出发的那一份"。
      //    ⚠️ 为什么核对用的是 `baseline`（而不是身份里的 `lineCount`）：提交过之后
      //    `session` 的行数已经与磁盘不同了，拿行数跟磁盘比会**永远不等** ⇒ 每次保存都被拒。
      //    ⚠️ `begin_edit` 是**幂等**的（再调一次 = 刷新文本与基线），所以这条不额外引入状态。
      if (state !== 'editing' && state !== 'committing') {
        let grant;
        try {
          grant = await d.beginEdit({ generation: ident0.generation, realPath: snapRealPath });
        } catch (e) {
          fail(t('status.live-save-failed', { msg: msgOf(e) }));
          return false;
        }
        // ⚠️ 等授权期间换了文档 ⇒ 这份快照不属于现在这一份文件，⛔ 别写。
        if (session !== sess) return false;
        const disk = model.splitLines(grant && grant.text);
        if (!sameLines(disk, baseline)) {
          // ⚠️ 文件在**我们改它之前**被外部动过 ⇒ 这次保存会覆盖掉别人的内容，必须拒。
          const why =
            disk.length !== baseline.length
              ? t('status.live-why-line-count', { want: baseline.length, got: disk.length })
              : t('status.live-why-content');
          fail(t('status.live-identity', { why: why }));
          await safeEndEdit(true);
          return false;
        }
        lastEnvelope = grant.envelope || lastEnvelope;
      }
      try {
        const saved = await d.saveDisk({ text: snapText, envelope: lastEnvelope, realPath: snapRealPath });
        // ⭐ `design/0082`：未命名草稿的落点由**系统保存面板**产生，用户可能在面板里**取消**。
        //    ⚠️ 那不是失败，也⛔ 不是"已保存"：磁盘上一个字节没动、`baseline` 不许往前推
        //    （推了就等于把用户还没落盘的内容说成"与磁盘一致" ⇒ 之后不再提示丢稿）。
        //    调用方（`main.js::liveSaveNow`）会按 `{cancelled:true}` 说一句"已取消保存"。
        if (saved && saved.cancelled) return false;
        // ⭐⭐ **草稿刚刚变成了真实文档**：路径有了、`doc_seq` +1。⚠️ 不回填身份的话，
        //    下一次 `begin_edit` 会拿新路径去比旧的空串 ⇒ 每一块都被判「身份不符」，
        //    而报出来的是"正文在打开后被改过"（把用户自己的保存说成外部改动）。
        //    ⚠️ `session` 不在这里换：它的文本与磁盘逐字节相同，换路径的活由下一次
        //    `sameDocumentSession` 判否之后按盘重建（那次重建是无损的，`grant.text` 就是它）。
        if (ident0.draft && saved && saved.path) {
          ident = {
            realPath: String(saved.path),
            draft: null,
            generation: ident0.generation,
            docSeq: saved.doc_seq,
            lineCount: snapLines.length,
          };
          baseline = snapLines;
          return true;
        }
        // ⭐⭐ 基线 = **这一次写出去的那份快照**，⛔ 不是 `session.lines()`：
        //    写盘期间可能又提交了别的内容，那些**不在磁盘上**，必须继续算脏。
        //    ⚠️ 只在"还是同一个会话"时回填；换了文档 ⇒ 这份快照不是它的基线。
        //    ⚠️⚠️ 判据⛔ **不能**比 `ident === ident0`：每次提交之后 `notePayload` 都会
        //    换一个新的 `ident` 对象（同一份文档、同一个 `doc_seq`）⇒ 那样比在这一趟
        //    里提交过之后**永远不等**，`⌘S` 存完还判脏、`save()` 每次都重写盘。
        //    要比的是"这份文件有没有换过"：`realPath` ＋ `docSeq`（`model.acceptReply`
        //    认的同两个字段），而 `session` 那一条兜住"整个会话被 `reset()` 换掉"。
        if (session === sess && ident && ident.realPath === snapRealPath
          && ident.docSeq === ident0.docSeq) baseline = snapLines;
        return true;
      } catch (e) {
        fail(t('status.live-save-failed', { msg: msgOf(e) }));
        return false;
      }
    }

    // ── 任务项打勾（`design/0051`）─────────────────────────────────────

    /**
     * ⭐ **打勾的串行入口**（`INV-TASK-03/04`）：连点时按顺序排队，每一次都重新读表与全文。
     *
     * ⚠️ 串行不是为了性能，是为了**正确**：两次并发会各自从同一份 `session.lines()` 出发，
     *    后一次会拿**已经被前一次改过**的行去套一个**陈旧的列区间**——那一处可能已经不是符号了。
     *
     * @param {{index:number, flat:number, domCount:number, domChecked:boolean}} req
     *   `flat` = 块内先序扁平下标，`domCount`/`domChecked` 由 `main.js` 在**点击那一刻**量。
     * @returns {Promise<{ok:boolean, why?:string, checked?:boolean, saved?:boolean}>}
     */
    function toggleTask(req) {
      const run = taskChain.then(function () {
        return doToggleTask(req);
      });
      // ⚠️ 链上⛔ 不许留拒绝：一次抛错会让之后每一次点击都直接短路到 catch。
      taskChain = run.then(
        function () {},
        function () {}
      );
      return run;
    }

    async function doToggleTask(req) {
      const r = req || {};
      // ① 正在别的块里 ⇒ 先提交并退出（与 `begin()` 同一条纪律）。
      //    ⭐ 2026-10-29 复评 P1-3 之后 `leave()` 会**如实失败**：那时输入还在视图里、
      //    块表与行号也都还是"提交之前"那一份 ⇒ ⛔ 一律不许接着打勾（会拿陈旧的
      //    `span.line` 去翻一行，用户看到的是"勾了一个、结果另一处变了"）。
      if (state === 'editing' || state === 'committing') {
        const left = await leave({ reason: 'task' });
        if (!left.ok) return { ok: false, why: 'commit-failed' };
      }

      if (!ident) {
        fail(t('status.task-unavailable'));
        return { ok: false, why: 'no-document' };
      }
      if (issues.length > 0) {
        // ⚠️ 块表不可信 ⇒ 行号可能指向别处，⛔ 一律不打勾（与 `INV-LIVE-06` 同源）。
        fail(t('status.live-identity', { why: issues[0] }));
        return { ok: false, why: 'issues' };
      }
      const block = blockAt(r.index);
      if (!block) {
        fail(t('status.task-unavailable'));
        return { ok: false, why: 'no-block' };
      }
      const spans = tasksOf(block.index);
      if (!spans) {
        fail(t('status.task-unavailable'));
        return { ok: false, why: 'no-tasks' };
      }
      // ② 配对闸门（`INV-TASK-03`）：数量与状态**两项都**要对上，⛔ 不部分配对。
      if (spans.length !== r.domCount) {
        fail(t('status.task-pairing'));
        return { ok: false, why: 'task-pairing' };
      }
      const span = spans[r.flat];
      if (!span) {
        fail(t('status.task-pairing'));
        return { ok: false, why: 'task-pairing' };
      }
      if (span.checked !== (r.domChecked === true)) {
        fail(t('status.task-pairing'));
        return { ok: false, why: 'task-pairing' };
      }
      if (span.writable !== true) {
        // `INV-TASK-05`：不可写项**显式标 0**，这里如实说出来，⛔ 不夹取、⛔ 不猜位置。
        fail(t('status.task-locked'));
        return { ok: false, why: 'task-locked' };
      }

      // ⚠️⚠️ **必须在提交之前**取这份快照（`INV-TASK-06`）：提交之后 `session` 一定脏，
      //    那时再问"进这一趟之前脏不脏"永远得到 `true` ⇒ 打勾**永远不会写盘**。
      const wasDirty = dirty();

      // ③ 要回写授权 ＋ 身份四件套（复用 `begin()` 的那一段，⛔ 不另开一条写盘/授权路径）。
      state = 'prep';
      let grant;
      try {
        grant = await d.beginEdit({ generation: ident.generation, realPath: ident.realPath });
      } catch (e) {
        state = 'viewing';
        fail(t('status.task-write-failed', { msg: msgOf(e) }));
        return { ok: false, why: 'begin-edit' };
      }
      const why = identityMismatch(ident, grant, model);
      if (why) {
        state = 'viewing';
        await safeEndEdit(true);
        // ⭐ 与 `begin()` 同一条：打勾这条路也会撞上"正文在打开后被改过"。
        staleDocument(why);
        return { ok: false, why: 'identity' };
      }
      if (grant.envelope && grant.envelope.lossy) {
        state = 'viewing';
        await safeEndEdit(true);
        fail(t('status.live-eol'));
        return { ok: false, why: 'eol' };
      }
      lastEnvelope = grant.envelope || null;

      if (!sameDocumentSession(session, ident)) {
        session = model.createSession({
          text: grant.text,
          realPath: grant.realPath !== undefined ? grant.realPath : ident.realPath,
          generation: ident.generation,
          docSeq: ident.docSeq,
        });
        baseline = model.splitLines(grant.text);
      }

      // ④ 同长度替换（`INV-TASK-01`）：只换那一行的一个符号，行数/行尾/两侧文字不动。
      const idx = span.line - 1;
      const lines = session.lines();
      const cur = lines[idx];
      let nextLine;
      try {
        nextLine = taskMod.toggleLine(typeof cur === 'string' ? cur : null, span.from, span.to);
      } catch (e) {
        state = 'viewing';
        await safeEndEdit(true);
        fail(t('status.task-write-failed', { msg: msgOf(e) }));
        return { ok: false, why: 'task-write' };
      }

      // ⑤ 走**同一条事务链**（`INV-TASK-04`）：候选 → 校验 → 复核 → 发布。
      //    ⭐ 失败时由 T0 快照成对回滚（旧写法在这里**什么都不做**，真值已经前进、
      //    屏幕还是旧的——`design/0058` §1.2 点名的那条）。
      const out = await runTransaction(null, {
        operation: 'task',
        objectKind: 'block',
        range: { from: idx, to: idx + 1 },
        next: [nextLine],
        // 一次打勾是**一个已定义的逻辑动作** ⇒ 撤销时整步回到（`design/0059` §2.1）。
        group: 'toggle-task',
      });
      state = 'viewing';
      // 写授权先还回去：`save()` 自己要的时候会再要一次（`design/0051` §2.5）。
      await safeEndEdit(false);
      if (out.status !== txn.STATUS.COMMITTED) {
        return { ok: false, why: out.why || out.status };
      }

      // ⚠️⚠️ 参数是**翻之前**那一行（`cur`），⛔ 不是 `nextLine`：
      //    `isCheckedSymbol` 的口径是「把这一行翻一下之后是不是勾上」（它自己会再翻一次）。
      //    传 `nextLine` 等于**连翻两下** ⇒ 状态条永远说反（2026-10-27 由 V 段 `V3b`/`V4b` 抓出：
      //    勾上了却说「已取消勾选」，且**任何纯逻辑判据都看不见**——那两份函数各自的单测都是绿的）。
      const checked = taskMod.isCheckedSymbol(cur, span.from, span.to);
      if (wasDirty) {
        // ⚠️ 进入前已经脏 ⇒ ⛔ 不替用户偷偷保存别的改动（`INV-TASK-06` 后半条）。
        note(t('status.live-committed'));
        return { ok: true, checked: checked, saved: false };
      }
      const saved = await save();
      if (saved) note(t(checked ? 'status.task-checked' : 'status.task-unchecked'));
      announce(t(checked ? 'status.task-checked' : 'status.task-unchecked'));
      return { ok: true, checked: checked, saved: saved };
    }

    /**
     * `Viewing` 态的 `⌘Z`：撤**最近一次提交**（§2.6 的第二层）。
     * ⚠️ 编辑态下 ⛔ 不走这里——`⌘Z` 只交给 CM6（不跨层）。
     */
    async function undo() {
      // ⚠️ `session === null`（打开文档、还没进过编辑）也是**「没有可撤的」**，
      //    ⛔ 不是"这个语境不归我" ⇒ 必须说一句（`bugs/0020` 评审 P2-5）。
      if (state !== 'viewing') return false;
      if (!session) {
        note(t('status.live-nothing-to-undo'));
        return false;
      }
      // ⭐ 走**同一条事务**：候选来自 `peekUndo`，复核通过后才落地；失败由 T0 成对回滚
      //    （旧写法先改真值、失败再 `res.revert()`——那是 `design/0058` §1.2 的第二条路）。
      const out = await undoTop({ operation: 'undo' });
      if (!out || out.status === txn.STATUS.UNCHANGED) {
        note(t('status.live-nothing-to-undo'));
        return false;
      }
      const ok = out.status === txn.STATUS.COMMITTED;
      if (ok) {
        note(t('status.live-undo'));
        announce(t('status.live-undo'));
      }
      return ok;
    }

    /**
     * `Viewing` 态的 `⇧⌘Z`：重做**最近一次被撤销的提交**（`bugs/0020` §8）。
     * ⚠️ 重做栈只装"用户撤销过的"那条：新提交、换文档、外部重载都会把它清掉
     *    （`live/model.js::createCommitStack`）——没有可重做的就说一声。
     */
    async function redo() {
      if (state !== 'viewing') return false;
      if (!session) {
        note(t('status.live-nothing-to-redo'));
        return false;
      }
      const out = await redoTop();
      if (!out || out.status === txn.STATUS.UNCHANGED) {
        note(t('status.live-nothing-to-redo'));
        return false;
      }
      const ok = out.status === txn.STATUS.COMMITTED;
      if (ok) {
        note(t('status.live-redo'));
        announce(t('status.live-redo'));
      }
      return ok;
    }

    /**
     * ⭐ **栈顶那一条重做**（`⇧⌘Z`）：候选来自 `peekRedo()`，落地才调 `session.redo()`。
     * @returns {Promise<TxPayload|null>} `null` = 没有可重做的条目
     */
    async function redoTop() {
      if (!session) return null;
      const peek = session.peekRedo();
      if (!peek) return null;
      return await runTransaction(null, {
        operation: 'redo',
        objectKind: 'block',
        range: peek.range,
        next: peek.next,
        apply: function () {
          const r = session.redo();
          if (!r) throw new Error('nothing-to-redo');
          return r;
        },
      });
    }

    // ── 生命周期 ───────────────────────────────────────────────────────

    /** 换文档 / 外部重载：丢弃在途 Prep、清栈、基线换新（§2.5 的最后两行）。 */
    async function reset() {
      enterSeq++;
      renderSeq++;
      await leave({ discard: true });
      session = null;
      baseline = null;
      ident = null;
      table = [];
      issues = [];
      cellTable = [];
      taskTable = [];
      // ⚠️ 换了文档 ⇒ 上一份的"发布段没上屏"不再有意义（它说的是**那一份**的屏）。
      publishFailed = '';
      state = 'viewing';
    }

    /** 信封（`begin_edit` 给的那一份）：`save()` 要原样还回去，`main.js` 也要用它显示提示。 */
    let lastEnvelope = null;

    /**
     * 活动格的只读快照（`null` = 块形态 / 没在编辑）。`activeCell` 与 `activeCellForNav`
     * 共用这一份取值，避免两处各抄一遍字段表。
     * @returns {{blockIndex:number, flat:number, line:number, from:number, to:number}|null}
     */
    function activeCellInfo() {
      if (!active || !active.cell) return null;
      return {
        blockIndex: active.index,
        flat: active.cell.flat,
        line: active.cell.line,
        from: active.cell.from,
        to: active.cell.to,
      };
    }

    /**
     * ⭐ 行落在哪一块：优先**真正包含**这一行的那一块（块内空行也算），
     * 找不到才退回 `blockAtLine()`（块间空行归上面那一块）。
     *
     * ⚠️ 为什么不用块下标：`leave()` 会提交并整篇重渲，刚提交的块可能被拆成两块
     * （用户在块里敲了一个空行），旧下标会指向**另一块**——`bugs/0024` 同族。
     * @param {number} line0 0-based
     * @returns {Object|null}
     */
    function blockContainingLine(line0) {
      for (let i = 0; i < table.length; i++) {
        if (table[i].from <= line0 && line0 < table[i].to) return table[i];
      }
      return blockAtLine(line0);
    }

    /** 偏移在文本里的行号（0-based，只数 `\n`）。 */
    function lineOfOffset(text, pos) {
      let line = 0;
      const end = Math.min(text.length, Math.max(0, pos));
      for (let i = 0; i < end; i++) if (text.charAt(i) === '\n') line++;
      return line;
    }

    /** 把块内偏移夹进文本范围（提交后文本可能变长/变短）。 */
    function clampOffset(text, pos) {
      const n = typeof pos === 'number' && isFinite(pos) ? Math.trunc(pos) : 0;
      return Math.min(text.length, Math.max(0, n));
    }

    /**
     * ⭐ **块命令**（`design/0078` §2.2）：当前块 → 纯计划 → 一次整块提交。
     *
     * ⚠️ 没有编辑上下文 / 当前在格内 ⇒ 直接 `{ok:false}`，⛔ 不报错、⛔ 不猜目标
     * （格式栏据此把菜单项禁用，`INV-TABLEOP-05`）。
     *
     * @param {string} cmd
     * @returns {Promise<{ok:boolean, status?:string, why?:string}>}
     */
    async function blockCommand(cmd) {
      const mod = LIVE.blockCmd;
      const a0 = active;
      if (!mod || !a0 || a0.cell || state !== 'editing') {
        return { ok: false, why: 'no-editing' };
      }
      if (!session || !ident) return { ok: false, why: 'no-document' };
      const block0 = blockAt(a0.index);
      if (!block0) return { ok: false, why: 'no-block' };
      const text0 = session.lines().slice(block0.from, block0.to).join('\n');
      let anchor = 0;
      let head = 0;
      if (a0.view && typeof a0.view.selection === 'function') {
        const s = a0.view.selection();
        if (s) { anchor = s.anchor; head = s.head; }
      }
      anchor = clampOffset(text0, anchor);
      head = clampOffset(text0, head);
      const caretLine = block0.startLine + lineOfOffset(text0, anchor);
      // ⚠️ 先提交落定（它自己是一次提交），再按**行**重取目标块。
      const left = await leave({ reason: 'block-command' });
      if (!left.ok) return { ok: false, why: 'commit-failed' };
      if (!session) return { ok: false, why: 'no-document' };
      const block = blockContainingLine(caretLine - 1);
      if (!block) return { ok: false, why: 'no-block' };
      const blockLines = session.lines().slice(block.from, block.to);
      const text = blockLines.join('\n');
      const out = mod.plan(cmd, text, clampOffset(text, anchor), clampOffset(text, head));
      if (!out) return { ok: false, why: 'no-op' };
      const payload = await runTransaction(null, {
        operation: 'block-command',
        objectKind: 'block',
        range: { from: block.from, to: block.to },
        next: model.splitLines(out.text),
        verify: null,
        selectionBefore: null,
        selectionAfter: null,
        group: 'block-command',
      });
      return {
        ok: payload.committed === true || payload.unchanged === true,
        status: payload.status,
        why: payload.why,
      };
    }

    /**
     * ⭐ **表格行列操作**（`design/0078` §2.3）：活动格 → 纯计划 → 一次整块提交。
     *
     * ⚠️ 结构拒绝（`uneven` / `header-row` / …）走 `note()` 中性提示，⛔ 不报红色失败：
     * 这是"这里不能这么做"，不是"程序坏了"。
     *
     * @param {string} cmd
     * @returns {Promise<{ok:boolean, status?:string, why?:string}>}
     */
    async function tableOp(cmd) {
      const mod = LIVE.table;
      const info = activeCellInfo();
      if (!mod || !info || state !== 'editing') return { ok: false, why: 'no-cell' };
      if (!session || !ident) return { ok: false, why: 'no-document' };
      const startLine = info.line;
      const flat = info.flat;
      const index = info.blockIndex;
      const left = await leave({ reason: 'table-op' });
      if (!left.ok) return { ok: false, why: 'commit-failed' };
      if (!session) return { ok: false, why: 'no-document' };
      const block = blockContainingLine(startLine - 1) || blockAt(index);
      if (!block) return { ok: false, why: 'no-block' };
      const cells = cellsOf(block.index);
      if (!cells) {
        note(t('status.table-rejected', { why: t('status.table-why.no-cells') }));
        return { ok: false, why: 'no-cells' };
      }
      const blockLines = session.lines().slice(block.from, block.to);
      const out = mod.apply(cmd, blockLines, cells, { startLine: block.startLine, flat: flat });
      if (!out.ok) {
        note(t('status.table-rejected', { why: t(`status.table-why.${out.why}`) }));
        return { ok: false, why: out.why };
      }
      const payload = await runTransaction(null, {
        operation: 'table-op',
        objectKind: 'table',
        range: { from: block.from, to: block.to },
        next: out.lines,
        verify: null,
        selectionBefore: null,
        selectionAfter: null,
        group: 'table-op',
      });
      return {
        ok: payload.committed === true || payload.unchanged === true,
        status: payload.status,
        why: payload.why,
      };
    }

    /**
     * 活动格的**表格能力**（菜单置灰用；只读，⛔ 不产生改动）。
     * `null` = 没有活动格 / 不在编辑态 / 这张表没有格子。
     * @returns {Object|null}
     */
    function tableCapabilities() {
      const mod = LIVE.table;
      const info = activeCellInfo();
      if (!mod || typeof mod.capacity !== 'function' || !info
        || state !== 'editing' || !session) return null;
      const block = blockAt(info.blockIndex);
      if (!block) return null;
      const cells = cellsOf(block.index);
      if (!cells) return null;
      const lines = session.lines().slice(block.from, block.to);
      const cap = mod.capacity(lines, cells, { startLine: block.startLine, flat: info.flat });
      if (!cap || cap.ok !== true) return cap || null;
      return {
        ok: true,
        uneven: cap.uneven,
        columns: cap.columns,
        column: cap.column,
        rowIndex: cap.rowIndex,
        rowCount: cap.rowCount,
        blockIndex: block.index,
      };
    }

    const api = {
      state: function () {
        return state;
      },
      activeIndex: function () {
        return active ? active.index : null;
      },
      /**
       * ⭐ `design/0061` L4：**只读**的活动视图（选中浮动格式栏用的最小暴露）。
       *
       * 返回的是 `main.js::makeLiveView` 的适配对象（`dom` / `lines` / `selection`
       * / `focusAt` …），⛔ **不是** CM6 的 `EditorView`：本控制器刻意不碰 CM6
       * （文件头的第三条不变量），格式栏自己用 `EditorView.findFromDOM(adapter.dom)`
       * 取回真视图再 `dispatch`。⛔ 别在这里加写入口——编辑仍然只经 `view.dispatch`。
       *
       * @returns {object|null} 没在编辑 / 视图已销毁 ⇒ `null`
       */
      activeView: function () {
        return active && active.view ? active.view : null;
      },
      isEditing: function () {
        return state === 'editing' || state === 'committing';
      },
      isDirty: dirty,
      lines: function () {
        return session ? session.lines() : null;
      },
      fullText: function () {
        return session ? session.fullText() : null;
      },
      lineCount: function () {
        return session ? session.lineCount() : 0;
      },
      stackSize: function () {
        return session ? session.stack().size() : 0;
      },
      canUndo: function () {
        return state === 'viewing' && session !== null && session.stack().size() > 0;
      },
      /** ⭐ `⇧⌘Z` 能不能用（`bugs/0020` §8）：`Viewing` 态 ＋ 重做栈非空。 */
      canRedo: function () {
        return state === 'viewing' && session !== null && session.stack().redoSize() > 0;
      },
      blocks: function () {
        return table;
      },
      /** ⭐ 某个块的单元格区间（`null` ⇒ 这张表没有可配对的格子）。 */
      cellsOf: cellsOf,
      /** ⭐ 某个块的任务项区间（`null` ⇒ 这张表没有任务项）。 */
      tasksOf: tasksOf,
      /**
       * ⭐ **当前活动目标是不是一格里**（`null` = 块形态 / 没在编辑）。
       * `main.js` 用它决定 `reseat` 要重取"整块"还是"第 n 格"、以及 `Tab`/`Enter` 走格。
       *
       * ⚠️ 它**故意不看 `state`**：`leave()` 提交落定之前 `active` 不清（失败时要保住
       *    输入），而 `reseat` 恰好需要那一刻的格（重渲后把视图挂回原格）。跨格导航的
       *    基准请用 `activeCellForNav()`——两者混用就是"快速连按以旧格为基准"的根因。
       */
      activeCell: activeCellInfo,
      /**
       * ⭐ **跨格导航的基准格**（`bugs/0104` 连按）：只在**真正处于编辑态**时返回。
       *
       * 现象：`leave()` 提交期间 `state` 是 `'committing'`、`active` 仍是**旧格**；
       * 快速连按时第二次按键若拿 `activeCell()` 当基准，会以旧格再排队一次 `begin`
       * （目标跳格或回到同一格）。⇒ 提交中 / 准备中一律给 `null`，调用方
       * （`main.js::navigateCell`）据此把按键按普通按键处理，⛔ 不吞键。
       */
      activeCellForNav: function () {
        if (state !== 'editing') return null;
        return activeCellInfo();
      },
      /** ⭐ `design/0078`：块命令（一条命令 = 一次整块提交 = 一次撤销）。 */
      blockCommand: blockCommand,
      /** ⭐ `design/0078`：表格行列操作（同上；没有活动格时返回 `{ok:false}`）。 */
      tableOp: tableOp,
      /** ⭐ `design/0078`：活动格的表格能力（菜单置灰用，只读）。 */
      tableCapabilities: tableCapabilities,
      /**
       * ⭐ **把光标挪到屏幕上的某一点**（`bugs/0069`）：用户点的那一处**就是**正在编辑的这一格时，
       * 这一下只该改选区，⛔ 不该走 `begin()`——那条路会 `leave('switch')`：提交 ＋ 整篇重渲 ＋
       * 重新申请写授权 ＋ 换宿主，落点还得在重渲之后**重新**把屏幕坐标映射回新布局 ⇒
       * 实测停在最后一个字之前（用户 2026-11-04：「行尾无法插入光标」「使用 → 无法走到行尾」）。
       * ⚠️ 只对**活动视图**生效：没在编辑 / 视图没了 ⇒ `false`，调用方按原路走。
       * @param {{x:number, y:number}} point 视口坐标（`event.clientX/clientY`）
       * @returns {boolean}
       */
      focusPoint: function (point) {
        // ⭐ 失败必须**可诊断**（缺陷：纵向跨格后光标悄悄落在格首、没有任何提示）：
        //    契约仍是 `return false`（⛔ 不抛——抛会走到全局 `reportFatal`，用户看到
        //    「启动失败」），但同时走既有 console 诊断通道写明是哪一条不满足，
        //    调用方（`main.js::crossCellVertical`）再据此降级到默认格首。
        if (state !== 'editing' || !active || !active.view) {
          console.warn('[rmd-live] focusPoint：当前不在编辑态（state=' + state + '），定位请求忽略');
          return false;
        }
        if (typeof active.view.focusAt !== 'function') {
          console.warn('[rmd-live] focusPoint：活动视图没有 focusAt，定位请求忽略');
          return false;
        }
        active.view.focusAt(point);
        return true;
      },
      issues: function () {
        return issues;
      },
      identity: function () {
        return ident;
      },
      notePayload: notePayload,
      begin: begin,
      /**
       * ⭐ `⌘↵`：跳出当前块，在它后面新起一个正文段落，光标放进去，**不退出编辑态**
       * （`bugs/0024`，2026-10-28 用户更正）。语义与三步做法见 `newParagraph()` 的注释。
       * @returns {Promise<boolean>}
       */
      newParagraph: newParagraph,
      /** ⭐ 一次 `⌘Z` 撤回「新起一段」这**一整步**（内容 ＋ 光标），见 `undoNewParagraph()`。 */
      undoNewParagraph: undoNewParagraph,
      /** ⭐ 当前活动目标是不是「`⌘↵` 新起的那一段」（合成块 ⇒ `reseat` 要跳过）。 */
      isNewParagraph: function () {
        return !!(active && active.synthetic);
      },
      commit: commit,
      toggleTask: toggleTask,
      leave: leave,
      reseat: reseat,
      save: save,
      undo: undo,
      /** ⭐ `⇧⌘Z`（`Viewing` 态）：重做最近一次撤销的提交（`bugs/0020` §8）。 */
      redo: redo,
      reset: reset,
      /** 进入时拿到的信封（`save()` 要还回去；`main.js` 也要用它显示那条提示）。 */
      envelope: function () {
        return lastEnvelope;
      },
      /**
       * ⭐ **最近一次事务的完整载荷**（`design/0059` 阶段 A）：五种状态、修订、选前/选后选区、
       * 对象种类与操作种类。⚠️ 只读观测口（探针与判据拿它和实际执行对表）；
       * ⛔ 不参与判定，也⛔ 不能当"这次提交成功"的凭据——那要看 `status`。
       * @returns {TxPayload|null}
       */
      lastTransaction: function () {
        return lastTx;
      },
    };

    return api;
  }

  // ⭐ **块内撤销已归 CM6 的 `history()`**（`design/0052` U2，2026-10-27）：
  //    这里原本有一份"快照栈"实现（每次改动前压一份全文），已删除。
  //    ⚠️ 原因写在 `tools/cm6/entry.mjs` 的文件头：撤销 / 重做是**文档语义**，属 A 栏；
  //    自己记一份的代价是"分组、选区随撤销恢复、重做栈作废"三件事全都要重写一遍。
  //    ⛔ **别写回来**：撤销的接线在 `main.js`（`CM6.history()` ＋ `CM6.undo(view)`）；
  //    控制器上的 `api.undo` 是**多块的提交栈**，与块内撤销不是一回事。

  function round1(n) {
    return Math.round(Number(n) * 10) / 10;
  }

  const api = {
    LIMITS: LIMITS,
    HEIGHT_TOLERANCE: HEIGHT_TOLERANCE,
    MAX_COMMIT_ROUNDS: MAX_COMMIT_ROUNDS,
    sliceLines: sliceLines,
    rangeOf: rangeOf,
    identOfPayload: identOfPayload,
    replyOfPayload: replyOfPayload,
    createController: createController,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveController = api;
})();
