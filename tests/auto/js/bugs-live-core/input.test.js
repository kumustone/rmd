// 编辑内核 · 输入状态机与回车落点。
// 从 `docs/bugs/` 的 0015/0033/0035/0061/0062/0063/0079/0081/0108/0110 倒推：
// CRLF 归一、组合会话只在结束落一条、重复 insert 按内容吞、组合期粘贴不丢、回车续列表。
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

function planOf(listLines) {
  return { listLines: listLines };
}

// 源自 docs/bugs/0081（假后端不归一化行尾和BOM导致探针假红）
// 同轴向：CRLF / 裸 CR 必须在这里归一成 LF，其余字节一个不动。
test('normalizeNewlines 把 CRLF 与裸 CR 都归成 LF，其余字节不动', () => {
  assert.strictEqual(I.normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.strictEqual(I.normalizeNewlines('a\r\r\nb'), 'a\n\nb');
  assert.strictEqual(I.normalizeNewlines(' a \t'), ' a \t');
});

test('normalizeNewlines 对 null / undefined / 数字归一，不 trim', () => {
  assert.strictEqual(I.normalizeNewlines(null), '');
  assert.strictEqual(I.normalizeNewlines(undefined), '');
  assert.strictEqual(I.normalizeNewlines(12), '12');
  assert.strictEqual(I.normalizeNewlines('　x　'), '　x　');
});

test('normalizeNewlines 不动 BOM，也不折叠全角空格', () => {
  assert.strictEqual(I.normalizeNewlines('﻿a\r\nb'), '﻿a\nb');
  assert.strictEqual(I.normalizeNewlines('a　　b'), 'a　　b');
});

test('linesOf 先归一化再按 LF 切行，末尾空行保留', () => {
  assert.deepStrictEqual(I.linesOf('a\r\nb\r'), ['a', 'b', '']);
  assert.deepStrictEqual(I.linesOf(''), ['']);
  assert.deepStrictEqual(I.linesOf(null), ['']);
});

test('isComposingEvent 用自己的组合标志优先，不依赖 Safari 的 isComposing', () => {
  assert.strictEqual(I.isComposingEvent({ isComposing: false }, { composing: true }), true);
  assert.strictEqual(I.isComposingEvent({ isComposing: true }, { composing: false }), true);
  assert.strictEqual(I.isComposingEvent({}, { composing: false }), false);
  assert.strictEqual(I.isComposingEvent({ isComposing: 'true' }, { composing: false }), false);
});

// 源自 docs/bugs/0060（拼音与正文叠字）
// 同轴向：组合期间文档一个字节都不动，只更新临时态给装饰层画 preedit。
test('输入机初始态：不在组合、没有会话 / 待吞 / 待补', () => {
  const { machine } = setup();
  assert.deepStrictEqual(machine.state, {
    composing: false, start: 0, end: 0, provisional: '', session: null, swallow: null, pending: [],
  });
});

test('组合开始记下区间与会话，不产出任何文本事务', () => {
  const { machine, txs } = setup();
  const r = machine.handle({ type: 'compositionstart', from: 2, to: 4, target: 't1', revision: 'r1' });
  assert.strictEqual(r.applied, false);
  assert.deepStrictEqual(machine.state.session, { from: 2, to: 4, target: 't1', revision: 'r1' });
  assert.strictEqual(machine.state.composing, true);
  assert.deepStrictEqual(txs, []);
});

test('组合开始缺 target / revision 时记 null，并清掉上一轮待吞', () => {
  const { machine } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'compositionend', from: 0, to: 0, data: 'x' });
  assert.strictEqual(machine.state.swallow, 'x');
  machine.handle({ type: 'compositionstart', from: 3, to: 3 });
  assert.deepStrictEqual(machine.state.session, { from: 3, to: 3, target: null, revision: null });
  assert.strictEqual(machine.state.swallow, null);
});

test('不在组合态时 compositionupdate / compositionend 都忽略', () => {
  const { machine, txs } = setup();
  assert.strictEqual(machine.handle({ type: 'compositionupdate', data: 'x' }).applied, false);
  assert.strictEqual(machine.handle({ type: 'compositionend', data: 'x' }).applied, false);
  assert.deepStrictEqual(txs, []);
});

