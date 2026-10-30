#!/usr/bin/env bash
# 跑「编辑面与预览共存的时序」探针（`design/0012` §7 步骤 0f）
#
# 用法：
#   tools/wkwebview-probe/editor-latency-probe.sh                # 落盘到 benchmarks/results/
#   tools/wkwebview-probe/editor-latency-probe.sh --stdout       # 只打屏幕，不落盘
#   tools/wkwebview-probe/editor-latency-probe.sh --force        # 允许覆盖已有的同名结果
#   ONLY="T-C" M1=0 tools/wkwebview-probe/editor-latency-probe.sh   # 只跑某几个测项（快）
#
# ⚠️ 与 `make bench` 同一条纪律：`benchmarks/results/` 是**历史记录**，默认**拒绝覆盖**。
#
# ⭐⭐ 本探针**不打扰用户**（用户铁律：「探测的时候，不要影响我的日常工作，不要反复弹窗」）：
#     ⛔ 不开可见窗口、⛔ 不抢前台、⛔ 不用 `osascript` / `System Events`、⛔ 不要辅助功能授权。
#     ✅ 一个进程跑完全部测项；窗口 `.accessory` + `.borderless` + `alphaValue = 0` + `orderBack`；
#       按键由探针自己造 `NSEvent` 直接送第一响应者。
#
# ⚠️ 首次运行不需要 npm：CM6 bundle 直接用**产品那份产物** `src/vendor/cm6.bundle.js`；
#    调度器直接用**产品那份源文件** `src/editor/preview.js`（⛔ 探针不另抄一份判据）。
#
# ⚠️⚠️ **它量得到什么、量不到什么**（判决写进结果里的 `计时边界`，这里只列一句）：
#     量得到：页面侧的 `keydown → CM6 update → rAF → rAF`；注入到页面 `keydown` 的墙钟差；
#             重渲期间键事件被推后多久（主线程那一段是**忙等真占**）。
#     量不到：真人按键时 HID → WindowServer → AppKit 那一段（合成事件绕过它）；
#             后端的真耗时（`render_preview` 要 Tauri IPC，这里是**按实测 Σ 模拟**的）；
#             IME 组合态（合成事件造不出）。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

TO_STDOUT=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --stdout) TO_STDOUT=1 ;;
    --force)  FORCE=1 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。这条探针需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 1
fi

BUNDLE="$ROOT/src/vendor/cm6.bundle.js"
if [ ! -s "$BUNDLE" ]; then
  echo "⛔ 没有 $BUNDLE —— 先跑 make cm6（要 node）。" >&2
  echo "   本探针用的是**产品那份产物**，⛔ 不是探针自己再打一份（那样量出来的不是产品的版本）。" >&2
  exit 1
fi
if [ ! -s "$ROOT/src/editor/preview.js" ]; then
  echo "⛔ 没有 src/editor/preview.js —— 这条探针要**产品那份调度器**（⛔ 不另抄一份判据）。" >&2
  exit 1
fi

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/editor-latency-${TODAY}-${MODEL}.json"

