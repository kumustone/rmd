//! 文档处理层：**本项目唯一的解析实现**。
//!
//! ⛔ 不要有第二份。CLI 与 GUI 都从这里取（`docs/design/0002` `INV-SINGLE-01`）。
//! ⛔ 不要指望增量解析：comrak 只有整文档入口（`docs/kb/0001-comrak-解析入口.md`）。
//!
//! 层次：`loader`（读盘）→ `parser`（comrak）→ `render`（出 HTML）/ `toc` / `search`。
//! `offset` 是横切的：把 comrak 的 `(行, 列)` 和全局字节偏移互相换算。
//!
//! ⭐ `design/0007` 起多了三个**渲染增强**模块，它们只被 `render` 用：
//!
//! - `highlight`：围栏的高亮适配器（`SyntaxHighlighterAdapter`，**只出 class**）。
//! - `math`：`Math` 节点 → MathML（`katex-rs`），进 DOM 前**按属性剥色**。
//! - `diagram`：`flow`/`sequence` 围栏 → Mermaid → SVG（`flowmaid`），并**注册**这两个围栏。
//!
//! ⛔ 它们都不碰 `offset` / `toc` 的行为（`design/0007` §3 的"明确不动"清单）。
//!
//! ⭐ `design/0012` 起多了 `envelope`：它**不是**渲染链的一环，
//! 而是"磁盘正文的编码与行尾"这一层的**唯一定义**（`INV-EDIT-12`）。
//! ⚠️ 它只被写侧（`commands/edit.rs`）与 `commands/document.rs` 的打开路径用，
//! 解析链（`parser` / `render`）**看不见它**——⛔ 别把它接进渲染。
//!
//! ⭐ `design/0047` 起多了 `blocks`：**顶层块的行区间表**（「唯一全文模型 ＋ 单块编辑视图」的骨架）。
//! ⚠️ 它在**既有 AST** 上走一层（⛔ 不重新 parse、⛔ 不开 `render.sourcepos`），
//! 只被 `commands/document.rs::render_source` 调用。
//!
//! ⭐ `design/0076` 起多了 `export`：导出的**纯逻辑**（CSS 打包 / 图片内联 / 页面拼装）。
//! ⚠️ 它**不在渲染链上**：输入是已经渲染好的 HTML，输出是一份自足的单文件；
//! 落点授权与写盘分别在 `fs/grants.rs` 与 `fs/atomic.rs`（⛔ 别从本模块伸手去写盘）。
//! ⚠️ **不 gate `gui`**：`make test`（默认构建）直接跑它的判据。

pub mod blocks;
pub mod diagram;
pub mod envelope;
pub mod export;
pub mod highlight;
pub mod loader;
pub mod math;
pub mod mermaid;
pub mod offset;
pub mod parser;
pub mod render;
pub mod search;
pub mod toc;
