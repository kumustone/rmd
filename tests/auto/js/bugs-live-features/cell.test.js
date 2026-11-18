// 表格单元格编辑功能层：扁平配对、布局冻结、换行 ↔ <br>、竖线转义、末尾反斜杠补位、
// 无首尾竖线的表、<br> 不改也判脏、Tab/方向键跨格、点到行尾的几何兜底。
// 每条都从 `docs/bugs/` 的历史缺陷出发，断言落在返回值 / 写回文本 / 拒绝原因上。
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
  return { rows: rows.map(function (cells) { return { cells: cells }; }) };
}

function rect(left, top, right, bottom) {
  return { left: left, top: top, right: right, bottom: bottom, width: right - left };
}

function geoCell(r) {
  return {
    nodeType: 1,
    tagName: 'TD',
    getBoundingClientRect: function () { return r; },
  };
}

function styleEl(r, styleAttr) {
  const el = {
    style: {},
    attrs: styleAttr === undefined ? {} : { style: styleAttr },
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute: function (name, value) { this.attrs[name] = String(value); },
    removeAttribute: function (name) {
      this.removed = this.removed || [];
      this.removed.push(name);
      delete this.attrs[name];
    },
    getBoundingClientRect: function () { return r; },
  };
  return el;
}

// ── 源自 docs/bugs/0026（点击表格里的文字它会消失）──────────────────────
// 纯逻辑侧守的是「DOM 行主序 ↔ 载荷扁平下标」这一处唯一换算；配错一格，
// 屏幕上就是点 A 格改 B 格（看起来像文字消失）。

test('0026 单元格配对只认元素节点里的 TD / TH，大小写不敏感', () => {
  assert.strictEqual(C.isCellNode(cell('TD')), true);
  assert.strictEqual(C.isCellNode(cell('th')), true);
  assert.strictEqual(C.isCellNode(cell('TR')), false);
  assert.strictEqual(C.isCellNode({ nodeType: 3, tagName: 'TD' }), false);
  assert.strictEqual(C.isCellNode({ nodeType: 1, tagName: 'TD ' }), false);
});

test('0026 表头行与数据行走同一套行主序，th 不被当成另一类', () => {
  const th = cell('TH');
  const a = cell();
  const b = cell();
  const t = table([[th, a], [b]]);
  assert.strictEqual(C.flatIndexOf(t, th), 0);
  assert.strictEqual(C.flatIndexOf(t, a), 1);
  assert.strictEqual(C.flatIndexOf(t, b), 2);
  assert.strictEqual(C.countCells(t), 3);
});

test('0026 没有 cells 的行被跳过，不让扁平下标虚增', () => {
  const a = cell();
  const b = cell();
  const t = { rows: [{}, { cells: [a, b] }, { cells: [] }] };
  assert.deepStrictEqual(C.rowCounts(t), [0, 2, 0]);
  assert.strictEqual(C.flatIndexOf(t, a), 0);
  assert.strictEqual(C.flatIndexOf(t, b), 1);
  assert.strictEqual(C.cellAtIndex(t, 1), b);
});

test('0026 空表 / 非表对象给出空行数和零格，不抛错', () => {
  assert.deepStrictEqual(C.rowCounts({}), []);
  assert.deepStrictEqual(C.rowCounts(null), []);
  assert.strictEqual(C.countCells({ rows: [] }), 0);
  assert.strictEqual(C.countCells(undefined), 0);
});

test('0026 cellAtIndex 对负数 / 小数 / 越界 / 非数字一律 null，不夹取', () => {
  const t = table([[cell()]]);
  assert.strictEqual(C.cellAtIndex(t, -1), null);
  assert.strictEqual(C.cellAtIndex(t, 0.5), null);
  assert.strictEqual(C.cellAtIndex(t, 1), null);
  assert.strictEqual(C.cellAtIndex(t, NaN), null);
  assert.strictEqual(C.cellAtIndex(t, '0'), null);
});

test('0026 flatIndexOf 对不在本表的节点给 -1，不跨表猜测', () => {
  const a = cell();
  const t = table([[a]]);
  assert.strictEqual(C.flatIndexOf(t, cell()), -1);
  assert.strictEqual(C.flatIndexOf(t, null), -1);
  assert.strictEqual(C.flatIndexOf(null, a), -1);
});

// ── 源自 docs/bugs/0027（进入表格单元格编辑时整张表长高 12px）────────────
// 冻结必须是「先量 → 写宽 → 切 fixed」；量到的是边框盒，所以写回必须带 border-box。

