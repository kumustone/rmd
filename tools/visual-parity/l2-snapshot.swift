// rmd · 设计 0063《Mardo 端侧对照测试》§7.2 步 2 / §8.1 T6 —— L2 离屏取像
//
// # 这个文件干什么
//
// 把 build-l2-page.sh 构好的页面（`<dir>/index.html`，内含 `render_source` 产物与
// `__fixture.js` / `__fake-tauri.js` / `__harness.js` / `__parity-boot.js`）在**离屏**
// WKWebView 里渲染，然后用两条互不依赖的路径各出一张 PNG：
//
//   主路径：WKWebView.takeSnapshot(with: WKSnapshotConfiguration)
//           ⭐ `snapshotWidth` 的单位是 **point**，取 --width（默认 1000 pt）；
//              基线 DPR 2.0 ⇒ PNG 宽 2000 px。⛔ 绝不把 --width 当像素写进来。
//   备路径：NSView.cacheDisplay(in:to:)，按窗口真实 backing scale 出图。
//
// 两条路都成功时，本工具只报**两者的尺寸**与“两路都成功”这一事实；
// 「行带序列是否一致」由外部工具（bands.py / l2-check.sh）读两张 PNG 自行判定——
// 本工具不复制第二份行带算法。
//
// # 安全口径（最高优先，见 kb/0025）
//
//   ⛔ 不 NSApp.activate、不 makeKeyAndOrderFront / orderFront / makeKey、
//      不设置 frontmost、不 AXRaise、不 osascript / System Events / CGEvent、不合成按键。
//   ✅ 窗口骨架逐字复制 tools/wkwebview-probe/probe.swift:118–139：
//      `.prohibited` + `.borderless` + `alphaValue = 0`；再加同族探针统一的 `orderBack(nil)`
//      （只 alpha=0 而从不 order 的窗口，WebKit 当它完全不可见）。
//   自证三条：抓帧前后 `NSWorkspace.frontmostApplication`、`NSApp.isActive`、`window.isKeyWindow`。
//
// # 就绪协议
//
//   载入 index.html 后轮询 `window.__PARITY_READY`（由 __parity-boot.js 置位）。
//   若 `window.__PARITY_ERROR` 为真 ⇒ 打印该错误并以非 0 退出；
//   超过 --timeout 仍未就绪 ⇒ 同样以非 0 退出。
//
// # 用法
//
//   swiftc -O tools/visual-parity/l2-snapshot.swift -o /tmp/l2-snapshot
//   /tmp/l2-snapshot --page <dir> --out <png> [--width 1000] [--height 801]
//                     [--dpr 2] [--eval-file <js>] [--json <out.json>]
//                     [--timeout <ms>] [--no-snapshot-width]
//                     [--screen main|<CGDirectDisplayID>] [--negctl k=v,…]
//
//   --no-snapshot-width 仅用于自检：复现「800 pt、未设 snapshotWidth ⇒ 1600 px @ DPR2」
//   这一 2026-11-07 的既有实测口径；⛔ 正常 L2 取像不要用它（默认按设计设 snapshotWidth）。
//
// # 输出（stdout，一行一条，V 前导字段为机器可读键）
//
//   READY    ms=<n>  dpr=<x>  innerW=<w>  innerH=<h>
//   LAYOUT   <页面自证 JSON：稳定后的列宽 / 内容盒高 / overflow / 构页 provenance>
//   PRIMARY  <ok|fail>  <png>  <WxH>  [err]（N4：判据未过时 path=-，不交付）
//   BACKUP   <ok|fail>  <png>  <WxH>  [err]（同上）
//   SNAP     <交付给 --out 的 png>  <WxH>
//   SNAP_SOURCE  <primary|backup|force-scale>
//   DPR      px_per_pt=<x>  screen=<所选项 scale>  window_scale=<窗口实际 scale>
//            expected=<x|->  match=<1|0|->
//   SCALE_FORCED  requested=<x>  delivered=<x>
//   SCREEN   id=<CGDirectDisplayID>  name=<localizedName>  scale=<x>
//            main=<0|1>  screens=<n>  frame=<x,y,w,h>
//   SCREEN_IDENTITY  window_screen_id=<id|->  requested_screen_id=<id>
//            screen_scale=<x>  window_scale=<x>  id_match=<1|0>  scale_match=<1|0>
//            （N7：同 scale 多屏也要求窗口实际所在屏 == 请求屏）
//   BLANK    primary=<0|1>  backup=<0|1|->  （全透明或单色即 1）
//   COLOR_PARITY  delta_e76=<x>  max_channel=<n>
//            local_max_delta_e76=<x>  local_mean_delta_e76=<x>
//            local_blocks_over_1=<n>/<m>  local_pass=<1|0|skipped>
//            global_pass=<1|0>  pass=<0|1>
//            （N8：全局众数色 + 局部 16×16 块均值；跨像素尺度时 local 显式 skipped）
//   PROVENANCE  frame_sha256=<hex>  captured_at=<iso8601>  window_id=<n>
//   SELF     frontmost_before=<app>  frontmost_before_bundle=<id|->
//            frontmost_before_ok=<0|1>  frontmost_before_error=<msg|->
//            frontmost_after=...  frontmost_after_bundle=...  frontmost_after_ok=...
//            frontmost_after_error=...  frontmost_changed=<0|1>
//            NSApp.isActive=<true|false>  window.isKeyWindow=<true|false>
//            window.isVisible=<true|false>  window.alpha=<x>
//            window.ignoresMouseEvents=<true|false>
//            window_visible=<true|false>（= isVisible && alpha > 0，即"用户能看见"）
//   NEGCTL   alpha=<x|->  applied=<k1,k2|->  provided=<0|1>
//            （N3：测试开关留痕；未传时 applied=-）
//   INVALID  code=<n>  frame=<out.invalid|->  write_error=<msg|->  reasons=<...>
//            （N4：判据未过 ⇒ 帧只落 <out>.invalid，JSON 只落 <json>.invalid）
//
// 退出码：0 成功；3 __PARITY_ERROR；4 就绪超时；5 导航失败；7 eval-file 执行失败；
//         9 主备两路都出不了图（含两路均为空白帧）、或无可用显示器/无图形会话（环境无效）；
//         64 参数错误（含 --dpr 与实测不符、--screen 指定的显示器不存在、未知 --negctl 键）；
//         65 自证不成立（`bugs/0221/0224/0225/0265`：屏幕身份/scale 与实测不符、主备色彩
//         不一致、窗口可穿透未生效、离屏窗口对用户可见、帧 provenance 缺项）；
//         66 文件缺失；73 写文件失败。
//         判据未过时**不交付 `--out` 像素与 `--json`**（帧落到 `<out>.invalid` 并打印 INVALID）。

import Cocoa
import CryptoKit
import WebKit

// MARK: - 通用输出

private func fail(_ message: String, _ code: Int32 = 2) -> Never {
    FileHandle.standardError.write(("⛔ " + message + "\n").data(using: .utf8)!)
    exit(code)
}

private func emit(_ line: String) {
    // 用 FileHandle 直写，避免 stdout 被管道缓冲后在 exit() 时丢行。
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

private func oneLine(_ text: String) -> String {
    text.replacingOccurrences(of: "\t", with: " ")
        .replacingOccurrences(of: "\n", with: " ")
        .replacingOccurrences(of: "\r", with: " ")
}

private func writeData(_ data: Data, to path: String) -> String? {
    let url = URL(fileURLWithPath: path)
    do {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try data.write(to: url)
        return nil
    } catch {
        return "\(error)"
    }
}

private func writeText(_ text: String, to path: String) -> String? {
    writeData(text.data(using: .utf8)!, to: path)
}

/// 取像完成时刻（UTC、秒级 ISO-8601）。`bugs/0265` 要求帧自带取像时间，
/// ⛔ 不用 `snapshot.json` 的组装时刻冒充。
private func nowISO() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: Date())
}

private func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/// 选中的显示器自证（`bugs/0221`）：同一张帧必须能回答"跑在哪块屏、scale 多少"。
private struct ScreenInfo {
    var id: UInt32
    var name: String
    var scale: Double
    var isMain: Bool
    var frame: NSRect
    var visibleFrame: NSRect
    var screenCount: Int

    var json: [String: Any] {
        [
            "id": NSNumber(value: id),
            "localized_name": name,
            "backing_scale": scale,
            "is_main": isMain,
            "frame_pt": ["x": Double(frame.origin.x), "y": Double(frame.origin.y),
                         "w": Double(frame.width), "h": Double(frame.height)],
            "visible_frame_pt": ["x": Double(visibleFrame.origin.x),
                                 "y": Double(visibleFrame.origin.y),
                                 "w": Double(visibleFrame.width),
                                 "h": Double(visibleFrame.height)],
            "screen_count": screenCount,
        ]
    }

    var line: String {
        "SCREEN\tid=\(id)\tname=\(oneLine(name))\tscale=\(String(format: "%.2f", scale))" +
            "\tmain=\(isMain ? "1" : "0")\tscreens=\(screenCount)" +
            "\tframe=\(Int(frame.origin.x)),\(Int(frame.origin.y))," +
            "\(Int(frame.width)),\(Int(frame.height))"
    }
}

private func displayID(of screen: NSScreen) -> UInt32? {
    let key = NSDeviceDescriptionKey("NSScreenNumber")
    return (screen.deviceDescription[key] as? NSNumber)?.uint32Value
}

/// `main`（默认）= `NSScreen.main`（无则第一块）；数字 = 按 CGDirectDisplayID 精确匹配。
/// 指定了不存在的 ID ⇒ 调用方 exit 64，⛔ 不悄悄退回主屏（`bugs/0221`）。
private func resolveScreen(_ selector: String?) -> ScreenInfo? {
    let screens = NSScreen.screens
    // N14：没有显示器是**环境无效**（无图形会话/显示器全休眠），⛔ 不是参数错误。
    if screens.isEmpty {
        fail("环境无效：枚举不到任何显示器（无图形会话 / 显示器全部休眠）⇒ 本轮不取像", 9)
    }
    let chosen: NSScreen?
    if let selector = selector, selector != "main" {
        guard let wanted = UInt32(selector) else { return nil }
        chosen = screens.first { displayID(of: $0) == wanted }
    } else {
        chosen = NSScreen.main ?? screens.first
    }
    guard let screen = chosen, let id = displayID(of: screen) else { return nil }
    return ScreenInfo(id: id,
                      name: screen.localizedName,
                      scale: Double(screen.backingScaleFactor),
                      isMain: screen == NSScreen.main,
                      frame: screen.frame,
                      visibleFrame: screen.visibleFrame,
                      screenCount: screens.count)
}

