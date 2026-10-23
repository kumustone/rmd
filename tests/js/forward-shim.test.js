// `design/0012` §2.3-5 的单测：**`ctx.editable()` 垫片**。
//
// ⭐ 这个垫片只有二十来行，但它是本设计里**唯一**一处"临时把一道安全闸掰开"的代码
//    （`INV-SET-05`：焦点在输入框里时不抢键）。⇒ 它的正确性判据不是"能不能转发成功"，
//    而是 **"掰开的那一下有没有一定合上"**。
//
// ⚠️ 失败的形态是**静默且危险**的：标志卡在 `true` 上 ⇒ 应用快捷键在**任何**
//    普通文本框里也全部复活（用户在别的输入框里按 `⌘O` 会弹出打开对话框）。
//    而"多响应了几个键"这件事，没有任何界面能看出来。
//
// ⚠️ 纯逻辑、无 DOM（`window` 是注入的假货）⇒ 可 `node --test`。

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const EK = require('../../src/editor/keys.js');

// ─────────────────────────────────────────────────────────────────────────
// 假的 window / keymap 实例
// ─────────────────────────────────────────────────────────────────────────

/** 一个假 `window`：⛔ 只提供垫片真的会读的那一样东西（`document.activeElement`）。 */
function 假窗(焦点可编辑) {
  return { document: { activeElement: 焦点可编辑 ? { tagName: 'INPUT' } : { tagName: 'BODY' } } };
}

/**
 * ⭐ 一个假 keymap 实例（**只为读 `composition`** —— 垫片对它的全部要求就是这个）。
 *
 * ⚠️ `dispatch` 的行为由用例给：本文件关心的是**标志的复位**，不是分发本身。
 */
function 假Keymap(dispatch) {
  return { composition: { active: false }, dispatch: dispatch };
}

// ─────────────────────────────────────────────────────────────────────────
// 标志的**复位**（本文件的主角）
// ─────────────────────────────────────────────────────────────────────────

test('垫片：转发时 `ctx.editable()` 让开，转发完**收回**', function () {
  const shim = EK.createForwardShim({ win: 假窗(true) });
  let 转发时的 = null;
  shim.bind(假Keymap(function () { 转发时的 = shim.ctx.editable(); return true; }));

  assert.strictEqual(shim.ctx.editable(), true, '⚠️ 前置：不转发时，焦点在输入框里 ⇒ 可编辑');
  shim.forward('file.save');
  assert.strictEqual(转发时的, false, '⭐ 转发的那一瞬间必须让开（否则 `dispatch` 会把自己挡掉）');
  assert.strictEqual(shim.ctx.editable(), true, '⭐ 转发完**必须**收回 —— 这一条就是本文件存在的理由');
  assert.strictEqual(shim.isForwarding(), false);
});

test('⭐⭐ 垫片：`dispatch` **抛异常**时标志也必须收回（`try/finally` 那条）', function () {
  // ⚠️⚠️ 本文件里最值钱的一条。写成 `forwarding = true; const r = km.dispatch(...); forwarding = false;`
  //    —— 一个字节都不差的"显然写法" —— 抛一次就永远卡在 `true` 上。
  //    表现：用户在**任何**普通文本框里按 `⌘O` 都会弹出打开对话框，
  //    而这一点在界面上完全看不出来（没有报错、没有变化）。
  const shim = EK.createForwardShim({ win: 假窗(true) });
  shim.bind(假Keymap(function () { throw new Error('handler 里炸了'); }));

  assert.throws(function () { shim.forward('file.save'); }, /handler 里炸了/);
  assert.strictEqual(shim.isForwarding(), false, '⛔ 抛异常之后标志必须收回');
  assert.strictEqual(shim.ctx.editable(), true, '⛔ 而且可编辑判据必须回到"真的焦点"这一份');
});

test('垫片：`forward` 返回底层的返回值（⛔ 不等于"转发成功"）', function () {
  // ⚠️ `dispatch` 会因为"表外 id"/"没有 handler"/"组合态"返回 `false`。
  //    那是**正常**的返回值，⛔ 不是要抛的异常（抛出去会让 CM6 的 `run` 炸掉）。
  const shim = EK.createForwardShim({ win: 假窗(true) });
  shim.bind(假Keymap(function () { return false; }));
  assert.strictEqual(shim.forward('file.save'), false);
  assert.strictEqual(shim.isForwarding(), false, '⚠️ 返回 false 同样要收回标志');
});

