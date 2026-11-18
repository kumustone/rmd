// `bugs/0116` §9（2026-11-14 用户报告）：**有序列表的分级字形**，复刻 Notion ——
// `1. 2. 3.` → `a. b. c.` → `i. ii. iii.` → 回到十进制，三层一循环。
//
// 用户原话：「复刻 Notion 的时候，未注意到一点，有序列表 1.2.3.4 的下一级是 a. b. c. d.」
//
// # 为什么必须两边一起判
//
// 同一个循环被写在**三处**：
//   · 阅读态 = `typography.css` 的 12 条 `.doc … ol { list-style-type }`（浏览器按祖先层数套用）；
//   · 编辑态 = `live.css` 的 12 条 `[data-rmd-li="ordered"][data-rmd-li-level="k"] { list-style-type }`
//     —— ⭐ 2026-11-15（`design/0084`）起标记由 UA 的 `::marker` 画，字形同样是**关键字表**，
//     不再由 `decorations.js::分级字形` 算成字形串再 `content: attr()`；
//   · `decorations.js::分级字形` 仍留在**纯函数面**（`markers()` 的 `marker` 字段，
//     `input.js` 用它的长度算源码列；⛔ 不再喂渲染）。
// 两张 CSS 表一旦不同步，**浏览器不会报任何错**——用户看到的就是"点进编辑态编号变了个样子"，
// 正是 `bugs/0321` / `0101` 同一族的"进出编辑态不一致"。⇒ 本文件把两张表**逐档比对**。
//
// 另三件同类的事：
//   ① **层数口径**：`ul` 也算一层（编辑态 `listStack.length` ≡ CSS 的 `:is(ol, ul)` 祖先计数），
//      否则 `1.` 里套一个 `- ` 再套 `1.` 时两边会差一层；
//   ② **编号交给 UA 的计数器**：`listDeco` 写 `counter-reset: list-item (N-1)` ＋
//      `counter-increment: list-item` —— 编辑态的编号由 UA 按这两个声明在前一行上算出来，
//      ⛔ 不再有 `data-rmd-marker`（也就没有"三位数溢出、让位、等宽数字"那一族拟合常数，
//      见 `design/0084` §2.2 与 `bugs/0112` B2-m / B2-m-5 的历史）；
//   ③ **层数夹到表长**：`data-rmd-li-level` 必须 `Math.min(层, 级上限)`，否则第 12 层起
//      没有规则命中、静默落回 `disc`。
//
// # 变异台账（2026-11-15 实跑）

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../../src/live/decorations.js');
// ⚠️ 产品同一个解析器（ESM，node ≥ 22.12 的 `require(esm)` 直接取命名导出）。
const { markdownLanguage } = require('@codemirror/lang-markdown');

const ROOT = path.join(__dirname, '..', '..');
const TYPO = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'typography.css'), 'utf8');
const LIVE = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'live.css'), 'utf8');
const DECO = fs.readFileSync(path.join(ROOT, 'src', 'live', 'decorations.js'), 'utf8');

/** 层数上限（`decorations.js::级上限`）：CSS 那条表与它同长，⛔ 不许各写一个数。 */
const MAX = D.ORDERED_MARKER_MAX_LEVEL;

// ────────────────────────────────────────────────────────────────
// 一、`分级字形` 本身（纯函数）
// ────────────────────────────────────────────────────────────────

test('⭐ 三层一循环：十进制 → 小写拉丁 → 小写罗马（Notion 口径）', function () {
  // number 取 2 时三档的字形互不相同、且都不是"看起来像别的档"的那种：
  // `2` / `b` / `ii`。
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map(function (lv) { return D.orderedMarker(2, lv); }),
    ['2', 'b', 'ii', '2', 'b', 'ii'], '循环必须按 3 走，⛔ 不是按 2 或按 4');
  // 第 0 层永远是十进制（顶层就是用户看到的第一层）。
  assert.strictEqual(D.orderedMarker(1, 0), '1');
});

