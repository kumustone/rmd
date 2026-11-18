// 0043–0046：真实 CM6 Text 上的字素/方向/跨行边界，不用产品算法生成期望。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Text } = require('@codemirror/state');
const S = require('../../src/live/selection.js');

const glyphs = [
  ['ASCII', 'a'], ['汉字', '汉'], ['代理对', '😀'], ['组合重音', 'e\u0301'],
  ['变体选择符', '✈️'], ['肤色', '👍🏽'], ['职业ZWJ', '👩🏽‍💻'],
  ['家庭ZWJ', '👨‍👩‍👧‍👦'], ['区域旗帜', '🇨🇳'], ['键帽', '1️⃣'],
  ['韩文组合', '한'], ['天城文', 'क्ष'], ['多重重音', 'a\u0301\u0327'],
  ['补充汉字', '𠮷'],
];
for (const [name, glyph] of glyphs) {
  for (const prefix of ['左 ', 'x'.repeat(40)]) {
    const doc = Text.of([prefix + glyph + ' 右']);
    const start = prefix.length;
    const end = start + glyph.length;
    const label = `${name}/前缀${prefix.length}`;
    const cases = [
      ['退格', () => S.deleteRange(doc, { anchor: end, head: end }), { from: start, to: end }],
      ['向前删除', () => S.deleteRange(doc, { anchor: start, head: start }, { forward: true }), { from: start, to: end }],
      ['Shift右', () => S.move(doc, { anchor: start, head: start }, 'charRight', { extend: true }), { anchor: start, head: end }],
      ['Shift左', () => S.move(doc, { anchor: end, head: end }, 'charLeft', { extend: true }), { anchor: end, head: start }],
      ['反向选区左收起', () => S.move(doc, { anchor: end, head: start }, 'charLeft'), { anchor: start, head: start }],
      ['反向选区右收起', () => S.move(doc, { anchor: end, head: start }, 'charRight'), { anchor: end, head: end }],
    ];
    for (const [action, run, expected] of cases) {
      test(`Unicode ${label}/${action}`, () => {
        const out = run();
        for (const [key, value] of Object.entries(expected)) assert.equal(out[key], value);
        if ('from' in expected) assert.equal(doc.sliceString(out.from, out.to), glyph);
      });
    }
  }
}

// 每一行显式声明词的位置，不调用 wordStop/wordAt 构造 oracle。
for (const [text, words] of [
  ['one two three', [[0, 3], [4, 7], [8, 13]]],
  ['_id x2 value_3', [[0, 3], [4, 6], [7, 14]]],
  ['one\nsecond\n三', [[0, 3], [4, 10], [11, 12]]],
  ['甲乙 ASCII', [[0, 1], [1, 2], [3, 8]]],
]) {
  const doc = Text.of(text.split('\n'));
  for (const [from, to] of words) {
    for (const pos of [...new Set([from, to - 1])]) {
      test(`双击词边界 ${JSON.stringify(text)}/${pos}`, () => {
        assert.deepEqual(S.wordAt(doc, pos), { from, to });
      });
    }
  }
}

const dragDoc = Text.of(['one two three', 'four five']);
const dragCases = [
  [2, { from: 4, to: 7 }, 0, 7, 0],
  [2, { from: 4, to: 7 }, 5, 4, 7],
  [2, { from: 4, to: 7 }, 9, 4, 13],
  [2, { from: 7, to: 4 }, 0, 7, 0],
  [3, { from: 0, to: 13 }, 16, 0, 23],
  [3, { from: 14, to: 23 }, 2, 23, 0],
  [3, { from: 14, to: 23 }, 18, 14, 23],
];
for (const [unit, base, pos, anchor, head] of dragCases) {
  test(`方向折返拖选 unit=${unit}/base=${base.from}:${base.to}/pos=${pos}`, () => {
    assert.deepEqual(S.dragRange(dragDoc, unit, base, pos), { anchor, head });
  });
}

for (const text of ['', '\n', 'a\n', '\na', '😀\n中', 'a\n\nb']) {
  const doc = Text.of(text.split('\n'));
  for (const [command, head] of [['docStart', 0], ['docEnd', text.length]]) {
    test(`文档边界 ${command}/${JSON.stringify(text)}`, () => {
      const out = S.move(doc, { anchor: text.length, head: 0 }, command, { extend: true });
      assert.equal(out.anchor, text.length);
      assert.equal(out.head, head);
      assert.equal(doc.toString(), text, '选择动作不得改文本');
    });
  }
}

test('选择矩阵变异：向前删除改为一个码元，Emoji 判据必红、ASCII负对照仍绿', () => {
  const src = fs.readFileSync(require.resolve('../../src/live/selection.js'), 'utf8');
  const target = 'return { from: head, to: graphemeForward(doc, head) };';
  assert.equal(src.split(target).length - 1, 1);
  const box = { module: { exports: {} } };
  vm.runInNewContext(src.replace(target, 'return { from: head, to: head + 1 };'), box);
  const api = box.module.exports;
  const doc = Text.of(['😀a']);
  assert.throws(() => assert.equal(api.deleteRange(doc, { anchor: 0, head: 0 }, { forward: true }).to, 2),
    { code: 'ERR_ASSERTION' });
  assert.equal(api.deleteRange(doc, { anchor: 2, head: 2 }, { forward: true }).to, 3);
});
