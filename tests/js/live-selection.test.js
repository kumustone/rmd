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

// ── 合法落点 `legalEdge`（`design/0061` L2 / `INV-LIVE-15`）──────────────────
//
// ⭐ 失效形态全都不报错：光标停进看不见的 `**` 里 ⇒ 按一下方向键"没动"，
//    再按一下跳过两个字符；或落在 0 高的围栏行里 ⇒ 看起来像光标丢了。
//    判据只钉**吸附结果**，几何与真鼠标归离屏探针。

/** 两个隐藏标记区间的常用夹具：`**` 在 [2,4)，`**` 在 [10,12)。 */
const HID = [{ from: 2, to: 4 }, { from: 10, to: 12 }];

test('L2 区间内部：←/⌫ 吸到左端，→/⌦ 吸到右端', function () {
  assert.strictEqual(S.legalEdge(HID, 3, -1), 2, '严格内部 + 向左 ⇒ 左端');
  assert.strictEqual(S.legalEdge(HID, 3, 1), 4, '严格内部 + 向右 ⇒ 右端');
  assert.strictEqual(S.legalEdge(HID, 11, -1), 10);
  assert.strictEqual(S.legalEdge(HID, 11, 1), 12);
});

test('L2 区间端点：本身就是合法可见边界，⛔ 不推开（含相邻两个区间）', function () {
  assert.strictEqual(S.legalEdge(HID, 2, -1), 2, '`**` 之前');
  assert.strictEqual(S.legalEdge(HID, 2, 1), 2, '向右也不动（不在严格内部）');
  assert.strictEqual(S.legalEdge(HID, 4, -1), 4, '`**` 之后');
  assert.strictEqual(S.legalEdge(HID, 4, 1), 4);
  assert.strictEqual(S.legalEdge(HID, 0, 1), 0, '可见区的普通位置一步不动');
  assert.strictEqual(S.legalEdge(HID, 9, -1), 9);
});

// ⭐ 围栏行整行塌成 0 高（`cm-rmd-fence`）⇒ 行内**每一个**整数位置都不可见。
//    `legalRanges()` 把整行编成伪区间 `[行首-1, 行末+1]`，让严格内部覆盖整行。
test('L2 不可见行（围栏）：← 跨到上一行末，→ 跨到下一行首', function () {
  // `a\n```\ncode`：围栏行 [2,5)，上一行末 = 1，下一行首 = 6。
  const plan = { ranges: [], fenceLines: [{ line: 1, from: 2, to: 5 }] };
  const legal = S.legalRanges({}, { plan: function () { return plan; } });
  assert.strictEqual(S.legalEdge(legal, 3, -1), 1, '落在围栏行内部 ⇒ 上一行末');
  assert.strictEqual(S.legalEdge(legal, 3, 1), 6, '落在围栏行内部 ⇒ 下一行首');
  assert.strictEqual(S.legalEdge(legal, 1, 1), 1, '伪区间的左端点（上一行末）是合法边界');
  assert.strictEqual(S.legalEdge(legal, 6, -1), 6, '伪区间的右端点（下一行首）是合法边界');
  assert.deepStrictEqual(legal, [{ from: 1, to: 6 }], '伪区间恰好包住整行文本（含行首/行末）');
});

test('L2 越界 / 非整数 / 空集合：原样返回（⛔ 本函数不猜文档长度）', function () {
  assert.strictEqual(S.legalEdge([], 5, -1), 5);
  assert.strictEqual(S.legalEdge(null, 5, 1), 5);
  assert.strictEqual(S.legalEdge(HID, 999, -1), 999, '超出隐藏集合 ⇒ 不动');
  assert.strictEqual(S.legalEdge(HID, -1, 1), -1, '负数不擅自夹到 0（调用方负责夹）');
  assert.strictEqual(S.legalEdge(HID, 2.5, 1), 2.5, '非整数原样');
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

// ⭐ `bugs/0105`（2026-11-06 用户报告）：在"光标最前面"按回车，插入点必须退到
//    **从行首开始的整条隐藏标记链**之前——否则 `**读者**` 会被劈成 `**\n读者**`。
test('行首标记链之后按回车：插入点退到链首（⛔ 不劈开 `**`）', function () {
  // `**读者**：…` ⇒ 开场 `**` = [0,2)、闭合 `**` = [4,6)，可见光标在 2。
  const 强调 = '**读者**：接手本仓库的开发者。';
  const 强调隐藏 = [{ from: 0, to: 2 }, { from: 4, to: 6 }];
  assert.strictEqual(S.lineStartInsertPoint(强调隐藏, doc(强调), 2), 0);
  // 任务项：`- [x] ` 是两段相接的链（`ListMark` ＋ `TaskMarker`），必须整链一起退。
  assert.strictEqual(S.lineStartInsertPoint([{ from: 0, to: 2 }, { from: 2, to: 6 }], doc('- [x] 完成'), 6), 0);
  // 标题 `## `：行首标记链同样不能劈开（否则 `##` 独占一行，标题没了）。
  assert.strictEqual(S.lineStartInsertPoint([{ from: 0, to: 3 }], doc('## 标题'), 3), 0);
  // 第二行同理：链首是**这一行的**行首（⛔ 不是文档开头）。
  assert.strictEqual(S.lineStartInsertPoint([{ from: 2, to: 4 }], doc('甲\n**乙**'), 4), 2);
  // 句子中间：链没顶到行首 ⇒ 原样插（那里回车就该在可见处断行）。
  assert.strictEqual(S.lineStartInsertPoint([{ from: 2, to: 4 }], doc('前**重**后'), 4), -1);
  // 光标前面没有隐藏标记 ⇒ 原样插。
  assert.strictEqual(S.lineStartInsertPoint(强调隐藏, doc(强调), 4), -1);
  assert.strictEqual(S.lineStartInsertPoint([{ from: 0, to: 2 }], doc(强调), 6), -1, '闭合标记之后 ⇒ 行尾，原样插');
  // ⭐ 2026-11-08（`blocks/W5` 探针实测）：**整行只剩标记**、光标在行尾 ⇒ 原样插。
  //    `> 第一段\n>` 的光标停在 `>` 之后（偏移 37）按回车，退到链首会把换行插到 `>` **之前**
  //    ⇒ `>` 变成下一行的孤儿（用户看到的是"回车之后光标跑到标记上面去了"）。
  assert.strictEqual(S.lineStartInsertPoint([{ from: 2, to: 3 }], doc('甲\n>'), 3), -1,
    '行尾（`>` 独占一行）⇒ 原样插');
  assert.strictEqual(S.lineStartInsertPoint([{ from: 0, to: 2 }], doc('**'), 2), -1,
    '行尾（`**` 独占一行）⇒ 原样插');
  assert.strictEqual(S.lineStartInsertPoint([{ from: 2, to: 3 }], doc('甲\n> '), 3), -1,
    '链后只剩尾随空白 ⇒ 原样插（`bugs/0115` 第 5 节候选判据）');
  // ⚠️ 负对照：同一行有正文时规则照旧生效（上一条不许把 `0105` 一起关掉）。
  assert.strictEqual(S.lineStartInsertPoint([{ from: 2, to: 4 }], doc('甲\n> 乙'), 4), 2,
    '`> 乙` 的光标在"乙"之前 ⇒ 仍退到链首');
  // 坏输入不猜。
  assert.strictEqual(S.lineStartInsertPoint(null, doc(强调), 2), -1);
  assert.strictEqual(S.lineStartInsertPoint(强调隐藏, null, 2), -1);
  assert.strictEqual(S.lineStartInsertPoint(强调隐藏, doc(强调), 2.5), -1);
});

// ⭐ `bugs/0308`（2026-11-11 用户报告）：行尾回车不能把**闭合标记链**劈到下一行——
//    标记恒藏时，光标停在闭合 `**` 之前与之后屏幕上看不出差别，原样插 `\n` 会写成
//    `**正文\n**`，强调当场断成两半。`lineStartInsertPoint` 的行尾镜像。
test('行尾标记链之前按回车：插入点挪到链尾（⛔ 不劈开闭合 `**`）', function () {
  // `**asdfdf**` ⇒ 开场 [0,2)、闭合 [8,10)，可见"行尾"两侧都是合法落点（8 或 10）。
  const 强调 = '**asdfdf**';
  const 强调隐藏 = [{ from: 0, to: 2 }, { from: 8, to: 10 }];
  assert.strictEqual(S.lineEndInsertPoint(强调隐藏, doc(强调), 8), 10, '闭合标记之前 ⇒ 挪到它之后');
  assert.strictEqual(S.lineEndInsertPoint(强调隐藏, doc(强调), 10), -1, '已经在行尾 ⇒ 原样插');
  // 开场标记之前 / 正文中间：后面不是"顶到行末"的整链（还有可见内容）⇒ 原样插。
  assert.strictEqual(S.lineEndInsertPoint(强调隐藏, doc(强调), 0), -1);
  assert.strictEqual(S.lineEndInsertPoint(强调隐藏, doc(强调), 2), -1);
  // 第二行同理：挪到**这一行**的行末，⛔ 不是文档末尾。
  assert.strictEqual(S.lineEndInsertPoint([{ from: 2, to: 4 }, { from: 5, to: 7 }], doc('甲\n**乙**'), 5), 7);
  // 列表项里的强调：`- ` 是另一段隐藏标记，不影响行尾这条判据。
  assert.strictEqual(
    S.lineEndInsertPoint([{ from: 0, to: 2 }, { from: 2, to: 4 }, { from: 6, to: 8 }], doc('- **完成**'), 6), 8);
  // 链后还有可见内容 ⇒ 光标本来就在可见处，原样插。
  assert.strictEqual(
    S.lineEndInsertPoint([{ from: 0, to: 2 }, { from: 2, to: 4 }, { from: 6, to: 8 }], doc('- **完成**！'), 6), -1);
  // 链后只剩尾随空白 ⇒ 挪到行末（⛔ 别把换行插在空白之前，让新行以空白开头）。
  assert.strictEqual(S.lineEndInsertPoint([{ from: 0, to: 2 }, { from: 3, to: 5 }], doc('**x**   '), 3), 8);
  // ⚠️ 反向边界（`bugs/0115` 的对称形态）：整行只剩标记、光标在**它之前** ⇒ 原样插，
  //    挪到链尾会把标记甩到新行**上面**。
  assert.strictEqual(S.lineEndInsertPoint([{ from: 0, to: 2 }], doc('**'), 0), -1, '`**` 独占一行 ⇒ 原样插');
  assert.strictEqual(S.lineEndInsertPoint([{ from: 2, to: 4 }], doc('甲\n> '), 2), -1, '`> ` 独占一行 ⇒ 原样插');
  // 坏输入不猜。
  assert.strictEqual(S.lineEndInsertPoint(null, doc(强调), 8), -1);
  assert.strictEqual(S.lineEndInsertPoint(强调隐藏, null, 8), -1);
  assert.strictEqual(S.lineEndInsertPoint(强调隐藏, doc(强调), 7.5), -1);
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

// ── 删除保护（`design/0061` L3 / `INV-LIVE-16`）─────────────────────────────
//
// ⭐ 删除单位 = 一个**可见**字素；紧邻的隐藏标记整段跨过（⛔ 逐字节吃）。
//    `a **b** c` 的坐标：`**` = [2,4) 与 [5,7)，可见字符是 0(a) 1(空格) 4(b) 7(空格) 8(c)。

const 保护文本 = 'a **b** c';
const 保护隐藏 = [{ from: 2, to: 4 }, { from: 5, to: 7 }];

test('L3 折叠 ⌫：跨过整段隐藏标记，删的是**前一个可见字素**', function () {
  // 光标在开标记之前 ⇒ 删空格；在标记之后 / 闭合标记之后 ⇒ 同样删「b」，⛔ 不删 `*`。
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 2, head: 2 }, { hidden: 保护隐藏 }), { from: 1, to: 2 });
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 4, head: 4 }, { hidden: 保护隐藏 }), { from: 1, to: 2 });
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 7, head: 7 }, { hidden: 保护隐藏 }), { from: 4, to: 5 });
  // ⚠️ 防御：旧坐标把光标留在隐藏区间**内部**（撤销 / 迟到事务）⇒ 先按方向吸附，仍只删可见字节。
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 3, head: 3 }, { hidden: 保护隐藏 }), { from: 1, to: 2 },
    '`**` 内部 + ⌫ ⇒ 删前一个可见字素，⛔ 不吞半个标记');
});

