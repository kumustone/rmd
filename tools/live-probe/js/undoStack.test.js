'use strict';

// ⭐ 关键契约 2「撤销被收窄是否可接受」的**可运行证据**（`docs/design/0047` §2.6）。
//
// ⚠️ 这个文件**证明不了"可以接受"**——那是产品判断，只能由人拍板。
// 它证明的是**被收窄的到底是哪几件事**，好让拍板有个准确的靶子：
//
// | 场景 | 收窄后的行为 |
// |---|---|
// | 在块里连敲 10 个字，还没提交 | ⌘Z 逐字退（CM6 自己那份历史） |
// | 提交之后 | 视图销毁 ⇒ 那 10 个字**再也退不成中间态**，⌘Z 只能整体退这一块 |
// | 提交之后又想退**上一个块** | 要⌘Z 第二次（先退本块，再退上一块） |
// | 一次 ⌘Z | ⛔ 绝不跨层（不会"退一个字"与"退一整段"混着来） |

const test = require('node:test');
const assert = require('node:assert');

const M = require('./lineModel');
const U = require('./undoStack');

/**
 * 模拟"提交一个块"：把**旧文本**的 `[startLine, endLine]` 换成 `next`，
 * 同时产出撤销条目。
 *
 * ⚠️ 条目里的 `from/to` 记的是 **提交之后**那份文本里的区间
 * （`to = from + next.length`），⛔ 不是旧区间——行数会变，旧区间在新文本里没意义。
 */
function commit(lines, startLine, endLine, next) {
  const range = M.toRange(startLine, endLine);
  const before = lines.slice(range.from, range.to);
  const out = M.applyEdit(lines, range, next);
  return {
    lines: out,
    entry: {
      from: range.from,
      to: range.from + next.length,
      before,
      after: next.slice(),
      docSeq: 1,
    },
  };
}

test('两层撤销·基本语义', async (t) => {
  await t.test('连敲的字在提交前逐字可退（CM6 那一层）', () => {
    // ⚠️ CM6 的历史**不在这里实现**——这里只是把"它存在"这件事放进判据里
    assert.strictEqual(
      U.resolveUndo({ inBlockView: true, cm6HasHistory: true, commitStackSize: 2 }),
      'cm6'
    );
  });

  await t.test('提交后视图销毁 ⇒ CM6 那份历史没了，⌘Z 落到提交栈', () => {
    assert.strictEqual(
      U.resolveUndo({ inBlockView: false, cm6HasHistory: false, commitStackSize: 1 }),
      'commit'
    );
  });

  await t.test('进了块但一个字没打 ⇒ 直接落到提交栈', () => {
    assert.strictEqual(
      U.resolveUndo({ inBlockView: true, cm6HasHistory: false, commitStackSize: 1 }),
      'commit'
    );
  });

  await t.test('都没有 ⇒ none（⛔ 不响铃、不假装撤了）', () => {
    assert.strictEqual(
      U.resolveUndo({ inBlockView: true, cm6HasHistory: false, commitStackSize: 0 }),
      'none'
    );
  });
});

test('两层撤销·块级回滚逐字复原', async (t) => {
  await t.test('两次提交后连按两次 ⌘Z ⇒ 回到原文', () => {
    const orig = M.splitLines('a\n\nb\n');
    const stack = U.createCommitStack(50);

    const c1 = commit(orig, 1, 1, ['a1']);
    stack.push(c1.entry);
    assert.strictEqual(M.joinLines(c1.lines), 'a1\n\nb\n');

    const c2 = commit(c1.lines, 3, 3, ['b1']);
    stack.push(c2.entry);
    assert.strictEqual(M.joinLines(c2.lines), 'a1\n\nb1\n');
    assert.strictEqual(stack.size(), 2);

    // 第 1 次 ⌘Z：只退最后一块
    const e1 = stack.popEdit();
    const back1 = M.applyEdit(c2.lines, e1.range, e1.next);
    assert.strictEqual(M.joinLines(back1), 'a1\n\nb\n');

    // 第 2 次 ⌘Z：再退一块
    const e2 = stack.popEdit();
    const back2 = M.applyEdit(back1, e2.range, e2.next);
    assert.strictEqual(M.joinLines(back2), 'a\n\nb\n');
    assert.strictEqual(stack.size(), 0);
  });

  await t.test('单次撤销只动一个块（⛔ 不连带别的块）', () => {
    const orig = M.splitLines('a\n\nb\n');
    const stack = U.createCommitStack(50);
    const c1 = commit(orig, 1, 1, ['a1']);
    stack.push(c1.entry);
    const c2 = commit(c1.lines, 3, 3, ['b1']);
    stack.push(c2.entry);

    const e = stack.popEdit();
    const back = M.applyEdit(c2.lines, e.range, e.next);
    // 块 0 仍是修改后的 a1，只有块 1 被退回
    assert.strictEqual(M.joinLines(back), 'a1\n\nb\n');
  });

  await t.test('行数变化的提交也能逐字退回（这是 line_count 之外的那半）', () => {
    const orig = M.splitLines('a\n\nb\n');
    const stack = U.createCommitStack(50);
    const c1 = commit(orig, 1, 1, ['a', '续行']); // 4 行 → 5 行
    stack.push(c1.entry);
    assert.strictEqual(c1.lines.length, 5);

    const e = stack.popEdit();
    const back = M.applyEdit(c1.lines, e.range, e.next);
    assert.deepStrictEqual(back, orig);
  });

  await t.test('合并删除（after 为空）也能退回', () => {
    const orig = M.splitLines('para one\n\npara two\n');
    const stack = U.createCommitStack(50);
    const c1 = commit(orig, 2, 2, []); // 删掉分隔空行
    stack.push(c1.entry);
    assert.strictEqual(M.joinLines(c1.lines), 'para one\npara two\n');

    const e = stack.popEdit();
    const back = M.applyEdit(c1.lines, e.range, e.next);
    assert.deepStrictEqual(back, orig);
  });

  await t.test('条目自相矛盾必须抛错（after 长度 ≠ 区间长度）', () => {
    const stack = U.createCommitStack(50);
    assert.throws(
      () => stack.push({ from: 0, to: 2, before: ['x'], after: ['one'], docSeq: 1 }),
      /自相矛盾/
    );
  });
});

