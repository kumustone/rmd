#!/usr/bin/env bash
# 按窗口 ID 抓帧，并在交付前完成「身份 / 可采样性 / 几何 / 内容 / 环境」自证。
#
# 用法：
#   capture.sh --window <id> --out <png> --meta <json> [--env-file <json>]
#   capture.sh --window <id> --admit-only [--meta <json>]
#   capture.sh --check-png <png> --bounds x,y,w,h [--meta <json>]
#   capture.sh --environment
#   capture.sh --self-test
#
# 安全口径（0063 §7.0 / §7.1）：
#   - 只读枚举：CGWindowListCopyWindowInfo；前台应用：NSWorkspace.frontmostApplication。
#   - 抓帧只用 `screencapture -l <id> -x -o -a`，不抬窗口、不激活、不置 frontmost、
#     不发合成事件、不调用 osascript / System Events / CGEvent。
#   - 抓帧前后各记一次前台应用；不一致 => 明确告警、status=invalid、非 0 退出。
#   - ⛔ 探针只输出 JSON，⛔ 不解析制表符分隔（bugs/0220）。
#
# 退出码：0 成功且全部自证通过；1 --self-test 自检失败；2 参数/权限/窗口/抓帧/解析失败
#         （不产出 META，含未知 --negctl 键、生产路径误传 --skip-frontmost）；
#         3 帧被判 invalid（身份、可采样性、几何、内容、环境任一不满足），META 已落盘。
#
# 依赖：bash、screencapture、swiftc（仅首次把内置只读探针编译进缓存）、shasum、awk、python3。

set -u

VERSION="capture.sh/2 2026-11-08"

usage() {
    cat <<'EOF'
用法:
  capture.sh --window <id> --out <png> --meta <json> [选项]
  capture.sh --window <id> --admit-only [--meta <json>]
  capture.sh --window <id> --dry-run [--meta <json>]
  capture.sh --check-png <png> --bounds x,y,w,h [--meta <json>]
  capture.sh --environment
  capture.sh --self-test

  --window <id>        目标窗口 ID（CGWindowNumber，十进制）
  --out <png>          输出 PNG 路径（目录会自动创建）
  --meta <json>        provenance JSON 路径（capture 模式必填）
  --env-file <json>    环境表输入（如构页产出的 __l2-provenance.json）
  --expect-owner <名>  期望窗口 owner（默认 Mardo；也用于前台断言）
  --expect-bundle <id> 期望窗口 bundle id（给定时必须同时匹配）
  --admit-only         只做身份/可采样性准入，不抓帧
  --dry-run            只做准入并构造取像命令（不抓帧、不落像素）
  --check-png <png>    只校验已有 PNG（配合 --bounds），不抓帧
  --bounds x,y,w,h     --check-png 的窗口 bounds（pt）
  --skip-frontmost     ⚠️ 仅 --admit-only / --dry-run / --self-test：不把前台应用计入判定；
                       生产取像路径（capture/--check-png）传了直接退出 2
  --negctl <k,...>     ⚠️ 仅负对照：alpha_zero/offscreen/sharing_none/layer_one/
                       layer_missing/bounds_missing（未知键 ⇒ 退出 2，⛔ 不静默忽略）
  --environment        打印本机环境表 JSON 后退出
  --self-test          跑内置解析/空白检测自检后退出

只读：不激活、不置前、不抬窗口。抓帧前后前台应用不一致时以退出码 3 结束，
并把 status=invalid 写进 provenance。
EOF
}

WINDOW=""
OUT=""
META=""
EXPECT_OWNER="${CAPTURE_EXPECT_OWNER:-Mardo}"
EXPECT_BUNDLE="${CAPTURE_EXPECT_BUNDLE:-}"
ENV_FILE=""
MODE="capture"          # capture | admit | checkpng | dryrun
CHECK_PNG=""
BOUNDS=""
DO_SELFTEST=0
DO_ENV=0
# ⚠️ 仅离线/自检：不把「前台是否为期望应用」计入判定。运行时必须保持默认（开启），
#    否则 L1 环境表的「前台（前/后）」自证就丢了；META 会记 frontmost_asserted=false。
ASSERT_FRONTMOST=1
# ⚠️ 记录调用方是否显式传了 --skip-frontmost；生产路径要拒绝（bugs/0265 同族 N5）。
SKIP_FRONTMOST=0
# ⚠️ 仅负对照：人为覆盖探针读到的准入事实（⛔ 运行时不传）。
NEGCTL=""

while [ $# -gt 0 ]; do
    case "$1" in
        --window) WINDOW="${2:-}"; shift 2 ;;
        --out) OUT="${2:-}"; shift 2 ;;
        --meta) META="${2:-}"; shift 2 ;;
        --env-file) ENV_FILE="${2:-}"; shift 2 ;;
        --expect-owner) EXPECT_OWNER="${2:-}"; shift 2 ;;
        --expect-bundle) EXPECT_BUNDLE="${2:-}"; shift 2 ;;
        --admit-only) MODE="admit"; shift ;;
        --check-png) MODE="checkpng"; CHECK_PNG="${2:-}"; shift 2 ;;
        --bounds) BOUNDS="${2:-}"; shift 2 ;;
        --dry-run) MODE="dryrun"; shift ;;
        --skip-frontmost) ASSERT_FRONTMOST=0; SKIP_FRONTMOST=1; shift ;;
        --negctl) NEGCTL="${2:-}"; shift 2 ;;
        --self-test) DO_SELFTEST=1; shift ;;
        --environment) DO_ENV=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "capture.sh: 未知参数: $1" >&2; usage >&2; exit 2 ;;
    esac
done

if [ "$MODE" = "capture" ] && [ "$DO_ENV" = "0" ] && [ "$DO_SELFTEST" = "0" ]; then
    if [ -z "$WINDOW" ] || [ -z "$OUT" ] || [ -z "$META" ]; then
        echo "capture.sh: 抓帧模式要求 --window / --out / --meta 均为必填" >&2
        usage >&2
        exit 2
    fi
fi
if [ "$MODE" = "admit" ] && [ -z "$WINDOW" ]; then
    echo "capture.sh: --admit-only 需要 --window" >&2
    usage >&2
    exit 2
fi
if [ "$MODE" = "dryrun" ] && [ -z "$WINDOW" ]; then
    echo "capture.sh: --dry-run 需要 --window" >&2
    usage >&2
    exit 2
fi
if [ "$MODE" = "checkpng" ] && { [ -z "$CHECK_PNG" ] || [ -z "$BOUNDS" ]; }; then
    echo "capture.sh: --check-png 需要 --bounds x,y,w,h" >&2
    usage >&2
    exit 2
fi

if [ -n "$WINDOW" ]; then
    case "$WINDOW" in
        *[!0-9]*|"")
            echo "capture.sh: --window 必须是十进制窗口 ID，实得: $WINDOW" >&2
            exit 2
            ;;
    esac
fi

# bugs/0265 同族 N5：--skip-frontmost 关闭的是「前台是否为期望应用」的唯一自证，
# ⛔ 不允许出现在生产取像（capture / check-png）路径；只放行离线准入与自检。
if [ "$SKIP_FRONTMOST" = "1" ]; then
    case "$MODE" in
        admit|dryrun) : ;;
        *)
            if [ "$DO_SELFTEST" != "1" ]; then
                echo "capture.sh: --skip-frontmost 仅允许配合 --admit-only / --dry-run / --self-test；生产取像路径禁用" >&2
                exit 2
            fi
            ;;
    esac
fi

