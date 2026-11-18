// 浮动格式栏的纯决策：行内标记开关、行前缀开关、标题级别、链接插入与选区映射。
// 守的是 `design/0061` §6：判据只按源码字节算，⛔ 不猜隐藏标记覆盖了谁。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load() {
  const src = fs.readFileSync(path.join(ROOT, 'src/live/formatbar.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.rmd.liveFormatbar;
}

const F = load();

test('所有编辑计划都拒绝非整数与越界选区，不把坏坐标喂给 CM6', () => {
  assert.throws(function () { F.toggleInline('abcdef', 0.5, 2, '*'); }, /not an integer/);
  assert.throws(function () { F.togglePrefix('abcdef', 0, NaN, '- '); }, /not an integer/);
  assert.throws(function () { F.headingLevel('abcdef', -1, 2, 1); }, /out of bounds/);
  assert.throws(function () { F.insertLink('abc', 0, 4); }, /out of bounds/);
});

test('selectedLines 取整行，选区停在下一行行首时不多算那一行', () => {
  assert.deepStrictEqual(F.selectedLines('abc', 1, 2), [{ start: 0, end: 3 }]);
  assert.deepStrictEqual(F.selectedLines('a\nb', 0, 2), [{ start: 0, end: 1 }]);
  assert.deepStrictEqual(F.selectedLines('a\nb', 0, 3), [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
  ]);
});

test('selectedLines 对空行、空文档与末尾换行给出确定的区间', () => {
  assert.deepStrictEqual(F.selectedLines('', 0, 0), [{ start: 0, end: 0 }]);
  assert.deepStrictEqual(F.selectedLines('a\n\nb', 2, 2), [{ start: 2, end: 2 }]);
  assert.deepStrictEqual(F.selectedLines('a\nb\n', 0, 4), [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
  ]);
});

test('mapPosition：变更在左侧就平移，落在替换内部贴到右端，在右侧就停', () => {
  const ins = [{ from: 2, to: 2, insert: '- ' }];
  assert.strictEqual(F.mapPosition(0, ins), 0);
  assert.strictEqual(F.mapPosition(2, ins), 4);
  assert.strictEqual(F.mapPosition(5, ins), 7);
  const del = [{ from: 1, to: 4, insert: '' }];
  assert.strictEqual(F.mapPosition(2, del), 1);
  assert.strictEqual(F.mapPosition(4, del), 1);
  assert.strictEqual(F.mapPosition(5, del), 2);
});

test('mapPosition 依次累计多条变更，不按原坐标重复平移', () => {
  const changes = [
    { from: 0, to: 0, insert: '# ' },
    { from: 5, to: 7, insert: 'x' },
  ];
  assert.deepStrictEqual(F.mapPosition(6, changes), 8);
  assert.strictEqual(F.mapPosition(7, changes), 8);
  assert.strictEqual(F.mapPosition(10, changes), 11);
});

test('toggleInline 未命中时给选区两侧各包一层，端点同步外移', () => {
  assert.deepStrictEqual(F.toggleInline('hello', 1, 3, '**'), {
    changes: [
      { from: 1, to: 1, insert: '**' },
      { from: 3, to: 3, insert: '**' },
    ],
    selection: { anchor: 3, head: 5 },
  });
});

test('toggleInline 两侧都紧邻标记时剥一层，反向选区方向保留', () => {
  assert.deepStrictEqual(F.toggleInline('**hi**', 2, 4, '**'), {
    changes: [
      { from: 0, to: 2, insert: '' },
      { from: 4, to: 6, insert: '' },
    ],
    selection: { anchor: 0, head: 2 },
  });
  assert.deepStrictEqual(F.toggleInline('**hi**', 4, 2, '**').selection, {
    anchor: 2,
    head: 0,
  });
});

test('toggleInline 空选区插入一对标记，光标落在中间', () => {
  assert.deepStrictEqual(F.toggleInline('ab', 1, 1, '**'), {
    changes: [{ from: 1, to: 1, insert: '****' }],
    selection: { anchor: 3, head: 3 },
  });
  assert.deepStrictEqual(F.toggleInline('', 0, 0, '`'), {
    changes: [{ from: 0, to: 0, insert: '``' }],
    selection: { anchor: 1, head: 1 },
  });
});

test('toggleInline 只有一侧有标记时不停留在半剥状态，而是再包一层', () => {
  assert.deepStrictEqual(F.toggleInline('**hi', 2, 4, '**'), {
    changes: [
      { from: 2, to: 2, insert: '**' },
      { from: 4, to: 4, insert: '**' },
    ],
    selection: { anchor: 4, head: 6 },
  });
  assert.deepStrictEqual(F.toggleInline('hi**', 0, 2, '**').changes, [
    { from: 0, to: 0, insert: '**' },
    { from: 2, to: 2, insert: '**' },
  ]);
});

test('toggleInline 对多字符与单字符标记同一套字节判据', () => {
  assert.deepStrictEqual(F.toggleInline('~~x~~', 2, 3, '~~').changes, [
    { from: 0, to: 2, insert: '' },
    { from: 3, to: 5, insert: '' },
  ]);
  assert.deepStrictEqual(F.toggleInline('`x`', 1, 2, '`').selection, { anchor: 0, head: 1 });
});

test('toggleInline 对空 marker 直接抛错，不生成没有标记的计划', () => {
  assert.throws(function () { F.toggleInline('x', 0, 0, ''); }, /marker must not be empty/);
  assert.throws(function () { F.toggleInline('x', 0, 0, null); }, /marker must not be empty/);
});

test('togglePrefix 混合选区只给缺前缀的行补，已有的一行不动', () => {
  assert.deepStrictEqual(F.togglePrefix('a\n- b', 0, 4, '- '), {
    changes: [{ from: 0, to: 0, insert: '- ' }],
    selection: { anchor: 2, head: 6 },
  });
});

test('togglePrefix 全都有前缀时整批剥掉，选区随之左移', () => {
  assert.deepStrictEqual(F.togglePrefix('- a\n- b', 0, 7, '- '), {
    changes: [
      { from: 0, to: 2, insert: '' },
      { from: 4, to: 6, insert: '' },
    ],
    selection: { anchor: 0, head: 3 },
  });
});

test('togglePrefix 空选区只作用于光标所在行', () => {
  assert.deepStrictEqual(F.togglePrefix('- a\nb', 4, 4, '- '), {
    changes: [{ from: 4, to: 4, insert: '- ' }],
    selection: { anchor: 6, head: 6 },
  });
});

test('togglePrefix 的多行判定按每行行首字面比，不认 * / + 与缩进', () => {
  assert.deepStrictEqual(F.togglePrefix('* a\n+ b', 0, 7, '- ').changes, [
    { from: 0, to: 0, insert: '- ' },
    { from: 4, to: 4, insert: '- ' },
  ]);
  assert.deepStrictEqual(F.togglePrefix('  - a', 0, 5, '- ').changes, [
    { from: 0, to: 0, insert: '- ' },
  ]);
});

test('togglePrefix 对空 prefix 抛错', () => {
  assert.throws(function () { F.togglePrefix('a', 0, 1, ''); }, /prefix must not be empty/);
});

test('togglePrefix 选区停在下一行行首时只改上一行', () => {
  assert.deepStrictEqual(F.togglePrefix('- a\n- b', 1, 4, '- '), {
    changes: [{ from: 0, to: 2, insert: '' }],
    selection: { anchor: 0, head: 2 },
  });
});

test('headingLevel 设级别：正文补 #、旧标题换级、同级别不产生变更', () => {
  assert.deepStrictEqual(F.headingLevel('title', 0, 5, 1), {
    changes: [{ from: 0, to: 0, insert: '# ' }],
    selection: { anchor: 2, head: 7 },
  });
  assert.deepStrictEqual(F.headingLevel('### t', 0, 5, 2), {
    changes: [{ from: 0, to: 4, insert: '## ' }],
    selection: { anchor: 3, head: 4 },
  });
  assert.strictEqual(F.headingLevel('## t', 0, 4, 2), null);
});

test('headingLevel 的 0 级剥掉整个标记段，含多余空白', () => {
  assert.deepStrictEqual(F.headingLevel('#   a', 0, 5, 0), {
    changes: [{ from: 0, to: 4, insert: '' }],
    selection: { anchor: 0, head: 1 },
  });
  assert.strictEqual(F.headingLevel('plain', 0, 5, 0), null);
});

test('headingLevel 多行只改需要改的行，并保留其余行', () => {
  assert.deepStrictEqual(F.headingLevel('a\n# b', 0, 5, 1), {
    changes: [{ from: 0, to: 0, insert: '# ' }],
    selection: { anchor: 2, head: 7 },
  });
});

test('headingLevel 的行首判据要求 # 后是空白或行尾', () => {
  assert.deepStrictEqual(F.headingLevel('#tag', 0, 4, 1).changes, [
    { from: 0, to: 0, insert: '# ' },
  ]);
  assert.strictEqual(F.headingLevel('#tag', 0, 4, 0), null);
  assert.deepStrictEqual(F.headingLevel('#', 0, 1, 0).changes, [
    { from: 0, to: 1, insert: '' },
  ]);
  assert.strictEqual(F.headingLevel('#', 0, 1, 1), null);
});

test('headingLevel 对 0–6 之外的级别一律抛错', () => {
  for (const bad of [-1, 7, 1.5, '2', NaN, null]) {
    assert.throws(function () { F.headingLevel('x', 0, 1, bad); }, /0-6/, String(bad));
  }
});

test('insertLink 把选区包成 [文字](url)，并选中占位 url', () => {
  assert.deepStrictEqual(F.insertLink('hello', 1, 3), {
    changes: [
      { from: 1, to: 1, insert: '[' },
      { from: 3, to: 3, insert: '](url)' },
    ],
    selection: { anchor: 6, head: 9 },
  });
});

test('insertLink 空选区生成 [](url)，光标直接落在 url 上（反向也一样）', () => {
  assert.deepStrictEqual(F.insertLink('hello', 2, 2), {
    changes: [
      { from: 2, to: 2, insert: '[' },
      { from: 2, to: 2, insert: '](url)' },
    ],
    selection: { anchor: 5, head: 8 },
  });
  assert.deepStrictEqual(F.insertLink('hello', 3, 1).selection, { anchor: 6, head: 9 });
});

test('commandPlan 把每个按钮命令映射到对应纯函数，未知命令给 null', () => {
  assert.deepStrictEqual(
    F.commandPlan('bold', 'x', 0, 1),
    F.toggleInline('x', 0, 1, '**')
  );
  assert.deepStrictEqual(
    F.commandPlan('italic', 'x', 0, 1),
    F.toggleInline('x', 0, 1, '*')
  );
  assert.deepStrictEqual(
    F.commandPlan('code', 'x', 0, 1),
    F.toggleInline('x', 0, 1, '`')
  );
  assert.deepStrictEqual(
    F.commandPlan('strike', 'x', 0, 1),
    F.toggleInline('x', 0, 1, '~~')
  );
  assert.deepStrictEqual(F.commandPlan('link', 'x', 0, 1), F.insertLink('x', 0, 1));
  assert.deepStrictEqual(F.commandPlan('h2', 'x', 0, 1), F.headingLevel('x', 0, 1, 2));
  assert.deepStrictEqual(F.commandPlan('ul', 'x', 0, 1), F.togglePrefix('x', 0, 1, '- '));
  assert.deepStrictEqual(F.commandPlan('quote', 'x', 0, 1), F.togglePrefix('x', 0, 1, '> '));
  assert.strictEqual(F.commandPlan('Bold', 'x', 0, 1), null);
  assert.strictEqual(F.commandPlan('', 'x', 0, 1), null);
  assert.strictEqual(F.commandPlan('nope', 'x', 0, 1), null);
});

test('commandPlan 的 body 对正文是 null、对标题是剥前缀', () => {
  assert.strictEqual(F.commandPlan('body', 'plain', 0, 0), null);
  assert.deepStrictEqual(F.commandPlan('body', '# t', 0, 0), {
    changes: [{ from: 0, to: 2, insert: '' }],
    selection: { anchor: 0, head: 0 },
  });
});

test('BUTTONS 的屏幕顺序、命令名与字典键一致，且每个命令都有计划', () => {
  assert.deepStrictEqual(F.BUTTONS.map(function (b) { return b.cmd; }), [
    'bold', 'italic', 'code', 'strike', 'link', 'body', 'h1', 'h2', 'h3', 'ul', 'quote',
  ]);
  for (const b of F.BUTTONS) {
    assert.strictEqual(b.key, b.cmd, b.cmd);
    assert.ok(typeof b.text === 'string' && b.text.length > 0, b.cmd);
    const plan = F.commandPlan(b.cmd, 'x', 0, 1);
    if (b.cmd === 'body') assert.strictEqual(plan, null);
    else assert.ok(plan && plan.changes.length > 0, b.cmd);
  }
});

test('计划里的 changes 都落在源码边界内，插入/删除位置可直接喂给 CM6', () => {
  const plans = [
    F.toggleInline('hello', 1, 3, '**'),
    F.togglePrefix('- a\n- b', 0, 7, '- '),
    F.headingLevel('a\n# b', 0, 5, 1),
    F.insertLink('hello', 1, 3),
  ];
  for (const plan of plans) {
    for (const c of plan.changes) {
      assert.ok(Number.isInteger(c.from) && Number.isInteger(c.to), JSON.stringify(c));
      assert.ok(c.from >= 0 && c.from <= c.to, JSON.stringify(c));
      assert.strictEqual(typeof c.insert, 'string');
    }
    assert.ok(Number.isInteger(plan.selection.anchor));
    assert.ok(Number.isInteger(plan.selection.head));
  }
});
