// L-0307：**列表项的增删改查行为矩阵**（`docs/bugs/0305` / `0306` 之后的补强）。
//
// # 这一份要钉住什么
//
// 用户反馈「列表项的增删改查，问题特别多」。现有 6 份 `editing-*-matrix` 与
// `live-*.test.js` 已经覆盖了单条判据（`input.js::lineBreakAction` 的手写 plan、
// `selection.js::deleteRange` 的隐藏区间、`task.js::toggleLine` 的单行翻转），
// 但**没有一份把"装饰层算出的真实 plan"接到"输入/删除/打勾动作"上跑一整圈**。
// 本文件补的就是这一圈：
//
//   `decorations.js::markers()`（产品同一个 Markdown 解析器）
//        ↓ `listLines` / `ranges` / `tasks`
//   `input.js::lineBreakAction()` · `selection.js::deleteRange()` · `task.js::toggleLine()`
//        ↓ 事务描述 `{from, to, data}` / 删除区间
//   测试自己把事务应用回源码 → 再跑一次 `markers()` 核对**结构后置条件**
//
// ⚠️ 这里**不重写列表算法当 oracle**（`.claude/rules/tests.md` 的硬规则）：
//    期望值全部是**逐字节的源码串**＋产品模块自己解析出的 `kind` / `depth` / `tasks`。
//    测试只做三件事：调产品函数、把返回的事务应用回字符串、再问产品"现在是什么结构"。
//
// # 不含什么（别把这份当完整验收）
//
// - ⛔ 不碰 DOM / CM6 `EditorView` / 真键盘事件 ⇒ `bugs/0306` 的"焦点离开后删不掉"
//   那条接线缺陷（离屏 textarea 失焦后的选区/键位路径）不在这里证明；
// - ⛔ 不测真 IME、系统剪贴板、鼠标拖选；那些各有自己的闸门；
// - ⛔ 不测 Tab 缩进/反缩进的行为——产品当前**没有**这个动作（`bugs/0116`），
//   对应格显式 `test.skip`，证据见文件尾的「已知缺口」。
//
// # 覆盖表（操作 × 状态 → 格 ID）
//
// 状态列按"这一格实际覆盖到的维度"填；`—` = 该组合不适用（例：空项回车没有"行中"）。
// ID 完整名见下面的数据表，测试名形如 `L-0307-01 行尾回车续标记 · …`。
//
// | 操作 | 紧列表 | 松列表 | 无序 | 有序 1. | 有序 3. | 顶层 | 嵌套 | 行首 | 行中 | 行尾 | 跨行选区 | 无选区 | 任务项 | 普通项 |
// |---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
// | 行尾回车续标记 | 01,03,04,06,07,08,10,11,12 | 02,05,09 | 01,02,07,10,11,12 | 03,05,08 | 04 | 01–06,10 | 07,08,09 | — | — | 01–12 | — | 01–12 | 06,09 | 01–05,07,08,10–12 |
// | 行中回车 | 13,15,17,18,19,20,21,22,31,32 | 14,16 | 13,14,19,21,22,23 | 15,20 | 16,32 | 13–18,21–23,31,32 | 19,20 | 21,31,32 | 13–20,23 | — | 22 | 13–21,23,31,32 | 17,18,31 | 13–16,19–23,32 |
// | 空项上回车（退出列表） | 24,26,28,29,30 | 25,27 | 24,25,29,30 | 26 | 27 | 24–28,30 | 29 | — | — | 24–30 | — | 24–30 | 28 | 24–27,29,30 |
// | 行首退格删标记 | 01,02,04,06,07,08,09,15,16 | 03,05 | 01,02,03,07,15,16 | 04,08 | 05 | 01–06,09,15,16 | 07,08 | 01–09,15,16 | — | — | — | 01–09,15,16 | 06,09 | 01–05,07,08,15,16 |
// | 空行上退格 | 13 | 10,11,12 | 10,13,14 | 11 | — | 10–14 | — | 10–14 | — | — | — | 10–14 | 12 | 10,11,13,14 |
// | 删除整项 | 01,02,03,07,09,10,11,12,13,14,15,17 | 04,05,06,08,16 | 01–06,09–13,15,16 | 07,17 | 08,14 | 01–09,12–16 | 10,11,17 | — | 12 | — | 12,13 | — | 09,16 | 01–08,10–15,17 |
// | 切换任务框 | 01,02,04,06,07,08,09,10,11,13 | 03,05,12 | 01,02,03,06,07,08,09,10,11,12 | 04,13 | 05 | 01–05,07–12 | 06,13 | — | — | — | — | 01–13 | 01–09,11,12,13 | 10 |
// | Tab 缩进（skip，`0116`） | 01 | — | 01,03 | 02 | — | 01,02 | 03 | 01–03 | — | — | — | 01–03 | — | 01–03 |
// | Shift-Tab 取消缩进（skip，`0116`） | 04,05 | — | 04 | — | — | 05 | 04 | 04,05 | — | — | — | 04,05 | — | 04,05 |
//
// 合计 **84 格**：运行 79（78 条行为格 + 1 条缺口取证）＋ Tab 缺口 5（skip）；
// 另有 5 条变异自检。⚠️ 数字以文件尾的 `L-0312-01 覆盖汇总` 实跑为准，别从这张表手抄。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const D = require('../../src/live/decorations.js');
const I = require('../../src/live/input.js');
const S = require('../../src/live/selection.js');
const T = require('../../src/live/task.js');
// ⚠️ `@codemirror/lang-markdown` 是 ESM，node ≥ 22.12 的 `require(esm)` 能直接取到。
//    这是**产品同一个**解析器（`live-decorations.test.js` 同口径），⛔ 不另装一套。
const { markdownLanguage } = require('@codemirror/lang-markdown');

// ── harness ────────────────────────────────────────────────────────────────

/** 产品同一个解析器造树；`markers()` 只认树，不碰 CM6 / DOM。 */
function parse(text) {
  return markdownLanguage.parser.parse(String(text));
}

/** 装饰层的真实 plan（`listLines` / `ranges` / `tasks` 全在这里）。 */
function plan(text, opts) {
  return D.markers(text, Object.assign({ tree: parse(text) }, opts || {}));
}

/**
 * CM6 `Text` 的最小替身（与 `live-selection.test.js` / `live-gap` 同口径：
 * `lineAt(pos).to` 是行尾**之前**，`length` 是 UTF-16 码元）。
 */
function doc(text) {
  const src = String(text);
  const lines = src.split('\n');
  const starts = [];
  let p = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(p);
    p += lines[i].length + 1;
  }
  return {
    length: src.length,
    lines: lines.length,
    lineAt: function (pos) {
      const at = Math.max(0, Math.min(pos, src.length));
      let i = lines.length - 1;
      for (let k = 0; k < lines.length; k++) {
        if (at <= starts[k] + lines[k].length) { i = k; break; }
      }
      return { number: i + 1, from: starts[i], to: starts[i] + lines[i].length, text: lines[i] };
    },
  };
}

/** 把 `lineBreakAction` 的事务描述应用回源码（测试侧的"编辑器"）。 */
function applyAction(text, action) {
  return text.slice(0, action.from) + action.data + text.slice(action.to);
}

/** 把 `deleteRange` 的区间应用回源码。 */
function applyRange(text, range) {
  return text.slice(0, range.from) + text.slice(range.to);
}

/** 结构后置条件：产品模块自己解析出的 `[行号, 品种, 深度]`。 */
function listShape(text) {
  return plan(text).listLines.map(function (l) {
    return [l.line, l.kind, l.depth];
  });
}

/** 任务框的 `[{pos, checked}]`（产品模块给的落点与状态）。 */
function taskShape(text) {
  return plan(text).tasks.map(function (t) {
    return [t.pos, t.checked];
  });
}

/**
 * 注册一格。
 * ⚠️ `EXECUTED` 只记**真的跑完并断言通过**的格；文件尾的汇总据此说"实际覆盖"，
 *    ⛔ 不把计划数当实跑数。
 */
const EXECUTED = new Set();
function cell(id, name, fn) {
  test(id + ' ' + name, function () {
    fn();
    EXECUTED.add(id);
  });
}

// ── L-0307 回车：续标记 / 行中劈项 / 空项退出 ──────────────────────────────
//
// 判据 = `input.js::lineBreakAction(text, plan, from, to)` 的动作描述。
// `plan` 是 `markers()` 的真实输出，⛔ 不是手写的 `listLines` 假数据。

