// rmd · CM6 bundle 的**打包入口**（`design/0012` §2.5-2）。
//
// ⚠️ 本文件**不进产物、也不参与运行时**——它只是 esbuild 的入口：
//    把下面这几个符号收进**一个**全局名（`--global-name=rmdCM6`）。
//
// # ⭐ 为什么是"一个入口 + 一个全局"，而不是让页面直接 import
//
// `src/` 下今天**全部**是经典 script（`<script src="…">`、⛔ 无 `type="module"`、
// ⛔ 无 `import`），`index.html` 的加载顺序规则（`adr/0002` / `notes/0009` 那次
// `search.js` 排在 `session.js` 之后的教训）就是按这个前提立的。
// ⇒ 打了 bundle 之后那条规则**一个字不用改**：`rmdCM6` 是一个普通全局，
//    `src/editor/*.js` 按老样子取它。
//
// # ⛔ 这份导出清单与 §2.1① 的**扩展白名单**是同一件事
//
// ⚠️ 加一项 = 改本设计（那张表下面写着这句话）。所以这里**只导出运行时要用的**，
// 并且与白名单**逐条对得上**：
//
// | 白名单那一项 | 这里导出的符号 |
// |---|---|
// | `EditorView.lineWrapping` / `EditorView.updateListener` | `EditorView`（两个都是它的静态成员） |
// | `lineNumbers()` | `lineNumbers` |
// | `keymap` 注册（§2.3-4 转发） | `keymap`（住 `@codemirror/view`） |
// | `Prec.low`（转发层 `src/editor/keys.js`） | `Prec` |
// ⚠️ 这张表原先写的是「⭐ Vim 插槽留 `Prec.higher`」——**那两句已作废**（`design/0014` §1.1 更正块）：
//    `Prec` 的成员只有 `highest/high/default/low/lowest`（**没有 `higher`**），
//    而且 `vimPlugin` 走 `EditorView` 的原生 `domEventHandlers`、⛔ **不在 `keymap` facet 里**
//    ⇒ **包不包 `Prec` 都一样**；决定谁先拿到键的是**扩展在 `extensions()` 里的位置**。
// | `history()` ＋ `historyKeymap` | `history` / `historyKeymap`（住 `@codemirror/commands`） |
// | `markdown()` | `markdown` |
// | `EditorState`（`create` / `Text` 往返） | `EditorState` |
// | ⭐ `Compartment`（`design/0014` 裁定 (a)：Vim 开关切换） | `Compartment`（容器，本身不装扩展） |
// | ⭐ `vim()` / `Vim`（`design/0014`：编辑态 Vim 键位） | `vim` / `Vim`（`@replit/codemirror-vim`） |
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
// ⚠️ **`markdown()` 只装语言、不装它的键位**（`markdownKeymap` 不在白名单里）：
//    §2.1① 给 `markdown()` 写的用途是"列表延续 / 将来 Vim 的 motion"，
//    但**列表延续的键位来自 `markdownKeymap`** ⇒ 本期它**不生效**，
//    生效的只有语法树。⚠️ 这一条已作为**偏差**记进 `design/0012` §10 实施记录
//    （⛔ 不许把它当成"已经能续列表"）。

export { EditorState, Prec, Compartment } from "@codemirror/state";
export { EditorView, keymap, lineNumbers } from "@codemirror/view";
export { history, historyKeymap } from "@codemirror/commands";
export { markdown } from "@codemirror/lang-markdown";
// ⭐ `design/0014`（编辑态 Vim 键位）加的两项。⚠️ §2.1① 那张**封闭白名单**因此对编辑面不再封闭
//    （`vim()` 自带 `ViewPlugin` / `Decoration` / `inputHandler` / panel 四件，见 `design/0014` §1.5），
//    ⛔ **正文不改**，留痕在 `design/0014` §3.6。
//    `vim` = 安装扩展；`Vim` = 运行期 API 面（`:w` 走 `Vim.defineEx`、`⌃K`/`⌃H` 走 `Vim.mapCommand`）。
export { vim, Vim } from "@replit/codemirror-vim";
// ⭐ 同上，`Compartment` 是 `design/0014` 裁定 (a)「开关切换」的落点（`reconfigure` 而不是 `setState`，
//    ⚠️ 后者会重建 `EditorState` ⇒ 丢撤销历史，见其 §2.4-3 与 `INV-VIM-08`）。
//    ⚠️ 它**不破** §2.1① 白名单：它只是 `@codemirror/state` 的**容器**，本身不装任何扩展。
//    ⭐ 0a-② 已核实：包里**有**它（`grep -c` = 16），只是原先**没往出口放**。
