// 源码级**样式契约**：`bugs/0090` / `bugs/0091` 的行级类必须与 `live.css` 一一对应。
//
// ⭐ 为什么必须是源码级：这两条缺陷的几何真相**有一半写在 CSS 里**——
//    `decorations.js` 算得出"该给哪一行贴什么类"，但类名写错、规则缺失、
//    或者规则里偷偷写死一个 `px`，纯逻辑判据**一条都不会红**，屏幕上却会
//    "类贴上了、样式没来"（与 `bugs/0022` 的折行点同族）。
// ⚠️ 断言的取值**只认 token**（`--reader-*`）：`INV-TYPE-02` / `INV-THEME-04`
//    要求尺度单点派生，写死 px 会把"改字号时这一处不变"变成静默缺陷。
// ⚠️ 变异自测不写在这里：`bugs/0090` / `0091` §7 记录了手工变异的实跑结果
//    （改坏产品代码 ⇒ 对应判据变红 ⇒ 还原）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'styles', 'live.css'), 'utf8');
// ⭐ `design/0066`（2026-11-11）起列表的"永远紧凑 ＋ 空行照排"有一半落在**阅读态**的
//    `typography.css` 里（撤 `li > p` 段距、按 `[data-blanks]` 给空行高度）⇒ 本文件两条都读。
const TYPO = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'styles', 'typography.css'), 'utf8');
// ⚠️ 注释里本来就有 `px` 与 `padding` 字样 ⇒ 先抹掉块注释再判规则体。
function strip(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}
const CSS_CODE = strip(CSS);
const TYPO_CODE = strip(TYPO);

/**
 * 在 `code` 里找选择器 `sel` 的**全部**规则体（`live.css` / `typography.css` 都没有嵌套）。
 *
 * ⭐ 2026-11-09（`bugs/0021`）：一条规则可以是**逗号分隔的选择器表** ⇒ 按表项匹配，
 *    ⛔ 不按整串。`design/0066` 起 `cm-rmd-li-sep` 与 `cm-rmd-quote-gap` 不再共用一条。
 */
function rulesIn(code, sel) {
  const hits = [];
  let i = 0;
  while ((i = code.indexOf('{', i)) !== -1) {
    // 选择器表从**上一条规则的右花括号**之后开始。
    const 头 = code.slice(code.lastIndexOf('}', i) + 1, i);
    const sels = 头.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (sels.indexOf(sel) !== -1) hits.push({ open: i, close: code.indexOf('}', i) });
    i += 1;
  }
  return hits;
}

/** `live.css` 里选择器 `sel` 的规则数。 */
function ruleCount(sel) {
  return rulesIn(CSS_CODE, sel).length;
}

/**
 * 取**唯一**一条规则体（要求选择器恰好命中一次：改坏类名/复制一份都要在这里红）。
 */
function rule(sel) {
  const hits = rulesIn(CSS_CODE, sel);
  assert.strictEqual(hits.length, 1,
    '`' + sel + '` 的规则数 = ' + hits.length + '（要求恰好 1 条）—— 类贴上了、样式没来，或同一件事有了第二份规则');
  assert.notStrictEqual(hits[0].close, -1, '`' + sel + '` 的规则体没有闭合');
  return CSS_CODE.slice(hits[0].open + 1, hits[0].close);
}

/** `typography.css` 里选择器 `sel` 的**唯一**规则体（同 `rule()` 的口径）。 */
function typoRule(sel) {
  const hits = rulesIn(TYPO_CODE, sel);
  assert.strictEqual(hits.length, 1,
    '`' + sel + '` 在 typography.css 里的规则数 = ' + hits.length + '（要求恰好 1 条）');
  assert.notStrictEqual(hits[0].close, -1, '`' + sel + '` 的规则体没有闭合');
  return TYPO_CODE.slice(hits[0].open + 1, hits[0].close);
}

