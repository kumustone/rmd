// 拖入窗口的**遮罩状态机** —— `design/0071` §2.2。
//
// # 它服务谁 / 它不做什么
//
// ⭐ 判「这次拖进来的东西能不能开、开哪个、拒绝说哪句」**全在 Rust**
// （`gui/mod.rs::classify_drop`）。这一份只回答一件事：**遮罩现在该不该显示**。
// ⛔ 它不认类型、不读路径、不调任何命令——`INV-OPEN-01` 的落点之一：
// 前端从头到尾拿不到拖放路径（事件只有 `"enter"|"leave"` 两个词）。
//
// # 为什么需要兜底（设计 §2.4 最后一行）
//
// `leave` 是**可以丢的**：拖到窗口边缘又被系统取消、拖到一半切走应用、
// WKWebView 自己吞了一次事件……任何一种都会让遮罩**永久卡在屏幕上**。
// ⇒ 三条清空路径：`leave`（正常）、`drop`（后端在这次 Drop 之后补发一句 leave，
// 前端自己也会在落点时清一次）、窗口失焦（用户已经去看别的窗口了）。
//
// # 可测的那一半
//
// `reduce` 是**纯函数**（`tests/js/drop.test.js`）；
// `createOverlay` 只碰 DOM，且 DOM 由调用方注入（`node --test` 里用假元素也能跑）。
(function () {
  'use strict';

  /** 显示遮罩的事件：只有 `Enter` 一个（`Over` 由后端丢掉，⛔ 不重复发）。 */
  const SHOW = ['enter'];
  /** 清掉遮罩的事件：正常离开 / 落点 / 失焦（三条兜底，任一成立就清）。 */
  const HIDE = ['leave', 'drop', 'blur'];

  /**
   * 状态机（纯函数）：**只认这四个词**，别的一律不动。
   *
   * ⚠️ 不认识的事件**原样返回**（不改 `visible`）：宁可不动，也别把一个
   * 拼错的事件名当成"清空"——那会让遮罩在拖动过程中闪一下。
   *
   * @param {{visible:boolean}} state
   * @param {string} ev
   * @returns {{visible:boolean}}
   */
  function reduce(state, ev) {
    const prev = !!(state && state.visible);
    if (SHOW.indexOf(ev) >= 0) return { visible: true };
    if (HIDE.indexOf(ev) >= 0) return { visible: false };
    return { visible: prev };
  }

  /**
   * @param {object} deps
   *   · `doc` —— 有 `getElementById` 的对象（浏览器 `document`，测试用假对象）
   *   · `el`  —— 遮罩节点（`#drop-overlay`）；缺了只是**不显示**，⛔ 不抛
   */
  function createOverlay(deps) {
    const d = deps || {};
    const el = d.el || (d.doc && d.doc.getElementById ? d.doc.getElementById('drop-overlay') : null);
    let state = { visible: false };

    function paint() {
      if (!el) return;
      el.hidden = !state.visible;
      // ⚠️ `aria-hidden` 跟着走：遮罩**只**是视觉反馈，没有任何可操作内容，
      //    读屏用户不该因为它多听到一层（它也没有可聚焦的东西）。
      el.setAttribute('aria-hidden', state.visible ? 'false' : 'true');
    }

    paint();

    /**
     * 喂一个事件（`"enter"` / `"leave"` / `"drop"` / `"blur"`）。
     * @returns {boolean} 处理之后的可见性
     */
    function send(ev) {
      const next = reduce(state, ev);
      if (next.visible !== state.visible) {
        state = next;
        paint();
      }
      return state.visible;
    }

    return {
      send: send,
      visible: function () { return state.visible; },
      /** 兜底清空（启动 / 出错时调用方可以直接摆平，⛔ 不依赖事件序）。 */
      reset: function () { state = { visible: false }; paint(); },
      element: function () { return el; },
    };
  }

  const api = {
    reduce: reduce,
    createOverlay: createOverlay,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).drop = api;
})();
