// `design/0058` §2.2 / §2.5 的纯逻辑判据：**全文变更事务的协调层**。
//
// ⚠️ 这一份测的是 `src/live/txn.js`（⛔ 不碰 DOM / CM6 / IPC）。
//    它守的三件事在屏幕上**都不报错**：
//    ① 五种结果被读成一个布尔（`stale` / `unchanged` 被当成"成功"）；
//    ② 发布失败后只退了一部分（全文退了、区间没退 ⇒ 下一轮候选拼错位）；
//    ③ 旧事务的 `catch` 把**新会话**恢复成旧状态（所有权/修订校验漏了）。
//    ⇒ 每条都带反例：拿掉那一条，判据必须变红。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../../src/live/txn.js');

// ── 五种结果 ───────────────────────────────────────────────────────────────

test('⭐⭐ 五种结果各自可读，`stale` / `unchanged` ⛔ 不许被读成"成功"', function () {
  const all = ['committed', 'unchanged', 'rejected', 'stale', 'failed'];
  for (const s of all) {
    const r = T.result(s, { why: 'w', txId: 't1' });
    assert.strictEqual(r.status, s);
    assert.strictEqual(r.committed, s === 'committed', s);
    // ⚠️ 反例口径：只有 `committed` 才 `committed === true`。
    //    `stale` 说的是"基线旧了"，调用方⛔ 不许据此退出/清脏/报保存成功。
  }
  // 显式把三者分开（不是"非 failed 即成功"）。
  const stale = T.result('stale');
  assert.strictEqual(stale.failed, false);
  assert.strictEqual(stale.unchanged, false);
  assert.strictEqual(stale.committed, false);
  assert.strictEqual(stale.stale, true);
});

test('⭐ 写错状态名是程序错误：⛔ 静默折成 `failed`', function () {
  assert.throws(function () { T.result('Commited'); }, /unknown transaction status/);
  assert.throws(function () { T.result(undefined); }, /unknown transaction status/);
});

test('修订比较键：`docSeq:commitSeq` —— ⛔ 不拿行数/代数当"文本版本"', function () {
  assert.strictEqual(T.revisionKey({ docSeq: 2, commitSeq: 7 }), '2:7');
  assert.strictEqual(T.revisionKey(null), '');
  assert.notStrictEqual(
    T.revisionKey({ docSeq: 1, commitSeq: 3 }),
    T.revisionKey({ docSeq: 2, commitSeq: 3 }),
    '换文档之后 commitSeq 会归零 ⇒ docSeq 必须一起比'
  );
});

// ── 快照与成对回滚 ─────────────────────────────────────────────────────────

/** 造一个最小回滚现场：三部分各自可观测。 */
function scene() {
  const log = [];
  const box = { full: 'A', range: { from: 0, to: 1 }, tables: { id: 1 } };
  const frame = T.createFrame({ txId: 1, kind: 'edit', revision: { docSeq: 1, commitSeq: 4 } });
  frame.add('session', function () { return box.full; }, function (v) { box.full = v; log.push('session'); });
  frame.add('object', function () { return box.range; }, function (v) { box.range = v; log.push('object'); });
  frame.add('tables', function () { return box.tables; }, function (v) { box.tables = v; log.push('tables'); });
  return { box: box, frame: frame, log: log };
}

test('⭐ T0 语义：`add()` 那一刻就取快照（⛔ 等要回滚了再取）', function () {
  const { box, frame } = scene();
  box.full = 'Z'; // 发布段改了真值
  const back = frame.restore({ txId: 1, revision: { docSeq: 1, commitSeq: 4 } });
  assert.strictEqual(back.ok, true);
  assert.strictEqual(box.full, 'A', '取快照晚一步就会"回滚"成发布后的值');
});

test('⭐⭐ 逐项退回且顺序相反：后面改的东西先退', function () {
  const { log, frame } = scene();
  frame.restore({ txId: 1, revision: { docSeq: 1, commitSeq: 4 } });
  assert.deepStrictEqual(log, ['tables', 'object', 'session']);
});

test('⭐⭐ 一项退不干净 ⛔ 拦住其余的（每条独立 try）', function () {
  const box = { a: 0, b: 0, c: 0 };
  const frame = T.createFrame({ txId: 7, revision: { docSeq: 1, commitSeq: 1 } });
  frame.add('a', function () { return 1; }, function () { throw new Error('boom'); });
  frame.add('b', function () { return 1; }, function () { box.b = 1; });
  frame.add('c', function () { return 1; }, function () { box.c = 1; });
  const back = frame.restore({ txId: 7, revision: { docSeq: 1, commitSeq: 1 } });
  assert.strictEqual(back.ok, false);
  assert.deepStrictEqual(back.failed, ['a']);
  assert.strictEqual(box.b, 1, 'b 必须照样退');
  assert.strictEqual(box.c, 1, 'c 必须照样退');
});

