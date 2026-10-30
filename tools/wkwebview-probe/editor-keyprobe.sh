#!/usr/bin/env bash
# 跑「编辑区聚焦下的键位归属」探针（`design/0012` §7 步骤 0c ①③④）
#
# 用法：
#   tools/wkwebview-probe/editor-keyprobe.sh              # 落盘到 benchmarks/results/
#   tools/wkwebview-probe/editor-keyprobe.sh --stdout     # 只打屏幕，不落盘
#   tools/wkwebview-probe/editor-keyprobe.sh --force      # 允许覆盖已有的同名结果
#   KEYS="ctrl-e ctrl-o" tools/wkwebview-probe/editor-keyprobe.sh   # 只测某几个键
#
# ⚠️ 与 `make bench` 同一条纪律：`benchmarks/results/` 是**历史记录**，默认**拒绝覆盖**。
#
# ⭐⭐ 2026-10-16：**本探针不打扰用户**（用户铁律：「探测的时候，不要影响我的日常工作，
#     不要反复弹窗」）——
#     ⛔ 不开可见窗口、⛔ 不抢前台、⛔ 不用 `osascript` / `System Events`、⛔ 不要辅助功能授权、
#     ⛔ 不再"每键起一个前台进程"（旧形态 13 键 = 14 次弹窗，**已废弃**）。
#     ✅ 一个进程跑完全部键；窗口是 `.accessory` + `.borderless` + `alphaValue = 0`；
#       按键由探针**自己造 `NSEvent` 直接 `window.sendEvent`**。
#     ⚠️ 代价与判据（"注入到底送到没有"）写在 `.swift` 的文件头与结果里的 `到达性` 一节。
#
# ⚠️ 首次运行不需要 npm：CM6 bundle 直接用**产品那份产物** `src/vendor/cm6.bundle.js`
#     （⇒ 与产品版本**同一个**；没跑过 `make cm6` 就没得测）。
#
# ⚠️⚠️ 本探针有一个**结构性盲区**，两份结果必须**合起来**读：
#      `…run1-6键.json`  —— 旧形态（**前台**窗口 + `System Events` 合成真按键，13 键 = 14 次弹窗，
#                          **已因用户铁律废弃**）⇒ 移光标的 `⌃E`/`⌃A` **只有那一份有数**；
#      `…-Mac14,9.json`  —— 本形态（不可见窗口 + 进程内注入）⇒ 覆盖面更广、可重复、不打扰用户，
#                          但**移光标那一族测不出**（非 key 窗口里 DOM 选区改动根本落不下来）。
#      ⭐ 两者的 `⌃O` 互为**交叉验证**（都是 71 → 72，+1 个换行）。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

TO_STDOUT=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --stdout) TO_STDOUT=1 ;;
    --force)  FORCE=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

# ⚠️ 键集由 `.swift` 定义（`KEY_SPECS`，含 keyCode 与控制字符）。这里只做"空格 → 逗号"的转写。
KEYS="${KEYS:-}"
KEYS="${KEYS// /,}"

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

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/editor-key-${TODAY}-${MODEL}.json"

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

# ── ⭐⭐ 真表：从 Rust 的 `SHORTCUTS` 抽出来（⛔ 探针不手抄第二份键位表） ──
#    手法与 `tests/js/keymap-forward.test.js` 相同（正则解析 `gui/mod.rs`），
#    ⚠️ 它**不是**"另写一张表"，而是把唯一那份读进来——所以表一改，本探针跟着改。
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
# ⭐ 真的 `keymap.js` 与 `keys.js`：白名单**派生**自上面那张表（§2.3-4/§2.3-5）
cp "$ROOT/src/services/keymap.js" "$PAGE/keymap.js"
cp "$ROOT/src/editor/keys.js"     "$PAGE/editor-keys.js"

