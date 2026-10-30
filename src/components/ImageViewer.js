// 图片缩放预览 —— `design/0018-图片缩放预览.md` §2.1/§2.3/§2.5（2026-10-19 已通过）。
//
// # 它是什么
//
// 第四层覆盖层（前三层：设置 / 查找 / `⌘P`）：点正文里的本地图片 ⇒ 全屏看，可缩放、可拖动平移。
// ⭐ **纯前端**：零后端改动、零新命令、零新快捷键、⛔ **零新增网络请求**。
//
// # 四条承重约束（读改这个文件之前先看）
//
// 1. ⭐ **缩放数学不在这里**（`INV-ZOOM-06`）：拟合 / 夹取 / 焦点缩放 / resize 全在
//    `services/imagezoom.js`，本文件只负责"把状态画出来"。⛔ 这里不许出现第二份
//    `Math.min(…)` 形式的适配计算——那样单测就够不到它了。
// 2. ⭐ **只认 `data:image/*`**（`INV-ZOOM-02`）：远程图的 `src` 是 `https:`，
//    预览层若复制它会**可能**再发一次请求（`Cache-Control: no-store` 的情形）
//    ⇒ `open()` 直接返回 false，界面完全不变。本期明确不做远程图预览（§4 边界）。
// 3. ⭐ **打开是事务式的**（§2.3 ③）：先做不碰界面的判据 → 显自己并量尺寸 →
//    量成功才关别的覆盖层、装背景隔离。⛔ 不许"先把查找框关了再说"——
//    准入失败时用户的查找框必须还在。
// 4. ⭐ **键盘是分层的，⛔ 不是一句吞掉全部**（§2.3 ④，评审 R1）：`stopPropagation`
//    不等于 `preventDefault`。只 stop 的话 `PageDown`/`Space` 的**浏览器默认滚动**
//    仍会作用到背景；而按钮的 `Enter`/`Space` 激活又**依赖**默认行为。
//
// # 背焦点隔离
//
// `inert` 在本机 WKWebView **完整支持**（`docs/kb/0009`，含焦点被挡住的实测）
// ⇒ 背景同时失去指针事件、焦点与 a11y 树。⚠️ 仍要单独挡 `wheel` / 触摸：
// `inert` **不阻止**滚动容器的默认滚动。
//
// # ⭐ 为什么 `installDelegation` / `zoomTarget` 也在这个文件里
//
// 离屏探针加载的就是这个文件（⛔ 加载不了 `main.js`，那依赖整棵 Tauri 面）。
// 写进 `main.js` 的话探针只能照抄一份 ⇒ **两条实现必然漂移**。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**（经典脚本共享全局词法作用域，
// 顶层 `const` 撞名会让整个文件不执行 —— 见 `FileTree.js` 的详细说明）。
(function () {
  'use strict';

  // ⭐ `design/0025`：可见文案走字典。本层是**启动时造一次、之后一直复用**的
  //    ⇒ 静态属性用 `data-i18n*`（`applyDom` 会重贴），⛔ 不在这里缓存译文。
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) || null;
  const t = I18N ? I18N.t : function (key) { return key; };

  const Z = (typeof module !== 'undefined' && module.exports) ? require('../services/imagezoom.js') : window.rmd.imagezoom;
  const St = (typeof module !== 'undefined' && module.exports) ? require('./Settings.js') : window.rmd.settings;
  // ⚠️ 「带不带修饰键」只在 `services/keymap.js` 里判（那三个标识符**只许出现在那一份**，
  //    闸门在 `keymap.test.js`）⇒ 这里调它，⛔ 不自己写 `e.metaKey || …`。
  const K = (typeof module !== 'undefined' && module.exports) ? require('../services/keymap.js') : window.rmd.keymap;

  /** 覆盖层登记处里的名字（`INV-ZOOM-04` 的双向互斥靠它）。 */
  const NAME = 'image-viewer';
  /** 方向键每次平移的距离（§2.3 ④ 的「平移 40 px」）。 */
  const PAN_STEP = 40;
  /** 指针位移超过它才算"拖动"（判据是 `|dx| + |dy|`，§2.3 ④ 写的 > 3 px）。 */
  const DRAG_SLOP = 3;

  /** 方向键 → 动作。⚠️ 语义是**滚视口**（同 macOS 预览）：`←` 露出图的左边。 */
  const ARROWS = {
    ArrowLeft: 'pan-left',
    ArrowRight: 'pan-right',
    ArrowUp: 'pan-up',
    ArrowDown: 'pan-down'
  };

  /** 造一个元素。 */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** ⭐ 焦点该还给谁：链接里的图焦点目标是**外层链接**（它本来就可聚焦，
      图本身不再加 `tabindex`——嵌套交互元素是坏结构）；否则就是图自己。 */
  function focusTargetFor(imgEl) {
    if (!imgEl) return null;
    if (typeof imgEl.tabIndex === 'number' && imgEl.tabIndex >= 0) return imgEl;
    const a = imgEl.closest ? imgEl.closest('a[href]') : null;
    return a || null;
  }

  /**
   * 造一个预览层。⭐ **不自动打开**；`main.js` 只在启动时造一次。
   */
  function createImageViewer() {
    // ── DOM ────────────────────────────────────────────────────────
    const root = el('div', 'image-viewer-layer');
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('data-i18n-aria-label', 'viewer.label');
    root.setAttribute('aria-label', t('viewer.label'));

    const caption = el('div', 'image-viewer-caption');

    const stage = el('div', 'image-viewer-stage');
    const img = el('img', 'image-viewer-img');
    img.alt = '';
    img.draggable = false;
    stage.appendChild(img);

    const controls = el('div', 'image-viewer-controls');
    // ⚠️ `100%` 是**初始占位文案**，⛔ 不是字典键：传成键会被贴 `data-i18n="100%"`，
    //    于是换语言时 `applyDom()` 把当前倍率（可能已经是 `250%`）**改回 `100%`**。
    const scaleLabel = el('span', 'image-viewer-scale');
    scaleLabel.textContent = '100%';
    const buttons = {};
    function addBtn(actName, text, extraCls) {
      const b = el('button', 'image-viewer-btn' + (extraCls ? ' ' + extraCls : ''), text);
      b.setAttribute('type', 'button');
      b.dataset.act = actName;
      controls.appendChild(b);
      buttons[actName] = b;
      return b;
    }
    // ⚠️ 按钮文字与 `aria-label` 同源（`viewer.*`）；⛔ 不在这里写中文。
    function addTitledBtn(act, key) {
      const b = addBtn(act, t(key));
      b.setAttribute('data-i18n', key);
      return b;
    }
    addTitledBtn('zoom-out', 'viewer.zoom-out');
    controls.appendChild(scaleLabel);
    addTitledBtn('zoom-in', 'viewer.zoom-in');
    addTitledBtn('fit', 'viewer.fit');
    addTitledBtn('actual', 'viewer.actual');
    addTitledBtn('close', 'viewer.close');

    root.appendChild(caption);
    root.appendChild(stage);
    root.appendChild(controls);
    document.body.appendChild(root);

    // ── 状态 ──────────────────────────────────────────────────────
    let opened = false;
    let st = null;
    let restoreTo = null;
    let unregister = null;
    /** ⭐ 只记"这次由我们加上去的" inert（`INV-ZOOM-05`）。 */
    const inerted = [];
    /** 拖动结束时抑制紧随其后的那一次 click（§2.3 ④）。 */
    let suppressClick = false;
    /** 当前这次按下 → {id, x, y, moved}；不在拖动就是 null。 */
    let drag = null;

    // ── 背景隔离 ──────────────────────────────────────────────────
    function isolateBackground() {
      Array.prototype.slice.call(document.body.children).forEach(function (n) {
        if (n === root || n.hasAttribute('inert')) return; // 已 inert（如收起的侧栏）⇒ 不动
        n.setAttribute('inert', '');
        n.setAttribute('data-viewer-inert', '');
        inerted.push(n);
      });
    }
    function releaseBackground() {
      inerted.forEach(function (n) {
        // ⚠️ 只放行"我们加过标记的"——别人自己设的 inert 不许被我们摘掉。
        if (n.hasAttribute('data-viewer-inert')) {
          n.removeAttribute('inert');
          n.removeAttribute('data-viewer-inert');
        }
      });
      inerted.length = 0;
    }

    // ── 渲染 ──────────────────────────────────────────────────────
    function apply() {
      if (!st) return;
      img.style.transform = Z.toTransform(st);
      scaleLabel.textContent = Z.scaleLabel(st.scale);
    }

    // ── 焦点循环（Tab / ⇧Tab）────────────────────────────────────
    function cycleFocus(back) {
      const list = Object.keys(buttons).map(function (k) { return buttons[k]; });
      if (!list.length) return;
      const cur = document.activeElement;
      let i = list.indexOf(cur);
      if (i < 0) i = back ? 0 : -1;
      const next = back ? (i - 1 + list.length) % list.length : (i + 1) % list.length;
      list[next].focus({ preventScroll: true });
    }

    // ── 动作 ──────────────────────────────────────────────────────
    function zoomBy(factor) {
      if (!st) return;
      st = Z.zoomAt(st, factor, st.sw / 2, st.sh / 2);
      apply();
    }
    function act(name) {
      if (!opened || !st) return;
      if (name === 'zoom-in') zoomBy(Z.ZOOM_STEP);
      else if (name === 'zoom-out') zoomBy(1 / Z.ZOOM_STEP);
      else if (name === 'fit') { st = Z.fitTo(st); apply(); }
      else if (name === 'actual') { st = Z.zoomTo(st, 1, st.sw / 2, st.sh / 2); apply(); }
      // ⚠️ 方向键是**滚视口**：`←` 让图右移，露出左边那一截（同 macOS 预览）。
      else if (name === 'pan-left') { st = Z.panBy(st, PAN_STEP, 0); apply(); }
      else if (name === 'pan-right') { st = Z.panBy(st, -PAN_STEP, 0); apply(); }
      else if (name === 'pan-up') { st = Z.panBy(st, 0, PAN_STEP); apply(); }
      else if (name === 'pan-down') { st = Z.panBy(st, 0, -PAN_STEP); apply(); }
      else if (name === 'close') close();
    }

    // ── 键盘（window 捕获，只在打开期间存在）─────────────────────
    function onModalKeydown(e) {
      if (!opened) return;
      // ⑤ 组合态最优先：不碰默认行为，只阻止外传
      if (e.isComposing || e.keyCode === 229) { e.stopPropagation(); return; }
      // ① 焦点循环：Tab 一律由我们处理（否则焦点会逃到背景）
      if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); cycleFocus(e.shiftKey); return; }
      // ② 原生控件：Enter / Space 落在本层按钮上 ⇒ 放行默认激活，只拦外传
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if ((e.key === 'Enter' || e.key === ' ') && btn && controls.contains(btn)) {
        e.stopPropagation();
        return;
      }
      // ④ 修饰键组合：模态内不执行任何应用动作（⛔ 不让 ⌘F / ⌘E / ⌘S 在背后生效）
      //    ⚠️ 判据在 `services/keymap.js::hasModifier`（那三个标识符只许出现在那一份）。
      if (K.hasModifier(e)) { e.preventDefault(); e.stopPropagation(); return; }
      // ① 模态动作
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); e.stopPropagation(); act('zoom-in'); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); e.stopPropagation(); act('zoom-out'); return; }
      if (e.key === '0') { e.preventDefault(); e.stopPropagation(); act('fit'); return; }
      if (e.key === '1') { e.preventDefault(); e.stopPropagation(); act('actual'); return; }
      if (ARROWS[e.key]) { e.preventDefault(); e.stopPropagation(); act(ARROWS[e.key]); return; }
      // ③ + ⑥：其余一律吞掉默认（⛔ 不让 PageDown / Space 滚背景），也不让全局 keymap 看到
      e.preventDefault();
      e.stopPropagation();
    }

    // ── 指针拖动 ──────────────────────────────────────────────────
    function onPointerDown(e) {
      if (!opened || !st) return;
      if (typeof e.button === 'number' && e.button !== 0) return;
      suppressClick = false;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      stage.classList.add('is-panning');
      // ⚠️ 不支持指针捕获的环境不抛（`try/catch` 是刻意的，不是偷懒）
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 作罢 */ }
    }
    function onPointerMove(e) {
      if (!drag || !st) return;
      if (drag.id !== undefined && e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) <= DRAG_SLOP) return;
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      st = Z.panBy(st, dx, dy);
      apply();
    }
    function endDrag(e) {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      stage.classList.remove('is-panning');
      try { stage.releasePointerCapture(e.pointerId); } catch (err) { /* 作罢 */ }
      // ⭐ 拖过就不许这一下 `click` 把预览关掉
      suppressClick = moved;
    }

    // ── 其余事件 ──────────────────────────────────────────────────
    /** ⚠️ `preventDefault()` **无条件**执行：工具栏/标题上的滚轮也⛔ 不许落到背景。
        只有舞台内的目标才缩放；滚动位置一个像素都不改。 */
    function onWheel(e) {
      e.preventDefault();
      if (!opened || !st) return;
      if (!stage.contains(e.target)) return;
      const r = stage.getBoundingClientRect();
      st = Z.zoomAt(st, Z.wheelFactor(e.deltaY), e.clientX - r.left, e.clientY - r.top);
      apply();
    }
    /** 舞台内挡住触摸滚动；工具栏内放行给按钮。 */
    function onTouchMove(e) {
      if (!opened) return;
      if (e.target && stage.contains(e.target)) e.preventDefault();
    }
    /** 只在 `e.target === stage`（点空白）且不是拖动结束时关。点图片本身不关。 */
    function onStageClick(e) {
      if (!opened) return;
      if (e.target !== stage) return;
      if (suppressClick) { suppressClick = false; return; }
      close();
    }
    function onControlsClick(e) {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn || !controls.contains(btn)) return;
      e.stopPropagation(); // 工具条的点击不许冒到舞台（否则会当成"点空白"）
      act(btn.dataset.act);
    }
    /** ⭐ 窗口 resize：五步顺序在 `resizeState` 里（`INV-ZOOM-13`）。
        ⚠️ 退化尺寸（隐藏 / 未布局）⇒ `resizeState` 原样返回，这里也就不重画。 */
    function onWindowResize() {
      if (!opened || !st) return;
      const r = stage.getBoundingClientRect();
      const next = Z.resizeState(st, r.width, r.height);
      if (next === st) return;
      st = next;
      apply();
    }

    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('click', onStageClick);
    controls.addEventListener('click', onControlsClick);
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('touchmove', onTouchMove, { passive: false });

    // ── 打开 / 关闭 ───────────────────────────────────────────────
    /**
     * ⭐ 事务式：**先做不改变界面的判据 → 再显示自己的层并量尺寸 →
     * 量成功才关别的覆盖层、装背景隔离**（§2.3 ③）。
     * ⇒ 准入失败时，用户原本开着的查找框 / 设置面板**还在**。
     * @returns {boolean} 真的打开了没有
     */
    function open(imgEl) {
      if (opened) return true;
      // ① 还在文档里
      if (!imgEl || !document.contains(imgEl)) return false;
      // ② ⭐ 零网络：只认 data:image/*
      const src = imgEl.currentSrc || imgEl.getAttribute('src');
      if (!Z.isPreviewableSrc(src)) return false;
      // ③ ⭐ 已解码成功（`naturalWidth > 0`；⛔ 不用 `clientWidth` 那种布局占位尺寸）
      const nw = imgEl.naturalWidth;
      const nh = imgEl.naturalHeight;
      if (imgEl.complete === false || !(nw > 0) || !(nh > 0)) return false;

      root.hidden = false;                    // ② 只显自己
      const r = stage.getBoundingClientRect(); // 强制布局（必须在 hidden=false 之后）
      if (!(r.width > 0) || !(r.height > 0)) {
        root.hidden = true;                    // ③ 量不到 ⇒ 回滚到打开前，别的覆盖层一个都没被碰过
        return false;
      }

      // ④ 提交：从这里开始不再有失败路径（全是内存赋值与属性读写）
      St.closeOtherOverlays(NAME);
      isolateBackground();
      restoreTo = focusTargetFor(imgEl);
      opened = true;
      document.body.classList.add('image-viewer-open');
      st = Z.makeState(nw, nh, r.width, r.height, Z.FIT_PAD);
      img.src = src;
      img.alt = imgEl.getAttribute('alt') || '';
      caption.textContent = Z.captionFor(img.getAttribute('alt'), imgEl.dataset ? imgEl.dataset.realPath : '');
      apply();
      window.addEventListener('keydown', onModalKeydown, true);
      window.addEventListener('resize', onWindowResize);
      // ⭐ 不滚背景（评审 R2）
      buttons.close.focus({ preventScroll: true });
      return true;
    }

    /**
     * ⭐ **幂等**：`mountDocument`、`closeOtherOverlays`、`destroy` 都可能重复调它。
     * @param {{restoreFocus?: boolean}} [opts] `restoreFocus === false` 时不动焦点（文档提交用）
     */
    function close(opts) {
      if (!opened) return;
      opened = false;
      window.removeEventListener('keydown', onModalKeydown, true); // ⭐ 关闭即摘监听
      window.removeEventListener('resize', onWindowResize);
      root.hidden = true;
      releaseBackground();
      document.body.classList.remove('image-viewer-open');
      stage.classList.remove('is-panning');
      drag = null;
      suppressClick = false;
      st = null;

      if (!opts || opts.restoreFocus !== false) {
        const back = restoreTo;
        restoreTo = null;
        if (back && typeof back.focus === 'function' && document.contains(back)) {
          // ⭐ preventScroll：恢复焦点**不许**把正文滚到那个元素（评审 R2）
          try { back.focus({ preventScroll: true }); } catch (e) { /* 已不可聚焦就作罢，⛔ 不抛 */ }
        }
      } else {
        restoreTo = null;
      }
      // ⛔ 这里**不**调 `closeOtherOverlays(null)`——那会把别的覆盖层也一起关掉。
      if (St.currentFocusOwner() === NAME) St.releaseFocusOwner(NAME);
    }

    const handle = {
      open: open,
      close: close,
      isOpen: function () { return opened; },
      destroy: function () {
        close({ restoreFocus: false });
        if (unregister) { unregister(); unregister = null; }
        stage.removeEventListener('pointerdown', onPointerDown);
        stage.removeEventListener('pointermove', onPointerMove);
        stage.removeEventListener('pointerup', endDrag);
        stage.removeEventListener('pointercancel', endDrag);
        stage.removeEventListener('click', onStageClick);
        controls.removeEventListener('click', onControlsClick);
        root.removeEventListener('wheel', onWheel, { passive: false });
        root.removeEventListener('touchmove', onTouchMove, { passive: false });
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };

    // ⭐ 注册进唯一那个登记处 ⇒ 与查找 / `⌘P` / 设置**双向互斥**（`INV-ZOOM-04`）。
    unregister = St.registerOverlay(NAME, handle);
    return handle;
  }

  /** 命中一张可预览的图：直接点图，或**键盘激活了包着图的外层链接**。
      ⭐ 这是"看图优先"的**唯一**判据（§2.4/§2.5）——`click` 与 `keydown` 两条路共用。 */
  function zoomTarget(node) {
    if (!node || !node.closest) return null;
    const direct = node.closest('img.rmd-zoomable');
    if (direct) return direct;
    const a = node.closest('a[href]');
    if (!a) return null;
    const inner = a.querySelector('img.rmd-zoomable');
    return inner || null;
  }

  /**
   * `#doc` 上的两条委托（click / keydown）。⭐ 定义在这里而不是 `main.js`：
   * 离屏探针加载不到 `main.js`，放那儿就只能照抄一份 ⇒ 两条实现必然漂移。
   * @returns {Function} 卸载函数
   */
  function installDelegation(docEl, getViewer) {
    if (!docEl) return function () {};
    function fire(img, e) {
      e.preventDefault();  // ⭐ 看图优先：链接（若有）不再执行第二次动作（§2.4）
      e.stopPropagation();
      const v = getViewer();
      if (v) v.open(img);
    }
    function onClick(e) {
      const img = zoomTarget(e.target);
      if (!img) return;
      fire(img, e);
    }
    function onKeydown(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const img = zoomTarget(e.target);
      if (!img) return;
      fire(img, e);
    }
    docEl.addEventListener('click', onClick);
    docEl.addEventListener('keydown', onKeydown);
    return function uninstall() {
      docEl.removeEventListener('click', onClick);
      docEl.removeEventListener('keydown', onKeydown);
    };
  }

  const api = {
    createImageViewer: createImageViewer,
    installDelegation: installDelegation,
    zoomTarget: zoomTarget
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).imageViewer = api;
})();
