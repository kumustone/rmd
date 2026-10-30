#!/bin/bash
# `design/0015` §7.1 的自动验收：`make smoke-app`。
#
# 判据全部进退出码；每一条打印 PASS/FAIL 与实测值。
#
# # ⛔ 操作红线（根 `CLAUDE.md` 工作约定 4）
#
# 这里会**真的启动应用**（那正是被测对象：LaunchServices → launchd → 窗口）。
# 所以：
#   · `open` 一律带 `-g`（⛔ 不把应用带到前台）；
#   · ⛔ 绝不 `kill -9`（那会让 LaunchServices 认为应用崩溃过）——
#     正常路径是 `osascript … to quit`，退路是 SIGTERM；
#   · **如果用户已经在用 rmd（任何一份 `.app`）就整轮拒绝**，
#     ⛔ 绝不为了跑冒烟去杀用户的实例。判据是 pgrep 到 `/rmd.app/Contents/MacOS/rmd`。
#
# # 两份样本（⚠️⚠️ 第 6 条的样本**必须是长文档**，2026-10-21 踩过）
#
# 第 6/7 条用 `docs/tasks.md`（长文档、中文）；第 9 条换成 `tools/ime-sample.md`
# （小而全，中文），目的是让"第二条 Apple Event"在日志里可分辨。
#
# ⚠️⚠️ **为什么第 6 条不能用小而全那份**：应用自证的那条 `PASS` 里含
#   `gui/mod.rs` 的 `scrollable = scroll_height > viewport_height * 1.5`
#   —— 那个 1.5 倍是**批 1 验收的夹具假定**（语料是 4 个 XL 文件），
#   ⛔ 不是"这份文档能不能滚"。小样本在**用户自己的外观设置**下渲染出来只有
#   **1.45 屏**（2026-10-21 实测：`滚动高度=1115 视口=769`，`1115 < 1153.5`）
#   ⇒ **应用完全正常，验收却报 FAIL**，而且换个字号/内容宽就会翻面
#   （`docs/bugs/0010`）。换成长文档后它稳定在 **27565 / 769 ≈ 36 屏**。
#   ⛔ 别把判据的 1.5 改小来迁就——那会同时削弱 `make smoke` 对批 1 语料的保护。

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/macos/rmd.app"
APP_BIN="$APP/Contents/MacOS/rmd"
BIN="$ROOT/src-tauri/target/release/rmd"
# ⚠️ 2026-10-23（GitHub 首次公开前的边界收紧）：`docs/` **整棵不公开**
#   ⇒ 公开候选树里没有 `docs/tasks.md`，也没有 `docs/vision/`。
#   第 6/7 条**必须**用长文档（理由见文件头），所以按顺序找：
#     ① 开发仓库里的 `docs/tasks.md`（≈ 36 屏，首选）
#     ② 公开树里最长的一份公开文档 `THIRD-PARTY-NOTICES.md`（≈ 400 行，远超 1.5 屏）
#   两处都没有 ⇒ 第 6/7 条会因 `open` 失败而红，**这也是对的**：
#   ⛔ 不许悄悄回落到小样本——那正是 `docs/bugs/0010` 那次的假 FAIL 形态。
SAMPLE="$ROOT/docs/tasks.md"
if [ ! -f "$SAMPLE" ]; then
  SAMPLE="$ROOT/THIRD-PARTY-NOTICES.md"
fi
SAMPLE2="$ROOT/tools/ime-sample.md"
BUNDLE_ID="io.github.kumustone.rmd"

PASS=0
FAIL=0
SKIP=0

ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf 'SKIP  %s\n' "$1"; }

# 现在有没有一份 rmd `.app` 在跑（用户自己的实例也算）。
app_running() {
  pgrep -f '/rmd\.app/Contents/MacOS/rmd' >/dev/null 2>&1
}

app_pids() {
  pgrep -f '/rmd\.app/Contents/MacOS/rmd' || true
}

# 毫秒级时钟（macOS 没有 `timeout(1)`，计时用 perl）。
now_ms() {
  perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1000'
}

# 等一个条件成立；$1 = 超时秒数，其余 = 命令。返回 0 = 成立。
wait_until() {
  local timeout_s="$1"; shift
  local deadline=$(( $(now_ms) + timeout_s * 1000 ))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    if "$@"; then return 0; fi
    sleep 0.1
  done
  return 1
}

count_marker() {
  # 计数一个稳定标记；日志可能还没建出来。
  local file="$1" marker="$2"
  [ -f "$file" ] || { echo 0; return; }
  grep -c "$marker" "$file" 2>/dev/null || true
}

# ── 前置 ────────────────────────────────────────────────────────────────
if [ ! -d "$APP" ]; then
  bad "前置：$APP 不存在（先 make app）"
  printf '\n结果：%d 通过 / %d 失败 / %d 跳过\n' "$PASS" "$FAIL" "$SKIP"
  exit 3
fi

