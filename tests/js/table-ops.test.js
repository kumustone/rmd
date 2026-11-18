// `design/0078` §2.3 / §7：**表格行列操作**的纯字节判据。
//
// ⚠️ 每条都断言**完整输出串**：列操作在源码上做区间插入 / 删除 / 两段交换，
//    错一位就会把 `\|` 拆开、把邻格内容吞掉、或把分隔行的对齐搞乱。
//    格子边界**只来自后端 `table_cells`**，所以这里按后端与 comrak 的口径手工写
//    `{line, from, to, writable}`（`line` 1-based、`from/to` 行内 UTF-16 右开、已修剪空白）。
//
// ⭐ 覆盖：13 条操作 / 表头 / 单行表 / 单列表 / 空表 / 列数不齐 / 转义竖线 /
//    末尾反斜杠 / 缺分隔行 / 缺对齐 / 置灰判据 / 越界 / 输入不被改写 / 文案闸门。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../../src/live/table.js');

/**
 * @param {number} line
 * @param {number} from
 * @param {number} to
 * @param {boolean} [writable]
 * @returns {{line:number, from:number, to:number, writable:boolean}}
 */
function cell(line, from, to, writable) {
  return { line: line, from: from, to: to, writable: writable !== false };
}

/**
 * @param {string} op
 * @param {string[]} lines
 * @param {Array<object>} cells
 * @param {number} startLine
 * @param {number} flat
 */
function run(op, lines, cells, startLine, flat) {
  return T.apply(op, lines, cells, { startLine: startLine, flat: flat });
}

/**
 * @param {string[]} lines
 * @param {Array<object>} cells
 * @param {number} startLine
 * @param {number} flat
 */
function cap(lines, cells, startLine, flat) {
  return T.capacity(lines, cells, { startLine: startLine, flat: flat });
}

// ── 公共夹具：2 列 × 2 数据行 ────────────────────────────────────────────────

const LINES = [
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '| 3 | 4 |',
];
const CELLS = [
  cell(10, 2, 3), cell(10, 6, 7),
  cell(12, 2, 3), cell(12, 6, 7),
  cell(13, 2, 3), cell(13, 6, 7),
];

test('行：在数据行上方插空行，列数沿用表头', function () {
  const out = run('row-insert-above', LINES, CELLS, 10, 2);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| a | b |',
    '| --- | --- |',
    '|  |  |',
    '| 1 | 2 |',
    '| 3 | 4 |',
  ] });
});

test('行：表头“下方”落在分隔行之后（⛔ 不插进表头与分隔行之间）', function () {
  const out = run('row-insert-below', LINES, CELLS, 10, 0);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| a | b |',
    '| --- | --- |',
    '|  |  |',
    '| 1 | 2 |',
    '| 3 | 4 |',
  ] });
});

test('行：最后一行下方追加', function () {
  const out = run('row-insert-below', LINES, CELLS, 10, 4);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '|  |  |',
  ] });
});

test('行：删数据行', function () {
  const out = run('row-delete', LINES, CELLS, 10, 2);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| a | b |',
    '| --- | --- |',
    '| 3 | 4 |',
  ] });
});

test('行：删最后一行', function () {
  const out = run('row-delete', LINES, CELLS, 10, 4);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
  ] });
});

test('行：上移 / 下移整行交换，表头与分隔行不动', function () {
  const up = run('row-move-up', LINES, CELLS, 10, 4);
  assert.deepStrictEqual(up, { ok: true, lines: [
    '| a | b |',
    '| --- | --- |',
    '| 3 | 4 |',
    '| 1 | 2 |',
  ] });
  const down = run('row-move-down', LINES, CELLS, 10, 2);
  assert.deepStrictEqual(down, up);
});

