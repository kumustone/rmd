#!/usr/bin/env bash
# 跑「左右滚动同步」的**真 DOM 离屏探针**（`design/0012` §11.6/§11.7）
#
# 用法：
#   tools/wkwebview-probe/scroll-sync-probe.sh            # 只打屏幕，判据进退出码
#   tools/wkwebview-probe/scroll-sync-probe.sh --save     # 另存一份到 benchmarks/results/
#   tools/wkwebview-probe/scroll-sync-probe.sh --save --force   # 允许覆盖同名结果
#   tools/wkwebview-probe/scroll-sync-probe.sh --json     # 只打原始 JSON
#
# 退出码：0 = 全通过；1 = 有检查**失败**；2 = 有检查**跳过**（环境自证没过）；3 = 跑不起来
#
# ⚠️⚠️ **默认不落盘**：`benchmarks/results/` 是**历史记录**（`docs/README.md` §6），
#    而这一条是个**闸门**（改一次 `sync.js` 就该跑一次）。把每次跑都塞进历史里，
#    下一跑就会被"拒绝覆盖同名文件"挡住 ⇒ 闸门自己把自己锁死。
#    ⇒ 要存证据时才 `--save`（那时仍拒绝覆盖，除非 `--force`）。
#
# ⚠️ 它跑的是**产品那两份**：`src/services/sync.js` 与 `src/vendor/cm6.bundle.js`，
#    原样拷进页面。⛔ 探针不抄第二份实现——那正是这一族（"两端各写一半的契约"）
#    在 `docs/bugs/0003`/`0004`/`0005` 里三次出事的形态。
#
# ⚠️ 前置：`src/vendor/cm6.bundle.js` 必须先由 `make cm6` 产出（要 node）。
#    页面能起、但 CM6 不在时探针会**响亮地**报"bundle 没加载"，⛔ 不静默降级。

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
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

BUNDLE="$ROOT/src/vendor/cm6.bundle.js"
SYNCJS="$ROOT/src/services/sync.js"
HARNESS="$HERE/scroll-sync-harness.js"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 3
fi
for f in "$BUNDLE" "$SYNCJS" "$HARNESS"; do
  if [ ! -f "$f" ]; then
    if [ "$f" = "$BUNDLE" ]; then
      echo "⛔ 缺 $BUNDLE —— 先跑 make cm6（要 node；这是 design/0012 §2.5 的产品产物）" >&2
    else
      echo "⛔ 缺 $f" >&2
    fi
    exit 3
  fi
