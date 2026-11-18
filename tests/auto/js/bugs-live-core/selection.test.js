// 编辑内核 · 选区 / 光标移动 / 隐藏区间 / 删除区间 / 行末吸附。
// 从 `docs/bugs/` 的 0014/0030/0031/0043/0044/0045/0046/0069/0084/0085/0086/0087/0092/0105 倒推。
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

/** CM6 `Text` 的最小替身：`lineAt(pos).to` 不含换行。 */
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

function planOf(plan) {
  return { plan: function () { return plan; } };
}

function at(text, head, cmd, opts) {
  return S.move(doc(text), { anchor: head, head: head }, cmd, opts);
}

// 源自 docs/bugs/0031（编辑态选不了文本与拖动不跟手）
// 同轴向：选区必须先归一成半开区间，反向选区不能产生负长度。
test('range 把 anchor/head 归一成半开区间，反向选区也一样', () => {
  assert.deepStrictEqual(S.range({ anchor: 5, head: 2 }), { from: 2, to: 5 });
  assert.deepStrictEqual(S.range({ anchor: 2, head: 5 }), { from: 2, to: 5 });
  assert.deepStrictEqual(S.range({ anchor: 3, head: 3 }), { from: 3, to: 3 });
});

test('range 缺字段 / 非整数时按 0 / anchor 兜底，不产生 NaN', () => {
  assert.deepStrictEqual(S.range(null), { from: 0, to: 0 });
  assert.deepStrictEqual(S.range({ head: 4 }), { from: 0, to: 4 });
  assert.deepStrictEqual(S.range({ anchor: 2 }), { from: 2, to: 2 });
  assert.deepStrictEqual(S.range({ anchor: 2.5, head: 5 }), { from: 0, to: 5 });
  assert.deepStrictEqual(S.range({ anchor: 3, head: 2.5 }), { from: 3, to: 3 });
});

// 源自 docs/bugs/0014（实时编辑的删除键不生效）
// 同轴向：光标处删除依赖 charAt 的"换行 / 越界给空串"口径。
test('charAt 只取同一逻辑行的码元，换行位置与越界给空串', () => {
  const d = doc('ab\ncd');
  assert.strictEqual(S.charAt(d, 0), 'a');
  assert.strictEqual(S.charAt(d, 1), 'b');
  assert.strictEqual(S.charAt(d, 2), '');
  assert.strictEqual(S.charAt(d, 3), 'c');
  assert.strictEqual(S.charAt(d, 5), '');
  assert.strictEqual(S.charAt(d, -1), '');
});

test('charAt 对全角空格与汉字原样给一个码元', () => {
  const d = doc('　中');
  assert.strictEqual(S.charAt(d, 0).charCodeAt(0), 0x3000);
  assert.strictEqual(S.charAt(d, 1), '中');
});

test('charAt 对代理对按码元返回半个，不擅自合并', () => {
  const d = doc('a😀b');
  assert.strictEqual(S.charAt(d, 1).charCodeAt(0), 0xd83d);
  assert.strictEqual(S.charAt(d, 2).charCodeAt(0), 0xde00);
  assert.strictEqual(S.charAt(d, 3), 'b');
});

// 源自 docs/bugs/0045（在词的起点双击会多选前一个词）
// 同轴向：按词移动与点击命中词必须是两套语义。
test('wordStop 向右跨过整段 ASCII 词，向左回到词首', () => {
  const d = doc('one two');
  assert.strictEqual(S.wordStop(d, 0, 1), 3);
  assert.strictEqual(S.wordStop(d, 1, 1), 3);
  assert.strictEqual(S.wordStop(d, 3, 1), 7);
  assert.strictEqual(S.wordStop(d, 7, -1), 4);
  assert.strictEqual(S.wordStop(d, 5, -1), 4);
});

test('wordStop 对汉字只走一个字，不把整段跳到段尾', () => {
  const d = doc('中文字');
  assert.strictEqual(S.wordStop(d, 0, 1), 1);
  assert.strictEqual(S.wordStop(d, 2, -1), 1);
  assert.strictEqual(S.wordStop(d, 3, -1), 2);
});

test('wordStop 跨过全角标点后进入汉字只走一个字', () => {
  const d = doc('中，文');
  assert.strictEqual(S.wordStop(d, 0, 1), 1);
  assert.strictEqual(S.wordStop(d, 1, 1), 3);
  assert.strictEqual(S.wordStop(d, 2, -1), 0);
});

test('wordStop 在 ASCII 与汉字交界处停下，不混成一类', () => {
  const d = doc('a中b');
  assert.strictEqual(S.wordStop(d, 0, 1), 1);
  assert.strictEqual(S.wordStop(d, 3, -1), 2);
  assert.strictEqual(S.wordStop(d, 2, -1), 1);
});

test('wordStop 对行尾 / 越界位置做夹取后返回同一边界', () => {
  const d = doc('ab');
  assert.strictEqual(S.wordStop(d, 99, 1), 2);
  assert.strictEqual(S.wordStop(d, -3, -1), 0);
});

