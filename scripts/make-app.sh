#!/usr/bin/env bash
# 手工组装 `build/macos/rmd.app`（`design/0015` §2.1 ①）。
#
# 产物结构：
#   build/macos/rmd.app/Contents/
#     Info.plist          ← src-tauri/macos/Info.plist（版本号由 tauri.conf.json 注入）
#     PkgInfo             ← APPL????
#     MacOS/rmd           ← `make build-gui` 的**同一份**二进制（INV-APP-01）
#     Resources/rmd.icns  ← scripts/make-icon.sh 产出
#     _CodeSignature/     ← codesign 产出
#
# ⛔ 不复制前端资源：`frontendDist` 已在编译期嵌进二进制（docs/kb/0006）。
# ⛔ 不引入 tauri-cli：`bundle.active` 保持 false（adr/0011）。
#
# 用法：scripts/make-app.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BIN="$ROOT/src-tauri/target/release/rmd"
CONF="$ROOT/src-tauri/tauri.conf.json"
PLIST_T="$ROOT/src-tauri/macos/Info.plist"
ICNS="$ROOT/src-tauri/icons/rmd.icns"
APP="$ROOT/build/macos/rmd.app"
APP_ID="io.github.kumustone.rmd"

say() { echo "$@"; }
die() { echo "⛔ $*" >&2; exit 1; }

[ -x "$BIN" ] || die "没有 $BIN —— 先跑 make build-gui"
grep -q 'rmd://menu' "$BIN" 2>/dev/null || die "$BIN 不含 GUI（先跑 make build-gui）"
[ -f "$PLIST_T" ] || die "找不到 plist 模板：$PLIST_T"
command -v plutil >/dev/null || die "没有 plutil"
command -v codesign >/dev/null || die "没有 codesign"

VERSION="$(plutil -extract version raw "$CONF")"
[ -n "$VERSION" ] || die "从 $CONF 读不出 version"
say "▶ 版本：$VERSION"

# ⭐ 图标按需重建：SVG 比 icns 新（或 icns 不存在）时才跑，避免每次 make app 都重渲。
if [ ! -f "$ICNS" ] || [ "$ROOT/src-tauri/icons/icon.svg" -nt "$ICNS" ]; then
  bash "$HERE/make-icon.sh"
else
  say "ℹ️ 图标源没变 ⇒ 复用 $(basename "$ICNS")（要强制重建：rm -f it 后重跑）"
fi
[ -f "$ICNS" ] || die "缺少 $ICNS"

say "▶ 组装 $(basename "$APP")"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
install -m 755 "$BIN" "$APP/Contents/MacOS/rmd"
cp "$ICNS" "$APP/Contents/Resources/rmd.icns"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# ⭐⭐ `INV-APP-01` 的**逐字节判据只能在这一刻跑**（2026-10-19 实测）：
#     `codesign --sign - <bundle>`（带不带 `--force` 都一样）会**重写**主可执行文件——
#     它要往 Mach-O 里写绑定了 `Info.plist` 的 CodeDirectory
#     （`Info.plist entries=15`，标识符也从 linker 的 `rmd-…` 变成 bundle id）。
#     ⇒ 签名之后 `cmp` 必然不等，那**不是**"装错了"，是签名本身。
cmp -s "$BIN" "$APP/Contents/MacOS/rmd" || die ".app 里的二进制与 $(basename "$BIN") 不同"
# ⚠️ 把"放进来那一刻"的**内容哈希**写进 bundle：签名之后，它是唯一还能与
#    `target/release/rmd` 对账的东西（`make doctor` / `make smoke-app` 都用它）。
#    ⛔ 它**不是**判据本身——判据上面那条 `cmp`；这只是给"事后核对"留的证据。
shasum -a 256 "$BIN" | awk '{print $1}' > "$APP/Contents/Resources/build-id.txt"

# ⚠️ `sed` 的替换串里版本号只含数字与点，转义风险可控；但仍然只替换模板里的那个占位符。
sed "s/__VERSION__/$VERSION/g" "$PLIST_T" > "$APP/Contents/Info.plist"

plutil -lint "$APP/Contents/Info.plist" >/dev/null || die "Info.plist 语法检查没过"
# ⭐ 判据：标识符必须与 tauri.conf.json 的 identifier 一致——默认处理器按它认应用。
GOT_ID="$(plutil -extract CFBundleIdentifier raw "$APP/Contents/Info.plist")"
[ "$GOT_ID" = "$APP_ID" ] || die "CFBundleIdentifier=${GOT_ID}，与配置里的 $APP_ID 不一致"

# ⚠️ `--force` 是必须的：二进制本身是 linker-signed 的 ad-hoc 签名，
#    bundle 层要重新签一遍。`--deep` **不用**（没有嵌套 bundle；Apple 已不推荐用它签名）。
say "▶ ad-hoc 重签"
codesign --force --sign - "$APP" >/dev/null || die "codesign 失败（⛔ 不产出半成品）"
codesign --verify --strict "$APP" || die "codesign 校验没过"

# ⭐ `INV-APP-01` 的事后证据：签名会改主可执行文件（理由见上面那段），
#    所以这里核对的是**签名前记下的内容哈希**，而不是 `cmp`。
RECORDED="$(cat "$APP/Contents/Resources/build-id.txt")"
NOW="$(shasum -a 256 "$BIN" | awk '{print $1}')"
[ "$RECORDED" = "$NOW" ] || die "build-id.txt（${RECORDED}）与当前 $(basename "$BIN")（${NOW}）不符"

say "✓ $APP"
say "  Info.plist $(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")｜签名 $(codesign -dv "$APP" 2>&1 | awk -F= '/^Signature/ {print $2}')｜build-id ${NOW:0:12}"
say "  ⚠️ 还没注册到 LaunchServices —— 要装到 ~/Applications 跑 make install-app"