test('行：表头不可删 / 不可上插 / 不可移动；首行不可上移、末行不可下移', function () {
  assert.deepStrictEqual(run('row-delete', LINES, CELLS, 10, 0), { ok: false, why: 'header-row' });
  assert.deepStrictEqual(run('row-insert-above', LINES, CELLS, 10, 0), { ok: false, why: 'header-row' });
  assert.deepStrictEqual(run('row-move-up', LINES, CELLS, 10, 0), { ok: false, why: 'header-row' });
  assert.deepStrictEqual(run('row-move-down', LINES, CELLS, 10, 0), { ok: false, why: 'header-row' });
  assert.deepStrictEqual(run('row-move-up', LINES, CELLS, 10, 2), { ok: false, why: 'top-row' });
  assert.deepStrictEqual(run('row-move-down', LINES, CELLS, 10, 4), { ok: false, why: 'bottom-row' });
});

// ── 列：插入 / 删除 / 交换 ───────────────────────────────────────────────────

test('列：第一列左侧插入，所有行与分隔行同步', function () {
  const out = run('col-insert-left', LINES, CELLS, 10, 0);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| | a | b |',
    '| --- | --- | --- |',
    '| | 1 | 2 |',
    '| | 3 | 4 |',
  ] });
});

test('列：第二列左侧插入', function () {
  const out = run('col-insert-left', LINES, CELLS, 10, 1);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| a | | b |',
    '| --- | --- | --- |',
    '| 1 | | 2 |',
    '| 3 | | 4 |',
  ] });
});

test('列：第一列右侧插入', function () {
  const out = run('col-insert-right', LINES, CELLS, 10, 0);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| a | | b |',
    '| --- | --- | --- |',
    '| 1 | | 2 |',
    '| 3 | | 4 |',
  ] });
});

test('列：最后一列右侧插入保留行尾竖线', function () {
  const out = run('col-insert-right', LINES, CELLS, 10, 1);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| a | b |  |',
    '| --- | --- | --- |',
    '| 1 | 2 |  |',
    '| 3 | 4 |  |',
  ] });
});

test('列：删除第一列（连它后面那段分隔一起删）', function () {
  const out = run('col-delete', LINES, CELLS, 10, 0);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| b |',
    '| --- |',
    '| 2 |',
    '| 4 |',
  ] });
});

test('列：删除最后一列', function () {
  const out = run('col-delete', LINES, CELLS, 10, 1);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| a |',
    '| --- |',
    '| 1 |',
    '| 3 |',
  ] });
});

test('列：左移 / 右移交换内容与分隔格', function () {
  const left = run('col-move-left', LINES, CELLS, 10, 1);
  assert.deepStrictEqual(left, { ok: true, lines: [
    '| b | a |',
    '| --- | --- |',
    '| 2 | 1 |',
    '| 4 | 3 |',
  ] });
  const right = run('col-move-right', LINES, CELLS, 10, 0);
  assert.deepStrictEqual(right, left);
});

test('列：边缘列不可再移；单列表不可删列', function () {
  assert.deepStrictEqual(run('col-move-left', LINES, CELLS, 10, 0), { ok: false, why: 'left-edge' });
  assert.deepStrictEqual(run('col-move-right', LINES, CELLS, 10, 1), { ok: false, why: 'right-edge' });
  const oneLines = ['| a |', '| --- |', '| 1 |'];
  const oneCells = [cell(20, 2, 3), cell(22, 2, 3)];
  assert.deepStrictEqual(run('col-delete', oneLines, oneCells, 20, 1), { ok: false, why: 'last-column' });
});

// ── 对齐：只改分隔格 token，首尾空白与其它字节原样 ──────────────────────────

const ALINES = [
  '| a | b | c |',
  '| --- | :--- | ---: |',
  '| 1 | 2 | 3 |',
];
const ACELLS = [
  cell(30, 2, 3), cell(30, 6, 7), cell(30, 10, 11),
  cell(32, 2, 3), cell(32, 6, 7), cell(32, 10, 11),
];