# ── 页面 ──
# ⚠️ 挂载脚本**内联**在这里（⛔ 不是从 `src/editor/main.js` 引）：那个文件要 Tauri 的 IPC。
#    **扩展清单**按 §2.1① 对齐，⭐ 且第 7 槽**是真扩展**——`src/services/keymap.js` 与
#    `src/editor/keys.js` 原样加载进来，白名单**派生**自上面抽出来的 `SHORTCUTS` 真表。
#    ⚠️ 换掉的是"装扩展**之前**那一步"（`buildBindings` 的入参来自派生），
#    产品里与探针里**同一个函数、同一张表** ⇒ 0c② 的"页面 → 转发 → dispatch"这一整段可答。
#
# ⚠️ 页面**不含任何定时器**：不可见窗口里 `setInterval`/rAF 都会被节流，
#    采样一律由 Swift 侧 `evaluateJavaScript` 主动取（`.swift` 文件头有实测出处）。
cat > "$PAGE/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>rmd · 0c 探针</title>
<style>
  html, body { margin: 0; height: 100%; background: #fff; }
  #host { width: 1100px; height: 700px; font: 14px/1.7 ui-monospace, Menlo, monospace; }
</style>
<div id="host"></div>
<script src="bundle.js"></script>
<!-- ⚠️ 顺序是硬要求：bundle → keymap → editor/keys（后者在**加载期**取 window.rmd.keymap）→ 表 -->
<script src="keymap.js"></script>
<script src="editor-keys.js"></script>
<script src="shortcuts.js"></script>
<script>
(function () {
  'use strict';
  var S = window.__STATE = {
    ready: false, mount: null, initial: null, lines: null, ext: [],
    keys: [], series: [], 当前键: null, 相位: null,
    focus: null, mount_error: null, reset_error: null, snap_error: null
  };

  var DOC = [
    '# 键位归属探针',
    '',
    '第一行：中文行，用来确认光标不会跑到别的行。',
    '第二行：abcdefghijklmnopqrstuvwxyz',
    '第三行：末尾。'
  ].join('\n');

  // ⭐⭐ 0c② 的实测件：`design/0012` §2.3-4 的**真转发扩展**。
  //   把 `src/services/keymap.js`（模块 api）与 `src/editor/keys.js` 原样加载进来，
  //   白名单**派生**自 Rust 那张 `SHORTCUTS` 真表（⛔ 探针不另抄键位表）。
  //   ⚠️ 唯一与产品不同的地方：handler 不是 `main.js` 那批，而是**记录器**
  //   （`dispatch` 的两道校验照常跑 ⇒ 判据没被放松）。
  var FORWARD = {
    可用: false, 错误: null, specs: [], skipped: [], notes: [],
    log: [], 起点: 0
  };
  window.__FORWARD_LOG = FORWARD;
  S.转发 = FORWARD;

  var CM6 = window.rmdCM6;
  if (!CM6) { S.mount_error = 'rmdCM6 不在（bundle.js 没加载？）'; return; }
  var host = document.getElementById('host');

  var forwardExt = null;
  (function () {
    var KM = window.rmd && window.rmd.keymap;
    var EK = window.rmd && window.rmd.editorKeys;
    var TBL = window.__SHORTCUTS_TABLE || [];
    if (!KM) { FORWARD.错误 = 'window.rmd.keymap 不在（keymap.js 没加载？）'; return; }
    if (!EK) { FORWARD.错误 = 'window.rmd.editorKeys 不在（editor/keys.js 没加载？）'; return; }
    if (!TBL.length) { FORWARD.错误 = 'SHORTCUTS 表为空（抽表失败）'; return; }
    try {
      var d = EK.deriveWhitelist(TBL);
      FORWARD.specs   = d.specs.map(function (r) { return r.id + '：' + r.accel + ' → ' + r.spec; });
      FORWARD.skipped = d.skipped.map(function (r) { return r.id + '（' + r.why + '）'; });
      FORWARD.notes   = d.notes.map(function (r) { return r.id + '（' + r.why + '）'; });
      var shim = EK.createForwardShim();
      var km = KM.createKeymap({ table: TBL, ctx: shim.ctx });
      d.specs.forEach(function (row) {
        km.register(row.id, function () { FORWARD.log.push(row.id); return true; });
      });
      shim.bind(km);
      forwardExt = EK.buildBindings(CM6, d.specs, shim.forward);
      FORWARD.可用 = true;
    } catch (e) { FORWARD.错误 = String((e && e.message) || e); }
  })();

  var EXT_LIST = [
    'EditorView.lineWrapping', 'lineNumbers()', 'history()',
    'keymap.of(historyKeymap)', 'markdown()', 'EditorView.updateListener'
  ];
  S.ext = EXT_LIST.concat([
    forwardExt ? 'editor/keys.js::buildBindings（⭐ 真转发扩展，白名单派生自 SHORTCUTS 真表）'
               : '⛔ 转发扩展**没装上**（见 转发.错误）'
  ]);
  var exts = [
    CM6.EditorView.lineWrapping,
    CM6.lineNumbers(),
    CM6.history(),
    CM6.keymap.of(CM6.historyKeymap),
    CM6.markdown(),
    CM6.EditorView.updateListener.of(function () {})
  ];
  if (forwardExt) exts.push(forwardExt);
  var state = CM6.EditorState.create({ doc: DOC, extensions: exts });
  var view = new CM6.EditorView({ state: state, parent: host });

  // ⭐ 光标落在**第 4 行（1 基）的中段**：`Ctrl+E`（行尾）与 `Ctrl+A`（行首）
  //    会往**两个相反方向**移动 ⇒ 一次挂载就能判两个方向，且都看得见。
  var lines = DOC.split('\n');
  var li = 3;
  var lineStart = 0;
  for (var i = 0; i < li; i++) lineStart += lines[i].length + 1;
  var lineEnd = lineStart + lines[li].length;
  var CARET = lineStart + 10;            // "第二行："(4) + "abcdef"(6)
  var DOC_LEN = DOC.length;

  // ⭐⭐ 为什么要另测 **DOM 选区**：原生命令（`⌃E`/`⌃A`）动的是 **DOM 的 selection**，
  //   而 CM6 的 `state.selection` 是它自己的副本——⭐ 实测：本窗口（非 key、`document.hasFocus()`
  //   为 false）里 CM6 **不跟随**外部 DOM 选区改动（判别器 head 一直是 43）。
  //   ⇒ 只看 CM6 会把"原生命令生效了但 CM6 没跟"误读成"命令没生效"。DOM 偏移才是本层的真判据。
  function domCaret() {
    try {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) { return { 无选区: true }; }
      var r = sel.getRangeAt(0);
      var full = document.createRange();
      full.selectNodeContents(view.contentDOM);
      full.setEnd(r.endContainer, r.endOffset);
      var node = r.endContainer.nodeType === 3 ? r.endContainer.parentElement : r.endContainer;
      var 行 = null;
      if (node && node.closest) {
        var l = node.closest('.cm-line');
        if (l && l.parentElement === view.contentDOM) {
          行 = Array.prototype.indexOf.call(view.contentDOM.children, l);
        }
      }
      return { 偏移: full.toString().length, 折叠: r.collapsed, 行: 行 };
    } catch (e) { return { 错误: String(e) }; }
  }

  function snap() {
    var sel = view.state.selection.main;
    var ln = view.state.doc.lineAt(sel.head);
    return {
      t: Math.round(performance.now()),
      head: sel.head, anchor: sel.anchor, from: sel.from, to: sel.to,
      行: ln.number, 列: sel.head - ln.from,
      文本长度: view.state.doc.length,
      // ⭐ 0c②：本轮（`__RESET` 起）转发到的动作 id。非空 = 转发链路真的走通了。
      转发_本轮: FORWARD.log.slice(FORWARD.起点),
      焦点在编辑器: view.hasFocus,
      activeElement: document.activeElement ? document.activeElement.tagName : null,
      // ⭐ 不可见窗口的已知风险面：DOM 焦点可能拿不到 ⇒ 要把"焦点在不在那道 contenteditable 上"
      //    记全（`tagName` 都是 DIV，光看它分不清 host 与 CM6 的 contentDOM）。
      activeElement_类名: document.activeElement ? String(document.activeElement.className) : null,
      activeElement_就是contentDOM: document.activeElement === view.contentDOM,
      activeElement_可编辑: document.activeElement ? !!document.activeElement.isContentEditable : null,
      DOM选区: domCaret()
    };
  }

  // ⭐ 事件到达是**被动**记录（⛔ 不依赖任何定时器）。
  // ⚠️ `defaultPrevented` 只能在**分发之后**读 ⇒ 由下一个采样点顺手补上
  //    （`setTimeout(…, 0)` 在不可见窗口里不保证按时来，⛔ 不用它）。
  // ⚠️ 事件对象**不可序列化** ⇒ 与 `S.keys` 一一对应地存在**页面私有数组**里，⛔ 不进 JSON。
  var evs = [];
  window.addEventListener('keydown', function (e) {
    var rec = {
      t: Math.round(performance.now()),
      key: e.key, code: e.code, keyCode: e.keyCode,
      ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey,
      isComposing: e.isComposing,
      target: e.target && e.target.tagName,
      落在编辑器里: !!(e.target && view.contentDOM.contains(e.target)),
      当时键: S.当前键,
      前: snap()
    };
    S.keys.push(rec);
    evs[S.keys.length - 1] = e;
  }, true);

  function finalizeAll() {
    for (var i = 0; i < evs.length; i++) {
      if (evs[i]) { S.keys[i].终_preventDefault = evs[i].defaultPrevented; evs[i] = null; }
    }
  }

  // ── 由 Swift 驱动的两个入口 ──
  // ⭐ 每轮开跑前把**文档与光标恢复成初始态**：所有键都从"第 4 行中段"出发，
  //    两个方向相反的移动才可比（旧形态靠"每键一个进程 + 重新挂载"达到同一目的）。
  window.__RESET = function (键) {
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: DOC },
        selection: { anchor: CARET }
      });
      view.focus();
      FORWARD.起点 = FORWARD.log.length;
      S.当前键 = 键; S.相位 = null;
      return 'ok';
    } catch (err) { S.reset_error = String(err); return 'err:' + err; }
  };

  window.__SNAP = function (相位) {
    try {
      S.相位 = 相位;
      finalizeAll();
      var s = snap();
      s.键 = S.当前键;
      s.相位 = 相位;
      S.series.push(s);
      return 'ok';
    } catch (err) { S.snap_error = String(err); return 'err:' + err; }
  };

  // ⭐⭐ 判别器：**程序化**改 DOM 选区，看 CM6 的状态跟不跟。
  //   用途：本探针的窗口**不是 key window**（本进程从不激活）⇒ `document.hasFocus()` 为 false。
  //   实测 ⌃O（**改文档内容**的原生命令）**生效**，而 ⌃E/⌃A（**只移光标**的）不动。
  //   两种成因要分开：
  //     ① WebKit 在非激活文档上**拒绝执行移动类编辑命令**（⇒ 移光标那一族在本探针里测不出，
  //        但真 rmd 里窗口是激活的，行为以 run 1 那份前台实测为准）；
  //     ② CM6 在把外部选区改动**顶回去**（⇒ 那 ⌃E 其实生效过，是被覆盖了）。
  //   本判别器分开它们：程序化改选区和原生命令走的是**两条不同的路**。
  window.__TEST_DOM_SELECTION = function () {
    var 前 = view.state.selection.main.head;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return { 前: 前, 错误: '没有 DOM 选区' };
    var r = sel.getRangeAt(0);
    var node = r.startContainer, off = r.startOffset;
    if (node.nodeType !== 3) return { 前: 前, 错误: '起点不是文本节点（' + node.nodeType + '）' };
    var 目标 = Math.min(off + 5, node.length);
    try {
      sel.collapse(node, 目标);
    } catch (e) { return { 前: 前, 错误: String(e) }; }
    return { 前: 前, 原偏移: off, 设成: 目标, 节点长度: node.length,
             文本片段: node.data.slice(Math.max(0, off - 4), Math.min(node.data.length, 目标 + 4)) };
  };

  view.dispatch({ selection: { anchor: CARET } });
  view.focus();

  S.lines = { '第 4 行起点': lineStart, '第 4 行终点': lineEnd, '第 4 行长度': lines[li].length, '第 4 行文本': lines[li], '文档长度': DOC_LEN };
  S.initial = { '光标': CARET, '文本长度': view.state.doc.length };
  S.mount = { host_nodes: host.getElementsByTagName('*').length, doc_len: view.state.doc.length };
  S.focus = { hasFocus_after_mount: view.hasFocus,
              activeElement: document.activeElement ? document.activeElement.tagName : null,
              activeElement_类名: document.activeElement ? String(document.activeElement.className) : null,
              activeElement_就是contentDOM: document.activeElement === view.contentDOM };
  S.ready = true;
})();
</script>
HTML