test('compositionupdate 只更新临时态，文档零事务', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  const r = machine.handle({ type: 'compositionupdate', data: '你' });
  assert.strictEqual(r.applied, false);
  assert.strictEqual(machine.state.provisional, '你');
  assert.deepStrictEqual(txs, []);
});

test('compositionupdate 的空 data 把临时态清成空串', () => {
  const { machine } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'compositionupdate', data: '你' });
  machine.handle({ type: 'compositionupdate', data: null });
  assert.strictEqual(machine.state.provisional, '');
});

test('组合结束只落一条事务，区间取当前选区并记下待吞文本', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 2, to: 4 });
  const r = machine.handle({ type: 'compositionend', from: 2, to: 4, data: '你好' });
  assert.deepStrictEqual(r, { applied: true, rebased: false, why: '组合结束：落一条事务' });
  assert.deepStrictEqual(txs, [{ from: 2, to: 4, next: ['你好'], reason: 'composition' }]);
  assert.strictEqual(machine.state.swallow, '你好');
  assert.strictEqual(machine.state.session, null);
  assert.strictEqual(machine.state.provisional, '');
});

test('组合结果里的 CRLF / 裸 CR 也归一化并切成多行', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'compositionend', from: 0, to: 0, data: 'a\r\nb\rc' });
  assert.deepStrictEqual(txs[0].next, ['a', 'b', 'c']);
});

test('组合结果是全角字符 / emoji 时原样落一条，按码元计长度', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 1, to: 1 });
  machine.handle({ type: 'compositionend', from: 1, to: 1, data: '　😀' });
  assert.deepStrictEqual(txs, [{ from: 1, to: 1, next: ['　😀'], reason: 'composition' }]);
  assert.strictEqual(I.caretAfterComposition(1, '　😀'), 4);
});

// 源自 docs/bugs/0063（组合去重标记跨动作吞掉真实输入）
// 同轴向：只有"类型是 insert 且内容逐字相同"的那一发才吞，且只吞一发。
test('组合结束后的重复 beforeinput 按内容逐字吞掉，只吞一发', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'compositionend', from: 0, to: 0, data: '词' });
  assert.strictEqual(machine.handle({ type: 'beforeinput', inputType: 'insertText', data: '词' }).applied, false);
  assert.strictEqual(machine.state.swallow, null);
  assert.strictEqual(machine.handle({ type: 'beforeinput', inputType: 'insertText', data: '词', from: 1, to: 1 }).applied, true);
  assert.strictEqual(txs.length, 2);
});

test('重复 input 事件同样按内容吞掉，只吞一发', () => {
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
  assert.strictEqual(machine.handle({ type: 'beforeinput', inputType: 'insertText', data: 'y', from: 1, to: 1 }).applied, true);
  assert.strictEqual(machine.state.swallow, null);
  assert.strictEqual(machine.handle({ type: 'beforeinput', inputType: 'insertText', data: 'x', from: 2, to: 2 }).applied, true);
  assert.strictEqual(txs.length, 3);
});

test('删除、撤销、格式等其它动作都会结束待吞，不跨动作存活', () => {
  for (const ev of [
    { type: 'beforeinput', inputType: 'deleteContentBackward', from: 0, to: 1 },
    { type: 'beforeinput', inputType: 'historyUndo' },
    { type: 'beforeinput', inputType: 'historyRedo' },
    { type: 'beforeinput', inputType: 'formatBold', from: 0, to: 1 },
    { type: 'paste', text: 'P', from: 0, to: 0 },
    { type: 'cancel' },
  ]) {
    const { machine } = setup();
    machine.handle({ type: 'compositionstart', from: 0, to: 0 });
    machine.handle({ type: 'compositionend', from: 0, to: 0, data: 'x' });
    machine.handle(ev);
    assert.strictEqual(machine.state.swallow, null, ev.inputType || ev.type);
  }
});

test('空插入不产出事务，也不清掉待吞', () => {
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

test('insert / delete 前缀分派：insertParagraph 是插入，deleteByCut 是删除', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'beforeinput', inputType: 'insertParagraph', data: 'x', from: 0, to: 0 });
  machine.handle({ type: 'beforeinput', inputType: 'deleteByCut', from: 0, to: 1 });
  assert.deepStrictEqual(txs.map((t) => t.reason), ['insert', 'delete']);
});