# N3：--negctl 是负对照开关，⛔ 未知键不能静默忽略（否则写错的负对照看起来像通过）。
NEGCTL_KEYS="alpha_zero offscreen sharing_none layer_one layer_missing bounds_missing"
if [ -n "$NEGCTL" ]; then
    IFS=',' read -ra _neg_items <<< "$NEGCTL"
    for _k in "${_neg_items[@]}"; do
        if [ -z "$_k" ]; then
            echo "capture.sh: --negctl 含空项（'$NEGCTL'）" >&2
            exit 2
        fi
        case " $NEGCTL_KEYS " in
            *" $_k "*) : ;;
            *)
                echo "capture.sh: 未知 --negctl 键 '$_k'（允许：${NEGCTL_KEYS// /,}）" >&2
                exit 2
                ;;
        esac
    done
fi
NEGCTL_APPLIED_JSON="$(python3 -I -c '
import json, sys
raw = sys.argv[1] if len(sys.argv) > 1 else ""
print(json.dumps([x for x in raw.split(",") if x], ensure_ascii=False))
' "$NEGCTL")"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/parity-capture.XXXXXX")" || exit 2
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 内置只读探针（Swift）。所有输出均为 JSON（bugs/0220：⛔ 不再用 TSV，
# 窗口标题含 TAB / 换行 / 引号时也不会错位）。
#   preflight   : CGPreflightScreenCaptureAccess()
#   frontmost   : {"name","bundle_id","pid"}
#   window <id> : 身份 + 可采样性 + bounds + 所属显示器 + 应用版本
#   environment : OS / 主题 / 架构
#   pnginfo <p>: 尺寸 / 色彩空间 / 空白统计（用于内容自证）
#   testpix <p> <blank|twotone> : 自检用 PNG 生成器
# ---------------------------------------------------------------------------
read -r -d '' PROBE_SRC <<'SWIFT'
import AppKit
import CoreGraphics
import Foundation

func emit(_ line: String) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func emitJSON(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else { exit(70) }
    emit(text)
}

func displayID(of screen: NSScreen) -> CGDirectDisplayID? {
    let key = NSDeviceDescriptionKey("NSScreenNumber")
    return (screen.deviceDescription[key] as? NSNumber)?.uint32Value
}

/// 缺失值统一写成 JSON null（⛔ 不写 0 冒充真实读数）。
func orNull(_ value: Any?) -> Any {
    guard let value = value else { return NSNull() }
    return value
}

func machineArch() -> String {
    var info = utsname()
    uname(&info)
    return withUnsafePointer(to: &info.machine) {
        $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) {
            String(cString: $0)
        }
    }
}

/// 按与窗口矩形（CG 全局坐标，左上原点）交集最大的显示器归属。
func displayInfo(for rect: CGRect) -> [String: Any] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [:] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [:] }
    let mainID = NSScreen.main.flatMap { displayID(of: $0) } ?? CGMainDisplayID()
    var bestID = mainID
    var bestArea: CGFloat = -1
    for id in ids {
        let b = CGDisplayBounds(id)
        let inter = b.intersection(rect)
        let area = inter.isNull ? 0 : inter.width * inter.height
        if area > bestArea { bestArea = area; bestID = id }
    }
    let screen = NSScreen.screens.first { displayID(of: $0) == bestID } ?? NSScreen.main
    let bounds = CGDisplayBounds(bestID)
    let info: [String: Any] = [
        "id": Int(bestID),
        "name": screen?.localizedName ?? "-",
        "scale": screen?.backingScaleFactor ?? 0,
        "main": bestID == mainID,
        "width": Int(bounds.width),
        "height": Int(bounds.height),
        "x": bounds.origin.x,
        "y": bounds.origin.y,
    ]
    return info
}

func appInfo(pid: pid_t) -> [String: Any] {
    guard let app = NSRunningApplication(processIdentifier: pid) else {
        return ["version": "-", "build": "-", "bundle_path": "-"]
    }
    var version = "-"
    var build = "-"
    if let url = app.bundleURL {
        let plistURL = url.appendingPathComponent("Contents/Info.plist")
        if let dict = NSDictionary(contentsOf: plistURL) {
            version = (dict["CFBundleShortVersionString"] as? String) ?? "-"
            build = (dict["CFBundleVersion"] as? String) ?? "-"
        }
    }
    return [
        "version": version,
        "build": build,
        "bundle_path": app.bundleURL?.path ?? "-",
    ]
}

/// 与 l2-snapshot 同口径：解码 → 画进 sRGB → 采样网格统计空白/众数色。
func pngStats(_ data: Data) -> [String: Any]? {
    guard let rep = NSBitmapImageRep(data: data), let cg = rep.cgImage,
          let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    let w = cg.width
    let h = cg.height
    guard w > 0, h > 0,
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: w * 4, space: space,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                                        | CGBitmapInfo.byteOrder32Big.rawValue) else { return nil }
    ctx.interpolationQuality = .none
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let buf = ctx.data else { return nil }
    let row = ctx.bytesPerRow
    let px = buf.bindMemory(to: UInt8.self, capacity: row * h)
    let step = max(1, min(w, h) / 64)
    var sampled = 0
    var alphaZero = 0
    var counts: [UInt32: Int] = [:]
    var y = 0
    while y < h {
        var x = 0
        while x < w {
            let o = y * row + x * 4
            let a = px[o + 3]
            if a == 0 { alphaZero += 1 }
            // alpha 合成到白底：与 bands.py / l2-snapshot 的读法一致。
            let af = Int(a)
            let r = (Int(px[o]) * af + 255 * (255 - af)) / 255
            let g = (Int(px[o + 1]) * af + 255 * (255 - af)) / 255
            let b = (Int(px[o + 2]) * af + 255 * (255 - af)) / 255
            let key = (UInt32(r) << 16) | (UInt32(g) << 8) | UInt32(b)
            counts[key, default: 0] += 1
            sampled += 1
            x += step
        }
        y += step
    }
    guard sampled > 0 else { return nil }
    let mode = counts.max { $0.value < $1.value }!.key
    let unique = counts.count
    var blankReason = ""
    if alphaZero == sampled {
        blankReason = "fully-transparent"
    } else if unique == 1 {
        blankReason = "single-color"
    }
    return [
        "width": w,
        "height": h,
        "space": (cg.colorSpace?.name as String?) ?? "-",
        "has_alpha": cg.alphaInfo != .none && cg.alphaInfo != .noneSkipFirst
                    && cg.alphaInfo != .noneSkipLast,
        "sampled": sampled,
        "unique_colors": unique,
        "alpha_zero": alphaZero,
        "blank": !blankReason.isEmpty,
        "blank_reason": blankReason,
        "mode_rgb": [Int((mode >> 16) & 0xFF), Int((mode >> 8) & 0xFF), Int(mode & 0xFF)],
    ]
}

let args = CommandLine.arguments
guard args.count >= 2 else { exit(64) }