test('L3 折叠 ⌦：跨过整段隐藏标记，删的是**后一个可见字素**', function () {
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 2, head: 2 }, { forward: true, hidden: 保护隐藏 }), { from: 4, to: 5 },
    '开标记之前按 ⌦ ⇒ 删「b」，标记原样保留');
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 4, head: 4 }, { forward: true, hidden: 保护隐藏 }), { from: 4, to: 5 });
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 5, head: 5 }, { forward: true, hidden: 保护隐藏 }), { from: 7, to: 8 },
    '闭合标记之前按 ⌦ ⇒ 删后面的空格');
});

test('L3 选区只删可见字节：**部分覆盖**的隐藏标记留在原地', function () {
  // 从开标记内部选到 c：左侧 `**` 只覆盖一半 ⇒ 保留；右侧闭合标记整段被覆盖 ⇒ 一起删。
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 3, head: 8 }, { hidden: 保护隐藏 }), { from: 4, to: 8 });
  // 选区整段落在同一个隐藏区间里 ⇒ 一个可见字节都没有，返回折叠区间（调用方不必区分）。
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 3, head: 4 }, { hidden: 保护隐藏 }), { from: 4, to: 4 });
});

test('L3 整结构被覆盖 ⇒ 隐藏标记一起删（`INV-LIVE-16` 的另一半）', function () {
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 2, head: 7 }, { hidden: 保护隐藏 }), { from: 2, to: 7 },
    '`**b**` 整段被选中 ⇒ 连标记一起删');
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 0, head: 9 }, { hidden: 保护隐藏 }), { from: 0, to: 9 },
    '全文选中 ⇒ 原样整段删');
});

test('L3 按行删也⛔ 不许把隐藏标记切成一半：整段结构要么留、要么整个带走', function () {
  // ⌘⌫ 在闭合标记之后 ⇒ 删到行首：`a **b**` 里的两个隐藏区间都被完全覆盖 ⇒ 一起删。
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 7, head: 7 }, { byLine: true, hidden: 保护隐藏 }),
    { from: 0, to: 7 });
  // 光标在开标记之后（行首到 4）：开标记被完整覆盖 ⇒ 一起删，结果恰好是行首到光标。
  assert.deepStrictEqual(S.deleteRange(d2(保护文本), { anchor: 4, head: 4 }, { byLine: true, hidden: 保护隐藏 }),
    { from: 0, to: 4 });
});

test('L3 不传 `hidden` ⇒ 行为与旧版逐字相同（回归：没有第二套删除语义）', function () {
  assert.deepStrictEqual(S.deleteRange(d2('abc'), { anchor: 2, head: 2 }, {}), { from: 1, to: 2 });
  assert.deepStrictEqual(S.deleteRange(d2('abc'), { anchor: 1, head: 1 }, { forward: true }), { from: 1, to: 2 });
});

// ── 删除保护：围栏行**自己的换行**也必须守住（`bugs/0087`）────────────────────
//
// ⭐ 失效形态：`a\n```\ncode` @6 ⌫ 删掉的是围栏行的换行 ⇒ `a\n```code`，
//    可见的 `code` 被并进 0 高、恒藏的围栏行，屏幕上代码**凭空消失**。
//    另两个可达边界（代码末行 ⌦ / 闭合围栏后行首 ⌫）会让围栏结构翻转。
// ⭐ 保护集合 = 标记 ＋ 围栏伪区间 `[行首-1, 行末+1]`（`protectedRanges`），
//    删除会整段**跨过**围栏、落到相邻的可见字素上。

/** 只有围栏行时的删除保护集合。 */
function 围栏保护(plan) {
  return S.protectedRanges({}, { plan: function () { return plan; } });
}

test('L3 围栏：代码首行行首 ⌫ ⇒ ⛔ 不删围栏行的换行（`code` 不被并进隐形行）', function () {
  const t = 'a\n```\ncode';
  const 计划 = { ranges: [], fenceLines: [{ line: 1, from: 2, to: 5 }] };
  const hidden = 围栏保护(计划);
  assert.deepStrictEqual(hidden, [{ from: 1, to: 6 }], '围栏伪区间恰好包住整行（含两侧换行）');
  const r = S.deleteRange(d2(t), { anchor: 6, head: 6 }, { hidden: hidden });
  assert.notDeepStrictEqual(r, { from: 5, to: 6 }, '⛔ 不许只删围栏行自己的换行');
  const after = t.slice(0, r.from) + t.slice(r.to);
  assert.ok(after.indexOf('\n```\ncode') >= 0, '围栏结构与可见 code 都还在：' + JSON.stringify(after));
});

test('L3 围栏：代码末行 ⌦ / 闭合围栏后行首 ⌫ ⇒ 围栏结构不翻转', function () {
  const t = 'para\n```js\ncode\n```\nend';
  const 计划 = {
    ranges: [],
    fenceLines: [{ line: 1, from: 5, to: 10 }, { line: 3, from: 16, to: 19 }],
  };
  const hidden = 围栏保护(计划);
  assert.deepStrictEqual(hidden, [{ from: 4, to: 11 }, { from: 15, to: 20 }]);
  const fwd = S.deleteRange(d2(t), { anchor: 15, head: 15 }, { forward: true, hidden: hidden });
  const afterF = t.slice(0, fwd.from) + t.slice(fwd.to);
  assert.ok(afterF.indexOf('\n```\n') >= 0, '闭合围栏仍是独立的围栏行：' + JSON.stringify(afterF));
  assert.ok(afterF.indexOf('code```') < 0, '⛔ 代码行末的换行还在（围栏没被并进代码行）');
  const back = S.deleteRange(d2(t), { anchor: 20, head: 20 }, { hidden: hidden });
  const afterB = t.slice(0, back.from) + t.slice(back.to);
  assert.ok(afterB.indexOf('\n```\n') >= 0, '闭合围栏仍是独立的围栏行：' + JSON.stringify(afterB));
  assert.ok(afterB.indexOf('end```') < 0, '⛔ 闭合围栏没变成正文 / 开围栏');
});

