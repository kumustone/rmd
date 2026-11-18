// 块表：线格式解包、种类 → DOM 形状、块表对齐、块间行。
// 守的是 `src/live/blocks.js` 文件头的「坐标只换一次」与 `INV-LIVE-06` 对齐闸门。
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

const B = load('src/live/blocks.js').liveBlocks;

// 后端 `src-tauri/src/document/blocks.rs::KIND_NAMES` 的逐字顺序。
const KIND_NAMES = [
  'Paragraph',
  'Heading',
  'CodeBlock',
  'List',
  'BlockQuote',
  'Table',
  'HtmlBlock',
  'ThematicBreak',
  'FootnoteDefinition',
  'Other',
];

function el(tagName, attrs) {
  const a = attrs || {};
  return {
    nodeType: 1,
    tagName: tagName,
    hasAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(a, name);
    },
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(a, name) ? a[name] : null;
    },
  };
}

function comment() {
  return { nodeType: 8 };
}

function block(kind, startLine, endLine, extra) {
  return Object.assign(
    {
      index: 0,
      kind: kind,
      startLine: startLine,
      endLine: endLine,
      from: startLine - 1,
      to: endLine,
      editable: true,
    },
    extra || {}
  );
}

function payload(rows, names) {
  return {
    line_count: 6,
    block_kinds: names || KIND_NAMES,
    blocks: rows,
  };
}

test('toRange 把 1-based 含两端换成 0-based 半开', () => {
  assert.deepStrictEqual(B.toRange(1, 1), { from: 0, to: 1 });
  assert.deepStrictEqual(B.toRange(2, 4), { from: 1, to: 4 });
});

test('toRange 对非整数、0 起点、反向区间一律抛错，不夹取', () => {
  assert.throws(() => B.toRange(0, 1), /行区间非法/);
  assert.throws(() => B.toRange(2, 1), /行区间非法/);
  assert.throws(() => B.toRange(1.5, 2), /整数/);
  assert.throws(() => B.toRange(1, NaN), /整数/);
});

test('SHAPES 覆盖后端 KIND_NAMES 的全部十项且没有多出的种类', () => {
  // ⚠️ 不比较声明顺序：kind_idx → 名字的映射来自后端下发的 block_kinds 数组，
  //    SHAPES 的键序不参与任何运行时映射；这里只钉住「同名、十项、不多不少」。
  assert.deepStrictEqual(Object.keys(B.SHAPES).slice().sort(), KIND_NAMES.slice().sort());
  assert.strictEqual(Object.keys(B.SHAPES).length, 10);
  assert.deepStrictEqual(B.SHAPES.Other, []);
  assert.deepStrictEqual(B.SHAPES.Paragraph, ['p', 'math-block']);
  assert.deepStrictEqual(B.SHAPES.FootnoteDefinition, ['footnotes']);
});

test('每个后端种类的 tagOf 都给出它该有的 DOM 形状', () => {
  assert.deepStrictEqual(B.tagOf('HtmlBlock'), ['raw-html']);
  assert.deepStrictEqual(B.tagOf('ThematicBreak'), ['hr']);
  assert.deepStrictEqual(B.tagOf('Table'), ['table']);
  assert.deepStrictEqual(B.tagOf('List'), ['list']);
  assert.deepStrictEqual(B.tagOf('BlockQuote'), ['quote']);
  assert.deepStrictEqual(B.tagOf('Heading'), ['h']);
  assert.deepStrictEqual(B.tagOf('CodeBlock'), ['pre', 'diagram']);
});

test('tagOf 认识十个种类，未知种类落 Other 而不是猜成段落', () => {
  for (const name of KIND_NAMES) {
    assert.strictEqual(B.tagOf(name), B.SHAPES[name], name);
  }
  assert.strictEqual(B.tagOf('NotAKind'), B.SHAPES.Other);
  assert.deepStrictEqual(B.tagOf(undefined), []);
});

test('accepts 只在种类允许的形状上为真，Other 什么都不接受', () => {
  assert.strictEqual(B.accepts('Paragraph', 'p'), true);
  assert.strictEqual(B.accepts('Paragraph', 'math-block'), true);
  assert.strictEqual(B.accepts('Paragraph', 'h'), false);
  assert.strictEqual(B.accepts('CodeBlock', 'diagram'), true);
  assert.strictEqual(B.accepts('CodeBlock', 'diagram-fallback'), false);
  assert.strictEqual(B.accepts('Other', 'p'), false);
});