# ⚠️ 覆盖检查在**编译之前**：编译要几十秒，跑完才发现要拒绝等于白跑
if [ "$TO_STDOUT" != "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 1
fi

WORK="$(mktemp -d)"
# 调试用：`KEEP_WORK=1` 保留临时目录并打印路径（⛔ 默认删）
if [ -n "${KEEP_WORK:-}" ]; then
  trap 'echo "· WORK=${WORK}（KEEP_WORK=1，未删）" >&2' EXIT
else
  trap 'rm -rf "$WORK"' EXIT
fi
PAGE="$WORK/page"
mkdir -p "$PAGE"
cp "$BUNDLE" "$PAGE/bundle.js"
# ⭐⭐ 真的调度器：`src/editor/preview.js` 原样加载（⛔ 探针不复制它的判据）
cp "$ROOT/src/editor/preview.js" "$PAGE/preview.js"

# ── ⭐ 真表：从 Rust 的 `SHORTCUTS` 抽出来（⚠️ 只为让挂载形态与 0c 探针**逐条对齐**， ──
#    本探针只注入**无修饰键的单字符**，转发白名单结构上不会接走它们） ──
python3 -I - "$ROOT/src-tauri/src/gui/mod.rs" > "$PAGE/shortcuts.js" <<'PY'
import json, re, sys
src = open(sys.argv[1], encoding='utf-8').read()
consts = dict(re.findall(r'const\s+([A-Z_][A-Z0-9_]*)\s*:\s*&str\s*=\s*"([^"]*)"\s*;', src))
body = src.split('const SHORTCUTS: &[Shortcut] = &[', 1)[1].split('\n];', 1)[0]
rows = []
for blk in body.split('Shortcut {')[1:]:
    blk = blk.split('},', 1)[0]
    def f(name):
        m = re.search(name + r':\s*([^,\n]+)', blk)
        return m.group(1).strip() if m else None
    rid = f('id')
    if rid is None:
        continue
    rid = rid.strip('"') if rid.startswith('"') else consts.get(rid, rid)
    accel = (f('accel') or '').strip('"')
    m = re.search(r'aliases:\s*&\[([^\]]*)\]', blk)
    aliases = re.findall(r'"([^"]*)"', m.group(1)) if m else []
    rows.append({'id': rid, 'accel': accel, 'aliases': aliases,
                 'owner': 'menu' if 'Menu' in (f('owner') or '') else 'web'})
print('window.__SHORTCUTS_TABLE = ' + json.dumps(rows, ensure_ascii=False) + ';')
PY
cp "$ROOT/src/services/keymap.js" "$PAGE/keymap.js"
cp "$ROOT/src/editor/keys.js"     "$PAGE/editor-keys.js"

# ── 页面 ──
cat > "$PAGE/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>rmd · 0f 探针</title>
<style>
  html, body { margin: 0; height: 100%; background: #fff; }
  #wrap { display: flex; height: 100%; }
  #host { width: 600px; height: 100%; overflow: auto; font: 14px/1.7 ui-monospace, Menlo, monospace; }
  #pane { width: 600px; height: 100%; overflow: auto; border-left: 1px solid #ddd; }
  #pane .blk { height: 40px; box-sizing: border-box; border-bottom: 1px solid #eee; font: 12px/40px sans-serif; }
</style>
<div id="wrap"><div id="host"></div><div id="pane"></div></div>
<!-- ⚠️ 顺序是硬要求：bundle → preview → keymap → editor/keys（后者在**加载期**取 window.rmd.keymap）→ 表 -->
<script src="bundle.js"></script>
<script src="preview.js"></script>
<script src="keymap.js"></script>
<script src="editor-keys.js"></script>
<script src="shortcuts.js"></script>
<script>
(function () {
  'use strict';
  var S = window.__STATE = {
    ready: false, mount_error: null, ext: [],
    raf: 0, rafTs: [],
    冷启动定时器: null, 定时器: null,
    时钟自检: null,
    m1: { pending: null, queue: [] },
    m2: null, m3: null
  };

  var CM6 = window.rmdCM6;
  if (!CM6) { S.mount_error = 'rmdCM6 不在（bundle.js 没加载？）'; return; }
  var P = window.rmd && window.rmd.editorPreview;
  if (!P) { S.mount_error = 'window.rmd.editorPreview 不在（preview.js 没加载？）'; return; }

  var host = document.getElementById('host');
  var pane = document.getElementById('pane');

  // ⭐ 预览栏**一开始就装满**（⛔ 不留空）：E1 的"布局可滚"要拿它当判据，
  //   而产品里那块也从来不是空的。⚠️ M3 会整棵换掉它，换之前的内容不影响任何测项。
  (function () {
    var a = [];
    for (var i = 0; i < 400; i++) { a.push('<div class="blk" id="b' + i + '">块 ' + i + '</div>'); }
    pane.innerHTML = a.join('');
  })();

  // ── 文档：280 行，中文 + 粗体 + 行内代码 + 列表（够真实，⛔ 不靠大小——CM6 视口恒定）──
  var DOC = (function () {
    var out = ['# 0f 探针文档', ''];
    for (var i = 0; i < 40; i++) {
      out.push('## 第 ' + i + ' 节');
      out.push('');
      out.push('这是第 ' + i + ' 节的中文正文，混一些 **粗体** 与 `行内代码`，够长以便有点排版量。');
      out.push('');
      out.push('- 列表项 A' + i);
      out.push('- 列表项 B' + i);
      out.push('');
    }
    return out.join('\n');
  })();

  // ── rAF 计数（E1 的 rAF 节奏判据）──
  (function loop(t) { S.raf++; S.rafTs.push(t); requestAnimationFrame(loop); })(0);

  // ── ⭐ 冷启动那一轮定时器：**故意在热身之前**arm，用来复现"前 ~2.2 s 被节流"（kb/0022）──
  S.冷启动定时器 = (function () {
    var r = { t: {}, at: performance.now() };
    [50, 150, 300, 1000].forEach(function (ms) {
      var t0 = performance.now();
      setTimeout(function () { r.t[ms] = +(performance.now() - t0).toFixed(2); }, ms);
    });
    return r;
  })();

  // ── ⭐⭐ 真的转发扩展（与 0c 探针**逐条对齐**，白名单派生自 SHORTCUTS 真表）──
  var FORWARD = { 可用: false, 错误: null, specs: [], skipped: [], notes: [] };
  S.转发 = FORWARD;
  var forwardExt = null;
  (function () {
    var KM = window.rmd && window.rmd.keymap;
    var EK = window.rmd && window.rmd.editorKeys;
    var TBL = window.__SHORTCUTS_TABLE || [];
    if (!KM) { FORWARD.错误 = 'window.rmd.keymap 不在'; return; }
    if (!EK) { FORWARD.错误 = 'window.rmd.editorKeys 不在'; return; }
    if (!TBL.length) { FORWARD.错误 = 'SHORTCUTS 表为空（抽表失败）'; return; }
    try {
      var d = EK.deriveWhitelist(TBL);
      FORWARD.specs = d.specs.map(function (r) { return r.id + '：' + r.accel + ' → ' + r.spec; });
      FORWARD.skipped = d.skipped.map(function (r) { return r.id + '（' + r.why + '）'; });
      FORWARD.notes = d.notes.map(function (r) { return r.id + '（' + r.why + '）'; });
      var shim = EK.createForwardShim();
      var km = KM.createKeymap({ table: TBL, ctx: shim.ctx });
      d.specs.forEach(function (row) { km.register(row.id, function () { return true; }); });
      shim.bind(km);
      forwardExt = EK.buildBindings(CM6, d.specs, shim.forward);
      FORWARD.可用 = true;
    } catch (e) { FORWARD.错误 = String((e && e.message) || e); }
  })();

  // ── ⭐⭐ 键入→绘制的四段：`keydown → CM6 update → rAF → rAF` ──
  //    ⚠️ 两次 rAF：CM6 的 `updateListener` 在**事务落地之后、DOM 写好之前**触发，
  //       所以"下一次绘制"要用**再下一次** rAF 当代理（第一次 rAF 可能还在同一帧里）。
  //       ⛔ 它仍然**不是**"像素真的上屏了"——那是浏览器的合成器，页面侧看不到。
  function 圆(x) { return x == null ? null : +x.toFixed(2); }

  function finishM1(p) {
    return {
      key: p.key, code: p.code,
      'keydown→update': 圆(p.tUpdate - p.t0),
      'update→rAF1': 圆(p.tRaf1 - p.tUpdate),
      'rAF1→rAF2': 圆(p.tRaf2 - p.tRaf1),
      'keydown→paint': 圆(p.tRaf2 - p.t0),
      '页面keydown墙钟': p.wall == null ? null : +p.wall.toFixed(2)
    };
  }

  // ⚠️ capture 阶段：CM6 自己也会听 `keydown`，capture 保证我们先拿到。
  window.addEventListener('keydown', function (ev) {
    var now = performance.now();
    if (S.m2 && S.m2.onKey) { S.m2.onKey(now, ev); return; }
    var p = S.m1.pending;
    if (!p || p.t0 !== null) return;
    p.t0 = now; p.key = ev.key; p.code = ev.code;
    p.alt = ev.altKey; p.ctrl = ev.ctrlKey; p.meta = ev.metaKey;
    p.wall = performance.timeOrigin + now;      // ⭐ 高精度墙钟（给"注入→页面"那座桥用）
  }, true);

  var m1 = S.m1;
  window.__M1_BEGIN = function (id) {
    m1.pending = { id: id, t0: null, tUpdate: null, tRaf1: null, tRaf2: null,
                   wall: null, key: null, code: null };
    m1.queue = [];
    return id;
  };
  window.__M1_POP = function () { if (!m1.queue.length) return null; var r = m1.queue[0]; m1.queue = []; return r; };
  window.__M1_PENDING = function () { return m1.pending ? m1.pending.id : null; };

  var EXT_LIST = ['EditorView.lineWrapping', 'lineNumbers()', 'history()',
                  'keymap.of(historyKeymap)', 'markdown()', 'EditorView.updateListener'];
  S.ext = EXT_LIST.concat([forwardExt ? 'editor/keys.js::buildBindings（真转发扩展）'
                                      : '⛔ 转发扩展没装上（' + FORWARD.错误 + '）']);
  var exts = [
    CM6.EditorView.lineWrapping,
    CM6.lineNumbers(),
    CM6.history(),
    CM6.keymap.of(CM6.historyKeymap),
    CM6.markdown(),
    CM6.EditorView.updateListener.of(function (u) {
      if (!u.docChanged) return;
      var t = performance.now();
      // ⭐ M2 期间：每次文档变更都喂给**真的**调度器（`markEdited` 是它唯一的入口）
      if (S.m2 && S.m2.onEdit) { S.m2.onEdit(t); return; }
      // M1：等这一条键的"下一次绘制"
      var p = m1.pending;
      if (!p || p.t0 === null || p.tUpdate !== null) return;
      p.tUpdate = t;
      requestAnimationFrame(function (r1) {
        p.tRaf1 = r1;
        requestAnimationFrame(function (r2) {
          p.tRaf2 = r2;
          m1.queue.push(finishM1(p));
          m1.pending = null;
        });
      });
    })
  ];
  if (forwardExt) exts.push(forwardExt);
  var state = CM6.EditorState.create({ doc: DOC, extensions: exts });
  var view = new CM6.EditorView({ state: state, parent: host });
  view.dispatch({ selection: { anchor: 0 } });
  view.focus();

  // ── E1：环境判别器（rAF 节奏 + 定时器保真 + 布局）──
  window.__ENV_TIMERS = function () {
    var r = { t: {}, at: performance.now() };
    [50, 150, 300, 1000].forEach(function (ms) {
      var t0 = performance.now();
      setTimeout(function () { r.t[ms] = +(performance.now() - t0).toFixed(2); }, ms);
    });
    S.定时器 = r;
    return r.at;
  };
  window.__ENV = function () {
    var ts = S.rafTs, n = ts.length, last = n ? ts[n - 1] : 0, win = [];
    for (var i = n - 1; i >= 0; i--) { if (last - ts[i] > 1000) break; win.push(ts[i]); }
    win.reverse();
    var gaps = [];
    for (var j = 1; j < win.length; j++) gaps.push(+(win[j] - win[j - 1]).toFixed(2));
    var sorted = gaps.slice().sort(function (a, b) { return a - b; });
    var med = sorted.length ? sorted[sorted.length >> 1] : -1;
    S.时钟自检 = 圆((performance.timeOrigin + performance.now()) - Date.now());
    return {
      rAF: { n: win.length, span: win.length ? +(win[win.length - 1] - win[0]).toFixed(1) : 0,
             中位间隔: med,
             最小: sorted.length ? sorted[0] : null,
             最大: sorted.length ? sorted[sorted.length - 1] : null,
             总回调数: S.raf },
      定时器: S.定时器 ? S.定时器.t : null,
      定时器_冷启动那轮: S.冷启动定时器 ? S.冷启动定时器.t : null,
      布局: { scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight,
              host_scrollHeight: host.scrollHeight, host_clientHeight: host.clientHeight },
      时钟自检ms: S.时钟自检,
      可见性: { visibilityState: document.visibilityState, hidden: document.hidden,
                hasFocus: document.hasFocus() },
      页面存活秒: 圆(performance.now() / 1000)
    };
  };

  // ── M2：连续输入期间的预览调度（⭐ 用**真的** preview.js）──
  function 忙等(ms) { var t0 = performance.now(); while (performance.now() - t0 < ms) { /* spin */ } }

  window.__M2_SETUP = function (id, backendMs, blockMs, initialMs) {
    var m2 = S.m2 = {
      id: id, backendMs: backendMs, blockMs: blockMs, initialMs: initialMs,
      onKey: null, onEdit: null, _note: null, t0: 0,
      keys: [], edits: [], renders: [], stale: [], manual: [], sched: null
    };
    m2.sched = P.createScheduler({
      render: function (req) {
        var t0 = performance.now();
        return new Promise(function (resolve) {
          // ① 非主线程那一段（`T2 + T3 + r`）：真异步，⛔ 不占主线程
          setTimeout(function () {
            var b0 = performance.now();
            // ② ⭐⭐ 主线程那一段（`T5` 注入 + `T5b` 强制布局）：**忙等真占**
            //    ⚠️ 生产里这里是 `mountDocument` 的 `innerHTML` + `offsetHeight`，
            //       结构上不可能是异步的（§2.6-1）⇒ 用忙等模拟**机制**，时长照实测填。
            忙等(m2.blockMs);
            var t1 = performance.now();
            m2.renders.push({
              req: req,
              '起点ms': 圆(t0 - m2.t0),
              '终点ms': 圆(t1 - m2.t0),
              '非主线程段ms': 圆(b0 - t0),
              '主线程段ms': 圆(t1 - b0),
              '总ms': 圆(t1 - t0),
              '回给调度器的ms': backendMs
            });
            resolve({ ms: backendMs });
          }, Math.max(0, backendMs - blockMs));
        });
      },
      onStale: function (stale, tier) {
        m2.stale.push({ 'atMs': 圆(performance.now() - m2.t0), stale: stale, tier: tier });
      },
      initialMs: initialMs
    });
    return { id: id, 起始档位: m2.sched.tier(), 后端ms: backendMs, 主线程段ms: blockMs };
  };

  window.__M2_START = function () {
    var m2 = S.m2;
    m2.onKey = null; m2.onEdit = null;          // ⚠️ 复位那一次 dispatch 不算击键
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: DOC } });
    view.focus();
    m2.keys = []; m2.edits = []; m2.renders = []; m2.stale = []; m2.manual = [];
    m2.t0 = performance.now();
    // ⚠️⚠️ 页面**只记自己知道的那一半**（keydown 被处理的高精度时刻）。
    //    原生那一半（注入墙钟）由 Swift 在**注入当时**记下、collect 时按**序号**配回来。
    //    ⛔ 早先的写法是注入前先 `evaluateJavaScript(__M2_NOTE)` 把墙钟塞进页面——
    //    那条路**在忙等期间会卡死**（WebContent 主线程正忙，evaluateJavaScript 排在后面），
    //    ⇒ 注入循环本身被冻住 ⇒ **正好在最该采样的那 413 ms 里停止注入**，
    //    实测"撞上的键"只剩 1 个。2026-10-16 实测踩过（见下 `__M2_COLLECT` 的说明）。
    m2.onKey = function (now, ev) {
      m2.keys.push({
        '序号': m2.keys.length,
        key: ev.key,
        '页面ms': 圆(now - m2.t0),
        '页面墙钟': +(performance.timeOrigin + now).toFixed(2)
      });
    };
    m2.onEdit = function (now) { m2.edits.push(圆(now - m2.t0)); m2.sched.markEdited(); };
    return 圆(m2.t0);
  };

  // ⚠️ 由 Swift 在**全部注入完之后**调（页面这时是空的，不存在被忙等挡住的问题）。
  //    `注入` = `[[key, 原生墙钟], …]`，按注入顺序。⭐ 配对靠**序号**——
  //    页面记 keydown 的顺序与 Swift 注入的顺序是同一个顺序。
  //    ⚠️ 但配对**不能假定一定对得上**：丢一个 keydown 就会让后面全体错位。
  //    ⇒ 逐条比 `key` 字面，把第一个不匹配的序号与前后各一条**如实报出来**，
  //      ⛔ 不"跳过坏的继续配"（那会把错位洗成一份看着完整的表）。
  window.__M2_COLLECT = function (注入) {
    var m2 = S.m2;
    m2.onKey = null; m2.onEdit = null;
    var 注入表 = [];
    try { 注入表 = JSON.parse(注入 || '[]'); } catch (e) { 注入表 = []; }

    var 首个不匹配 = null;
    for (var i = 0; i < m2.keys.length; i++) {
      var k = m2.keys[i];
      var w = i < 注入表.length ? 注入表[i] : null;
      k['注入墙钟'] = (w && typeof w[1] === 'number') ? +w[1].toFixed(2) : null;
      k['注入到页面ms'] = k['注入墙钟'] == null ? null : 圆(k['页面墙钟'] - k['注入墙钟']);
      if (w && w[0] !== k.key && 首个不匹配 === null) {
        首个不匹配 = { '序号': i, '注入的key': w[0], '页面记的key': k.key,
                      '上一条': i > 0 ? { '注入': 注入表[i - 1][0], '页面': m2.keys[i - 1].key } : null };
      }
      // ⚠️ 判据是**"撞在主线程忙等里"**，⛔ 不是"落在整个重渲窗口里"——
      //    后者把 `T2+T3+r` 那一段真异步的等待也算进去了，那段时间键是**照常处理**的。
      var 撞 = null;
      for (var j = 0; j < m2.renders.length; j++) {
        var r = m2.renders[j];
        var 忙起 = r['起点ms'] + r['非主线程段ms'];
        if (k['页面ms'] >= 忙起 && k['页面ms'] <= r['终点ms']) {
          撞 = { '哪次': j, '忙段ms': [忙起, r['终点ms']],
                '块剩余ms': 圆(r['终点ms'] - k['页面ms']) };
          break;
        }
      }
      k['撞在主线程忙等里'] = !!撞;
      k['撞在哪'] = 撞;
    }

    var 撞里 = m2.keys.filter(function (k) { return k['撞在主线程忙等里']; });
    var 桥 = m2.keys.map(function (k) { return k['注入到页面ms']; }).filter(function (v) { return v != null; });
    var lastKey = m2.keys.length ? m2.keys[m2.keys.length - 1]['页面ms'] : null;
    return {
      id: m2.id, 后端ms: m2.backendMs, 主线程段ms: m2.blockMs, 起始判据: m2.initialMs,
      '档位_起始': P.tierFor(m2.initialMs),
      '档位_收工时': m2.sched.tier(),
      '调度器记的重渲次数': m2.sched.renders(),
      '本探针记的重渲次数': m2.renders.length,
      '击键数': m2.keys.length,
      '注入数': 注入表.length,
      '配对': { '键数': m2.keys.length, '注入数': 注入表.length,
               '配上几个': Math.min(m2.keys.length, 注入表.length),
               '首个不匹配': 首个不匹配 },
      '文档变更数': m2.edits.length,
      '最后一次击键ms': lastKey,
      '第一次重渲起点ms': m2.renders.length ? m2.renders[0]['起点ms'] : null,
      '末次击键到首次重渲ms': (m2.renders.length && lastKey !== null)
        ? 圆(m2.renders[0]['起点ms'] - lastKey) : null,
      '两次重渲间隔ms': m2.renders.length > 1
        ? m2.renders.map(function (r, i) { return i ? 圆(r['起点ms'] - m2.renders[i - 1]['起点ms']) : null; }).slice(1)
        : [],
      '撞在重渲里的击键数': 撞里.length,
      '撞里的键_注入到页面ms': 撞里.map(function (k) { return k['注入到页面ms']; }),
      '全部键_注入到页面ms': 桥,
      '陈旧事件数': m2.stale.length,
      '陈旧': m2.stale,
      '手动触发': m2.manual,
      '重渲': m2.renders,
      '击键': m2.keys,
      'seq': { edit: m2.sched._editSeq(), render: m2.sched._renderSeq(), stale: m2.sched.stale() }
    };
  };

  // ⛔ **已废弃**：先注入墙钟再注入按键那条路会在忙等期间卡死（见 `__M2_START` 的说明）。
  //    留着只是让老调用点**立刻看得见**——它现在恒返回 false。
  window.__M2_NOTE = function () { return false; };

  window.__M2_MANUAL = function (nativeWall) {
    var m2 = S.m2;
    m2.manual.push({ '调用ms': 圆(performance.now() - m2.t0), '注入墙钟': nativeWall });
    m2.sched.requestNow();
    return true;
  };

  // ── M3：滚动位置变化（⭐ 量的是"浏览器事实"，⛔ 不是把产品规则再实现一遍）──
  window.__M3_RUN = function () {
    var 块高 = 40;
    // ⚠️⚠️ 判据必须是"**旧顶块**换完之后跑到哪去了"，⛔ **不是**"换完之后顶端是哪个块"。
    //    第一版量的是后者，而它恒等于 0（`原 scrollTop / 块高` 是整数 ⇒ 顶端块永远贴在
    //    视口上沿）⇒ 三次都报"漂移 0 px"，**看起来像"位置法没有漂移"**，是个假绿。
    //    真实漂移只能靠**追一个具体的块**才看得见。2026-10-16 实测踩过。
    var 参考 = 'b100';            // 前后两版都存在的那个块
    // ⚠️ 4023 = 不是块高的整数倍（⛔ 免得"贴在上沿"这种退化形态把判据掩盖掉）
    var 起点 = 4023;

    function fill(n, off) {
      var a = [];
      for (var i = 0; i < n; i++) {
        a.push('<div class="blk" id="b' + (i + off) + '">块 ' + (i + off) + '</div>');
      }
      return a.join('');
    }
    function 参考块偏移() {
      var el = pane.querySelector('#' + 参考);
      if (!el) return null;
      return 圆(el.getBoundingClientRect().top - pane.getBoundingClientRect().top);
    }
    function 顶端块() {
      var pr = pane.getBoundingClientRect();
      var kids = pane.children;
      for (var i = 0; i < kids.length; i++) {
        var r = kids[i].getBoundingClientRect();
        if (r.bottom > pr.top + 0.5) return { id: kids[i].id, offset: 圆(r.top - pr.top) };
      }
      return null;
    }
    function 最大滚() { return Math.max(0, pane.scrollHeight - pane.clientHeight); }
    function 现状() {
      return { top: 圆(pane.scrollTop), 最大滚: 圆(最大滚()), 顶端: 顶端块(),
               参考块偏移: 参考块偏移() };
    }
    function 装(html, top) { pane.innerHTML = html; pane.scrollTop = top; return 现状(); }

    var out = { 块高px: 块高, 视口高px: pane.clientHeight, 参考块: 参考, 起点scrollTop: 起点, 步: {} };

    // ⓞ **浏览器基线**：只换 `innerHTML`、什么都不补 ⇒ `scrollTop` 会怎样？
    //    ⚠️ 这一问回答的是"keepScroll 为什么存在"（⛔ 不是产品规则）。
    (function () {
      var 前 = 装(fill(400, 0), 起点);
      pane.innerHTML = fill(400, 0);      // 同一份内容，整棵换掉
      out.步['ⓞ_只换innerHTML'] = {
        换前: 前, 换后: 现状(), 参考块漂移: 圆(参考块偏移() - 前.参考块偏移),
        说明: '内容不变、整棵 innerHTML 换掉 ⇒ 看浏览器自己把 scrollTop 放哪'
      };
    })();

    // ⓐ **位置法**（⭐ 产品预览路径 `keepScroll` 的做法）：`min(prevTop, maxScroll)`
    (function () {
      var 前 = 装(fill(400, 0), 起点);
      var t0 = performance.now();
      pane.innerHTML = fill(6, 9000) + fill(400, 0);   // 上方插 6 块 = 240 px
      var t1 = performance.now();
      var sh = pane.scrollHeight;                       // ⭐ 读它 ⇒ 强制布局
      var t2 = performance.now();
      pane.scrollTop = Math.min(前.top, 最大滚());
      var t3 = performance.now();
      var 后 = 现状();
      out.步['ⓐ_位置法'] = {
        换前: 前, 换后: 后,
        上方插入块数: 6, 上方插入px: 240,
        参考块漂移px: 圆(后.参考块偏移 - 前.参考块偏移),
        t_换innerHTML: 圆(t1 - t0), t_读scrollHeight: 圆(t2 - t1), t_写scrollTop: 圆(t3 - t2)
      };
    })();

    // ⓑ **锚点法**（⭐ 阅读路径三级锚点的第①级：把旧顶块推回原偏移）
    (function () {
      var 前 = 装(fill(400, 0), 起点);
      pane.innerHTML = fill(6, 9000) + fill(400, 0);
      pane.scrollTop = 前.top + 240;                    // 旧顶块回到原位
      var 后 = 现状();
      out.步['ⓑ_锚点法'] = {
        换前: 前, 换后: 后,
        上方插入块数: 6, 上方插入px: 240,
        参考块漂移px: 圆(后.参考块偏移 - 前.参考块偏移),
        说明: '⭐ 对照组：不是产品预览路径的做法，用来量化 ⓐ 的漂移有多大'
      };
    })();

    // ⓒ **内容收缩 ⇒ 位置法被 maxScroll 夹住**，⚠️ 且**参考块整个消失了**
    //    ⇒ 这正是阅读路径那条"三级锚点（标题 id → 比例 → 回顶部且必须提示）"的由来。
    (function () {
      var 前 = 装(fill(400, 0), 9000);                  // 滚到接近底部
      pane.innerHTML = fill(50, 0);                     // 砍到 50 块
      pane.scrollTop = Math.min(前.top, 最大滚());
      var 后 = 现状();
      out.步['ⓒ_收缩夹住'] = {
        换前: 前, 换后: 后, 收缩后块数: 50,
        被夹住: 圆(前.top) > 圆(后.最大滚),
        参考块还在: pane.querySelector('#' + 参考) !== null,
        说明: '内容变短 ⇒ min(prevTop, maxScroll) 落在 maxScroll 上；⚠️ 参考块被删掉 ⇒ 锚点法的目标不存在'
      };
    })();

    return out;
  };

  S.ready = true;
})();
</script>
HTML