test('垫片：还没 `bind` 就转发 ⇒ 返回 `false` 并**响亮报**（⛔ 不静默）', function () {
  // ⚠️ 这个形态只在"接线顺序写错了"时出现。它必须报出来：静默的话，
  //    表现是"编辑区里所有应用键按不动"，而没有任何线索指向接线顺序。
  const shim = EK.createForwardShim({ win: 假窗(true) });
  const 原 = console.error;
  const 报 = [];
  console.error = function () { 报.push(Array.prototype.slice.call(arguments).join(' ')); };
  try {
    assert.strictEqual(shim.forward('file.save'), false);
  } finally {
    console.error = 原;
  }
  assert.strictEqual(报.length, 1, '⛔ 必须报一声');
  assert.match(报[0], /file\.save/, '⚠️ 把**哪个动作**按不动了写出来（这是唯一的线索）');
});

// ─────────────────────────────────────────────────────────────────────────
// 组合态：⛔ 不另起一份实现（`INV-SET-05` 的中文输入那一半）
// ─────────────────────────────────────────────────────────────────────────

test('⭐ 垫片：`compositionActive` 读的是**真 keymap 实例**上那一份，⛔ 不是自己再记一份', function () {
  // ⚠️ 两份组合态迟早会分叉，而分叉的表现正是 `INV-SET-05` 那条闸漏掉：
  //    中文输入法组合中按 `⌘S` 存了盘（把半成品存进文件）。
  const shim = EK.createForwardShim({ win: 假窗(true) });
  const km = 假Keymap(function () { return true; });
  shim.bind(km);

  assert.strictEqual(shim.ctx.compositionActive(), false);
  km.composition.active = true;
  assert.strictEqual(shim.ctx.compositionActive(), true, '⭐ 必须**跟着实例走**（`keymap.js` 挂在 api 上的那一个对象）');
  km.composition.active = false;
  assert.strictEqual(shim.ctx.compositionActive(), false, '⭐ 而且组合结束要跟着回落');
});

test('垫片：还没 `bind` 时 `compositionActive()` 是 `false`（⛔ 不抛）', function () {
  // ⚠️ 结构上这时 `dispatch` 还不可能被调到（`attach()` 更晚），
  //    但**抛出去**会让"接线顺序写错"变成"整个前端启动失败"——代价差太远。
  const shim = EK.createForwardShim({ win: 假窗(true) });
  assert.strictEqual(shim.ctx.compositionActive(), false);
  assert.doesNotThrow(function () { shim.ctx.compositionActive(); });
});

test('⭐ 垫片：组合态与"转发中"是**两件事**，⛔ 转发不会顺手把组合态说成 false', function () {
  // ⚠️ `dispatch` 里那两道闸是**并列**的（`compositionActive` 在前、`editable` 在后）：
  //    垫片只该让开后一道。要是它把前一道也一起开了，中文输入法组合中按 `⌘S`
  //    就会把半成品存进文件——而那是一条**写盘**路径。
  const shim = EK.createForwardShim({ win: 假窗(true) });
  const km = 假Keymap(function () { return true; });
  km.composition.active = true;
  shim.bind(km);
  shim.forward('file.save');
  assert.strictEqual(shim.ctx.compositionActive(), true, '⛔ 转发**不许**动组合态那一道闸');
});

// ─────────────────────────────────────────────────────────────────────────
// 可编辑判据的来源（⛔ 不复用 `keymap.js` 之外的第三份实现）
// ─────────────────────────────────────────────────────────────────────────

test('垫片：不转发时，可编辑判据**就是** `keymap.js::isEditableElement(activeElement)`', function () {
  // ⭐ 垫片在"不转发"这条路径上**必须是透明的**：它就是原判据。
  //    ⚠️ 若这里自己写一套（比如按 `tagName` 自己列白名单），那就有两份实现——
  //    而 `keymap.js` 那一份是**既有**行为（`INV-SET-05` 的既有测试盯着它）。
  const K = require('../../src/services/keymap.js');
  [true, false].forEach(function (可编辑) {
    const win = 假窗(可编辑);
    const shim = EK.createForwardShim({ win: win });
    assert.strictEqual(
      shim.ctx.editable(),
      K.isEditableElement(win.document.activeElement),
      '⛔ 两条判据必须**逐值相同**（可编辑=' + 可编辑 + '）'
    );
  });
});

test('垫片：`win` 缺 `document` 时 `editable()` 返回 `false`（⛔ 不抛）', function () {
  // ⚠️ 与 `compositionActive` 同一条纪律：这条路径在启动早期就会被走到，
  //    抛出去的表现是"整个前端起不来"，而原因只是"window 还没有 document"。
  const shim = EK.createForwardShim({ win: {} });
  assert.strictEqual(shim.ctx.editable(), false);
  const shim2 = EK.createForwardShim({ win: null });
  assert.strictEqual(shim2.ctx.editable(), false);
});

