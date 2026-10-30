// rmd · CM6 bundle 的**打包入口**（`design/0012` §2.5-2）。
//
// ⚠️ 本文件**不进产物、也不参与运行时**——它只是 esbuild 的入口：
//    把下面这些符号收进**一个**全局名（`--global-name=rmdCM6`）。
//
// # ⭐ 为什么是"一个入口 + 一个全局"，而不是让页面直接 import
//
// `src/` 下今天**全部**是经典 script（`<script src="…">`、⛔ 无 `type="module"`、
// ⛔ 无 `import`），`index.html` 的加载顺序规则（`adr/0002` / `notes/0009` 那次
// `search.js` 排在 `session.js` 之后的教训）就是按这个前提立的。
// ⇒ 打了 bundle 之后那条规则**一个字不用改**：`rmdCM6` 是一个普通全局，
//    `src/editor/*.js` / `src/live/*.js` 按老样子取它。
//
// # ⭐ 导出面分**两栏**（`design/0052` / `adr/0013`，2026-10-27 起）
//
// 判据是一句话：**这个 API 是让「文档状态」更正确，还是让「呈现」归它？**
//
// | 栏 | 内容 | 加一项的代价 |
// |---|---|---|
// | **A · 文档语义面** | 事务与状态、选区、历史、语法树、**不绑定键位**的命令 | ⭐ 只改本文件的导出注释（写清用途） |
// | **B · 呈现与输入面** | 键位表族、`drawSelection`、`contenteditable` 相关、高亮/主题类、panel/tooltip | ⛔ **仍然封闭**：加一项必须改 `docs/design/0052` §2.1 的表并过人评审 |
//
// ⚠️ 这**不是**"放宽白名单"——当初要挡的三件事一件没松：
//   · `INV-LIVE-11` ①：分栏那个视图仍守 `INV-EDIT-09`，一个字节不放宽；
//   · `INV-LIVE-11` ③ / `INV-KERNEL-03`：全仓仍禁 `defaultKeymap` / `standardKeymap` /
//     `emacsStyleKeymap` / `basicSetup` / `markdownKeymap`；
//   · `INV-LIVE-12` / `INV-KERNEL-04`：输入层仍归 rmd —— `contentDOM` **永不聚焦、永不 contenteditable**。
//     ⭐ 引入 CM6 的**命令** ⛔ 不等于把输入交回去：命令只改 `EditorState`，键还是由 rmd 的
//     离屏 textarea 收（`notes/0038` 的 22.40 px 就是 contenteditable 吃组合串的代价）。
//
// ⭐ **为什么需要 A 栏**：`design/0047` 的覆盖层要做的是**就地编辑**（删除、选区、历史、语法树），
//    这些能力 CM6 都有、而且 `@codemirror/{commands,language}` 早就是精确版本的直接依赖，
//    只是**没从出口放出来**。旧口径（「加一项 = 改设计」）把它们一起关在外面，代价是
//    本仓重写了删除语义（`bugs/0014`）、撤销栈（`bugs/0020`）、ATX 识别（`bugs/0015`/`0016`）。
//    ⇒ 那条摩擦**只该留给 B 栏**：它当初要挡的是"两套键位事实"和"第二套排版来源"，
//      而不是"别用 CM6 算出来的文档状态"。
//
// ⛔ **A 栏的两条禁止**（加之前先自查，否则它其实是 B 栏）：
//    ① 不许放任何**绑键位**的东西（`keymap` 表族、`historyKeymap`、`markdownKeymap`）；
//    ② 不许放任何**写样式**的东西（`drawSelection`、`HighlightStyle`、`EditorView.theme`、
//       任何 panel/tooltip）。命令只做文档状态，⛔ 不做呈现。
//
// ⛔ **这里没有、也不许有**：`defaultKeymap` / `standardKeymap` / `emacsStyleKeymap` /
//    `basicSetup` / `drawSelection` / `markdownKeymap` /
//    ⛔ **我们自己主动装**的任何 `@codemirror/search` 东西
//    —— 少一条就是 §7 的源码级 `grep` 闸门要抓的事。
//
// ⚠️⚠️ **一处必须写清的区别**（`design/0014` §3.2）：`@codemirror/search` 由
//    `@replit/codemirror-vim` 的**顶部静态 import** 带进来（它要 `SearchQuery` /
//    `setSearchQuery` / `RegExpCursor` 做 Vim 的 `/` 搜索高亮）。
//    ⇒ 那是**上游内部**要的，⛔ **不是我们主动装的扩展**，也⛔ **不经过这张导出表**。
//    ⛔ 别因为"包里出现了 search 的代码"就把上面那条禁项放宽。
//
// ⚠️ **`markdown()` 只装语言、不装它的键位**（`markdownKeymap` 不在导出面上）：
//    §2.1① 给 `markdown()` 写的用途是"列表延续 / 将来 Vim 的 motion"，
//    但**列表延续的键位来自 `markdownKeymap`** ⇒ 那个键位表**仍然不装**。
//    列表续行改由 rmd 自己调 `insertNewlineContinueMarkup`（A 栏命令，绑哪几个键由
//    `src/live/` 决定，⛔ 不交给 CM6 的键位表）。⚠️ 原偏差记录在 `design/0012` §10。

