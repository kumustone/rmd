// `design/0078` §2.2 / §7：**块命令**的纯字节判据。
//
// ⚠️ 每条都断言**完整输出串**，⛔ 不按"看起来对不对"：
//    这些命令错一次不会报错——只会把两段正文粘成一段、把围栏提前闭合、
//    或把 `2 * 3 * 4` 里的乘号当成强调删掉。屏幕上看不见标记，用户没有第二份真相。
//
// ⭐ 覆盖：空文档 / 行中 / 跨行选区 / 列表内 / 开关语义 / 幂等 / 越界 / 文案闸门。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const B = require('../../src/live/blockcmd.js');

/**
 * @param {string} cmd
 * @param {string} text
 * @param {number} anchor
 * @param {number} head
 * @returns {{text:string, selection:{anchor:number, head:number}}}
 */
function plan(cmd, text, anchor, head) {
  const p = B.plan(cmd, text, anchor, head);
  assert.ok(p, cmd + ' 没有计划：' + JSON.stringify(text));
  return p;
}

// ── 空文档：每种容器都要“自成一块”，光标落在可以立刻打字的位置 ───────────────

test('空文档：代码块 = 围栏 + 一个空行，光标在空行', function () {
  const p = plan('code', '', 0, 0);
  assert.strictEqual(p.text, '```\n\n```');
  assert.deepStrictEqual(p.selection, { anchor: 4, head: 4 });
});

test('空文档：公式块 = $$ + 一个空行', function () {
  const p = plan('math', '', 0, 0);
  assert.strictEqual(p.text, '$$\n\n$$');
  assert.deepStrictEqual(p.selection, { anchor: 3, head: 3 });
});

test('空文档：表格 = 规范 2 列 × 1 数据行，光标在第一格', function () {
  const p = plan('table', '', 0, 0);
  assert.strictEqual(p.text, '|  |  |\n| --- | --- |\n|  |  |');
  assert.deepStrictEqual(p.selection, { anchor: 2, head: 2 });
});

test('空文档：提示块 = `> [!NOTE]` + 可继续写的引用行', function () {
  const p = plan('callout', '', 0, 0);
  assert.strictEqual(p.text, '> [!NOTE]\n> ');
  assert.deepStrictEqual(p.selection, { anchor: 12, head: 12 });
});

test('空文档：分隔线 = 独立一段', function () {
  const p = plan('hr', '', 0, 0);
  assert.strictEqual(p.text, '---');
  assert.deepStrictEqual(p.selection, { anchor: 3, head: 3 });
});

// ── 容器命令：选区成为内容；围栏要能包住自带的反引号 ─────────────────────────

test('代码块：选中文字原样成为内容，光标在内容首', function () {
  const p = plan('code', 'abc', 0, 3);
  assert.strictEqual(p.text, '```\nabc\n```');
  assert.deepStrictEqual(p.selection, { anchor: 4, head: 4 });
});

test('代码块：选中文字自带 ``` ⇒ 围栏加长到 4，⛔ 不提前闭合', function () {
  const src = '```\nx\n```';
  const p = plan('code', src, 0, src.length);
  assert.strictEqual(p.text, '````\n```\nx\n```\n````');
  assert.deepStrictEqual(p.selection, { anchor: 5, head: 5 });
});

test('提示块：跨行选区每行都加引用前缀，空行只留 `>`', function () {
  const p = plan('callout', 'a\n\nb', 0, 4);
  assert.strictEqual(p.text, '> [!NOTE]\n> a\n>\n> b');
  assert.deepStrictEqual(p.selection, { anchor: 12, head: 12 });
});

test('公式块：跨行选区原样放进 $$ 之间', function () {
  const p = plan('math', 'a\nb', 0, 3);
  assert.strictEqual(p.text, '$$\na\nb\n$$');
  assert.deepStrictEqual(p.selection, { anchor: 3, head: 3 });
});

// ── 行中插入：把原行断成“前段 / 新块 / 后段”，⛔ 不把两段粘成一段 ────────────

