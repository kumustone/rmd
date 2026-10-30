// `src/live/cell.js` 的纯逻辑判据 —— `design/0049` §7「纯逻辑（JS）」那一行。
//
// ⭐ 为什么这一份必须存在：单元格写回的三类后果里**三类都不上屏**
//    （两侧填充空格被吃掉 / 竖线多转义一层 / 中文切进字符中间），
//    而它们写下去就是**另一份源码**，只有在字节层才看得见。
//
// ⚠️ 变异自测在最后：判据喂给"写坏的副本"必须变红。

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const Cell = require('../../src/live/cell.js');

/** 造一张假表（`rows[r].cells`，够 `rowCounts` / `flatIndexOf` 用）。 */
function fakeTable(counts) {
  const rows = [];
  let n = 0;
  for (let r = 0; r < counts.length; r++) {
    const cells = [];
    for (let c = 0; c < counts[r]; c++) {
      cells.push({ id: n++, nodeType: 1, tagName: c === 0 && r === 0 ? 'TH' : 'TD' });
    }
    rows.push({ cells: cells });
  }
  return { rows: rows };
}

test('扁平下标：行主序，表头行也在里面', function () {
  const table = fakeTable([3, 3]);
  assert.strictEqual(Cell.countCells(table), 6);
  assert.deepStrictEqual(Cell.rowCounts(table), [3, 3]);
  assert.strictEqual(Cell.flatIndexOf(table, table.rows[0].cells[0]), 0);
  assert.strictEqual(Cell.flatIndexOf(table, table.rows[0].cells[2]), 2);
  assert.strictEqual(Cell.flatIndexOf(table, table.rows[1].cells[0]), 3);
  assert.strictEqual(Cell.flatIndexOf(table, { nodeType: 1, tagName: 'TD' }), -1, '不是这张表的格子 ⇒ -1');
});

test('反查：扁平下标 → 那一格', function () {
  const table = fakeTable([2, 2, 2]);
  assert.strictEqual(Cell.cellAtIndex(table, 0), table.rows[0].cells[0]);
  assert.strictEqual(Cell.cellAtIndex(table, 4), table.rows[2].cells[0]);
  assert.strictEqual(Cell.cellAtIndex(table, 6), null, '越界 ⇒ null（⛔ 不夹取到最后一格）');
});

test('走格：Tab / ⇧Tab 到端点给 -1（⛔ 不环绕）', function () {
  const table = fakeTable([2, 2]);
  assert.strictEqual(Cell.flatAfter(table, 0, 1), 1);
  assert.strictEqual(Cell.flatAfter(table, 1, 1), 2, '跨行连续');
  assert.strictEqual(Cell.flatAfter(table, 3, 1), -1, '最后一格之后 ⇒ 退出');
  assert.strictEqual(Cell.flatAfter(table, 0, -1), -1, '第一格之前 ⇒ 退出');
});

test('Enter：同列下一行；没有下一行给 -1', function () {
  const table = fakeTable([3, 3]);
  assert.strictEqual(Cell.flatBelow(table, 1), 4);
  assert.strictEqual(Cell.flatBelow(table, 5), -1, '最后一行 ⇒ 退出');
});

test('`|` 转义：裸竖线补一个反斜杠', function () {
  assert.strictEqual(Cell.escapePipes('a|b'), 'a\\|b');
  assert.strictEqual(Cell.escapePipes('a\\|b'), 'a\\|b', '已有奇数个反斜杠 ⇒ ⛔ 不再加');
  assert.strictEqual(Cell.escapePipes('a\\\\|b'), 'a\\\\\\|b', '偶数个反斜杠 ⇒ 仍然要加（`\\\\|` 是"转义反斜杠 + 裸竖线"）');
  assert.strictEqual(Cell.escapePipes('a\\b'), 'a\\b', '孤立的反斜杠不动');
  assert.strictEqual(Cell.escapePipes('||||'), '\\|\\|\\|\\|');
});

