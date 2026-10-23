// `design/0006` §2.1 ④⑤⑥ 的单测：**自动重载的四条判据**。
//
// ⭐ 这个文件守的是"**同一判据只有一份实现**"那条决定（见 `reload.js` 头部）：
// 闸门、事件判据、三级锚点全在 `reload.js` 里，这里逐条钉住它们的**边界**。
//
// ⚠️ 为什么边界比正常路径重要：这四件事的错法**全是静默的**——
// 闸门写成 `<` 而不是 `<=` ⇒ 恰好在 500 ms 的文档每次保存都白等一遍，
// 而它"看起来在工作"；`acceptEvent` 漏掉 `seq > 0` 那条 ⇒ "没有监视"这个状态
// **恰好接受**一条 `seq` 为 0 的事件；锚点恢复失败不弹提示 ⇒
// 用户以为"文档被改了、我看到的是开头"。
//
// ⚠️ 纯逻辑、无 DOM、无计时器 ⇒ 可以直接 `node --test`。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const R = require('../../src/services/reload.js');

const MiB = 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────
// autoReloadDecision —— 降级闸门（§2.1 ④）
// ─────────────────────────────────────────────────────────────────────────

test('闸门：恰好等于 500 ms 算过（<= 而不是 <）', () => {
  assert.strictEqual(R.autoReloadDecision(499, null), 'auto');
  assert.strictEqual(R.autoReloadDecision(500, null), 'auto');
  // ⚠️ 这一条就是那个静默错法的边界：写成 `<` 时它会变红。
  assert.strictEqual(R.autoReloadDecision(500.0001, null), 'notice');
  assert.strictEqual(R.autoReloadDecision(501, null), 'notice');
});

test('闸门：优先用实测历史，字节数只在没有历史时用', () => {
  // 历史说"很快" ⇒ 即使字节数超了兜底上限也自动
  assert.strictEqual(R.autoReloadDecision(120, 10 * MiB), 'auto');
  // 历史说"太慢" ⇒ 即使字节数很小也降级
  assert.strictEqual(R.autoReloadDecision(3000, 1024), 'notice');
});

test('闸门：兜底档的边界是 1 MiB（含）', () => {
  assert.strictEqual(R.autoReloadDecision(null, MiB), 'auto');
  // ⚠️ 恰好 1 MiB 之上一个字节 —— 与 500/501 那条同一种边界。
  assert.strictEqual(R.autoReloadDecision(null, MiB + 1), 'notice');
  assert.strictEqual(R.autoReloadDecision(null, 10 * MiB), 'notice');
});

test('闸门：采不到的数跳过该档，⛔ 不当成 0', () => {
  // ⭐ 与 `measure.js` 那条"采不到是 null 不是 0"同族：
  //    把 NaN 当 0 会让"没采到"变成"很快，放心重载"。
  assert.strictEqual(R.autoReloadDecision(NaN, 10 * MiB), 'notice', 'NaN 必须跳到字节那一档');
  assert.strictEqual(R.autoReloadDecision('500', MiB + 1), 'notice', '字符串不是数');
  assert.strictEqual(R.autoReloadDecision(undefined, MiB + 1), 'notice');
  assert.strictEqual(R.autoReloadDecision(Infinity, MiB), 'auto', 'Infinity 不是有效的实测值');
});

test('闸门：两档都没有 ⇒ auto（没有证据说明它重不起来）', () => {
  assert.strictEqual(R.autoReloadDecision(null, null), 'auto');
  assert.strictEqual(R.autoReloadDecision(undefined, undefined), 'auto');
  assert.strictEqual(R.autoReloadDecision(NaN, NaN), 'auto');
  // ⚠️ 只要有一档存在就用那一档，⛔ 不因为"另一档没有"就放弃判断。
  assert.strictEqual(R.autoReloadDecision(null, 2 * MiB), 'notice');
});

test('闸门：0 与负数', () => {
  // 0 ms 是合法的实测值（缓存命中）⇒ 过
  assert.strictEqual(R.autoReloadDecision(0, null), 'auto');
  assert.strictEqual(R.autoReloadDecision(null, 0), 'auto');
  // ⚠️ 负数**不是**合法的字节数 ⇒ 跳过该档（⛔ 不是"比上限小所以放行"）
  assert.strictEqual(R.autoReloadDecision(null, -1), 'auto', '负数跳过该档，两档皆无 ⇒ auto');
});

test('闸门：常量就是设计里那两个数', () => {
  // ⚠️ 这两个数是 §9.3 拍板的**初值**，改它们要连着改设计——
  //    写在这里是为了让"哪天有人顺手调成 1000"至少碰到一条断言。
  assert.strictEqual(R.GATE_MS, 500);
  assert.strictEqual(R.DEBOUNCE_MS, 300);
  assert.strictEqual(R.FALLBACK_MAX_BYTES, MiB);
});

