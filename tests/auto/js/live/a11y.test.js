// 辅助技术镜像：`aria-valuetext` 的文本计算、码点安全截断、通告去重与属性生命周期。
// 守的是 `design/0047` §2.7 方案①与「不设 tabindex / 不用 aria-live 报按键」三条边界。
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

const A = load('src/live/a11y.js').liveA11y;

/** 与 `selection.js` 同口径的适配器：`lineAt(pos).to` 是行尾之前，不含换行。 */
function doc(text) {
  const s = String(text);
  const lines = s.split('\n');
  const starts = [];
  let p = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(p);
    p += lines[i].length + 1;
  }
  return {
    length: s.length,
    lines: lines.length,
    lineAt: function (pos) {
      const at = Math.max(0, Math.min(pos, s.length));
      let i = lines.length - 1;
      for (let k = 0; k < lines.length; k++) {
        if (at <= starts[k] + lines[k].length) {
          i = k;
          break;
        }
      }
      return { number: i + 1, from: starts[i], to: starts[i] + lines[i].length, text: lines[i] };
    },
  };
}

/** 把 `t()` 的参数展开成可断言文本：选区带 chars，光标行不带。 */
function tr(key, params) {
  if (!params) return key;
  if (Object.prototype.hasOwnProperty.call(params, 'chars')) {
    return key + '(' + params.line + ',' + params.col + ',' + params.chars + ',' + params.text + ')';
  }
  return key + '(' + params.line + ',' + params.col + ',' + params.text + ')';
}

/** 记录 `t()` 收到的键与参数；返回 `键` 或 `键(参数)` 便于断言。 */
function translator(calls) {
  return function (key, params) {
    calls.push(params === undefined ? { key: key } : { key: key, params: params });
    if (params === undefined) return key;
    return key + '(' + params.line + ',' + params.col + ',' + params.chars + ',' + params.text + ')';
  };
}

test('truncate 不超上限就原样返回，null / undefined 当空串', () => {
  assert.strictEqual(A.truncate('abc', 3), 'abc');
  assert.strictEqual(A.truncate('ab', 3), 'ab');
  assert.strictEqual(A.truncate(null, 3), '');
  assert.strictEqual(A.truncate(undefined, 3), '');
});

test('truncate 按码点截断：高代理项落在边界时退一格，不切半个表情', () => {
  assert.strictEqual(A.truncate('a😀', 2), 'a');
  assert.strictEqual(A.truncate('a😀', 3), 'a😀');
  assert.strictEqual(A.truncate('ab😀', 3), 'ab');
});

test('describe 折叠光标给当前行、1-based 列与正文', () => {
  const out = A.describe(doc('ab\ncd'), { anchor: 1, head: 1 }, { t: tr });
  assert.deepStrictEqual(out, {
    label: 'live.a11y-label',
    value: 'live.a11y-value(1,2,ab)',
    line: 1,
    col: 2,
    chars: 0,
  });
});

test('describe 的 lineOffset 把块内行号换成全文行号', () => {
  const out = A.describe(doc('ab\ncd'), { anchor: 0, head: 0 }, { lineOffset: 40 });
  assert.strictEqual(out.line, 41);
  assert.strictEqual(out.col, 1);
});

test('describe 单行选区只读该行内到选区终点，不吞换行', () => {
  const out = A.describe(doc('abcdef'), { anchor: 1, head: 4 }, { t: tr });
  assert.strictEqual(out.chars, 3);
  assert.strictEqual(out.line, 1);
  assert.strictEqual(out.col, 2);
  assert.ok(out.value.indexOf(',bcd)') >= 0);
});

test('describe 跨行选区把中间换行读出来，区间是半开', () => {
  const out = A.describe(doc('ab\ncd'), { anchor: 1, head: 3 }, { t: tr });
  assert.strictEqual(out.chars, 2);
  assert.ok(out.value.indexOf(',b\n)') >= 0);
});

test('describe 反向选区与正向读数一致', () => {
  const a = A.describe(doc('abcdef'), { anchor: 4, head: 1 });
  const b = A.describe(doc('abcdef'), { anchor: 1, head: 4 });
  assert.deepStrictEqual(a, b);
});

test('describe 空行与空选区内容都落到 a11y-blank 文案，不读空串', () => {
  assert.strictEqual(A.describe(doc(''), { anchor: 0, head: 0 }, { t: tr }).value, 'live.a11y-value(1,1,live.a11y-blank)');
  const over = A.describe(doc('ab'), { anchor: 5, head: 6 }, { t: tr });
  assert.strictEqual(over.chars, 1);
  assert.strictEqual(over.value, 'live.a11y-selection(1,6,1,live.a11y-blank)');
});

test('describe 的选区文案带 line / col / chars / text 四个参数', () => {
  const calls = [];
  const out = A.describe(doc('ab\ncd'), { anchor: 1, head: 3 }, { t: translator(calls) });
  assert.deepStrictEqual(calls, [
    { key: 'live.a11y-label' },
    {
      key: 'live.a11y-selection',
      params: { line: 1, col: 2, chars: 2, text: 'b\n' },
    },
  ]);
  assert.strictEqual(out.label, 'live.a11y-label');
});

