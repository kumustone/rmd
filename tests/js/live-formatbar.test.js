// `design/0061` L4：**选中浮动格式栏**的纯逻辑判据。
//
// ⚠️ 这一份只测 `src/live/formatbar.js` 里那四个**不碰 DOM / CM6** 的决策函数：
//    `toggleInline` / `togglePrefix` / `headingLevel` / `insertLink`（＋ `commandPlan`）。
//    浮层本体的定位与鼠标手感属于可见窗口 / 真机，留人工；能用 node 钉住的只有"改哪几个字节"。
//
// ⭐ 每条都要正反例的理由：这些函数错一次**不会报错**——只会静默改错一段源码，
//    而 `design/0061` 的前提正是"屏幕上看不见标记"，用户没有任何视觉线索能发现它。
//    ⇒ 判据按**源码字节**写，⛔ 不按"看起来对不对"。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const F = require('../../src/live/formatbar.js');

/**
 * 按 `EditPlan` 把变更应用到源码上（与 CM6 `dispatch({changes})` 同一口径：
 * 所有 `from/to` 都是**原始坐标**，按升序拼接；同一位置的多条插入**保持数组顺序**
 * ——`insertLink` 的 `[` 与 `](url)` 就是同一位置的两条）。
 * @param {string} text
 * @param {{changes:Array<{from:number,to:number,insert:string}>}} plan
 * @returns {string}
 */
