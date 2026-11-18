// versions 的缺陷回归用例（`tests/auto/js/bugs-services-b/`）。
//
// 覆盖：版本对比较（gen 先于 req）、提交点判决、第 ③ 步的双条件、
// 深度上限与分片边界。全部纯函数，直跑。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'versions.js'), 'utf8');

function loadVersions() {
  const win = {};
  new Function('window', SRC)(win);
  return win.rmd.versions;
}

const V = loadVersions();

// ── 常量 ────────────────────────────────────────────────────────────

// 源自 docs/bugs/0001（点击链接导致应用自行重载）
test('深度上限 32、分片阈值 500 / 500 逐字锁死', () => {
  assert.strictEqual(V.MAX_DEPTH, 32);
  assert.strictEqual(V.CHUNK_FIRST, 500);
  assert.strictEqual(V.CHUNK_STEP, 500);
});

// ── versionOf ─────────────────────────────────────────────────────

// 源自 docs/bugs/0001（点击链接导致应用自行重载）
test('versionOf 只取 gen / req，其余字段不泄进版本对', () => {
  assert.deepStrictEqual(
    V.versionOf({ gen: 3, req: 9, entries: [1], path: '/a' }),
    { gen: 3, req: 9 }
  );
  assert.deepStrictEqual(Object.keys(V.versionOf({ gen: 1, req: 2 })), ['gen', 'req']);
});

// 源自 docs/bugs/0001（点击链接导致应用自行重载）
test('versionOf 缺字段时如实给 undefined，不伪造 0', () => {
  const got = V.versionOf({ gen: 1 });
  assert.strictEqual(got.gen, 1);
  assert.strictEqual(got.req, undefined);
});

// ── staleReason：gen 必须先于 req 判 ──────────────────────────────

// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
test('staleReason：两项都对 ⇒ null（可提交）', () => {
  assert.strictEqual(V.staleReason({ gen: 2, req: 5 }, { generation: 2, latestReq: 5 }), null);
});

// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
test('staleReason：代次不同 ⇒ 先报 gen（即使 req 也不同）', () => {
  assert.strictEqual(V.staleReason({ gen: 1, req: 5 }, { generation: 2, latestReq: 5 }), 'gen');
  assert.strictEqual(V.staleReason({ gen: 1, req: 4 }, { generation: 2, latestReq: 5 }), 'gen');
});

// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
test('staleReason：代次同、请求号不同 ⇒ req（慢的旧包被拒）', () => {
  assert.strictEqual(V.staleReason({ gen: 2, req: 4 }, { generation: 2, latestReq: 5 }), 'req');
  assert.strictEqual(V.staleReason({ gen: 2, req: 6 }, { generation: 2, latestReq: 5 }), 'req');
});

// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
test('staleReason：比较的是最新发出的 req，不是已接受的最大值', () => {
  // 最新请求 A→B：B 失败后，A 的回包仍然不能提交
  assert.strictEqual(V.staleReason({ gen: 1, req: 1 }, { generation: 1, latestReq: 2 }), 'req');
});

// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
test('staleReason：类型不同即视为不同（"1" ≠ 1）', () => {
  assert.strictEqual(V.staleReason({ gen: '1', req: 1 }, { generation: 1, latestReq: 1 }), 'gen');
  assert.strictEqual(V.staleReason({ gen: 1, req: '1' }, { generation: 1, latestReq: 1 }), 'req');
});

// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
test('staleReason：NaN 与 NaN 也判不同（迟到包不会被误放行）', () => {
  assert.strictEqual(V.staleReason({ gen: NaN, req: 1 }, { generation: NaN, latestReq: 1 }), 'gen');
  assert.strictEqual(V.staleReason({ gen: 1, req: NaN }, { generation: 1, latestReq: NaN }), 'req');
});

// ── docCommitDecision ─────────────────────────────────────────────

// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
test('docCommitDecision：可提交时 commit=true 且 reason=null', () => {
  assert.deepStrictEqual(
    V.docCommitDecision({ gen: 1, req: 1 }, { generation: 1, latestReq: 1 }),
    { commit: true, reason: null }
  );
});

// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
test('docCommitDecision：不可提交时带回具体原因', () => {
  assert.deepStrictEqual(
    V.docCommitDecision({ gen: 0, req: 1 }, { generation: 1, latestReq: 1 }),
    { commit: false, reason: 'gen' }
  );
  assert.deepStrictEqual(
    V.docCommitDecision({ gen: 1, req: 0 }, { generation: 1, latestReq: 1 }),
    { commit: false, reason: 'req' }
  );
});

// ── step3Needed：两个条件缺一不可 ─────────────────────────────────

// 源自 docs/bugs/0001（点击链接导致应用自行重载）
test('step3Needed：roots 非空且文档在 root 之外才触发', () => {
  assert.strictEqual(V.step3Needed({ roots_nonempty: true, outside_roots: true }), true);
});

// 源自 docs/bugs/0001（点击链接导致应用自行重载）
test('step3Needed：单文件模式（roots 为空）⛔ 不空转增代次', () => {
  assert.strictEqual(V.step3Needed({ roots_nonempty: false, outside_roots: true }), false);
});

// 源自 docs/bugs/0001（点击链接导致应用自行重载）
test('step3Needed：root 内正常导航 ⛔ 不清掉用户自己的树', () => {
  assert.strictEqual(V.step3Needed({ roots_nonempty: true, outside_roots: false }), false);
  assert.strictEqual(V.step3Needed({ roots_nonempty: true, outside_roots: 0 }), false);
});

