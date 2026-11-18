#!/usr/bin/env bash
# ⭐ **点击网格扫描**（`docs/tasks.md` T45 提案 ③）——"快速系统地发现 bug"的工具。
#
# 它把正文按 x/y 切成网格（每个顶层块 3×3），**逐点真点一下**，然后检查五条与动作
# 无关的后置不变量（T45 提案 ①）：未捕获异常 / 顶层块数变化必须有提交解释 /
# 点完不留覆盖层（`editable=0` 的块一条都不许开）/ 被点那一块的视口位移 ≤ 2 px /
# 没有未知 IPC。网格之外再**逐个点小目标**（任务方框 / 链接 / 图片 / `<summary>` /
# 表格格）——`bugs/0077` 就出在 3×3 网格永远踩不到的那几个像素上。
#
# 用法：
#   tools/live-probe/clickgrid-probe.sh                     # 默认跑 fixtures/*.md
#   tools/live-probe/clickgrid-probe.sh --only blocks       # 只跑一份夹具
#   tools/live-probe/clickgrid-probe.sh --max 40            # 每份夹具最多扫 40 个点
#   tools/live-probe/clickgrid-probe.sh --from 117 --max 27  # 从第 117 个点起扫 27 个
#   tools/live-probe/clickgrid-probe.sh --two-step          # 点完再点块间空白（退出路径）
#   tools/live-probe/clickgrid-probe.sh --mutate M2         # 变异自检（见下），证明判据承重
#   tools/live-probe/clickgrid-probe.sh --json              # 只打原始 JSON
#
# 退出码：0 = 没有红点；1 = 有红点（报告里有那一条）；3 = 环境/基建失败
#
# ⚠️ **一次页面只点一下**：点一下可能进编辑、提交、甚至改正文，留在同一页里点第二下
#    测的是"上一轮改过的那棵树"。⇒ 每个点重开页面（`__point.js` 只改一个数字），
#    每个红点因此都能**单独复现**。
# ⚠️ 跑的是**真应用**（`src/index.html` ＋ 全部 `src/**`），后端是假后端
#    （回 Stage A 用**真 comrak** 导出的载荷）。⛔ 探针不重写产品实现。
# ⚠️ 离屏、不弹窗、不抢前台、不合成系统按键（`probe.swift` 的 `.prohibited` ＋ `alpha=0`）。
# ⚠️ 假后端不渲染 Markdown ⇒ "提交之后的文本对不对"缺一半；本工具只据
#    **几何 / DOM / IPC / 异常**判，⛔ 不冒充文本判据。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$ROOT/src"
SWIFT="$HERE/probe.swift"
FAKE="$HERE/fake-tauri.js"
HARNESS="$HERE/clickgrid-harness.js"
FIXTURES="$HERE/fixtures"
ONLY=""
MAX=0
FROM=0
STRIDE=1
TWO_STEP=false
TO_JSON=0
MUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:-}"; shift 2 ;;
    --max)  MAX="${2:-0}"; shift 2 ;;
    # 从第 N 个点开始扫（用于只验某一类块，例如结构块在 13..15 ⇒ --from 117）。
    --from) FROM="${2:-0}"; shift 2 ;;
    # 抽样步长：大文档（400+ 块）逐点全扫要几小时 ⇒ 隔 K 个点取一个。
    --stride) STRIDE="${2:-1}"; shift 2 ;;
    # 两阶段：点完这一块之后再点"块间空白"（退出编辑），验退出路径不留残留、不跳。
    --two-step) TWO_STEP=true; shift ;;
    --fixtures) FIXTURES="${2:-}"; shift 2 ;;
    --json) TO_JSON=1; shift ;;
    # ⚠️ 变异只打**页面副本**（`.cg-work/page-*/`），仓库文件一字不动。
    --mutate) MUT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

case "$MUT" in
  ""|M1|M2|M3|M4|M5|M6|M7) ;;
  *) echo "⛔ 未知变异：${MUT}（M1..M7）" >&2; exit 2 ;;
esac

