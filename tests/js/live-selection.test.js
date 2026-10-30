// `design/0047` §2.7（导航 / 选区）的**纯逻辑判据** —— `INV-LIVE-17`。
//
// ⚠️ 这一份测的是 `src/live/selection.js` 的 `move()`：它只认一个"适配器"
//    （`length` / `lines` / `lineAt(pos)`），所以在 node 里塞一个假适配器就能跑。
//    **真视图里的几何（`coordsAtPos`）与真鼠标**仍要离屏/人工，⛔ 但那不是"移动语义"。
//
// ⭐ 每条都带反例的理由：移动错一次的形态是"按一下 ↓ 跳了三行"或"上下穿过短行之后
//    回不到原列"——**屏幕不报错**，只有对照按键与结果才看得见。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../../src/live/selection.js');

/** CM6 `Text` 的最小替身（口径必须与它一致：`lineAt(pos)` 的 `to` 是行尾**之前**）。 */
function doc(text) {
  const lines = String(text).split('\n');
  const starts = [];
  let p = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(p);
    p += lines[i].length + 1;
  }
  return {
    length: String(text).length,
    lines: lines.length,
    lineAt: function (pos) {
      const at = Math.max(0, Math.min(pos, String(text).length));
      let i = lines.length - 1;
      for (let k = 0; k < lines.length; k++) {
        if (at <= starts[k] + lines[k].length) {
          i = k;
          break;
        }
      }
      return { number: i + 1, from: starts[i], to: starts[i] + lines[i].length, text: lines[i] };
    },
  };
}

/** 一次按键：返回 `head`（大多数断言只关心它）。 */
function at(text, head, cmd, opts) {
  const r = S.move(doc(text), { anchor: head, head: head }, cmd, opts);
  return r.head;
}

// ── 字符级 ─────────────────────────────────────────────────────────────────

test('左右：一格一格走，两端夹住（⛔ 不越界、⛔ 不抛错）', function () {
  assert.strictEqual(at('abc', 0, 'charRight'), 1);
  assert.strictEqual(at('abc', 3, 'charRight'), 3, '⛔ 末尾再按不出界');
  assert.strictEqual(at('abc', 0, 'charLeft'), 0);
  assert.strictEqual(at('abc', 2, 'charLeft'), 1);
});

test('⭐ 有选区时（不按 Shift）：← 收到**左端**、→ 收到**右端**（与系统一致）', function () {
  const r = S.move(doc('abcdef'), { anchor: 4, head: 1 }, 'charLeft', {});
  assert.deepStrictEqual([r.anchor, r.head], [1, 1]);
  const l = S.move(doc('abcdef'), { anchor: 1, head: 4 }, 'charRight', {});
  assert.deepStrictEqual([l.anchor, l.head], [4, 4]);
});

test('Shift＋左右：只动 head，anchor 不动（选区可伸可缩）', function () {
  const r = S.move(doc('abcdef'), { anchor: 2, head: 2 }, 'charRight', { extend: true });
  assert.deepStrictEqual([r.anchor, r.head], [2, 3]);
  const back = S.move(doc('abcdef'), { anchor: 2, head: 3 }, 'charLeft', { extend: true });
  assert.deepStrictEqual([back.anchor, back.head], [2, 2]);
});

// ── 行内 / 文档边界 ────────────────────────────────────────────────────────

test('Home / End：已在行首行尾时**再按一次才换行**（系统的两段行为）', function () {
  const t = 'ab\ncd';
  assert.strictEqual(at(t, 4, 'lineStart'), 3, '第二行行首');
  assert.strictEqual(at(t, 3, 'lineStart'), 0, '已在行首 ⇒ 去上一行行首');
  assert.strictEqual(at(t, 1, 'lineStart'), 0);
  assert.strictEqual(at(t, 0, 'lineEnd'), 2);
  assert.strictEqual(at(t, 2, 'lineEnd'), 5, '已在行尾 ⇒ 去下一行行尾');
});

test('⌘↑ / ⌘↓：文档首尾（⛔ 不是行首行尾）', function () {
  assert.strictEqual(at('ab\ncd', 3, 'docStart'), 0);
  assert.strictEqual(at('ab\ncd', 0, 'docEnd'), 5);
});

// ── 上下移动与"目标列" ────────────────────────────────────────────────────

