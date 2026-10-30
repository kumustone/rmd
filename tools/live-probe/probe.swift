// rmd · 就地编辑块视图探针的**运行器**（跑 `design/0047` §7.2 第 6 条 `make probe-live-block`，
// 页面侧在 `block-harness.js`，假后端在 `fake-tauri.js`）
//
// ⭐ 它的结构与 `tools/wkwebview-probe/tree-menu-probe.swift` **同源**（`.prohibited` 那条激活策略
//    是实测出来的，⛔ 别另起一份）：只做三件事——离屏窗口、调 `window.__RUN()`、把环境自证写进 JSON。
//    两处不同**只有**：① 窗口更大（真应用的整页布局，`#doc` + 侧边栏；⛔ 太小会把段落压成两行，
//    折行判据就不是它想验的那件事了）② 兜底超时更长（逐块 14 轮 × 若干帧）。
//
// ⭐ **不弹窗、不抢焦点、不合成系统按键**（根 `CLAUDE.md` 工作约定 4）：
//    `.prohibited` + `.borderless` + `alphaValue = 0` + `orderBack`；
//    页内的事件是 `MouseEvent` / `KeyboardEvent` / `CompositionEvent` / `InputEvent`
//    **派发到 DOM 元素上**（⛔ 不是系统级合成按键，不会进到任何前台应用）。
//    ⛔ 全程不调 `NSApp.activate` / `makeKey` / `makeFirstResponder`，⛔ 不用 `osascript` / `System Events`。
//
// ⚠️⚠️ 本探针**不验可见首帧**（`design/0047` §7.1 `0c-②`）——那个只有在窗口可见时才成立，
//    如实留在人工那一档（`.claude/rules/tests.md` 的「操作红线」）。
//
// 用法： live-block-probe <pageDir>
// 输出： 一行 JSON 到 stdout（页面 `window.__RUN()` 的返回值）
// 退出码：0 = 拿到结果（⚠️ 结论在 JSON 里）；1 = 环境/加载/超时

import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: live-block-probe <pageDir>\n".data(using: .utf8)!)
    exit(2)
}
let pageDir = args[1]

// ⚠️ 用 `callAsyncJavaScript`：老的 `evaluateJavaScript` **不 await Promise**。
let RUNNER = """
  if (typeof window.__RUN !== 'function') {
    return { 致命: 'harness 没跑起来（window.__RUN 不是函数）；加载期错误：'
      + JSON.stringify(window.__LOADERR || []) };
  }
  return await window.__RUN();
"""

