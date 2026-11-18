// 编辑内核 · 全文变更事务的协调层。
// 从 `docs/bugs/` 的 0014/0020/0062/0064/0065/0100 倒推：
// 结果有五种而不是布尔、回滚按快照逐项退、旧事务不许碰新会话、选区跨替换映射。
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

const T = load('src/live/txn.js').liveTxn;

// 源自 docs/bugs/0020（Cmd-Z 不能撤销编辑）
// 同轴向：一次变更的结论必须是五种之一；"没变""被拒""基线旧了"都不能读成"提交成功"。
test('STATUS 只有五种，字符串与设计表逐字一致', () => {
  assert.deepStrictEqual(T.STATUS, {
    COMMITTED: 'committed',
    UNCHANGED: 'unchanged',
    REJECTED: 'rejected',
    STALE: 'stale',
    FAILED: 'failed',
  });
});

test('result 给 committed：只有 committed 一个布尔为真', () => {
  const r = T.result('committed', { why: 'ok', txId: 't1' });
  assert.deepStrictEqual(r, {
    status: 'committed', committed: true, unchanged: false, rejected: false,
    stale: false, failed: false, why: 'ok', txId: 't1',
    revision: null, selection: null, selectionLost: false,
  });
});

test('result 给 unchanged / rejected / stale / failed：各自只有自己的布尔为真', () => {
  for (const status of ['unchanged', 'rejected', 'stale', 'failed']) {
    const r = T.result(status);
    assert.strictEqual(r.status, status);
    assert.strictEqual(r.committed, false);
    assert.strictEqual(r.unchanged, status === 'unchanged');
    assert.strictEqual(r.rejected, status === 'rejected');
    assert.strictEqual(r.stale, status === 'stale');
    assert.strictEqual(r.failed, status === 'failed');
  }
});

// 源自 docs/bugs/0065（非法单元格绑定被判成无修改）
// 同轴向：非法输入是 rejected；unchanged 只表示"确实没改"，⛔ 不能拿来兜住非法输入。
test('非法绑定报 rejected，与 unchanged 的两个布尔绝不重叠', () => {
  const rej = T.result('rejected', { why: 'illegal-cell-binding', txId: 't9' });
  assert.strictEqual(rej.status, 'rejected');
  assert.strictEqual(rej.rejected, true);
  assert.strictEqual(rej.unchanged, false);
  assert.strictEqual(rej.committed, false);
  assert.strictEqual(rej.why, 'illegal-cell-binding');
  const unch = T.result('unchanged');
  assert.strictEqual(unch.unchanged, true);
  assert.strictEqual(unch.rejected, false);
  assert.strictEqual(unch.committed, false);
});

test('result 把 why 归一成字符串，空值变空串', () => {
  assert.strictEqual(T.result('failed', { why: null }).why, '');
  assert.strictEqual(T.result('failed', { why: undefined }).why, '');
  assert.strictEqual(T.result('failed', { why: 42 }).why, '42');
  assert.strictEqual(T.result('failed').why, '');
});

test('result 的 txId 缺省为 null，显式 0 / 空串保留', () => {
  assert.strictEqual(T.result('stale').txId, null);
  assert.strictEqual(T.result('stale', { txId: undefined }).txId, null);
  assert.strictEqual(T.result('stale', { txId: 0 }).txId, 0);
  assert.strictEqual(T.result('stale', { txId: '' }).txId, '');
});

test('result 只把严格的 true 读成 selectionLost', () => {
  assert.strictEqual(T.result('committed', { selectionLost: true }).selectionLost, true);
  assert.strictEqual(T.result('committed', { selectionLost: 1 }).selectionLost, false);
  assert.strictEqual(T.result('committed', { selectionLost: 'true' }).selectionLost, false);
});

test('result 拿到未知状态名直接抛错，不静默折成 failed', () => {
  assert.throws(function () { T.result('ok'); }, /unknown transaction status ok/);
  assert.throws(function () { T.result(''); }, /unknown transaction status/);
});

