// `design/0079`（行号 / 专注模式 / 画布缩放）的**纯逻辑 + 源码级**闸门。
//
// ⭐ 为什么这三项都要有源码级判据：
//   它们的失效形态大多**不报错**——
//   ① 行号如果在前端另解析一遍 Markdown，阅读态与编辑态的"第几行"就会有两套真相
//      （`INV-SINGLE-01` / `INV-VIEW-01`）；
//   ② 专注模式多一条 `classList.add('zen')` 的路，`Esc` / 菜单 / 快捷键就可能各自记状态，
//      退出时只收回一半外壳；再有一条 `body.zen .topbar` 就会把降级 / 陈旧提示带一起吞掉
//      （`INV-CHROME-01` / `INV-EXT-04`）；
//   ③ 缩放如果写成任意倍数或没有边界，"再按一次"会跳档 / 越界，而屏幕上只是"好像没动"。
//
// ⚠️ 判据对**注释免疫**：本仓注释里大量出现"⛔ 别写成 X"这种原文，
//    直接 grep 会把**正确的注释**判成缺陷 ⇒ 先挖空注释再判。
// ⚠️ 变异自测：同一套判据喂给"故意写坏的副本"必须变红；纯逻辑那半也在
//    `vm` 里改源码再执行一次（⛔ 不是只对产品源码做一次断言）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const read = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };

const VS_SRC = read('src/services/viewstate.js');
const MAIN_SRC = read('src/main.js');
const CSS_SRC = read('src/style.css');
const RUST_SRC = read('src-tauri/src/gui/mod.rs');
const HTML_SRC = read('src/index.html');

// ────────────────────────────────────────────────────────────────
// 源码预处理：挖空注释（保守实现与 `chrome.test.js` 同形）
// ────────────────────────────────────────────────────────────────

function stripBlockComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