private final class Delegate: NSObject, WKNavigationDelegate {
    private let 起跑前前台 = NSWorkspace.shared.frontmostApplication?.localizedName ?? "未知"
    private let 起跑时刻 = Date()

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        FileHandle.standardError.write("· didFinish，开始跑 window.__RUN()\n".data(using: .utf8)!)
        let 起跑前前台 = self.起跑前前台
        let 起跑时刻 = self.起跑时刻
        webView.callAsyncJavaScript(RUNNER, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .failure(let error):
                FileHandle.standardError.write("⛔ callAsyncJavaScript 失败：\(error)\n".data(using: .utf8)!)
                exit(1)
            case .success(let value):
                guard var obj = value as? [String: Any] else {
                    FileHandle.standardError.write("⛔ 返回值不是对象：\(String(describing: value))\n".data(using: .utf8)!)
                    exit(1)
                }
                // ── 环境自证：窗口状态 ＋ 有没有动到用户的前台应用 ──
                let 现在前台 = NSWorkspace.shared.frontmostApplication?.localizedName ?? "未知"
                let 窗口: [String: Any] = [
                    "isVisible": webView.window?.isVisible ?? false,
                    "alpha": Double(webView.window?.alphaValue ?? -1),
                    "windowNumber": Int(webView.window?.windowNumber ?? -1),
                    "调过_NSApp_activate": false,
                    "调过_makeKey": false,
                    // ⭐ 两条**自证"没抢键盘焦点"**的判据（本探针不调 `makeKey`）
                    "进程被激活": NSApp.isActive,
                    "窗口是_key": webView.window?.isKeyWindow ?? false,
                ]
                var env = (obj["环境"] as? [String: Any]) ?? [:]
                env["窗口"] = 窗口
                env["前台应用_起跑前"] = 起跑前前台
                env["前台应用_收工时"] = 现在前台
                env["前台被抢过"] = (起跑前前台 != 现在前台)
                env["墙钟秒"] = (Date().timeIntervalSince(起跑时刻) * 1000).rounded() / 1000
                obj["环境"] = env
                if 起跑前前台 != 现在前台 {
                    FileHandle.standardError.write(
                        "⚠️⚠️ 前台应用从「\(起跑前前台)」变成了「\(现在前台)」——这次跑的数不要信\n"
                            .data(using: .utf8)!)
                }
                guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
                      let json = String(data: data, encoding: .utf8) else {
                    FileHandle.standardError.write("⛔ 返回值不能序列化\n".data(using: .utf8)!)
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
// ⚠️⚠️ **`.prohibited`，⛔ 不是 `.accessory`**（见 `kb/0025`）：`.accessory` 只是"没有 Dock 图标"，
//    **仍然可以被激活**；从终端里起的进程会被 AppKit 抢去激活。
_ = app.setActivationPolicy(.prohibited)

let config = WKWebViewConfiguration()
config.suppressesIncrementalRendering = false

// ⭐ **把页内的 `console.error` / 未捕获异常 / 未处理的 rejection 打到 stderr**。
// ⚠️ 少了这一条，"页内某处炸了"与"某处真的挂死"**输出一模一样**（都是等满 180 秒、一行 JSON 都没有）
//    —— 而这正是本仓踩过的那类静默失败（`docs/kb/0006` 一族）。⛔ 它不改页面行为，只多一条通路。
private final class 页内日志: NSObject, WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        FileHandle.standardError.write("· 页内：\(m.body)\n".data(using: .utf8)!)
    }
}
private let 日志桩 = 页内日志()
config.userContentController.add(日志桩, name: "probeLog")
config.userContentController.addUserScript(WKUserScript(source: """
(function () {
  function 发(kind, args) {
    try {
      var s = Array.prototype.map.call(args, function (a) {
        try { return (a && a.stack) ? String(a.stack) : String(a); } catch (e) { return '?'; }
      }).join(' ');
      window.webkit.messageHandlers.probeLog.postMessage(kind + ': ' + s);
    } catch (e) { /* ⛔ 日志通路本身不许影响页面 */ }
  }
  ['error', 'warn'].forEach(function (k) {
    var 原 = console[k];
    console[k] = function () { 发(k, arguments); if (原) 原.apply(console, arguments); };
  });
  window.addEventListener('error', function (e) {
    发('onerror', [e.message + ' @' + (e.filename || '?') + ':' + e.lineno + ':' + e.colno
      + (e.error && e.error.stack ? '\\n' + e.error.stack : '')]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    发('reject', [String((e.reason && e.reason.stack) || e.reason)]);
  });
})();
""", injectionTime: .atDocumentStart, forMainFrameOnly: true))

// ⚠️ 窗口尺寸是**判据的一部分**：够宽 ⇒ 段落不会被挤成两行，`D7`（折行只发生一次）才有意义；
//    够高 ⇒ 14 块全在视口内，逐块量几何不需要滚动。可用环境变量覆盖。
let w = Double(ProcessInfo.processInfo.environment["PROBE_W"] ?? "") ?? 1000
let h = Double(ProcessInfo.processInfo.environment["PROBE_H"] ?? "") ?? 1600
let rect = NSRect(x: 0, y: 0, width: w, height: h)
let webView = WKWebView(frame: rect, configuration: config)
private let delegate = Delegate()
webView.navigationDelegate = delegate

let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView
window.alphaValue = 0

// ⚠️ **不调 `makeKey()` / `makeFirstResponder`**：页内事件是**派发到 DOM 元素**上的，
//    不需要键盘焦点（⛔ 也不是"顺手少一处写"，见文件头）。
window.orderBack(nil)

DispatchQueue.main.async {
    let html = URL(fileURLWithPath: (pageDir as NSString).appendingPathComponent("index.html"))
    if FileManager.default.fileExists(atPath: html.path) {
        webView.loadFileURL(html, allowingReadAccessTo: URL(fileURLWithPath: pageDir))
    } else {
        FileHandle.standardError.write("⛔ 找不到 \(html.path)\n".data(using: .utf8)!)
        exit(1)
    }
    FileHandle.standardError.write("▶ 加载 \(html.path)（\(Int(w))×\(Int(h))）\n".data(using: .utf8)!)
}

// ⚠️ 兜底超时：逐块 14 轮 ×（进入 + 退出 + 若干帧）＋ F6 的 60 步折行，正常十几秒。
//    给 180 秒 —— ⛔ 又不足以让"某处真的挂死"蒙混过去。macOS **没有** `timeout(1)`。
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 180) {
    if Date().timeIntervalSince(wall) >= 179.5 {
        FileHandle.standardError.write("⛔ 180 秒没拿到结果\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
