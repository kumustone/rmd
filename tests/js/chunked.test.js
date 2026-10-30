// `design/0003` §7 的单测之二：**分片中断**（R5 点名的"分片中途切根"）。
//
// ⭐ 这一格测的是四种失败里**最隐蔽**的一种：切根之后旧代的分片继续往 DOM 里追加。
// 若只"停止调度、不移除已追加的"，留下的是一棵**半截的旧树**——
// 它看起来像"这个目录里真只有这么多文件"，是**静默的错误内容**，比崩溃更糟
// （`INV-VER-01`）。所以断言必须包含"已追加的部分被**移除**"，
// ⛔ 只断言"没继续追加"是不够的。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../../src/services/chunked.js');

/** 一个可控的调度器：回调攒起来，由测试决定什么时候跑。 */
function fakeScheduler() {
  const queue = [];
  return {
    schedule: (fn) => { queue.push(fn); },
    pending: () => queue.length,
    /** 跑一批（模拟一次 idle 回调）。 */
    runOne: () => { const fn = queue.shift(); if (fn) fn(); },
  };
}

/** 造一个"假 DOM"：append/remove 都记在一个数组里。 */
function fakeHost() {
  const live = [];
  return {
    live,
    build: (from, to) => {
      const out = [];
      for (let i = from; i < to; i++) out.push({ id: i });
      return out;
    },
    append: (nodes) => { for (const n of nodes) live.push(n); },
    remove: (nodes) => { for (const n of nodes) { const i = live.indexOf(n); if (i >= 0) live.splice(i, 1); } },
  };
}

test('分片追加_生成到第3批时代次变了_停止并移除已追加部分', () => {
  const sched = fakeScheduler();
  const host = fakeHost();
  let gen = 7;

  const app = C.createChunkAppender({
    total: 1200,
    gen: 7,
    currentGen: () => gen,
    build: host.build,
    append: host.append,
    remove: host.remove,
    schedule: sched.schedule,
  });

  app.start();                         // 第 1 批（同步）
  assert.strictEqual(host.live.length, 500);
  assert.strictEqual(sched.pending(), 1);

  sched.runOne();                      // 第 2 批
  assert.strictEqual(host.live.length, 1000);

  // ⭐ 切根发生在这里——第 3 批之前
  gen = 8;

  sched.runOne();                      // 第 3 批应当"发现代次变了"
  assert.strictEqual(app.state.stale, true);
  assert.strictEqual(app.state.reason, 'gen');
  // ⛔ 关键断言：**已追加的 1000 个节点也一并消失**，不留半截旧树
  assert.strictEqual(host.live.length, 0);
  assert.strictEqual(app.state.appended.length, 0);
  // ⛔ 而且不再继续调度
  assert.strictEqual(sched.pending(), 0);
});

test('分片追加_首批之前代次就变了_一个节点都不追加', () => {
  const sched = fakeScheduler();
  const host = fakeHost();
  const app = C.createChunkAppender({
    total: 1200,
    gen: 7,
    currentGen: () => 8, // 一开始就已经是别的代次了
    build: host.build,
    append: host.append,
    remove: host.remove,
    schedule: sched.schedule,
  });
  app.start();
  assert.strictEqual(host.live.length, 0);
  assert.strictEqual(app.state.stale, true);
  assert.strictEqual(sched.pending(), 0); // ⛔ 不排任何剩余分片
});

test('分片追加_代次不变时跑完并正常结束', () => {
  const sched = fakeScheduler();
  const host = fakeHost();
  const app = C.createChunkAppender({
    total: 1200,
    gen: 7,
    currentGen: () => 7,
    build: host.build,
    append: host.append,
    remove: host.remove,
    schedule: sched.schedule,
  });
  app.start();
  sched.runOne();
  sched.runOne();
  assert.strictEqual(host.live.length, 1200);
  assert.strictEqual(app.state.stale, false);
  assert.strictEqual(app.state.reason, 'done');
  assert.strictEqual(sched.pending(), 0);
  // ⚠️ 正常结束时**不移除**任何东西——移除只属于"陈旧"那条路径
  assert.strictEqual(app.state.appended.length, 1200);
});

test('分片追加_不足阈值时一次追加完_不排回调', () => {
  const sched = fakeScheduler();
  const host = fakeHost();
  const app = C.createChunkAppender({
    total: 120,
    gen: 7,
    currentGen: () => 7,
    build: host.build,
    append: host.append,
    remove: host.remove,
    schedule: sched.schedule,
  });
  app.start();
  assert.strictEqual(host.live.length, 120);
  assert.strictEqual(sched.pending(), 0);
  assert.strictEqual(app.state.reason, 'done');
});

