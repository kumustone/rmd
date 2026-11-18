// 输入状态机：CRLF 归一、组合会话落定、重复 insert 吞咽、粘贴排队、回车续列表。
// 守的是 `INV-LIVE-12/13/17` 与 `design/0059` C′ 的组合目标 / 修订复核。
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

const I = load('src/live/input.js').liveInput;

function setup(policy) {
  const txs = [];
  const machine = I.createInputMachine(function (tx) {
    txs.push(tx);
  }, policy);
  return { machine: machine, txs: txs };
}

test('normalizeNewlines 把 CRLF 与裸 CR 都归成 LF，其余字节不动', () => {
  assert.strictEqual(I.normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.strictEqual(I.normalizeNewlines('a\r\r\nb'), 'a\n\nb');
  assert.strictEqual(I.normalizeNewlines(' a \t'), ' a \t');
  assert.strictEqual(I.normalizeNewlines(null), '');
  assert.strictEqual(I.normalizeNewlines(12), '12');
});

test('linesOf 先归一化再按 LF 切行', () => {
  assert.deepStrictEqual(I.linesOf('a\r\nb\r'), ['a', 'b', '']);
  assert.deepStrictEqual(I.linesOf(''), ['']);
  assert.deepStrictEqual(I.linesOf(null), ['']);
});

test('isComposingEvent 用自己的组合标志优先，不依赖 Safari 的 isComposing', () => {
  assert.strictEqual(I.isComposingEvent({ isComposing: false }, { composing: true }), true);
  assert.strictEqual(I.isComposingEvent({ isComposing: true }, { composing: false }), true);
  assert.strictEqual(I.isComposingEvent({}, { composing: false }), false);
});

test('createInputMachine 初始快照：不在组合、没有会话 / 待吞 / 待补', () => {
  const { machine } = setup();
  assert.deepStrictEqual(machine.state, {
    composing: false,
    start: 0,
    end: 0,
    provisional: '',
    session: null,
    swallow: null,
    pending: [],
  });
});

test('组合开始：记下区间与会话，但不产出事务', () => {
  const { machine, txs } = setup();
  const r = machine.handle({ type: 'compositionstart', from: 2, to: 4, target: 't1', revision: 'r1' });
  assert.strictEqual(r.applied, false);
  assert.deepStrictEqual(machine.state.session, { from: 2, to: 4, target: 't1', revision: 'r1' });
  assert.strictEqual(machine.state.composing, true);
  assert.deepStrictEqual(txs, []);
});

test('组合开始会清掉上一轮的待吞文本', () => {
  const { machine } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'compositionend', from: 0, to: 0, data: 'x' });
  assert.strictEqual(machine.state.swallow, 'x');
  machine.handle({ type: 'compositionstart', from: 3, to: 3 });
  assert.strictEqual(machine.state.swallow, null);
});

test('不在组合态时 compositionupdate / compositionend 都忽略', () => {
  const { machine, txs } = setup();
  assert.strictEqual(machine.handle({ type: 'compositionupdate', data: 'x' }).applied, false);
  assert.strictEqual(machine.handle({ type: 'compositionend', data: 'x' }).applied, false);
  assert.deepStrictEqual(txs, []);
});

test('compositionupdate 只更新临时态，文档一个字节都不动', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  const r = machine.handle({ type: 'compositionupdate', data: '你' });
  assert.strictEqual(r.applied, false);
  assert.strictEqual(machine.state.provisional, '你');
  assert.deepStrictEqual(txs, []);
});

test('组合结束只落一条事务，区间取当前选区并记下待吞文本', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 2, to: 4 });
  const r = machine.handle({ type: 'compositionend', from: 2, to: 4, data: '你好' });
  assert.deepStrictEqual(r, {
    applied: true,
    rebased: false,
    why: '组合结束：落一条事务',
  });
  assert.deepStrictEqual(txs, [{ from: 2, to: 4, next: ['你好'], reason: 'composition' }]);
  assert.strictEqual(machine.state.swallow, '你好');
  assert.strictEqual(machine.state.session, null);
  assert.strictEqual(machine.state.provisional, '');
});

