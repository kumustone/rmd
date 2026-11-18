#!/usr/bin/env bash
# 按 `docs/design/0063-Mardo-端侧对照测试.md` §2.6 / §7.2 的 **Stage A**，
# 把 `fixtures/` 里的 20 份夹具经**产品渲染器**（真 comrak）导出成载荷 JSON，
# 并生成 `fixtures-expect.json` 的**初版**（`dom_line_boxes` 先留 null）。
#
# 用法：
#   tools/visual-parity/export-fixtures.sh            # 首跑；已有产物就拒绝覆盖
#   tools/visual-parity/export-fixtures.sh --force    # 允许覆盖 .work/ 与 fixtures-expect.json
#       [--backup-dir <dir>]                          # 旧产物备份目录（默认 <work>/.backup）
#       [--reset-line-boxes]                          # 允许把已有 non-null dom_line_boxes 清零
#       [--layout-provenance <__l2-provenance.json>]  # 记录冻结依据的排版 profile
#       [--work-dir <dir>] [--expect-out <path>]      # 隔离跑（测试用，必须成对给）
#       [--stale-lock-after <秒>]                     # 仅清理「无法验证为同一进程」
#                                                    # 且锁龄 ≥ N 秒的锁；⚠️ 对 start_time /
#                                                    # 命令行摘要匹配的活锁始终拒绝
#   tools/visual-parity/export-fixtures.sh --augment-only <payload> --out <path> \
#       [--expect-out <path>]                          # 只给**已有载荷**补 provenance（⛔ 不跑 cargo）
#
# 产物（⛔ 不写 benchmarks/results/）：
#   tools/visual-parity/.work/fixtures.json       —— `live_block_夹具导出` 的原始载荷
#                                                    ＋ `provenance`（`bugs/0154`）＋ `export_id`
#   tools/visual-parity/.work/stage-a.log         —— cargo test 的完整日志
#   tools/visual-parity/fixtures-expect.json      —— 夹具期望冻结文件的初版
#
# `provenance`（`bugs/0154`）回答「这份 HTML 是哪个二进制、什么时候渲染的」：
#   schema / exported_at / build_id / build_id_source / build_id_error /
#   binary_path / binary_sha256 / binary_sha256_error / binary_sha256_matches_build_id /
#   docs_sha256 / fixtures_payload_sha256 / stage_a_log_sha256 / fixture_count
#   - `build_id` 读 `build/macos/rmd.app/Contents/Resources/build-id.txt`
#     （= 未签名 release 二进制的 sha256，见 Makefile）。读不到时**显式记 null
#     ＋原因**，⛔ 不编造。
#   - `binary_sha256` 读 app bundle 里的主可执行文件；签名会重写它，所以
#     `binary_sha256_matches_build_id=false` 是**签名后的正常形态**（见 Makefile 注释）。
#   - `docs_sha256` 与 `build-l2-page.sh` 的算法一致（`docs` 的规范 JSON），
#     构页时能核对「页面里的 HTML 就是这份载荷」。
#
# `export_id`（`bugs/0256`）= `l2-export/<docs 规范 JSON 的 sha256>`：载荷与每条
# 期望都写同一个值，下游可核对「载荷与期望是不是同一代产物」。
#
# 事务与并发（`bugs/0256` / R5 §3.1-§3.3）：
#   - Stage A 先写 `<work>/.tmp/`，校验通过后才 `mv` 到最终载荷路径；
#     中途失败时旧载荷/旧期望原样保留（旧载荷另备份一份到 `<work>/.backup/`）。
#   - 临时载荷由 EXIT/INT/TERM trap 统一清理；开跑时还会清掉 `<work>/.tmp/` 里
#     超过 `RMD_L2_TMP_MAX_AGE_HOURS`（默认 6）小时的 `fixtures.json.*.tmp|.aug`，
#     ⛔ 不留跨 PID 永久残留。
#   - `fixtures-expect.json` 用 temp + `os.replace` 原子落盘。
#   - 跨文件提交窗口：载荷 `mv` 到最终路径**之前**先写 `<work>/.export-in-progress`
#     （含 `export_id`/`pid`/`started_at`），期望成功写出或失败回滚后才删除。
#     SIGKILL/断电留下该标记 ⇒ 下一次运行会告警「载荷与期望可能不是同一代」。
#     ⚠️ 该标记只能被发现，**不能**在没有 journal/rename 协议的情况下防断电
#     （见文件尾与 `.agent/l2-fix3-E.md`）。
#   - 锁文件 `<work>/export.lock`（`--lock-file` 可改）记录 `pid` / `start_time` /
#     `command_sha256` / `created_at`：PID 被无关进程复用时靠 start_time 与命令行
#     摘要识别为陈旧锁；`kill` 探测区分 EPERM（拒绝，⛔ 不删）与 ESRCH（陈旧，清理）。
#     旧式「纯 PID」锁或 `ps` 读不到 start_time 时，只有 `--stale-lock-after <秒>`
#     且锁龄超阈值才清理。拿不到锁 ⇒ 退 3。
#
# 重生成语义（`bugs/0194`）：
#   - `--force` 覆盖前把旧 `fixtures-expect.json` 与旧载荷按时间戳备份到
#     `--backup-dir`（默认 `<work>/.backup`），失败 ⇒ 退 3，不覆盖。
#   - 旧条目里 non-null 的 `dom_line_boxes` 默认**原值保留**；要清零必须显式
#     `--reset-line-boxes`。stdout 打印逐夹具 diff（`sha256` / `blocks_kind` /
#     `dom_line_boxes` / `dom_line_boxes_stale` / `layout_profile` 的旧值 → 新值）。
#   - 夹具 `sha256` 变了但旧 `dom_line_boxes` 仍保留时，该条显式标
#     `dom_line_boxes_stale=true` ＋ `dom_line_boxes_stale_reason="fixture-sha-changed"`
#     并打印告警；⛔ 本轮**不自动清零**（等设计裁定，见 `0194` / R5 §3.8）。
#   - 本地工作产物（`<work>/`、`.tmp/`、`.backup/`、`*.bak.*`）由
#     `tools/visual-parity/.gitignore` 覆盖；⛔ 不要 `git add` 这些目录。
#   - 每条加 `layout_profile`：`font_size` / `line_height` / `content_width` /
#     `sidebar_width` ＋ `source`（来源字面量逐字取自 `--layout-provenance`
#     指向的 `__l2-provenance.json`）。没给 provenance ⇒ 四项均 `null`、
#     `source` 均 `"unknown"`；⛔ 不拿当前用户 config 猜一套（`bugs/0282` 未裁定）。
#
# 退出码：0 = 成功；3 = 前置条件 / 用法 / 环境不满足（含已有产物且未加 --force、
#         `SOURCE_DATE_EPOCH` 非法、拿不到导出锁、Stage A 失败或产物不合格，
#         后两者并打印日志尾部）。⛔ 不新增其它退出码（不再用 1/2/4）。
#
# ⚠️ 不启动、不激活任何 app，不 open，不用 osascript / CGEvent / AX / 合成按键。
# ⚠️ Stage A 走的是 `commands/document.rs::live_block_夹具导出`（`#[ignore]` 测试），
#    与 `tools/live-probe/block-probe.sh` 的 Stage A **同一条调用方式**：
#    `RMD_LIVE_BLOCK_DIR` / `RMD_LIVE_BLOCK_OUT` ＋
#    `cargo test --release --offline --features gui -- --ignored --nocapture live_block`。
# ⚠️ 成功判据（`bugs/0254`）：日志必须命中 `running 1 test`、目标测试行
#    `... live_block_夹具导出 ... ok`、`test result: ok. 1 passed;` 三者且顺序成立。
#    过滤串 0 命中时 cargo 退 0、只打印 `running 0 tests`，这里必须判失败。
#
# 确定性：
#   - `fixtures-expect.json` 的结构字段（夹具名、sha256、blocks_kind、dom_line_boxes、renderer）
#     逐字节稳定；`generated_at` 是元数据，默认取当前 UTC，可用 `SOURCE_DATE_EPOCH` 固定。
#     `SOURCE_DATE_EPOCH` 必须是十进制非负整数且落在 `time.gmtime` 可接受范围内；
#     空串等同未设置（沿用旧行为），其它非法值在**写出任何产物之前**退 3。
#   - `renderer` 从载荷 provenance 复制（`comrak+<build_id 前 12 位>`），⛔ 不再写死
#     `"comrak+"`（`bugs/0154`）；没有 build_id 时写 `comrak+unknown`。
#   - ⚠️ `.work/fixtures.json` **不是**逐字节稳定：含 MathML 的两份夹具
#     （`11-diagrams`、`14-edit-menu`）里 `<math>` 的**属性顺序**在进程间会变
#     （`display="block" xmlns=…` ↔ `xmlns=… display="block"`），语义等价、字节不同。
#     这是产品渲染器（katex-rs / MathML 序列化）的现状，本轮只记录、⛔ 不改产品代码。
#
# 行盒回填（`bugs/0195`）：本脚本只生成初版；回填用同目录 `backfill-expect.py`
#   （`--work-dir <dir> [--dry-run]`），从 `<work>/<夹具>/dom.json` 的
#   `dom.doc.line_boxes.count` 写回，并记 `generated_at` 与每条 `provenance`。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FIXTURES="$HERE/fixtures"
EXPECTED_COUNT=20
BUILD_ID_FILE="${RMD_L2_BUILD_ID_FILE:-$ROOT/build/macos/rmd.app/Contents/Resources/build-id.txt}"
RELEASE_BIN="$ROOT/target/release/rmd"
STAGE_A_CHECK="$HERE/check-stage-a-log.py"

