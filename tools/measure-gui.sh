#!/usr/bin/env bash
# rmd 批次 2 的测量入口：**真开窗口**，把前端量到的 T4/T5/T5b/T6/T6b、残差 R、
# DOM 节点数与 WebView 进程内存采下来，落成 `benchmarks/results/<日期>-<机型>-gui.json`。
#
#     tools/measure-gui.sh                        # 默认 8 个语料 + 一个"启动地板"夹具 × 3 轮
#     tools/measure-gui.sh FILE.md [FILE2.md ...] # 只跑指定的
#     tools/measure-gui.sh --rounds 5 FILE.md     # 换轮数
#     tools/measure-gui.sh --out /tmp/x.json      # 换落点（默认按日期+机型）
#     tools/measure-gui.sh --force                # 允许覆盖同名结果（⛔ 默认拒绝）
#
# # 为什么需要它（`design/0002` §10.4 批 2）
#
# 批 2 要回答的是「**V1 要不要分块渲染**」。那是个只能用**数字**回答的问题，
# 而数字只存在于一个 GUI 窗口里——**Agent 看不到那个窗口**。
#
# ⚠️ **它要采的六个量都没有别的来源**：
#   · T4/T5/T5b —— **前端** `performance.now()`，只有真 WebView 有；
#   · T6/T6b   —— `paint` / `largest-contentful-paint` 条目，只有真 WebView 有；
#   · 残差 R   —— `T4 − (T1+T2+T3)`，**推导值**，要前端那份 T4 才成立；
#   · DOM 节点数 —— HTML 真的挂进 DOM 之后才有（§7.2 第 9 条）；
#   · WebView 进程内存 —— ⚠️ **没有标准 API**（§7.3.4），只能从 macOS 侧按进程采。
# 其中前四个由 `src/services/measure.js` + `main.js` 的 `reportMeasure()` 产出，
# 经 `report_measure` 命令回到 stdout（`RMD_MEASURE_SAMPLE ` 那一行）。
#
# # 三条口径（⛔ 违反了这些数字就不可比）
#
# 1. **只用 `--release` 二进制**（本脚本不替你构建；构建几分钟，
#    混在一起会让"是构建坏了还是渲染坏了"分不清）。
# 2. **一文件一进程**：每轮都重新起一个进程，⛔ 不在同一个窗口里连续开——
#    那样第二轮起就没有"冷启动"了，而冷启动正是用户每次点开文件时的处境。
# 3. **多轮取中位数**（§7.3.1），单次数字不进结果文件。
#
# ⚠️ **启动地板**（`research/notes/0007`：约 0.5 s 的固定开销，与文档大小无关）：
# 本脚本每次都会**顺带跑一份 1 段的极小文档**（`kind: "floor"`，写在系统临时目录里，
# ⛔ 不进仓库），它的总耗时就是这一次的**地板**。分析 T6/T6b 前**必须先扣掉它**——
# 不扣的话连 117 B 的文档都会显示"慢"，会把结论错误地推向"必须分块渲染"。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BIN="$ROOT/src-tauri/target/release/rmd"

ROUNDS=3
HOLD_MS=1200          # 报完之后多活一会儿，让本脚本采得到 WebView 进程内存
POLL_S=0.05
OUT=""
FORCE=0
FILES=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --rounds) ROUNDS="$2"; shift 2 ;;
    --hold)   HOLD_MS="$2"; shift 2 ;;
    --out)    OUT="$2"; shift 2 ;;
    --force)  FORCE=1; shift ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) FILES+=("$1"); shift ;;
  esac
done

if [ ! -x "$BIN" ]; then
  echo "✗ 没有 ${BIN}，先跑 make build-gui（⛔ 批次 2 只能用 GUI 构建）" >&2
  exit 1
fi
# ⚠️ 与 `make install` 同一条判据（`rmd://menu` 标记）：`build` 与 `build-gui`
#    写的是**同一个路径**，先 `build-gui` 再 `build` 会把它悄悄换成纯 CLI 的那份。
#    那时量出来的是"每次都没有窗口"，而文件本身看着完全正常。
#
# ⚠️⚠️ 这里**必须用 `grep -c` 而不是 `grep -q`**：本脚本开了 `set -o pipefail`，
#    而 `grep -q` 一命中就退出 ⇒ 上游 `strings` 收到 SIGPIPE ⇒ **整条管道返回 141**
#    ⇒ `! 管道` 判成"没找到标记"，于是**一个含 GUI 的构建被拒绝**。
#    （同一句在 Makefile 里没事——Make 的 recipe 跑在 `sh -c` 下，没有 pipefail。）
if [ "$(strings -a "$BIN" | grep -c 'rmd://menu' || true)" -eq 0 ]; then
  echo "⛔ $BIN 是**不含 GUI** 的构建（找不到标记 rmd://menu）⇒ 一开窗就报没编译 GUI。" >&2
  echo "   先跑 make build-gui。" >&2
  exit 1
