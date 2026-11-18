// 历史缺陷的组合回归：0020/0032/0035/0040/0047，以及 10-29 输入层评审。
// 只调用产品模块；完整文本快照作历史 oracle，不复制产品的逆向区间算法。
// 真 IME、DOM 几何、系统剪贴板不在这份 Node 测试的证明范围内。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const M = require('../../src/live/model.js');
const C = require('../../src/live/cell.js');
const I = require('../../src/live/input.js');
const T = require('../../src/live/txn.js');

function historySequence(api, seed, steps) {
  let random = seed >>> 0;
  const pick = n => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random % n;
  };
  const words = ['中', '😀', 'e\u0301', '', '|', '<br>', '\\', '尾'];
  const session = api.createSession({ text: '中\n😀\n', docSeq: 17, generation: 3, realPath: '/r/a.md', limit: 8 });
  let text = '中\n😀\n';
  const done = [];
  const undone = [];
  let revision = 0;
  for (let step = 0; step < steps; step++) {
    const action = pick(5);
    if (action < 3) {
      const rows = text.split('\n');
      const from = pick(rows.length + 1);
      const to = from + pick(rows.length - from + 1);
      const next = Array.from({ length: 1 + pick(3) }, () => words[pick(words.length)]);
      const before = text;
      // oracle 用完整前后文本记账，而不是重放产品记录的 range。
      rows.splice(from, to - from, ...next);
      text = rows.join('\n');
      done.push({ before, after: text });
      if (done.length > 8) done.shift();
      undone.length = 0;
      session.commit({ from, to }, next);
      revision++;
    } else if (action === 3) {
      const entry = done.pop();
      const result = session.undoEdit();
      if (entry) {
        text = entry.before;
        undone.push(entry);
        revision++;
        assert.ok(result);
      } else assert.equal(result, null);
    } else {
      const entry = undone.pop();
      const result = session.redo();
      if (entry) {
        text = entry.after;
        done.push(entry);
        revision++;
        assert.ok(result);
      } else assert.equal(result, null);
    }
    const at = `seed=${seed}, step=${step}, action=${action}`;
    assert.equal(session.fullText(), text, at);
    assert.equal(session.lineCount(), text.split('\n').length, at);
    assert.equal(session.stack().size(), done.length, at);
    assert.equal(session.stack().redoSize(), undone.length, at);
    assert.equal(session.identity().commitSeq, revision, at);
  }
}

const historySeeds = [1, 23, 0xc0ffee, ...Array.from({ length: 17 }, (_, i) => Math.imul(i + 1, 0x9e3779b1) >>> 0)];
for (const seed of historySeeds) {
  test(`0020：变行数/末尾空行/Unicode/历史容量交错，固定种子 ${seed}`, () => {
    historySequence(M, seed, 750);
  });
}

test('0020：失败提交回滚必须恢复原有重做条目内容，不只恢复深度', () => {
  const s = M.createSession({ text: '原\n尾\n', docSeq: 1 });
  s.commit({ from: 0, to: 1 }, ['甲', '乙']);
  s.commit({ from: 2, to: 3 }, ['后']);
  s.undoEdit();
  const before = s.fullText();
  const identity = { ...s.identity() };
  const failed = s.commit({ from: 0, to: 2 }, ['失败候选']);
  assert.equal(failed.revert({ txId: failed.txId, revision: failed.revision }).ok, true);
  assert.equal(s.fullText(), before);
  assert.deepEqual(s.identity(), identity);
  assert.equal(s.redo().fullText, '甲\n乙\n后\n');
  assert.equal(s.undoEdit().fullText, before);
  assert.equal(s.undoEdit().fullText, '原\n尾\n');
});