test('⭐⭐ 所有权：`txId` 不符 ⇒ 什么都不做（旧事务的 catch ⛔ 不许碰新会话）', function () {
  const { box, frame } = scene();
  box.full = 'NEW';
  const back = frame.restore({ txId: 999, revision: { docSeq: 1, commitSeq: 4 } });
  assert.deepStrictEqual(back, { ok: false, already: false, failed: [], why: 'not-owner' });
  assert.strictEqual(box.full, 'NEW');
});

test('⭐⭐ 修订：期间已有更新 ⇒ `newer`，⛔ 把新状态退回去', function () {
  const { box, frame } = scene();
  box.full = 'NEWER';
  const back = frame.restore({ txId: 1, revision: { docSeq: 1, commitSeq: 9 } });
  assert.strictEqual(back.why, 'newer');
  assert.strictEqual(box.full, 'NEWER');
});

test('⭐⭐ 幂等：第二次调用直接返回第一次的结论，⛔ 再动状态', function () {
  const { box, frame, log } = scene();
  frame.restore({ txId: 1, revision: { docSeq: 1, commitSeq: 4 } });
  const n = log.length;
  box.full = 'USER-NEW'; // 回滚之后用户又打字了
  const again = frame.restore({ txId: 1, revision: { docSeq: 1, commitSeq: 4 } });
  assert.strictEqual(again.already, true);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(box.full, 'USER-NEW', '⛔ 第二次回滚把回滚之后的新输入也退回去');
  assert.strictEqual(log.length, n, '⛔ 再执行一遍 restore 体');
});

// ── 选区载荷 ───────────────────────────────────────────────────────────────

test('⭐ 选区保留 anchor/head 方向与三种空间（⛔ 裸加偏移）', function () {
  const s = T.selection({ anchor: 9, head: 3, space: 'cell', revision: { docSeq: 1 }, objectId: 'cell:0:2' });
  assert.deepStrictEqual([s.anchor, s.head], [9, 3], '方向必须留着（反向选区的 head 是左端）');
  assert.strictEqual(s.space, 'cell');
  assert.strictEqual(s.objectId, 'cell:0:2');
  assert.strictEqual(T.selection({}).space, 'doc', '缺省是文档空间');
  assert.strictEqual(T.selection({ space: 'block' }).space, 'block');
  // ⚠️ 反例：只存 from/to 的形态
  assert.notDeepStrictEqual(T.bounds(s), { from: 9, to: 3 }, 'bounds 才是"与方向无关"的那一份');
});

test('`mapThrough`：区间内部吸附到新文本右端、右侧按长度差平移、左侧不动', function () {
  const r = { from: 2, to: 5 };
  // 替换成 5 个字符：delta = +2
  assert.strictEqual(T.mapThrough(T.selection({ anchor: 0, head: 0 }), r, 5).head, 0);
  assert.strictEqual(T.mapThrough(T.selection({ anchor: 3, head: 3 }), r, 5).head, 7);
  assert.strictEqual(T.mapThrough(T.selection({ anchor: 5, head: 5 }), r, 5).head, 7);
  assert.strictEqual(T.mapThrough(T.selection({ anchor: 8, head: 8 }), r, 5).head, 10);
  const rev = T.mapThrough(T.selection({ anchor: 8, head: 3, space: 'cell' }), r, 5);
  assert.deepStrictEqual([rev.anchor, rev.head, rev.space], [10, 7, 'cell'], '方向与空间穿过映射也不丢');
});

test('`clampSelection` 夹取边界但⛔ 不抹掉方向', function () {
  const c = T.clampSelection(T.selection({ anchor: 99, head: -5 }), 10);
  assert.deepStrictEqual([c.anchor, c.head], [10, 0]);
  assert.strictEqual(T.clampSelection(null, 10), null);
});

test('`sameSelection` 比端点与空间，⛔ 比修订（修订另存）', function () {
  const a = T.selection({ anchor: 1, head: 2, space: 'block', revision: { docSeq: 1, commitSeq: 1 } });
  const b = T.selection({ anchor: 1, head: 2, space: 'block', revision: { docSeq: 1, commitSeq: 9 } });
  assert.strictEqual(T.sameSelection(a, b), true);
  assert.strictEqual(T.sameSelection(a, T.selection({ anchor: 2, head: 1, space: 'block' })), false);
  assert.strictEqual(T.sameSelection(a, T.selection({ anchor: 1, head: 2, space: 'cell' })), false);
});
