// 按 `--experimental-test-coverage` 实测出来的**未覆盖分支**补测（第三轮）。
//
// 与同目录那几份矩阵不重复：矩阵按"用户动作 × 字符类"铺面，这一份专打三个点
//  ① `selection.js` 的字素窗口**翻倍**（`bugs/0046` 家族：`⇧→`/`⌦` 选中半个 Emoji）；
//  ② `selection.js::rectsFor` 的**跨行回落**（`textRects` 不可用时逐行量）；
//  ③ `cell.js::judge` 的**陈旧坐标**分支、`a11y.js::describe` 的**全文行号**、
//     `model.js` 撤销/重做的**失败回滚**（`bugs/0020` 家族）。
//
// ⚠️ 这里全是纯逻辑，不碰 DOM、不建编辑器视图、不合成按键。
//    几何的真实观感、真 IME、读屏实际朗读仍要各自那一层，⛔ 不拿这份 Node 测试冒充。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const S = require('../../src/live/selection.js');
const C = require('../../src/live/cell.js');
const A = require('../../src/live/a11y.js');
const M = require('../../src/live/model.js');

/**
 * CM6 `Text` 的最小替身（口径与 `live-selection.test.js` 一致：
 * `lineAt(pos).to` 是行尾**之前**，`sliceString` 与 `length` 同为 UTF-16 码元）。
 */
function doc(text) {
  const src = String(text);
  const lines = src.split('\n');
  const starts = [];
  let p = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(p);
    p += lines[i].length + 1;
  }
  return {
    length: src.length,
    lines: lines.length,
    lineAt: function (pos) {
      const at = Math.max(0, Math.min(pos, src.length));
      let i = lines.length - 1;
      for (let k = 0; k < lines.length; k++) {
        if (at <= starts[k] + lines[k].length) { i = k; break; }
      }
      return { number: i + 1, from: starts[i], to: starts[i] + lines[i].length, text: lines[i] };
    },
    sliceString: function (from, to) {
      return src.slice(Math.max(0, from), Math.max(0, to));
    },
  };
}

/**
 * 一个**超过字素窗口**（32 码元）的单簇：12 个 👨 用 ZWJ 串起来 ＝ 35 码元。
 * ⚠️ 这不是造出来的怪东西——带肤色的多人家庭 emoji 真能到这个长度，
 *    短窗口会切在簇中间，于是"退格一次退半个"。
 */
const LONG_CLUSTER = Array.from({ length: 12 }, function () { return '👨'; }).join('‍');
const LONG = LONG_CLUSTER.length; // 35

test('字素窗口：超过 32 码元的单簇，退格一次要跨过**整簇**', function () {
  assert.equal(LONG, 35, '夹具本身先钉住：必须真的长过窗口');
  const d = doc('xxxxx' + LONG_CLUSTER);
  assert.equal(S.graphemeBack(d, d.length), 5,
    '窗口不够时必须翻倍再切，⛔ 返回簇中间的偏移（那会让 ⌫ 只退掉半个字符）');
});

test('字素窗口：超过 32 码元的单簇，向前一次同样跨过整簇', function () {
  const d = doc(LONG_CLUSTER + '尾巴');
  assert.equal(S.graphemeForward(d, 0), LONG,
    '第一个字素吃满窗口且右边还有内容 ⇒ 必须翻倍，⛔ 把 32 当成整簇长度');
});

test('字素窗口：按键走的是同一判据（charLeft / charRight 与 ⇧ 扩展）', function () {
  const d1 = doc('xxxxx' + LONG_CLUSTER);
  assert.deepEqual(S.move(d1, { anchor: d1.length, head: d1.length }, 'charLeft', {}),
    { anchor: 5, head: 5, goal: null });
  const d2 = doc(LONG_CLUSTER + '尾巴');
  assert.deepEqual(S.move(d2, { anchor: 0, head: 0 }, 'charRight', {}),
    { anchor: LONG, head: LONG, goal: null });
  // ⇧←：锚点不动、头挪一整簇 ⇒ 选中的是一整簇，⛔ 半个代理项。
  const sel = S.move(d1, { anchor: d1.length, head: d1.length }, 'charLeft', { extend: true });
  assert.deepEqual([sel.anchor, sel.head], [d1.length, 5]);
  assert.equal(d1.sliceString(sel.head, sel.anchor), LONG_CLUSTER, '选中的必须正好是这一簇');
});