/** @type {any[]} */
const ENTER_CELLS = [
  // 行尾回车：续标记
  { id: 'L-0307-01', name: '行尾回车续标记 · 紧列表 · 无序 · 顶层 · 行尾 · 无选区',
    text: '- 甲', from: 3, to: 3, type: 'insert', out: '- 甲\n- ',
    lines: [[0, 'bullet', 0], [1, 'bullet', 0]] },
  { id: 'L-0307-02', name: '行尾回车续标记 · 松列表 · 无序 · 顶层 · 行尾 · 无选区',
    text: '- 甲\n\n- 乙', from: 3, to: 3, type: 'insert', out: '- 甲\n- \n\n- 乙',
    lines: [[0, 'bullet', 0], [1, 'bullet', 0], [2, 'plain', 0], [3, 'bullet', 0]] },
  { id: 'L-0307-03', name: '行尾回车续标记 · 紧列表 · 有序 1. · 顶层 · 行尾 · 无选区',
    text: '1. 甲', from: 4, to: 4, type: 'insert', out: '1. 甲\n2. ',
    lines: [[0, 'ordered', 0], [1, 'ordered', 0]] },
  { id: 'L-0307-04', name: '行尾回车续标记 · 紧列表 · 有序 3. · 顶层 · 行尾 · 无选区',
    text: '3. 甲', from: 4, to: 4, type: 'insert', out: '3. 甲\n4. ',
    lines: [[0, 'ordered', 0], [1, 'ordered', 0]] },
  { id: 'L-0307-05', name: '行尾回车续标记 · 松列表 · 有序 1. · 顶层 · 行尾 · 无选区',
    text: '1. 甲\n\n2. 乙', from: 4, to: 4, type: 'insert', out: '1. 甲\n2. \n\n2. 乙',
    lines: [[0, 'ordered', 0], [1, 'ordered', 0], [2, 'plain', 0], [3, 'ordered', 0]] },
  { id: 'L-0307-06', name: '行尾回车续标记 · 紧列表 · 任务项(已勾) · 顶层 · 行尾 · 无选区',
    text: '- [x] 甲', from: 7, to: 7, type: 'insert', out: '- [x] 甲\n- [ ] ',
    lines: [[0, 'task', 0], [1, 'task', 0]], tasks: [[6, true], [14, false]] },
  { id: 'L-0307-07', name: '行尾回车续标记 · 紧列表 · 无序 · 嵌套 · 行尾 · 无选区 · 普通项',
    text: '- 甲\n  - 乙', from: 9, to: 9, type: 'insert', out: '- 甲\n  - 乙\n  - ',
    lines: [[0, 'bullet', 0], [1, 'bullet', 1], [2, 'bullet', 1]] },
  { id: 'L-0307-08', name: '行尾回车续标记 · 紧列表 · 有序 1. · 嵌套 · 行尾 · 无选区 · 普通项',
    text: '- 甲\n  1. 乙', from: 10, to: 10, type: 'insert', out: '- 甲\n  1. 乙\n  2. ',
    lines: [[0, 'bullet', 0], [1, 'ordered', 1], [2, 'ordered', 1]] },
  { id: 'L-0307-09', name: '行尾回车续标记 · 松列表 · 任务项(未勾) · 嵌套 · 行尾 · 无选区',
    text: '- 甲\n\n  - [ ] 乙', from: 14, to: 14, type: 'insert',
    out: '- 甲\n\n  - [ ] 乙\n  - [ ] ',
    lines: [[0, 'bullet', 0], [1, 'plain', 0], [2, 'task', 1], [3, 'task', 1]],
    tasks: [[13, false], [23, false]] },
  { id: 'L-0307-10', name: '行尾回车续标记 · 紧列表 · 无序 · 顶层 · 行尾(尾随空白)',
    text: '- 甲  ', from: 3, to: 3, type: 'insert', out: '- 甲  \n- ',
    lines: [[0, 'bullet', 0], [1, 'bullet', 0]] },
  { id: 'L-0307-11', name: '行尾回车续标记 · 紧列表 · 无序 · 引用内顶层 · 行尾',
    text: '> - 甲', from: 5, to: 5, type: 'insert', out: '> - 甲\n> - ',
    lines: [[0, 'bullet', 1], [1, 'bullet', 1]] },
  { id: 'L-0307-12', name: '行尾回车续标记 · 紧列表 · 无序 · 续行 · 行尾',
    text: '- 甲\n  续行', from: 8, to: 8, type: 'insert', out: '- 甲\n  续行\n- ',
    lines: [[0, 'bullet', 0], [1, 'plain', 0], [2, 'bullet', 0]] },

  // 行中回车：把当前项一分为二，新项续同品种前缀
  { id: 'L-0307-13', name: '行中回车 · 紧列表 · 无序 · 顶层 · 行中 · 无选区 · 普通项',
    text: '- 甲乙', from: 3, to: 3, type: 'insert', out: '- 甲\n- 乙',
    lines: [[0, 'bullet', 0], [1, 'bullet', 0]] },
  { id: 'L-0307-14', name: '行中回车 · 松列表 · 无序 · 顶层 · 行中 · 无选区 · 普通项',
    text: '- 甲乙\n\n- 丙', from: 3, to: 3, type: 'insert', out: '- 甲\n- 乙\n\n- 丙',
    lines: [[0, 'bullet', 0], [1, 'bullet', 0], [2, 'plain', 0], [3, 'bullet', 0]] },
  { id: 'L-0307-15', name: '行中回车 · 紧列表 · 有序 1. · 顶层 · 行中 · 无选区 · 普通项',
    text: '1. 甲乙', from: 4, to: 4, type: 'insert', out: '1. 甲\n2. 乙',
    lines: [[0, 'ordered', 0], [1, 'ordered', 0]] },
  { id: 'L-0307-16', name: '行中回车 · 松列表 · 有序 3. · 顶层 · 行中 · 无选区 · 普通项',
    text: '3. 甲乙\n\n4. 丙', from: 4, to: 4, type: 'insert', out: '3. 甲\n4. 乙\n\n4. 丙',
    lines: [[0, 'ordered', 0], [1, 'ordered', 0], [2, 'plain', 0], [3, 'ordered', 0]] },
  { id: 'L-0307-17', name: '行中回车 · 紧列表 · 任务项(未勾) · 顶层 · 行中 · 无选区',
    text: '- [ ] 甲乙', from: 7, to: 7, type: 'insert', out: '- [ ] 甲\n- [ ] 乙',
    lines: [[0, 'task', 0], [1, 'task', 0]], tasks: [[6, false], [14, false]] },
  { id: 'L-0307-18', name: '行中回车 · 紧列表 · 任务项(已勾) · 顶层 · 行中 · 无选区',
    text: '- [x] 甲乙', from: 7, to: 7, type: 'insert', out: '- [x] 甲\n- [ ] 乙',
    lines: [[0, 'task', 0], [1, 'task', 0]], tasks: [[6, true], [14, false]] },
  { id: 'L-0307-19', name: '行中回车 · 紧列表 · 无序 · 嵌套 · 行中 · 无选区 · 普通项',
    text: '- 甲\n  - 乙丙', from: 9, to: 9, type: 'insert', out: '- 甲\n  - 乙\n  - 丙',
    lines: [[0, 'bullet', 0], [1, 'bullet', 1], [2, 'bullet', 1]] },
  { id: 'L-0307-20', name: '行中回车 · 紧列表 · 有序 1. · 嵌套 · 行中 · 无选区 · 普通项',
    text: '- 甲\n  1. 乙丙', from: 10, to: 10, type: 'insert', out: '- 甲\n  1. 乙\n  2. 丙',
    lines: [[0, 'bullet', 0], [1, 'ordered', 1], [2, 'ordered', 1]] },
  { id: 'L-0307-21', name: '行中回车(行首) · 紧列表 · 无序 · 顶层 · 行首 · 无选区',
    text: '- 甲乙', from: 0, to: 0, type: 'insert', out: '- \n- 甲乙',
    lines: [[0, 'bullet', 0], [1, 'bullet', 0]] },
  { id: 'L-0307-22', name: '行中回车 · 紧列表 · 无序 · 顶层 · 跨行选区',
    text: '- 甲\n- 乙', from: 3, to: 7, type: 'insert', out: '- 甲\n',
    lines: [[0, 'bullet', 0]] },
  { id: 'L-0307-23', name: '行中回车 · 普通段落 · 行中 · 无选区',
    text: '正文', from: 1, to: 1, type: 'insert', out: '正\n文',
    lines: [] },
  { id: 'L-0307-31', name: '行中回车(行首) · 紧列表 · 任务项(未勾) · 顶层 · 行首',
    text: '- [ ] 甲乙', from: 0, to: 0, type: 'insert', out: '- [ ] \n- [ ] 甲乙',
    lines: [[0, 'task', 0], [1, 'task', 0]], tasks: [[6, false], [13, false]] },
  { id: 'L-0307-32', name: '行中回车(行首) · 紧列表 · 有序 3. · 顶层 · 行首',
    text: '3. 甲乙', from: 0, to: 0, type: 'insert', out: '3. \n4. 甲乙',
    lines: [[0, 'ordered', 0], [1, 'ordered', 0]] },

  // 空项上回车：删掉标记、退回正文（不是"续出一个新项"）
  { id: 'L-0307-24', name: '空项上回车 · 紧列表 · 无序 · 顶层 · 行尾 · 退出列表',
    text: '- ', from: 2, to: 2, type: 'delete', out: '',
    lines: [] },
  { id: 'L-0307-25', name: '空项上回车 · 松列表 · 无序 · 顶层 · 行尾 · 退出列表',
    text: '- \n\n- 乙', from: 2, to: 2, type: 'delete', out: '\n\n- 乙',
    lines: [[2, 'bullet', 0]] },
  { id: 'L-0307-26', name: '空项上回车 · 紧列表 · 有序 1. · 顶层 · 行尾 · 退出列表',
    text: '1. ', from: 3, to: 3, type: 'delete', out: '',
    lines: [] },
  { id: 'L-0307-27', name: '空项上回车 · 松列表 · 有序 3. · 顶层 · 行尾 · 退出列表',
    text: '3. \n\n4. 乙', from: 3, to: 3, type: 'delete', out: '\n\n4. 乙',
    lines: [[2, 'ordered', 0]] },
  { id: 'L-0307-28', name: '空项上回车 · 紧列表 · 任务项(未勾) · 顶层 · 行尾 · 退出列表',
    text: '- [ ] ', from: 6, to: 6, type: 'delete', out: '',
    lines: [] },
  // ⚠️ 2026-11-14（`bugs/0116` §10）：空项回车在**内层**是"升一级"（Notion / Mardo 口径），
  //    ⛔ 不再整条退出列表——所以这一格从 `out: '- 甲\n'` 改成留在列表里、只退一层缩进。
  { id: 'L-0307-29', name: '空项上回车 · 紧列表 · 无序 · 嵌套 · 行尾 · 升一级',
    text: '- 甲\n  - ', from: 8, to: 8, type: 'delete', out: '- 甲\n- ',
    lines: [[0, 'bullet', 0], [1, 'bullet', 0]] },
  { id: 'L-0307-30', name: '空项上回车 · 紧列表 · 无序 · 顶层 · 尾随空白 · 退出列表',
    text: '-   ', from: 2, to: 2, type: 'delete', out: '',
    lines: [] },
];

for (const c of ENTER_CELLS) {
  cell(c.id, c.name, function () {
    const p = plan(c.text);
    const action = I.lineBreakAction(c.text, p, c.from, c.to);
    assert.equal(action.type, c.type,
      '动作类型不对：空项要删标记、其余要插前缀（`input.js::lineBreakAction` 分支 ②/③）');
    const out = applyAction(c.text, action);
    assert.equal(out, c.out, '事务应用回源码后逐字节不符');
    assert.deepEqual(listShape(out), c.lines, '结果结构（行号/品种/深度）与产品解析不符');
    if (c.tasks) assert.deepEqual(taskShape(out), c.tasks, '任务框落点/勾选状态不符');
  });
}

// ── L-0308 退格：行首删标记 / 空行 / 续行 ─────────────────────────────────
//
// 判据 = `selection.js::deleteRange(doc, sel, {hidden})`。
// `hidden` 是 `markers().ranges` 的真实隐藏区间（`- ` / 缩进 / 任务标记全在里面）。

