// `design/0075` §7 的单测：**查找替换的纯逻辑**（`src/services/find.js`）＋ 接线闸门。
//
// ⭐ 这里测的是三件事，都在 `node --test` 里能钉死：
//   ① **匹配口径与渲染域同源**（`sourceHits` 只是把 `matchAll` 的命中折成全文偏移）；
//   ② **替换是字面的、非递归的、一次事务的**（`replaceNextPlan` / `replaceAllPlan`）；
//   ③ **接线没被换成第二套实现**（源码级：`FindBar` 走适配器、`main.js` 只 `dispatch` 一次）。
//
// ⚠️ 为什么这些判据值得写：它们的失败面**全都不报错**——
//    · 把 `$&` 当反向引用 ⇒ 正文里出现一段莫名其妙的反向引用文本；
//    · 全部替换拆成 N 个事务 ⇒ 用户按一次 `⌘Z` 只退回一处，以为"撤销坏了"；
//    · 从替换串里再扫一轮（`a`→`aa` 递归）⇒ 替换永远停不下来；
//    · 大小写不敏感 ⇒ 改掉用户没想改的地方。
//
// 跑法：`node --test tests/js/find-replace.test.js`（`make test-js` 会跑全部）。
// ⚠️ 放在仓库根的 `tests/js/` 而不是 `src/`：`src/` 是 Tauri 的 `frontendDist`，
//    整个目录**会在编译期嵌进二进制**。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const F = require('../../src/services/find.js');
const I18N = require('../../src/services/i18n.js');

