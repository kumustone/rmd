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

// ⭐ `bugs/0104`（2026-11-06）：方向键上下跨格走**同一个**「同列上下行」换算，
//    ⛔ 不是在 `main.js` 里另算一套行列。
test('方向键 ↑：同列上一行；没有上一行给 -1（⛔ 不退回别的行）', function () {
  const table = fakeTable([3, 3, 3]);
  assert.strictEqual(Cell.flatAbove(table, 4), 1, '第二行中列 ⇒ 第一行中列');
  assert.strictEqual(Cell.flatAbove(table, 6), 3, '第三行首列 ⇒ 第二行首列');
  assert.strictEqual(Cell.flatAbove(table, 2), -1, '第一行 ⇒ 停住');
  assert.strictEqual(Cell.flatAbove(table, -1), -1);
  assert.strictEqual(Cell.flatAbove(table, 1.5), -1, '非整数下标同样是"没有上一格"');
  assert.strictEqual(Cell.flatAbove(table, 99), -1, '下标落不到任何一行 ⇒ -1（⛔ 当成最后一行）');
  // 上下互逆：中间行按 ↑ 再按 ↓ 回到原格
  assert.strictEqual(Cell.flatBelow(table, Cell.flatAbove(table, 7)), 7);
});

test('方向键 ↑：上一行短一格 ⇒ -1（⛔ 不猜位置）', function () {
  const table = fakeTable([2, 3]);
  assert.strictEqual(Cell.flatAbove(table, 4), -1, '上一行只有 2 格，第 3 列没有对应格');
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

// ⭐⭐ 2026-11-02（`bugs/0047`）：`\|` 是 `escapePipes` 的产物，`decode` 必须把它**还原成一个 `|`**。
//   否则发布之后「源码 `x\|y` / 视图 `x|y`」这对不一致会一直成立：
//   `commitCell` 判"编码之后没有改动"、`stillDirty` 判"脏" ⇒ 预算耗尽 ⇒ 这一格**退不出去**
//   （`⌘↵` / `Tab` / 点别处全部失败，且再提一次会把字写重）。
test('解码：`\\|` 还原成字面竖线（`escapePipes` 的逆变换）', function () {
  assert.strictEqual(Cell.encode('a|b'), 'a\\|b', '负对照：编码会给裸竖线补转义');
  assert.strictEqual(Cell.decode('a\\|b'), 'a|b', '解码必须去掉那一个反斜杠');
  assert.strictEqual(Cell.encode(Cell.decode('a\\|b')), 'a\\|b', '往返逐字稳定');
  assert.strictEqual(Cell.decode('|a\\|b'), '|a|b', '连续两个都还原');
  // ⚠️ 其余转义对仍**原样**保留：`encode` 只补竖线，`\<` 若被吞掉就没人再补回来了。
  assert.strictEqual(Cell.decode('a\\<br>b'), 'a\\<br>b');
  assert.strictEqual(Cell.encode(Cell.decode('a\\<br>b')), 'a\\<br>b');
});

test('三值判定：`judge` 是脏 / 提交 / 退出的唯一判据（`design/0058` §2.1）', function () {
  // 行 `|a\|b|` 的第一格：区间 [1,5) 盖住 `a\|b`
  const b = Cell.bind({ raw: Cell.textOf('|a\\|b|', 1, 5), from: 1, to: 5 });
  assert.strictEqual(b.raw, 'a\\|b', '原始源码切片逐字保留');
  assert.strictEqual(b.initialView, 'a|b', '初始编辑文本 = `decode(raw)`');
  assert.strictEqual(Cell.judge(b, '|a\\|b|', 'a|b').status, 'unchanged', '解码之后与视图一致');
  // ⭐ P1-1：**先比编辑文本**。用户在源码 `a\|b` 时打了字面的 `a\|b` ⇒ 变了，
  //    编码后解不回来 ⇒ `rejected`（⛔ 不许按"字节相同"判成无操作把输入吞掉）。
  const typed = Cell.judge(b, '|a\\|b|', 'a\\|b');
  assert.strictEqual(typed.status, 'rejected', '同形输入也不是无操作');
  assert.strictEqual(typed.why, 'inexpressible', '理由是"表达不了"，⛔ 不是"没改"');
  // ⭐ P1-1 负对照：把判据写成"候选字节 == 原始源码"就会在这里判 `unchanged`。
  assert.strictEqual(Cell.encode('a\\|b'), 'a\\|b', '旧的按字节判据在这个格子上确实会说"没改"');

  const changed = Cell.judge(b, '|a\\|b|', 'a|b|c');
  assert.strictEqual(changed.status, 'valid');
  assert.strictEqual(changed.nextLine, '|a\\|b\\|c|', '候选是补齐后的整行源码');

  // 全新一格（没有转义）走同一条路
  const plain = Cell.bind({ raw: Cell.textOf('|ab|', 1, 3), from: 1, to: 3 });
  assert.strictEqual(Cell.judge(plain, '|ab|', 'ab').status, 'unchanged');
  assert.strictEqual(Cell.judge(plain, '|ab|', 'a|b').nextLine, '|a\\|b|', '真打了竖线 ⇒ 要写');

  // 区间不可信 ⇒ `rejected`，⛔ 不读成"没改动"
  const broken = Cell.bind({ raw: null, from: 5, to: 9 });
  assert.strictEqual(Cell.judge(broken, '|ab|', 'x').status, 'rejected');
  assert.strictEqual(Cell.judge(broken, '|ab|', 'x').why, 'range');
});

test('绑定：`bind` 把 raw / initialView / 区间一起绑到对象与修订上', function () {
  const rev = { docSeq: 7, commitSeq: 3, renderRev: 11 };
  const b = Cell.bind({ raw: 'a<br />b', from: 2, to: 12, objectId: 'c1', revision: rev });
  assert.strictEqual(b.initialView, 'a\nb', '`<br />` 归一成换行');
  assert.strictEqual(b.objectId, 'c1');
  assert.strictEqual(b.revision, rev, '修订原样带着，⛔ 不复制成第二份真相');
  assert.strictEqual(Cell.bind({ raw: null, from: 0, to: 0 }).initialView, '', '区间不可信时没有初始文本');
});


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
 * 简易容器：只需要 `insertBefore` / `appendChild` / `removeChild` 与 `children`。
 * @param {string} id
 * @returns {any}
 */
function container(id) {
  /** @type {any} */
  const c = {
    id: id,
    nodeType: 1,
    tagName: 'DIV',
    parentNode: null,
    children: [],
    styleAttr: null,
    /** @param {string} name @param {any} v */
    setAttribute: function (name, v) { if (name === 'style') c.styleAttr = v; },
    /** @param {string} name */
    getAttribute: function (name) { return name === 'style' ? c.styleAttr : null; },
    /** @param {any} n @param {any} [ref] */
    insertBefore: function (n, ref) {
      if (n.parentNode) n.parentNode.removeChild(n);
      const i = ref ? c.children.indexOf(ref) : -1;
      if (i < 0) c.children.push(n); else c.children.splice(i, 0, n);
      n.parentNode = c;
      return n;
    },
    /** @param {any} n */
    appendChild: function (n) { return c.insertBefore(n, null); },
    /** @param {any} n */
    removeChild: function (n) {
      const i = c.children.indexOf(n);
      if (i >= 0) c.children.splice(i, 1);
      n.parentNode = null;
      return n;
    },
  };
  return c;
}

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
      parentNode: null,
      style: styleOf(id),
      styleAttr: styleAttr,
      getAttribute: function (name) { return name === 'style' ? n.styleAttr : null; },
      setAttribute: function (name, v) { if (name === 'style') n.styleAttr = v; },
      removeAttribute: function (name) { if (name === 'style') n.styleAttr = null; },
      getBoundingClientRect: function () { log.push('measure:' + id); return { width: w }; },
    };
    return n;
  }

  /** 简易容器：只需要 `insertBefore` / `appendChild` / `removeChild` 与 `children`。 */
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
  const parent = container('parent');
  parent.appendChild(table);
  return { table: table, rows: rows, parent: parent, cell: rows[0] ? rows[0].cells[0] : null, log: log };
}