// ─────────────────────────────────────────────────────────────────────────
// acceptEvent —— 这条事件是我这一轮监视的吗（§2.1 ②）
// ─────────────────────────────────────────────────────────────────────────

test('事件判据：三条都对上才收', () => {
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 7 }, 7, '/a/b.md'), true);
});

test('事件判据：代号不符 ⇒ 丢（换文档后上一份的迟到事件）', () => {
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 6 }, 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 8 }, 7, '/a/b.md'), false);
});

test('事件判据：路径不符 ⇒ 丢（后端换了目标而前端还不知道）', () => {
  assert.strictEqual(R.acceptEvent({ path: '/a/c.md', seq: 7 }, 7, '/a/b.md'), false);
});

test('事件判据：seq=0 一律不收（⛔ 不依赖对面守规矩）', () => {
  // ⭐ 只判 `ev.seq === seq` 的话，`0 === 0` 会让"没有监视"这个状态
  //    **恰好接受**一条 seq 为 0 的事件。真实事件不会带 0——
  //    但判据的边界应当自己站得住。
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 0 }, 0, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 0 }, 0, null), false);
});

test('事件判据：形状不对 ⇒ 丢，⛔ 不抛', () => {
  assert.strictEqual(R.acceptEvent(null, 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent(undefined, 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent('x', 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md' }, 7, '/a/b.md'), false, '缺 seq');
  assert.strictEqual(R.acceptEvent({ seq: 7 }, 7, '/a/b.md'), false, '缺 path');
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: '7' }, 7, '/a/b.md'), false, 'seq 是字符串');
  assert.strictEqual(R.acceptEvent({ path: '', seq: 7 }, 7, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 7 }, 7, null), false, '前端没有当前文档');
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 7 }, 7, ''), false);
  // ⚠️ 前端自己那个 seq 也不可信：负数 / 非数一样不收
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: -1 }, -1, '/a/b.md'), false);
  assert.strictEqual(R.acceptEvent({ path: '/a/b.md', seq: 7 }, '7', '/a/b.md'), false);
});

// ─────────────────────────────────────────────────────────────────────────
// pickAnchor —— 重载之前记下阅读位置（§6.1）
// ─────────────────────────────────────────────────────────────────────────

test('锚点：还没超出视口 ⇒ 不记（返回 null，⛔ 不是空锚点）', () => {
  // ⚠️ 返回 `null` 与返回 `{id:null,offset:0,ratio:null}` 是**两件事**：
  //    前者让恢复那一步**不弹提示**（那时位置只可能是 0，没有损失）。
  assert.strictEqual(R.pickAnchor(0, [], 600, 800), null);
  // ⚠️ 但**有标题**时仍然记：那是两条正交的判据（"有没有可滚的东西" vs "有没有锚"）。
  //    它恢复出来的位置也是 0，所以记与不记都不出错——记下来反而少一条特例。
  assert.strictEqual(R.pickAnchor(0, [{ id: 'h', top: 0 }], 600, 800).id, 'h');
  assert.strictEqual(R.pickAnchor(0, [{ id: 'h', top: 0 }], 600, 800).ratio, null,
    '不能滚就没有比例可言');
});

test('锚点：取最后一个 top <= scrollTop 的标题', () => {
  const hs = [{ id: 'a', top: 0 }, { id: 'b', top: 500 }, { id: 'c', top: 1500 }];
  const a = R.pickAnchor(1200, hs, 3000, 800);
  assert.strictEqual(a.id, 'b');
  assert.strictEqual(a.offset, 700);
  assert.ok(Math.abs(a.ratio - 1200 / 2200) < 1e-12);
});

test('锚点：标题列表**不假定有序**', () => {
  // ⚠️ DOM 顺序与视觉顺序在有多列/浮动时会分叉 ⇒ 判据必须是"top 最大的那个合格项"
  const hs = [{ id: 'c', top: 1500 }, { id: 'a', top: 0 }, { id: 'b', top: 500 }];
  assert.strictEqual(R.pickAnchor(1200, hs, 3000, 800).id, 'b');
});

