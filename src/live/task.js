// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// 任务项方框的**纯逻辑**：识别、块内扁平下标、同长度翻转 —— `design/0051` §2.1。
//
// # 它负责什么、⛔ 不负责什么
//
// 这里回答五个问题，五个都**不碰 CM6、不碰控制器、不发 IPC**，因此全部能在 node 里跑：
//   ① 一个 DOM 节点是不是任务项的方框（`<input class="task-list-item-checkbox">`）；
//   ② 一个块底下有几个方框、第 n 个是哪个（**先序**，与后端 `descendants()` 同序）；
//   ③ 把源码里那一行翻过来：`[ ] ↔ [x]`，**同长度替换**（`INV-TASK-01`）；
//   ④ 区间不可信时**抛错、⛔ 不夹取**（与 `live/cell.js::splice` 同一条纪律）；
//   ⑤ ⭐ **武装**（`arm`，2026-10-29 代码评审第 15 条从 `main.js` 搬来）：
//      摘 `disabled`（属性与 property 两处）、退出 Tab 停靠点、挂上两个监听。
//
// ⚠️⚠️ **列的语义**：`from` / `to` 是**行内 UTF-16 码元、0-based 右开**，由**后端**算好
// （`INV-TASK-02`）。这里⛔ 不做任何字节换算——而且任务项有一个结构性事实让这件事
// 更简单：符号**前面**永远是 ASCII 的列表前缀（`- ` / `  ` / `> ` / `1. `），
// 因为 comrak 只在"项内容的最开头"物化 `TaskItem`。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，顶层 `const` 撞名会让
// **整个文件不执行**（窗口空白、stderr 全静默）。理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  /** `nodeType` 的元素节点（探针与单测会塞假节点进来，判据只认这个数）。 */
  const ELEMENT_NODE = 1;

  /** comrak 给任务项方框的 class（`render.tasklist_classes = true`，`parser.rs:110`）。 */
  const BOX_CLASS = 'task-list-item-checkbox';

  /** 能不能翻转的两个符号（后端已经把它们挡成唯一可写的那两种）。 */
  const UNCHECKED = ' ';
  const CHECKED = 'x';

  function classListOf(node) {
    const c = node && node.className;
    return typeof c === 'string' ? c.split(/\s+/) : [];
  }

  /**
   * 这个节点是不是**任务项的方框**。
   *
   * ⚠️ 判据是 **tag ＋ type ＋ class 三件**（⛔ 不看 `disabled`）：
   * `disabled` 会被我们**摘掉**（§2.3），拿它当判据会在武装之后立刻失配。
   * ⚠️ class 由 comrak 无条件写出（`html.rs:1266`），所以它同时是"这是任务项"的凭据。
   */
  function isTaskCheckbox(node) {
    if (!node || node.nodeType !== ELEMENT_NODE) return false;
    const tag = String(node.tagName || '').toUpperCase();
    if (tag !== 'INPUT') return false;
    const type = node.getAttribute ? node.getAttribute('type') : node.type;
    if (String(type === undefined || type === null ? '' : type).toLowerCase() !== 'checkbox') return false;
    const list = classListOf(node);
    for (let i = 0; i < list.length; i++) if (list[i] === BOX_CLASS) return true;
    return false;
  }

  function walk(node, out) {
    const kids = node && node.children;
    if (!kids || typeof kids.length !== 'number') return;
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      if (isTaskCheckbox(kid)) out.push(kid);
      walk(kid, out);
    }
  }

  /**
   * 一个块节点底下的**全部方框**，**先序**（= 文档顺序 = 后端 `descendants()` 的顺序）。
   *
   * ⚠️ 用手写的前序遍历而不是 `querySelectorAll`：载荷里那一串区间是**扁平数组**，
   * 配对全靠"第 n 个"这一层换算，而它必须能用假节点在 node 里验（`live-cell.test.js` 同款）。
   */
  function checkboxesOf(root) {
    const out = [];
    walk(root, out);
    return out;
  }

  /** 方框个数（`INV-TASK-03` 的配对判据用）。 */
  function countOf(root) {
    return checkboxesOf(root).length;
  }

  /** 方框 → 块内**先序扁平下标**；不在这一块里 ⇒ `-1`。 */
  function flatIndexOf(root, el) {
    const list = checkboxesOf(root);
    for (let i = 0; i < list.length; i++) if (list[i] === el) return i;
    return -1;
  }

  /**
   * ⭐ 翻转：把 `line` 的 `[from, to)`（就是一个符号）换成它的反面，**其余逐字节不变**。
   *
   * ⚠️ 越界 / 非符号一律**抛错、⛔ 不夹取**：夹取会把"用陈旧的列区间提交"这个错误
   * **静默**变成"改到了附近"，而屏幕上看起来是对的（`INV-TASK-01`）。
   * @returns {string} 与 `line` **等长**的新行
   */
  function toggleLine(line, from, to) {
    if (typeof line !== 'string') throw new Error('任务项写回：行不是字符串');
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error('任务项写回：列坐标必须是整数');
    if (from < 0 || to !== from + 1 || to > line.length) {
      throw new Error(`任务项写回：列区间越界 ${from}-${to}（行长 ${line.length}）`);
    }
    const sym = line.slice(from, to);
    let next;
    if (sym === UNCHECKED) next = CHECKED;
    else if (sym === CHECKED || sym === 'X') next = UNCHECKED;
    else throw new Error(`任务项写回：那一处不是可打勾的符号：${JSON.stringify(sym)}`);
    return line.slice(0, from) + next + line.slice(to);
  }

  /**
   * **把这一行翻一下之后**是不是"已勾上"（调用方据此选状态条文案）。
   * ⚠️⚠️ 参数是**翻转之前**的那一行——本函数内部会自己翻一次。
   * 传翻转之后的会**连翻两下**，状态条永远说反（`design/0051` §10，2026-10-27 的 V 段实测）。
   */
  function isCheckedSymbol(line, from, to) {
    return toggleLine(line, from, to).charAt(from) !== UNCHECKED;
  }

  /**
   * ⭐ **武装一个根节点底下的全部方框**（`INV-TASK-07`）：摘 `disabled`、退出 Tab 停靠点、
   * 挂上两个监听。返回**这一趟新武装了几个**（幂等：已武装过的跳过）。
   *
   * ⚠️⚠️ **为什么必须摘 `disabled`**：WebKit 对 `disabled` 表单控件**不派发**鼠标事件
   * ⇒ 不摘的话这条路上**永远收不到** `click`。代价是观感由"灰方框"变成可点方框，
   * 而灰方框本来就在骗人——方框所在的 `List` 块**本来就能就地改**（`design/0051` §2.3）。
   * ⚠️ **属性与 property 两处都要摘**：只改一项在 WebKit 上仍算 `disabled`。
   * ⛔ 不新增 Tab 停靠点（`tabIndex = -1`）：阅读态按 Tab 离开正文是老行为。
   *
   * ⭐ **2026-10-29 代码评审第 15 条把它从 `main.js` 搬到这里**：这是一段
   * "看到什么就改什么"的**判据**（哪些算方框、摘哪两处、要不要占 Tab 位），
   * 而 `main.js` 既不在 `tests/js/` 里、也不在 `make typecheck` 的范围里
   * ⇒ 住在那一层时**任何断言都碰不到**。搬过来之后 `live-task.test.js` 用假节点就能验。
   * 留在 `main.js` 的只有**接线**（`#doc` 从哪来、两个回调是谁）。
   *
   * @param {any} root 挂载点（产品是 `#doc`）
   * @param {{down?: Function, click?: Function}} [handlers] 两个监听（`currentTarget` 是那个方框）
   * @returns {number} 这一趟新武装的个数（0 = 没有方框 / 全都武装过了）
   */
  function arm(root, handlers) {
    const h = handlers || {};
    const boxes = checkboxesOf(root);
    let armed = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      // 同一次挂载只武装一次（提交链上 `noteLive` 可能被再调一次）。
      if (box.__rmdTaskArmed) continue;
      box.__rmdTaskArmed = true;
      box.disabled = false;
      box.removeAttribute('disabled');
      box.tabIndex = -1;
      // ⚠️ `checked` 的翻转发生在 `click` **派发之前**（HTML 的 pre-click activation steps）
      // ⇒ 想拿"屏幕上原来是什么样"，只能在更早的 `mousedown` 里记一笔。
      if (typeof h.down === 'function') box.addEventListener('mousedown', h.down);
      if (typeof h.click === 'function') box.addEventListener('click', h.click);
      armed += 1;
    }
    return armed;
  }

  const api = {
    isTaskCheckbox: isTaskCheckbox,
    checkboxesOf: checkboxesOf,
    countOf: countOf,
    flatIndexOf: flatIndexOf,
    arm: arm,
    toggleLine: toggleLine,
    isCheckedSymbol: isCheckedSymbol,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveTask = api;
})();
