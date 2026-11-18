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

// ── ⭐ `design/0059` C′：组合会话是与**目标文本**绑定的 ──────────────────────
//
// ⚠️ 为什么这几条必须是纯逻辑：组合链路的失效形态是"字落到了别处"或"字没了"，
//    真机 IME 下都**不报错**；而把目标/修订令牌与当前选区对一次是纯函数就能钉死的。

test('⭐ C′：起手记下会话（目标令牌 ＋ 区间），落定用同一份目标 ⇒ 不标记 rebased', function () {
  const { m, txs } = machine();
  const doc1 = { v: 1 };
  m.handle({ type: 'compositionstart', from: 5, to: 5, target: doc1 });
  assert.deepStrictEqual(m.state.session, { from: 5, to: 5, target: doc1, revision: null });
  const r = m.handle({ type: 'compositionend', data: '你好', from: 5, to: 5, target: doc1 });
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.rebased, false, '目标没变，⛔ 不许标成需要重新落定');
  assert.deepStrictEqual(txs.map(shape), [['composition', 5, 5, ['你好']]]);
});

test('⭐⭐ C′：组合期间目标文本变了 ⇒ 按**当前**选区落定并标记 rebased（⛔ 不写旧区间）', function () {
  const { m, txs } = machine();
  const doc1 = { v: 1 };
  const doc2 = { v: 2 };
  m.handle({ type: 'compositionstart', from: 3, to: 3, target: doc1 });
  // 期间别处提交了一笔：文本身份换了（`view.state.doc` 是新的那份）
  const r = m.handle({ type: 'compositionend', data: '好', from: 4, to: 4, target: doc2 });
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.rebased, true, '目标变过就必须标记出来');
  assert.deepStrictEqual(txs.map(shape), [['composition', 4, 4, ['好']]],
    '⛔ 拿起手那一次的旧偏移去写，会落到别的字中间');
});

test('⭐ C′：修订令牌变了也算 rebased（同一份目标对象、文档修订前进）', function () {
  const { m, txs } = machine();
  const doc1 = { v: 1 };
  m.handle({ type: 'compositionstart', from: 2, to: 2, target: doc1, revision: '1:2' });
  const r = m.handle({ type: 'compositionend', data: 'x', from: 6, to: 6, target: doc1, revision: '1:3' });
  assert.strictEqual(r.rebased, true);
  assert.deepStrictEqual(txs.map(shape), [['composition', 6, 6, ['x']]]);
});

test('⭐⭐ C′：目标整份失效（视图已换掉）⇒ 丢弃并说出来，⛔ 不落进任何偏移', function () {
  const { m, txs } = machine();
  const doc1 = { v: 1 };
  const doc2 = { v: 2 };
  m.handle({ type: 'compositionstart', from: 3, to: 3, target: doc1 });
  m.handle({ type: 'paste', text: 'PT', from: 3, to: 3 }); // 组合期粘贴，记在 pending
  // 落定时**没有**当前选区（视图已经拆了）：只剩旧目标 ＋ 新目标，二者不符
  const r = m.handle({ type: 'compositionend', data: '好', target: doc2 });
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.stale, true, '必须标记为过期回包，⛔ 不许静默当成"没这回事"');
  assert.deepStrictEqual(txs, [], '⛔ 不许往任何区间写');
  assert.deepStrictEqual(m.state.pending, [], '目标作废时暂存的粘贴内容也一起作废');
  assert.strictEqual(m.state.composing, false);
  assert.strictEqual(m.state.session, null);
});

test('⭐ C′：取消时补上的粘贴按**当前**选区落定（⛔ 不用起手那一刻的旧偏移）', function () {
  const { m, txs } = machine();
  const doc1 = { v: 1 };
  m.handle({ type: 'compositionstart', from: 2, to: 2, target: doc1 });
  m.handle({ type: 'paste', text: 'P', from: 2, to: 2 });
  const r = m.handle({ type: 'cancel', from: 9, to: 9, target: { v: 2 } });
  assert.strictEqual(r.applied, true);
  assert.deepStrictEqual(txs.map(shape), [['paste-after-composition', 9, 9, ['P']]]);
});

