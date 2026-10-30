// `design/0047` §3.2 的 JS 纯逻辑判据之一：**块表解包 ＋ 块表 ↔ DOM 对齐 ＋ 块间行**。
//
// ⚠️ 这一份测的是 `src/live/blocks.js`（纯函数，⛔ 不碰真 DOM / Tauri / 定时器）。
//    DOM 那半用**假节点**（`{nodeType, tagName, getAttribute, hasAttribute}`）——
//    真 DOM 的形状证据在 `blocks.rs` 的测试注释里（2026-10-26 实地渲出来的）。
//
// ⭐ 为什么每条都要**正反例**：这三组错的共同点是"屏幕上不报错"——
//    解包多吞一个越界下标、对齐错一格、块间行多放行一行，界面都照样能用，
//    只是用户改的是 A、屏幕上是 B（`INV-LIVE-05/06`）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const LB = require('../../src/live/blocks.js');

/** Rust `blocks.rs::KIND_NAMES` 的**逐字**副本（⛔ 只在这里出现一次，别在别处再抄）。 */
const NAMES = [
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

/** 造一个假元素节点。 */
function el(tag, cls, attrs) {
  const a = Object.assign({}, attrs || {});
  if (cls) a.class = cls;
  return {
    nodeType: 1,
    tagName: tag,
    getAttribute: function (n) {
      return a[n] === undefined ? null : a[n];
    },
    hasAttribute: function (n) {
      return a[n] !== undefined;
    },
  };
}

/** 造一个假注释节点（`<!-- raw HTML omitted -->`）。 */
function comment() {
  return { nodeType: 8 };
}

function payload(rows, lineCount, names) {
  return { line_count: lineCount, block_kinds: names || NAMES, blocks: rows };
}

/** 常常用的那一步：解包 + 断言没问题。 */
function blocksOf(rows, lineCount) {
  const got = LB.fromPayload(payload(rows, lineCount));
  assert.deepStrictEqual(got.issues, [], '夹具本身必须干净：' + JSON.stringify(got.issues));
  return got.blocks;
}

// ── toRange：唯一一次坐标换算 ───────────────────────────────────────────────

test('坐标换算：1-based 含两端 → 0-based 半开', function () {
  assert.deepStrictEqual(LB.toRange(1, 1), { from: 0, to: 1 });
  assert.deepStrictEqual(LB.toRange(3, 3), { from: 2, to: 3 });
  // ⚠️ 三行块：第 5..7 行 ⇒ 下标 4..7（`to` 是**半开**的右端）。
  assert.deepStrictEqual(LB.toRange(5, 7), { from: 4, to: 7 });
});

test('坐标换算：非法区间**抛错**，⛔ 不夹取', function () {
  assert.throws(function () {
    LB.toRange(0, 1);
  }, /行区间非法/);
  assert.throws(function () {
    LB.toRange(3, 2);
  }, /行区间非法/);
  assert.throws(function () {
    LB.toRange(1.5, 2);
  }, /必须是整数/);
});

// ── fromPayload：唯一解包点 ─────────────────────────────────────────────────

test('解包：正常回包逐块对得上（种类名按下标取）', function () {
  const blocks = blocksOf(
    [
      [1, 1, 1, 1],
      [0, 3, 5, 1],
      [5, 7, 9, 0],
    ],
    10
  );
  assert.deepStrictEqual(
    blocks.map(function (b) {
      return [b.kind, b.startLine, b.endLine, b.from, b.to, b.editable];
    }),
    [
      ['Heading', 1, 1, 0, 1, true],
      ['Paragraph', 3, 5, 2, 5, true],
      ['Table', 7, 9, 6, 9, false],
    ]
  );
  // `index` 是**线格式里的位置**，对齐时按它说话。
  assert.deepStrictEqual(
    blocks.map(function (b) {
      return b.index;
    }),
    [0, 1, 2]
  );
});

test('解包：种类下标越界 ⇒ 落 Other 且**记一条**（⛔ 不猜一个最像的）', function () {
  const got = LB.fromPayload(payload([[99, 1, 1, 1]], 1));
  assert.strictEqual(got.blocks.length, 1, '块本身要留下来，才能对齐时看见它');
  assert.strictEqual(got.blocks[0].kind, 'Other');
  assert.strictEqual(got.issues.length, 1);
  assert.match(got.issues[0], /种类下标越界/);
});

test('解包：不是四元组 ⇒ 那条被跳过并记一条（其余照解）', function () {
  const got = LB.fromPayload(payload([[0, 1, 1], [0, 3, 3, 1]], 5));
  assert.strictEqual(got.blocks.length, 1);
  assert.strictEqual(got.blocks[0].startLine, 3);
  assert.strictEqual(got.issues.length, 1);
  assert.match(got.issues[0], /四元组/);
});

test('解包：行区间非法 / 倒置 ⇒ 记一条且**不产生块**', function () {
  const got = LB.fromPayload(payload([[0, 0, 1, 1]], 5));
  assert.deepStrictEqual(got.blocks, []);
  assert.match(got.issues[0], /行区间非法/);

  const inv = LB.fromPayload(payload([[0, 4, 2, 1]], 5));
  assert.deepStrictEqual(inv.blocks, []);
  assert.match(inv.issues[0], /行区间非法/);
});

test('解包：右端越界 / 块重叠都要说出来（⛔ 静默对齐）', function () {
  const over = LB.fromPayload(payload([[0, 4, 9, 1]], 5));
  assert.match(over.issues.join('\n'), /超出 5 行/);

  const overlap = LB.fromPayload(payload([[0, 1, 3, 1], [0, 3, 5, 1]], 5));
  assert.match(overlap.issues.join('\n'), /重叠/);
});

// ⭐ `bugs/0037`：有脚注的文档**整篇进不了就地编辑**，报的还是「块重叠」。
//    真因：comrak 把脚注定义物化到 AST 末尾，而 `sourcepos` 仍指着源码原处
//    ⇒ 块表里的行号本来就**不是升序**。`blocks.rs::脚注定义在块表末尾而行号回到原位`
//    是同一份夹具（Rust 侧钉住这个事实），两边一起看才知道"不是包坏了"。
test('解包：脚注定义的行号回到原位 ⇒ ⛔ 不算重叠（块序号是 AST 顺序）', function () {
  // 源码：第 1 / 3 / 7 行三个段落，第 5 行是 `[^a]: 定义`（被第 1 行引用）。
  const rows = [
    [0, 1, 1, 1],
    [0, 3, 3, 1],
    [0, 7, 7, 1],
    [8, 5, 5, 0],
  ];
  const got = LB.fromPayload(payload(rows, 7));
  assert.deepStrictEqual(got.issues, [], '整篇必须能进编辑态：' + got.issues.join(' / '));
  assert.deepStrictEqual(
    got.blocks.map(function (b) {
      return [b.kind, b.from, b.to];
    }),
    [
      ['Paragraph', 0, 1],
      ['Paragraph', 2, 3],
      ['Paragraph', 6, 7],
      ['FootnoteDefinition', 4, 5],
    ],
    '块序号 = AST 顺序，⛔ 不按行号重排（`align()` 靠它映射文末那个 section）'
  );
});

test('解包：脚注定义的真重叠仍要说出来（组内 ＋ 跨组），而"只是行号小"不算', function () {
  // ① 组内：两个脚注定义共享一行
  const within = LB.fromPayload(payload([[8, 5, 6, 0], [8, 6, 7, 0]], 7));
  assert.match(within.issues.join('\n'), /脚注定义块 1 与上一个脚注定义重叠/);

  // ② 跨组：正文块盖住了定义那一行（两边会去改同一段字节）
  const across = LB.fromPayload(payload([[0, 1, 5, 1], [8, 5, 5, 0]], 7));
  assert.match(across.issues.join('\n'), /脚注定义块 1 与块 0 重叠/);

  // ③ 负对照：定义的行号**比正文小**，但两段并不相交 ⇒ ⛔ 不许报
  //    （① 的修法最容易顺手写成"看正文游标的最大值"，那样这一条会被误伤）
  const fine = LB.fromPayload(payload([[0, 7, 7, 1], [8, 3, 3, 0]], 7));
  assert.deepStrictEqual(fine.issues, []);
});

test('解包：字段缺失 ⇒ issues 非空，⛔ 不抛错', function () {  assert.match(LB.fromPayload(null).issues.join('\n'), /line_count/);
  assert.match(LB.fromPayload({ line_count: 3 }).issues.join('\n'), /block_kinds/);
  assert.match(LB.fromPayload({ line_count: 3, block_kinds: NAMES }).issues.join('\n'), /blocks 缺失/);
});

// ── 两份行事实的交叉断言（评审第 13 条） ──────────────────────────────────

test('交叉断言：块序号 / 种类 / 行区间三条各自都要说得出来', function () {
  // 块 0 是段落（1 行），块 1 是表格（5–8 行）。
  const rows = [
    [0, 1, 1, 1],
    [5, 5, 8, 0],
  ];

  // ① 干净夹具：一条都不许报（否则下面三条的"红了"没有对照）。
  const clean = LB.fromPayload(
    Object.assign(payload(rows, 8), {
      table_cells: [[1, [[5, 0, 1, 1], [8, 0, 1, 1]]]],
      task_items: [[0, [[1, 0, 1, 0, 1]]]],
    })
  );
  assert.deepStrictEqual(clean.issues, [], '夹具本身必须干净：' + clean.issues.join(' / '));

  // ② 块序号越界 ⇒ 说出来，并且带上「载荷版本不一致」的口径。
  const outOfRange = LB.fromPayload(
    Object.assign(payload(rows, 8), { table_cells: [[9, [[1, 0, 1, 1]]]] })
  );
  assert.match(outOfRange.issues.join('\n'), /table_cells 的块序号 9 越界/);
  assert.match(outOfRange.issues.join('\n'), /载荷版本不一致/);

  // ③ 指到的块不是 Table ⇒ 单独一条（⛔ 不许与"越界"糊成同一句）。
  const wrongKind = LB.fromPayload(
    Object.assign(payload(rows, 8), { table_cells: [[0, [[1, 0, 1, 1]]]] })
  );
  assert.match(wrongKind.issues.join('\n'), /table_cells 的块 0 种类是 Paragraph，不是 Table/);

  // ④ 行号落在块区间之外 ⇒ 说得出是哪一格、第几行、区间多少。
  const outside = LB.fromPayload(
    Object.assign(payload(rows, 8), {
      table_cells: [[1, [[9, 0, 1, 1]]]],
      task_items: [[0, [[2, 0, 1, 0, 1]]]],
    })
  );
  assert.match(outside.issues.join('\n'), /块 1 第 0 格在第 9 行，落在块区间 5-8 之外/);
  assert.match(outside.issues.join('\n'), /块 0 第 0 个方框在第 2 行，落在块区间 1-1 之外/);

  // ⑤ 任务项**不查块种类**：任务列表是 `List`、引用里的任务是 `BlockQuote`，
  //    两个都必须放过（按种类白名单查会造出假红——Rust 侧同一条理由）。
  const taskKinds = LB.fromPayload(
    Object.assign(payload([[3, 1, 3, 0], [4, 5, 6, 0]], 6), {
      task_items: [[0, [[2, 0, 1, 0, 1]]], [1, [[6, 0, 1, 0, 1]]]],
    })
  );
  assert.deepStrictEqual(taskKinds.issues, [], taskKinds.issues.join(' / '));
});

test('解包：`editable` 只认线格式的 1（其余一律 false，安全侧）', function () {
  const blocks = blocksOf(
    [
      [0, 1, 1, 1],
      [0, 2, 2, 0],
      [0, 3, 3, '1'],
      [0, 4, 4, true],
    ],
    4
  );
  assert.deepStrictEqual(
    blocks.map(function (b) {
      return b.editable;
    }),
    [true, false, false, false]
  );
});

// ── shapeOf：DOM 那一侧的词表 ───────────────────────────────────────────────

test('形状：六种块标签各归各的形状', function () {
  assert.strictEqual(LB.shapeOf(el('P')), 'p');
  for (let lv = 1; lv <= 6; lv++) assert.strictEqual(LB.shapeOf(el('H' + lv)), 'h');
  assert.strictEqual(LB.shapeOf(el('PRE', 'rmd-code')), 'pre');
  assert.strictEqual(LB.shapeOf(el('UL')), 'list');
  assert.strictEqual(LB.shapeOf(el('OL')), 'list');
  assert.strictEqual(LB.shapeOf(el('BLOCKQUOTE')), 'quote');
  assert.strictEqual(LB.shapeOf(el('TABLE')), 'table');
  assert.strictEqual(LB.shapeOf(el('HR')), 'hr');
});

test('形状：⭐ 块级公式是 div.rmd-math-display、图表是 div.rmd-diagram、脚注是 section[data-footnotes]', function () {
  assert.strictEqual(LB.shapeOf(el('DIV', 'rmd-math-display')), 'math-block');
  assert.strictEqual(LB.shapeOf(el('DIV', 'rmd-diagram', { 'data-diagram': 'flow' })), 'diagram');
  assert.strictEqual(LB.shapeOf(el('SECTION', null, { 'data-footnotes': '' })), 'footnotes');
});

test('形状：注释节点是 raw-html（`<!-- raw HTML omitted -->`），其余一律 unknown', function () {
  assert.strictEqual(LB.shapeOf(comment()), 'raw-html');
  assert.strictEqual(LB.shapeOf({ nodeType: 3 }), 'unknown', '文本节点');
  assert.strictEqual(LB.shapeOf(el('LI')), 'unknown');
  assert.strictEqual(LB.shapeOf(el('DIV', 'something-else')), 'unknown');
  assert.strictEqual(LB.shapeOf(el('SECTION')), 'unknown', '没有 data-footnotes 的 section');
  assert.strictEqual(LB.shapeOf(null), 'unknown');
});

test('形状：种类 → 允许的形状（唯一一份表）', function () {
  assert.deepStrictEqual(LB.tagOf('Paragraph'), ['p', 'math-block']);
  assert.deepStrictEqual(LB.tagOf('CodeBlock'), ['pre', 'diagram']);
  assert.deepStrictEqual(LB.tagOf('HtmlBlock'), ['raw-html']);
  // ⚠️ `Other` **一个形状都不接受** ⇒ 落进它的块会让整次对齐失败。
  assert.deepStrictEqual(LB.tagOf('Other'), []);
  assert.deepStrictEqual(LB.tagOf('没见过的种类'), []);
  assert.strictEqual(LB.accepts('Paragraph', 'math-block'), true);
  assert.strictEqual(LB.accepts('Paragraph', 'pre'), false);
  assert.strictEqual(LB.accepts('Other', 'p'), false);
});

// ── align：块表 ↔ DOM ──────────────────────────────────────────────────────

test('对齐：四块对上四个节点', function () {
  const blocks = blocksOf(
    [
      [1, 1, 1, 1],
      [0, 3, 3, 1],
      [3, 5, 6, 1],
      [2, 8, 10, 1],
    ],
    11
  );
  const out = LB.align([el('H1'), el('P'), el('UL'), el('PRE', 'rmd-code')], blocks);
  assert.strictEqual(out.ok, true, JSON.stringify(out.issues));
  assert.deepStrictEqual(
    out.slots.map(function (s) {
      return s.block.kind;
    }),
    ['Heading', 'Paragraph', 'List', 'CodeBlock']
  );
});

test('对齐：⭐ 脚注定义被搬到文末合并成一个 section（定义在**中间**也不许错位）', function () {
  // 源码顺序：段落 → 脚注定义 → 段落 → 列表
  const blocks = blocksOf(
    [
      [0, 1, 1, 1],
      [8, 3, 3, 0],
      [0, 5, 5, 1],
      [3, 7, 8, 1],
    ],
    9
  );
  // DOM 顺序：p → p → ul → section（⛔ 定义没有留在原位）
  const out = LB.align([el('P'), el('P'), el('UL'), el('SECTION', null, { 'data-footnotes': '' })], blocks);
  assert.strictEqual(out.ok, true, JSON.stringify(out.issues));
  assert.deepStrictEqual(
    out.slots.map(function (s) {
      return [s.block.kind, LB.shapeOf(s.node)];
    }),
    [
      ['Paragraph', 'p'],
      ['Paragraph', 'p'],
      ['List', 'list'],
      ['FootnoteDefinition', 'footnotes'],
    ]
  );
});

test('对齐：反例——块表说没有脚注、DOM 文末却有 section ⇒ 失败且一个 slot 都不给', function () {
  const blocks = blocksOf([[0, 1, 1, 1]], 9);
  const out = LB.align([el('P'), el('SECTION', null, { 'data-footnotes': '' })], blocks);
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(out.slots, [], '⛔ 半个对齐比没有对齐更危险');
  assert.match(out.issues.join('\n'), /没有脚注定义/);
});

test('对齐：反例——有脚注定义但文末没有 section ⇒ 失败', function () {
  const blocks = blocksOf(
    [
      [0, 1, 1, 1],
      [8, 3, 3, 0],
    ],
    5
  );
  const out = LB.align([el('P')], blocks);
  assert.strictEqual(out.ok, false);
  assert.match(out.issues.join('\n'), /没有 <section data-footnotes>/);
});

test('对齐：反例——数量对不上 ⇒ 失败（⛔ 不做最长公共子序列去凑）', function () {
  const blocks = blocksOf(
    [
      [0, 1, 1, 1],
      [0, 3, 3, 1],
    ],
    5
  );
  const out = LB.align([el('P')], blocks);
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(out.slots, []);
  assert.match(out.issues.join('\n'), /数量对不上/);
});

test('对齐：反例——形状不匹配 ⇒ 失败，且提示里带**行号**与两种形状', function () {
  const blocks = blocksOf([[2, 3, 5, 1]], 6);
  const out = LB.align([el('P')], blocks);
  assert.strictEqual(out.ok, false);
  const text = out.issues.join('\n');
  assert.match(text, /第 0 块（CodeBlock，第 3-5 行）/);
  assert.match(text, /DOM 是 p/);
});

test('对齐：反例——认不出来的种类（Other）就算 DOM 是 <p> 也不对齐', function () {
  const blocks = blocksOf([[9, 1, 1, 1]], 3);
  const out = LB.align([el('P')], blocks);
  assert.strictEqual(out.ok, false);
  assert.match(out.issues.join('\n'), /Other/);
});

test('对齐：反向锚点——块级公式那个不可编辑的段落**必须照旧对齐**（否则后面全错位）', function () {
  const blocks = blocksOf(
    [
      [0, 1, 3, 0],
      [0, 5, 5, 1],
    ],
    6
  );
  const out = LB.align([el('DIV', 'rmd-math-display'), el('P')], blocks);
  assert.strictEqual(out.ok, true, JSON.stringify(out.issues));
  assert.strictEqual(out.slots[0].block.editable, false);
  assert.strictEqual(out.slots[1].block.editable, true);
});

test('对齐：空文档（0 块 0 节点）算对齐成功', function () {
  const out = LB.align([], []);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.slots, []);
});

