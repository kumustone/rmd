// rmd · 位置映射原型探针（`design/0059` 阶段 C，页面侧在 posmap-harness.js）
//
// ⭐ **不弹窗、不抢焦点、不合成系统按键**（根 `CLAUDE.md` 工作约定 4）：
//    `.prohibited` + `.borderless` + `alphaValue = 0` + `orderBack`。
//    ⛔ 全程不调 `NSApp.activate`、⛔ 不调 `makeKey()`、⛔ 不用 `osascript` / `System Events`。
//    ⭐ 激活策略与 `dir-session-probe.swift` / `link-nav-probe.swift` 逐字同源
//    （2026-10-21 实测：启动本进程的终端站在前台时 `.accessory` 会被 AppKit 激活，`kb/0025`）。
//
// ⭐ 本探针**不依赖 rAF、不依赖布局几何**：位置映射只走 DOM 文本节点，⛔ 不等帧。
//    ⇒ 少一处对系统状态的写，也少一类"显示器睡了就没帧"的环境噪声。
//
// 用法： posmap-probe <pageDir>
// 输出： 一行 JSON 到 stdout（页面 `window.__RUN()` 的返回值 ＋ Swift 记的 `环境`）
// 退出码：0 = 拿到结果（⚠️ 结论在聚合器里）；1 = 环境/加载/超时；2 = 用法

import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: posmap-probe <pageDir>\n".data(using: .utf8)!)
    exit(2)
}
let pageDir = args[1]
let indexPath = (pageDir as NSString).appendingPathComponent("index.html")

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
                let 现在前台 = NSWorkspace.shared.frontmostApplication?.localizedName ?? "未知"
                let 窗口: [String: Any] = [
                    "isVisible": webView.window?.isVisible ?? false,
                    "alpha": Double(webView.window?.alphaValue ?? -1),
                    "windowNumber": Int(webView.window?.windowNumber ?? -1),
                    "调过_NSApp_activate": false,
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
// ⚠️⚠️ `.prohibited`，⛔ 不是 `.accessory`（同 `dir-session-probe.swift` 的那段实测）。
_ = app.setActivationPolicy(.prohibited)

let config = WKWebViewConfiguration()
config.suppressesIncrementalRendering = false

let rect = NSRect(x: 0, y: 0, width: 1000, height: 720)
let webView = WKWebView(frame: rect, configuration: config)
private let delegate = Delegate()
webView.navigationDelegate = delegate

let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView
window.alphaValue = 0
// ⚠️ 本探针不依赖 rAF、不依赖键盘焦点 ⇒ ⛔ 不调 `makeKey()` / `makeFirstResponder`（`kb/0025`）。
window.orderBack(nil)

DispatchQueue.main.async {
    if FileManager.default.fileExists(atPath: indexPath) {
        webView.loadFileURL(URL(fileURLWithPath: indexPath), allowingReadAccessTo: URL(fileURLWithPath: pageDir))
    } else {
        FileHandle.standardError.write("⛔ 找不到 \(indexPath)\n".data(using: .utf8)!)
        exit(1)
    }
    FileHandle.standardError.write("▶ 加载 \(indexPath)\n".data(using: .utf8)!)
}

// ⚠️ 兜底超时：macOS **没有** `timeout(1)`，由 `.sh` 再套一层看门狗。
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 120) {
    if Date().timeIntervalSince(wall) >= 119.5 {
        FileHandle.standardError.write("⛔ 120 秒没拿到结果\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