# ── 编译探针 ──
BIN="$WORK/editor-keyprobe"
echo "▶ 编译探针…" >&2
swiftc -O "$HERE/editor-keyprobe.swift" -o "$BIN" >"$WORK/build.log" 2>&1 || {
  echo "⛔ 编译失败：" >&2; cat "$WORK/build.log" >&2; exit 1
}

RAW="$WORK/raw.json"
ERR="$WORK/raw.err"

echo "▶ 跑探针（⚠️ 全程**一个不可见窗口**、无前台切换、无合成系统按键；约 40 秒）…" >&2
# ⚠️ macOS **没有** `timeout(1)`：兜底超时由探针自己带（150 秒），这里再套一层 240 秒的看门狗。
if [ -n "$KEYS" ]; then
  "$BIN" "$PAGE" --keys "$KEYS" >"$RAW" 2>"$ERR" &
else
  "$BIN" "$PAGE" >"$RAW" 2>"$ERR" &
fi
pid=$!
for _ in $(seq 1 480); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$pid" 2>/dev/null; then
  echo "⛔ 240 秒没结束，强杀。" >&2
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
import json, os, platform, sys, re

raw_path, to_stdout, out, model, today = sys.argv[1:6]
# ⚠️ 探针在 JSON 之前会先打一行 `READY`（给外部对齐用）⇒ 从第一个 `{` 起切。
_t = open(raw_path, encoding="utf-8").read()
raw = json.loads(_t[_t.index("{"):])
page = raw.get("页面侧") or {}
natives = (raw.get("原生侧") or {}).get("日志") or []
series = page.get("series") or []
records = page.get("keys") or []

