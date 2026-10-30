// rmd · 图片缩放预览探针（跑 `design/0018` §7.4 的 25 条判据，页面侧在 image-viewer-harness.js）
//
// ⭐ **不弹窗、不抢焦点、不合成系统按键**（根 `CLAUDE.md` 工作约定 4）：
//    `.prohibited` + `.borderless` + `alphaValue = 0`，页面脚本只改自己那一份 DOM。
//    ⛔ 全程不调 `NSApp.activate`、⛔ 不用 `osascript` / `System Events`。
//
// ⚠️⚠️ 与 `scroll-sync-probe` / `reading-progress-probe` 同一个已知风险面：**rAF 不保证来**
//    （`kb/0022` 的口径是"可以用，但每次都要自证"）⇒ 页面侧 E 那条自证失败时，
//    要等落定的那几条记**「跳过」**，⛔ 不是「失败」。
//    ⭐ 窗口因此必须被 `order` 过一次（只 `orderBack`）：只 `alphaValue = 0`
//    而**从不 order** 的窗口，WebKit 把它当"完全不可见" ⇒ **一帧都不派**。
//
// ⭐⭐ **五个阶段，窗口尺寸由这里改**（`design/0018` §7.4 第 20/21 条要真 resize）：
//    ① `__RUN`              窗口 1000×720（判据 1–19、22–25）
//    ② `__RUN_RESIZE_BIG`   放大到 1400×900（判据 20 前半：新 fit 更大，manual 不被顶走）
//    ③ `__RUN_RESIZE_TINY`  缩到 600×400（判据 20 后半：比例仍是有限正数）
//    ④ `__RUN_RESIZE_MICRO` 缩到 64×52（判据 21 前半：留白吃光 ⇒ fit 回落 MIN_SCALE）
//    ⑤ `__RUN_RESIZE_BACK`  回到 1000×720（判据 21 后半：手动比例仍保持）
//
// ⚠️ **时序**：resize 必须在**阶段函数已经开始（监听器已挂上）之后**才发生，
//    否则页面等不到那次 `resize` ⇒ 于是这里是"**先调阶段、同时排一个 600 ms 后的改尺寸**"。
//    ⛔ 不能"先改尺寸再调阶段"——那样 `resize` 事件早于监听到达，判据永远等不到。
//
// ⭐ 环境自证（"前台被抢过没有"）在这里算：起跑前 / 收工时各取一次 `frontmostApplication`，
//    写进 JSON 的 `环境.前台被抢过`，由 `.sh` 的聚合器记成判据。
//
// 用法： image-viewer-probe <pageDir>
// 输出： 一行 JSON 到 stdout（五个阶段 `检查` 的拼接 ＋ `环境` ＋ `夹具`）
// 退出码：0 = 拿到结果（⚠️ 结论在 JSON 里）；1 = 环境/加载/超时

import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: image-viewer-probe <pageDir>\n".data(using: .utf8)!)
    exit(2)
}
let pageDir = args[1]

/// ⚠️ 用 `callAsyncJavaScript`：老的 `evaluateJavaScript` **不 await Promise**。
/// ⚠️ 让页面自己管等待（它在内部用 `setInterval` 轮询尺寸 + 两帧 rAF），
///    ⛔ Swift 这边不替它等 rAF。
func runner(_ name: String) -> String {
    """
    if (typeof window['\(name)'] !== 'function') {
      return { 致命: 'harness 没跑起来（window.\(name) 不是函数）；加载期错误：'
        + JSON.stringify(window.__LOADERR || []) };
    }
    return await window['\(name)']();
    """
}

/// 五个阶段：(入口函数名, 进入该阶段后要改的窗口尺寸)。
let STAGES: [(String, NSSize?)] = [
    ("__RUN", nil),
    ("__RUN_RESIZE_BIG", NSSize(width: 1400, height: 900)),
    ("__RUN_RESIZE_TINY", NSSize(width: 600, height: 400)),
    ("__RUN_RESIZE_MICRO", NSSize(width: 64, height: 52)),
    ("__RUN_RESIZE_BACK", NSSize(width: 1000, height: 720)),
]

private final class Delegate: NSObject, WKNavigationDelegate {
    private let 起跑前前台 = NSWorkspace.shared.frontmostApplication?.localizedName ?? "未知"
    private let 起跑时刻 = Date()