test('行中：分隔线两侧各补一个空行，原行前后两段都保住', function () {
  const p = plan('hr', 'abc', 1, 1);
  assert.strictEqual(p.text, 'a\n\n---\n\nbc');
  assert.deepStrictEqual(p.selection, { anchor: 6, head: 6 });
});

test('行中：表格替换选区，选区文字不进入表内容', function () {
  const p = plan('table', 'hello world', 6, 11);
  assert.strictEqual(p.text, 'hello \n\n|  |  |\n| --- | --- |\n|  |  |');
  assert.deepStrictEqual(p.selection, { anchor: 10, head: 10 });
});

test('行中：代码块吞掉选中文字，围栏外的前后段逐字保留', function () {
  const p = plan('code', 'abcdef', 3, 6);
  assert.strictEqual(p.text, 'abc\n\n```\ndef\n```');
  assert.deepStrictEqual(p.selection, { anchor: 9, head: 9 });
});

test('列表内：分隔线插在两项之间，两项的列表标记一个字节不动', function () {
  const p = plan('hr', '- a\n- b', 3, 3);
  assert.strictEqual(p.text, '- a\n\n---\n\n- b');
  assert.deepStrictEqual(p.selection, { anchor: 8, head: 8 });
});

test('文首 / 文末：插入不额外叠空行', function () {
  const atStart = plan('hr', 'abc', 0, 0);
  assert.strictEqual(atStart.text, '---\n\nabc');
  const atEnd = plan('hr', 'abc', 3, 3);
  assert.strictEqual(atEnd.text, 'abc\n\n---');
});

test('上一行已空：⛔ 不叠第二个空行', function () {
  const p = plan('hr', 'a\n\nbc', 2, 2);
  assert.strictEqual(p.text, 'a\n\n---\n\nbc');
});

// ── 图片：行内语法，⛔ 不按块间空行规则拆段 ──────────────────────────────────

test('图片：空选区插 `![](path)` 并选中占位符 path', function () {
  const p = plan('image', 'ab', 1, 1);
  assert.strictEqual(p.text, 'a![](path)b');
  assert.deepStrictEqual(p.selection, { anchor: 5, head: 9 });
});

test('图片：选中文字当成路径，仍选中路径本身', function () {
  const p = plan('image', 'abc', 1, 2);
  assert.strictEqual(p.text, 'a![](b)c');
  assert.deepStrictEqual(p.selection, { anchor: 5, head: 6 });
});

test('图片：跨行选区 ⇒ null（路径不能跨行，⛔ 不猜用户想留哪一段）', function () {
  assert.strictEqual(B.plan('image', 'a\nb', 0, 3), null);
});

// ── 有序列表：开关 + 重编号 + 保留缩进 / 内容 ───────────────────────────────

test('有序列表：正文两行 ⇒ 1. / 2.，选区跟着内容走', function () {
  const p = plan('ol', 'a\nb', 0, 3);
  assert.strictEqual(p.text, '1. a\n2. b');
  assert.deepStrictEqual(p.selection, { anchor: 3, head: 9 });
});

test('有序列表：全部已是有序项 ⇒ 整批剥掉标记', function () {
  const src = '1. a\n2. b';
  const p = plan('ol', src, 0, src.length);
  assert.strictEqual(p.text, 'a\nb');
  assert.deepStrictEqual(p.selection, { anchor: 0, head: 3 });
});

test('有序列表：已有无序 / 星号项 ⇒ 换成顺序编号，缩进保留', function () {
  const src = '  - x\n  * y';
  const p = plan('ol', src, 0, src.length);
  assert.strictEqual(p.text, '  1. x\n  2. y');
});

test('有序列表：空白行不编号，但编号在非空行之间连续', function () {
  const src = 'a\n\nb';
  const p = plan('ol', src, 0, src.length);
  assert.strictEqual(p.text, '1. a\n\n2. b');
});

test('有序列表：部分有序 ⇒ 统一重编号（⛔ 不叠成 `1. 1. `）', function () {
  const src = '1. a\n- b';
  const p = plan('ol', src, 0, src.length);
  assert.strictEqual(p.text, '1. a\n2. b');
});

