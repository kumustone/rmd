// ⭐ `design/0056`（`⌘L` = 关掉当前文档、回到导航页；2026-11-11 由裸 `F2` 改来、2026-11-16 定为 `⌘L`）与 `design/0057`
//    （`文件 ▸ 收藏 / 取消收藏`，`⌘D`）的**接线闸门**。
//
// # 为什么这两条只能验"接线"，不能验"行为"
//
// 它们的真行为要**真的按一下 ⌘L** / **真的点一次原生菜单**才看得见，而本项目
// ⛔ 禁止合成按键、⛔ 禁止抢焦点（`CLAUDE.md` 的「高代价错误必须避免」那一条）。
// ⇒ 自动化的那一半只能是**结构判据**：表里有、三处命令清单里有、前端真的挂了 handler、
//    **实现顺序对**、**身份字段取对了**。真按键的部分登记为**人工验收**（设计 §10）。
//
// ⚠️⚠️ 这里有两条会**静默错**的判据，所以必须钉住：
//   · **顺序**：`flushReadingProgress()` 必须排在 `S.closeDocument()` **之前**——
//     反过来就是"身份已经没了才去写进度"，后端按 `doc_seq` 判陈旧，**一声不响**地丢。
//   · **身份字段**：`session.js::closeDocument` 必须取 `currentDoc.doc_seq`，
//     ⛔ 不是 `state.docSeq`（后者只随**快照**更新，而"打开文档"不走快照）
//     ⇒ 用错字段的形态是"⌘L 按下去毫无反应"，日志里只有一行"不动"。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

