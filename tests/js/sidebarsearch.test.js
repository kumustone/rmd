// `design/0042`：侧边栏常驻文件名搜索的纯逻辑 ＋ 源码级闸门。
//
// ⚠️ 这几条判据的共同点：**违反了不会有任何一处报错**。
//   · "每次输入都重建索引"只表现为慢（用户以为搜索就这速度）；
//   · "从不重建"表现为新文件永远搜不到（界面上只有索引年龄那一行在暗示）；
//   · "组件自己改面板 `hidden`"会与 `Sidebar.applyPanes` 打架，表现为搜索框留在大纲页上。
// ⇒ 前一半是纯函数单测（`services/sidebarsearch.js`），后一半是扫源码。
// ⭐ 每条源码闸门都自带**反例自测**（合成一份违规源码，检查器必须判红）——
//    否则"永远绿"的闸门等于没有。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SS = require(path.join(ROOT, 'src', 'services', 'sidebarsearch.js'));

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/** 剥注释（把注释换成等量空白，保留换行 ⇒ 行号不漂）。 */
function strip(s) {
  const blank = function (m) { return m.replace(/[^\n]/g, ' '); };
  return s
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:/])\/\/[^\n]*/g, function (m, lead) { return lead + blank(m.slice(lead.length)); });
}

// ── ① `planQuery`：一次输入之后该做什么 ─────────────────────────────────

test('planQuery：空 / 纯空白 ⇒ 收起，不发 IPC', function () {
  ['', '   ', '\t\n', null, undefined].forEach(function (p) {
    assert.deepStrictEqual(SS.planQuery(false, p), { kind: 'clear' });
    assert.deepStrictEqual(SS.planQuery(true, p), { kind: 'clear' });
  });
});

test('planQuery：从"没在搜"进入"在搜" ⇒ 这一次必须重建索引', function () {
  // ⭐ 与 `⌘P` 浮层打开时同一条时机（`INV-SEARCH-06`）：
  //    代次回答不了"目录里有没有新文件"，只有一次全树遍历能。
  assert.deepStrictEqual(SS.planQuery(false, 'a'), { kind: 'query', rebuild: true });
  assert.deepStrictEqual(SS.planQuery(false, '中文名'), { kind: 'query', rebuild: true });
});

test('planQuery：已经在搜 ⇒ 只查不重建（每个键都等一次全树遍历是不可接受的）', function () {
  assert.deepStrictEqual(SS.planQuery(true, 'ab'), { kind: 'query', rebuild: false });
  assert.deepStrictEqual(SS.planQuery(true, 'abc'), { kind: 'query', rebuild: false });
});

test('planQuery：`active` 不是真布尔也按"没在搜"算（⛔ 不把 `undefined` 读成真）', function () {
  assert.deepStrictEqual(SS.planQuery(0, 'a'), { kind: 'query', rebuild: true });
  assert.deepStrictEqual(SS.planQuery(undefined, 'a'), { kind: 'query', rebuild: true });
  assert.deepStrictEqual(SS.planQuery(1, 'a'), { kind: 'query', rebuild: false });
});

// ── ② `moveSelection`：环绕与越界归一 ────────────────────────────────────

test('moveSelection：没有结果时恒为 -1', function () {
  assert.strictEqual(SS.moveSelection(-1, 0, 1), -1);
  assert.strictEqual(SS.moveSelection(0, 0, 1), -1);
  assert.strictEqual(SS.moveSelection(3, 0, -1), -1);
});

test('moveSelection：没有选中时，往下从第一条、往上从最后一条', function () {
  assert.strictEqual(SS.moveSelection(-1, 5, 1), 0);
  assert.strictEqual(SS.moveSelection(-1, 5, -1), 4);
});

test('moveSelection：两端环绕', function () {
  assert.strictEqual(SS.moveSelection(4, 5, 1), 0);
  assert.strictEqual(SS.moveSelection(0, 5, -1), 4);
  assert.strictEqual(SS.moveSelection(2, 5, 1), 3);
  assert.strictEqual(SS.moveSelection(2, 5, -1), 1);
});

test('moveSelection：越界 / 非法的当前下标按"没有选中"处理（⛔ 不就近取整成最后一条）', function () {
  assert.strictEqual(SS.moveSelection(9, 5, 1), 0);
  assert.strictEqual(SS.moveSelection(9, 5, -1), 4);
  assert.strictEqual(SS.moveSelection(-2, 5, 1), 0);
});

test('moveSelection：`delta = 0` 保持原选中', function () {
  assert.strictEqual(SS.moveSelection(2, 5, 0), 2);
  assert.strictEqual(SS.moveSelection(-1, 5, 0), 4); // 没有选中时按"往上"那一支
});

test('moveSelection：只有一条时上下都回到它自己', function () {
  assert.strictEqual(SS.moveSelection(0, 1, 1), 0);
  assert.strictEqual(SS.moveSelection(0, 1, -1), 0);
});

// ── ③ 源码闸门：纯逻辑里没有 DOM / IPC ───────────────────────────────────

