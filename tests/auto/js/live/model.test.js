// 全文模型：行数组互转、按行区间提交、身份闸、两层撤销。
// 守的是 `src/live/model.js` 文件头列出的四条口径；产品行为是唯一真值。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.rmd;
}

const M = load('src/live/model.js').liveModel;

test('末尾换行被拆成真实的一行空串，不是被吞掉', () => {
  assert.deepStrictEqual(M.splitLines('a\n'), ['a', '']);
  assert.deepStrictEqual(M.splitLines('a\nb'), ['a', 'b']);
  assert.deepStrictEqual(M.splitLines(''), ['']);
});

test('splitLines 对 undefined / null 给一行空串，行数恒至少 1', () => {
  assert.deepStrictEqual(M.splitLines(undefined), ['']);
  assert.deepStrictEqual(M.splitLines(null), ['']);
  assert.strictEqual(M.lineCountOf(M.splitLines('')), 1);
});

test('joinLines 是 splitLines 的逐字节逆运算', () => {
  for (const text of ['', 'a', 'a\n', 'a\nb\n', '\n\n']) {
    assert.strictEqual(M.joinLines(M.splitLines(text)), text);
  }
});

test('applyEdit 按行区间替换并返回新数组，不改入参', () => {
  const before = ['a', 'b', 'c'];
  const out = M.applyEdit(before, { from: 1, to: 2 }, ['x', 'y']);
  assert.deepStrictEqual(out, ['a', 'x', 'y', 'c']);
  assert.deepStrictEqual(before, ['a', 'b', 'c']);
});

test('applyEdit 允许空区间插入与空载荷删除', () => {
  assert.deepStrictEqual(M.applyEdit(['a', 'b'], { from: 1, to: 1 }, ['x']), ['a', 'x', 'b']);
  assert.deepStrictEqual(M.applyEdit(['a', 'b'], { from: 0, to: 1 }, []), ['b']);
});

test('applyEdit 越界或非整数区间直接抛错，不夹取', () => {
  const bad = [
    { from: -1, to: 0 },
    { from: 0, to: 4 },
    { from: 2, to: 1 },
    { from: 0.5, to: 1 },
    { from: 0, to: NaN },
    null,
  ];
  for (const range of bad) {
    assert.throws(() => M.applyEdit(['a', 'b', 'c'], range, []), /区间越界/);
  }
});

test('identity 把 commitSeq 缺省成 0，realPath 缺省成空串', () => {
  const id = M.identity({ realPath: undefined, generation: 2, docSeq: 7, lineCount: 3 });
  assert.deepStrictEqual(id, {
    realPath: '',
    generation: 2,
    docSeq: 7,
    lineCount: 3,
    commitSeq: 0,
  });
});

test('acceptReply 没有身份快照时拒绝', () => {
  assert.deepStrictEqual(M.acceptReply(null, {}), { ok: false, why: '没有身份快照' });
});

test('acceptReply 的 doc_seq 不符时拒绝', () => {
  const st = M.identity({ realPath: '/a.md', generation: 1, docSeq: 2, lineCount: 3 });
  assert.strictEqual(M.acceptReply(st, { doc_seq: 3, line_count: 3 }).ok, false);
  assert.strictEqual(M.acceptReply(st, { doc_seq: 2, line_count: 3 }).ok, true);
});

test('acceptReply 的 real_path / generation 只在回包给出时比较', () => {
  const st = M.identity({ realPath: '/a.md', generation: 4, docSeq: 1, lineCount: 2 });
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, real_path: '/b.md', line_count: 2 }).ok, false);
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, generation: 5, line_count: 2 }).ok, false);
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, line_count: 2 }).ok, true);
});

test('acceptReply 把过期的 line_count 当成行号已陈旧而拒绝', () => {
  const st = M.identity({ realPath: '/a.md', generation: 1, docSeq: 1, lineCount: 3 });
  const r = M.acceptReply(st, { doc_seq: 1, line_count: 2 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.why.includes('行号已陈旧'), r.why);
});

test('acceptReply 拒绝 commit_seq 倒退，但缺省或相等照常接受', () => {
  const st = M.identity({ realPath: '/a.md', generation: 1, docSeq: 1, lineCount: 2, commitSeq: 5 });
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, line_count: 2, commit_seq: 4 }).ok, false);
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, line_count: 2, commit_seq: 5 }).ok, true);
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, line_count: 2 }).ok, true);
});