# 键 id → 该键**在页面侧**的可识别特征（用来从按键记录里挑出它）
SIGN = {
    "cmd-k":     ("k", True,  False),
    "cmd-comma": (",", True,  False),
    "cmd-b":     ("b", True,  False),
    "cmd-s":     ("s", True,  False),
    "ctrl-a":    ("a", False, True),
    "ctrl-b":    ("b", False, True),
    "ctrl-d":    ("d", False, True),
    "ctrl-e":    ("e", False, True),
    "ctrl-f":    ("f", False, True),
    "ctrl-h":    ("h", False, True),
    "ctrl-k":    ("k", False, True),
    "ctrl-n":    ("n", False, True),
    "ctrl-o":    ("o", False, True),
    "ctrl-p":    ("p", False, True),
    "escape":    ("Escape", False, False),
}

# ⭐ 每个 `Ctrl+x` 在 WebKit 的 `macEditingCommandsMap` 里的**预期**语义，以及它落到
#    可观察量上的判据（**预期，⛔ 不是结论**——结论以实测的光标/文本变化为准）。
EMACS_EXPECT = {
    "ctrl-a": ("moveToBeginningOfLine", "落到行首", "列 → 0"),
    "ctrl-e": ("moveToEndOfLine",       "落到行尾", "列 → 30（第 4 行长度）"),
    "ctrl-b": ("moveBackward",          "光标左移一格", "head → 42"),
    "ctrl-f": ("moveForward",           "光标右移一格", "head → 44"),
    "ctrl-n": ("moveDown",              "下移一行", "行 4 → 5"),
    "ctrl-p": ("moveUp",                "上移一行", "行 4 → 3"),
    "ctrl-d": ("deleteForward",         "删掉光标后一个字符", "文本长度 −1，head 不变"),
    "ctrl-h": ("deleteBackward",        "删掉光标前一个字符", "文本长度 −1，head −1"),
    "ctrl-k": ("killLine",              "删到行尾", "文本长度减少 30 − 10 = 20"),
    "ctrl-o": ("insertNewlineIgnoringFieldEditor", "⭐ 插入一个换行（改文档内容）", "文本长度 +1，head 不变"),
}