test('shapeOf 按 tagName 识别块级形状，注释算 raw-html', () => {
  assert.strictEqual(B.shapeOf(el('p')), 'p');
  assert.strictEqual(B.shapeOf(el('PRE')), 'pre');
  assert.strictEqual(B.shapeOf(el('ul')), 'list');
  assert.strictEqual(B.shapeOf(el('ol')), 'list');
  assert.strictEqual(B.shapeOf(el('blockquote')), 'quote');
  assert.strictEqual(B.shapeOf(el('table')), 'table');
  assert.strictEqual(B.shapeOf(el('hr')), 'hr');
  assert.strictEqual(B.shapeOf(el('h1')), 'h');
  assert.strictEqual(B.shapeOf(el('h6')), 'h');
  assert.strictEqual(B.shapeOf(comment()), 'raw-html');
  assert.strictEqual(B.shapeOf(null), 'unknown');
});

test('shapeOf 只把带 data-footnotes 的 section 认成脚注区', () => {
  assert.strictEqual(B.shapeOf(el('section', { 'data-footnotes': '' })), 'footnotes');
  assert.strictEqual(B.shapeOf(el('section', {})), 'unknown');
});

test('shapeOf 识别公式块与图表块（含 -fallback 回退）', () => {
  assert.strictEqual(B.shapeOf(el('div', { class: 'rmd-math-display' })), 'math-block');
  assert.strictEqual(B.shapeOf(el('div', { class: 'x rmd-math-display y' })), 'math-block');
  assert.strictEqual(B.shapeOf(el('div', { class: 'rmd-diagram' })), 'diagram');
  assert.strictEqual(B.shapeOf(el('div', { class: 'rmd-diagram-fallback' })), 'diagram');
  assert.strictEqual(B.shapeOf(el('div', { class: 'rmd-diagramx' })), 'unknown');
});

test('fromPayload 正常解出块的行区间与可编辑位', () => {
  const out = B.fromPayload(payload([[0, 1, 1, 1], [1, 2, 4, 0]]));
  assert.deepStrictEqual(out.issues, []);
  assert.strictEqual(out.lineCount, 6);
  assert.strictEqual(out.blocks.length, 2);
  assert.deepStrictEqual(
    { index: out.blocks[0].index, kind: out.blocks[0].kind, from: out.blocks[0].from, to: out.blocks[0].to, editable: out.blocks[0].editable },
    { index: 0, kind: 'Paragraph', from: 0, to: 1, editable: true }
  );
  assert.strictEqual(out.blocks[1].kind, 'Heading');
  assert.strictEqual(out.blocks[1].editable, false);
  assert.strictEqual(out.blocks[1].startLine, 2);
  assert.strictEqual(out.blocks[1].endLine, 4);
});

test('fromPayload 对非法 line_count 记问题并归零，不抛错', () => {
  const out = B.fromPayload({ line_count: 0, block_kinds: KIND_NAMES, blocks: [] });
  assert.strictEqual(out.lineCount, 0);
  assert.ok(out.issues.some((s) => s.includes('line_count')), out.issues.join('|'));
});

test('fromPayload 缺 block_kinds 或 blocks 都记问题而不是抛错', () => {
  const a = B.fromPayload({ line_count: 2, blocks: [] });
  assert.ok(a.issues.some((s) => s.includes('block_kinds')));
  const b = B.fromPayload({ line_count: 2, block_kinds: KIND_NAMES });
  assert.ok(b.issues.some((s) => s.includes('blocks 缺失')));
  assert.deepStrictEqual(b.blocks, []);
});

test('fromPayload 的块不是四元组时只跳过那一块并记问题', () => {
  const out = B.fromPayload(payload([[0, 1, 1, 1], [0, 2, 2], [1, 3, 3, 1]]));
  assert.strictEqual(out.blocks.length, 2);
  assert.ok(out.issues.some((s) => s.includes('不是四元组')), out.issues.join('|'));
});

