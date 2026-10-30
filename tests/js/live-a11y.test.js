// `design/0047` §2.7 **候选方案①**（`role="textbox"` ＋ `aria-valuetext` 镜像）的判据。
//
// ⚠️ 这一份测的是 `src/live/a11y.js`：`describe()` 是纯逻辑，`attach()` 用假元素跑
//    （`createEl` 是**注入点**，真实现用 `document.createElement`）。
//    ⛔ 它答不了"VoiceOver 实际读得对不对"——那是 §7.3 的人工闸门。
//
// ⭐ 三类错在屏幕上都不报错、AT 也不会报错，只会**读出错的字**：
//   ① 行号报成"块内第 N 行"（用户看不见块边界 ⇒ 送错地方）；
//   ② 截断切在代理对中间（读出一个替换字符）；
//   ③ `aria-live` 每次按键都播（读屏被淹没，用户只能关掉 VoiceOver）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const A = require('../../src/live/a11y.js');

/** 与 `live-selection.test.js` 同一口径的假适配器。 */
function doc(text) {
  const lines = String(text).split('\n');
  const starts = [];
  let p = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(p);
    p += lines[i].length + 1;
  }
  const n = String(text).length;
  return {
    length: n,
    lines: lines.length,
    lineAt: function (pos) {
      const at = Math.max(0, Math.min(pos, n));
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

/** 假 `t`：把占位符原样摊开，方便断言"这两个值真的进了模板"。 */
function t(key, vars) {
  if (!vars) return key;
  return (
    key +
    ' ' +
    Object.keys(vars)
      .map(function (k) {
        return k + '=' + vars[k];
      })
      .join(',')
  );
}

/** 假元素（够 `attach()` 用）。 */
function el(tag) {
  const node = {
    tagName: tag,
    attrs: {},
    children: [],
    className: '',
    parentNode: null,
    writes: 0,
    _text: '',
    setAttribute: function (k, v) {
      node.attrs[k] = String(v);
    },
    getAttribute: function (k) {
      return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null;
    },
    removeAttribute: function (k) {
      delete node.attrs[k];
    },
    appendChild: function (c) {
      c.parentNode = node;
      node.children.push(c);
      return c;
    },
    removeChild: function (c) {
      const i = node.children.indexOf(c);
      if (i >= 0) node.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
  };
  Object.defineProperty(node, 'textContent', {
    get: function () {
      return node._text;
    },
    // ⭐ 数一次"真的改写过"——`announce()` 的去重就靠它验。
    set: function (v) {
      node.writes++;
      node._text = String(v);
    },
  });
  return node;
}

// ── describe()：纯逻辑 ────────────────────────────────────────────────────

test('光标：报**全文**行号与列号（1-based），正文进模板', function () {
  const d = doc('第一行\n第二行');
  const r = A.describe(d, { anchor: 5, head: 5 }, { t: t });
  assert.strictEqual(r.line, 2);
  assert.strictEqual(r.col, 2);
  assert.ok(r.value.indexOf('line=2') >= 0, r.value);
  assert.ok(r.value.indexOf('col=2') >= 0, r.value);
  assert.ok(r.value.indexOf('第二行') >= 0, r.value);
  assert.strictEqual(r.label, 'live.a11y-label');
});

test('⭐ `lineOffset`：块内第 1 行要报成全文的对应行（⛔ 不是"块内第 1 行"）', function () {
  const d = doc('# 标题\n正文');
  const r = A.describe(d, { anchor: 0, head: 0 }, { t: t, lineOffset: 41 });
  assert.strictEqual(r.line, 42, '42 = 前面 41 行 + 块内第 1 行');
  const two = A.describe(d, { anchor: 5, head: 5 }, { t: t, lineOffset: 41 });
  assert.strictEqual(two.line, 43);
});

test('空行：正文位置换成"空行"那句（⛔ 不留下一个空格让人以为没读到）', function () {
  const r = A.describe(doc('a\n\nb'), { anchor: 2, head: 2 }, { t: t });
  assert.ok(r.value.indexOf('live.a11y-blank') >= 0, r.value);
});

test('选区（同一行）：报字符数 ＋ 选中的那段文字', function () {
  const r = A.describe(doc('abcdef'), { anchor: 1, head: 4 }, { t: t });
  assert.strictEqual(r.chars, 3);
  assert.strictEqual(r.line, 1);
  assert.strictEqual(r.col, 2, '列号取选区**起点**');
  assert.ok(r.value.indexOf('chars=3') >= 0, r.value);
  assert.ok(r.value.indexOf('bcd') >= 0, r.value);
});

test('选区（跨行）：正文是两行拼起来的（含换行），⛔ 只报第一行', function () {
  // `'ab\ncd'`：偏移 1…4 是 `b` `\n` `c`（`d` 在 4）
  const r = A.describe(doc('ab\ncd'), { anchor: 1, head: 4 }, { t: t });
  assert.ok(r.value.indexOf('b\nc') >= 0, r.value);
  assert.ok(r.value.indexOf('d') < 0, '选区之外的字符不许进朗读文本');
});

test('选区反着给（anchor > head）与正着给**逐字一样**', function () {
  const d = doc('abcdef');
  const a = A.describe(d, { anchor: 1, head: 4 }, { t: t });
  const b = A.describe(d, { anchor: 4, head: 1 }, { t: t });
  assert.deepStrictEqual(a, b);
});

test('⭐ 截断按**码点**：⛔ 不把代理对切成一个替换字符', function () {
  const emoji = '🌰'; // 两个 UTF-16 码元
  const src = emoji.repeat(10); // 20 码元
  const cut = A.truncate(src, 5); // 5 是奇数 ⇒ 第 5 个码元落在低代理项上
  assert.strictEqual(cut, emoji + emoji, '只留两个完整字符（4 码元），⛔ 不留半个');
  assert.strictEqual(Array.from(cut).length, 2);
  for (const ch of cut) assert.ok(ch !== '�', '出现替换字符就是切坏了');
});

test('镜像文本有上限（默认 200 码元）；⚠️ 只影响朗读，⛔ 不影响文档', function () {
  const long = 'x'.repeat(5000);
  const r = A.describe(doc(long), { anchor: 0, head: 0 }, { t: t });
  assert.ok(r.value.length < 400, '实际值 ' + r.value.length);
  assert.strictEqual(A.MAX_TEXT, 200);
  const custom = A.describe(doc(long), { anchor: 0, head: 0 }, { t: t, maxText: 10 });
  assert.ok(custom.value.indexOf('x'.repeat(10)) >= 0);
  assert.ok(custom.value.indexOf('x'.repeat(11)) < 0, '⛔ 超出上限的那一格不许出现');
});

test('空文档 / 越界位置不抛错', function () {
  assert.doesNotThrow(function () {
    A.describe(doc(''), { anchor: 0, head: 0 }, { t: t });
    A.describe(doc('abc'), { anchor: 99, head: 99 }, { t: t });
    A.describe(doc('abc'), null, { t: t });
  });
});

// ── attach()：DOM 那半（假元素）─────────────────────────────────────────

function host() {
  return el('div');
}

test('host：`role=textbox` ＋ `aria-multiline` ＋ `aria-label`，⛔ 不设 `tabindex`', function () {
  const h = host();
  const a = A.attach(h, { t: t, createEl: el });
  assert.strictEqual(h.getAttribute('role'), 'textbox');
  assert.strictEqual(h.getAttribute('aria-multiline'), 'true');
  assert.strictEqual(h.getAttribute('aria-label'), 'live.a11y-label');
  assert.strictEqual(h.getAttribute('tabindex'), null, '⛔ 第二个可聚焦编辑面');
  a.destroy();
});

test('通告区**先建好**再用（`aria-live` 后插入时多数 AT 不读第一段）', function () {
  const h = host();
  const a = A.attach(h, { t: t, createEl: el });
  const region = h.children.filter(function (c) {
    return c.getAttribute('role') === 'status';
  })[0];
  assert.ok(region, '没有 role=status 的通告区');
  assert.strictEqual(region.getAttribute('aria-live'), 'polite');
  assert.strictEqual(region.getAttribute('aria-atomic'), 'true');
  a.destroy();
});

test('`sync()` 写 `aria-valuetext`，并把同一个 info 交回去（⛔ 不 dispatch）', function () {
  const h = host();
  const a = A.attach(h, { t: t, createEl: el, lineOffset: 9 });
  const info = a.sync(doc('abc\ndef'), { anchor: 5, head: 5 });
  assert.strictEqual(info.line, 11);
  assert.strictEqual(h.getAttribute('aria-valuetext'), info.value);
  a.destroy();
});

test('⭐ `announce()` 同一句连续两次**只写一次**（否则读屏被淹没）', function () {
  const h = host();
  const a = A.attach(h, { t: t, createEl: el });
  const region = h.children.filter(function (c) {
    return c.getAttribute('role') === 'status';
  })[0];
  a.announce('已改在内存里');
  const once = region.writes;
  assert.strictEqual(once, 1);
  a.announce('已改在内存里');
  assert.strictEqual(region.writes, once, '⛔ 同一句重复写会重复播报');
  a.announce('别的');
  assert.strictEqual(region.writes, once + 1);
  a.destroy();
});

test('`destroy()` 把 host 上的四个属性与通告区都摘干净', function () {
  const h = host();
  const a = A.attach(h, { t: t, createEl: el });
  a.sync(doc('abc'), { anchor: 0, head: 0 });
  a.destroy();
  assert.strictEqual(h.getAttribute('role'), null);
  assert.strictEqual(h.getAttribute('aria-multiline'), null);
  assert.strictEqual(h.getAttribute('aria-label'), null);
  assert.strictEqual(h.getAttribute('aria-valuetext'), null);
  assert.strictEqual(h.children.length, 0);
});