// ── A · 文档语义面（⭐ 加一项只改上面那段注释里的一行，写清用途）──────────────

// 事务与状态：`EditorState`（`create` / `Text` 往返）、`StateField`（块级装饰必须走它）、
// `Compartment`（`design/0014` 裁定 (a)：Vim 开关 `reconfigure` 用，⚠️ 它只是容器，本身不装扩展）、
// `EditorSelection`（`design/0052` U1：选区语义 —— `bugs/0014` 的 `range()` 形状就在这一族里）。
export { EditorState, Prec, Compartment, StateField, EditorSelection } from "@codemirror/state";

// 视图容器与**装饰**。⚠️ `Decoration` / `WidgetType` 属 A 栏：它们**不绑键位、不写样式**
// （值由 `src/styles/live.css` 的类给，`INV-KERNEL-06`：装饰层只贴类名）。
export { EditorView, keymap, lineNumbers, Decoration, WidgetType } from "@codemirror/view";

// 历史（`design/0052` U2）：`history()` 是扩展，`undo`/`redo` 等是**命令**。
// ⚠️ `historyKeymap` 是**键位表** ⇒ 它属 B 栏（`design/0012` 装的分栏视图要用，历史遗留）。
export {
  history, historyKeymap,
  undo, redo, undoDepth, redoDepth, isolateHistory,
  deleteCharBackward, deleteCharForward, deleteGroupBackward,
  insertNewline, insertBlankLine, selectAll,
} from "@codemirror/commands";

// 语法树（`design/0052` U3）：`syntaxTree(state)` 是 Lezer 树，`ensureSyntaxTree` 用于视口外强制解析。
export { syntaxTree, ensureSyntaxTree, syntaxTreeAvailable } from "@codemirror/language";

// 语言 ＋ Markdown 的**两条命令**（⛔ 不是 `markdownKeymap`）：列表续行 / 退格删标记。
// ⭐ `markdownLanguage`（`design/0052` U3）：**带 GFM 方言**的那一份。`markdown()` 的默认
//    `base` 是 `commonmarkLanguage`（**没有** GFM）⇒ 不换 base 的话 `~~删~~` 在语法树里
//    根本不是 `Strikethrough`，标记就藏不掉。⚠️ 它同时也带进了 superscript / subscript / emoji
//    三条 comrak **不支持**的扩展 ⇒ 那三类节点**故意不进隐藏白名单**（`src/live/decorations.js`
//    的 `HIDDEN_MARK`），差异归 U9 的差分表。
export {
  markdown, markdownLanguage, insertNewlineContinueMarkup, deleteMarkupBackward,
} from "@codemirror/lang-markdown";

// ── B · 呈现与输入面（⛔ 仍然封闭：加一项必须改 `design/0052` §2.1 的表并过人评审）──────

// ⭐ `design/0014`（编辑态 Vim 键位）加的两项。⚠️ §2.1① 那张**封闭白名单**因此对编辑面不再封闭
//    （`vim()` 自带 `ViewPlugin` / `Decoration` / `inputHandler` / panel 四件，见 `design/0014` §1.5），
//    ⛔ **正文不改**，留痕在 `design/0014` §3.6。
//    `vim` = 安装扩展；`Vim` = 运行期 API 面（`:w` 走 `Vim.defineEx`、`⌃K`/`⌃H` 走 `Vim.mapCommand`）。
export { vim, Vim } from "@replit/codemirror-vim";
// ⭐ `Compartment` 的**导出行**在 A 栏（它是 `@codemirror/state` 的容器，不装任何扩展），
//    但它的实际用途是 `design/0014` 裁定 (a)「Vim 开关切换」的落点
//    （`reconfigure` 而不是 `setState`，⚠️ 后者会重建 `EditorState` ⇒ 丢撤销历史，
//    见其 §2.4-3 与 `INV-VIM-08`）。⭐ 0a-② 已核实：包里**有**它（`grep -c` = 16），原先只是没往出口放。
