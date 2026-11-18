// 任务项方框：识别（阅读态 vs 编辑态两套判据）、先序扁平配对、同长度翻转、武装。
// 守的是 `INV-TASK-01/02/03/07` 与 `design/0051` §2.1/§2.3；编辑态 widget 的独立判据见 `bugs/0103`。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.rmd;
}

const T = load('src/live/task.js').liveTask;

function box(over) {
  const o = over || {};
  const type = o.type === undefined ? 'checkbox' : o.type;
  const attrs = Object.assign({}, o.attrs || {});
  if (type !== null && !Object.prototype.hasOwnProperty.call(attrs, 'type')) attrs.type = type;
  const node = {
    nodeType: 1,
    tagName: o.tagName || 'INPUT',
    type: type === null ? undefined : type,
    className: o.className === undefined ? 'task-list-item-checkbox' : o.className,
    children: o.children || [],
    attrs: attrs,
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    removeAttribute: function (name) {
      this.removed = this.removed || [];
      this.removed.push(name);
      delete this.attrs[name];
    },
    addEventListener: function (name, fn) {
      this.listeners = this.listeners || {};
      (this.listeners[name] = this.listeners[name] || []).push(fn);
    },
  };
  if (o.noGetAttribute) delete node.getAttribute;
  return node;
}

function tree(node, kids) {
  node.children = kids || [];
  return node;
}

function host(kids) {
  return { nodeType: 1, tagName: 'DIV', children: kids || [] };
}

// ── 源自 docs/bugs/0103（编辑态任务方框点不动）──────────────────────────
// 阅读态方框与编辑态 widget 是两种节点，配对闸门只能数前者；混进来数量就永远对不上。

test('0103 阅读态方框的判据是 tag + type + class 三件，不看 disabled', () => {
  assert.strictEqual(T.isTaskCheckbox(box()), true);
  assert.strictEqual(T.isTaskCheckbox(box({ attrs: { disabled: '' } })), true);
  assert.strictEqual(T.isTaskCheckbox(box({ type: 'radio' })), false);
  assert.strictEqual(T.isTaskCheckbox(box({ tagName: 'DIV' })), false);
  assert.strictEqual(T.isTaskCheckbox(box({ className: 'cm-rmd-taskbox' })), false);
  assert.strictEqual(T.isTaskCheckbox(box({ className: 'task-list-item-checkbox-x' })), false);
});

test('0103 type 可以从属性读，也可以从 property 读，大小写不敏感', () => {
  const viaAttr = box({ noGetAttribute: false, type: 'CHECKBOX' });
  assert.strictEqual(T.isTaskCheckbox(viaAttr), true);
  const viaProp = box({ noGetAttribute: true, type: 'CheckBox' });
  assert.strictEqual(T.isTaskCheckbox(viaProp), true);
  const noType = box({ type: null });
  assert.strictEqual(T.isTaskCheckbox(noType), false);
});

test('0103 多个 class 只要含目标 class 就算，顺序无关', () => {
  assert.strictEqual(T.isTaskCheckbox(box({ className: 'a task-list-item-checkbox b' })), true);
  assert.strictEqual(T.isTaskCheckbox(box({ className: ' task-list-item-checkbox\t' })), true);
});

test('0103 编辑态 widget 有自己的一套判据，不被阅读态判据认领', () => {
  const widget = box({ className: 'cm-rmd-taskbox' });
  assert.strictEqual(T.isWidgetBox(widget), true);
  assert.strictEqual(T.isTaskCheckbox(widget), false);
  const read = box();
  assert.strictEqual(T.isWidgetBox(read), false);
  assert.strictEqual(T.isTaskCheckbox(read), true);
});

test('0103 widgetBoxOf 从子节点往上找，命中含自己的第一个编辑态方框', () => {
  const widget = box({ className: 'cm-rmd-taskbox' });
  const inner = { nodeType: 1, tagName: 'SPAN', parentNode: widget };
  const outer = { nodeType: 1, tagName: 'SPAN', parentNode: inner };
  assert.strictEqual(T.widgetBoxOf(outer), widget);
  assert.strictEqual(T.widgetBoxOf(widget), widget);
  assert.strictEqual(T.widgetBoxOf({ nodeType: 1, tagName: 'SPAN', parentNode: null }), null);
  assert.strictEqual(T.widgetBoxOf(null), null);
});

test('0103 widgetBoxOf 不跨文字节点往上爬（只认元素节点）', () => {
  const widget = box({ className: 'cm-rmd-taskbox' });
  const text = { nodeType: 3, parentNode: widget };
  assert.strictEqual(T.widgetBoxOf(text), null);
});