test('负对照：窗口以内的簇照旧只走一簇，两端不越界', function () {
  const short = doc('a😀');
  assert.equal(S.graphemeBack(short, short.length), 1, '😀 是 2 码元 ⇒ 起点回到 1');
  const pair = doc('😀b');
  assert.equal(S.graphemeForward(pair, 0), 2);
  const two = doc('😀😀');
  assert.equal(S.graphemeBack(two, two.length), 2, '两个独立 emoji 只退右边那个');
  assert.equal(S.graphemeForward(two, 0), 2, '只进左边那个');
  // 文首/文末：整簇就是全文时，两端都要停在边界上。
  const only = doc(LONG_CLUSTER);
  assert.equal(S.graphemeBack(only, only.length), 0);
  assert.equal(S.graphemeForward(only, 0), only.length);
});

// ── 选区几何：`rectsFor` 的跨行回落 ────────────────────────────────────────
// 正常路径走 `geo.textRects`（真视图里由 DOM Range 给出）；下面这条回落是
// "取不到视觉矩形时逐行量"的兜底。⚠️ 兜底的形态是**少画**（⛔ 不画错宽度）。

/** 两行文档的假几何：`coord(pos)` 决定这一点的 top。 */
function geoOf(coord, extra) {
  const base = {
    lineAt: function (pos) { return pos <= 3 ? { from: 0, to: 3, text: 'abc' } : { from: 4, to: 7, text: 'def' }; },
    coordsAtPos: function (pos) { const top = coord(pos); return { left: pos * 7, top: top, bottom: top + 16 }; },
  };
  return Object.assign(base, extra || {});
}

test('几何回落：跨两行的选区按行各出一个矩形，换行那一格不画', function () {
  const got = S.rectsFor({ from: 1, to: 6 }, geoOf(function (pos) { return pos <= 3 ? 0 : 20; }));
  // ⚠️ 逐行量：第一行 [1,3)、第二行 [4,6)，换行位置 3 本身不是可画区间。
  assert.deepEqual(got, [
    { left: 7, top: 0, w: 14, h: 16 },
    { left: 28, top: 20, w: 14, h: 16 },
  ]);
  assert.equal(got.length, 2, '⛔ 把整段当成一个矩形（那会横跨换行画出一条假线）');
});

test('几何回落：两端不在同一视觉行（折行）⇒ 这一行不画，⛔ 用错高度冒充', function () {
  // pos 1 在第 1 视觉行、pos 3 已折到下一行（top 不同）⇒ 跳过，只留第二行那段。
  const got = S.rectsFor({ from: 1, to: 6 }, geoOf(function (pos) {
    if (pos <= 2) return 0;
    if (pos === 3) return 5;
    return 20;
  }));
  assert.deepEqual(got, [{ left: 28, top: 20, w: 14, h: 16 }]);
});

test('几何回落：textRects 抛错时退回逐行测量（⛔ 返回空 = 选区看不见）', function () {
  const got = S.rectsFor({ from: 1, to: 6 }, geoOf(function () { return 0; }, {
    textRects: function () { throw Error('domAtPos 不可用'); },
  }));
  assert.equal(got.length, 2);
});

test('几何回落：textRects 只给出零面积矩形 ⇒ 同样退回逐行', function () {
  const got = S.rectsFor({ from: 1, to: 6 }, geoOf(function (pos) { return pos <= 3 ? 0 : 20; }, {
    textRects: function () { return [{ left: 0, top: 0, w: 0, h: 16 }, { left: 3, top: 0, w: 9, h: 0 }]; },
  }));
  assert.deepEqual(got, [
    { left: 7, top: 0, w: 14, h: 16 },
    { left: 28, top: 20, w: 14, h: 16 },
  ], '零面积的折点/行尾矩形画出来是看不见却占位的线');
});

