// progress 的自动化用例（`tests/auto/js/services-b/`）。
//
// 覆盖：锚点 ↔ 落盘条目的形状与清洗、±8 px / ±0.5% 的“同一位置”判据、
// 恢复三态、写盘频控与失败重试、迟到校正的六道闸、keepScroll 的同族闸，
// 以及后端回包并入运行期表（含 evicted 消费）。
// ⚠️ 本模块无状态、无 DOM、无 timers，用例直接调纯函数。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadProgress() {
  const win = {};
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'progress.js'), 'utf8');
  new Function('window', src)(win);
  return win.rmd.progress;
}

const P = loadProgress();

test('频控常量：停止滚动 1500 ms 后写、两次写至少隔 2000 ms', () => {
  assert.strictEqual(P.SAVE_IDLE_MS, 1500);
  assert.strictEqual(P.MIN_INTERVAL_MS, 2000);
});

test('判据常量：平移 8 px、比例 0.5%、id 上限 256 字符', () => {
  assert.strictEqual(P.OFFSET_EPS, 8);
  assert.strictEqual(P.RATIO_EPS, 0.005);
  assert.strictEqual(P.MAX_ID_CHARS, 256);
});

test('usable：既没有合法 id 也没有有限 ratio 的条目一律不可用', () => {
  assert.strictEqual(P.usable(null), false);
  assert.strictEqual(P.usable(undefined), false);
  assert.strictEqual(P.usable({}), false);
  assert.strictEqual(P.usable({ id: '' }), false);
  assert.strictEqual(P.usable({ id: 123 }), false);
  assert.strictEqual(P.usable({ id: 'h' }), true);
  assert.strictEqual(P.usable({ ratio: 0 }), true);
  assert.strictEqual(P.usable({ ratio: NaN }), false);
});

test('usable：id 按码点数，256 个 emoji 仍然合法', () => {
  assert.strictEqual(P.usable({ id: '😀'.repeat(256) }), true);
  assert.strictEqual(P.usable({ id: '😀'.repeat(257) }), false);
  assert.strictEqual(P.usable({ id: 'x'.repeat(256) }), true);
  assert.strictEqual(P.usable({ id: 'x'.repeat(257) }), false);
});

test('toEntry：null / 空锚点不写记录', () => {
  assert.strictEqual(P.toEntry(null, 0), null);
  assert.strictEqual(P.toEntry({}, 0), null);
  assert.strictEqual(P.toEntry({ id: '', ratio: NaN }, 0), null);
});

test('toEntry：ratio 夹到 [0,1] 并保留 6 位，offset 非负并保留 1 位', () => {
  const e = P.toEntry({ id: 'h', offset: -5, ratio: 1.5 }, 100);
  assert.strictEqual(e.ratio, 1);
  assert.strictEqual(e.offset, 0);
  assert.strictEqual(P.toEntry({ id: 'h', offset: 12.36, ratio: -1 }, 0).offset, 12.4);
  assert.strictEqual(P.toEntry({ id: 'h', offset: 0, ratio: -1 }, 0).ratio, 0);
  assert.strictEqual(P.toEntry({ id: 'h', offset: 0, ratio: 0.123456789 }, 0).ratio, 0.123457);
});

test('toEntry：source_bytes 向下取整，负数与非法值写 0', () => {
  assert.strictEqual(P.toEntry({ id: 'h' }, 1234.9).source_bytes, 1234);
  assert.strictEqual(P.toEntry({ id: 'h' }, -3).source_bytes, 0);
  assert.strictEqual(P.toEntry({ id: 'h' }, NaN).source_bytes, 0);
  assert.strictEqual(P.toEntry({ id: 'h' }, '100').source_bytes, 0);
});

test('toEntry：超长 id 被整个丢掉，但 ratio 仍可独立成立', () => {
  const long = 'x'.repeat(257);
  const e = P.toEntry({ id: long, ratio: 0.25 }, 0);
  assert.strictEqual(e.id, null);
  assert.strictEqual(e.ratio, 0.25);
});

test('toAnchor：不可用条目返回 null', () => {
  assert.strictEqual(P.toAnchor(null), null);
  assert.strictEqual(P.toAnchor({}), null);
  assert.strictEqual(P.toAnchor({ id: 'x'.repeat(257) }), null);
});

