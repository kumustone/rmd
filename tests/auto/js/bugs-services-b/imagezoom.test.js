// imagezoom 的缺陷回归用例（`tests/auto/js/bugs-services-b/`）。
//
// 覆盖：`0068` 的"二倍图打开不该被放大"、比例恒为正有限数、
// 缩放锚点不动、平移夹取、resize 五步顺序与轮盘倍率边界。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'imagezoom.js'), 'utf8');

function loadZoom(win) {
  const w = win || {};
  new Function('window', SRC)(w);
  return w.rmd.imagezoom;
}

const Z = loadZoom();

/** 手搓一份不在边界上的状态，便于精确算锚点。 */
function st(over) {
  return Object.assign({
    nw: 1000, nh: 1000, sw: 500, sh: 500, pad: 24,
    fit: 0.5, initial: 0.5, min: Z.MIN_SCALE, max: Z.MAX_SCALE,
    scale: 1, tx: -100, ty: -100, mode: 'manual',
  }, over || {});
}

// ── 常量 ────────────────────────────────────────────────────────────

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('留白 24、步长 1.25、绝对下界 1/64、绝对上限 8 逐字锁死', () => {
  assert.strictEqual(Z.FIT_PAD, 24);
  assert.strictEqual(Z.ZOOM_STEP, 1.25);
  assert.strictEqual(Z.MIN_SCALE, 1 / 64);
  assert.strictEqual(Z.MAX_SCALE, 8);
  assert.strictEqual(Z.WHEEL_K, 0.002);
  assert.strictEqual(Z.WHEEL_CLAMP, 1.5);
});

