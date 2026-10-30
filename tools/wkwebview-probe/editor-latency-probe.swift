// rmd · 「编辑面与预览共存的时序」探针（`design/0012` §7 步骤 0f）
//
// ⚠️ 这是**设计期取证工具**，不是产品代码。结论进 `docs/design/0012` §7 与 §10，
//    数字落 `benchmarks/results/`。
//
// # 它回答什么（用户 2026-10-16 明确授权："0f 不要整体留给人工"）
//
//   ① **键入到下一次绘制的延迟** —— 页面侧四段：`keydown → CM6 update → rAF → rAF`。
//   ② **连续输入期间的预览调度** —— 拿**真的** `src/editor/preview.js` 驱动，
//      量 30 键连打 3 秒里到底发生了几次重渲、隔多久、档位怎么跳、陈旧提示怎么来。
//   ③ **滚动位置变化** —— 内容在视口上方增长/收缩时，预览栏顶端那一块**漂了多少像素**。
//
// # ⛔ 它**不**回答什么（计时边界，写死在结果里）
//
//   ⛔ **HID → WindowServer → AppKit** 这一跳：合成事件根本不经过它 ⇒ 本探针
//      量到的"键入延迟"**不含**真人按键时从硬件中断到 `NSEvent` 的那一段。
//   ⛔ **后端的真耗时**：`render_preview` 要走 Tauri IPC，探针里没有 ⇒
//      ② 里的后端是**照 §2.6-2-2 实测算出来的 `Σ` 模拟的**（分项逐条列在结果里），
//      且**主线程那一段（`T5+T5b`）用忙等真占**——所以"重渲期间输入被卡多久"是真的，
//      而"这一趟总耗时"是模拟的。
//   ⛔ **IME 组合态**：合成事件造不出输入法组合态（`notes/0016` §2.2，`0d` 同族）。
//
// # ⭐⭐ 为什么不弹窗（用户铁律：「探测的时候，不要影响我的日常工作，不要反复弹窗」）
//
//   与 `editor-keyprobe.swift` **同一条路**：`.accessory` ＋ `.borderless` ＋
//   ⚠️⚠️ **`.accessory` 是必须的，⛔ 不能换成 `.prohibited`**（`kb/0025` 的解药对这里不适用）：
//      2026-10-21 在 `editor-keyprobe.swift` 上做过对照——同一份代码只改这一行，
//      `.prohibited` ⇒ 注入的 `NSEvent` **到达 0/14 轮**，`.accessory` ⇒ **14/14 轮**。
//      ⇒ 靠**进程内注入 `NSEvent`** 才成立的探针，必须让进程能被激活；
//      这是 `kb/0025` 那条边界的实例：需要焦点/激活的验证，`.prohibited` 验不了。
//      ⛔ 代价：从**正在前台的终端**里起它时可能被激活 ⇒ 只在用户知情时跑。
//      ⚠️ 日常那五份闸门（scroll-sync / edit-chrome / vim-keys / reading-progress /
//      image-viewer）已全部换成 `.prohibited`，⛔ 别拿本文件的理由去改它们。
//   `alphaValue = 0` ＋ `orderBack`，⛔ **全程不调 `NSApp.activate`**、
//   ⛔ 不用 `osascript` / `System Events`、⛔ 不要辅助功能授权。**一个进程跑完全部测项。**
//
// # ⚠️⚠️ 离屏环境**先自证再测**（本探针 E1 段）
//
//   不可见窗口里 rAF 与页面定时器会被节流——但**只在前 ~2.2 秒**（2026-10-16 实测，
//   见 `docs/kb/0022`）。⇒ 本探针**先热身 3 秒**，跑 E1 判别器
//   （rAF 节奏 ＋ 定时器保真 ＋ 布局），**判成"不可信"就直接收工并标 `无结论`**，
//   ⛔ 绝不把节流期间的数字当结果交上去。
//
// # 到达性
//
//   ⭐ M1 每注入一个键都要求页面给出对应的 `keydown` 记录（`没拿到的键数` 一栏）。
//      ⇒ 一个都没到就是"没送到"，⛔ **不许读成"延迟为 0"**。

