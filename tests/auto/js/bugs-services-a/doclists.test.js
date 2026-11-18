// 文档列表面回归：`src/services/doclists.js` 的纯逻辑、组合令牌与截断说明。
//
// 从历史缺陷出发，守三族**静默**错误：
//   · `0019` 外部新增文件不出现 —— 空目录过滤把"有 md 的子目录"藏掉同样是"磁盘上有、界面没有"；
//   · `0064` 换文档后旧回包改状态 —— 切根 / 刷新 / 换形态时旧分片继续往容器里追加，
//     会留下一屏旧内容而看起来"就是有这么多文档"；
//   · `0041` 的截断与收录不完整被合并成一句话 —— 用户分不清"盘上就这么多"还是"没画完"。
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

const dir = (p, extra) => Object.assign({ name: p.split('/').pop(), path: p, is_dir: true, ignored: false }, extra);
const file = (p, extra) => Object.assign({ name: p.split('/').pop(), path: p, is_dir: false, ignored: false }, extra);

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
// 变体：列表里的“有 md / 确认无 md / 未知”三态；空目录、隐藏目录、中文路径。
// ─────────────────────────────────────────────────────────────────────────

test('0019/开关关着时一个都不藏，且返回新数组而不是入参本身', () => {
  const all = [dir('/r/d'), file('/r/a.md')];
  const out = D.visibleEntries(all, new Set(), null, false);
  assert.deepStrictEqual(out, all);
  assert.notStrictEqual(out, all, '返回入参同一数组会让调用方污染共享索引');
});

test('0019/判据还没到（keepDirs=null）时全画，不提前隐藏', () => {
  const all = [dir('/r/d'), file('/r/a.md')];
  assert.deepStrictEqual(D.visibleEntries(all, null, null, true), all);
});

test('0019/文件永远画：判据只回答“这个目录里有没有 md”', () => {
  const all = [file('/r/a.md'), file('/r/.hidden.md')];
  assert.deepStrictEqual(D.visibleEntries(all, new Set(), null, true), all);
});

test('0019/忽略目录灰显但可见（用户要看得见“这里有一个不扫的目录”）', () => {
  const all = [dir('/r/node_modules', { ignored: true }), dir('/r/empty')];
  assert.deepStrictEqual(D.visibleEntries(all, new Set(), null, true), all.slice(0, 1));
});

test('0019/确认有 md 的目录画出来，即使它自己这一层为空', () => {
  const all = [dir('/r/notes'), dir('/r/empty')];
  const out = D.visibleEntries(all, new Set(['/r/notes']), null, true);
  assert.deepStrictEqual(out.map((e) => e.path), ['/r/notes']);
});

test('0019/本次会话新建的目录临时例外，即使清单还没收录它', () => {
  const all = [dir('/r/newdir')];
  const out = D.visibleEntries(all, new Set(), new Set(['/r/newdir']), true);
  assert.deepStrictEqual(out.map((e) => e.path), ['/r/newdir']);
});

test('0019/中文目录名与中文根路径按原串判在不在集合里', () => {
  const all = [dir('/资料/笔记'), dir('/资料/空目录')];
  const out = D.visibleEntries(all, new Set(['/资料/笔记']), null, true);
  assert.deepStrictEqual(out.map((e) => e.name), ['笔记']);
});

test('0019/不同根下的同名目录各自判定，不按名字合并', () => {
  const all = [dir('/a/同名'), dir('/b/同名')];
  const out = D.visibleEntries(all, new Set(['/b/同名']), null, true);
  assert.deepStrictEqual(out.map((e) => e.path), ['/b/同名']);
});

test('0019/entries 不是数组时返回空数组，不抛', () => {
  assert.deepStrictEqual(D.visibleEntries(null, new Set(), null, true), []);
  assert.deepStrictEqual(D.visibleEntries(undefined, null, null, true), []);
});

test('0019/过滤不修改入参与共享集合', () => {
  const all = [dir('/r/a'), dir('/r/b')];
  const keep = new Set(['/r/a']);
  const copy = all.slice();
  D.visibleEntries(all, keep, null, true);
  assert.deepStrictEqual(all, copy);
  assert.deepStrictEqual(Array.from(keep), ['/r/a']);
});

test('0019/recentCreated 是 null 时仍按 keepDirs 判，不把新建逻辑当兜底', () => {
  const all = [dir('/r/a'), dir('/r/b')];
  const out = D.visibleEntries(all, new Set(['/r/a']), null, true);
  assert.deepStrictEqual(out.map((e) => e.path), ['/r/a']);
});

// ─────────────────────────────────────────────────────────────────────────
// 行渲染：父目录标签与名字拆段（中文 / 同名 / 隐藏文件 / 大小写）
// ─────────────────────────────────────────────────────────────────────────

test('parentLabel：根下直接一层显示 /', () => {
  assert.strictEqual(D.parentLabel('a.md'), '/');
  assert.strictEqual(D.parentLabel(''), '/');
  assert.strictEqual(D.parentLabel(null), '/');
});