switch args[1] {
case "preflight":
    emit(CGPreflightScreenCaptureAccess() ? "1" : "0")

case "frontmost":
    let app = NSWorkspace.shared.frontmostApplication
    emitJSON([
        "name": app?.localizedName ?? "-",
        "bundle_id": app?.bundleIdentifier ?? "-",
        "pid": Int(app?.processIdentifier ?? 0),
    ])

case "environment":
    let v = ProcessInfo.processInfo.operatingSystemVersion
    let raw = ProcessInfo.processInfo.operatingSystemVersionString
    var build = "-"
    if let l = raw.firstIndex(of: "("), let r = raw.lastIndex(of: ")"), l < r {
        build = String(raw[raw.index(after: l)..<r])
    }
    let style = UserDefaults.standard.string(forKey: "AppleInterfaceStyle") ?? "Light"
    emitJSON([
        "os_version": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
        "os_build": build,
        "os_version_string": raw,
        "arch": machineArch(),
        "appearance": style.lowercased() == "dark" ? "dark" : "light",
    ])

case "window":
    guard args.count >= 3, let wid = UInt32(args[2]) else { exit(64) }
    // optionIncludingWindow 对离屏/其它 Space 的窗口可能返回空，改用全量只读枚举后按 ID 匹配。
    let opts: CGWindowListOption = [.optionAll, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        exit(1)
    }
    guard let info = list.first(where: { ($0[kCGWindowNumber as String] as? Int) == Int(wid) }) else {
        // 不存在是「查询成功但无此窗口」，与探针自身失败区分开。
        emitJSON(["found": false, "window_id": Int(wid)])
        exit(0)
    }
    let owner = (info[kCGWindowOwnerName as String] as? String) ?? "-"
    let name = (info[kCGWindowName as String] as? String) ?? ""
    let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
    // bugs/0182：bounds 缺失时**输出 null**（⛔ 不写 0 把「读不到」伪装成零尺寸窗口）。
    // 是否可用由主脚本统一判定（正数校验），探针只负责如实转述。
    var bounds: [String: Any] = [:]
    if let b = info[kCGWindowBounds as String] as? [String: Any] {
        for key in ["X", "Y", "Width", "Height"] {
            bounds[key] = orNull((b[key] as? NSNumber)?.doubleValue)
        }
    } else {
        for key in ["X", "Y", "Width", "Height"] { bounds[key] = NSNull() }
    }
    let rect = CGRect(
        x: (bounds["X"] as? Double) ?? 0,
        y: (bounds["Y"] as? Double) ?? 0,
        width: (bounds["Width"] as? Double) ?? 0,
        height: (bounds["Height"] as? Double) ?? 0)
    var out: [String: Any] = [
        "found": true,
        "window_id": Int(wid),
        "owner": owner,
        "name": name,
        "name_present": info[kCGWindowName as String] != nil,
        "owner_pid": Int(pid),
        "bounds": bounds,
        "layer": orNull((info[kCGWindowLayer as String] as? NSNumber)?.intValue),
        "alpha": orNull((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue),
        "onscreen": orNull((info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue),
        "sharing": orNull((info[kCGWindowSharingState as String] as? NSNumber)?.intValue),
        "display": displayInfo(for: rect),
        "app": appInfo(pid: pid),
    ]
    if let app = NSRunningApplication(processIdentifier: pid) {
        out["bundle_id"] = app.bundleIdentifier ?? "-"
    } else {
        out["bundle_id"] = "-"
    }
    emitJSON(out)

case "pnginfo":
    guard args.count >= 3, let data = FileManager.default.contents(atPath: args[2]) else { exit(1) }
    guard let stats = pngStats(data) else { exit(1) }
    emitJSON(stats)

case "testpix":
    guard args.count >= 4 else { exit(64) }
    let path = args[2]
    let kind = args[3]
    let w = 16, h = 16
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: w * 4, space: space,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                                        | CGBitmapInfo.byteOrder32Big.rawValue) else { exit(1) }
    ctx.setFillColor(CGColor(colorSpace: space, components: [1, 1, 1, 1])!)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    if kind == "twotone" {
        ctx.setFillColor(CGColor(colorSpace: space, components: [0, 0.46, 0.41, 1])!)
        ctx.fill(CGRect(x: 0, y: 0, width: w / 2, height: h))
    }
    guard let image = ctx.makeImage() else { exit(1) }
    let rep = NSBitmapImageRep(cgImage: image)
    guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
    do { try png.write(to: URL(fileURLWithPath: path)) } catch { exit(1) }
    emit(path)

default:
    exit(64)
}
SWIFT

PROBE_HASH="$(printf '%s' "$PROBE_SRC" | /usr/bin/shasum -a 256 | awk '{print $1}')"
PROBE_CACHE="${TMPDIR:-/tmp}/parity-capture-helper"
PROBE_BIN="$PROBE_CACHE/probe-$PROBE_HASH"
mkdir -p "$PROBE_CACHE" || exit 2

if [ ! -x "$PROBE_BIN" ]; then
    PROBE_SWIFT="$PROBE_CACHE/probe-$PROBE_HASH.swift"
    printf '%s\n' "$PROBE_SRC" > "$PROBE_SWIFT"
    if ! swiftc -O -o "$PROBE_BIN" "$PROBE_SWIFT" >"$TMP_DIR/swiftc.log" 2>&1; then
        echo "capture.sh: 内置只读探针编译失败（见下），未执行任何查询" >&2
        cat "$TMP_DIR/swiftc.log" >&2
        exit 2
    fi
fi

# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
is_num() {
    awk -v v="$1" 'BEGIN{ exit !(v ~ /^-?[0-9]+(\.[0-9]+)?$/) }'
}
is_int() {
    case "$1" in
        ""|*[!0-9-]*) return 1 ;;
        *) return 0 ;;
    esac
}
# 只认非负整数（⛔ is_int 允许单独的 "-"，不能用于 PID/尺寸）。
is_uint() {
    case "${1:-}" in
        ""|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}
# bugs/0182：标题/路径里的换行、控制字符由 json.dumps 统一转义，⛔ 不自己拼规则。
json_escape() {
    printf '%s' "$1" | python3 -I -c 'import json,sys
sys.stdout.write(json.dumps(sys.stdin.buffer.read().decode("utf-8", "replace"), ensure_ascii=False)[1:-1])'
}

# N1：未观测的值必须写成 JSON null，⛔ 不用 ""/"-"/0 冒充已观测。
json_string_or_null() {
    if [ -n "${1:-}" ]; then printf '"%s"' "$(json_escape "$1")"; else printf 'null'; fi
}
json_uint_or_null() {
    if is_uint "${1:-}"; then printf '%s' "$1"; else printf 'null'; fi
}
# N6：display 的 CGDisplayBounds 值是 point；px 由 scale 换算（⛔ 不静默换语义）。
display_px_or_null() {
    if is_uint "${1:-}" && is_num "${2:-}"; then
        awk -v v="$1" -v s="$2" 'BEGIN { if (s + 0 > 0) printf "%d", (v * s) + 0.5; else printf "null" }'
    else
        printf 'null'
    fi
}

# 把探针 JSON 转成可 source 的 KEY='value'（shlex.quote ⇒ 任意字符都不会词法出错）。
extract_facts() {
    python3 -I - "$1" <<'PY'
import json, shlex, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
b = d.get("bounds") or {}
if not isinstance(b, dict):
    b = {}
def put(k, v):
    if isinstance(v, bool):
        v = "true" if v else "false"
    elif v is None:
        v = ""
    print("%s=%s" % (k, shlex.quote(str(v))))
put("W_FOUND", d.get("found"))
put("W_ID", d.get("window_id"))
put("W_OWNER", d.get("owner"))
put("W_NAME", d.get("name"))
put("W_BUNDLE", d.get("bundle_id"))
put("W_PID", d.get("owner_pid"))
put("W_LAYER", d.get("layer"))
put("W_ALPHA", d.get("alpha"))
put("W_ONSCREEN", d.get("onscreen"))
put("W_SHARING", d.get("sharing"))
put("W_X", b.get("X"))
put("W_Y", b.get("Y"))
put("W_W", b.get("Width"))
put("W_H", b.get("Height"))
app = d.get("app") or {}
put("W_APP_VERSION", app.get("version"))
put("W_APP_BUILD", app.get("build"))
put("W_BUNDLE_PATH", app.get("bundle_path"))
disp = d.get("display") or {}
put("D_ID", disp.get("id"))
put("D_NAME", disp.get("name"))
put("D_SCALE", disp.get("scale"))
put("D_MAIN", disp.get("main"))
put("D_W", disp.get("width"))
put("D_H", disp.get("height"))
PY
}

# ---------------------------------------------------------------------------
# --environment / --self-test：不抓帧、不枚举任何用户窗口
# ---------------------------------------------------------------------------
if [ "$DO_ENV" = "1" ]; then
    "$PROBE_BIN" environment || exit 2
    exit 0
