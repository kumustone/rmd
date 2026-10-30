#!/usr/bin/env bash
# 从 `src-tauri/icons/icon.svg` 生成两份**可重建产物**（`design/0015` §2.1 ③）：
#
#   src-tauri/icons/icon.png    1024×1024，`tauri-codegen` 的窗口图标要求
#   src-tauri/icons/rmd.icns    Dock / Finder 图标（由 10 个尺寸的 iconset 打包）
#
# ⭐ **唯一可编辑的输入是 `icon.svg`**（`INV-APP-05`）。本脚本只做确定性转换：
#    ⛔ 不手改 png / icns，⛔ 不使用字体渲染（避免 `sips` 的字体依赖）。
#
# ⚠️ `sips` 对 SVG 的支持是基础子集。若它渲染出空白/走样，回退方案是
#    `qlmanage -t -s 1024 -o <dir> icon.svg`（产物名会变成 `icon.svg.png`）；
#    两条都失败 ⇒ **停下报告**，⛔ 不手搓 icns（`design/0015` §6 的失败模型）。
#
# 用法：scripts/make-icon.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/src-tauri/icons/icon.svg"
OUT_PNG="$ROOT/src-tauri/icons/icon.png"
OUT_ICNS="$ROOT/src-tauri/icons/rmd.icns"
WORK="$ROOT/build/rmd.iconset"

[ -f "$SRC" ] || { echo "⛔ 找不到图标源：$SRC" >&2; exit 1; }
command -v sips >/dev/null || { echo "⛔ 没有 sips（macOS 自带；这不是 macOS？）" >&2; exit 1; }
command -v iconutil >/dev/null || { echo "⛔ 没有 iconutil（macOS 自带）" >&2; exit 1; }

rm -rf "$WORK"
mkdir -p "$WORK"

echo "▶ sips 渲染 SVG → 1024 PNG"
TMP_PNG="$ROOT/build/icon-1024.png"
mkdir -p "$ROOT/build"
if ! sips -s format png "$SRC" --out "$TMP_PNG" >/dev/null 2>&1; then
  echo "⚠️ sips 渲染 SVG 失败，回退 qlmanage" >&2
  QL_DIR="$ROOT/build/qlmanage"
  rm -rf "$QL_DIR"; mkdir -p "$QL_DIR"
  qlmanage -t -s 1024 -o "$QL_DIR" "$SRC" >/dev/null 2>&1 || true
  if [ -f "$QL_DIR/icon.svg.png" ]; then
    mv "$QL_DIR/icon.svg.png" "$TMP_PNG"
  else
    echo "⛔ sips 与 qlmanage 都没能渲染 $SRC —— 停下，⛔ 不手改 icns" >&2
    exit 1
  fi
fi

# ⚠️ 尺寸判据：SVG 若不是 1024×1024，后面所有 `-z` 都会以错误基准缩放。
W="$(sips -g pixelWidth "$TMP_PNG" 2>/dev/null | awk '/pixelWidth/ {print $2}')"
H="$(sips -g pixelHeight "$TMP_PNG" 2>/dev/null | awk '/pixelHeight/ {print $2}')"
if [ "$W" != "1024" ] || [ "$H" != "1024" ]; then
  echo "⛔ 渲染结果是 ${W}x${H}，不是 1024x1024 —— 检查 icon.svg 的 width/height" >&2
  exit 1
fi

# iconset 的 10 个文件名是 `iconutil` 的硬要求（⛔ 不能换名）。
mk() { # $1 = 像素边长，$2 = iconset 里的文件名
  sips -z "$1" "$1" "$TMP_PNG" --out "$WORK/$2" >/dev/null
}
mk 16   icon_16x16.png
mk 32   icon_16x16@2x.png
mk 32   icon_32x32.png
mk 64   icon_32x32@2x.png
mk 128  icon_128x128.png
mk 256  icon_128x128@2x.png
mk 256  icon_256x256.png
mk 512  icon_256x256@2x.png
mk 512  icon_512x512.png
mk 1024 icon_512x512@2x.png

echo "▶ iconutil → $(basename "$OUT_ICNS")"
iconutil -c icns "$WORK" -o "$OUT_ICNS"

cp "$TMP_PNG" "$OUT_PNG"

echo "✓ ${OUT_PNG}（1024）"
echo "✓ ${OUT_ICNS}（$(du -h "$OUT_ICNS" | cut -f1)）"