test('L3 反面：没有围栏行时删除保护集合与标记集合一致（普通 ⌫ 行为不变）', function () {
  const 计划 = { ranges: [{ from: 0, to: 2 }, { from: 3, to: 5 }] };
  const opts = { plan: function () { return 计划; } };
  assert.deepStrictEqual(S.protectedRanges({}, opts), S.hiddenRanges({}, opts));
  // 普通标记处的 ⌫ 仍按既有 L3 语义跨过整段标记。
  assert.deepStrictEqual(
    S.deleteRange(d2('**b**'), { anchor: 5, head: 5 }, { hidden: S.protectedRanges({}, opts) }),
    { from: 2, to: 3 }, '闭合标记之后 ⌫ ⇒ 删「b」，⛔ 不吞标记'
  );
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

// ── 阅读态换算后的"零宽尾巴"（`bugs/0084`）──────────────────────────────────

/** 只有 `state.doc.lineAt` 与 `coordsAtPos` 的假视图（几何判据要的就是这两样）。 */
function 假视图(text, xs, tops) {
  return {
    state: { doc: doc(text) },
    coordsAtPos: function (p) {
      if (!(p in xs)) return null;
      return { left: xs[p], top: tops ? tops[p] : 0 };
    },
  };
}

test('⭐ 行尾是零宽标记：光标从"闭合标记之前"吸到行末（`bugs/0084`）', function () {
  // `中等长度的 `内容``（源码 10 字）：两个反引号在阅读态被藏成零宽 ⇒
  // 位置 9（「容」之后、闭合反引号之前）与位置 10（行末）**是同一个屏幕点**。
  const t = '中等长度的 `内容`';
  const xs = { 0: 0, 1: 14, 2: 28, 3: 42, 4: 56, 5: 70, 6: 70, 7: 84, 8: 98, 9: 112, 10: 112 };
  const v = 假视图(t, xs);
  assert.strictEqual(S.snapHiddenTail(v, 9), 10, '最后一个可见字之后 ⇒ 行末');
  assert.strictEqual(S.snapHiddenTail(v, 10), 10, '已在行末 ⇒ 原样');
});

test('⛔ 中段那些零宽位置**不许**往前推（在 `**` 里打字会变粗体）', function () {
  const t = 'x **粗** y';
  // 位置 2（`**` 之前）与 3（`**` 之后）同点；位置 4 起是「粗」有宽度。
  const xs = { 0: 0, 1: 14, 2: 28, 3: 28, 4: 42, 5: 56, 6: 56, 7: 70, 8: 84 };
  const v = 假视图(t, xs);
  assert.strictEqual(S.snapHiddenTail(v, 2), 2, '后面还有可见字 ⇒ 原样（⛔ 吸进加粗区间）');
  assert.strictEqual(S.snapHiddenTail(v, 5), 5, '行尾不是零宽 ⇒ 原样');
});

test('⚠️ 折到下一视觉行 / 读不到坐标 / 非整数 ⇒ 原样返回（⛔ 不把光标推到别处）', function () {
  const t = 'abcdef';
  const xs = { 0: 0, 1: 10, 2: 20, 3: 30, 4: 40, 5: 50, 6: 50 };
  const 折行 = 假视图(t, xs, { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 20 });
  assert.strictEqual(S.snapHiddenTail(折行, 5), 5, '行末换到下一视觉行 ⇒ top 变了 ⇒ 原样');
  assert.strictEqual(S.snapHiddenTail(假视图(t, xs), 5), 6, '同一视觉行 ⇒ 照常吸');
  const 缺坐标 = 假视图('ab', { 0: 0, 1: 10 });
  assert.strictEqual(S.snapHiddenTail(缺坐标, 1), 1, '`coordsAtPos` 给 null ⇒ 原样');
  assert.strictEqual(S.snapHiddenTail(假视图(t, xs), 2.5), 2.5, '非整数 ⇒ 原样');
  assert.strictEqual(S.snapHiddenTail(null, 3), 3, '没有视图 ⇒ 原样');
});

// ── "点在哪就落在哪"：按真实字形坐标把换算歪掉的落点扳回来（`bugs/0084` 第三面）──────

// 12 个字的格子（`唯一能触达文件系统的地方`），每个字 12 px，行首 x=0。
// 边界 i 的 x = i*12：位置 10 → 120、11 → 132、12（行末）→ 144。
const 格文本 = '唯一能触达文件系统的地方';
const 格xs = (function () {
  const o = {};
  for (let i = 0; i <= 12; i++) o[i] = i * 12;
  return o;
})();

test('⭐⭐ 换算少算了字符：点在末字右半 ⇒ 按字形坐标扳到行末（`bugs/0084` 第三面）', function () {
  // 变异对照：`posAtCoords` 少算 2 格（实测形态 10/12，用户原话「光标无法触达这一行的末尾」）。
  // 点 140：边界 11 在 132（差 8）、行末 12 在 144（差 4）⇒ 落 12。
  assert.strictEqual(S.snapClickX(假视图(格文本, 格xs), 10, 140), 12, '少算 2 ⇒ 扳到行末');
  assert.strictEqual(S.snapClickX(假视图(格文本, 格xs), 9, 140), 12, '少算 3 ⇒ 一样扳到行末');
  // ⛔ 不越过行末：行末就是最后一个边界。
  assert.strictEqual(S.snapClickX(假视图(格文本, 格xs), 12, 9999), 12, '点远在右边 ⇒ 仍是行末');
});

test('换算本来就准 ⇒ 一步都不动（恒等，⛔ 不是"总是吸到行末"）', function () {
  const v = 假视图(格文本, 格xs);
  assert.strictEqual(S.snapClickX(v, 4, 48), 4, '点在边界上 ⇒ 原样');
  assert.strictEqual(S.snapClickX(v, 0, 2), 0, '行首');
  assert.strictEqual(S.snapClickX(v, 12, 140), 12, '已在行末');
  // 反例：点在**前一个字**的右半（132 是 11 的边界，点 128 更靠 11 而不是 12）⇒ 落 11。
  assert.strictEqual(S.snapClickX(v, 10, 128), 11, '落点是"离点最近的那个边界"');
});

test('点落在落点左边 ⇒ 往回走；⛔ 不跨视觉行', function () {
  const v = 假视图(格文本, 格xs);
  assert.strictEqual(S.snapClickX(v, 10, 30), 3, '往回走到最近的边界');
  // 折行：位置 7 起换到第二视觉行（top 20）。点在同一条的右边 ⇒ 只能留在第一行末。
  const tops = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 20, 8: 20, 9: 20, 10: 20, 11: 20, 12: 20 };
  const 折 = 假视图(格文本, 格xs, tops);
  assert.strictEqual(S.snapClickX(折, 5, 300), 6, '第一视觉行右端 ⇒ 第一行末（⛔ 整段末）');
});

test('⚠️ 读不到坐标 / 非整数 / 没有视图 ⇒ 原样返回（⛔ 把光标推到别处）', function () {
  const 缺 = 假视图(格文本, { 0: 0, 1: 12 });
  assert.strictEqual(S.snapClickX(缺, 1, 100), 1, '`coordsAtPos` 给 null ⇒ 原样');
  assert.strictEqual(S.snapClickX(假视图(格文本, 格xs), 2.5, 100), 2.5, '非整数 ⇒ 原样');
  assert.strictEqual(S.snapClickX(null, 3, 100), 3, '没有视图 ⇒ 原样');
  assert.strictEqual(S.snapClickX(假视图(格文本, 格xs), 3, NaN), 3, 'x 不是数 ⇒ 原样');
});

// ── 编辑态内再次点击：与首次进入同一落点（`bugs/0094`）──────────────────────
//
// ⭐ 首次进入走 `main.js::focusAt`（有 `snapHiddenTail`），再次点击走
//    `installMouse::posAt`。`**b**` 的行末三处（3 / 4 / 5）在屏幕上是**同一个点**，
//    两条路必须都落到 5；⛔ 不能一个 5、一个 3（在 3 处打字还会触发 `bugs/0086` 的倒序）。

test('⭐⭐ 编辑态内再次点击行末尾的零宽标记：落点与首次进入一致（`bugs/0094`）', function () {
  const t = '**b**';
  // 位置 3（「b」之后、闭合 `**` 之前）、4（`**` 中间）、5（行末）同一点。
  const xs = { 0: 0, 1: 0, 2: 0, 3: 14, 4: 14, 5: 14 };
  const plan = { ranges: [{ from: 0, to: 2 }, { from: 3, to: 5 }] };
  const view = {
    state: { doc: doc(t), selection: { main: { anchor: 3, head: 3 } } },
    contentDOM: { getBoundingClientRect: function () { return { right: 1000 }; } },
    posAtCoords: function () { return 3; },
    coordsAtPos: function (p) {
      if (!(p in xs)) return null;
      return { left: xs[p], top: 0 };
    },
    dispatch: function (tr) { view.派发 = tr; },
    requestMeasure: function () {},
  };
  const listeners = {};
  view.dom = {
    addEventListener: function (n, f) { listeners[n] = f; },
    removeEventListener: function () {},
    ownerDocument: { addEventListener: function () {}, removeEventListener: function () {} },
  };
  const uninstall = S.installMouse(view, {
    focus: function () {},
    onSelect: function () {},
    hidden: { plan: function () { return plan; } },
  });
  try {
    // 编辑态内的一次 `mousedown`（同一点、单击）⇒ 走 `posAt`。
    listeners.mousedown({
      button: 0, clientX: 14, clientY: 0, detail: 1, shiftKey: false,
      preventDefault: function () {}, stopPropagation: function () {},
    });
  } finally {
    uninstall();
  }
  assert.strictEqual(S.snapHiddenTail(view, 3), 5, '首次进入（`focusAt` 同一条管线）落 5');
  assert.deepStrictEqual(view.派发 && view.派发.selection, { anchor: 5, head: 5 },
    '再次点击同一视觉点也必须落 5（⛔ 3）');
});

// ── 行末光标被格子的水平裁剪切掉（`bugs/0085`）──────────────────────────────
//
// ⭐ 实测（离屏真 WKWebView，真 `ARCHITECTURE.md`）：格子 `.cm-rmd-cell` 是
//    `inline-block` ＋ `overflow-x: clip`、宽**收缩到内容宽** `143 px`；行末光标
//    `left = 143`、宽 2 px ⇒ 落在裁剪盒外的部分 = 全部 ⇒ **剩余可见宽 0**（行中光标是 2）。

test('⭐ 行末光标压线 ⇒ 夹回盒内（实测形态：盒宽 143、光标左沿 143）', function () {
  assert.strictEqual(S.caretClamp(143, 143, 2), 141, '压线的光标退到盒内');
  assert.strictEqual(S.caretClamp(200, 143, 2), 141, '再往右也一样（⛔ 不许越界）');
  assert.strictEqual(S.caretClamp(141, 143, 2), 141, '已经在最右可见位 ⇒ 不动');
});

test('换算本来就看得见 ⇒ 一步都不动（⛔ 不是"总是贴右边"）', function () {
  assert.strictEqual(S.caretClamp(73, 143, 2), 73, '行中');
  assert.strictEqual(S.caretClamp(0, 143, 2), 0, '行首');
});

test('⚠️ 盒宽读不到 / 非数 / 盒比光标还窄 ⇒ 原样（⛔ 把光标搬到别处）', function () {
  assert.strictEqual(S.caretClamp(143, 0, 2), 143, '`clientWidth` 读成 0');
  assert.strictEqual(S.caretClamp(143, 1, 2), 143, '盒比光标窄（不该发生，但不猜）');
  assert.strictEqual(S.caretClamp(NaN, 143, 2), NaN, '左沿不是数');
  assert.strictEqual(S.caretClamp(143, NaN, 2), 143, '盒宽不是数');
});

// ── 列表标记恒藏之后的落点（`bugs/0092`，2026-11-05）────────────────────────────
//
// ⭐ 列表标记（`- ` / `1. ` / `[x] `）与行首缩进被**恒定隐藏**之后，行首 `from`
//    在文档里仍是合法位置（不在隐藏区间内部），但那里**没有可见字符**：
//    光标停在那儿会画进缩进带，敲的字还会插到 `- ` 之前、把列表结构写坏。
//    ⇒ 折叠选区落在列表行行首时按方向换去处：点击/Home ⇒ 正文起点；`←` ⇒ 跨到上一行末。

const 列表文本 = 'x\n- 甲\n  - 乙\n1. 丙\n';
const 列表计划 = {
  ranges: [
    { from: 2, to: 4 },   // `- `
    { from: 8, to: 10 },  // `  - `
    { from: 13, to: 16 }, // `1. `
  ],
  listLines: [
    { line: 1, from: 2, contentFrom: 4, depth: 0, kind: 'bullet', marker: '-' },
    { line: 2, from: 8, contentFrom: 10, depth: 1, kind: 'bullet', marker: '-' },
    { line: 3, from: 13, contentFrom: 16, depth: 0, kind: 'ordered', marker: '1.' },
  ],
};

function 列表视图() {
  return { state: { doc: { length: 列表文本.length } } };
}
function 列表opts() {
  return { plan: function () { return 列表计划; } };
}

test('列表行首：点击 / 兜底（dir=0）⇒ 正文起点，⛔ 停在缩进带', function () {
  assert.strictEqual(S.listContentStart(列表计划, 2), 4);
  assert.strictEqual(S.listContentStart(列表计划, 13), 16, '有序列表也要过编号与空格');
  assert.strictEqual(S.snapCaret(列表视图(), 2, 0, 列表opts()), 4);
  assert.strictEqual(S.snapCaret(列表视图(), 13, 0, 列表opts()), 16);
});

test('列表行首：→ 进正文、← 跨到上一行末（⛔ 不吸回正文起点，那样按了不动）', function () {
  assert.strictEqual(S.snapCaret(列表视图(), 2, 1, 列表opts()), 4, '→ 进入正文起点');
  assert.strictEqual(S.snapCaret(列表视图(), 2, -1, 列表opts()), 1, '← 落到上一行行末');
  assert.strictEqual(S.snapCaret(列表视图(), 8, -1, 列表opts()), 7, '嵌套项同理');
});

test('非列表行首 / 该行没有可去的正文起点 ⇒ 一步不动', function () {
  assert.strictEqual(S.listContentStart(列表计划, 0), -1, '普通行');
  assert.strictEqual(S.listContentStart(列表计划, 4), -1, '正文起点不是行首');
  assert.strictEqual(S.listContentStart(null, 2), -1, '没有计划');
  const 续行 = {
    ranges: [{ from: 2, to: 4 }],
    listLines: [{ line: 1, from: 2, contentFrom: 2, depth: 0, kind: 'plain', marker: '' }],
  };
  assert.strictEqual(S.listContentStart(续行, 2), -1, '续行（kind=plain）不吸');
});

test('折叠选区（snapRange）走同一条规则', function () {
  const r = S.snapRange(列表视图(), { anchor: 2, head: 2 }, 列表opts());
  assert.deepStrictEqual([r.anchor, r.head], [4, 4]);
});

// ── 变更中的中央兜底：**行首表必须跟着变更走**（`bugs/0092` 的反面，2026-11-05）──────
//
// ⭐ 实测形态（离屏探针 `O-ul-2/4/5`、`O-ol-*`、`O-blockquote-*` 六条同红）：
//    `legalFilter` 拿到的是**变更前**发布的 `plan`。在列表块第 1 行末按回车时，
//    新空行的行首（`E+1`）恰好等于变更前第 2 行（列表项）的行首 ⇒ 未映射的
//    `listLines` 命中，光标被吸进第 2 行的 `- ` 里（那是隐藏区间）⇒ 接着敲的
//    `## 小标题` 落成 `-# # 小标题…`。
//    ⇒ 判据：`docChanged` 时行首表与隐藏区间**都必须**按同一份 `ChangeSet` 映射。

/** 只支持"在 `E` 处插入 `len` 个字符"的假 `ChangeSet`。 */
function 插入变更(E, len) {
  return {
    length: 100,
    /** @param {number} pos @param {number} assoc */
    mapPos: function (pos, assoc) {
      if (pos < E) return pos;
      if (pos === E) return assoc > 0 ? pos + len : pos;
      return pos + len;
    },
    /** @param {function} f CM6 `iterChanges` 的回调（这里只给旧坐标） */
    iterChanges: function (f) { f(E, E, E, E + len, ''); },
  };
}

/** 只支持"删掉 `[from, to)`"的假 `ChangeSet`。 */
function 删除变更(from, to) {
  return {
    length: 100,
    /** @param {number} pos @param {number} assoc */
    mapPos: function (pos, assoc) {
      if (pos <= from) return pos;
      if (pos >= to) return pos - (to - from);
      return assoc > 0 ? from : to - (to - from);
    },
    /** @param {function} f CM6 `iterChanges` 的回调（这里只给旧坐标） */
    iterChanges: function (f) { f(from, to, from, from, ''); },
  };
}

/** 只满足 `legalFilter` 用到的那几个面的假 CM6。 */
const 假CM6 = {
  EditorState: { transactionFilter: { of: function (f) { return f; } } },
  EditorSelection: {
    create: function (ranges, mainIndex) { return { ranges: ranges, mainIndex: mainIndex }; },
    range: function (anchor, head) { return { anchor: anchor, head: head }; },
  },
};

/**
 * 跑一遍中央兜底，返回它给出的折叠落点。
 * @param {object} 计划 变更**前**发布的那一份
 * @param {object} changes 假 `ChangeSet`
 * @param {number} pos 事务要落的落点
 * @param {number} 新长度
 */
function 过兜底(计划, changes, pos, 新长度) {
  const filters = S.legalFilter(假CM6, { plan: function () { return 计划; } });
  const tr = {
    docChanged: true,
    isUserEvent: function () { return false; },
    changes: changes,
    newSelection: { ranges: [{ anchor: pos, head: pos }], mainIndex: 0 },
    newDoc: { length: 新长度 },
    effects: [],
    annotations: [],
    startState: {
      update: function (x) {
        return { 选区: x.selection };
      },
    },
  };
  const out = filters[0](tr);
  // 兜底不需要改 ⇒ 原样返回那一个 `tr`（⛔ 不是新 state）⇒ 落点就是事务自己给的那个。
  if (out === tr) return pos;
  return out.选区.ranges[0].head;
}

test('⭐ 回车后：新空行的行首 ⛔ 不被吸进下一行列表项的 `- ` 里', function () {
  // 变更前：`- 甲\n` 之后紧跟 `- 乙\n`（第 2 行行首 4、正文起点 6）。
  const 计划 = {
    ranges: [{ from: 4, to: 6 }],
    listLines: [{ line: 1, from: 4, contentFrom: 6, depth: 0, kind: 'bullet', marker: '-' }],
  };
  // 在第 1 行末（`\n` 的位置 3）回车 ⇒ 新文档 `- 甲\n\n- 乙\n`，落点 4，新的第 2 行行首 5。
  assert.strictEqual(过兜底(计划, 插入变更(3, 1), 4, 10), 4,
    '落点停在新空行，⛔ 没有被旧坐标吸到 6（`- ` 里）');
});

test('变更后**真的**落在列表行首（删掉上一行的换行）⇒ 仍然吸到正文起点', function () {
  // 变更前：`- 甲\n\n- 乙`（空行在第 1 行，`- 乙` 行首 5、正文起点 7）。
  const 计划 = {
    ranges: [{ from: 5, to: 7 }],
    listLines: [{ line: 2, from: 5, contentFrom: 7, depth: 0, kind: 'bullet', marker: '-' }],
  };
  // 删掉第 2 行那个换行（位置 4）⇒ 新文档 `- 甲\n- 乙`，`- 乙` 行首 4，落点 4。
  assert.strictEqual(过兜底(计划, 删除变更(4, 5), 4, 8), 6,
    '这一回落点**真的**是列表行首 ⇒ 必须吸到正文起点（否则敲字插到 `- ` 之前）');
});

// ── ⭐ 伪区间（Setext 下划线 / 围栏行）不许在变更里压到相邻行（`bugs/0312`，2026-11-11）──
//
// 实测形态（离屏探针 `pb0314`，段落里现敲列表）：`##地方金额`（不带空格 ⇒ 是**段落**）
// 下面一行敲 `-` ⇒ Lezer 把它当 Setext 下划线行（伪区间 `[6,9]`，横跨 `\n-\n`）；
// 再敲一个空格 `- ` 当场把它变成列表项（那一行恢复可见），可过滤器手里还是**变更前**
// 那份伪区间：映射后成 `[6,10]` ⇒ 落在 9（空项行末）的落点被吸到 10 = **下一行行首**，
// 接着敲的字全粘到下一段前面。

test('⭐ 空格把 `-` 变成列表项：落点留在行末，⛔ 不被旧的 Setext 伪区间吸到下一行', function () {
  // 变更前 `##地方金额\n-\nHello\n…`：`-` 行 [7, 8) ⇒ 伪区间 [6, 9]。
  const 计划 = { ranges: [], collapsedLines: [{ line: 1, from: 7, to: 8 }] };
  // 在 8（`-` 行末）插入一个空格 ⇒ 新文档 `##地方金额\n- \nHello\n…`，落点 9。
  assert.strictEqual(过兜底(计划, 插入变更(8, 1), 9, 60), 9,
    '被变更碰到的行 ⇒ 它的伪区间这一发不用，光标留在自己敲的那一行');
});

test('没被碰到的 Setext 伪区间照旧生效（敲别的行时塌高保护不丢）', function () {
  const 计划 = { ranges: [], collapsedLines: [{ line: 1, from: 7, to: 8 }] };
  // 在第 0 行里插入一个字（位置 3）⇒ `-` 行整体后移：伪区间 [6,9] → [7,10]。
  // 落点 9 在映射后的伪区间内部 ⇒ 必须被推开（到更近的 10），否则光标停在 0 高行里。
  assert.strictEqual(过兜底(计划, 插入变更(3, 1), 9, 60), 10);
});

test('⌫ 在任务项正文起点：整条标记链（`- [x] `）一次删掉（⛔ 按了没反应）', function () {
  // `- [x] 甲`：ListMark 藏 `[0,2)`、TaskMarker 藏 `[2,6)`，正文从 6 起。
  const 文本 = '- [x] 甲';
  const 隐藏 = [{ from: 0, to: 2 }, { from: 2, to: 6 }];
  const r = S.deleteRange(doc(文本), { anchor: 6, head: 6 }, { hidden: 隐藏 });
  assert.deepStrictEqual(r, { from: 0, to: 6 }, '一次退格把整条标记删掉（＝取消列表）');
});

// ── ⭐⭐ 列表项行首 ⌫：先消化**上一行的空行**（`bugs/0305`，2026-11-10 用户报告）────
//
// 失效形态（离屏实测）：列表中间被回车敲出一条空行 ⇒ 整张列表变**松**，每条之间多出
// 一段段距（23.8 → 39.19 px）。用户把光标放到**下一项的行首**按 ⌫ 想删掉它，
// 打中的却是 `wholeLineMark` 那一档：`- ` 整链被删（`- 丙项` → `丙项`），空行原地不动，
// 段距全在 ⇒ 「行间距突然变大，而且无法恢复」。
// ⇒ 行首 ⌫ 的第一语义是"并到上一行"；上一行本来就是空行时，并过去就是删空行。
// ⚠️ 只认**列表行**：标题 / 引用块前面那条空行是正常结构，⛔ 不改写。

test('列表项行首 ⌫ ＋ 上一行空行 ⇒ 删的是**那条空行**，列表标记原样留着（`bugs/0305`）', function () {
  // `甲\n\n- 丙`：空行第 1 行（`\n` 在 2），`- 丙` 行首 3、正文起点 5。
  const 文本 = '甲\n\n- 丙';
  const 隐藏 = [{ from: 3, to: 5 }];
  assert.deepStrictEqual(S.deleteRange(doc(文本), { anchor: 5, head: 5 }, { hidden: 隐藏 }),
    { from: 2, to: 3 }, '删的是空行末尾那个换行 ⇒ 空行没了，`- 丙` 还在');
  // 有序 / 任务项同一口径。
  const 有序 = '甲\n\n1. 乙';
  assert.deepStrictEqual(S.deleteRange(doc(有序), { anchor: 6, head: 6 },
    { hidden: [{ from: 3, to: 6 }] }), { from: 2, to: 3 });
  const 任务 = '甲\n\n- [ ] 乙';
  assert.deepStrictEqual(S.deleteRange(doc(任务), { anchor: 9, head: 9 },
    { hidden: [{ from: 3, to: 6 }, { from: 6, to: 9 }] }), { from: 2, to: 3 },
  '`- [ ] ` 是两段相连的隐藏区间，整链判据要认得出来');
});

test('列表项行首 ⌫ 的**负对照**：上一行有内容 / 不是列表 / 光标不在行首 ⇒ 行为不变（`bugs/0305`）', function () {
  // ① 上一行有正文 ⇒ 仍是"删掉整条标记链"（取消列表），⛔ 不吞正文。
  const 紧 = '甲\n- 丙';
  assert.deepStrictEqual(S.deleteRange(doc(紧), { anchor: 4, head: 4 }, { hidden: [{ from: 2, to: 4 }] }),
    { from: 2, to: 4 });
  // ② 标题前面那条空行是正常结构 ⇒ 仍然删标记（`# `），空行不动。
  const 标题 = '甲\n\n# 乙';
  assert.deepStrictEqual(S.deleteRange(doc(标题), { anchor: 5, head: 5 }, { hidden: [{ from: 3, to: 5 }] }),
    { from: 3, to: 5 });
  // ③ 光标在条目正文中间 ⇒ 普通删一个字素。
  assert.deepStrictEqual(S.deleteRange(doc('甲\n\n- 丙'), { anchor: 6, head: 6 }, { hidden: [{ from: 3, to: 5 }] }),
    { from: 5, to: 6 });
  // ④ 光标已在行首（标记链在右侧）⇒ 与旧行为一致：删前一个换行（恰好就是空行那条）。
  assert.deepStrictEqual(S.deleteRange(doc('甲\n\n- 丙'), { anchor: 3, head: 3 }, { hidden: [{ from: 3, to: 5 }] }),
    { from: 2, to: 3 });
});

// ── 中央兜底的方向：边界插入必须落在隐藏区间**外**（`bugs/0086`）──────────────
//
// ⭐ 失效形态：`**b**` 的 `b` 之后连打 x、y ⇒ 屏幕 `byx`（倒序）、光标不前进；
//    在这些边界按回车 ⇒ 新行插在光标之前（光标落回上一行）。
//    根因是 `mapHidden` 把边界上的插入划进了隐藏区间，`legalFilter` 再把光标吸回去。
// ⭐ 判据过**真** `ChangeSet`（`src/vendor/cm6.bundle.js` 是 `make cm6` 的产物），
//    ⛔ 不用手写 `mapPos` 替身——替身会把方向写反也当成正确。

/** 真 CM6 的 `EditorState` 走一遍中央兜底，返回新落点与新文档。 */
function 过真兜底(计划, 文本, anchor, changes, 新选区) {
  const ext = S.legalFilter(真CM6, { plan: function () { return 计划; } });
  const st = 真CM6.EditorState.create({
    doc: 文本,
    selection: { anchor: anchor },
    extensions: ext,
  });
  const tr = st.update({ changes: changes, selection: 新选区 });
  return { head: tr.newSelection.main.head, doc: tr.newDoc.toString() };
}

test('⭐⭐ L2 边界插入：`**b**` 的 b 之后打字 ⇒ 光标前进到 4（⛔ 被吸回 3）', function () {
  // 开标记 [0,2)、闭标记 [3,5)；在 3 处插入 x、光标在 4。
  // 映射后闭标记必须是 [4,6)；写成 [3,6) 就会把 x 当成隐藏 ⇒ 光标吸回 3，再打 y 成 `byx`。
  const 计划 = { ranges: [{ from: 0, to: 2 }, { from: 3, to: 5 }] };
  const r = 过真兜底(计划, '**b**', 3, { from: 3, insert: 'x' }, { anchor: 4 });
  assert.strictEqual(r.head, 4, '光标必须停在 x 之后');
  assert.strictEqual(r.doc, '**bx**');
});

test('⭐ L2 边界插入：区间 `to` 边界上插入的字符**可见**（⛔ 被并进隐藏区间）', function () {
  const 计划 = { ranges: [{ from: 0, to: 2 }, { from: 3, to: 5 }] };
  // 开标记 to=2：在「b」之前插 z，光标 3。反方向映射会把 [0,2) 扩成 [0,3)，光标被吸回 0。
  const 左 = 过真兜底(计划, '**b**', 2, { from: 2, insert: 'z' }, { anchor: 3 });
  assert.strictEqual(左.head, 3, '开标记 to 边界插入 ⇒ 光标停在 z 之后');
  assert.strictEqual(左.doc, '**zb**');
  // 闭标记 to=5：在行末插 y，光标仍在插入点左侧；反方向映射会把 [3,5) 扩成 [3,6)，
  // 把 y 当成隐藏 ⇒ 光标被推到 6。
  const 右 = 过真兜底(计划, '**b**', 5, { from: 5, insert: 'y' }, { anchor: 5 });
  assert.strictEqual(右.head, 5, '闭标记 to 边界插入 ⇒ 光标不被推进隐藏区间');
  assert.strictEqual(右.doc, '**b**y');
});

test('L2 反面：非边界处打字落点与今天一致；整段删除仍收拢（`bugs/0086` 回归）', function () {
  const 计划 = { ranges: [{ from: 0, to: 2 }, { from: 3, to: 5 }] };
  // 可见区中部（`**b** x` 的空格之前）打字：与隐藏区间无关，落点原样前进。
  const 中 = 过真兜底(计划, '**b** x', 6, { from: 6, insert: 'y' }, { anchor: 7 });
  assert.strictEqual(中.head, 7);
  assert.strictEqual(中.doc, '**b** yx');
  // 整段 `**b**` 被替换掉 ⇒ 两个隐藏区间都收拢成空、不再吸光标。
  const 删 = 过真兜底(计划, '**b**', 0, { from: 0, to: 5 }, { anchor: 0 });
  assert.strictEqual(删.head, 0);
  assert.strictEqual(删.doc, '');
});

// ── ⭐ 行首回车后光标必须停在原行（`bugs/0313`）────────────────────────────
//
// 失效形态（离屏实测 `K1` / `K1b`）：`## 标题` / `**读者**…` 在正文起点按回车，
// 文本是对的（`⏎# 标题`），但光标落在插入的 `\n` **之后**（＝原行行首）；再敲一个字 ⇒
// `⏎新# 标题`，标记被劈成行中普通字符。判据：光标停在插入的换行**之前**。

test('⭐ 行首回车：非空行行首插 `\\n` ⇒ 光标留在原行首（⛔ 落到新行行首）', function () {
  assert.strictEqual(S.caretAfterInsert(doc('# 小标题'), 0, 0, '\n'), 0);
  assert.strictEqual(S.caretAfterInsert(doc('**读者**：接手'), 0, 0, '\n'), 0,
    '行内强调行首同一口径');
  assert.strictEqual(S.caretAfterInsert(doc('# 标题'), 0, 0, '\n\n'), 0,
    '插入多行（粘贴）同样按开头那个 `\\n` 判');
});

test('行首回车的负对照：行尾 / 行中 / 普通打字 / 空行 / 有选区替换 ⇒ 光标照旧前进', function () {
  // 行尾：`# 小标题` 长度 5，5 是行尾（不是行首）⇒ 6。
  assert.strictEqual(S.caretAfterInsert(doc('# 小标题'), 5, 5, '\n'), 6);
  // 行中：1 不是行首 ⇒ 2。
  assert.strictEqual(S.caretAfterInsert(doc('abc'), 1, 1, '\n'), 2);
  // 普通打字：插的不是 `\n` ⇒ 1。
  assert.strictEqual(S.caretAfterInsert(doc('# 小标题'), 0, 0, 'x'), 1);
  // 空行：`\n\n#` 的第 1 行（from=1, to=1）是空行 ⇒ 停在换行之前会跑到上一行行尾
  // ⇒ 必须维持 2（⛔ 0 行尾）。空文档同一口径。
  assert.strictEqual(S.caretAfterInsert(doc('\n\n#'), 1, 1, '\n'), 2);
  assert.strictEqual(S.caretAfterInsert(doc(''), 0, 0, '\n'), 1);
  // 有选区替换（to !== from）：走原样 1 + 1 = 2。
  assert.strictEqual(S.caretAfterInsert(doc('abcdef'), 1, 3, '\n'), 2);
});

// ── ⭐ 隐藏反引号前连打（`bugs/0317`）──────────────────────────────────────
//
// 失效形态：`2. ` 与开反引号在装饰层被合并成 `[0,4)`；在 3 处插字后 `mapHidden`
// 把合并区间映成 `[0,5)`，`legalNearest` 把锚点 4 吸到 5 ⇒ 第二个字起落进反引号之后。
// ⭐ 判据过**真** `ChangeSet`：映射输入改成未合并的 `rawRanges` 后，锚点 4 是区间边界。

test('⭐ 隐藏反引号前打字：锚点停在 4（⛔ 被吸到反引号之后 5）', function () {
  // 装饰层合并后的 `ranges` 是 `[0,4)`，未合并的 `rawRanges` 是 `[0,3)` ＋ `[3,4)`。
  const 计划 = {
    ranges: [{ from: 0, to: 4 }],
    rawRanges: [{ from: 0, to: 3 }, { from: 3, to: 4 }],
  };
  const r = 过真兜底(计划, '2. `x`', 3, { from: 3, insert: '#' }, { anchor: 4 });
  assert.strictEqual(r.head, 4, '锚点 4 是相邻区间的边界（合法落点）');
  assert.strictEqual(r.doc, '2. #`x`');
});

test('⭐ 逐键连续性：3 键之后是 `2. ###`x``，每键光标前进一格（`bugs/0317`）', function () {
  // ⚠️ 这里用的是**手工给出的每键 plan**，⛔ 不是实跑 `markers()`——node 侧没有
  //    comrak / Lezer 树。第 1 键的 plan 是"合并前后"的真实形状；第 2 键起沿用
  //    同一份手工计划（合并视图已把新增可见字吞进去的保守形态），用来钉住
  //    "映射输入必须看 `rawRanges`"这条判据。
  const s = 3;
  const N = 3;
  const 第1键 = {
    ranges: [{ from: 0, to: 4 }],
    rawRanges: [{ from: 0, to: 3 }, { from: 3, to: 4 }],
  };
  const 后续键 = {
    ranges: [{ from: 0, to: 5 }],
    rawRanges: [{ from: 0, to: 3 }, { from: 4, to: 5 }],
  };
  let 文本 = '2. `x`';
  let 锚点 = s;
  for (let i = 0; i < N; i++) {
    const r = 过真兜底(i === 0 ? 第1键 : 后续键, 文本, 锚点,
      { from: 锚点, insert: '#' }, { anchor: 锚点 + 1 });
    assert.strictEqual(r.head, s + i + 1, '第 ' + (i + 1) + ' 键之后光标必须前进一格');
    文本 = r.doc;
    锚点 = r.head;
  }
  assert.strictEqual(文本.slice(s, s + N), '###', '三个字连续落在反引号**之前**');
  assert.strictEqual(文本, '2. ###`x`');
});

// ── ⭐ 正文起点 ⌫ 不删掉成对行内标记的半边（`bugs/0111` A6）────────────────
//
// 失效形态：`wholeLineMark` 反向分支拿**合并后的隐藏集合**走链 ⇒ `- ` 与 `**`
// （或 `> ` 与 `**`）被并成一条链，一次 ⌫ 删掉 `[0,4)`（`读者**：` 只剩半边）。
// ⇒ 块前缀与成对行内标记分属两个集合：`prefix` 只含块前缀。

test('⭐ `- **甲**` 正文起点 ⌫ ⇒ 只删块前缀 `[0,2)`（⛔ 不删 `- **`）', function () {
  const r = S.deleteRange(doc('- **甲**'), { anchor: 4, head: 4 }, {
    hidden: [{ from: 0, to: 4 }],
    prefix: [{ from: 0, to: 2 }],
  });
  assert.deepStrictEqual(r, { from: 0, to: 2 });
});

test('⭐ 行首的成对行内标记（`**甲**` / `**读者**：x`）⇒ 正文起点 ⌫ 原地不动', function () {
  assert.deepStrictEqual(S.deleteRange(doc('**甲**'), { anchor: 2, head: 2 }, {
    hidden: [{ from: 0, to: 2 }, { from: 3, to: 5 }],
    prefix: [],
  }), { from: 2, to: 2 }, '⛔ 不能只剩闭合半边');
  assert.deepStrictEqual(S.deleteRange(doc('**读者**：x'), { anchor: 2, head: 2 }, {
    hidden: [{ from: 0, to: 2 }, { from: 4, to: 6 }],
    prefix: [],
  }), { from: 2, to: 2 });
});

test('A6 反面：单前缀（任务框 / 列表 / 引用 / 标题）的整段删除行为不变', function () {
  assert.deepStrictEqual(S.deleteRange(doc('- [ ] 甲'), { anchor: 6, head: 6 }, {
    hidden: [{ from: 0, to: 6 }], prefix: [{ from: 0, to: 6 }] }), { from: 0, to: 6 });
  assert.deepStrictEqual(S.deleteRange(doc('- 甲'), { anchor: 2, head: 2 }, {
    hidden: [{ from: 0, to: 2 }], prefix: [{ from: 0, to: 2 }] }), { from: 0, to: 2 });
  assert.deepStrictEqual(S.deleteRange(doc('> 引用'), { anchor: 2, head: 2 }, {
    hidden: [{ from: 0, to: 2 }], prefix: [{ from: 0, to: 2 }] }), { from: 0, to: 2 });
  assert.deepStrictEqual(S.deleteRange(doc('## 标题'), { anchor: 3, head: 3 }, {
    hidden: [{ from: 0, to: 3 }], prefix: [{ from: 0, to: 3 }] }), { from: 0, to: 3 });
});

test('A6 负对照：`opts.prefix` 缺省（老 plan）⇒ 合并链照旧整段删除', function () {
  // 老 plan 没有 `prefixRanges` ⇒ `wholeLineMark` 回落 `hidden`，行为必须与今天一致。
  assert.deepStrictEqual(S.deleteRange(doc('- **甲**'), { anchor: 4, head: 4 },
    { hidden: [{ from: 0, to: 4 }] }), { from: 0, to: 4 });
});

// ── 变异自测（`bugs/0105`）──────────────────────────────────────────────────
//
// ⚠️ `tests.md`：没做过变异测试的断言不算数。这里的变异直接改源码文本再跑一遍。
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'live', 'selection.js'), 'utf8');

