// 自动重载的四条纯逻辑（`src/services/reload.js`）的补充用例。
//
// 这些判据的错法**全是静默的**：闸门写成 `<` 而不是 `<=`、事件判据漏掉 `seq > 0`、
// 锚点恢复失败却不提示 —— 界面上都不会报错，只表现为“保存一次白等一遍”
// 或“文档被改了、我看到的是开头”。
//
// ⚠️ 加载方式同 `sync.test.js`：遮蔽 Node 26 的全局 `module` / `require`，走 `window` 分支。
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
// autoReloadDecision：降级闸门
// ─────────────────────────────────────────────────────────────────────────

test('闸门：500 ms 含在自动档内，500.0001 就降级', () => {
  assert.strictEqual(R.autoReloadDecision(499, null), 'auto');
  assert.strictEqual(R.autoReloadDecision(500, null), 'auto');
  assert.strictEqual(R.autoReloadDecision(500.0001, null), 'notice');
  assert.strictEqual(R.autoReloadDecision(501, null), 'notice');
});

test('闸门：实测历史优先于字节数', () => {
  // 历史很快 ⇒ 即便字节数超了兜底上限也自动
  assert.strictEqual(R.autoReloadDecision(120, 10 * MiB), 'auto');
  // 历史很慢 ⇒ 即便字节数很小也降级
  assert.strictEqual(R.autoReloadDecision(3000, 1024), 'notice');
});

test('闸门：兜底档边界是 1 MiB（含）', () => {
  assert.strictEqual(R.autoReloadDecision(null, MiB), 'auto');
  assert.strictEqual(R.autoReloadDecision(null, MiB + 1), 'notice');
  assert.strictEqual(R.autoReloadDecision(null, 10 * MiB), 'notice');
});

test('闸门：采不到的数跳过该档，⛔ 不当成 0', () => {
  assert.strictEqual(R.autoReloadDecision(NaN, 10 * MiB), 'notice');
  assert.strictEqual(R.autoReloadDecision('500', MiB + 1), 'notice');
  assert.strictEqual(R.autoReloadDecision(undefined, MiB + 1), 'notice');
  assert.strictEqual(R.autoReloadDecision(null, 2 * MiB), 'notice');
});

test('闸门：Infinity 不是有效的实测值，跳到字节那一档', () => {
  assert.strictEqual(R.autoReloadDecision(Infinity, MiB), 'auto');
  assert.strictEqual(R.autoReloadDecision(Infinity, MiB + 1), 'notice');
});

test('闸门：两档都没有证据时选择自动（不制造噪音）', () => {
  assert.strictEqual(R.autoReloadDecision(null, null), 'auto');
  assert.strictEqual(R.autoReloadDecision(undefined, undefined), 'auto');
  assert.strictEqual(R.autoReloadDecision(NaN, NaN), 'auto');
});

test('闸门：0 是合法实测值；负数字节不算证据，负数耗时目前仍按“很快”放行', () => {
  assert.strictEqual(R.autoReloadDecision(0, null), 'auto');
  assert.strictEqual(R.autoReloadDecision(null, 0), 'auto');
  // 字节档有 >= 0 的守卫：负数跳过该档；两档皆无 ⇒ auto
  assert.strictEqual(R.autoReloadDecision(null, -1), 'auto');
  // 耗时档只看“有限数”：-1 满足 <= 500 ⇒ auto，并因此短路掉字节档。
  // ⚠️ 这是产品当前行为（见报告“可疑行为”）；改行为时这条应当跟着红。
  assert.strictEqual(R.autoReloadDecision(-1, MiB + 1), 'auto');
});

test('闸门：三个常量就是设计里拍板的数', () => {
  assert.strictEqual(R.GATE_MS, 500);
  assert.strictEqual(R.DEBOUNCE_MS, 300);
  assert.strictEqual(R.FALLBACK_MAX_BYTES, MiB);
});

// ─────────────────────────────────────────────────────────────────────────
// acceptEvent：这轮监视的事件吗
// ─────────────────────────────────────────────────────────────────────────

test('事件判据：seq 与 path 都对上才收', () => {
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 7 }, 7, '/a/b.md'), true);
});

test('事件判据：seq 不符 / path 不符一律丢', () => {
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 6 }, 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 8 }, 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/a/c.md', seq: 7 }, 7, '/a/b.md'), false);
});

test('事件判据：seq=0 在两边都不被接受', () => {
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 0 }, 0, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 0 }, 0, null), false);
});