test('几何回落：textRects 有效时直接采用，并逐项过滤零宽零高', function () {
  const got = S.rectsFor({ from: 0, to: 9 }, {
    textRects: function () {
      return [{ left: 1, top: 2, w: 3, h: 4 }, { left: 5, top: 2, w: 0, h: 4 }, { left: 9, top: 2, w: 6, h: 7 }];
    },
  });
  assert.deepEqual(got, [{ left: 1, top: 2, w: 3, h: 4 }, { left: 9, top: 2, w: 6, h: 7 }]);
});

test('负对照：适配器连 coordsAtPos 都没有 ⇒ 返回空数组，⛔ 猜坐标', function () {
  assert.deepEqual(S.rectsFor({ from: 0, to: 6 }, {}), []);
  assert.deepEqual(S.rectsFor({ from: 0, to: 6 }, null), []);
  assert.deepEqual(S.rectsFor({ from: 0, to: 6 }, { lineAt: geoOf(function () { return 0; }).lineAt }), []);
});

// ── 单元格表示：陈旧坐标 ────────────────────────────────────────────────
// ⚠️ 这一支与"没改动"是**两回事**：区间对不上 = 没写进去的失败，
//    必须报 rejected 让用户看见，⛔ 静默当成"什么都没发生"。

test('表示绑定：列区间越界 + 编辑文本变了 ⇒ rejected（⛔ 当成 unchanged）', function () {
  const binding = C.bind({ raw: 'old', from: 2, to: 99 });
  const out = C.judge(binding, '| old |', 'new');
  assert.equal(out.status, 'rejected');
  assert.equal(out.why, 'range', '与"原始绑定缺失"同一个出口：区间不可信');
});

test('表示绑定：列坐标不是整数 + 编辑文本变了 ⇒ rejected', function () {
  const binding = C.bind({ raw: 'old', from: 1.5, to: 4 });
  const out = C.judge(binding, '| old |', 'new');
  assert.equal(out.status, 'rejected');
  assert.equal(out.why, 'range');
});

test('表示绑定：越界拒绝之后，坐标修好仍可继续写入（⛔ 一次失败就锁死）', function () {
  const binding = C.bind({ raw: 'old', from: 2, to: 5 });
  assert.equal(C.judge(binding, '| old |', 'new').status, 'valid');
  const stale = C.bind({ raw: 'old', from: 2, to: 99 });
  assert.equal(C.judge(stale, '| old |', 'new').status, 'rejected');
  assert.equal(C.judge(binding, '| old |', 'newer').status, 'valid');
});

test('负对照：区间合法且视图没改 ⇒ unchanged，⛔ 趁机把原文重新编码一遍', function () {
  const binding = C.bind({ raw: 'a<br />b', from: 2, to: 10 });
  const before = structuredClone(binding);
  const out = C.judge(binding, '|a<br />b|', binding.initialView);
  assert.equal(out.status, 'unchanged');
  assert.deepEqual(binding, before);
  assert.equal(out.encoded, undefined, '无改动不带编码结果（调用方据此零字节写回）');
});

// ── 无障碍描述：全文行号与截断 ────────────────────────────────────────────
// ⚠️ 用户看不见块边界；报"块内第 2 行"会把人送错地方。

test('朗读：块内第 2 行 + lineOffset ⇒ 报全文行号', function () {
  const d = doc('第一行\n第二行abc\n第三行');
  const out = A.describe(d, { anchor: 4, head: 4 }, { lineOffset: 40 });
  assert.equal(out.line, 42, '40 + 块内第 2 行 = 全文第 42 行');
  assert.equal(out.col, 1);
  assert.equal(out.chars, 0);
});

test('朗读：跨行选区报字符数与整段文本（含换行）', function () {
  const d = doc('ab😀cd\n第二行');
  const seen = [];
  const t = function (k, o) { seen.push(o); return k; };
  const out = A.describe(d, { anchor: 0, head: 6 }, { t: t, lineOffset: 0 });
  assert.equal(out.chars, 6, '字符数按 UTF-16 码元算，与选区口径一致');
  assert.equal(seen[1].text, 'ab😀cd', '跨行那一段按原文取，⛔ 只取第一行');
  assert.equal(out.value, 'live.a11y-selection');
});

