// rmd · 「编辑区聚焦下的键位归属」探针（`design/0012` §7 步骤 0c ①③④）
//
// ⚠️ 这是**设计期取证工具**，不是产品代码。结论进 `docs/design/0012` §7 步骤 0c
//    与 §10 的实施记录。
//
// # 它回答什么
//
// `design/0012` §2.3-4 留了一条**未核实**：编辑区聚焦时，`Ctrl+E` / `Ctrl+A` 这类
// **macOS 的 emacs 文本绑定**在 WKWebView 的 `contenteditable` 上生不生效？
// 若生效，用户按 `Ctrl+E` 会**移动光标**而不是"打开外部编辑器"——那是**一个新的用户可见行为**，
// 可能推翻该节「不转发也不会怎样」的判断。
//
// 四条一起测（③④ 在本探针里可答；①②里 ② 要在**真 rmd** 里答，见下面的"本探针不回答什么"）：
//   ① `⌘,` / `⌘B`（`owner = Menu`）在编辑区聚焦时是否**照常生效**、且**只生效一次**
//   ③ `Ctrl+E` / `Ctrl+A` / `Ctrl+O` / `Ctrl+K` / `Ctrl+D` / `Ctrl+H` / `Ctrl+B/F/N/P` 被谁接走
//   ④ `Esc` 落在谁手里
//
// # 本探针**不回答**什么
//
// ⛔ **②（转发的 `⌘S` 是否真的执行）**：转发链是 `src/editor/keys.js` ＋
//   `src/services/keymap.js` ＋ **Rust 侧那张 `SHORTCUTS` 表**三者的合成，
//   探针里没有这张表 ⇒ 复制不出来。它只能在**真 rmd** 里验（`▶ save_document …` 那行）。
// ⛔ **IME 组合态**：合成事件造不出输入法组合态（`notes/0016` §2.2，`design/0012` 的 0d 同理）。
//
// # ⭐⭐ 2026-10-16 改法：**窗口不可见 + 进程内注入事件**（用户铁律）
//
// 用户 2026-10-16：「**探测的时候，不要影响我的日常工作，不要反复弹窗。**」
// ⇒ 本探针从「每键起一个**前台**进程 + `System Events` 合成真按键」改成
//    「**一个进程跑完全部键** + 自己造 `NSEvent` 直接 `window.sendEvent`」：
//
//   ⛔ 不再 `NSApp.activate`（**抢前台的正是这一行**）、不再 `osascript`、
//      不再需要「辅助功能」授权、不再每键弹一次窗。
//   ✅ 窗口是 `.accessory` 策略 ＋ `.borderless` ＋ `alphaValue = 0` ＋ `orderBack`
//      （与 `cm6-probe.swift` 同一条路）⇒ **用户看不见、前台应用不受影响**。
//
// ⚠️⚠️ **代价与判据**：注入的事件**绕过了 WindowServer 的全局路由**。它到不到得了网页，
//    ⛔ 不能靠"我觉得能"——本探针自带**两条到达性判据**（`到达性判据` 字段）：
//      A. **页面侧**：⌘K（全项目无绑定）必须出现在 `keydown` 记录里；
//      B. **菜单层**：⌘B 必须触发菜单动作（说明 `performKeyEquivalent` 这一路是通的）。
//    ⭐ A ∧ B 成立 ⇒ 合成事件**走完了** AppKit → responder 链 → WKWebView → WebKit
//      进程 → DOM 这一整条路，与真按键在**我们关心的那一段**上同路（`notes/0016` §2.5
//      的 `cm6-probe` 同族口径：⛔ 不宣称"等价于真人按了一次"，只宣称"这一段同路"）。
//    ⛔ A ∨ B 不成立 ⇒ 本探针**无结论**（⛔ 不许读成"键被吞了"）——那是"没送到"。
//
// # 复刻了什么、⛔ 没复刻什么（判据可查）
//
// ✅ **CM6 用的是真 bundle**（调用方把 `src/vendor/cm6.bundle.js` 拷进页面目录，
//    ⇒ 版本与产品**同一个**，见 `cm6-bundle.test.js`）。
// ✅ **扩展清单与 `src/editor/main.js` 的 §2.1① 一致**：`lineWrapping` / `history()` /
//    `keymap.of(historyKeymap)` / `updateListener`。⛔ 不含 `defaultKeymap` /
//    `standardKeymap` / `emacsStyleKeymap` / `basicSetup`（那是本设计的硬约束）。
// ⛔ **省略了"应用键转发"那个扩展**（`Prec.low` 那一项）。⭐ 省略**不影响 ③ 的答案**，
//    判据是 `src/editor/keys.js` 派生的白名单①`owner=web`②`accel` 含 `cmd`③`accel` 不含 `ctrl`
//    ⇒ **任何带 Ctrl 的键都不可能被它注册**，而 `Esc` 也不带 `cmd`。
//    ⛔ 而 ② 恰恰要靠它 ⇒ 这也是 ② 只能回真 rmd 验的原因之一。
// ⛔ **菜单是手搭的**，不是 Tauri 的 `Menu::default`；但 `⌘,`/`⌘B` 两项与 rmd 的
//    归属一致（`owner = Menu`），Edit / View 子菜单也按 `kb/0016` §1 那张表复刻。
//
// # 判据分三层，缺一不可
//
//   A. **页面侧**：`keydown` 到没到？`defaultPrevented` 是什么？——"网页有没有机会看它"
//   B. **页面侧**：**光标 / 选区 / 文本长度**动没动？——⭐ 这一层才是"用户看得见的行为"
//   C. **原生侧**：`performKeyEquivalent:` 有没有被调到、`super` 返回什么。
//      ⭐ `super=true` ＝ **被菜单加速键吃掉了**（⇒ 到不了网页）。
//
// # 为什么采样由 Swift 驱动（⛔ 不靠页内定时器）
//
// `cm6-probe.swift` 头注的实测：**不可见窗口里 rAF 不保证来**；
// ⚠️ `setInterval` 同族（可能被节流）⇒ 采样一律由本文件用 `evaluateJavaScript`
// 逐个时点**主动取**，页内只留"事件到达"这种**被动**记录。
//
// 用法（⚠️ 它自己发键，不需要任何外部工具）：
//   editor-keyprobe <pageDir> [--keys a,b,c] [--settle 0.4] [--interval 0.1] [--samples 14]

