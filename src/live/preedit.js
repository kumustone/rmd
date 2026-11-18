// @ts-check
// `design/0047` §2.7（2026-11-02 修订）——IME 组合串的**行内 widget**。
//
// ⭐ 形态对齐 Mardo（用户 2026-11-02「按照 mardo 来修改」）：组合串**进排版**——
//    占宽度、把右边的字推开、行满就折行。依据是 `docs/research/notes/0038`：
//    Mardo 的 `EditorLayout.layout(source:spans:covered:runs:**inputting**:…)` 把
//    组合区间当**排版输入**（"排版时单独照顾"），⛔ 不是画在文字上面的一层。
// ⛔ **文档一个字节都不动**：它只活在**装饰层**里 —— `state.doc` 不变、组合期仍然是
//    零条改文档的事务（`INV-LIVE-04` / `F6` 的"文档不变"）。
//
// ⚠️ 为什么这份住在 `live/` 而⛔ 不写在 `main.js`：`tests/js/keymap.test.js` 的渲染符号
//    闸门对**非 `src/editor/**`** 的文件要求"代码里不出现那个扩展名"（注释里提到没事），
//    靠它证明 `stripComments` 真的把注释挖空了。`design/0047` 给 live 层的是**独立白名单**
//    （`StateField` / `Decoration` / `WidgetType` 允许）⇒ 装饰的**构造**归这一层，
//    `main.js` 只负责"什么时候画、画在哪里"。
(() => {
  'use strict';

  /**
   * 造一个组合串的渲染器（一个**块视图**一个：状态是每实例的）。
   *
   * @param {object} CM6 `window.rmdCM6`
   * @returns {{extension: object, paint: (view: object, text: string, pos: number) => void}}
   *   `extension` 必须在**建视图之前**推进 extensions；
   *   `paint(view, text, pos)` 在组合期每次 `compositionupdate` 调一次，`text` 为空串表示清掉。
   */
  function create(CM6) {
    /**
     * 组合串那个**行内小方块**。
     *
     * ⚠️ 它住在 `.cm-line` **里面** ⇒ 字号 / 行高 / 字体族 / 字重 / 底色**天然继承那一行**：
     *    标题块第二行的正文尺度、代码块的等宽字体都不用再各量一遍（2026-10-29 那条
     *    「拼音的字很大」在这个形态下结构上不可能）。
     * ⚠️ `eq` 只比文本：文案没变时 CM6 直接复用同一段 DOM，⛔ 不重建节点（每敲一个拼音字
     *    都会走到这里，重建节点会让光标所在行整段重排一次）。
     */
    class PreeditWidget extends CM6.WidgetType {
      /** @param {string} text */
      constructor(text) {
        super();
        /** @type {string} */
        this.text = text;
      }
      /**
       * @param {object} other
       * @returns {boolean}
       */
      eq(other) {
        return !!other && other.text === this.text;
      }
      /** @returns {object} */
      toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-rmd-preedit';
        span.textContent = this.text;
        // ⚠️ 组合串**还没进文档**：别让读屏把它当正文念一遍（通告由 `live/a11y.js` 出）。
        span.setAttribute('aria-hidden', 'true');
        return span;
      }
      /** ⛔ 它不接收事件：事件照旧落回编辑器（与"这一格不存在"同义）。 */
      ignoreEvent() {
        return true;
      }
    }

    // ⭐ 用 `Compartment` 换装饰 ⇒ 不必为此自己造一个 `StateEffect`：
    //    `cm6.bundle.js` 的出口**没有** `StateEffect`（只有 `Decoration` / `StateField` /
    //    `WidgetType` 等），而 `Compartment.reconfigure(...)` 返回的正是 CM6 自己的 effect。
    const slot = new CM6.Compartment();
    let shown = '';

    return {
      extension: slot.of([]),
      /**
       * @param {object} view `EditorView`
       * @param {string} text 组合串（`''` = 清掉）
       * @param {number} pos 落点（文档偏移，调用方已夹取）
       */
      paint: function (view, text, pos) {
        const s = String(text === undefined || text === null ? '' : text);
        if (s === shown) return;
        shown = s;
        // ⚠️⚠️ `side` 必须是 **-1**（2026-11-14 用户报告「内容在光标的后面，等按了 Enter
        //    真正输入之后，光标变成在内容的后面，产生跳动」）。
        //    `@codemirror/view` 的 `WidgetDecorationSpec.side` 原文：「When this is positive,
        //    the widget will be drawn **after the cursor** if the cursor is on the same position.
        //    Otherwise, it'll be drawn **before** it.」⇒ `side: 1` 把组合串画在光标**右边**，
        //    自绘光标（`selection.js` 的 `coordsAtPos(head, 1)`）就落在串的**左缘**；上屏后
        //    串没了、光标退到插入点 + 长度 ⇒ 视觉上"跳一下"。`side: -1` 让串画在光标**左边**，
        //    光标全程贴在串的右缘——与 `bugs/0300` 任务框那条同一条规律（`side: 1` 缺陷值
        //    ⇒ caret.left == widget.left；`side: -1` ⇒ caret.left == widget.right）。
        const deco = s
          ? CM6.EditorView.decorations.of(CM6.Decoration.set([
            CM6.Decoration.widget({ widget: new PreeditWidget(s), side: -1 }).range(pos),
          ], true))
          : [];
        view.dispatch({ effects: slot.reconfigure(deco) });
      },
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { create: create };
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).livePreedit = { create: create };
})();
