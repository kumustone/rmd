// rmd · 全局失败条「**真的看得见吗**」的离屏可见性闸门
//
// 起因（2026-11-15 用户）：「新建文件，没有任何反应」
//   ⚠️ 应用日志证明 `onNewFile()` 走到了 `raiseFail(fail.new.no-directory)`，
//      且 `services/failbar.js::raise()` 里的 `onShown` 留了痕 ⇒ **模型层确实渲染了**。
//      那"看不见"只可能出在**渲染之后的那一层**（布局 / 覆盖 / 状态互斥）。
//   ⇒ 把"看得见"变成可断言的数：真 `index.html` ＋ 真样式表 ＋ **产品那一个**
//      `services/failbar.js`（⛔ 不抄第二份实现），在每种 body 状态下量
//      ① 矩形与计算样式 ② `elementFromPoint` 的命中者（被盖住 = 用户看不见）。
//
// ⚠️ 页面由 `failbar-visible-probe.sh` 现搭：`src/index.html` 摘掉 `<script>`
//    （没有 Tauri IPC 时真脚本会走 `reportFatal` 把 DOM 换掉）+ 原顺序的样式表副本。
// ⚠️ 离屏：`alphaValue = 0` ＋ `orderBack` ＋ `.prohibited`（`kb/0025`）。
//    ⛔ 不抢前台、⛔ 不合成按键（根 `CLAUDE.md` §4）。
// 用法： failbar-visible-probe <pageDir> [--json]
// 退出码：0 = 全通过；1 = 有判据失败；3 = 跑不起来

import Cocoa
import WebKit

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    FileHandle.standardError.write("用法: failbar-visible-probe <pageDir> [--json]\n".data(using: .utf8)!)
    exit(3)
}
let pageDir = argv[1]
var asJSON = false
var i = 2
while i < argv.count {
    switch argv[i] {
    case "--json": asJSON = true; i += 1
    default:
        FileHandle.standardError.write("未知参数：\(argv[i])\n".data(using: .utf8)!)
        exit(3)
    }
}

// ⚠️ 必须 `callAsyncJavaScript`（老 `evaluateJavaScript` 不 await Promise）。
// ⚠️ 让出事件循环一律用 `setTimeout(…, 0)`：不可见窗口不保证派 rAF（`cm6-probe.swift` 的教训）。
let RUNNER = """
  const out = { checks: [], info: {} };
  const check = (name, ok, actual, expect) =>
    out.checks.push({ name: name, ok: !!ok, actual: String(actual), expect: String(expect) });

  const bar = document.getElementById('fail-bar');
  const textEl = document.getElementById('fail-text');
  const preview = document.getElementById('preview-bar');

  // ── ① 前提：**产品那一份** `createFailBar` 真的把条渲染出来了 ──
  const raised = window.__failbarProbe();
  out.info.raise_shown = raised.shown;
  out.info.raise_hidden_attr = raised.hidden;
  out.info.text = textEl ? textEl.textContent : null;
  check('前提：raise(fail.new.no-directory) 返回 true 且 #fail-bar 被解除隐藏',
        raised.shown === true && raised.hidden === false,
        JSON.stringify(raised), '{"shown":true,"hidden":false}');
  check('前提：文案就是「先打开一个目录」',
        textEl && textEl.textContent === '先打开一个目录',
        JSON.stringify(out.info.text), '"先打开一个目录"');

  // ── ② 每种 body 状态下的可见性 ──
  function snap(label, cls, previewShown) {
    document.body.className = cls;
    preview.hidden = !previewShown;
    void document.body.offsetHeight;
    const r = bar.getBoundingClientRect();
    const cs = getComputedStyle(bar);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = (r.width > 1 && r.height > 1) ? document.elementFromPoint(cx, cy) : null;
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    return {
      label: label,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      topbar: [Math.round(topbar.top), Math.round(topbar.height)],
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      hit: hit ? (hit.id || hit.className || hit.tagName) : null,
      hit_inside: !!(hit && (hit === bar || bar.contains(hit))),
      in_viewport: r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5 && r.left >= -0.5,
      on_screen: r.width > 40 && r.height > 6
                 && cs.display !== 'none' && cs.visibility !== 'hidden'
                 && parseFloat(cs.opacity) > 0.9,
    };
  }

  const STATES = [
    ['阅读态',                '', false],
    ['编辑态',                'editing', false],
    ['折叠顶栏',              'chrome-hidden', false],
    ['专注模式',              'zen', false],
    ['编辑态＋折叠顶栏',      'editing chrome-hidden', false],
    ['编辑态＋专注模式',      'editing zen', false],
    ['编辑态＋预览提示条',    'editing', true],
  ];

  const states = {};
  for (const [label, cls, pv] of STATES) {
    states[label] = snap(label, cls, pv);
    const s = states[label];
    check('可见性·' + label + '：有条、不透明、在视口内',
          s.on_screen && s.in_viewport,
          'rect=' + JSON.stringify(s.rect) + ' display=' + s.display
          + ' visibility=' + s.visibility + ' opacity=' + s.opacity
          + ' in_viewport=' + s.in_viewport,
          'rect 高>6 且 flex/block、visible、opacity≈1、整体在视口内');
    check('命中·' + label + '：中心点 `elementFromPoint` 落在条内（⛔ 没被别的元素盖住）',
          s.hit_inside === true,
          JSON.stringify(s.hit) + ' / inside=' + s.hit_inside,
          'true');
  }
  out.info.states = states;

  // ── ③ 编辑态 ＋ 预览提示条同时在场时，两者**不许相交** ──
  //    ⚠️ `#preview-bar` 在编辑态是 `absolute / bottom:0`（`editor.css` §10.14）——
  //       失败条恰好也是 `.topbar` 的最后一行 ⇒ 这是**结构上会撞**的一对。
  document.body.className = 'editing';
  preview.hidden = false;
  void document.body.offsetHeight;
  const rb = bar.getBoundingClientRect();
  const rp = preview.getBoundingClientRect();
  const overlap = !(rp.bottom <= rb.top || rp.top >= rb.bottom || rp.right <= rb.left || rp.left >= rb.right);
  out.info.preview_overlap = overlap;
  out.info.preview_rect = [Math.round(rp.left), Math.round(rp.top), Math.round(rp.width), Math.round(rp.height)];
  check('编辑态下预览提示条**不与失败条相交**（相交 = 失败被盖住）',
        overlap === false, String(overlap), 'false');

  document.body.className = '';
  return out;
"""

