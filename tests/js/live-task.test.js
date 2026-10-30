// `src/live/task.js` 的纯逻辑判据 —— `design/0051` §7「JS 纯逻辑」那一行。
//
// ⭐ 为什么这一份必须存在：打勾的三类后果里**三类都不上屏**
//    （改到别的行 / 把行尾或两侧文字吃掉 / 拿陈旧的列区间去套一个已经不是符号的位置），
//    写下去就是**另一份源码**，只有在字节层才看得见。
//
// ⚠️ 变异自测在最后：判据喂给"写坏的副本"必须变红。

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const Task = require('../../src/live/task.js');

/**
 * 造一个假的 `<input class="task-list-item-checkbox" type="checkbox">`。
 * ⚠️ 刻意**造得和 comrak 的输出一样**（`html.rs:1246-1277`）：`disabled` 一栏由调用方给，
 * 因为生产里它会被我们摘掉——判据⛔ 不看它。
 */
function box(checked, disabled) {
  const attrs = { type: 'checkbox' };
  const out = {
    nodeType: 1,
    tagName: 'INPUT',
    className: 'task-list-item-checkbox',
    checked: checked === true,
    disabled: disabled !== false,
    getAttribute: function (n) { return Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null; },
    children: [],
    // ⭐ `arm` 的判据要用（2026-10-29 代码评审第 15 条搬过来之后这里才开始需要）
    tabIndex: 0,
    removed: [],
    listeners: [],
    removeAttribute: function (n) { out.removed.push(n); delete attrs[n]; },
    addEventListener: function (type, fn) { out.listeners.push([type, fn]); },
  };
  return out;
}

/** 造一个普通元素（`li` / `ul` / `p` …），`kids` 是孩子数组。 */
function el(tagName, kids, className) {
  return {
    nodeType: 1,
    tagName: tagName,
    className: className || '',
    children: kids || [],
    getAttribute: function () { return null; },
  };
}

/** 一份嵌套列表：`ul > li > (input, p)`, `ul > li > ul > li > input`。 */
function fakeList() {
  const a = box(false);
  const b = box(true);
  const c = box(false);
  const inner = el('UL', [el('LI', [c, el('P', [])])]);
  return el('UL', [
    el('LI', [a, el('P', [])], 'task-list-item'),
    el('LI', [b, el('P', [])], 'task-list-item'),
    inner,
  ]);
}

// ── 识别 ─────────────────────────────────────────────────────────────

test('识别方框：tag ＋ type ＋ class 三件都要对', function () {
  assert.strictEqual(Task.isTaskCheckbox(box(false)), true);
  // ⚠️ `disabled` ⛔ 不是判据：生产里它会被摘掉，拿它当判据会在武装之后立刻失配。
  assert.strictEqual(Task.isTaskCheckbox(box(false, false)), true, '已武装的方框仍然认得出');

  const notInput = el('SPAN', [], 'task-list-item-checkbox');
  assert.strictEqual(Task.isTaskCheckbox(notInput), false, 'tagName 不对');
  const notCheckbox = box(false);
  notCheckbox.getAttribute = function () { return 'radio'; };
  assert.strictEqual(Task.isTaskCheckbox(notCheckbox), false, 'type 不对');
  const noClass = box(false);
  noClass.className = 'something-else';
  assert.strictEqual(Task.isTaskCheckbox(noClass), false, 'class 不对');
  assert.strictEqual(Task.isTaskCheckbox(null), false);
  assert.strictEqual(Task.isTaskCheckbox({ nodeType: 3, textContent: '- [ ] x' }), false, '文本节点不是方框');
});

// ── 块内扁平下标（先序 = 后端 `descendants()` 的顺序）─────────────────

test('扁平下标：先序，嵌套列表也按文档顺序', function () {
  const root = fakeList();
  const boxes = Task.checkboxesOf(root);
  assert.strictEqual(boxes.length, 3);
  assert.strictEqual(Task.countOf(root), 3);
  assert.strictEqual(Task.flatIndexOf(root, boxes[0]), 0);
  assert.strictEqual(Task.flatIndexOf(root, boxes[1]), 1);
  assert.strictEqual(Task.flatIndexOf(root, boxes[2]), 2, '嵌套里那个排第三（⛔ 不是按层级）');
  assert.strictEqual(Task.flatIndexOf(root, box(false)), -1, '不在这一块里 ⇒ -1（⛔ 不按"长得像"配对）');
  assert.deepStrictEqual(Task.checkboxesOf(null), []);
});