// ⭐ 2026-10-28 用户需求变更（`bugs/0035`）：格内换行**保留**，存储形态是 `<br>`
//   （GFM 的单元格写不进字面换行；后端 `parser.rs::honor_cell_line_breaks` 只把
//   **单元格内**的 `<br>` 还原成换行节点）。⛔ 别再折成空格。
test('编码：换行写成 `<br>`，再转义竖线', function () {
  assert.strictEqual(Cell.encode('a\nb'), 'a<br>b');
  assert.strictEqual(Cell.encode('a\r\nb'), 'a<br>b');
  assert.strictEqual(Cell.encode('a\rb'), 'a<br>b');
  assert.strictEqual(Cell.encode('a\n|b'), 'a<br>\\|b', '先折行再转义');
  assert.strictEqual(Cell.encode('a\n\nb'), 'a<br><br>b', '连续两个换行 ⇒ 两个 `<br>`');
});

test('解码：`<br>` 家族还原成换行（编码的逆变换）', function () {
  assert.strictEqual(Cell.decode('a<br>b'), 'a\nb');
  assert.strictEqual(Cell.decode('a<BR/>b'), 'a\nb');
  assert.strictEqual(Cell.decode('a<br />b'), 'a\nb');
  assert.strictEqual(Cell.decode('<b>x</b>'), '<b>x</b>', '其余裸 HTML 原样留着（后端不渲染它们）');
  assert.strictEqual(Cell.decode('a\nb'), 'a\nb', '本来就是换行的不动');
  // ⭐ 逆变换：源码 ⇄ 视图 往返恒等（⛔ 少了哪一半都会在"再次点进这一格"时露馅）
  for (const src of ['a<br>b', 'a<br/>b', 'a<br />b', '第一行<br>第二行']) {
    assert.strictEqual(Cell.encode(Cell.decode(src)), src.replace(/<br\s*\/?>/gi, '<br>'), src);
  }
});

// ⭐ 2026-10-29 评审第 14 条 (a)（`bugs/0040`）：代码 span 里的 `<br>` **不解码**。
//   后端 `honor_cell_line_breaks` 按**节点类型**换行（只认 `HtmlInline`），
//   而 `` `<br>` `` 是 `Code` 节点 ⇒ 阅读态**显示字面的四个字符**。
//   前端若照正则一律解码，同一个格子就成了「阅读态显示 `<br>`、编辑态显示换行」。
test('解码：代码 span 里的 `<br>` 原样留着（与后端同口径）', function () {
  assert.strictEqual(Cell.decode('`<br>`'), '`<br>`', '代码 span 里的是字面量');
  assert.strictEqual(Cell.decode('`a<br>b`c<br>d'), '`a<br>b`c\nd', '⛔ 只跳过反引号段');
  assert.strictEqual(Cell.decode('``a`<br>``'), '``a`<br>``', '双反引号段可含单个反引号');
  assert.strictEqual(Cell.decode('a`b<br>c'), 'a`b\nc', '⛔ 没有等长收尾 ⇒ 反引号是字面的，`<br>` 照样解码');
  assert.strictEqual(Cell.decode('`x`'), '`x`');
  assert.strictEqual(Cell.decode('`a<br>'), '`a\n', '未闭合的反引号是字面量 ⇒ `<br>` 照样解码');
});

