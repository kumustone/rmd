// 事务协调层：五种结果、修订比较键、可回滚快照的所有权 / 修订 / 幂等、选区载荷与映射。
// 守的是 `design/0058` §2.2 / §2.5 与「stale 不是失败也不是无操作」。
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

const X = load('src/live/txn.js').liveTxn;

test('STATUS 只有五种，名字就是设计表里的那五个', () => {
  assert.deepStrictEqual(X.STATUS, {
    COMMITTED: 'committed',
    UNCHANGED: 'unchanged',
    REJECTED: 'rejected',
    STALE: 'stale',
    FAILED: 'failed',
  });
});

test('result 为每种状态只点亮对应的布尔，不把 stale / unchanged 读成成功', () => {
  for (const status of Object.keys(X.STATUS).map(function (k) { return X.STATUS[k]; })) {
    const r = X.result(status);
    assert.strictEqual(r.status, status);
    assert.strictEqual(r.committed, status === 'committed', status);
    assert.strictEqual(r.unchanged, status === 'unchanged', status);
    assert.strictEqual(r.rejected, status === 'rejected', status);
    assert.strictEqual(r.stale, status === 'stale', status);
    assert.strictEqual(r.failed, status === 'failed', status);
  }
});

test('result 对未知状态抛错，不静默折成 failed', () => {
  assert.throws(function () { X.result('ok'); }, /unknown transaction status ok/);
  assert.throws(function () { X.result(''); }, /unknown transaction status/);
});

test('result 归一 why / txId / revision / selection / selectionLost', () => {
  const rev = { docSeq: 1, commitSeq: 2 };
  const sel = { anchor: 1, head: 2 };
  const r = X.result('stale', {
    why: 12, txId: 0, revision: rev, selection: sel, selectionLost: true,
  });
  assert.strictEqual(r.why, '12');
  assert.strictEqual(r.txId, 0);
  assert.strictEqual(r.revision, rev);
  assert.strictEqual(r.selection, sel);
  assert.strictEqual(r.selectionLost, true);
  assert.strictEqual(X.result('stale', { selectionLost: 1 }).selectionLost, false);
});

test('result 的缺省值：why 空串、txId / revision / selection 为 null', () => {
  const r = X.result('failed');
  assert.strictEqual(r.why, '');
  assert.strictEqual(r.txId, null);
  assert.strictEqual(r.revision, null);
  assert.strictEqual(r.selection, null);
});

test('revisionKey 只认 docSeq 与 commitSeq，空修订给空串', () => {
  assert.strictEqual(X.revisionKey(null), '');
  assert.strictEqual(X.revisionKey({}), 'undefined:undefined');
  assert.strictEqual(X.revisionKey({ docSeq: 3, commitSeq: 4 }), '3:4');
  assert.strictEqual(X.revisionKey({ docSeq: '3', commitSeq: '4', generation: 9, lineCount: 99 }), '3:4');
});

test('revisionKey 让 generation / 行数不同的同一文本版本相等', () => {
  const a = X.revisionKey({ docSeq: 1, commitSeq: 2, generation: 5, lineCount: 10 });
  const b = X.revisionKey({ docSeq: 1, commitSeq: 2, generation: 6, lineCount: 20 });
  assert.strictEqual(a, b);
});

test('createFrame 的 add 在加入那一刻就取值（T0 语义）', () => {
  let state = 'T0';
  const f = X.createFrame({ txId: 'tx1' });
  f.add('doc', function () { return state; }, function () {});
  state = 'changed';
  assert.strictEqual(f.restored, false);
  assert.deepStrictEqual(f.restore({ txId: 'tx1' }), {
    ok: true, already: false, failed: [], why: '',
  });
});

test('restore 按加入的逆序退回每一部分', () => {
  const order = [];
  const f = X.createFrame({ txId: 'tx1' });
  f.add('first', function () { return 1; }, function () { order.push('first'); });
  f.add('second', function () { return 2; }, function () { order.push('second'); });
  f.restore({ txId: 'tx1' });
  assert.deepStrictEqual(order, ['second', 'first']);
});

test('restore 幂等：第二次返回 already，不再动任何状态', () => {
  let count = 0;
  const f = X.createFrame({ txId: 'tx1' });
  f.add('doc', function () { return 0; }, function () { count++; });
  const first = f.restore({ txId: 'tx1' });
  const second = f.restore({ txId: 'tx1' });
  assert.strictEqual(count, 1);
  assert.strictEqual(first.already, false);
  assert.strictEqual(second.already, true);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(f.restored, true);
});

