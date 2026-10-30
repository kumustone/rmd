// 盘上变更的**前端唯一入口**（`design/0050` 最终约束 3/4/5/8）。
//
// # 它解决的三个问题
//
// | 问题 | 它怎么答 |
// |---|---|
// | "这条在途结果描述的是哪个时刻的盘？" | [`seq`] —— **收到 IPC 那一刻**同步 +1
// |                                     （`tree-changed`，以及 `dir-watch` 里 `epoch` 前进时） |
// | "监视还活着吗？" | [`state`] —— 后端 `DiskView`（纯身份元数据：⛔ 无路径） |
// | "用户想从盘上重来一次？" | [`refresh`] / [`retryWatch`] —— 两条**窄命令** |
//
// # 三条承重约定
//
// 1. **`seq` 在原始 IPC 到达时同步前进**（最终约束 4）：⛔ 不等去抖广播之后的
//    "树刷新完成"。理由：在飞的 `list_dir` / `search_files` 必须在**提交点**
//    就能看见"我描述的那个时刻已经过去了"。⚠️ 后端的去抖只推迟**重列**，不推迟失效。
//    ⇒ 两条通道都推：`tree-changed` 是**该重列了**，`dir-watch` 的 `epoch` 前进是
//    **盘上真的变了**（⚠️ 它的健康那半⛔ 不推，见 [`adopt`]）。
// 2. **`dir-watch` 按 `revision` 丢弃倒退的包**（最终约束 3）：事件可能乱序到达，
//    而"健康"是一个**状态**不是一次事件——按到达顺序覆盖会让界面在
//    "已恢复"与"仍在降级"之间来回闪。
// 3. **`reason` 的措辞固定**（⛔ 不随语言变）：它是协议的一部分，i18n 在展示层做。
//
// ⚠️ **为什么单独成一个文件**：它是纯逻辑 ＋ 两条 IPC，`node --test` 里能直接跑
// （与 `services/treerefresh.js` / `services/reload.js` 同一条纪律）。
// ⚠️ **它必须排在 `main.js` 之前**（`index.html`）：`main.js` 加载期就取它。
(function () {
  'use strict';

  /** 两条通道的事件名。⭐ 与 Rust 侧 `external.rs::watch` 里那两个常量逐字一致。 */
  const TREE_EVENT = 'rmd://tree-changed';
  const DISK_EVENT = 'rmd://dir-watch';

  /** 前端侧的内容序号：
   *  **收到 `rmd://tree-changed` 那一刻**同步 +1。
   *  ⚠️ 它与后端的 `epoch` **不是**同一个数（那个只有后端知道），
   *  两个都叫"内容修订"但各自服务一侧的提交点——⛔ 别拿它去跟 `payload.epoch` 比。
   */
  let seq = 0;

  /** 最后一份 `DiskView`（`null` = 还没收到过）。
   *  ⚠️ 字段全是身份元数据：`epoch` / `watch_id` / `revision` / `reason` / `pending`。
   */
  let view = null;

  /** 最后**采纳过**的那一版内容修订（后端 `DiskState::epoch`）。
   *
   *  ⚠️ 它与 [`seq`] **不是同一个数**，也⛔ 不该相同：`seq` 是前端的计数器，
   *  `epoch` 只有后端知道。这里只用它判一件事——**盘上内容真的前进了没有**
   *  （纯健康变化不推进 `epoch`，所以它不该让在途结果作废）。
   *
   *  ⚠️⚠️ **重接监视（[`retryWatch`]）推进会它**（2026-10-29 评审第 9 条）：重接之前
   *  那段盲窗口里盘上可能变过 ⇒ 后端 `Reattach` 推纪元 ⇒ 在途结果**该**作废。
   *  ⛔ 别把"它只是修管道"读成"不该推 `seq`"。
   *
   *  ⚠️ 初值取 `0`：后端 `DiskState::epoch` 从 0 起（`disk.rs`），
   *  这样**启动时第一份 `DiskView` 不会白推一次 `seq`**（白推的代价是一次多余的 `rev` 重列）。
   */
  let lastEpoch = 0;

  /** `seq` 变化时通知的回调（**内容**变了）。 */
  const listeners = [];

  /** `DiskView` 变化时通知的回调（**健康**变了）。 */
  const stateListeners = [];

  let installed = false;

  // ── 纯逻辑（`node --test` 能直接钉） ────────────────────────────────

  /**
   * 这一份 `DiskView` 要不要**采纳**（最终约束 3：丢弃倒退的包）。
   *
   * 判据三条：
   * 1. 形状不对（缺 `revision`）⇒ ⛔ 不采纳；
   * 2. 还没有过任何一份 ⇒ 采纳；
   * 3. 否则 **`revision` 必须严格更大**（相等 = 重复，倒退 = 迟到）。
   *
   * ⚠️ ⛔ 不按"值看起来更严重"来合并：`Io` 之后的一版 `null` 可能是真的恢复了，
   * 也可能是迟到的旧包——只有 `revision` 能区分，别猜。
   */
  function shouldAccept(prev, next) {
    if (!next || typeof next.revision !== 'number') return false;
    if (!prev) return true;
    return next.revision > prev.revision;
  }

  /**
   * 一份 `DiskView` 该在状态条上显示成什么（`null` = 什么都不显示）。
   *
   * @returns {{key:string, retry:boolean, transient:boolean}|null}
   *   `key` 是 i18n 的键（**万一没有对应文案**，展示层要退回 `reason` 原文——
   *   ⛔ 不许把未知档静默成"没事"）。
   */
  function healthOf(v) {
    if (!v || !v.reason) return null;
    switch (v.reason) {
      case 'rescan':
        // ⚠️ 临时档：它自己会好（核对完就消失）⇒ **不给**"重试"按钮。
        return { key: 'disk.rescan', retry: false, transient: true };
      case 'io':
        return { key: 'disk.io', retry: true, transient: false };
      case 'path-not-found':
        return { key: 'disk.path-not-found', retry: true, transient: false };
      case 'limit':
        return { key: 'disk.limit', retry: true, transient: false };
      case 'rewatch-failed':
        return { key: 'disk.rewatch-failed', retry: true, transient: false };
      default:
        // ⭐ 后端加了新档而前端还没跟上：**照实显示那个串**，
        //    ⛔ 不静默成 `null`（那正是"监视坏了但界面不吭声"）。
        return { key: '', retry: true, transient: false };
    }
  }

  // ── 状态 ─────────────────────────────────────────────────────────────

  /** 当前内容序号。⭐ 调用方在**提交点**现取（⛔ 不在发请求时取）。 */
  function seqNow() {
    return seq;
  }

  /** 只推进序号，⛔ **不通知**（`adopt` 里那种"内容前进了但重列另有安排"的场景）。 */
  function advance() {
    seq += 1;
    return seq;
  }

  /** 通知 [`onChange`] 的订阅者。⚠️ 一个订阅者抛异常**不许**带走其它订阅者
   *  （最终约束 8 的"消费者抛异常"）：树与搜索是两条独立的消费者，一条坏了不该让另一条也瞎。
   */
  function notifyChange() {
    for (const fn of listeners.slice()) {
      try {
        fn(seq, view);
      } catch (e) {
        if (typeof console !== 'undefined') console.error('⛔ 磁盘事件订阅者抛异常：', e);
      }
    }
  }

  /** ⭐ 当作"收到了一条原始通知"——**同步**推进序号并通知订阅者。 */
  function bump() {
    advance();
    notifyChange();
    return seq;
  }

  /** 最后一份 `DiskView`（可能为 `null`）。 */
  function stateNow() {
    return view;
  }

  /**
   * 采纳一份 `DiskView`（来自 `dir-watch` 事件、手动刷新 / 重接监视的回包，或启动快照）。
   *
   * ⭐ 两件事分开做（最终约束 2 的"别把健康洗白成内容"）：
   * - **内容**：`epoch` 前进了 ⇒ [`advance`] 推一格 `seq`（⛔ 不通知）——
   *   那一格就是"在途的 `list_dir` / `search_files` 描述的时刻已经过去了"；
   * - **健康**：只通知 [`onState`] 的订阅者。
   *
   * ⚠️ 两者**不能合并**：纯健康变化（降级 / 恢复）时 `epoch` 不动，
   * 若它也推 `seq`，每次"监视抖一下"都会白重列一次树。
   * ⚠️ **重接监视属于例外**（评审第 9 条）：那段盲窗口里盘上可能变过，
   * 后端 `Reattach` 会推纪元 ⇒ 这里照常推 `seq`，在途结果**应当**作废。
   * ⚠️ 内容前进时**不通知** [`onChange`]：重列由后端去抖后的 `tree-changed` 或
   * 调用方自己那一趟负责，两边都通知就是**一次改动列两遍**。
   *
   * @returns {boolean} 是否真的采纳了（倒退 / 重复的包返回 `false`）
   */
  function adopt(next) {
    if (!shouldAccept(view, next)) return false;
    view = next;
    if (typeof next.epoch === 'number' && next.epoch !== lastEpoch) {
      lastEpoch = next.epoch;
      advance();
    }
    for (const fn of stateListeners.slice()) {
      try {
        fn(view);
      } catch (e) {
        // ⚠️ 同 [`notifyChange`]：一个消费者抛异常不许带走另一个。
        if (typeof console !== 'undefined') console.error('⛔ 磁盘状态订阅者抛异常：', e);
      }
    }
    return true;
  }

  /** 订阅"盘上可能变了"。@returns {function} 取消订阅 */
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /** 订阅"监视健康变了"（展示层用它重画那一行提示）。@returns {function} 取消订阅 */
  function onState(fn) {
    if (typeof fn !== 'function') return function () {};
    stateListeners.push(fn);
    return function () {
      const i = stateListeners.indexOf(fn);
      if (i >= 0) stateListeners.splice(i, 1);
    };
  }

  // ── IPC（唯一的两条出口，⛔ 别在别处再写一遍） ──────────────────────

  /**
   * ⭐ 装两条通道。**必须**在启动自检里 `await` 它——订阅失败要能被回报，
   * ⛔ 不许静默（静默失败的表现是"盘上变了但树不刷新"，与"没变化"长得一样）。
   *
   * @param {{listen:function}} T `services/tauri.js` 的实例
   * @returns {Promise<{treeOk:boolean, diskOk:boolean, note:string}>}
   */
  async function install(T) {
    if (installed) return { treeOk: true, diskOk: true, note: '' };
    installed = true;
    let treeOk = false;
    let diskOk = false;
    const notes = [];
    try {
      await T.listen(TREE_EVENT, function () {
        // ⭐ **同步**：这一行就是最终约束 4 那个"收到即失效"。
        //    ⚠️ 它之前**不许**再 `await` 任何东西——一 `await` 就变成"过一会儿才失效"。
        bump();
      });
      treeOk = true;
    } catch (e) {
      notes.push('tree:' + String((e && (e.message || e.wording)) || e));
    }
    try {
      await T.listen(DISK_EVENT, function (e) {
        // ⚠️ **恢复（`reason` 为 null）也要采纳**：那是"提示该撤掉了"的唯一信号。
        adopt(e && e.payload);
      });
      diskOk = true;
    } catch (e) {
      notes.push('disk:' + String((e && (e.message || e.wording)) || e));
    }
    return { treeOk: treeOk, diskOk: diskOk, note: notes.join('; ') };
  }

  /**
   * ⭐ **手动刷新**（`design/0050` 最终约束 5）：从盘上核对一次。
   *
   * ⚠️ 它与 [`retryWatch`] **不是**同一件事：这个说"盘上可能变了，重看一眼"，
   * 那个说"监视坏了，重接一条"。⚠️ 两者都由后端汇到同一个状态机。
   * ⚠️ 回包里 `epoch` 前进 ⇒ [`adopt`] 同步推 `seq`（在途结果作废），
   * 但⛔ **不通知** [`onChange`]：调用方随后自己那一趟重列就是这次刷新的落点，
   * 两边都做就是**按一下重列两遍**。
   */
  async function refresh(T) {
    const v = await T.call('reconcile_disk');
    if (v) adopt(v);
    return v;
  }

  /**
   * ⭐ **重接监视**（健康提示上的"重试"）。
   *
   * ⚠️ 它修的确实是**管道**，但⛔ 不等于"盘上什么都没变"：重接之前那一段没人接事件
   * 的窗口里盘上可能变过 ⇒ 后端走 `ReconcileCause::Reattach`，**推内容修订**
   * （2026-10-29 评审第 9 条：此前这里写的是「⛔ 不推内容修订」，与实现相反）。
   * ⇒ 回包里的 `epoch` 前进 ⇒ [`adopt`] 推 `seq` ⇒ 在途结果作废，这是**对的**。
   */
  async function retryWatch(T) {
    const v = await T.call('retry_tree_watch');
    if (v) adopt(v);
    return v;
  }

  /** 单测用：把内部状态清回初始（⛔ 产品代码别调）。 */
  function _reset() {
    seq = 0;
    view = null;
    lastEpoch = 0;
    listeners.length = 0;
    stateListeners.length = 0;
    installed = false;
  }

  const api = {
    TREE_EVENT,
    DISK_EVENT,
    shouldAccept,
    healthOf,
    seq: seqNow,
    bump,
    state: stateNow,
    adopt,
    onChange,
    onState,
    install,
    refresh,
    retryWatch,
    _reset,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).diskEvents = api;
})();
