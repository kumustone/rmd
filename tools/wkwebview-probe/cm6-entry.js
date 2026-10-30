// rmd · CM6 冷启动探针的页面入口（`research/notes/0004` §7 待补 #3 / `notes/0016` §2.5）
//
// 目的：在**真 WKWebView** 里量「引入 CodeMirror 6 打开一份大 Markdown」的冷启动分段。
// ⛔ **不测 IME**：合成按键造不出输入法组合态（对照 `find-keyprobe.swift` 只能合成普通按键）。
//
// ⚠️ 时间轴是本页的 `performance.now()`；每一段都在**同一次同步调用里**量，不跨帧。
// ⚠️ **不能用 `requestAnimationFrame` 让出**：探针的窗口 `alphaValue = 0`、不在屏幕上，
//    WKWebView 不保证给不可见窗口刷新机会 ⇒ 等 rAF 会**永不回调**、探针挂死。
//    （第一版就撞在这：`evaluateJavaScript` 挂到 180 秒兜底。）
//    同理必须用 `callAsyncJavaScript`——老的 `evaluateJavaScript` **不 await Promise**，
//    会直接报 "returned a result of an unsupported type"。

import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree, forceParsing } from "@codemirror/language";

const now = () => performance.now();
const r3 = (x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x);

window.__CM6 = {
  // opts: { withLanguage: bool }
  async open(doc, opts) {
    const withLanguage = !opts || opts.withLanguage !== false;
    const out = { withLanguage, doc_len: doc.length };

    // ── ① 造 EditorState（CM6 在这里建 Text 树；语言插件此阶段不解析） ──
    let t = now();
    const state = EditorState.create({
      doc,
      extensions: withLanguage
        ? [lineNumbers(), markdown({ base: markdownLanguage })]
        : [lineNumbers()],
    });
    out.t_state_ms = r3(now() - t);

    // ── ② 挂 EditorView（建 DOM、装观察器） ──
    const host = document.getElementById("host");
    host.innerHTML = "";
    t = now();
    const view = new EditorView({ state, parent: host });
    out.t_view_ms = r3(now() - t);

    // ── ③ 强制布局（CM6 只渲染视口 ⇒ 这里应当很便宜） ──
    t = now();
    void view.contentDOM.offsetHeight;
    out.t_layout_ms = r3(now() - t);

    // ── ④ 视口里到底建了多少节点（CM6 是虚拟化的，与 `design/0002` 的 `innerHTML` 不同族） ──
    out.viewport_nodes = host.getElementsByTagName("*").length;
    out.viewport_lines = view.contentDOM.querySelectorAll(".cm-line").length;

    // ── ⑤ 全量解析（Lezer）：CM6 是**惰性 + 分片**解析，`forceParsing` 才把整篇算完 ──
    if (withLanguage) {
      t = now();
      out.force_parsing_returned = forceParsing(view, doc.length, 20000);
      out.t_force_parse_ms = r3(now() - t);
      out.tree_len_after = syntaxTree(view.state).length;
    }

    // ── ⑥ 一次按键：改一个字符 + 强制布局（"编辑手感"的同步量） ──
    const pos = Math.floor(view.state.doc.length / 3);
    t = now();
    view.dispatch({ changes: { from: pos, insert: "x" } });
    void view.contentDOM.offsetHeight;
    out.t_keystroke_ms = r3(now() - t);
    if (withLanguage) {
      t = now();
      forceParsing(view, view.state.doc.length, 20000);
      out.t_keystroke_reparse_ms = r3(now() - t);
    }

    // ── ⑦ 让出事件循环再回来（见文件头的 rAF 警告） ──
    out.t_yield_ms = await new Promise((res) => {
      const a = now();
      setTimeout(() => res(r3(now() - a)), 0);
    });

    view.destroy();
    return out;
  },
};
