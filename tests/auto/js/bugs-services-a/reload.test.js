// 加载面回归：自动重载的四条纯逻辑（`src/services/reload.js`）。
//
// 本族用例从历史缺陷出发，守的是**静默**失败：
//   · `0001` 点击链接让整个应用重载 → 任何不是"这一份文档这一轮监视"的事件都不许生效；
//   · `0067` 正文在打开后被改过却不自动重载 → 同一路径、同一 seq 才是自动重载的入口；
//   · `0006` 重载/提交把阅读位置甩回开头 → 锚点记录与恢复的三级兜底。
// 这些判据坏掉时界面不会报错，只会表现为"白等一遍"或"文档被改了、我看到的是开头"。
//
// ⚠️ 加载方式同 `tests/auto/js/services-a/reload.test.js`：遮蔽 Node 的 `module` / `require`，
//    强制产品文件走 `window` 分支（⛔ 不是 require 产品文件）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'reload.js'), 'utf8');
  const win = {};
  new Function('window', 'module', 'require', src)(win, undefined, undefined);
  return win.rmd.reload;
}

const R = load();
const MiB = 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0001（点击链接导致应用自行重载）
// 变体：导航不是文件变化；迟到 / 陌生事件一律不许触发重载。
// ─────────────────────────────────────────────────────────────────────────

test('0001/导航类事件没有路径与序号，绝不能当成本文档的变化', () => {
  for (const ev of [null, undefined, 'navigate', 42, {}, { path: 'tauri://localhost/x' }]) {
    assert.strictEqual(R.acceptEvent(ev, 1, '/r/a.md'), false, JSON.stringify(ev));
  }
});

test('0001/上一份文档的监视事件不许在新文档上生效（seq 不符）', () => {
  // 换文档后旧监视的迟到事件：seq 是旧的，path 也可能是旧的。
  assert.strictEqual(R.acceptEvent({ path: '/r/a.md', seq: 3 }, 4, '/r/a.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/r/b.md', seq: 4 }, 4, '/r/a.md'), false);
});

test('0001/路径相同但前端还没有监视（seq=0）时，任何事件都不收', () => {
  assert.strictEqual(R.acceptEvent({ path: '/r/a.md', seq: 0 }, 0, '/r/a.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/r/a.md', seq: 1 }, 0, '/r/a.md'), false);
});

test('0001/字符串 seq 与负数 seq 不是有效监视代号', () => {
  assert.strictEqual(R.acceptEvent({ path: '/r/a.md', seq: '4' }, 4, '/r/a.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/r/a.md', seq: -1 }, -1, '/r/a.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/r/a.md', seq: 4 }, '4', '/r/a.md'), false);
});

