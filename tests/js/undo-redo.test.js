// `bugs/0020` §8（提交之后 `⌘Z` 不好使，2026-11-02）的**源码级闸门**。
//
// ⭐ 为什么这一格必须是源码级：这一族的失效形态**全部不报错**——
//   ① 两个键**不在**唯一键位表里 ⇒ 阅读态按 `⌘Z` 什么都不发生（提交栈没有主人）；
//   ② 进了表但**没挂 handler** ⇒ `checkActions` 会在启动时喊，可如果有人把那条自检
//      放软了，表现仍然是"按下去没反应"；
//   ③ 就地编辑态的认领**排在 `K.matchEvent` 之后** ⇒ `⌘Z` 被 `forwardShim` 转发出块，
//      块内 CM6 历史（层①）与文档提交栈（层②）当场分叉——一次 `⌘Z` 可能退整段；
//   ④ 控制器 `undo()` 仍在调 `session.undo()`（内部回滚那条）⇒ `⇧⌘Z` 永远没有东西可重做，
//      而界面上"撤销"看起来完全正常；
//   ⑤ `Menu::default` 里 `muda` 的预定义 `Undo` / `Redo` **自带** `⌘Z` / `⇧⌘Z`
//      的 NSMenuItem key equivalent ⇒ AppKit 在 key window 之前就把键吃掉
//      （`docs/bugs/0310` 真机根因；离屏探针看不见这一层）。
//      必须摘掉那两项，再用同两个格子放回**无加速键**的自己人。
//   ⇒ 五条都只能读源码判。
//
// ⚠️ 判据对**注释免疫**（注释里大量引用"⛔ 别写成 X"）：先 `strip*` 再判。
// ⚠️ 变异自测在末尾：同一套判据喂给"故意写坏的副本"必须**各自**变红。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const LIVE = fs.readFileSync(path.join(ROOT, 'src', 'live', 'index.js'), 'utf8');
const RUST = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'gui', 'mod.rs'), 'utf8');
const I18N = fs.readFileSync(path.join(ROOT, 'src', 'services', 'i18n.js'), 'utf8');

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

/**
 * @param {{main:string, live:string, rust:string, i18n:string}} src 四份**原始**源码
 * @returns {string[]} 问题清单（空 = 全过）
 */
