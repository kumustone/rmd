// rmd · 排版度量的**仿射性**探针（`design/0085` §2.2 步骤 0，`make probe-type-metrics`）
//
// # 它回答什么
//
// C2 的症状是「改字号后，已经进编辑态的块还停在旧 px」。修法要把 `applyBox` 搬的那批
// computed px 换成 `calc(var(--reader-font-size) * k + b)` —— **前提是这条仿射关系真的成立**。
// 本探针就在**阅读态**（唯一的值来源）上验它：六个字号档 × 每类块 × 每个属性，
// 拟合 `px(fs) = k·fs + b`，报告最大残差。
//
// # 为什么判据不是"数字好看"
//
// `typography.css` 明文规定 A 类几何一律 `calc(基准 × 比例)`、B 类物理线宽固定 `1px`
// （该文件头 §2.1.7）⇒ 仿射是**构造上**成立的。本探针的价值在于**证伪**：
// 一旦有人往样式表里塞了一个"14px 看着刚好"的字面量，残差立刻超阈 ⇒ 那条 assertion 才不是空转。
//
// # 口径
//
// · 阈值：最大残差 **≤ 0.5 CSS px**（`design/0085` §7 第 0 条）。WKWebView 的 computed 值是
//   1/64 px 粒度，正常应当 ≈0。
// · 每次改字号后**强制一次布局**（读 `offsetHeight`），⛔ 不靠 `requestAnimationFrame`——
//   显示器睡着时没有帧，会把环境问题误报成产品失败（`docs/kb/0025` 那族）。
// · 探针**只读**：改的是 `documentElement.style` 上的 `--reader-font-size`，结束时恢复原值。

'use strict';

(function () {
  /** 六个字号档（`FONT_SIZE_MIN`..`FONT_SIZE_MAX` 的取样，见 `services/theme.js`）。 */
  const 字号档 = [12, 13, 14, 20, 24, 32];

  /** 要量的属性：与 `src/live/box.js::PROPS` 同一批（⛔ 别只量字号，那样漏掉"只有 margin 不缩放"）。 */
  const 属性 = [
    'fontSize', 'lineHeight', 'fontWeight',
    'marginTop', 'marginBottom',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderLeftWidth',
  ];

  /**
   * 测量目标：选择器取的是**块盒本身**（不是它里面的行内元素），
   * 因为 `applyBox` 搬的正是被换掉的那个顶层元素的 computed 值。
   */
  const 目标 = [
    ['h1', '.doc > h1'],
    ['h2', '.doc > h2'],
    ['h3', '.doc > h3'],
    ['p', '.doc > p'],
    ['blockquote', '.doc > blockquote'],
    ['blockquote>p', '.doc > blockquote > p'],
    ['ul', '.doc > ul'],
    ['ul>li', '.doc > ul > li'],
    ['ol>li', '.doc > ol > li'],
    ['pre', '.doc > pre'],
    ['hr', '.doc > hr'],
    ['table', '.doc > table'],
    ['th', '.doc > table th'],
    ['td', '.doc > table td'],
  ];

  /** 取数值（`normal` / `auto` 这类没有 px 的值返回 `null`，不参与拟合）。 */
  function 数(v) {
    const m = /^(-?[0-9.]+)px$/.exec(String(v));
    return m ? parseFloat(m[1]) : null;
  }

  /** 最小二乘拟合 `y = k·x + b`，返回 `{k, b, 残差}`（残差 = max|y - (kx+b)|）。 */
  function 拟合(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce(function (a, b) { return a + b; }, 0) / n;
    const my = ys.reduce(function (a, b) { return a + b; }, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) * (xs[i] - mx);
    }
    const k = den === 0 ? 0 : num / den;
    const b = my - k * mx;
    let 残差 = 0;
    for (let i = 0; i < n; i++) {
      残差 = Math.max(残差, Math.abs(ys[i] - (k * xs[i] + b)));
    }
    return { k: k, b: b, 残差: 残差 };
  }

  /** 在某个字号档下，量全部目标的全部属性。 */
  function 量一轮() {
    const root = document.documentElement;
    const out = {};
    for (const [名, 选择器] of 目标) {
      const el = document.querySelector(选择器);
      if (!el) { out[名] = null; continue; }
      const cs = getComputedStyle(el);
      const 一项 = {};
      for (const p of 属性) 一项[p] = cs[p];
      out[名] = 一项;
    }
    // ⚠️ 强制一次布局：`getComputedStyle` 只保证**样式**已算，布局不一定已跑。
    void root.offsetHeight;
    void document.body.offsetHeight;
    return out;
  }

  window.__RUN = function () {
    return new Promise(function (resolve) {
      const root = document.documentElement;
      const 原值 = root.style.getPropertyValue('--reader-font-size');
      const 每档 = {};
      try {
        for (const fs of 字号档) {
          root.style.setProperty('--reader-font-size', fs + 'px');
          void root.offsetHeight; // 让这一档生效
          每档[fs] = 量一轮();
        }
      } finally {
        if (原值) root.style.setProperty('--reader-font-size', 原值);
        else root.style.removeProperty('--reader-font-size');
      }

      // ── 逐（目标, 属性）拟合 ──
      const 明细 = [];
      let 最大残差 = 0;
      let 最差 = null;
      for (const [名] of 目标) {
        for (const p of 属性) {
          const xs = [], ys = [];
          for (const fs of 字号档) {
            const 行 = 每档[fs][名];
            if (!行) continue;
            const y = 数(行[p]);
            if (y === null) continue;
            xs.push(fs); ys.push(y);
          }
          if (xs.length < 3) continue; // 常量或取不到 px ⇒ 不参与（下面单列）
          const f = 拟合(xs, ys);
          const 一条 = {
            目标: 名, 属性: p, 值: ys.map(function (v) { return Math.round(v * 1000) / 1000; }),
            k: Math.round(f.k * 10000) / 10000,
            b: Math.round(f.b * 1000) / 1000,
            最大残差: Math.round(f.残差 * 1000) / 1000,
          };
          明细.push(一条);
          if (f.残差 > 最大残差) { 最大残差 = f.残差; 最差 = 一条; }
        }
      }

      const 阈值 = 0.5;
      const 结论 = {
        通过: 最大残差 <= 阈值,
        最大残差: Math.round(最大残差 * 1000) / 1000,
        最差项: 最差,
        阈值: 阈值,
        说明: 最大残差 <= 阈值
          ? '仿射成立：`applyBox` 可以写 calc(var(--reader-font-size) * k + b)'
          : '⛔ 仿射不成立：`src/styles/typography.css` 里有不随基准缩放的量值，先查它，⛔ 别把阈值放宽',
      };

      resolve({
        环境: {
          字号档: 字号档,
          DPR: window.devicePixelRatio,
          视口: [window.innerWidth, window.innerHeight],
          样式表: Array.prototype.map.call(document.styleSheets, function (s) {
            return (s.href || '').split('/').pop();
          }),
        },
        结论: 结论,
        明细: 明细,
      });
    });
  };
})();
