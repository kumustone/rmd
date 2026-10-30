// `src/services/diskevents.js` 的**纯逻辑**判据（`design/0050` 最终约束 3/4/8）。
//
// ⭐ 它为什么必须有单测：这一份是前端"盘上变了"的**唯一入口**，而它的失效形态
// **全是静默的**——`seq` 不推 ⇒ 在途结果把旧内容当新鲜内容提交（界面纹丝不动，
// 只有"外部改动不出现"）；`seq` 推多了 ⇒ 每次健康抖动都白重列一次树（看不出错，
// 只是慢）；订阅失败被吞 ⇒ 与"盘上什么都没变"在界面上**长得一模一样**。
// 这些都没有异常、没有日志，只能在纯逻辑这一层钉住。
//
// ⚠️ 用法上的两条纪律（与 `live-box.test.js` 同族）：
//   · 每个用例前 `_reset()`——它是**单例**，状态会串；
//   · 变异自测用 `load(源码副本)` **重新求值**，⛔ 不改导出对象：
//     闭包里捕获的是模块内部函数，改 `api.bump` 一行都不会生效。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', '..', 'src', 'services', 'diskevents.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const DE = require(SRC_PATH);

/**
 * 把一份源码**重新求值**成一个独立实例（变异自测用）。
 * ⚠️ `window` 传 `undefined`：那一行 `typeof window !== 'undefined'` 因此跳过，
 * 只留下 `module.exports` 这条路。
 */
function load(src) {
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'window', src)(mod, undefined);
  return mod.exports;
}

/** 造一份 `DiskView`（字段与 Rust 侧 `disk::DiskView` 逐字一致）。 */
function view(epoch, revision, reason, watchId, pending) {
  return {
    epoch: epoch,
    watch_id: watchId === undefined ? 1 : watchId,
    revision: revision,
    reason: reason === undefined ? null : reason,
    pending: !!pending,
  };
}

/** 一个记账用的假 tauri 实例。 */
function fakeT(opts) {
  const o = opts || {};
  const calls = [];
  const listeners = {};
  return {
    calls: calls,
    listeners: listeners,
    listen: function (name, fn) {
      calls.push(['listen', name]);
      if (o.failListen === name) {
        return Promise.reject(new Error('listen 被拒：' + name));
      }
      listeners[name] = fn;
      return Promise.resolve();
    },
    call: function (cmd, args) {
      calls.push(['call', cmd, args]);
      if (o.calls && o.calls[cmd]) return Promise.resolve(o.calls[cmd]);
      return Promise.resolve(view(0, 1));
    },
  };
}

test.beforeEach(function () { DE._reset(); });

// ────────────────────────────────────────────────────────────────
// 1 · `shouldAccept`：按 `revision` 丢倒退与重复的包（最终约束 3）
// ────────────────────────────────────────────────────────────────

test('`shouldAccept`：首份采纳、严格更大才采纳、重复与倒退一律丢', function () {
  assert.strictEqual(DE.shouldAccept(null, view(0, 1)), true, '首份必须采纳');
  assert.strictEqual(DE.shouldAccept(view(0, 1), view(0, 2)), true);
  assert.strictEqual(DE.shouldAccept(view(0, 2), view(0, 2)), false, '重复的包不许采纳');
  assert.strictEqual(DE.shouldAccept(view(0, 3), view(0, 2)), false, '倒退的包不许采纳');
  // ⚠️ 形状不对（缺 `revision`）⇒ ⛔ 不采纳：坏包不许把状态改成"没事"
  assert.strictEqual(DE.shouldAccept(null, null), false);
  assert.strictEqual(DE.shouldAccept(null, {}), false);
  assert.strictEqual(DE.shouldAccept(null, { revision: '2' }), false, '字符串不是号码');
});

test('⚠️ `shouldAccept` **不按"看起来更严重"**合并（迟到的旧包不许覆盖新状态）', function () {
  const worse = view(3, 10, 'io');
  const better = view(3, 11, null);
  assert.strictEqual(DE.shouldAccept(worse, better), true, '更新的"已恢复"必须采纳');
  assert.strictEqual(DE.shouldAccept(better, worse), false, '迟到的"仍在降级"必须丢掉');
});

// ────────────────────────────────────────────────────────────────
// 2 · `healthOf`：临时档 / 持久档 / 未知档（`INV-DISK-06`）
// ────────────────────────────────────────────────────────────────