command -v swiftc >/dev/null 2>&1 || { echo "⛔ 没有 swiftc（xcode-select --install）" >&2; exit 3; }
# ⚠️ `--fixtures` 允许给相对路径，而 Stage A 是 `cd src-tauri` 之后跑的（见 ① ）
#    ⇒ 这里必须先转成绝对路径。2026-11-04 实测：`--fixtures tools/live-probe/fixtures`
#    在脚本里报「夹具目录读不了: No such file or directory」，而同一条 cargo 命令
#    手打在仓库根就能过——差别只在 cwd，⛔ 不是夹具或产品的问题。
case "$FIXTURES" in
  /*) ;;
  *) FIXTURES="$(cd "$FIXTURES" 2>/dev/null && pwd)" \
       || { echo "⛔ 夹具目录不存在" >&2; exit 3; } ;;
esac
for f in "$SWIFT" "$FAKE" "$HARNESS" "$SRC/index.html" "$SRC/vendor/cm6.bundle.js"; do
  [ -f "$f" ] || { echo "⛔ 缺 ${f}（\`make cm6\`？）" >&2; exit 3; }
done
ls "$FIXTURES"/*.md >/dev/null 2>&1 || { echo "⛔ 夹具目录里没有 .md：$FIXTURES" >&2; exit 3; }

WORK="$HERE/.cg-work"
rm -rf "$WORK"; mkdir -p "$WORK"

# ── ① Stage A：真 comrak 导出载荷 ──
FIXTURE_JSON="$WORK/fixtures.json"
echo "▶ Stage A：真 comrak 导出载荷…" >&2
( cd "$ROOT/src-tauri" && RMD_LIVE_BLOCK_DIR="$FIXTURES" RMD_LIVE_BLOCK_OUT="$FIXTURE_JSON" \
  cargo test --release --offline --features gui -- --ignored --nocapture live_block \
  >"$WORK/stage-a.log" 2>&1 ) || {
  echo "⛔ Stage A 失败：" >&2; sed -n '1,40p' "$WORK/stage-a.log" >&2; exit 3; }
[ -s "$FIXTURE_JSON" ] || { echo "⛔ Stage A 没产出载荷" >&2; exit 3; }

python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
for doc in d["docs"]:
    print(doc["name"])
' "$FIXTURE_JSON" > "$WORK/names.txt"
if [ -n "$ONLY" ]; then
  grep -qx "$ONLY" "$WORK/names.txt" || { echo "⛔ 没有夹具 $ONLY" >&2; exit 3; }
  printf '%s\n' "$ONLY" > "$WORK/names.txt"
fi

# ── ② 组装页面（产品 `src/` 整棵拷进去；注入夹具 / 假后端 / harness / 点号）──
#
# 变异（只打**页面副本**）：每条都对应**一条后置不变量**，目的是证明那一条真能红：
#   M1 → ① 未捕获异常      点下去必抛
#   M2 → ④ 块位移          被点那一块当场下沉 40 px
#   M3 → ③ editable=0 进编辑  两道闸（main.js 提示闸 + live/index.js 真闸）一起拆
#   M4 → ② 块数变化无提交   点下去直接删掉最后一块
#   M5 → ⑤ 未知 IPC        把 `begin_edit` 这条命令名改坏
#   M6 → ⑥ 进了编辑没焦点  把 `focusAt` 那一步停掉
#   M7 → ④ 的归因（不判红）把 U6 锚定的 `scrollTop` 补丁换成 +0
# ⚠️ 目标串都在 `build_page` 里**字面**写死，好让 `tests/js/probe-targets.test.js`
#    静态审计到（命中数 ≠ 1 ⇒ 变异作废）。
# ⚠️ 目标串都在 `build_page` 里**字面**写死，好让 `tests/js/probe-targets.test.js`
#    静态审计到（命中数 ≠ 1 ⇒ 变异作废）。
apply_mutation() {
  local file="$1" old="$2" new="$3"
  local before after
  before="$(cksum "$file" | awk '{print $1}')"
  python3 -I - "$file" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as f:
    src = f.read()
hits = src.count(old)
if hits != 1:
    print("HITS=%d（期望 1）" % hits, file=sys.stderr)
    sys.exit(4)
with open(path, "w", encoding="utf-8") as f:
    f.write(src.replace(old, new))
print("HITS=1", file=sys.stderr)
PY
  after="$(cksum "$file" | awk '{print $1}')"
  if [ "$before" = "$after" ]; then
    echo "⚠️⚠️ 变异**没改到文件**：$file" >&2
    exit 4
  fi
}

build_page() {
  local dir="$1" name="$2"
  rm -rf "$dir"; mkdir -p "$dir"
  cp -R "$SRC/." "$dir/"
  python3 -I - "$FIXTURE_JSON" "$name" "$dir/__fixture.js" <<'PY'
import json, sys
src, name, out = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src, encoding="utf-8"))
doc = next(x for x in d["docs"] if x["name"] == name)
doc["shortcuts"] = d.get("shortcuts") or []
with open(out, "w", encoding="utf-8") as f:
    f.write("window.__FIXTURE = " + json.dumps(doc, ensure_ascii=False) + ";\n")
    f.write("""
window.__ERR = [];
window.addEventListener('error', function (e) {
  if (!e || e.target !== window) return;
  var st = '';
  try {
    st = e.error && e.error.stack ? String(e.error.stack).slice(0, 400) : '';
  } catch (e2) { void e2; }
  window.__ERR.push(String(e.message || '') + ' @' +
    String(e.filename || '').split('/').pop() + ':' + (e.lineno || 0) +
    (st ? ' ⟵ ' + st : ''));
}, true);
window.addEventListener('unhandledrejection', function (e) {
  var r = e && e.reason;
  window.__ERR.push('rejection: ' + String((r && r.message) || r || '').slice(0, 200));
}, true);
""")
PY
  cp "$FAKE" "$dir/__fake-tauri.js"
  cp "$HARNESS" "$dir/__harness.js"
  printf 'window.__POINT = 0;\n' > "$dir/__point.js"
  python3 -I - "$dir/index.html" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
needle = '  <script src="vendor/cm6.bundle.js"></script>\n'
if src.count(needle) != 1:
    print("HITS=%d（期望 1）" % src.count(needle), file=sys.stderr); sys.exit(4)
src = src.replace(needle, '  <script src="__fixture.js"></script>\n'
                           '  <script src="__point.js"></script>\n'
                           '  <script src="__fake-tauri.js"></script>\n' + needle)
tail = '</body>\n</html>'
if src.count(tail) != 1:
    print("TAIL=%d（期望 1）" % src.count(tail), file=sys.stderr); sys.exit(4)
src = src.replace(tail, '  <script src="__harness.js"></script>\n' + tail)
open(path, "w", encoding="utf-8").write(src)
PY
  # ⚠️ 注入脚本语法错的表现是"应用没启动"（`共` 取不到、0 个点），与"夹具有问题"
  #    长得一模一样 —— 2026-11-04 实测踩过（Python 三引号把 `\n` 吃成了真换行）。
  #    ⇒ 组装完立刻 `node --check`，⛔ 不让它退化成一个空扫描。
  local f
  for f in "$dir/__fixture.js" "$dir/__point.js" "$dir/__harness.js"; do
    node --check "$f" >/dev/null 2>"$WORK/node-check.log" || {
      echo "⛔ 注入脚本语法错误：$f" >&2; sed -n '1,12p' "$WORK/node-check.log" >&2; exit 4; }
  done
  # ── 变异（只改页面副本）──
  if [ "$MUT" = "M1" ]; then
    apply_mutation "$dir/main.js" \
"  function onLiveDocDown(ev) {" \
"  function onLiveDocDown(ev) {
    throw new Error('MUTATION-1');" || {
      echo "⛔ 变异 M1 没命中（靶子漂了）" >&2; exit 4; }
  elif [ "$MUT" = "M2" ]; then
    apply_mutation "$dir/main.js" \
"    if (!live) return;
    if (ev.button !== 0) return;" \
"    if (!live) return;
    if (ev.button !== 0) return;
    var __b = ev.target && ev.target.closest ? ev.target.closest('#doc > *') : null;
    if (__b) __b.style.marginTop = '40px';" || {
      echo "⛔ 变异 M2 没命中（靶子漂了）" >&2; exit 4; }
  elif [ "$MUT" = "M3" ]; then
    # ⚠️ `editable=0` 有**两道闸**：`main.js` 那道只负责提示，真正拦住的是
    #    `live/index.js::begin` 里那道（2026-11-04 实测：只拆外面那道，点公式块
    #    仍然是 `begin_edit=0` ⇒ 判据 ③ 一个红点都不出，变异**不承重**）。
    #    ⇒ 两道一起拆，才是「可编辑性判据被拿掉」这个真实缺陷形状。
    apply_mutation "$dir/main.js" \
"    if (block.editable !== true) {" \
"    if (false) {" || {
      echo "⛔ 变异 M3 没命中（靶子漂了）" >&2; exit 4; }
    apply_mutation "$dir/live/index.js" \
"      } else if (block.editable !== true) {" \
"      } else if (false) {" || {
      echo "⛔ 变异 M3（内层闸门）没命中（靶子漂了）" >&2; exit 4; }
  elif [ "$MUT" = "M4" ]; then
    apply_mutation "$dir/main.js" \
"    if (!live) return;
    if (ev.button !== 0) return;" \
"    if (!live) return;
    if (ev.button !== 0) return;
    var __d = document.getElementById('doc');
    if (__d && __d.lastElementChild) __d.lastElementChild.remove();" || {
      echo "⛔ 变异 M4 没命中（靶子漂了）" >&2; exit 4; }
  elif [ "$MUT" = "M5" ]; then
    apply_mutation "$dir/services/session.js" \
"    return T.call('begin_edit', { generation: state.generation });" \
"    return T.call('begin_edit_X', { generation: state.generation });" || {
      echo "⛔ 变异 M5 没命中（靶子漂了）" >&2; exit 4; }
  elif [ "$MUT" = "M6" ]; then
    # ⚠️ `bugs/0084` 起这一行多了第二个参数 `{ reading: true }`：靶子跟着改，
    #    ⛔ 别把"靶子漂了"当成判据不承重。
    apply_mutation "$dir/live/index.js" \
"      else if (view.focusAt && r.point) view.focusAt(r.point, { reading: true });" \
"      else if (false) view.focusAt(r.point, { reading: true });" || {
      echo "⛔ 变异 M6 没命中（靶子漂了）" >&2; exit 4; }
  elif [ "$MUT" = "M7" ]; then
    # M7 → ④ 的**归因**：把 U6 锚定的那一次 `scrollTop` 补丁掐掉。若红点消失 ⇒
    #      位移来自 `anchorAt`（产品**自己**在滚页面），⛔ 不是内容重排。
    apply_mutation "$dir/main.js" \
"            sc.scrollTop += delta;" \
"            sc.scrollTop += 0;" || {
      echo "⛔ 变异 M7 没命中（靶子漂了）" >&2; exit 4; }
  fi
}

# ── ③ 运行器 ──
BIN="$WORK/clickgrid-probe"
echo "▶ 编译运行器…" >&2
swiftc -O "$SWIFT" -o "$BIN" >"$WORK/build.log" 2>&1 || {
  echo "⛔ 编译失败：" >&2; sed -n '1,40p' "$WORK/build.log" >&2; exit 3; }

# 一次点：写点号 → 跑 → 取 JSON。⚠️ 兜底超时 40 s（正常一点 ~2 s）。
run_point() {
  local page="$1" i="$2" raw="$3"
  printf 'window.__POINT = %d;\nwindow.__TWO = %s;\n' "$i" "$TWO_STEP" > "$page/__point.js"
  "$BIN" "$page" >"$raw" 2>"$raw.err" &
  local pid=$!
  local n
  for n in $(seq 1 80); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    echo "⛔ 点 $i 超过 40 秒，强杀" >&2; exit 3
  fi
  wait "$pid" 2>/dev/null || true
  if ! grep -q '^{' "$raw" 2>/dev/null; then
    echo "⛔ 点 $i 没产出 JSON。stderr：" >&2
    sed -n '1,20p' "$raw.err" >&2
    exit 3
  fi
}

# ── ④ 逐夹具扫描 ──
ALL="$WORK/rows.jsonl"
: > "$ALL"

while read -r NAME; do
  [ -n "$NAME" ] || continue
  PAGE="$WORK/page-$NAME"
  build_page "$PAGE" "$NAME"
  echo "▶ 夹具 ${NAME}：先跑第 0 点探总点数…" >&2
  run_point "$PAGE" 0 "$WORK/$NAME-0.json"
  N=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1],encoding="utf-8")).get("共",0))' "$WORK/$NAME-0.json")
  if [ "${N:-0}" -le 0 ]; then
    # ⚠️⚠️ **不许静默跳过**：环境无效（屏幕锁 / 显示器睡眠 ⇒ rAF 0/8）与应用没起来
    #    在输出上都长得像"0 个点"，而旧版这里 `continue` 之后汇总会打印
    #    "0 个点，0 个红点" 并**退 0**——把"没测成"记成了"全绿"（2026-11-04 实测踩过）。
    #    ⇒ 记一条 `环境无效` 行，汇总那边据此退 3。
    python3 -I - "$WORK/$NAME-0.json" "$NAME" >> "$ALL" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
why = d.get("致命") or d.get("环境") or d
print(json.dumps({"夹具": sys.argv[2], "环境无效": True, "原因": why}, ensure_ascii=False))
PY
    echo "⚠️ ${NAME}：第 0 点没给出总点数 —— $(python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
print(d.get("致命") or d.get("结果") or d.get("环境") or d)
' "$WORK/$NAME-0.json" 2>&1 | head -c 400)" >&2
    continue
  fi
  TOTAL=$N
  [ "$MAX" -gt 0 ] && [ "$((FROM + MAX * STRIDE))" -lt "$N" ] && N=$((FROM + MAX * STRIDE))
  # ⚠️ 打印**真空集**与**本轮抽样多少**：只写"共 N 个点"会让人以为那 N 个都是实扫过的
  #    （2026-11-04 踩过：真文档被 `--max` 截到 108，看起来"扫了 108 个点"）。
  echo "▶ ${NAME}：全集 ${TOTAL} 个点，本轮扫 $(( (N - FROM + STRIDE - 1) / STRIDE )) 个（从 ${FROM} 起，步长 ${STRIDE}，逐点重开页面）…" >&2
  i=$FROM
  while [ "$i" -lt "$N" ]; do
    if [ "$i" -eq 0 ] && [ -f "$WORK/$NAME-0.json" ]; then RAW="$WORK/$NAME-0.json"
    else
      RAW="$WORK/$NAME-$i.json"; run_point "$PAGE" "$i" "$RAW"
    fi
    python3 -I - "$RAW" "$NAME" >> "$ALL" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
if d.get("致命"):
    print(json.dumps({"夹具": sys.argv[2], "致命": d["致命"]}, ensure_ascii=False)); raise SystemExit
r = d.get("结果")
if not r:
    print(json.dumps({"夹具": sys.argv[2], "点序号": d.get("点序号"), "跳过": d.get("结果") or d.get("环境")}, ensure_ascii=False)); raise SystemExit
r = dict(r); r["夹具"] = sys.argv[2]
print(json.dumps(r, ensure_ascii=False))
PY
    i=$((i + STRIDE))
  done
done < "$WORK/names.txt"

# ── ⑤ 汇总：红点表进退出码 ──
# ⚠️ 汇总逻辑单独在 `clickgrid-summary.py`：**报告器本身要有判据**
#    （`tests/js/probe-report.test.js` 拿构造的 rows 验 0/1/3 三条退出码）。
python3 -I "$HERE/clickgrid-summary.py" "$ALL" "$TO_JSON"
