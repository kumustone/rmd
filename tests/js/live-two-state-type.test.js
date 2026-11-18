// `design/0085`（2026-11-15 用户「批准这份设计」）：两态排版的**甲类四条**里
// 有三条的真相有一半写在样式表里 —— 纯逻辑判据碰不到"类贴上了、规则没来 / 写死了 px"。
//
// # 这一份钉什么
//
// | 条目 | 判据 |
// |---|---|
// | **C5** 标题字色 | `.cm-rmd-h1`–`.cm-rmd-h6` 六条规则都必须给 `color: var(--reader-heading)`；`live/box.js` 那句"标题与正文同色"的**错注释**不许回来 |
// | **C4** 嵌套引用 | `[data-rmd-qdepth="1"/"2"/"3"]` 各恰好一条规则，几何全走 `--reader-quote-*`；引用里的代码行另有一条**求和**规则（同一个 `padding-left`，两条叠加不了） |
// | **C3** 引用空行 | `typography.css` 里引用语境的 `[data-blanks]` 乘 `--reader-quote-lh`，⛔ 不是全局 `--reader-line-height` |
//
// ⚠️ 尺度一律只认 token（`INV-TYPE-02`）：写死 `17.5px` 这类值会把"改字号时这一处不变"
//    变成静默缺陷，而屏幕上只表现为"进出编辑态差半个字"。
// ⚠️ 变异自测在最后：判据喂给"写坏的副本"必须变红（`tests.md`：没做过变异测试的断言不算数）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const 源 = {
  live: fs.readFileSync(path.join(ROOT, 'src', 'styles', 'live.css'), 'utf8'),
  typo: fs.readFileSync(path.join(ROOT, 'src', 'styles', 'typography.css'), 'utf8'),
  deco: fs.readFileSync(path.join(ROOT, 'src', 'live', 'decorations.js'), 'utf8'),
  box: fs.readFileSync(path.join(ROOT, 'src', 'live', 'box.js'), 'utf8'),
};

