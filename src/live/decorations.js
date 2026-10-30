// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// 装饰层：把 Markdown 标记变成**不可见**（Live Preview 的那半）—— `design/0047` §2.9。
//
// # 范围（⛔ 别扩大）
//
// 只做两件事：① 标记不可见；② **光标/选区所在的那几行原样显示源码**。
// ⛔ 不换字体、⛔ 不改字号、⛔ 不动间距 —— 竖直节奏的唯一来源是样式表（`INV-LIVE-07`），
// 一旦从这里发出 `padding`/`margin`，就会变成"文档里没有代码块时，编辑代码块用错样式"那一类
// （`notes/0037` §8.5(d)-2 实测过的缺陷）。
//
// # 为什么判据是**语法树**（`design/0052` U3，2026-10-27 起）
//
// 旧实现是一份**逐行正则 ＋ 围栏状态机**：先认围栏（进/出），再认行首标记，再按"代码段优先"
// 的顺序扫行内。它当年这么写的唯一原因是 `syntaxTree()` 当时不在导出白名单里（那张表加一项
// 就要改设计）——⛔ **不是因为它更好**。代价写在明处，而且**三条都真的发生过**：
//   · 跨行的强调（`**a\nb**`）认不出 ⇒ 标记留在屏幕上；
//   · 行首语义是自己手抄 comrak 的（`bugs/0015` / `0016`：`##` 空 ATX、引用里的标题）；
//   · 行内只有"藏不藏"两个态，做不出 U4 要的"贴类"。
// ⇒ `design/0052` 把 `syntaxTree` 放进 A 栏（文档语义面）之后，这里**只认树**。
// ⚠️ 两个解析器的方言差异**依然存在**（Lezer ↔ comrak）⇒ 配 U9 的差分闸门；
//    ⛔ 别把"树里没有这个节点"当成"comrak 也不会渲染"。
//
// ⚠️ **没有 `tree` 就什么都不藏**（`markers()` 的可选入参）。这是**有意的降级**：
//    屏幕上看得见 `#` / `**`（用户能读、能改），⛔ 不是错位，也⛔ 不会抛错白屏。
//    产品那条路的树由 `createField` 从 `state` 现取（`design/0052` U3 的接线点）。
//
// # 三条硬规则（每条都对应一个屏幕上的坏形态）
//
// 1. ⭐ **围栏里面一个字都不许动**：代码块里 `# ** _` 全是内容。
// 2. ⭐ **光标所在行显示源码**：不然用户改标题时看不到那个 `#`，"空格删不掉"会变成玄学。
// 3. ⭐ **只隐藏、不删除**：`Decoration.replace({})` 是零宽替换，文档一个字符都不变
//    ⇒ 提交上去的仍是真源码（`INV-LIVE-13`）。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，顶层 `const` 撞名会让
// **整个文件不执行**（窗口空白、stderr 全静默）。理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  /**
   * 行首：`#{1,6}` ＋ 一个空格（标题）。
   * ⚠️ **只给 `layoutSlack()` 用**（几何允许量），⛔ 不再参与"藏不藏标记"——
   *    那半已经归语法树（`design/0052` U3）。它的语义是"**数一行差多少**"，不是"认品种"，
   *    所以留着这份行首判据是**对的**：`markers()` 要的是节点身份，`layoutSlack()` 要的是行数。
   * ⚠️ 行尾也算（`|$`）：`##` 这种空 ATX 在渲染态是 h2（`bugs/0016`）。
   */
  const HEADING = /^(#{1,6})(?:[ \t]+|$)/;
  /** 行首：`>`（引用）。⚠️ 同 `HEADING`：**只给 `layoutSlack()` 用**。 */
  const QUOTE = /^(>[ \t]?)+/;

  /** 这一行是不是围栏（``` 或 ~~~），返回围栏字符，否则 `null`。 */
  function fenceOf(line) {
    const t = String(line).trim();
    if (t.slice(0, 3) === '```') return '`';
    if (t.slice(0, 3) === '~~~') return '~';
    return null;
  }

  /** 标题节点名 → 级别（`ATXHeading3` / `SetextHeading2`）。 */
  const HEADING_NODE = /^(?:ATX|Setext)Heading([1-6])$/;

  /**
   * ⭐ **该藏的标记节点**（`design/0052` U3）。
   *
   * ⚠️ 这是一张**白名单**：树里出现别的节点一律不动。理由不是省事——每多藏一个节点，
   *    就多一种"两个解析器对方言理解不同 ⇒ 标记永远不消失/永远消失"的形态（U9 的差分表就是量它）。
   * ⛔ **故意不在表里**（藏了反而错）：
   *    · `SuperscriptMark` / `SubscriptMark` / `Emoji`：comrak **不支持**这三种扩展
   *      （`document/parser.rs` 只开 table/strikethrough/tasklist/autolink/footnotes）⇒
   *      它们在渲染态是**原样文字**，编辑态也应当原样可见；
   *    · `ListMark` / `TaskMarker` / `TableDelimiter`：渲染态有它们的位置（圆点/方框/竖线），
   *      ⛔ 藏掉会让编辑态比渲染态**矮**（`INV-LIVE-07` 的另一面：宁可多，不可少）。
   */
  const HIDDEN_MARK = {
    HeaderMark: 1,
    QuoteMark: 1,
    EmphasisMark: 1,
    StrikethroughMark: 1,
    LinkMark: 1,
    CodeMark: 1,
  };

  /**
   * ⭐ **行内呈现**该贴哪个类（`design/0052` U4，2026-10-27 起）。
   *
   * ⚠️ 这一张表与 `live.css` 的五条规则**逐字对应**，⛔ 别在别处再起一套名字。
   * ⚠️ **不是白名单的镜像**：`HIDDEN_MARK` 决定"藏不藏标记"，这张表决定"内容长什么样"，
   *    两者互不影响——`InlineCode` 既藏反引号、也要等宽，两个表里各一条。
   * ⛔ **故意不在表里**：
   *    · `Image`：渲染态显示的是**图片本身**，源码的 `![alt](src)` 是纯文本，
   *      给它上链接色会让人以为 alt 文字在渲染态也可见；
   *    · 链接里的 `URL` / `LinkTitle`：渲染态根本没有它们（藏掉之后也自然没有），
   *      而 `Link` 的整段已经带色 ⇒ 不必再逐个贴。
   * ⚠️ 链接贴的是**整个 `Link` 节点**（含 `](url)`）：隐藏行上那部分已被零宽替换取代、
   *    看不见；活动行上 `](url)` 也会跟着变色——那是**有意**的（源码态要能一眼认出这是链接）。
   */
  const INLINE_MARK = {
    StrongEmphasis: 'cm-rmd-strong',
    Emphasis: 'cm-rmd-em',
    Strikethrough: 'cm-rmd-strike',
    InlineCode: 'cm-rmd-code',
    Link: 'cm-rmd-link',
  };

  /**
   * 这个节点该不该藏。
   * @param {object} node `tree.iterate` 的 `SyntaxNodeRef`（只在回调里有效）
   */  function shouldHide(node) {
    const name = node.name;
    const parent = node.node && node.node.parent;
    const parentName = parent ? parent.name : '';
    // ⭐ 围栏的语言标记**藏**（`design/0052` U5，2026-10-27 起；`design/0047` §4.4 的
    //    「围栏不藏」已被取代）：用户原话「```json 还是会显示」。渲染态那一行**根本不存在**
    //    ⇒ 编辑态留着它就是凭空多一行。⚠️ 零宽替换⛔ 不删字符（`INV-LIVE-13`）；
    //    语言标记仍可改——活动的意思是"标记不藏"（规则 2 已覆盖，那一行会原样显示）。
    // ⚠️ 只判 `CodeInfo`：`CodeMark` 由下面的白名单**一律藏**（围栏符与行内代码反引号
    //    在树里是**同一个节点名**，靠父节点区分）⇒ ⛔ 别在这里再给 `CodeMark` 加父节点条件，
    //    那会把行内代码的反引号一起放出来（2026-10-27 实测：这条写错时
    //    `用 \`code\` 表示` 的两个反引号留在屏幕上）。
    if (name === 'CodeInfo') return parentName === 'FencedCode' || parentName === 'CodeBlock';
    // 链接/图片的 `](url "title")` 整段藏掉，留下文字。
    //    ⚠️ `Autolink`（`<http://x>`）**只藏尖括号**：渲染态的文字就是那个 URL 本身，
    //    把 `URL` 一起藏掉会让整条链接**凭空消失**。
    if (name === 'URL' || name === 'LinkTitle') return parentName === 'Link' || parentName === 'Image';
    return HIDDEN_MARK[name] === 1;
  }

  /**
   * ⭐ **纯逻辑判据**：算出该隐藏的区间。
   *
   * @param {string} text 这一块的源码（`fullText` 的行区间切片，恒 LF）
   * @param {{activeLines?:number[], bodyLines?:boolean, cellContext?:boolean, tree?:object}} [opts]
   *   `activeLines`：**原样显示**的行下标（0-based，相对 `text`）——调用方给"光标/选区碰到的那几行"。
   *   `bodyLines`：**块基线是标题尺度**（被换掉的那个元素是 `h1`–`h6`）⇒ 那些不是标题的行要
   *   **显式回落**到正文尺度（`bugs/0015`；理由见 `live.css` 的「行级排版」那一节）。
   *   `cellContext`：这段文本是**表格单元格**里切出来的（`design/0049`）⇒ GFM 的格内只有
   *   **行内语义**：⛔ 不认标题/引用/列表/围栏，⛔ 不藏 `HeaderMark`/`QuoteMark`，
   *   只保留强调 / 删除线 / 链接 / 行内代码。⚠️ 判的是**节点在树里的位置**，⛔ 不是内容里有没有 `#`。
   *   `tree`：这一份源码的 Lezer 语法树（`CM6.syntaxTree(state)` / `ensureSyntaxTree(state,…)`）。
   *   ⚠️ **缺省 = 一个标记都不藏**（可见降级，见文件头）。
   * @returns {{ranges:Array<{from:number,to:number}>, fenced:boolean,
   *   headings:Array<{line:number,level:number,from:number}>, bodies:Array<{line:number,from:number}>,
   *   inline:Array<{from:number,to:number,cls:string}>,
   *   fenceLines:Array<{line:number,from:number,to:number}>}}
   *   `ranges` 是**绝对偏移**（0-based，与 `text` 同一坐标）、**有序、互不重叠、不跨行**
   *   ⇒ 能直接喂 `Decoration.replace`；
   *   `headings` / `bodies` 除了行下标还带上**行首偏移 `from`** ⇒ 喂 `Decoration.line`
   *   不用再从 `state.doc` 二次求值（纯逻辑那半因此不需要造一个假 `Text`）；
   *   `inline` 是**行内呈现**（`design/0052` U4）：喂 `Decoration.mark`，⛔ 不改文档、
   *   ⚠️ **允许跨行与嵌套**（`**a\nb**`、`***x***` 都是合法形态），也**不受活动行影响**
   *   ——活动的意思是"标记不藏"，⛔ 不是"样式作废"；
   *   `fenceLines` 是**非活动**围栏行的行首偏移（`design/0052` U5）：喂 `Decoration.line`
   *   的 `cm-rmd-fence`（整行塌成 0 高）。⚠️ 活动行**不在里面**——那一行要能看见、能改语言标记。
   */
  function markers(text, opts) {
    const src = String(text === undefined || text === null ? '' : text);
    const o = opts || {};
    const active = {};
    (o.activeLines || []).forEach(function (n) {
      active[n] = true;
    });
    const wantBody = o.bodyLines === true;
    // ⭐⭐ **单元格上下文**（`design/0049` ＋ 2026-10-28 评审 P2）：GFM 的格子内**只有行内语义**。
    //    但格子是从全文里切出来**单独**解析的 ⇒ `# 普通格子` 在树里是 `ATXHeading1`
    //    ⇒ 装饰层照块级规则给它贴 `cm-rmd-h1`，字号/行高当场变掉（阅读态 `<td>` 里它就是普通文字）。
    //    ⇒ 置上这个开关后：**⛔ 不认块级标题、⛔ 不认围栏与代码块、⛔ 不藏标题/引用标记**，
    //    只保留行内的强调 / 删除线 / 链接 / 行内代码。
    //    ⚠️ 判据是"**节点自己在树里的位置**"，⛔ 不是"内容里有没有 `#`"——
    //       后者正是评审点名的"只针对井号加特殊判断"。
    const 格内 = o.cellContext === true;
    /** 这个节点最外层那个**块**的节点名（`Document` 的直接孩子；拿不到 ⇒ 空串）。 */
    function 顶层块(node) {
      let p = node;
      while (p && p.parent && p.parent.name !== 'Document') p = p.parent;
      return p && p.parent ? p.name : '';
    }
    /** 格子里压根不该按块解释的容器（代码块 / HTML 块里一个字都不许动）。 */
    const 块级容器 = { FencedCode: 1, CodeBlock: 1, HTMLBlock: 1 };
    const tree = o.tree || null;

    // 行起点表（二分查行号）。⚠️ 用它而不用 `split('\n')`：树给的是**绝对偏移**，
    //    两边必须落在同一套坐标上，⛔ 别一次 split、一次累加，那正是 off-by-one 的来源。
    const lineStarts = [0];
    for (let i = 0; i < src.length; i++) {
      if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
    }
    function lineOf(pos) {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= pos) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    }

    const raw = [];
    const headingLines = {};
    const headings = [];
    const inline = [];
    const fenceLines = [];
    const fenceSeen = {};
    let fenced = false;

    if (tree) {
      tree.iterate({
        enter: function (node) {
          const name = node.name;
          // ⭐ 格子里（`cellContext`）：代码块 / HTML 块里一个字节都不动，标题与引用标记
          //    ⛔ 不藏（在阅读态它们就是**普通文字**）。⚠️ 这两条必须先判——下面那些分支
          //    一旦走到就会按块级语义处理。
          if (格内) {
            if (块级容器[顶层块(node.node)]) return;
            if (name === 'HeaderMark' || name === 'QuoteMark') return;
          }
          // ⭐ 行内呈现（U4）先记：它**不看**活动行，也不看围栏——围栏里压根没有这些节点
          //    （那一整段在树里是 `CodeText`）。
          const cls = INLINE_MARK[name];
          if (cls && node.to > node.from) inline.push({ from: node.from, to: node.to, cls: cls });
          // ⭐ 围栏行（U5）：**非活动**的围栏行整行塌掉（`live.css` 的 `cm-rmd-fence`）。
          //    ⚠️ 只在 `CodeMark` 上记一次：`CodeInfo`（语言标记）与它在同一行。
          if (name === 'CodeMark') {
            const 父 = node.node && node.node.parent;
            if (父 && 父.name === 'FencedCode') {
              const n = lineOf(node.from);
              if (!active[n] && !fenceSeen[n]) {
                fenceSeen[n] = true;
                fenceLines.push({ line: n, from: lineStarts[n] });
              }
            }
          }
          const h = HEADING_NODE.exec(name);
          if (h) {
            // ⭐ 格子里**没有块级标题**（`# 普通格子` 在 `<td>` 里就是这七个字）⇒ 不认。
            if (格内) return;
            // ⭐ 一级标题/Setext 可以**跨多行**（`a\nb\n===` 整个是一个 h1）⇒ 逐行都标标题尺度。
            //    ⚠️ 位置在"活动行提前 return"之前算：光标停在标题行时它照样要按标题尺度显示
            //    （活动的意思是"标记不藏"，⛔ 不是"排版作废"）。
            const 首 = lineOf(node.from);
            const 末 = lineOf(Math.max(node.from, node.to - 1));
            for (let n = 首; n <= 末; n++) {
              if (headingLines[n]) continue;
              headingLines[n] = true;
              headings.push({ line: n, level: +h[1], from: lineStarts[n] });
            }
            return;
          }
          if (name === 'FencedCode') {
            fenced = true;
            return;
          }
          if (!shouldHide(node)) return;
          let from = node.from;
          let to = node.to;
          // ⚠️ 标题/引用的标记后面紧跟的**一个**空格一起藏（缩进⛔ 不藏：
          //    藏掉的话"标题前面有空格"这件事在编辑态就看不出来了）。
          if (name === 'HeaderMark' || name === 'QuoteMark') {
            const 下 = src.charAt(to);
            if (下 === ' ' || 下 === '\t') to += 1;
          }
          if (to <= from || to > src.length) return;
          // ⛔ 跨行的替换会让 CM6 抛错（`Decoration.replace` 不许吞行尾）⇒ 整段放弃。
          //    会走到这里的是"跨行的链接标题"这类极少数形态，放弃 = 标记可见，⛔ 不是错位。
          if (src.slice(from, to).indexOf('\n') >= 0) return;
          if (active[lineOf(from)]) return; // 光标所在行：显示源码（规则 2）
          raw.push({ from: from, to: to });
        },
      });
    }

    // ⭐ 有序 ＋ 合并**相邻**区间：`](url)` 在树里是 4 个挨着的节点（`LinkMark`/`URL`/…），
    //    不合并的话零宽替换之间会插一串 widget buffer，行高可能被推高
    //    （`live.css` 的 `.cm-widgetBuffer{font-size:0}` 只是兜底，⛔ 不该靠它）。
    raw.sort(function (a, b) {
      return a.from - b.from || a.to - b.to;
    });
    const ranges = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      const last = ranges[ranges.length - 1];
      if (last && r.from <= last.to) {
        if (r.to > last.to) last.to = r.to;
      } else {
        ranges.push({ from: r.from, to: r.to });
      }
    }
    // 兜底：空区间与非法区间一律丢弃（`Decoration` 遇到 `from > to` 会抛错 ⇒ 整块白屏）。
    const clean = ranges.filter(function (r) {
      return r.to > r.from && r.from >= 0 && r.to <= src.length;
    });

    const bodies = [];
    if (wantBody) {
      for (let i = 0; i < lineStarts.length; i++) {
        if (!headingLines[i]) bodies.push({ line: i, from: lineStarts[i] });
      }
    }
    return { ranges: clean, fenced: fenced, headings: headings, bodies: bodies, inline: inline,
      fenceLines: fenceLines };
  }

  /**
   * ⭐ 取这一份 `state` 的语法树（`design/0052` U3 的接线点）。
   *
   * ⚠️⚠️ **必须同时试 `ensureSyntaxTree`**：CM6 的 Markdown 解析器是**增量＋分片**的，
   *    `syntaxTree(state)` 在首次解析还没跑完时只返回**已经解析的那一小段**
   *    （甚至一个空树）⇒ 直接用它的话，块的**后半截**的标记一个都不藏。
   *    `ensureSyntaxTree` 会**阻塞**到解析完或超时；给了预算就一定能拿到整棵（或至少更长的）。
   * ⚠️ 预算是**为了不卡输入**：`create`（一次性）给得松，`update`（每敲一个字都可能来）给得紧。
   *    超时也不是灾难——拿到多少藏多少，未解析的那部分标记可见（同"没有树"的降级）。
   *
   * @param {object} CM6 `window.rmdCM6`
   * @param {object} state `EditorState`
   * @param {number} 预算 毫秒数（`ensureSyntaxTree` 的预算；⛔ 别写成 `预算毫秒`——JSDoc 的参数名要与形参逐字相同）
   */
  function treeOf(CM6, state, 预算) {
    if (!CM6 || typeof CM6.syntaxTree !== 'function') return null;
    if (typeof CM6.ensureSyntaxTree === 'function') {
      const t = CM6.ensureSyntaxTree(state, state.doc.length, 预算);
      if (t) return t;
    }
    return CM6.syntaxTree(state) || null;
  }

  /**
   * ⭐ 装饰层的 `StateField` + **接线**（规则 1：**块级装饰必须走它**，`ViewPlugin` 一抛
   * `RangeError` 就白屏）。
   *
   * ⚠️⚠️ **返回值必须是一个数组，而且第二项 `EditorView.decorations.from(field)` 不能省**：
   *    CM6 只把 `EditorView.decorations` 这个 **facet** 里的装饰集交给视图。
   *    只把 `StateField` 放进 extensions 是**静默无效**——`markers()` 算得出区间、
   *    视图里却原样显示 `#` / `**` / 反引号，而**任何逻辑判据都看不见**
   *    （2026-10-26 实测：`隐藏区间=8` 与 `.cm-line` 的 `textContent` 里全是原文，同屏并存）。
   *    ⭐ 数组本身是合法的 extension ⇒ 调用方照旧 `extensions.push(...)`，⛔ 不用改成两次 push。
   *
   * @param {object} CM6 `window.rmdCM6`
   * @param {{activeLineIndexes:(state) => number[], bodyLines?:boolean|(() => boolean), cellContext?:boolean}} hooks
   *   给"光标碰到的那几行"（0-based，块内）；`bodyLines` 说"这一块原来的品种是标题"
   *   （`live/box.js::headingLevelOf`）——那时非标题行要回落成正文尺度；
   *   `cellContext` 说"这是一格里切出来的文本"（`design/0049`）——只按行内语义呈现，
   *   ⛔ 不认标题/引用/围栏（GFM 的格子内只有行内语义）。
   * @returns {Array} `[StateField, FacetProvider]`
   */
  function createField(CM6, hooks) {
    const hide = CM6.Decoration.replace({});
    // ⭐ 单元格上下文（`design/0049` ＋ 2026-10-28 评审 P2）：只按**行内**语义呈现。
    const 格内 = hooks.cellContext === true;
    // ⚠️ 行级品种类的类名与 `live.css` 的「行级排版」一节**逐字对应**；⛔ 别在别处再造一套。
    const lineDecos = {};
    function lineDeco(cls) {
      if (!lineDecos[cls]) lineDecos[cls] = CM6.Decoration.line({ class: cls });
      return lineDecos[cls];
    }
    // ⚠️ 行内那五条同理：`Decoration.mark` 的 spec 只有 `class`，按类名缓存一份就够
    //    （CM6 的 spec 是不可变对象，重复 `mark()` 会让每次重算都造一批新对象）。
    const markDecos = {};
    function markDeco(cls) {
      if (!markDecos[cls]) markDecos[cls] = CM6.Decoration.mark({ class: cls });
      return markDecos[cls];
    }
    const build = function (state, 预算) {
      const text = state.doc.toString();
      const wantBody = typeof hooks.bodyLines === 'function' ? hooks.bodyLines() === true : hooks.bodyLines === true;
      const plan = markers(text, {
        activeLines: hooks.activeLineIndexes(state),
        bodyLines: wantBody,
        cellContext: 格内,
        tree: treeOf(CM6, state, 预算),
      });
      const decos = plan.ranges.map(function (r) {
        return hide.range(r.from, r.to);
      });
      // ⭐ **行内呈现**（`design/0052` U4）：加粗/斜体/删除线/行内代码/链接。
      //    ⚠️ 这一段正是 `bugs/0022`（编辑态与渲染态的**折行差**）的正解：
      //    行内代码在渲染态是等宽＋有内边距，编辑态若是正文字体，折行位置本来就不同
      //    ——加多少几何 slack 都堵不住，只能让两边长得一样。
      plan.inline.forEach(function (m) {
        decos.push(markDeco(m.cls).range(m.from, m.to));
      });
      // ⭐ 行级排版（`bugs/0015`）：每一行按**它自己的源码**定尺度，⛔ 不按那一块原来的品种。
      //    ⚠️ 位置由 `markers()` 与这里**同一份切片**算出来（`from` 就是那一行的行首偏移），
      //    ⇒ 不再从 `state.doc` 二次求值：纯逻辑那半（node 测试）也就不用造一个假 `Text`。
      plan.headings.forEach(function (h) {
        decos.push(lineDeco('cm-rmd-h' + h.level).range(h.from));
      });
      plan.bodies.forEach(function (b) {
        decos.push(lineDeco('cm-rmd-body').range(b.from));
      });
      // ⭐ **围栏行塌掉**（U5）：零宽替换已经把 ``` 与语言标记藏掉了，但那一行**还在**
      //    （一个空行仍占一整行高）⇒ 再贴一条行级类把它压到 0 高。
      //    ⚠️ 只有**非活动**的围栏行在这里（`markers()` 已经排除了活动行）。
      plan.fenceLines.forEach(function (f) {
        decos.push(lineDeco('cm-rmd-fence').range(f.from));
      });
      return CM6.Decoration.set(decos, true);
    };
    const field = CM6.StateField.define({
      create: function (state) {
        return build(state, 50);
      },
      update: function (value, tr) {
        // ⚠️ 选区变了也要重算：那是"光标所在行显示源码"的那一条（规则 2）。
        //    ⚠️ 输入路径的预算比 `create` 紧（10 ms）：这是**每敲一个字都可能**走的路，
        //    而增量重解析一棵已解析过的小树本来就快；超时也只会退化成"部分标记可见"。
        if (tr.docChanged || tr.selection) return build(tr.state, 10);
        // ⚠️⚠️ **第三个触发条件：后台解析完成**（`design/0052` U3 实测出来的）。
        //    首次 `create` 时整篇往往还没解析完（`ensureSyntaxTree` 超时）⇒ 那一帧
        //    **一个标记都藏不掉**；解析器随后跑完时，CM6 派的是 `Language.setState` 的
        //    **效果事务**——它⛔ 不带 `docChanged` 也不带 `selection` ⇒ 上面那行拦不住，
        //    结果是"首帧的标记永远留在屏幕上"，而**任何判据都看不见**。
        //    唯一可靠的信号是**树换了对象**：增量解析每次都产出新的 `Tree` 实例。
        // ⚠️ 判据挂在 `tr.startState` 上（真实 CM6 每条事务都有；假 CM6 里没有则是
        //    "不参与这条判据"，⛔ 不是"树没变"）。
        if (typeof CM6.syntaxTree === 'function' && tr.startState) {
          const 前 = CM6.syntaxTree(tr.startState) || null;
          const 后 = CM6.syntaxTree(tr.state) || null;
          if (后 && 后 !== 前) return build(tr.state, 10);
        }
        return value;
      },
    });
    return [field, CM6.EditorView.decorations.from(field)];
  }

  /**
   * 行首的列表标记（`- ` / `* ` / `+ ` / `1. `）——`layoutSlack()` 的第三类判据要用。
   * ⚠️ 只用来**排除**"这些行不会被合并成一段"，⛔ 不参与渲染。
   */
  const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;

  /**
   * ⭐ **纯函数**：源码里"渲染态不占一整行"的行数 —— "进编辑态会变高多少"的**记账**。
   *
   * ⚠️⚠️ **这是唯一实现**，⛔ 别在第二处写这个算式（`docs/bugs/0025`：
   *   探针曾经自己另算了一遍 `fences + blanks + 有标记的行数`，产品只有前两项
   *   ⇒ **探针比产品宽**，「探针全绿」推不出「用户看不到报错」）。
   *
   * ⚠️⚠️ **`design/0052` U6 起它不再拦任何人**：几何闸门不再拒收（`INV-KERNEL-05`
   *   「块永远进得去」），所以这里只回答"这块大概会高出多少"，供
   *   `make probe-live-block` 的 `B-3b` 印进判据说明。⛔ 不许任何代码拿它去**拒收**一块。
   *
   * 三类，各有各的理由，⛔ 都不是"宽容"：
   * - ~~**围栏行**~~ ⇒ ⭐ **`design/0052` U5 起恒为 0**：围栏行在**非活动**时整行塌成 0 高
   *   （`cm-rmd-fence` ＋ 零宽替换），与渲染态一样**不存在**那两行。
   *   ⚠️ 字段**留着**（恒 `0`）是因为签名与返回结构被产品与探针共同依赖，⛔ 不是为了将来再填回去；
   *   若哪天塌行失效，`B-3b` 会以"块高了 40 px"的形式红，⛔ 别靠把这一项调回 2 来"修"。
   * - **空行 / 只剩 `>` 的行**：渲染态里承载的是**段间距**（14px 正文下 15.4px），
   *   比一行（20.3px）**矮** ⇒ 视图比渲染态**多占**一截（实测引用块 **+4.907 px**）。
   * - **连续的正文本行**（`softWraps`）：CommonMark 的软换行在渲染态被**合并成一个段落**
   *   （`a\nb` 渲染成一行 `<p>`），编辑态却是**两行** ⇒ 每多一行多占一整行。
   *   ⚠️ 这一族 2026-10-27 之前**没有任何人算**（`layoutSlack('普通段落\n第二行')` 曾返回
   *   `{fences:0, blanks:0}`）⇒ 两行以上的段落**点不进去**，报「高度对不上」。
   *   ⚠️ 标题行与列表行**不合并**（各是各的块）⇒ 它们断开连续段，⛔ 不计入。
   * ⚠️ 围栏**内部**的行是**真内容**（代码里的空行就是一行），⛔ 不算。
   * ⚠️ 它只是一条**估算**：真正的差还取决于两端各自的行高与折行。
   *    "排版丢了东西"那半**不由它管**——那是 `live/index.js` 的**变矮告警**（只告警、不拦人）。
   *
   * @param {string} text 这一块的源码
   * @returns {{fences:number, blanks:number, softWraps:number}}
   */
  function layoutSlack(text) {
    const src = String(text === undefined || text === null ? '' : text);
    // ⚠️ 空源码没有行可数（`split('\n')` 会给出一个空行，那是"零行"的假象）。
    if (src === '') return { fences: 0, blanks: 0, softWraps: 0 };
    const lines = src.split('\n');
    let fence = null;
    let blanks = 0;
    let softWraps = 0;
    /** 当前这一段连续"可合并"的正文行数（-1 就是它多占的整行数）。 */
    let run = 0;
    function flush() {
      if (run > 1) softWraps += run - 1;
      run = 0;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const f = fenceOf(line);
      if (f) {
        flush();
        // ⚠️ 围栏行**不再计数**（U5：它们塌成 0 高）；但状态机照旧要翻——围栏里的
        //    空行与"连续正文行"都不是段间距/软换行。
        fence = fence === null ? f : null;
        continue;
      }
      if (fence !== null) continue;
      const 去引用 = line.replace(QUOTE, '');
      // 只剩引用标记（或全空白）的行：渲染态里是段落分隔，不是一个整行。
      if (去引用.trim() === '') {
        flush();
        blanks++;
        continue;
      }
      // 标题不参与合并（`#` 起头那一行自成一个块）；列表项自成一个 `<li>`（宽松列表另算段距）。
      if (HEADING.test(去引用) || LIST_ITEM.test(去引用)) {
        flush();
        continue;
      }
      run++;
    }
    flush();
    // ⚠️ `fences` 恒 0（U5 起围栏行整行塌掉，见上面的说明）。
    return { fences: 0, blanks: blanks, softWraps: softWraps };
  }

  /** 光标/选区碰到的行（0-based，块内）——`createField` 的 `hooks` 默认实现。 */
  function activeLineIndexes(state) {
    const out = [];
    const seen = {};
    for (let i = 0; i < state.selection.ranges.length; i++) {
      const r = state.selection.ranges[i];
      const from = state.doc.lineAt(r.from).number;
      const to = state.doc.lineAt(r.to).number;
      for (let n = from; n <= to; n++) {
        if (!seen[n]) {
          seen[n] = true;
          out.push(n - 1);
        }
      }
    }
    return out;
  }

  const api = {
    markers: markers,
    fenceOf: fenceOf,
    layoutSlack: layoutSlack,
    createField: createField,
    activeLineIndexes: activeLineIndexes,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  // ⚠️⚠️ 全局名**不叫** `liveDecorations`（`design/0047` §10 的一处偏差）：
  //    `tests/js/keymap.test.js` 有一条源码级闸门，判据是"**非 `live/**` 的文件里
  //    不许出现 `Decoration` 这个子串**"（它防的是"又装了一个 CM6 渲染类扩展"）。
  //    而 `main.js` 必须持有本模块的引用 ⇒ 那个名字在**它**的文件里就成了一个
  //    逐字命中的假阳性。⛔ 不放宽闸门（那条闸门挡的是真缺陷），改用一个不撞的名字：
  //    `liveMarks` = "藏起来的 Markdown 标记"，与本文件做的**唯一**那件事同名。
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveMarks = api;
})();