function stripLineComments(src) {
  return String(src).split('\n').map(function (line) {
    const i = line.indexOf('//');
    if (i < 0) return line;
    const before = line.slice(0, i);
    const quotes = (before.match(/["']/g) || []).length;
    if (quotes % 2 === 1) return line;
    return before;
  }).join('\n');
}

const CSS_CODE = stripBlockComments(CSS_SRC);
const MAIN_CODE = stripLineComments(stripBlockComments(MAIN_SRC));
const RUST_CODE = stripLineComments(RUST_SRC);

// ────────────────────────────────────────────────────────────────
// `viewstate.js` 的加载器（产品源码与变异副本走同一个入口）
// ────────────────────────────────────────────────────────────────

function loadViewstate(src) {
  const sandbox = { module: { exports: {} }, window: {} };
  vm.runInNewContext(src, sandbox, { filename: 'viewstate.js' });
  return sandbox.module.exports;
}

const VS = loadViewstate(VS_SRC);

/** 断言变异真的改到了靶子（"没改到"与"判据不敏感"的输出必须分得开）。 */
function mutate(src, from, to) {
  assert.ok(src.indexOf(from) >= 0, '变异靶子不存在：' + from);
  const out = src.replace(from, to);
  assert.notStrictEqual(out, src, '变异没有改动源码：' + from);
  return out;
}

/** 替换第 `n` 处（0-based）。⚠️ `setChromeHidden` 与 `setZen` 有同形的守卫，靶子必须点名。 */
function mutateNth(src, from, to, n) {
  let idx = -1;
  for (let i = 0; i <= n; i++) {
    idx = src.indexOf(from, idx + 1);
    assert.ok(idx >= 0, '变异靶子第 ' + n + ' 处不存在：' + from);
  }
  return src.slice(0, idx) + to + src.slice(idx + from.length);
}

function fakeDoc() {
  const classes = new Set();
  return {
    classList: {
      toggle: function (name, on) {
        if (on) classes.add(name); else classes.delete(name);
      },
      contains: function (name) { return classes.has(name); },
    },
  };
}

function fakeNode(type, attrs) {
  return {
    nodeType: type,
    attrs: Object.assign({}, attrs || {}),
    setAttribute: function (k, v) { this.attrs[k] = v; },
    removeAttribute: function (k) { delete this.attrs[k]; },
  };
}

// ────────────────────────────────────────────────────────────────
// ① 缩放：档位是闭集，边界夹取，不循环
// ────────────────────────────────────────────────────────────────

test('缩放档位：升序、唯一、含实际大小，上下界就是两端', function () {
  const levels = VS.ZOOM_LEVELS;
  assert.deepStrictEqual(Array.from(levels), [50, 67, 80, 90, 100, 110, 125, 150, 175, 200]);
  for (let i = 1; i < levels.length; i++) {
    assert.ok(levels[i] > levels[i - 1], '档位不是升序：' + levels.join(','));
  }
  assert.strictEqual(new Set(levels).size, levels.length);
  assert.strictEqual(VS.ZOOM_MIN, 50);
  assert.strictEqual(VS.ZOOM_MAX, 200);
  assert.strictEqual(VS.ZOOM_ACTUAL, 100);
  assert.ok(levels.indexOf(VS.ZOOM_ACTUAL) >= 0);
});

test('normalizeZoom：夹取到上下界、就近一档、平局取小、坏输入回 100', function () {
  assert.strictEqual(VS.normalizeZoom(100), 100);
  assert.strictEqual(VS.normalizeZoom(49), 50);
  assert.strictEqual(VS.normalizeZoom(-1000), 50);
  assert.strictEqual(VS.normalizeZoom(9999), 200);
  assert.strictEqual(VS.normalizeZoom(73), 67);   // 67 差 6，80 差 7
  assert.strictEqual(VS.normalizeZoom(74), 80);   // 67 差 7，80 差 6
  assert.strictEqual(VS.normalizeZoom(73.5), 67); // 平局取较小一档
  assert.strictEqual(VS.normalizeZoom(NaN), 100);
  assert.strictEqual(VS.normalizeZoom(undefined), 100);
  assert.strictEqual(VS.normalizeZoom('not-a-number'), 100);
});

test('zoomNext：逐档走、到边界停住、方向 0 / 坏值原样', function () {
  assert.strictEqual(VS.zoomNext(100, 1), 110);
  assert.strictEqual(VS.zoomNext(100, -1), 90);
  assert.strictEqual(VS.zoomNext(67, 1), 80);
  assert.strictEqual(VS.zoomNext(175, -1), 150);
  assert.strictEqual(VS.zoomNext(VS.ZOOM_MIN, -1), 50, '下限必须停住，⛔ 不循环');
  assert.strictEqual(VS.zoomNext(VS.ZOOM_MAX, 1), 200, '上限必须停住，⛔ 不循环');
  assert.strictEqual(VS.zoomNext(100, 0), 100);
  assert.strictEqual(VS.zoomNext(100, NaN), 100);
  assert.strictEqual(VS.zoomNext(NaN, 1), 110, '当前值坏掉时先归一到 100 再走一档');
});

test('zoomScale：百分比 → CSS zoom 倍数', function () {
  assert.strictEqual(VS.zoomScale(100), 1);
  assert.strictEqual(VS.zoomScale(50), 0.5);
  assert.strictEqual(VS.zoomScale(200), 2);
  assert.strictEqual(VS.zoomScale(NaN), 1);
});

// ────────────────────────────────────────────────────────────────
// ② 行号：只标顶层块首行；数据只来自对齐后的块表
// ────────────────────────────────────────────────────────────────

test('linePlan：只收元素节点的顶层块首行，脚注 / 注释 / 坏行号跳过', function () {
  const p1 = fakeNode(1);
  const p2 = fakeNode(1);
  const p3 = fakeNode(1);
  const comment = fakeNode(8);
  const plan = VS.linePlan([
    { block: { kind: 'Paragraph', startLine: 1 }, node: p1 },
    { block: { kind: 'HtmlBlock', startLine: 3 }, node: comment },
    { block: { kind: 'FootnoteDefinition', startLine: 9 }, node: p2 },
    { block: { kind: 'Heading', startLine: 5 }, node: p3 },
    { block: { kind: 'Paragraph', startLine: 0 }, node: fakeNode(1) },
    { block: { kind: 'Paragraph', startLine: 1.5 }, node: fakeNode(1) },
    { block: { kind: 'Paragraph', startLine: '7' }, node: fakeNode(1) },
    null,
    { block: null, node: fakeNode(1) },
    { block: { kind: 'Paragraph', startLine: 8 }, node: null },
  ]);
  assert.deepStrictEqual(Array.from(plan, function (x) { return x.line; }), [1, 5]);
  assert.strictEqual(plan[0].node, p1);
  assert.strictEqual(plan[1].node, p3);
});

test('linePlan：空输入 / 非数组不抛，回空表', function () {
  assert.deepStrictEqual(Array.from(VS.linePlan([])), []);
  assert.deepStrictEqual(Array.from(VS.linePlan(null)), []);
  assert.deepStrictEqual(Array.from(VS.linePlan(undefined)), []);
});

test('applyLineNumbers：开写属性与 class，关全部撤掉；严格 === true；注释节点不碰', function () {
  const doc = fakeDoc();
  const a = fakeNode(1);
  const b = fakeNode(1);
  const comment = fakeNode(8);
  const plan = [{ node: a, line: 3 }, { node: comment, line: 4 }, { node: b, line: 12 }];

  VS.applyLineNumbers(doc, plan, true);
  assert.strictEqual(doc.classList.contains('doc-lines'), true);
  assert.strictEqual(a.attrs['data-rmd-line'], '3');
  assert.strictEqual(b.attrs['data-rmd-line'], '12');
  assert.strictEqual(comment.attrs['data-rmd-line'], undefined);

  VS.applyLineNumbers(doc, plan, false);
  assert.strictEqual(doc.classList.contains('doc-lines'), false);
  assert.strictEqual(a.attrs['data-rmd-line'], undefined);
  assert.strictEqual(b.attrs['data-rmd-line'], undefined);

  VS.applyLineNumbers(doc, plan, 'true');
  assert.strictEqual(doc.classList.contains('doc-lines'), false, '字符串 "true" ⛔ 不能当开');
  assert.strictEqual(a.attrs['data-rmd-line'], undefined);

  assert.doesNotThrow(function () { VS.applyLineNumbers(null, plan, true); });
});

// ────────────────────────────────────────────────────────────────
// ③ 源码级：线号落点、Zen 单状态、缩放接线、菜单 / 快捷键表
// ────────────────────────────────────────────────────────────────

function score(s) {
  const bad = [];

  // 行号样式：伪元素画在块左侧，⛔ 不改块数
  if (!/\.doc\.doc-lines\s+\[data-rmd-line\]::before\s*\{[^}]*content:\s*attr\(\s*data-rmd-line\s*\)/.test(s.css)) {
    bad.push('style.css 没有 `.doc.doc-lines [data-rmd-line]::before { content: attr(data-rmd-line) }`');
  }
  if (!/\.doc\.doc-lines\s+\[data-rmd-line\]\s*\{[^}]*position:\s*relative/.test(s.css)) {
    bad.push('行号伪元素没有 `position: relative` 的块级参照（会跑到页面左上角）');
  }

  // 缩放：只走 `#doc` 的 CSS 变量
  if (!/\.doc\s*\{[^}]*zoom:\s*var\(\s*--rmd-canvas-zoom\s*,\s*1\s*\)/.test(s.css)) {
    bad.push('`.doc` 没有消费 `--rmd-canvas-zoom`（缩放没有落点）');
  }

  // 专注：侧边栏让位；⛔ 不许一刀切 `.topbar`
  if (!/body\.zen\s+\.sidebar\s*\{[^}]*left:\s*-30000px/.test(s.css)) {
    bad.push('`body.zen .sidebar` 没有让位（侧边栏会继续占宽）');
  }
  if (/body\.zen\s+\.topbar\b/.test(s.css)) {
    bad.push('`body.zen` 一刀切藏了 `.topbar` —— 降级 / 陈旧提示带会跟着消失');
  }
  if (!/body\.zen\s+\.toolbar\s*,[\s\S]{0,120}?body\.zen\s+\.status/.test(s.css)) {
    bad.push('`body.zen` 没有点名 `.toolbar` / `.status`');
  }

  // Zen 只有一个写入口；编辑态拒绝；进编辑态先退出
  const zenToggles = (s.js.match(/classList\.toggle\(\s*'zen'/g) || []).length;
  if (zenToggles !== 1) {
    bad.push('`zen` 的 classList.toggle 出现 ' + zenToggles + ' 次（应恰好 1 次：唯一写入口）');
  }
  // ⚠️ 必须**落在 setZen 里**：`setChromeHidden` 有一条一模一样的守卫，
  //    只按全文件 grep 的话，删掉 setZen 那条它照样绿（本次变异自测真踩到）。
  const zenAt = s.js.indexOf('function setZen');
  const zenBlk = zenAt >= 0 ? s.js.slice(zenAt, zenAt + 260) : '';
  if (!/if\s*\(on\s*&&\s*editing\)\s*return;/.test(zenBlk)) {
    bad.push('setZen 没有"编辑态拒绝进入"那条');
  }
  if (!/document\.body\.classList\.add\('editing'\);[\s\S]{0,500}?setZen\(false\);/.test(s.js)) {
    bad.push('enterEdit 没有退出专注（编辑态会缺可见退出入口）');
  }

  // 行号数据链路：后端块表 → 解包 → 对齐；⛔ 前端另解析
  if (!/const VS = window\.rmd\.viewstate;/.test(s.js)) bad.push('main.js 没有加载期取 `window.rmd.viewstate`');
  const planAt = s.js.indexOf('function refreshLinePlan');
  const planBlk = planAt >= 0 ? s.js.slice(planAt, planAt + 900) : '';
  if (!/LB\.fromPayload/.test(planBlk) || !/LB\.topNodes/.test(planBlk) || !/LB\.align/.test(planBlk)) {
    bad.push('refreshLinePlan 没有走 fromPayload → topNodes → align（行号可能成了第二套解析）');
  }
  if (!/doc\.innerHTML = payload\.html;[\s\S]{0,400}?refreshLinePlan\(payload\);[\s\S]{0,120}?applyLineNumbersNow\(\)/.test(s.js)) {
    bad.push('挂载后没有在新 DOM 上重算并应用行号');
  }
  if (!/parsed\.issues\.length > 0[\s\S]{0,120}?docLinePlan = \[\]/.test(s.js)) {
    bad.push('解包有 issue 时没有整篇禁用行号');
  }

  // 五个前端 handler 一个不少
  ['view.toggle-line-numbers', 'view.toggle-zen', 'view.zoom-actual', 'view.zoom-in', 'view.zoom-out']
    .forEach(function (id) {
      const re = new RegExp("keymap\\.register\\(\\s*'" + id.replace(/\./g, '\\.') + "'");
      if (!re.test(s.js)) bad.push('main.js 没有注册 ' + id + '（菜单项会按下去没反应）');
    });

  // Rust 唯一表：五个 id 都在、owner = Web、accel 与设计一致
  const want = [
    ['view.toggle-line-numbers', 'Ctrl+Cmd+L'],
    ['view.toggle-zen', 'Ctrl+Cmd+Z'],
    ['view.zoom-actual', 'Ctrl+Cmd+0'],
    ['view.zoom-in', 'Ctrl+Cmd+='],
    ['view.zoom-out', 'Ctrl+Cmd+-'],
  ];
  want.forEach(function (pair) {
    const at = s.rust.indexOf('id: "' + pair[0] + '"');
    if (at < 0) { bad.push('SHORTCUTS 里没有 ' + pair[0]); return; }
    const blk = s.rust.slice(at, at + 300);
    if (!/owner:\s*Owner::Web/.test(blk)) bad.push(pair[0] + ' 的 owner 必须是 Web（动作与状态都在前端）');
    if (blk.indexOf('accel: "' + pair[1] + '"') < 0) bad.push(pair[0] + ' 的 accel 与设计不一致：' + pair[1]);
  });

  // `index.html`：viewstate 必须先于 main
  // ⚠️ 认 `<script src="main.js">` 这个**标签**，⛔ 不认 `main.js` 这个词——
  //    它在这份文件的大段注释里出现过，按词找会把注释行当成加载顺序。
  const vsAt = s.html.indexOf('src="services/viewstate.js"');
  const mainAt = s.html.indexOf('src="main.js"');
  if (!(vsAt >= 0 && mainAt >= 0 && vsAt < mainAt)) {
    bad.push('index.html 里 services/viewstate.js 必须排在 main.js 之前（加载期取值）');
  }

  return bad;
}

test('⭐ 产品源码满足 `design/0079` 的全部结构判据', function () {
  const bad = score({ js: MAIN_CODE, css: CSS_CODE, rust: RUST_CODE, html: HTML_SRC });
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});

// ────────────────────────────────────────────────────────────────
// ④ 变异自测（源码级）
// ────────────────────────────────────────────────────────────────

test('⭐ 源码级变异自测：写坏一处必须让对应判据变红', function () {
  const base = { js: MAIN_CODE, css: CSS_CODE, rust: RUST_CODE, html: HTML_SRC };
  assert.deepStrictEqual(score(base), [], '基线必须先全绿');

  // 1. 行号伪元素没了
  const m1 = score(Object.assign({}, base, {
    css: mutate(base.css, 'content: attr(data-rmd-line)', 'content: none'),
  }));
  assert.ok(m1.some(function (x) { return x.indexOf('content: attr') >= 0; }), m1.join('\n'));

  // 2. 专注一刀切吞掉 `.topbar`
  const m2 = score(Object.assign({}, base, {
    css: base.css + '\nbody.zen .topbar { display: none; }\n',
  }));
  assert.ok(m2.some(function (x) { return x.indexOf('一刀切') >= 0; }), m2.join('\n'));

  // 3. 第二条直接改 `zen` class 的路（唯一写入口破了）
  const m3 = score(Object.assign({}, base, {
    js: base.js + "\ndocument.body.classList.toggle('zen', true);\n",
  }));
  assert.ok(m3.some(function (x) { return x.indexOf('唯一写入口') >= 0; }), m3.join('\n'));

  // 4. 编辑态不再拒绝专注（⚠️ 第二处：第一处是 `setChromeHidden` 同形守卫）
  const m4 = score(Object.assign({}, base, {
    js: mutateNth(base.js, 'if (on && editing) return;', '', 1),
  }));
  assert.ok(m4.some(function (x) { return x.indexOf('编辑态拒绝') >= 0; }), m4.join('\n'));

  // 5. 少一个 handler
  const m5 = score(Object.assign({}, base, {
    js: mutate(base.js,
      "keymap.register('view.zoom-in', function () { setZoom(VS.zoomNext(zoomLevel, 1)); });",
      ''),
  }));
  assert.ok(m5.some(function (x) { return x.indexOf('view.zoom-in') >= 0; }), m5.join('\n'));

  // 6. 键位表被改掉
  const m6 = score(Object.assign({}, base, {
    rust: mutate(base.rust, 'accel: "Ctrl+Cmd+0"', 'accel: "Cmd+0"'),
  }));
  assert.ok(m6.some(function (x) { return x.indexOf('view.zoom-actual') >= 0; }), m6.join('\n'));

  // 7. 行号又去找第二套解析（链路缺 align）
  const m7 = score(Object.assign({}, base, {
    js: mutate(base.js, 'LB.align(LB.topNodes(doc), parsed.blocks)', 'LB.topNodes(doc)'),
  }));
  assert.ok(m7.some(function (x) { return x.indexOf('第二套解析') >= 0; }), m7.join('\n'));
});

// ────────────────────────────────────────────────────────────────
// ⑤ 变异自测（纯逻辑：改源码 → vm 重新执行）
// ────────────────────────────────────────────────────────────────

test('⭐ 纯逻辑变异自测：档位少 100 / 脚注不再跳过 / 边界返回反 / 布尔放宽', function () {
  // 1. 档位表里没有 100 ⇒ normalizeZoom(100) 不可能还是 100
  const no100 = loadViewstate(mutate(
    VS_SRC,
    '[50, 67, 80, 90, 100, 110, 125, 150, 175, 200]',
    '[50, 67, 80, 90, 110, 125, 150, 175, 200]'
  ));
  assert.notStrictEqual(no100.normalizeZoom(100), 100, '档位变异没有被判据看见');

  // 2. 脚注定义不再跳过 ⇒ 它会进 linePlan
  const keepFootnotes = loadViewstate(mutate(
    VS_SRC,
    "if (block.kind === 'FootnoteDefinition') continue;",
    ''
  ));
  const footnoteSlot = [{ block: { kind: 'FootnoteDefinition', startLine: 9 }, node: fakeNode(1) }];
  assert.strictEqual(VS.linePlan(footnoteSlot).length, 0, '基线：脚注必须跳过');
  assert.strictEqual(keepFootnotes.linePlan(footnoteSlot).length, 1, '脚注变异没有被判据看见');

  // 3. 到上界返回下界 ⇒ "不循环"判据必须变红
  const wrap = loadViewstate(mutate(VS_SRC, 'return ZOOM_MAX;', 'return ZOOM_MIN;'));
  assert.strictEqual(VS.zoomNext(200, 1), 200);
  assert.strictEqual(wrap.zoomNext(200, 1), 50, '边界变异没有被判据看见');

  // 4. 布尔判断放宽成真值 ⇒ 字符串 "true" 会被读成开
  const loose = loadViewstate(mutate(VS_SRC, 'const want = on === true;', 'const want = !!on;'));
  const doc = fakeDoc();
  const node = fakeNode(1);
  loose.applyLineNumbers(doc, [{ node: node, line: 1 }], 'true');
  assert.strictEqual(doc.classList.contains('doc-lines'), true, '布尔变异没有被判据看见');
  assert.strictEqual(node.attrs['data-rmd-line'], '1');
});