fi

if [ "$DO_SELFTEST" = "1" ]; then
    FAILS=0
    say() { printf '%s\n' "$*"; }
    expect_ok() {
        if [ "$1" = "$2" ]; then say "SELFTEST PASS  $3"; else
            say "SELFTEST FAIL  ${3}（期望 '${2}'，实得 '${1}'）"; FAILS=$((FAILS + 1)); fi
    }
    # 1) 数字校验（0182 的边界）
    if is_num "12"; then r=ok; else r=bad; fi; expect_ok "$r" "ok" "is_num 12"
    if is_num "-3.5"; then r=ok; else r=bad; fi; expect_ok "$r" "ok" "is_num -3.5"
    if is_num ""; then r=ok; else r=bad; fi; expect_ok "$r" "bad" "is_num 空串（bounds 缺失形态）"
    if is_num "null"; then r=ok; else r=bad; fi; expect_ok "$r" "bad" "is_num null"
    if is_num "nan"; then r=ok; else r=bad; fi; expect_ok "$r" "bad" "is_num nan"
    # 2) 探针 JSON 的转义/字段数量（0220）：标题带 TAB、换行、引号、反斜杠
    printf '%s' '{"found":true,"window_id":7,"owner":"O","name":"a\tb\nc\"d\\e","name_present":true,"owner_pid":1,"bounds":{"X":1,"Y":2,"Width":3,"Height":4},"layer":0,"alpha":1,"onscreen":true,"sharing":1,"display":{"id":3,"name":"D","scale":2,"main":true,"width":10,"height":10},"app":{"version":"1","build":"2","bundle_path":"/x"},"bundle_id":"b"}' > "$TMP_DIR/adv.json"
    if extract_facts "$TMP_DIR/adv.json" > "$TMP_DIR/adv.sh" 2>/dev/null; then
        # shellcheck disable=SC1090
        . "$TMP_DIR/adv.sh"
        expect_ok "$W_NAME" "a	b
c\"d\\e" "标题含 TAB/换行/引号原样保真"
        expect_ok "$W_W" "3" "标题含特殊字符时 bounds 不错位"
        expect_ok "$W_LAYER" "0" "标题含特殊字符时 layer 不错位"
    else
        say "SELFTEST FAIL  探针 JSON 解析失败"; FAILS=$((FAILS + 1))
    fi
    # 3) bounds 缺失必须是空值而不是 0
    printf '%s' '{"found":true,"bounds":{"X":null,"Y":null,"Width":null,"Height":null},"app":{},"display":{}}' > "$TMP_DIR/nobounds.json"
    extract_facts "$TMP_DIR/nobounds.json" > "$TMP_DIR/nobounds.sh" 2>/dev/null
    # shellcheck disable=SC1090
    . "$TMP_DIR/nobounds.sh"
    expect_ok "$W_W" "" "bounds 缺失输出空值（⛔ 不是 0）"
    # 3b) 非法 JSON 必须显式失败，⛔ 不静默错位（0220 验收判据）
    printf '%s' 'owner	iTerm2	not-json' > "$TMP_DIR/broken.json"
    if extract_facts "$TMP_DIR/broken.json" > /dev/null 2>&1; then r=ok; else r=rejected; fi
    expect_ok "$r" "rejected" "非法探针输出被拒绝"
    # 4) 空白 PNG 检测（0222/0218 的内容自证）
    "$PROBE_BIN" testpix "$TMP_DIR/blank.png" blank >/dev/null 2>&1
    "$PROBE_BIN" testpix "$TMP_DIR/twotone.png" twotone >/dev/null 2>&1
    B=$("$PROBE_BIN" pnginfo "$TMP_DIR/blank.png" 2>/dev/null | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print("%s/%s"%(d["blank"],d["blank_reason"]))' 2>/dev/null)
    expect_ok "$B" "True/single-color" "全白 PNG 判空白"
    T=$("$PROBE_BIN" pnginfo "$TMP_DIR/twotone.png" 2>/dev/null | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print("%s/%s"%(d["blank"],d["unique_colors"]))' 2>/dev/null)
    expect_ok "$T" "False/2" "双色 PNG 判非空白"
    if [ "$FAILS" = "0" ]; then say "SELFTEST OK"; exit 0; fi
    say "SELFTEST FAILED（$FAILS 项）"
    exit 1
fi

# 屏幕录制权限前置检查：没有权限就不调用 screencapture，避免弹 TCC 框打扰用户。
if [ "$MODE" = "capture" ] && [ "$("$PROBE_BIN" preflight)" != "1" ]; then
    echo "capture.sh: 无屏幕录制权限（CGPreflightScreenCaptureAccess=false），未抓帧" >&2
    exit 2
fi

# ---------------------------------------------------------------------------
# 1) 抓帧前：前台应用
# ---------------------------------------------------------------------------
FM_BEFORE_NAME="-"; FM_BEFORE_BUNDLE="-"; FM_BEFORE_PID=0
if [ "$MODE" != "checkpng" ]; then
    if ! "$PROBE_BIN" frontmost > "$TMP_DIR/front_before.json"; then
        echo "capture.sh: 读取抓帧前的前台应用失败" >&2
        exit 2
    fi
    eval "$(python3 -I - "$TMP_DIR/front_before.json" <<'PY'
import json, shlex, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
for k, v in (("FM_BEFORE_NAME", d.get("name")), ("FM_BEFORE_BUNDLE", d.get("bundle_id")), ("FM_BEFORE_PID", d.get("pid"))):
    print("%s=%s" % (k, shlex.quote("" if v is None else str(v))))
PY
)"
fi

# ---------------------------------------------------------------------------
# 2) 窗口事实 + 准入（0180 身份 / 0218 可采样性）
# ---------------------------------------------------------------------------
W_FOUND=true
# N1（2026-11-08）：check-png 只读既有 PNG，**没有观测**窗口身份/可采样性/前台应用。
# 未观测的字段一律记 null 并显式标 observed=false，⛔ 不再用 "-"/0/1 冒充已观测。
W_OBSERVED=true
if [ "$MODE" = "checkpng" ]; then
    IFS=',' read -r W_X W_Y W_W W_H <<< "$BOUNDS"
    W_OBSERVED=false
    W_ID=""; W_OWNER=""; W_NAME=""; W_BUNDLE=""; W_PID=""; W_LAYER=""
    W_ALPHA=""; W_ONSCREEN=""; W_SHARING=""
    W_APP_VERSION=""; W_APP_BUILD=""; W_BUNDLE_PATH=""
    D_ID=""; D_NAME=""; D_SCALE=""; D_MAIN=""; D_W=""; D_H=""
else
    if ! "$PROBE_BIN" window "$WINDOW" > "$TMP_DIR/window.json" 2>/dev/null; then
        echo "capture.sh: 窗口 ID $WINDOW 查询失败（探针错误）" >&2
        exit 2
    fi
    if ! extract_facts "$TMP_DIR/window.json" > "$TMP_DIR/window.sh" 2>"$TMP_DIR/window.err"; then
        echo "capture.sh: 窗口 JSON 解析失败（拒绝继续）" >&2
        cat "$TMP_DIR/window.err" >&2
        exit 2
    fi
    # shellcheck disable=SC1090
    . "$TMP_DIR/window.sh"
    if [ "$W_FOUND" != "true" ]; then
        echo "capture.sh: 窗口 ID $WINDOW 不存在或不可枚举" >&2
        exit 2
    fi
fi

# ⚠️ 仅负对照：在准入判定前伪造/清空单个事实，验证闸门会红而不是静默通过。
#    所有覆盖都会写进 META 的 negctl 字段，⛔ 不用于 L2 取像。
neg_set() {
    case ",${NEGCTL}," in *",$1,"*) return 0 ;; esac
    return 1
}
# check-png 没有观测窗口事实，负对照无对象可覆盖（META 记 negctl_applicable=false）。
if [ "$W_OBSERVED" = "true" ]; then
    if neg_set "alpha_zero"; then W_ALPHA=0; fi
    if neg_set "offscreen"; then W_ONSCREEN=false; fi
    if neg_set "sharing_none"; then W_SHARING=0; fi
    if neg_set "layer_one"; then W_LAYER=1; fi
    if neg_set "layer_missing"; then W_LAYER=""; fi
    if neg_set "bounds_missing"; then W_X=""; fi
