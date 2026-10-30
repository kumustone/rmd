// rmd · CM6 冷启动探针（`research/notes/0016` §2.5 / `notes/0004` §7 待补 #3）
//
// 量什么：在**真 WKWebView** 里，用 CodeMirror 6 打开一份大 Markdown 的冷启动分段——
//   ① 建 `EditorState`（Text 树）② 挂 `EditorView` ③ 强制布局
//   ④ 视口节点/行数 ⑤ 全量 Lezer 解析（`forceParsing`）⑥ 一次按键（改一个字符）
//   ⑦ 按键后的增量重解析。
//
// ⛔ 不量 IME：合成按键造不出输入法组合态（对照 `find-keyprobe.swift` 只能合成普通按键）。
// ⇒ 「中文输入法在 CM6 里什么手感」**这条探针永远答不了**，见 `notes/0016` §2.2。
//
// 用法： cm6-probe <pageDir> <docJs> [--repeat N]
// 输出： 一行 JSON 到 stdout（`{"doc_len":…,"rounds":[…]}`）

import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("用法: cm6-probe <pageDir> <docJs> [--repeat N]\n".data(using: .utf8)!)
    exit(2)
}
let pageDir = args[1]
let docJs = args[2]
var repeatCount = 1
if let i = args.firstIndex(of: "--repeat"), i + 1 < args.count, let n = Int(args[i + 1]) { repeatCount = n }

// ⚠️ 必须用 `callAsyncJavaScript`：老的 `evaluateJavaScript` **不 await Promise**，
//    直接报 "returned a result of an unsupported type"（本探针第一版就撞在这）。
// ⚠️ **不要等 rAF**：本探针窗口 `alphaValue = 0`、不在屏幕上，WKWebView 不保证给不可见
//    窗口刷新机会 ⇒ 等 rAF 会**永不回调**、探针挂死（第一版挂到 180 秒兜底）。
//    让出事件循环一律用 `setTimeout(…, 0)`。
//    这是 `probe.swift` 那条"窗口必须可见性中立"的口径在**异步等待**上的延伸：
//    ⛔ 不是"rAF 不能用"，而是**看不见的窗口里 rAF 不保证来**。
let RUNNER = """
  const out = { rounds: [], ua: navigator.userAgent };
  await new Promise(r => setTimeout(r, 0));
  for (let i = 0; i < %N%; i++) {
    const withLang = await window.__CM6.open(window.__DOC, { withLanguage: true });
    const noLang   = await window.__CM6.open(window.__DOC, { withLanguage: false });
    out.rounds.push({ withLanguage: withLang, withoutLanguage: noLang });
  }
  out.doc_len = window.__DOC.length;
  return out;
""".replacingOccurrences(of: "%N%", with: String(repeatCount))

private final class Delegate: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        FileHandle.standardError.write("· didFinish，开始跑 RUNNER\n".data(using: .utf8)!)
        webView.callAsyncJavaScript(RUNNER, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .failure(let error):
                FileHandle.standardError.write("⛔ callAsyncJavaScript 失败：\(error)\n".data(using: .utf8)!)
                exit(1)
            case .success(let value):
                guard let obj = value as? [String: Any],
                      let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
                      let json = String(data: data, encoding: .utf8) else {
                    FileHandle.standardError.write("⛔ 返回值不能序列化：\(String(describing: value))\n".data(using: .utf8)!)
                    exit(1)
                }
                print(json)
                exit(0)
            }
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("⛔ 导航失败：\(error)\n".data(using: .utf8)!)
        exit(1)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("⛔ 预导航失败：\(error)\n".data(using: .utf8)!)
        exit(1)
    }
}

let app = NSApplication.shared
// ⚠️⚠️ **`.prohibited`，⛔ 不是 `.accessory`**（`kb/0025` ＋ 2026-10-21 实测）：
//    `.accessory` 只是"没有 Dock 图标"，**仍会被激活**——从正在前台的终端里起进程时，
//    实测 `frontmostApplication` 会从 `iTerm2` 变成探针自己。本探针不依赖焦点/键盘，
//    ⇒ 换 `.prohibited`（结构上不允许被激活），代价为零。
_ = app.setActivationPolicy(.prohibited)

let config = WKWebViewConfiguration()
config.suppressesIncrementalRendering = false

// ⚠️ 尺寸与 `probe.swift` 一致（1200×800）。视口行数**取决于高度**，
//    换尺寸会让 `viewport_lines` 那一列不可跨轮比较。
let rect = NSRect(x: 0, y: 0, width: 1200, height: 800)
let webView = WKWebView(frame: rect, configuration: config)
private let delegate = Delegate()
webView.navigationDelegate = delegate

let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView
window.alphaValue = 0

DispatchQueue.main.async {
    let fm = FileManager.default
    let html = URL(fileURLWithPath: (pageDir as NSString).appendingPathComponent("index.html"))
    // doc.js 换成调用方指定的那一份（页面里只有一个 `<script src="doc.js">`）
    let src = URL(fileURLWithPath: (pageDir as NSString).appendingPathComponent(docJs))
    let dst = URL(fileURLWithPath: (pageDir as NSString).appendingPathComponent("doc.js"))
    if fm.fileExists(atPath: src.path) {
        try? fm.removeItem(at: dst)
        try? fm.copyItem(at: src, to: dst)
    }
    if fm.fileExists(atPath: html.path) {
        webView.loadFileURL(html, allowingReadAccessTo: URL(fileURLWithPath: pageDir))
    } else {
        FileHandle.standardError.write("⛔ 找不到 \(html.path)\n".data(using: .utf8)!)
        exit(1)
    }
    FileHandle.standardError.write("▶ 加载 \(html.path)（doc=\(docJs)）\n".data(using: .utf8)!)
}

// ⚠️ 兜底超时：10 MB 语料 + 全量解析，给足 180 秒。
//    macOS **没有** `timeout`（那是 coreutils 的 `gtimeout`），所以兜底只能自己带。
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 180) {
    if Date().timeIntervalSince(wall) >= 179.5 {
        FileHandle.standardError.write("⛔ 180 秒没拿到结果\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