test('0027 冻结先量再切 fixed，表格与每格都写 border-box', () => {
  const c1 = styleEl({ width: 100 });
  const c2 = styleEl({ width: 200 });
  let duringMeasure = 'not-measured';
  const t = styleEl({ width: 300 }, 'width: 500px');
  t.getBoundingClientRect = function () {
    duringMeasure = t.style.tableLayout;
    return { width: 300 };
  };
  t.rows = [{ cells: [c1, c2] }];
  const restore = C.freezeTableLayout({ closest: function () { return t; } });
  assert.strictEqual(typeof restore, 'function');
  assert.strictEqual(duringMeasure, undefined);
  assert.strictEqual(t.style.tableLayout, 'fixed');
  assert.strictEqual(t.style.boxSizing, 'border-box');
  assert.strictEqual(t.style.width, '300px');
  assert.strictEqual(c1.style.boxSizing, 'border-box');
  assert.strictEqual(c2.style.width, '200px');
});

test('0027 冻结只按首行量到的列数写后续行，第二行多出的格子不写', () => {
  const a = styleEl({ width: 10 });
  const b = styleEl({ width: 20 });
  const c = styleEl({ width: 30 });
  const t = styleEl({ width: 60 });
  t.rows = [{ cells: [a, b] }, { cells: [a, b, c] }];
  C.freezeTableLayout({ closest: function () { return t; } });
  assert.strictEqual(c.style.width, undefined);
  assert.strictEqual(c.style.boxSizing, undefined);
});

test('0027 量为 0 的列宽不写 0px，交给 fixed 自己分配', () => {
  const a = styleEl({ width: 0 });
  const b = styleEl({ width: 120 });
  const t = styleEl({ width: 120 });
  t.rows = [{ cells: [a, b] }];
  C.freezeTableLayout({ closest: function () { return t; } });
  assert.strictEqual(a.style.width, undefined);
  assert.strictEqual(a.style.boxSizing, undefined);
  assert.strictEqual(b.style.width, '120px');
});

test('0297 整表量到 0 宽时表宽退回列宽和（⛔ 不写 0px），仍切成 fixed', () => {
  // 2026-11-09 改判（`bugs/0297`）：表宽改口径为「列宽和」（`display:block` 的块盒铺满正文栏，
  // 拿它当表宽会把短表拉满）⇒ 块盒量到 0 时写的是列宽和，不再留空。判据与产品侧
  // `tests/js/live-cell.test.js`「量到 0 的宽不钉」一致。
  const a = styleEl({ width: 50 });
  const t = styleEl({ width: 0 });
  t.rows = [{ cells: [a] }];
  C.freezeTableLayout({ closest: function () { return t; } });
  assert.strictEqual(t.style.width, '50px');
  assert.strictEqual(t.style.boxSizing, 'border-box');
  assert.strictEqual(t.style.tableLayout, 'fixed');
  assert.strictEqual(a.style.width, '50px');
  // 列宽和也是 0 ⇒ 仍然⛔ 不写宽（别写 0px 把表压没）
  const z = styleEl({ width: 0 });
  z.rows = [{ cells: [styleEl({ width: 0 })] }];
  C.freezeTableLayout({ closest: function () { return z; } });
  assert.strictEqual(z.style.width, undefined);
  assert.strictEqual(z.style.boxSizing, undefined);
  assert.strictEqual(z.style.tableLayout, 'fixed');
});

test('0027 还原逐字写回原始 style 属性，原本没有的就摘掉属性', () => {
  const c1 = styleEl({ width: 100 }, 'color: red');
  const c2 = styleEl({ width: 100 });
  const t = styleEl({ width: 200 }, 'width: 500px; margin: 0');
  t.rows = [{ cells: [c1, c2] }];
  const restore = C.freezeTableLayout({ closest: function () { return t; } });
  restore();
  assert.strictEqual(t.attrs.style, 'width: 500px; margin: 0');
  assert.strictEqual(c1.attrs.style, 'color: red');
  assert.deepStrictEqual(c2.removed, ['style']);
});

test('0027 没有 closest / 没有 rows 时返回 null，不假装冻结成功', () => {
  assert.strictEqual(C.freezeTableLayout(null), null);
  assert.strictEqual(C.freezeTableLayout({}), null);
  assert.strictEqual(C.freezeTableLayout({ closest: function () { return null; } }), null);
  assert.strictEqual(C.freezeTableLayout({ closest: function () { return {}; } }), null);
});

test('0027 空表仍可冻结：只写表自己的固定布局，不碰不存在的格子', () => {
  const t = styleEl({ width: 80 });
  t.rows = [];
  const restore = C.freezeTableLayout({ closest: function () { return t; } });
  assert.strictEqual(t.style.tableLayout, 'fixed');
  assert.strictEqual(t.style.width, '80px');
  assert.strictEqual(typeof restore, 'function');
});