test('历史越界：拒绝非法行区间不能污染全文、身份和原有重做内容', () => {
  const s = M.createSession({ text: '原\n😀\n', docSeq: 1 });
  s.commit({ from: 0, to: 1 }, ['新']);
  s.undoEdit();
  const snapshot = structuredClone(s.snapshot());
  for (const range of [
    { from: -1, to: 1 }, { from: 0, to: 99 },
    { from: 2, to: 1 }, { from: 0.5, to: 1 },
  ]) {
    assert.throws(() => s.commit(range, ['不应写入']));
    assert.deepEqual(s.snapshot(), snapshot);
  }
  assert.equal(s.redo().fullText, '新\n😀\n');
});

const noEditRaws = ['a<br />b', 'a<BR>b', 'a<br/>b', '`<br>`', 'a\\|b', '甲😀', 'a\\<br>b'];
for (const raw of noEditRaws) {
  test(`0040：Unicode 邻格前后，无操作保留原始表示 ${JSON.stringify(raw)}`, () => {
    const left = '| 左😀 | ';
    const right = ' | 右e\u0301 |';
    const line = left + raw + right;
    const binding = C.bind({ raw, from: left.length, to: left.length + raw.length });
    const snapshot = structuredClone(binding);
    const out = C.judge(binding, line, binding.initialView);
    assert.equal(out.status, 'unchanged');
    assert.deepEqual(binding, snapshot, '判定不能悄悄更新 raw 或初始文本');
    assert.equal(line, left + raw + right);
  });
}

const cellCases = [
  ['', ''], ['甲😀', '甲😀'], ['a|b', 'a\\|b'],
  ['甲\n乙', '甲<br>乙'], ['😀|e\u0301', '😀\\|e\u0301'], ['尾\\', '尾\\'],
];
test('0032/0035/0047：可表示编辑保留左右邻格，发布后重进、第二次退出收敛', () => {
  for (const [view, encoded] of cellCases) {
    const left = '| 左😀 | ';
    const right = '|右e\u0301|';
    const binding = C.bind({ raw: 'old', from: left.length, to: left.length + 3 });
    const out = C.judge(binding, left + 'old' + right, view);
    assert.equal(out.status, 'valid', JSON.stringify(view));
    assert.equal(out.encoded, encoded);
    assert.equal(out.nextLine, left + encoded + (view.endsWith('\\') ? ' ' : '') + right);
    const reopened = C.bind({ raw: encoded, from: left.length, to: left.length + encoded.length });
    assert.equal(reopened.initialView, view);
    assert.equal(C.judge(reopened, out.nextLine, view).status, 'unchanged');
  }
});

test('0047：不可表示输入不得吞成 unchanged，也不得改写绑定快照', () => {
  const binding = C.bind({ raw: 'a\\|b', from: 1, to: 5 });
  const before = structuredClone(binding);
  for (const view of ['a\\|b', '<br>', 'a\\\nb']) {
    const out = C.judge(binding, '|a\\|b|', view);
    assert.equal(out.status, 'rejected', JSON.stringify(view));
    assert.equal(out.why, 'inexpressible');
    assert.deepEqual(binding, before);
  }
  assert.equal(C.judge(binding, '|a\\|b|', '改好').status, 'valid', '拒绝后允许继续修正');
});

function inputScene() {
  const edits = [];
  const machine = I.createInputMachine(tx => edits.push(tx));
  return { machine, edits };
}

test('输入历史弱点：空 compositionend 取消仍须保留已粘贴内容并清空队列', () => {
  const { machine: m, edits } = inputScene();
  m.handle({ type: 'compositionstart', from: 2, to: 2 });
  m.handle({ type: 'paste', text: '已粘贴' });
  m.handle({ type: 'compositionend', data: '', from: 2, to: 2 });
  assert.deepEqual(edits.map(x => [x.from, x.to, x.next]), [[2, 2, ['已粘贴']]]);
  assert.deepEqual(m.state.pending, []);
  m.handle({ type: 'compositionstart', from: 9, to: 9 });
  m.handle({ type: 'compositionend', data: '新' });
  assert.deepEqual(edits.map(x => x.next), [['已粘贴'], ['新']], '旧粘贴不能跟到下次组合');
});