/** 真产物 `src/vendor/cm6.bundle.js`（`make cm6`）：边界插入的判据必须过真 `ChangeSet`。 */
const 真CM6 = (function () {
  const file = path.join(__dirname, '..', '..', 'src', 'vendor', 'cm6.bundle.js');
  assert.ok(fs.existsSync(file), '⛔ 没有 src/vendor/cm6.bundle.js —— 跑 `make cm6`');
  return new Function(fs.readFileSync(file, 'utf8') + '\nreturn rmdCM6;')();
})();

/** 在独立模块作用域里跑一遍源码（不碰全局 `window`）。 */
function load(src) {
  const mod = { exports: {} };
  new Function('module', 'window', src)(mod, undefined);
  return mod.exports;
}

test('变异 m11：插入点不退到链首 ⇒ 行首标记那几条必红', function () {
  const m11 = SRC.replace(
    '    return ch.start;',
    '    return pos;');
  assert.notStrictEqual(m11, SRC, 'm11 没改到');
  const mut = load(m11);
  const 强调隐藏 = [{ from: 0, to: 2 }, { from: 4, to: 6 }];
  assert.notStrictEqual(mut.lineStartInsertPoint(强调隐藏, doc('**读者**：接手'), 2), 0,
    'm11 没红：`**` 仍会被劈开');
  assert.strictEqual(S.lineStartInsertPoint(强调隐藏, doc('**读者**：接手'), 2), 0, '负对照：产品版退到 0');
});