test('`healthOf`：没有视图或没有 `reason` ⇒ 什么都不显示', function () {
  assert.strictEqual(DE.healthOf(null), null);
  assert.strictEqual(DE.healthOf(view(1, 1, null)), null);
  assert.strictEqual(DE.healthOf({}), null);
});

test('`healthOf`：五档各有键，且 `rescan` 是**唯一**不给重试按钮的（它自己会好）', function () {
  const cases = [
    ['rescan', 'disk.rescan', false, true],
    ['io', 'disk.io', true, false],
    ['path-not-found', 'disk.path-not-found', true, false],
    ['limit', 'disk.limit', true, false],
    ['rewatch-failed', 'disk.rewatch-failed', true, false],
  ];
  cases.forEach(function (c) {
    const h = DE.healthOf(view(1, 1, c[0]));
    assert.ok(h, c[0] + ' 必须有一档');
    assert.strictEqual(h.key, c[1], c[0] + ' 的键');
    assert.strictEqual(h.retry, c[2], c[0] + ' 的 retry');
    assert.strictEqual(h.transient, c[3], c[0] + ' 的 transient');
  });
});

test('⭐ 未知档**不许**静默成"没事"（后端加了新 reason 而前端没跟上）', function () {
  const h = DE.healthOf(view(1, 1, 'brand-new-reason'));
  assert.ok(h, '未知档必须仍然显示出一行');
  assert.strictEqual(h.key, '', '未知档没有键 ⇒ 展示层要退回 reason 原文');
  assert.strictEqual(h.retry, true, '未知档一律给重试入口');
  assert.strictEqual(h.transient, false, '未知档按持久档处理');
});

// ────────────────────────────────────────────────────────────────
// 3 · `bump` / `seq` / `onChange`：收到即失效，且消费者互不牵连
// ────────────────────────────────────────────────────────────────

test('`bump` 同步推进 `seq`，并把 `(seq, view)` 交给订阅者', function () {
  const seen = [];
  DE.onChange(function (s, v) { seen.push([s, v]); });
  assert.strictEqual(DE.seq(), 0);
  assert.strictEqual(DE.bump(), 1);
  assert.strictEqual(DE.seq(), 1);
  DE.bump();
  assert.strictEqual(DE.seq(), 2);
  assert.deepStrictEqual(seen.map(function (x) { return x[0]; }), [1, 2]);
});

test('⭐ 一个订阅者抛异常**不许**带走其它订阅者（最终约束 8）', function () {
  const order = [];
  DE.onChange(function () { order.push('坏'); throw new Error('boom'); });
  DE.onChange(function () { order.push('好'); });
  assert.doesNotThrow(function () { DE.bump(); });
  assert.deepStrictEqual(order, ['坏', '好'], '第二个订阅者必须照常收到');
});

test('`onState` 同理：健康订阅者抛异常不影响另一个', function () {
  const order = [];
  DE.onState(function () { order.push('坏'); throw new Error('boom'); });
  DE.onState(function () { order.push('好'); });
  assert.doesNotThrow(function () { DE.adopt(view(0, 1)); });
  assert.deepStrictEqual(order, ['坏', '好']);
});

test('取消订阅之后不再收到（`install` 之外唯一的路是 `onChange`）', function () {
  let n = 0;
  const off = DE.onChange(function () { n += 1; });
  DE.bump();
  off();
  DE.bump();
  assert.strictEqual(n, 1);
});

// ────────────────────────────────────────────────────────────────
// 4 · `adopt`：内容前进才推 `seq`，健康变化不动（最终约束 2/4）
// ────────────────────────────────────────────────────────────────

test('`adopt`：`epoch` 前进 ⇒ `seq` 同步前进，但⛔ **不通知** `onChange`', function () {
  let changed = 0;
  DE.onChange(function () { changed += 1; });
  DE.adopt(view(0, 1));
  assert.strictEqual(DE.seq(), 0, '纪元 0 是初值 ⇒ 首份不白推一格');
  assert.strictEqual(DE.adopt(view(1, 2)), true);
  assert.strictEqual(DE.seq(), 1, '内容前进了 ⇒ 在途结果必须作废');
  assert.strictEqual(changed, 0, '重列另有安排（去抖后的广播 / 调用方自己那一趟）');
});

test('⭐ 健康变化（`epoch` 不动）**不许**推进 `seq`——否则每次抖动都白重列一次树', function () {
  DE.adopt(view(5, 1, 'io'));
  const after = DE.seq();
  assert.strictEqual(DE.adopt(view(5, 2, 'rewatch-failed')), true);
  assert.strictEqual(DE.seq(), after, '同一纪元内的健康变化不动内容修订');
  assert.strictEqual(DE.adopt(view(5, 3, null)), true, '恢复也要采纳（那是提示该撤掉的唯一信号）');
  assert.strictEqual(DE.seq(), after);
});

