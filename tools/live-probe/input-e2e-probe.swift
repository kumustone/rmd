// rmd · 端到端输入探针的**运行器**（`design/0062` §2.1：`make probe-input-e2e`）
//
// ⭐ 它只做四件事：
//   ① 在离屏 `.prohibited` 窗口里加载**产品同一份页面**（`block-probe.sh --e2e` 构的页）；
//   ② 在**第一响应者 / NSTextInputClient** 两个面注入（`NSEvent.keyEvent` /
//      `setMarkedText` / `insertText`），⛔ 不用 `window.sendEvent`（非 key 窗口会整条丢事件）；
//   ③ 按 `design/0062` §2.3 的组别逐条判据（期望值在**这里**，⛔ 不在页面里）；
//   ④ 把结论、判据、环境自证写成一行 JSON 到 stdout。
//
// ⛔ **不抢前台、不弹窗、不合成系统事件**（根 `CLAUDE.md` 高代价错误第 1 条）：
//    `.prohibited` + `.borderless` + `alphaValue = 0` + `orderBack`；⛔ 不调 `NSApp.activate`，
//    ⛔ 不调 `makeKey`。⭐ 本探针**只调** `window.makeFirstResponder(webView)`——它让按键在
//    **本窗口自己的**响应者链里往下走，而窗口既不是 key、进程也不是 active，
//    用户的键盘焦点一个字节都不会变（判据 H2/H3/H4 每次跑都自证）。
//    ⛔ 不用 `osascript` / `System Events` / `CGEvent`。
//
// ⚠️ 不验真实输入法（候选窗、拼音按键）、不验真实菜单/真实 IPC/真实磁盘：见 `design/0062` §4。
//
// 用法： input-e2e-probe <pageDir>
// 输出： 一行 JSON（`{结论:{通过,失败,跳过}, 判据:[{判据,ok,说明}], 环境:{…}, 观测:{…}}`）
// 退出码：0 = 跑完（⚠️ 结论在 JSON 里）；1 = 环境/加载/超时；2 = 用法

import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: input-e2e-probe <pageDir>\n".data(using: .utf8)!)
    exit(2)
}
let pageDir = args[1]
// 变异开关：`menu` = 不装 Undo 加速键（I 组「删菜单动作」负对照）
let mutation = ProcessInfo.processInfo.environment["RMD_E2E_MUTATION"] ?? ""

// ─────────────────────────── 键表（`kVK_*` 取自 Carbon/HIToolbox/Events.h） ───────────────────────────

struct KeySpec {
    let id: String
    let mods: NSEvent.ModifierFlags
    let chars: String
    let ignoring: String
    let keyCode: UInt16
}

let KEY_SPECS: [KeySpec] = [
    KeySpec(id: "a",        mods: [],         chars: "a",      ignoring: "a",      keyCode: 0),   // kVK_ANSI_A
    KeySpec(id: "e",        mods: [],         chars: "e",      ignoring: "e",      keyCode: 14),  // kVK_ANSI_E
    KeySpec(id: "2",        mods: [],         chars: "2",      ignoring: "2",      keyCode: 19),  // kVK_ANSI_2
    KeySpec(id: "backspace", mods: [],        chars: "\u{8}",  ignoring: "\u{8}",  keyCode: 51),  // kVK_Delete
    KeySpec(id: "delete",   mods: [],         chars: "\u{7F}", ignoring: "\u{7F}", keyCode: 117), // kVK_ForwardDelete
    KeySpec(id: "return",   mods: [],         chars: "\r",     ignoring: "\r",     keyCode: 36),  // kVK_Return
    KeySpec(id: "left",     mods: [],         chars: "\u{F702}", ignoring: "\u{F702}", keyCode: 123), // kVK_LeftArrow
    KeySpec(id: "tab",      mods: [],         chars: "\t",     ignoring: "\t",     keyCode: 48),  // kVK_Tab
    KeySpec(id: "escape",   mods: [],         chars: "\u{1B}", ignoring: "\u{1B}", keyCode: 53),  // kVK_Escape
    KeySpec(id: "cmd-k",    mods: [.command], chars: "k",      ignoring: "k",      keyCode: 40),  // kVK_ANSI_K（全项目无绑定 = 到达性对照）
    KeySpec(id: "cmd-z",    mods: [.command], chars: "z",      ignoring: "z",      keyCode: 6),   // kVK_ANSI_Z
    KeySpec(id: "cmd-s",    mods: [.command], chars: "s",      ignoring: "s",      keyCode: 1),   // kVK_ANSI_S
]

func spec(_ id: String) -> KeySpec {
    KEY_SPECS.first { $0.id == id }!
}

func modsText(_ f: NSEvent.ModifierFlags) -> String {
    var s = ""
    if f.contains(.control) { s += "⌃" }
    if f.contains(.option) { s += "⌥" }
    if f.contains(.shift) { s += "⇧" }
    if f.contains(.command) { s += "⌘" }
    return s.isEmpty ? "—" : s
}

// ─────────────────────────── 菜单（按产品 `SHORTCUTS` 镜像的最小集） ───────────────────────────
//
// ⭐ 为什么要有它：`⌘` 键在 AppKit 里**先过 `performKeyEquivalent`（菜单加速键）**，没被吃才
//    送 `keyDown:` 给第一响应者。F 组判的是这条机制，⛔ 不是"Tauri 生成的菜单今天长这样"。
// ⚠️ 镜像**只放产品真有加速键的项**：`⌘S`/`⌘N`/`⌘A` 等 `Owner::Web` 的键产品**不进菜单**
//    ⇒ 这里也⛔ 不放，否则测的是假菜单（`design/0062` §6「菜单镜像漂移」）。

