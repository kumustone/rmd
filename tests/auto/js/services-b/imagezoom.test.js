// imagezoom 的自动化用例（`tests/auto/js/services-b/`）。
//
// 覆盖：预览源白名单、比例夹取（恒为正有限数）、适应/初始的区分、
// 焦点缩放锚点、平移夹取、resize 五步顺序、轮盘倍率、比例文字与标题。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load() {
  const win = {};
  for (const rel of ['src/services/i18n.js', 'src/services/imagezoom.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    new Function('window', src)(win);
  }
  return { win: win, I: win.rmd.i18n, Z: win.rmd.imagezoom };
}

const { I, Z } = load();

test('常量：留白 24、步长 1.25、绝对下界 1/64、上限 8', () => {
  assert.strictEqual(Z.FIT_PAD, 24);
  assert.strictEqual(Z.ZOOM_STEP, 1.25);
  assert.strictEqual(Z.MIN_SCALE, 1 / 64);
  assert.strictEqual(Z.MAX_SCALE, 8);
  assert.strictEqual(Z.WHEEL_K, 0.002);
  assert.strictEqual(Z.WHEEL_CLAMP, 1.5);
});

test('isPreviewableSrc：只认 data:image/…', () => {
  assert.strictEqual(Z.isPreviewableSrc('data:image/png;base64,AAA'), true);
  assert.strictEqual(Z.isPreviewableSrc('DATA:IMAGE/SVG+XML,<svg/>'), true);
  assert.strictEqual(Z.isPreviewableSrc('  data:image/jpeg;base64,AAA  '), true);
});

test('isPreviewableSrc：远程 / 协议相对 / blob / 非图片 data 一律拒绝', () => {
  assert.strictEqual(Z.isPreviewableSrc('https://example.com/a.png'), false);
  assert.strictEqual(Z.isPreviewableSrc('//example.com/a.png'), false);
  assert.strictEqual(Z.isPreviewableSrc('blob:https://x/1'), false);
  assert.strictEqual(Z.isPreviewableSrc('data:text/html,<b>x</b>'), false);
  assert.strictEqual(Z.isPreviewableSrc(''), false);
  assert.strictEqual(Z.isPreviewableSrc(null), false);
});

test('clampScale：非有限数落到 MIN_SCALE，越界夹到绝对上下界', () => {
  assert.strictEqual(Z.clampScale(NaN), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(Infinity), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(-Infinity), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(0), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(-1), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(100), Z.MAX_SCALE);
  assert.strictEqual(Z.clampScale(1), 1);
});

test('fitScale：扣掉四边留白后取较小的那个方向', () => {
  assert.strictEqual(Z.fitScale(1000, 500, 548, 548, 24), 0.5);
});

test('fitScale：小图的适应比例可以大于 1（封顶由调用方决定）', () => {
  assert.strictEqual(Z.fitScale(100, 100, 548, 548, 24), 5);
});

test('fitScale：舞台比两倍留白还小时返回 MIN_SCALE 而不是负数/0', () => {
  assert.strictEqual(Z.fitScale(100, 100, 40, 548, 24), Z.MIN_SCALE);
});

test('fitScale：自然尺寸无效时给中性的 1', () => {
  assert.strictEqual(Z.fitScale(0, 100, 548, 548, 24), 1);
});

test('fitScale：非法 pad 退回默认 24', () => {
  assert.strictEqual(Z.fitScale(1000, 1000, 548, 548, 'x'), 0.5);
});

test('initialScale：大图缩到适应，小图保持 100%', () => {
  assert.strictEqual(Z.initialScale(1000, 1000, 548, 548, 24), 0.5);
  assert.strictEqual(Z.initialScale(100, 100, 548, 548, 24), 1);
});

test('makeState：大图 mode=fit、比例=适应、平移居中', () => {
  const st = Z.makeState(1000, 1000, 500, 500, 0);
  assert.strictEqual(st.fit, 0.5);
  assert.strictEqual(st.initial, 0.5);
  assert.strictEqual(st.scale, 0.5);
  assert.strictEqual(st.mode, 'fit');
  assert.strictEqual(st.tx, 0);
  assert.strictEqual(st.ty, 0);
  assert.strictEqual(st.min, Z.MIN_SCALE);
  assert.strictEqual(st.max, Z.MAX_SCALE);
});

