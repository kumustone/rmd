#!/usr/bin/env bash
#
# 手工打一个**本地候选** DMG（开源准备 · 工作项 6 的本地那一半）。
#
# ⚠️ 这不是"发布"：没有 Developer ID，没有公证，没有上传。
#    产物只放在 `build/dmg/`（gitignore），文件名与校验值写进终端。
#
# 产物结构（`hdiutil` 的 srcfolder）：
#   rmd.app                  ← `make app` 组装并 ad-hoc 重签的那一份（INV-APP-01）
#   Applications -> /Applications   ← 拖拽安装的落点（只是个符号链接）
#   THIRD-PARTY-NOTICES.md   ← 第三方声明（含 GPL 阻断项的说明）
#   BUILDING.md              ← 从源码构建的方法
#   README.txt               ← 安装三步 ＋ Gatekeeper 提示 ＋ "GPL-3.0-or-later，可再分发" 的明示
#
# ⛔ 不做的事：
#   - 不挂载 DMG（`hdiutil create` 本身不挂载；挂载会弹 Finder 窗口）
#   - 不复制前端资源（已嵌在二进制里）
#   - 不动 `~/Applications`、⛔ 不装到系统目录
#   - ⛔ 不覆盖已有 DMG（除非 FORCE=1）——同一天重跑请先改名
#
# 用法：scripts/make-dmg.sh [--force]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CONF="$ROOT/src-tauri/tauri.conf.json"
APP="$ROOT/build/macos/rmd.app"
OUTDIR="$ROOT/build/dmg"
STAGE="$OUTDIR/staging"

say() { echo "$@"; }
die() { echo "⛔ $*" >&2; exit 1; }

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) die "未知参数：${arg}（只认 --force）" ;;
  esac
done

[ -d "$APP" ] || die "没有 $APP —— 先跑 make app"
command -v hdiutil >/dev/null || die "没有 hdiutil"
command -v plutil >/dev/null || die "没有 plutil"

VERSION="$(plutil -extract version raw "$CONF")"
[ -n "$VERSION" ] || die "从 $CONF 读不出 version"
ARCH="$(lipo -archs "$APP/Contents/MacOS/rmd" 2>/dev/null || echo unknown)"
DMG="$OUTDIR/rmd-$VERSION-$ARCH.dmg"

# ⚠️ 版本一致性：`.app` 的 plist 与 `tauri.conf.json` 必须同源。
#    二进制自身的版本由 `env!("CARGO_PKG_VERSION")` 决定（Cargo.toml），
#    ⛔ 与 plist 不是同一个来源 ⇒ 这里顺带把三者对一遍，不一致就停。
PLIST_VERSION="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")"
CARGO_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/src-tauri/Cargo.toml" | head -1)"
[ "$VERSION" = "$PLIST_VERSION" ] || die "版本不一致：tauri.conf=${VERSION}，.app plist=${PLIST_VERSION}（重跑 make app）"
[ "$VERSION" = "$CARGO_VERSION" ] || die "版本不一致：tauri.conf=${VERSION}，Cargo.toml=$CARGO_VERSION"

if [ -e "$DMG" ] && [ "$FORCE" -ne 1 ]; then
  die "$DMG 已存在。同一天重跑请先改名，或显式 FORCE=1（⚠️ 会覆盖）"
fi

say "▶ 版本 $VERSION · 架构 $ARCH"
say "▶ 组装 staging"
rm -rf "$STAGE"
mkdir -p "$STAGE"
# ⚠️ 用 ditto 保留签名与资源分叉，⛔ 不用 cp -R（会破坏 _CodeSignature 的元数据）。
ditto "$APP" "$STAGE/rmd.app"
ln -s /Applications "$STAGE/Applications"
cp "$ROOT/THIRD-PARTY-NOTICES.md" "$STAGE/THIRD-PARTY-NOTICES.md"
cp "$ROOT/BUILDING.md" "$STAGE/BUILDING.md"

cat > "$STAGE/README.txt" <<TXT
rmd $VERSION (macOS, $ARCH) — local candidate build
============================================================

Install:
  1. Drag rmd.app into the Applications folder (the symlink next to it).
  2. The app is ad-hoc signed and not notarized. On first launch macOS may
     block it: open System Settings -> Privacy & Security, find the rmd
     message, and choose "Open Anyway". Alternatively, right-click the app
     and choose Open.
  3. Terminal use (optional): open rmd, then use the menu
       rmd -> Install Command Line Tool...
     It creates a link that follows the app, so it keeps working after you
     replace rmd.app with a newer version. If ~/.local/bin is not on your
     PATH, the app says so after installing; add it to ~/.zshrc and open a
     new terminal.
     Fallback (manual, same effect but does not follow app upgrades):
       ln -sf /Applications/rmd.app/Contents/MacOS/rmd ~/.local/bin/rmd
     Then: rmd /path/to/document.md
     (When both stdout and stderr are a terminal, rmd returns to the prompt
     immediately and keeps running in the background.)

License:
  rmd is free software under the GNU General Public License, version 3 or
  later (GPL-3.0-or-later); the full text is in the source repository's
  LICENSE file. You may redistribute this build as long as you follow the
  GPL: pass along the license and make the corresponding source available.
  Bundled third-party components and their licenses are listed in
  THIRD-PARTY-NOTICES.md. The diagram renderer is GPL-3.0-or-later as well,
  so this build is redistributable under the GPL; that file lists every
  bundled component and the obligations attached to it.

Build from source: see BUILDING.md.
TXT

say "▶ 生成 DMG"
hdiutil create -volname "rmd $VERSION" -srcfolder "$STAGE" -format UDZO -ov "$DMG" >/dev/null

say "▶ 校验"
# ⚠️ 在 OUTDIR 里按**文件名**算，⛔ 不写绝对路径：这份 `.sha256` 会随 Release 发布，
#    写成绝对路径既泄露构建机路径，又让下载的人 `shasum -a 256 -c` 找不到文件。
( cd "$OUTDIR" && shasum -a 256 "$(basename "$DMG")" | tee "$(basename "$DMG").sha256" )
say ""
say "✓ 本地候选产物：$DMG"
say "  ⛔ 未签名（Developer ID）、未公证、⛔ 未上传；许可证 GPL-3.0-or-later（可再分发，须随附源码）"
