#!/usr/bin/env bash
# 跑「编辑分栏外壳」的**离屏视觉闸门**（`edit-chrome-probe.swift`）
#
# 用法：
#   tools/wkwebview-probe/edit-chrome-probe.sh                  # 浅色，只打屏幕
#   tools/wkwebview-probe/edit-chrome-probe.sh --theme dark
#   tools/wkwebview-probe/edit-chrome-probe.sh --png /tmp/x.png  # 另存一张快照（⚠️ 仅作参考）
#   tools/wkwebview-probe/edit-chrome-probe.sh --json
#
# 退出码：0 = 全通过；1 = 有判据失败；2 = 环境自证没过（bundle 不在）；3 = 跑不起来
#
# ⚠️ 它是**离屏**的（窗口 `alphaValue = 0`，默认连 `orderBack` 都不做）：
#    ⛔ 不动用户的前台窗口、⛔ 不合成按键（根 `CLAUDE.md` §4）。
# ⚠️ 前置：`src/vendor/cm6.bundle.js` 必须先由 `make cm6` 产出（要 node）。
#
# ⚠️ 为什么需要它：这一域改的是**纯 CSS + 伪元素**（滚动条 / 焦点态 / 分界线），
#    `make test-js` 够不着、浏览器也不会为它们报任何错。
#    按「⛔ 不能把全部正确性验证都归给人工」，能断言的就别留给眼睛。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

THEME=light
PNG=""
PASSTHRU=()
while [ $# -gt 0 ]; do
  case "$1" in
    --theme) THEME="${2:-light}"; PASSTHRU+=(--theme "$THEME"); shift 2 ;;
    --png)   PNG="${2:-}";        PASSTHRU+=(--png "$PNG");       shift 2 ;;
    --json)  PASSTHRU+=(--json); shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 3 ;;
  esac
done

BUNDLE="$ROOT/src/vendor/cm6.bundle.js"
if [ ! -s "$BUNDLE" ]; then
  echo "⛔ 找不到 $BUNDLE —— 先跑 \`make cm6\`（它是产物，不入库）" >&2
  exit 3
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/edit-chrome-probe"

# ── 现搭一个页面目录：**真**的样式表 + **真**的 CM6 产物（⛔ 不抄第二份） ──
# ⚠️ 用 `cp` 而**不是**符号链接：`allowingReadAccessTo` 只放行该目录**真身**下的读取。
PAGE="$WORK/page"
mkdir -p "$PAGE/vendor"
cp -R "$ROOT/src/styles" "$PAGE/styles"
cp "$ROOT/src/style.css" "$PAGE/style.css"
cp "$BUNDLE" "$PAGE/vendor/cm6.bundle.js"
# ⚠️ `index.html` 由 `.swift` 现写进去（主题名要插值，放在 shell 里会在两处有第二份标记）

swiftc -O "$HERE/edit-chrome-probe.swift" -o "$BIN" >"$WORK/build.log" 2>&1 || {
  echo "⛔ 编译失败：" >&2; cat "$WORK/build.log" >&2; exit 3
}

"$BIN" "$PAGE" "${PASSTHRU[@]+"${PASSTHRU[@]}"}"
