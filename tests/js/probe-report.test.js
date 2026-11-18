// 点击网格扫描的**报告器判据**（`tools/live-probe/clickgrid-summary.py`）。
//
// ⭐ 为什么需要这一条：`tests.md` 明令「要检查报告器本身：真实失败、缺覆盖和异常必须
//    反映到退出码；不能只打印错误却成功退出」。2026-11-04 实测就踩了一次：
//    显示器锁定 ⇒ 探针 `rAF 0/8`、一个点都没跑，而汇总打印「0 个点，0 个红点」并**退 0**
//    ——"没测成"被记成了"全绿"。
// ⚠️ 判据只打 shell 的退出码与那几行输出，⛔ 不跑 swift/探针（几毫秒，可进 `make test-js`）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'tools', 'live-probe', 'clickgrid-summary.py');

/** 把行数组写成临时 jsonl 跑一次汇总，返回 { code, out }。 */
function 跑(rows, toJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sum-'));
  const p = path.join(dir, 'rows.jsonl');
  fs.writeFileSync(p, rows.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n');
  const r = spawnSync('python3', ['-I', SCRIPT, p, toJson ? '1' : '0'], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const 绿点 = { 夹具: 'x', 点: { x: 1, y: 2 }, 命中: 'p', 红: [] };
const 红点 = { 夹具: 'x', 点: { x: 3, y: 4 }, 命中: 'td', 红: ['被点那一块的视口位移 9 px（容差 2）'] };

test('没有红点 ⇒ 退 0，且清点是真点过的那些', function () {
  const r = 跑([绿点, 绿点]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /2 个点，0 个红点/);
});

test('有红点 ⇒ 退 1，并且**打印那条红**（⛔ 不吞）', function () {
  const r = 跑([绿点, 红点]);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /1 个红点/);
  assert.match(r.out, /视口位移 9 px/);
});

test('致命（应用没起来）⇒ 退 1', function () {
  const r = 跑([{ 夹具: 'x', 致命: '应用没启动（等不到 window.__rmd.payload）' }]);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /致命/);
});

test('⭐ 环境无效 ⇒ 退 3（没测成不能冒充全绿）', function () {
  const r = 跑([{ 夹具: 'x', 环境无效: true, 原因: { 帧健康: '0/8' } }]);
  assert.strictEqual(r.code, 3);
  assert.match(r.out, /环境无效/);
  // ⚠️ 分母不许把那一条算成"点过的一个点"
  assert.match(r.out, /0 个点，0 个红点/);
});

test('⭐ 环境无效优先于红点：整轮数字不可信 ⇒ 退 3，⛔ 不退 1', function () {
  const r = 跑([红点, { 夹具: 'y', 环境无效: true, 原因: 'rAF 0/8' }]);
  assert.strictEqual(r.code, 3);
});

test('跳过的点不算红、也不占分母，但**要列出来**', function () {
  const r = 跑([绿点, { 夹具: 'x', 点序号: 7, 跳过: { 状态: '跳过', 原因: '块滚不到视口里' } }]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /1 个点，0 个红点，1 个跳过/);
  assert.match(r.out, /块滚不到视口里/);
});

test('--json 模式打的是**合法 JSON 数组**（能被解析回来）', function () {
  const r = 跑([绿点, 红点], true);
  assert.strictEqual(r.code, 1);
  const back = JSON.parse(r.out);
  assert.strictEqual(back.length, 2);
  assert.deepStrictEqual(back[1].红, 红点.红);
});
