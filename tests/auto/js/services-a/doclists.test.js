// 文档列表纯逻辑（`src/services/doclists.js`）的补充用例。
//
// 三件事都不能静默：空目录过滤（把有 md 的目录藏掉 = 用户找不到文件）、
// 组合令牌（切走后旧分片继续追加 = 静默的错误内容）、
// “收录不完整”与“显示截断”两句话各说各的。
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
loadInto(win, 'src/services/doclists.js');
const D = win.rmd.doclists;

// ─────────────────────────────────────────────────────────────────────────
// visibleEntries：哪一层该画
// ─────────────────────────────────────────────────────────────────────────

test('visibleEntries：开关关着时一个都不藏，且返回新数组', () => {
  const all = [{ name: 'd', path: '/r/d', is_dir: true }];
  const out = D.visibleEntries(all, new Set(), null, false);
  assert.deepStrictEqual(out, all);
  assert.notStrictEqual(out, all, '返回了入参同一数组，调用方一改就污染共享索引');
});

test('visibleEntries：判据还没到（keepDirs=null）时一个都不藏', () => {
  const all = [
    { name: 'd', path: '/r/d', is_dir: true },
    { name: 'a.md', path: '/r/a.md', is_dir: false },
  ];
  assert.deepStrictEqual(D.visibleEntries(all, null, null, true), all);
});

test('visibleEntries：文件永远画，哪怕不在判据集合里', () => {
  const all = [{ name: 'a.md', path: '/r/a.md', is_dir: false }];
  assert.deepStrictEqual(D.visibleEntries(all, new Set(), null, true), all);
});

test('visibleEntries：忽略目录（node_modules）灰显但可见，⛔ 不被空目录判据藏掉', () => {
  const all = [{ name: 'node_modules', path: '/r/node_modules', is_dir: true, ignored: true }];
  assert.deepStrictEqual(D.visibleEntries(all, new Set(), null, true), all);
});

test('visibleEntries：确认无 md 的目录藏掉，在判据集合里的目录可见', () => {
  const all = [
    { name: 'has', path: '/r/has', is_dir: true },
    { name: 'empty', path: '/r/empty', is_dir: true },
  ];
  const out = D.visibleEntries(all, new Set(['/r/has']), null, true);
  assert.deepStrictEqual(out.map((e) => e.name), ['has']);
});

test('visibleEntries：本次会话新建的目录有临时例外', () => {
  const all = [{ name: 'new', path: '/r/new', is_dir: true }];
  assert.deepStrictEqual(
    D.visibleEntries(all, new Set(), new Set(['/r/new']), true).map((e) => e.name),
    ['new']
  );
});

test('visibleEntries：不改入参、空输入也不抛', () => {
  const all = [{ name: 'd', path: '/r/d', is_dir: true }];
  const snapshot = JSON.parse(JSON.stringify(all));
  D.visibleEntries(all, new Set(), null, true);
  assert.deepStrictEqual(all, snapshot);
  assert.deepStrictEqual(D.visibleEntries(null, new Set(), null, true), []);
  assert.deepStrictEqual(D.visibleEntries([], null, null, true), []);
});

// ─────────────────────────────────────────────────────────────────────────
// 行文案：父目录与拆名
// ─────────────────────────────────────────────────────────────────────────

test('parentLabel：root 直接下一层显示 /，多级取前缀整段', () => {
  assert.strictEqual(D.parentLabel('a.md'), '/');
  assert.strictEqual(D.parentLabel('/a.md'), '/');
  assert.strictEqual(D.parentLabel('notes/a.md'), 'notes');
  assert.strictEqual(D.parentLabel('a/b/c.md'), 'a/b');
  assert.strictEqual(D.parentLabel(''), '/');
  assert.strictEqual(D.parentLabel(null), '/');
});

test('splitName：.md 扩展名大小写不敏感，其他扩展名整串当名字', () => {
  assert.deepStrictEqual(D.splitName('a.md'), { base: 'a', ext: '.md' });
  assert.deepStrictEqual(D.splitName('A.MD'), { base: 'A', ext: '.MD' });
  assert.deepStrictEqual(D.splitName('a.b.md'), { base: 'a.b', ext: '.md' });
  assert.deepStrictEqual(D.splitName('a.txt'), { base: 'a.txt', ext: '' });
});

test('splitName：没有点 / 点在开头 / 空串都不拆', () => {
  assert.deepStrictEqual(D.splitName('readme'), { base: 'readme', ext: '' });
  assert.deepStrictEqual(D.splitName('.md'), { base: '.md', ext: '' });
  assert.deepStrictEqual(D.splitName(''), { base: '', ext: '' });
  assert.deepStrictEqual(D.splitName(null), { base: '', ext: '' });
  assert.deepStrictEqual(D.splitName('.hidden.md'), { base: '.hidden', ext: '.md' });
});

// ─────────────────────────────────────────────────────────────────────────
// createToken：组合令牌
// ─────────────────────────────────────────────────────────────────────────

test('createToken：初始状态与 current()', () => {
  const tk = D.createToken();
  assert.strictEqual(tk.alive(), true);
  assert.strictEqual(tk.epoch(), 0);
  assert.strictEqual(tk.seq(), 0);
  assert.strictEqual(tk.key(), 1);
  assert.strictEqual(tk.current(), 1);
});

test('createToken：request 让 seq 与 key 各前进一次，并返回快照', () => {
  const tk = D.createToken();
  assert.deepStrictEqual(tk.request(), { epoch: 0, seq: 1, key: 2 });
  assert.deepStrictEqual(tk.request(), { epoch: 0, seq: 2, key: 3 });
  assert.strictEqual(tk.current(), 3);
});

