// rmd · 文件树右键菜单探针（跑 `design/0034` §8 第 5 条 ＋ `design/0035` §3.8 的 A4 / B8–B13，
// 页面侧在 tree-menu-harness.js）
//
// ⭐ **不弹窗、不抢焦点、不合成系统按键、不写用户剪贴板**（根 `CLAUDE.md` 工作约定 4）：
//    `.prohibited` + `.borderless` + `alphaValue = 0` + `orderBack`，页面脚本只改自己那一份 DOM；
//    剪贴板由 harness 换成**记账桩子**，⛔ 真 `navigator.clipboard` 一次都不碰。
//    ⛔ 全程不调 `NSApp.activate`、⛔ 不用 `osascript` / `System Events`。
//
// ⚠️ 激活策略与 `dir-session-probe` 同档（**⛔ 不是** `scroll-sync` 那一族的 `.accessory`）：
//    2026-10-21 实测「从正在前台的终端里起进程时，`.accessory` 仍会被 AppKit 激活」
//    （`docs/kb/0025`，`makeKey()` 是**无关变量**）⇒ `.prohibited` 是结构上唯一不允许被激活的档位。
//    本探针的判据只看 DOM 与回调计数，⛔ 不依赖 rAF / 键盘焦点 ⇒ 代价为零。
//
// ⭐ 判据 E（"前台被抢过没有"）就在这里算：起跑前 / 收工时各取一次
//    `frontmostApplication`，再加 `NSApp.isActive` / `isKeyWindow` 两条结构自证，
//    写进 JSON 的 `环境`，由 `.sh` 的聚合器记成判据。
//
// 用法： tree-menu-probe <pageDir>
// 输出： 一行 JSON 到 stdout（页面 `window.__RUN()` 的返回值）
// 退出码：0 = 拿到结果（⚠️ 结论在 JSON 里）；1 = 环境/加载/超时

import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: tree-menu-probe <pageDir>\n".data(using: .utf8)!)
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
// ⚠️⚠️ **`.prohibited`，⛔ 不是 `scroll-sync-probe` 那一族的 `.accessory`**（见文件头与 `kb/0025`）：
//    `.accessory` 只是"没有 Dock 图标"，**仍然可以被激活**；从终端里起的进程会被 AppKit 抢去激活。
//    `.prohibited` 是唯一一个**结构上不允许被激活**的档位 ⇒ 从根上断掉这条路。
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

// ⚠️ **不调 `makeKey()` / `makeFirstResponder`**：判据只看 DOM 与回调计数，
//    ⛔ 不依赖 rAF、⛔ 不依赖键盘、⛔ 不依赖焦点 ⇒ 少一处对系统状态的写。
window.orderBack(nil)

DispatchQueue.main.async {
    let html = URL(fileURLWithPath: (pageDir as NSString).appendingPathComponent("index.html"))
    if FileManager.default.fileExists(atPath: html.path) {
        webView.loadFileURL(html, allowingReadAccessTo: URL(fileURLWithPath: pageDir))
    } else {
        FileHandle.standardError.write("⛔ 找不到 \(html.path)\n".data(using: .utf8)!)
        exit(1)
    }
    FileHandle.standardError.write("▶ 加载 \(html.path)\n".data(using: .utf8)!)
}

// ⚠️ 兜底超时：每条判据都是同步/微任务级的 DOM 操作，通常几秒内。
//    给 150 秒 —— ⛔ 又不足以让"某处真的挂死"蒙混过去。macOS **没有** `timeout(1)`。
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 150) {
    if Date().timeIntervalSince(wall) >= 149.5 {
        FileHandle.standardError.write("⛔ 150 秒没拿到结果\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
