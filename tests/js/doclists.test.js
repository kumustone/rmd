// `design/0041` §7 的 JS 纯逻辑判据之三：**过滤（R1/R4）＋ 提交判据（R3）＋ 提示（INV-DOCS-04）**。
//
// ⚠️ 这一份测的是 `src/services/doclists.js`（纯函数，⛔ 不碰 DOM / Tauri / 定时器）。
//    分片生命周期那一格（评审给的"500 行残留"反例）在 `doclist.test.js`。
//
// ⭐ 为什么每条判据都要**正反例**：这三组都是"两种状态下输出一模一样"的那类错法——
//    过滤多藏一个目录、旧回包多落一次、提示少说一句，屏幕上都不会报错，
//    只有对照才发现（`INV-DOCS-02/04/09`）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const DL = require('../../src/services/doclists.js');

/** 造一个目录项。 */
function dir(name, path, over) {
  return Object.assign({ name: name, path: path, is_dir: true, ignored: false }, over || {});
}
function file(name, path) {
  return { name: name, path: path, is_dir: false, ignored: false };
}

// ── R1：一层里哪些该画 ─────────────────────────────────────────────────────

test('过滤：判据还没就绪（keepDirs 为 null）⇒ 一个都不藏', function () {
  const entries = [dir('a', '/r/a'), dir('b', '/r/b'), file('x.md', '/r/x.md')];
  const out = DL.visibleEntries(entries, null, new Set(), true);
  assert.deepStrictEqual(out.map(function (e) { return e.path; }), ['/r/a', '/r/b', '/r/x.md']);
});

test('过滤：开关关着（hideEmpty=false）⇒ 与今天逐字一致，一个都不藏', function () {
  const entries = [dir('a', '/r/a'), dir('b', '/r/b')];
  const out = DL.visibleEntries(entries, new Set(['/r/a']), new Set(), false);
  assert.deepStrictEqual(out.map(function (e) { return e.path; }), ['/r/a', '/r/b']);
});

test('过滤：确认无 md 的目录被藏掉，而文件永远画', function () {
  const entries = [dir('a', '/r/a'), dir('b', '/r/b'), file('x.md', '/r/x.md')];
  const out = DL.visibleEntries(entries, new Set(['/r/a']), new Set(), true);
  assert.deepStrictEqual(out.map(function (e) { return e.path; }), ['/r/a', '/r/x.md']);
});

test('过滤：⭐ 过滤清单里的目录（ignored）即便不在判据集合里也**必须可见**', function () {
  // `INV-DOCS-02`：灰显但可见是 `design/0003` 的既有取舍，⛔ 不许被"空目录"判据顺手藏掉。
  const entries = [dir('node_modules', '/r/node_modules', { ignored: true })];
  const out = DL.visibleEntries(entries, new Set(), new Set(), true);
  assert.deepStrictEqual(out.map(function (e) { return e.path; }), ['/r/node_modules']);
});

test('过滤：⭐ 本次会话**新建**的空目录可见（R4 的临时例外）', function () {
  const entries = [dir('new', '/r/new'), dir('old-empty', '/r/old-empty')];
  const out = DL.visibleEntries(entries, new Set(), new Set(['/r/new']), true);
  assert.deepStrictEqual(out.map(function (e) { return e.path; }), ['/r/new']);
});

test('过滤：⭐ 未走完的子树（未知）在判据集合里 ⇒ 可见（`INV-DOCS-08`）', function () {
  // 后端 `keep_dirs` 已经把"没走完的那些目录"包含进去了；前端⛔ 不造第二个判据。
  const entries = [dir('denied', '/r/denied')];
  const out = DL.visibleEntries(entries, new Set(['/r/denied']), new Set(), true);
  assert.deepStrictEqual(out.map(function (e) { return e.path; }), ['/r/denied']);
});

test('过滤：不改入参、不返回同一个数组（共享索引不许被就地改）', function () {
  const entries = [dir('a', '/r/a'), dir('b', '/r/b')];
  const snapshot = entries.slice();
  const out = DL.visibleEntries(entries, new Set(['/r/a']), new Set(), true);
  assert.notStrictEqual(out, entries);
  assert.deepStrictEqual(entries, snapshot, '入参被就地改了 —— `INV-DOCS-01` 的共享索引会跟着变');
});