test('分片追加_顺序是连续的_不重不漏', () => {
  const sched = fakeScheduler();
  const host = fakeHost();
  const app = C.createChunkAppender({
    total: 1200,
    gen: 1,
    currentGen: () => 1,
    build: host.build,
    append: host.append,
    remove: host.remove,
    schedule: sched.schedule,
  });
  app.start();
  sched.runOne();
  sched.runOne();
  assert.deepStrictEqual(host.live.map((n) => n.id), Array.from({ length: 1200 }, (_, i) => i));
});

// ⭐ `design/0009` §2.1 ⑤ 加的口子：**这一层结束了吗**。
//
// ⚠️ 它存在的理由不是"顺手加个回调"：`FileTree.expand` 要能被 `await` 到
//    "本层**全**渲染完"（含最后一片），否则 `revealPath` 会在分片还没跑完时
//    去 `findNode` ⇒ 目标落在未追加的分片里时返回 `null`，
//    表现是「搜索结果点得开正文、树定位不到」——**静默**，而且只在 >500 项的层上偶发。
// ⭐ 两条判据缺一不可：**成功也要调**、**整批回滚也要调**，且**只调一次**。

test('onDone_正常跑完时调一次_且是成功那一种', () => {
  const sched = fakeScheduler();
  const host = fakeHost();
  const calls = [];
  const app = C.createChunkAppender({
    total: 1200, gen: 1, currentGen: () => 1,
    build: host.build, append: host.append, remove: host.remove,
    schedule: sched.schedule,
    onDone: (st) => calls.push(st.reason),
  });
  app.start();
  assert.deepStrictEqual(calls, [], '⚠️ 还没跑完就报"结束"会更糟：那等于谎报完成');
  while (sched.pending() > 0) sched.runOne();
  assert.deepStrictEqual(calls, ['done']);
  assert.strictEqual(host.live.length, 1200);
});

test('onDone_整批回滚时也要调_调用方才知道"别等了"', () => {
  // ⚠️ 少了这一路，`expand` 那个 Promise **永远不 resolve** ⇒
  //    用户点了搜索结果之后，树那边一直挂在"正在定位"上（而界面上看不出任何东西）。
  const sched = fakeScheduler();
  const host = fakeHost();
  const calls = [];
  let gen = 1;
  const app = C.createChunkAppender({
    total: 1200, gen: 1, currentGen: () => gen,
    build: host.build, append: host.append, remove: host.remove,
    schedule: sched.schedule,
    onDone: (st) => calls.push(st.reason),
  });
  app.start();
  gen = 2;                 // 切根
  sched.runOne();
  assert.deepStrictEqual(calls, ['gen']);
  assert.strictEqual(host.live.length, 0, '⚠️ 已追加的部分必须被移除（INV-VER-01）');
});

test('onDone_只调一次_后续的分片不该再报一次结束', () => {
  const sched = fakeScheduler();
  const host = fakeHost();
  const calls = [];
  const app = C.createChunkAppender({
    total: 1200, gen: 1, currentGen: () => 1,
    build: host.build, append: host.append, remove: host.remove,
    schedule: sched.schedule,
    onDone: () => calls.push(1),
  });
  app.start();
  while (sched.pending() > 0) sched.runOne();
  sched.runOne();          // 队列空了之后再抽一次（现实中是已排的回调迟到）
  app.start();             // 再 start 一次（调用方写错了也不该重复通知）
  assert.strictEqual(calls.length, 1);
});

test('onDone_自己抛错不许带走分片循环', () => {
  // ⚠️ 回调来自调用方（`FileTree`），它一崩不该让状态变得"半停止"——
  //    更不能把异常顺着 `run()` 冒到调度器里（那会让剩下的层永远收不到 `done`）。
  const sched = fakeScheduler();
  const host = fakeHost();
  const errs = [];
  const origErr = console.error;
  console.error = () => errs.push(1);
  const app = C.createChunkAppender({
    total: 600, gen: 1, currentGen: () => 1,
    build: host.build, append: host.append, remove: host.remove,
    schedule: sched.schedule,
    onDone: () => { throw new Error('调用方的锅'); },
  });
  app.start();
  while (sched.pending() > 0) sched.runOne();
  console.error = origErr;
  assert.strictEqual(app.state.reason, 'done');
  assert.strictEqual(host.live.length, 600);
  assert.strictEqual(errs.length, 1, '⚠️ 吞掉可以，静默不行');
});
