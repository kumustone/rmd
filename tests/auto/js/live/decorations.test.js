// 装饰层：从语法树算隐藏区间、行内呈现、围栏 / 列表 / 引用行元数据、结构差**诊断量**
// （⚠️ 2026-11-09 起 `layoutSlack` 不是几何允许量：`INV-LIVE-04` ① 要求进入瞬间块高差为 0）。
// 守的是 `design/0061` L1「隐藏集合是源码的纯函数」与 `INV-LIVE-14`。
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

function n(name, from, to) {
  return { name: name, from: from, to: to, children: [], node: { name: name, parent: null } };
}

function add(parent) {
  for (let i = 1; i < arguments.length; i++) {
    const kid = arguments[i];
    parent.children.push(kid);
    kid.node.parent = parent.node;
  }
  return parent;
}

function tree(root) {
  return {
    iterate: function (visitor) {
      (function walk(node) {
        if (visitor.enter) visitor.enter(node);
        node.children.forEach(walk);
        if (visitor.leave) visitor.leave(node);
      })(root);
    },
  };
}

function documentOf() {
  return add.apply(null, [n('Document', 0, 10000)].concat(Array.prototype.slice.call(arguments)));
}

test('没有语法树时一个标记都不藏（可见降级）', () => {
  const out = D.markers('# 标题 **粗**', {});
  assert.deepStrictEqual(out.ranges, []);
  assert.deepStrictEqual(out.headings, []);
  assert.deepStrictEqual(out.inline, []);
  assert.strictEqual(out.fenced, false);
});

test('标题标记连同后面一个空格一起藏，并标出标题行', () => {
  const h = add(n('ATXHeading1', 0, 4), n('HeaderMark', 0, 1));
  const out = D.markers('# 标题', { tree: tree(documentOf(h)) });
  assert.deepStrictEqual(out.ranges, [{ from: 0, to: 2 }]);
  assert.deepStrictEqual(out.headings, [{ line: 0, level: 1, from: 0 }]);
});

test('强调标记藏掉，内容整段贴 cm-rmd-strong', () => {
  const strong = add(n('StrongEmphasis', 0, 5), n('EmphasisMark', 0, 2), n('EmphasisMark', 3, 5));
  const out = D.markers('**粗**', { tree: tree(documentOf(add(n('Paragraph', 0, 5), strong))) });
  assert.deepStrictEqual(out.ranges, [{ from: 0, to: 2 }, { from: 3, to: 5 }]);
  assert.deepStrictEqual(out.inline, [{ from: 0, to: 5, cls: 'cm-rmd-strong' }]);
});

test('行内代码藏反引号并贴 cm-rmd-code', () => {
  const code = add(n('InlineCode', 0, 3), n('CodeMark', 0, 1), n('CodeMark', 2, 3));
  const out = D.markers('`x`', { tree: tree(documentOf(add(n('Paragraph', 0, 3), code))) });
  assert.deepStrictEqual(out.ranges, [{ from: 0, to: 1 }, { from: 2, to: 3 }]);
  assert.deepStrictEqual(out.inline, [{ from: 0, to: 3, cls: 'cm-rmd-code' }]);
});

test('链接的标记与 URL 整段藏掉，整条链接贴 cm-rmd-link', () => {
  const link = add(
    n('Link', 0, 6),
    n('LinkMark', 0, 1),
    n('LinkMark', 2, 4),
    n('URL', 4, 5)
  );
  const out = D.markers('[a](u)', { tree: tree(documentOf(add(n('Paragraph', 0, 6), link))) });
  assert.deepStrictEqual(out.ranges, [{ from: 0, to: 1 }, { from: 2, to: 5 }]);
  assert.deepStrictEqual(out.inline, [{ from: 0, to: 6, cls: 'cm-rmd-link' }]);
});