test('两层撤销·上限与清空', async (t) => {
  await t.test('超上限丢最旧的一条，且 revertTo 追不回原文', () => {
    let lines = M.splitLines('a\n\nb\n');
    const stack = U.createCommitStack(2);
    const orig = lines;

    for (let i = 0; i < 3; i++) {
      const c = commit(lines, 1, 1, [`a${i}`]);
      stack.push(c.entry);
      lines = c.lines;
    }
    assert.strictEqual(stack.size(), 2);
    const back = U.revertTo(lines, stack, 0);
    assert.notDeepStrictEqual(back, orig, '最旧那条已丢 ⇒ 回不到原文');
    assert.strictEqual(stack.size(), 0);
  });

  await t.test('上限内 revertTo 逐条逆序应用 ⇒ 回到原文', () => {
    let lines = M.splitLines('a\n\nb\n');
    const orig = lines;
    const stack = U.createCommitStack(10);
    for (let i = 0; i < 3; i++) {
      const c = commit(lines, 1, 1, [`a${i}`]);
      stack.push(c.entry);
      lines = c.lines;
    }
    assert.deepStrictEqual(U.revertTo(lines, stack, 0), orig);
  });

  await t.test('换文档 clear() 之后没有可撤的', () => {
    const stack = U.createCommitStack(10);
    const c = commit(M.splitLines('a\n'), 1, 1, ['b']);
    stack.push(c.entry);
    assert.strictEqual(stack.size(), 1);
    stack.clear();
    assert.strictEqual(stack.size(), 0);
    assert.strictEqual(stack.popEdit(), null);
  });

  await t.test('onChange 通知次数与取消订阅', () => {
    const stack = U.createCommitStack(10);
    let n = 0;
    const off = stack.onChange(() => n++);
    const c = commit(M.splitLines('a\n'), 1, 1, ['b']);
    stack.push(c.entry);
    stack.popEdit();
    assert.strictEqual(n, 2);
    off();
    stack.push(c.entry);
    assert.strictEqual(n, 2);
  });
});

test('两层撤销·⚠️ 收窄的四条可观测后果（拍板靶子）', async (t) => {
  await t.test('① 提交后无法退到"敲到一半"的中间态', () => {
    // 模拟：视图里敲了 a→a1→a12（CM6 有 2 步历史），提交时只有最终值进提交栈
    const stack = U.createCommitStack(50);
    const afterCommit = commit(M.splitLines('a\n'), 1, 1, ['a12']);
    stack.push(afterCommit.entry);
    const e = stack.popEdit();
    const back = M.applyEdit(afterCommit.lines, e.range, e.next);
    assert.strictEqual(M.joinLines(back), 'a\n', '只能回到提交前，⛔ 回不到 a1');
  });

  await t.test('② 跨块撤销要按两次 ⌘Z（不是一次到底）', () => {
    const stack = U.createCommitStack(50);
    let lines = M.splitLines('a\n\nb\n');
    for (const [s, e, next] of [
      [1, 1, ['a1']],
      [3, 3, ['b1']],
    ]) {
      const c = commit(lines, s, e, next);
      stack.push(c.entry);
      lines = c.lines;
    }
    assert.strictEqual(stack.size(), 2, '两次独立提交 ⇒ 要按两次');
  });

  await t.test('③ 单次 ⌘Z 的语义是确定的（不会时大时小）', () => {
    // 同一状态下反复问，答案必须相同——这是"可预期"的最小形式
    const q = { inBlockView: true, cm6HasHistory: false, commitStackSize: 3 };
    assert.strictEqual(U.resolveUndo(q), U.resolveUndo(q));
    assert.strictEqual(U.resolveUndo(q), 'commit');
  });

  await t.test('④ 上限之外的提交永远退不回（2 条上限的小栈，第 3 次提交挤掉第 1 次）', () => {
    const stack = U.createCommitStack(2);
    let lines = M.splitLines('a\n');
    for (let i = 0; i < 3; i++) {
      const c = commit(lines, 1, 1, [`v${i}`]);
      stack.push(c.entry);
      lines = c.lines;
    }
    const back = U.revertTo(lines, stack, 0);
    assert.strictEqual(M.joinLines(back), 'v0\n', '追到 v0，⛔ 不是原文 a');
  });
});