test('toAnchor：形状转换并夹取比例，缺失 offset 记 0', () => {
  const a = P.toAnchor({ id: 'h', offset: -5, ratio: 2 });
  assert.deepStrictEqual(a, { id: 'h', offset: 0, ratio: 1 });
  assert.deepStrictEqual(P.toAnchor({ id: 'h' }), { id: 'h', offset: 0, ratio: null });
  assert.deepStrictEqual(P.toAnchor({ ratio: 0.5 }), { id: null, offset: 0, ratio: 0.5 });
  assert.strictEqual(P.toAnchor({ ratio: -1 }).ratio, 0);
});

test('same：id 不同直接不同', () => {
  assert.strictEqual(P.same(null, { id: 'a' }), false);
  assert.strictEqual(P.same({ id: 'a' }, null), false);
  assert.strictEqual(P.same({ id: 'a' }, { id: 'b' }), false);
  assert.strictEqual(P.same({ id: 'a' }, { id: 'a' }), true);
});

test('same：平移差 8 px 分界：<8 同、>=8 不同', () => {
  assert.strictEqual(P.same({ id: 'a', offset: 10 }, { id: 'a', offset: 17.9 }), true);
  assert.strictEqual(P.same({ id: 'a', offset: 10 }, { id: 'a', offset: 18 }), false);
});

test('same：比例都没有时只看平移；只有一边有比例则不同', () => {
  assert.strictEqual(P.same({ id: 'a' }, { id: 'a' }), true);
  assert.strictEqual(P.same({ id: 'a' }, { id: 'a', ratio: 0.5 }), false);
  assert.strictEqual(P.same({ id: 'a', ratio: 0.5 }, { id: 'a' }), false);
});

test('same：比例差 0.5% 分界：<0.5% 同、>=0.5% 不同', () => {
  assert.strictEqual(P.same({ id: 'a', ratio: 0.5 }, { id: 'a', ratio: 0.504 }), true);
  assert.strictEqual(P.same({ id: 'a', ratio: 0.5 }, { id: 'a', ratio: 0.505 }), false);
});

test('restorePlan：条目不可用 skip，否则按能不能滚给 apply/defer', () => {
  assert.strictEqual(P.restorePlan(null, true), 'skip');
  assert.strictEqual(P.restorePlan({}, true), 'skip');
  assert.strictEqual(P.restorePlan({ id: 'a' }, true), 'apply');
  assert.strictEqual(P.restorePlan({ id: 'a' }, false), 'defer');
});

test('planSave：没有新位置时什么都不做，force 也不例外', () => {
  assert.deepStrictEqual(P.planSave(null, null, 0, false), { action: 'skip', waitMs: 0 });
  assert.deepStrictEqual(P.planSave(null, null, 0, true), { action: 'skip', waitMs: 0 });
});

test('planSave：force 无视间隔立刻写', () => {
  const last = { entry: { id: 'a' }, persisted: true };
  assert.deepStrictEqual(P.planSave(last, { id: 'a' }, 1, true), { action: 'save', waitMs: 0 });
});

test('planSave：已确认落盘的同值不再写', () => {
  const last = { entry: { id: 'a' }, persisted: true };
  assert.deepStrictEqual(P.planSave(last, { id: 'a' }, 99999, false), { action: 'skip', waitMs: 0 });
});

test('planSave：上次写失败（persisted=false）时同值也允许按间隔重试', () => {
  const last = { entry: { id: 'a' }, persisted: false };
  assert.deepStrictEqual(P.planSave(last, { id: 'a' }, 2500, false), { action: 'save', waitMs: 0 });
  assert.deepStrictEqual(P.planSave(last, { id: 'a' }, 1000, false), { action: 'wait', waitMs: 1000 });
});

test('planSave：没有基线时立刻写（间隔只约束同一路径的后续写）', () => {
  assert.deepStrictEqual(P.planSave(null, { id: 'a' }, 1500, false), { action: 'save', waitMs: 0 });
  assert.deepStrictEqual(P.planSave(null, { id: 'a' }, 0, false), { action: 'save', waitMs: 0 });
});

test('planSave：间隔不足时返回还差多少毫秒', () => {
  const last = { entry: { id: 'other' }, persisted: true };
  assert.deepStrictEqual(P.planSave(last, { id: 'a' }, 1500, false), { action: 'wait', waitMs: 500 });
  assert.deepStrictEqual(P.planSave(last, { id: 'a' }, 0, false), { action: 'wait', waitMs: 2000 });
});

test('planSave：负数 / 非有限间隔按 0 处理', () => {
  const last = { entry: { id: 'other' }, persisted: true };
  assert.deepStrictEqual(P.planSave(last, { id: 'a' }, -500, false), { action: 'wait', waitMs: 2000 });
  assert.deepStrictEqual(P.planSave(last, { id: 'a' }, NaN, false), { action: 'wait', waitMs: 2000 });
});