test('⭐ C′：组合期「允许重排」——update 只动临时态，⛔ 不产出文本事务（装饰不受此限）', function () {
  const { m, txs } = machine();
  m.handle({ type: 'compositionstart', from: 0, to: 0 });
  m.handle({ type: 'compositionupdate', data: 'n' });
  m.handle({ type: 'compositionupdate', data: 'ni' });
  assert.deepStrictEqual(txs, [], '文本事务一条都不许有');
  assert.strictEqual(m.state.provisional, 'ni', '临时态照样更新（preedit 靠它排版与重排）');
  assert.strictEqual(m.state.composing, true);
});

// ── 行尾回车（`lineBreakAction`，`bugs/0108`）───────────────────────────────
//
// ⭐ `main.js` 的 Enter 分支把「行尾回车要不要续列表标记」整个交给这个纯函数：
//    `Mardo §2.6` 的 `linePrefix` 是**特性声明的数据**，⛔ 不撒在键盘处理里。
//    判据 = 输入 `(text, plan, from, to)` → 输出动作 `{type, data, from, to}`。

/** 造 `lineBreakAction` 要的 plan 形状（`extra` 补 `quoteLines` / `maxOrdered` 这类新字段）。 */
function planOf(rows, extra) {
  return Object.assign({ listLines: rows }, extra || {});
}

/**
 * 一行 listLine 记录的紧凑工厂。
 * ⚠️ `markerFrom` 缺省 = `from`（普通 `- ` 的标记就在行首）；`number` 缺省 `null`
 * ⇒ 有序项走**旧**的 `parseInt + 1` 路径（旧 plan 的 fail-closed 语义，顺便守住它）。
 */
function li(from, contentFrom, kind, extra) {
  return Object.assign({
    line: 0, from: from, contentFrom: contentFrom, depth: 0, kind: kind, marker: '',
    markerFrom: from, markerRaw: '', number: null,
  }, extra || {});
}

test('⭐ 回车：正文行尾 / plan 缺失 / 行不匹配 / text 为空，一律裸 `\\n`（⛔ 不猜）', function () {
  assert.deepStrictEqual(I.lineBreakAction('abc', null, 3, 3),
    { type: 'insert', data: '\n', from: 3, to: 3 });
  assert.deepStrictEqual(I.lineBreakAction('abc', planOf([]), 3, 3),
    { type: 'insert', data: '\n', from: 3, to: 3 });
  // 记录形状齐全、但行首对不上（装饰层与正文错位）→ 裸 `\n`，⛔ 不拿别的行前缀来续。
  assert.deepStrictEqual(I.lineBreakAction('- 甲', planOf([li(5, 7, 'bullet')]), 3, 3),
    { type: 'insert', data: '\n', from: 3, to: 3 });
  assert.deepStrictEqual(I.lineBreakAction(null, null, 0, 0),
    { type: 'insert', data: '\n', from: 0, to: 0 });
});

test('⭐ 回车：**选区**回车是替换，区间原样带走，⛔ 不续标记', function () {
  assert.deepStrictEqual(I.lineBreakAction('- 甲', planOf([li(0, 2, 'bullet')]), 1, 3),
    { type: 'insert', data: '\n', from: 1, to: 3 });
});

test('⭐ 回车：bullet 行尾续 `- `，缩进与引用前缀按**源码切片**原样保留', function () {
  assert.deepStrictEqual(I.lineBreakAction('- 甲', planOf([li(0, 2, 'bullet')]), 3, 3),
    { type: 'insert', data: '\n- ', from: 3, to: 3 });
  assert.deepStrictEqual(I.lineBreakAction('  - 乙', planOf([li(0, 4, 'bullet')]), 5, 5),
    { type: 'insert', data: '\n  - ', from: 5, to: 5 });
  assert.deepStrictEqual(I.lineBreakAction('> - x', planOf([li(0, 4, 'bullet')]), 5, 5),
    { type: 'insert', data: '\n> - ', from: 5, to: 5 });
});

