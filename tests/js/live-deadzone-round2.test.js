// 变异审计 Top 10「哑区」第 2 轮：把**行为敏感**的判据补到纯 Node 可达的条目上。
//
// 出处：`docs/research/notes/0046-判据灵敏度审计-2026-11-10.md` §2 的 Top 10 表、
//       `docs/design/0065-块级几何单一真相与列表行为声明化（提案）.md`。
//
// # 这一份钉什么（每条都带 `vm` 变异自检，见文件尾）
//
// | 本文件 | Top 10 | 位置 | 被钉住的**可观察**行为 |
// |---|---|---|---|
// | R2-01 | #1 | `decorations.js:865/871/875` | 有序列表行装饰的 `data-rmd-marker` / 类名 / `data-rmd-li`；缓存键必须含 marker |
// | R2-02 | #10 | `decorations.js:428` | `- \t项` 的 Tab 与空格一样并入隐藏区间（`contentFrom` ＝ 第一个可见字） |
// | R2-03 | #5 | `decorations.js:136` | `LinkTitle` 被隐藏；Autolink 的 `URL` **不**被隐藏（负对照） |
// | R2-04 | #3 | `objects.js:75/106` | 策略值本身：`BLOCK.tab='leave'`、`CELL.arrows='cross'`（不是"键处理读过这个字段"） |
// | R2-05 | #2 | `selection.js:1123` | 末行行尾 `End` 不许 `lineAt(len+1)`——用**严格适配器**（越界即抛 `RangeError`）证明 |
// | R2-06 | #9 | `input.js:143` | 组合目标被换掉（`nowTarget` 是**另一个**目标）必须算 `targetChanged` |
//
// # 不含什么
//
// - ⛔ 不碰 `src/**`：本文件只读源码（`require` ＋ 变异副本走 `vm`）。
// - ⛔ 不碰真 DOM / 真 CM6 `EditorView`：`createField` 用假 `CM6`（只给 `Decoration` /
//   `StateField` / `EditorView.decorations.from` / `syntaxTree`），语法树用**产品同一个**
//   `@codemirror/lang-markdown` 解析器。
// - ⛔ 不写假断言：本文件尾列出**不可达**条目（`index.js:lineOfCaret`）与**当前源码不满足**
//   的一条（`nowTarget === null`），⛔ 不拿"恒绿"糊过去。
//
// # 变异自检的写法（照 `live-list-crud-matrix.test.js` 的 `L-0313-*`）
//
// 每条断言都抽成 `check*(api)`：先用**真实模块**跑绿，再用 `vm` 加载**改坏一处**的副本，
// 断言同一个 `check*` 当场抛 `ERR_ASSERTION`。靶子串必须唯一命中一处（`mutateModule` 自检）。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const D = require('../../src/live/decorations.js');
const S = require('../../src/live/selection.js');
const O = require('../../src/live/objects.js');
const I = require('../../src/live/input.js');
// ⚠️ 产品同一个解析器（`live-decorations.test.js` / `live-list-crud-matrix.test.js` 同口径）。
const { markdownLanguage } = require('@codemirror/lang-markdown');

// ── harness ────────────────────────────────────────────────────────────────

/** 产品同一个解析器造树；`markers()` / `createField()` 只认树。 */
function parse(text) {
  return markdownLanguage.parser.parse(String(text));
}

/** 某段源码是否被隐藏区间**完整覆盖**。 */
function covered(ranges, from, to) {
  return ranges.some(function (r) { return r.from <= from && to <= r.to; });
}

/**
 * 假 CM6：只提供 `createField()` 真正会摸的那几个入口。
 * ⚠️ `Decoration.line(spec)` 返回的对象带 `range(from)`，`set()` 原样返回列表
 *    ⇒ 测试能逐条读回 `spec.attributes`（⛔ 不需要真视图）。
 */
function fakeCM6(tree) {
  return {
    Decoration: {
      replace: function () {
        return { range: function (from, to) { return { kind: 'hide', from: from, to: to }; } };
      },
      line: function (spec) {
        const o = { spec: spec };
        o.range = function (from) { return { kind: 'line', from: from, spec: spec }; };
        return o;
      },
      mark: function (spec) {
        const o = { spec: spec };
        o.range = function (from, to) {
          return { kind: 'mark', from: from, to: to, spec: spec };
        };
        return o;
      },
      set: function (list) { return list; },
    },
    StateField: { define: function (cfg) { return cfg; } },
    EditorView: { decorations: { from: function (f) { return { field: f }; } } },
    syntaxTree: function () { return tree; },
  };
}

