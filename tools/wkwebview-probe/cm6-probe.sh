#!/usr/bin/env bash
# 跑「CM6 冷启动」探针并把真值落盘（`research/notes/0016` §2.5 / `notes/0004` §7 待补 #3）
#
# 用法：
#   tools/wkwebview-probe/cm6-probe.sh                  # 默认 6 个夹具 × 3 轮，落盘
#   tools/wkwebview-probe/cm6-probe.sh --stdout         # 只打屏幕，不落盘
#   tools/wkwebview-probe/cm6-probe.sh --force          # 允许覆盖已有的同名结果
#   REPEAT=5 tools/wkwebview-probe/cm6-probe.sh         # 多轮
#   FIXTURES="XL-plain" tools/wkwebview-probe/cm6-probe.sh   # 只跑一个
#
# ⚠️ 与 `make bench` 同一条纪律：`benchmarks/results/` 是**历史记录**，默认**拒绝覆盖**。
#    要留两次对比，先把旧文件改名（或加 --force）。
#
# ⚠️ 这是**取证探针**，⛔ 不是产品代码：它把 CodeMirror 6 打进一个 WKWebView 只为量数字。
#    `adr/0006`（V1 不自研窗口内编辑）与 `adr/0005`（V1 无前端转译链）**都没有被它改动**——
#    它落在 `tools/` 下，碰不到 `src/`，也不进任何构建产物。
#
# ⚠️ 首次运行要 `npm install`（拉 6 个 `@codemirror/*` / `@lezer/*` / `esbuild`）。
#    之后依赖与打包产物缓存在 `tools/wkwebview-probe/.cm6-work/`（已 gitignore）。

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

REPEAT="${REPEAT:-3}"
# ⚠️ 夹具覆盖四档规模：S 是**线性度锚**（38 KB），L 是 5 MB 档，四个 XL 是 10 MB 档。
#    ⛔ 别只留 XL：没有 S/L 就分不清"随规模涨"和"常数开销"。
FIXTURES="${FIXTURES:-S-plain L-plain XL-plain XL-headings XL-tables XL-code}"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。这条探针需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "⛔ 没有 node/npm。探针要 esbuild 把 CM6 打进一个 bundle。" >&2
  exit 1
fi

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/cm6-coldstart-${TODAY}-${MODEL}.json"

# ⚠️ 覆盖检查在**装依赖与编译之前**：那两件事要几十秒，跑完才发现要拒绝等于白跑。
if [ "$TO_STDOUT" != "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 1
fi

WORK="$HERE/.cm6-work"
PAGE="$WORK/page"
mkdir -p "$WORK" "$PAGE" "$WORK/out"

# ── ① 依赖（锁版本，见 cm6-package.json 的 comment） ──
if [ ! -d "$WORK/node_modules" ]; then
  echo "▶ 装探针依赖（首次，约 10 秒）…" >&2
  cp "$HERE/cm6-package.json" "$WORK/package.json"
  ( cd "$WORK" && npm install --silent --no-audit --no-fund ) >&2
fi

# ── ② 打包 entry.js（CM6 是 ESM，页面里没有模块加载器 ⇒ 必须打成经典脚本） ──
# ⚠️ **必须先把入口拷进 $WORK 再打包**：esbuild 解析裸模块名是从**入口文件所在目录**
#    往上找 node_modules，⛔ 不是从 cwd。直接拿 $HERE/cm6-entry.js 当入口，
#    它会去 tools/wkwebview-probe/node_modules 找（不存在）⇒ 四个 unresolved 报错。
cp "$HERE/cm6-entry.js" "$WORK/entry.js"
echo "▶ 打包 CM6 bundle…" >&2
( cd "$WORK" && ./node_modules/.bin/esbuild entry.js \
    --bundle --format=iife --target=safari17 --outfile="$PAGE/bundle.js" --log-level=warning ) >&2

# ── ③ 页面 + 语料夹具 ──
# 页面极简：一个 #host、一个 doc.js（探针每次运行前把它换成对应夹具）。
cat > "$PAGE/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>rmd · cm6 probe</title>
<style>
  html, body { margin: 0; height: 100%; }
  /* ⚠️ 高度决定视口行数（`viewport_lines`）——改了这里，那一列就不能跨轮比较 */
  #host { width: 1200px; height: 780px; font: 14px -apple-system; }
</style>
<div id="host"></div>
<script src="bundle.js"></script>
<script src="doc.js"></script>
HTML

miss=0
for name in $FIXTURES; do
  src="$ROOT/benchmarks/corpus/${name}.md"
  if [ ! -f "$src" ]; then
    echo "⛔ 缺语料 $src —— 先跑 make corpus" >&2
    miss=1
  fi
done
[ "$miss" = "0" ] || exit 1

for name in $FIXTURES; do
  # ⚠️ 用 python3 -I 生成（转义交给 json.dumps，⛔ 别用 sed/awk 拼 10 MB 的字符串）
  python3 -I - "$ROOT/benchmarks/corpus/${name}.md" "$PAGE/doc-${name}.js" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding='utf-8') as f:
    text = f.read()
with open(dst, 'w', encoding='utf-8') as f:
    f.write("window.__DOC = ")
    json.dump(text, f, ensure_ascii=False)
    f.write(";\n")
PY
done

# ── ④ 编译探针 ──
BIN="$WORK/cm6-probe"
if [ ! -x "$BIN" ] || [ "$HERE/cm6-probe.swift" -nt "$BIN" ]; then
  echo "▶ 编译探针…" >&2
  swiftc -O "$HERE/cm6-probe.swift" -o "$BIN" >"$WORK/build.log" 2>&1 || {
    echo "⛔ 编译失败：" >&2; cat "$WORK/build.log" >&2; exit 1
  }