test('⭐ 小写拉丁是双射 26 进制：1→a、26→z、27→aa、52→az、53→ba', function () {
  assert.deepStrictEqual([1, 26, 27, 52, 53].map(function (n) { return D.orderedMarker(n, 1); }),
    ['a', 'z', 'aa', 'az', 'ba']);
});

test('⭐ 小写罗马是标准减法式：4→iv、9→ix、40→xl、1994→mcmxciv；超范围退回十进制', function () {
  assert.deepStrictEqual([1, 4, 9, 40, 1994].map(function (n) { return D.orderedMarker(n, 2); }),
    ['i', 'iv', 'ix', 'xl', 'mcmxciv']);
  // ⚠️ CSS 的 `lower-roman` 只到 3999，超出它退回十进制——这里同口径，⛔ 别造 `mmmm…`。
  assert.strictEqual(D.orderedMarker(4000, 2), '4000');
  // 非正数同理（CSS 对 0 输出 "0"）。
  assert.strictEqual(D.orderedMarker(0, 2), '0');
});

test('⭐ 层数封顶在 `ORDERED_MARKER_MAX_LEVEL`，再深就按最内层那一档算', function () {
  assert.strictEqual(MAX, 11, '11 层 = 22em 缩进，再深任何正文宽度下都已不可读（注释里的理由）');
  const 末 = D.orderedMarker(7, MAX);
  assert.strictEqual(D.orderedMarker(7, MAX + 1), 末, '超过上限必须夹到上限');
  assert.strictEqual(D.orderedMarker(7, 999), 末, '深到荒谬也一样');
  // 负数/非有限层数按 0 处理（⛔ 别掉进 `NaN % 3`）。
  assert.strictEqual(D.orderedMarker(7, -3), D.orderedMarker(7, 0));
  assert.strictEqual(D.orderedMarker(7, NaN), D.orderedMarker(7, 0));
});

// ────────────────────────────────────────────────────────────────
// 二、`markers()` 的接线：字形进 `marker`（显示），`number`/`markerRaw` 留十进制（源码）
// ────────────────────────────────────────────────────────────────

/** 造树 + 跑产品 `markers()`。 */
function marks(text) {
  return D.markers(text, { tree: markdownLanguage.parser.parse(String(text)) });
}

test('⭐⭐ 嵌套有序列表的 `marker` 随层换字形，`number` 仍是十进制（源码权威）', function () {
  const 源 = '1. 甲\n   1. 甲一\n      1. 甲一一\n';
  const p = marks(源);
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.marker; }),
    ['1.', 'a.', 'i.'], '三层 = 十进制 / 拉丁 / 罗马');
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.level; }), [0, 1, 2]);
  // ⚠️ 写回源码的编号必须还是十进制：`input.js` 续行 / 重排要写 `3.`，⛔ 不能写 `c.`。
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.number; }), [1, 1, 1]);
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.markerRaw; }), ['1.', '1.', '1.']);
});

test('⭐⭐ `ul` 也占一层：`1.` 里套 `- ` 再套 `1.`，最内层是罗马（与 CSS 的祖先计数同构）', function () {
  const p = marks('1. 甲\n   - 乙\n     1. 丙\n');
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.level; }), [0, 1, 2]);
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.marker; }),
    ['1.', '-', 'i.'], '无序项不受影响（圆点由 0321 那条管）');
});

test('⭐ 同一层的序号仍按位置连续，字形只换"进制"', function () {
  const p = marks('1. 甲\n   1. 甲一\n   1. 甲二\n   1. 甲三\n');
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.marker; }),
    ['1.', 'a.', 'b.', 'c.']);
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.number; }), [1, 1, 2, 3]);
});

// ────────────────────────────────────────────────────────────────
// 三、两张表逐档比对（CSS ←→ JS），外加"无序列表不许被覆盖"的反面对照
// ────────────────────────────────────────────────────────────────

/** 从 `typography.css` 取出有序列表那张 `list-style-type` 表：`[{level, type}]`。 */
function css表(源) {
  const re = /\.doc((?:\s+:is\(ol, ul\))*)\s+ol\s*\{\s*list-style-type:\s*([a-z-]+)\s*;?\s*\}/g;
  const out = [];
  let m;
  while ((m = re.exec(源)) !== null) {
    out.push({ level: (m[1].match(/:is\(ol, ul\)/g) || []).length, type: m[2] });
  }
  return out;
}

