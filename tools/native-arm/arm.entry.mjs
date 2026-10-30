// rmd · 「编辑选区与输入能力复用」隔离对照臂的打包入口（`design/0054` §6.2 阶段 1）。
//
// ⛔ **这不是产品包**：`tools/cm6/entry.mjs` / `src/vendor/cm6.bundle.js` 一个字节不动。
//    本文件只被 `tools/native-arm/probe.sh` 用 esbuild 打进 `$TMPDIR`，
//    产物不进仓库、不进二进制、不被 `src/**` 引用。
//
// ⭐ 为什么必须另开一份：原生对照臂要用 **`drawSelection()`** 与 **`defaultKeymap` /
//    `historyKeymap`**，而这三样在 `design/0052` §2.1 的 B 栏里是**明令封闭**的
//    （`INV-KERNEL-03` / `INV-LIVE-12`）。用户 2026-10-29 授权「隔离对照臂内允许作为
//    实验变量调整；生产路径仍按现有约束运行」⇒ 它们只能出现在这里。
//    ⛔ 如果哪天本文件被 `src/**` import 了，那就是把 B 栏悄悄开放——`probe.sh` 末尾的自检
//    会拒绝（`grep -R` 产品源码里的 `native-arm`）。
//
// ⚠️ 这里导出的每一样都**直接来自 `node_modules`**（钉死版本，见根 `package.json`），
//    不复制上游实现、不调私有 API。

// 文档状态与选区
export { EditorState, EditorSelection, Text } from "@codemirror/state";

// 视图；⭐ `drawSelection` 是本次实验的自变量之一（原生选区各画各的 vs 自绘层）
export { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";

// ⭐ 键位表：原生臂靠它接管 Enter / Backspace / ⌘Z。
//    ⛔ 生产路径仍然禁用它（`INV-KERNEL-03`）——本臂要验的正是「交回去会怎样」。
export { defaultKeymap, historyKeymap, history, undo, redo, undoDepth } from "@codemirror/commands";
