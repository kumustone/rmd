// 编辑内核 · 全文模型 / 身份闸 / 两层撤销。
// 从 `docs/bugs/` 的历史缺陷倒推：末尾空行被吞、行区间提交、CRLF/BOM 不许在这里被"顺手修"、
// 提交回滚的所有权、撤销重做顺序与重做栈作废。产品行为是唯一真值。
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

// 源自 docs/bugs/0015（标题块里回车之后一直是标题）
// 同轴向：回车产生的新行必须是真实的一行，结尾换行不能被吞。
test('末尾换行拆出真实空行，行数恒比换行数多一', () => {
  assert.deepStrictEqual(M.splitLines('a\n'), ['a', '']);
  assert.deepStrictEqual(M.splitLines('a\nb\n'), ['a', 'b', '']);
  assert.deepStrictEqual(M.splitLines('\n\n'), ['', '', '']);
});

test('空串 / undefined / null 都归一成一行空串', () => {
  assert.deepStrictEqual(M.splitLines(''), ['']);
  assert.deepStrictEqual(M.splitLines(undefined), ['']);
  assert.deepStrictEqual(M.splitLines(null), ['']);
});

test('非字符串输入按 String 归一，不做 trim', () => {
  assert.deepStrictEqual(M.splitLines(12), ['12']);
  assert.deepStrictEqual(M.splitLines('  a  '), ['  a  ']);
});

// 源自 docs/bugs/0081（假后端不归一化行尾和BOM导致探针假红）
// 同轴向：归一化是输入层的职责；模型拿到 CRLF / BOM 必须原样保留，不能偷偷改。
test('模型不归一化 CRLF：a\\r\\nb 是两行，第二行首没有 CR', () => {
  assert.deepStrictEqual(M.splitLines('a\r\nb'), ['a\r', 'b']);
  assert.strictEqual(M.splitLines('a\r\nb').length, 2);
});

test('模型不剥 BOM，BOM 留在第一行行首', () => {
  const lines = M.splitLines('﻿# 标题');
  assert.deepStrictEqual(lines, ['﻿# 标题']);
  assert.strictEqual(lines[0].charCodeAt(0), 0xfeff);
});

test('joinLines 是 splitLines 的逐字节逆运算（含 CRLF / BOM）', () => {
  for (const text of ['', 'a', 'a\n', '\n\n', 'a\r\nb', '﻿x\ny']) {
    assert.strictEqual(M.joinLines(M.splitLines(text)), text, JSON.stringify(text));
  }
});

test('joinLines 对空数组给空串，对 null 给空串', () => {
  assert.strictEqual(M.joinLines([]), '');
  assert.strictEqual(M.joinLines(null), '');
});

test('lineCountOf 对 null / undefined 给 0，真实空行仍计数', () => {
  assert.strictEqual(M.lineCountOf(null), 0);
  assert.strictEqual(M.lineCountOf(undefined), 0);
  assert.strictEqual(M.lineCountOf(M.splitLines('\n')), 2);
});

// 源自 docs/bugs/0014（实时编辑的删除键不生效）
// 同轴向：提交按行半开区间 splice，删一行就该少一行，不是"改附近"。
test('applyEdit 替换 / 插入 / 删除都按半开行区间落到新数组', () => {
  assert.deepStrictEqual(M.applyEdit(['a', 'b', 'c'], { from: 1, to: 2 }, ['x', 'y']), ['a', 'x', 'y', 'c']);
  assert.deepStrictEqual(M.applyEdit(['a', 'b'], { from: 1, to: 1 }, ['x']), ['a', 'x', 'b']);
  assert.deepStrictEqual(M.applyEdit(['a', 'b'], { from: 0, to: 1 }, []), ['b']);
});

test('applyEdit 允许在行数末尾追加，也允许清空全文', () => {
  assert.deepStrictEqual(M.applyEdit(['a'], { from: 1, to: 1 }, ['b']), ['a', 'b']);
  assert.deepStrictEqual(M.applyEdit(['a', 'b'], { from: 0, to: 2 }, []), []);
});

test('applyEdit 不修改入参数组，返回新引用', () => {
  const before = ['a', 'b', 'c'];
  const out = M.applyEdit(before, { from: 1, to: 2 }, ['x']);
  assert.deepStrictEqual(before, ['a', 'b', 'c']);
  assert.notStrictEqual(out, before);
});

