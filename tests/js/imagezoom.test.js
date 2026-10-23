// 图片缩放预览的断言（`src/services/imagezoom.js` ＋ `src/components/ImageViewer.js`，
// `design/0018-图片缩放预览.md` §7.2/§7.3）。**42 条**，分两层：
//
// | 层 | 守什么 | 条数 |
// |---|---|---|
// | ⭐ **纯逻辑**（拟合 / 初始 / 夹取 / 焦点缩放 / resize / 轮盘 / 文案） | §7.2 第 1–30 条 | 30 |
// | ⭐⭐ **源码级闸门**（`index.html` 顺序 / 标记只在一支 / 监听成对 / inert 只摘自己的 …） | §7.3 第 31–42 条 | 12 |
//
// ⚠️ 它们守的**不是"算得对不对"这一件事**，是四类**不会报错**的错（该设计 §6 开头那四条）：
//    ① 预览改了文档 ② 预览偷偷联网 ③ 预览碰了滚动位置 ④ 预览吞错默认动作 / 什么都没挡。
//    ⭐ 四类的共同点是**屏幕上没有异常信息**——只有"按钮按不动""背景被翻了一页"这种体感。
//
// ⚠️ ⛔ **真 DOM 那半这里到不了**：本文件跑在 node 里，没有 `document`、没有 `getBoundingClientRect`。
//    点击 / 键盘分层 / 背景隔离 / resize 的真行为由离屏探针 `make probe-image-viewer` 兜底
//    （§7.4 那 25 条）；⚠️ 而 §7.3 那 12 条**只有**这里能自动守——它们问的是**源码的形状**。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

// ⚠️ 两个模块都是给浏览器用的经典脚本（IIFE 挂 `window.rmd`），
//    但也都留了 CommonJS 出口 ⇒ node 里直接 `require` 拿到的是同一份 api。
const Z = require(path.join(SRC, 'services', 'imagezoom.js'));
const IV = require(path.join(SRC, 'components', 'ImageViewer.js'));

// ────────────────────────────────────────────────────────────────
// 夹具：读源码 / 剥注释 / 取顺序
// ────────────────────────────────────────────────────────────────

/**
 * 把注释**挖成空格**（⛔ 不是删掉）——行号必须与原文一一对应。
 * ⚠️ 与 `keymap.test.js` 那份同一个理由：注释里写一句 `#preview-bar 在 .topbar 内`
 *    是**文档**，⛔ 不是第二份实现；被管的只有**代码**。
 */
