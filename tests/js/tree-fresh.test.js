// `docs/bugs/0019`（2026-10-27）的**源码级闸门**：
// 「⚠️⚠️ 磁盘变了、产品没感知」这一类缺陷里最贵的一条 —— **刷新事务读了缓存**。
//
// ⭐ 为什么必须是源码级：
//   这条缺陷的判据是**行为级**的（`probe-favorites-rootheader` 判据 12），而行为级探针
//   要真跑一整个离屏 WKWebView（十几秒）。真正让它复活的动作却只有一个字符：
//   把 `fillLayer(…, true, …)` 写成 `false`。写成 `false` 之后
//   **没有异常、没有日志、界面上什么都没变**——只是"外部新增的文件永远不出现"
//   （用户 2026-10-27 报的原话：「在目录树结构中，如果其他程序目录中增加了一个文档，
//     目录树中并没有展示」）。纯逻辑单测够不到（那里没有后端缓存），
//   `probe-tree-menu` 也够不到（它不重建整棵树）⇒ 这一格必须由源码闸门守着。
//
// ⚠️ 根因的形状（写在这里，因为下次改动的人只会看到这个文件）：
//   后端 `TreeCache` 的键是 `(授权代次, 路径)`，而**"目录里多了一个文件"不动代次**
//   （`commands/fs.rs::list_dir_three_stage`：只有 `fresh` 才 `invalidate`）。
//   ⇒ 刷新事务一旦不带 `fresh`，离屏重建拿到的是**上一次那一份**，
//     重建出**一模一样**的树，三道身份复核全过，原子提交上去 ⇒ 界面纹丝不动。
//
// ⚠️ 判据对**注释免疫**：`FileTree.js` 的注释里就写着 `fillLayer(det, rootPath, 0, true, …)`
//    这段原文（为了解释这条约束），直接 grep 会把**正确的注释**判成缺陷 ⇒ 先挖空注释。
// ⚠️ 变异自测在 `score()` 里：同一套判据喂给"故意写坏的副本"必须变假，
//    否则"全绿"只说明判据没看那一眼（`.claude/rules/tests.md` 的四种"没红"）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const TREE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'components', 'FileTree.js'), 'utf8');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
// ⭐ `design/0050`：那条通道的订阅搬进了 `services/diskevents.js`。
//    ⚠️ 判据 3 因此**横跨三份文件**：订阅端在 `diskevents.js`，消费端在 `main.js`
//    ⇒ 任何一份单独看都能"看起来对"，只有三份对起来才说明这条线还在。
const DE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'diskevents.js'), 'utf8');

/** 挖空 `/* … *\/`（⛔ 不删，保持行数对齐）。 */
function stripBlockComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

/** 挖空 `// …`（⚠️ 粗暴但保守：`//` 之前引号数是奇数就当还在字符串里，不动）。 */
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

function stripAll(src) {
  return stripLineComments(stripBlockComments(src));
}

/**
 * 取一个具名函数的**函数体文本**（从 `function name(` 起做花括号配平）。
 * ⚠️ 调用前必须先挖空注释；字符串字面量里的 `{}` 会被跳过。
 * @returns {string|null} 找不到返回 `null`（⛔ 别当成"通过"）
 */
function bodyOf(src, header) {
  const i = String(src).indexOf(header);
  if (i < 0) return null;
  let j = String(src).indexOf('{', i);
  if (j < 0) return null;
  let depth = 0;
  let quote = null;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (quote) {
      if (c === '\\') { k++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(j + 1, k);
    }
  }
  return null;
}