// ── 可预览来源：只认 data:image/ ───────────────────────────────────

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('isPreviewableSrc：data:image/ 各种 MIME 都收，大小写与首尾空白不影响', () => {
  assert.strictEqual(Z.isPreviewableSrc('data:image/png;base64,AAA'), true);
  assert.strictEqual(Z.isPreviewableSrc('DATA:IMAGE/JPEG;base64,AAA'), true);
  assert.strictEqual(Z.isPreviewableSrc('  data:image/svg+xml;utf8,<svg/>  '), true);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('isPreviewableSrc：远程 URL / blob / 非图片 data 一律拒绝（⛔ 预览不许偷偷联网）', () => {
  assert.strictEqual(Z.isPreviewableSrc('https://example.com/a.png'), false);
  assert.strictEqual(Z.isPreviewableSrc('http://example.com/a.png'), false);
  assert.strictEqual(Z.isPreviewableSrc('//cdn.example.com/a.png'), false);
  assert.strictEqual(Z.isPreviewableSrc('blob:http://localhost/abc'), false);
  assert.strictEqual(Z.isPreviewableSrc('file:///tmp/a.png'), false);
  assert.strictEqual(Z.isPreviewableSrc('data:text/html,<b>x</b>'), false);
  assert.strictEqual(Z.isPreviewableSrc('data:application/pdf;base64,AAA'), false);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('isPreviewableSrc：空值 / null / undefined 都是 false，⛔ 不抛', () => {
  assert.strictEqual(Z.isPreviewableSrc(''), false);
  assert.strictEqual(Z.isPreviewableSrc('   '), false);
  assert.strictEqual(Z.isPreviewableSrc(null), false);
  assert.strictEqual(Z.isPreviewableSrc(undefined), false);
});

// ── clampScale：恒为正有限数 ───────────────────────────────────────

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('clampScale：区间内原样，两端包含边界', () => {
  assert.strictEqual(Z.clampScale(1), 1);
  assert.strictEqual(Z.clampScale(Z.MIN_SCALE), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(Z.MAX_SCALE), Z.MAX_SCALE);
  assert.strictEqual(Z.clampScale(2.5), 2.5);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('clampScale：0 与负数落到绝对下界，超上限落到 8', () => {
  assert.strictEqual(Z.clampScale(0), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(-3), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(Z.MIN_SCALE / 2), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(9), Z.MAX_SCALE);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('clampScale：NaN 与 ±Infinity 都落到 MIN_SCALE，⛔ 不返回 NaN/0', () => {
  assert.strictEqual(Z.clampScale(NaN), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(Infinity), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(-Infinity), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(undefined), Z.MIN_SCALE);
  // ⚠️ 疑似缺陷：Infinity 语义上像"无穷大"，这里却落到下界；
  // 钉住现状，避免改实现时无声改变用户可见行为。
  assert.strictEqual(Z.clampScale(Infinity), Z.MIN_SCALE);
});

// ── fitScale：适应窗口的数学 ──────────────────────────────────────

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('fitScale：取宽高两个方向的较小比例（扣掉四边留白）', () => {
  // 800×600 舞台、留白 24 ⇒ 可用 752×552
  assert.strictEqual(Z.fitScale(1000, 500, 800, 600), Math.min(752 / 1000, 552 / 500));
  assert.strictEqual(Z.fitScale(2000, 1000, 800, 600), 752 / 2000);
  assert.strictEqual(Z.fitScale(500, 1000, 800, 600), 552 / 1000);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('fitScale：小图会得到 > 1 的比例（是否放大由调用方决定）', () => {
  const f = Z.fitScale(100, 100, 800, 600);
  assert.ok(f > 1, '实际 ' + f);
  assert.strictEqual(f, Math.min(752 / 100, 552 / 100));
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('fitScale：舞台比两倍留白还小时返回 MIN_SCALE，⛔ 不返回 0/负数/NaN', () => {
  assert.strictEqual(Z.fitScale(100, 100, 48, 600), Z.MIN_SCALE);
  assert.strictEqual(Z.fitScale(100, 100, 800, 48), Z.MIN_SCALE);
  assert.strictEqual(Z.fitScale(100, 100, 10, 10), Z.MIN_SCALE);
  assert.strictEqual(Z.fitScale(100, 100, 0, 0), Z.MIN_SCALE);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('fitScale：自然尺寸无效时返回中性的 1', () => {
  assert.strictEqual(Z.fitScale(0, 100, 800, 600), 1);
  assert.strictEqual(Z.fitScale(100, 0, 800, 600), 1);
  assert.strictEqual(Z.fitScale(NaN, 100, 800, 600), 1);
  assert.strictEqual(Z.fitScale(-5, 100, 800, 600), 1);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('fitScale：pad 非法时退回 24，pad=0 时可用区就是整块舞台', () => {
  assert.strictEqual(Z.fitScale(1000, 1000, 800, 600, NaN), Z.fitScale(1000, 1000, 800, 600, 24));
  assert.strictEqual(Z.fitScale(1000, 1000, 800, 600, 0), Math.min(0.8, 0.6));
});

// ── initialScale：二倍图不该被放大 ────────────────────────────────

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('initialScale：大图取 fit，小图封顶在 100%', () => {
  assert.strictEqual(Z.initialScale(2000, 1000, 800, 600), 752 / 2000);
  assert.strictEqual(Z.initialScale(100, 100, 800, 600), 1);
  assert.strictEqual(Z.initialScale(100, 100, 800, 600), 1, '⛔ 打开时不许把小学放大');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('initialScale：始终是正有限数，舞台退化也不抛', () => {
  const v = Z.initialScale(100, 100, 0, 0);
  assert.ok(Number.isFinite(v) && v > 0, String(v));
  assert.strictEqual(v, Z.MIN_SCALE);
});

// ── makeState ──────────────────────────────────────────────────────

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('makeState：大图进 fit 模式，小图进 manual 模式（resize 语义不同）', () => {
  const big = Z.makeState(2000, 1000, 800, 600);
  assert.strictEqual(big.mode, 'fit');
  assert.strictEqual(big.scale, big.fit);
  const small = Z.makeState(100, 100, 800, 600);
  assert.strictEqual(small.mode, 'manual');
  assert.strictEqual(small.scale, 1);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('makeState：图像比舞台小的那一维居中，大的那维贴边', () => {
  const s = Z.makeState(100, 50, 800, 600);
  assert.strictEqual(s.scale, 1);
  assert.strictEqual(s.tx, (800 - 100) / 2);
  assert.strictEqual(s.ty, (600 - 50) / 2);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('makeState：min/max 是绝对常量，不跟着 fit 漂', () => {
  const s = Z.makeState(100, 100, 800, 600);
  assert.strictEqual(s.min, Z.MIN_SCALE);
  assert.strictEqual(s.max, Z.MAX_SCALE);
  assert.strictEqual(s.fit, Z.fitScale(100, 100, 800, 600));
});

// ── clampPan：小图居中、大图贴边 ───────────────────────────────────

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('clampPan：缩放后比舞台小的维度强制居中，忽略传入的 tx/ty', () => {
  const s = Z.clampPan(st({ nw: 100, nh: 100, sw: 500, sh: 500, scale: 1, tx: -999, ty: 999 }));
  assert.strictEqual(s.tx, 200);
  assert.strictEqual(s.ty, 200);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('clampPan：比舞台大的维度夹在 [sw-w, 0]，不露出空白带', () => {
  const base = st({ nw: 1000, nh: 1000, sw: 500, sh: 500, scale: 1 });
  assert.strictEqual(Z.clampPan(Object.assign({}, base, { tx: -100, ty: -100 })).tx, -100);
  assert.strictEqual(Z.clampPan(Object.assign({}, base, { tx: 50, ty: 50 })).tx, 0);
  assert.strictEqual(Z.clampPan(Object.assign({}, base, { tx: -9999, ty: -9999 })).tx, -500);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('clampPan：非有限的 tx/ty 归零后再夹；mode 原样保留', () => {
  const out = Z.clampPan(st({ nw: 1000, nh: 1000, tx: NaN, ty: Infinity, mode: 'fit' }));
  assert.strictEqual(out.tx, 0);
  assert.strictEqual(out.ty, 0);
  assert.strictEqual(out.mode, 'fit');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('clampPan：返回新对象，不改输入', () => {
  const input = st({ tx: -100, ty: -100 });
  const out = Z.clampPan(input);
  assert.notStrictEqual(out, input);
  assert.strictEqual(input.tx, -100);
});

// ── zoomAt：锚点下的图像不动 ──────────────────────────────────────

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('zoomAt：锚点处的图像坐标缩放前后严格相等', () => {
  const s = st();
  const px = 250;
  const py = 250;
  const beforeX = (px - s.tx) / s.scale;
  const beforeY = (py - s.ty) / s.scale;
  const out = Z.zoomAt(s, 2, px, py);
  assert.strictEqual((px - out.tx) / out.scale, beforeX);
  assert.strictEqual((py - out.ty) / out.scale, beforeY);
  assert.strictEqual(out.scale, 2);
  assert.strictEqual(out.mode, 'manual');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('zoomAt：非法倍率（0 / 负 / NaN / Infinity）保持比例，但仍标记 manual', () => {
  const s = st();
  for (const f of [0, -1, NaN, Infinity, 'x']) {
    const out = Z.zoomAt(s, f, 100, 100);
    assert.strictEqual(out.scale, 1, '倍率 ' + String(f));
  }
  assert.strictEqual(Z.zoomAt(s, 0, 100, 100).mode, 'manual');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('zoomAt：结果比例被绝对上下界夹住（8 封顶、1/64 托底）', () => {
  const big = st({ scale: 6, nw: 10000, nh: 10000, tx: 0, ty: 0 });
  assert.strictEqual(Z.zoomAt(big, 4, 250, 250).scale, Z.MAX_SCALE);
  const tiny = st({ scale: 0.02, tx: 0, ty: 0 });
  assert.strictEqual(Z.zoomAt(tiny, 0.1, 250, 250).scale, Z.MIN_SCALE);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('zoomAt：锚点坐标非有限时以舞台中心为锚', () => {
  const s = st();
  const a = Z.zoomAt(s, 2, NaN, null);
  const b = Z.zoomAt(s, 2, s.sw / 2, s.sh / 2);
  assert.strictEqual(a.tx, b.tx);
  assert.strictEqual(a.ty, b.ty);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('zoomTo：绝对目标比例，100% 与 200% 都能精确落位', () => {
  const s = st({ scale: 0.5, tx: 0, ty: 0, nw: 4000, nh: 4000 });
  assert.strictEqual(Z.zoomTo(s, 1, 250, 250).scale, 1);
  assert.strictEqual(Z.zoomTo(s, 2, 250, 250).scale, 2);
  assert.strictEqual(Z.zoomTo(s, 100, 250, 250).scale, Z.MAX_SCALE);
  assert.strictEqual(Z.zoomTo(s, 0, 250, 250).scale, Z.MIN_SCALE);
});

// ── fitTo / panBy ─────────────────────────────────────────────────

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('fitTo：小图也被放大到铺满（「适应」按钮与打开时的 initial 语义不同）', () => {
  const s = Z.makeState(100, 100, 800, 600);
  assert.strictEqual(s.scale, 1);
  const out = Z.fitTo(s);
  assert.ok(out.scale > 1, String(out.scale));
  assert.strictEqual(out.scale, s.fit);
  assert.strictEqual(out.mode, 'fit');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('panBy：位移累加后夹取，mode 不因拖动改变', () => {
  const s = st({ tx: -100, ty: -100, mode: 'fit' });
  const out = Z.panBy(s, -50, 20);
  assert.strictEqual(out.tx, -150);
  assert.strictEqual(out.ty, -80);
  assert.strictEqual(out.mode, 'fit');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('panBy：非有限位移当作 0，不污染状态', () => {
  const s = st({ tx: -100, ty: -100 });
  const out = Z.panBy(s, NaN, undefined);
  assert.strictEqual(out.tx, -100);
  assert.strictEqual(out.ty, -100);
});

// ── resizeState：五步顺序 ─────────────────────────────────────────

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('resizeState：退化舞台（0×0 / 负数）原样返回，⛔ 不把比例算成 MIN_SCALE', () => {
  const s = st({ scale: 0.75 });
  assert.strictEqual(Z.resizeState(s, 0, 600), s);
  assert.strictEqual(Z.resizeState(s, 800, 0), s);
  assert.strictEqual(Z.resizeState(s, -1, -1), s);
  assert.strictEqual(Z.resizeState(s, NaN, 600), s);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('resizeState：fit 模式精确跟随新的 fit', () => {
  const s = Z.makeState(2000, 1000, 800, 600);
  const out = Z.resizeState(s, 1600, 1200);
  assert.strictEqual(out.mode, 'fit');
  assert.strictEqual(out.scale, out.fit);
  assert.strictEqual(out.fit, Z.fitScale(2000, 1000, 1600, 1200));
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('resizeState：manual 模式保持用户比例，只被绝对界夹', () => {
  const s = st({ mode: 'manual', scale: 2, fit: 5, tx: 0, ty: 0 });
  const out = Z.resizeState(s, 4000, 4000);
  assert.strictEqual(out.scale, 2, '窗口变大不许把用户比例顶到新的 fit');
  assert.ok(out.fit > 2);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('resizeState：manual 模式的越界比例仍被 8 / 1/64 夹住', () => {
  const s = st({ mode: 'manual', scale: 99 });
  assert.strictEqual(Z.resizeState(s, 500, 500).scale, Z.MAX_SCALE);
  const t = st({ mode: 'manual', scale: 0.00001 });
  assert.strictEqual(Z.resizeState(t, 500, 500).scale, Z.MIN_SCALE);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('resizeState：重算 initial 与 fit，并按新舞台重新夹平移', () => {
  const s = st({ nw: 100, nh: 100, sw: 500, sh: 500, scale: 1, tx: -999, ty: -999, mode: 'manual' });
  const out = Z.resizeState(s, 800, 600);
  assert.strictEqual(out.initial, 1);
  assert.strictEqual(out.fit, Z.fitScale(100, 100, 800, 600));
  assert.strictEqual(out.tx, (800 - 100) / 2);
  assert.strictEqual(out.ty, (600 - 100) / 2);
});

// ── wheelFactor / 标签 / transform ────────────────────────────────

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('wheelFactor：向上滚放大、向下滚缩小，deltaY=0 是 no-op', () => {
  assert.strictEqual(Z.wheelFactor(0), 1);
  assert.ok(Z.wheelFactor(-100) > 1);
  assert.ok(Z.wheelFactor(100) < 1);
  assert.ok(Math.abs(Z.wheelFactor(-100) * Z.wheelFactor(100) - 1) < 1e-12);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('wheelFactor：单次事件倍率夹在 1/1.5 ~ 1.5，⛔ 一次猛划不会把图甩没', () => {
  assert.strictEqual(Z.wheelFactor(-10000), Z.WHEEL_CLAMP);
  assert.strictEqual(Z.wheelFactor(10000), 1 / Z.WHEEL_CLAMP);
  assert.ok(Z.wheelFactor(-10000) <= 1.5);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('wheelFactor：非有限 deltaY 当作 0', () => {
  assert.strictEqual(Z.wheelFactor(NaN), 1);
  assert.strictEqual(Z.wheelFactor(Infinity), 1);
  assert.strictEqual(Z.wheelFactor('abc'), 1);
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('scaleLabel：四舍五入到整数百分比', () => {
  assert.strictEqual(Z.scaleLabel(1), '100%');
  assert.strictEqual(Z.scaleLabel(0.5), '50%');
  assert.strictEqual(Z.scaleLabel(0.333), '33%');
  assert.strictEqual(Z.scaleLabel(0.336), '34%');
  assert.strictEqual(Z.scaleLabel(8), '800%');
  assert.strictEqual(Z.scaleLabel(Z.MIN_SCALE), '2%');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('scaleLabel：NaN / 非数字退回 MIN_SCALE 的标签，⛔ 不显示 NaN%', () => {
  assert.strictEqual(Z.scaleLabel(NaN), '2%');
  assert.strictEqual(Z.scaleLabel(undefined), '2%');
  assert.strictEqual(Z.scaleLabel('0.5'), '50%');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('toTransform：格式被逐字钉着', () => {
  assert.strictEqual(
    Z.toTransform({ tx: -12.5, ty: 3, scale: 1.25 }),
    'translate(-12.5px, 3px) scale(1.25)'
  );
});

// ── captionFor：alt 优先，路径取 basename ─────────────────────────

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('captionFor：alt 去掉首尾空白后优先', () => {
  assert.strictEqual(Z.captionFor('  架构图  ', '/tmp/a.png'), '架构图');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('captionFor：没有 alt 时取路径 basename，正斜杠与反斜杠都认', () => {
  assert.strictEqual(Z.captionFor('', '/Users/example/docs/a.png'), 'a.png');
  assert.strictEqual(Z.captionFor(null, 'C:\\Users\\liubo\\a.png'), 'a.png');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('captionFor：路径含空格也原样取 basename', () => {
  assert.strictEqual(Z.captionFor('', '/tmp/my docs/二倍图 1.png'), '二倍图 1.png');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('captionFor：alt 与路径都没有时走 i18n 兜底键', () => {
  // 不注入 i18n 时 t() 原样返回键名
  assert.strictEqual(Z.captionFor('', ''), 'viewer.label');
  assert.strictEqual(Z.captionFor('   ', '   '), 'viewer.label');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('captionFor：路径以分隔符结尾、取不到 basename 时也走兜底', () => {
  assert.strictEqual(Z.captionFor('', '/tmp/docs/'), 'viewer.label');
  assert.strictEqual(Z.captionFor('', 'no-slash-name.txt'), 'no-slash-name.txt');
});

// 源自 docs/bugs/0068（正文图片按像素尺寸显示导致二倍图偏大）
test('captionFor：注入了 i18n 就用它的译文', () => {
  const win = { rmd: { i18n: { t: function (k) { return k === 'viewer.label' ? '图片预览' : k; } } } };
  const Z2 = loadZoom(win);
  assert.strictEqual(Z2.captionFor('', ''), '图片预览');
});
