// 选区与光标移动的纯逻辑：归一化、词 / 字素边界、隐藏区间吸附、删除区间、移动语义。
// 守的是 `INV-LIVE-15/16/17` 与 `design/0061` 的分层。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.rmd;
}

const S = load('src/live/selection.js').liveSelection;

/** CM6 `Text` 的最小替身：`lineAt(pos).to` 是行尾**之前**（不含换行）。 */
function doc(text) {
  const s = String(text);
  const lines = s.split('\n');
  const starts = [];
  let p = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(p);
    p += lines[i].length + 1;
  }
  return {
    length: s.length,
    lines: lines.length,
    sliceString: function (from, to) {
      return s.slice(from, to);
    },
    lineAt: function (pos) {
      const at = Math.max(0, Math.min(pos, s.length));
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

function viewOf(length) {
  return { state: { doc: { length: length } } };
}

function planOfPlan(plan) {
  return { plan: function () { return plan; } };
}

function at(text, head, cmd, opts) {
  return S.move(doc(text), { anchor: head, head: head }, cmd, opts);
}

test('range 把 anchor/head 归一成半开区间，反向选区也一样', () => {
  assert.deepStrictEqual(S.range({ anchor: 5, head: 2 }), { from: 2, to: 5 });
  assert.deepStrictEqual(S.range({ anchor: 2, head: 5 }), { from: 2, to: 5 });
  assert.deepStrictEqual(S.range({ anchor: 3, head: 3 }), { from: 3, to: 3 });
});

test('range 缺字段或非整数时按 0 / anchor 兜底，不产生 NaN', () => {
  assert.deepStrictEqual(S.range(null), { from: 0, to: 0 });
  assert.deepStrictEqual(S.range({ head: 4 }), { from: 0, to: 4 });
  assert.deepStrictEqual(S.range({ anchor: 2.5, head: 5 }), { from: 0, to: 5 });
});

test('charAt 只取同一逻辑行的码元，换行与越界给空串', () => {
  const d = doc('ab\ncd');
  assert.strictEqual(S.charAt(d, 0), 'a');
  assert.strictEqual(S.charAt(d, 1), 'b');
  assert.strictEqual(S.charAt(d, 2), '');
  assert.strictEqual(S.charAt(d, 3), 'c');
  assert.strictEqual(S.charAt(d, 5), '');
  assert.strictEqual(S.charAt(d, -1), '');
});

test('wordStop 向右跨过整段 ASCII 词，向左回到词首', () => {
  const d = doc('one two');
  assert.strictEqual(S.wordStop(d, 0, 1), 3, '词末是分隔符，先跨过去');
  assert.strictEqual(S.wordStop(d, 1, 1), 3);
  assert.strictEqual(S.wordStop(d, 3, 1), 7);
  assert.strictEqual(S.wordStop(d, 7, -1), 4);
  assert.strictEqual(S.wordStop(d, 5, -1), 4);
});

test('wordStop 对汉字只走一个字（中文没有空格，整段跳会一次到段尾）', () => {
  const d = doc('中文字');
  assert.strictEqual(S.wordStop(d, 0, 1), 1);
  assert.strictEqual(S.wordStop(d, 2, -1), 1);
  assert.strictEqual(S.wordStop(d, 3, -1), 2);
});

test('wordAt 是双击语义：命中哪个词就只给哪个词，不吞相邻词', () => {
  const d = doc('one two');
  assert.deepStrictEqual(S.wordAt(d, 4), { from: 4, to: 7 });
  assert.deepStrictEqual(S.wordAt(d, 5), { from: 4, to: 7 });
  assert.deepStrictEqual(S.wordAt(d, 0), { from: 0, to: 3 });
});

test('wordAt 落在词末分隔符时取左边那个词，不跨行', () => {
  const d = doc('one two');
  assert.deepStrictEqual(S.wordAt(d, 3), { from: 0, to: 3 });
  assert.deepStrictEqual(S.wordAt(d, 7), { from: 4, to: 7 });
});

test('wordAt 对汉字只取一个字，对整段分隔符给出分隔符段', () => {
  const cjk = doc('中文');
  assert.deepStrictEqual(S.wordAt(cjk, 0), { from: 0, to: 1 });
  assert.deepStrictEqual(S.wordAt(cjk, 1), { from: 1, to: 2 });
  const gap = doc('a  b');
  assert.deepStrictEqual(S.wordAt(gap, 2), { from: 1, to: 3 });
});

test('graphemeBack / Forward 不把代理对切成半个字符', () => {
  const d = doc('a😀b');
  assert.strictEqual(S.graphemeBack(d, 3), 1);
  assert.strictEqual(S.graphemeForward(d, 1), 3);
});

test('graphemeBack / Forward 把组合字符当成一个完整字素', () => {
  const d = doc('éx');
  assert.strictEqual(S.graphemeBack(d, 2), 0);
  assert.strictEqual(S.graphemeForward(d, 0), 2);
});

test('dragRange 字符单位只动 head，基准折叠时从头拖', () => {
  const d = doc('abcdef');
  assert.deepStrictEqual(S.dragRange(d, 1, { from: 2, to: 2 }, 5), { anchor: 2, head: 5 });
  assert.deepStrictEqual(S.dragRange(d, 1, null, 5), { anchor: 5, head: 5 });
});

test('dragRange 词单位以初选区间为支点，往左扩时锚右端', () => {
  const d = doc('one two three');
  const base = { from: 4, to: 7 };
  assert.deepStrictEqual(S.dragRange(d, 2, base, 8), { anchor: 4, head: 13 });
  assert.deepStrictEqual(S.dragRange(d, 2, base, 3), { anchor: 7, head: 0 });
  assert.deepStrictEqual(S.dragRange(d, 2, base, 5), { anchor: 4, head: 7 });
});

test('dragRange 行单位扩到目标行行尾 / 行首，区间内保持原选', () => {
  const d = doc('ab\ncd\nef');
  const base = { from: 1, to: 2 };
  assert.deepStrictEqual(S.dragRange(d, 3, base, 3), { anchor: 1, head: 5 });
  assert.deepStrictEqual(S.dragRange(d, 3, base, 0), { anchor: 2, head: 0 });
  assert.deepStrictEqual(S.dragRange(d, 3, base, 1), { anchor: 2, head: 0 });
  assert.deepStrictEqual(S.dragRange(d, 3, { from: 1, to: 5 }, 3), { anchor: 1, head: 5 });
});

test('legalEdge 只推开严格内部的落点，区间端点保持不动', () => {
  const hidden = [{ from: 2, to: 5 }];
  assert.strictEqual(S.legalEdge(hidden, 2, -1), 2);
  assert.strictEqual(S.legalEdge(hidden, 5, 1), 5);
  assert.strictEqual(S.legalEdge(hidden, 3, -1), 2);
  assert.strictEqual(S.legalEdge(hidden, 3, 1), 5);
  assert.strictEqual(S.legalEdge(hidden, 6, -1), 6);
  assert.strictEqual(S.legalEdge(hidden, 3.5, 1), 3.5);
});

test('legalNearest 取较近端点，等距取左', () => {
  const hidden = [{ from: 2, to: 5 }];
  assert.strictEqual(S.legalNearest(hidden, 3), 2);
  assert.strictEqual(S.legalNearest(hidden, 4), 5);
  assert.strictEqual(S.legalNearest(hidden, 2), 2);
  assert.deepStrictEqual(S.legalNearest([{ from: 2, to: 4 }], 3), 2);
});

test('listContentStart 只对列表行行首生效，plain 与空正文不算', () => {
  const plan = {
    listLines: [
      { from: 0, contentFrom: 2, kind: 'ul' },
      { from: 10, contentFrom: 12, kind: 'plain' },
      { from: 20, contentFrom: 20, kind: 'ol' },
    ],
  };
  assert.strictEqual(S.listContentStart(plan, 0), 2);
  assert.strictEqual(S.listContentStart(plan, 1), -1);
  assert.strictEqual(S.listContentStart(plan, 10), -1);
  assert.strictEqual(S.listContentStart(plan, 20), -1);
  assert.strictEqual(S.listContentStart(null, 0), -1);
});

test('hiddenRanges 只给标记区间，不含围栏行的伪区间', () => {
  const plan = { ranges: [{ from: 2, to: 4 }], fenceLines: [{ from: 0, to: 5 }] };
  assert.deepStrictEqual(S.hiddenRanges({}, planOfPlan(plan)), [{ from: 2, to: 4 }]);
  assert.deepStrictEqual(S.hiddenRanges({}, { plan: () => { throw new Error('坏'); } }), []);
});

test('legalRanges 把围栏行与折叠行编成跨整行的伪区间并合并', () => {
  const plan = {
    ranges: [{ from: 2, to: 4 }],
    fenceLines: [{ from: 0, to: 5 }],
    collapsedLines: [{ from: 10, to: 12 }],
  };
  assert.deepStrictEqual(S.legalRanges({}, planOfPlan(plan)), [
    { from: -1, to: 6 },
    { from: 9, to: 13 },
  ]);
});

test('protectedRanges 含围栏行（删换行会吞掉可见内容）但不含折叠行', () => {
  const plan = {
    ranges: [{ from: 2, to: 4 }],
    fenceLines: [{ from: 0, to: 5 }],
    collapsedLines: [{ from: 10, to: 12 }],
  };
  assert.deepStrictEqual(S.protectedRanges({}, planOfPlan(plan)), [{ from: -1, to: 6 }]);
});

test('snapCaret 按方向把光标吸到隐藏区间端点', () => {
  const plan = { ranges: [{ from: 5, to: 8 }] };
  const opts = planOfPlan(plan);
  assert.strictEqual(S.snapCaret(viewOf(20), 6, -1, opts), 5);
  assert.strictEqual(S.snapCaret(viewOf(20), 6, 1, opts), 8);
  assert.strictEqual(S.snapCaret(viewOf(20), 6, 0, opts), 5);
  assert.strictEqual(S.snapCaret(viewOf(20), 5, -1, opts), 5);
});

test('snapCaret 对整行不可见的围栏行按方向落到上一行末 / 下一行首', () => {
  const plan = { fenceLines: [{ from: 5, to: 8 }] };
  const opts = planOfPlan(plan);
  assert.strictEqual(S.snapCaret(viewOf(20), 6, -1, opts), 4);
  assert.strictEqual(S.snapCaret(viewOf(20), 6, 1, opts), 9);
});

test('snapCaret 把列表行行首吸到正文起点；向左则跨过整条标记', () => {
  const plan = { listLines: [{ from: 10, contentFrom: 12, kind: 'ul' }] };
  const opts = planOfPlan(plan);
  assert.strictEqual(S.snapCaret(viewOf(20), 10, 0, opts), 12);
  assert.strictEqual(S.snapCaret(viewOf(20), 10, 1, opts), 12);
  assert.strictEqual(S.snapCaret(viewOf(20), 10, -1, opts), 9);
});

test('snapRange 两端分别向左 / 向右吸附，并保持 anchor/head 方向', () => {
  const plan = { ranges: [{ from: 5, to: 8 }] };
  const opts = planOfPlan(plan);
  assert.deepStrictEqual(S.snapRange(viewOf(20), { anchor: 6, head: 7 }, opts), { anchor: 5, head: 8 });
  assert.deepStrictEqual(S.snapRange(viewOf(20), { anchor: 7, head: 6 }, opts), { anchor: 8, head: 5 });
});

test('collapsed caretClamp 只在盒子裁切时把光标往左夹，读数无效则不动', () => {
  assert.strictEqual(S.caretClamp(100, 80, 2), 78);
  assert.strictEqual(S.caretClamp(50, 80, 2), 50);
  assert.strictEqual(S.caretClamp(100, 0, 2), 100);
  assert.strictEqual(S.caretClamp(100, 80, 0), 100);
  assert.strictEqual(S.caretClamp(NaN, 80, 2), NaN);
});

test('deleteRange 对选区只删可见字节，部分覆盖的隐藏标记留在原地', () => {
  const d = doc('abcdefghij');
  const hidden = [{ from: 5, to: 8 }];
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 6, head: 7 }, { hidden: hidden }), { from: 8, to: 8 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 3, head: 7 }, { hidden: hidden }), { from: 3, to: 5 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 6, head: 9 }, { hidden: hidden }), { from: 8, to: 9 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 3, head: 9 }, { hidden: hidden }), { from: 3, to: 9 });
});