// ── 源自 docs/bugs/0028（往表格格粘贴两行文字会让表格先长高再缩回）──────
// 入口折行由 main.js 负责；纯逻辑的底线是「提交出去的那一行永远没有裸换行」。

test('0028 encode 把换行折成 <br>，提交文本里不再有裸换行', () => {
  const out = C.encode('甲\n乙');
  assert.strictEqual(out, '甲<br>乙');
  assert.strictEqual(/[\r\n]/.test(out), false);
});

test('0028 encode 先统一 CRLF / CR 再写 <br>', () => {
  assert.strictEqual(C.encode('a\r\nb'), 'a<br>b');
  assert.strictEqual(C.encode('a\rb'), 'a<br>b');
  assert.strictEqual(C.encode('a\r\nb\rc\nd'), 'a<br>b<br>c<br>d');
  assert.strictEqual(/[\r\n]/.test(C.encode('a\r\nb')), false);
});

test('0028 多行粘贴编码后仍是一条源码行，行数不增长', () => {
  const view = '一\n二\n三';
  const encoded = C.encode(view);
  assert.strictEqual(encoded.split('\n').length, 1);
  assert.strictEqual(encoded, '一<br>二<br>三');
});

test('0033 换行前紧邻奇数个反斜杠时补成偶数，避免 <br> 被当成转义尖括号', () => {
  assert.strictEqual(C.encode('a\\\nb'), 'a\\\\<br>b');
  assert.strictEqual(C.encode('a\\\\\nb'), 'a\\\\<br>b');
  assert.strictEqual(C.encode('a\\\\\\\nb'), 'a\\\\\\\\<br>b');
});

test('0028 encode 是「先折行、后转义竖线」，顺序不可交换', () => {
  assert.strictEqual(C.encode('a|b\nc|d'), 'a\\|b<br>c\\|d');
});

// ── 源自 docs/bugs/0035（格内回车无法换行）──────────────────────────────
// 视图里 `\n`、源码里 `<br>`，两者必须是可逆的一对。

test('0035 decode 把 <br> 的三种常见写法还原成换行', () => {
  assert.strictEqual(C.decode('a<br>b'), 'a\nb');
  assert.strictEqual(C.decode('a<br/>b'), 'a\nb');
  assert.strictEqual(C.decode('a<br />b'), 'a\nb');
  assert.strictEqual(C.decode('a<br\t>b'), 'a\nb');
});

test('0035 decode 对 <br> 大小写不敏感，但不放宽到带属性的标签', () => {
  assert.strictEqual(C.decode('a<BR>b'), 'a\nb');
  assert.strictEqual(C.decode('a<br class=x>b'), 'a<br class=x>b');
  assert.strictEqual(C.decode('a< br>b'), 'a< br>b');
});

test('0035 encode / decode 在普通文本、竖线与换行上互为逆变换', () => {
  const views = ['a|b', 'a\nb', 'a\r\nb', '中文|换行\n下一行', ''];
  for (const view of views) {
    assert.strictEqual(C.decode(C.encode(view)), view.replace(/\r\n?/g, '\n'));
  }
});

test('0035 decode 不把代码 span 里的 <br> 当换行', () => {
  assert.strictEqual(C.decode('`a<br>b`'), '`a<br>b`');
  assert.strictEqual(C.decode('``a<br>b``'), '``a<br>b``');
  assert.strictEqual(C.decode('a`b<br>c'), 'a`b\nc');
});

test('0035 decode 认出转义对：\\<br> 是字面，\\` 不开启代码 span', () => {
  assert.strictEqual(C.decode('a\\<br>b'), 'a\\<br>b');
  assert.strictEqual(C.decode('a\\`x<br>y`'), 'a\\`x\ny`');
  assert.strictEqual(C.decode('a\\\\<br>b'), 'a\\\\\nb');
});

// ── 源自 docs/bugs/0032（格内末尾反斜杠会合并相邻单元格）────────────────
// 末尾反斜杠靠「补一个空格」断开，不是靠凑偶数。

test('0032 padFor 只在末尾反斜杠且右边紧贴竖线时补一个空格', () => {
  assert.strictEqual(C.padFor('|x|y|', 2, 'z\\'), 'z\\ ');
  assert.strictEqual(C.padFor('x|y', 1, 'z\\'), 'z\\ ');
});

test('0032 padFor 右边是空格 / 行尾 / 越界 / 非整数时一律不补', () => {
  assert.strictEqual(C.padFor('|x |y|', 2, 'z\\'), 'z\\');
  assert.strictEqual(C.padFor('|x', 2, 'z\\'), 'z\\');
  assert.strictEqual(C.padFor('|x|y|', 99, 'z\\'), 'z\\');
  assert.strictEqual(C.padFor('|x|y|', 2.5, 'z\\'), 'z\\');
  assert.strictEqual(C.padFor(null, 2, 'z\\'), 'z\\');
});