test('上下：落在同一列', function () {
  const t = 'abcde\nabcde\nabcde';
  assert.strictEqual(at(t, 2, 'lineDown'), 8);
  assert.strictEqual(at(t, 8, 'lineUp'), 2);
});

test('⭐ 上下穿过短行：**目标列要留住**（否则来回一次就回不到原处）', function () {
  const t = 'abcdefgh\nab\nabcdefgh';
  const d = doc(t);
  const one = S.move(d, { anchor: 6, head: 6 }, 'lineDown', {});
  assert.strictEqual(one.head, 11, '短行只能落到行尾');
  assert.strictEqual(one.goal, 6, '但目标列记的是 6');
  const two = S.move(d, { anchor: one.head, head: one.head }, 'lineDown', { goal: one.goal });
  assert.strictEqual(two.head, 12 + 6, '回到第三行的第 6 列，而不是短行处被永久截短');
});

test('上下：首行再往上 / 末行再往下 ⇒ 夹在文档两端（⛔ 不报错）', function () {
  assert.strictEqual(at('ab\ncd', 1, 'lineUp'), 0);
  assert.strictEqual(at('ab\ncd', 4, 'lineDown'), 5);
});

test('PageUp / PageDown：按给定的页行数走，同样的列语义', function () {
  const t = 'a\nb\nc\nd\ne';
  assert.strictEqual(at(t, 0, 'pageDown', { pageLines: 2 }), 4, '第 3 行的列 0');
  assert.strictEqual(at(t, 8, 'pageUp', { pageLines: 2 }), 4);
});

// ── 词移动 ─────────────────────────────────────────────────────────────────

test('⌥→ / ⌥←：跨过一整段词（ASCII）', function () {
  const t = 'foo bar baz';
  assert.strictEqual(at(t, 0, 'wordRight'), 3);
  assert.strictEqual(at(t, 3, 'wordRight'), 7);
  assert.strictEqual(at(t, 11, 'wordLeft'), 8);
  assert.strictEqual(at(t, 8, 'wordLeft'), 4);
});

test('⭐ 中文按**字**跳、英文按**词**跳——本项目自定（§1.5 标⚠️，没有通用标准）', function () {
  const t = '中文abc';
  assert.strictEqual(at(t, 0, 'wordRight'), 1, '⛔ 不是"跳过整段中文"（一次一个字）');
  assert.strictEqual(at(t, 1, 'wordRight'), 2);
  assert.strictEqual(at(t, 2, 'wordRight'), 5, '英文那一族仍是整词');
  assert.strictEqual(at(t, 2, 'wordLeft'), 1, '往左一次也只退一个字');
  assert.strictEqual(at(t, 1, 'wordLeft'), 0);
});

test('词移动在两端夹住', function () {
  assert.strictEqual(at('abc', 0, 'wordLeft'), 0);
  assert.strictEqual(at('abc', 3, 'wordRight'), 3);
});

// ── 不认识的命令 ───────────────────────────────────────────────────────────

test('⛔ 不认识的命令返回 null（不臆造一个"最像的"动作）', function () {
  assert.strictEqual(S.move(doc('abc'), { anchor: 0, head: 0 }, 'selectAll', {}), null);
  assert.strictEqual(S.move(doc('abc'), { anchor: 0, head: 0 }, undefined, {}), null);
});

test('range()：anchor/head 反着给也能归一成 from ≤ to', function () {
  assert.deepStrictEqual(S.range({ anchor: 5, head: 2 }), { from: 2, to: 5 });
  assert.deepStrictEqual(S.range({ anchor: 3, head: 3 }), { from: 3, to: 3 });
  assert.deepStrictEqual(S.range(null), { from: 0, to: 0 });
});

// ── 删除区间（`deleteRange` / `graphemeBack`）───────────────────────────────
//
// ⭐ 为什么这一段必须有：2026-10-27 用户报「实时编辑，无法执行删除操作」——
//    `⌫` 在**折叠选区**下一个字符都不删，而**有选区时**照常能用。
//    根因是调用方读了一个不存在的字段（`range()` 只返回 `{from, to}`，没有 `head`）
//    ⇒ `undefined` 进了算术 ⇒ `NaN` ⇒ `to > from` 恒假 ⇒ 静默空转。
//    ⚠️ 它当时住在 `main.js` 里（node 够不到）⇒ 462 条离屏判据也没覆盖删除。
//    搬到这里之后，**每条分支**都能在 node 里钉死。

