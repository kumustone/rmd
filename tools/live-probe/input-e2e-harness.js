// rmd · 端到端输入探针的**页面侧**（`design/0062` §2.1 / `design/0062` §3）。
//
// ⭐ 本文件是**薄动作 / 快照面**，只做三件事：
//   ① 把原生的键 / 组合事件在 DOM 这一侧的**事实**记下来（顺序、`defaultPrevented`、焦点）；
//   ② 用真实的鼠标按下**进入**产品自己的块 / 表格格编辑（⛔ 不调视图 API 去"伪造进入"）；
//   ③ 给 Swift 侧一个可 JSON 化的快照（块文档、选区、焦点、提交字节、IPC 次数）。
//
// ⛔ 本文件**不复制第二份产品实现**：不重算正文、不模拟输入状态机、不写期望串；
//    期望值在 Swift 侧按 `design/0062` §2.3 的组别逐条给（独立常量或产品不变量）。
// ⛔ 不碰真剪贴板、不发起真 IPC、不写磁盘（页面跑的是 `fake-tauri.js`）。
//
// 用法（Swift 侧 `callAsyncJavaScript` 调用）：
//   await window.__E2E.就绪()             → {ok, 块数}
//   await window.__E2E.进入块(i)          → {ok, 焦点, 输入框}
//   await window.__E2E.进入格(fallback)   → {ok, 焦点, 本格}
//   window.__E2E.快照()                   → 快照对象
//   window.__E2E.清空事件()               → 清空事件日志（只清日志，不碰产品状态）

