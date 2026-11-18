// 选中浮动格式栏的纯决策：行内标记开关、行前缀开关、标题级别设置、链接插入、选区映射。
// 守的是 `design/0061` §6 与 `INV-LIVE-17`；历史缺陷见 `bugs/0022`、`0015`、`0016`、`0093`、`0114`。
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

const F = load('src/live/formatbar.js').liveFormatbar;

// 按变更升序应用（同一位置的两次插入保持出现顺序，与 CM6 ChangeSet 同形）。
function apply(text, changes) {
  let out = '';
  let pos = 0;
  for (const c of changes) {
    out += text.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + text.slice(pos);
}

function inline(text, anchor, head, marker) {
  return F.toggleInline(text, anchor, head, marker);
}

// ── selectedLines：选区覆盖到的整行，右端不算下一行 ─────────────────────
test('selectedLines：单行选区只覆盖那一行', () => {
  assert.deepStrictEqual(F.selectedLines('a\nb\nc', 0, 1), [{ start: 0, end: 1 }]);
});

test('selectedLines：正好停在下一行行首时不算下一行（右端规则）', () => {
  // 'a\nb\nc' 中 to=2 指向 'b' 行首，前一个字符是换行符 ⇒ 只算第一行。
  assert.deepStrictEqual(F.selectedLines('a\nb\nc', 0, 2), [{ start: 0, end: 1 }]);
});

test('selectedLines：跨过换行符且越过行首才把下一行算进来', () => {
  assert.deepStrictEqual(F.selectedLines('a\nb\nc', 0, 3), [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
  ]);
});

test('selectedLines：空选区落在行首时取那一整行', () => {
  assert.deepStrictEqual(F.selectedLines('a\nb\nc', 2, 2), [{ start: 2, end: 3 }]);
});

test('selectedLines：空选区落在行内时也只取那一行', () => {
  assert.deepStrictEqual(F.selectedLines('abc\ndef', 1, 1), [{ start: 0, end: 3 }]);
});

test('selectedLines：最后一行没有换行符时 end 是文本长度', () => {
  assert.deepStrictEqual(F.selectedLines('a\nbc', 2, 4), [{ start: 2, end: 4 }]);
});

test('selectedLines：空文本给出一行零宽区间', () => {
  assert.deepStrictEqual(F.selectedLines('', 0, 0), [{ start: 0, end: 0 }]);
});

test('selectedLines：全选三行给出三个区间', () => {
  assert.deepStrictEqual(F.selectedLines('a\nb\nc', 0, 5), [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
    { start: 4, end: 5 },
  ]);
});

// ── mapPosition：变更前后的坐标换算 ─────────────────────────────────────
test('mapPosition：插入点之前的变更累计位移', () => {
  assert.strictEqual(F.mapPosition(5, [{ from: 0, to: 0, insert: 'ab' }]), 7);
});

test('mapPosition：插入点之后的变更不影响坐标', () => {
  assert.strictEqual(F.mapPosition(1, [{ from: 5, to: 5, insert: 'ab' }]), 1);
});

test('mapPosition：删除之后坐标左移', () => {
  assert.strictEqual(F.mapPosition(9, [{ from: 2, to: 5, insert: '' }]), 6);
});

test('mapPosition：位置落在被替换区间内部时贴到替换结果右端', () => {
  assert.strictEqual(F.mapPosition(3, [{ from: 2, to: 5, insert: 'XY' }]), 4);
});

test('mapPosition：多个互不重叠的变更按顺序累计', () => {
  const changes = [
    { from: 0, to: 0, insert: '# ' },
    { from: 5, to: 5, insert: '# ' },
  ];
  assert.strictEqual(F.mapPosition(6, changes), 10);
});

test('mapPosition：空变更列表原样返回', () => {
  assert.strictEqual(F.mapPosition(7, []), 7);
});

// ── 行内标记：包裹 / 剥离 / 空选区 ─────────────────────────────────────
test('0022 行内标记未包裹时两侧各加一层，内容字节不动', () => {
  const plan = inline('abc', 0, 3, '**');
  assert.deepStrictEqual(plan.changes, [
    { from: 0, to: 0, insert: '**' },
    { from: 3, to: 3, insert: '**' },
  ]);
  assert.strictEqual(apply('abc', plan.changes), '**abc**');
});

test('0022 选区紧邻同种标记时两侧各剥一层', () => {
  const plan = inline('**abc**', 2, 5, '**');
  assert.deepStrictEqual(plan.changes, [
    { from: 0, to: 2, insert: '' },
    { from: 5, to: 7, insert: '' },
  ]);
  assert.strictEqual(apply('**abc**', plan.changes), 'abc');
});

test('0022 剥离后选区整体左移一层', () => {
  const plan = inline('**abc**', 2, 5, '**');
  assert.deepStrictEqual(plan.selection, { anchor: 0, head: 3 });
});

test('0022 反向选区（head 在 anchor 前）在选择时保持方向', () => {
  const plan = inline('**abc**', 5, 2, '**');
  assert.deepStrictEqual(plan.selection, { anchor: 3, head: 0 });
});

test('0022 反向选区包裹时也保持方向', () => {
  const plan = inline('abc', 3, 0, '*');
  assert.deepStrictEqual(plan.selection, { anchor: 4, head: 1 });
  assert.strictEqual(apply('abc', plan.changes), '*abc*');
});

test('0022 空选区插入一对标记，光标落在中间', () => {
  const plan = inline('abc', 1, 1, '**');
  assert.deepStrictEqual(plan.changes, [{ from: 1, to: 1, insert: '****' }]);
  assert.deepStrictEqual(plan.selection, { anchor: 3, head: 3 });
  assert.strictEqual(apply('abc', plan.changes), 'a****bc');
});

test('0022 单字符标记（斜体）空选区插入两个字符', () => {
  const plan = inline('ab', 1, 1, '*');
  assert.strictEqual(plan.changes[0].insert, '**');
  assert.deepStrictEqual(plan.selection, { anchor: 2, head: 2 });
});

test('0022 只有左侧有标记时不剥离，而是再包一层', () => {
  const plan = inline('**abc', 2, 5, '**');
  assert.strictEqual(plan.changes.length, 2);
  assert.deepStrictEqual(plan.changes[0], { from: 2, to: 2, insert: '**' });
  assert.deepStrictEqual(plan.changes[1], { from: 5, to: 5, insert: '**' });
});

test('0022 标记在选区外侧但不紧邻时同样按包裹处理', () => {
  const plan = inline('a**b', 0, 1, '**');
  assert.strictEqual(apply('a**b', plan.changes), '**a****b');
});

test('0022 选区起点不足一个标记长度时不可能命中左侧标记', () => {
  const plan = inline('*abc', 1, 4, '**');
  assert.deepStrictEqual(plan.changes[0], { from: 1, to: 1, insert: '**' });
});

test('0022 选区终点不足以容纳右侧标记时不可能命中', () => {
  const plan = inline('abc*', 0, 3, '**');
  assert.deepStrictEqual(plan.changes[1], { from: 3, to: 3, insert: '**' });
});

test('0022 四种行内标记分别在包裹与剥离间往返', () => {
  for (const marker of ['**', '*', '`', '~~']) {
    const wrapped = inline('正文', 0, 2, marker);
    const text2 = apply('正文', wrapped.changes);
    assert.strictEqual(text2, marker + '正文' + marker, marker);
    const stripped = inline(text2, marker.length, marker.length + 2, marker);
    assert.strictEqual(apply(text2, stripped.changes), '正文', marker);
  }
});

test('0022 加粗与斜体是两个不同标记，不互相吞', () => {
  const bold = inline('abc', 0, 3, '**');
  const italic = inline('abc', 0, 3, '*');
  assert.strictEqual(apply('abc', bold.changes), '**abc**');
  assert.strictEqual(apply('abc', italic.changes), '*abc*');
});

test('0093 行内开关不碰反斜杠，硬换行标记随内容原样包住', () => {
  const plan = inline('a\\', 0, 2, '**');
  assert.strictEqual(apply('a\\', plan.changes), '**a\\**');
});

test('边界：空标记直接抛错，不产生空包裹', () => {
  assert.throws(function () { F.toggleInline('abc', 0, 1, ''); }, /marker must not be empty/);
  assert.throws(function () { F.toggleInline('abc', 0, 1, null); }, /marker must not be empty/);
});

test('边界：选区越界 / 非整数抛错，⛔ 不夹取', () => {
  assert.throws(function () { F.toggleInline('abc', 0, 4, '*'); }, /range out of bounds/);
  assert.throws(function () { F.toggleInline('abc', -1, 0, '*'); }, /range out of bounds/);
  assert.throws(function () { F.toggleInline('abc', 0.5, 1, '*'); }, /selection is not an integer/);
  assert.throws(function () { F.toggleInline('abc', 0, NaN, '*'); }, /selection is not an integer/);
});

// ── 行前缀开关：全有则剥，否则只补缺的 ─────────────────────────────────
test('行前缀：单行没有前缀时补一个', () => {
  const plan = F.togglePrefix('abc', 0, 3, '- ');
  assert.deepStrictEqual(plan.changes, [{ from: 0, to: 0, insert: '- ' }]);
  assert.strictEqual(apply('abc', plan.changes), '- abc');
});

test('行前缀：单行已有前缀时剥掉', () => {
  const plan = F.togglePrefix('- abc', 0, 5, '- ');
  assert.deepStrictEqual(plan.changes, [{ from: 0, to: 2, insert: '' }]);
  assert.strictEqual(apply('- abc', plan.changes), 'abc');
});

test('行前缀：多行全有前缀时整批剥掉', () => {
  const plan = F.togglePrefix('- a\n- b', 0, 7, '- ');
  assert.deepStrictEqual(plan.changes, [
    { from: 0, to: 2, insert: '' },
    { from: 4, to: 6, insert: '' },
  ]);
  assert.strictEqual(apply('- a\n- b', plan.changes), 'a\nb');
});

test('行前缀：混合选区只给缺的行补，已有的一行不动（⛔ 不叠加）', () => {
  const plan = F.togglePrefix('- a\nb', 0, 5, '- ');
  assert.deepStrictEqual(plan.changes, [{ from: 4, to: 4, insert: '- ' }]);
  assert.strictEqual(apply('- a\nb', plan.changes), '- a\n- b');
});

test('行前缀：空选区只作用于光标所在行', () => {
  const plan = F.togglePrefix('a\nb', 2, 2, '> ');
  assert.deepStrictEqual(plan.changes, [{ from: 2, to: 2, insert: '> ' }]);
  assert.strictEqual(apply('a\nb', plan.changes), 'a\n> b');
});

test('行前缀：引用前缀只在行首字面匹配，行中的 > 不算', () => {
  const plan = F.togglePrefix('a > b', 0, 5, '> ');
  assert.deepStrictEqual(plan.changes, [{ from: 0, to: 0, insert: '> ' }]);
  assert.strictEqual(apply('a > b', plan.changes), '> a > b');
});

test('行前缀：`* ` 列表不被 `- ` 口径认领，会再补一个前缀', () => {
  const plan = F.togglePrefix('* a', 0, 3, '- ');
  assert.strictEqual(apply('* a', plan.changes), '- * a');
});

test('行前缀：`- ` 行用 `> ` 开关时是加引用，不是剥列表', () => {
  const plan = F.togglePrefix('- a', 0, 3, '> ');
  assert.strictEqual(apply('- a', plan.changes), '> - a');
});

test('行前缀：缩进列表行首不是字面 `- `，不误判为已有前缀', () => {
  const plan = F.togglePrefix('  - a', 0, 5, '- ');
  assert.strictEqual(apply('  - a', plan.changes), '-   - a');
});

test('行前缀：三行全有前缀时剥三处，选区端点同步左移', () => {
  const text = '- a\n- b\n- c';
  const plan = F.togglePrefix(text, 0, text.length, '- ');
  assert.strictEqual(apply(text, plan.changes), 'a\nb\nc');
  assert.deepStrictEqual(plan.selection, { anchor: 0, head: text.length - 6 });
});

test('行前缀：反向选区的方向在映射后仍保留', () => {
  const text = 'a\nb';
  const plan = F.togglePrefix(text, 3, 0, '- ');
  assert.deepStrictEqual(plan.selection, { anchor: 7, head: 2 });
});

test('行前缀：空前缀抛错', () => {
  assert.throws(function () { F.togglePrefix('abc', 0, 3, ''); }, /prefix must not be empty/);
});

test('行前缀：越界选区抛错', () => {
  assert.throws(function () { F.togglePrefix('abc', 0, 9, '- '); }, /range out of bounds/);
});

// ── 标题级别：设置而不是开关 ────────────────────────────────────────────
test('0015 正文设成 H1 时插入 `# `，内容原样保留', () => {
  const plan = F.headingLevel('abc', 0, 3, 1);
  assert.deepStrictEqual(plan.changes, [{ from: 0, to: 0, insert: '# ' }]);
  assert.strictEqual(apply('abc', plan.changes), '# abc');
});

test('0015 H1 设成 H2 时替换前缀，不出现 `# # `', () => {
  const plan = F.headingLevel('# abc', 0, 5, 2);
  assert.deepStrictEqual(plan.changes, [{ from: 0, to: 2, insert: '## ' }]);
  assert.strictEqual(apply('# abc', plan.changes), '## abc');
});

test('0015 已经是目标级别时返回 null，不压一条空撤销', () => {
  assert.strictEqual(F.headingLevel('# abc', 0, 5, 1), null);
  assert.strictEqual(F.headingLevel('### x', 0, 5, 3), null);
});

test('0015 设成正文（0）时剥掉标题前缀', () => {
  const plan = F.headingLevel('## abc', 0, 6, 0);
  assert.deepStrictEqual(plan.changes, [{ from: 0, to: 3, insert: '' }]);
  assert.strictEqual(apply('## abc', plan.changes), 'abc');
});

test('0015 正文设成正文是 null，不产生空变更', () => {
  assert.strictEqual(F.headingLevel('abc', 0, 3, 0), null);
});

test('0016 只剩 `###` 的行能被认成三级标题', () => {
  assert.strictEqual(F.headingLevel('###', 0, 3, 3), null);
  const toBody = F.headingLevel('###', 0, 3, 0);
  assert.strictEqual(apply('###', toBody.changes), '');
  const toH2 = F.headingLevel('###', 0, 3, 2);
  assert.strictEqual(apply('###', toH2.changes), '## ');
});

test('0016 `#` 后没有空白不是标题，设成 H1 会补一个前缀', () => {
  const plan = F.headingLevel('#foo', 0, 4, 1);
  assert.strictEqual(apply('#foo', plan.changes), '# #foo');
});

test('0016 七个井号不满足标题语法，不会被截成六级', () => {
  const plan = F.headingLevel('####### x', 0, 9, 6);
  assert.strictEqual(apply('####### x', plan.changes), '###### ####### x');
});

test('0016 标题前缀允许制表符，设级别时归一成一个空格', () => {
  const plan = F.headingLevel('#\tfoo', 0, 5, 2);
  assert.deepStrictEqual(plan.changes, [{ from: 0, to: 2, insert: '## ' }]);
  assert.strictEqual(apply('#\tfoo', plan.changes), '## foo');
});

test('0015 多行选区逐行设置，同级别的行不产生变更', () => {
  const text = '# a\n## b\nc';
  const plan = F.headingLevel(text, 0, text.length, 2);
  assert.deepStrictEqual(plan.changes, [
    { from: 0, to: 2, insert: '## ' },
    { from: 9, to: 9, insert: '## ' },
  ]);
  assert.strictEqual(apply(text, plan.changes), '## a\n## b\n## c');
});

test('0015 多行全同级别时返回 null', () => {
  assert.strictEqual(F.headingLevel('## a\n## b', 0, 9, 2), null);
});

test('0015 标题级别越界 / 非整数抛错', () => {
  assert.throws(function () { F.headingLevel('a', 0, 1, -1); }, /0-6/);
  assert.throws(function () { F.headingLevel('a', 0, 1, 7); }, /0-6/);
  assert.throws(function () { F.headingLevel('a', 0, 1, 1.5); }, /0-6/);
  assert.throws(function () { F.headingLevel('a', 0, 1, '1'); }, /0-6/);
});

test('0015 标题命令对反向选区同样映射两个端点', () => {
  const plan = F.headingLevel('# a', 3, 0, 2);
  assert.deepStrictEqual(plan.selection, { anchor: 4, head: 3 });
});

// ── 链接插入 ────────────────────────────────────────────────────────────
test('链接：选中文字包成 [文字](url)，并选中占位符 url', () => {
  const plan = F.insertLink('abc', 0, 3);
  assert.deepStrictEqual(plan.changes, [
    { from: 0, to: 0, insert: '[' },
    { from: 3, to: 3, insert: '](url)' },
  ]);
  assert.strictEqual(apply('abc', plan.changes), '[abc](url)');
  assert.deepStrictEqual(plan.selection, { anchor: 6, head: 9 });
});

test('链接：空选区生成 [](url)，光标直接落在 url 上', () => {
  const plan = F.insertLink('abc', 1, 1);
  assert.strictEqual(apply('abc', plan.changes), 'a[](url)bc');
  assert.deepStrictEqual(plan.selection, { anchor: 4, head: 7 });
});

test('链接：选中区域内的换行与竖线逐字节保留', () => {
  const text = 'a|b\nc';
  const plan = F.insertLink(text, 0, 5);
  assert.strictEqual(apply(text, plan.changes), '[a|b\nc](url)');
});

test('链接：反向选区仍按较小 / 较大端点包围', () => {
  const plan = F.insertLink('abc', 3, 0);
  assert.strictEqual(apply('abc', plan.changes), '[abc](url)');
  assert.deepStrictEqual(plan.selection, { anchor: 6, head: 9 });
});

test('链接：越界选区抛错', () => {
  assert.throws(function () { F.insertLink('abc', 0, 9); }, /range out of bounds/);
});

// ── commandPlan：命令到计划的唯一映射 ──────────────────────────────────
test('commandPlan：bold / italic / code / strike 各自用对应的标记包裹', () => {
  assert.strictEqual(apply('x', F.commandPlan('bold', 'x', 0, 1).changes), '**x**');
  assert.strictEqual(apply('x', F.commandPlan('italic', 'x', 0, 1).changes), '*x*');
  assert.strictEqual(apply('x', F.commandPlan('code', 'x', 0, 1).changes), '`x`');
  assert.strictEqual(apply('x', F.commandPlan('strike', 'x', 0, 1).changes), '~~x~~');
});

test('commandPlan：body / h1 / h2 / h3 分别设置 0 / 1 / 2 / 3 级', () => {
  assert.strictEqual(apply('# x', F.commandPlan('body', '# x', 0, 3).changes), 'x');
  assert.strictEqual(apply('x', F.commandPlan('h1', 'x', 0, 1).changes), '# x');
  assert.strictEqual(apply('x', F.commandPlan('h2', 'x', 0, 1).changes), '## x');
  assert.strictEqual(apply('x', F.commandPlan('h3', 'x', 0, 1).changes), '### x');
});

test('commandPlan：ul / quote 分别补 `- ` 与 `> `', () => {
  assert.strictEqual(apply('x', F.commandPlan('ul', 'x', 0, 1).changes), '- x');
  assert.strictEqual(apply('x', F.commandPlan('quote', 'x', 0, 1).changes), '> x');
});

test('commandPlan：link 走 insertLink，不是开关', () => {
  assert.strictEqual(apply('x', F.commandPlan('link', 'x', 0, 1).changes), '[x](url)');
});

test('commandPlan：未知 / 空 / 大小写不符的命令返回 null', () => {
  assert.strictEqual(F.commandPlan('nope', 'x', 0, 1), null);
  assert.strictEqual(F.commandPlan('', 'x', 0, 1), null);
  assert.strictEqual(F.commandPlan('BOLD', 'x', 0, 1), null);
  assert.strictEqual(F.commandPlan(null, 'x', 0, 1), null);
});

test('commandPlan：已就位的命令返回 null（body 对正文、同级标题）', () => {
  assert.strictEqual(F.commandPlan('body', 'abc', 0, 3), null);
  assert.strictEqual(F.commandPlan('h2', '## abc', 0, 6), null);
});

// ── 格式开关组合（举一反三）────────────────────────────────────────────
test('组合：加粗开两次回到原文，选区也跟着回到原处', () => {
  const first = inline('abc', 0, 3, '**');
  const text2 = apply('abc', first.changes);
  assert.strictEqual(text2, '**abc**');
  const second = inline(text2, first.selection.anchor, first.selection.head, '**');
  assert.strictEqual(apply(text2, second.changes), 'abc');
  assert.deepStrictEqual(second.selection, { anchor: 0, head: 3 });
});

test('组合：在加粗里点斜体会剥掉一层星号（只认紧邻字节，不猜嵌套）', () => {
  // `design/0061` §6：判据只看选区外紧邻字节 ⇒ 加粗的 `**` 里正好露出一个 `*`，
  // 单字符斜体命令把它当成「已有标记」剥掉，得到 `*abc*`，而不是 `***abc***`。
  const bold = inline('abc', 0, 3, '**');
  const boldText = apply('abc', bold.changes);
  assert.strictEqual(boldText, '**abc**');
  const italic = inline(boldText, bold.selection.anchor, bold.selection.head, '*');
  const stripped = apply(boldText, italic.changes);
  assert.strictEqual(stripped, '*abc*');
  // 再点加粗：左侧不足两个字符、右侧只有一个 `*` ⇒ 两侧各加一层。
  const bold2 = inline(stripped, 1, 4, '**');
  assert.strictEqual(apply(stripped, bold2.changes), '***abc***');
});

test('组合：在斜体里开加粗得到 ***abc***，关掉斜体后保留加粗', () => {
  const italic = inline('abc', 0, 3, '*');
  const italicText = apply('abc', italic.changes);
  assert.strictEqual(italicText, '*abc*');
  const bold = inline(italicText, 1, 4, '**');
  const both = apply(italicText, bold.changes);
  assert.strictEqual(both, '***abc***');
  const off = inline(both, bold.selection.anchor, bold.selection.head, '*');
  assert.strictEqual(apply(both, off.changes), '**abc**');
});

test('组合：代码标记包住已加粗文字，剥代码后加粗仍在', () => {
  const bold = inline('ab', 0, 2, '**');
  const boldText = apply('ab', bold.changes);
  const code = inline(boldText, 2, 4, '`');
  const text2 = apply(boldText, code.changes);
  assert.strictEqual(text2, '**`ab`**');
  const off = inline(text2, code.selection.anchor, code.selection.head, '`');
  assert.strictEqual(apply(text2, off.changes), '**ab**');
});

test('组合：删除线与其他行内标记互不干扰', () => {
  const strike = inline('abc', 0, 3, '~~');
  assert.strictEqual(apply('abc', strike.changes), '~~abc~~');
  const again = inline('~~abc~~', 2, 5, '~~');
  assert.strictEqual(apply('~~abc~~', again.changes), 'abc');
});

test('组合：标题级别可连续设置，H1 → H3 → 正文', () => {
  let text = 'abc';
  let plan = F.headingLevel(text, 0, 3, 1);
  text = apply(text, plan.changes);
  assert.strictEqual(text, '# abc');
  plan = F.headingLevel(text, 0, text.length, 3);
  text = apply(text, plan.changes);
  assert.strictEqual(text, '### abc');
  plan = F.headingLevel(text, 0, text.length, 0);
  text = apply(text, plan.changes);
  assert.strictEqual(text, 'abc');
});

test('组合：列表开关开两次回到原文（多行混合）', () => {
  const text = '- a\nb';
  const first = F.togglePrefix(text, 0, text.length, '- ');
  assert.strictEqual(apply(text, first.changes), '- a\n- b');
  const second = F.togglePrefix('- a\n- b', 0, 7, '- ');
  assert.strictEqual(apply('- a\n- b', second.changes), 'a\nb');
});

test('组合：引用与列表各自独立，先列表后引用得到 `> - a`', () => {
  const ul = F.togglePrefix('a', 0, 1, '- ');
  const withUl = apply('a', ul.changes);
  const quote = F.togglePrefix(withUl, 0, withUl.length, '> ');
  assert.strictEqual(apply(withUl, quote.changes), '> - a');
});

test('组合：标题里再开行内标记，前缀字节不受影响', () => {
  const plan = F.toggleInline('# ab', 2, 4, '**');
  assert.strictEqual(apply('# ab', plan.changes), '# **ab**');
});

// ── BUTTONS：顺序、键、字形 ─────────────────────────────────────────────
test('按钮表有 11 个按钮，顺序即屏幕顺序', () => {
  assert.strictEqual(F.BUTTONS.length, 11);
  assert.deepStrictEqual(F.BUTTONS.map(function (b) { return b.cmd; }), [
    'bold', 'italic', 'code', 'strike', 'link', 'body', 'h1', 'h2', 'h3', 'ul', 'quote',
  ]);
});

test('按钮表的 key 是命令名本身（完整键 = live.format.<key>）', () => {
  assert.deepStrictEqual(F.BUTTONS.map(function (b) { return b.key; }), F.BUTTONS.map(function (b) { return b.cmd; }));
});

test('按钮表的字形与设计一致，且不含任何自然语言文案', () => {
  assert.deepStrictEqual(F.BUTTONS.map(function (b) { return b.text; }), [
    'B', 'I', '</>', 'S', '↗', '¶', 'H1', 'H2', 'H3', '•', '❯',
  ]);
  for (const b of F.BUTTONS) assert.match(b.text, /^[^一-鿿]+$/);
});

test('按钮表的命令全都能翻成非 null 计划（正文 / 正文级除外）', () => {
  for (const b of F.BUTTONS) {
    const plan = F.commandPlan(b.cmd, 'x', 0, 1);
    if (b.cmd === 'body') {
      assert.strictEqual(plan, null);
    } else {
      assert.ok(plan && plan.changes.length > 0, b.cmd);
    }
  }
});

test('按钮表只有 B / I / S 带样式类，其余靠字形', () => {
  const withCls = F.BUTTONS.filter(function (b) { return b.cls; });
  assert.deepStrictEqual(withCls.map(function (b) { return b.cmd; }), ['bold', 'italic', 'strike']);
  assert.strictEqual(withCls[0].cls, 'live-formatbar-bold');
  assert.strictEqual(withCls[1].cls, 'live-formatbar-italic');
  assert.strictEqual(withCls[2].cls, 'live-formatbar-strike');
});

test('按钮表的命令名两两不重复', () => {
  const seen = {};
  for (const b of F.BUTTONS) {
    assert.strictEqual(seen[b.cmd], undefined, b.cmd);
    seen[b.cmd] = true;
  }
});

// ── 边界：空文档 / 行首行尾 ─────────────────────────────────────────────
test('边界：空文档上开加粗只插入两个标记并把光标放中间', () => {
  const plan = inline('', 0, 0, '**');
  assert.strictEqual(apply('', plan.changes), '****');
  assert.deepStrictEqual(plan.selection, { anchor: 2, head: 2 });
});

test('边界：整行选区开前缀不影响下一行（右端规则）', () => {
  const text = 'a\nb';
  const plan = F.togglePrefix(text, 0, 2, '- ');
  assert.strictEqual(plan.changes.length, 1);
  assert.strictEqual(apply(text, plan.changes), '- a\nb');
});

test('边界：链接在文档末尾也能生成完整占位符', () => {
  const plan = F.insertLink('abc', 3, 3);
  assert.strictEqual(apply('abc', plan.changes), 'abc[](url)');
});

test('边界：标题设置在空文档上生成一个空标题前缀', () => {
  const plan = F.headingLevel('', 0, 0, 1);
  assert.strictEqual(apply('', plan.changes), '# ');
});
