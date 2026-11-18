//! 产品模块的**转接层**：按 `#[path]` 直接编译 `src-tauri/src/document/` 下的真实源码。
//!
//! ⚠️ 目录 `src/document/` 必须**真实存在**，否则 `#[path]` 里的 `..` 解析不到
//! （POSIX 路径解析要求中间目录存在）——这是本文件存在的唯一理由。
//!
//! ⛔ 这里**不写任何逻辑**，只做 `mod` 声明。

#[path = "../../../../src-tauri/src/document/envelope.rs"]
#[allow(dead_code)] // 产品里 GUI/CLI 两条路都会用到的那些，探针只调一部分
pub mod envelope;

#[path = "../../../../src-tauri/src/document/offset.rs"]
#[allow(dead_code)] // 产品里被 GUI/CLI 两边调用的那些换算函数，探针只用其中几个
pub mod offset;

#[path = "../../../../src-tauri/src/document/parser.rs"]
#[allow(dead_code)]
pub mod parser;

// ⭐ `design/0059` 阶段 C：位置映射原型要的是**真实产品渲染**（`render::to_html_with_stats`），
// 所以 `0007` 的三份渲染增强模块以及 `render.rs` 本身也按 `#[path]` 编进来。
// ⚠️ 它们的 `super::` 路径依赖本模块把兄弟模块放在同一层——⛔ 别拆子模块。
// ⚠️ `render.rs` / `parser.rs` 里的 `crate::document::…` 只在 `#[cfg(test)]` 里出现，
//    正常构建不会编到（`cargo run` 不设 `cfg(test)`）。
#[path = "../../../../src-tauri/src/document/highlight.rs"]
#[allow(dead_code)]
pub mod highlight;

#[path = "../../../../src-tauri/src/document/math.rs"]
#[allow(dead_code)]
pub mod math;

#[path = "../../../../src-tauri/src/document/mermaid.rs"]
#[allow(dead_code)]
pub mod mermaid;

#[path = "../../../../src-tauri/src/document/diagram.rs"]
#[allow(dead_code)]
pub mod diagram;

#[path = "../../../../src-tauri/src/document/render.rs"]
#[allow(dead_code)]
pub mod render;