/** 跑一次 `createField().create()`，取回所有**行级**装饰 `{from, spec}`。 */
function lineDecosFor(api, text) {
  const field = api.createField(fakeCM6(parse(text)), {})[0];
  const out = field.create({
    doc: { toString: function () { return String(text); }, length: String(text).length },
  });
  return out.filter(function (d) { return d && d.kind === 'line'; })
    .map(function (d) { return { from: d.from, spec: d.spec }; });
}

/**
 * 宽松适配器（与 `live-list-crud-matrix.test.js::doc` 同口径）。
 * ⚠️ 它会把越界位置**夹取**掉 ⇒ 不能用来证明"末行 End 不许越界"（Top 10 #2 的教训）。
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
  };
}

/**
 * ⭐ **严格适配器**：与 CM6 `Text` 同口径——`lineAt(pos)` 在 `pos < 0 || pos > length`
 * 时抛 `RangeError`，⛔ 不做夹取。
 * 这条正是 Top 10 #2 指出的缺口：假适配器的夹取把"越界"掩盖成了"正确"。
 */
function strictDoc(text) {
  const src = String(text);
  const base = doc(src);
  return {
    length: base.length,
    lines: base.lines,
    lineAt: function (pos) {
      if (!Number.isInteger(pos) || pos < 0 || pos > src.length) {
        throw new RangeError('lineAt 越界：' + pos + ' ∉ [0, ' + src.length + ']');
      }
      return base.lineAt(pos);
    },
  };
}

/** 读真实模块、按唯一靶子改一处、在隔离上下文里跑出副本。 */
function mutateModule(name, target, replacement) {
  const src = fs.readFileSync(require.resolve('../../src/live/' + name + '.js'), 'utf8');
  assert.equal(src.split(target).length - 1, 1, name + ' 变异必须恰好命中一处');
  // ⚠️ `design/0065` P1 起 `decorations.js` 加载期就要取 `live/geometry.js`
  //    （`require('./geometry.js')`）：隔离上下文里没有 `require` ⇒ 必须显式注进去，
  //    且 `./geometry.js` 映射到产品那份（⛔ 相对 `tests/js/` 去解析）。
  const context = {
    module: { exports: {} },
    require: function (p) {
      return p === './geometry.js' ? require('../../src/live/geometry.js') : require(p);
    },
  };
  vm.runInNewContext(src.replace(target, replacement), context);
  return /** @type {any} */ (context.module.exports);
}

const ERR_ASSERTION = { code: 'ERR_ASSERTION' };

// ── R2-01 Top 10 #1：有序列表行装饰的身份随**渲染编号**变化 ────────────────
//
// `listDeco()` 按「深度｜品种｜marker｜层数｜编号」缓存。⭐ 2026-11-15（`design/0084`）起
// 编号不再写成 `data-rmd-marker`（手绘 `::before` 那套已整个删除），而是写成行内
// `counter-reset: list-item (N-1)` ＋ `counter-increment: list-item`，由 UA 的 `::marker`
// 数出来。缓存键一旦丢掉编号，两行共用同一个 `Decoration.line`：整列都从 1 数
// （用户看到"1. 1."）——这就是下面那条承重判据。

/** @param {any} api decorations 模块（真实或变异副本） */
function checkOrderedListDecos(api) {
  const text = '1. 甲\n2. 乙';
  const decos = lineDecosFor(api, text);
  assert.equal(decos.length, 2, '两条列表行各要一条行级装饰');
  assert.deepEqual(decos.map(function (d) { return d.from; }), [0, 5], '每行装饰落在各自行首');
  for (const d of decos) {
    assert.equal(d.spec.class, 'cm-rmd-li', '列表行级类名必须与 live.css 的规则逐字一致');
    assert.equal(d.spec.attributes['data-rmd-li'], 'ordered', '品种属性决定开 `display: list-item`');
    assert.equal(d.spec.attributes['data-rmd-li-level'], '0', '层数（第一层）');
    assert.match(d.spec.attributes.style, /margin-left:\s*calc\(var\(--reader-list-indent\) \* 0\)/,
      '缩进必须写在 `margin-left` 上（写在 `padding-left` 上标记会整体左移一个缩进）');
    assert.doesNotMatch(d.spec.attributes.style, /padding-left/,
      '⛔ 行上不许再有 `padding-left`（`bugs/0113` §8 的 64 设备 px）');
    assert.match(d.spec.attributes.style, /counter-increment:\s*list-item/,
      '缺 `counter-increment` ⇒ 编号永远停在 `counter-reset` 那个值');
  }
  // ⭐ 承重判据：两行的编号必须**各自**出自本行（`counter-reset: N-1`，N ＝ 1 / 2）。
  assert.match(decos[0].spec.attributes.style, /counter-reset:\s*list-item 0\b/, '第 1 项：N-1 = 0');
  assert.match(decos[1].spec.attributes.style, /counter-reset:\s*list-item 1\b/,
    '第 2 项：N-1 = 1 —— 缓存键丢掉编号时这里会退回 `0`（整列同号）');
}

