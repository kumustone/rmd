// 任务项方框：识别、块内先序下标、同长度翻转、武装。
// 守的是 `INV-TASK-01`（同长度）与 `INV-TASK-07`（摘 disabled、不占 Tab）。
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

function node(tag, opts) {
  const o = opts || {};
  const attrs = Object.assign({}, o.attrs || {});
  const el = {
    nodeType: o.nodeType === undefined ? 1 : o.nodeType,
    tagName: tag,
    className: o.className || '',
    children: o.children || [],
    style: {},
    listeners: {},
    disabled: o.disabled !== undefined ? o.disabled : true,
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    setAttribute: function (name, value) {
      attrs[name] = String(value);
    },
    removeAttribute: function (name) {
      delete attrs[name];
      if (name === 'disabled') this.disabled = false;
    },
    hasAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    addEventListener: function (type, fn) {
      (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    },
  };
  if (o.type !== undefined) el.type = o.type;
  return el;
}

function box(cls, opts) {
  return node('input', Object.assign({ attrs: { type: 'checkbox' }, className: cls || 'task-list-item-checkbox' }, opts || {}));
}

test('任务方框的判据是 input + type=checkbox + 那个 class 三件', () => {
  assert.strictEqual(T.isTaskCheckbox(box()), true);
  assert.strictEqual(T.isTaskCheckbox(box('a task-list-item-checkbox b')), true);
  assert.strictEqual(T.isTaskCheckbox(box('TASK-LIST-ITEM-CHECKBOX')), false);
});

test('isTaskCheckbox 不看 disabled，因为武装之后它会被摘掉', () => {
  assert.strictEqual(T.isTaskCheckbox(box('task-list-item-checkbox', { disabled: true })), true);
  assert.strictEqual(T.isTaskCheckbox(box('task-list-item-checkbox', { disabled: false })), true);
});

test('非元素、非 input、非 checkbox、class 只是子串都不是任务方框', () => {
  assert.strictEqual(T.isTaskCheckbox(null), false);
  assert.strictEqual(T.isTaskCheckbox({ nodeType: 3 }), false);
  assert.strictEqual(T.isTaskCheckbox(node('div', { className: 'task-list-item-checkbox' })), false);
  assert.strictEqual(T.isTaskCheckbox(node('input', { attrs: { type: 'radio' }, className: 'task-list-item-checkbox' })), false);
  assert.strictEqual(T.isTaskCheckbox(box('my-task-list-item-checkbox')), false);
});

test('type 从属性读不到时退回 property，且大小写不敏感', () => {
  const a = { nodeType: 1, tagName: 'input', type: 'CHECKBOX', className: 'task-list-item-checkbox' };
  assert.strictEqual(T.isTaskCheckbox(a), true);
  const b = node('input', { attrs: { type: 'CheckBox' }, className: 'task-list-item-checkbox' });
  assert.strictEqual(T.isTaskCheckbox(b), true);
});

test('checkboxesOf 按先序（文档顺序）枚举嵌套方框', () => {
  const b1 = box();
  const b2 = box();
  const b3 = box();
  const root = node('div', { children: [b1, node('ul', { children: [node('li', { children: [b2] })] }), b3] });
  assert.deepStrictEqual(T.checkboxesOf(root), [b1, b2, b3]);
});

test('编辑态 widget 方框与阅读态方框是两套判据，互不混入', () => {
  const read = box('task-list-item-checkbox');
  const widget = box('cm-rmd-taskbox');
  const root = node('div', { children: [read, widget] });
  assert.deepStrictEqual(T.checkboxesOf(root), [read]);
  assert.strictEqual(T.isWidgetBox(widget), true);
  assert.strictEqual(T.isWidgetBox(read), false);
  assert.deepStrictEqual(T.widgetsOf(root), [widget]);
});

test('countOf 与 flatIndexOf 用同一份先序清单，落空给 -1', () => {
  const b1 = box();
  const b2 = box();
  const other = box();
  const root = node('div', { children: [b1, node('div', { children: [b2] })] });
  assert.strictEqual(T.countOf(root), 2);
  assert.strictEqual(T.flatIndexOf(root, b1), 0);
  assert.strictEqual(T.flatIndexOf(root, b2), 1);
  assert.strictEqual(T.flatIndexOf(root, other), -1);
});

test('widgetBoxOf 从子节点向上找，含自己，越过元素链就停', () => {
  const widget = box('cm-rmd-taskbox');
  const inner = node('span');
  inner.parentNode = widget;
  widget.parentNode = node('div');
  assert.strictEqual(T.widgetBoxOf(widget), widget);
  assert.strictEqual(T.widgetBoxOf(inner), widget);
  assert.strictEqual(T.widgetBoxOf(node('span')), null);
  assert.strictEqual(T.widgetBoxOf({ nodeType: 3 }), null);
});

test('widgetIndexOf 只数编辑态方框，并给出宿主内先序下标', () => {
  const w1 = box('cm-rmd-taskbox');
  const w2 = box('cm-rmd-taskbox');
  const root = node('div', { children: [w1, box('task-list-item-checkbox'), w2] });
  assert.deepStrictEqual(T.widgetsOf(root), [w1, w2]);
  assert.strictEqual(T.widgetIndexOf(root, w2), 1);
  assert.strictEqual(T.widgetIndexOf(root, box('cm-rmd-taskbox')), -1);
});

test('toggleLine 把空格翻成 x、把 x/X 翻回空格，其余逐字节不变', () => {
  assert.strictEqual(T.toggleLine('- [ ] a', 3, 4), '- [x] a');
  assert.strictEqual(T.toggleLine('- [x] a', 3, 4), '- [ ] a');
  assert.strictEqual(T.toggleLine('- [X] a', 3, 4), '- [ ] a');
  assert.strictEqual(T.toggleLine('- [ ] a', 3, 4).length, '- [ ] a'.length);
});

test('toggleLine 对非字符串、非整数、越界与多字符区间一律抛错', () => {
  assert.throws(() => T.toggleLine(null, 0, 1), /不是字符串/);
  assert.throws(() => T.toggleLine('- [ ]', 1.5, 2.5), /整数/);
  assert.throws(() => T.toggleLine('- [ ]', -1, 0), /越界/);
  assert.throws(() => T.toggleLine('- [ ]', 5, 6), /越界/);
  assert.throws(() => T.toggleLine('- [ ]', 3, 5), /越界/);
});

test('toggleLine 对非勾选符号抛错，不静默改成别的字', () => {
  assert.throws(() => T.toggleLine('- [-] a', 3, 4), /不是可打勾的符号/);
  assert.throws(() => T.toggleLine('- [y] a', 3, 4), /不是可打勾的符号/);
});

test('isCheckedSymbol 接受翻转之前的那一行，返回翻转后是否勾上', () => {
  assert.strictEqual(T.isCheckedSymbol('- [ ] a', 3, 4), true);
  assert.strictEqual(T.isCheckedSymbol('- [x] a', 3, 4), false);
  assert.strictEqual(T.isCheckedSymbol('- [X] a', 3, 4), false);
});

test('arm 摘 disabled 属性与 property、退出 Tab 停靠点并挂两个监听', () => {
  const b = box();
  const root = node('div', { children: [b] });
  let down = 0;
  let click = 0;
  const n = T.arm(root, { down: () => down++, click: () => click++ });
  assert.strictEqual(n, 1);
  assert.strictEqual(b.disabled, false);
  assert.strictEqual(b.hasAttribute('disabled'), false);
  assert.strictEqual(b.tabIndex, -1);
  assert.strictEqual(b.listeners.mousedown.length, 1);
  assert.strictEqual(b.listeners.click.length, 1);
  b.listeners.mousedown[0]();
  b.listeners.click[0]();
  assert.strictEqual(down, 1);
  assert.strictEqual(click, 1);
});

test('arm 幂等：同一批方框第二次返回 0，也不重复挂监听', () => {
  const b = box();
  const root = node('div', { children: [b] });
  assert.strictEqual(T.arm(root, { click: () => {} }), 1);
  assert.strictEqual(T.arm(root, { click: () => {} }), 0);
  assert.strictEqual(b.listeners.click.length, 1);
});

test('arm 不给回调时只做属性清理，不硬塞监听', () => {
  const b = box();
  const root = node('div', { children: [b] });
  assert.strictEqual(T.arm(root), 1);
  assert.deepStrictEqual(Object.keys(b.listeners), []);
});

test('arm 不把编辑态 widget 当阅读态方框武装', () => {
  const widget = box('cm-rmd-taskbox');
  const root = node('div', { children: [widget] });
  assert.strictEqual(T.arm(root, { click: () => {} }), 0);
  assert.strictEqual(widget.__rmdTaskArmed, undefined);
});

test('walk 对没有 children 或畸形子节点不抛错', () => {
  assert.deepStrictEqual(T.checkboxesOf(null), []);
  assert.deepStrictEqual(T.checkboxesOf({}), []);
  assert.deepStrictEqual(T.checkboxesOf({ children: [null, { nodeType: 1 }] }), []);
});
