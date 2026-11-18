// 只读窗口枚举；绝不 AXRaise / activate / makeKey / 设置 frontmost / 合成事件。
// 数据源仅 CGWindowListCopyWindowInfo。
//
// 用法：window-list [--owner <子串>] [--all]
// 输出：每行 `id \t owner \t name \t LxW \t layer`，只列 layer 0 的普通窗口。
//       名称缺失时以 `-` 占位；LxW 为窗口逻辑尺寸（point，四舍五入）。
//       ⚠️ owner/name 里的反斜杠、TAB、CR、LF 按 C 转义写成 `\\`/`\t`/`\r`/`\n`，
//          保证每行恰好 5 列（N13）；消费方需按同一规则反转义。
//       --owner 按窗口 owner 名做不区分大小写的子串过滤。
//       默认只枚举当前屏幕上的窗口；--all 连带其它 Space / 离屏窗口（仍是只读枚举）。
//       需要抓取不在当前 Space 的窗口时用 --all 拿到 ID。

import CoreGraphics
import Foundation

let keyNumber = kCGWindowNumber as String
let keyOwner = kCGWindowOwnerName as String
let keyName = kCGWindowName as String
let keyBounds = kCGWindowBounds as String
let keyLayer = kCGWindowLayer as String

func fail(_ message: String, code: Int32 = 64) -> Never {
    FileHandle.standardError.write(("window-list: " + message + "\n").data(using: .utf8)!)
    exit(code)
}

/// N13：TSV 字段转义。反斜杠先转，避免把转义产生的 `\` 再转一遍。
func tsvField(_ value: String) -> String {
    value.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\t", with: "\\t")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
}

var ownerFilter: String?
var includeOffscreen = false
var arguments = Array(CommandLine.arguments.dropFirst())
var index = 0

while index < arguments.count {
    switch arguments[index] {
    case "--owner":
        guard index + 1 < arguments.count else {
            fail("--owner 需要一个子串参数")
        }
        index += 1
        ownerFilter = arguments[index]
    case "--all":
        includeOffscreen = true
    case "-h", "--help":
        print("用法: window-list [--owner <子串>] [--all]")
        print("只读枚举 layer 0 的普通窗口，输出: id<TAB>owner<TAB>name<TAB>LxW<TAB>layer")
        print("owner/name 中的反斜杠与 TAB/CR/LF 转义为 \\\\ / \\t / \\r / \\n（N13）")
        print("--all 连带离屏/其它 Space 的窗口（仍只读，不触碰窗口状态）")
        exit(0)
    default:
        fail("未知参数: \(arguments[index])")
    }
    index += 1
}

// 只读枚举；不触碰窗口状态。默认当前屏幕，--all 时含离屏窗口。
let listOptions: CGWindowListOption = includeOffscreen
    ? [.optionAll, .excludeDesktopElements]
    : [.optionOnScreenOnly, .excludeDesktopElements]

guard let windows = CGWindowListCopyWindowInfo(
    listOptions,
    kCGNullWindowID
) as? [[String: Any]] else {
    fail("CGWindowListCopyWindowInfo 未返回窗口列表", code: 1)
}

let needle = ownerFilter?.lowercased()

for info in windows {
    guard let layer = info[keyLayer] as? Int, layer == 0 else { continue }
    guard let number = info[keyNumber] as? Int else { continue }

    // 完全透明的窗口不算可采样的普通窗口。
    let alpha = (info[kCGWindowAlpha as String] as? Double) ?? 1.0
    guard alpha > 0 else { continue }

    // bugs/0218：kCGWindowSharingNone(=0) 的窗口 screencapture 取不到内容，
    // 不应出现在候选里。⚠️ onscreen 仍只作信息，不能在这里过滤：
    // `--all` 的用途正是拿到不在当前 Space / 离屏的窗口 ID。
    if let sharing = (info[kCGWindowSharingState as String] as? NSNumber)?.intValue, sharing == 0 {
        continue
    }

    let owner = (info[keyOwner] as? String) ?? "-"
    let rawName = (info[keyName] as? String) ?? ""
    let name = rawName.isEmpty ? "-" : rawName

    guard let bounds = info[keyBounds] as? [String: Any],
          let width = (bounds["Width"] as? NSNumber)?.doubleValue,
          let height = (bounds["Height"] as? NSNumber)?.doubleValue,
          width > 0, height > 0 else { continue }

    if let needle, !owner.lowercased().contains(needle) { continue }

    let logicalWidth = Int(width.rounded())
    let logicalHeight = Int(height.rounded())
    print("\(number)\t\(tsvField(owner))\t\(tsvField(name))\t\(logicalWidth)x\(logicalHeight)\t\(layer)")
}
