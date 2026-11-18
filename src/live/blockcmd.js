// @ts-check —— `design/0078`：本文件在 `make typecheck` 的检查范围里（`src/live/**`）。
// ⚠️ 仍是**经典脚本 ＋ IIFE**（`frontend.md` 第 1、2 条）：注解只活在注释里，⛔ 不改运行时。
//
// # 块命令的**纯计划层**
//
// `plan(cmd, text, anchor, head)` 只回答一件事：**当前这一块的源码要变成什么**。
// 它⛔ 不碰 DOM、⛔ 不碰 CM6、⛔ 不发 IPC、⛔ 不认识块表与会话
// —— 把"改哪一块、什么时候提交、怎么撤销"留给 `live/index.js` 的 `blockCommand()`。
//
// 这样每条命令的字节判据都能在 node 里钉死（`tests/js/block-commands.test.js`），
// 而屏幕上的位置 / 手感归真实 DOM 与人工（`design/0078` §7）。
//
// ⚠️ 插入位置的**空白规则**是逐字确定的（`beforeGap` / `afterGap`）：块命令的目标是
//    "原行不断、新块独占一段"，⛔ 不是"随手在光标处塞一段源码"。规则错一次不会报错，
//    只会把两段正文粘成一段（Markdown 里可能整段变成代码块）——所以判据按**完整输出串**写。