test('⭐ 回车：ordered 换**下一编号**，标点（`.` / `)`）与尾随空白都保留', function () {
  assert.deepStrictEqual(I.lineBreakAction('3. x', planOf([li(0, 3, 'ordered')]), 4, 4),
    { type: 'insert', data: '\n4. ', from: 4, to: 4 });
  assert.deepStrictEqual(I.lineBreakAction('3) x', planOf([li(0, 3, 'ordered')]), 4, 4),
    { type: 'insert', data: '\n4) ', from: 4, to: 4 });
  assert.deepStrictEqual(I.lineBreakAction('12. x', planOf([li(0, 4, 'ordered')]), 5, 5),
    { type: 'insert', data: '\n13. ', from: 5, to: 5 });
  assert.deepStrictEqual(I.lineBreakAction('3.  x', planOf([li(0, 4, 'ordered')]), 5, 5),
    { type: 'insert', data: '\n4.  ', from: 5, to: 5 });
});

test('⭐ 回车：task 续行换**空框**（⛔ 已勾选的跟着续下去）', function () {
  assert.deepStrictEqual(I.lineBreakAction('- [x] 甲', planOf([li(0, 6, 'task')]), 7, 7),
    { type: 'insert', data: '\n- [ ] ', from: 7, to: 7 });
  assert.deepStrictEqual(I.lineBreakAction('- [X] 甲', planOf([li(0, 6, 'task')]), 7, 7),
    { type: 'insert', data: '\n- [ ] ', from: 7, to: 7 });
  assert.deepStrictEqual(I.lineBreakAction('- [ ] 甲', planOf([li(0, 6, 'task')]), 7, 7),
    { type: 'insert', data: '\n- [ ] ', from: 7, to: 7 });
});

test('⭐ 回车：空 item 是**删标记退列表**（Typora/Obsidian 通用惯例），⛔ 不是续出两个空项', function () {
  assert.deepStrictEqual(I.lineBreakAction('- ', planOf([li(0, 2, 'bullet')]), 2, 2),
    { type: 'delete', data: '', from: 0, to: 2 });
  assert.deepStrictEqual(I.lineBreakAction('- \n', planOf([li(0, 2, 'bullet')]), 2, 2),
    { type: 'delete', data: '', from: 0, to: 2 });
  assert.deepStrictEqual(I.lineBreakAction('3. ', planOf([li(0, 3, 'ordered')]), 3, 3),
    { type: 'delete', data: '', from: 0, to: 3 });
});

test('⭐ 回车：列表行**行中**回车也把当前项一分为二、新项续出同品种前缀（`bugs/0110`）', function () {
  assert.deepStrictEqual(I.lineBreakAction('- 甲乙', planOf([li(0, 2, 'bullet')]), 3, 3),
    { type: 'insert', data: '\n- ', from: 3, to: 3 });
  assert.deepStrictEqual(I.lineBreakAction('3. 甲乙', planOf([li(0, 3, 'ordered')]), 5, 5),
    { type: 'insert', data: '\n4. ', from: 5, to: 5 });
  assert.deepStrictEqual(I.lineBreakAction('- [x] 甲乙', planOf([li(0, 6, 'task')]), 7, 7),
    { type: 'insert', data: '\n- [ ] ', from: 7, to: 7 });
  assert.deepStrictEqual(I.lineBreakAction('> - 甲乙', planOf([li(0, 4, 'bullet')]), 5, 5),
    { type: 'insert', data: '\n> - ', from: 5, to: 5 });
  // 正文行行中回车仍是裸 `\n`（断行，不是续列表）。
  assert.deepStrictEqual(I.lineBreakAction('正文', planOf([]), 1, 1),
    { type: 'insert', data: '\n', from: 1, to: 1 });
});