test('输入历史弱点：组合目标已失效，cancel 不得把暂存粘贴写进新目标', () => {
  const { machine: m, edits } = inputScene();
  m.handle({ type: 'compositionstart', from: 2, to: 2, target: { id: 'old' } });
  m.handle({ type: 'paste', text: '旧粘贴' });
  m.handle({ type: 'cancel', target: { id: 'new' } });
  assert.deepEqual(edits, [], '不能向已失效的目标偏移发事务');
  assert.deepEqual(m.state.pending, []);
});

for (const intervening of [
  { type: 'paste', text: 'P', from: 1, to: 1 },
  { type: 'beforeinput', inputType: 'deleteContentBackward', from: 0, to: 1 },
]) {
  test(`输入历史弱点：${intervening.type}/${intervening.inputType || ''} 之后相同文字是真输入`, () => {
    const { machine: m, edits } = inputScene();
    m.handle({ type: 'compositionstart', from: 0, to: 0 });
    m.handle({ type: 'compositionend', data: '字' });
    m.handle(intervening);
    const before = edits.length;
    const out = m.handle({ type: 'input', data: '字', from: 2, to: 2 });
    assert.equal(out.applied, true, '另一个用户动作之后的真输入不得被组合去重吞掉');
    assert.equal(edits.length, before + 1);
    assert.deepEqual(edits.at(-1).next, ['字']);
  });
}

test('输入负对照：组合后的紧邻重复事件只吞一次，后续同字照常插入', () => {
  const { machine: m, edits } = inputScene();
  m.handle({ type: 'compositionstart', from: 0, to: 0 });
  m.handle({ type: 'compositionend', data: '字' });
  assert.equal(m.handle({ type: 'input', data: '字', from: 0, to: 0 }).applied, false);
  assert.equal(m.handle({ type: 'input', data: '字', from: 1, to: 1 }).applied, true);
  assert.equal(edits.length, 2);
});

// ── 同一根因的补充角度（`docs/reviews/2026-11-03-历史缺陷驱动的测试补强.md` §6）──
// 每组都配一条负对照：证明断言不是"把实现抄一遍"，修复时也不能靠放宽判据转绿。

test('根因1 补充：空 compositionend 的多条暂存粘贴按顺序合成一条并清空队列', () => {
  const { machine: m, edits } = inputScene();
  m.handle({ type: 'compositionstart', from: 2, to: 2 });
  m.handle({ type: 'paste', text: '甲' });
  m.handle({ type: 'paste', text: '乙' });
  m.handle({ type: 'compositionend', data: '', from: 2, to: 2 });
  assert.deepEqual(
    edits.map(x => [x.from, x.to, x.next, x.reason]),
    [[2, 2, ['甲乙'], 'paste-after-composition']],
    '空结束不是"什么都没发生"：暂存粘贴是另一个用户动作，必须补一条'
  );
  assert.deepEqual(m.state.pending, [], '补完必须清空，⛔ 留给下一次组合');
  // 负对照：队列已空之后再空结束一次，不得重复补发。
  m.handle({ type: 'compositionstart', from: 9, to: 9 });
  m.handle({ type: 'compositionend', data: '', from: 9, to: 9 });
  assert.equal(edits.length, 1, '⛔ 重复补发');
});

test('根因1 补充：空 compositionend 的暂存粘贴同样过对象约束（CRLF 归一 + 策略折叠）', () => {
  const edits = [];
  const m = I.createInputMachine(
    tx => edits.push(tx),
    { text: t => String(t).replace(/\n/g, ' ') }
  );
  m.handle({ type: 'compositionstart', from: 0, to: 0 });
  m.handle({ type: 'paste', text: 'A\r\nB' });
  m.handle({ type: 'compositionend', data: '', from: 0, to: 0 });
  assert.deepEqual(edits.map(x => x.next), [['A B']],
    '补齐的那条必须与普通粘贴走同一个 textIn，⛔ 绕过策略把 CRLF 塞进格子');
});