fi

# ── ⑤ 逐夹具跑（⚠️ 一次一个进程：WKWebView 的进程内状态不能跨夹具复用，
#      否则第二个夹具量的就不是冷启动了） ──
for name in $FIXTURES; do
  echo "▶ ${name}（repeat=${REPEAT}）…" >&2
  "$BIN" "$PAGE" "doc-${name}.js" --repeat "$REPEAT" \
    > "$WORK/out/${name}.json" 2> "$WORK/out/${name}.err" || {
      echo "⛔ $name 失败：" >&2; cat "$WORK/out/${name}.err" >&2; exit 1
    }
done

# ── ⑥ 合并元数据落盘 ──
python3 -I - "$WORK" "$OUT" "$MODEL" "$TODAY" "$REPEAT" "$FIXTURES" \
    "$(cd "$WORK" && ./node_modules/.bin/esbuild --version)" "$(node -v)" "$TO_STDOUT" <<'PY'
import json, os, platform, statistics, sys

work, out, model, today, repeat, fixtures, esbuild_ver, node_ver, to_stdout = sys.argv[1:10]
fixtures = fixtures.split()
work = os.path.join(work, "out")

# 每一轮的中位数：多轮取中位数（design/0002 §7.3.1 的多轮口径），⛔ 不取最小也不取均值
KEYS = ["t_state_ms", "t_view_ms", "t_layout_ms", "t_force_parse_ms",
        "t_keystroke_ms", "t_keystroke_reparse_ms", "t_yield_ms"]
# 这几列**不该取中位数**：它们是结构性计数（视口里建了多少节点/行），
# 取中位数会把"某一轮不同"这件事实抹掉。⇒ 逐轮原样保留，是否一致自己看。
COUNT_KEYS = ["viewport_nodes", "viewport_lines", "tree_len_after"]

entries = []
for name in fixtures:
    raw = json.load(open(os.path.join(work, name + ".json"), encoding="utf-8"))
    entry = {"夹具": name, "doc_len": raw["doc_len"], "rounds": len(raw["rounds"])}
    for mode in ["withLanguage", "withoutLanguage"]:
        rounds = [r[mode] for r in raw["rounds"]]
        med = {}
        for k in KEYS:
            vals = [r[k] for r in rounds if r.get(k) is not None]
            med[k] = round(statistics.median(vals), 3) if vals else None
        for k in COUNT_KEYS:
            vals = [r[k] for r in rounds if r.get(k) is not None]
            if not vals:
                med[k] = None          # ⚠️ 不能落成 []：那是"量到了但为空"的形状，会骗过读的人
            elif len(set(vals)) == 1:
                med[k] = vals[0]       # 逐轮一致 ⇒ 存那个数（不是数组、好读）
            else:
                med[k] = vals          # 逐轮不一致 ⇒ 原样留着，别取中位数把它抹平
        if mode == "withLanguage":
            med["force_parsing_returned"] = sorted({r["force_parsing_returned"] for r in rounds})
        entry[mode] = med
    entries.append(entry)

doc = {
    "schema": "rmd-cm6-coldstart/1",
    "date": today,
    "口径": {
        "说明": "research/notes/0016 §2.5：在真 WKWebView 里用 CodeMirror 6 打开大 Markdown 的冷启动分段。",
        "为什么": "research/notes/0004 §7 待补 #3。notes/0004 的『CM6 大文件冷启动』当时是**推断未实测**；"
                  "这条探针把它变成自己跑出来的数字（research/README.md 铁律允许的第三类一手材料）。",
        "内核版本": "codemirror/view 6.43.14 / state 6.7.6 / language 6.13.1 / lang-markdown 6.5.2 / lezer-markdown 1.8.0。"
                    "⚠️ 版本必须与本表一起读——换个版本这些数就作废。",
        "计时口径": "performance.now()，**每一段都在同一次同步调用里**量完，不跨帧。"
                    "t_state = EditorState.create（Text 树）· t_view = new EditorView（建 DOM、装观察器）·"
                    " t_layout = void contentDOM.offsetHeight（强制布局）· t_force_parse = forceParsing(view, len, 20000)"
                    "（CM6 默认**惰性分片**解析，不强制就量不到全量代价）· t_keystroke = dispatch 插入 1 个字符 + 强制布局 ·"
                    " t_keystroke_reparse = 按键后再 forceParsing · t_yield = setTimeout(…,0) 的往返。",
        "机器": f"{model} / macOS {platform.mac_ver()[0]} / {platform.machine()}",
        "轮次": f"{repeat} 轮，表里是**逐轮中位数**；⛔ 不是最小值（那会只留最好的一轮）。",
        "⚠️ rAF": "让出事件循环用的是 setTimeout ⛔ 不是 requestAnimationFrame——探针窗口 alphaValue=0、"
                  "不在屏幕上，WKWebView 不保证给不可见窗口刷新机会（第一版挂在 180 秒兜底上）。",
        "⚠️ 不测 IME": "合成按键造不出输入法组合态 ⇒ 『中文输入法在 CM6 里的手感』这条探针永远答不了，"
                       "见 notes/0016 §2.2。",
        "工具链": f"esbuild {esbuild_ver} / node {node_ver}",
        "视口": "1200×800 的 WKWebView，页面 #host 1200×780。#host 高度改了 viewport_lines 就不能跨轮比。",
    },
    "环境": {
        "machine_model": model,
        "os_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "python": platform.python_version(),
    },
    "夹具": entries,
}
os.makedirs(os.path.dirname(out), exist_ok=True)
if to_stdout != "1":
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
print(json.dumps(doc, ensure_ascii=False, indent=2))
if to_stdout != "1":
    print(f"\n✅ 结果写入 {out}", file=sys.stderr)
PY