test('变异 m12：去掉"必须顶到行首"的判据 ⇒ 句子中间也被搬到行首', function () {
  const m12 = SRC.replace(
    '    if (行.from !== ch.start) return -1;',
    '');
  assert.notStrictEqual(m12, SRC, 'm12 没改到');
  const mut = load(m12);
  assert.strictEqual(mut.lineStartInsertPoint([{ from: 2, to: 4 }], doc('前**重**后'), 4), 2,
    'm12 没红：句子中间的 `**` 也被整条搬到行首');
  assert.strictEqual(S.lineStartInsertPoint([{ from: 2, to: 4 }], doc('前**重**后'), 4), -1, '负对照：产品版按原样插');
});

test('变异 m13：去掉"链后没有可见内容就不劫持"的判据 ⇒ `>` 独占一行时换行又跑到标记前面', function () {
  const m13 = SRC.replace(
    '    if (pos >= 行.to) return -1;\n'
    + '    if (typeof 行.text === \'string\' && !/\\S/.test(行.text.slice(pos - 行.from))) return -1;',
    '');
  assert.notStrictEqual(m13, SRC, 'm13 没改到');
  const mut = load(m13);
  assert.strictEqual(mut.lineStartInsertPoint([{ from: 2, to: 3 }], doc('甲\n>'), 3), 2,
    'm13 没红：行尾光标又退到链首（`blocks/W5` 那个形态）');
  assert.strictEqual(S.lineStartInsertPoint([{ from: 2, to: 3 }], doc('甲\n>'), 3), -1, '负对照：产品版按原样插');
});