test('0001/事件少 path 或 path 为空都丢掉，且不抛', () => {
  assert.strictEqual(R.acceptEvent({ seq: 4 }, 4, '/r/a.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '', seq: 4 }, 4, ''), false);
  assert.strictEqual(R.acceptEvent({ path: null, seq: 4 }, 4, null), false);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
// 变体：只有"这一份、这一轮"的事件才是自动重载的合法入口。
// ─────────────────────────────────────────────────────────────────────────

test('0067/同一路径同一 seq 的事件被接受（自动重载的唯一入口）', () => {
  assert.strictEqual(R.acceptEvent({ path: '/笔记/文档.md', seq: 12 }, 12, '/笔记/文档.md'), true);
});

test('0067/中文路径按字符串逐字比对，不做规范化也不做包含判断', () => {
  assert.strictEqual(R.acceptEvent({ path: '/笔记/文档.md', seq: 5 }, 5, '/笔记/文档.md'), true);
  assert.strictEqual(R.acceptEvent({ path: '/笔记/文档.md.bak', seq: 5 }, 5, '/笔记/文档.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/笔记', seq: 5 }, 5, '/笔记/文档.md'), false);
});

test('0067/seq 前进后旧事件被丢，新一轮监视不会重放上一轮', () => {
  assert.strictEqual(R.acceptEvent({ path: '/r/a.md', seq: 9 }, 9, '/r/a.md'), true);
  assert.strictEqual(R.acceptEvent({ path: '/r/a.md', seq: 9 }, 10, '/r/a.md'), false);
});

test('0067/实测很快时自动重载，即便字节数很大也不降级', () => {
  assert.strictEqual(R.autoReloadDecision(120, 10 * MiB), 'auto');
});

test('0067/实测很慢时降级成提示，即便文件很小也不自动', () => {
  assert.strictEqual(R.autoReloadDecision(3000, 1024), 'notice');
});

test('0067/没有实测历史时才用 1 MiB 兜底，边界含 1 MiB', () => {
  assert.strictEqual(R.autoReloadDecision(null, MiB), 'auto');
  assert.strictEqual(R.autoReloadDecision(null, MiB + 1), 'notice');
  assert.strictEqual(R.autoReloadDecision(null, 10 * MiB), 'notice');
});

test('0067/采不到的数不能当成 0：NaN 与字符串都跳过该档', () => {
  assert.strictEqual(R.autoReloadDecision(NaN, MiB + 1), 'notice');
  assert.strictEqual(R.autoReloadDecision('0', MiB + 1), 'notice');
  assert.strictEqual(R.autoReloadDecision(undefined, 2 * MiB), 'notice');
});

test('0067/两档都没有证据时选择自动，不制造提示噪音', () => {
  assert.strictEqual(R.autoReloadDecision(null, null), 'auto');
  assert.strictEqual(R.autoReloadDecision(undefined, NaN), 'auto');
});

test('0001/10 MB 文档没有历史时会降级，不会让用户以为应用崩了又好了', () => {
  // 0001 记录的实测：XL-tables 10 MB 打开约 3.4 s，点链接等于再等 3.4 s。
  assert.strictEqual(R.autoReloadDecision(null, 10 * MiB), 'notice');
});

test('⚠️ 疑似缺陷：负耗时被当成“很快”，短路掉字节兜底', () => {
  // ⚠️ 疑似缺陷：`-1` 是有限数且 <= 500，`autoReloadDecision(-1, MiB+1)` 返回 auto。
  // 负的实测值只可能来自计时口径错误，不该被当成有效证据。
  assert.strictEqual(R.autoReloadDecision(-1, MiB + 1), 'auto');
});

test('三个常量就是设计拍板的数', () => {
  assert.strictEqual(R.GATE_MS, 500);
  assert.strictEqual(R.DEBOUNCE_MS, 300);
  assert.strictEqual(R.FALLBACK_MAX_BYTES, MiB);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0006（打字时预览栏上下晃动）
// 变体：重载前后的阅读位置记录（锚点），文档高度变化时也不能把位置丢掉。
// ─────────────────────────────────────────────────────────────────────────

test('0006/文档不超出视口且没有标题 ⇒ null（不是空锚点）', () => {
  assert.strictEqual(R.pickAnchor(0, [], 600, 800), null);
});

test('0006/文档不超出视口但有标题时仍记锚点，ratio 为 null', () => {
  const a = R.pickAnchor(0, [{ id: 'h', top: 0 }], 600, 800);
  assert.strictEqual(a.id, 'h');
  assert.strictEqual(a.offset, 0);
  assert.strictEqual(a.ratio, null);
});

test('0006/取最后一个 top <= scrollTop 的标题，不假定标题有序', () => {
  const hs = [{ id: 'c', top: 1500 }, { id: 'a', top: 0 }, { id: 'b', top: 500 }];
  const a = R.pickAnchor(1200, hs, 3000, 800);
  assert.strictEqual(a.id, 'b');
  assert.strictEqual(a.offset, 700);
  assert.ok(Math.abs(a.ratio - 1200 / 2200) < 1e-12);
});

test('0006/第一个标题在视口下方时 id 为 null 但比例仍然记下', () => {
  const a = R.pickAnchor(300, [{ id: 'a', top: 900 }], 3000, 800);
  assert.strictEqual(a.id, null);
  assert.strictEqual(a.offset, 0);
  assert.ok(a.ratio > 0 && a.ratio <= 1);
});

test('0006/坏标题条目跳过，不抛也不补 0', () => {
  const hs = [null, { id: '', top: 10 }, { id: 'x' }, { id: 'y', top: NaN },
    { id: 'ok', top: 100 }, { id: 'z', top: Infinity }];
  assert.strictEqual(R.pickAnchor(500, hs, 3000, 800).id, 'ok');
});

test('0006/标题列表不是数组时仍能退回比例', () => {
  assert.strictEqual(R.pickAnchor(0, null, 3000, 800).id, null);
  assert.strictEqual(R.pickAnchor(0, undefined, 3000, 800).ratio, 0);
  assert.strictEqual(R.pickAnchor(9999, [], 3000, 800).ratio, 1);
  assert.strictEqual(R.pickAnchor(-5, [], 3000, 800).ratio, 0);
});

test('0006/当时没记锚点 ⇒ 回顶部但不提示', () => {
  assert.deepStrictEqual(R.resolveAnchor(null, [], 3000, 800), {
    kind: 'top', scrollTop: 0, notice: false,
  });
  assert.strictEqual(R.resolveAnchor('坏数据', [], 3000, 800).notice, false);
});

test('0006/标题还在 ⇒ 按标题加行内偏移恢复', () => {
  const r = R.resolveAnchor({ id: 'b', offset: 40, ratio: 0.5 },
    [{ id: 'b', top: 700 }], 3000, 800);
  assert.strictEqual(r.kind, 'heading');
  assert.strictEqual(r.scrollTop, 740);
  assert.strictEqual(r.notice, false);
});

test('0006/标题没了 ⇒ 退到比例，而不是静默回顶部', () => {
  const r = R.resolveAnchor({ id: 'gone', offset: 40, ratio: 0.5 },
    [{ id: 'b', top: 700 }], 3000, 800);
  assert.strictEqual(r.kind, 'ratio');
  assert.strictEqual(r.scrollTop, 1100);
  assert.strictEqual(r.notice, false);
});

test('0006/标题加偏移落在可滚范围外时夹回边界', () => {
  assert.strictEqual(
    R.resolveAnchor({ id: 'b', offset: 9999, ratio: 0.5 }, [{ id: 'b', top: 700 }], 3000, 800).scrollTop,
    2200
  );
  assert.strictEqual(
    R.resolveAnchor({ id: 'b', offset: -9999, ratio: 0 }, [{ id: 'b', top: 100 }], 3000, 800).scrollTop,
    0
  );
});

test('0006/两条路都不可用 ⇒ 回顶部且必须提示（静默回顶是明令禁止的形态）', () => {
  assert.deepStrictEqual(
    R.resolveAnchor({ id: 'gone', offset: 0, ratio: null }, [{ id: 'b', top: 700 }], 3000, 800),
    { kind: 'top', scrollTop: 0, notice: true }
  );
});

test('0006/新文档已经不可滚 ⇒ 回顶部但不提示', () => {
  assert.deepStrictEqual(
    R.resolveAnchor({ id: 'gone', offset: 0, ratio: 0.7 }, [], 600, 800),
    { kind: 'top', scrollTop: 0, notice: false }
  );
});

test('0006/往返：记下再恢复，位置误差不超过 1px', () => {
  const hs = [{ id: 'a', top: 0 }, { id: 'b', top: 500 }, { id: 'c', top: 1500 }];
  for (const top of [0, 1, 499, 500, 501, 1200, 2199, 2200]) {
    const a = R.pickAnchor(top, hs, 3000, 800);
    const r = R.resolveAnchor(a, hs, 3000, 800);
    assert.ok(Math.abs(r.scrollTop - top) <= 1, `${top} → ${r.scrollTop}`);
  }
});

test('0006/文档被改短时位置夹到新的底，不越界', () => {
  const hs = [{ id: 'a', top: 0 }, { id: 'b', top: 500 }, { id: 'c', top: 1500 }];
  const a = R.pickAnchor(1200, hs, 3000, 800);
  const r = R.resolveAnchor(a, [{ id: 'b', top: 100 }], 1300, 800);
  assert.ok(r.scrollTop >= 0 && r.scrollTop <= 500, `越界：${r.scrollTop}`);
});

test('0006/重复标题 id（后端加了 -1 后缀）互不串位', () => {
  const hs = [{ id: 'intro', top: 0 }, { id: 'intro-1', top: 400 }];
  const a = R.pickAnchor(450, hs, 3000, 800);
  assert.strictEqual(a.id, 'intro-1');
  assert.strictEqual(R.resolveAnchor(a, hs, 3000, 800).scrollTop, 450);
});
