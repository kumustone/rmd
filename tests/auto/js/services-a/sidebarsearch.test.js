// 侧边栏常驻文件名搜索的纯逻辑（`src/services/sidebarsearch.js`）补充用例。
//
// 三分支错一个的代价都是静默的：每次都重建 ⇒ 每个键等一次全树遍历；
// 从不重建 ⇒ 新文件永远搜不到，而界面只多一行“索引年龄”。
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
const SS = win.rmd.sidebarsearch;

// ─────────────────────────────────────────────────────────────────────────
// planQuery：一次输入之后该做什么
// ─────────────────────────────────────────────────────────────────────────

test('planQuery：从“没在搜”进入“在搜”时强制重建索引', () => {
  assert.deepStrictEqual(SS.planQuery(false, 'a'), { kind: 'query', rebuild: true });
});

test('planQuery：已经在搜时只查不重建', () => {
  assert.deepStrictEqual(SS.planQuery(true, 'a'), { kind: 'query', rebuild: false });
});

test('planQuery：空 / 纯空白 / 非字符串 ⇒ 收起结果，不发 IPC', () => {
  assert.deepStrictEqual(SS.planQuery(false, ''), { kind: 'clear' });
  assert.deepStrictEqual(SS.planQuery(true, '   '), { kind: 'clear' });
  assert.deepStrictEqual(SS.planQuery(true, null), { kind: 'clear' });
  assert.deepStrictEqual(SS.planQuery(true, 7), { kind: 'clear' });
});

test('planQuery：active 只看真假，非真布尔也按实际值算', () => {
  assert.deepStrictEqual(SS.planQuery(1, 'x'), { kind: 'query', rebuild: false });
  assert.deepStrictEqual(SS.planQuery(0, 'x'), { kind: 'query', rebuild: true });
});

// ─────────────────────────────────────────────────────────────────────────
// moveSelection：选中项移动
// ─────────────────────────────────────────────────────────────────────────

test('moveSelection：没有结果时恒为 -1', () => {
  assert.strictEqual(SS.moveSelection(0, 0, 1), -1);
  assert.strictEqual(SS.moveSelection(-1, 0, -1), -1);
  assert.strictEqual(SS.moveSelection(5, -3, 1), -1);
});

test('moveSelection：没有选中时，向下从第一条、向上从最后一条', () => {
  assert.strictEqual(SS.moveSelection(-1, 5, 1), 0);
  assert.strictEqual(SS.moveSelection(-1, 5, -1), 4);
});

test('moveSelection：两端环绕', () => {
  assert.strictEqual(SS.moveSelection(4, 5, 1), 0);
  assert.strictEqual(SS.moveSelection(0, 5, -1), 4);
  assert.strictEqual(SS.moveSelection(2, 5, 1), 3);
  assert.strictEqual(SS.moveSelection(2, 5, -1), 1);
});

test('moveSelection：越界 / 非法的当前下标按“没有选中”处理', () => {
  assert.strictEqual(SS.moveSelection(5, 5, 1), 0);
  assert.strictEqual(SS.moveSelection(99, 5, -1), 4);
  assert.strictEqual(SS.moveSelection(NaN, 5, 1), 0);
});

test('moveSelection：delta 是模数，跨多圈仍落在范围内', () => {
  assert.strictEqual(SS.moveSelection(1, 5, 5), 1);
  assert.strictEqual(SS.moveSelection(1, 5, -6), 0);
  assert.strictEqual(SS.moveSelection(3, 7, 14), 3);
  assert.strictEqual(SS.moveSelection(3, 7, 15), 4);
});

test('moveSelection：只有一条时上下都回到它自己', () => {
  assert.strictEqual(SS.moveSelection(0, 1, 1), 0);
  assert.strictEqual(SS.moveSelection(0, 1, -1), 0);
  assert.strictEqual(SS.moveSelection(-1, 1, 1), 0);
  assert.strictEqual(SS.moveSelection(-1, 1, -1), 0);
});

test('moveSelection：条数先向下取整，小数不会造出非整数下标', () => {
  assert.strictEqual(SS.moveSelection(2, 3.9, 1), 0);
  assert.strictEqual(SS.moveSelection(-1, 3.9, -1), 2);
});
