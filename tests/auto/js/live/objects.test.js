// 编辑对象策略表：`BLOCK` / `CELL` 的唯一声明处，接线层只读不判。
// 守的是 `design/0054` 的「新对象先填契约表再接线」。
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

const O = load('src/live/objects.js').liveObjects;

test('没有 cell 语境时用块级策略', () => {
  assert.strictEqual(O.policyOf(undefined), O.BLOCK);
  assert.strictEqual(O.policyOf(null), O.BLOCK);
  assert.strictEqual(O.policyOf({}), O.BLOCK);
  assert.strictEqual(O.policyOf({ cell: null }), O.BLOCK);
});

test('cell 字段非空时用单元格策略', () => {
  assert.strictEqual(O.policyOf({ cell: {} }), O.CELL);
  assert.strictEqual(O.policyOf({ cell: { line: 3 } }), O.CELL);
});

test('块级策略：允许换行、搬盒子、Tab 离开、Enter 换行、方向键停住', () => {
  assert.strictEqual(O.BLOCK.id, 'block');
  assert.strictEqual(O.BLOCK.inlineOnly, false);
  assert.strictEqual(O.BLOCK.box, true);
  assert.strictEqual(O.BLOCK.tab, 'leave');
  assert.strictEqual(O.BLOCK.enter, 'newline');
  assert.strictEqual(O.BLOCK.arrows, 'stay');
  assert.strictEqual(O.BLOCK.verify, 'lines');
});

test('单元格策略：只按行内语义、不搬盒子、Tab 走格、方向键跨格、结构校验', () => {
  assert.strictEqual(O.CELL.id, 'cell');
  assert.strictEqual(O.CELL.inlineOnly, true);
  assert.strictEqual(O.CELL.box, false);
  assert.strictEqual(O.CELL.tab, 'walk');
  assert.strictEqual(O.CELL.enter, 'newline');
  assert.strictEqual(O.CELL.arrows, 'cross');
  assert.strictEqual(O.CELL.verify, 'structure');
});

test('两份策略都被冻结，调用点不能就地改契约', () => {
  assert.strictEqual(Object.isFrozen(O.BLOCK), true);
  assert.strictEqual(Object.isFrozen(O.CELL), true);
  assert.throws(() => {
    'use strict';
    O.BLOCK.tab = 'walk';
  }, TypeError);
});

test('两份策略是不同对象，不能靠字段相等混用', () => {
  assert.notStrictEqual(O.BLOCK, O.CELL);
  assert.notStrictEqual(O.BLOCK.id, O.CELL.id);
});

test('任何文本入口都原样收下换行，不在策略层折成空格', () => {
  assert.strictEqual(O.BLOCK.text('a\r\nb'), 'a\r\nb');
  assert.strictEqual(O.CELL.text('a\nb'), 'a\nb');
  assert.strictEqual(O.BLOCK.text(' x '), ' x ');
});

test('文本约束对 null / undefined 给空串而不是字符串 null', () => {
  assert.strictEqual(O.BLOCK.text(null), '');
  assert.strictEqual(O.CELL.text(undefined), '');
  assert.strictEqual(O.CELL.text(0), '0');
});