# ── 编译探针 ──
BIN="$WORK/editor-latency-probe"
echo "▶ 编译探针…" >&2
swiftc -O "$HERE/editor-latency-probe.swift" -o "$BIN" >"$WORK/build.log" 2>&1 || {
  echo "⛔ 编译失败：" >&2; cat "$WORK/build.log" >&2; exit 1
}

RAW="$WORK/raw.json"
ERR="$WORK/raw.err"

echo "▶ 跑探针（⚠️ 一个**不可见**窗口，无前台切换、无合成系统按键；约 45 秒）…" >&2
ONE=()
[ -n "${ONLY:-}" ] && ONE+=(--only "$ONLY")
[ -n "${M1:-}" ]   && ONE+=(--m1 "$M1")
"$BIN" --page "$PAGE" "${ONE[@]+"${ONE[@]}"}" >"$RAW" 2>"$ERR" &
pid=$!
# ⚠️ macOS **没有** `timeout(1)`：兜底超时由探针自己带（240 秒）＋ 这层 300 秒的看门狗。
for _ in $(seq 1 600); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$pid" 2>/dev/null; then
  echo "⛔ 300 秒没结束，强杀。" >&2
  kill -9 "$pid" 2>/dev/null || true
  exit 1
fi
wait "$pid" 2>/dev/null || true