fi
command -v python3 >/dev/null || { echo "✗ 没有 python3（采样记录与落盘要它）" >&2; exit 1; }

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
if [ -z "$OUT" ]; then
  OUT="$ROOT/benchmarks/results/$TODAY-$MODEL-gui.json"
fi
if [ -e "$OUT" ] && [ "$FORCE" -ne 1 ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是**历史记录**（design/0002 §8），不删不覆盖。" >&2
  echo "   要留两份对比：先把旧文件改名（如 …-gui-run1.json），再跑。" >&2
  echo "   或者显式加 --force。" >&2
  exit 1
fi

if [ "${#FILES[@]}" -eq 0 ]; then
  # ⭐ 默认矩阵 = **最坏情形 + 一个基准点**。只跑 plain 等于只测了最容易的那个。
  FILES=(
    "$ROOT/benchmarks/corpus/S-plain.md"     # 100 KB：门口那一档
    "$ROOT/benchmarks/corpus/M-plain.md"     # 1 MB
    "$ROOT/benchmarks/corpus/L-plain.md"     # 5 MB
    "$ROOT/benchmarks/corpus/XL-plain.md"    # 10 MB
    "$ROOT/benchmarks/corpus/XL-headings.md" # 10 MB，目录 31 425 项
    "$ROOT/benchmarks/corpus/XL-code.md"     # 10 MB，高亮最贵（design/0007 §10.3）
    "$ROOT/benchmarks/corpus/XL-tables.md"   # 10 MB，AST 860 837 个节点（最坏）
    "$ROOT/benchmarks/corpus/mixed.md"       # 1 MB，四类混排
  )
fi
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "✗ 找不到 ${f}（先跑 make corpus）" >&2
    exit 1
  fi
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/rmd-measure.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ⭐ 启动地板夹具：**一段话**的极小文档。写在系统临时目录，⛔ 不落仓库。
FLOOR_DOC="$TMP/floor.md"
printf '地板。\n' > "$FLOOR_DOC"

echo "▶ rmd 批次 2 · GUI 测量"
echo "  二进制   : $BIN"
echo "  机器     : $MODEL / $(uname -m) / $(uname -r)"
echo "  轮数     : ${ROUNDS}（每轮**重开一个进程**，取中位数）"
echo "  文件     : ${#FILES[@]} 个语料 + 1 个启动地板夹具"
echo "  落点     : $OUT"
echo

RECORDS="$TMP/records.tsv"
: > "$RECORDS"

# ⚠️ macOS 上 WKWebView 的 WebContent 进程**不是**我们进程的直接子进程
#    （它由系统的 runningboard 拉起），所以 ⛔ 不能用 `pgrep -P` 认亲。
#    ⇒ 用"启动前/启动后取差集"这个启发式（把启动前那一份 pid 记下来）。
BEFORE_WC=" $(ps -Ao pid=,comm= 2>/dev/null | awk '/com\.apple\.WebKit\.WebContent/ {print $1}' | tr '\n' ' ')"

# 把采到的一轮写进 records.tsv，并打一行人读的。
# 用法：record <record文件> <文件路径> <kind> <轮次> <样本JSON> <rmd峰值RSS字节> <wc峰值RSS字节> <wc进程数峰值> <墙钟毫秒>
record() {
  python3 - "$@" <<'PY'
import json, sys
rec, path, kind, rnd, js, prss, wrss, wcnt, wall = sys.argv[1:10]
s = json.loads(js)
s["_kind"] = kind
s["_round"] = int(rnd)
s["_peak_rmd_rss_bytes"] = int(prss)
s["_peak_webcontent_rss_bytes"] = int(wrss)
s["_webcontent_procs_max"] = int(wcnt)
s["_wall_ms"] = float(wall)
with open(rec, "a") as f:
    f.write(path + "\t" + json.dumps(s, ensure_ascii=False) + "\n")

def f(v, d=1):
    return "-" if v is None else f"{v:.{d}f}"
print("  ✓ 第 %s 轮  T4=%s ms  T5=%s  T5b=%s  R=%s  FCP=%s  LCP=%s  DOM %s 元素 / %s 节点  墙钟 %.0f ms%s"
      % (s["_round"], f(s.get("t4_ms")), f(s.get("t5_ms")), f(s.get("t5b_ms")), f(s.get("r_ms")),
         f(s.get("t6_fcp_ms")), f(s.get("t6b_lcp_ms")), s.get("doc_elements"), s.get("doc_nodes_total"),
         s["_wall_ms"],
         "" if not s.get("_peak_webcontent_rss_bytes") else
         "  WebView 峰值 %.0f MB（%d 个进程）" % (s["_peak_webcontent_rss_bytes"]/1048576, s["_webcontent_procs_max"])))
PY
}

run_one() {
  local file="$1" kind="$2" round="$3"
  local samples="$TMP/sample-$round.json" log="$TMP/log-$round.txt"
  : > "$samples"

  local t0 t1
  t0="$(python3 -c 'import time;print(time.time())')"
  # ⭐ 三个环境变量各司其职：
  #    `RMD_MEASURE`      —— 打开前端的测量分支（`main.js` 的 `MEASURE`）
  #    `RMD_MEASURE_OUT`  —— 样本落点（一行 JSON；stdout 上也有一份，双保险）
  #    `RMD_MEASURE_HOLD_MS` —— 报完之后多活一会儿，**只为让本脚本采得到内存**
  RMD_MEASURE=1 RMD_MEASURE_OUT="$samples" RMD_MEASURE_HOLD_MS="$HOLD_MS" \
    "$BIN" "$file" >"$log" 2>&1 &
  local pid=$!

  local peak_rmd=0 peak_wc=0 peak_wc_n=0 r w n
  while kill -0 "$pid" 2>/dev/null; do
    r="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')"
    if [ -n "$r" ] && [ "$r" -gt "$peak_rmd" ]; then peak_rmd="$r"; fi
    # 我们这一轮的 WebContent：在**当前全量集合**里、且不在启动前那份里。
    # ⚠️ 这是个**启发式**——期间别的 app 若新拉起一个 WebContent 也会被算进来，
    #    所以把**进程数**一起记下来：一个 10 MB 文档正常只该有 1 个。
    w="$(ps -Ao pid=,rss=,comm= 2>/dev/null \
         | awk '/com\.apple\.WebKit\.WebContent/ {print $1, $2}' \
         | while read -r p rr; do
             case "$BEFORE_WC" in *" $p "*) ;; *) echo "$rr" ;; esac
           done)"
    n="$(printf '%s\n' "$w" | awk 'NF{c++} END{print c+0}')"
    w="$(printf '%s\n' "$w" | awk '{s+=$1} END {print s+0}')"
    if [ -n "$w" ] && [ "$w" -gt "$peak_wc" ]; then peak_wc="$w"; peak_wc_n="$n"; fi
    sleep "$POLL_S"
  done
  wait "$pid" 2>/dev/null || true
  t1="$(python3 -c 'import time;print(time.time())')"

  # ⚠️ 墙钟由**本脚本**量、峰值内存由**本脚本**采；其余全部来自那行 JSON。
  #    ⛔ 墙钟含 HOLD_MS，只当参考报出去，⛔ 不要拿它当"打开耗时"。
  local json
  json="$(grep -m1 '^RMD_MEASURE_SAMPLE ' "$log" | sed 's/^RMD_MEASURE_SAMPLE //' || true)"
  if [ -z "$json" ]; then
    json="$(grep -m1 '^RMD_MEASURE_SAMPLE ' "$samples" | sed 's/^RMD_MEASURE_SAMPLE //' || true)"
  fi
  if [ -z "$json" ]; then
    # ⚠️ 这一条**必须响亮**：它多半意味着 ACL 漏了 `allow-report-measure`
    #    （`report_measure` 被静默拒 ⇒ 前端只在 `console.warn` 里说一句 ⇒ 我们什么都收不到）。
    echo "  ⛔ 第 $round 轮没有样本（ACL 漏了 allow-report-measure？或前端报错）"
    echo "     日志尾部："
    tail -n 6 "$log" | sed 's/^/       /'
    return 1
  fi

  local wall
  wall="$(python3 -c "print(round(($t1 - $t0) * 1000.0, 1))")"
  record "$RECORDS" "$file" "$kind" "$round" "$json" \
         "$((peak_rmd * 1024))" "$((peak_wc * 1024))" "$peak_wc_n" "$wall"
}

# ⭐ **先烧一轮热身，丢掉**。理由：本进程是构建之后第一个被拉起来的 rmd，
# 它要付的代价（dyld 预热、代码签名校验、文件系统缓存）**后面每一轮都不再付**。
# ⚠️ 热身不留样本，否则"启动地板"那一行会**永远**是被污染的第一次。
echo "───────── 热身（丢掉，不进结果）─────────"
run_one "$FLOOR_DOC" "warmup" 0 >/dev/null 2>&1 || true
: > "$RECORDS"

echo "───────── 启动地板夹具（这一轮的固定开销）─────────"
for r in $(seq 1 "$ROUNDS"); do run_one "$FLOOR_DOC" "floor" "$r" || true; done
echo
for f in "${FILES[@]}"; do
  echo "───────── $(basename "$f") ─────────"
  for r in $(seq 1 "$ROUNDS"); do run_one "$f" "corpus" "$r" || true; done
done

echo
python3 "$HERE/measure-gui-aggregate.py" "$RECORDS" "$OUT" "$ROUNDS" "$HOLD_MS" "$MODEL"