/** @type {any[]} */
const BACKSPACE_CELLS = [
  { id: 'L-0308-01', name: '行首退格删标记 · 紧列表 · 无序 · 顶层 · 首项',
    text: '- 甲\n- 乙', sel: { anchor: 2, head: 2 }, range: { from: 0, to: 2 },
    out: '甲\n- 乙', lines: [[1, 'bullet', 0]] },
  { id: 'L-0308-02', name: '行首退格删标记 · 紧列表 · 无序 · 顶层 · 次项',
    text: '- 甲\n- 乙', sel: { anchor: 6, head: 6 }, range: { from: 4, to: 6 },
    out: '- 甲\n乙', lines: [[0, 'bullet', 0], [1, 'plain', 0]] },
  { id: 'L-0308-03', name: '行首退格删标记 · 松列表 · 无序 · 顶层 · 次项（删空行，`0305`）',
    text: '- 甲\n\n- 乙', sel: { anchor: 7, head: 7 }, range: { from: 4, to: 5 },
    out: '- 甲\n- 乙', lines: [[0, 'bullet', 0], [1, 'bullet', 0]] },
  { id: 'L-0308-04', name: '行首退格删标记 · 紧列表 · 有序 1. · 顶层 · 次项',
    text: '1. 甲\n2. 乙', sel: { anchor: 8, head: 8 }, range: { from: 5, to: 8 },
    out: '1. 甲\n乙', lines: [[0, 'ordered', 0], [1, 'plain', 0]] },
  { id: 'L-0308-05', name: '行首退格删标记 · 松列表 · 有序 3. · 顶层 · 次项（删空行）',
    text: '3. 甲\n\n4. 乙', sel: { anchor: 9, head: 9 }, range: { from: 5, to: 6 },
    out: '3. 甲\n4. 乙', lines: [[0, 'ordered', 0], [1, 'ordered', 0]] },
  { id: 'L-0308-06', name: '行首退格删标记 · 紧列表 · 任务项(已勾) · 顶层 · 次项',
    text: '- 甲\n- [x] 乙', sel: { anchor: 10, head: 10 }, range: { from: 4, to: 10 },
    out: '- 甲\n乙', lines: [[0, 'bullet', 0], [1, 'plain', 0]] },
  { id: 'L-0308-07', name: '行首退格删标记 · 紧列表 · 无序 · 嵌套 · 次项',
    text: '- 甲\n  - 乙', sel: { anchor: 8, head: 8 }, range: { from: 4, to: 8 },
    out: '- 甲\n乙', lines: [[0, 'bullet', 0], [1, 'plain', 0]] },
  { id: 'L-0308-08', name: '行首退格删标记 · 紧列表 · 有序 1. · 嵌套 · 次项',
    text: '- 甲\n  1. 乙', sel: { anchor: 9, head: 9 }, range: { from: 4, to: 9 },
    out: '- 甲\n乙', lines: [[0, 'bullet', 0], [1, 'plain', 0]] },
  { id: 'L-0308-09', name: '行首退格删标记 · 紧列表 · 任务项(未勾) · 顶层 · 首项',
    text: '- [ ] 甲', sel: { anchor: 6, head: 6 }, range: { from: 0, to: 6 },
    out: '甲', lines: [] },
  { id: 'L-0308-10', name: '空行上退格 · 松列表 · 无序 · 顶层 · 中间空行',
    text: '- 甲\n\n- 乙', sel: { anchor: 4, head: 4 }, range: { from: 3, to: 4 },
    out: '- 甲\n- 乙', lines: [[0, 'bullet', 0], [1, 'bullet', 0]] },
  { id: 'L-0308-11', name: '空行上退格 · 松列表 · 有序 1. · 顶层 · 中间空行',
    text: '1. 甲\n\n2. 乙', sel: { anchor: 5, head: 5 }, range: { from: 4, to: 5 },
    out: '1. 甲\n2. 乙', lines: [[0, 'ordered', 0], [1, 'ordered', 0]] },
  { id: 'L-0308-12', name: '空行上退格 · 松列表 · 任务项 · 顶层 · 中间空行',
    text: '- [ ] 甲\n\n- [ ] 乙', sel: { anchor: 8, head: 8 }, range: { from: 7, to: 8 },
    out: '- [ ] 甲\n- [ ] 乙', lines: [[0, 'task', 0], [1, 'task', 0]],
    tasks: [[6, false], [14, false]] },
  { id: 'L-0308-13', name: '空行上退格 · 紧列表 · 无序 · 顶层 · 文档首空行',
    text: '\n- 甲', sel: { anchor: 2, head: 2 }, range: { from: 0, to: 1 },
    out: '- 甲', lines: [[0, 'bullet', 0]] },
  { id: 'L-0308-14', name: '空行上退格 · 普通段落 · 中间空行（负对照）',
    text: '甲\n\n乙', sel: { anchor: 2, head: 2 }, range: { from: 1, to: 2 },
    out: '甲\n乙', lines: [] },
  { id: 'L-0308-15', name: '行首退格 · 空项 · 紧列表 · 无序 · 中间项',
    text: '- 甲\n- \n- 丙', sel: { anchor: 6, head: 6 }, range: { from: 4, to: 6 },
    out: '- 甲\n\n- 丙', lines: [[0, 'bullet', 0], [1, 'plain', 0], [2, 'bullet', 0]] },
  { id: 'L-0308-16', name: '行首退格 · 续行 · 紧列表 · 无序 · 顶层 · 行首',
    text: '- 甲\n  续行', sel: { anchor: 4, head: 4 }, range: { from: 3, to: 4 },
    out: '- 甲  续行', lines: [[0, 'bullet', 0]] },
];

for (const c of BACKSPACE_CELLS) {
  cell(c.id, c.name, function () {
    const p = plan(c.text);
    const range = S.deleteRange(doc(c.text), c.sel, { hidden: p.ranges });
    assert.deepEqual(range, c.range, '删除区间与产品判据不符（隐藏标记必须整体处理）');
    const out = applyRange(c.text, range);
    assert.equal(out, c.out, '删除后源码逐字节不符');
    assert.deepEqual(listShape(out), c.lines, '结果结构（行号/品种/深度）与产品解析不符');
    if (c.tasks) assert.deepEqual(taskShape(out), c.tasks, '任务框落点/勾选状态不符');
  });
}

// ── L-0309 删除整项：整行选区（含行尾换行）/ 跨行选区 / 嵌套子树 ──────────
//
// 判据仍是 `deleteRange` 的**选区分支**（`from !== to`）：只删可见字节，
// 完全覆盖的隐藏标记照删、部分覆盖的留在原地（`INV-LIVE-16`）。

/** @type {any[]} */
const DELETE_ITEM_CELLS = [
  { id: 'L-0309-01', name: '删除整项 · 紧列表 · 无序 · 顶层 · 首项',
    text: '- 甲\n- 乙', sel: { anchor: 0, head: 4 }, range: { from: 0, to: 4 },
    out: '- 乙', lines: [[0, 'bullet', 0]] },
  { id: 'L-0309-02', name: '删除整项 · 紧列表 · 无序 · 顶层 · 中间项',
    text: '- 甲\n- 乙\n- 丙', sel: { anchor: 4, head: 9 }, range: { from: 4, to: 8 },
    out: '- 甲\n- 丙', lines: [[0, 'bullet', 0], [1, 'bullet', 0]] },
  { id: 'L-0309-03', name: '删除整项 · 紧列表 · 无序 · 顶层 · 末项',
    text: '- 甲\n- 乙', sel: { anchor: 3, head: 7 }, range: { from: 3, to: 7 },
    out: '- 甲', lines: [[0, 'bullet', 0]] },
  { id: 'L-0309-04', name: '删除整项 · 松列表 · 无序 · 顶层 · 首项(含后空行)',
    text: '- 甲\n\n- 乙', sel: { anchor: 0, head: 5 }, range: { from: 0, to: 5 },
    out: '- 乙', lines: [[0, 'bullet', 0]] },
  { id: 'L-0309-05', name: '删除整项 · 松列表 · 无序 · 顶层 · 中间项(含后空行)',
    text: '- 甲\n\n- 乙\n\n- 丙', sel: { anchor: 5, head: 10 }, range: { from: 5, to: 10 },
    out: '- 甲\n\n- 丙', lines: [[0, 'bullet', 0], [1, 'plain', 0], [2, 'bullet', 0]] },
  { id: 'L-0309-06', name: '删除整项 · 松列表 · 无序 · 顶层 · 末项(含前空行)',
    text: '- 甲\n\n- 乙', sel: { anchor: 3, head: 8 }, range: { from: 3, to: 8 },
    out: '- 甲', lines: [[0, 'bullet', 0]] },
  { id: 'L-0309-07', name: '删除整项 · 紧列表 · 有序 1. · 顶层 · 中间项',
    text: '1. 甲\n2. 乙\n3. 丙', sel: { anchor: 5, head: 10 }, range: { from: 5, to: 10 },
    out: '1. 甲\n3. 丙', lines: [[0, 'ordered', 0], [1, 'ordered', 0]] },
  { id: 'L-0309-08', name: '删除整项 · 松列表 · 有序 3. · 顶层 · 中间项(含前空行)',
    text: '3. 甲\n\n4. 乙\n\n5. 丙', sel: { anchor: 5, head: 11 }, range: { from: 5, to: 11 },
    out: '3. 甲\n\n5. 丙', lines: [[0, 'ordered', 0], [1, 'plain', 0], [2, 'ordered', 0]] },
  { id: 'L-0309-09', name: '删除整项 · 紧列表 · 任务项(未勾) · 顶层 · 首项',
    text: '- [ ] 甲\n- 乙', sel: { anchor: 0, head: 8 }, range: { from: 0, to: 8 },
    out: '- 乙', lines: [[0, 'bullet', 0]] },
  { id: 'L-0309-10', name: '删除整项 · 紧列表 · 无序 · 嵌套 · 子项',
    text: '- 甲\n  - 乙\n- 丙', sel: { anchor: 4, head: 10 }, range: { from: 4, to: 10 },
    out: '- 甲\n- 丙', lines: [[0, 'bullet', 0], [1, 'bullet', 0]] },
  { id: 'L-0309-11', name: '删除整项 · 紧列表 · 无序 · 嵌套 · 整棵子树',
    text: '- 甲\n  - 乙\n    - 丙\n- 丁', sel: { anchor: 4, head: 18 }, range: { from: 4, to: 18 },
    out: '- 甲\n- 丁', lines: [[0, 'bullet', 0], [1, 'bullet', 0]] },
  { id: 'L-0309-12', name: '删除整项 · 紧列表 · 无序 · 顶层 · 跨行选区(行中→行中)',
    text: '- 甲乙\n- 丙丁', sel: { anchor: 3, head: 8 }, range: { from: 3, to: 8 },
    out: '- 甲丁', lines: [[0, 'bullet', 0]] },
  { id: 'L-0309-13', name: '删除整项 · 紧列表 · 无序 · 顶层 · 跨行选区(含首标记)',
    text: '- 甲\n- 乙', sel: { anchor: 0, head: 6 }, range: { from: 0, to: 6 },
    out: '乙', lines: [] },
  { id: 'L-0309-14', name: '删除整项 · 紧列表 · 有序 3. · 顶层 · 唯一条目',
    text: '3. 甲', sel: { anchor: 0, head: 4 }, range: { from: 0, to: 4 },
    out: '', lines: [] },
  { id: 'L-0309-15', name: '删除整项 · 紧列表 · 无序 · 顶层 · 整项含续行',
    text: '- 甲\n  续行\n- 乙', sel: { anchor: 0, head: 9 }, range: { from: 0, to: 9 },
    out: '- 乙', lines: [[0, 'bullet', 0]] },
  { id: 'L-0309-16', name: '删除整项 · 松列表 · 任务项(已勾) · 顶层 · 首项(含后空行)',
    text: '- [x] 甲\n\n- 乙', sel: { anchor: 0, head: 9 }, range: { from: 0, to: 9 },
    out: '- 乙', lines: [[0, 'bullet', 0]] },
  { id: 'L-0309-17', name: '删除整项 · 紧列表 · 有序 1. · 嵌套 · 子项',
    text: '- 甲\n  1. 乙\n- 丙', sel: { anchor: 4, head: 11 }, range: { from: 4, to: 11 },
    out: '- 甲\n- 丙', lines: [[0, 'bullet', 0], [1, 'bullet', 0]] },
];