test('倒退 / 重复的 `DiskView` 采纳失败，且**不改任何状态**', function () {
  DE.adopt(view(3, 5));
  const s = DE.seq();
  assert.strictEqual(DE.adopt(view(9, 5)), false, '同 revision 的包不采纳');
  assert.strictEqual(DE.seq(), s, '被拒的包不许推 seq（哪怕它带着更大的 epoch）');
  assert.strictEqual(DE.state().epoch, 3, '也不许改视图');
});

// ────────────────────────────────────────────────────────────────
// 5 · `install`：两条通道各订阅一次，失败必须**报出来**（最终约束 8）
// ────────────────────────────────────────────────────────────────

test('`install` 订阅两条通道，`tree-changed` 到达即推 `seq` 并通知', async function () {
  const T = fakeT();
  const r = await DE.install(T);
  assert.deepStrictEqual(r, { treeOk: true, diskOk: true, note: '' });
  assert.deepStrictEqual(T.calls.map(function (c) { return c[1]; }),
    [DE.TREE_EVENT, DE.DISK_EVENT], '两条通道各订阅一次');
  assert.strictEqual(DE.seq(), 0, '订阅本身不动序号');

  let changed = 0;
  DE.onChange(function () { changed += 1; });
  T.listeners[DE.TREE_EVENT]();
  assert.strictEqual(DE.seq(), 1);
  assert.strictEqual(changed, 1, '这条通道是"该重列了"，必须通知');
});

test('⭐ `install` 只装一次（第二次不重复注册，否则一次改动列两遍）', async function () {
  const T = fakeT();
  await DE.install(T);
  const n = T.calls.length;
  const r2 = await DE.install(T);
  assert.strictEqual(r2.treeOk, true);
  assert.strictEqual(T.calls.length, n, '第二次 install 不许再订阅一遍');
});

test('⭐ 订阅失败必须回报（`treeOk`/`diskOk` 为假 ＋ note 里点名是哪条通道）', async function () {
  const T = fakeT({ failListen: DE.TREE_EVENT });
  const r = await DE.install(T);
  assert.strictEqual(r.treeOk, false);
  assert.strictEqual(r.diskOk, true);
  assert.ok(r.note.indexOf('tree:') === 0, 'note 必须点名失败的通道：' + r.note);
});

test('`dir-watch` 那条通道到达即采纳（含恢复），健康订阅者被通知', async function () {
  const T = fakeT();
  await DE.install(T);
  const seen = [];
  DE.onState(function (v) { seen.push(v && v.reason); });
  T.listeners[DE.DISK_EVENT]({ payload: view(2, 1, 'io') });
  T.listeners[DE.DISK_EVENT]({ payload: view(2, 2, null) });
  assert.deepStrictEqual(seen, ['io', null]);
  assert.strictEqual(DE.state().revision, 2);
});

// ────────────────────────────────────────────────────────────────
// 6 · `refresh` / `retryWatch`：两条**窄命令**，不许混（最终约束 5）
// ────────────────────────────────────────────────────────────────

test('`refresh` 走 `reconcile_disk`，并把回包采纳（纪元前进 ⇒ 作废在途结果）', async function () {
  const T = fakeT({ calls: { reconcile_disk: view(4, 9) } });
  let changed = 0;
  DE.onChange(function () { changed += 1; });
  const v = await DE.refresh(T);
  assert.deepStrictEqual(T.calls, [['call', 'reconcile_disk', undefined]]);
  assert.strictEqual(v.epoch, 4);
  assert.strictEqual(DE.seq(), 1, '对账会推内容修订 ⇒ 在途结果作废');
  assert.strictEqual(changed, 0, '⛔ 不通知：调用方自己那一趟就是这次刷新的落点');
});