else
    # N3：没有窗口事实就没有「已应用」的负对照。请求本身仍由 negctl 字段留痕，
    # negctl_applied 只记真正生效的键（⛔ 不把「请求了」写成「应用了」）。
    NEGCTL_APPLIED_JSON="[]"
fi

# bugs/0182：bounds 是 provenance 的机器可读输入。读不到就**在产出前拒绝**，
# ⛔ 不许以 0 兜底再算出 `dpr=n/a` 交出一份非法 JSON。
if ! is_num "$W_X" || ! is_num "$W_Y" || ! is_num "$W_W" || ! is_num "$W_H"; then
    echo "capture.sh: 窗口 $WINDOW 的 bounds 不完整（x='${W_X}' y='${W_Y}' w='${W_W}' h='${W_H}'），拒绝产出 provenance" >&2
    exit 2
fi
if ! awk -v w="$W_W" -v h="$W_H" 'BEGIN{ exit !(w + 0 > 0 && h + 0 > 0) }'; then
    echo "capture.sh: 窗口 $WINDOW 的 bounds 非正（w='${W_W}' h='${W_H}'），拒绝产出 provenance" >&2
    exit 2
fi

ADMISSION_ERRORS="$TMP_DIR/admission_errors.txt"
FRAME_ERRORS="$TMP_DIR/frame_errors.txt"
: > "$ADMISSION_ERRORS"
: > "$FRAME_ERRORS"
add_err() { printf '%s\n' "$1" >> "$ADMISSION_ERRORS"; }
add_frame_err() { printf '%s\n' "$1" >> "$FRAME_ERRORS"; }

if [ "$MODE" != "checkpng" ]; then
    # 0180：layer 必须为 0（普通窗口）；读不到同样不可接受 —— ⛔ 不再只打警告。
    if ! is_int "$W_LAYER"; then
        add_err "layer 读不到（'${W_LAYER}'），无法证明是普通窗口"
    elif [ "$W_LAYER" != "0" ]; then
        add_err "layer=${W_LAYER}（⛔ 非 0：不是普通窗口，拒绝作为基线帧）"
    fi
    # 0218：alpha / onscreen / sharing 是可采样性的必要条件。
    if ! is_num "$W_ALPHA"; then
        add_err "alpha 读不到（'${W_ALPHA}'）"
    elif ! awk -v a="$W_ALPHA" 'BEGIN{ exit !(a + 0 > 0) }'; then
        add_err "alpha=${W_ALPHA}（窗口完全透明，不可采样）"
    fi
    if [ "$W_ONSCREEN" != "true" ]; then
        add_err "onscreen=${W_ONSCREEN:-读不到}（窗口不在屏上，不可采样）"
    fi
    if ! is_int "$W_SHARING"; then
        add_err "sharing 读不到（'${W_SHARING}'）"
    elif [ "$W_SHARING" = "0" ]; then
        add_err "sharing=0（kCGWindowSharingNone：窗口不可被截取）"
    fi
    # 0180：身份断言（owner / bundle 至少一项必须由调用方给出期望）
    IDENTITY_OK=true
    if [ -z "$EXPECT_OWNER" ] && [ -z "$EXPECT_BUNDLE" ]; then
        IDENTITY_OK=false
        add_err "未给出期望身份（--expect-owner / --expect-bundle），无法自证是基线应用"
    fi
    if [ -n "$EXPECT_OWNER" ] && [ "$W_OWNER" != "$EXPECT_OWNER" ]; then
        IDENTITY_OK=false
        add_err "窗口 owner='${W_OWNER}' ≠ 期望 '${EXPECT_OWNER}'"
    fi
    if [ -n "$EXPECT_BUNDLE" ] && [ "$W_BUNDLE" != "$EXPECT_BUNDLE" ]; then
        IDENTITY_OK=false
        add_err "窗口 bundle='${W_BUNDLE}' ≠ 期望 '${EXPECT_BUNDLE}'"
    fi
else
    # N1：check-png 未观测窗口身份 ⇒ identity_ok 记 null（not_applicable），
    # ⛔ 不再无条件写 true 让消费方误以为身份已核对。
    IDENTITY_OK=null
fi

# 抓帧/校验模式才需要 PNG；dry-run 只构造命令，不落任何像素。
HAS_PNG=false
case "$MODE" in capture|checkpng) HAS_PNG=true ;; esac

# ---------------------------------------------------------------------------
# 3) 取像 / PNG 校验
# ---------------------------------------------------------------------------
if [ "$MODE" = "capture" ]; then
    mkdir -p "$(dirname "$OUT")" || exit 2
    # 0223：`-a` 让 screencapture 只取目标窗口，不并入附加窗口（sheet/child）。
    CAPTURE_CMD=(screencapture -l "$WINDOW" -x -o -a "$OUT")
    if ! "${CAPTURE_CMD[@]}"; then
        echo "capture.sh: screencapture 失败: ${CAPTURE_CMD[*]}" >&2
        exit 2
    fi
    PNG="$OUT"
elif [ "$MODE" = "checkpng" ]; then
    CAPTURE_CMD=(check-png "$CHECK_PNG")
    PNG="$CHECK_PNG"
    if [ ! -s "$PNG" ]; then
        echo "capture.sh: --check-png 文件不存在或为空: $PNG" >&2
        exit 2
    fi
elif [ "$MODE" = "dryrun" ]; then
    # 只构造命令并落进 META，用于在不抓取任何用户像素的前提下自证取像口径。
    CAPTURE_CMD=(screencapture -l "$WINDOW" -x -o -a "${OUT:-<out>}")
    PNG=""
fi

if [ "$HAS_PNG" != "true" ]; then
    PNG=""
    PNG_SHA=""
    PNG_SIZE=0
    PNG_W=""; PNG_H=""
    PNG_SPACE="-"; PNG_BLANK=false; PNG_BLANK_REASON=""
    PNG_UNIQUE=0; PNG_ALPHA_ZERO=0; PNG_SAMPLED=0; PNG_MODE_RGB="[]"
else
    if [ ! -s "$PNG" ]; then
        echo "capture.sh: 抓帧后文件为空或不存在: $PNG" >&2
        exit 2
    fi
    if ! "$PROBE_BIN" pnginfo "$PNG" > "$TMP_DIR/png.json" 2>/dev/null; then
        echo "capture.sh: 无法解码 PNG（不是有效 PNG？）: $PNG" >&2
        exit 2
    fi
    eval "$(python3 -I - "$TMP_DIR/png.json" <<'PY'
import json, shlex, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
vals = {
    "PNG_W": d.get("width"),
    "PNG_H": d.get("height"),
    "PNG_SPACE": d.get("space"),
    "PNG_BLANK": "true" if d.get("blank") else "false",
    "PNG_BLANK_REASON": d.get("blank_reason") or "",
    "PNG_UNIQUE": d.get("unique_colors"),
    "PNG_ALPHA_ZERO": d.get("alpha_zero"),
    "PNG_SAMPLED": d.get("sampled"),
    "PNG_MODE_RGB": json.dumps(d.get("mode_rgb") or [], ensure_ascii=False),
}
for k, v in vals.items():
    print("%s=%s" % (k, shlex.quote("" if v is None else str(v))))