test('Autolink 里的 URL 不藏，避免整条链接凭空消失', () => {
  const auto = add(n('Autolink', 0, 8), n('LinkMark', 0, 1), n('URL', 1, 7), n('LinkMark', 7, 8));
  const out = D.markers('<http://x>', { tree: tree(documentOf(add(n('Paragraph', 0, 10), auto))) });
  assert.deepStrictEqual(out.ranges, [{ from: 0, to: 1 }, { from: 7, to: 8 }]);
});

test('围栏代码：语言标记与围栏符都藏，两条围栏行登记为塌高行', () => {
  const code = add(
    n('FencedCode', 0, 11),
    n('CodeMark', 0, 3),
    n('CodeInfo', 3, 5),
    n('CodeText', 6, 7),
    n('CodeMark', 8, 11)
  );
  const src = '```js\nx\n```\n';
  const out = D.markers(src, { tree: tree(documentOf(code)) });
  assert.strictEqual(out.fenced, true);
  assert.deepStrictEqual(out.ranges, [{ from: 0, to: 5 }, { from: 8, to: 11 }]);
  assert.deepStrictEqual(out.fenceLines, [
    { line: 0, from: 0, to: 5 },
    { line: 2, from: 8, to: 11 },
  ]);
});

test('Setext 下划线行既藏标记也纳入塌高行', () => {
  const h = add(n('SetextHeading1', 0, 5), n('HeaderMark', 2, 5));
  const out = D.markers('a\n===', { tree: tree(documentOf(h)) });
  assert.deepStrictEqual(out.ranges, [{ from: 2, to: 5 }]);
  assert.deepStrictEqual(out.headings, [
    { line: 0, level: 1, from: 0 },
    { line: 1, level: 1, from: 2 },
  ]);
  assert.deepStrictEqual(out.collapsedLines, [{ line: 1, from: 2, to: 5 }]);
});

test('带 bodyLines 时非标题行显式回落正文尺度', () => {
  const h = add(n('ATXHeading1', 0, 3), n('HeaderMark', 0, 1));
  const out = D.markers('# h\ntext\n', { bodyLines: true, tree: tree(documentOf(h)) });
  assert.deepStrictEqual(out.headings, [{ line: 0, level: 1, from: 0 }]);
  assert.deepStrictEqual(out.bodies, [
    { line: 1, from: 4 },
    { line: 2, from: 9 },
  ]);
});

test('列表标记从行首藏到正文起点，续行缩进也一起藏', () => {
  const list = add(n('BulletList', 0, 7), n('ListItem', 0, 7), n('ListMark', 0, 1));
  const out = D.markers('- a\n  b', { tree: tree(documentOf(list)) });
  assert.deepStrictEqual(out.ranges, [{ from: 0, to: 2 }, { from: 4, to: 6 }]);
  assert.deepStrictEqual(out.listLines, [
    { line: 0, from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '-', code: false },
    { line: 1, from: 4, contentFrom: 6, depth: 0, kind: 'plain', marker: '', code: false },
  ]);
});

test('有序列表按位置重编号，不照抄源码里的数字', () => {
  const list = add(
    n('OrderedList', 0, 9),
    n('ListItem', 0, 4),
    n('ListMark', 0, 2),
    n('ListItem', 5, 9),
    n('ListMark', 5, 7)
  );
  const out = D.markers('1. a\n1. b', { tree: tree(documentOf(list)) });
  assert.deepStrictEqual(out.ranges, [{ from: 0, to: 3 }, { from: 5, to: 8 }]);
  assert.deepStrictEqual(out.listLines.map((x) => [x.kind, x.marker, x.contentFrom]), [
    ['ordered', '1.', 3],
    ['ordered', '2.', 8],
  ]);
});

test('任务项标记藏掉并在正文起点给方框落点，未勾选为 false', () => {
  const list = add(
    n('BulletList', 0, 7),
    n('ListItem', 0, 7),
    n('ListMark', 0, 1),
    n('TaskMarker', 2, 5)
  );
  const out = D.markers('- [ ] t', { tree: tree(documentOf(list)) });
  assert.deepStrictEqual(out.ranges, [{ from: 0, to: 6 }]);
  assert.deepStrictEqual(out.tasks, [{ pos: 6, checked: false }]);
  assert.deepStrictEqual(
    out.listLines.map((x) => [x.kind, x.contentFrom]),
    [['task', 6]]
  );
});