test('restore 的所有权不符时什么都不做，也不标记 restored', () => {
  let count = 0;
  const f = X.createFrame({ txId: 'tx2' });
  f.add('doc', function () { return 0; }, function () { count++; });
  assert.deepStrictEqual(f.restore({ txId: 'tx1' }), {
    ok: false, already: false, failed: [], why: 'not-owner',
  });
  assert.strictEqual(count, 0);
  assert.strictEqual(f.restored, false);
});

test('restore 接受缺 txId 的 claim（调用方显式不校验所有权）', () => {
  let count = 0;
  const f = X.createFrame({ txId: 'tx2' });
  f.add('doc', function () { return 0; }, function () { count++; });
  assert.strictEqual(f.restore({}).ok, true);
  assert.strictEqual(count, 1);
  assert.strictEqual(f.restore().ok, true);
});

test('restore 的修订不符时拒绝退回，避免盖掉更新的一次提交', () => {
  let count = 0;
  const f = X.createFrame({ txId: 'tx1', revision: { docSeq: 1, commitSeq: 2 } });
  f.add('doc', function () { return 0; }, function () { count++; });
  assert.deepStrictEqual(f.restore({ txId: 'tx1', revision: { docSeq: 1, commitSeq: 3 } }), {
    ok: false, already: false, failed: [], why: 'newer',
  });
  assert.strictEqual(count, 0);
});

test('restore 的修订一致时正常退回', () => {
  let count = 0;
  const f = X.createFrame({ txId: 'tx1', revision: { docSeq: 1, commitSeq: 2 } });
  f.add('doc', function () { return 0; }, function () { count++; });
  assert.strictEqual(f.restore({ txId: 'tx1', revision: { docSeq: 1, commitSeq: 2 } }).ok, true);
  assert.strictEqual(count, 1);
});

test('某一项退回抛错不拦住其余项，失败项按加入顺序记名', () => {
  const order = [];
  const f = X.createFrame({ txId: 'tx1' });
  f.add('session', function () { return 1; }, function () { order.push('session'); });
  f.add('object', function () { return 2; }, function () { throw new Error('坏'); });
  f.add('tables', function () { return 3; }, function () { order.push('tables'); });
  const r = f.restore({ txId: 'tx1' });
  assert.deepStrictEqual(order, ['tables', 'session']);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.failed, ['object']);
  assert.strictEqual(r.why, 'object');
});

test('部分失败后的第二次 restore 仍返回同一份失败清单（already）', () => {
  const f = X.createFrame({ txId: 'tx1' });
  f.add('object', function () { return 0; }, function () { throw new Error('坏'); });
  const first = f.restore({ txId: 'tx1' });
  const second = f.restore({ txId: 'tx1' });
  assert.strictEqual(second.already, true);
  assert.strictEqual(second.ok, first.ok);
  assert.deepStrictEqual(second.failed, first.failed);
  assert.strictEqual(second.why, first.why);
});

test('frame 的 txId / kind / revision 默认值与显式值', () => {
  const a = X.createFrame();
  assert.strictEqual(a.txId, undefined);
  assert.strictEqual(a.kind, 'edit');
  assert.strictEqual(a.revision, null);
  const rev = { docSeq: 1, commitSeq: 1 };
  const b = X.createFrame({ txId: 't', kind: 'insert', revision: rev });
  assert.strictEqual(b.txId, 't');
  assert.strictEqual(b.kind, 'insert');
  assert.strictEqual(b.revision, rev);
});

test('selection 的 anchor / head 截成整数，越界值按 0 兜底', () => {
  assert.deepStrictEqual(X.selection({ anchor: 1.9, head: -2.2 }), {
    anchor: 1, head: -2, space: 'doc', revision: null, objectId: null,
  });
  assert.strictEqual(X.selection({ anchor: Infinity }).anchor, 0);
  assert.strictEqual(X.selection({ head: NaN }).head, 0);
  assert.strictEqual(X.selection(null).anchor, 0);
});

test('selection 保留三种空间，未知空间一律落到 doc', () => {
  assert.strictEqual(X.selection({ space: 'cell' }).space, 'cell');
  assert.strictEqual(X.selection({ space: 'block' }).space, 'block');
  assert.strictEqual(X.selection({ space: 'doc' }).space, 'doc');
  assert.strictEqual(X.selection({ space: 'other' }).space, 'doc');
  assert.strictEqual(X.selection({}).space, 'doc');
});

test('selection 保留修订与 objectId，objectId 缺省为 null', () => {
  const rev = { docSeq: 1, commitSeq: 1 };
  const s = X.selection({ revision: rev, objectId: 'cell:0:1' });
  assert.strictEqual(s.revision, rev);
  assert.strictEqual(s.objectId, 'cell:0:1');
  assert.strictEqual(X.selection({}).objectId, null);
  assert.strictEqual(X.selection({ objectId: null }).objectId, null);
});

