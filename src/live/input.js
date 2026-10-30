// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// R1 输入子系统：**事件 → 事务**的状态机 —— `design/0047` §2.7 / `INV-LIVE-12` / `INV-LIVE-17`。
//
// 形态（§2.7）：`contentDOM` 永不被聚焦（`contenteditable=false` ＋ `tabindex=-1`），
// 输入事件来自一个**离屏 `textarea`**。本文件只回答"这串事件该产出几条事务、
// 每条事务改哪一段"，⛔ 不碰 DOM、⛔ 不调 CM6、⛔ 不碰剪贴板 API（那是接线层的事）。
//
// ## 四条硬规则（每条都对应一个**用户能看见**的坏形态）
//
// 1. ⭐ **组合期间文档一个字节都不动**（用户 2026-10-26 的强需求 `F6`）：
//    `compositionupdate` 只更新**临时态**（交给装饰层画 preedit），⛔ 不产出事务。
//    ⇒ 一旦组合串进了文档，浏览器就会自己排版，每一帧都位移
//    （步骤 0 实测：一个拼音串 5 个中间态 = 17 次 DOM 变更）。
// 2. **组合结束只落一条事务**，⛔ 不是"逐键落"。
// 3. ⭐ **组合结束后的那一发重复 insert 必须被吃掉**（WebKit 会在 `compositionend`
//    之后补发一次 `beforeinput`/`input`，`isComposing` 为假、`data` 与组合结果相同）
//    ⇒ 不然同一个词会被**插两遍**。
//    ⚠️ 判据是 **"类型是 insert ∧ data 与刚提交的文本逐字相同"**，⛔ 不是一个无条件的
//    "吞下一发"开关——后者在浏览器**没有**补发时会把用户真正敲的那个字符吃掉。
// 4. ⭐ **`\r` 永远不许进 `fullText`**（全文模型恒 LF，`INV-LIVE-13`）。
//    唯一现实入口是粘贴：从终端/别的编辑器复制一段 CRLF 文本。不规范化的话
//    它留在行里——不换行、不可见，却**让行号与预期错位**，而且下次 `Envelope::detect`
//    会算出 `Eol::Other` ⇒ **整篇变不可编辑**（`blocks.rs::to_wire` 那道闸）。
//
// ⚠️ 语义与 `tools/live-probe/js/inputState.js` 一致（那是步骤 0 的可运行证据）；
// 本文件多两件事：`beforeinput` 的 `inputType` 分派、以及上面第 3 条**改成按内容判**。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，
// 顶层 `const` 撞名会让**整个文件不执行**（窗口空白、stderr 全静默）。
// 理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  /**
   * ⭐ **`\r` 永远不许进 `fullText`**：CRLF / 裸 CR 一律归一成 LF。
   * ⚠️ 只做这一件事，⛔ 不做别的规范化（不 `trim`、不折叠空白）——
   * 多余的处理会让"提交上去的文本 ≠ 用户看到的东西"。
   */
  function normalizeNewlines(text) {
    return String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
  }

  /** 一段输入文本 → 行数组（已归一化行尾）。 */
  function linesOf(text) {
    return normalizeNewlines(text).split('\n');
  }

  /**
   * 事件是不是**组合态**的。
   *
   * ⚠️ 自己的标志位优先：`compositionstart` 之后、`compositionend` 之前的任何事件都算组合态，
   * ⛔ 不依赖 `ev.isComposing`（Safari 某些版本在 `input` 上不给这个字段）。
   */
  function isComposingEvent(ev, state) {
    return state.composing || ev.isComposing === true;
  }

  /** 这个 `inputType` 是"插入"类。 */
  function isInsertType(t) {
    return typeof t === 'string' && t.slice(0, 6) === 'insert';
  }

  /** 这个 `inputType` 是"删除"类。 */
  function isDeleteType(t) {
    return typeof t === 'string' && t.slice(0, 6) === 'delete';
  }

  /**
   * @param {(tx:{from:number,to:number,next:string[],reason:string}) => void} onTransaction
   *   ⚠️ `from`/`to` 是 **0-based 半开区间**，与 `live/blocks.js` 的 `from`/`to` 同一口径。
   * @param {{text?:function(string):string}} [policy] 编辑对象给的**输入约束**
   *   （`design/0054` `INV-EDITOBJ-01`，策略表在 `live/objects.js`）。
   *   ⚠️ 它作用于**每一个文本入口**（`beforeinput` 插入 / `input` / `paste` /
   *   `compositionend`）——⛔ 不是只在粘贴上折一次：只折一个入口的形态是
   *   "改粘贴管住了、IME 上屏那条路照样把换行塞进去"。缺省 = 不约束。
   */
  function createInputMachine(onTransaction, policy) {
    /**
     * ⭐ **唯一的入口约束点**：先归一化行尾（`INV-LIVE-13`），再按对象策略处理。
     * ⚠️ 顺序不能反——见 `live/objects.js::foldNewlines` 的注释（CRLF 会剩下裸 `\r`）。
     * @param {string|undefined|null} raw
     * @returns {string}
     */
    function textIn(raw) {
      const norm = normalizeNewlines(raw);
      const rule = policy && typeof policy.text === 'function' ? policy.text : null;
      return rule ? String(rule(norm)) : norm;
    }

    const state = {
      composing: false,
      start: 0,
      end: 0,
      provisional: '',
      /** 刚由 `compositionend` 提交的文本（`null` = 没有待吞的那一发）。 */
      swallow: null,
      /**
       * ⭐ 组合期间粘贴进来的文本，**等组合结束再补一条**。
       *
       * ⚠️ 为什么不并进 `provisional`：`provisional` 是 preedit 的镜像，
       * 而 `compositionend` 提交的是**它自己的 `data`**——并进去就等于**静默丢掉**用户粘贴的内容。
       * ⛔ 那正是本项目最不能接受的一类错（吞内容）。
       * ⇒ 顺序写死：**先上屏组合结果，再插粘贴内容**，两条事务（两个不同的用户动作）。
       */
      pending: [],
    };

    function tx(from, to, next, reason) {
      onTransaction({ from: from, to: to, next: next, reason: reason });
    }

    /**
     * 这是不是"组合结束后的那一发重复 insert"。
     * ⚠️ 只有**内容逐字相同**才吞，且吞完就清掉——⛔ 不吞第二发。
     */
    function trySwallow(ev, text) {
      if (state.swallow === null) return false;
      if (text !== state.swallow) {
        // 内容不同 ⇒ 那是用户真的敲了别的字，⛔ 不许吞；同时这一发也不是重复发。
        state.swallow = null;
        return false;
      }
      state.swallow = null;
      return true;
    }

    return {
      /** 只读快照（测试与状态条用）。 */
      get state() {
        return {
          composing: state.composing,
          start: state.start,
          end: state.end,
          provisional: state.provisional,
          swallow: state.swallow,
          pending: state.pending.slice(),
        };
      },

      /**
       * 处理一个**已经归一化过**的事件对象。
       *
       * 归一化（`compositionend` 的 `data`、`beforeinput` 的 `data`、
       * `paste` 的剪贴板文本）由接线层做，⛔ 不在状态机里摸 DOM。
       * @returns {{applied:boolean, why:string}}
       */
      handle(ev) {
        const e = ev || {};
        switch (e.type) {
          case 'compositionstart': {
            state.composing = true;
            state.start = e.from;
            state.end = e.to;
            state.provisional = '';
            state.swallow = null;
            return { applied: false, why: '组合开始：不动文档' };
          }

          case 'compositionupdate': {
            if (!state.composing) return { applied: false, why: '不在组合态，忽略' };
            state.provisional = e.data || '';
            // ⭐ 只更新临时态 ⇒ 文档长度不变 ⇒ 版面不动（F6 强需求）
            return { applied: false, why: '组合中：只更新临时态' };
          }

          case 'compositionend': {
            if (!state.composing) return { applied: false, why: '不在组合态，忽略' };
            // ⚠️ 组合结果同样过对象约束：IME 也能把换行带回来（删词/换行候选），
            //    ⛔ "只折粘贴"的形态在这里就是一个漏口。
            const text = textIn(e.data);
            state.composing = false;
            state.provisional = '';
            if (text.length === 0) {
              state.swallow = null;
              return { applied: false, why: '组合被取消（空结果）' };
            }
            // ⭐ 只落**一条**事务：组合期间攒下的字一次性进去
            tx(state.start, state.end, text.split('\n'), 'composition');
            state.swallow = text;
            // ⚠️ 组合期间粘贴过 ⇒ 在**组合结果之后**补一条，⛔ 不丢。
            if (state.pending.length > 0) {
              const extra = state.pending.join('');
              state.pending = [];
              const caret = state.start + text.length;
              tx(caret, caret, extra.split('\n'), 'paste-after-composition');
            }
            return { applied: true, why: '组合结束：落一条事务' };
          }

          case 'beforeinput': {
            if (isComposingEvent(e, state)) {
              return { applied: false, why: '组合中的 beforeinput：交给 compositionend' };
            }
            const type = e.inputType;

            // ⛔ 撤销/重做由我们自己分派（`model.js::resolveUndo`）：
            //    放给浏览器就是在两套历史之间来回切（`design/0047` §2.6）。
            if (type === 'historyUndo' || type === 'historyRedo') {
              return { applied: false, why: '撤销重做由我们分派，⛔ 不交给浏览器' };
            }

            if (isInsertType(type)) {
              const text = textIn(e.data);
              if (text.length === 0) return { applied: false, why: '空插入' };
              if (trySwallow(e, text)) {
                return { applied: false, why: '组合结束后的重复 beforeinput：吃掉' };
              }
              tx(e.from, e.to, text.split('\n'), 'insert');
              return { applied: true, why: '插入' };
            }

            if (isDeleteType(type)) {
              // ⚠️ 删除的**方向与粒度**（词 / 行 / 选区）由浏览器算好放在 `from`/`to` 里，
              //    ⛔ 我们不自己按 `inputType` 猜——那会与系统键位不一致。
              tx(e.from, e.to, [], 'delete');
              return { applied: true, why: '删除' };
            }

            return { applied: false, why: `未处理的 inputType ${type}` };
          }

          case 'input': {
            // ⭐ 顺序很重要：先判"这是不是组合产生的 input"
            if (isComposingEvent(e, state)) {
              return { applied: false, why: '组合中的 input：交给 compositionend' };
            }
            const text = textIn(e.data);
            if (text.length === 0) return { applied: false, why: '空 input' };
            if (trySwallow(e, text)) {
              return { applied: false, why: '组合结束后的重复 input：吃掉' };
            }
            tx(e.from, e.to, text.split('\n'), 'input');
            return { applied: true, why: '普通输入' };
          }

          case 'paste': {
            const text = textIn(e.text);
            if (text.length === 0) return { applied: false, why: '空粘贴' };
            if (state.composing) {
              // 组合中粘贴：⛔ 不动文档；记下来，等组合结束后补一条（⛔ 不并进 preedit）
              state.pending.push(text);
              return { applied: false, why: '组合中粘贴：记下来，组合结束后补一条' };
            }
            tx(e.from, e.to, text.split('\n'), 'paste');
            return { applied: true, why: '粘贴（已把 CRLF/CR 归一成 LF）' };
          }

          case 'cancel': {
            // `Esc` / 失焦：组合作废，⛔ 不落事务（与系统行为一致：未上屏的字丢掉）
            const was = state.composing;
            state.composing = false;
            state.provisional = '';
            state.swallow = null;
            // ⚠️ 但**已经粘贴进来**的文本不能丢：它是另一个用户动作，落一条独立事务。
            if (state.pending.length > 0) {
              const extra = state.pending.join('');
              state.pending = [];
              tx(state.start, state.start, extra.split('\n'), 'paste-after-composition');
              return { applied: true, why: '组合取消，但补上组合期间粘贴的内容' };
            }
            return { applied: false, why: was ? '组合被取消' : '不在组合态' };
          }

          default:
            return { applied: false, why: `未处理的事件 ${e.type}` };
        }
      },
    };
  }

  /**
   * 组合结束后的光标位置（块内 UTF-16 偏移）。
   *
   * ⚠️ 口径是 **UTF-16 码元**（与 JS 字符串长度、以及 `offset.rs` 的展示层换算一致）。
   * ⛔ 不是字节、⛔ 不是字素簇——组合字符仍按码元算，这一条**本项目自定**（§2.1）。
   */
  function caretAfterComposition(startOffset, committedText) {
    return startOffset + String(committedText || '').length;
  }

  const api = {
    normalizeNewlines: normalizeNewlines,
    linesOf: linesOf,
    isComposingEvent: isComposingEvent,
    createInputMachine: createInputMachine,
    caretAfterComposition: caretAfterComposition,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveInput = api;
})();
