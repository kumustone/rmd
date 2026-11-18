// 版面搬运：把被替换块的 computed style 过滤成 host 行内样式，并给出品种 / 标题级别。
// 守的是 `design/0047` §2.10「外观只有一个来源」。⚠️ 2026-11-09 起 `INV-KERNEL-05` 只剩
// ① "块永远进得去"：几何差不是"告警即可"的允差，`INV-LIVE-04` ① 要求它为 0。
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
  return win;
}

const W = load('src/live/box.js');
const B = W.rmd.liveBox;

function computed(over) {
  const o = over || {};
  const cs = {};
  for (let i = 0; i < B.PROPS.length; i++) {
    const k = B.PROPS[i][1];
    if (Object.prototype.hasOwnProperty.call(o, B.PROPS[i][0])) cs[k] = o[B.PROPS[i][0]];
    else cs[k] = '0px';
  }
  return cs;
}

test('boxOf 按 PROPS 把计算样式搬成 CSS 属性名，不认识的字段不出现', () => {
  const cs = computed({
    'font-size': '28px',
    'line-height': '30.8px',
    'font-weight': '700',
    'margin-bottom': '15.4px',
    'padding-left': '2em',
    'border-left-width': '3px',
    'border-left-style': 'solid',
    'border-left-color': 'rgb(200, 200, 200)',
    'background-color': 'rgb(245, 245, 245)',
  });
  cs.color = 'rgb(1, 2, 3)';
  cs.fontFamily = 'sans-serif';
  const box = B.boxOf(cs);
  assert.strictEqual(box['font-size'], '28px');
  assert.strictEqual(box['line-height'], '30.8px');
  assert.strictEqual(box['font-weight'], '700');
  assert.strictEqual(box['margin-bottom'], '15.4px');
  assert.strictEqual(box['padding-left'], '2em');
  assert.strictEqual(box['border-left-width'], '3px');
  assert.strictEqual(box['border-left-style'], 'solid');
  assert.strictEqual(box['border-left-color'], 'rgb(200, 200, 200)');
  assert.strictEqual(box['background-color'], 'rgb(245, 245, 245)');
  assert.strictEqual(box.color, undefined);
  assert.strictEqual(box['font-family'], undefined);
});

test('boxOf 丢掉 none / transparent / 0px，host 上不凭空长边框', () => {
  const box = B.boxOf(computed({
    'border-left-width': '0px',
    'border-left-style': 'none',
    'border-left-color': 'transparent',
    'background-color': 'transparent',
  }));
  assert.deepStrictEqual(box, {});
});

test('boxOf 只把四分量的零 alpha 当透明，半透明与三分量都保留', () => {
  assert.deepStrictEqual(B.boxOf(computed({ 'background-color': 'rgba(0, 0, 0, 0)' })), {});
  assert.strictEqual(
    B.boxOf(computed({ 'background-color': 'rgba(0, 0, 0, 0.5)' }))['background-color'],
    'rgba(0, 0, 0, 0.5)'
  );
  assert.strictEqual(
    B.boxOf(computed({ 'background-color': 'rgb(0, 0, 0)' }))['background-color'],
    'rgb(0, 0, 0)'
  );
});

test('boxOf 丢掉空串 / 非字符串，不让 undefined 写进行内样式', () => {
  const cs = computed({});
  cs.fontSize = '';
  cs.lineHeight = undefined;
  cs.fontWeight = 700;
  const box = B.boxOf(cs);
  assert.strictEqual(box['font-size'], undefined);
  assert.strictEqual(box['line-height'], undefined);
  assert.strictEqual(box['font-weight'], undefined);
});

test('boxOf 对 null / undefined / 空对象给空结果，不抛错', () => {
  assert.deepStrictEqual(B.boxOf(null), {});
  assert.deepStrictEqual(B.boxOf(undefined), {});
  assert.deepStrictEqual(B.boxOf({}), {});
});

test('PROPS 覆盖盒子四边与文字层，但不搬字体族与字色', () => {
  const names = B.PROPS.map(function (p) { return p[0]; });
  for (const k of ['margin-top', 'margin-bottom', 'padding-left', 'padding-right',
    'border-left-width', 'border-top-left-radius', 'background-color',
    'font-size', 'line-height', 'font-weight']) {
    assert.ok(names.indexOf(k) >= 0, k);
  }
  assert.strictEqual(names.indexOf('font-family'), -1);
  assert.strictEqual(names.indexOf('color'), -1);
});

test('classNameOf 只给 pre 品种类，大小写不敏感，其它标签给空串', () => {
  assert.strictEqual(B.classNameOf({ tagName: 'PRE' }), ' cm-rmd-code');
  assert.strictEqual(B.classNameOf({ tagName: 'pre' }), ' cm-rmd-code');
  assert.strictEqual(B.classNameOf({ tagName: 'P' }), '');
  assert.strictEqual(B.classNameOf({ tagName: 'PRE ' }), '');
  assert.strictEqual(B.classNameOf(null), '');
  assert.strictEqual(B.classNameOf({}), '');
});

test('headingLevelOf 认 h1–h6 的标签名，h7 / 非标题给 0', () => {
  assert.strictEqual(B.headingLevelOf({ tagName: 'H1' }), 1);
  assert.strictEqual(B.headingLevelOf({ tagName: 'h3' }), 3);
  assert.strictEqual(B.headingLevelOf({ tagName: 'H6' }), 6);
  assert.strictEqual(B.headingLevelOf({ tagName: 'H7' }), 0);
  assert.strictEqual(B.headingLevelOf({ tagName: 'DIV' }), 0);
  assert.strictEqual(B.headingLevelOf(null), 0);
  assert.strictEqual(B.headingLevelOf({ tagName: 1 }), 0);
});

test('applyBox 把 boxOf 的结果逐条写进 host.style', () => {
  const cs = computed({ 'font-size': '28px', 'margin-bottom': '15.4px' });
  const written = {};
  const host = { style: { setProperty: function (k, v) { written[k] = v; } } };
  W.getComputedStyle = function () {
    return cs;
  };
  try {
    B.applyBox(host, {});
  } finally {
    delete W.getComputedStyle;
  }
  assert.strictEqual(written['font-size'], '28px');
  assert.strictEqual(written['margin-bottom'], '15.4px');
});

test('applyBox 在缺 host / el / getComputedStyle 时安静跳过', () => {
  const written = {};
  const host = { style: { setProperty: function (k, v) { written[k] = v; } } };
  assert.doesNotThrow(function () { B.applyBox(null, {}); });
  assert.doesNotThrow(function () { B.applyBox(host, null); });
  assert.doesNotThrow(function () { B.applyBox({}, {}); });
  assert.deepStrictEqual(written, {});
});