// ── 块间行 ─────────────────────────────────────────────────────────────────

test('块间行：0-based 下标，连续段能合并成区间', function () {
  const blocks = blocksOf(
    [
      [0, 1, 1, 1],
      [0, 3, 4, 1],
    ],
    6
  );
  assert.deepStrictEqual(LB.gaps(blocks, 6), [1, 4, 5]);
  assert.deepStrictEqual(LB.gapRanges(LB.gaps(blocks, 6)), [
    { from: 1, to: 2 },
    { from: 4, to: 6 },
  ]);
});

test('块间行报警器：白名单四类放行，其余**必须报出来**', function () {
  const lines = [
    '正文', // 0（块内）
    '', // 1 空行 ✅
    '[a]: https://example.com', // 2 链接引用定义 ✅
    '  续行', // 3 定义的缩进续行 ✅
    '[^x]: 未被引用的脚注', // 4 脚注定义 ✅
    '[TOC]', // 5 隐藏指令 ✅
    '@(笔记本)[标签]', // 6 隐藏指令 ✅
    '意外的一行', // 7 ⛔ 必须报
  ];
  const gaps = [1, 2, 3, 4, 5, 6, 7];
  const bad = LB.unknownGapLines(lines, gaps);
  assert.deepStrictEqual(
    bad.map(function (b) {
      return [b.line, b.text];
    }),
    [[8, '意外的一行']],
    '⚠️ 报出来的行号是 **1-based**（说人话用的那个）'
  );
});

test('块间行报警器：空行之后的缩进续行不算"定义续行"（判据依赖前一行）', function () {
  const lines = ['', '  缩进但没有定义在前'];
  assert.deepStrictEqual(
    LB.unknownGapLines(lines, [0, 1]).map(function (b) {
      return b.line;
    }),
    [2]
  );
});

test('locate：0-based 行下标 → 块；块外 ⇒ null', function () {
  const blocks = blocksOf(
    [
      [0, 3, 4, 1],
      [0, 6, 6, 1],
    ],
    7
  );
  assert.strictEqual(LB.locate(blocks, 2).startLine, 3);
  assert.strictEqual(LB.locate(blocks, 4), null, '第 5 行是块间行');
  assert.strictEqual(LB.locate(blocks, 5).startLine, 6);
  assert.strictEqual(LB.locate(blocks, 6), null);
});