test('0103 widgetsOf 只收编辑态方框，先序与文档顺序一致', () => {
  const w1 = box({ className: 'cm-rmd-taskbox' });
  const w2 = box({ className: 'cm-rmd-taskbox' });
  const read = box();
  const root = host([
    { nodeType: 1, tagName: 'SPAN', children: [w1] },
    { nodeType: 1, tagName: 'SPAN', children: [read, w2] },
  ]);
  assert.deepStrictEqual(T.widgetsOf(root), [w1, w2]);
  assert.strictEqual(T.widgetIndexOf(root, w2), 1);
  assert.strictEqual(T.widgetIndexOf(root, read), -1);
});

// ── 源自 docs/bugs/0152（嵌套任务项筛选用子串计数）──────────────────────
// 配对靠「先序第 n 个」，不是「文本里出现几次」；嵌套结构必须与后端 descendants 同序。

test('0152 嵌套任务按先序扁平，父项在前、子项紧随其后', () => {
  const a = box();
  const b = box();
  const c = box();
  const root = host([
    { nodeType: 1, tagName: 'LI', children: [a, { nodeType: 1, tagName: 'UL', children: [b] }] },
    { nodeType: 1, tagName: 'LI', children: [c] },
  ]);
  assert.deepStrictEqual(T.checkboxesOf(root), [a, b, c]);
  assert.strictEqual(T.flatIndexOf(root, a), 0);
  assert.strictEqual(T.flatIndexOf(root, b), 1);
  assert.strictEqual(T.flatIndexOf(root, c), 2);
  assert.strictEqual(T.countOf(root), 3);
});

test('0152 同一节点被挂在两处时按出现次数计，配对靠出现顺序', () => {
  const a = box();
  const root = host([a, a]);
  assert.deepStrictEqual(T.checkboxesOf(root), [a, a]);
  assert.strictEqual(T.flatIndexOf(root, a), 0);
});

test('0152 非方框的 checkbox（缺 comrak class）不计入配对，数量不受污染', () => {
  const real = box();
  const other = box({ className: 'other-checkbox' });
  const root = host([real, other]);
  assert.strictEqual(T.countOf(root), 1);
  assert.strictEqual(T.flatIndexOf(root, other), -1);
});

test('0152 空树 / 没有 children / 非元素根都给出空列表与 0', () => {
  assert.deepStrictEqual(T.checkboxesOf(null), []);
  assert.deepStrictEqual(T.checkboxesOf({}), []);
  assert.strictEqual(T.countOf({ children: [] }), 0);
  assert.strictEqual(T.flatIndexOf(null, box()), -1);
});

test('0152 深层嵌套（五层）仍然完整遍历，不半途截断', () => {
  const leaf = box();
  let node = { nodeType: 1, tagName: 'UL', children: [leaf] };
  for (let i = 0; i < 4; i++) node = { nodeType: 1, tagName: 'UL', children: [node] };
  assert.strictEqual(T.countOf(node), 1);
  assert.strictEqual(T.checkboxesOf(node)[0], leaf);
});

// ── 源自 docs/bugs/0077（勾选任务项后正文往上跳）────────────────────────
// 翻转必须是同长度替换：行长度一变，块高就变，滚动锚点跟着跳。

test('0077 未勾选翻成勾选，只有那一个符号变，行长不变', () => {
  const line = '- [ ] 买菜';
  const out = T.toggleLine(line, 3, 4);
  assert.strictEqual(out, '- [x] 买菜');
  assert.strictEqual(out.length, line.length);
});

test('0077 已勾选（小写 x）翻回未勾选，行长不变', () => {
  const line = '- [x] 买菜';
  const out = T.toggleLine(line, 3, 4);
  assert.strictEqual(out, '- [ ] 买菜');
  assert.strictEqual(out.length, line.length);
});

test('0077 大写 X 也认作已勾选，翻回空格', () => {
  assert.strictEqual(T.toggleLine('- [X] 买菜', 3, 4), '- [ ] 买菜');
});

test('0077 嵌套 / 引用 / 有序列表的前缀逐字节保留，只动符号', () => {
  assert.strictEqual(T.toggleLine('  - [ ] 子项', 5, 6), '  - [x] 子项');
  assert.strictEqual(T.toggleLine('> - [ ] 引用', 5, 6), '> - [x] 引用');
  assert.strictEqual(T.toggleLine('1. [ ] 有序', 4, 5), '1. [x] 有序');
});

test('0077 整行长度在翻转前后严格相等（滚动锚点的前提）', () => {
  const lines = ['- [ ] a', '  - [x] b', '> - [X] c', '10. [ ] d'];
  for (const line of lines) {
    const at = line.indexOf('[') + 1;
    assert.strictEqual(T.toggleLine(line, at, at + 1).length, line.length, line);
  }
});