if ! grep -q '^{' "$RAW" 2>/dev/null; then
  echo "⛔ 探针没产出 JSON。stderr：" >&2
  sed -n '1,40p' "$ERR" >&2
  exit 1
fi
[ -s "$ERR" ] && sed -n '1,20p' "$ERR" >&2 || true

python3 -I - "$RAW" "$TO_STDOUT" "$OUT" "$MODEL" "$TODAY" <<'PY'
import json, sys

raw_path, to_stdout, out, model, today = sys.argv[1:6]
_t = open(raw_path, encoding="utf-8").read()
raw = json.loads(_t[_t.index("{"):])

def 分位(xs, q):
    xs = sorted([x for x in xs if isinstance(x, (int, float))])
    if not xs: return None
    i = min(len(xs) - 1, max(0, int(round(q * (len(xs) - 1)))))
    return xs[i]

# ── M1 统计（⚠️ 分位只在**这一层**算：探针只负责逐条记录，⛔ 不自己聚合）──
m1 = raw.get("M1_键入到绘制") or {}
recs = m1.get("记录") or []
spans = ["keydown→update", "update→rAF1", "rAF1→rAF2", "keydown→paint"]
m1统计 = {}
for sp in spans:
    xs = [r.get(sp) for r in recs if isinstance(r.get(sp), (int, float))]
    m1统计[sp] = {"n": len(xs), "min": min(xs) if xs else None,
                  "p50": 分位(xs, 0.5), "p90": 分位(xs, 0.9),
                  "max": max(xs) if xs else None}
