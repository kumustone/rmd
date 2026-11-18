// 侧边栏常驻搜索的纯逻辑（`src/services/sidebarsearch.js`）。
//
// 从历史缺陷出发，守两族**静默**错误：
//   · `0019` 外部新增文件在树里不出现 —— 同一根因也会让"进入搜索那一趟"不重建索引，
//     于是新文件永远搜不到，界面只多一行索引年龄；
//   · `0042` 的分支写错 —— 每次按键都重建索引（每个键等一次全树遍历），
//     或已经在搜却从不重建（新文件永远不出现）。
// 选中项移动守的是环绕与越界归一：错了下键会卡在末行、或从 -1 跳到中间。
//
// ⚠️ 模块加载期取 `window.rmd.search`，所以必须先加载 `search.js`。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadInto(win, rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', 'module', 'require', src)(win, undefined, undefined);
}

const win = {};
loadInto(win, 'src/services/i18n.js');
loadInto(win, 'src/services/search.js');
loadInto(win, 'src/services/sidebarsearch.js');
const S = win.rmd.sidebarsearch;

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
// 变体：进入搜索那一趟必须重建索引，之后逐键只查不重建。
// ─────────────────────────────────────────────────────────────────────────

test('0019/从没在搜时敲第一个字符 ⇒ 查询且强制重建索引', () => {
  assert.deepStrictEqual(S.planQuery(false, '新'), { kind: 'query', rebuild: true });
});

test('0019/已经在搜时继续敲 ⇒ 只查不重建（否则每个键都等一次全树遍历）', () => {
  assert.deepStrictEqual(S.planQuery(true, '新文'), { kind: 'query', rebuild: false });
});

test('0019/清空输入框 ⇒ 收起结果层，不发 IPC', () => {
  assert.deepStrictEqual(S.planQuery(true, ''), { kind: 'clear' });
  assert.deepStrictEqual(S.planQuery(false, ''), { kind: 'clear' });
});

test('0019/纯空白（半角 / 全角 / 制表 / 换行）等同于没输入', () => {
  for (const p of [' ', '   ', '\t', '\n', '　', ' ']) {
    assert.deepStrictEqual(S.planQuery(true, p), { kind: 'clear' }, JSON.stringify(p));
  }
});

test('0019/非字符串输入一律收起，不把数字当地址查', () => {
  for (const p of [null, undefined, 7, {}, []]) {
    assert.deepStrictEqual(S.planQuery(false, p), { kind: 'clear' }, String(p));
  }
});

test('0019/重建判据只看“现在是不是已经在搜”，与输入内容无关', () => {
  assert.strictEqual(S.planQuery(false, 'a').rebuild, true);
  assert.strictEqual(S.planQuery(false, '很长的一段中文搜索词').rebuild, true);
  assert.strictEqual(S.planQuery(true, 'a').rebuild, false);
});

test('0019/返回值只有两个键，调用方不能从多余字段猜状态', () => {
  assert.deepStrictEqual(Object.keys(S.planQuery(false, 'x')).sort(), ['kind', 'rebuild']);
  assert.deepStrictEqual(Object.keys(S.planQuery(true, '')).sort(), ['kind']);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0042（侧边栏文件名搜索的选中项移动）
// 变体：环绕、越界归一、没有选中时上下键的起点。
// ─────────────────────────────────────────────────────────────────────────

test('0042/没有结果时选中恒为 -1，往下往上都一样', () => {
  assert.strictEqual(S.moveSelection(-1, 0, 1), -1);
  assert.strictEqual(S.moveSelection(-1, 0, -1), -1);
  assert.strictEqual(S.moveSelection(3, 0, 1), -1);
});

test('0042/没有选中时下键从第一条开始', () => {
  assert.strictEqual(S.moveSelection(-1, 5, 1), 0);
});

test('0042/没有选中时上键从最后一条开始', () => {
  assert.strictEqual(S.moveSelection(-1, 5, -1), 4);
});

test('0042/下键在末行环绕到首行', () => {
  assert.strictEqual(S.moveSelection(4, 5, 1), 0);
});

test('0042/上键在首行环绕到末行', () => {
  assert.strictEqual(S.moveSelection(0, 5, -1), 4);
});

test('0042/越界选中按“没有选中”处理，方向决定起点', () => {
  assert.strictEqual(S.moveSelection(99, 5, 1), 0);
  assert.strictEqual(S.moveSelection(99, 5, -1), 4);
  assert.strictEqual(S.moveSelection(-9, 5, 1), 0);
  assert.strictEqual(S.moveSelection(-9, 5, -1), 4);
});

test('0042/delta=0 且已有选中时停在原处', () => {
  assert.strictEqual(S.moveSelection(2, 5, 0), 2);
});

test('0042/大步长先取模，仍落在有效下标内', () => {
  assert.strictEqual(S.moveSelection(1, 5, 7), 3);
  assert.strictEqual(S.moveSelection(1, 5, -7), 4);
  assert.strictEqual(S.moveSelection(0, 3, 6), 0);
});

test('0042/负数条数当成 0，不造出负下标', () => {
  assert.strictEqual(S.moveSelection(0, -3, 1), -1);
  assert.strictEqual(S.moveSelection(-1, -3, -1), -1);
});

test('0042/小数条数向下取整', () => {
  assert.strictEqual(S.moveSelection(0, 2.9, 1), 1);
  assert.strictEqual(S.moveSelection(1, 2.9, 1), 0);
});

test('0042/中文结果与英文结果走同一套移动规则', () => {
  const names = ['文档', '笔记', 'readme'];
  assert.strictEqual(S.moveSelection(-1, names.length, 1), 0);
  assert.strictEqual(S.moveSelection(2, names.length, 1), 0);
  assert.strictEqual(S.moveSelection(0, names.length, -1), 2);
});
