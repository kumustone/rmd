// ⭐ 阅读进度的**纯逻辑**（`design/0017` §2.3 ②）。
//
// ⚠️ **这里不碰 DOM、不取 `window.rmd.*`**：
//    - 锚点怎么取、怎么解，仍然只有 `services/reload.js` 一份
//      （`design/0006` §8：同一判据两份实现，其中一份没有调用方）；
//    - 本模块只做**形状转换与频控**，所以它能在 `node --test` 里逐条钉边界。
//
// ⚠️ 三件事**刻意不在这里**：
//   ① 读 `S.state.readingProgress`（那是 `main.js` 的事）；
//   ② 发 IPC / 建定时器（纯函数才能被断言）；
//   ③ 用"像素接近"判断"用户没动过"——用户滚走再回来，像素也一样
//      ⇒ 接管判据是**输入事件**，见 `main.js`（评审 R4）。
//
// ⚠️ **排在 `services/reload.js` 之后、`services/session.js` 之前**：
//    它没有加载期依赖，但经典脚本按顺序执行，必须在 `main.js` 之前存在。
(function () {
  'use strict';

  /** 停止滚动多久后写一次（`design/0017` §2.3 ②）。 */
  const SAVE_IDLE_MS = 1500;
  /** 两次写盘的最小间隔（⭐ `persist_failed` 的重试也受它约束）。 */
  const MIN_INTERVAL_MS = 2000;
  /** 同一标题内小于 8 px 的变化不写。 */
  const OFFSET_EPS = 8;
  /** 比例变化小于 0.5% 不写。 */
  const RATIO_EPS = 0.005;
  /** 标题 id 的长度上限（**字符数**，与后端 `MAX_PROGRESS_ID_CHARS` 同一把尺子）。 */
  const MAX_ID_CHARS = 256;

  function finite(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function normId(id) {
    if (typeof id !== 'string' || id === '') return null;
    // ⚠️ 超长 id **整个丢弃**（⛔ 不截成前缀——前缀可能恰好匹配另一个标题）。
    //    `Array.from` 按**码点**数，与后端 `chars().count()` 同口径；
    //    `String.length` 会把 emoji 数成 2。
    if (Array.from(id).length > MAX_ID_CHARS) return null;
    return id;
  }

  function round(v, digits) {
    const m = Math.pow(10, digits);
    return Math.round(v * m) / m;
  }

  /** 这条记录还有没有任何可用信息（与后端 `sanitized()` 的"整条不写"判据一致）。 */
  function usable(entry) {
    if (!entry) return false;
    return normId(entry.id) !== null || finite(entry.ratio);
  }

  /**
   * `pickAnchor()` 的返回值 → 落盘条目（`design/0017` 表第 1 行）。
   *
   * [anchor] 为 `null`、或者"既没有 id 也没有 ratio" ⇒ `null`（⛔ 不写一条空记录）。
   */
  function toEntry(anchor, sourceBytes) {
    if (!anchor) return null;
    const id = normId(anchor.id);
    const ratio = finite(anchor.ratio) ? round(Math.min(1, Math.max(0, anchor.ratio)), 6) : null;
    if (id === null && ratio === null) return null;
    const offset = finite(anchor.offset) ? round(Math.max(0, anchor.offset), 1) : 0;
    return {
      id: id,
      offset: offset,
      ratio: ratio,
      source_bytes: finite(sourceBytes) && sourceBytes >= 0 ? Math.floor(sourceBytes) : 0,
    };
  }

  /** 落盘条目 → `resolveAnchor()` 认的锚点形状；不可用 ⇒ `null`。 */
  function toAnchor(entry) {
    if (!usable(entry)) return null;
    return {
      id: normId(entry.id),
      offset: finite(entry.offset) ? Math.max(0, entry.offset) : 0,
      ratio: finite(entry.ratio) ? Math.min(1, Math.max(0, entry.ratio)) : null,
    };
  }

  /** 两条记录算不算"同一个位置"（±8 px / ±0.5%）。 */
  function same(a, b) {
    if (!a || !b) return false;
    if (normId(a.id) !== normId(b.id)) return false;
    const ao = finite(a.offset) ? a.offset : 0;
    const bo = finite(b.offset) ? b.offset : 0;
    if (Math.abs(ao - bo) >= OFFSET_EPS) return false;
    const ar = finite(a.ratio) ? a.ratio : null;
    const br = finite(b.ratio) ? b.ratio : null;
    if (ar === null && br === null) return true;
    if (ar === null || br === null) return false;
    return Math.abs(ar - br) < RATIO_EPS;
  }

  /**
   * 挂载后该不该恢复（`design/0017` 表第 3 行）。
   *
   * ⭐ 三态：`'skip'`（条目不可用）/ `'apply'`（现在就能滚）/ `'defer'`（**现在滚不动，但意图保留**）。
   * ⚠️ `'defer'` 是评审 R3 的直接产物：图片还没落定、页面比视口短时，
   *    直接跳成 `'skip'` 会让进度**永远不恢复**（那正是"打开大图文档总是回到顶部"）。
   */
  function restorePlan(entry, scrollable) {
    if (!usable(entry)) return 'skip';
    return scrollable ? 'apply' : 'defer';
  }

  /**
   * 这次该不该写盘（`design/0017` 表第 4 行）。
   *
   * @param {{entry: object, at: number, persisted: boolean}|null} last 同一路径上次的基线
   * @param {object|null} next 本次捕获的位置
   * @param {number} sinceLastMs 距上次写入多少毫秒
   * @param {boolean} force 切换文档 / 隐藏 / 退出前的冲刷
   * @returns {{action: 'skip'|'wait'|'save', waitMs: number}}
   */
  function planSave(last, next, sinceLastMs, force) {
    if (!next) return { action: 'skip', waitMs: 0 };
    if (force) return { action: 'save', waitMs: 0 };
    const since = finite(sinceLastMs) ? Math.max(0, sinceLastMs) : 0;
    if (last && same(last.entry, next)) {
      // ⭐ 已经**确认落盘**的同值 ⇒ 什么都不做。
      if (last.persisted === true) return { action: 'skip', waitMs: 0 };
      // ⚠️ `persisted: false`（上次 `persist_failed`）**允许按间隔重试**——
      //    ⛔ 不能因为"值没变"永久放弃（评审 R2）。
    }
    if (last && since < MIN_INTERVAL_MS) {
      return { action: 'wait', waitMs: MIN_INTERVAL_MS - since };
    }
    return { action: 'save', waitMs: 0 };
  }

  /**
   * 图片落定之后还该不该校正一次（`design/0017` §2.3 ⑤，评审 R4）。
   *
   * ⭐ 六个条件**全要满足**：挂载代号相同 ∧ 路径未变 ∧ 会话号未变 ∧ 不在编辑态
   * ∧ 未过期 ∧ **用户没有接管**。
   * ⚠️ 挂载代号是"迟到回调"的第一道闸：换了一份文档之后，
   *    上一份的图片回调**仍然会到达**，它不许动新正文的恢复意图。
   */
  function shouldCorrect(pending, mountGen, pathNow, docSeqNow, editingNow, userTookOver, now) {
    if (!pending) return false;
    if (pending.userAborted === true) return false;
    if (userTookOver === true) return false;
    if (pending.mountGen !== mountGen) return false;
    if (pending.path !== pathNow) return false;
    if (pending.docSeq !== docSeqNow) return false;
    if (editingNow === true) return false;
    if (finite(pending.expires) && now > pending.expires) return false;
    return true;
  }

  /**
   * 把后端回来的**规范化条目**并入运行期恢复表（`design/0017` §2.3 ③，评审 R1）。
   *
   * ⭐ 后端清洗/盖章后的条目才是真值（前端那份可能刚被夹过 / 舍入过）；
   *    `evicted` 必须一起消费，否则表里会留着一条后端已经淘汰的历史。
   * @returns {number} 实际删掉的条数（幂等：第二次并同一份 ⇒ 0）
   */
  function mergeWrite(table, path, entry, evicted) {
    if (table && entry) table[path] = entry;
    let removed = 0;
    if (table && Array.isArray(evicted)) {
      for (let i = 0; i < evicted.length; i++) {
        const p = evicted[i];
        if (Object.prototype.hasOwnProperty.call(table, p)) {
          delete table[p];
          removed += 1;
        }
      }
    }
    return removed;
  }

  const api = {
    SAVE_IDLE_MS: SAVE_IDLE_MS,
    MIN_INTERVAL_MS: MIN_INTERVAL_MS,
    OFFSET_EPS: OFFSET_EPS,
    RATIO_EPS: RATIO_EPS,
    MAX_ID_CHARS: MAX_ID_CHARS,
    usable: usable,
    toEntry: toEntry,
    toAnchor: toAnchor,
    same: same,
    restorePlan: restorePlan,
    planSave: planSave,
    shouldCorrect: shouldCorrect,
    mergeWrite: mergeWrite,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).progress = api;
})();