test('组合结果里的换行也归一化并切成多行', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'compositionend', from: 0, to: 0, data: 'a\r\nb' });
  assert.deepStrictEqual(txs[0].next, ['a', 'b']);
});

test('组合结束后的重复 beforeinput 按内容逐字吞掉，只吞一发', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'compositionend', from: 0, to: 0, data: '词' });
  const first = machine.handle({ type: 'beforeinput', inputType: 'insertText', data: '词', from: 0, to: 0 });
  assert.strictEqual(first.applied, false);
  assert.strictEqual(machine.state.swallow, null);
  const second = machine.handle({ type: 'beforeinput', inputType: 'insertText', data: '词', from: 1, to: 1 });
  assert.strictEqual(second.applied, true);
  assert.strictEqual(txs.length, 2);
});

test('重复 input 事件同样按内容吞掉', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'compositionend', from: 0, to: 0, data: 'z' });
  assert.strictEqual(machine.handle({ type: 'input', data: 'z', from: 0, to: 0 }).applied, false);
  assert.strictEqual(machine.handle({ type: 'input', data: 'z', from: 1, to: 1 }).applied, true);
  assert.strictEqual(txs.length, 2);
});

test('内容不同的 insert 不被吞，并当场结束待吞生命周期', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'compositionend', from: 0, to: 0, data: 'x' });
  const r = machine.handle({ type: 'beforeinput', inputType: 'insertText', data: 'y', from: 1, to: 1 });
  assert.strictEqual(r.applied, true);
  assert.strictEqual(txs[1].next[0], 'y');
  assert.strictEqual(machine.state.swallow, null);
  assert.strictEqual(machine.handle({ type: 'beforeinput', inputType: 'insertText', data: 'x', from: 2, to: 2 }).applied, true);
});

test('删除、撤销、未处理的 beforeinput 都会结束待吞，避免吞掉后续真输入', () => {
  for (const ev of [
    { type: 'beforeinput', inputType: 'deleteContentBackward', from: 0, to: 1 },
    { type: 'beforeinput', inputType: 'historyUndo' },
    { type: 'beforeinput', inputType: 'formatBold', from: 0, to: 1 },
  ]) {
    const { machine } = setup();
    machine.handle({ type: 'compositionstart', from: 0, to: 0 });
    machine.handle({ type: 'compositionend', from: 0, to: 0, data: 'x' });
    machine.handle(ev);
    assert.strictEqual(machine.state.swallow, null, ev.inputType);
  }
});

test('空插入不产出事务，也不清掉待吞（它没有改变任何东西）', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'compositionend', from: 0, to: 0, data: 'x' });
  assert.strictEqual(machine.handle({ type: 'beforeinput', inputType: 'insertText', data: '' }).applied, false);
  assert.strictEqual(machine.state.swallow, 'x');
  assert.strictEqual(machine.handle({ type: 'beforeinput', inputType: 'insertText', data: 'x', from: 0, to: 0 }).applied, false);
  assert.deepStrictEqual(txs, [{ from: 0, to: 0, next: ['x'], reason: 'composition' }]);
});

test('组合态里的 beforeinput / input 一律交给 compositionend', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  assert.strictEqual(machine.handle({ type: 'beforeinput', inputType: 'insertText', data: 'a' }).applied, false);
  assert.strictEqual(machine.handle({ type: 'input', data: 'a' }).applied, false);
  assert.deepStrictEqual(txs, []);
});

test('普通 beforeinput 插入与删除按浏览器给的区间落事务', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'beforeinput', inputType: 'insertText', data: 'ab', from: 1, to: 2 });
  machine.handle({ type: 'beforeinput', inputType: 'deleteWordBackward', from: 1, to: 5 });
  assert.deepStrictEqual(txs, [
    { from: 1, to: 2, next: ['ab'], reason: 'insert' },
    { from: 1, to: 5, next: [], reason: 'delete' },
  ]);
});

