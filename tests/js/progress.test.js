// `design/0017` §7.3 的 22 条：阅读进度的**纯逻辑** ＋ 两条源码级闸门。
//
// ⚠️ 这些断言的错法**全是静默的**：
//    `same()` 写成 `<=` ⇒ 每次滚 8 px 都要写一次盘（配置反复重写）；
//    `planSave` 漏掉 `persisted:false` 那条 ⇒ 一次写盘失败之后**进度永远不再更新**；
//    `restorePlan` 少了 `'defer'` ⇒ 大图文档**永远回到顶部**（而且没有报错）；
//    `shouldCorrect` 少了挂载代号 ⇒ 换文档后旧图片回调把新正文**抢回旧位置**。
// ⇒ 逐条钉边界，⛔ 不靠"看起来对"。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../../src/services/progress.js');

const ROOT = path.join(__dirname, '..', '..');

// ── #1–#4 toEntry ────────────────────────────────────────────────────

test('#1 toEntry：空锚点 / 既无 id 又无 ratio ⇒ null', function () {
  assert.strictEqual(P.toEntry(null, 100), null);
  assert.strictEqual(P.toEntry({ id: null, ratio: null }, 100), null);
  assert.strictEqual(P.toEntry({ id: null, offset: 12, ratio: null }, 100), null);
});

test('#2 toEntry：offset 保留 1 位、ratio 保留 6 位', function () {
  const e = P.toEntry({ id: 'h1', offset: 12.34, ratio: 0.123456789 }, 42);
  assert.strictEqual(e.offset, 12.3);
  assert.strictEqual(e.ratio, 0.123457);
  assert.strictEqual(e.source_bytes, 42);
});

test('#3 toEntry：比与 offset 的夹取', function () {
  assert.strictEqual(P.toEntry({ id: null, ratio: 1.5 }, 0).ratio, 1);
  assert.strictEqual(P.toEntry({ id: null, ratio: -1 }, 0).ratio, 0);
  assert.strictEqual(P.toEntry({ id: 'h', offset: -3 }, 0).offset, 0);
});

test('#4 toEntry：空串 id ⇒ null；⭐ 300 字符 id 整个丢弃但 ratio 保留', function () {
  const noId = P.toEntry({ id: '', ratio: 0.5 }, 0);
  assert.strictEqual(noId.id, null);
  assert.strictEqual(noId.ratio, 0.5);
  const long = P.toEntry({ id: 'x'.repeat(300), ratio: 0.5 }, 0);
  assert.strictEqual(long.id, null, '⛔ 不截成前缀：前缀可能撞上另一个标题');
  assert.strictEqual(long.ratio, 0.5);
  // 刚好 256 字符仍收下（边界在"多于 256"）
  assert.strictEqual(P.toEntry({ id: 'x'.repeat(256), ratio: null }, 0).id.length, 256);
});

// ── #5–#8 toAnchor / same ────────────────────────────────────────────

test('#5 toAnchor(toEntry(a)) 在 epsilon 内一致', function () {
  const a = { id: 'h-9', offset: 123.4, ratio: 0.25 };
  const back = P.toAnchor(P.toEntry(a, 1000));
  assert.strictEqual(back.id, 'h-9');
  assert.ok(Math.abs(back.offset - a.offset) < 0.1);
  assert.ok(Math.abs(back.ratio - a.ratio) < 1e-6);
  assert.strictEqual(P.toAnchor(null), null);
});

test('#6 same：offset 差 7.9 ⇒ true；8.0 ⇒ false', function () {
  const base = { id: 'h', offset: 100, ratio: null };
  assert.strictEqual(P.same(base, { id: 'h', offset: 107.9, ratio: null }), true);
  assert.strictEqual(P.same(base, { id: 'h', offset: 108, ratio: null }), false);
});

test('#7 same：ratio 差 0.0049 ⇒ true；0.005 ⇒ false', function () {
  const base = { id: 'h', offset: 0, ratio: 0.5 };
  assert.strictEqual(P.same(base, { id: 'h', offset: 0, ratio: 0.5049 }), true);
  assert.strictEqual(P.same(base, { id: 'h', offset: 0, ratio: 0.505 }), false);
});

