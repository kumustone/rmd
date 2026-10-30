// `design/0052` U4：**行内呈现**该贴哪个类（`src/live/decorations.js::markers().inline`）。
//
// ⚠️ 这一份测的是**纯逻辑**：给定源码 ＋ 语法树，算出"哪一段该带哪个类"。
//    真正的 `Decoration.mark` 有没有落到 DOM 上，归 `make probe-live-block`（O 段逐行 oracle）。
//
// ⭐ 为什么它值得单独一份判据：`bugs/0022`（编辑态与渲染态**折行位置不同**）的根因就是
//    行内代码在渲染态是等宽＋有内边距、编辑态是正文字体 —— 折行差**加多少几何 slack 都堵不住**。
//    这里钉住"该贴的类"，几何那边才谈得上对齐。
//
// ⚠️ 三类错在屏幕上都不报错：① 类名与 `live.css` 漂开（贴了个没有规则的类 ⇒ 静默无样式）；
//    ② 围栏里的 `**` 被当成强调（代码块被上色）；③ 活动行把样式一起做掉（用户改字时字重乱跳）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../../src/live/decorations.js');
const { markdownLanguage } = require('@codemirror/lang-markdown');

function parse(text) {
  return markdownLanguage.parser.parse(String(text));
}

/** `markers()` ＋ 自动补树（与 `live-decorations.test.js` 同口径）。 */
function plan(text, opts) {
  const o = Object.assign({}, opts);
  if (!o.tree) o.tree = parse(text);
  return D.markers(text, o);
}

/** `inline` 摊平成 `类名@字面`，便于断言（顺带验证区间不越界）。 */
function marks(text, opts) {
  return plan(text, opts).inline.map(function (m) {
    assert.ok(m.to > m.from && m.from >= 0 && m.to <= text.length, '非法行内区间 ' + JSON.stringify(m));
    return m.cls + '@' + text.slice(m.from, m.to);
  });
}

test('强调 / 删除线 / 行内代码：类名与区间逐字对得上', function () {
  assert.deepStrictEqual(marks('这是 **粗体** 文本'), ['cm-rmd-strong@**粗体**']);
  assert.deepStrictEqual(marks('这是 *斜体* 文本'), ['cm-rmd-em@*斜体*']);
  assert.deepStrictEqual(marks('这是 __粗__ 与 _斜_'), ['cm-rmd-strong@__粗__', 'cm-rmd-em@_斜_']);
  assert.deepStrictEqual(marks('这是 ~~删~~ 文本'), ['cm-rmd-strike@~~删~~']);
  // ⚠️ 行内代码贴的是**整个节点**（含两端反引号）：活动行上那对反引号也要等宽，
  //    否则用户点进去的一瞬间字宽就变了（那正是 `bugs/0022` 的形态）。
  assert.deepStrictEqual(marks('用 `code` 表示'), ['cm-rmd-code@`code`']);
});

test('链接：整段（含 `](url)`）带链接色；⛔ 图片的 alt 不带', function () {
  assert.deepStrictEqual(marks('[文字](http://x)'), ['cm-rmd-link@[文字](http://x)']);
  // ⚠️ **有意**不给 `Image` 贴类：渲染态显示的是图片本身，给 alt 上链接色会让人
  //    以为 alt 文字在渲染态也看得见。
  assert.deepStrictEqual(marks('前 ![图](a.png) 后'), []);
});

test('嵌套：`***x***` 同时是强调与强强调（两条各留各的）', function () {
  // ⚠️ 实测形状：外层 `Emphasis` 罩**整串** `***x***`，内层 `StrongEmphasis` 罩 `**x**`
  //    ⇒ 两个类各在自己的区间上，CSS 叠起来就是"粗 + 斜"。
  const got = marks('***x***').sort();
  assert.deepStrictEqual(got, ['cm-rmd-em@***x***', 'cm-rmd-strong@**x**'].sort());
});

test('⭐ 围栏里面**一个类都不贴**（代码块里的 `**` 是内容）', function () {
  const src = ['```rust', 'let a = **b**;', '// `c` 与 [d](e)', '```'].join('\n');
  assert.deepStrictEqual(plan(src).inline, []);
});

