// 表格单元格：扁平下标、几何兜底、`|` 转义、换行 ↔ `<br>`、写回判定、布局冻结。
// 守的是 `INV-CELL-01/02/03/04` 与 `design/0058` 的候选判定顺序。
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

const C = load('src/live/cell.js').liveCell;

function cell(tag) {
  return { nodeType: 1, tagName: tag || 'TD' };
}

function table(rows) {
  return { rows: rows.map((cells) => ({ cells: cells })) };
}

function geoCell(rect) {
  return {
    nodeType: 1,
    tagName: 'TD',
    getBoundingClientRect: function () {
      return rect;
    },
  };
}

function rect(left, top, right, bottom) {
  return { left: left, top: top, right: right, bottom: bottom, width: right - left };
}

test('isCellNode 只认元素节点里的 td / th', () => {
  assert.strictEqual(C.isCellNode(cell('TD')), true);
  assert.strictEqual(C.isCellNode(cell('th')), true);
  assert.strictEqual(C.isCellNode(cell('tr')), false);
  assert.strictEqual(C.isCellNode({ nodeType: 3, tagName: 'TD' }), false);
  assert.strictEqual(C.isCellNode(null), false);
});

test('rowCounts 给出每行格子数，非表格给空数组', () => {
  assert.deepStrictEqual(C.rowCounts(table([[1, 2], [3], []])), [2, 1, 0]);
  assert.deepStrictEqual(C.rowCounts({}), []);
  assert.deepStrictEqual(C.rowCounts(null), []);
});

test('countCells 是各行格子数之和', () => {
  assert.strictEqual(C.countCells(table([[1, 2, 3], [4, 5]])), 5);
  assert.strictEqual(C.countCells(table([])), 0);
  assert.strictEqual(C.countCells(null), 0);
});

test('flatIndexOf 按行主序换算，不在这张表里给 -1', () => {
  const a = cell();
  const b = cell();
  const c = cell();
  const t = table([[a, b], [c]]);
  assert.strictEqual(C.flatIndexOf(t, a), 0);
  assert.strictEqual(C.flatIndexOf(t, b), 1);
  assert.strictEqual(C.flatIndexOf(t, c), 2);
  assert.strictEqual(C.flatIndexOf(t, cell()), -1);
  assert.strictEqual(C.flatIndexOf(null, a), -1);
});

test('cellAtIndex 与 flatIndexOf 互逆，非法下标给 null', () => {
  const a = cell();
  const b = cell();
  const t = table([[a], [b]]);
  assert.strictEqual(C.cellAtIndex(t, 0), a);
  assert.strictEqual(C.cellAtIndex(t, 1), b);
  assert.strictEqual(C.cellAtIndex(t, 2), null);
  assert.strictEqual(C.cellAtIndex(t, -1), null);
  assert.strictEqual(C.cellAtIndex(t, 0.5), null);
});

test('flatAfter 只加减一，越界给 -1，不环绕也不跨表', () => {
  const t = table([[1, 2], [3]]);
  assert.strictEqual(C.flatAfter(t, 0, 1), 1);
  assert.strictEqual(C.flatAfter(t, 1, 1), 2);
  assert.strictEqual(C.flatAfter(t, 2, 1), -1);
  assert.strictEqual(C.flatAfter(t, 0, -1), -1);
  assert.strictEqual(C.flatAfter(t, 1, -1), 0);
  assert.strictEqual(C.flatAfter(t, 1, 0), -1);
  assert.strictEqual(C.flatAfter(t, 0.5, 1), -1);
});

test('flatBelow 取同列下一行的扁平下标，末行给 -1', () => {
  const t = table([[0, 1, 2], [3, 4, 5]]);
  assert.strictEqual(C.flatBelow(t, 0), 3);
  assert.strictEqual(C.flatBelow(t, 2), 5);
  assert.strictEqual(C.flatBelow(t, 3), -1);
  assert.strictEqual(C.flatBelow(t, 9), -1);
  assert.strictEqual(C.flatBelow(t, -1), -1);
});

test('flatBelow 在下一行更短时不猜，给 -1', () => {
  const t = table([[0, 1, 2], [3]]);
  assert.strictEqual(C.flatBelow(t, 0), 3);
  assert.strictEqual(C.flatBelow(t, 1), -1);
});

