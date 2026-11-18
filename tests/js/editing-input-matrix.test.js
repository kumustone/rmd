// 输入状态机 → 真 CM6 EditorState 的文本事务。不是系统 IME/事件顺序验收。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EditorState } = require('@codemirror/state');
const I = require('../../src/live/input.js');
const O = require('../../src/live/objects.js');

const payloads = [
  ['中文', '你好', '你好'], ['Emoji', '👩🏽‍💻', '👩🏽‍💻'],
  ['组合字符', 'e\u0301', 'e\u0301'], ['CRLF', '甲\r\n乙', '甲\n乙'],
  ['裸CR', '甲\r乙', '甲\n乙'], ['空行', '甲\n\n乙', '甲\n\n乙'],
  ['末尾换行', '甲\n', '甲\n'], ['纯换行', '\n', '\n'],
  ['管道转义', 'a\\|b', 'a\\|b'], ['HTML字面量', '<br>', '<br>'],
  ['TSV', '甲\t乙\r\n丙\t丁', '甲\t乙\n丙\t丁'],
  ['Markdown结构', '> 引用\n- [ ] 任务', '> 引用\n- [ ] 任务'],
];

function scene(api = I, policy = O.BLOCK) {
  let state = EditorState.create({ doc: '前🌱选区后' });
  const edits = [];
  const machine = api.createInputMachine(tx => {
    edits.push(tx);
    state = state.update({ changes: { from: tx.from, to: tx.to, insert: tx.next.join('\n') } }).state;
  }, policy);
  return { machine, edits, text: () => state.doc.toString(), target: () => state.doc };
}

for (const [policyName, policy] of [['block', O.BLOCK], ['cell', O.CELL]]) {
  for (const [name, raw, normalized] of payloads) {
    for (const kind of ['beforeinput', 'input', 'paste']) {
      test(`输入替换 ${policyName}/${name}/${kind}`, () => {
        const s = scene(I, policy);
        const event = kind === 'paste'
          ? { type: kind, text: raw, from: 3, to: 5 }
          : { type: kind, inputType: 'insertText', data: raw, from: 3, to: 5 };
        assert.equal(s.machine.handle(event).applied, true);
        assert.equal(s.edits.length, 1);
        assert.deepEqual(s.edits[0].next, normalized.split('\n'), '不能靠 CM6 自动归一掩盖输入层的裸CR');
        assert.equal(s.text(), '前🌱' + normalized + '后');
        assert.equal(s.text().includes('\r'), false);
      });
    }
  }
}

for (const [name, raw, normalized] of payloads) {
  for (const duplicateKind of ['beforeinput', 'input']) {
    test(`IME替换选区/补发去重 ${name}/${duplicateKind}`, () => {
      const s = scene();
      const target = s.target();
      s.machine.handle({ type: 'compositionstart', from: 3, to: 5, target });
      for (const data of ['p', 'pin', 'pinyin']) {
        s.machine.handle({ type: 'compositionupdate', data });
        assert.equal(s.text(), '前🌱选区后');
        assert.equal(s.edits.length, 0);
      }
      s.machine.handle({ type: 'compositionend', data: raw, from: 3, to: 5, target });
      const caret = 3 + normalized.length;
      const duplicate = { type: duplicateKind, inputType: 'insertText', data: raw, from: caret, to: caret };
      assert.equal(s.machine.handle(duplicate).applied, false);
      assert.equal(s.text(), '前🌱' + normalized + '后');
      assert.equal(s.edits.length, 1);
      assert.equal(s.machine.handle(duplicate).applied, true, '相同内容只能去重一发');
      assert.equal(s.text(), '前🌱' + normalized + normalized + '后');
    });
  }
}

for (const type of ['cancel', 'compositionend']) {
  for (const range of [[0, 0], [3, 5], [6, 6]]) {
    test(`取消组合保留原选区文本 ${type}/${range.join(':')}`, () => {
      const s = scene();
      const target = s.target();
      s.machine.handle({ type: 'compositionstart', from: range[0], to: range[1], target });
      s.machine.handle({ type: 'compositionupdate', data: 'pinyin' });
      s.machine.handle({ type, data: '', from: range[0], to: range[1], target });
      assert.equal(s.text(), '前🌱选区后');
      assert.equal(s.edits.length, 0);
      assert.equal(s.machine.state.composing, false);
      assert.equal(s.machine.state.session, null);
      assert.equal(s.machine.state.provisional, '');
    });
  }
}

for (const [name, raw, normalized] of payloads.slice(0, 8)) {
  test(`组合中多次粘贴/落定顺序 ${name}`, () => {
    const s = scene();
    const target = s.target();
    s.machine.handle({ type: 'compositionstart', from: 3, to: 5, target });
    for (const part of [raw, 'P', '😀']) s.machine.handle({ type: 'paste', text: part });
    assert.equal(s.text(), '前🌱选区后');
    s.machine.handle({ type: 'compositionend', data: '字', from: 3, to: 5, target });
    assert.equal(s.text(), '前🌱字' + normalized + 'P😀后');
    assert.equal(s.edits.length, 2);
    assert.deepEqual(s.machine.state.pending, []);
  });
}

for (const type of ['input', 'beforeinput']) {
  for (const flag of ['isComposing', 'session']) {
    test(`旧WebKit组合标志 ${type}/${flag}`, () => {
      const s = scene();
      const event = { type, inputType: 'insertText', data: '未提交', from: 3, to: 5 };
      if (flag === 'session') s.machine.handle({ type: 'compositionstart', from: 3, to: 5 });
      else event.isComposing = true;
      assert.equal(s.machine.handle(event).applied, false);
      assert.equal(s.text(), '前🌱选区后');
      assert.equal(s.edits.length, 0);
    });
  }
}

for (const type of ['historyUndo', 'historyRedo', 'formatBold', 'formatItalic', 'unknown']) {
  test(`未归输入层所有的动作不能写正文 ${type}`, () => {
    const s = scene();
    assert.equal(s.machine.handle({ type: 'beforeinput', inputType: type, data: 'X', from: 3, to: 5 }).applied, false);
    assert.equal(s.text(), '前🌱选区后');
    assert.equal(s.edits.length, 0);
  });
}

test('输入矩阵变异：不归一裸CR，多行输入判据必红、普通中文负对照仍绿', () => {
  const src = fs.readFileSync(require.resolve('../../src/live/input.js'), 'utf8');
  // 用实际源码的转义拼写，命中数本身也是守卫。
  const literal = '.replace(/\\r\\n?/g, \'\\n\')';
  assert.equal(src.split(literal).length - 1, 1);
  const box = { module: { exports: {} } };
  vm.runInNewContext(src.replace(literal, ''), box);
  const bad = box.module.exports;
  const s = scene(bad);
  s.machine.handle({ type: 'paste', text: '甲\r乙', from: 3, to: 5 });
  assert.throws(() => assert.deepEqual(Array.from(s.edits[0].next), ['甲', '乙']), { code: 'ERR_ASSERTION' });
  const control = scene(bad);
  control.machine.handle({ type: 'paste', text: '中文', from: 3, to: 5 });
  assert.equal(control.text(), '前🌱中文后');
});