test('advanceIdentity 只推进 commitSeq 与 lineCount', () => {
  const st = M.identity({ realPath: '/a.md', generation: 3, docSeq: 8, lineCount: 4, commitSeq: 2 });
  assert.deepStrictEqual(M.advanceIdentity(st, 6), {
    realPath: '/a.md',
    generation: 3,
    docSeq: 8,
    lineCount: 6,
    commitSeq: 3,
  });
});

test('提交栈拒绝 after 长度与区间长度自相矛盾的条目', () => {
  const st = M.createCommitStack(10);
  assert.throws(
    () => st.push({ from: 0, to: 2, before: [], after: ['x'] }),
    /条目自相矛盾/
  );
  assert.strictEqual(st.size(), 0);
});

test('提交栈超过上限时丢最旧的一条', () => {
  const st = M.createCommitStack(3);
  for (let i = 0; i < 4; i++) {
    st.push({ from: 0, to: 1, before: ['b' + i], after: ['a' + i] });
  }
  assert.strictEqual(st.size(), 3);
  assert.deepStrictEqual(st.snapshot().map((e) => e.after[0]), ['a1', 'a2', 'a3']);
});

test('新提交清空重做栈，避免分叉后重做旧文本', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 0, to: 1, before: ['b'], after: ['a'] });
  st.undoEdit();
  assert.strictEqual(st.redoSize(), 1);
  st.push({ from: 0, to: 1, before: ['a'], after: ['x'] });
  assert.strictEqual(st.redoSize(), 0);
});

test('用户撤销进重做栈，重做再把条目还回提交栈', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 0, to: 1, before: ['b'], after: ['a'] });
  assert.deepStrictEqual(st.undoEdit(), { range: { from: 0, to: 1 }, next: ['b'] });
  assert.strictEqual(st.size(), 0);
  assert.strictEqual(st.redoSize(), 1);
  assert.deepStrictEqual(st.redoEdit(), { range: { from: 0, to: 1 }, next: ['a'] });
  assert.strictEqual(st.size(), 1);
  assert.strictEqual(st.redoSize(), 0);
});

test('内部回滚用的 popEdit 不进重做栈，栈空时返回 null', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 0, to: 1, before: ['b'], after: ['a'] });
  assert.deepStrictEqual(st.popEdit(), { range: { from: 0, to: 1 }, next: ['b'] });
  assert.strictEqual(st.redoSize(), 0);
  assert.strictEqual(st.popEdit(), null);
  assert.strictEqual(st.peek(), null);
});

test('peekUndoEdit / peekRedoEdit 只看不动两侧栈', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 2, to: 3, before: ['b1', 'b2'], after: ['a1'] });
  assert.deepStrictEqual(st.peekUndoEdit(), {
    range: { from: 2, to: 3 },
    next: ['b1', 'b2'],
  });
  assert.strictEqual(st.size(), 1);
  assert.strictEqual(st.peekRedoEdit(), null);
  st.undoEdit();
  assert.deepStrictEqual(st.peekRedoEdit(), {
    range: { from: 2, to: 4 },
    next: ['a1'],
  });
  assert.strictEqual(st.redoSize(), 1);
});

test('两侧栈快照能原样还原（含重做栈）', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 0, to: 1, before: ['b'], after: ['a'] });
  st.undoEdit();
  const snap = st.snapshotState();
  st.clear();
  assert.strictEqual(st.size(), 0);
  assert.strictEqual(st.redoSize(), 0);
  assert.strictEqual(st.restoreState(snap), true);
  assert.strictEqual(st.size(), 0);
  assert.strictEqual(st.redoSize(), 1);
  assert.strictEqual(st.restoreState(null), false);
});