/** 负对照：无序列表不碰计数器（⛔ 不能把 bullet 也塞一个 `counter-reset`）。 */
function checkBulletNoCounter(api) {
  const bullet = lineDecosFor(api, '- 甲');
  assert.equal(bullet.length, 1, '一条无序列表行一条行级装饰');
  assert.equal(bullet[0].spec.attributes['data-rmd-li'], 'bullet', '品种＝圆点');
  assert.doesNotMatch(bullet[0].spec.attributes.style, /counter-(reset|increment)/,
    '无序项不该有计数器（圆点由 UA 按 `list-style-type` 画）');
  assert.equal(bullet[0].spec.attributes['data-rmd-li-level'], '0', '圆点形状按层数给');
}

test('R2-01 有序列表行装饰：类名 / 品种 / 计数器逐行独立', function () {
  checkOrderedListDecos(D);
  checkBulletNoCounter(D);
});

test('R2-01m 变异：缓存键丢掉 marker 与编号 ⇒ 第 2 行退回 `counter-reset: 0` 必红', function () {
  const bad = mutateModule('decorations',
    "const key = li.depth + '|' + li.kind + '|' + (li.marker || '') + '|' + (li.level || 0)\n"
    + "        + '|' + (li.number || 0);",
    "const key = li.depth + '|' + li.kind + '|' + (li.level || 0);");
  checkOrderedListDecos(D); // 真实模块绿
  assert.throws(function () { checkOrderedListDecos(bad); }, ERR_ASSERTION,
    '缓存键不含编号时，第二条断言的 `counter-reset: 1` 必须当场红');
  const badDecos = lineDecosFor(bad, '1. 甲\n2. 乙');
  assert.match(badDecos[1].spec.attributes.style, /counter-reset:\s*list-item 0\b/,
    '变异副本把两行合并成同一个编号');
});

test('R2-01m2 变异：不写 `counter-reset` ⇒ 计数器断言必红', function () {
  const bad = mutateModule('decorations',
    'counter-reset: list-item ',
    'counter-reset-x: list-item ');
  assert.throws(function () { checkOrderedListDecos(bad); }, ERR_ASSERTION,
    '去掉 `counter-reset` 后，编号断言必须红');
});

test('R2-01m3 变异：行级类名写错 ⇒ 类名断言必红', function () {
  const bad = mutateModule('decorations',
    "listDecos[key] = CM6.Decoration.line({ class: 'cm-rmd-li', attributes: attrs });",
    "listDecos[key] = CM6.Decoration.line({ class: 'cm-rmd-li-x', attributes: attrs });");
  assert.throws(function () { checkOrderedListDecos(bad); }, ERR_ASSERTION,
    '类名与 live.css 不逐字一致时，类名断言必须红');
});

test('R2-01m4 变异：data-rmd-li 品种写死 ⇒ 品种断言必红', function () {
  const bad = mutateModule('decorations',
    "'data-rmd-li': li.kind,",
    "'data-rmd-li': 'li',");
  assert.throws(function () { checkOrderedListDecos(bad); }, ERR_ASSERTION,
    '品种属性写死时 "ordered" 断言必须红');
});

test('R2-01m5 变异：计数器无条件写 ⇒ 无序负对照必红', function () {
  // ⚠️ 这一处源码是 `if (li.kind === 'ordered') { … } else { … }`，
  //    所以变异改成"条件恒真"，⛔ 不能只留一句赋值（会留下裸 `else` ⇒ 语法错）。
  const bad = mutateModule('decorations',
    "if (li.kind === 'ordered') {\n          // ⭐ 编号取",
    "if (true) {\n          // ⭐ 编号取");
  checkBulletNoCounter(D); // 真实模块绿
  assert.throws(function () { checkBulletNoCounter(bad); }, ERR_ASSERTION,
    '无序项被塞进计数器时，负对照必须红');
});