test('撤销重做由我们分派，不交给浏览器，也不产出事务', () => {
  const { machine, txs } = setup();
  const r = machine.handle({ type: 'beforeinput', inputType: 'historyUndo', from: 0, to: 0 });
  assert.strictEqual(r.applied, false);
  assert.match(r.why, /撤销重做/);
  assert.deepStrictEqual(txs, []);
});

test('未处理的 inputType 不动文本，并说明原因', () => {
  const { machine, txs } = setup();
  const r = machine.handle({ type: 'beforeinput', inputType: 'formatBold', from: 0, to: 1 });
  assert.strictEqual(r.applied, false);
  assert.match(r.why, /未处理的 inputType/);
  assert.deepStrictEqual(txs, []);
});

test('普通 input 事件落一条事务，空 input 不落', () => {
  const { machine, txs } = setup();
  assert.strictEqual(machine.handle({ type: 'input', data: '', from: 0, to: 0 }).applied, false);
  machine.handle({ type: 'input', data: 'a\r\nb', from: 2, to: 2 });
  assert.deepStrictEqual(txs, [{ from: 2, to: 2, next: ['a', 'b'], reason: 'input' }]);
});

test('只含裸 CR 的 input 归一成一个换行后照常落事务', () => {
  const { machine, txs } = setup();
  assert.strictEqual(machine.handle({ type: 'input', data: '\r', from: 0, to: 0 }).applied, true);
  assert.deepStrictEqual(txs, [{ from: 0, to: 0, next: ['', ''], reason: 'input' }]);
});

test('粘贴把 CRLF / 裸 CR 归一成 LF 再落一条事务', () => {
  const { machine, txs } = setup();
  const r = machine.handle({ type: 'paste', text: 'a\r\nb\rc', from: 3, to: 3 });
  assert.strictEqual(r.applied, true);
  assert.deepStrictEqual(txs, [{ from: 3, to: 3, next: ['a', 'b', 'c'], reason: 'paste' }]);
});

test('空粘贴 / null 粘贴不产出事务；只含换行的粘贴照常落一个换行', () => {
  const { machine, txs } = setup();
  assert.strictEqual(machine.handle({ type: 'paste', text: '', from: 0, to: 0 }).applied, false);
  assert.strictEqual(machine.handle({ type: 'paste', text: null, from: 0, to: 0 }).applied, false);
  assert.deepStrictEqual(txs, []);
  assert.strictEqual(machine.handle({ type: 'paste', text: '\r\n', from: 0, to: 0 }).applied, true);
  assert.deepStrictEqual(txs, [{ from: 0, to: 0, next: ['', ''], reason: 'paste' }]);
});

// 源自 docs/bugs/0061（组合期间粘贴的内容在空组合结束后丢失）
// 同轴向：组合期粘贴先排队，组合结束后按"先上屏、后粘贴"两条事务补上。
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

test('组合期间多次粘贴按顺序拼接成一条补发事务，换行也归一', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'paste', text: 'A\r\n', from: 0, to: 0 });
  machine.handle({ type: 'paste', text: 'B', from: 0, to: 0 });
  assert.deepStrictEqual(machine.state.pending, ['A\n', 'B']);
  machine.handle({ type: 'compositionend', from: 0, to: 0, data: '字' });
  assert.deepStrictEqual(txs[1], { from: 1, to: 1, next: ['A', 'B'], reason: 'paste-after-composition' });
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

// 源自 docs/bugs/0062（组合取消且目标失效时暂存粘贴写到旧偏移）
// 同轴向：目标文本没了就没有"当前位置"可写，丢弃并标记 stale。
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

test('目标变更但给出当前选区时按当前选区落定并标记 rebased', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 2, to: 2, target: 'A', revision: 'r1' });
  const r = machine.handle({ type: 'compositionend', from: 7, to: 8, target: 'A', revision: 'r2', data: '新' });
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.rebased, true);
  assert.deepStrictEqual(txs, [{ from: 7, to: 8, next: ['新'], reason: 'composition' }]);
});