test('撤销优先级：块视图且有 CM6 历史先用 CM6，否则提交栈，最后 none', () => {
  assert.strictEqual(M.resolveUndo({ inBlockView: true, cm6HasHistory: true, commitStackSize: 3 }), 'cm6');
  assert.strictEqual(M.resolveUndo({ inBlockView: true, cm6HasHistory: false, commitStackSize: 3 }), 'commit');
  assert.strictEqual(M.resolveUndo({ inBlockView: false, cm6HasHistory: true, commitStackSize: 3 }), 'commit');
  assert.strictEqual(M.resolveUndo({ inBlockView: false, cm6HasHistory: true, commitStackSize: 0 }), 'none');
  assert.strictEqual(M.resolveUndo(undefined), 'none');
});

test('revertTo 逆序逐条回退到目标深度', () => {
  // 两次提交的行区间各自只对提交后的文本成立，必须逆序弹。
  let lines = ['a'];
  const st = M.createCommitStack(10);
  let e1 = { from: 0, to: 1, before: ['a'], after: ['b'] };
  lines = M.applyEdit(lines, { from: e1.from, to: e1.to }, e1.after);
  st.push(e1);
  const e2 = { from: 0, to: 2, before: ['b'], after: ['c', 'd'] };
  lines = M.applyEdit(lines, { from: 0, to: 1 }, e2.after);
  st.push(e2);
  assert.deepStrictEqual(lines, ['c', 'd']);
  const back = M.revertTo(lines, st, 0);
  assert.deepStrictEqual(back, ['a']);
  assert.strictEqual(st.size(), 0);
});

test('会话提交改文本、压条目并推进 commitSeq', () => {
  const s = M.createSession({ text: 'a\nb', realPath: '/x.md', generation: 1, docSeq: 2 });
  const out = s.commit({ from: 0, to: 1 }, ['x', 'y']);
  assert.deepStrictEqual(out.lines, ['x', 'y', 'b']);
  assert.strictEqual(out.fullText, 'x\ny\nb');
  assert.strictEqual(out.lineCount, 3);
  assert.strictEqual(out.identity.commitSeq, 1);
  assert.strictEqual(out.identity.lineCount, 3);
  assert.deepStrictEqual(out.entry, { from: 0, to: 2, before: ['a'], after: ['x', 'y'] });
  assert.strictEqual(s.stack().size(), 1);
});

test('会话提交不写盘：只改内存里的行数组', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  assert.deepStrictEqual(s.lines(), ['b']);
  assert.strictEqual(s.fullText(), 'b');
  assert.strictEqual(s.lineCount(), 1);
});

test('提交后的回滚句柄能整份还原文本、身份与提交栈', () => {
  const s = M.createSession({ text: 'a\nb' });
  const c = s.commit({ from: 0, to: 1 }, ['x']);
  assert.deepStrictEqual(s.lines(), ['x', 'b']);
  assert.strictEqual(s.identity().commitSeq, 1);
  const r = c.revert();
  assert.deepStrictEqual(r, { ok: true, already: false, why: '' });
  assert.deepStrictEqual(s.lines(), ['a', 'b']);
  assert.strictEqual(s.identity().commitSeq, 0);
  assert.strictEqual(s.stack().size(), 0);
  assert.deepStrictEqual(c.revert(), { ok: true, already: true, why: '' });
});

test('旧提交的回滚句柄在出现更新的提交后拒绝覆盖', () => {
  const s = M.createSession({ text: 'a' });
  const c = s.commit({ from: 0, to: 1 }, ['b']);
  s.commit({ from: 0, to: 1 }, ['c']);
  const r = c.revert();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.why, 'newer');
  assert.deepStrictEqual(s.lines(), ['c']);
});

test('非所有权 txId 提交不生效，不改变任何状态', () => {
  const s = M.createSession({ text: 'a' });
  const c = s.commit({ from: 0, to: 1 }, ['b']);
  const r = c.revert({ txId: c.txId + 1 });
  assert.deepStrictEqual(r, { ok: false, already: false, why: 'not-owner' });
  assert.deepStrictEqual(s.lines(), ['b']);
  assert.strictEqual(s.identity().commitSeq, 1);
});

