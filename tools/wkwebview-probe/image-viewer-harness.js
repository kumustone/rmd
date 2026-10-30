// rmd · 图片缩放预览的**真 DOM 离屏探针**（`design/0018` §7.4，25 条判据）
//
// ⚠️⚠️ 这个文件**不是产品代码**，也⛔ 不复制产品逻辑：
//    · 缩放数学 → 产品 `src/services/imagezoom.js`（原样拷进来）
//    · 预览层 / 命中判据 / 委托 → 产品 `src/components/ImageViewer.js`
//    · 覆盖层登记处 → 产品 `src/components/Settings.js`
//    · 键盘分发器 → 产品 `src/services/keymap.js`（**真分发器**，评审 R1 点名要的）
//    ⇒ 这里只写**夹具**（正文、图片、假指针）与**观察**（读 `style.transform` / `hidden` /
//      `defaultPrevented` / `activeElement` / `scrollTop` / `inert`）。
//
// # ⚠️ 探针能证明什么、不能证明什么
//
// `dispatchEvent` 造的是**不可信事件**：浏览器**不会**为它执行默认动作
// （翻页、空格滚动、`<a>` 跳转都不会真的发生）。所以第 12/14/17/22 条证明的是
// 「**该 preventDefault 的地方我们确实调了、该放行的地方确实没调**」——
// 这是**因果上的那一半**。真实事件的默认行为那一半（WKWebView 真的照着做）
// 只能**人造输入**验证，⛔ 本探针到不了，列在 `design/0018` §7.5 的人工项里。
// ⭐ 例外：`focus({preventScroll:true})` 是**真实 API**，滚动量真的可读 ⇒ 第 18/19 条是真的。
//
// # 五个阶段（窗口尺寸由 Swift 侧在阶段之间改，⛔ 不改产品 CSS）
//
//   __RUN                → 判据 1–19、22–25（并留下"手动比例"这个前提）
//   __RUN_RESIZE_BIG     → 判据 20（放大窗口：manual 比例⛔ 不许被新的 fit 顶走）
//   __RUN_RESIZE_TINY    → 判据 20 的后半（缩小窗口：比例⛔ 变 0）
//   __RUN_RESIZE_MICRO   → 判据 21 的前半（缩到几十像素：fit 有限且 > 0，不抛）
//   __RUN_RESIZE_BACK    → 判据 21 的后半（再放大：手动比例仍保持）＋ 汇总第 21 条
(function () {
  'use strict';

  const Z = window.rmd.imagezoom;
  const IV = window.rmd.imageViewer;
  const St = window.rmd.settings;
  const K = window.rmd.keymap;

  const 检查 = [];
  /** 阶段之间要带过去的东西（⛔ 不放在 DOM 上——那是产品的地盘）。 */
  const P = { 手动比例: null, 微小fit: null, 微小比例: null, 视口0: null };

  function 记(id, 名, ok, 判据, 值) {
    检查.push({ id: String(id), 名: 名, 结果: ok ? '通过' : '失败', 判据: 判据, 值: 值 });
  }
  function 跳(id, 名, 判据, 值) {
    检查.push({ id: String(id), 名: 名, 结果: '跳过', 判据: 判据, 值: 值 });
  }
  function 近(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }
  /**
   * 等 n 帧。
   * ⚠️ **带超时**：离屏窗口里 rAF 不一定来（`kb/0022`）——⛔ 不能让整轮挂死在那里，
   * 那样连"rAF 不来"这个结论都拿不到。超时后照常往下走，由 `E` 那条自证如实记下来。
   */
  function 帧(n) {
    return new Promise(function (resolve) {
      let i = 0;
      let done = false;
      const t = setTimeout(function () {
        if (done) return;
        done = true;
        P.rAF超时 = (P.rAF超时 || 0) + 1;
        resolve();
      }, 800);
      (function step() {
        if (done) return;
        if (i++ >= n) { done = true; clearTimeout(t); return resolve(); }
        requestAnimationFrame(step);
      })();
    });
  }
  function 睡(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ── 夹具：正文 / 图片 ────────────────────────────────────────────
  function 造图(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#cccccc'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#333333'; g.fillRect(0, 0, w / 4, h / 4);
    return c.toDataURL('image/png');
  }

  const docEl = document.getElementById('doc');
  const 大图 = 造图(2000, 1000);

  function 造正文() {
    docEl.innerHTML = '';
    for (let i = 0; i < 40; i++) {
      const p = document.createElement('p');
      p.textContent = '第 ' + i + ' 段：正文占位，用来让 #doc 可滚。';
      p.style.height = '40px';
      docEl.appendChild(p);
    }
    // ⭐ 与产品同名的标记（`ImageView.js` 在本地图成功那一支加的）：`class="rmd-zoomable"`
    //    ＋ `tabindex="0"`（产品里也是 `!inLink` 时才对**图**加 tabindex）。
    const img = document.createElement('img');
    img.id = 'zoomimg';
    img.className = 'rmd-zoomable';
    img.src = 大图;
    img.alt = '大图';
    img.tabIndex = 0;
    docEl.appendChild(img);

    // ⭐ 被链接包着的图：⛔ 不加 tabindex（`<a>` 自己就可聚焦，产品规则如此）
    const a = document.createElement('a');
    a.href = '#sentinel';
    a.id = 'linkwrap';
    const img2 = document.createElement('img');
    img2.id = 'linkimg';
    img2.className = 'rmd-zoomable';
    img2.src = 大图;
    img2.alt = '链接里的图';
    a.appendChild(img2);
    docEl.appendChild(a);

    // ⭐ 原本就 inert 的兄弟节点（判据 24 的"别人的 inert 不许被摘"）
    const pre = document.createElement('div');
    pre.id = 'preinert';
    pre.setAttribute('inert', '');
    pre.textContent = '本来就有 inert 的兄弟节点';
    document.body.appendChild(pre);
  }

  // ── 夹具：事件 ───────────────────────────────────────────────────
  function 按键(目标, init) {
    const e = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init));
    目标.dispatchEvent(e);
    return e;
  }
  function 鼠标(目标, type, init) {
    const e = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, init));
    目标.dispatchEvent(e);
    return e;
  }
  function 指针(目标, type, init) {
    const e = new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0
    }, init));
    目标.dispatchEvent(e);
    return e;
  }
  /**
   * ⚠️⚠️ 滚轮**必须**造 `WheelEvent`，⛔ 不能拿 `MouseEvent` 顶替——
   * `MouseEventInit` 里**没有** `deltaY/deltaX/deltaMode`，用 MouseEvent 造出来的
   * `e.deltaY` 是 `undefined`，而产品那边 `wheelFactor(undefined)` 按设计返回 **1**
   * （= 不缩放，⛔ 不抛也不报）⇒ 判据会红在一个**夹具的错**上。
   */
  function 滚轮(目标, init) {
    const e = new WheelEvent('wheel', Object.assign({ bubbles: true, cancelable: true }, init));
    目标.dispatchEvent(e);
    return e;
  }

  // ── 观察：从 `style.transform` 反读状态（产品只有这一个对外可见的面）──
  // ⭐ 产品写的是 `translate(tx, ty) scale(s)`（`imagezoom.toTransform`），
  //    但 WebKit 可能把它序列化成别形状 ⇒ 先按原文解析，解析不出再走 `DOMMatrix`。
  function 读状态() {
    const el = 图层() && 图层().querySelector('.image-viewer-img');
    if (!el) return null;
    const t = el.style.transform || '';
    const m = /translate\(([-\d.eE+]+)px,\s*([-\d.eE+]+)px\)\s*scale\(([-\d.eE+]+)\)/.exec(t);
    if (m) return { tx: Number(m[1]), ty: Number(m[2]), scale: Number(m[3]) };
    const 算 = getComputedStyle(el).transform;
    if (!算 || 算 === 'none') return null;
    try {
      const d = new DOMMatrix(算);
      return { tx: d.e, ty: d.f, scale: d.a };
    } catch (e) {
      return null;
    }
  }
  function 图层() { return document.querySelector('.image-viewer-layer'); }
  function 舞台() { return 图层().querySelector('.image-viewer-stage'); }
  function 工具条() { return 图层().querySelector('.image-viewer-controls'); }
  function 按钮(name) { return 图层().querySelector('button[data-act="' + name + '"]'); }
  function 舞台矩形() { return 舞台().getBoundingClientRect(); }

  // ── 装配 ─────────────────────────────────────────────────────────
  let v = null;
  let 卸载委托 = null;
  let km = null;
  let 键map命中 = 0;
  let 内存覆盖层被关 = 0;

  async function 装配() {
    造正文();
    // ⚠️ 两张图都要**解码完**：`open()` 的准入判据是 `naturalWidth > 0`（⛔ 不认布局占位尺寸）
    await Promise.all([
      document.getElementById('zoomimg').decode(),
      document.getElementById('linkimg').decode()
    ]);

    v = IV.createImageViewer();
    卸载委托 = IV.installDelegation(docEl, function () { return v; });

    // ⭐ 真实的覆盖层登记处（产品 API，⛔ 不是 stub）：用来验证"开预览 ⇒ 它被关"
    St.registerOverlay('probe-memory', {
      close: function () { 内存覆盖层被关 += 1; }
    });

    // ⭐⭐ 真实的键盘分发器（评审 R1 点名：⛔ 不用 stub）
    km = K.createKeymap({ table: [{ id: 'probe.find', accel: 'Cmd+F', owner: 'web' }], win: window });
    km.register('probe.find', function () { 键map命中 += 1; return true; });
    km.attach();
  }

  /**
   * 等 Swift 把窗口改到别的尺寸。
   * ⚠️ 时序：Swift 在**本阶段开始后**约 600 ms 才 `setContentSize`（两件事同时排上），
   * 所以这里有两条判据：① `innerWidth/Height` 真的变了 ② 页面**收到了 `resize` 事件**
   * （产品的 `onWindowResize` 就挂在那个事件上）。只变了尺寸却没事件 ⇒ 记**跳过**，
   * ⛔ 不记失败——离屏窗口的派发行为是外部依赖，不是本设计的判据。
   */
  function 等resize(基准, ms) {
    return new Promise(function (resolve) {
      let done = false;
      let 见事件 = false;
      function on() { 见事件 = true; }
      window.addEventListener('resize', on);
      const t0 = Date.now();
      const iv = setInterval(function () {
        const 变了 = innerWidth !== 基准[0] || innerHeight !== 基准[1];
        const 等 = Date.now() - t0;
        let how = null;
        if (变了 && 见事件) how = 'resize';
        else if (变了 && 等 > 800) how = 'size-only';
        else if (等 > (ms || 2500)) how = 变了 ? 'size-only' : 'timeout';
        if (!how || done) return;
        done = true;
        clearInterval(iv);
        window.removeEventListener('resize', on);
        帧(2).then(function () { resolve(how); });
      }, 25);
    });
  }

  // ────────────────────────────────────────────────────────────────
  // 阶段 1：判据 1–19、22–25
  // ────────────────────────────────────────────────────────────────
  async function run() {
    await 装配();
    await 帧(2);

    // ⚠️ 环境自证：离屏窗口里**程序性焦点**可能不生效（`edit-chrome-probe` 记过这件事）。
    //    判据 9/13 依赖它 ⇒ 先量一次，不成立就记**跳过**（⛔ 不是失败）。
    const 探针按钮 = document.createElement('button');
    document.body.appendChild(探针按钮);
    探针按钮.focus({ preventScroll: true });
    const 焦点可用 = document.activeElement === 探针按钮;
    document.activeElement.blur && document.activeElement.blur();
    探针按钮.remove();
    检查.push({
      id: 'E', 名: '环境自证：程序性焦点可用 / rAF 在跑', 结果: '通过',
      判据: '仅作记录（判据 9/13 依赖 `焦点可用`；rAF 不来说明这次的时序数不要信）',
      值: { 焦点可用: 焦点可用, hasFocus: document.hasFocus(), rAF超时次数: P.rAF超时 || 0,
            视口: [innerWidth, innerHeight] }
    });

    const zoomImg = document.getElementById('zoomimg');
    const linkImg = document.getElementById('linkimg');

    // ── 1 ────────────────────────────────────────────────────────
    const ok1 = v.open(zoomImg);
    记(1, 'open(data 图) 返回 true，层 hidden === false', ok1 && 图层().hidden === false,
      'open 返回 true ∧ `.image-viewer-layer[hidden] === false`',
      { 返回: ok1, hidden: 图层().hidden });

    // ── 2 ────────────────────────────────────────────────────────
    const 矩形 = 舞台矩形();
    const 期望初始 = Z.initialScale(zoomImg.naturalWidth, zoomImg.naturalHeight, 矩形.width, 矩形.height, Z.FIT_PAD);
    const 状态0 = 读状态();
    记(2, '打开后 transform 的 scale === initialScale（±1e-6）',
      状态0 && 近(状态0.scale, 期望初始, 1e-6),
      '`initialScale(nw, nh, 舞台宽, 舞台高, FIT_PAD)`',
      { 实测: 状态0 && 状态0.scale, 期望: 期望初始, 舞台: [矩形.width, 矩形.height] });

    // ── 3 ────────────────────────────────────────────────────────
    {
      const r = 舞台矩形();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const 前 = 读状态();
      const 锚前 = { x: (cx - r.left - 前.tx) / 前.scale, y: (cy - r.top - 前.ty) / 前.scale };
      const ev = 滚轮(图层().querySelector('.image-viewer-img'),
        { deltaY: -120, clientX: cx, clientY: cy });
      const 后 = 读状态();
      const 锚后 = { x: (cx - r.left - 后.tx) / 后.scale, y: (cy - r.top - 后.ty) / 后.scale };
      记(3, '舞台内 wheel（deltaY < 0）⇒ 比例变大、锚点不变（±0.5 px）、defaultPrevented',
        后.scale > 前.scale && Math.abs(锚后.x - 锚前.x) <= 0.5 && Math.abs(锚后.y - 锚前.y) <= 0.5
          && ev.defaultPrevented === true,
        'scale 变大 ∧ 锚点图像坐标差 ≤ 0.5 px ∧ defaultPrevented === true',
        { 前: 前.scale, 后: 后.scale, 锚差: [锚后.x - 锚前.x, 锚后.y - 锚前.y], prevented: ev.defaultPrevented });
    }

    // ── 4 ────────────────────────────────────────────────────────
    {
      // ⚠️ 前提：比例得大到图比舞台宽，否则平移被"居中"夹住，什么也测不到。
      按键(document.body, { key: '1' }); // 「100%」
      const 起 = 读状态();
      const img = 图层().querySelector('.image-viewer-img');
      const 前x = 起.tx;
      指针(img, 'pointerdown', { clientX: 600, clientY: 500 });
      指针(img, 'pointermove', { clientX: 550, clientY: 460 });
      const 中 = 读状态();
      指针(img, 'pointermove', { clientX: -4000, clientY: -4000 });
      const 超 = 读状态();
      指针(img, 'pointerup', { clientX: -4000, clientY: -4000 });
      const w = 起.scale * 2000;
      const 夹住 = 超.tx <= 1e-9 && 超.tx >= 舞台矩形().width - w - 1e-9;
      const 拖后那一下 = 鼠标(舞台(), 'click', { clientX: 10, clientY: 10 });
      记(4, 'pointerdown/move/up 能平移；拖到超界被夹住；拖动后的那一下 click 不关层',
        中.tx < 前x && 夹住 && 图层().hidden === false,
        '拖动后 tx 变化 ∧ 超界 tx ∈ [sw−w, 0] ∧ 层仍开着（拖动不被当成"点空白"）',
        { 起tx: 前x, 中tx: 中.tx, 超tx: 超.tx, 舞台宽: 舞台矩形().width, 图宽: w, 层开着: 图层().hidden === false });
      void 拖后那一下;
    }

    // ── 6（先于 5：点图不关是"点空白关"的反面）───────────────
    {
      鼠标(图层().querySelector('.image-viewer-img'), 'click', {});
      记(6, '点图片本身 ⇒ **不关**', 图层().hidden === false,
        '点击 `img.image-viewer-img` 后 hidden 仍为 false',
        { hidden: 图层().hidden });
    }

    // ── 5 ────────────────────────────────────────────────────────
    {
      鼠标(舞台(), 'click', {});
      记(5, '点舞台空白 ⇒ 关（hidden === true）', 图层().hidden === true,
        'target === stage 的 click ⇒ `close()`',
        { hidden: 图层().hidden });
    }

    // ── 7 ────────────────────────────────────────────────────────
    {
      // ⚠️⚠️ 零网络判据。⛔ 不能放一个 `src="https://…"` 的 `<img>` 进文档——
      //    那**真的会发请求**。用 `<canvas src="https://…">`：它不会加载任何东西，
      //    而 `open()` 只读 `currentSrc || getAttribute('src')` ⇒ 走的正是第 ② 道闸。
      const 假远程 = document.createElement('canvas');
      假远程.setAttribute('src', 'https://example.com/x.png');
      document.body.appendChild(假远程);
      const ok = v.open(假远程);
      const 层还藏着 = 图层().hidden === true;
      假远程.remove();
      记(7, 'open(非 data:image) 返回 false，层保持隐藏（零网络判据）',
        ok === false && 层还藏着,
        '`isPreviewableSrc` 拒绝 ⇒ false，且层不显示',
        { 返回: ok, hidden: 图层().hidden });
    }

    // ── 8 ────────────────────────────────────────────────────────
    {
      内存覆盖层被关 = 0;
      St.closeOtherOverlays('probe-memory');   // 模拟"设置/查找已经开着"
      v.open(zoomImg);
      const 被关 = 内存覆盖层被关;
      const 主人开时 = St.currentFocusOwner();
      v.close();
      const 主人关后 = St.currentFocusOwner();
      记(8, '开预览 ⇒ 别的覆盖层被关；关预览 ⇒ 焦点主人不再是自己',
        被关 === 1 && 主人开时 === 'image-viewer' && 主人关后 !== 'image-viewer',
        '`closeOtherOverlays(NAME)` ∧ `releaseFocusOwner(NAME)`',
        { 别的覆盖层被关次数: 被关, 开时主人: 主人开时, 关后主人: 主人关后 });
    }

    // ── 9 ────────────────────────────────────────────────────────
    {
      v.open(zoomImg);
      const ev = 按键(document.body, { key: 'Escape' });
      const 关了 = 图层().hidden === true;
      const 焦点回图 = document.activeElement === zoomImg;
      if (焦点可用) {
        记(9, 'Esc ⇒ 关闭，焦点回到打开它的那张图',
          关了 && 焦点回图 && ev.defaultPrevented === true,
          'Esc 关闭 ∧ `activeElement` 回到原图 ∧ defaultPrevented === true',
          { hidden: 图层().hidden, 焦点在图上: 焦点回图, prevented: ev.defaultPrevented });
      } else {
        跳(9, 'Esc ⇒ 关闭，焦点回到打开它的那张图（焦点那半**没判定**）',
          'Esc 关闭可判；"焦点回到图"依赖程序性焦点，离屏窗口里不成立',
          { hidden: 图层().hidden, 焦点在图上: 焦点回图, 焦点可用: 焦点可用 });
      }
    }

    // ── 10：对照组（必须先绿）──────────────────────────────────
    {
      const 前 = 键map命中;
      按键(document.body, { key: 'f', metaKey: true });
      记(10, '⭐ 对照组：预览**没开**时派发 ⌘F ⇒ 真 keymap 计数 +1',
        键map命中 === 前 + 1,
        '没有这一步，"开着时计数不变"既可能是模态生效、也可能是 keymap 根本没装上',
        { 前: 前, 后: 键map命中 });
    }

    // ── 11 ───────────────────────────────────────────────────────
    {
      v.open(zoomImg);
      const 前 = 键map命中;
      const ev = 按键(document.body, { key: 'f', metaKey: true });
      const 后 = 键map命中;
      v.close();
      记(11, '⭐ 预览开着时同一个 ⌘F ⇒ keymap 计数不变 ∧ defaultPrevented',
        后 === 前 && ev.defaultPrevented === true,
        '模态层在**捕获**阶段吞掉修饰键组合（第 ④ 支）',
        { 前: 前, 后: 后, prevented: ev.defaultPrevented });
    }

    // ── 12 ───────────────────────────────────────────────────────
    {
      v.open(zoomImg);
      docEl.scrollTop = 200;
      const 起 = docEl.scrollTop;
      const 键 = ['PageDown', 'PageUp', ' ', 'Home', 'End'];
      const 结果 = 键.map(function (k) {
        return { 键: k, prevented: 按键(document.body, { key: k }).defaultPrevented };
      });
      const 末 = docEl.scrollTop;
      记(12, '⭐ PageDown/PageUp/Space/Home/End ⇒ 每个都 defaultPrevented，且 #doc.scrollTop 不动',
        结果.every(function (x) { return x.prevented === true; }) && 末 === 起,
        '5 个键各 dispatch 一次 ⇒ defaultPrevented === true ∧ scrollTop 不变',
        { 各键: 结果, 起: 起, 末: 末 });
      v.close();
    }

    // ── 13 ───────────────────────────────────────────────────────
    {
      v.open(zoomImg);
      const 层 = 图层();
      const 可聚焦数 = 层.querySelectorAll('button').length;
      let 出界 = 0;
      for (let i = 0; i < 可聚焦数 + 3; i++) {
        按键(document.body, { key: 'Tab' });
        if (!层.contains(document.activeElement)) 出界 += 1;
      }
      for (let i = 0; i < 可聚焦数 + 3; i++) {
        按键(document.body, { key: 'Tab', shiftKey: true });
        if (!层.contains(document.activeElement)) 出界 += 1;
      }
      记(13, '⭐ Tab / ⇧Tab 循环不出层（连按超过层内可聚焦元素个数）',
        焦点可用 ? 出界 === 0 : true,
        焦点可用 ? '`document.activeElement` 始终在层内' : '（跳过判定）',
        { 焦点可用: 焦点可用, 出界次数: 出界, 按钮数: 可聚焦数 });
      if (!焦点可用) {
        检查[检查.length - 1].结果 = '跳过';
        检查[检查.length - 1].判据 = '依赖程序性焦点，离屏窗口里不成立';
      }
      v.close();
    }

    // ── 14 ───────────────────────────────────────────────────────
    {
      v.open(zoomImg);
      const 放大 = 按钮('zoom-in');
      放大.focus({ preventScroll: true });
      const 前 = 读状态().scale;
      const e1 = 按键(放大, { key: 'Enter' });
      const e2 = 按键(放大, { key: ' ' });
      记(14, '⭐ 焦点在「放大」按钮上派发 Enter / Space ⇒ defaultPrevented === false（放行原生激活）',
        e1.defaultPrevented === false && e2.defaultPrevented === false,
        '第 ② 支：落在本层按钮上的 Enter / Space 只拦外传、⛔ 不 preventDefault',
        { Enter: e1.defaultPrevented, Space: e2.defaultPrevented, 比例未变: 读状态().scale === 前 });
      v.close();
    }

    // ── 15 ───────────────────────────────────────────────────────
    {
      v.open(zoomImg);
      const 前 = 读状态().scale;
      const 前数 = 键map命中;
      // ⚠️ `isComposing` 与 `keyCode: 229` 都是 UI Events 的 `KeyboardEventInit` 成员；
      //    哪个在 WebKit 里真的落到事件上，这里如实记下来；**两个都造不出来就记跳过**
      //    （⛔ 不能拿"Escape 关掉了"当失败——那是探针造不出组合态，不是产品坏了）。
      const 探 = new KeyboardEvent('keydown', { isComposing: true, keyCode: 229 });
      const 能造 = 探.isComposing === true || 探.keyCode === 229;
      const ev = 按键(document.body, { key: 'Escape', isComposing: 探.isComposing, keyCode: 探.keyCode });
      const 后数 = 键map命中;
      const 结果 = {
        hidden: 图层().hidden, 比例未变: 读状态().scale === 前,
        事件上的isComposing: ev.isComposing, 事件上的keyCode: ev.keyCode,
        探针能造出isComposing: 探.isComposing, 探针能造出keyCode229: 探.keyCode === 229
      };
      if (!能造) {
        跳(15, '⭐ 组合态（isComposing / keyCode 229）⇒ 不关闭、不缩放（**探针造不出组合态**）',
          'KeyboardEventInit 上两个成员在 WebKit 里都没落地', 结果);
      } else {
        记(15, '⭐ 组合态（isComposing / keyCode 229）⇒ 不关闭、不缩放',
          图层().hidden === false && 读状态().scale === 前 && 后数 === 前数,
          '第 ⑤ 支最优先：只 `stopPropagation`，⛔ 不执行任何动作', 结果);
      }
      v.close();
    }

    // ── 16 ───────────────────────────────────────────────────────
    {
      v.open(zoomImg);
      // ⚠️⚠️ **先把比例挪离 fit**（2026-10-20 补）：刚打开时状态就是 `fit`，
      //    于是 `⌘0` 万一漏进第 ① 支也只会再算一次同样的 fit ⇒ **比例不变照样成立**，
      //    这条判据在"修饰键没挡住"这件事上**一句话都没说**（变异实测：把
      //    `K.hasModifier` 改成恒 `false`，本判据**仍绿**）。
      //    按一下 `1` = 100%（夹具图 320×200、视口远大于它 ⇒ fit 与 1.0 不相等）
      //    ⇒ ⌘0 漏进去会跳回 fit（≠ 1.0）、⌘+ / ⌘− 漏进去会各乘 1.25 / 0.8 ⇒ 三处都看得见。
      按键(document.body, { key: '1' });
      const 前 = 读状态().scale;
      const 数 = 键map命中;
      const 组 = [
        { key: '+', metaKey: true }, { key: '-', metaKey: true }, { key: '0', metaKey: true }
      ].map(function (init) { return 按键(document.body, init).defaultPrevented; });
      记(16, '⭐ ⌘+ / ⌘− / ⌘0 形状 ⇒ keymap 计数不变 ∧ defaultPrevented ∧ 比例不变',
        组.every(function (x) { return x === true; }) && 键map命中 === 数 && 读状态().scale === 前,
        '第 ④ 支：模态内不执行任何应用动作（⚠️ 前提：比例已按 `1` 挪到 1.0，⛔ 不是 fit）',
        { prevented: 组, 计数前: 数, 计数后: 键map命中, 比例未变: 读状态().scale === 前, 前: 前 });
      v.close();
    }

    // ── 17 ───────────────────────────────────────────────────────
    {
      v.open(zoomImg);
      docEl.scrollTop = 300;
      const 滚前 = docEl.scrollTop;
      const 前 = 读状态().scale;
      const 条 = 工具条();
      const ev = 滚轮(条, { deltaY: -120, clientX: 600, clientY: 600 });
      记(17, '⭐ 工具栏上的滚轮 ⇒ 不缩放 ∧ defaultPrevented ∧ 正文滚动位置不变',
        读状态().scale === 前 && ev.defaultPrevented === true && docEl.scrollTop === 滚前,
        '第 17 条与第 3 条的分界：`stage.contains(e.target)` 为假 ⇒ 只 preventDefault',
        { 比例未变: 读状态().scale === 前, prevented: ev.defaultPrevented,
          滚动前: 滚前, 滚动后: docEl.scrollTop });
      v.close();
    }

    // ── 18 ───────────────────────────────────────────────────────
    {
      docEl.scrollTop = 500;
      const 前 = docEl.scrollTop;
      v.open(zoomImg);
      v.close();
      记(18, '⭐ 开 → 关不动正文：`#doc.scrollTop` 仍 500（±0 px）',
        docEl.scrollTop === 前,
        '打开时 `closeBtn.focus({preventScroll:true})`，关闭时还焦点也带 preventScroll',
        { 前: 前, 后: docEl.scrollTop });
    }

    // ── 19 ───────────────────────────────────────────────────────
    {
      docEl.scrollTop = 600;
      v.open(zoomImg);
      docEl.scrollTop = 0;  // 原图被滚到视口外
      v.close();
      // ⚠️⚠️ **这一条在本环境里不是承重的**（2026-10-20 变异 P4 实测：把 `close()` 里的
      //     `focus({preventScroll:true})` 改成 `focus()` ⇒ 本判据**照样绿**）。
      //     根因是**离屏窗口里 `document.hasFocus() === false`**：文档根本没被聚焦，
      //     WebKit 对程序性 `focus()` **不做任何 scroll-into-view** ⇒ 滚不滚都读不出差别。
      //     ⇒ 它只证明"关的时候我们没有主动滚"，⛔ 证明不了 `preventScroll` 那一半。
      //     ⭐ `preventScroll` 的**真正防线**是 `tests/js/imagezoom.test.js` #36（源码级闸门，
      //     P4 打在它上面**立刻红**），另有 §7.5 的真机人工项。
      //     ⭐ 见 `design/0018` §10（「没红」的第三种：环境够不到，⛔ 不是判据不敏感）。
      记(19, '⭐ 原图已出视口时关闭 ⇒ scrollTop 停在 0（不因还焦点而跳回原图）',
        docEl.scrollTop === 0,
        '`focus({preventScroll:true})` 是真实 API，滚动量真的可读；'
          + '⚠️ 离屏窗口 `document.hasFocus()` 恒 false ⇒ 本判据对 preventScroll **不承重**（见 §10）',
        { 关后: docEl.scrollTop, hasFocus: document.hasFocus() });
    }

    // ── 22 ───────────────────────────────────────────────────────
    // ⭐ 两条路**都要走**，⛔ 只测第一条等于没测到 `zoomTarget` 的链接那一支：
    //    ① 鼠标点在**图**上 ⇒ `node.closest('img.rmd-zoomable')` 直接命中（链接根本没参与）
    //    ② 键盘在**外层链接**上按 Enter ⇒ `e.target` 是 `<a>`，图是它的后代
    //       ⇒ **只有**链接那一支能把它找回来（P6 变异就是打这一支，见 design/0018 §10）
    {
      if (location.hash === '#sentinel') location.hash = '';
      const 链接 = document.getElementById('linkwrap');

      const ev1 = 鼠标(linkImg, 'click', {});
      const 开1 = 图层().hidden === false;
      v.close();

      const ev2 = 按键(链接, { key: 'Enter' });
      const 开2 = 图层().hidden === false;
      v.close();

      const hash = location.hash;
      记(22, '⭐ 链接包裹的图：点图 / 键盘激活外层链接**两条路都开**，且链接动作没执行第二次',
        开1 && 开2 && hash !== '#sentinel' && ev1.defaultPrevented === true && ev2.defaultPrevented === true,
        '`zoomTarget` 的**直接命中**与**链接分支**各走一次 ∧ `fire()` 里 preventDefault ＋ stopPropagation',
        { 点图开了: 开1, 链接Enter开了: 开2, hash: hash,
          prevented1: ev1.defaultPrevented, prevented2: ev2.defaultPrevented });
    }

    // ── 23 ───────────────────────────────────────────────────────
    {
      const 前数 = 键map命中;
      const ev = 按键(document.body, { key: 'PageDown' });
      按键(document.body, { key: 'f', metaKey: true });
      记(23, '⭐ 关闭即摘监听：PageDown 不再被 preventDefault，⌘F 让 keymap 计数 +1',
        ev.defaultPrevented === false && 键map命中 === 前数 + 1,
        '`close()` 摘掉 window 捕获监听 ⇒ 背景恢复正常',
        { PageDown_prevented: ev.defaultPrevented, 计数前: 前数, 计数后: 键map命中 });
    }

    // ── 24 ───────────────────────────────────────────────────────
    {
      const pre = document.getElementById('preinert');
      按键(document.body, { key: 'Escape' }); // 确保是关着的
      const 关时 = { doc: docEl.hasAttribute('inert'), pre: pre.hasAttribute('inert') };
      v.open(zoomImg);
      const 开时 = { doc: docEl.hasAttribute('inert'), pre: pre.hasAttribute('inert') };
      v.close();
      const 再关 = { doc: docEl.hasAttribute('inert'), pre: pre.hasAttribute('inert') };
      记(24, '⭐ 背景隔离：开 ⇒ #doc 带 inert；关 ⇒ 摘除；**原来就有的 inert 不被误摘**',
        关时.doc === false && 开时.doc === true && 再关.doc === false
          && 关时.pre === true && 开时.pre === true && 再关.pre === true,
        '`isolateBackground` 只收"原本没有 inert"的节点，`releaseBackground` 只摘自己标记的',
        { 关: 关时, 开: 开时, 再关: 再关 });
    }

    // ── 25 ───────────────────────────────────────────────────────
    {
      内存覆盖层被关 = 0;
      St.closeOtherOverlays('probe-memory');
      const 层 = 图层();
      层.style.display = 'none';   // ← 让舞台量到 0×0（⛔ 不是改产品 CSS，只是这一个元素的内联样式）
      let ok = null;
      let 抛了 = null;
      try { ok = v.open(zoomImg); } catch (e) { 抛了 = String(e); }
      const 结果 = {
        返回: ok, 抛了: 抛了, hidden: 层.hidden,
        主人: St.currentFocusOwner(), doc带inert: docEl.hasAttribute('inert'),
        别的覆盖层被关次数: 内存覆盖层被关
      };
      层.style.display = '';
      记(25, '⭐ 打开失败不改界面：量到 0×0 ⇒ 返回 false、层重新隐藏、别的覆盖层仍开着、背景没 inert',
        抛了 === null && ok === false && 层.hidden === true
          && 结果.主人 === 'probe-memory' && 结果.doc带inert === false && 内存覆盖层被关 === 0,
        '事务式：准入/量尺寸失败 ⇒ 回滚，⛔ 一个别的覆盖层都没被碰过',
        结果);
    }

    // ── E4（补充，⛔ 不是 25 条里的）：`design/0018` §7.7 的那两个数字 ──
    //    ⚠️ 计时口径写清楚：**离屏 WKWebView 里、同一进程内**，`performance.now()`
    //    ⇒ 它量的是"产品代码这一跳"，⛔ 不含真实机器的首次读盘与解码前的等待
    //    （图在计时前已经 `decode()` 过 ⇒ 量的是**打开覆盖层**这一步，不是"图片从磁盘到可见"）。
    {
      // 造一张 ~5 MB 的 data:image/png：**随机噪声压不动** ⇒ 1 像素 ≈ 4 字节。
      const W = 1400, H = 1300;   // 1400×1300×4 ≈ 7.3 MB 原始 ⇒ PNG 噪声 ≈ 5 MB（实测见下）
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      const im = ctx.createImageData(W, H);
      const d = im.data;
      let seed = 12345;
      for (let i = 0; i < d.length; i += 4) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        d[i] = seed & 255;
        d[i + 1] = (seed >> 8) & 255;
        d[i + 2] = (seed >> 16) & 255;
        d[i + 3] = 255;
      }
      ctx.putImageData(im, 0, 0);
      const url = c.toDataURL('image/png');
      const 字节 = Math.round(url.length * 3 / 4);
      const big = document.createElement('img');
      big.className = 'rmd-zoomable';
      big.src = url;
      docEl.appendChild(big);
      await big.decode();

      // ① 点击 → `open()` 返回（⚠️ 走的是**产品那条路**：`installDelegation` 的 click）
      const t0 = performance.now();
      鼠标(big, 'click', {});
      const 一次 = performance.now() - t0;
      const 开了 = 图层().hidden === false;
      v.close();

      // ② 连续开关 10 次（⚠️ 用 `open()/close()` 直接调，⛔ 不掺事件分发的不确定性）
      const 每轮 = [];
      for (let i = 0; i < 10; i++) {
        const a = performance.now();
        v.open(big);
        const b = performance.now();
        v.close();
        const e = performance.now();
        每轮.push({ 开: b - a, 关: e - b, 合计: e - a });
      }
      const 中位 = function (xs) {
        const s = xs.slice().sort(function (x, y) { return x - y; });
        const n = s.length;
        return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
      };
      docEl.removeChild(big);
      记('E4', '§7.7 数字：~5 MB 本地大图的「点击→open 返回」与「10 次开关」',
        开了 === true && 每轮.every(function (x) { return x.合计 >= 0; }),
        '⚠️ 离屏 WKWebView ＋ 图已 decode ⇒ 量的是**打开覆盖层这一步**，'
          + '⛔ 不含首次读盘/解码；中位数取偶数个的均值',
        {
          图字节: 字节, 尺寸: [W, H],
          点击到open_ms: Math.round(一次 * 1000) / 1000,
          开关10次_开中位_ms: Math.round(中位(每轮.map(function (x) { return x.开; })) * 1000) / 1000,
          开关10次_关中位_ms: Math.round(中位(每轮.map(function (x) { return x.关; })) * 1000) / 1000,
          开关10次_合计中位_ms: Math.round(中位(每轮.map(function (x) { return x.合计; })) * 1000) / 1000,
        });
    }

    // ── 给后续阶段留下前提：开着 + 手动比例（⛔ 不依赖 fit）──
    v.open(zoomImg);
    for (let i = 0; i < 6; i++) 按键(document.body, { key: '-' });
    P.手动比例 = 读状态().scale;
    P.视口0 = [innerWidth, innerHeight];

    return {
      检查: 检查, 阶段: 1, 手动比例: P.手动比例, 视口: P.视口0,
      夹具: {
        视口: P.视口0,
        图: [zoomImg.naturalWidth, zoomImg.naturalHeight],
        图源: 'canvas 现生成的 data:image/png（⛔ 不读任何真实资产）',
        正文: '#doc：40 段 40px + 一张图（rmd-zoomable，tabindex=0）'
          + ' + 一个 <a href="#sentinel"> 包着的图 + body 下一个原本就 inert 的 #preinert',
        焦点可用: 焦点可用,
      },
    };
  }

  // ────────────────────────────────────────────────────────────────
  // 阶段 2：判据 20 的前半（窗口放大）
  // ────────────────────────────────────────────────────────────────
  async function runResizeBig() {
    const 起 = 检查.length;
    const how = await 等resize(P.视口0, 2500);
    const r = 舞台矩形();
    const 状态 = 读状态();
    const fit = Z.fitScale(2000, 1000, r.width, r.height, Z.FIT_PAD);
    P.视口0 = [innerWidth, innerHeight];
    if (how !== 'resize' || !状态) {
      跳(20, '⭐ resize 上界：manual 比例不被新的 fit 顶走（窗口没放大，**没判定**）',
        '需要离屏窗口真的收到一次 resize 事件', { how: how, 视口: P.视口0, 状态: 状态 });
    } else if (!(fit > P.手动比例)) {
      // ⚠️ 前提没建立：新的 fit 没有超过手动比例，"会不会被顶走"就问不出来。
      跳(20, '⭐ resize 上界：manual 比例不被新的 fit 顶走（前提不成立，**没判定**）',
        '需要 新 fit > 手动比例', { 新fit: fit, 手动比例: P.手动比例, 舞台: [r.width, r.height] });
    } else {
      记(20, '⭐ resize 上界：窗口放大（新 fit 更大）⇒ manual 比例**仍是**原来那个',
        Math.abs(状态.scale - P.手动比例) < 1e-9 && Number.isFinite(状态.scale) && 状态.scale > 0,
        '`resizeState` 第 ④ 步：`mode === "manual"` ⇒ `scale` 只夹取、⛔ 不跟随 fit',
        { 手动比例: P.手动比例, 新fit: fit, 实测比例: 状态.scale, 舞台: [r.width, r.height] });
    }
    // ⚠️ 只交**本阶段新增**的那几条：`检查` 是全程累积的，整份交回去会被 Swift 重复拼接。
    return { 检查: 检查.slice(起), 阶段: 2 };
  }

  // ────────────────────────────────────────────────────────────────
  // 阶段 3：判据 20 的后半（窗口缩小 ⇒ 比例不许被改成 0）
  // ────────────────────────────────────────────────────────────────
  async function runResizeTiny() {
    const 起 = 检查.length;
    const how = await 等resize(P.视口0, 2500);
    const 状态 = 读状态();
    P.视口0 = [innerWidth, innerHeight];
    const ok = how === 'resize' && 状态
      && Math.abs(状态.scale - P.手动比例) < 1e-9
      && Number.isFinite(状态.scale) && 状态.scale > 0
      && Number.isFinite(状态.tx) && Number.isFinite(状态.ty);
    // ⚠️ 第 20 条已经记过一次；这一阶段**只补充证据**，⛔ 不新开一条判据
    //    （§7.4 的条数就是 25，多报一条会让"25 条"这个数失去意义）。
    检查.push({
      id: 'E2', 名: '（判据 20 的后半：缩小窗口后比例仍是有限正数）',
      结果: ok ? '通过' : (how === 'resize' ? '失败' : '跳过'),
      判据: '§7.4 第 20 条的后半句，作为补充证据与第 20 条合并判读',
      值: { how: how, 手动比例: P.手动比例, 状态: 状态, 视口: P.视口0 }
    });
    return { 检查: 检查.slice(起), 阶段: 3 };
  }

  // ────────────────────────────────────────────────────────────────
  // 阶段 4：判据 21 的前半（缩到几十像素）
  // ────────────────────────────────────────────────────────────────
  async function runResizeMicro() {
    const 起 = 检查.length;
    const how = await 等resize(P.视口0, 2500);
    const r = 舞台矩形();
    let fit = null;
    let 抛了 = null;
    try { fit = Z.fitScale(2000, 1000, r.width, r.height, Z.FIT_PAD); } catch (e) { 抛了 = String(e); }
    const 状态 = 读状态();
    P.视口0 = [innerWidth, innerHeight];
    P.微小fit = fit;
    P.微小比例 = 状态 ? 状态.scale : null;
    检查.push({
      id: 'E3', 名: '（判据 21 的前半：极小舞台 ⇒ fit 有限且 > 0、不抛）',
      // ⚠️ 这一半**只要舞台确实很小**就成立（`fit` 是我们直接问 `fitScale` 的），
      //    ⛔ 不依赖产品有没有收到 `resize` 事件 ⇒ `size-only` 也算前提成立。
      结果: how === 'timeout' ? '跳过'
        : ((抛了 === null && Number.isFinite(fit) && fit > 0) ? '通过' : '失败'),
      判据: '§7.4 第 21 条的前半句（舞台 ≤ 64 px ⇒ fitScale 回落 MIN_SCALE，有限且 > 0）',
      值: { how: how, fit: fit, 抛了: 抛了, 舞台: [r.width, r.height], 视口: P.视口0 }
    });
    return { 检查: 检查.slice(起), 阶段: 4 };
  }

  // ────────────────────────────────────────────────────────────────
  // 阶段 5：判据 21（汇总：再放大 ⇒ 手动比例仍保持）
  // ────────────────────────────────────────────────────────────────
  async function runResizeBack() {
    const 起 = 检查.length;
    const how = await 等resize(P.视口0, 2500);
    const 状态 = 读状态();
    P.视口0 = [innerWidth, innerHeight];
    const 前半 = 检查.filter(function (c) { return c.id === 'E3'; })[0];
    if (how !== 'resize' || !状态 || !前半 || 前半.结果 === '跳过') {
      跳(21, '⭐ resize 极小舞台：fit 有限且 > 0、不抛；再放大 ⇒ 手动比例仍保持（**没判定**）',
        '需要两次 resize 都到、且极小舞台那一半成立',
        { how: how, 微小fit: P.微小fit, 微小比例: P.微小比例, 视口: P.视口0 });
    } else {
      记(21, '⭐ resize 极小舞台：fit 有限且 > 0、不抛；再放大 ⇒ 手动比例仍保持',
        前半.结果 === '通过'
          && Math.abs(状态.scale - P.手动比例) < 1e-9
          && Number.isFinite(状态.scale) && 状态.scale > 0,
        '`fitScale` 留白吃光时回落 `MIN_SCALE`（⛔ 不是 NaN/0），且 `mode=manual` 一直不被顶走',
        { 微小fit: P.微小fit, 微小比例: P.微小比例, 回来后的比例: 状态.scale,
          手动比例: P.手动比例, 视口: P.视口0 });
    }
    // 收尾：关掉，别把 inert 留在页面上（探针页只有一个，但这是习惯）
    try { v.close(); } catch (e) { /* 作罢 */ }
    return { 检查: 检查.slice(起), 阶段: 5 };
  }

  window.__RUN = run;
  window.__RUN_RESIZE_BIG = runResizeBig;
  window.__RUN_RESIZE_TINY = runResizeTiny;
  window.__RUN_RESIZE_MICRO = runResizeMicro;
  window.__RUN_RESIZE_BACK = runResizeBack;
})();