test('applyEdit 的载荷为空时按 undefined 当空数组', () => {
  assert.deepStrictEqual(M.applyEdit(['a', 'b'], { from: 0, to: 1 }), ['b']);
});

test('applyEdit 对负索引、反向、越界、小数、NaN、缺区间一律抛错', () => {
  const bad = [
    { from: -1, to: 0 },
    { from: 2, to: 1 },
    { from: 0, to: 4 },
    { from: 0.5, to: 1 },
    { from: 0, to: NaN },
    { from: 0, to: Infinity },
    null,
  ];
  for (const range of bad) {
    assert.throws(() => M.applyEdit(['a', 'b', 'c'], range, []), /区间越界/, JSON.stringify(range));
  }
});

test('applyEdit 对空行数组的 0..0 区间合法', () => {
  assert.deepStrictEqual(M.applyEdit([], { from: 0, to: 0 }, ['x']), ['x']);
});

test('行的 UTF-16 长度是唯一坐标单位：中文与 emoji 按码元计数', () => {
  const lines = ['中文😀'];
  assert.strictEqual(lines[0].length, 4);
  assert.deepStrictEqual(M.applyEdit(lines, { from: 0, to: 1 }, ['中文']), ['中文']);
});

// 源自 docs/bugs/0020（Cmd-Z 不能撤销编辑）
// 同轴向：一次提交 = 一条可回退条目，区间记在提交后的文本上。
test('会话提交把 before/after 与提交后区间一起压栈', () => {
  const s = M.createSession({ text: 'a\nb' });
  const out = s.commit({ from: 0, to: 1 }, ['x', 'y']);
  assert.deepStrictEqual(out.entry, { from: 0, to: 2, before: ['a'], after: ['x', 'y'] });
  assert.deepStrictEqual(out.lines, ['x', 'y', 'b']);
  assert.strictEqual(out.fullText, 'x\ny\nb');
  assert.strictEqual(out.lineCount, 3);
});

test('会话提交只改内存：lines / fullText / lineCount 同步，但没有写盘入口', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  assert.deepStrictEqual(s.lines(), ['b']);
  assert.strictEqual(s.fullText(), 'b');
  assert.strictEqual(s.lineCount(), 1);
  assert.strictEqual(typeof s.commit, 'function');
});

test('删除一行的提交让行数减少，撤销后行数恢复', () => {
  const s = M.createSession({ text: 'a\nb\nc' });
  const c = s.commit({ from: 1, to: 2 }, []);
  assert.deepStrictEqual(s.lines(), ['a', 'c']);
  assert.strictEqual(c.identity.lineCount, 2);
  assert.strictEqual(c.revert().ok, true);
  assert.deepStrictEqual(s.lines(), ['a', 'b', 'c']);
});

// 源自 docs/bugs/0015（标题块里回车之后一直是标题）
// 同轴向：回车 = 删掉旧行 + 插入两行；撤销必须整段还回去，不能只退一半。
test('一次回车式提交（一行换两行）的撤销恢复原文与行数', () => {
  const s = M.createSession({ text: '# 标题' });
  const c = s.commit({ from: 0, to: 1 }, ['# 标题', '正文']);
  assert.strictEqual(c.entry.to, 2);
  assert.deepStrictEqual(c.entry.before, ['# 标题']);
  assert.deepStrictEqual(c.entry.after, ['# 标题', '正文']);
  assert.strictEqual(c.revert().ok, true);
  assert.deepStrictEqual(s.lines(), ['# 标题']);
});

test('在末尾追加空行是合法提交，提交栈条目长度与区间一致', () => {
  const s = M.createSession({ text: 'a' });
  const c = s.commit({ from: 1, to: 1 }, ['']);
  assert.deepStrictEqual(s.lines(), ['a', '']);
  assert.deepStrictEqual(c.entry, { from: 1, to: 2, before: [], after: [''] });
});

test('提交失败（区间越界）不改文本、不压栈、不推进 commitSeq', () => {
  const s = M.createSession({ text: 'a' });
  const before = s.stack().size();
  const seq = s.identity().commitSeq;
  assert.throws(() => s.commit({ from: 0, to: 5 }, ['x']), /区间越界/);
  assert.deepStrictEqual(s.lines(), ['a']);
  assert.strictEqual(s.stack().size(), before);
  assert.strictEqual(s.identity().commitSeq, seq);
});

