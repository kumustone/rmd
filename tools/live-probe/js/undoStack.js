'use strict';

// ⭐ `design/0047` §2.6 的**候选实现**：两层撤销。
//
// ⚠️ 这是**用户能感知的行为变化**，不是实现细节（第一轮评审 P1 之一）：
//
// | 层 | 内容 | 何时结束 |
// |---|---|---|
// | CM6 `history()` | 单块视图里的**逐键**历史 | **随视图销毁结束**（提交后视图就没了） |
// | `commitStack` | 每次提交一个条目（块粒度） | 有上限的栈，跨视图存活 |
//
// ⛔ **不跨层自动衔接**：CM6 的键级历史与提交栈**不是**一个连续的时间线。

const { applyEdit } = require('./lineModel');

/**
 * @param {number} limit 上限（超出后丢最旧的一条）
 */
function createCommitStack(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须是正整数');
  let entries = [];
  const listeners = [];

  function emit() {
    for (const fn of listeners) fn(entries.length);
  }

  return {
    /**
     * @param {{from:number,to:number,before:string[],after:string[],docSeq:number}} e
     *   ⚠️ `from/to` 是 **提交之后**那份文本里的 0-based 半开区间，而**不是**旧区间。
     *   因为行数会变（插一行、删一行、两段合并），旧区间在新文本里没有意义。
     *   ⇒ 不变式：`after.length === to - from`，撤销就是把这个区间换回 `before`。
     *   ⚠️ 这也正是"必须**逆序**逐条弹"的原因：每条的位置只对**它自己那一刻**的文本成立。
     */
    push(e) {
      // 不变式：`after` 的长度**就是**被替换区间的长度（半开）⇒ 撤销时不必猜。
      if (e.after.length !== e.to - e.from) {
        throw new Error(
          `条目自相矛盾：[${e.from},${e.to}) 长 ${e.to - e.from}，after 长 ${e.after.length}`
        );
      }
      entries.push(e);
      if (entries.length > limit) entries.shift();
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
     * 弹出栈顶并给出**要应用到当前文本上的**编辑。
     * @returns {{range:{from:number,to:number}, next:string[]}|null}
     *
     * ⚠️ `to` 用**栈顶条目自己记的 `after.length`** 算，⛔ 不用当前文本猜——
     * 因为在它之后可能还有别的提交（那种情况必须**先倒序全弹**，见 `revertTo`）。
     */
    popEdit() {
      const e = entries.pop();
      emit();
      if (!e) return null;
      return { range: { from: e.from, to: e.from + e.after.length }, next: e.before };
    },

    /** 清空（换文档 / 重载时）。 */
    clear() {
      entries = [];
      emit();
    },

    /** 供测试与状态条：只读快照。 */
    snapshot() {
      return entries.map((e) => ({ from: e.from, to: e.to, before: e.before.slice(), after: e.after.slice() }));
    },

    onChange(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
}

/**
 * ⭐ **两层怎么选**——这条策略就是那个"可感知的行为变化"，必须写在一处、且可测。
 *
 * 规则（`design/0047` §2.6）：
 * 1. 焦点在块视图里 且 CM6 自己还有历史 ⇒ **交给 CM6**（键级撤销）；
 * 2. 否则若提交栈非空 ⇒ **弹一条提交**（块级撤销）；
 * 3. 都没有 ⇒ `none`。
 * ⛔ **绝不在一次 ⌘Z 里跨层**：那会让"撤销一次"有时退一个字符、有时退一整段。
 */
function resolveUndo({ inBlockView, cm6HasHistory, commitStackSize }) {
  if (inBlockView && cm6HasHistory) return 'cm6';
  if (commitStackSize > 0) return 'commit';
  return 'none';
}

/**
 * 把提交栈倒到 `targetSize`（含）。
 *
 * ⚠️ 一次 ⌘Z **只弹一条**；这个函数是给"连按 N 次"或"退出编辑态回滚"用的，
 * 它按**逆序**逐条应用，⛔ 不允许一次性把所有条目拼成一个大编辑（那样会跨文档漂移）。
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

module.exports = { createCommitStack, resolveUndo, revertTo };