(function () {
  'use strict';

  var 日志 = [];
  var 上限 = 400;
  var 序 = 0;
  var 事件类 = [
    'keydown', 'keyup', 'beforeinput', 'input',
    'compositionstart', 'compositionupdate', 'compositionend',
  ];

  function 描述(el) {
    if (!el) return null;
    var 名 = String(el.tagName || '').toLowerCase();
    var 类 = String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    return 名 + (el.id ? '#' + el.id : '') + (类 ? '.' + 类 : '');
  }

  function 记(类名, e) {
    var 条 = {
      序: ++序,
      类: 类名,
      key: typeof e.key === 'string' ? e.key : '',
      data: e.data === undefined ? null : e.data,
      inputType: typeof e.inputType === 'string' ? e.inputType : '',
      目标: 描述(e.target),
      // ⚠️ 捕获阶段这里**必然**是 false（产品的处理器还没跑）；`keydown` 另有一条
      //    冒泡监听把**最终**状态补到同一条记录上（`防`）。
      防: !!e.defaultPrevented,
      composing: e.isComposing === true || !!e.composition,
      shift: !!e.shiftKey,
      meta: !!e.metaKey,
    };
    日志.push(条);
    if (日志.length > 上限) 日志.shift();
    return 条;
  }

  事件类.forEach(function (t) {
    window.addEventListener(t, function (e) { 记(t, e); }, true);
  });
  // ⚠️ 冒泡末端的**第二眼**：产品的 `preventDefault()` 只有在这里才看得见。
  window.addEventListener('keydown', function (e) {
    for (var i = 日志.length - 1; i >= 0; i--) {
      if (日志[i].类 === 'keydown' && 日志[i].防 !== true) {
        日志[i].防 = !!e.defaultPrevented;
        break;
      }
    }
  }, false);

  // ── DOM / 视图读数（只读产品暴露的东西）─────────────────────────────
  function docEl() { return document.getElementById('doc'); }
  function 块节点() {
    var d = docEl();
    var LB = window.rmd && window.rmd.liveBlocks;
    return d && LB && typeof LB.topNodes === 'function' ? LB.topNodes(d) : [];
  }
  function 主机() { return docEl() ? docEl().querySelector('.cm-rmd-liveHost') : null; }
  function 输入框() { return document.querySelector('textarea.cm-rmd-input'); }
  function 视图() {
    try {
      var CM6 = window.rmdCM6;
      if (!CM6 || !CM6.EditorView || typeof CM6.EditorView.findFromDOM !== 'function') return null;
      return CM6.EditorView.findFromDOM(主机()) || null;
    } catch (e) { return null; }
  }
  function 焦点() {
    var a = document.activeElement;
    return { 是谁: 描述(a), 是输入框: !!(a && a.classList && a.classList.contains('cm-rmd-input')) };
  }
  function 帧() {
    return new Promise(function (r) {
      var done = false;
      var fin = function () { if (!done) { done = true; r(true); } };
      try { window.requestAnimationFrame(fin); } catch (e) { void e; }
      setTimeout(fin, 300); // ⚠️ 离屏窗口可能被节流；兜底只影响"等多久"，不改判据
    });
  }
  async function 帧们(n) { for (var i = 0; i < n; i++) await 帧(); }
  async function 等(fn, ms) {
    var 起 = Date.now();
    while (Date.now() - 起 < ms) {
      var v = fn();
      if (v) return v;
      await 帧();
    }
    return null;
  }

  /** 真 `mousedown`（走产品的 `onLiveDocDown`，⛔ 不调视图 API 伪造进入）。 */
  function 点(el, where) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var x = where === 'end' ? r.right - 6 : r.left + Math.min(8, Math.max(2, r.width / 2));
    var y = r.top + Math.min(8, Math.max(2, r.height / 2));
    el.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      clientX: Math.round(x), clientY: Math.round(y), view: window,
    }));
    return true;
  }

  /** 第一张表的所有格子（行优先）。 */
  function 格们() {
    var 表 = null;
    var 全部 = 块节点();
    for (var i = 0; i < 全部.length; i++) {
      if (全部[i] && 全部[i].tagName === 'TABLE') { 表 = 全部[i]; break; }
    }
    var out = [];
    if (!表 || !表.rows) return out;
    for (var r = 0; r < 表.rows.length; r++) {
      for (var c = 0; c < 表.rows[r].cells.length; c++) out.push(表.rows[r].cells[c]);
    }
    return out;
  }

  /** 当前编辑宿主若落在表格格里，返回它在**第一张表**里的行优先序号（⛔ 否则 null）。 */
  function 格序号() {
    var h = 主机();
    if (!h) return null;
    var el = h.parentElement;
    if (!el || (el.tagName !== 'TD' && el.tagName !== 'TH')) return null;
    var row = el.parentElement;
    if (!row || row.tagName !== 'TR') return null;
    var sec = row.parentElement;
    var 表 = sec && sec.tagName === 'TABLE' ? sec : (sec ? sec.parentElement : null);
    if (!表 || 表.tagName !== 'TABLE') return null;
    var n = 0;
    for (var r = 0; r < 表.rows.length; r++) {
      var 格 = 表.rows[r].cells;
      for (var c = 0; c < 格.length; c++) {
        if (格[c] === el) return n;
        n++;
      }
    }
    return null;
  }

  function 快照() {
    var v = 视图();
    var 插件 = window.__FAKE && window.__FAKE.counts ? window.__FAKE.counts : {};
    var ipc = window.__IPC || [];
    var 最近 = null;
    for (var i = ipc.length - 1; i >= 0; i--) {
      if (ipc[i] && ipc[i].cmd === 'render_preview') { 最近 = ipc[i]; break; }
    }
    var 保存 = null;
    for (var j = ipc.length - 1; j >= 0; j--) {
      if (ipc[j] && ipc[j].cmd === 'save_document') { 保存 = ipc[j]; break; }
    }
    return {
      在编辑态: !!主机(),
      格序号: 格序号(),
      块文本: v && v.state && v.state.doc ? v.state.doc.toString() : null,
      选区: v && v.state && v.state.selection
        ? { from: v.state.selection.main.from, to: v.state.selection.main.to,
            head: v.state.selection.main.head }
        : null,
      焦点: 焦点(),
      提交次数: 插件.render_preview || 0,
      保存次数: 插件.save_document || 0,
      最近提交: 最近 && 最近.args && typeof 最近.args.text === 'string' ? 最近.args.text : null,
      最近保存: 保存 && 保存.args && typeof 保存.args.text === 'string' ? 保存.args.text : null,
      全文: (最近 && 最近.args && typeof 最近.args.text === 'string')
        ? 最近.args.text
        : String((window.__FIXTURE || {}).text || ''),
      事件: 日志.slice(),
      错误: (window.__ERR || []).slice(0, 8),
    };
  }

  window.__E2E = {
    /** 等 `n` 帧（离屏可能被节流，内部有 300 ms 兜底，只影响"等多久"）。 */
    async 等帧(n) { await 帧们(n); return true; },

    async 就绪() {
      var p = await 等(function () { return window.__rmd && window.__rmd.payload; }, 15000);
      if (!p) {
        return { ok: false, 原因: '载荷 15 秒内没就绪', 错误: (window.__ERR || []).slice(0, 8) };
      }
      await 帧们(2);
      return { ok: true, 块数: (p.blocks || []).length };
    },

    /** 进入第 `i` 块的编辑态（点它第一行的右端）。 */
    async 进入块(i) {
      var 表 = 块节点();
      if (!表[i]) return { ok: false, 原因: '没有第 ' + i + ' 块（共 ' + 表.length + '）' };
      var 旧 = 主机();
      点(表[i], 'end');
      var h = await 等(function () { var x = 主机(); return x && x !== 旧 ? x : null; }, 4000);
      if (!h) return { ok: false, 原因: '4 秒内没进编辑态' };
      await 帧们(1);
      return { ok: true, 焦点: 焦点(), 有输入框: !!输入框() };
    },

    /** 进入第一张表的第 `idx` 格（`idx` 是行优先序号）。 */
    async 进入格(idx) {
      var g = 格们();
      if (!g.length) return { ok: false, 原因: '夹具里没有表格' };
      if (idx < 0 || idx >= g.length) return { ok: false, 原因: '格序号越界：' + idx + '/' + g.length };
      点(g[idx]);
      var h = await 等(function () {
        var x = 主机();
        return x && x.classList && x.classList.contains('cm-rmd-cell') ? x : null;
      }, 4000);
      if (!h) return { ok: false, 原因: '4 秒内没进格编辑态' };
      await 帧们(1);
      return { ok: true, 焦点: 焦点(), 有输入框: !!输入框(), 格数: g.length };
    },

    /** 把第 `i` 块**新的表格行**当作行（表格格内 `Tab` 判据用）。 */
    快照: 快照,
    清空事件() { 日志.length = 0; 序 = 0; return true; },
    格数() { return 格们().length; },

    /**
     * 走**真实粘贴事件路径**（与 `block-harness.js` 同口径，⛔ 不碰真剪贴板）。
     * 返回 `false` ⇒ WebKit 造不出 `ClipboardEvent`/`DataTransfer`（调用方如实判红并写原因）。
     */
    async 粘贴(text) {
      var ta = 输入框();
      if (!ta) return false;
      try {
        var dt = new DataTransfer();
        dt.setData('text/plain', String(text));
        ta.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt, bubbles: true, cancelable: true,
        }));
        return true;
      } catch (e) {
        return false;
      }
    },
  };
})();