test('锚点：第一个标题在视口下方 ⇒ 没有标题可记，但比例还在', () => {
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

test('锚点：headings 不是数组 / 为 null 也活下来', () => {
  assert.strictEqual(R.pickAnchor(0, null, 3000, 800).id, null);
  assert.strictEqual(R.pickAnchor(0, undefined, 3000, 800).ratio, 0);
});

test('锚点：滚到底 ⇒ 比例正好 1（含越界夹取）', () => {
  assert.strictEqual(R.pickAnchor(2200, [], 3000, 800).ratio, 1);
  assert.strictEqual(R.pickAnchor(9999, [], 3000, 800).ratio, 1, '超出可滚范围也要夹到 1');
  assert.strictEqual(R.pickAnchor(-5, [], 3000, 800).ratio, 0, '负的也要夹到 0');
});

// ─────────────────────────────────────────────────────────────────────────
// resolveAnchor —— 重载之后把它变回 scrollTop（§6.1）
// ─────────────────────────────────────────────────────────────────────────

test('恢复：当时没记（null）⇒ 回顶部但**不提示**', () => {
  const r = R.resolveAnchor(null, [], 3000, 800);
  assert.deepStrictEqual(r, { kind: 'top', scrollTop: 0, notice: false });
  assert.strictEqual(R.resolveAnchor(undefined, [], 3000, 800).notice, false);
});

test('恢复：标题还在 ⇒ 按标题 + 行内偏移', () => {
  const a = { id: 'b', offset: 40, ratio: 0.5 };
  const r = R.resolveAnchor(a, [{ id: 'b', top: 700 }], 3000, 800);
  assert.strictEqual(r.kind, 'heading');
  assert.strictEqual(r.scrollTop, 740);
  assert.strictEqual(r.notice, false);
});

test('恢复：标题没了 ⇒ 退到比例', () => {
  const a = { id: 'gone', offset: 40, ratio: 0.5 };
  const r = R.resolveAnchor(a, [{ id: 'b', top: 700 }], 3000, 800);
  assert.strictEqual(r.kind, 'ratio');
  assert.strictEqual(r.scrollTop, 1100);
  assert.strictEqual(r.notice, false);
});

test('恢复：标题 + 偏移落在可滚范围外 ⇒ 夹回来', () => {
  const a = { id: 'b', offset: 9999, ratio: 0.5 };
  assert.strictEqual(R.resolveAnchor(a, [{ id: 'b', top: 700 }], 3000, 800).scrollTop, 2200);
  const b = { id: 'b', offset: -9999, ratio: 0 };
  assert.strictEqual(R.resolveAnchor(b, [{ id: 'b', top: 100 }], 3000, 800).scrollTop, 0);
});

test('恢复：两条都不可用 ⇒ 回顶部 + **必须提示**', () => {
  // ⭐ 这正是 §6.1 那句"静默回顶部是明令禁止的失败形态"
  const a = { id: 'gone', offset: 0, ratio: null };
  const r = R.resolveAnchor(a, [{ id: 'b', top: 700 }], 3000, 800);
  assert.deepStrictEqual(r, { kind: 'top', scrollTop: 0, notice: true });
});

test('恢复：新文档没有可滚的东西 ⇒ 回顶部但**不提示**', () => {
  // ⚠️ 位置只可能是 0，"恢复不了"在这里不是一个损失。
  //    ⛔ 这里弹提示就是"狼来了"——用户下次会忽略那句真的警告。
  const a = { id: 'gone', offset: 0, ratio: 0.7 };
  assert.deepStrictEqual(R.resolveAnchor(a, [], 600, 800), {
    kind: 'top', scrollTop: 0, notice: false,
  });
});

test('恢复：heading 列表脏数据不影响结论', () => {
  const a = { id: 'b', offset: 10, ratio: null };
  const dirty = [null, { id: 'b' }, { id: 'b', top: NaN }, { id: 'b', top: 300 }];
  assert.strictEqual(R.resolveAnchor(a, dirty, 3000, 800).scrollTop, 310);
});

test('往返：记下再恢复，位置误差在 1px 内', () => {
  // ⭐ 这是这一对函数**唯一**真正要保证的性质。
  const hs = [{ id: 'a', top: 0 }, { id: 'b', top: 500 }, { id: 'c', top: 1500 }];
  for (const top of [0, 1, 499, 500, 501, 1200, 2199, 2200]) {
    const a = R.pickAnchor(top, hs, 3000, 800);
    const r = R.resolveAnchor(a, hs, 3000, 800);
    assert.ok(Math.abs(r.scrollTop - top) <= 1, `${top} → ${r.scrollTop}`);
  }
});

test('往返：文档被改短，位置被夹到新的底而不是爆掉', () => {
  const hs = [{ id: 'a', top: 0 }, { id: 'b', top: 500 }, { id: 'c', top: 1500 }];
  const a = R.pickAnchor(1200, hs, 3000, 800);
  // 新文档只有 500px 可滚（标题 c 还在，但整体短了）
  const r = R.resolveAnchor(a, [{ id: 'b', top: 100 }], 1300, 800);
  assert.ok(r.scrollTop >= 0 && r.scrollTop <= 500, `越界：${r.scrollTop}`);
});
