// versions 的自动化用例（`tests/auto/js/services-b/`）。
//
// 覆盖：版本对提取（只留 gen/req）、提交判据（先 gen 后 req）、§2.1.4 第 ③ 步触发、
// 目录层级上限、首批大小与分片计划。⛔ 这里不碰 DOM / Tauri / 定时器。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadVersions() {
  const win = {};
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'versions.js'), 'utf8');
  new Function('window', src)(win);
  return win.rmd.versions;
}

const V = loadVersions();

test('versionOf：只提取 gen / req，不带其它字段', () => {
  assert.deepStrictEqual(V.versionOf({ gen: 3, req: 7, extra: 'x' }), { gen: 3, req: 7 });
});

test('versionOf：字段缺失时原样保留 undefined', () => {
  assert.deepStrictEqual(V.versionOf({}), { gen: undefined, req: undefined });
});

test('staleReason：代次不符返回 gen', () => {
  assert.strictEqual(V.staleReason({ gen: 2, req: 7 }, { generation: 1, latestReq: 7 }), 'gen');
});

test('staleReason：代次相同、请求号不符返回 req', () => {
  assert.strictEqual(V.staleReason({ gen: 1, req: 6 }, { generation: 1, latestReq: 7 }), 'req');
});

test('staleReason：两者都不符时先报 gen（判据有固定顺序）', () => {
  assert.strictEqual(V.staleReason({ gen: 2, req: 6 }, { generation: 1, latestReq: 7 }), 'gen');
});

test('staleReason：完全一致才返回 null', () => {
  assert.strictEqual(V.staleReason({ gen: 1, req: 7 }, { generation: 1, latestReq: 7 }), null);
});

test('docCommitDecision：过期响应不提交并带原因', () => {
  assert.deepStrictEqual(
    V.docCommitDecision({ gen: 1, req: 6 }, { generation: 1, latestReq: 7 }),
    { commit: false, reason: 'req' }
  );
});

test('docCommitDecision：一致时提交且 reason 为 null', () => {
  assert.deepStrictEqual(
    V.docCommitDecision({ gen: 2, req: 9 }, { generation: 2, latestReq: 9 }),
    { commit: true, reason: null }
  );
});

test('step3Needed：roots 非空与文档在 root 之外两个条件缺一不可', () => {
  assert.strictEqual(V.step3Needed({ roots_nonempty: true, outside_roots: true }), true);
  assert.strictEqual(V.step3Needed({ roots_nonempty: true, outside_roots: false }), false);
  assert.strictEqual(V.step3Needed({ roots_nonempty: false, outside_roots: true }), false);
  assert.strictEqual(V.step3Needed({}), false);
});

test('MAX_DEPTH 是 32，第 0–31 层可展开、32 层起不行', () => {
  assert.strictEqual(V.MAX_DEPTH, 32);
  assert.strictEqual(V.depthAllowed(0), true);
  assert.strictEqual(V.depthAllowed(31), true);
  assert.strictEqual(V.depthAllowed(32), false);
  assert.strictEqual(V.depthAllowed(33), false);
});

test('分片阈值：首批 500、步长 500', () => {
  assert.strictEqual(V.CHUNK_FIRST, 500);
  assert.strictEqual(V.CHUNK_STEP, 500);
});

test('firstChunkSize：不足 500 全给，够多才封顶', () => {
  assert.strictEqual(V.firstChunkSize(0), 0);
  assert.strictEqual(V.firstChunkSize(100), 100);
  assert.strictEqual(V.firstChunkSize(500), 500);
  assert.strictEqual(V.firstChunkSize(501), 500);
  assert.strictEqual(V.firstChunkSize(5000), 500);
});

test('chunkPlan：0 项没有分片', () => {
  assert.deepStrictEqual(V.chunkPlan(0), []);
});

test('chunkPlan：整百边界不产生空尾片', () => {
  assert.deepStrictEqual(V.chunkPlan(500), [[0, 500]]);
  assert.deepStrictEqual(V.chunkPlan(1000), [[0, 500], [500, 1000]]);
});

test('chunkPlan：最后一片可以不满，且区间半开', () => {
  assert.deepStrictEqual(V.chunkPlan(501), [[0, 500], [500, 501]]);
  assert.deepStrictEqual(V.chunkPlan(1201), [[0, 500], [500, 1000], [1000, 1201]]);
});

test('chunkPlan：分片连续且覆盖 [0,total)', () => {
  const total = 1733;
  const plan = V.chunkPlan(total);
  assert.strictEqual(plan[0][0], 0);
  assert.strictEqual(plan[plan.length - 1][1], total);
  for (let i = 1; i < plan.length; i++) {
    assert.strictEqual(plan[i][0], plan[i - 1][1], '第 ' + i + ' 片没有接上前一片');
  }
  for (const seg of plan) assert.ok(seg[1] > seg[0], '出现空分片：' + seg);
});

test('双导出：浏览器挂到 window.rmd.versions', () => {
  const win = {};
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'versions.js'), 'utf8');
  new Function('window', src)(win);
  assert.strictEqual(typeof win.rmd.versions.staleReason, 'function');
});