for (const c of DELETE_ITEM_CELLS) {
  cell(c.id, c.name, function () {
    const p = plan(c.text);
    const range = S.deleteRange(doc(c.text), c.sel, { hidden: p.ranges });
    assert.deepEqual(range, c.range, '选区删除区间与产品判据不符');
    const out = applyRange(c.text, range);
    assert.equal(out, c.out, '删除后源码逐字节不符');
    assert.deepEqual(listShape(out), c.lines, '结果结构（行号/品种/深度）与产品解析不符');
  });
}

// ── L-0310 切换任务框：只换 `[ ]` / `[x]` 那一个符号 ─────────────────────
//
// 判据 = `task.js::toggleLine(line, from, to)` ＋ `markers().tasks` 的落点/状态。
// ⚠️ `from/to` 由测试自己从源码里定位 `[` 后一位（独立于产品算法），
//    再与实际 `tasks[].pos` 对照——产品给的是"正文起点"，符号在它前面 3 个码元。

/** @type {any[]} */
const TASK_CELLS = [
  { id: 'L-0310-01', name: '切换任务框 · 紧列表 · 无序 · 顶层 · 未勾→已勾',
    text: '- [ ] 甲', line: 0, sym: ' ', outLine: '- [x] 甲', checkedAfter: true,
    lines: [[0, 'task', 0]], tasks: [[6, true]] },
  { id: 'L-0310-02', name: '切换任务框 · 紧列表 · 无序 · 顶层 · 已勾→未勾',
    text: '- [x] 甲', line: 0, sym: 'x', outLine: '- [ ] 甲', checkedAfter: false,
    lines: [[0, 'task', 0]], tasks: [[6, false]] },
  { id: 'L-0310-03', name: '切换任务框 · 松列表 · 无序 · 顶层 · 未勾→已勾',
    text: '- [ ] 甲\n\n- [x] 乙', line: 0, sym: ' ', outLine: '- [x] 甲', checkedAfter: true,
    lines: [[0, 'task', 0], [1, 'plain', 0], [2, 'task', 0]], tasks: [[6, true], [15, true]] },
  { id: 'L-0310-04', name: '切换任务框 · 紧列表 · 有序 1. · 顶层 · 未勾→已勾',
    text: '1. [ ] 甲', line: 0, sym: ' ', outLine: '1. [x] 甲', checkedAfter: true,
    lines: [[0, 'task', 0]], tasks: [[7, true]] },
  { id: 'L-0310-05', name: '切换任务框 · 松列表 · 有序 3. · 顶层 · 已勾→未勾',
    text: '3. [x] 甲\n\n4. [ ] 乙', line: 0, sym: 'x', outLine: '3. [ ] 甲', checkedAfter: false,
    lines: [[0, 'task', 0], [1, 'plain', 0], [2, 'task', 0]], tasks: [[7, false], [17, false]] },
  { id: 'L-0310-06', name: '切换任务框 · 紧列表 · 无序 · 嵌套 · 未勾→已勾',
    text: '- 甲\n  - [ ] 乙', line: 1, sym: ' ', outLine: '  - [x] 乙', checkedAfter: true,
    lines: [[0, 'bullet', 0], [1, 'task', 1]], tasks: [[12, true]] },
  { id: 'L-0310-07', name: '切换任务框 · 紧列表 · 无序 · 引用内顶层 · 未勾→已勾',
    text: '> - [ ] 甲', line: 0, sym: ' ', outLine: '> - [x] 甲', checkedAfter: true,
    lines: [[0, 'task', 1]], tasks: [[8, true]] },
  { id: 'L-0310-08', name: '切换任务框 · 紧列表 · 无序 · 顶层 · 大写 X→未勾',
    text: '- [X] 甲', line: 0, sym: 'X', outLine: '- [ ] 甲', checkedAfter: false,
    lines: [[0, 'task', 0]], tasks: [[6, false]] },
  { id: 'L-0310-09', name: '切换任务框 · 紧列表 · 无序 · 顶层 · 两次切换回原样',
    text: '- [ ] 甲', line: 0, sym: ' ', outLine: '- [x] 甲', checkedAfter: true,
    lines: [[0, 'task', 0]], tasks: [[6, true]], twice: '- [ ] 甲' },
  { id: 'L-0310-10', name: '切换任务框 · 紧列表 · 普通项 · 拒绝非符号',
    text: '- 甲', line: 0, sym: '甲', rel: 2, reject: true },
  { id: 'L-0310-11', name: '切换任务框 · 紧列表 · 无序 · 顶层 · 内容含方括号只改首符号',
    text: '- [ ] [x] 甲', line: 0, sym: ' ', outLine: '- [x] [x] 甲', checkedAfter: true,
    lines: [[0, 'task', 0]], tasks: [[6, true]] },
  { id: 'L-0310-13', name: '切换任务框 · 紧列表 · 有序 1. · 嵌套 · 未勾→已勾',
    text: '- 甲\n  1. [ ] 乙', line: 1, sym: ' ', outLine: '  1. [x] 乙', checkedAfter: true,
    lines: [[0, 'bullet', 0], [1, 'task', 1]], tasks: [[13, true]] },
];

for (const c of TASK_CELLS) {
  cell(c.id, c.name, function () {
    const lines = String(c.text).split('\n');
    const line = lines[c.line];
    // `toggleLine` 收的是**行内**下标；`tasks[].pos` 是**全文**下标。
    const at = c.rel !== undefined ? c.rel : line.indexOf('[') + 1;
    let lineStart = 0;
    for (let i = 0; i < c.line; i++) lineStart += lines[i].length + 1;
    assert.equal(line.slice(at, at + 1), c.sym, '测试定位到的符号与格名不符');
    const p = plan(c.text);
    if (!c.reject) {
      assert.equal(p.tasks[0].pos - 3, lineStart + at, '产品给的正文起点与源码里的符号位置不一致');
    }
    if (c.reject) {
      assert.throws(function () { T.toggleLine(line, at, at + 1); }, /不是可打勾的符号/);
      assert.equal(p.tasks.length, 0, '普通项不该被当任务框');
      return;
    }
    assert.equal(T.isCheckedSymbol(line, at, at + 1), c.checkedAfter,
      '`isCheckedSymbol` 的"翻一下之后是否勾上"口径不符');
    lines[c.line] = T.toggleLine(line, at, at + 1);
    const out = lines.join('\n');
    assert.equal(lines[c.line], c.outLine, '只许换那一个符号，其余逐字节不变');
    assert.deepEqual(listShape(out), c.lines, '结果结构（行号/品种/深度）与产品解析不符');
    assert.deepEqual(taskShape(out), c.tasks, '翻转后的任务框落点/状态不符');
    if (c.twice) {
      const twice = T.toggleLine(lines[c.line], at, at + 1);
      assert.equal(twice, c.twice, '连翻两次必须逐字节回到原样');
    }
  });
}

// 任务框落点与源码的一致性：`tasks[].pos` 是正文起点，符号在它前 3 个码元。
cell('L-0310-12', '切换任务框 · 松列表 · 无序 · 顶层 · markers 的 checked/pos 与源码一致',
  function () {
    const text = '- [ ] 甲\n\n- [x] 乙';
    const p = plan(text);
    assert.deepEqual(taskShape(text), [[6, false], [15, true]]);
    const rows = text.split('\n');
    assert.equal(rows[0].slice(3, 4), ' ', '第 1 项符号位是未勾');
    assert.equal(rows[2].slice(3, 4), 'x', '第 2 项符号位是已勾');
    // 落点前 3 个码元恒为 `[ ] ` / `[x] ` 的闭括号＋空格 ⇒ 从 pos 往回看能独立复原符号。
    assert.equal(rows[0].slice(2, 6), '[ ] ');
    assert.equal(rows[2].slice(2, 6), '[x] ');
  });

// ── L-0311 Tab / Shift-Tab：列表缩进 / 反缩进（`bugs/0116`，2026-11-13 落地）─────
//
// 用户 2026-11-07 与 2026-11-13 两次裁定按 Notion / Mardo 口径对齐：
// `Tab` = 降一级、`⇧Tab` = 升一级。判据一律走**产品那一个纯函数**
// （`input.js::indentList` / `outdentList`，⛔ 这里不写第二套缩进规则），
// 再把事务应用回源码、问产品"现在是什么结构"。
//
// ⚠️ 一级列表的 `⇧Tab` **什么都不做**（`L-0311-05`）：Notion 里也不会把列表项退成
//    段落；退出列表仍是"空项回车"（`lineBreakAction` ③）与"行首退格"（`deleteRange`）。

/** 光标放到第 `line` 行（0-based）的第 `col` 个码元（缺省 = 行首）。 */
function caretAt(text, line, col) {
  const lines = String(text).split('\n');
  let off = 0;
  for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
  const w = line < lines.length ? lines[line].length : 0;
  return off + Math.max(0, Math.min(col || 0, w));
}

/** Tab 格的 ID 清单（汇总与"覆盖表一致"的判据用）。 */
const TAB_CELLS = [
  { id: 'L-0311-01' }, { id: 'L-0311-02' }, { id: 'L-0311-03' }, { id: 'L-0311-04' },
  { id: 'L-0311-05' }, { id: 'L-0311-06' }, { id: 'L-0311-07' }, { id: 'L-0311-08' },
  { id: 'L-0311-09' }, { id: 'L-0311-10' }, { id: 'L-0311-11' }, { id: 'L-0311-12' },
  { id: 'L-0311-13' }, { id: 'L-0311-14' }, { id: 'L-0311-15' }, { id: 'L-0311-16' },
  { id: 'L-0311-17' }, { id: 'L-0311-18' }, { id: 'L-0311-19' }, { id: 'L-0311-20' },
  { id: 'L-0311-21' },
];

cell('L-0311-01', 'Tab 缩进 · 紧列表 · 无序 · 顶层', function () {
  const t = '- 甲\n- 乙';
  const at = caretAt(t, 1);
  const act = I.indentList(t, plan(t), at, at);
  assert.equal(act.type, 'replace');
  const out = applyAction(t, act);
  assert.equal(out, '- 甲\n  - 乙', '缩到前一条同级项的正文列（`- ` ⇒ 2）');
  assert.deepEqual(listShape(out), [[0, 'bullet', 0], [1, 'bullet', 1]], '第 2 项真的降了一级');
  assert.equal(act.sel.anchor, at + 2, '光标跟着自己那一行走，⛔ 不跳到行尾');
});

