// 多格式复制 —— `design/0077` 的**纯逻辑**那一半：MIME 计划、源码片段、语境判据。
//
// # 为什么单独一个文件
//
// 「复制为 Markdown / HTML / 纯文本 / 富文本」看起来只是四次 `setData`，但有三处
// **静默错法**必须用纯函数钉住：
//
// 1. ⛔ **MIME 集合与顺序写错**：富文本少了 `text/plain` 兜底，粘进纯文本框就是空串；
//    HTML 源码误写 `text/html`，粘进代码编辑器会变成格式化结果而不是源码。
// 2. ⛔ **块边界算错**：阅读态只能按块退让，`startLine/endLine` 是 1-based 闭区间；
//    差一行就会多复制或少复制一段，而界面上一切正常。
// 3. ⛔ **无源码时假装有**：阅读态在没进过就地编辑时拿不到 Markdown 源码，
//    必须明确拒绝，⛔ 不许从前端 HTML 反推（那是第二套正文真相）。
//
// ⚠️ 本文件**不碰剪贴板**、不碰 DOM 全局（`htmlToText` 的 `doc` 是注入的）：
//    真正的写入在 `services/clipboard.js`，这里只回答「该写什么」。
(function () {
  'use strict';

  const KIND_MARKDOWN = 'markdown';
  const KIND_HTML = 'html';
  const KIND_PLAIN = 'plain';
  const KIND_RICH = 'rich';
  const MIME_PLAIN = 'text/plain';
  const MIME_HTML = 'text/html';

  /**
   * 行尾统一为 LF（`design/0077` §2.1）。
   * ⚠️ 编辑缓冲的既有不变量就是 LF（`INV-EDIT-12`），复制出去的源码也按同一口径。
   * @param {*} text
   * @returns {string}
   */
  function normalizeNewlines(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\r\n?/g, '\n');
  }

  /**
   * ⭐ 复制动作 → 要写进剪贴板的条目（**唯一来源**，`INV-CLIPFMT-01`）。
   *
   * - `markdown` / `plain` 用 `payload.text`；
   * - `html` 用 `payload.html`，但 MIME 是 `text/plain`（用户要的是**源码**）；
   * - `rich` 用 `text/html` ＋ `text/plain` 兜底。
   *
   * ⚠️ 返回 `null` = 这一种格式缺必需内容。调用方必须**显式报错**，
   *    ⛔ 不许退化成别的格式（`INV-CLIPFMT-04`）。
   *
   * @param {string} kind
   * @param {{text?:string, html?:string}} payload
   * @returns {Array<{mime:string, text:string}>|null}
   */
  function writeEntries(kind, payload) {
    const p = payload || {};
    const text = normalizeNewlines(p.text);
    const html = normalizeNewlines(p.html);
    if (kind === KIND_MARKDOWN || kind === KIND_PLAIN) {
      return text ? [{ mime: MIME_PLAIN, text: text }] : null;
    }
    if (kind === KIND_HTML) {
      return html ? [{ mime: MIME_PLAIN, text: html }] : null;
    }
    if (kind === KIND_RICH) {
      if (!html) return null;
      return [
        { mime: MIME_HTML, text: html },
        { mime: MIME_PLAIN, text: text },
      ];
    }
    return null;
  }

  /**
   * 编辑态：**精确选区**的源码。
   * ⚠️ 空白字符也是用户选中的内容 ⇒ 只有空串才算「没有选中」。
   * @param {*} text
   * @returns {string|null}
   */
  function selectionSnippet(text) {
    const s = normalizeNewlines(text);
    return s ? s : null;
  }

  /**
   * 阅读态：按**整块**取源码（1-based 闭区间，`design/0077` §2.1-C）。
   *
   * @param {string} fullText 会话全文（LF）
   * @param {Array<{index:number,startLine:number,endLine:number}>} blocks 块表
   * @param {number} firstIndex 选区覆盖的第一块
   * @param {number} lastIndex 选区覆盖的最后一块
   * @returns {{text:string, startLine:number, endLine:number}|null}
   */
  function sourceSnippet(fullText, blocks, firstIndex, lastIndex) {
    const full = normalizeNewlines(fullText);
    if (!full || !Array.isArray(blocks) || !blocks.length) return null;
    // ⚠️ 只认**数字**序号：`'1'` 这种字符串是调用方接错了（`bugs/0014` 同族的静默面），
    //    ⛔ 不用 `Number()` 悄悄收下——那会让"读错了字段"照样走通。
    if (typeof firstIndex !== 'number' || typeof lastIndex !== 'number') return null;
    let a = firstIndex;
    let b = lastIndex;
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    let first = null;
    let last = null;
    for (let i = 0; i < blocks.length; i++) {
      const blk = blocks[i];
      if (blk && blk.index === a) first = blk;
      if (blk && blk.index === b) last = blk;
    }
    if (!first || !last) return null;
    const start = Math.min(first.startLine, last.startLine);
    const end = Math.max(first.endLine, last.endLine);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 1 || end < start) return null;
    const lines = full.split('\n');
    if (end > lines.length) return null;
    const snippet = lines.slice(start - 1, end).join('\n');
    if (!snippet) return null;
    return { text: snippet, startLine: start, endLine: end };
  }

  /**
   * 语境判据（纯函数）：`ok` / `no-document` / `no-selection` / `no-source`。
   *
   * ⚠️ 只有**阅读态 + Markdown** 需要源码；HTML/纯文本在阅读态直接走 DOM 选区。
   * @param {string} kind
   * @param {('split'|'live'|'reading'|'none')} mode
   * @param {boolean} hasSelection
   * @param {boolean} hasSource
   * @returns {string}
   */
  function checkCopy(kind, mode, hasSelection, hasSource) {
    if (kind !== KIND_MARKDOWN && kind !== KIND_HTML &&
        kind !== KIND_PLAIN && kind !== KIND_RICH) {
      return 'unsupported';
    }
    if (mode !== 'split' && mode !== 'live' && mode !== 'reading') return 'no-document';
    if (!hasSelection) return 'no-selection';
    if (kind === KIND_MARKDOWN && mode === 'reading' && !hasSource) return 'no-source';
    return 'ok';
  }

  const BLOCK_TAGS = {
    P: 1, DIV: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    LI: 1, TR: 1, TABLE: 1, THEAD: 1, TBODY: 1, UL: 1, OL: 1,
    BLOCKQUOTE: 1, PRE: 1, SECTION: 1, ARTICLE: 1, HR: 1,
  };
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1 };

  /** 无 DOM 时的兜底（只在单测/极端环境走到）：按标签补换行、解常见实体。 */
  function fallbackText(html) {
    return normalizeNewlines(String(html == null ? '' : html)
      .replace(/<(script|style|template)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|table|ul|ol|section|article)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"))
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+|\n+$/g, '');
  }

  /**
   * 渲染后的 HTML → 可见文字。
   *
   * ⚠️ 只能喂**渲染结果**（阅读态 DOM 选区 / `render_preview` 的 `html`），
   *    ⛔ 不用它反推 Markdown（`INV-CLIPFMT-03`）。
   * ⚠️ 用**惰性文档**解析：普通 `div.innerHTML` 可能让图片等资源真的去加载。
   * @param {string} html
   * @param {*} [doc]
   * @returns {string}
   */
  function htmlToText(html, doc) {
    const src = typeof html === 'string' ? html : '';
    const d = doc || (typeof document !== 'undefined' ? document : null);
    let root = null;
    try {
      if (d && d.implementation && typeof d.implementation.createHTMLDocument === 'function') {
        root = d.implementation.createHTMLDocument('').createElement('div');
      } else if (d && typeof d.createElement === 'function') {
        root = d.createElement('div');
      }
    } catch (e) {
      root = null;
    }
    // ⚠️ 假 DOM / 无 DOM：走可预测的兜底，⛔ 不抛给调用方。
    if (!root || !('innerHTML' in root)) return fallbackText(src);
    try {
      root.innerHTML = src;
    } catch (e) {
      return fallbackText(src);
    }

    let out = '';
    function newline() {
      if (out && out.charAt(out.length - 1) !== '\n') out += '\n';
    }
    function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        out += node.nodeValue || '';
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = String(node.tagName || '').toUpperCase();
      if (SKIP_TAGS[tag]) return;
      if (tag === 'BR') {
        out += '\n';
        return;
      }
      const block = !!BLOCK_TAGS[tag];
      if (block) newline();
      const kids = node.childNodes || [];
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
      if (block) newline();
    }
    walk(root);
    return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  }

  const api = {
    KIND_MARKDOWN: KIND_MARKDOWN,
    KIND_HTML: KIND_HTML,
    KIND_PLAIN: KIND_PLAIN,
    KIND_RICH: KIND_RICH,
    MIME_PLAIN: MIME_PLAIN,
    MIME_HTML: MIME_HTML,
    normalizeNewlines: normalizeNewlines,
    writeEntries: writeEntries,
    selectionSnippet: selectionSnippet,
    sourceSnippet: sourceSnippet,
    checkCopy: checkCopy,
    htmlToText: htmlToText,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).copyFormats = api;
})();
