// @ts-check —— `design/0078`：本文件在 `make typecheck` 的检查范围里（`src/live/**`）。
// ⚠️ 仍是**经典脚本 ＋ IIFE**（`frontend.md` 第 1、2 条）：注解只活在注释里，⛔ 不改运行时。
//
// # 表格行列操作的**纯计划层**
//
// `apply(op, blockLines, cells, {startLine, flat})` 只回答：
// **这张表的源码行要变成什么**。它⛔ 不碰 DOM、⛔ 不碰 CM6、⛔ 不发 IPC。
//
// ⭐ 数据格的内容边界**只来自后端 `table_cells`**（`src-tauri/src/document/blocks.rs::scan_tables`）：
//    转义竖线 `\|`、末尾反斜杠、comrak 自动补齐的短行格子，都在那些区间里已经算对。
//    ⛔ 本文件不许按 `|` 切数据行——那是第二套 Markdown 解析器，切错一次就写坏邻格。
//    唯一做的语法扫描是**分隔行**：GFM 分隔格只允许 `-`、可选冒号与空白，没有转义，
//    所以按字面竖线切是安全的（`design/0078` §2.3）。
//
// ⚠️ 结构判据的失败**不抛异常**：返回 `{ok:false, why:'代码'}`，由调用方决定是置灰
//    还是给一句理由。异常只留给"程序错误"（非法参数 / 未知操作）。