test('parentLabel：嵌套路径显示父目录相对路径', () => {
  assert.strictEqual(D.parentLabel('notes/a.md'), 'notes');
  assert.strictEqual(D.parentLabel('notes/deep/a.md'), 'notes/deep');
  assert.strictEqual(D.parentLabel('资料/笔记/文档.md'), '资料/笔记');
});

test('parentLabel：尾随斜杠不产生空标签', () => {
  assert.strictEqual(D.parentLabel('notes/'), 'notes');
  assert.strictEqual(D.parentLabel('/a'), '/');
});

test('splitName：普通 .md 拆成主体与扩展名两段', () => {
  assert.deepStrictEqual(D.splitName('readme.md'), { base: 'readme', ext: '.md' });
  assert.deepStrictEqual(D.splitName('文档.md'), { base: '文档', ext: '.md' });
});

test('splitName：扩展名判定大小写不敏感，但显示保留原大小写', () => {
  assert.deepStrictEqual(D.splitName('README.MD'), { base: 'README', ext: '.MD' });
  assert.deepStrictEqual(D.splitName('A.Md'), { base: 'A', ext: '.Md' });
});

test('splitName：多个点按最后一个点切', () => {
  assert.deepStrictEqual(D.splitName('a.b.md'), { base: 'a.b', ext: '.md' });
  assert.deepStrictEqual(D.splitName('v1.2.3.md'), { base: 'v1.2.3', ext: '.md' });
});

test('splitName：隐藏文件 .md 整串当名字，⛔ 不把点当扩展名分隔', () => {
  assert.deepStrictEqual(D.splitName('.md'), { base: '.md', ext: '' });
  assert.deepStrictEqual(D.splitName('.hidden.md'), { base: '.hidden', ext: '.md' });
});

test('splitName：不是 .md 的扩展名整串当名字，不猜别的类型', () => {
  assert.deepStrictEqual(D.splitName('a.txt'), { base: 'a.txt', ext: '' });
  assert.deepStrictEqual(D.splitName('a.markdown'), { base: 'a.markdown', ext: '' });
  assert.deepStrictEqual(D.splitName('没有扩展名'), { base: '没有扩展名', ext: '' });
});