test('⭐ 行内类**不受活动行影响**：活动的意思是"标记不藏"，⛔ 不是"样式作废"', function () {
  assert.deepStrictEqual(marks('这是 **粗体**', { activeLines: [0] }), ['cm-rmd-strong@**粗体**']);
  // ⚠️ 反面：同一行上"藏标记"那一半确实被活动行取消了（两条判据互相独立）
  assert.deepStrictEqual(plan('这是 **粗体**', { activeLines: [0] }).ranges, []);
  assert.deepStrictEqual(plan('这是 **粗体**').ranges.length, 2);
});

test('⚠️ 没有树就没有行内类（与"什么都不藏"同一条可见降级）', function () {
  assert.deepStrictEqual(D.markers('这是 **粗体**').inline, []);
  assert.deepStrictEqual(D.markers('这是 **粗体**', { tree: null }).inline, []);
});

test('⭐ 接线：`createField` 必须把行内类交给 `Decoration.mark`（没接线等于没做）', function () {
  const marks2 = [];
  const CM6 = {
    Decoration: {
      replace: function () { return { range: function (f, t) { return { from: f, to: t }; } }; },
      line: function (spec) { return { cls: spec.class, range: function (f) { return { from: f, to: f, cls: spec.class }; } }; },
      mark: function (spec) {
        marks2.push(spec.class);
        return { cls: spec.class, range: function (f, t) { return { from: f, to: t, mark: spec.class }; } };
      },
      set: function (decos) { return { size: decos.length, decos: decos }; },
    },
    StateField: { define: function (spec) { return spec; } },
    syntaxTree: function (state) { return (state && state.tree) || null; },
    ensureSyntaxTree: function (state) { return (state && state.tree) || null; },
    EditorView: { decorations: { from: function (f) { return { facetFrom: f }; } } },
  };
  const text = '这是 **粗体** 与 `code`';
  const state = { doc: { toString: function () { return text; } }, selection: {}, tree: parse(text) };
  const field = D.createField(CM6, { activeLineIndexes: function () { return []; } })[0];
  const built = field.create(state);
  assert.deepStrictEqual(marks2, ['cm-rmd-strong', 'cm-rmd-code'], '两个类都要真的被 `Decoration.mark` 建出来');
  const got = built.decos.filter(function (d) { return d.mark; });
  assert.deepStrictEqual(got.map(function (d) { return d.mark; }), ['cm-rmd-strong', 'cm-rmd-code']);
});

// ⭐⭐ 类名与样式表**逐字对应**：贴了个 `live.css` 里没有的类 ⇒ 静默无样式，
//    而任何逻辑判据都绿（`markers()` 算得对，只是没人给它写规则）。
test('⭐ `live.css` 里五条行内规则都在，且**只引用 `--reader-*`**（⛔ 无字面色 / 无 px）', function () {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'styles', 'live.css'), 'utf8');
  const 产出 = new Set();
  ['**a**', '*a*', '~~a~~', '`a`', '[a](b)'].forEach(function (s) {
    plan(s).inline.forEach(function (m) { 产出.add(m.cls); });
  });
  assert.deepStrictEqual([...产出].sort(), ['cm-rmd-code', 'cm-rmd-em', 'cm-rmd-link', 'cm-rmd-strike', 'cm-rmd-strong'],
    '产品产出的类变了？下面那张表与断言要同批改');
  [...产出].forEach(function (cls) {
    const m = new RegExp('\\.' + cls + '\\s*\\{([^}]*)\\}').exec(css);
    assert.ok(m, '⛔ `live.css` 里没有 .' + cls + ' 的规则 —— 贴了类却没有样式，屏幕上什么都不变');
    const body = m[1];
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b/, cls + ' 里写了字面色值（`INV-THEME-02`）');
    assert.doesNotMatch(body, /\b(?:rgba?|hsla?)\(/, cls + ' 里写了字面色值（`INV-THEME-02`）');
    assert.doesNotMatch(body, /\b\d+(?:\.\d+)?px\b/, cls + ' 里写了绝对像素（`INV-THEME-04`：主题只改颜色、不改尺度）');
  });
});
