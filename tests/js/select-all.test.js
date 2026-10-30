// `bugs/0036`（`⌘A` 全选，2026-10-29）的**源码级闸门**。
//
// ⭐ 为什么这一格必须是源码级、而不是"跑一遍看看"：
//   全选的失效形态**全部不报错**，而且**屏幕上看起来都像"选中了"**——
//   ① 选区范围跑到 `document.body` ⇒ 侧边栏文件名、顶栏状态条一起被选蓝，
//      而 `⌘C` 复制出来的东西要**粘出去**才发现多了几行；
//   ② 就地编辑态把 `⌘A` **转发**给全局 handler ⇒ 选区跳到正文全文，光标却还留在块里，
//      接着敲一个字，字落进块、选区在别处 —— 两边当场不一致；
//   ③ 外壳没有 `user-select: none` ⇒ `Menu::default` 自带的 `Select All`（走 AppKit，
//      ⛔ 不经过任何 JS）照样把 chrome 选进去 —— 这一层**用 JS 判据看不见**；
//   ⇒ 三条里两条只能读源码判（①③），第三条（②）的顺序也读源码最稳。
//
// ⚠️ 判据对**注释免疫**：本仓库注释里大量引用"⛔ 别写成 X"这种写法，
//    直接 grep 原文会把**正确的注释**判成缺陷 ⇒ 先 `strip*` 再判。
// ⚠️ 变异自测在文件末尾：同一套判据喂给"故意写坏的副本"必须各自变红，
//    否则"全绿"只说明判据没看那一眼（`.claude/rules/tests.md` 的四种"没红"）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'style.css'), 'utf8');
const RUST = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'gui', 'mod.rs'), 'utf8');

/** 挖空 `/* … *\/`（保留换行，行号对齐）。 */
function stripBlockComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

/** 挖空 `// …`（⚠️ 引号奇数时保守不动）。 */
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

// ────────────────────────────────────────────────────────────────
// 判据本体（⭐ 抽成函数：变异自测要拿"写坏的副本"再判一次）
// ────────────────────────────────────────────────────────────────

/**
 * @param {{main:string, css:string, rust:string}} src 三份**原始**源码（内部各自挖空注释）
 * @returns {string[]} 问题清单（空 = 全过）
 */
function score(src) {
  const main = stripLineComments(stripBlockComments(src.main));
  const css = stripBlockComments(src.css);
  const rust = stripLineComments(src.rust);
  const bad = [];

  // —— ① 表里有这一项，而且是 `owner = Web`（键归前端，Rust 不参与）——
  const at = rust.indexOf('id: "edit.select-all"');
  if (at < 0) {
    bad.push('`SHORTCUTS` 里没有 `edit.select-all` —— `⌘A` 没有主人（`INV-SET-01`）');
  } else {
    const tail = rust.slice(at, at + 400);
    if (tail.indexOf('Cmd+A') < 0) bad.push('`edit.select-all` 的 accel 不是 `Cmd+A`');
    if (tail.indexOf('Owner::Web') < 0) bad.push('`edit.select-all` 不是 `Owner::Web`（它的作用域在 DOM 里）');
  }

  // —— ② 前端真的挂了 handler（`INV-SET-02`②：表里有、代码没有 = 按下去没反应）——
  if (main.indexOf("keymap.register('edit.select-all'") < 0) {
    bad.push("`main.js` 没有 `keymap.register('edit.select-all')` —— 键进表了但没人接");
  }

  // —— ③ 就地编辑态**自己认领**，而且认领必须**早于**转发 ——
  const claim = main.indexOf("id === 'edit.select-all'");
  const forward = main.indexOf('forwardShim.forward(id)');
  if (claim < 0) {
    bad.push('`makeLiveView::onKeyDown` 没认领 `edit.select-all` —— '
      + '会被转发给"选正文全文"的全局 handler，而光标还在块里（两边不一致）');
  } else if (forward >= 0 && forward < claim) {
    bad.push('`edit.select-all` 的认领排在 `forwardShim.forward` **之后** —— 永远轮不到');
  }

  // —— ④ 正文范围**只能**是 `#doc`（⛔ `document.body` / ⛔ 整篇 document）——
  const fnAt = main.indexOf('function selectAllText(');
  if (fnAt < 0) {
    bad.push('`main.js` 没有 `selectAllText()`');
  } else {
    const fn = main.slice(fnAt, fnAt + 1200);
    if (fn.indexOf("$('doc')") < 0) bad.push('`selectAllText()` 不拿 `#doc` 当范围');
    if (/selectNodeContents\(\s*document\b/.test(fn) || fn.indexOf('document.body') >= 0) {
      bad.push('`selectAllText()` 把范围放到了整篇文档 —— 侧边栏与顶栏会被一起选进去');
    }
    // ⭐ 分栏编辑态那条分支必须在：转发白名单收**所有** `owner=web` 的项，
    //    编辑区里按 `⌘A` 会被转发进来 —— 不认编辑器就会去选**预览**。
    if (fn.indexOf('editor.isMounted()') < 0) {
      bad.push('`selectAllText()` 不看分栏编辑器 —— 编辑区按 `⌘A` 会去选预览');
    }
  }

  // —— ⑤ 外壳不可选（挡住 AppKit 那条原生全选）——
  // ⚠️ 必须按**同一条规则**判，⛔ 不能"找到 `.topbar` 的第一个块就算数"：
  //    `.topbar { position: sticky; … }` 排在前面，那样 `user-select` 加没加都绿。
  const shell = /\.topbar\s*,\s*\.sidebar\s*\{([^}]*)\}/.exec(css);
  if (!shell || !/user-select:\s*none/.test(shell[1])) {
    bad.push('`style.css` 的 `.topbar, .sidebar` 没有 `user-select: none` —— '
      + '原生全选会把侧边栏文件名与状态条一起选进去');
  }
  // ⚠️ 反面对照：表单控件必须**放回来**，否则改名框的"全选默认名"与搜索框拖选一起废掉。
  if (!/\.sidebar\s+input[\s\S]{0,200}user-select:\s*text/.test(css)) {
    bad.push('侧边栏的 `input` 没有放回 `user-select: text` —— 改名框全选与搜索框拖选会失效');
  }

  return bad;
}