// ⭐⭐ `bugs/0300` 现象二（2026-11-09 用户裁定）：「最后一行，输入 enter 之后，还是没有继承
//    上一行的 todo Item」⇒ 列表项的**续行**（`kind === 'plain'`）回车要续出**所属项**的品种。
//    ⚠️ 前缀从**项那一行**切（缩进 / `> ` / 标记原样），插入点仍落在**当前续行**上。
test('⭐ 回车：**续行**回车继承所属列表项的品种（`bugs/0300` 现象二，用户裁定）', function () {
  // 任务项：`- [ ] 甲` + 续行 ⇒ 续出空框（⛔ 已勾选的跟着续下去）。
  const 任务 = '- [ ] 甲\n  续行';
  assert.deepStrictEqual(
    I.lineBreakAction(任务, planOf([li(0, 6, 'task'), li(8, 10, 'plain')]), 11, 11),
    { type: 'insert', data: '\n- [ ] ', from: 11, to: 11 });
  // 已勾选的项：续行同样续出**空框**。
  assert.deepStrictEqual(
    I.lineBreakAction('- [x] 甲\n  续行', planOf([li(0, 6, 'task'), li(8, 10, 'plain')]), 11, 11),
    { type: 'insert', data: '\n- [ ] ', from: 11, to: 11 });
  // 无序项：续 `- `；嵌套项连缩进一起（前缀切的是项那一行）。
  assert.deepStrictEqual(
    I.lineBreakAction('- 甲\n  续行', planOf([li(0, 2, 'bullet'), li(4, 6, 'plain')]), 7, 7),
    { type: 'insert', data: '\n- ', from: 7, to: 7 });
  assert.deepStrictEqual(
    I.lineBreakAction('  - 甲\n    续行', planOf([li(0, 4, 'bullet'), li(6, 10, 'plain')]), 11, 11),
    { type: 'insert', data: '\n  - ', from: 11, to: 11 });
  // 有序项：续**下一编号**（编号取自项那一行，不是续行）。
  assert.deepStrictEqual(
    I.lineBreakAction('3. 甲\n   续行', planOf([li(0, 3, 'ordered'), li(5, 8, 'plain')]), 9, 9),
    { type: 'insert', data: '\n4. ', from: 9, to: 9 });
  // 引用块里的任务项：`> ` 原样保留。
  assert.deepStrictEqual(
    I.lineBreakAction('> - [ ] 甲\n>   续行', planOf([li(0, 8, 'task'), li(10, 14, 'plain')]), 15, 15),
    { type: 'insert', data: '\n> - [ ] ', from: 15, to: 15 });
  // 行中回车也续（与项行同口径：断成两项）。
  //  ⚠️ 插入点用 **11**（正文中），⛔ 不是 10：10 是续行正文起点，`bugs/0314` 之后那里
  //     插裸 `\n`（行首/缩进内语义，见下面 0314 那条），不再续前缀。
  assert.deepStrictEqual(
    I.lineBreakAction('- [ ] 甲\n  续行', planOf([li(0, 6, 'task'), li(8, 10, 'plain')]), 11, 11),
    { type: 'insert', data: '\n- [ ] ', from: 11, to: 11 });
  // 深度：续行深度**比紧挨着的那条项浅** ⇒ 那条项不是它的所属项，继续往上找
  //（嵌套项的内层续行绝不能把外层项的标记当自己的）。
  assert.deepStrictEqual(
    I.lineBreakAction('1. 甲\n   - 乙\n   乙续行', planOf([
      { line: 0, from: 0, contentFrom: 3, depth: 0, kind: 'ordered', marker: '1', code: false },
      { line: 1, from: 5, contentFrom: 10, depth: 1, kind: 'bullet', marker: '-', code: false },
      { line: 2, from: 12, contentFrom: 15, depth: 0, kind: 'plain', marker: '', code: false },
    ]), 17, 17),
    { type: 'insert', data: '\n2. ', from: 17, to: 17 });
});

test('⭐ 回车：续行**没有所属项**（块首 / 前面没有列表项）仍是裸 `\\n`', function () {
  // 续行在块首：往上没有非 `plain` 行。
  assert.deepStrictEqual(I.lineBreakAction('  续行', planOf([li(0, 2, 'plain')]), 4, 4),
    { type: 'insert', data: '\n', from: 4, to: 4 });
});