test('splitName：空串 / null / 名字以点开头都安全', () => {
  assert.deepStrictEqual(D.splitName(''), { base: '', ext: '' });
  assert.deepStrictEqual(D.splitName(null), { base: '', ext: '' });
  assert.deepStrictEqual(D.splitName('.gitignore'), { base: '.gitignore', ext: '' });
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0064（换文档后旧回包把状态改回去）
// 变体：组合令牌让在途分片整体作废，旧代次 / 旧请求 / 倒退索引都不落地。
// ─────────────────────────────────────────────────────────────────────────

test('0064/令牌初值：活着、代次 0、请求 0、key 1', () => {
  const t = D.createToken();
  assert.strictEqual(t.alive(), true);
  assert.strictEqual(t.epoch(), 0);
  assert.strictEqual(t.seq(), 0);
  assert.strictEqual(t.key(), 1);
  assert.strictEqual(t.current(), 1);
});

test('0064/每次发请求都让 key 前进，旧分片在下一个分片开头停住', () => {
  const t = D.createToken();
  const first = t.request();
  assert.deepStrictEqual(first, { epoch: 0, seq: 1, key: 2 });
  const second = t.request();
  assert.deepStrictEqual(second, { epoch: 0, seq: 2, key: 3 });
  assert.ok(second.key > first.key);
});

test('0064/刷新 / 换形态让 epoch 与 key 同时前进', () => {
  const t = D.createToken();
  t.request();
  const k = t.bump();
  assert.strictEqual(k, 3);
  assert.strictEqual(t.epoch(), 1);
  assert.strictEqual(t.current(), 3);
});

test('0064/卸载后 current 恒为 -1，迟到的分片不会误判“还是我”', () => {
  const t = D.createToken();
  t.request();
  t.destroy();
  assert.strictEqual(t.alive(), false);
  assert.strictEqual(t.current(), -1);
  t.request();
  assert.strictEqual(t.current(), -1, '卸载后再发请求也不许复活');
  t.bump();
  assert.strictEqual(t.current(), -1);
});

test('0064/shouldApply：代次不符丢弃（切根后的旧回包）', () => {
  assert.strictEqual(D.shouldApply(
    { gen: 1, req: 2, index_rev: 5 },
    { generation: 2, seq: 2, appliedRev: 0 }
  ), false);
});

test('0064/shouldApply：请求号不符丢弃（同根刷新后的旧回包）', () => {
  assert.strictEqual(D.shouldApply(
    { gen: 2, req: 1, index_rev: 5 },
    { generation: 2, seq: 2, appliedRev: 0 }
  ), false);
});

test('0064/shouldApply：相同索引可以回两次（新鲜缓存的票号不变）', () => {
  assert.strictEqual(D.shouldApply(
    { gen: 2, req: 2, index_rev: 5 },
    { generation: 2, seq: 2, appliedRev: 5 }
  ), true);
});

test('0064/shouldApply：index_rev 倒退不许覆盖新索引', () => {
  assert.strictEqual(D.shouldApply(
    { gen: 2, req: 2, index_rev: 4 },
    { generation: 2, seq: 2, appliedRev: 5 }
  ), false);
  assert.strictEqual(D.shouldApply(
    { gen: 2, req: 2, index_rev: 6 },
    { generation: 2, seq: 2, appliedRev: 5 }
  ), true);
});

test('0064/shouldApply：缺任一侧都返回 false，不抛', () => {
  assert.strictEqual(D.shouldApply(null, { generation: 1, seq: 1, appliedRev: 0 }), false);
  assert.strictEqual(D.shouldApply({ gen: 1, req: 1, index_rev: 1 }, null), false);
  assert.strictEqual(D.shouldApply(undefined, undefined), false);
});

// ─────────────────────────────────────────────────────────────────────────
// 截断与“收录不完整”：两件事分开说
// ─────────────────────────────────────────────────────────────────────────

test('MAX_RENDER 与去抖常量就是设计拍板的数', () => {
  assert.strictEqual(D.MAX_RENDER, 5000);
  assert.strictEqual(D.STALE_REBUILD_MS, 500);
});

test('renderedCount：夹在 0..MAX_RENDER 之间，非数当 0', () => {
  assert.strictEqual(D.renderedCount(0), 0);
  assert.strictEqual(D.renderedCount(-10), 0);
  assert.strictEqual(D.renderedCount(42), 42);
  assert.strictEqual(D.renderedCount(4999), 4999);
  assert.strictEqual(D.renderedCount(5000), 5000);
  assert.strictEqual(D.renderedCount(5001), 5000);
  assert.strictEqual(D.renderedCount('7'), 7);
  assert.strictEqual(D.renderedCount(NaN), 0);
  assert.strictEqual(D.renderedCount(undefined), 0);
});

test('notices：没有回包时什么都不说', () => {
  assert.deepStrictEqual(D.notices(null, 0), []);
});

test('notices：收录不完整说一条，带缺口条数', () => {
  assert.deepStrictEqual(
    D.notices({ complete: false, incomplete: ['/a', '/b'] }, 10),
    [{ key: 'doclist.incomplete', params: { n: 2 } }]
  );
});

test('notices：收录不完整且被截断时说“还有更多”，与普通不完整分开', () => {
  assert.deepStrictEqual(
    D.notices({ complete: false, incomplete_truncated: true, incomplete: ['/a'] }, 10),
    [{ key: 'doclist.incomplete-more', params: { n: 1 } }]
  );
});

test('notices：complete 缺省或非 false 时不说“不完整”', () => {
  assert.deepStrictEqual(D.notices({ entries: [], total: 0 }, 0), []);
  assert.deepStrictEqual(D.notices({ complete: true, entries: [], total: 0 }, 0), []);
});

test('notices：后端截断与前端上限截断各产生同一条“没画完”', () => {
  const a = D.notices({ truncated: true, entries: [], total: 9000 }, 5000);
  assert.deepStrictEqual(a, [{ key: 'doclist.truncated-nokey', params: { shown: 5000, total: 9000, key: '' } }]);
  const many = {
    truncated: false,
    entries: new Array(D.MAX_RENDER + 1),
    total: D.MAX_RENDER + 1,
  };
  assert.deepStrictEqual(D.notices(many, D.MAX_RENDER), [
    { key: 'doclist.truncated-nokey', params: { shown: D.MAX_RENDER, total: D.MAX_RENDER + 1, key: '' } },
  ]);
});

test('notices：有快捷键显示字形时用带键位的那条文案', () => {
  assert.deepStrictEqual(
    D.notices({ truncated: true, entries: [], total: 7 }, 5, '⌘P'),
    [{ key: 'doclist.truncated', params: { shown: 5, total: 7, key: '⌘P' } }]
  );
});

test('notices：两条都成立时顺序固定为“收录不完整”在前', () => {
  const out = D.notices({
    complete: false, incomplete: ['/a'],
    truncated: true, entries: [], total: 6000,
  }, 5000, '⌘P');
  assert.deepStrictEqual(out.map((n) => n.key), ['doclist.incomplete', 'doclist.truncated']);
});

test('notices：恰好 5000 行不算截断，5001 才算', () => {
  const five = { entries: new Array(5000), total: 5000 };
  const over = { entries: new Array(5001), total: 5001 };
  assert.deepStrictEqual(D.notices(five, 5000), []);
  assert.strictEqual(D.notices(over, 5000).length, 1);
});

test('notices：total 缺失或非数时按 0 报，不印 NaN', () => {
  const out = D.notices({ truncated: true, entries: [] }, 0);
  assert.strictEqual(out[0].params.total, 0);
});