// ── R2-01b `bugs/0321` ①：圆点形状按**层数**走（2026-11-14 用户报告）───────
//
// 阅读态的圆点由 UA 级联画（实心圆 / 空心圈 / 实心方），编辑态同样交给 UA 的 `::marker`，
// 但扁平行没有嵌套结构 ⇒ 行级装饰必须把**层数**交出去（`data-rmd-li-level`），
// `live.css` 据此给 `disc` / `circle` / `square`。⛔ 不许一律实心圆（那正是用户看到的"不一致"）。

/** @param {any} api decorations 模块（真实或变异副本） */
function checkBulletShapes(api) {
  const text = '- 一\n  - 二\n    - 三\n      - 四\n';
  const decos = lineDecosFor(api, text);
  assert.deepEqual(decos.map(function (d) { return d.spec.attributes['data-rmd-li-level']; }),
    ['0', '1', '2', '2'], '四层圆点：0 / 1 / 2 / 2（三层及更深都是方，夹到 2）');
  assert.deepEqual(decos.map(function (d) { return d.spec.attributes['data-rmd-li']; }),
    ['bullet', 'bullet', 'bullet', 'bullet'], '品种仍是 bullet（层数是它的子属性）');
  // 负对照：引用里的**第一层**列表仍是实心圆（`depth` 补位 ⛔ 不影响层数）。
  const quoted = lineDecosFor(api, '> - 甲');
  assert.equal(quoted[0].spec.attributes['data-rmd-li-level'], '0',
    '引用只补缩进、不补层级：第一层列表恒为实心圆');
}

test('R2-01b 圆点层数逐层独立（`bugs/0321`）', function () {
  checkBulletShapes(D);
});

test('R2-01bm 变异：层数写死成 0 ⇒ 层级断言必红', function () {
  const bad = mutateModule('decorations',
    'Math.min(层, 2)',
    'Math.min(0, 2)');
  assert.throws(function () { checkBulletShapes(bad); }, ERR_ASSERTION,
    '第二层写成 0 时，"1" 断言必须当场红');
});

test('R2-01bm2 变异：层数记成 `listStack.length + 1` ⇒ 第二层变方、断言必红', function () {
  const bad = mutateModule('decorations',
    '记层级(n, listStack.length);',
    '记层级(n, listStack.length + 1);');
  assert.throws(function () { checkBulletShapes(bad); }, ERR_ASSERTION,
    '层数多算一层时，第一层就会变成空心圈');
});

// ── R2-02 Top 10 #10：`- \t项` 的 Tab 必须并入隐藏区间 ─────────────────────
//
// `ListMark` 之后的空白由 `while (... ' ' || '\t')` 一起吃掉。只测过空格分隔，
// 于是"漏掉 \t"的变异能让 Tab 留在屏幕上、`contentFrom` 停在标记后一位
// ⇒ 光标落点与折行点都偏移。

/** @param {any} api decorations 模块（真实或变异副本） */
function checkTabSeparatedList(api) {
  const text = '- \t项';
  const p = api.markers(text, { tree: parse(text) });
  const firstVisible = text.indexOf('项');
  assert.deepEqual(p.ranges, [{ from: 0, to: firstVisible }],
    '隐藏区间必须从行首一直吃到第一个可见字（空格与 Tab 一视同仁）');
  assert.equal(p.listLines.length, 1);
  assert.equal(p.listLines[0].contentFrom, firstVisible,
    'contentFrom 必须是标记 + 空白之后的第一个可见字');
  assert.equal(p.listLines[0].kind, 'bullet');
  // 负对照：空格分隔照旧（改动不能反过来吞掉正文）。
  const space = '- 项';
  const ps = api.markers(space, { tree: parse(space) });
  assert.deepEqual(ps.ranges, [{ from: 0, to: space.indexOf('项') }]);
  assert.equal(ps.listLines[0].contentFrom, space.indexOf('项'));
  // 连续 Tab 也一样：循环必须把连续空白都吃掉（⛔ 只处理第一个）。
  const double = '- \t\t项';
  const pd = api.markers(double, { tree: parse(double) });
  assert.deepEqual(pd.ranges, [{ from: 0, to: double.indexOf('项') }],
    '连续 Tab 不许留下任何一个在屏幕上');
  assert.equal(pd.listLines[0].contentFrom, double.indexOf('项'));
}

test('R2-02 Tab 分隔的列表项：隐藏区间与空格分隔同口径', function () {
  checkTabSeparatedList(D);
});

