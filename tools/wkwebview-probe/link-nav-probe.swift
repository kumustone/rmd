// rmd · 文档内链接导航探针（跑 `design/0026` §7.2 的判据 1–5，页面侧在 link-nav-harness.js）
//
// ⭐ **不弹窗、不抢焦点、不合成系统按键**（根 `CLAUDE.md` 工作约定 4）：
//    `.prohibited` + `.borderless` + `alphaValue = 0` + `orderBack`。
//    ⛔ 全程不调 `NSApp.activate`、⛔ 不调 `makeKey()`、⛔ 不用 `osascript` / `System Events`。
//    ⭐ 激活策略取 `.prohibited` 的理由与 `dir-session-probe.swift` 逐字同源
//    （2026-10-21 实测：启动本进程的终端正站在前台时，`.accessory` 会被 AppKit 激活，`kb/0025`）。
//
// ⭐ **本探针独有的那一件**：它是 Tauri `on_navigation` / `on_new_window` 那层闸门的**等价物**——
//    `decidePolicyFor` 记下**每一次**导航请求（url ＋ 时刻），并一律 `.cancel`：
//    · 入口页那一次放行（不放行连页面都打不开）；
//    · 其余一律**记录后拒绝** ⇒ "闸门拒绝之后页面还在原地址"在页面侧是**可观察**的。
//    ⚠️ 这不只是"模拟"：`wry` 的 `on_navigation` 用的就是同一个 `decidePolicyFor` 钩子，
//       所以"同文档锚点走不走它"这个问题这里答得了（`design/0026` §7.1 0a）。
//
// 用法： link-nav-probe <pageDir>
// 输出： 一行 JSON 到 stdout（页面 `window.__RUN()` 的返回值 ＋ Swift 记的 `导航` 与 `环境`）
// 退出码：0 = 拿到结果（⚠️ 结论在聚合器里）；1 = 环境/加载/超时；2 = 用法

import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: link-nav-probe <pageDir>\n".data(using: .utf8)!)
    exit(2)
}
let pageDir = args[1]
let indexPath = (pageDir as NSString).appendingPathComponent("index.html")
let 入口URL = URL(fileURLWithPath: indexPath).absoluteString

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
    /// ⭐ 导航日志：**每一次** `decidePolicyFor`（入口页那一次除外）。
    /// `ms` 与页面侧 `Date.now()` 是同一只墙钟 ⇒ 聚合器按步骤窗口归位。
    var 导航: [[String: Any]] = []

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url?.absoluteString ?? ""
        if url == 入口URL {
            decisionHandler(.allow)
            return
        }
        导航.append([
            "url": url,
            "ms": Int(Date().timeIntervalSince1970 * 1000),
            "type": Int(navigationAction.navigationType.rawValue),
            "主框架": navigationAction.targetFrame?.isMainFrame ?? false,
        ])
        // ⚠️ **一律拒绝**：本探针要的是"闸门收到过什么"，⛔ 不是"把页面导去别处"。
        //    表现上这就是 Tauri `on_navigation` 返回 false 的那一格。
        decisionHandler(.cancel)
    }

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
                // ⭐ 导航日志随结果一起出去（聚合器按步骤的 t0/t1 归位）。
                // ⚠️⚠️ 必须在这里读 `self.导航`，⛔ 不能像第一版那样在 `didFinish` 开头
                //    拷一份常量：`Array` 是值类型，拷完之后 `decidePolicyFor` 追加的条目
                //    落在 `self.导航` 上、拷出去的那份**永远停在"入口页加载完"那一刻**
                //    ⇒ 每一条导航都"没发生过"，对照组（判据 2）必假红。
                obj["导航"] = self.导航
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
        // ⚠️ 我们**故意**取消每一次导航 ⇒ `NSURLErrorCancelled` 是正常路径，⛔ 不是失败。
        if (error as NSError).code == NSURLErrorCancelled { return }
        FileHandle.standardError.write("⛔ 导航失败：\(error)\n".data(using: .utf8)!)
        exit(1)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
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
// ⚠️ 本探针不依赖 rAF、不依赖键盘焦点 ⇒ ⛔ 不调 `makeKey()` / `makeFirstResponder`
//    （少一处对系统状态的写；见 `kb/0025` 与本文件头）。
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

// ⚠️ 兜底超时：五步各等 180 ms ⇒ 通常两三秒内。给 120 秒。
//    macOS **没有** `timeout(1)`，所以由 `.sh` 再套一层看门狗。
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 120) {
    if Date().timeIntervalSince(wall) >= 119.5 {
        FileHandle.standardError.write("⛔ 120 秒没拿到结果\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