die() {
  echo "⛔ $*" >&2
  exit 3
}

usage_error() {
  # `bugs/0259`：契约只允许 0/3，用法错误也归 3（⛔ 不新增退出码）。
  echo "⛔ $*" >&2
  exit 3
}

FORCE=0
AUGMENT_ONLY=""
AUGMENT_OUT=""
EXPECT_OUT=""
RESET_LINE_BOXES=0
BACKUP_DIR_ARG=""
BACKUP_DIR_SET=0
LAYOUT_PROVENANCE=""
WORK_DIR_ARG=""
LOCK_FILE_ARG=""
STALE_LOCK_AFTER=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --reset-line-boxes) RESET_LINE_BOXES=1; shift ;;
    --augment-only)
      [ "$#" -ge 2 ] || usage_error "--augment-only 缺参数值"
      AUGMENT_ONLY="$2"; shift 2 ;;
    --augment-only=*) AUGMENT_ONLY="${1#*=}"; shift ;;
    --out)
      [ "$#" -ge 2 ] || usage_error "--out 缺参数值"
      AUGMENT_OUT="$2"; shift 2 ;;
    --out=*) AUGMENT_OUT="${1#*=}"; shift ;;
    --expect-out)
      [ "$#" -ge 2 ] || usage_error "--expect-out 缺参数值"
      EXPECT_OUT="$2"; shift 2 ;;
    --expect-out=*) EXPECT_OUT="${1#*=}"; shift ;;
    --backup-dir)
      [ "$#" -ge 2 ] || usage_error "--backup-dir 缺参数值"
      BACKUP_DIR_ARG="$2"; BACKUP_DIR_SET=1; shift 2 ;;
    --backup-dir=*) BACKUP_DIR_ARG="${1#*=}"; BACKUP_DIR_SET=1; shift ;;
    --layout-provenance)
      [ "$#" -ge 2 ] || usage_error "--layout-provenance 缺参数值"
      LAYOUT_PROVENANCE="$2"; shift 2 ;;
    --layout-provenance=*) LAYOUT_PROVENANCE="${1#*=}"; shift ;;
    --work-dir)
      [ "$#" -ge 2 ] || usage_error "--work-dir 缺参数值"
      WORK_DIR_ARG="$2"; shift 2 ;;
    --work-dir=*) WORK_DIR_ARG="${1#*=}"; shift ;;
    --lock-file)
      [ "$#" -ge 2 ] || usage_error "--lock-file 缺参数值"
      LOCK_FILE_ARG="$2"; shift 2 ;;
    --lock-file=*) LOCK_FILE_ARG="${1#*=}"; shift ;;
    --stale-lock-after)
      [ "$#" -ge 2 ] || usage_error "--stale-lock-after 缺参数值（秒，十进制非负整数）"
      STALE_LOCK_AFTER="$2"; shift 2 ;;
    --stale-lock-after=*) STALE_LOCK_AFTER="${1#*=}"; shift ;;
    -h|--help)
      awk 'NR > 1 && /^set -euo pipefail$/ { exit } NR > 1 { print }' "${BASH_SOURCE[0]}" \
        | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      usage_error "不认识的参数：${1}（支持 --force / --reset-line-boxes / --augment-only / --out / --expect-out / --backup-dir / --layout-provenance / --work-dir / --lock-file / --stale-lock-after）"
      ;;
  esac
done

case "$STALE_LOCK_AFTER" in
  ''|*[!0-9]*) usage_error "--stale-lock-after 必须是十进制非负整数（秒），实际：'${STALE_LOCK_AFTER}'" ;;
esac

if [ "$BACKUP_DIR_SET" -eq 1 ] && [ -z "${BACKUP_DIR_ARG//[[:space:]]/}" ]; then
  usage_error "--backup-dir 不能为空/空白（--force 必须能备份旧产物）"
fi