PY
)"
    PNG_SHA="$(/usr/bin/shasum -a 256 "$PNG" | awk '{print $1}')"
    PNG_SIZE="$(/usr/bin/stat -f '%z' "$PNG")"
    if ! is_num "$PNG_W" || ! is_num "$PNG_H" || ! awk -v w="$PNG_W" -v h="$PNG_H" 'BEGIN{ exit !(w + 0 > 0 && h + 0 > 0) }'; then
        echo "capture.sh: PNG 尺寸非法（${PNG_W}x${PNG_H}）: $PNG" >&2
        exit 2
    fi
fi

# 0219 / 0223：DPR 不能只由宽度反推 —— 两个方向都算并互相校验。
DPR_W=""; DPR_H=""; DPR_DELTA=""; DPR=""; DPR_SET_OK=false
if [ "$HAS_PNG" = "true" ]; then
    DPR_W="$(awk -v pw="$PNG_W" -v lw="$W_W" 'BEGIN { printf "%.4f", pw / lw }')"
    DPR_H="$(awk -v ph="$PNG_H" -v lh="$W_H" 'BEGIN { printf "%.4f", ph / lh }')"
    if ! is_num "$DPR_W" || ! is_num "$DPR_H" \
        || ! awk -v d="$DPR_W" 'BEGIN{ exit !(d + 0 > 0) }' \
        || ! awk -v d="$DPR_H" 'BEGIN{ exit !(d + 0 > 0) }'; then
        echo "capture.sh: 无法由 PNG ${PNG_W}x${PNG_H} / 窗口 ${W_W}x${W_H} 推出 DPR（'${DPR_W}'/'${DPR_H}'），拒绝产出 provenance" >&2
        exit 2
    fi
    DPR_DELTA="$(awk -v a="$DPR_W" -v b="$DPR_H" 'BEGIN { d = a - b; if (d < 0) d = -d; printf "%.4f", d }')"
    # 落在 {1,2,3} 的 ±0.02 内才算合理（外接屏常见 1/2；3 给 3× 屏留位）。
    DPR_SET_OK="$(awk -v d="$DPR_W" 'BEGIN { ok = 0; for (i = 1; i <= 3; i++) { x = d - i; if (x < 0) x = -x; if (x <= 0.02) ok = 1 } printf "%s", ok ? "true" : "false" }')"
    DPR="$DPR_W"
fi

# ---------------------------------------------------------------------------
# 4) 内容自证（0222 空白帧 / 0218 最小内容检查）
# ---------------------------------------------------------------------------
if [ "$HAS_PNG" = "true" ]; then
    if [ "$PNG_BLANK" = "true" ]; then
        add_frame_err "PNG 空白（reason=${PNG_BLANK_REASON}，unique_colors=${PNG_UNIQUE}，alpha_zero=${PNG_ALPHA_ZERO}/${PNG_SAMPLED}）"
    fi
    if [ "$DPR_SET_OK" != "true" ]; then
        add_frame_err "DPR ${DPR_W} 不在合理集合 {1,2,3}±0.02 内"
    fi
    if ! awk -v d="$DPR_DELTA" 'BEGIN{ exit !(d + 0 <= 0.01) }'; then
        add_frame_err "纵向/横向 DPR 不一致（width=${DPR_W} height=${DPR_H} Δ=${DPR_DELTA}）⇒ 帧尺寸与 bounds 不符（附加窗口或裁切）"
    fi
fi

# ---------------------------------------------------------------------------
# 5) 抓帧后：前台应用（0180）
# ---------------------------------------------------------------------------
FM_AFTER_NAME="-"; FM_AFTER_BUNDLE="-"; FM_AFTER_PID=0
FRONT_CHANGED="false"
if [ "$MODE" != "checkpng" ]; then
    if ! "$PROBE_BIN" frontmost > "$TMP_DIR/front_after.json"; then
        echo "capture.sh: 读取抓帧后的前台应用失败" >&2
        exit 2
    fi
    eval "$(python3 -I - "$TMP_DIR/front_after.json" <<'PY'
import json, shlex, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
for k, v in (("FM_AFTER_NAME", d.get("name")), ("FM_AFTER_BUNDLE", d.get("bundle_id")), ("FM_AFTER_PID", d.get("pid"))):
    print("%s=%s" % (k, shlex.quote("" if v is None else str(v))))
PY
)"
    if [ "$FM_BEFORE_NAME" != "$FM_AFTER_NAME" ] || [ "$FM_BEFORE_BUNDLE" != "$FM_AFTER_BUNDLE" ]; then
        FRONT_CHANGED="true"
    fi
    if [ "$FRONT_CHANGED" = "true" ]; then
        add_frame_err "抓帧前后前台应用变化（${FM_BEFORE_NAME} -> ${FM_AFTER_NAME}）"
    fi
    if [ "$ASSERT_FRONTMOST" = "1" ] && [ -n "$EXPECT_OWNER" ] && { [ "$FM_BEFORE_NAME" != "$EXPECT_OWNER" ] || [ "$FM_AFTER_NAME" != "$EXPECT_OWNER" ]; }; then
        add_frame_err "前台应用不是期望的 '${EXPECT_OWNER}'（before='${FM_BEFORE_NAME}' after='${FM_AFTER_NAME}'）"
    fi
    if [ "$ASSERT_FRONTMOST" = "1" ] && [ -n "$EXPECT_BUNDLE" ] && { [ "$FM_BEFORE_BUNDLE" != "$EXPECT_BUNDLE" ] || [ "$FM_AFTER_BUNDLE" != "$EXPECT_BUNDLE" ]; }; then
        add_frame_err "前台 bundle 不是期望的 '${EXPECT_BUNDLE}'（before='${FM_BEFORE_BUNDLE}' after='${FM_AFTER_BUNDLE}'）"
    fi
fi

# N1：check-png 不读前台应用 ⇒ frontmost_* 记 null + observed=false，
# ⛔ 不再无条件写 frontmost_asserted=true。
if [ "$MODE" = "checkpng" ]; then
    FRONTMOST_OBSERVED=false
    FRONTMOST_ASSERTED=null
else
    FRONTMOST_OBSERVED=true
    FRONTMOST_ASSERTED=$([ "$ASSERT_FRONTMOST" = "1" ] && echo true || echo false)
fi

# ---------------------------------------------------------------------------
# 6) 环境表快照（0226）：OS / 应用版本 / 主题 / 显示器 / 排版参数 + SHA
# ---------------------------------------------------------------------------
"$PROBE_BIN" environment > "$TMP_DIR/env_probe.json" || exit 2
SETTINGS_PATH="$ENV_FILE"
if [ -n "$SETTINGS_PATH" ] && [ ! -s "$SETTINGS_PATH" ]; then
    echo "capture.sh: --env-file 不存在或为空: $SETTINGS_PATH" >&2
    exit 2
fi
ENV_COMPLETE="$(python3 -I - "$TMP_DIR/env_probe.json" "$TMP_DIR/window.json" "${SETTINGS_PATH:-}" "$TMP_DIR/environment.json" "$VERSION" "$MODE" "$NEGCTL" "$NEGCTL_APPLIED_JSON" "$W_OBSERVED" <<'PY'
import hashlib, json, sys

(probe_path, window_path, settings_path, out_path, script_version, mode,
 negctl_raw, negctl_applied_raw, observed_raw) = sys.argv[1:10]
probe = json.load(open(probe_path, encoding="utf-8"))
try:
    win = json.load(open(window_path, encoding="utf-8"))
except (OSError, ValueError):
    win = {}