test('变异 m14：只看行尾、不看链后是不是只剩空白 ⇒ `> ` 的空引用行又被劫持', function () {
  const m14 = SRC.replace(
    '    if (typeof 行.text === \'string\' && !/\\S/.test(行.text.slice(pos - 行.from))) return -1;',
    '');
  assert.notStrictEqual(m14, SRC, 'm14 没改到');
  const mut = load(m14);
  assert.strictEqual(mut.lineStartInsertPoint([{ from: 2, to: 3 }], doc('甲\n> '), 3), 2,
    'm14 没红：链后只剩尾随空白时仍被搬到行首');
  assert.strictEqual(S.lineStartInsertPoint([{ from: 2, to: 3 }], doc('甲\n> '), 3), -1, '负对照：产品版按原样插');
});

// ── 变异自测（`bugs/0308`，行尾方向的 `bugs/0105` 镜像）─────────────────────
test('变异 m21：插入点不挪到链尾 ⇒ 闭合 `**` 又被劈到下一行', function () {
  const m21 = SRC.replace('    return 行.to;', '    return pos;');
  assert.notStrictEqual(m21, SRC, 'm21 没改到');
  const mut = load(m21);
  const 强调隐藏 = [{ from: 0, to: 2 }, { from: 8, to: 10 }];
  assert.notStrictEqual(mut.lineEndInsertPoint(强调隐藏, doc('**asdfdf**'), 8), 10,
    'm21 没红：闭合 `**` 仍会被劈到下一行');
  assert.strictEqual(S.lineEndInsertPoint(强调隐藏, doc('**asdfdf**'), 8), 10, '负对照：产品版挪到链尾');
});

test('变异 m22：去掉"光标前面要有可见内容"的判据 ⇒ 整行只剩标记时也被劫持', function () {
  const m22 = SRC.replace(
    '    if (!/\\S/.test(行.text.slice(0, pos - 行.from))) return -1;',
    '');
  assert.notStrictEqual(m22, SRC, 'm22 没改到');
  const mut = load(m22);
  assert.strictEqual(mut.lineEndInsertPoint([{ from: 0, to: 2 }], doc('**'), 0), 2,
    'm22 没红：`**` 独占一行时标记被甩到新行上面');
  assert.strictEqual(S.lineEndInsertPoint([{ from: 0, to: 2 }], doc('**'), 0), -1, '负对照：产品版按原样插');
});

test('变异 m23：不看链后是不是只剩空白 ⇒ 句子中间的标记也被搬到行末', function () {
  const m23 = SRC.replace(
    '    if (!/^\\s*$/.test(行.text.slice(ch.end - 行.from))) return -1;',
    '');
  assert.notStrictEqual(m23, SRC, 'm23 没改到');
  const mut = load(m23);
  assert.strictEqual(mut.lineEndInsertPoint([{ from: 1, to: 3 }, { from: 4, to: 6 }], doc('前**重**后'), 4), 7,
    'm23 没红：链后还有可见内容时仍被搬到行末');
  assert.strictEqual(S.lineEndInsertPoint([{ from: 1, to: 3 }, { from: 4, to: 6 }], doc('前**重**后'), 4), -1,
    '负对照：产品版按原样插');
});

// ── 变异自测（`bugs/0305`）：两条判据各自承重 ───────────────────────────────
//    m19 去掉"上一行空行"这一档 ⇒ 用户回到「删也删不掉、行距回不去」；
//    m20 把"只认列表行"的判据去掉 ⇒ 标题前面那条正常空行被 ⌫ 吃掉（过度修正）。
test('变异 m19 / m20：空行档与"只认列表行"各自承重（`bugs/0305`）', function () {
  const m19 = SRC.replace(
    '    const 空行反 = backOverBlankLine(doc, hidden, 起点);\n    if (空行反) return 空行反;\n', '');
  assert.notStrictEqual(m19, SRC, 'm19 没改到');
  const 文本 = '甲\n\n- 丙';
  assert.deepStrictEqual(load(m19).deleteRange(doc(文本), { anchor: 5, head: 5 }, { hidden: [{ from: 3, to: 5 }] }),
    { from: 3, to: 5 }, 'm19 没红：空行删不掉，标记链反被删');
  assert.deepStrictEqual(S.deleteRange(doc(文本), { anchor: 5, head: 5 }, { hidden: [{ from: 3, to: 5 }] }),
    { from: 2, to: 3 }, '负对照：产品版删的是空行');

  const m20 = SRC.replace(
    '    if (!/^[ \\t]*(?:[-*+]|\\d{1,9}[.)])(?:[ \\t]|$)/.test(String(行.text || \'\'))) return null;',
    '    if (false) return null;');
  assert.notStrictEqual(m20, SRC, 'm20 没改到');
  assert.deepStrictEqual(load(m20).deleteRange(doc('甲\n\n# 乙'), { anchor: 5, head: 5 }, { hidden: [{ from: 3, to: 5 }] }),
    { from: 2, to: 3 }, 'm20 没红：标题前面那条正常空行被吃掉了');
  assert.deepStrictEqual(S.deleteRange(doc('甲\n\n# 乙'), { anchor: 5, head: 5 }, { hidden: [{ from: 3, to: 5 }] }),
    { from: 3, to: 5 }, '负对照：产品版仍删标题标记');
});