test('createToken：bump 只动 epoch 与 key，request 的快照跟着 epoch 走', () => {
  const tk = D.createToken();
  assert.strictEqual(tk.bump(), 2);
  assert.strictEqual(tk.epoch(), 1);
  assert.deepStrictEqual(tk.request(), { epoch: 1, seq: 1, key: 3 });
});

test('createToken：destroy 之后 current() 恒为 -1，⛔ 不再误判“还是我”', () => {
  const tk = D.createToken();
  tk.request();
  tk.destroy();
  assert.strictEqual(tk.alive(), false);
  assert.strictEqual(tk.current(), -1);
  // key 只前进不后退
  assert.ok(tk.key() > 1);
});

// ─────────────────────────────────────────────────────────────────────────
// shouldApply：回包能不能上屏
// ─────────────────────────────────────────────────────────────────────────

test('shouldApply：三条同时成立才收', () => {
  const cur = { generation: 2, seq: 5, appliedRev: 10 };
  assert.strictEqual(D.shouldApply({ gen: 2, req: 5, index_rev: 10 }, cur), true);
  assert.strictEqual(D.shouldApply({ gen: 2, req: 5, index_rev: 11 }, cur), true);
});

test('shouldApply：切根 / 同根刷新 / 版本倒退各自被挡', () => {
  const cur = { generation: 2, seq: 5, appliedRev: 10 };
  assert.strictEqual(D.shouldApply({ gen: 1, req: 5, index_rev: 10 }, cur), false);
  assert.strictEqual(D.shouldApply({ gen: 2, req: 4, index_rev: 10 }, cur), false);
  assert.strictEqual(D.shouldApply({ gen: 2, req: 5, index_rev: 9 }, cur), false);
});

test('shouldApply：缺任一对象一律判假，不抛', () => {
  assert.strictEqual(D.shouldApply(null, { generation: 1, seq: 1, appliedRev: 0 }), false);
  assert.strictEqual(D.shouldApply({ gen: 1, req: 1, index_rev: 0 }, null), false);
  assert.strictEqual(D.shouldApply(undefined, undefined), false);
});

test('renderedCount：夹在 0..MAX_RENDER，非数按 0', () => {
  assert.strictEqual(D.MAX_RENDER, 5000);
  assert.strictEqual(D.renderedCount(0), 0);
  assert.strictEqual(D.renderedCount(-3), 0);
  assert.strictEqual(D.renderedCount(5000), 5000);
  assert.strictEqual(D.renderedCount(5001), 5000);
  assert.strictEqual(D.renderedCount(NaN), 0);
  assert.strictEqual(D.renderedCount(3.9), 3);
  assert.strictEqual(D.renderedCount('3'), 3);
});

// ─────────────────────────────────────────────────────────────────────────
// notices：末尾说明行
// ─────────────────────────────────────────────────────────────────────────

test('notices：完整且没截断时一句话都不说', () => {
  assert.deepStrictEqual(D.notices(null), []);
  assert.deepStrictEqual(D.notices({ complete: true, entries: [], total: 0 }, 0), []);
});

test('notices：收录不完整与“不完整清单本身被截断”是两句话', () => {
  assert.deepStrictEqual(
    D.notices({ complete: false, incomplete: ['/a', '/b'], entries: [], total: 0 }, 0),
    [{ key: 'doclist.incomplete', params: { n: 2 } }]
  );
  assert.deepStrictEqual(
    D.notices({ complete: false, incomplete_truncated: true, incomplete: ['/a'], entries: [] }, 0),
    [{ key: 'doclist.incomplete-more', params: { n: 1 } }]
  );
});

test('notices：没有 incomplete 数组时条数按 0 说', () => {
  assert.deepStrictEqual(
    D.notices({ complete: false, entries: [] }, 0),
    [{ key: 'doclist.incomplete', params: { n: 0 } }]
  );
});

test('notices：截断说明带“实际画了多少 / 总数”，并带快捷键字形', () => {
  assert.deepStrictEqual(
    D.notices({ complete: true, entries: [], truncated: true, total: 9000 }, 5000, '⌘P'),
    [{ key: 'doclist.truncated', params: { shown: 5000, total: 9000, key: '⌘P' } }]
  );
  assert.deepStrictEqual(
    D.notices({ complete: true, entries: [], truncated: true, total: 9000 }, 5000),
    [{ key: 'doclist.truncated-nokey', params: { shown: 5000, total: 9000, key: '' } }]
  );
});

test('notices：前端展示上限先到时也要说“没画完”', () => {
  const entries = new Array(D.MAX_RENDER + 1).fill({});
  assert.deepStrictEqual(
    D.notices({ complete: true, entries, total: 6000 }, D.MAX_RENDER, '⌘P'),
    [{ key: 'doclist.truncated', params: { shown: D.MAX_RENDER, total: 6000, key: '⌘P' } }]
  );
});

test('notices：收录不完整与显示截断同时成立时两条都在，顺序固定', () => {
  const out = D.notices(
    { complete: false, incomplete: ['/a'], entries: [], truncated: true, total: 10 },
    5, '⌘P'
  );
  assert.deepStrictEqual(out, [
    { key: 'doclist.incomplete', params: { n: 1 } },
    { key: 'doclist.truncated', params: { shown: 5, total: 10, key: '⌘P' } },
  ]);
});