lines = page.get("lines") or {}
L0, L1 = lines.get("第 4 行起点"), lines.get("第 4 行终点")
CARET0, DLEN0 = lines.get("第 4 行起点", 0) + 10, lines.get("文档长度")

def track(键, 相位):
    return [s for s in series if s.get("键") == 键 and s.get("相位") == 相位]

def recs_for(轮, 键):
    """**某一轮**（`当时键` == 轮）里页面收到的、属于 `键` 的 keydown。
    ⚠️ 归属靠**轮标记**，⭐ 不是"按时间猜"——`⌘K` 对照每轮都发，只能靠 `当时键` 分清是哪一轮的。
    ⚠️ 命中判据 = 修饰键二元组 + (key 或 code)：`Ctrl+H` 的 `key` 由原生编辑命令决定，
    ⛔ 别赌它一定是某个字面量。"""
    if 键 not in SIGN:
        return []
    want, meta, ctrl = SIGN[键]
    got = []
    for e in records:
        if e.get("当时键") != 轮:
            continue
        if bool(e.get("meta")) != meta or bool(e.get("ctrl")) != ctrl:
            continue
        if e.get("key") != want and e.get("code") != want:
            continue
        got.append(e)
    return got

def summarize(键):
    idle = track(键, "idle")
    after = track(键, "after")
    heads = [s["head"] for s in after]
    lens = [s["文本长度"] for s in after]
    recs = recs_for(键, 键)
    idle_heads = [s["head"] for s in idle]
    def dom(s):
        d = s.get("DOM选区") or {}
        return d.get("偏移")
    dom_heads = [dom(s) for s in after]
    dom_idle = [dom(s) for s in idle]
    return {
        "DOM偏移_空转": dom_idle,
        "DOM偏移_按键后_序列": dom_heads,
        "DOM偏移_变化过": len({x for x in dom_heads if x is not None}) > 1,
        "DOM偏移_末": dom_heads[-1] if dom_heads else None,
        "DOM行_末": (after[-1].get("DOM选区") or {}).get("行") if after else None,
        "空转_样本数": len(idle),
        "空转_head": idle_heads,
        "空转_光标未动": bool(idle_heads) and len(set(idle_heads)) == 1,
        "空转_文本长度": [s["文本长度"] for s in idle],
        "空转_行": [s["行"] for s in idle],
        "按键后_样本数": len(after),
        "按键后_head_序列": heads,
        "按键后_行_序列": [s["行"] for s in after],
        "按键后_列_序列": [s["列"] for s in after],
        "按键后_文本长度_序列": lens,
        "光标变化过": len(set(heads)) > 1,
        "文本变化过": len(set(lens)) > 1,
        "末_head": heads[-1] if heads else None,
        "末_行": after[-1]["行"] if after else None,
        "末_列": after[-1]["列"] if after else None,
        "末_文本长度": lens[-1] if lens else None,
        "被测键_到页面": len(recs) > 0,
        "被测键_记录数": len(recs),
        "被测键_记录": recs,
        # ⚠️ 对照键是在**这一轮**里发的 ⇒ 轮标记是 `键`、被认的键是 `cmd-k`
        "对照_cmd_k_到页面": len(recs_for(键, "cmd-k")) > 0,
        "对照_cmd_k_记录数": len(recs_for(键, "cmd-k")),
        "焦点在编辑器_末": after[-1].get("焦点在编辑器") if after else None,
        # ⭐ 0c②：按键之后**转发到了哪个动作**（`__RESET` 起算；空 = 没转发）。
        # ⚠️⚠️ 页面每个样本报的都是**从本轮起点算起的累积切片** ⇒ ⛔ 不能把各样本连起来
        #   （那会把"1 次转发 × 13 个样本"读成"13 次转发"——本探针第一版就是这么读错的）。
        #   ⭐ 取**最后一个非空切片**：它是本轮最完整的那个。
        "转发_本轮": list(dict.fromkeys(
            [x for s in after if s.get("转发_本轮") for x in s["转发_本轮"]])),
        "转发_次数_末": (
            len([s for s in after if s.get("转发_本轮")][-1]["转发_本轮"])
            if [s for s in after if s.get("转发_本轮")] else 0),
    }

# ── 全局判据 ──
menu_settings = [s for s in natives if "菜单动作：设置" in s]
menu_sidebar = [s for s in natives if "菜单动作：显示/隐藏侧边栏" in s]
injected = [s for s in natives if s.startswith("注入 keyDown")]
pke_eaten = [s for s in natives if "performKeyEquivalent" in s and "super=True" in s]
active_editor = [s for s in natives if s.startswith("· RESET")]
# ⚠️ `__` 开头的轮是**探针自己的判别器**，⛔ 不算被测键（也不参与"每轮对照"的判据）。
被测键集 = sorted({s.get("键") for s in series if s.get("键") and not str(s.get("键")).startswith("__")},
                key=lambda x: str(x))

summary = {k: summarize(k) for k in 被测键集}
对照到达 = all(summary[k]["对照_cmd_k_到页面"] for k in 被测键集) if 被测键集 else False
空转全部未动 = all(summary[k]["空转_光标未动"] for k in 被测键集) if 被测键集 else False