test('R2-02m 变异：while 去掉 \\t ⇒ Tab 留在屏幕上、contentFrom 少一格', function () {
  const bad = mutateModule('decorations',
    '            let to = node.to;\n'
    + "            while (to < src.length && (src.charAt(to) === ' ' || src.charAt(to) === '\\t')) to++;\n"
    + '            const 止 = Math.min(to, 行末(n));\n'
    + '            raw.push({ from: lineStarts[n], to: 止 });',
    '            let to = node.to;\n'
    + "            while (to < src.length && src.charAt(to) === ' ') to++;\n"
    + '            const 止 = Math.min(to, 行末(n));\n'
    + '            raw.push({ from: lineStarts[n], to: 止 });');
  assert.throws(function () { checkTabSeparatedList(bad); }, ERR_ASSERTION,
    'Tab 不并入隐藏区间时，ranges / contentFrom 断言必须红');
  const text = '- \t项';
  const p = bad.markers(text, { tree: parse(text) });
  assert.equal(p.ranges[0].to, 2,
    '变异副本只藏到空格之后（`- `），Tab 留在屏幕上');
  assert.equal(p.listLines[0].contentFrom, 2,
    '正文起点停在 Tab 之前 ⇒ 光标与折行点都偏一格');
});

// ── R2-03 Top 10 #5：`LinkTitle` 被隐藏，Autolink 的 URL 不被隐藏 ──────────
//
// 行内隐藏只测过强调 / 链接 / 行内代码，独漏 `"title"`。`shouldHide()` 把
// `URL` 与 `LinkTitle` 绑在同一条父节点判据上；负对照防"整条链接凭空消失"
// （Autolink 的文字就是 URL 本身，藏了 URL 等于藏了链接文字）。

/** 取第一个指定节点名的跨度（只在树里，不碰 DOM）。 */
function spanOf(tree, name) {
  let hit = null;
  tree.iterate({
    enter: function (n) {
      if (hit === null && n.name === name) hit = { from: n.from, to: n.to };
    },
  });
  return hit;
}

/** @param {any} api decorations 模块（真实或变异副本） */
function checkLinkTitleHidden(api) {
  const text = '[文字](url "标题")';
  const tree = parse(text);
  const title = spanOf(tree, 'LinkTitle');
  assert.ok(title, '语法树里必须有 LinkTitle 节点（前置事实）');
  assert.equal(text.slice(title.from, title.to), '"标题"');
  const p = api.markers(text, { tree: tree });
  assert.ok(covered(p.ranges, title.from, title.to),
    'LinkTitle（含引号）必须整段隐藏，否则源码形态的 "标题" 会露出来');

  // 负对照：Autolink 只藏尖括号，URL 是可见文字。
  const auto = '<http://x>';
  const aTree = parse(auto);
  const url = spanOf(aTree, 'URL');
  assert.ok(url, 'Autolink 里必须有 URL 节点（前置事实）');
  const ap = api.markers(auto, { tree: aTree });
  assert.ok(!covered(ap.ranges, url.from, url.to),
    'Autolink 的 URL 不许藏：藏了整条链接的文字就消失了');
  assert.ok(covered(ap.ranges, 0, 1) && covered(ap.ranges, auto.length - 1, auto.length),
    'Autolink 只藏两个尖括号');
}

test('R2-03 LinkTitle 隐藏 · Autolink URL 可见（负对照）', function () {
  checkLinkTitleHidden(D);
});

test('R2-03m 变异：shouldHide 独漏 LinkTitle ⇒ "标题" 露出必红', function () {
  const bad = mutateModule('decorations',
    "if (name === 'URL' || name === 'LinkTitle') return parentName === 'Link' || parentName === 'Image';",
    "if (name === 'URL') return parentName === 'Link' || parentName === 'Image';");
  assert.throws(function () { checkLinkTitleHidden(bad); }, ERR_ASSERTION,
    'LinkTitle 不藏时，覆盖判据必须红');
});

test('R2-03m2 变异：URL 无条件藏 ⇒ Autolink 文字消失的负对照必红', function () {
  const bad = mutateModule('decorations',
    "if (name === 'URL' || name === 'LinkTitle') return parentName === 'Link' || parentName === 'Image';",
    "if (name === 'URL' || name === 'LinkTitle') return true;");
  assert.throws(function () { checkLinkTitleHidden(bad); }, ERR_ASSERTION,
    'URL 被无条件隐藏时，负对照必须红（证明它承重，不是恒绿）');
});

// ── R2-04 Top 10 #3：断言策略值本身 ───────────────────────────────────────
//
// `live-wiring.test.js:1027` 只证明键处理**读**了 `obj.tab`，不证明字段是什么。
// 这里直接钉数据表：列表（块级）Tab = 提交并退出、表格格内方向键 = 跨格。

