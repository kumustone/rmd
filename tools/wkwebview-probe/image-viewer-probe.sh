#!/usr/bin/env bash
# 跑「图片缩放预览」的**真 DOM 离屏探针**（`design/0018` §7.4，25 条判据）
#
# 用法：
#   tools/wkwebview-probe/image-viewer-probe.sh            # 只打屏幕，判据进退出码
#   tools/wkwebview-probe/image-viewer-probe.sh --save     # 另存一份到 benchmarks/results/
#   tools/wkwebview-probe/image-viewer-probe.sh --save --force   # 允许覆盖同名结果
#   tools/wkwebview-probe/image-viewer-probe.sh --json     # 只打原始 JSON
#
# 退出码：0 = 全通过；1 = 有检查**失败**；2 = 有检查**跳过**（前提/环境不成立）；3 = 跑不起来
#
# ⚠️⚠️ **默认不落盘**：`benchmarks/results/` 是**历史记录**（`docs/README.md` §6），
#    而这一条是个**闸门**（改一次 `imagezoom.js` / `ImageViewer.js` / `image-viewer.css` 就该跑一次）。
#    ⇒ 要存证据时才 `--save`（那时仍拒绝覆盖，除非 `--force`）。
#
# ⚠️ 它跑的是**产品那几份**，原样拷进页面，⛔ 探针不抄第二份实现或夹具：
#    `src/services/imagezoom.js`（缩放数学）＋ `src/services/keymap.js`（**真实分发器**，评审 R1）
#    ＋ `src/components/Settings.js`（**真实覆盖层登记处**）＋ `src/components/ImageViewer.js`
#    ＋ `src/styles/{tokens,themes,settings,image-viewer}.css`
#
# ⚠️ 夹具（`#doc` / 图片 / 假指针事件）全在 `image-viewer-harness.js` 里现造：
#    图片是 `canvas.toDataURL()` 生成的 `data:image/png` ⇒ ⛔ **零网络、不读真实资产**。
#
# ⚠️⚠️ **它证明不了什么**（`design/0018` §7.4 末那段）：`dispatchEvent` 造的是**不可信事件**，
#    浏览器不为它执行默认动作 ⇒ 第 12/14/17/22 条证明的是"该 preventDefault 的地方我们调了"，
#    ⛔ 不是"WebKit 真的照着做"。真实默认行为只能人造输入验证（§7.5）。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

TO_JSON=0
SAVE=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --json)  TO_JSON=1 ;;
    --save)  SAVE=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

IMAGEZOOM="$ROOT/src/services/imagezoom.js"
KEYMAP="$ROOT/src/services/keymap.js"
SETTINGS="$ROOT/src/components/Settings.js"
IMAGEVIEWER="$ROOT/src/components/ImageViewer.js"
HARNESS="$HERE/image-viewer-harness.js"
CSSDIR="$ROOT/src/styles"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 3
fi
for f in "$IMAGEZOOM" "$KEYMAP" "$SETTINGS" "$IMAGEVIEWER" "$HARNESS" \
         "$CSSDIR/tokens.css" "$CSSDIR/themes.css" "$CSSDIR/settings.css" "$CSSDIR/image-viewer.css"; do
  if [ ! -f "$f" ]; then
    echo "⛔ 缺 $f" >&2
    exit 3
  fi