test('flatAbove 取同列上一行，首行给 -1（不退出编辑）', () => {
  const t = table([[0, 1, 2], [3, 4, 5]]);
  assert.strictEqual(C.flatAbove(t, 3), 0);
  assert.strictEqual(C.flatAbove(t, 5), 2);
  assert.strictEqual(C.flatAbove(t, 0), -1);
  assert.strictEqual(C.flatAbove(t, 9), -1);
});

test('rectOf 拿不到合法矩形时给 null，不拿 0 冒充', () => {
  assert.strictEqual(C.rectOf(null), null);
  assert.strictEqual(C.rectOf({}), null);
  assert.strictEqual(C.rectOf({ getBoundingClientRect: () => ({ left: 0 }) }), null);
  assert.deepStrictEqual(C.rectOf(geoCell(rect(1, 2, 3, 4))), { left: 1, right: 3, top: 2, bottom: 4 });
});

test('cellAtPoint 先按 y 选行、再按 x 命中格', () => {
  const a = geoCell(rect(0, 0, 100, 20));
  const b = geoCell(rect(100, 0, 200, 20));
  const c = geoCell(rect(0, 20, 100, 40));
  const d = geoCell(rect(100, 20, 200, 40));
  const t = { rows: [{ cells: [a, b] }, { cells: [c, d] }] };
  assert.strictEqual(C.cellAtPoint(t, 150, 10), b);
  assert.strictEqual(C.cellAtPoint(t, 10, 30), c);
  assert.strictEqual(C.cellAtPoint(t, 150, 30), d);
});

test('cellAtPoint 左右越界只在容差内夹到首 / 末格', () => {
  const a = geoCell(rect(0, 0, 100, 20));
  const b = geoCell(rect(100, 0, 200, 20));
  const t = { rows: [{ cells: [a, b] }] };
  assert.strictEqual(C.cellAtPoint(t, -10, 10), a);
  assert.strictEqual(C.cellAtPoint(t, 210, 10), b);
  assert.strictEqual(C.cellAtPoint(t, -30, 10), null);
  assert.strictEqual(C.cellAtPoint(t, 250, 10), null);
});

test('cellAtPoint 离表太远、坐标非数字或没有行时都不猜', () => {
  const a = geoCell(rect(0, 0, 100, 20));
  const t = { rows: [{ cells: [a] }] };
  assert.strictEqual(C.cellAtPoint(t, 10, 100), null);
  assert.strictEqual(C.cellAtPoint(t, NaN, 10), null);
  assert.strictEqual(C.cellAtPoint(t, 10, Infinity), null);
  assert.strictEqual(C.cellAtPoint({ rows: [] }, 10, 10), null);
  assert.strictEqual(C.cellAtPoint(null, 10, 10), null);
});

test('escapePipes 只给裸竖线补反斜杠，已转义的竖线不再补', () => {
  assert.strictEqual(C.escapePipes('a|b'), 'a\\|b');
  assert.strictEqual(C.escapePipes('a\\|b'), 'a\\|b');
  assert.strictEqual(C.escapePipes('a\\\\|b'), 'a\\\\\\|b');
  assert.strictEqual(C.escapePipes('x\\y|z'), 'x\\y\\|z');
  assert.strictEqual(C.escapePipes('|'), '\\|');
});

test('trailingBackslashes 只数末尾连续反斜杠', () => {
  assert.strictEqual(C.trailingBackslashes('a\\\\'), 2);
  assert.strictEqual(C.trailingBackslashes('a\\'), 1);
  assert.strictEqual(C.trailingBackslashes('a'), 0);
  assert.strictEqual(C.trailingBackslashes('\\\\a'), 0);
});

test('encode 把换行写成 <br>，并统一 CRLF / CR', () => {
  assert.strictEqual(C.encode('a\nb'), 'a<br>b');
  assert.strictEqual(C.encode('a\r\nb'), 'a<br>b');
  assert.strictEqual(C.encode('a\rb'), 'a<br>b');
  assert.strictEqual(C.encode('a\nb\nc'), 'a<br>b<br>c');
});

test('encode 对换行前奇数个反斜杠补成偶数，避免 <br> 被转义', () => {
  assert.strictEqual(C.encode('a\\\nb'), 'a\\\\<br>b');
  assert.strictEqual(C.encode('a\\\\\nb'), 'a\\\\<br>b');
});

test('encode 换行后再转义竖线（顺序是承重的）', () => {
  assert.strictEqual(C.encode('a\nb|c'), 'a<br>b\\|c');
});

