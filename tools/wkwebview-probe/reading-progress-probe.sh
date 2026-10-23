#!/usr/bin/env bash
# 跑「阅读进度恢复」的**真 DOM 离屏探针**（`design/0017` §7.4，12 条判据）
#
# 用法：
#   tools/wkwebview-probe/reading-progress-probe.sh            # 只打屏幕，判据进退出码
#   tools/wkwebview-probe/reading-progress-probe.sh --save     # 另存一份到 benchmarks/results/
#   tools/wkwebview-probe/reading-progress-probe.sh --save --force   # 允许覆盖同名结果
#   tools/wkwebview-probe/reading-progress-probe.sh --json     # 只打原始 JSON
#
# 退出码：0 = 全通过；1 = 有检查**失败**；2 = 有检查**跳过**（环境自证没过）；3 = 跑不起来
#
# ⚠️⚠️ **默认不落盘**：`benchmarks/results/` 是**历史记录**（`docs/README.md` §6），
#    而这一条是个**闸门**（改一次 `progress.js` / `ImageView.js` 的 `onSettled` 就该跑一次）。
#    ⇒ 要存证据时才 `--save`（那时仍拒绝覆盖，除非 `--force`）。
#
# ⚠️ 它跑的是**产品那三份**：`src/services/progress.js`（全部判据）、
#    `src/services/reload.js`（锚点解析）、`src/components/ImageView.js`（落定语义），
#    原样拷进页面。⛔ 探针不抄第二份实现——`main.js` 那层接线只能在页面里**镜像**
#    （它是根脚本，进不了探针页），镜像的那几行在 harness 头部写明了。
#
# ⚠️ 夹具用 `canvas` 现生成的 `data:` PNG —— ⛔ 不读任何真实资产文件。

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

PROGRESSJS="$ROOT/src/services/progress.js"
RELOADJS="$ROOT/src/services/reload.js"
IMAGEVIEW="$ROOT/src/components/ImageView.js"
HARNESS="$HERE/reading-progress-harness.js"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 3
fi
for f in "$PROGRESSJS" "$RELOADJS" "$IMAGEVIEW" "$HARNESS"; do
  if [ ! -f "$f" ]; then
    echo "⛔ 缺 $f" >&2
    exit 3
  fi
done

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/reading-progress-${TODAY}-${MODEL}.json"
if [ "$SAVE" = "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 3
fi

WORK="$HERE/.rp-work"
PAGE="$WORK/rp-page"
mkdir -p "$WORK" "$PAGE"

# ── ① 页面：产品那三份 + 探针自己的夹具，全部**拷进去**（⛔ 不用符号链接：
#      `allowingReadAccessTo` 是按目录给的，链接指到目录外读不到） ──
cp "$PROGRESSJS" "$PAGE/progress.js"
cp "$RELOADJS"   "$PAGE/reload.js"
cp "$IMAGEVIEW"  "$PAGE/imageview.js"
cp "$HARNESS"    "$PAGE/harness.js"

# ⚠️ `#doc` 是**滚动宿主**（与 `main.js::scrollHost()` 在编辑态的形态同构：
#    元素宿主，`scrollTop` 直接可写）。`height: 500px` + `overflow-y: auto`
#    才有确定的 `clientHeight` 与可滚上界；字号/行高只影响绝对像素，⛔ 不影响判据。
cat > "$PAGE/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>rmd · reading-progress probe</title>
<style>
  html, body { margin: 0; }
  #doc {
    height: 500px; width: 760px; overflow-y: auto;
    font: 400 16px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
  }
  #doc h2 { margin: 0; font-size: 18px; line-height: 24px; }
  #doc p { margin: 0; background: #f4f4f4; }
  /* ⚠️ 图片**不给固定宽高**：要的就是"解码前 naturalHeight = 0，
     解码后按内在尺寸进布局"——那正是判据 2/3 的被测形态。 */
  #doc img { display: block; }
  #doc .img-placeholder { display: inline-block; padding: 2px 4px; background: #eef; color: #446; }
</style>
<div id="doc"></div>
<!-- ⚠️ 顺序：先垫 `window.rmd`（tauri / session 两个对象），再上产品三份，最后夹具。
     `ImageView` 在**加载期**取 `window.rmd.session` 成常量 ⇒ 那两个对象必须先存在；
     而 `readAsset` 由夹具在**运行期**补上（同一个对象，取常量不影响）。 -->
<script>
  window.rmd = { tauri: {}, session: {} };
  // ⚠️ 加载期错误只能靠这个面看见：经典脚本抛异常时**页面不报给 Swift**，
  //    表现与"忘了 `make` 某一步"逐字相同（`frontend.md` 那条结构性约束的同族）。
  window.__LOADERR = [];
  window.addEventListener('error', function (e) {
    window.__LOADERR.push(String(e.message) + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0));
  });
</script>
<script src="reload.js"></script>
<script src="progress.js"></script>
<script src="imageview.js"></script>
<script src="harness.js"></script>
HTML

# ── ② 编译探针 ──
BIN="$WORK/reading-progress-probe"
if [ ! -x "$BIN" ] || [ "$HERE/reading-progress-probe.swift" -nt "$BIN" ]; then
  echo "▶ 编译探针…" >&2
  swiftc -O "$HERE/reading-progress-probe.swift" -o "$BIN" >"$WORK/rp-build.log" 2>&1 || {
    echo "⛔ 编译失败：" >&2; cat "$WORK/rp-build.log" >&2; exit 3
  }