test('0077 符号两侧内容逐字节不变，不 trim、不补空格', () => {
  const line = '前缀 [ ]后缀';
  const out = T.toggleLine(line, 4, 5);
  assert.strictEqual(out, '前缀 [x]后缀');
  assert.strictEqual(out.slice(0, 4), line.slice(0, 4));
  assert.strictEqual(out.slice(5), line.slice(5));
});

// ── 源自 docs/bugs/0077 / INV-TASK-01（翻转的失败路径）──────────────────
// 坐标不可信必须抛错，⛔ 不夹取：夹取会把「陈旧区间」静默改成「改了附近」。

test('0077 非字符串 / 非整数坐标抛错', () => {
  assert.throws(function () { T.toggleLine(null, 0, 1); }, /不是字符串/);
  assert.throws(function () { T.toggleLine('- [ ] a', 0.5, 1.5); }, /整数/);
  assert.throws(function () { T.toggleLine('- [ ] a', NaN, 1); }, /整数/);
  assert.throws(function () { T.toggleLine('- [ ] a', 0, Infinity); }, /整数/);
});

test('0077 区间不是恰好一个字符时抛越界错', () => {
  assert.throws(function () { T.toggleLine('- [ ] a', 3, 5); }, /越界/);
  assert.throws(function () { T.toggleLine('- [ ] a', 4, 3); }, /越界/);
  assert.throws(function () { T.toggleLine('- [ ] a', -1, 0); }, /越界/);
  assert.throws(function () { T.toggleLine('- [ ] a', 99, 100); }, /越界/);
});

test('0077 目标字符不是空格 / x / X 时抛「不是可打勾的符号」', () => {
  assert.throws(function () { T.toggleLine('- [-] a', 3, 4); }, /不是可打勾的符号/);
  assert.throws(function () { T.toggleLine('- [] a', 3, 4); }, /不是可打勾的符号/);
  assert.throws(function () { T.toggleLine('- [y] a', 3, 4); }, /不是可打勾的符号/);
});

test('0077 失败路径不产生任何部分写回（抛错即没有返回值）', () => {
  let out;
  try {
    out = T.toggleLine('- [ ] a', 3, 5);
  } catch (e) {
    out = 'threw';
  }
  assert.strictEqual(out, 'threw');
});

// ── 源自 docs/bugs/0077（状态条说反：参数必须是翻转前的行）──────────────
// isCheckedSymbol 内部自己翻一次；传翻转后的行会连翻两下，状态条永远说反。

test('0077 isCheckedSymbol 传翻转前的行：未勾 → 翻后已勾', () => {
  assert.strictEqual(T.isCheckedSymbol('- [ ] a', 3, 4), true);
});

test('0077 isCheckedSymbol 传翻转前的行：已勾 → 翻后未勾', () => {
  assert.strictEqual(T.isCheckedSymbol('- [x] a', 3, 4), false);
  assert.strictEqual(T.isCheckedSymbol('- [X] a', 3, 4), false);
});

test('0077 isCheckedSymbol 与 toggleLine 的结果一致：翻后首字符不是空格', () => {
  const line = '- [ ] a';
  const after = T.toggleLine(line, 3, 4);
  assert.strictEqual(T.isCheckedSymbol(line, 3, 4), after.charAt(3) !== ' ');
});

test('0077 传翻转之后的行会得到相反答案（把这条陷阱钉住）', () => {
  const before = '- [ ] a';
  const after = T.toggleLine(before, 3, 4);
  assert.strictEqual(T.isCheckedSymbol(before, 3, 4), true);
  assert.strictEqual(T.isCheckedSymbol(after, 3, 4), false);
});

// ── 源自 docs/bugs/0103（武装：摘 disabled、摘 Tab 位、挂两个监听）──────
// 不摘 disabled，WebKit 不派发鼠标事件 ⇒ 那条唯一的提交入口永远收不到点击。

test('0103 arm 同时摘掉 disabled 的 property 与属性', () => {
  const b = box({ attrs: { disabled: '' } });
  const root = host([b]);
  assert.strictEqual(T.arm(root, {}), 1);
  assert.strictEqual(b.disabled, false);
  assert.deepStrictEqual(b.removed, ['disabled']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(b.attrs, 'disabled'), false);
});

test('0103 arm 把 tabIndex 设为 -1，不新增 Tab 停靠点', () => {
  const b = box();
  T.arm(host([b]), {});
  assert.strictEqual(b.tabIndex, -1);
});

test('0103 arm 挂上 mousedown 与 click 两个监听，顺序是先 down 后 click', () => {
  const b = box();
  const down = function () {};
  const click = function () {};
  T.arm(host([b]), { down: down, click: click });
  assert.deepStrictEqual(b.listeners.mousedown, [down]);
  assert.deepStrictEqual(b.listeners.click, [click]);
});

