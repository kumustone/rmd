// `design/0071` §5（阶段 4）：多窗口的**前端那半**判据。
//
// # 这一组守的是什么
//
// 两件事错了都**没有异常**，只表现为"新窗口开出来是空的 / 开到了别的东西上"：
//   ① 新窗口起来后要落到用户点的那一条（最近目录 / 收藏）——
//      `open_in_new_window` 只把目标写进 `pending_navigation`，真正去开的是**新窗口
//      自己的 `main.js`** ⇒ 少了 `take_pending_navigation()` 这一拉，新窗口永远停在导航页；
//   ② `listen` 的目标必须是**当前窗口**。默认 `event.listen` 的 target 是 `Any`，
//      多窗口下**每个窗口都收到同一事件**：菜单按一下，所有窗口一起动。
//      ⚠️ 这个错也没有报错，只表现为"另一个窗口莫名其妙跟着变"。
//
// # 三层
//
// · **纯逻辑**：`services/windownav.js::plan()` 只把 `{kind,value}` 翻成既有命令名，
//   ⛔ 不拼路径、⛔ 不判断可达性（授权在新窗口自己的命令里做）。
// · **源码接线**：`index.html` 的脚本顺序、`StartScreen.js` 的菜单动作、
//   `main.js` 的起始恢复、`windownav.js` 自己不许沾 IPC。
// · **变异自测**：每条判据都拿"故意写坏的副本"再问一次，必须变红
//   （`.claude/rules/tests.md`：没做过变异测试的断言不算数）。
//
// ⚠️ 源码级判据一律**先剥注释**：本仓注释里大量写着"⛔ 别写成 X"，
//    直接 grep 原文会把正确的注释判成缺陷（也是本仓既有闸门的统一口径）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };

/** `/* … *\/` 挖空（保留换行，行号仍对得上）。 */
function stripBlockComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, '');
  });
}

/**
 * 逐行挖掉 `//` 之后的部分。
 * ⚠️ 字符串里的 `//`（如 URL）不动：按 `//` 之前引号数的奇偶判断。
 */
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

/** HTML 注释整块挖掉（`index.html` 的注释里也写着脚本名）。 */
function stripHtmlComments(src) {
  return String(src).replace(/<!--[\s\S]*?-->/g, '');
}

function 去注释(src) {
  return stripLineComments(stripBlockComments(src));
}

// ────────────────────────────────────────────────────────────────
// ① 纯逻辑：`plan()` 只做一次查表
// ────────────────────────────────────────────────────────────────

/**
 * 判据本体：喂一个 `plan` 实现，返回所有不符合项（空 = 过）。
 *
 * ⚠️ 写成可替换实现，是为了下面的变异自测——同一套判据喂"故意写坏的 plan"
 *    必须变红，否则"全绿"不说明判据真的在看。
 *
 * @param {(nav:any)=>any} plan
 * @returns {string[]}
 */
