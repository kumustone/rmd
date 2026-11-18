// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
//
// `design/0065` P1（2026-11-10 用户批准「立即开工」）：**列表几何的唯一真相**。
//
// # 它回答什么、⛔ 不回答什么
//
// 一个列表行只要一样东西：行盒的 **`margin-left`**（正文从哪儿起 ＝ 缩进几格）。
// 以前还有第二样——"圆点/编号那条缩进带的左缘 `--rmd-li-left`"，因为标记是手绘的 `::before`。
// ⭐ 2026-11-15（`design/0084`，用户批准「按照你的建议执行」）之后**没有第二样了**：
//   行 `display: list-item`，标记交给 UA 的 `::marker`，UA 自己按边框盒定位
//   ⇒ 本文件只给"缩进写在 `margin-left` 上"这一个值。
// ⚠️ 缩进**必须**写在 `margin-left` 上：UA 的标记按**边框盒**定位，缩进写在项自身的
//   `padding-left` 上时标记整体左移一个缩进（离屏实测 64 设备 px，`docs/bugs/0113` §8）。
// 缩进量以前**各算一遍**：写死在 `decorations.js` 的 `calc()` 字符串里，而"深度从谁起算"
// 又由"宿主是不是 `<ul>`"临时补位（`bugs/0305` ①）。本文件把这件事收成**一个纯函数**：
// 输入（嵌套层数、最外层块是不是列表、宿主品种），输出（深度与那一行 CSS 值）。
//
// ⛔ 这里**不读 DOM、不读 `getComputedStyle`、不碰 CM6**：`tests/js/live-*.test.js` 能直接跑。
// ⛔ 也**不写死像素**：返回值里留着 `var(--reader-list-indent)`，字号一改跟着改
//   （`INV-TYPE-02`；数值仍然只有 `tokens.css` 那一份 ⇒ 不会出现第二个真相）。
//   ⇒ 这也是为什么函数返回的是 **CSS 字符串**而不是数字：装饰在进入编辑态时算一次就缓存，
//     若换成"读一次 px 再算数字"，用户中途调字号/主题会让缓存里那份**过期**且没人重算。
(function () {
  'use strict';

  /**
   * 把**已经定下来的深度**换成行盒的 `margin-left`（`listGeometry` 的后半段；
   * `decorations.js` 里「同一行可能被多个列表节点记深度、取最大值」⇒ 数值定下来之后
   * 还要再映射一次）。
   *
   * @param {number} depth 最终深度（≥ 0）
   * @param {string} [indentVar] 缩进变量名（缺省 `--reader-list-indent`）
   * @returns {{depth:number, marginLeft:string}}
   */
  function listGeometryAt(depth, indentVar) {
    const v = indentVar || '--reader-list-indent';
    const 深 = typeof depth === 'number' && isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
    /** @param {number} n */
    const 倍 = function (n) { return 'calc(var(' + v + ') * ' + n + ')'; };
    return {
      depth: 深,
      // ⚠️ 写在 `margin-left` 上，⛔ 不是 `padding-left`（理由见文件头）。
      marginLeft: 倍(深),
    };
  }

  /**
   * 计算一个列表行的几何。
   *
   * @param {{
   *   depth?: number,                  // 列表**嵌套层数**（最外层列表里的项 ＝ 0）
   *   topIsList?: boolean,             // 这一行所在的最外层块**就是** `<ul>`/`<ol>`
   *   hostKind?: 'list'|'box'|undefined, // 宿主元素是不是列表：'list'＝`<ul>`/`<ol>`，'box'＝段落/标题/引用等
   *   indentVar?: string               // 缩进变量名（缺省 `--reader-list-indent`）
   * }} [input]
   * @returns {{depth:number, marginLeft:string}}
   */
  function listGeometry(input) {
    const i = input || {};
    const 层 = typeof i.depth === 'number' && isFinite(i.depth)
      ? Math.max(0, Math.floor(i.depth))
      : 0;
    const 顶层即列表 = i.topIsList === true;
    // ⭐ **补位规则（唯一一份）**：
    //   · 最外层块就是列表，且宿主搬的正是那个 `<ul>` ⇒ 第一层缩进已经在宿主的 `padding-left` 上，
    //     行级从 0 起（否则 28 ＋ 28 ＝ 56，`bugs/0113` C1 那个"多缩进"）；
    //   · 最外层块就是列表，但宿主是 `<p>`/`<h*>`（在段落里现敲出来的列表）⇒ 没人搬 `<ul>` 的
    //     `padding-left`，行级补 1（`bugs/0305` ①）；
    //   · 最外层块不是列表（列表藏在引用块/列表项里）⇒ 内层 `<ul>` 的 `padding-left` 同样没人搬，
    //     一律补 1。
    //   ⚠️ `undefined`（纯逻辑单测没给宿主）按"不用补"处理，⛔ 不改既有判据的口径。
    const 补位 = 顶层即列表 ? (i.hostKind === 'box' ? 1 : 0) : 1;
    return listGeometryAt(层 + 补位, i.indentVar);
  }

  /** @type {{listGeometry: typeof listGeometry, listGeometryAt: typeof listGeometryAt}} */
  const api = { listGeometry: listGeometry, listGeometryAt: listGeometryAt };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveGeometry = api;
})();