test('修订号只在两边都给时才比较，缺省不误判 rebased', () => {
  const { machine } = setup();
  machine.handle({ type: 'compositionstart', from: 2, to: 2, target: 'A', revision: 'r1' });
  const a = machine.handle({ type: 'compositionend', from: 2, to: 2, data: 'x' });
  assert.strictEqual(a.rebased, false);
  const b = (function () {
    const s = setup();
    s.machine.handle({ type: 'compositionstart', from: 2, to: 2, target: 'A', revision: 'r1' });
    return s.machine.handle({ type: 'compositionend', from: 2, to: 2, target: 'A', data: 'x' });
  })();
  assert.strictEqual(b.rebased, false);
});

test('没有当前区间时退回组合起手的区间，不谎报 rebased', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 3, to: 4 });
  const r = machine.handle({ type: 'compositionend', data: 'x' });
  assert.strictEqual(r.rebased, false);
  assert.deepStrictEqual(txs, [{ from: 3, to: 4, next: ['x'], reason: 'composition' }]);
});

test('当前区间与起手区间不同但 target 未变，也算 rebased（偏移已变）', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 3, to: 3 });
  const r = machine.handle({ type: 'compositionend', from: 9, to: 9, data: 'x' });
  assert.strictEqual(r.rebased, true);
  assert.strictEqual(txs[0].from, 9);
});

// 源自 docs/bugs/0062（同上：取消路径）
// 同轴向：Esc / 失焦取消组合，暂存组合串丢掉，已粘贴的内容按当前选区保留。
test('Esc / 失焦取消组合：暂存组合串丢掉，没有粘贴就不落事务', () => {
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

test('取消时目标已失效也丢弃暂存输入', () => {
  const { machine, txs } = setup();
  machine.handle({ type: 'compositionstart', from: 0, to: 0, target: 'A' });
  machine.handle({ type: 'paste', text: 'P', from: 0, to: 0 });
  const r = machine.handle({ type: 'cancel', target: 'B' });
  assert.strictEqual(r.stale, true);
  assert.deepStrictEqual(txs, []);
});

test('不在组合态时 cancel 说明"不在组合态"，不落事务', () => {
  const { machine, txs } = setup();
  const r = machine.handle({ type: 'cancel' });
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.why, '不在组合态');
  assert.deepStrictEqual(txs, []);
});

// 源自 docs/bugs/0033（格内 shift-enter 能插进真实换行）/ 0035（格内回车无法换行）
// 同轴向：对象策略作用于每一个文本入口，格内把换行折成软换行。
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
  assert.deepStrictEqual(txs.map((x) => x.next), [['a b'], ['x y'], ['p q'], ['m n']]);
});

test('对象策略在行尾归一化之后才执行，不会留下裸 CR', () => {
  const seen = [];
  const policy = { text: function (s) { seen.push(s); return s; } };
  const { machine } = setup(policy);
  machine.handle({ type: 'compositionstart', from: 0, to: 0 });
  machine.handle({ type: 'compositionend', from: 0, to: 0, data: 'a\r\nb' });
  assert.deepStrictEqual(seen, ['a\nb']);
});

test('对象策略返回非字符串时按 String 归一', () => {
  const { machine, txs } = setup({ text: function () { return 42; } });
  machine.handle({ type: 'input', data: 'x', from: 0, to: 0 });
  assert.deepStrictEqual(txs[0].next, ['42']);
});

test('caretAfterComposition 按 UTF-16 码元推进，表情算两个', () => {
  assert.strictEqual(I.caretAfterComposition(2, '你'), 3);
  assert.strictEqual(I.caretAfterComposition(2, '😀'), 4);
  assert.strictEqual(I.caretAfterComposition(5, null), 5);
  assert.strictEqual(I.caretAfterComposition(0, '　'), 1);
});

test('未知事件类型不落事务，并说明未处理', () => {
  const { machine, txs } = setup();
  const r = machine.handle({ type: 'keydown' });
  assert.strictEqual(r.applied, false);
  assert.match(r.why, /未处理的事件/);
  assert.deepStrictEqual(txs, []);
});

// 源自 docs/bugs/0108（列表项行尾回车不再续列表标记）
// 同轴向：有选区回车是替换，不续列表；无选区才按列表品种续行。
test('回车：有选区时是裸换行，不续列表', () => {
  assert.deepStrictEqual(I.lineBreakAction('- abc', planOf([
    { from: 0, contentFrom: 2, kind: 'bullet', marker: '-' },
  ]), 2, 5), { type: 'insert', data: '\n', from: 2, to: 5 });
});