test('describe 默认把正文截到 MAX_TEXT，并按码点截', () => {
  const s = 'x'.repeat(250);
  const out = A.describe(doc(s), { anchor: 0, head: 0 }, { t: tr });
  assert.ok(out.value.indexOf('x'.repeat(200)) >= 0);
  assert.ok(out.value.indexOf('x'.repeat(201)) < 0);
});

test('describe 允许用 maxText 收紧上限，不影响行号列号', () => {
  const out = A.describe(doc('abcdef'), { anchor: 2, head: 2 }, { t: tr, maxText: 2 });
  assert.strictEqual(out.col, 3);
  assert.ok(out.value.indexOf(',ab)') >= 0);
});

test('describe 对缺字段的选区按 0 / anchor 兜底，非整数不参与计算', () => {
  const out = A.describe(doc('abc'), null);
  assert.strictEqual(out.line, 1);
  assert.strictEqual(out.col, 1);
  assert.strictEqual(out.chars, 0);
  const frac = A.describe(doc('abc'), { anchor: 1.5, head: 2.5 });
  assert.strictEqual(frac.col, 1);
  assert.strictEqual(frac.chars, 0);
});

function fakeHost() {
  const attrs = {};
  const children = [];
  return {
    attrs: attrs,
    children: children,
    setAttribute: function (name, value) {
      attrs[name] = String(value);
    },
    removeAttribute: function (name) {
      delete attrs[name];
    },
    appendChild: function (child) {
      child.parentNode = this;
      children.push(child);
      return child;
    },
    removeChild: function (child) {
      const i = children.indexOf(child);
      if (i >= 0) children.splice(i, 1);
      child.parentNode = null;
    },
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
  };
}

function fakeEl(tag) {
  return {
    tagName: tag || 'div',
    className: '',
    textContent: '',
    attrs: {},
    setAttribute: function (name, value) {
      this.attrs[name] = String(value);
    },
    removeAttribute: function (name) {
      delete this.attrs[name];
    },
  };
}

test('attach 给 host 挂 textbox 三角色，但⛔ 不设 tabindex', () => {
  const host = fakeHost();
  A.attach(host, { createEl: fakeEl });
  assert.strictEqual(host.attrs.role, 'textbox');
  assert.strictEqual(host.attrs['aria-multiline'], 'true');
  assert.strictEqual(host.attrs['aria-label'], 'live.a11y-label');
  assert.strictEqual(host.attrs.tabindex, undefined);
  assert.strictEqual(host.attrs.tabIndex, undefined);
});

test('attach 先建公告区再改文字：role=status ＋ polite ＋ atomic', () => {
  const host = fakeHost();
  A.attach(host, { createEl: fakeEl });
  assert.strictEqual(host.children.length, 1);
  const live = host.children[0];
  assert.strictEqual(live.className, 'cm-rmd-liveAnnouncer');
  assert.strictEqual(live.attrs.role, 'status');
  assert.strictEqual(live.attrs['aria-live'], 'polite');
  assert.strictEqual(live.attrs['aria-atomic'], 'true');
});

test('attach 的 sync 写 aria-valuetext 并返回同一份读数', () => {
  const host = fakeHost();
  const a = A.attach(host, { createEl: fakeEl, lineOffset: 9 });
  const info = a.sync(doc('ab'), { anchor: 1, head: 1 });
  assert.strictEqual(info.line, 10);
  assert.strictEqual(host.attrs['aria-valuetext'], info.value);
});

test('attach 的 announce 对同一句连续两次只写一次，换句才更新', () => {
  const host = fakeHost();
  const a = A.attach(host, { createEl: fakeEl });
  const live = host.children[0];
  let writes = 0;
  Object.defineProperty(live, 'textContent', {
    configurable: true,
    get: function () {
      return this.__text || '';
    },
    set: function (v) {
      writes++;
      this.__text = v;
    },
  });
  a.announce('已提交');
  a.announce('已提交');
  assert.strictEqual(writes, 1);
  a.announce('被拒绝');
  assert.strictEqual(writes, 2);
  assert.strictEqual(live.textContent, '被拒绝');
});

test('attach 的 label 复用同一份 i18n 键，不自己拼文案', () => {
  const host = fakeHost();
  const calls = [];
  const a = A.attach(host, { createEl: fakeEl, t: translator(calls) });
  assert.strictEqual(a.label(), 'live.a11y-label');
  assert.deepStrictEqual(calls, [{ key: 'live.a11y-label' }, { key: 'live.a11y-label' }]);
});

test('destroy 摘掉全部 aria 属性并从 host 移除公告区', () => {
  const host = fakeHost();
  const a = A.attach(host, { createEl: fakeEl });
  const live = host.children[0];
  a.sync(doc('abc'), { anchor: 0, head: 0 });
  a.destroy();
  assert.deepStrictEqual(host.attrs, {});
  assert.strictEqual(host.children.length, 0);
  assert.strictEqual(live.parentNode, null);
});

test('attach 默认的 t 直接回键名，供无 i18n 的纯逻辑环境使用', () => {
  const host = fakeHost();
  const a = A.attach(host, { createEl: fakeEl });
  assert.strictEqual(a.label(), 'live.a11y-label');
  assert.strictEqual(host.attrs['aria-label'], 'live.a11y-label');
});