    let webView: WKWebView
    let window: NSWindow
    private var 检查: [[String: Any]] = []
    private var 阶段记录: [[String: Any]] = []
    private var 夹具: Any = NSNull()

    init(webView: WKWebView, window: NSWindow) {
        self.webView = webView
        self.window = window
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        FileHandle.standardError.write("· didFinish，开始跑第 1 阶段\n".data(using: .utf8)!)
        跑阶段(0)
    }

    private func 跑阶段(_ i: Int) {
        if i >= STAGES.count {
            收工()
            return
        }
        let (名字, 尺寸) = STAGES[i]
        if let 尺寸 = 尺寸 {
            // ⚠️ **先排、后调**：页面阶段一开始就装上尺寸监听，600 ms 后才真的改。
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                self?.window.setContentSize(尺寸)
                FileHandle.standardError.write(
                    "· 窗口改成 \(Int(尺寸.width))×\(Int(尺寸.height))\n".data(using: .utf8)!)
            }
        }
        FileHandle.standardError.write("· 阶段 \(i + 1)：\(名字)\n".data(using: .utf8)!)
        webView.callAsyncJavaScript(runner(名字), arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .failure(let error):
                FileHandle.standardError.write("⛔ \(名字) 失败：\(error)\n".data(using: .utf8)!)
                exit(1)
            case .success(let value):
                guard let obj = value as? [String: Any] else {
                    FileHandle.standardError.write(
                        "⛔ \(名字) 返回值不是对象：\(String(describing: value))\n".data(using: .utf8)!)
                    exit(1)
                }
                if let 致命 = obj["致命"] {
                    FileHandle.standardError.write("⛔ 致命：\(致命)\n".data(using: .utf8)!)
                    exit(1)
                }
                if let list = obj["检查"] as? [[String: Any]] {
                    self.检查.append(contentsOf: list)
                }
                if i == 0 {
                    self.夹具 = obj["夹具"] ?? NSNull()
                }
                self.阶段记录.append(["阶段": i + 1, "入口": 名字])
                self.跑阶段(i + 1)
            }
        }
    }

    private func 收工() {
        // ── 环境自证：窗口状态 ＋ 有没有动到用户的前台应用 ──
        let 现在前台 = NSWorkspace.shared.frontmostApplication?.localizedName ?? "未知"
        let 窗口: [String: Any] = [
            "isVisible": window.isVisible,
            "alpha": Double(window.alphaValue),
            "windowNumber": Int(window.windowNumber),
            "调过_NSApp_activate": false,
            "最后尺寸": [Int(window.frame.width), Int(window.frame.height)],
        ]
        var env: [String: Any] = [:]
        env["窗口"] = 窗口
        env["阶段"] = 阶段记录
        env["前台应用_起跑前"] = 起跑前前台
        env["前台应用_收工时"] = 现在前台
        env["前台被抢过"] = (起跑前前台 != 现在前台)
        env["墙钟秒"] = (Date().timeIntervalSince(起跑时刻) * 1000).rounded() / 1000
        if 起跑前前台 != 现在前台 {
            FileHandle.standardError.write(
                "⚠️⚠️ 前台应用从「\(起跑前前台)」变成了「\(现在前台)」——这次跑的数不要信\n"
                    .data(using: .utf8)!)
        }
        let obj: [String: Any] = ["检查": 检查, "环境": env, "夹具": 夹具]
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else {
            FileHandle.standardError.write("⛔ 返回值不能序列化\n".data(using: .utf8)!)
            exit(1)
        }
        print(json)
        exit(0)
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

let rect = NSRect(x: 0, y: 0, width: 1000, height: 720)
let webView = WKWebView(frame: rect, configuration: config)
webView.autoresizingMask = [.width, .height]

let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView
window.alphaValue = 0

private let delegate = Delegate(webView: webView, window: window)
webView.navigationDelegate = delegate

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

// ⚠️ 兜底超时：五个阶段里有四个各等 resize（尺寸轮询 2.5 s 上限），加起来约 25 秒。
//    给 180 秒足够，⛔ 又不足以让"某处真的挂死"蒙混过去。
//    macOS **没有** `timeout(1)`，兜底只能自己带。
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 180) {
    if Date().timeIntervalSince(wall) >= 179.5 {
        FileHandle.standardError.write("⛔ 180 秒没拿到结果\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
