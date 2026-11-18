// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// 版面搬运：把**被换掉那一块**的盒子量下来，搬到 host 上 —— `design/0047` §2.10。
//
// # 为什么必须有这一份
//
// `swap` 之后，`#doc` 里那个 `<p>` / `<ul>` / `<blockquote>` / `<pre>` 被换成一个 `div`
// （`main.js::swapLiveView`）。而 `.doc` 的版面规则**全写在标签上**（`.doc p`、`.doc ul`…）
// ⇒ 换成 `div` 就**一个都不匹配**了：
//
// | 丢了什么 | 屏幕上的样子 | 等高校验看得见吗 |
// |---|---|---|
// | `margin-bottom: --reader-gap-block`（14px 下 **15.4px**） | 点一下，**下面全文往上蹦一段** | ⛔ **看不见**（高度量的是 border box，不含外边距） |
// | `padding-left`（列表缩进） | 整块**往左跳**一个缩进 | ⛔ **看不见**（横向） |
// | `padding` ＋ `border-left`（引用块） | 竖线消失、字贴到边上 | ✅ 看得见（高度会差出内边距的量）——⚠️ 但 `design/0052` U6 起它**只告警、⛔ 不拦人**（`INV-KERNEL-05`）〔⛔ 2026-11-09：U6 那半作废，"只告警"是**回归网**不是合规；见下〕 |
// | `background`（代码块面板） | 底色消失，代码浮在正文底上 | ⛔ **看不见** |
//
// ⚠️ **前两行与第四行才是这份文件存在的理由**：它们**任何行为判据都碰不到**。
//
// # 为什么是"量下来"而不是"在 CSS 里再写一遍"
//
// `design/0047` §2.10：外观只有一个来源（样式表）。在这里重新写一遍 `.doc p` 的段距，
// 就是**第二份事实**——样式表一改，编辑态与阅读态就分叉，而且分叉只在某几种块上出现。
// 量 `getComputedStyle` 拿的是**样式表算出来的结果**，样式表仍是唯一来源。
//
// ⚠️ 与 §2.10 那句"⛔ 不许从当前文档里恰好存在的那一个块采样"**不矛盾**：那句防的是
//    "文档里没有代码块时，编辑代码块会用错样式"（`notes/0037` §8.5(d)-2）。这里采样的就是
//    **被换掉的那个元素本身**——它必然存在（不然就没有"换掉"这件事），采到的必然是对的。
//
// # 搬不到的那几样（⛔ 别在这里硬搬）
//
// 代码块的**等宽字体**、字号与行高住内层 `.doc pre code` 上（`pre` 自己只有底色与圆角）
// ⇒ 量 `pre` 只会拿到**外面那个壳**的 14px 无衬线（⚠️ 实测：`pre` 12.6px 的代码字在**内层**）。
// 那三样由 `live.css` 的 `.cm-rmd-liveHost.cm-rmd-code` 用**同一批变量**给出
// （不是第二份数值，是同一个 `--reader-*`）；⚠️ 正因为那条规则声明在 `.cm-scroller` 上，
// 它**压过**这里搬过去的行内值——两条路不打架，代码块仍按代码的尺度排版。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，顶层 `const` 撞名会让
// **整个文件不执行**（窗口空白、stderr 全静默）。理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  /**
   * 要搬的属性：`[CSS 属性名, getComputedStyle 上的驼峰名]`。
   *
   * ⭐ **两族**：① **盒子**（外边距 / 内边距 / 左边框 / 圆角 / 底色）；
   * ② **文字层**（字号 / 行高 / 字重）——⚠️ 2026-10-26 补，理由是实测出来的：
   * `h1` 少 **7 px**、`h3` 少 **8.672 px**、引用块多 **15.407 px**（`tools/live-probe --diag`），
   * 因为 `.doc h1` / `.doc blockquote` 那些规则换成 `div` 之后**一条都不匹配**，
   * 而 `live.css` 里钉死一个 `--reader-font-size` 就是**第二份事实**。
   *
   * ⚠️ **字色与字体族仍然不在这里**：三套主题的**正文**字色只由 `--reader-text` 给，
   *    字体族由 `.cm-scroller` 的 sans / `.cm-rmd-code` 的 mono 两档给
   *    （`pre` 自己的 `font-family` 只是继承来的正文无衬线，量它没有意义）。
   *
   * ⚠️⚠️ **标题的字色不是正文色**（`design/0085` C5 纠正的旧说法）：阅读态 `.doc h1`–`.doc h6`
   *    带 `color: var(--reader-heading)`（`typography.css:63`，`--p-gray-900` / dark 下
   *    `#e8e8e8`，都比正文深一档）⇒ 编辑态由 `live.css` 的 `.cm-rmd-hN` 引**同一个变量**。
   *    ⛔ 别把这句话再改回"标题与正文同色"——照那句写出来的代码两态就是不一样深。
   */
  const PROPS = [
    // ⭐ 文字层：块与块之间**真的不一样**（标题 28px/30.8/700、引用 14px/20.3/400…）
    ['font-size', 'fontSize'],
    ['line-height', 'lineHeight'],
    ['font-weight', 'fontWeight'],
    ['margin-top', 'marginTop'],
    ['margin-bottom', 'marginBottom'],
    ['padding-top', 'paddingTop'],
    ['padding-right', 'paddingRight'],
    ['padding-bottom', 'paddingBottom'],
    ['padding-left', 'paddingLeft'],
    ['border-left-width', 'borderLeftWidth'],
    ['border-left-style', 'borderLeftStyle'],
    ['border-left-color', 'borderLeftColor'],
    ['border-top-left-radius', 'borderTopLeftRadius'],
    ['border-top-right-radius', 'borderTopRightRadius'],
    ['border-bottom-left-radius', 'borderBottomLeftRadius'],
    ['border-bottom-right-radius', 'borderBottomRightRadius'],
    ['background-color', 'backgroundColor'],
  ];

  /**
   * 值等于这些就不写（写上去只是把 `style` 属性撑长，效果与"不写"相同）。
   * ⚠️ **`border-left-width: 0px` 必须丢**：真正决定"有没有那条线"的是 `border-left-style`，
   *    而 `none` 也在丢弃名单里 ⇒ 两条一起丢，host 上不会凭空长出一条 3px 的 UA 默认边框。
   */
  const INERT = {
    'none': true,
    'transparent': true,
    '0px': true,
  };

  /**
   * 这个值是不是"什么也没画"（透明底色）。
   *
   * ⚠️ 判据是**按分量算 alpha**，⛔ 不是比对字面量：`getComputedStyle` 给的是它自己算出来的
   *    形状（三个分量表示不透明、四个分量才带 alpha），与作者当初写的那个词无关。
   * ⚠️ 也⛔ 别在这里写一个带圆括号的 `rgb…` **字面量**去比 —— `lint-theme` 闸门 ① 会把
   *    那种形状的字符串判成"写死色值"，而它判得对：那玩意儿不会跟着主题走。
   */
  function isClear(v) {
    if (v === 'transparent') return true;
    if (v.slice(0, 3) !== 'rgb') return false;
    const parts = v.split(',');
    // 三个分量 = 不透明；只有四个分量那一个才带 alpha。
    if (parts.length !== 4) return false;
    return parseFloat(parts[3]) === 0;
  }

  /**
   * ⭐ **纯函数**：`CSSStyleDeclaration`（或任何同形状的对象）→ 要写给 host 的行内样式。
   *
   * @param {object} cs `getComputedStyle(el)`
   * @returns {Object<string, string>} CSS 属性名 → 值（可能为空对象）
   */
  function boxOf(cs) {
    /** @type {Object<string, string>} */
    const out = {};
    if (!cs) return out;
    for (let i = 0; i < PROPS.length; i++) {
      const css = PROPS[i][0];
      const v = cs[PROPS[i][1]];
      if (typeof v !== 'string' || v === '') continue;
      if (INERT[v] === true) continue;
      if (isClear(v)) continue;
      out[css] = v;
    }
    return out;
  }

  /**
   * ⭐ `design/0085` C2（2026-11-15 用户「批准这份设计」）：要搬的**长度**里，
   * 哪些必须写成 `calc(var(--reader-font-size) * k + b)` 而不是裸 px。
   *
   * 症状：`theme.setFontSize()` 只改根变量（`theme.js:196`），已经进编辑态的那块是
   * **swap 时的 px 快照** ⇒ 改字号后它停在旧尺度，直到下一次 swap。
   * ⇒ 把长度属性写成相对根变量的表达式，根变量一变，**所有已挂载的 host 自动重解析**。
   *
   * ⚠️ 只有长度在名单里：`font-weight` / `border-left-style` / `border-left-color` /
   *    `background-color` 不随字号变，原样搬运（写成 `calc(… * 0 …)` 只是噪声）。
   */
  const 尺度 = {
    'font-size': true,
    'line-height': true,
    'margin-top': true,
    'margin-bottom': true,
    'padding-top': true,
    'padding-right': true,
    'padding-bottom': true,
    'padding-left': true,
    'border-left-width': true,
    'border-top-left-radius': true,
    'border-top-right-radius': true,
    'border-bottom-left-radius': true,
    'border-bottom-right-radius': true,
  };

  /** 根变量：`theme.js::apply()` 写在 `documentElement` 上的那一个（唯一的绝对锚点）。 */
  const 根变量 = '--reader-font-size';

  /**
   * 品种 → 系数表（`{k, b}`，与字号**无关** ⇒ 永不过期，换主题也不改尺度）。
   * ⚠️ 键里含类名：同一个标签在不同品种类下量到的盒子可能不同。
   * @type {Object<string, (Object<string, {k:number,b:number}>|null)>}
   */
  const 系数表 = {};

  /** 从 `calc(… + 2px)` 这类值里取数；不是 px 的返回 `null`（`normal` / `auto` / 颜色…）。 */
  function 像素(v) {
    const m = /^(-?[0-9.]+)px$/.exec(String(v));
    return m ? parseFloat(m[1]) : null;
  }

  /** 舍入（k 到 6 位、b 到 3 位 ⇒ 14 px 档下误差 < 1e-4 px）。 */
  function 约(v, 位) {
    const p = Math.pow(10, 位);
    return Math.round(v * p) / p;
  }

  /**
   * ⭐ **纯函数**：仿射系数 → CSS 表达式。
   *
   * `k = 0` ⇒ 这一项根本不随字号变（B 类物理线宽就是这种）⇒ 直接给 `bpx`；
   * `b = 0` ⇒ 纯比例，写最短的那一形；`b ≠ 0` ⇒ 带固定分量（引用条实测 k≈0.2963、b≈−0.513）。
   *
   * @param {number} k 每 1px 根字号换多少 px
   * @param {number} b 固定分量（px）
   * @returns {string} `calc()` 表达式或裸 px
   */
  function 表达式(k, b) {
    const 斜率 = 约(k, 6);
    const 截距 = 约(b, 3);
    if (斜率 === 0) return 截距 + 'px';
    const 基 = 'calc(var(' + 根变量 + ') * ' + 斜率;
    if (截距 === 0) return 基 + ')';
    return 基 + (截距 < 0 ? ' - ' : ' + ') + Math.abs(截距) + 'px)';
  }

  /**
   * ⭐ **纯函数**：两点实测 → `{k, b}`。`px(fs) = k·fs + b`。
   *
   * @param {number} x0 第一档字号（px）
   * @param {number} y0 第一档量到的值（px）
   * @param {number} x1 第二档字号（px）
   * @param {number} y1 第二档量到的值（px）
   * @returns {{k:number, b:number}|null} 两档相同（量不到差别）或算出退化值时返回 `null`
   */
  function 反解(x0, y0, x1, y1) {
    const 差 = x1 - x0;
    if (!isFinite(差) || 差 === 0) return null;
    const k = (y1 - y0) / 差;
    const b = y0 - k * x0;
    if (!isFinite(k) || !isFinite(b)) return null;
    // ⚠️ 负斜率 = 量到了噪声（或那条属性压根不是长度）⇒ 退回裸 px，⛔ 不写一个会倒缩的表达式。
    if (k < 0) return null;
    return { k: k, b: b };
  }

  /**
   * 当前根字号（px）。量不到（主题还没落地 / 宿主没有 DOM）返回 `0`。
   * ⚠️ 先读行内值（`theme.apply` 写的就是行内），再退回 computed —— 只有 `:root` 里
   *    声明过的值才在 computed 上，两者都要问。
   * @returns {number}
   */
  function 根字号() {
    if (typeof document === 'undefined' || !document.documentElement) return 0;
    const 根 = document.documentElement;
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 0;
    let 值 = '';
    if (根.style && typeof 根.style.getPropertyValue === 'function') {
      值 = 根.style.getPropertyValue(根变量);
    }
    if (!值) {
      try {
        值 = window.getComputedStyle(根).getPropertyValue(根变量);
      } catch (e) {
        值 = '';
      }
    }
    const v = parseFloat(值);
    return isFinite(v) && v > 0 ? v : 0;
  }

  /** 按 `PROPS` 把一份 `getComputedStyle` 摘成普通对象（⛔ 不留活引用，见 `量两档`）。 */
  function 摘(cs) {
    /** @type {Object<string, string>} */
    const out = {};
    if (!cs) return out;
    for (let i = 0; i < PROPS.length; i++) {
      const v = cs[PROPS[i][1]];
      out[PROPS[i][0]] = typeof v === 'string' ? v : '';
    }
    return out;
  }

  /**
   * ⭐ 量**第二档**并反解 `k` / `b`（`design/0085` §2.2）。
   *
   * ⚠️ 为什么必须两档：单档只能得到 `k = px ÷ fs`（`b` 恒 0），而实测里 `b` 不总是 0
   *    ——引用条六档实测是 `k ≈ 0.2963 / b ≈ −0.513`（浏览器把 3.43px 的条吸附到 3 / 3.5px），
   *    丢掉 `b` 之后 12px ⇒ 32px 条宽少 1 px（`make probe-type-metrics`）。
   * ⚠️⚠️ 第二档改的是 **`documentElement` 上的根变量**，⛔ 不能改在别处：
   *    `tokens.css` 的派生量（`--reader-gap-block` 等）是 `calc(var(--reader-font-size) …)`，
   *    而自定义属性在**声明它的那个元素**上就完成了替换（后代继承的是算好的值）
   *    ⇒ 只有改根，派生量才会重算。实测踩过：改容器上时 `--reader-gap-block` 一动不动。
   * ⚠️ 代价是**一次全篇重排** ⇒ 按品种缓存（一个会话最多几次），且全程同步、
   *    `finally` 里恢复原值 ⇒ 中间那次布局**不会**被画出来（没有帧就没有闪烁）。
   * ⚠️ `getComputedStyle` 返回的是**活对象**：改回根变量之后它的值就变回去了
   *    ⇒ 必须在恢复之前把值抄进普通对象（`摘`）。
   *
   * @param {object} el 还在文档里的被替换元素
   * @param {Object<string,string>} 第一档 `摘(getComputedStyle(el))`
   * @param {number} fs 当前根字号
   * @returns {Object<string, {k:number,b:number}>|null}
   */
  function 量两档(el, 第一档, fs) {
    if (typeof document === 'undefined' || !document.documentElement) return null;
    const 根 = document.documentElement;
    if (!根.style || typeof 根.style.setProperty !== 'function') return null;
    const 旧值 = 根.style.getPropertyValue(根变量);
    /** @type {Object<string,string>|null} */
    let 第二档 = null;
    try {
      根.style.setProperty(根变量, (fs * 2) + 'px');
      // ⚠️ 强制一次布局：`getComputedStyle` 只保证样式已算，不保证布局已跑；
      //    ⛔ 也别靠 `requestAnimationFrame`（显示器睡着时没有帧，那会把环境问题误报成产品问题）。
      void 根.offsetHeight;
      第二档 = 摘(window.getComputedStyle(el));
    } catch (e) {
      第二档 = null;
    } finally {
      if (旧值) 根.style.setProperty(根变量, 旧值);
      else 根.style.removeProperty(根变量);
    }
    if (!第二档) return null;
    /** @type {Object<string, {k:number,b:number}>} */
    const out = {};
    for (let i = 0; i < PROPS.length; i++) {
      const css = PROPS[i][0];
      if (尺度[css] !== true) continue;
      const y0 = 像素(第一档[css]);
      const y1 = 像素(第二档[css]);
      if (y0 === null || y1 === null) continue;
      const f = 反解(fs, y0, fs * 2, y1);
      if (f) out[css] = f;
    }
    return out;
  }

  /** 品种键：标签名 ＋ 类名（同一个标签套不同品种类时盒子不同）。 */
  function 品种键(el) {
    const tag = el && typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
    const cls = el && typeof el.className === 'string' ? el.className : '';
    return tag + '|' + cls;
  }

  /** 取（或量一次并缓存）这一块所属品种的系数表；量不到返回 `null`（退回裸 px）。 */
  function 系数Of(el, cs) {
    const fs = 根字号();
    if (!(fs > 0)) return null;
    const 键 = 品种键(el);
    if (Object.prototype.hasOwnProperty.call(系数表, 键)) return 系数表[键];
    const 表 = 量两档(el, 摘(cs), fs);
    系数表[键] = 表;
    return 表;
  }

  /**
   * ⭐ **纯函数**：这一块需要哪个"品种类"（`live.css` 里补那几样搬不动的）。
   *
   * ⚠️ 判据是**标签名**而不是块表里的 `kind`：`swap` 在 `mountDocument` 之后会被重跑
   *    （`index.js::reseat`），那时用户可能刚把一段敲成了列表 —— 块表是新的，而视图是旧的。
   *    标签名**永远来自当前树上那个节点**，⛔ 不会旧。
   *
   * @param {object} el `#doc` 的直接孩子
   * @returns {string} 形如 `' cm-rmd-code'`（没有就空串，直接拼在 `className` 后面）
   */
  function classNameOf(el) {
    if (!el || typeof el.tagName !== 'string') return '';
    const tag = el.tagName.toLowerCase();
    // ⚠️ 目前只有代码块需要：字体/字号/行高住在内层 `.doc pre code`，量 `pre` 量不到。
    if (tag === 'pre') return ' cm-rmd-code';
    return '';
  }

  /**
   * ⭐ **纯函数**：这一块原来的品种是不是标题，是几级（`bugs/0015`）。
   *
   * 搬过去的文字层是**块级**的 ⇒ 标题块里长出来的第二行、第三行**全都**是 28px/700，
   * 用户看到的是"回车之后一直是标题，进不了正文"。行级尺度由 `decorations.js` 按**源码**给
   * （`#` 开头才是标题），这里只回答"块基线是不是标题尺度、要不要给非标题行加回落类"。
   *
   * ⚠️ 与 `classNameOf()` 同一个口径：认**标签名**，⛔ 不认块表里的 `kind`
   *    （`reseat` 之后块表是新的、树上的节点是旧的，标签名永远来自当前那个节点）。
   *
   * @param {object} el `#doc` 的直接孩子
   * @returns {number} 0（不是标题）/ 1–6
   */
  function headingLevelOf(el) {
    if (!el || typeof el.tagName !== 'string') return 0;
    const m = /^H([1-6])$/.exec(el.tagName.toUpperCase());
    return m ? Number(m[1]) : 0;
  }

  /**
   * 把 `boxOf()` 的结果写进 host（唯一的写入口，⛔ 别在别处再摊一份）。
   *
   * ⭐ `design/0085` C2 起：**长度**写成 `calc(var(--reader-font-size) * k + b)`
   * ⇒ 用户改字号时这一块**跟着重解析**，不再停在 swap 那一刻的 px 快照上。
   * ⚠️ 量不到根字号 / 量不到第二档（老内核、离屏假 DOM）⇒ 退回裸 px（旧行为）。
   */
  function applyBox(host, el) {
    if (!host || !host.style || !el) return;
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return;
    const cs = window.getComputedStyle(el);
    if (!cs) return;
    const box = boxOf(cs);
    const 系数 = 系数Of(el, cs);
    const 名单 = Object.keys(box);
    for (let i = 0; i < 名单.length; i++) {
      const css = 名单[i];
      const f = 系数 && 尺度[css] === true ? 系数[css] : null;
      host.style.setProperty(css, f ? 表达式(f.k, f.b) : box[css]);
    }
  }

  const api = {
    boxOf: boxOf,
    classNameOf: classNameOf,
    headingLevelOf: headingLevelOf,
    applyBox: applyBox,
    // ⭐ `design/0085` C2 的三块纯逻辑（判据直接钉它们，⛔ 不只钉 `applyBox` 的黑盒行为）
    表达式: 表达式,
    反解: 反解,
    尺度: 尺度,
    PROPS: PROPS,
    INERT: INERT,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveBox = api;
})();