test('提交推进 commitSeq 与身份行数，docSeq / generation 不变', () => {
  const s = M.createSession({ text: 'a\nb', realPath: '/x.md', generation: 7, docSeq: 9 });
  s.commit({ from: 0, to: 1 }, ['x', 'y']);
  assert.deepStrictEqual(s.identity(), {
    realPath: '/x.md', generation: 7, docSeq: 9, lineCount: 3, commitSeq: 1,
  });
});

// 源自 docs/bugs/0020（Cmd-Z 不能撤销编辑）
// 同轴向：用户撤销可重做，内部回滚不可重做；新提交让重做栈作废。
test('撤销进重做栈，重做把条目还回提交栈，顺序是 LIFO', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 0, to: 1, before: ['a'], after: ['b'] });
  st.push({ from: 0, to: 1, before: ['b'], after: ['c'] });
  assert.deepStrictEqual(st.undoEdit().next, ['b']);
  assert.deepStrictEqual(st.undoEdit().next, ['a']);
  assert.strictEqual(st.size(), 0);
  assert.strictEqual(st.redoSize(), 2);
  assert.deepStrictEqual(st.redoEdit().next, ['b']);
  assert.deepStrictEqual(st.redoEdit().next, ['c']);
  assert.strictEqual(st.size(), 2);
  assert.strictEqual(st.redoSize(), 0);
});

test('内部 popEdit 不进重做栈，弹空后返回 null', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 0, to: 1, before: ['a'], after: ['b'] });
  assert.deepStrictEqual(st.popEdit(), { range: { from: 0, to: 1 }, next: ['a'] });
  assert.strictEqual(st.redoSize(), 0);
  assert.strictEqual(st.popEdit(), null);
  assert.strictEqual(st.undoEdit(), null);
  assert.strictEqual(st.redoEdit(), null);
});

test('会话内部 undo 不产生可重做项，redo 返回 null', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  const u = s.undo();
  assert.deepStrictEqual(u.lines, ['a']);
  assert.strictEqual(s.peekRedo(), null);
  assert.strictEqual(s.redo(), null);
});

test('新提交清空重做栈，避免把旧目标重做到新文本上', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 0, to: 1, before: ['a'], after: ['b'] });
  st.undoEdit();
  assert.strictEqual(st.redoSize(), 1);
  st.push({ from: 0, to: 1, before: ['a'], after: ['z'] });
  assert.strictEqual(st.redoSize(), 0);
  assert.strictEqual(st.redoEdit(), null);
});

test('提交栈超过上限丢最旧条目，默认上限是 100', () => {
  assert.strictEqual(M.COMMIT_STACK_LIMIT, 100);
  const st = M.createCommitStack(2);
  for (let i = 0; i < 3; i++) {
    st.push({ from: 0, to: 1, before: ['b' + i], after: ['a' + i] });
  }
  assert.deepStrictEqual(st.snapshot().map((e) => e.after[0]), ['a1', 'a2']);
});

test('非法上限回落到默认 100，不会被当成 0 或负数', () => {
  const st = M.createCommitStack(0);
  for (let i = 0; i < 101; i++) {
    st.push({ from: 0, to: 1, before: ['b'], after: ['a' + i] });
  }
  assert.strictEqual(st.size(), 100);
  assert.strictEqual(st.snapshot()[0].after[0], 'a1');
});

test('压栈拒绝 after 长度与区间长度矛盾的条目，且栈保持原样', () => {
  const st = M.createCommitStack(10);
  assert.throws(
    () => st.push({ from: 0, to: 2, before: ['a'], after: ['x'] }),
    /条目自相矛盾/
  );
  assert.strictEqual(st.size(), 0);
});

test('peekUndo / peekRedo 只观察不动栈，redo 区间按 before 长度算', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 2, to: 4, before: ['a'], after: ['x', 'y'] });
  assert.deepStrictEqual(st.peekUndoEdit(), { range: { from: 2, to: 4 }, next: ['a'] });
  st.undoEdit();
  assert.deepStrictEqual(st.peekRedoEdit(), { range: { from: 2, to: 3 }, next: ['x', 'y'] });
  assert.strictEqual(st.size(), 0);
  assert.strictEqual(st.redoSize(), 1);
});

test('两侧栈快照原样还原，restoreState(null) 返回 false 且不动栈', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 0, to: 1, before: ['a'], after: ['b'] });
  st.undoEdit();
  const snap = st.snapshotState();
  st.clear();
  assert.strictEqual(st.restoreState(snap), true);
  assert.strictEqual(st.size(), 0);
  assert.strictEqual(st.redoSize(), 1);
  assert.strictEqual(st.restoreState(null), false);
});