test('过滤：空输入 / undefined 都不抛', function () {
  assert.deepStrictEqual(DL.visibleEntries(undefined, null, null, true), []);
  assert.deepStrictEqual(DL.visibleEntries([], new Set(), new Set(), true), []);
});

// ── R3：回包能不能落到屏上 ─────────────────────────────────────────────────

test('提交判据：三条同时成立才为真', function () {
  const ok = DL.shouldApply(
    { gen: 3, req: 7, index_rev: 11 },
    { generation: 3, seq: 7, appliedRev: 11 }
  );
  assert.strictEqual(ok, true);
});

test('提交判据：授权代次不同 ⇒ 丢（切根后的旧回包）', function () {
  const ok = DL.shouldApply(
    { gen: 2, req: 7, index_rev: 11 },
    { generation: 3, seq: 7, appliedRev: 0 }
  );
  assert.strictEqual(ok, false);
});

test('提交判据：请求号不同 ⇒ 丢（同根刷新后的旧回包）', function () {
  const ok = DL.shouldApply(
    { gen: 3, req: 6, index_rev: 11 },
    { generation: 3, seq: 7, appliedRev: 0 }
  );
  assert.strictEqual(ok, false);
});

test('提交判据：发布版本倒退 ⇒ 丢（同代次里晚完成的旧构建，R2）', function () {
  const ok = DL.shouldApply(
    { gen: 3, req: 7, index_rev: 10 },
    { generation: 3, seq: 7, appliedRev: 11 }
  );
  assert.strictEqual(ok, false);
});

test('提交判据：版本**相等** ⇒ 收（同一份索引被两个请求各回一次，⛔ 不是倒退）', function () {
  const ok = DL.shouldApply(
    { gen: 3, req: 7, index_rev: 11 },
    { generation: 3, seq: 7, appliedRev: 11 }
  );
  assert.strictEqual(ok, true);
});

test('提交判据：缺字段一律判假（⛔ 不因为 `undefined >= n` 是 false 就"恰好"对）', function () {
  assert.strictEqual(DL.shouldApply(null, { generation: 1, seq: 1, appliedRev: 0 }), false);
  assert.strictEqual(DL.shouldApply({ gen: 1, req: 1, index_rev: 0 }, null), false);
});

// ── 组合令牌（注入给 `chunked.js` 的 `currentGen`）────────────────────────

test('令牌：每次 request / bump 都让 key 前进（旧分片在下一片开头就停下）', function () {
  const tok = DL.createToken();
  const k0 = tok.key();
  assert.ok(tok.request().key > k0, 'request 没推进 key');
  const k1 = tok.key();
  assert.ok(tok.bump() > k1, 'bump 没推进 key');
  assert.strictEqual(tok.current(), tok.key());
});

test('令牌：销毁之后 current() 恒为 -1（⛔ 不会再误判"还是我"）', function () {
  const tok = DL.createToken();
  tok.destroy();
  assert.strictEqual(tok.alive(), false);
  const before = tok.current();
  tok.bump();
  assert.strictEqual(tok.current(), before);
  assert.strictEqual(tok.current(), -1);
});

test('令牌：key 单调不减（任何一个分支都不许回退）', function () {
  const tok = DL.createToken();
  let last = tok.key();
  const steps = [
    function () { tok.request(); },
    function () { tok.bump(); },
    function () { tok.request(); },
    function () { tok.bump(); },
  ];
  for (let i = 0; i < steps.length; i++) {
    steps[i]();
    assert.ok(tok.key() > last, '第 ' + i + ' 步之后 key 没有前进');
    last = tok.key();
  }
});

// ── 行文本（名字 / 扩展名 / 父目录）────────────────────────────────────────

test('父目录：`a.md` ⇒ `/`（root 直接下一层）', function () {
  assert.strictEqual(DL.parentLabel('a.md'), '/');
});

test('父目录：`notes/a.md` ⇒ `notes`；多级取前缀整段', function () {
  assert.strictEqual(DL.parentLabel('notes/a.md'), 'notes');
  assert.strictEqual(DL.parentLabel('a/b/c/d.md'), 'a/b/c');
});