done

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/image-viewer-${TODAY}-${MODEL}.json"
if [ "$SAVE" = "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 3
fi

WORK="$HERE/.iv-work"
PAGE="$WORK/iv-page"
mkdir -p "$WORK" "$PAGE"

# ── ① 页面：产品那四份 JS ＋ 四张样式表 ＋ 探针自己的夹具，全部**拷进去**
#      （⛔ 不用符号链接：`allowingReadAccessTo` 是按目录给的，链接指到目录外读不到） ──
cp "$IMAGEZOOM"  "$PAGE/imagezoom.js"
cp "$KEYMAP"     "$PAGE/keymap.js"
cp "$SETTINGS"   "$PAGE/settings-overlay.js"
cp "$IMAGEVIEWER" "$PAGE/imageviewer.js"
cp "$HARNESS"    "$PAGE/harness.js"
cp "$CSSDIR/tokens.css"       "$PAGE/tokens.css"
cp "$CSSDIR/themes.css"       "$PAGE/themes.css"
cp "$CSSDIR/settings.css"     "$PAGE/settings.css"
cp "$CSSDIR/image-viewer.css" "$PAGE/image-viewer.css"

# ⚠️ `#doc` 是**滚动宿主**（元素宿主，`scrollTop` 直接可写）：
#    `height: 400px` + `overflow-y: auto` 才有确定的 `clientHeight` 与可滚上界。
#    ⚠️ 图片**不给固定宽高**：判据 2 要的是真 `naturalWidth/Height`。
# ⚠️ 样式表的顺序照产品（`index.html`）来 ⇒ 探针量到的层叠关系与产品同构。
cat > "$PAGE/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>rmd · image-viewer probe</title>
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="themes.css">
<link rel="stylesheet" href="settings.css">
<link rel="stylesheet" href="image-viewer.css">
<style>
  html, body { margin: 0; }
  #doc {
    height: 400px; width: 760px; overflow-y: auto;
    font: 400 16px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
  }
  #doc p { margin: 0; height: 40px; }
  #doc img { display: block; }
  #preinert { position: absolute; left: 0; top: 0; }
</style>
<div id="doc"></div>
<!-- ⚠️ 顺序：先垫 `window.rmd`，再按产品依赖序上四份，最后夹具。
     `ImageViewer.js` 在**加载期**把 `window.rmd.imagezoom` / `window.rmd.settings` 取成常量
     ⇒ 那两个必须先加载（`frontend.md` 的结构性约束 3 同因）。
     `Settings.js` 加载期不碰 DOM（`open()`/`createSettings()` 才建）⇒ 可以直接上。 -->
<script>
  window.rmd = {};
  // ⚠️ 加载期错误只能靠这个面看见：经典脚本抛异常时**页面不报给 Swift**，
  //    表现与"忘了 `make` 某一步"逐字相同。
  window.__LOADERR = [];
  window.addEventListener('error', function (e) {
    window.__LOADERR.push(String(e.message) + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0));
  });
</script>
<script src="imagezoom.js"></script>
<script src="keymap.js"></script>
<script src="settings-overlay.js"></script>
<script src="imageviewer.js"></script>
<script src="harness.js"></script>
HTML

# ── ② 编译探针 ──
BIN="$WORK/image-viewer-probe"
if [ ! -x "$BIN" ] || [ "$HERE/image-viewer-probe.swift" -nt "$BIN" ]; then
  echo "▶ 编译探针…" >&2
  swiftc -O "$HERE/image-viewer-probe.swift" -o "$BIN" >"$WORK/iv-build.log" 2>&1 || {
    echo "⛔ 编译失败：" >&2; cat "$WORK/iv-build.log" >&2; exit 3
  }
fi

RAW="$WORK/iv-raw.json"
ERR="$WORK/iv.err"
echo "▶ 跑探针（⚠️ 全程**一个不可见窗口**、无前台切换、无合成按键；五个阶段，实测约 10–30 秒）…" >&2
# ⚠️ macOS **没有** `timeout(1)`：探针自己带 180 秒兜底，这里再套一层 300 秒看门狗。
"$BIN" "$PAGE" >"$RAW" 2>"$ERR" &
pid=$!
for _ in $(seq 1 600); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$pid" 2>/dev/null; then
  echo "⛔ 300 秒没结束，强杀。" >&2
  kill -9 "$pid" 2>/dev/null || true
  exit 3
fi
wait "$pid" 2>/dev/null || true

if ! grep -q '^{' "$RAW" 2>/dev/null; then
  echo "⛔ 探针没产出 JSON。stderr：" >&2
  sed -n '1,60p' "$ERR" >&2
  exit 3
