// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// 装饰层：把 Markdown 标记变成**不可见**（Live Preview 的那半）—— `design/0047` §2.9。
//
// # 范围（⛔ 别扩大）
//
// 只做一件事：**标记恒定不可见**（`design/0061` L1，2026-11-05 起）。
// ⚠️ 旧形态是"隐藏 ＋ 光标/选区所在行原样显示源码"；那条规则（`design/0047` 规则 2）
//    已被 `design/0061` 取代：进编辑态不再把标记露出来，屏幕文本与行高才能与阅读态恒等
//    （`INV-LIVE-14`）。⇒ 这里**不再接收任何选区/活动行输入**，隐藏集合只是源码的纯函数。
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
// 2. ⭐ **隐藏集合与光标/选区无关**（`design/0061` L1）：标记**恒定**隐藏，进编辑态
//    不显示源码。落点由 `selection.js::legalEdge` 钳到可见边界（L2），⛔ 不靠"放开活动行"。
// 3. ⭐ **只隐藏、不删除**：`Decoration.replace({})` 是零宽替换，文档一个字符都不变
//    ⇒ 提交上去的仍是真源码（`INV-LIVE-13`）。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，顶层 `const` 撞名会让
// **整个文件不执行**（窗口空白、stderr 全静默）。理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  // ⭐ `design/0065` P1：列表几何的**唯一真相**（`live/geometry.js`，纯函数）。
  //    ⚠️ **加载期取值** ⇒ `index.html` 里 `live/geometry.js` 必须排在**本文件之前**
  //    （`tests/js/keymap.test.js` 的「脚本加载顺序」闸门盯着这一条）。
  //    ⚠️ Node 侧（`tests/js/live-*.test.js`）走 `require('./geometry.js')`——注意那是相对
  //    `src/live/` 解析的，与 `decorations.js` 自身的位置一致；`tests/js` 里用 `new Function`
  //    跑源码副本的那几处必须显式把 `require` 注进去（否则这里为 `null`，`markers()` 一碰列表就抛）。
  const LG = (typeof window !== 'undefined' && window.rmd && window.rmd.liveGeometry)
    || (typeof require === 'function' ? require('./geometry.js') : null);
  /**
   * 列表几何（`live/geometry.js`）。缺模块 ⇒ 立刻报错，⛔ 退回内联公式（那会是第二个真相）。
   * @param {{depth?: number, topIsList?: boolean, hostKind?: 'list'|'box'|undefined}} input
   */
  function 列表几何(input) {
    if (!LG) throw new Error('rmd: live/geometry.js 必须先于 live/decorations.js 加载');
    return LG.listGeometry(input);
  }
  /**
   * 深度已定那一段的几何（`listGeometryAt`）。
   * @param {number} depth
   */
  function 列表几何At(depth) {
    if (!LG) throw new Error('rmd: live/geometry.js 必须先于 live/decorations.js 加载');
    return LG.listGeometryAt(depth);
  }

  /**
   * 行首：`#{1,6}` ＋ 一个空格（标题）。
   * ⚠️ **只给 `layoutSlack()` 用**（⛔ 2026-11-09 起那是**诊断量**，不是允许量：`INV-LIVE-04` ①
   *    要求进入瞬间块高差为 0），⛔ 不再参与"藏不藏标记"——
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
   * ⭐ 有序列表标记的**合法上界**（`design/0063` F4c：10 位数字不是列表标记）。
   * ⚠️ 这一份是 CommonMark §5.2 / `P-OL-06-SPEC` 的结构判据，阅读态由 Rust/comrak 定
   * ⇒ 编辑侧只把它**交出去**（`bugs/0315`：`999999999.` 回车⛔ 不许写出十位编号）。
   */
  const MAX_ORDERED = 999999999;

  /**
   * ⭐ **该藏的标记节点**（`design/0052` U3）。
   *
   * ⚠️ 这是一张**白名单**：树里出现别的节点一律不动。理由不是省事——每多藏一个节点，
   *    就多一种"两个解析器对方言理解不同 ⇒ 标记永远不消失/永远消失"的形态（U9 的差分表就是量它）。
   * ⛔ **故意不在表里**（藏了反而错）：
   *    · `SuperscriptMark` / `SubscriptMark` / `Emoji`：comrak **不支持**这三种扩展
   *      （`document/parser.rs` 只开 table/strikethrough/tasklist/autolink/footnotes）⇒
   *      它们在渲染态是**原样文字**，编辑态也应当原样可见；
   *    · `TableDelimiter`：表格的分隔行在渲染态有位置（竖线），塌掉会让整张表变样。
   * ⚠️ `ListMark` / `TaskMarker` / `HardBreak` **已从这张排除名单里移出**（2026-11-05，
   *    [`bugs/0092`](../../docs/bugs/0092-列表标记占正文宽度改变折行点.md) /
   *    [`bugs/0093`](../../docs/bugs/0093-硬换行的反斜杠在编辑态可见.md)）：
   *    旧注释只算了"藏了会变矮"，没算"留着会让**正文可用宽度少 2–6 个字符** ⇒
   *    长列表项多折一行、画面整体跳动。现在它们在 `markers()` 里有**专门分支**：
   *    藏掉源码标记，圆点/编号/方框由行级装饰画在**缩进带**里（不占正文宽度）。
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
   * ⚠️ 链接贴的是**整个 `Link` 节点**（含 `](url)`）：隐藏区间上那部分已被零宽替换取代、
   *    看不见；`](url)` 的样式照常存在，只是没有可见字形。⚠️ 标记恒定隐藏（`design/0061` L1）
   *    ⇒ 不再有"活动行上 `](url)` 跟着变色"这一形态。
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
    //    语言标记改走格式栏或原文模式（`design/0061` §4：隐藏后不可点，这是 Mardo 的形态）。
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
   * ⚠️⚠️ **`design/0061` L1 起它是源码的纯函数**：签名里**没有**光标/选区/活动行，
   *    调用方给同一份 `text` ＋ `tree` 就永远得到同一组 `ranges`（`INV-LIVE-14`）。
   *    旧的可选入参 `activeLines` 已**删除**（不是忽略）——留着第二个开关就等于两套隐藏真相。
   *
   * @param {string} text 这一块的源码（`fullText` 的行区间切片，恒 LF）
   * @param {{bodyLines?:boolean, cellContext?:boolean, listHost?:boolean, tree?:object}} [opts]
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
   *   fenceLines:Array<{line:number,from:number,to:number}>,
   *   collapsedLines:Array<{line:number,from:number,to:number}>,
   *   listLines:Array<{line:number,from:number,contentFrom:number,depth:number,level:number,kind:string,
   *     marker:string,markerFrom:number,markerRaw:string,number:number|null,checked?:boolean,code:boolean}>,
   *   tasks:Array<{pos:number,checked:boolean}>,
   *   quoteGapLines:Array<{line:number,from:number,to:number}>,
   *   quoteDepths:Array<{line:number,from:number,qdepth:number}>,
   *   nestedCodeLines:Array<{line:number,from:number,first:boolean,last:boolean}>,
   *   nestedHeadingSpaces:Array<{line:number,from:number,where:string}>,
   *   rawRanges:Array<{from:number,to:number}>,
   *   prefixRanges:Array<{from:number,to:number}>,
   *   prefixLevels:Array<{from:number,to:number}>,
   *   zwRanges:Array<{from:number,to:number}>,
   *   quoteLines:Array<{line:number,from:number,markerFrom:number,contentFrom:number,blank:boolean}>,
   *   maxOrdered:number,
   *   codeLines:Object<string|number, boolean>}}
   *   ⚠️ `design/0066`（2026-11-11）起**没有** `listGapLines` / `listSepLines`：
   *   列表内不再有段距，理由见下。
   *   `ranges` 是**绝对偏移**（0-based，与 `text` 同一坐标）、**有序、互不重叠、不跨行**
   *   ⇒ 能直接喂 `Decoration.replace`；
   *   `headings` / `bodies` 除了行下标还带上**行首偏移 `from`** ⇒ 喂 `Decoration.line`
   *   不用再从 `state.doc` 二次求值（纯逻辑那半因此不需要造一个假 `Text`）；
   *   `inline` 是**行内呈现**（`design/0052` U4）：喂 `Decoration.mark`，⛔ 不改文档、
   *   ⚠️ **允许跨行与嵌套**（`**a\nb**`、`***x***` 都是合法形态），且与隐藏集合一样**恒定**
   *   ——标记藏不藏与内容样式是两件独立的事；
   *   `fenceLines` 是**每一条**围栏行的行首/行末偏移（`design/0052` U5）：喂 `Decoration.line`
   *   的 `cm-rmd-fence`（整行塌成 0 高）。⚠️ `design/0061` L1 起**没有例外**：围栏行恒塌，
   *   光标必须跨过整行（L2 的 `legalEdge` 负责），⛔ 不再有"活动行要能看见、能改语言标记"。
   *   `collapsedLines` 是**同样要塌成 0 高**的其它行（目前只有 Setext 的下划线行，
   *   `bugs/0089`）——喂 `cm-rmd-collapsed`，与围栏行同一条 CSS 规则；
   *   `listLines` 是每一条列表行（含续行）的深度与品种：喂 `cm-rmd-li` 行级类，
   *   行内 `margin-left` 给出嵌套缩进，标记交给 UA 的 `::marker`（`design/0084`；`bugs/0092`）。
   *   `kind` 是 `'bullet' | 'ordered' | 'task' | 'plain'`（`plain` ＝ 列表项的续行）；
   *   `contentFrom` 是**正文起点**（标记与行首缩进藏掉之后的第一个可见字符位置）。
   *   ⚠️ 标记恒藏之后，光标若停在 `from`（行首）敲字会插到 `- ` **之前**、把列表结构写坏
   *   ⇒ `selection.js` 的 `listContentStart` 用它把折叠选区从行首吸到正文起点。
   *   `tasks` 是任务框 widget 的落点（隐藏区间末端 ＝ 正文起点，`bugs/0092`）。
   *   `quoteGapLines` 是**夹在内容之间**的空引用行（`bugs/0090`）：喂 `cm-rmd-quote-gap`，
   *   行高 ＝ `--reader-gap-block`（阅读态那一处本来就是**段距**，不是一整行）。
   *   ⚠️ 连续多条只取第一条；开头 / 结尾的空引用行进 `collapsedLines`（塌成 0 高）。
   *   ⭐ `design/0085` C3 起例外：**两侧都是列表行**的空引用行两边都不进（它按普通行盒排，
   *   行高 ＝ 该处正文行高 —— 与阅读态 `li[data-blanks]` 同一档，`bugs/0318`）。
   *   `quoteDepths` 是**第二层起**的引用盒：`{line, from, qdepth}`，喂 `data-rmd-qdepth`
   *   （`live.css` 给竖线与左内边距）。宿主已经搬了最外层那一份（`design/0085` C4）。
   *   ⚠️ **列表内没有段距**（`design/0066`，2026-11-11 用户裁定「松散不存在」）：阅读态由
   *   `render.rs::写空行属性` 的 `--rmd-blanks` ＋ `typography.css` 落地，编辑态就是源码本身
   *   的行高 ⇒ 这里**不产出**任何补段距的行装饰（`bugs/0021` / `bugs/0307` 那套 emulation 已删）。
   *   `nestedCodeLines` 是**嵌在引用块 / 列表项里**的代码块内容行（`bugs/0091`）：
   *   喂 `cm-rmd-code-line`，首 / 末行另加 `cm-rmd-code-first` / `-last` 承担整块的上下内边距。
   *   顶层代码块**不在这里**（它的 mono / 字号 / 内边距由 host 的 `cm-rmd-code` 给）。
   *   `nestedHeadingSpaces` 是内嵌标题的留白行（`bugs/0091`）：`where` 是 `'before' | 'after'`，
   *   喂 `cm-rmd-heading-space-before` / `-after`；顶层标题块由 host 搬外边距，不在这里。
   *   ── `bugs/0111` / `0315` / `0317` 起新增的**纯数据**（装饰层自己一条都不用，⛔ 别删）──
   *   `listLines[].markerFrom` 是**标记本身**的起点（`> - ` 的一级标记是 2，⛔ 不是行首 0）；
   *   `markerRaw` 是源码里的原始标记（`'3.'` / `'3)'` / `'-'`）；`number` 是有序项的**渲染编号**
   *   （按位置算出来的 `基 + i`），无序 / 任务 / 续行恒 `null`。
   *   `quoteLines` 是每个引用行（**非代码行**）的 `{line,from,markerFrom,contentFrom,blank}`：
   *   `contentFrom` 覆盖 `> > ` 所有层级的引用标记与随后的空白；`blank` ＝ 前缀之后只剩空白。
   *   `rawRanges` 是 `ranges` 合并**之前**的视图：按 `from` 排序、只去重（完全相同）不合并
   *   ⇒ 落点判定能看到相邻区间之间的边界（`bugs/0317`）；
   *   `prefixRanges` 只含**块前缀**（列表标记 / 任务框 / 引用 / 标题 / 续行缩进），不含行内标记，
   *   相邻者已合并；
   *   `prefixLevels` 是同一批块前缀的**分层**视图（`bugs/0111` K3）：已排序、互不重叠、
   *   **不合并**。粒度：每一层 `>` 各一段；列表标记 ＋ 同一行的任务框 ＋ 行首缩进合成一段
   *   （`- [ ] 甲` ⇒ `[0,6)`）；标题标记一段；列表续行的行首缩进一段。
   *   ⛔ 行内标记（`**` / 反引号 / 删除线 / 链接）不进这里。选区间用：
   *   `selection.js::wholeLineMark` 的反向档要"只退一层"，靠它把 `> - ` 劈成 `[0,2)` / `[2,4)`。
   *   `zwRanges` 是**行内代码反引号**的区间（`bugs/0304` 候选 ④）：与 `rawRanges` 同风格，
   *   按 `from` 排序、只去重不合并。⚠️ 它们**同时仍在 `ranges` 里**（落点 / 删除层要那份
   *   完整隐藏集合）；`build()` 只把它们从**零宽替换**里拆出来，改贴 `cm-rmd-zw`
   *   （字符留在文本流里 ⇒ 断行输入与阅读态同类）。
   *   `maxOrdered` 是有序编号的合法上界（`999999999`，`design/0063` F4c：10 位不是列表标记）。
   *
   * `opts.listHost`：**宿主元素是不是 `<ul>` / `<ol>`**（`bugs/0305`，2026-11-10）。
   *   `false` ⇒ 列表是在段落 / 标题的编辑框里现敲出来的（宿主是 `<p>` / `<h*>`，
   *   `padding-left` 为 0）⇒ 顶层列表的行级深度从 1 起，把 `<ul>` 那条缩进补回来；
   *   `true` ⇒ 宿主搬的正是 `<ul>` 的 `padding-left`，深度从 0 起；
   *   `undefined` ⇒ 未知（纯逻辑单测）⇒ 沿用旧口径（0），⛔ 不改变既有判据。
   */
  function markers(text, opts) {
    const src = String(text === undefined || text === null ? '' : text);
    const o = opts || {};
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
    /** 这个节点的祖先里有没有块级容器（代码 / HTML 块）。引用标记在围栏里时**不是**块标记。 */
    function 在块级容器里(node) {
      let p = node && node.parent;
      while (p) {
        if (块级容器[p.name]) return true;
        p = p.parent;
      }
      return false;
    }
    /**
     * 这个节点是否**嵌在引用块里**（`bugs/0091` 的标题首行留白判据）。
     *
     * ⚠️ 顶层的列表项里，标题的 `margin-top` 会**穿过** `li` / `ul` 折叠到列表外，
     *    不在被替换元素的 border box 里 ⇒ 编辑态补了反而比阅读态高。
     *    引用块有 `padding`，外边距折不出去 ⇒ 必须补（阅读态它确实占着高度）。
     * @param {object} node Lezer 语法树节点
     * @returns {boolean}
     */
    function 在引用块里(node) {
      let p = node && node.parent;
      while (p) {
        if (p.name === 'Blockquote') return true;
        p = p.parent;
      }
      return false;
    }
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

    /**
     * ⭐ `bugs/0321`：这个 `OrderedList` 在 comrak 眼里**不是列表**——它打断了一个段落，
     * 而首项编号不是 `1`（CommonMark §5.2：「列表打断段落时必须以 1 起」）。
     *
     * 实测（comrak 0.56，`tools/live-probe --render-json`）：
     *   · `1. 甲\n   2. 乙`   ⇒ `<li>甲<br />2. 乙</li>`（乙是**段落文字**）
     *   · `1. 甲\n   1. 乙`   ⇒ 真嵌套 `<ol><li>乙</li></ol>`
     *   · `1. 甲\n\n   2. 乙` ⇒ 真嵌套 `<ol start="2">`（隔了空行就不算"打断"）
     * 而 Lezer 前两种都给出嵌套列表 ⇒ 编辑态与阅读态分叉（用户 2026-11-14 的截图）。
     *
     * @param {any} node `OrderedList` 的语法树节点
     * @returns {boolean}
     */
    function 假嵌套列表(node) {
      const 首项 = node.firstChild;
      const 标记 = 首项 && 首项.firstChild;
      if (!标记 || 标记.name !== 'ListMark') return false;
      const 号 = parseInt(src.slice(标记.from, 标记.to), 10);
      if (!isFinite(号) || 号 === 1) return false;
      const 前 = node.prevSibling;
      if (!前 || 前.name !== 'Paragraph') return false;
      // 「打断」= 段落**紧贴**在这一行之前（中间没有空行）。⚠️ `Paragraph.to` 不含换行。
      return lineOf(前.to) === lineOf(node.from) - 1;
    }

    /**
     * 待藏区间（遍历顺序推入，**不保证**按 `from` 有序）。
     * `prefix: 1` 标的是**块前缀**（列表标记 / 任务框 / 引用 / 标题 / 续行缩进）——
     * `prefixRanges` 只收这些；⛔ 行内标记（强调 / 删除线 / 链接 / 行内代码）不带这个字段。
     * `zw: 1` 标的是**行内代码的反引号**（`bugs/0304` 候选 ④）——`zwRanges` 只收这些；
     * ⛔ 围栏 / 缩进代码块里的同名 `CodeMark` 不带这个字段（它们是围栏符或内容）。
     * @type {Array<{from:number, to:number, prefix?:number, zw?:number}>}
     */
    const raw = [];
    /**
     * ⭐ `bugs/0111` K3：块前缀的**分层**视图（第三份区间视图，⛔ 不参与 `raw` 的合并）。
     * 每层一段、已排序、互不重叠、不合并 ⇒ "一次退格只退一层"能拿到边界。
     * ⚠️ 与 `prefixRanges` 的差别只有一个：相邻层**不并**（列表标记与同一行的任务框除外）。
     * @type {Array<{from:number, to:number}>}
     */
    const prefixLevels = [];
    /** 每行最后一个块前缀层的下标（任务框要并进同一行的列表标记层）。 */
    const levelLast = {};
    /** 每行块前缀层已覆盖到的终点（下一层从这里起，保证互不重叠）。 */
    const levelEnd = {};
    /**
     * 往 `prefixLevels` 里追加**一层**块前缀（`bugs/0111` K3）。
     *
     * ⚠️ `from` 会被夹到该行已有层的终点之后 ⇒ 结果天然互不重叠；`merge` 只给
     *    `TaskMarker` 用：它紧接 `ListMark`（`- [ ] `），按约定并入同一段，⛔ 不单独成层。
     * @param {number} n 行号
     * @param {number} from 这一层的起点（可能早于该行已有层的终点）
     * @param {number} to 这一层的终点（半开）
     * @param {boolean} [merge] 是否并入同一行上一段（仅任务框）
     * @returns {number} 层下标；`-1` ＝ 空区间，没记
     */
    function 添层(n, from, to, merge) {
      const 起 = Math.max(from, levelEnd[n] || 0);
      if (!(to > 起)) return -1;
      const last = levelLast[n];
      if (merge === true && last !== undefined && prefixLevels[last].to === 起) {
        prefixLevels[last].to = to;
        levelEnd[n] = to;
        return last;
      }
      prefixLevels.push({ from: 起, to: to });
      const idx = prefixLevels.length - 1;
      levelLast[n] = idx;
      levelEnd[n] = to;
      return idx;
    }
    const headingLines = {};
    const headings = [];
    const inline = [];
    const fenceLines = [];
    const fenceSeen = {};
    // ⭐ 2026-11-05（`bugs/0089`/`0092`/`0093` 同批）：列表与硬换行的装饰数据。
    //    · `collapsedLines`：`====` 下划线这类**整行不可见**的行（与围栏行同一条塌高路）；
    //    · `listLines`：每一行列表的深度与品种（缩进走行内 `margin-left`，标记由 UA 的
    //      `::marker` 画 —— `design/0084`）；
    //    · `tasks`：任务框 widget 的落点（`- [ ] ` 之后，正文起点）。
    const collapsedLines = [];
    const listLines = [];
    const listSeen = {};
    const lineDepth = {};
    // ⭐ 2026-11-14（`bugs/0321`，用户报告）：列表行的**嵌套层数**（最外层 ＝ 0）。
    //    ⚠️ 它与 `lineDepth` **不是一回事**：后者是"行盒该缩进几格"，含"宿主搬没搬
    //    `<ul>` 的 `padding-left`"那一段补位（`live/geometry.js` 的 `补位`），而圆点的
    //    **形状**只认层数（阅读态的 UA 级联 `disc`/`circle`/`square` 看的是 `<ul>` 套了几层）。
    const lineLevel = {};
    // ⭐ 2026-11-08（`bugs/0090`/`0091`）：**引用块里**的两种行。
    //    · `quoteBlankSeen`：源码里"只剩引用标记"的行（`>` / `> `）——阅读态它不是一行，
    //      而是一段**段距**；这里先登记行号，遍历结束后再按"是否夹在内容之间"分类。
    //    · `nestedCodeRanges` / `nestedHeadingRanges`：**嵌在别的块里**的代码块与标题
    //      （引用块 / 列表项）。顶层块自己由 host 类（`live/box.js::classNameOf`）管，
    //      内层块没有第二层宿主 ⇒ 只能按源码行贴类（`bugs/0091`）。
    const quoteMarkLines = {};
    /**
     * 每一行**最后一个** QuoteMark 的右端点（行号 → 偏移）。
     * 多层引用（`> > foo`）同一行有多个 QuoteMark，取最大者；`input.js` 的续行前缀
     * 与 `quoteLines[].contentFrom` 都从它派生。
     * @type {Object<string|number, number>}
     */
    const quoteMarkEnd = {};
    // ⭐⭐ `design/0085` C4（2026-11-15）：**引用块的层级范围**。
    //    宿主只搬**最外层**那一份盒子（`live/box.js` 量的是被换掉的那个顶层元素）
    //    ⇒ `- > q` / `> > q` 的第二层起在编辑态没有竖线与左内边距。
    //    ⚠️ 收的是**范围**而不是 `QuoteMark` 的个数：lazy continuation 行（`> a\nb`）
    //    没有标记，但它在树里仍在引用范围内 ⇒ 按范围算才对。`层` 从 1 起。
    const 引用范围 = [];
    let 引用层 = 0;
    const nestedCodeRanges = [];
    const nestedHeadingRanges = [];
    // ⭐ 代码块占的**行号**（`bugs/0102`）：续行的行首缩进要被藏掉，但代码块里的缩进
    //    是**正文**（`- ` 里贴一段 ``` 或四个空格缩进的代码，缩进本身就是内容）⇒ 逐行登记，
    //    藏缩进的那一步跳过它们。
    const codeLines = {};
    const tasks = [];
    /** 正在进入的列表（栈顶 ＝ 当前最内层）。`leave` 时弹栈并把有序编号定下来。 */
    const listStack = [];
    let fenced = false;

    /** 第 `n` 行的行末偏移（`\n` 的位置，或文件末尾）。 */
    function 行末(n) {
      return n + 1 < lineStarts.length ? lineStarts[n + 1] - 1 : src.length;
    }
    /** 取/建某一行的列表记录（同一行只有一个 `ListMark`，后来的 `TaskMarker` 复用）。 */
    function 列表行(n) {
      let r = listSeen[n];
      if (!r) {
        r = {
          line: n, from: lineStarts[n], contentFrom: lineStarts[n],
          depth: lineDepth[n] || 0, level: lineLevel[n] || 0, kind: 'plain', marker: '',
          // ⭐ `bugs/0111` A2 / `0314`：**标记本身**的起点与原始源码。续行没有标记
          //    ⇒ `markerFrom` 落在行首、`markerRaw` 为空；`ListMark` 分支会覆盖它们。
          //    ⚠️ `markerFrom` ⛔ 不是行首：`> - ` 的一级标记起点是 `node.from = 2`
          //    （`> ` 是引用前缀，回车只许退列表那一层）。
          markerFrom: lineStarts[n], markerRaw: '',
          // ⭐ `bugs/0111` A3：有序项的**渲染编号**（按位置算出来的 `基 + i`），
          //    由 `leave` 填写；无序 / 任务 / 续行恒 `null`。
          number: null,
          // ⭐ `bugs/0300` 现象二（2026-11-09）：代码行不是"列表续行"——回车时
          //    `input.js::lineBreakAction` 靠这个标记把它排除在外，⛔ 不往围栏里塞前缀。
          code: false,
        };
        listSeen[n] = r;
        listLines.push(r);
      }
      return r;
    }
    function 记深度(n, d) {
      const 旧 = lineDepth[n];
      lineDepth[n] = 旧 === undefined ? d : Math.max(旧, d);
    }
    /** ⭐ `bugs/0321`：递归层数同样**取最大**（外层列表先给自己的整段登记过一次）。 */
    function 记层级(n, lv) {
      const 旧 = lineLevel[n];
      lineLevel[n] = 旧 === undefined ? lv : Math.max(旧, lv);
    }

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
          // ⭐ 引用块里的空行（`bugs/0090`）：先只登记"这一行有引用标记"。
          //    ⚠️ 围栏内部的 `>` 是**代码内容**（`> let x = 1;` 的 `>` 在树里也是 QuoteMark）
          //    ⇒ 用祖先判据排除，⛔ 不能只看行首字符。
          if (!格内 && name === 'QuoteMark' && !在块级容器里(node.node)) {
            const n = lineOf(node.from);
            quoteMarkLines[n] = true;
            // 多层引用同一行有多个 QuoteMark：记**最后一个**的右端点（取最大）。
            if (!(quoteMarkEnd[n] >= node.to)) quoteMarkEnd[n] = node.to;
          }
          // ⭐ `design/0085` C4：登记引用块的范围与层数（`宿主搬了` ＝ 最外层块就是引用块
          //    ⇒ 那一层盒子已经由 host 搬过，行级只补剩下的）。
          if (!格内 && name === 'Blockquote' && !在块级容器里(node.node)) {
            引用层 += 1;
            引用范围.push({
              层: 引用层,
              from: node.from,
              to: node.to,
              宿主搬了: 顶层块(node.node) === 'Blockquote',
            });
          }
          // ⭐ 列表与硬换行（`bugs/0092`/`0093`，2026-11-05）：源码标记**恒藏**。
          //    单元格里只有行内语义（GFM 的格内没有列表）⇒ 这一族整段跳过（`bugs/0092` 的
          //    既有判据「格子里不藏 ListMark」照旧成立）。
          if (!格内 && (name === 'BulletList' || name === 'OrderedList')) {
            // ⭐⭐ 2026-11-14（`bugs/0321` 第二半，用户报告「进入编辑状态的缩进，和展示的缩进
            //    是不一样的。违背展示和编辑完全一致的原则」）：**这不是一个列表**——
            //    有序列表**打断一个段落**时必须以 `1` 起（CommonMark §5.2）。Lezer 不守这一条，
            //    于是 `1. 甲` / `   2. 乙`（用户按 Tab 之后就长这样）在树里是"嵌套列表"，
            //    而 comrak 渲染成 `<li>甲<br />2. 乙</li>` ——**乙那行是段落文字**。
            //    ⇒ 整棵子树按普通文字处理（`return false` 跳过孩子）：这些行由外层列表的
            //    `lineDepth` 兜住（外层在它自己的范围里已经登记过），续行那一遍会把行首空白藏掉、
            //    正文落在外层的内容列上 —— 与阅读态逐像素同一个起点。
            //    ⚠️ 判据**用树**（前一个兄弟是不是紧贴着的 `Paragraph`），⛔ 不看行首字符：
            //    中间隔了空行时 comrak 认这个列表（实测 `1. 甲\n\n   2. 乙` ⇒ `<ol start="2">`），
            //    那时 `Paragraph` 与列表之间差着一行。
            //    ⚠️ 已经产生的这种文件由这一分支**按阅读态显示**；`Tab` 那一侧另有一条
            //    （`input.js::indentStep` 把新子列表的第一项改写成 `1`），⛔ 别在这里补救号。
            if (name === 'OrderedList' && 假嵌套列表(node.node)) return false;
            // ⭐⭐ 2026-11-08（`bugs/0112 B4`）：列表的**第一条缩进**来自它自己的 `<ul>` / `<ol>`。
            //    宿主只搬**被替换那一块**的盒子（`live/box.js::PROPS`），所以：
            //    · 块本身就是列表 ⇒ 宿主搬的正是那个 `<ul>` 的 `padding-left` ⇒ 行级深度从 0 起；
            //    · 块是引用块、列表藏在里面 ⇒ 宿主搬的是引用块，内层 `<ul>` 的 `padding-left`
            //      **没人搬**（阅读态它在 `<li>` 外面）⇒ 行级深度从 1 起，把这一条缩进补回来。
            //    证据（离屏实测 2026-11-08）：引用块里的列表，阅读态 `<li>` 正文左缘 330、
            //    编辑态 302，差 28 ＝ 14px × `--reader-list-indent`(2em)；顶层列表 309/309。
            const 顶层 = 顶层块(node.node);
            const 作顶层块 = (顶层 === 'BulletList' || 顶层 === 'OrderedList');
            // ⭐⭐ 2026-11-10（`bugs/0305`）：宿主**不是** `<ul>` / `<ol>` 时，那条缩进没人搬。
            //    在段落 / 标题的编辑框里现敲出列表（`* ` 起头 → 回车 → 逐项输入）时，
            //    树里的 Document 孩子**就是这个列表**（`作顶层块` 为真），
            //    但宿主是 `<p>` / `<h*>`：`box.js` 搬的是它们的盒子，`padding-left` ＝ 0
            //    ⇒ 旧口径「作顶层块 ⇒ 深度从 0 起」让整块列表**贴上正文左缘**，
            //    圆点再往左突出 16 px（离屏实测 2026-11-10：行左 281 ＝ 宿主左缘、
            //    `padding-left: 0`、圆点 265；真 `<ul>` 宿主是 行 309 / 圆点 293）。
            // ⭐ `design/0065` P1（2026-11-10 用户批准"立即开工"）：**补位与缩进值只由
            //    `live/geometry.js::listGeometry` 给**，本文件⛔ 不再出现第二个 `+1`、
            //    ⛔ 也不再自己拼 `calc(... * depth)`。改动前这里写的是
            //    `深基 = 作顶层块 ? (listHost === false ? 1 : 0) : 1`，
            //    现在那条规则连同它的一句话理由一起搬进了那个纯函数（`bugs/0305` ① 的位置）。
            const 深 = 列表几何({
              depth: listStack.length,
              topIsList: 作顶层块,
              hostKind: o.listHost === true ? 'list' : (o.listHost === false ? 'box' : undefined),
            }).depth;
            const 首 = lineOf(node.from);
            const 末 = lineOf(Math.max(node.from, node.to - 1));
            // 这个列表覆盖的**每一行**（含续行、含内层代码块）都要多缩进一个
            // `--reader-list-indent`：阅读态的嵌套是靠每一层 `<ul>` 的 padding-left 出来的。
            // ⭐ `bugs/0321`：层数同时记一份（`listStack.length` ＝ 外层已有几个列表，
            //    所以最外层是 **0**），圆点形状只认它。
            for (let n = 首; n <= 末; n++) { 记深度(n, 深); 记层级(n, listStack.length); }
            // ⭐⭐ 2026-11-11（`design/0066`）：**列表里没有段距了**。
            //    用户裁定「永远是紧凑的状态，松散不存在，如果是空行，就把空行展示出来」。
            //    阅读态那半由 `render.rs::写空行属性` ＋ `typography.css` 落地；编辑态这半是
            //    **减法**——空行本来就排成正常一行高，`bugs/0021` 立的
            //    `listGapLines` / `listSepLines` / `cm-rmd-li-gap-after` / `cm-rmd-li-sep`
            //    整套模拟因此作废。⇒ 帧里只剩**有序列表重新编号**要用的东西。
            const 帧 = { ordered: name === 'OrderedList', items: [] };
            listStack.push(帧);
            return;
          }
          // ⚠️ 这里**曾经**有两支：`Paragraph`（`bugs/0021`）与 `Task`（`bugs/0307`），
          //    它们把"松散列表项里每个段落的末尾"登记到列表帧上，好让 `markers()` 给那一行
          //    补 `padding-bottom`。`design/0066`（2026-11-11）之后列表内不再有段距，
          //    两支连同列表帧上的段距字段一起删掉——⛔ 别再复活它们。
          if (!格内 && name === 'ListMark') {
            const n = lineOf(node.from);
            // 从**行首**藏到标记后的空白：行首缩进与 `> ` 引用标记一并吃掉，
            // 圆点/编号改由行级装饰画进缩进带（⛔ 不让它占正文宽度 ⇒ 折行点不再改变）。
            let to = node.to;
            while (to < src.length && (src.charAt(to) === ' ' || src.charAt(to) === '\t')) to++;
            const 止 = Math.min(to, 行末(n));
            raw.push({ from: lineStarts[n], to: 止 });
            // ⚠️ `prefix` 另起一行写：这一行 `raw.push` 是 `tests/js/live-deadzone-round2.test.js`
            //    变异 m（R2-02m）的靶子，⛔ 别把字段塞进对象字面量里。
            raw[raw.length - 1].prefix = 1;
            // ⭐ `bugs/0111` K3：列表标记与**行首缩进**合成一层；同一行的任务框由
            //    `TaskMarker` 分支并进来（`- [ ] 甲` ⇒ 一层 `[0,6)`）。
            //    ⚠️ 起点取行首、但会被 `添层` 夹到引用层之后 ⇒ `> - ` ＝ `[0,2)` ＋ `[2,4)`。
            添层(n, lineStarts[n], 止);
            const r = 列表行(n);
            r.contentFrom = 止;
            const 栈顶 = listStack[listStack.length - 1] || null;
            r.kind = 栈顶 && 栈顶.ordered ? 'ordered' : 'bullet';
            r.marker = src.slice(node.from, node.to);
            // 标记本身的起点与**原始源码**（`3.` / `3)` / `-`）：`bugs/0111` A2 的删除跨度
            // 从 `markerFrom` 起（⛔ 不吞 `> ` 引用前缀），A3 的标点也取自 `markerRaw`。
            r.markerFrom = node.from;
            r.markerRaw = src.slice(node.from, node.to);
            if (栈顶 && 栈顶.ordered) 栈顶.items.push({ line: n, rec: r });
            return;
          }
          if (!格内 && name === 'TaskMarker') {
            const n = lineOf(node.from);
            let to = node.to;
            while (to < src.length && (src.charAt(to) === ' ' || src.charAt(to) === '\t')) to++;
            const 止 = Math.min(to, 行末(n));
            raw.push({ from: node.from, to: 止, prefix: 1 });
            // ⭐ `bugs/0111` K3：任务框并入同一行的列表标记层（约定：一个列表项只是一层）。
            添层(n, node.from, 止, true);
            const r = 列表行(n);
            r.kind = 'task';
            r.contentFrom = 止;
            r.checked = src.charAt(node.from + 1).toLowerCase() === 'x';
            // 方框用**真的 `<input type="checkbox">`** 画（与阅读态同一个元素 ⇒ 尺寸、
            // 基线、外边距天然一致），落在正文起点，⛔ 不参与扩展文档。
            tasks.push({ pos: 止, checked: r.checked });
            return;
          }
          if (!格内 && name === 'HardBreak') {
            // `\` 或行尾两空格 ＋ 换行：只藏**本行内**那一段。⛔ 不吞换行本身——
            // 跨行替换会让 `Decoration.replace` 抛错（整块白屏）。
            const n = lineOf(node.from);
            const to = Math.min(node.to, 行末(n));
            if (to > node.from) raw.push({ from: node.from, to: to });
            return;
          }
          // ⭐ 行内呈现（U4）先记：它不看围栏——围栏里压根没有这些节点
          //    （那一整段在树里是 `CodeText`）。
          const cls = INLINE_MARK[name];
          if (cls && node.to > node.from) inline.push({ from: node.from, to: node.to, cls: cls });
          // ⭐ 围栏行（U5）：**每一条**围栏行整行塌掉（`live.css` 的 `cm-rmd-fence`）。
          //    ⚠️ 只在 `CodeMark` 上记一次：`CodeInfo`（语言标记）与它在同一行。
          //    ⚠️ `design/0061` L1 起没有"活动行例外"（隐藏集合是源码的纯函数）。
          if (name === 'CodeMark') {
            const 父 = node.node && node.node.parent;
            if (父 && 父.name === 'FencedCode') {
              const n = lineOf(node.from);
              if (!fenceSeen[n]) {
                fenceSeen[n] = true;
                const 行末 = n + 1 < lineStarts.length ? lineStarts[n + 1] - 1 : src.length;
                fenceLines.push({ line: n, from: lineStarts[n], to: 行末 });
              }
            }
          }
          const h = HEADING_NODE.exec(name);
          if (h) {
            // ⭐ 格子里**没有块级标题**（`# 普通格子` 在 `<td>` 里就是这七个字）⇒ 不认。
            if (格内) return;
            // ⭐ 一级标题/Setext 可以**跨多行**（`a\nb\n===` 整个是一个 h1）⇒ 逐行都标标题尺度。
            const 首 = lineOf(node.from);
            const 末 = lineOf(Math.max(node.from, node.to - 1));
            for (let n = 首; n <= 末; n++) {
              if (headingLines[n]) continue;
              headingLines[n] = true;
              headings.push({ line: n, level: +h[1], from: lineStarts[n] });
            }
            // ⭐ 嵌在引用块 / 列表项里的标题（`bugs/0091`）：顶层的标题块由 host 搬外边距，
            //    内层的没有第二层宿主 ⇒ 登记下来，由 `createField` 贴"上/下留白"行级类。
            if (顶层块(node.node) !== name) {
              nestedHeadingRanges.push({ 首: 首, 末: 末, level: +h[1], inQuote: 在引用块里(node.node) });
            }
            return;
          }
          // ⭐ 代码块 / 原始 HTML 块占的**行号**（`bugs/0102`）：这些行的行首缩进是**内容**
          //    （列表项里贴一段 ``` 或四空格缩进的代码，缩进本身就是正文）⇒ 登记下来，
          //    下面藏续行缩进那一步跳过它们。
          if (name === 'FencedCode' || name === 'CodeBlock' || name === 'HTMLBlock') {
            const 块首 = lineOf(node.from);
            const 块末 = lineOf(Math.max(node.from, node.to - 1));
            for (let n = 块首; n <= 块末; n++) codeLines[n] = true;
            // ⭐ 嵌在引用块 / 列表项里的代码块（`bugs/0091`）：它的 mono / 字号 / 内边距 /
            //    底色在阅读态住 `pre` / `pre code` 上，顶层代码块由 host 类给；
            //    内层只能逐源码行贴类。顶层代码块**不登记**（否则会与 host 类叠两遍）。
            if (name !== 'HTMLBlock' && 顶层块(node.node) !== name) {
              nestedCodeRanges.push({ 首: 块首, 末: 块末 });
            }
          }
          if (name === 'FencedCode') {
            fenced = true;
            return;
          }
          // ⭐ Setext 的下划线行（`====` / `----`）：只藏字形还不够——那一行**仍有行盒**，
          //    编辑态会比阅读态高出一整行（`bugs/0089`）。把它纳入与围栏行同一条**塌高**路。
          if (!格内 && name === 'HeaderMark' && node.node && node.node.parent
              && /^SetextHeading[1-6]$/.test(node.node.parent.name)) {
            const n = lineOf(node.from);
            collapsedLines.push({ line: n, from: lineStarts[n], to: 行末(n) });
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
          // ⭐ 块前缀（`HeaderMark` / `QuoteMark`，含其后那一个空格）单独标记：
          //    `prefixRanges` 供落点判定（`bugs/0317`），⛔ 行内标记不带这个字段。
          //    ⚠️ 围栏里的 `>` 是**内容**（树里同样是 QuoteMark）⇒ 不算块前缀。
          // ⭐ `bugs/0304` 候选 ④（2026-11-12）：**行内代码**的反引号留在字符流里、只压成零宽。
          //    零宽替换会给它插一个 `cm-widgetBuffer` 零宽 `<img>`（U+FFFC 的替身），
          //    它参与 UAX#14 断行 ⇒「（」紧跟行内代码时编辑态折行点比阅读态差一个全角字。
          //    ⇒ 用 `zw: 1` 标出来，`build()` 把这些小区间从零宽替换里**拆出去**、
          //    改贴 `cm-rmd-zw`（字符仍在文本里，只是 `font-size: 0`）。
          //    ⚠️ 只标**行内**的 `CodeMark`：围栏 / 缩进代码块里的同名节点是围栏符或内容，
          //    仍走零宽替换（整行再由 `fenceLines` 塌掉），⛔ 别把它们放进 `zwRanges`。
          const 反引号父 = node.node && node.node.parent;
          const 行内反引号 = name === 'CodeMark'
            && !(反引号父 && (反引号父.name === 'FencedCode' || 反引号父.name === 'CodeBlock'));
          if ((name === 'HeaderMark' || name === 'QuoteMark') && !在块级容器里(node.node)) {
            raw.push({ from: from, to: to, prefix: 1 });
            // ⭐ `bugs/0111` K3：引用**每一层**各占一段（`> > 文` ⇒ `[0,2)`、`[2,4)`），
            //    标题标记一段。⛔ 这里不并入上一段——"退一层"要看清层与层的边界。
            添层(lineOf(from), from, to);
          } else if (行内反引号) {
            raw.push({ from: from, to: to, zw: 1 });
          } else {
            raw.push({ from: from, to: to });
          }
        },
        leave: function (node) {
          if (格内) return;
          const name = node.name;
          // ⚠️ 与 `enter` 里那条**同一个判据**（否则层数会漂，越编辑越错）。
          if (name === 'Blockquote' && !在块级容器里(node.node)) {
            if (引用层 > 0) 引用层 -= 1;
            return;
          }
          if (name !== 'BulletList' && name !== 'OrderedList') return;
          const 层 = listStack.pop();
          if (!层 || !层.ordered) return;
          // 有序列表的显示编号由**位置**决定（源码写 `1. 1. 1.` 渲染出来仍是 1/2/3），
          // ⛔ 不能照抄源码里的数字——阅读态用的是 comrak 算出来的序列号。
          const 起 = 层.items.length ? parseInt(层.items[0].rec.marker, 10) : NaN;
          const 基 = isFinite(起) ? 起 : 1;
          for (let i = 0; i < 层.items.length; i++) {
            const 号 = 基 + i;
            // ⭐⭐ 2026-11-14（`bugs/0116` §9）：**字形跟着层数走**（Notion 口径
            //    十进制 → 小写拉丁 → 小写罗马）。层数取 `lineLevel`——它在列表 enter
            //    时就按"这一行被几层列表覆盖"记好了，⛔ 不用 `rec.level`（那一份要等
            //    整个 `markers()` 收尾才回填，此刻还是建记录时的旧值）。
            层.items[i].rec.marker = 分级字形(号, lineLevel[层.items[i].line]) + '.';
            // ⭐ **唯一的编号来源**（`bugs/0111` A3）：渲染编号按位置算好之后就交给
            //    `input.js`（续行写"下一编号"），⛔ 别在那边再 parseInt 一遍。
            //    ⚠️ `number` 恒为**十进制数值**：源码要写的是 `3.`，不是 `c.`。
            层.items[i].rec.number = 号;
          }
        },
      });
    }

    // ⚠️ 这里**曾经**是 `bugs/0021` / `bugs/0307` 立的「列表段距」emulation：把松列表里
    //    每段的下外边距折成 `cm-rmd-li-gap-after`（`padding-bottom`）/ `cm-rmd-li-sep`
    //    （行高 = 段距）/ `cm-rmd-collapsed`（0 高）三族行装饰。`design/0066`
    //    （2026-11-11 用户裁定「松散不存在，空行照排」）之后**整段作废**：
    //    列表内的空行回到正常行高，阅读态的段距由 `typography.css` 里
    //    `.doc li > p { margin: 0 }` 撤掉、空行高度由 `render.rs::写空行属性`
    //    的 `--rmd-blanks` 给出。⛔ 别再往这里补"编辑态模拟段距"的代码。
    // ⭐ 续行补深度（`bugs/0092`）：条目里第二行起的源码行没有 `ListMark`，但同样要缩进。
    //    ⚠️ 单元格里不产列表（`格内` 时 `lineDepth` 恒空），这段天然不生效。
    // ⭐⭐ 2026-11-05（`bugs/0102`）：**续行的行首缩进也是标记**，一并藏掉。
    //    阅读态里列表项的续行由 `<li>` 的内容列决定起点（HTML 在行首把空白折叠掉），
    //    而编辑态是 `white-space: pre-wrap`，源码里那两个空格照原样占宽度
    //    ⇒ 点进编辑态后，条目的续行**整体右移 7 px**（14 px 正文、两个空格实测值），
    //    用户看到的就是「点击之后，整段还是有明显的变化」。
    //    ⚠️ 只藏**行首到第一个非空白**这一段（⛔ 不吞整行）；代码块里的行跳过（缩进是内容）。
    for (const k in lineDepth) {
      const n = +k;
      const r = listSeen[n];
      if (r) { r.depth = lineDepth[n]; r.level = lineLevel[n] || 0; continue; }
      // 续行（没有 `ListMark` 的那些行）：同样是一条列表行，深度照给（嵌套缩进靠它）。
      const rec = 列表行(n);
      if (codeLines[n]) { rec.code = true; continue; }
      const 首 = lineStarts[n];
      const 尾 = 行末(n);
      let i = 首;
      while (i < 尾 && (src.charAt(i) === ' ' || src.charAt(i) === '\t')) i++;
      if (i > 首 && i < 尾) {
        raw.push({ from: 首, to: i, prefix: 1 });
        // ⭐ `bugs/0111` K3：续行的行首缩进自成一层（`  - 甲` 的续行同理）。
        添层(n, 首, i);
        rec.contentFrom = i;
      }
    }

    // ⭐⭐ 2026-11-08（`bugs/0090`）：引用块里的空行在阅读态是**段距**，不是一整行。
    //    `> 第一段\n>\n> 第二段` 实测：阅读态两段之间 = 行高 20.3 ＋ 段距 15.4；
    //    编辑态两行之间 = 空行本身 20.297 ×2 ⇒ 每条空引用行高 **+4.906 px**（方向是变高）。
    //    ⇒ 夹在内容之间的空引用行给 `cm-rmd-quote-gap`（行高 ＝ `--reader-gap-block`）。
    //    · 连续多条：阅读态的段距只出现一次 ⇒ 只有**第一条**承载，其余塌成 0 高；
    //    · 开头 / 结尾的空引用行：阅读态里根本没有这一行 ⇒ 也塌成 0 高。
    //    ⚠️ 判据来自**树里的 QuoteMark** ＋ 行内容，⛔ 不是只看行首字符：
    //       围栏内部的 `>` 是代码内容（`> let x = 1;` 在树里也有 QuoteMark）。
    const quoteBlank = {};
    const quoteBlankNos = [];
    for (const k in quoteMarkLines) {
      const n = +k;
      if (codeLines[n]) continue;
      const 行 = src.slice(lineStarts[n], 行末(n));
      if (行.replace(QUOTE, '').trim() !== '') continue;
      quoteBlank[n] = true;
      quoteBlankNos.push(n);
    }
    // ⚠️ **最后一条真实行**：源码以 `\n` 结尾时 `lineStarts` 会多出一个幻影行，
    //    它不是内容 ⇒ "后面还有内容"的判据必须排除它（否则结尾的空引用行 / 标题
    //    会被误判成"夹在中间"，平白多出段距或下留白）。
    const 末行号 = src.length > 0 && src.charCodeAt(src.length - 1) === 10
      ? lineStarts.length - 2 : lineStarts.length - 1;
    quoteBlankNos.sort(function (a, b) { return a - b; });
    const quoteGapLines = [];
    let qi = 0;
    while (qi < quoteBlankNos.length) {
      let qj = qi;
      while (qj + 1 < quoteBlankNos.length && quoteBlankNos[qj + 1] === quoteBlankNos[qj] + 1) qj++;
      const 首 = quoteBlankNos[qi];
      const 末 = quoteBlankNos[qj];
      // 前 / 后都有内容 ⇒ 它是段落分隔；否则阅读态不存在这一行（开头 / 结尾）。
      const 有前 = 首 > 0 && quoteBlank[首 - 1] !== true;
      const 有后 = 末 < 末行号 && quoteBlank[末 + 1] !== true;
      // ⭐⭐ `design/0085` C3（`bugs/0318`）：**两侧都是列表行**的空行不是段距。
      //    阅读态里这一格是列表项之间的空行（`li[data-blanks]`），高度 ＝ **该处正文行高**；
      //    编辑态若照样按段距（`--reader-gap-block` ⇒ 15.4px）排，进出编辑就跳 8.4px。
      //    ⇒ 这一族走**普通行盒**：行高由引用语境继承（`--reader-quote-lh` ⇒ 20.3px，
      //      与阅读态同一档），⛔ 既不挂 `cm-rmd-quote-gap`，也⛔ 不塌成 0 高。
      //    ⚠️ 判据是**邻居在不在 `listSeen` 里**（续行也算），⛔ 不是"行里有 `- `"：
      //       围栏里的 `- ` 是代码内容，而续行没有标记但仍然是列表项的一部分。
      const 两侧列表 = 有前 && 有后
        && listSeen[首 - 1] !== undefined && listSeen[末 + 1] !== undefined;
      if (有前 && 有后 && !两侧列表) {
        quoteGapLines.push({ line: 首, from: lineStarts[首], to: 行末(首) });
        for (let n = 首 + 1; n <= 末; n++) {
          collapsedLines.push({ line: n, from: lineStarts[n], to: 行末(n) });
        }
      } else if (!两侧列表) {
        for (let n = 首; n <= 末; n++) {
          collapsedLines.push({ line: n, from: lineStarts[n], to: 行末(n) });
        }
      }
      qi = qj + 1;
    }

    // ⭐⭐ `design/0085` C4：**行级要补几层引用盒**。
    //    行处在第 `层` 层引用里；宿主已经搬了最外层那一份（`宿主搬了`）⇒ 行级补 `层 - 1`。
    //    ⚠️ 同一行可能被多层范围覆盖（`> > q`）⇒ 取**最大**层数。
    //    ⚠️ 围栏行由 block widget 顶替（没有 `.cm-line`）/ 塌成 0 高 ⇒ 跳过。
    const 行引用层 = {};
    const 行宿主搬了 = {};
    引用范围.forEach(function (r) {
      const 首行 = lineOf(r.from);
      const 末行 = lineOf(Math.max(r.from, r.to - 1));
      for (let n = 首行; n <= 末行; n++) {
        if (!(行引用层[n] >= r.层)) 行引用层[n] = r.层;
        if (r.宿主搬了 === true) 行宿主搬了[n] = true;
      }
    });
    const quoteDepths = [];
    Object.keys(行引用层).map(Number).sort(function (a, b) { return a - b; })
      .forEach(function (n) {
        if (fenceSeen[n] === true) return;
        const 补 = 行引用层[n] - (行宿主搬了[n] === true ? 1 : 0);
        if (补 <= 0) return;
        // ⚠️ 层数上限 3（`live.css` 只有 1/2/3 三条规则）：更深的引用在编辑态显示 3 层竖线。
        //    阅读态是逐层内边距，行级盒子表达不了"任意多层"而不引入第二份常数表。
        quoteDepths.push({ line: n, from: lineStarts[n], qdepth: Math.min(补, 3) });
      });

    // ⭐⭐ `bugs/0111` A1/A2：**引用行**的块前缀数据（纯数据，喂 `input.js::lineBreakAction`）。
    //    · `contentFrom` = 该行**所有** QuoteMark（含 `> > ` 多层）＋其后空白之后的第一个
    //      非空白位置；`> > foo` 因此是 4，不是 2。
    //    · `from` = `markerFrom` = 行首：删除 / 续写都以整条前缀链为单位（⛔ 不劈开）。
    //    · `blank` = 前缀之后到行末全是空白 ⇒ 回车应当**退出引用**（⛔ 不产 `> > `）。
    //    ⚠️ 围栏里的 `>` 是内容（`bugs/0090` 同一条判据）⇒ `codeLines` 跳过。
    const quoteLines = [];
    const quoteNos = Object.keys(quoteMarkLines).map(Number)
      .sort(function (a, b) { return a - b; });
    for (let zi = 0; zi < quoteNos.length; zi++) {
      const n = quoteNos[zi];
      if (codeLines[n]) continue;
      const 首 = lineStarts[n];
      const 末 = 行末(n);
      let 止 = typeof quoteMarkEnd[n] === 'number' ? quoteMarkEnd[n] : 首;
      while (止 < 末 && (src.charAt(止) === ' ' || src.charAt(止) === '\t')) 止++;
      quoteLines.push({
        line: n, from: 首, markerFrom: 首, contentFrom: 止,
        blank: src.slice(止, 末).trim() === '',
      });
    }

    // ⭐⭐ 2026-11-08（`bugs/0091`）：嵌在引用块 / 列表项里的**标题**。
    //    阅读态 `.doc hN` 的上下外边距是 `系数 × 该级字号`；编辑态只有行级类
    //    `cm-rmd-hN`（字号 / 行高 / 字重），**没有**外边距 ⇒ 首行文字上跳（实测 11.859 px）。
    //    ⇒ 给首 / 末行贴"留白"行级类；CSS 用 `1em`（就是 `cm-rmd-hN` 给这一行设的字号）
    //    乘同一个系数 ⇒ 仍是同一批 token，⛔ 没有第二份数值。
    //    ⚠️ 紧邻空引用行的一侧**不再补**：那个空行已经承载了段距，补了就双份。
    //    ⚠️ 紧邻另一个标题的一侧由**前一个标题的下留白**承担（外边距会折叠），
    //       所以"上方"在上一行也是标题时跳过。
    //    ⚠️ 块的最后一行不补下留白：阅读态 `.doc blockquote > :last-child` 把它去掉了。
    const collapsedSet = {};
    collapsedLines.forEach(function (c) { collapsedSet[c.line] = true; });
    const nestedHeadingSpaces = [];
    nestedHeadingRanges.forEach(function (r) {
      // Setext 的下划线行已经塌成 0 高 ⇒ 留白只落在真正的标题文字行上。
      const 实 = [];
      for (let n = r.首; n <= r.末; n++) if (collapsedSet[n] !== true) 实.push(n);
      if (!实.length) return;
      const 首 = 实[0];
      const 末 = 实[实.length - 1];
      // ⚠️ 标题是块的第一行时也要补：引用块有 `padding`，阅读态的 `margin-top`
      //    **折不出去**（实测首行文字上跳 11.859 px 的就是这种形态）。
      //    顶层列表项里则相反（外边距穿过 li/ul 折到列表外，不在被替换元素的 border box 里）
      //    ⇒ 只有 `inQuote` 才补。
      const 上一行 = 首 > 0 ? 首 - 1 : -1;
      const 补上 = 上一行 >= 0
        ? (quoteBlank[上一行] !== true && headingLines[上一行] !== true)
        : r.inQuote === true;
      if (补上) {
        nestedHeadingSpaces.push({ line: 首, from: lineStarts[首], where: 'before' });
      }
      if (末 < 末行号 && quoteBlank[末 + 1] !== true) {
        nestedHeadingSpaces.push({ line: 末, from: lineStarts[末], where: 'after' });
      }
    });

    // ⭐⭐ 2026-11-08（`bugs/0091`）：嵌在引用块 / 列表项里的**代码块**。
    //    阅读态的 mono / 字号 / 行高住在 `.doc pre code`，底色 / 圆角 / 横滚住在 `pre`
    //    ⇒ 顶层代码块由 host 类（`.cm-rmd-code`）给，内层没有第二层宿主。
    //    这里逐**内容行**登记：围栏行已由 `cm-rmd-fence` 塌成 0 高（阅读态里不存在），
    //    ⛔ 不贴代码行类；`pre code` 的上下内边距是**整块一份** ⇒ 只落在首 / 末内容行。
    const nestedCodeLines = [];
    nestedCodeRanges.forEach(function (r) {
      const 内容 = [];
      for (let n = r.首; n <= r.末; n++) if (fenceSeen[n] !== true) 内容.push(n);
      for (let i = 0; i < 内容.length; i++) {
        nestedCodeLines.push({
          line: 内容[i], from: lineStarts[内容[i]],
          first: i === 0, last: i === 内容.length - 1,
        });
      }
    });
    nestedCodeLines.sort(function (a, b) { return a.line - b.line; });

    // ⭐ 有序 ＋ 合并**相邻**区间：`](url)` 在树里是 4 个挨着的节点（`LinkMark`/`URL`/…），
    //    不合并的话零宽替换之间会插一串 widget buffer，行高可能被推高
    //    （`live.css` 的 `.cm-widgetBuffer{font-size:0}` 只是兜底，⛔ 不该靠它）。
    raw.sort(function (a, b) {
      return a.from - b.from || a.to - b.to;
    });
    // ⭐⭐ `bugs/0317`：落点判定要看到"**相邻但不同**"的区间（隐藏反引号与紧挨着它的
    //    区间各自成段），而 `ranges` 只服务装饰层（相邻 / 重叠一律合并，合并后就没有边界了）。
    //    ⇒ 在合并**之前**留两份：`rawRanges`（按 `from` 排序、**只去重不合并**）与
    //    `prefixRanges`（只收块前缀，合并相邻即可）。
    //    ⛔ 不动下面 `ranges` 的既有合并语义（它是装饰层的唯一输入）。
    const rawSorted = raw.slice().sort(function (a, b) {
      return a.from - b.from || a.to - b.to;
    });
    /** @param {{from:number, to:number}} r */
    function 区间合法(r) {
      return r.to > r.from && r.from >= 0 && r.to <= src.length;
    }
    /** @type {Array<{from:number, to:number}>} */
    const rawRanges = [];
    for (let i = 0; i < rawSorted.length; i++) {
      const r = rawSorted[i];
      if (!区间合法(r)) continue;
      const last = rawRanges[rawRanges.length - 1];
      if (last && last.from === r.from && last.to === r.to) continue;
      rawRanges.push({ from: r.from, to: r.to });
    }
    /**
     * ⭐ `bugs/0304` 候选 ④：**行内代码反引号**的区间（`raw` 里 `zw: 1` 的那一批）。
     * 与 `rawRanges` 同风格：按 `from` 排序、只去重（完全相同）**不合并**
     * ⇒ `build()` 能把每一个反引号单独拆成 `cm-rmd-zw` 的 mark 装饰。
     * ⚠️ 这些区间**同时仍在 `ranges` 里**（落点 / 删除层的隐藏集合必须保持原样），
     *    ⛔ 别在这里把它们从隐藏集合中摘掉。
     * @type {Array<{from:number, to:number}>}
     */
    const zwRanges = [];
    for (let i = 0; i < rawSorted.length; i++) {
      const r = rawSorted[i];
      if (r.zw !== 1 || !区间合法(r)) continue;
      const last = zwRanges[zwRanges.length - 1];
      if (last && last.from === r.from && last.to === r.to) continue;
      zwRanges.push({ from: r.from, to: r.to });
    }
    /**
     * 块前缀：列表标记 / 任务框 / 引用 / 标题（各含其后空白）+ 续行行首缩进。
     * @type {Array<{from:number, to:number}>}
     */
    const prefixRanges = [];
    for (let i = 0; i < rawSorted.length; i++) {
      const r = rawSorted[i];
      if (r.prefix !== 1 || !区间合法(r)) continue;
      const last = prefixRanges[prefixRanges.length - 1];
      if (last && r.from <= last.to) {
        if (r.to > last.to) last.to = r.to;
      } else {
        prefixRanges.push({ from: r.from, to: r.to });
      }
    }
    // ⭐⭐ `bugs/0111` K3：`prefixLevels` 的**第三份视图**——只排序，⛔ 不合并相邻层。
    //    构建顺序是"树遍历 + 续行补扫"，跨行不保证有序 ⇒ 这里统一按 `(from, to)` 排一次；
    //    层与层的不重叠由 `添层` 在构建时按行夹取保证。
    prefixLevels.sort(function (a, b) { return a.from - b.from || a.to - b.to; });

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
    listLines.sort(function (a, b) { return a.line - b.line; });
    return { ranges: clean, fenced: fenced, headings: headings, bodies: bodies, inline: inline,
      fenceLines: fenceLines, collapsedLines: collapsedLines, listLines: listLines, tasks: tasks,
      quoteGapLines: quoteGapLines, nestedCodeLines: nestedCodeLines,
      nestedHeadingSpaces: nestedHeadingSpaces,
      // ⭐ `design/0085` C4：行级要补的引用盒层数（第二层起）。
      quoteDepths: quoteDepths,
      // ⭐ `bugs/0317`：合并前的两份区间视图（`rawRanges` 只去重；`prefixRanges` 只含块前缀）。
      rawRanges: rawRanges, prefixRanges: prefixRanges,
      // ⭐ `bugs/0111` K3：块前缀的**分层**视图（不合并；一次退格只退一层）。
      prefixLevels: prefixLevels,
      // ⭐ `bugs/0304` 候选 ④：行内代码反引号的区间（`build()` 把它们从零宽替换里拆出去）。
      zwRanges: zwRanges,
      // ⭐ `bugs/0111` A1：引用行的块前缀数据（`> foo` / `> > foo` / 空引用行）。
      quoteLines: quoteLines,
      // ⭐ `bugs/0315`：有序编号的合法上界（CommonMark：10 位不是列表标记）。
      maxOrdered: MAX_ORDERED,
      // ⭐ `bugs/0311`：代码块 / HTML 块占的**行号**（0-based）。`input.js::headingSpaceInsert`
      //    用它排除"围栏里的 `###` 是内容"那一族；⚠️ 这里只是把上面已经算好的那份登记交出去，
      //    ⛔ 不是第二套判据（`bugs/0102` 的那份就是它）。
      codeLines: codeLines };
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
   * @param {{activeLineIndexes?:(state) => number[], bodyLines?:boolean|(() => boolean),
   *   cellContext?:boolean, listHost?:boolean, onPlan?:(plan:object) => void}} hooks
   *   ⚠️ `activeLineIndexes` **已废弃且被忽略**（`design/0061` L1）：它只作为类型兼容保留，
   *   因为 `tests/js/live-inline.test.js` 仍按旧契约传它。产品路径（`main.js`）⛔ 不再传；
   *   隐藏集合是源码的纯函数。`bodyLines` 说"这一块原来的品种是标题"
   *   （`live/box.js::headingLevelOf`）——那时非标题行要回落成正文尺度；
   *   `listHost` 说"宿主元素是不是 `<ul>` / `<ol>`"（`bugs/0305`）——`false` 时顶层列表的
   *   行级深度从 1 起（宿主是段落 / 标题，没人搬 `<ul>` 那条 `padding-left`）；
   *   `cellContext` 说"这是一格里切出来的文本"（`design/0049`）——只按行内语义呈现，
   *   ⛔ 不认标题/引用/围栏（GFM 的格子内只有行内语义）；
   *   `onPlan` 把每次重算出的 `markers()` 结果交给调用方（`main.js` 用它给落点/删除层
   *   提供**同一份**隐藏区间，⛔ 不重算第二遍）。
   * @returns {Array} `[StateField, FacetProvider]`
   */
  /**
   * ⭐ `bugs/0321`（2026-11-14 用户报告「编辑的时候 List Item 是圆点，编辑完展示的时候…不一样了」）：
   * **无序列表圆点的形状**，复刻阅读态的 **UA 级联**——
   * 一级 `disc`（实心圆）、二级 `circle`（空心圆环）、三级及更深 `square`（实心方）。
   *
   * ⚠️ 判据只有一条：**阅读态是谁画的，编辑态就得画成同一个形状**。阅读态是浏览器对
   *    `<ul>` 嵌套套用 UA 样式表（`ul ul` ⇒ circle、`ul ul ul` ⇒ square，更深的 `ul`
   *    仍命中第三条 ⇒ 一直是方）。**无序列表**的 `list-style-type` 本仓**没有覆盖**
   *    （`typography.css` 明文：⛔ 不覆盖，渲染层要忠实）⇒ 这把尺子的定义不在本仓，
   *    它的取值就是那张表。⚠️ 2026-11-14 起**有序列表**那一份被覆盖了（Notion 分级字形，
   *    见下面的 `分级字形`），那不影响本条：`ul` 的形状仍是 UA 给的。
   * ⚠️ 这里收的是**层数**（最外层 0），⛔ 不是 `depth`——后者含"宿主搬没搬 `<ul>` 的
   *    `padding-left`"那一段补位（`live/geometry.js`），与形状无关。
   *
   * @param {number|undefined} level 嵌套层数（最外层 0）
   * @returns {'disc'|'circle'|'square'}
   */
  function 圆点形状(level) {
    const 层 = typeof level === 'number' && isFinite(level) ? Math.floor(level) : 0;
    if (层 <= 0) return 'disc';
    return 层 === 1 ? 'circle' : 'square';
  }

  /** 分级字形的**层数上限**：超过它就按最内层那一档算（阅读态那张 `list-style-type` 表
   *  只列到第 11 层，⛔ 两边必须同一个上限，否则深到荒谬的地方两边会各画一个字形）。
   *  ⚠️ 为什么是 11：每层一个 `--reader-list-indent`(2em)，12 层就是 24em（14 px 下 336 px）
   *   —— 再深的列表在任何正文宽度下都已经被挤到不可读。 */
  const 级上限 = 11;

  /**
   * ⭐⭐ 2026-11-14（`bugs/0116` §9）：有序列表的**分级字形**，复刻 Notion ——
   * 十进制 → 小写拉丁 → 小写罗马，三层一循环。
   *
   * 用户原话：「复刻 Notion 的时候，未注意到一点，有序列表 1.2.3.4 的下一级是 a. b. c. d.」
   * ⇒ 不只是"下一级"，整条链是 `1.` / `a.` / `i.` / 回到 `1.`。
   *
   * ⚠️ 阅读态那张表在 `typography.css`（`.doc :is(ol, ul) … ol` 的 `list-style-type`），
   *    ⛔ 不是这里算完之后再写进 HTML——渲染层只负责忠实输出 `<ol>`，字形是样式层的事。
   *    ⇒ **同一个循环被写在两个语言里**：改这里的 `级 % 3` 或那边的表，必须同批改另一边；
   *    `tests/js/live-list-marker.test.js` 有一条判据把两张表逐档比对（含变异）。
   * ⚠️ 层数口径与 `圆点形状` 同一个（`listStack.length`，最外层 0，**任何**列表都算一层），
   *    与 `list-style-type` 的 `:is(ol, ul)` 祖先计数同构。
   *
   * @param {number} number 渲染编号（`基 + i`，由位置算出，⛔ 不是源码里那个数字）
   * @param {number|undefined} level 嵌套层数（最外层 0）
   * @returns {string} 字形（⛔ 不含标点；标点由调用方补 `.`）
   */
  function 分级字形(number, level) {
    const n = typeof number === 'number' && isFinite(number) ? Math.trunc(number) : 1;
    const 原层 = typeof level === 'number' && isFinite(level) ? Math.floor(level) : 0;
    const 层 = Math.min(Math.max(原层, 0), 级上限);
    const 位 = 层 % 3;
    if (位 === 1) return 拉丁字形(n);
    if (位 === 2) return 罗马字形(n);
    return String(n);
  }

  /** 小写拉丁序号（1→a、26→z、27→aa）：CSS `lower-alpha` 的双射 26 进制。 */
  function 拉丁字形(n) {
    // ⚠️ 非正数 / 非有限值：CSS 那边会退回十进制（`lower-alpha` 对 0 输出 "0"），
    //    这里同口径，⛔ 别造一个 a 前面还有空位的怪字形。
    if (!(n >= 1)) return String(n);
    let s = '';
    let m = n;
    while (m > 0) {
      const r = (m - 1) % 26;
      s = String.fromCharCode(97 + r) + s;
      m = Math.floor((m - 1) / 26);
    }
    return s;
  }

  /** 小写罗马序号（1→i、4→iv、1994→mcmxciv）；超出 1–3999 时 CSS 退回十进制。 */
  function 罗马字形(n) {
    if (!(n >= 1) || n > 3999) return String(n);
    /** @type {Array<[number, string]>} */
    const 表 = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
      [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let s = '';
    let m = n;
    for (let i = 0; i < 表.length; i++) {
      while (m >= 表[i][0]) { s += 表[i][1]; m -= 表[i][0]; }
    }
    return s;
  }

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
    // ⭐ 嵌套引用的第二层起（`design/0085` C4）：只挂 `data-rmd-qdepth`，几何全在 `live.css`。
    //    ⚠️⛔ 不许改写成行内 `style`：列表行已经用行内 `margin-left` 写缩进，两条行级装饰的
    //    `style` 属性会**互相覆盖**（CM6 合并同一行的属性时后者整串替换前者）⇒ 缩进当场丢。
    const quoteDecos = {};
    function quoteDeco(层) {
      const n = Math.max(1, Math.min(3, typeof 层 === 'number' ? 层 : 1));
      if (!quoteDecos[n]) {
        quoteDecos[n] = CM6.Decoration.line({ attributes: { 'data-rmd-qdepth': String(n) } });
      }
      return quoteDecos[n];
    }
    // ⚠️ 行内那五条同理：`Decoration.mark` 的 spec 只有 `class`，按类名缓存一份就够
    //    （CM6 的 spec 是不可变对象，重复 `mark()` 会让每次重算都造一批新对象）。
    const markDecos = {};
    function markDeco(cls) {
      if (!markDecos[cls]) markDecos[cls] = CM6.Decoration.mark({ class: cls });
      return markDecos[cls];
    }
    // ⭐ 列表行（`bugs/0092`）：类名固定、深度与品种在行内属性上，按「深度｜品种｜编号」缓存。
    //    ⭐⭐ 2026-11-15（`design/0084`）：缩进写在 **`margin-left`** 上，标记交给 UA 的 `::marker`
    //    （行 `display: list-item`，见 `live.css`）⇒ 两态的标记由**同一段代码**算出来，
    //    ⛔ 不再有任何手绘 `::before` 与拟合常数（历史见 `bugs/0101` / `0112` B2-m / B2-m-5）。
    //    ⚠️ 缩进⛔ 不能写在行 `padding-left` 上：`::marker` 按**边框盒**定位，
    //    写在项自身的 padding 上时标记整体左移一个缩进（离屏实测 64 设备 px，`bugs/0113` §8）。
    //    ⚠️ 缩进量仍来自 `--reader-list-indent`（与阅读态 `.doc ul` 同一个变量，`INV-LIVE-07`）。
    const listDecos = {};
    function listDeco(li) {
      const key = li.depth + '|' + li.kind + '|' + (li.marker || '') + '|' + (li.level || 0)
        + '|' + (li.number || 0);
      if (listDecos[key]) return listDecos[key];
      // ⭐ `design/0065` P1：缩进值来自 `live/geometry.js`（`listGeometryAt` 是
      //    "深度已定"那一段 ⇒ 与上面 `记深度` 用的是同一套映射，⛔ 不是第二套公式）。
      const 几何 = 列表几何At(li.depth);
      const attrs = /** @type {Object<string, string>} */ ({
        style: 'margin-left: ' + 几何.marginLeft,
        'data-rmd-li': li.kind,
      });
      /** @type {number} */
      let 层 = 0;
      if (typeof li.level === 'number' && isFinite(li.level)) 层 = Math.max(0, Math.floor(li.level));
      if (li.kind === 'bullet' || li.kind === 'ordered') {
        // ⚠️ `data-rmd-li` 只是给 `live.css` 开 `display: list-item` 的口子；字形按**层数**给，
        //    与阅读态 `typography.css` 的两张表同词汇（`INV-TYPE-08`，⛔ 别在这边自创形状）。
        if (li.kind === 'ordered') {
          // ⭐ 编号取 `markers()` 算好的**渲染编号**（`rec.number`，恒为十进制），
          //    ⛔ 不是源码里那个数字：源码写 `1. 1. 1.` 渲染出来仍是 1/2/3。
          //    `counter-reset: N-1` ＋ `counter-increment` ⇒ UA 的 `::marker` 显示 N。
          const 号 = typeof li.number === 'number' && isFinite(li.number) ? li.number : 1;
          attrs.style += '; counter-reset: list-item ' + (号 - 1)
            + '; counter-increment: list-item';
          attrs['data-rmd-li-level'] = String(Math.min(层, 级上限));
        } else {
          // ⭐ `bugs/0321`：形状按**层数**给（阅读态是 UA 级联画的：一级实心圆、二级空心圆、
          //    三级及更深实心方），⛔ 不是一律实心圆。夹到 2 是因为再深也还是方。
          attrs['data-rmd-li-level'] = String(Math.min(层, 2));
        }
      }
      listDecos[key] = CM6.Decoration.line({ class: 'cm-rmd-li', attributes: attrs });
      return listDecos[key];
    }
    /**
     * ⭐ **编辑态方框的 DOM**：`<span class="cm-rmd-taskbox-wrap"><input class="cm-rmd-taskbox"> </span>`。
     *
     * ⚠️⚠️ **后面那个字面空格不是装饰，是排版**（`bugs/0106`，2026-11-06 用户实测
     * 「todo 格式 打勾前和打勾后格式还是有变动，Mardo 可以做点一点不动，只是多了一个勾」）：
     * comrak 在阅读态**无条件**写出 `disabled="" /> `（`html.rs` 的 `write_str(" disabled=\"\" /> ")`
     * ——那个空格与源码里有几个空格无关），而编辑态把 `- [x] ` 连同它的尾随空格一起藏掉了
     * ⇒ 编辑态正文比阅读态**左 4 px**（离屏实测正文左缘 327 vs 331，方框盒两边都是 311/12×12）。
     * 打勾要退出编辑态（`doToggleTask` 第 ① 步），于是点一下方框整块文字就横跳 4 px，
     * 长行还可能因此换行点不同（等高校验报过这一族 ±23.8 px）。
     * ⇒ 让 widget **自带同一个空格**，两态的排版由同一个字符产生。
     * ⛔ **不要**改成"给 margin 再加一个数"：那是第二份盒子，字号/字体一变就对不上。
     *
     * ⚠️ 空格必须排在 `<input>` **之后**：行首的连续空白会被折叠掉，排前面等于没有。
     * ⚠️ 外层 `span` 只负责装这两样，⛔ 不给它任何尺寸样式（盒子仍由 `<input>` 给）。
     *
     * @param {boolean} checked
     * @returns {object}
     */
    function taskBoxDom(checked) {
      const wrap = document.createElement('span');
      wrap.className = 'cm-rmd-taskbox-wrap';
      wrap.setAttribute('aria-hidden', 'true');
      wrap.setAttribute('contenteditable', 'false');
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.className = 'cm-rmd-taskbox';
      el.checked = checked === true;
      el.tabIndex = -1;
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('contenteditable', 'false');
      wrap.appendChild(el);
      wrap.appendChild(document.createTextNode(' '));
      return wrap;
    }

    /**
     * 任务框 widget：**真的 `<input type="checkbox">`**。用同一个元素是为了让尺寸、基线、
     * 外边距与阅读态的 `.doc li.task-list-item input[type=checkbox]` 天然一致 ——
     * 另画一个 `span` 就等于第二份盒子数值（`INV-LIVE-07`）。
     * ⭐ 它**可交互**（`pointer-events: auto`，`bugs/0103`）：Mardo 在编辑态点方框就是打勾。
     * 接线在 `main.js::onHostTaskBoxDown/Click`（`#doc` capture），⛔ 不在 widget 里另挂监听。
     * ⚠️ DOM 由 `taskBoxDom()` 造：方框 ＋ **一个空格**（`bugs/0106`，两态排版同一个来源）。
     *
     * ⚠️⚠️ **必须是 `CM6.WidgetType` 的真子类**（2026-11-05 探针实测）：
     *    CM6 的 `WidgetView.coordsAt()` 会直接调 `this.widget.coordsAt(dom,pos,side)`
     *    （`src/vendor/cm6.bundle.js:5687`），`compare()` 也走原型。给一个**普通对象**，
     *    任务列表块第一次测量就抛 `this.widget.coordsAt is not a function` ⇒ 视图拆不掉、
     *    `end_edit` 不还授权（`B7-8 begin_edit +1 / end_edit +0`），随后每一块都级联失败。
     *    ⛔ 别再加 `coordsAt` 之类的"补丁方法"绕过去——继承 `WidgetType` 才有默认实现
     *    （`coordsAt → null`、`destroy`、`ignoreEvent → true`、`estimatedHeight → -1`）。
     *    ⚠️ 纯逻辑判据用的假 CM6 没有 `WidgetType` ⇒ 那时退回旧的对象形状（不进真视图）。
     */
    const TaskBoxWidget = typeof CM6.WidgetType === 'function'
      ? class extends CM6.WidgetType {
        /** @param {boolean} checked */
        constructor(checked) {
          super();
          /** @type {boolean} */
          this.checked = checked === true;
        }
        /** @param {object} other @returns {boolean} */
        eq(other) {
          return !!other && other.checked === this.checked;
        }
        /** @returns {object} */
        toDOM() {
          return taskBoxDom(this.checked);
        }
      }
      : null;
    function taskWidget(checked) {
      if (TaskBoxWidget) return new TaskBoxWidget(checked);
      return {
        checked: checked,
        toDOM: function () {
          return taskBoxDom(checked === true);
        },
        eq: function (other) { return !!(other && other.checked === checked); },
        ignoreEvent: function () { return true; },
      };
    }

    /**
     * ⭐ **围栏行的 block widget**（`bugs/0298` 候选 1b，2026-11-12）。
     *
     * 问题：围栏行靠行级类 `cm-rmd-fence` ＋ CSS 塌成 0 高，但**那只影响 DOM**，
     * ⛔ 不进 CM6 的 `HeightMap`。视口外的行由 `HeightOracle.heightForLine` 按
     * "至少一整行"估算 ⇒ 高过一屏的块点进编辑态后，块外的围栏行在高度表里仍记一整行
     * （实测整块长高 **+20.141 px**，正好是一行）。
     *
     * 修法：把围栏行改成 `Decoration.replace({ block: true, widget })`，widget 的
     * `estimatedHeight` 返回 **0**。`DocView.updateHeight` 的 `point()` 对带 widget 的
     * 替换装饰走另一条记账（`let height = deco.widget ? deco.widget.estimatedHeight : 0`，
     * 只有 `-1` 才回落到 `lineHeight`）⇒ 视口外也记 0，绕开 `heightForLine` 的
     * "下限一整行"。这是标准 `Decoration` / `WidgetType` API：⛔ 不碰 `viewState.heightMap`
     * 之类的内部字段、⛔ 不 fork bundle。
     *
     * ⚠️ **block replace 的区间恰好是整行**（`f.from` 行首 → `f.to` 行末，不含 `\n`）：
     *    `plan.fenceLines` 本来就是这个口径，换行由 CM6 自己收成 tile 的 `breakAfter`，
     *    ⛔ 不许把 `\n` 吞进替换区间。
     * ⚠️ block widget 落下之后**那一行不再有 `.cm-line`**，所以同一行⛔ 不能再贴行级装饰
     *    （见 `build()` 里的 `行级类跳过围栏行`）。DOM 侧由 `live.css` 的
     *    `.cm-rmd-fence-block` 压成 0 高。
     * ⚠️ 与任务框 widget 同一条纪律（`bugs/0092`）：必须是 `CM6.WidgetType` 的**真子类**
     *    （`coordsAt` / `compare` 走原型）。纯逻辑判据用的假 CM6 没有 `WidgetType`
     *    ⇒ 那时退回旧的 `cm-rmd-fence` 行级类（可见降级，不进真视图）。
     */
    const FenceLineWidget = typeof CM6.WidgetType === 'function'
      ? class extends CM6.WidgetType {
        /** @returns {number} */
        get estimatedHeight() { return 0; }
        /** @param {object} other @returns {boolean} */
        eq(other) {
          return !!other && other.estimatedHeight === 0;
        }
        /** @returns {object} */
        toDOM() {
          const el = document.createElement('div');
          el.className = 'cm-rmd-fence-block';
          return el;
        }
        /** @returns {boolean} */
        ignoreEvent() { return true; }
      }
      : null;
    /** 围栏行的 block 替换装饰（spec 不可变，整个 field 共用一份）。 */
    const fenceHide = FenceLineWidget && typeof CM6.Decoration.replace === 'function'
      ? CM6.Decoration.replace({ block: true, widget: new FenceLineWidget() })
      : null;

    const build = function (state, 预算) {
      const text = state.doc.toString();
      const wantBody = typeof hooks.bodyLines === 'function' ? hooks.bodyLines() === true : hooks.bodyLines === true;
      const plan = markers(text, {
        bodyLines: wantBody,
        cellContext: 格内,
        listHost: hooks.listHost,
        tree: treeOf(CM6, state, 预算),
      });
      // ⭐ 把这一份结果交给调用方（`main.js` 的落点/删除层）——同一份隐藏区间，⛔ 不重算。
      if (typeof hooks.onPlan === 'function') hooks.onPlan(plan);
      const decos = plan.ranges.map(function (r) {
        return hide.range(r.from, r.to);
      });
      // ⭐ `bugs/0304` 候选 ④（2026-11-12）：把**行内代码反引号**从零宽替换里拆出去。
      //    `Decoration.replace` 会让 CM6 在隐藏区间前插一个 `cm-widgetBuffer` 零宽 `<img>`
      //    （U+FFFC 的替身），它参与 UAX#14 断行 ⇒「（」紧跟行内代码时，编辑态能在
      //    「（」之后断行、阅读态不能（LB14）⇒ 折行点差一个全角字（`bugs/0304` §3.2）。
      //    修法：这些区间改贴 `cm-rmd-zw` 的 **mark**（字符留在文本流里，只 `font-size: 0`），
      //    断行输入因此与阅读态同类、widget buffer 也不再出现。
      //    ⚠️ 只拆**被某个隐藏区间完整包含**的 zw 区间（`zwRanges` 是 `ranges` 的子集来源，
      //    合并之后仍然包含）；⛔ 不从 `plan.ranges` 里删它们——落点 / 删除层的隐藏集合
      //    必须保持原样（`bugs/0317` 那两路读的就是同一份 plan）。
      //    ⚠️ 多个 zw 区间在同一个 range 内时按 `from` 升序逐个拆；长度 0 的隐藏段丢弃，
      //    ⛔ 不产生重叠 / 逆序装饰。
      //    ⚠️ **fail-closed**：`plan.zwRanges` 缺失或为空时上面那份 `map` 就是最终结果，
      //    与改动前**逐字节相同**（老调用方 / 被裁掉字段的 plan 不走进这个分支）。
      const zwRanges = Array.isArray(plan.zwRanges) ? plan.zwRanges : [];
      if (zwRanges.length) {
        /** @type {Array<object>} */
        const 拆后 = [];
        for (let i = 0; i < decos.length; i++) {
          const d = decos[i];
          /** @type {Array<{from:number, to:number}>} */
          const 内 = [];
          for (let j = 0; j < zwRanges.length; j++) {
            const z = zwRanges[j];
            if (z.to > z.from && z.from >= d.from && z.to <= d.to) 内.push(z);
          }
          if (!内.length) { 拆后.push(d); continue; }
          let 起 = d.from;
          for (let j = 0; j < 内.length; j++) {
            const z = 内[j];
            // 防御：完全不重叠才拆（重叠时后一个起点已经落在前一个之后）。
            if (z.from < 起) continue;
            if (z.from > 起) 拆后.push(hide.range(起, z.from));
            拆后.push(markDeco('cm-rmd-zw').range(z.from, z.to));
            起 = z.to;
          }
          if (d.to > 起) 拆后.push(hide.range(起, d.to));
        }
        decos.length = 0;
        Array.prototype.push.apply(decos, 拆后);
      }
      // ⭐ **行内呈现**（`design/0052` U4）：加粗/斜体/删除线/行内代码/链接。
      //    ⚠️ 这一段是编辑态与渲染态**折行差**（`bugs/0022`，其"活动行显示源码"前提
      //    已被 `design/0061` 取代）的正解：行内代码在渲染态是等宽＋有内边距，
      //    编辑态若是正文字体，折行位置本来就不同——加多少几何 slack 都堵不住，
      //    只能让两边长得一样。
      plan.inline.forEach(function (m) {
        decos.push(markDeco(m.cls).range(m.from, m.to));
      });
      // ⭐ 行级排版（`bugs/0015`）：每一行按**它自己的源码**定尺度，⛔ 不按那一块原来的品种。
      //    ⚠️ 位置由 `markers()` 与这里**同一份切片**算出来（`from` 就是那一行的行首偏移），
      //    ⇒ 不再从 `state.doc` 二次求值：纯逻辑那半（node 测试）也就不用造一个假 `Text`。
      // ⚠️ `bugs/0298` 候选 1b：围栏行换成 block widget 之后，**那一行没有 `.cm-line`**
      //    ⇒ 同一行⛔ 不许再贴行级装饰（行级类与 block 装饰落在同一偏移会让 CM6 多留一个
      //    空行 tile，塌高当场失效）。会落到围栏行上的只有 `bodies`（`bodyLines` 时逐行
      //    给正文尺度）与 `listLines`（列表项里缩进写出来的围栏行算续行）⇒ 只守这两处，
      //    其余几族按定义都只落在内容行上。退化路径（没有 `WidgetType`）时这个集合为空，
      //    行为与改动前逐字节相同。
      /** @type {Object<string|number, boolean>} */
      const 围栏行 = {};
      if (fenceHide) plan.fenceLines.forEach(function (f) { 围栏行[f.from] = true; });
      plan.headings.forEach(function (h) {
        decos.push(lineDeco('cm-rmd-h' + h.level).range(h.from));
      });
      plan.bodies.forEach(function (b) {
        if (围栏行[b.from] === true) return;
        decos.push(lineDeco('cm-rmd-body').range(b.from));
      });
      // ⭐ **围栏行塌掉**（U5）：零宽替换已经把 ``` 与语言标记藏掉了，但那一行**还在**
      //    （一个空行仍占一整行高）⇒ 再贴一条行级类把它压到 0 高。
      //    ⚠️ `design/0061` L1 起**每一条**围栏行都在这里（没有活动行例外）。
      //    ⭐ `bugs/0298` 候选 1b（2026-11-12）：**改成 block replace ＋ `estimatedHeight = 0`
      //    的 widget**。行级类只影响 DOM，⛔ 不进 CM6 的 `HeightMap` ⇒ 视口外的围栏行仍按
      //    "一整行"估算，高过一屏的块进去时整块长高 +20.141 px。block widget 走
      //    `DocView.updateHeight` 的 `deco.widget.estimatedHeight` 那条记账 ⇒ 高度表记 0。
      //    ⚠️ 区间必须**恰好是整行**（`f.from` 行首 → `f.to` 行末，不含 `\n`）；`fenceLines`
      //    就是这个口径，换行由 CM6 自己收成 tile 的 `breakAfter`，⛔ 不许吞 `\n`。
      //    ⚠️ 没有 `WidgetType` 的假 CM6（纯逻辑判据）退回旧的 `cm-rmd-fence` 行级类：
      //    可见降级，不进真视图（与任务框 widget 同一条纪律）。
      plan.fenceLines.forEach(function (f) {
        if (fenceHide) decos.push(fenceHide.range(f.from, f.to));
        else decos.push(lineDeco('cm-rmd-fence').range(f.from));
      });
      // ⭐ Setext 下划线行同样塌成 0 高（`bugs/0089`）：不塌的话，编辑态比阅读态
      //    多出**一整行**，下方全部内容被推下去。
      (plan.collapsedLines || []).forEach(function (f) {
        decos.push(lineDeco('cm-rmd-collapsed').range(f.from));
      });
      // ⭐ 引用块里的空行承载**段距**（`bugs/0090`）：行高 ＝ `--reader-gap-block`。
      (plan.quoteGapLines || []).forEach(function (f) {
        decos.push(lineDeco('cm-rmd-quote-gap').range(f.from));
      });
      // ⭐ 嵌套引用的第二层起（`design/0085` C4）：宿主只搬了最外层那一份盒子
      //    ⇒ 剩下的竖线 ＋ 左内边距按行补（`live.css` 的 `[data-rmd-qdepth]` 三条）。
      (plan.quoteDepths || []).forEach(function (q) {
        if (围栏行[q.from] === true) return;
        decos.push(quoteDeco(q.qdepth).range(q.from));
      });
      // ⭐ 引用块 / 列表项里的代码块（`bugs/0091`）：逐内容行贴代码行类；
      //    首 / 末行再各加一条，承担 `pre code` 那份**整块一次**的上下内边距。
      (plan.nestedCodeLines || []).forEach(function (c) {
        decos.push(lineDeco('cm-rmd-code-line').range(c.from));
        if (c.first) decos.push(lineDeco('cm-rmd-code-first').range(c.from));
        if (c.last) decos.push(lineDeco('cm-rmd-code-last').range(c.from));
      });
      // ⭐ 引用块 / 列表项里的标题（`bugs/0091`）：补阅读态 `.doc hN` 的上 / 下外边距。
      (plan.nestedHeadingSpaces || []).forEach(function (s) {
        decos.push(lineDeco(s.where === 'before'
          ? 'cm-rmd-heading-space-before'
          : 'cm-rmd-heading-space-after').range(s.from));
      });
      // ⭐ 列表行（`bugs/0092`）：嵌套缩进走行内 `margin-left`，圆点/编号由 UA 的 `::marker` 画
      //    （`design/0084`）。
      //    ⚠️ 围栏行改 block widget 之后没有 `.cm-line`（`bugs/0298` 1b）⇒ 跳过。
      (plan.listLines || []).forEach(function (li) {
        if (围栏行[li.from] === true) return;
        decos.push(listDeco(li).range(li.from));
      });
      // ⭐ 任务框（`bugs/0092`）：落点是隐藏掉 `- [ ] ` 之后的正文起点。
      //    ⚠️ 假 CM6（纯逻辑判据）没有 `Decoration.widget`，那时这一条不参与。
      //
      // ⚠️⚠️ **必须是 `side: -1`（WidgetBefore）**（`bugs/0300`，2026-11-09 用户报告
      //    「Enter 之后，光标处于 todo 框的前面，而且无法往后移动」）：方框与光标**同在**
      //    正文起点（`t.pos === contentFrom`）。`side` 决定**同一点**上光标相对 widget 的
      //    左右侧：正的 `side: 1` 让光标被画在方框**左缘**（离屏实测：插入符 `left` ==
      //    widget 包裹层 `left`，方框在它右边 22 px），于是回车续出的空任务行看起来
      //    “光标在框前”；负值让光标落在方框**右缘之后**（实测 `left` == 包裹层右缘）。
      //    ⛔ 别改回正值，也别在没有光标断言的情况下动它——`W7e`/`W7f`/`W7h` 承重。
      if (typeof CM6.Decoration.widget === 'function') {
        (plan.tasks || []).forEach(function (t) {
          decos.push(CM6.Decoration.widget({ widget: taskWidget(t.checked), side: -1 }).range(t.pos));
        });
      }
      return CM6.Decoration.set(decos, true);
    };
    const field = CM6.StateField.define({
      create: function (state) {
        return build(state, 50);
      },
      update: function (value, tr) {
        // ⚠️⚠️ **选区变化不重算**（`design/0061` L1）：隐藏集合是源码的纯函数，
        //    `tr.selection` 再也不能改变任何标记的可见性。⚠️ 这不是省性能的顺手优化：
        //    重建会换掉整批 `Decoration` 对象，真的会让画面闪一下。
        //    ⚠️ 输入路径的预算比 `create` 紧（10 ms）：这是**每敲一个字都可能**走的路，
        //    而增量重解析一棵已解析过的小树本来就快。
        //    ⛔⛔ **2026-11-09 起：超时不算"可接受的降级"**——超时就是"部分标记露在屏幕上"，
        //    那是缺陷（`INV-LIVE-14` ①：编辑态一个源码标记都不许露）。它由探针
        //    `B{i}-3c`（逐字对齐独立 oracle）判红；⛔ 不许再把"超时只会退化成部分可见"
        //    写成一句免责说明。真要栽在预算上，正确做法是让重算变快/变增量，不是放宽判据。
        if (tr.docChanged) return build(tr.state, 10);
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
   * - ~~**围栏行**~~ ⇒ ⭐ **`design/0052` U5 起恒为 0**：围栏行整行塌成 0 高
   *   （`cm-rmd-fence` ＋ 零宽替换；`design/0061` L1 起不再有活动行例外），与渲染态一样
   *   **不存在**那两行。
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
   *    "排版丢了东西"那半**不由它管**——那是 `live/index.js` 的**变矮上报**；
   *    ⛔ 2026-11-09 起那不是"只告警、不拦人"的合规信号：`INV-LIVE-04` ① 要求进入瞬间
   *    块高逐像素不变，报了就是缺陷（`bugs/0298` 一族），必须消除而不是接受。
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

  const api = {
    markers: markers,
    fenceOf: fenceOf,
    layoutSlack: layoutSlack,
    createField: createField,
    /** ⭐ `bugs/0321`：纯函数，`tests/js/live-list-marker.test.js` 直接判它。 */
    bulletShape: 圆点形状,
    /** ⭐ `bugs/0116` §9：有序列表的分级字形（纯函数），同上。 */
    orderedMarker: 分级字形,
    /** ⭐ 同上：分级字形的层数上限，测试用它把 CSS 那张表钉在同一长度。 */
    ORDERED_MARKER_MAX_LEVEL: 级上限,
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