test('deleteRange 对折叠光标按字素删前 / 后一个字符', () => {
  const d = doc('a😀b');
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 3, head: 3 }, {}), { from: 1, to: 3 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 1, head: 1 }, { forward: true }), { from: 1, to: 3 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 0, head: 0 }, {}), { from: 0, to: 0 });
});

test('deleteRange 先跨过紧邻的隐藏标记，再去删可见字素', () => {
  const d = doc('abcd');
  const hidden = [{ from: 1, to: 2 }];
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 2, head: 2 }, { hidden: hidden }), { from: 0, to: 1 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 1, head: 1 }, { hidden: hidden, forward: true }), { from: 2, to: 3 });
});

test('deleteRange 在只剩整行标记时删标记本体，不吞相邻换行', () => {
  const d = doc('## \nbody');
  const hidden = [{ from: 0, to: 3 }];
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 3, head: 3 }, { hidden: hidden }), { from: 0, to: 3 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 0, head: 0 }, { hidden: hidden, forward: true }), { from: 0, to: 3 });
});

test('deleteRange 的整行标记会走完整条相接的隐藏链', () => {
  const d = doc('- [x] task');
  const hidden = [{ from: 0, to: 2 }, { from: 2, to: 6 }];
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 6, head: 6 }, { hidden: hidden }), { from: 0, to: 6 });
});