disp = win.get("display") or {}
app = win.get("app") or {}
observed = observed_raw == "true"
try:
    negctl_applied = json.loads(negctl_applied_raw or "[]")
except ValueError:
    negctl_applied = []

settings = None
settings_source = None
settings_error = None
if settings_path:
    settings_source = settings_path
    try:
        raw = json.load(open(settings_path, encoding="utf-8"))
        appearance = raw.get("appearance")
        a = appearance if isinstance(appearance, dict) else raw
        # 实测列宽优先于配置值（版心 = 实际正文列宽）。
        width = a.get("content_box_width")
        if width is None:
            width = raw.get("content_width_px", a.get("content_width"))
        settings = {
            "font_family": a.get("font_family", raw.get("font_family")),
            "font_size": a.get("font_size", raw.get("font_size")),
            "line_height": a.get("line_height", raw.get("line_height")),
            "content_width": width,
            "sidebar_width": raw.get("sidebar_width", a.get("sidebar_width")),
        }
    except (OSError, ValueError) as exc:
        settings_error = "%s: %s" % (type(exc).__name__, exc)

# N6：`CGDisplayBounds` 的单位是 **point**；旧字段 `width_px/height_px` 把 point 当 px。
# 现在 `*_pt` 是 CGDisplayBounds 原值，`*_px` 由 scale 换算；⛔ 不改名后静默换语义。
scale = disp.get("scale")
try:
    scale_num = float(scale) if scale is not None else None
except (TypeError, ValueError):
    scale_num = None
w_pt = disp.get("width")
h_pt = disp.get("height")

def to_px(pt):
    if pt is None or scale_num is None or scale_num <= 0:
        return None
    return int(round(float(pt) * scale_num))

env = {
    "schema": "l1-capture-env/1",
    "capture_script": script_version,
    "os_version": probe.get("os_version"),
    "os_build": probe.get("os_build"),
    "arch": probe.get("arch"),
    "appearance": probe.get("appearance"),
    # N3：负对照开关必须留痕；未观测时 applicable=false，⛔ 不把测试开关洗成正常帧。
    "negctl": negctl_raw or None,
    "negctl_applied": negctl_applied,
    "negctl_applicable": observed,
    "observed": observed,
    "app": {
        "name": win.get("owner") if observed else None,
        "bundle_id": win.get("bundle_id") if observed else None,
        "version": app.get("version") if observed else None,
        "build": app.get("build") if observed else None,
        "pid": win.get("owner_pid") if observed else None,
    },
    "display": {
        "id": disp.get("id") if observed else None,
        "name": disp.get("name") if observed else None,
        "scale": scale_num if observed else None,
        "main": disp.get("main") if observed else None,
        "width_pt": w_pt if observed else None,
        "height_pt": h_pt if observed else None,
        "width_px": to_px(w_pt) if observed else None,
        "height_px": to_px(h_pt) if observed else None,
        "units": "width_pt/height_pt = CGDisplayBounds point; "
                 "width_px/height_px = *_pt * scale",
    },
    "appearance_settings": settings,
    "appearance_settings_source": settings_source,
    "appearance_settings_error": settings_error,
}

REQUIRED = {
    "os_version": env["os_version"],
    "os_build": env["os_build"],
    "arch": env["arch"],
    "appearance": env["appearance"],
}
# check-png 只校验既有 PNG，不声称「哪次运行、哪个应用」——应用/显示器不参与完整性。
if mode != "checkpng":
    REQUIRED["app.version"] = env["app"]["version"]
    REQUIRED["display.id"] = env["display"]["id"]
    REQUIRED["display.scale"] = env["display"]["scale"]
# 排版四项必须有值；font_family 产品配置里不存在，如实记 null（不伪装成已采集）。
if settings:
    for key in ("font_size", "line_height", "content_width", "sidebar_width"):
        REQUIRED["settings." + key] = settings.get(key)
else:
    REQUIRED["settings"] = None
missing = [k for k, v in REQUIRED.items() if v in (None, "", "-")]
env["missing"] = missing
env["complete"] = not missing
# SHA 覆盖除自身以外的全部字段（稳定排序、紧凑分隔符）。
canon = json.dumps(env, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
env["sha256"] = hashlib.sha256(canon.encode("utf-8")).hexdigest()

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(env, fh, ensure_ascii=False, sort_keys=True)
print("true" if env["complete"] else "false")
PY
)" || { echo "capture.sh: 环境表生成失败" >&2; exit 2; }

if [ "$ENV_COMPLETE" != "true" ] && { [ "$MODE" = "capture" ] || [ "$MODE" = "checkpng" ]; }; then
    add_frame_err "环境表不完整（缺 $(python3 -I -c 'import json,sys;print(",".join(json.load(open(sys.argv[1],encoding="utf-8"))["missing"]))' "$TMP_DIR/environment.json")）"
fi
ENV_SHA="$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1],encoding="utf-8"))["sha256"])' "$TMP_DIR/environment.json")"

# ---------------------------------------------------------------------------
# 7) 汇总（0220 的 JSON 合法性自证保留）
# ---------------------------------------------------------------------------
ADMISSION_PASSED=true
if [ -s "$ADMISSION_ERRORS" ]; then ADMISSION_PASSED=false; fi
FRAME_OK=true
if [ -s "$FRAME_ERRORS" ]; then FRAME_OK=false; fi
STATUS="valid"
if [ "$ADMISSION_PASSED" != "true" ] || [ "$FRAME_OK" != "true" ]; then STATUS="invalid"; fi
CAPTURED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
ENV_JSON="$(cat "$TMP_DIR/environment.json")"
ERRORS_JSON="$(python3 -I - "$ADMISSION_ERRORS" "$FRAME_ERRORS" <<'PY'
import json, sys
out = []
for path in sys.argv[1:]:
    out.extend(l.rstrip("\n") for l in open(path, encoding="utf-8") if l.strip())
print(json.dumps(out, ensure_ascii=False))
PY
)"
ADMISSION_JSON="$(python3 -I - "$ADMISSION_ERRORS" <<'PY'
import json, sys
print(json.dumps([l.rstrip("\n") for l in open(sys.argv[1], encoding="utf-8") if l.strip()],
                 ensure_ascii=False))
PY
)"

# N1：check-png 未观测的字段统一落 null，并显式标 observed=false / not_applicable。
# 已观测路径保持原语义（owner/bundle/layer/alpha/... 都是真实读数）。
if [ "$W_OBSERVED" = "true" ]; then
    WINDOW_ID_JSON="$(json_uint_or_null "$W_ID")"
    OWNER_JSON="$(json_string_or_null "$W_OWNER")"
    NAME_JSON="$(json_string_or_null "$W_NAME")"
    BUNDLE_JSON="$(json_string_or_null "$W_BUNDLE")"
    OWNER_PID_JSON="$(json_uint_or_null "$W_PID")"
    IDENTITY_OBSERVED_JSON="{\"owner\": ${OWNER_JSON}, \"bundle_id\": ${BUNDLE_JSON}, \"owner_pid\": ${OWNER_PID_JSON}}"
    FRONTMOST_BEFORE_JSON="{\"name\": $(json_string_or_null "$FM_BEFORE_NAME"), \"bundle_id\": $(json_string_or_null "$FM_BEFORE_BUNDLE"), \"pid\": $(json_uint_or_null "$FM_BEFORE_PID")}"
    FRONTMOST_AFTER_JSON="{\"name\": $(json_string_or_null "$FM_AFTER_NAME"), \"bundle_id\": $(json_string_or_null "$FM_AFTER_BUNDLE"), \"pid\": $(json_uint_or_null "$FM_AFTER_PID")}"
    FRONT_CHANGED_JSON="$FRONT_CHANGED"
    DISPLAY_NAME_JSON="$(json_string_or_null "$D_NAME")"
    ADMISSION_APPLICABLE=true
    ADMISSION_PASSED_JSON="$ADMISSION_PASSED"
    NOT_APPLICABLE_JSON="[]"