test('0103 arm 允许只给一个回调，缺的那个不挂', () => {
  const b = box();
  const down = function () {};
  T.arm(host([b]), { down: down });
  assert.deepStrictEqual(b.listeners.mousedown, [down]);
  assert.strictEqual(b.listeners.click, undefined);
});

test('0103 arm 是幂等的：第二次不再重复挂监听，返回新武装数 0', () => {
  const b = box();
  const root = host([b]);
  const click = function () {};
  assert.strictEqual(T.arm(root, { click: click }), 1);
  assert.strictEqual(T.arm(root, { click: click }), 0);
  assert.strictEqual(b.listeners.click.length, 1);
});

test('0103 arm 返回这一趟新武装的个数，嵌套树全部武装', () => {
  const a = box();
  const b = box();
  const c = box();
  const root = host([
    { nodeType: 1, tagName: 'LI', children: [a, { nodeType: 1, tagName: 'UL', children: [b] }] },
    { nodeType: 1, tagName: 'LI', children: [c] },
  ]);
  assert.strictEqual(T.arm(root, {}), 3);
  assert.strictEqual(T.arm(root, {}), 0);
});

test('0103 arm 不碰编辑态 widget，避免两套判据互相污染', () => {
  const widget = box({ className: 'cm-rmd-taskbox' });
  assert.strictEqual(T.arm(host([widget]), {}), 0);
  assert.strictEqual(widget.tabIndex, undefined);
  assert.strictEqual(widget.listeners, undefined);
});

test('0103 arm 空树 / 没有方框时返回 0，不抛错', () => {
  assert.strictEqual(T.arm(null, {}), 0);
  assert.strictEqual(T.arm({}, {}), 0);
  assert.strictEqual(T.arm(host([]), {}), 0);
});

test('0103 arm 在 disabled 已经摘过时仍保留第二次可武装（只由标记判重）', () => {
  const b = box();
  b.disabled = false;
  T.arm(host([b]), {});
  assert.strictEqual(b.__rmdTaskArmed, true);
  T.arm(host([b]), {});
  assert.strictEqual(b.__rmdTaskArmed, true);
});

// ── 源自 docs/bugs/0106（任务项打勾前后排版横跳）────────────────────────
// 纯逻辑侧守的是「方框本身只有一个、不重复挂」，排版由 widget DOM 与样式负责。

test('0106 空任务项（符号后没有文字）也能翻转，不依赖尾随空格', () => {
  assert.strictEqual(T.toggleLine('- [ ]', 3, 4), '- [x]');
  assert.strictEqual(T.toggleLine('- [x]', 3, 4), '- [ ]');
});

test('0106 尾随空格数量在翻转前后不变（排版宽度不由翻转改变）', () => {
  const line = '- [ ]   ';
  const out = T.toggleLine(line, 3, 4);
  assert.strictEqual(out, '- [x]   ');
  assert.strictEqual(out.length, line.length);
});

test('0106 连续多个任务项逐个翻转，互不影响', () => {
  const lines = ['- [ ] a', '- [ ] b', '- [ ] c'];
  const out = lines.map(function (l) { return T.toggleLine(l, 3, 4); });
  assert.deepStrictEqual(out, ['- [x] a', '- [x] b', '- [x] c']);
});

test('0106 同一个方框被武装后 counted 仍是一次（INV-TASK-03 配对闸门）', () => {
  const b = box();
  const root = host([b]);
  T.arm(root, {});
  assert.strictEqual(T.countOf(root), 1);
  assert.strictEqual(T.flatIndexOf(root, b), 0);
});

// ── 边界变体：非方框输入 / 多块互不串 ──────────────────────────────────
test('边界：isTaskCheckbox / isWidgetBox 对 null 与非元素节点一律 false', () => {
  assert.strictEqual(T.isTaskCheckbox(null), false);
  assert.strictEqual(T.isTaskCheckbox(undefined), false);
  assert.strictEqual(T.isTaskCheckbox({ nodeType: 3, tagName: 'INPUT' }), false);
  assert.strictEqual(T.isWidgetBox(null), false);
  assert.strictEqual(T.isWidgetBox({ nodeType: 3, tagName: 'INPUT' }), false);
});

test('边界：两块任务列表的扁平下标各自从 0 起，不跨块累加', () => {
  const a = box();
  const b = box();
  const block1 = host([a]);
  const block2 = host([b]);
  assert.strictEqual(T.flatIndexOf(block1, a), 0);
  assert.strictEqual(T.flatIndexOf(block2, b), 0);
  assert.strictEqual(T.flatIndexOf(block1, b), -1);
  assert.strictEqual(T.flatIndexOf(block2, a), -1);
});