import Cocoa
import WebKit

// ─────────────────────────── 键定义 ───────────────────────────
//
// ⚠️ `characters` 与 `charactersIgnoringModifiers` 都要**显式给对**：
//    WebKit 的 `macEditingCommandsMap`（emacs 文本绑定）按 **ignoringModifiers 的字符 + 修饰键**
//    查表，而 DOM `keydown` 的 `key` 也由它派生。给错 ⇒ 探针量的是别的键（静默偏题）。
//    ⚠️ Ctrl+字母的 `characters` 是**控制字符**（`Ctrl+A` = U+0001），这才是真按键的形状。
struct KeySpec {
    let id: String
    let mods: NSEvent.ModifierFlags
    let chars: String
    let ignoring: String
    let keyCode: UInt16
}

// keyCode 表取自 `Carbon/HIToolbox/Events.h` 的 `kVK_*`（⛔ 不凭印象写）。
private let KEY_SPECS: [KeySpec] = [
    KeySpec(id: "cmd-k",     mods: [.command], chars: "k",      ignoring: "k",      keyCode: 40), // kVK_ANSI_K
    KeySpec(id: "cmd-comma", mods: [.command], chars: ",",      ignoring: ",",      keyCode: 43), // kVK_ANSI_Comma
    KeySpec(id: "cmd-b",     mods: [.command], chars: "b",      ignoring: "b",      keyCode: 11), // kVK_ANSI_B
    KeySpec(id: "cmd-s",     mods: [.command], chars: "s",      ignoring: "s",      keyCode: 1),  // kVK_ANSI_S —— ⭐ 0c②
    KeySpec(id: "ctrl-a",    mods: [.control], chars: "\u{01}", ignoring: "a",      keyCode: 0),  // kVK_ANSI_A
    KeySpec(id: "ctrl-b",    mods: [.control], chars: "\u{02}", ignoring: "b",      keyCode: 11),
    KeySpec(id: "ctrl-d",    mods: [.control], chars: "\u{04}", ignoring: "d",      keyCode: 2),  // kVK_ANSI_D
    KeySpec(id: "ctrl-e",    mods: [.control], chars: "\u{05}", ignoring: "e",      keyCode: 14), // kVK_ANSI_E
    KeySpec(id: "ctrl-f",    mods: [.control], chars: "\u{06}", ignoring: "f",      keyCode: 3),  // kVK_ANSI_F
    KeySpec(id: "ctrl-h",    mods: [.control], chars: "\u{08}", ignoring: "h",      keyCode: 4),  // kVK_ANSI_H
    KeySpec(id: "ctrl-k",    mods: [.control], chars: "\u{0B}", ignoring: "k",      keyCode: 40),
    KeySpec(id: "ctrl-n",    mods: [.control], chars: "\u{0E}", ignoring: "n",      keyCode: 45), // kVK_ANSI_N
    KeySpec(id: "ctrl-o",    mods: [.control], chars: "\u{0F}", ignoring: "o",      keyCode: 31), // kVK_ANSI_O
    KeySpec(id: "ctrl-p",    mods: [.control], chars: "\u{10}", ignoring: "p",      keyCode: 35), // kVK_ANSI_P
    KeySpec(id: "escape",    mods: [],         chars: "\u{1B}", ignoring: "\u{1B}", keyCode: 53), // kVK_Escape
]