function plan问题(plan) {
  const bad = [];
  const 串 = function (v) {
    try {
      return v === undefined ? 'undefined' : JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  };
  const 喂 = function (输入, 期望, 名) {
    let got;
    try {
      got = plan(输入);
    } catch (e) {
      bad.push(名 + '：不该抛异常，实际抛了 ' + e.message);
      return;
    }
    if (串(got) !== 串(期望)) {
      bad.push(名 + '：期望 ' + 串(期望) + '，实际 ' + 串(got));
    }
  };

  // ── 没有可用导航：一律 `null`（调用方据此"什么都不做"）──
  喂(null, null, 'null');
  喂(undefined, null, 'undefined');
  喂('recent', null, '字符串不是导航对象');
  喂(42, null, '数字不是导航对象');
  喂([], null, '数组不是导航对象（没有 kind）');
  喂({}, null, '空对象');
  喂({ kind: 'recent' }, null, '缺 value');
  喂({ kind: 'favorite' }, null, 'favorite 缺 value');
  喂({ kind: 'recent', value: null }, null, 'value 为 null');
  喂({ kind: 'recent', value: 123 }, null, 'value 不是字符串');
  喂({ kind: 'recent', value: '' }, null, 'value 为空串');
  喂({ kind: 'recent', value: ['/a'] }, null, 'value 是数组');
  喂({ value: '/a' }, null, '缺 kind');

  // ── 两种合法 kind ⇒ 既有命令名（⚠️ 名字一个字母都不能自创）──
  喂({ kind: 'recent', value: '/a' },
    { cmd: 'open_recent_directory', value: '/a' }, 'recent');
  喂({ kind: 'favorite', value: '/a' },
    { cmd: 'open_favorite', value: '/a' }, 'favorite');

  // ── 未知 kind 一律 `null`（⛔ 不猜、⛔ 不兜底成某一种）──
  喂({ kind: 'other', value: '/a' }, null, '未知 kind');
  喂({ kind: 'Recent', value: '/a' }, null, 'kind 大小写不符');
  喂({ kind: 'recent ', value: '/a' }, null, 'kind 带尾空格');
  喂({ kind: '', value: '/a' }, null, 'kind 为空串');

  // ── 原串回传：⛔ 不规范化、⛔ 不拼路径、⛔ 不 trim ──
  喂({ kind: 'recent', value: '/a/b/../c/' },
    { cmd: 'open_recent_directory', value: '/a/b/../c/' }, '路径原串回传（含 .. 与尾斜杠）');
  喂({ kind: 'favorite', value: '/a b/中文' },
    { cmd: 'open_favorite', value: '/a b/中文' }, '路径原串回传（含空格与中文）');

  // ── 多余字段不许透传（结果形状固定是 `{cmd, value}`）──
  喂({ kind: 'recent', value: '/a', extra: 1, path: '/x' },
    { cmd: 'open_recent_directory', value: '/a' }, '忽略多余字段');

  // ── ⛔ 不改输入（新窗口拿到的对象是后端刚给的，改它就是第二份状态）──
  const 冻结 = Object.freeze({ kind: 'recent', value: '/a' });
  喂(冻结, { cmd: 'open_recent_directory', value: '/a' }, '冻结输入（改输入会抛）');

  return bad;
}

test('plan：只把 {kind,value} 翻成既有命令名，⛔ 不拼路径 / ⛔ 不猜 kind', function () {
  const WN = require('../../src/services/windownav.js');
  assert.deepStrictEqual(plan问题(WN.plan), []);
});

test('⭐ 变异自测：四种"看起来能用"的坏 plan 都必须被上面的判据打红', function () {
  // ① 直接拿 kind 拼命令名 ⇒ `open_recent`（Rust 侧没有这条命令，静默无反应）
  const 拼名 = function (nav) {
    return { cmd: 'open_' + nav.kind, value: nav.value };
  };
  // ② 只认 recent，其余全当 favorite ⇒ 未知 kind 被猜成收藏
  const 猜一家 = function (nav) {
    if (!nav || !nav.kind || !nav.value) return null;
    return {
      cmd: nav.kind === 'recent' ? 'open_recent_directory' : 'open_favorite',
      value: nav.value,
    };
  };
  // ③ 顺手规范化路径 ⇒ 与用户点的那一条不再逐字一致（后端按原串查表，查不到）
  const 改路径 = function (nav) {
    if (!nav || (nav.kind !== 'recent' && nav.kind !== 'favorite') || !nav.value) return null;
    return {
      cmd: nav.kind === 'recent' ? 'open_recent_directory' : 'open_favorite',
      value: String(nav.value).replace(/\/+$/, ''),
    };
  };
  // ④ 缺 value 也放行 ⇒ 会拿 `undefined` 去 invoke
  const 放行空值 = function (nav) {
    if (!nav || (nav.kind !== 'recent' && nav.kind !== 'favorite')) return null;
    return {
      cmd: nav.kind === 'recent' ? 'open_recent_directory' : 'open_favorite',
      value: nav.value,
    };
  };

  assert.notDeepStrictEqual(plan问题(拼名), [], '⛔ `open_` + kind 的坏实现居然全绿');
  assert.ok(
    plan问题(猜一家).some(function (x) { return x.indexOf('未知 kind') >= 0; }),
    '⛔ 未知 kind 被兜底成 favorite 还没红'
  );
  assert.ok(
    plan问题(改路径).some(function (x) { return x.indexOf('原串回传') >= 0; }),
    '⛔ 路径被规范化还没红'
  );
  assert.ok(
    plan问题(放行空值).some(function (x) { return x.indexOf('缺 value') >= 0; }),
    '⛔ 缺 value 被放行还没红'
  );
});

test('windownav.js 是纯逻辑：⛔ 不碰 IPC、⛔ 不拼路径', function () {
  const src = 去注释(read('src/services/windownav.js'));
  const bad = [];
  if (/__TAURI__/.test(src)) bad.push('出现了 `__TAURI__` —— 本文件不该发 IPC');
  if (/\bT\.call\s*\(/.test(src)) bad.push('出现了 `T.call(` —— 本文件不该发 IPC');
  if (/\binvoke\s*\(/.test(src)) bad.push('出现了 `invoke(` —— 本文件不该发 IPC');
  if (/\bpath\.(?:join|resolve|normalize|dirname|basename|sep)\b/.test(src)) {
    bad.push('出现了路径拼接 / 规范化 —— 授权与路径都由新窗口自己的命令负责');
  }
  assert.deepStrictEqual(bad, []);
});

test('windownav.js 两个口子都要有：`module.exports`（离屏测试）与 `window.rmd`（经典脚本）', function () {
  const src = 去注释(read('src/services/windownav.js'));
  assert.ok(/module\.exports/.test(src), '⛔ 没有 `module.exports` —— `node --test` 取不到');
  assert.ok(/window\.rmd/.test(src), '⛔ 没有挂到 `window.rmd` —— 经典脚本加载后 `main.js` 取不到');
});

// ────────────────────────────────────────────────────────────────
// ② 源码接线：脚本顺序 / 菜单动作 / 启动恢复
// ────────────────────────────────────────────────────────────────

/**
 * `index.html` 的加载顺序：`services/windownav.js` 必须**先于** `main.js`。
 * ⚠️ 经典脚本按出现顺序执行，`main.js` 在**加载期**就取 `window.rmd.windowNav`；
 *    排在后面 ⇒ 取到 `undefined`，而且只有启动恢复这一条路静默失效。
 */
function 脚本顺序问题(html) {
  const src = stripHtmlComments(html);
  const bad = [];
  const atW = src.indexOf('services/windownav.js');
  const atM = src.indexOf('src="main.js"');
  if (atW < 0) bad.push('`index.html` 没有加载 `services/windownav.js`');
  if (atM < 0) bad.push('`index.html` 找不到 `main.js` 的 `<script>`');
  if (atW >= 0 && atM >= 0 && atW > atM) {
    bad.push('`services/windownav.js` 排在 `main.js` 之后（加载期取到 undefined）');
  }
  const 次数 = (src.match(/services\/windownav\.js/g) || []).length;
  if (次数 > 1) bad.push('`services/windownav.js` 被加载了 ' + 次数 + ' 次');
  return bad;
}

/** 取命令串后面那个参数对象（按花括号配平，⛔ 不按"前 N 字符"回看）。 */
function 参数对象(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/** 取 `function name(…) { … }` 的函数体（按花括号配平）。 */
function fnBody(src, name) {
  const head = 'function ' + name + '(';
  const i = String(src).indexOf(head);
  if (i < 0) return '';
  const open = String(src).indexOf('{', i);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, j);
    }
  }
  return '';
}

/**
 * `StartScreen.js` 的两个右键菜单各加一项「在新窗口中打开」。
 *
 * ⚠️ 两种落地形状都收，判的是**同一件事**（菜单项真的把 `kind/value` 交给后端命令）：
 *   ① 直接 `invoke('open_in_new_window', { kind, value })`；
 *   ② `StartScreen` 保持"⛔ 本文件不碰 IPC"的文件头约束，只调
 *      `onOpenInNewWindow(kind, value)`，命令落在 `main.js`（本仓**当前**就是这一种）。
 * ⇒ ② 也必须在**两个菜单函数体**里各出现一次，且 kind 字面量必须是
 *    `favorite` / `recent`；⛔ 不能只在一张菜单里加。
 * 左键 / 回车的既有行为由 `tests/auto/js/bugs-components-b/startscreen.test.js` 的 DOM 用例守。
 */
function 启动页菜单问题(raw) {
  const src = 去注释(raw);
  const bad = [];
  const 直连 = /(?:\binvoke|\.call)\s*\(\s*['"]open_in_new_window['"]\s*,/.test(src);
  const at = src.indexOf('open_in_new_window');

  if (直连) {
    const 对象 = 参数对象(src, at);
    if (!对象) bad.push('`open_in_new_window` 后面没有参数对象');
    else {
      if (!/\bkind\b/.test(对象)) bad.push('参数对象里没有 `kind`');
      if (!/\bvalue\b/.test(对象)) bad.push('参数对象里没有 `value`');
    }
  } else if (/onOpenInNewWindow\s*\(/.test(src)) {
    // ⭐ 回调形状：两张菜单各交一次，且 kind 与菜单语义对得上。
    const 期望 = [['openFavMenu', 'favorite'], ['openRecentMenu', 'recent']];
    期望.forEach(function (pair) {
      const body = fnBody(src, pair[0]);
      if (!body) {
        bad.push('`StartScreen.js` 找不到 `' + pair[0] + '` —— 这条判据失去靶子');
      } else if (!new RegExp("onOpenInNewWindow\\s*\\(\\s*'" + pair[1] + "'\\s*,").test(body)) {
        bad.push('`' + pair[0] + '` 没有 `onOpenInNewWindow(\'' + pair[1] + '\', …)` —— 菜单项少了一半');
      }
    });
  } else {
    bad.push('`StartScreen.js` 里没有打开新窗口的动作 —— 右键菜单没有这一项');
    return bad;
  }

  // ⚠️ 菜单项**不放加速键**：这里出现键位字面量，说明有人把 `⇧⌘N` 也画进了右键菜单，
  //    与原生菜单的加速键撞车（`INV-SET-04`：按一次动两次）。
  if (/(?:Cmd|Ctrl|Shift|Alt|Opt)\s*\+/.test(src)) {
    bad.push('`StartScreen.js` 出现 `Cmd+` 之类的键位字面量（菜单项不该带加速键）');
  }
  if (/[⌘⇧⌥⌃]/.test(src)) {
    bad.push('`StartScreen.js` 出现键位符号（菜单项不该带加速键）');
  }
  return bad;
}

/**
 * `main.js` 启动流程末尾：拉一次 `take_pending_navigation()`，
 * 有值就经 `windownav.plan()` 走既有命令。
 *
 * ⚠️ 按任务口径只钉"拉了 + 引用了 windownav + 调了 plan"；
 *    "结果真的进了既有命令"由 `plan()` 的返回值形状与
 *    `windownav.js` 的纯逻辑判据共同保证。
 */
function 启动恢复问题(raw) {
  const src = 去注释(raw);
  const bad = [];
  if (src.indexOf('take_pending_navigation') < 0) {
    bad.push('`main.js` 没有 `take_pending_navigation` —— 新窗口永远停在导航页');
  }
  if (!/windownav/i.test(src)) {
    bad.push('`main.js` 没有引用 `windownav` —— 拉到的目标没人翻译成既有命令');
  }
  if (!/\bplan\s*\(/.test(src)) {
    bad.push('`main.js` 没有调用 `windownav` 的 `plan()`');
  }
  // ⭐ 「在新窗口中打开」的**命令落点**：`StartScreen` 只交 `(kind, value)`，
  //    真正发 IPC 的是这里（`T.call('open_in_new_window', {kind, value})`）。
  const at = src.indexOf("open_in_new_window");
  if (at < 0) {
    bad.push('`main.js` 没有 `open_in_new_window` —— 右键菜单的动作没有落点');
  } else {
    if (!/(?:\binvoke|\.call)\s*\(\s*['"]open_in_new_window['"]\s*,/.test(src)) {
      bad.push('`open_in_new_window` 不是 `invoke(...)` / `T.call(...)` 的命令参数');
    }
    const 对象 = 参数对象(src, at);
    if (!对象) bad.push('`open_in_new_window` 后面没有参数对象');
    else {
      if (!/\bkind\b/.test(对象)) bad.push('`open_in_new_window` 的参数对象里没有 `kind`');
      if (!/\bvalue\b/.test(对象)) bad.push('`open_in_new_window` 的参数对象里没有 `value`');
    }
  }
  return bad;
}

test('接线：`index.html` 里 `windownav.js` 先于 `main.js`', function () {
  assert.deepStrictEqual(脚本顺序问题(read('src/index.html')), []);
});

test('接线：`StartScreen.js` 的两张右键菜单都有「在新窗口中打开」，且不带键位字面量', function () {
  assert.deepStrictEqual(启动页菜单问题(read('src/components/StartScreen.js')), []);
});

test('接线：`main.js` 启动末尾拉 `take_pending_navigation` 并经 `windownav.plan()`', function () {
  assert.deepStrictEqual(启动恢复问题(read('src/main.js')), []);
});

// ────────────────────────────────────────────────────────────────
// ③ 变异自测：静态判据拿坏副本再问一次
// ────────────────────────────────────────────────────────────────

test('⭐ 变异自测：脚本顺序 / 菜单动作 / 启动恢复，每种坏法都必须变红', function () {
  const 变红 = function (bad, 片段, 名) {
    assert.ok(
      bad.some(function (x) { return x.indexOf(片段) >= 0; }),
      '⛔ ' + 名 + '：变异没被抓到（判据恒真）\n实际：' + JSON.stringify(bad)
    );
  };

  // ── 脚本顺序 ──
  const 好HTML = '<script src="services/windownav.js"></script>\n<script src="main.js"></script>';
  assert.deepStrictEqual(脚本顺序问题(好HTML), [], '好 HTML 被误判');
  变红(
    脚本顺序问题('<script src="services/windownav.js"></script>'),
    '找不到 `main.js`',
    '缺 main.js'
  );
  变红(
    脚本顺序问题('<script src="main.js"></script>\n<script src="services/windownav.js"></script>'),
    '排在 `main.js` 之后',
    '顺序反了'
  );
  变红(
    脚本顺序问题('<script src="main.js"></script>'),
    '没有加载 `services/windownav.js`',
    '漏装脚本'
  );

  // ── 菜单动作 ──
  const 命令 = "T.call('open_in_new_window', { kind: kind, value: value });";
  const 好回调 =
    "function openFavMenu(i) { onOpenInNewWindow('favorite', r.path); }\n" +
    "function openRecentMenu(i) { onOpenInNewWindow('recent', r.root); }";
  assert.deepStrictEqual(启动页菜单问题(命令), [], '直接 invoke 的好菜单被误判');
  assert.deepStrictEqual(启动页菜单问题(好回调), [], '回调形状的好菜单被误判');
  变红(
    启动页菜单问题("T.call('open_in_new_window', { kind: kind });"),
    '没有 `value`',
    '参数漏 value'
  );
  变红(
    启动页菜单问题("T.call('open_in_new_window', { value: value });"),
    '没有 `kind`',
    '参数漏 kind'
  );
  变红(
    启动页菜单问题("function openFavMenu(i) { onOpenInNewWindow('recent', r.path); }\n" +
      "function openRecentMenu(i) { onOpenInNewWindow('recent', r.root); }"),
    "openFavMenu` 没有 `onOpenInNewWindow('favorite'",
    '收藏菜单的 kind 写错'
  );
  变红(
    启动页菜单问题("function openRecentMenu(i) { onOpenInNewWindow('recent', r.root); }"),
    '找不到 `openFavMenu`',
    '只给一张菜单加了项'
  );
  变红(
    启动页菜单问题(命令 + " var 提示 = 'Cmd+Shift+N';"),
    '键位字面量',
    '菜单项带了加速键'
  );
  // 反面对照：**注释里**写键位不算实现（剥注释真的生效了，⛔ 别把注释判成缺陷）。
  assert.deepStrictEqual(
    启动页菜单问题("/* 注释里写 Cmd+Shift+N 不算 */ " + 命令),
    [],
    '⛔ 注释里的键位被当成了实现（剥注释失效）'
  );

  // ── 启动恢复 / 命令落点 ──
  const 好启动 = "async function boot(){\n" + 命令 + "\n"
    + "const nav = await T.call('take_pending_navigation');\n"
    + 'const 计划 = window.rmd.windowNav.plan(nav);\n'
    + 'if (计划) await window.rmd.tauri.call(计划.cmd, { value: 计划.value });\n}';
  assert.deepStrictEqual(启动恢复问题(好启动), [], '好启动流程被误判');
  变红(
    启动恢复问题("const 计划 = window.rmd.windowNav.plan(null); " + 命令),
    '没有 `take_pending_navigation`',
    '没拉 pending'
  );
  变红(
    启动恢复问题("const nav = await T.call('take_pending_navigation'); " + 命令),
    '没有引用 `windownav`',
    '没引用模块'
  );
  变红(
    启动恢复问题("const nav = await T.call('take_pending_navigation'); window.rmd.windowNav; " + 命令),
    '没有调用 `windownav` 的 `plan()`',
    '没调 plan'
  );
  变红(
    启动恢复问题("const nav = await T.call('take_pending_navigation'); " +
      'window.rmd.windowNav.plan(nav);'),
    '没有 `open_in_new_window`',
    '右键菜单没有命令落点'
  );
  变红(
    启动恢复问题("const nav = await T.call('take_pending_navigation'); " +
      "window.rmd.windowNav.plan(nav); T.call('open_in_new_window', { kind: kind });"),
    '没有 `value`',
    '命令参数漏 value'
  );
});