WORK="${WORK_DIR_ARG:-$HERE/.work}"
FIXTURE_JSON="$WORK/fixtures.json"
STAGE_LOG="$WORK/stage-a.log"
TMP_DIR="$WORK/.tmp"
BACKUP_DIR="${BACKUP_DIR_ARG:-$WORK/.backup}"
LOCK_FILE="${LOCK_FILE_ARG:-$WORK/export.lock}"
EXPECT="${EXPECT_OUT:-$HERE/fixtures-expect.json}"
CM6="$ROOT/src/vendor/cm6.bundle.js"
IN_PROGRESS_FILE="$WORK/.export-in-progress"
EXPORT_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 隔离跑护栏：`--work-dir` 只改载荷/日志/锁的位置，不自动改期望文件位置。
# 不配对给 `--expect-out` 时拒绝，避免测试误写冻结的 fixtures-expect.json。
if [ -n "$WORK_DIR_ARG" ] && [ -z "$EXPECT_OUT" ]; then
  usage_error "--work-dir 必须同时给 --expect-out（⛔ 不误写冻结的 fixtures-expect.json）"
fi

# ── `SOURCE_DATE_EPOCH`（`bugs/0259`）：在任何产物写出之前校验 ──────────
# 规则：空串 = 未设置（沿用旧行为）；否则必须是十进制非负整数，且
# `time.gmtime()` 能接受。失败打印实际值与期望格式，退 3（契约只允许 0/3）。
validate_source_date_epoch() {
  local raw="${SOURCE_DATE_EPOCH-}"
  [ -z "$raw" ] && return 0
  case "$raw" in
    *[!0-9]*)
      die "SOURCE_DATE_EPOCH 必须是十进制非负整数（实际：'${raw}'；期望：如 0 / 1752000000）"
      ;;
  esac
  python3 -I - "$raw" <<'PY' || exit 3
import sys
import time

raw = sys.argv[1]
try:
    value = int(raw, 10)
except ValueError:
    print("⛔ SOURCE_DATE_EPOCH 必须是十进制非负整数（实际：%r；期望：如 0 / 1752000000）"
          % raw, file=sys.stderr)
    sys.exit(3)
if value < 0:
    print("⛔ SOURCE_DATE_EPOCH 不能为负（实际：%r）" % raw, file=sys.stderr)
    sys.exit(3)
try:
    time.gmtime(value)
except (OverflowError, OSError, ValueError) as exc:
    print("⛔ SOURCE_DATE_EPOCH=%s 超出 time.gmtime 可接受范围（%s）" % (raw, exc),
          file=sys.stderr)
    sys.exit(3)
PY
}
validate_source_date_epoch

# ── 统一清理（`bugs/0254` / R5 §3.3）：临时载荷永远不跨运行残留 ──────────
# ⚠️ 刻意**不**在 trap 里删 `.export-in-progress`：SIGKILL/SIGTERM 后它是
#    「载荷与期望可能不是同一代」的唯一线索（R5 §3.2）。
CLEANUP_FILES=()
cleanup_on_exit() {
  local rc=$?
  local f
  for f in "${CLEANUP_FILES[@]:-}"; do
    [ -n "$f" ] || continue
    rm -f "$f" 2>/dev/null || true
  done
  if [ "$LOCK_HELD" -eq 1 ]; then
    rm -f "$LOCK_FILE" 2>/dev/null || true
    LOCK_HELD=0
  fi
  exit "$rc"
}
trap 'cleanup_on_exit' EXIT
trap 'exit 3' INT TERM

# ── 导出锁（`bugs/0256` / R5 §3.1）：锁文件不止 PID ─────────────────────
# 锁内容（key=value，向后兼容旧版「纯 PID」）：
#   tool=export-fixtures.sh
#   pid=<pid>
#   start_time=<ps -o lstart= 的进程启动时刻>
#   command_sha256=<ps -o command= 的 sha256>
#   created_at=<epoch 秒>
# 判活：ESRCH=死（可清理）；EPERM=无权判断（⛔ 不删，退 3）；存在则再比
# start_time / command_sha256，不一致 = PID 被无关进程复用（可清理）。
# 旧式锁或 `ps` 读不到 start_time 时无法验证，只有 `--stale-lock-after <秒>`
# 且锁龄超阈值才清理；对已验证匹配的活锁始终拒绝。
LOCK_HELD=0

lock_field() {
  # $1 = 锁文件；$2 = 键名。找不到则输出空串。
  local file="$1" key="$2" line
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*) printf '%s' "${line#*=}"; return 0 ;;
    esac
  done <"$file"
}

process_start_time() {
  [ -n "${1:-}" ] || return 0
  ps -o lstart= -p "$1" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true
}

process_command_digest() {
  local cmd
  [ -n "${1:-}" ] || return 0
  # `-ww`：⛔ 不让 ps 按终端宽度截断命令行，否则同一进程两次摘要可能不同。
  cmd="$(ps -ww -o command= -p "$1" 2>/dev/null || true)"
  [ -n "$cmd" ] || return 0
  printf '%s' "$cmd" | shasum -a 256 | awk '{print $1}'
}

process_state() {
  # 输出 dead / denied / alive / invalid，并给出对应退出码。
  # ⚠️ 必须用 os.kill 区分 EPERM 与 ESRCH：`kill -0` 的 shell 退出码对两者相同。
  python3 -I - "$1" <<'PY'
import errno
import os
import sys

try:
    pid = int(sys.argv[1])
except (TypeError, ValueError):
    print("invalid")
    sys.exit(3)
try:
    os.kill(pid, 0)
except ProcessLookupError:
    print("dead")
    sys.exit(1)
except PermissionError:
    print("denied")
    sys.exit(2)
except OSError as exc:
    if exc.errno == errno.ESRCH:
        print("dead")
        sys.exit(1)
    if exc.errno == errno.EPERM:
        print("denied")
        sys.exit(2)
    print("invalid")
    sys.exit(3)
print("alive")
sys.exit(0)
PY
}

lock_mtime_epoch() {
  local file="$1"
  [ -f "$file" ] || return 0
  stat -f %m "$file" 2>/dev/null || stat -c %Y "$file" 2>/dev/null || true
}

remove_lock_matching() {
  # $1 = 读取时的内容快照；仅在文件仍逐字相同时删除（缩小误删活锁的窗口）。
  python3 -I - "$LOCK_FILE" "$1" <<'PY'
import os
import sys

path, expect = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8", errors="replace") as f:
        actual = f.read()
except OSError:
    sys.exit(0)
if actual.rstrip("\n") != expect.rstrip("\n"):
    sys.exit(2)
try:
    os.unlink(path)
except OSError:
    sys.exit(3)
PY
}

write_lock() {
  ( set -C; umask 077; {
      printf 'tool=%s\n' "export-fixtures.sh"
      printf 'pid=%s\n' "$$"
      printf 'start_time=%s\n' "$(process_start_time "$$")"
      printf 'command_sha256=%s\n' "$(process_command_digest "$$")"
      printf 'created_at=%s\n' "$(date +%s)"
    } >"$LOCK_FILE" ) 2>/dev/null
}