// MARK: - 像素自证：空白帧与色彩一致性

/// 局部色彩判据的网格边长（`bugs/0224` / N8）。
/// 白底页的全局众数色几乎总是白色，只看众数会「失明」；16×16 块均值覆盖整幅图，
/// 任一区域的系统性偏色都会体现在对应块的 ΔE 上。
private let colorBlockGrid = 16

/// 一张 PNG 的最小内容统计（`bugs/0222` / `0224`）。
/// ⛔ 不做第二套排版判定，只看「是否全透明/单色」、众数色与分块均值，供两路互换性自证。
private struct ImageStats {
    var width = 0
    var height = 0
    var sampled = 0
    var unique = 0
    var alphaZero = 0
    var blank = false
    var modeRGB: (Int, Int, Int) = (0, 0, 0)
    /// 每块的平均 sRGB（半透明按白底合成后）。
    var blockMeans: [(Int, Int, Int)] = Array(repeating: (0, 0, 0),
                                               count: colorBlockGrid * colorBlockGrid)
    var blockCounts: [Int] = Array(repeating: 0,
                                   count: colorBlockGrid * colorBlockGrid)

    var blankReason: String? {
        guard blank else { return nil }
        if sampled > 0 && alphaZero == sampled { return "fully-transparent" }
        return "single-color"
    }

    var json: [String: Any] {
        [
            "width": width,
            "height": height,
            "sampled": sampled,
            "unique_colors": unique,
            "alpha_zero": alphaZero,
            "blank": blank,
            "blank_reason": blankReason ?? NSNull(),
            "mode_rgb": [modeRGB.0, modeRGB.1, modeRGB.2],
            "block_grid": colorBlockGrid,
        ]
    }
}

/// 解码 PNG → 8-bit sRGB RGBA，按网格抽样。
private func imageStats(_ data: Data) -> ImageStats? {
    guard let rep = NSBitmapImageRep(data: data),
          let cg = rep.cgImage else { return nil }
    let width = cg.width
    let height = cg.height
    guard width > 0, height > 0,
          let space = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: width, height: height,
                              bitsPerComponent: 8, bytesPerRow: width * 4,
                              space: space,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                                        | CGBitmapInfo.byteOrder32Big.rawValue) else {
        return nil
    }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let raw = ctx.data else { return nil }
    let buffer = raw.bindMemory(to: UInt8.self, capacity: width * height * 4)

    var stats = ImageStats(width: width, height: height)
    let total = width * height
    let stride = max(1, total / 40000)
    var counts: [Int: Int] = [:]
    var blockSums = Array(repeating: [0, 0, 0],
                          count: colorBlockGrid * colorBlockGrid)
    var i = 0
    while i < total {
        let o = i * 4
        let a = Int(buffer[o + 3])
        // 与 bands.py 一致：半透明按白底合成。
        let r = (Int(buffer[o]) * a + 255 * (255 - a) + 127) / 255
        let g = (Int(buffer[o + 1]) * a + 255 * (255 - a) + 127) / 255
        let b = (Int(buffer[o + 2]) * a + 255 * (255 - a) + 127) / 255
        if a == 0 { stats.alphaZero += 1 }
        // N8：按像素坐标归入 16×16 网格（与采样步长无关）。
        let x = i % width
        let y = i / width
        let bx = min(colorBlockGrid - 1, x * colorBlockGrid / width)
        let by = min(colorBlockGrid - 1, y * colorBlockGrid / height)
        let bi = by * colorBlockGrid + bx
        blockSums[bi][0] += r
        blockSums[bi][1] += g
        blockSums[bi][2] += b
        stats.blockCounts[bi] += 1
        let key = (r << 16) | (g << 8) | b
        counts[key, default: 0] += 1
        stats.sampled += 1
        i += stride
    }
    stats.unique = counts.count
    if let (key, _) = counts.max(by: { $0.value < $1.value }) {
        stats.modeRGB = ((key >> 16) & 0xFF, (key >> 8) & 0xFF, key & 0xFF)
    }
    for bi in 0..<(colorBlockGrid * colorBlockGrid) where stats.blockCounts[bi] > 0 {
        let n = stats.blockCounts[bi]
        stats.blockMeans[bi] = (blockSums[bi][0] / n,
                                blockSums[bi][1] / n,
                                blockSums[bi][2] / n)
    }
    stats.blank = stats.sampled > 0
        && (stats.alphaZero == stats.sampled || stats.unique <= 1)
    return stats
}

/// sRGB → CIE Lab（D65），只用于两路互换性的粗判；M4 的 ΔE2000 权威实现仍在 bands.py。
private func srgbToLab(_ rgb: (Int, Int, Int)) -> (Double, Double, Double) {
    func linear(_ v: Int) -> Double {
        let c = Double(v) / 255.0
        return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }
    let r = linear(rgb.0), g = linear(rgb.1), b = linear(rgb.2)
    let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883
    func f(_ t: Double) -> Double {
        t > 216.0 / 24389.0 ? pow(t, 1.0 / 3.0) : (24389.0 / 27.0 * t + 16.0) / 116.0
    }
    let fx = f(x), fy = f(y), fz = f(z)
    return (116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz))
}

private func deltaE76(_ a: (Int, Int, Int), _ b: (Int, Int, Int)) -> Double {
    let la = srgbToLab(a), lb = srgbToLab(b)
    return sqrt(pow(la.0 - lb.0, 2) + pow(la.1 - lb.1, 2) + pow(la.2 - lb.2, 2))
}

/// 两路图的局部块差异（N8 / `bugs/0224`）。
/// 只比**两路都有像素**的块；块均值覆盖整幅图，白底页不会因为众数色是白色而漏判。
private struct LocalColorDiff {
    var maxDelta = 0.0
    var meanDelta = 0.0
    var blocksCompared = 0
    var blocksOverOne = 0

    /// 阈值工具侧暂定（待设计批准）：块均值 max ≤ 1.5 且 mean ≤ 0.5。
    /// 实测（2026-11-08，`/tmp/fix3-A/colorprobe`）：合法主备对 max 0.447–0.852、
    /// mean 0.020–0.033；P3 误标对 max 2.309–7.478、mean 1.154–5.337。
    var pass: Bool { blocksCompared > 0 && maxDelta <= 1.5 && meanDelta <= 0.5 }

    var json: [String: Any] {
        [
            "grid": colorBlockGrid,
            "blocks_compared": blocksCompared,
            "max_delta_e76": maxDelta,
            "mean_delta_e76": meanDelta,
            "blocks_over_1": blocksOverOne,
            "threshold": ["max_delta_e76": 1.5, "mean_delta_e76": 0.5],
            "pass": pass,
            "source": "16×16 块均值（sRGB→Lab，ΔE76）",
        ]
    }
}

private func localColorDiff(_ a: ImageStats, _ b: ImageStats) -> LocalColorDiff {
    var diff = LocalColorDiff()
    var sum = 0.0
    for i in 0..<(colorBlockGrid * colorBlockGrid)
        where a.blockCounts[i] > 0 && b.blockCounts[i] > 0 {
        let d = deltaE76(a.blockMeans[i], b.blockMeans[i])
        diff.blocksCompared += 1
        sum += d
        if d > diff.maxDelta { diff.maxDelta = d }
        if d > 1.0 { diff.blocksOverOne += 1 }
    }
    if diff.blocksCompared > 0 {
        diff.meanDelta = sum / Double(diff.blocksCompared)
    }
    return diff
}

// MARK: - 自证：屏幕归因（N7 / bugs/0221）

/// 帧能否归因到 `--screen` 指定的那块屏。
/// ⭐ 必须同时满足：窗口**实际所在屏**的 displayID 等于请求屏（同 scale 多屏也能发现错配），
/// 且交付帧的 px/pt 等于**该屏**的 `backingScaleFactor`。
private struct ScreenAttribution {
    var idMatch: Bool
    var scaleMatch: Bool
    var ok: Bool { idMatch && scaleMatch }
}

private func screenAttribution(windowScreenID: UInt32?,
                               requestedScreenID: UInt32,
                               observed: Double,
                               screenScale: Double) -> ScreenAttribution {
    ScreenAttribution(idMatch: windowScreenID == requestedScreenID,
                      scaleMatch: abs(observed - screenScale) <= 0.01)
}

// MARK: - 自证：前台应用

/// `bugs/0181`：前台迁移应用必须同时留下**名字、bundle id 与是否读成功**。
/// ⛔ 只写 `localizedName`（无 bundle）或把「读不到」写成占位符相等，都是零证据的绿。
private struct FrontmostInfo {
    var name: String? = nil
    var bundleID: String? = nil
    var pid: Int? = nil
    var error: String? = nil

    /// 至少有一项真实身份才算读到；⛔ 占位符不算。
    var readOK: Bool { name != nil || bundleID != nil }
    /// 兼容旧读者：未读到时保留 `<无法读取>` 占位符（同时用 read_ok=false 显式标记）。
    /// 名字缺失但 bundle 读到（少见）时退到 bundle，⛔ 不把「读到了 bundle」写成占位符。
    var displayName: String { name ?? bundleID ?? "<无法读取>" }
    /// 身份比较用：名字或 bundle 任一不同即认为前台变了。
    func differs(from other: FrontmostInfo) -> Bool {
        name != other.name || bundleID != other.bundleID
    }

    var json: [String: Any] {
        [
            "name": name ?? NSNull(),
            "bundle_id": bundleID ?? NSNull(),
            "pid": pid.map { NSNumber(value: $0) } ?? NSNull(),
            "read_ok": readOK,
            "error": error ?? NSNull(),
        ]
    }
}

private func frontmostInfo() -> FrontmostInfo {
    guard let app = NSWorkspace.shared.frontmostApplication else {
        return FrontmostInfo(error: "NSWorkspace.frontmostApplication=nil"
                             + "（锁屏 / 无图形会话 / 切用户）")
    }
    var info = FrontmostInfo(name: app.localizedName,
                             bundleID: app.bundleIdentifier,
                             pid: Int(app.processIdentifier))
    if info.name == nil && info.bundleID == nil {
        info.error = "frontmostApplication 无可读身份（name/bundle 均为 nil）"
    }
    return info
}

