// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// 块表：线格式解包、块表 ↔ DOM 对齐、块间行报警器 —— `design/0047` §2.2 / §2.8 / §3.2。
//
// 这里回答四个问题，四个都**不碰 DOM 的写、不碰 Tauri、不碰定时器**：
//   ① Rust 发来的 `blocks` 线格式怎么解（唯一解包点，⛔ 别在 `main.js` 里拆数组）；
//   ② `#doc` 的那批顶层子节点与块表**对不对得上**（对不上 ⇒ `issues` 非空 ⇒ 降级）；
//   ③ 每个块种类**允许**长成哪个 DOM 形状（`tagOf` 是全项目唯一一份）；
//   ④ 块与块之间那些行（空行 / 引用定义 / 隐藏指令）是哪几行、有没有**认不出来**的；
//   ⑤ ⭐ `0049` 起：表格单元格的列区间表怎么解（`table_cells` 的**独立**字段）。
//
// ⚠️ **坐标只在这里换一次**：Rust 侧全程 1-based 含两端（`blocks.rs` 模块头第 4 条），
// 前端内部全程 **0-based 半开**（`from` / `to`，直接喂 `Array.prototype.slice`）。
// ⛔ 别在别处再写 `end_line + 1`——那是本项目最容易差一的地方。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，
// 顶层 `const` 撞名会让**整个文件不执行**（窗口空白、stderr 全静默）。
// 理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  /**
   * 兜底种类名（与 Rust `blocks.rs::KIND_NAMES` 的最后一项逐字相同）。
   *
   * ⚠️ 它**不是**"不认识就当成普通段落"——`Other` 在 [`accepts`] 里**不接受任何形状**，
   * 所以落进它的块会让整次对齐失败、走可见降级（`INV-LIVE-06`）。
   */
  const OTHER = 'Other';

  /**
   * `FootnoteDefinition` 的名字（对齐里要单独处理，见 [`align`] 的三步）。
   */
  const FOOTNOTE = 'FootnoteDefinition';

  /**
   * ⭐ **块种类 → 它允许的 DOM 形状**。全项目唯一一份（`design/0047` §3.2）。
   *
   * | 种类 | 允许的形状 | 依据（2026-10-26 实测顶层 DOM） |
   * |---|---|---|
   * | `Paragraph` | `p` / `math-block` | 整段就是一个块级公式时是 `<div class="rmd-math-display">`；那种块 Rust 侧已经标成不可编辑 |
   * | `Heading` | `h` | `<h1>`–`<h6>` |
   * | `CodeBlock` | `pre` / `diagram` | ` ```flow `/` ```sequence ` 渲染成 `<div class="rmd-diagram">` |
   * | `List` | `list` | `<ul>` / `<ol>` |
   * | `BlockQuote` | `quote` | `<blockquote>` |
   * | `Table` | `table` | `<table>` |
   * | `ThematicBreak` | `hr` | `<hr />` |
   * | `HtmlBlock` | `raw-html` | `<!-- raw HTML omitted -->`（`render.unsafe` 从不设置，`INV-SEC-01`） |
   * | `FootnoteDefinition` | `footnotes` | 整篇只有一个尾部 `<section data-footnotes>`，见 [`align`] |
   * | `Other` | **无** | 认不出来的种类 ⛔ 不猜 |
   *
   * ⚠️ `Paragraph` 接受 `math-block` 是**刻意的**：那个块不可编辑，但**必须能对齐**，
   * 否则它后面的每一个块都会跟着错位（对齐是一维的顺序比对）。
   * ⚠️ 反过来，`CodeBlock` 接受 `pre` 而不细分"是不是 `.rmd-code`"：
   * 可编辑性是 Rust 给的 `editable`，⛔ 不靠 class 名再判一次。
   */
  const SHAPES = {
    Paragraph: ['p', 'math-block'],
    Heading: ['h'],
    CodeBlock: ['pre', 'diagram'],
    List: ['list'],
    BlockQuote: ['quote'],
    Table: ['table'],
    ThematicBreak: ['hr'],
    HtmlBlock: ['raw-html'],
    FootnoteDefinition: ['footnotes'],
    Other: [],
  };

  /** `nodeType` 的注释节点（`<!-- raw HTML omitted -->` 就是它）。 */
  const COMMENT_NODE = 8;
  /** `nodeType` 的元素节点。 */
  const ELEMENT_NODE = 1;

  /**
   * 1-based 含两端 → **0-based 半开**。⭐ 全项目唯一一次换算。
   *
   * ⚠️ 非法区间**抛错，⛔ 不夹取**（与 `tools/live-probe/js/lineModel.js` 同口径）：
   * 夹取会把"用陈旧行号提交"这个错误**静默**变成"改对了附近"。
   */
  function toRange(startLine, endLine) {
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      throw new Error('行号必须是整数');
    }
    if (startLine < 1 || endLine < startLine) {
      throw new Error(`行区间非法 ${startLine}-${endLine}`);
    }
    return { from: startLine - 1, to: endLine };
  }

  /**
   * ⭐ 线格式 → 内部模型。**唯一的解包点**（`design/0047` §3.1.1）。
   *
   * 线格式（Rust `blocks::to_wire`）：
   * ```
   * { line_count: 21,
   *   block_kinds: ["Paragraph","Heading",…],      // 固定 10 项，下标稳定
   *   blocks: [[kind_idx, start_line, end_line, editable], …] }
   * ```
   *
   * @param {object} payload `open_document` / `render_preview` 的回包
   * @returns {{lineCount:number, blocks:Array, cells:Array, tasks:Array, issues:string[]}}
   *   `issues` 非空 ⇒ ⛔ 不许进编辑态（`INV-LIVE-06`）。⛔ 本函数**不抛错**：
   *   它是判据不是守卫，抛错会让整个打开流程陪葬。
   */
  function fromPayload(payload) {
    const issues = [];
    const src = payload || {};

    let lineCount = src.line_count;
    if (!Number.isInteger(lineCount) || lineCount < 1) {
      issues.push(`line_count 不是正整数：${JSON.stringify(lineCount)}`);
      lineCount = 0;
    }

    const names = src.block_kinds;
    if (!Array.isArray(names) || names.length === 0) {
      issues.push('block_kinds 缺失（种类名表是解包的前提）');
    }

    // ⭐ 表格单元格区间表（`design/0049`）：**独立字段**，⛔ 不动上面那四个数。
    //    非表格文档是空数组 ⇒ 这里一个字节都不多。
    const cells = fromCellPayload(src.table_cells, issues);

    // ⭐ 任务项区间表（`design/0051`）：同样是**独立字段**。非任务文档是空数组。
    const tasks = fromTaskPayload(src.task_items, issues);

    const rows = src.blocks;
    if (!Array.isArray(rows)) {
      issues.push('blocks 缺失');
      return { lineCount, blocks: [], cells, tasks, issues };
    }

    const blocks = [];
    let cursor = 0; // 0-based 半开游标：正文块的重叠检查
    // ⭐⚠️ 脚注定义**另开一组游标**（`bugs/0037`）：comrak 把它们物化到 AST **末尾**
    //    （Rust 侧同一事实由 `blocks.rs::脚注定义在块表末尾而行号回到原位` 钉住），
    //    而 `sourcepos` 仍指着源码**原处** ⇒ 块表里的行号**本来就不是升序**。
    //    ⛔ 别为了这里能过就把块表按行号排序——块序号是 AST 顺序，`align()` 侧
    //    按序号把定义映射到文末那个 `<section data-footnotes>`，一排序就全错位。
    let footCursor = 0;
    let sawFootnote = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row) || row.length !== 4) {
        issues.push(`块 ${i} 的线格式不是四元组：${JSON.stringify(row)}——载荷版本不一致？`);
        continue;
      }
      const kindIdx = row[0];
      const editable = row[3] === 1;

      let kind = OTHER;
      if (!Number.isInteger(kindIdx) || !Array.isArray(names) || kindIdx < 0 || kindIdx >= names.length) {
        // ⚠️ 下标越界 ⇒ 落 `Other`（⛔ 不猜一个"最像的"），并且**记一条**：
        //    这是"Rust 与前端版本不一致"的形状，必须看得见。
        issues.push(`块 ${i} 的种类下标越界：${JSON.stringify(kindIdx)}`);
      } else {
        kind = names[kindIdx];
      }

      let range;
      try {
        range = toRange(row[1], row[2]);
      } catch (e) {
        issues.push(`块 ${i}：${e.message}`);
        continue;
      }
      if (lineCount > 0 && range.to > lineCount) {
        issues.push(`块 ${i} 右端第 ${range.to} 行超出 ${lineCount} 行`);
      }
      // 重叠判据**分组**：脚注定义只在脚注组里比升序，正文块只在正文组里比。
      // ⚠️ 跨组（定义 ↔ 正文）那一半在循环**之后**归并一遍——两组各自升序，
      //    两路归并就能把所有相交的都数出来，⛔ 不需要按行号重排块表。
      if (kind === FOOTNOTE) {
        sawFootnote = true;
        if (range.from < footCursor) {
          issues.push(
            `脚注定义块 ${i} 与上一个脚注定义重叠（起点第 ${range.from + 1} 行，游标第 ${footCursor + 1} 行）`
          );
        }
        footCursor = Math.max(footCursor, range.to);
      } else {
        if (range.from < cursor) {
          issues.push(`块 ${i} 与上一块重叠（起点第 ${range.from + 1} 行，游标第 ${cursor + 1} 行）`);
        }
        cursor = Math.max(cursor, range.to);
      }

      blocks.push({
        index: i,
        kind: kind,
        // 1-based 那两个数**留着**：状态条文案、TOC 锚点、日志都按人话行号说。
        startLine: row[1],
        endLine: row[2],
        // 内部运算一律用这两个（0-based 半开）。
        from: range.from,
        to: range.to,
        editable: editable,
      });
    }

    // ⭐ 跨组重叠（正文块 ↔ 脚注定义）：两边的行区间**不许相交**——相交意味着
    //    改这一边的字会落到那一边的源码里。两组各自升序（上面两个游标查过组内），
    //    所以两路归并一遍就够：每次比较完推进**右端更靠前**的那一路，
    //    这样每个相交对都会被比到（⛔ 不是"看游标最大值"，那样 [0,2)+[10,12) 会误伤 [4,5)）。
    // ⚠️ 只在真有脚注定义时跑这一趟：无脚注的文档（绝大多数）零额外开销。
    if (sawFootnote && blocks.length > 1) {
      const body = [];
      const foot = [];
      for (let j = 0; j < blocks.length; j++) {
        (blocks[j].kind === FOOTNOTE ? foot : body).push(blocks[j]);
      }
      let a = 0;
      let f = 0;
      while (a < body.length && f < foot.length) {
        const x = body[a];
        const y = foot[f];
        if (x.from < y.to && y.from < x.to) {
          issues.push(
            `脚注定义块 ${y.index} 与块 ${x.index} 重叠（第 ${Math.max(x.from, y.from) + 1} 行）`
          );
        }
        if (x.to < y.to) a++;
        else f++;
      }
    }

    // ⭐ 两份行事实的交叉断言（评审第 13 条）：必须在 `blocks` 建好**之后**跑。
    crossCheck(blocks, cells, tasks, issues);

    return { lineCount: lineCount, blocks: blocks, cells: cells, tasks: tasks, issues: issues };
  }

  /**
   * ⭐ **两份行事实的交叉断言**（2026-10-29 代码评审第 13 条；Rust 侧同族判据是
   * `blocks.rs::cross_check`）。
   *
   * 解包出来的 `blocks`（块起止行）与 `cells` / `tasks`（每格 / 每框的行号）是同一次
   * `root.children()` 枚举的两份副本，但此前**没有任何东西钉住它们互相一致**：
   * 一格的行号可以落在它那个块的行区间之外，而两侧**单独看都对**。
   *
   * 三条判据（与 Rust 侧逐条对应）：
   * 1. 块序号必须存在（越界 ⇒ 老后端 / 线格式版本不一致）；
   * 2. `cells` 指到的块**必须是 `Table`**；
   * 3. 每格 / 每框的行号必须落在块区间内。
   *    ⚠️ `tasks` **不查块种类**——任务项可以长在 `List` / `BlockQuote` / 嵌套列表里，
   *    "哪些种类能装任务项"不是一份稳定清单（与 Rust 侧同一条理由）。
   *
   * ⚠️ 违规项在**别处**表现为"整篇不可编辑"，那句话看不出是这里坏了
   * ⇒ 每一条都自带「载荷版本不一致」的口径，好让人一眼分辨"是我们的 bug"还是"文件内容坏了"。
   *
   * @param {Array} blocks [`fromPayload`] 的产物
   * @param {Array} cells [`fromCellPayload`] 的产物
   * @param {Array} tasks [`fromTaskPayload`] 的产物
   * @param {string[]} issues 收集器（就地追加）
   */
  function crossCheck(blocks, cells, tasks, issues) {
    const list = blocks || [];
    const byIndex = function (blockIndex) {
      return blockIndex < list.length && list[blockIndex].index === blockIndex
        ? list[blockIndex]
        : null;
    };
    const cellGroups = cells || [];
    for (let i = 0; i < cellGroups.length; i++) {
      const g = cellGroups[i];
      const b = byIndex(g.blockIndex);
      if (!b) {
        issues.push(
          `table_cells 的块序号 ${g.blockIndex} 越界（共 ${list.length} 块）——载荷版本不一致？`
        );
        continue;
      }
      if (b.kind !== 'Table') {
        issues.push(
          `table_cells 的块 ${g.blockIndex} 种类是 ${b.kind}，不是 Table——载荷版本不一致？`
        );
      }
      for (let j = 0; j < g.cells.length; j++) {
        const c = g.cells[j];
        if (c.line < b.startLine || c.line > b.endLine) {
          issues.push(
            `块 ${g.blockIndex} 第 ${j} 格在第 ${c.line} 行，落在块区间 ${b.startLine}-${b.endLine} 之外`
          );
        }
      }
    }
    const taskGroups = tasks || [];
    for (let i = 0; i < taskGroups.length; i++) {
      const g = taskGroups[i];
      const b = byIndex(g.blockIndex);
      if (!b) {
        issues.push(
          `task_items 的块序号 ${g.blockIndex} 越界（共 ${list.length} 块）——载荷版本不一致？`
        );
        continue;
      }
      for (let j = 0; j < g.tasks.length; j++) {
        const t = g.tasks[j];
        if (t.line < b.startLine || t.line > b.endLine) {
          issues.push(
            `块 ${g.blockIndex} 第 ${j} 个方框在第 ${t.line} 行，落在块区间 ${b.startLine}-${b.endLine} 之外`
          );
        }
      }
    }
  }

  /**
   * ⭐ **表格单元格区间表**的解包（`design/0049` §2.1，线格式见 Rust `blocks::cells_to_wire`）：
   * ```
   * table_cells: [[block_index, [[line, from, to, writable], …]], …]
   * ```
   * ⚠️ `line` 是 **1-based**、`from`/`to` 是**该行的 UTF-16 列**（右开），
   * `writable` 是 `0/1`。⛔ 前端不做字节换算（`INV-CELL-03`）。
   *
   * ⚠️ 形状不对**只记一条、⛔ 不抛**：解包是判据不是守卫（与 [`fromPayload`] 同一条理由）。
   * 缺字段（老后端 / 非表格文档）**不算问题**——前者的表现是"点格子没反应"，
   * 由控制器在点击那一下如实告知（`design/0049` §6 第一行）。
   *
   * @returns {Array<{blockIndex:number, cells:Array<{line:number,from:number,to:number,writable:boolean}>}>}
   */
  function fromCellPayload(raw, issues) {
    const out = [];
    if (raw === undefined || raw === null) return out;
    if (!Array.isArray(raw)) {
      issues.push('table_cells 不是数组');
      return out;
    }
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i];
      if (!Array.isArray(row) || row.length !== 2) {
        issues.push(`table_cells[${i}] 不是二元组`);
        continue;
      }
      const blockIndex = row[0];
      const list = row[1];
      if (!Number.isInteger(blockIndex) || blockIndex < 0) {
        issues.push(`table_cells[${i}] 的块序号非法：${JSON.stringify(blockIndex)}`);
        continue;
      }
      if (!Array.isArray(list)) {
        issues.push(`table_cells[${i}] 的格子表不是数组`);
        continue;
      }
      const cells = [];
      let ok = true;
      for (let j = 0; j < list.length; j++) {
        const c = list[j];
        if (!Array.isArray(c) || c.length !== 4) {
          issues.push(`table_cells[${i}] 的第 ${j} 格不是四元组`);
          ok = false;
          break;
        }
        const line = c[0];
        const from = c[1];
        const to = c[2];
        const writable = c[3] === 1 || c[3] === true;
        if (!Number.isInteger(line) || line < 1 || !Number.isInteger(from) || !Number.isInteger(to)
          || from < 0 || to < from) {
          issues.push(`table_cells[${i}] 第 ${j} 格的区间非法：${JSON.stringify(c)}`);
          ok = false;
          break;
        }
        cells.push({ line: line, from: from, to: to, writable: writable });
      }
      if (!ok) continue;
      out.push({ blockIndex: blockIndex, cells: cells });
    }
    return out;
  }

  /**
   * 某个块（`block.index`，0-based 顺序号）的格子区间表；没有 ⇒ `null`。
   *
   * ⚠️ 返回的是**共享数组**，调用方⛔ 不许就地改（控制器每次提交后整表换新）。
   */
  function cellsOf(cells, blockIndex) {
    const list = cells || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].blockIndex === blockIndex) return list[i].cells;
    }
    return null;
  }

  /**
   * ⭐ **任务项区间表**的解包（`design/0051` §2.1，线格式见 Rust `blocks::tasks_to_wire`）：
   * ```
   * task_items: [[block_index, [[line, from, to, checked, writable], …]], …]
   * ```
   * ⚠️ `line` 是 **1-based**、`from`/`to` 是**该行的 UTF-16 列**（右开，恒 `to == from + 1`），
   * `checked` / `writable` 是 `0/1`。⛔ 前端不做字节换算（`INV-TASK-02`）。
   *
   * ⚠️ 形状不对**只记一条、⛔ 不抛**（与 [`fromCellPayload`] 同一条理由）。
   * 缺字段（老后端 / 非任务文档）**不算问题**——前者的表现是"点方框没反应"，
   * 由控制器在点击那一下如实告知（`design/0051` §6 第一行）。
   *
   * ⚠️ 这里⛔ **不校验"恰 1 字节"**：那是后端 `task_span()` 的活（不可写项它已经标 `writable: 0`），
   * 前端再算一遍就是第二份实现（`INV-SINGLE-01` 同族）。这里只管**形状**。
   *
   * @returns {Array<{blockIndex:number, tasks:Array<{line:number,from:number,to:number,
   *   checked:boolean,writable:boolean}>}>}
   */
  function fromTaskPayload(raw, issues) {
    const out = [];
    if (raw === undefined || raw === null) return out;
    if (!Array.isArray(raw)) {
      issues.push('task_items 不是数组');
      return out;
    }
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i];
      if (!Array.isArray(row) || row.length !== 2) {
        issues.push(`task_items[${i}] 不是二元组`);
        continue;
      }
      const blockIndex = row[0];
      const list = row[1];
      if (!Number.isInteger(blockIndex) || blockIndex < 0) {
        issues.push(`task_items[${i}] 的块序号非法：${JSON.stringify(blockIndex)}`);
        continue;
      }
      if (!Array.isArray(list)) {
        issues.push(`task_items[${i}] 的任务项表不是数组`);
        continue;
      }
      const tasks = [];
      let ok = true;
      for (let j = 0; j < list.length; j++) {
        const c = list[j];
        if (!Array.isArray(c) || c.length !== 5) {
          issues.push(`task_items[${i}] 的第 ${j} 项不是五元组`);
          ok = false;
          break;
        }
        const line = c[0];
        const from = c[1];
        const to = c[2];
        if (!Number.isInteger(line) || line < 1 || !Number.isInteger(from) || !Number.isInteger(to)
          || from < 0 || to !== from + 1) {
          issues.push(`task_items[${i}] 第 ${j} 项的区间非法：${JSON.stringify(c)}`);
          ok = false;
          break;
        }
        tasks.push({
          line: line,
          from: from,
          to: to,
          checked: c[3] === 1 || c[3] === true,
          writable: c[4] === 1 || c[4] === true,
        });
      }
      if (!ok) continue;
      out.push({ blockIndex: blockIndex, tasks: tasks });
    }
    return out;
  }

  /**
   * 某个块（`block.index`，0-based 顺序号）的任务项区间表；没有 ⇒ `null`。
   *
   * ⚠️ 返回的是**共享数组**，调用方⛔ 不许就地改（控制器每次提交后整表换新）。
   */
  function tasksOf(tasks, blockIndex) {
    const list = tasks || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].blockIndex === blockIndex) return list[i].tasks;
    }
    return null;
  }

  /**
   * 一个 DOM 节点属于哪种**形状**（词表与 [`SHAPES`] 相同）。
   *
   * ⚠️ 只看 **tagName ＋ 两三个必要的 class**，⛔ 不看文本、⛔ 不看 `data-sourcepos`
   * （那个从未打开，`INV-LIVE-05`）。
   */
  function shapeOf(node) {
    if (!node) return 'unknown';
    if (node.nodeType === COMMENT_NODE) return 'raw-html';
    if (node.nodeType !== ELEMENT_NODE) return 'unknown';
    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'P') return 'p';
    if (tag === 'PRE') return 'pre';
    if (tag === 'UL' || tag === 'OL') return 'list';
    if (tag === 'BLOCKQUOTE') return 'quote';
    if (tag === 'TABLE') return 'table';
    if (tag === 'HR') return 'hr';
    if (/^H[1-6]$/.test(tag)) return 'h';
    if (tag === 'SECTION') {
      return node.hasAttribute && node.hasAttribute('data-footnotes') ? 'footnotes' : 'unknown';
    }
    if (tag === 'DIV') {
      const cls = (node.getAttribute && node.getAttribute('class')) || '';
      if (/(^|\s)rmd-math-display(\s|$)/.test(cls)) return 'math-block';
      if (/(^|\s)rmd-diagram(\s|$)/.test(cls)) return 'diagram';
    }
    return 'unknown';
  }

  /** 这个种类**允许**哪些形状（⛔ 返回的是共享数组，调用方不许改）。 */
  function tagOf(kind) {
    return SHAPES[kind] || SHAPES[OTHER];
  }

  /** 这个种类能不能落在这个形状上。 */
  function accepts(kind, shape) {
    const list = tagOf(kind);
    for (let i = 0; i < list.length; i++) if (list[i] === shape) return true;
    return false;
  }

  /**
   * ⭐ 块表 ↔ `#doc` 的顶层子节点对齐（`design/0047` §2.2 / `INV-LIVE-06`）。
   *
   * ## 三步（顺序是判据的一部分）
   *
   * 1. **脚注定义要先摘出去**：comrak 把它们**全部搬到文末**，合并成一个
   *    `<section data-footnotes>`（2026-10-26 实测：定义在第 2 块，`<section>` 仍在最后）。
   *    ⇒ 只要块表里有 `FootnoteDefinition`，就要求**最后一个**子节点是 `footnotes` 形状
   *    并把它摘掉；否则整次对齐失败。⚠️ 不摘的话，定义之后的**每一个块都会错位一格**。
   * 2. **数量必须相等**（剩下的块 vs 剩下的子节点）。多一个少一个都是"我们不知道哪边对"，
   *    ⛔ 不猜、⛔ 不做最长公共子序列。
   * 3. **逐个比形状**：种类与形状不匹配就记一条，且**整次失败**。
   *
   * @param {Array} nodes `#doc` 的顶层子节点（`Array.from(doc.childNodes)`）
   * @param {Array} blocks [`fromPayload`] 的 `blocks`
   * @returns {{ok:boolean, issues:string[], slots:Array}}
   *   `slots` 只在 `ok` 时非空，每项 = 块 ＋ 它对应的节点。`ok === false` 时**一个都不给**
   *   ——⛔ 半个对齐比没有对齐更危险（用户改 A、屏幕上是 B）。
   */
  function align(nodes, blocks) {
    const issues = [];
    const dom = Array.prototype.slice.call(nodes || []);
    const list = blocks || [];

    let defs = [];
    let ordered = list;
    /** 文末那个脚注 section（`defs` 非空且对齐成立时才有）。 */
    let section = null;
    // 脚注定义在块表里**按源码顺序**排，而 comrak 把它们搬到文末合并成一个 section。
    // ⚠️ 实测里"定义恰好是最后一块"是常见的，但**不能**靠这个巧合：
    //    定义在中间时（`前文[^1]` + 后文）它照样被搬走。
    const defBlocks = [];
    const rest = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === FOOTNOTE) defBlocks.push(list[i]);
      else rest.push(list[i]);
    }
    if (defBlocks.length > 0) {
      defs = defBlocks;
      ordered = rest;
      if (dom.length === 0 || shapeOf(dom[dom.length - 1]) !== 'footnotes') {
        issues.push(
          `块表里有 ${defBlocks.length} 个脚注定义，但文末没有 <section data-footnotes>`
        );
      } else {
        section = dom.pop();
      }
    } else if (dom.length > 0 && shapeOf(dom[dom.length - 1]) === 'footnotes') {
      // 块表说没有脚注定义、DOM 却有一个 section ⇒ 两边不是同一份渲染。
      issues.push('DOM 文末有 <section data-footnotes>，但块表里没有脚注定义');
    }

    if (ordered.length !== dom.length) {
      issues.push(
        `数量对不上：块表 ${ordered.length} 块（另有 ${defs.length} 个脚注定义），DOM 顶层 ${dom.length} 个节点`
      );
    }

    const many = Math.min(ordered.length, dom.length);
    for (let i = 0; i < many; i++) {
      const block = ordered[i];
      const shape = shapeOf(dom[i]);
      if (!accepts(block.kind, shape)) {
        issues.push(
          `第 ${i} 块（${block.kind}，第 ${block.startLine}-${block.endLine} 行）对不上：` +
            `允许 ${JSON.stringify(tagOf(block.kind))}，DOM 是 ${shape}`
        );
      }
    }

    if (issues.length > 0) return { ok: false, issues: issues, slots: [] };

    const slots = [];
    for (let i = 0; i < ordered.length; i++) {
      slots.push({ block: ordered[i], node: dom[i] });
    }
    if (defs.length > 0) {
      for (let i = 0; i < defs.length; i++) {
        slots.push({ block: defs[i], node: section });
      }
    }
    return { ok: true, issues: [], slots: slots };
  }

  /**
   * 块间行：**0-based 行下标**数组（`design/0047` §2.8）。
   *
   * ⚠️ 就是"光标不进、边界键不吞"的那批行。它**不是**"都是空行"——
   * 里面有引用定义、未引用的脚注定义、`[TOC]` / `@(…)` 隐藏指令。
   * 认不出来的用 [`unknownGapLines`] 报警。
   */
  function gaps(blocks, lineCount) {
    const covered = new Array(lineCount);
    for (let i = 0; i < lineCount; i++) covered[i] = false;
    const list = blocks || [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      for (let l = b.from; l < b.to && l < lineCount; l++) covered[l] = true;
    }
    const out = [];
    for (let i = 0; i < lineCount; i++) if (!covered[i]) out.push(i);
    return out;
  }

  /** 连续的块间行下标 → `[{from,to}]`（0-based 半开；合并视图按区间取）。 */
  function gapRanges(gapLines) {
    const out = [];
    let i = 0;
    while (i < gapLines.length) {
      const from = gapLines[i];
      let to = from + 1;
      i++;
      while (i < gapLines.length && gapLines[i] === to) {
        to++;
        i++;
      }
      out.push({ from: from, to: to });
    }
    return out;
  }

  /**
   * ⭐ **块间行报警器**：哪几行**不像是**已知的那四类（`design/0047` §2.8 的表）。
   *
   * 白名单四类：空行（含首尾空白）、链接/脚注定义（`[x]: …`，含**它的缩进续行**）、
   * 隐藏指令（`[TOC]` / `@(标签)[目标]`）。**之外的任何一行都是问题**——它多半是
   * "块表漏了内容"，而漏内容的后果是**合并视图会把它静默删掉**。
   * ✅ 判据与 `tools/live-probe/src/fixtures.rs::unknown_gap_lines` **逐条同义**
   * （17 份语料上未知行 **0**）。
   *
   * @param {string[]} lines 全篇行（`fullText.split('\n')`）
   * @param {number[]} gapLines [`gaps`] 的结果（0-based）
   * @returns {Array<{line:number, text:string}>} `line` 是 **1-based**（说人话用）
   */
  function unknownGapLines(lines, gapLines) {
    const out = [];
    let prevWasDef = false;
    for (let i = 0; i < gapLines.length; i++) {
      const idx = gapLines[i];
      const raw = lines[idx] === undefined ? '' : lines[idx];
      const t = raw.trim();
      const indented = raw.charAt(0) === ' ' || raw.charAt(0) === '\t';
      const isDef =
        (t.slice(0, 2) === '[^' && t.indexOf(']:') >= 0) ||
        (t.charAt(0) === '[' && t.indexOf(']:') >= 0);
      const isDirective =
        t.toUpperCase() === '[TOC]' || (t.slice(0, 2) === '@(' && t.indexOf(')[') > 0 && t.slice(-1) === ']');
      if (t === '') {
        prevWasDef = false;
        continue;
      }
      if (isDef || isDirective || (indented && prevWasDef)) {
        prevWasDef = isDef;
        continue;
      }
      out.push({ line: idx + 1, text: raw });
      prevWasDef = false;
    }
    return out;
  }

  /**
   * 命中某个 **0-based 行下标**的块（没有 ⇒ `null`）。
   *
   * ⚠️ 参数是 0-based（与 [`from`]/[`to`] 同一口径）；对外说人话时用 `block.startLine`。
   */
  function locate(blocks, index) {
    const list = blocks || [];
    for (let i = 0; i < list.length; i++) {
      if (index >= list[i].from && index < list[i].to) return list[i];
    }
    return null;
  }

  const api = {
    OTHER: OTHER,
    FOOTNOTE: FOOTNOTE,
    SHAPES: SHAPES,
    toRange: toRange,
    fromPayload: fromPayload,
    crossCheck: crossCheck,
    fromCellPayload: fromCellPayload,
    cellsOf: cellsOf,
    fromTaskPayload: fromTaskPayload,
    tasksOf: tasksOf,
    shapeOf: shapeOf,
    tagOf: tagOf,
    accepts: accepts,
    align: align,
    gaps: gaps,
    gapRanges: gapRanges,
    unknownGapLines: unknownGapLines,
    locate: locate,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveBlocks = api;
})();
