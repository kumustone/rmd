// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// 全文变更事务的**协调层**：五阶段、五种结果、成对回滚 —— `design/0058` §2.2 / §2.5。
//
// # 它回答什么
//
// ① 一次变更的**结果**有五种，⛔ 不是一个布尔：
//    `committed` / `unchanged` / `rejected` / `stale` / `failed`（`design/0058` §2.2 的表）。
//    ⚠️ `stale` ⛔ 不是失败，也⛔ 不是无操作：它说的是"这一包的基线已经旧了"，
//    调用方**不许**把它读成"可以退出/可以清脏/可以报保存成功"。
// ② 一次变更在发布段失败时，要按**快照逐项退回**，⛔ 不是"再补一个 try/catch"。
//    回滚句柄**只归统一事务入口消费**，带 `txId` 所有权校验与修订校验，且**幂等**
//    ——旧事务的 `catch`/`finally` 拿到过期句柄时⛔ 不许把新会话恢复成旧状态。
// ③ 选区是**载荷的一部分**：带 `anchor`/`head`（方向）、`space`（文档 / 格内）、`revision`
//    与 `objectId`（`design/0058` §2.5）。⛔ 格内偏移不许裸加源码偏移。
//
// # 它⛔ 不做什么
//
// ⛔ 不碰 DOM、⛔ 不碰 CM6、⛔ 不发 IPC、⛔ 不认识 `session`/`view` 的具体形状。
// 每个"要退回去的东西"由调用方用 `frame.add(name, save, restore)` 声明，
// 于是整条判据都能在 node 里跑（`INV-LIVE-17`）。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，
// 顶层 `const` 撞名会让**整个文件不执行**（窗口空白、stderr 全静默）。