// ⚠️ 疑似缺陷：日文假名（U+3040–30FF）不在 CJK 类里，被当成整段分隔符，
// 于是 ⌥→ 从假名段首会一次跳到段末，而不是像汉字那样逐字走。
test('wordStop 把假名当分隔符整段跳过（现状）', () => {
  const d = doc('あいう');
  assert.strictEqual(S.wordStop(d, 0, 1), 3);
  assert.strictEqual(S.wordStop(d, 3, -1), 0);
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
  assert.deepStrictEqual(S.wordAt(doc('  a'), 0), { from: 0, to: 2 });
});

test('wordAt 在全角标点旁取左边的词 / 汉字，不吞标点', () => {
  assert.deepStrictEqual(S.wordAt(doc('a，b'), 1), { from: 0, to: 1 });
  assert.deepStrictEqual(S.wordAt(doc('中，文'), 1), { from: 0, to: 1 });
});

test('wordAt 不跨行：行末位置只在本行内扩', () => {
  const d = doc('ab\ncd');
  assert.deepStrictEqual(S.wordAt(d, 2), { from: 0, to: 2 });
  assert.deepStrictEqual(S.wordAt(d, 3), { from: 3, to: 5 });
});

// 源自 docs/bugs/0046（Shift-方向键可以选中半个 Emoji）
// 同轴向：左右移动与正反向删除都必须按整字素簇走。
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

test('graphemeBack / Forward 跨过整个 ZWJ 家庭 emoji', () => {
  const fam = '👨‍👩‍👧‍👦';
  const d = doc('a' + fam + 'b');
  assert.strictEqual(fam.length, 11);
  assert.strictEqual(S.graphemeForward(d, 1), 12);
  assert.strictEqual(S.graphemeBack(d, 12), 1);
});

test('graphemeBack / Forward 对国旗等区域指示符按一个簇处理', () => {
  const d = doc('🇨🇳x');
  assert.strictEqual(S.graphemeForward(d, 0), 4);
  assert.strictEqual(S.graphemeBack(d, 4), 0);
});

test('graphemeBack / Forward 在文档首尾不越界', () => {
  const d = doc('ab');
  assert.strictEqual(S.graphemeBack(d, 0), 0);
  assert.strictEqual(S.graphemeBack(d, -5), 0);
  assert.strictEqual(S.graphemeForward(d, 2), 2);
  assert.strictEqual(S.graphemeForward(d, 99), 2);
});

test('graphemeForward 把换行当一个字素，CRLF 也不劈开', () => {
  assert.strictEqual(S.graphemeForward(doc('a\nb'), 1), 2);
  assert.strictEqual(S.graphemeForward(doc('a\r\nb'), 1), 3);
  assert.strictEqual(S.graphemeBack(doc('a\r\nb'), 3), 1);
});

// 源自 docs/bugs/0044（双击后反向拖动丢掉原选中的词）
// 同轴向：词 / 行单位拖动以初选区间为支点，往左扩时锚右端。
test('dragRange 字符单位只动 head，基准折叠时从头拖', () => {
  const d = doc('abcdef');
  assert.deepStrictEqual(S.dragRange(d, 1, { from: 2, to: 2 }, 5), { anchor: 2, head: 5 });
  assert.deepStrictEqual(S.dragRange(d, 1, null, 5), { anchor: 5, head: 5 });
});

