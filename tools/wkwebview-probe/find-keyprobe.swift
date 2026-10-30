// rmd · 「正文内查找」探针 B：**WKWebView 吞不吞 `⌘F`**（`design/0011` §7 步骤 0b）
//
// ⚠️ 这是**设计期取证工具**，不是产品代码。产物进 `docs/research/notes/0015`。
//
// ⛔⛔ **这是全仓唯一会合成「系统级真按键」的探针**（`osascript` / `System Events` → 前台应用）。
//    根 `CLAUDE.md` 工作约定 4 明令禁止这类动作 ⇒ **⛔ 不经用户明确同意，不得运行**。
//    它的 `.regular` 激活策略与 `makeKeyAndOrderFront` **不能**改（改了就测不了），
//    这是 `kb/0025` 边界的另一实例：这条证据链**只可能**由一次知情的前台实验补上。
//
// 为什么非测不可：`design/0011` 拟把 `⌘F` 归 `Owner::Web`（前端 `keydown` 处理、⛔ 不进菜单）。
// 若 AppKit / WebKit 在事件到达网页**之前**就把它吃掉，`Owner::Web` 会**静默失效**——
// 页面上一切正常、浮层永远打不开（`kb/0016` §6 同族的静默失效）。
//
// 本探针**复刻 rmd 的两条关键前提**（依据 `docs/kb/0016` §1 那张实测表）：
//   ① 菜单栏里**没有任何**声称 `⌘F` 的项——`Edit` = Undo/Redo/Cut/Copy/Paste/Select All，
//      `View` 只有 Full Screen（是 **⌃⌘F**，⛔ 不是 ⌘F）；
//   ② 正文**不可编辑**（rmd 是只读阅读器，⛔ 不是 `contenteditable`）。
//
// ⭐ 判据分三层，缺一不可（只看其中一层会得出错的结论）：
//   A. 页面侧：`keydown` 收不收得到，且 `e.key === "f" && e.metaKey`？——`Owner::Web` 的成立条件
//   B. 页面侧：`defaultPrevented` 是什么？（我们没 preventDefault，所以它应当 `false`）
//   C. 原生侧：`performKeyEquivalent:` / `keyDown:` / `performTextFinderAction:` 有没有被调到、
//      `super` 返回什么、`usesFindBar` 是什么、事后有没有多出一个窗口。
//      ——用来区分「AppKit 吃了」「WebKit 内部吃了」与「根本没人吃」。
//
// ⚠️⚠️ **必须带对照组**：只发 `⌘F` 的话，「收不到」有两种成因——被吞、或**根本没人按键**
//      （System Events 没有辅助功能权限时**静默不送**）。所以本探针同时发一个**无主键**
//      （`⌘K`，全项目没绑）作对照：对照也没到 ⇒ 是权限问题，⛔ **不是"被吞"**。
//
// ⚠️ 本探针**只回答 `⌘F` 这一条**。它与 `find-probe.swift`（0a/0c）是**两个**探针：
//    那个量的是成本，这个量的是**路由**。
//
// 用法（⚠️ 它自己不发键，按键由 runner 合成）：
//   tools/wkwebview-probe/find-keyprobe.sh              # 跑一轮并落盘
//   tools/wkwebview-probe/find-keyprobe.sh --stdout     # 只打屏幕
//   WAIT=20 tools/wkwebview-probe/find-keyprobe.sh      # 加长等待窗口
//
// 单独跑：swiftc -O find-keyprobe.swift -o find-keyprobe && ./find-keyprobe
//         （另一终端：osascript -e 'tell application "System Events" to keystroke "f" using command down'）

import Cocoa
import WebKit

// ─────────────────────────── 原生侧观察点 ───────────────────────────

private var nativeLog: [String] = []