// 源自 docs/bugs/0001（点击链接导致应用自行重载）
test('step3Needed：字段缺失 / 非真值一律不触发', () => {
  assert.strictEqual(V.step3Needed({}), false);
  assert.strictEqual(V.step3Needed({ roots_nonempty: 1, outside_roots: undefined }), false);
  assert.strictEqual(V.step3Needed({ roots_nonempty: 'yes', outside_roots: 'yes' }), true);
});

// ── depthAllowed ──────────────────────────────────────────────────

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('depthAllowed：0..31 可展开，32 起拒绝', () => {
  assert.strictEqual(V.depthAllowed(0), true);
  assert.strictEqual(V.depthAllowed(31), true);
  assert.strictEqual(V.depthAllowed(32), false);
  assert.strictEqual(V.depthAllowed(33), false);
  assert.strictEqual(V.depthAllowed(99), false);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('depthAllowed：负数层号被判为可展开（上游不该传负值）', () => {
  // ⚠️ 疑似缺陷：负数 depth 会通过 `depth < 32`；钉住现状，别让它无声漂移。
  assert.strictEqual(V.depthAllowed(-1), true);
  assert.strictEqual(V.depthAllowed(-100), true);
});

// ── firstChunkSize ────────────────────────────────────────────────

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('firstChunkSize：不超过 500 时全量，超过时首批 500', () => {
  assert.strictEqual(V.firstChunkSize(0), 0);
  assert.strictEqual(V.firstChunkSize(1), 1);
  assert.strictEqual(V.firstChunkSize(499), 499);
  assert.strictEqual(V.firstChunkSize(500), 500);
  assert.strictEqual(V.firstChunkSize(501), 500);
  assert.strictEqual(V.firstChunkSize(5200), 500);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('firstChunkSize：负数原样返回负数（⛔ 不夹成 0）', () => {
  // ⚠️ 疑似缺陷：Math.min(-1, 500) = -1，负数会直接漏给分片器。
  assert.strictEqual(V.firstChunkSize(-1), -1);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('firstChunkSize：NaN 原样返回 NaN', () => {
  // ⚠️ 疑似缺陷：NaN 会一路传到"已渲染条数"的比较里。
  assert.ok(Number.isNaN(V.firstChunkSize(NaN)));
});

// ── chunkPlan：分片边界 ───────────────────────────────────────────

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('chunkPlan：空层给空计划', () => {
  assert.deepStrictEqual(V.chunkPlan(0), []);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('chunkPlan：1 / 499 / 500 都只有一片', () => {
  assert.deepStrictEqual(V.chunkPlan(1), [[0, 1]]);
  assert.deepStrictEqual(V.chunkPlan(499), [[0, 499]]);
  assert.deepStrictEqual(V.chunkPlan(500), [[0, 500]]);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('chunkPlan：501 开始第二片，最后一片可以不满', () => {
  assert.deepStrictEqual(V.chunkPlan(501), [[0, 500], [500, 501]]);
  assert.deepStrictEqual(V.chunkPlan(999), [[0, 500], [500, 999]]);
  assert.deepStrictEqual(V.chunkPlan(1000), [[0, 500], [500, 1000]]);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('chunkPlan：5200 项得到 11 片，首尾相接无重叠', () => {
  const plan = V.chunkPlan(5200);
  assert.strictEqual(plan.length, 11);
  assert.deepStrictEqual(plan[0], [0, 500]);
  assert.deepStrictEqual(plan[10], [5000, 5200]);
  for (let i = 1; i < plan.length; i++) {
    assert.strictEqual(plan[i][0], plan[i - 1][1], '第 ' + i + ' 片与上一片不相接');
  }
  assert.strictEqual(plan[plan.length - 1][1], 5200);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('chunkPlan：每片都是 [start, end) 且长度不超过 500', () => {
  for (const total of [1, 2, 499, 500, 501, 1234, 5000, 10001]) {
    const plan = V.chunkPlan(total);
    let covered = 0;
    for (const piece of plan) {
      assert.ok(piece[1] > piece[0], total + ' 出现空片');
      assert.ok(piece[1] - piece[0] <= 500, total + ' 出现超长片');
      covered += piece[1] - piece[0];
    }
    assert.strictEqual(covered, total, total + ' 覆盖条数不等于总数');
  }
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('chunkPlan：NaN / 负数都得到空计划（⛔ 不抛）', () => {
  // ⚠️ 疑似缺陷：负数会被静默当成"空层"，调用方分不清"没有"与"参数坏了"。
  assert.deepStrictEqual(V.chunkPlan(NaN), []);
  assert.deepStrictEqual(V.chunkPlan(-5), []);
});

// ── 版本回滚的组合场景 ───────────────────────────────────────────

// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
test('连点 A→B：B 的回包可提交，A 的迟到回包被 req 拒', () => {
  const current = { generation: 4, latestReq: 2 };
  assert.deepStrictEqual(V.docCommitDecision({ gen: 4, req: 2 }, current), { commit: true, reason: null });
  assert.deepStrictEqual(V.docCommitDecision({ gen: 4, req: 1 }, current), { commit: false, reason: 'req' });
});

// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
test('切换根之后：旧代次的回包一律被 gen 拒，哪怕 req 正好相等', () => {
  const current = { generation: 8, latestReq: 3 };
  assert.deepStrictEqual(V.docCommitDecision({ gen: 7, req: 3 }, current).reason, 'gen');
});

// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
test('同一请求号但代次对不上：不能靠 req 相等蒙混', () => {
  const current = { generation: 2, latestReq: 10 };
  assert.deepStrictEqual(V.docCommitDecision({ gen: 1, req: 10 }, current), { commit: false, reason: 'gen' });
});