// ⭐⭐ 2026-10-29 复评 P2-5：**转义语义**。这些格子**不是**"几个正则示例"——
//   六条源码与 `src-tauri/src/document/parser.rs::单元格里的_br_转义语义` **逐字同一串**，
//   那一份用真 comrak 判"这一格到底有没有换行"，这一份判 `decode` 的结论与它一致。
//   ⚠️ 改动时**两份同批改**；只改一边就等于把"与后端同口径"变成了自说自话。
test('与真 comrak 夹具逐格对齐：转义 / 代码 span / 奇偶反斜杠', function () {
  // [格内源码, 真 comrak 有没有渲染出换行, 期望的视图文本]
  /** @type {Array<[string, boolean, string]>} */
  const cases = [
    ['a\\<br>b', false, 'a\\<br>b'], // 转义的尖括号 ⇒ 字面 `<br>`
    ['\\`a<br>b`', true, '\\`a\nb`'], // 转义的反引号 ⇒ **不是**代码 span
    ['`a<br>b`', false, '`a<br>b`'], // 代码 span ⇒ 字面
    ['a\\\\<br>b', true, 'a\\\\\nb'], // 偶数个反斜杠 ⇒ 真标签
    ['a\\\\\\<br>b', false, 'a\\\\\\<br>b'], // 奇数个 ⇒ 转义的尖括号
    ['``a`b<br>c``', false, '``a`b<br>c``'], // 等长反引号串 ⇒ 代码 span
  ];
  for (const [src, br, view] of cases) {
    const got = Cell.decode(src);
    assert.strictEqual(got, view, '源码 ' + JSON.stringify(src));
    // 反向自证：`decode` 认不认这个换行，必须与后端**同一个判断**
    assert.strictEqual(got.indexOf('\n') >= 0, br, '换行判定与真 comrak 不一致：' + JSON.stringify(src));
  }
});

test('往返：源码 → 视图 → 源码，只有 `<br>` 的写法会被归一', function () {
  for (const src of ['a\\<br>b', '`a<br>b`', 'a\\\\<br>b', 'a\\\\\\<br>b', '``a`b<br>c``']) {
    assert.strictEqual(Cell.encode(Cell.decode(src)), src, '转义夹具往返被改动：' + JSON.stringify(src));
  }
  // ⚠️ 只有"真换行"那一条会归一成 `<br>`（`<br />` ⇒ `<br>`），这是**有意**的（同 `bugs/0040`）
  assert.strictEqual(Cell.encode(Cell.decode('\\`a<br />b`')), '\\`a<br>b`');
});

test('编码：换行前紧邻奇数个反斜杠 ⇒ 补一个，⛔ 不许让 `<br>` 被转义', function () {
  // ⚠️ 负对照：不补的话后端把 `\<` 当成转义尖括号 ⇒ 用户打的换行变成字面的四个字符
  assert.notStrictEqual('a\\' + '<br>' + 'b', 'a\\\\<br>b', '这就是那个错法');
  assert.strictEqual(Cell.encode('a\\\nb'), 'a\\\\<br>b', '奇数 ⇒ 补一个');
  assert.strictEqual(Cell.encode('a\\\\\nb'), 'a\\\\<br>b', '偶数 ⇒ ⛔ 不动');
  assert.strictEqual(Cell.encode('a\nb'), 'a<br>b', '没有反斜杠 ⇒ 原样');
  // 补出来的那一份，解码回来必须**仍是同一处换行**（视图里多一个反斜杠，是有意接受的代价）
  assert.strictEqual(Cell.decode(Cell.encode('a\\\nb')), 'a\\\\\nb');
  assert.strictEqual(Cell.encode(Cell.decode(Cell.encode('a\\\nb'))), Cell.encode('a\\\nb'), '第二次往返起字节稳定');
});