else
    WINDOW_ID_JSON=null
    OWNER_JSON=null
    NAME_JSON=null
    BUNDLE_JSON=null
    OWNER_PID_JSON=null
    IDENTITY_OBSERVED_JSON=null
    FRONTMOST_BEFORE_JSON=null
    FRONTMOST_AFTER_JSON=null
    FRONT_CHANGED_JSON=null
    DISPLAY_NAME_JSON=null
    ADMISSION_APPLICABLE=false
    ADMISSION_PASSED_JSON=null
    NOT_APPLICABLE_JSON='["window_identity","samplability","frontmost"]'
fi
NEGCTL_APPLICABLE_JSON="$([ "$W_OBSERVED" = "true" ] && echo true || echo false)"
D_W_PX_JSON="$(display_px_or_null "$D_W" "$D_SCALE")"
D_H_PX_JSON="$(display_px_or_null "$D_H" "$D_SCALE")"

build_meta() {
    cat <<EOF
{
  "capture_script": "$(json_escape "$VERSION")",
  "capture_mode": "$([ "$MODE" = "capture" ] && echo screencapture || { [ "$MODE" = "checkpng" ] && echo check-png || { [ "$MODE" = "dryrun" ] && echo dry-run || echo admit-only; }; })",
  "observed": $W_OBSERVED,
  "not_applicable": $NOT_APPLICABLE_JSON,
  "negctl": "$(json_escape "$NEGCTL")",
  "negctl_applied": $NEGCTL_APPLIED_JSON,
  "negctl_applicable": $NEGCTL_APPLICABLE_JSON,
  "status": "$STATUS",
  "errors": $ERRORS_JSON,
  "window_id": $WINDOW_ID_JSON,
  "owner": $OWNER_JSON,
  "name": $NAME_JSON,
  "bundle_id": $BUNDLE_JSON,
  "owner_pid": $OWNER_PID_JSON,
  "window_bounds_pt": {
    "x": $W_X,
    "y": $W_Y,
    "width": $W_W,
    "height": $W_H
  },
  "layer": $( [ -n "${W_LAYER:-}" ] && { is_int "$W_LAYER" && echo "$W_LAYER" || echo null; } || echo null ),
  "alpha": $( is_num "${W_ALPHA:-}" && echo "$W_ALPHA" || echo null ),
  "onscreen": $( [ "${W_ONSCREEN:-}" = "true" ] && echo true || { [ "${W_ONSCREEN:-}" = "false" ] && echo false || echo null; } ),
  "sharing": $( [ -n "${W_SHARING:-}" ] && { is_int "$W_SHARING" && echo "$W_SHARING" || echo null; } || echo null ),
  "display": {
    "id": $( [ -n "${D_ID:-}" ] && { is_int "$D_ID" && echo "$D_ID" || echo null; } || echo null ),
    "name": $DISPLAY_NAME_JSON,
    "scale": $( is_num "${D_SCALE:-}" && echo "$D_SCALE" || echo null ),
    "main": $( [ "${D_MAIN:-}" = "true" ] && echo true || { [ "${D_MAIN:-}" = "false" ] && echo false || echo null; } ),
    "width_pt": $( is_uint "${D_W:-}" && echo "$D_W" || echo null ),
    "height_pt": $( is_uint "${D_H:-}" && echo "$D_H" || echo null ),
    "width_px": $D_W_PX_JSON,
    "height_px": $D_H_PX_JSON,
    "units": "width_pt/height_pt = CGDisplayBounds point; width_px/height_px = *_pt * scale"
  },
  "identity_expected": {
    "owner": "$(json_escape "$EXPECT_OWNER")",
    "bundle_id": "$(json_escape "$EXPECT_BUNDLE")"
  },
  "identity_observed": $IDENTITY_OBSERVED_JSON,
  "identity_ok": $IDENTITY_OK,
  "admission": {
    "applicable": $ADMISSION_APPLICABLE,
    "passed": $ADMISSION_PASSED_JSON,
    "errors": $ADMISSION_JSON
  },
  "frontmost_before": $FRONTMOST_BEFORE_JSON,
  "frontmost_after": $FRONTMOST_AFTER_JSON,
  "frontmost_observed": $FRONTMOST_OBSERVED,
  "frontmost_changed": $FRONT_CHANGED_JSON,
  "frontmost_asserted": $FRONTMOST_ASSERTED,
  "captured_at": "$CAPTURED_AT",
  "png": "$(json_escape "$PNG")",
  "png_sha256": "$PNG_SHA",
  "png_size_bytes": ${PNG_SIZE:-0},
  "png_width_px": $( is_num "${PNG_W:-}" && echo "$PNG_W" || echo null ),
  "png_height_px": $( is_num "${PNG_H:-}" && echo "$PNG_H" || echo null ),
  "png_color_space": "$(json_escape "$PNG_SPACE")",
  "png_blank": $PNG_BLANK,
  "png_blank_reason": "$(json_escape "$PNG_BLANK_REASON")",
  "png_unique_colors": ${PNG_UNIQUE:-0},
  "png_sampled_px": ${PNG_SAMPLED:-0},
  "png_alpha_zero_px": ${PNG_ALPHA_ZERO:-0},
  "png_mode_rgb": $PNG_MODE_RGB,
  "dpr": $( is_num "${DPR:-}" && echo "$DPR" || echo null ),
  "dpr_width": $( is_num "${DPR_W:-}" && echo "$DPR_W" || echo null ),
  "dpr_height": $( is_num "${DPR_H:-}" && echo "$DPR_H" || echo null ),
  "dpr_delta": $( is_num "${DPR_DELTA:-}" && echo "$DPR_DELTA" || echo null ),
  "dpr_set_ok": $DPR_SET_OK,
  "capture_command": "$(json_escape "${CAPTURE_CMD[*]:-}")",
  "environment_sha256": "$ENV_SHA",
  "environment_complete": $ENV_COMPLETE,
  "environment": $ENV_JSON,
  "provenance": {
    "frame_sha256": "$PNG_SHA",
    "frame_sha256_source": "recomputed-after-capture",
    "captured_at": "$CAPTURED_AT",
    "window_id": $WINDOW_ID_JSON,
    "window_id_observed": $W_OBSERVED,
    "environment_sha256": "$ENV_SHA"
  }
}
EOF
}

if [ -n "$META" ]; then
    mkdir -p "$(dirname "$META")" || exit 2
    META_TMP="$TMP_DIR/meta.json"
    build_meta > "$META_TMP"

    # bugs/0182：写出来的东西必须先自证是合法 JSON，再落到 --meta 路径。
    # ⛔ 不许「写了就算成功」——失败推迟到下游 `json.load` 时，成因已经丢了。
    if ! python3 -I -c 'import json,sys
json.load(open(sys.argv[1], encoding="utf-8"))' "$META_TMP" 2>"$TMP_DIR/meta_check.err"; then
        echo "capture.sh: 生成的 provenance 不是合法 JSON，拒绝交付（详见下）" >&2
        cat "$TMP_DIR/meta_check.err" >&2
        rm -f "$META_TMP"
        exit 2
    fi
    mv -f "$META_TMP" "$META" || exit 2
    cat "$META"
else
    build_meta
fi

if [ "$STATUS" != "valid" ]; then
    echo "capture.sh: ⛔ 帧被判无效（status=invalid），原因：" >&2
    while IFS= read -r line; do [ -n "$line" ] && echo "  - $line" >&2; done < "$ADMISSION_ERRORS"
    while IFS= read -r line; do [ -n "$line" ] && echo "  - $line" >&2; done < "$FRAME_ERRORS"
    exit 3
fi

exit 0