acquire_lock() {
  mkdir -p "$(dirname "$LOCK_FILE")" || die "建不了锁目录：$(dirname "$LOCK_FILE")"
  local attempt content pid state pstat recorded_start recorded_cmd current_start current_cmd
  local created_at age verify same_process
  for attempt in 1 2 3; do
    if write_lock; then
      LOCK_HELD=1
      return 0
    fi
    if [ ! -f "$LOCK_FILE" ]; then
      # 竞争窗口内锁被释放：直接重试。
      continue
    fi
    content="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    pid="$(lock_field "$LOCK_FILE" pid)"
    if [ -z "$pid" ]; then
      # 向后兼容旧版锁：整个文件只有一个 PID。
      pid="$(printf '%s' "$content" | head -n 1 | tr -dc '0-9' || true)"
    fi
    if [ -z "$pid" ] || ! [ "$pid" -gt 0 ] 2>/dev/null; then
      echo "⚠️ 锁文件没有可解析的 PID（内容损坏），按陈旧锁清理：$LOCK_FILE" >&2
      remove_lock_matching "$content" || die "清不掉损坏的锁：$LOCK_FILE"
      continue
    fi

    state="$(process_state "$pid" || true)"
    case "$state" in
      dead)
        echo "⚠️ 清理陈旧导出锁（${LOCK_FILE}，PID $pid 已不存在）" >&2
        remove_lock_matching "$content" || die "清不掉陈旧锁：$LOCK_FILE"
        continue
        ;;
      denied)
        die "锁文件 $LOCK_FILE 的 PID $pid 存在但无权探测（EPERM）。⛔ 不当作陈旧锁删除；请确认该进程已退出，或在确认无导出后人工删除锁文件。"
        ;;
      alive) ;;
      *)
        die "无法判断锁文件 $LOCK_FILE 的 PID $pid 是否存活（探测失败）。⛔ 不删锁。"
        ;;
    esac

    # 僵尸进程（已退出但未被 reap）按死处理。
    pstat="$(ps -o stat= -p "$pid" 2>/dev/null || true)"
    case "$pstat" in
      *Z*)
        echo "⚠️ 清理陈旧导出锁（${LOCK_FILE}，PID $pid 已是僵尸进程）" >&2
        remove_lock_matching "$content" || die "清不掉陈旧锁：$LOCK_FILE"
        continue
        ;;
    esac

    recorded_start="$(lock_field "$LOCK_FILE" start_time)"
    recorded_cmd="$(lock_field "$LOCK_FILE" command_sha256)"
    current_start="$(process_start_time "$pid")"
    current_cmd="$(process_command_digest "$pid")"
    created_at="$(lock_field "$LOCK_FILE" created_at)"
    [ -n "$created_at" ] || created_at="$(lock_mtime_epoch "$LOCK_FILE")"
    age=""
    if [ -n "$created_at" ] && [ "$created_at" -gt 0 ] 2>/dev/null; then
      age=$(( $(date +%s) - created_at ))
    fi

    # 身份优先用 start_time（PID + 启动时刻唯一标识一个进程）；读不到时才退到
    # 命令行摘要。⛔ 不要求两者同时匹配：ps 的格式差异会制造假的「已复用」。
    verify=0
    same_process=1
    if [ -n "$recorded_start" ] && [ -n "$current_start" ]; then
      verify=1
      [ "$recorded_start" = "$current_start" ] || same_process=0
    elif [ -n "$recorded_cmd" ] && [ -n "$current_cmd" ]; then
      verify=1
      [ "$recorded_cmd" = "$current_cmd" ] || same_process=0
    fi

    if [ "$verify" -eq 1 ] && [ "$same_process" -eq 1 ]; then
      die "另一个导出在进行（锁文件 ${LOCK_FILE}，PID ${pid}；记录的 start_time / 命令行摘要与当前进程一致）。⛔ 不并发写载荷/期望；确认该进程已退出后再重跑。"
    fi
    if [ "$verify" -eq 1 ]; then
      echo "⚠️ 锁文件 ${LOCK_FILE} 的 PID ${pid} 已被无关进程复用（记录的 start_time / 命令行摘要与当前进程不符），按陈旧锁清理" >&2
      remove_lock_matching "$content" || die "清不掉陈旧锁：$LOCK_FILE"
      continue
    fi
    if [ "$STALE_LOCK_AFTER" -gt 0 ] && [ -n "$age" ] && [ "$age" -ge "$STALE_LOCK_AFTER" ]; then
      echo "⚠️ 锁 $LOCK_FILE 无法验证为同一进程（旧式锁或 ps 读不到 start_time），已存在 ${age}s ≥ --stale-lock-after=${STALE_LOCK_AFTER}s，按参数清理（PID ${pid}）" >&2
      remove_lock_matching "$content" || die "清不掉陈旧锁：$LOCK_FILE"
      continue
    fi
    die "锁文件 $LOCK_FILE 的持有者无法验证（旧式锁或 ps 读不到 start_time），PID $pid 仍可能存在。⛔ 不删锁；确认没有导出在进行后，可加 --stale-lock-after <秒>（如 3600）清理。"
  done
  die "拿不到导出锁：${LOCK_FILE}（另一个导出在进行）"
}

# ── 备份（`bugs/0194` / `0256`）──────────────────────────────────────────
backup_file() {
  # $1 = 要备份的文件；成功时把备份路径写到 stdout。
  local src="$1" base stamp dest
  [ -e "$src" ] || return 0
  mkdir -p "$BACKUP_DIR" || die "建不了备份目录：$BACKUP_DIR"
  [ -d "$BACKUP_DIR" ] || die "备份路径不是目录：$BACKUP_DIR"
  base="$(basename "$src")"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)" || die "生成备份时间戳失败"
  dest="$BACKUP_DIR/${base}.${stamp}.$$.bak"
  cp -p "$src" "$dest" || die "备份失败：$src → $dest"
  echo "📦 备份 $src → $dest" >&2
  printf '%s\n' "$dest"
}

# ── 过期临时载荷清理（R5 §3.3）：跨 PID 的 `.tmp` 不得永久堆积 ───────────
# `RMD_L2_TMP_MAX_AGE_HOURS`：默认 6 小时；0 = 关闭开跑清理（本次运行的
# 临时文件仍由 EXIT trap 负责删除）。
cleanup_old_tmp() {
  local hours="${RMD_L2_TMP_MAX_AGE_HOURS:-6}"
  case "$hours" in
    ''|*[!0-9]*) die "RMD_L2_TMP_MAX_AGE_HOURS 必须是十进制非负整数（实际：'${hours}'）" ;;
  esac
  [ "$hours" -gt 0 ] || return 0
  local f found
  for f in "$TMP_DIR"/fixtures.json.*.tmp "$TMP_DIR"/fixtures.json.*.aug; do
    [ -e "$f" ] || continue
    found="$(find "$f" -maxdepth 0 -mmin "+$((hours * 60))" 2>/dev/null || true)"
    [ -n "$found" ] || continue
    rm -f "$f" || true
    echo "🧹 清理过期临时载荷（>${hours}h）：$f" >&2
  done
}