/** 同一个假适配器 ＋ `sliceString`（`graphemeBack` 要它）。 */
function d2(text) {
  const o = doc(text);
  o.sliceString = function (l, r) { return String(text).slice(l, r); };
  return o;
}

test('⌫ 折叠选区：删掉插入符**左边一个字符**（⭐ 就是它曾经一个都不删）', function () {
  const t = 'abc';
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 2, head: 2 }, {}), { from: 1, to: 2 });
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 1, head: 1 }, {}), { from: 0, to: 1 });
});

test('⌫ 在文首没有可删的（from === to，调用方不必区分）', function () {
  assert.deepStrictEqual(S.deleteRange(d2('abc'), { anchor: 0, head: 0 }, {}), { from: 0, to: 0 });
});

test('⌫ 跨行：删的是换行符（行首一次退到上一行尾）', function () {
  const t = 'ab\ncd';
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 3, head: 3 }, {}), { from: 2, to: 3 });
});

test('⌦ 前向：删掉插入符**右边**一个字符；文末没有可删的', function () {
  assert.deepStrictEqual(S.deleteRange(d2('abc'), { anchor: 1, head: 1 }, { forward: true }), { from: 1, to: 2 });
  assert.deepStrictEqual(S.deleteRange(d2('abc'), { anchor: 3, head: 3 }, { forward: true }), { from: 3, to: 3 });
});

test('⭐ 有选区时：方向与粒度都让位给选区（整段删）', function () {
  const t = 'abcdef';
  const want = { from: 1, to: 4 };
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 1, head: 4 }, {}), want);
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 4, head: 1 }, {}), want, '⛔ 反着选也一样');
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 1, head: 4 }, { byWord: true }), want, '⛔ 粒度不生效');
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 1, head: 4 }, { byLine: true, forward: true }), want);
});

test('⌥⌫ 按词删、⌥⌦ 前向按词删（CJK 逐字、ASCII 整词，与移动同一套判据）', function () {
  const t = 'foo bar';
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 7, head: 7 }, { byWord: true }), { from: 4, to: 7 });
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 0, head: 0 }, { byWord: true, forward: true }), { from: 0, to: 3 });
  const c = '中文abc';
  assert.deepStrictEqual(S.deleteRange(d2(c), { anchor: 2, head: 2 }, { byWord: true }), { from: 1, to: 2 }, '汉字只退一个');
});

test('⌘⌫ 删到行首、⌘⌦ 删到行尾；已在边界时各退/进一个字符', function () {
  const t = 'ab\ncdef';
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 6, head: 6 }, { byLine: true }), { from: 3, to: 6 });
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 3, head: 3 }, { byLine: true }), { from: 2, to: 3 }, '行首退一个');
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 3, head: 3 }, { byLine: true, forward: true }), { from: 3, to: 7 });
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 7, head: 7 }, { byLine: true, forward: true }), { from: 7, to: 7 }, '文末不动');
});

test('⭐ 字素簇不许拆开：emoji / 组合字符一次退一整个', function () {
  const emoji = 'a\u{1F600}';       // a ＋ 😀（代理对，2 个码元）
  assert.deepStrictEqual(S.deleteRange(d2(emoji), { anchor: 3, head: 3 }, {}), { from: 1, to: 3 });
  const comb = 'éx';          // e ＋ 组合尖音 ＋ x
  assert.deepStrictEqual(S.deleteRange(d2(comb), { anchor: 3, head: 3 }, {}), { from: 2, to: 3 });
});

test('⛔ 删除区间永远落在 [0, length] 内，且 from ≤ to', function () {
  const t = 'ab';
  const cases = [
    [], [{ forward: true }], [{ byWord: true }], [{ byWord: true, forward: true }],
    [{ byLine: true }], [{ byLine: true, forward: true }],
  ];
  for (const sel of [{ anchor: 0, head: 0 }, { anchor: 1, head: 1 }, { anchor: 2, head: 2 }]) {
    for (const opts of cases) {
      const r = S.deleteRange(d2(t), sel, opts[0]);
      assert.ok(Number.isInteger(r.from) && Number.isInteger(r.to), '必须是整数：' + JSON.stringify(r));
      assert.ok(r.from >= 0 && r.to <= t.length, '越界：' + JSON.stringify(r));
      assert.ok(r.from <= r.to, 'from > to：' + JSON.stringify(r));
    }
  }
});

