// `design/0003` §7 的 JS 单测之一：**版本比对逻辑**与 §2.1.4 第 ③ 步的触发条件。
//
// ⭐ 为什么这些必须测：`INV-VER-01` 是**唯一**一条"看起来正常的错"型不变量
// （慢的 A 覆盖快的 B、切根后旧分片继续追加）。它在小文件上永远复现不了，
// 只在大文件上偶发，用户的描述通常是"有时候打开的是上一篇"。
// ⇒ 它必须有一份能直跑、不依赖 WebView 的判据，就是这里。
//
// 跑法：`make test-js`（= `node --test tests/js/`）。
// ⚠️ 放在仓库根的 `tests/js/` 而不是 `src/`：`src/` 是 Tauri 的 `frontendDist`，
//    整个目录**会在编译期嵌进二进制**——测试文件不该进产物。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const V = require('../../src/services/versions.js');

// ── 版本比对：四种组合（§7 的「期望：丢弃 / 丢弃 / 丢弃 / 提交」）──
test('版本比对_陈旧代次被丢弃', () => {
  const r = V.docCommitDecision({ gen: 1, req: 7 }, { generation: 2, latestReq: 7 });
  assert.strictEqual(r.commit, false);
  assert.strictEqual(r.reason, 'gen');
});

test('版本比对_陈旧请求被丢弃', () => {
  // ⭐ 这条就是"慢的 A 在快的 B 之后返回"：A 的 req 比最新发出的那个小
  const r = V.docCommitDecision({ gen: 2, req: 3 }, { generation: 2, latestReq: 4 });
  assert.strictEqual(r.commit, false);
  assert.strictEqual(r.reason, 'req');
});

test('版本比对_两者都陈旧也被丢弃', () => {
  const r = V.docCommitDecision({ gen: 1, req: 3 }, { generation: 2, latestReq: 4 });
  assert.strictEqual(r.commit, false);
  assert.strictEqual(r.reason, 'gen'); // 先报代次——它更根本
});

test('版本比对_两者都新才提交', () => {
  const r = V.docCommitDecision({ gen: 2, req: 4 }, { generation: 2, latestReq: 4 });
  assert.strictEqual(r.commit, true);
  assert.strictEqual(r.reason, null);
});

// ── §2.1.4 第 ③ 步的触发条件：三行表格逐行断言 ──
test('第3步_目录模式下打开_root_内的文件_不清根不递增代次', () => {
  assert.strictEqual(V.step3Needed({ roots_nonempty: true, outside_roots: false }), false);
});

test('第3步_目录模式下打开外部文件_触发收回', () => {
  assert.strictEqual(V.step3Needed({ roots_nonempty: true, outside_roots: true }), true);
});

test('第3步_单文件模式的自动重载_不触发_防空转', () => {
  // ⚠️ 这一格**只有在单测里兜得住**：单文件模式下 roots 本来就是空的，
  //    若少了 `roots_nonempty` 这个前提，每一次自动重载都会空转一次代次递增——
  //    不造成错误，但让"代次"这个调试数字没法读，§7 步骤 14–16 的日志判据也失去意义。
  assert.strictEqual(V.step3Needed({ roots_nonempty: false, outside_roots: false }), false);
});

// ── 深度上限（§6：⛔ 不静默截断）──
test('深度上限_32层以内可展开_第32层不可', () => {
  assert.strictEqual(V.MAX_DEPTH, 32);
  assert.strictEqual(V.depthAllowed(0), true);
  assert.strictEqual(V.depthAllowed(31), true);
  assert.strictEqual(V.depthAllowed(32), false);
  assert.strictEqual(V.depthAllowed(99), false);
});

// ── 分片计划（只分**渲染**，⛔ 不分扫描——见 research/notes/0006）──
test('分片计划_不足阈值只有一批', () => {
  assert.deepStrictEqual(V.chunkPlan(120), [[0, 120]]);
  assert.strictEqual(V.firstChunkSize(120), 120);
});

test('分片计划_超过阈值时逐片切到最后一项', () => {
  assert.deepStrictEqual(V.chunkPlan(1200), [[0, 500], [500, 1000], [1000, 1200]]);
  assert.strictEqual(V.firstChunkSize(1200), 500);
});