cell('L-0311-02', 'Tab 缩进 · 紧列表 · 有序 1.（⭐ 编号同时改成 1，`bugs/0321`）', function () {
  const t = '1. 甲\n2. 乙';
  const at = caretAt(t, 1, 3);          // 光标在正文里（`2. ` 之后）
  const act = I.indentList(t, plan(t), at, at);
  // ⚠️ 不只是加缩进：CommonMark §5.2 要求**打断段落**的有序项从 1 起，
  //    `   2. 乙` 会被 comrak 渲染成上一项正文里的一行字（实测见 `bugs/0321`）。
  assert.equal(applyAction(t, act), '1. 甲\n   1. 乙', '正文列是 3（`1. `），且编号改写成 1');
  assert.deepEqual(listShape('1. 甲\n   1. 乙'),
    [[0, 'ordered', 0], [1, 'ordered', 1]], '第 2 项真的降了一级（⛔ 不是段落正文）');
  assert.equal(act.sel.anchor, at + 3, '光标留在正文里（`   1. ` 比 `2. ` 多 3 个字符）');
});

cell('L-0311-03', 'Tab · 首项（没有前一条同级项）⇒ 什么都不做（Notion 口径）', function () {
  // ⚠️ 2026-11-14 用户裁定「多级有序列表参考 Notion 的实现」：Notion 里 `Tab` 是把块挂到
  //    **前一个块**下面；自己那一层的第一项前面没有块 ⇒ 没有可挂的地方，键被吃掉但源码不动。
  const t = '- 甲\n  - 乙';
  const at = caretAt(t, 1);
  const act = I.indentList(t, plan(t), at, at);
  assert.equal(act.type, 'noop', '没有同级前项 ⇒ `noop`（⛔ 不按自身标记宽再缩一级）');

  // ⭐ 用户报的**有序列表被劈开**就是旧实现这条路：首项带着子项继续缩，父项与子项同列
  //    ⇒ 子项被提成兄弟（`bugs/0321`）。判据必须把它挡住。
  const o = '1. 甲\n   1. 甲一\n      1. 甲一一';
  const oa = caretAt(o, 1);
  assert.equal(I.indentList(o, plan(o), oa, oa).type, 'noop', '首个子项同样不动');

  // 正对照：**有**前一条同级项时照常降级（判据不是"永远 noop"）。
  const p = '- 甲\n- 乙';
  const pa = caretAt(p, 1);
  assert.equal(applyAction(p, I.indentList(p, plan(p), pa, pa)), '- 甲\n  - 乙');
});

cell('L-0311-04', 'Shift-Tab 取消缩进 · 紧列表 · 嵌套', function () {
  const t = '- 甲\n  - 乙';
  const at = caretAt(t, 1);
  const act = I.outdentList(t, plan(t), at, at);
  const out = applyAction(t, act);
  assert.equal(out, '- 甲\n- 乙');
  assert.deepEqual(listShape(out), [[0, 'bullet', 0], [1, 'bullet', 0]], '回到上一级（深度 0）');
});

cell('L-0311-05', 'Shift-Tab 取消缩进 · 顶层 ⇒ 什么都不做（⚠️ 不退成段落）', function () {
  for (const t of ['- 甲', '1. 甲', '- [ ] 甲']) {
    const at = caretAt(t, 0);
    const act = I.outdentList(t, plan(t), at, at);
    // ⚠️ 不是 `null`：`null` 会让调用方"提交并退出这一块"。列表里的 Tab 必须被吃掉。
    assert.equal(act.type, 'noop', JSON.stringify(t) + ' 的 ⇧Tab 应被吃掉但不改源码');
  }
});

cell('L-0311-06', 'Tab 接线取证 · 列表块策略 tab=indent，非列表块仍是 leave', function () {
  const O = require('../../src/live/objects.js');
  assert.equal(O.LIST.tab, 'indent', '列表块：Tab = 缩进（`bugs/0116`）');
  assert.equal(O.BLOCK.tab, 'leave', '非列表块：Tab 仍是"离开"（可访问性的标准出口）');
  assert.equal(O.CELL.tab, 'walk', '表格格内仍是走格（负对照：缩进只属于列表）');
  assert.equal(O.policyOf({ el: { tagName: 'UL' } }), O.LIST);
  assert.equal(O.policyOf({ el: { tagName: 'ol' } }), O.LIST);
  assert.equal(O.policyOf({ el: { tagName: 'P' } }), O.BLOCK);
  assert.equal(O.policyOf({ cell: {}, el: { tagName: 'TD' } }), O.CELL,
    '格子语境压过元素名');
  assert.equal(O.policyOf(null), O.BLOCK);
  const main = fs.readFileSync(require.resolve('../../src/main.js'), 'utf8');
  assert.ok(main.indexOf("obj.tab === 'indent'") >= 0,
    '`main.js` 必须按策略字段分派（`INV-EDITOBJ-05`）');
  assert.ok(main.indexOf('LIn.indentList(') >= 0 && main.indexOf('LIn.outdentList(') >= 0,
    '`main.js` 调的是纯函数，⛔ 不许自己写缩进');
});

cell('L-0311-07', 'Tab 缩进 · 任务项（`[x] ` 不算列表标记宽）', function () {
  const t = '- [ ] 甲\n- [ ] 乙';
  const at = caretAt(t, 1);
  const act = I.indentList(t, plan(t), at, at);
  const out = applyAction(t, act);
  assert.equal(out, '- [ ] 甲\n  - [ ] 乙', '正文列按 `- ` 算（2），⛔ 不是 6');
  assert.deepEqual(listShape(out), [[0, 'task', 0], [1, 'task', 1]]);
});

cell('L-0311-08', 'Tab 缩进 · 光标在续行上 ⇒ 跟着所属项走', function () {
  // ⚠️ 续行所属的项必须**有前一条同级项**，否则整项按 Notion 口径不动（`L-0311-03`）。
  const t = '- 甲\n- 乙\n  续行';
  const at = caretAt(t, 2);
  const act = I.indentList(t, plan(t), at, at);
  const out = applyAction(t, act);
  assert.equal(out, '- 甲\n  - 乙\n  续行', '改的是所属项（乙）那一行，⛔ 不给续行单加缩进');
  assert.equal(plan(out).listLines[2].kind, 'plain', '续行仍是续行（没有被提成新项）');
  assert.equal(act.sel.anchor, at + 2, '光标留在续行上并跟着右移');
});

cell('L-0311-09', 'Tab 缩进 · 多行选区 ⇒ 首项跳过，其余统一缩进量、一条事务', function () {
  const t = '- 甲\n- 乙\n- 丙';
  const act = I.indentList(t, plan(t), 0, 8);   // 选 0..8 = 前两行（丙 不在选区里）
  const out = applyAction(t, act);
  assert.equal(out, '- 甲\n  - 乙\n- 丙',
    '甲是首项、前面没有可挂的块 ⇒ 跳过；乙照常缩；选区外的丙不动');
  assert.equal(act.sel.anchor, 0, '甲没动，选区起点不动');
  assert.equal(act.sel.head, 10, '选区终点跟着乙一起右移 2');
});

cell('L-0311-10', 'Shift-Tab · 引用里的列表 ⛔ 不啃 `> ` 前面那个空格', function () {
  const t = '> - 甲\n> - 乙';
  const at = caretAt(t, 1);
  assert.equal(I.outdentList(t, plan(t), at, at).type, 'noop',
    '引用里的一级列表没有上一级 ⇒ 不动（否则会写成 `>- 乙`）');
  const u = '> - 甲\n>   - 乙';
  const at2 = caretAt(u, 1);
  const act = I.outdentList(u, plan(u), at2, at2);
  assert.equal(applyAction(u, act), '> - 甲\n> - 乙', '真有上一级时只退缩进那一段');
});

cell('L-0311-11', 'Tab · 不在列表行上 ⇒ `null`（调用方保持"提交并退出"）', function () {
  const p = '正文段落';
  assert.equal(I.indentList(p, plan(p), 0, 0), null);
  // 围栏里的 `- 甲` 是**内容**，不是列表项。
  const f = '```\n- 甲\n```';
  assert.equal(I.indentList(f, plan(f), 4, 4), null);
  // 列表项之间的空行不参与，也不把整段判成"可缩进"。
  const b = '- 甲\n\n- 乙';
  assert.equal(I.indentList(b, plan(b), 4, 4), null, '光标落在空行上 ⇒ 不在列表行上');
  assert.equal(I.indentList('', null, 0, 0), null, 'plan 缺失 ⇒ 不猜');
});

cell('L-0311-12', 'Tab 缩进 · 有序 10.（正文列 4 ＋ 编号改写，`bugs/0321`）', function () {
  const t = '10. 甲\n11. 乙';
  const at = caretAt(t, 1, 4);
  const act = I.indentList(t, plan(t), at, at);
  assert.equal(applyAction(t, act), '10. 甲\n    1. 乙', '正文列 4，且 `11.` 改写成 `1.`');
  assert.deepEqual(listShape('10. 甲\n    1. 乙'),
    [[0, 'ordered', 0], [1, 'ordered', 1]]);
});

cell('L-0311-14', 'Tab · 有序项改号的三种例外（`bugs/0321`）', function () {
  // ① 上一行是空行 ⇒ 本来就是真嵌套（comrak 渲染 `<ol start="2">`）⇒ ⛔ 不改号。
  const loose = '1. 甲\n\n2. 乙';
  const a1 = caretAt(loose, 2, 3);
  assert.equal(applyAction(loose, I.indentList(loose, plan(loose), a1, a1)),
    '1. 甲\n\n   2. 乙', '空行隔开 ⇒ 只加缩进，编号 2 原样保留');

  // ② 上一行是**同一个有序列表**里、降级后仍同列的兄弟项 ⇒ 在延长那个列表，⛔ 不改号。
  const inner = '1. 甲\n   1. 乙\n2. 丙';
  const a2 = caretAt(inner, 2, 3);
  const act2 = I.indentList(inner, plan(inner), a2, a2);
  assert.equal(applyAction(inner, act2), '1. 甲\n   1. 乙\n   2. 丙',
    '`2. 丙` 续的是里面那个列表 ⇒ 编号原样保留');

  // ③ 源码里本来就是 1 ⇒ ⛔ 不改（只加缩进）。
  const one = '1. 甲\n1. 乙';
  const a3 = caretAt(one, 1, 3);
  assert.equal(applyAction(one, I.indentList(one, plan(one), a3, a3)),
    '1. 甲\n   1. 乙');

  // ④ 标点跟着源码走（`1)` 家族 ⛔ 不被改成 `1.`）。
  const paren = '1) 甲\n5) 乙';
  const a4 = caretAt(paren, 1, 3);
  assert.equal(applyAction(paren, I.indentList(paren, plan(paren), a4, a4)),
    '1) 甲\n   1) 乙');
});