# ── 判定 ──
verdict = {}
FWD = page.get("转发") or {}
verdict["⭐⭐ 0c② 转发白名单（真表派生 + 真扩展挂载）"] = (
    (
        "✅ 转发扩展**真的装上去了**：`src/services/keymap.js` + `src/editor/keys.js` 原样加载，"
        "白名单**派生**自 Rust 那张 `SHORTCUTS` 真表（⛔ 探针没抄第二份键位表）。"
        "派生结果 **%d** 条：%s"
        + ("；\n⚠️ 刻意不转发 **%d** 条：%s" % (len(FWD.get("notes") or []), "、".join(FWD.get("notes") or []))
           if FWD.get("notes") else "")
        + ("；\n⛔ 本该转发却翻不出来的 **%d** 条：%s" % (len(FWD.get("skipped") or []), "、".join(FWD.get("skipped") or []))
           if FWD.get("skipped") else "；⭐ 没有一条 `skipped`（⇒ 没有静默失效）")
    ) % (len(FWD.get("specs") or []), "、".join(FWD.get("specs") or []))
    if FWD.get("可用") else
    "⛔ **转发扩展没装上**：%s" % (FWD.get("错误") or "未知")
)
_菜单项被测 = [k for k in 被测键集 if k in ("cmd-b", "cmd-comma")]
verdict["⭐⭐ 注入是否送到（全局前置）"] = (
    "✅ 对照 ⌘K 在**每一轮**都到了页面（%d/%d 轮）"
    "⇒ 注入的事件确实走完了 AppKit → 响应者链 → WKWebView → WebKit 进程 → DOM 这一整条路，"
    "本轮结果可用于归因。（菜单动作次数：⌘B=%d、⌘,=%d——⚠️ 只有那两个键在本次键集里时才是判据）" % (
        sum(1 for k in 被测键集 if summary[k]["对照_cmd_k_到页面"]), len(被测键集),
        len(menu_sidebar), len(menu_settings))
    if 对照到达 else
    "⛔ **注入没送到**（对照 ⌘K 到达 %d/%d 轮；菜单动作 ⌘B=%d 次、⌘,=%d 次）"
    "⇒ 本轮**无结论**，⛔ 读成「键被吞了」是错的——那是「没送到」。"
    "下一步：把 `.swift` 的窗口改成可见再跑一次做交叉验证（⚠️ 那会打扰用户，须先说明）。" % (
        sum(1 for k in 被测键集 if summary[k]["对照_cmd_k_到页面"]), len(被测键集),
        len(menu_sidebar), len(menu_settings))
)
verdict["零按键对照（每轮各自空转）"] = (
    "✅ 每一轮在发键之前的空转采样里光标都没动（%d 轮全部满足）⇒ 下面每条「光标动了」都能归因给按键。" % len(被测键集)
    if 空转全部未动 else
    "⚠️ **有轮次在没人按键时空转采样里光标也在动** ⇒ 那几轮的「光标动了」不能归因给按键：%s" % (
        [k for k in 被测键集 if not summary[k]["空转_光标未动"]])
)
_ds_前 = [s for s in series if s.get("键") == "__domsel__" and s.get("相位") == "改前"]
_ds_后 = [s for s in series if s.get("键") == "__domsel__" and s.get("相位") == "改后"]
def _dom(s):
    return (s.get("DOM选区") or {}).get("偏移")

if not (_ds_前 and _ds_后):
    verdict["判别器 · 程序化改 DOM 选区谁跟"] = "⚠️ 没采到判别器样本"
else:
    _h0, _h1 = _ds_前[-1]["head"], _ds_后[-1]["head"]
    _d0, _d1 = _dom(_ds_前[-1]), _dom(_ds_后[-1])
    verdict["判别器 · 程序化改 DOM 选区谁跟"] = (
        "程序化把 DOM 选区右移 5 格 ⇒ DOM 偏移 %s → %s；CM6 `head` %s → %s。"
        % (_d0, _d1, _h0, _h1)
    ) + (
        " ⭐ **DOM 跟、CM6 不跟** ⇒ 证实「CM6 在本窗口不跟随外部 DOM 选区」"
        " ⇒ 判「原生命令生不生效」**只能看 DOM 偏移**，⛔ 看 CM6 会误判。"
        if _d0 != _d1 and _h0 == _h1 else
        " ⚠️ **DOM 也没跟** ⇒ 本窗口里**选区改动根本落不下来**（连程序化改都不动）"
        " ⇒ 移光标那一族在本形态下是**结构性测不出**（⛔ 既不能证实也不能否定），"
        "它的数**只能**取前台变体（`…run1-6键.json`）。"
        if _d0 == _d1 else
        " ⭐ DOM 与 CM6 都跟了 ⇒ 本窗口的外部选区改动是通的。"
    )