// ⭐⭐ `bugs/0314`（2026-11-12 核准）：续行**行首 / 缩进内**回车 ⛔ 不续前缀。
//    判据 = `from <= 本行记录的 contentFrom`；行中 / 行尾仍走 `0300` 现象二。
test('⭐ 回车：续行**行首 / 正文起点**插裸 `\\n`，⛔ 不续前缀、⛔ 不抬回 contentFrom（`bugs/0314`）', function () {
  const 源 = '- 甲\n  续行';
  const 计划 = planOf([
    li(0, 2, 'bullet'),
    { line: 1, from: 4, contentFrom: 6, depth: 0, kind: 'plain', marker: '',
      markerFrom: 4, markerRaw: '', number: null, code: false },
  ]);
  // 行首（缩进之前）：整行（含缩进）留在下面，新行是列表项里的第二个段落（空行）。
  assert.deepStrictEqual(I.lineBreakAction(源, 计划, 4, 4),
    { type: 'insert', data: '\n', from: 4, to: 4 });
  // 正文起点（缩进之后、"续"之前）：同样是裸 `\n`——这正是 `0314` 报的那一下。
  assert.deepStrictEqual(I.lineBreakAction(源, 计划, 6, 6),
    { type: 'insert', data: '\n', from: 6, to: 6 });
  // 反面（`0300` 现象二保持不变）：行中仍续前缀，插入点就是光标处。
  assert.deepStrictEqual(I.lineBreakAction(源, 计划, 7, 7),
    { type: 'insert', data: '\n- ', from: 7, to: 7 });
  // ⚠️ 记录与行首对不上（旧 plan / 错位）⇒ 没有 `li`，仍是裸 `\n`（fail-closed）。
  assert.deepStrictEqual(
    I.lineBreakAction(源, planOf([{ line: 0, from: 3, contentFrom: 5, depth: 0, kind: 'plain', marker: '' }]), 3, 3),
    { type: 'insert', data: '\n', from: 3, to: 3 });
});

// ⭐⭐ `bugs/0111` A1（2026-11-12 核准）：引用行回车续 `> `（多层就是 `> > `）。
test('⭐ 回车：引用行续 `> `，空引用行**退出引用**（`bugs/0111` A1）', function () {
  const 引用 = function (from, contentFrom, blank) {
    return { line: 0, from: from, markerFrom: from, contentFrom: contentFrom, blank: blank };
  };
  const 一行 = function (q) { return planOf([], { quoteLines: [q] }); };
  // 行尾 / 行中：新行写 `> `（`from` 原样，⛔ 不收敛）。
  assert.deepStrictEqual(I.lineBreakAction('> foo', 一行(引用(0, 2, false)), 5, 5),
    { type: 'insert', data: '\n> ', from: 5, to: 5 });
  assert.deepStrictEqual(I.lineBreakAction('> foo', 一行(引用(0, 2, false)), 3, 3),
    { type: 'insert', data: '\n> ', from: 3, to: 3 });
  // 空引用行：删整条前缀链 = 退出引用，⛔ 不产 `> > `。
  assert.deepStrictEqual(I.lineBreakAction('> ', 一行(引用(0, 2, true)), 2, 2),
    { type: 'delete', data: '', from: 0, to: 2 });
  assert.deepStrictEqual(I.lineBreakAction('>', 一行(引用(0, 1, true)), 1, 1),
    { type: 'delete', data: '', from: 0, to: 1 });
  // ⚠️ 光标在标记区里（`from < contentFrom`）⇒ 按行首插入处理，⛔ 不删标记。
  assert.deepStrictEqual(I.lineBreakAction('> ', 一行(引用(0, 2, true)), 0, 0),
    { type: 'insert', data: '\n', from: 0, to: 0 });
});

test('⭐ 回车：多层引用续 `> > `（`bugs/0111` A1）', function () {
  const 计划 = planOf([], {
    quoteLines: [{ line: 0, from: 0, markerFrom: 0, contentFrom: 4, blank: false }],
  });
  assert.deepStrictEqual(I.lineBreakAction('> > foo', 计划, 7, 7),
    { type: 'insert', data: '\n> > ', from: 7, to: 7 });
});