test('decode 只把 <br> 家族三种写法还原成换行，大小写不敏感', () => {
  assert.strictEqual(C.decode('a<br>b'), 'a\nb');
  assert.strictEqual(C.decode('a<br/>b'), 'a\nb');
  assert.strictEqual(C.decode('a<br />b'), 'a\nb');
  assert.strictEqual(C.decode('a<BR>b'), 'a\nb');
  assert.strictEqual(C.decode('a<br class=x>b'), 'a<br class=x>b');
});

test('decode 不解码代码 span 里的 <br>，成对等长反引号才算代码', () => {
  assert.strictEqual(C.decode('`a<br>b`'), '`a<br>b`');
  assert.strictEqual(C.decode('``a<br>b``'), '``a<br>b``');
  assert.strictEqual(C.decode('a`b<br>c'), 'a`b\nc');
});

test('decode 认转义对：\\<br> 是字面，\\` 不开启代码 span', () => {
  assert.strictEqual(C.decode('a\\<br>b'), 'a\\<br>b');
  assert.strictEqual(C.decode('a\\`x<br>y`'), 'a\\`x\ny`');
  assert.strictEqual(C.decode('a\\\\<br>b'), 'a\\\\\nb');
});

test('decode 把 \\| 还原成一个竖线，其余转义对原样保留', () => {
  assert.strictEqual(C.decode('a\\|b'), 'a|b');
  assert.strictEqual(C.decode('a\\<b'), 'a\\<b');
  assert.strictEqual(C.decode('a\\a<br>b'), 'a\\a\nb');
});

test('encode 与 decode 在普通文本与竖线上互为逆变换', () => {
  for (const view of ['a|b', 'a\nb', 'a\r\nb', '中文|换行\n下一行']) {
    assert.strictEqual(C.decode(C.encode(view)), view.replace(/\r\n?/g, '\n'));
  }
});

test('bind 同时产出原源码与进入时的视图文本，缺省值是空串 / 0 / null', () => {
  assert.deepStrictEqual(C.bind({ raw: 'a<br>b', from: 2, to: 4 }), {
    raw: 'a<br>b',
    initialView: 'a\nb',
    from: 2,
    to: 4,
    objectId: null,
    revision: null,
  });
  assert.deepStrictEqual(C.bind(), {
    raw: null,
    initialView: '',
    from: 0,
    to: 0,
    objectId: null,
    revision: null,
  });
});

test('judge 在区间不可信时先报 rejected，而不是读成没改动', () => {
  const b = C.bind({ raw: 'a', from: 9, to: 10 });
  assert.deepStrictEqual(C.judge(b, '|a|', 'a'), { status: 'rejected', why: 'range' });
  assert.deepStrictEqual(C.judge(C.bind(), '|a|', 'a'), { status: 'rejected', why: 'range' });
});

test('judge 在视图与进入时完全相同时报 unchanged，不写回', () => {
  const b = C.bind({ raw: 'a', from: 2, to: 3 });
  assert.deepStrictEqual(C.judge(b, 'x|a|', 'a'), { status: 'unchanged' });
});

test('judge 对真实改动给出编码、替换片段与整行结果', () => {
  const b = C.bind({ raw: 'a', from: 2, to: 3 });
  assert.deepStrictEqual(C.judge(b, 'x|a|', 'z|q'), {
    status: 'valid',
    encoded: 'z\\|q',
    replacement: 'z\\|q',
    nextLine: 'x|z\\|q|',
  });
});

test('judge 对编码后无法还原的视图报 inexpressible，保留输入', () => {
  const b = C.bind({ raw: 'a|b', from: 1, to: 4 });
  const out = C.judge(b, 'qa|bq', 'a\\|b');
  assert.strictEqual(out.status, 'rejected');
  assert.strictEqual(out.why, 'inexpressible');
});

test('judge 在内容以反斜杠结尾且右侧是竖线时补一个空格', () => {
  const b = C.bind({ raw: 'a', from: 1, to: 2 });
  const out = C.judge(b, '|a|b|', 'z\\');
  assert.strictEqual(out.status, 'valid');
  assert.strictEqual(out.encoded, 'z\\');
  assert.strictEqual(out.replacement, 'z\\ ');
  assert.strictEqual(out.nextLine, '|z\\ |b|');
});