/** 从 `live.css` 取出编辑态那张表（`design/0084` 之后它也是 `list-style-type` 关键字）：`[{level, type}]`。 */
function live表(源) {
  const re = /\[data-rmd-li="ordered"\]\[data-rmd-li-level="(\d+)"\]\s*\{\s*list-style-type:\s*([a-z-]+)\s*;?\s*\}/g;
  const out = [];
  let m;
  while ((m = re.exec(源)) !== null) out.push({ level: parseInt(m[1], 10), type: m[2] });
  return out;
}

/** CSS 关键字 ←→ `分级字形` 在 number=2 时的输出（三档互不混淆：`2` / `b` / `ii`）。 */
const 名字 = { decimal: '2', 'lower-alpha': 'b', 'lower-roman': 'ii' };

/** 去掉注释：判的是**声明**，⛔ 不是注释里那些被删掉的历史写法。 */
function 去注释(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 全部判据合成一个函数，返回违规列表（空 = 全绿）。
 * ⚠️ 变异自测靠它——⛔ 别把判据只写在 `assert` 里，那样"写坏了哪条"分不出来。
 * @param {{typo: string, live: string, deco: string, glyph: Function}} 源
 * @returns {string[]}
 */
function 检查(源) {
  const bad = [];
  const T = css表(源.typo);
  const L = live表(源.live);
  // ① 层数：每张表都要**每一层恰好一条**、从 0 到上限连续（漏一层会**静默**命中更外层那条）。
  if (T.length !== MAX + 1) {
    bad.push('层数：`typography.css` 只列了 ' + T.length + ' 条，`级上限` 是 ' + MAX
      + '（应 ' + (MAX + 1) + ' 条）');
  }
  if (L.length !== MAX + 1) {
    bad.push('层数：`live.css` 只列了 ' + L.length + ' 条，`级上限` 是 ' + MAX
      + '（应 ' + (MAX + 1) + ' 条）');
  }
  for (let lv = 0; lv <= MAX; lv++) {
    const 阅 = T.filter(function (r) { return r.level === lv; });
    const 编 = L.filter(function (r) { return r.level === lv; });
    if (阅.length !== 1) { bad.push('层 ' + lv + '：`typography.css` 命中 ' + 阅.length + ' 条规则'); continue; }
    if (编.length !== 1) { bad.push('层 ' + lv + '：`live.css` 命中 ' + 编.length + ' 条规则'); continue; }
    const 应 = 名字[阅[0].type];
    const 算 = 源.glyph(2, lv);
    if (应 === undefined) {
      bad.push('层 ' + lv + ' 的 `list-style-type: ' + 阅[0].type + '` 不是三档之一');
    } else if (应 !== 算) {
      // ② 字形：纯函数这边（`marker` 字段）算出来的必须与阅读态同一个循环。
      bad.push('层 ' + lv + '：CSS=' + 阅[0].type + '，JS 算出来是 ' + 算);
    }
    // ③ 两张表同构（`INV-TYPE-08`）：同一层必须是同一个关键字。
    if (阅[0].type !== 编[0].type) {
      bad.push('层 ' + lv + '：`live.css` 写的是 ' + 编[0].type
        + '，`typography.css` 是 ' + 阅[0].type + '（进出编辑态字形会变）');
    }
  }
  // ④ 反面对照：阅读态无序列表**不许**被覆盖（UA 的 disc/circle/square 就是那把尺子，0321）。
  if (/\.doc\s+ul[^{]*\{[^}]*list-style-type/.test(源.typo)) {
    bad.push('无序列表被覆盖了 `list-style-type`——圆点形状必须留给 UA（形状 = 阅读态的证据）');
  }
  // ⑤ 编辑态的编号交给 UA 的计数器（`design/0084`）：`counter-reset: list-item (N-1)` ＋
  //    `counter-increment`，`N` 取 `li.number`（`markers()` 算好的**渲染编号**，十进制）。
  const deco = 去注释(源.deco);
  if (!/counter-reset: list-item ' \+ \(号 - 1\)/.test(deco)) {
    bad.push('计数器：`listDeco` 没把渲染编号交给 `counter-reset`（`::marker` 会从 1 重新数）');
  }
  if (!/counter-increment: list-item/.test(deco)) {
    bad.push('计数器：缺 `counter-increment: list-item`');
  }
  if (!/li\.number/.test(deco)) {
    bad.push('编号：`listDeco` 没取 `li.number` —— 编号必须来自 `markers()` 的渲染编号');
  }
  // ⑥ 层数夹到表长（第 12 层起没有规则 ⇒ 静默落回 `disc`）。
  if (!/Math\.min\(层, 级上限\)/.test(deco)) {
    bad.push('层数：`data-rmd-li-level` 没夹到 `级上限`');
  }
  // ⑦ 拟合常数一族不许回来（标记由 UA 画）。
  if (/data-rmd-marker|data-rmd-li-shape|--rmd-li-/.test(deco)) {
    bad.push('拟合常数：`decorations.js` 里又出现了手绘标记那套属性/变量');
  }
  return bad;
}

test('⭐ 两张表逐档一致 ＋ 编号交给 UA 的计数器（基线必须先全绿）', function () {
  assert.deepStrictEqual(检查({ typo: TYPO, live: LIVE, deco: DECO, glyph: D.orderedMarker }), []);
  // 表本身得**真的存在**：0 条也会"没有违规"，所以单独钉一次条数。
  assert.strictEqual(css表(TYPO).length, MAX + 1, '`typography.css` 的分级表条数');
  assert.strictEqual(live表(LIVE).length, MAX + 1, '`live.css` 的分级表条数');
});

// ────────────────────────────────────────────────────────────────
// 四、变异自测（⚠️ 没做过变异测试的断言不算数）
// ────────────────────────────────────────────────────────────────

test('⭐⭐ 变异自测：十处写坏各必须让**对应**判据变红', function () {
  const has = function (list, needle) {
    return list.some(function (x) { return x.indexOf(needle) >= 0; });
  };
  const 基线 = { typo: TYPO, live: LIVE, deco: DECO, glyph: D.orderedMarker };
  assert.deepStrictEqual(检查(基线), [], '基线必须先全绿，否则下面分不清是谁的红');

  // m1：`typography.css` 第 2 条（level 1）改回十进制 ⇒ 层 1 与纯函数不一致
  //     （"a. 不见了"正是用户报的那条）。
  const m1 = 检查(Object.assign({}, 基线, {
    typo: TYPO.replace(/(\.doc :is\(ol, ul\) ol \{\s*list-style-type:\s*)lower-alpha/,
      '$1decimal'),
  }));
  assert.ok(has(m1, '层 1'), m1.join('\n'));

  // m2：删掉 `typography.css` 最后一条 ⇒ 层数不够（第 12 层会静默落回更外层那条）。
  const 末条 = '\\s*\\.doc(?:\\s+:is\\(ol, ul\\)){11}\\s+ol\\s*\\{[^}]*\\}';
  const m2 = 检查(Object.assign({}, 基线, { typo: TYPO.replace(new RegExp(末条), '') }));
  assert.ok(has(m2, '层数'), m2.join('\n'));

  // m3：`live.css` 第 2 条改回十进制 ⇒ 两张表在层 1 不同构（进出编辑态字形变）。
  const m3 = 检查(Object.assign({}, 基线, {
    live: LIVE.replace(/(\[data-rmd-li-level="1"\]\s*\{\s*list-style-type:\s*)lower-alpha/,
      '$1decimal'),
  }));
  assert.ok(has(m3, '层 1'), m3.join('\n'));

  // m4：删掉 `live.css` 最后一条 ⇒ 编辑态层数不够（第 12 层落回 `disc`，⛔ 不是十进制）。
  const m4src = LIVE.replace(/\n[^\n]*\[data-rmd-li-level="11"\][^\n]*/, '');
  assert.notStrictEqual(m4src, LIVE, 'm4 没改到（靶子漂移）');
  const m4 = 检查(Object.assign({}, 基线, { live: m4src }));
  assert.ok(has(m4, '层数'), m4.join('\n'));

  // m5：`counter-reset` 丢掉 `N-1` ⇒ 每一项都从 1 数（整列同号，正是 `1. 1. 1.` 那种错）。
  const m5 = 检查(Object.assign({}, 基线, {
    deco: DECO.replace("counter-reset: list-item ' + (号 - 1)", "counter-reset: list-item ' + 0"),
  }));
  assert.ok(has(m5, '计数器'), m5.join('\n'));

  // m6：去掉层数夹取 ⇒ 第 12 层没有规则命中。
  const m6 = 检查(Object.assign({}, 基线, { deco: DECO.replace('Math.min(层, 级上限)', '层') }));
  assert.ok(has(m6, '层数'), m6.join('\n'));

  // m7：JS 的循环改成按 2 走 ⇒ 从第 2 层起整条表错位（CSS 那边完全看不出问题）。
  const 坏字形 = function (n, lv) { return D.orderedMarker(n, (lv || 0) % 2 === 0 ? 0 : 1); };
  const m7 = 检查(Object.assign({}, 基线, { glyph: 坏字形 }));
  assert.ok(has(m7, '层 2'), m7.join('\n'));

  // m8：罗马字形的 4000 上限被去掉（CSS 只到 3999，两边在深列表第 4000 项上分叉）。
  //     ⚠️ 这一条不走 `检查`——它是纯函数性质，直接判。
  assert.strictEqual(D.orderedMarker(4000, 2), '4000');
  const 无上限 = function (n, lv) {
    return (lv || 0) % 3 === 2 && n > 3999 ? 'mmmm' : D.orderedMarker(n, lv);
  };
  assert.notStrictEqual(无上限(4000, 2), D.orderedMarker(4000, 2),
    '变异本身必须真的改变输出，否则这条判据是空转');

  // m9：`live.css` 的表整体错位（层 2 写成拉丁）⇒ 层 2 不同构。
  const m9 = 检查(Object.assign({}, 基线, {
    live: LIVE.replace(/(\[data-rmd-li-level="2"\]\s*\{\s*list-style-type:\s*)lower-roman/,
      '$1lower-alpha'),
  }));
  assert.ok(has(m9, '层 2'), m9.join('\n'));

  // m10：把 `data-rmd-marker` 塞回装饰层 ⇒ 拟合常数闸门红。
  const m10 = 检查(Object.assign({}, 基线, {
    deco: DECO.replace("attrs.style += '; counter-reset:",
      "attrs['data-rmd-marker'] = li.marker; attrs.style += '; counter-reset:"),
  }));
  assert.ok(has(m10, '拟合常数'), m10.join('\n'));
});

// ⭐ 变异台账（2026-11-15 实跑；2026-11-14/15 那版的 m3–m5、m8–m14 靶子是
// `padding-right` / `tabular-nums` / `max-content` / `translateX` 那一族拟合常数，
// 随 `design/0084`（标记改由 UA 画）**整族退役**，改靶到两张关键字表）：
// | 变异 | 结果 |
// |---|---|
// | m1 `typography.css` 层 1 改回 `decimal` | ✅ 红「层 1」（`a.` 消失） |
// | m2 删 `typography.css` 最后一条（层 11） | ✅ 红「层数」 |
// | m3 `live.css` 层 1 改回 `decimal` | ✅ 红「层 1」（两表不同构） |
// | m4 删 `live.css` 最后一条（层 11） | ✅ 红「层数」 |
// | m5 `counter-reset` 丢掉 `N-1` | ✅ 红「计数器」 |
// | m6 去掉层数夹取 | ✅ 红「层数」 |
// | m7 JS 循环改成 `% 2` | ✅ 红「层 2」 |
// | m8 罗马去掉 4000 上限 | ✅ 「4000 退回十进制」那条纯函数判据红 |
// | m9 `live.css` 层 2 写成 `lower-alpha` | ✅ 红「层 2」 |
// | m10 把 `data-rmd-marker` 塞回装饰层 | ✅ 红「拟合常数」 |