test('makeState：小图 mode=manual、初始 100%、平移居中', () => {
  const st = Z.makeState(100, 100, 500, 500, 0);
  assert.strictEqual(st.fit, 5);
  assert.strictEqual(st.initial, 1);
  assert.strictEqual(st.scale, 1);
  assert.strictEqual(st.mode, 'manual');
  assert.strictEqual(st.tx, 200);
  assert.strictEqual(st.ty, 200);
});

test('clampPan：比舞台小的维度总是居中', () => {
  const st = { nw: 100, nh: 100, sw: 500, sh: 500, scale: 1, tx: 999, ty: -999, mode: 'fit' };
  const p = Z.clampPan(st);
  assert.strictEqual(p.tx, 200);
  assert.strictEqual(p.ty, 200);
  assert.strictEqual(p.mode, 'fit');
});

test('clampPan：比舞台大的维度夹在 [sw-w, 0]，不露空白带', () => {
  const st = { nw: 1000, nh: 1000, sw: 500, sh: 500, scale: 1, tx: 100, ty: -999, mode: 'manual' };
  const p = Z.clampPan(st);
  assert.strictEqual(p.tx, 0);
  assert.strictEqual(p.ty, -500);
  assert.strictEqual(p.mode, 'manual');
});

test('clampPan：非有限平移量按 0 处理', () => {
  const st = { nw: 1000, nh: 1000, sw: 500, sh: 500, scale: 1, tx: NaN, ty: undefined, mode: 'fit' };
  assert.strictEqual(Z.clampPan(st).tx, 0);
  assert.strictEqual(Z.clampPan(st).ty, 0);
});

test('zoomAt：锚点下的图像坐标缩放前后不变', () => {
  const st = Z.makeState(1000, 1000, 500, 500, 0);
  const next = Z.zoomAt(st, 2, 250, 250);
  const before = (250 - st.tx) / st.scale;
  const after = (250 - next.tx) / next.scale;
  assert.strictEqual(next.scale, 1);
  assert.strictEqual(next.mode, 'manual');
  assert.ok(Math.abs(before - after) < 1e-9);
});

test('zoomAt：非法倍率不改比例，但已进入 manual', () => {
  const st = Z.makeState(1000, 1000, 500, 500, 0);
  const next = Z.zoomAt(st, NaN, 250, 250);
  assert.strictEqual(next.scale, st.scale);
  assert.strictEqual(next.mode, 'manual');
});

test('zoomAt：倍率被绝对上限夹住', () => {
  const st = { nw: 1000, nh: 1000, sw: 500, sh: 500, pad: 0, fit: 0.5, initial: 0.5,
    min: Z.MIN_SCALE, max: Z.MAX_SCALE, scale: 8, tx: 0, ty: 0, mode: 'manual' };
  assert.strictEqual(Z.zoomAt(st, 2, 0, 0).scale, 8);
});

test('zoomTo：绝对目标也走同一套夹取', () => {
  const st = Z.makeState(1000, 1000, 500, 500, 0);
  assert.strictEqual(Z.zoomTo(st, 2, 250, 250).scale, 2);
  assert.strictEqual(Z.zoomTo(st, 100, 250, 250).scale, 8);
});

test('fitTo：小图也会被放大到铺满，且 mode=fit', () => {
  const st = Z.makeState(100, 100, 500, 500, 0);
  const fit = Z.fitTo(st);
  assert.strictEqual(fit.scale, 5);
  assert.strictEqual(fit.mode, 'fit');
});

test('panBy：只夹平移量，不改 mode', () => {
  const st = { nw: 1000, nh: 1000, sw: 500, sh: 500, pad: 0, fit: 0.5, initial: 0.5,
    min: Z.MIN_SCALE, max: Z.MAX_SCALE, scale: 1, tx: 0, ty: 0, mode: 'fit' };
  const p = Z.panBy(st, -100, -100);
  assert.strictEqual(p.tx, -100);
  assert.strictEqual(p.ty, -100);
  assert.strictEqual(p.mode, 'fit');
  const q = Z.panBy(st, NaN, NaN);
  assert.strictEqual(q.tx, 0);
  assert.strictEqual(q.ty, 0);
});