/** @param {any} api objects 模块（真实或变异副本） */
function checkPolicies(api) {
  assert.equal(api.BLOCK.id, 'block');
  assert.equal(api.BLOCK.tab, 'leave', '列表/块级 Tab 当前口径＝提交并退出（bugs/0116 的已知缺口）');
  assert.equal(api.BLOCK.enter, 'newline', '块级裸 Enter 必须真的换行，⛔ 不走格');
  assert.equal(api.BLOCK.arrows, 'stay', '块级方向键到边界只能停在本块（没有相邻格）');
  assert.equal(api.BLOCK.inlineOnly, false, '块级不是"只按行内语义"');
  assert.equal(api.BLOCK.verify, 'lines');

  assert.equal(api.CELL.id, 'cell');
  assert.equal(api.CELL.tab, 'walk', '格内 Tab 走格');
  assert.equal(api.CELL.arrows, 'cross', '格内方向键到边界必须跨格（bugs/0104，复刻 Mardo）');
  assert.equal(api.CELL.inlineOnly, true, '格内只按行内语义呈现');
  assert.equal(api.CELL.verify, 'structure');

  assert.equal(api.policyOf({ cell: {} }), api.CELL, '有 cell 上下文 ⇒ 格子策略');
  assert.equal(api.policyOf(null), api.BLOCK, '没有上下文 ⇒ 块级策略');
}

test('R2-04 编辑对象策略值：BLOCK.tab=leave / CELL.arrows=cross', function () {
  checkPolicies(O);
});

test('R2-04m 变异：CELL.arrows cross → stay ⇒ 跨格策略断言必红', function () {
  const bad = mutateModule('objects',
    "arrows: /** @type {const} */ ('cross'),",
    "arrows: /** @type {const} */ ('stay'),");
  assert.throws(function () { checkPolicies(bad); }, ERR_ASSERTION,
    '方向键跨格失效（整齐地退回 stay）时断言必须红');
});

test('R2-04m2 变异：BLOCK.tab leave → walk ⇒ 列表 Tab 策略断言必红', function () {
  const bad = mutateModule('objects',
    "tab: /** @type {const} */ ('leave'),",
    "tab: /** @type {const} */ ('walk'),");
  assert.throws(function () { checkPolicies(bad); }, ERR_ASSERTION,
    '块级 Tab 语义被改掉时断言必须红');
});

// ── R2-05 Top 10 #2：末行行尾 End 不许 `lineAt(len + 1)` ──────────────────
//
// `move(doc, sel, 'lineEnd')` 在"已在行尾"时要先去下一行行尾；当前代码用
// `l.number < doc.lines` 挡住末行。删掉这个守卫 ⇒ `lineAt(doc.length + 1)`，
// 真 CM6 抛 `RangeError`。⚠️ 矩阵文件里的宽松适配器会夹取，掩盖成"正确"；
// 这里用严格适配器让越界**当场抛**。

/** @param {any} api selection 模块（真实或变异副本） */
function checkLastLineEnd(api) {
  const text = 'ab\ncd';
  const d = strictDoc(text);
  assert.equal(d.length, 5);
  assert.equal(d.lines, 2);
  /** @type {{anchor:number, head:number}} */
  let r = { anchor: -1, head: -1 };
  assert.doesNotThrow(function () {
    r = api.move(d, { anchor: 5, head: 5 }, 'lineEnd');
  }, '末行行尾按 End 不许访问 lineAt(len + 1)');
  assert.equal(r.head, 5, '末行行尾就是终点');
  assert.equal(r.anchor, 5);
  // 正对照：非末行行尾 ⇒ 去下一行行尾（守卫不能把这条正常路径也关掉）。
  assert.equal(api.move(d, { anchor: 2, head: 2 }, 'lineEnd').head, 5,
    '第 1 行行尾按 End 应落到第 2 行行尾');
  // 末行行中 ⇒ 本行行尾。
  assert.equal(api.move(d, { anchor: 4, head: 4 }, 'lineEnd').head, 5,
    '末行行中按 End 应落到本行行尾');
}

test('R2-05 末行行尾 End：严格适配器下不越界', function () {
  checkLastLineEnd(S);
});