test('对齐：居中 / 右对齐 / 左对齐（已左对齐的列是幂等）', function () {
  assert.deepStrictEqual(run('align-center', ALINES, ACELLS, 30, 0), { ok: true, lines: [
    '| a | b | c |',
    '| :---: | :--- | ---: |',
    '| 1 | 2 | 3 |',
  ] });
  assert.deepStrictEqual(run('align-right', ALINES, ACELLS, 30, 0), { ok: true, lines: [
    '| a | b | c |',
    '| ---: | :--- | ---: |',
    '| 1 | 2 | 3 |',
  ] });
  assert.deepStrictEqual(run('align-left', ALINES, ACELLS, 30, 2), { ok: true, lines: [
    '| a | b | c |',
    '| --- | :--- | :--- |',
    '| 1 | 2 | 3 |',
  ] });
});

test('对齐：无外框空白的紧凑分隔行也不被重排', function () {
  const lines = ['| a | b |', '|---|---|', '| 1 | 2 |'];
  const cells = [cell(40, 2, 3), cell(40, 6, 7), cell(42, 2, 3), cell(42, 6, 7)];
  const out = run('align-center', lines, cells, 40, 1);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| a | b |',
    '|---|:---:|',
    '| 1 | 2 |',
  ] });
});

test('列移动：不同对齐的分隔格跟着列一起走', function () {
  const out = run('col-move-left', ALINES, ACELLS, 30, 2);
  assert.deepStrictEqual(out, { ok: true, lines: [
    '| a | c | b |',
    '| --- | ---: | :--- |',
    '| 1 | 3 | 2 |',
  ] });
});

// ── 边界：表头单行 / 空表 / 列数不齐 / 转义 / 反斜杠 / 缺分隔行 ──────────────

const HLINES = ['| a | b |', '| --- | --- |'];
const HCELLS = [cell(50, 2, 3), cell(50, 6, 7)];

test('表头单行：可下插、可对齐；删 / 上插 / 移动全部拒绝', function () {
  assert.deepStrictEqual(run('row-insert-below', HLINES, HCELLS, 50, 0), { ok: true, lines: [
    '| a | b |',
    '| --- | --- |',
    '|  |  |',
  ] });
  assert.deepStrictEqual(run('row-delete', HLINES, HCELLS, 50, 0), { ok: false, why: 'header-row' });
  assert.deepStrictEqual(run('row-insert-above', HLINES, HCELLS, 50, 0), { ok: false, why: 'header-row' });
  assert.deepStrictEqual(run('row-move-down', HLINES, HCELLS, 50, 0), { ok: false, why: 'header-row' });
  assert.deepStrictEqual(cap(HLINES, HCELLS, 50, 0), {
    ok: true, uneven: false, columns: 2, column: 0, rowIndex: 0, rowCount: 1,
  });
});

const ULINES = ['| a | b | c |', '|---|---|---|', '| 1 | 2 |'];
const UCELLS = [
  cell(60, 2, 3), cell(60, 6, 7), cell(60, 10, 11),
  cell(62, 2, 3), cell(62, 6, 7), cell(62, 8, 8, false), // comrak 补的不可写空格
];

test('列数不齐：列操作整批拒绝；行操作与对齐仍可用', function () {
  assert.deepStrictEqual(run('col-delete', ULINES, UCELLS, 60, 4), { ok: false, why: 'uneven' });
  assert.deepStrictEqual(run('col-insert-left', ULINES, UCELLS, 60, 0), { ok: false, why: 'uneven' });
  assert.deepStrictEqual(run('col-move-right', ULINES, UCELLS, 60, 0), { ok: false, why: 'uneven' });
  assert.deepStrictEqual(run('row-insert-below', ULINES, UCELLS, 60, 4), { ok: true, lines: [
    '| a | b | c |',
    '|---|---|---|',
    '| 1 | 2 |',
    '|  |  |  |',
  ] });
  assert.deepStrictEqual(run('row-delete', ULINES, UCELLS, 60, 4), { ok: true, lines: [
    '| a | b | c |',
    '|---|---|---|',
  ] });
  assert.deepStrictEqual(run('align-center', ULINES, UCELLS, 60, 4), { ok: true, lines: [
    '| a | b | c |',
    '|---|:---:|---|',
    '| 1 | 2 |',
  ] });
  assert.deepStrictEqual(cap(ULINES, UCELLS, 60, 4), {
    ok: true, uneven: true, columns: 3, column: 1, rowIndex: 1, rowCount: 2,
  });
});