test('朗读：maxText 截断不拆代理对', function () {
  const d = doc('ab😀cd');
  const seen = [];
  A.describe(d, { anchor: 0, head: 6 }, {
    maxText: 3,
    t: function (k, o) { seen.push(o); return k; },
  });
  assert.equal(seen[1].text, 'ab', '切在 ' + String.fromCharCode(0xd83d) + ' 中间要退一格，⛔ 留半个代理项');
});

test('负对照：不传 opts 也给出可读值（⛔ 要求调用方必传 t/lineOffset）', function () {
  const d = doc('第一行\n第二行abc');
  const out = A.describe(d, { anchor: 5, head: 5 });
  assert.deepEqual([out.label, out.value, out.line, out.col, out.chars],
    ['live.a11y-label', 'live.a11y-value', 2, 2, 0]);
  const nullSel = A.describe(d, null, {});
  assert.deepEqual([nullSel.line, nullSel.col, nullSel.chars], [1, 1, 0], '空选区退到文首，⛔ 抛错');
});

// ── 撤销/重做的失败回滚（`bugs/0020`）──────────────────────────────────────
// ⚠️ 撤销/重做也要过渲染与身份复核；预览失败时**必须**能整份回退，
//    ⛔ 只在栈上做反向操作（那会把 `commitSeq` 再推一次，现场就不是原样了）。

test('0020：撤销发布失败回滚 ⇒ 全文、身份与两侧栈都回到撤销前', function () {
  const s = M.createSession({ text: 'A\nB\n', docSeq: 1 });
  s.commit({ from: 0, to: 1 }, ['X']);
  s.commit({ from: 1, to: 2 }, ['Y']);
  const text0 = s.fullText();
  const ident0 = { ...s.identity() };
  const size0 = s.stack().size();
  const redo0 = s.stack().redoSize();

  const u = s.undoEdit();
  assert.notEqual(s.fullText(), text0, '撤销先真的改了模型（调用方随后必须发布）');
  const r = u.revert({ txId: u.txId, revision: u.revision });
  assert.deepEqual(r, { ok: true, already: false, why: '' });
  assert.equal(s.fullText(), text0);
  assert.deepEqual(s.identity(), ident0, 'commitSeq ⛔ 被回滚再推一次');
  assert.equal(s.stack().size(), size0);
  assert.equal(s.stack().redoSize(), redo0);

  // 回滚之后必须还能对**同一条**做撤销，且结果与第一次一样。
  const again = s.undoEdit();
  assert.equal(again.fullText, 'X\nB\n');
});

test('0020：重做发布失败回滚 ⇒ 回到重做前，重做条目仍在', function () {
  const s = M.createSession({ text: 'A\nB\n', docSeq: 1 });
  s.commit({ from: 0, to: 1 }, ['X']);
  s.undoEdit();
  const text0 = s.fullText();
  const size0 = s.stack().size();
  const redo0 = s.stack().redoSize();

  const rd = s.redo();
  assert.equal(rd.fullText, 'X\nB\n');
  const r = rd.revert({ txId: rd.txId, revision: rd.revision });
  assert.equal(r.ok, true);
  assert.equal(s.fullText(), text0);
  assert.equal(s.stack().size(), size0);
  assert.equal(s.stack().redoSize(), redo0, '回滚后这条必须还在重做栈上');
  assert.equal(s.redo().fullText, 'X\nB\n');
});

test('0020：回滚之后又有新编辑 ⇒ 旧句柄拒绝覆盖（newer）', function () {
  const s = M.createSession({ text: 'A\n', docSeq: 1 });
  s.commit({ from: 0, to: 1 }, ['X']);
  const u = s.undoEdit();
  s.commit({ from: 0, to: 1 }, ['W']);
  const cur = s.fullText();
  const r = u.revert({ txId: u.txId, revision: u.revision });
  assert.equal(r.ok, false);
  assert.equal(r.why, 'newer', '期间有别的提交 ⇒ 回滚会把新状态退回旧值');
  assert.equal(s.fullText(), cur);
});

