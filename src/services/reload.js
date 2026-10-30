// 自动重载的**纯逻辑**（`design/0006` §2.1 ④⑤⑥）。
//
// 这个文件里**没有任何 I/O、没有计时器、没有 DOM**——它只回答四个问题：
//
// | 函数 | 问题 |
// |---|---|
// | `autoReloadDecision` | 这一份文档重载得起吗？还是只能提示用户手动按？ |
// | `acceptEvent` | 这条变化事件是我这一轮监视的吗？ |
// | `pickAnchor` | 重载**之前**，把"用户读到哪儿了"记成什么？ |
// | `resolveAnchor` | 重载**之后**，怎么把它变回一个 `scrollTop`？ |
//
// ⚠️⚠️ **为什么闸门只有这一份实现**（`design/0006` §3 的改动面里写的是 Rust 侧
// `external.rs` 也要有一份"可 `cargo test` 的纯函数式闸门"）：
// 运行时做这个决定需要的是**前端手里那份 payload 的计时**（T1/T2/T3 与字节数），
// 而 Rust 侧要再算一遍就得把同一份数字再传一次——于是它会变成
// 「**同一判据的两份实现，其中一份没有调用方**」。
// ⭐ 本项目对"留着不调的代码"有明文禁令（§8：⛔ 不许把回滚做成"函数留着不调"）。
// ⇒ 闸门**只在这里**，由 `tests/js/reload.test.js` 覆盖（边界含 499/500/501 与 1 MiB）。
//
// ⚠️ 与 `versions.js` / `chunked.js` 一样：⛔ **纯逻辑**、可 `node --test`、
// 且**必须**包 IIFE（经典脚本共享全局词法作用域，见 `session.js` 顶部那段）。
(function () {
  'use strict';

  /**
   * ⭐ **debounce 窗口**（`design/0006` §9.3 第 3 条：300 ms 作为初值）。
   *
   * ⚠️ 为什么必须有它：编辑器保存一次，FSEvents 会报出**多条**事件
   * （实测同一操作报过 2 / 6 / 11 条，`kb/0020`）——每一条都触发一次全量重渲染
   * 就是"保存一次卡十下"。⚠️ 这也说明**⛔ 别把"事件条数"当判据**。
   */
  const DEBOUNCE_MS = 300;

  /**
   * ⭐ **降级闸门**：估算重载耗时超过它 ⇒ 不自动重载，只提示（§2.1 ④ / §9.3 第 3 条）。
   *
   * ⚠️ 代价的量级来自 `design/0006` §1.2 的实测：同一份 10.5 MB 的文档，
   * 编码高亮那一族把它从 **26.8 ms** 推到 **3381.5 ms**（126×）。
   * ⇒ 自动重载必须有一个"值不值得自己动手"的门槛，否则用户每敲一次保存
   * 就换来三秒白屏。
   */
  const GATE_MS = 500;

  /**
   * ⭐ **兜底闸门**：没有任何历史计时时（第一次重载）用的字节上限（§2.1 ④）。
   *
   * ⚠️ 1 MiB 是**照经验取的初值**，⛔ 不是实测结论——它的依据只有一条：
   * 闸门要有一个"连数据都没有时也说得过去"的底线，而 1 MiB 的 Markdown
   * 在绝大多数机器上远在 500 ms 以内（`benchmarks/results/` 里 10 MB 量级
   * 才进入秒级）。⚠️ 真正的判据是**上一次的实际耗时**，这个数只在
   * "刚打开、还没有任何一次计时"的头一次重载上用得到。
   */
  const FALLBACK_MAX_BYTES = 1024 * 1024;

  /**
   * 这一份文档**该自动重载，还是只提示**？
   *
   * @param {number|null} prevMs 上一次这份文档整段渲染的耗时（T1+T2+T3）。`null` = 没有历史。
   * @param {number|null} bytes 这份文档的源字节数（`payload.source_bytes`）。
   * @returns {'auto'|'notice'}
   *
   * ⭐ **优先用实测历史**（`prevMs`），没有历史才退到字节数——顺序不能反：
   * 同一份 1 MB 的文档在不同机器上可能差一个数量级，而"上一次花了多久"
   * 是**这台机器上的这份文档**的真实数字。⛔ 反过来会让首次重载的判据
   * 与之后的判据来自两个不同的量。
   *
   * ⚠️ 三个边界都要说得清（`tests/js/reload.test.js` 逐条测）：
   * ① 恰好等于 `GATE_MS` **算过**（`<=`，⛔ 不是 `<`）；
   * ② `null` / 非数 / `NaN` 一律**跳过**该档，⛔ 不当成 0（那会让"没采到"
   *    变成"很快，放心重载"——正是 `measure.js` 那条"采不到是 null 不是 0"的同族错误）；
   * ③ 两档都没有（全新会话、连字节数都没有）⇒ `'auto'`：
   *    此时用户刚打开这份文档，**没有任何证据说明它重不起来**，
   *    而"提示他手动重载"在没有理由时只是噪音。
   */
  function autoReloadDecision(prevMs, bytes) {
    if (typeof prevMs === 'number' && isFinite(prevMs)) {
      return prevMs <= GATE_MS ? 'auto' : 'notice';
    }
    if (typeof bytes === 'number' && isFinite(bytes) && bytes >= 0) {
      return bytes <= FALLBACK_MAX_BYTES ? 'auto' : 'notice';
    }
    return 'auto';
  }

  /**
   * 这条变化事件**要不要收**？
   *
   * @param {object|null} ev 后端 `rmd://document-changed` 的载荷 `{path, seq}`。
   * @param {number} seq 前端手里那个监视代号（`state.watchSeq`，0 = 没有监视）。
   * @param {string|null} path 前端认为正在显示的那份文档（`state.currentPath`）。
   *
   * ⭐ 三个判据缺一不可：
   * ① `seq` 相等——它是"**哪一轮监视**"的代号（`INV-EXT-06`：换文档必须换 `seq`，
   *    否则上一份文档的迟到事件会把这一份重载一遍）；
   * ② `path` 相等——**第二道**，防的是"后端换了目标而前端还不知道"；
   * ③ `seq` 不能是 0——0 = 没有监视，此时**任何**事件都不该被接受。
   *
   * ⚠️ ①③ 一起看才严密：只判 `ev.seq === seq` 的话，`0 === 0` 会让
   * "没有监视"这个状态**恰好接受**一条 `seq` 为 0 的事件（真实事件不会带 0，
   * 但判据的边界应当自己站得住，⛔ 不依赖对面守规矩）。
   */
  function acceptEvent(ev, seq, path) {
    if (!ev || typeof ev !== 'object') return false;
    if (typeof seq !== 'number' || seq <= 0) return false;
    if (typeof ev.seq !== 'number' || ev.seq !== seq) return false;
    if (typeof ev.path !== 'string' || !ev.path) return false;
    if (!path || ev.path !== path) return false;
    return true;
  }

  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  /**
   * 重载**之前**：把当前阅读位置记成一个可恢复的锚点（`design/0006` §6.1 三级）。
   *
   * @param {number} scrollTop 当前滚动位置。
   * @param {Array<{id: string, top: number}>} headings 大纲项在**当前**文档里的像素位置
   *        （由调用方用 `getBoundingClientRect` + `scrollTop` 现算）。
   * @param {number} scrollHeight
   * @param {number} clientHeight
   * @returns {{id: string|null, offset: number, ratio: number|null}|null}
   *          `null` = **没有位置可记**（文档还没超出视口）。
   *
   * ⭐ 三级锚点的第一级是**标题 + 行内偏移**：文档被编辑之后，"第 3200 行"
   * 会漂，但"某个标题往下 40 px"在多数编辑下仍指向同一个地方。
   * 第二级是**比例**，给"标题被删了"兜底。
   *
   * ⚠️ 返回 `null` 而不是一个空锚点是**有意的**：文档还没超出视口时
   * （`scrollHeight <= clientHeight`）滚动位置**只可能是 0**，
   * 那时"恢复位置失败"不是一个真实的损失，⛔ 不该弹提示
   * （见 `resolveAnchor` 的 `notice`）。
   */
  function pickAnchor(scrollTop, headings, scrollHeight, clientHeight) {
    const max = Math.max(0, scrollHeight - clientHeight);
    const list = Array.isArray(headings) ? headings : [];
    // ⭐ 取**最后一个 top <= scrollTop** 的标题，⛔ 不假定列表有序**也不假定**
    //    "第一个不满足就停"（生成的 DOM 顺序与视觉顺序在有多列/浮动时会分叉）。
    let id = null;
    let offset = 0;
    let bestTop = -Infinity;
    for (const h of list) {
      if (!h || typeof h.id !== 'string' || !h.id) continue;
      if (typeof h.top !== 'number' || !isFinite(h.top)) continue;
      if (h.top <= scrollTop && h.top > bestTop) {
        bestTop = h.top;
        id = h.id;
        offset = scrollTop - h.top;
      }
    }
    if (max <= 0 && id === null) return null;
    return { id, offset, ratio: max > 0 ? clamp(scrollTop / max, 0, 1) : null };
  }

  /**
   * 重载**之后**：把锚点变回一个 `scrollTop`（`design/0006` §6.1）。
   *
   * @param {object|null} anchor [`pickAnchor`] 的返回值（`null` = 当时没记）。
   * @param {Array<{id: string, top: number}>} headings **新**文档里的大纲位置。
   * @param {number} scrollHeight
   * @param {number} clientHeight
   * @returns {{kind: 'heading'|'ratio'|'top', scrollTop: number, notice: boolean}}
   *
   * ⭐ `notice` 就是 §6.1 那句"**两条都不可用 ⇒ 回顶部 + 必须提示**"的落地：
   * ⛔ 静默回顶部是明令禁止的失败形态（用户会以为"文档被改了、我看到的是开头"）。
   * ⚠️ 但 `anchor === null`（当时没有位置可记）**不算**失败 ⇒ 不提示。
   */
  function resolveAnchor(anchor, headings, scrollHeight, clientHeight) {
    const max = Math.max(0, scrollHeight - clientHeight);
    if (!anchor || typeof anchor !== 'object') {
      return { kind: 'top', scrollTop: 0, notice: false };
    }
    const list = Array.isArray(headings) ? headings : [];
    if (typeof anchor.id === 'string' && anchor.id) {
      for (const h of list) {
        if (!h || h.id !== anchor.id) continue;
        if (typeof h.top !== 'number' || !isFinite(h.top)) continue;
        const off = typeof anchor.offset === 'number' && isFinite(anchor.offset) ? anchor.offset : 0;
        return { kind: 'heading', scrollTop: clamp(h.top + off, 0, max), notice: false };
      }
    }
    // ⚠️ 新文档**没有可滚的东西**（改短了 / 改到只剩一屏）⇒ 位置只可能是 0，
    //    "恢复不了"在这时**不是一个损失**。⛔ 别在这里弹提示：
    //    那正是"狼来了"——用户看到一句没有对应事实的警告，下次就学会忽略它。
    if (max <= 0) return { kind: 'top', scrollTop: 0, notice: false };
    if (typeof anchor.ratio === 'number' && isFinite(anchor.ratio)) {
      return { kind: 'ratio', scrollTop: clamp(anchor.ratio * max, 0, max), notice: false };
    }
    return { kind: 'top', scrollTop: 0, notice: true };
  }

  const api = {
    DEBOUNCE_MS,
    GATE_MS,
    FALLBACK_MAX_BYTES,
    autoReloadDecision,
    acceptEvent,
    pickAnchor,
    resolveAnchor,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).reload = api;
})();