test('任务项写成 [x] 或 [X] 时 checked 为 true', () => {
  for (const sym of ['x', 'X']) {
    const list = add(
      n('BulletList', 0, 7),
      n('ListItem', 0, 7),
      n('ListMark', 0, 1),
      n('TaskMarker', 2, 5)
    );
    const src = '- [' + sym + '] t';
    const out = D.markers(src, { tree: tree(documentOf(list)) });
    assert.deepStrictEqual(out.tasks, [{ pos: 6, checked: true }], src);
  }
});

test('硬换行的反斜杠只藏本行内那一段，不吞换行', () => {
  const p = add(n('Paragraph', 0, 4), n('HardBreak', 1, 2));
  const out = D.markers('a\\\nb', { tree: tree(documentOf(p)) });
  assert.deepStrictEqual(out.ranges, [{ from: 1, to: 2 }]);
});

test('单元格上下文只保留行内语义：不认标题、不藏标题标记', () => {
  const h = add(
    n('ATXHeading1', 0, 7),
    n('HeaderMark', 0, 2),
    add(n('StrongEmphasis', 2, 7), n('EmphasisMark', 2, 4), n('EmphasisMark', 5, 7))
  );
  const out = D.markers('# **x**', { cellContext: true, tree: tree(documentOf(h)) });
  assert.deepStrictEqual(out.headings, []);
  assert.deepStrictEqual(out.ranges, [{ from: 2, to: 4 }, { from: 5, to: 7 }]);
  assert.deepStrictEqual(out.inline, [{ from: 2, to: 7, cls: 'cm-rmd-strong' }]);
});

test('单元格上下文不藏列表与任务标记，也不产列表行', () => {
  const list = add(
    n('BulletList', 0, 7),
    n('ListItem', 0, 7),
    n('ListMark', 0, 1),
    n('TaskMarker', 2, 5)
  );
  const out = D.markers('- [ ] t', { cellContext: true, tree: tree(documentOf(list)) });
  assert.deepStrictEqual(out.ranges, []);
  assert.deepStrictEqual(out.listLines, []);
  assert.deepStrictEqual(out.tasks, []);
});

test('引用块里的空行只在夹着内容时承载段距，连续多条只留第一条', () => {
  const q = add(
    n('Blockquote', 0, 10),
    n('Paragraph', 0, 2),
    n('QuoteMark', 0, 1),
    n('Paragraph', 4, 5),
    n('QuoteMark', 4, 5),
    n('Paragraph', 6, 7),
    n('QuoteMark', 6, 7),
    n('Paragraph', 8, 10),
    n('QuoteMark', 8, 9)
  );
  const out = D.markers('> a\n>\n>\n> b', { tree: tree(documentOf(q)) });
  assert.deepStrictEqual(out.quoteGapLines, [{ line: 1, from: 4, to: 5 }]);
  assert.deepStrictEqual(out.collapsedLines, [{ line: 2, from: 6, to: 7 }]);
});

test('引用块开头或结尾的空行没有段距，直接塌成 0 高', () => {
  const lead = add(
    n('Blockquote', 0, 6),
    n('QuoteMark', 0, 1),
    n('Paragraph', 2, 4),
    n('QuoteMark', 2, 3)
  );
  const outLead = D.markers('>\n> a', { tree: tree(documentOf(lead)) });
  assert.deepStrictEqual(outLead.quoteGapLines, []);
  assert.deepStrictEqual(outLead.collapsedLines, [{ line: 0, from: 0, to: 1 }]);

  const tail = add(
    n('Blockquote', 0, 6),
    n('Paragraph', 0, 2),
    n('QuoteMark', 0, 1),
    n('QuoteMark', 4, 5)
  );
  const outTail = D.markers('> a\n>', { tree: tree(documentOf(tail)) });
  assert.deepStrictEqual(outTail.quoteGapLines, []);
  assert.deepStrictEqual(outTail.collapsedLines, [{ line: 1, from: 4, to: 5 }]);
});