test('有序列表：没有非空行 ⇒ null（⛔ 白压撤销）', function () {
  assert.strictEqual(B.plan('ol', '', 0, 0), null);
  assert.strictEqual(B.plan('ol', '\n', 0, 1), null);
});

test('有序列表：重复调用是幂等的（已有序 ⇒ 第二下是“剥掉”，不是再套一层）', function () {
  const once = plan('ol', 'a\nb', 0, 3);
  const twice = plan('ol', once.text, 0, once.text.length);
  assert.strictEqual(twice.text, 'a\nb');
});

// ── 清除格式：块前缀 + 行内标记；⛔ 不动乘号这类普通符号 ────────────────────

test('清除格式：标题 / 引用 / 任务项 + 行内强调 / 代码', function () {
  const src = '# **Bold** and `code`\n> quote\n- [ ] task';
  const p = plan('clear', src, 0, src.length);
  assert.strictEqual(p.text, 'Bold and code\nquote\ntask');
});

test('清除格式：链接与图片只留文字', function () {
  const src = 'see ![alt](a.png) and [text](u)';
  const p = plan('clear', src, 0, src.length);
  assert.strictEqual(p.text, 'see alt and text');
});

test('清除格式：`2 * 3 * 4` 的星号是乘号 ⇒ 无改动 = null', function () {
  assert.strictEqual(B.plan('clear', '2 * 3 * 4', 0, 9), null);
});

test('清除格式：选区停在下一行行首 ⇒ 下一行不算进来', function () {
  const src = '# a\nb';
  const p = plan('clear', src, 0, 4);
  assert.strictEqual(p.text, 'a\nb');
});

// ── 程序错误：越界 / 非整数必须抛，⛔ 不静默夹取 ─────────────────────────────

test('非法选区 / 未知命令', function () {
  assert.throws(function () { B.plan('hr', 'abc', -1, 0); }, /range out of bounds/);
  assert.throws(function () { B.plan('hr', 'abc', 0, 4); }, /range out of bounds/);
  assert.throws(function () { B.plan('hr', 'abc', 0.5, 1); }, /selection is not an integer/);
  assert.strictEqual(B.plan('nope', 'abc', 0, 1), null);
});

// ── 命令表 / 文案闸门 ───────────────────────────────────────────────────────

test('命令表：每条都能翻出非空计划（未知命令除外）', function () {
  const fixtures = {
    clear: { text: '**x**', anchor: 0, head: 5 },
    ol: { text: 'x', anchor: 0, head: 1 },
    image: { text: 'ab', anchor: 1, head: 1 },
  };
  B.BLOCK_COMMANDS.forEach(function (item) {
    const f = fixtures[item.cmd] || { text: 'abc', anchor: 1, head: 2 };
    const p = B.plan(item.cmd, f.text, f.anchor, f.head);
    assert.ok(p, '命令 ' + item.cmd + ' 没有计划');
    assert.notStrictEqual(p.text, f.text, '命令 ' + item.cmd + ' 没有产生改动');
  });
  const seen = new Set();
  B.BLOCK_COMMANDS.forEach(function (item) {
    assert.ok(!seen.has(item.cmd), '命令重复：' + item.cmd);
    seen.add(item.cmd);
  });
});

test('块命令文案全部走字典：中英都有、非空、互不相同', function () {
  const I = require('../../src/services/i18n.js');
  const keys = ['live.format.more', 'live.block.menu', 'status.table-rejected'].concat(
    B.BLOCK_COMMANDS.map(function (item) { return 'live.block.' + item.key; })
  );
  keys.forEach(function (k) {
    ['zh', 'en'].forEach(function (lang) {
      const v = I.DICT[lang][k];
      assert.strictEqual(typeof v, 'string', lang + ' 缺键：' + k);
      assert.ok(v.trim().length > 0, lang + ' 空文案：' + k);
    });
    assert.notStrictEqual(I.DICT.zh[k], I.DICT.en[k], '中英文案相同：' + k);
  });
});
