// 编辑内核 · 装饰隐藏与行级计划（`markers` / `fenceOf` / `layoutSlack`）。
// 从 `docs/bugs/` 的 0016/0022/0023/0089/0090/0091/0092/0093/0102 倒推：
// 标记恒藏、Setext 下划线塌高、引用空行是段距、嵌套标题/代码补留白、列表标记不占正文宽度。
// 语法树用最小 fake（`enter`/`leave` 前序遍历 ＋ `parent` 链），⛔ 不引入 CM6。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load(rel, win) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  win = win || {};
  new Function('window', src)(win);
  return win.rmd;
}

// ⚠️ `live/decorations.js` 的列表 / 任务项几何走 `window.rmd.liveGeometry`
//    （取不到就抛 `live/geometry.js 必须先于 live/decorations.js 加载`）。
//    产品侧顺序由 `src/index.html` 保证；这里要自己按同一顺序喂进**同一个** window。
//    ⛔ 别为了省事在 decorations.js 里退回第二套公式——那会造出两个几何真相。
const W = {};
load('src/live/geometry.js', W);
const D = load('src/live/decorations.js', W).liveMarks;

/** 造一个带 parent 链的节点。 */
function mk(name, from, to, children) {
  const n = { name: name, from: from, to: to, children: children || [], parent: null };
  for (const c of n.children) c.parent = n;
  return n;
}

/** 造最小语法树：Document 根 ＋ 前序 enter/leave。 */
function makeTree(text, roots) {
  const doc = { name: 'Document', from: 0, to: text.length, children: roots, parent: null };
  for (const r of roots) r.parent = doc;
  return {
    iterate: function (cb) {
      (function walk(n) {
        cb.enter({ name: n.name, from: n.from, to: n.to, node: n });
        for (const c of n.children) walk(c);
        cb.leave({ name: n.name, from: n.from, to: n.to, node: n });
      })(doc);
    },
  };
}

function plan(text, roots, opts) {
  const o = opts || {};
  return D.markers(text, {
    tree: makeTree(text, roots),
    bodyLines: o.bodyLines,
    cellContext: o.cellContext,
  });
}

// 源自 docs/bugs/0016（只剩井号的行在编辑态被当成正文）
// 同轴向：空 ATX / 行尾井号 / 一级到六级都要按标题行处理，标记照藏。
test('# 单独一行也是标题：级别正确、井号藏掉、行首偏移对', () => {
  const p = plan('#\n', [mk('ATXHeading1', 0, 2, [mk('HeaderMark', 0, 1)])]);
  assert.deepStrictEqual(p.headings, [{ line: 0, level: 1, from: 0 }]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 1 }]);
});

test('## 没有正文的二级标题同样识别，标记区间覆盖两个井号', () => {
  const p = plan('##', [mk('ATXHeading2', 0, 2, [mk('HeaderMark', 0, 2)])]);
  assert.deepStrictEqual(p.headings, [{ line: 0, level: 2, from: 0 }]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 2 }]);
});

test('六级标题与标题后的一个空格一起藏，正文首字保留', () => {
  const p = plan('###### 字', [mk('ATXHeading6', 0, 9, [mk('HeaderMark', 0, 6)])]);
  assert.deepStrictEqual(p.headings, [{ line: 0, level: 6, from: 0 }]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 7 }]);
});

test('标题不藏前面的缩进：缩进是新的一行，不是标记', () => {
  const text = '  # h';
  const p = plan(text, [mk('ATXHeading1', 2, 5, [mk('HeaderMark', 2, 3)])]);
  assert.deepStrictEqual(p.headings, [{ line: 0, level: 1, from: 0 }]);
  assert.deepStrictEqual(p.ranges, [{ from: 2, to: 4 }]);
});

test('bodyLines 打开时把所有非标题行回落成正文尺度，含末尾幻影空行', () => {
  const text = '# h\ntext\n';
  const p = plan(text, [mk('ATXHeading1', 0, 3, [mk('HeaderMark', 0, 1)])], { bodyLines: true });
  assert.deepStrictEqual(p.headings, [{ line: 0, level: 1, from: 0 }]);
  assert.deepStrictEqual(p.bodies, [
    { line: 1, from: 4 },
    { line: 2, from: 9 },
  ]);
});