// ⭐⭐ 2026-10-29 评审第 14 条 (b)（`bugs/0040`）：**无改动判据比视图文本，⛔ 不比编码之后的串**。
//   `decode` 把 `<br />` 归一成 `\n`，`encode` 再一律写回 `<br>` ⇒
//   `encode(decode(src)) !== src`，于是"点进去、什么都不改、再点出来"会**静默改写源码**。
test('无改动判据：`<br />` / `<BR>` 仅仅换个写法不算改动', function () {
  // 负对照：**旧的**判据（比编码之后的串）在同一个格子上必然判"脏"——这就是那个 bug。
  assert.notStrictEqual(Cell.encode(Cell.decode('a<br />b')), 'a<br />b', '旧判据在这里必然撒谎');

  assert.strictEqual(Cell.isUnchanged('|a<br />b|', 1, 9, 'a\nb'), true, '`<br />` 没改');
  assert.strictEqual(Cell.isUnchanged('|a<BR>b|', 1, 7, 'a\nb'), true, '大写 `<BR>` 没改');
  assert.strictEqual(Cell.isUnchanged('|a<br>b|', 1, 7, 'a\nb'), true, '已经是规范写法也没改');
  assert.strictEqual(Cell.isUnchanged('|a|b|', 1, 2, 'a'), true, '没有换行的普通格子');
  assert.strictEqual(Cell.isUnchanged('|a<br>b|', 1, 7, 'a\nc'), false, '真改了字 ⇒ 脏');
  assert.strictEqual(Cell.isUnchanged('|a<br>b|', 1, 7, 'a\nb\nc'), false, '多一行 ⇒ 脏');
  assert.strictEqual(Cell.isUnchanged('|`<br>`|', 1, 7, '`<br>`'), true, '代码 span 里的不是换行');
  assert.strictEqual(Cell.isUnchanged('|`<br>`|', 1, 7, '`\n`'), false, '真把代码 span 改了 ⇒ 脏');
  assert.strictEqual(Cell.isUnchanged('|a|', 5, 9, 'a'), false, '区间不可信 ⇒ ⛔ 不读成"没改动"');
});

// ⭐ 2026-10-28 评审 P1（`INV-CELL-02` 的第二半）：末尾反斜杠会吃掉**右侧分隔竖线**。
//   真 comrak 0.56.0 实测（`scanners.re:405` 的 re2c 最长匹配）：
//   `|z\|y|` ⇒ `<td>z\|y</td><td></td>`、`|z\\|y|` ⇒ **也合并**（⛔ 翻倍没用）、
//   `|z\ |y|` ⇒ `<td>z\</td><td>y</td>` ✅。
//   ⇒ 修法是**插一个空格**（`padFor`），不是"末尾凑成偶数"。
test('编码：不做右侧补位（补位取决于插入点右边，见 padFor）', function () {
  assert.strictEqual(Cell.encode('z\\'), 'z\\', '⛔ encode 不再自己补反斜杠');
  assert.strictEqual(Cell.encode('z\\\\'), 'z\\\\');
  assert.strictEqual(Cell.encode('z'), 'z');
  assert.strictEqual(Cell.encode(''), '');
  assert.strictEqual(Cell.encode('a|'), 'a\\|', '`|` ⇒ `\\|`，末尾 0 个反斜杠');
  assert.strictEqual(Cell.trailingBackslashes('a\\\\\\'), 3);
  assert.strictEqual(Cell.trailingBackslashes('a\\b\\'), 1);
  assert.strictEqual(Cell.trailingBackslashes('a'), 0);
});

test('补位：末尾反斜杠 ＋ 右边紧贴 `|` ⇒ 补一个空格（唯一断得开的写法）', function () {
  // `|x|y|` 的第一格：区间 [1,2)，右边是 '|'
  assert.strictEqual(Cell.padFor('|x|y|', 2, 'z\\'), 'z\\ ');
  // ⚠️ **偶数个也要补**：`|z\\|y|` 实测照样合并（评审报告里"凑成偶数"的建议在这里无效）
  assert.strictEqual(Cell.padFor('|x|y|', 2, 'z\\\\'), 'z\\\\ ');
  // 末尾没有反斜杠 ⇒ 一字不动
  assert.strictEqual(Cell.padFor('|x|y|', 2, 'z'), 'z');
  assert.strictEqual(Cell.padFor('|x|y|', 2, 'a\\|'), 'a\\|', '末尾是 `|` ⇒ 不是反斜杠');
});