test('fromPayload 的种类下标越界落 Other 并记问题，块仍然保留', () => {
  const out = B.fromPayload(payload([[99, 1, 1, 1]]));
  assert.strictEqual(out.blocks.length, 1);
  assert.strictEqual(out.blocks[0].kind, 'Other');
  assert.ok(out.issues.some((s) => s.includes('种类下标越界')));
});

test('fromPayload 的行号非法时跳过该块（没有行区间的块没有意义）', () => {
  const out = B.fromPayload(payload([[0, 0, 1, 1], [1, 2, 2, 1]]));
  assert.strictEqual(out.blocks.length, 1);
  assert.strictEqual(out.blocks[0].kind, 'Heading');
  assert.ok(out.issues.some((s) => s.includes('行区间非法')));
});

test('fromPayload 的块右端超出 line_count 时记问题但保留块', () => {
  const out = B.fromPayload(payload([[0, 1, 9, 1]]));
  assert.strictEqual(out.blocks.length, 1);
  assert.ok(out.issues.some((s) => s.includes('超出')), out.issues.join('|'));
});

test('fromPayload 检查正文块之间的重叠，脚注组另外计数', () => {
  const out = B.fromPayload(payload([[0, 1, 3, 1], [1, 2, 4, 1]]));
  assert.ok(out.issues.some((s) => s.includes('与上一块重叠')), out.issues.join('|'));
});

test('fromPayload 检查脚注定义组内重叠与跨组重叠', () => {
  const names = KIND_NAMES;
  const inside = B.fromPayload(payload([
    [8, 4, 6, 1],
    [8, 2, 3, 1],
  ], names));
  assert.ok(inside.issues.some((s) => s.includes('脚注定义') && s.includes('重叠')), inside.issues.join('|'));

  const cross = B.fromPayload(payload([
    [0, 1, 3, 1],
    [8, 2, 4, 1],
  ], names));
  assert.ok(cross.issues.some((s) => s.includes('脚注定义块') && s.includes('重叠')), cross.issues.join('|'));
});

test('crossCheck 拒绝越界的表格块序号', () => {
  const issues = [];
  B.crossCheck([block('Paragraph', 1, 1)], [{ blockIndex: 1, cells: [] }], [], issues);
  assert.ok(issues.some((s) => s.includes('越界')), issues.join('|'));
});

test('crossCheck 要求 table_cells 指到的块必须是 Table', () => {
  const issues = [];
  B.crossCheck([block('Paragraph', 1, 3)], [{ blockIndex: 0, cells: [] }], [], issues);
  assert.ok(issues.some((s) => s.includes('不是 Table')), issues.join('|'));
});

test('crossCheck 检查每格与每框的行号落在块区间内', () => {
  const issues = [];
  const blocks = [block('Table', 2, 4), block('List', 5, 6, { index: 1 })];
  B.crossCheck(
    blocks,
    [{ blockIndex: 0, cells: [{ line: 1, from: 0, to: 1 }] }],
    [{ blockIndex: 1, tasks: [{ line: 7, from: 0, to: 1 }] }],
    issues
  );
  assert.ok(issues.some((s) => s.includes('第 0 格在第 1 行')), issues.join('|'));
  assert.ok(issues.some((s) => s.includes('第 0 个方框在第 7 行')), issues.join('|'));
});

test('crossCheck 不限制任务项所在块的种类（列表 / 引用里都能长）', () => {
  const issues = [];
  B.crossCheck(
    [block('BlockQuote', 1, 3)],
    [],
    [{ blockIndex: 0, tasks: [{ line: 2, from: 0, to: 1 }] }],
    issues
  );
  assert.deepStrictEqual(issues, []);
});

test('fromCellPayload 解出格子区间并把 0/1 与布尔都当可写', () => {
  const issues = [];
  const out = B.fromCellPayload([
    [2, [[1, 0, 3, 1], [2, 4, 6, true], [3, 1, 2, 0]]],
  ], issues);
  assert.deepStrictEqual(issues, []);
  assert.deepStrictEqual(out, [
    {
      blockIndex: 2,
      cells: [
        { line: 1, from: 0, to: 3, writable: true },
        { line: 2, from: 4, to: 6, writable: true },
        { line: 3, from: 1, to: 2, writable: false },
      ],
    },
  ]);
});