import AppKit
import WebKit

// ── 测项定义 ────────────────────────────────────────────────────────────────────

/// 一段连续击键。
struct Seg {
    let count: Int
    let intervalMs: Double
    /// 这一段打完之后额外静默多久（用来制造"停顿"，验 B 档的 1 s 地板）。
    let gapAfterMs: Double
}

struct BurstCase {
    let id: String
    /// 模拟的端到端 `Σ`（ms）——**出处是实测**，逐条见 `source`。
    let backendMs: Double
    /// 其中**占主线程**的那一段（`T5` 注入 ＋ `T5b` 强制布局）——忙等真占。
    let blockMs: Double
    /// 起始档位的依据（产品里是 `previewInitialMs()`）。
    let initialMs: Double
    let segs: [Seg]
    /// 打完是否手动点一次「更新预览」（档 C 的唯一出路）。
    let manual: Bool
    /// `Σ` 的分项出处（原样写进结果，⚠️ 免得三个月后没人知道这些数哪来的）。
    let source: String
}

/// ⚠️ 每个 `backendMs` / `blockMs` 都取自 `design/0012` §2.6-2-2 那张表的实测分项，
///    ⛔ **不是估的**。分项口径：`Σ = T2 + T3 + r + T5 + T5b`（`T5`/`T5b` 即"主线程那一段"）。
///
/// ⚠️ 装在一个 `enum` 里（类型声明，⛔ 不是顶层 `let`）——本文件是**脚本模式**（末尾有顶层代码），
///    顶层 `let` 会被当成那个"顶层函数"的局部变量，类**捕获不到**（实测编译不过）。
enum ProbeCases {
    static let all: [BurstCase] = [
        BurstCase(id: "T-A", backendMs: 13.9, blockMs: 12.0, initialMs: 13.9,
                  segs: [Seg(count: 30, intervalMs: 100, gapAfterMs: 0)], manual: false,
                  source: "S-plain：T2 0.2 + T3 0.4 + r 1.3 + T5 1.0 + T5b 11.0 = 13.9 ⇒ 档 A"),
        BurstCase(id: "T-B", backendMs: 455.1, blockMs: 413.0, initialMs: 455.1,
                  segs: [Seg(count: 30, intervalMs: 100, gapAfterMs: 0)], manual: false,
                  source: "L-plain：T2 7.0 + T3 2.3 + r 32.8 + T5 12.0 + T5b 401.0 = 455.1 ⇒ 档 B"),
        BurstCase(id: "T-C", backendMs: 4223.0, blockMs: 3964.0, initialMs: 4223.0,
                  segs: [Seg(count: 30, intervalMs: 100, gapAfterMs: 0)], manual: true,
                  source: "XL-tables：T2 138.8 + T3 34.0 + r 86.2 + T5 219.0 + T5b 3745.0 = 4223.0 ⇒ 档 C"),
        BurstCase(id: "T-A→B", backendMs: 455.1, blockMs: 413.0, initialMs: 13.9,
                  segs: [Seg(count: 30, intervalMs: 100, gapAfterMs: 0)], manual: false,
                  source: "起档按 S-plain 的 13.9（档 A）、真实回包是 L-plain 的 455.1 ⇒ 看档位会不会自己跳"),
        BurstCase(id: "T-B-floor", backendMs: 455.1, blockMs: 413.0, initialMs: 455.1,
                  segs: [Seg(count: 12, intervalMs: 100, gapAfterMs: 400),
                         Seg(count: 5, intervalMs: 100, gapAfterMs: 0)], manual: false,
                  source: "L-plain 的 455.1；两段之间静默 400 ms（< B 档 1 s 地板）⇒ 实测**只重渲一次**：尾随防抖把第二次压在停手之后"),
        // ⭐⭐ 下面两条是**唯一能撞上"重渲"的形态**，也是这一整趟探针最想问的那件事。
        //    ⚠️⚠️ 前面那几条**根本撞不上**：防抖是**尾随**的 ⇒ 重渲一定发生在"停手之后"，
        //    打字的整段时间里一次渲染都没跑。所以「打字期间被卡住多久」在 T-A/T-B/T-C 上
        //    测到的恒为 0——那不是"没卡"，是**形态选错了**。
        //    真正的场景是：**停一下（够触发一次重渲）→ 又接着打**，重渲跑的时候用户正在敲。
        //    ⚠️ 停顿必须 ≥ **该档自己的防抖**：B 档地板 1 s ⇒ 停 350 ms 时定时器根本没到点
        //    （第一版就是拿 350 ms 试的，两次都"撞上 0 个"，看那个数会以为不卡）。
        //    ⭐ 第二段用 50 ms 间隔：比人连续输入（约 80–100 ms/键）更密，但正是
        //    **按住不放的重复速率**（macOS 约 30 ms 起）与输入法成串上屏的同一档。
        //    ⭐ 两条**同一个停顿 1100 ms**，差别只在 Σ：这正是 A/B 的对照。
        BurstCase(id: "T-A-resume", backendMs: 13.9, blockMs: 12.0, initialMs: 13.9,
                  segs: [Seg(count: 8, intervalMs: 100, gapAfterMs: 1100),
                         Seg(count: 30, intervalMs: 50, gapAfterMs: 0)], manual: false,
                  source: "S-plain 13.9（档 A）；停 1100 ms 触发重渲后接着打 ⇒ ⭐ 12 ms 的块**短于一次按键间隔**，预期撞不上"),
        BurstCase(id: "T-B-resume", backendMs: 455.1, blockMs: 413.0, initialMs: 455.1,
                  segs: [Seg(count: 8, intervalMs: 100, gapAfterMs: 1100),
                         Seg(count: 30, intervalMs: 50, gapAfterMs: 0)], manual: false,
                  source: "L-plain 455.1（档 B）；停 1100 ms 触发重渲后接着打 ⇒ ⭐ 413 ms 的块会被连续撞上"),
    ]
}

