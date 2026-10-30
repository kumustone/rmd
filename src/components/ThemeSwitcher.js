// 工具栏：主题 + 阅读设置（字号 / 行高 / 内容宽度）。
//
// `design/0004` §2.1.4：「切换：工具栏下拉」。
// `design/0005` §2.1.5：字号 / 行高 / 内容宽度**由用户在运行时调整**。
// `design/0004` §9.1 B3：「跟随系统」是**默认提供的一档**。
//
// # ⛔ 这个文件里没有一件事是"样式"
//
// 它只做**把用户的意图交给 `services/theme.js`**，再把生效值显示出来。
// ⛔ 不在这里改 `data-theme`、⛔ 不在这里写 CSS 变量——
//    那会让"谁是真源"变成两个地方。⛔ 也不在这里做钳制：
//    边界在 `theme.js` 里，这里只画按钮的禁用态。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**（经典脚本共享全局词法作用域，
// 顶层 `const` 撞名会让整个文件不执行 —— 见 `FileTree.js` 的详细说明）。
(function () {
  'use strict';

  /**
   * ⭐ `design/0025`（2026-10-21）：这三张表由**文案**改成**字典键**。
   *
   * ⚠️ 顶栏 `<select>` 里的**静态选项**在 `index.html` 里，已经各自带 `data-i18n`
   * （`applyDom` 换语言时重贴）⇒ 这里只剩**自定义项**要现算。
   * 但表本身仍是**共用的那份真值**（与 `Settings.js` 同源），所以一起改成键：
   * 一边留文案、一边留键，等于给同一件事留两种写法。
   */
  const CW_PRESETS = [
    { v: 0, key: 'typo.width.full' },
    { v: 1200, key: 'typo.width.wide' },
    { v: 900, key: 'typo.width.medium' },
    { v: 720, key: 'typo.width.narrow' },
  ];

  const LH_PRESETS = [
    { v: 1.4, key: 'typo.line-height.tight' },
    { v: 1.6, key: 'typo.line-height.normal' },
    { v: 1.8, key: 'typo.line-height.loose' },
  ];

  const THEME_LABELS = {
    system: 'theme.system',
    light: 'theme.light',
    dark: 'theme.dark',
    warm: 'theme.warm',
  };

  /** ⚠️ **惰性取**（⛔ 不在加载期存成常量）——理由同 `Settings.js`。 */
  function i18nApi() {
    return (typeof window !== 'undefined' && window && window.rmd && window.rmd.i18n) || null;
  }

  /** 取一句话。⚠️ 没有 i18n 时回落 **key 本身**（可见、不静默）。 */
  function T(key, vars) {
    const api = i18nApi();
    return api ? api.t(key, vars) : key;
  }

  /**
   * @param {object} opts
   * @param {object} opts.els  工具栏里的元素（⛔ 不在这里查 DOM，便于测试）
   * @param {object} opts.theme `services/theme.js` 的服务
   */
  function createThemeSwitcher(opts) {
    const els = opts.els;
    const theme = opts.theme;

    /** 往 `<select>` 里补一个"自定义"项——⛔ 不假装用户的取值就是某个预设。
        ⚠️ 配置可以被手改（`config.json` 是明文），显示成错误的预设是**静默的谎**。 */
    function ensureOption(sel, value, label) {
      const key = String(value);
      if (sel.querySelector('option[value="' + key + '"]')) return;
      const o = document.createElement('option');
      o.value = key;
      o.textContent = label;
      o.dataset.custom = '1';
      sel.appendChild(o);
    }

    /** 把 `applied` 摊到控件上。⚠️ 单向：只读状态，⛔ 不回写。 */
    function sync() {
      const a = theme.applied;

      els.themeSelect.value = a.mode;

      els.lhSelect.querySelectorAll('option[data-custom]').forEach(function (o) { o.remove(); });
      ensureOption(els.lhSelect, a.lineHeight, T('settings.custom', { value: a.lineHeight }));
      els.lhSelect.value = String(a.lineHeight);

      els.cwSelect.querySelectorAll('option[data-custom]').forEach(function (o) { o.remove(); });
      ensureOption(els.cwSelect, a.contentWidth,
        a.contentWidth === 0 ? T('typo.width.full') : T('settings.custom', { value: a.contentWidth }));
      els.cwSelect.value = String(a.contentWidth);

      els.fsVal.textContent = a.fontSize + ' px';
      els.fsDec.disabled = a.fontSize <= theme.FONT_SIZE_MIN;
      els.fsInc.disabled = a.fontSize >= theme.FONT_SIZE_MAX;

      // ⭐ `INV-THEME-06`：未保存要**看得见**。⛔ 不弹错、⛔ 也不许静默。
      els.saveWarn.hidden = !theme.isDirty();
    }

    els.themeSelect.addEventListener('change', function () {
      theme.setMode(els.themeSelect.value);
    });
    els.lhSelect.addEventListener('change', function () {
      theme.setLineHeight(Number(els.lhSelect.value));
    });
    els.cwSelect.addEventListener('change', function () {
      theme.setContentWidth(Number(els.cwSelect.value));
    });

    // 字号：**一次 1px**。⛔ 不做"按住加速"——那会让"我到底调到了几"变得不可预测，
    // 而当前值就在旁边写着，多按几下比猜便宜。
    els.fsDec.addEventListener('click', function () { theme.setFontSize(theme.applied.fontSize - 1); });
    els.fsInc.addEventListener('click', function () { theme.setFontSize(theme.applied.fontSize + 1); });

    // ⭐ **订阅生效值**（`design/0010` §2.1 ⑤）：原来是构造时传进来的一个 `onChange`。
    //    `0010` 起有**两个**能改外观的表面（这里是顶栏、还有设置覆盖层），
    //    单回调会被后注册的那个顶掉。⛔ 这里**不**自己攒状态——
    //    `sync()` 每次都是从 `theme.applied` 现读（`INV-SET-03`）。
    const unsubscribe = theme.subscribe(sync);

    // ⭐ `design/0025` §2.5.1 层③：换语言后**只能现算**的那两格（"自定义 N"）。
    //    ⚠️ 顶栏的静态标签/选项由 `applyDom` 贴（层①），这里不必再碰。
    //    ⚠️ 与 `Settings.js` 同一个订阅者形状：⛔ 不判"要不要显示"——顶栏永远在。
    const I18N = i18nApi();
    const unsubscribeI18n = I18N ? I18N.subscribe(sync) : function () {};

    return {
      sync: sync,
      detach: function () { unsubscribe(); unsubscribeI18n(); }
    };
  }

  const api = { createThemeSwitcher, CW_PRESETS, LH_PRESETS, THEME_LABELS };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).themeSwitcher = api;
})();