// ── 变异自测（`bugs/0317` / `bugs/0111` A6）──────────────────────────────────
//    m31：映射输入退回**合并**区间 ⇒ 锚点被吸到反引号之后（0317 复现）；
//    m41：反向链退回**合并隐藏集** ⇒ `- **甲**` 又同时删掉块前缀与开场 `**`。
test('变异 m31：映射输入用合并区间 ⇒ 锚点 4 必被吸到 5（`bugs/0317`）', function () {
  const m31 = SRC.replace(
    'plan && plan.rawRanges ? plan.rawRanges : hiddenOfPlan(plan)',
    'hiddenOfPlan(plan)');
  assert.notStrictEqual(m31, SRC, 'm31 没改到');
  const 计划 = {
    ranges: [{ from: 0, to: 4 }],
    rawRanges: [{ from: 0, to: 3 }, { from: 3, to: 4 }],
  };
  const mut = load(m31);
  const ext = mut.legalFilter(真CM6, { plan: function () { return 计划; } });
  const st = 真CM6.EditorState.create({
    doc: '2. `x`',
    selection: { anchor: 3 },
    extensions: ext,
  });
  const tr = st.update({ changes: { from: 3, insert: '#' }, selection: { anchor: 4 } });
  assert.strictEqual(tr.newSelection.main.head, 5, 'm31 没红：合并输入把锚点吸到了反引号之后');
  assert.strictEqual(过真兜底(计划, '2. `x`', 3, { from: 3, insert: '#' }, { anchor: 4 }).head, 4,
    '负对照：产品版用 `rawRanges` ⇒ 停在 4');
});

test('变异 m41：反向链用合并隐藏集 ⇒ `- **甲**` 一次删掉 `[0,4)`（`bugs/0111` A6）', function () {
  const m41 = SRC.replace(
    '    const pre = (prefix === undefined || prefix === null) ? hidden : prefix;',
    '    const pre = hidden;');
  assert.notStrictEqual(m41, SRC, 'm41 没改到');
  const 计划 = {
    hidden: [{ from: 0, to: 4 }],
    prefix: [{ from: 0, to: 2 }],
  };
  assert.deepStrictEqual(load(m41).deleteRange(doc('- **甲**'), { anchor: 4, head: 4 }, 计划),
    { from: 0, to: 4 }, 'm41 没红：链又跨到了成对行内标记');
  assert.deepStrictEqual(S.deleteRange(doc('- **甲**'), { anchor: 4, head: 4 }, 计划),
    { from: 0, to: 2 }, '负对照：产品版只删块前缀');
});

// ── ⭐ `bugs/0111` K3：引用内列表项正文起点 ⌫ **只退一层** ─────────────────────
//
// 失效形态：`> - 正文` 的 `prefixLevels` 若不存在或被当成一条链，一次 ⌫ 删 `[0,4)`
// （`> - ` 两层一起没）；正确形态是第一次只删列表那一层 `[2,4)`、留下 `> `。

test('K3-1：`> - 正文` 正文起点 ⌫ ⇒ 只删列表层 `{2,4}`（`> ` 留下）', function () {
  const 计划 = {
    hidden: [{ from: 0, to: 4 }],
    prefix: [{ from: 0, to: 4 }],
    levels: [{ from: 0, to: 2 }, { from: 2, to: 4 }],
  };
  assert.deepStrictEqual(S.deleteRange(doc('> - 正文'), { anchor: 4, head: 4 }, 计划),
    { from: 2, to: 4 }, '第一次 ⌫ 只该退列表那一层');

  // 变异 m43：关掉分层分支 ⇒ 退回旧跨度 `[0,4)`（一次退两层）。
  const m43 = SRC.replace(
    '        if (最近) return { from: 最近.from, to: pos };',
    '        if (false) return { from: 最近.from, to: pos };');
  assert.notStrictEqual(m43, SRC, 'm43 没改到');
  assert.deepStrictEqual(load(m43).deleteRange(doc('> - 正文'), { anchor: 4, head: 4 }, 计划),
    { from: 0, to: 4 }, 'm43 没红：分层分支没承重');
});

test('K3-2：`> > 文` 两层引用 ⇒ 一次 ⌫ 只删最内层 `{2,4}`', function () {
  const 计划 = {
    hidden: [{ from: 0, to: 4 }],
    prefix: [{ from: 0, to: 4 }],
    levels: [{ from: 0, to: 2 }, { from: 2, to: 4 }],
  };
  assert.deepStrictEqual(S.deleteRange(doc('> > 文'), { anchor: 4, head: 4 }, 计划),
    { from: 2, to: 4 }, '第二次才该删外层 `> `');

  // 变异 m44：整个分层块停用 ⇒ 两层 `>` 又被并成一条链。
  const m44 = SRC.replace('      if (levels) {', '      if (false) {');
  assert.notStrictEqual(m44, SRC, 'm44 没改到');
  assert.deepStrictEqual(load(m44).deleteRange(doc('> > 文'), { anchor: 4, head: 4 }, 计划),
    { from: 0, to: 4 }, 'm44 没红：分层块没承重');
});

// ⭐ `- [ ] 甲` 的"一层"来自 `decorations.js`：任务框必须并进列表标记层。
//    ⇒ 这一条连**产品 markers()** 一起断言；变异打在装饰层的合并上（⛔ 不在 selection.js 里造第二套分层）。
const DECO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'live', 'decorations.js'), 'utf8');
const DECO = require('../../src/live/decorations.js');
const { markdownLanguage } = require('@codemirror/lang-markdown');

/** 在独立模块作用域里跑一遍装饰层源码（`./geometry.js` 映射到产品那份）。 */
function loadDeco(src) {
  const mod = { exports: {} };
  const req = function (p) {
    return p === './geometry.js' ? require('../../src/live/geometry.js') : require(p);
  };
  new Function('module', 'window', 'require', src)(mod, undefined, req);
  return mod.exports;
}

/** 这份源码的分层块前缀（真 `markers()`，⛔ 不手写）。 */
function 分层(dmod, text) {
  return dmod.markers(text, { tree: markdownLanguage.parser.parse(text) }).prefixLevels;
}

test('K3-3：`- [ ] 甲` 的列表标记与任务框合成一层 ⇒ 一次 ⌫ 删 `{0,6}`', function () {
  const 文本 = '- [ ] 甲';
  const 层级 = 分层(DECO, 文本);
  assert.deepStrictEqual(层级, [{ from: 0, to: 6 }], '任务框必须并进列表那一层');
  assert.deepStrictEqual(S.deleteRange(doc(文本), { anchor: 6, head: 6 }, {
    hidden: [{ from: 0, to: 6 }], prefix: [{ from: 0, to: 6 }], levels: 层级,
  }), { from: 0, to: 6 });

  // 变异 m45：任务框不并入 ⇒ 分层变成 `[0,2)` / `[2,6)`，⌫ 只会删掉任务框那一层。
  const m45 = DECO_SRC.replace('添层(n, node.from, 止, true);', '添层(n, node.from, 止);');
  assert.notStrictEqual(m45, DECO_SRC, 'm45 没改到');
  const 坏层 = 分层(loadDeco(m45), 文本);
  assert.deepStrictEqual(坏层, [{ from: 0, to: 2 }, { from: 2, to: 6 }],
    'm45 没红：任务框仍并进了列表层');
  assert.deepStrictEqual(S.deleteRange(doc(文本), { anchor: 6, head: 6 }, {
    hidden: [{ from: 0, to: 6 }], prefix: [{ from: 0, to: 6 }], levels: 坏层,
  }), { from: 2, to: 6 }, 'm45 的实际后果：只删掉 `[ ] `');
});

test('K3-4 负对照：不传 `levels`（老 plan）⇒ 与今天一致删整条 `{0,4}`', function () {
  assert.deepStrictEqual(S.deleteRange(doc('> - 正文'), { anchor: 4, head: 4 }, {
    hidden: [{ from: 0, to: 4 }], prefix: [{ from: 0, to: 4 }],
  }), { from: 0, to: 4 });

  // 变异 m46：调用方没给 `levels`，`deleteRange` 却凭空造一份 ⇒ fail-closed 破功。
  const m46 = SRC.replace('    const levels = o.levels;',
    '    const levels = o.levels || [{ from: 2, to: 4 }];');
  assert.notStrictEqual(m46, SRC, 'm46 没改到');
  assert.deepStrictEqual(load(m46).deleteRange(doc('> - 正文'), { anchor: 4, head: 4 }, {
    hidden: [{ from: 0, to: 4 }], prefix: [{ from: 0, to: 4 }],
  }), { from: 2, to: 4 }, 'm46 没红：缺省没有回落到旧跨度');
});

// ── 阅读态双击 / 三击：手势松手早于视图就绪时也要落出选区（`bugs/0333`）──────
//
// ⭐ 形态（用户 2026-11-18：「引用模块中的内容，双击没有办法选中整段」）：
//    阅读态那一下 `mousedown` 被 `onLiveDocDown` 的 `preventDefault` 拦掉（原生词选已不可能），
//    随后异步 `live.begin` 建视图；**两次点击都可能在视图就绪之前完成** ⇒ 宿主记下的手势
//    带着 `released === true` 到达 `installMouse`。旧行为只让「第一次 `mousemove`」接手拖拽，
//    纯双击没有 move ⇒ 新视图里只有一个插入符，**那个词根本没被选中**。
//    引用块 / 代码块最容易稳现：整块是一次更重的 `live.begin`，视图几乎必然晚于第二次点击。
// ⭐ 判据：`{released:true, detail:2}` ⇒ 落一个词；`detail:3` ⇒ 落一行；
//    `detail:1` ⇒ 什么都不落（⛔ 单击不能变成"选一个词"）；
//    落地之后**不建拖拽态**（⛔ 悬停不能改选区）；用户在新视图里重新按下 ⇒ 多击作废。

/** 装一个能被我们驱动事件的最小视图。`落点` 可以是函数（返回值非整数 ⇒ 当作"量不到"）。 */
function 多击夹具(文本, 落点) {
  const domL = {};
  const docL = {};
  const view = {
    state: { doc: doc(文本), selection: { main: { anchor: 0, head: 0 } } },
    contentDOM: { getBoundingClientRect: function () { return { right: 10000 }; } },
    posAtCoords: function () {
      const p = typeof 落点 === 'function' ? 落点() : 落点;
      return Number.isInteger(p) ? p : null;
    },
    coordsAtPos: function (p) { return { left: p * 10, top: 0 }; },
    dispatch: function (tr) { view.派发.push(tr); },
    requestMeasure: function () {},
    派发: [],
  };
  view.dom = {
    addEventListener: function (n, f) { domL[n] = f; },
    removeEventListener: function (n) { delete domL[n]; },
    ownerDocument: {
      addEventListener: function (n, f) { docL[n] = f; },
      removeEventListener: function (n) { delete docL[n]; },
    },
  };
  return { view: view, domL: domL, docL: docL };
}

/** 等一拍：多击落地走 `setTimeout(0)`（它必须排在 `focusAt` 之后）。 */
function 等一拍(ms) {
  return new Promise(function (r) { setTimeout(r, ms || 5); });
}