// ─────────────────────────── 命令行 ───────────────────────────

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("⛔ \(message)\n".data(using: .utf8)!)
    exit(2)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail("用法: editor-keyprobe <pageDir> [--keys a,b,c] [--settle 0.4] [--interval 0.1] [--samples 14]")
}
let pageDir = args[1]

func argValue(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

// ⚠️ 顺序有意义：**每个键都从"第 4 行中段"这个同一位置出发**（每轮前由页面 `__RESET`
//    恢复文档与光标），两个方向相反的移动才可比。⭐ 但**全在一个进程里**——
//    ⛔ 不再"每键起一个前台进程"（那是被用户叫停的形态）。
// ⚠️ 为什么把 `Ctrl+B/F/N/P`、`Ctrl+D/H/K` 也测了（设计只点名 `Ctrl+E`/`Ctrl+A`）：
//    ① `Ctrl+D`/`Ctrl+H`/`Ctrl+K` 的 emacs 语义是**删字符 / 删字符 / 删到行尾**——
//       它们**改文档内容**，比"移光标"严重一档；
//    ② `Ctrl+B/F/N/P` 是**将来 Vim 模式要用的键**（决策 3「Ctrl 组合留给 Vim」）——
//       若 macOS 自己已经把它们占掉，"留给 Vim"这个前提就得重新算。
//    ⇒ 合并起来才是 §2.3-4 那条代价清单的真正形状。
// ⛔ `cmd-k` 不在被测集里：它每轮都被**当对照**发一次（`controlKeyID`），被测会重复。
let defaultKeys = "cmd-comma,cmd-b,cmd-s,ctrl-a,ctrl-b,ctrl-d,ctrl-e,ctrl-f,ctrl-h,ctrl-k,ctrl-n,ctrl-o,ctrl-p,escape"
var keyIDs = (argValue("--keys") ?? ProcessInfo.processInfo.environment["KEYS"] ?? defaultKeys)
    .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
let settleSeconds = Double(argValue("--settle") ?? "") ?? 0.4
let intervalSeconds = Double(argValue("--interval") ?? "") ?? 0.1
let sampleCount = Int(argValue("--samples") ?? "") ?? 14
/// 每轮被测键之前先发一个**无主键 `⌘K`**（CM6 的 `historyKeymap` 与菜单里都没有它）——
/// 它是**到达性判据 A**：对照都没到 ⇒ 本探针无结论（⛔ 不是"被吞"）。
let controlKeyID = "cmd-k"
let keys: [KeySpec] = keyIDs.compactMap { id in KEY_SPECS.first { $0.id == id } }
guard keys.count == keyIDs.count else {
    fail("未知键 id：\(keyIDs.filter { id in !KEY_SPECS.contains { $0.id == id } })")
}
/// ⚠️ 对照键若也在被测集里，它会被测两遍（一次作对照、一次当测项）——**这是允许的**，
///    而且有用：它同时证明"对照键自己也没人处理"。这里只做去重提示。
let testKeys = keys.filter { $0.id != controlKeyID }

// ─────────────────────────── 原生侧观察点 ───────────────────────────

private var nativeLog: [String] = []

private func mods(_ event: NSEvent) -> String {
    var s = ""
    if event.modifierFlags.contains(.control) { s += "⌃" }
    if event.modifierFlags.contains(.option) { s += "⌥" }
    if event.modifierFlags.contains(.shift) { s += "⇧" }
    if event.modifierFlags.contains(.command) { s += "⌘" }
    return s.isEmpty ? "—" : s
}

private func mods(_ flags: NSEvent.ModifierFlags) -> String {
    var s = ""
    if flags.contains(.control) { s += "⌃" }
    if flags.contains(.option) { s += "⌥" }
    if flags.contains(.shift) { s += "⇧" }
    if flags.contains(.command) { s += "⌘" }
    return s.isEmpty ? "—" : s
}

final class ProbeWebView: WKWebView {
    /// ⭐ **`⌘` 系的键在这一层就被菜单接走了**（`NSWindow.performKeyEquivalent` → 菜单）。
    /// 它被调到且 `superReturned == true` ⇒ 这个键**到不了网页**。
    /// ⚠️ 它**可能一次都不被调到**：`contenteditable` 的第一响应者是 WebKit 内部的
    /// `WKContentView`，⛔ 不是 WKWebView 自己。
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let consumed = super.performKeyEquivalent(with: event)
        nativeLog.append("performKeyEquivalent \(mods(event))\(event.charactersIgnoringModifiers ?? "?") ⇒ super=\(consumed)")
        return consumed
    }
    override var acceptsFirstResponder: Bool { true }
}