test('负对照：回滚句柄只认自己的 txId，且第二次调用报 already', function () {
  const s = M.createSession({ text: 'A\n', docSeq: 1 });
  s.commit({ from: 0, to: 1 }, ['X']);
  const u = s.undoEdit();
  const wrong = u.revert({ txId: u.txId + 1, revision: u.revision });
  assert.deepEqual([wrong.ok, wrong.why], [false, 'not-owner']);
  assert.equal(u.revert({ txId: u.txId, revision: u.revision }).ok, true);
  assert.deepEqual(u.revert({ txId: u.txId, revision: u.revision }), { ok: true, already: true, why: '' });
});

// ── 表格邻接：只认单元格元素；下一行短一格时⛔ 猜坐标 ─────────────────────

/** 造一张假表（与 `live-cell.test.js` 同形状：`rows[r].cells`）。 */
function fakeTable(counts) {
  const rows = [];
  let n = 0;
  for (let r = 0; r < counts.length; r++) {
    const cells = [];
    for (let c = 0; c < counts[r]; c++) {
      cells.push({ id: n++, nodeType: 1, tagName: c === 0 && r === 0 ? 'TH' : 'TD' });
    }
    rows.push({ cells: cells });
  }
  return { rows: rows };
}

test('表格邻接：只认元素节点的 TD/TH，⛔ 认文本节点或随便一个 div', function () {
  assert.equal(C.isCellNode({ nodeType: 1, tagName: 'td' }), true, '不区分大小写');
  assert.equal(C.isCellNode({ nodeType: 1, tagName: 'TH' }), true);
  assert.equal(C.isCellNode({ nodeType: 3, tagName: 'TD' }), false, '文本节点不算');
  assert.equal(C.isCellNode({ nodeType: 1, tagName: 'DIV' }), false);
  assert.equal(C.isCellNode(null), false);
  assert.equal(C.isCellNode(undefined), false);
});

test('表格邻接：下一行短一格 ⇒ -1，⛔ 猜一个越界下标', function () {
  const table = fakeTable([3, 2]);
  assert.equal(C.flatBelow(table, 1), 4, '同列存在的照常下移');
  assert.equal(C.flatBelow(table, 2), -1, '下一行没有第 3 格 ⇒ 退出，⛔ 夹到最后一格');
  assert.equal(C.flatBelow(table, -1), -1);
  assert.equal(C.flatBelow(table, 1.5), -1, '非整数下标同样是"没有下一格"');
  assert.equal(C.flatBelow(table, 99), -1, '下标落不到任何一行 ⇒ -1（⛔ 当成最后一行）');
});

// ── 内部撤销（`session.undo`）：弹一条提交并能整份回滚 ─────────────────────
// ⚠️ 这条**不是** `⌘Z`（那走 `undoEdit`，要留重做条目）；它是提交失败 / 丢空段落 /
//    退出编辑态时回收刚压进去的那一条。⛔ 两者走混 ⇒ `⇧⌘Z` 没有东西可重做。

test('内部撤销：弹掉最近一条提交，⛔ 产生重做条目', function () {
  const s = M.createSession({ text: 'A\nB\n', docSeq: 1 });
  assert.equal(s.undo(), null, '没有提交 ⇒ null（⛔ 发空事务）');
  s.commit({ from: 0, to: 1 }, ['X']);
  const text0 = s.fullText();
  const ident0 = { ...s.identity() };
  const u = s.undo();
  assert.equal(u.fullText, 'A\nB\n');
  assert.equal(s.stack().size(), 0);
  assert.equal(s.stack().redoSize(), 0, '内部撤销不留重做条目（与 undoEdit 的区别）');

  const r = u.revert({ txId: u.txId, revision: u.revision });
  assert.equal(r.ok, true);
  assert.equal(s.fullText(), text0);
  assert.deepEqual(s.identity(), ident0);
  assert.equal(s.stack().size(), 1, '回滚后那一条要回到提交栈');
});

// ── 通告节点（`a11y.attach`）：不碰真 DOM 也验得了那几条硬约束 ──────────────
// ⚠️ 真读屏会不会念，仍要那一层；这里只钉"该有的属性在、重复播报被压掉"。