/// M1 用的键：**单字符、无修饰键**。⚠️ 只有无修饰键才走 `firstResponder?.keyDown` 一条路
/// （`⌘` 系要走 `performKeyEquivalent`，两条都发会双份，见 `editor-keyprobe.swift` 的实测）。
enum ProbeConst {
    static let m1Chars = Array("abcdefghijklmnopqrstuvwxyz")
    /// 热身时长（秒）。⚠️ 这个数**是判据的一部分**：< 2.2 s 时 rAF 与定时器还在被节流。
    static let warmupSeconds = 3.0
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("⛔ \(message)\n".data(using: .utf8)!)
    exit(1)
}

func argValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

// ── 探针 ───────────────────────────────────────────────────────────────────────

final class Delegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private let pageDir: String
    private let cases: [BurstCase]
    private let m1Count: Int

    init(pageDir: String, cases: [BurstCase], m1Count: Int) {
        self.pageDir = pageDir
        self.cases = cases
        self.m1Count = m1Count
        super.init()
    }

    var window: NSWindow!
    var web: WKWebView!

    private var nativeLog: [String] = []
    private var startedAt = Date()
    private var frontmostBefore = ""

    // E1
    private var env: [String: Any]?
    private var envVerdict: [String: Any] = [:]
    // M1
    private var m1: [[String: Any]] = []
    private var m1Walls: [String: Double] = [:]
    private var m1Miss = 0
    // M2
    private var m2Raw: [String: Any] = [:]
    private var m2Index = 0
    /// ⭐ 本测项的注入表：`[[key, 原生墙钟], …]`，按**注入顺序**。
    /// ⚠️ 它是这一趟里**唯一**代表"用户按下键的那一刻"的东西——页面侧只有"键被处理的那一刻"。
    private var m2Walls: [[String: Any]] = []
    // M3
    private var m3: [String: Any]?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let rect = NSRect(x: 0, y: 0, width: 1200, height: 800)
        // ⚠️ `.borderless` + `alphaValue = 0` + **从不 `NSApp.activate`**：
        //    用户看不见它，且**不改变用户前台应用**（与 `editor-keyprobe.swift` 同路）。
        window = NSWindow(contentRect: rect, styleMask: [.borderless],
                          backing: .buffered, defer: false)
        window.alphaValue = 0
        window.title = "rmd 0f 探针"

        web = WKWebView(frame: rect, configuration: WKWebViewConfiguration())
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        window.contentView = web

        // ⚠️ `orderBack`（⛔ 不是 `orderFront` / `makeKeyAndOrderFront`）：只为拿到
        //    一个非零 `windowNumber`；⚠️ `.accessory` 下本进程没有 Dock 图标、不接管菜单栏。
        window.orderBack(nil)
        window.makeKey()
        window.makeFirstResponder(web)

        frontmostBefore = NSWorkspace.shared.frontmostApplication?.localizedName ?? "未知"
        nativeLog.append("探针启动：策略=accessory，窗口 alphaValue=0，⛔ 从不 NSApp.activate")

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

    // ── 就绪 → 热身 → E1 → M1 → M2 → M3 → 收尾 ──

    private func waitForMount(tries: Int) {
        if tries <= 0 { fail("页面 30 秒内没报就绪（编辑器没挂上？）") }
        evalBool("(window.__STATE && window.__STATE.ready) === true") { [weak self] ok in
            guard let self else { return }
            if ok {
                self.nativeLog.append("页面就绪（Swift 侧 \(self.elapsed()) s）")
                // ⚠️⚠️ 热身：不可见窗口里 rAF/定时器在前 ~2.2 s 内被节流（`kb/0022`）
                DispatchQueue.main.asyncAfter(deadline: .now() + ProbeConst.warmupSeconds) {
                    self.nativeLog.append("热身 \(ProbeConst.warmupSeconds) s 结束（Swift 侧 \(self.elapsed()) s）")
                    self.runEnv()
                }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.waitForMount(tries: tries - 1)
                }
            }
        }
    }

    /// E1：环境判别器。⚠️ 判成"不可信"⇒ 直接收工标无结论。
    ///
    /// ⚠️⚠️ 定时器必须**重新 arm 一轮**再采：页面上那轮是在**热身之前**装的，
    /// 它测到的正是"被节流"的值（`冷启动那轮` 那一栏留着做对照）⇒ 拿它当判据会把
    /// 一个**已经恢复**的环境判成不可用（2026-10-16 实测踩过，第一版就是这么错的）。
    private func runEnv() {
        eval("window.__ENV_TIMERS()") { [weak self] _ in
            guard let self else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { self.readEnv() }
        }
    }

    private func readEnv() {
        evalJSON("window.__ENV()") { [weak self] obj in
            guard let self else { return }
            guard let obj else {
                self.nativeLog.append("⛔ __ENV 取不到 ⇒ 无结论")
                self.envVerdict = ["可用": false, "理由": ["__ENV 取不到"]]
                return self.dump()
            }
            self.env = obj
            self.envVerdict = verdict(for: obj)
            let ok = self.envVerdict["可用"] as? Bool == true
            self.nativeLog.append("E1 环境判别 ⇒ \(ok ? "可用" : "⛔ 不可用")\(ok ? "" : "：\(self.envVerdict["理由"] ?? "")")")
            if !ok { return self.dump() }   // ⛔ 不测——节流期的数字没有意义
            self.runM1(index: 0)
        }
    }

    // ── M1：键入 → 下一次绘制 ──

    private func runM1(index: Int) {
        if index >= m1Count { return runM2(index: 0) }
        let ch = String(ProbeConst.m1Chars[index % ProbeConst.m1Chars.count])
        let id = "k\(index)-\(ch)"
        eval("window.__M1_BEGIN(\(js(id)))") { [weak self] _ in
            guard let self else { return }
            let wall = Date().timeIntervalSince1970 * 1000
            self.inject(ch)
            self.m1Walls[id] = wall
            // ⚠️ 轮询补集：注入之后等页面把这一条的记录写出来（⛔ 不靠页内定时器）。
            self.pollJSON("window.__M1_POP()", tries: 40, interval: 0.03) { rec in
                if var r = rec {
                    r["id"] = id
                    r["原生注入墙钟"] = wall
                    self.m1.append(r)
                    self.nativeLog.append("M1 \(id)：keydown→update \(r["keydown→update"] ?? "?") ms、"
                                          + "keydown→第二次 rAF \(r["keydown→paint"] ?? "?") ms")
                } else {
                    self.nativeLog.append("⛔ M1 \(id) 超时没拿到记录（键没到？）")
                    self.m1Miss += 1
                }
                // 每条之间留 ~350 ms（≥ 两次 rAF + 余量），免得前一条的 rAF 被后一条抢走
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self.runM1(index: index + 1) }
            }
        }
    }

    // ── M2：连续输入期间的预览调度 ──

    private func runM2(index: Int) {
        if index >= cases.count { return runM3() }
        m2Index = index
        let c = cases[index]
        m2Walls = []          // ⚠️ 每个测项自己的注入表，⛔ 别跨测项累加
        // 编辑器缓冲区复位（上一测项打的字清掉），再装调度器
        evalJSON("window.__M2_SETUP(\(js(c.id)), \(c.backendMs), \(c.blockMs), \(c.initialMs))") { [weak self] res in
            guard let self else { return }
            self.nativeLog.append("M2 \(c.id) 装配：\(res.map { String(describing: $0) } ?? "?")")
            self.eval("window.__M2_START()") { _ in
                self.runSegs(case: c, s: 0, k: 0)
            }
        }
    }

    /// 把一段段击键按间隔注入。
    /// ⚠️⚠️ 定时器与注入**都在 Swift 主线程上，且不等页面回话**——页面忙等**不会**卡住它
    /// （JS 跑在 WebContent 进程），否则"注入正好撞进忙等里"就永远量不到了。
    /// ⛔ 第一版在每次注入前先 `evaluateJavaScript("__M2_NOTE")` 把墙钟塞进页面，并
    /// **等那个回调**才注入下一个 —— 那条路在忙等期间**必然卡死**（页面主线程正忙，
    /// `evaluateJavaScript` 排在它后面）⇒ 注入循环正好在**最该采样的那 413 ms 里停摆**，
    /// 实测"撞上的键"只剩 1 个。2026-10-16 实测踩过。
    /// ⇒ 现在原生侧**只按期注入并记下自己的墙钟**，配对的活挪到 `__M2_COLLECT`（页面那时是空的）。
    private func runSegs(case c: BurstCase, s: Int, k: Int) {
        if s >= c.segs.count { return finishM2(c) }
        let seg = c.segs[s]
        if k >= seg.count {
            return DispatchQueue.main.asyncAfter(deadline: .now() + seg.gapAfterMs / 1000) {
                self.runSegs(case: c, s: s + 1, k: 0)
            }
        }
        let ch = String(ProbeConst.m1Chars[k % ProbeConst.m1Chars.count])
        // ⚠️ 墙钟在**注入之前**取：它代表"用户按下键的那一刻"（合成事件没有 HID 那一段提前量）。
        let wall = Date().timeIntervalSince1970 * 1000
        m2Walls.append(["key": ch, "wall": wall])
        inject(ch)
        DispatchQueue.main.asyncAfter(deadline: .now() + seg.intervalMs / 1000) {
            self.runSegs(case: c, s: s, k: k + 1)
        }
    }

    /// 打完之后：等"最慢的测项也该跑完"的时间，再取记录（档 C 还要手动点一次）。
    private func finishM2(_ c: BurstCase) {
        // 静默窗口：debounce 最多 1 s ＋ 一次重渲最多 c.backendMs（含主线程忙等）
        let settle = max(2.2, c.backendMs / 1000 + 1.0)
        DispatchQueue.main.asyncAfter(deadline: .now() + settle) {
            if c.manual {
                let wall = Date().timeIntervalSince1970 * 1000
                self.eval("window.__M2_MANUAL(\(wall))") { _ in
                    self.nativeLog.append("M2 \(c.id)：已手动触发「更新预览」")
                    DispatchQueue.main.asyncAfter(deadline: .now() + c.backendMs / 1000 + 1.0) {
                        self.collectM2(c)
                    }
                }
            } else {
                self.collectM2(c)
            }
        }
    }

    private func collectM2(_ c: BurstCase) {
        // ⚠️ 配对表按 `[[key, 墙钟], …]` 的形状递进去（页面按序号配）。
        let 配对 = m2Walls.map { [$0["key"] ?? "", $0["wall"] ?? 0] }
        let 配对JSON = (try? JSONSerialization.data(withJSONObject: 配对))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        evalJSON("window.__M2_COLLECT(\(js(配对JSON)))") { [weak self] obj in
            guard let self else { return }
            self.m2Raw[c.id] = obj ?? ["⛔": "__M2_COLLECT 取不到"]
            let n = (obj?["重渲"] as? [Any])?.count ?? -1
            let 键 = obj?["键数"] as? Int ?? (obj?["击键数"] as? Int ?? -1)
            self.nativeLog.append("M2 \(c.id) 记录已取：自动重渲 \(n) 次，击键 \(键) 条，注入 \(self.m2Walls.count) 条")
            if let bad = (obj?["配对"] as? [String: Any])?["首个不匹配"], !(bad is NSNull) {
                self.nativeLog.append("⚠️ M2 \(c.id) 注入表与 keydown **没对齐**：\(bad)")
            }
            // ⚠️ 档 C 手动那一次会把页面冻 ~4 s；给它一点喘息再进下一测项
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                self.runM2(index: self.m2Index + 1)
            }
        }
    }

    // ── M3：滚动位置变化（纯页面侧，无需注入） ──

    private func runM3() {
        evalJSON("window.__M3_RUN()") { [weak self] obj in
            guard let self else { return }
            self.m3 = obj ?? ["⛔": "__M3_RUN 取不到"]
            self.nativeLog.append("M3 完成")
            self.dump()
        }
    }

    // ── 注入 ──

    /// ⭐ 与 `editor-keyprobe.swift` **同一套**：本窗口不是 key window ⇒ `sendEvent` 会把键丢掉，
    /// 所以要显式复刻 AppKit 的两步。⚠️ 本探针只注入**无修饰键的单字符** ⇒ 只走响应者链这一条。
    private func inject(_ ch: String) {
        let ts = ProcessInfo.processInfo.systemUptime
        let code = keyCode(for: ch)
        func ev(_ type: NSEvent.EventType) -> NSEvent? {
            NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [],
                             timestamp: ts, windowNumber: window.windowNumber,
                             context: nil, characters: ch, charactersIgnoringModifiers: ch,
                             isARepeat: false, keyCode: code)
        }
        guard let down = ev(.keyDown), let up = ev(.keyUp) else { return }
        window.firstResponder?.keyDown(with: down)
        window.firstResponder?.keyUp(with: up)
    }

    /// ⚠️ keyCode 只用来造事件（`characters` 才是 WebKit 取字的地方），但送一个**不相符**的
    /// keyCode 会让 AppKit 的字符映射看起来矛盾 ⇒ 照 US 布局给全表。
    private func keyCode(for ch: String) -> UInt16 {
        switch ch {
        case "a": return 0;  case "b": return 11; case "c": return 8;  case "d": return 2
        case "e": return 14; case "f": return 3;  case "g": return 5;  case "h": return 4
        case "i": return 34; case "j": return 38; case "k": return 40; case "l": return 37
        case "m": return 46; case "n": return 45; case "o": return 31; case "p": return 35
        case "q": return 12; case "r": return 15; case "s": return 1;  case "t": return 17
        case "u": return 32; case "v": return 9;  case "w": return 13; case "x": return 7
        case "y": return 16; case "z": return 6
        default:  return 0
        }
    }

    // ── eval 工具 ──

    private func eval(_ js: String, done: @escaping (Any?) -> Void) {
        web.evaluateJavaScript(js) { v, e in
            if let e { self.nativeLog.append("⛔ \(js.prefix(48)) ⇒ \(e)") }
            done(v)
        }
    }

    private func evalBool(_ js: String, done: @escaping (Bool) -> Void) {
        eval(js) { done(($0 as? Bool) ?? false) }
    }

    private func evalJSON(_ js: String, done: @escaping ([String: Any]?) -> Void) {
        eval("JSON.stringify(\(js))") { v in
            guard let s = v as? String, s != "null", let d = s.data(using: .utf8),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
                return done(nil)
            }
            done(o)
        }
    }

    /// 轮询补集：每 `interval` 秒问一次，拿到非 null 就走（超时给 nil）。
    private func pollJSON(_ js: String, tries: Int, interval: Double,
                          done: @escaping ([String: Any]?) -> Void) {
        if tries <= 0 { return done(nil) }
        evalJSON(js) { [weak self] o in
            guard let self else { return }
            if let o { return done(o) }
            DispatchQueue.main.asyncAfter(deadline: .now() + interval) {
                self.pollJSON(js, tries: tries - 1, interval: interval, done: done)
            }
        }
    }

    private func js(_ s: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [s], options: [])
        let arr = String(data: data, encoding: .utf8)!
        return String(arr.dropFirst().dropLast())
    }

    private func elapsed() -> String {
        String(format: "%.2f", Date().timeIntervalSince(self.startedAt))
    }

    // ── 收尾 ──

    private func dump() {
        evalJSON("window.__STATE") { [weak self] page in
            guard let self else { return }
            let out: [String: Any] = [
                "回答": "design/0012 §7 步骤 0f：键入→绘制的延迟 / 连续输入期间的预览调度 / 滚动位置变化",
                "计时边界": [
                    "⛔_不含_HID到NSEvent": "合成事件绕过 WindowServer 的全局路由 ⇒ 真人的硬件中断 → AppKit 那一段不在任何数字里",
                    "⭐_注入到页面keydown": "每个键都记了原生墙钟与页面墙钟（见 M2 的 注入 一栏）⇒ 这一段是量的，⛔ 不是推的",
                    "M1_四段都在页面侧": "keydown → CM6 update → rAF → rAF。⚠️ 后两次 rAF 是'下一次绘制'的代理，⛔ 不是'像素真的上屏了'",
                    "⚠️_M2_的后端是模拟的": "Σ 取自已实测的分项（逐项见各测项的 出处），⛔ 不是这一趟真送了一次 IPC",
                    "⭐_主线程那一段是真忙等": "T5+T5b 用忙等真占主线程 ⇒ '重渲期间输入被推后多久'是真的量出来的",
                    "⛔_无_IME": "合成事件造不出输入法组合态",
                ],
                "前提": [
                    "窗口对用户可见": false,
                    "调过_NSApp_activate": false,
                    "用了_osascript_或_System_Events": false,
                    "全程一个进程": true,
                    "CM6_用真_bundle": true,
                    "preview_js_用真文件": true,
                    "热身秒": ProbeConst.warmupSeconds,
                ],
                "原生侧": [
                    "开始前的_前端应用": self.frontmostBefore,
                    "app_isActive": NSApp.isActive,
                    "window_isKey": self.window.isKeyWindow,
                    "window_isVisible": self.window.isVisible,
                    "window_alpha": Double(self.window.alphaValue),
                    "window_number": self.window.windowNumber,
                    "日志": self.nativeLog,
                    "耗时秒": Int(Date().timeIntervalSince(self.startedAt)),
                ],
                "E1_环境有效性": self.env ?? NSNull(),
                "E1_判定": self.envVerdict,
                "M1_键入到绘制": [
                    "测了几个键": self.m1.count,
                    "没拿到的键数": self.m1Miss,
                    "记录": self.m1,
                ],
                "M2_连续输入期间的预览调度": [
                    "各测项": cases.map { c in
                        ["id": c.id, "Σ": c.backendMs, "主线程段": c.blockMs,
                         "起始判据": c.initialMs, "出处": c.source,
                         "击键规格": c.segs.map { ["个数": $0.count, "间隔ms": $0.intervalMs,
                                                   "段后静默ms": $0.gapAfterMs] },
                         "手动触发": c.manual]
                    },
                    "记录": self.m2Raw,
                ],
                "M3_滚动位置变化": self.m3 ?? NSNull(),
                "页面侧": page ?? NSNull(),
            ]
            let data = try! JSONSerialization.data(withJSONObject: out,
                                                   options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            print(String(data: data, encoding: .utf8)!)
            fflush(stdout)
            NSApp.terminate(nil)
        }
    }
}