const REAL = { main: MAIN, css: CSS, rust: RUST };

test('`⌘A` 全选：表里有主、前端有 handler、就地编辑自己认领、范围只到 #doc', function () {
  const bad = score(REAL);
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});

test('⭐ 判据自检：五处各自喂坏源码，必须**各自**变红（⛔ 不许有一条恒真）', function () {
  // ① 表里没有这一项
  const noRow = Object.assign({}, REAL, { rust: RUST.replace('id: "edit.select-all"', 'id: "edit.xxx"') });
  assert.notStrictEqual(noRow.rust, RUST, 'M-a 变异没改到源码');
  assert.ok(score(noRow).some(function (x) { return x.indexOf('SHORTCUTS') >= 0; }), 'M-a');

  // ② 没挂 handler
  const noHandler = Object.assign({}, REAL, {
    main: MAIN.replace("keymap.register('edit.select-all'", "keymap.register('edit.xxx'"),
  });
  assert.notStrictEqual(noHandler.main, MAIN, 'M-b 变异没改到源码');
  assert.ok(score(noHandler).some(function (x) { return x.indexOf('keymap.register') >= 0; }), 'M-b');

  // ③ 认领排在转发之后
  const lateClaim = MAIN
    .replace("if (id === 'edit.select-all') {", 'if (false) {')
    .replace('if (forwardShim) forwardShim.forward(id);',
      "if (forwardShim) forwardShim.forward(id);\n        if (id === 'edit.select-all') { }");
  assert.notStrictEqual(lateClaim, MAIN, 'M-c 变异没改到源码');
  assert.ok(score(Object.assign({}, REAL, { main: lateClaim }))
    .some(function (x) { return x.indexOf('认领') >= 0; }), 'M-c');

  // ④ 范围放到整篇文档
  const wholePage = MAIN.replace('range.selectNodeContents(main);', 'range.selectNodeContents(document.body);');
  assert.notStrictEqual(wholePage, MAIN, 'M-d 变异没改到源码');
  assert.ok(score(Object.assign({}, REAL, { main: wholePage }))
    .some(function (x) { return x.indexOf('整篇文档') >= 0; }), 'M-d');

  // ⑤ 外壳没设 user-select: none
  const selectable = CSS.replace('  -webkit-user-select: none;\n  user-select: none;\n}\n\n.topbar input', '}\n\n.topbar input');
  assert.notStrictEqual(selectable, CSS, 'M-e 变异没改到源码');
  assert.ok(score(Object.assign({}, REAL, { css: selectable }))
    .some(function (x) { return x.indexOf('user-select: none') >= 0; }), 'M-e');

  // ⑥ 表单控件没放回来（反面对照：`user-select: none` 一刀切到 input）
  const inputsDead = CSS.replace('  -webkit-user-select: text;\n  user-select: text;\n', '');
  assert.notStrictEqual(inputsDead, CSS, 'M-f 变异没改到源码');
  assert.ok(score(Object.assign({}, REAL, { css: inputsDead }))
    .some(function (x) { return x.indexOf('改名框') >= 0; }), 'M-f');
});
