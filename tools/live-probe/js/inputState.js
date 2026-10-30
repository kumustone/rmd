'use strict';

// ⭐ `design/0047` §2.7（R1 输入子系统）的**候选实现**：事件 → 事务，⛔ 不碰 DOM。
//
// 形态（§2.7）：`contentDOM` 永不被聚焦（`contenteditable=false` ＋ `tabindex=-1`），
// 输入事件来自一个**离屏 `textarea`**；本文件只负责**判断"这串事件该产出几条事务、
// 每条事务改哪里"**。DOM 与 WKWebView 的真实事件顺序由离屏探针覆盖（`--fixtures` 答不了）。
//
// ⚠️ 三条硬规则（每条都对应一个**用户能看见**的坏形态）：
//
// 1. **组合期间文档一个字节都不动**（P1 强需求：`notes/0038` §7.2 的"组合期间累计位移 0"）。
//    ⇒ `compositionupdate` 只更新**临时态**（交给装饰层画），⛔ 不产出事务。
// 2. **组合结束只落一条事务**，⛔ 不是"逐键落"。
// 3. **组合结束后的那个重复 `input` 必须被吃掉**（WebKit 会补发一次 `input`，
//    `isComposing=false`、`data` 与组合结果相同）⇒ 不然会**插两遍**。
//
// ⚠️ 粘贴另有一条硬规则：**`\r` 永远不许进 `fullText`**（全文模型恒 LF）。

/**
 * ⭐ **`\r` 永远不许进 `fullText`**（全文模型恒 LF，§2.1）。
 * ⚠️ 粘贴是它唯一的现实入口：从别的编辑器/终端复制一段 CRLF 文本，
 * 不规范化就会在行里留下一个 `\r`——它不换行、不可见，但**会让行号与预期错位**，
 * 而且 `Envelope::detect` 下次算出来是 `Eol::Other` ⇒ 整篇变不可编辑。
 */
function linesOf(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
}

/**
 * 组合态判定：WebKit / Chrome 都认 `isComposing`，但**自己也要有标志位**——
 * `compositionstart` 之后到 `compositionend` 之间的 `input` 一律算组合态，
 * ⛔ 不依赖 `ev.isComposing`（Safari 某些版本在 `input` 上不给这个字段）。
 */
function isComposingEvent(ev, state) {
  return state.composing || ev.isComposing === true;
}

/**
 * @param {(tx:{from:number,to:number,next:string[],reason:string}) => void} onTransaction
 *   0-based 半开区间，与 `lineModel.toRange` 同一套口径。
 */
function createInputMachine(onTransaction) {
  /** @type {{composing:boolean, start:number, end:number, provisional:string, swallowInput:boolean}} */
  const state = { composing: false, start: 0, end: 0, provisional: '', swallowInput: false };

  function tx(from, to, next, reason) {
    onTransaction({ from, to, next, reason });
  }

  return {
    /** 只读快照（测试与状态条用）。 */
    get state() {
      return { ...state };
    },

    /**
     * 处理一个**已经归一化过**的事件对象：
     * `{type, data?, isComposing?, from?, to?, text?}`
     *
     * ⚠️ 归一化（`compositionend` 的 `data`、`input` 的 `data`、`paste` 的
     *    `clipboardData.getData('text/plain')`）由接线层做，⛔ 不在状态机里摸 DOM。
     */
    handle(ev) {
      switch (ev.type) {
        case 'compositionstart': {
          state.composing = true;
          state.start = ev.from;
          state.end = ev.to;
          state.provisional = '';
          state.swallowInput = false;
          return { applied: false, why: '组合开始：不动文档' };
        }

        case 'compositionupdate': {
          if (!state.composing) return { applied: false, why: '不在组合态，忽略' };
          state.provisional = ev.data || '';
          // ⭐ 只更新临时态 ⇒ 文档长度不变 ⇒ 版面不动（P1 强需求）
          return { applied: false, why: '组合中：只更新临时态' };
        }

        case 'compositionend': {
          if (!state.composing) return { applied: false, why: '不在组合态，忽略' };
          const text = ev.data || '';
          state.composing = false;
          // ⭐ 只落**一条**事务；组合期间攒下的字一次性进去
          if (text.length > 0) {
            tx(state.start, state.end, linesOf(text), 'composition');
            state.swallowInput = true; // 吃掉紧随其后的那次重复 input
            return { applied: true, why: '组合结束：落一条事务' };
          }
          state.swallowInput = false;
          return { applied: false, why: '组合被取消（空结果）' };
        }

        case 'input': {
          // ⭐ 顺序很重要：先判"这是不是组合产生的 input"
          if (isComposingEvent(ev, state)) {
            return { applied: false, why: '组合中的 input：交给 compositionend' };
          }
          if (state.swallowInput) {
            state.swallowInput = false;
            return { applied: false, why: '组合结束后的重复 input：吃掉' };
          }
          const text = ev.data || '';
          if (text.length === 0) return { applied: false, why: '空 input' };
          tx(ev.from, ev.to, linesOf(text), 'input');
          return { applied: true, why: '普通输入' };
        }

        case 'paste': {
          // ⭐ 硬规则：`\r` 不许进 `fullText` ⇒ 粘贴时**当场**规范化（见 `linesOf`）
          const text = String(ev.text == null ? '' : ev.text).replace(/\r\n?/g, '\n');
          if (text.length === 0) return { applied: false, why: '空粘贴' };
          if (state.composing) {
            // 组合中粘贴：⛔ 不动文档，交给组合结束后那一条
            state.provisional += text;
            return { applied: false, why: '组合中粘贴：并进临时态' };
          }
          tx(ev.from, ev.to, text.split('\n'), 'paste');
          return { applied: true, why: '粘贴（已把 CRLF/CR 归一成 LF）' };
        }

        case 'cancel': {
          // Escape / 失焦：组合作废，⛔ 不落事务
          const was = state.composing;
          state.composing = false;
          state.provisional = '';
          state.swallowInput = false;
          return { applied: false, why: was ? '组合被取消' : '不在组合态' };
        }

        default:
          return { applied: false, why: `未处理的事件 ${ev.type}` };
      }
    },
  };
}

/**
 * 选区映射：组合结束后的光标位置。
 * ⚠️ 口径是 **UTF-16**（与 `offset.rs` 的换算、以及 JS 字符串长度一致）。
 * ⛔ 不是字节、⛔ 不是字素簇（组合字符仍按码元算，这一条**本项目自定**）。
 */
function caretAfterComposition(startOffset, committedText) {
  return startOffset + committedText.length;
}

module.exports = { createInputMachine, caretAfterComposition };
