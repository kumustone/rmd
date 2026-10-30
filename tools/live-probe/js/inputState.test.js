'use strict';

// ⭐ 关键契约 3「自研输入层是否完整」的**状态机半**（`docs/design/0047` §2.7）。
//
// ⚠️ 这个文件**答不了"WebKit 的真实事件顺序"**——那必须由离屏探针在真 WKWebView 里量
// （`make probe-vim-keys` 同族的做法）。它答的是另一半，而且是不能靠人眼验的那一半：
//
// **给定一串事件，应该产出几条事务、每条改哪里、会不会重复插入。**
//
// 三条最容易出事的形态：
// ① 组合期间动了文档 ⇒ 版面重排（直接违反 P1 强需求「只有输入在动」）；
// ② 组合结束落了两条事务 ⇒ 字**插了两遍**；
// ③ 粘贴带 `\r` 进 `fullText` ⇒ 全文模型不再是"恒 LF"，下一次 `Envelope::detect`
//    算出来是 `Eol::Other` ⇒ **整篇变不可编辑**。

const test = require('node:test');
const assert = require('node:assert');

const { createInputMachine, caretAfterComposition } = require('./inputState');

function harness() {
  const txs = [];
  const m = createInputMachine((tx) => txs.push(tx));
  return { m, txs };
}

test('输入层·组合生命周期只落一条事务', async (t) => {
  await t.test('start → update×3 → end ⇒ 恰好 1 条事务', () => {
    const { m, txs } = harness();
    m.handle({ type: 'compositionstart', from: 3, to: 3 });
    m.handle({ type: 'compositionupdate', data: 'n' });
    m.handle({ type: 'compositionupdate', data: 'ni' });
    m.handle({ type: 'compositionupdate', data: '你' });
    assert.strictEqual(txs.length, 0, '组合期间 ⛔ 不动文档');
    m.handle({ type: 'compositionend', data: '你' });
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].reason, 'composition');
    assert.strictEqual(txs[0].from, 3);
    assert.strictEqual(txs[0].to, 3);
    assert.deepStrictEqual(txs[0].next, ['你']);
  });

  await t.test('组合替换选区（from ≠ to）也只用一条事务', () => {
    const { m, txs } = harness();
    m.handle({ type: 'compositionstart', from: 2, to: 5 });
    m.handle({ type: 'compositionupdate', data: '新' });
    m.handle({ type: 'compositionend', data: '新' });
    assert.strictEqual(txs.length, 1);
    assert.deepStrictEqual({ from: txs[0].from, to: txs[0].to }, { from: 2, to: 5 });
  });

  await t.test('⭐ 组合期间的 `input`（isComposing=true）必须被忽略', () => {
    const { m, txs } = harness();
    m.handle({ type: 'compositionstart', from: 0, to: 0 });
    const r = m.handle({ type: 'input', data: 'n', isComposing: true, from: 0, to: 1 });
    assert.strictEqual(r.applied, false);
    assert.match(r.why, /组合中的 input/);
    assert.strictEqual(txs.length, 0);
  });

  await t.test('⭐⭐ WebKit 补发的那次重复 input 必须被吃掉（否则插两遍）', () => {
    const { m, txs } = harness();
    m.handle({ type: 'compositionstart', from: 0, to: 0 });
    m.handle({ type: 'compositionend', data: '你' });
    const dup = m.handle({ type: 'input', data: '你', isComposing: false, from: 0, to: 1 });
    assert.strictEqual(dup.applied, false);
    assert.match(dup.why, /重复 input/);
    assert.strictEqual(txs.length, 1, '总事务数仍是 1');
    assert.strictEqual(m.state.swallowInput, false, '吃掉一次后标志复位');
  });

  await t.test('吃掉重复 input 之后的下一次真 input 正常落', () => {
    const { m, txs } = harness();
    m.handle({ type: 'compositionstart', from: 0, to: 0 });
    m.handle({ type: 'compositionend', data: '你' });
    m.handle({ type: 'input', data: '你', isComposing: false, from: 0, to: 1 }); // 重复
    m.handle({ type: 'input', data: '好', isComposing: false, from: 1, to: 1 });
    assert.strictEqual(txs.length, 2);
    assert.deepStrictEqual(txs[1].next, ['好']);
  });

  await t.test('组合期间累计位移为 0 ⇒ 状态机层面就是"文档没变"', () => {
    const { m, txs } = harness();
    m.handle({ type: 'compositionstart', from: 0, to: 0 });
    for (let i = 1; i <= 15; i++) m.handle({ type: 'compositionupdate', data: 'x'.repeat(i) });
    assert.strictEqual(txs.length, 0, '15 次 update 之后仍然 0 条事务');
    // 临时态在增长，但它不进文档
    assert.strictEqual(m.state.provisional.length, 15);
    assert.strictEqual(m.state.composing, true);
  });

  await t.test('Escape 取消组合 ⇒ 不落事务', () => {
    const { m, txs } = harness();
    m.handle({ type: 'compositionstart', from: 0, to: 0 });
    m.handle({ type: 'compositionupdate', data: '你' });
    const r = m.handle({ type: 'cancel' });
    assert.strictEqual(r.applied, false);
    assert.match(r.why, /取消/);
    assert.strictEqual(txs.length, 0);
    assert.strictEqual(m.state.composing, false);
    assert.strictEqual(m.state.provisional, '');
  });

  await t.test('compositionend 带空结果 ⇒ 当作取消，且不吞掉后续 input', () => {
    const { m, txs } = harness();
    m.handle({ type: 'compositionstart', from: 0, to: 0 });
    m.handle({ type: 'compositionupdate', data: '你' });
    const r = m.handle({ type: 'compositionend', data: '' });
    assert.strictEqual(r.applied, false);
    assert.strictEqual(m.state.swallowInput, false);
    m.handle({ type: 'input', data: 'x', isComposing: false, from: 0, to: 0 });
    assert.strictEqual(txs.length, 1);
  });

  await t.test('组合态漏掉 isComposing 字段也认（自己那个标志位兜底）', () => {
    const { m, txs } = harness();
    m.handle({ type: 'compositionstart', from: 0, to: 0 });
    // ⚠️ Safari 某些版本在 input 上不给 isComposing
    const r = m.handle({ type: 'input', data: 'n', from: 0, to: 1 });
    assert.strictEqual(r.applied, false);
    assert.strictEqual(txs.length, 0);
  });

  await t.test('没有 compositionstart 的裸 input 正常工作', () => {
    const { m, txs } = harness();
    const r = m.handle({ type: 'input', data: 'a', isComposing: false, from: 1, to: 1 });
    assert.strictEqual(r.applied, true);
    assert.deepStrictEqual(txs[0].next, ['a']);
  });
});