m1["统计"] = m1统计
# ⭐ **注入→页面 keydown** 那座桥：每个键自己的（页面高精度墙钟 − 原生注入墙钟）。
#    ⚠️ 两端来自**两个进程的墙钟** ⇒ 只读"被推后的键 vs 基线"之差，⛔ 不读绝对值。
#    ⛔ 它不含 HID → WindowServer 那一段（合成事件绕过它）。
#    ⚠️⚠️ 要挂到 `m1统计` 上（⭐ 那才是导出出去的那一个）；挂到 `m1` 上会**静默丢失**——
#       2026-10-16 实测踩过：外层导出的是 `m1统计`，`m1` 只是它的原始记录。
桥m1 = [round(r["页面keydown墙钟"] - r["原生注入墙钟"], 2) for r in recs
       if isinstance(r.get("页面keydown墙钟"), (int, float))
       and isinstance(r.get("原生注入墙钟"), (int, float))]
m1统计["注入到页面keydown_统计"] = {
    "n": len(桥m1), "min": min(桥m1) if 桥m1 else None,
    "p50": 分位(桥m1, 0.5), "p90": 分位(桥m1, 0.9),
    "max": max(桥m1) if 桥m1 else None,
    "怎么读": "基线，用来给 M2 的'被推后'当参照；⛔ 不读它的绝对值（两进程时钟）",
}