test('bounds 与方向无关，缺字段按 0', () => {
  assert.deepStrictEqual(X.bounds({ anchor: 7, head: 2 }), { from: 2, to: 7 });
  assert.deepStrictEqual(X.bounds({ anchor: 2, head: 7 }), { from: 2, to: 7 });
  assert.deepStrictEqual(X.bounds(null), { from: 0, to: 0 });
  assert.deepStrictEqual(X.bounds({ anchor: 3 }), { from: 0, to: 3 });
});

test('clampSelection 保留方向地把两端夹进 [0, limit]', () => {
  assert.deepStrictEqual(X.clampSelection({ anchor: 9, head: -3, space: 'block' }, 5), {
    anchor: 5, head: 0, space: 'block', revision: null, objectId: null,
  });
  assert.deepStrictEqual(X.clampSelection({ anchor: 4, head: 2 }, 5), {
    anchor: 4, head: 2, space: 'doc', revision: null, objectId: null,
  });
  assert.strictEqual(X.clampSelection(null, 5), null);
});

test('clampSelection 对非法 limit 夹到 0，不产生负上限', () => {
  const s = X.clampSelection({ anchor: 3, head: 1 }, -4);
  assert.deepStrictEqual([s.anchor, s.head], [0, 0]);
  assert.deepStrictEqual(X.clampSelection({ anchor: 3, head: 1 }, NaN).anchor, 0);
});

test('clampSelection 保留 space / revision / objectId', () => {
  const rev = { docSeq: 2, commitSeq: 3 };
  const s = X.clampSelection({ anchor: 99, head: 0, space: 'cell', revision: rev, objectId: 'cell:1:2' }, 10);
  assert.strictEqual(s.space, 'cell');
  assert.strictEqual(s.revision, rev);
  assert.strictEqual(s.objectId, 'cell:1:2');
});

test('sameSelection 比较两端与空间，不比较修订 / objectId', () => {
  const a = X.selection({ anchor: 1, head: 4, space: 'cell', revision: { docSeq: 1, commitSeq: 1 } });
  const b = X.selection({ anchor: 1, head: 4, space: 'cell', revision: { docSeq: 2, commitSeq: 2 } });
  assert.strictEqual(X.sameSelection(a, b), true);
  assert.strictEqual(X.sameSelection(a, X.selection({ anchor: 1, head: 4, space: 'block' })), false);
  assert.strictEqual(X.sameSelection(a, X.selection({ anchor: 1, head: 5, space: 'cell' })), false);
  assert.strictEqual(X.sameSelection(null, null), true);
  assert.strictEqual(X.sameSelection(null, b), false);
  assert.strictEqual(X.sameSelection(a, null), false);
});

test('mapThrough 对左侧端点不动，右侧端点按长度差平移', () => {
  const sel = X.selection({ anchor: 1, head: 20 });
  const out = X.mapThrough(sel, { from: 5, to: 8 }, 10);
  assert.strictEqual(out.anchor, 1);
  assert.strictEqual(out.head, 27);
});

test('mapThrough 把落在替换区间内部（含右端）的端点吸到新文本右端', () => {
  const map = function (p) {
    return X.mapThrough(X.selection({ anchor: p, head: p }), { from: 5, to: 8 }, 3).anchor;
  };
  assert.strictEqual(map(5), 8);
  assert.strictEqual(map(6), 8);
  assert.strictEqual(map(8), 8);
  assert.strictEqual(map(4), 4);
  assert.strictEqual(map(9), 9);
});

test('mapThrough 在替换文本变短时把右侧端点左移，不出现负长度', () => {
  const out = X.mapThrough(X.selection({ anchor: 9, head: 9 }), { from: 2, to: 8 }, 0);
  assert.strictEqual(out.anchor, 3);
  assert.strictEqual(X.mapThrough(null, { from: 0, to: 1 }, 2), null);
});

test('mapThrough 保留 space / revision / objectId，未知 range 按 0 处理', () => {
  const rev = { docSeq: 1, commitSeq: 1 };
  const sel = X.selection({ anchor: 0, head: 0, space: 'block', revision: rev, objectId: 'x' });
  const out = X.mapThrough(sel, null, 3);
  assert.deepStrictEqual([out.anchor, out.space, out.objectId], [3, 'block', 'x']);
  assert.strictEqual(out.revision, rev);
});

test('mapThrough 对负 nextLen 按 0 夹取，不把端点退到区间左边', () => {
  const out = X.mapThrough(X.selection({ anchor: 4, head: 4 }), { from: 2, to: 6 }, -5);
  assert.strictEqual(out.anchor, 2);
});
