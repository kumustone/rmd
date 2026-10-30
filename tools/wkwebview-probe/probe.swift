// rmd · 批次 0 —— 真机 WKWebView 的观测能力探针（`design/0002` §7.0 第 6 步）
//
// # 为什么有这个文件
//
// `docs/kb/0003-WKWebView-性能观测能力.md` 一手核实了「WebKit **没有** `longtask`」，
// 但它读的是 **WebKit 上游源码**。上游 `main` ≠ 本机这个 WKWebView 版本。
// 而这条结论**决定 `design/0002` §7.3 的整个测量方案成立与否**：
// 如果本机其实有 `longtask`，§7.3 那套"同步分段计时"的替代方案就是自找麻烦。
//
// 所以这一步的产出是**真值，不是推断**。
//
// # 为什么是独立 Swift，不是 Tauri
//
// §7.0 写明第 5、6 步「**都必须在写原型代码之前完成**」。用一个几十行的 Swift 探针
// 比先搭 Tauri 更符合那个时序，也避免"为了测一个 JS API 先编译整棵 Tauri 依赖树"。
//
// # 怎么跑
//
//     tools/wkwebview-probe/run.sh          # 见同目录的 run.sh
//
// ⚠️ 需要图形会话（会创建一个隐藏窗口，不弹出来）。
// ⚠️ 探针**不联网**：`loadHTMLString` 用的是内联 HTML。

import Cocoa
import WebKit

// ── 被探测的 entry type 清单 ──
// 前四个是 `design/0002` §7.3.3 点名"只有包含才 observe"的；
// `longtask` 是 `kb/0003` 说"没有"的那个（本条就是要复核它）；
// 其余是常见但本项目未必需要的，一并记录，省得下次再写一遍探针。
private let PROBE_TYPES = [
    "paint", "largest-contentful-paint", "event", "first-input",
    "longtask", "loaf",
    "element", "layout-shift", "navigation", "resource",
    "mark", "measure", "visibility-state", "back-forward-cache",
]

private let JS = """
(() => {
  const out = {};

  // ① 上游结论要复核的那一个属性
  try {
    out.supportedEntryTypes = PerformanceObserver.supportedEntryTypes ?? null;
  } catch (e) {
    out.supportedEntryTypes = "throw: " + e.name + ": " + e.message;
  }
  out.hasPerformanceObserver = (typeof PerformanceObserver !== "undefined");

  // ② 逐个实测 observe()：属性里没有的，observe 会不会**静默**接受？
  //    ⚠️ 这正是"照着 Chromium 写法抄会静默测不到东西"的机制——
  //    如果 observe 对不支持的 type 不报错，那错误就只体现在"永远收不到回调"。
  const types = %TYPES%;
  out.observeProbe = {};
  for (const t of types) {
    try {
      const o = new PerformanceObserver(() => {});
      o.observe({ type: t, buffered: true });
      o.disconnect();
      out.observeProbe[t] = "ok";
    } catch (e) {
      out.observeProbe[t] = "throw: " + e.name;
    }
  }

  // ③ paint 条目实测（`loadHTMLString` 之后一般已经有了）
  try {
    out.paintEntries = performance.getEntriesByType("paint")
      .map(e => ({ name: e.name, startTime: Math.round(e.startTime * 100) / 100 }));
  } catch (e) {
    out.paintEntries = "throw: " + e.name;
  }

  // ④ 身份与时钟：报告要能对齐机器与版本
  out.userAgent = navigator.userAgent;
  out.timeOrigin = performance.timeOrigin;
  out.hasPerformanceMark = (typeof performance.mark === "function");
  out.devicePixelRatio = window.devicePixelRatio;

  return JSON.stringify(out);
})()
""".replacingOccurrences(of: "%TYPES%", with: {
    let quoted = PROBE_TYPES.map { "\"\($0)\"" }.joined(separator: ", ")
    return "[\(quoted)]"
}())

private final class ProbeDelegate: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript(JS) { result, error in
            if let error = error {
                FileHandle.standardError.write(
                    "⛔ evaluateJavaScript 失败：\(error)\n".data(using: .utf8)!)
                exit(1)
            }
            guard let json = result as? String else {
                FileHandle.standardError.write(
                    "⛔ 返回值不是字符串：\(String(describing: result))\n".data(using: .utf8)!)
                exit(1)
            }
            // ⚠️ 直接把原始 JSON 打到 stdout，让调用方决定怎么落盘——
            //    探针不替使用者决定格式（`run.sh` 负责套壳与落盘）。
            print(json)
            exit(0)
        }
    }

    func webView(_ webView: WKWebView,
                 didFail navigation: WKNavigation!,
                 withError error: Error) {
        FileHandle.standardError.write("⛔ 导航失败：\(error)\n".data(using: .utf8)!)
        exit(1)
    }
}

// ── 起一个隐藏窗口，让布局/绘制真的发生 ──
// ⚠️ 不给 viewport 的话有些 API 的行为不代表真实使用场景。
let app = NSApplication.shared
// ⚠️⚠️ **`.prohibited`，⛔ 不是 `.accessory`**（`kb/0025` ＋ 2026-10-21 实测）：
//    `.accessory` 只是"没有 Dock 图标"，**仍会被激活**——从正在前台的终端里起进程时，
//    实测 `frontmostApplication` 会从 `iTerm2` 变成探针自己。本探针不依赖焦点/键盘，
//    ⇒ 换 `.prohibited`（结构上不允许被激活），代价为零。
_ = app.setActivationPolicy(.prohibited)

let config = WKWebViewConfiguration()
config.suppressesIncrementalRendering = false

let rect = NSRect(x: 0, y: 0, width: 1200, height: 800)
let webView = WKWebView(frame: rect, configuration: config)
private let delegate = ProbeDelegate()
webView.navigationDelegate = delegate

let window = NSWindow(contentRect: rect,
                      styleMask: [.borderless],
                      backing: .buffered,
                      defer: false)
window.contentView = webView
// ⚠️ 不 orderFront：窗口不进屏幕，但 WebView 仍是"已附着"状态，
//    布局与 paint 照常发生。这样跑探针不会打断用户。
window.alphaValue = 0

webView.loadHTMLString(
    "<!doctype html><meta charset=\"utf-8\"><title>rmd wkwebview probe</title>" +
    "<body style=\"font:14px -apple-system\">探测中…</body>", baseURL: nil)

// 兜底超时：5 秒还没回调就报错，别让探针挂死
DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
    FileHandle.standardError.write("⛔ 5 秒内没有拿到结果（WKWebView 没起来？）\n".data(using: .utf8)!)
    exit(1)
}

app.run()