test('引用块里的代码块逐内容行登记，首末行各标 first / last', () => {
  const fenced = add(
    n('FencedCode', 2, 15),
    n('CodeMark', 2, 5),
    n('CodeText', 8, 9),
    n('CodeMark', 12, 15)
  );
  const q = add(n('Blockquote', 0, 15), fenced);
  const out = D.markers('> ```\n> x\n> ```', { tree: tree(documentOf(q)) });
  assert.deepStrictEqual(out.fenceLines, [
    { line: 0, from: 0, to: 5 },
    { line: 2, from: 10, to: 15 },
  ]);
  assert.deepStrictEqual(out.nestedCodeLines, [
    { line: 1, from: 6, first: true, last: true },
  ]);
});

test('引用块里的标题补上 / 下留白行，但不重复标题标记', () => {
  const h = add(n('ATXHeading1', 2, 5), n('HeaderMark', 2, 3));
  const p = add(n('Paragraph', 6, 12), n('QuoteMark', 6, 7));
  const q = add(n('Blockquote', 0, 12), h, p);
  const out = D.markers('> # q\n> body', { tree: tree(documentOf(q)) });
  assert.deepStrictEqual(out.ranges, [{ from: 2, to: 4 }, { from: 6, to: 8 }]);
  assert.deepStrictEqual(out.nestedHeadingSpaces, [
    { line: 0, from: 0, where: 'before' },
    { line: 0, from: 0, where: 'after' },
  ]);
});

test('相邻隐藏区间合并，越界 / 空区间被丢弃', () => {
  const a = add(n('Emphasis', 0, 2), n('EmphasisMark', 0, 1), n('EmphasisMark', 1, 2));
  const out = D.markers('ab', { tree: tree(documentOf(add(n('Paragraph', 0, 2), a))) });
  assert.deepStrictEqual(out.ranges, [{ from: 0, to: 2 }]);

  const bad = add(n('Paragraph', 0, 2), n('EmphasisMark', 1, 99), n('EmphasisMark', 2, 1));
  const outBad = D.markers('ab', { tree: tree(documentOf(bad)) });
  assert.deepStrictEqual(outBad.ranges, []);
});

test('fenceOf 认 ``` 与 ~~~，普通反引号不算围栏', () => {
  assert.strictEqual(D.fenceOf('```js'), '`');
  assert.strictEqual(D.fenceOf('  ~~~'), '~');
  assert.strictEqual(D.fenceOf('`a`'), null);
  assert.strictEqual(D.fenceOf('``'), null);
});

test('layoutSlack 数连续正文行、空行与引用空行，围栏内不计', () => {
  assert.deepStrictEqual(D.layoutSlack(''), { fences: 0, blanks: 0, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack('a\nb'), { fences: 0, blanks: 0, softWraps: 1 });
  assert.deepStrictEqual(D.layoutSlack('a\nb\nc'), { fences: 0, blanks: 0, softWraps: 2 });
  assert.deepStrictEqual(D.layoutSlack('a\n\nb'), { fences: 0, blanks: 1, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack('```\na\n```'), { fences: 0, blanks: 0, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack('~~~\n\n~~~'), { fences: 0, blanks: 0, softWraps: 0 });
});

test('layoutSlack 让标题行与列表行断开连续段', () => {
  assert.deepStrictEqual(D.layoutSlack('# h\nbody'), { fences: 0, blanks: 0, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack('- a\n  b'), { fences: 0, blanks: 0, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack('a\n# h\nb'), { fences: 0, blanks: 0, softWraps: 0 });
});

test('layoutSlack 把只剩引用标记的行当空行，不按引用后的正文算', () => {
  assert.deepStrictEqual(D.layoutSlack('> \n>'), { fences: 0, blanks: 2, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack('> a\n> b'), { fences: 0, blanks: 0, softWraps: 1 });
});
