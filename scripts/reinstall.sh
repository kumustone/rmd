#!/usr/bin/env bash
# 一条命令完成「重装」：强关旧实例 → 重编 GUI → 组装**一次** `.app` → 覆盖全部落点 → 校验 → 后台重启。
#
# 为什么要有它：`make install-app` 依赖 `make app`（`app` 又依赖 `build-gui`），
# 每装一个落点就把「组装 ＋ ad-hoc 重签」重跑一遍；装两处就白跑一遍，
# 而且每处各自重签 ⇒ 两份二进制不保证逐字节相同。本脚本只组装一次再 `ditto` 分发。
#
# 用法：
#   scripts/reinstall.sh                  # 全套
#   scripts/reinstall.sh --no-restart     # 装完不启动
#   scripts/reinstall.sh --no-build       # 复用现有 build/macos/rmd.app（只分发）
#   scripts/reinstall.sh --dirs=/Applications   # 只装指定目录（冒号分隔）
#
# ⛔ 不抢前台：重启一律 `open -g -j`；⛔ 不改系统默认打开程序（INV-APP-04）。
# ⚠️ `-g` **单独不够**（2026-11-15 实测＋源码取证）：`tao` 在 `launched()` 里**无条件**
#    `activateIgnoringOtherApps(true)`（`tao-0.37.1/src/platform_impl/macos/app_state.rs:284-293`、
#    `app_delegate.rs:106`，见 `docs/design/0022` §1.3）⇒ 只带 `-g` 照样把 rmd 顶到前台。
#    `-j`（LaunchServices 的 hidden 启动）才真的不抢：实测前台保持 iTerm2、进程在、
#    窗口仍在屏（1000×800，`CGWindowListCopyWindowInfo` 可查）、启动自证照常打完。见 `docs/kb/0023` §5。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BIN="$ROOT/src-tauri/target/release/rmd"
BUILD_APP="$ROOT/build/macos/rmd.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

DO_BUILD=1
DO_RESTART=1
DIRS=""
for arg in "$@"; do
  case "$arg" in
    --no-build)   DO_BUILD=0 ;;
    --no-restart) DO_RESTART=0 ;;
    --dirs=*)     DIRS="${arg#--dirs=}" ;;
    -h|--help)    sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "⛔ 不认识的参数：$arg" >&2; exit 2 ;;
  esac
done

die() { echo "⛔ $*" >&2; exit 1; }
say() { echo "$@"; }

cd "$ROOT"

# ── 1. 强关旧实例（⛔ 不等用户手关）────────────────────────────────────────────
# ⚠️ 必须按**启动路径**逐个匹配：应用内「安装命令行工具」建的软链
#    （~/.local/bin/rmd）会让进程的 argv[0] 变成软链路径，
#    只匹配 `/Applications/rmd.app/Contents/MacOS/rmd` 会漏杀（2026-11-11 实测漏掉一个）。
PATTERNS=(
  "/Applications/rmd.app/Contents/MacOS/rmd"
  "$HOME/Applications/rmd.app/Contents/MacOS/rmd"
  "$HOME/.local/bin/rmd"
  "$ROOT/build/macos/rmd.app/Contents/MacOS/rmd"
)
running() {
  local p
  for p in "${PATTERNS[@]}"; do
    pgrep -f -- "$p" >/dev/null 2>&1 && return 0
  done
  return 1
}
if running; then
  say "▶ 关闭旧实例"
  for p in "${PATTERNS[@]}"; do pkill -TERM -f -- "$p" 2>/dev/null || true; done
  for _ in $(seq 1 10); do running || break; sleep 0.5; done
  if running; then
    say "⚠️ 5 s 未退出 ⇒ SIGKILL"
    for p in "${PATTERNS[@]}"; do pkill -KILL -f -- "$p" 2>/dev/null || true; done
    sleep 1
  fi
  running && die "旧实例仍在运行，放弃安装（不会覆盖正在运行的程序）"
  say "✓ 旧实例已退出"
else
  say "ℹ️ 没有在运行的实例"
fi