/// E1 判据 —— ⚠️ **只写在这一处**（结论与判据必须同源，⛔ 不在结果里另写一份）。
func verdict(for env: [String: Any]) -> [String: Any] {
    var reasons: [String] = []
    let raf = env["rAF"] as? [String: Any] ?? [:]
    let n = raf["n"] as? Int ?? 0
    let median = raf["中位间隔"] as? Double ?? -1
    if n < 40 { reasons.append("1000 ms 内 rAF 只有 \(n) 次（< 40）") }
    if !(median >= 10 && median <= 25) { reasons.append("rAF 中位间隔 \(median) ms 不在 [10, 25]") }
    let timers = env["定时器"] as? [String: Any] ?? [:]
    for (want, tol) in [("50", 20.0), ("150", 25.0), ("300", 30.0), ("1000", 100.0)] {
        guard let got = timers[want] as? Double else { reasons.append("\(want) ms 定时器没采到"); continue }
        let w = Double(want)!
        if abs(got - w) > tol { reasons.append("\(want) ms 定时器实测 \(got) ms（容差 ±\(tol)）") }
    }
    let layout = env["布局"] as? [String: Any] ?? [:]
    let sh = layout["scrollHeight"] as? Double ?? 0
    let ch = layout["clientHeight"] as? Double ?? 0
    if !(sh > ch && ch > 0) { reasons.append("布局不可滚（scrollHeight \(sh) / clientHeight \(ch)）") }
    return ["可用": reasons.isEmpty,
            "理由": reasons,
            "判据": "rAF ≥ 40 次/1000 ms 且中位间隔 ∈ [10,25] ms；50/150/300/1000 ms 定时器误差 ≤ 20/25/30/100 ms；scrollHeight > clientHeight > 0",
            "怎么读": "⚠️ 判成不可用 ⇒ 后面的数字一律无结论（节流期量不出真值），⛔ 别把那段数字当延迟"]
}

