// `design/0065` P1（2026-11-10 用户批准「立即开工」）的**纯逻辑判据**：
// `src/live/geometry.js` 是列表几何的**唯一真相**，这一份盯四件事：
//
//   g1  深度 → 行盒 `margin-left` **逐字**，且值里留着 `var(...)`
//       ——⛔ 不是像素数字（否则字号一改就过期，见 `geometry.js` 文件头）；
//       ⭐ 2026-11-15（`design/0084`）：返回面从 `{padLeft, dotLeft, dotWidth}` 收成
//       `{marginLeft}` —— 标记交给 UA 的 `::marker`，没有"缩进带左缘"这第二样东西了；
//   g2  补位规则的四个分支各自成立（`bugs/0305` ① / `bugs/0112` B4 的判据本体）；
//   g3  g2 的两条关键分支**各自承重**（变异自测，⛔ 不做变异不算数）；
//   g4  第二份公式不许复活：`decorations.js` 里⛔ 再出现 `calc(var(--reader-list-indent) *`
//       这种自己拼的缩进（单一真相的**源码级**判据；行为由 `live-decorations.test.js` 与
//       离屏闸门负责）。
//
// ⚠️ 这一份**不碰 DOM、不读 `getComputedStyle`**：`geometry.js` 承诺只做纯映射。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../../src/live/geometry.js');

const 倍 = function (n) { return 'calc(var(--reader-list-indent) * ' + n + ')'; };

test('g1：深度 → 行盒 `margin-left` 逐字，且留着 `var(...)`（⛔ 不落成像素）', function () {
  assert.deepStrictEqual(G.listGeometryAt(0),
    { depth: 0, marginLeft: 倍(0) },
    'depth 0：行不缩进（第一层缩进在宿主的 padding-left 上）');
  assert.deepStrictEqual(G.listGeometryAt(3),
    { depth: 3, marginLeft: 倍(3) },
    'depth 3：行缩进 3 格');
  // ⚠️ 值必须**带着 `var(`**：阅读态/编辑态共用同一份 CSS 变量，字号与主题一改跟着改。
  const 几何 = G.listGeometryAt(2);
  assert.ok(几何.marginLeft.indexOf('var(') >= 0, '返回的不是 CSS 变量表达式：' + 几何.marginLeft);
  assert.ok(!/[0-9.]+px/.test(几何.marginLeft), '⛔ 出现了写死的像素：' + 几何.marginLeft);
  // ⭐ `design/0084` 的减法：返回面只有 `{depth, marginLeft}`。
  // 多一个 `padLeft`/`dotLeft` 就说明"缩进带"那套手绘标记的坐标又回来了。
  assert.deepStrictEqual(Object.keys(G.listGeometryAt(1)).sort(), ['depth', 'marginLeft'],
    '返回面只能有 `{depth, marginLeft}`（标记由 UA 画，⛔ 不需要缩进带左缘/宽度）');
});

test('g1b：非法 / 边界深度一律夹成 ≥0 的整数（⛔ 出 NaN、⛔ 出负 padding）', function () {
  [undefined, null, NaN, '2', -3, 2.7].forEach(function (bad) {
    const 几何 = G.listGeometryAt(/** @type {any} */ (bad));
    assert.ok(Number.isInteger(几何.depth) && 几何.depth >= 0, '深度没夹干净：' + 几何.depth);
  });
  assert.strictEqual(G.listGeometryAt(-3).depth, 0, '负数夹到 0');
  assert.strictEqual(G.listGeometryAt(2.7).depth, 2, '小数向下取整（⛔ 不是四舍五入）');
});

test('g2：补位规则的四支（`bugs/0305` ① / `bugs/0112` B4）', function () {
  /** @param {{depth?:number, topIsList?:boolean, hostKind?:'list'|'box'|undefined}} i */
  const 深 = function (i) { return G.listGeometry(i).depth; };
  assert.strictEqual(深({ depth: 0, topIsList: true, hostKind: 'list' }), 0,
    '真 `<ul>` 宿主：宿主的 padding-left 已经是第一层缩进 ⇒ ⛔ 不再补（否则 28 + 28 = 56）');
  assert.strictEqual(深({ depth: 0, topIsList: true, hostKind: 'box' }), 1,
    '段落/标题宿主（`bugs/0305` ①）：没人搬 `<ul>` 的 padding-left ⇒ 补 1');
  assert.strictEqual(深({ depth: 0, topIsList: true }), 0,
    '没给宿主（纯逻辑单测）按"不用补" ⇒ ⛔ 不改既有判据的口径');
  assert.strictEqual(深({ depth: 0, topIsList: false, hostKind: 'list' }), 1,
    '最外层块不是列表（藏在引用块里，`bugs/0112` B4）：内层 `<ul>` 同样没人搬 ⇒ 补 1');
  assert.strictEqual(深({ depth: 1, topIsList: true, hostKind: 'box' }), 2, '补位叠在嵌套层数之上');
  assert.deepStrictEqual(G.listGeometry(), G.listGeometryAt(1), '空入参 ＝ 全缺省（补 1、深度 0）');
});

// ⭐ 变异自测：两条关键分支各自承重（`tests.md`：没做过变异测试的断言不算数）。
const GEOM_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'live', 'geometry.js'), 'utf8');
/** 在独立模块作用域里跑一遍源码副本（⛔ 不碰真模块，也不碰 `window`）。 */
function loadGeometry(src) {
  const mod = { exports: {} };
  new Function('module', 'window', src)(mod, undefined);
  return mod.exports;
}

test('g3：去掉 `hostKind === \'box\'` 那一支 ⇒ `bugs/0305` ① 重现，g2 必红', function () {
  const m1 = GEOM_SRC.replace("const 补位 = 顶层即列表 ? (i.hostKind === 'box' ? 1 : 0) : 1;",
    'const 补位 = 顶层即列表 ? 0 : 1;');
  assert.notStrictEqual(m1, GEOM_SRC, 'g3-m1 没改到（靶子漂移）');
  assert.strictEqual(loadGeometry(m1).listGeometry({ depth: 0, topIsList: true, hostKind: 'box' }).depth, 0,
    'g3-m1 没红：段落宿主里的列表仍从 0 起（`bugs/0305` ①）');

  const m2 = GEOM_SRC.replace("const 补位 = 顶层即列表 ? (i.hostKind === 'box' ? 1 : 0) : 1;",
    'const 补位 = 1;');
  assert.notStrictEqual(m2, GEOM_SRC, 'g3-m2 没改到（靶子漂移）');
  assert.strictEqual(loadGeometry(m2).listGeometry({ depth: 0, topIsList: true, hostKind: 'list' }).depth, 1,
    'g3-m2 没红：真 `<ul>` 宿主也被补了 1（28 + 28 = 56 那个"多缩进"）');
});

test('g4：`decorations.js` 里不许有第二份缩进公式（单一真相的源码级判据）', function () {
  const DECO = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'live', 'decorations.js'), 'utf8');
  const 自拼 = DECO.match(/calc\(var\(--reader-list-indent\)\s*\*/g) || [];
  assert.deepStrictEqual(自拼, [],
    '`decorations.js` 又自己拼了缩进表达式——那正是 `design/0065` P1 要收进 `live/geometry.js` 的东西');
  assert.ok(DECO.indexOf('列表几何({') >= 0, '没接上 `listGeometry`：补位规则又回到装饰层了');
  assert.ok(DECO.indexOf('列表几何At(li.depth)') >= 0, '没接上 `listGeometryAt`：行装饰又自己算缩进了');
});
