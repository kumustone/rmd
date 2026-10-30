// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// 辅助技术（VoiceOver）的落点 —— `design/0047` §2.7 的**候选方案①**。
//
// # 为什么需要一个"镜像"（⛔ 不是"顺手加个 aria")
//
// 阅读—编辑的编辑态有两个**故意**的结构：原块 `display:none`、`contentDOM` **永不聚焦**
// （`INV-LIVE-12`，否则 WebKit 会自己排版组合串 ⇒ `F6` 失守）。两者叠起来，辅助技术读到的
// **不是**编辑内容：原块不可见，新视图里没有可聚焦的编辑面。
// ⇒ 方案①：给 host 一个 `role="textbox"` ＋ `aria-multiline="true"`，并用
// **`aria-valuetext` 镜像"当前行 ＋ 行列号"**——AT 至少能读到"正在改哪一行、改成什么"。
//
// # 三条边界（⛔ 别扩大）
//
// 1. ⛔ **不设 `tabindex`**：方案①只管"读得出来"，不管"键盘能进"。给 host `tabindex=0`
//    会造出**第二个可聚焦的编辑面**，而焦点进它之后既没有插入符也不会收到输入（输入走离屏
//    `textarea`，见 `input.js`）——那比"读不到"更像坏了。⚠️ 这是**已知缺口**，登记在 §7.3。
// 2. ⛔ **不用 `aria-live` 报每次按键**：来回移动光标会把屏幕阅读器淹没。只报**提交结果 /
//    被拒原因**这一类"用户按了之后才发生"的事件（`announce()`）。
// 3. ⭐ **镜像文本必须有上限**：`fullText` 里一行可以有上兆字节（`notes/0037` §8.5 的
//    10 MB 单一顶层块）。`aria-valuetext` 不做上限等于让 AT 读一部小说，
//    而且那个字符串每次选区变化都要重建。⇒ 截到 `MAX_TEXT`，并按**码点**截，
//    ⛔ 不切断代理对（切断了是个替换字符，AT 会读"未知字符"）。
//
// ⚠️ 屏幕上**没有**任何可见文案出自本文件（`aria-valuetext` / `aria-label` / `role=status`
//    都是给 AT 读的）。但它们的字符串仍然走 `t()`——键在 `services/i18n.js` 的 `live.a11y-*`，
//    ⛔ 不在这里拼中文（`INV-I18N-04` 的同族理由：拼出来的双语一定有一半是错的）。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，顶层 `const` 撞名会让
// **整个文件不执行**（窗口空白、stderr 全静默）。理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  /** `aria-valuetext` 里正文的上限（UTF-16 码元）。⚠️ 只影响朗读，⛔ 不影响文档。 */
  const MAX_TEXT = 200;

  /**
   * 按**码点**截断：`slice` 会把代理对切一半（🌰 这类字符会变成一个替换字符）。
   * @returns {string}
   */
  function truncate(s, max) {
    const src = String(s === undefined || s === null ? '' : s);
    if (src.length <= max) return src;
    let out = src.slice(0, max);
    const last = out.charCodeAt(out.length - 1);
    // 高代理项结尾 ⇒ 退一格（低代理项被截掉之后它已经没有搭档了）。
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
    return out;
  }

  /**
   * ⭐ **纯逻辑**：算出 `aria-label` / `aria-valuetext` 的两段文本。
   *
   * @param {object} doc 适配器（与 `selection.js` 同一套）：`{length, lines, lineAt(pos)}`
   * @param {{anchor:number, head:number}} sel 视图内偏移（0-based，UTF-16）
   * @param {{t?:function, lineOffset?:number, maxText?:number}} [opts]
   *   ⚠️ 三个键**都可缺省**：`const o = opts || {}` 里那个 `{}` 必须能赋给这个类型
   *   （`design/0052` U8 踩过：不全可选 ⇒ 每一次 `o.t` 都被报成「属性不存在」）。
   *   `lineOffset` = 这块之前有多少行（0-based）⇒ 报给用户的是**全文行号**，
   *   ⛔ 不是"块内第 3 行"（用户看不见块边界，报块内行号会把人送错地方）。
   * @returns {{label:string, value:string, line:number, col:number, chars:number}}
   */
  function describe(doc, sel, opts) {
    const o = opts || {};
    const t = o.t || function (k) {
      return k;
    };
    const offset = Number.isInteger(o.lineOffset) ? o.lineOffset : 0;
    const max = Number.isInteger(o.maxText) ? o.maxText : MAX_TEXT;

    const a = sel && Number.isInteger(sel.anchor) ? sel.anchor : 0;
    const h = sel && Number.isInteger(sel.head) ? sel.head : a;
    const from = Math.min(a, h);
    const to = Math.max(a, h);
    const chars = to - from;

    const line = doc.lineAt(Math.max(0, Math.min(from, doc.length || 0)));
    const lineNo = line.number + offset;
    const col = from - line.from + 1;
    const body = chars > 0 ? doc.lineAt(Math.max(0, Math.min(to, doc.length || 0))) : null;

    // 选区跨行时正文取"从起点到终点"的一整段；单行时就是那一行。
    // ⚠️ 两种取法都要走 `truncate`：跨行那一段可能是一整篇。
    let text;
    if (chars > 0) {
      const end = body && body.number !== line.number ? to : Math.min(to, line.to);
      text = truncate(slice(doc, from, end), max);
      if (text.length === 0) text = t('live.a11y-blank');
      return {
        label: t('live.a11y-label'),
        value: t('live.a11y-selection', { line: lineNo, col: col, chars: chars, text: text }),
        line: lineNo,
        col: col,
        chars: chars,
      };
    }

    text = truncate(line.text, max);
    if (text.length === 0) text = t('live.a11y-blank');
    return {
      label: t('live.a11y-label'),
      value: t('live.a11y-value', { line: lineNo, col: col, text: text }),
      line: lineNo,
      col: col,
      chars: 0,
    };
  }

  /** 从适配器取 `[from, to)` 的子串。⚠️ 只用于朗读，⛔ 不进任何索引空间的计算。 */
  function slice(doc, from, to) {
    const out = [];
    let pos = from;
    while (pos < to) {
      const l = doc.lineAt(pos);
      const end = Math.min(to, l.to);
      out.push(l.text.slice(pos - l.from, end - l.from));
      if (l.to >= to) break;
      out.push('\n');
      pos = l.to + 1;
    }
    return out.join('');
  }

  /**
   * 把方案①**挂到** host 上。
   *
   * @param {object} host 编辑块的容器（`div.cm-rmd-liveHost`）
   * @param {{t?:function, lineOffset?:number, createEl?:function}} [deps]
   *   `createEl` 只为 node 测试注入（真实现用 `document.createElement`）。
   * @returns {{sync:function, announce:function, label:function, destroy:function}}
   */
  function attach(host, deps) {
    const d = deps || {};
    const t = d.t || function (k) {
      return k;
    };
    const createEl =
      d.createEl ||
      function (tag) {
        return document.createElement(tag);
      };

    host.setAttribute('role', 'textbox');
    host.setAttribute('aria-multiline', 'true');
    host.setAttribute('aria-label', t('live.a11y-label'));

    // ⭐ 通告区先建好再改文字：`aria-live` 节点**后插入**时，多数 AT 不会读第一段。
    const live = createEl('div');
    live.className = 'cm-rmd-liveAnnouncer';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    host.appendChild(live);

    let lastAnnounce = null;

    return {
      /** 选区变了 ⇒ 重写 `aria-valuetext`（⛔ 不 dispatch、⛔ 不碰文档）。 */
      sync: function (doc, sel) {
        const info = describe(doc, sel, { t: t, lineOffset: d.lineOffset });
        host.setAttribute('aria-valuetext', info.value);
        return info;
      },

      /** 给 AT 播报一句（提交结果 / 被拒原因）。⚠️ 同一句连续两次**只播一次**。 */
      announce: function (msg) {
        const s = String(msg === undefined || msg === null ? '' : msg);
        // ⚠️ 先比再写：`textContent` 每赋一次值都算一次变更事件 ⇒ 重复播报会把读屏淹没。
        if (s === lastAnnounce) return;
        lastAnnounce = s;
        live.textContent = s;
      },

      /** 当前标签（调用方要复用时取，⛔ 不自己拼一份）。 */
      label: function () {
        return t('live.a11y-label');
      },

      destroy: function () {
        host.removeAttribute('role');
        host.removeAttribute('aria-multiline');
        host.removeAttribute('aria-label');
        host.removeAttribute('aria-valuetext');
        if (live.parentNode) live.parentNode.removeChild(live);
      },
    };
  }

  const api = {
    MAX_TEXT: MAX_TEXT,
    truncate: truncate,
    describe: describe,
    attach: attach,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveA11y = api;
})();