// MARK: - 参数

private struct Options {
    var pageDir = ""
    var outPNG = ""
    var width: CGFloat = 1000
    var height: CGFloat = 801
    var dpr: CGFloat? = nil          // 期望 DPR；与实测不符 ⇒ 退出 64（⛔ 不静默通过）
    var evalFile: String? = nil
    var jsonOut: String? = nil
    var timeoutMS = 15000
    var noSnapshotWidth = false
    var forceScale: CGFloat? = nil   // 强制 1×/其它 backing scale 重新栅格化（N6）
    var alphaOverride: CGFloat? = nil // 仅负对照：强制窗口 alphaValue（⛔ 不用于取像）
    var screenSelector: String? = nil // 目标显示器：main（默认）或 CGDirectDisplayID（bugs/0221）
    var negctl: [String: String] = [:] // 仅负对照开关，见 USAGE（⛔ L2 取像不得传）

    /// 负对照开关：`--negctl key=1`。
    func neg(_ key: String) -> Bool { negctl[key] == "1" }

    /// N3：落盘用的稳定顺序键表（env/negctl_applied）。
    var negctlApplied: [String] { negctl.keys.sorted() }
}

private let USAGE = """
用法: l2-snapshot --page <dir> --out <png> [选项]
  --page <dir>            含 index.html 的目录（必填）
  --out <png>             主路径输出 PNG（必填）
  --width <pt>            画布宽（point），默认 1000
  --height <pt>           画布高（point），默认 801
  --dpr <float>           期望 DPR；与实测 px/pt 不符 ⇒ 退出 64（⛔ 不静默通过）
  --force-scale <float>   按指定 backing scale 重新栅格化（N6：`--force-scale 1`）
  --eval-file <js>        页面就绪后执行的 JS，其结果与自证环境合并写入 --json
  --json <out.json>       自证 JSON（eval 模式下 env 与测量结果**合并**，⛔ 不互相覆盖）
  --timeout <ms>          等 __PARITY_READY 的超时，默认 15000
  --no-snapshot-width     自检用：不设 snapshotWidth（取 WKWebView 自身宽度）
  --screen <main|id>      目标显示器：main（默认）或 CGDirectDisplayID；找不到 ⇒ 退出 64
  --alpha <float>         ⚠️ 仅负对照：强制窗口 alphaValue（默认 0；⛔ 不用于 L2 取像）
  --negctl <k=v,...>      ⚠️ 仅负对照：blank_primary=1 /
                          primary_colorspace=displayP3|p3_as_srgb /
                          ignores_mouse_events=0 / no_window_id=1
                          （未知键/取值 ⇒ 退出 64，⛔ 不静默忽略；会写进 env）
  -h, --help              显示本帮助
"""

private func parseArgs(_ argv: [String]) -> Options {
    var o = Options()
    var i = 1
    func value(_ name: String) -> String {
        i += 1
        guard i < argv.count else { fail("参数 \(name) 缺值\n\(USAGE)", 64) }
        return argv[i]
    }
    while i < argv.count {
        switch argv[i] {
        case "--page": o.pageDir = value("--page")
        case "--out": o.outPNG = value("--out")
        case "--width":
            let raw = value("--width")
            guard let v = Double(raw), v > 0 else { fail("--width 不是正数：\(raw)", 64) }
            o.width = CGFloat(v)
        case "--height":
            let raw = value("--height")
            guard let v = Double(raw), v > 0 else { fail("--height 不是正数：\(raw)", 64) }
            o.height = CGFloat(v)
        case "--dpr":
            let raw = value("--dpr")
            guard let v = Double(raw), v > 0 else { fail("--dpr 不是正数：\(raw)", 64) }
            o.dpr = CGFloat(v)
        case "--eval-file": o.evalFile = value("--eval-file")
        case "--json": o.jsonOut = value("--json")
        case "--force-scale":
            let raw = value("--force-scale")
            guard let v = Double(raw), v > 0 else { fail("--force-scale 不是正数：\(raw)", 64) }
            o.forceScale = CGFloat(v)
        case "--alpha":
            let raw = value("--alpha")
            guard let v = Double(raw), v >= 0, v <= 1 else {
                fail("--alpha 必须在 [0,1]：\(raw)", 64)
            }
            o.alphaOverride = CGFloat(v)
        case "--screen": o.screenSelector = value("--screen")
        case "--negctl":
            let raw = value("--negctl")
            let known: Set<String> = ["blank_primary", "primary_colorspace",
                                      "ignores_mouse_events", "no_window_id"]
            var parsed: [String: String] = [:]
            for pair in raw.split(separator: ",") where !pair.isEmpty {
                let parts = pair.split(separator: "=", maxSplits: 1)
                guard parts.count == 2 else { fail("--negctl 需要 k=v：\(pair)", 64) }
                let key = String(parts[0])
                let val = String(parts[1])
                // N3：未知键必须拒绝，⛔ 不许静默忽略（写错的负对照看起来会像通过）。
                guard known.contains(key) else {
                    fail("未知 --negctl 键 '\(key)'（允许："
                         + known.sorted().joined(separator: ",") + "）", 64)
                }
                // 值也要可解释；未知取值同样拒绝，避免拼写错误被吞掉。
                switch key {
                case "primary_colorspace":
                    guard val == "displayP3" || val == "p3_as_srgb" else {
                        fail("--negctl primary_colorspace 只接受 displayP3|p3_as_srgb，实得 '\(val)'", 64)
                    }
                case "ignores_mouse_events":
                    guard val == "0" || val == "1" || val == "false" || val == "true" else {
                        fail("--negctl ignores_mouse_events 只接受 0|1|false|true，实得 '\(val)'", 64)
                    }
                default:
                    guard val == "0" || val == "1" else {
                        fail("--negctl \(key) 只接受 0|1，实得 '\(val)'", 64)
                    }
                }
                parsed[key] = val
            }
            o.negctl = parsed
        case "--timeout":
            let raw = value("--timeout")
            guard let v = Int(raw), v > 0 else { fail("--timeout 不是正整数：\(raw)", 64) }
            o.timeoutMS = v
        case "--no-snapshot-width": o.noSnapshotWidth = true
        case "-h", "--help":
            emit(USAGE)
            exit(0)
        default:
            fail("未知参数 \(argv[i])\n\(USAGE)", 64)
        }
        i += 1
    }
    if o.pageDir.isEmpty { fail("必须给 --page\n\(USAGE)", 64) }
    if o.outPNG.isEmpty { fail("必须给 --out\n\(USAGE)", 64) }
    return o
}

// MARK: - 就绪探测

private let READY_JS = """
(() => {
  try {
    return JSON.stringify({
      ready: !!window.__PARITY_READY,
      error: (typeof window.__PARITY_ERROR === "undefined" || window.__PARITY_ERROR === null)
        ? null : String(window.__PARITY_ERROR),
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight
    });
  } catch (e) {
    return JSON.stringify({
      ready: false,
      error: "READY_JS throw: " + e.name + ": " + e.message,
      dpr: null, innerWidth: null, innerHeight: null
    });
  }
})()
"""

private struct ReadyState {
    var ready = false
    var error: String? = nil
    var dpr: Double? = nil
    var innerWidth: Double? = nil
    var innerHeight: Double? = nil
}

/// 页面自证（`bugs/0117` / `0121` / `0154`）：稳定后的布局量、就绪细节、构页 provenance。
/// ⚠️ 页面由 `build-l2-page.sh` 生成；老页面没有这些全局 ⇒ `available=false` 并显式记录。
private struct PageState {
    var available = false
    var ready: Bool? = nil
    var error: String? = nil
    var fontsReady: Bool? = nil
    var stableFrames: Int? = nil
    var frames: Int? = nil
    var layout: Any? = nil
    var provenance: Any? = nil
    var raw: String = "null"
}

private let PAGE_STATE_JS = """
(() => {
  try {
    var boot = window.__PARITY_BOOT || null;
    var layout = window.__PARITY_LAYOUT || null;
    var prov = window.__PARITY_PROVENANCE || null;
    return JSON.stringify({
      available: !!(boot || layout || prov),
      ready: (typeof window.__PARITY_READY === "boolean") ? window.__PARITY_READY : null,
      error: (typeof window.__PARITY_ERROR === "string") ? window.__PARITY_ERROR : null,
      boot: boot,
      layout: layout,
      provenance: prov
    });
  } catch (e) {
    return JSON.stringify({ available: false, error: "PAGE_STATE_JS throw: " + e.name + ": " + e.message });
  }
})()
"""

// MARK: - 取像器

/// `finish()` 判完闸门后交给 `environmentInfo()` 的全部事实。
/// 用结构体而不是二三十个参数，避免「少传一项就静默写成默认值」。
private struct DeliveryFacts {
    var status = "ok"                 // ok | invalid
    var delivered = true              // 是否交付到 --out
    var pngPath: String? = nil        // 实际交付/落盘路径（invalid 时是 <out>.invalid）
    var finalSize: (Int, Int) = (0, 0)
    var observed: Double = 0
    var screenScale: Double = 0
    var windowScale: Double = 0
    var windowScreenID: UInt32? = nil
    var screenIdentityOK = false
    var scaleOK = false
    var dprMatch: Bool? = nil
    var primaryPath: String? = nil
    var backupPath: String? = nil
    var source = ""
    var frontAfter = FrontmostInfo()
    var frontChanged = false
    var alpha: Double = 0
    var alphaOverride: Double? = nil
    var appkitVisible = false
    var effectiveVisible = false
    var visibleSource = "window"
    var ignoresMouse = true
    var primaryStats: ImageStats? = nil
    var backupStats: ImageStats? = nil
    var primaryBlank = false
    var backupBlank = false
    var colorParity: [String: Any] = [:]
    var colorParityPass: Bool? = nil
    var capturedAt = ""
    var frameSHA: String? = nil
    var windowID: Int? = nil
    var provenanceComplete = false
    var invalidReasons: [String] = []
    var invalidCode: Int32? = nil
}