if [ ! -x "$APP_BIN" ]; then
  bad "前置：$APP_BIN 不存在或不可执行"
  printf '\n结果：%d 通过 / %d 失败 / %d 跳过\n' "$PASS" "$FAIL" "$SKIP"
  exit 3
fi

if app_running; then
  printf '⛔ 已经有一份 rmd.app 在跑（pid: %s）。\n' "$(app_pids | tr '\n' ' ')"
  printf '   冒烟需要独占一份应用实例；⛔ 本脚本不会去杀用户的实例。\n'
  printf '   先自己退出那个窗口，或稍后再跑。\n'
  exit 4
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/rmd-smoke-app.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
LOG_A="$TMP/launch-a.log"
LOG_B="$TMP/launch-b.log"

# 退出时（含失败中断）尽量别留下我们起的实例。
cleanup_app() {
  if app_running; then
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    wait_until 8 bash -c "! pgrep -f '/rmd\\.app/Contents/MacOS/rmd' >/dev/null 2>&1" || true
    if app_running; then
      local pids
      pids="$(app_pids | tr '\n' ' ')"
      printf '⚠️  osascript quit 之后仍在跑（pid: %s），发 SIGTERM（⛔ 不 kill -9）\n' "$pids"
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
      wait_until 5 bash -c "! pgrep -f '/rmd\\.app/Contents/MacOS/rmd' >/dev/null 2>&1" || true
    fi
  fi
}
trap 'cleanup_app; rm -rf "$TMP"' EXIT

# ── 2. plist 语法 ───────────────────────────────────────────────────────
if plutil -lint "$APP/Contents/Info.plist" >/dev/null 2>&1; then
  ok "2 · plutil -lint Info.plist"
else
  bad "2 · plutil -lint Info.plist（输出见上）"
  plutil -lint "$APP/Contents/Info.plist" || true
fi

# ── 3. 签名 ─────────────────────────────────────────────────────────────
if codesign --verify --strict "$APP" >/dev/null 2>&1; then
  ok "3 · codesign --verify --strict"
else
  bad "3 · codesign --verify --strict（输出见上）"
  codesign --verify --strict "$APP" || true
fi

# ── 4. 同一份二进制（INV-APP-01）────────────────────────────────────────
# ⚠️ 这里**不能**用 `cmp`：bundle 签名会重写主可执行文件的 Mach-O
#    （绑定 `Info.plist` 的 CodeDirectory），签名后与 `target/release/rmd` 必然不同。
#    ⇒ 判据换成 `make app` 在**签名前**记下的内容哈希（`Contents/Resources/build-id.txt`）。
BUILD_ID_FILE="$APP/Contents/Resources/build-id.txt"
if [ ! -f "$BIN" ]; then
  bad "4 · $BIN 不存在（先 make build-gui）"
elif [ ! -f "$BUILD_ID_FILE" ]; then
  bad "4 · .app 里没有 build-id.txt（重跑 make app）"
else
  recorded="$(cat "$BUILD_ID_FILE")"
  now="$(shasum -a 256 "$BIN" | awk '{print $1}')"
  if [ "$recorded" = "$now" ]; then
    ok "4 · .app 装的是当前这一份二进制（build-id ${now:0:12}）"
  else
    bad "4 · .app 里是**另一份**二进制（记着 ${recorded:0:12}，当前 ${now:0:12}）⇒ 重跑 make app"
  fi
fi

# ── 5. 文件关联字段 ─────────────────────────────────────────────────────
PLIST_DOC_TYPES="$(plutil -extract CFBundleDocumentTypes json -o - "$APP/Contents/Info.plist" 2>/dev/null || true)"
MISSING=""
for want in '"md"' 'net.daringfireball.markdown' 'Viewer' 'Alternate'; do
  case "$PLIST_DOC_TYPES" in
    *"$want"*) ;;
    *) MISSING="$MISSING $want" ;;
  esac
done
if [ -z "$MISSING" ]; then
  ok "5 · CFBundleDocumentTypes 含 md / UTI / Viewer / Alternate"
else
  bad "5 · CFBundleDocumentTypes 缺：$MISSING"
  printf '%s\n' "$PLIST_DOC_TYPES"
fi

# ── 6. 后台启动 + 冒烟自证 + 自行退出 ───────────────────────────────────
# ⚠️ `--env RMD_SMOKE=1` 只在**这一份新实例**上生效（open 的语义）。
start_ms="$(now_ms)"
if ! open -g --env RMD_SMOKE=1 --stderr "$LOG_A" -a "$APP" "$SAMPLE"; then
  bad "6 · open -a 返回非零（应用没起来）"