test('bodyLines 缺省关闭：bodies 恒为空', () => {
  const p = plan('# h\ntext\n', [mk('ATXHeading1', 0, 3, [mk('HeaderMark', 0, 1)])]);
  assert.deepStrictEqual(p.bodies, []);
});

// 源自 docs/bugs/0089（Setext标题进入编辑态高出一整行）
// 同轴向：多行 Setext 的每一行都是标题尺度，下划线行同时进 collapsedLines。
test('Setext 标题跨多行：每一行都标标题尺度，下划线行进塌高计划', () => {
  const text = 'a\nb\n===';
  const p = plan(text, [mk('SetextHeading1', 0, 7, [mk('HeaderMark', 4, 7)])]);
  assert.deepStrictEqual(p.headings, [
    { line: 0, level: 1, from: 0 },
    { line: 1, level: 1, from: 2 },
    { line: 2, level: 1, from: 4 },
  ]);
  assert.deepStrictEqual(p.collapsedLines, [{ line: 2, from: 4, to: 7 }]);
  assert.deepStrictEqual(p.ranges, [{ from: 4, to: 7 }]);
});

test('Setext 二级标题（---）同样塌下划线行，级别是 2', () => {
  const p = plan('a\n---', [mk('SetextHeading2', 0, 5, [mk('HeaderMark', 2, 5)])]);
  assert.deepStrictEqual(p.headings, [
    { line: 0, level: 2, from: 0 },
    { line: 1, level: 2, from: 2 },
  ]);
  assert.deepStrictEqual(p.collapsedLines, [{ line: 1, from: 2, to: 5 }]);
});

test('Setext ＋ bodyLines：没有可回落的正文行', () => {
  const p = plan('a\n===', [mk('SetextHeading1', 0, 5, [mk('HeaderMark', 2, 5)])], { bodyLines: true });
  assert.deepStrictEqual(p.bodies, []);
});

// 源自 docs/bugs/0022（就地编辑里行内样式全部丢失）
// 同轴向：强调 / 删除线 / 行内代码的标记藏掉，内容贴对应的行内类。
test('StrongEmphasis：内容贴 cm-rmd-strong，两侧 ** 都藏', () => {
  const text = '**a**';
  const p = plan(text, [mk('StrongEmphasis', 0, 5, [
    mk('EmphasisMark', 0, 2), mk('EmphasisMark', 3, 5),
  ])]);
  assert.deepStrictEqual(p.inline, [{ from: 0, to: 5, cls: 'cm-rmd-strong' }]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 2 }, { from: 3, to: 5 }]);
});

test('Emphasis：内容贴 cm-rmd-em，两侧下划线 / 星号都藏', () => {
  const p = plan('_a_', [mk('Emphasis', 0, 3, [
    mk('EmphasisMark', 0, 1), mk('EmphasisMark', 2, 3),
  ])]);
  assert.deepStrictEqual(p.inline, [{ from: 0, to: 3, cls: 'cm-rmd-em' }]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 1 }, { from: 2, to: 3 }]);
});

test('Strikethrough：内容贴 cm-rmd-strike，~~ 藏掉', () => {
  const p = plan('~~a~~', [mk('Strikethrough', 0, 5, [
    mk('StrikethroughMark', 0, 2), mk('StrikethroughMark', 3, 5),
  ])]);
  assert.deepStrictEqual(p.inline, [{ from: 0, to: 5, cls: 'cm-rmd-strike' }]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 2 }, { from: 3, to: 5 }]);
});

test('行内代码：反引号藏掉，内容贴 cm-rmd-code（与围栏同名节点靠父区分）', () => {
  const p = plan('`x`', [mk('InlineCode', 0, 3, [
    mk('CodeMark', 0, 1), mk('CodeMark', 2, 3),
  ])]);
  assert.deepStrictEqual(p.inline, [{ from: 0, to: 3, cls: 'cm-rmd-code' }]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 1 }, { from: 2, to: 3 }]);
});

test('链接：整个 Link 贴 cm-rmd-link，](url) 段整段藏、文字留下', () => {
  const text = '[a](u)';
  const p = plan(text, [mk('Link', 0, 6, [
    mk('LinkMark', 0, 1), mk('LinkMark', 2, 4), mk('URL', 4, 5),
  ])]);
  assert.deepStrictEqual(p.inline, [{ from: 0, to: 6, cls: 'cm-rmd-link' }]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 1 }, { from: 2, to: 5 }]);
});