# ── M2 汇总（跨测项：把"**被推后**的键"单独拎出来）──
m2 = raw.get("M2_连续输入期间的预览调度") or {}
m2记录 = m2.get("记录") or {}
m2汇总 = {}
for cid, rec in sorted(m2记录.items()):
    if not isinstance(rec, dict):
        m2汇总[cid] = {"⛔": "记录不是对象"}; continue
    # ⚠️ 分组要按**每键自己的布尔标记**来分，⛔ 别按"值在不在另一张表里"——
    #    按值分会在两键桥值恰好相等时把没撞的那个**误删**（形态正确、数字悄悄少一个）。
    keys = rec.get("击键") or []
    # ⚠️⚠️ 分档**按"被推后了多少"**，⛔ 不是按"keydown 落在忙等窗口内"。
    #    实测（T-B-resume）：4 个键在忙等期间被注入（1991/2042/2093/2146 ms），
    #    全都在块结束的**那一瞬**（2190–2197 ms）被一起处理 ⇒ 桥值是
    #    **198.7 / 150.4 / 102.1 / 51.4** 的等差数列，每一项恰好等于"块的剩余时间"。
    #    ⚠️ 而"落在窗口内"这个判据只认到其中 1 个——另外 3 个的 keydown 时刻**在窗口之后**
    #    （排队排到块结束之后才派发），会被判成"没撞"。**判据错了，不是现象没有。**
    #    ⇒ 现在只问桥值大小：正常 ≈ 0（本机 p50 −0.8，量化 1 ms），> 10 ms 一律算被推后。
    对 = [(k.get("页面ms"), k["注入到页面ms"], k) for k in keys
          if isinstance(k.get("注入到页面ms"), (int, float))]
    推后判据 = 12
    基线 = [b for _, b, _ in 对 if b < 推后判据]
    # ⭐ 忙等段的**终点**：被积压的键就是在它那一刻被一起放出来的。
    忙终 = [(r["起点ms"] + r["非主线程段ms"], r["终点ms"]) for r in (rec.get("重渲") or [])]

    def 挨着忙终(页面ms):
        # ⚠️ 窗口取 [终点 − 8, 终点 + 40]：键在终点那一刻或紧随其后被派发。
        #    上界 40 ms 是"一次 flush 里能塞下几个键"的余量，⛔ 不是给"慢慢变慢"留的余地。
        for _, 终 in 忙终:
            if 终 - 8 <= 页面ms <= 终 + 40:
                return 终
        return None

    # ⚠️⚠️ 判据**必须两条件同时成立**：
    #    ① 桥值 ≥ `推后判据`（12 ms）——本机 7 个测项 × 近 30 键的**基线 max 只有 3.13 ms**，
    #       12 ms 有约 4 倍余量；② 该键的处理时刻**挨着某次忙等的终点**。
    #    ⛔ 只看①会把**页面冷启动**那一下当成"被重渲推后"：实测 T-A/T-A→B 的第 11 号键
    #       都有 10 ms 的桥值，而它们的首次重渲在 **3300 ms 之后**——因果上根本够不着。
    #    2026-10-16 实测踩过（第一版就是只看①）。
    被推 = sorted([(p, b, 挨着忙终(p)) for p, b, _ in 对
                   if b >= 推后判据 and 挨着忙终(p) is not None])
    桥 = [b for _, b, _ in 对]

    def 档(xs):
        return {"n": len(xs), "min": min(xs) if xs else None,
                "p50": 分位(xs, 0.5) if xs else None, "max": max(xs) if xs else None}

    推后px = 分位([b for _, b, _ in 被推], 0.5) if 被推 else None
    推后 = round(推后px) if 推后px is not None else None
    # ⭐ 被推后的那几个键是在**什么时候**被页面处理的：全都挤在块结束那一刻 ⇒ 跨度很小。
    #    跨度小 = "一起补上"，跨度大 = 分散着慢。
    flush = None
    if len(被推) > 1:
        ps = [p for p, _, _ in 被推]
        flush = {"首个被推后的键_页面ms": ps[0], "最后一个_页面ms": ps[-1],
                 "跨度ms": round(ps[-1] - ps[0]),
                 "说明": "跨度远小于各键的注入间隔之和 ⇒ 是**积压后一起补上的**，⛔ 不是逐个变慢"}
    m2汇总[cid] = {
        "起始档位": rec.get("档位_起始"),
        "收工档位": rec.get("档位_收工时"),
        "调度器记的重渲次数": rec.get("调度器记的重渲次数"),
        "击键数": rec.get("击键数"),
        "文档变更数": rec.get("文档变更数"),
        "末次击键到首次重渲ms": rec.get("末次击键到首次重渲ms"),
        "两次重渲间隔ms": rec.get("两次重渲间隔ms"),
        "陈旧事件数": rec.get("陈旧事件数"),
        "手动触发次数": len(rec.get("手动触发") or []),
        "重渲": rec.get("重渲"),
        "注入到页面ms_全体": 档(桥),
        "注入到页面ms_基线（<%d）" % 推后判据: 档(基线),
        "⭐_被推后的键": {"n": len(被推), "p50": 推后,
                     "max": round(max(b for _, b, _ in 被推)) if 被推 else None,
                     "判据": "桥值 ≥ %d ms **且** 处理时刻挨着某次忙等终点（两条件缺一不可）" % 推后判据},
        "被推后的键_各自(页面ms, 推后ms, 挨着哪次忙等的终点)": [[p, round(b), 终] for p, b, 终 in 被推],
        "被推后的键_何时被处理": flush,
        "推后怎么算": "桥值 ≥ %d ms 且挨着忙等终点；它们的 p50 就是'打字被卡住多久'。"
                  "⛔ 不读桥的绝对值（两进程时钟偏差：基线 p50 约 −0.4 ms）" % 推后判据,
        "配对": rec.get("配对"),
        "seq": rec.get("seq"),
    }