final class ProbeWebView: WKWebView {
    /// ⛔ 不设 `usesFindBar`——默认真值就是我们要观察的东西之一（rmd 也是默认值）
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let consumed = super.performKeyEquivalent(with: event)
        nativeLog.append("WKWebView.performKeyEquivalent key=\(event.charactersIgnoringModifiers ?? "?") superReturned=\(consumed)")
        return consumed
    }
    override func keyDown(with event: NSEvent) {
        nativeLog.append("WKWebView.keyDown key=\(event.charactersIgnoringModifiers ?? "?") mods=\(event.modifierFlags.rawValue)")
        super.keyDown(with: event)
    }
    /// ⭐ 这一条是「WebKit 自己开了查找」的**直接**判据。它若被调到，`⌘F` 就到不了页面。
    @objc override func performTextFinderAction(_ sender: Any?) {
        nativeLog.append("⛔ WKWebView.performTextFinderAction 被调到 —— WebKit 自己想吃 ⌘F")
        super.performTextFinderAction(sender)
    }
    override var acceptsFirstResponder: Bool { true }
}

final class ProbeWindow: NSWindow {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let consumed = super.performKeyEquivalent(with: event)
        nativeLog.append("NSWindow.performKeyEquivalent key=\(event.charactersIgnoringModifiers ?? "?") superReturned=\(consumed)")
        return consumed
    }
}

// ─────────────────────────── 菜单（复刻 Tauri 默认，⛔ 无 ⌘F） ───────────────────────────

