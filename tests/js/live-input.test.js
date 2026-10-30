// `design/0047` §2.7（R1 输入子系统）＋ `INV-LIVE-12` / `INV-LIVE-17` 的纯逻辑判据。
//
// ⚠️ 这一份测的是 `src/live/input.js`（事件 → 事务的状态机，⛔ 不碰 DOM）。
//    真 WKWebView 的事件顺序与真机中文 IME 是**人工闸门**（`design/0047` §7.3），
//    ⛔ 但"这串事件该产出几条事务"必须在这里钉死——那是 `INV-LIVE-17` 要的
//    「函数级状态机测试」，⛔ 不许把整层都推给人工。
//
// ⭐ 每条都带**反例**的理由：这四类错（组合期落事务、组合结束落多条、重复 insert 插两遍、
//    `\r` 进正文）在屏幕上都不报错，只有对照输入与结果才能发现。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const I = require('../../src/live/input.js');
const O = require('../../src/live/objects.js');

/** 造一台会记账的状态机。 */
function machine(policy) {
  const txs = [];
  const m = I.createInputMachine(function (tx) {
    txs.push(tx);
  }, policy);
  return { m: m, txs: txs };
}

/** 事务的紧凑形状，便于断言。 */
function shape(tx) {
  return [tx.reason, tx.from, tx.to, tx.next];
}

// ── 行尾规范化 ─────────────────────────────────────────────────────────────