(function () {
  'use strict';

  /**
   * 后端格子区间（与 `blocks.js::fromCellPayload` 同形）：
   * `line` 1-based；`from`/`to` 是该行内的 UTF-16 右开偏移，两侧 ASCII 空白已修剪。
   * @typedef {{line:number, from:number, to:number, writable:boolean}} CellSpan
   */

  /**
   * @typedef {{rel:number, line:string, cells:CellSpan[]}} Row
   * @typedef {{lead:string, token:string, trail:string}} Piece
   * @typedef {{prefix:string, pieces:Piece[], suffix:string}} Delimiter
   * @typedef {{rows:Row[], header:Row, delimiter:Delimiter, columns:number,
   *            lines:string[], startLine:number, uneven:boolean}} Shape
   */

  /** 行前缀 / 后缀只允许空白与至多一个竖线。 */
  const EDGE = /^[ \t]*\|?[ \t]*$/;
  /** 分隔格：可选冒号 + 至少一个连字符 + 可选冒号。 */
  const DELIM_TOKEN = /^:?-+:?$/;

  /**
   * 把分隔行切成 `前缀 + 若干分隔格 + 后缀`。
   *
   * ⚠️ 只接受**两侧都有竖线**的写法（`| --- | --- |`）：rmd 渲染的表格就是这种形态。
   *    无外框的 `--- | ---` 返回 `null` ⇒ 调用方报 `bad-delimiter`，⛔ 不猜边界。
   *
   * @param {string} line
   * @returns {Delimiter|null}
   */
  function splitDelimiter(line) {
    const first = line.indexOf('|');
    const last = line.lastIndexOf('|');
    if (first < 0 || last <= first) return null;
    const prefix = line.slice(0, first + 1);
    const suffix = line.slice(last);
    if (!EDGE.test(line.slice(0, first))) return null;
    if (!EDGE.test(line.slice(last + 1))) return null;
    const inner = line.slice(first + 1, last);
    const raw = inner.split('|');
    /** @type {Piece[]} */
    const pieces = [];
    for (let i = 0; i < raw.length; i++) {
      const m = /^([ \t]*)(:?-+:?)([ \t]*)$/.exec(raw[i]);
      if (!m || !DELIM_TOKEN.test(m[2])) return null;
      pieces.push({ lead: m[1], token: m[2], trail: m[3] });
    }
    if (!pieces.length) return null;
    return { prefix: prefix, pieces: pieces, suffix: suffix };
  }

  /**
   * @param {Delimiter} d
   * @param {Piece[]} pieces
   * @returns {string}
   */
  function joinDelimiter(d, pieces) {
    let out = d.prefix;
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) out += '|';
      out += pieces[i].lead + pieces[i].token + pieces[i].trail;
    }
    return out + d.suffix;
  }

  /**
   * ⭐ 读形状：只认**后端给的格子区间**，不解析数据行内容。
   *
   * @param {string[]} blockLines
   * @param {CellSpan[]} cells
   * @param {number} startLine
   * @returns {{ok:true, shape:Shape}|{ok:false, why:string}}
   */
  function readShape(blockLines, cells, startLine) {
    if (blockLines.length < 2) return { ok: false, why: 'no-delimiter' };
    if (!cells || !cells.length) return { ok: false, why: 'no-cells' };
    const delimiter = splitDelimiter(blockLines[1]);
    if (!delimiter) return { ok: false, why: 'bad-delimiter' };

    /** @type {Map<number, CellSpan[]>} */
    const byLine = new Map();
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c || !Number.isInteger(c.line) || !Number.isInteger(c.from)
        || !Number.isInteger(c.to) || c.from > c.to) {
        return { ok: false, why: 'bad-shape' };
      }
      const rel = c.line - startLine;
      if (rel < 0 || rel >= blockLines.length || rel === 1) {
        return { ok: false, why: 'bad-shape' };
      }
      let list = byLine.get(rel);
      if (!list) { list = []; byLine.set(rel, list); }
      list.push(c);
    }

    const headerCells = byLine.get(0);
    if (!headerCells || !headerCells.length) return { ok: false, why: 'no-cells' };
    const columns = headerCells.length;
    if (delimiter.pieces.length !== columns) return { ok: false, why: 'bad-delimiter' };

    /** @type {Row[]} */
    const rows = [];
    let uneven = false;
    for (let rel = 0; rel < blockLines.length; rel++) {
      if (rel === 1) continue;
      const list = byLine.get(rel);
      if (!list) continue;
      if (list.length !== columns) return { ok: false, why: 'bad-shape' };
      const line = blockLines[rel];
      let prevEnd = -1;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.from < prevEnd || c.to > line.length) return { ok: false, why: 'bad-shape' };
        prevEnd = c.to;
        if (c.writable !== true) uneven = true;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (!EDGE.test(line.slice(0, first.from))) return { ok: false, why: 'bad-shape' };
      if (!EDGE.test(line.slice(last.to))) return { ok: false, why: 'bad-shape' };
      rows.push({ rel: rel, line: line, cells: list });
    }
    // 表头必须在第一行。⚠️ 上面的循环按 `rel` 升序 push，`rows` 天然有序，
    // 这里⛔ 不再 `.sort(`（该写法被 `tests/js/doclist-source.test.js` 限制在白名单文件里）。
    if (!rows.length || rows[0].rel !== 0) return { ok: false, why: 'bad-shape' };
    return {
      ok: true,
      shape: {
        rows: rows,
        header: rows[0],
        delimiter: delimiter,
        columns: columns,
        lines: blockLines.slice(),
        startLine: startLine,
        uneven: uneven,
      },
    };
  }

  /**
   * 规范化空行：`|` + `  |` × 列数。
   * @param {number} columns
   * @returns {string}
   */
  function emptyRow(columns) {
    let out = '|';
    for (let i = 0; i < columns; i++) out += '  |';
    return out;
  }

  /**
   * 活动格落在哪一行 / 哪一列。
   * @param {Shape} shape
   * @param {number} flat
   * @returns {{row:Row, rowIndex:number, column:number}|null}
   */
  function locate(shape, flat) {
    if (!Number.isInteger(flat) || flat < 0) return null;
    let seen = 0;
    for (let r = 0; r < shape.rows.length; r++) {
      const row = shape.rows[r];
      if (flat < seen + row.cells.length) {
        return { row: row, rowIndex: r, column: flat - seen };
      }
      seen += row.cells.length;
    }
    return null;
  }

  /**
   * @param {Shape} shape
   * @returns {number} 第一条数据行在 `shape.rows` 里的下标（没有 ⇒ `rows.length`）
   */
  function firstBodyIndex(shape) {
    return shape.rows.length > 1 ? 1 : shape.rows.length;
  }

  /**
   * 行操作。⚠️ 表头行永远不动；插入“下方”在表头处落到分隔行之后。
   * @param {string} op
   * @param {Shape} shape
   * @param {{row:Row, rowIndex:number, column:number}} hit
   * @returns {{ok:true, lines:string[]}|{ok:false, why:string}}
   */
  function rowOp(op, shape, hit) {
    const lines = shape.lines.slice();
    const isHeader = hit.rowIndex === 0;
    const bodyFirst = firstBodyIndex(shape);
    if (op === 'row-insert-above') {
      if (isHeader) return { ok: false, why: 'header-row' };
      lines.splice(hit.row.rel, 0, emptyRow(shape.columns));
      return { ok: true, lines: lines };
    }
    if (op === 'row-insert-below') {
      const at = isHeader ? 2 : hit.row.rel + 1;
      lines.splice(at, 0, emptyRow(shape.columns));
      return { ok: true, lines: lines };
    }
    if (op === 'row-delete') {
      if (isHeader) return { ok: false, why: 'header-row' };
      lines.splice(hit.row.rel, 1);
      return { ok: true, lines: lines };
    }
    if (op === 'row-move-up') {
      if (isHeader) return { ok: false, why: 'header-row' };
      if (hit.rowIndex <= bodyFirst) return { ok: false, why: 'top-row' };
      const prev = shape.rows[hit.rowIndex - 1].rel;
      const cur = hit.row.rel;
      const tmp = lines[prev];
      lines[prev] = lines[cur];
      lines[cur] = tmp;
      return { ok: true, lines: lines };
    }
    if (op === 'row-move-down') {
      if (isHeader) return { ok: false, why: 'header-row' };
      if (hit.rowIndex + 1 >= shape.rows.length) return { ok: false, why: 'bottom-row' };
      const next = shape.rows[hit.rowIndex + 1].rel;
      const cur = hit.row.rel;
      const tmp = lines[next];
      lines[next] = lines[cur];
      lines[cur] = tmp;
      return { ok: true, lines: lines };
    }
    return { ok: false, why: 'unknown-op' };
  }

  /**
   * 列操作。⭐ 数据行只在后端给的内容边界上做**区间插入 / 删除 / 两段交换**，
   * 其余字节（缩进、分隔竖线两侧空白、转义序列）原样保留。
   *
   * @param {string} op
   * @param {Shape} shape
   * @param {{row:Row, rowIndex:number, column:number}} hit
   * @returns {{ok:true, lines:string[]}|{ok:false, why:string}}
   */
  function colOp(op, shape, hit) {
    const columns = shape.columns;
    const k = hit.column;
    const lines = shape.lines.slice();
    /** @type {Piece[]} */
    const pieces = shape.delimiter.pieces.slice();
    if (op === 'align-left' || op === 'align-center' || op === 'align-right') {
      const token = op === 'align-left' ? ':---' : op === 'align-center' ? ':---:' : '---:';
      pieces[k] = { lead: pieces[k].lead, token: token, trail: pieces[k].trail };
      lines[1] = joinDelimiter(shape.delimiter, pieces);
      return { ok: true, lines: lines };
    }
    if (shape.uneven) return { ok: false, why: 'uneven' };
    if (op === 'col-insert-left') {
      for (let r = 0; r < shape.rows.length; r++) {
        const row = shape.rows[r];
        const c = row.cells[k];
        lines[row.rel] = row.line.slice(0, c.from) + '| ' + row.line.slice(c.from);
      }
      pieces.splice(k, 0, { lead: ' ', token: '---', trail: ' ' });
      lines[1] = joinDelimiter(shape.delimiter, pieces);
      return { ok: true, lines: lines };
    }
    if (op === 'col-insert-right') {
      const last = k === columns - 1;
      for (let r = 0; r < shape.rows.length; r++) {
        const row = shape.rows[r];
        const c = row.cells[k];
        const insert = last ? ' | ' : ' |';
        lines[row.rel] = row.line.slice(0, c.to) + insert + row.line.slice(c.to);
      }
      pieces.splice(k + 1, 0, { lead: ' ', token: '---', trail: ' ' });
      lines[1] = joinDelimiter(shape.delimiter, pieces);
      return { ok: true, lines: lines };
    }
    if (op === 'col-delete') {
      if (columns === 1) return { ok: false, why: 'last-column' };
      for (let r = 0; r < shape.rows.length; r++) {
        const row = shape.rows[r];
        // ⚠️ `k=0` 要连**第一格之后的那一段**（内容 ＋ 分隔）一起删；`k>0` 删到本格右端。
        const from = k === 0 ? row.cells[0].from : row.cells[k - 1].to;
        const to = k === 0 ? row.cells[1].from : row.cells[k].to;
        lines[row.rel] = row.line.slice(0, from) + row.line.slice(to);
      }
      pieces.splice(k, 1);
      lines[1] = joinDelimiter(shape.delimiter, pieces);
      return { ok: true, lines: lines };
    }
    if (op === 'col-move-left' || op === 'col-move-right') {
      const other = op === 'col-move-left' ? k - 1 : k + 1;
      if (other < 0) return { ok: false, why: 'left-edge' };
      if (other >= columns) return { ok: false, why: 'right-edge' };
      const a = Math.min(k, other);
      const b = Math.max(k, other);
      for (let r = 0; r < shape.rows.length; r++) {
        const row = shape.rows[r];
        const A = row.cells[a];
        const B = row.cells[b];
        const contentA = row.line.slice(A.from, A.to);
        const contentB = row.line.slice(B.from, B.to);
        lines[row.rel] = row.line.slice(0, A.from) + contentB
          + row.line.slice(A.to, B.from) + contentA + row.line.slice(B.to);
      }
      const tmp = pieces[a];
      pieces[a] = pieces[b];
      pieces[b] = tmp;
      lines[1] = joinDelimiter(shape.delimiter, pieces);
      return { ok: true, lines: lines };
    }
    return { ok: false, why: 'unknown-op' };
  }

  /**
   * 活动格所在的**结构位置**（只读判据，供菜单置灰用；⛔ 不产生任何改动）。
   *
   * @param {string[]} blockLines
   * @param {CellSpan[]} cells
   * @param {{startLine:number, flat:number}} opts
   * @returns {{ok:true, uneven:boolean, columns:number, column:number,
   *            rowIndex:number, rowCount:number}|{ok:false, why:string}}
   */
  function capacity(blockLines, cells, opts) {
    const o = opts || /** @type {any} */ ({});
    if (!Array.isArray(blockLines) || !Array.isArray(cells)) {
      throw new Error('table capacity needs blockLines and cells');
    }
    if (!Number.isInteger(o.startLine) || o.startLine < 1) throw new Error('startLine must be 1-based');
    if (!Number.isInteger(o.flat) || o.flat < 0) return { ok: false, why: 'no-cell' };
    const read = readShape(blockLines, cells, o.startLine);
    if (read.ok === false) return { ok: false, why: read.why };
    const shape = read.shape;
    const hit = locate(shape, o.flat);
    if (!hit) return { ok: false, why: 'no-cell' };
    return {
      ok: true,
      uneven: shape.uneven,
      columns: shape.columns,
      column: hit.column,
      rowIndex: hit.rowIndex,
      rowCount: shape.rows.length,
    };
  }

  /**
   * ⭐ 表格操作的唯一入口（纯函数）。
   *
   * @param {string} op `TABLE_OPS` 里的 `cmd`
   * @param {string[]} blockLines 该表格块的源码行（0-based 块内下标）
   * @param {CellSpan[]} cells 后端 `table_cells` 给的那一组
   * @param {{startLine:number, flat:number}} opts `startLine` 是块首行的 1-based 行号
   * @returns {{ok:true, lines:string[]}|{ok:false, why:string}}
   */
  function apply(op, blockLines, cells, opts) {
    const o = opts || /** @type {any} */ ({});
    if (!Array.isArray(blockLines) || !Array.isArray(cells)) {
      throw new Error('table op needs blockLines and cells');
    }
    if (!Number.isInteger(o.startLine) || o.startLine < 1) throw new Error('startLine must be 1-based');
    if (!Number.isInteger(o.flat) || o.flat < 0) return { ok: false, why: 'no-cell' };
    const read = readShape(blockLines, cells, o.startLine);
    if (read.ok === false) return { ok: false, why: read.why };
    const shape = read.shape;
    const hit = locate(shape, o.flat);
    if (!hit) return { ok: false, why: 'no-cell' };
    if (op.indexOf('row-') === 0) return rowOp(op, shape, hit);
    if (op.indexOf('col-') === 0 || op.indexOf('align-') === 0) return colOp(op, shape, hit);
    return { ok: false, why: 'unknown-op' };
  }

  /**
   * 菜单项（顺序即屏幕顺序）。`key` 是字典键的第二段（完整键 = `live.table.` + `key`）。
   * ⛔ 这里不写可见文案：文案只进 `services/i18n.js`。
   * @type {Array<{cmd:string, key:string}>}
   */
  const TABLE_OPS = [
    { cmd: 'row-insert-above', key: 'row-insert-above' },
    { cmd: 'row-insert-below', key: 'row-insert-below' },
    { cmd: 'row-delete', key: 'row-delete' },
    { cmd: 'row-move-up', key: 'row-move-up' },
    { cmd: 'row-move-down', key: 'row-move-down' },
    { cmd: 'col-insert-left', key: 'col-insert-left' },
    { cmd: 'col-insert-right', key: 'col-insert-right' },
    { cmd: 'col-delete', key: 'col-delete' },
    { cmd: 'col-move-left', key: 'col-move-left' },
    { cmd: 'col-move-right', key: 'col-move-right' },
    { cmd: 'align-left', key: 'align-left' },
    { cmd: 'align-center', key: 'align-center' },
    { cmd: 'align-right', key: 'align-right' },
  ];

  /** 所有拒绝码（i18n 闸门按这张表查键）。 */
  const WHY = [
    'no-cells', 'no-delimiter', 'bad-delimiter', 'bad-shape', 'uneven',
    'no-cell', 'header-row', 'top-row', 'bottom-row', 'last-column',
    'left-edge', 'right-edge', 'unknown-op',
  ];

  const api = {
    apply: apply,
    capacity: capacity,
    TABLE_OPS: TABLE_OPS,
    WHY: WHY,
    splitDelimiter: splitDelimiter,
    emptyRow: emptyRow,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveTable = api;
})();