test('deleteRange 按词删时先跳过紧邻隐藏标记，再删一个词', () => {
  const d = doc('`x`');
  const hidden = [{ from: 0, to: 1 }, { from: 2, to: 3 }];
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 2, head: 2 }, { hidden: hidden, byWord: true }), { from: 1, to: 2 });
  const plain = doc('one two');
  assert.deepStrictEqual(S.deleteRange(plain, { anchor: 7, head: 7 }, { byWord: true }), { from: 4, to: 7 });
  assert.deepStrictEqual(S.deleteRange(plain, { anchor: 0, head: 0 }, { byWord: true, forward: true }), { from: 0, to: 3 });
  assert.deepStrictEqual(S.deleteRange(plain, { anchor: 3, head: 3 }, { byWord: true, forward: true }), { from: 3, to: 7 });
});

test('deleteRange 按行删到行首 / 行尾，已在端点时退一格', () => {
  const d = doc('ab\ncd');
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 1, head: 1 }, { byLine: true }), { from: 0, to: 1 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 0, head: 0 }, { byLine: true }), { from: 0, to: 0 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 1, head: 1 }, { byLine: true, forward: true }), { from: 1, to: 2 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 2, head: 2 }, { byLine: true, forward: true }), { from: 2, to: 3 });
});

test('move 有选区时不按 Shift 就收到左 / 右端', () => {
  const d = doc('abcdef');
  assert.deepStrictEqual(S.move(d, { anchor: 4, head: 1 }, 'charLeft', {}), { anchor: 1, head: 1, goal: null });
  assert.deepStrictEqual(S.move(d, { anchor: 1, head: 4 }, 'charRight', {}), { anchor: 4, head: 4, goal: null });
});