test('dragRange 词单位以初选区间为支点，往左扩时锚右端，回到区间内原样保留', () => {
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

test('dragRange 把越界指针夹进文档后再算', () => {
  const d = doc('abc');
  assert.deepStrictEqual(S.dragRange(d, 1, { from: 1, to: 1 }, 99), { anchor: 1, head: 3 });
  assert.deepStrictEqual(S.dragRange(d, 1, { from: 1, to: 1 }, -9), { anchor: 1, head: 0 });
});

// 源自 docs/bugs/0086（隐藏区间映射方向反了导致边界打字倒序）
// 同轴向：落在隐藏区间严格内部的光标按方向吸附，端点本身是合法边界。
test('legalEdge 只推开严格内部的落点，区间端点保持不动', () => {
  const hidden = [{ from: 2, to: 5 }];
  assert.strictEqual(S.legalEdge(hidden, 2, -1), 2);
  assert.strictEqual(S.legalEdge(hidden, 5, 1), 5);
  assert.strictEqual(S.legalEdge(hidden, 3, -1), 2);
  assert.strictEqual(S.legalEdge(hidden, 3, 1), 5);
  assert.strictEqual(S.legalEdge(hidden, 6, -1), 6);
  assert.strictEqual(S.legalEdge(hidden, 3.5, 1), 3.5);
});

test('legalEdge 在多个区间里二分命中第一个 from<=pos 的区间', () => {
  const hidden = [{ from: 2, to: 4 }, { from: 6, to: 9 }];
  assert.strictEqual(S.legalEdge(hidden, 7, -1), 6);
  assert.strictEqual(S.legalEdge(hidden, 7, 1), 9);
  assert.strictEqual(S.legalEdge(hidden, 5, 1), 5);
});

test('legalNearest 取较近端点，等距取左', () => {
  const hidden = [{ from: 2, to: 5 }];
  assert.strictEqual(S.legalNearest(hidden, 3), 2);
  assert.strictEqual(S.legalNearest(hidden, 4), 5);
  assert.strictEqual(S.legalNearest(hidden, 2), 2);
  assert.deepStrictEqual(S.legalNearest([{ from: 2, to: 4 }], 3), 2);
  assert.strictEqual(S.legalNearest([], 3), 3);
});

test('legalNearest 对非整数位置原样返回，不猜', () => {
  assert.strictEqual(S.legalNearest([{ from: 2, to: 5 }], 3.5), 3.5);
  assert.strictEqual(S.legalNearest([{ from: 2, to: 5 }], NaN), NaN);
});

// 源自 docs/bugs/0023（代码块编辑态仍然显示围栏行）
// 同轴向：围栏行整行塌成 0 高，光标必须能跨过去。
test('hiddenRanges 只给标记区间，plan 抛错时降级为空', () => {
  const plan = { ranges: [{ from: 2, to: 4 }], fenceLines: [{ from: 0, to: 5 }] };
  assert.deepStrictEqual(S.hiddenRanges({}, planOf(plan)), [{ from: 2, to: 4 }]);
  assert.deepStrictEqual(S.hiddenRanges({}, { plan: function () { throw new Error('坏'); } }), []);
  assert.deepStrictEqual(S.hiddenRanges({}, null), []);
});

test('legalRanges 把围栏行与折叠行编成跨整行的伪区间并合并', () => {
  const plan = {
    ranges: [{ from: 2, to: 4 }],
    fenceLines: [{ from: 0, to: 5 }],
    collapsedLines: [{ from: 10, to: 12 }],
  };
  assert.deepStrictEqual(S.legalRanges({}, planOf(plan)), [
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
  assert.deepStrictEqual(S.protectedRanges({}, planOf(plan)), [{ from: -1, to: 6 }]);
  assert.deepStrictEqual(S.protectedRanges({}, planOf(null)), []);
});

test('snapCaret 按方向把光标吸到隐藏区间端点，无方向取较近端', () => {
  const opts = planOf({ ranges: [{ from: 5, to: 8 }] });
  assert.strictEqual(S.snapCaret(viewOf(20), 6, -1, opts), 5);
  assert.strictEqual(S.snapCaret(viewOf(20), 6, 1, opts), 8);
  assert.strictEqual(S.snapCaret(viewOf(20), 6, 0, opts), 5);
  assert.strictEqual(S.snapCaret(viewOf(20), 5, -1, opts), 5);
});

test('snapCaret 对整行不可见的围栏行按方向落到上一行末 / 下一行首', () => {
  const opts = planOf({ fenceLines: [{ from: 5, to: 8 }] });
  assert.strictEqual(S.snapCaret(viewOf(20), 6, -1, opts), 4);
  assert.strictEqual(S.snapCaret(viewOf(20), 6, 1, opts), 9);
});

test('snapCaret 把列表行行首吸到正文起点；向左则跨过整条标记', () => {
  const opts = planOf({ listLines: [{ from: 10, contentFrom: 12, kind: 'ul' }] });
  assert.strictEqual(S.snapCaret(viewOf(20), 10, 0, opts), 12);
  assert.strictEqual(S.snapCaret(viewOf(20), 10, 1, opts), 12);
  assert.strictEqual(S.snapCaret(viewOf(20), 10, -1, opts), 9);
});

test('snapCaret 没 plan 时只夹到 [0, length]，非整数原样', () => {
  assert.strictEqual(S.snapCaret(viewOf(10), -5, 0, null), 0);
  assert.strictEqual(S.snapCaret(viewOf(10), 99, 1, null), 10);
  assert.strictEqual(S.snapCaret({}, 3, 0, null), 3);
  assert.strictEqual(S.snapCaret(viewOf(10), 2.5, 0, planOf(null)), 2.5);
});

test('snapRange 两端分别向左 / 向右吸附，并保持 anchor/head 方向', () => {
  const opts = planOf({ ranges: [{ from: 5, to: 8 }] });
  assert.deepStrictEqual(S.snapRange(viewOf(20), { anchor: 6, head: 7 }, opts), { anchor: 5, head: 8 });
  assert.deepStrictEqual(S.snapRange(viewOf(20), { anchor: 7, head: 6 }, opts), { anchor: 8, head: 5 });
});

test('snapRange 的折叠选区按无方向吸附，并落到列表正文起点', () => {
  const opts = planOf({
    ranges: [{ from: 10, to: 12 }],
    listLines: [{ from: 10, contentFrom: 12, kind: 'task' }],
  });
  assert.deepStrictEqual(S.snapRange(viewOf(20), { anchor: 10, head: 10 }, opts), { anchor: 12, head: 12 });
});

test('snapRange 对非法选区原样返回，无隐藏时也不动', () => {
  assert.deepStrictEqual(S.snapRange(viewOf(10), { anchor: 1.5, head: 2 }, null), { anchor: 1.5, head: 2 });
  assert.deepStrictEqual(S.snapRange(viewOf(10), { anchor: 2, head: 5 }, planOf(null)), { anchor: 2, head: 5 });
});

test('listContentStart 只对列表行行首生效，plain 与空正文不算', () => {
  const plan = {
    listLines: [
      { from: 0, contentFrom: 2, kind: 'bullet' },
      { from: 10, contentFrom: 12, kind: 'plain' },
      { from: 20, contentFrom: 20, kind: 'ordered' },
      { from: 30, contentFrom: 33, kind: 'task' },
      { from: 40, kind: 'bullet' },
    ],
  };
  assert.strictEqual(S.listContentStart(plan, 0), 2);
  assert.strictEqual(S.listContentStart(plan, 10), -1);
  assert.strictEqual(S.listContentStart(plan, 20), -1);
  assert.strictEqual(S.listContentStart(plan, 30), 33);
  assert.strictEqual(S.listContentStart(plan, 40), -1);
  assert.strictEqual(S.listContentStart(null, 0), -1);
  assert.strictEqual(S.listContentStart({ listLines: [] }, 0), -1);
});

// 源自 docs/bugs/0085（行末光标被格子的水平裁剪切掉）
// 同轴向：夹取只对光标、只在盒子有效宽读得到时生效。
test('caretClamp 只在盒子裁切时把光标往左夹，读数无效则不动', () => {
  assert.strictEqual(S.caretClamp(100, 80, 2), 78);
  assert.strictEqual(S.caretClamp(50, 80, 2), 50);
  assert.strictEqual(S.caretClamp(78, 80, 2), 78);
  assert.strictEqual(S.caretClamp(100, 0, 2), 100);
  assert.strictEqual(S.caretClamp(100, 80, 0), 100);
  assert.strictEqual(S.caretClamp(100, 80, -1), 100);
  assert.strictEqual(S.caretClamp(100, -5, 2), 100);
  assert.strictEqual(S.caretClamp(NaN, 80, 2), NaN);
  assert.strictEqual(S.caretClamp(100, Infinity, 2), 100);
});

// 源自 docs/bugs/0014（实时编辑的删除键不生效）
// 同轴向：选区删除只删可见字节；部分覆盖的隐藏标记留在原地。
test('deleteRange 对选区只删可见字节，部分覆盖的隐藏标记留在原地', () => {
  const d = doc('abcdefghij');
  const hidden = [{ from: 5, to: 8 }];
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 6, head: 7 }, { hidden: hidden }), { from: 8, to: 8 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 3, head: 7 }, { hidden: hidden }), { from: 3, to: 5 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 6, head: 9 }, { hidden: hidden }), { from: 8, to: 9 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 3, head: 9 }, { hidden: hidden }), { from: 3, to: 9 });
});