function apply(text, plan) {
  let out = '';
  let pos = 0;
  const list = plan.changes.slice().sort(function (a, b) {
    return a.from - b.from || a.to - b.to;
  });
  for (const c of list) {
    out += text.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + text.slice(pos);
}

// ── toggleInline ────────────────────────────────────────────────────────────

test('行内标记：未包裹 ⇒ 两侧各加一层，选区仍圈住原文', function () {
  const plan = F.toggleInline('abc', 1, 2, '**');
  assert.ok(plan);
  assert.strictEqual(apply('abc', plan), 'a**b**c');
  assert.deepStrictEqual(plan.selection, { anchor: 3, head: 4 });
});

test('行内标记：两侧紧邻同一标记 ⇒ 各剥一层（`**` / `*` / `` ` `` / `~~`）', function () {
  const cases = [
    { text: 'a**b**c', marker: '**', out: 'abc', sel: [3, 4] },
    { text: 'a*b*c', marker: '*', out: 'abc', sel: [2, 3] },
    { text: 'a`b`c', marker: '`', out: 'abc', sel: [2, 3] },
    { text: 'a~~b~~c', marker: '~~', out: 'abc', sel: [3, 4] },
  ];
  cases.forEach(function (c) {
    const plan = F.toggleInline(c.text, c.sel[0], c.sel[1], c.marker);
    assert.ok(plan, JSON.stringify(c));
    assert.strictEqual(apply(c.text, plan), c.out, JSON.stringify(c));
    assert.deepStrictEqual(plan.selection, { anchor: 1, head: 2 }, JSON.stringify(c));
  });
});

test('行内标记：空选区 ⇒ 插入一对标记，光标在正中间', function () {
  const plan = F.toggleInline('ab', 1, 1, '**');
  assert.ok(plan);
  assert.strictEqual(apply('ab', plan), 'a****b');
  assert.deepStrictEqual(plan.selection, { anchor: 3, head: 3 });
});

test('行内标记：中文按 UTF-16 偏移算，⛔ 不按字节', function () {
  const text = '前中后';
  const plan = F.toggleInline(text, 1, 2, '`');
  assert.ok(plan);
  assert.strictEqual(apply(text, plan), '前`中`后');
  assert.deepStrictEqual(plan.selection, { anchor: 2, head: 3 });
});

test('行内标记：反向选区保方向，⛔ 不归一化后丢端', function () {
  const plan = F.toggleInline('abc', 3, 0, '**');
  assert.ok(plan);
  assert.strictEqual(apply('abc', plan), '**abc**');
  assert.deepStrictEqual(plan.selection, { anchor: 5, head: 2 });
});

test('行内标记：区间越界 / 非整数 / 空标记一律抛错（⛔ 不夹取）', function () {
  assert.throws(function () { F.toggleInline('abc', -1, 1, '**'); }, /range out of bounds/);
  assert.throws(function () { F.toggleInline('abc', 0, 4, '**'); }, /range out of bounds/);
  assert.throws(function () { F.toggleInline('abc', 0.5, 1, '**'); }, /selection is not an integer/);
  assert.throws(function () { F.toggleInline('abc', 0, 1, ''); }, /marker must not be empty/);
});

// ── togglePrefix ────────────────────────────────────────────────────────────

test('行前缀：单行未加 ⇒ 在行首插入，选区跟着右移', function () {
  const text = 'one\ntwo\nthree';
  const plan = F.togglePrefix(text, 0, 3, '- ');
  assert.ok(plan);
  assert.strictEqual(apply(text, plan), '- one\ntwo\nthree');
  assert.deepStrictEqual(plan.selection, { anchor: 2, head: 5 });
});

test('行前缀：跨行选区 ⇒ 每一行都加（其它行一个字节不动）', function () {
  const text = 'one\ntwo\nthree';
  const plan = F.togglePrefix(text, 0, 7, '- ');
  assert.ok(plan);
  assert.strictEqual(apply(text, plan), '- one\n- two\nthree');
  assert.strictEqual(apply(text, plan).split('\n')[2], 'three', '第三行必须原样');
});

test('行前缀：全部已有 ⇒ 整批剥掉', function () {
  const text = '- one\n- two';
  const plan = F.togglePrefix(text, 2, 5, '- ');
  assert.ok(plan);
  assert.strictEqual(apply(text, plan), 'one\n- two');
  assert.deepStrictEqual(plan.selection, { anchor: 0, head: 3 });
});

test('行前缀：只有部分有 ⇒ 只给缺的那些补，⛔ 不叠成 `- - `', function () {
  const text = '- one\ntwo';
  const plan = F.togglePrefix(text, 0, 9, '- ');
  assert.ok(plan);
  assert.strictEqual(apply(text, plan), '- one\n- two');
  assert.strictEqual(plan.changes.length, 1, '已有前缀的那一行不该产生变更');
  assert.deepStrictEqual(plan.changes[0], { from: 6, to: 6, insert: '- ' });
});

test('行前缀：选区停在下一行行首 ⇒ 下一行不算进来', function () {
  const text = 'a\nb';
  const plan = F.togglePrefix(text, 0, 2, '> ');
  assert.ok(plan);
  assert.strictEqual(apply(text, plan), '> a\nb');
});

test('行前缀：空选区只作用于光标所在行；再按一次 ⇒ 剥掉', function () {
  const text = 'a\nb';
  const plan = F.togglePrefix(text, 2, 2, '> ');
  assert.ok(plan);
  assert.strictEqual(apply(text, plan), 'a\n> b');
  // ⚠️ 前缀是**开关**（与标题的"设置"语义不同）：已经在前缀里再按一次就是删掉。
  const off = F.togglePrefix('> a', 2, 2, '> ');
  assert.ok(off);
  assert.strictEqual(apply('> a', off), 'a');
});

// ── headingLevel ────────────────────────────────────────────────────────────

test('标题：正文 ⇒ H1 ⇒ H2 ⇒ 正文（设置语义，⛔ 不是开关）', function () {
  const text = '标题\n正文';
  const h1 = F.headingLevel(text, 0, 0, 1);
  assert.ok(h1);
  assert.strictEqual(apply(text, h1), '# 标题\n正文');
  assert.deepStrictEqual(h1.selection, { anchor: 2, head: 2 });

  const h1Text = apply(text, h1);
  const h2 = F.headingLevel(h1Text, 2, 4, 2);
  assert.ok(h2);
  assert.strictEqual(apply(h1Text, h2), '## 标题\n正文');

  const h2Text = apply(h1Text, h2);
  const body = F.headingLevel(h2Text, 3, 5, 0);
  assert.ok(body);
  const plain = apply(h2Text, body);
  assert.strictEqual(plain, '标题\n正文');
  assert.deepStrictEqual(body.selection, { anchor: 0, head: 2 });
});

test('标题：已经是目标级别 ⇒ null（⛔ 白压一条撤销）', function () {
  assert.strictEqual(F.headingLevel('# 标题', 2, 2, 1), null);
  assert.strictEqual(F.headingLevel('正文', 0, 0, 0), null);
});

test('标题：跨行选区逐行设置，选区外的行不动', function () {
  const text = '# a\n## b\nc';
  const plan = F.headingLevel(text, 0, 8, 3);
  assert.ok(plan);
  const out = apply(text, plan);
  assert.strictEqual(out, '### a\n### b\nc');
  assert.strictEqual(out.split('\n')[2], 'c');
});

test('标题：级别只接受 0–6 的整数', function () {
  assert.throws(function () { F.headingLevel('a', 0, 0, 7); }, /0-6/);
  assert.throws(function () { F.headingLevel('a', 0, 0, 1.5); }, /0-6/);
});

// ── insertLink / commandPlan ────────────────────────────────────────────────

test('链接：选中文字 ⇒ `[文字](url)`，并把占位符 `url` 选中', function () {
  const text = 'abc';
  const plan = F.insertLink(text, 1, 2);
  assert.strictEqual(apply(text, plan), 'a[b](url)c');
  assert.deepStrictEqual(plan.selection, { anchor: 5, head: 8 });
  assert.strictEqual(apply(text, plan).slice(5, 8), 'url');
});

test('链接：空选区 ⇒ `[](url)`，光标落在 `url` 上', function () {
  const plan = F.insertLink('ab', 1, 1);
  assert.strictEqual(apply('ab', plan), 'a[](url)b');
  assert.deepStrictEqual(plan.selection, { anchor: 4, head: 7 });
});

test('命令表：十一个按钮都翻得出计划（未知命令 ⇒ null）', function () {
  // ⚠️ `body` 要一份**已经是标题**的源码才非空；`h1` 反过来要一份**不是标题**的
  //    —— 用同一个夹具跑全部按钮会得到两个假红。
  const fixture = {
    body: { text: '# abc', anchor: 2, head: 3 },
  };
  F.BUTTONS.forEach(function (b) {
    const f = fixture[b.cmd] || { text: 'abc', anchor: 1, head: 2 };
    const plan = F.commandPlan(b.cmd, f.text, f.anchor, f.head);
    assert.ok(plan, '按钮 ' + b.cmd + ' 没有计划');
    assert.ok(plan.changes.length > 0, '按钮 ' + b.cmd + ' 产生了空计划');
  });
  assert.strictEqual(F.commandPlan('nope', 'abc', 1, 2), null);
});

// ── 文案：⛔ 按钮表里不许有第二份产品文案 ─────────────────────────────────────

test('按钮文案全部走字典：每个 `key` 在中英两份里都存在且非空', function () {
  // ⚠️ 这条是**闸门不是留痕**：`formatbar.js` 的 `BUTTONS` 只许带 `key`，
  //    文案在 `services/i18n.js`。少一个键的后果是界面里出现 `live.format.h1`
  //    这种原始键——屏幕上看不见标记之后，按钮是**唯一**的格式入口，它不能瘸。
  const I = require('../../src/services/i18n.js');
  const keys = ['live.format.bar'].concat(
    F.BUTTONS.map(function (b) { return 'live.format.' + b.key; })
  );
  const 见过 = new Set();
  keys.forEach(function (k) {
    assert.ok(!见过.has(k), '字典键重复：' + k);
    见过.add(k);
    ['zh', 'en'].forEach(function (lang) {
      const v = I.DICT[lang][k];
      assert.strictEqual(typeof v, 'string', lang + ' 缺键：' + k);
      assert.ok(v.trim().length > 0, lang + ' 空文案：' + k);
    });
  });
  // 中英必须是**两份**文案：完全相同多半是忘译（`B` / `H1` 这类字形不走字典，不在表内）。
  keys.forEach(function (k) {
    assert.notStrictEqual(I.DICT.zh[k], I.DICT.en[k], '中英文案相同：' + k);
  });
});