// ⭐⭐ `bugs/0111` A2：引用内空列表项回车只退**列表那一层**（`> ` 留下）。
test('⭐ 回车：空列表项的删除跨度从 `markerFrom` 起，⛔ 不吞 `> `（`bugs/0111` A2）', function () {
  assert.deepStrictEqual(
    I.lineBreakAction('> - ', planOf([li(0, 4, 'bullet', { markerFrom: 2, markerRaw: '-' })]), 4, 4),
    { type: 'delete', data: '', from: 2, to: 4 });
  // 普通 `- `：`markerFrom` 就是行首（缺省）⇒ 与旧行为完全相同。
  assert.deepStrictEqual(I.lineBreakAction('- ', planOf([li(0, 2, 'bullet')]), 2, 2),
    { type: 'delete', data: '', from: 0, to: 2 });
  // 嵌套项（`bugs/0116` §10 起）：空项回车**先升一级** ⇒ 只删缩进那一层，标记留在原处
  // （旧行为是连 `- ` 一起删、整条列表当场结束；Notion / Mardo 不是这样）。删到最外层之后
  // 再回车才走上面那条"删标记退列表"。
  assert.deepStrictEqual(
    I.lineBreakAction('- 甲\n  - ', planOf([
      li(0, 2, 'bullet'),
      li(4, 8, 'bullet', { line: 1, markerFrom: 6, markerRaw: '-' }),
    ]), 8, 8),
    { type: 'delete', data: '', from: 4, to: 6, sel: { anchor: 6, head: 6 } });
  // 旧 plan（没有 `markerFrom`）⇒ fail-closed 退回 `li.from`。
  assert.deepStrictEqual(
    I.lineBreakAction('- ', planOf([{ line: 0, from: 0, contentFrom: 2, depth: 0, kind: 'bullet', marker: '' }]), 2, 2),
    { type: 'delete', data: '', from: 0, to: 2 });
});

// ⭐⭐ `bugs/0111` A3：编号只认装饰层按**位置**给出的 `number`，⛔ 不再从源码 `parseInt + 1`。
test('⭐ 回车：有序编号取 `number + 1`（`1. 甲 / 1. 乙` ⇒ 第二项续 `3. `，`bugs/0111` A3）', function () {
  const 源 = '1. 甲\n1. 乙';
  const 计划 = planOf([
    li(0, 3, 'ordered', { line: 0, number: 1, marker: '1.', markerRaw: '1.' }),
    li(5, 8, 'ordered', { line: 1, number: 2, marker: '2.', markerRaw: '1.' }),
  ]);
  assert.deepStrictEqual(I.lineBreakAction(源, 计划, 9, 9),
    { type: 'insert', data: '\n3. ', from: 9, to: 9 });
  // 标点取**源码原始标记**：`1)` 续 `2)`。
  assert.deepStrictEqual(
    I.lineBreakAction('1) 甲', planOf([li(0, 3, 'ordered', { number: 1, marker: '1.', markerRaw: '1)' })]), 4, 4),
    { type: 'insert', data: '\n2) ', from: 4, to: 4 });
  // 编号上限：`999999999` 是最后一个合法编号 ⇒ 新行 fail-closed 到裸 `\n`（`bugs/0315` 方案 B）。
  assert.deepStrictEqual(
    I.lineBreakAction('999999999. x', planOf([
      li(0, 11, 'ordered', { number: 999999999, marker: '999999999.', markerRaw: '999999999.' }),
    ], { maxOrdered: 999999999 }), 12, 12),
    { type: 'insert', data: '\n', from: 12, to: 12 });
  // 反面：`999999998` ⇒ 写 `999999999. `（合法上界本身仍能续）。
  assert.deepStrictEqual(
    I.lineBreakAction('999999998. x', planOf([
      li(0, 11, 'ordered', { number: 999999998, marker: '999999998.', markerRaw: '999999998.' }),
    ], { maxOrdered: 999999999 }), 12, 12),
    { type: 'insert', data: '\n999999999. ', from: 12, to: 12 });
  // 缺 `maxOrdered` ⇒ 缺省 `999999999`（同上限，⛔ 不写成 `NaN`）。
  assert.deepStrictEqual(
    I.lineBreakAction('999999999. x', planOf([
      li(0, 11, 'ordered', { number: 999999999, marker: '999999999.', markerRaw: '999999999.' }),
    ]), 12, 12),
    { type: 'insert', data: '\n', from: 12, to: 12 });
});