test('撤销重做不交给浏览器，也不产出事务', () => {
  const { machine, txs } = setup();
  const r = machine.handle({ type: 'beforeinput', inputType: 'historyUndo', from: 0, to: 0 });
  assert.strictEqual(r.applied, false);
  assert.match(r.why, /撤销重做/);
  assert.deepStrictEqual(txs, []);
});

test('普通 input 事件落一条事务，空 input 不落', () => {
  const { machine, txs } = setup();
  assert.strictEqual(machine.handle({ type: 'input', data: '', from: 0, to: 0 }).applied, false);
  machine.handle({ type: 'input', data: 'a\r\nb', from: 2, to: 2 });
  assert.deepStrictEqual(txs, [{ from: 2, to: 2, next: ['a', 'b'], reason: 'input' }]);
});

test('粘贴把 CRLF / 裸 CR 归一成 LF 再落一条事务', () => {
  const { machine, txs } = setup();
  const r = machine.handle({ type: 'paste', text: 'a\r\nb\rc', from: 3, to: 3 });
  assert.strictEqual(r.applied, true);
  assert.deepStrictEqual(txs, [{ from: 3, to: 3, next: ['a', 'b', 'c'], reason: 'paste' }]);
});

test('空粘贴不产出事务', () => {
  const { machine, txs } = setup();
  assert.strictEqual(machine.handle({ type: 'paste', text: '', from: 0, to: 0 }).applied, false);
  assert.strictEqual(machine.handle({ type: 'paste', text: null, from: 0, to: 0 }).applied, false);
  assert.deepStrictEqual(txs, []);
});

test('组合期间粘贴只排队，组合结果之后才在光标处补一条', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 2, to: 2 });
  const r = machine.handle({ type: 'paste', text: 'P', from: 2, to: 2 });
  assert.strictEqual(r.applied, false);
  assert.deepStrictEqual(machine.state.pending, ['P']);
  assert.deepStrictEqual(txs, []);
  machine.handle({ type: 'compositionend', from: 2, to: 2, data: '你' });
  assert.deepStrictEqual(txs, [
    { from: 2, to: 2, next: ['你'], reason: 'composition' },
    { from: 3, to: 3, next: ['P'], reason: 'paste-after-composition' },
  ]);
});

test('组合被取消（空结果）时，组合期间粘贴的内容照样补上', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 2, to: 2 });
  machine.handle({ type: 'paste', text: 'P', from: 2, to: 2 });
  const r = machine.handle({ type: 'compositionend', from: 5, to: 5, data: '' });
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.rebased, true);
  assert.deepStrictEqual(txs, [{ from: 5, to: 5, next: ['P'], reason: 'paste-after-composition' }]);
});

test('组合被取消且没有粘贴时什么事务都不落', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  const r = machine.handle({ type: 'compositionend', from: 0, to: 0, data: '' });
  assert.strictEqual(r.applied, false);
  assert.deepStrictEqual(txs, []);
});

test('Esc / 失焦取消组合：暂存的组合串丢掉，已粘贴的内容保留', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 2, to: 2 });
  machine.handle({ type: 'compositionupdate', data: '你' });
  const r = machine.handle({ type: 'cancel', from: 4, to: 4 });
  assert.strictEqual(r.applied, false);
  assert.strictEqual(machine.state.provisional, '');
  assert.strictEqual(machine.state.composing, false);
  assert.deepStrictEqual(txs, []);
});

test('取消时若组合期间粘贴过，按当前选区补一条独立事务', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'paste', text: 'P', from: 0, to: 0 });
  const r = machine.handle({ type: 'cancel', from: 3, to: 3 });
  assert.strictEqual(r.applied, true);
  assert.deepStrictEqual(txs, [{ from: 3, to: 3, next: ['P'], reason: 'paste-after-composition' }]);
});

test('组合目标已失效时丢弃暂存输入并标记 stale，不往旧偏移写', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 2, to: 2, target: 'A', revision: 'r1' });
  machine.handle({ type: 'paste', text: 'P', from: 2, to: 2 });
  const r = machine.handle({ type: 'compositionend', target: 'B', revision: 'r1', data: 'x' });
  assert.deepStrictEqual(r, { applied: false, stale: true, why: '组合目标已失效：丢弃暂存输入' });
  assert.deepStrictEqual(txs, []);
  assert.deepStrictEqual(machine.state.pending, []);
  assert.strictEqual(machine.state.session, null);
});