fi
sed -n '1,40p' "$ERR" >&2 || true

# ── ③ 判据汇总：**退出码就是结论** ──
python3 -I - "$RAW" "$TO_JSON" "$SAVE" "$OUT" "$MODEL" "$TODAY" <<'PY'
import json, os, platform, sys

raw_path, to_json, save, out, model, today = sys.argv[1:7]
raw = json.load(open(raw_path, encoding="utf-8"))

if "致命" in raw:
    print("⛔ 致命：" + str(raw["致命"]), file=sys.stderr)
    sys.exit(3)

检查 = list(raw.get("检查") or [])
env = raw.get("环境") or {}
窗口 = env.get("窗口") or {}

# ⭐ 安全自证在 Swift 那边算（页面够不到 frontmostApplication）——⛔ 它不是 25 条判据里的，
#    而是一条**前置**：抢了前台或窗口不是全透明 ⇒ 这一轮的数不可信 ⇒ 退出码 3（基础设施）。
抢 = env.get("前台被抢过")
try:
    alpha0 = float(窗口.get("alpha", -1)) == 0.0
except (TypeError, ValueError):
    alpha0 = False
安全 = (抢 is False) and alpha0 and (窗口.get("调过_NSApp_activate") is False)

# ⚠️ 防"探针半路停了还报全绿"：1..25 缺任何一条都当场记成失败。
有 = set(str(c.get("id")) for c in 检查)
for i in range(1, 26):
    if str(i) not in 有:
        检查.append({
            "id": str(i),
            "名": "（探针没有产出这一条判据）",
            "结果": "失败",
            "判据": "§7.4 的 25 条必须逐条产出",
            "值": {"缺": str(i)},
        })

数字 = [c for c in 检查 if str(c.get("id", "")).isdigit()]
补充 = [c for c in 检查 if not str(c.get("id", "")).isdigit()]
数字.sort(key=lambda c: int(c["id"]))
补充.sort(key=lambda c: str(c.get("id")))

通过 = [c for c in 数字 if c["结果"] == "通过"]
失败 = [c for c in 数字 if c["结果"] == "失败"]
跳过 = [c for c in 数字 if c["结果"] == "跳过"]