// ⭐⭐ 旧 plan 的 fail-closed（`bugs/0111` 不变量：缺字段⛔ 不抛异常、退回旧行为）。
test('⭐ 回车：旧 plan 缺 `quoteLines` / `number` / `markerRaw` ⇒ 行为与旧版完全一致', function () {
  // `quoteLines` 缺失 ⇒ 引用行仍是裸 `\n`。
  assert.deepStrictEqual(I.lineBreakAction('> foo', planOf([]), 5, 5),
    { type: 'insert', data: '\n', from: 5, to: 5 });
  assert.deepStrictEqual(I.lineBreakAction('> ', planOf([]), 2, 2),
    { type: 'insert', data: '\n', from: 2, to: 2 });
  // `number` 缺失（`li()` 缺省 null）⇒ 仍从 prefix 里 `parseInt + 1`。
  assert.deepStrictEqual(
    I.lineBreakAction('3. x', planOf([{ line: 0, from: 0, contentFrom: 3, depth: 0, kind: 'ordered', marker: '3.' }]), 4, 4),
    { type: 'insert', data: '\n4. ', from: 4, to: 4 });
  // quoteLines 记录缺 `contentFrom` ⇒ fail-closed 到裸 `\n`。
  assert.deepStrictEqual(
    I.lineBreakAction('> foo', planOf([], { quoteLines: [{ line: 0, from: 0, blank: false }] }), 5, 5),
    { type: 'insert', data: '\n', from: 5, to: 5 });
});


test('⭐ 回车：**代码行**（`code: true`）不算续行，⛔ 不往围栏里塞前缀（`bugs/0300` 现象二）', function () {
  const 源 = '- 条目\n\n  ```\n  代码一行\n  ```\n';
  const 行 = [
    li(0, 2, 'bullet'),
    { line: 1, from: 5, contentFrom: 5, depth: 0, kind: 'plain', marker: '', code: false },
    { line: 2, from: 6, contentFrom: 6, depth: 0, kind: 'plain', marker: '', code: false },
    { line: 3, from: 12, contentFrom: 12, depth: 0, kind: 'plain', marker: '', code: true },
    { line: 4, from: 19, contentFrom: 19, depth: 0, kind: 'plain', marker: '', code: false },
  ];
  // 代码行行尾回车 ⇒ 裸 `\n`（代码里的缩进与内容一个字节都不动）。
  assert.deepStrictEqual(I.lineBreakAction(源, planOf(行), 18, 18),
    { type: 'insert', data: '\n', from: 18, to: 18 });
  // 对照：紧跟其后的围栏收尾行（同样在项内、同样带缩进）仍能继承。
  assert.deepStrictEqual(I.lineBreakAction('- 条目\n\n  续行', planOf([
    li(0, 2, 'bullet'),
    { line: 1, from: 5, contentFrom: 5, depth: 0, kind: 'plain', marker: '', code: false },
    { line: 2, from: 6, contentFrom: 8, depth: 0, kind: 'plain', marker: '', code: false },
  ]), 10, 10), { type: 'insert', data: '\n- ', from: 10, to: 10 });
});

test('⭐ 回车：光标落在隐藏标记区（行首）⇒ 插入点收敛到正文起点，⛔ 不劈开标记', function () {
  // `from < contentFrom`：新起一个空项在上，原项原样留在下面（`bugs/0105` 的同族语义）。
  assert.deepStrictEqual(I.lineBreakAction('- 甲乙', planOf([li(0, 2, 'bullet')]), 0, 0),
    { type: 'insert', data: '\n- ', from: 2, to: 2 });
  assert.deepStrictEqual(I.lineBreakAction('- [x] 甲乙', planOf([li(0, 6, 'task')]), 0, 0),
    { type: 'insert', data: '\n- [ ] ', from: 6, to: 6 });
  // 光标正在正文起点：同样收敛（插入点就是它自己，零变化）。
  assert.deepStrictEqual(I.lineBreakAction('- 甲乙', planOf([li(0, 2, 'bullet')]), 2, 2),
    { type: 'insert', data: '\n- ', from: 2, to: 2 });
});

test('⭐ 回车：行尾纯空白里的光标收敛到行末（尾随空白留在原行）', function () {
  assert.deepStrictEqual(I.lineBreakAction('- 甲  ', planOf([li(0, 2, 'bullet')]), 3, 3),
    { type: 'insert', data: '\n- ', from: 5, to: 5 });
  assert.deepStrictEqual(I.lineBreakAction('- 甲  ', planOf([li(0, 2, 'bullet')]), 4, 4),
    { type: 'insert', data: '\n- ', from: 5, to: 5 });
});

