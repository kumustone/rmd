// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// 表格单元格的**纯逻辑**：扁平下标换算、独占区间写回、`|` 转义、换行 ↔ `<br>` —— `design/0049` §2.1。
//
// # 它负责什么、⛔ 不负责什么
//
// 这里回答四个问题，四个都**不碰 CM6、不碰控制器、不发 IPC**，因此全部能在 node 里跑
// （`INV-CELL-01/02/03`；`design/0049` §7「纯逻辑（JS）」那一行）：
//   ① `<td>`/`<th>` ↔ 行主序**扁平下标**的换算（载荷是扁平数组，DOM 是行列两层）；
//   ② 写回：**只替换**修剪后的内容区间，⛔ 两侧填充空格、竖线、同排其余格子一个字节不动；
//   ③ `|` 的转义（奇数个反斜杠 ⇒ 已经转义过，⛔ 不再加）；
//   ④ 换行 ↔ `<br>`（GFM 的单元格写不进字面换行 ⇒ 视图里的 `\n` 提交成 `<br>`，
//      再次点进来又还原成 `\n`；`bugs/0035`，2026-10-28 用户需求变更）。
//   ⑤ ⭐ **布局冻结**（`freezeTableLayout`，2026-10-29 代码评审第 15 条从 `main.js` 搬来）：
//      进入前量列宽 → 写死 `table-layout: fixed` → 退出逐像素还原（`INV-CELL-04`）。
//      ⚠️ 它碰 DOM 但不碰 CM6/控制器/IPC ⇒ 与其余几条一样能在 node 里用假节点跑。
//
// ⚠️⚠️ **列坐标是 UTF-16 码元**，由后端算好（`INV-CELL-03`）。前端⛔ **不做**任何
// 字节换算——中文/Emoji 上错一位就切进字符中间，而 `String.prototype.slice` 对此
// 一声不吭。这里的 `from`/`to` 直接喂 `slice`，这正是"后端换、前端用"那条口径的落点。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，顶层 `const` 撞名会让
// **整个文件不执行**（窗口空白、stderr 全静默）。理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  /** `nodeType` 的元素节点（探针与单测会塞假节点进来，判据只认这个数）。 */
  const ELEMENT_NODE = 1;

  /** 这一格是不是可编辑的单元格（`<td>` / `<th>`）。 */
  function isCellNode(node) {
    if (!node || node.nodeType !== ELEMENT_NODE) return false;
    const tag = String(node.tagName || '').toUpperCase();
    return tag === 'TD' || tag === 'TH';
  }

  /**
   * 表格的**行 → 每行格子数**。`table.rows[r].cells` 同时含 `<th>` 与 `<td>`，
   * 这正是 comrak 的 AST 顺序（表头行也在 `TableRow` 里）。
   *
   * @param {object} tableNode
   * @returns {number[]} 每行的格子数（不是表格就返回空数组）
   */
  function rowCounts(tableNode) {
    const rows = tableNode && tableNode.rows;
    if (!rows || typeof rows.length !== 'number') return [];
    const out = [];
    for (let r = 0; r < rows.length; r++) {
      const cells = rows[r] && rows[r].cells;
      out.push(cells && typeof cells.length === 'number' ? cells.length : 0);
    }
    return out;
  }

  /** 整张表的格子总数（= 载荷里那一串区间的长度）。 */
  function countCells(tableNode) {
    const counts = rowCounts(tableNode);
    let n = 0;
    for (let i = 0; i < counts.length; i++) n += counts[i];
    return n;
  }

  /**
   * ⭐ `<td>`/`<th>` → **行主序扁平下标**（`-1` = 不在这一张表里）。
   *
   * ⚠️ 这是"载荷顺序 ↔ DOM 顺序"配对的**唯一**一处换算。comrak 的 AST 是
   * `Table → TableRow → TableCell` 的行主序，`table.rows[r].cells[c]` 是同一个顺序
   * （`design/0049` §1.2 第 3 条：缺列会被自动补空单元格 ⇒ 数量恒等于表头列数）。
   */
  function flatIndexOf(tableNode, cellEl) {
    const rows = tableNode && tableNode.rows;
    if (!rows || !cellEl) return -1;
    let n = 0;
    for (let r = 0; r < rows.length; r++) {
      const cells = rows[r] && rows[r].cells;
      if (!cells) continue;
      for (let c = 0; c < cells.length; c++) {
        if (cells[c] === cellEl) return n;
        n++;
      }
    }
    return -1;
  }

  /** 扁平下标 → 那个单元格节点（没有 ⇒ `null`）。 */
  function cellAtIndex(tableNode, flat) {
    if (!Number.isInteger(flat) || flat < 0) return null;
    const rows = tableNode && tableNode.rows;
    if (!rows) return null;
    let n = 0;
    for (let r = 0; r < rows.length; r++) {
      const cells = rows[r] && rows[r].cells;
      if (!cells) continue;
      for (let c = 0; c < cells.length; c++) {
        if (n === flat) return cells[c];
        n++;
      }
    }
    return null;
  }

  /**
   * `Tab` / `⇧Tab` 的目标：扁平下标加减一，**越界给 `-1`**（调用方据此退出编辑）。
   *
   * ⚠️ 刻意**不跨表、不环绕**：绕回到第一格会让"改完最后一格"变成"又进了第一格"，
   * 用户按 Tab 的本意是"走完这一行/这一张表"（`design/0049` §4 的取舍）。
   */
  function flatAfter(tableNode, flat, delta) {
    if (!Number.isInteger(flat) || !Number.isInteger(delta) || delta === 0) return -1;
    const total = countCells(tableNode);
    const next = flat + (delta > 0 ? 1 : -1);
    return next >= 0 && next < total ? next : -1;
  }

  /**
   * `Enter` 的目标：**同列的下一行**（`design/0049` §5 第 3 条「下移一格」）。
   *
   * @returns {number} 扁平下标；没有下一行 ⇒ `-1`
   */
  function flatBelow(tableNode, flat) {
    if (!Number.isInteger(flat) || flat < 0) return -1;
    const counts = rowCounts(tableNode);
    let start = 0;
    for (let r = 0; r < counts.length; r++) {
      const end = start + counts[r];
      if (flat >= start && flat < end) {
        if (r + 1 >= counts.length) return -1;
        const col = flat - start;
        if (col >= counts[r + 1]) return -1; // 下一行短一格（GFM 里不该出现，但不猜）
        return end + col;
      }
      start = end;
    }
    return -1;
  }

  /**
   * `↑` 的目标：**同列的上一行**（`bugs/0104`，与 {@link flatBelow} 对称）。
   *
   * ⚠️ 到边界给 `-1`，调用方据此**原地不动**（⛔ 不退出编辑态——方向键不是"离开"，
   * 离开是 `Tab` / `Esc` / `⌘↵`）。
   *
   * @returns {number} 扁平下标；没有上一行 ⇒ `-1`
   */
  function flatAbove(tableNode, flat) {
    if (!Number.isInteger(flat) || flat < 0) return -1;
    const counts = rowCounts(tableNode);
    let start = 0;
    for (let r = 0; r < counts.length; r++) {
      const end = start + counts[r];
      if (flat >= start && flat < end) {
        if (r === 0) return -1;
        const col = flat - start;
        if (col >= counts[r - 1]) return -1; // 上一行短一格（GFM 里不该出现，但不猜）
        return start - counts[r - 1] + col;
      }
      start = end;
    }
    return -1;
  }

  /** 几何兜底的容差（px）：一格左右内边距 ＋ 边框的量级。 */
  const EDGE_SLOP = 16;

  /** 元素的视口矩形（拿不到 ⇒ `null`，⛔ 不拿 `0` 冒充）。 */
  function rectOf(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    if (!r || typeof r.left !== 'number' || typeof r.top !== 'number') return null;
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }

  /**
   * ⭐ **几何兜底**：点落在表格的**块盒子**上（不在任何一格里）时，按坐标取最近的一格。
   *
   * ⚠️ 为什么必须有（`bugs/0066`）：`.doc table` 是 `display:block`
   *    （`typography.css` 让 `overflow-x` 生效的代价），块盒子**铺满正文宽度**，
   *    而里面那张匿名表按内容收缩 ⇒ 窄表右边那一大片**来源是 `<table>` 元素本身**。
   *    真 WKWebView 实测（2026-11-03）：3 列短表在 800 px 正文里格子只到 158.8 px，
   *    从 158.8 px（**含边界那一像素**）到 800 px 全部命中 `<table>`。
   *    ⇒ 瞄准"行尾"点下去，`cellFromTarget` 的 DOM 上溯一步都走不动 ⇒ `null`
   *    ⇒ 用户拿到的是"表格请点格子改字"的提示，而不是光标（"经常出不来"）。
   *
   * ⚠️ 判据是**几何上的最近**，⛔ 不是"这个点真的被某一格盖住"——
   *    后者的形态是"边界外一像素永远点不中"，正是本条要修的缺陷。
   * ⚠️ 只在"目标确实是表格本身"时调用（`main.js::onLiveDocDown` 的 `Table` 分支），
   *    ⛔ 不能拿它去抢别的块 / 正文空白的点击。
   *
   * @param {object} tableNode 表格元素（就是块序号对应的那个节点）
   * @param {number} x 视口坐标（`event.clientX`）
   * @param {number} y 视口坐标（`event.clientY`）
   * @param {number} [slop] 水平容差像素（默认 {@link EDGE_SLOP}）
   * @returns {object|null} 最近的一格；离得太远 ⇒ `null`（⛔ 不隔空抢点击）
   */
  function cellAtPoint(tableNode, x, y, slop) {
    if (!tableNode || !tableNode.rows || !tableNode.rows.length) return null;
    if (typeof x !== 'number' || typeof y !== 'number'
      || !isFinite(x) || !isFinite(y)) return null;
    const s = typeof slop === 'number' && isFinite(slop) && slop >= 0 ? slop : EDGE_SLOP;

    // ① 按 y 挑行：先找**真的盖住这个 y** 的那一行；都在外面就取最近一行，
    //    但距离超过**那一行自己的高度** ⇒ 说明点根本不在表上，⛔ 不猜。
    let row = null;
    let bestDist = Infinity;
    let rowH = 0;
    for (let r = 0; r < tableNode.rows.length; r++) {
      const cand = tableNode.rows[r];
      if (!cand || !cand.cells || cand.cells.length === 0) continue;
      const rect = rectOf(cand.cells[0]);
      if (!rect) continue;
      const h = Math.max(0, rect.bottom - rect.top);
      if (y >= rect.top && y <= rect.bottom) { row = cand; bestDist = 0; rowH = h; break; }
      const d = y < rect.top ? rect.top - y : y - rect.bottom;
      if (d < bestDist) { bestDist = d; row = cand; rowH = h; }
    }
    if (!row || bestDist > rowH) return null;

    // ② 按 x 取那一行里的格子：命中谁算谁，越过两端就按容差夹到首/末格。
    let firstR = null;
    let lastR = null;
    const cells = row.cells;
    for (let c = 0; c < cells.length; c++) {
      const rect = rectOf(cells[c]);
      if (!rect) return null;
      if (c === 0) firstR = rect;
      lastR = rect;
      if (x >= rect.left && x <= rect.right) return cells[c];
    }
    if (x < firstR.left) return (firstR.left - x) <= s ? cells[0] : null;
    return (x - lastR.right) <= s ? cells[cells.length - 1] : null;
  }

  /**
   * ⭐ `|` 转义（`INV-CELL-02`）：**已有奇数个反斜杠时不再加**。
   *
   * ⚠️ 判据是"**紧邻的**连续反斜杠个数"——`\\|`（两个反斜杠）在 GFM 里是
   * "转义的反斜杠 + 裸竖线"⇒ 仍然是拆列，必须再补一个；`\|` 才是转义竖线。
   * ⚠️ 只看 `|` 与 `\` 两种字符，⛔ 不碰行内代码里的竖线：那是**用户写的东西**，
   * 这里只保证"写回去之后这一行不会被拆成多一列"。
   */
  function escapePipes(text) {
    const s = String(text === undefined || text === null ? '' : text);
    let out = '';
    let backslashes = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      if (ch === '\\') {
        backslashes++;
        out += ch;
        continue;
      }
      if (ch === '|') {
        if (backslashes % 2 === 0) out += '\\';
        out += '|';
        backslashes = 0;
        continue;
      }
      backslashes = 0;
      out += ch;
    }
    return out;
  }

  /**
   * 末尾**连续**反斜杠的个数。
   *
   * @param {string} s
   * @returns {number}
   */
  function trailingBackslashes(s) {
    let n = 0;
    for (let i = s.length - 1; i >= 0 && s.charAt(i) === '\\'; i--) n++;
    return n;
  }

  /**
   * ⭐ 单元格文本的**编码**：换行写成 `<br>` → 转义 `|`。
   *
   * ⚠️⚠️ **2026-10-28 用户需求变更（`bugs/0035`）**：这里原先折成**空格**
   * （"GFM 的单元格写不进换行"）。用户原话：
   * 「表格编辑还是不能换行，enter 键无法换到下一行，直接到表格的下一行中了」
   * ⇒ 格内回车要**真的换行**。GFM 里唯一的表示就是 `<br>`
   * （后端 [`honor_cell_line_breaks`] 只把**表格单元格内**的 `<br>` 还原成换行节点，
   * `render.unsafe` 仍然关着）。
   * ⚠️ 于是 `encode` 与 [`decode`] 是一对**可逆**变换：视图里是 `\n`，源码里是 `<br>`。
   * ⛔ 别只在 `encode` 那一侧做——那样再次点进这一格会看到字面的 `<br>`。
   *
   * ⚠️ 换行发生在转义**之前**：`\n` → `<br>` 是**结构**变换，而转义只管竖线。
   *
   * ⚠️⚠️ **末尾反斜杠不在这里处理**——它取决于**插入点右边有什么**，见 [`padFor`]。
   *   2026-10-28 评审 P1 的第一版修法是"末尾凑成偶数"，**实测是错的**（见 `padFor` 的注释）。
   *
   * ⭐⭐ **换行前紧邻奇数个反斜杠时⛔ 不能直接拼 `<br>`**（2026-10-29 复评 P2-5）：
   * 视图里 `a\` ＋ 回车 ＋ `b` 直接拼出来是 `a\<br>b`，而 CommonMark 把 `\<` 解释成
   * **转义的尖括号** ⇒ 后端渲染成字面的 `<br>`（真 comrak 实测，见
   * `parser.rs::单元格里的_br_转义语义`）——**用户打的换行会静默变成四个字符**。
   * 修法是把那个反斜杠**凑成偶数**（`a\\<br>b` ⇒ `a\` ＋ 换行 ＋ `b`）。
   * ⚠️ 代价（有意接受）：再点进这一格时视图会显示**两个**反斜杠——视图是**源码**语义，
   * 而源码里要写出"字面反斜杠 ＋ 换行"本来就得写两个。⛔ 别为了好看把 `decode` 改成
   * 会吞反斜杠的版本：那会让用户源码里的 `\\` 在视图里凭空少一半。
   */
  function encode(text) {
    const s = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
    let out = '';
    let i = 0;
    while (i < s.length) {
      if (s.charAt(i) !== '\n') {
        out += s.charAt(i);
        i += 1;
        continue;
      }
      // 数一数这个换行前面**紧邻**的反斜杠：奇数 ⇒ 补一个（`\` 变成 `\\`）
      let k = 0;
      for (let j = out.length - 1; j >= 0 && out.charAt(j) === '\\'; j--) k += 1;
      out += (k % 2 === 1 ? '\\' : '') + '<br>';
      i += 1;
    }
    return escapePipes(out);
  }

  /**
   * ⭐ **解码**：把格子里已有的 `<br>` 还原成视图里的换行（[`encode`] 的逆变换）。
   *
   * ⚠️ **只认 `<br>` 家族的三种常见写法**（与后端 `is_br_literal` 同口径）：
   * `<br>` / `<br/>` / `<br />`，大小写不敏感。
   * ⚠️ 其余裸 HTML 原样留着——后端不会渲染它们（`render.unsafe` 关着），
   * 这里也⛔ 不替它解释成换行。
   *
   * ⚠️⚠️ **代码 span 里的 `<br>` 不解码**（`bugs/0040` 的 (a)）：
   * 后端的换行是 `honor_cell_line_breaks` 按**节点类型**做的——只把
   * `HtmlInline` 换成 `LineBreak`，而 `` `<br>` `` 是 `Code` 节点 ⇒ **阅读态显示字面的 `<br>`**。
   * 前端若照正则一律解码，同一个格子就成了「阅读态显示 `<br>`、编辑态显示换行」，
   * 用户会以为编辑态丢了内容。⇒ 这里按 CommonMark 的代码 span 边界跳过反引号段。
   * ⚠️ 判定必须**成对且等长**（`` ` `` 与 ``` `` ``` 不是一对）——否则 `a\`b<br>c` 会把
   * 后半段也当成代码、连真正的换行都不解码了。
   *
   * ⭐⭐ **转义必须算进来**（2026-10-29 复评 P2-5）——这一条此前只有"代码 span"一半：
   * | 格内源码 | 真 comrak | 旧 decode | 现在 |
   * |---|---|---|---|
   * | `a\<br>b` | `a&lt;br&gt;b`（**字面**） | `a\` ＋ 换行 ＋ `b` ❌ | 原样 ✓ |
   * | `` \`a<br>b` `` | 字面反引号 ＋ **真换行** ＋ 字面反引号 | 当成代码 span，不解码 ❌ | 换行 ✓ |
   *
   * 判据与 CommonMark 一致（⛔ 不是"看着像就跳过"）：
   * ① `\` ＋ **ASCII 标点** 是一对转义 —— 那一对整对都是字面的，⛔ 既不开启代码 span、
   *    也不让 `\<` 被当成裸 HTML 标签；
   * ② 代码 span 的开启反引号**不能是转义过的**（`\\` 是"转义的反斜杠"，它后面的反引号照常）；
   * ③ 一旦进了代码 span，里面的反斜杠**是字面的**（CommonMark 明文）⇒ 收尾照旧只认等长反引号串。
   *
   * ⚠️ 变体表由**真 comrak 夹具**钉住（`parser.rs::单元格里的_br_转义语义` 六条），
   * 对应判据在 `tests/js/live-cell.test.js`——两份用**同一串源码**，⛔ 别只改一边。
   * ⚠️ `decode` 与 `encode` **各自独立地处理反斜杠**（不经对方的口径）：`encode` 只在
   * "换行前是奇数个反斜杠"时补一个、在裸竖线前补一个，`decode` **只吞 `\|` 那一个**
   * （它是 `escapePipes` 的逆变换，见下），其余反斜杠原样留着（视图 = 源码）。
   *
   * @param {string} text
   * @returns {string}
   */
  function decode(text) {
    const s = String(text === undefined || text === null ? '' : text);
    let out = '';
    let i = 0;
    while (i < s.length) {
      const ch = s.charAt(i);
      // ① 转义对：整对字面（`\<br>` 的尖括号、`\`` 的反引号都不再是语法）
      if (ch === '\\' && isEscapable(s.charAt(i + 1))) {
        // ⭐⭐ `\|` 是**唯一的例外**：它是 [`encode`] → `escapePipes` 的产物
        //    （用户在视图里打的字面竖线），⇒ 视图里必须是**一个** `|`，⛔ 不能把反斜杠
        //    一起搬过去。否则「提交之后这一格永远判脏」（`bugs/0047` 的根因）：
        //    发布之后源码里是 `x\|y`、视图里是用户打的 `x|y` ⇒ `decode(源码) !== 视图`
        //    ⇒ `commitTarget` 每轮都"编码之后没有改动"、`stillDirty` 又每轮都"脏"
        //    ⇒ 预算耗尽、`⌘↵`/`Tab`/点别处**全都退不出这一格**，且第二次提交会把字写重。
        //    ⚠️ 其余转义对仍原样保留：`encode` **只补竖线**（`\` ＋ `<` 若被吞掉，
        //    写回时没人再补 ⇒ 字面 `<br>` 会变成真换行）。
        if (s.charAt(i + 1) === '|') {
          out += '|';
          i += 2;
          continue;
        }
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      // ② 代码 span：原样搬过去（里面的 `<br>` 是字面量，见 `bugs/0040` 的 (a)）
      if (ch === '`') {
        let n = 1;
        while (s.charAt(i + n) === '`') n += 1;
        const end = closingFence(s, i + n, n);
        const len = end >= 0 ? end + n - i : n;
        out += s.slice(i, i + len);
        i += len;
        continue;
      }
      // ③ 裸 `<br>` 家族 ⇒ 换行
      const brLen = brAt(s, i);
      if (brLen > 0) {
        out += '\n';
        i += brLen;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  /**
   * CommonMark 的**可转义字符**：ASCII 标点（`\` 只有加在它们前面才是转义）。
   * ⚠️ 只有标点算——`\a` 的 `\` 是字面反斜杠，它后面的 `<br>` 照常解码。
   */
  const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

  /**
   * @param {string} ch
   * @returns {boolean}
   */
  function isEscapable(ch) {
    return ch.length === 1 && ESCAPABLE.indexOf(ch) >= 0;
  }

  /**
   * 从 `i` 起是不是一个 `<br>` 家族的标签；是 ⇒ 返回它的长度，不是 ⇒ `0`。
   *
   * ⚠️ 与后端 `parser.rs::is_br_literal` **同口径**：`<br>` / `<br/>` / `<br />`
   * （标签内允许空白与一个 `/`），大小写不敏感。⛔ 别放宽到 `<br class=x>`：
   * 后端不认它 ⇒ 阅读态显示字面，编辑态却会显示换行。
   *
   * @param {string} s
   * @param {number} i
   * @returns {number}
   */
  function brAt(s, i) {
    if (s.charAt(i) !== '<') return 0;
    let k = i + 1;
    const b = s.charAt(k);
    const r = s.charAt(k + 1);
    if ((b !== 'b' && b !== 'B') || (r !== 'r' && r !== 'R')) return 0;
    k += 2;
    // ⚠️ 与后端 `is_br_literal` 同口径：`<` 后面**紧贴** `br`（⛔ 不认 `< br>`），
    //    之后允许空白与一个 `/`，再要求 `>`。⛔ 别改用固定长度的 `slice` 去喂正则：
    //    `<br` ＋ 一长串空格 ＋ `>` 是**合法**的（后端 trim 之后照样认）。
    while (s.charAt(k) === ' ' || s.charAt(k) === '\t') k += 1;
    if (s.charAt(k) === '/') k += 1;
    if (s.charAt(k) !== '>') return 0;
    return k + 1 - i;
  }

  /**
   * 从 `from` 起找**恰好 `n` 个**反引号组成的收尾；找不到给 `-1`。
   * @param {string} s
   * @param {number} from
   * @param {number} n
   * @returns {number}
   */
  function closingFence(s, from, n) {
    let i = from;
    for (;;) {
      const k = s.indexOf('`', i);
      if (k < 0) return -1;
      let m = 0;
      while (s.charAt(k + m) === '`') m += 1;
      if (m === n) return k;
      i = k + m;
    }
  }

  /**
   * ⭐⭐ **编辑对象的表示绑定**（`design/0058` §2.1 规则 0）。
   *
   * `raw`（原始源码切片）与 `initialView`（进入时的编辑文本）**同一时刻**产出，
   * 并一起绑到 `{objectId, revision}` 上：修订一变，这份基线就已经不是"这一次编辑"的了。
   *
   * @param {{raw?:string|null, from?:number, to?:number,
   *          objectId?:string|null, revision?:object|null}} [o]
   * @returns {{raw:string|null, initialView:string, from:number, to:number,
   *   objectId:string|null, revision:object|null}}
   */
  function bind(o) {
    const s = o || {};
    const raw = s.raw === null || s.raw === undefined ? null : String(s.raw);
    return {
      raw: raw,
      initialView: raw === null ? '' : decode(raw),
      from: typeof s.from === 'number' ? s.from : 0,
      to: typeof s.to === 'number' ? s.to : 0,
      objectId: s.objectId === undefined || s.objectId === null ? null : s.objectId,
      revision: s.revision || null,
    };
  }

  /**
   * ⭐⭐⭐ **候选判定的唯一入口**：三值之一，脏状态、提交、退出**共用同一个结果**
   * （`design/0058` §2.1 规则 3；`INV-MUT-02`）。
   *
   * 判定**顺序**是承重的（评审 P1-1）：
   * ① 区间不可信 ⇒ `rejected`（⛔ 不许读成"没改动"）；
   * ② **先比编辑文本**：`currentView === initialView` ⇒ `unchanged`。
   *    ⚠️ 这一步**不能**换成"候选字节 == 原始源码"：用户在源码为 `a\|b` 时打了字面的
   *    `a\|b`，编码后恰好等于原源码 ⇒ 按字节判会把**真实输入当成无操作吞掉**。
   * ③ 编辑文本变了 ⇒ 编码，并验**往返**：`decode(编码结果) === currentView` 才 `valid`，
   *    否则 `rejected`（保留输入、报错、⛔ 不清脏；`INV-MUT-03`）。
   *    ⭐ `INV-MUT-01b`：变了但编码后与原源码同形 ⇒ 照常 `valid`（那是"真的写入了同样内容"）。
   *
   * @param {{raw:string|null, initialView:string, from:number, to:number}} binding [`bind`] 的产物
   * @param {string} line 这一格**当前**的源码行
   * @param {string} currentView 视图里此刻的文本（多行已用 `\n` 拼好）
   * @returns {{status:'unchanged'|'valid'|'rejected', why?:string,
   *   encoded?:string, replacement?:string, nextLine?:string}}
   */
  function judge(binding, line, currentView) {
    const b = binding || /** @type {any} */ ({});
    const view = String(currentView === undefined || currentView === null ? '' : currentView);
    if (b.raw === null || b.raw === undefined) return { status: 'rejected', why: 'range' };
    // ① 区间不可信 ⇒ `rejected`（⛔ 不许读成"没改动"）。
    //    ⚠️ 这一条必须在"没动过"**之前**：坐标坏了照样可能 `view === initialView`，
    //    先返回 `unchanged` 就是拿一个坏绑定去说"这次没改"，调用方据此零字节写回、
    //    却把"区间对不上"这件事永远藏起来（`design/0058` §2.1 规则 3 的顺序）。
    if (!Number.isInteger(b.from) || !Number.isInteger(b.to)
      || b.from < 0 || b.to < b.from || b.to > String(line).length) {
      return { status: 'rejected', why: 'range' };
    }
    // ② 没动过 ⇒ 原样保留（⛔ 不写、⛔ 不压栈）
    if (view === b.initialView) return { status: 'unchanged' };
    let encoded;
    let replacement;
    let nextLine;
    try {
      encoded = encode(view);
      replacement = padFor(line, b.to, encoded);
      nextLine = splice(line, b.from, b.to, replacement);
    } catch (e) {
      // ⚠️ `splice`/`padFor` 抛错 = 区间与这一行对不上（陈旧坐标 / 载荷坏了）：
      //    这是**没写进去**的失败，⛔ 不是"没改动"。
      return { status: 'rejected', why: e && e.message ? e.message : String(e) };
    }
    if (decode(encoded) !== view) return { status: 'rejected', why: 'inexpressible' };
    return { status: 'valid', encoded: encoded, replacement: replacement, nextLine: nextLine };
  }

  /**
   * ⭐⭐ **无改动判据**：这一格在视图里**一个字都没动**吗？（`bugs/0040` 的 (b)）
   *
   * ⚠️ 判据必须是「视图文本 == `initialView`（= `decode(源码)`）」，⛔ **不是**
   * 「`encode(视图)` == 源码」。`decode` 会把 `<br />` / `<BR>` / `<br/>` 归一成 `\n`，
   * `encode` 再一律写回 `<br>` ⇒ 两个串**永远不相等**，于是"点进去、什么都不改、
   * 再点出来"会把用户的源码**静默改写成另一种写法**（`<br />` → `<br>`，
   * 屏幕上一点变化都没有）。
   *
   * ⚠️ `design/0058` 之后它只是 [`judge`] 的一个谓词视图——判据仍只有一处。
   *
   * @param {string} line 这一格的源码行
   * @param {number} from 行内 UTF-16 右开区间起点
   * @param {number} to 行内 UTF-16 右开区间终点
   * @param {string} viewText 视图里此刻的文本（多行已用 `\n` 拼好）
   * @returns {boolean}
   */
  function isUnchanged(line, from, to, viewText) {
    const raw = textOf(line, from, to);
    return judge(bind({ raw: raw, from: from, to: to }), line, viewText).status === 'unchanged';
  }

  /**
   * ⭐⭐ **右侧补位**：内容以反斜杠结尾、而插入点右边正好是分隔竖线 `|` 时，
   * 补**一个空格**再写回去（`INV-CELL-02` 的第二半，2026-10-28 评审 P1）。
   *
   * # 为什么必须有这一步
   *
   * comrak 切格用的是 `scanners::table_cell = (escaped_char|[^|\r\n])+`
   * （`comrak-0.56.0/src/scanners.re:405`，`escaped_char = [\\][标点]`），
   * 而 re2c 取**最长匹配** ⇒ `z\\|y` 里那个 `|` 会被当作 `\|` 转义序列吃掉：
   * 第一个 `\` 走单字符分支，第二个 `\` ＋ `|` 走 `escaped_char` 分支，匹配更长。
   * 于是**任意个**反斜杠紧贴 `|` 都会把右侧分隔符吃掉（实测，真 comrak 0.56.0）：
   *
   * | 写回去的源码 | 解析结果 |
   * |---|---|
   * | `|z\|y|` | `<td>z\|y</td><td></td>`（⚠️ 注意：输出里的 `z\|y` 是**未去转义**的原文，即一格） |
   * | `|z\\|y|` | `<td>z\\|y</td><td></td>` ← ⛔ **翻倍没用，照样合并** |
   * | `|z\\\\|y|` | 同上，照样合并 |
   * | `|z\ |y|` | `<td>z\</td><td>y</td>` ✅ **只有插一个空格才断得开** |
   *
   * ⚠️⚠️ **"末尾凑成偶数"（评审报告里的建议）在这里是无效的**：它只对**中间**的
   * `\|` 成立（`escapePipes` 那个奇偶判据说的是"这个 `|` 有没有被转义"），
   * 末尾的反斜杠根本没有"偶数就安全"这回事——目标不是转义奇偶，而是
   * **别让插入点右边那个字节是反斜杠**。所以修法是**空格**，不是反斜杠。
   *
   * ⚠️ 只在 `line.charAt(to) === '|'` 时补：右边本来就是空格 ⇒ 已经断得开，再补就是
   * 每编辑一次多一个空格（跨会话累积）；右边是行尾 ⇒ 没有竖线可吃（`|x|z\` 实测正常）。
   *
   * @param {string} line 这一行**当前**的源码
   * @param {number} to 这一格内容区间的右端（UTF-16 列）
   * @param {string} encoded [`encode`] 的产物
   * @returns {string} 真正要 `splice` 进去的片段
   */
  function padFor(line, to, encoded) {
    const s = String(encoded === undefined || encoded === null ? '' : encoded);
    if (trailingBackslashes(s) === 0) return s;
    if (typeof line !== 'string' || !Number.isInteger(to)) return s;
    return line.charAt(to) === '|' ? s + ' ' : s;
  }

  /**
   * ⭐ **写回**：把 `line` 的 `[from, to)` 换成 `text`，其余**逐字节不变**（`INV-CELL-01`）。
   *
   * ⚠️ 越界**抛错、⛔ 不夹取**（与 `blocks.js::toRange` 同口径）：夹取会把
   * "用陈旧的列区间提交"这个错误**静默**变成"改到了附近"，而屏幕上看起来是对的。
   * ⚠️ 区间非法同样抛——`from > to` 是"自动补出来的空列"那一族的形态，
   * 后端已经把它们标成不可写（`INV-CELL-05`），能走到这里就是载荷坏了。
   */
  function splice(line, from, to, text) {
    if (typeof line !== 'string') throw new Error('单元格写回：行不是字符串');
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error('单元格写回：列坐标必须是整数');
    if (from < 0 || to < from || to > line.length) {
      throw new Error(`单元格写回：列区间越界 ${from}-${to}（行长 ${line.length}）`);
    }
    return line.slice(0, from) + String(text) + line.slice(to);
  }

  /**
   * 取一格当前的源码文本（`session` 那一行再切列区间）。
   * @returns {string|null} 区间不可信 ⇒ `null`（调用方据此如实告知，⛔ 不猜）
   */
  function textOf(line, from, to) {
    if (typeof line !== 'string') return null;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
    if (from < 0 || to < from || to > line.length) return null;
    return line.slice(from, to);
  }

  /**
   * ⭐ **表格布局冻结**（`INV-CELL-04`）：进入编辑前把列宽写死，退出**逐像素**还原。
   *
   * ⚠️ 为什么必须冻结：格子里敲一个字就会让"按内容分配列宽"的表格**整张重排**——
   * 用户看到的正是"编辑期间表格在跳"，而块级那套几何判据量的是 `<td>` 的高度，**看不见**它。
   * ⚠️ 还原用**原始 `style` 属性**逐字写回（⛔ 不逐个属性置空）：表格可能本来就有内联宽度，
   * 置空等于把作者写的样式一起删掉。
   *
   * ⭐ **2026-10-29 代码评审第 15 条把它从 `main.js` 搬到这里**：这一段是"**量 → 写 → 还**"
   * 的纯几何判据（先量还是先切 `fixed`、`border-box` 有没有写、还原用属性还是属性名），
   * 而 `main.js` 既不进 `tests/js/`、也不在 `make typecheck` 的范围里 ⇒ 住在那一层时
   * **任何断言都碰不到**。三个坑（顺序 / `border-box` / 还原口径）都是**静默**的：
   * 屏幕上看只是"表格跳了一下"，没有任何报错。搬过来之后 `live-cell.test.js` 用假节点就能验。
   * ⚠️ 留在 `main.js` 的只有**接线**（什么时候调、谁是那一格）。
   *
   * ⭐⭐ **2026-11-09 第二版：光切 `table-layout: fixed` 根本管不住列宽**（`bugs/0297`）。
   *
   * `.doc table` 是 `display: block; overflow-x: auto`（宽表要能横滚）—— 这个元素的
   * **块盒子**才是那个 `fixed` 与 `width` 的作用对象，而真正排版的是一张**匿名内表**，
   * `table-layout` 是**非继承**属性 ⇒ 匿名内表仍是 `auto` ⇒ 换入 CM6 宿主（`inline-block`、
   * 窄）之后，**那一列按"内容宽度"重算**：非最大化窗口里实测整表高 +21 / −12 / +63 px，
   * 列宽 −6 / −80 / −18 px，表格下面的所有块跟着位移。
   * ⇒ 编辑期间**必须让表格真的是一张表**（`display: table`），而 `display: table` 下
   * `overflow-x` 不再是滚动容器 ⇒ 用一层**临时外壳**接住原来的滚动职责与外边距，
   * 退出时把表格挪回去、摘掉外壳、逐字写回原 `style`。
   * ⚠️ 外壳的横向 overflow 按**进入前的状态**选：原本就在横滚 ⇒ `auto`（滚动条位置照旧，
   * 高度与原来逐像素相等）；原本不横滚 ⇒ `clip`（列宽和与容器只差**亚像素**，
   * 用 `auto` 会凭空多出一条 12 px 的经典滚动条 —— 实测 `PROBE_W=1200` 整表 +12 px）。
   *
   * @param {any} cellEl 那一格（产品传 `<td>`/`<th>`）
   * @returns {Function|null} 还原函数（`null` = 没做成；§6：仍可编辑，只是会跳）
   */
  function freezeTableLayout(cellEl) {
    const table = cellEl && typeof cellEl.closest === 'function' ? cellEl.closest('table') : null;
    if (!table || !table.rows) return null;
    const targets = [table];
    for (let r = 0; r < table.rows.length; r++) {
      const cells = table.rows[r].cells;
      for (let c = 0; c < cells.length; c++) targets.push(cells[c]);
    }
    const saved = [];
    for (let i = 0; i < targets.length; i++) {
      saved.push({ el: targets[i], style: targets[i].getAttribute('style') });
    }
    // ⚠️ 顺序：**先量、再写宽、最后切 `table-layout: fixed`**。切早了会先按 auto 重排一次。
    const first = table.rows.length > 0 ? table.rows[0] : null;
    const widths = [];
    if (first) {
      for (let c = 0; c < first.cells.length; c++) {
        widths.push(first.cells[c].getBoundingClientRect().width);
      }
    }
    const total = table.getBoundingClientRect().width;
    // ⚠️⚠️ 进入前它是不是**横向滚动容器**：两条路都要判——`scrollWidth` 是整数取整，
    //    亚像素溢出量不出来；经典滚动条 12 px 会实打实吃掉 `offsetHeight - clientHeight`。
    const 原横滚 = table.scrollWidth > table.clientWidth + 0.5
      || table.offsetHeight - table.clientHeight >= 4;
    let 列和 = 0;
    for (let i = 0; i < widths.length; i++) if (widths[i] > 0) 列和 += widths[i];
    // ⚠️⚠️ **必须 `border-box`**：`getBoundingClientRect().width` 量的是**边框盒**，
    //    而 `width` 默认按**内容盒**解释 ⇒ 直接写回去会让每一列涨 `padding + border`
    //    （探针实测 3 列各 **+15 px**：左右内边距 14 ＋ 边框 1；Q2 就是这么红的）。
    //    ⚠️ 表格自己同理：`width` 与量到的边框宽对不上时，固定布局会把整张表撑宽。
    // ⭐ 表格宽度用**列宽和**而不是块盒宽：`display:block` 的块盒铺满正文栏（短表也一样），
    //    拿它当表宽会把短表拉成满宽；列宽和才是匿名内表真正的宽度。
    const 表宽 = 列和 > 0 ? 列和 : total;
    // ⭐ 临时外壳：接住 `.doc table` 原本由 **表格自己**承担的两件事——
    //    横向滚动（`overflow-x`）与它的下外边距（挪出去，否则外壳会凭空高 15 px）。
    const 父 = table.parentNode;
    let 壳 = null;
    const 边距 = typeof getComputedStyle === 'function' ? getComputedStyle(table).marginBottom : '';
    if (父 && total > 0 && typeof document !== 'undefined' && document.createElement) {
      壳 = document.createElement('div');
      壳.className = 'rmd-table-freeze';
      壳.setAttribute('style', 'display:block;width:' + total + 'px;'
        + 'overflow-x:' + (原横滚 ? 'auto' : 'clip') + ';'
        + 'overflow-y:' + (原横滚 ? 'auto' : 'visible') + ';'
        + 'margin-bottom:' + 边距 + ';');
      const 左移 = table.scrollLeft || 0;
      父.insertBefore(壳, table);
      壳.appendChild(table);
      try { 壳.scrollLeft = 左移; } catch (e) { /* 量不到滚动位置不影响冻结本身 */ }
    }
    if (表宽 > 0) {
      table.style.boxSizing = 'border-box';
      table.style.width = 表宽 + 'px';
    }
    if (壳) {
      // ⚠️ 只有 `display: table` 才能让 `table-layout: fixed` 落到**真正排版的那张表**上；
      //    没有外壳时保持原样（`display:block` ⇒ 冻结照旧不生效，但不新增失败路径）。
      table.style.display = 'table';
      table.style.marginBottom = '0';
    }
    table.style.tableLayout = 'fixed';
    for (let r = 0; r < table.rows.length; r++) {
      const cells = table.rows[r].cells;
      for (let c = 0; c < cells.length && c < widths.length; c++) {
        if (widths[c] > 0) {
          cells[c].style.boxSizing = 'border-box';
          cells[c].style.width = widths[c] + 'px';
        }
      }
    }
    return function () {
      // ⭐ 编辑期间用户可能横向滚过：把滚动位置还给还原后的表格（它自己也是滚动容器）。
      const 留 = 壳 ? (壳.scrollLeft || 0) : (table.scrollLeft || 0);
      if (壳) {
        if (table.parentNode === 壳) {
          if (壳.parentNode) 壳.parentNode.insertBefore(table, 壳);
          else 壳.removeChild(table);
        }
        if (壳.parentNode) 壳.parentNode.removeChild(壳);
      }
      for (let i = 0; i < saved.length; i++) {
        if (saved[i].style === null) saved[i].el.removeAttribute('style');
        else saved[i].el.setAttribute('style', saved[i].style);
      }
      try { table.scrollLeft = 留; } catch (e) { /* 同上 */ }
    };
  }

  const api = {
    isCellNode: isCellNode,
    rowCounts: rowCounts,
    countCells: countCells,
    flatIndexOf: flatIndexOf,
    cellAtIndex: cellAtIndex,
    flatAfter: flatAfter,
    flatBelow: flatBelow,
    flatAbove: flatAbove,
    // ⭐ `main.js::crossCellVertical` 的几何落点要它（`bugs/0104`）：方向键跨格时目标格
    // 还没建视图，只能按**元素矩形**算"同一视觉列"。⚠️ 2026-11-06 之前它只是模块内部函数，
    // 未导出 ⇒ 调用点 `LCell.rectOf(...)` 是 `undefined` ⇒ 跨格在 `after` 里抛
    // `TypeError` ⇒ 全局 `unhandledrejection` 报成「启动失败：Script error.」，
    // 用户看到的是"按 ↓ 什么都不发生"（正是他复报的那个形态）。
    rectOf: rectOf,
    cellAtPoint: cellAtPoint,
    freezeTableLayout: freezeTableLayout,
    escapePipes: escapePipes,
    trailingBackslashes: trailingBackslashes,
    encode: encode,
    decode: decode,
    bind: bind,
    judge: judge,
    isUnchanged: isUnchanged,
    padFor: padFor,
    splice: splice,
    textOf: textOf,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveCell = api;
})();