const ELINES = ['| a \\| b | c |', '| --- | --- |', '| 1 | 2 |'];
const ECELLS = [cell(70, 2, 8), cell(70, 11, 12), cell(72, 2, 3), cell(72, 6, 7)];

test('转义竖线：删左列不撕开 `\\|`，删右列保留它', function () {
  assert.deepStrictEqual(run('col-delete', ELINES, ECELLS, 70, 0), { ok: true, lines: [
    '| c |',
    '| --- |',
    '| 2 |',
  ] });
  assert.deepStrictEqual(run('col-delete', ELINES, ECELLS, 70, 1), { ok: true, lines: [
    '| a \\| b |',
    '| --- |',
    '| 1 |',
  ] });
});

test('转义竖线：插入 / 交换都按后端格子的右端算，`\\|` 原样', function () {
  assert.deepStrictEqual(run('col-insert-left', ELINES, ECELLS, 70, 1), { ok: true, lines: [
    '| a \\| b | | c |',
    '| --- | --- | --- |',
    '| 1 | | 2 |',
  ] });
  assert.deepStrictEqual(run('col-move-left', ELINES, ECELLS, 70, 1), { ok: true, lines: [
    '| c | a \\| b |',
    '| --- | --- |',
    '| 2 | 1 |',
  ] });
});

const TLINES = ['| z\\ | y |', '| --- | --- |', '| 1 | 2 |'];
const TCELLS = [cell(80, 2, 4), cell(80, 7, 8), cell(82, 2, 3), cell(82, 6, 7)];

test('末尾反斜杠：格子右端由后端给出，⛔ 不把它和后面的竖线连起来切', function () {
  assert.deepStrictEqual(run('col-insert-right', TLINES, TCELLS, 80, 0), { ok: true, lines: [
    '| z\\ | | y |',
    '| --- | --- | --- |',
    '| 1 | | 2 |',
  ] });
});

test('缺分隔行 / 缺表头格子 / 缺列 / 非法前缀都返回结构错误，⛔ 不抛', function () {
  const at90 = [cell(90, 2, 3), cell(90, 6, 7)];
  assert.deepStrictEqual(run('row-insert-below', ['| a | b |'], at90, 90, 0), { ok: false, why: 'no-delimiter' });
  assert.deepStrictEqual(run('row-insert-below', ['| a | b |', '| --- | --- |'], [], 90, 0), { ok: false, why: 'no-cells' });
  assert.deepStrictEqual(run('row-insert-below', ['| a | b |', 'plain'], at90, 90, 0), { ok: false, why: 'bad-delimiter' });
  assert.deepStrictEqual(run('row-insert-below', ['| a | b |', '| --- |'], at90, 90, 0), { ok: false, why: 'bad-delimiter' });
  assert.deepStrictEqual(run('row-insert-below', LINES, [cell(10, 2, 3), cell(10, 6, 7), cell(12, 2, 3)], 10, 0), { ok: false, why: 'bad-shape' });
  assert.deepStrictEqual(run('row-insert-below', ['x | a | b |', '| --- | --- |'], [cell(10, 4, 5), cell(10, 8, 9)], 10, 0), { ok: false, why: 'bad-shape' });
});

