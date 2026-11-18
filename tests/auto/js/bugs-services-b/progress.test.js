// progress 的缺陷回归用例（`tests/auto/js/bugs-services-b/`）。
//
// 覆盖：进度条目的形状转换、标题 id 长度上限（按码点）、
// 频控（2s 间隔 / 8px / 0.5%）、迟到回调的六道闸、以及写回后的表合并。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'progress.js'), 'utf8');

function loadProgress() {
  const win = {};
  new Function('window', SRC)(win);
  return win.rmd.progress;
}

const P = loadProgress();

// ── 常量 ────────────────────────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('频控与上限常量逐字锁死', () => {
  assert.strictEqual(P.SAVE_IDLE_MS, 1500);
  assert.strictEqual(P.MIN_INTERVAL_MS, 2000);
  assert.strictEqual(P.OFFSET_EPS, 8);
  assert.strictEqual(P.RATIO_EPS, 0.005);
  assert.strictEqual(P.MAX_ID_CHARS, 256);
});

// ── usable：一条记录有没有可用信息 ─────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('usable：null / 空 id / 非法 ratio 都算不可用', () => {
  assert.strictEqual(P.usable(null), false);
  assert.strictEqual(P.usable(undefined), false);
  assert.strictEqual(P.usable({}), false);
  assert.strictEqual(P.usable({ id: '' }), false);
  assert.strictEqual(P.usable({ id: 123 }), false);
  assert.strictEqual(P.usable({ ratio: NaN }), false);
  assert.strictEqual(P.usable({ ratio: '0.5' }), false);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('usable：只有 offset 不算可用（offset 依附于 id 或 ratio）', () => {
  assert.strictEqual(P.usable({ offset: 100 }), false);
  assert.strictEqual(P.usable({ id: 'h1', offset: 100 }), true);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('usable：ratio 为 0 是合法位置', () => {
  assert.strictEqual(P.usable({ ratio: 0 }), true);
});

// ── id 长度：按码点，超长整条丢弃 ─────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('id 恰好 256 个字符保留，257 个整条丢弃（⛔ 不截前缀）', () => {
  const ok = 'a'.repeat(256);
  const tooLong = 'a'.repeat(257);
  assert.strictEqual(P.toEntry({ id: ok, ratio: 0.5 }, 10).id, ok);
  assert.strictEqual(P.toEntry({ id: tooLong, ratio: 0.5 }, 10).id, null);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('id 长度按 Unicode 码点算：256 个 emoji 合法（⛔ 不按 UTF-16 长度）', () => {
  const ok = '😀'.repeat(256); // length=512，码点=256
  const bad = '😀'.repeat(257);
  assert.strictEqual(P.toEntry({ id: ok, ratio: 0.5 }, 0).id, ok);
  assert.strictEqual(P.toEntry({ id: bad, ratio: 0.5 }, 0).id, null);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('超长 id 被丢时 ratio 仍然保留：位置还能按比例恢复', () => {
  const e = P.toEntry({ id: 'x'.repeat(300), ratio: 0.25 }, 0);
  assert.strictEqual(e.id, null);
  assert.strictEqual(e.ratio, 0.25);
});

// ── toEntry：落盘形状 ──────────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('toEntry：null 或既无 id 又无 ratio ⇒ null，⛔ 不写空记录', () => {
  assert.strictEqual(P.toEntry(null, 100), null);
  assert.strictEqual(P.toEntry({}, 100), null);
  assert.strictEqual(P.toEntry({ offset: 50 }, 100), null);
  assert.strictEqual(P.toEntry({ id: '', ratio: NaN }, 100), null);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('toEntry：ratio 夹到 [0,1] 并保留 6 位小数', () => {
  assert.strictEqual(P.toEntry({ ratio: 1.5 }, 0).ratio, 1);
  assert.strictEqual(P.toEntry({ ratio: -0.2 }, 0).ratio, 0);
  assert.strictEqual(P.toEntry({ ratio: 0.123456789 }, 0).ratio, 0.123457);
  assert.strictEqual(P.toEntry({ ratio: 0.1 + 0.2 }, 0).ratio, 0.3);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('toEntry：offset 负值归零、保留 1 位小数、非数字归零', () => {
  assert.strictEqual(P.toEntry({ id: 'h', offset: -5 }, 0).offset, 0);
  assert.strictEqual(P.toEntry({ id: 'h', offset: 12.345 }, 0).offset, 12.3);
  assert.strictEqual(P.toEntry({ id: 'h', offset: NaN }, 0).offset, 0);
  assert.strictEqual(P.toEntry({ id: 'h' }, 0).offset, 0);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('toEntry：source_bytes 向下取整，负数 / 非数字归零', () => {
  assert.strictEqual(P.toEntry({ id: 'h' }, 123.9).source_bytes, 123);
  assert.strictEqual(P.toEntry({ id: 'h' }, 0).source_bytes, 0);
  assert.strictEqual(P.toEntry({ id: 'h' }, -1).source_bytes, 0);
  assert.strictEqual(P.toEntry({ id: 'h' }, NaN).source_bytes, 0);
  assert.strictEqual(P.toEntry({ id: 'h' }, '10').source_bytes, 0);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('toEntry：ratio 为 0 与 id 同时在时都保留（0 不被当成缺省）', () => {
  const e = P.toEntry({ id: 'top', ratio: 0, offset: 0 }, 5);
  assert.strictEqual(e.id, 'top');
  assert.strictEqual(e.ratio, 0);
  assert.strictEqual(e.offset, 0);
});

// ── toAnchor：回读形状 ─────────────────────────────────────────────

// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
test('toAnchor：不可用条目返回 null', () => {
  assert.strictEqual(P.toAnchor(null), null);
  assert.strictEqual(P.toAnchor({}), null);
  assert.strictEqual(P.toAnchor({ id: 'x'.repeat(300) }), null);
});

// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
test('toAnchor：ratio 夹到 [0,1]，offset 负值归零，id 超长被丢', () => {
  assert.strictEqual(P.toAnchor({ ratio: 2 }).ratio, 1);
  assert.strictEqual(P.toAnchor({ ratio: -1 }).ratio, 0);
  assert.strictEqual(P.toAnchor({ id: 'h', offset: -30 }).offset, 0);
  assert.strictEqual(P.toAnchor({ id: 'x'.repeat(300), ratio: 0.5 }).id, null);
});

// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
test('toAnchor：没有 ratio 时给 null，而不是 0', () => {
  assert.strictEqual(P.toAnchor({ id: 'h' }).ratio, null);
  assert.strictEqual(P.toAnchor({ id: 'h', ratio: NaN }).ratio, null);
});

// ── same：位置是否相同（不使用像素接近判"用户没动过"）──────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('same：任一为空都是 false', () => {
  assert.strictEqual(P.same(null, { id: 'h' }), false);
  assert.strictEqual(P.same({ id: 'h' }, null), false);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('same：id 不同就不是同一位置，哪怕偏移一样', () => {
  assert.strictEqual(P.same({ id: 'a', offset: 0 }, { id: 'b', offset: 0 }), false);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('same：偏移差 < 8px 算相同，恰为 8px 算不同', () => {
  assert.strictEqual(P.same({ id: 'h', offset: 100 }, { id: 'h', offset: 107.9 }), true);
  assert.strictEqual(P.same({ id: 'h', offset: 100 }, { id: 'h', offset: 108 }), false);
  assert.strictEqual(P.same({ id: 'h', offset: 108 }, { id: 'h', offset: 100 }), false);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('same：比例差 < 0.5% 算相同，恰为 0.5% 算不同', () => {
  assert.strictEqual(P.same({ ratio: 0.5 }, { ratio: 0.5049 }), true);
  assert.strictEqual(P.same({ ratio: 0.5 }, { ratio: 0.505 }), false);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('same：两边都没有比例时只看 id 与偏移', () => {
  assert.strictEqual(P.same({ id: 'h', offset: 10 }, { id: 'h', offset: 12 }), true);
  assert.strictEqual(P.same({ id: 'h', offset: 10 }, { id: 'h', offset: 20 }), false);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('same：一边有比例一边没有 ⇒ 不同（不能靠比例缺省蒙混）', () => {
  assert.strictEqual(P.same({ id: 'h', offset: 0, ratio: 0.5 }, { id: 'h', offset: 0 }), false);
  assert.strictEqual(P.same({ id: 'h', offset: 0 }, { id: 'h', offset: 0, ratio: 0.5 }), false);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('same：非有限的 offset / ratio 各自按 0 / null 处理', () => {
  assert.strictEqual(P.same({ id: 'h', offset: NaN }, { id: 'h', offset: 0 }), true);
  assert.strictEqual(P.same({ id: 'h', ratio: NaN }, { id: 'h', ratio: undefined }), true);
});

// ── restorePlan：挂载后该不该恢复 ─────────────────────────────────

// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
test('restorePlan：不可用条目 skip，可滚就 apply', () => {
  assert.strictEqual(P.restorePlan(null, true), 'skip');
  assert.strictEqual(P.restorePlan({}, true), 'skip');
  assert.strictEqual(P.restorePlan({ ratio: 0.2 }, true), 'apply');
  assert.strictEqual(P.restorePlan({ id: 'h' }, true), 'apply');
});

// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
test('restorePlan：当前滚不动时 defer（意图保留，⛔ 不 skip）', () => {
  assert.strictEqual(P.restorePlan({ ratio: 0.2 }, false), 'defer');
  assert.strictEqual(P.restorePlan({ ratio: 0.2 }, 0), 'defer');
});

// ── planSave：写盘频控 ─────────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('planSave：没有捕获到位置 ⇒ skip', () => {
  assert.deepStrictEqual(P.planSave(null, null, 99999, false), { action: 'skip', waitMs: 0 });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('planSave：force 直接 save，无视间隔与"值没变"', () => {
  const last = { entry: { id: 'h', offset: 0 }, persisted: true };
  assert.deepStrictEqual(
    P.planSave(last, { id: 'h', offset: 0 }, 0, true),
    { action: 'save', waitMs: 0 }
  );
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('planSave：间隔不足时 wait，waitMs 补到 2000', () => {
  const last = { entry: { id: 'a', offset: 0 }, persisted: true };
  assert.deepStrictEqual(
    P.planSave(last, { id: 'b', offset: 0 }, 500, false),
    { action: 'wait', waitMs: 1500 }
  );
  assert.deepStrictEqual(
    P.planSave(last, { id: 'b', offset: 0 }, 1999, false),
    { action: 'wait', waitMs: 1 }
  );
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('planSave：间隔满 2000 就 save；负数 / 非有限按 0 算', () => {
  const last = { entry: { id: 'a', offset: 0 }, persisted: true };
  assert.deepStrictEqual(P.planSave(last, { id: 'b' }, 2000, false), { action: 'save', waitMs: 0 });
  assert.deepStrictEqual(
    P.planSave(last, { id: 'b' }, -500, false),
    { action: 'wait', waitMs: 2000 }
  );
  assert.deepStrictEqual(
    P.planSave(last, { id: 'b' }, NaN, false),
    { action: 'wait', waitMs: 2000 }
  );
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('planSave：同值且已确认落盘 ⇒ skip（不做无意义写盘）', () => {
  const last = { entry: { id: 'h', offset: 100, ratio: 0.5 }, persisted: true };
  assert.deepStrictEqual(
    P.planSave(last, { id: 'h', offset: 104, ratio: 0.502 }, 99999, false),
    { action: 'skip', waitMs: 0 }
  );
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('planSave：同值但上次 persist_failed ⇒ 允许按间隔重试，⛔ 不永久放弃', () => {
  const last = { entry: { id: 'h', offset: 100 }, persisted: false };
  assert.deepStrictEqual(
    P.planSave(last, { id: 'h', offset: 100 }, 2500, false),
    { action: 'save', waitMs: 0 }
  );
  assert.deepStrictEqual(
    P.planSave(last, { id: 'h', offset: 100 }, 100, false),
    { action: 'wait', waitMs: 1900 }
  );
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('planSave：首次写没有基线 ⇒ 立即 save', () => {
  assert.deepStrictEqual(P.planSave(null, { id: 'h' }, 0, false), { action: 'save', waitMs: 0 });
});

// ── shouldCorrect：迟到回调的六道闸 ───────────────────────────────

function pending(over) {
  return Object.assign({
    mountGen: 3, path: '/docs/a.md', docSeq: 7, expires: 2000, userAborted: false,
  }, over || {});
}

// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
test('shouldCorrect：全部条件满足才校正', () => {
  assert.strictEqual(P.shouldCorrect(pending(), 3, '/docs/a.md', 7, false, false, 1000), true);
});

// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
test('shouldCorrect：没有 pending / 用户已接管 / 用户中断都拒绝', () => {
  assert.strictEqual(P.shouldCorrect(null, 3, '/docs/a.md', 7, false, false, 1000), false);
  assert.strictEqual(P.shouldCorrect(pending(), 3, '/docs/a.md', 7, false, true, 1000), false);
  assert.strictEqual(P.shouldCorrect(pending({ userAborted: true }), 3, '/docs/a.md', 7, false, false, 1000), false);
});

// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
test('shouldCorrect：换文档 / 换路径 / 换会话号都拒绝（迟到回调不许动新正文）', () => {
  assert.strictEqual(P.shouldCorrect(pending(), 4, '/docs/a.md', 7, false, false, 1000), false);
  assert.strictEqual(P.shouldCorrect(pending(), 3, '/docs/b.md', 7, false, false, 1000), false);
  assert.strictEqual(P.shouldCorrect(pending(), 3, '/docs/a.md', 8, false, false, 1000), false);
});

// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
test('shouldCorrect：编辑态不校正（预览栏自己滚）', () => {
  assert.strictEqual(P.shouldCorrect(pending(), 3, '/docs/a.md', 7, true, false, 1000), false);
  assert.strictEqual(P.shouldCorrect(pending(), 3, '/docs/a.md', 7, false, false, 1000), true);
});

// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
test('shouldCorrect：过期判据是严格大于，等于 expires 仍有效', () => {
  assert.strictEqual(P.shouldCorrect(pending({ expires: 1000 }), 3, '/docs/a.md', 7, false, false, 1000), true);
  assert.strictEqual(P.shouldCorrect(pending({ expires: 1000 }), 3, '/docs/a.md', 7, false, false, 1001), false);
});

// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
test('shouldCorrect：expires 非有限时视为不过期', () => {
  assert.strictEqual(P.shouldCorrect(pending({ expires: Infinity }), 3, '/docs/a.md', 7, false, false, 1e9), true);
  assert.strictEqual(P.shouldCorrect(pending({ expires: 'soon' }), 3, '/docs/a.md', 7, false, false, 1e9), true);
});

// ── shouldFixKeepScroll：keepScroll 重渲的落定校正 ─────────────────

// 源自 docs/bugs/0077（勾选任务项后正文往上跳）
test('shouldFixKeepScroll：编辑态也允许校正（这条路预览栏自己在滚）', () => {
  const p = { mountGen: 3, path: '/docs/a.md', expires: 5000, userAborted: false };
  assert.strictEqual(P.shouldFixKeepScroll(p, 3, '/docs/a.md', 1000), true);
});

// 源自 docs/bugs/0077（勾选任务项后正文往上跳）
test('shouldFixKeepScroll：换文档 / 换路径 / 用户中断 / 过期都拒绝', () => {
  const p = { mountGen: 3, path: '/docs/a.md', expires: 5000 };
  assert.strictEqual(P.shouldFixKeepScroll(null, 3, '/docs/a.md', 1000), false);
  assert.strictEqual(P.shouldFixKeepScroll(Object.assign({}, p, { userAborted: true }), 3, '/docs/a.md', 1000), false);
  assert.strictEqual(P.shouldFixKeepScroll(p, 4, '/docs/a.md', 1000), false);
  assert.strictEqual(P.shouldFixKeepScroll(p, 3, '/docs/b.md', 1000), false);
  assert.strictEqual(P.shouldFixKeepScroll(p, 3, '/docs/a.md', 5001), false);
});

// 源自 docs/bugs/0077（勾选任务项后正文往上跳）
test('shouldFixKeepScroll：没有 expires 字段时不过期，等于 expires 仍有效', () => {
  assert.strictEqual(P.shouldFixKeepScroll({ mountGen: 1, path: 'p' }, 1, 'p', 1e12), true);
  assert.strictEqual(P.shouldFixKeepScroll({ mountGen: 1, path: 'p', expires: 10 }, 1, 'p', 10), true);
});

// ── mergeWrite：后端规范化结果并回运行期表 ────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('mergeWrite：写入条目并消费 evicted，返回真正删掉的条数', () => {
  const table = { '/a': { id: 'a' }, '/b': { id: 'b' } };
  const removed = P.mergeWrite(table, '/c', { id: 'c' }, ['/a', '/not-there']);
  assert.strictEqual(removed, 1);
  assert.deepStrictEqual(table, { '/b': { id: 'b' }, '/c': { id: 'c' } });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('mergeWrite：同一路径同时出现在 entry 与 evicted 时，evicted 后手生效', () => {
  const table = {};
  assert.strictEqual(P.mergeWrite(table, '/a', { id: 'a' }, ['/a']), 1);
  assert.deepStrictEqual(table, {}, 'evicted 在写入之后生效，同一路径会被删掉');
  assert.strictEqual(P.mergeWrite(table, '/a', { id: 'a' }, ['/a']), 1);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('mergeWrite：entry 为 null 时不写入，只消费 evicted', () => {
  const table = { '/a': { id: 'a' }, '/b': { id: 'b' } };
  assert.strictEqual(P.mergeWrite(table, '/c', null, ['/b']), 1);
  assert.deepStrictEqual(table, { '/a': { id: 'a' } });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('mergeWrite：table 为空或 evicted 不是数组时安全返回 0', () => {
  assert.strictEqual(P.mergeWrite(null, '/a', { id: 'a' }, ['/a']), 0);
  assert.strictEqual(P.mergeWrite({}, '/a', { id: 'a' }, null), 0);
  assert.strictEqual(P.mergeWrite({}, '/a', { id: 'a' }, 'x'), 0);
  assert.deepStrictEqual(P.mergeWrite({}, '/a', { id: 'a' }, []), 0);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('mergeWrite：evicted 不误删原型链上的同名键', () => {
  const table = Object.create(null);
  table['/real'] = { id: 'real' };
  assert.strictEqual(P.mergeWrite(table, null, null, ['toString', '/real']), 1);
  assert.deepStrictEqual(Object.keys(table), []);
});