doc = {
    "schema": "rmd-image-viewer-probe/1",
    "date": today,
    "口径": {
        "说明": "design/0018 §7.4：跑**产品那几份**（src/services/imagezoom.js ＋ "
                "src/services/keymap.js ＋ src/components/Settings.js ＋ "
                "src/components/ImageViewer.js ＋ 四张样式表）在真 WKWebView 里的"
                "图片缩放预览接线。",
        "为什么": "纯逻辑那 30 条在 tests/js/imagezoom.test.js（另 12 条源码级闸门）；"
                  "而 §7.4 要验的是「真 DOM 里样式/布局/事件顺序对不对」——"
                  "缩放是不是真的画到了 transform 上、模态键盘有没有挡住背景、"
                  "开关会不会把正文滚走、resize 后手动比例会不会被顶走。",
        "被测文件": {
            "imagezoom.js": "src/services/imagezoom.js（原样拷入，⛔ 探针不抄第二份）",
            "keymap.js": "src/services/keymap.js（⭐ **真实分发器**，评审 R1 要求 ⛔ 不用 stub）",
            "Settings.js": "src/components/Settings.js（⭐ **真实覆盖层登记处**，产品 API）",
            "ImageViewer.js": "src/components/ImageViewer.js（含 zoomTarget() 与 installDelegation()）",
            "样式表": ["tokens.css", "themes.css", "settings.css", "image-viewer.css"],
            "夹具": "tools/wkwebview-probe/image-viewer-harness.js",
        },
        "⚠️ 边界": "dispatchEvent 造的是**不可信事件**，浏览器不为它执行默认动作 "
                   "⇒ 第 12/14/17/22 条证明的是「该 preventDefault 的地方我们确实调了、"
                   "该放行的地方确实没调」（因果上的那一半），⛔ **不是**「WebKit 真的照着做」；"
                   "后者只能人造输入验证，列在 §7.5 的人工项。"
                   "⚠️ 第 18/19 条只能证明「我们没主动滚」——"
                   "`focus({preventScroll:true})` **不是不可信事件**，但它承重与否取决于环境："
                   "离屏窗口 `document.hasFocus()` 恒 false ⇒ WebKit 对程序性 focus **不做 scroll-into-view** "
                   "⇒ ⭐ 2026-10-20 变异 P4 实测（去掉 preventScroll）**本探针红 0 条**，"
                   "而 `tests/js/imagezoom.test.js` #36 **立刻红**。见 `design/0018` §10。"
                   "⚠️ 第 20/21 条由 Swift 侧在阶段之间改**视图 frame**（⛔ 不是改产品 CSS）。",
        "机器": f"{model} / macOS {platform.mac_ver()[0]} / {platform.machine()}",
        "⚠️ 离屏": "窗口 alphaValue=0 ＋ orderBack ⇒ **不弹窗、不抢焦点、不合成按键**"
                   "（根 CLAUDE.md 约定 4）。代价是环境要**每次自证**：rAF 与程序性焦点"
                   "（E）＋ swift 侧比一次 frontmostApplication（安全自证）。",
    },
    "环境": {
        "machine_model": model,
        "os_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "python": platform.python_version(),
        "页面自证": env,
        "安全": 安全,
    },
    "夹具": raw.get("夹具"),
    "补充": 补充,
    "检查": 数字,
    "结论": {"通过": len(通过), "失败": len(失败), "跳过": len(跳过)},
}

if not 安全:
    print("⛔⛔ 安全自证没过（前台被抢 / 窗口不是全透明）——这一轮的数不要信", file=sys.stderr)
    print(json.dumps(doc, ensure_ascii=False, indent=2), file=sys.stderr)
    sys.exit(3)

if to_json == "1":
    print(json.dumps(doc, ensure_ascii=False, indent=2))
else:
    if 失败:
        print("⛔ 图片缩放预览：**没通过**（%d 条失败）" % len(失败), file=sys.stderr)
    elif 跳过:
        print("⚠️ 图片缩放预览：有 %d 条**没判定**（前提/环境不成立，⛔ 不是失败）" % len(跳过),
              file=sys.stderr)
    else:
        print("✅ 图片缩放预览：%d 条全通过" % len(通过), file=sys.stderr)
    for c in 数字:
        mark = {"通过": "✅", "失败": "⛔", "跳过": "⏭"}.get(c["结果"], "?")
        print("%s %-4s %s" % (mark, c["id"], c["名"]), file=sys.stderr)
        if c["结果"] != "通过":
            print("      判据：%s" % c["判据"], file=sys.stderr)
            print("      实测：%s" % json.dumps(c["值"], ensure_ascii=False), file=sys.stderr)
    for c in 补充:
        mark = {"通过": "·", "失败": "⛔", "跳过": "⏭"}.get(c["结果"], "?")
        print("%s %-4s %s" % (mark, c["id"], c["名"]), file=sys.stderr)
        if c["结果"] != "通过":
            print("      实测：%s" % json.dumps(c["值"], ensure_ascii=False), file=sys.stderr)
    for key, val in env.items():
        if key in ("窗口",):
            print("· 环境.%s = %s" % (key, json.dumps(val, ensure_ascii=False)), file=sys.stderr)
    print("· 夹具 = %s" % json.dumps(raw.get("夹具"), ensure_ascii=False), file=sys.stderr)
    print(json.dumps(doc, ensure_ascii=False, indent=2))

if save == "1":
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("✅ 结果写入 %s" % out, file=sys.stderr)

sys.exit(1 if 失败 else (2 if 跳过 else 0))
PY
