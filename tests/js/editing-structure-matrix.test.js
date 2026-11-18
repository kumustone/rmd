// 0032/0035/0040/0047/0051：源码保真、邻格隔离、导航与任务项的结构边界。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../../src/live/cell.js');
const Task = require('../../src/live/task.js');

const contexts = [
  ['紧邻分隔符', '|左|', '|右|'],
  ['Unicode邻格', '| 左😀 | ', ' | 右e\u0301 |'],
  ['行尾省略竖线', '  左 | ', ''],
];
const rawCells = [
  '', '普通文字', '😀e\u0301', 'a<br>b', 'a<br/>b', 'a<br />b', 'a<BR>b',
  '`<br>`', '``a`b<br>c``', 'a\\<br>b', 'a\\|b', 'a\\\\\\|b',
  '**加粗**', '_倾斜_', '[链接](../a.md)', '&amp;', '[^foot]', '![图](a.png)',
];
for (const raw of rawCells) {
  for (const [name, left, right] of contexts) {
    test(`原始切片不修改 ${name}/${JSON.stringify(raw)}`, () => {
      const line = left + raw + right;
      const b = C.bind({ raw, from: left.length, to: left.length + raw.length, objectId: 'cell:2' });
      const before = structuredClone(b);
      assert.equal(C.textOf(line, b.from, b.to), raw);
      assert.equal(C.judge(b, line, b.initialView).status, 'unchanged');
      assert.deepEqual(b, before);
      assert.equal(line.slice(0, b.from), left);
      assert.equal(line.slice(b.to), right);
    });
  }
}

for (const [view, encoded] of [
  ['', ''], ['普通中文', '普通中文'], ['😀|甲', '😀\\|甲'],
  ['甲\n乙\n', '甲<br>乙<br>'], ['尾\\', '尾\\'], ['`<br>`', '`<br>`'],
]) {
  for (const [name, left, right] of contexts) {
    test(`整格替换隔离 ${name}/${JSON.stringify(view)}`, () => {
      const b = C.bind({ raw: 'old', from: left.length, to: left.length + 3 });
      const out = C.judge(b, left + 'old' + right, view);
      assert.equal(out.status, 'valid');
      const padding = view.endsWith('\\') && right.startsWith('|') ? ' ' : '';
      assert.equal(out.nextLine, left + encoded + padding + right);
      const next = C.bind({ raw: encoded, from: b.from, to: b.from + encoded.length });
      assert.equal(next.initialView, view);
      assert.equal(C.judge(next, out.nextLine, view).status, 'unchanged');
    });
  }
}

// 非法坐标即使文本没变也不能被默认为安全的无操作。
for (const [from, to] of [[-1, 2], [0, 99], [3, 1], [0.5, 2], [NaN, 2], [1, Infinity]]) {
  test(`非法原始绑定不得伪装无修改 ${from}:${to}`, () => {
    const b = C.bind({ raw: 'old', from, to });
    assert.equal(C.judge(b, '|old|', b.initialView).status, 'rejected');
  });
}

// 独立 oracle 是行列坐标：产品消费 DOM 的行主序扁平表，两者并非同一段遍历实现。
for (const shape of [[1], [3], [2, 2], [3, 3, 3], [1, 4, 2], [2, 0, 3]]) {
  const coords = shape.flatMap((count, row) => Array.from({ length: count }, (_, col) => ({ row, col })));
  const table = { rows: shape.map(count => ({ cells: Array.from({ length: count }, () => ({})) })) };
  for (const [flat, at] of coords.entries()) {
    const below = coords.findIndex(p => p.row === at.row + 1 && p.col === at.col);
    const cases = [
      ['Tab', () => C.flatAfter(table, flat, 1), flat + 1 < coords.length ? flat + 1 : -1],
      ['ShiftTab', () => C.flatAfter(table, flat, -1), flat > 0 ? flat - 1 : -1],
      ['下一行同列', () => C.flatBelow(table, flat), below],
    ];
    for (const [action, run, expected] of cases) {
      test(`表格导航 ${shape.join('x')}/${at.row}:${at.col}/${action}`, () => {
        assert.equal(run(), expected);
        assert.equal(C.cellAtIndex(table, flat), table.rows[at.row].cells[at.col]);
        assert.equal(C.countCells(table), coords.length);
      });
    }
  }
}

for (const prefix of ['- [', '* [', '+ [', '1. [', '10) [', '  - [', '> - [', '> > - [']) {
  for (const symbol of [' ', 'x', 'X']) {
    for (const suffix of [' 中文😀', '\t[链接](a.md)', ' e\u0301与邻接[x]']) {
      test(`任务符号隔离 ${JSON.stringify(prefix + symbol + suffix)}`, () => {
        const left = prefix;
        const right = ']' + suffix;
        const from = left.length;
        const line = left + symbol + right;
        const first = symbol === ' ' ? 'x' : ' ';
        assert.equal(Task.toggleLine(line, from, from + 1), left + first + right);
        assert.equal(Task.isCheckedSymbol(line, from, from + 1), first === 'x');
        const twice = Task.toggleLine(left + first + right, from, from + 1);
        assert.equal(twice, left + (symbol === 'X' ? 'x' : symbol) + right);
        assert.equal(twice.length, line.length);
      });
    }
  }
}

for (const symbol of ['-', '✓', '√', 'y', '\t', '😀']) {
  test(`任务项拒绝非法符号 ${JSON.stringify(symbol)}`, () => {
    const line = '- [' + symbol + '] 文字';
    assert.throws(() => Task.toggleLine(line, 3, 3 + symbol.length));
    assert.equal(line, '- [' + symbol + '] 文字');
  });
}

test('结构矩阵变异：末尾反斜杠取消补位，邻格边界判据必红、普通字负对照仍绿', () => {
  const src = fs.readFileSync(require.resolve('../../src/live/cell.js'), 'utf8');
  const target = "return line.charAt(to) === '|' ? s + ' ' : s;";
  assert.equal(src.split(target).length - 1, 1);
  const box = { module: { exports: {} } };
  vm.runInNewContext(src.replace(target, 'return s;'), box);
  const api = box.module.exports;
  const b = api.bind({ raw: 'old', from: 1, to: 4 });
  assert.throws(() => assert.equal(api.judge(b, '|old|邻|', '尾\\').nextLine, '|尾\\ |邻|'),
    { code: 'ERR_ASSERTION' });
  assert.equal(api.judge(b, '|old|邻|', '好').nextLine, '|好|邻|');
});