# ── 跨文件事务发现标记（R5 §3.2）────────────────────────────────────────
# `export_id` 在载荷落盘前先写进 `<work>/.export-in-progress`；期望写出或
# 失败回滚后才删除。⚠️ 这是**可发现性**，不是断电原子性：要真正防断电需
# journal/rename 协议（例如先落 expects 再切载荷的 commit 指针）。
write_in_progress() {
  # $1 = export_id；$2 = stage
  python3 -I - "$IN_PROGRESS_FILE" "$1" "$2" "$$" "$EXPORT_STARTED_AT" \
    "$FIXTURE_JSON" "$EXPECT" <<'PY'
import json
import os
import sys

path, export_id, stage, pid, started_at, payload, expect = sys.argv[1:8]
data = {
    "schema": "l2-export-in-progress/1",
    "export_id": export_id,
    "stage": stage,
    "pid": int(pid),
    "started_at": started_at,
    "payload": payload,
    "expect": expect,
}
out_dir = os.path.dirname(os.path.abspath(path)) or "."
os.makedirs(out_dir, exist_ok=True)
tmp = path + ".tmp.%d" % os.getpid()
try:
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)
except BaseException:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
PY
}

remove_in_progress() {
  rm -f "$IN_PROGRESS_FILE" || die "清不掉导出进行中标记：$IN_PROGRESS_FILE"
}

warn_if_in_progress() {
  [ -e "$IN_PROGRESS_FILE" ] || return 0
  echo "⚠️ 发现未完成的导出标记：$IN_PROGRESS_FILE" >&2
  sed 's/^/   /' "$IN_PROGRESS_FILE" >&2 || true
  echo "   上次导出可能在「提交载荷」与「写出期望」之间中断 ⇒ 载荷与期望可能不是同一代（R5 §3.2）。" >&2
  echo "   本次成功完成后会清除该标记；若只做检查，请以标记里的 export_id 为准。" >&2
}

# ── 载荷 provenance（`bugs/0154`）＋ export_id（`bugs/0256`）────────────
# $1 = 输入载荷；$2 = 输出路径。
augment_payload() {
  python3 -I - "$1" "$2" "$BUILD_ID_FILE" "$RELEASE_BIN" "$STAGE_LOG" <<'PY'
import hashlib, json, os, sys, time

src_path, out_path, build_id_file, release_bin, stage_log = sys.argv[1:6]


def sha256_file(path):
    if not path or not os.path.isfile(path):
        return None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def utc_stamp():
    raw = os.environ.get("SOURCE_DATE_EPOCH", "")
    if raw == "":
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        value = int(raw, 10)
    except ValueError:
        print("⛔ SOURCE_DATE_EPOCH 必须是十进制非负整数（实际：%r；期望：如 0 / 1752000000）"
              % raw, file=sys.stderr)
        sys.exit(3)
    if value < 0:
        print("⛔ SOURCE_DATE_EPOCH 不能为负（实际：%r）" % raw, file=sys.stderr)
        sys.exit(3)
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value))
    except (OverflowError, OSError, ValueError) as exc:
        print("⛔ SOURCE_DATE_EPOCH=%s 超出 time.gmtime 可接受范围（%s）" % (raw, exc),
              file=sys.stderr)
        sys.exit(3)


with open(src_path, "rb") as f:
    raw = f.read()
payload_sha = hashlib.sha256(raw).hexdigest()
payload = json.loads(raw.decode("utf-8"))
docs = payload.get("docs") or []
if not isinstance(docs, list) or not docs:
    print("⛔ 载荷没有 docs 数组，无法写 provenance", file=sys.stderr)
    sys.exit(3)

stamp = utc_stamp()

build_id = None
build_id_error = None
if os.path.isfile(build_id_file):
    try:
        with open(build_id_file, encoding="utf-8") as f:
            build_id = f.read().strip() or None
        if build_id is None:
            build_id_error = "build-id.txt 为空"
    except OSError as exc:
        build_id_error = "读 build-id.txt 失败：%s" % exc
else:
    build_id_error = "build-id.txt 不存在（先跑 make app）"

# 二进制 sha256：`build-id.txt` 记的是**签名前**的主可执行文件哈希，签名会重写它，
# 所以优先读 app bundle 里那一份；读不到再退回 cargo 的 release 产物。
binary_path = release_bin
app_bin = os.path.join(os.path.dirname(os.path.dirname(build_id_file)), "MacOS", "rmd")
if os.path.isfile(app_bin):
    binary_path = app_bin
binary_sha = sha256_file(binary_path)
binary_error = None if binary_sha else ("二进制不存在：%s" % binary_path)
binary_matches = (
    (binary_sha == build_id) if (binary_sha and build_id) else None
)

docs_canonical = json.dumps(docs, ensure_ascii=False, sort_keys=True,
                            separators=(",", ":")).encode("utf-8")
docs_digest = hashlib.sha256(docs_canonical).hexdigest()

payload["export_id"] = "l2-export/" + docs_digest
payload["provenance"] = {
    "schema": "l2-fixtures-provenance/1",
    "exported_at": stamp,
    "export_id": payload["export_id"],
    "build_id": build_id,
    "build_id_source": build_id_file,
    "build_id_error": build_id_error,
    "binary_path": binary_path,
    "binary_sha256": binary_sha,
    "binary_sha256_error": binary_error,
    "binary_sha256_matches_build_id": binary_matches,
    "docs_sha256": docs_digest,
    "fixtures_payload_sha256": payload_sha,
    "stage_a_log_sha256": sha256_file(stage_log),
    "fixture_count": len(docs),
}

# `bugs/0256`：原子落盘（temp + os.replace），⛔ 不直接截断目标。
out_dir = os.path.dirname(os.path.abspath(out_path)) or "."
os.makedirs(out_dir, exist_ok=True)
tmp_path = out_path + ".tmp.%d" % os.getpid()
try:
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp_path, out_path)
except BaseException:
    try:
        os.unlink(tmp_path)
    except OSError:
        pass
    raise

print("✅ provenance：build_id=%s exported_at=%s export_id=%s docs_sha256=%s…"
      % (build_id or "null", stamp, payload["export_id"],
         payload["provenance"]["docs_sha256"][:12]), file=sys.stderr)
if build_id is None:
    print("   ⚠️ %s ⇒ 载荷无法自证与当前二进制同源（`bugs/0154`）" % build_id_error,
          file=sys.stderr)
PY
}