test('取消时目标已失效也丢弃暂存输入', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0, target: 'A', revision: null });
  machine.handle({ type: 'paste', text: 'P', from: 0, to: 0 });
  const r = machine.handle({ type: 'cancel', target: 'B' });
  assert.strictEqual(r.stale, true);
  assert.deepStrictEqual(txs, []);
});

test('目标或修订变了但给了当前选区：按当前选区落定并标记 rebased', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 2, to: 2, target: 'A', revision: 'r1' });
  const r = machine.handle({
    type: 'compositionend', from: 7, to: 8, target: 'A', revision: 'r2', data: '新',
  });
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.rebased, true);
  assert.deepStrictEqual(txs, [{ from: 7, to: 8, next: ['新'], reason: 'composition' }]);
});

test('没有当前区间时退回组合起手的区间', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 3, to: 4 });
  const r = machine.handle({ type: 'compositionend', data: 'x' });
  assert.strictEqual(r.rebased, false);
  assert.deepStrictEqual(txs, [{ from: 3, to: 4, next: ['x'], reason: 'composition' }]);
});

test('对象策略作用于每一个文本入口：组合、插入、input、粘贴', () => {
  const seen = [];
  const policy = {
    text: function (s) {
      seen.push(s);
      return s.replace(/\n/g, ' ');
    },
  };
  const { machine, txs } = setup(policy);
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'compositionend', from: 0, to: 0, data: 'a\r\nb' });
  machine.handle({ type: 'beforeinput', inputType: 'insertText', data: 'x\ny', from: 1, to: 1 });
  machine.handle({ type: 'input', data: 'p\nq', from: 2, to: 2 });
  machine.handle({ type: 'paste', text: 'm\r\nn', from: 3, to: 3 });
  assert.deepStrictEqual(seen, ['a\nb', 'x\ny', 'p\nq', 'm\nn']);
  assert.deepStrictEqual(txs.map(function (x) { return x.next; }), [
    ['a b'],
    ['x y'],
    ['p q'],
    ['m n'],
  ]);
});

test('caretAfterComposition 按 UTF-16 码元推进，表情算两个', () => {
  assert.strictEqual(I.caretAfterComposition(2, '你'), 3);
  assert.strictEqual(I.caretAfterComposition(2, '😀'), 4);
  assert.strictEqual(I.caretAfterComposition(5, null), 5);
});

function planOf(listLines) {
  return { listLines: listLines };
}

test('回车：有选区时是裸换行，不续列表', () => {
  assert.deepStrictEqual(I.lineBreakAction('- abc', planOf([
    { from: 0, contentFrom: 2, kind: 'bullet', marker: '-' },
  ]), 2, 5), { type: 'insert', data: '\n', from: 2, to: 5 });
});

test('回车：没有 plan 或不在列表行时一律裸换行', () => {
  assert.deepStrictEqual(I.lineBreakAction('plain', null, 2, 2), {
    type: 'insert', data: '\n', from: 2, to: 2,
  });
  assert.deepStrictEqual(I.lineBreakAction('plain', planOf([
    { from: 10, contentFrom: 12, kind: 'bullet', marker: '-' },
  ]), 2, 2), { type: 'insert', data: '\n', from: 2, to: 2 });
});