test('move 按 Shift 只动 head，anchor 留着', () => {
  const d = doc('abcdef');
  assert.deepStrictEqual(S.move(d, { anchor: 2, head: 2 }, 'charRight', { extend: true }), { anchor: 2, head: 3, goal: null });
  assert.deepStrictEqual(S.move(d, { anchor: 2, head: 3 }, 'charLeft', { extend: true }), { anchor: 2, head: 2, goal: null });
});

test('move 的 Home / End 两段式：已在行首行尾再按才换行', () => {
  const t = 'ab\ncd';
  assert.strictEqual(at(t, 4, 'lineStart').head, 3);
  assert.strictEqual(at(t, 3, 'lineStart').head, 0);
  assert.strictEqual(at(t, 0, 'lineEnd').head, 2);
  assert.strictEqual(at(t, 2, 'lineEnd').head, 5);
});

test('move 的文档首尾与未知命令', () => {
  assert.strictEqual(at('ab\ncd', 3, 'docStart').head, 0);
  assert.strictEqual(at('ab\ncd', 0, 'docEnd').head, 5);
  assert.strictEqual(at('ab\ncd', 0, '不存在的命令'), null);
});

test('move 按词移动与 wordStop 同口径', () => {
  assert.strictEqual(at('one two', 0, 'wordRight').head, 3);
  assert.strictEqual(at('one two', 7, 'wordLeft').head, 4);
});