// ── 鼠标拖选五条（`bugs/0042`–`0046`）的纯逻辑那一半 ─────────────────────────
// ⭐ 这五条的失效形态**全都不报错**：多吞一个词、少画几行高亮、半个代理项被复制出去。
//    ⇒ 判据必须钉在**区间**上（几何那一半归探针 `R` 段）。

test('⭐ 双击取词：词首/词中/词末命中**同一个词**（`bugs/0045`）', function () {
  const d = doc('one two three');
  for (const p of [4, 5, 6, 7]) {
    assert.deepStrictEqual(S.wordAt(d, p), { from: 4, to: 7 }, 'p=' + p);
  }
  assert.deepStrictEqual(S.wordAt(d, 0), { from: 0, to: 3 }, '词首');
  assert.deepStrictEqual(S.wordAt(d, 2), { from: 0, to: 3 }, '词中');
  // ⚠️ 对照：`wordStop` 在词首本来就该往左**跨过**空格到上一个词（`⌥←` 的语义，⛔ 不改）。
  assert.notStrictEqual(S.wordStop(d, 4, -1), 4, '`wordStop` 不该被这一条改掉');
});

test('双击取词：汉字逐字、中文夹英文按同类成段（与 `wordStop` 同一套口径）', function () {
  const d = doc('中文abc');
  assert.deepStrictEqual(S.wordAt(d, 0), { from: 0, to: 1 });
  assert.deepStrictEqual(S.wordAt(d, 1), { from: 1, to: 2 });
  assert.deepStrictEqual(S.wordAt(d, 2), { from: 2, to: 5 }, '英文整段');
  assert.deepStrictEqual(S.wordAt(d, 4), { from: 2, to: 5 });
});

test('双击取词：落在分隔符上取**那一段**分隔符；⛔ 不跨行', function () {
  const d = doc('a  b');
  assert.deepStrictEqual(S.wordAt(d, 2), { from: 1, to: 3 }, '两空格之间');
  assert.deepStrictEqual(S.wordAt(d, 1), { from: 0, to: 1 }, '紧贴词末 ⇒ 取左边那个词');
  const m = doc('one\ntwo');
  assert.deepStrictEqual(S.wordAt(m, 4), { from: 4, to: 7 }, '⛔ 不许跨到上一行');
  assert.deepStrictEqual(S.wordAt(m, 3), { from: 0, to: 3 }, '行尾取左边那一段');
});

test('⭐ 字素簇不许拆开：`⇧←` / `⇧→` / `⌦` 在 emoji 上各走一整个（`bugs/0046`）', function () {
  const t = 'a\u{1F600}b'; // a ＋ 😀（2 码元）＋ b ⇒ length 4
  const back = S.move(d2(t), { anchor: 3, head: 3 }, 'charLeft', { extend: true });
  assert.deepStrictEqual([back.anchor, back.head], [3, 1], '⇧← 从 3 退到 1，⛔ 不是 2');
  const fwd = S.move(d2(t), { anchor: 1, head: 1 }, 'charRight', { extend: true });
  assert.deepStrictEqual([fwd.anchor, fwd.head], [1, 3], '⇧→ 从 1 进到 3，⛔ 不是 2');
  assert.deepStrictEqual(S.deleteRange(d2(t), { anchor: 1, head: 1 }, { forward: true }), { from: 1, to: 3 });
  // ⚠️ 适配器缺 `sliceString`（老契约）⇒ 退化成"至少避开代理对"，⛔ 不抛错、⛔ 不拆半个。
  const plain = S.move(doc(t), { anchor: 3, head: 3 }, 'charLeft', { extend: true });
  assert.deepStrictEqual([plain.anchor, plain.head], [3, 1], '退化路径也必须整簇走');
  // 两端都落在字符边界上（低代理项 0xDC00–0xDFFF 处不算边界）。
  const isBoundary = function (k) {
    const c = t.charCodeAt(k);
    return !(c >= 0xdc00 && c <= 0xdfff);
  };
  assert.ok(isBoundary(plain.head) && isBoundary(back.head) && isBoundary(fwd.head), '边界落在代理对中间');
});