private final class Runner: NSObject, WKNavigationDelegate {
    private let opts: Options
    private let frontBefore: FrontmostInfo
    private let startedAt = Date()
    private var finished = false
    // --eval-file 的结果延后到取像之后再落盘：这样同一份 JSON 能同时带测量与环境自证。
    private var evalRaw: String? = nil
    private var evalValue: Any? = nil
    private var evalPage = PageState()

    private let webView: WKWebView
    private let window: NSWindow
    private let screen: ScreenInfo

    init(opts: Options, frontBefore: FrontmostInfo) {
        self.opts = opts
        self.frontBefore = frontBefore

        // `bugs/0221`：显式选目标显示器并记下身份；指定了不存在的 ID ⇒ 64，⛔ 不悄悄退回主屏。
        guard let screen = resolveScreen(opts.screenSelector) else {
            let available = NSScreen.screens.compactMap { s in
                displayID(of: s).map { "\($0)=\(s.localizedName)" }
            }.joined(separator: ", ")
            fail("找不到 --screen \(opts.screenSelector ?? "main") 指定的显示器"
                 + "（可用：\(available.isEmpty ? "无" : available)）", 64)
        }
        self.screen = screen

        // ── 以下窗口骨架逐字复制 tools/wkwebview-probe/probe.swift:118–139 ──
        // ⚠️⚠️ **`.prohibited`，⛔ 不是 `.accessory`**（`kb/0025` ＋ 2026-10-21 实测）：
        //    `.accessory` 只是"没有 Dock 图标"，**仍会被激活**——从正在前台的终端里起进程时，
        //    实测 `frontmostApplication` 会从 `iTerm2` 变成探针自己。本探针不依赖焦点/键盘，
        //    ⇒ 换 `.prohibited`（结构上不允许被激活），代价为零。
        let app = NSApplication.shared
        _ = app.setActivationPolicy(.prohibited)

        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = false

        let rect = NSRect(x: 0, y: 0, width: opts.width, height: opts.height)
        self.webView = WKWebView(frame: rect, configuration: config)

        let window = NSWindow(contentRect: rect,
                              styleMask: [.borderless],
                              backing: .buffered,
                              defer: false)
        window.contentView = self.webView
        // ⚠️ 不 orderFront：窗口不进屏幕，但 WebView 仍是"已附着"状态，
        //    布局与 paint 照常发生。这样跑探针不会打断用户。
        window.alphaValue = opts.alphaOverride ?? 0
        // `bugs/0225`：显式点击穿透，⛔ 不依赖 AppKit 默认值（alpha=0 不参与命中测试）。
        //    ⚠️ "点击不被吞"的最终证明需要可见会话/真实事件，属人工验收（P7 禁合成事件）。
        window.ignoresMouseEvents = true
        if opts.negctl["ignores_mouse_events"] == "0"
            || opts.negctl["ignores_mouse_events"] == "false" {
            // 仅负对照：把显式设置撤销，验证下游自证会红而不是静默通过。
            window.ignoresMouseEvents = false
        }
        // `bugs/0221`：把窗口放到所选显示器的可见区域原点，让 backingScaleFactor
        // 真正取自这块屏；仍是 alpha=0 + orderBack + 不可激活，不打扰用户。
        window.setFrameOrigin(screen.visibleFrame.origin)
        self.window = window

        super.init()

        self.webView.navigationDelegate = self
        // ⚠️ `orderBack`（⛔ 不是 `orderFront`、⛔ 不是 `makeKeyAndOrderFront`）：
        //    只 `alphaValue = 0` 而从不 order 的窗口，WebKit 当它完全不可见。
        //    `orderBack` 把它排在用户前台应用**之后**，且本进程在 `.prohibited` 下不可能被激活。
        //    ⛔ **不调 `makeKey()`**：本探针不依赖键盘焦点。
        window.orderBack(nil)
    }