// ── 翻转（`INV-TASK-01`：同长度替换）─────────────────────────────────

test('翻转：`[ ]` / `[x]` / `[X]` 三种写法，结果**等长**且只有那一个字节变', function () {
  // ⚠️ 逐行标注成**元组**：不标的话数组字面量里既有字符串又有数字 ⇒ `c` 推断成
  //    `(string | number)[]`，`c[0].length` / `c[0].charAt(i)` 全变成「属性不存在」。
  /** @type {Array<[string, number, number, string]>} */
  const cases = [
    ['- [ ] 甲', 3, 4, '- [x] 甲'],
    ['- [x] 甲', 3, 4, '- [ ] 甲'],
    ['- [X] 甲', 3, 4, '- [ ] 甲'],
    ['  - [ ] 缩进', 5, 6, '  - [x] 缩进'],
    ['1. [ ] 有序', 4, 5, '1. [x] 有序'],
    ['> - [x] 引用里', 5, 6, '> - [ ] 引用里'],
  ];
  cases.forEach(function (c) {
    const out = Task.toggleLine(c[0], c[1], c[2]);
    assert.strictEqual(out, c[3]);
    assert.strictEqual(out.length, c[0].length, '长度必须不变（' + c[0] + '）');
    // 除那一个位置之外逐字符相同 —— 行尾、两侧文字、缩进一个都不许动。
    for (let i = 0; i < c[0].length; i++) {
      if (i === c[1]) continue;
      assert.strictEqual(out.charAt(i), c[0].charAt(i), '第 ' + i + ' 个字符被改动了：' + c[0]);
    }
  });
});

test('翻转：列是**行内 UTF-16 码元**（后缀有中文/emoji 不影响）', function () {
  // ⚠️ 任务符号**前面**永远是 ASCII 的列表前缀（comrak 只在项内容最开头物化 `TaskItem`），
  //    但**后面**可以是任意文本 ⇒ 这里钉住"按码元切、⛔ 不按字节"。
  const line = '- [ ] 😀 中文';
  assert.strictEqual(Task.toggleLine(line, 3, 4), '- [x] 😀 中文');
  assert.strictEqual(Task.toggleLine(line, 3, 4).length, line.length, 'emoji 不受影响');
});

test('翻转：越界 / 区间不是一格 / 非符号 ⇒ **抛错**（⛔ 不夹取）', function () {
  assert.throws(function () { Task.toggleLine('- [ ] x', 0, 9); }, /越界/);
  assert.throws(function () { Task.toggleLine('- [ ] x', 3, 5); }, /越界/, '宽度不是 1 ⇒ 越界');
  assert.throws(function () { Task.toggleLine('- [ ] x', -1, 0); }, /越界/);
  assert.throws(function () { Task.toggleLine('- [ ] x', 3.5, 4.5); }, /整数/);
  // ⭐ 那一处不是可打勾的符号 ⇒ 抛错。⚠️ 夹取会把"用陈旧列区间提交"这个错误**静默**
  //    变成"改到了附近"，而屏幕上看起来是对的。
  assert.throws(function () { Task.toggleLine('- [√] x', 3, 4); }, /不是可打勾的符号/);
  assert.throws(function () { Task.toggleLine('- [-] x', 3, 4); }, /不是可打勾的符号/);
  assert.throws(function () { Task.toggleLine(null, 3, 4); }, /不是字符串/);
});

test('翻转后的状态：`isCheckedSymbol`', function () {
  assert.strictEqual(Task.isCheckedSymbol('- [ ] x', 3, 4), true);
  assert.strictEqual(Task.isCheckedSymbol('- [x] x', 3, 4), false);
  assert.strictEqual(Task.isCheckedSymbol('- [X] x', 3, 4), false);
});

// ── 武装（`INV-TASK-07`）────────────────────────────────────────────
// ⭐ 2026-10-29 代码评审第 15 条：这一段此前住在 `main.js`，**任何断言都碰不到**。
//    它的三个后果全是静默的（WebKit 对 `disabled` 控件不派发鼠标事件 / 只摘一处算没摘 /
//    平白多出 Tab 停靠点），而屏幕上只表现成"点了没反应"。