test('自动链接只藏尖括号：URL 本身必须留在屏幕上', () => {
  const text = '<http://x>';
  const p = plan(text, [mk('Autolink', 0, 10, [
    mk('LinkMark', 0, 1), mk('URL', 1, 9), mk('LinkMark', 9, 10),
  ])]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 1 }, { from: 9, to: 10 }]);
  assert.deepStrictEqual(p.inline, []);
});

test('图片：![alt](src) 的标记全藏，alt 文字不贴链接色', () => {
  const text = '![a](u)';
  const p = plan(text, [mk('Image', 0, 7, [
    mk('LinkMark', 0, 2), mk('LinkMark', 3, 5), mk('URL', 5, 6),
  ])]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 2 }, { from: 3, to: 6 }]);
  assert.deepStrictEqual(p.inline, []);
});

test('链接标题跨行时整段放弃隐藏（⛔ 不做跨行 replace）', () => {
  const text = 'a\nb';
  const p = plan(text, [mk('Link', 0, 3, [mk('LinkTitle', 0, 3)])]);
  assert.deepStrictEqual(p.ranges, []);
});

// 源自 docs/bugs/0023（代码块编辑态仍然显示围栏行）
// 同轴向：每一条围栏行整行塌高，语言标记藏掉，代码内容原样。
test('围栏代码块：三条 CodeMark 语言标记藏，首末围栏行进 fenceLines', () => {
  const text = '```js\nx\n```';
  const p = plan(text, [mk('FencedCode', 0, 11, [
    mk('CodeMark', 0, 3), mk('CodeInfo', 3, 5),
    mk('CodeText', 6, 7),
    mk('CodeMark', 8, 11),
  ])]);
  assert.strictEqual(p.fenced, true);
  assert.deepStrictEqual(p.fenceLines, [
    { line: 0, from: 0, to: 5 },
    { line: 2, from: 8, to: 11 },
  ]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 5 }, { from: 8, to: 11 }]);
});

test('围栏没有语言标记时只有围栏符区间，fenceLines 照记', () => {
  const text = '```\nx\n```';
  const p = plan(text, [mk('FencedCode', 0, 9, [
    mk('CodeMark', 0, 3), mk('CodeText', 4, 5), mk('CodeMark', 6, 9),
  ])]);
  assert.deepStrictEqual(p.fenceLines, [
    { line: 0, from: 0, to: 3 },
    { line: 2, from: 6, to: 9 },
  ]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 3 }, { from: 6, to: 9 }]);
});

test('零宽围栏标记：只登记 fenceLines，不产出非法 replace 区间', () => {
  const text = '```';
  const p = plan(text, [mk('FencedCode', 0, 3, [mk('CodeMark', 0, 0)])]);
  assert.deepStrictEqual(p.ranges, []);
  assert.deepStrictEqual(p.fenceLines, [{ line: 0, from: 0, to: 3 }]);
  assert.strictEqual(p.fenced, true);
});

test('缩进代码块：CodeInfo 是行首缩进，藏掉；fenced 保持 false', () => {
  const text = '    code';
  const p = plan(text, [mk('CodeBlock', 0, 8, [mk('CodeInfo', 0, 4)])]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 4 }]);
  assert.strictEqual(p.fenced, false);
});

// 源自 docs/bugs/0093（硬换行的反斜杠在编辑态可见）
// 同轴向：只藏本行内那一段，⛔ 不吞换行。
test('反斜杠硬换行只藏反斜杠，换行与下一行不动', () => {
  const text = 'a\\\nb';
  const p = plan(text, [mk('HardBreak', 1, 3)]);
  assert.deepStrictEqual(p.ranges, [{ from: 1, to: 2 }]);
});

test('行尾两空格硬换行藏两个空格，不吞换行', () => {
  const text = 'a  \nb';
  const p = plan(text, [mk('HardBreak', 1, 4)]);
  assert.deepStrictEqual(p.ranges, [{ from: 1, to: 3 }]);
});