test('垫片：`bind` 换一个实例 ⇒ 组合态跟着换（⛔ 不缓存旧实例）', function () {
  // ⚠️ 生产代码只 `bind` 一次，但"缓存了旧的"是个**静默**错法：
  //    表现是组合态永远读一份已经不用的状态（恒 false 或恒 true）。
  const shim = EK.createForwardShim({ win: 假窗(true) });
  const 甲 = 假Keymap(function () { return true; });
  const 乙 = 假Keymap(function () { return true; });
  甲.composition.active = true;
  shim.bind(甲);
  assert.strictEqual(shim.ctx.compositionActive(), true);
  shim.bind(乙);
  assert.strictEqual(shim.ctx.compositionActive(), false, '⛔ 换了实例就该读新的那一份');
  乙.composition.active = true;
  assert.strictEqual(shim.ctx.compositionActive(), true);
});

// ─────────────────────────────────────────────────────────────────────────
// 与真 keymap 实例的**联调**（⛔ 不靠假货证明"真的能转发"）
// ─────────────────────────────────────────────────────────────────────────

test('⭐ 联调：真 `keymap.js` 实例 ＋ 垫片 ⇒ 编辑区里 `dispatch` 能通过，普通输入框里仍被挡', function () {
  // ⭐ 这条是本文件唯一的**端到端**（仍是纯逻辑）：它把 `keymap.js` 的两道校验
  //    （组合态 / 可编辑焦点）与垫片接在一起，证明：
  //    ① 垫片确实能让 `dispatch` 放行（⛔ 不是"看着像放了"）；
  //    ② 放开之后**表内 id ＋ handler 存在性**那两道校验照旧生效（§2.3-5 的原话）。
  const K = require('../../src/services/keymap.js');
  const win = 假窗(true);
  const km = K.createKeymap({
    table: [{ id: 'file.save', label: '保存', accel: 'Cmd+S', display: '⌘S', owner: 'web', aliases: [] }],
    win: win,
  });
  const shim = EK.createForwardShim({ win: win });
  const km2 = K.createKeymap({
    table: [{ id: 'file.save', label: '保存', accel: 'Cmd+S', display: '⌘S', owner: 'web', aliases: [] }],
    win: win,
    ctx: shim.ctx,     // ⭐ 垫片就是**通过这一个参数**接进来的（`keymap.js` 一行都不用改）
  });
  void km;
  shim.bind(km2);

  let 存了几次 = 0;
  km2.register('file.save', function () { 存了几次 += 1; });

  // —— ① 焦点在输入框里（可编辑），**不**转发 ⇒ 被挡掉 ——
  assert.strictEqual(km2.dispatch('file.save', 'key'), false, '⚠️ 前置：这正是 `INV-SET-05` 要挡的形态');
  assert.strictEqual(存了几次, 0);

  // —— ② 走垫片转发 ⇒ 放行 ——
  assert.strictEqual(shim.forward('file.save'), true);
  assert.strictEqual(存了几次, 1, '⭐ 垫片让开之后 `dispatch` 真的执行了 handler');

  // —— ③ ⭐ 表内 id 与 handler 存在性那两道**照旧**生效 ——
  assert.strictEqual(shim.forward('不存在的.id'), false, '⛔ 垫片**不是**"无条件放行"——表外 id 照样被挡');
  assert.strictEqual(存了几次, 1);

  // —— ④ 转完之后普通路径仍然被挡（收回去了）——
  assert.strictEqual(km2.dispatch('file.save', 'key'), false, '⛔ 转完必须回到"输入框里不抢键"');
  assert.strictEqual(shim.isForwarding(), false);
});

test('⭐ 联调：垫片让开的是 `editable` 那一道，⛔ **不是**组合态那一道', function () {
  // ⚠️ 这条用**真** `dispatch` 再钉一次上面的判断：中文输入法组合中按 `⌘S`
  //    **必须仍然被挡**（那是一条写盘路径，把半成品存进文件是最坏的结果之一）。
  const K = require('../../src/services/keymap.js');
  const win = 假窗(true);
  const shim = EK.createForwardShim({ win: win });
  const km = K.createKeymap({
    table: [{ id: 'file.save', label: '保存', accel: 'Cmd+S', display: '⌘S', owner: 'web', aliases: [] }],
    win: win,
    ctx: shim.ctx,
  });
  shim.bind(km);
  let 存了几次 = 0;
  km.register('file.save', function () { 存了几次 += 1; });

  km.composition.active = true;          // ⭐ 中文输入法正在组合
  assert.strictEqual(shim.forward('file.save'), false, '⛔ 组合中**不许**存盘');
  assert.strictEqual(存了几次, 0);
  assert.strictEqual(shim.ctx.editable(), true, '⚠️ 而且标志已经收回（让开的只有 editable 那一道）');
});