test('0032 padFor 对不以反斜杠结尾的内容一个字节都不加', () => {
  assert.strictEqual(C.padFor('|x|y|', 2, 'z'), 'z');
  assert.strictEqual(C.padFor('|x|y|', 2, ''), '');
  assert.strictEqual(C.padFor('|x|y|', 2, 'z\\\\'), 'z\\\\ ');
});

test('0032 judge 给出补位后的 replacement 与整行结果', () => {
  const b = C.bind({ raw: 'x', from: 1, to: 2 });
  const out = C.judge(b, '|x|y|', 'z\\');
  assert.strictEqual(out.status, 'valid');
  assert.strictEqual(out.encoded, 'z\\');
  assert.strictEqual(out.replacement, 'z\\ ');
  assert.strictEqual(out.nextLine, '|z\\ |y|');
});

test('0032 补位只在右边紧贴竖线时发生，邻格文字逐字节不变', () => {
  const b = C.bind({ raw: 'x', from: 1, to: 2 });
  const out = C.judge(b, '|x | y |', 'z\\');
  assert.strictEqual(out.status, 'valid');
  assert.strictEqual(out.replacement, 'z\\');
  assert.strictEqual(out.nextLine, '|z\\ | y |');
});

test('0032 splice 只换区间内字节，两侧竖线与同排其余格子不动', () => {
  assert.strictEqual(C.splice('|a|b|', 1, 2, 'xy'), '|xy|b|');
  assert.strictEqual(C.splice('|a|b|', 3, 4, 'z'), '|a|z|');
  assert.strictEqual(C.splice('x|y', 0, 1, 'X'), 'X|y');
});

test('0032 splice 对越界 / 反向 / 非整数 / 非字符串抛错，绝不夹取', () => {
  assert.throws(function () { C.splice('|a|', 0, 9, 'x'); }, /越界/);
  assert.throws(function () { C.splice('|a|', 3, 2, 'x'); }, /越界/);
  assert.throws(function () { C.splice('|a|', -1, 0, 'x'); }, /越界/);
  assert.throws(function () { C.splice('|a|', 0.5, 1, 'x'); }, /整数/);
  assert.throws(function () { C.splice(null, 0, 1, 'x'); }, /不是字符串/);
});

// ── 源自 docs/bugs/0038（省略首尾竖线的表格整表不可写）──────────────────
// 单元格的可写性由后端给的列区间决定，前端不自己补竖线、不扩展边界。

test('0038 无首尾竖线的行按后端列区间写回，只动那一格', () => {
  const first = C.judge(C.bind({ raw: 'x', from: 0, to: 1 }), 'x|y', 'X');
  assert.strictEqual(first.status, 'valid');
  assert.strictEqual(first.nextLine, 'X|y');
  const second = C.judge(C.bind({ raw: 'y', from: 2, to: 3 }), 'x|y', 'Y');
  assert.strictEqual(second.status, 'valid');
  assert.strictEqual(second.nextLine, 'x|Y');
});

test('0038 textOf 在无首尾竖线的行上严格按列切，不自行摘分隔符', () => {
  assert.strictEqual(C.textOf('x|y', 0, 1), 'x');
  assert.strictEqual(C.textOf('x|y', 1, 2), '|');
  assert.strictEqual(C.textOf('x|y', 2, 3), 'y');
});

test('0038 无首尾竖线的非法区间同样判 rejected，不退回「没改动」', () => {
  const out = C.judge(C.bind({ raw: 'x', from: 0, to: 9 }), 'x|y', 'x');
  assert.deepStrictEqual(out, { status: 'rejected', why: 'range' });
});

test('0038 无首尾竖线的表也能用 flatAfter 走格，末尾给 -1', () => {
  const t = table([[cell(), cell()], [cell(), cell()]]);
  assert.strictEqual(C.flatAfter(t, 2, 1), 3);
  assert.strictEqual(C.flatAfter(t, 3, 1), -1);
});

// ── 源自 docs/bugs/0040（点进含 br 的格子不改也会改写源码）──────────────
// 无改动判据必须是「视图 == decode(源码)」，不能是「encode(视图) == 源码」。

test('0040 点进含 <br /> 的格子不改，judge 报 unchanged 且不产出编码', () => {
  const cases = ['a<br>b', 'a<br/>b', 'a<br />b', 'a<BR>b'];
  for (const raw of cases) {
    const line = '|' + raw + '|';
    const b = C.bind({ raw: raw, from: 1, to: 1 + raw.length });
    const out = C.judge(b, line, 'a\nb');
    assert.deepStrictEqual(out, { status: 'unchanged' }, raw);
    assert.strictEqual(out.encoded, undefined);
  }
});