/**
 * 在假 `document` 下跑一段（外壳方案要 `createElement`，Node 里没有）。
 * @param {Function} fn
 */
function withFakeDocument(fn) {
  const 旧文档 = /** @type {any} */ (globalThis).document;
  const 旧样式 = /** @type {any} */ (globalThis).getComputedStyle;
  /** @type {any} */ (globalThis).document = {
    createElement: function (tag) {
      const n = container('created:' + tag);
      n.className = '';
      n.scrollLeft = 0;
      return n;
    },
  };
  /** @type {any} */ (globalThis).getComputedStyle = function () { return { marginBottom: '15.39px' }; };
  try {
    return fn();
  } finally {
    if (旧文档 === undefined) delete /** @type {any} */ (globalThis).document;
    else /** @type {any} */ (globalThis).document = 旧文档;
    if (旧样式 === undefined) delete /** @type {any} */ (globalThis).getComputedStyle;
    else /** @type {any} */ (globalThis).getComputedStyle = 旧样式;
  }
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
  assert.ok(d.log.indexOf('write:table.width=300px') < fixedAt, '表格总宽必须写在切 `fixed` 之前');
});

test('布局冻结：表格宽 = **列宽和**（⛔ 块盒宽 —— `display:block` 的块盒铺满正文栏，短表会被拉满）', function () {
  const d = fakeDom([[100, 200], [100, 200]]);
  Cell.freezeTableLayout(d.cell);
  assert.strictEqual(d.table.style.boxSizing, 'border-box');
  assert.strictEqual(d.table.style.width, '300px');
  assert.strictEqual(d.rows[0].cells[0].style.boxSizing, 'border-box');
  assert.strictEqual(d.rows[0].cells[0].style.width, '100px');
  assert.strictEqual(d.rows[1].cells[1].style.width, '200px', '每一行都要钉（⛔ 只有表头那一行）');
});