test('行尾：CRLF 与裸 CR 都归一成 LF，⛔ 一个 `\\r` 都不许剩', function () {
  assert.strictEqual(I.normalizeNewlines('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.deepStrictEqual(I.linesOf('a\r\nb'), ['a', 'b']);
  assert.deepStrictEqual(I.linesOf('a\rb'), ['a', 'b']);
  // ⚠️ 反例：只处理 `\r\n` 的写法会把裸 CR 留下来。
  assert.ok(I.linesOf('a\rb').every(function (l) { return l.indexOf('\r') < 0; }));
});

// ── 普通输入 / 删除 ────────────────────────────────────────────────────────

test('普通字符：一条 `insert` 事务，区间原样带过去', function () {
  const { m, txs } = machine();
  const r = m.handle({ type: 'beforeinput', inputType: 'insertText', data: '你', from: 3, to: 3 });
  assert.strictEqual(r.applied, true);
  assert.deepStrictEqual(txs.map(shape), [['insert', 3, 3, ['你']]]);
});

test('替换选区：`from < to` 时是一次替换（⛔ 不是先删再插）', function () {
  const { m, txs } = machine();
  m.handle({ type: 'beforeinput', inputType: 'insertText', data: 'X', from: 2, to: 7 });
  assert.deepStrictEqual(txs.map(shape), [['insert', 2, 7, ['X']]]);
});

test('⭐ 删除：四种 inputType 都只产出**一条**空内容的删除事务（区间由浏览器算好）', function () {
  const kinds = ['deleteContentBackward', 'deleteContentForward', 'deleteWordBackward', 'deleteByCut'];
  for (const k of kinds) {
    const { m, txs } = machine();
    m.handle({ type: 'beforeinput', inputType: k, from: 1, to: 4 });
    assert.deepStrictEqual(txs.map(shape), [['delete', 1, 4, []]], k);
  }
});

test('⛔ 撤销 / 重做不交给浏览器（否则两套历史来回切）', function () {
  const { m, txs } = machine();
  assert.strictEqual(m.handle({ type: 'beforeinput', inputType: 'historyUndo' }).applied, false);
  assert.strictEqual(m.handle({ type: 'beforeinput', inputType: 'historyRedo' }).applied, false);
  assert.deepStrictEqual(txs, []);
});

test('未处理的 inputType ⇒ 不落事务，但**说出来**（⛔ 静默）', function () {
  const { m, txs } = machine();
  const r = m.handle({ type: 'beforeinput', inputType: 'formatBold' });
  assert.strictEqual(r.applied, false);
  assert.match(r.why, /未处理的 inputType formatBold/);
  assert.deepStrictEqual(txs, []);
});

// ── IME 组合（`F6` 强需求的核心）──────────────────────────────────────────

test('⭐ 组合期间：文档**一个字节都不动**（update 只更新临时态）', function () {
  const { m, txs } = machine();
  m.handle({ type: 'compositionstart', from: 5, to: 9 });
  for (const s of ['n', 'ni', 'nih', 'niha', 'nihao']) {
    const r = m.handle({ type: 'compositionupdate', data: s });
    assert.strictEqual(r.applied, false, '组合 update 绝不许落事务：' + s);
  }
  assert.strictEqual(m.state.provisional, 'nihao', '临时态要跟着更新（preedit 靠它画）');
  assert.deepStrictEqual(txs, [], '⭐ 组合期间事务数必须为 0');
});

test('组合结束：**恰好一条**事务，内容一次性进去', function () {
  const { m, txs } = machine();
  m.handle({ type: 'compositionstart', from: 5, to: 9 });
  m.handle({ type: 'compositionupdate', data: 'nihao' });
  const r = m.handle({ type: 'compositionend', data: '你好' });
  assert.strictEqual(r.applied, true);
  assert.deepStrictEqual(txs.map(shape), [['composition', 5, 9, ['你好']]]);
  assert.strictEqual(m.state.composing, false);
});

test('组合取消（空结果）：⛔ 不落事务、不留残字', function () {
  const { m, txs } = machine();
  m.handle({ type: 'compositionstart', from: 5, to: 9 });
  m.handle({ type: 'compositionupdate', data: 'nih' });
  const r = m.handle({ type: 'compositionend', data: '' });
  assert.strictEqual(r.applied, false);
  assert.deepStrictEqual(txs, []);
  assert.strictEqual(m.state.provisional, '', '临时态必须清掉（否则 preedit 残在屏幕上）');
});

test('`cancel`（Esc / 失焦）：组合作废、不落事务', function () {
  const { m, txs } = machine();
  m.handle({ type: 'compositionstart', from: 1, to: 1 });
  m.handle({ type: 'compositionupdate', data: 'x' });
  assert.strictEqual(m.handle({ type: 'cancel' }).applied, false);
  assert.strictEqual(m.state.composing, false);
  assert.strictEqual(m.state.provisional, '');
  assert.deepStrictEqual(txs, []);
});

// ── 组合结束后的重复 insert（WebKit 会补发）────────────────────────────────

test('⭐ 重复的 `beforeinput`（同 data）被吃掉：⛔ 不许插两遍', function () {
  const { m, txs } = machine();
  m.handle({ type: 'compositionstart', from: 0, to: 0 });
  m.handle({ type: 'compositionend', data: '你好' });
  // 浏览器补发的那一发
  const r = m.handle({ type: 'beforeinput', inputType: 'insertText', data: '你好', from: 0, to: 0, isComposing: false });
  assert.strictEqual(r.applied, false);
  assert.match(r.why, /重复/);
  assert.strictEqual(txs.length, 1, '⛔ 只能有一条事务');
});

test('⭐ 重复的 `input` 同样被吃掉（WebKit 也可能只补这一发）', function () {
  const { m, txs } = machine();
  m.handle({ type: 'compositionstart', from: 0, to: 0 });
  m.handle({ type: 'compositionend', data: '你好' });
  assert.strictEqual(m.handle({ type: 'input', data: '你好', from: 0, to: 0 }).applied, false);
  assert.strictEqual(txs.length, 1);
});

test('⭐ 反例——组合结束后用户**真敲**了别的字，⛔ 不许被吞', function () {
  const { m, txs } = machine();
  m.handle({ type: 'compositionstart', from: 0, to: 0 });
  m.handle({ type: 'compositionend', data: '你好' });
  const r = m.handle({ type: 'beforeinput', inputType: 'insertText', data: '啊', from: 2, to: 2 });
  assert.strictEqual(r.applied, true, '内容不同 ⇒ 那是真的敲字');
  assert.deepStrictEqual(
    txs.map(function (t) { return t.reason; }),
    ['composition', 'insert']
  );
});

test('⭐ 只吞**一发**：第二次相同的 data 照常落事务（⛔ 吞成无底洞）', function () {
  const { m, txs } = machine();
  m.handle({ type: 'compositionstart', from: 0, to: 0 });
  m.handle({ type: 'compositionend', data: '好' });
  m.handle({ type: 'beforeinput', inputType: 'insertText', data: '好', from: 0, to: 0 });
  const r = m.handle({ type: 'beforeinput', inputType: 'insertText', data: '好', from: 1, to: 1 });
  assert.strictEqual(r.applied, true, '用户真的又敲了一个"好"');
  assert.strictEqual(txs.length, 2);
});

test('组合中的 `beforeinput` / `input` 一律不落事务（⛔ 不靠 `isComposing` 单飞）', function () {
  const { m, txs } = machine();
  m.handle({ type: 'compositionstart', from: 0, to: 0 });
  assert.strictEqual(m.handle({ type: 'beforeinput', inputType: 'insertText', data: 'n', from: 0, to: 0 }).applied, false);
  // ⚠️ 反例：`isComposing` 字段缺失（Safari 某些版本）也必须算组合态——靠自己的标志位。
  assert.strictEqual(m.handle({ type: 'input', data: 'n', from: 0, to: 0, isComposing: undefined }).applied, false);
  assert.deepStrictEqual(txs, []);
});

// ── 粘贴 ───────────────────────────────────────────────────────────────────

test('粘贴多行：一条事务，行数组按 `\\n` 切开', function () {
  const { m, txs } = machine();
  m.handle({ type: 'paste', text: '第一行\n第二行\n', from: 4, to: 4 });
  assert.deepStrictEqual(txs.map(shape), [['paste', 4, 4, ['第一行', '第二行', '']]]);
});

test('⭐ 粘贴 CRLF / 裸 CR：`\\r` 永远进不了正文', function () {
  const { m, txs } = machine();
  m.handle({ type: 'paste', text: 'a\r\nb\rc', from: 0, to: 0 });
  assert.deepStrictEqual(txs[0].next, ['a', 'b', 'c']);
  assert.ok(
    txs[0].next.every(function (l) { return l.indexOf('\r') < 0; }),
    '⛔ 正文里出现 `\\r` ⇒ 行号错位 ＋ 下次 Eol::Other 整篇不可编辑'
  );
});

test('空粘贴 / 空输入 ⇒ 不落事务', function () {
  const { m, txs } = machine();
  assert.strictEqual(m.handle({ type: 'paste', text: '', from: 0, to: 0 }).applied, false);
  assert.strictEqual(m.handle({ type: 'beforeinput', inputType: 'insertText', data: '', from: 0, to: 0 }).applied, false);
  assert.deepStrictEqual(txs, []);
});

test('⭐ 组合中粘贴：⛔ 不并进 preedit（那会被 `compositionend` 的 data 覆盖掉 ⇒ 静默丢内容）', function () {
  const { m, txs } = machine();
  m.handle({ type: 'compositionstart', from: 3, to: 3 });
  assert.strictEqual(m.handle({ type: 'paste', text: '粘的', from: 3, to: 3 }).applied, false);
  assert.deepStrictEqual(txs, [], '组合期间仍然一个字节都不动');
  assert.deepStrictEqual(m.state.pending, ['粘的'], '但要**记下来**');

  m.handle({ type: 'compositionend', data: '你' });
  assert.deepStrictEqual(
    txs.map(shape),
    [
      ['composition', 3, 3, ['你']],
      ['paste-after-composition', 4, 4, ['粘的']],
    ],
    '先上屏组合结果、再插粘贴内容（两条事务，两个不同的用户动作）'
  );
});

test('组合取消时，**已经粘贴进来**的内容不许跟着丢', function () {
  const { m, txs } = machine();
  m.handle({ type: 'compositionstart', from: 6, to: 6 });
  m.handle({ type: 'paste', text: 'P', from: 6, to: 6 });
  const r = m.handle({ type: 'cancel' });
  assert.strictEqual(r.applied, true);
  assert.deepStrictEqual(txs.map(shape), [['paste-after-composition', 6, 6, ['P']]]);
});

// ── 对象约束（`design/0054` `INV-EDITOBJ-01`）─────────────────────────────────
//
// ⭐ 这一组的对立面是**同一件事散在三处各写一半**：约束声明只在
//    `live/objects.js` 的策略表，执行只在状态机的 `textIn()` —— ⛔ 但**每一个文本入口**
//    都要过它（粘贴 / 键盘插入 / `input` / IME 上屏）。
// ⚠️ 少一个入口的形态在屏幕上**只有"表格跳一下"看得见**（`Q14b`），
//    而提交出去的字节是对的（`cell.js::encode` 兜住了）⇒ 只靠交付层判据永远发现不了。

test('⭐ 单元格策略：粘贴 CRLF 两行 ⇒ **两行**（`bugs/0035`；⛔ 但没有裸 `\\r` 留下）', function () {
  const { m, txs } = machine(O.CELL);
  m.handle({ type: 'paste', text: '第一行\r\n第二行', from: 2, to: 2 });
  assert.deepStrictEqual(txs.map(shape), [['paste', 2, 2, ['第一行', '第二行']]]);
  assert.strictEqual(txs[0].next.length, 2, '格内换行现在**保留**（提交时写成 `<br>`，`cell.js::encode`）');
  assert.ok(txs[0].next.join('').indexOf('\r') < 0, '⛔ 还留着 `\\r`（归一化必须在前）');
});

test('反例（负对照）：块级策略**原样保留**换行 —— ⛔ 别把默认行为也折了', function () {
  const { m, txs } = machine(O.BLOCK);
  m.handle({ type: 'paste', text: '第一行\n第二行', from: 2, to: 2 });
  assert.deepStrictEqual(txs.map(shape), [['paste', 2, 2, ['第一行', '第二行']]]);
});

test('⭐ 单元格：**IME 上屏**带回来的换行**原样保留**（`bugs/0035`，⛔ 不再折成空格）', function () {
  const { m, txs } = machine(O.CELL);
  m.handle({ type: 'compositionstart', from: 0, to: 0 });
  m.handle({ type: 'compositionupdate', data: 'a\nb' });
  assert.deepStrictEqual(txs, [], '组合期间一个字节都不动（F6 不变）');
  m.handle({ type: 'compositionend', data: 'a\nb' });
  assert.deepStrictEqual(txs.map(shape), [['composition', 0, 0, ['a', 'b']]]);
});

test('⭐ 单元格：组合期间粘贴的那一条也保留换行（⛔ 不是补发时才处理）', function () {
  const { m, txs } = machine(O.CELL);
  m.handle({ type: 'compositionstart', from: 4, to: 4 });
  m.handle({ type: 'paste', text: '甲\n乙', from: 4, to: 4 });
  assert.deepStrictEqual(m.state.pending, ['甲\n乙'], '记下来的就已经是归一化之后的（换行保留）');
  m.handle({ type: 'compositionend', data: '你' });
  assert.deepStrictEqual(txs.map(shape), [
    ['composition', 4, 4, ['你']],
    ['paste-after-composition', 5, 5, ['甲', '乙']],
  ]);
});

test('⭐ 策略仍然作用于**每一个**文本入口（换成一条真会改字的规则再看一遍）', function () {
  // ⚠️ `bugs/0035` 之后 `CELL.text` 是恒等 ⇒ 上面两条**证明不了**"策略被读到了"。
  //    这里用一条会改字的规则（删掉空行）把同一个口径重新钉住：
  //    少挂一处（`compositionend` 或 `paste`）就会露馅。
  const policy = { text: function (t) { return String(t).replace(/\n/g, '|'); } };
  const { m, txs } = machine(policy);
  m.handle({ type: 'paste', text: 'a\nb', from: 0, to: 0 });
  m.handle({ type: 'compositionstart', from: 3, to: 3 });
  m.handle({ type: 'compositionend', data: 'c\nd' });
  assert.deepStrictEqual(txs.map(shape), [
    ['paste', 0, 0, ['a|b']],
    ['composition', 3, 3, ['c|d']],
  ]);
});

test('缺省（不传策略）= 不约束 —— 块级那条老行为一个字节都不许变', function () {
  const { m, txs } = machine();
  m.handle({ type: 'paste', text: 'a\r\nb', from: 0, to: 0 });
  assert.deepStrictEqual(txs.map(shape), [['paste', 0, 0, ['a', 'b']]]);
});

// ── 光标位置 ───────────────────────────────────────────────────────────────

test('组合结束后的光标 = 起点 ＋ **UTF-16 码元**数', function () {
  assert.strictEqual(I.caretAfterComposition(5, '你好'), 7);
  // ⚠️ 反例：按 UTF-8 字节算会得到 5+6=11（中文 3 字节）——那正是本项目最容易踩的错。
  assert.notStrictEqual(I.caretAfterComposition(5, '你好'), 11);
  // Emoji（代理对）按**两个码元**算，与 JS 字符串长度一致。
  assert.strictEqual(I.caretAfterComposition(0, '😀'), 2);
});

test('未处理的事件类型：不落事务但说出来', function () {
  const { m, txs } = machine();
  const r = m.handle({ type: 'keydown' });
  assert.strictEqual(r.applied, false);
  assert.match(r.why, /未处理的事件 keydown/);
  assert.deepStrictEqual(txs, []);
});