final class MenuSink: NSObject {
    static let shared = MenuSink()
    var hits: [String: Int] = [:]
    @objc func probeSettings(_ sender: Any?) { hits["settings", default: 0] += 1 }
    @objc func probeUndo(_ sender: Any?) { hits["undo", default: 0] += 1 }
    @objc func probeRedo(_ sender: Any?) { hits["redo", default: 0] += 1 }
}

func buildMenu() -> NSMenu {
    let main = NSMenu()
    func submenu(_ title: String) -> NSMenu {
        let item = NSMenuItem()
        main.addItem(item)
        let m = NSMenu(title: title)
        item.submenu = m
        return m
    }
    let app = submenu("Probe")
    let settings = NSMenuItem(title: "设置…", action: #selector(MenuSink.probeSettings(_:)), keyEquivalent: ",")
    settings.target = MenuSink.shared
    app.addItem(settings)

    let file = submenu("File")
    file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

    // Edit：与 `kb/0016` §1 的真机菜单表对齐（Undo / Redo 是 `Menu::default` 自带的）。
    let edit = submenu("Edit")
    if mutation == "menu" {
        // I 组负对照：**删掉 Undo 的加速键** ⇒ F2 的「菜单消费」判据必须打红。
        edit.addItem(withTitle: "Undo（无加速键·变异）", action: #selector(MenuSink.probeUndo(_:)), keyEquivalent: "")
    } else {
        let undo = NSMenuItem(title: "Undo", action: #selector(MenuSink.probeUndo(_:)), keyEquivalent: "z")
        undo.target = MenuSink.shared
        edit.addItem(undo)
    }
    // ⚠️⚠️ Redo 必须用**大写 `Z`**（与 AppKit 标准菜单同形）：`NSMenu` 匹配键等价时，
    //     **小写**键等价**忽略 ⇧**——写 `"z"` ＋ `[.command,.shift]` 的话裸 ⌘Z 也会命中
    //     Redo（2026-11-15 实测：变异 M-E4 删掉 Undo 加速键后仍报"菜单持有=true"，
    //     就是被这一条接住了 ⇒ F2 判据失去分辨率）。
    let redo = NSMenuItem(title: "Redo", action: #selector(MenuSink.probeRedo(_:)), keyEquivalent: "Z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    redo.target = MenuSink.shared
    edit.addItem(redo)
    return main
}

// ─────────────────────────── 运行器 ───────────────────────────

final class Runner: NSObject, WKNavigationDelegate {
    let window: NSWindow
    let web: WKWebView
    let 起跑前前台 = NSWorkspace.shared.frontmostApplication?.localizedName ?? "未知"
    let 起跑时刻 = Date()

    var 注入记录: [String] = []
    var 观测: [String: Any] = [:]
    var 判据: [(String, Bool, String)] = []
    var 致命: String? = nil
    var 调过NSAppActivate = false
    var 调过MakeKey = false
    var 调过MakeFirstResponder = true // 本探针确实调了它（见文件头：非 key 窗口，不改变用户焦点）

    init(window: NSWindow, web: WKWebView) {
        self.window = window
        self.web = web
        super.init()
    }

    // ── JS 调用（`callAsyncJavaScript` 会 await Promise）──
    func js(_ body: String, _ done: @escaping (Any?) -> Void) {
        web.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .failure(let e):
                FileHandle.standardError.write("⛔ JS 失败：\(e)\n".data(using: .utf8)!)
                done(nil)
            case .success(let v):
                done(v)
            }
        }
    }

    func fail(_ why: String) {
        致命 = why
        finish()
    }

    func add(_ name: String, _ ok: Bool, _ detail: String) {
        判据.append((name, ok, detail))
    }

    // ── 造事件 / 注入 ──
    func event(_ k: KeySpec, down: Bool) -> NSEvent? {
        NSEvent.keyEvent(with: down ? .keyDown : .keyUp,
                         location: .zero,
                         modifierFlags: k.mods,
                         timestamp: ProcessInfo.processInfo.systemUptime,
                         windowNumber: window.windowNumber,
                         context: nil,
                         characters: k.chars,
                         charactersIgnoringModifiers: k.ignoring,
                         isARepeat: false,
                         keyCode: k.keyCode)
    }

    /// ⭐ 复刻 AppKit 的两步（`editor-keyprobe.swift` 实测过，⛔ 别用 `window.sendEvent`）：
    ///    `⌘` 系先过**菜单加速键**；没被吃才送 `keyDown:` 给第一响应者。无 `⌘` 的只走响应者链。
    ///    返回值：**菜单**是否持有这个键。
    ///
    /// ⚠️⚠️ 必须问 `NSApp.mainMenu.performKeyEquivalent`，⛔ **不能**问
    ///    `window.performKeyEquivalent`：后者在**非 key 窗口**里会把键交给内容视图
    ///    （WKWebView 认领 ⌘ 键并派发 DOM keydown）⇒ 它**永远**返回 true，
    ///    "菜单消费"与"页面收到"两栏同时为真，F2/A1 那一族判据**没有分辨率**
    ///    （2026-11-15 首次实跑实测：⌘K/⌘S 也报 consumed=true）。
    @discardableResult
    func inject(_ id: String) -> Bool {
        let k = spec(id)
        guard let down = event(k, down: true), let up = event(k, down: false) else {
            注入记录.append("⛔ 造不出事件：\(id)")
            return false
        }
        let fr = window.firstResponder.map { String(describing: type(of: $0)) } ?? "nil"
        注入记录.append("注入 \(modsText(k.mods))\(k.ignoring)（id=\(id)，firstResponder=\(fr)）")
        var consumed = false
        if k.mods.contains(.command) {
            consumed = NSApp.mainMenu?.performKeyEquivalent(with: down) ?? false
            注入记录.append("  ⇢ 菜单 performKeyEquivalent ⇒ \(consumed)")
            if !consumed { window.firstResponder?.keyDown(with: down) }
        } else {
            window.firstResponder?.keyDown(with: down)
        }
        window.firstResponder?.keyUp(with: up)
        return consumed
    }

    func setMarked(_ s: String) {
        guard let c = window.firstResponder as? NSTextInputClient else {
            注入记录.append("⛔ firstResponder 不是 NSTextInputClient")
            return
        }
        c.setMarkedText(s, selectedRange: NSRange(location: (s as NSString).length, length: 0),
                        replacementRange: NSRange(location: NSNotFound, length: 0))
        注入记录.append("setMarkedText(\(s))")
    }

    func insertText(_ s: String) {
        guard let c = window.firstResponder as? NSTextInputClient else {
            注入记录.append("⛔ firstResponder 不是 NSTextInputClient")
            return
        }
        c.insertText(s, replacementRange: NSRange(location: NSNotFound, length: 0))
        注入记录.append("insertText(\(s))")
    }

    // ── 快照与等待 ──
    func snapshot(_ name: String, _ done: @escaping ([String: Any]?) -> Void) {
        js("await window.__E2E.等帧(2); return window.__E2E.快照();") { v in
            let snap = v as? [String: Any]
            if let snap { self.观测[name] = snap }
            done(snap)
        }
    }

    func settle(_ done: @escaping () -> Void) {
        // ⚠️ 180 ms：给 WebKit 的默认动作 / 产品的事务 / IPC 一次往返留出时间。
        //    这是**时序余量**，⛔ 不是性能判据；没到就是等下一次快照，不改判据。
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
            self.js("await window.__E2E.等帧(2); return true;") { _ in done() }
        }
    }

    // ── 读数工具（全部只读快照，⛔ 不从别处推）──
    func str(_ snap: [String: Any]?, _ k: String) -> String { (snap?[k] as? String) ?? "" }
    func num(_ snap: [String: Any]?, _ k: String) -> Int { (snap?[k] as? Int) ?? -1 }
    func events(_ snap: [String: Any]?) -> [[String: Any]] { (snap?["事件"] as? [[String: Any]]) ?? [] }
    func evCount(_ snap: [String: Any]?, _ cls: String, _ key: String? = nil,
                 inputType: String? = nil) -> Int {
        events(snap).filter { e in
            guard (e["类"] as? String) == cls else { return false }
            if let key, (e["key"] as? String) != key { return false }
            if let inputType, (e["inputType"] as? String) != inputType { return false }
            return true
        }.count
    }
    func keydown(_ snap: [String: Any]?, _ key: String) -> Bool {
        events(snap).contains { ($0["类"] as? String) == "keydown" && ($0["key"] as? String) == key }
    }
    func firstIndex(_ snap: [String: Any]?, _ cls: String) -> Int? {
        events(snap).firstIndex { ($0["类"] as? String) == cls }.map { $0 }
    }
    func seq(_ snap: [String: Any]?, _ cls: String) -> [Int] {
        events(snap).enumerated().filter { $1["类"] as? String == cls }.map { $0.offset }
    }
    func selHead(_ snap: [String: Any]?) -> Int? {
        ((snap?["选区"] as? [String: Any])?["head"] as? Int)
    }
    func count(_ snap: [String: Any]?, _ k: String) -> Int { num(snap, k) }

    /// 「全文 = 基线 ＋ 唯一一处插入」与「块文本 = 块基线 ＋ 唯一一处插入」共用的判据。
    /// ⚠️ 用一个**夹具里不存在**的词当探针：去掉它就回到基线、且只出现一次，与插入点无关。
    func inserted(_ text: String, into base: String, word: String) -> (Bool, Int) {
        guard !base.contains(word) else { return (false, -1) }
        let n = text.components(separatedBy: word).count - 1
        return (text.replacingOccurrences(of: word, with: "") == base, n)
    }

    // ── 主流程 ──
    func start() {
        js("""
        if (!window.__E2E) { return { ok:false, 原因:'__E2E 没挂上', 错误:(window.__ERR||[]) }; }
        return await window.__E2E.就绪();
        """) { v in
            guard let r = v as? [String: Any], (r["ok"] as? Bool) == true else {
                self.fail("页面没就绪：\(String(describing: v))")
                return
            }
            self.观测["就绪"] = r
            self.snapshot("base") { base in
                guard let base else { self.fail("基线快照取不到"); return }
                self.stepEnter(base)
            }
        }
    }

    /// ① 进入块 0 → ② 键入 `e2e` → ③ 组合 → ④ Emoji → ⑤ 粘贴 → ⑥ 删除/换行/方向
    func stepEnter(_ base: [String: Any]) {
        js("return await window.__E2E.进入块(0);") { v in
            guard let r = v as? [String: Any], (r["ok"] as? Bool) == true else {
                self.fail("进不了第 0 块：\(String(describing: v))；状态条见观测.base")
                return
            }
            self.观测["进入块"] = r
            self.snapshot("进块") { snap in
                guard let snap else { self.fail("进块后快照取不到"); return }
                self.add("E3 进入块后 activeElement 是离屏输入框",
                         ((snap["焦点"] as? [String: Any])?["是输入框"] as? Bool) == true,
                         "焦点=\(String(describing: snap["焦点"]))")
                self.stepClearAndType(base, snap)
            }
        }
    }

    func stepClearAndType(_ base: [String: Any], _ entry: [String: Any]) {
        js("window.__E2E.清空事件(); return true;") { _ in
            // 依次注入 e / 2 / e（⚠️ 已经在块里，⛔ 不再点一次：再点会换一个插入点）
            self.inject("e")
            self.inject("2")
            self.inject("e")
            self.settle {
                self.snapshot("打字后") { snap in
                    guard let snap else { self.fail("打字后快照取不到"); return }
                    let blockBase = self.str(entry, "块文本")
                    let blockNow = self.str(snap, "块文本")
                    let (okInsert, n) = self.inserted(blockNow, into: blockBase, word: "e2e")
                    self.add("B1 键入 `e2e`：块文本 = 块基线 ＋ 唯一一处插入", okInsert && n == 1,
                             "块文本=\(blockNow.debugDescription) 次数=\(n)")
                    self.add("B2 每个字符都到达 DOM keydown（e/2/e 各一次）",
                             self.evCount(snap, "keydown", "e") == 2
                             && self.evCount(snap, "keydown", "2") == 1,
                             "e=\(self.evCount(snap, "keydown", "e")) 2=\(self.evCount(snap, "keydown", "2"))")
                    self.add("B2b 键入产生 beforeinput insertText 且随输入事件",
                             self.evCount(snap, "beforeinput", inputType: "insertText") >= 3,
                             "beforeinput/insertText=\(self.evCount(snap, "beforeinput", inputType: "insertText"))")
                    self.stepComposition(base, blockNow)
                }
            }
        }
    }

    func stepComposition(_ base: [String: Any], _ blockAfterTyping: String) {
        js("window.__E2E.清空事件(); return true;") { _ in
            self.setMarked("ce")
            self.settle {
                self.snapshot("组合中") { mid in
                    guard let mid else { self.fail("组合中快照取不到"); return }
                    let submitted = self.count(mid, "提交次数")
                    self.add("C2 组合期不提交（提交次数不变）", submitted == self.count(self.观测["打字后"] as? [String: Any], "提交次数"),
                             "提交次数=\(submitted)")
                    self.add("C1 组合事件序列 compositionstart → update → end",
                             self.seq(mid, "compositionstart").count == 1
                             && self.seq(mid, "compositionupdate").count >= 1,
                             "start=\(self.seq(mid, "compositionstart")) update=\(self.seq(mid, "compositionupdate"))")
                    self.insertText("端测")
                    self.settle {
                        self.snapshot("上屏后") { end in
                            guard let end else { self.fail("上屏后快照取不到"); return }
                            let block = self.str(end, "块文本")
                            let (ok, n) = self.inserted(block, into: blockAfterTyping, word: "端测")
                            self.add("C3 上屏只落一次（WebKit 补发不造成双插）", ok && n == 1,
                                     "块文本=\(block.debugDescription) 次数=\(n)")
                            self.add("C1b compositionend 恰好一次且晚于 compositionstart",
                                     self.seq(end, "compositionstart").count == 1
                                     && self.seq(end, "compositionend").count == 1
                                     && (self.seq(end, "compositionstart").first ?? 0)
                                        < (self.seq(end, "compositionend").first ?? -1),
                                     "start=\(self.seq(end, "compositionstart")) end=\(self.seq(end, "compositionend"))")
                            self.add("C3b 上屏产生 beforeinput insertFromComposition",
                                     self.evCount(end, "beforeinput", inputType: "insertFromComposition") == 1,
                                     "insertFromComposition=\(self.evCount(end, "beforeinput", inputType: "insertFromComposition"))")
                            self.stepEmoji(block)
                        }
                    }
                }
            }
        }
    }

    func stepEmoji(_ blockBefore: String) {
        js("window.__E2E.清空事件(); return true;") { _ in
            self.insertText("😀")
            self.settle {
                self.snapshot("Emoji 后") { snap in
                    guard let snap else { self.fail("Emoji 快照取不到"); return }
                    let block = self.str(snap, "块文本")
                    let (ok, n) = self.inserted(block, into: blockBefore, word: "😀")
                    self.add("B3 Emoji 以代理对完整上屏且只落一次", ok && n == 1,
                             "块文本=\(block.debugDescription) 次数=\(n)")
                    self.stepPaste(block)
                }
            }
        }
    }

    func stepPaste(_ blockBefore: String) {
        js("return await window.__E2E.粘贴('甲\\r\\n乙');") { v in
            let ok = (v as? Bool) == true
            self.settle {
                self.snapshot("粘贴后") { snap in
                    guard let snap else { self.fail("粘贴快照取不到"); return }
                    let block = self.str(snap, "块文本")
                    self.add("B4 粘贴 CRLF 文本：CRLF 归一化、无残留 \\r",
                             ok && block.contains("甲\n乙") && !block.contains("\r"),
                             "粘贴动作=\(ok) 块文本=\(block.debugDescription)")
                    self.stepDelete(block)
                }
            }
        }
    }

    func stepDelete(_ blockBefore: String) {
        js("window.__E2E.清空事件(); return true;") { _ in
            self.inject("backspace")
            self.settle {
                self.snapshot("退格后") { snap in
                    guard let snap else { self.fail("退格快照取不到"); return }
                    let block = self.str(snap, "块文本")
                    // ⚠️ 产品在 **keydown** 里自己删（`main.js` 的 `deleteRange` 那一支并
                    //    `preventDefault`）⇒ 浏览器**不会**发 `beforeinput`（默认动作没跑）。
                    //    ⇒ 判据是"键到了、被否掉、正文恰少一个 UTF-16 单元"；
                    //    `beforeinput` 那一层是**兜底**（真发出来也必须在产品里被接住），
                    //    ⛔ 不能把它写成必经事件。
                    let prevented = (self.events(snap).first {
                        ($0["类"] as? String) == "keydown" && ($0["key"] as? String) == "Backspace"
                    })?["防"] as? Bool
                    self.add("D1 Backspace 到达且被 preventDefault，块文本恰少一个字符",
                             prevented == true && block.count == blockBefore.count - 1,
                             "keydown.defaultPrevented=\(String(describing: prevented)) 长度 \(blockBefore.count)→\(block.count)")
                    self.stepEnterKey(block)
                }
            }
        }
    }

    func stepEnterKey(_ blockBefore: String) {
        js("window.__E2E.清空事件(); return true;") { _ in
            self.inject("return")
            self.settle {
                self.snapshot("换行后") { snap in
                    guard let snap else { self.fail("换行快照取不到"); return }
                    let block = self.str(snap, "块文本")
                    let linesDelta = block.components(separatedBy: "\n").count
                        - blockBefore.components(separatedBy: "\n").count
                    let prevented = (self.events(snap).first {
                        ($0["类"] as? String) == "keydown" && ($0["key"] as? String) == "Enter"
                    })?["防"] as? Bool
                    // ⚠️ 与 D1 同口径：换行由产品在 keydown 里 `preventDefault` 后插（默认动作没跑）。
                    self.add("D2 Enter 到达且被 preventDefault，块多一行",
                             prevented == true && linesDelta == 1,
                             "keydown.defaultPrevented=\(String(describing: prevented)) 行数Δ=\(linesDelta)")
                    self.stepArrow(block)
                }
            }
        }
    }

    func stepArrow(_ blockBefore: String) {
        js("window.__E2E.清空事件(); return true;") { _ in
            let head0 = self.selHead(self.观测["换行后"] as? [String: Any])
            self.inject("left")
            self.settle {
                self.snapshot("左移后") { snap in
                    guard let snap else { self.fail("左移快照取不到"); return }
                    let head1 = self.selHead(snap)
                    self.add("D3 ArrowLeft 只动选区、不动文档",
                             head0 != nil && head1 != nil && head1 == head0! - 1
                             && self.str(snap, "块文本") == blockBefore,
                             "head \(String(describing: head0))→\(String(describing: head1)) 文档变=\(self.str(snap, "块文本") != blockBefore)")
                    self.stepEscapeCommit(snap)
                }
            }
        }
    }

    func stepEscapeCommit(_ before: [String: Any]) {
        js("window.__E2E.清空事件(); return true;") { _ in
            let renderBefore = self.count(before, "提交次数")
            let blockNow = self.str(before, "块文本")
            self.inject("escape")
            self.settle {
                self.snapshot("提交后") { snap in
                    guard let snap else { self.fail("提交快照取不到"); return }
                    let renderAfter = self.count(snap, "提交次数")
                    let full = self.str(snap, "最近提交")
                    let baseFull = self.str(self.观测["base"] as? [String: Any], "全文")
                    // ⭐ **锚定到"第 0 块那一行"的一处插入**：本轮对正文的全部改动是
                    //    `e2e` ＋ `端测` ＋ `😀` ＋ 粘贴的 `甲` 与一个换行（`乙` 被退格删掉）
                    //    ＋ Enter 又加的一个换行 ⇒ 期望 = 基线里那一行后面接
                    //    `e2e端测😀甲\n\n`，**其余字节一个不动**。
                    //    ⚠️ 这比"逐词挖掉再比"强：它同时证明**没有**任何多余改动。
                    let line0 = String(baseFull.split(separator: "\n", omittingEmptySubsequences: false).first ?? "")
                    let 锚 = line0.isEmpty ? nil : baseFull.range(of: line0)
                    let expected: String? = 锚.map { r in
                        baseFull.replacingCharacters(in: r, with: line0 + "e2e端测😀甲\n\n")
                    }
                    let 锚唯一 = !line0.isEmpty && baseFull.components(separatedBy: line0).count == 2
                    self.add("G1 Escape 提交恰好一次 render_preview", renderAfter == renderBefore + 1,
                             "render \(renderBefore)→\(renderAfter)")
                    self.add("G2 提交全文 = 基线 ＋ 唯一一处插入（`e2e端测😀甲` ＋ 两行换行），其余字节不变",
                             锚唯一 && expected != nil && full == expected!,
                             "锚唯一=\(锚唯一) 全文相等=\(full == expected) 字节 \(baseFull.utf8.count)→\(full.utf8.count)")
                    self.add("G3 退出后不在编辑态", (snap["在编辑态"] as? Bool) == false,
                             "在编辑态=\(String(describing: snap["在编辑态"]))")
                    self.观测["块末文本"] = blockNow
                    self.stepNoopExit()
                }
            }
        }
    }

    /// 进入后一个字不改就退出 ⇒ 不应提交（`INV-EDIT-12` ① 的端到端形态）。
    func stepNoopExit() {
        js("return await window.__E2E.进入块(0);") { v in
            guard let r = v as? [String: Any], (r["ok"] as? Bool) == true else {
                self.fail("第二次进块失败：\(String(describing: v))")
                return
            }
            self.snapshot("再进入") { snap in
                guard let snap else { self.fail("再进入快照取不到"); return }
                let before = self.count(snap, "提交次数")
                self.inject("escape")
                self.settle {
                    self.snapshot("未改退出后") { after in
                        guard let after else { self.fail("未改退出快照取不到"); return }
                        self.add("G4 未改字退出不提交", self.count(after, "提交次数") == before,
                                 "render \(before)→\(self.count(after, "提交次数"))")
                        self.stepTabBlock()
                    }
                }
            }
        }
    }

    /// E1：块内 `Tab` 的产品语义是「离开覆盖层」（`main.js` 里 `preventDefault` + `leaveLive`）。
    func stepTabBlock() {
        js("return await window.__E2E.进入块(0);") { v in
            guard let r = v as? [String: Any], (r["ok"] as? Bool) == true else {
                self.fail("Tab 组进块失败：\(String(describing: v))")
                return
            }
            self.js("window.__E2E.清空事件(); return true;") { _ in
                self.inject("tab")
                self.settle {
                    self.snapshot("块内 Tab 后") { snap in
                        guard let snap else { self.fail("Tab 快照取不到"); return }
                        let left = (snap["在编辑态"] as? Bool) == false
                        let first = (self.events(snap).first { ($0["类"] as? String) == "keydown" })?["防"] as? Bool
                        self.add("E1 块内 Tab：按产品基线离开覆盖层（keydown 被 preventDefault）",
                                 left && first == true,
                                 "离开编辑态=\(left) keydown.defaultPrevented=\(String(describing: first))")
                        self.stepTabCell()
                    }
                }
            }
        }
    }

    /// E2（`bugs/0047` 的端到端形态）：表格格内 `Tab` 不离开覆盖层、只换格。
    func stepTabCell() {
        js("return await window.__E2E.进入格(0);") { v in
            guard let r = v as? [String: Any], (r["ok"] as? Bool) == true else {
                self.fail("进不了格 0：\(String(describing: v))")
                return
            }
            self.snapshot("进格") { snap in
                guard let snap else { self.fail("进格快照取不到"); return }
                let cell0 = snap["格序号"] as? Int
                let full0 = self.str(snap, "全文")
                self.js("window.__E2E.清空事件(); return true;") { _ in
                self.inject("tab")
                self.settle {
                    self.snapshot("格内 Tab 后") { after in
                        guard let after else { self.fail("格内 Tab 快照取不到"); return }
                        // ⭐ 判据按**产品承诺的**形状：`design/0049` §4 / `bugs/0047` 的
                        //    `Q7` 是「宿主换到右边那一格」，⛔ 不是"输入框仍持有焦点"
                        //    （2026-11-15 实测：走格之后 `activeElement` 会变成 body，
                        //    下一个键由文档级兜底**先归位再交回** `onKeyDown`——
                        //    那是既有设计，⛔ 不是本探针该判红的东西）。
                        let still = (after["在编辑态"] as? Bool) == true
                        let cell1 = after["格序号"] as? Int
                        let first = (self.events(after).first {
                            ($0["类"] as? String) == "keydown" && ($0["key"] as? String) == "Tab"
                        })
                        let prevented = first?["防"] as? Bool
                        self.add("E2 表格格内 Tab：留在覆盖层、宿主换到下一格、全文不变",
                                 still && cell0 != nil && cell1 == (cell0 ?? -2) + 1
                                 && self.str(after, "全文") == full0 && prevented == true,
                                 "在编辑态=\(still) 格 \(String(describing: cell0))→\(String(describing: cell1))"
                                 + " 全文变=\(self.str(after, "全文") != full0) keydown.defaultPrevented=\(String(describing: prevented))")
                        self.inject("escape")
                        self.settle { self.stepArrivalControl() }
                    }
                }
                }
            }
        }
    }

    /// A1（INV-E2E-04）：无绑定的 `⌘K` 必须到达页面 —— 否则后面每条「没收到」都无结论。
    func stepArrivalControl() {
        js("return await window.__E2E.进入块(0);") { v in
            guard let r = v as? [String: Any], (r["ok"] as? Bool) == true else {
                self.fail("到达性对照进块失败：\(String(describing: v))")
                return
            }
            self.js("window.__E2E.清空事件(); return true;") { _ in
                let consumed = self.inject("cmd-k")
                self.settle {
                    self.snapshot("⌘K 后") { snap in
                        guard let snap else { self.fail("⌘K 快照取不到"); return }
                        self.观测["⌘K_菜单持有"] = consumed
                        self.add("A1 到达性对照：无绑定的 ⌘K 到达页面 keydown（metaKey）",
                                 !consumed && self.keydown(snap, "k")
                                 && ((self.events(snap).first { ($0["类"] as? String) == "keydown" })?["meta"] as? Bool) == true,
                                 "菜单持有=\(consumed) 收到=\(self.keydown(snap, "k"))")
                        self.stepCmdZ(snap)
                    }
                }
            }
        }
    }

    /// F1/F2（`bugs/0020` §3.2 ⑤ 的现状基线）：块内 `⌘Z` 的归属。
    func stepCmdZ(_ before: [String: Any]) {
        js("window.__E2E.清空事件(); return true;") { _ in
            let textBefore = self.str(before, "块文本")
            let consumed = self.inject("cmd-z")
            self.settle {
                self.snapshot("⌘Z 后") { snap in
                    guard let snap else { self.fail("⌘Z 快照取不到"); return }
                    let received = self.keydown(snap, "z")
                    let changed = self.str(snap, "块文本") != textBefore
                    self.观测["块内⌘Z"] = ["菜单持有": consumed, "页面收到": received, "文档变了": changed]
                    // ⚠️ **现状基线**（`design/0062` §7.2）：先记下来，不预设产品对错。
                    //    基线值 2026-11-15 实测后写死在 `docs/design/0062` §10；漂移即红，须重新评审。
                    self.add("F2 块内 ⌘Z 的归属与基线一致（现状：菜单持有加速键 / 页面未收到 / 文档未变）",
                             consumed && !received && !changed,
                             "菜单持有=\(consumed) 页面收到=\(received) 文档变=\(changed)")
                    self.inject("escape")
                    self.settle { self.stepCmdS() }
                }
            }
        }
    }

    /// F3：`⌘S` 是 `Owner::Web`、产品**不进菜单** ⇒ 加速键不消费，页面必须收到，且只保存一次。
    func stepCmdS() {
        js("return await window.__E2E.进入块(0);") { v in
            guard let r = v as? [String: Any], (r["ok"] as? Bool) == true else {
                self.fail("⌘S 组进块失败：\(String(describing: v))")
                return
            }
            self.snapshot("⌘S 前") { before in
                guard let before else { self.fail("⌘S 前快照取不到"); return }
                let saves = self.count(before, "保存次数")
                let renders = self.count(before, "提交次数")
                self.js("window.__E2E.清空事件(); return true;") { _ in
                    let consumed = self.inject("cmd-s")
                    self.settle {
                        self.snapshot("⌘S 后") { after in
                            guard let after else { self.fail("⌘S 后快照取不到"); return }
                            let received = self.keydown(after, "s")
                            let saved = self.str(after, "最近保存")
                            let rendered = self.str(after, "最近提交")
                            self.观测["⌘S"] = ["菜单持有": consumed, "页面收到": received,
                                              "保存 +": self.count(after, "保存次数") - saves]
                            self.add("F3 ⌘S 不经菜单（产品无此项加速键）、页面收到且只保存一次",
                                     !consumed && received && self.count(after, "保存次数") == saves + 1,
                                     "菜单持有=\(consumed) 收到=\(received) 保存 \(saves)→\(self.count(after, "保存次数"))")
                            self.add("F3b 写盘字节 = 最近一次提交（render_preview ≡ save_document）",
                                     !saved.isEmpty && saved == rendered,
                                     "保存 \(saved.utf8.count) B / 提交 \(rendered.utf8.count) B")
                            self.add("F3c ⌘S 没有额外触发提交（提交只 +1）",
                                     self.count(after, "提交次数") <= renders + 1,
                                     "render \(renders)→\(self.count(after, "提交次数"))")
                            self.stepCmdZReading()
                        }
                    }
                }
            }
        }
    }

    /// F4（阅读态基线）：退出编辑态之后 `⌘Z` 仍由菜单接走（`Edit▸Undo`）。
    func stepCmdZReading() {
        self.inject("escape")
        self.settle {
            self.js("window.__E2E.清空事件(); return true;") { _ in
                let consumed = self.inject("cmd-z")
                self.settle {
                    self.snapshot("阅读态 ⌘Z 后") { snap in
                        guard let snap else { self.fail("阅读态 ⌘Z 快照取不到"); return }
                        let received = self.keydown(snap, "z")
                        self.观测["阅读态⌘Z"] = ["菜单持有": consumed, "页面收到": received]
                        self.add("F4 阅读态 ⌘Z 的归属与基线一致（现状：菜单持有加速键 / 页面未收到）",
                                 consumed && !received,
                                 "菜单持有=\(consumed) 页面收到=\(received)")
                        self.stepSelfProof()
                    }
                }
            }
        }
    }

    /// H 组：把「没抢前台」写成判据（`INV-E2E-01`）。
    func stepSelfProof() {
        let now = NSWorkspace.shared.frontmostApplication?.localizedName ?? "未知"
        self.观测["前台应用_起跑前"] = 起跑前前台
        self.观测["前台应用_收工时"] = now
        add("H1 前台应用未变（\(起跑前前台)）", 起跑前前台 == now, "收工时=\(now)")
        add("H2 进程未被激活（NSApp.isActive == false）", !NSApp.isActive, "isActive=\(NSApp.isActive)")
        add("H3 窗口不是 key（isKeyWindow == false）", !(window.isKeyWindow), "isKeyWindow=\(window.isKeyWindow)")
        // ⚠️ 判据是"**屏幕上看不见、也拿不到焦点**"的两条可测事实：`alpha == 0` ＋ 不是 key
        //    （加 H1/H2 的前台/进程那两条）。⛔ **不判 `isVisible == false`**：`orderBack`
        //    之后窗口仍在窗口序里（`isVisible` 为 true 是**正常**的），拿它当判据会把
        //    一个正确环境判成无效（2026-11-15 首次实跑踩到）。
        add("H4 窗口 alpha == 0 且不是 key（屏幕上看不见、拿不到焦点）",
            window.alphaValue == 0 && !(window.isKeyWindow),
            "alpha=\(window.alphaValue) isKeyWindow=\(window.isKeyWindow) isVisible=\(window.isVisible)")
        add("H5 未调用 NSApp.activate / makeKey", !调过NSAppActivate && !调过MakeKey,
            "activate=\(调过NSAppActivate) makeKey=\(调过MakeKey)")
        finish()
    }

    func finish() {
        let pass = 判据.filter { $0.1 }.count
        let failCnt = 判据.count - pass
        var env: [String: Any] = [
            "窗口": [
                "isVisible": window.isVisible,
                "alpha": Double(window.alphaValue),
                "windowNumber": window.windowNumber,
                "进程被激活": NSApp.isActive,
                "窗口是_key": window.isKeyWindow,
                "调过_makeFirstResponder": 调过MakeFirstResponder,
                "调过_makeKey": 调过MakeKey,
                "调过_NSApp_activate": 调过NSAppActivate,
            ],
            "前台应用_起跑前": 起跑前前台,
            "前台应用_收工时": NSWorkspace.shared.frontmostApplication?.localizedName ?? "未知",
            "墙钟秒": (Date().timeIntervalSince(起跑时刻) * 1000).rounded() / 1000,
            "变异": mutation.isEmpty ? "无" : mutation,
            "注入记录": 注入记录,
        ]
        env["前台被抢过"] = (env["前台应用_起跑前"] as? String) != (env["前台应用_收工时"] as? String)
        var out: [String: Any] = [
            "结论": ["通过": pass, "失败": failCnt, "跳过": 0],
            "判据": 判据.map { ["判据": $0.0, "ok": $0.1, "说明": $0.2] },
            "环境": env,
            "观测": 观测,
        ]
        if let 致命 { out["致命"] = 致命 }
        guard let data = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else {
            FileHandle.standardError.write("⛔ 返回值不能序列化\n".data(using: .utf8)!)
            exit(1)
        }
        print(json)
        exit(0)
    }
}

// ─────────────────────────── 窗口与生命周期 ───────────────────────────

let app = NSApplication.shared
// ⚠️⚠️ `.prohibited`，⛔ 不是 `.accessory`（`kb/0025`）：后者仍可被 AppKit 激活。
_ = app.setActivationPolicy(.prohibited)
app.mainMenu = buildMenu()

let config = WKWebViewConfiguration()
// 页内日志 → stderr（"页内炸了"与"真的挂死"必须分得开，`kb/0006` 一族）
private final class 页内日志: NSObject, WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        FileHandle.standardError.write("· 页内：\(m.body)\n".data(using: .utf8)!)
    }
}
private let 日志桩 = 页内日志() // ⚠️ 必须 private/fileprivate：类型本身是 private
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
    发('onerror', [e.message + ' @' + (e.filename || '?') + ':' + e.lineno + ':' + e.colno]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    发('reject', [String((e.reason && e.reason.stack) || e.reason)]);
  });
})();
""", injectionTime: .atDocumentStart, forMainFrameOnly: true))

let w = Double(ProcessInfo.processInfo.environment["PROBE_W"] ?? "") ?? 1000
let h = Double(ProcessInfo.processInfo.environment["PROBE_H"] ?? "") ?? 1200
let rect = NSRect(x: 0, y: 0, width: w, height: h)
let webView = WKWebView(frame: rect, configuration: config)
let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView
window.alphaValue = 0
let runner = Runner(window: window, web: webView)
webView.navigationDelegate = runner

// ⚠️ **不调 `makeKey()`**（那会要求激活）；只把按键送进本窗口自己的响应者链。
window.orderBack(nil)

DispatchQueue.main.async {
    let html = URL(fileURLWithPath: (pageDir as NSString).appendingPathComponent("index.html"))
    if FileManager.default.fileExists(atPath: html.path) {
        webView.loadFileURL(html, allowingReadAccessTo: URL(fileURLWithPath: pageDir))
    } else {
        FileHandle.standardError.write("⛔ 找不到 \(html.path)\n".data(using: .utf8)!)
        exit(1)
    }
}

extension Runner {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        FileHandle.standardError.write("· didFinish，把按键送进本窗口的响应者链\n".data(using: .utf8)!)
        window.makeFirstResponder(webView)
        start()
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

// 兜底超时：正常十几秒；没拿到 JSON 才是挂死。
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 240) {
    if Date().timeIntervalSince(wall) >= 239.5 {
        FileHandle.standardError.write("⛔ 240 秒没拿到结果\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