/** 抹掉块注释（判据看的是**声明**，⛔ 不是历史注释里的数字与说法）。 */
function strip(css) {
  return String(css).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

/** 选择器表里含 `sel` 的全部规则体。 */
function bodies(css, sel) {
  const code = strip(css);
  const out = [];
  let i = 0;
  while ((i = code.indexOf('{', i)) !== -1) {
    const 头 = code.slice(code.lastIndexOf('}', i) + 1, i);
    const 表 = 头.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (表.indexOf(sel) !== -1) out.push(code.slice(i + 1, code.indexOf('}', i)));
    i += 1;
  }
  return out;
}

/** 规则体里不许出现字面 px（尺度必须由 token 派生）。 */
function 有字面px(body) {
  return /\b\d+(?:\.\d+)?px\b/.test(body);
}

const LINE = '.cm-rmd-liveHost .cm-line';

/**
 * 全部判据合成一个函数，返回违规列表（空 = 全绿）。
 * ⚠️ 变异自测靠它——⛔ 别把判据只写在 `assert` 里，那样"写坏了哪条"分不出来。
 * @param {{live: string, typo: string, deco: string, box: string}} s
 * @returns {string[]}
 */
function 检查(s) {
  const bad = [];

  // ── C5：六条标题规则都要给字色，且值是阅读态那一个 token ──
  for (let n = 1; n <= 6; n++) {
    const sel = LINE + '.cm-rmd-h' + n;
    const 体 = bodies(s.live, sel);
    if (体.length !== 1) { bad.push('`' + sel + '` 的规则数 = ' + 体.length + '（要求恰好 1 条）'); continue; }
    if (!/color:\s*var\(--reader-heading\)/.test(体[0])) {
      bad.push('`' + sel + '` 没有 `color: var(--reader-heading)` ⇒ 编辑态标题比阅读态浅一档');
    }
  }
  // ⚠️ 那句错注释是这条缺陷的**来源**（`bugs/0113` C5 的成因之一）：它写着"标题与正文同色"，
  //    下一个人照着它就会把上面那条 `color` 删掉。
  //    ⇒ 允许它**被否定地引用**（`⛔ 别…` 那一句），⛔ 不许作为结论出现。
  s.box.split('\n').forEach(function (行) {
    if (行.indexOf('标题与正文同色') === -1) return;
    if (/(⛔|别|不是)/.test(行)) return;
    bad.push('`live/box.js` 里"标题与正文同色"的旧说法又回来了（与 `typography.css:63` 相反）');
  });

  // ── C4：三层引用盒 + 引用里的代码行求和 ──
  for (let n = 1; n <= 3; n++) {
    const sel = LINE + '[data-rmd-qdepth="' + n + '"]';
    const 体 = bodies(s.live, sel);
    if (体.length !== 1) { bad.push('`' + sel + '` 的规则数 = ' + 体.length + '（要求恰好 1 条）'); continue; }
    // 第 1 层就是阅读态那一条，⛔ 不写 `× 1`；第 2、3 层才乘层数。
    const 条 = n === 1
      ? /border-left:\s*var\(--reader-quote-bar-width\)\s+solid\s+var\(--reader-quote-bar-color\)/
      : new RegExp('border-left:\\s*calc\\(var\\(--reader-quote-bar-width\\) \\* ' + n
        + '\\)\\s+solid\\s+var\\(--reader-quote-bar-color\\)');
    if (!条.test(体[0])) {
      bad.push('`' + sel + '` 的竖线不是 `--reader-quote-bar-width` × ' + n + ' / `--reader-quote-bar-color`');
    }
    if (!/padding-left:\s*calc\(var\(--reader-font-size\) \* var\(--reader-quote-pad-x-factor\)/.test(体[0])) {
      bad.push('`' + sel + '` 的让位不是 `--reader-font-size` × `--reader-quote-pad-x-factor`');
    }
    if (有字面px(体[0])) bad.push('`' + sel + '` 里写死了 px');
  }
  for (let n = 1; n <= 3; n++) {
    const sel = LINE + '.cm-rmd-code-line[data-rmd-qdepth="' + n + '"]';
    const 体 = bodies(s.live, sel);
    if (体.length !== 1) { bad.push('`' + sel + '` 的规则数 = ' + 体.length + '（要求恰好 1 条）'); continue; }
    if (!/padding-left:\s*calc\([^;]*var\(--reader-quote-pad-x-factor\)[^;]*var\(--reader-code-pad-x\)/.test(体[0])) {
      bad.push('`' + sel + '` 没有把引用让位与 `--reader-code-pad-x` **求和** ⇒ 代码行的左内边距会被整条覆盖');
    }
    if (有字面px(体[0])) bad.push('`' + sel + '` 里写死了 px');
  }
  // 装饰层真的挂了这个属性（⛔ 不是只写了 CSS 没人用）。
  if (s.deco.indexOf("'data-rmd-qdepth'") === -1) bad.push('`decorations.js` 没有产出 `data-rmd-qdepth`');
  // ⚠️ 行级盒子的几何必须留在样式表里：若改成行内 `style`，它会和列表行的 `margin-left`
  //    在 CM6 合并属性时**互相整串覆盖**（缩进当场丢）。
  if (/quoteDeco[\s\S]{0,400}?style:/.test(s.deco)) {
    bad.push('`quoteDeco` 写了行内 `style` —— 会覆盖列表行的 `margin-left`');
  }

  // ── C3：引用语境的空行按 `--reader-quote-lh` ──
  const 引用空行 = bodies(s.typo, '.doc blockquote li[data-blanks]');
  if (引用空行.length !== 1) {
    bad.push('`typography.css` 里引用语境的 `[data-blanks]` 规则数 = ' + 引用空行.length + '（要求恰好 1 条）');
  } else if (!/margin-top:\s*calc\(var\(--rmd-blanks, 0\) \* var\(--reader-quote-lh\) \* 1em\)/.test(引用空行[0])) {
    bad.push('引用里的空行没有按 `--reader-quote-lh` 取行高（会用到全局 `--reader-line-height`）');
  }
  // 编辑态那一半：两侧都是列表行时⛔ 不许进 `quoteGapLines`。
  if (s.deco.indexOf('两侧列表') === -1) {
    bad.push('`decorations.js` 没有"两侧都是列表行 ⇒ 不按段距"的判据（`bugs/0318` 的编辑态那一半）');
  }

  return bad;
}

test('甲类四条（C5 / C4 / C3）的样式面必须与设计一致（`design/0085`）', function () {
  assert.deepStrictEqual(检查(源), []);
});

test('⭐ 变异自测：写坏一处必须让对应判据变红（先证明改到了）', function () {
  // M1：删掉一条标题字色（`bugs/0113` C5 原样打回）
  const m1 = Object.assign({}, 源, {
    live: 源.live.replace('  color: var(--reader-heading);\n  font-size: var(--reader-size-h2);',
      '  font-size: var(--reader-size-h2);'),
  });
  assert.notStrictEqual(m1.live, 源.live, 'M1 没改到');
  assert.ok(检查(m1).some(function (b) { return b.indexOf('cm-rmd-h2') >= 0; }), 'M1 没红');

  // M2：把引用让位换成字面 px（"14px 看着刚好"那一族）
  const m2 = Object.assign({}, 源, {
    live: 源.live.replace(
      '  padding-left: calc(var(--reader-font-size) * var(--reader-quote-pad-x-factor));',
      '  padding-left: 17.5px;'),
  });
  assert.notStrictEqual(m2.live, 源.live, 'M2 没改到');
  assert.ok(检查(m2).some(function (b) { return b.indexOf('写死了 px') >= 0; }), 'M2 没红');

  // M3：删掉第二层的规则（两层引用只剩一层竖线）
  const m3 = Object.assign({}, 源, {
    live: 源.live.replace(LINE + '[data-rmd-qdepth="2"]', LINE + '[data-rmd-qdepth="9"]'),
  });
  assert.notStrictEqual(m3.live, 源.live, 'M3 没改到');
  assert.ok(检查(m3).some(function (b) { return b.indexOf('qdepth="2"') >= 0; }), 'M3 没红');

  // M4：代码行的合并规则退化成"只有引用让位"（代码左内边距被整条覆盖）
  const m4 = Object.assign({}, 源, {
    live: 源.live.replace(
      '  padding-left: calc(var(--reader-font-size) * var(--reader-quote-pad-x-factor) * 2\n                     + var(--reader-code-pad-x));',
      '  padding-left: calc(var(--reader-font-size) * var(--reader-quote-pad-x-factor) * 2);'),
  });
  assert.notStrictEqual(m4.live, 源.live, 'M4 没改到');
  assert.ok(检查(m4).some(function (b) { return b.indexOf('求和') >= 0; }), 'M4 没红');

  // M5：阅读态那一半退回全局行高（`bugs/0318` 的原样）
  const m5 = Object.assign({}, 源, {
    typo: 源.typo.replace('calc(var(--rmd-blanks, 0) * var(--reader-quote-lh) * 1em)',
      'calc(var(--rmd-blanks, 0) * var(--reader-line-height) * 1em)'),
  });
  assert.notStrictEqual(m5.typo, 源.typo, 'M5 没改到');
  assert.ok(检查(m5).some(function (b) { return b.indexOf('quote-lh') >= 0; }), 'M5 没红');

  // M6：删掉编辑态那条"两侧是列表行"的分叉（空行又按段距排）
  const m6 = Object.assign({}, 源, { deco: 源.deco.replace(/两侧列表/g, '两侧是列表行') });
  assert.notStrictEqual(m6.deco, 源.deco, 'M6 没改到');
  assert.ok(检查(m6).some(function (b) { return b.indexOf('bugs/0318') >= 0; }), 'M6 没红');
});