m2["汇总"] = m2汇总

# ── 判据（⭐ 与 .swift 里那份**同源同义**，⛔ 不是另立一套）──
判 = raw.get("E1_判定") or {}
可用 = 判.get("可用") is True
结 = []
结.append(("E1 环境自证", "✅ 通过" if 可用 else "⛔ 不通过 ⇒ 后面的数字一律无结论"))
if 可用:
    st = m1统计.get("keydown→paint") or {}
    结.append(("M1 键到达", "✅ %d/%d 条拿到记录" % (st.get("n") or 0, (m1.get("测了几个键") or 0) + (m1.get("没拿到的键数") or 0))))
    if st.get("n"):
        结.append(("M1 键入到下次绘制（页面侧）", "p50 **%s ms**（min %s / max %s），同一批的 keydown→CM6 更新 p50 %s ms" % (
            st.get("p50"), st.get("min"), st.get("max"),
            (m1统计.get("keydown→update") or {}).get("p50"))))
        结.append(("⛔ M1 的计时边界", "**不含** HID→WindowServer→AppKit 那一段（合成事件绕过），也**不是**'像素上屏'；它是页面侧的下界"))
    for cid, s in sorted(m2汇总.items()):
        if "⛔" in s: continue
        推 = s.get("⭐_被推后的键") or {}
        到首渲 = s["末次击键到首次重渲ms"]
        到首渲说 = ("负值 ⇒ 首渲发生在末次击键**之前** %s ms（多段形态的正常形状）" % abs(到首渲)
                    if isinstance(到首渲, (int, float)) and 到首渲 < 0 else "%s ms" % 到首渲)
        推语 = ("⭐ 打字被推后 **%s 个键**（p50 %s ms、最长 %s ms）" % (推.get("n"), 推.get("p50"), 推.get("max"))
                if 推.get("n") else "⛔ 没有键被推后")
        结.append(("M2 %s" % cid, "档 %s→%s，自动重渲 %s 次，末次击键到首渲 %s；%s" % (
            s["起始档位"], s["收工档位"], s["调度器记的重渲次数"], 到首渲说, 推语)))
        冲 = s.get("被推后的键_何时被处理")
        if 冲:
            结.append(("M2 %s 积压形状" % cid, "%s ⇒ %s" % (
                "、".join("页面%s/推后%s" % (p, b) for p, b, _ in (s.get("被推后的键_各自(页面ms, 推后ms, 挨着哪次忙等的终点)") or [])), 冲["说明"])))
        配 = s.get("配对") or {}
        if 配.get("首个不匹配"):
            结.append(("⛔ M2 %s 配对" % cid,
                      "注入表与 keydown **没对齐**（%s）⇒ 这一测项的'注入到页面ms'全部作废" % 配["首个不匹配"]))
    m3 = raw.get("M3_滚动位置变化") or {}
    步 = m3.get("步") or {}
    if "ⓐ_位置法" in 步 and "ⓑ_锚点法" in 步:
        结.append(("M3 漂移", "追同一块：位置法 %s px vs 锚点法 %s px（上方插 240 px）" % (
            步["ⓐ_位置法"]["参考块漂移px"], 步["ⓑ_锚点法"]["参考块漂移px"])))