// 源自 docs/bugs/0092（列表标记占正文宽度改变折行点）
// 同轴向：列表标记从行首整段藏，内容起点、深度、品种、编号都由 markers 给出。
test('无序列表：每条 ListMark 从行首藏到标记后空白，contentFrom 是正文起点', () => {
  const text = '- a\n- b';
  const p = plan(text, [mk('BulletList', 0, 7, [
    mk('ListItem', 0, 3, [mk('ListMark', 0, 1)]),
    mk('ListItem', 4, 7, [mk('ListMark', 4, 5)]),
  ])]);
  assert.deepStrictEqual(p.listLines, [
    { line: 0, from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-', code: false },
    { line: 1, from: 4, contentFrom: 6, depth: 0, kind: 'bullet', marker: '-', code: false },
  ]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 2 }, { from: 4, to: 6 }]);
});

test('有序列表：显示编号按位置重排，源码 1. 1. 都变成 1. 2. 3.', () => {
  const text = '1. a\n1. b\n1. c';
  const p = plan(text, [mk('OrderedList', 0, 14, [
    mk('ListItem', 0, 4, [mk('ListMark', 0, 2)]),
    mk('ListItem', 5, 9, [mk('ListMark', 5, 7)]),
    mk('ListItem', 10, 14, [mk('ListMark', 10, 12)]),
  ])]);
  assert.deepStrictEqual(p.listLines.map((x) => x.marker), ['1.', '2.', '3.']);
  assert.deepStrictEqual(p.listLines.map((x) => x.contentFrom), [3, 8, 13]);
  assert.deepStrictEqual(p.listLines.map((x) => x.kind), ['ordered', 'ordered', 'ordered']);
});

test('有序列表从 7 起编号，后续按 8. 递增', () => {
  const text = '7. a\n1. b';
  const p = plan(text, [mk('OrderedList', 0, 9, [
    mk('ListItem', 0, 4, [mk('ListMark', 0, 2)]),
    mk('ListItem', 5, 9, [mk('ListMark', 5, 7)]),
  ])]);
  assert.deepStrictEqual(p.listLines.map((x) => x.marker), ['7.', '8.']);
});

test('嵌套列表：内层深度 1，外层深度 0，缩进都进隐藏区间', () => {
  const text = '- a\n  - b';
  const p = plan(text, [mk('BulletList', 0, 9, [
    mk('ListItem', 0, 9, [
      mk('ListMark', 0, 1),
      mk('BulletList', 4, 9, [mk('ListItem', 4, 9, [mk('ListMark', 6, 7)])]),
    ]),
  ])]);
  assert.deepStrictEqual(p.listLines.map((x) => [x.line, x.depth, x.contentFrom]), [
    [0, 0, 2],
    [1, 1, 8],
  ]);
});

test('引用块里的列表深度从 1 起（内层 ul 的缩进没有宿主可搬）', () => {
  const text = '> - a';
  const p = plan(text, [mk('Blockquote', 0, 5, [
    mk('BulletList', 2, 5, [mk('ListItem', 2, 5, [mk('ListMark', 2, 3)])]),
  ])]);
  assert.deepStrictEqual(p.listLines, [
    { line: 0, from: 0, contentFrom: 4, depth: 1, kind: 'bullet', marker: '-', code: false },
  ]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 4 }]);
});

test('任务项：类目是 task、勾选状态从源码读、方框落点等于正文起点', () => {
  const text = '- [x] done';
  const p = plan(text, [mk('BulletList', 0, 10, [
    mk('ListItem', 0, 10, [mk('ListMark', 0, 1), mk('TaskMarker', 2, 5)]),
  ])]);
  assert.deepStrictEqual(p.listLines, [
    { line: 0, from: 0, contentFrom: 6, depth: 0, kind: 'task', marker: '-', code: false, checked: true },
  ]);
  assert.deepStrictEqual(p.tasks, [{ pos: 6, checked: true }]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 6 }]);
});

test('未勾选任务项 checked=false，大写 X 也算勾选', () => {
  const text = '- [ ] a\n- [X] b';
  const p = plan(text, [mk('BulletList', 0, 15, [
    mk('ListItem', 0, 7, [mk('ListMark', 0, 1), mk('TaskMarker', 2, 5)]),
    mk('ListItem', 8, 15, [mk('ListMark', 8, 9), mk('TaskMarker', 10, 13)]),
  ])]);
  assert.deepStrictEqual(p.tasks, [{ pos: 6, checked: false }, { pos: 14, checked: true }]);
});