test('回车：无序项正文中间断成两项，新项带同样前缀', () => {
  assert.deepStrictEqual(I.lineBreakAction('- abc', planOf([
    { from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-' },
  ]), 3, 3), { type: 'insert', data: '\n- ', from: 3, to: 3 });
});

test('回车：有序项把编号换成下一个，标点与空白原样保留', () => {
  assert.deepStrictEqual(I.lineBreakAction('3. abc', planOf([
    { from: 0, contentFrom: 3, depth: 0, kind: 'ordered', marker: '3.' },
  ]), 4, 4), { type: 'insert', data: '\n4. ', from: 4, to: 4 });
  assert.deepStrictEqual(I.lineBreakAction('7) abc', planOf([
    { from: 0, contentFrom: 3, depth: 0, kind: 'ordered', marker: '7)' },
  ]), 4, 4), { type: 'insert', data: '\n8) ', from: 4, to: 4 });
});

test('回车：任务项的新项总是空框，已勾选与未勾选一致', () => {
  assert.deepStrictEqual(I.lineBreakAction('- [x] done', planOf([
    { from: 0, contentFrom: 6, depth: 0, kind: 'task', marker: '- ', checked: true },
  ]), 7, 7), { type: 'insert', data: '\n- [ ] ', from: 7, to: 7 });
  assert.deepStrictEqual(I.lineBreakAction('- [ ] done', planOf([
    { from: 0, contentFrom: 6, depth: 0, kind: 'task', marker: '- ', checked: false },
  ]), 7, 7), { type: 'insert', data: '\n- [ ] ', from: 7, to: 7 });
});

test('回车：空 item 删掉标记退回正文', () => {
  assert.deepStrictEqual(I.lineBreakAction('- ', planOf([
    { from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-' },
  ]), 2, 2), { type: 'delete', data: '', from: 0, to: 2 });
  assert.deepStrictEqual(I.lineBreakAction('-   ', planOf([
    { from: 0, contentFrom: 4, depth: 0, kind: 'bullet', marker: '-' },
  ]), 4, 4), { type: 'delete', data: '', from: 0, to: 4 });
});

test('回车：光标落在隐藏标记区时收敛到正文起点，不劈开标记', () => {
  assert.deepStrictEqual(I.lineBreakAction('- abc', planOf([
    { from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-' },
  ]), 1, 1), { type: 'insert', data: '\n- ', from: 2, to: 2 });
});

test('回车：光标落在行尾空白里时收敛到行末，空白留在原行', () => {
  assert.deepStrictEqual(I.lineBreakAction('- a  ', planOf([
    { from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-' },
  ]), 5, 5), { type: 'insert', data: '\n- ', from: 5, to: 5 });
});

test('回车：续行（plain）续出**所属列表项**的前缀（⛔ 不是裸换行）', () => {
  assert.deepStrictEqual(I.lineBreakAction('- a\n  b', planOf([
    { from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-', code: false },
    { from: 4, contentFrom: 6, depth: 0, kind: 'plain', marker: '', code: false },
  ]), 7, 7), { type: 'insert', data: '\n- ', from: 7, to: 7 });
  // 反面：找不到所属项的续行（块里前面没有列表项）仍退回裸换行。
  assert.deepStrictEqual(I.lineBreakAction('  b', planOf([
    { from: 0, contentFrom: 2, depth: 0, kind: 'plain', marker: '', code: false },
  ]), 3, 3), { type: 'insert', data: '\n', from: 3, to: 3 });
});

test('回车：光标越过行末、或列表记录的 contentFrom 不可信时退回裸换行', () => {
  assert.deepStrictEqual(I.lineBreakAction('- abc', planOf([
    { from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-' },
  ]), 6, 6), { type: 'insert', data: '\n', from: 6, to: 6 });
  assert.deepStrictEqual(I.lineBreakAction('- abc', planOf([
    { from: 0, contentFrom: 0, depth: 0, kind: 'bullet', marker: '-' },
  ]), 2, 2), { type: 'insert', data: '\n', from: 2, to: 2 });
});

test('回车：第二行列表项按第二行的行首匹配，不受首行影响', () => {
  assert.deepStrictEqual(I.lineBreakAction('a\n- b', planOf([
    { from: 2, contentFrom: 4, depth: 0, kind: 'bullet', marker: '-' },
  ]), 5, 5), { type: 'insert', data: '\n- ', from: 5, to: 5 });
});

test('回车：列表项正文中间（非行尾空白）保留光标后的内容在新项里', () => {
  assert.deepStrictEqual(I.lineBreakAction('- abcd', planOf([
    { from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-' },
  ]), 4, 4), { type: 'insert', data: '\n- ', from: 4, to: 4 });
});
