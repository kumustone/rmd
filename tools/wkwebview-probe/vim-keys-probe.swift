// rmd · 编辑态 Vim 键位探针（`docs/design/0014` §7 步骤 0：0b/0c/0d-①/0e/0f）
//                                页面侧在 `vim-keys-harness.js`
//
// ⭐ **不弹窗、不抢焦点、不合成系统按键**（根 `CLAUDE.md` 工作约定 4）：
//    `.prohibited` + `.borderless` + `alphaValue = 0`，页面脚本只往**自己那几个容器**里
//    `dispatchEvent`（那是**页内合成事件**，⛔ 不是"合成系统按键"——它到不了别的进程）。
//    ⛔ 全程不调 `NSApp.activate`、⛔ 不用 `osascript` / `System Events`。
//
// ⚠️⚠️ 两个已知的离屏风险面，页面侧各有一条**自证**（E1 的 rAF、E3 的 activeElement）：
//    · **rAF 不保证来**（`cm6-probe.swift` 第一版挂在"等 rAF 永不回调"上，
//      `kb/0022` 之后的口径是"可以用，但**每次都要自证**"）；
//    · **真 DOM 焦点拿不到**（`edit-chrome-probe` 实测 `document.hasFocus() === false`）
//      ⇒ 页面侧会**手动补 `.cm-focused` 类**，并在 E3 里如实记这一步有没有发生。
//    ⇒ 自证失败时依赖它的检查记**「跳过」**，⛔ 不是「失败」——环境不成立与实现坏了是两件事。
//
// ⭐⭐ **窗口因此必须被 `order` 过一次**（只 `orderBack`，取自
//    `editor-keyprobe.swift` / `scroll-sync-probe.swift` 那条已验过的路）：
//    只 `alphaValue = 0` 而**从不 order** 的窗口，WebKit 把它当"完全不可见"
//    ⇒ **一帧都不派**（`scroll-sync-probe` 第一版实测：1000 ms 里 0 帧）——
//    而块光标那条判据（0e）**正靠 measure 循环**，帧不来它就不出现。
//    `orderBack` 让它排到**用户前台应用之后**、又是全透明的；`.prohibited` 策略下
//    本进程**结构上不允许被激活**（⚠️ 2026-10-21 由 `.accessory` 改的，见 `kb/0025`），
//    且 ⛔ **从不 `NSApp.activate`** ⇒ 用户感知不到。
//    ⚠️ 下面还留了一条**前台自证**：起跑前后比一次 `frontmostApplication`，
//    变了就**响亮地说出来**（那次跑的数不要信）。
//
// 用法： vim-keys-probe <pageDir>
// 输出： 一行 JSON 到 stdout（页面 `window.__RUN()` 的返回值）
// 退出码：0 = 拿到结果（⚠️ **结论在 JSON 里**，不在这个码上）；1 = 环境/加载/超时；
//        2 = 用法错

import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: vim-keys-probe <pageDir>\n".data(using: .utf8)!)
    exit(2)
}
let pageDir = args[1]

// ⚠️ 用 `callAsyncJavaScript`：老的 `evaluateJavaScript` **不 await Promise**，
//    会报 "returned a result of an unsupported type"。
// ⚠️ 让页面自己管等待（它内部用 `等()` ＝ 轮询 + 自造超时），⛔ Swift 这边不替它等 rAF。
let RUNNER = """
  return await window.__RUN();
"""

private final class Delegate: NSObject, WKNavigationDelegate {
    private let 起跑前前台 = NSWorkspace.shared.frontmostApplication?.localizedName ?? "未知"
    private let 起跑时刻 = Date()

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        FileHandle.standardError.write("· didFinish，开始跑 window.__RUN()\n".data(using: .utf8)!)
        // ⚠️ 闭包是 escaping 的 ⇒ 这两个值先取成局部常量（它们就是"起跑那一刻"的快照）。
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
// ⚠️⚠️ **`.prohibited`，⛔ 不是 `.accessory`**（`kb/0025` ＋ 2026-10-21 判别器实测）：
//    `.accessory` 只是"没有 Dock 图标"，**仍然可以被激活**——从**正在前台的终端**里起进程时，
//    AppKit 会把本进程激活（实测 `frontmostApplication` 由 `iTerm2` 变成探针自己）。
//    `.prohibited` 是唯一"结构上不允许被激活"的档位，**且实测不损 rAF**：
//    同样 `alphaValue = 0` ＋ `orderBack`，两种策略各量到 **63 帧 / 1000 ms**，
//    而 `.prohibited` 前后 `frontmostApplication` 不变、`NSApp.isActive == false`。
_ = app.setActivationPolicy(.prohibited)

let config = WKWebViewConfiguration()
config.suppressesIncrementalRendering = false

// ⚠️ 尺寸要**够大**：四个 EditorView 竖排，每个都要有可量的布局（0e 全靠它）。
let rect = NSRect(x: 0, y: 0, width: 1400, height: 1000)
let webView = WKWebView(frame: rect, configuration: config)
private let delegate = Delegate()
webView.navigationDelegate = delegate

let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView
window.alphaValue = 0

// ⚠️⚠️ 这四行是**必须的**，不是为了"能看见"：
//    · `orderBack`（⛔ 不是 `orderFront`、⛔ 不是 `makeKeyAndOrderFront`）——
//      只 `alphaValue = 0` 而从不 order 的窗口，WebKit 当它完全不可见 ⇒ **一帧 rAF 都不派**。
//      `orderBack` 把它排在用户前台应用**之后**。
// ⚠️⚠️ **只有 `orderBack` 是必须的**（不是为了「能看见」）：只 `alphaValue = 0` 而从不
//    order 的窗口，WebKit 当它完全不可见 ⇒ **一帧 rAF 都不派**（第一版实测 1000 ms / 0 帧）。
//    `orderBack` 把它排在用户前台应用**之后**。
//    ⛔ **`makeKey()` / `makeFirstResponder` 已删**（2026-10-21 实测）：`kb/0025` 证明它对
//    「抢前台」是**无关变量**；同日判别器又量到它对 rAF 也无影响（有/无都是 63 帧/1000 ms），
//    并且 `.prohibited` 下 `isKeyWindow` 恒为 false ⇒ 留着只是多写一次系统状态。
//    ⚠️ 若哪天某条判据真的要「窗口是 key」，**先回来读这段**，⛔ 别默默加回去。
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

// ⚠️ 兜底超时：这一份比 `scroll-sync-probe` **重**（0e 要对三套主题各等一次块光标回来，
//    每次 2 秒；再加 0c/0d 那几十条 dispatch）⇒ rAF 到位时约 20–30 秒，
//    rAF 全不来时每一步都要走各自的兜底，累起来约 60 秒。给 200 秒足够，
//    ⛔ 又不足以让"某处真的挂死"蒙混过去。
//    macOS **没有** `timeout(1)`（那是 coreutils 的 `gtimeout`），兜底只能自己带。
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 200) {
    if Date().timeIntervalSince(wall) >= 199.5 {
        FileHandle.standardError.write("⛔ 200 秒没拿到结果\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