test('补位：右边已经是空白 / 是行尾 ⇒ ⛔ 不再补（否则每编辑一次多一个空格）', function () {
  // 右边是填充空格：`| z | y |` 的区间 [2,3)，charAt(3) === ' '
  assert.strictEqual(Cell.padFor('| z | y |', 3, 'z\\'), 'z\\', '已有空格 ⇒ 断得开，不再补');
  // 行尾（最后一格没写收尾竖线）：没有竖线可吃
  assert.strictEqual(Cell.padFor('|x|z\\', 5, 'z\\'), 'z\\', '行尾 ⇒ 不补');
  // 越界 / 非整数 ⇒ 保守不补
  assert.strictEqual(Cell.padFor('|x|y|', 99, 'z\\'), 'z\\');
  assert.strictEqual(Cell.padFor('|x|y|', 0.5, 'z\\'), 'z\\');
});

test('补位：写回之后**再进来一次**不会多长出一个空格（幂等）', function () {
  // 第一次：`|x|y|` 的 `x` 改成 `z\`
  const first = Cell.splice('|x|y|', 1, 2, Cell.padFor('|x|y|', 2, Cell.encode('z\\')));
  assert.strictEqual(first, '|z\\ |y|');
  // 第二次：后端给的区间是**修剪后**的 [1,3)，右边此时是 ' ' ⇒ 不再补
  const second = Cell.splice(first, 1, 3, Cell.padFor(first, 3, Cell.encode('z\\')));
  assert.strictEqual(second, first, '⛔ 跨轮累积空格');
});

test('写回：只替换内容区间，两侧一个字节不动', function () {
  const line = '| 甲 | 乙 |';
  // `| 甲 | 乙 |`：0='|',1=' ',2='甲',3=' ',4='|',5=' ',6='乙',7=' ',8='|'
  assert.strictEqual(Cell.splice(line, 2, 3, '丙丁'), '| 丙丁 | 乙 |');
  // ⚠️ 前导空格的位置不动 ⇒ 这一行的对齐（`| ` 那一格）逐字保持
  assert.strictEqual(Cell.splice(line, 2, 3, ''), '|  | 乙 |');
  assert.strictEqual(Cell.splice(line, 2, 3, 'x'), '| x | 乙 |');
});

test('写回：中文按 UTF-16 列切（⛔ 不按字节）', function () {
  const line = '| 😀 | 乙 |';
  // '😀' 占 2 个 UTF-16 码元：0='|',1=' ',2..3='😀',4=' ',5='|'
  assert.strictEqual(Cell.textOf(line, 2, 4), '😀');
  assert.strictEqual(Cell.splice(line, 2, 4, '🙂'), '| 🙂 | 乙 |');
});

test('写回：越界抛错（⛔ 不夹取）', function () {
  assert.throws(function () { Cell.splice('abc', 0, 9, 'x'); }, /越界/);
  assert.throws(function () { Cell.splice('abc', 2, 1, 'x'); }, /越界/);
  assert.throws(function () { Cell.splice('abc', -1, 1, 'x'); }, /越界/);
  assert.throws(function () { Cell.splice('abc', 0.5, 1, 'x'); }, /整数/);
  assert.strictEqual(Cell.textOf('abc', 0, 9), null, '取文本的越界 ⇒ null（调用方如实告知）');
});

test('配对判据：DOM 格子数必须等于载荷格子数', function () {
  const table = fakeTable([2, 3]);
  assert.strictEqual(Cell.countCells(table), 5);
  assert.notStrictEqual(Cell.countCells(table), 4, '少一格 ⇒ 调用方必须拒绝进入（INV-CELL-06）');
});