/** 假 host ＋ 假元素（只实现 `attach` 用到的那几个面）。 */
function fakeHost() {
  const attrs = {};
  const children = [];
  const host = {
    attrs: attrs,
    children: children,
    setAttribute: function (k, v) { attrs[k] = String(v); },
    removeAttribute: function (k) { delete attrs[k]; },
    appendChild: function (el) { children.push(el); el.parentNode = host; },
    removeChild: function (el) {
      const i = children.indexOf(el);
      if (i >= 0) children.splice(i, 1);
      el.parentNode = null;
    },
  };
  return host;
}

function fakeEl(tag, log) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    parentNode: null,
    attrs: {},
    writes: [],
    setAttribute: function (k, v) { el.attrs[k] = String(v); },
  };
  Object.defineProperty(el, 'textContent', {
    get: function () { return el.writes.join(''); },
    set: function (v) { el.writes.push(String(v)); if (log) log.push(String(v)); },
  });
  return el;
}

test('通告节点：挂上 textbox 三件套，通告区先建好再写', function () {
  const host = fakeHost();
  const created = [];
  const a = A.attach(host, {
    createEl: function (tag) { const el = fakeEl(tag, created); return el; },
    lineOffset: 7,
  });
  assert.deepEqual(host.attrs, {
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': 'live.a11y-label',
  });
  assert.equal(host.children.length, 1, '通告区必须在 attach 时就插进去');
  assert.deepEqual(host.children[0].attrs, {
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });
  assert.equal(host.children[0].className, 'cm-rmd-liveAnnouncer');
  a.destroy();
  assert.deepEqual(host.attrs, {}, 'destroy 摘掉四个属性');
  assert.equal(host.children.length, 0);
});

test('通告节点：同一句连续两次只写一次（⛔ 淹没读屏）', function () {
  const host = fakeHost();
  const a = A.attach(host, { createEl: function (tag) { return fakeEl(tag); } });
  a.announce('已保存');
  a.announce('已保存');
  assert.deepEqual(host.children[0].writes, ['已保存'], '相同文案第二遍不得再写 textContent');
  a.announce('已拒绝');
  assert.deepEqual(host.children[0].writes, ['已保存', '已拒绝']);
  a.announce('');
  assert.equal(host.children[0].writes.length, 3, '空串是新的一句，照常播');
});

test('通告节点：sync 写 aria-valuetext，行号走全文口径', function () {
  const host = fakeHost();
  const a = A.attach(host, {
    createEl: function (tag) { return fakeEl(tag); },
    lineOffset: 40,
    t: function (k, o) {
      return o && o.line !== undefined ? k + ':' + o.line + ':' + o.col : k;
    },
  });
  const info = a.sync(doc('第一行\n第二行abc'), { anchor: 5, head: 5 });
  assert.equal(info.line, 42);
  assert.equal(host.attrs['aria-valuetext'], 'live.a11y-value:42:2');
  assert.equal(a.label(), 'live.a11y-label');
});

// ── 判据承重：字素窗口翻倍被打掉之后，上面的判据必须红 ────────────────────
function mutateModule(name, target, replacement) {
  const src = fs.readFileSync(require.resolve('../../src/live/' + name + '.js'), 'utf8');
  assert.equal(src.split(target).length - 1, 1, name + ' 变异必须恰好命中一处');
  const context = { module: { exports: {} } };
  vm.runInNewContext(src.replace(target, replacement), context);
  return context.module.exports;
}

test('变异自检：字素窗口不再翻倍 ⇒ 长簇判据必红，短簇负对照仍绿', function () {
  const bad = mutateModule('selection', 'const GRAPHEME_WINDOW_MAX = 256;', 'const GRAPHEME_WINDOW_MAX = 32;');
  const long = doc('xxxxx' + LONG_CLUSTER);
  assert.throws(
    function () { assert.equal(bad.graphemeBack(long, long.length), 5); },
    { code: 'ERR_ASSERTION' },
    '窗口封顶去掉之后会停在簇中间的 8，判据必须当场红'
  );
  assert.equal(bad.graphemeBack(doc('a😀'), 2), 1, '短簇继承走不到翻倍分支，负对照必须仍绿');
});