test('根因1 补充：空 compositionend 的暂存粘贴落在事件给的当前选区', () => {
  const { machine: m, edits } = inputScene();
  m.handle({ type: 'compositionstart', from: 2, to: 2 });
  m.handle({ type: 'paste', text: 'x' });
  m.handle({ type: 'compositionend', data: '', from: 5, to: 5 });
  assert.deepEqual(edits.map(x => [x.from, x.to, x.next]), [[5, 5, ['x']]],
    '期间选区已挪动 ⇒ 补的那条落当前位，⛔ 退回起手偏移 2');
});

test('负对照：空 compositionend 之后同字真输入不得被当成补发吞掉', () => {
  const { machine: m, edits } = inputScene();
  m.handle({ type: 'compositionstart', from: 0, to: 0 });
  m.handle({ type: 'compositionend', data: '' });
  assert.equal(m.handle({ type: 'input', data: '字', from: 0, to: 0 }).applied, true);
  assert.equal(edits.length, 1);
});

test('负对照：组合目标失效时 compositionend 会丢弃暂存粘贴（与 cancel 对照）', () => {
  const { machine: m, edits } = inputScene();
  m.handle({ type: 'compositionstart', from: 2, to: 2, target: { id: 'old' } });
  m.handle({ type: 'paste', text: '旧粘贴' });
  const out = m.handle({ type: 'compositionend', data: '新', target: { id: 'new' } });
  assert.equal(out.stale, true);
  assert.deepEqual(edits, [], '目标整份没了 ⇒ ⛔ 往任何偏移写');
  assert.deepEqual(m.state.pending, []);
});

test('根因2 负对照：目标变了但仍有当前选区，cancel 必须落到当前位而不是起手位', () => {
  const { machine: m, edits } = inputScene();
  m.handle({ type: 'compositionstart', from: 2, to: 2, target: { id: 'old' } });
  m.handle({ type: 'paste', text: '粘贴' });
  m.handle({ type: 'cancel', target: { id: 'new' }, from: 7, to: 7 });
  assert.deepEqual(edits.map(x => [x.from, x.to, x.next]), [[7, 7, ['粘贴']]],
    '这是合法的 rebase 路径；修 lost 分支时⛔ 不能把它一起丢掉');
});

test('根因2 补充：cancel 目标失效且无暂存时不得发出任何事务', () => {
  const { machine: m, edits } = inputScene();
  m.handle({ type: 'compositionstart', from: 2, to: 2, target: { id: 'old' } });
  const out = m.handle({ type: 'cancel', target: { id: 'new' } });
  assert.equal(out.applied, false);
  assert.deepEqual(edits, []);
});

test('根因3 补充：撤销（historyUndo）之后相同文字是真输入', () => {
  const { machine: m, edits } = inputScene();
  m.handle({ type: 'compositionstart', from: 0, to: 0 });
  m.handle({ type: 'compositionend', data: '字' });
  assert.equal(m.handle({ type: 'beforeinput', inputType: 'historyUndo', from: 1, to: 1 }).applied, false);
  assert.equal(m.handle({ type: 'input', data: '字', from: 0, to: 0 }).applied, true,
    '撤销是另一个用户动作 ⇒ ⛔ 让组合留下的待吞标记吞掉真输入');
  assert.equal(edits.length, 2);
});

for (const inputType of ['historyRedo', 'formatBold']) {
  test(`根因3 补充：未处理的 beforeinput/${inputType} 之后相同文字是真输入`, () => {
    const { machine: m, edits } = inputScene();
    m.handle({ type: 'compositionstart', from: 0, to: 0 });
    m.handle({ type: 'compositionend', data: '字' });
    assert.equal(m.handle({ type: 'beforeinput', inputType: inputType, from: 1, to: 1 }).applied, false);
    assert.equal(m.handle({ type: 'input', data: '字', from: 1, to: 1 }).applied, true);
    assert.equal(edits.length, 2);
  });
}