test('回车：没有 plan 或不在列表行时一律裸换行', () => {
  assert.deepStrictEqual(I.lineBreakAction('plain', null, 2, 2), { type: 'insert', data: '\n', from: 2, to: 2 });
  assert.deepStrictEqual(I.lineBreakAction('plain', planOf([]), 2, 2), { type: 'insert', data: '\n', from: 2, to: 2 });
  assert.deepStrictEqual(I.lineBreakAction('plain', planOf([
    { from: 10, contentFrom: 12, kind: 'bullet', marker: '-' },
  ]), 2, 2), { type: 'insert', data: '\n', from: 2, to: 2 });
});

test('回车：无序项正文中间断成两项，新项带同样前缀', () => {
  assert.deepStrictEqual(I.lineBreakAction('- abc', planOf([
    { from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-' },
  ]), 3, 3), { type: 'insert', data: '\n- ', from: 3, to: 3 });
});

test('回车：有序项把编号换成下一个，9 之后是 10，标点不变', () => {
  assert.deepStrictEqual(I.lineBreakAction('3. abc', planOf([
    { from: 0, contentFrom: 3, kind: 'ordered', marker: '3.' },
  ]), 4, 4), { type: 'insert', data: '\n4. ', from: 4, to: 4 });
  assert.deepStrictEqual(I.lineBreakAction('9. abc', planOf([
    { from: 0, contentFrom: 3, kind: 'ordered', marker: '9.' },
  ]), 4, 4), { type: 'insert', data: '\n10. ', from: 4, to: 4 });
  assert.deepStrictEqual(I.lineBreakAction('7) abc', planOf([
    { from: 0, contentFrom: 3, kind: 'ordered', marker: '7)' },
  ]), 4, 4), { type: 'insert', data: '\n8) ', from: 4, to: 4 });
});

test('回车：任务项的新项总是空框，已勾选与未勾选一致', () => {
  for (const sym of ['x', 'X', ' ']) {
    const src = '- [' + sym + '] done';
    assert.deepStrictEqual(I.lineBreakAction(src, planOf([
      { from: 0, contentFrom: 6, depth: 0, kind: 'task', marker: '- ', checked: sym === ' ' ? false : true },
    ]), 7, 7), { type: 'insert', data: '\n- [ ] ', from: 7, to: 7 }, src);
  }
});

// 源自 docs/bugs/0079（新起一段后每按一次多留一行空行）
// 同轴向：空 item 上回车应删掉标记退回正文，而不是插换行再留空项。
test('回车：空 item 删掉整条标记退回正文（含多个尾随空格）', () => {
  assert.deepStrictEqual(I.lineBreakAction('- ', planOf([
    { from: 0, contentFrom: 2, kind: 'bullet', marker: '-' },
  ]), 2, 2), { type: 'delete', data: '', from: 0, to: 2 });
  assert.deepStrictEqual(I.lineBreakAction('-   ', planOf([
    { from: 0, contentFrom: 4, kind: 'bullet', marker: '-' },
  ]), 4, 4), { type: 'delete', data: '', from: 0, to: 4 });
  assert.deepStrictEqual(I.lineBreakAction('- [ ] ', planOf([
    { from: 0, contentFrom: 6, kind: 'task', marker: '- ' },
  ]), 6, 6), { type: 'delete', data: '', from: 0, to: 6 });
});

test('回车：光标落在隐藏标记区时收敛到正文起点，不劈开标记', () => {
  assert.deepStrictEqual(I.lineBreakAction('- abc', planOf([
    { from: 0, contentFrom: 2, kind: 'bullet', marker: '-' },
  ]), 1, 1), { type: 'insert', data: '\n- ', from: 2, to: 2 });
});

test('回车：光标落在行尾空白里时收敛到行末，空白留在原行', () => {
  assert.deepStrictEqual(I.lineBreakAction('- a  ', planOf([
    { from: 0, contentFrom: 2, kind: 'bullet', marker: '-' },
  ]), 5, 5), { type: 'insert', data: '\n- ', from: 5, to: 5 });
  assert.deepStrictEqual(I.lineBreakAction('- a\t', planOf([
    { from: 0, contentFrom: 2, kind: 'bullet', marker: '-' },
  ]), 4, 4), { type: 'insert', data: '\n- ', from: 4, to: 4 });
});

test('回车：续行（plain）续出**所属列表项**的前缀（⛔ 不是裸换行）', () => {
  assert.deepStrictEqual(I.lineBreakAction('- a\n  b', planOf([
    { from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-', code: false },
    { from: 4, contentFrom: 6, depth: 0, kind: 'plain', marker: '', code: false },
  ]), 7, 7), { type: 'insert', data: '\n- ', from: 7, to: 7 });
  // 反面：块里前面没有列表项 ⇒ 找不到所属项 ⇒ 裸换行。
  assert.deepStrictEqual(I.lineBreakAction('  b', planOf([
    { from: 0, contentFrom: 2, depth: 0, kind: 'plain', marker: '', code: false },
  ]), 3, 3), { type: 'insert', data: '\n', from: 3, to: 3 });
});

test('回车：光标越过行末、或列表记录 contentFrom 不可信时退回裸换行', () => {
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

// 源自 docs/bugs/0110（已写好的列表项正文中间回车退成正文）
// 同轴向：正文中间回车必须续列表，而不是把后半段降级成普通段落。
test('回车：列表项正文中间保留光标后的内容在新项里', () => {
  assert.deepStrictEqual(I.lineBreakAction('- abcd', planOf([
    { from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-' },
  ]), 4, 4), { type: 'insert', data: '\n- ', from: 4, to: 4 });
});

test('回车：嵌套列表保留缩进，新项同深度', () => {
  assert.deepStrictEqual(I.lineBreakAction('  - x', planOf([
    { from: 0, contentFrom: 4, depth: 1, kind: 'bullet', marker: '-' },
  ]), 5, 5), { type: 'insert', data: '\n  - ', from: 5, to: 5 });
});

test('回车：引用块里的有序列表保留 > 前缀并递增编号', () => {
  assert.deepStrictEqual(I.lineBreakAction('> 2. x', planOf([
    { from: 0, contentFrom: 5, depth: 0, kind: 'ordered', marker: '2.' },
  ]), 6, 6), { type: 'insert', data: '\n> 3. ', from: 6, to: 6 });
});

test('回车：引用块里的任务项保留 > 前缀，新框总是空的', () => {
  assert.deepStrictEqual(I.lineBreakAction('> - [x] y', planOf([
    { from: 0, contentFrom: 8, depth: 0, kind: 'task', marker: '- ' },
  ]), 9, 9), { type: 'insert', data: '\n> - [ ] ', from: 9, to: 9 });
});

test('回车：空串 / 单列表标记行从行首回车也走同一分支', () => {
  assert.deepStrictEqual(I.lineBreakAction('', null, 0, 0), { type: 'insert', data: '\n', from: 0, to: 0 });
  assert.deepStrictEqual(I.lineBreakAction('- x', planOf([
    { from: 0, contentFrom: 2, kind: 'bullet', marker: '-' },
  ]), 0, 0), { type: 'insert', data: '\n- ', from: 2, to: 2 });
});

test('回车：空 item 的判定看正文段，不把只有空格的正文当内容', () => {
  assert.deepStrictEqual(I.lineBreakAction('-    ', planOf([
    { from: 0, contentFrom: 5, kind: 'bullet', marker: '-' },
  ]), 5, 5), { type: 'delete', data: '', from: 0, to: 5 });
});

test('回车：正文行的行中回车与行尾回车都是裸换行', () => {
  assert.deepStrictEqual(I.lineBreakAction('abcdef', null, 3, 3), { type: 'insert', data: '\n', from: 3, to: 3 });
  assert.deepStrictEqual(I.lineBreakAction('abcdef', null, 6, 6), { type: 'insert', data: '\n', from: 6, to: 6 });
});

test('回车：多个列表行时只按当前行的计划记录续行', () => {
  const plan = planOf([
    { from: 0, contentFrom: 2, kind: 'bullet', marker: '-' },
    { from: 4, contentFrom: 7, kind: 'ordered', marker: '1.' },
  ]);
  assert.deepStrictEqual(I.lineBreakAction('- a\n1. b', plan, 7, 7), { type: 'insert', data: '\n2. ', from: 7, to: 7 });
});