test('snapshot 返回副本，改副本不污染栈内条目', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 0, to: 1, before: ['a'], after: ['b'] });
  const snap = st.snapshot();
  snap[0].after[0] = 'z';
  snap[0].before.push('q');
  assert.strictEqual(st.peek().after[0], 'b');
  assert.deepStrictEqual(st.peek().before, ['a']);
});

test('revertTo 逆序弹到目标深度：两次提交各自区间只对当时文本成立', () => {
  let lines = ['a'];
  const st = M.createCommitStack(10);
  lines = M.applyEdit(lines, { from: 0, to: 1 }, ['b']);
  st.push({ from: 0, to: 1, before: ['a'], after: ['b'] });
  lines = M.applyEdit(lines, { from: 0, to: 1 }, ['c', 'd']);
  st.push({ from: 0, to: 2, before: ['b'], after: ['c', 'd'] });
  assert.deepStrictEqual(lines, ['c', 'd']);
  assert.deepStrictEqual(M.revertTo(lines, st, 0), ['a']);
  assert.strictEqual(st.size(), 0);
  assert.strictEqual(st.redoSize(), 0);
});

test('revertTo 目标深度大于当前深度时原样返回', () => {
  const st = M.createCommitStack(10);
  st.push({ from: 0, to: 1, before: ['a'], after: ['b'] });
  assert.deepStrictEqual(M.revertTo(['b'], st, 5), ['b']);
  assert.strictEqual(st.size(), 1);
});

test('resolveUndo 的三层优先级与缺省值', () => {
  assert.strictEqual(M.resolveUndo({ inBlockView: true, cm6HasHistory: true, commitStackSize: 9 }), 'cm6');
  assert.strictEqual(M.resolveUndo({ inBlockView: true, cm6HasHistory: false, commitStackSize: 1 }), 'commit');
  assert.strictEqual(M.resolveUndo({ inBlockView: false, cm6HasHistory: true, commitStackSize: 1 }), 'commit');
  assert.strictEqual(M.resolveUndo({ inBlockView: false, cm6HasHistory: true, commitStackSize: 0 }), 'none');
  assert.strictEqual(M.resolveUndo({}), 'none');
  assert.strictEqual(M.resolveUndo(undefined), 'none');
});

// 源自 docs/bugs/0020（Cmd-Z 不能撤销编辑）
// 同轴向：撤销 / 重做也是文本变化，必须推进 commitSeq，失败时能整份回滚。
test('用户撤销与重做各自推进 commitSeq，重做后文本回到提交结果', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  const u = s.undoEdit();
  assert.deepStrictEqual(u.lines, ['a']);
  assert.strictEqual(s.identity().commitSeq, 2);
  const r = s.redo();
  assert.deepStrictEqual(r.lines, ['b']);
  assert.strictEqual(s.identity().commitSeq, 3);
  assert.strictEqual(s.stack().size(), 1);
});

test('撤销的回滚连重做栈一起还原：条目回栈顶、重做栈清空', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  const u = s.undoEdit();
  assert.strictEqual(s.stack().redoSize(), 1);
  assert.strictEqual(u.revert().ok, true);
  assert.deepStrictEqual(s.lines(), ['b']);
  assert.strictEqual(s.stack().size(), 1);
  assert.strictEqual(s.stack().redoSize(), 0);
  assert.strictEqual(s.identity().commitSeq, 1);
});

test('重做的回滚回到"撤销之后、重做之前"的文本与栈形', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  s.undoEdit();
  const r = s.redo();
  assert.deepStrictEqual(s.lines(), ['b']);
  assert.strictEqual(r.revert().ok, true);
  assert.deepStrictEqual(s.lines(), ['a']);
  assert.strictEqual(s.stack().size(), 0);
  assert.strictEqual(s.stack().redoSize(), 1);
  assert.strictEqual(s.identity().commitSeq, 2);
});

test('撤销 / 重做的回滚是幂等的，第二次返回 already', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  const u = s.undoEdit();
  assert.deepStrictEqual(u.revert(), { ok: true, already: false, why: '' });
  assert.deepStrictEqual(u.revert(), { ok: true, already: true, why: '' });
  assert.deepStrictEqual(s.lines(), ['b']);
});