test('#8 same：id 不同 ⇒ false；两侧 ratio 都 null ⇒ true', function () {
  assert.strictEqual(P.same({ id: 'a', offset: 0, ratio: null }, { id: 'b', offset: 0, ratio: null }), false);
  assert.strictEqual(P.same({ id: null, offset: 0, ratio: null }, { id: null, offset: 0, ratio: null }), true);
  // 一侧有 ratio、另一侧没有 ⇒ 不是同一个位置
  assert.strictEqual(P.same({ id: 'h', offset: 0, ratio: 0.5 }, { id: 'h', offset: 0, ratio: null }), false);
});

// ── #9–#15 planSave ─────────────────────────────────────────────────

const entry = { id: 'h', offset: 100, ratio: null };

test('#9 planSave(next=null) ⇒ skip', function () {
  assert.deepStrictEqual(P.planSave(null, null, 0, false), { action: 'skip', waitMs: 0 });
  assert.deepStrictEqual(P.planSave({ entry: entry, at: 0, persisted: true }, null, 99999, true), {
    action: 'skip',
    waitMs: 0,
  });
});

test('#10 planSave(同值 ∧ persisted:true) ⇒ skip', function () {
  assert.deepStrictEqual(
    P.planSave({ entry: entry, at: 0, persisted: true }, entry, 99999, false),
    { action: 'skip', waitMs: 0 }
  );
});

test('#11 ⭐ persisted:false 的同值 + since=1999 ⇒ wait（允许重试）', function () {
  assert.deepStrictEqual(
    P.planSave({ entry: entry, at: 0, persisted: false }, entry, 1999, false),
    { action: 'wait', waitMs: 1 }
  );
});

test('#12 ⭐ persisted:false 的同值 + since=2000 ⇒ save（重试的时刻到了）', function () {
  assert.deepStrictEqual(
    P.planSave({ entry: entry, at: 0, persisted: false }, entry, 2000, false),
    { action: 'save', waitMs: 0 }
  );
});

test('#13 值变了 + since=1999 ⇒ wait 1', function () {
  const next = { id: 'h', offset: 300, ratio: null };
  assert.deepStrictEqual(
    P.planSave({ entry: entry, at: 0, persisted: true }, next, 1999, false),
    { action: 'wait', waitMs: 1 }
  );
});

test('#14 值变了 + since=2000 ⇒ save', function () {
  const next = { id: 'h', offset: 300, ratio: null };
  assert.deepStrictEqual(
    P.planSave({ entry: entry, at: 0, persisted: true }, next, 2000, false),
    { action: 'save', waitMs: 0 }
  );
});

test('#15 force ⇒ save（无视间隔与 persisted）', function () {
  assert.deepStrictEqual(
    P.planSave({ entry: entry, at: 0, persisted: true }, entry, 0, true),
    { action: 'save', waitMs: 0 }
  );
  assert.deepStrictEqual(P.planSave(null, entry, 0, true), { action: 'save', waitMs: 0 });
});

// ── #16–#17 restorePlan ─────────────────────────────────────────────

test('#16 restorePlan：不可用 ⇒ skip；可滚 ⇒ apply；⭐ 不可滚 ⇒ defer', function () {
  assert.strictEqual(P.restorePlan(null, true), 'skip');
  assert.strictEqual(P.restorePlan({ id: null, ratio: null }, true), 'skip');
  assert.strictEqual(P.restorePlan(entry, true), 'apply');
  assert.strictEqual(P.restorePlan(entry, false), 'defer');
});

test('#17 ⭐ defer 不是 skip：之后再可滚 ⇒ apply（意图没丢）', function () {
  assert.strictEqual(P.restorePlan(entry, false), 'defer');
  assert.strictEqual(P.restorePlan(entry, true), 'apply');
});

// ── #18–#19 mergeWrite ──────────────────────────────────────────────

test('#18 mergeWrite：覆盖旧值 + 按 evicted 删除 + 返回删除条数', function () {
  const table = { '/a.md': { id: 'old' }, '/b.md': { id: 'b' }, '/c.md': { id: 'c' } };
  const normalized = { id: 'new', offset: 1, ratio: null, source_bytes: 9, updated_at: 7 };
  const removed = P.mergeWrite(table, '/a.md', normalized, ['/b.md', '/gone.md']);
  assert.deepStrictEqual(table['/a.md'], normalized, '⭐ 后端的规范化条目才是真值');
  assert.strictEqual(table['/b.md'], undefined);
  assert.ok(table['/c.md'], '没点名的不许动');
  assert.strictEqual(removed, 1, '只数**真的删掉**的');
});