// 源自 docs/bugs/0102（列表续行缩进致编辑态整段右移）
// 同轴向：续行的行首缩进要藏，但代码块里的缩进是内容，⛔ 不能一起藏。
test('列表续行补深度，行首缩进也藏掉，contentFrom 指到正文', () => {
  const text = '- a\n  b';
  const p = plan(text, [mk('BulletList', 0, 7, [
    mk('ListItem', 0, 7, [mk('ListMark', 0, 1)]),
  ])]);
  assert.deepStrictEqual(p.listLines, [
    { line: 0, from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-', code: false },
    { line: 1, from: 4, contentFrom: 6, depth: 0, kind: 'plain', marker: '', code: false },
  ]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 2 }, { from: 4, to: 6 }]);
});

test('列表里的代码块：行首缩进是内容，续行缩进⛔ 不藏', () => {
  const text = '- a\n  ```\n  x\n  ```';
  const p = plan(text, [mk('BulletList', 0, 19, [
    mk('ListItem', 0, 19, [
      mk('ListMark', 0, 1),
      mk('FencedCode', 4, 19, [mk('CodeMark', 4, 7), mk('CodeText', 12, 13), mk('CodeMark', 14, 17)]),
    ]),
  ])]);
  assert.strictEqual(p.listLines.length, 4);
  assert.deepStrictEqual(p.listLines.map((x) => [x.line, x.contentFrom]), [
    [0, 2], [1, 4], [2, 10], [3, 14],
  ]);
  assert.deepStrictEqual(p.ranges.map((x) => [x.from, x.to]), [
    [0, 2], [4, 7], [14, 17],
  ]);
});

// 源自 docs/bugs/0090（引用块内的空行在编辑态独占一行）
// 同轴向：夹在内容之间的空引用行给段距行，开头 / 结尾 / 连续重复的塌成 0 高。
test('夹在内容之间的空引用行进 quoteGapLines，两端都是同一个行区间', () => {
  const text = '> a\n>\n> b';
  const p = plan(text, [mk('Blockquote', 0, 9, [
    mk('QuoteMark', 0, 1), mk('QuoteMark', 4, 5), mk('QuoteMark', 6, 7),
  ])]);
  assert.deepStrictEqual(p.quoteGapLines, [{ line: 1, from: 4, to: 5 }]);
  assert.deepStrictEqual(p.collapsedLines, []);
});

test('开头的空引用行在阅读态不存在，塌成 0 高', () => {
  const text = '>\n> a';
  const p = plan(text, [mk('Blockquote', 0, 5, [mk('QuoteMark', 0, 1), mk('QuoteMark', 2, 3)])]);
  assert.deepStrictEqual(p.quoteGapLines, []);
  assert.deepStrictEqual(p.collapsedLines, [{ line: 0, from: 0, to: 1 }]);
});

test('结尾的空引用行同样塌掉，最后一条真实行之后的幻影行不算内容', () => {
  const text = '> a\n>\n';
  const p = plan(text, [mk('Blockquote', 0, 6, [mk('QuoteMark', 0, 1), mk('QuoteMark', 4, 5)])]);
  assert.deepStrictEqual(p.quoteGapLines, []);
  assert.deepStrictEqual(p.collapsedLines, [{ line: 1, from: 4, to: 5 }]);
});

test('连续多条空引用行只让第一条承载段距，其余塌高', () => {
  const text = '> a\n>\n>\n> b';
  const p = plan(text, [mk('Blockquote', 0, 12, [
    mk('QuoteMark', 0, 1), mk('QuoteMark', 4, 5), mk('QuoteMark', 6, 7), mk('QuoteMark', 8, 9),
  ])]);
  assert.deepStrictEqual(p.quoteGapLines, [{ line: 1, from: 4, to: 5 }]);
  assert.deepStrictEqual(p.collapsedLines, [{ line: 2, from: 6, to: 7 }]);
});

test('引用标记给的空行判定看整行内容，不是只看行首字符', () => {
  const text = '> \n> a';
  const p = plan(text, [mk('Blockquote', 0, 6, [mk('QuoteMark', 0, 1), mk('QuoteMark', 3, 4)])]);
  assert.deepStrictEqual(p.collapsedLines, [{ line: 0, from: 0, to: 2 }]);
});