test('fromCellPayload 对非二元组、非数组格子表、非四元组逐层报错', () => {
  const issues = [];
  const out = B.fromCellPayload([
    [0, []],
    'x',
    [1, 'y'],
    [2, [[1, 0, 1]]],
  ], issues);
  assert.deepStrictEqual(out, [{ blockIndex: 0, cells: [] }]);
  assert.ok(issues.some((s) => s.includes('不是二元组')), issues.join('|'));
  assert.ok(issues.some((s) => s.includes('格子表不是数组')), issues.join('|'));
  assert.ok(issues.some((s) => s.includes('不是四元组')), issues.join('|'));
});

test('fromCellPayload 拒绝 0 行号、负列与右端小于左端的格子', () => {
  const issues = [];
  const out = B.fromCellPayload([
    [0, [[0, 0, 1, 1], [1, -1, 1, 1], [2, 3, 2, 1]]],
  ], issues);
  assert.deepStrictEqual(out, []);
  assert.strictEqual(issues.length, 1);
  assert.ok(issues[0].includes('区间非法'));
});

test('fromTaskPayload 解出五元组并强制 to = from + 1', () => {
  const issues = [];
  const out = B.fromTaskPayload([
    [0, [[1, 4, 5, 1, 1], [2, 0, 1, true, false]]],
  ], issues);
  assert.deepStrictEqual(issues, []);
  assert.deepStrictEqual(out, [
    {
      blockIndex: 0,
      tasks: [
        { line: 1, from: 4, to: 5, checked: true, writable: true },
        { line: 2, from: 0, to: 1, checked: true, writable: false },
      ],
    },
  ]);
});

test('fromTaskPayload 拒绝宽度不是 1 的任务项区间', () => {
  const issues = [];
  const out = B.fromTaskPayload([[0, [[1, 4, 7, 1, 1]]]], issues);
  assert.deepStrictEqual(out, []);
  assert.ok(issues.some((s) => s.includes('区间非法')), issues.join('|'));
});

test('fromTaskPayload 对非二元组、非数组任务表、非五元组逐层报错', () => {
  const issues = [];
  const out = B.fromTaskPayload([
    [0, []],
    ['x'],
    [1, 'y'],
    [2, [[1, 0, 1, 1]]],
  ], issues);
  assert.deepStrictEqual(out, [{ blockIndex: 0, tasks: [] }]);
  assert.ok(issues.some((s) => s.includes('不是二元组')), issues.join('|'));
  assert.ok(issues.some((s) => s.includes('任务项表不是数组')), issues.join('|'));
  assert.ok(issues.some((s) => s.includes('不是五元组')), issues.join('|'));
});

test('cellsOf / tasksOf 按块序号取表，没有时返回 null', () => {
  const cells = [{ blockIndex: 2, cells: [{ line: 1, from: 0, to: 1, writable: true }] }];
  const tasks = [{ blockIndex: 3, tasks: [{ line: 1, from: 0, to: 1, checked: false, writable: true }] }];
  assert.deepStrictEqual(B.cellsOf(cells, 2), cells[0].cells);
  assert.strictEqual(B.cellsOf(cells, 0), null);
  assert.deepStrictEqual(B.tasksOf(tasks, 3), tasks[0].tasks);
  assert.strictEqual(B.tasksOf(tasks, 1), null);
  assert.strictEqual(B.cellsOf(null, 0), null);
  assert.strictEqual(B.tasksOf(undefined, 0), null);
});

test('align 在块数与顶层节点数相等且形状匹配时给出 slots', () => {
  const blocks = [block('Paragraph', 1, 1, { index: 0 }), block('Heading', 2, 2, { index: 1 })];
  const nodes = [el('p'), el('h2')];
  const out = B.align(nodes, blocks);
  assert.deepStrictEqual(out.issues, []);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.slots.length, 2);
  assert.strictEqual(out.slots[0].node, nodes[0]);
  assert.strictEqual(out.slots[1].block.kind, 'Heading');
});

test('align 把脚注定义映射到文末唯一的 section，不参与逐块错位', () => {
  const blocks = [
    block('Paragraph', 1, 1, { index: 0 }),
    block('FootnoteDefinition', 2, 2, { index: 1 }),
    block('Paragraph', 3, 3, { index: 2 }),
  ];
  const section = el('section', { 'data-footnotes': '' });
  const out = B.align([el('p'), el('p'), section], blocks);
  assert.strictEqual(out.ok, true, out.issues.join('|'));
  assert.strictEqual(out.slots.length, 3);
  assert.strictEqual(out.slots[2].block.kind, 'FootnoteDefinition');
  assert.strictEqual(out.slots[2].node, section);
});