test('#19 mergeWrite 幂等：同一份并两次 ⇒ 等价于只并一次', function () {
  const t1 = {};
  const t2 = {};
  const e = { id: 'h', offset: 1, ratio: null };
  P.mergeWrite(t1, '/a.md', e, ['/x.md']);
  P.mergeWrite(t2, '/a.md', e, ['/x.md']);
  P.mergeWrite(t2, '/a.md', e, ['/x.md']);
  assert.deepStrictEqual(t2, t1);
  assert.strictEqual(P.mergeWrite(t2, '/a.md', e, ['/x.md']), 0, '第二次的删除数为 0');
});

// ── #20 shouldCorrect ───────────────────────────────────────────────

test('#20 shouldCorrect：六个条件全等 ⇒ true；任一条不满足 ⇒ false', function () {
  const base = { mountGen: 3, path: '/a.md', docSeq: 7, expires: 10000 };
  const now = 5000;
  assert.strictEqual(P.shouldCorrect(base, 3, '/a.md', 7, false, false, now), true);
  // ① 挂载代号不同（换文档之后旧图片回调到达）
  assert.strictEqual(P.shouldCorrect(base, 4, '/a.md', 7, false, false, now), false);
  // ② 路径变了
  assert.strictEqual(P.shouldCorrect(base, 3, '/b.md', 7, false, false, now), false);
  // ③ 会话号变了（同路径重开）
  assert.strictEqual(P.shouldCorrect(base, 3, '/a.md', 8, false, false, now), false);
  // ④ 编辑态
  assert.strictEqual(P.shouldCorrect(base, 3, '/a.md', 7, true, false, now), false);
  // ⑤ 过期
  assert.strictEqual(P.shouldCorrect(base, 3, '/a.md', 7, false, false, 10001), false);
  // ⑥ 用户接管
  assert.strictEqual(P.shouldCorrect(base, 3, '/a.md', 7, false, true, now), false);
  // pending 自身记着"已接管"也一样
  assert.strictEqual(
    P.shouldCorrect({ mountGen: 3, path: '/a.md', docSeq: 7, expires: 10000, userAborted: true }, 3, '/a.md', 7, false, false, now),
    false
  );
  assert.strictEqual(P.shouldCorrect(null, 3, '/a.md', 7, false, false, now), false);
});

// ── #21–#22 源码级闸门 ──────────────────────────────────────────────

test('#21 ⭐ 脚本顺序：reload.js ≤ progress.js < session.js < main.js', function () {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  // ⚠️ 必须按**真的 `<script src>` 标签**找，⛔ 不能只搜文件名：
  //    `index.html` 的注释里就写着 `main.js` / `session.js`（讲顺序的那些说明），
  //    按 `indexOf('main.js')` 找会命中注释 ⇒ 这条闸门会**恒假**。
  const at = function (name) {
    const tag = '<script src="' + name + '"></script>';
    const i = html.indexOf(tag);
    assert.ok(i >= 0, 'index.html 里找不到 ' + tag);
    return i;
  };
  const reload = at('services/reload.js');
  const progress = at('services/progress.js');
  const session = at('services/session.js');
  const main = at('main.js');
  assert.ok(reload <= progress, 'progress.js 必须排在 reload.js 之后（或同批）');
  assert.ok(progress < session, 'progress.js 必须在 session.js 之前');
  assert.ok(progress < main, 'progress.js 必须在 main.js 之前');
});

test('#22 ⭐ 接线闸门：身份核对与挂载代号真的在源码里', function () {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // ① 保存/冲刷回调里同时核对 capture.path 与 capture.docSeq
  assert.ok(/capture\.path\s*!==\s*S\.state\.currentPath/.test(js), '保存回调缺 capture.path 核对');
  assert.ok(/capture\.docSeq\s*!==\s*currentDocSeq\(\)/.test(js), '保存回调缺 capture.docSeq 核对');
  // ② mountDocument 开头自增挂载代号并作废旧恢复意图
  assert.ok(/mountGen\s*\+=\s*1/.test(js), 'mountDocument 缺 mountGen += 1');
  assert.ok(/pendingRestore\s*=\s*null/.test(js), 'mountDocument 缺 pendingRestore = null');
});
