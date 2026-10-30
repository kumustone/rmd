// `design/0037`（顶栏折叠，2026-10-23）的**源码级闸门**。
//
// ⭐ 为什么这一格必须是源码级、而不是"跑一遍看看"：
//   折叠的失效形态**全部不报错**——
//   ① 把 `body.chrome-hidden` 写成 `.topbar` 一刀切 ⇒ `#reload-bar` / `#preview-bar` /
//      `#edit-prompt` 跟着消失 ⇒ 「降级必须显式告知」（`INV-EXT-04`）与「陈旧必须始终可见」
//      （`INV-EDIT-11`）被静默破掉，而屏幕上只是"少了条提示带"，没人会想到是折叠干的；
//   ② 折叠后**没有回来的路**（抓手丢了 / 快捷键的 handler 漏注册）⇒ 用户被困在全屏阅读态，
//      而 `checkActions` 那条运行时闸门只覆盖"表里有、handler 没有"，覆盖不了"抓手不在"；
//   ③ 编辑态里也允许折叠 ⇒ `design/0012` §2.1⑤ 要求的**可见退出控件**被藏起来；
//   ④ 前端另写一份键位文案 ⇒ `INV-SET-01`（键位唯一来源在后端那张表）。
//
// ⚠️ 判据对**注释免疫**（本仓库的注释里大量引用"⛔ 别写成 X"这种写法，
//    直接 grep 原文会把**正确的注释**判成缺陷）——所以三条 `strip*` 先挖空注释再判。
// ⚠️ 变异自测在 `score()` 里：同一套判据喂给"故意写坏的副本"必须变红，
//    否则"全绿"只说明判据没看那一眼（`tests.md` 的四种"没红"）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'style.css'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const RUST = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'gui', 'mod.rs'), 'utf8');

/** 挖空 `/* … *\/`（⛔ 不删，保持长度与行号对齐的思路一致）。 */
function stripBlockComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