const ROOT = path.join(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────
// ① `sourceHits`：源码域的命中（口径必须与渲染域同源）
// ─────────────────────────────────────────────────────────────────────────

test('sourceHits_空与纯空白关键词_没有命中', function () {
  // ⭐ 沿用 `normalizeQuery` 的口径：只有空白的关键词等于没输入（`design/0011` §7）。
  assert.deepStrictEqual(F.sourceHits('abc', ''), []);
  assert.deepStrictEqual(F.sourceHits('abc', '   '), []);
  assert.deepStrictEqual(F.sourceHits('abc', '\n\t '), []);
  assert.deepStrictEqual(F.sourceHits('abc', null), []);
});

test('sourceHits_非重叠_aaaa里搜aa是两处', function () {
  // ⚠️ 与渲染域同口径：找完一处从**它的结尾**继续，⛔ 不是 +1。
  assert.deepStrictEqual(F.sourceHits('aaaa', 'aa'), [
    { from: 0, to: 2 },
    { from: 2, to: 4 },
  ]);
  // 第三处需要重叠才存在（1..3）⇒ 这里**没有**它。
  assert.strictEqual(F.sourceHits('aaaa', 'aa').length, 2);
});

test('sourceHits_大小写敏感', function () {
  // 'AaA'：`A` 在 0、2，`a` 在 1 ⇒ 两问各得一份，⛔ 不互相吞并。
  assert.deepStrictEqual(F.sourceHits('AaA', 'a'), [{ from: 1, to: 2 }]);
  assert.deepStrictEqual(F.sourceHits('AaA', 'A'), [
    { from: 0, to: 1 },
    { from: 2, to: 3 },
  ]);
});

test('sourceHits_偏移是UTF16码元_不是码点', function () {
  // ⭐ CM6 的 `changes.from/to` 也是 UTF-16 码元 ⇒ 两边同一个空间，⛔ 不做换算。
  // `😀` 占两个码元：'😀a😀a' 的长度是 6，两个 `a` 分别在 2 与 5。
  const s = '😀a😀a';
  assert.strictEqual(s.length, 6);
  assert.deepStrictEqual(F.sourceHits(s, 'a'), [
    { from: 2, to: 3 },
    { from: 5, to: 6 },
  ]);
  // ⚠️ 替身：用 `applyChanges` 真删掉那个 `a`，剩下的仍然是完整的两个代理对。
  const out = F.applyChanges(s, [{ from: 2, to: 3, insert: '' }]);
  assert.strictEqual(out, '😀😀a');
});

test('sourceHits_关键词里的正则元字符按字面处理', function () {
  // ⚠️ 匹配走 `indexOf`，⛔ 不构造 `RegExp` ⇒ `.`/`*`/`$` 都是普通字符。
  assert.deepStrictEqual(F.sourceHits('a.c', '.'), [{ from: 1, to: 2 }]);
  assert.deepStrictEqual(F.sourceHits('a*c', '*'), [{ from: 1, to: 2 }]);
  assert.deepStrictEqual(F.sourceHits('a$c', '$'), [{ from: 1, to: 2 }]);
  // 正则里 `.` 等价于任意字符，字面匹配下必须**一个也搜不到**。
  assert.deepStrictEqual(F.sourceHits('abc', '.'), []);
});

test('sourceHits_没有命中时是空数组', function () {
  assert.deepStrictEqual(F.sourceHits('abc', 'x'), []);
  assert.deepStrictEqual(F.sourceHits('', 'a'), []);
});

// ─────────────────────────────────────────────────────────────────────────
// ② `applyChanges`：把一批变更拼成新文本
// ─────────────────────────────────────────────────────────────────────────

test('applyChanges_空变更集是恒等', function () {
  assert.strictEqual(F.applyChanges('abc', []), 'abc');
  assert.strictEqual(F.applyChanges('abc', null), 'abc');
  assert.strictEqual(F.applyChanges(null, []), '');
});

test('applyChanges_多处替换_删除_插入都按升序拼', function () {
  assert.strictEqual(F.applyChanges('a b a', [
    { from: 0, to: 1, insert: 'X' },
    { from: 4, to: 5, insert: 'Y' },
  ]), 'X b Y');
  // 空串 = 删除这一次命中（`INV-REPL-03` 允许空替换串）。
  // `xaxbxa` 的两个 `a` 在 1 与 5。
  assert.strictEqual(F.applyChanges('xaxbxa', [
    { from: 1, to: 2, insert: '' },
    { from: 5, to: 6, insert: '' },
  ]), 'xxbx');
  // 变长插入 + 紧挨着的两处（`to === 下一处的 from` 是合法形态）。
  assert.strictEqual(F.applyChanges('aa', [
    { from: 0, to: 1, insert: 'BBB' },
    { from: 1, to: 2, insert: 'C' },
  ]), 'BBBC');
});

// ─────────────────────────────────────────────────────────────────────────
// ③ `replaceNextPlan`：单次替换（从光标处向后，找不到环绕）
// ─────────────────────────────────────────────────────────────────────────

test('replaceNextPlan_从光标处找第一处_光标落在替换串末尾', function () {
  const text = 'one two one two';
  const p = F.replaceNextPlan(text, 'one', 'ONE', 0);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.count, 1);
  assert.strictEqual(p.total, 2);
  assert.strictEqual(p.index, 0);
  assert.strictEqual(p.wrapped, false);
  assert.deepStrictEqual(p.changes, [{ from: 0, to: 3, insert: 'ONE' }]);
  assert.strictEqual(p.text, 'ONE two one two');
  // ⭐ 光标停到替换串末尾 ⇒ 下一次"替换"从它后面继续，⛔ 不会改回同一处。
  assert.strictEqual(p.nextFrom, 3);
});

test('replaceNextPlan_光标在中间时跳过已经过去的命中', function () {
  const text = 'one two one two';
  const p = F.replaceNextPlan(text, 'one', 'X', 4);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.index, 1);
  assert.deepStrictEqual(p.changes, [{ from: 8, to: 11, insert: 'X' }]);
  assert.strictEqual(p.wrapped, false);
});

test('replaceNextPlan_光标越界或非法时夹取', function () {
  const text = 'abc abc';
  // 负数 ⇒ 0（找第一处）。
  assert.strictEqual(F.replaceNextPlan(text, 'abc', 'x', -5).index, 0);
  // NaN / Infinity / 非数字 ⇒ 0。
  assert.strictEqual(F.replaceNextPlan(text, 'abc', 'x', NaN).index, 0);
  assert.strictEqual(F.replaceNextPlan(text, 'abc', 'x', Infinity).index, 0);
  assert.strictEqual(F.replaceNextPlan(text, 'abc', 'x', '3').index, 0);
  // 超过文本长度 ⇒ 夹到末尾（只能环绕）。
  const p = F.replaceNextPlan(text, 'abc', 'x', 999);
  assert.strictEqual(p.index, 0);
  assert.strictEqual(p.wrapped, true);
});