function score(src) {
  const main = stripLineComments(stripBlockComments(src.main));
  const live = stripLineComments(stripBlockComments(src.live));
  const rust = stripLineComments(src.rust);
  // ⚠️ `i18n.js` **不挖注释**：它的词条里有 `/*` 形状的串（URL / 样式片段），
  //    按块注释整段挖空会连整张词表一起吃掉（实测：59120 字节 → 全空）。
  const i18n = String(src.i18n);
  const bad = [];

  // ── ① 表里两项都在，accel 与 owner 正确 ──────────────────────────────
  //    ⚠️ 只在 `SHORTCUTS` 表**段内**找：`id: "edit.undo"` 现在**出现两次**
  //       （表里一行 ＋ `PLAIN_MENU_ITEMS` 的 `Edit` 第 0 格），整文件 `indexOf`
  //       会看串到菜单项上、把"表里没有"误判成"有"。
  const 表起 = rust.indexOf('const SHORTCUTS');
  const 表终 = rust.indexOf('const PLAIN_MENU_ITEMS');
  const 快捷表 = 表起 < 0 || 表终 <= 表起 ? '' : rust.slice(表起, 表终);
  const 表项 = function (id, accel, msg) {
    const at = 快捷表.indexOf('id: "' + id + '"');
    if (at < 0) {
      bad.push('`SHORTCUTS` 里没有 `' + id + '` —— ' + msg);
      return;
    }
    const tail = 快捷表.slice(at, at + 320);
    if (tail.indexOf(accel) < 0) bad.push('`' + id + '` 的 accel 不是 `' + accel + '`');
    if (tail.indexOf('Owner::Web') < 0) bad.push('`' + id + '` 不是 `Owner::Web`（作用域在文档/编辑器里）');
  };
  // ⚠️ `edit.undo` 的 accel 是 `Cmd+Z`；`edit.redo` 是 `Shift+Cmd+Z`（muda 的修饰键在前）。
  表项('edit.undo', 'Cmd+Z', '阅读态按 `⌘Z` 什么也不会发生（提交栈没有主人）');
  表项('edit.redo', 'Shift+Cmd+Z', '`⇧⌘Z` 没有主人');

  // ── ② `Edit` 顶部两项必须换成**无加速键**的自己人，且预定义项先摘掉 ──────
  //    ⚠️⚠️ 2026-11-11（`bugs/0310`）**翻转了旧结论**：旧判据是"⛔ 不进 `PLAIN_MENU_ITEMS`"，
  //      但真机取证发现救不了——`muda 0.20.0` 的预定义 `Undo` / `Redo` **自带**
  //      `⌘Z` / `⇧⌘Z` 的 NSMenuItem key equivalent（`items/predefined.rs` +
  //      `platform_impl/macos/mod.rs`）⇒ AppKit 在事件送达 key window **之前**就消费掉，
  //      前端 `keydown` 一条都收不到。⇒ 必须**摘掉预定义项**，再用同两个格子
  //      （`position: 0/1`）放回我们自己的无加速键项，菜单项序一个位置都不变。
  //    ⇒ 现在两条一起判：① 表里有我们的人（否则菜单顶部留两个空洞）；
  //      ② `install_menu` 真的摘了**两项**（只摘一项 = `⇧⌘Z` 仍被吞）。
  const 菜单起 = rust.indexOf('const PLAIN_MENU_ITEMS');
  const 菜单终 = 菜单起 < 0 ? -1 : rust.indexOf('];', 菜单起);
  if (菜单起 < 0 || 菜单终 < 0) {
    bad.push('找不到 `PLAIN_MENU_ITEMS` 表 —— 这条判据失去靶子');
  } else {
    const 菜单 = rust.slice(菜单起, 菜单终);
    const 位 = {};
    const re = /PlainMenuItem\s*\{([\s\S]*?)\}/g;
    let m;
    while ((m = re.exec(菜单))) {
      const 体 = m[1];
      const 子 = /submenu:\s*"([^"]+)"/.exec(体);
      const pos = /position:\s*(\d+)/.exec(体);
      const id = /id:\s*"([^"]+)"/.exec(体);
      if (子 && pos && id && 子[1] === 'Edit') 位[id[1]] = Number(pos[1]);
    }
    if (位['edit.undo'] !== 0) {
      bad.push('`PLAIN_MENU_ITEMS` 的 `Edit` 组里没有 `edit.undo` 占回第 0 格 —— '
        + '摘掉预定义 `Undo` 之后菜单顶部留了个空洞');
    }
    if (位['edit.redo'] !== 1) {
      bad.push('`PLAIN_MENU_ITEMS` 的 `Edit` 组里没有 `edit.redo` 占回第 1 格 —— 同上');
    }
  }
  // ⚠️ **无加速键**不能只看表：`PlainMenuItem` 结构里根本没有 accel 字段，
  //    风险在插入循环偷偷补一句 `.accelerator(...)`（那样 `⌘Z` 又回到 AppKit 手里）。
  // ⭐ 2026-11-15（`design/0071` §5.2，阶段 4）：位置表里第一次出现 `Owner::Menu`
  //    的项（`File ▸ 新建窗口`）——它**必须**在这里装原生加速键。⇒ 把判据从
  //    "整段一条都不许有"收成"**每一处** `.accelerator(` 都必须落在
  //    `if s.owner == Owner::Menu` 的守卫块里"。⚠️ 原意（`⌘Z` 不许被无条件加速）
  //    一个字没放宽：`edit.undo` / `edit.redo` 是 `Owner::Web`，走不进那个守卫。
  const 插起 = rust.indexOf('for (p, place) in group');
  const 插终 = rust.indexOf('app.set_menu(menu)');
  const 插体 = 插起 < 0 || 插终 <= 插起
    ? ''
    : stripBlockComments(rust.slice(插起, 插终));
  if (!插体) {
    bad.push('找不到 `PLAIN_MENU_ITEMS` 的插入循环 —— 「无加速键」这条判据失去靶子');
  } else {
    const 加速次数 = (插体.match(/\.accelerator\s*\(/g) || []).length;
    const 守卫次数 = (插体.match(
      /if\s*\(?\s*s\.owner\s*==\s*Owner::Menu\s*\)?\s*\{[\s\S]{0,200}?\.accelerator\s*\(/g
    ) || []).length;
    if (加速次数 > 0 && 守卫次数 !== 加速次数) {
      bad.push('`PLAIN_MENU_ITEMS` 的插入循环里有**没有 `Owner::Menu` 守卫**的 `.accelerator(...)` —— '
        + '`⌘Z` 会被 AppKit 先吃，块内（CM6 `history()`）静默失效');
    }
  }
  const 摘起 = rust.indexOf('sub.remove_at(0)');
  if (摘起 < 0) {
    bad.push('`install_menu` 没有摘掉 `Menu::default` 预定义的 `Undo` / `Redo`'
      + '（`sub.remove_at(0)`）—— 那两个 key equivalent 会把 `⌘Z` 吞在 AppKit 那一层');
  } else {
    const 摘段 = rust.slice(Math.max(0, 摘起 - 600), 摘起);
    if (摘段.indexOf('for _ in 0..2') < 0) {
      bad.push('摘预定义项的不是"两次"（`for _ in 0..2`）—— 只摘一项会留下 `Redo`，`⇧⌘Z` 仍被吞');
    }
    if (摘段.indexOf('submenu_titles("Edit")') < 0) {
      bad.push('摘的不是 `Edit` 子菜单 —— 摘错了子菜单会少掉 `Cut` / `Copy` 之类，看不出来');
    }
  }

  // ── ③ 前端两个 id 都挂了 handler ─────────────────────────────────────
  if (main.indexOf("keymap.register('edit.undo'") < 0) {
    bad.push("`main.js` 没有 `keymap.register('edit.undo')` —— 键进表了但没人接");
  }
  if (main.indexOf("keymap.register('edit.redo'") < 0) {
    bad.push("`main.js` 没有 `keymap.register('edit.redo')` —— `⇧⌘Z` 没人接");
  }

  // ── ④ 就地编辑态的 `⌘Z` 认领必须排在 `K.matchEvent` 之前 ────────────
  const 认领 = main.indexOf("if (mods.cmd && (ev.key === 'z' || ev.key === 'Z'))");
  const 匹配 = main.indexOf('K.matchEvent(keymap.bindings, ev)');
  if (认领 < 0) {
    bad.push('`makeLiveView::onKeyDown` 没有认领 `⌘Z` / `⇧⌘Z` —— 块内撤销没有落点');
  } else if (匹配 >= 0 && 认领 > 匹配) {
    bad.push('`⌘Z` 的认领排在 `K.matchEvent` **之后** —— 键会被 `forwardShim` 转发出块，'
      + '块内 CM6 历史与文档提交栈当场分叉');
  }

  // ── ⑤ 控制器：用户撤销走 `undoEdit`，且有 `redo` ─────────────────────
  //    ⚠️ `design/0058` 起真正的落地在 `undoTop()` 的 `apply` 里（`undo()` 只是调用方），
  //    判据跟着下沉：**用户那条**必须经 `undoTop` 且不许选内部回滚的 `pop: true`。
  const undo起 = live.indexOf('async function undo()');
  const redo起 = live.indexOf('async function redo()');
  const top起 = live.indexOf('async function undoTop(');
  const top终 = live.indexOf('async function redoTop(');
  const redoTop起 = top终;
  if (undo起 < 0) {
    bad.push('`src/live/index.js` 找不到 `async function undo()` —— 这条判据失去靶子');
  } else {
    const undo体 = live.slice(undo起, redo起 > undo起 ? redo起 : undo起 + 1600);
    if (undo体.indexOf('undoTop(') < 0) {
      bad.push('控制器 `undo()` 不走统一事务入口 `undoTop` —— 撤销的失败回滚与重做栈都没人管');
    } else if (undo体.indexOf('pop: true') >= 0) {
      bad.push('控制器 `undo()` 走的是 `session.undo()`（内部回滚那条）—— 重做栈会被漏记');
    }
  }
  const undoTop体 = top起 < 0 ? '' : live.slice(top起, top终 > top起 ? top终 : top起 + 1200);
  if (!undoTop体) {
    bad.push('`src/live/index.js` 找不到 `async function undoTop()` —— 这条判据失去靶子');
  } else {
    if (undoTop体.indexOf('session.undoEdit()') < 0) {
      bad.push('`undoTop()` 不走 `session.undoEdit()` —— 撤销的条目进不了重做栈，'
        + '`⇧⌘Z` 永远没有东西可重做');
    }
    if (undoTop体.indexOf('runTransaction(') < 0) {
      bad.push('`undoTop()` 绕过统一事务入口 —— 撤销失败时没有成对回滚（`design/0058` §2.2）');
    }
  }
  const redoTop体 = redoTop起 < 0 ? ''
    : live.slice(redoTop起, redoTop起 + 1200);
  if (!redoTop体 || redoTop体.indexOf('session.redo()') < 0) {
    bad.push('`redoTop()` 不走 `session.redo()` —— 重做没有落地路径');
  }
  if (redo起 < 0) {
    bad.push('`src/live/index.js` 没有 `async function redo()` —— `⇧⌘Z` 没有落点');
  } else if (live.indexOf('redo: redo') < 0) {
    bad.push('控制器 api 没有导出 `redo` —— `main.js` 拿不到它');
  }

  // ── ⑥ 两条文案两种语言都在（⛔ 缺席时状态条会显示 key 本身）────────────
  ['status.live-redo', 'status.live-nothing-to-redo'].forEach(function (k) {
    const n = (i18n.match(new RegExp("'" + k + "'", 'g')) || []).length;
    if (n < 2) bad.push('`i18n.js` 的 `' + k + '` 只有 ' + n + ' 份 —— zh / en 必须各一份');
  });

  // ── ⑦ 撤销/重做**失败必须回滚**（评审 P0）────────────────────────────
  //    ⚠️ 旧形态是"失败后补一个 `res.revert()`"，那是 `design/0058` §1.2 点名的**第二条路**：
  //    真值已经前进、屏幕还是旧的，靠调用方记得收拾。现在回滚由统一事务入口的 T0 快照做，
  //    判据改成"**必须经那条路**"——绕过它就没有回滚，`⌘S` 会写出没显示过的内容。
  const 撤销体 = undo起 < 0 ? '' : live.slice(undo起, redo起 > undo起 ? redo起 : undo起 + 1600);
  const 重做体 = redo起 < 0 ? ''
    : live.slice(redo起, redoTop起 > redo起 ? redoTop起 : redo起 + 1200);
  if (撤销体.indexOf('undoTop(') < 0) {
    bad.push('控制器 `undo()` 提交失败时没有回滚（未经 `undoTop` → 无 T0 快照）'
      + ' —— 屏幕上没显示过的内容会被 `⌘S` 写盘');
  }
  if (重做体.indexOf('redoTop(') < 0) {
    bad.push('控制器 `redo()` 提交失败时没有回滚（未经 `redoTop` → 无 T0 快照） —— 同上');
  }

  // ── ⑧ 覆盖层开着时 ⛔ 不碰正文（评审 P1-3）───────────────────────────
  const 分派起 = main.indexOf('function undoOrRedo(');
  if (分派起 < 0) {
    bad.push('`main.js` 找不到 `undoOrRedo(` —— 这条判据失去靶子');
  } else {
    const 分派体 = main.slice(分派起, 分派起 + 1200);
    const 覆盖层 = 分派体.indexOf('overlayOpen()');
    const 分栏 = 分派体.indexOf('editor.isMounted()');
    if (覆盖层 < 0) {
      bad.push('`undoOrRedo` 没有覆盖层门控 —— 设置面板里聚焦 button / select 时 `⌘Z` 会撤掉背后的正文');
    } else if (分栏 >= 0 && 覆盖层 > 分栏) {
      bad.push('`undoOrRedo` 的覆盖层门控排在分栏分支**之后** —— 覆盖层里按 `⌘Z` 仍会先动编辑器');
    }
  }

  // ── ⑨ 没有会话时也要说一句（评审 P2-5）───────────────────────────────
  //    ⚠️ 只看 `if (!session)` 到 `if (!res)` 之间那一段：后面「没有可撤的」那句
  //    也在同一个函数里，整段搜会漏掉"没有会话时静默返回"。
  //    ⚠️ 上界取**事务入口**（`undoTop(`），⛔ 不取 `if (!res)`（那个形状已经不存在）；
  //    取错上界会把事务**之后**那句「没有可撤的」也算进来 ⇒ 变异静默落空。
  const 无会话起 = 撤销体.indexOf('if (!session)');
  const 无会话终 = 撤销体.indexOf('undoTop(');
  const 无会话体 = 无会话起 < 0 ? ''
    : 撤销体.slice(无会话起, 无会话终 > 无会话起 ? 无会话终 : 无会话起 + 240);
  if (无会话体.indexOf('status.live-nothing-to-undo') < 0) {
    bad.push('控制器 `undo()` 在没有会话时静默返回 —— 阅读态第一次 `⌘Z` 什么都不说');
  }

  return bad;
}

const REAL = { main: MAIN, live: LIVE, rust: RUST, i18n: I18N };

test('`⌘Z` / `⇧⌘Z`：表里有主、前端有 handler、就地编辑自己认领、预定义菜单项摘掉、重做那一半也在', function () {
  const bad = score(REAL);
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});

test('⭐ 判据自检：十处各自喂坏源码，必须**各自**变红（⛔ 不许有一条恒真）', function () {
  const 变红 = function (src, 词) {
    const bad = score(Object.assign({}, REAL, src));
    assert.ok(bad.length > 0, '变异没有让任何判据变红 —— 判据没看那一处');
    assert.ok(bad.some(function (x) { return x.indexOf(词) >= 0; }), '没有命中预期的判据「' + 词 + '」：' + bad.join(' | '));
  };

  // ① 表里没有 `edit.undo`
  const noRow = RUST.replace('id: "edit.undo"', 'id: "edit.xxx"');
  assert.notStrictEqual(noRow, RUST, 'M-a 变异没改到源码');
  变红({ rust: noRow }, 'SHORTCUTS');

  // ② `Menu::default` 的预定义 `Undo` / `Redo` 没摘干净（只摘一项 ⇒ `⇧⌘Z` 仍被 AppKit 吞）
  const 摘一项 = RUST.replace('for _ in 0..2 {', 'for _ in 0..1 {');
  assert.notStrictEqual(摘一项, RUST, 'M-b 变异没改到源码');
  变红({ rust: 摘一项 }, '两次');

  // ②′ 我们自己的项没占回 `Edit` 的第 0 格（摘完预定义项后菜单顶部留空洞）
  const 无占位 = RUST.replace(
    '    PlainMenuItem {\n        submenu: "Edit",\n        position: 0,\n        sep: SepSide::None,\n        id: "edit.undo",\n    },',
    ''
  );
  assert.notStrictEqual(无占位, RUST, 'M-b2 变异没改到源码');
  变红({ rust: 无占位 }, 'edit.undo');

  // ③ 没挂 handler
  const noHandler = MAIN.replace("keymap.register('edit.redo'", "keymap.register('edit.xxx'");
  assert.notStrictEqual(noHandler, MAIN, 'M-c 变异没改到源码');
  变红({ main: noHandler }, 'keymap.register');

  // ④ 认领挪到 `K.matchEvent` 之后
  const EARLY = "      if (mods.cmd && (ev.key === 'z' || ev.key === 'Z')) {\n"
    + '        ev.preventDefault();\n'
    + '        if (mods.shift) redoOnce(); else undoOnce();\n'
    + '        return;\n'
    + '      }\n';
  assert.ok(MAIN.indexOf(EARLY) >= 0, 'M-d 找不到要挪走的那一段（源码形状变了）');
  const lateClaim = MAIN.replace(EARLY, '')
    .replace('if (forwardShim) forwardShim.forward(id);',
      'if (forwardShim) forwardShim.forward(id);\n        '
      + "if (mods.cmd && (ev.key === 'z' || ev.key === 'Z')) { ev.preventDefault(); if (mods.shift) redoOnce(); else undoOnce(); return; }");
  assert.notStrictEqual(lateClaim, MAIN, 'M-d 变异没改到源码');
  变红({ main: lateClaim }, 'K.matchEvent');

  // ⑤ 控制器撤销退回内部回滚那条（`undoTop` 的 apply 永远用 `session.undo()`）
  const 回滚 = LIVE.replace(
    'const r = opts.pop ? session.undo() : session.undoEdit();',
    'const r = session.undo();');
  assert.notStrictEqual(回滚, LIVE, 'M-e 变异没改到源码');
  变红({ live: 回滚 }, 'session.undoEdit');

  // ⑥ 少一份英文文案
  const noEn = I18N.replace("'status.live-redo': 'Redid the last undo',\n", '');
  assert.notStrictEqual(noEn, I18N, 'M-f 变异没改到源码');
  变红({ i18n: noEn }, 'status.live-redo');

  // ⑦ 重做绕过统一入口（评审 P0 的新形态：没有 T0 快照 ⇒ 失败时真值前进、屏幕不动）
  const 不回滚 = LIVE.replace(
    "const out = await redoTop();",
    'const out = await undoTop({ operation: \'redo\' });'
  );
  assert.notStrictEqual(不回滚, LIVE, 'M-g 变异没改到源码');
  变红({ live: 不回滚 }, 'redoTop');

  // ⑧ 拆掉覆盖层门控（评审 P1-3）
  const 无门控 = MAIN.replace('    if (overlayOpen()) return;\n', '');
  assert.notStrictEqual(无门控, MAIN, 'M-h 变异没改到源码');
  变红({ main: 无门控 }, '覆盖层门控');

  // ⑩ 插入循环里把 `Owner::Menu` 守卫摘掉（`⌘Z` 那两项也会被无条件加速）
  const 无守卫 = RUST.replace(
    '                if s.owner == Owner::Menu {\n'
    + '                    builder = builder.accelerator(s.accel);\n'
    + '                }\n',
    '                builder = builder.accelerator(s.accel);\n'
  );
  assert.notStrictEqual(无守卫, RUST, 'M-j 变异没改到源码');
  变红({ rust: 无守卫 }, '没有 `Owner::Menu` 守卫');
});
