// rmd · 目录会话恢复探针（跑 `design/0020` §7.4 的判据 46–54，页面侧在 dir-session-harness.js）
//
// ⭐ **不弹窗、不抢焦点、不合成系统按键**（根 `CLAUDE.md` 工作约定 4）：
//    `.prohibited` + `.borderless` + `alphaValue = 0` + `orderBack`，页面脚本只改自己那一份 DOM。
//    ⛔ 全程不调 `NSApp.activate`、⛔ 不用 `osascript` / `System Events`。
//
// ⚠️⚠️ ⭐ **本探针比 `reading-progress-probe` / `scroll-sync-probe` 那一族**更严一档**，
//    而那一档是被一次实测逼出来的（2026-10-21，详见文件下半段与 `kb/0025`）：
//    从**正在前台的终端**里起进程时，`.accessory` ＋ 一个已 `order` 的窗口
//    ⇒ AppKit 会把本进程**激活**（`frontmostApplication` 从 `iTerm2` 变成探针自己）。
//    ⇒ 本探针用 `.prohibited`（**结构上不允许被激活**），并且**不调 `makeKey()`**
//    （判据 46–52 只看 DOM 与回调计数，⛔ 不依赖 rAF、⛔ 不依赖键盘焦点）。
//
// ⭐ 判据 E（"前台被抢过没有"）就在这里算：起跑前 / 收工时各取一次
//    `frontmostApplication`，再加上 `NSApp.isActive` / `isKeyWindow` 两条结构自证，
//    写进 JSON 的 `环境`，由 `.sh` 的聚合器记成判据。
//
// 用法： dir-session-probe <pageDir>
// 输出： 一行 JSON 到 stdout（页面 `window.__RUN()` 的返回值）
// 退出码：0 = 拿到结果（⚠️ 结论在 JSON 里）；1 = 环境/加载/超时

import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: dir-session-probe <pageDir>\n".data(using: .utf8)!)
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
                    // ⭐ 两条**自证"没抢键盘焦点"**的判据（本探针不调 `makeKey`，
                    //    见文件下半段那段注释）：进程没有被激活、窗口不是 key。
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
// ⚠️⚠️ **`.prohibited`，⛔ 不是 `scroll-sync-probe` 那一族的 `.accessory`**（见文件下半段那段实测）：
//    `.accessory` 只是"没有 Dock 图标"，**仍然可以被激活**。而从终端里起的进程
//    （= 用户正在 iTerm2 里敲命令，那正是最主要的使用场景）**会被 AppKit 抢去激活**：
//    实测 `进程被激活 = true`、`frontmostApplication` 从 `iTerm2` 变成 `dir-session-probe`
//    —— 且**即使不调 `makeKey()` 也一样**（那次 `窗口是_key = false` 而进程已被激活）。
//    `.prohibited` 是唯一一个**结构上不允许被激活**的档位 ⇒ 从根上断掉这条路。
//    ⭐ 本探针不需要激活（不依赖 rAF、不依赖键盘焦点，见下）⇒ 代价为零。
//    ⚠️ 若哪天某条判据突然需要"窗口真的拿到焦点"，**先回来读这段话**，⛔ 别默默换回 `.accessory`。
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

// ⚠️⚠️ **这里与 `scroll-sync-probe` / `reading-progress-probe` 那一族有一处**有意的**不同**：
//    它们会补 `makeKey()` ＋ `makeFirstResponder`（它们要 rAF／要键盘，而只 `order` 过、
//    又全透明的窗口里 WebKit 才肯派帧）。⭐ 本探针**两者都不需要**：
//    判据 46–52 只看 DOM 与回调计数，⛔ 不依赖 rAF、⛔ 不依赖键盘、⛔ 不依赖焦点。
//    ⇒ **⛔ 不调 `makeKey()` / `makeFirstResponder`**：少一处对系统状态的写。
//    ⚠️⚠️ **但它⛔ 不是"抢前台"的解药**——这一点实测过，⛔ 别记反：
//       · 有 `makeKey()` ＋ 前台是 iTerm2 ⇒ 进程被激活（抢了前台）；
//       · 有 `makeKey()` ＋ 前台是别的 app ⇒ **未**被激活（连跑 4 轮都是 false）；
//       · **没有** `makeKey()` ＋ 前台是 iTerm2 ⇒ **仍被激活**（`窗口是_key = false` 而进程已激活）。
//    ⇒ `makeKey` 是**无关变量**；真正的触发器是**"启动本进程的那个终端正站在前台"**
//       （实测算法是：本进程的祖先是 `iTermServer` → `iTerm2`，而那一刻 iTerm2 是 frontmost）。
//       这正是"用户在终端里敲命令"这个**最主要的**使用场景 ⇒ 必须从根上断掉，
//       ⛔ 不许拿"大多数时候没事"糊过去（根 `CLAUDE.md` 工作约定 4）。
//       解药在上面那条：`.prohibited`。
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

// ⚠️ 兜底超时：判据 46–52 里最长的是判据 52（200 条展开），假 IPC 同步 resolve ⇒ 通常几秒内。
//    给 150 秒 —— ⛔ 又不足以让"某处真的挂死"蒙混过去。macOS **没有** `timeout(1)`。
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 150) {
    if Date().timeIntervalSince(wall) >= 149.5 {
        FileHandle.standardError.write("⛔ 150 秒没拿到结果\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