cell('L-0311-13', 'Tab · 光标在行中 ⇒ 只右移缩进量，⛔ 不跳到行尾', function () {
  const t = '- 甲\n- 乙丙';
  const act = I.indentList(t, plan(t), 7, 7);   // 光标在 `乙` 与 `丙` 之间
  assert.equal(applyAction(t, act), '- 甲\n  - 乙丙');
  assert.equal(act.sel.anchor, 9, '原光标 7 + 缩进 2');
  assert.equal(act.sel.head, 9);
});

cell('L-0311-15', 'Tab 缩进 · 子项随父项一起走（Notion：移动一个块，子块跟着走）', function () {
  const t = '1. 甲\n2. 乙\n   1. 乙一\n      1. 乙一一\n3. 丙';
  const at = caretAt(t, 1);
  const act = I.indentList(t, plan(t), at, at);
  const out = applyAction(t, act);
  assert.equal(out, '1. 甲\n   1. 乙\n      1. 乙一\n         1. 乙一一\n3. 丙',
    '乙带着乙一、乙一一整体右移 3（步长 = `1. ` 的正文列）');
  assert.deepEqual(listShape(out), [[0, 'ordered', 0], [1, 'ordered', 1],
    [2, 'ordered', 2], [3, 'ordered', 3], [4, 'ordered', 0]],
  '层级没有被压平：乙一仍是乙的子项，丙仍是顶层');
});

cell('L-0311-16', '⇧Tab 反缩进 · 子项随父项一起走', function () {
  const t = '1. 甲\n   1. 甲一\n      1. 甲一一\n2. 乙';
  const at = caretAt(t, 1);
  const act = I.outdentList(t, plan(t), at, at);
  const out = applyAction(t, act);
  assert.equal(out, '1. 甲\n1. 甲一\n   1. 甲一一\n2. 乙',
    '甲一退回顶层，甲一一跟着退回一级（⛔ 不留在原地被提成顶层）');
  assert.deepEqual(listShape(out), [[0, 'ordered', 0], [1, 'ordered', 0],
    [2, 'ordered', 1], [3, 'ordered', 0]]);
});

// ── L-0311（续）：回车 / 行首退格 = **一级一级退**（`bugs/0116` §10，2026-11-14）──
//
// 用户原话：「多级有序和无序列表使用的体验，感觉比 Mardo 差不少事」。Notion / Mardo 里
// **内层**项（空项回车 / 行首退格）是"回到上一级"，只有**最外层**才退出列表；旧实现两处
// 都是一步退到底（空项回车删整条标记、行首退格按隐藏区把 `缩进＋标记` 一起删）。

cell('L-0311-17', '回车 · 空的内层项 ⇒ 升一级（Notion / Mardo 口径，⛔ 不整条退列表）', function () {
  const t = '- 甲\n  - ';
  const p = plan(t);
  const at = p.listLines[1].contentFrom;        // 用户眼里的行首（标记恒藏）
  const act = I.lineBreakAction(t, p, at, at);
  const out = applyAction(t, act);
  assert.equal(out, '- 甲\n- ', '只删缩进那一层，标记 `- ` 留着');
  assert.deepEqual(listShape(out), [[0, 'bullet', 0], [1, 'bullet', 0]], '这一项真的升到了顶层');
  assert.equal(act.sel.anchor, plan(out).listLines[1].contentFrom, '光标落在新位置的正文起点');
  assert.equal(act.sel.head, act.sel.anchor);
});

cell('L-0311-18', '回车 · 有序内层空项同样先升一级；到最外层再回车才退出列表', function () {
  const t = '1. 甲\n   1. ';
  const p = plan(t);
  const at = p.listLines[1].contentFrom;
  const out = applyAction(t, I.lineBreakAction(t, p, at, at));
  assert.equal(out, '1. 甲\n1. ');
  assert.deepEqual(listShape(out), [[0, 'ordered', 0], [1, 'ordered', 0]]);
  // 第二次回车：已经在最外层 ⇒ 删标记退回正文（负对照：新分支 ⛔ 不许把顶层也吃掉）。
  const p2 = plan(out);
  const at2 = p2.listLines[1].contentFrom;
  assert.deepEqual(I.lineBreakAction(out, p2, at2, at2),
    { type: 'delete', data: '', from: p2.listLines[1].from, to: p2.listLines[1].contentFrom });
});

cell('L-0311-19', '行首退格 · 内层项**升一级**（`outdentAtStart`，Notion / Mardo 口径）', function () {
  const t = '- 甲\n  - 乙';
  const p = plan(t);
  const at = p.listLines[1].contentFrom;
  const act = I.outdentAtStart(t, p, at, at);
  assert.ok(act, '内层项行首退格必须升一级，⛔ 不是删标记变段落');
  const out = applyAction(t, act);
  assert.equal(out, '- 甲\n- 乙');
  assert.deepEqual(listShape(out), [[0, 'bullet', 0], [1, 'bullet', 0]]);
  assert.equal(act.sel.anchor, plan(out).listLines[1].contentFrom, '光标停在标记后的正文起点');
});

cell('L-0311-20', '行首退格 · 顶层 / 行中 / 有选区 / 续行 / 引用首项 / 无 plan ⇒ `null`（交回原退格）', function () {
  const top = '- 甲';
  const tp = plan(top);
  assert.equal(I.outdentAtStart(top, tp, tp.listLines[0].contentFrom, tp.listLines[0].contentFrom),
    null, '顶层项没有上一级 ⇒ 旧行为（删标记退列表）');
  const t = '- 甲\n  - 乙';
  const p = plan(t);
  const at = p.listLines[1].contentFrom;
  assert.equal(I.outdentAtStart(t, p, at + 1, at + 1), null, '行中退格删的是字符');
  assert.equal(I.outdentAtStart(t, p, at, at + 1), null, '有选区时退格删的是选中内容');
  const r = '- 甲\n  续行';
  const rp = plan(r);
  assert.equal(I.outdentAtStart(r, rp, rp.listLines[1].contentFrom, rp.listLines[1].contentFrom),
    null, '续行行首退格是"并进上一行"；⛔ 不把所属项降级');
  const q = '> - 甲';
  const qp = plan(q);
  assert.equal(I.outdentAtStart(q, qp, qp.listLines[0].contentFrom, qp.listLines[0].contentFrom),
    null, '引用里的首项没有更浅的缩进 ⇒ 交回旧行为（只退列表那一层）');
  assert.equal(I.outdentAtStart('', null, 0, 0), null, 'plan 缺失 ⇒ 不猜');
});

cell('L-0311-21', '行首退格 · 升一级时子项跟着走（与 ⇧Tab 同一条口径）', function () {
  const t = '1. 甲\n   1. 乙\n      1. 乙一';
  const p = plan(t);
  const at = p.listLines[1].contentFrom;
  const out = applyAction(t, I.outdentAtStart(t, p, at, at));
  assert.equal(out, '1. 甲\n1. 乙\n   1. 乙一');
  assert.deepEqual(listShape(out), [[0, 'ordered', 0], [1, 'ordered', 0], [2, 'ordered', 1]]);
});


// ── 变异自检：判据必须能被"改坏的产品副本"打红 ────────────────────────────
//
// `.claude/rules/tests.md`：没做过变异测试的断言不算数。
// 每一条都加载**真实源码的变异副本**（`vm` 里跑，⛔ 不改 `src/`），
// 证明对应格依赖的判据是承重的，并各带一条负对照。

/** 读真实模块、按唯一靶子改一处、在隔离上下文里跑出副本。 */
function mutateModule(name, target, replacement) {
  const src = fs.readFileSync(require.resolve('../../src/live/' + name + '.js'), 'utf8');
  assert.equal(src.split(target).length - 1, 1, name + ' 变异必须恰好命中一处');
  const context = { module: { exports: {} } };
  vm.runInNewContext(src.replace(target, replacement), context);
  return /** @type {any} */ (context.module.exports);
}

/** 同上，但同一份源码上允许**多个**靶子（每个仍必须恰好命中一处）。 */
function mutateModuleMany(name, pairs) {
  let src = fs.readFileSync(require.resolve('../../src/live/' + name + '.js'), 'utf8');
  for (let i = 0; i < pairs.length; i++) {
    const target = pairs[i][0];
    assert.equal(src.split(target).length - 1, 1,
      name + ' 变异靶子必须恰好命中一处：' + target);
    src = src.replace(target, pairs[i][1]);
  }
  const context = { module: { exports: {} } };
  vm.runInNewContext(src, context);
  return /** @type {any} */ (context.module.exports);
}

test('L-0313-01 变异：有序续号 +1 被改成 +0 ⇒ `L-0307-04` 必红、无序负对照仍绿', function () {
  // ⚠️ 靶子已随 `bugs/0111` A3 换代（2026-11-12）：编号**只有一份来源** ——
  //    装饰层按位置算出的 `listLines[].number`，`input.js` 只做 `number + 1`。
  //    旧的 `parseInt(num,10)+1` 现在只存在于**旧 plan 的 fail-closed 分支**，
  //    拿它当靶子对真实 plan 不承重（变异后仍然绿）。
  const bad = mutateModule('input',
    'const 下一 = 项.number + 1;',
    'const 下一 = 项.number;');
  assert.equal(bad.lineBreakAction('3. 甲', plan('3. 甲'), 4, 4).data, '\n3. ');
  assert.throws(function () {
    assert.equal(bad.lineBreakAction('3. 甲', plan('3. 甲'), 4, 4).data, '\n4. ');
  }, { code: 'ERR_ASSERTION' }, '有序续号判据必须当场红');
  assert.equal(bad.lineBreakAction('- 甲', plan('- 甲'), 3, 3).data, '\n- ',
    '负对照：无序项不经过递增分支');
});

test('L-0313-02 变异：空项退出的 delete 被改成 insert ⇒ `L-0307-24` 必红、非空负对照仍绿', function () {
  // ⚠️ 靶子已随 `bugs/0111` A2 换代（2026-11-12）：删除起点不再是恒定 `li.from`，
  //    而是 `起`（纯缩进取行首、含引用标记取 `markerFrom`）。
  const bad = mutateModule('input',
    "return { type: 'delete', data: '', from: 起, to: li.contentFrom };",
    "return { type: 'insert', data: '\\n', from: from, to: to };");
  assert.equal(bad.lineBreakAction('- ', plan('- '), 2, 2).type, 'insert');
  assert.throws(function () {
    assert.equal(bad.lineBreakAction('- ', plan('- '), 2, 2).type, 'delete');
  }, { code: 'ERR_ASSERTION' }, '空项回车必须删标记而不是再续一项');
  assert.equal(bad.lineBreakAction('- 甲', plan('- 甲'), 3, 3).type, 'insert',
    '负对照：非空项本来就是 insert');
});