test('过期 txId 的撤销回滚被拒，文本与栈都不动', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  const u = s.undoEdit();
  const r = u.revert({ txId: u.txId + 1 });
  assert.deepStrictEqual(r, { ok: false, already: false, why: 'not-owner' });
  assert.deepStrictEqual(s.lines(), ['a']);
  assert.strictEqual(s.stack().redoSize(), 1);
});

test('撤销之后又有新提交 ⇒ 旧回滚句柄报 newer，不盖掉新状态', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  const u = s.undoEdit();
  s.commit({ from: 0, to: 1 }, ['c']);
  assert.strictEqual(u.revert().ok, false);
  assert.strictEqual(u.revert().why, 'newer');
  assert.deepStrictEqual(s.lines(), ['c']);
});

test('提交的回滚在出现更新提交后同样报 newer', () => {
  const s = M.createSession({ text: 'a' });
  const c = s.commit({ from: 0, to: 1 }, ['b']);
  s.commit({ from: 0, to: 1 }, ['c']);
  assert.deepStrictEqual(c.revert(), { ok: false, already: false, why: 'newer' });
  assert.deepStrictEqual(s.lines(), ['c']);
});

test('换文档（rebind）后旧提交的回滚报 newer，不把新文本退回去', () => {
  const s = M.createSession({ text: 'a', realPath: '/a.md' });
  const c = s.commit({ from: 0, to: 1 }, ['b']);
  s.rebind({ text: 'm\nn', realPath: '/b.md', docSeq: 2 });
  assert.strictEqual(c.revert().why, 'newer');
  assert.deepStrictEqual(s.lines(), ['m', 'n']);
});

test('会话快照不可变：提交之后旧快照仍指旧文本与旧栈', () => {
  const s = M.createSession({ text: 'a' });
  const snap = s.snapshot();
  s.commit({ from: 0, to: 1 }, ['b']);
  assert.deepStrictEqual(snap.lines, ['a']);
  assert.strictEqual(s.restore(snap), true);
  assert.deepStrictEqual(s.lines(), ['a']);
  assert.strictEqual(s.stack().size(), 0);
  assert.strictEqual(s.restore(null), false);
});

test('会话 undoEdit / redo 在空栈时返回 null，不改任何状态', () => {
  const s = M.createSession({ text: 'a' });
  assert.strictEqual(s.undoEdit(), null);
  assert.strictEqual(s.redo(), null);
  assert.deepStrictEqual(s.lines(), ['a']);
  assert.strictEqual(s.identity().commitSeq, 0);
});

test('peekUndo / peekRedo 只观察：文本、两侧栈、身份都不动', () => {
  const s = M.createSession({ text: 'a' });
  s.commit({ from: 0, to: 1 }, ['b']);
  assert.deepStrictEqual(s.peekUndo(), { range: { from: 0, to: 1 }, next: ['a'] });
  assert.deepStrictEqual(s.lines(), ['b']);
  assert.strictEqual(s.stack().size(), 1);
  assert.strictEqual(s.peekRedo(), null);
});

// 源自 docs/bugs/0016（只剩井号的行在编辑态被当成正文）
// 同轴向：rebind / 外部重载换文本就清栈 —— 旧条目说的是旧文本的行号。
test('rebind 换文本并清空两侧栈，commitSeq 归零，身份其余字段可保留', () => {
  const s = M.createSession({ text: 'a', realPath: '/x.md', generation: 1, docSeq: 2 });
  s.commit({ from: 0, to: 1 }, ['b']);
  s.undoEdit();
  const id = s.rebind({ text: 'm\nn' });
  assert.deepStrictEqual(s.lines(), ['m', 'n']);
  assert.strictEqual(id.commitSeq, 0);
  assert.strictEqual(id.realPath, '/x.md');
  assert.strictEqual(id.docSeq, 2);
  assert.strictEqual(s.stack().size(), 0);
  assert.strictEqual(s.stack().redoSize(), 0);
});

test('rebind 不给 text 时保留原文，只换身份并清栈', () => {
  const s = M.createSession({ text: 'a', realPath: '/x.md', generation: 1, docSeq: 2 });
  s.commit({ from: 0, to: 1 }, ['b']);
  const id = s.rebind({ realPath: '/y.md', generation: 3 });
  assert.deepStrictEqual(s.lines(), ['b']);
  assert.strictEqual(id.realPath, '/y.md');
  assert.strictEqual(id.generation, 3);
  assert.strictEqual(id.lineCount, 1);
  assert.strictEqual(s.stack().size(), 0);
});