test('move 上下移动保留目标列，穿过短行后还能回到原列', () => {
  const d = doc('abcde\nab\nabcde');
  const down = S.move(d, { anchor: 4, head: 4 }, 'lineDown', {});
  assert.deepStrictEqual(down, { anchor: 8, head: 8, goal: 4 });
  const down2 = S.move(d, { anchor: 8, head: 8 }, 'lineDown', { goal: down.goal });
  assert.deepStrictEqual(down2, { anchor: 13, head: 13, goal: 4 });
  const up = S.move(d, { anchor: 13, head: 13 }, 'lineUp', { goal: 4 });
  assert.deepStrictEqual(up, { anchor: 8, head: 8, goal: 4 });
});

test('move 上下越过文档边界时停在首 / 尾', () => {
  const d = doc('ab\ncd');
  assert.deepStrictEqual(S.move(d, { anchor: 0, head: 0 }, 'lineUp', {}), { anchor: 0, head: 0, goal: 0 });
  assert.deepStrictEqual(S.move(d, { anchor: 5, head: 5 }, 'lineDown', {}), { anchor: 5, head: 5, goal: 2 });
});

test('move 翻页默认十行，边界处夹到首 / 尾', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += (i ? '\n' : '') + 'x';
  const d = doc(text);
  assert.strictEqual(S.move(d, { anchor: 0, head: 0 }, 'pageDown', {}).head, 20);
  assert.strictEqual(S.move(d, { anchor: 20, head: 20 }, 'pageUp', {}).head, 0);
});

test('lineStartInsertPoint 在行首标记链之后把插入点退到链起点', () => {
  const d = doc('**bold** tail');
  const hidden = [{ from: 0, to: 2 }, { from: 6, to: 8 }];
  assert.strictEqual(S.lineStartInsertPoint(hidden, d, 2), 0);
  assert.strictEqual(S.lineStartInsertPoint(hidden, d, 3), -1);
});

test('lineStartInsertPoint 不把句子中间的强调搬到下一段', () => {
  const d = doc('a **b**');
  const hidden = [{ from: 2, to: 4 }, { from: 5, to: 7 }];
  assert.strictEqual(S.lineStartInsertPoint(hidden, d, 4), -1);
});

test('lineStartInsertPoint 在标记后没有可见内容时返回 -1，避免孤立标记', () => {
  const empty = doc('## ');
  assert.strictEqual(S.lineStartInsertPoint([{ from: 0, to: 3 }], empty, 3), -1);
  const spaces = doc('##   ');
  assert.strictEqual(S.lineStartInsertPoint([{ from: 0, to: 3 }], spaces, 3), -1);
});
