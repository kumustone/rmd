// 图片预览的**全部数学** —— `design/0018-图片缩放预览.md` §2.2（2026-10-19 已通过）。
//
// # 为什么单独成文件
//
// `INV-ZOOM-06`：拟合、初始比例、夹取、焦点缩放、平移、resize **只在这里**，
// 组件（`components/ImageViewer.js`）与 `main.js` ⛔ 一律不另算。
// 理由不是"整洁"，是**可测**：这些全部是纯函数，`node --test` 直接跑，
// 不需要 WKWebView、不需要真图片；而组件那半要真 DOM，由离屏探针兜底。
//
// # 三条容易被"顺手简化"掉的性质（每一条都有单测钉着）
//
// 1. ⭐ **`min` 与「适应」解耦**（评审 R3）：`min = MIN_SCALE` 是**绝对**下界，
//    ⛔ 不跟着 `fit` 走。跟着走的话，用户在 0.2 手动放大的图会在窗口变大
//    （`fit` 变成 0.4）时被**强制顶到 0.4**——他选的比例被系统改掉了。
//    「适应」是一个**目标值**（按钮 / `0` 键），⛔ 不是地板。
// 2. ⭐ **比例恒为正有限数**（`INV-ZOOM-12`）：`clampScale` 兜底，
//    `fitScale` 在"留白吃光"（舞台比两倍留白还小）时返回 `MIN_SCALE`
//    ——⛔ 不是负数、⛔ 不是 0、⛔ 不是 NaN。窗口拖到极小的那个瞬间不许抛。
// 3. ⭐ **resize 的五步顺序是判据的一部分**（`resizeState`）：忽略退化尺寸 →
//    重算 `fit`/`initial` → 按 `mode` 定 `scale` → 重新夹平移。
//    `mode === 'manual'` 时用户的比例**不被新的 `fit` 顶走**（只被绝对上下界夹）。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**（经典脚本共享全局词法作用域，
// 顶层 `const` 撞名会让整个文件不执行 —— 见 `FileTree.js` 的详细说明）。
(function () {
  'use strict';

  // ⭐ `design/0025`：兜底文案走字典（`viewer.label`）。⚠️ 本模块被 `node --test` 直接
  //    `require` ⇒ 那条路走 `require('./i18n.js')`，与浏览器**同一份字典**。
  //    ⚠️ 它**必须排在 `i18n.js` 之后**（`index.html` 里 `services/i18n.js` 是第一条）。
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) ||
    (typeof module !== 'undefined' && module.exports ? require('./i18n.js') : null);
  const t = I18N ? I18N.t : function (key) { return key; };

  /** 适应窗口时四边的留白（px）。 */
  const FIT_PAD = 24;
  /** 按钮 / 键盘的离散步长。 */
  const ZOOM_STEP = 1.25;
  /** ⭐ 绝对下界（≈1.6%）：只为"比例恒为正有限数"兜底，⛔ 不是「适应」的地板。 */
  const MIN_SCALE = 1 / 64;
  /** 绝对上限：800%。 */
  const MAX_SCALE = 8;
  /** 轮盘：`factor = exp(−deltaY · K)`。 */
  const WHEEL_K = 0.002;
  /** 单次轮盘事件的倍率上下限（触控板一次猛划不该把图甩没）。 */
  const WHEEL_CLAMP = 1.5;

  /** 这个 `src` 是不是"可以进预览"的：⭐ **只认 `data:image/…`**（`INV-ZOOM-02`）。
      ⛔ `https:` / `//` / `blob:` / `data:text/html` 一律 false —— 预览层复制远程 URL
      可能再发一次请求（`Cache-Control: no-store` 的情形），那就是"预览偷偷联网"。 */
  function isPreviewableSrc(src) {
    return /^data:image\//i.test(String(src == null ? '' : src).trim());
  }

  /** ⭐ 比例夹取：**返回值恒为正有限数**（`INV-ZOOM-12`）。
      ⚠️ 非有限数（`NaN` / `±Infinity`）一律落到 `MIN_SCALE`——那不是"随便挑个数"，
      它是这条不变量里唯一安全的落点：正、有限、且不假装用户选过某个比例。 */
  function clampScale(s) {
    const n = Number(s);
    if (!Number.isFinite(n)) return MIN_SCALE;
    if (n < MIN_SCALE) return MIN_SCALE;
    if (n > MAX_SCALE) return MAX_SCALE;
    return n;
  }

  /** 「适应」的比例：可用区（扣掉四边留白）里放得下整张图的那个比例。
      ⚠️ 返回的是**目标值**，⛔ 不是下界——函数本身不封顶（小图会得到 > 1 的值，
      要不要放大由调用方按 `initialScale` / `fitTo` 的语义决定）。
      ⚠️ 舞台任一边比两倍留白还小 ⇒ 可用区 ≤ 0 ⇒ 返回 `MIN_SCALE`（⛔ 不返回负数/0/NaN）。 */
  function fitScale(nw, nh, sw, sh, pad) {
    const p = Number.isFinite(Number(pad)) ? Number(pad) : FIT_PAD;
    const availW = Number(sw) - 2 * p;
    const availH = Number(sh) - 2 * p;
    if (!(availW > 0) || !(availH > 0)) return MIN_SCALE;
    // 自然尺寸无效：调用方（`open`）本来就会拒绝，这里给一个中性的 1。
    if (!(Number(nw) > 0) || !(Number(nh) > 0)) return 1;
    return clampScale(Math.min(availW / Number(nw), availH / Number(nh)));
  }

  /** 打开时的初始比例：大图适应窗口、**小图不放大**（100%）。
      ⚠️ 与 `fitTo`（「适应」按钮）是两件事：后者**会**把小图放大到铺满。 */
  function initialScale(nw, nh, sw, sh, pad) {
    return clampScale(Math.min(1, fitScale(nw, nh, sw, sh, pad)));
  }

  /** 平移夹取：缩放后比舞台小的那一维**居中**，大的那一维夹到边缘（不出现空白带）。
      ⚠️ 返回**新对象**（纯函数），并保持 `mode` 不变。 */
  function clampPan(st) {
    const scale = st.scale;
    const w = st.nw * scale;
    const h = st.nh * scale;
    const tx0 = Number.isFinite(st.tx) ? st.tx : 0;
    const ty0 = Number.isFinite(st.ty) ? st.ty : 0;
    const tx = w <= st.sw ? (st.sw - w) / 2 : Math.min(0, Math.max(st.sw - w, tx0));
    const ty = h <= st.sh ? (st.sh - h) / 2 : Math.min(0, Math.max(st.sh - h, ty0));
    return Object.assign({}, st, { tx: tx, ty: ty });
  }

  /** 起一个新状态：拟合 / 初始 / 居中。
      ⭐ `mode` 的初值：`fit < 1`（大图被缩过）⇒ `'fit'`，窗口 resize 时精确跟随；
      小图初始就是 100% ⇒ `'manual'`（resize **不该**把它放大）。 */
  function makeState(nw, nh, sw, sh, pad) {
    const p = Number.isFinite(Number(pad)) ? Number(pad) : FIT_PAD;
    const fit = fitScale(nw, nh, sw, sh, p);
    const initial = clampScale(Math.min(1, fit));
    return clampPan({
      nw: Number(nw),
      nh: Number(nh),
      sw: Number(sw),
      sh: Number(sh),
      pad: p,
      fit: fit,
      initial: initial,
      min: MIN_SCALE,
      max: MAX_SCALE,
      scale: initial,
      tx: 0,
      ty: 0,
      mode: fit < 1 ? 'fit' : 'manual'
    });
  }

  /** 以舞台坐标 `(px, py)` 为锚缩放：锚点下的那一点图像**不动**。
      ⚠️ 最后要 `clampPan`——图被推到边缘时锚点会跟着走，这是**接受**的
      （否则会露出空白带）。⭐ 成功后 `mode = 'manual'`（用户选了比例）。 */
  function zoomAt(st, factor, px, py) {
    const f = Number(factor);
    const next = Number.isFinite(f) && f > 0 ? clampScale(st.scale * f) : st.scale;
    const x = Number.isFinite(px) ? px : st.sw / 2;
    const y = Number.isFinite(py) ? py : st.sh / 2;
    // 锚点处的图像坐标（缩放前后必须相同）
    const cx = (x - st.tx) / st.scale;
    const cy = (y - st.ty) / st.scale;
    return clampPan(Object.assign({}, st, {
      scale: next,
      tx: x - cx * next,
      ty: y - cy * next,
      mode: 'manual'
    }));
  }

  /** 目标比例版（「100%」按钮）：语义同 `zoomAt`，只是 `factor` 换成绝对目标。 */
  function zoomTo(st, target, px, py) {
    const want = clampScale(target);
    const factor = want / st.scale;
    return zoomAt(st, factor, px, py);
  }

  /** ⭐ 「适应」按钮：`mode = 'fit'`、比例取 `fit`。
      ⚠️ **小图也会被放大到铺满**——这是这个按钮的明确语义，与打开时的 `initial` 不同。 */
  function fitTo(st) {
    return clampPan(Object.assign({}, st, { scale: st.fit, mode: 'fit' }));
  }

  /** 拖动平移：只夹平移量，**不改 `mode`**（拖动不算"选了一个比例"）。 */
  function panBy(st, dx, dy) {
    const ax = Number.isFinite(dx) ? dx : 0;
    const ay = Number.isFinite(dy) ? dy : 0;
    return clampPan(Object.assign({}, st, { tx: st.tx + ax, ty: st.ty + ay }));
  }

  /** ⭐ 窗口 resize：**五步顺序是判据的一部分**（评审 R3）。
      ① 退化舞台（隐藏 / 未布局，量到 0×0）⇒ **原样返回**，⛔ 不把比例算成 `MIN_SCALE`；
      ②③ `fit`/`initial` 按新尺寸重算；
      ④ `mode === 'fit'` 精确跟随新的 `fit`；`mode === 'manual'` **保持用户比例**（只夹绝对界）；
      ⑤ 平移按新尺寸重新夹。
      ⚠️ `min`/`max` 是常量，不参与重算——它们的职责只是"正且有限"，不随布局漂。 */
  function resizeState(st, sw2, sh2) {
    const sw = Number(sw2);
    const sh = Number(sh2);
    if (!(sw > 0) || !(sh > 0)) return st;
    const fit = fitScale(st.nw, st.nh, sw, sh, st.pad);
    const initial = clampScale(Math.min(1, fit));
    const scale = st.mode === 'fit' ? fit : clampScale(st.scale);
    return clampPan(Object.assign({}, st, {
      sw: sw,
      sh: sh,
      fit: fit,
      initial: initial,
      scale: scale
    }));
  }

  /** 轮盘 → 倍率：`exp(−deltaY · K)`，夹到单次事件的上下限。
      ⚠️ `deltaY = 0` ⇒ 1（no-op），非有限数也当作 0。 */
  function wheelFactor(deltaY) {
    const d = Number(deltaY);
    if (!Number.isFinite(d)) return 1;
    const f = Math.exp(-d * WHEEL_K);
    if (f > WHEEL_CLAMP) return WHEEL_CLAMP;
    if (f < 1 / WHEEL_CLAMP) return 1 / WHEEL_CLAMP;
    return f;
  }

  /** 工具栏上那个比例文字。 */
  function scaleLabel(scale) {
    const n = Number(scale);
    const s = Number.isFinite(n) ? n : MIN_SCALE;
    return Math.round(s * 100) + '%';
  }

  /** 预览层 `<img>` 的 `style.transform`。⚠️ 格式被单测逐字钉着。 */
  function toTransform(st) {
    return 'translate(' + st.tx + 'px, ' + st.ty + 'px) scale(' + st.scale + ')';
  }

  /** 顶部标题：`alt` 优先；否则取真实路径的 basename；都没有 ⇒ 兜底文案。 */
  function captionFor(alt, realPath) {
    const a = String(alt == null ? '' : alt).trim();
    if (a) return a;
    const p = String(realPath == null ? '' : realPath).trim();
    if (p) {
      const parts = p.split(/[\\/]+/);
      const base = parts[parts.length - 1];
      if (base) return base;
    }
    return t('viewer.label');
  }

  const api = {
    FIT_PAD: FIT_PAD,
    ZOOM_STEP: ZOOM_STEP,
    MIN_SCALE: MIN_SCALE,
    MAX_SCALE: MAX_SCALE,
    WHEEL_K: WHEEL_K,
    WHEEL_CLAMP: WHEEL_CLAMP,
    isPreviewableSrc: isPreviewableSrc,
    clampScale: clampScale,
    fitScale: fitScale,
    initialScale: initialScale,
    makeState: makeState,
    clampPan: clampPan,
    zoomAt: zoomAt,
    zoomTo: zoomTo,
    fitTo: fitTo,
    panBy: panBy,
    resizeState: resizeState,
    wheelFactor: wheelFactor,
    scaleLabel: scaleLabel,
    toTransform: toTransform,
    captionFor: captionFor
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).imagezoom = api;
})();
