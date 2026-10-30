// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// 唯一全文模型：`fullText` ＋ 行索引 ＋ 提交 ＋ 两层撤销的下层 —— `design/0047` §2.1 / §2.4 / §2.6。
//
// 这里回答四个问题，四个都**不碰 DOM、不碰 Tauri、不碰定时器**：
//   ① `fullText` 与行数组怎么互转（`'a\n'` 是**两行**，末尾那个空串是真实的一行）；
//   ② 一次提交怎么落到行数组上（按**行区间** splice，⛔ 不用字节偏移）；
//   ③ 一条回包**还能不能**用（身份四件套 ＋ `commitSeq`，`INV-LIVE-20`）；
//   ④ `⌘Z` 这次该交给谁（CM6 键级 / 提交栈 / 都不）。
//
// ## 三条口径（⛔ 改之前先读）
//
// 1. **索引空间 = 行号 ＋ 行内 UTF-16**（`INV-LIVE-13`）。⛔ UTF-8 字节偏移不进入前端：
//    Rust 侧 `offset.rs` 那一套是给搜索用的，两套口径混用必然漂移（§1.4）。
// 2. **`fullText` 恒 LF、无 BOM**——那是 `EditGrant.text` 的保证（`INV-EDIT-12`），
//    ⛔ 本文件**不做**行尾规范化、⛔ 不 `trim`：`\r` 一旦进来就已经是 bug，不是这里能修的。
// 3. **区间越界抛错，⛔ 不夹取**——夹取会把"用陈旧行号提交"这个错误**静默**变成"改对了附近"，
//    而那种错在屏幕上看起来完全正常。
//
// ⚠️ 语义与 `tools/live-probe/js/{lineModel,undoStack}.js` **逐条一致**（那两份是步骤 0 的
// 可运行证据，`design/0047` §7.1）。⛔ 别在这里改语义而不改那边——两份分叉等于没有证据。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，
// 顶层 `const` 撞名会让**整个文件不执行**（窗口空白、stderr 全静默）。
// 理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  /**
   * ⭐ **文档级提交栈的上限**（`design/0047` §2.6：超限丢最旧）。
   * ⚠️ 它是"块级撤销能退几步"的唯一来源，⛔ 别在别处再写一个数。
   */
  const COMMIT_STACK_LIMIT = 100;

  // ── 行模型 ───────────────────────────────────────────────────────────

  /**
   * `fullText` → 行数组。
   *
   * ⚠️ `'a\n'` 得到 `['a', '']`——**末尾那个空串是真实的一行**，就是"光标能停在
   * 最后一行之后"的那一行。⛔ 别 `filter(Boolean)`，那会让行数比 `LineIndex` 少一。
   */
  function splitLines(text) {
    return String(text === undefined || text === null ? '' : text).split('\n');
  }

  /** 行数组 → `fullText`（`splitLines` 的逆，逐字节可逆）。 */
  function joinLines(lines) {
    return (lines || []).join('\n');
  }

  /** 行数组 → 行数（`splitLines` 之后恒 ≥ 1）。 */
  function lineCountOf(lines) {
    return (lines || []).length;
  }

  /**
   * 把 `lines[from, to)` 换成 `next`（**返回新数组**，⛔ 不改入参）。
   *
   * ⚠️ 区间来自 `live/blocks.js`（那里是全项目唯一一次 1-based→0-based 换算，
   * `INV-LIVE-05`）⇒ 本文件**不认识** 1-based 行号，⛔ 别在这里再换一次。
   */
  function applyEdit(lines, range, next) {
    const cur = lines || [];
    const from = range ? range.from : NaN;
    const to = range ? range.to : NaN;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > cur.length) {
      throw new Error(`区间越界 [${from},${to}) 于 ${cur.length} 行`);
    }
    const mid = next || [];
    return cur.slice(0, from).concat(mid, cur.slice(to));
  }

  // ── 身份闸（`INV-LIVE-20`）────────────────────────────────────────────

  /**
   * 一份身份快照。⚠️ 它是**后端给的那三个** ＋ 前端记的 `commitSeq`。
   *
   * @param {{realPath:string, generation:number, docSeq:number, lineCount:number,
   *          commitSeq?:number}} o
   */
  function identity(o) {
    return {
      realPath: String(o.realPath || ''),
      generation: o.generation,
      docSeq: o.docSeq,
      lineCount: o.lineCount,
      commitSeq: Number.isInteger(o.commitSeq) ? o.commitSeq : 0,
    };
  }

  /**
   * 一条回包能不能被接受。
   *
   * ⚠️ **四条判据的顺序无关，但一条都不能少**：
   * - `doc_seq`：换文档了（最粗的那一层）；
   * - `real_path`：同一 `doc_seq` 下换成了另一个文件（软链/重开）；
   * - `generation`：授权代次变了（换根目录）；
   * - `line_count`：⭐ **行号已经陈旧**——一次改行数的提交之后，旧块表的行号会
   *   **静默指向别的行**。这是唯一一条"看起来一切正常"的错法。
   *
   * ⛔ **不看"看起来是不是同一份"**（内容相似度、字节数接近都不算判据）。
   */
  function acceptReply(state, reply) {
    if (!state) return { ok: false, why: '没有身份快照' };
    const r = reply || {};
    if (r.doc_seq !== state.docSeq) return { ok: false, why: 'doc_seq 不符（换文档了）' };
    if (r.real_path !== undefined && r.real_path !== state.realPath) {
      return { ok: false, why: 'real_path 不符（不是同一份文件）' };
    }
    if (r.generation !== undefined && r.generation !== state.generation) {
      return { ok: false, why: 'generation 不符（授权代次变了）' };
    }
    if (r.line_count !== state.lineCount) {
      return {
        ok: false,
        why: `line_count 不符（${r.line_count} ≠ ${state.lineCount}，行号已陈旧）`,
      };
    }
    if (Number.isInteger(r.commit_seq) && r.commit_seq < state.commitSeq) {
      return { ok: false, why: `commit_seq 倒退（${r.commit_seq} < ${state.commitSeq}）` };
    }
    return { ok: true, why: '' };
  }

  /** 身份推进（⛔ 只在这里推进，别在别处各写一份）。 */
  function advanceIdentity(state, lineCount) {
    return identity({
      realPath: state.realPath,
      generation: state.generation,
      docSeq: state.docSeq,
      lineCount: lineCount,
      commitSeq: state.commitSeq + 1,
    });
  }

  // ── 提交栈（文档级那一层，§2.6）──────────────────────────────────────

  /**
   * ⭐ 每次**提交**一个条目（不是每次按键）。跨块视图存活，上限 [`COMMIT_STACK_LIMIT`]。
   *
   * @param {number} [limit] 上限（`design/0047` §2.6 写死 100，⛔ 别在调用点另传）
   */
  function createCommitStack(limit) {
    const cap = Number.isInteger(limit) && limit > 0 ? limit : COMMIT_STACK_LIMIT;
    let entries = [];
    const listeners = [];

    function emit() {
      for (let i = 0; i < listeners.length; i++) listeners[i](entries.length);
    }

    return {
      /**
       * @param {{from:number,to:number,before:string[],after:string[]}} e
       *   ⚠️ `from/to` 是**提交之后**那份文本里的 0-based 半开区间，**不是旧区间**——
       *   行数会变（插一行、删一行、两段合并），旧区间在新文本里没有意义。
       *   ⇒ 不变式 `after.length === to - from`，撤销就是把这个区间换回 `before`。
       *   ⚠️ 这也正是"必须**逆序**逐条弹"的原因：每条的位置只对**它自己那一刻**的文本成立。
       */
      push(e) {
        if (e.after.length !== e.to - e.from) {
          throw new Error(
            `条目自相矛盾：[${e.from},${e.to}) 长 ${e.to - e.from}，after 长 ${e.after.length}`
          );
        }
        entries.push(e);
        if (entries.length > cap) entries.shift();
        emit();
        return entries.length;
      },

      size() {
        return entries.length;
      },

      peek() {
        return entries.length ? entries[entries.length - 1] : null;
      },

      /**
       * 弹出栈顶，给出**要应用到当前文本上的**编辑。
       * ⚠️ `to` 用**条目自己记的 `after.length`**，⛔ 不用当前文本猜——
       * 在它之后可能还有别的提交（那种情况必须**先倒序全弹**，见 [`revertTo`]）。
       */
      popEdit() {
        const e = entries.pop();
        emit();
        if (!e) return null;
        return { range: { from: e.from, to: e.from + e.after.length }, next: e.before };
      },

      /** 清空（换文档 / 外部重载时，§2.5 的表）。 */
      clear() {
        entries = [];
        emit();
      },

      /** 只读快照（状态条与测试用）。 */
      snapshot() {
        return entries.map(function (e) {
          return {
            from: e.from,
            to: e.to,
            before: e.before.slice(),
            after: e.after.slice(),
          };
        });
      },

      onChange(fn) {
        listeners.push(fn);
        return function () {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    };
  }

  /**
   * ⭐ **两层撤销怎么选**——这条策略就是那个"用户能感知的行为变化"，写在一处、且可测。
   *
   * 1. 焦点在块视图里 且 CM6 自己还有历史 ⇒ `'cm6'`（键级撤销）；
   * 2. 否则提交栈非空 ⇒ `'commit'`（块级撤销）；
   * 3. 都没有 ⇒ `'none'`。
   *
   * ⛔ **绝不在一次 ⌘Z 里跨层**：那会让"撤销一次"有时退一个字符、有时退一整段
   * （`design/0047` §2.6，2026-10-26 定案 = 接受现状 ＋ 状态条一行提示）。
   */
  function resolveUndo(o) {
    const s = o || {};
    if (s.inBlockView && s.cm6HasHistory) return 'cm6';
    if (s.commitStackSize > 0) return 'commit';
    return 'none';
  }

  /**
   * 把提交栈倒到 `targetSize`（含）。
   *
   * ⚠️ 一次 `⌘Z` **只弹一条**；这个函数是给"连按 N 次"或"退出编辑态回滚"用的。
   * 它按**逆序**逐条应用，⛔ 不允许把所有条目拼成一个大编辑（那样会跨文档漂移）。
   */
  function revertTo(lines, stack, targetSize) {
    let cur = lines;
    while (stack.size() > targetSize) {
      const edit = stack.popEdit();
      if (!edit) break;
      cur = applyEdit(cur, edit.range, edit.next);
    }
    return cur;
  }

  // ── 会话（行数组 ＋ 身份 ＋ 提交栈）──────────────────────────────────

  /**
   * 一次编辑会话的内存态。
   *
   * ⚠️ **全键可缺省**：`const src = o || {}` 里那个 `{}` 必须能赋给这个类型，
   *   否则 `checkJs` 会把每一次 `src.text` 都报成「属性不存在」（`design/0052` U8 踩过）。
   *
   * @param {{text?:string, realPath?:string, generation?:number, docSeq?:number,
   *          limit?:number}} [o]
   *   `text` 必须来自 `begin_edit` 的 `EditGrant.text`（恒 LF、无 BOM）。
   */
  function createSession(o) {
    const src = o || {};
    let lines = splitLines(src.text);
    let ident = identity({
      realPath: src.realPath,
      generation: src.generation,
      docSeq: src.docSeq,
      lineCount: lines.length,
      commitSeq: 0,
    });
    const stack = createCommitStack(src.limit);

    return {
      /** 当前全文（恒 LF）。 */
      lines() {
        return lines;
      },
      fullText() {
        return joinLines(lines);
      },
      lineCount() {
        return lines.length;
      },
      identity() {
        return ident;
      },
      stack() {
        return stack;
      },

      /**
       * ⭐ **提交**：把 `range` 那段换成 `nextLines`，压一条撤销条目，推进身份。
       *
       * ⚠️ **提交 ≠ 保存**（§2.5）：这里只改内存，⛔ 一个字节都不写盘。
       * @returns {{entry:object, lines:string[], fullText:string, lineCount:number, identity:object}}
       */
      commit(range, nextLines) {
        const before = lines.slice(range.from, range.to);
        const next = nextLines || [];
        lines = applyEdit(lines, range, next);
        const entry = {
          // ⚠️ 存的是**提交之后**的区间（见 `push` 的注释）。
          from: range.from,
          to: range.from + next.length,
          before: before,
          after: next.slice(),
        };
        stack.push(entry);
        ident = advanceIdentity(ident, lines.length);
        return {
          entry: entry,
          lines: lines,
          fullText: joinLines(lines),
          lineCount: lines.length,
          identity: ident,
        };
      },

      /**
       * 撤一条提交（`Viewing` 态的 `⌘Z`）。
       * @returns {{lines:string[], fullText:string, lineCount:number, identity:object}|null}
       */
      undo() {
        const edit = stack.popEdit();
        if (!edit) return null;
        lines = applyEdit(lines, edit.range, edit.next);
        // ⚠️ 撤销**也是一次文本变化** ⇒ `commitSeq` 要往前走：
        //    在途的预览回包说的是撤销之前那份文本，⛔ 不能被当成当前结果。
        ident = advanceIdentity(ident, lines.length);
        return {
          lines: lines,
          fullText: joinLines(lines),
          lineCount: lines.length,
          identity: ident,
        };
      },

      /** 外部重载 / 换文档：文本与身份换新、栈清空（§2.5 的表）。 */
      rebind(o2) {
        const s = o2 || {};
        if (typeof s.text === 'string') lines = splitLines(s.text);
        ident = identity({
          realPath: s.realPath === undefined ? ident.realPath : s.realPath,
          generation: s.generation === undefined ? ident.generation : s.generation,
          docSeq: s.docSeq === undefined ? ident.docSeq : s.docSeq,
          lineCount: lines.length,
          commitSeq: 0,
        });
        stack.clear();
        return ident;
      },
    };
  }

  const api = {
    COMMIT_STACK_LIMIT: COMMIT_STACK_LIMIT,
    splitLines: splitLines,
    joinLines: joinLines,
    lineCountOf: lineCountOf,
    applyEdit: applyEdit,
    identity: identity,
    acceptReply: acceptReply,
    advanceIdentity: advanceIdentity,
    createCommitStack: createCommitStack,
    resolveUndo: resolveUndo,
    revertTo: revertTo,
    createSession: createSession,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveModel = api;
})();