test('事件判据：形状不对一律丢，且不抛', () => {
  assert.strictEqual(R.acceptEvent(null, 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent(undefined, 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent('x', 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md' }, 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ seq: 7 }, 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '', seq: 7 }, 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: '7' }, 7, '/a/b.md'), false);
});

test('事件判据：前端自己那个 seq 非正数或非数也不可信', () => {
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: -1 }, -1, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 7 }, '7', '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 7 }, 7, ''), false);
});

// ─────────────────────────────────────────────────────────────────────────
// pickAnchor：重载之前记阅读位置
// ─────────────────────────────────────────────────────────────────────────

test('锚点：文档没超出视口且无标题 ⇒ null（⛔ 不是空锚点）', () => {
  assert.strictEqual(R.pickAnchor(0, [], 600, 800), null);
});

test('锚点：没超出视口但有标题时仍记，ratio 为 null', () => {
  const a = R.pickAnchor(0, [{ id: 'h', top: 0 }], 600, 800);
  assert.strictEqual(a.id, 'h');
  assert.strictEqual(a.offset, 0);
  assert.strictEqual(a.ratio, null, '不能滚就没有比例可言');
});

test('锚点：取最后一个 top <= scrollTop 的标题，不假定有序', () => {
  const hs = [{ id: 'c', top: 1500 }, { id: 'a', top: 0 }, { id: 'b', top: 500 }];
  const a = R.pickAnchor(1200, hs, 3000, 800);
  assert.strictEqual(a.id, 'b');
  assert.strictEqual(a.offset, 700);
  assert.ok(Math.abs(a.ratio - 1200 / 2200) < 1e-12);
});

test('锚点：第一个标题在视口下方 ⇒ id 为 null 但比例还在', () => {
  const a = R.pickAnchor(300, [{ id: 'a', top: 900 }], 3000, 800);
  assert.strictEqual(a.id, null);
  assert.strictEqual(a.offset, 0);
  assert.ok(a.ratio > 0);
});

test('锚点：坏条目跳过，⛔ 不抛', () => {
  const hs = [null, { id: '', top: 10 }, { id: 'x' }, { id: 'y', top: NaN },
    { id: 'ok', top: 100 }, { id: 'z', top: Infinity }];
  assert.strictEqual(R.pickAnchor(500, hs, 3000, 800).id, 'ok');
});

test('锚点：headings 不是数组也活下来，比例夹在 0..1', () => {
  assert.strictEqual(R.pickAnchor(0, null, 3000, 800).id, null);
  assert.strictEqual(R.pickAnchor(0, undefined, 3000, 800).ratio, 0);
  assert.strictEqual(R.pickAnchor(9999, [], 3000, 800).ratio, 1);
  assert.strictEqual(R.pickAnchor(-5, [], 3000, 800).ratio, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// resolveAnchor：重载之后恢复位置
// ─────────────────────────────────────────────────────────────────────────

test('恢复：当时没记（null）⇒ 回顶部但不提示', () => {
  assert.deepStrictEqual(R.resolveAnchor(null, [], 3000, 800), {
    kind: 'top', scrollTop: 0, notice: false,
  });
  assert.strictEqual(R.resolveAnchor(undefined, [], 3000, 800).notice, false);
  assert.strictEqual(R.resolveAnchor('x', [], 3000, 800).notice, false);
});

test('恢复：标题还在 ⇒ 按标题 + 行内偏移', () => {
  const r = R.resolveAnchor({ id: 'b', offset: 40, ratio: 0.5 },
    [{ id: 'b', top: 700 }], 3000, 800);
  assert.strictEqual(r.kind, 'heading');
  assert.strictEqual(r.scrollTop, 740);
  assert.strictEqual(r.notice, false);
});

test('恢复：标题没了 ⇒ 退到比例', () => {
  const r = R.resolveAnchor({ id: 'gone', offset: 40, ratio: 0.5 },
    [{ id: 'b', top: 700 }], 3000, 800);
  assert.strictEqual(r.kind, 'ratio');
  assert.strictEqual(r.scrollTop, 1100);
  assert.strictEqual(r.notice, false);
});

test('恢复：标题 + 偏移落在可滚范围外时夹回来', () => {
  assert.strictEqual(
    R.resolveAnchor({ id: 'b', offset: 9999, ratio: 0.5 }, [{ id: 'b', top: 700 }], 3000, 800).scrollTop,
    2200
  );
  assert.strictEqual(
    R.resolveAnchor({ id: 'b', offset: -9999, ratio: 0 }, [{ id: 'b', top: 100 }], 3000, 800).scrollTop,
    0
  );
});

test('恢复：两条都不可用 ⇒ 回顶部 + 必须提示', () => {
  // 静默回顶部是明令禁止的失败形态：用户会以为文档被改成了开头。
  assert.deepStrictEqual(
    R.resolveAnchor({ id: 'gone', offset: 0, ratio: null }, [{ id: 'b', top: 700 }], 3000, 800),
    { kind: 'top', scrollTop: 0, notice: true }
  );
});

test('恢复：新文档没有可滚内容 ⇒ 回顶部但不提示', () => {
  assert.deepStrictEqual(
    R.resolveAnchor({ id: 'gone', offset: 0, ratio: 0.7 }, [], 600, 800),
    { kind: 'top', scrollTop: 0, notice: false }
  );
});

test('恢复：heading 列表里的脏数据不影响结论', () => {
  const a = { id: 'b', offset: 10, ratio: null };
  const dirty = [null, { id: 'b' }, { id: 'b', top: NaN }, { id: 'b', top: 300 }];
  assert.strictEqual(R.resolveAnchor(a, dirty, 3000, 800).scrollTop, 310);
});

test('往返：记下再恢复，位置误差不超过 1px', () => {
  const hs = [{ id: 'a', top: 0 }, { id: 'b', top: 500 }, { id: 'c', top: 1500 }];
  for (const top of [0, 1, 499, 500, 501, 1200, 2199, 2200]) {
    const a = R.pickAnchor(top, hs, 3000, 800);
    const r = R.resolveAnchor(a, hs, 3000, 800);
    assert.ok(Math.abs(r.scrollTop - top) <= 1, `${top} → ${r.scrollTop}`);
  }
});

test('往返：文档被改短时位置夹到新的底而不是爆掉', () => {
  const hs = [{ id: 'a', top: 0 }, { id: 'b', top: 500 }, { id: 'c', top: 1500 }];
  const a = R.pickAnchor(1200, hs, 3000, 800);
  const r = R.resolveAnchor(a, [{ id: 'b', top: 100 }], 1300, 800);
  assert.ok(r.scrollTop >= 0 && r.scrollTop <= 500, `越界：${r.scrollTop}`);
});