test('围栏里的 > 是代码内容：不参与空引用行分类', () => {
  const text = '> ```\n> >\n> ```';
  const p = plan(text, [mk('Blockquote', 0, 13, [
    mk('QuoteMark', 0, 1),
    mk('FencedCode', 2, 13, [mk('CodeMark', 2, 5), mk('QuoteMark', 7, 8), mk('CodeMark', 10, 13)]),
  ])]);
  assert.deepStrictEqual(p.quoteGapLines, []);
  assert.deepStrictEqual(p.collapsedLines, []);
});

// 源自 docs/bugs/0091（引用块内的代码块与标题在编辑态丢样式）
// 同轴向：嵌套标题补上/下留白，嵌套代码块逐内容行贴类。
test('引用块里的标题：首行补 before 留白，引用块 padding 折不掉外边距', () => {
  const text = '> # h';
  const p = plan(text, [mk('Blockquote', 0, 5, [
    mk('QuoteMark', 0, 1), mk('ATXHeading1', 2, 5, [mk('HeaderMark', 2, 3)]),
  ])]);
  assert.deepStrictEqual(p.nestedHeadingSpaces, [{ line: 0, from: 0, where: 'before' }]);
});

test('顶层列表项里的标题不补上方留白（外边距会折到列表外）', () => {
  const text = '- # h';
  const p = plan(text, [mk('BulletList', 0, 5, [
    mk('ListItem', 0, 5, [mk('ListMark', 0, 1), mk('ATXHeading1', 2, 5, [mk('HeaderMark', 2, 3)])]),
  ])]);
  assert.deepStrictEqual(p.nestedHeadingSpaces, []);
});

test('嵌套标题后面还有正文时补 after 留白', () => {
  const text = '> # h\n> 正文';
  const p = plan(text, [mk('Blockquote', 0, 10, [
    mk('QuoteMark', 0, 1), mk('ATXHeading1', 2, 5, [mk('HeaderMark', 2, 3)]),
    mk('QuoteMark', 6, 7),
  ])]);
  assert.deepStrictEqual(p.nestedHeadingSpaces, [
    { line: 0, from: 0, where: 'before' },
    { line: 0, from: 0, where: 'after' },
  ]);
});

test('嵌套标题紧邻空引用行的一侧不重复补留白', () => {
  const text = '>\n> # h\n>\n> b';
  const p = plan(text, [mk('Blockquote', 0, 12, [
    mk('QuoteMark', 0, 1), mk('QuoteMark', 2, 3),
    mk('ATXHeading1', 4, 7, [mk('HeaderMark', 4, 5)]),
    mk('QuoteMark', 8, 9), mk('QuoteMark', 10, 11),
  ])]);
  // 上方是空引用行（承载段距）⇒ 不补 before；下方同样不补 after。
  assert.deepStrictEqual(p.nestedHeadingSpaces, []);
  assert.deepStrictEqual(p.collapsedLines.map((x) => x.line), [0]);
});

test('引用块里的围栏代码：只给内容行贴代码类，首末行带 first/last，围栏行不贴', () => {
  const text = '> ```\n> x\n> y\n> ```';
  const p = plan(text, [mk('Blockquote', 0, 18, [
    mk('QuoteMark', 0, 1),
    mk('FencedCode', 2, 18, [
      mk('CodeMark', 2, 5), mk('CodeText', 8, 9),
      mk('CodeText', 12, 13), mk('CodeMark', 15, 18),
    ]),
  ])]);
  assert.deepStrictEqual(p.nestedCodeLines, [
    { line: 1, from: 6, first: true, last: false },
    { line: 2, from: 10, first: false, last: true },
  ]);
});

test('顶层围栏代码只靠 host 类，不重复登记嵌套代码行', () => {
  const p = plan('```\nx\n```', [mk('FencedCode', 0, 9, [
    mk('CodeMark', 0, 3), mk('CodeText', 4, 5), mk('CodeMark', 6, 9),
  ])]);
  assert.deepStrictEqual(p.nestedCodeLines, []);
});

test('HTML 块不登记嵌套代码行（它没有 mono / 底色那一套）', () => {
  const text = '> <div>';
  const p = plan(text, [mk('Blockquote', 0, 7, [
    mk('QuoteMark', 0, 1), mk('HTMLBlock', 2, 7),
  ])]);
  assert.deepStrictEqual(p.nestedCodeLines, []);
});