test('resizeState：退化舞台（0 宽或 0 高）原样返回', () => {
  const st = Z.makeState(1000, 1000, 500, 500, 0);
  assert.strictEqual(Z.resizeState(st, 0, 100), st);
  assert.strictEqual(Z.resizeState(st, 100, 0), st);
});

test('resizeState：mode=fit 时精确跟随新的适应比例', () => {
  const st = Z.makeState(1000, 1000, 500, 500, 0);
  const next = Z.resizeState(st, 1000, 1000);
  assert.strictEqual(next.fit, 1);
  assert.strictEqual(next.scale, 1);
  assert.strictEqual(next.mode, 'fit');
  assert.strictEqual(next.sw, 1000);
});

test('resizeState：mode=manual 时用户比例不被新 fit 顶走', () => {
  const st = Z.makeState(100, 100, 500, 500, 0);
  const next = Z.resizeState(st, 800, 800);
  assert.strictEqual(next.fit, 8);
  assert.strictEqual(next.scale, 1, 'manual 模式下必须保持用户选的比例');
});

test('resizeState：manual 的越界比例只被绝对上下界夹', () => {
  const st = { nw: 100, nh: 100, sw: 500, sh: 500, pad: 0, fit: 5, initial: 1,
    min: Z.MIN_SCALE, max: Z.MAX_SCALE, scale: 20, tx: 0, ty: 0, mode: 'manual' };
  assert.strictEqual(Z.resizeState(st, 1000, 1000).scale, 8);
});

test('resizeState：总是重算 fit 与 initial', () => {
  const st = Z.makeState(1000, 1000, 500, 500, 0);
  const next = Z.resizeState(st, 1000, 1000);
  assert.strictEqual(next.initial, 1);
  assert.strictEqual(next.fit, 1);
});

test('wheelFactor：deltaY=0 是 no-op，正负方向正确', () => {
  assert.strictEqual(Z.wheelFactor(0), 1);
  assert.ok(Z.wheelFactor(100) < 1);
  assert.ok(Z.wheelFactor(-100) > 1);
  assert.strictEqual(Z.wheelFactor(NaN), 1);
});

test('wheelFactor：单次事件的倍率被 1.5 夹住', () => {
  assert.strictEqual(Z.wheelFactor(-10000), 1.5);
  assert.strictEqual(Z.wheelFactor(10000), 1 / 1.5);
});

test('scaleLabel：按百分比取整，非法值落到 MIN_SCALE', () => {
  assert.strictEqual(Z.scaleLabel(0.5), '50%');
  assert.strictEqual(Z.scaleLabel(8), '800%');
  assert.strictEqual(Z.scaleLabel(0), '0%');
  assert.strictEqual(Z.scaleLabel(NaN), '2%');
  assert.strictEqual(Z.scaleLabel(Infinity), '2%');
});

test('toTransform：格式逐字固定', () => {
  assert.strictEqual(
    Z.toTransform({ tx: -10, ty: 20, scale: 0.5 }),
    'translate(-10px, 20px) scale(0.5)'
  );
});

test('captionFor：alt 优先，其次真实路径的 basename，都没有才用兜底文案', () => {
  assert.strictEqual(Z.captionFor('  图注  ', '/a/b.md'), '图注');
  assert.strictEqual(Z.captionFor('', '/a/b.md'), 'b.md');
  assert.strictEqual(Z.captionFor('', 'C:\\dir\\x.png'), 'x.png');
  assert.strictEqual(Z.captionFor('', '   '), '图片预览');
});

test('captionFor：兜底文案跟随界面语言', () => {
  I.setLang('en');
  try {
    assert.strictEqual(Z.captionFor('', ''), 'Image preview');
  } finally {
    I.setLang('zh');
  }
});