function 剥注释(text, isHtml) {
  let s = text;
  if (isHtml) s = s.replace(/<!--[\s\S]*?-->/g, function (m) { return m.replace(/[^\n]/g, ' '); });
  let out = '';
  let i = 0;
  let q = null;
  function blank(from, to) { out += s.slice(from, to).replace(/[^\n]/g, ' '); }
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && n === '*') {
      const e = s.indexOf('*/', i + 2);
      const end = e < 0 ? s.length : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && n === '/') {
      const e = s.indexOf('\n', i);
      const end = e < 0 ? s.length : e;
      blank(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function 读源码(rel) { return fs.readFileSync(path.join(SRC, rel), 'utf8'); }
function 代码(rel, isHtml) { return 剥注释(读源码(rel), isHtml); }

/** `index.html` 里 `<script src>` 的出现顺序。 */
function 脚本顺序() {
  const html = 代码('index.html', true);
  const out = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/** `index.html` 里 `<link href>` 的出现顺序。 */
function 样式顺序() {
  const html = 代码('index.html', true);
  const out = [];
  const re = /<link\b[^>]*\bhref\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/** 数一个子串在代码里出现几次。 */
function 次数(code, sub) { return code.split(sub).length - 1; }

// ────────────────────────────────────────────────────────────────
// §7.2 纯逻辑（第 1–30 条）
// ────────────────────────────────────────────────────────────────

test('1 `isPreviewableSrc`：`data:image/…` 为真，且**大小写不敏感**', function () {
  assert.strictEqual(Z.isPreviewableSrc('data:image/png;base64,iVBORw0KGgo='), true);
  assert.strictEqual(Z.isPreviewableSrc('DATA:IMAGE/SVG+XML,<svg/>'), true);
  assert.strictEqual(Z.isPreviewableSrc('  data:image/jpeg;base64,AAA  '), true);
});

test('2 `isPreviewableSrc`：远程 / 协议相对 / blob / 非图片 data / 空串 ⇒ 一律假', function () {
  assert.strictEqual(Z.isPreviewableSrc('https://example.com/a.png'), false);
  assert.strictEqual(Z.isPreviewableSrc('//example.com/a.png'), false);
  assert.strictEqual(Z.isPreviewableSrc('blob:https://x/1234'), false);
  assert.strictEqual(Z.isPreviewableSrc('data:text/html,<b>x</b>'), false);
  assert.strictEqual(Z.isPreviewableSrc(''), false);
  assert.strictEqual(Z.isPreviewableSrc(null), false);
  assert.strictEqual(Z.isPreviewableSrc(undefined), false);
});

test('3 `fitScale(2000,1000,800,600,24)` = min(752/2000, 552/1000) = 0.376', function () {
  const v = Z.fitScale(2000, 1000, 800, 600, 24);
  assert.ok(Math.abs(v - 0.376) < 1e-12, '实际 ' + v);
});

test('4 ⚠️ `fitScale(100,100,800,600,24)`：**函数本身不封顶**（设计写 3，公式是 5.52）', function () {
  const v = Z.fitScale(100, 100, 800, 600, 24);
  // ⚠️ `design/0018` §7.2 第 4 行写的是 `= 3`，而 §2.2 的公式给出 `min(752/100, 552/100) = 5.52`
  //    ——第 3 条（0.376）正是按同一个公式算出来的，两条互相矛盾。
  //    ⭐ 这里按**公式**断言：承重的那句话是"函数本身不封顶"，5.52 与 3 都满足它。
  //    ⚠️ 差异已登记在 `design/0018` §10（不是偷偷改判据）。
  assert.ok(Math.abs(v - 5.52) < 1e-12, '实际 ' + v);
  assert.ok(v > 1, '⛔ 封顶到 1 的话「小图也能铺满」这条语义就没了');
});

test('5 `initialScale(100,100,800,600,24)` = 1（小图不放大）', function () {
  assert.strictEqual(Z.initialScale(100, 100, 800, 600, 24), 1);
});

test('6 `initialScale(4000,3000,800,600,24)` = `fitScale`（大图适应）', function () {
  assert.strictEqual(
    Z.initialScale(4000, 3000, 800, 600, 24),
    Z.fitScale(4000, 3000, 800, 600, 24)
  );
});

test('7 ⭐ `makeState` 的 `min === MIN_SCALE`（⛔ 不是 `initial`）、`max === 8`、初始 `scale === initial`', function () {
  const st = Z.makeState(4000, 3000, 800, 600, 24);
  // ⭐ 评审 R3：`min` 跟着 `initial` 走的话，用户在 0.2 手动放大的图会在窗口变大时被**顶到**新的 fit。
  assert.strictEqual(st.min, Z.MIN_SCALE);
  assert.notStrictEqual(st.min, st.initial, '⛔ `min` 被写成 `initial` 了 —— 手动比例会被 resize 顶走');
  assert.strictEqual(st.max, 8);
  assert.strictEqual(st.max, Z.MAX_SCALE);
  assert.strictEqual(st.scale, st.initial);
});

test('8 `makeState` 初始居中：`tx === (sw − nw·s)/2`（`ty` 同理）', function () {
  const st = Z.makeState(2000, 1000, 800, 600, 24);
  assert.ok(Math.abs(st.tx - (800 - 2000 * st.scale) / 2) < 1e-12, '实际 tx=' + st.tx);
  assert.ok(Math.abs(st.ty - (600 - 1000 * st.scale) / 2) < 1e-12, '实际 ty=' + st.ty);
});

test('9 `zoomAt` 锚点不变：放大 1.25 后，锚点处的图像坐标误差 ≤ 1e-6', function () {
  const st = Z.makeState(2000, 1000, 800, 600, 24);
  const px = 400;
  const py = 300;
  const cx = (px - st.tx) / st.scale;
  const cy = (py - st.ty) / st.scale;
  const n = Z.zoomAt(st, 1.25, px, py);
  assert.ok(Math.abs((px - n.tx) / n.scale - cx) < 1e-6, '锚点 x 走了');
  assert.ok(Math.abs((py - n.ty) / n.scale - cy) < 1e-6, '锚点 y 走了');
  assert.ok(Math.abs(n.scale - st.scale * 1.25) < 1e-12);
});

test('10 `zoomAt` 在四角都不抛；被夹取时以夹取后为准', function () {
  const st = Z.makeState(2000, 1000, 800, 600, 24);
  const 角 = [[0, 0], [st.sw, 0], [0, st.sh], [st.sw, st.sh]];
  角.forEach(function (p) {
    const n = Z.zoomAt(st, 1.25, p[0], p[1]);
    assert.ok(Number.isFinite(n.scale) && n.scale > 0, '比例必须是正有限数');
    assert.ok(Number.isFinite(n.tx) && Number.isFinite(n.ty));
    const w = n.nw * n.scale;
    const h = n.nh * n.scale;
    // 超出舞台的那一维必须夹在 [sw−w, 0] 内 —— 不然会露出空白带
    if (w > n.sw) assert.ok(n.tx <= 1e-9 && n.tx >= n.sw - w - 1e-9, 'tx 超界：' + n.tx);
    else assert.ok(Math.abs(n.tx - (n.sw - w) / 2) < 1e-9, '小图必须居中');
    if (h > n.sh) assert.ok(n.ty <= 1e-9 && n.ty >= n.sh - h - 1e-9, 'ty 超界：' + n.ty);
    else assert.ok(Math.abs(n.ty - (n.sh - h) / 2) < 1e-9, '小图必须居中');

    // 没被夹住的那一维，锚点语义必须**精确**成立（被夹住时以夹取后为准，这是接受的）
    if (n.tx > n.sw - w + 1e-9 && n.tx < -1e-9) {
      assert.ok(Math.abs((p[0] - n.tx) / n.scale - (p[0] - st.tx) / st.scale) < 1e-6, 'x 锚点走了');
    }
  });
});

test('11 `zoomAt` 到 `MAX_SCALE` 后再放大 ⇒ 比例不变，`mode === "manual"`', function () {
  const st = Z.makeState(2000, 1000, 800, 600, 24);
  const 顶 = Z.zoomAt(st, 1e6, 400, 300);
  assert.strictEqual(顶.scale, Z.MAX_SCALE);
  assert.strictEqual(顶.mode, 'manual');
  const 再 = Z.zoomAt(顶, 1.25, 400, 300);
  assert.strictEqual(再.scale, Z.MAX_SCALE, '⛔ 超过 800% 了');
});

test('12 `zoomAt` 到 `MIN_SCALE` 后再缩小 ⇒ 比例不变', function () {
  const st = Z.makeState(2000, 1000, 800, 600, 24);
  const 底 = Z.zoomAt(st, 1e-12, 400, 300);
  assert.strictEqual(底.scale, Z.MIN_SCALE);
  const 再 = Z.zoomAt(底, 0.5, 400, 300);
  assert.strictEqual(再.scale, Z.MIN_SCALE);
});

test('13 `zoomTo(st, 1, 中心)`：大图到 100%；小图 100% → 100% 是 no-op；`mode === "manual"`', function () {
  const 大 = Z.makeState(4000, 3000, 800, 600, 24);
  const a = Z.zoomTo(大, 1, 400, 300);
  assert.ok(Math.abs(a.scale - 1) < 1e-12);
  assert.strictEqual(a.mode, 'manual');

  const 小 = Z.makeState(100, 100, 800, 600, 24);
  assert.strictEqual(小.scale, 1);
  const b = Z.zoomTo(小, 1, 400, 300);
  assert.ok(Math.abs(b.scale - 1) < 1e-12);
  assert.ok(Math.abs(b.tx - 小.tx) < 1e-12, '100%→100% 不该动平移');
  assert.strictEqual(b.mode, 'manual');
});

test('14 `clampPan`：放大后宽度 > 舞台 ⇒ `tx ∈ [sw−nw·s, 0]`，超界被夹回', function () {
  const st = Object.assign({}, Z.makeState(2000, 1000, 800, 600, 24), { scale: 1 });
  const 右 = Z.clampPan(Object.assign({}, st, { tx: 500 }));
  assert.strictEqual(右.tx, 0, '往右推超界必须停在 0');
  const 左 = Z.clampPan(Object.assign({}, st, { tx: -5000 }));
  assert.strictEqual(左.tx, 800 - 2000, '往左推超界必须停在 sw−w');
  const 中 = Z.clampPan(Object.assign({}, st, { tx: -600 }));
  assert.strictEqual(中.tx, -600, '界内不许动');
});

test('15 `clampPan`：宽度 ≤ 舞台 ⇒ `tx === (sw−nw·s)/2`（忽略传入的 tx）', function () {
  const st = Object.assign({}, Z.makeState(2000, 1000, 800, 600, 24), { scale: 0.2 });
  const r = Z.clampPan(Object.assign({}, st, { tx: 123 }));
  assert.strictEqual(r.tx, (800 - 2000 * 0.2) / 2);
});

test('16 `panBy`：两个方向同时夹取，比例与 `mode` 都不变（拖动不算"选比例"）', function () {
  const st = Z.makeState(4000, 3000, 800, 600, 24);
  assert.strictEqual(st.mode, 'fit');
  const a = Z.panBy(st, 1000, 1000);
  assert.strictEqual(a.scale, st.scale);
  assert.strictEqual(a.mode, 'fit', '⛔ 拖动把 `mode` 改成了 manual');
  assert.strictEqual(a.tx, (800 - 4000 * st.scale) / 2, '小图必须居中');
  const b = Z.panBy(st, -1000, -1000);
  assert.strictEqual(b.tx, a.tx);
  // ⚠️ 非有限增量当作 0，⛔ 不许把 tx 变成 NaN
  const c = Z.panBy(st, NaN, undefined);
  assert.ok(Number.isFinite(c.tx) && Number.isFinite(c.ty));
});

test('17 `resizeState` · fit 模式跟随：窗口变大后 `scale === 新 fit`，`fit`/`initial` 都重算', function () {
  const st = Z.makeState(4000, 3000, 800, 600, 24);
  assert.strictEqual(st.mode, 'fit');
  const r = Z.resizeState(st, 1600, 1200);
  const 新fit = Z.fitScale(4000, 3000, 1600, 1200, 24);
  assert.ok(Math.abs(r.fit - 新fit) < 1e-12);
  assert.ok(Math.abs(r.scale - 新fit) < 1e-12, 'fit 模式下比例必须精确跟随');
  assert.ok(Math.abs(r.initial - 新fit) < 1e-12);
  assert.strictEqual(r.sw, 1600);
  assert.strictEqual(r.sh, 1200);
});

test('18 ⭐ `resizeState` · manual **不被顶走**（评审 R3 正面例：0.2 仍是 0.2）', function () {
  const 起 = Z.makeState(7520, 5520, 800, 600, 24);
  assert.ok(Math.abs(起.fit - 0.1) < 1e-12, '夹具前提：fit 应是 0.1，实际 ' + 起.fit);
  const 手 = Z.zoomAt(起, 2, 400, 300);
  assert.ok(Math.abs(手.scale - 0.2) < 1e-12);
  assert.strictEqual(手.mode, 'manual');

  // 窗口放大到 fit = 0.4（3008×2256 ⇒ 可用区 2960×2208）
  const r = Z.resizeState(手, 3056, 2256);
  assert.ok(Math.abs(r.fit - 0.4) < 1e-9, '夹具前提：新 fit 应是 0.4，实际 ' + r.fit);
  assert.ok(Math.abs(r.scale - 0.2) < 1e-12, '⛔ 用户选的比例被 resize 顶成了 ' + r.scale);
  assert.strictEqual(r.mode, 'manual');
});

test('19 `resizeState` · manual 缩小后夹界：`scale` 不变，平移重新夹、不出现空白带', function () {
  const 起 = Z.makeState(7520, 5520, 800, 600, 24);
  const 手 = Z.zoomAt(起, 2, 400, 300);
  const r = Z.resizeState(手, 400, 400);
  assert.ok(Math.abs(r.scale - 0.2) < 1e-12);
  const w = r.nw * r.scale;
  const h = r.nh * r.scale;
  assert.ok(w > r.sw, '夹具前提：0.2 下这张图仍比舞台宽');
  assert.ok(r.tx <= 1e-9 && r.tx >= r.sw - w - 1e-9, 'tx 没被夹回：' + r.tx);
  assert.ok(r.ty <= 1e-9 && r.ty >= r.sh - h - 1e-9, 'ty 没被夹回：' + r.ty);
});

test('20 `resizeState` · 退化舞台（0 / 负数 / NaN）⇒ **原样返回**，⛔ 不算成 `MIN_SCALE`', function () {
  const st = Z.makeState(4000, 3000, 800, 600, 24);
  [[0, 600], [800, 0], [-5, -5], [NaN, 600], [800, NaN]].forEach(function (p) {
    const r = Z.resizeState(st, p[0], p[1]);
    assert.strictEqual(r, st, '退化尺寸必须原样返回（' + p[0] + '×' + p[1] + '）');
  });
});

test('21 `fitScale` · 留白吃光（`sw = 40, pad = 24`）⇒ `MIN_SCALE`，且正有限', function () {
  const v = Z.fitScale(100, 100, 40, 600, 24);
  assert.strictEqual(v, Z.MIN_SCALE);
  assert.ok(Number.isFinite(v) && v > 0);
});

test('22 `fitScale` · 非有限输入 ⇒ 返回值恒为**正有限数**', function () {
  [[NaN, 100, 800, 600], [100, NaN, 800, 600], [100, 100, Infinity, 600],
    [100, 100, 800, -Infinity], [100, 100, NaN, 600]].forEach(function (a) {
    const v = Z.fitScale(a[0], a[1], a[2], a[3], 24);
    assert.ok(Number.isFinite(v) && v > 0, '入参 ' + a.join(',') + ' ⇒ ' + v);
  });
});

test('23 `clampScale`：`NaN` / `Infinity` / `-1` / `0` ⇒ `MIN_SCALE`；`1e9` ⇒ `MAX_SCALE`', function () {
  assert.strictEqual(Z.clampScale(NaN), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(Infinity), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(-Infinity), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(-1), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(0), Z.MIN_SCALE);
  assert.strictEqual(Z.clampScale(1e9), Z.MAX_SCALE);
  assert.strictEqual(Z.clampScale(0.5), 0.5);
});

test('24 `fitTo` · **小图也会铺满**：`scale === fit`、`mode === "fit"`，再 resize 仍跟随', function () {
  const st = Z.makeState(100, 100, 800, 600, 24);
  assert.ok(st.scale < st.fit, '夹具前提：小图初始不放大');
  const f = Z.fitTo(st);
  assert.strictEqual(f.scale, st.fit);
  assert.strictEqual(f.mode, 'fit');
  const r = Z.resizeState(f, 400, 300);
  const 新fit = Z.fitScale(100, 100, 400, 300, 24);
  assert.ok(Math.abs(r.scale - 新fit) < 1e-12, '「适应」之后 resize 必须继续跟随');
});

test('25 `fitTo` → 手动缩放 → resize：`mode` 由 fit 转 manual 后**不再跟随**', function () {
  const f = Z.fitTo(Z.makeState(2000, 1000, 800, 600, 24));
  assert.strictEqual(f.mode, 'fit');
  const 手 = Z.zoomAt(f, 1.25, 400, 300);
  assert.strictEqual(手.mode, 'manual');
  const r = Z.resizeState(手, 1600, 1200);
  assert.ok(Math.abs(r.scale - 手.scale) < 1e-12, '⛔ manual 被新的 fit 顶走了');
  assert.ok(Math.abs(r.fit - Z.fitScale(2000, 1000, 1600, 1200, 24)) < 1e-12, 'fit 本身仍要重算');
});

test('26 `wheelFactor(0)` = 1；正 `deltaY` < 1；负 `deltaY` > 1', function () {
  assert.strictEqual(Z.wheelFactor(0), 1);
  assert.ok(Z.wheelFactor(100) < 1);
  assert.ok(Z.wheelFactor(-100) > 1);
  assert.strictEqual(Z.wheelFactor(NaN), 1, '非有限数当作 0（no-op）');
});

test('27 `wheelFactor(±100000)` 被夹到 `1/1.5` / `1.5`', function () {
  assert.strictEqual(Z.wheelFactor(100000), 1 / Z.WHEEL_CLAMP);
  assert.strictEqual(Z.wheelFactor(-100000), Z.WHEEL_CLAMP);
});

test('28 `scaleLabel(0.376)` = `"38%"`；`scaleLabel(1)` = `"100%"`', function () {
  assert.strictEqual(Z.scaleLabel(0.376), '38%');
  assert.strictEqual(Z.scaleLabel(1), '100%');
  assert.strictEqual(Z.scaleLabel(NaN), Z.scaleLabel(Z.MIN_SCALE), '非有限数⛔ 不许印 NaN');
});

test('29 `toTransform({tx:10,ty:20,scale:0.5})` **逐字**等于约定格式', function () {
  assert.strictEqual(
    Z.toTransform({ tx: 10, ty: 20, scale: 0.5 }),
    'translate(10px, 20px) scale(0.5)'
  );
});

test('30 `captionFor`：alt 优先 → 真实路径的 basename → 兜底文案', function () {
  assert.strictEqual(Z.captionFor('图 1', ''), '图 1');
  assert.strictEqual(Z.captionFor('', '/a/b/c.png'), 'c.png');
  assert.strictEqual(Z.captionFor('', ''), '图片预览');
  assert.strictEqual(Z.captionFor(null, null), '图片预览');
  assert.strictEqual(Z.captionFor('   ', '/x/y.png'), 'y.png', '全空白 alt 视同没有');
});

// ────────────────────────────────────────────────────────────────
// §7.3 源码级闸门（第 31–42 条）
// ⚠️ 这一层问的是"**源码的形状**"，⛔ 不是行为——行为那半要真 DOM（`make probe-image-viewer`）。
//    它们挡的是"以后有人把 `preventScroll` 删掉 / 顺手加一个 `scrollTo(0)`"这一类改动。
// ────────────────────────────────────────────────────────────────

test('31 ⭐ `index.html`：`services/imagezoom.js` 排在 `components/ImageViewer.js` **之前**', function () {
  const o = 脚本顺序();
  const 逻辑 = o.indexOf('services/imagezoom.js');
  const 组件 = o.indexOf('components/ImageViewer.js');
  assert.ok(逻辑 >= 0, '⛔ `index.html` 里没有 `services/imagezoom.js` —— 预览的数学整个不存在');
  assert.ok(组件 >= 0, '⛔ `index.html` 里没有 `components/ImageViewer.js` —— 预览层整个不存在');
  assert.ok(逻辑 < 组件, '⛔ imagezoom.js 排在 ImageViewer.js 之后 ⇒ 后者加载期取到 `undefined`');
});

test('32 ⭐ `index.html`：`ImageViewer.js` 在 `Settings.js` **之后**、`main.js` **之前**', function () {
  const o = 脚本顺序();
  const 设置 = o.indexOf('components/Settings.js');
  const 预览 = o.indexOf('components/ImageViewer.js');
  const 根 = o.indexOf('main.js');
  assert.ok(设置 >= 0 && 预览 >= 0 && 根 >= 0);
  assert.ok(预览 > 设置, '⛔ 拿不到覆盖层登记处（`INV-ZOOM-04` 的双向互斥就断了）');
  assert.ok(预览 < 根, '⛔ `main.js` 加载期要取 `window.rmd.imageViewer`');
});

test('33 `index.html`：`styles/image-viewer.css` 排在 `styles/settings.css` **之后**', function () {
  const o = 样式顺序();
  const 设置 = o.indexOf('styles/settings.css');
  const 预览 = o.indexOf('styles/image-viewer.css');
  assert.ok(设置 >= 0, '⛔ 没有 settings.css —— 顺序断言的前提没建立');
  assert.ok(预览 >= 0, '⛔ 没有 image-viewer.css —— 预览层会**完全没有样式**');
  assert.ok(预览 > 设置, '⛔ 覆盖层的样式表排到设置之前了');
});

test('34 ⭐ `ImageView.js`：`rmd-zoomable` 只出现在**本地图成功**那一支', function () {
  const code = 代码('components/ImageView.js');
  assert.strictEqual(次数(code, 'rmd-zoomable'), 1,
    '⛔ 标记出现了不止一次 —— 远程图 / 失败图也被标成可预览了');

  const at = code.indexOf('rmd-zoomable');
  const 读资产 = code.indexOf('S.readAsset(');
  const 兜底 = code.indexOf('.catch(', 读资产 >= 0 ? 读资产 : 0);
  assert.ok(读资产 >= 0, '⛔ 找不到 `S.readAsset(` —— 夹具/判据过期了');
  assert.ok(兜底 > 读资产, '⛔ 找不到本地图成功分支的 `.catch(`');
  assert.ok(at > 读资产 && at < 兜底,
    '⛔ 标记不在"本地图成功"那一支里 —— 远程图会因此可以进预览（= 预览偷偷联网）');

  // 远程那一支必须一个标记都没有
  const 远程 = code.indexOf('if (isRemote(src)) {');
  assert.ok(远程 >= 0, '⛔ 找不到远程图分支');
  const 远程体 = code.slice(远程, code.indexOf('continue;', 远程));
  assert.strictEqual(次数(远程体, 'rmd-zoomable'), 0, '⛔ 远程图被标记了');
});

test('35 ⭐ `ImageViewer.js`：准入判据调用 `isPreviewableSrc`（⛔ 不自己写正则）', function () {
  const code = 代码('components/ImageViewer.js');
  assert.strictEqual(次数(code, 'Z.isPreviewableSrc('), 1,
    '⛔ 准入判据没有（或不止一次）调 `Z.isPreviewableSrc` —— 零网络那条闸门少了一道');
  assert.ok(!/data:image/.test(code),
    '⛔ 文件里出现了 `data:image` 字面/正则 —— 第二份判据，会和 `imagezoom.js` 漂移');
});

test('36 ⭐ 每一处 `focus(` 都带 `preventScroll`（评审 R2：还焦点不许滚背景）', function () {
  const code = 代码('components/ImageViewer.js');
  const 全部 = code.match(/\.focus\s*\(/g) || [];
  const 带参 = code.match(/\.focus\s*\(\s*\{[^}]*\}/g) || [];
  assert.ok(全部.length >= 2,
    '⛔ 只找到 ' + 全部.length + ' 处 `focus(` —— 至少要有「打开时聚焦关闭按钮」与「关闭时还焦点」两处');
  assert.strictEqual(全部.length, 带参.length,
    '⛔ 有 `focus(` 没带参数对象 —— 那些地方会滚动背景');
  带参.forEach(function (m) {
    assert.ok(/preventScroll\s*:\s*true/.test(m),
      '⛔ 这个 focus 没带 `preventScroll: true`：' + m.replace(/\s+/g, ' '));
  });
});

test('37 ⭐ `ImageViewer.js`：⛔ 全文没有 `clientWidth` / `clientHeight`（准入只认自然尺寸）', function () {
  const code = 代码('components/ImageViewer.js');
  assert.strictEqual(次数(code, 'clientWidth'), 0, '⛔ 用了布局占位尺寸 —— 图没解码完也会"看起来可以用"');
  assert.strictEqual(次数(code, 'clientHeight'), 0, '⛔ 同上');
  assert.ok(次数(code, 'naturalWidth') >= 1 && 次数(code, 'naturalHeight') >= 1,
    '⛔ 准入判据里没有自然尺寸 —— 那它到底判了什么？');
});

test('38 ⭐ `ImageViewer.js`：键盘 / 滚轮 / 触摸的监听**成对**，且摘在 `close()` 里', function () {
  const code = 代码('components/ImageViewer.js');

  // ⚠️ 口径：只数 `window.` 与 `root.` 这两族。
  //    `docEl.addEventListener('keydown'` 是 `installDelegation` 的**委托**（另一件事），
  //    它有自己的一对（在 `uninstall()` 里）——下面单独数它。
  assert.strictEqual(次数(code, "window.addEventListener('keydown'"), 1, '⛔ 模态监听没挂上（或挂了两次）');
  assert.strictEqual(次数(code, "window.removeEventListener('keydown'"), 1,
    '⛔ 没摘模态监听 —— 关掉预览之后 `PageDown` 仍会被吞（而且会一直吞）');
  assert.strictEqual(次数(code, "root.addEventListener('wheel'"), 1);
  assert.strictEqual(次数(code, "root.removeEventListener('wheel'"), 1);
  assert.strictEqual(次数(code, "root.addEventListener('touchmove'"), 1);
  assert.strictEqual(次数(code, "root.removeEventListener('touchmove'"), 1);
  // 委托那一对：挂在一个地方、摘在返回的卸载函数里
  assert.strictEqual(次数(code, "docEl.addEventListener('click'"), 1);
  assert.strictEqual(次数(code, "docEl.removeEventListener('click'"), 1);
  assert.strictEqual(次数(code, "docEl.addEventListener('keydown'"), 1);
  assert.strictEqual(次数(code, "docEl.removeEventListener('keydown'"), 1);

  // ⚠️ 摘监听必须写在 `close()` 里（在 `open()` 之前不可能有监听器）
  const 关 = code.indexOf('function close(');
  const 摘 = code.indexOf("window.removeEventListener('keydown'");
  assert.ok(关 >= 0 && 摘 > 关, '⛔ 摘监听不在 `close()` 里');
});

test('39 ⭐ `ImageViewer.js`：`inert` 的设置与摘除成对，且**只摘带 `data-viewer-inert` 的**', function () {
  const code = 代码('components/ImageViewer.js');
  assert.strictEqual(次数(code, "setAttribute('inert'"), 1);
  assert.strictEqual(次数(code, "removeAttribute('inert'"), 1);
  assert.strictEqual(次数(code, "setAttribute('data-viewer-inert'"), 1);
  assert.strictEqual(次数(code, "removeAttribute('data-viewer-inert'"), 1);

  const 摘 = code.indexOf("removeAttribute('inert')");
  const 前文 = code.slice(Math.max(0, 摘 - 240), 摘);
  assert.ok(/hasAttribute\('data-viewer-inert'\)/.test(前文),
    '⛔ `removeAttribute(\'inert\')` 没有前置判断 —— 别人自己设的 `inert` 会被我们摘掉');

  // ⭐ 已经带 `inert` 的节点不许被收进名单（否则释放时会把别人的 inert 清掉）
  assert.ok(/hasAttribute\('inert'\)/.test(code), '⛔ 没有"原本就 inert 的跳过"这条判据');
});

test('40 ⭐ `main.js`：接线只有一处，且 ⛔ 没有第二份委托/判据', function () {
  const code = 代码('main.js');
  assert.strictEqual(次数(code, 'ImageViewer.installDelegation('), 1,
    '⛔ 委托装了不止一次 —— 一次点击会开两次预览（或者装了又漏摘）');
  assert.strictEqual(次数(code, 'ImageViewer.createImageViewer('), 1, '⛔ 预览层被造了不止一份');
  assert.strictEqual(次数(code, 'zoomTarget'), 0,
    '⛔ `main.js` 里出现了 `zoomTarget` —— 第二份命中判据（`ImageViewer.js` 才是唯一那份）');

  // ⚠️ 口径：`main.js` 本来就有十几处自己的 click/keydown（侧栏、树、编辑面…），
  //    所以⛔ 不能断言"全文没有 addEventListener"（设计 §7.3 第 40 行的原话做不到）。
  //    要问的是**预览这几行本身**有没有自己挂监听——它必须只经 `installDelegation`。
  code.split('\n').forEach(function (line, i) {
    if (!/imageViewer|ImageViewer/.test(line)) return;
    assert.ok(!/addEventListener|removeEventListener/.test(line),
      '⛔ main.js:' + (i + 1) + ' 预览接线自己挂了监听：' + line.trim());
  });
});

test('41 ⭐ `zoomTarget` 两条路返回同一张图；两个委托都 `preventDefault` ＋ `stopPropagation`', function () {
  const img = { tag: 'img' };
  // ① 直接命中图
  assert.strictEqual(IV.zoomTarget({
    closest: function (s) { return s === 'img.rmd-zoomable' ? img : null; }
  }), img);
  // ② 命中链接里的图（键盘激活外层 `<a>` 的情形）
  const a = { querySelector: function (s) { return s === 'img.rmd-zoomable' ? img : null; } };
  assert.strictEqual(IV.zoomTarget({
    closest: function (s) {
      if (s === 'img.rmd-zoomable') return null;
      return s === 'a[href]' ? a : null;
    }
  }), img);
  // ③ 都不命中
  assert.strictEqual(IV.zoomTarget({ closest: function () { return null; } }), null);
  assert.strictEqual(IV.zoomTarget({
    closest: function (s) { return s === 'a[href]' ? { querySelector: function () { return null; } } : null; }
  }), null);
  assert.strictEqual(IV.zoomTarget(null), null);

  // 源码那半：共用的 `fire()` 必须两个都调（⛔ 只 stop 的话链接动作不会被打断）
  const code = 代码('components/ImageViewer.js');
  const 起 = code.indexOf('function fire(');
  assert.ok(起 >= 0, '⛔ 找不到 `fire()` —— click 与 keydown 没有共用那一份');
  const 体 = code.slice(起, 起 + 400);
  assert.ok(/preventDefault\s*\(/.test(体), '⛔ `fire()` 没调 `preventDefault` ⇒ 链接会被执行第二次');
  assert.ok(/stopPropagation\s*\(/.test(体), '⛔ `fire()` 没调 `stopPropagation` ⇒ 文档上的别的委托也会响应');
  // ⚠️ 数**带分号的调用**（`fire(img, e);`），⛔ 不数 `function fire(img, e) {` 那一处定义
  //    ——否则"定义了 + 调了两次"会数成 3，与"调了三次"分不开。
  assert.strictEqual(次数(code, 'fire(img, e);'), 2, '⛔ 两个委托没有都走 `fire()`');
});

test('42 ⭐ `ImageViewer.js`：⛔ 全文没有 `scrollTo` / `scrollTop` / `hostSetTop`（`INV-ZOOM-03`）', function () {
  const code = 代码('components/ImageViewer.js');
  assert.strictEqual(次数(code, 'scrollTo'), 0, '⛔ 预览碰了滚动位置 —— 编辑态会触发同步来源闸翻边');
  assert.strictEqual(次数(code, 'scrollTop'), 0, '⛔ 同上');
  assert.strictEqual(次数(code, 'hostSetTop'), 0, '⛔ 同上');
});