// ── 布局冻结（`INV-CELL-04`）──────────────────────────────────────────
// ⭐ 2026-10-29 代码评审第 15 条：这一段此前住在 `main.js`，**任何断言都碰不到**。
//    三个坑（先量还是先切 `fixed` / `border-box` 有没有写 / 还原用属性还是属性名）
//    全是静默的：屏幕上看只是"编辑期间表格跳了一下"。

/**
 * 造一张能跑 `freezeTableLayout` 的假表。
 * ⚠️ `style` 用 `Proxy` 记账 —— 判据要判的是**写的顺序**（先量、再写宽、最后切 `fixed`），
 *    而顺序在真 DOM 上没有可观测的痕迹。
 * @param {number[][]} widths 每行每格的边框盒宽
 * @param {{total?:number, tableStyle?:string, cellStyle?:string|null}} [opt]
 */
function fakeDom(widths, opt) {
  const o = opt || {};
  /** @type {string[]} */
  const log = [];

  function styleOf(id) {
    /** @type {any} */
    const raw = {};
    return new Proxy(raw, {
      set: function (t, k, v) {
        log.push('write:' + id + '.' + String(k) + '=' + String(v));
        t[k] = v;
        return true;
      },
      get: function (t, k) { return t[k]; },
    });
  }

  function node(id, tag, w, styleAttr) {
    /** @type {any} */
    const n = {
      id: id,
      nodeType: 1,
      tagName: tag,
      style: styleOf(id),
      styleAttr: styleAttr,
      getAttribute: function (name) { return name === 'style' ? n.styleAttr : null; },
      setAttribute: function (name, v) { if (name === 'style') n.styleAttr = v; },
      removeAttribute: function (name) { if (name === 'style') n.styleAttr = null; },
      getBoundingClientRect: function () { log.push('measure:' + id); return { width: w }; },
    };
    return n;
  }

  const rows = widths.map(function (row, r) {
    return { cells: row.map(function (w, c) {
      return node('r' + r + 'c' + c, r === 0 ? 'TH' : 'TD', w, o.cellStyle);
    }) };
  });
  const table = node('table', 'TABLE', o.total === undefined ? 640 : o.total,
    o.tableStyle === undefined ? 'width: 640px;' : o.tableStyle);
  table.rows = rows;
  rows.forEach(function (row) {
    row.cells.forEach(function (c) {
      c.closest = function (sel) { return sel === 'table' ? table : null; };
    });
  });
  return { table: table, rows: rows, cell: rows[0] ? rows[0].cells[0] : null, log: log };
}

/** 日志里第一处写入的下标（没有写入 ⇒ -1）。 */
function firstWrite(log) {
  return log.findIndex(function (x) { return x.indexOf('write:') === 0; });
}

/** 日志里最后一处测量的下标（没测量 ⇒ -1）。 */
function lastMeasure(log) {
  let at = -1;
  log.forEach(function (x, i) { if (x.indexOf('measure:') === 0) at = i; });
  return at;
}

test('布局冻结：没有表格 ⇒ null（仍可编辑，只是会跳，§6）', function () {
  assert.strictEqual(Cell.freezeTableLayout(null), null);
  assert.strictEqual(Cell.freezeTableLayout({ nodeType: 1 }), null, '没有 closest');
  assert.strictEqual(Cell.freezeTableLayout({ closest: function () { return null; } }), null, '不在表里');
});

test('布局冻结：先量完、再写宽、最后切 `fixed`', function () {
  const d = fakeDom([[100, 200], [100, 200]]);
  const thaw = Cell.freezeTableLayout(d.cell);
  assert.strictEqual(typeof thaw, 'function');
  // ⚠️ 切早了会先按 auto 重排一次，量到的是**重排后**的宽 ⇒ 冻结的是错的列宽。
  assert.ok(lastMeasure(d.log) >= 0, '一次都没量');
  assert.ok(lastMeasure(d.log) < firstWrite(d.log), '切 `fixed` 之前必须先量好：' + d.log.join(' | '));
  const fixedAt = d.log.indexOf('write:table.tableLayout=fixed');
  assert.ok(fixedAt >= 0, '没有切 `table-layout: fixed` —— 敲一个字整张表就重排');
  assert.ok(d.log.indexOf('write:table.width=640px') < fixedAt, '表格总宽必须写在切 `fixed` 之前');
});