test('0040 isUnchanged 按视图与初始视图比，而不是按编码后字节比', () => {
  assert.strictEqual(C.isUnchanged('|a<br />b|', 1, 9, 'a\nb'), true);
  assert.strictEqual(C.isUnchanged('|a<br />b|', 1, 9, 'a<br />b'), false);
  assert.strictEqual(C.isUnchanged('|a|', 9, 10, 'a'), false);
});

test('0040 视图里真的新增换行时才给出 <br> 编码', () => {
  const b = C.bind({ raw: 'a', from: 1, to: 2 });
  const out = C.judge(b, '|a|', 'a\nb');
  assert.strictEqual(out.status, 'valid');
  assert.strictEqual(out.encoded, 'a<br>b');
  assert.strictEqual(out.nextLine, '|a<br>b|');
});

test('0040 代码 span 里的 <br> 在视图里也是字面量，视图相同即 unchanged', () => {
  const raw = '`a<br>b`';
  const line = '|' + raw + '|';
  const b = C.bind({ raw: raw, from: 1, to: 1 + raw.length });
  assert.deepStrictEqual(C.judge(b, line, raw), { status: 'unchanged' });
});

test('0040 视图把代码 span 里的 br 改成真换行时报 inexpressible，不静默写坏', () => {
  const raw = '`a<br>b`';
  const line = '|' + raw + '|';
  const b = C.bind({ raw: raw, from: 1, to: 1 + raw.length });
  const out = C.judge(b, line, '`a\nb`');
  assert.strictEqual(out.status, 'rejected');
  assert.strictEqual(out.why, 'inexpressible');
});

// ── 源自 docs/bugs/0047（格内按 Tab 什么也不发生）───────────────────────
// Tab 的走格换算与 `\|` 的往返是两件事，但都会让「退不出这一格」。

test('0047 decode 把 \\| 还原成一个竖线，其余转义对原样保留', () => {
  assert.strictEqual(C.decode('a\\|b'), 'a|b');
  assert.strictEqual(C.decode('a\\<b'), 'a\\<b');
  assert.strictEqual(C.decode('a\\a<br>b'), 'a\\a\nb');
  assert.strictEqual(C.decode('a\\\\|b'), 'a\\\\|b');
});

test('0047 源码 x\\|y 且视图 x|y 时判 unchanged，第一次点进不判脏', () => {
  const line = '|x\\|y|';
  const raw = 'x\\|y';
  const b = C.bind({ raw: raw, from: 1, to: 1 + raw.length });
  assert.deepStrictEqual(C.judge(b, line, 'x|y'), { status: 'unchanged' });
});

test('0047 用户输入的字面竖线编码成 \\|，往返后仍可回读', () => {
  const b = C.bind({ raw: 'a', from: 1, to: 2 });
  const out = C.judge(b, '|a|', 'x|y');
  assert.strictEqual(out.status, 'valid');
  assert.strictEqual(out.encoded, 'x\\|y');
  assert.strictEqual(out.nextLine, '|x\\|y|');
  assert.strictEqual(C.decode(out.encoded), 'x|y');
});

test('0047 flatAfter 只加减一，到表格首尾给 -1，不环绕', () => {
  const t = table([[0, 1], [2]]);
  assert.strictEqual(C.flatAfter(t, 0, 1), 1);
  assert.strictEqual(C.flatAfter(t, 2, 1), -1);
  assert.strictEqual(C.flatAfter(t, 0, -1), -1);
  assert.strictEqual(C.flatAfter(t, 2, -1), 1);
  assert.strictEqual(C.flatAfter(t, 1, 0), -1);
  assert.strictEqual(C.flatAfter(t, 0.5, 1), -1);
});

test('0047 flatAfter 对超过 1 的 delta 仍只走一格，不跳格', () => {
  const t = table([[0, 1, 2]]);
  assert.strictEqual(C.flatAfter(t, 0, 9), 1);
  assert.strictEqual(C.flatAfter(t, 2, -9), 1);
});

// ── 源自 docs/bugs/0065（非法单元格绑定被判成无修改）────────────────────
// 顺序是承重的：坏区间 ⇒ rejected 必须先于「视图没改」 ⇒ unchanged。

test('0065 六种非法绑定即便视图没改也一律 rejected/range', () => {
  const cases = [
    { from: -1, to: 2 },
    { from: 0, to: 99 },
    { from: 3, to: 1 },
    { from: 0.5, to: 2 },
    { from: NaN, to: 2 },
    { from: 1, to: Infinity },
  ];
  for (const c of cases) {
    const b = C.bind({ raw: 'old', from: c.from, to: c.to });
    const out = C.judge(b, '|old|', b.initialView);
    assert.deepStrictEqual(out, { status: 'rejected', why: 'range' }, JSON.stringify(c));
  }
});