test('父目录：空 / 非字符串都不抛', function () {
  assert.strictEqual(DL.parentLabel(''), '/');
  assert.strictEqual(DL.parentLabel(null), '/');
});

test('拆名：`.md` 大小写不敏感（与后端 `is_markdown` 同口径）', function () {
  assert.deepStrictEqual(DL.splitName('a.md'), { base: 'a', ext: '.md' });
  assert.deepStrictEqual(DL.splitName('A.MD'), { base: 'A', ext: '.MD' });
});

test('拆名：别的扩展名整串当名字（⛔ 不猜）', function () {
  assert.deepStrictEqual(DL.splitName('a.txt'), { base: 'a.txt', ext: '' });
});

test('拆名：点在最前 / 没有点 ⇒ 整串是名字（`.md` 这种文件名不拆成空主体）', function () {
  assert.deepStrictEqual(DL.splitName('.md'), { base: '.md', ext: '' });
  assert.deepStrictEqual(DL.splitName('README'), { base: 'README', ext: '' });
});

// ── 截断 / 收录不完整（`INV-DOCS-04`：⛔ 两件事不许合并成一句）─────────────

/** 造一个"完整、没截断"的回包。 */
function result(over) {
  return Object.assign({
    complete: true,
    incomplete: [],
    incomplete_truncated: false,
    entries: [],
    total: 0,
    truncated: false,
  }, over || {});
}

test('提示：完整且没截断 ⇒ 一句话都不说', function () {
  assert.deepStrictEqual(DL.notices(result(), 0, ''), []);
});

test('提示：收录不完整 ⇒ 一条，条数来自响应', function () {
  const out = DL.notices(result({ complete: false, incomplete: [{ path: '/r/a', reason: 'denied' }] }), 1, '');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].key, 'doclist.incomplete');
  assert.deepStrictEqual(out[0].params, { n: 1 });
});

test('提示：未完整清单本身也被展示上限截断 ⇒ 换一句话说（⛔ 不说"就 3 处"）', function () {
  const out = DL.notices(result({ complete: false, incomplete_truncated: true, incomplete: [{}, {}, {}] }), 1, '');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].key, 'doclist.incomplete-more');
});

test('提示：后端按条数截断 ⇒ 一条，且带响应里的 total（⛔ 不抄常量）', function () {
  const out = DL.notices(result({ truncated: true, total: 12345 }), 5000, '⌘P');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].key, 'doclist.truncated');
  assert.deepStrictEqual(out[0].params, { shown: 5000, total: 12345, key: '⌘P' });
});

test('提示：前端展示上限先到 ⇒ 同样说"没画完"（`entries.length > MAX_RENDER`）', function () {
  const entries = [];
  for (let i = 0; i < DL.MAX_RENDER + 1; i++) entries.push({ name: 'a' + i + '.md', rel: 'a' + i + '.md' });
  const out = DL.notices(result({ entries: entries, total: entries.length }), DL.MAX_RENDER, '');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].key, 'doclist.truncated-nokey', '拿不到键位字形时⛔ 不许硬写按键');
});

test('提示：⭐ 两种"不全"同时成立 ⇒ **两条都在**（⛔ 不许合并成一句）', function () {
  const out = DL.notices(result({
    complete: false,
    incomplete: [{ path: '/r/a', reason: 'denied' }],
    truncated: true,
    total: 9000,
  }), 5000, '⌘P');
  assert.deepStrictEqual(out.map(function (o) { return o.key; }),
    ['doclist.incomplete', 'doclist.truncated']);
});

test('提示：条数上限按 `MAX_RENDER` 夹取（负数 / 非数字 / 超限）', function () {
  assert.strictEqual(DL.renderedCount(-5), 0);
  assert.strictEqual(DL.renderedCount('x'), 0);
  assert.strictEqual(DL.renderedCount(3.9), 3);
  assert.strictEqual(DL.renderedCount(DL.MAX_RENDER + 1), DL.MAX_RENDER);
  assert.strictEqual(DL.renderedCount(DL.MAX_RENDER), DL.MAX_RENDER);
});