test('L-0313-03 变异：松列表空行分支被摘掉 ⇒ `L-0308-03` 必红、紧列表负对照仍绿', function () {
  const bad = mutateModule('selection',
    'const 空行反 = backOverBlankLine(doc, hidden, 起点);',
    'const 空行反 = null;');
  const loose = '- 甲\n\n- 乙';
  const got = bad.deleteRange(doc(loose), { anchor: 7, head: 7 }, { hidden: plan(loose).ranges });
  // ⚠️ 变异副本在另一个 vm realm 里 ⇒ 原型不同，`deepEqual` 会假红；逐字段比。
  assert.equal(got.from, 5, '摘掉空行分支后只剩"删标记"，空行留着');
  assert.equal(got.to, 7);
  assert.throws(function () {
    const r = bad.deleteRange(doc(loose), { anchor: 7, head: 7 },
      { hidden: plan(loose).ranges });
    assert.equal(r.from, 4);
    assert.equal(r.to, 5);
  }, { code: 'ERR_ASSERTION' }, '`bugs/0305` 的空行删除判据必须当场红');
  const tight = '- 甲\n- 乙';
  const tightGot = bad.deleteRange(doc(tight), { anchor: 6, head: 6 },
    { hidden: plan(tight).ranges });
  assert.equal(tightGot.from, 4, '负对照：紧列表本来就走整行标记分支');
  assert.equal(tightGot.to, 6);
});

test('L-0313-04 变异：未勾符号不再翻成勾 ⇒ `L-0310-01` 必红、已勾负对照仍绿', function () {
  const bad = mutateModule('task',
    'if (sym === UNCHECKED) next = CHECKED;',
    'if (sym === UNCHECKED) next = UNCHECKED;');
  assert.equal(bad.toggleLine('- [ ] 甲', 3, 4), '- [ ] 甲');
  assert.throws(function () {
    assert.equal(bad.toggleLine('- [ ] 甲', 3, 4), '- [x] 甲');
  }, { code: 'ERR_ASSERTION' }, '未勾→已勾的判据必须当场红');
  assert.equal(bad.toggleLine('- [x] 甲', 3, 4), '- [ ] 甲',
    '负对照：已勾→未勾走另一条分支');
});

test('L-0313-05 变异：任务项续前缀的勾选复位被摘掉 ⇒ `L-0307-06` 必红、未勾负对照仍绿', function () {
  const bad = mutateModule('input',
    "prefix = prefix.replace(/\\[[xX ]\\]/, '[ ]');",
    'prefix = prefix;');
  const checked = '- [x] 甲';
  const action = bad.lineBreakAction(checked, plan(checked), 7, 7);
  assert.equal(action.data, '\n- [x] ', '已勾项续出来的新项仍是已勾');
  assert.throws(function () {
    assert.equal(bad.lineBreakAction(checked, plan(checked), 7, 7).data, '\n- [ ] ');
  }, { code: 'ERR_ASSERTION' }, '任务项"新项一律未勾"的判据必须当场红');
  const unchecked = '- [ ] 甲';
  assert.equal(bad.lineBreakAction(unchecked, plan(unchecked), 7, 7).data, '\n- [ ] ',
    '负对照：未勾项本来就不需要复位');
  assert.equal(bad.lineBreakAction('- 甲', plan('- 甲'), 3, 3).data, '\n- ',
    '负对照：普通无序项不过这条分支');
});

test('L-0313-06 变异：取消"没有上一级 ⇒ 不动"⇒ `L-0311-05`/`L-0311-10` 必红、嵌套负对照仍绿', function () {
  // ⚠️ 2026-11-14 起这条要**两处同时**改坏才能复刻旧行为（`bugs/0321` Notion 口径）：
  //    ① `可移` 先把"没有上一级"的项剔掉（起缩为空 ⇒ noop）；
  //    ② 步长的空值兜底再回退成"删自身缩进"（旧实现）。
  //    只改 ② 打不红任何东西——那一层已经被 ① 挡在前面，这正是新判据承重的证明。
  const bad = mutateModuleMany('input', [
    ["if (起缩.length === 0) return { type: 'noop' };", "if (起缩.length === 0) 起缩.push(目标[0]);"],
    ['步 = 爸 ? 首缩 - 缩进(爸) : 0;', '步 = 爸 ? 首缩 - 缩进(爸) : 首缩;'],
  ]);
  const quoted = '> - 甲\n> - 乙';
  const act = bad.outdentList(quoted, plan(quoted), 8, 8);
  assert.equal(act.type, 'delete', '变异后引用里的一级列表开始删前缀');
  assert.equal(applyAction(quoted, act), '> - 甲\n>- 乙', '把 `> ` 本身啃掉了');
  assert.throws(function () {
    assert.equal(act.type, 'noop');
  }, { code: 'ERR_ASSERTION' }, '"没有上一级 ⇒ 不动"的判据必须当场红');
  assert.equal(bad.outdentList('> - 甲', plan('> - 甲'), 4, 4).type, 'delete',
    '`L-0311-05` 的引用变体（`> - 甲` 单行）同样当场变红');
  const nested = '- 甲\n  - 乙';
  const good = bad.outdentList(nested, plan(nested), 6, 6);
  assert.equal(good.type, 'delete', '负对照：真有上一级时照常删那两个空格');
  assert.equal(applyAction(nested, good), '- 甲\n- 乙');
});

test('L-0313-07 变异：降级缩进量写死 2 ⇒ 有序 `L-0311-02`/`L-0311-12` 必红、无序负对照仍绿', function () {
  // `Tab` 的步长**只能**来自 CommonMark 内容列（`1. ` = 3、`10. ` = 4），
  // 写死任何常数都会让有序列表随后续号变宽而错位。
  const bad = mutateModule('input',
    '步 = 前 ? 列宽(前) - 首缩 : 0;',
    '步 = 2;');
  const two = '1. 甲\n2. 乙';
  const got = bad.indentList(two, plan(two), 7, 7);
  assert.equal(applyAction(two, got), '1. 甲\n  1. 乙', '变异后缩进只有 2（⚠️ 改号仍生效）');
  assert.throws(function () {
    assert.equal(applyAction(two, got), '1. 甲\n   1. 乙');
  }, { code: 'ERR_ASSERTION' }, '`1. ` 的内容列判据必须当场红');
  const ten = '10. 甲\n11. 乙';
  const got2 = bad.indentList(ten, plan(ten), 9, 9);
  assert.equal(applyAction(ten, got2), '10. 甲\n  1. 乙');
  assert.throws(function () {
    assert.equal(applyAction(ten, got2), '10. 甲\n    1. 乙');
  }, { code: 'ERR_ASSERTION' }, '`L-0311-12` 必须当场红');
  const bullet = '- 甲\n- 乙';
  assert.equal(applyAction(bullet, bad.indentList(bullet, plan(bullet), 6, 6)),
    '- 甲\n  - 乙', '负对照：无序项的内容列本来就恰好是 2');
});

test('L-0313-08 变异：降级时的编号改写被摘掉 ⇒ `L-0311-02`/`L-0311-12` 必红、同列表负对照仍绿', function () {
  // ⚠️ 这条变异复刻的正是**用户 2026-11-14 报的那个不一致**（`bugs/0321`）：
  //    只加缩进不改号 ⇒ comrak 把那行渲染成上一项正文里的一行字，而编辑侧仍画成子项。
  const bad = mutateModule('input',
    "return 空 + '1' + 编号标点(原);",
    'return 空;');
  const two = '1. 甲\n2. 乙';
  const a = caretAt(two, 1, 3);
  const act = bad.indentList(two, plan(two), a, a);
  assert.equal(applyAction(two, act), '1. 甲\n   2. 乙', '变异后只剩缩进（假子列表）');
  assert.throws(function () {
    assert.equal(applyAction(two, act), '1. 甲\n   1. 乙');
  }, { code: 'ERR_ASSERTION' }, '`L-0311-02` 的改号判据必须当场红');
  const ten = '10. 甲\n11. 乙';
  const a2 = caretAt(ten, 1, 4);
  assert.throws(function () {
    assert.equal(applyAction(ten, bad.indentList(ten, plan(ten), a2, a2)), '10. 甲\n    1. 乙');
  }, { code: 'ERR_ASSERTION' }, '`L-0311-12` 必须当场红');
  // 负对照 ①：无序项没有编号，本来就不该被改。
  const bullet = '- 甲\n- 乙';
  assert.equal(applyAction(bullet, bad.indentList(bullet, plan(bullet), 6, 6)),
    '- 甲\n  - 乙');
  // 负对照 ②：同一列表内的续项本来就不改号（`L-0311-14` ②）。
  const inner = '1. 甲\n   1. 乙\n2. 丙';
  const a3 = caretAt(inner, 2, 3);
  assert.equal(applyAction(inner, bad.indentList(inner, plan(inner), a3, a3)),
    '1. 甲\n   1. 乙\n   2. 丙');
});

test('L-0313-09 变异：多行选区不再跳过没有前项的首项 ⇒ `L-0311-09` 必红、有前项负对照仍绿', function () {
  // Notion 口径（2026-11-14）：「没有前一个块 ⇒ 没有可挂的地方」。多行选区里逐项判定，
  // 跳过动不了的那几项；这条变异让首项也进 `起缩` ⇒ 步长改由首项算（它没有前项 ⇒ 0）。
  const bad = mutateModule('input',
    'return dir > 0 ? !!同级前一(rec) : !!浅缩进前一(rec);',
    'return true;');
  const t = '- 甲\n- 乙\n- 丙';
  const got = bad.indentList(t, plan(t), 0, 8);
  assert.equal(got.type, 'noop', '变异后首项（甲）也算"可移"⇒ 步长算不出来，整段 noop');
  assert.throws(function () {
    assert.equal(got.type, 'replace');
  }, { code: 'ERR_ASSERTION' }, '"首项跳过、其余照常"的判据必须当场红');
  // 负对照：目标行**有**前项时判据不参与决策，结果与产品一致。
  const p = '- 甲\n- 乙';
  assert.equal(applyAction(p, bad.indentList(p, plan(p), 4, 4)), '- 甲\n  - 乙');
});