// 源自 docs/bugs/0034（格内文本被当成独立 markdown 文档）/ 0102（列表续行缩进致整段右移）
// 同轴向：单元格上下文只保留行内语义；代码块里的行首缩进是内容。
test('单元格里不认标题：HeaderMark 一个字节都不藏、不产标题行', () => {
  const text = '# 普通格子';
  const p = plan(text, [mk('ATXHeading1', 0, 6, [mk('HeaderMark', 0, 1)])], { cellContext: true });
  assert.deepStrictEqual(p.headings, []);
  assert.deepStrictEqual(p.ranges, []);
});

test('单元格里保留强调与行内代码的行内语义', () => {
  const p = plan('**a**', [mk('StrongEmphasis', 0, 5, [
    mk('EmphasisMark', 0, 2), mk('EmphasisMark', 3, 5),
  ])], { cellContext: true });
  assert.deepStrictEqual(p.inline, [{ from: 0, to: 5, cls: 'cm-rmd-strong' }]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 2 }, { from: 3, to: 5 }]);
});

test('单元格里的围栏 / 列表 / 引用标记不作为块级结构处理', () => {
  const text = '```\n- a\n> b';
  const p = plan(text, [mk('FencedCode', 0, 12, [
    mk('CodeMark', 0, 3), mk('ListMark', 5, 6), mk('QuoteMark', 8, 9),
  ])], { cellContext: true });
  assert.deepStrictEqual(p.ranges, []);
  assert.deepStrictEqual(p.fenceLines, []);
  assert.deepStrictEqual(p.listLines, []);
  assert.deepStrictEqual(p.quoteGapLines, []);
  assert.strictEqual(p.fenced, false);
});

// 区间合并与兜底。
test('相邻隐藏区间合并成一条，避免零宽 widget 之间插缓冲', () => {
  const p = plan('ab', [mk('QuoteMark', 0, 1), mk('EmphasisMark', 1, 2)]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 2 }]);
});

test('重叠隐藏区间合并成并集', () => {
  const p = plan('abcde', [mk('HeaderMark', 0, 3), mk('EmphasisMark', 2, 5)]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 5 }]);
});

test('越界区间被丢弃，⛔ 不把非法 replace 交给 CM6', () => {
  const p = plan('# x', [mk('HeaderMark', 0, 99)]);
  assert.deepStrictEqual(p.ranges, []);
});

test('空区间被丢弃，越界的 from 也不留', () => {
  const p = plan('# x', [mk('HeaderMark', 3, 3), mk('HeaderMark', -1, 2)]);
  assert.deepStrictEqual(p.ranges, []);
});

test('没有语法树时什么都不藏（可见降级），所有数组都是空', () => {
  const p = D.markers('# h\n- a');
  assert.deepStrictEqual(p.ranges, []);
  assert.deepStrictEqual(p.headings, []);
  assert.deepStrictEqual(p.bodies, []);
  assert.deepStrictEqual(p.inline, []);
  assert.deepStrictEqual(p.fenceLines, []);
  assert.deepStrictEqual(p.collapsedLines, []);
  assert.deepStrictEqual(p.listLines, []);
  assert.deepStrictEqual(p.tasks, []);
  assert.deepStrictEqual(p.quoteGapLines, []);
  assert.deepStrictEqual(p.nestedCodeLines, []);
  assert.deepStrictEqual(p.nestedHeadingSpaces, []);
  assert.strictEqual(p.fenced, false);
});

test('markers 是源码 + 树的纯函数：同样输入两次结果一致且不共享数组', () => {
  const text = '- a\n- b';
  const roots = function () {
    return [mk('BulletList', 0, 7, [
      mk('ListItem', 0, 3, [mk('ListMark', 0, 1)]),
      mk('ListItem', 4, 7, [mk('ListMark', 4, 5)]),
    ])];
  };
  const a = plan(text, roots());
  const b = plan(text, roots());
  assert.deepStrictEqual(a, b);
  assert.notStrictEqual(a.ranges, b.ranges);
  assert.notStrictEqual(a.listLines, b.listLines);
});

test('null / undefined 文本按空串处理，不抛错', () => {
  const p = D.markers(null, { tree: makeTree('', []) });
  assert.deepStrictEqual(p.ranges, []);
  assert.deepStrictEqual(D.markers(undefined).ranges, []);
});