封 = {
    "回答": "design/0012 §7 步骤 0f：键入→绘制的延迟 / 连续输入期间的预览调度 / 滚动位置变化",
    "机型": model,
    "日期": today,
    "环境": {
        "怎么跑的": "不可见窗口（alphaValue=0 + orderBack + .accessory），进程内 NSEvent 注入，**一个进程跑完全部测项**",
        "⛔_不打扰用户": ["不开可见窗口", "不抢前台（⛔ 从不 NSApp.activate）",
                        "不用 osascript / System Events", "不要辅助功能授权"],
        "热身": "3 秒（⚠️ 不可见窗口的计时可信度**靠 E1 自证、⛔ 不靠这条断言**，见 kb/0022）",
        "CM6": "src/vendor/cm6.bundle.js（**产品那份产物**）",
        "调度器": "src/editor/preview.js（**产品那份源文件**，⛔ 未复制判据）",
        "后端": "⛔ **模拟**：Σ 取自已实测的分项（§2.6-2-2），逐测项出处见 M2 的 出处 一栏；⭐ 主线程那一段用忙等**真占**",
        "计时口径": "页面侧 performance.now()，单位 ms；⚠️ 本机 WebKit 把时钟粗化到 1 ms（<1 读作不到一个刻度）",
    },
    "怎么读": [
        "⭐ M1 的 'keydown→paint' = keydown → CM6 update → rAF → rAF，是'键入到下一次绘制'的**页面侧代理**",
        "⛔ 它 **不含** 真人按键时 HID → WindowServer → AppKit 那一段（合成事件绕过它）",
        "⛔ 它 **不是**'像素真的上屏了'（合成器在页面侧看不到）",
        "⚠️ '注入→页面 keydown' 那座桥跨**两个进程的墙钟** ⇒ 本机实测有约 −0.5 ms 系统偏差、1 ms 量化",
        "   ⇒ ⛔ **不读桥的绝对值**，只读「被推后的那些键」的桥值（它们跟基线差了几十上百 ms，远超偏差）",
        "⭐⭐ M2 的 '⭐_被推后的键' = 桥值 ≥ 10 ms 的那些键（正常 ≈ 0）⇒ **这就是「打字被卡住多久」**",
        "   ⇒ 这就是 §2.6-1 那句'那期间输入是排队的'的直接量化：**打字被卡住多久**",
        "⚠️⚠️ 但**不是每个形态都撞得上**：防抖是**尾随**的 ⇒ 连着打的时候重渲根本还没开始",
        "   ⇒ T-A/T-B/T-C/T-B-floor 的'撞上 0 个'是在说'这个形态撞不上'，⛔ **别读成'不卡'**",
        "   ⭐ 真正会撞上的是 T-A-resume / T-B-resume：**停一下（触发重渲）→ 又接着打**",
        "⚠️ M3 量的是**浏览器事实**（换 innerHTML 之后 scrollTop 去哪、位置法/锚点法各漂多少），⛔ 不是把产品规则再实现一遍",
        "   ⭐ 判据是'**追的那个块**换完跑到哪去了'，⛔ 不是'换完之后顶端是哪个块'（后者恒为 0，是个假绿）",
    ],
    "结论": 结,
    "E1_判定": 判,
    "M1_统计": m1统计,
    "M2_汇总": m2汇总,
    "原始": raw,
}
txt = json.dumps(封, ensure_ascii=False, indent=2, sort_keys=False)
if to_stdout == "1":
    print(txt)
else:
    with open(out, "w", encoding="utf-8") as f:
        f.write(txt + "\n")
    print("· 结果写入 %s" % out)
    print("\n".join("  %s：%s" % (k, v) for k, v in 结))
PY