final class Delegate: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.callAsyncJavaScript(RUNNER, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .failure(let error):
                FileHandle.standardError.write("⛔ callAsyncJavaScript 失败：\(error)\n".data(using: .utf8)!)
                exit(3)
            case .success(let value):
                guard let dict = value as? [String: Any],
                      let checks = dict["checks"] as? [[String: Any]] else {
                    FileHandle.standardError.write("⛔ 结果形状不对：\(value)\n".data(using: .utf8)!)
                    exit(3)
                }
                emit(checks: checks, info: (dict["info"] as? [String: Any]) ?? [:])
            }
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("⛔ 导航失败：\(error)\n".data(using: .utf8)!); exit(3)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("⛔ 预导航失败：\(error)\n".data(using: .utf8)!); exit(3)
    }
}

func emit(checks: [[String: Any]], info: [String: Any]) {
    if asJSON {
        let payload: [String: Any] = ["info": info, "checks": checks]
        if let d = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .prettyPrinted]),
           let s = String(data: d, encoding: .utf8) { print(s) }
        exit(checks.allSatisfy { ($0["ok"] as? Bool) == true } ? 0 : 1)
    }
    print("# 失败条可见性闸门（真 index.html ＋ 真样式表 ＋ 产品 failbar.js）")
    var bad = 0
    for (n, c) in checks.enumerated() {
        let ok = (c["ok"] as? Bool) == true
        if !ok { bad += 1 }
        print("\(ok ? "ok" : "not ok") \(n + 1) - \(c["name"] as? String ?? "?")")
        print("#    实测 = \(c["actual"] as? String ?? "nil")   期望 = \(c["expect"] as? String ?? "nil")")
    }
    print("# 实测量：")
    for k in info.keys.sorted() { print("#    \(k) = \(info[k]!)") }
    print(bad == 0 ? "1..\(checks.count)  ✅ 全通过" : "⛔ \(bad)/\(checks.count) 条失败")
    exit(bad == 0 ? 0 : 1)
}

let app = NSApplication.shared
// ⚠️⚠️ **`.prohibited`，⛔ 不是 `.accessory`**（`kb/0025`）：后者仍可被激活，会把前台的终端挤下去。
_ = app.setActivationPolicy(.prohibited)

let config = WKWebViewConfiguration()
config.suppressesIncrementalRendering = false
let rect = NSRect(x: 0, y: 0, width: 1400, height: 900)
let webView = WKWebView(frame: rect, configuration: config)
private let delegate = Delegate()
webView.navigationDelegate = delegate

let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView
window.alphaValue = 0

DispatchQueue.main.async {
    let base = URL(fileURLWithPath: pageDir)
    let htmlURL = base.appendingPathComponent("index.html")
    window.orderBack(nil)
    FileHandle.standardError.write("▶ 加载 \(htmlURL.path)\n".data(using: .utf8)!)
    webView.loadFileURL(htmlURL, allowingReadAccessTo: base)
}

// 兜底超时（macOS 没有 coreutils 的 `timeout`）
let wall = Date()
while Date().timeIntervalSince(wall) < 60 {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
}
FileHandle.standardError.write("⛔ 60 秒没拿到结果\n".data(using: .utf8)!)
exit(3)