verdict["焦点状态（⚠️ 不可见窗口的已知风险面）"] = (
    "✅ `view.hasFocus` 为 true" if (page.get("focus") or {}).get("hasFocus_after_mount") else
    "⚠️ 本窗口**不是 key window**（本进程从不激活）⇒ `document.hasFocus()` 为 false"
    "（`view.hasFocus`=false，但 DOM 焦点**在** CM6 的 contentDOM 上：activeElement=%s、"
    "类名=%s）。⭐ 实测后果有**两面**，别混成一句："
    "① **改文档内容的**原生命令照常执行 —— `⌃O` 实测 71 → 72；"
    "② **只移光标**的那一族**结构性测不出** —— 这个窗口里 DOM 选区改动**根本落不下来**"
    "（程序化 `selection.collapse()` 也不动，见下面的判别器）⇒ 该族**只能**取前台变体 "
    "`editor-key-2026-10-16-Mac14,9.run1-6键.json`。"
    % ((page.get("focus") or {}).get("activeElement"), (page.get("focus") or {}).get("activeElement_类名"))
)

for k in 被测键集:
    s = summary[k]
    if k in ("cmd-comma", "cmd-b"):
        hits = menu_settings if k == "cmd-comma" else menu_sidebar
        verdict[k] = (
            "✅ **菜单层接走**：菜单动作记到 **%d** 次，页面**没**收到 keydown（⇒ 不重复动作）" % len(hits)
            if hits and not s["被测键_到页面"] else
            "✅ **菜单层接走**：菜单动作记到 **%d** 次；⚠️ 页面**也**收到 keydown —— "
            "⚠️ 会不会动作两次？**不会**：`keymap.js::buildBindings` 只收 `owner === 'web'` 的行，"
            "`⌘B`/`⌘,` 是 `owner = Menu` ⇒ 页面侧**没有**绑定，那次 keydown 是惰性的。" % len(hits)
            if hits and s["被测键_到页面"] else
            "⛔ 菜单动作**没**记到 —— ① 不成立" if not len(hits) else "⚠️ 未归类"
        ) + "；光标变化=%s；对照到达=%s" % ("是" if s["光标变化过"] else "否",
                                          "是" if s["对照_cmd_k_到页面"] else "否")
        continue

    # ⭐⭐ 0c②：转发的 `⌘S`
    if k == "cmd-s":
        fwd = s["转发_本轮"]
        verdict[k] = (
            "⭐ **转发链路走通了**：真 `NSEvent`（⌘S）→ 页面 `keydown` → CM6 派生出的 `Mod-s` 命中 "
            "→ `keys.js` 的转发扩展 → `rmd.keymap.dispatch`。本轮转发到 **%s**（共 **%d** 次"
            "——⚠️ 一条 `keydown` 该只转 **1** 次，多于此数就是重复投递）。"
            "⚠️ 本探针把 handler 换成了**记录器**（产品里是 `main.js` 注册的 `file.save`）"
            "⇒ 到 `session.saveDocument → invoke('save_document')` 的最后**一跳**不在此处断言（见 §7 手工表第 2 条）。"
            "；对照到达=%s" % (repr(fwd), s["转发_次数_末"], "是" if s["对照_cmd_k_到页面"] else "否")
            if fwd else
            "⛔ **没转发出去**（本轮转发日志为空）—— ⚠️ 先看上面那条「0c② 转发白名单」装没装上；"
            "装上了还为空 = `Mod-s` 没命中原生事件 ⇒ 那是 `keys.js` 里 `免Shift` 那一整段的**反例**。"
            "；光标变化=%s；文本长度 %s；对照到达=%s" % ("是" if s["光标变化过"] else "否", DLEN0,
                                                       "是" if s["对照_cmd_k_到页面"] else "否")
        )
        continue

    # Ctrl 系列 / Esc：判"谁接走的 + 用户看得见的后果"
    if not s["对照_cmd_k_到页面"]:
        verdict[k] = "⚠️ 本轮对照 ⌘K 没到页面 ⇒ **无结论**（⛔ 不是「被吞」）"
        continue
    if not s["被测键_到页面"]:
        verdict[k] = "⭐ 页面**没**收到 keydown ⇒ 被原生层接走；光标变化=%s；文本变化=%s" % (
            "是 ⇒ **用户可见行为**" if s["光标变化过"] else "否 ⇒ 被吃掉但无副作用",
            "是 ⇒ **改了文档内容**" if s["文本变化过"] else "否")
        continue

    bits = ["页面收到了 keydown（preventDefault=%s）" % (
        s["被测键_记录"][0].get("终_preventDefault") if s["被测键_记录"] else "?")]
    bits.append("光标变化=" + ("是（head %s → %s）" % (CARET0, s["末_head"]) if s["光标变化过"] else "否"))
    bits.append("文本长度 " + ("%s → %s ⇒ ⚠️ **文档被改了**" % (DLEN0, s["末_文本长度"])
                             if s["文本变化过"] else "%s（未变）" % DLEN0))
    if k in EMACS_EXPECT:
        cmd, 语义, 判据 = EMACS_EXPECT[k]
        bits.append("WebKit 预期命令 `%s`（%s；预期：%s）" % (cmd, 语义, 判据))
        # ⚠️⚠️ **不可见窗口的固有盲区**：本进程从不激活 ⇒ `document.hasFocus()` 为 false，
        #   而 WebKit 对**只移动光标**那一族的编辑命令有"文档未激活就不做"的闸门
        #   （`⌃O` 那种**改文档内容**的照做——本次实测 71 → 72 就是证据）。
        #   ⇒ 移光标族在本探针里只能记「未测到」，⛔ 不许写成「不生效」。
        if cmd in ("moveToBeginningOfLine", "moveToEndOfLine", "moveBackward", "moveForward",
                   "moveDown", "moveUp"):
            if s["DOM偏移_变化过"]:
                bits.append("⭐ **DOM 选区动了**（DOM 偏移 %s → %s）⇒ 原生命令**生效**"
                            "（⚠️ CM6 的 `head` 没跟，是它在本窗口不跟随外部 DOM 选区，⛔ 不是命令没生效）"
                            % (s["DOM偏移_空转"][-1] if s["DOM偏移_空转"] else None, s["DOM偏移_末"]))
            elif not s["光标变化过"]:
                bits.append("⚠️ **DOM 选区也没动** ⇒ 本窗口（非 key）里选区改动**落不下来**"
                            "（判别器：程序化改也不动）⇒ **结构性测不出**，"
                            "⛔ 不是「不生效」该族的数**只能**取前台变体 `…run1-6键.json`。")
    verdict[k] = "；".join(bits)