/**
 * `typography.css` 里**选择器表恰好就是 `sels` 这些项**的那一条规则体。
 * ⚠️ 一条规则用逗号同时覆盖"项与项之间"和"项内相邻块之间"两种情况是**有意**的
 *    （同一件事只有一份声明）⇒ 按整张表定位，⛔ 不按单个选择器拆开找。
 */
function typoTable(sels) {
  const 头们 = [];
  let i = 0;
  while ((i = TYPO_CODE.indexOf('{', i)) !== -1) {
    const 头 = TYPO_CODE.slice(TYPO_CODE.lastIndexOf('}', i) + 1, i);
    const 表 = 头.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (表.length === sels.length && sels.every(function (s) { return 表.indexOf(s) !== -1; })) {
      头们.push({ open: i, close: TYPO_CODE.indexOf('}', i) });
    }
    i += 1;
  }
  assert.strictEqual(头们.length, 1,
    '选择器表 `' + sels.join(', ') + '` 在 typography.css 里的规则数 = ' + 头们.length + '（要求恰好 1 条）');
  return TYPO_CODE.slice(头们[0].open + 1, 头们[0].close);
}

/** 规则体里 ⛔ 不许出现字面 px（尺度必须是 token 或 `em` 派生）。 */
function noLiteralPx(body, sel) {
  assert.ok(!/\b\d+(?:\.\d+)?px\b/.test(body),
    '`' + sel + '` 里出现字面 px —— 尺度必须由 `--reader-*` / `em` 派生（`INV-TYPE-02`）');
}

const LINE = '.cm-rmd-liveHost .cm-line.';
const CLASSES = [
  'cm-rmd-code-line',
  'cm-rmd-code-first',
  'cm-rmd-code-last',
  'cm-rmd-heading-space-before',
  'cm-rmd-heading-space-after',
];

test('五个行级类与 `live.css` 的规则**一一对应**，且不含字面 px（`bugs/0091`）', function () {
  CLASSES.forEach(function (cls) {
    const body = rule(LINE + cls);
    noLiteralPx(body, LINE + cls);
  });
});

test('内层代码行：mono / 小字号 / 代码行高 / 左右内边距 / 底色必须落在 `.cm-line` 上', function () {
  const body = rule(LINE + 'cm-rmd-code-line');
  assert.ok(/font-family:\s*var\(--reader-font-mono\)/.test(body),
    '代码行没有等宽字体 —— 阅读态 `.doc pre code` 是 mono');
  assert.ok(/font-size:\s*var\(--reader-size-small\)/.test(body),
    '代码行没有小字号 —— 阅读态是 `--reader-size-small`');
  assert.ok(/line-height:\s*var\(--reader-code-lh\)/.test(body),
    '代码行没有代码行高 —— 行高会退回宿主（引用块 1.45）');
  assert.ok(/padding-left:\s*var\(--reader-code-pad-x\)/.test(body)
    && /padding-right:\s*var\(--reader-code-pad-x\)/.test(body),
  '代码行没有左右内边距 —— 每一行都会从宿主内容盒左缘起排（实测左移 25.2 px）');
  assert.ok(/background:\s*var\(--reader-block-code-bg\)/.test(body),
    '代码行没有底色 —— 阅读态的底色住在 `pre` 上，内层搬不进来');
});