test('L-0313-10 变异：子项不再随父项走 ⇒ `L-0311-15`/`L-0311-16` 必红、无子项负对照仍绿', function () {
  // Notion：移动一个块，它的**子块**跟着走。⛔ 只动父项会让父项与子项缩到同一列
  // ⇒ 子项被提成兄弟、有序列表被劈开（与 `L-0311-03` 那个用户报的形态同源）。
  const bad = mutateModule('input',
    'if (自 || 动列.length > 0) 全部.push(r);',
    'if (自) 全部.push(r);');
  const t = '1. 甲\n2. 乙\n   1. 乙一\n      1. 乙一一\n3. 丙';
  const a = caretAt(t, 1);
  const got = applyAction(t, bad.indentList(t, plan(t), a, a));
  assert.equal(got, '1. 甲\n   1. 乙\n   1. 乙一\n      1. 乙一一\n3. 丙',
    '变异后只动父项 ⇒ 乙一与乙同列，子项被提成兄弟');
  assert.throws(function () {
    assert.equal(got, '1. 甲\n   1. 乙\n      1. 乙一\n         1. 乙一一\n3. 丙');
  }, { code: 'ERR_ASSERTION' }, '`L-0311-15` 的子项跟随判据必须当场红');
  const u = '1. 甲\n   1. 甲一\n      1. 甲一一\n2. 乙';
  const b = caretAt(u, 1);
  assert.equal(applyAction(u, bad.outdentList(u, plan(u), b, b)),
    '1. 甲\n1. 甲一\n      1. 甲一一\n2. 乙', '⇧Tab 同样把子项留在原地');
  // 负对照：没有子项的项不受影响。
  const p = '- 甲\n- 乙';
  assert.equal(applyAction(p, bad.indentList(p, plan(p), 4, 4)), '- 甲\n  - 乙');
});

test('L-0313-11 变异：空项回车的"先升一级"被摘掉 ⇒ `L-0311-17` 必红、顶层负对照仍绿', function () {
  // `bugs/0116` §10：内层空项回车 = 回上一级（Notion / Mardo），⛔ 不是整条列表结束。
  const bad = mutateModule('input',
    'const 升 = indentStep(s, plan, from, from, -1);',
    'const 升 = null;');
  const t = '- 甲\n  - ';
  const p = plan(t);
  const at = p.listLines[1].contentFrom;
  const got = applyAction(t, bad.lineBreakAction(t, p, at, at));
  assert.equal(got, '- 甲\n', '变异后内层空项直接删掉整条标记、退回正文');
  assert.throws(function () {
    assert.equal(got, '- 甲\n- ');
  }, { code: 'ERR_ASSERTION' }, '内层空项回车升一级的判据必须当场红');
  // 负对照：顶层空项本来就是"删标记退列表"，与新分支无关。
  const top = '- 甲\n- ';
  const tp = plan(top);
  assert.equal(applyAction(top, bad.lineBreakAction(top, tp, tp.listLines[1].contentFrom,
    tp.listLines[1].contentFrom)), '- 甲\n');
});

test('L-0313-12 变异：行首退格的方向反成 `+1` ⇒ `L-0311-19` 必红、顶层负对照仍绿', function () {
  // `bugs/0116` §10：内层项行首退格 = 升一级；方向写反就成了"再降一级"（首个子项 ⇒ 空转）。
  const bad = mutateModule('input',
    'const act = indentStep(s, plan, from, from, -1);',
    'const act = indentStep(s, plan, from, from, 1);');
  const t = '- 甲\n  - 乙';
  const p = plan(t);
  const at = p.listLines[1].contentFrom;
  assert.equal(bad.outdentAtStart(t, p, at, at), null,
    '变异后首个子项没有同级前项 ⇒ 空转（原判据当场变红）');
  assert.throws(function () {
    assert.ok(bad.outdentAtStart(t, p, at, at), '变异后必须仍然能升一级');
  }, { code: 'ERR_ASSERTION' }, '行首退格升一级的判据必须当场红');
  // 负对照：顶层项无论方向都走 `null`（交回 `deleteRange`）。
  const top = '- 甲';
  const tp = plan(top);
  assert.equal(bad.outdentAtStart(top, tp, tp.listLines[0].contentFrom, tp.listLines[0].contentFrom),
    null);
});

// ── 覆盖汇总（必须是本文件最后一条 test）──────────────────────────────────
//
// ⚠️ 只统计**真的跑完**的格；⛔ 没有 skip 了（`L-0311` 那 5 格 2026-11-13 已落地），
//    数字变化时先改数据表，别手改这里。

test('L-0312-01 覆盖汇总：格数、ID 唯一性（无 skip）', function () {
  const all = [].concat(ENTER_CELLS, BACKSPACE_CELLS, DELETE_ITEM_CELLS, TASK_CELLS, TAB_CELLS)
    .map(function (c) { return c.id; })
    .concat(['L-0310-12']);
  assert.equal(new Set(all).size, all.length, '格 ID 必须唯一');
  assert.equal(EXECUTED.size, all.length,
    '实际跑完的格数 ' + EXECUTED.size + ' 与计划 ' + all.length + ' 不符（有用例中途失败？）');
  assert.deepEqual(TAB_CELLS.map(function (c) { return c.id; }),
    ['L-0311-01', 'L-0311-02', 'L-0311-03', 'L-0311-04', 'L-0311-05', 'L-0311-06',
      'L-0311-07', 'L-0311-08', 'L-0311-09', 'L-0311-10', 'L-0311-11', 'L-0311-12',
      'L-0311-13', 'L-0311-14', 'L-0311-15', 'L-0311-16',
      'L-0311-17', 'L-0311-18', 'L-0311-19', 'L-0311-20', 'L-0311-21'],
    'Tab 清单必须与覆盖表一致');
  // 打印给 `make test-js` 的 tail 与人工复核看（node:test 默认透传 stdout）。
  console.log('[L-0307 列表增删改查矩阵] 格 ' + all.length + ' 全部运行、无 skip；变异自检 12 条');
  console.log('[L-0307] 回车 ' + ENTER_CELLS.length + ' 格 / 退格 ' + BACKSPACE_CELLS.length
    + ' 格 / 删除整项 ' + DELETE_ITEM_CELLS.length + ' 格 / 任务框 ' + (TASK_CELLS.length + 1)
    + ' 格 / Tab 缩进 ' + TAB_CELLS.length + ' 格');
});

// ── 文件尾：Tab 语义台账与变异台账（⛔ 别凭记忆改）────────────────────────
//
// ## Tab / ⇧Tab（`bugs/0116`，2026-11-13 用户裁定后落地）
//
// | 格 ID | 最小复现 | 落地后的行为 | 出处 |
// |---|---|---|---|
// | L-0311-01 | `- 甲\n- 乙`，第 2 项 Tab | `- 甲\n  - 乙`（缩到前一条同级项的正文列 2） | `bugs/0116` §2/§3 |
// | L-0311-02 | `1. 甲\n2. 乙`，第 2 项 Tab | `1. 甲\n   1. 乙`（内容列 3 **＋ 编号改写成 1**） | `bugs/0116` §3；`bugs/0321` |
// | L-0311-03 | `- 甲\n  - 乙`，第 2 项 Tab | `- 甲\n    - 乙`（无同级前项 ⇒ 自身标记宽） | `bugs/0116` §2 |
// | L-0311-04 | `- 甲\n  - 乙`，⇧Tab | `- 甲\n- 乙` | `bugs/0116` §5 |
// | L-0311-05 | `- 甲`，⇧Tab | `noop`：吃掉键、源码不变（Notion 同口径，⛔ 不退成段落） | `bugs/0116` §5 |
// | L-0311-06 | 策略表与接线 | `LIST.tab='indent'`；`BLOCK.tab='leave'`、`CELL.tab='walk'` 不变 | `design/0054` `INV-EDITOBJ-05` |
// | L-0311-07..13 | 任务项 / 续行 / 多行选区 / 引用 / 非列表 / `10.` / 行中光标 | 见各格断言 | `bugs/0116` §3 |
// | L-0311-14 | 改号的四种例外（空行隔开 / 同列表续项 / 源码本来就 1 / `1)` 标点） | 除①外都保持原编号，①只加缩进 | `bugs/0321` §3 |
// | L-0311-17 | `- 甲\n  - `（内层空项），回车 | `- 甲\n- `（**升一级**，光标回正文起点） | `bugs/0116` §10 |
// | L-0311-18 | `1. 甲\n   1. `，回车 ×2 | 第一按升到顶层，第二按才删标记退回正文 | `bugs/0116` §10 |
// | L-0311-19 | `- 甲\n  - 乙`，内层项行首退格 | `- 甲\n- 乙`（升一级，⛔ 不变段落） | `bugs/0116` §10 |
// | L-0311-20 | 顶层 / 行中 / 有选区 / 续行 / 引用首项 / 无 plan | 一律 `null`（交回 `deleteRange` 原语义） | `bugs/0116` §10 |
// | L-0311-21 | `1. 甲\n   1. 乙\n      1. 乙一`，乙行首退格 | 乙与乙一一起退回一级 | `bugs/0116` §10 |
//
// ⚠️ 与 Notion 的一处**有意分歧**：Notion 顶层 ⇧Tab 同样什么都不做，退出列表是
//    "空项回车"（`L-0307-24`）与"行首退格"（`L-0308-*`）——本文件两组格仍是那两条的判据。
//    ⭐ 2026-11-14 起，**内层**的那两条都是"一级一级退"（`L-0311-17..21`）；到最外层才是
//    上面那两条的退出判据。
//
// ## 变异台账（2026-11-13 实跑，⛔ 别凭记忆改）
//
// | 变异点（真实源码的唯一靶子） | 预期打红的用例 |
// |---|---|
// | `input.js` 有序续号 `项.number + 1` → `项.number` | `L-0307-04`（有序 3. 行尾回车） |
// | `input.js` 空项分支 `type:'delete'` → `type:'insert'` | `L-0307-24`（空无序项回车退出） |
// | `selection.js` `const 空行反 = backOverBlankLine(...)` → `null` | `L-0308-03`（松列表行首退格删空行，`0305`） |
// | `task.js` `if (sym === UNCHECKED) next = CHECKED` → `next = UNCHECKED` | `L-0310-01`（未勾→已勾） |
// | `input.js` `prefix.replace(/\[[xX ]\]/, '[ ]')` → `prefix = prefix` | `L-0307-06`（已勾任务项续前缀复位） |
// | `input.js` 反缩进回退 `: 0;` → `: 首缩;` | `L-0311-10`（引用里的一级列表）/ `L-0311-05`（顶层 ⇧Tab） |
// | `input.js` 降级缩进量 `步 = 列宽(前) - 首缩` → `步 = 2` | `L-0311-02`（`1. ` 内容列 3）/ `L-0311-12`（`10. ` 内容列 4） |
// | `input.js` 改号插入 `return 空 + '1' + 编号标点(原);` → `return 空;` | `L-0311-02` / `L-0311-12`（有序降级必须从 1 起，`bugs/0321`） |
// | `input.js` 空项回车的升一级 `const 升 = indentStep(...-1);` → `const 升 = null;` | `L-0311-17`（内层空项回车，2026-11-14 加） |
// | `input.js` 行首退格的 `-1` → `+1`（`outdentAtStart` 内） | `L-0311-19`（内层项行首退格，2026-11-14 加） |
//
// 每条变异都附负对照（无序/非空/紧列表/已勾/普通项/有序外层仍绿），防"把判据写死成恒红"。