# $1 = 载荷；$2 = fixtures 目录；$3 = 输出期望文件；
# $4 = 旧期望文件（可不存在）；$5 = 1 表示允许清零 dom_line_boxes；
# $6 = `--layout-provenance` 路径（空 = 不提供）。
generate_expect() {
  python3 -I - "$1" "$2" "$3" "$4" "$5" "$6" <<'PY'
import hashlib, json, os, sys, time

payload_path, fixtures_dir, out_path, old_path, reset_raw, layout_prov_path = sys.argv[1:7]
reset_line_boxes = reset_raw == "1"
UNKNOWN = "unknown"


def utc_stamp():
    raw = os.environ.get("SOURCE_DATE_EPOCH", "")
    if raw == "":
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        value = int(raw, 10)
    except ValueError:
        print("⛔ SOURCE_DATE_EPOCH 必须是十进制非负整数（实际：%r；期望：如 0 / 1752000000）"
              % raw, file=sys.stderr)
        sys.exit(3)
    if value < 0:
        print("⛔ SOURCE_DATE_EPOCH 不能为负（实际：%r）" % raw, file=sys.stderr)
        sys.exit(3)
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value))
    except (OverflowError, OSError, ValueError) as exc:
        print("⛔ SOURCE_DATE_EPOCH=%s 超出 time.gmtime 可接受范围（%s）" % (raw, exc),
              file=sys.stderr)
        sys.exit(3)


def empty_layout_profile():
    return {
        "schema": "l2-layout-profile/1",
        "font_size": None,
        "line_height": None,
        "content_width": None,
        "sidebar_width": None,
        "source": {
            "font_size": UNKNOWN,
            "line_height": UNKNOWN,
            "content_width": UNKNOWN,
            "sidebar_width": UNKNOWN,
        },
        "provenance": None,
    }


def read_layout_profile(path):
    """逐字读取 `build-l2-page.sh` 的 `__l2-provenance.json`；⛔ 不猜值。"""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as exc:
        print("⛔ 读不了 --layout-provenance %s：%s" % (path, exc), file=sys.stderr)
        sys.exit(3)
    if not isinstance(data, dict):
        print("⛔ --layout-provenance 顶层不是对象：%s" % path, file=sys.stderr)
        sys.exit(3)
    appearance = data.get("appearance") if isinstance(data.get("appearance"), dict) else {}
    source = appearance.get("source") if isinstance(appearance.get("source"), dict) else {}

    def source_of(key):
        value = source.get(key)
        return value if isinstance(value, str) and value else UNKNOWN

    return {
        "schema": "l2-layout-profile/1",
        "font_size": appearance.get("font_size"),
        "line_height": appearance.get("line_height"),
        "content_width": appearance.get("content_width"),
        "sidebar_width": data.get("sidebar_width"),
        "source": {
            "font_size": source_of("font_size"),
            "line_height": source_of("line_height"),
            "content_width": source_of("content_width"),
            # `__l2-provenance.json` 只记侧栏宽的值，不记上游来源（如 param/env）⇒ unknown。
            "sidebar_width": source_of("sidebar_width"),
        },
        "provenance": os.path.abspath(path),
    }