test('R2-05m 变异：删掉 l.number < doc.lines 守卫 ⇒ 末行 End 抛 RangeError 必红', function () {
  const bad = mutateModule('selection',
    'if (head === l.to && l.number < doc.lines) return keep(doc.lineAt(l.to + 1).to);',
    'if (head === l.to) return keep(doc.lineAt(l.to + 1).to);');
  assert.throws(function () { checkLastLineEnd(bad); }, ERR_ASSERTION,
    '越界访问在严格适配器下抛 RangeError，doesNotThrow 必须变成断言失败');
  assert.throws(function () {
    bad.move(strictDoc('ab\ncd'), { anchor: 5, head: 5 }, 'lineEnd');
  }, RangeError, '变异副本确实在末行行尾越界');
});

test('R2-05m2 变异：lineAt(l.to + 1) → lineAt(l.to) ⇒ 非末行不再换行必红', function () {
  const bad = mutateModule('selection',
    'return keep(doc.lineAt(l.to + 1).to);',
    'return keep(doc.lineAt(l.to).to);');
  assert.throws(function () { checkLastLineEnd(bad); }, ERR_ASSERTION,
    '非末行行尾 End 停在原地时，正对照断言必须红');
});

// ── R2-06 Top 10 #9：组合目标被换掉必须算 `targetChanged` ──────────────────
//
// `settleTarget()` 用**不透明令牌**判断"这一串暂存输入还属不属于当前目标"。
// 判据必须是**行为**：目标换成另一个对象时，即使偏移**恰好相同**，也要 `rebased`
// （否则调用方会以为可以继续用起手那一刻的旧位置）。
//
// ⚠️ 审计原文还点名了 `nowTarget === null` 那一支。当前源码
// `at.target !== null && nowTarget !== null && at.target !== nowTarget`
// 在 `nowTarget === null` 时算 **false**（即"没有变化"）⇒ 无当前位置时会把暂存内容
// 写回**旧偏移**。按"⛔ 不改 src / ⛔ 不写假断言"，本文件**不**把这条写成绿色判据；
// 如实登记在文件尾的「已知缺口」。

/** @param {any} api input 模块（真实或变异副本） */
function checkTargetChanged(api) {
  // ① 目标换成另一个对象，但当前偏移与起手时**逐值相同** ⇒ 只能靠 target 判出 rebased。
  const edits1 = [];
  const m1 = api.createInputMachine(function (tx) { edits1.push(tx); });
  m1.handle({ type: 'compositionstart', from: 2, to: 2, target: { id: 'old' } });
  const r1 = m1.handle({
    type: 'compositionend', data: '新', from: 2, to: 2, target: { id: 'new' },
  });
  assert.equal(r1.applied, true);
  assert.equal(r1.rebased, true,
    '目标已换（哪怕偏移相同）必须 rebased：否则落定会被旧目标继续带偏');
  assert.deepEqual(edits1.map(function (t) { return [t.from, t.to, t.next]; }),
    [[2, 2, ['新']]]);

  // ② 目标被换、**没有**当前位置 ⇒ lost，⛔ 不许往旧偏移写。
  const edits2 = [];
  const m2 = api.createInputMachine(function (tx) { edits2.push(tx); });
  m2.handle({ type: 'compositionstart', from: 2, to: 2, target: { id: 'old' } });
  const r2 = m2.handle({
    type: 'compositionend', data: '新', target: { id: 'new' },
  });
  assert.equal(r2.stale, true, '目标已换且没有当前位置 ⇒ 丢弃暂存输入');
  assert.deepEqual(edits2, [], '⛔ 不许把组合结果写进旧偏移');

  // ③ 取消路径同理：暂存粘贴也不许写进旧目标。
  const edits3 = [];
  const m3 = api.createInputMachine(function (tx) { edits3.push(tx); });
  m3.handle({ type: 'compositionstart', from: 2, to: 2, target: { id: 'old' } });
  m3.handle({ type: 'paste', text: '旧粘贴' });
  const r3 = m3.handle({ type: 'cancel', target: { id: 'new' } });
  assert.equal(r3.stale, true);
  assert.deepEqual(edits3, []);
  assert.deepEqual(m3.state.pending, []);

  // ④ 目标已换、但**有**当前选区 ⇒ 按当前偏移落定（⛔ 落回起手的 2）。
  const edits4 = [];
  const m4 = api.createInputMachine(function (tx) { edits4.push(tx); });
  m4.handle({ type: 'compositionstart', from: 2, to: 2, target: { id: 'old' } });
  const r4 = m4.handle({
    type: 'compositionend', data: '新', from: 7, to: 7, target: { id: 'new' },
  });
  assert.equal(r4.rebased, true);
  assert.deepEqual(edits4.map(function (t) { return [t.from, t.to]; }), [[7, 7]],
    '有当前选区时必须落当前偏移');
}