test('代码块上下内边距**整块一次**：只落首 / 末行，且⛔ 不用 `padding` 简写', function () {
  const first = rule(LINE + 'cm-rmd-code-first');
  assert.ok(/padding-top:\s*var\(--reader-code-pad-y\)/.test(first),
    '首行没有 `padding-top: var(--reader-code-pad-y)`');
  assert.ok(!/(^|[;{\s])padding\s*:/.test(first),
    '首行用了 `padding` 简写 —— 会把左右内边距一起重置');

  const last = rule(LINE + 'cm-rmd-code-last');
  assert.ok(/padding-bottom:\s*var\(--reader-code-pad-y\)/.test(last),
    '末行没有 `padding-bottom: var(--reader-code-pad-y)`');
  assert.ok(!/(^|[;{\s])padding\s*:/.test(last),
    '末行用了 `padding` 简写 —— 会把左右内边距一起重置');
});

test('标题留白只走 `padding-top` / `padding-bottom`，系数与 `.doc hN` 同源', function () {
  const before = rule(LINE + 'cm-rmd-heading-space-before');
  assert.ok(/padding-top:\s*calc\(1em \* var\(--reader-gap-heading-before\)\)/.test(before),
    '标题上留白不是「1em × --reader-gap-heading-before」—— 与 `.doc hN` 的派生式分叉了');
  assert.ok(!/(^|[;{\s])(margin|padding)\s*:/.test(before),
    '标题上留白用了简写 / 外边距 —— 行盒上外边距会折叠，间距会消失');

  const after = rule(LINE + 'cm-rmd-heading-space-after');
  assert.ok(/padding-bottom:\s*calc\(1em \* var\(--reader-gap-heading-after\)\)/.test(after),
    '标题下留白不是「1em × --reader-gap-heading-after」');
  assert.ok(!/(^|[;{\s])(margin|padding)\s*:/.test(after),
    '标题下留白用了简写 / 外边距 —— 行盒上外边距会折叠，间距会消失');
});

test('引用空行：行盒高 ＝ 段距（`--reader-gap-block`），不再是一整行（`bugs/0090`）', function () {
  const body = rule(LINE + 'cm-rmd-quote-gap');
  noLiteralPx(body, LINE + 'cm-rmd-quote-gap');
  assert.ok(/font-size:\s*0/.test(body), '空引用行必须先去掉字形高度（`font-size: 0`）');
  assert.ok(/line-height:\s*var\(--reader-gap-block\)/.test(body),
    '空引用行的行高必须**就是**段距 —— 否则两段之间会比阅读态多出 4.906 px');
});

/**
 * 模型 A 的**核心谓词**：这条规则体真的把段距撤干净了吗？
 *
 * ⚠️ 必须是"`margin: 0` **且**规则体里没有 `--reader-gap-block`"两条同时成立：
 *    只看前者的话，`margin: 0; padding-bottom: var(--reader-gap-block)` 这种
 *    "换个属性把段距加回来"的写法会静默通过。
 */
function 撤段距(body) {
  const 体 = body.trim() + ';';
  return /margin:\s*0\s*(;|$)/.test(体) && !/var\(--reader-gap-block\)/.test(body);
}

// ⭐⭐ `design/0066`（2026-11-11 用户裁定「永远是紧凑的状态，松散不存在，如果是空行，
//    就把空行展示出来」）：列表内**没有段距这一路**，`bugs/0021` / `bugs/0307` 立的两条
//    编辑态模拟类随之停用。这是**减法**——⛔ 不是"类还在、只是没人贴"：
//    规则留在 CSS 里就是一条随时会被重新接上的死代码，必须在下限处打红。
test('模型 A：段距模拟的两条行级类在 `live.css` 里**一条规则都不剩**（`design/0066` §3.3）', function () {
  ['cm-rmd-li-sep', 'cm-rmd-li-gap-after'].forEach(function (cls) {
    assert.strictEqual(ruleCount(LINE + cls), 0,
      '`' + cls + '` 仍有规则 —— 模型 A 下它不该存在（`design/0066` §3.3 是减法）');
  });
});

// ⭐ `design/0066` §2：「一行源码 = 一行版面」。撤段距必须在**阅读态**（权威侧）落地，
//    否则编辑态把空行画出来了、阅读态还按 comrak 的 loose `<p>` 加段距 ⇒ 两态高差。
//    ⚠️ 这三条规则此前完全没人测（`typography.test.js` 只测字号阶梯/行高/色板）——
//    顺手把「列表内即紧凑」钉在源码级。
test('模型 A：阅读态列表内撤段距，空行高度按 `data-blanks` 派生（`design/0066` §3.2）', function () {
  const 段 = typoRule('.doc li > p');
  assert.ok(撤段距(段),
    '`.doc li > p` 还在加段距 —— 松散列表的项距会多出 15.39 px（`design/0066` §2）');

  // 子列表贴在父项最后一段之后：`<p>` 的段距撤了，`ul/ol` 的下外边距也得撤，否则末项照样多一截。
  const 子 = typoTable(['.doc li > ul', '.doc li > ol']);
  assert.ok(/margin-bottom:\s*0\s*(;|$)/.test(子.trim() + ';'),
    '`.doc li > ul, .doc li > ol` 没有 `margin-bottom: 0` —— 父项末行下方仍会多出段距');

  // 空行高度：`data-blanks` 由 `render.rs::写空行属性` 按 `sourcepos` 写，数值由 CSS 换算。
  //  ⚠️ 选择器表里两种宿主都要有：`<li data-blanks>`（项与项之间）与
  //     `<li > [data-blanks]>`（项内相邻块之间）——缺一个就有半张列表矮。
  const 空行 = typoTable(['.doc li[data-blanks]', '.doc li > [data-blanks]']);
  noLiteralPx(空行, '.doc li[data-blanks], .doc li > [data-blanks]');
  assert.ok(/margin-top:\s*calc\(var\(--rmd-blanks,\s*0\)\s*\*\s*var\(--reader-line-height\)\s*\*\s*1em\)/.test(空行),
    '空行高度不是「n × 行高」的派生式 —— 行高改了空行不跟着改');
});

// ⚠️ 范围 A（`design/0066` §7 第 1 条）：列表**外**的块段距本次不动。
//    没有这条，上面「撤 `li > p`」很容易被顺手改成撤 `.doc p` ⇒ 全篇段落间距
//    15.39 → 23.80 px（+55 %），与 Mardo 的排版基准脱钩。
test('范围 A：列表外的 `.doc p` 段距保持 15.39 px 不变（`design/0066` §7 第 1 条）', function () {
  const 段 = typoRule('.doc p');
  assert.ok(/margin:\s*0\s+0\s+var\(--reader-gap-block\)/.test(段),
    '`.doc p` 的块段距被改掉了 —— 范围 A 只动列表内');
});

// ⭐ 变异 ③（`design/0066` §4）：把 `.doc li > p` 的段距**恢复** ⇒ 上面那条判据必须打红。
//    ⚠️ 变异跑在内存里的副本上，⛔ 不写回产品文件；判据用与产品测试**同一个** `撤段距`
//    谓词——否则"打红"可能只是变异测试自己在数别的东西。
test('变异 ③：恢复 `li > p` 的块段距，模型 A 的撤段距判据必须打红（`design/0066` §4）', function () {
  const 原 = typoRule('.doc li > p');
  const 变 = TYPO_CODE.replace(/(\.doc li > p\s*\{[^}]*?)margin:\s*0\s*;/, '$1margin: 0 0 var(--reader-gap-block);');
  assert.notStrictEqual(变, TYPO_CODE, '变异没命中 —— 谓词的前提（`.doc li > p { margin: 0 }`）与源码对不上');
  const 命中 = rulesIn(变, '.doc li > p');
  assert.strictEqual(命中.length, 1, '变异后规则数变了，谓词无法比对');
  const 变体 = 变.slice(命中[0].open + 1, 命中[0].close);
  assert.ok(/var\(--reader-gap-block\)/.test(变体) && !/margin:\s*0\s*(;|$)/.test(变体.trim() + ';'),
    '变异后的规则体与 `design/0066` §4 的"恢复段距"形态不符（变异本身没做对）');
  // 判定：变异体必须**打红**，原文件必须**通过**——两条都在才是负对照。
  assert.strictEqual(撤段距(变体), false, '变异后判据仍然通过 —— 这条断言不承重');
  assert.strictEqual(撤段距(原), true, '原文件没通过谓词 —— 变异测试没有对照组');
});