test('布局冻结：量到 0 的宽不钉（`0px` 会把那一列 / 整张表压没）', function () {
  const d = fakeDom([[0, 200]], { total: 0 });
  Cell.freezeTableLayout(d.cell);
  assert.strictEqual(d.rows[0].cells[0].style.width, undefined, '这一列量到 0 ⇒ 不钉');
  assert.strictEqual(d.rows[0].cells[1].style.width, '200px', '负对照：另一列照钉');
  assert.strictEqual(d.table.style.width, '200px', '表宽退回列宽和，⛔ 不写 0px');
  assert.strictEqual(d.table.style.tableLayout, 'fixed', '冻结本身仍然要挂上');
  // 列宽和也是 0 ⇒ 不写宽（⛔ 别写 0px）
  const z = fakeDom([[0, 0]], { total: 0 });
  Cell.freezeTableLayout(z.cell);
  assert.strictEqual(z.table.style.width, undefined);
  assert.strictEqual(z.table.style.boxSizing, undefined);
});

// ⭐ 2026-11-09（`bugs/0297`）：`.doc table` 是 `display:block`，真正排版的是**匿名内表**，
//    而 `table-layout` 非继承 ⇒ 只在块盒上切 `fixed` **根本管不住列宽**。修法是编辑期间
//    `display:table` ＋ 一层临时外壳接住滚动与下外边距。下面四条判据把这次的结构钉住。

