#!/usr/bin/env bash
# `make probe-type-metrics`：C2 的前置实测（`design/0085` §7 第 0 条）。
#
# 只做四件事：拷页面 → 拷三张阅读态样式表 → 编译跑器 → 跑一轮。
# ⭐ 跑器**复用** `tools/live-probe/probe.swift`（离屏、`.prohibited`、alpha 0、`orderBack`，
#    ⛔ 不激活、⛔ 不抢焦点）——那一份的激活策略是实测出来的（`docs/kb/0025`），⛔ 不另起一份。
#
# 用法：
#   tools/type-metrics-probe/run.sh            # 一行 JSON 到 stdout
#   tools/type-metrics-probe/run.sh --pretty   # 缩进过的 JSON（人读）
#
# 退出码：0 = 拿到结果且仿射成立；1 = 仿射不成立（结论在 JSON 里）；3 = 跑不起来
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$HERE/.work"
PRETTY=0
for a in "$@"; do
  case "$a" in
    --pretty) PRETTY=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "⛔ 不认识的参数：$a" >&2; exit 3 ;;
  esac
done

command -v swiftc >/dev/null 2>&1 || { echo "⛔ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2; exit 3; }

rm -rf "$WORK/page"
mkdir -p "$WORK/page/styles"
cp "$HERE/index.html" "$HERE/harness.js" "$WORK/page/"
cp "$ROOT/src/styles/tokens.css" "$ROOT/src/styles/themes.css" "$ROOT/src/styles/typography.css" \
   "$WORK/page/styles/"

if [ ! -x "$WORK/runner" ] || [ "$ROOT/tools/live-probe/probe.swift" -nt "$WORK/runner" ]; then
  echo "▶ 编译跑器（复用 tools/live-probe/probe.swift）…" >&2
  swiftc -O "$ROOT/tools/live-probe/probe.swift" -o "$WORK/runner" >&2
fi

set +e
OUT="$("$WORK/runner" "$WORK/page" 2>"$WORK/run.err")"
CODE=$?
set -e
sed -e 's/^/  probe│ /' "$WORK/run.err" >&2 || true
[ "$CODE" -eq 0 ] || { echo "⛔ 跑器失败（退出 ${CODE}），日志：${WORK}/run.err" >&2; exit 3; }

if [ "$PRETTY" -eq 1 ]; then
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s),null,2)))' <<<"$OUT"
else
  printf '%s\n' "$OUT"
fi

# ⚠️ 结论走退出码：仿射不成立是**产品结论**（样式表里混进了字面量），不是探针故障。
node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const o=JSON.parse(s);
    process.exit(o.结论 && o.结论.通过 ? 0 : 1);
  });' <<<"$OUT"