test('planSave：间隔够了就写', () => {
  const last = { entry: { id: 'other' }, persisted: true };
  assert.deepStrictEqual(P.planSave(last, { id: 'a' }, 2000, false), { action: 'save', waitMs: 0 });
});

function pending(over) {
  return Object.assign({ mountGen: 1, path: '/a.md', docSeq: 2, expires: 1000 }, over || {});
}

test('shouldCorrect：六个条件全满足才校正', () => {
  assert.strictEqual(
    P.shouldCorrect(pending(), 1, '/a.md', 2, false, false, 500),
    true
  );
});

test('shouldCorrect：没有待校正记录 / 用户已接管 / 用户已中止都不校正', () => {
  assert.strictEqual(P.shouldCorrect(null, 1, '/a.md', 2, false, false, 0), false);
  assert.strictEqual(P.shouldCorrect(pending(), 1, '/a.md', 2, false, true, 0), false);
  assert.strictEqual(P.shouldCorrect(pending({ userAborted: true }), 1, '/a.md', 2, false, false, 0), false);
});

test('shouldCorrect：挂载代号、路径、会话号任一不符都不校正', () => {
  assert.strictEqual(P.shouldCorrect(pending(), 9, '/a.md', 2, false, false, 0), false);
  assert.strictEqual(P.shouldCorrect(pending(), 1, '/b.md', 2, false, false, 0), false);
  assert.strictEqual(P.shouldCorrect(pending(), 1, '/a.md', 9, false, false, 0), false);
});

test('shouldCorrect：编辑态不校正', () => {
  assert.strictEqual(P.shouldCorrect(pending(), 1, '/a.md', 2, true, false, 0), false);
});

test('shouldCorrect：过期边界——等于 expires 仍算有效，超过才失效', () => {
  assert.strictEqual(P.shouldCorrect(pending(), 1, '/a.md', 2, false, false, 1000), true);
  assert.strictEqual(P.shouldCorrect(pending(), 1, '/a.md', 2, false, false, 1001), false);
  assert.strictEqual(P.shouldCorrect(pending({ expires: undefined }), 1, '/a.md', 2, false, false, 1e12), true);
});

test('shouldFixKeepScroll：不排除编辑态与会话号，其余闸照旧', () => {
  const p = { mountGen: 1, path: '/a.md', expires: 1000 };
  assert.strictEqual(P.shouldFixKeepScroll(p, 1, '/a.md', 500), true);
  assert.strictEqual(P.shouldFixKeepScroll(null, 1, '/a.md', 0), false);
  assert.strictEqual(P.shouldFixKeepScroll({ userAborted: true, mountGen: 1, path: '/a.md' }, 1, '/a.md', 0), false);
  assert.strictEqual(P.shouldFixKeepScroll(p, 2, '/a.md', 0), false);
  assert.strictEqual(P.shouldFixKeepScroll(p, 1, '/b.md', 0), false);
  assert.strictEqual(P.shouldFixKeepScroll(p, 1, '/a.md', 1001), false);
});

test('mergeWrite：写入路径并把后端淘汰的路径删掉，返回删除条数', () => {
  const table = { '/a.md': { id: 'a' }, '/b.md': { id: 'b' } };
  const removed = P.mergeWrite(table, '/c.md', { id: 'c' }, ['/b.md', '/not-there.md']);
  assert.strictEqual(removed, 1);
  assert.deepStrictEqual(table, { '/a.md': { id: 'a' }, '/c.md': { id: 'c' } });
});

test('mergeWrite：幂等——同一份回包并第二次删 0 条', () => {
  const table = { '/a.md': { id: 'a' } };
  assert.strictEqual(P.mergeWrite(table, '/b.md', { id: 'b' }, ['/a.md']), 1);
  assert.strictEqual(P.mergeWrite(table, '/b.md', { id: 'b' }, ['/a.md']), 0);
  assert.deepStrictEqual(table, { '/b.md': { id: 'b' } });
});

test('mergeWrite：没有 entry 时不写入；evicted 非数组时忽略', () => {
  const table = {};
  P.mergeWrite(table, '/a.md', null, ['/b.md']);
  assert.deepStrictEqual(table, {});
  P.mergeWrite(table, '/a.md', { id: 'a' }, 'not-an-array');
  assert.deepStrictEqual(table, { '/a.md': { id: 'a' } });
});

test('mergeWrite：table 缺失时安静返回 0', () => {
  assert.strictEqual(P.mergeWrite(null, '/a.md', { id: 'a' }, ['/b.md']), 0);
});