test('输入层·粘贴必须把 CRLF/CR 归一成 LF', async (t) => {
  await t.test('CRLF 粘贴 ⇒ 事务里一个 `\\r` 都没有', () => {
    const { m, txs } = harness();
    const r = m.handle({ type: 'paste', text: 'a\r\nb\r\n', from: 0, to: 0 });
    assert.strictEqual(r.applied, true);
    assert.deepStrictEqual(txs[0].next, ['a', 'b', '']);
    assert.ok(!txs[0].next.join('\n').includes('\r'), '⛔ `\\r` 不许进 fullText');
  });

  await t.test('裸 CR 也归一', () => {
    const { m, txs } = harness();
    m.handle({ type: 'paste', text: 'a\rb', from: 0, to: 0 });
    assert.deepStrictEqual(txs[0].next, ['a', 'b']);
  });

  await t.test('多行粘贴是**一条**事务（不是逐行）', () => {
    const { m, txs } = harness();
    m.handle({ type: 'paste', text: '一\n二\n三', from: 0, to: 0 });
    assert.strictEqual(txs.length, 1);
    assert.deepStrictEqual(txs[0].next, ['一', '二', '三']);
  });

  await t.test('普通 input 里的 CRLF 同样归一（不只是 paste）', () => {
    const { m, txs } = harness();
    m.handle({ type: 'input', data: 'a\r\nb', isComposing: false, from: 0, to: 0 });
    assert.deepStrictEqual(txs[0].next, ['a', 'b']);
  });

  await t.test('空粘贴不落事务', () => {
    const { m, txs } = harness();
    const r = m.handle({ type: 'paste', text: '', from: 0, to: 0 });
    assert.strictEqual(r.applied, false);
    assert.strictEqual(txs.length, 0);
  });

  await t.test('组合中粘贴 ⇒ 并进临时态，文档不动', () => {
    const { m, txs } = harness();
    m.handle({ type: 'compositionstart', from: 0, to: 0 });
    m.handle({ type: 'compositionupdate', data: '你' });
    const r = m.handle({ type: 'paste', text: 'X', from: 0, to: 0 });
    assert.strictEqual(r.applied, false);
    assert.match(r.why, /组合中粘贴/);
    assert.strictEqual(m.state.provisional, '你X');
    assert.strictEqual(txs.length, 0);
  });
});

test('输入层·光标按 UTF-16 码元计', async (t) => {
  await t.test('ASCII：3 + 2 = 5', () => {
    assert.strictEqual(caretAfterComposition(3, 'ab'), 5);
  });

  await t.test('中文：一个字算 1', () => {
    assert.strictEqual(caretAfterComposition(0, '你好'), 2);
  });

  await t.test('⭐ Emoji 是代理对 ⇒ 一个字算 2（与 offset.rs 的 UTF-16 口径一致）', () => {
    assert.strictEqual('🙂'.length, 2);
    assert.strictEqual(caretAfterComposition(0, '🙂'), 2);
  });

  await t.test('混合：中文 + Emoji', () => {
    assert.strictEqual(caretAfterComposition(10, '你🙂'), 13);
  });

  await t.test('⚠️ 本项目口径是码元，⛔ 不是字素簇（组合字符仍各算 1）', () => {
    const e = 'é'; // e + 组合重音
    assert.strictEqual(caretAfterComposition(0, e), 2);
    // 用 Intl.Segmenter 数一下"字素簇"是 1 ⇒ 两个口径确实不同
    const graphemes = [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(e)];
    assert.strictEqual(graphemes.length, 1);
  });
});