test('负对照：取消之后不残留待吞标记，同字真输入照常插入', () => {
  const { machine: m, edits } = inputScene();
  m.handle({ type: 'compositionstart', from: 0, to: 0 });
  m.handle({ type: 'compositionend', data: '字' });
  m.handle({ type: 'cancel' });
  assert.equal(m.handle({ type: 'input', data: '字', from: 1, to: 1 }).applied, true);
  assert.equal(edits.length, 2);
});

function rollbackScenario(api) {
  const log = [];
  const frame = api.createFrame({ txId: 5, revision: { docSeq: 2, commitSeq: 4 } });
  for (const part of ['text', 'undo', 'redo', 'range', 'selection', 'dom']) {
    frame.add(part, () => part, value => {
      log.push(value);
      if (part === 'selection') throw Error('selection restore failed');
    });
  }
  assert.equal(frame.restore({ txId: 6 }).why, 'not-owner');
  assert.deepEqual(log, []);
  const out = frame.restore({ txId: 5, revision: { docSeq: 2, commitSeq: 4 } });
  assert.equal(out.ok, false);
  assert.deepEqual(Array.from(out.failed), ['selection']);
  assert.deepEqual(log, ['dom', 'selection', 'range', 'redo', 'undo', 'text']);
  assert.equal(frame.restore({ txId: 5 }).already, true);
  assert.equal(log.length, 6, '部分失败后也不能第二次回滚覆盖后续新状态');
}

test('事务回滚：失败项不阻断其他部分，拒绝非所有者后仍可由所有者恢复', () => {
  rollbackScenario(T);
});

function mutateModule(name, target, replacement) {
  const src = fs.readFileSync(require.resolve('../../src/live/' + name + '.js'), 'utf8');
  assert.equal(src.split(target).length - 1, 1, name + ' 变异必须恰好命中一处');
  const context = { module: { exports: {} } };
  vm.runInNewContext(src.replace(target, replacement), context);
  return context.module.exports;
}

test('变异自检：吞掉不可表示输入的保护被删除，丢输入判据必红、无操作负对照仍绿', () => {
  const bad = mutateModule('cell', 'if (decode(encoded) !== view)', 'if (false)');
  const b = bad.bind({ raw: 'a\\|b', from: 1, to: 5 });
  assert.throws(() => assert.equal(bad.judge(b, '|a\\|b|', 'a\\|b').status, 'rejected'),
    { code: 'ERR_ASSERTION' });
  assert.equal(bad.judge(b, '|a\\|b|', 'a|b').status, 'unchanged');
});

test('变异自检：一项回滚异常就终止，完整恢复判据必红、无异常负对照仍绿', () => {
  const bad = mutateModule('txn', 'failed.push(parts[i].name);', 'failed.push(parts[i].name); break;');
  assert.throws(() => rollbackScenario(bad), { code: 'ERR_ASSERTION' });
  const log = [];
  const frame = bad.createFrame({ txId: 1 });
  for (const part of ['text', 'undo', 'redo']) frame.add(part, () => part, value => log.push(value));
  assert.equal(frame.restore({ txId: 1 }).ok, true);
  assert.deepEqual(log, ['redo', 'undo', 'text']);
});

test('变异自检：清空重做分支被删除，序列 oracle 必红，未分叉撤销负对照仍绿', () => {
  const src = fs.readFileSync(require.resolve('../../src/live/model.js'), 'utf8');
  const target = '        redoEntries = [];\n        emit();\n        return entries.length;';
  // 精确限定 push()，不能误删声明或 clear()。
  assert.equal(src.split(target).length - 1, 1);
  const at = src.indexOf(target);
  const changed = src.slice(0, at) + '        emit();\n        return entries.length;' + src.slice(at + target.length);
  const context = { module: { exports: {} } };
  vm.runInNewContext(changed, context);
  const bad = context.module.exports;
  assert.throws(() => historySequence(bad, 23, 300), { code: 'ERR_ASSERTION' });
  const s = bad.createSession({ text: 'A' });
  s.commit({ from: 0, to: 1 }, ['B']);
  assert.equal(s.undoEdit().fullText, 'A');
  assert.equal(s.redo().fullText, 'B');
});
