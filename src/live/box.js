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
// | `padding` ＋ `border-left`（引用块） | 竖线消失、字贴到边上 | ✅ 看得见（高度会差出内边距的量）——⚠️ 但 `design/0052` U6 起它**只告警、⛔ 不拦人**（`INV-KERNEL-05`） |
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
   * ⚠️ **字色与字体族仍然不在这里**：三套主题的字色只由 `--reader-text` 给（标题与正文同色），
   *    字体族由 `.cm-scroller` 的 sans / `.cm-rmd-code` 的 mono 两档给
   *    （`pre` 自己的 `font-family` 只是继承来的正文无衬线，量它没有意义）。
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

  /** 把 `boxOf()` 的结果写进 host（唯一的写入口，⛔ 别在别处再摊一份）。 */
  function applyBox(host, el) {
    if (!host || !host.style || !el) return;
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return;
    const box = boxOf(window.getComputedStyle(el));
    Object.keys(box).forEach(function (k) {
      host.style.setProperty(k, box[k]);
    });
  }

  const api = {
    boxOf: boxOf,
    classNameOf: classNameOf,
    headingLevelOf: headingLevelOf,
    applyBox: applyBox,
    PROPS: PROPS,
    INERT: INERT,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveBox = api;
})();