test('布局冻结：`display: table` ＋ 临时外壳（⛔ 只切 `fixed` —— 匿名内表不吃它）', function () {
  withFakeDocument(function () {
    const d = fakeDom([[100, 200], [100, 200]]);
    const thaw = Cell.freezeTableLayout(d.cell);
    assert.strictEqual(typeof thaw, 'function');
    const 壳 = d.parent.children[0];
    assert.ok(壳 && 壳 !== d.table, '必须建外壳：`display:table` 之后宽表没有滚动容器');
    assert.strictEqual(d.parent.children.length, 1, '外壳必须占表格原来的位置');
    assert.strictEqual(d.table.parentNode, 壳);
    assert.strictEqual(壳.children[0], d.table);
    assert.strictEqual(d.table.style.display, 'table', '⚠️ 关键：切在块盒上的 fixed 管不到匿名内表');
    assert.strictEqual(d.table.style.tableLayout, 'fixed');
    assert.match(壳.styleAttr, /width:640px/, '外壳接住块盒宽（原表格占的横向位置）');
    assert.match(壳.styleAttr, /margin-bottom:15\.39px/, '表格自己的下外边距必须挪到外壳上（否则凭空高 15px）');
    assert.strictEqual(d.table.style.marginBottom, '0');
    thaw();
    assert.strictEqual(d.parent.children.length, 1);
    assert.strictEqual(d.parent.children[0], d.table, '退出后表格必须挪回原位');
    assert.strictEqual(d.table.parentNode, d.parent);
    assert.strictEqual(d.table.styleAttr, 'width: 640px;', '表格原 style 属性逐字回来（异于冻结时的值）');
  });
});

test('布局冻结：原本不横滚 ⇒ 外壳 `overflow-x: clip`（`auto` 会凭空多一条 12px 滚动条）', function () {
  withFakeDocument(function () {
    const d = fakeDom([[100, 200], [100, 200]]);
    d.table.scrollWidth = 640;
    d.table.clientWidth = 640;
    d.table.offsetHeight = 100;
    d.table.clientHeight = 100;
    Cell.freezeTableLayout(d.cell);
    assert.match(d.parent.children[0].styleAttr, /overflow-x:clip/);
    assert.match(d.parent.children[0].styleAttr, /overflow-y:visible/);
  });
});

test('布局冻结：原本就在横滚 ⇒ 外壳 `auto`，滚动位置进出都接住（`bugs/0027` 那 12px 的位置照旧）', function () {
  withFakeDocument(function () {
    const d = fakeDom([[100, 200], [100, 200]]);
    d.table.scrollWidth = 900;
    d.table.clientWidth = 640;
    d.table.offsetHeight = 112;
    d.table.clientHeight = 100;
    d.table.scrollLeft = 120;
    const thaw = Cell.freezeTableLayout(d.cell);
    const 壳 = d.parent.children[0];
    assert.match(壳.styleAttr, /overflow-x:auto/);
    assert.match(壳.styleAttr, /overflow-y:auto/);
    assert.strictEqual(壳.scrollLeft, 120, '进入前滚在哪，编辑期间就在哪');
    壳.scrollLeft = 260; // 编辑期间用户横向滚过
    d.table.scrollLeft = 0;
    thaw();
    assert.strictEqual(d.table.scrollLeft, 260, '退出后滚动位置还回去（还原的表格自己也是滚动容器）');
  });
});