test('中文 / 全角字符按 UTF-16 偏移切片，隐藏区间仍是码元坐标', () => {
  const text = '**中文**';
  const p = plan(text, [mk('StrongEmphasis', 0, 6, [
    mk('EmphasisMark', 0, 2), mk('EmphasisMark', 4, 6),
  ])]);
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 2 }, { from: 4, to: 6 }]);
  assert.deepStrictEqual(p.inline, [{ from: 0, to: 6, cls: 'cm-rmd-strong' }]);
});

// fenceOf。
test('fenceOf 认 ``` 与 ~~~ 两种围栏，前导空白不影响', () => {
  assert.strictEqual(D.fenceOf('```'), '`');
  assert.strictEqual(D.fenceOf('```js'), '`');
  assert.strictEqual(D.fenceOf('  ```'), '`');
  assert.strictEqual(D.fenceOf('~~~'), '~');
  assert.strictEqual(D.fenceOf('  ~~~js'), '~');
  assert.strictEqual(D.fenceOf('````'), '`');
});

test('fenceOf 对行内代码、两连反引号、普通正文都返回 null', () => {
  assert.strictEqual(D.fenceOf('`x`'), null);
  assert.strictEqual(D.fenceOf('``'), null);
  assert.strictEqual(D.fenceOf('text'), null);
  assert.strictEqual(D.fenceOf(''), null);
  assert.strictEqual(D.fenceOf(null), null);
});

// layoutSlack：几何允许量。
test('layoutSlack 空源码零行，null 同空串', () => {
  assert.deepStrictEqual(D.layoutSlack(''), { fences: 0, blanks: 0, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack(null), { fences: 0, blanks: 0, softWraps: 0 });
});

test('layoutSlack 连续正文行按"多占的整行数"计软换行', () => {
  assert.deepStrictEqual(D.layoutSlack('a\nb\nc'), { fences: 0, blanks: 0, softWraps: 2 });
  assert.deepStrictEqual(D.layoutSlack('a\nb'), { fences: 0, blanks: 0, softWraps: 1 });
  assert.deepStrictEqual(D.layoutSlack('a'), { fences: 0, blanks: 0, softWraps: 0 });
});

test('layoutSlack 空白行与空引用行都算段距，并打断正文合并', () => {
  assert.deepStrictEqual(D.layoutSlack('a\n\nb'), { fences: 0, blanks: 1, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack('>\n>\n'), { fences: 0, blanks: 3, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack('a\nb\n\nc\nd\ne'), { fences: 0, blanks: 1, softWraps: 3 });
});

test('layoutSlack 标题与列表项各自成块，不参与正文合并', () => {
  assert.deepStrictEqual(D.layoutSlack('# h\na\nb'), { fences: 0, blanks: 0, softWraps: 1 });
  assert.deepStrictEqual(D.layoutSlack('- a\n- b'), { fences: 0, blanks: 0, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack('1) a\n2) b'), { fences: 0, blanks: 0, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack('* a\n+ b'), { fences: 0, blanks: 0, softWraps: 0 });
});

test('layoutSlack 围栏内部不计数：里面的空行与连续行都不是段距 / 软换行', () => {
  assert.deepStrictEqual(D.layoutSlack('```\na\n\nb\n```'), { fences: 0, blanks: 0, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack('a\n```\nb\nc\n```\nd'), { fences: 0, blanks: 0, softWraps: 0 });
});

test('layoutSlack 围栏只认成对的同一种，⛔ 不把反引号里的波浪线当围栏', () => {
  // 第一个 ``` 开围栏后，~~~ 只是代码内容，不关围栏；末尾的 ``` 才关。
  assert.deepStrictEqual(D.layoutSlack('```\n~~~\nx\n```\n'), { fences: 0, blanks: 0, softWraps: 0 });
});

test('layoutSlack 引用前缀先剥掉再判标题 / 列表', () => {
  assert.deepStrictEqual(D.layoutSlack('> # h\n> a\n> b'), { fences: 0, blanks: 0, softWraps: 1 });
  assert.deepStrictEqual(D.layoutSlack('> - a\n> - b'), { fences: 0, blanks: 0, softWraps: 0 });
});