test('字素簇：组合字符一次过完；纯 ASCII 逐字不变（反面判据）', function () {
  const comb = 'éx'; // e ＋ 组合尖音 ＋ x ⇒ length 3
  const r = S.move(d2(comb), { anchor: 2, head: 2 }, 'charLeft', { extend: true });
  assert.deepStrictEqual([r.anchor, r.head], [2, 0], '光标在「组合字符之后、x 之前」⇒ 一次退到 0，⛔ 不留在 1');
  const a = 'abc';
  assert.strictEqual(S.move(d2(a), { anchor: 3, head: 3 }, 'charLeft', { extend: true }).head, 2);
  assert.strictEqual(S.move(d2(a), { anchor: 0, head: 0 }, 'charRight', { extend: true }).head, 1);
});

test('⭐ 双击/三击后往回拖：初选那一段**留在选区里**（`bugs/0044`）', function () {
  const d = doc('one two three');
  const base = { from: 4, to: 7 }; // "two"
  // 往回拖到 1 ⇒ [0,7) = "one two"
  assert.deepStrictEqual(S.dragRange(d, 2, base, 1), { anchor: 7, head: 0 });
  // 往右拖到 9 ⇒ 覆盖到第 3 个词（"one two three" 的 13 是第 3 个词的右端）
  assert.deepStrictEqual(S.dragRange(d, 2, base, 9), { anchor: 4, head: 13 });
  // 落在初选内部 ⇒ 原样，⛔ 不塌成一点
  assert.deepStrictEqual(S.dragRange(d, 2, base, 5), { anchor: 4, head: 7 });
  // 越过起点后**折返**回到 7 ⇒ 恰好是初选那一段
  assert.deepStrictEqual(S.dragRange(d, 2, base, 7), { anchor: 4, head: 7 });
});

test('⭐ 三击选行后拖动：两行都在（`bugs/0044` 行单位）', function () {
  const d = doc('first\nsecond\nthird');
  const base = { from: 6, to: 12 }; // "second"
  assert.deepStrictEqual(S.dragRange(d, 3, base, 2), { anchor: 12, head: 0 });
  assert.deepStrictEqual(S.dragRange(d, 3, base, 14), { anchor: 6, head: 18 });
});

test('拖动的反面判据：字符级（单位 1）行为**逐字不变**', function () {
  const d = doc('abcdef');
  assert.deepStrictEqual(S.dragRange(d, 1, { from: 2, to: 4 }, 5), { anchor: 2, head: 5 });
  assert.deepStrictEqual(S.dragRange(d, 1, { from: 2, to: 4 }, 0), { anchor: 2, head: 0 });
});

test('⭐ 跨软换行的高亮：真实矩形有几块画几块，零面积丢掉（`bugs/0043`）', function () {
  const want = [{ left: 10, top: 0, w: 30, h: 20 }, { left: 0, top: 20, w: 40, h: 20 }];
  assert.deepStrictEqual(S.rectsFor({ from: 1, to: 11 }, { textRects: () => want }), want);
  assert.deepStrictEqual(
    S.rectsFor({ from: 1, to: 2 }, { textRects: () => [{ left: 0, top: 0, w: 0, h: 20 }] }),
    [],
    '零面积（折点/行尾）不许画'
  );
  assert.deepStrictEqual(S.rectsFor({ from: 1, to: 2 }, { textRects: () => { throw new Error('x'); } }), [],
    '`textRects` 抛错不是崩溃点，回落兜底');
});

test('⭐ 兜底路径：⛔ 不再画一条 4px 竖条（`bugs/0043` 的原形态）', function () {
  // 一条逻辑行被软折成两行：两端 `top` 不同 ⇒ 兜底**什么都不画**（宁缺，⛔ 不画错）。
  const wrapped = {
    lineAt: () => ({ from: 0, to: 10 }),
    coordsAtPos: (p) => ({ left: p * 10, top: p < 4 ? 0 : 20, bottom: p < 4 ? 20 : 40 }),
  };
  assert.deepStrictEqual(S.rectsFor({ from: 1, to: 8 }, wrapped), []);
  // 同一视觉行照常画：宽度是**真实跨度**，⛔ 不是写死的 4。
  const same = {
    lineAt: () => ({ from: 0, to: 10 }),
    coordsAtPos: (p) => ({ left: p * 10, top: 0, bottom: 20 }),
  };
  assert.deepStrictEqual(S.rectsFor({ from: 1, to: 5 }, same), [{ left: 10, top: 0, w: 40, h: 20 }]);
});