// ── 参数（⚠️ 只能在**顶层代码**里解析：脚本模式下顶层 `let` 是局部变量，类捕获不到）──

guard let pageDir = argValue("--page") else {
    fail("用法：editor-latency-probe --page <页面目录> [--only T-A,T-C] [--m1 12]")
}
/// ⚠️ 只测某几个测项（不同档位可以分开跑，避免一次跑太久）。
/// ⚠️⚠️ 分隔符**逗号与空白都收**：⛔ `sel.contains($0.id)` 那写法看着像子串匹配，
/// 其实是 **`Set.contains` 的成员判定**（`only.map` 拆掉 Optional 之后 `sel` 是那个 `Set`）
/// ⇒ `ONLY="T-A T-B"` 曾经**一个都匹配不上**。选中的是**精确 id**，2026-10-16 更正。
let 选 = argValue("--only").map { arg -> Set<String> in
    Set(arg.split(whereSeparator: { $0 == "," || $0.isWhitespace })
           .map { String($0) }
           .filter { !$0.isEmpty })
}
if let 选, let 坏的 = 选.subtracting(ProbeCases.all.map(\.id)).sorted().first {
    fail("--only 里没有这个测项：\(坏的)；可选：\(ProbeCases.all.map(\.id).joined(separator: ", "))")
}
let cases = 选.map { sel in ProbeCases.all.filter { sel.contains($0.id) } } ?? ProbeCases.all
if cases.isEmpty { fail("--only 没匹配上任何测项：\(ProbeCases.all.map(\.id))") }

let app = NSApplication.shared
// ⚠️ `.accessory`：没有 Dock 图标、不接管菜单栏，**且本进程从不激活自己**。
app.setActivationPolicy(.accessory)
let delegate = Delegate(pageDir: pageDir,
                        cases: cases,
                        m1Count: Int(argValue("--m1") ?? "12") ?? 12)
app.delegate = delegate
// ⚠️ 兜底超时：macOS **没有** `timeout(1)`，兜底只能自己带（同族探针一致，240 秒）。
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 240) {
    if Date().timeIntervalSince(wall) >= 239.5 {
        FileHandle.standardError.write("⛔ 240 秒没拿到结果\n".data(using: .utf8)!)
        exit(1)
    }
}
app.run()