test('rebind 允许把文本换成空串，得到一行空行', () => {
  const s = M.createSession({ text: 'a\nb' });
  const id = s.rebind({ text: '' });
  assert.deepStrictEqual(s.lines(), ['']);
  assert.strictEqual(id.lineCount, 1);
});

test('revision 只含 docSeq / generation / commitSeq / lineCount 四件套', () => {
  const s = M.createSession({ text: 'a\nb', realPath: '/x.md', generation: 2, docSeq: 9 });
  assert.deepStrictEqual(s.revision(), { docSeq: 9, generation: 2, commitSeq: 0, lineCount: 2 });
  s.commit({ from: 0, to: 1 }, ['x', 'y']);
  assert.deepStrictEqual(s.revision(), { docSeq: 9, generation: 2, commitSeq: 1, lineCount: 3 });
});

// 源自 docs/bugs/0014（实时编辑的删除键不生效）
// 同轴向：删除整行后行号陈旧必须能被身份闸识别，不能拿旧行号去改"附近"。
test('身份闸：line_count 不符时先报"行号已陈旧"，doc_seq 不符优先于它', () => {
  const st = M.identity({ realPath: '/a.md', generation: 1, docSeq: 2, lineCount: 3 });
  const r = M.acceptReply(st, { doc_seq: 2, line_count: 2 });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /行号已陈旧/);
  const rr = M.acceptReply(st, { doc_seq: 3, line_count: 99 });
  assert.strictEqual(rr.why, 'doc_seq 不符（换文档了）');
});

test('身份闸：没有快照直接拒绝', () => {
  assert.deepStrictEqual(M.acceptReply(null, {}), { ok: false, why: '没有身份快照' });
  assert.deepStrictEqual(M.acceptReply(undefined, { doc_seq: 1, line_count: 1 }), {
    ok: false, why: '没有身份快照',
  });
});

test('身份闸：real_path / generation 只在回包给出时比较', () => {
  const st = M.identity({ realPath: '/a.md', generation: 4, docSeq: 1, lineCount: 2 });
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, real_path: '/b.md', line_count: 2 }).ok, false);
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, real_path: '/a.md', line_count: 2 }).ok, true);
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, generation: 5, line_count: 2 }).ok, false);
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, generation: 4, line_count: 2 }).ok, true);
});

test('身份闸：commit_seq 只拒绝倒退，相等或缺省都接受', () => {
  const st = M.identity({ realPath: '/a.md', generation: 1, docSeq: 1, lineCount: 2, commitSeq: 5 });
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, line_count: 2, commit_seq: 4 }).ok, false);
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, line_count: 2, commit_seq: 5 }).ok, true);
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, line_count: 2, commit_seq: 6 }).ok, true);
  assert.strictEqual(M.acceptReply(st, { doc_seq: 1, line_count: 2 }).ok, true);
});

test('identity 缺省：realPath 空串、commitSeq 0，其余字段原样', () => {
  assert.deepStrictEqual(M.identity({}), {
    realPath: '', generation: undefined, docSeq: undefined, lineCount: undefined, commitSeq: 0,
  });
  assert.strictEqual(M.identity({ commitSeq: 1.5 }).commitSeq, 0);
  assert.strictEqual(M.identity({ realPath: null }).realPath, '');
});

test('advanceIdentity 只推 commitSeq 与 lineCount，且不改入参', () => {
  const st = M.identity({ realPath: '/a.md', generation: 3, docSeq: 8, lineCount: 4, commitSeq: 2 });
  const next = M.advanceIdentity(st, 6);
  assert.deepStrictEqual(next, {
    realPath: '/a.md', generation: 3, docSeq: 8, lineCount: 6, commitSeq: 3,
  });
  assert.strictEqual(st.lineCount, 4);
  assert.strictEqual(st.commitSeq, 2);
});

test('提交栈 onChange 在提交 / 撤销 / 还原 / 清空时通知，退订后静默', () => {
  const st = M.createCommitStack(10);
  let n = 0;
  const off = st.onChange(() => n++);
  st.push({ from: 0, to: 1, before: ['a'], after: ['b'] });
  st.undoEdit();
  st.restoreState(st.snapshotState());
  st.clear();
  assert.strictEqual(n, 4);
  off();
  st.push({ from: 0, to: 1, before: ['a'], after: ['b'] });
  assert.strictEqual(n, 4);
});
