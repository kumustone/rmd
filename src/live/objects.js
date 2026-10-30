// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// 编辑对象的**策略表** —— `design/0054` `INV-EDITOBJ-01/02/05`。
//
// # 为什么要有这一份
//
// 在它之前，**同一条约束散在三个地方各写一半**，每一处只记住自己那一半：
//   · `main.js::onPaste` 的 `isCell ? text2.replace(/\r\n?|\n/g, ' ') : text2`
//     —— 「⛔ 无换行」这条约束**只有粘贴一个入口**在管；
//   · `main.js::makeLiveView` 的 `cellContext: isCell`
//     —— 呈现模式（只按行内语义）由接线处临时判；
//   · `main.js::onKeyDown` 的 `if (isCell) { Tab 走格 / Enter 走格 }`
//     —— 允许的操作在键处理里临时判。
// ⚠️ 三处的失效形态**全是静默的**：折错了只有"表格在粘贴瞬间跳一下"看得见（`Q14b`）、
//    呈现错了只有字号变掉看得见（2026-10-28 评审 P2-③）、走格错了只有"按 Enter 没反应"。
//
// # 契约（表在 `design/0054` §2.1，⛔ 别在这里再抄一遍那张表）
//
// 每个对象声明四件事：**允许的操作** / **输入约束** / **呈现模式** / **写回校验**。
// 本文件是这四件事的**唯一**声明处；执行者只读、⛔ 不各判各的：
//   · `live/input.js::createInputMachine(onTransaction, policy)` —— 任何文本入口都过 `policy.text`；
//   · `live/decorations.js` 的 `cellContext` —— 接线层传 `policy.inlineOnly`；
//   · `main.js::onKeyDown` —— 读 `policy.tab` / `policy.enter`；
//   · `main.js::makeLiveView` —— 读 `policy.box`；
//   · `live/index.js::commitActive` —— 读 `policy.verify` 决定走哪条写回校验。
//
// ⚠️ **任务项方框不在表里**，⛔ 不是漏了：它是**阅读态**里"同长度翻转一个字节"，
//    根本不过输入机（`design/0051`）；它的"同长度"由后端 `symbol_sourcepos` 保证，
//    前端没有第二处判断 —— 给它编一个没人读的字段，只会让下一个人以为那里有约束。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，
// 顶层 `const` 撞名会让**整个文件不执行**（窗口空白、stderr 全静默）。
// 理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  /**
   * 一条文本约束：原文 → 该进视图的文本。
   * @callback TextRule
   * @param {string} text
   * @returns {string}
   */

  /**
   * @typedef {object} Policy
   * @property {string} id 对象名（状态条与判据里说人话用）
   * @property {boolean} inlineOnly 呈现：装饰层**只按行内语义**（旧 `cellContext`）
   * @property {boolean} box 呈现：是否把被替换元素的盒子搬到 host（`live/box.js`）
   * @property {'leave'|'walk'} tab `Tab`：提交并退出这一块 / 走到下一格
   * @property {'newline'|'walk'} enter 裸 `Enter`：换行 / 走格
   * @property {TextRule} text **任何**文本入口（键盘 / `beforeinput` / `paste` /
   *   `compositionend`）的约束 —— ⛔ 只在某一个入口上折的行，别的入口照样漏得进来
   * @property {'lines'|'structure'} verify 写回校验：行区间 / 行区间 ＋ 结构
   */

  /** 原文照收（⛔ 不折、⛔ 不改）——缺省的那条约束。 */
  /**
   * @type {TextRule}
   */
  function identity(text) {
    return String(text === undefined || text === null ? '' : text);
  }

  /** 块级对象（段落 / 标题 / 列表 / 引用 / 代码块）——**换行原样进来**。 */
  const BLOCK = Object.freeze({
    id: 'block',
    inlineOnly: false,
    box: true,
    tab: /** @type {const} */ ('leave'),
    enter: /** @type {const} */ ('newline'),
    // ⛔ 不折：`INV-LIVE-13` 的归一化只有状态机那一份，在这里再折一遍
    //    等于把"粘贴两行"变成"粘一行"（探针 `O-*-5c` 的期望正好相反）。
    text: /** @type {TextRule} */ (identity),
    verify: /** @type {const} */ ('lines'),
  });

  /**
   * ⭐ **表格单元格的输入约束：换行原样进来**（`bugs/0035`，2026-10-28 用户需求变更）。
   *
   * 用户原话：「表格编辑还是不能换行，enter 键无法换到下一行，直接到表格的下一行中了」
   * ⇒ 格内 `Enter` / 粘贴多行**都要**在视图里真的换行。
   *
   * ⚠️⚠️ 这里原先折成**空格**（`design/0049` §4「GFM 的单元格写不进字面换行」）。
   * 那句话在**源码**层仍然成立——所以换行的**存储**形态是 `<br>`，由
   * `live/cell.js::encode` 写、`decode` 读，后端 `parser.rs::honor_cell_line_breaks`
   * 把**单元格内**的 `<br>` 还原成换行节点（`render.unsafe` 仍然关着）。
   * ⇒ 视图里是 `\n`、源码里是 `<br>`，两边都对得上。
   *
   * ⚠️ 为什么入口这里**什么都不做**：约束只剩"换行合法"这一条，
   *    再做一层就是第二份事实（`INV-EDITOBJ-01`）。⛔ 别再引入 `foldNewlines`。
   */
  const CELL = Object.freeze({
    id: 'cell',
    inlineOnly: true,
    box: false,
    tab: /** @type {const} */ ('walk'),
    enter: /** @type {const} */ ('newline'),
    text: /** @type {TextRule} */ (identity),
    verify: /** @type {const} */ ('structure'),
  });

  /**
   * 这个语境用哪一份策略。
   *
   * ⚠️ `INV-EDITOBJ-05`：**新对象先填契约表再接线**——⛔ 不许"先接线、回头补一行"，
   *    也不许在调用点写 `ctx.cell ? … : …` 那样的第三份判断。
   * @param {{cell?:object|null}|null|undefined} ctx
   * @returns {Policy}
   */
  function policyOf(ctx) {
    const c = ctx || {};
    return c.cell ? CELL : BLOCK;
  }

  const api = {
    policyOf: policyOf,
    BLOCK: BLOCK,
    CELL: CELL,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveObjects = api;
})();