test('0065 缺 raw 的绑定先报 range，不读成「没改动」', () => {
  assert.deepStrictEqual(C.judge(C.bind({ from: 0, to: 1 }), '|a|', ''), { status: 'rejected', why: 'range' });
  assert.deepStrictEqual(C.judge(null, '|a|', 'a'), { status: 'rejected', why: 'range' });
});

test('0065 良好区间 + 文本未改才是 unchanged，且不带 encoded', () => {
  const b = C.bind({ raw: 'a', from: 1, to: 2 });
  const out = C.judge(b, '|a|', 'a');
  assert.deepStrictEqual(out, { status: 'unchanged' });
  assert.strictEqual('encoded' in out, false);
});

test('0065 坏区间失败后修正坐标仍可 valid，不一次失败就锁死', () => {
  const bad = C.bind({ raw: 'a', from: 0, to: 99 });
  assert.strictEqual(C.judge(bad, '|a|', 'a').status, 'rejected');
  const good = C.bind({ raw: 'a', from: 1, to: 2 });
  assert.strictEqual(C.judge(good, '|a|', 'z').status, 'valid');
});

test('0065 坏区间优先于 inexpressible：先报 range', () => {
  const b = C.bind({ raw: 'a|b', from: -1, to: 4 });
  const out = C.judge(b, '|a|b|', 'a|b');
  assert.deepStrictEqual(out, { status: 'rejected', why: 'range' });
});

test('0065 judge 对编码后无法还原的视图报 inexpressible，保留输入', () => {
  const b = C.bind({ raw: 'a|b', from: 1, to: 4 });
  const out = C.judge(b, '|a|b|', 'a\\|b');
  assert.strictEqual(out.status, 'rejected');
  assert.strictEqual(out.why, 'inexpressible');
});

// ── 源自 docs/bugs/0066（点在表格行尾不进入单元格编辑）──────────────────
// 表格块盒子铺满正文宽度，点在空白处只能靠几何找最近格；离得太远不许隔空抢。

test('0066 cellAtPoint 先按 y 选行、再按 x 命中格', () => {
  const a = geoCell(rect(0, 0, 100, 20));
  const b = geoCell(rect(100, 0, 200, 20));
  const c = geoCell(rect(0, 20, 100, 40));
  const d = geoCell(rect(100, 20, 200, 40));
  const t = { rows: [{ cells: [a, b] }, { cells: [c, d] }] };
  assert.strictEqual(C.cellAtPoint(t, 150, 10), b);
  assert.strictEqual(C.cellAtPoint(t, 10, 30), c);
  assert.strictEqual(C.cellAtPoint(t, 150, 30), d);
});

test('0066 cellAtPoint 左右越界只在 16px 容差内夹到首 / 末格', () => {
  const a = geoCell(rect(0, 0, 100, 20));
  const b = geoCell(rect(100, 0, 200, 20));
  const t = { rows: [{ cells: [a, b] }] };
  assert.strictEqual(C.cellAtPoint(t, -16, 10), a);
  assert.strictEqual(C.cellAtPoint(t, -17, 10), null);
  assert.strictEqual(C.cellAtPoint(t, 216, 10), b);
  assert.strictEqual(C.cellAtPoint(t, 217, 10), null);
});

test('0066 cellAtPoint 的 slop 可放宽或收紧，非法 slop 回落到默认 16', () => {
  const a = geoCell(rect(0, 0, 100, 20));
  const t = { rows: [{ cells: [a] }] };
  assert.strictEqual(C.cellAtPoint(t, -20, 10, 20), a);
  assert.strictEqual(C.cellAtPoint(t, -20, 10, 0), null);
  assert.strictEqual(C.cellAtPoint(t, -14, 10, NaN), a);
  assert.strictEqual(C.cellAtPoint(t, -14, 10, -3), a);
});

test('0066 cellAtPoint 纵向离行超过该行高度时不猜', () => {
  const a = geoCell(rect(0, 0, 100, 20));
  const t = { rows: [{ cells: [a] }] };
  assert.strictEqual(C.cellAtPoint(t, 10, 35), a);
  assert.strictEqual(C.cellAtPoint(t, 10, 41), null);
  assert.strictEqual(C.cellAtPoint(t, 10, -20), a);
  assert.strictEqual(C.cellAtPoint(t, 10, -21), null);
});

test('0066 cellAtPoint 跳过没有 cells 或没有矩形的行', () => {
  const a = geoCell(rect(0, 20, 100, 40));
  const t = { rows: [{ cells: [] }, {}, { cells: [a] }] };
  assert.strictEqual(C.cellAtPoint(t, 10, 30), a);
});

