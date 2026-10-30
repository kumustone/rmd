// rmd · 「文档列表」渲染成本的**取证探针**（`design/0041` §7 步骤 0 第一项）
//
// ⭐ **不弹窗、不抢焦点、不合成系统按键**（根 `CLAUDE.md` 工作约定 4）：
//    `.prohibited` + `.borderless` + `alphaValue = 0` + `orderBack`。
//    ⛔ 全程不调 `NSApp.activate` / `makeKey()`、⛔ 不用 `osascript` / `System Events`。
//    ⚠️ 激活策略选 `.prohibited` 的理由见 `kb/0025`（`.accessory` 仍可能被 AppKit 激活）。
//
// ⭐ 判据 E（"前台被抢过没有"）在这里自证：起跑前后各取一次 `frontmostApplication`，
//    加上 `NSApp.isActive` / `isKeyWindow` 两条结构自证，一起写进 JSON 的 `环境`。
//
// 用法： doclist-probe <pageDir>
// 输出： 一行 JSON 到 stdout（页面 `window.__RUN()` 的返回值）
// 退出码：0 = 拿到结果（⚠️ 结论在 JSON 里）；1 = 环境/加载/超时

import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: doclist-probe <pageDir>\n".data(using: .utf8)!)
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
// ⚠️ `.prohibited`：结构上不允许被激活（`kb/0025`）。
_ = app.setActivationPolicy(.prohibited)

let config = WKWebViewConfiguration()
config.suppressesIncrementalRendering = false

// ⚠️ 视口 1280 × 820：与同族探针一致。量的是**侧边栏内 280 × 760 的容器**，
//    视口只保证窗口足够装下它，不参与判据。
let rect = NSRect(x: 0, y: 0, width: 1280, height: 820)
let webView = WKWebView(frame: rect, configuration: config)
private let delegate = Delegate()
webView.navigationDelegate = delegate

let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView
window.alphaValue = 0

// ⚠️ `orderBack`（⛔ 不是 `orderFront`、⛔ 不是 `makeKeyAndOrderFront`）：
//    只 `alphaValue = 0` 而从不 order 的窗口，WebKit 当它完全不可见（同族探针实测）。
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

// ⚠️ 兜底超时 240 秒：四档 × 3 轮，5000 行那一档最慢。⛔ 又不是"挂死也能过"。
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 240) {
    if Date().timeIntervalSince(wall) >= 239.5 {
        FileHandle.standardError.write("⛔ 240 秒没拿到结果\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