def show(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


stamp = utc_stamp()
with open(payload_path, encoding="utf-8") as f:
    payload = json.load(f)

export_id = payload.get("export_id")
if not isinstance(export_id, str) or not export_id:
    print("⛔ 载荷缺 export_id（先跑本脚本的 Stage A / augment 路径，`bugs/0256`）",
          file=sys.stderr)
    sys.exit(3)

old = {}
if old_path and os.path.isfile(old_path):
    try:
        with open(old_path, encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError) as exc:
        print("⛔ 旧期望文件读不了（拒绝覆盖）：%s（%s）" % (old_path, exc), file=sys.stderr)
        sys.exit(3)
    if not isinstance(old, dict):
        print("⛔ 旧期望文件顶层不是对象（拒绝覆盖）：%s" % old_path, file=sys.stderr)
        sys.exit(3)

KIND_NAMES = [
    "Paragraph", "Heading", "CodeBlock", "List", "BlockQuote",
    "Table", "HtmlBlock", "ThematicBreak", "FootnoteDefinition", "Other",
]

# `bugs/0154`：renderer 从载荷 provenance 派生（⛔ 不写死 "comrak+"）。
prov = payload.get("provenance") if isinstance(payload.get("provenance"), dict) else {}
build_id = prov.get("build_id")
renderer = "comrak+" + (str(build_id)[:12] if build_id else "unknown")

expect = {}
stale_marked = 0
for doc in payload["docs"]:
    name = doc["name"]
    md_path = os.path.join(fixtures_dir, name + ".md")
    with open(md_path, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()

    table = doc.get("block_kinds") or KIND_NAMES
    kinds = []
    for b in doc["blocks"]:
        idx = b[0]
        if not (0 <= idx < len(table)):
            raise SystemExit(f"⛔ {name}: 非法 kind_idx {idx}")
        kinds.append(table[idx])

    old_entry = old.get(name + ".md") if isinstance(old.get(name + ".md"), dict) else {}

    # `bugs/0194`：保留旧字段（含 `backfill-expect.py` 写的 `provenance`）。
    entry = dict(old_entry)
    entry["sha256"] = sha
    entry["blocks_kind"] = kinds
    entry["generated_at"] = stamp
    entry["renderer"] = renderer
    entry["export_id"] = export_id

    # `bugs/0194`：non-null `dom_line_boxes` 默认原值保留；清零须显式 --reset-line-boxes。
    if reset_line_boxes or "dom_line_boxes" not in old_entry:
        entry["dom_line_boxes"] = None
    else:
        entry["dom_line_boxes"] = old_entry.get("dom_line_boxes")

    # `bugs/0194` / R5 §3.8：夹具 sha256 变了但旧行盒仍原值保留时**必须显式标红**，
    # ⛔ 不静默。清零与否待设计裁定，本脚本只标记 + 告警。
    old_sha = old_entry.get("sha256")
    sha_changed = isinstance(old_sha, str) and old_sha != sha
    if entry.get("dom_line_boxes") is not None and sha_changed:
        entry["dom_line_boxes_stale"] = True
        entry["dom_line_boxes_stale_reason"] = "fixture-sha-changed"
        stale_marked += 1
    else:
        entry["dom_line_boxes_stale"] = False
        entry["dom_line_boxes_stale_reason"] = None

    # `bugs/0194` / `0282`：显式给了 provenance 才覆盖；否则保留旧值，首版写 null+unknown。
    if layout_prov_path:
        entry["layout_profile"] = read_layout_profile(layout_prov_path)
    elif isinstance(old_entry.get("layout_profile"), dict):
        entry["layout_profile"] = old_entry["layout_profile"]
    else:
        entry["layout_profile"] = empty_layout_profile()

    expect[name + ".md"] = entry

# ── 逐夹具 diff（`bugs/0194`）：⛔ 不静默覆盖冻结值 ─────────────────────
print("── fixtures-expect 逐夹具 diff（旧 → 新）──")
changed = 0
for name in sorted(set(old) | set(expect)):
    if name not in old:
        print("+ %s 新增" % name)
        changed += 1
        continue
    if name not in expect:
        print("- %s 移除（本次载荷里没有）" % name)
        changed += 1
        continue
    for field in ("sha256", "blocks_kind", "dom_line_boxes",
                  "dom_line_boxes_stale", "layout_profile"):
        before = old[name].get(field, "<缺失>")
        after = expect[name].get(field, "<缺失>")
        if before != after:
            print("~ %s %s" % (name, field))
            print("    旧: %s" % show(before))
            print("    新: %s" % show(after))
            changed += 1
if changed == 0:
    print("· 无变化")
else:
    print("· 合计 %d 处变化" % changed)
print("· export_id: %s" % export_id)
if stale_marked:
    print("⚠️ %d 条夹具的 sha256 变了，但旧 dom_line_boxes 仍原值保留："
          "已标 dom_line_boxes_stale=true（reason=fixture-sha-changed）。"
          "⛔ 本轮不自动清零，待设计裁定（bugs/0194 / R5 §3.8）。" % stale_marked,
          file=sys.stderr)

out_dir = os.path.dirname(os.path.abspath(out_path)) or "."
os.makedirs(out_dir, exist_ok=True)
tmp_path = out_path + ".tmp.%d" % os.getpid()
try:
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(expect, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp_path, out_path)
except BaseException:
    try:
        os.unlink(tmp_path)
    except OSError:
        pass
    raise
print(f"✅ 写出 {out_path}（{len(expect)} 条，renderer={renderer}，export_id={export_id}）",
      file=sys.stderr)
PY
}

# ── 锁：所有会写产物的路径（含 --augment-only）都要先拿锁 ───────────────
acquire_lock

# ── --augment-only：只补 provenance，⛔ 不跑 cargo、⛔ 不覆盖既有产物 ─────
if [ -n "$AUGMENT_ONLY" ]; then
  [ -f "$AUGMENT_ONLY" ] || usage_error "载荷不存在：$AUGMENT_ONLY"
  [ -n "$AUGMENT_OUT" ] || usage_error "--augment-only 必须同时给 --out（⛔ 不原地覆盖）"
  if [ "$AUGMENT_OUT" = "$AUGMENT_ONLY" ]; then
    usage_error "--out 不能与输入相同（⛔ 不原地覆盖）"
  fi
  augment_payload "$AUGMENT_ONLY" "$AUGMENT_OUT"
  if [ -n "$EXPECT_OUT" ]; then
    generate_expect "$AUGMENT_OUT" "$FIXTURES" "$EXPECT_OUT" "$EXPECT_OUT" \
      "$RESET_LINE_BOXES" "$LAYOUT_PROVENANCE"
  fi
  exit 0
fi

# ── 前置条件：前端 bundle、夹具、输出目录 ────────────────────────────────
if [ ! -s "$CM6" ]; then
  die "缺 $CM6 —— 先跑 make cm6（⛔ 本脚本不替你装依赖）"
fi
if ! ls "$FIXTURES"/*.md >/dev/null 2>&1; then
  die "夹具目录里没有 .md：$FIXTURES"
fi
MD_COUNT="$(ls "$FIXTURES"/*.md | wc -l | tr -d ' ')"
if [ "$MD_COUNT" -ne "$EXPECTED_COUNT" ]; then
  die "夹具数量为 ${MD_COUNT}，应为 $EXPECTED_COUNT"
fi
if [ ! -d "$ROOT/src-tauri" ]; then
  die "缺 $ROOT/src-tauri"
fi
if [ ! -f "$STAGE_A_CHECK" ]; then
  die "缺 ${STAGE_A_CHECK}（Stage A 成功判据，bugs/0254）"
fi

# ── 覆盖闸：已有产物时必须显式 --force ──────────────────────────────────
if [ "$FORCE" -ne 1 ]; then
  if [ -e "$FIXTURE_JSON" ] || [ -e "$EXPECT" ]; then
    echo "⛔ 已有产物，拒绝覆盖：" >&2
    [ -e "$FIXTURE_JSON" ] && echo "   $FIXTURE_JSON" >&2
    [ -e "$EXPECT" ] && echo "   ${EXPECT}（首采后入库冻结，⛔ 不得静默重生成，见 design/0063 §2.6 E2）" >&2
    echo "   确认要重生成请加 --force。" >&2
    exit 3
  fi
fi

mkdir -p "$WORK" "$TMP_DIR" || die "建不了工作目录：$WORK / $TMP_DIR"

# `bugs/0254` / R5 §3.3：开跑先清过期临时载荷；本次临时文件由 EXIT trap 兜底。
cleanup_old_tmp
# R5 §3.2：上一次导出若在载荷/期望之间中断，`.export-in-progress` 仍在。
warn_if_in_progress
echo "🗂  工作产物：${WORK}（备份 ${BACKUP_DIR}，临时 ${TMP_DIR}）；已由 tools/visual-parity/.gitignore 覆盖，⛔ 不要 git add。" >&2

# ── 备份旧产物（`bugs/0194` / `0256`）：必须在任何覆盖之前成功 ───────────
PAYLOAD_BACKUP=""
if [ "$FORCE" -eq 1 ] || [ -e "$FIXTURE_JSON" ]; then
  PAYLOAD_BACKUP="$(backup_file "$FIXTURE_JSON")"
fi
if [ "$FORCE" -eq 1 ] || [ -e "$EXPECT" ]; then
  backup_file "$EXPECT" >/dev/null
fi

# ── Stage A：真 comrak 导出载荷（先写临时文件，`bugs/0254` / `0256`）────
TMP_PAYLOAD="$TMP_DIR/fixtures.json.$$.tmp"
AUGMENTED="$TMP_DIR/fixtures.json.$$.aug"
CLEANUP_FILES+=("$TMP_PAYLOAD" "$AUGMENTED")
rm -f "$TMP_PAYLOAD" "$AUGMENTED" || die "清不掉旧临时载荷：$TMP_PAYLOAD / $AUGMENTED"
[ ! -e "$TMP_PAYLOAD" ] || die "清不掉旧临时载荷：$TMP_PAYLOAD"

echo "▶ Stage A：真 comrak 导出 $(printf '%s' "$MD_COUNT") 份夹具载荷…" >&2
set +e
(
  cd "$ROOT/src-tauri"
  RMD_LIVE_BLOCK_DIR="$FIXTURES" RMD_LIVE_BLOCK_OUT="$TMP_PAYLOAD" \
    cargo test --release --offline --features gui -- --ignored --nocapture live_block \
    >"$STAGE_LOG" 2>&1
)
STAGE_RC=$?
set -e
if [ "$STAGE_RC" -ne 0 ]; then
  echo "⛔ Stage A 失败（cargo test --ignored live_block，退出码 ${STAGE_RC}）：" >&2
  echo "──── $STAGE_LOG 尾部 ────" >&2
  tail -n 60 "$STAGE_LOG" >&2 || true
  echo "   旧载荷/旧期望未改动${PAYLOAD_BACKUP:+（旧载荷备份：${PAYLOAD_BACKUP}）}" >&2
  exit 3
fi

# `bugs/0254`：cargo 退 0 不等于测试跑了；日志三行必须按顺序命中。
if ! python3 -I "$STAGE_A_CHECK" "$STAGE_LOG" "live_block_夹具导出"; then
  echo "⛔ Stage A 日志不能证明 live_block_夹具导出 真的跑了（bugs/0254）：$STAGE_LOG" >&2
  echo "   旧载荷/旧期望未改动${PAYLOAD_BACKUP:+（旧载荷备份：${PAYLOAD_BACKUP}）}" >&2
  exit 3
fi
if [ ! -s "$TMP_PAYLOAD" ]; then
  echo "⛔ Stage A 没产出本次载荷：$TMP_PAYLOAD" >&2
  echo "──── $STAGE_LOG 尾部 ────" >&2
  tail -n 60 "$STAGE_LOG" >&2 || true
  echo "   旧载荷/旧期望未改动${PAYLOAD_BACKUP:+（旧载荷备份：${PAYLOAD_BACKUP}）}" >&2
  exit 3
fi

# ── 校验载荷：20 份 doc，name 与文件名（去 .md）一致，每份有 blocks 与 html ──
validate_payload() {
python3 -I - "$TMP_PAYLOAD" "$FIXTURES" "$EXPECTED_COUNT" <<'PY'
import json, os, sys

payload_path, fixtures_dir, expected = sys.argv[1], sys.argv[2], int(sys.argv[3])
with open(payload_path, encoding="utf-8") as f:
    payload = json.load(f)

docs = payload.get("docs") or []
problems = []
if len(docs) != expected:
    problems.append(f"docs 数量为 {len(docs)}，应为 {expected}")

stems = sorted(
    os.path.splitext(n)[0]
    for n in os.listdir(fixtures_dir)
    if n.endswith(".md")
)
seen = []
for doc in docs:
    name = doc.get("name")
    seen.append(name)
    if name not in stems:
        problems.append(f"doc.name={name!r} 不对应任何夹具文件名")
        continue
    if "blocks" not in doc or not isinstance(doc["blocks"], list):
        problems.append(f"{name}: 缺 blocks 数组")
    if "html" not in doc or not isinstance(doc["html"], str) or not doc["html"]:
        problems.append(f"{name}: 缺非空 html")
    if doc.get("block_kinds") != [
        "Paragraph", "Heading", "CodeBlock", "List", "BlockQuote",
        "Table", "HtmlBlock", "ThematicBreak", "FootnoteDefinition", "Other",
    ]:
        problems.append(f"{name}: block_kinds 不是产品 KIND_NAMES 的 10 个名字")
    else:
        idx_max = len(doc["block_kinds"]) - 1
        for b in doc["blocks"]:
            if not (isinstance(b, list) and len(b) >= 1 and 0 <= b[0] <= idx_max):
                problems.append(f"{name}: blocks 里出现非法 kind_idx: {b!r}")
                break
if sorted(seen) != stems:
    problems.append(f"name 集合与夹具文件不一致：{sorted(seen)} vs {stems}")

if problems:
    print("⛔ 载荷校验失败：", file=sys.stderr)
    for p in problems:
        print(f"   - {p}", file=sys.stderr)
    sys.exit(3)
print(f"✅ 载荷校验通过：{len(docs)} 份 doc，name 与夹具文件名一一对应", file=sys.stderr)
PY
}
if ! validate_payload; then
  # 期望的校验失败是 Python 自己退 3；这里把未预期崩溃也归一到 3（契约只允许 0/3）。
  exit 3
fi

# ── provenance（`bugs/0154`）＋ export_id（`bugs/0256`）：写回临时载荷 ──
augment_payload "$TMP_PAYLOAD" "$AUGMENTED" || die "写 provenance/export_id 失败：$TMP_PAYLOAD"
mv "$AUGMENTED" "$TMP_PAYLOAD" || die "临时载荷落盘失败：$TMP_PAYLOAD"

# ── 跨文件事务：先落「进行中」标记，再提交载荷（R5 §3.2）─────────────────
# 载荷与期望不是一次 rename 能同时替换的两个文件；标记让下一次运行/消费者
# 能发现「新载荷 + 旧期望」。⚠️ 本标记不提供断电原子性，只提供可发现性。
EXPORT_ID="$(python3 -I - "$TMP_PAYLOAD" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
export_id = data.get("export_id")
if not isinstance(export_id, str) or not export_id:
    print("⛔ 临时载荷缺 export_id", file=sys.stderr)
    sys.exit(3)
print(export_id)
PY
)" || die "读不出本次 export_id：$TMP_PAYLOAD"
write_in_progress "$EXPORT_ID" "committing-payload" || die "写不了导出进行中标记：$IN_PROGRESS_FILE"

# ── 载荷落盘：原子替换；旧载荷已在上面备份 ──────────────────────────────
mv "$TMP_PAYLOAD" "$FIXTURE_JSON" || die "载荷落盘失败：${FIXTURE_JSON}（旧载荷备份：${PAYLOAD_BACKUP:-无}）"

# ── 生成 fixtures-expect.json（temp + os.replace；失败恢复旧载荷）───────
if ! generate_expect "$FIXTURE_JSON" "$FIXTURES" "$EXPECT" "$EXPECT" \
     "$RESET_LINE_BOXES" "$LAYOUT_PROVENANCE"; then
  echo "⛔ 期望生成失败，恢复旧载荷（bugs/0256）：$FIXTURE_JSON" >&2
  if [ -n "$PAYLOAD_BACKUP" ] && [ -f "$PAYLOAD_BACKUP" ]; then
    cp -p "$PAYLOAD_BACKUP" "$FIXTURE_JSON" || die "恢复旧载荷失败：$PAYLOAD_BACKUP"
    echo "   已从备份恢复：$PAYLOAD_BACKUP" >&2
  else
    rm -f "$FIXTURE_JSON" || die "移除未完成载荷失败：$FIXTURE_JSON"
    echo "   首跑无旧载荷 ⇒ 已移除本次未完成载荷" >&2
  fi
  # 回滚成功后载荷/期望重新一致 ⇒ 清除「进行中」标记。
  remove_in_progress
  exit 3
fi

# 期望已成功落盘 ⇒ 本次事务完成，清除标记。
remove_in_progress

echo "✅ Stage A 完成：$FIXTURE_JSON" >&2
echo "✅ 期望：$EXPECT" >&2