test('0066 cellAtPoint 对非数字 / NaN / Infinity / 空表一律 null', () => {
  const a = geoCell(rect(0, 0, 100, 20));
  const t = { rows: [{ cells: [a] }] };
  assert.strictEqual(C.cellAtPoint(t, NaN, 10), null);
  assert.strictEqual(C.cellAtPoint(t, 10, Infinity), null);
  assert.strictEqual(C.cellAtPoint(t, '10', 10), null);
  assert.strictEqual(C.cellAtPoint({ rows: [] }, 10, 10), null);
  assert.strictEqual(C.cellAtPoint(null, 10, 10), null);
});

test('0066 cellAtPoint 在共享边界上取先遇到的那一格（含右边界）', () => {
  const a = geoCell(rect(0, 0, 100, 20));
  const b = geoCell(rect(100, 0, 200, 20));
  const t = { rows: [{ cells: [a, b] }] };
  assert.strictEqual(C.cellAtPoint(t, 100, 10), a);
  assert.strictEqual(C.cellAtPoint(t, 100.1, 10), b);
});

// ── 源自 docs/bugs/0069（表格格子里点行尾不出光标）──────────────────────
// 与 0026 的「配对」分开：这里量的是「点在行尾 / 空白里能不能找到目标格」。

test('0069 cellAtPoint 在窄表右侧的块空白里仍能回到末格', () => {
  const a = geoCell(rect(0, 0, 80, 20));
  const b = geoCell(rect(80, 0, 158.8, 20));
  const t = { rows: [{ cells: [a, b] }] };
  assert.strictEqual(C.cellAtPoint(t, 158.8, 10), b);
  assert.strictEqual(C.cellAtPoint(t, 174.8, 10), b);
  assert.strictEqual(C.cellAtPoint(t, 175, 10), null);
});

test('0069 cellAtPoint 在行尾下方一像素仍按行高容差算在同一行', () => {
  const a = geoCell(rect(0, 0, 100, 20));
  const t = { rows: [{ cells: [a] }] };
  assert.strictEqual(C.cellAtPoint(t, 10, 20.5), a);
  assert.strictEqual(C.cellAtPoint(t, 10, 40.5), null);
});

test('0069 rectOf 拿不到合法矩形时给 null，不拿 0 冒充', () => {
  assert.strictEqual(C.rectOf(null), null);
  assert.strictEqual(C.rectOf({}), null);
  assert.strictEqual(C.rectOf({ getBoundingClientRect: function () { return { left: 0 }; } }), null);
  assert.deepStrictEqual(C.rectOf(geoCell(rect(1, 2, 3, 4))), { left: 1, right: 3, top: 2, bottom: 4 });
});

test('0069 rectOf 保留全零矩形（那是真的零尺寸，不是缺失）', () => {
  assert.deepStrictEqual(C.rectOf(geoCell(rect(0, 0, 0, 0))), { left: 0, right: 0, top: 0, bottom: 0 });
});

// ── 源自 docs/bugs/0104（表格方向键不能跨格）────────────────────────────
// 上下跨格必须按「同列」换算；上一行短一格就不猜，边界一律 -1。

test('0104 flatBelow 取同列下一行，末行给 -1', () => {
  const t = table([[0, 1, 2], [3, 4, 5]]);
  assert.strictEqual(C.flatBelow(t, 0), 3);
  assert.strictEqual(C.flatBelow(t, 1), 4);
  assert.strictEqual(C.flatBelow(t, 2), 5);
  assert.strictEqual(C.flatBelow(t, 3), -1);
  assert.strictEqual(C.flatBelow(t, 9), -1);
  assert.strictEqual(C.flatBelow(t, -1), -1);
});

test('0104 flatAbove 取同列上一行，首行给 -1（不退出编辑）', () => {
  const t = table([[0, 1, 2], [3, 4, 5]]);
  assert.strictEqual(C.flatAbove(t, 3), 0);
  assert.strictEqual(C.flatAbove(t, 4), 1);
  assert.strictEqual(C.flatAbove(t, 5), 2);
  assert.strictEqual(C.flatAbove(t, 0), -1);
  assert.strictEqual(C.flatAbove(t, 99), -1);
});

test('0104 flatAbove / flatBelow 在规整表上互为逆运算', () => {
  const t = table([[0, 1, 2], [3, 4, 5], [6, 7, 8]]);
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(C.flatAbove(t, C.flatBelow(t, i)), i);
    assert.strictEqual(C.flatBelow(t, C.flatAbove(t, i + 3)), i + 3);
  }
});