test('没有活动格 / 非法参数：结构错误不抛，程序错误才抛', function () {
  assert.deepStrictEqual(run('row-delete', LINES, CELLS, 10, 99), { ok: false, why: 'no-cell' });
  assert.deepStrictEqual(run('row-delete', LINES, CELLS, 10, -1), { ok: false, why: 'no-cell' });
  assert.deepStrictEqual(run('nuke', LINES, CELLS, 10, 0), { ok: false, why: 'unknown-op' });
  assert.throws(function () { T.apply('row-delete', LINES, CELLS, { startLine: 0, flat: 0 }); }, /startLine/);
  assert.throws(function () { T.apply('row-delete', /** @type {any} */ (null), CELLS, { startLine: 10, flat: 0 }); }, /blockLines/);
});

test('纯函数：输入数组与格子对象一个字节都不改', function () {
  const lines = LINES.slice();
  const cells = CELLS.map(function (c) { return { line: c.line, from: c.from, to: c.to, writable: c.writable }; });
  const linesSnap = JSON.stringify(lines);
  const cellsSnap = JSON.stringify(cells);
  run('col-move-right', lines, cells, 10, 0);
  run('row-delete', lines, cells, 10, 2);
  assert.strictEqual(JSON.stringify(lines), linesSnap);
  assert.strictEqual(JSON.stringify(cells), cellsSnap);
});

// ── 小件 / 命令表 / 文案闸门 ─────────────────────────────────────────────────

test('分隔行解析：只认两侧有竖线的形态；空行按列数生成', function () {
  const d = T.splitDelimiter('| --- | :---: |');
  assert.deepStrictEqual(d, {
    prefix: '|',
    pieces: [{ lead: ' ', token: '---', trail: ' ' }, { lead: ' ', token: ':---:', trail: ' ' }],
    suffix: '|',
  });
  assert.strictEqual(T.splitDelimiter('--- | ---'), null);
  assert.strictEqual(T.splitDelimiter('| --- | ---'), null);
  assert.strictEqual(T.emptyRow(3), '|  |  |  |');
});

test('命令表：13 条操作各有独立键与拒绝码', function () {
  assert.strictEqual(T.TABLE_OPS.length, 13);
  const cmds = new Set();
  T.TABLE_OPS.forEach(function (item) {
    assert.ok(!cmds.has(item.cmd), '操作重复：' + item.cmd);
    cmds.add(item.cmd);
    assert.strictEqual(typeof item.key, 'string');
    assert.ok(item.key.length > 0);
  });
  assert.deepStrictEqual(T.WHY.slice().sort(), [
    'bad-delimiter', 'bad-shape', 'bottom-row', 'header-row', 'last-column',
    'left-edge', 'no-cell', 'no-cells', 'no-delimiter', 'right-edge',
    'top-row', 'uneven', 'unknown-op',
  ]);
});

test('表格文案全部走字典：中英都有、非空、互不相同；拒绝理由带 {why}', function () {
  const I = require('../../src/services/i18n.js');
  const keys = ['live.table.menu', 'status.table-rejected']
    .concat(T.TABLE_OPS.map(function (item) { return 'live.table.' + item.key; }))
    .concat(T.WHY.map(function (why) { return 'status.table-why.' + why; }));
  keys.forEach(function (k) {
    ['zh', 'en'].forEach(function (lang) {
      const v = I.DICT[lang][k];
      assert.strictEqual(typeof v, 'string', lang + ' 缺键：' + k);
      assert.ok(v.trim().length > 0, lang + ' 空文案：' + k);
    });
    assert.notStrictEqual(I.DICT.zh[k], I.DICT.en[k], '中英文案相同：' + k);
  });
  ['zh', 'en'].forEach(function (lang) {
    assert.ok(I.DICT[lang]['status.table-rejected'].indexOf('{why}') >= 0,
      lang + ' 的 status.table-rejected 缺占位符 {why}');
  });
});