test('deleteRange 的选区完整覆盖隐藏区间时连标记一起删', () => {
  const d = doc('ab**cd**ef');
  const hidden = [{ from: 2, to: 4 }, { from: 6, to: 8 }];
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 2, head: 4 }, { hidden: hidden }), { from: 2, to: 4 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 1, head: 9 }, { hidden: hidden }), { from: 1, to: 9 });
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

// 源自 docs/bugs/0087（代码块首行退格把可见代码并进零高围栏行）
// 同轴向：只剩整行标记时删标记本体，不吞相邻换行。
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

test('deleteRange 整行标记只在标记顶到行首 / 行末时成立', () => {
  const d = doc('a **b**');
  const hidden = [{ from: 2, to: 4 }, { from: 5, to: 7 }];
  // `**` 不在行首：反向退格跨过闭合标记后删 `b`，不把整行当标记。
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 5, head: 5 }, { hidden: hidden }), { from: 4, to: 5 });
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

test('deleteRange 按行删在末行行尾不越过文档长度', () => {
  const d = doc('ab\ncd');
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 5, head: 5 }, { byLine: true, forward: true }), { from: 5, to: 5 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 3, head: 3 }, { byLine: true }), { from: 2, to: 3 });
});

test('deleteRange 对全中文 / 全角文本按码元删除一个字符', () => {
  const d = doc('中文，');
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 3, head: 3 }, {}), { from: 2, to: 3 });
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 1, head: 1 }, { forward: true }), { from: 1, to: 2 });
});

test('deleteRange 对跨行选区原样删除换行', () => {
  const d = doc('ab\ncd');
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 1, head: 4 }, {}), { from: 1, to: 4 });
});

test('deleteRange 对落在隐藏区间内部（本不该有）的光标先吸附再删', () => {
  const d = doc('abcdef');
  const hidden = [{ from: 2, to: 4 }];
  assert.deepStrictEqual(S.deleteRange(d, { anchor: 3, head: 3 }, { hidden: hidden }), { from: 1, to: 2 });
});