(function () {
  'use strict';

  /**
   * 行内 / 行前缀计划（与 `formatbar.js` 同形）。本文件只产出 `{text, selection}`，
   * 不产出 `changes`；`ol` / `clear` 内部用 changes 算选区映射。
   * @typedef {{from:number, to:number, insert:string}} Change
   */

  /**
   * @param {string} text
   * @param {number} anchor
   * @param {number} head
   * @returns {{from:number, to:number}}
   */
  function rangeOf(text, anchor, head) {
    if (!Number.isInteger(anchor) || !Number.isInteger(head)) {
      throw new Error('selection is not an integer');
    }
    if (anchor < 0 || head < 0 || anchor > text.length || head > text.length) {
      throw new Error('range out of bounds');
    }
    return { from: Math.min(anchor, head), to: Math.max(anchor, head) };
  }

  /**
   * 选区覆盖到的**整行**（与 `formatbar.js::selectedLines` 同口径）：
   * 选区正好停在下一行行首时，那一行不算。
   * @param {string} text
   * @param {number} from
   * @param {number} to
   * @returns {Array<{start:number, end:number}>}
   */
  function selectedLines(text, from, to) {
    const first = text.lastIndexOf('\n', from - 1) + 1;
    let lastChar = to;
    if (to > from && to > 0 && text.charAt(to - 1) === '\n') lastChar = to - 1;
    /** @type {Array<{start:number, end:number}>} */
    const lines = [];
    let start = first;
    for (;;) {
      const nl = text.indexOf('\n', start);
      const end = nl < 0 ? text.length : nl;
      lines.push({ start: start, end: end });
      if (end >= lastChar || nl < 0) break;
      start = nl + 1;
    }
    return lines;
  }

  /**
   * @param {number} pos
   * @param {Change[]} changes 按位置升序、互不重叠
   * @returns {number}
   */
  function mapPosition(pos, changes) {
    let shift = 0;
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i];
      if (c.to <= pos) {
        shift += c.insert.length - (c.to - c.from);
        continue;
      }
      if (c.from <= pos && pos < c.to) return c.from + shift + c.insert.length;
      if (c.from > pos) break;
    }
    return pos + shift;
  }

  /**
   * @param {number} anchor
   * @param {number} head
   * @param {Change[]} changes
   * @returns {{anchor:number, head:number}}
   */
  function mapSelection(anchor, head, changes) {
    return { anchor: mapPosition(anchor, changes), head: mapPosition(head, changes) };
  }

  /**
   * 按坐标升序应用变更（**原始坐标**；同位置插入保持数组顺序）。
   * @param {string} text
   * @param {Change[]} changes
   * @returns {string}
   */
  function applyChanges(text, changes) {
    // ⚠️ 调用方按位置升序、互不重叠地给出（`toggleOrdered` / `clearFormat` 都按行扫）；
    //    这里⛔ 不排序：`.sort(` 被 `tests/js/doclist-source.test.js` 限制在白名单文件里。
    const list = changes;
    let out = '';
    let pos = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      out += text.slice(pos, c.from) + c.insert;
      pos = c.to;
    }
    return out + text.slice(pos);
  }

  /**
   * 插入点**左侧**需要的空行（新块前面）。
   *
   * 规则（`design/0078` §2.2）：
   * · 文首 ⇒ 不加；
   * · 上一行已空 ⇒ 不加（不要让两个空行叠起来）；
   * · 上一行非空 ⇒ 断行（行中再加一个换行，让原行前后两段各自成行）。
   *
   * @param {string} text
   * @param {number} pos
   * @returns {string}
   */
  function beforeGap(text, pos) {
    if (pos <= 0) return '';
    if (text.charAt(pos - 1) !== '\n') return '\n\n';
    const lineStart = text.lastIndexOf('\n', pos - 2) + 1;
    // pos - 1 就是空行的换行符 ⇒ 上一行长度为 0。
    return pos - 1 === lineStart ? '' : '\n';
  }

  /**
   * 插入点**右侧**需要的空行（新块后面）。与 `beforeGap` 对称。
   * @param {string} text
   * @param {number} pos
   * @returns {string}
   */
  function afterGap(text, pos) {
    if (pos >= text.length) return '';
    if (text.charAt(pos) !== '\n') return '\n\n';
    const nl = text.indexOf('\n', pos + 1);
    const lineEnd = nl < 0 ? text.length : nl;
    return lineEnd === pos + 1 ? '' : '\n';
  }

  /**
   * 在 `[from,to)` 处放一段 snippet（选区被替换），两侧补空行，光标落在
   * `caretOffset`（snippet 内偏移）。
   * @param {string} text
   * @param {number} from
   * @param {number} to
   * @param {string} snippet
   * @param {number} caretOffset
   * @param {number} [selectLen] 若给出，选中 snippet 内 `caretOffset` 起的这一段
   * @returns {{text:string, selection:{anchor:number, head:number}}}
   */
  function insertAt(text, from, to, snippet, caretOffset, selectLen) {
    const before = beforeGap(text, from);
    const after = afterGap(text, to);
    const out = text.slice(0, from) + before + snippet + after + text.slice(to);
    const start = from + before.length + caretOffset;
    const len = selectLen === undefined ? 0 : selectLen;
    return { text: out, selection: { anchor: start, head: start + len } };
  }

  /**
   * 围栏长度：取选中文字里**最长反引号串 + 1**（至少 3）。
   * 不这样做的话，选中一段自己带 ``` 的代码再包一层，围栏会被提前闭合。
   * @param {string} inner
   * @returns {string}
   */
  function fenceFor(inner) {
    // ⚠️ 反引号写成 `\x60`：源码闸门（`tests/js/i18n.test.js`）不认正则字面量，
    //    直接写反引号会被它当成模板串开头，把后面半份文件都读歪。
    const runs = inner.match(/\x60+/g) || [];
    let n = 3;
    for (let i = 0; i < runs.length; i++) n = Math.max(n, runs[i].length + 1);
    return new Array(n + 1).join('`');
  }

  /**
   * 有序列表的**行首标记**（`1. ` / `1) `，允许缩进）。
   * ⚠️ 不认多级 `1.1.`——那不是 GFM 的有序项。
   */
  const ORDERED_PREFIX = /^([ \t]*)\d{1,9}[.)][ \t]+/;
  /** 任何行首块标记（有序 / 无序）＋ 可选任务框。 */
  const BULLET_PREFIX = /^([ \t]*)(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;

  /**
   * 覆盖行转有序列表 / 转回正文。
   *
   * 开关口径（`design/0078` §2.2）：**覆盖到的非空行全部已是有序项** ⇒ 整批剥掉标记；
   * 否则剥掉已有标记、按顺序重新编号（保留缩进与内容）。
   *
   * @param {string} text
   * @param {number} anchor
   * @param {number} head
   * @returns {{text:string, selection:{anchor:number, head:number}}|null}
   */
  function toggleOrdered(text, anchor, head) {
    const r = rangeOf(text, anchor, head);
    const lines = selectedLines(text, r.from, r.to);
    let nonBlank = 0;
    let allOrdered = true;
    for (let i = 0; i < lines.length; i++) {
      const src = text.slice(lines[i].start, lines[i].end);
      if (!src.trim()) continue;
      nonBlank++;
      if (!ORDERED_PREFIX.test(src)) allOrdered = false;
    }
    if (!nonBlank) return null;
    /** @type {Change[]} */
    const changes = [];
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const raw = text.slice(line.start, line.end);
      if (!raw.trim()) continue;
      const m = (allOrdered ? ORDERED_PREFIX : BULLET_PREFIX).exec(raw);
      const indent = m ? m[1].length : (/^[ \t]*/.exec(raw) || [''])[0].length;
      const contentStart = line.start + (m ? m[0].length : indent);
      if (allOrdered) {
        // 只剥标记与它后面的空白，缩进与内容原样。
        changes.push({ from: line.start + indent, to: contentStart, insert: '' });
      } else {
        n++;
        changes.push({ from: line.start + indent, to: contentStart, insert: n + '. ' });
      }
    }
    if (!changes.length) return null;
    const out = applyChanges(text, changes);
    if (out === text) return null;
    return { text: out, selection: mapSelection(anchor, head, changes) };
  }

  /**
   * 去一层行首块标记（可叠加：`> - [ ] x` 会逐层剥）。
   * @param {string} src
   * @returns {string}
   */
  function stripBlockPrefix(src) {
    let out = src;
    for (;;) {
      const before = out;
      out = out.replace(/^[ \t]*#{1,6}[ \t]+/, '');
      out = out.replace(/^[ \t]*>[ \t]?/, '');
      out = out.replace(/^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/, '');
      out = out.replace(/^\[[ xX]\][ \t]+/, '');
      if (out === before) return out;
    }
  }

  /**
   * 去行内强调标记。⚠️ 只认"标记内侧不是空白"的闭合形态：
   * `2 * 3 * 4` 里的星号是乘号，⛔ 不许被当成强调（清格式不是"删掉所有符号"）。
   * @param {string} src
   * @returns {string}
   */
  function stripInline(src) {
    return src
      // 图片先于链接：`![alt](url)` → `alt`
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '$1')
      .replace(/_(\S(?:[^_\n]*\S)?)_/g, '$1')
      .replace(/[\x60]([^\x60]*)[\x60]/g, '$1');
  }

  /**
   * 清除格式：覆盖行去块前缀与行内强调；链接 / 图片只留文字。
   * @param {string} text
   * @param {number} anchor
   * @param {number} head
   * @returns {{text:string, selection:{anchor:number, head:number}}|null}
   */
  function clearFormat(text, anchor, head) {
    const r = rangeOf(text, anchor, head);
    const lines = selectedLines(text, r.from, r.to);
    /** @type {Change[]} */
    const changes = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const raw = text.slice(line.start, line.end);
      const clean = stripInline(stripBlockPrefix(raw));
      if (clean === raw) continue;
      changes.push({ from: line.start, to: line.end, insert: clean });
    }
    if (!changes.length) return null;
    return { text: applyChanges(text, changes), selection: mapSelection(anchor, head, changes) };
  }

  /**
   * ⭐ 块命令的唯一入口（纯函数）。
   *
   * @param {string} cmd `BLOCK_COMMANDS` 里的 `cmd`
   * @param {string} text 当前块源码
   * @param {number} anchor 块内 UTF-16 偏移
   * @param {number} head 块内 UTF-16 偏移
   * @returns {{text:string, selection:{anchor:number, head:number}}|null}
   *   未知命令 / 无事可做 / 无法表达 ⇒ `null`
   */
  function plan(cmd, text, anchor, head) {
    const src = String(text);
    const r = rangeOf(src, anchor, head);
    const sel = src.slice(r.from, r.to);
    /** @type {{text:string, selection:{anchor:number, head:number}}|null} */
    let out = null;
    switch (cmd) {
      case 'code': {
        const fence = fenceFor(sel);
        const snippet = fence + '\n' + sel + '\n' + fence;
        out = insertAt(src, r.from, r.to, snippet, fence.length + 1);
        break;
      }
      case 'math': {
        const snippet = '$$\n' + sel + '\n$$';
        out = insertAt(src, r.from, r.to, snippet, 3);
        break;
      }
      case 'callout': {
        const body = sel
          ? sel.split('\n').map(function (line) { return line ? '> ' + line : '>'; }).join('\n')
          : '> ';
        const snippet = '> [!NOTE]\n' + body;
        out = insertAt(src, r.from, r.to, snippet, 12);
        break;
      }
      case 'table': {
        const snippet = '|  |  |\n| --- | --- |\n|  |  |';
        out = insertAt(src, r.from, r.to, snippet, 2);
        break;
      }
      case 'hr': {
        out = insertAt(src, r.from, r.to, '---', 3);
        break;
      }
      case 'image': {
        if (sel.indexOf('\n') >= 0) return null; // 路径不能跨行，⛔ 不猜用户想留哪一段
        const path = sel || 'path';
        const snippet = '![](' + path + ')';
        // ⚠️ 图片是**行内**语法：⛔ 不走 `insertAt` 的块间空行规则（那会把它拆成独立段落）。
        const start = r.from + 4;
        out = {
          text: src.slice(0, r.from) + snippet + src.slice(r.to),
          selection: { anchor: start, head: start + path.length },
        };
        break;
      }
      case 'ol': return toggleOrdered(src, anchor, head);
      case 'clear': return clearFormat(src, anchor, head);
      default: return null;
    }
    // 与源文逐字相同 ⇒ 没有改动（⛔ 白压一条撤销）。
    if (!out || out.text === src) return null;
    return out;
  }

  /**
   * 菜单项（顺序即屏幕顺序）。`key` 是字典键的第二段（完整键 = `live.block.` + `key`）。
   * ⛔ 这里不写可见文案：产品是中文界面，文案只进 `services/i18n.js`。
   * @type {Array<{cmd:string, key:string}>}
   */
  const BLOCK_COMMANDS = [
    { cmd: 'code', key: 'code' },
    { cmd: 'table', key: 'table' },
    { cmd: 'math', key: 'math' },
    { cmd: 'callout', key: 'callout' },
    { cmd: 'hr', key: 'hr' },
    { cmd: 'image', key: 'image' },
    { cmd: 'ol', key: 'ol' },
    { cmd: 'clear', key: 'clear' },
  ];

  const api = {
    plan: plan,
    BLOCK_COMMANDS: BLOCK_COMMANDS,
    // 判据可直接调的小件（⛔ 不是第二套产品入口）
    beforeGap: beforeGap,
    afterGap: afterGap,
    selectedLines: selectedLines,
    mapSelection: mapSelection,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveBlockCmd = api;
})();