    func start() {
        let base = URL(fileURLWithPath: opts.pageDir, isDirectory: true)
        let html = base.appendingPathComponent("index.html")
        guard FileManager.default.fileExists(atPath: html.path) else {
            fail("找不到页面 \(html.path)", 66)
        }
        // 最终兜底：导航/轮询任一环节卡住也不能挂死。
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(opts.timeoutMS) / 1000.0) {
            self.watchdogFired()
        }
        webView.loadFileURL(html, allowingReadAccessTo: base)
    }

    // MARK: 导航

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pollReady()
    }

    func webView(_ webView: WKWebView,
                 didFail navigation: WKNavigation!,
                 withError error: Error) {
        fail("导航失败：\(error)", 5)
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        fail("导航失败：\(error)", 5)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fail("WebContent 进程终止", 5)
    }

    // MARK: 就绪轮询

    private func pollReady() {
        guard !finished else { return }
        webView.evaluateJavaScript(READY_JS) { [weak self] result, error in
            guard let self = self, !self.finished else { return }
            if let error = error {
                fail("轮询 __PARITY_READY 失败：\(error)", 5)
            }
            let state = self.parseReady(result)
            if state.ready {
                self.finished = true
                self.afterReady(state)
                return
            }
            if let err = state.error {
                fail("__PARITY_ERROR: \(err)", 3)
            }
            let elapsedMS = Date().timeIntervalSince(self.startedAt) * 1000
            if elapsedMS >= Double(self.opts.timeoutMS) {
                fail("__PARITY_READY 超时（\(self.opts.timeoutMS) ms）", 4)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.pollReady() }
        }
    }

    private func watchdogFired() {
        guard !finished else { return }
        // 导航可能根本没回 didFinish；最后再试一次就绪态，然后统一报错。
        webView.evaluateJavaScript(READY_JS) { [weak self] result, _ in
            guard let self = self, !self.finished else { return }
            let state = self.parseReady(result)
            if state.ready {
                self.finished = true
                self.afterReady(state)
            } else if let err = state.error {
                fail("__PARITY_ERROR: \(err)", 3)
            } else {
                fail("__PARITY_READY 超时（\(self.opts.timeoutMS) ms）", 4)
            }
        }
    }

    private func parseReady(_ value: Any?) -> ReadyState {
        guard let text = value as? String,
              let data = text.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return ReadyState(ready: false,
                              error: "READY_JS 返回值不可解析：\(String(describing: value))")
        }
        var state = ReadyState()
        state.ready = (object["ready"] as? Bool) ?? ((object["ready"] as? NSNumber)?.boolValue ?? false)
        if let err = object["error"] as? String { state.error = err }
        state.dpr = (object["dpr"] as? NSNumber)?.doubleValue
        state.innerWidth = (object["innerWidth"] as? NSNumber)?.doubleValue
        state.innerHeight = (object["innerHeight"] as? NSNumber)?.doubleValue
        return state
    }

    // MARK: 就绪之后：可选 eval → 取像

    private func afterReady(_ state: ReadyState) {
        let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
        emit("READY\tms=\(elapsed)" +
             "\tdpr=\(state.dpr.map { "\($0)" } ?? "?")" +
             "\tinnerW=\(state.innerWidth.map { "\(Int($0.rounded()))" } ?? "?")" +
             "\tinnerH=\(state.innerHeight.map { "\(Int($0.rounded()))" } ?? "?")")

        // ⭐ `bugs/0117` / `0121`：页面在"布局稳定"后才置的就绪信号，这里把稳定值取回来。
        fetchPageState { page in
            self.runEvalIfNeeded(page) {
                self.takeSnapshots(page)
            }
        }
    }

    /// 取页面的布局自证与构页 provenance（`__PARITY_LAYOUT` / `__PARITY_PROVENANCE`）。
    /// ⚠️ 取不到不致命，但**必须留下 `available=0`**：⛔ 不让"没有布局自证"静默变成通过。
    private func fetchPageState(_ done: @escaping (PageState) -> Void) {
        webView.evaluateJavaScript(PAGE_STATE_JS) { result, error in
            var page = PageState()
            if let error = error {
                emit("LAYOUT\tavailable=0\terror=" + oneLine("\(error)"))
                done(page)
                return
            }
            guard let text = result as? String else {
                emit("LAYOUT\tavailable=0\terror=返回值不是字符串")
                done(page)
                return
            }
            page.raw = text
            guard let object = Self.parseJSON(text) as? [String: Any] else {
                emit("LAYOUT\tavailable=0\terror=JSON 不可解析")
                done(page)
                return
            }
            page.available = (object["available"] as? Bool) ?? false
            page.ready = object["ready"] as? Bool
            page.error = object["error"] as? String
            if let boot = object["boot"] as? [String: Any] {
                page.fontsReady = boot["fonts_ready"] as? Bool
                page.stableFrames = (boot["stable_frames"] as? NSNumber)?.intValue
                page.frames = (boot["frames"] as? NSNumber)?.intValue
            }
            page.layout = object["layout"]
            page.provenance = object["provenance"]
            emit("LAYOUT\t" + oneLine(text))
            done(page)
        }
    }

    private static func parseJSON(_ text: String) -> Any? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    /// --eval-file 是 DOM 侧度量（DOM 行盒数、computed style）的通道：
    /// 页面就绪后执行，结果在取像后与自证环境**合并**写入 --json（`bugs/0126`）。
    private func runEvalIfNeeded(_ page: PageState, _ done: @escaping () -> Void) {
        guard let path = opts.evalFile else {
            done()
            return
        }
        let source: String
        do {
            source = try String(contentsOfFile: path, encoding: .utf8)
        } catch {
            fail("读不出 --eval-file \(path)：\(error)", 66)
        }
        webView.evaluateJavaScript(source) { [weak self] result, error in
            guard let self = self else { return }
            if let error = error {
                fail("--eval-file 执行失败：\(error)", 7)
            }
            let text = Self.jsonText(from: result ?? NSNull())
            self.evalRaw = text
            self.evalValue = Self.parseJSON(text) ?? text
            self.evalPage = page
            done()
        }
    }

    private static func jsonText(from value: Any) -> String {
        if let string = value as? String { return string }
        if value is NSNull { return "null" }
        if JSONSerialization.isValidJSONObject(value) {
            if let data = try? JSONSerialization.data(withJSONObject: value,
                                                      options: [.prettyPrinted, .sortedKeys]),
               let text = String(data: data, encoding: .utf8) {
                return text
            }
        }
        if let number = value as? NSNumber { return number.stringValue }
        return String(describing: value)
    }

    // MARK: 取像

    /// ⚠️ 仅负对照：在交付前替换主路图（空白帧 / 错误色彩标记）。
    private func negctlImage(_ image: (data: Data, width: Int, height: Int)?)
        -> (data: Data, width: Int, height: Int)? {
        guard let image = image else { return nil }
        if opts.neg("blank_primary") {
            guard let data = Self.blankPNG(width: image.width, height: image.height) else {
                return image
            }
            return (data, image.width, image.height)
        }
        switch opts.negctl["primary_colorspace"] ?? "" {
        case "displayP3":
            if let space = CGColorSpace(name: CGColorSpace.displayP3),
               let retagged = Self.retagPNG(image.data, to: space) {
                return retagged
            }
        case "p3_as_srgb":
            if let mislabeled = Self.p3BytesTaggedSRGB(image.data) {
                return mislabeled
            }
        default:
            break
        }
        return image
    }

    private func takeSnapshots(_ page: PageState) {
        // 主路径：WKSnapshotConfiguration。
        // ⭐ `snapshotWidth` 以 **point** 计：取 --width（默认 1000 pt）。
        //    基线 DPR 2.0 ⇒ PNG 宽 = 2000 px。⛔ 不要把它写成像素。
        let config = WKSnapshotConfiguration()
        config.rect = NSRect(x: 0, y: 0, width: opts.width, height: opts.height)
        if !opts.noSnapshotWidth {
            config.snapshotWidth = NSNumber(value: Double(opts.width))
        }
        // --no-snapshot-width：不设 snapshotWidth，取 WKWebView 自身宽度（= --width）。
        // 仅用于复现 2026-11-07「800 pt ⇒ 1600 px @ DPR2」的既有实测口径。

        // ⭐ `bugs/0125`：`--force-scale N` 用 CGContext 按 N× **重新栅格化**同一份布局，
        //    ⛔ 不是把 2× 图降采样。这样 `--dpr 1` 在两倍屏上也能真的产出 1000 px。
        if let forced = opts.forceScale {
            var primary: (data: Data, width: Int, height: Int)? = nil
            var primaryError: String? = nil
            if let png = self.negctlImage(self.cacheDisplayPNG(scale: forced)) {
                primary = png
            } else {
                primaryError = "强制 \(forced)× 栅格化未产出位图"
            }
            var backup: (data: Data, width: Int, height: Int)? = nil
            var backupError: String? = nil
            if let png = self.cacheDisplayPNG(scale: self.window.backingScaleFactor) {
                backup = png
            } else {
                backupError = "cacheDisplay（原生 scale）未产出位图"
            }
            self.finish(primary: primary, primaryError: primaryError,
                        backup: backup, backupError: backupError,
                        source: "force-scale", page: page,
                        forcedScale: forced)
            return
        }

        webView.takeSnapshot(with: config) { [weak self] image, error in
            guard let self = self else { return }

            var primary: (data: Data, width: Int, height: Int)? = nil
            var primaryError: String? = nil
            if let error = error {
                primaryError = "\(error)"
            } else if let image = image, let png = Self.png(from: image) {
                primary = self.negctlImage(png)
            } else {
                primaryError = "takeSnapshot 返回空图"
            }

            // 备路径：NSView.cacheDisplay(in:to:)。
            var backup: (data: Data, width: Int, height: Int)? = nil
            var backupError: String? = nil
            if let png = self.cacheDisplayPNG() {
                backup = png
            } else {
                backupError = "cacheDisplay 未产出位图"
            }
            self.finish(primary: primary, primaryError: primaryError,
                        backup: backup, backupError: backupError,
                        source: "primary", page: page, forcedScale: nil)
        }
    }

    /// 落盘 + 自证 + 退出。主/备两路与强制 scale 共用这一段，避免第二份 DPR/自证实现。
    ///
    /// ⭐ N4：**先判定、后交付**。所有闸门（provenance / 色彩 / 屏幕归因 / 点击穿透 /
    /// 窗口不可见 / DPR）都在写 `--out`、`--json` 之前算完；任一不过 ⇒ 帧只落到
    /// `<out>.invalid`，JSON 落到 `<json>.invalid`，并打印 `INVALID`，
    /// ⛔ 不留下看起来像正常产物的 `--out`。
    private func finish(primary initialPrimary: (data: Data, width: Int, height: Int)?,
                        primaryError: String?,
                        backup: (data: Data, width: Int, height: Int)?,
                        backupError: String?,
                        source initialSource: String,
                        page: PageState,
                        forcedScale: CGFloat?) {
        var primary = initialPrimary
        var primaryError = primaryError
        var backupError = backupError

        // `bugs/0222`：先看**内容**再决定交付（设计 §8.3「离屏图为空/全白 ⇒ 先降级到备份」）。
        //   空白 = 全透明或单色；⛔ 不再把「非 nil」当成「有内容」。
        var primaryStats: ImageStats? = nil
        if let p = primary { primaryStats = imageStats(p.data) }
        var backupStats: ImageStats? = nil
        if let b = backup { backupStats = imageStats(b.data) }
        let primaryBlank = primaryStats?.blank ?? false
        let backupBlank = backupStats?.blank ?? false
        if primaryBlank {
            primaryError = "主路图为空白帧（\(primaryStats?.blankReason ?? "blank")；"
                + "sampled=\(primaryStats?.sampled ?? 0) unique=\(primaryStats?.unique ?? 0)）"
            primary = nil   // ⛔ 不把空白帧写到 --out
        }
        emit("BLANK\tprimary=\(primaryBlank ? "1" : "0")" +
             "\tbackup=\(backupStats == nil ? "-" : (backupBlank ? "1" : "0"))")

        // ── 选定待交付帧；⛔ 这里还不写盘 ──
        var candidate: (data: Data, width: Int, height: Int)? = nil
        var source = initialSource
        if let p = primary {
            candidate = p
        } else if let b = backup {
            if backupBlank {
                fail("主/备两路都不可用：主路=\(oneLine(primaryError ?? "-"))；"
                     + "备路也是空白帧（sampled=\(backupStats?.sampled ?? 0) "
                     + "unique=\(backupStats?.unique ?? 0)）⇒ 环境无效（bugs/0222）", 9)
            }
            candidate = b
            source = "backup"
        }
        guard let delivery = candidate else {
            fail("主/备两路都失败：primary=\(oneLine(primaryError ?? "-")) " +
                      "backup=\(oneLine(backupError ?? "-"))", 9)
        }

        // ── 判定所需事实 ──
        let observed = Double(delivery.width) / Double(self.opts.width)
        // N7：归因闸门比的是**所选显示器**的 scale，⛔ 不是窗口当前碰巧所在的屏。
        let screenScale = self.screen.scale
        let windowScale = Double(self.window.backingScaleFactor)
        let windowScreenID = self.window.screen.flatMap { displayID(of: $0) }
        // N7：同时校验「窗口在哪块屏」与「帧 px/pt 是否等于所选屏 scale」。
        let attribution = screenAttribution(windowScreenID: windowScreenID,
                                            requestedScreenID: self.screen.id,
                                            observed: observed,
                                            screenScale: screenScale)
        let screenIdentityOK = attribution.idMatch
        let scaleOK = attribution.scaleMatch
        var dprMatch: Bool? = nil
        if let expected = self.opts.dpr {
            dprMatch = abs(observed - Double(expected)) <= 0.01
        }

        // `bugs/0224`：两路色彩一致性 = 全局众数色 **且** 局部 16×16 块均值（N8）。
        // 局部块只有两路**同一像素尺度**时才可比：`--force-scale` 会让主路按 N× 重栅格化、
        // 备路仍是原生 scale，文字边缘的抗锯齿差会被块均值放大 ⇒ 该情形显式 skipped，
        // 只保留尺度无关的全局众数判据，⛔ 不把「网格不可比」判成红或绿。
        var colorParity: [String: Any] = ["status": "skipped",
                                          "reason": "no-primary-or-backup"]
        var colorParityPass: Bool? = nil
        if let ps = primaryStats, let bs = backupStats, !primaryBlank, !backupBlank {
            let delta = deltaE76(ps.modeRGB, bs.modeRGB)
            let maxChannel = max(abs(ps.modeRGB.0 - bs.modeRGB.0),
                                 abs(ps.modeRGB.1 - bs.modeRGB.1),
                                 abs(ps.modeRGB.2 - bs.modeRGB.2))
            let globalPass = delta <= 2.0 && maxChannel <= 2
            let sameRasterScale = abs(ps.width - bs.width) <= 1
            let local: LocalColorDiff? = sameRasterScale ? localColorDiff(ps, bs) : nil
            let localJSON: [String: Any] = local?.json ?? [
                "status": "skipped",
                "reason": "主/备两路像素宽不同（\(ps.width) vs \(bs.width)），"
                    + "16×16 块网格不可比（--force-scale 的预期形态）",
                "primary_width": ps.width,
                "backup_width": bs.width,
            ]
            let localPass: Bool? = local?.pass
            let pass = globalPass && (localPass ?? true)
            colorParityPass = pass
            colorParity = [
                "status": pass ? "pass" : "fail",
                "delta_e76": delta,
                "max_channel_delta": maxChannel,
                "global_pass": globalPass,
                "global_threshold": ["delta_e76": 2.0, "max_channel_delta": 2],
                "local": localJSON,
                "local_pass": localPass.map { $0 as Any } ?? NSNull(),
                "local_verified": local != nil,
                "same_raster_scale": sameRasterScale,
                "pass": pass,
                "primary_mode_rgb": [ps.modeRGB.0, ps.modeRGB.1, ps.modeRGB.2],
                "backup_mode_rgb": [bs.modeRGB.0, bs.modeRGB.1, bs.modeRGB.2],
                "method": "sRGB 众数色（全局）+ 16×16 块均值（局部）；ΔE76 粗判"
                    + "（M4 权威仍是 bands.py 的 ΔE2000）。阈值工具侧暂定，待设计批准。",
            ]
            let localText: String
            if let local = local {
                localText = "local_max_delta_e76=\(Self.fmt(local.maxDelta))"
                    + "\tlocal_mean_delta_e76=\(Self.fmt(local.meanDelta))"
                    + "\tlocal_blocks_over_1=\(local.blocksOverOne)/\(local.blocksCompared)"
                    + "\tlocal_pass=\(local.pass ? "1" : "0")"
            } else {
                localText = "local_pass=skipped"
            }
            emit("COLOR_PARITY\tdelta_e76=\(Self.fmt(delta))" +
                 "\tmax_channel=\(maxChannel)" +
                 "\t" + localText +
                 "\tglobal_pass=\(globalPass ? "1" : "0")" +
                 "\tpass=\(pass ? "1" : "0")")
        } else {
            emit("COLOR_PARITY\tstatus=skipped\treason=no-primary-or-backup")
        }

        // 自证（kb/0025）：前后台应用、进程激活态、窗口键态、窗口可见性、点击穿透。
        // `bugs/0181`：名字、bundle id、read_ok 与失败原因一起落，⛔ 不给「占位符相等」留绿。
        let frontAfter = frontmostInfo()
        let frontChanged = self.frontBefore.differs(from: frontAfter)
        let alpha = Double(self.window.alphaValue)
        let alphaOverride = self.opts.alphaOverride.map { Double($0) }
        let appkitVisible = self.window.isVisible
        let ignoresMouse = self.window.ignoresMouseEvents
        // ⭐ "窗口不可见"在 `bugs/0126` 里的语义是**用户感知不到**：
        //    `orderBack` 之后 AppKit 的 `isVisible` 可能仍为 true（窗口在窗表里），
        //    真正让它不可感知的是 alpha = 0 ⇒ 这里报派生量，并把原始值一并留下。
        //    `bugs/0225` 残留：这个派生量现在同时是显式闸门（见下）。
        let effectiveVisible = appkitVisible && alpha > 0
        let windowVisibleOK = !effectiveVisible
        emit("SELF\tfrontmost_before=\(oneLine(self.frontBefore.displayName))" +
             "\tfrontmost_before_bundle=\(oneLine(self.frontBefore.bundleID ?? "-"))" +
             "\tfrontmost_before_ok=\(self.frontBefore.readOK ? "1" : "0")" +
             "\tfrontmost_before_error=\(oneLine(self.frontBefore.error ?? "-"))" +
             "\tfrontmost_after=\(oneLine(frontAfter.displayName))" +
             "\tfrontmost_after_bundle=\(oneLine(frontAfter.bundleID ?? "-"))" +
             "\tfrontmost_after_ok=\(frontAfter.readOK ? "1" : "0")" +
             "\tfrontmost_after_error=\(oneLine(frontAfter.error ?? "-"))" +
             "\tfrontmost_changed=\(frontChanged ? "1" : "0")" +
             "\tNSApp.isActive=\(NSApp.isActive ? "true" : "false")" +
             "\twindow.isKeyWindow=\(self.window.isKeyWindow ? "true" : "false")" +
             "\twindow.isVisible=\(appkitVisible ? "true" : "false")" +
             "\twindow.alpha=\(Self.fmtG(alpha))" +
             "\twindow.ignoresMouseEvents=\(ignoresMouse ? "true" : "false")" +
             "\twindow_visible=\(effectiveVisible ? "true" : "false")")
        // N3：负对照开关必须留痕；未传时 applied=-。
        let appliedText = self.opts.negctlApplied.isEmpty
            ? "-" : self.opts.negctlApplied.joined(separator: ",")
        emit("NEGCTL\talpha=\(alphaOverride.map { Self.fmtG($0) } ?? "-")" +
             "\tapplied=\(appliedText)" +
             "\tprovided=\(self.opts.negctl.isEmpty ? "0" : "1")")

        // `bugs/0265`：帧 provenance —— 交付文件的 SHA-256、取像完成时刻、真实窗口 ID。
        //   SHA 直接对**待交付字节**算，⛔ 不等写盘后再回读、⛔ 不写组装时刻。
        let capturedAt = nowISO()
        let frameSHA = sha256Hex(delivery.data)
        let windowNumber = self.window.windowNumber
        let windowID: Int? = self.opts.neg("no_window_id")
            ? nil
            : (windowNumber > 0 ? windowNumber : nil)
        let provenanceComplete = !frameSHA.isEmpty && windowID != nil
        emit("PROVENANCE\tframe_sha256=\(frameSHA.isEmpty ? "-" : frameSHA)" +
             "\tcaptured_at=\(capturedAt)" +
             "\twindow_id=\(windowID.map(String.init) ?? "-")")

        // DPR 对表：--dpr 是**期望值**；不符 ⇒ 退出 64（`bugs/0125`，⛔ 不静默通过）。
        // N6：同时报所选屏 scale 与窗口实际 scale，单位都是 px/pt。
        emit("DPR\tpx_per_pt=\(Self.fmt(observed))\tscreen=\(Self.fmt(screenScale))" +
             "\twindow_scale=\(Self.fmt(windowScale))" +
             "\texpected=\(self.opts.dpr.map { "\(Double($0))" } ?? "-")" +
             "\tmatch=\(dprMatch.map { $0 ? "1" : "0" } ?? "-")")
        if let forced = forcedScale {
            emit("SCALE_FORCED\trequested=\(Self.fmt(Double(forced)))" +
                 "\tdelivered=\(Self.fmt(observed))")
        }

        // `bugs/0221`：帧必须能回答"跑在哪块屏"；显示器身份与 scale 一并落自证。
        emit(self.screen.line)
        emit("SCREEN_IDENTITY\twindow_screen_id=\(windowScreenID.map(String.init) ?? "-")" +
             "\trequested_screen_id=\(self.screen.id)" +
             "\tscreen_scale=\(Self.fmt(screenScale))" +
             "\twindow_scale=\(Self.fmt(windowScale))" +
             "\tid_match=\(screenIdentityOK ? "1" : "0")" +
             "\tscale_match=\(scaleOK ? "1" : "0")")

        // ── 闸门：顺序与旧实现一致，首个不通过者决定退出码 ──
        var failures: [(code: Int32, reason: String)] = []
        if !provenanceComplete {
            failures.append((65, "帧 provenance 不完整（frame_sha256=\(frameSHA.isEmpty ? "缺失" : frameSHA)；"
                                + "window_id=\(windowID.map(String.init) ?? "缺失")；"
                                + "captured_at=\(capturedAt)）⇒ 该帧无效（bugs/0265）"))
        }
        if colorParityPass == false {
            let local = (colorParity["local"] as? [String: Any]) ?? [:]
            let localVerified = (colorParity["local_verified"] as? Bool) ?? false
            let localText = localVerified
                ? "局部块 max ΔE76=\(local["max_delta_e76"] ?? "?")/"
                    + "mean ΔE76=\(local["mean_delta_e76"] ?? "?")，阈值 max 1.5·mean 0.5"
                : "局部块 skipped（主/备像素尺度不同）"
            failures.append((65, "主/备两路色彩不一致（全局 ΔE76=\(colorParity["delta_e76"] ?? "?")，"
                                + localText + "，全局阈值 2.0）"
                                + "⇒ 降级帧与基线帧不可互换（bugs/0224）"))
        }
        if forcedScale == nil && !screenIdentityOK {
            failures.append((65, "window.screen（\(windowScreenID.map(String.init) ?? "nil")）"
                                + "与 --screen 指定显示器 \(self.screen.id) 不一致"
                                + " ⇒ 帧无法归因到该屏（bugs/0221）"))
        }
        if forcedScale == nil && !scaleOK {
            failures.append((65, "实测 px_per_pt \(Self.fmt(observed)) 与所选显示器 \(self.screen.name)"
                                + "（id=\(self.screen.id)）的 backing scale \(Self.fmt(screenScale)) 不符"
                                + " ⇒ 帧无法归因到该屏（bugs/0221）"))
        }
        if !ignoresMouse {
            failures.append((65, "window.ignoresMouseEvents=false：离屏窗口可能吞掉点击（bugs/0225）"))
        }
        if !windowVisibleOK {
            failures.append((65, "window_visible=\(effectiveVisible)：离屏窗口对用户可见"
                                + "（alpha=\(Self.fmtG(alpha))）⇒ 本轮取像无效（bugs/0225）"))
        }
        if let expected = self.opts.dpr, abs(observed - Double(expected)) > 0.01 {
            failures.append((64, "--dpr \(Double(expected)) 与实测 px_per_pt \(Self.fmt(observed)) 不符"
                                + "（PNG \(delivery.width)x\(delivery.height)；画布 \(Double(self.opts.width)) pt）。"
                                + "本机屏幕 backing scale = \(Self.fmt(screenScale))；"
                                + "要真按其它 scale 出图请加 --force-scale \(Double(expected))。"
                                + "⛔ 不把与声明不符的帧当作成功。"))
        }

        let backupPath = Self.backupPath(for: self.opts.outPNG)
        var facts = DeliveryFacts()
        facts.finalSize = (delivery.width, delivery.height)
        facts.observed = observed
        facts.screenScale = screenScale
        facts.windowScale = windowScale
        facts.windowScreenID = windowScreenID
        facts.screenIdentityOK = screenIdentityOK
        facts.scaleOK = scaleOK
        facts.dprMatch = dprMatch
        facts.source = source
        facts.frontAfter = frontAfter
        facts.frontChanged = frontChanged
        facts.alpha = alpha
        facts.alphaOverride = alphaOverride
        facts.appkitVisible = appkitVisible
        facts.effectiveVisible = effectiveVisible
        facts.ignoresMouse = ignoresMouse
        facts.primaryStats = primaryStats
        facts.backupStats = backupStats
        facts.primaryBlank = primaryBlank
        facts.backupBlank = backupBlank
        facts.colorParity = colorParity
        facts.colorParityPass = colorParityPass
        facts.capturedAt = capturedAt
        facts.frameSHA = frameSHA
        facts.windowID = windowID
        facts.provenanceComplete = provenanceComplete

        // ── N4：判据未过 ⇒ 只落 .invalid，⛔ 不交付 --out / --json ──
        if let first = failures.first {
            let invalidPath = self.opts.outPNG + ".invalid"
            let writeErr = writeData(delivery.data, to: invalidPath)
            let reasons = failures.map { $0.reason }.joined(separator: "；")

            self.emitResult(tag: "PRIMARY", ok: false, path: nil,
                            size: primary.map { ($0.width, $0.height) },
                            error: "未交付（判据未过：" + oneLine(first.reason) + "）")
            self.emitResult(tag: "BACKUP", ok: false, path: nil,
                            size: backup.map { ($0.width, $0.height) },
                            error: "未交付（判据未过）")
            emit("INVALID\tcode=\(first.code)" +
                 "\tframe=\(writeErr == nil ? invalidPath : "-")" +
                 "\twrite_error=\(oneLine(writeErr ?? "-"))" +
                 "\treasons=" + oneLine(reasons))

            facts.status = "invalid"
            facts.delivered = false
            facts.pngPath = writeErr == nil ? invalidPath : nil
            facts.primaryPath = nil
            facts.backupPath = nil
            facts.invalidReasons = failures.map { $0.reason }
            facts.invalidCode = first.code
            if let jsonPath = self.opts.jsonOut {
                let invalidJSON = jsonPath + ".invalid"
                let payload = Self.mergeEval(self.evalValue,
                                             env: self.environmentInfo(facts: facts, page: page))
                if let werr = Self.writeJSON(payload, to: invalidJSON) {
                    emit("INVALID_JSON\tpath=\(invalidJSON)\terror=" + oneLine(werr))
                } else {
                    emit("JSON_INVALID\t\(invalidJSON)")
                }
            }
            fail("判据未过，未交付 --out / --json：" + oneLine(reasons), first.code)
        }

        // ── 全部通过：交付 ──
        let outPath = self.opts.outPNG
        if let werr = writeData(delivery.data, to: outPath) {
            fail("写不出 --out \(outPath)：\(werr)", 73)
        }
        let deliveredFromBackup = (primary == nil)
        var backupWritten: String? = nil
        if let b = backup {
            if let werr = writeData(b.data, to: backupPath) {
                backupError = "写不出 \(backupPath)：\(werr)"
            } else {
                backupWritten = backupPath
            }
        }
        let primaryPath: String? = deliveredFromBackup ? nil : outPath
        if deliveredFromBackup {
            emit("FALLBACK\t\(primaryBlank ? "blank_primary" : "primary_failed")\t"
                 + oneLine(primaryError ?? "-"))
        }

        self.emitResult(tag: "PRIMARY",
                        ok: primaryPath != nil,
                        path: primaryPath,
                        size: primary.map { ($0.width, $0.height) },
                        error: primaryError)
        self.emitResult(tag: "BACKUP",
                        ok: backupWritten != nil,
                        path: backupWritten,
                        size: backup.map { ($0.width, $0.height) },
                        error: backupError)

        emit("SNAP\t\(outPath)\t\(delivery.width)x\(delivery.height)")
        emit("SNAP_SOURCE\t\(source)")

        facts.pngPath = outPath
        facts.primaryPath = primaryPath
        facts.backupPath = backupWritten

        // 自证 JSON：无论有没有 --eval-file 都写（`bugs/0126`：⛔ 两件事不能互相顶掉）。
        if let jsonPath = self.opts.jsonOut {
            let payload = Self.mergeEval(self.evalValue,
                                         env: self.environmentInfo(facts: facts, page: page))
            if let werr = Self.writeJSON(payload, to: jsonPath) {
                fail("写不出 --json \(jsonPath)：\(werr)", 73)
            }
            emit("JSON\t\(jsonPath)")
        } else if let raw = self.evalRaw {
            emit("EVAL\t" + oneLine(raw))
        }

        exit(0)
    }

    /// 自证环境（`bugs/0126` / `0128` / `0181` / `0221` / `0224` / `0225` / `0265`）：
    /// 键名同时覆盖 `preflight.py` 的别名表与 `l2-run.sh` 已在用的旧名。
    private func environmentInfo(facts: DeliveryFacts, page: PageState) -> [String: Any] {
        let before = self.frontBefore
        let after = facts.frontAfter
        var info: [String: Any] = [
            "ok": facts.status == "ok",
            "status": facts.status,
            "delivered": facts.delivered,
            "schema": "l2-snapshot-env/4",
            "tool": "l2-snapshot",
            "page": self.opts.pageDir,
            "png": facts.pngPath ?? NSNull(),
            "png_px": ["w": facts.finalSize.0, "h": facts.finalSize.1],
            "png_size": [facts.finalSize.0, facts.finalSize.1],
            "canvas_pt": ["w": Double(self.opts.width), "h": Double(self.opts.height)],
            "snapshot_width_pt": self.opts.noSnapshotWidth
                ? NSNull() : NSNumber(value: Double(self.opts.width)),
            // `preflight.dpr_of` 认 `dpr`；`px_per_pt` 是同一事实的旧名。
            "dpr": facts.observed,
            "px_per_pt": facts.observed,
            "screen_backing_scale": facts.screenScale,
            "window_backing_scale": facts.windowScale,
            "expected_dpr": self.opts.dpr.map { NSNumber(value: Double($0)) } ?? NSNull(),
            "dpr_match": facts.dprMatch.map { $0 as Any } ?? NSNull(),
            // `bugs/0221`：显示器身份与几何，产物可独立回答"跑在哪块屏"。
            // N7：同时记录窗口**实际所在屏**，同 scale 多屏也能发现错配。
            "screen": self.screen.json,
            "screen_id": NSNumber(value: self.screen.id),
            "screen_name": self.screen.name,
            "screen_scale": self.screen.scale,
            "window_screen_id": facts.windowScreenID.map { NSNumber(value: $0) } ?? NSNull(),
            "screen_identity_ok": facts.screenIdentityOK,
            "screen_scale_ok": facts.scaleOK,
            // `preflight.gate_04` 认 `is_active` / `is_key_window`。
            "is_active": NSApp.isActive,
            "is_key_window": self.window.isKeyWindow,
            "nsapp_active": NSApp.isActive,
            "window_is_key": self.window.isKeyWindow,
            // 窗口可见性（`bugs/0126` / `0225`）：`window_visible` 是"用户能看见"的派生量，
            //   并把「期望不可见」写成显式闸门字段，⛔ 不再只有一句自由文本。
            "window_visible": facts.effectiveVisible,
            "appkit_is_visible": facts.appkitVisible,
            "window_visible_gate": [
                "expected": false,
                "observed": facts.effectiveVisible,
                "ok": !facts.effectiveVisible,
                "field": "window_visible",
                "source": "window.isVisible && window.alpha > 0",
            ],
            "alpha": facts.alpha,
            "alpha_override": facts.alphaOverride.map { NSNumber(value: $0) } ?? NSNull(),
            "alpha_source": facts.alphaOverride == nil ? "default:0" : "negctl:--alpha",
            "window_level": self.window.level.rawValue,
            // `bugs/0225`：显式点击穿透的运行期值（⛔ 不靠默认值）。
            "ignores_mouse_events": facts.ignoresMouse,
            "ignores_mouse_events_ok": facts.ignoresMouse,
            // N3：负对照开关必须随产物留痕，⛔ 不静默应用。
            "negctl": self.opts.negctl,
            "negctl_applied": self.opts.negctlApplied,
            "negctl_provided": !self.opts.negctl.isEmpty,
            "primary": facts.primaryPath ?? NSNull(),
            "backup": facts.backupPath ?? NSNull(),
            "source": facts.source,
            // `bugs/0181`：前台身份 = 名字 + bundle id + read_ok + 失败原因。
            //   扁平键供 `preflight._FRONTMOST_*_KEYS` 直接取；嵌套对象供结构化读取。
            "frontmost_before": before.displayName,
            "frontmost_before_name": before.name ?? NSNull(),
            "frontmost_before_bundle": before.bundleID ?? NSNull(),
            "frontmost_before_bundle_id": before.bundleID ?? NSNull(),
            "frontmost_before_ok": before.readOK,
            "frontmost_before_error": before.error ?? NSNull(),
            "frontmost_before_pid": before.pid.map { NSNumber(value: $0) } ?? NSNull(),
            "frontmost_after": after.displayName,
            "frontmost_after_name": after.name ?? NSNull(),
            "frontmost_after_bundle": after.bundleID ?? NSNull(),
            "frontmost_after_bundle_id": after.bundleID ?? NSNull(),
            "frontmost_after_ok": after.readOK,
            "frontmost_after_error": after.error ?? NSNull(),
            "frontmost_after_pid": after.pid.map { NSNumber(value: $0) } ?? NSNull(),
            "frontmost_changed": facts.frontChanged,
            "frontmost": ["before": before.json, "after": after.json],
            // `bugs/0181` 的窗口侧：产物自身身份也带 bundle 与 read_ok。
            "window": [
                "number": facts.windowID.map { NSNumber(value: $0) } ?? NSNull(),
                "owner_pid": NSNumber(value: Int(getpid())),
                "owner_bundle_id": Bundle.main.bundleIdentifier.map { $0 as Any } ?? NSNull(),
                "screen_id": facts.windowScreenID.map { NSNumber(value: $0) } ?? NSNull(),
                "backing_scale": facts.windowScale,
                "read_ok": facts.windowID != nil,
                "error": facts.windowID == nil
                    ? ("窗口号不可用（windowNumber<=0 或被 negctl 抑制）" as Any)
                    : NSNull(),
            ],
            // `bugs/0222`：空白帧判定与两路统计。
            "primary_blank": facts.primaryBlank,
            "backup_blank": facts.backupBlank,
            "primary_stats": facts.primaryStats?.json ?? NSNull(),
            "backup_stats": facts.backupStats?.json ?? NSNull(),
            // `bugs/0224`：两路色彩一致性（全局众数色 + 局部 16×16 块均值）。
            "color_parity": facts.colorParity,
            "color_space": "sRGB",
            "color_space_source": "CGColorSpace.sRGB（主/备两路共用 pngSRGB 出口）",
            // `bugs/0265`：帧 provenance（扁平 + 嵌套两份，消费侧按需取）。
            "frame_sha256": facts.frameSHA ?? NSNull(),
            "captured_at": facts.capturedAt,
            "window_id": facts.windowID.map { NSNumber(value: $0) } ?? NSNull(),
            "provenance": [
                "frame_sha256": facts.frameSHA ?? NSNull(),
                "captured_at": facts.capturedAt,
                "window_id": facts.windowID.map { NSNumber(value: $0) } ?? NSNull(),
                "width_px": facts.finalSize.0,
                "height_px": facts.finalSize.1,
                "dpr": facts.observed,
                "screen_id": NSNumber(value: self.screen.id),
                "complete": facts.provenanceComplete,
            ],
            "provenance_complete": facts.provenanceComplete,
            // N4：判据未过时，产物显式标记无效原因与退出码。
            "invalid_reasons": facts.invalidReasons,
            "invalid_code": facts.invalidCode.map { NSNumber(value: $0) } ?? NSNull(),
            // 页面自证（`bugs/0117` / `0121` / `0154`）：缺页面上报的数据时显式为 null。
            "page_state_available": page.available,
            "page_layout": page.layout ?? NSNull(),
            "page_provenance": page.provenance ?? NSNull(),
            "ready": page.ready.map { $0 } ?? NSNull(),
            "ready_error": page.error ?? NSNull(),
            "fonts_ready": page.fontsReady.map { $0 } ?? NSNull(),
            "stable_frames": page.stableFrames.map { NSNumber(value: $0) } ?? NSNull(),
        ]
        // ⭐ `0128`（产出侧）：把页面自证里**已经量到**的环境值再以 `preflight.env_fields`
        // 的别名写一份（`content_width_px` / `font_size` / `line_height` / `sidebar_width`）。
        // 缺页面上报（老页面）时**不写**这些键 ⇒ 闸门保持 skipped，⛔ 不拿历史值兜底。
        for (key, value) in Self.pageEnvAliases(page: page) where info[key] == nil {
            info[key] = value
        }
        return info
    }

    /// 页面自证 → `preflight.env_fields` 的别名（只从**本帧实测**的 layout/provenance 取）。
    private static func pageEnvAliases(page: PageState) -> [String: Any] {
        var out: [String: Any] = [:]
        if let layout = page.layout as? [String: Any] {
            let map = [
                "content_box_width": "content_width_px",
                "font_size": "font_size",
                "line_height": "line_height",
                "content_box_height": "content_box_height_px",
            ]
            for (src, dst) in map {
                if let v = layout[src] as? NSNumber { out[dst] = v }
            }
        }
        if let prov = page.provenance as? [String: Any],
           let sidebar = prov["sidebar_width"] as? NSNumber {
            out["sidebar_width"] = sidebar
        }
        return out
    }

    /// eval 结果与自证环境合并（`bugs/0126` / `0128`）：
    /// - eval 是对象 ⇒ 把 env 挂到 `env`；若 eval 自己已有 `env`，⛔ 不覆盖，挂到 `snapshot_env`；
    /// - ⭐ `0128`（产出侧）：env 的键**同时**提升到顶层，但只在 eval 自己没占这个名字时。
    ///   这样 `preflight.gate_04` 按顶层别名表（`is_active` / `is_key_window` /
    ///   `window_visible` / `alpha` / `dpr`）读**未经手改的工具原样输出**也能判定，
    ///   ⛔ 不依赖"读者自己往 `env` 里再取一层"。
    /// - eval 不是对象 ⇒ 包成 `{measurement, env}`（env 的键同样提升到顶层）。
    private static func mergeEval(_ value: Any?, env: [String: Any]) -> Any {
        guard let value = value else { return env }
        if var object = value as? [String: Any] {
            if object["env"] == nil {
                object["env"] = env
            } else {
                object["snapshot_env"] = env
            }
            for (key, val) in env where object[key] == nil {
                object[key] = val
            }
            return object
        }
        var object: [String: Any] = ["measurement": value, "env": env]
        for (key, val) in env where object[key] == nil {
            object[key] = val
        }
        return object
    }

    private static func writeJSON(_ value: Any, to path: String) -> String? {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value,
                                                     options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return "结果不是合法 JSON 对象"
        }
        return writeText(text, to: path)
    }

    private func emitResult(tag: String,
                            ok: Bool,
                            path: String?,
                            size: (Int, Int)?,
                            error: String?) {
        var line = "\(tag)\t\(ok ? "ok" : "fail")"
        line += "\t\(path ?? "-")"
        line += "\t\(size.map { "\($0.0)x\($0.1)" } ?? "-")"
        if let error = error, !error.isEmpty {
            line += "\t" + oneLine(error)
        }
        emit(line)
    }

    private static func fmt(_ value: Double) -> String {
        String(format: "%.2f", value)
    }

    /// 精确但不啰嗦的数值（`--alpha 0.0001` 不能被 %.2f 抹成 0.00）。
    private static func fmtG(_ value: Double) -> String {
        String(format: "%.6g", value)
    }

    private static func backupPath(for out: String) -> String {
        let url = URL(fileURLWithPath: out)
        let ext = url.pathExtension
        let base = url.deletingPathExtension().lastPathComponent
        let name = ext.isEmpty ? base + "-backup" : base + "-backup." + ext
        return url.deletingLastPathComponent().appendingPathComponent(name).path
    }

    /// 主路径：NSImage（WKWebView.takeSnapshot 的产物）→ **统一 sRGB** → PNG 字节 + 像素尺寸。
    /// `bugs/0224`：主路原先直接编码 `takeSnapshot` 的 rep（色彩空间随屏/系统而变），
    /// 与备路的 `.deviceRGB` 不统一；降级换路会引入系统性颜色差。现在两路都先归一化到
    /// `CGColorSpace.sRGB`，PNG 里带同一份 sRGB 配置，`bands.py` 按 sRGB 解码才是对的。
    private static func png(from image: NSImage) -> (data: Data, width: Int, height: Int)? {
        if let rep = image.representations
            .compactMap({ $0 as? NSBitmapImageRep })
            .max(by: { $0.pixelsWide < $1.pixelsWide }),
           let cg = rep.cgImage {
            return pngSRGB(from: cg)
        }
        var proposed = NSRect(origin: .zero, size: image.size)
        guard let cg = image.cgImage(forProposedRect: &proposed, context: nil, hints: nil) else {
            return nil
        }
        return pngSRGB(from: cg)
    }

    /// 把任意 CGImage 画进 sRGB 上下文再编码 PNG（唯一的 PNG 出口）。
    private static func pngSRGB(from cg: CGImage) -> (data: Data, width: Int, height: Int)? {
        let w = cg.width, h = cg.height
        guard w > 0, h > 0,
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: w * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                                            | CGBitmapInfo.byteOrder32Big.rawValue) else {
            return nil
        }
        ctx.interpolationQuality = .none
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let out = ctx.makeImage() else { return nil }
        let rep = NSBitmapImageRep(cgImage: out)
        guard let data = rep.representation(using: .png, properties: [:]) else { return nil }
        return (data, w, h)
    }

    /// ⚠️ 仅负对照（`--negctl`）：产出一张与目标同尺寸的纯白帧，用来验证空白检测。
    private static func blankPNG(width: Int, height: Int) -> Data? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                                            | CGBitmapInfo.byteOrder32Big.rawValue) else {
            return nil
        }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let out = ctx.makeImage() else { return nil }
        return NSBitmapImageRep(cgImage: out).representation(using: .png, properties: [:])
    }

    /// ⚠️ 仅负对照（`--negctl primary_colorspace=displayP3`）：把 sRGB 字节**原样重标**成
    /// Display P3（⛔ 不做色彩转换）。这正是 `bugs/0224` 的风险形态：字节是 sRGB，标记是 P3。
    private static func retagPNG(_ data: Data, to space: CGColorSpace)
        -> (data: Data, width: Int, height: Int)? {
        guard let rep = NSBitmapImageRep(data: data), let cg = rep.cgImage,
              let retagged = cg.copy(colorSpace: space) else { return nil }
        let out = NSBitmapImageRep(cgImage: retagged)
        guard let png = out.representation(using: .png, properties: [:]) else { return nil }
        return (png, retagged.width, retagged.height)
    }

    /// ⚠️ 仅负对照（`--negctl primary_colorspace=p3_as_srgb`）：把像素真正转成 Display P3 编码，
    /// 再**重标为 sRGB** 交付 —— 即「P3 字节被当 sRGB 解码」，`bugs/0224` 实测 ΔE2000 3.55 的形态。
    private static func p3BytesTaggedSRGB(_ data: Data) -> (data: Data, width: Int, height: Int)? {
        guard let rep = NSBitmapImageRep(data: data), let cg = rep.cgImage,
              let p3 = CGColorSpace(name: CGColorSpace.displayP3),
              let srgb = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let w = cg.width, h = cg.height
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: w * 4, space: p3,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                                            | CGBitmapInfo.byteOrder32Big.rawValue) else {
            return nil
        }
        ctx.interpolationQuality = .none
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let p3image = ctx.makeImage(),
              let mislabeled = p3image.copy(colorSpace: srgb) else { return nil }
        let out = NSBitmapImageRep(cgImage: mislabeled)
        guard let png = out.representation(using: .png, properties: [:]) else { return nil }
        return (png, w, h)
    }

    /// 备路径：NSView.cacheDisplay(in:to:)，按给定 backing scale 出图。
    /// `scale == nil` ⇒ 窗口真实 backing scale（默认口径）。
    /// ⭐ `bugs/0125`：传入别的 scale 时，位图的**像素数**按该 scale 算、`rep.size` 仍是
    /// point 尺寸 ⇒ AppKit 在给定 scale 的上下文里**重新栅格化**这份布局。
    private func cacheDisplayPNG(scale requested: CGFloat? = nil) -> (data: Data, width: Int, height: Int)? {
        let bounds = webView.bounds
        let scale = requested ?? window.backingScaleFactor
        let pixelsWide = max(1, Int((bounds.width * scale).rounded()))
        let pixelsHigh = max(1, Int((bounds.height * scale).rounded()))
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
                                         pixelsWide: pixelsWide,
                                         pixelsHigh: pixelsHigh,
                                         bitsPerSample: 8,
                                         samplesPerPixel: 4,
                                         hasAlpha: true,
                                         isPlanar: false,
                                         colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0,
                                         bitsPerPixel: 0) else {
            return nil
        }
        rep.size = bounds.size  // point 尺寸；像素尺寸由 pixelsWide/High 决定
        webView.cacheDisplay(in: bounds, to: rep)
        // `bugs/0224`：与主路共用 sRGB 归一化出口，⛔ 不让备路带 `.deviceRGB` 直接交付。
        guard let cg = rep.cgImage else { return nil }
        return Self.pngSRGB(from: cg)
    }
}

// MARK: - 入口

private let opts = parseArgs(CommandLine.arguments)
private let frontBefore = frontmostInfo()   // 任何 AppKit 初始化之前先记一次
private let runner = Runner(opts: opts, frontBefore: frontBefore)
runner.start()
NSApplication.shared.run()