// 源自 docs/bugs/0105（行首回车劈开强调标记）
// 同轴向：只有"从行首开始、且后面还有可见内容"的标记链才把插入点退到链首。
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
  assert.strictEqual(S.lineStartInsertPoint([{ from: 0, to: 3 }], doc('## '), 3), -1);
  assert.strictEqual(S.lineStartInsertPoint([{ from: 0, to: 3 }], doc('##   '), 3), -1);
});

test('lineStartInsertPoint 对空隐藏集合 / 非法位置 / 缺文档一律 -1', () => {
  const d = doc('**x**');
  assert.strictEqual(S.lineStartInsertPoint([], d, 2), -1);
  assert.strictEqual(S.lineStartInsertPoint([{ from: 0, to: 2 }], d, 1.5), -1);
  assert.strictEqual(S.lineStartInsertPoint([{ from: 0, to: 2 }], null, 2), -1);
});

// 源自 docs/bugs/0030（上下箭头按逻辑行算导致一按就跳到块末尾）
// 同轴向：上下移动保留目标列，跨短行后还能回原列。
test('move 有选区时不按 Shift 就收到左 / 右端', () => {
  const d = doc('abcdef');
  assert.deepStrictEqual(S.move(d, { anchor: 4, head: 1 }, 'charLeft', {}), { anchor: 1, head: 1, goal: null });
  assert.deepStrictEqual(S.move(d, { anchor: 1, head: 4 }, 'charRight', {}), { anchor: 4, head: 4, goal: null });
});

test('move 按 Shift 只动 head，anchor 留着', () => {
  const d = doc('abcdef');
  assert.deepStrictEqual(S.move(d, { anchor: 2, head: 2 }, 'charRight', { extend: true }), { anchor: 2, head: 3, goal: null });
  assert.deepStrictEqual(S.move(d, { anchor: 2, head: 3 }, 'charLeft', { extend: true }), { anchor: 2, head: 2, goal: null });
  assert.deepStrictEqual(S.move(d, { anchor: 3, head: 5 }, 'docStart', { extend: true }), { anchor: 3, head: 0, goal: null });
});

test('move 的 Home / End 两段式：已在行首行尾再按才换行', () => {
  const t = 'ab\ncd';
  assert.strictEqual(at(t, 4, 'lineStart').head, 3);
  assert.strictEqual(at(t, 3, 'lineStart').head, 0);
  assert.strictEqual(at(t, 0, 'lineStart').head, 0);
  assert.strictEqual(at(t, 0, 'lineEnd').head, 2);
  assert.strictEqual(at(t, 2, 'lineEnd').head, 5);
  assert.strictEqual(at(t, 5, 'lineEnd').head, 5);
});

test('move 的文档首尾与未知命令', () => {
  assert.strictEqual(at('ab\ncd', 3, 'docStart').head, 0);
  assert.strictEqual(at('ab\ncd', 0, 'docEnd').head, 5);
  assert.strictEqual(at('ab\ncd', 0, '不存在的命令'), null);
  assert.strictEqual(at('ab\ncd', 0, ''), null);
});