test('revisionKey 只认 docSeq 与 commitSeq，空修订给空串', () => {
  assert.strictEqual(T.revisionKey(null), '');
  assert.strictEqual(T.revisionKey(undefined), '');
  assert.strictEqual(T.revisionKey({ docSeq: 3, commitSeq: 4 }), '3:4');
  assert.strictEqual(T.revisionKey({ docSeq: 3, commitSeq: 4, generation: 9 }), '3:4');
  assert.notStrictEqual(T.revisionKey({ docSeq: 3, commitSeq: 4 }), T.revisionKey({ docSeq: 3, commitSeq: 5 }));
});

test('revisionKey 忽略 generation 与行数这类"看起来像版本"的字段', () => {
  assert.strictEqual(
    T.revisionKey({ docSeq: 1, commitSeq: 2, generation: 7, lineCount: 99 }),
    T.revisionKey({ docSeq: 1, commitSeq: 2, generation: 8, lineCount: 3 }),
  );
});

// 源自 docs/bugs/0014（实时编辑的删除键不生效）
// 同轴向：回滚不是"再补 catch"，而是按 T0 快照倒序逐项恢复；一项失败不能拦住其余。
test('frame 默认 kind=edit、revision=null、txId=undefined', () => {
  const f = T.createFrame();
  assert.strictEqual(f.kind, 'edit');
  assert.strictEqual(f.revision, null);
  assert.strictEqual(f.txId, undefined);
  assert.strictEqual(f.restored, false);
});

test('frame.add 在加入那一刻就执行 save（T0），不是回滚时才取', () => {
  const calls = [];
  const f = T.createFrame();
  f.add('a', function () { calls.push('save-a'); return 1; }, function () {});
  f.add('b', function () { calls.push('save-b'); return 2; }, function () {});
  assert.deepStrictEqual(calls, ['save-a', 'save-b']);
});

test('restore 按加入的相反顺序逐项恢复，并传回各自 T0 值', () => {
  const calls = [];
  const f = T.createFrame({ txId: 't1' });
  f.add('a', function () { return 'A0'; }, function (v) { calls.push('a=' + v); });
  f.add('b', function () { return 'B0'; }, function (v) { calls.push('b=' + v); });
  const r = f.restore({ txId: 't1' });
  assert.deepStrictEqual(calls, ['b=B0', 'a=A0']);
  assert.deepStrictEqual(r, { ok: true, already: false, failed: [], why: '' });
  assert.strictEqual(f.restored, true);
});

test('restore 一项抛错不拦其余，失败名单按恢复顺序记', () => {
  const calls = [];
  const f = T.createFrame();
  f.add('first', function () { return 1; }, function () { calls.push('first'); throw new Error('boom'); });
  f.add('second', function () { return 2; }, function () { calls.push('second'); });
  const r = f.restore();
  assert.deepStrictEqual(calls, ['second', 'first']);
  assert.deepStrictEqual(r, { ok: false, already: false, failed: ['first'], why: 'first' });
});

test('restore 多项失败时 failed 数组与 why 用逗号连', () => {
  const f = T.createFrame();
  f.add('a', function () { return 0; }, function () { throw new Error('x'); });
  f.add('b', function () { return 0; }, function () { throw new Error('y'); });
  const r = f.restore();
  assert.deepStrictEqual(r.failed, ['b', 'a']);
  assert.strictEqual(r.why, 'b,a');
  assert.strictEqual(r.ok, false);
});

test('restore 是幂等的：第二次返回第一次结论且不再动状态', () => {
  let restores = 0;
  const f = T.createFrame();
  f.add('a', function () { return 0; }, function () { restores++; });
  const first = f.restore();
  const second = f.restore();
  assert.strictEqual(restores, 1);
  assert.strictEqual(second.already, true);
  assert.strictEqual(second.ok, first.ok);
  assert.notStrictEqual(second, first);
});

test('失败过的回滚再次调用仍报 already 且保留失败名单', () => {
  const f = T.createFrame();
  f.add('bad', function () { return 0; }, function () { throw new Error('x'); });
  f.restore();
  const again = f.restore({ txId: 'anything' });
  assert.strictEqual(again.already, true);
  assert.strictEqual(again.ok, false);
  assert.deepStrictEqual(again.failed, ['bad']);
  assert.strictEqual(again.why, 'bad');
});

// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
// 同轴向：旧事务的 catch/finally 拿到过期句柄时，不许把新会话退回旧状态。
test('claim.txId 与 frame 不符时什么都不做（not-owner）', () => {
  let restores = 0;
  const f = T.createFrame({ txId: 'new' });
  f.add('a', function () { return 0; }, function () { restores++; });
  const r = f.restore({ txId: 'old' });
  assert.deepStrictEqual(r, { ok: false, already: false, failed: [], why: 'not-owner' });
  assert.strictEqual(restores, 0);
  assert.strictEqual(f.restored, false);
});

test('not-owner 之后正确所有者仍可回滚（过期句柄不消耗回滚权）', () => {
  let restores = 0;
  const f = T.createFrame({ txId: 'new' });
  f.add('a', function () { return 0; }, function () { restores++; });
  f.restore({ txId: 'old' });
  const r = f.restore({ txId: 'new' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(restores, 1);
});

test('claim 不给 txId（null / undefined）时不做所有权校验', () => {
  for (const txId of [undefined, null]) {
    let restores = 0;
    const f = T.createFrame({ txId: 'x' });
    f.add('a', function () { return 0; }, function () { restores++; });
    assert.strictEqual(f.restore({ txId: txId }).ok, true);
    assert.strictEqual(restores, 1);
  }
  assert.strictEqual(T.createFrame().restore({ txId: 'x' }).why, 'not-owner');
});

test('claim.revision 比 frame.revision 新时拒绝回滚（newer）', () => {
  let restores = 0;
  const f = T.createFrame({ revision: { docSeq: 1, commitSeq: 2 } });
  f.add('a', function () { return 0; }, function () { restores++; });
  const r = f.restore({ revision: { docSeq: 1, commitSeq: 3 } });
  assert.deepStrictEqual(r, { ok: false, already: false, failed: [], why: 'newer' });
  assert.strictEqual(restores, 0);
  assert.strictEqual(f.restored, false);
});

test('修订只按 docSeq:commitSeq 比较，generation 不同不算 newer', () => {
  let restores = 0;
  const f = T.createFrame({ revision: { docSeq: 1, commitSeq: 2, generation: 1 } });
  f.add('a', function () { return 0; }, function () { restores++; });
  const r = f.restore({ revision: { docSeq: 1, commitSeq: 2, generation: 2 } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(restores, 1);
});

test('任一方缺修订时跳过修订校验', () => {
  for (const pair of [
    [{ revision: null }, { revision: { docSeq: 9, commitSeq: 9 } }],
    [{ revision: { docSeq: 9, commitSeq: 9 } }, { revision: null }],
  ]) {
    const f = T.createFrame({ revision: pair[0].revision });
    f.add('a', function () { return 0; }, function () {});
    assert.strictEqual(f.restore({ revision: pair[1].revision }).ok, true);
  }
});

test('所有权先于修订判定：txId 不符时即使修订也旧，仍报 not-owner', () => {
  const f = T.createFrame({ txId: 'new', revision: { docSeq: 1, commitSeq: 2 } });
  const r = f.restore({ txId: 'old', revision: { docSeq: 1, commitSeq: 9 } });
  assert.strictEqual(r.why, 'not-owner');
});

// 源自 docs/bugs/0062（组合取消且目标失效时暂存粘贴写到旧偏移）
// 同轴向：选区载荷必须带空间与方向；格内偏移不许裸加源码偏移。
test('selection 缺省：两端 0、空间 doc、修订 null、对象 null', () => {
  assert.deepStrictEqual(T.selection(), {
    anchor: 0, head: 0, space: 'doc', revision: null, objectId: null,
  });
});

test('selection 保留方向：anchor 与 head 分开存，不折成 from/to', () => {
  const s = T.selection({ anchor: 9, head: 2 });
  assert.strictEqual(s.anchor, 9);
  assert.strictEqual(s.head, 2);
  assert.deepStrictEqual(T.bounds(s), { from: 2, to: 9 });
});

test('selection 只认 cell / block / doc 三种空间，未知值退回 doc', () => {
  assert.strictEqual(T.selection({ space: 'cell' }).space, 'cell');
  assert.strictEqual(T.selection({ space: 'block' }).space, 'block');
  assert.strictEqual(T.selection({ space: 'doc' }).space, 'doc');
  assert.strictEqual(T.selection({ space: 'Cell' }).space, 'doc');
  assert.strictEqual(T.selection({ space: null }).space, 'doc');
});

test('selection 把端点截断成整数，NaN / Infinity 归 0，负数保留', () => {
  const s = T.selection({ anchor: 3.9, head: -4.7 });
  assert.strictEqual(s.anchor, 3);
  assert.strictEqual(s.head, -4);
  assert.strictEqual(T.selection({ anchor: NaN, head: Infinity }).anchor, 0);
  assert.strictEqual(T.selection({ anchor: NaN, head: -Infinity }).head, 0);
  assert.strictEqual(T.selection({ anchor: '7' }).anchor, 0);
});

test('selection 的对象 id：缺省 null，显式 null 保留，字符串原样', () => {
  assert.strictEqual(T.selection().objectId, null);
  assert.strictEqual(T.selection({ objectId: null }).objectId, null);
  assert.strictEqual(T.selection({ objectId: 'cell-3' }).objectId, 'cell-3');
  assert.strictEqual(T.selection({ objectId: '' }).objectId, '');
});

test('bounds 对 null 给 {0,0}，对小数截断后取左右端', () => {
  assert.deepStrictEqual(T.bounds(null), { from: 0, to: 0 });
  assert.deepStrictEqual(T.bounds({ anchor: 2.9, head: 7.1 }), { from: 2, to: 7 });
  assert.deepStrictEqual(T.bounds({ anchor: -2, head: 3 }), { from: -2, to: 3 });
});

test('clampSelection 把两端夹进 [0, limit] 并保留方向', () => {
  const s = T.clampSelection(T.selection({ anchor: 9, head: -3 }), 5);
  assert.deepStrictEqual({ anchor: s.anchor, head: s.head }, { anchor: 5, head: 0 });
  const rev = T.clampSelection(T.selection({ anchor: 2, head: 5 }), 3);
  assert.deepStrictEqual({ anchor: rev.anchor, head: rev.head }, { anchor: 2, head: 3 });
});

test('clampSelection 的 limit 为负 / 非数时按 0，null 选区给 null', () => {
  assert.strictEqual(T.clampSelection(null, 5), null);
  const s = T.clampSelection(T.selection({ anchor: 4, head: 7 }), -2);
  assert.deepStrictEqual({ anchor: s.anchor, head: s.head }, { anchor: 0, head: 0 });
  const t = T.clampSelection(T.selection({ anchor: 4, head: 7 }), 'x');
  assert.deepStrictEqual({ anchor: t.anchor, head: t.head }, { anchor: 0, head: 0 });
});

test('clampSelection 保留空间、修订与对象 id', () => {
  const s = T.clampSelection(T.selection({
    anchor: 1, head: 9, space: 'cell', revision: { docSeq: 2, commitSeq: 3 }, objectId: 'c1',
  }), 4);
  assert.strictEqual(s.space, 'cell');
  assert.deepStrictEqual(s.revision, { docSeq: 2, commitSeq: 3 });
  assert.strictEqual(s.objectId, 'c1');
});

test('sameSelection 只比端点与空间，不比修订 / 对象 id', () => {
  const a = T.selection({ anchor: 1, head: 2, space: 'doc', revision: { docSeq: 1 }, objectId: 'a' });
  const b = T.selection({ anchor: 1, head: 2, space: 'doc', revision: { docSeq: 9 }, objectId: 'b' });
  assert.strictEqual(T.sameSelection(a, b), true);
  assert.strictEqual(T.sameSelection(a, T.selection({ anchor: 1, head: 2, space: 'cell' })), false);
  assert.strictEqual(T.sameSelection(a, T.selection({ anchor: 2, head: 1, space: 'doc' })), false);
});

test('sameSelection 对 null 用严格相等', () => {
  assert.strictEqual(T.sameSelection(null, null), true);
  assert.strictEqual(T.sameSelection(null, T.selection()), false);
  assert.strictEqual(T.sameSelection(T.selection(), null), false);
});

// 源自 docs/bugs/0100（中央兜底拿变更前的列表行首表判新落点）
// 同轴向：选区穿过一次替换时，旧偏移必须按同一区间映射，不能拿旧表直接判。
test('mapThrough：区间左侧不动、内部吸到新文本右端、右侧按长度差平移', () => {
  const s = T.selection({ anchor: 1, head: 8 });
  const m = T.mapThrough(s, { from: 2, to: 5 }, 2);
  assert.strictEqual(m.anchor, 1);
  assert.strictEqual(m.head, 7);
});

test('mapThrough：端点正好在 from 上吸到 from+nextLen（替换从选区左端开始）', () => {
  const m = T.mapThrough(T.selection({ anchor: 2, head: 2 }), { from: 2, to: 5 }, 2);
  assert.strictEqual(m.anchor, 4);
  assert.strictEqual(m.head, 4);
});

test('mapThrough：端点正好在 to 上算区间内部，吸到新右端', () => {
  const m = T.mapThrough(T.selection({ anchor: 5, head: 5 }), { from: 2, to: 5 }, 2);
  assert.strictEqual(m.anchor, 4);
});

test('mapThrough：插入（from=to）把恰在该点的光标推到新文本之后', () => {
  const m = T.mapThrough(T.selection({ anchor: 3, head: 3 }), { from: 3, to: 3 }, 4);
  assert.strictEqual(m.anchor, 7);
  assert.strictEqual(m.head, 7);
});

test('mapThrough：删除（nextLen=0）把内部端点叠到 from，右侧左移', () => {
  assert.strictEqual(T.mapThrough(T.selection({ anchor: 3, head: 3 }), { from: 3, to: 7 }, 0).anchor, 3);
  assert.strictEqual(T.mapThrough(T.selection({ anchor: 9, head: 9 }), { from: 3, to: 7 }, 0).anchor, 5);
});

test('mapThrough：反向选区分别映射，方向保持不变', () => {
  const m = T.mapThrough(T.selection({ anchor: 8, head: 1 }), { from: 2, to: 5 }, 1);
  assert.strictEqual(m.anchor, 6);
  assert.strictEqual(m.head, 1);
});

test('mapThrough：两端都落在被替换区间内时折叠到同一点', () => {
  const m = T.mapThrough(T.selection({ anchor: 3, head: 4 }), { from: 2, to: 5 }, 1);
  assert.strictEqual(m.anchor, 3);
  assert.strictEqual(m.head, 3);
});

test('mapThrough：nextLen 负数 / 小数 / 非数按 0 处理', () => {
  assert.strictEqual(T.mapThrough(T.selection({ anchor: 0, head: 0 }), { from: 1, to: 4 }, -3).anchor, 0);
  assert.strictEqual(T.mapThrough(T.selection({ anchor: 9, head: 9 }), { from: 1, to: 4 }, -3).anchor, 6);
  assert.strictEqual(T.mapThrough(T.selection({ anchor: 2, head: 2 }), { from: 1, to: 4 }, 2.9).anchor, 3);
  assert.strictEqual(T.mapThrough(T.selection({ anchor: 2, head: 2 }), { from: 1, to: 4 }, null).anchor, 1);
});

test('mapThrough：缺 range 时按 [0,0) 处理', () => {
  assert.strictEqual(T.mapThrough(T.selection({ anchor: 5, head: 5 }), null, 2).anchor, 7);
  assert.strictEqual(T.mapThrough(T.selection({ anchor: 0, head: 0 }), undefined, 0).anchor, 0);
});

test('mapThrough：null 选区给 null，空间 / 修订 / 对象 id 原样带过', () => {
  assert.strictEqual(T.mapThrough(null, { from: 0, to: 0 }, 1), null);
  const m = T.mapThrough(T.selection({
    anchor: 0, head: 1, space: 'cell', revision: { docSeq: 1, commitSeq: 2 }, objectId: 'c',
  }), { from: 5, to: 6 }, 1);
  assert.strictEqual(m.space, 'cell');
  assert.deepStrictEqual(m.revision, { docSeq: 1, commitSeq: 2 });
  assert.strictEqual(m.objectId, 'c');
});

test('mapThrough 不修改输入选区', () => {
  const s = T.selection({ anchor: 4, head: 4 });
  T.mapThrough(s, { from: 1, to: 2 }, 9);
  assert.strictEqual(s.anchor, 4);
});

test('mapThrough 与 clampSelection 串起来：先映射再夹回文本长度', () => {
  const m = T.mapThrough(T.selection({ anchor: 8, head: 8 }), { from: 2, to: 5 }, 0);
  assert.strictEqual(m.anchor, 5);
  assert.strictEqual(T.clampSelection(m, 4).anchor, 4);
});