private func buildMenu() {
    let main = NSMenu()
    func submenu(_ title: String) -> NSMenu {
        let item = NSMenuItem()
        main.addItem(item)
        let m = NSMenu(title: title)
        item.submenu = m
        return m
    }

    let appMenu = submenu("Probe")
    appMenu.addItem(withTitle: "About Probe", action: nil, keyEquivalent: "")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Hide Probe", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Quit Probe", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

    let file = submenu("File")
    file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

    // Edit —— 与 kb/0016 §1 的表逐项对齐，⛔ 无 Find
    let edit = submenu("Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(redo)
    edit.addItem(NSMenuItem.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

    // View —— macOS 上**只有 Full Screen**，且它是 ⌃⌘F（⛔ 不是 ⌘F）
    let view = submenu("View")
    let full = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
    full.keyEquivalentModifierMask = [.command, .control]
    view.addItem(full)

    let window = submenu("Window")
    window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")

    _ = submenu("Help")
    NSApp.mainMenu = main
}

// ─────────────────────────── 页面（只读正文） ───────────────────────────

private let HTML = """
<!doctype html><html><head><meta charset="utf-8"><title>rmd-0b-probe</title>
<style>body{font:16px/1.7 -apple-system;margin:0;padding:24px}#doc{max-width:720px}</style>
</head><body>
<div id="doc">
  <h1>正文内查找探针</h1>
  <p>这一段里有若干可搜的词：查找 查找 查找。下面用来验证 keydown 是否到得了页面。</p>
  <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.</p>
</div>
<script>
window.__cap = [];   // capture 阶段（比一切 handler 早）
window.__bub = [];   // bubble 到 window（最晚，能看到 defaultPrevented 的终值）
window.__prevented = [];
function snap(e){
  return { key: e.key, code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey,
           alt: e.altKey, repeat: e.repeat, keyCode: e.keyCode,
           targetTag: e.target && e.target.tagName, defaultPrevented: e.defaultPrevented };
}
document.addEventListener('keydown', function(e){ window.__cap.push(snap(e)); }, true);
window.addEventListener('keydown', function(e){
  var rec = snap(e);
  window.__bub.push(rec);
  setTimeout(function(){ rec.afterDefaultPrevented = e.defaultPrevented; }, 0);
});
var _pd = Event.prototype.preventDefault;
Event.prototype.preventDefault = function(){
  if (this.type === 'keydown') { window.__prevented.push(this.key); }
  return _pd.apply(this, arguments);
};
</script>
</body></html>
"""

// ─────────────────────────── 主流程 ───────────────────────────

final class Delegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: ProbeWindow!
    var web: ProbeWebView!
    /// 等待窗口：外部在这段时间里合成按键。
    /// ⚠️ 必须宽到够跑完「两轮 osascript + 一次 13 s 的 dump」——runner 用 READY 对齐，不靠它。
    private let waitSeconds = Double(ProcessInfo.processInfo.environment["WAIT"] ?? "") ?? 16.0
    /// ⚠️ 记的是**集合**，⛔ 不是个数：WKWebView 一加载，AppKit 就会建一个**隐藏**的
    /// `TUINSWindow`（文本输入辅助窗口，`visible=false`）——**不发任何键也在**
    /// （2026-10-14 实测：零按键对照组的窗口数同样是 1→2）。
    /// ⇒ 只报"多出来的**新**窗口、且**可见**"，否则每次都会误报一个数。
    private var windowsBefore: Set<ObjectIdentifier> = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let rect = NSRect(x: 0, y: 0, width: 820, height: 560)
        window = ProbeWindow(contentRect: rect,
                             styleMask: [.titled, .closable, .resizable],
                             backing: .buffered, defer: false)
        window.title = "rmd 0b 探针"

        web = ProbeWebView(frame: rect, configuration: WKWebViewConfiguration())
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        window.contentView = web

        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        windowsBefore = Set(NSApp.windows.map(ObjectIdentifier.init))

        web.loadHTMLString(HTML, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        window.makeFirstResponder(webView)
        NSApp.activate(ignoringOtherApps: true)
        // ⚠️ 等待窗口里**持续**把焦点抢回来：`osascript` 每次起进程要几百毫秒，
        //    期间只要探针丢了前台，`System Events` 就把键送到**别的应用**上——
        //    表现是"对照组也没到"，与"被吞"**同形**（第一轮实测踩到过）。
        Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            self.window.makeFirstResponder(self.web)
        }
        // 给外部脚本把窗口抬到最前的时间，然后打 READY（runner 以它对齐）
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            print("READY"); fflush(stdout)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + waitSeconds) { self.dump() }
    }

    private func dump() {
        let js = """
        JSON.stringify({
          keys: window.__bub || [],
          capture: window.__cap || [],
          prevented: window.__prevented || [],
          hasFocus: document.hasFocus(),
          activeEl: document.activeElement ? document.activeElement.tagName : null
        })
        """
        let respondsFinder = web.responds(to: Selector(("performTextFinderAction:")))
        web.evaluateJavaScript(js) { value, error in
            var page: Any = "eval-error: \(error.map { String(describing: $0) } ?? "nil")"
            if let s = value as? String, let d = s.data(using: .utf8),
               let o = try? JSONSerialization.jsonObject(with: d) { page = o }
            let out: [String: Any] = [
                "回答": "design/0011 §7 步骤 0b：Owner::Web 下 ⌘F 到不到得了页面",
                "前提": [
                    "菜单里有_⌘F_的项": false,
                    "正文可编辑": false,
                    "responds_to_text_finder": respondsFinder,
                ],
                "原生侧": [
                    "日志": nativeLog,
                    "app_isActive": NSApp.isActive,
                    "window_isKey": self.window.isKeyWindow,
                    "window_isVisible": self.window.isVisible,
                    "全部窗口": NSApp.windows.map {
                        "\(type(of: $0)) title=\($0.title) visible=\($0.isVisible)"
                    },
                    "新增窗口": NSApp.windows.filter {
                        !self.windowsBefore.contains(ObjectIdentifier($0))
                    }.map {
                        "\(type(of: $0)) title=\($0.title) visible=\($0.isVisible)"
                    },
                    "新增且可见的窗口数": NSApp.windows.filter {
                        !self.windowsBefore.contains(ObjectIdentifier($0)) && $0.isVisible
                    }.count,
                ],
                "页面侧": page,
            ]
            let data = try! JSONSerialization.data(withJSONObject: out,
                                                   options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            print(String(data: data, encoding: .utf8)!)
            fflush(stdout)
            NSApp.terminate(nil)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
app.run()
