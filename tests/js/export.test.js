// `design/0076` §7.1 的源码级闸门：**导出（HTML / PDF）**。
//
// ⭐ 这一格测的全是"浏览器不会报错、画面上也看不出来"的失效形态：
//
//   ① **样式表顺序**：`print.css` 插错位置不会报错，只会在某天打印时
//      要么把屏幕排版带坏（排到 `editor.css` 之前），要么被 `live.css` 盖掉
//      （排到最后）。⇒ 断言"恰好一次 ＋ editor 之后 ＋ live 之前"。
//   ② **`print.css` 的顶层块**：一条没有 `@media print` 的正文规则会**污染屏幕**，
//      而症状只在"有人打开打印样式"时出现。⇒ 顶层只允许 `@page` 与 `@media print`。
//   ③ **纸张调色板**：`themes.css` 的打印块必须覆盖 dark 块声明的**每个**变量名，
//      且值与 light（`tokens.css` 的 `:root`）逐字相同——漏一个名字就是"深色值落在白纸上"。
//   ④ **接线与文案**：`main.js` 里两个 `keymap.register` 必须存在（否则菜单/键盘只有一边动），
//      `i18n.js` 的 zh 与 en 必须含 `design/0076` §2.1.9 的全部新键且占位符一致。
//
// ⚠️ 另加一条结构性判据：`#doc` 必须是 `<body>` 的直接子节点——`print.css` 的
//    `body > :not(#doc) { display: none }` 靠它成立（该文件头自己点名了这条）。
//
// 跑法：`make test-js`（= `node --test tests/js/`）。
// ⚠️ 放仓库根的 `tests/js/`，⛔ 不放 `src/`（那是 `frontendDist`，会嵌进二进制）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const I = require('../../src/services/i18n.js');

const SRC = path.resolve(__dirname, '../../src');
const read = function (rel) { return fs.readFileSync(path.join(SRC, rel), 'utf8'); };

/** 抹掉块注释（⚠️ 注释里本来就有 `@page` / 变量名 / 色值，⛔ 不能让它们参与判定）。 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

/** 折叠空白：`var(--p-gray-50)` 与 `var( --p-gray-50 )` 视为同一个值。 */
function fold(s) { return String(s).replace(/\s+/g, ' ').trim(); }

/**
 * 取 `src` 里**选择器 `sel` 的全部规则体**（本仓 CSS 没有嵌套，够用）。
 * ⚠️ 只按**完整选择器字符串**匹配：`[data-theme="dark"]` 与
 *    `:root[data-theme="dark"]` 是两条不同的规则，⛔ 别互相匹配。
 */
function bodies(src, sel) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf(sel, i)) !== -1) {
    const open = src.indexOf('{', i);
    assert.notStrictEqual(open, -1, '`' + sel + '` 后面没有 `{`');
    let depth = 0;
    let close = open;
    for (; close < src.length; close += 1) {
      if (src[close] === '{') depth += 1;
      else if (src[close] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(open + 1, close));
    i = close + 1;
  }
  return out;
}

/** 规则体里的自定义属性表（`--name: value`，值折叠空白）。 */
function decls(body) {
  const out = {};
  const parts = body.split(';');
  for (let i = 0; i < parts.length; i += 1) {
    const k = parts[i].indexOf(':');
    if (k < 0) continue;
    const name = parts[i].slice(0, k).trim();
    if (name.indexOf('--') !== 0) continue;
    out[name] = fold(parts[i].slice(k + 1));
  }
  return out;
}

/** `print.css` 的顶层块前言（按 `{` 的深度扫，⛔ 不靠行首缩进）。 */
function topLevelPreludes(code) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i];
    if (c === '{') {
      if (depth === 0) out.push(code.slice(start, i).trim());
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) start = i + 1;
    }
  }
  return out;
}

/**
 * `@media print` 块里的扁平规则（本仓 CSS 没有嵌套；⛔ 不靠缩进）。
 * 返回 `[{ selectors: ['body'], decl: '...' }, …]`。
 */