test('武装：摘两处 `disabled`、退出 Tab 停靠点、两个监听都挂上', function () {
  const down = function () {};
  const click = function () {};
  const a = box(false);
  const root = el('UL', [el('LI', [a, el('P', [])], 'task-list-item')]);

  assert.strictEqual(Task.arm(root, { down: down, click: click }), 1, '返回这一趟新武装的个数');
  assert.strictEqual(a.disabled, false, 'property 那一处必须摘掉（只摘属性在 WebKit 上仍算 disabled）');
  assert.ok(a.removed.indexOf('disabled') >= 0, '属性那一处也必须摘掉');
  assert.strictEqual(a.tabIndex, -1, '阅读态按 Tab 离开正文是老行为，⛔ 不许新增停靠点');
  assert.deepStrictEqual(a.listeners, [['mousedown', down], ['click', click]]);
});

test('武装：幂等（`noteLive` 可能对同一批方框再跑一次）', function () {
  const a = box(false);
  const root = el('UL', [el('LI', [a], 'task-list-item')]);
  assert.strictEqual(Task.arm(root, { down: function () {}, click: function () {} }), 1);
  assert.strictEqual(Task.arm(root, { down: function () {}, click: function () {} }), 0, '第二次一个都不该新武装');
  assert.strictEqual(a.listeners.length, 2, '⚠️ 重复挂监听会让一次点击走两遍提交链');
});

test('武装：没给回调也要摘 `disabled`（否则方框连原生行为都没有）', function () {
  const a = box(false);
  const root = el('UL', [el('LI', [a], 'task-list-item')]);
  assert.strictEqual(Task.arm(root), 1);
  assert.strictEqual(a.disabled, false);
  assert.deepStrictEqual(a.listeners, [], '没回调就不挂 —— ⛔ 别挂一个 `undefined`');
});

test('武装：只给一个回调就只挂那一个 / 空树返回 0', function () {
  const a = box(false);
  const root = el('UL', [el('LI', [a], 'task-list-item')]);
  Task.arm(root, { click: function () {} });
  assert.deepStrictEqual(a.listeners.map(function (p) { return p[0]; }), ['click']);
  assert.strictEqual(Task.arm(el('P', []), { down: function () {} }), 0);
  assert.strictEqual(Task.arm(null), 0);
});

// ── 变异自测：判据必须能打红"写坏的副本" ──────────────────────────────

test('变异 m1：整行重写（丢掉前缀、尾巴补充空格）⇒ 等长那条**抓不住**，逐字符那条必红', function () {
  // ⚠️ 这条变异**刻意凑成等长**：它证明"长度不变"只挡得住最粗糙的写法，
  //    真正承重的是主判据里那句"除那一个位置之外逐字符相同"。
  const broken = function (line, from, to) {
    const out = line.slice(2, from) + (line.slice(from, to) === ' ' ? 'x' : ' ') + line.slice(to);
    return out + ' '.repeat(Math.max(0, line.length - out.length));
  };
  const want = Task.toggleLine('- [ ] 甲', 3, 4);
  const got = broken('- [ ] 甲', 3, 4);
  assert.strictEqual(want, '- [x] 甲');
  assert.notStrictEqual(got, want, '变异副本必须与产品**不同** —— 否则它和产品没法区分');
  assert.strictEqual(got.length, '- [ ] 甲'.length, '⚠️ 这一条变异**长度相同** ⇒ 只靠长度抓不住');

  let diff = 0;
  for (let i = 0; i < want.length; i++) if (got.charAt(i) !== want.charAt(i)) diff++;
  assert.ok(diff > 0, '主判据的逐字符比对必须抓得住它（否则 m1 白做）');
});

test('变异 m2：越界夹取（⛔ 不抛错）⇒ 越界那条必红', function () {
  const broken = function (line, from, to) {
    const f = Math.max(0, Math.min(from, line.length - 1));
    const t = Math.max(f + 1, Math.min(to, line.length));
    const sym = line.slice(f, t);
    return line.slice(0, f) + (sym === ' ' ? 'x' : ' ') + line.slice(t);
  };
  assert.throws(function () { Task.toggleLine('- [ ] x', 0, 9); }, /越界/);
  assert.doesNotThrow(function () { broken('- [ ] x', 0, 9); }, '变异副本必须**不**抛 —— 否则它和产品没法区分');
  assert.notStrictEqual(broken('- [ ] x', 0, 9), Task.toggleLine('- [ ] x', 3, 4));
});