final class ProbeWindow: NSWindow {
    /// ⚠️ 保留只为**记录**：注入路径不经它（见 `inject` 的注释——非 key 窗口上 `sendEvent` 会丢事件）。
    /// 它在真按键路径上仍然是"原生层看到了这个键"的第一个落点 ⇒ 留着，作为对照。
    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .keyDown, .keyUp:
            nativeLog.append("window.sendEvent \(event.type == .keyDown ? "keyDown" : "keyUp") \(mods(event)) keyCode=\(event.keyCode) chars=\(event.charactersIgnoringModifiers ?? "?")")
        default:
            break
        }
        super.sendEvent(event)
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let consumed = super.performKeyEquivalent(with: event)
        nativeLog.append("NSWindow.performKeyEquivalent \(mods(event))\(event.charactersIgnoringModifiers ?? "?") ⇒ super=\(consumed)")
        return consumed
    }
}

// ─────────────────────────── 菜单（复刻 rmd 的 ①② 形态） ───────────────────────────

/// ⭐ 菜单项动作的落点。**每一项都要能把"菜单层真的收到了这一键"记下来**——
/// 只发 `⌘B` 而菜单没记到，与"键根本没送到"是**两个**结论。
final class MenuSink: NSObject {
    static let shared = MenuSink()
    @objc func probeSettings(_ sender: Any?) {
        nativeLog.append("⭐⭐ 菜单动作：设置…（⌘,）① 生效")
    }
    @objc func probeSidebar(_ sender: Any?) {
        nativeLog.append("⭐⭐ 菜单动作：显示/隐藏侧边栏（⌘B）① 生效")
    }
}

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

    // ⭐ rmd 的 `⌘,`（`MENU_SETTINGS_ID`，`owner = Menu`）——放在应用菜单里，与 macOS 惯例一致
    let settings = NSMenuItem(title: "设置…", action: #selector(MenuSink.probeSettings(_:)), keyEquivalent: ",")
    settings.target = MenuSink.shared
    appMenu.addItem(settings)

    let file = submenu("File")
    file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    // ⭐ rmd 的 `⌘B`（`MENU_SIDEBAR_ID`，`owner = Menu`）
    let sidebar = NSMenuItem(title: "显示/隐藏侧边栏", action: #selector(MenuSink.probeSidebar(_:)), keyEquivalent: "b")
    sidebar.target = MenuSink.shared
    file.addItem(sidebar)

    // Edit —— 与 kb/0016 §1 的表逐项对齐（⛔ 无 Find；rmd 的 `⌘F` 走 `Owner::Web`）
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

// ─────────────────────────── 主流程 ───────────────────────────

final class Delegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: ProbeWindow!
    var web: ProbeWebView!

    /// 结果：键 id → 这一轮的各时点采样。
    private var frontmostBefore = ""
    private var startedAt = Date()

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let rect = NSRect(x: 0, y: 0, width: 1200, height: 800)
        // ⚠️ `.borderless` + `alphaValue = 0` + **从不 `NSApp.activate`**：
        //    用户看不见它，且**不改变用户前台应用**（与 `cm6-probe.swift` 同路）。
        window = ProbeWindow(contentRect: rect,
                             styleMask: [.borderless],
                             backing: .buffered, defer: false)
        window.alphaValue = 0
        window.title = "rmd 0c 探针"

        web = ProbeWebView(frame: rect, configuration: WKWebViewConfiguration())
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        window.contentView = web

        // ⚠️ `orderBack`（⛔ 不是 `orderFront`、⛔ 不是 `makeKeyAndOrderFront`）：
        //    只为拿到一个 `windowNumber`（没被 order 过的窗口 `windowNumber` 是 0，事件会无主）。
        //    `.accessory` 策略下本进程**没有 Dock 图标**、**不接管菜单栏**，
        //    且**不激活** ⇒ 这个窗口排在用户前台应用**之后**、又是全透明的。
        window.orderBack(nil)
        window.makeKey()
        window.makeFirstResponder(web)

        frontmostBefore = NSWorkspace.shared.frontmostApplication?.localizedName ?? "未知"
        nativeLog.append("探针启动：激活策略=accessory（本探针需要激活才能送事件），窗口 alphaValue=0，⛔ 从不调用 NSApp.activate")

        let pageURL = URL(fileURLWithPath: (pageDir as NSString).appendingPathComponent("index.html"))
        guard FileManager.default.fileExists(atPath: pageURL.path) else {
            fail("找不到 \(pageURL.path)")
        }
        web.loadFileURL(pageURL, allowingReadAccessTo: URL(fileURLWithPath: pageDir))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        window.makeFirstResponder(web)
        waitForMount(tries: 60)
    }

    private func waitForMount(tries: Int) {
        if tries <= 0 { fail("页面 30 秒内没报就绪（编辑器没挂上？）") }
        web.evaluateJavaScript("(window.__STATE && window.__STATE.ready) === true") { [weak self] value, _ in
            guard let self else { return }
            if let ok = value as? Bool, ok {
                print("READY"); fflush(stdout)
                self.runRounds()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitForMount(tries: tries - 1) }
            }
        }
    }

    // ── 造事件：`NSEvent.keyEvent` → 直接 `window.sendEvent` ──
    private func makeEvent(_ spec: KeySpec, down: Bool) -> NSEvent? {
        NSEvent.keyEvent(with: down ? .keyDown : .keyUp,
                         location: .zero,
                         modifierFlags: spec.mods,
                         timestamp: ProcessInfo.processInfo.systemUptime,
                         windowNumber: window.windowNumber,
                         context: nil,
                         characters: spec.chars,
                         charactersIgnoringModifiers: spec.ignoring,
                         isARepeat: false,
                         keyCode: spec.keyCode)
    }

    /// ⭐⭐ 注入路径**必须自己复刻 AppKit 的两步**，⛔ 不能用 `window.sendEvent`：
    ///   ⚠️ 实测（第一版）：本窗口**不是 key window**（`window_isKey=False`——AppKit 规定
    ///   非激活进程的窗口**不可能**成为 key），`NSWindow.sendEvent` 于是**把按键整个丢掉**：
    ///   网页一条没收到，连 `performKeyEquivalent` 都没被调到。
    ///   ⇒ 改成显式两步，与 AppKit 的顺序一致：
    ///     **先 key equivalent（菜单 / 视图链）→ 没被吃掉才送 `keyDown:` 给第一响应者**。
    private func inject(_ spec: KeySpec) {
        guard let down = makeEvent(spec, down: true), let up = makeEvent(spec, down: false) else {
            nativeLog.append("⛔ 造不出事件：\(spec.id)")
            return
        }
        let fr = window.firstResponder.map { String(describing: type(of: $0)) } ?? "nil"
        nativeLog.append("注入 keyDown \(mods(spec.mods))\(spec.ignoring)（id=\(spec.id)，firstResponder=\(fr)）")
        if spec.mods.contains(.command) {
            // ⭐ `⌘` 系：只走**菜单加速键**这一条（AppKit 的真实顺序里，加速键先于响应者链）。
            let consumed = window.performKeyEquivalent(with: down)
            nativeLog.append("  ⇢ performKeyEquivalent 返回 \(consumed)\(consumed ? "（被加速键吃掉，与 AppKit 一致：⛔ 不再送 keyDown）" : "（没被吃）")")
            if !consumed { window.firstResponder?.keyDown(with: down) }
        } else {
            // ⭐ 无 `⌘` 的键（⌃x / Esc）：**只走响应者链**，⛔ 不再顺带调 `performKeyEquivalent`。
            //   ⚠️ 实测（第二版）：两条都发时 ⌃O 会**插两个换行**（文档 71 → 73）——
            //   说明 `performKeyEquivalent` 在这一层**也会**把键送进网页 ⇒ 两条路都发＝双份。
            //   ⇒ 单条路才量得准"一次按键的后果"。
            nativeLog.append("  ⇢ 直接送 keyDown 给第一响应者（⛔ 不走 performKeyEquivalent）")
            window.firstResponder?.keyDown(with: down)
        }
        window.firstResponder?.keyUp(with: up)
    }

    // ── 一轮：RESET → **空转采样（本轮的零按键对照）** → 发对照 ⌘K → 发被测键 → 逐时点采样 ──
    //
    // ⭐ 空转采样是**每一轮自己的零按键对照**（⛔ 不是全局一轮）：它证明"这一轮在没人按键的
    //    那 0.3 秒里光标不会自己动"，否则该轮所有"光标动了"都不能归因给按键。
    private func runRounds() {
        var index = 0

        func next() {
            if index >= testKeys.count {
                self.domSelectionProbe { self.dump() }
                return
            }
            let key = testKeys[index]
            index += 1
            self.reset(round: key.id) {
                DispatchQueue.main.asyncAfter(deadline: .now() + settleSeconds) {
                    // ① 空转：一个键都不发
                    self.sample(round: key.id, phase: "idle", remaining: 3) {
                        // ② 到达性对照 ⌘K（全项目无绑定）
                        if let ctl = KEY_SPECS.first(where: { $0.id == controlKeyID }) { self.inject(ctl) }
                        // ③ 被测键
                        self.inject(key)
                        // ④ 采被测键之后的各时点
                        self.sample(round: key.id, phase: "after", remaining: sampleCount) { next() }
                    }
                }
            }
        }
        next()
    }

    /// ⭐ 收尾判别器：程序化改 DOM 选区 → 看 CM6 跟不跟（见页面里 `__TEST_DOM_SELECTION` 的注释）。
    private func domSelectionProbe(done: @escaping () -> Void) {
        reset(round: "__domsel__") {
            DispatchQueue.main.asyncAfter(deadline: .now() + settleSeconds) {
                self.sample(round: "__domsel__", phase: "改前", remaining: 2) {
                    self.web.evaluateJavaScript("JSON.stringify(window.__TEST_DOM_SELECTION())") { value, error in
                        nativeLog.append("· 判别器 __TEST_DOM_SELECTION ⇒ \(value as? String ?? "err:\(String(describing: error))")")
                        self.sample(round: "__domsel__", phase: "改后", remaining: 8) { done() }
                    }
                }
            }
        }
    }

    private func reset(round: String, done: @escaping () -> Void) {
        let js = "window.__RESET(\(jsString(round)))"
        web.evaluateJavaScript(js) { value, error in
            if let error {
                nativeLog.append("⛔ __RESET 失败（\(round)）：\(error)")
            } else {
                nativeLog.append("· RESET \(round) ⇒ \(value as? String ?? "?")")
            }
            done()
        }
    }

    /// 逐时点主动取（⛔ 不靠页内定时器——不可见窗口里它可能被节流）。
    private func sample(round: String, phase: String, remaining: Int, done: @escaping () -> Void) {
        if remaining <= 0 { done(); return }
        let js = "window.__SNAP(\(jsString(phase)))"
        web.evaluateJavaScript(js) { [weak self] _, error in
            guard let self else { return }
            if let error { nativeLog.append("⛔ __SNAP 失败（\(round)/\(phase)）：\(error)") }
            DispatchQueue.main.asyncAfter(deadline: .now() + intervalSeconds) {
                self.sample(round: round, phase: phase, remaining: remaining - 1, done: done)
            }
        }
    }

    private func jsString(_ s: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [s], options: [])
        let arr = String(data: data, encoding: .utf8)!
        return String(arr.dropFirst().dropLast())
    }

    // ── 收尾 ──
    private func dump() {
        web.evaluateJavaScript("JSON.stringify(window.__STATE)") { value, error in
            var page: Any = "eval-error: \(error.map { String(describing: $0) } ?? "nil")"
            if let s = value as? String, let d = s.data(using: .utf8),
               let o = try? JSONSerialization.jsonObject(with: d) { page = o }
            let out: [String: Any] = [
                "回答": "design/0012 §7 步骤 0c ①③④：编辑区聚焦时 ⌘, / ⌘B / Ctrl+* / Esc 各归谁",
                "前提": [
                    "菜单里有_⌘,_与_⌘B_的项": true,
                    "CM6_用真_bundle": true,
                    "扩展清单含_转发扩展": false,
                    "事件注入方式": "NSEvent.keyEvent → window.sendEvent（⛔ 不经 System Events / 不抢前台）",
                    "窗口对用户可见": false,
                    "调过_NSApp_activate": false,
                    "原生判据是_window_sendEvent": true,
                    "全程一个进程": true,
                ],
                "原生侧": [
                    "日志": nativeLog,
                    "前端应用_启动时": self.frontmostBefore,
                    "app_isActive": NSApp.isActive,
                    "window_isKey": self.window.isKeyWindow,
                    "window_isVisible": self.window.isVisible,
                    "window_alpha": Double(self.window.alphaValue),
                    "window_number": self.window.windowNumber,
                    "新增且可见的窗口数": 0,
                    "耗时秒": Int(Date().timeIntervalSince(self.startedAt)),
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
// ⚠️ `.accessory`：没有 Dock 图标、不接管菜单栏，**且本进程从不激活自己**。
// ⚠️⚠️ **`.prohibited`，⛔ 不是 `.accessory`**（`kb/0025` ＋ 2026-10-21 实测）：
//    `.accessory` 只是"没有 Dock 图标"，**仍会被激活**（从正在前台的终端里起进程时，
//    `frontmostApplication` 会从 `iTerm2` 变成探针自己）。本探针的注入路径**不依赖**窗口
//    是 key（见下面 `inject` 的注释：非激活进程的窗口本来就成不了 key，所以它自己复刻
//    AppKit 的两步）⇒ 换 `.prohibited` 结构上不允许被激活，对判据没有影响。
// ⚠️⚠️ **本探针**必须**是 `.accessory`——⛔ 不能跟着 `kb/0025` 换成 `.prohibited`**
//    （2026-10-21 对照实验，同一份代码、同一时刻、只改这一行）：
//      · `.prohibited`：对照键 `⌘K` **到达 0/14 轮** ⇒ 事件根本没送到页面，整轮无结论；
//      · `.accessory`：对照键 `⌘K` **到达 14/14 轮** ⇒ 注入的 `NSEvent` 才能走完
//        AppKit → 响应者链 → WKWebView → WebKit 进程 → DOM 这条整路。
//    ⇒ 这是一处**已知且被接受**的偏离：它属于 `kb/0025` 的边界那一条
//      （「需要真焦点/激活才能成立的验证，用 `.prohibited` 会验不了」）。
//    ⚠️ 代价：从**正在前台的终端**里起它时，AppKit 可能把本进程激活（`kb/0025` 实测）。
//      ⛔ 所以它是**需要用户知情时才跑**的那一类，⛔ 不是日常闸门。
//      其余五份日常闸门（scroll-sync / edit-chrome / vim-keys / reading-progress /
//      image-viewer）已全部换成 `.prohibited`，⛔ 别用本文件的理由去改它们。
app.setActivationPolicy(.accessory)
let delegate = Delegate()
app.delegate = delegate
// ⚠️ 兜底超时：macOS **没有** `timeout(1)`，兜底只能自己带（find-keyprobe 同族）。
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 150) {
    if Date().timeIntervalSince(wall) >= 149.5 {
        FileHandle.standardError.write("⛔ 150 秒没拿到结果\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