else
  end_ms="$(now_ms)"
  elapsed=$(( end_ms - start_ms ))
  if [ "$elapsed" -lt 1000 ]; then
    ok "6a · open 立即返回（${elapsed} ms < 1000 ms）"
  else
    bad "6a · open 用时 ${elapsed} ms（应 < 1000 ms）"
  fi

  # 第 7 条要趁进程还在的时候读 ppid。
  launched_pid=""
  if wait_until 5 bash -c "pgrep -f '/rmd\\.app/Contents/MacOS/rmd' >/dev/null 2>&1"; then
    launched_pid="$(pgrep -f '/rmd\.app/Contents/MacOS/rmd' | head -n 1)"
  fi

  if [ -z "$launched_pid" ]; then
    bad "6b · 没看到进程起来"
  else
    # ── 7. ppid == 1（launchd 拉起，不是 shell 的子进程）────────────────
    ppid_val="$(ps -o ppid= -p "$launched_pid" 2>/dev/null | tr -d ' ')"
    if [ "$ppid_val" = "1" ]; then
      ok "7 · 进程的 ppid = 1（launchd）"
    else
      bad "7 · 进程的 ppid = ${ppid_val:-（读不到）}，应 = 1"
    fi

    # ── 6b. 冒烟 PASS 行 ────────────────────────────────────────────────
    if wait_until 60 bash -c "grep -q '^RMD_SMOKE PASS' '$LOG_A' 2>/dev/null"; then
      ok "6b · 日志出现 RMD_SMOKE PASS"
    else
      bad "6b · 60 s 内没等到 RMD_SMOKE PASS（日志见下）"
      [ -f "$LOG_A" ] && tail -n 40 "$LOG_A"
    fi

    # ── 6c. 自行退出 ────────────────────────────────────────────────────
    if wait_until 30 bash -c "! pgrep -f '/rmd\\.app/Contents/MacOS/rmd' >/dev/null 2>&1"; then
      ok "6c · 冒烟后进程自行退出"
    else
      bad "6c · 30 s 内没有自行退出（pid 仍在）"
      grep -n 'RMD_SMOKE' "$LOG_A" 2>/dev/null || true
    fi
  fi
fi

# 收尾：万一上一段留下实例，先清掉再进第 9 条。
cleanup_app

# ── 8. `make which-default`（只读）──────────────────────────────────────
# ⚠️ 只读：它只调 `NSWorkspace.urlForApplication(toOpen:)`，⛔ 不改任何设置
#    （`INV-APP-04` 的另一半：这个目标在任何时候都不许有副作用）。
if which_out="$(cd "$ROOT" && make -s which-default 2>&1)"; then
  ok "8 · which-default 可读（只读，不改设置）"
  printf '      %s\n' "$(printf '%s' "$which_out" | tr '\n' ' ' | cut -c1-200)"
else
  bad "8 · which-default 失败：$which_out"
fi

# ── 9. 已在运行时再送一份 ⇒ 仍 1 个进程 + 第二条 Apple Event ─────────────
# ⚠️ 这一段**不带** RMD_SMOKE：要的就是一个常驻实例。
if open -g --stderr "$LOG_B" -a "$APP" "$SAMPLE"; then
  if wait_until 10 bash -c "pgrep -f '/rmd\\.app/Contents/MacOS/rmd' >/dev/null 2>&1"; then
    # 给它一点时间跑完引导（注册监听 / 打开第一份）。
    sleep 2
    open -g -a "$APP" "$SAMPLE2" || true

    # 第二条事件：日志里 `▶ 打开请求（Apple Event）` 至少出现 2 次。
    if wait_until 15 bash -c "[ \"\$(grep -c '▶ 打开请求（Apple Event）' '$LOG_B' 2>/dev/null || true)\" -ge 2 ]"; then
      ok "9a · 日志出现第二条「▶ 打开请求（Apple Event）」（共 $(count_marker "$LOG_B" '▶ 打开请求（Apple Event）') 条）"
    else
      bad "9a · 15 s 内没等到第二条 Apple Event（共 $(count_marker "$LOG_B" '▶ 打开请求（Apple Event）') 条）"
      [ -f "$LOG_B" ] && tail -n 40 "$LOG_B"
    fi

    n="$(app_pids | wc -l | tr -d ' ')"
    if [ "$n" = "1" ]; then
      ok "9b · 仍只有 1 个进程（复用了运行中的实例）"
    else
      bad "9b · 进程数 = ${n}（应为 1）⇒ 又起了一份实例"
    fi

    # 退出（⛔ 不用 kill -9）。
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    if wait_until 10 bash -c "! pgrep -f '/rmd\\.app/Contents/MacOS/rmd' >/dev/null 2>&1"; then
      ok "9c · osascript quit 正常退出"
    else
      bad "9c · quit 后 10 s 仍在跑（收尾会发 SIGTERM）"
    fi
  else
    bad "9 · 常驻实例没起来（进程找不到）"
  fi
else
  bad "9 · open（常驻实例）返回非零"
fi

cleanup_app

# ── 汇总 ────────────────────────────────────────────────────────────────
printf '\n结果：%d 通过 / %d 失败 / %d 跳过\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -ne 0 ]; then exit 1; fi
exit 0