/** 裸判据：一份源码里"认识 DOM / 直接发 IPC"的痕迹（剥注释后）。 */
function domOrIpcHits(src) {
  const code = strip(src);
  const out = [];
  const re = /(\bdocument\s*\.|\bT\.call\s*\(|\binvoke\s*\(|__TAURI__)/g;
  let m;
  while ((m = re.exec(code)) !== null) out.push(code.slice(0, m.index).split('\n').length);
  return out;
}

test('裸判据自测：DOM / IPC 痕迹被抓到，注释里的不算', function () {
  const bad = [
    '// 这里⛔ 不碰 document.createElement',
    'const n = document.createElement("div");',
    'T.call("search_files", {});',
  ].join('\n');
  assert.deepStrictEqual(domOrIpcHits(bad), [2, 3]);
});

test('⭐ `services/sidebarsearch.js` 里没有 DOM / IPC（否则它进不了 `node --test`）', function () {
  assert.deepStrictEqual(domOrIpcHits(read('src/services/sidebarsearch.js')), []);
});

test('⭐ `components/SidebarSearch.js` 不直接发 IPC（只拿注入的 `search`）', function () {
  const code = strip(read('src/components/SidebarSearch.js'));
  assert.strictEqual(/\binvoke\s*\(/.test(code), false, '组件里出现了 `invoke(`');
  assert.strictEqual(/__TAURI__/.test(code), false, '组件里出现了 `__TAURI__`');
  assert.strictEqual(/\bT\.call\s*\(/.test(code), false,
    '组件里出现了 `T.call(` —— 搜索必须走注入的 `search`（`session.searchFiles`），⛔ 不是第二条路径');
});

// ── ④ 源码闸门：面板可见性只有一个计算处 ─────────────────────────────────

/** 裸判据：一份源码里写 `hidden` 的地方（剥注释后）。 */
function hiddenWrites(src) {
  const code = strip(src);
  const out = [];
  const re = /\.hidden\s*=/g;
  let m;
  while ((m = re.exec(code)) !== null) out.push(code.slice(0, m.index).split('\n').length);
  return out;
}

test('裸判据自测：`.hidden =` 被抓到', function () {
  assert.deepStrictEqual(hiddenWrites('a.hidden = true;\n// b.hidden = false;'), [1]);
});

test('⭐ `SidebarSearch.js` 不写面板 `hidden`（唯一计算处是 `Sidebar.applyPanes`）', function () {
  assert.deepStrictEqual(hiddenWrites(read('src/components/SidebarSearch.js')), [],
    '组件自己改可见性 ⇒ 与 `Sidebar.applyPanes` 两个写者各说各话（表现：搜索框留在大纲页上）');
});

test('⭐ `Sidebar.js` 的 `applyPanes` 里四个面板都在算（树 / 列表 / 搜索 / 大纲）', function () {
  const code = strip(read('src/components/Sidebar.js'));
  ['paneToc.hidden', 'paneTree.hidden', 'paneDoclist.hidden', 'paneSearch.hidden']
    .forEach(function (needle) {
      assert.ok(code.indexOf(needle) >= 0, '`applyPanes` 里少了 ' + needle);
    });
  assert.ok(code.indexOf('searchBar.hidden') >= 0, '`applyPanes` 里少了搜索框那一行（searchBar.hidden）');
  // ⚠️ 只查"这个名字在不在"太弱：把条件改成 `= false` 照样能过。
  //    这里钉的是**判据本身**——搜索框只在文件页且可用时出现，结果层只在"文件页 ＋ 在搜"时出现。
  assert.ok(/searchBar\.hidden\s*=\s*!\(onFiles\s*&&\s*searchAvailable\)/.test(code),
    '搜索框的可见性丢了 `!（文件页 && 可用）`——大纲页上会留下一个不该在的输入框');
  assert.ok(/paneSearch\.hidden\s*=\s*!searching/.test(code),
    '结果层的可见性丢了 `!searching`（它是第三个面板，与树 / 列表互斥）');
});

// ── ⑤ 源码闸门：匹配只有一份，刷新键从后端表里认 ─────────────────────────

test('⭐ 组件只经 `Se.segments` 切命中片段（⛔ 不在前端再写一份匹配）', function () {
  const code = strip(read('src/components/SidebarSearch.js'));
  assert.strictEqual((code.match(/Se\.segments\s*\(/g) || []).length, 1,
    '命中片段的切分必须恰好一处（`services/search.js` 的字节→UTF-16 换算）');
  assert.strictEqual(/\.includes\s*\(/.test(code), false,
    '组件里出现了 `includes(` —— 那看起来像"自己再判一次匹配"');
});

test('⭐ 刷新键经 `K.matchEvent` 从后端表里认（⛔ 没有键位字面量）', function () {
  const code = strip(read('src/components/SidebarSearch.js'));
  assert.ok(/K\.matchEvent\s*\(/.test(code), '组件里没有 `K.matchEvent(`');
  assert.ok(/refreshId/.test(code), '组件没有接 `refreshId`');
  // ⚠️ 本仓的纪律：前端源码里⛔ 不出现按键字面量（`INV-SET-01`）。
  assert.strictEqual(/metaKey/.test(code), false, '组件里出现了 `metaKey` 判断');
  assert.strictEqual(/ctrlKey/.test(code), false, '组件里出现了 `ctrlKey` 判断');
});

test('⭐ 组件把"第一次输入要重建索引"交给 `SS.planQuery`（⛔ 不在组件里自己推）', function () {
  const code = strip(read('src/components/SidebarSearch.js'));
  assert.ok(/SS\.planQuery\s*\(/.test(code), '组件没有走 `SS.planQuery(`');
  assert.ok(/plan\.rebuild/.test(code), '组件没有使用 `planQuery` 给出的 `rebuild`（那它一定在别处又算了一份）');
  assert.strictEqual(/rebuild\s*[:=]\s*!/.test(code), false,
    '组件里出现了自己算 `rebuild: !active` —— 三分支判据只有 `sidebarsearch.js` 一份');
});