test('用户撤销与重做各自推进 commitSeq，重做后文本回到提交结果', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  const u = s.undoEdit();
  assert.deepStrictEqual(u.lines, ['a']);
  assert.strictEqual(s.identity().commitSeq, 2);
  assert.strictEqual(s.stack().redoSize(), 1);
  const r = s.redo();
  assert.deepStrictEqual(r.lines, ['b']);
  assert.strictEqual(s.identity().commitSeq, 3);
  assert.strictEqual(s.stack().size(), 1);
});

test('用户撤销的回滚把条目与重做栈一起还原', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  const u = s.undoEdit();
  assert.strictEqual(s.stack().size(), 0);
  assert.strictEqual(s.stack().redoSize(), 1);
  assert.strictEqual(u.revert().ok, true);
  assert.deepStrictEqual(s.lines(), ['b']);
  assert.strictEqual(s.stack().size(), 1);
  assert.strictEqual(s.stack().redoSize(), 0);
  assert.strictEqual(s.identity().commitSeq, 1);
});

test('撤销期间的更新提交会让旧回滚句柄报 newer', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  const u = s.undoEdit();
  s.commit({ from: 0, to: 1 }, ['c']);
  const r = u.revert();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.why, 'newer');
  assert.deepStrictEqual(s.lines(), ['c']);
});

test('peekUndo / peekRedo 不改变真值与两侧栈', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  assert.deepStrictEqual(s.peekUndo(), { range: { from: 0, to: 1 }, next: ['a'] });
  assert.deepStrictEqual(s.lines(), ['b']);
  assert.strictEqual(s.stack().size(), 1);
  assert.strictEqual(s.peekRedo(), null);
});

test('revision 只含文档标识四件套，不含 generation 之外的字段', () => {
  const s = M.createSession({ text: 'a\nb', realPath: '/x.md', generation: 2, docSeq: 9 });
  assert.deepStrictEqual(s.revision(), { docSeq: 9, generation: 2, commitSeq: 0, lineCount: 2 });
  s.commit({ from: 0, to: 1 }, ['x', 'y']);
  assert.deepStrictEqual(s.revision(), { docSeq: 9, generation: 2, commitSeq: 1, lineCount: 3 });
});

test('rebind 换文本并清空两侧栈、把 commitSeq 归零', () => {
  const s = M.createSession({ text: 'a', realPath: '/x.md', generation: 1, docSeq: 2 });
  s.commit({ from: 0, to: 1 }, ['b']);
  s.undoEdit();
  const id = s.rebind({ text: 'm\nn' });
  assert.deepStrictEqual(s.lines(), ['m', 'n']);
  assert.strictEqual(s.lineCount(), 2);
  assert.strictEqual(id.commitSeq, 0);
  assert.strictEqual(id.realPath, '/x.md');
  assert.strictEqual(id.docSeq, 2);
  assert.strictEqual(s.stack().size(), 0);
  assert.strictEqual(s.stack().redoSize(), 0);
});

test('rebind 不给 text 时保留原文，只换身份与清栈', () => {
  const s = M.createSession({ text: 'a', realPath: '/x.md', generation: 1, docSeq: 2 });
  s.commit({ from: 0, to: 1 }, ['b']);
  const id = s.rebind({ realPath: '/y.md' });
  assert.deepStrictEqual(s.lines(), ['b']);
  assert.strictEqual(id.realPath, '/y.md');
  assert.strictEqual(id.commitSeq, 0);
  assert.strictEqual(s.stack().size(), 0);
});

test('提交栈 onChange 在提交、撤销、还原时通知，取消订阅后不再通知', () => {
  const st = M.createCommitStack(10);
  let n = 0;
  const off = st.onChange(() => n++);
  st.push({ from: 0, to: 1, before: ['b'], after: ['a'] });
  assert.strictEqual(n, 1);
  st.undoEdit();
  assert.strictEqual(n, 2);
  st.clear();
  assert.strictEqual(n, 3);
  off();
  st.push({ from: 0, to: 1, before: ['b'], after: ['a'] });
  assert.strictEqual(n, 3);
});

test('snapshot 返回条目副本，外部改副本不污染栈内条目', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 0, to: 1, before: ['b'], after: ['a'] });
  const snap = st.snapshot();
  snap[0].after[0] = 'z';
  assert.strictEqual(st.peek().after[0], 'a');
});