test('replaceNextPlan_找不到向后命中时环绕到第一处', function () {
  const p = F.replaceNextPlan('one two one', 'one', 'X', 5);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.index, 1);
  assert.strictEqual(p.wrapped, false);
  // 从第二处之后开始 ⇒ 后面已经没有命中 ⇒ 回到第一处并**明确标出** wrapped。
  const q = F.replaceNextPlan('one two one', 'one', 'X', 11);
  assert.strictEqual(q.ok, true);
  assert.strictEqual(q.index, 0);
  assert.strictEqual(q.wrapped, true);
  assert.strictEqual(q.text, 'X two one');
});

test('replaceNextPlan_空关键词与无命中是两个不同的理由', function () {
  const e = F.replaceNextPlan('abc', '   ', 'x', 0);
  assert.strictEqual(e.ok, false);
  assert.strictEqual(e.reason, 'empty');
  assert.strictEqual(e.text, 'abc');
  assert.deepStrictEqual(e.changes, []);

  const n = F.replaceNextPlan('abc', 'zzz', 'x', 0);
  assert.strictEqual(n.ok, false);
  assert.strictEqual(n.reason, 'none');
  assert.strictEqual(n.text, 'abc');
  assert.deepStrictEqual(n.changes, []);
});

test('replaceNextPlan_替换串是字面的_美元与斜杠按原样写入', function () {
  // ⚠️⚠️ 这是 `INV-REPL-03` 的核心：`$&` / `$1` / `\1` 在 `String.replace` 里是反向引用，
  //    在这里必须是**六个普通字符**。
  const a = F.replaceNextPlan('a$&b', 'a', '$&', 0);
  assert.strictEqual(a.text, '$&$&b');
  const b = F.replaceNextPlan('a1', 'a', '$1', 0);
  assert.strictEqual(b.text, '$11');
  const c = F.replaceNextPlan('a1', 'a', '\\1', 0);
  assert.strictEqual(c.text, '\\11');
});

test('replaceNextPlan_替换串里含被查串时只改一处_不递归', function () {
  const p = F.replaceNextPlan('aaa', 'a', 'aa', 0);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.count, 1);
  assert.strictEqual(p.changes.length, 1);
  assert.strictEqual(p.text, 'aaaa');
  // 光标在替换串末尾 ⇒ 后面那个 `a` 不会被同一轮吃掉。
  assert.strictEqual(p.nextFrom, 2);
});

test('replaceNextPlan_空替换串等于删除这一处', function () {
  const p = F.replaceNextPlan('xaxbxa', 'a', '', 0);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.text, 'xxbxa');
  assert.strictEqual(p.nextFrom, 1);
});

test('replaceNextPlan_不改动入参', function () {
  const text = 'one two';
  F.replaceNextPlan(text, 'one', 'X', 0);
  assert.strictEqual(text, 'one two');
});

// ─────────────────────────────────────────────────────────────────────────
// ④ `replaceAllPlan`：全部替换（一条事务的输入）
// ─────────────────────────────────────────────────────────────────────────

test('replaceAllPlan_计数等于变更数_变更按升序且互不重叠', function () {
  const text = 'a b a b a';
  const p = F.replaceAllPlan(text, 'a', 'X');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.count, 3);
  assert.strictEqual(p.changes.length, p.count, '⭐ 全部替换必须是**一个**数组里的 N 项（一次 dispatch）');
  assert.deepStrictEqual(p.changes, [
    { from: 0, to: 1, insert: 'X' },
    { from: 4, to: 5, insert: 'X' },
    { from: 8, to: 9, insert: 'X' },
  ]);
  for (let i = 1; i < p.changes.length; i++) {
    assert.ok(p.changes[i].from >= p.changes[i - 1].to, '变更必须升序且互不重叠');
  }
  assert.strictEqual(p.text, 'X b X b X');
});

test('replaceAllPlan_大小写不敏感不是我们的口径', function () {
  const p = F.replaceAllPlan('AbAba', 'a', 'X');
  assert.strictEqual(p.count, 1);
  assert.strictEqual(p.text, 'AbAbX');
});

test('replaceAllPlan_替换串含被查串时不递归', function () {
  const p = F.replaceAllPlan('aaa', 'a', 'aa');
  assert.strictEqual(p.count, 3);
  assert.strictEqual(p.text, 'aaaaaa');
});

