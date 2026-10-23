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

pub mod diagram;
pub mod envelope;
pub mod highlight;
pub mod loader;
pub mod math;
pub mod offset;
pub mod parser;
pub mod render;
pub mod search;
pub mod toc;