fi

RAW="$WORK/rp-raw.json"
ERR="$WORK/rp.err"
echo "▶ 跑探针（⚠️ 全程**一个不可见窗口**、无前台切换、无合成按键；实测约 5–15 秒）…" >&2
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

# ⭐ 判据 12 在 Swift 那边算（页面够不到 frontmostApplication）——这里并进来。
抢 = env.get("前台被抢过")
try:
    alpha0 = float(窗口.get("alpha", -1)) == 0.0
except (TypeError, ValueError):
    alpha0 = False
ok12 = (抢 is False) and alpha0 and (窗口.get("调过_NSApp_activate") is False)
检查.append({
    "id": "12",
    "名": "前台没有被抢（离屏不打扰用户）",
    "结果": "通过" if ok12 else "失败",
    "判据": "frontmostApplication 起跑前后相同 ∧ 窗口 alpha=0 ∧ 没调 NSApp.activate",
    "值": {"前台被抢过": 抢, "窗口": 窗口,
           "前台应用_起跑前": env.get("前台应用_起跑前"),
           "前台应用_收工时": env.get("前台应用_收工时")},
})

# ⚠️ 防"探针半路停了还报全绿"：1..11 缺任何一条都当场记成失败。
有 = set(str(c.get("id")) for c in 检查)
for i in range(1, 12):
    if str(i) not in 有:
        检查.append({
            "id": str(i),
            "名": "（探针没有产出这一条判据）",
            "结果": "失败",
            "判据": "§7.4 的 12 条必须逐条产出",
            "值": {"缺": str(i)},
        })

检查.sort(key=lambda c: int(c["id"]))
通过 = [c for c in 检查 if c["结果"] == "通过"]
失败 = [c for c in 检查 if c["结果"] == "失败"]
跳过 = [c for c in 检查 if c["结果"] == "跳过"]

doc = {
    "schema": "rmd-reading-progress-probe/1",
    "date": today,
    "口径": {
        "说明": "design/0017 §7.4：跑**产品那三份**（src/services/progress.js ＋ "
                "src/services/reload.js ＋ src/components/ImageView.js）在真 WKWebView 里的"
                "阅读进度恢复接线。",
        "为什么": "纯逻辑那 22 条在 tests/js/progress.test.js；而 §7.4 要验的是"
                  "「图片落定之后还会不会把位置校正回去」「旧挂载的迟到回调会不会抢走新正文」"
                  "「用户自己动了之后还抢不抢」——这三件都要真 DOM + 真 decode + 真 rAF。",
        "被测文件": {
            "progress.js": "src/services/progress.js（原样拷入，⛔ 探针不抄第二份）",
            "reload.js": "src/services/reload.js（锚点解析）",
            "ImageView.js": "src/components/ImageView.js（onSettled 的落定语义）",
            "夹具": "tools/wkwebview-probe/reading-progress-harness.js",
        },
        "⚠️ 边界": "main.js 那层接线是**镜像**的（根脚本进不了探针页）——镜像只保留判据用得到的行，"
                   "lastAppliedByPath 的写盘记账不在本探针里（它在 tests/js/progress.test.js #18/#19）。"
                   "夹具的正文是手搭的 ⇒ ⛔ 不覆盖 comrak 的真实排版高度，⛔ 不是「滚动恢复手感好不好」。",
        "⚠️ 容差": "落点判据 1 px（与 main.js::correctReadingProgress 的 '< 1 px 就不写' 同一把尺子）。",
        "机器": f"{model} / macOS {platform.mac_ver()[0]} / {platform.machine()}",
        "⚠️ 离屏": "窗口 alphaValue=0 ＋ orderBack ⇒ **不弹窗、不抢焦点、不合成按键**（根 CLAUDE.md 约定 4）。"
                   "代价是环境要**每次自证**：E1（rAF 来不来）＋ swift 侧比一次 frontmostApplication"
                   "（判据 12）。kb/0022 的口径是『可以用，但每次都要自证』。",
    },
    "环境": {
        "machine_model": model,
        "os_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "python": platform.python_version(),
        "页面自证": env,
    },
    "夹具": raw.get("夹具"),
    "检查": 检查,
    "结论": {"通过": len(通过), "失败": len(失败), "跳过": len(跳过)},
}

if to_json == "1":
    print(json.dumps(doc, ensure_ascii=False, indent=2))
else:
    if 失败:
        print("⛔ 阅读进度恢复：**没通过**", file=sys.stderr)
    elif 跳过:
        print("⚠️ 阅读进度恢复：有 %d 条**没判定**（环境不成立，⛔ 不是失败）" % len(跳过), file=sys.stderr)
    else:
        print("✅ 阅读进度恢复：%d 条全通过" % len(通过), file=sys.stderr)
    for c in 检查:
        mark = {"通过": "✅", "失败": "⛔", "跳过": "⏭"}.get(c["结果"], "?")
        print("%s %-4s %s" % (mark, c["id"], c["名"]), file=sys.stderr)
        if c["结果"] != "通过":
            print("      判据：%s" % c["判据"], file=sys.stderr)
            print("      实测：%s" % json.dumps(c["值"], ensure_ascii=False), file=sys.stderr)
    for key, val in env.items():
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