test('布局冻结：`border-box` 表格与每一格都要写（否则每列涨 padding ＋ border，实测 +15 px）', function () {
  const d = fakeDom([[100, 200], [100, 200]]);
  Cell.freezeTableLayout(d.cell);
  assert.strictEqual(d.table.style.boxSizing, 'border-box');
  assert.strictEqual(d.table.style.width, '640px');
  assert.strictEqual(d.rows[0].cells[0].style.boxSizing, 'border-box');
  assert.strictEqual(d.rows[0].cells[0].style.width, '100px');
  assert.strictEqual(d.rows[1].cells[1].style.width, '200px', '每一行都要钉（⛔ 只有表头那一行）');
});

test('布局冻结：量到 0 的宽不钉（`0px` 会把那一列 / 整张表压没）', function () {
  const d = fakeDom([[0, 200]], { total: 0 });
  Cell.freezeTableLayout(d.cell);
  assert.strictEqual(d.table.style.width, undefined, '总宽量不到 ⇒ ⛔ 别写 0px');
  assert.strictEqual(d.table.style.boxSizing, undefined);
  assert.strictEqual(d.rows[0].cells[0].style.width, undefined, '这一列量到 0 ⇒ 不钉');
  assert.strictEqual(d.rows[0].cells[1].style.width, '200px', '负对照：另一列照钉');
  assert.strictEqual(d.table.style.tableLayout, 'fixed', '冻结本身仍然要挂上');
});

test('布局冻结：后面的行比首行多出格子 ⇒ 多出来的不钉（不猜）', function () {
  const d = fakeDom([[100, 100], [100, 100, 100]]);
  Cell.freezeTableLayout(d.cell);
  assert.strictEqual(d.rows[0].cells[1].style.width, '100px');
  assert.strictEqual(d.rows[1].cells[2].style.width, undefined);
});

test('布局冻结：还原写回**原始 style 属性原文**（⛔ 逐属性置空）', function () {
  const d = fakeDom([[100, 200]], { tableStyle: 'width: 640px; color: red', cellStyle: null });
  const thaw = Cell.freezeTableLayout(d.cell);
  assert.strictEqual(d.table.style.tableLayout, 'fixed', '冻结期间真的改过（负对照）');
  thaw();
  assert.strictEqual(d.table.styleAttr, 'width: 640px; color: red', '作者写的内联样式必须逐字回来');
  assert.strictEqual(d.rows[0].cells[1].styleAttr, null, '本来没有 style 属性 ⇒ 摘掉，⛔ 留一个空属性');
});

// ── 变异自测：判据必须能打红"写坏的副本" ──────────────────────────────

test('变异 m1：反斜杠计数写成"只要有一个就不加" ⇒ 偶数个那条必红', function () {
  const broken = function (s) {
    return String(s).replace(/(^|[^\\])\|/g, '$1\\|');
  };
  assert.strictEqual(Cell.escapePipes('a\\\\|b'), 'a\\\\\\|b');
  assert.notStrictEqual(broken('a\\\\|b'), Cell.escapePipes('a\\\\|b'), '变异副本必须与产品不一致');
});

test('顺序：先换行后转义（⚠️ 2026-10-28 起这一步已有等价性，见注释）', function () {
  // ⚠️⚠️ **`bugs/0035` 之后这条变异（m2：转义 → 换行）变成"改法等价"**：
  //    `<br>` 里没有竖线、`escapePipes` 也不碰 `<`/`>` ⇒ 两种顺序逐字相同
  //    （实测：产品 `a\|<br>b`，变异同样 `a\|<br>b`）。
  //    ⇒ 它现在只钉住**结果**，⛔ 别把这条当成"顺序被守住了"。
  //    顺序在折成**空格**的年代是有区别的（空格会被当成"折出来的空位"），`bugs/0035` 之后没有了。
  assert.strictEqual(Cell.encode('a|\nb'), 'a\\|<br>b');
});