function printBlockRules(code) {
  const at = code.indexOf('@media print');
  assert.notStrictEqual(at, -1, '`print.css` 里没有 `@media print`');
  const open = code.indexOf('{', at);
  let depth = 0;
  let close = open;
  for (; close < code.length; close += 1) {
    if (code[close] === '{') depth += 1;
    else if (code[close] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const inner = code.slice(open + 1, close);
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    out.push({
      selectors: m[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      decl: m[2],
    });
  }
  return out;
}

/** 规则体里某个属性的折叠值；没有该属性返回 `null`。 */
function propValue(decl, prop) {
  const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i');
  const m = re.exec(decl);
  return m ? fold(m[1]) : null;
}

// ────────────────────────────────────────────────────────────────
// ① 样式表顺序
// ────────────────────────────────────────────────────────────────

test('`index.html` 里 `styles/print.css` 恰好一次，且在 editor.css 之后、live.css 之前', function () {
  const html = read('index.html');
  const hits = html.match(/href="styles\/print\.css"/g) || [];
  assert.strictEqual(hits.length, 1, '`styles/print.css` 的 <link> 数量 = ' + hits.length + '（要求恰好 1）');

  const at = function (name) {
    const m = html.match(new RegExp('href="styles/' + name + '"'));
    assert.ok(m, '`index.html` 里找不到 `styles/' + name + '`');
    return html.indexOf(m[0]);
  };
  assert.ok(at('editor.css') < at('print.css'),
    '`print.css` 必须排在 `editor.css` 之后（读者分栏外壳先定义，打印再覆盖）');
  assert.ok(at('print.css') < at('live.css'),
    '`print.css` 必须排在 `live.css` 之前（`live.css` 仍是最后一张样式表）');
});

// ────────────────────────────────────────────────────────────────
// ② `print.css` 的顶层块
// ────────────────────────────────────────────────────────────────

test('`print.css` 的顶层块只有 `@page` 与 `@media print`', function () {
  const code = stripComments(read('styles/print.css'));
  const preludes = topLevelPreludes(code);
  assert.ok(preludes.length > 0, '`print.css` 里没有任何顶层块');
  preludes.forEach(function (p) {
    assert.ok(p === '@page' || /^@media\s+print\b/.test(p),
      '`print.css` 出现未包裹的顶层块 `' + p + '` —— 它会污染屏幕排版（`INV-EXP-07`）');
  });
  assert.ok(preludes.indexOf('@page') !== -1, '`print.css` 少了 `@page`（wry 的边距是 0，页边距只能由它补）');
  assert.ok(preludes.some(function (p) { return /^@media\s+print\b/.test(p); }),
    '`print.css` 少了 `@media print`');
});

// ────────────────────────────────────────────────────────────────
// ②b 打印块把屏幕布局的偏移归零（`bugs/0323`）
// ────────────────────────────────────────────────────────────────

/**
 * ⭐ `bugs/0323`（2026-11-15 真机）：打印出来的正文只占纸面**右半部分**。
 *
 * ⚠️ 失效形态是**纯视觉**的：`sidebar.css` 给 `body` 留了
 *    `padding-left: var(--sidebar-width)`（280px），`@media print` 用
 *    `body > :not(#doc) { display:none }` 只把侧边栏**元素**拿掉，
 *    它占的**宽度不还** ⇒ 正文整块右移一个侧边栏宽，白纸左边空一半。
 *    CSS 不报错、屏幕上看不出、`lint-theme` 也扫不到。
 * ⭐ 所以这里钉三件事：① `body` 的 `padding` / `margin` 在打印块里为 0；
 *    ② 值必须带 `!important`（`body.sidebar-collapsed` 那族是 (0,1,1)，会压过裸 `body`）；
 *    ③ `#doc` 的 `zoom` 归 1（`design/0079` 的画布缩放只属于屏幕）。
 */
function 体检打印偏移(src) {
  const rules = printBlockRules(stripComments(src));
  const bodyRules = rules.filter(function (r) { return r.selectors.indexOf('body') >= 0; });
  if (bodyRules.length === 0) return '打印块里没有给 `body` 的规则';

  const zeroImportant = function (v) { return v !== null && /^0(px)?\s*!important$/.test(v); };
  let 失败 = null;
  bodyRules.forEach(function (r) {
    const pad = propValue(r.decl, 'padding');
    const mar = propValue(r.decl, 'margin');
    if (!zeroImportant(pad)) 失败 = 失败 || '`body` 的 `padding` = `' + pad + '`（要求 `0 !important`）';
    if (!zeroImportant(mar)) 失败 = 失败 || '`body` 的 `margin` = `' + mar + '`（要求 `0 !important`）';
  });
  if (失败) return 失败;

  const docRules = rules.filter(function (r) { return r.selectors.indexOf('#doc') >= 0; });
  if (docRules.length === 0) return '打印块里没有给 `#doc` 的规则';
  const zooms = docRules.map(function (r) { return propValue(r.decl, 'zoom'); }).filter(function (v) { return v !== null; });
  if (zooms.length === 0 || zooms[zooms.length - 1] !== '1') {
    return '`#doc` 的 `zoom` 没有被归 1（画布缩放会被带进纸面）';
  }
  return null;
}

test('⭐ bugs/0323：打印块把屏幕布局的偏移归零（否则正文只占纸面右半边）', function () {
  const src = read('styles/print.css');
  assert.strictEqual(体检打印偏移(src), null,
    '⛔ ' + 体检打印偏移(src) + ' —— 打印出来的正文会整体右移一个侧边栏宽（用户真机截图：只占页面右侧一半）');

  // ── 变异：把 `padding: 0 !important` 换回屏幕上的那个偏移 ⇒ 同一个体检器必须报红 ──
  const 靶子 = 'padding: 0 !important;';
  assert.ok(src.indexOf(靶子) >= 0, '⚠️ 前置：找不到 `' + 靶子 + '`（靶子漂了，这条变异失去意义）');
  const 变异 = src.replace(靶子, 'padding-left: var(--sidebar-width);');
  assert.notStrictEqual(变异, src, '⚠️ 前置：变异必须真的改到源码');
  assert.notStrictEqual(体检打印偏移(变异), null,
    '⚠️ 变异之后体检器仍然通过 ⇒ 上面那条断言看的不是 `body` 的 padding');
});

// ────────────────────────────────────────────────────────────────
// ③ 纸张调色板 = 浅色
// ────────────────────────────────────────────────────────────────

test('`themes.css` 的打印块覆盖 dark 的每个变量名，且值等于 light', function () {
  const themes = stripComments(read('styles/themes.css'));
  const tokens = stripComments(read('styles/tokens.css'));

  const printAt = themes.indexOf('@media print');
  assert.notStrictEqual(printAt, -1, '`themes.css` 里没有打印块');

  const printBodies = bodies(themes.slice(printAt), ':root[data-theme="dark"]');
  assert.strictEqual(printBodies.length, 1, '打印块的 `:root[data-theme="dark"]` 数量 = ' + printBodies.length);
  const print = decls(printBodies[0]);

  // ⚠️ dark 的**普通**块选择器是 `[data-theme="dark"]`（没有 `:root`），
  //    打印块用 `:root[...]` 挣特异性 ⇒ 这里必须按各自的完整选择器取，⛔ 不能合并。
  const darkBodies = bodies(themes.slice(0, printAt), '[data-theme="dark"]');
  assert.ok(darkBodies.length > 0, '`themes.css` 里找不到 dark 块');
  const dark = decls(darkBodies[0]);

  const rootBodies = bodies(tokens, ':root');
  assert.ok(rootBodies.length > 0, '`tokens.css` 里找不到 `:root`');
  const light = decls(rootBodies[0]);

  const names = Object.keys(dark);
  assert.ok(names.length > 0, 'dark 块里一个变量都没有');
  names.forEach(function (name) {
    assert.ok(Object.prototype.hasOwnProperty.call(print, name),
      '打印块漏了 `' + name + '` ⇒ 深色主题打印时这一项沿用深色值（白纸上读不出来）');
    assert.strictEqual(print[name], light[name],
      '打印块的 `' + name + '` = `' + print[name] + '`，而 light 是 `' + light[name] + '` ⇒ 纸面必须等于浅色');
  });
});

// ────────────────────────────────────────────────────────────────
// ④ 接线与文案
// ────────────────────────────────────────────────────────────────

test('`main.js` 注册了 `file.export-html` / `file.export-pdf`，且命令签名对得上', function () {
  const main = read('main.js');
  assert.ok(/keymap\.register\('file\.export-html'/.test(main),
    '`main.js` 少了 `keymap.register(\'file.export-html\')` ⇒ 菜单能点、键盘不动');
  assert.ok(/keymap\.register\('file\.export-pdf'/.test(main),
    '`main.js` 少了 `keymap.register(\'file.export-pdf\')` ⇒ 菜单能点、键盘不动');
  // ⚠️ `AppearanceIn` 的字段是 snake_case（`document/export.rs` 没有 rename_all），
  //    而**命令参数名**走 Tauri 的 camelCase ⇒ 这里钉住实际发出去的那个形状。
  assert.ok(/T\.call\('export_html',\s*\{\s*appearance:/.test(main),
    '`export_html` 的调用必须带 `{ appearance }`（外观快照是后端拼 <style> 的依据）');
  assert.ok(/T\.call\('export_pdf'\)/.test(main), '`export_pdf` 的调用不见了');
  // 失败条：重试必须重新走整条流程（设计 §2.1.9 末条）。
  assert.ok(/label:\s*'fail\.retry'/.test(main), '导出失败条少了「重试」动作');
});

/**
 * ⭐ `bugs/0322`（2026-11-15）：菜单点击必须能穿过**可编辑焦点**闸门。
 *
 * ⚠️ 失效形态是**全静默**的：编辑态（就地 `contenteditable` / 分栏 CM6）中点
 *    `File ▸ 导出为 PDF`，`keymap.dispatch(id, 'menu')` 撞上 `ctx.editable()` 直接
 *    `return false` ⇒ 没有 IPC、没有状态条、`rmd.log` 一个字都没有 ——
 *    用户看到的就是「点了没有任何反应」。
 * ⭐ 所以这条闸门钉两件事：① 清单里有没有那三个 id；② `allowEditable` **真的读的是这份清单**
 *    （写了清单却比对 `CLIP_ACTION_IDS`，症状与没修一样）。
 */
test('⭐ bugs/0322：菜单路径放行 保存 / 两种导出（否则编辑态点菜单被静默吞掉）', function () {
  const main = read('main.js');

  /** 取出 `MENU_EDITABLE_IDS` 那段清单：`full` 是整段原文，`ids` 是 `concat([...])` 里的字面量。 */
  const 取清单 = function (src) {
    const m = /const MENU_EDITABLE_IDS = CLIP_ACTION_IDS\.concat\(\[([\s\S]*?)\]\);/.exec(src);
    assert.ok(m, '⛔ 找不到 `const MENU_EDITABLE_IDS = CLIP_ACTION_IDS.concat([...])` —— 清单的形状变了，这条闸门必须跟着改');
    return {
      full: m[0],
      ids: (m[1].match(/'[^']+'/g) || []).map(function (s) { return s.slice(1, -1); }),
    };
  };

  const 清单 = 取清单(main);
  ['file.save', 'file.export-html', 'file.export-pdf'].forEach(function (id) {
    assert.ok(清单.ids.indexOf(id) >= 0,
      '⛔ 清单里没有 `' + id + '` —— 编辑态点这一项会被静默吞掉（用户实测：点了没有任何反应）');
  });
  // ⭐ 复制/粘贴那五个仍必须在（`design/0077` 的既有行为，⛔ 别把它挤掉）。
  ['edit.copy-markdown', 'edit.copy-plain', 'edit.paste-literal'].forEach(function (id) {
    assert.strictEqual(清单.ids.indexOf(id), -1,
      '⚠️ 这一条不该出现在**追加段**里：`' + id + '` 来自 `CLIP_ACTION_IDS`，重复写会成为第二份清单');
  });
  assert.ok(/allowEditable[\s\S]{0,400}MENU_EDITABLE_IDS\.indexOf\(id\)/.test(main),
    '⛔ `allowEditable` 没有比对 `MENU_EDITABLE_IDS` —— 清单写了也没有人读');

  // ── 变异：把 `file.export-pdf` 从**这一段**里删掉 ⇒ 同一个提取器必须读不到它 ──
  const 变异段 = 清单.full.replace("'file.export-pdf',", '');
  assert.notStrictEqual(变异段, 清单.full, '⚠️ 前置：变异必须真的改到清单（找不到那一行说明靶子漂了）');
  assert.strictEqual(取清单(main.replace(清单.full, 变异段)).ids.indexOf('file.export-pdf'), -1,
    '⚠️ 变异之后仍读到 `file.export-pdf` ⇒ 上面那条断言看的不是清单内容');
});

/**
 * ⭐ `design/0080`（2026-11-15）：`export_pdf` 从「派发打印面板」改成「直接写 .pdf」之后，
 *    **成功也必须给一句状态条**——旧口径「面板本身就是可见的结果」在新路径下**没有面板了**。
 *
 * ⚠️ 失效形态是**静默的**：文件确实写出来了，用户不知道写在哪；
 *    而如果把取消也当失败，每次按「取消」都要吃一条失败条（`INV-PDF-04`）。
 */
test('⭐ design/0080：`export_pdf` 的结果进状态条，取消保持静默', function () {
  const main = read('main.js');

  /** 按花括号配平取出某个函数的**函数体**（含外层 `{}`）。 */
  const 取函数体 = function (src, name) {
    const head = src.indexOf('async function ' + name + '()');
    assert.ok(head >= 0, '找不到 `async function ' + name + '()`');
    const open = src.indexOf('{', head);
    assert.ok(open > head, '`' + name + '` 后面没有函数体');
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    return assert.fail('`' + name + '` 的花括号没有配平');
  };

  const body = 取函数体(main, 'exportPdfNow');

  assert.ok(/const out = await T\.call\('export_pdf'\)/.test(body),
    '⛔ `export_pdf` 的返回值必须接住（`const out = …`）——它现在带 `path`');
  assert.ok(/if \(!out\) return null;/.test(body),
    '⛔ 缺了取消分支：用户取消后结果是 `null`，再读 `out.path` 会抛');
  assert.ok(/setStatusT\('status\.export-done', \{ path: out\.path \}\)/.test(body),
    '⛔ 成功后必须写 `status.export-done`，且路径只能来自后端');
  assert.ok(!/await T\.call\('export_pdf'\);\s*return true;/.test(body),
    '⚠️ 「调一下、直接 `return true`」是旧写法（那时结果是系统面板）⇒ 文件写了也不告诉用户写在哪');

  // ── 变异：把状态条里的路径抹成空 ⇒ 上面那条判据必须打红 ──
  const 变异 = body.replace('{ path: out.path }', '{}');
  assert.notStrictEqual(变异, body, '⚠️ 前置：变异必须真的命中 `{ path: out.path }`（靶子漂了）');
  assert.ok(!/setStatusT\('status\.export-done', \{ path: out\.path \}\)/.test(变异),
    '⚠️ 变异之后仍匹配 ⇒ 上面那条判据根本不在看路径');

  // ── 反向对照：提取器必须**只**框住这一个函数（框大了，上面的断言等于在扫整个文件）──
  assert.ok(!/T\.call\('export_pdf'\)/.test(取函数体(main, 'exportHtmlNow')),
    '⚠️ 提取器越界：它把别的函数也框进来了');
});

test('i18n 的 zh / en 含 §2.1.9 的全部新键，且占位符一致', function () {
  const keys = [
    'status.export-no-document',
    'status.export-needs-save',
    'status.export-done',
    'status.export-partial',
    'fail.export-failed',
    'fail.print-failed',
    'err.kind.export',
  ];
  const vars = function (s) {
    const out = [];
    const re = /\{([A-Za-z_][\w]*)\}/g;
    let m;
    while ((m = re.exec(s)) !== null) out.push(m[1]);
    return out.sort();
  };
  keys.forEach(function (key) {
    const zh = I.DICT.zh[key];
    const en = I.DICT.en[key];
    assert.strictEqual(typeof zh, 'string', 'zh 字典缺 `' + key + '`');
    assert.strictEqual(typeof en, 'string', 'en 字典缺 `' + key + '`');
    assert.deepStrictEqual(vars(en), vars(zh),
      '`' + key + '` 的占位符 zh=' + JSON.stringify(vars(zh)) + ' en=' + JSON.stringify(vars(en)));
  });
});

test('`tauri.js` 的 `KIND_KEY` 有 `export`，且 `#doc` 是 body 的直接子节点', function () {
  const tauri = read('services/tauri.js');
  assert.ok(/export:\s*'err\.kind\.export'/.test(tauri),
    '`KIND_KEY` 少了 `export` ⇒ `Denied::Export` 会落到兜底那句「操作失败」');

  // ⚠️ `print.css` 的 `body > :not(#doc)` 靠这条结构成立。
  const html = stripComments(read('index.html'));
  const from = html.indexOf('<body');
  const to = html.indexOf('</body>');
  assert.ok(from !== -1 && to > from, '`index.html` 里找不到 <body> … </body>');
  const body = html.slice(from, to);
  const VOID = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];
  const re = /<(\/?)([A-Za-z][\w-]*)([^>]*)>/g;
  let depth = 0;
  let docDepth = -1;
  let m;
  while ((m = re.exec(body)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosing = /\/\s*$/.test(m[3]);
    if (closing) { depth -= 1; continue; }
    if (VOID.indexOf(name) === -1 && !selfClosing) depth += 1;
    if (/\bid="doc"/.test(m[3])) docDepth = depth;
  }
  assert.strictEqual(docDepth, 2,
    '`#doc` 的深度 = ' + docDepth + '（<body> 的直接子节点应为 2）⇒ `print.css` 的 `body > :not(#doc)` 会失效');
});