test('0104 下一行 / 上一行短一格时不猜，给 -1 保持表格形状纪律', () => {
  const t = table([[0, 1, 2], [3]]);
  assert.strictEqual(C.flatBelow(t, 0), 3);
  assert.strictEqual(C.flatBelow(t, 1), -1);
  const u = table([[0], [1, 2, 3]]);
  assert.strictEqual(C.flatAbove(u, 1), 0);
  assert.strictEqual(C.flatAbove(u, 2), -1);
});

test('0104 空表 / 小数下标下上下换算都给 -1', () => {
  assert.strictEqual(C.flatBelow({ rows: [] }, 0), -1);
  assert.strictEqual(C.flatAbove({ rows: [] }, 0), -1);
  assert.strictEqual(C.flatBelow(table([[0]]), 0.5), -1);
  assert.strictEqual(C.flatAbove(table([[0]]), 0.5), -1);
});

// ── 源自 docs/bugs/0093（硬换行的反斜杠在编辑态可见）与 0084 / 0085 ────
// 这些缺陷的几何部分在 main.js，纯逻辑侧只守「视图 = 源码语义」与「只取这一格」。

test('0093 行末反斜杠在编码后原样保留，不被吞掉也不被加倍', () => {
  assert.strictEqual(C.encode('a\\'), 'a\\');
  assert.strictEqual(C.encode('\\\\'), '\\\\');
  assert.strictEqual(C.decode('a\\'), 'a\\');
});

test('0084 textOf 只用后端给的区间，不把整行当一格', () => {
  const line = '|甲|乙|';
  assert.strictEqual(C.textOf(line, 1, 2), '甲');
  assert.strictEqual(C.textOf(line, 3, 4), '乙');
  assert.strictEqual(C.textOf(line, 0, line.length), line);
});

test('0085 长内容写回不截断、不裁切，首尾字符原样进入 nextLine', () => {
  const view = '首' + 'x'.repeat(500) + '尾';
  const b = C.bind({ raw: 'a', from: 1, to: 2 });
  const out = C.judge(b, '|a|', view);
  assert.strictEqual(out.status, 'valid');
  assert.strictEqual(out.nextLine, '|' + view + '|');
  assert.strictEqual(out.nextLine.indexOf('首'), 1);
  assert.strictEqual(out.nextLine.charAt(out.nextLine.length - 2), '尾');
});

test('0093 bind 的 raw 与 initialView 同时产出，缺省值是空串 / 0 / null', () => {
  assert.deepStrictEqual(C.bind({ raw: 'a<br>b', from: 2, to: 4 }), {
    raw: 'a<br>b', initialView: 'a\nb', from: 2, to: 4, objectId: null, revision: null,
  });
  assert.deepStrictEqual(C.bind(), {
    raw: null, initialView: '', from: 0, to: 0, objectId: null, revision: null,
  });
});

// ── 源自 docs/bugs/0029（表格格编辑态不换行长内容被切断）与 0034 ────────
// 长内容 / 多行内容在逻辑上都不能被截断，也不能被当成独立 markdown 文档。

test('0029 多行内容编码后能完整还原，没有字符丢失', () => {
  const view = '第一行\n第二行\n第三行';
  const encoded = C.encode(view);
  assert.strictEqual(C.decode(encoded), view);
  assert.strictEqual(encoded.includes('第一行'), true);
  assert.strictEqual(encoded.includes('第三行'), true);
});

test('0034 单元格文本只取这一格，不夹带前后竖线与邻格', () => {
  const line = '| 左格 | 中格 | 右格 |';
  const b = C.bind({ raw: C.textOf(line, 7, 9), from: 7, to: 9 });
  assert.strictEqual(b.initialView, '中格');
  const out = C.judge(b, line, '新格');
  assert.strictEqual(out.nextLine, '| 左格 | 新格 | 右格 |');
});

test('0034 只有单元格内容参与编辑，行内其余字节在 valid 写回时逐字保留', () => {
  const line = '| a | b | c |';
  const out = C.judge(C.bind({ raw: 'b', from: 6, to: 7 }), line, 'B');
  assert.strictEqual(out.status, 'valid');
  assert.strictEqual(out.nextLine, '| a | B | c |');
  assert.strictEqual(out.nextLine.charAt(0), '|');
  assert.strictEqual(out.nextLine.charAt(out.nextLine.length - 1), '|');
});

test('0034 自动补出的空列（区间 from==to）只要不改就判 unchanged', () => {
  const b = C.bind({ raw: '', from: 3, to: 3 });
  assert.deepStrictEqual(C.judge(b, '|a||', ''), { status: 'unchanged' });
});

test('0034 空列里真的输入内容可 valid，并写到那个零宽区间', () => {
  const b = C.bind({ raw: '', from: 3, to: 3 });
  const out = C.judge(b, '|a||', 'x');
  assert.strictEqual(out.status, 'valid');
  assert.strictEqual(out.nextLine, '|a|x|');
});