test('变异 m3：写回时把整行重拼（丢掉两侧填充）⇒ 第一条必红', function () {
  const broken = function (line, from, to, text) {
    return '| ' + text + ' |';
  };
  assert.strictEqual(Cell.splice('| 甲 | 乙 |', 2, 3, '丙'), '| 丙 | 乙 |');
  assert.notStrictEqual(broken('| 甲 | 乙 |', 2, 3, '丙'), Cell.splice('| 甲 | 乙 |', 2, 3, '丙'));
});

// ⚠️⚠️ 布局冻结这三条对**源码**做：`freezeTableLayout` 是 IIFE 里的闭包，
//    改导出对象不会影响它自己捕获的东西 —— 那正是"没改到"与"判据不敏感"输出
//    一模一样的坑（`live-box.test.js` 同款教训）。
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'live', 'cell.js'), 'utf8');

/** 在**独立模块作用域**里跑一遍源码（不碰全局 `window`）。 */
function load(src) {
  const mod = { exports: {} };
  new Function('module', 'window', src)(mod, undefined);
  return mod.exports;
}

test('⭐ 变异自测：布局冻结的三处写坏必须各自让对应判据变红（先证明改到了）', function () {
  // M4：先切 `fixed` 再量（量到的已经是重排后的列宽 ⇒ 冻结的是错的宽）
  const MEASURE_AT = '    const first = table.rows.length > 0 ? table.rows[0] : null;';
  const m4 = SRC.replace(MEASURE_AT, "    table.style.tableLayout = 'fixed';\n" + MEASURE_AT);
  assert.notStrictEqual(m4, SRC, 'M4 没改到');
  const d4 = fakeDom([[100, 200], [100, 200]]);
  load(m4).freezeTableLayout(d4.cell);
  assert.ok(lastMeasure(d4.log) > firstWrite(d4.log), 'M4 没红：测量仍然在第一次写入之前');

  // M5：不写 `border-box`（每列涨 padding ＋ border，实测 +15 px，屏幕上只是"表格宽了一点"）
  //    ⚠️ 变异落在**值**上（`border-box` → `content-box`），⛔ 不是删掉那一句：
  //    删掉会留下 `table.void 0;` —— 那不是产品缺陷，是一段语法错误。
  const m5 = SRC.split("boxSizing = 'border-box';").join("boxSizing = 'content-box';");
  assert.notStrictEqual(m5, SRC, 'M5 没改到');
  const d5 = fakeDom([[100, 200], [100, 200]]);
  load(m5).freezeTableLayout(d5.cell);
  assert.strictEqual(d5.table.style.boxSizing, 'content-box', 'M5 没红：表格仍是 border-box');
  assert.strictEqual(d5.rows[0].cells[0].style.boxSizing, 'content-box', 'M5 没红：格子仍是 border-box');

  // M6：还原一律 `removeAttribute`（作者写的内联宽度/颜色被一起删掉，而退出后看起来"正常"）
  const m6 = SRC.replace(
    "        if (saved[i].style === null) saved[i].el.removeAttribute('style');\n"
      + "        else saved[i].el.setAttribute('style', saved[i].style);",
    "        saved[i].el.removeAttribute('style');");
  assert.notStrictEqual(m6, SRC, 'M6 没改到');
  const d6 = fakeDom([[100, 200]], { tableStyle: 'width: 640px; color: red', cellStyle: null });
  load(m6).freezeTableLayout(d6.cell)();
  assert.strictEqual(d6.table.styleAttr, null, 'M6 没红：原 style 属性没被删');
});