(function () {
  'use strict';

  /** ⭐ 事务的五种结果（`design/0058` §2.2）。⛔ 别在别处再写一套字符串。 */
  const STATUS = {
    COMMITTED: 'committed',
    UNCHANGED: 'unchanged',
    REJECTED: 'rejected',
    STALE: 'stale',
    FAILED: 'failed',
  };

  /**
   * 一次事务的结果。
   *
   * ⚠️ 同时给**状态**与**旧的三个布尔**（`committed`/`failed`/`why`）：现有调用方与
   *    测试按那三个读，本轮不要求它们一起改；但新代码⛔ 别再用"`failed === false`"
   *    推"成功了"——那会把 `stale` 与 `unchanged` 一起读成成功（`design/0058` §2.2）。
   *
   * @param {string} status [`STATUS`] 里的一个
   * @param {{why?:string, txId?:string|number|null, revision?:object|null,
   *          selection?:object|null, selectionLost?:boolean}} [o]
   */
  function result(status, o) {
    const r = o || {};
    const known = status === STATUS.COMMITTED || status === STATUS.UNCHANGED
      || status === STATUS.REJECTED || status === STATUS.STALE || status === STATUS.FAILED;
    // ⚠️ 写错状态名是**程序错误**，⛔ 不许静默折成 `failed`：
    //    折了之后"为什么没提交"在日志里就查不到了。
    if (!known) throw new Error(`unknown transaction status ${String(status)}`);
    return {
      status: status,
      committed: status === STATUS.COMMITTED,
      unchanged: status === STATUS.UNCHANGED,
      rejected: status === STATUS.REJECTED,
      stale: status === STATUS.STALE,
      failed: status === STATUS.FAILED,
      why: r.why === undefined || r.why === null ? '' : String(r.why),
      txId: r.txId === undefined ? null : r.txId,
      revision: r.revision || null,
      selection: r.selection || null,
      selectionLost: r.selectionLost === true,
    };
  }

  /** 修订的**比较键**（`docSeq` ＋ `commitSeq`）：⛔ 不拿 `generation`/行数当"文本版本"。 */
  function revisionKey(rev) {
    if (!rev) return '';
    return String(rev.docSeq) + ':' + String(rev.commitSeq);
  }

  /**
   * ⭐ 一次事务的**可回滚快照**（T0）。
   *
   * 用法：`const f = createFrame({txId, kind, revision})`，然后
   * `f.add('session', () => session.snapshot(), (v) => session.restore(v))` ……
   * 发布段抛错时 `f.restore({txId, revision})`。
   *
   * ⚠️ `save()` 在 `add()` 那一刻就执行（T0 语义）；⛔ 不是"等要回滚了再取"——
   *    那时真值已经被改过了。
   *
   * @param {{txId?:string|number, kind?:string, revision?:object|null}} [o]
   */
  function createFrame(o) {
    const opts = o || {};
    /** @type {{name:string, value:any, restore:function(any):void}[]} */
    const parts = [];
    let restored = false;
    let restoreResult = null;

    const frame = {
      txId: opts.txId,
      kind: opts.kind || 'edit',
      revision: opts.revision || null,

      /**
       * @param {string} name 给诊断看
       * @param {function():any} save 立即执行
       * @param {function(any):void} restore
       */
      add: function (name, save, restore) {
        parts.push({ name: String(name), value: save(), restore: restore });
        return frame;
      },

      get restored() {
        return restored;
      },

      /**
       * ⭐⭐ **成对回滚**（T4 的失败分支）。
       *
       * 三条纪律（`design/0058` §2.2）：
       * ① **所有权**：`claim.txId` 与本次不符 ⇒ 什么都不做（`{ok:false, why:'not-owner'}`）。
       *    ⚠️ 这正是"旧事务的 catch/finally 不许碰新会话"那条。
       * ② **修订**：`claim.revision` 与 T0 的修订不符 ⇒ 期间已有更新的提交/换文档，
       *    ⛔ 不许把新状态退回去（`{ok:false, why:'newer'}`）。
       * ③ **幂等**：第二次调用直接返回第一次的结论（`already:true`），⛔ 不再动任何状态。
       *
       * 每一部分**独立** try：一项退不干净⛔ 不许拦住其余的（否则"全文退了、区间没退"
       * 会变成"全文也没退"，屏幕与真值一起分叉）。
       *
       * @param {{txId?:string|number, revision?:object|null}} [claim]
       * @returns {{ok:boolean, already:boolean, failed:string[], why:string}}
       */
      restore: function (claim) {
        if (restored) {
          return {
            ok: restoreResult ? restoreResult.ok : true,
            already: true,
            failed: restoreResult ? restoreResult.failed : [],
            why: restoreResult ? restoreResult.why : '',
          };
        }
        const c = claim || {};
        if (c.txId !== undefined && c.txId !== null && c.txId !== frame.txId) {
          return { ok: false, already: false, failed: [], why: 'not-owner' };
        }
        if (c.revision && frame.revision && revisionKey(c.revision) !== revisionKey(frame.revision)) {
          return { ok: false, already: false, failed: [], why: 'newer' };
        }
        restored = true;
        /** @type {string[]} */
        const failed = [];
        for (let i = parts.length - 1; i >= 0; i--) {
          try {
            parts[i].restore(parts[i].value);
          } catch (e) {
            void e;
            failed.push(parts[i].name);
          }
        }
        restoreResult = {
          ok: failed.length === 0,
          already: false,
          failed: failed,
          why: failed.join(','),
        };
        return restoreResult;
      },
    };
    return frame;
  }

  // ── 选区载荷（`design/0058` §2.5）────────────────────────────────────

  /**
   * @param {{anchor?:number, head?:number, space?:'doc'|'cell'|'block',
   *          revision?:object|null, objectId?:string|null}} [o]
   */
  function selection(o) {
    const s = o || {};
    return {
      // ⚠️ `anchor`/`head` 分开存：⛔ 只存 `from`/`to` 会丢方向（反向选区的 `head` 是左端）。
      anchor: toInt(s.anchor),
      head: toInt(s.head),
      // ⚠️ 三种空间**不能互算**：`doc` = LF 规范化全文；`cell` = 该格编辑文本；
      //    `block` = 该块的编辑文本。后两者前面还有别的行、格内还有编解码
      //    （`<br>` / `\|` / 补齐空格会改长度）⇒ ⛔ 裸加源码偏移。
      space: s.space === 'cell' ? 'cell' : s.space === 'block' ? 'block' : 'doc',
      revision: s.revision || null,
      objectId: s.objectId === undefined ? null : s.objectId,
    };
  }

  function toInt(n) {
    return typeof n === 'number' && isFinite(n) ? Math.trunc(n) : 0;
  }

  /** 选区的左端 / 右端（与方向无关）。 */
  function bounds(sel) {
    const a = sel ? toInt(sel.anchor) : 0;
    const h = sel ? toInt(sel.head) : 0;
    return { from: Math.min(a, h), to: Math.max(a, h) };
  }

  /**
   * 把两个端点夹进 `[0, limit]`，**保留方向**。
   * ⚠️ 夹取在这里是**要的**：位置越界来自"文本短了"，退回边界是唯一确定的合法答案；
   *    ⛔ 但在格内↔文档之间**不许**用来"凑数"（那是 §2.5 明令禁止的裸加）。
   */
  function clampSelection(sel, limit) {
    if (!sel) return null;
    const max = Math.max(0, toInt(limit));
    return selection({
      anchor: Math.min(max, Math.max(0, toInt(sel.anchor))),
      head: Math.min(max, Math.max(0, toInt(sel.head))),
      space: sel.space,
      revision: sel.revision || null,
      objectId: sel.objectId === undefined ? null : sel.objectId,
    });
  }

  function sameSelection(a, b) {
    if (!a || !b) return a === b;
    return a.anchor === b.anchor && a.head === b.head && a.space === b.space;
  }

  /**
   * ⭐ **选区穿过一次替换**（`[from, to)` 换成 `nextLen` 长的新文本）。
   *
   * 吸附策略**确定且写明**（`design/0058` §2.5）：落在被替换区间**内部**的端点吸附到
   * 新文本的**右端**（`from + nextLen`）——与 CM6/浏览器"替换选区后光标在插入内容之后"
   * 一致；区间**右侧**的端点按长度差平移；区间**左侧**的不动。
   *
   * @param {object|null} sel
   * @param {{from:number, to:number}} range
   * @param {number} nextLen 替换后那一段的新长度（**字符数**，与 `space` 同单位）
   * @returns {object|null}
   */
  function mapThrough(sel, range, nextLen) {
    if (!sel) return null;
    const from = toInt(range && range.from);
    const to = toInt(range && range.to);
    const len = Math.max(0, toInt(nextLen));
    const delta = len - (to - from);
    const end = from + len;
    function one(p) {
      const n = toInt(p);
      if (n < from) return n;
      if (n <= to) return end;
      return n + delta;
    }
    return selection({
      anchor: one(sel.anchor),
      head: one(sel.head),
      space: sel.space,
      revision: sel.revision || null,
      objectId: sel.objectId,
    });
  }

  const api = {
    STATUS: STATUS,
    result: result,
    revisionKey: revisionKey,
    createFrame: createFrame,
    selection: selection,
    bounds: bounds,
    clampSelection: clampSelection,
    sameSelection: sameSelection,
    mapThrough: mapThrough,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveTxn = api;
})();