test('align 在块表有脚注而 DOM 文末没有 section 时失败', () => {
  const blocks = [block('Paragraph', 1, 1), block('FootnoteDefinition', 2, 2)];
  const out = B.align([el('p'), el('p')], blocks);
  assert.strictEqual(out.ok, false);
  assert.ok(out.issues.some((s) => s.includes('文末没有')), out.issues.join('|'));
  assert.deepStrictEqual(out.slots, []);
});

test('align 在 DOM 有脚注区而块表没有定义时失败', () => {
  const out = B.align([el('p'), el('section', { 'data-footnotes': '' })], [block('Paragraph', 1, 1)]);
  assert.strictEqual(out.ok, false);
  assert.ok(out.issues.some((s) => s.includes('块表里没有脚注定义')), out.issues.join('|'));
});

test('align 数量对不上直接失败，不给半个对齐', () => {
  const out = B.align([el('p')], [block('Paragraph', 1, 1), block('Heading', 2, 2, { index: 1 })]);
  assert.strictEqual(out.ok, false);
  assert.ok(out.issues.some((s) => s.includes('数量对不上')), out.issues.join('|'));
  assert.deepStrictEqual(out.slots, []);
});

test('align 形状不匹配时点名允许形状与实际形状', () => {
  const out = B.align([el('h1')], [block('Paragraph', 1, 1)]);
  assert.strictEqual(out.ok, false);
  assert.ok(out.issues.some((s) => s.includes('Paragraph') && s.includes('DOM 是 h')), out.issues.join('|'));
  assert.deepStrictEqual(out.slots, []);
});

test('gaps 给出未被任何块覆盖的 0-based 行号', () => {
  const blocks = [block('Paragraph', 1, 2), block('Heading', 4, 4, { index: 1 })];
  assert.deepStrictEqual(B.gaps(blocks, 6), [2, 4, 5]);
});

test('gapRanges 把连续块间行合并成半开区间', () => {
  assert.deepStrictEqual(B.gapRanges([1, 2, 5, 7, 8]), [
    { from: 1, to: 3 },
    { from: 5, to: 6 },
    { from: 7, to: 9 },
  ]);
  assert.deepStrictEqual(B.gapRanges([]), []);
});

test('unknownGapLines 放行空行、引用定义、缩进续行与隐藏指令', () => {
  const lines = [
    '[^a]: 脚注正文',
    '    continue',
    '',
    '[x]: https://example.com',
    '[TOC]',
    '@(demo)[target]',
  ];
  assert.deepStrictEqual(B.unknownGapLines(lines, [0, 1, 2, 3, 4, 5]), []);
});

test('unknownGapLines 把认不出来的块间行按 1-based 行号报出', () => {
  const lines = ['正文漏块', '    not a continuation', '> quote', '[TOC]'];
  assert.deepStrictEqual(B.unknownGapLines(lines, [0, 1, 2]), [
    { line: 1, text: '正文漏块' },
    { line: 2, text: '    not a continuation' },
    { line: 3, text: '> quote' },
  ]);
});

test('locate 用 0-based 半开区间，右端那一行不属于块', () => {
  const blocks = [block('Paragraph', 1, 2, { index: 0 }), block('Heading', 3, 3, { index: 1 })];
  assert.strictEqual(B.locate(blocks, 0).index, 0);
  assert.strictEqual(B.locate(blocks, 1).index, 0);
  assert.strictEqual(B.locate(blocks, 2).index, 1);
  assert.strictEqual(B.locate(blocks, 3), null);
  assert.strictEqual(B.locate(null, 0), null);
});

test('topNodes 只留元素与注释，滤掉空白文本与空项', () => {
  const p = el('p');
  const c = comment();
  const h = el('h1');
  const doc = {
    childNodes: [p, { nodeType: 3 }, null, c, { nodeType: 3 }, h],
  };
  assert.deepStrictEqual(B.topNodes(doc), [p, c, h]);
  assert.deepStrictEqual(B.topNodes(null), []);
  assert.deepStrictEqual(B.topNodes({}), []);
});