# ── 2. 重编 ＋ 只组装一次 ────────────────────────────────────────────────────
if [ "$DO_BUILD" -eq 1 ]; then
  # ⚠️ 不走 `make app`：它依赖 `cm6`，而 `cm6` 每次都会重打包 `src/vendor/cm6.bundle.js`
  #    ⇒ tauri-codegen 重新嵌入前端资源 ⇒ **整链重编 87 s**，哪怕一个字都没改
  #    （2026-11-11 实测）。这里先自己判 bundle 是否过期，没过期就跳过打包。
  BUNDLE="$ROOT/src/vendor/cm6.bundle.js"
  bundle_stale=0
  if [ ! -s "$BUNDLE" ]; then
    bundle_stale=1
  else
    for f in "$ROOT"/tools/cm6/*.mjs "$ROOT/package.json" "$ROOT/package-lock.json"; do
      [ -e "$f" ] && [ "$f" -nt "$BUNDLE" ] && bundle_stale=1
    done
    [ -e "$ROOT/node_modules/.package-lock.json" ] && [ "$ROOT/node_modules/.package-lock.json" -nt "$BUNDLE" ] && bundle_stale=1
  fi
  if [ "$bundle_stale" -eq 1 ]; then
    say "▶ CM6 bundle 过期 ⇒ make cm6"
    make cm6 >/dev/null || die "make cm6 失败"
  else
    say "ℹ️ CM6 bundle 未过期 ⇒ 跳过打包（省掉一次整链重编）"
  fi
  say "▶ cargo build --release --features gui"
  ( cd "$ROOT/src-tauri" && cargo build --release --features gui ) >/dev/null || die "cargo build 失败"
  say "▶ 组装 .app"
  "$ROOT/scripts/make-app.sh" >/dev/null || die "make-app.sh 失败"
else
  say "ℹ️ --no-build：复用 $BUILD_APP"
fi
[ -d "$BUILD_APP" ] || die "没有 $BUILD_APP"

BUILD_ID="$(cat "$BUILD_APP/Contents/Resources/build-id.txt" 2>/dev/null || true)"
[ -n "$BUILD_ID" ] || die "$BUILD_APP 缺 build-id.txt"
SHORT_ID="${BUILD_ID:0:12}"
BIN_MTIME="$(stat -f '%m' "$BUILD_APP/Contents/MacOS/rmd")"

# 二进制必须晚于所有会进二进制的源码（前端资源是编译期**嵌入**的，改前端后不重编就是旧版）
STALE="$(find "$ROOT/src" "$ROOT/src-tauri/src" -type f \
           \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.rs' -o -name '*.json' -o -name '*.toml' \) \
           -newer "$BUILD_APP/Contents/MacOS/rmd" -print -quit 2>/dev/null || true)"
[ -z "$STALE" ] || die "产物比源码旧：$STALE —— 去掉 --no-build 重跑"

# ── 3. 分发到所有落点（同一份 ditto，⛔ 不再重新组装/签名）──────────────────────
if [ -z "$DIRS" ]; then
  DIRS="/Applications"
  [ -d "$HOME/Applications" ] && DIRS="$DIRS:$HOME/Applications"
fi
IFS=':' read -r -a DIR_LIST <<< "$DIRS"
say "▶ 落点：${DIR_LIST[*]}"

INSTALLED=()
for dir in "${DIR_LIST[@]}"; do
  [ -n "$dir" ] || continue
  target="$dir/rmd.app"
  mkdir -p "$dir"
  if [ -e "$target" ]; then
    say "ℹ️ 覆盖 $target"
    rm -rf "$target"
  fi
  ditto "$BUILD_APP" "$target" || die "ditto 到 $target 失败"
  "$LSREGISTER" -f "$target" >/dev/null 2>&1 || say "⚠️ lsregister 返回非零（LaunchServices 缓存可能没刷新）：$target"
  INSTALLED+=("$target")
  say "✓ $target"
done

# ── 4. 校验：build-id 一致 ＋ 二进制与构建产物逐字节一致 ──────────────────────
BUILD_SHA="$(shasum -a 256 "$BUILD_APP/Contents/MacOS/rmd" | cut -d' ' -f1)"
for target in "${INSTALLED[@]}"; do
  got_id="$(cat "$target/Contents/Resources/build-id.txt" 2>/dev/null || true)"
  [ "$got_id" = "$BUILD_ID" ] || die "$target 的 build-id（${got_id:0:12}）与构建产物（${SHORT_ID}）不一致"
  got_sha="$(shasum -a 256 "$target/Contents/MacOS/rmd" | cut -d' ' -f1)"
  if [ "$got_sha" != "$BUILD_SHA" ]; then
    say "⚠️ $target 的二进制与构建产物不是逐字节一致（sha ${got_sha:0:12} vs ${BUILD_SHA:0:12}）——签名可能不确定，build-id 已一致"
  fi
done
say "✓ 校验通过：build-id ${SHORT_ID}，二进制 mtime $(date -r $((BIN_MTIME)) '+%Y-%m-%d %H:%M:%S')"

# ── 5. 后台重启（⛔ 不抢前台）──────────────────────────────────────────────
if [ "$DO_RESTART" -eq 1 ]; then
  launch="${INSTALLED[0]}"
  for target in "${INSTALLED[@]}"; do
    case "$target" in /Applications/*) launch="$target" ;; esac
  done
  open -g -j "$launch"
  for _ in $(seq 1 20); do
    pid="$(pgrep -f -- "$launch/Contents/MacOS/rmd" 2>/dev/null | head -1 || true)"
    if [ -n "$pid" ]; then say "✓ 已在后台启动：${launch}（pid ${pid}）"; break; fi
    sleep 0.5
  done
  [ -n "${pid:-}" ] || die "启动后 10 s 没看到进程：$launch"
fi

say "ℹ️ 默认处理器没有被改（INV-APP-04）；要改：make default-app"