test('move 按词移动与 wordStop 同口径（含中文逐字）', () => {
  assert.strictEqual(at('one two', 0, 'wordRight').head, 3);
  assert.strictEqual(at('one two', 7, 'wordLeft').head, 4);
  assert.strictEqual(at('中文', 0, 'wordRight').head, 1);
  assert.strictEqual(at('中文', 2, 'wordLeft').head, 1);
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

test('move 上下越过文档边界时停在首 / 尾，goal 仍记原列', () => {
  const d = doc('ab\ncd');
  assert.deepStrictEqual(S.move(d, { anchor: 0, head: 0 }, 'lineUp', {}), { anchor: 0, head: 0, goal: 0 });
  assert.deepStrictEqual(S.move(d, { anchor: 5, head: 5 }, 'lineDown', {}), { anchor: 5, head: 5, goal: 2 });
});

test('move 在标题 / 列表这类同块多逻辑行上逐行移动，不按视觉行乱跳', () => {
  const d = doc('# 标题\n正文\n- 项');
  const r = S.move(d, { anchor: 5, head: 5 }, 'lineDown', {});
  assert.strictEqual(r.head, 8);
  const r2 = S.move(d, { anchor: 8, head: 8 }, 'lineDown', {});
  assert.strictEqual(r2.head, 11);
});

test('move 翻页默认十行，边界处夹到首 / 尾，自定义 pageLines 生效', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += (i ? '\n' : '') + 'x';
  const d = doc(text);
  assert.strictEqual(S.move(d, { anchor: 0, head: 0 }, 'pageDown', {}).head, 20);
  assert.strictEqual(S.move(d, { anchor: 20, head: 20 }, 'pageUp', {}).head, 0);
  assert.strictEqual(S.move(d, { anchor: 0, head: 0 }, 'pageDown', { pageLines: 2 }).head, 4);
  // 0 被 `|| 10` 折成默认十行；负数会夹成一行。
  assert.strictEqual(S.move(d, { anchor: 0, head: 0 }, 'pageDown', { pageLines: 0 }).head, 20);
  assert.strictEqual(S.move(d, { anchor: 0, head: 0 }, 'pageDown', { pageLines: -3 }).head, 2);
});

// 源自 docs/bugs/0043（跨软换行的高亮只画一条竖条）
// 同轴向：优先用浏览器自己的矩形；兜底只画两端同视觉行的那一半。
test('rectsFor 优先用 textRects，过滤零面积与空项', () => {
  const geo = {
    textRects: function () {
      return [
        { left: 10, top: 20, w: 30, h: 16 },
        { left: 40, top: 46, w: 50, h: 16 },
        { left: 0, top: 0, w: 0, h: 16 },
        { left: 0, top: 0, w: 10, h: 0 },
        null,
      ];
    },
  };
  assert.deepStrictEqual(S.rectsFor({ from: 0, to: 30 }, geo), [
    { left: 10, top: 20, w: 30, h: 16 },
    { left: 40, top: 46, w: 50, h: 16 },
  ]);
});

test('rectsFor 的 textRects 抛错或全零面积时退回端点几何', () => {
  const geo = {
    textRects: function () { throw new Error('坏'); },
    coordsAtPos: function (pos) {
      return { left: pos * 10, top: 5, bottom: 21 };
    },
    lineAt: function () { return { from: 0, to: 2 }; },
  };
  assert.deepStrictEqual(S.rectsFor({ from: 0, to: 2 }, geo), [
    { left: 0, top: 5, w: 20, h: 16 },
  ]);
});

test('rectsFor 兜底在两端跨视觉行时不画，宁可少画也不谎报宽度', () => {
  const geo = {
    coordsAtPos: function (pos) {
      return { left: pos * 10, top: pos === 0 ? 5 : 25, bottom: 41 };
    },
    lineAt: function () { return { from: 0, to: 2 }; },
  };
  assert.deepStrictEqual(S.rectsFor({ from: 0, to: 2 }, geo), []);
});

test('rectsFor 对缺几何 / 折叠区间返回空数组', () => {
  assert.deepStrictEqual(S.rectsFor({ from: 0, to: 2 }, null), []);
  assert.deepStrictEqual(S.rectsFor({ from: 1, to: 1 }, {
    coordsAtPos: function () { return null; },
    lineAt: function () { return { from: 0, to: 2 }; },
  }), []);
});

// 源自 docs/bugs/0069（表格格子里点行尾不出光标）
// 同轴向：点在文字右边就吸到该行行末，只在这一行内。
test('snapLineEnd 在点越过内容框右边界时吸到行末', () => {
  const view = {
    state: { doc: doc('abc') },
    contentDOM: { getBoundingClientRect: function () { return { right: 100 }; } },
  };
  assert.strictEqual(S.snapLineEnd(view, 1, 101), 3);
  assert.strictEqual(S.snapLineEnd(view, 1, 100.4), 1);
  assert.strictEqual(S.snapLineEnd(view, 1, 100.6), 3);
  assert.strictEqual(S.snapLineEnd(view, 1, 90), 1);
});

test('snapLineEnd 对非整数位置、非法 x、缺 contentDOM 一律原样返回', () => {
  const view = {
    state: { doc: doc('abc') },
    contentDOM: { getBoundingClientRect: function () { return { right: 100 }; } },
  };
  assert.strictEqual(S.snapLineEnd(view, 1.5, 200), 1.5);
  assert.strictEqual(S.snapLineEnd(view, 1, NaN), 1);
  assert.strictEqual(S.snapLineEnd({ state: { doc: doc('abc') } }, 1, 200), 1);
});

// 源自 docs/bugs/0084（阅读态点格内行尾光标少算隐藏标记）
// 同轴向：行尾一串零宽标记在屏幕上同点，光标必须吸到行末。
test('snapHiddenTail 把从位置到行末全同点的零宽尾巴吸到行末', () => {
  const line = { from: 0, to: 4, text: 'abc`' };
  const coords = { 1: { left: 30, top: 5 }, 2: { left: 30, top: 5 }, 3: { left: 30, top: 5 }, 4: { left: 30, top: 5 } };
  const view = {
    state: { doc: { lineAt: function () { return line; }, length: 4 } },
    coordsAtPos: function (p) { return coords[p]; },
  };
  assert.strictEqual(S.snapHiddenTail(view, 1), 4);
});

test('snapHiddenTail 在折行 / 坐标读不到时原样返回，不把光标推到别处', () => {
  const line = { from: 0, to: 4, text: 'abcd' };
  const view = {
    state: { doc: { lineAt: function () { return line; }, length: 4 } },
    coordsAtPos: function (p) {
      return p <= 2 ? { left: 10, top: 5 } : { left: 10, top: 30 };
    },
  };
  assert.strictEqual(S.snapHiddenTail(view, 1), 1);
  const empty = {
    state: { doc: { lineAt: function () { return line; }, length: 4 } },
    coordsAtPos: function () { return null; },
  };
  assert.strictEqual(S.snapHiddenTail(empty, 1), 1);
  assert.strictEqual(S.snapHiddenTail(view, 4), 4);
  assert.strictEqual(S.snapHiddenTail(view, 1.5), 1.5);
});

test('snapHiddenTail 对行尾中间位置只吸到最末，不会跳行', () => {
  const line = { from: 0, to: 5, text: 'ab``c' };
  const view = {
    state: { doc: { lineAt: function () { return line; }, length: 5 } },
    coordsAtPos: function (p) {
      return p >= 2 && p <= 4 ? { left: 20, top: 5 } : { left: p * 10, top: 5 };
    },
  };
  // 尾巴必须一直同点延到**行末**才吸收；中途就变了 ⇒ 原样返回。
  assert.strictEqual(S.snapHiddenTail(view, 2), 2);
  assert.strictEqual(S.snapHiddenTail(view, 1), 1);
});

// 源自 docs/bugs/0084（同上第三面：posAtCoords 换算少算列）
// 同轴向：用真实字形坐标把落点扳到最近的边界，跨视觉行立刻停。
test('snapClickX 从换算落点向更近的相邻边界移动，得到点击的真实列', () => {
  const line = { from: 0, to: 6, text: 'abcdef' };
  const view = {
    state: { doc: { lineAt: function () { return line; }, length: 6 } },
    coordsAtPos: function (p) { return { left: p * 10, top: 0 }; },
  };
  assert.strictEqual(S.snapClickX(view, 2, 47), 5);
  assert.strictEqual(S.snapClickX(view, 2, 26), 3);
  assert.strictEqual(S.snapClickX(view, 4, 1), 0);
});

test('snapClickX 在零宽标记处不来回走，跨视觉行立即停', () => {
  const line = { from: 0, to: 3, text: 'a**' };
  const zero = {
    state: { doc: { lineAt: function () { return line; }, length: 3 } },
    coordsAtPos: function (p) { return { left: p <= 1 ? 10 : 40, top: 0 }; },
  };
  assert.strictEqual(S.snapClickX(zero, 1, 10), 1);
  const fold = {
    state: { doc: { lineAt: function () { return line; }, length: 3 } },
    coordsAtPos: function (p) { return { left: p * 10, top: p === 2 ? 30 : 0 }; },
  };
  assert.strictEqual(S.snapClickX(fold, 1, 19), 1);
});

test('snapClickX 对非整数位置 / 非法 x / 坐标缺失原样返回', () => {
  const view = {
    state: { doc: { lineAt: function () { return { from: 0, to: 3 }; }, length: 3 } },
    coordsAtPos: function (p) { return p === 1 ? null : { left: p * 10, top: 0 }; },
  };
  assert.strictEqual(S.snapClickX(view, 1.5, 20), 1.5);
  assert.strictEqual(S.snapClickX(view, 1, NaN), 1);
  assert.strictEqual(S.snapClickX(view, 1, 20), 1);
});

// 源自 docs/bugs/0086（隐藏区间映射方向反了导致边界打字倒序）
// 同轴向：中央事务兜底必须按变更把隐藏区间与列表行首表映射到新坐标。
function fakeCM6() {
  return {
    EditorState: {
      transactionFilter: {
        of: function (fn) {
          return { kind: 'filter', fn: fn };
        },
      },
    },
    EditorSelection: {
      create: function (ranges, mainIndex) {
        return { ranges: ranges, mainIndex: mainIndex };
      },
      range: function (anchor, head) {
        return { anchor: anchor, head: head };
      },
    },
  };
}

function trOf(partial) {
  const tr = {
    docChanged: false,
    changes: null,
    newSelection: { mainIndex: 0, ranges: [{ anchor: 0, head: 0 }] },
    newDoc: { length: 10 },
    effects: [],
    annotations: [],
    scrollIntoView: false,
    isUserEvent: function () { return false; },
    startState: {
      update: function (spec) {
        return { updated: spec };
      },
    },
  };
  return Object.assign(tr, partial);
}

test('legalFilter 在缺 CM6 / 缺 transactionFilter 时返回空数组（可见降级）', () => {
  assert.deepStrictEqual(S.legalFilter(null, {}), []);
  assert.deepStrictEqual(S.legalFilter({}, {}), []);
  assert.deepStrictEqual(S.legalFilter({ EditorState: {} }, {}), []);
});

test('legalFilter 在 select.all 时直接放行，全选必须覆盖整块源码', () => {
  const CM6 = fakeCM6();
  const exts = S.legalFilter(CM6, planOf({ fenceLines: [{ from: 0, to: 9 }] }));
  const tr = trOf({
    newSelection: { mainIndex: 0, ranges: [{ anchor: 5, head: 5 }] },
    isUserEvent: function (name) { return name === 'select.all'; },
  });
  assert.strictEqual(exts[0].fn(tr), tr);
});

test('legalFilter 在无 plan / 无隐藏区间时原样放行', () => {
  const CM6 = fakeCM6();
  const a = S.legalFilter(CM6, planOf(null))[0].fn;
  const tr = trOf({ newSelection: { mainIndex: 0, ranges: [{ anchor: 3, head: 3 }] } });
  assert.strictEqual(a(tr), tr);
  const b = S.legalFilter(CM6, planOf({ ranges: [] }))[0].fn;
  assert.strictEqual(b(tr), tr);
});

test('legalFilter 把落在隐藏区间里的折叠光标吸到最近的合法端点', () => {
  const CM6 = fakeCM6();
  const filter = S.legalFilter(CM6, planOf({ ranges: [{ from: 5, to: 8 }] }))[0].fn;
  const tr = trOf({ newSelection: { mainIndex: 0, ranges: [{ anchor: 6, head: 6 }] } });
  const out = filter(tr);
  assert.strictEqual(out.updated.selection.ranges[0].anchor, 5);
  assert.strictEqual(out.updated.selection.ranges[0].head, 5);
});

test('legalFilter 对非折叠选区的两端按方向外扩，并保留 anchor/head 方向', () => {
  const CM6 = fakeCM6();
  const filter = S.legalFilter(CM6, planOf({ ranges: [{ from: 5, to: 8 }] }))[0].fn;
  const fwd = filter(trOf({ newSelection: { mainIndex: 0, ranges: [{ anchor: 6, head: 7 }] } }));
  assert.deepStrictEqual(fwd.updated.selection.ranges[0], { anchor: 5, head: 8 });
  const rev = filter(trOf({ newSelection: { mainIndex: 0, ranges: [{ anchor: 7, head: 6 }] } }));
  assert.deepStrictEqual(rev.updated.selection.ranges[0], { anchor: 8, head: 5 });
});

test('legalFilter 把列表行行首吸到正文起点，避免把标记写坏', () => {
  const CM6 = fakeCM6();
  const filter = S.legalFilter(CM6, planOf({
    ranges: [{ from: 0, to: 2 }],
    listLines: [{ from: 4, contentFrom: 6, kind: 'bullet' }],
  }))[0].fn;
  const out = filter(trOf({ newSelection: { mainIndex: 0, ranges: [{ anchor: 4, head: 4 }] } }));
  assert.strictEqual(out.updated.selection.ranges[0].head, 6);
});

test('legalFilter 的变更映射把隐藏区间整体右移，不把新插入的可见字符吞进去', () => {
  const CM6 = fakeCM6();
  const filter = S.legalFilter(CM6, planOf({ ranges: [{ from: 5, to: 8 }] }))[0].fn;
  // 在第 8 位（隐藏区间右端）插入 1 个字符：assoc=-1 时右端留在 8，新字符在区间外。
  const changes = {
    length: 10,
    mapPos: function (pos, assoc) {
      if (pos < 8) return pos;
      if (pos > 8) return pos + 1;
      return assoc < 0 ? 8 : 9;
    },
  };
  const tr = trOf({
    docChanged: true,
    changes: changes,
    newDoc: { length: 11 },
    newSelection: { mainIndex: 0, ranges: [{ anchor: 8, head: 8 }] },
  });
  assert.strictEqual(filter(tr), tr, '边界上的光标应当原样放行');
});

test('legalFilter 的列表行首表随变更映射：新插入的行首不会被旧坐标吸走', () => {
  const CM6 = fakeCM6();
  const filter = S.legalFilter(CM6, planOf({
    ranges: [{ from: 0, to: 2 }],
    listLines: [{ from: 0, contentFrom: 2, kind: 'bullet' }],
  }))[0].fn;
  // 在第 0 位插一个换行：旧列表行整体下移 1，新行首 0 不是列表行。
  const changes = {
    length: 10,
    mapPos: function (pos, assoc) {
      if (pos > 0) return pos + 1;
      return assoc > 0 ? 1 : 0;
    },
  };
  const tr = trOf({
    docChanged: true,
    changes: changes,
    newDoc: { length: 11 },
    newSelection: { mainIndex: 0, ranges: [{ anchor: 0, head: 0 }] },
  });
  assert.strictEqual(filter(tr), tr, '新行首 0 不应按旧列表行吸到 2');
});

test('legalFilter 对多光标逐个吸附，未变化的选区不触发二次 update', () => {
  const CM6 = fakeCM6();
  const filter = S.legalFilter(CM6, planOf({ ranges: [{ from: 5, to: 8 }] }))[0].fn;
  const out = filter(trOf({
    newSelection: {
      mainIndex: 1,
      ranges: [{ anchor: 0, head: 0 }, { anchor: 6, head: 6 }],
    },
  }));
  assert.deepStrictEqual(out.updated.selection.ranges, [
    { anchor: 0, head: 0 },
    { anchor: 5, head: 5 },
  ]);
  assert.strictEqual(out.updated.selection.mainIndex, 1);
});

test('legalFilter 的吸附结果幂等：已合法的事务不再改写', () => {
  const CM6 = fakeCM6();
  const filter = S.legalFilter(CM6, planOf({ ranges: [{ from: 5, to: 8 }] }))[0].fn;
  const tr = trOf({ newSelection: { mainIndex: 0, ranges: [{ anchor: 0, head: 0 }] } });
  assert.strictEqual(filter(tr), tr);
});