test('replaceAllPlan_重叠不算两处', function () {
  const p = F.replaceAllPlan('aaaa', 'aa', 'b');
  assert.strictEqual(p.count, 2);
  assert.strictEqual(p.text, 'bb');
});

test('replaceAllPlan_空替换串等于全部删除', function () {
  const p = F.replaceAllPlan('xaxbxa', 'a', '');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.count, 2);
  assert.strictEqual(p.text, 'xxbx');
});

test('replaceAllPlan_字面替换_美元与反斜杠原样', function () {
  assert.strictEqual(F.replaceAllPlan('a-a', 'a', '$&').text, '$&-$&');
  assert.strictEqual(F.replaceAllPlan('a-a', 'a', '\\1').text, '\\1-\\1');
});

test('replaceAllPlan_空关键词与无命中是两个不同的理由', function () {
  const e = F.replaceAllPlan('abc', '', 'x');
  assert.strictEqual(e.ok, false);
  assert.strictEqual(e.reason, 'empty');
  assert.strictEqual(e.count, 0);
  assert.deepStrictEqual(e.changes, []);
  assert.strictEqual(e.text, 'abc');

  const n = F.replaceAllPlan('abc', 'zzz', 'x');
  assert.strictEqual(n.ok, false);
  assert.strictEqual(n.reason, 'none');
  assert.strictEqual(n.count, 0);
  assert.strictEqual(n.text, 'abc');
});