/** 取 `src` 里每个 `name(` 的**实参列表**（按顶层逗号切分，⚠️ 跳过括号/字符串里的逗号）。 */
function callArgs(src, name) {
  const out = [];
  let from = 0;
  for (;;) {
    const i = String(src).indexOf(name + '(', from);
    if (i < 0) break;
    from = i + name.length + 1;
    // ⚠️ 排除定义处与 `function name(`：定义处的 `(` 前面是 `name` 的声明位置，
    //    而调用点前面不是空白＋`function`。够用的保守判据：跳过 `function name(`。
    const head = src.slice(Math.max(0, i - 20), i);
    if (/function\s*$/.test(head)) continue;
    let depth = 0;
    let quote = null;
    const args = [];
    let cur = '';
    for (let k = from; k < src.length; k++) {
      const c = src[k];
      if (quote) {
        cur += c;
        if (c === '\\') { cur += src[++k] || ''; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
      if (c === ')' || c === ']' || c === '}') {
        if (c === ')' && depth === 0) { args.push(cur.trim()); break; }
        depth--; cur += c; continue;
      }
      if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    out.push(args);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// 判据本体（⭐ 抽成函数是为了让变异自测能拿"写坏的副本"再判一次）
// ────────────────────────────────────────────────────────────────

/**
 * @param {{tree:string, main:string, de:string}} src
 * @returns {{ok:boolean, 明细:object}}
 */
function score(src) {
  const tree = stripAll(src.tree);
  const main = stripAll(src.main);
  const de = stripAll(src.de || '');
  const 明细 = {};

  // ── 判据 1：刷新事务的**每一处** `fillLayer` 都必须 `fresh = true` ──
  //    `fillLayer(container, path, childDepth, fresh, recordEpoch, offscreen)` ⇒ 第 4 个实参。
  const det = bodyOf(tree, 'function buildDetached(');
  明细.找到刷新事务 = det !== null;
  if (det !== null) {
    const calls = callArgs(det, 'fillLayer');
    明细.刷新事务里的层数 = calls.length;
    明细.各层fresh = calls.map(function (a) { return a[3] === undefined ? '（缺参）' : a[3]; });
    明细.判据1 = calls.length > 0 && calls.every(function (a) { return a[3] === 'true'; });
  } else {
    明细.各层fresh = [];
    明细.判据1 = false;
  }

  // ── 判据 2：两个刷新入口都走**同一个**事务（⛔ 不许人工刷新另开一条路）──
  //    事件那条与「刷新」菜单那条各写一份实现 ⇒ 修一边漏一边的样子是
  //    "外部改动不自动出现，但右键刷新一下就有了"。
  const note = bodyOf(tree, 'function noteTreeChanged(');
  const manual = bodyOf(tree, 'function manualRefresh(');
  明细.事件入口存在 = note !== null;
  明细.人工入口存在 = manual !== null;
  明细.判据2 =
    !!note && note.indexOf('refreshVisible()') >= 0 &&
    !!manual && manual.indexOf('refreshVisible()') >= 0;

  // ── 判据 3：磁盘事件**只有一个**订阅点，且它必须最终交给 `noteTreeChanged` ──
  //    ⚠️ 两处订阅 ⇒ 第二次提交会和第一次互相取消（`refreshVisible` 的 `refreshing` 闸），
  //    表现是"偶发不刷新"——比完全不刷新更难查。
  //    ⭐ `design/0050` 起订阅端在 `services/diskevents.js`（两条通道的唯一入口），
  //    消费端在 `main.js` 的 `DE.onChange(...)` 里 ⇒ 三件事都要成立：
  //      a. `main.js` **一处都不许**再自己订阅（否则两条通道各订阅一遍）；
  //      b. `diskevents.js` 恰好订阅**一处**；
  //      c. `main.js` 的 `onChange` 回调里真的调了 `tree.noteTreeChanged()`。
  const listensMain = (main.match(/listen\(\s*['"]rmd:\/\/tree-changed['"]/g) || []).length;
  const listensDe = (de.match(/listen\(\s*TREE_EVENT\b/g) || []).length;
  明细.订阅处数 = listensMain + listensDe;
  明细.main里没有订阅 = listensMain === 0;
  明细.交给刷新事务 =
    /DE\s*\.\s*onChange\([\s\S]{0,600}?noteTreeChanged\(\)/.test(main);
  明细.判据3 = listensMain === 0 && listensDe === 1 && 明细.交给刷新事务;

  // ── 判据 4：`install` 只装一次，且它的返回值被**检查**（最终约束 8 的"订阅失败要报"）──
  //    ⚠️ 静默失败的表现是"盘上变了但树不刷新"，与"盘上什么都没变"在界面上长得一样。
  const installs = (main.match(/DE\s*\.\s*install\(/g) || []).length;
  明细.install处数 = installs;
  明细.判据4 = installs === 1 &&
    /DE\s*\.\s*install\([\s\S]{0,200}?if\s*\(\s*!diskInstall\.treeOk/.test(main);

  明细.ok = 明细.判据1 && 明细.判据2 && 明细.判据3 && 明细.判据4;
  return { ok: 明细.ok, 明细: 明细 };
}

// ────────────────────────────────────────────────────────────────
// 1 · 产品源码：绿
// ────────────────────────────────────────────────────────────────

test('磁盘变更可感知：刷新事务每一层都 fresh ＋ 两个入口同一事务 ＋ 事件只有一个订阅点', function () {
  const r = score({ tree: TREE_SRC, main: MAIN_SRC, de: DE_SRC });
  assert.strictEqual(r.ok, true, '判据不成立：' + JSON.stringify(r.明细, null, 2));
  // ⚠️ 判据 1 至少要看到**两层**（根层 ＋ 已展开的子层）：只找到一处说明
  //    「每一层都要 fresh」这件事根本没被覆盖（`design/0034` §2.1 A.3 第 3 步）。
  assert.ok(r.明细.刷新事务里的层数 >= 2, '刷新事务里应当有根层与子层两处 `fillLayer`');
});

// ────────────────────────────────────────────────────────────────
// 2 · 变异自测：拿**故意写坏的副本**再判一次，必须变假
//    ⚠️ 变异打在**字符串副本**上（⛔ 不碰仓库文件）
// ────────────────────────────────────────────────────────────────

test('⭐ 判据自检：九处变异各自必须把对应的那条判据打假（⛔ 不许有一条恒真）', function () {
  const 基线 = score({ tree: TREE_SRC, main: MAIN_SRC, de: DE_SRC });
  assert.strictEqual(基线.ok, true, '自测前提：基线必须先是绿的');

  // ① `bugs/0019` 的**原样**：根层不带 fresh。
  const m1 = TREE_SRC.replace(
    'const r0 = await fillLayer(det, rootPath, 0, true, false, true);',
    'const r0 = await fillLayer(det, rootPath, 0, false, false, true);');
  assert.notStrictEqual(m1, TREE_SRC, '变异①没改到文件（模式没命中）');
  const r1 = score({ tree: m1, main: MAIN_SRC, de: DE_SRC });
  assert.strictEqual(r1.明细.判据1, false, '变异①（根层 fresh=false）判据1 必须为假');
  assert.strictEqual(r1.明细.判据2, true, '变异①不该牵连判据2');

  // ② 深一层漏掉（只修根层的等价写错法）。
  const m2 = TREE_SRC.replace(
    'const r = await fillLayer(node._kids, p, depth + 1, true, false, true);',
    'const r = await fillLayer(node._kids, p, depth + 1, false, false, true);');
  assert.notStrictEqual(m2, TREE_SRC, '变异②没改到文件（模式没命中）');
  assert.strictEqual(score({ tree: m2, main: MAIN_SRC, de: DE_SRC }).明细.判据1, false,
    '变异②（子层 fresh=false）判据1 必须为假');

  // ③ 缺参（把 fresh 那一格整个删掉，看起来像"用默认值"）。
  const m3 = TREE_SRC.replace(
    'const r0 = await fillLayer(det, rootPath, 0, true, false, true);',
    'const r0 = await fillLayer(det, rootPath, 0, false, true);');
  assert.notStrictEqual(m3, TREE_SRC, '变异③没改到文件（模式没命中）');
  assert.strictEqual(score({ tree: m3, main: MAIN_SRC, de: DE_SRC }).明细.判据1, false,
    '变异③（少传一位）判据1 必须为假');

  // ④ 人工刷新另开一条路（不再走同一个事务）。
  //    ⚠️ `design/0050` 起 `manualRefresh` 是**三步链**（对账 → 重列），
  //    所以变异打在链尾那个 `refreshVisible()` 上，⛔ 不再是整行替换。
  const m4 = TREE_SRC.replace(
    '.then(function () { return refreshVisible(); });',
    '.then(function () { return rebuildNow(); });');
  assert.notStrictEqual(m4, TREE_SRC, '变异④没改到文件（模式没命中）');
  assert.strictEqual(score({ tree: m4, main: MAIN_SRC, de: DE_SRC }).明细.判据2, false,
    '变异④（人工刷新另开一条路）判据2 必须为假');

  // ⑤ 事件不再交给刷新事务（订阅了但什么都不做）。
  const m5 = MAIN_SRC.replace('tree.noteTreeChanged()', 'tree.noop()');
  assert.notStrictEqual(m5, MAIN_SRC, '变异⑤没改到文件（模式没命中）');
  assert.strictEqual(score({ tree: TREE_SRC, main: m5, de: DE_SRC }).明细.判据3, false,
    '变异⑤（事件不触发刷新）判据3 必须为假');

  // ⑥ 两个订阅点（偶发不刷新，比完全不刷新更难查）。
  //    ⚠️ `0050` 之后订阅已经搬进 `diskevents.js` ⇒ 变异打在**那一份**上。
  const m6 = DE_SRC.replace(
    /(\n\s*)(await T\.listen\(TREE_EVENT)/,
    '$1await T.listen(TREE_EVENT, function () {});$1$2');
  assert.notStrictEqual(m6, DE_SRC, '变异⑥没改到文件（模式没命中）');
  assert.strictEqual(score({ tree: TREE_SRC, main: MAIN_SRC, de: m6 }).明细.判据3, false,
    '变异⑥（第二个订阅点）判据3 必须为假');

  // ⑦ **旧形状复活**：`main.js` 又自己订了一遍 `rmd://tree-changed`。
  //    这是搬代码时最真实的回归（老那段没删干净），而它**不会**报错，
  //    只会让每次改动重列两遍（`refreshing` 闸把第二次静默吞掉）。
  const m7 = MAIN_SRC.replace(
    'DE.onChange(function () {',
    "T.listen('rmd://tree-changed', function () {});\n    DE.onChange(function () {");
  assert.notStrictEqual(m7, MAIN_SRC, '变异⑦没改到文件（模式没命中）');
  assert.strictEqual(score({ tree: TREE_SRC, main: m7, de: DE_SRC }).明细.判据3, false,
    '变异⑦（main.js 自己又订阅一遍）判据3 必须为假');

  // ⑧ `install()` 不检查返回值（最终约束 8：订阅失败必须报出来）。
  const m8 = MAIN_SRC.replace(
    'if (!diskInstall.treeOk) {',
    'if (false) {');
  assert.notStrictEqual(m8, MAIN_SRC, '变异⑧没改到文件（模式没命中）');
  assert.strictEqual(score({ tree: TREE_SRC, main: m8, de: DE_SRC }).明细.判据4, false,
    '变异⑧（不检查订阅结果）判据4 必须为假');

  // ⑨ `install()` 根本没人调（整条通道静默消失）。
  const m9 = MAIN_SRC.replace(/await DE\.install\(T\);/, '');
  assert.notStrictEqual(m9, MAIN_SRC, '变异⑨没改到文件（模式没命中）');
  assert.strictEqual(score({ tree: TREE_SRC, main: m9, de: DE_SRC }).明细.判据4, false,
    '变异⑨（没有 install）判据4 必须为假');
});