test('padFor 只在末尾有反斜杠且插入点右边正好是竖线时补空格', () => {
  assert.strictEqual(C.padFor('|a|', 2, 'z\\'), 'z\\ ');
  assert.strictEqual(C.padFor('|a |', 2, 'z\\'), 'z\\');
  assert.strictEqual(C.padFor('|a|', 2, 'z'), 'z');
  assert.strictEqual(C.padFor(null, 2, 'z\\'), 'z\\');
  assert.strictEqual(C.padFor('|a|', 1.5, 'z\\'), 'z\\');
});

test('splice 只换区间内字节，越界或反向区间抛错', () => {
  assert.strictEqual(C.splice('|a|b|', 1, 2, 'xy'), '|xy|b|');
  assert.throws(() => C.splice('|a|', 0, 9, 'x'), /越界/);
  assert.throws(() => C.splice('|a|', 3, 2, 'x'), /越界/);
  assert.throws(() => C.splice('|a|', 0.5, 1, 'x'), /整数/);
  assert.throws(() => C.splice(null, 0, 1, 'x'), /不是字符串/);
});

test('textOf 对坏区间给 null，不猜内容', () => {
  assert.strictEqual(C.textOf('|a|', 1, 2), 'a');
  assert.strictEqual(C.textOf('|a|', 2, 1), null);
  assert.strictEqual(C.textOf('|a|', 0, 9), null);
  assert.strictEqual(C.textOf('|a|', 0.5, 1), null);
  assert.strictEqual(C.textOf(null, 0, 1), null);
});

test('isUnchanged 以「视图 == decode(源码)」判定，而不是编码后字节相等', () => {
  assert.strictEqual(C.isUnchanged('|a<br />b|', 1, 9, 'a\nb'), true);
  assert.strictEqual(C.isUnchanged('|a<br />b|', 1, 9, 'a<br />b'), false);
  assert.strictEqual(C.isUnchanged('|a|', 9, 10, 'a'), false);
});

function styleEl(rectBox, styleAttr) {
  const el = {
    style: {},
    attrs: styleAttr === undefined ? {} : { style: styleAttr },
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute: function (name, value) {
      this.attrs[name] = String(value);
    },
    removeAttribute: function (name) {
      this.removed = this.removed || [];
      this.removed.push(name);
      delete this.attrs[name];
    },
    getBoundingClientRect: function () {
      return rectBox;
    },
  };
  return el;
}

test('freezeTableLayout 先量宽再切 fixed，并用 border-box 写回量到的边框宽', () => {
  const c1 = styleEl({ width: 100 });
  const c2 = styleEl({ width: 200 });
  let tableLayoutDuringMeasure = 'not-measured';
  const t = styleEl({ width: 300 }, 'width: 500px');
  t.getBoundingClientRect = function () {
    tableLayoutDuringMeasure = t.style.tableLayout;
    return { width: 300 };
  };
  t.rows = [{ cells: [c1, c2] }];
  const restore = C.freezeTableLayout({ closest: () => t });
  assert.strictEqual(typeof restore, 'function');
  assert.strictEqual(tableLayoutDuringMeasure, undefined);
  assert.strictEqual(t.style.tableLayout, 'fixed');
  assert.strictEqual(t.style.boxSizing, 'border-box');
  assert.strictEqual(t.style.width, '300px');
  assert.strictEqual(c1.style.boxSizing, 'border-box');
  assert.strictEqual(c1.style.width, '100px');
  assert.strictEqual(c2.style.width, '200px');
});

test('freezeTableLayout 的还原函数逐字写回原 style 属性，没有就摘掉', () => {
  const c1 = styleEl({ width: 100 });
  const t = styleEl({ width: 300 }, 'width: 500px');
  t.rows = [{ cells: [c1] }];
  const restore = C.freezeTableLayout({ closest: () => t });
  restore();
  assert.strictEqual(t.attrs.style, 'width: 500px');
  assert.deepStrictEqual(c1.removed, ['style']);
  assert.strictEqual(c1.attrs.style, undefined);
});

test('freezeTableLayout 在没有 closest 或 rows 时返回 null，不假装冻结成功', () => {
  assert.strictEqual(C.freezeTableLayout(null), null);
  assert.strictEqual(C.freezeTableLayout({}), null);
  assert.strictEqual(C.freezeTableLayout({ closest: () => null }), null);
  assert.strictEqual(C.freezeTableLayout({ closest: () => ({}) }), null);
});