test('布局冻结：没有可挂的父节点 ⇒ 不建外壳，也⛔ 别切 `display:table`（那样会丢滚动容器）', function () {
  withFakeDocument(function () {
    const d = fakeDom([[100, 200]]);
    d.parent.removeChild(d.table);
    Cell.freezeTableLayout(d.cell);
    assert.strictEqual(d.parent.children.length, 0, '没地方挂外壳');
    assert.strictEqual(d.table.style.display, undefined, '没有外壳不得改 display');
    assert.strictEqual(d.table.style.tableLayout, 'fixed', '冻结本身仍然要挂上（退回旧行为）');
    assert.strictEqual(d.table.style.width, '300px');
  });
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

test('⭐ 变异自测：`bugs/0047` 的写坏必红、`unchanged` 判据退回比字节必红（先证明改到了）', function () {
  // M7：`decode` 不还原 `\|`（回到修复前的写法）⇒「解码」那一条必红
  const m7 = SRC.replace(
    "        if (s.charAt(i + 1) === '|') {\n"
      + "          out += '|';\n"
      + "          i += 2;\n"
      + "          continue;\n"
      + "        }\n",
    '');
  assert.notStrictEqual(m7, SRC, 'M7 没改到');
  assert.strictEqual(load(m7).decode('a\\|b'), 'a\\|b', 'M7 没红：仍然还原了字面竖线');
  assert.strictEqual(load(m7).isUnchanged('|a\\|b|', 1, 5, 'a|b'), false,
    'M7 没红：解码之后仍与视图不一致');

  // M8（`design/0058` §7 的第三条变异）：把 `unchanged` 判据改回**比字节**。
  //     用户手打的 `a\|b` 编码后与原源码逐字相同 ⇒ 变异版会把它读成"没改动"，
  //     于是**真实输入被静默吞掉**（评审 P1-1）。
  const m8 = SRC.replace(
    "    if (view === b.initialView) return { status: 'unchanged' };",
    '    if (encode(view) === b.raw) return { status: \'unchanged\' };');
  assert.notStrictEqual(m8, SRC, 'M8 没改到');
  const mut = load(m8);
  const mb = mut.bind({ raw: mut.textOf('|a\\|b|', 1, 5), from: 1, to: 5 });
  assert.strictEqual(mut.judge(mb, '|a\\|b|', 'a\\|b').status, 'unchanged',
    'M8 没红：按字节判仍然把同形输入读成无操作');
  assert.strictEqual(Cell.judge(Cell.bind({ raw: 'a\\|b', from: 1, to: 5 }), '|a\\|b|', 'a\\|b').status,
    'rejected', '负对照：产品版判 `rejected`，⛔ 不吞输入');
});


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

// ⭐ 2026-11-09（`bugs/0297`）：外壳方案的三处关键判断也必须能被变异打红——
//    "切了 fixed 就以为列宽钉住了"正是第一版在真机上失效的那个假设。
test('⭐ 变异自测：外壳方案的三处写坏必须各自让对应判据变红（`bugs/0297`）', function () {
  withFakeDocument(function () {
    // M12：只切 `table-layout: fixed`、不改 `display`（回到 2026-10-29 的写法）
    const m12 = SRC.replace("      table.style.display = 'table';\n", '');
    assert.notStrictEqual(m12, SRC, 'M12 没改到');
    const d12 = fakeDom([[100, 200]]);
    load(m12).freezeTableLayout(d12.cell);
    assert.strictEqual(d12.table.style.display, undefined, 'M12 没红：仍然改成了 display:table');
    assert.strictEqual(d12.parent.children[0].children[0], d12.table,
      '负对照：外壳照样建了 ⇒ 差异只在 display（那正是第一版的缺陷）');

    // M13：横向 overflow 一律 `clip` ⇒ 原本横滚的表格失去滚动能力
    const m13 = SRC.replace("(原横滚 ? 'auto' : 'clip')", "'clip'");
    assert.notStrictEqual(m13, SRC, 'M13 没改到');
    const d13 = fakeDom([[100, 200]]);
    d13.table.scrollWidth = 900;
    d13.table.clientWidth = 640;
    d13.table.offsetHeight = 112;
    d13.table.clientHeight = 100;
    load(m13).freezeTableLayout(d13.cell);
    assert.match(d13.parent.children[0].styleAttr, /overflow-x:clip/, 'M13 没红：本来横滚却给了 clip');

    // M14：还原时忘了把表格挪出外壳 ⇒ 表格被摘掉的外壳一起带走（屏幕上整张表消失）
    const m14 = SRC.replace(
      '        if (table.parentNode === 壳) {\n'
        + '          if (壳.parentNode) 壳.parentNode.insertBefore(table, 壳);\n'
        + '          else 壳.removeChild(table);\n'
        + '        }\n',
      '');
    assert.notStrictEqual(m14, SRC, 'M14 没改到');
    const d14 = fakeDom([[100, 200]]);
    load(m14).freezeTableLayout(d14.cell)();
    assert.strictEqual(d14.parent.children.length, 0, 'M14 没红：外壳被摘掉了（负对照）');
    assert.notStrictEqual(d14.table.parentNode, d14.parent, 'M14 没红：表格仍然回到了原位');
  });
});

// ── 点选命中：几何兜底（`bugs/0066`）────────────────────────────────────
//
// ⚠️ 为什么这条必须有：`.doc table` 是 `display:block`（让 `overflow-x` 生效的代价），
//    块盒子**铺满正文宽度**，而里面那张匿名表按内容收缩 ⇒ 窄表右侧一大片命中的是
//    `<table>` 元素本身。真 WKWebView 实测（2026-11-03，800 px 正文、3 列短表）：
//    格子右边界 158.8 px，从 158.8 px（**含边界那一像素**）到 800 px 全是 `<table>`。
//    ⇒ 用户瞄准"行尾"点下去，DOM 上溯拿不到格子，只弹提示、没有光标。

/** 造一张带**视口矩形**的假表：3 列 × 2 行，列宽 50，行高 20。 */
function fakeGrid() {
  function cell(c, r) {
    const left = c * 50;
    const top = r * 20;
    return {
      nodeType: 1,
      tagName: r === 0 ? 'TH' : 'TD',
      getBoundingClientRect: function () {
        return { left: left, right: left + 50, top: top, bottom: top + 20 };
      },
    };
  }
  const rows = [];
  for (let r = 0; r < 2; r++) {
    const cells = [];
    for (let c = 0; c < 3; c++) cells.push(cell(c, r));
    rows.push({ cells: cells });
  }
  return { rows: rows };
}

test('点选命中：格内直接命中，行按 y 分', function () {
  const t = fakeGrid();
  assert.strictEqual(Cell.cellAtPoint(t, 10, 10), t.rows[0].cells[0]);
  assert.strictEqual(Cell.cellAtPoint(t, 60, 10), t.rows[0].cells[1]);
  assert.strictEqual(Cell.cellAtPoint(t, 10, 30), t.rows[1].cells[0], '第二行按 y 分');
  assert.strictEqual(Cell.cellAtPoint(t, 149.9, 30), t.rows[1].cells[2], '格子右边界**内**那一像素');
});

test('点选命中：行尾那一像素与紧邻的容差区夹到最后一格（`bugs/0066` 的正身）', function () {
  const t = fakeGrid();
  const last = t.rows[0].cells[2];
  assert.strictEqual(Cell.cellAtPoint(t, 150, 10), last, '边界像素（实测命中 table）⇒ 最后一格');
  assert.strictEqual(Cell.cellAtPoint(t, 151, 10), last, '边界外 1 px ⇒ 仍在容差内');
  assert.strictEqual(Cell.cellAtPoint(t, 165, 10), last, '容差上限（16 px）仍算行尾');
  // ⚠️ 负对照：容差**之外**必须给 null —— 否则"点正文空白"也会跳进表格最后一格。
  assert.strictEqual(Cell.cellAtPoint(t, 167, 10), null, '超出容差 ⇒ ⛔ 不隔空抢点击');
  assert.strictEqual(Cell.cellAtPoint(t, 600, 10), null,
    '实测里窄表右侧到 800 px 都命中 table，⛔ 不能全算成最后一格');
});

test('点选命中：左侧同样有容差，且同样有边界', function () {
  const t = fakeGrid();
  assert.strictEqual(Cell.cellAtPoint(t, 0, 10), t.rows[0].cells[0]);
  assert.strictEqual(Cell.cellAtPoint(t, -8, 10), t.rows[0].cells[0], '左边界外 8 px ⇒ 第一格');
  assert.strictEqual(Cell.cellAtPoint(t, -40, 10), null, '离得太远 ⇒ null');
});

test('点选命中：竖直方向只在行附近生效，远离表格一律 null', function () {
  const t = fakeGrid();
  assert.strictEqual(Cell.cellAtPoint(t, 60, 19.5), t.rows[0].cells[1], '行内底边');
  assert.strictEqual(Cell.cellAtPoint(t, 60, 20), t.rows[0].cells[1],
    '行缝那一个像素：先命中上一行（判据是"第一个盖住它的行"，⛔ 不来回抖）');
  assert.strictEqual(Cell.cellAtPoint(t, 60, 41), t.rows[1].cells[1], '最后一行下方 1 px');
  assert.strictEqual(Cell.cellAtPoint(t, 60, 200), null, '离表 180 px ⇒ null');
});

test('点选命中：坏输入一律 null（⛔ 不猜）', function () {
  const t = fakeGrid();
  assert.strictEqual(Cell.cellAtPoint(null, 10, 10), null);
  assert.strictEqual(Cell.cellAtPoint({ rows: [] }, 10, 10), null);
  assert.strictEqual(Cell.cellAtPoint(t, NaN, 10), null);
  assert.strictEqual(Cell.cellAtPoint(t, 10, Infinity), null);
  // ⚠️ 故意传字符串：运行时要挡的是**任何**非有限数，⛔ 不只是 NaN。
  const notNumber = /** @type {any} */ ('10');
  assert.strictEqual(Cell.cellAtPoint(t, notNumber, 10), null, '非数字 ⇒ null');
  const noRect = { rows: [{ cells: [{ nodeType: 1, tagName: 'TD' }] }] };
  assert.strictEqual(Cell.cellAtPoint(noRect, 10, 10), null, '量不到矩形 ⇒ null（⛔ 拿 0 冒充）');
});

test('变异 m9：去掉右侧容差 ⇒ 行尾那几条必红，格内那条仍绿', function () {
  const m9 = SRC.replace('    return (x - lastR.right) <= s ? cells[cells.length - 1] : null;',
    '    return null;');
  assert.notStrictEqual(m9, SRC, 'm9 没改到');
  const mut = load(m9);
  const t = fakeGrid();
  assert.strictEqual(mut.cellAtPoint(t, 151, 10), null, 'm9 没红：边界外仍然命中了最后一格');
  assert.strictEqual(mut.cellAtPoint(t, 60, 10), t.rows[0].cells[1], '负对照：格内命中不受影响');
});

test('变异 m10：去掉竖直距离上限 ⇒ 离表 180 px 也会抢到格子', function () {
  const m10 = SRC.replace('    if (!row || bestDist > rowH) return null;',
    '    if (!row) return null;');
  assert.notStrictEqual(m10, SRC, 'm10 没改到');
  const mut = load(m10);
  const t = fakeGrid();
  assert.notStrictEqual(mut.cellAtPoint(t, 60, 200), null, 'm10 没红：远处仍然命中');
  assert.strictEqual(Cell.cellAtPoint(t, 60, 200), null, '负对照：产品版给 null');
});

// ⭐ `bugs/0104`（2026-11-06）：方向键 ↑ 跨格走同一套行列换算，写坏必须打红。
test('变异 m11：↑ 不算列偏移 ⇒"同列上一行"那几条必红', function () {
  const m11 = SRC.replace('        return start - counts[r - 1] + col;',
    '        return start - counts[r - 1];');
  assert.notStrictEqual(m11, SRC, 'm11 没改到');
  const mut = load(m11);
  const table = fakeTable([3, 3, 3]);
  assert.notStrictEqual(mut.flatAbove(table, 4), 1, 'm11 没红：↑ 落到了上一行的首列');
  assert.strictEqual(mut.flatAbove(table, 6), 3, '负对照：首列本来就该落到上一行首列');
  assert.strictEqual(Cell.flatAbove(table, 4), 1, '负对照：产品版同列上下');
});