test('⭐⭐ 双击（松手早于视图就绪）⇒ 新视图里那个词被选中（`bugs/0333`）', async function () {
  const f = 多击夹具('curl -H x', 2); // 点在 `curl` 里
  const uninstall = S.installMouse(f.view, {
    gesture: { clientX: 20, clientY: 0, shiftKey: false, detail: 2, at: Date.now(), released: true },
    focus: function () {}, onSelect: function () {},
  });
  try { await 等一拍(); } finally { uninstall(); }
  assert.deepStrictEqual(f.view.派发.map(function (t) { return t.selection; }),
    [{ anchor: 0, head: 4 }], '双击 ⇒ 只落一次「`curl` 这个词」');
});

test('三击 ⇒ 落整行（与编辑态 `detail >= 3` 同一口径）', async function () {
  const f = 多击夹具('curl -H x\n-d y', 3);
  const uninstall = S.installMouse(f.view, {
    gesture: { clientX: 30, clientY: 0, shiftKey: false, detail: 3, at: Date.now(), released: true },
    focus: function () {}, onSelect: function () {},
  });
  try { await 等一拍(); } finally { uninstall(); }
  assert.deepStrictEqual(f.view.派发.map(function (t) { return t.selection; }),
    [{ anchor: 0, head: 9 }], '三击 ⇒ 整行 `curl -H x`（⛔ 不跨到第二行）');
});

test('⭐ 负对照：单击松手早于视图就绪 ⇒ 一个选区都不落（⛔ 不许变成"选一个词"）', async function () {
  const f = 多击夹具('curl -H x', 2);
  const uninstall = S.installMouse(f.view, {
    gesture: { clientX: 20, clientY: 0, shiftKey: false, detail: 1, at: Date.now(), released: true },
    focus: function () {}, onSelect: function () {},
  });
  try { await 等一拍(); } finally { uninstall(); }
  assert.strictEqual(f.view.派发.length, 0, '单击的插入符由 `focusAt` 负责，这里⛔ 不抢');
});

test('⭐ 布局还没就绪 ⇒ 有界重试；就绪之后落在同一个词上', async function () {
  let 次 = 0;
  const f = 多击夹具('curl -H x', function () { return 次++ < 2 ? NaN : 2; });
  const uninstall = S.installMouse(f.view, {
    gesture: { clientX: 20, clientY: 0, shiftKey: false, detail: 2, at: Date.now(), released: true },
    focus: function () {}, onSelect: function () {},
  });
  try { await 等一拍(120); } finally { uninstall(); }
  assert.deepStrictEqual(f.view.派发.map(function (t) { return t.selection; }),
    [{ anchor: 0, head: 4 }], '前两次量不到 ⇒ 重试，最终仍然只落一次词');
});

test('⭐ 落地之后⛔ 不建拖拽态：悬停改不动选区（变异：改用 `startDrag`）', async function () {
  const f = 多击夹具('curl -H x', 2);
  const uninstall = S.installMouse(f.view, {
    gesture: { clientX: 20, clientY: 0, shiftKey: false, detail: 2, at: Date.now(), released: true },
    focus: function () {}, onSelect: function () {},
  });
  try {
    await 等一拍();
    f.docL.mousemove({
      buttons: 1, clientX: 40, clientY: 0, detail: 1, shiftKey: false,
      preventDefault: function () {}, stopPropagation: function () {},
    });
  } finally { uninstall(); }
  assert.deepStrictEqual(f.view.派发.map(function (t) { return t.selection; }),
    [{ anchor: 0, head: 4 }], '用户没有按下 ⇒ `mousemove` 一次也不许改选区');
});

test('⭐ 用户在新视图里重新按下 ⇒ 那一击作废（⛔ 不许把后来的点击覆盖成词选）', async function () {
  const f = 多击夹具('curl -H x', 2);
  const uninstall = S.installMouse(f.view, {
    gesture: { clientX: 20, clientY: 0, shiftKey: false, detail: 2, at: Date.now(), released: true },
    focus: function () {}, onSelect: function () {},
  });
  try {
    f.domL.mousedown({
      button: 0, clientX: 20, clientY: 0, detail: 1, shiftKey: false,
      preventDefault: function () {}, stopPropagation: function () {},
    });
    await 等一拍();
  } finally { uninstall(); }
  assert.deepStrictEqual(f.view.派发.map(function (t) { return t.selection; }),
    [{ anchor: 2, head: 2 }], '新按下自己算落点（插入符），多击那次不再补一次词选');
});

test('⭐⭐ 第三种时序：按下时视图已就绪、松手才到 ⇒ 松手那一下落词（`bugs/0333`）', async function () {
  // `released !== true` ⇒ 进 `pending`（拖拽交接）。可用户**没有拖**：
  // 第一次 `mousemove` 永远不会来，拖拽交接永远等不到 ⇒ 松手必须自己把这一击落地。
  const f = 多击夹具('curl -H x', 2);
  const uninstall = S.installMouse(f.view, {
    gesture: { clientX: 20, clientY: 0, shiftKey: false, detail: 2, at: Date.now(), released: false },
    focus: function () {}, onSelect: function () {},
  });
  try {
    f.docL.mouseup({ button: 0, clientX: 20, clientY: 0, detail: 2, shiftKey: false });
    await 等一拍();
  } finally { uninstall(); }
  assert.deepStrictEqual(f.view.派发.map(function (t) { return t.selection; }),
    [{ anchor: 0, head: 4 }], '松手之后落下「`curl`」这一个词');
});

test('⭐ 负对照：同一时序下单击松手 ⇒ 一个选区都不落', async function () {
  const f = 多击夹具('curl -H x', 2);
  const uninstall = S.installMouse(f.view, {
    gesture: { clientX: 20, clientY: 0, shiftKey: false, detail: 1, at: Date.now(), released: false },
    focus: function () {}, onSelect: function () {},
  });
  try {
    f.docL.mouseup({ button: 0, clientX: 20, clientY: 0, detail: 1, shiftKey: false });
    await 等一拍();
  } finally { uninstall(); }
  assert.strictEqual(f.view.派发.length, 0, '单击的插入符由 `focusAt` 负责，⛔ 这里不抢');
});

test('⭐ 拖过就不再补一次词选（`pending` 已被 `mousemove` 接手）', async function () {
  const f = 多击夹具('curl -H x', 2);
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = function () { return 0; };
  const uninstall = S.installMouse(f.view, {
    gesture: { clientX: 20, clientY: 0, shiftKey: false, detail: 2, at: Date.now(), released: false },
    focus: function () {}, onSelect: function () {},
  });
  try {
    // 真的拖了：`mousemove` 带左键 ⇒ `startDrag` 建拖拽态并按本次 move 扩展。
    f.docL.mousemove({
      buttons: 1, clientX: 40, clientY: 0, detail: 2, shiftKey: false,
      preventDefault: function () {}, stopPropagation: function () {},
    });
    const 拖后 = f.view.派发.length;
    f.docL.mouseup({ button: 0, clientX: 40, clientY: 0, detail: 2, shiftKey: false });
    await 等一拍();
    assert.strictEqual(f.view.派发.length, 拖后, '松手⛔ 不许再补一次"整词"（那会把拖选结果吞回去）');
    assert.ok(拖后 >= 2, '拖拽本身应当派过选区（词选 + 扩展）');
  } finally {
    uninstall();
    globalThis.requestAnimationFrame = raf;
  }
});

test('⭐ 卸载时不往正在拆掉的视图里写选区（`uninstall` 里的 `up()` 让路）', async function () {
  const f = 多击夹具('curl -H x', 2);
  const uninstall = S.installMouse(f.view, {
    gesture: { clientX: 20, clientY: 0, shiftKey: false, detail: 2, at: Date.now(), released: false },
    focus: function () {}, onSelect: function () {},
  });
  uninstall();
  await 等一拍();
  assert.strictEqual(f.view.派发.length, 0, '拆视图那一下⛔ 不派选区');
});

test('变异 m51：松手时不接多击 ⇒ 第三种时序那条必红', async function () {
  const m51 = SRC.replace(
    'if (没拖过 && 待落地 && !卸了 && (待落地.detail || 1) >= 2) {',
    'if (false) {');
  assert.notStrictEqual(m51, SRC, 'm51 没改到');
  const mut = load(m51);
  const f = 多击夹具('curl -H x', 2);
  const uninstall = mut.installMouse(f.view, {
    gesture: { clientX: 20, clientY: 0, shiftKey: false, detail: 2, at: Date.now(), released: false },
    focus: function () {}, onSelect: function () {},
  });
  try {
    f.docL.mouseup({ button: 0, clientX: 20, clientY: 0, detail: 2, shiftKey: false });
    await 等一拍();
  } finally { uninstall(); }
  assert.strictEqual(f.view.派发.length, 0, 'm51 没红：松手之后仍然没有词选（缺陷原样）');
});

test('变异 m47：多击手势不接（还原缺陷）⇒ 双击那条必红', async function () {
  const m47 = SRC.replace(
    'if (g && g.released === true && (g.detail || 1) >= 2) multiClick = g;',
    'void g;');
  assert.notStrictEqual(m47, SRC, 'm47 没改到');
  const mut = load(m47);
  const f = 多击夹具('curl -H x', 2);
  const uninstall = mut.installMouse(f.view, {
    gesture: { clientX: 20, clientY: 0, shiftKey: false, detail: 2, at: Date.now(), released: true },
    focus: function () {}, onSelect: function () {},
  });
  try { await 等一拍(); } finally { uninstall(); }
  assert.strictEqual(f.view.派发.length, 0, 'm47 没红：缺陷形态（只有插入符、没有词选）仍在');
});

test('变异 m48：改用 `startDrag` ⇒ 悬停改选区那条必红', async function () {
  const m48 = SRC.replace('        落多击(p0, g.detail || 2);',
    '        startDrag(p0, g.detail || 2, { shiftKey: false });');
  assert.notStrictEqual(m48, SRC, 'm48 没改到');
  const mut = load(m48);
  const f = 多击夹具('curl -H x', 2);
  const uninstall = mut.installMouse(f.view, {
    gesture: { clientX: 20, clientY: 0, shiftKey: false, detail: 2, at: Date.now(), released: true },
    focus: function () {}, onSelect: function () {},
  });
  try {
    await 等一拍();
    // ⚠️ 变异体走的是 `moveHandler` 的**拖拽分支**，它接着会 `requestAnimationFrame`（node 里没有）。
    //    这里只替它补一个空帧器，⛔ 不改判据：要看的是"有没有多派一次选区"。
    const 旧raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = function () { return 0; };
    try {
      f.docL.mousemove({
        buttons: 1, clientX: 40, clientY: 0, detail: 1, shiftKey: false,
        preventDefault: function () {}, stopPropagation: function () {},
      });
    } finally { globalThis.requestAnimationFrame = 旧raf; }
  } finally { uninstall(); }
  assert.ok(f.view.派发.length >= 2, 'm48 没红：没有按下的悬停仍然改了选区（悬空拖拽）');
});