test('⭐ 回车：机器层 `insertLineBreak` 的 `data` 含 `\\n` 时拆成两条（前缀成第二行）', function () {
  const { m, txs } = machine();
  const r = m.handle({ type: 'beforeinput', inputType: 'insertLineBreak', data: '\n- ', from: 3, to: 3 });
  assert.strictEqual(r.applied, true);
  assert.deepStrictEqual(txs.map(shape), [['insert', 3, 3, ['', '- ']]]);
});

// ── 空标题标记链后的分隔空格（`headingSpaceInsert`，`bugs/0311`）────────────────
//
// ⚠️ 这一族错在屏幕上**不报错**：`##` 单独立着时是**空 ATX 标题**（标记恒藏、看不见空格），
//    接着敲正文就退化成段落、`##` 变回可见字符 —— 用户只看到"标题没渲染出来"。
//    ⚠️ 中文输入法的"空格"是上屏候选，⛔ 不产生字面空格 ⇒ 用户根本打不出那个分隔符。

test('⭐ 空标题：光标在 `##` 末尾、链后到行末全空白 ⇒ 插入的文本前面补一个空格', function () {
  assert.strictEqual(I.headingSpaceInsert('##', 0, 2, 2, '地', null), ' 地');
  assert.strictEqual(I.headingSpaceInsert('###', 0, 3, 3, '地方金额', null), ' 地方金额');
  assert.strictEqual(I.headingSpaceInsert('#', 0, 1, 1, '甲', null), ' 甲');
  // 链后已有空白（例如 `## ` 的隐藏区间右缘）⇒ 空格本来就在，⛔ 不重复补。
  assert.strictEqual(I.headingSpaceInsert('## ', 0, 3, 3, '地', null), null);
  assert.strictEqual(I.headingSpaceInsert('##  ', 0, 3, 3, '地', null), null, '光标在空白中间也不补');
});

test('⭐ 空标题：只在光标**正好**在链尾时触发（⛔ 不抢行中、不抢别的字符）', function () {
  assert.strictEqual(I.headingSpaceInsert('## 甲', 0, 2, 2, '地', null), null, '链后已有正文 ⇒ 已不是标题，别去"修"');
  assert.strictEqual(I.headingSpaceInsert('##', 0, 1, 1, '地', null), null, '光标在链中');
  assert.strictEqual(I.headingSpaceInsert('abc', 0, 3, 3, '地', null), null, '不是标记链');
  assert.strictEqual(I.headingSpaceInsert(' ##', 0, 3, 3, '地', null), null, '有缩进 ⇒ 不顶行首');
  assert.strictEqual(I.headingSpaceInsert('> ##', 0, 4, 4, '地', null), null, '引用前缀不在此列');
});

test('⭐ 空标题：反例三条 —— 空格 / `#` / 替换选区都不补', function () {
  assert.strictEqual(I.headingSpaceInsert('##', 0, 2, 2, ' ', null), null, '用户自己打了空格');
  assert.strictEqual(I.headingSpaceInsert('##', 0, 2, 2, '#', null), null, '`##` → `###` 是延长标记链');
  assert.strictEqual(I.headingSpaceInsert('##', 0, 2, 2, '地', null) !== null, true);
  assert.strictEqual(I.headingSpaceInsert('##', 0, 2, 3, '地', null), null, '替换选区');
  assert.strictEqual(I.headingSpaceInsert('#######', 0, 7, 7, '地', null), null, '7 个 `#` 不是标题');
  assert.strictEqual(I.headingSpaceInsert('##', 0, 2, 2, '\n- ', null), null, '回车那条路不补');
});

test('⭐ 空标题：代码块里的 `###` 是内容 ⇒ 一律不补（`plan.codeLines`）', function () {
  const plan = { codeLines: { 0: true, 2: true } };
  assert.strictEqual(I.headingSpaceInsert('###', 0, 3, 3, 'x', plan), null);
  assert.strictEqual(I.headingSpaceInsert('###', 1, 3, 3, 'x', plan), ' x', '代码块外的行照旧补');
  assert.strictEqual(I.headingSpaceInsert('###', 0, 3, 3, 'x', null), ' x', '没有 plan ⇒ 不排除');
});