test('变异 m3：把任何符号都当"没勾"⇒ 非符号那条必红', function () {
  const broken = function (line, from, to) {
    const sym = line.slice(from, to);
    return line.slice(0, from) + (sym === ' ' ? 'x' : ' ') + line.slice(to);
  };
  assert.throws(function () { Task.toggleLine('- [√] x', 3, 4); }, /不是可打勾的符号/);
  assert.doesNotThrow(function () { broken('- [√] x', 3, 4); }, '变异副本把 √ 也认了 —— 正是要打掉的那一类');
});

test('变异 m4：返回不等长 ⇒ 等长那条必红', function () {
  const broken = function (line, from, to) {
    const sym = line.slice(from, to);
    return line.slice(0, from) + (sym === ' ' ? '[x]' : '[ ]') + line.slice(to + 1);
  };
  assert.strictEqual(Task.toggleLine('- [ ] 甲', 3, 4).length, '- [ ] 甲'.length);
  assert.notStrictEqual(broken('- [ ] 甲', 3, 4).length, '- [ ] 甲'.length);
});

test('变异 m5：丢掉后半行 ⇒ 等长那条必红', function () {
  const broken = function (line, from, to) {
    return line.slice(0, from) + (line.slice(from, to) === ' ' ? 'x' : ' ');
  };
  assert.strictEqual(Task.toggleLine('- [x] 后半行', 3, 4), '- [ ] 后半行');
  assert.notStrictEqual(broken('- [x] 后半行', 3, 4), Task.toggleLine('- [x] 后半行', 3, 4));
  assert.notStrictEqual(broken('- [x] 后半行', 3, 4).length, '- [x] 后半行'.length);
});

// ⚠️⚠️ 下面这组对**源码**做：`arm` 是 IIFE 里的闭包，改导出对象不会影响它自己捕获的东西
//    ——那正是"没改到"与"判据不敏感"输出一模一样的坑（`live-box.test.js` 同款教训）。
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'live', 'task.js'), 'utf8');

/** 在**独立模块作用域**里跑一遍源码（不碰全局 `window`）。 */
function load(src) {
  const mod = { exports: {} };
  new Function('module', 'window', src)(mod, undefined);
  return mod.exports;
}

test('⭐ 变异自测：武装的四处写坏必须各自让对应判据变红（先证明改到了）', function () {
  const down = function () {};
  const click = function () {};

  // M6：只摘 attribute、不摘 property（WebKit 上仍然算 `disabled` ⇒ 一条鼠标事件都收不到）
  const m6 = SRC.replace('box.disabled = false;', 'void 0;');
  assert.notStrictEqual(m6, SRC, 'M6 没改到');
  const b6 = box(false);
  load(m6).arm(el('UL', [el('LI', [b6], 'task-list-item')]), { down: down, click: click });
  assert.strictEqual(b6.disabled, true, 'M6 没红：property 那一处没摘，判据却绿了');

  // M7：不幂等（`noteLive` 再跑一次就多挂一套监听 ⇒ 一次点击走两遍提交链）
  const m7 = SRC.replace('if (box.__rmdTaskArmed) continue;', 'if (false) continue;');
  assert.notStrictEqual(m7, SRC, 'M7 没改到');
  const b7 = box(false);
  const r7 = el('UL', [el('LI', [b7], 'task-list-item')]);
  const m7api = load(m7);
  m7api.arm(r7, { down: down, click: click });
  assert.strictEqual(m7api.arm(r7, { down: down, click: click }), 1, 'M7 没红：第二次仍然返回 1');
  assert.strictEqual(b7.listeners.length, 4, 'M7 没红：监听被挂了两套');

  // M8：不退出 Tab 停靠点（阅读态按 Tab 平白多出一堆方框）
  const m8 = SRC.replace('box.tabIndex = -1;', '');
  assert.notStrictEqual(m8, SRC, 'M8 没改到');
  const b8 = box(false);
  load(m8).arm(el('UL', [el('LI', [b8], 'task-list-item')]), { down: down, click: click });
  assert.strictEqual(b8.tabIndex, 0, 'M8 没红：Tab 停靠点还在');

  // M9：不挂 `click`（摘了 `disabled` 却没人处理 ⇒ 点一下先勾上、随后什么都不提交）
  const m9 = SRC.replace("if (typeof h.click === 'function') box.addEventListener('click', h.click);", '');
  assert.notStrictEqual(m9, SRC, 'M9 没改到');
  const b9 = box(false);
  load(m9).arm(el('UL', [el('LI', [b9], 'task-list-item')]), { down: down, click: click });
  assert.deepStrictEqual(b9.listeners.map(function (p) { return p[0]; }), ['mousedown'], 'M9 没红：click 仍然挂着');
});