test('replaceAllPlan_文本与applyChanges自洽', function () {
  // ⭐ `text` 只是给单测/诊断用的投影；调用方真正用的是 `changes`。
  //    两者必须一致，否则"计划说改了 N 处、屏幕上却少一处"。
  const text = '# 标题\n\n正文 a，正文 b。\n';
  const p = F.replaceAllPlan(text, '正文', '**正文**');
  assert.strictEqual(p.text, F.applyChanges(text, p.changes));
  assert.strictEqual(p.count, 2);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑤ 源码级接线闸门（⛔ 不是风格问题：接错线不会报错）
// ─────────────────────────────────────────────────────────────────────────

test('main.js_替换只有一个写入口_一次动作一个事务', function () {
  const src = read('src/main.js');
  const 起 = src.indexOf('function applySourceReplace');
  assert.ok(起 >= 0, '⛔ 找不到 `applySourceReplace` —— 接线被改名了，本闸门的输入变了');
  const 止 = src.indexOf('findBar = FindBar.createFindBar({', 起);
  assert.ok(止 > 起, '⛔ `applySourceReplace` 之后找不到 `createFindBar` —— 结构变了');
  const 段 = src.slice(起, 止);

  // ① 真的走纯逻辑的计划函数（⛔ 不是第二套匹配）。
  assert.ok(段.indexOf('Find.replaceNextPlan(') >= 0, '单次替换没有走 `Find.replaceNextPlan`');
  assert.ok(段.indexOf('Find.replaceAllPlan(') >= 0, '全部替换没有走 `Find.replaceAllPlan`');
  // ② 输入文本来自编辑器（`INV-REPL-06`：前端不解析 Markdown）。
  assert.ok(段.indexOf('view.state.doc.toString()') >= 0, '替换的输入文本必须来自 CM6 的文档');
  // ③ 只经 CM6 写（`INV-REPL-01`）：两个分支各一次 `dispatch`，⛔ 没有循环 dispatch。
  assert.strictEqual(
    (段.match(/view\.dispatch\(/g) || []).length,
    2,
    '⛔ `applySourceReplace` 里应当恰好有两个 `view.dispatch`（单次 / 全部各一），多出来就意味着循环写'
  );
  // ④ ⛔ 不构造正则（`INV-REPL-03`）。
  assert.strictEqual(段.indexOf('RegExp'), -1, '替换路径里出现了 `RegExp`');
  // ⑤ 两个分支都用计划给出的 `changes`。
  assert.strictEqual(
    (段.match(/changes:\s*plan\.changes/g) || []).length,
    2,
    '⛔ 两个分支都必须把 `plan.changes` 交给 CM6（⛔ 不自己造变更）'
  );
});

test('FindBar_替换只经适配器_自己不动源码', function () {
  const src = read('src/components/FindBar.js');
  assert.ok(src.indexOf('replaceAdapter.apply({') >= 0, '⛔ 替换没有走 `replaceAdapter.apply()`');
  assert.ok(src.indexOf('replaceAvailable()') >= 0, '⛔ 可用性必须现问适配器');
  // ⚠️ 浮层**不碰源码**：它只拿到计划的结果。出现 `dispatch`/`RegExp` 就说明有人把写入口搬进来了。
  assert.strictEqual(src.indexOf('.dispatch('), -1, '⛔ FindBar 里出现了编辑器 dispatch —— 写入口必须在 main.js');
  assert.strictEqual(src.indexOf('new RegExp'), -1, '⛔ FindBar 里出现了正则构造');
});

test('i18n_替换相关键_中英两本齐全且占位符一致', function () {
  const keys = [
    'find.replace.placeholder',
    'find.replace.input-label',
    'find.replace.one',
    'find.replace.all',
    'find.replace.scope',
    'find.replace.need-edit',
    'find.replace.need-edit-nokey',
    'find.replace.empty-query',
    'find.replace.none',
    'find.replace.done-one',
    'find.replace.done-one-wrapped',
    'find.replace.done-all',
    'find.replace.failed',
    'find.what-replace',
  ];
  const zh = I18N.DICT.zh;
  const en = I18N.DICT.en;
  function vars(s) {
    return (String(s).match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(',');
  }
  keys.forEach(function (k) {
    assert.ok(Object.prototype.hasOwnProperty.call(zh, k), 'zh 缺 ' + k);
    assert.ok(Object.prototype.hasOwnProperty.call(en, k), 'en 缺 ' + k);
    assert.strictEqual(vars(zh[k]), vars(en[k]), k + ' 的占位符在 zh/en 不一致');
  });
});

test('gui_mod_快捷键与菜单项_同一份表_且键位不撞车', function () {
  const src = read('src-tauri/src/gui/mod.rs');
  // ① 快捷键表里有它，`accel` 是 `Alt+Cmd+F`、owner 是 Web。
  const 块 = /Shortcut\s*\{[\s\S]*?id:\s*"edit\.replace"[\s\S]*?\}/.exec(src);
  assert.ok(块, '⛔ `SHORTCUTS` 里没有 `edit.replace`');
  assert.ok(/accel:\s*"Alt\+Cmd\+F"/.test(块[0]), '⛔ `edit.replace` 的 accel 不是 `Alt+Cmd+F`');
  assert.ok(/owner:\s*Owner::Web/.test(块[0]), '⛔ `edit.replace` 必须归 `Owner::Web`（替换生命周期全在前端）');

  // ② 全表里的 Alt 组合**两两不同**（`⌥⌘F` 是这一族里的第一个，⛔ 别撞上别人）。
  //    ⚠️ 2026-11-15：`design/0077` 的 `edit.copy-plain` 也从这里走（`Alt+Cmd+P`），
  //    所以判据从"恰好一条"改成"不重复"——真正要守的是**不撞车**，不是数量。
  const shortcuts = src.slice(
    src.indexOf('const SHORTCUTS: &[Shortcut] = &['),
    src.indexOf('\n];', src.indexOf('const SHORTCUTS: &[Shortcut] = &['))
  );
  const alt = shortcuts.match(/accel:\s*"[^"]*Alt\+[^"]*"/g) || [];
  assert.strictEqual(new Set(alt).size, alt.length, '⛔ 快捷键表里有重复的 Alt 组合：' + alt.join(' / '));

  // ③ 菜单项存在，且**紧跟在 `edit.find` 之后**（同一条分隔线之内）。
  const menus = src.slice(src.indexOf('const PLAIN_MENU_ITEMS'), src.indexOf('fn plain_menu_ids()'));
  const findAt = menus.indexOf('id: "edit.find"');
  const replaceAt = menus.indexOf('id: "edit.replace"');
  assert.ok(findAt >= 0 && replaceAt > findAt, '⛔ 菜单项 `edit.replace` 不在 `edit.find` 之后');
  assert.ok(
    /position:\s*13[\s\S]*?sep:\s*SepSide::None[\s\S]*?id:\s*"edit\.replace"/.test(menus),
    '⛔ 菜单项应当是 `position: 13` ＋ `SepSide::None`（紧跟「查找…」，不另起分隔线）'
  );
});