test('R2-06 组合目标被换掉：rebased / stale 与"不写旧偏移"', function () {
  checkTargetChanged(I);
});

test('R2-06m 变异：nowTarget 恒为 null（目标令牌被忽略）⇒ 旧偏移照写必红', function () {
  const bad = mutateModule('input',
    'const nowTarget = e.target === undefined ? null : e.target;',
    'const nowTarget = null;');
  assert.throws(function () { checkTargetChanged(bad); }, ERR_ASSERTION,
    'targetChanged 永远为 false 时，rebased / stale 断言必须红');
  // 直接看变异副本的可观察后果：写回了旧偏移。
  const edits = [];
  const m = bad.createInputMachine(function (tx) { edits.push(tx); });
  m.handle({ type: 'compositionstart', from: 2, to: 2, target: { id: 'old' } });
  const r = m.handle({ type: 'compositionend', data: '新', target: { id: 'new' } });
  assert.equal(r.stale, undefined);
  assert.deepEqual(edits.map(function (t) { return t.from; }), [2],
    '变异副本把组合结果落回旧偏移（审计 §2 #9 描述的那条后果）');
});

test('R2-06m2 变异：targetChanged 写死 false ⇒ 同上', function () {
  const bad = mutateModule('input',
    'const targetChanged = at.target !== null && nowTarget !== null && at.target !== nowTarget;',
    'const targetChanged = false;');
  assert.throws(function () { checkTargetChanged(bad); }, ERR_ASSERTION);
});

test('R2-06m3 变异：settleTarget 忽略当前选区 ⇒ 落回起手偏移必红', function () {
  const bad = mutateModule('input',
    '        from: hasNow ? e.from : at.from,\n'
    + '        to: hasNow ? e.to : at.to,',
    '        from: at.from,\n'
    + '        to: at.to,');
  assert.throws(function () { checkTargetChanged(bad); }, ERR_ASSERTION,
    '有当前选区时落回起手 2 而不是当前 7，第 ④ 条断言必须红');
});

// ── 文件尾：不可达条目与已知缺口（⛔ 别把这里当"已覆盖"）────────────────────
//
// ## 不可达（纯 Node，不需要真 DOM / 真 CM6 `EditorView` 也够不着）
//
// | Top 10 | 位置 | 为什么不可达 |
// |---|---|---|
// | #6 | `index.js:469`（`lineOfCaret`） | 它是 `createController()` 闭包内的局部函数，**未导出**；唯一调用点 `newParagraph()` 还要求完整的 editing 会话（`leave()` / `runTransaction()` / `begin()` / `d.pendingHost`）。纯逻辑层无法只调它，⛔ 不造整台控制器假件充数。 |
// | #7 | `index.js:567/643`（块行数/字节数上限的 `>=`） | 同样在闭包内，只有 `begin()` 拒收路径会读到；需要完整 deps 会话。 |
// | #8 | `selection.js:932/968`（多隐藏区间折叠删除 / `lineAt(-1)`） | 前半可达但不在本轮优先表；`lineAt(-1)` 分支要真 CM6 语义（`snapLineEnd` 的 DOM 侧封装）。 |
// | #4 | `preedit.js:81/49` | 组合态行为需要 CM6 `EditorView` / widget 生命周期，不在纯 Node 可达面。 |
//
// ## 已知缺口（当前源码不满足，⛔ 不写成绿色判据）
//
// | 位置 | 现象 | 证据 |
// |---|---|---|
// | `input.js:143` | `nowTarget === null`（组合目标消失）算 `targetChanged = false` ⇒ 无当前位置时 `compositionend` / `cancel` 把暂存内容写回**旧偏移**（`{from:2,to:2}`），而不是按 `lost` 丢弃。审计 §2 #9 的原文要求它"必须算 targetChanged"。 | 本文件 `R2-06` 的 harness 可直接复现：`handle({type:'compositionend',data:'新',target:null})` ⇒ `{applied:true,rebased:false}` 且发出 `from:2` 事务。 |
//
// ⚠️ **上一条 2026-11-10 复核后已降级为「不可达分支」**：产品里只有两个 `composition*` 调用点
//    （`src/main.js:3757` / `:3774`），**都显式带 `target: view.state.doc`** ⇒ `nowTarget === null`
//    在真实接线里不会出现。可触发它的只有测试或将来新写的调用方，届时才会变成真缺陷。
//    ⇒ 这一条**不是**待修 bug，⛔ 别据它开 bug 单；要防的是"新调用方漏传 target"，
//    那属于接线判据（`live-wiring` 那一族），不是这里。