/** `/* … *\/` 整块挖掉（判据要在**实现**上成立，⛔ 不能在注释上成立）。 */
function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 逐行挖掉 `//` 之后的部分（字符串里的 `//` 不动：ui 文案里没有，URL 里那颗核对过）。 */
function stripLineComments(src) {
  return src.split('\n').map(function (line) {
    const i = line.indexOf('//');
    if (i < 0) return line;
    const before = line.slice(0, i);
    const quotes = (before.match(/["']/g) || []).length;
    if (quotes % 2 === 1) return line;
    return before;
  }).join('\n');
}

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/** 三份**原始**源码（判据内部各自挖空注释；变异自测要拿"写坏的副本"再判一次）。 */
function load() {
  return {
    rust: read('src-tauri/src/gui/mod.rs'),
    build: read('src-tauri/build.rs'),
    caps: read('src-tauri/capabilities/default.json'),
    main: read('src/main.js'),
    session: read('src/services/session.js'),
  };
}

/**
 * 判据本体。
 *
 * @param {object} src 五份**原始**源码
 * @returns {string[]} 问题清单（空 = 全过）
 */
function score(src) {
  const rust = stripLineComments(stripBlockComments(src.rust));
  const build = stripLineComments(stripBlockComments(src.build));
  const caps = stripBlockComments(src.caps);
  const main = stripLineComments(stripBlockComments(src.main));
  const session = stripLineComments(stripBlockComments(src.session));
  const bad = [];

  // ── ① 表里两条都在，键位与 owner 都对（`INV-SET-01`）──
  const 表项 = function (id, accel, 名) {
    const at = rust.indexOf('id: "' + id + '"');
    if (at < 0) { bad.push('`SHORTCUTS` 里没有 `' + id + '` —— ' + 名); return; }
    const tail = rust.slice(at, at + 400);
    if (tail.indexOf('accel: "' + accel + '"') < 0) bad.push('`' + id + '` 的 accel 不是 `' + accel + '`');
    if (tail.indexOf('Owner::Web') < 0) bad.push('`' + id + '` 不是 `Owner::Web`（不装原生加速键，以免按一次动两次）');
  };
  表项('view.start', 'Cmd+L', '`⌘L` 变了没人知道（导航页没有入口）');
  表项('file.toggle-favorite', 'Cmd+D', '`⌘D` 变了没人知道（收藏入口消失了）');

  // ── ② `view.start` **不进菜单**（`design/0056` §2.1：展示位只有设置覆盖层）──
  // ⚠️ 判据是"整份 `gui/mod.rs` 里只出现一次"——多出来那次就说明它被插进了菜单表。
  const 次数 = function (hay, needle) { return hay.split(needle).length - 1; };
  if (次数(rust, '"view.start"') !== 1) {
    bad.push('`view.start` 在 `gui/mod.rs` 里出现了 ' + 次数(rust, '"view.start"')
      + ' 次 —— 它只该有一条 `SHORTCUTS` 表项（⛔ 不进菜单，`design/0056` §2.1）');
  }

  // ── ③ `file.toggle-favorite` 真的进了 `File` 菜单，位置 4、下分隔线（`design/0057` §2.1 ②）──
  const 菜单区 = (function () {
    const a = rust.indexOf('const PLAIN_MENU_ITEMS');
    const b = rust.indexOf('];', a);
    return a < 0 || b < 0 ? '' : rust.slice(a, b);
  })();
  if (!菜单区) {
    bad.push('找不到 `PLAIN_MENU_ITEMS` 表');
  } else {
    // ⚠️ 逐块解析 `PlainMenuItem { … }`。⛔ 别用"命中处往前 260 字符"那种回看窗口：
    //    `position: 4` 在**邻居**身上也出现过（`file.save`）⇒ 位置漂了也照样绿。
    //    `design/0071` 阶段 3 往 `File` 顶部插了 `file.new`，整组 `position` 各 +1，
    //    正是这种漂移（详见 `start.test.js` 同名收紧）。
    const 菜单项 = function (id) {
      const blocks = 菜单区.split('PlainMenuItem {').slice(1);
      for (let i = 0; i < blocks.length; i++) {
        const body = blocks[i].slice(0, blocks[i].indexOf('}'));
        const m = /id: "([^"]+)"/.exec(body);
        if (m && m[1] === id) return body;
      }
      return '';
    };
    const 项 = 菜单项('file.toggle-favorite');
    if (!项) {
      bad.push('`PLAIN_MENU_ITEMS` 里没有 `file.toggle-favorite` —— 菜单里根本没有这一项');
    } else {
      // ⭐ `design/0083` §2.2（2026-11-15）：`File` 顶部又插了 `新建标签页`（位置 0）
      //    ＋ `新建窗口`（位置 1）⇒ 这一项与它下面那项**再各 +1**（8→9、9→10）。
      if (!/position:\s*9,/.test(项)) bad.push('`file.toggle-favorite` 的 `position` 不是 9');
      if (项.indexOf('SepSide::After') < 0) bad.push('`file.toggle-favorite` 的下分隔线不是 `SepSide::After`');
      if (项.indexOf('"File"') < 0) bad.push('`file.toggle-favorite` 不在 `File` 子菜单里');
    }
    // ⚠️ 插进来一项 ⇒ 后面那项**必须**顺延，否则两项落到同一格（那条单测会红）。
    const 外部 = 菜单项('file.open-external-editor');
    if (!外部 || !/position:\s*10,/.test(外部)) {
      bad.push('`file.open-external-editor` 没有顺延到 `position: 10`（`design/0071` §4.2/§5，`design/0076` 再顺延，`design/0083` 三顺延）');
    }
  }

  // ── ④ 三处命令清单（⛔ 漏一处就是 ACL 静默拒：`kb/0007`）──
  if (build.indexOf('"close_document"') < 0) bad.push('`build.rs::commands()` 少了 `close_document`（ACL 静默拒）');
  if (caps.indexOf('"allow-close-document"') < 0) bad.push('`capabilities/default.json` 少了 `allow-close-document`（ACL 静默拒）');
  if (rust.indexOf('document::close_document') < 0) bad.push('`invoke_handler` 少了 `document::close_document`');

  // ── ⑤ 前端两个 handler（`INV-SET-02`②：表里有、代码没有 = 按下去没反应）──
  if (main.indexOf("keymap.register('view.start'") < 0) bad.push("`main.js` 没有 `keymap.register('view.start')` —— 键进表了但没人接");
  if (main.indexOf("keymap.register('file.toggle-favorite'") < 0) bad.push("`main.js` 没有 `keymap.register('file.toggle-favorite')` —— 菜单项点了没反应");

  // ── ⑥ `⌘L` 的实现顺序（`design/0056` §2.1 ④ 的 ④→⑤→⑥，⚠️ 反了是**静默**的）──
  const 起点 = main.indexOf('async function returnToStartPage');
  const 终 = 起点 < 0 ? -1 : main.indexOf('\n  // ═══', 起点);
  if (起点 < 0) {
    bad.push('`main.js` 没有 `returnToStartPage()`');
  } else {
    const body = 终 < 0 ? main.slice(起点) : main.slice(起点, 终);
    const 冲刷 = body.indexOf('await flushReadingProgress()');
    const 关闭 = body.indexOf('await S.closeDocument()');
    if (冲刷 < 0) bad.push('`returnToStartPage()` 没有冲刷阅读进度（关掉之前那一段滚动位置会丢）');
    if (关闭 < 0) bad.push('`returnToStartPage()` 没有调 `S.closeDocument()` —— 前端自己清身份就是 §2.2 的备选 A');
    if (冲刷 >= 0 && 关闭 >= 0 && 冲刷 > 关闭) {
      bad.push('`flushReadingProgress()` 排在 `S.closeDocument()` **之后** —— 那时身份已经没了，后端按 `doc_seq` 判陈旧、**一声不响**地丢掉');
    }
    if (body.indexOf('tree.setCurrent(null)') < 0) bad.push('`returnToStartPage()` 没有把树的高亮摘掉（回到导航页还标着那份文档）');
  }

  // ── ⑦ `closeDocument` 的身份字段（⚠️ 用 `state.docSeq` 会**永远**被判身份不符）──
  const 函数起点 = session.indexOf('async function closeDocument');
  if (函数起点 < 0) {
    bad.push('`session.js` 没有 `closeDocument()`');
  } else {
    const fn = session.slice(函数起点, 函数起点 + 2000);
    if (fn.indexOf('state.currentDoc && state.currentDoc.doc_seq') < 0) {
      bad.push('`closeDocument()` 没取 `currentDoc.doc_seq` —— 它才是"当前这份"的会话号（与 `currentDocSeq()` 同一个字段）');
    }
    if (fn.indexOf('const docSeq = state.docSeq;') >= 0) {
      bad.push('`closeDocument()` 取了 `state.docSeq` —— 它只随**快照**更新，而打开文档不走快照 ⇒ 永远是旧会话号');
    }
    if (fn.indexOf("T.call('close_document'") < 0) bad.push('`closeDocument()` 没有发 `close_document`');
  }

  return bad;
}

test('接线：0056 / 0057 的表项、菜单、三处清单、前端 handler、实现顺序、身份字段 —— 一处不落', function () {
  assert.deepStrictEqual(score(load()), []);
});

// ────────────────────────────────────────────────────────────────
// ⚠️ 判据自检：每一条注入的坏法都**必须**让 `score()` 变红。
//    （没做过变异测试的断言不算数 —— `.claude/rules/tests.md`）
// ────────────────────────────────────────────────────────────────

test('判据自检：拿坏副本问它，七种坏法各自变红（⛔ 不许有一项恒真）', function () {
  const 原 = load();
  const 试 = function (补丁) {
    const s = Object.assign(load(), 补丁);
    return score(s);
  };
  const 变红 = function (bad, 片段) {
    assert.ok(
      bad.some(function (x) { return x.indexOf(片段) >= 0; }),
      '⛔ 变异没被抓到（判据恒真）：' + 片段 + '\n实际：' + JSON.stringify(bad)
    );
  };

  // ① 键位被改
  变红(试({ rust: 原.rust.replace('accel: "Cmd+L"', 'accel: "Cmd+9"') }), '不是 `Cmd+L`');
  // ② `view.start` 被塞进了菜单表（`design/0056` §2.1 的"不进菜单"）
  //    ⚠️ 锚点用**表声明的右括号之后**那一行：`id: "file.save"` 这种串在两张表里都有，
  //    用 `String.replace`（只换第一处）会改到 `SHORTCUTS` 上，变异就落空了。
  变红(试({
    rust: 原.rust.replace(
      'const PLAIN_MENU_ITEMS: &[PlainMenuItem] = &[',
      'const PLAIN_MENU_ITEMS: &[PlainMenuItem] = &[\n    PlainMenuItem { submenu: "File", position: 9, sep: SepSide::After, id: "view.start" },'
    ),
  }), '只该有一条');
  // ③ 菜单项被删（同样锚在 `PLAIN_MENU_ITEMS` 里那一项自己的分隔线行上）
  变红(试({
    rust: 原.rust.replace(
      'sep: SepSide::After,\n        id: "file.toggle-favorite",',
      'sep: SepSide::After,\n        id: "file.gone-favorite",'
    ),
  }), '没有 `file.toggle-favorite`');
  // ④ 三处清单漏一处（这里挑最容易漏的 capabilities）
  变红(试({ caps: 原.caps.replace('"allow-close-document",', '') }), 'allow-close-document');
  // ⑤ 前端 handler 被改名
  变红(试({ main: 原.main.replace("keymap.register('view.start'", "keymap.register('view.home'") }), '没人接');
  // ⑥ 顺序被反（把冲刷挪到关闭之后：直接删掉"前一次出现"是做不到的，
  //    所以这里把两行整体换位——判据只看**函数体内**的先后）
  const 顺序坏 = 原.main.replace(
    '      await flushReadingProgress();\n      // ⑤ 后端是唯一真值',
    '      // ⑤ 后端是唯一真值'
  ).replace(
    '      if (!closed) return;',
    '      await flushReadingProgress();\n      if (!closed) return;'
  );
  变红(试({ main: 顺序坏 }), '排在 `S.closeDocument()` **之后**');
  // ⑦ 身份字段用错
  变红(试({
    session: 原.session.replace(
      'const docSeq = (state.currentDoc && state.currentDoc.doc_seq) || 0;',
      'const docSeq = state.docSeq;'
    ),
  }), '只随**快照**更新');
});