done

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/scroll-sync-${TODAY}-${MODEL}.json"
if [ "$SAVE" = "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 3
fi

WORK="$HERE/.cm6-work"
PAGE="$WORK/ss-page"
mkdir -p "$WORK" "$PAGE"

# ── ① 页面：产品那两份 + 探针自己的夹具，全部**拷进去**（⛔ 不用符号链接：
#      `allowingReadAccessTo` 是按目录给的，链接指到目录外读不到） ──
cp "$BUNDLE"   "$PAGE/bundle.js"
cp "$SYNCJS"   "$PAGE/sync.js"
cp "$HARNESS"  "$PAGE/harness.js"

# ⚠️ `.cm-editor { height: 100% }` 这一条是**必须的**：CM6 的 baseTheme 给
#    `.cm-editor` 是 `display:flex` 但**没有高度**，于是 `.cm-scroller` 的
#    `height:100%` 落在一个 auto 高的盒子上 ⇒ **源码栏不可滚** ⇒ 大半检查直接失败。
#    产品那边同一条在 `src/styles/editor.css`（靠特异性赢过运行时注入的 baseTheme）。
cat > "$PAGE/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>rmd · scroll-sync probe</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  /* ⚠️ 与产品 `body.editing` 那个网格同形：两栏各自滚，外壳不滚。 */
  #wrap { display: grid; grid-template-columns: 1fr 1fr; height: 780px; width: 1200px; }
  #left { overflow: hidden; }
  #editor-host { height: 100%; overflow: hidden; }
  .cm-editor { height: 100%; }
  .cm-scroller { font-family: ui-monospace, Menlo, monospace; font-size: 14px; line-height: 1.6; }
  /* ⚠️ 预览栏：`overflow-y:auto` + **确定高度**才有可滚上界。
     行高与字号只影响绝对像素，⛔ 不影响映射的正确性（它是无量纲的）。 */
  #doc { height: 780px; overflow-y: auto; padding: 0; font: 400 16px/1.6 -apple-system; }
  #doc h2 { margin: 0; font-size: 20px; line-height: 28px; }
  #doc .pad, #doc .sec { background: #eef; color: #223; }
  #doc .pad { color: #889; }
</style>
<div id="wrap">
  <div id="left"><div id="editor-host"></div></div>
  <div id="doc"></div>
</div>
<!-- ⚠️ 顺序：bundle（全局 rmdCM6）→ 产品那份 sync.js（全局 rmd.sync）→ 夹具。
     与 `src/index.html` 里那三条硬约束同一回事。 -->
<script src="bundle.js"></script>
<script src="sync.js"></script>
<script src="harness.js"></script>
HTML

# ── ② 编译探针 ──
BIN="$WORK/scroll-sync-probe"
if [ ! -x "$BIN" ] || [ "$HERE/scroll-sync-probe.swift" -nt "$BIN" ]; then
  echo "▶ 编译探针…" >&2
  swiftc -O "$HERE/scroll-sync-probe.swift" -o "$BIN" >"$WORK/ss-build.log" 2>&1 || {
    echo "⛔ 编译失败：" >&2; cat "$WORK/ss-build.log" >&2; exit 3
  }
fi

RAW="$WORK/ss-raw.json"
ERR="$WORK/ss.err"
echo "▶ 跑探针（⚠️ 全程**一个不可见窗口**、无前台切换、无合成按键；实测约 5 秒）…" >&2
# ⚠️ macOS **没有** `timeout(1)`：探针自己带 150 秒兜底，这里再套一层 240 秒看门狗。
"$BIN" "$PAGE" >"$RAW" 2>"$ERR" &
pid=$!
for _ in $(seq 1 480); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$pid" 2>/dev/null; then
  echo "⛔ 240 秒没结束，强杀。" >&2
  kill -9 "$pid" 2>/dev/null || true
  exit 3
fi
wait "$pid" 2>/dev/null || true

if ! grep -q '^{' "$RAW" 2>/dev/null; then
  echo "⛔ 探针没产出 JSON。stderr：" >&2
  sed -n '1,40p' "$ERR" >&2
  exit 3
fi
sed -n '1,10p' "$ERR" >&2 || true

# ── ③ 判据汇总：**退出码就是结论** ──
python3 -I - "$RAW" "$TO_JSON" "$SAVE" "$OUT" "$MODEL" "$TODAY" "$HERE/scroll-sync-harness.js" <<'PY'
import json, os, platform, sys

raw_path, to_json, save, out, model, today, harness_path = sys.argv[1:8]
raw = json.load(open(raw_path, encoding="utf-8"))

if "致命" in raw:
    print("⛔ 致命：" + str(raw["致命"]), file=sys.stderr)
    sys.exit(3)

检查 = raw.get("检查") or []
通过 = [c for c in 检查 if c["结果"] == "通过"]
失败 = [c for c in 检查 if c["结果"] == "失败"]
跳过 = [c for c in 检查 if c["结果"] == "跳过"]

doc = {
    "schema": "rmd-scroll-sync-probe/1",
    "date": today,
    "口径": {
        "说明": "design/0012 §11.6/§11.7：跑**产品那两份**（src/services/sync.js ＋ "
                "src/vendor/cm6.bundle.js）在真 WKWebView 里的左右滚动同步接线。",
        "为什么": "纯逻辑那 35 条在 tests/js/sync.test.js；接线（监听/观察器/rAF 合流/夹取/拆卸）"
                  "要真 DOM ⇒ 只能离屏验。本仓库『两端各写一半的契约』已出过三次"
                  "（docs/bugs/0003/0004/0005），断的都是中间那一跳。",
        "被测文件": {"sync.js": "src/services/sync.js（原样拷入，⛔ 探针不抄第二份）",
                     "cm6": "src/vendor/cm6.bundle.js（make cm6 的产物）",
                     "夹具": "tools/wkwebview-probe/scroll-sync-harness.js"},
        "⚠️ 边界": "预览 DOM 是**手搭**的（节高刻意不均）⇒ 结论只对 sync.js 那一层有效，"
                   "⛔ 不覆盖 comrak 的排版高度，⛔ 不是『滚动手感好不好』。",
        "⚠️ 容差": "落点判据 3 px（滚动位置被设备像素量化，而夹具最陡那一段 Δb/Δa ≈ 3）",
        "机器": f"{model} / macOS {platform.mac_ver()[0]} / {platform.machine()}",
        "⚠️ 离屏": "窗口 alphaValue=0 ＋ orderBack ⇒ **不弹窗、不抢焦点、不合成按键**（根 CLAUDE.md 约定 4）。"
                   "⚠️⚠️ `orderBack` 不是可选项：只 alpha=0 而从不 order 的窗口 WebKit **一帧 rAF 都不派**"
                   "（第一版实测 1000 ms / 0 帧）——而观察器合流那两条检查正靠它。"
                   "代价是环境要**每次自证**：E1（rAF 来不来）、E2（scroll 事件派不派发）"
                   "＋ swift 侧比一次 `frontmostApplication`（被抢过就别信这次数）。"
                   "kb/0022 的口径是『可以用，但每次都要自证』。",
    },
    "环境": {
        "machine_model": model,
        "os_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "python": platform.python_version(),
        "页面自证": raw.get("环境"),
    },
    "夹具": raw.get("夹具"),
    "检查": 检查,
    "结论": raw.get("结论"),
}

if to_json == "1":
    print(json.dumps(doc, ensure_ascii=False, indent=2))
else:
    if 失败:
        print("⛔ 左右滚动同步：**没通过**", file=sys.stderr)
    elif 跳过:
        print("⚠️ 左右滚动同步：有 %d 条**没判定**（环境不成立，⛔ 不是失败）" % len(跳过), file=sys.stderr)
    else:
        print("✅ 左右滚动同步：%d 条全通过" % len(通过), file=sys.stderr)
    for c in 检查:
        mark = {"通过": "✅", "失败": "⛔", "跳过": "⏭"}.get(c["结果"], "?")
        print("%s %-4s %s" % (mark, c["id"], c["名"]), file=sys.stderr)
        if c["结果"] != "通过":
            print("      判据：%s" % c["判据"], file=sys.stderr)
            print("      实测：%s" % json.dumps(c["值"], ensure_ascii=False), file=sys.stderr)
    for key, val in (raw.get("环境") or {}).items():
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
