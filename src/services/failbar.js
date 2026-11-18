// 全局失败条 —— `#fail-bar` 的**模型与渲染**（`design/0070` §2.3.1）。
//
// # 它服务谁 / 不服务谁
//
// ⭐ 只服务「**没有本地承载面、用户发起、需要用户知道**」的失败（`INV-FAIL-01`）。
// 有锚点的失败必须行内说（启动页段内联 / `#edit-status`）；后台维护与"这次被拒"
// 只进状态条中性提示。⛔ 别把任何一条新失败图省事塞进来——那是评审否决过的形态。
//
// # 三条生命周期规则（⛔ 不是"换文档一律收起"）
//
// ① 同一时刻**只有一条**；`P0` 只能被另一条 `P0` 替换（`INV-FAIL-04`）。
// ② 作用域派生：`doc:<path>` 随当前文档离开；`start` 由启动页接管；
//    `none` / `global` 只按关闭 / 重试成功收起。
// ③ **不自动消失**（`INV-FAIL-03`，与 `INV-EXT-04` / `INV-EDIT-11` 同一条纪律）。
//
// # 可测的那一半
//
// `canReplace` / `scopeAlive` / `pickLevel` 是**纯函数**（`tests/js/failbar.test.js`）；
// `createFailBar` 只碰 DOM，且 DOM 由调用方注入 ⇒ `node --test` 里用假元素也能跑。
(function () {
  'use strict';

  const LEVELS = ['P0', 'P1'];

  /** 级别归一：只认 `P0` / `P1`（其它一律按 `P1`，⛔ 不静默升级）。 */
  function pickLevel(level) {
    return LEVELS.indexOf(level) >= 0 ? level : 'P1';
  }

  /**
   * 新失败能否顶掉当前这条。
   *
   * ⭐ `P0`（数据风险 / 启动阻断）**只**能被另一条 `P0` 替换——
   * 否则"保存失败"会被一条"锚点不存在"顶掉，用户以为已经保存了（`INV-FAIL-04`）。
   * `P1` 之间可互相替换（被替换的那条不排队，但调用方要留下日志）。
   */
  function canReplace(currentLevel, nextLevel) {
    if (!currentLevel) return true;
    return pickLevel(currentLevel) === 'P0' ? pickLevel(nextLevel) === 'P0' : true;
  }

  /**
   * 这条失败的作用域现在还成立吗。
   *
   * @param {{kind:('doc'|'start'|'none'|'global'), path?:string}} scope
   * @param {{docPath?:string|null, startVisible?:boolean}} ctx
   */
  function scopeAlive(scope, ctx) {
    if (!scope) return true;
    if (scope.kind === 'doc') {
      return !!(ctx && ctx.docPath && scope.path === ctx.docPath);
    }
    if (scope.kind === 'start') return !!(ctx && ctx.startVisible);
    // `none` / `global`：没有对象或对象是会话本身 ⇒ 只按关闭 / 重试成功收起。
    return true;
  }

  /**
   * @param {object} deps
   *   · `doc` —— 有 `getElementById` 的对象（浏览器 `document`，测试用假对象）
   *   · `t(key, vars)` —— 字典
   *   · `onShown(spec)` —— 每次**真的显示**一条时调（调用方在这里写诊断）
   *   · `onRejected(spec)` —— 被 `P0` 规则挡下时调（⛔ 不显示，但要留日志）
   *   · `onFallback(text)` —— `#fail-bar` 没建出来时的降级出口（调用方退回状态条）
   */
  function createFailBar(deps) {
    const d = deps || {};
    const doc = d.doc;
    const t = d.t || function (key) { return key; };
    const onShown = d.onShown || function () {};
    const onRejected = d.onRejected || function () {};
    const onFallback = d.onFallback || null;

    const bar = doc && doc.getElementById ? doc.getElementById('fail-bar') : null;
    const textEl = doc && doc.getElementById ? doc.getElementById('fail-text') : null;
    const actsEl = doc && doc.getElementById ? doc.getElementById('fail-actions') : null;
    const detailEl = doc && doc.getElementById ? doc.getElementById('fail-detail') : null;

    let current = null;
    let detailOpen = false;
    let busy = false;

    function available() {
      return !!(bar && textEl && actsEl);
    }

    function actionButton(labelKey, onClick) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'fail-btn';
      b.textContent = t(labelKey);
      b.addEventListener('click', onClick);
      return b;
    }

    function renderActions() {
      while (actsEl.firstChild) actsEl.removeChild(actsEl.firstChild);
      if (!current) return;
      const actions = current.actions || [];
      // ⭐ 上限两个：设计只允许「重试 / 查看详情」，关闭是独立按钮（评审意见 7）。
      for (let i = 0; i < actions.length && i < 2; i++) {
        const a = actions[i];
        const b = actionButton(a.label, function () {
          if (busy) return;
          if (typeof a.run !== 'function') { detailOpen = !detailOpen; render(); return; }
          busy = true;
          renderActions();
          // ⚠️ 成功 = resolve 一个**非 `false`** 的值；失败由调用方再抛一次 `raise`。
          Promise.resolve(a.run()).then(function (ok) {
            if (ok === false) { busy = false; render(); return; }
            close();
          }, function () { busy = false; render(); });
        });
        // ⚠️ 在途时禁用（`design/0070` §7-5：连点只执行一次）。
        b.disabled = busy;
        actsEl.appendChild(b);
      }
      if (current.detail) {
        const b = actionButton('fail.detail', function () {
          detailOpen = !detailOpen;
          render();
        });
        b.disabled = busy;
        b.setAttribute('aria-expanded', detailOpen ? 'true' : 'false');
        actsEl.appendChild(b);
      }
      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'fail-close';
      closeBtn.textContent = t('fail.close');
      // ⚠️ 关闭按钮有 `aria-label` 与 `title`（§2.6）：图形只用文字，⛔ 不画叉。
      closeBtn.setAttribute('aria-label', t('fail.close-hint'));
      closeBtn.title = t('fail.close-hint');
      closeBtn.addEventListener('click', function () { close(); });
      actsEl.appendChild(closeBtn);
    }

    function render() {
      if (!current) {
        if (bar) bar.hidden = true;
        return;
      }
      const text = t(current.key, current.vars);
      textEl.textContent = text;
      textEl.title = text;
      // ⭐ 只有 `P0` 用 `role=alert` ＋ `assertive`（评审意见 8 / `INV-FAIL-06`）。
      const level = pickLevel(current.level);
      bar.setAttribute('role', level === 'P0' ? 'alert' : 'status');
      bar.setAttribute('aria-live', level === 'P0' ? 'assertive' : 'polite');
      bar.setAttribute('data-level', level);
      bar.hidden = false;
      if (detailEl) {
        detailEl.textContent = detailOpen ? String(current.detail || '') : '';
        detailEl.hidden = !detailOpen || !current.detail;
      }
      renderActions();
    }

    /**
     * 显示一条失败。
     *
     * @param {{key:string, vars?:object, level?:string, scope?:object,
     *          actions?:Array<{label:string, run:Function}>,
     *          detail?:string, area?:string}} spec
     * @returns {boolean} 是否真的显示（`P0` 挡下 = `false`）
     */
    function raise(spec) {
      const next = {
        key: spec.key,
        vars: spec.vars || null,
        level: pickLevel(spec.level),
        scope: spec.scope || { kind: 'none' },
        actions: (spec.actions || []).slice(0, 2),
        detail: spec.detail ? String(spec.detail) : '',
        area: spec.area || '',
      };
      if (current && !canReplace(current.level, next.level)) {
        onRejected(next);
        return false;
      }
      current = next;
      detailOpen = false;
      busy = false;
      if (!available()) {
        // ⭐ DOM 缺失是**降级，不是静默**：调用方退回状态条说那一句（§6 失败模型）。
        if (onFallback) onFallback(t(next.key, next.vars));
        current = null;
        return false;
      }
      onShown(next);
      render();
      return true;
    }

    function close() {
      current = null;
      detailOpen = false;
      busy = false;
      if (bar) bar.hidden = true;
      if (actsEl) while (actsEl.firstChild) actsEl.removeChild(actsEl.firstChild);
      if (textEl) { textEl.textContent = ''; textEl.title = ''; }
      if (detailEl) { detailEl.textContent = ''; detailEl.hidden = true; }
    }

    /** 按当前文档 / 启动页可见性收掉已经离开作用域的那条。 */
    function syncScope(ctx) {
      if (!current) return false;
      if (scopeAlive(current.scope, ctx || {})) return false;
      close();
      return true;
    }

    return {
      raise: raise,
      close: close,
      syncScope: syncScope,
      current: function () { return current; },
      available: available,
    };
  }

  const api = {
    pickLevel: pickLevel,
    canReplace: canReplace,
    scopeAlive: scopeAlive,
    createFailBar: createFailBar,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).failBar = api;
})();