test('`retryWatch` 走 `retry_tree_watch`，⭐ 后端推内容修订 ⇒ 在途结果作废（评审第 9 条）', async function () {
  // ⚠️ 2026-10-29 判据**翻向**：这条此前钉的是「⛔ 不推内容修订」，
  //    而 `disk.rs::ReconcileCause::Reattach` 一直是 `epoch += 1`（文档与实现相反）。
  //    以代码为准 ⇒ 后端回包 `epoch` 前进 ⇒ `adopt` 推 `seq`。
  const T = fakeT({ calls: { retry_tree_watch: view(5, 10, null) } });
  DE.adopt(view(4, 9));
  const before = DE.seq();
  let changed = 0;
  DE.onChange(function () { changed += 1; });
  const v = await DE.retryWatch(T);
  assert.deepStrictEqual(T.calls, [['call', 'retry_tree_watch', undefined]]);
  assert.strictEqual(v.revision, 10);
  assert.strictEqual(DE.seq(), before + 1, '重接之前的盲窗口里盘上可能变过 ⇒ 推纪元');
  assert.strictEqual(changed, 0, '⛔ 不通知：重列另有安排，两边都做就是列两遍');
});

test('`retryWatch` 回包里 `epoch` 没动时⛔ 不许白推 `seq`（负对照）', async function () {
  // ⚠️ 负对照：证明上一条钉的确实是「纪元前进」，而不是「调了 retryWatch 就推」。
  const T = fakeT({ calls: { retry_tree_watch: view(4, 10, null) } });
  DE.adopt(view(4, 9));
  const before = DE.seq();
  await DE.retryWatch(T);
  assert.strictEqual(DE.seq(), before, '纪元没动 ⇒ 在途结果仍然描述着同一个时刻');
});

test('两条命令**不是**同一个（⛔ 别为了省事合并成一个参数）', async function () {
  const T = fakeT();
  await DE.refresh(T);
  await DE.retryWatch(T);
  assert.deepStrictEqual(T.calls.map(function (c) { return c[1]; }),
    ['reconcile_disk', 'retry_tree_watch']);
});

// ────────────────────────────────────────────────────────────────
// 7 · 变异自测：把**源码副本**改坏，对应的判据必须变红
//    ⚠️ 前提：变异必须**真的改到**（`notStrictEqual`），否则"没红"什么都不说明。
// ────────────────────────────────────────────────────────────────

test('⭐ 判据自检：四处变异各自必须把对应的那条判据打假（⛔ 不许有一条恒真）', function () {
  // ① 重复的包也采纳（倒退检测失效）。
  const m1 = SRC.replace('return next.revision > prev.revision;',
    'return next.revision >= prev.revision;');
  assert.notStrictEqual(m1, SRC, '变异①没改到文件');
  const A = load(m1);
  assert.strictEqual(A.shouldAccept(view(0, 2), view(0, 2)), true,
    '变异①（>= 代替 >）应当让"重复包被拒"变假');

  // ② 内容前进时**不推** `seq`（在途结果把旧内容当新鲜的）。
  const m2 = SRC.replace('      lastEpoch = next.epoch;\n      advance();',
    '      lastEpoch = next.epoch;');
  assert.notStrictEqual(m2, SRC, '变异②没改到文件');
  const B = load(m2);
  B._reset();
  B.adopt(view(0, 1));
  B.adopt(view(1, 2));
  assert.strictEqual(B.seq(), 0, '变异②（不推 seq）必须让"纪元前进 ⇒ seq 前进"变假');

  // ③ 健康变化也推 `seq`（每次抖动白重列一次树）。
  const m3 = SRC.replace("if (typeof next.epoch === 'number' && next.epoch !== lastEpoch) {",
    "if (typeof next.epoch === 'number') {");
  assert.notStrictEqual(m3, SRC, '变异③没改到文件');
  const C = load(m3);
  C._reset();
  C.adopt(view(5, 1, 'io'));
  const s0 = C.seq();
  C.adopt(view(5, 2, 'io'));
  assert.notStrictEqual(C.seq(), s0, '变异③（健康变化也推 seq）必须让"同纪元不动 seq"变假');

  // ④ 订阅者抛异常直接冒出去（第二个消费者收不到）。
  const m4 = SRC.replace(
    "      } catch (e) {\n        if (typeof console !== 'undefined') console.error('⛔ 磁盘事件订阅者抛异常：', e);\n      }",
    '      } catch (e) {\n        throw e;\n      }');
  assert.notStrictEqual(m4, SRC, '变异④没改到文件');
  const D = load(m4);
  D._reset();
  const order = [];
  D.onChange(function () { order.push('坏'); throw new Error('boom'); });
  D.onChange(function () { order.push('好'); });
  assert.throws(function () { D.bump(); }, '变异④（异常冒出去）应当让 bump 抛错');
  assert.deepStrictEqual(order, ['坏'], '变异④之后第二个订阅者收不到 —— 判据是敏感的');
});