/** 挖空 `// …`（⚠️ 只认行首注释与行尾注释，不碰字符串里的 `//`——本文件够用）。 */
function stripLineComments(src) {
  return String(src).split('\n').map(function (line) {
    const i = line.indexOf('//');
    if (i < 0) return line;
    // ⚠️ 粗糙但**保守**：这一行 `//` 之前若有奇数个引号，就当它还在字符串里，不动。
    const before = line.slice(0, i);
    const quotes = (before.match(/["']/g) || []).length;
    if (quotes % 2 === 1) return line;
    return before;
  }).join('\n');
}

const HTML_CODE = stripBlockComments(HTML);
const CSS_CODE = stripBlockComments(CSS);
const MAIN_CODE = stripLineComments(stripBlockComments(MAIN));
const RUST_CODE = stripLineComments(RUST);

// ────────────────────────────────────────────────────────────────
// 判据本体（⭐ 抽成函数是为了让变异自测能拿"写坏的副本"再判一次）
// ────────────────────────────────────────────────────────────────

/**
 * @param {{html:string, css:string, js:string, rust:string}} s
 * @returns {string[]} 失败项（空 = 全过）
 */
function score(s) {
  const bad = [];

  // ① 「隐藏顶栏」按钮在工具栏里，且带两处 i18n
  const hideAt = s.html.indexOf('id="chrome-hide"');
  const toolAt = s.html.indexOf('class="toolbar"');
  const statusAt = s.html.indexOf('id="status"');
  if (hideAt < 0) bad.push('index.html 少了 #chrome-hide');
  else {
    if (!(hideAt > toolAt && hideAt < statusAt)) bad.push('#chrome-hide 不在工具栏里');
    const tag = s.html.slice(hideAt, s.html.indexOf('>', hideAt) + 1);
    if (!/data-i18n-title="toolbar\.hide-chrome"/.test(tag)) bad.push('#chrome-hide 缺 data-i18n-title');
    if (!/data-i18n-aria-label="toolbar\.hide-chrome"/.test(tag)) bad.push('#chrome-hide 缺 data-i18n-aria-label');
  }

  // ② 折叠后的抓手是 `.topbar` 的直接子元素、排在 `.toolbar` 之前，且**不用 `hidden` 属性**
  const gripAt = s.html.indexOf('id="chrome-grip"');
  const topAt = s.html.indexOf('class="topbar"');
  if (gripAt < 0) bad.push('index.html 少了 #chrome-grip（折叠后没有回来的路）');
  else {
    if (!(gripAt > topAt && gripAt < toolAt)) bad.push('#chrome-grip 不在 .topbar 里、或排在 .toolbar 之后');
    const tag = s.html.slice(gripAt, s.html.indexOf('>', gripAt) + 1);
    if (/\shidden(\s|>)/.test(tag)) {
      bad.push('#chrome-grip 用了 hidden 属性 —— probe-i18n 会强开它再量溢出');
    }
    if (!/data-i18n-aria-label="toolbar\.show-chrome"/.test(tag)) bad.push('#chrome-grip 缺 data-i18n-aria-label');
  }

  // ③ 折叠只点名 `.toolbar` 与 `.status`，⛔ 不许一刀切 `.topbar`
  if (!/body\.chrome-hidden\s+\.toolbar\s*,\s*\n?\s*body\.chrome-hidden\s+\.status\s*\{\s*display:\s*none/.test(s.css)) {
    bad.push('style.css 没有"只藏 .toolbar 与 .status"那条规则');
  }
  if (/body\.chrome-hidden\s+\.topbar\b/.test(s.css)) {
    bad.push('style.css 一刀切藏了 .topbar —— 重载/预览/决策那三条提示带会跟着消失');
  }
  if (!/\.chrome-grip\s*\{[^}]*display:\s*none/.test(s.css)) bad.push('.chrome-grip 未折叠时没有 display:none');
  if (!/body\.chrome-hidden\s+\.chrome-grip\s*\{\s*display:\s*flex/.test(s.css)) bad.push('折叠后抓手没有显出来');
  if (!/body\.editing\s+\.chrome-btn\s*\{\s*display:\s*none/.test(s.css)) bad.push('编辑态没有藏起"隐藏顶栏"按钮（`0012` §2.1⑤）');

  // ④ 状态只有一个写入口；编辑态拒绝；进编辑态时复位
  const toggles = (s.js.match(/classList\.toggle\(\s*'chrome-hidden'/g) || []).length;
  if (toggles !== 1) bad.push('`chrome-hidden` 的 toggle 出现 ' + toggles + ' 次（应恰好 1 次：唯一写入口）');
  if (!/if\s*\(on\s*&&\s*editing\)\s*return;/.test(s.js)) bad.push('setChromeHidden 没有"编辑态拒绝折叠"那条');
  if (!/document\.body\.classList\.add\('editing'\);[\s\S]{0,400}?setChromeHidden\(false\);/.test(s.js)) {
    bad.push('enterEdit 没有把顶栏收回来');
  }

  // ⑤ 快捷键：表里有、前端有 handler、标题里的键位现算
  if (!/keymap\.register\('view\.toggle-chrome'/.test(s.js)) bad.push('main.js 没有注册 view.toggle-chrome');
  if (!/accelText\(\s*'view\.toggle-chrome'\s*\)/.test(s.js)) bad.push('tooltip 里的键位不是从后端表取的（INV-SET-01）');
  if (!/id:\s*"view\.toggle-chrome"/.test(s.rust)) bad.push('gui/mod.rs 的 SHORTCUTS 里没有 view.toggle-chrome');
  else {
    const at = s.rust.indexOf('id: "view.toggle-chrome"');
    const blk = s.rust.slice(at, at + 400);
    if (!/owner:\s*Owner::Web/.test(blk)) bad.push('view.toggle-chrome 的 owner 必须是 Web（它没有菜单加速键的位置）');
    if (!/accel:\s*"Shift\+Cmd\+B"/.test(blk)) bad.push('view.toggle-chrome 的 accel 变了（设计写的是 Shift+Cmd+B）');
  }

  return bad;
}

// ────────────────────────────────────────────────────────────────
// 判据
// ────────────────────────────────────────────────────────────────

test('⭐ 产品源码满足 `design/0037` 的全部结构判据', function () {
  const bad = score({ html: HTML_CODE, css: CSS_CODE, js: MAIN_CODE, rust: RUST_CODE });
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});

test('⭐ 两条 i18n 键在**两本**字典里都有（静态 title 与 aria-label 都不许是孤儿键）', function () {
  // ⚠️ `i18n.test.js` 那几条会扫 `index.html` 的每个 `data-i18n*` ⇒ 这里不重复扫；
  //    这一条只点名"折叠"这一组，失败时**报得出是哪一组**。
  const I = require('../../src/services/i18n.js');
  ['toolbar.hide-chrome', 'toolbar.show-chrome',
    'toolbar.hide-chrome-key', 'toolbar.show-chrome-key'].forEach(function (k) {
    ['zh', 'en'].forEach(function (lang) {
      const v = I.DICT[lang][k];
      assert.strictEqual(typeof v, 'string', lang + ' 少了 ' + k);
      assert.ok(v.length > 0, lang + ' 的 ' + k + ' 是空串');
    });
  });
});

// ────────────────────────────────────────────────────────────────
// 变异自测（⚠️ 没有这一步，"全绿"不说明判据真的在看）
// ────────────────────────────────────────────────────────────────

test('⭐ 变异自测：四处写坏各必须让**对应**判据变红', function () {
  const base = { html: HTML_CODE, css: CSS_CODE, js: MAIN_CODE, rust: RUST_CODE };
  assert.deepStrictEqual(score(base), [], '基线必须先全绿，否则下面分不清是谁的红');

  // 变异 1：CSS 一刀切 `.topbar`
  const m1 = score(Object.assign({}, base, {
    css: base.css.replace('body.chrome-hidden .toolbar,', 'body.chrome-hidden .topbar,'),
  }));
  assert.strictEqual(m1.length >= 1, true);
  assert.ok(m1.some(function (x) { return x.indexOf('一刀切') >= 0; }), m1.join('\n'));

  // 变异 2：抓手消失（折叠后没有回来的路）
  const m2 = score(Object.assign({}, base, { html: base.html.replace('id="chrome-grip"', 'id="chrome-grip-x"') }));
  assert.ok(m2.some(function (x) { return x.indexOf('chrome-grip') >= 0; }), m2.join('\n'));

  // 变异 3：又多了一条直接改 class 的路（唯一写入口破了）
  const m3 = score(Object.assign({}, base, {
    js: base.js + "\ndocument.body.classList.toggle('chrome-hidden', true);\n",
  }));
  assert.ok(m3.some(function (x) { return x.indexOf('唯一写入口') >= 0; }), m3.join('\n'));

  // 变异 4：Rust 表里的 accel 被改掉（设计写死的是 ⇧⌘B）
  const m4 = score(Object.assign({}, base, {
    rust: base.rust.replace('accel: "Shift+Cmd+B"', 'accel: "Cmd+Shift+B"'),
  }));
  assert.ok(m4.some(function (x) { return x.indexOf('accel 变了') >= 0; }), m4.join('\n'));

  // 变异 5：编辑态不拒绝折叠
  const m5 = score(Object.assign({}, base, { js: base.js.replace('if (on && editing) return;', '') }));
  assert.ok(m5.some(function (x) { return x.indexOf('编辑态拒绝') >= 0; }), m5.join('\n'));
});