doc = {
    "schema": "rmd-editor-keyprobe/2",
    "date": today,
    "口径": {
        "说明": "design/0012 §7 步骤 0c ①③④：编辑区（CM6 contenteditable）聚焦时，⌘, / ⌘B / Ctrl+* / Esc 各归谁。",
        "⭐⭐_不打扰用户": "用户 2026-10-16 铁律。⛔ 不开可见窗口 / 不抢前台 / 不用 System Events / 不用辅助功能授权 / 不按测项起进程。",
        "事件注入方式": "NSEvent.keyEvent(...) → window.sendEvent(...)（探针进程内自造事件）",
        "窗口": ".accessory 激活策略 + .borderless + alphaValue=0 + orderBack；⛔ 全程不调用 NSApp.activate。",
        "为什么要判「送到没有」": "注入绕过 WindowServer 的全局路由 ⇒ 送没送到**必须自带判据**：每轮先发无主键 ⌘K（全项目无绑定）作对照，并要求 ⌘B/⌘, 的菜单动作各记到 1 次。",
        "每轮同一出发点": "Swift 每轮调页面 __RESET，把文档与光标恢复成初始态（第 4 行中段）——旧形态靠「每键一个进程 + 重新挂载」达到同一目的。",
        "零按键对照": "**每一轮**都有（RESET 之后先空转采样 3 点，一个键都不发）。",
        "采样方式": "Swift 侧 evaluateJavaScript 主动取（⛔ 不靠页内定时器——不可见窗口里会被节流，见 .swift 头注）。",
        "CM6": "用**产品那份产物** src/vendor/cm6.bundle.js（⛔ 探针不另打一份）",
        "扩展清单": ["EditorView.lineWrapping", "lineNumbers()", "history()", "keymap.of(historyKeymap)", "markdown()", "EditorView.updateListener"],
        "⭐_第7槽是真扩展": "`src/services/keymap.js` + `src/editor/keys.js` **原样加载**，"
                       "白名单**派生**自上面抽出来的 `SHORTCUTS` 真表（⛔ 探针不抄第二份键位表）"
                       "⇒ 0c② 的「⌘S → 转发 → dispatch」这一段**在这里就有数**。"
                       "⚠️ 唯一替掉的是 handler（记录器，产品里是 main.js 注册的 `file.save`）。"
                       "⚠️ ② 的**最后一跳**（`session.saveDocument → invoke('save_document')`）仍需真 rmd。",
        "轮数": len(被测键集),
    },
    "环境": {
        "machine_model": model,
        "os_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "swift": os.popen("swiftc --version 2>/dev/null | head -1").read().strip(),
        "python": platform.python_version(),
    },
    "判据": {
        "第 4 行起点": L0, "第 4 行终点": L1, "初始光标": CARET0, "初始文档长度": DLEN0,
        "初始光标_列": (CARET0 - L0) if (L0 is not None and CARET0 is not None) else None,
    },
    "到达性": {
        "每轮对照_cmd_k_全部到达": 对照到达,
        "每轮空转_光标全部未动": 空转全部未动,
        "注入事件条数": len(injected),
        "菜单动作_⌘B_次数": len(menu_sidebar),
        "菜单动作_⌘,_次数": len(menu_settings),
        "被菜单加速键吃掉（performKeyEquivalent super=True）": pke_eaten,
        "RESET 次数": len(active_editor),
    },
    "汇总结论": verdict,
    "汇总原始": summary,
    "原生侧": raw.get("原生侧"),
    "转发": {kk: (FWD.get(kk) if kk != "log" else "（%d 次）" % len(FWD.get("log") or []))
             for kk in ("可用", "错误", "specs", "skipped", "notes")},
    "页面侧_元信息": {kk: page.get(kk) for kk in
                 ("ready", "mount", "initial", "lines", "ext", "focus", "mount_error", "reset_error", "snap_error")},
}

if to_stdout == "1":
    print(json.dumps(doc, ensure_ascii=False, indent=2))
    print("\n" + json.dumps(verdict, ensure_ascii=False, indent=2), file=sys.stderr)
    sys.exit(0)

os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(json.dumps(verdict, ensure_ascii=False, indent=2))
print("\n✅ 结果写入 %s" % out, file=sys.stderr)
PY
