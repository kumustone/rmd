#!/usr/bin/env bash
# design/0063 §7.2 L2 跑批入口：五步管线 ＋ 页内 CSS 变异 M1–M6 ＋ 负对照 N1–N7。
#
# 用法：
#   tools/visual-parity/l2-run.sh --fixtures <a,b,c> [选项]
#   tools/visual-parity/l2-run.sh --all [选项]
#
#   --fixtures <a,b,c>   夹具名（可带 .md）；与 --all 二选一。
#   --all                跑 .work/fixtures.json 里的全部夹具。
#   --mutations [LIST]   生成变异页；LIST 缺省为 all（M1–M6）。
#                        M1-INV 与 M1 同一次运行，⛔ 不单独出页。
#   --negative [LIST]    跑管线层负对照；LIST 缺省为 all（N1–N7）。
#                        N4 已移入 §7.1（L1），这里只登记 n/a。
#   --sidebar-width <px> L1 实测侧栏宽（⛔ 不回退到 260/280）。
#                        缺省读 RMD_PARITY_SIDEBAR_WIDTH；两者都没有 ⇒ 退出 3。
#   --dpr <f>            显式期望 DPR；给了才向 l2-snapshot 传 --dpr（不符即 exit 64）。
#                        缺省不传，取工具实测 px/pt（1× 屏不再被默认 2.0 判死，bug/0125）。
#                        实跑会把期望/实测/来源写到 <case>/dpr.log。
#   --canvas-width <pt>  画布宽（默认 1000）。
#   --canvas-height <pt> 画布高（默认 801）。
#   --timeout <ms>       等 __PARITY_READY 的超时（默认 15000）。
#   --work <dir>         工作根（默认 tools/visual-parity/.work）。
#   --out <json>         汇总结果（默认 <work>/l2/result.json）。
#   --fixtures-json <p>  Stage A 载荷（默认 <work>/fixtures.json）。
#                        启动即校验其 provenance.build_id 与 build-id.txt 一致；
#                        不等 ⇒ 退出 2 并打印双方值（bug/0154，⛔ 不自动沿用）。
#                        build-id.txt 默认 <root>/build/macos/rmd.app/Contents/Resources/build-id.txt，
#                        可用 RMD_L2_BUILD_ID_FILE 指向其它落点（如已装 .app）。
#   --expect <p>         fixtures-expect.json（默认 tools/visual-parity/fixtures-expect.json）。
#   --baseline <p>       L1 基线（默认 tools/visual-parity/baseline.json）。
#   --force              清掉本工具的既有产物后重跑。
#   --dry-run            只打印命令序列并校验输入，⛔ 不写文件、⛔ 不判红绿。
#
# 产物布局（与 l2-check.sh 的 `--work` 口径一致）：
#   <work>/<fixture>/                       参考页（未变异）
#   <work>/mutations/<M>/<fixture>/          变异页
#   <work>/negative/<N>/                     负对照
#   <work>/l2/bin/l2-snapshot                swiftc 缓存的离屏取像二进制
#   <work>/l2/b0.json                        F0 实测的 B（device px，全夹具共用）
#   <work>/l2/result.json                    汇总
#
# 退出码：
#   0  全部请求项完成且通过（无 baseline 时仍可能为 30，不会假绿）
#   2  用法 / 参数错误
#   3  缺依赖或缺输入（会指名「缺 X」）
#   4  跑批内部错误（构建/取像/度量/比对命令失败；中间产物保留）
#   10 期望失败 / 变异面隔离失败（必须红没红、必须绿变红、负对照没打中）
#   15 产品排版变更（P-ENV-06 判因分叉；来自 l2-check/参考页判决，**原样透出**，⛔ 不并入 10）
#   20 环境无效（参考页 P-ENV 红）
#   30 未完成 / 未验证 / 不支持 / 无 L1 基线
#
# ⚠️ 10 在参考页路径上是 PRODUCT-MISMATCH，在变异路径上是 MUTATION-EXPECTATION-FAIL：
#    同一数值两种语义属已知契约缺口（bug/0144），结果 JSON 的 `exit_reasons` 逐条列出
#    每个贡献者的 (source,id,code,label)，⛔ 不允许只读顶层码判断原因。
#
# ⚠️ 只读离屏管线：不启动/激活 app、不 open、不发合成事件、不跑 cargo。
# ⚠️ Python 一律 `-I`（隔离模式）。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

WORK="$HERE/.work"
OUT=""
FIXTURES_ARG=""
MUTS_ARG=""
NEGS_ARG=""
SIDEBAR="${RMD_PARITY_SIDEBAR_WIDTH:-}"
DPR="2.0"
DPR_EXPLICIT=0
CANVAS_W="1000"
CANVAS_H="801"
TIMEOUT="15000"
FIXTURES_JSON=""
EXPECT="$HERE/fixtures-expect.json"
BASELINE="$HERE/baseline.json"
FORCE=0
DRYRUN=0

usage() {
  printf '%s\n' \
    '用法：' \
    '  tools/visual-parity/l2-run.sh --fixtures <a,b,c> [--mutations [LIST]] [--negative [LIST]] [选项]' \
    '  tools/visual-parity/l2-run.sh --all [--mutations [LIST]] [--negative [LIST]] [选项]' \
    '' \
    '必填：--fixtures <a,b,c> 或 --all；--sidebar-width（或 RMD_PARITY_SIDEBAR_WIDTH）' \
    '可选：--mutations [LIST] / --negative [LIST] / --dpr / --canvas-width / --canvas-height' \
    '      --timeout / --work / --out / --fixtures-json / --expect / --baseline' \
    '      --force / --dry-run' \
    '' \
    '退出码：0 通过；2 用法；3 缺依赖/输入；4 内部错误；10 期望/隔离失败；15 产品排版变更；20 环境无效；30 未完成'
}

die() {
  local code="$1"
  shift
  printf '⛔ %s\n' "$*" >&2
  exit "$code"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fixtures)
      [ "$#" -ge 2 ] || die 2 "--fixtures 缺参数值"
      FIXTURES_ARG="$2"; shift 2 ;;
    --fixtures=*)
      FIXTURES_ARG="${1#*=}"; shift ;;
    --all)
      [ -z "$FIXTURES_ARG" ] || die 2 "--all 与 --fixtures 不能同时给"
      FIXTURES_ARG="all"; shift ;;
    --mutations)
      # 可选值：下一个参数不以 '-' 开头才当成 LIST；显式空串必须报错（bug/0277）。
      if [ "$#" -ge 2 ]; then
        [ -n "$2" ] || die 2 "--mutations 不能为空：要么不给，要么给 M1,.../all（bug/0277）"
        if [ "${2#-}" = "$2" ]; then
          MUTS_ARG="$2"; shift 2
        else
          MUTS_ARG="all"; shift
        fi
      else
        MUTS_ARG="all"; shift
      fi ;;
    --mutations=*)
      MUTS_ARG="${1#*=}"
      [ -n "$MUTS_ARG" ] || die 2 "--mutations 不能为空：要么不给，要么给 M1,.../all（bug/0277）"
      shift ;;
    --negative)
      if [ "$#" -ge 2 ] && [ "${2#-}" = "$2" ] && [ -n "$2" ]; then
        NEGS_ARG="$2"; shift 2
      else
        NEGS_ARG="all"; shift
      fi ;;
    --negative=*)
      NEGS_ARG="${1#*=}"; shift ;;
    --sidebar-width)
      [ "$#" -ge 2 ] || die 2 "--sidebar-width 缺参数值"
      SIDEBAR="$2"; shift 2 ;;
    --sidebar-width=*)
      SIDEBAR="${1#*=}"; shift ;;
    --dpr)
      [ "$#" -ge 2 ] || die 2 "--dpr 缺参数值"
      DPR="$2"; DPR_EXPLICIT=1; shift 2 ;;
    --dpr=*)
      DPR="${1#*=}"; DPR_EXPLICIT=1; shift ;;
    --canvas-width)
      [ "$#" -ge 2 ] || die 2 "--canvas-width 缺参数值"
      CANVAS_W="$2"; shift 2 ;;
    --canvas-width=*)
      CANVAS_W="${1#*=}"; shift ;;
    --canvas-height)
      [ "$#" -ge 2 ] || die 2 "--canvas-height 缺参数值"
      CANVAS_H="$2"; shift 2 ;;
    --canvas-height=*)
      CANVAS_H="${1#*=}"; shift ;;
    --timeout)
      [ "$#" -ge 2 ] || die 2 "--timeout 缺参数值"
      TIMEOUT="$2"; shift 2 ;;
    --timeout=*)
      TIMEOUT="${1#*=}"; shift ;;
    --work)
      [ "$#" -ge 2 ] || die 2 "--work 缺参数值"
      WORK="$2"; shift 2 ;;
    --work=*)
      WORK="${1#*=}"; shift ;;
    --out)
      [ "$#" -ge 2 ] || die 2 "--out 缺参数值"
      OUT="$2"; shift 2 ;;
    --out=*)
      OUT="${1#*=}"; shift ;;
    --fixtures-json)
      [ "$#" -ge 2 ] || die 2 "--fixtures-json 缺参数值"
      FIXTURES_JSON="$2"; shift 2 ;;
    --fixtures-json=*)
      FIXTURES_JSON="${1#*=}"; shift ;;
    --expect)
      [ "$#" -ge 2 ] || die 2 "--expect 缺参数值"
      EXPECT="$2"; shift 2 ;;
    --expect=*)
      EXPECT="${1#*=}"; shift ;;
    --baseline)
      [ "$#" -ge 2 ] || die 2 "--baseline 缺参数值"
      BASELINE="$2"; shift 2 ;;
    --baseline=*)
      BASELINE="${1#*=}"; shift ;;
    --force)
      FORCE=1; shift ;;
    --dry-run)
      DRYRUN=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    -*)
      die 2 "不认识的参数：${1}（用 --help 看用法）" ;;
    *)
      die 2 "多余的位置参数：$1" ;;
  esac
done

[ -n "$FIXTURES_ARG" ] || die 2 "缺 --fixtures <a,b,c> 或 --all"
[ -n "$SIDEBAR" ] || die 3 "缺 --sidebar-width（或环境变量 RMD_PARITY_SIDEBAR_WIDTH）。
   侧栏宽必须是 L1 实测值（design/0063 §7.2 U4②）；
   ⛔ 本脚本不回退到代码里的 260/280 默认值。"

[ -n "$FIXTURES_JSON" ] || FIXTURES_JSON="$WORK/fixtures.json"
[ -n "$OUT" ] || OUT="$WORK/l2/result.json"

# 数值校验：只接受正数。
is_pos_number() {
  awk -v v="$1" 'BEGIN { exit !(v ~ /^[0-9]+([.][0-9]+)?$/ && v + 0 > 0) }'
}
is_pos_int() {
  awk -v v="$1" 'BEGIN { exit !(v ~ /^[0-9]+$/ && v + 0 > 0) }'
}
is_pos_number "$SIDEBAR" || die 2 "--sidebar-width 必须是正数（px），收到：$SIDEBAR"
is_pos_number "$DPR" || die 2 "--dpr 必须是正数，收到：$DPR"
is_pos_number "$CANVAS_W" || die 2 "--canvas-width 必须是正数，收到：$CANVAS_W"
is_pos_number "$CANVAS_H" || die 2 "--canvas-height 必须是正数，收到：$CANVAS_H"
is_pos_int "$TIMEOUT" || die 2 "--timeout 必须是正整数（ms），收到：$TIMEOUT"

# ── 依赖检查：缺什么就点名什么（⛔ 不静默成功）────────────────────────────
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die 3 "缺 ${1}${2:+（${2}）}"
}
need_file() {
  [ -f "$1" ] || die 3 "缺 ${1}${2:+（${2}）}"
}

need_cmd python3 "五步管线与 JSON 汇总都要它"
need_cmd swiftc "编译 l2-snapshot.swift 需要它"

need_file "$HERE/build-l2-page.sh" "§7.2 步 1 构页"
need_file "$HERE/l2-snapshot.swift" "§7.2 步 2 离屏取像"
need_file "$HERE/bands.py" "§7.2 步 3 度量"
need_file "$HERE/dom-probe.js" "L2-DOM 度量探针"
need_file "$HERE/preflight.py" "环境闸门与家族比较"
need_file "$HERE/l2-check.sh" "§7.2 步 4/5 参考页比对"
need_file "$HERE/mutations.py" "M1–M6 / M1-INV 变异定义"
need_file "$FIXTURES_JSON" "Stage A 载荷；应由 \`live_block_夹具导出\` 产出（⛔ 本脚本不跑 cargo）"
need_file "$EXPECT" "fixtures-expect.json"

[ -d "$HERE/fixtures" ] || die 3 "缺夹具目录：$HERE/fixtures"

# 变异/负对照的输入先做一次语法与取值自检（纯逻辑，不跑页面）。
python3 -I "$HERE/mutations.py" --selftest >/dev/null 2>&1 \
  || die 3 "mutations.py --selftest 失败：变异定义与 §7.2 不一致（先修定义再跑批）"

if [ -n "$MUTS_ARG" ]; then
  :
fi
if [ -n "$NEGS_ARG" ]; then
  :
fi

# ── 运行锁（bug/0214）：同一 --work/--out 并发会交叉写 stage / 软链 / result ──
# 语义与 export-fixtures.sh:212-240 一致：O_EXCL 建锁，第二个进程立即退非 0；
# 锁里写 PID，PID 已不存在则视为陈旧锁并清理。dry-run 只读，⛔ 不写锁。
BUILD_TIMEOUT="${RMD_L2_BUILD_TIMEOUT:-300}"
is_pos_int "$BUILD_TIMEOUT" || die 2 "RMD_L2_BUILD_TIMEOUT 必须是正整数（秒），收到：$BUILD_TIMEOUT"

# 子进程 watchdog（bug/0211）：bash 层唯一直接跑的构建命令是 swiftc。
# macOS 没有 GNU timeout；用 python3 的 subprocess timeout 包一层。
bounded() {
  local seconds="$1"
  shift
  python3 -I -c 'import subprocess, sys
try:
    sys.exit(subprocess.run(sys.argv[2:], timeout=float(sys.argv[1])).returncode)
except subprocess.TimeoutExpired:
    sys.stderr.write("timeout after %ss: %r\n" % (sys.argv[1], sys.argv[2:]))
    sys.exit(124)' "$seconds" "$@"
}

LOCK_FILES=()
LOCK_HELD_FILES=()
ENGINE_PID=""
release_locks() {
  local f
  for f in "${LOCK_HELD_FILES[@]:-}"; do
    [ -n "$f" ] && rm -f "$f" 2>/dev/null || true
  done
  LOCK_HELD_FILES=()
}
# bug/0178 §6②（D3 新发现②）：外部 supervisor 常只杀 bash 包装 PID。旧 trap 要等
# 前台 python 结束才执行，无法即时中断。现在引擎放到后台，TERM/INT 先转发给引擎
# （引擎自己的 signal handler 写 state=interrupted），最多等 5 s，再 KILL。
stop_engine() {
  local sig="$1" code="$2" i
  trap - TERM INT EXIT
  if [ -n "$ENGINE_PID" ] && kill -0 "$ENGINE_PID" 2>/dev/null; then
    kill -"$sig" "$ENGINE_PID" 2>/dev/null || true
    for i in 1 2 3 4 5; do
      kill -0 "$ENGINE_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$ENGINE_PID" 2>/dev/null || true
    wait "$ENGINE_PID" 2>/dev/null || true
  fi
  release_locks
  exit "$code"
}
acquire_one_lock() {
  local lock="$1" attempt pid
  mkdir -p "$(dirname "$lock")" || die 3 "建不了锁目录：$(dirname "$lock")"
  for attempt in 1 2 3; do
    if ( set -C; printf '%s\n' "$$" >"$lock" ) 2>/dev/null; then
      LOCK_HELD_FILES+=("$lock")
      return 0
    fi
    pid=""
    if [ -f "$lock" ]; then
      pid="$(tr -dc '0-9' <"$lock" 2>/dev/null || true)"
    fi
    if [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null && kill -0 "$pid" 2>/dev/null; then
      die 3 "另一个 l2-run 在跑（锁 ${lock}，PID ${pid}）；⛔ 不并发写同一 --work/--out（bug/0214）"
    fi
    printf '⚠️  清理陈旧 l2-run 锁（%s，PID %s 已不存在）\n' "$lock" "${pid:-未知}" >&2
    rm -f "$lock" || die 3 "清不掉陈旧锁：$lock"
  done
  die 3 "拿不到运行锁：${lock}（另一个 l2-run 在跑）"
}
if [ "$DRYRUN" -eq 0 ]; then
  LOCK_FILES+=("$WORK/.l2-run.lock")
  LOCK_FILES+=("$OUT.l2-run.lock")
  for _lock in "${LOCK_FILES[@]}"; do
    acquire_one_lock "$_lock"
  done
  trap release_locks EXIT
  trap 'stop_engine INT 130' INT
  trap 'stop_engine TERM 143' TERM
fi

# baseline 不存在不是错误：-PARITY 会记 skipped(no-baseline)，整体 INCOMPLETE。
if [ ! -f "$BASELINE" ] && [ "$DRYRUN" -eq 0 ]; then
  printf '⚠️  没有 L1 基线：%s\n' "$BASELINE" >&2
  printf '   -PARITY 将记 skipped(no-baseline)，整轮只会到 INCOMPLETE，⛔ 不会假绿。\n' >&2
fi

# ── 取像二进制：非 dry-run 时按需编译并缓存 ──────────────────────────────
SNAP_BIN="$WORK/l2/bin/l2-snapshot"
need_build=0
if [ ! -x "$SNAP_BIN" ]; then
  need_build=1
elif [ "$HERE/l2-snapshot.swift" -nt "$SNAP_BIN" ]; then
  need_build=1
fi

if [ "$need_build" -eq 1 ]; then
  if [ "$DRYRUN" -eq 1 ]; then
    printf '[dry-run] $ mkdir -p %s\n' "$(dirname "$SNAP_BIN")"
    printf '[dry-run] $ swiftc -O %s -o %s\n' "$HERE/l2-snapshot.swift" "$SNAP_BIN"
  else
    mkdir -p "$(dirname "$SNAP_BIN")"
    build_log="$WORK/l2/bin/swiftc.log"
    printf '$ swiftc -O %s -o %s\n' "$HERE/l2-snapshot.swift" "$SNAP_BIN" >"$build_log"
    if ! bounded "$BUILD_TIMEOUT" swiftc -O "$HERE/l2-snapshot.swift" -o "$SNAP_BIN" >>"$build_log" 2>&1; then
      die 3 "缺可用的 l2-snapshot 二进制：swiftc 编译失败或超时（${BUILD_TIMEOUT}s，日志：${build_log}）"
    fi
    [ -x "$SNAP_BIN" ] || die 3 "缺可用的 l2-snapshot 二进制：编译后仍不可执行（${SNAP_BIN}）"
  fi
fi

# ── 交给内嵌 Python 引擎（⛔ 不 exec：锁由 EXIT trap 释放）──────────────
# 后台启动以便 TERM/INT 能立即转发（见 stop_engine）；heredoc 仍只喂给引擎。
ENGINE_RC=0
python3 -I - \
  "$HERE" "$ROOT" "$WORK" "$OUT" \
  "$FIXTURES_ARG" "$MUTS_ARG" "$NEGS_ARG" \
  "$SIDEBAR" "$DPR" "$DPR_EXPLICIT" "$CANVAS_W" "$CANVAS_H" "$TIMEOUT" \
  "$FORCE" "$DRYRUN" \
  "$FIXTURES_JSON" "$EXPECT" "$BASELINE" "$SNAP_BIN" <<'PY' &
# -*- coding: utf-8 -*-
"""l2-run 内嵌引擎。

只做编排与 JSON 汇总；构页/取像/度量/比对全部调用既有工具，
⛔ 不在此重写产品渲染，也不另造第二份正文真相。
"""

import fnmatch
import hashlib
import json
import math
import os
import re
import shlex
import shutil
import statistics
import subprocess
import sys
import time
import traceback

(
    HERE, ROOT, WORK, OUT,
    FIXTURES_ARGRAW, MUTS_ARGRAW, NEGS_ARGRAW,
    SIDEBAR_S, DPR_S, DPR_EXPLICIT_S, CANVAS_W_S, CANVAS_H_S, TIMEOUT_S,
    FORCE_S, DRYRUN_S,
    FIXTURES_JSON, EXPECT, BASELINE, SNAP_BIN,
) = sys.argv[1:20]

SIDEBAR = float(SIDEBAR_S)
DPR = float(DPR_S)
DPR_EXPLICIT = DPR_EXPLICIT_S == "1"
CANVAS_W = float(CANVAS_W_S)
CANVAS_H = float(CANVAS_H_S)
TIMEOUT = int(TIMEOUT_S)
FORCE = FORCE_S == "1"
DRY = DRYRUN_S == "1"

# 本脚本自身逻辑的版本号：`case_fingerprint` 不含 l2-run.sh 的 sha，
# 改派生/接线后必须让旧阶段失效，否则会复用缺新字段的 measured.json。
# d3-p0/1：R7/R6 P0（锁/超时/指纹/快照 provenance/缓存可区分）落地后 bump。
L2RUN_LOGIC_VERSION = "d3-p0/1"

# 子进程 watchdog（bug/0211）：所有 run_cmd 子进程默认不超过这个秒数。
# 页面就绪本身由 --timeout（ms）控制；给构建/度量/比对留余量，并允许环境变量覆盖。
CMD_TIMEOUT = float(os.environ.get("RMD_L2_CMD_TIMEOUT") or 0) or max(
    120.0, float(TIMEOUT) / 1000.0 * 8.0)


def sha_tree(root):
    """目录内容指纹（bug/0199）：相对路径 + 文件内容的稳定 sha256。

    产品 `src/` 由 build-l2-page.sh 整棵拷进页面；只比脚本 sha 会漏掉样式/脚本
    改动，导致旧页与旧测量被复用。返回 None 表示目录不存在。
    """
    if not os.path.isdir(root):
        return None
    h = hashlib.sha256()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith(".") or name.endswith((".swp", ".tmp")):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root)
            h.update(rel.encode("utf-8"))
            h.update(b"\0")
            h.update((sha_file(path) or "unreadable").encode("utf-8"))
            h.update(b"\n")
    return h.hexdigest()


_PRODUCT_SRC_SHA = None


def product_src_fingerprint():
    global _PRODUCT_SRC_SHA
    if _PRODUCT_SRC_SHA is None:
        _PRODUCT_SRC_SHA = sha_tree(os.path.join(ROOT, "src"))
    return _PRODUCT_SRC_SHA



def _abs_input(path):
    """输入路径统一解析成绝对路径（bug/0156）。

    软链保存的是**目标字符串本身**；相对目标会相对链接所在目录解析 ⇒ 工作根与
    链接根不同时必然悬空。这里一次解析，后续 `os.symlink` 只拿到绝对目标。
    """
    return os.path.abspath(os.path.expanduser(str(path)))


WORK = _abs_input(WORK)
OUT = _abs_input(OUT)
FIXTURES_JSON = _abs_input(FIXTURES_JSON)
EXPECT = _abs_input(EXPECT)
BASELINE = _abs_input(BASELINE)
SNAP_BIN = _abs_input(SNAP_BIN)

BUILD = os.path.join(HERE, "build-l2-page.sh")
SNAP_SWIFT = os.path.join(HERE, "l2-snapshot.swift")
BANDS = os.path.join(HERE, "bands.py")
PROBE = os.path.join(HERE, "dom-probe.js")
PREFLIGHT = os.path.join(HERE, "preflight.py")
CHECK = os.path.join(HERE, "l2-check.sh")
MUT_PY = os.path.join(HERE, "mutations.py")
FIXTURES_DIR = os.path.join(HERE, "fixtures")

L2_DIR = os.path.join(WORK, "l2")
RESULT_JSON = OUT
B0_JSON = os.path.join(L2_DIR, "b0.json")

MUT_ROOT = os.path.join(WORK, "mutations")
NEG_ROOT = os.path.join(WORK, "negative")

LOG_LINES = []


def log(msg=""):
    print(msg)
    LOG_LINES.append(msg)


def err(msg):
    print("⛔ " + msg, file=sys.stderr)


class CaseError(Exception):
    """某一阶段失败；调用方保留中间产物并把路径写进结果。"""

    def __init__(self, stage, detail, artifacts=None, cmd=None, rc=None, log_path=None):
        super().__init__(detail)
        self.stage = stage
        self.detail = detail
        self.artifacts = artifacts or []
        self.cmd = cmd
        self.rc = rc
        self.log_path = log_path

    def as_dict(self):
        return {
            "stage": self.stage,
            "detail": self.detail,
            "artifacts": self.artifacts,
            "cmd": self.cmd,
            "exit_code": self.rc,
            "log": self.log_path,
        }


def sha_file(path):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def load_json(path, required=False):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        if required:
            raise CaseError("load", "缺文件：%s" % path, [path])
        return None
    except json.JSONDecodeError as exc:
        raise CaseError("load", "%s 不是合法 JSON：%s" % (path, exc), [path])


def write_json(path, data):
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


# bug/0263 边角（D3 新发现④）：进程开始时间在模块初始化时就固定，fatal 占位
# 即使发生在 main() 之前也能带上 started_at/pid，⛔ 不再写 null。
PROCESS_STARTED_AT = now_iso()


def install_fatal_hook():
    """任何未预期异常都以 4（内部错误）退出，并尽量留下结果 JSON（bug/0156）。

    ⛔ 不再把裸 traceback + 退出码 1 交给调用方：1 不在码表里，下游无法分流。
    尽早安装：`load_json` 等模块级代码抛的异常也要被接住。
    """
    import traceback

    def hook(exc_type, exc, tb):
        if issubclass(exc_type, (SystemExit, KeyboardInterrupt)):
            sys.__excepthook__(exc_type, exc, tb)
            return
        detail = "".join(traceback.format_exception(exc_type, exc, tb))
        stage = getattr(exc, "stage", None) or "orchestrator"
        artifacts = getattr(exc, "artifacts", None) or []
        # bug/0215：初始化期的 CaseError 是「输入缺失/非法」⇒ 3，不是内部错误 4。
        # 其它未预期异常仍是 4；⛔ 不再让解释器以码表外的 1 退出。
        fatal_code = 4
        if isinstance(exc, CaseError) and stage in ("load", "bootstrap"):
            fatal_code = 3
        # bug/0215/0263：dry-run 只读，⛔ 不写 OUT；真实跑批的 fatal 也⛔ 不覆盖
        # 上一轮的聚合证据——先把旧 result 挪到 OUT.prev，再写 fatal。
        if not DRY:
            backup = None
            try:
                current_state = None
                if os.path.isfile(OUT):
                    try:
                        with open(OUT, encoding="utf-8") as f:
                            current_state = (json.load(f) or {}).get("state")
                    except Exception:
                        current_state = None
                # 开跑占位（state=running）不覆盖更早的 OUT.prev；否则把上一轮
                # 成功结果挪到 .prev，fatal 至少可回溯到真正的前一份证据。
                if os.path.isfile(OUT) and current_state != "running":
                    backup = OUT + ".prev"
                    os.replace(OUT, backup)
                out_dir = os.path.dirname(OUT)
                if out_dir:
                    os.makedirs(out_dir, exist_ok=True)
                write_json(OUT, {
                    "schema": "rmd-parity-l2run/1",
                    "tool": "l2-run",
                    "logic_version": globals().get("L2RUN_LOGIC_VERSION"),
                    "generated_at": now_iso(),
                    "started_at": globals().get("PROCESS_STARTED_AT") or now_iso(),
                    "state": "fatal",
                    "fatal": True,
                    "pid": os.getpid(),
                    "stage": stage,
                    "exit_code": fatal_code,
                    "error": {"type": exc_type.__name__, "detail": str(exc)},
                    "artifacts": artifacts,
                    "previous_result_backup": backup,
                    "invocation": {
                        "fixtures": globals().get("FIXTURES") or [],
                        "mutations": globals().get("SELECTED_MUTATIONS") or [],
                        "negatives": globals().get("SELECTED_NEGATIVES") or [],
                        "work": globals().get("WORK"),
                        "out": globals().get("OUT"),
                    },
                    "traceback": detail.splitlines()[-40:],
                })
            except Exception:
                pass
        sys.stderr.write("l2-run: 初始化/内部错误（stage=%s，exit %d）：%s\n"
                         % (stage, fatal_code, exc))
        sys.stderr.write(detail)
        sys.stderr.flush()
        os._exit(fatal_code)

    sys.excepthook = hook


install_fatal_hook()


def install_signal_handler():
    """bug/0263：SIGTERM/SIGINT 也要把 OUT 改成 interrupted，⛔ 不留旧成功 JSON。"""
    import signal

    def handler(signum, frame):
        if not DRY:
            try:
                write_json(OUT, {
                    "schema": "rmd-parity-l2run/1",
                    "tool": "l2-run",
                    "logic_version": globals().get("L2RUN_LOGIC_VERSION"),
                    "generated_at": now_iso(),
                    "started_at": globals().get("PROCESS_STARTED_AT") or now_iso(),
                    "state": "interrupted",
                    "pid": os.getpid(),
                    "signal": signum,
                    "exit_code": 4,
                    "invocation": {
                        "fixtures": globals().get("FIXTURES") or [],
                        "mutations": globals().get("SELECTED_MUTATIONS") or [],
                        "negatives": globals().get("SELECTED_NEGATIVES") or [],
                        "work": globals().get("WORK"),
                        "out": globals().get("OUT"),
                    },
                })
            except Exception:
                pass
        sys.stderr.write("l2-run: 被信号 %d 中断（state=interrupted）\n" % signum)
        sys.stderr.flush()
        os._exit(128 + signum)

    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)


install_signal_handler()


def quote_cmd(cmd):
    return " ".join(shlex.quote(str(x)) for x in cmd)


def run_cmd(cmd, log_path, capture=False, timeout=None):
    """执行命令；stdout/stderr 都进日志。dry-run 只打印。

    bug/0211：所有子进程都有 watchdog；超时返回 124（不无限阻塞整轮）。
    """
    log("  $ " + quote_cmd(cmd))
    if DRY:
        return 0, ""
    timeout = CMD_TIMEOUT if timeout is None else float(timeout)
    parent = os.path.dirname(os.path.abspath(log_path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    with open(log_path, "w", encoding="utf-8") as lf:
        lf.write("$ " + quote_cmd(cmd) + "\n")
        lf.flush()
        try:
            if capture:
                p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, errors="replace", timeout=timeout)
                lf.write(p.stdout or "")
                return p.returncode, p.stdout or ""
            p = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT, text=True,
                               errors="replace", timeout=timeout)
            return p.returncode, ""
        except subprocess.TimeoutExpired:
            lf.write("\n[TIMEOUT] 超过 %.1fs：%s\n" % (timeout, quote_cmd(cmd)))
            return 124, ""


def plan_cmd(cmd):
    """dry-run 命令打印（不执行）。"""
    log("[dry-run] $ " + quote_cmd(cmd))


def parse_kv_tail(text):
    out = {}
    for part in text.split("\t"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        out[key.strip()] = value.strip()
    return out


def png_size(path):
    try:
        with open(path, "rb") as f:
            head = f.read(24)
    except OSError:
        return None
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return [int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")]


def parse_dim(raw):
    m = re.match(r"^\s*(\d+)\s*[xX]\s*(\d+)\s*$", raw or "")
    return [int(m.group(1)), int(m.group(2))] if m else None


def parse_stdout_lines(text):
    data = {
        "ready": None,
        "primary": None,
        "backup": None,
        "snap": None,
        "snap_source": None,
        "dpr": None,
        "self": None,
        "provenance": None,
    }
    for line in (text or "").splitlines():
        if line.startswith("READY\t"):
            data["ready"] = parse_kv_tail(line.split("\t", 1)[1])
        elif line.startswith("PRIMARY\t"):
            parts = line.split("\t")
            data["primary"] = {
                "ok": len(parts) > 1 and parts[1] == "ok",
                "path": parts[2] if len(parts) > 2 else None,
                "size": parse_dim(parts[3]) if len(parts) > 3 else None,
                "error": parts[4] if len(parts) > 4 else None,
            }
        elif line.startswith("BACKUP\t"):
            parts = line.split("\t")
            data["backup"] = {
                "ok": len(parts) > 1 and parts[1] == "ok",
                "path": parts[2] if len(parts) > 2 else None,
                "size": parse_dim(parts[3]) if len(parts) > 3 else None,
                "error": parts[4] if len(parts) > 4 else None,
            }
        elif line.startswith("SNAP\t"):
            parts = line.split("\t")
            data["snap"] = {
                "path": parts[1] if len(parts) > 1 else None,
                "size": parse_dim(parts[2]) if len(parts) > 2 else None,
            }
        elif line.startswith("SNAP_SOURCE\t"):
            data["snap_source"] = line.split("\t", 1)[1].strip()
        elif line.startswith("DPR\t"):
            data["dpr"] = parse_kv_tail(line.split("\t", 1)[1])
        elif line.startswith("PROVENANCE\t"):
            data["provenance"] = parse_kv_tail(line.split("\t", 1)[1])
        elif line.startswith("SELF\t"):
            fields = parse_kv_tail(line.split("\t", 1)[1])
            data["self"] = {
                "frontmost_before": fields.get("frontmost_before"),
                "frontmost_after": fields.get("frontmost_after"),
                "frontmost_changed": fields.get("frontmost_changed"),
                "is_active": fields.get("NSApp.isActive"),
                "is_key_window": fields.get("window.isKeyWindow"),
            }
    return data


def as_bool(raw):
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        v = raw.strip().lower()
        if v in ("true", "1", "yes"):
            return True
        if v in ("false", "0", "no"):
            return False
    return None


def num_any(value):
    """数值化；工具自证里的数字常以字符串出现（`DPR\\tpx_per_pt=2.000`）。"""
    v = num(value)
    if v is not None:
        return v
    if isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError:
            return None
        return parsed if math.isfinite(parsed) else None
    return None


def rgb_hex(rgb):
    return "#%02x%02x%02x" % tuple(int(x) for x in rgb)


def color_is_transparent(value):
    """rgba(..., 0) 不是「无色」，但作锚点等于没测；按缺失处理。"""
    if not isinstance(value, str):
        return False
    match = re.match(r"rgba?\(([^)]+)\)", value.strip().lower())
    if not match:
        return False
    parts = [p for p in re.split(r"[,\s/]+", match.group(1).strip()) if p]
    if len(parts) >= 4:
        alpha = num_any(parts[3])
        return alpha is not None and alpha <= 0.001
    return False


def canonical_fixture(name):
    return str(name or "").strip().removesuffix(".md")


def split_list(raw, default=None):
    if raw is None or str(raw).strip() == "":
        return list(default or [])
    raw = str(raw).strip()
    if raw == "all":
        return ["all"]
    return [canonical_fixture(x) for x in raw.split(",") if canonical_fixture(x)]


def die2(msg):
    err(msg)
    sys.exit(2)


def die3(msg):
    err(msg)
    sys.exit(3)


# ── 输入装载与选择 ──────────────────────────────────────────────────────

payload = load_json(FIXTURES_JSON, required=True)
if not isinstance(payload, dict) or not isinstance(payload.get("docs"), list):
    die3("Stage A 载荷不是 {docs: [...]}：%s" % FIXTURES_JSON)

# ── bug/0154：载荷 provenance 与当前 build-id.txt 必须一致 ────────────────
#
# 旧载荷测新渲染会把「产品没变」误判成「基线过期」；这里启动即对表，
# 不等就退出 2 并打印双方值，⛔ 不自动重导出、⛔ 不静默沿用。
BUILD_ID_FILE = _abs_input(os.environ.get("RMD_L2_BUILD_ID_FILE")
                           or os.path.join(ROOT, "build/macos/rmd.app/Contents/Resources/build-id.txt"))


def verify_payload_build_id():
    provenance = payload.get("provenance")
    provenance = provenance if isinstance(provenance, dict) else {}
    payload_bid = str(provenance.get("build_id") or "").strip() or None
    try:
        with open(BUILD_ID_FILE, encoding="utf-8") as f:
            file_bid = f.read().strip() or None
    except OSError:
        file_bid = None
    record = {
        "status": "ok",
        "payload": FIXTURES_JSON,
        "payload_build_id": payload_bid,
        "build_id_file": BUILD_ID_FILE,
        "build_id": file_bid,
        "provenance_present": isinstance(payload.get("provenance"), dict),
        "exported_at": provenance.get("exported_at"),
        "docs_sha256": provenance.get("docs_sha256"),
        "docs_sha_matches": provenance.get("docs_sha_matches"),
    }
    if payload_bid is None or file_bid is None or payload_bid != file_bid:
        record["status"] = "mismatch"
        err("载荷 provenance.build_id 与当前 build-id.txt 不一致（bug/0154）：")
        err("  载荷：%s" % FIXTURES_JSON)
        err("    载荷 build_id  = %s" % (payload_bid or "<缺失>"))
        err("  当前构建：%s" % BUILD_ID_FILE)
        err("    build-id.txt   = %s" % (file_bid or "<缺失>"))
        err("  ⛔ 不自动沿用旧载荷；请先重导出 Stage A 载荷（export-fixtures.sh），"
            "或用 RMD_L2_BUILD_ID_FILE 指向本次真正取像的 .app。")
        sys.exit(2)
    if record.get("docs_sha_matches") is False:
        err("⚠️  载荷 provenance.docs_sha_matches=false（文档指纹与导出时不一致）：%s"
            % FIXTURES_JSON)
    return record


PAYLOAD_PROVENANCE = payload.get("provenance") if isinstance(payload.get("provenance"), dict) else None
BUILD_ID_CHECK = verify_payload_build_id()

ALL_FIXTURES = []
FIXTURE_DOC = {}
for doc in payload.get("docs") or []:
    if not isinstance(doc, dict):
        continue
    name = canonical_fixture(doc.get("name"))
    if name:
        ALL_FIXTURES.append(name)
        FIXTURE_DOC[name] = doc
if not ALL_FIXTURES:
    die3("Stage A 载荷里没有 docs：%s" % FIXTURES_JSON)


# ── bug/0255：载荷 text ↔ `fixtures/<name>.md` 的内容绑定 ────────────────
#
# Stage A 载荷里每份 doc 自带 `text`（源文副本），磁盘 `fixtures/<name>.md`
# 才是构页源；l2-run 旧版只从磁盘算 sha、从载荷取 blocks/blocks_kind，两者之间
# 没有任何断言。这里在参考页阶段逐字节比较，**不做任何规范化**：
# ⛔ 不 strip、不折叠/统一换行；若将来出现合法的换行差异，必须先在
# `normalization` 里显式写明规则再放行，⛔ 不许悄悄判等。
# 不匹配 ⇒ 该夹具按 CaseError 记 invalid（沿用既有退出码 4，⛔ 不新增码）。
PAYLOAD_BINDING_CACHE = {}

# `blocks` 的 kind 下标 → 名字；这些 kind 至少渲染出 1 个行盒，
# 用作 DOM 规模的**下界**（HtmlBlock/ThematicBreak/Other 不保证有文本行盒）。
TEXT_BEARING_BLOCK_KINDS = frozenset([
    "Paragraph", "Heading", "CodeBlock", "List", "BlockQuote",
    "Table", "FootnoteDefinition",
])
# 与 document.rs / export-fixtures.sh 的 KIND_NAMES 同序（仅作缺字段时的兜底）。
FALLBACK_BLOCK_KINDS = [
    "Paragraph", "Heading", "CodeBlock", "List", "BlockQuote",
    "Table", "HtmlBlock", "ThematicBreak", "FootnoteDefinition", "Other",
]


def _first_byte_diff(a, b):
    """返回首个不同字节的偏移；完全相等返回 None。"""
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i
    return None if len(a) == len(b) else n


def payload_binding_for(fixture):
    """载荷 doc.text ↔ `fixtures/<fixture>.md` 的逐字节绑定记录（bug/0255）。"""
    cached = PAYLOAD_BINDING_CACHE.get(fixture)
    if cached is not None:
        return cached
    md_path = os.path.join(FIXTURES_DIR, fixture + ".md")
    record = {
        "fixture": fixture,
        "status": "ok",
        "fixture_path": md_path,
        "normalization": "none",
        "fixture_sha256": None,
        "payload_text_sha256": None,
        "payload_text_present": False,
        "payload_doc_sha256": None,
        "payload_doc_sha256_check": "absent",
        "reason": None,
    }
    doc = FIXTURE_DOC.get(fixture)
    if not isinstance(doc, dict):
        record.update(status="missing-payload-doc",
                      reason="载荷里没有该夹具的 doc 条目")
        PAYLOAD_BINDING_CACHE[fixture] = record
        return record

    doc_sha = doc.get("sha256")
    if doc_sha is None:
        doc_sha = doc.get("text_sha256")
    record["payload_doc_sha256"] = doc_sha

    text = doc.get("text")
    if not isinstance(text, str):
        record.update(status="missing-text",
                      reason="载荷 doc 缺 text 字段（或不是字符串）；⛔ 不默认通过")
        PAYLOAD_BINDING_CACHE[fixture] = record
        return record
    record["payload_text_present"] = True
    payload_bytes = text.encode("utf-8")
    record["payload_text_sha256"] = hashlib.sha256(payload_bytes).hexdigest()

    try:
        with open(md_path, "rb") as f:
            disk_bytes = f.read()
    except OSError as exc:
        record.update(status="fixture-unreadable",
                      reason="读不出夹具源文件：%s" % exc)
        PAYLOAD_BINDING_CACHE[fixture] = record
        return record
    record["fixture_sha256"] = hashlib.sha256(disk_bytes).hexdigest()

    if doc_sha is not None:
        record["payload_doc_sha256_check"] = (
            "ok" if doc_sha == record["fixture_sha256"] else "mismatch")
        if record["payload_doc_sha256_check"] == "mismatch":
            record.update(
                status="mismatch",
                reason=("载荷 doc.sha256=%s ≠ 磁盘夹具 sha256=%s"
                        % (doc_sha, record["fixture_sha256"])))
            PAYLOAD_BINDING_CACHE[fixture] = record
            return record

    if payload_bytes != disk_bytes:
        offset = _first_byte_diff(payload_bytes, disk_bytes)
        record.update(
            status="mismatch",
            reason=("载荷 text 与 fixtures/%s.md 不是逐字节相等"
                    "（未做换行/strip 规范化；首个差异偏移 %s，载荷 %d B / 磁盘 %d B）"
                    % (fixture, offset, len(payload_bytes), len(disk_bytes))))
        record["first_diff_offset"] = offset
        record["payload_text_bytes"] = len(payload_bytes)
        record["fixture_bytes"] = len(disk_bytes)
    PAYLOAD_BINDING_CACHE[fixture] = record
    return record


def payload_set_check():
    """载荷 doc 集合 ↔ `fixtures/*.md` 集合；多/少/重名都显式记（bug/0255）。"""
    raw_names = []
    for doc in payload.get("docs") or []:
        if not isinstance(doc, dict):
            continue
        name = canonical_fixture(doc.get("name"))
        if name:
            raw_names.append(name)
    duplicates = sorted({n for n in raw_names if raw_names.count(n) > 1})
    payload_names = sorted(set(raw_names))
    try:
        disk_names = sorted(f[:-3] for f in os.listdir(FIXTURES_DIR)
                            if f.endswith(".md"))
    except OSError as exc:
        return {
            "status": "unreadable",
            "reason": "读不出夹具目录：%s" % exc,
            "payload_count": len(payload_names),
            "disk_count": None,
            "missing_on_disk": None,
            "extra_on_disk": None,
            "duplicate_payload_names": duplicates,
        }
    missing_on_disk = sorted(set(payload_names) - set(disk_names))
    extra_on_disk = sorted(set(disk_names) - set(payload_names))
    status = "ok" if not (missing_on_disk or extra_on_disk or duplicates) else "mismatch"
    return {
        "status": status,
        "payload_path": FIXTURES_JSON,
        "fixtures_dir": FIXTURES_DIR,
        "payload_count": len(payload_names),
        "disk_count": len(disk_names),
        "missing_on_disk": missing_on_disk,
        "extra_on_disk": extra_on_disk,
        "duplicate_payload_names": duplicates,
    }


def payload_self_check():
    """载荷自身可复算的摘要：`provenance.docs_sha256` 与文件摘要（bug/0255）。"""
    record = {
        "status": "ok",
        "payload_path": FIXTURES_JSON,
        "payload_file_sha256": None,
        "payload_self_sha256": {"declared": None, "status": "absent"},
        "docs_sha256": {"recorded": None, "recomputed": None, "status": "absent"},
        "fixtures_payload_sha256": {
            "recorded": None,
            "status": "absent",
            "reason": None,
        },
    }
    try:
        with open(FIXTURES_JSON, "rb") as f:
            raw = f.read()
    except OSError as exc:
        record.update(status="unreadable",
                      reason="读不出载荷：%s" % exc)
        return record
    record["payload_file_sha256"] = hashlib.sha256(raw).hexdigest()

    declared_self = payload.get("sha256") or payload.get("payload_sha256")
    if isinstance(declared_self, str) and declared_self:
        record["payload_self_sha256"] = {
            "declared": declared_self,
            "status": ("ok" if declared_self == record["payload_file_sha256"]
                       else "mismatch"),
        }
        if record["payload_self_sha256"]["status"] == "mismatch":
            record["status"] = "mismatch"

    docs = payload.get("docs") or []
    canonical = json.dumps(docs, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":")).encode("utf-8")
    recomputed = hashlib.sha256(canonical).hexdigest()
    prov = PAYLOAD_PROVENANCE or {}
    recorded = prov.get("docs_sha256")
    if isinstance(recorded, str) and recorded:
        record["docs_sha256"] = {
            "recorded": recorded,
            "recomputed": recomputed,
            "status": "ok" if recorded == recomputed else "mismatch",
        }
        if record["docs_sha256"]["status"] == "mismatch":
            record["status"] = "mismatch"
    else:
        record["docs_sha256"]["recomputed"] = recomputed

    recorded_src = prov.get("fixtures_payload_sha256")
    if recorded_src is not None:
        # provenance 记的是**导入 provenance 之前**的源载荷字节；本文件已含
        # provenance，无法从自身重算 ⇒ 显式 not-verifiable，⛔ 不拿它冒充本文件摘要。
        record["fixtures_payload_sha256"] = {
            "recorded": recorded_src,
            "status": "not-verifiable",
            "reason": ("provenance.fixtures_payload_sha256 是导入 provenance "
                       "之前的源载荷摘要；本文件已含 provenance，无法从自身重算"),
        }
    return record


def payload_cross_check_for(fixture, dom_line_boxes):
    """bug/0260 消费侧：载荷 `count`/`line_count` 与 DOM 规模交叉核对。

    本轮**只记 WARN、不硬失败**（要不要判红留给设计）；缺席也显式记。
    """
    doc = FIXTURE_DOC.get(fixture) or {}
    warnings = []

    payload_count = payload.get("count")
    docs_len = len(payload.get("docs") or [])
    if payload_count is None:
        count_status = "warn"
        warnings.append({
            "check": "count",
            "detail": "载荷根对象没有 count 字段；⛔ 不能默认通过",
        })
    elif payload_count != docs_len:
        count_status = "warn"
        warnings.append({
            "check": "count",
            "detail": "载荷 count=%r ≠ len(docs)=%d" % (payload_count, docs_len),
        })
    else:
        count_status = "ok"

    text = doc.get("text")
    line_count = doc.get("line_count")
    expected_lines = None
    if not isinstance(text, str):
        lc_status = "warn"
        warnings.append({
            "check": "line_count",
            "detail": "载荷 doc 缺 text，无法复算 line_count",
        })
    elif not isinstance(line_count, int) or isinstance(line_count, bool):
        lc_status = "warn"
        warnings.append({
            "check": "line_count",
            "detail": "载荷 doc 缺 line_count（或不是整数）：%r" % (line_count,),
        })
    else:
        # 与 document.rs 的 LineIndex 口径一致：按 '\n' 分行；
        # 空串也是 1 行，"a\n" ⇒ 2 行（末尾换行后还有一个空行）。
        expected_lines = len(text.split("\n"))
        if line_count != expected_lines:
            lc_status = "warn"
            warnings.append({
                "check": "line_count",
                "detail": ("载荷 line_count=%d ≠ 由 text 复算的 LineIndex 行数=%d"
                           % (line_count, expected_lines)),
            })
        else:
            lc_status = "ok"

    kinds = doc.get("block_kinds")
    if not isinstance(kinds, (list, tuple)):
        kinds = FALLBACK_BLOCK_KINDS
    blocks = doc.get("blocks") or []
    text_blocks = 0
    for block in blocks:
        if not isinstance(block, (list, tuple)) or not block:
            continue
        idx = block[0]
        name = (kinds[idx] if isinstance(idx, int) and 0 <= idx < len(kinds)
                else None)
        if name in TEXT_BEARING_BLOCK_KINDS:
            text_blocks += 1
    if not isinstance(dom_line_boxes, int) or isinstance(dom_line_boxes, bool):
        dom_status = "warn"
        warnings.append({
            "check": "dom_scale",
            "detail": "DOM 探针未给出 line_boxes（%r）；⛔ 不能默认通过"
                      % (dom_line_boxes,),
        })
    elif text_blocks > 0 and dom_line_boxes <= 0:
        dom_status = "warn"
        warnings.append({
            "check": "dom_scale",
            "detail": ("载荷有 %d 个带文本的块，但 DOM 行盒数=0（页面未渲染正文？）"
                       % text_blocks),
        })
    elif text_blocks > 0 and dom_line_boxes < text_blocks:
        dom_status = "warn"
        warnings.append({
            "check": "dom_scale",
            "detail": ("DOM 行盒数 %d < 载荷带文本块数 %d（下界；"
                       "HtmlBlock/ThematicBreak/Other 不计入）"
                       % (dom_line_boxes, text_blocks)),
        })
    else:
        dom_status = "ok"

    status = "ok" if all(s == "ok" for s in (count_status, lc_status, dom_status)) else "warn"
    return {
        "status": status,
        "warnings": warnings,
        "rules": {
            "count": "载荷 count == len(docs)",
            "line_count": "line_count == len(text.split('\\n'))（LineIndex 口径：空串也算 1 行）",
            "dom_scale": ("dom_line_boxes >= 带文本块数"
                          "（Paragraph/Heading/CodeBlock/List/BlockQuote/Table/"
                          "FootnoteDefinition）；缺失即 WARN"),
            "hard_failure": False,
        },
        "count": {"payload": payload_count, "docs_len": docs_len,
                  "status": count_status},
        "line_count": {"payload": line_count, "text_lineindex": expected_lines,
                       "status": lc_status},
        "dom_scale": {"dom_line_boxes": dom_line_boxes,
                      "text_bearing_blocks": text_blocks,
                      "status": dom_status},
    }


req = split_list(FIXTURES_ARGRAW)
if req == ["all"]:
    FIXTURES = list(ALL_FIXTURES)
else:
    FIXTURES = []
    for name in req:
        if name not in FIXTURE_DOC:
            die3("夹具 %r 不在 Stage A 载荷里；可用：%s"
                 % (name, ", ".join(ALL_FIXTURES)))
        if name not in FIXTURES:
            FIXTURES.append(name)
if not FIXTURES:
    die2("没有选中任何夹具")


def load_mutations():
    # bug/0215：初始化期的失败统一抛 CaseError("bootstrap")，由上面的
    # sys.excepthook 落 result.json 并退出 3；⛔ 不用 die3 静默退出（无产物），
    # 也⛔ 让 JSON/结构错误以码表外的 1 退出。
    try:
        p = subprocess.run([sys.executable, "-I", MUT_PY, "--json"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           text=True, errors="replace", timeout=CMD_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise CaseError("bootstrap",
                        "mutations.py --json 超过 %.1fs 未返回（bug/0211）"
                        % CMD_TIMEOUT)
    except OSError as exc:
        raise CaseError("bootstrap", "无法执行 mutations.py --json：%s" % exc,
                        [MUT_PY])
    if p.returncode != 0:
        raise CaseError("bootstrap", "mutations.py --json 失败（exit %d）：%s"
                        % (p.returncode, p.stderr.strip()), [MUT_PY])
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError as exc:
        raise CaseError("bootstrap", "mutations.py --json 输出不是合法 JSON：%s"
                        % exc, [MUT_PY])


def mutation_index(spec):
    """bug/0215：校验 mutations.py --json 的结构，缺 id/形状不对时给可读错误。

    ⛔ 直接 `{m["id"]: m for m in ...}` 会在缺字段时抛 KeyError（detail 只有
    "'id'"），调用方既拿不到阶段也拿不到产物；这里统一收敛为 CaseError。
    """
    if not isinstance(spec, dict):
        raise CaseError("bootstrap", "mutations.py --json 顶层不是对象：%s"
                        % type(spec).__name__, [MUT_PY])
    rows = spec.get("mutations")
    if rows is None:
        rows = []
    if not isinstance(rows, list):
        raise CaseError("bootstrap", "mutations.py --json 的 mutations 不是数组：%s"
                        % type(rows).__name__, [MUT_PY])
    index = {}
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            raise CaseError("bootstrap", "mutations.py --json 的 mutations[%d] 不是对象"
                            % i, [MUT_PY])
        mid = row.get("id")
        if not isinstance(mid, str) or not mid:
            raise CaseError("bootstrap",
                            "mutations.py --json 的 mutations[%d] 缺字符串 id（现有键：%s）"
                            % (i, ", ".join(sorted(row)) or "无"), [MUT_PY])
        if mid in index:
            raise CaseError("bootstrap", "mutations.py --json 的变异 id 重复：%s" % mid,
                            [MUT_PY])
        index[mid] = row
    # 顶层配套字段同样先验形状：page_ids/all_ids 会被 list()/join() 直接消费，
    # env_mutation 会被 .get() 消费；类型不对时给可读错误，⛔ 留给 TypeError。
    for key in ("page_ids", "all_ids"):
        val = spec.get(key)
        if val is not None and (not isinstance(val, list)
                                or any(not isinstance(x, str) for x in val)):
            raise CaseError("bootstrap",
                            "mutations.py --json 的 %s 不是字符串数组：%s"
                            % (key, type(val).__name__), [MUT_PY])
    env = spec.get("env_mutation")
    if env is not None and not isinstance(env, dict):
        raise CaseError("bootstrap", "mutations.py --json 的 env_mutation 不是对象：%s"
                        % type(env).__name__, [MUT_PY])
    return index


MUTSPEC = load_mutations()
MUT_BY_ID = mutation_index(MUTSPEC)
PAGE_IDS = list(MUTSPEC.get("page_ids") or [])
INVARIANTS_BY_PAGE = {}
for m in MUTSPEC.get("mutations") or []:
    if m.get("same_run_as"):
        INVARIANTS_BY_PAGE.setdefault(m["same_run_as"], []).append(m)

mut_req = split_list(MUTS_ARGRAW)
if not mut_req:
    # bug/0277：`--mutations` 显式给空表或 `all` 但没有任何出页变异时，
    # ⛔ 不得静默得到空表后成功——与夹具侧 `die2` 同口径。
    if MUTS_ARGRAW not in (None, ""):
        die2("--mutations 解析为空（收到 %r）；可用：all 或 %s"
             % (MUTS_ARGRAW, ", ".join(MUTSPEC.get("all_ids") or [])))
    SELECTED_MUTATIONS = []
elif mut_req == ["all"]:
    if not PAGE_IDS:
        die2("--mutations all 但 mutations.py 没有出页变异（page_ids 为空）")
    SELECTED_MUTATIONS = list(PAGE_IDS)
else:
    SELECTED_MUTATIONS = []
    for mid in mut_req:
        if mid not in MUT_BY_ID:
            die2("未知变异：%s（可用：%s）" % (mid, ", ".join(MUTSPEC.get("all_ids") or [])))
        if mid == "M1-INV":
            # 与 M1 同一次运行；⛔ 不单独出页。
            if "M1" not in SELECTED_MUTATIONS:
                SELECTED_MUTATIONS.insert(0, "M1")
            continue
        if mid not in PAGE_IDS:
            die2("%s 不是出页变异（emit_page=false）" % mid)
        if mid not in SELECTED_MUTATIONS:
            SELECTED_MUTATIONS.append(mid)

NEG_IDS = ["N1", "N2", "N3", "N4", "N5", "N6", "N7"]
neg_req = split_list(NEGS_ARGRAW)
if not neg_req:
    SELECTED_NEGATIVES = []
elif neg_req == ["all"]:
    SELECTED_NEGATIVES = list(NEG_IDS)
else:
    SELECTED_NEGATIVES = []
    for nid in neg_req:
        if nid not in NEG_IDS:
            die2("未知负对照：%s（可用：%s）" % (nid, ", ".join(NEG_IDS)))
        if nid not in SELECTED_NEGATIVES:
            SELECTED_NEGATIVES.append(nid)

# B 来源固定是参考页 00-body 的 bands.pitch.B（bug/0148/0127）。因此无论是否
# 选了变异/负对照，只要 00-body 不在夹具集合里就必须补一条辅助参考页；
# bug/0207：此前只在 SELECTED_MUTATIONS/SELECTED_NEGATIVES 非空时才补，
# 导致 `--fixtures 01-headings` 这类纯参考子集拿不到 b_ref，每条记录都记
# stage="b" 错误并以 4 退出——工具自身的用法约束被误报成产物问题。
AUX_FIXTURES = []
if "00-body" not in FIXTURES:
    AUX_FIXTURES.append("00-body")
REF_FIXTURES = list(FIXTURES) + AUX_FIXTURES

# N3 需要一个非 F0 夹具来避开 P-ENV-02 的正文段准入；优先用户选中的第一个非 F0。
NEG_FIXTURE = next((f for f in FIXTURES if f != "00-body"), "00-body")


# ── 颜色：sRGB → CIELAB → CIEDE2000（与 preflight.py 同口径）────────────

def parse_color(value):
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        try:
            return tuple(max(0, min(255, int(round(float(value[i]))))) for i in range(3))
        except (TypeError, ValueError):
            return None
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    named = {"white": (255, 255, 255), "black": (0, 0, 0),
             "red": (255, 0, 0), "green": (0, 128, 0), "blue": (0, 0, 255)}
    if text in named:
        return named[text]
    if text.startswith("#"):
        hexpart = text[1:]
        if not re.fullmatch(r"[0-9a-f]{3,8}", hexpart):
            return None
        if len(hexpart) in (3, 4):
            hexpart = "".join(ch * 2 for ch in hexpart[:3])
        if len(hexpart) in (6, 8):
            return tuple(int(hexpart[i:i + 2], 16) for i in (0, 2, 4))
        return None
    match = re.match(r"rgba?\(([^)]+)\)", text)
    if match:
        parts = [p for p in re.split(r"[,\s/]+", match.group(1).strip()) if p]
        if len(parts) >= 3:
            try:
                return tuple(max(0, min(255, int(round(float(parts[i]))))) for i in range(3))
            except ValueError:
                return None
    return None


def rgb_to_lab(rgb):
    def linear(channel):
        channel = channel / 255.0
        return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4

    r, g, b = (linear(x) for x in rgb)
    x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
    y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.00000
    z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883

    def f(t):
        return t ** (1.0 / 3.0) if t > 0.008856 else (7.787 * t + 16.0 / 116.0)

    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def delta_e_2000(lab1, lab2):
    """CIEDE2000（Sharma 等实现口径）。"""
    l1, a1, b1 = lab1
    l2, a2, b2 = lab2
    c1 = math.hypot(a1, b1)
    c2 = math.hypot(a2, b2)
    c_bar = (c1 + c2) / 2.0
    g = 0.5 * (1 - math.sqrt(c_bar ** 7 / (c_bar ** 7 + 25 ** 7)))
    a1p = (1 + g) * a1
    a2p = (1 + g) * a2
    c1p = math.hypot(a1p, b1)
    c2p = math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360
    h2p = math.degrees(math.atan2(b2, a2p)) % 360

    dlp = l2 - l1
    dcp = c2p - c1p
    if c1p * c2p == 0:
        dhp = 0.0
    elif abs(h2p - h1p) <= 180:
        dhp = h2p - h1p
    elif h2p - h1p > 180:
        dhp = h2p - h1p - 360
    else:
        dhp = h2p - h1p + 360
    dhp_big = 2 * math.sqrt(c1p * c2p) * math.sin(math.radians(dhp / 2.0))

    l_bar = (l1 + l2) / 2.0
    c_bar_p = (c1p + c2p) / 2.0
    if c1p * c2p == 0:
        h_bar = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        h_bar = (h1p + h2p) / 2.0
    elif h1p + h2p < 360:
        h_bar = (h1p + h2p + 360) / 2.0
    else:
        h_bar = (h1p + h2p - 360) / 2.0

    t = (1
         - 0.17 * math.cos(math.radians(h_bar - 30))
         + 0.24 * math.cos(math.radians(2 * h_bar))
         + 0.32 * math.cos(math.radians(3 * h_bar + 6))
         - 0.20 * math.cos(math.radians(4 * h_bar - 63)))
    d_theta = 30 * math.exp(-(((h_bar - 275) / 25) ** 2))
    rc = 2 * math.sqrt(c_bar_p ** 7 / (c_bar_p ** 7 + 25 ** 7))
    sl = 1 + (0.015 * (l_bar - 50) ** 2) / math.sqrt(20 + (l_bar - 50) ** 2)
    sc = 1 + 0.045 * c_bar_p
    sh = 1 + 0.015 * c_bar_p * t
    rt = -math.sin(math.radians(2 * d_theta)) * rc
    return math.sqrt(
        (dlp / sl) ** 2 + (dcp / sc) ** 2 + (dhp_big / sh) ** 2
        + rt * (dcp / sc) * (dhp_big / sh)
    )


def color_delta(a, b):
    ca, cb = parse_color(a), parse_color(b)
    if ca is None or cb is None:
        return None
    return delta_e_2000(rgb_to_lab(ca), rgb_to_lab(cb))


# ── 数值与几何小工具 ────────────────────────────────────────────────────

def num(x):
    if isinstance(x, bool):
        return None
    if isinstance(x, (int, float)) and math.isfinite(float(x)):
        return float(x)
    return None


def med(values):
    if not values:
        return None
    vals = [num(v) for v in values]
    vals = [v for v in vals if v is not None]
    return statistics.median(vals) if vals else None


def item_path(item):
    return str(item.get("path") or "") if isinstance(item, dict) else ""


def item_rect(item):
    return item.get("rect") if isinstance(item, dict) else None


def rect_field(item, key):
    rect = item_rect(item)
    return num(rect.get(key)) if isinstance(rect, dict) else None


def png_fingerprint(path):
    size = png_size(path)
    return {"path": path, "size": size, "bytes": os.path.getsize(path) if os.path.isfile(path) else 0}


# ── L2-DOM / L2-PIXEL 度量派生 ──────────────────────────────────────────
#
# 口径：§2.2 的 X/B 比值。X 是 DOM 的 CSS px，B 是 F0 的 device px
# ⇒ 归一化 = X_css × DPR / B。颜色与占比不除 B。
# 这些值写进 measured.metrics，供 preflight 的 -PARITY 在将来有 baseline 时比较；
# 变异页的「必须红/必须绿」由本脚本用「同端灵敏度」比对变异页与未变异参考页。

def derive_metrics(dom_root, extras, B, bands=None):
    doc = dom_root.get("doc") or {}
    env = doc.get("env") or {}
    viewport = dom_root.get("viewport") or {}
    dpr = num(viewport.get("device_pixel_ratio")) or DPR

    metrics = {}
    details = {}
    spec = []
    missing = []
    skipped = []

    def norm(css):
        v = num(css)
        if v is None or not B:
            return None
        return v * dpr / B

    def put(cid, value, det=None, unit="ratio"):
        if det:
            details[cid] = det
        if value is not None:
            metrics[cid] = {"value": value, "unit": unit}

    def structural(cid, ok, detail):
        if ok:
            spec.append({"id": cid, "status": "pass", "detail": detail})

    def raw(name, value, unit, source, reason="no-producer"):
        """原始观测量：缺值也写进 metrics（null + missing），⛔ 不静默省略。"""
        record = {"value": value, "unit": unit, "source": source}
        if value is None:
            record["missing"] = True
            record["reason"] = reason
            missing.append({"metric": name, "reason": reason, "source": source})
        metrics[name] = record
        return value

    def color_metric(name, css_value, source, reason="no-producer"):
        if color_is_transparent(css_value):
            css_value = None
            reason = "transparent"
        rgb = parse_color(css_value)
        if rgb is None:
            raw(name, None, "color", source, reason=reason)
            return None
        hexv = rgb_hex(rgb)
        metrics[name] = {
            "value": hexv,
            "hex": hexv,
            "lab": list(rgb_to_lab(rgb)),
            "unit": "color",
            "source": source,
        }
        return hexv

    body_fs = num(env.get("font_size_px"))
    content_left = num(env.get("content_box_left_px"))

    # §2.4 列表缩进（IND_list / IND_nest）
    lists = doc.get("lists") or {}
    list_items = lists.get("items") or []
    by_level = {}
    for item in list_items:
        lvl = num(item.get("level"))
        indent = num(item.get("indent_px"))
        if lvl is not None and indent is not None:
            by_level.setdefault(int(lvl), []).append(indent)
    l1 = med(by_level.get(1))
    l2 = med(by_level.get(2))
    tags = {str(it.get("parent_list_tag") or "").lower() for it in list_items}
    if l1 is not None:
        if "ul" in tags:
            put("P-UL-01-PARITY", norm(l1), {"IND_list/B": norm(l1)})
        if "ol" in tags:
            put("P-OL-01-PARITY", norm(l1), {"IND_list/B": norm(l1)})
    if l1 is not None and l2 is not None:
        put("P-NEST-01-PARITY", norm(l2 - l1), {"IND_nest/B": norm(l2 - l1)})
    qli = [num(it.get("indent_px")) for it in list_items if "blockquote" in item_path(it)]
    if qli:
        v = med(qli)
        put("P-C-QULI-01-PARITY", norm(v), {"IND_list/B": norm(v)})

    # §2.5 引用条（W_qbar / IND_quote / 颜色）
    bq_items = (doc.get("blockquotes") or {}).get("items") or []
    bar_widths = [num((it.get("bar") or {}).get("effective_width_px")) for it in bq_items]
    pad_lefts = [num(it.get("padding_left_px")) for it in bq_items]
    quote_colors = [q.get("color") for q in (extras.get("quote_bars") or [])
                    if isinstance(q, dict)]
    if bq_items:
        w = med(bar_widths)
        put("P-QUOTE-01-PARITY", norm(w), {
            "W_qbar/B": norm(w),
            "IND_quote/B": norm(med(pad_lefts)),
            "color/C_quote_bar": next((c for c in quote_colors if parse_color(c)), None),
        })
        liqt = [it for it in bq_items
                if any(tok in item_path(it) for tok in ("li", "ul", "ol"))]
        if liqt:
            lefts = [rect_field(it, "left") for it in liqt]
            if content_left is not None:
                d = med([x - content_left for x in lefts if x is not None])
                put("P-C-LIQT-01-PARITY", norm(d), {"left/B": norm(d)})

    # bug/0169/0167：引用条原始几何与色值进入公共 metrics。
    bq_content_lefts = [num_any(it.get("content_left_px")) for it in bq_items]
    raw("content_left_px", med(bq_content_lefts), "px",
        "dom-probe: blockquotes.items[].content_left_px")
    # bug/0167：C_quote 只认契约指定的 `bar.border_left_color`；
    # ⛔ 不从 extras.quote_bars[].color 静默换源（否则 source 标注会误导）。
    quote_bar_colors = [(it.get("bar") or {}).get("border_left_color")
                        for it in bq_items]
    color_metric("C_quote",
                 next((c for c in quote_bar_colors
                       if parse_color(c) and not color_is_transparent(c)), None),
                 "dom-probe: blockquotes.items[].bar.border_left_color")

    # §2.6 代码块（PAD_code / LH_code）
    code_items = (doc.get("code_blocks") or {}).get("items") or []
    pad_tops = []
    for it in code_items:
        pad = it.get("code_padding") or {}
        pad_tops.append(num(pad.get("top")))
    if code_items:
        v = med(pad_tops)
        # §7.2 M1-INV 把 P-FENCE-01 / P-INDENT-01 / P-C-LICODE-01 的 PAD_code/B 列为不变式。
        put("P-FENCE-01-PARITY", norm(v), {"PAD_code/B": norm(v)})
        put("P-INDENT-01-PARITY", norm(v), {"PAD_code/B": norm(v)})
        li_code = [it for it in code_items if "li" in item_path(it)]
        if li_code:
            vv = med([num((it.get("code_padding") or {}).get("top")) for it in li_code])
            put("P-C-LICODE-01-PARITY", norm(vv), {"PAD_code/B": norm(vv)})

    # bug/0169/0167：代码块背景顶边与底色进入公共 metrics。
    raw("background_top_px",
        med([num_any(it.get("background_top_px")) for it in code_items]),
        "px", "dom-probe: code_blocks.items[].background_top_px")
    color_metric("C_code",
                 next((it.get("background_color") for it in code_items
                       if parse_color(it.get("background_color"))
                       and not color_is_transparent(it.get("background_color"))), None),
                 "dom-probe: code_blocks.items[].background_color")

    # §2.3 标题（H/B、SP_head/B、SP_head_after/B；SPEC 字号比）
    heading_ratios = {1: 2.00, 2: 1.75, 3: 1.45, 4: 1.25, 5: 1.00, 6: 0.85}
    headings = doc.get("headings") or {}
    for lvl in range(1, 7):
        arr = headings.get("h%d" % lvl) or []
        if not arr:
            continue
        fs = med([num(h.get("font_size_px")) for h in arr])
        ink_h = med([num((h.get("ink") or {}).get("height")) for h in arr])
        mt = med([num(h.get("margin_top_px")) for h in arr])
        mb = med([num(h.get("margin_bottom_px")) for h in arr])
        put("P-H-%02d-PARITY" % lvl, norm(fs), {
            "H/B": norm(fs),
            "H_ink/B": norm(ink_h),
            "SP_head/B": norm(mt),
            "SP_head_after/B": norm(mb),
        })
        if body_fs:
            ratio = fs / body_fs
            spec.append({
                "id": "P-H-%02d-SPEC" % lvl,
                "value": round(ratio, 4),
                "expected": heading_ratios[lvl],
                "tolerance": {"type": "absolute", "value": 0.02},
                "detail": "计算字号比 %.4f vs 产品值 %.2f" % (ratio, heading_ratios[lvl]),
            })

    # §2.7 表格（H_table / 列宽占比 / 颜色）
    table_items = (doc.get("tables") or {}).get("items") or []
    head_bgs = [t.get("bg") for t in (extras.get("table_heads") or [])
                if isinstance(t, dict)]
    head_fs = [num(t.get("font_size_px")) for t in (extras.get("table_heads") or [])
               if isinstance(t, dict)]
    cell_pads = []
    for cell in (extras.get("table_cells") or []):
        if not isinstance(cell, dict):
            continue
        p = cell.get("padding") or {}
        vals = [num(p.get(k)) for k in ("top", "right", "bottom", "left")]
        vals = [v for v in vals if v is not None]
        if vals:
            cell_pads.append(sum(vals) / len(vals))

    # bug/0169：H_table 只能用数据行高（表头行是另一行，不可混用）。
    data_heights = []
    data_heights_raw = []
    data_count = 0
    header_heights = []
    header_from = None
    header_cells = []
    ratio_to_first = []
    first_cell_rect = None
    for table in table_items:
        row_h = num_any(table.get("data_row_height_px"))
        if row_h is not None:
            data_heights.append(row_h)
        data_heights_raw.append(table.get("data_row_heights_px"))
        rows = num_any(table.get("data_row_count"))
        if rows is not None:
            data_count += int(rows)
        header_heights.append(num_any(table.get("header_row_height_px")))
        if header_from is None and table.get("header_measured_from"):
            header_from = table.get("header_measured_from")
        for cell in table.get("header_cells") or []:
            if isinstance(cell, dict):
                header_cells.append(cell)
        for column in table.get("columns") or []:
            v = num_any(column.get("ratio_to_first"))
            if v is not None:
                ratio_to_first.append(v)
        if first_cell_rect is None and isinstance(table.get("first_data_cell_rect"), dict):
            first_cell_rect = table.get("first_data_cell_rect")
    flat_heights = [h for group in data_heights_raw if isinstance(group, list)
                    for h in (num_any(x) for x in group) if h is not None]
    header_cell_sizes = [num_any(c.get("font_size_px")) for c in header_cells]
    header_weights = [num_any(c.get("font_weight")) for c in header_cells]
    header_bgs = [c.get("background_color") for c in header_cells
                  if c.get("background_color")]

    if table_items:
        table_widths = [num((t.get("table_rect") or {}).get("width")) for t in table_items]
        table_heights = [num((t.get("table_rect") or {}).get("height")) for t in table_items]
        hh = med(data_heights)
        header_hh = med(header_heights)
        cell_fs = med([v for v in header_cell_sizes if v is not None])
        put("P-TBL-01-PARITY", norm(hh), {
            "H_table/B": norm(hh),
            "H_header/B": norm(header_hh),
            "H/B": norm(med(head_fs) if med(head_fs) is not None else cell_fs),
            "color/C_table_head": next((c for c in
                                        (header_bgs or head_bgs)
                                        if parse_color(c)
                                        and not color_is_transparent(c)), None),
            "PAD_cell/B": norm(med(cell_pads)),
        })
        put("P-TBL-02-PARITY", norm(med(table_widths)),
            {"width/B": norm(med(table_widths))})
        put("P-TBL-03-PARITY", norm(med(table_heights)),
            {"height/B": norm(med(table_heights))})

        ratios = []
        for t in table_items:
            ratios.extend([num(c.get("ratio")) for c in (t.get("columns") or [])
                           if num(c.get("ratio")) is not None])
        if ratios:
            put("P-TBL-05-PARITY", ratios[0], {"ratios": ratios}, unit="ratio")

        in_quote = [t for t in table_items if "blockquote" in item_path(t)]
        if in_quote:
            tr = in_quote[0].get("table_rect") or {}
            left = num(tr.get("left"))
            d = (left - content_left) if (left is not None and content_left is not None) else None
            qratios = []
            for t in in_quote:
                qratios.extend([num(c.get("ratio")) for c in (t.get("columns") or [])
                                if num(c.get("ratio")) is not None])
            put("P-C-TBLINQ-01-PARITY", norm(d), {"left/B": norm(d), "ratios": qratios})

    # bug/0169/0137/0166：表格原始观测量（无表格也写 null＋missing）。
    raw("data_row_height_px", med(data_heights), "px",
        "dom-probe: tables.items[].data_row_height_px")
    raw("data_row_heights_px", flat_heights or None, "px",
        "dom-probe: tables.items[].data_row_heights_px")
    raw("data_row_count", data_count if table_items else None, "count",
        "dom-probe: tables.items[].data_row_count")
    raw("header_row_height_px", med(header_heights), "px",
        "dom-probe: tables.items[].header_row_height_px")
    raw("header_measured_from", header_from, "text",
        "dom-probe: tables.items[].header_measured_from")
    raw("header_cells", header_cells or None, "items",
        "dom-probe: tables.items[].header_cells[]")
    raw("header_font_weight", med(header_weights), "weight",
        "dom-probe: tables.items[].header_cells[].font_weight")
    raw("ratio_to_first", ratio_to_first or None, "ratio",
        "dom-probe: tables.items[].columns[].ratio_to_first")
    raw("first_data_cell_rect", first_cell_rect, "rect",
        "dom-probe: tables.items[].first_data_cell_rect")
    color_metric("C_th",
                 next((c for c in (header_bgs or head_bgs)
                       if parse_color(c) and not color_is_transparent(c)), None),
                 "dom-probe: tables.items[].header_cells[].background_color")
    # bug/0167：链接色的生产者尚缺（inline.links 不含 computed color）⇒ 明确 blocked。
    color_metric("C_link", None,
                 "dom-probe: inline.links（无 color 字段）",
                 reason="no-producer: dom-probe.inline.links 未采集 color")

    # §2.8 任务项 / 复选框（方框宽 / 高 / margin-right）
    task_items = (doc.get("task_items") or {}).get("items") or []
    if task_items:
        widths = [num(t.get("width_px")) for t in task_items]
        heights = [num(t.get("height_px")) for t in task_items]
        margins = [num(t.get("margin_right_px")) for t in task_items]
        w, h = med(widths), med(heights)
        put("P-BOX-01-PARITY", norm(w), {
            "width/B": norm(w), "height/B": norm(h),
            "margin_right/B": norm(med(margins)),
        })
        put("P-TASK-01-PARITY", norm(w), {
            "width/B": norm(w), "height/B": norm(h),
        })
        # bug/0152：嵌套任务按 DOM 深度 list_level >= 2，⛔ 不再数 path 里的 "li" 子串
        # （`li.task-list-item` 自身就含 2 次，12-task 会把 7 项全选进来）。
        levels = [num_any(t.get("list_level")) for t in task_items]
        have_levels = any(v is not None for v in levels)
        raw("task_list_level", levels if have_levels else None, "level",
            "dom-probe: task_items.items[].list_level")
        nested = [t for t in task_items
                  if (num_any(t.get("list_level")) or -1) >= 2]
        if nested:
            ww = med([num(t.get("width_px")) for t in nested])
            lefts = [rect_field(t, "left") for t in nested]
            d = med([x - content_left for x in lefts
                     if x is not None and content_left is not None])
            put("P-C-NESTTASK-01-PARITY", norm(ww), {
                "width/B": norm(ww), "left/B": norm(d),
            })
        elif task_items and all(v is None for v in levels):
            skipped.append({
                "id": "P-C-NESTTASK-01-PARITY",
                "reason": "no-list-level",
                "detail": "task_items.items[] 未提供 list_level；"
                          "⛔ 不回退到 path 子串计数（bug/0152）",
            })

    # §2.11 分隔线（1 px 线宽 / B）
    rule_items = (doc.get("rules") or {}).get("items") or []
    if rule_items:
        line_w = med([num(r.get("border_top_width_px")) or num(r.get("height_px"))
                      for r in rule_items])
        put("P-RULE-01-PARITY", norm(line_w), {"line_width/B": norm(line_w)})
    color_metric("C_rule",
                 next((r.get("border_top_color") for r in rule_items
                       if parse_color(r.get("border_top_color"))
                       and not color_is_transparent(r.get("border_top_color"))), None),
                 "dom-probe: rules.items[].border_top_color")
    raw("rule_border_top_width_px",
        med([num_any(r.get("border_top_width_px")) for r in rule_items]),
        "px", "dom-probe: rules.items[].border_top_width_px")

    # §2.9 图片（bbox / B）
    image_items = (doc.get("images") or {}).get("items") or []
    if image_items:
        w = med([rect_field(i, "width") for i in image_items])
        h = med([rect_field(i, "height") for i in image_items])
        put("P-IMG-01-PARITY", norm(w), {
            "width/B": norm(w), "height/B": norm(h),
        })

    # §2.10 标题里的行内代码（底块高 / B）
    inline = doc.get("inline") or {}
    h_codes = [c for c in (inline.get("code") or [])
               if re.search(r">\s*h[1-6]", item_path(c))]
    if h_codes:
        hh = med([rect_field(c, "height") for c in h_codes])
        put("P-C-HINLINE-01-PARITY", norm(hh), {"H/B": norm(hh)})

    # §2.2 RAG_para：段内各显示行右缘极差 / B（只同端比，U3）
    paragraphs = extras.get("paragraphs")
    if not isinstance(paragraphs, list) or not paragraphs:
        paragraphs = []
        for block in (doc.get("line_boxes") or {}).get("by_block") or []:
            if str(block.get("tag") or "") not in ("p", "li"):
                continue
            lines = block.get("lines") or []
            rights = [num(l.get("right")) for l in lines]
            rights = [r for r in rights if r is not None]
            if len(rights) >= 2:
                paragraphs.append({
                    "rag_px": max(rights) - min(rights),
                    "lines": len(rights),
                    "cjk": False,
                })
    multi = [p for p in paragraphs
             if isinstance(p, dict) and num(p.get("rag_px")) is not None
             and (num(p.get("lines")) or 0) >= 2]
    if multi:
        rag = max(num(p.get("rag_px")) for p in multi)
        put("P-PARA-01-PARITY", norm(rag), {
            "RAG_para/B": norm(rag), "RAG_para_px": rag, "paragraphs": len(multi),
        })
        cjk = [num(p.get("rag_px")) for p in multi if p.get("cjk")]
        if cjk:
            rag_cjk = max(cjk)
            put("P-C-CJK-01-PARITY", norm(rag_cjk), {
                "RAG_para/B": norm(rag_cjk), "RAG_para_px": rag_cjk,
            })

    # ── SPEC：结构类（只在夹具确有该结构时登记，缺结构不是失败）──────────
    structural("P-UL-01-SPEC", "ul" in tags, "存在 ul/li 结构")
    structural("P-OL-01-SPEC", "ol" in tags, "存在 ol/li 结构")
    structural("P-QUOTE-01-SPEC", bool(bq_items), "存在 blockquote")
    structural("P-RULE-01-SPEC", bool(rule_items), "存在 hr")
    structural("P-PARA-01-SPEC",
               any(str(b.get("tag") or "") == "p"
                   for b in (doc.get("line_boxes") or {}).get("by_block") or []),
               "存在 p 结构")
    structural("P-TASK-01-SPEC", bool(task_items), "存在 input[type=checkbox]")
    structural("P-FENCE-01-SPEC", bool(code_items), "存在 pre>code")
    structural("P-TBL-01-SPEC", bool(table_items), "存在 table>thead>tr>th")
    structural("P-IMG-02-SPEC",
               bool(image_items) and all(bool(i.get("complete")) and bool(i.get("src"))
                                         for i in image_items),
               "img[src] 均已加载")

    # bug/0138/0165：像素域派生量直接上浮（缺则 null＋missing）。
    derived_bands = (bands or {}).get("derived") or {}
    for name, unit in (("BAND_px", "px"), ("BAND_over_B", "ratio"),
                       ("W_col_over_B", "ratio"), ("roi_width_px", "px")):
        raw(name, num_any(derived_bands.get(name)), unit,
            "bands.py derived (M1 content-box ROI)")

    return {
        "metrics": metrics,
        "details": details,
        "spec": spec,
        "missing": missing,
        "skipped": skipped,
        "dpr": dpr,
        "b": B,
        "env": {
            "content_width_px": num(env.get("content_box_width_px")),
            "font_size": num(env.get("font_size_px")),
            "line_height": num(env.get("line_height_px")),
            "dpr": dpr,
            "canvas_w": CANVAS_W,
            "canvas_h": CANVAS_H,
        },
    }


# ── 路径、指纹与阶段标记 ───────────────────────────────────────────────

def ref_case_dir(fixture):
    return os.path.join(WORK, fixture)


def mut_root(mid):
    return os.path.join(MUT_ROOT, mid)


def mut_case_dir(mid, fixture):
    return os.path.join(mut_root(mid), fixture)


def neg_root(nid):
    return os.path.join(NEG_ROOT, nid)


def ensure_root(root):
    """给 preflight 的工作根补一份 fixtures.json（current_block_kinds 要用）。

    bug/0156：链接目标必须是**绝对路径**（相对目标会相对链接所在目录解析 ⇒ 悬空）；
    判存在用 `lexists`（悬空链接也算占位），悬空或指错则先删再建；EEXIST 视为幂等。

    bug/0217：此前 `root == WORK` 直接 return，只对默认载荷（`$WORK/fixtures.json`）
    成立；用户显式 `--fixtures-json /别处/x.json` 时 preflight 仍会在 root 下找
    fixtures.json，于是自测工具把「用户换载荷」误报成缺文件。这里只在
    link 路径与载荷本身就是同一路径时跳过，其余一律补齐/刷新链接。
    """
    link = os.path.join(root, "fixtures.json")
    same_as_payload = (os.path.abspath(link)
                       == os.path.abspath(FIXTURES_JSON))
    if DRY:
        if not same_as_payload:
            plan_cmd(["ln", "-sf", FIXTURES_JSON, link])
        return
    os.makedirs(root, exist_ok=True)
    if same_as_payload:
        return
    target = os.path.realpath(FIXTURES_JSON)
    if not os.path.isfile(target):
        raise CaseError("bootstrap", "fixtures.json 不存在：%s" % FIXTURES_JSON,
                        [FIXTURES_JSON])
    if os.path.islink(link):
        if os.path.realpath(link) == target:
            return
        os.unlink(link)
    elif os.path.lexists(link):
        # 普通文件：内容相同就复用；内容不同不擅自覆盖（记内部错误而不是 traceback）。
        if sha_file(link) == sha_file(target):
            return
        raise CaseError("bootstrap", "工作根已有同名 fixtures.json 且内容不同：%s" % link,
                        [link])
    try:
        os.symlink(target, link)
    except FileExistsError:
        if os.path.islink(link) and os.path.realpath(link) == target:
            return
        raise CaseError("bootstrap", "fixtures.json 链接冲突：%s" % link, [link])


def case_fingerprint(fixture, mut_id=None):
    mut = MUT_BY_ID.get(mut_id) if mut_id else None
    # bug/0209：页面实际注入的 __l2-extras.js/__l2-eval.js 来自本文件内的字符串常量；
    # 只比外部脚本 sha 会让「改量具再验证量具」静默命中旧产物。
    # 常量在函数定义之后才赋值，用 globals().get 取，缺省按空串参与。
    injected_js = ((globals().get("EXTRAS_JS") or "")
                   + "\0" + (globals().get("EVAL_JS") or ""))
    here = globals().get("HERE")
    runner_sha = sha_file(os.path.join(here, "l2-run.sh")) if here else None
    parts = {
        "fixtures_json": sha_file(FIXTURES_JSON),
        "build": sha_file(BUILD),
        "probe": sha_file(PROBE),
        "snapshot_src": sha_file(SNAP_SWIFT),
        "bands": sha_file(BANDS),
        "preflight": sha_file(PREFLIGHT),
        "check": sha_file(CHECK),
        "mutations": sha_file(MUT_PY),
        # bug/0209：运行器自身 + 注入源码都必须让 stage 失效。
        "l2run": runner_sha,
        "injected_js": hashlib.sha256(
            injected_js.encode("utf-8")).hexdigest(),
        # bug/0199：build-l2-page.sh 整棵拷贝产品 src；只比脚本 sha 会漏样式/脚本改动。
        "product_src": product_src_fingerprint(),
        # bug/0266：基线/期望变化必须让旧测量失效，⛔ 不能把复用当本轮实测。
        "baseline": sha_file(BASELINE),
        "expect": sha_file(EXPECT),
        "fixture": fixture,
        "fixture_sha": sha_file(os.path.join(FIXTURES_DIR, fixture + ".md")),
        "sidebar": SIDEBAR,
        "dpr": DPR,
        "dpr_mode": "explicit" if DPR_EXPLICIT else "auto",
        "l2run_logic": L2RUN_LOGIC_VERSION,
        "canvas": [CANVAS_W, CANVAS_H],
        "mutation_css": (mut or {}).get("css"),
    }
    blob = json.dumps(parts, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def stage_path(case_dir, name):
    return os.path.join(case_dir, "stages", name + ".json")


def verified_backup_bands(case_dir):
    """bug/0208：只认「本轮 bands stage 标记登记过 sha」的备份度量。

    `bands-backup.json` 是可选产物（取像没交付独立备份帧时不存在）。旧实现
    直接 `load_json`，残留文件会被当成当前轮的备份读数；这里要求 stage 标记里
    的 `backup_bands_sha` 与磁盘一致，否则视为不存在。
    """
    path = os.path.join(case_dir, "bands-backup.json")
    marker = load_json(stage_path(case_dir, "bands"))
    expected = marker.get("backup_bands_sha") if isinstance(marker, dict) else None
    if expected and os.path.isfile(path) and sha_file(path) == expected:
        return load_json(path)
    return None


STAGE_INFO = {}


def note_stage(case_dir, name, cached, at=None, **extra):
    """bug/0266：记录每个阶段是复用还是本轮实测，供聚合/摘要区分。"""
    entry = {"cached": bool(cached), "at": at or now_iso()}
    entry.update(extra)
    STAGE_INFO.setdefault(os.path.abspath(case_dir), {})[name] = entry


def stages_for(case_dir):
    return STAGE_INFO.get(os.path.abspath(case_dir)) or {}


def stage_ok(case_dir, name, fingerprint, artifacts=None):
    """阶段缓存命中判定。

    bug/0177：除指纹外还校验产物 sha（`<key>_sha`）；手改/残留的旧 result 不能
    冒充本轮产物。`artifacts` 形如 {"result": path, ...}，对应 mark_stage 的
    extra `result_sha`。

    bug/0213：dry-run 必须给出**与缓存状态无关**的完整计划。缓存命中的
    分支会在日志里少打取像/度量步骤，`--dry-run` 的输出随工作目录里的
    旧 stage 文件漂移。DRY 下直接判不命中，让各 stage 走完整分支。
    """
    if DRY:
        return False
    data = load_json(stage_path(case_dir, name))
    if not (isinstance(data, dict) and data.get("ok") is True
            and data.get("fingerprint") == fingerprint):
        return False
    for key, path in (artifacts or {}).items():
        if not path or not os.path.isfile(path):
            return False
        expected = data.get(key + "_sha")
        if not expected or sha_file(path) != expected:
            return False
    note_stage(case_dir, name, True, at=data.get("at"))
    return True


def mark_stage(case_dir, name, fingerprint, extra=None):
    if DRY:
        return
    data = {"ok": True, "fingerprint": fingerprint, "at": now_iso()}
    if extra:
        data.update(extra)
    write_json(stage_path(case_dir, name), data)
    note_stage(case_dir, name, False, at=data["at"])


CASE_ARTIFACTS = [
    "page", "frame.png", "frame-backup.png", "dom.json", "snapshot.json",
    "roi.json", "bands.json", "bands-backup.json", "pixels.json",
    "measured.json", "result.json", "verdict.json", "gates.json",
    "gates.filtered.json", "compare.json", "build.log", "snapshot.log",
    "bands.log", "bands-backup.log", "check.log", "stages", "meta.json",
]


def clean_case(case_dir):
    if DRY:
        plan_cmd(["rm", "-rf"] + [os.path.join(case_dir, x) for x in CASE_ARTIFACTS[:4]])
        return
    for name in CASE_ARTIFACTS:
        path = os.path.join(case_dir, name)
        if os.path.isdir(path):
            shutil.rmtree(path)
        elif os.path.exists(path):
            os.remove(path)


def fmt_num(value):
    return ("%g" % value)


# ── 页面注入（HITS==1 守卫）─────────────────────────────────────────────

EXTRAS_JS = r"""// l2-run 注入：只读 DOM 补充量（颜色 / 格 padding / 段落折行）。
// 口径仍以 design/0063 §2.2 为准；本文件只提供 dom-probe.js 未覆盖的叶子量。
(function () {
  'use strict';
  var CJK = /[㐀-鿿豈-﫿]/;

  function cs(el, prop) {
    try { return window.getComputedStyle(el).getPropertyValue(prop); } catch (e) { return null; }
  }
  function px(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }
  function pathOf(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      var tag = node.tagName.toLowerCase();
      var idx = 1;
      var sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === node.tagName) idx += 1;
      }
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      node = node.parentElement;
    }
    return '.doc > ' + parts.join(' > ');
  }
  function ragOf(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var rects = [];
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (!node || !node.nodeValue || !node.nodeValue.trim()) continue;
      var range = document.createRange();
      range.selectNodeContents(node);
      var list = range.getClientRects();
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].width > 0) rects.push({ top: list[i].top, right: list[i].right });
      }
    }
    rects.sort(function (a, b) { return a.top - b.top; });
    var merged = [];
    for (var j = 0; j < rects.length; j += 1) {
      var last = merged[merged.length - 1];
      if (last && Math.abs(rects[j].top - last.top) <= 0.5) {
        if (rects[j].right > last.right) last.right = rects[j].right;
      } else {
        merged.push({ top: rects[j].top, right: rects[j].right });
      }
    }
    if (merged.length < 2) return { lines: merged.length, rag_px: 0 };
    var rights = merged.map(function (x) { return x.right; });
    return {
      lines: merged.length,
      rag_px: Math.max.apply(null, rights) - Math.min.apply(null, rights)
    };
  }

  window.__PARITY_L2_EXTRAS = function () {
    var out = {
      schema: 'rmd-parity-l2-extras/1',
      sidebar_width_px: null,
      quote_bars: [],
      table_heads: [],
      table_cells: [],
      paragraphs: [],
      doc_found: false,
      parity_boot: window.__PARITY_BOOT || null,
      errors: window.__ERR || []
    };
    try {
      if (window.__FAKE && window.__FAKE.snapshot) {
        out.sidebar_width_px = window.__FAKE.snapshot.sidebar_width;
      }
    } catch (e) { /* 假后端缺席不是本探针的错，留给 P-ENV 判 */ }

    var doc = document.querySelector('.doc');
    if (!doc) return out;
    out.doc_found = true;

    var bqs = doc.querySelectorAll('blockquote');
    for (var b = 0; b < bqs.length; b += 1) {
      var bq = bqs[b];
      out.quote_bars.push({
        index: b,
        path: pathOf(bq),
        color: cs(bq, 'border-left-color'),
        width_px: px(cs(bq, 'border-left-width')),
        left_px: bq.getBoundingClientRect().left
      });
    }

    var tables = doc.querySelectorAll('table');
    for (var t = 0; t < tables.length; t += 1) {
      var table = tables[t];
      var th = table.querySelector('thead th') || table.querySelector('th');
      out.table_heads.push({
        index: t,
        path: pathOf(table),
        bg: th ? cs(th, 'background-color') : null,
        color: th ? cs(th, 'color') : null,
        font_size_px: th ? px(cs(th, 'font-size')) : null,
        height_px: th ? px(cs(th, 'height')) : null
      });
      var td = table.querySelector('tbody td') || table.querySelector('td');
      if (td) {
        out.table_cells.push({
          index: t,
          padding: {
            top: px(cs(td, 'padding-top')),
            right: px(cs(td, 'padding-right')),
            bottom: px(cs(td, 'padding-bottom')),
            left: px(cs(td, 'padding-left'))
          }
        });
      }
    }

    var ps = doc.querySelectorAll('p');
    for (var p = 0; p < ps.length; p += 1) {
      var el = ps[p];
      var text = String(el.textContent || '');
      var rag = ragOf(el);
      out.paragraphs.push({
        index: p,
        path: pathOf(el),
        cjk: CJK.test(text),
        lines: rag.lines,
        rag_px: rag.rag_px
      });
    }
    return out;
  };
})();
"""

EVAL_JS = (
    "JSON.stringify({dom: window.__PARITY_DOM.collect(),"
    " extras: window.__PARITY_L2_EXTRAS()});\n"
)


MUTATION_STYLE_ID = "__l2-mutation"


def _head_span(src):
    """返回 `<head>` 内容区间 [start,end)。⛔ 不把正文里的同名文本当 head。"""
    match = re.search(r"<head\b[^>]*>", src, re.I)
    if not match:
        raise CaseError("build", "index.html 找不到 <head>，无法确定变异注入位")
    end = src.lower().find("</head>", match.end())
    if end < 0:
        raise CaseError("build", "index.html 找不到 </head>，无法确定变异注入位")
    return match.end(), end


def _mutation_style_count_in_head(src):
    start, end = _head_span(src)
    pattern = r"<style\b[^>]*\bid\s*=\s*[\"']%s[\"']" % re.escape(MUTATION_STYLE_ID)
    return len(re.findall(pattern, src[start:end], re.I))


def _normalize_css(text):
    return re.sub(r"\s+", "", text or "")


def _page_text_files(page_dir, limit=400):
    """列出页面副本里可能承载样式/脚本消费点的文本文件。"""
    out = []
    for base, _dirs, files in os.walk(page_dir):
        for name in files:
            if name.endswith((".css", ".html", ".js")):
                path = os.path.join(base, name)
                out.append(path)
                if len(out) >= limit:
                    return out
    return out


def _mutation_selector(mutation_css):
    """取变异 CSS 里第一条规则的 selector（去掉注释与 @ 规则）。"""
    text = re.sub(r"/\*.*?\*/", "", mutation_css or "", flags=re.S)
    match = re.search(r"([^{}@]+)\{", text)
    return (match.group(1).strip() if match else "")


def mutation_consumption_gaps(page_dir, mutation):
    """bug/0202：校验变异的每条声明在页面里**真有消费点**。

    `decls` 之前只用于文档与自检，注入后 HITS==1 只证明 style 节点落进 head，
    不证明变量被页面读取；产品改名/删除变量后变异会静默失效（假绿）。这里按
    声明类型检查：自定义属性要求出现 `var(--x)`；普通属性要求规则的 selector
    在页面样式里存在（如 M6 的 `.doc h2` font-size）。
    """
    decls = mutation.get("decls") or []
    if not decls:
        return []
    texts = []
    for path in _page_text_files(page_dir):
        try:
            texts.append(open(path, encoding="utf-8", errors="replace").read())
        except OSError:
            continue
    blob = "\n".join(texts)
    selector = _mutation_selector(mutation.get("css") or "")
    gaps = []
    for item in decls:
        try:
            name = item[0]
        except (TypeError, IndexError):
            gaps.append((str(item), "decls 项格式不可识别"))
            continue
        if str(name).startswith("--"):
            if ("var(%s)" % name) not in blob and ("var(%s," % name) not in blob:
                gaps.append((name, "页面样式/脚本里没有 var(%s) 消费点" % name))
        elif selector:
            if selector not in blob:
                gaps.append((name, "页面样式里找不到 selector %r" % selector))
        else:
            gaps.append((name, "无法从变异 CSS 解析 selector"))
    return gaps


def inject_page(page_dir, mutation_css, mutation=None):
    index = os.path.join(page_dir, "index.html")
    try:
        src = open(index, encoding="utf-8").read()
    except OSError as exc:
        raise CaseError("build", "读不出 index.html：%s" % exc, [index])

    if "__dom-probe.js" not in src:
        needle = '  <script src="__parity-boot.js"></script>\n'
        hits = src.count(needle)
        if hits != 1:
            raise CaseError(
                "build",
                "HITS=%d（期望 1）：%r" % (hits, needle),
                [index],
            )
        probe_tags = (
            '  <script src="__dom-probe.js"></script>\n'
            '  <script src="__l2-extras.js"></script>\n'
        )
        src = src.replace(needle, probe_tags + needle)

    if mutation_css:
        # bug/0281：只认 <head> 里的结构化注入点，⛔ 不扫整份 HTML 的字符串；
        # 正文出现 "__l2-mutation" 不得让注入被静默跳过。
        count = _mutation_style_count_in_head(src)
        if count > 1:
            raise CaseError("build",
                            "head 里已有 %d 个 #%s style（期望 ≤1）"
                            % (count, MUTATION_STYLE_ID), [index])
        if count == 0:
            end = _head_span(src)[1]
            style = ('  <style id="%s">\n' % MUTATION_STYLE_ID
                     + mutation_css
                     + '  </style>\n')
            src = src[:end] + style + src[end:]

    try:
        with open(index, "w", encoding="utf-8") as f:
            f.write(src)
    except OSError as exc:
        raise CaseError("build", "写不出 index.html：%s" % exc, [index])

    if mutation_css:
        # 注入后回读校验：head 里恰好一个结构节点，且声明确实落进该节点。
        try:
            written = open(index, encoding="utf-8").read()
        except OSError as exc:
            raise CaseError("build", "注入后读不回 index.html：%s" % exc, [index])
        if _mutation_style_count_in_head(written) != 1:
            raise CaseError("build",
                            "注入后 head 里没有唯一的 #%s style" % MUTATION_STYLE_ID,
                            [index])
        start, end = _head_span(written)
        if _normalize_css(mutation_css) not in _normalize_css(written[start:end]):
            raise CaseError("build", "注入后回读：变异 CSS 未落进 head", [index])

    if mutation_css and mutation:
        # bug/0202：注入成功 ≠ 变异生效。页面没有消费点时明确失败，
        # ⛔ 不允许「变异页全绿」被解读为「判据不敏感」或反过来的假绿。
        gaps = mutation_consumption_gaps(page_dir, mutation)
        if gaps:
            raise CaseError(
                "build",
                "变异 %s 的声明在页面里没有消费点：%s"
                % (mutation.get("id") or "?",
                   "; ".join("%s（%s）" % (n, why) for n, why in gaps)),
                [index],
            )


def stage_build(case_dir, fixture, mut_id=None, payload_path=None):
    fingerprint = case_fingerprint(fixture, mut_id)
    # N5 用「变异后的 Stage A 载荷副本」构页（bug/0155）；把载荷 sha 并进指纹，
    # 防止同目录里复用按原载荷构建的旧 page。
    if payload_path:
        fingerprint += ":payload-" + (sha_file(payload_path) or "missing")
    page_dir = os.path.join(case_dir, "page")
    page_index = os.path.join(page_dir, "index.html")
    if (not FORCE and stage_ok(case_dir, "build", fingerprint,
                               {"page": page_index})
            and os.path.isfile(page_index)):
        return fingerprint, page_dir

    mutation_obj = (MUT_BY_ID.get(mut_id) or {}) if mut_id else None
    mutation_css = (mutation_obj or {}).get("css")
    payload = payload_path or FIXTURES_JSON
    cmd = [
        BUILD, fixture, page_dir,
        "--fixtures-json", payload,
        "--sidebar-width", fmt_num(SIDEBAR),
    ]
    if DRY:
        log("[dry-run]   # 构页 + 注入（HITS==1）")
        plan_cmd(["rm", "-rf", page_dir])
        plan_cmd(cmd)
        plan_cmd(["cp", PROBE, os.path.join(page_dir, "__dom-probe.js")])
        log("[dry-run]   write %s  (%d bytes)" % (os.path.join(page_dir, "__l2-extras.js"),
                                                  len(EXTRAS_JS)))
        log("[dry-run]   write %s" % os.path.join(page_dir, "__l2-eval.js"))
        log("[dry-run]   patch %s  (probe + extras; mutation=%s)"
            % (os.path.join(page_dir, "index.html"), mut_id or "none"))
        return fingerprint, page_dir

    if os.path.isdir(page_dir):
        shutil.rmtree(page_dir)
    os.makedirs(case_dir, exist_ok=True)

    log("▶ 构页：%s × %s" % (fixture, mut_id or "reference"))
    rc, _ = run_cmd(cmd, os.path.join(case_dir, "build.log"))
    if rc != 0:
        raise CaseError("build", "build-l2-page.sh 退出 %d" % rc,
                        [page_dir, os.path.join(case_dir, "build.log")],
                        cmd=cmd, rc=rc, log_path=os.path.join(case_dir, "build.log"))

    shutil.copyfile(PROBE, os.path.join(page_dir, "__dom-probe.js"))
    with open(os.path.join(page_dir, "__l2-extras.js"), "w", encoding="utf-8") as f:
        f.write(EXTRAS_JS)
    with open(os.path.join(page_dir, "__l2-eval.js"), "w", encoding="utf-8") as f:
        f.write(EVAL_JS)
    inject_page(page_dir, mutation_css, mutation_obj)
    mark_stage(case_dir, "build", fingerprint,
               {"page": page_dir, "mutation": mut_id,
                "page_sha": sha_file(page_index)})
    return fingerprint, page_dir


# ── 取像 ────────────────────────────────────────────────────────────────

# dom-probe / l2-snapshot 自证里可能与 env 并列出现在顶层的键（A 组契约）。
RUNTIME_ENV_ALIASES = (
    "window_visible", "alpha", "appkit_is_visible", "is_active", "is_key_window",
    "dpr", "px_per_pt", "screen_backing_scale", "expected_dpr",
    "page_layout", "page_provenance", "page_state_available",
    "ready", "ready_error", "fonts_ready", "stable_frames",
    "content_width_px", "font_size", "line_height", "content_box_height_px",
    "sidebar_width", "canvas_pt", "png_size", "png_px",
)


def runtime_env_of(dom):
    """从 dom.json 取运行期 env（含 `env` 子对象与顶层别名）。

    A 组在 `--eval-file` 模式下把 env 键同时提升到顶层；两层都读，避免
    工具版本差异造成「有值却读不到」。
    """
    env = {}
    if isinstance(dom.get("env"), dict):
        env.update(dom["env"])
    for key in RUNTIME_ENV_ALIASES:
        if key not in env and key in dom:
            env[key] = dom[key]
    return env


def stage_snapshot(case_dir, fixture, mut_id=None):
    fingerprint = case_fingerprint(fixture, mut_id)
    frame = os.path.join(case_dir, "frame.png")
    dom_json = os.path.join(case_dir, "dom.json")
    snap_json = os.path.join(case_dir, "snapshot.json")
    if (not FORCE and stage_ok(case_dir, "snapshot", fingerprint,
                               {"frame": frame, "dom": dom_json, "snap": snap_json})
            and os.path.isfile(frame) and os.path.isfile(dom_json)
            and os.path.isfile(snap_json)):
        return load_json(snap_json, required=True)

    page_dir = os.path.join(case_dir, "page")
    eval_file = os.path.join(page_dir, "__l2-eval.js")
    cmd = [
        SNAP_BIN,
        "--page", page_dir,
        "--out", frame,
        "--width", fmt_num(CANVAS_W),
        "--height", fmt_num(CANVAS_H),
        "--eval-file", eval_file,
        "--json", dom_json,
        "--timeout", str(TIMEOUT),
    ]
    # bug/0125：`--dpr` 是**期望值**，与实测 px/pt 不符即 exit 64。
    # 只有用户显式给 --dpr 时才传；缺省取工具实测，1× 外接屏不再被默认 2.0 判死。
    if DPR_EXPLICIT:
        cmd[9:9] = ["--dpr", fmt_num(DPR)]
    if DRY:
        log("[dry-run]   # 离屏取像 + L2-DOM 采集（DPR %s）"
            % ("显式 %s" % fmt_num(DPR) if DPR_EXPLICIT else "实测屏幕 scale"))
        plan_cmd(cmd)
        return None

    log("  取像：%s" % fixture)
    rc, stdout = run_cmd(cmd, os.path.join(case_dir, "snapshot.log"), capture=True)
    artifacts = [frame, dom_json, os.path.join(case_dir, "snapshot.log")]
    if rc != 0:
        raise CaseError("snapshot", "l2-snapshot 退出 %d（页面未就绪/取像失败）" % rc,
                        artifacts, cmd=cmd, rc=rc,
                        log_path=os.path.join(case_dir, "snapshot.log"))
    parsed = parse_stdout_lines(stdout)
    if not parsed.get("snap") or not parsed["snap"].get("path"):
        raise CaseError("snapshot", "主/备两路都没有交付 PNG：primary=%s backup=%s"
                        % (parsed.get("primary"), parsed.get("backup")), artifacts,
                        cmd=cmd, rc=rc,
                        log_path=os.path.join(case_dir, "snapshot.log"))

    dom = load_json(dom_json, required=True)
    if not isinstance(dom, dict) or "dom" not in dom:
        raise CaseError("snapshot", "dom.json 不是 {dom, extras} 结构", [dom_json],
                        cmd=cmd, rc=rc,
                        log_path=os.path.join(case_dir, "snapshot.log"))

    self_info = parsed.get("self") or {}
    runtime_env = runtime_env_of(dom)
    dpr_line = parsed.get("dpr") or {}
    observed_dpr = (num_any(dpr_line.get("px_per_pt"))
                    or num_any(runtime_env.get("dpr"))
                    or num_any(runtime_env.get("px_per_pt")))
    screen_scale = num_any(runtime_env.get("screen_backing_scale"))
    visibility = {
        "window_visible": as_bool(runtime_env.get("window_visible")),
        "alpha": num_any(runtime_env.get("alpha")),
        "appkit_is_visible": as_bool(runtime_env.get("appkit_is_visible")),
    }
    has_runtime_visibility = (visibility["window_visible"] is not None
                              or visibility["alpha"] is not None)

    layout = runtime_env.get("page_layout")
    layout = layout if isinstance(layout, dict) else None
    provenance = runtime_env.get("page_provenance")
    provenance = provenance if isinstance(provenance, dict) else None
    attestation_fields = {
        "content_width_px": num_any(runtime_env.get("content_width_px")),
        "font_size": num_any(runtime_env.get("font_size")),
        "line_height": num_any(runtime_env.get("line_height")),
        "sidebar_width": num_any(runtime_env.get("sidebar_width")),
        "content_box_height_px": num_any(runtime_env.get("content_box_height_px")),
    }
    if layout:
        for key, src in (("content_width_px", "content_box_width"),
                         ("font_size", "font_size"),
                         ("line_height", "line_height"),
                         ("content_box_height_px", "content_box_height")):
            if attestation_fields.get(key) is None:
                attestation_fields[key] = num_any(layout.get(src))
    if provenance and attestation_fields.get("sidebar_width") is None:
        attestation_fields["sidebar_width"] = num_any(provenance.get("sidebar_width"))
    missing_attestation = [k for k, v in attestation_fields.items() if v is None]
    page_attestation = {
        "status": "ok" if layout else "skipped",
        "reason": None if layout else (
            "no-page-attestation" if runtime_env else "no-runtime-env"),
        "page_state_available": as_bool(runtime_env.get("page_state_available")),
        "layout": layout,
        "provenance": provenance,
        "fields": attestation_fields,
        "missing_fields": missing_attestation,
        "source": "l2-snapshot --eval-file env.page_layout/page_provenance",
    }

    # bug/0265（R1 N2）：帧 provenance 已由 l2-snapshot 写进 env/扁平字段，
    # 这里提升到 snapshot.json 顶层；⛔ 只放 env.* 等于让按票面读顶层的消费者拿 None。
    stdout_prov = parsed.get("provenance") or {}
    env_prov = runtime_env.get("provenance") if isinstance(
        runtime_env.get("provenance"), dict) else {}
    delivered_png = ((parsed.get("snap") or {}).get("path") or frame)

    def _prov_value(key):
        for source in (runtime_env, env_prov, stdout_prov):
            value = (source or {}).get(key)
            if value not in (None, "", "-"):
                return value, ("env" if source is runtime_env
                               else "env.provenance" if source is env_prov
                               else "stdout.PROVENANCE")
        return None, "unavailable"

    window_id, window_id_source = _prov_value("window_id")
    if isinstance(window_id, str):
        try:
            window_id = int(window_id)
        except ValueError:
            window_id = None
            window_id_source = "invalid"
    frame_sha256, frame_sha_source = _prov_value("frame_sha256")
    if frame_sha256 is None:
        frame_sha256 = sha_file(delivered_png)
        frame_sha_source = "computed:sha256(delivered_png)" if frame_sha256 else "unavailable"
    captured_at, captured_at_source = _prov_value("captured_at")
    if captured_at is None:
        captured_at = now_iso()
        captured_at_source = "orchestrator:now"

    # bug/0181：取像侧已在 SELF 与 `--json` 顶层给出 bundle 与读取状态；
    # 旧实现只搬 frontmost 名字，`preflight` 的 `frontmost_*_bundle/_ok` 永远拿不到，
    # 「读不到前台」与「读到了同名应用」无法区分。这里原样提升，⛔ 不补默认值。
    fm_nested = dom.get("frontmost") if isinstance(dom.get("frontmost"), dict) else {}

    def _fm_value(flat_key, phase, nested_key):
        value = dom.get(flat_key)
        if value is None:
            value = (fm_nested.get(phase) or {}).get(nested_key)
        return value

    frontmost_provenance = {}
    for _phase in ("before", "after"):
        for _field, _nested in (("bundle", "bundle_id"), ("ok", "read_ok"),
                                ("error", "error")):
            frontmost_provenance["frontmost_%s_%s" % (_phase, _field)] = _fm_value(
                "frontmost_%s_%s" % (_phase, _field), _phase, _nested)

    snap = {
        "tool": "l2-snapshot",
        "generated_at": now_iso(),
        "stdout": stdout,
        "page": page_dir,
        "page_ready": parsed.get("ready"),
        "primary": parsed.get("primary"),
        "backup": parsed.get("backup"),
        "snap": parsed.get("snap"),
        "snap_source": parsed.get("snap_source"),
        "dpr": parsed.get("dpr"),
        "dpr_observed": observed_dpr,
        "dpr_expected": DPR if DPR_EXPLICIT else None,
        "dpr_mode": "explicit" if DPR_EXPLICIT else "auto",
        "screen_backing_scale": screen_scale,
        "frontmost_before": self_info.get("frontmost_before"),
        "frontmost_after": self_info.get("frontmost_after"),
        "frontmost_changed": self_info.get("frontmost_changed"),
        **frontmost_provenance,
        "is_active": (as_bool(runtime_env.get("is_active"))
                      if as_bool(runtime_env.get("is_active")) is not None
                      else as_bool(self_info.get("is_active"))),
        "is_key_window": (as_bool(runtime_env.get("is_key_window"))
                          if as_bool(runtime_env.get("is_key_window")) is not None
                          else as_bool(self_info.get("is_key_window"))),
        "window_id": window_id,
        "window_id_source": window_id_source,
        "frame_sha256": frame_sha256,
        "frame_sha256_source": frame_sha_source,
        "captured_at": captured_at,
        "captured_at_source": captured_at_source,
        "provenance": {
            "frame_sha256": frame_sha256,
            "captured_at": captured_at,
            "window_id": window_id,
            "complete": bool(frame_sha256) and window_id is not None,
            "source": "snapshot.json 顶层（bug/0265；来自 l2-snapshot PROVENANCE/env）",
        },
        "env": runtime_env,
        "visibility": {
            "status": "runtime" if has_runtime_visibility else "invalid",
            "reason": None if has_runtime_visibility else "no-runtime-visibility",
            "source": "runtime:l2-snapshot --json env",
            **visibility,
        },
        "page_attestation": page_attestation,
    }
    # bug/0126：⛔ 不再从源码字符串静态伪造「窗口不可见」。
    # 运行期字段读得到就原样写回；读不到就显式 invalid，让 gate_04 走 skipped，
    # 而不是拿一个自造的 False 让闸门「有结论」。
    if has_runtime_visibility:
        snap["window_visible"] = visibility["window_visible"]
        snap["alpha"] = visibility["alpha"]
        snap["appkit_is_visible"] = visibility["appkit_is_visible"]
        snap["alpha_source"] = "runtime:l2-snapshot --json env"
    else:
        snap["alpha_source"] = "runtime:unavailable"
        snap["invalid"] = [{
            "id": "P-ENV-04",
            "reason": "no-runtime-visibility",
            "detail": "l2-snapshot 的 dom.json/env 未给出 window_visible/alpha；"
                      "⛔ 不用源码静态自证代替运行期值（bug/0126）",
        }]
    write_json(snap_json, snap)
    dpr_log = os.path.join(case_dir, "dpr.log")
    with open(dpr_log, "w", encoding="utf-8") as f:
        f.write("mode=%s\texpected=%s\tobserved=%s\tscreen_backing_scale=%s\n"
                % ("explicit" if DPR_EXPLICIT else "auto",
                   fmt_num(DPR) if DPR_EXPLICIT else "-",
                   fmt_num(observed_dpr) if observed_dpr is not None else "-",
                   fmt_num(screen_scale) if screen_scale is not None else "-"))
    mark_stage(case_dir, "snapshot", fingerprint,
               {"frame": frame, "dom": dom_json, "dpr_log": dpr_log,
                "frame_sha": sha_file(frame), "dom_sha": sha_file(dom_json),
                "snap_sha": sha_file(snap_json)})
    return snap


# ── ROI 与行带 ──────────────────────────────────────────────────────────

def stage_bands(case_dir, fixture, mut_id=None):
    fingerprint = case_fingerprint(fixture, mut_id)
    roi_path = os.path.join(case_dir, "roi.json")
    bands_path = os.path.join(case_dir, "bands.json")
    backup_bands_path = os.path.join(case_dir, "bands-backup.json")
    frame = os.path.join(case_dir, "frame.png")
    if (not FORCE and stage_ok(case_dir, "bands", fingerprint,
                               {"roi": roi_path, "bands": bands_path})
            and os.path.isfile(roi_path) and os.path.isfile(bands_path)):
        # bug/0208：缓存命中时 `bands-backup.json` 可能是更早一轮留下的；
        # 只有 stage 标记里登记过它的 sha 且文件仍与之一致才允许复用，
        # 否则删掉残留并记 backup=None（⛔ 不让旧备份冒充本轮测量）。
        backup = verified_backup_bands(case_dir)
        if backup is None and os.path.exists(backup_bands_path):
            os.remove(backup_bands_path)
        return {
            "roi": load_json(roi_path),
            "primary": load_json(bands_path),
            "backup": backup,
            "frame": frame,
            "backup_png": None,
        }

    dom = load_json(os.path.join(case_dir, "dom.json"), required=True)
    snap = load_json(os.path.join(case_dir, "snapshot.json")) or {}
    dom_doc = (dom.get("dom") or {}).get("doc") or {}
    env = dom_doc.get("env") or {}
    viewport = (dom.get("dom") or {}).get("viewport") or {}
    # bug/0125：实测 DPR 只能来自 DOM 或取像自证；⛔ 缺了就报错，不拿默认 2.0 冒充。
    dpr = num(viewport.get("device_pixel_ratio")) or num(snap.get("dpr_observed"))
    if dpr is None:
        raise CaseError("bands",
                        "DOM viewport 与 snapshot 都没有实测 device_pixel_ratio；"
                        "⛔ 不用默认 DPR 计算 ROI（bug/0125/0165）",
                        [os.path.join(case_dir, "dom.json"),
                         os.path.join(case_dir, "snapshot.json")])
    left_css = num(env.get("content_box_left_px"))
    right_css = num(env.get("content_box_right_px"))
    if left_css is None or right_css is None:
        raise CaseError("bands", "DOM 未给出 .doc content box 左/右缘（§2.8 U8）",
                        [os.path.join(case_dir, "dom.json")])
    top_css = num(env.get("content_box_top_px"))
    content_bottom_css = num(env.get("content_box_bottom_px"))
    roi_warnings = []
    if top_css is None or content_bottom_css is None:
        # bug/0165：拿不到纵向 content box 就退回视口，但必须留下回落原因；
        # ⛔ 不再把「视口高」冒充 content box 底缘而不吭声。
        bottom_css = num(viewport.get("inner_height_px")) or CANVAS_H
        top_dev, bottom_dev = 0.0, bottom_css * dpr
        roi_source = "viewport"
        roi_source_detail = ("viewport：DOM 缺 content_box_top_px/content_box_bottom_px"
                             "（bug/0165 回落，结果 JSON 带告警）")
        roi_warnings.append("roi-fallback:viewport（缺 content_box_top_px/"
                            "content_box_bottom_px，ROI 含页边，带数可能多 2）")
    else:
        top_dev = float(round(top_css * dpr))
        bottom_dev = float(round(content_bottom_css * dpr))
        roi_source = "content_box"
        roi_source_detail = "L2-DOM: .doc content box 四缘 × DPR（bug/0165）"
        if bottom_dev <= top_dev:
            roi_warnings.append(
                "roi-degenerate: content_box 纵向高 ≤ 0（top=%s bottom=%s device px）"
                % (fmt_num(top_dev), fmt_num(bottom_dev)))
    roi = {
        "content_box": {
            "left": left_css * dpr,
            "right": right_css * dpr,
            "top": top_dev,
            "bottom": bottom_dev,
        },
        "content_box_css": {
            "left": left_css,
            "right": right_css,
            "top": top_css,
            "bottom": content_bottom_css,
        },
        "source": roi_source,
        "source_detail": roi_source_detail,
        "unit": "device_px",
        "dpr": dpr,
        "warnings": roi_warnings,
    }
    if DRY:
        log("[dry-run]   # ROI = .doc content box × DPR")
        log("[dry-run]   write %s  %s" % (roi_path, json.dumps(roi["content_box"], ensure_ascii=False)))
        plan_cmd([sys.executable, "-I", BANDS,
                  "--png", frame, "--roi", roi_path, "--json", bands_path])
        plan_cmd([sys.executable, "-I", BANDS,
                  "--png", os.path.join(case_dir, "frame-backup.png"),
                  "--roi", roi_path, "--json", backup_bands_path])
        return {"roi": roi, "primary": None, "backup": None, "frame": frame,
                "backup_png": None}

    write_json(roi_path, roi)
    log("  度量：%s" % fixture)
    rc, _ = run_cmd([sys.executable, "-I", BANDS,
                     "--png", frame, "--roi", roi_path, "--json", bands_path],
                    os.path.join(case_dir, "bands.log"))
    if rc != 0:
        raise CaseError("bands", "bands.py 退出 %d" % rc,
                        [frame, roi_path, os.path.join(case_dir, "bands.log")],
                        cmd=["bands.py"], rc=rc,
                        log_path=os.path.join(case_dir, "bands.log"))
    primary = load_json(bands_path, required=True)

    backup_png = ((snap.get("backup") or {}).get("path"))
    backup = None
    # bug/0208：先清掉上一轮可能残留的 bands-backup.json，再跑备份度量；
    # 失败时同样删掉落盘一半/旧的内容，避免下游把过期备份当本轮结果。
    if os.path.exists(backup_bands_path):
        os.remove(backup_bands_path)
    if backup_png and os.path.isfile(backup_png) and os.path.abspath(backup_png) != os.path.abspath(frame):
        rc2, _ = run_cmd([sys.executable, "-I", BANDS,
                          "--png", backup_png, "--roi", roi_path,
                          "--json", backup_bands_path],
                         os.path.join(case_dir, "bands-backup.log"))
        if rc2 == 0:
            backup = load_json(backup_bands_path)
        elif os.path.exists(backup_bands_path):
            os.remove(backup_bands_path)

    write_json(os.path.join(case_dir, "pixels.json"), {
        "frame": frame,
        "frame_size": png_size(frame),
        "backup_png": backup_png,
        "backup_size": png_size(backup_png) if backup_png else None,
        "roi": roi,
        "primary_band_count": primary.get("band_count"),
        "backup_band_count": (backup or {}).get("band_count"),
    })
    mark_stage(case_dir, "bands", fingerprint,
               {"bands": bands_path, "roi": roi_path,
                "bands_sha": sha_file(bands_path), "roi_sha": sha_file(roi_path),
                # bug/0208：备份产物也要记 sha，缓存命中时据此判是否可复用。
                "backup_bands_sha": (sha_file(backup_bands_path)
                                     if backup is not None else None)})
    return {"roi": roi, "primary": primary, "backup": backup,
            "frame": frame, "backup_png": backup_png}


# ── measured.json ───────────────────────────────────────────────────────

def dom_body_runs(dom_root, dpr):
    """从 DOM 行盒按段落切正文行段，供 P-ENV-02 用（⛔ 不让它猜全部行带）。

    `line_boxes.by_block` 的 top/bottom 是 CSS px；行距按 ×DPR 转设备 px。
    """
    doc = dom_root.get("doc") or {}
    blocks = (doc.get("line_boxes") or {}).get("by_block") or []
    runs = []
    pitches_all = []
    index = 0
    for block in blocks:
        if str(block.get("tag") or "") not in ("p", "li"):
            continue
        lines = block.get("lines") or []
        tops = sorted(num(line.get("top")) for line in lines
                      if num(line.get("top")) is not None)
        if not tops:
            continue
        local = [(tops[i + 1] - tops[i]) * dpr for i in range(len(tops) - 1)]
        local = [p for p in local if p > 0]
        if index == 0:
            label = "01"
        elif index == 1:
            label = "03"
        else:
            label = "%02d" % (index + 1)
        runs.append({
            "label": label,
            "count": len(tops),
            "pitches": local,
            "items": [{"center": top * dpr, "label": label} for top in tops],
        })
        pitches_all.extend(local)
        index += 1

    cv = None
    if len(pitches_all) >= 2:
        mean = sum(pitches_all) / len(pitches_all)
        if mean:
            var = sum((p - mean) ** 2 for p in pitches_all) / len(pitches_all)
            cv = math.sqrt(var) / mean
    return runs, cv


def sample_color_on_frame(case_dir, name, rect_css, ref_color, dpr):
    """M4：`bands.py --sample-color` 取色（bug/0164）。

    ⛔ 不再传 `--line` 表达「这是 1 px 线」：容差由 `classify_sample_geometry`
    按取样几何自动选（短边 ≤1 CSS px ⇒ 8.0，≥3×3 ⇒ 3.0）。
    返回 `sample.geometry` / `reference.tolerance_source` / `warning_details` 供透传。
    """
    if ref_color is None or color_is_transparent(ref_color):
        return {"status": "skipped", "reason": "no-reference-color"}
    rgb = parse_color(ref_color)
    if rgb is None:
        return {"status": "skipped", "reason": "unparsable-reference-color",
                "reference_color": ref_color}
    if not isinstance(rect_css, dict):
        return {"status": "skipped", "reason": "no-sample-rect"}
    left = num_any(rect_css.get("left"))
    top = num_any(rect_css.get("top"))
    right = num_any(rect_css.get("right"))
    bottom = num_any(rect_css.get("bottom"))
    width = num_any(rect_css.get("width"))
    height = num_any(rect_css.get("height"))
    if right is None and left is not None and width is not None:
        right = left + width
    if bottom is None and top is not None and height is not None:
        bottom = top + height
    if None in (left, top, right, bottom):
        return {"status": "skipped", "reason": "incomplete-sample-rect"}

    x0 = int(round(left * dpr))
    x1 = int(round(right * dpr))
    y0 = int(round(top * dpr))
    y1 = int(round(bottom * dpr))
    frame = os.path.join(case_dir, "frame.png")
    size = png_size(frame)
    if size:
        x0, x1 = max(0, min(x0, size[0])), max(0, min(x1, size[0]))
        y0, y1 = max(0, min(y0, size[1])), max(0, min(y1, size[1]))
    if x1 <= x0 or y1 <= y0:
        return {"status": "skipped", "reason": "empty-sample-rect-after-clamp",
                "rect_device": [x0, y0, x1, y1]}

    out = os.path.join(case_dir, "m4-%s.json" % name)
    log_path = os.path.join(case_dir, "m4-%s.log" % name)
    cmd = [sys.executable, "-I", BANDS,
           "--png", frame,
           "--roi", os.path.join(case_dir, "roi.json"),
           "--sample-color", "%d,%d,%d,%d" % (x0, y0, x1, y1),
           "--ref", rgb_hex(rgb),
           "--json", out]
    log("  取色：%s（M4，几何自动容差）" % name)
    if DRY:
        plan_cmd(cmd)
        return {"status": "planned", "rect_device": [x0, y0, x1, y1],
                "reference_color": rgb_hex(rgb)}
    rc, _ = run_cmd(cmd, log_path)
    data = load_json(out)
    if rc != 0 or not isinstance(data, dict):
        return {"status": "error", "reason": "m4-failed",
                "exit_code": rc, "log": log_path,
                "rect_device": [x0, y0, x1, y1]}
    sample = data.get("sample") or {}
    reference = data.get("reference") or {}
    return {
        "status": "ok",
        "rect_device": [x0, y0, x1, y1],
        "reference_color": rgb_hex(rgb),
        "geometry": sample.get("geometry"),
        "sample_hex": sample.get("hex"),
        "tolerance": reference.get("tolerance"),
        "tolerance_source": reference.get("tolerance_source"),
        "delta_e_2000": data.get("delta_e_2000"),
        "pass": data.get("pass"),
        "warning_details": data.get("warning_details") or [],
        "file": out,
    }


def attach_pixel_samples(case_dir, derive, dom_root):
    """把 M4 取色挂到 `C_quote`/`C_code`/`C_rule` 的公共 metrics 上（bug/0164/0167）。

    `C_th` 没有逐格 rect、`C_link` 没有生产者色值 ⇒ 明确 skipped，⛔ 不编造。
    """
    doc = dom_root.get("doc") or {}
    dpr = derive.get("dpr") or DPR
    metrics = derive["metrics"]
    samples = {}

    bq_items = (doc.get("blockquotes") or {}).get("items") or []
    if bq_items:
        item = bq_items[0]
        bar = item.get("bar") or {}
        rect = item.get("rect") if isinstance(item.get("rect"), dict) else {}
        bar_width = num_any(bar.get("effective_width_px"))
        left, top, bottom = (num_any(rect.get("left")), num_any(rect.get("top")),
                             num_any(rect.get("bottom")))
        sample_rect = None
        if None not in (left, top, bottom) and bar_width:
            sample_rect = {
                "left": left,
                "right": left + bar_width,
                "top": top + 2,
                "bottom": min(bottom - 2, top + 20),
            }
        res = sample_color_on_frame(case_dir, "C_quote", sample_rect,
                                    bar.get("border_left_color"), dpr)
    else:
        res = {"status": "skipped", "reason": "no-blockquote"}
    samples["C_quote"] = res
    if "C_quote" in metrics and isinstance(metrics["C_quote"], dict):
        metrics["C_quote"]["sample"] = res

    code_items = (doc.get("code_blocks") or {}).get("items") or []
    if code_items:
        item = code_items[0]
        pre = item.get("pre_rect") if isinstance(item.get("pre_rect"), dict) else {}
        left, top = num_any(pre.get("left")), num_any(pre.get("top"))
        right, bottom = num_any(pre.get("right")), num_any(pre.get("bottom"))
        sample_rect = None
        if None not in (left, top, right, bottom) and bottom - top >= 8:
            # 取底部内边距带，避开文字；仍是 3×3 以上 ⇒ 容差 3.0。
            sample_rect = {"left": left + 4, "right": right - 4,
                           "top": bottom - 6, "bottom": bottom - 2}
        res = sample_color_on_frame(case_dir, "C_code", sample_rect,
                                    item.get("background_color"), dpr)
    else:
        res = {"status": "skipped", "reason": "no-code-block"}
    samples["C_code"] = res
    if "C_code" in metrics and isinstance(metrics["C_code"], dict):
        metrics["C_code"]["sample"] = res

    rule_items = (doc.get("rules") or {}).get("items") or []
    if rule_items:
        item = rule_items[0]
        rect = item.get("rect") if isinstance(item.get("rect"), dict) else {}
        left, right = num_any(rect.get("left")), num_any(rect.get("right"))
        top = num_any(rect.get("top"))
        sample_rect = None
        if None not in (left, right, top):
            # 1 px 线：短边 ≤1 CSS px ⇒ bands.py 自动取 8.0 容差。
            sample_rect = {"left": left, "right": right, "top": top, "bottom": top + 1}
        res = sample_color_on_frame(case_dir, "C_rule", sample_rect,
                                    item.get("border_top_color"), dpr)
    else:
        res = {"status": "skipped", "reason": "no-rule"}
    samples["C_rule"] = res
    if "C_rule" in metrics and isinstance(metrics["C_rule"], dict):
        metrics["C_rule"]["sample"] = res

    th_skip = {"status": "skipped",
               "reason": "no-per-cell-rect: header_cells[] 未给 rect，无法 M4 取色"}
    samples["C_th"] = th_skip
    if "C_th" in metrics and isinstance(metrics["C_th"], dict):
        metrics["C_th"]["sample"] = th_skip
    link_skip = {"status": "skipped",
                 "reason": "no-producer: dom-probe.inline.links 未采集 color"}
    samples["C_link"] = link_skip
    if "C_link" in metrics and isinstance(metrics["C_link"], dict):
        metrics["C_link"]["sample"] = link_skip
    return samples


def probe_coverage(dom_root):
    """bug/0173：显式报告「判据需要、探针已采集」的字段与未实现判据。

    `doc.breaks` / `doc.tables[].columns[].colspan` 早就有探针数据，但对应
    判据缺执行器；不把「有数据」写成「有覆盖」，也不让它们静默消失。
    """
    doc = (dom_root or {}).get("doc") or {}
    breaks = doc.get("breaks")
    tables = doc.get("tables")
    table_items = (tables or {}).get("items") if isinstance(tables, dict) else None
    colspan_values = []
    for table in table_items or []:
        for column in (table or {}).get("columns") or []:
            if isinstance(column, dict) and column.get("colspan") is not None:
                colspan_values.append(column.get("colspan"))
    return {
        "breaks": {
            "present": isinstance(breaks, dict) and bool(breaks),
            "count": (breaks or {}).get("count") if isinstance(breaks, dict) else None,
            "needed_by": ["P-BR-01"],
        },
        "tables": {
            "present": bool(table_items),
            "count": len(table_items or []),
            "colspan_present": bool(colspan_values),
            "colspan_values": colspan_values,
            "needed_by": ["P-CELLBR-01", "P-CELLBR-02"],
        },
        "note": ("探针有字段 ≠ 判据已实现；未实现判据见结果 JSON 的 "
                 "unimplemented_criteria（bug/0173）。"),
    }


def stage_derive(case_dir, fixture, B, mut_id=None, payload_doc=None, fixture_md=None):
    fingerprint = case_fingerprint(fixture, mut_id) + ":" + fmt_num(B or 0)
    # 只有「参考页」派生才做载荷绑定/交叉核对；N5 的变异载荷与夹具副本是
    # 故意分离的负对照（bug/0155），⛔ 不能拿绑定检查把它判死。
    is_reference_derive = (mut_id is None and payload_doc is None
                           and fixture_md is None)
    measured_path = os.path.join(case_dir, "measured.json")
    if (not FORCE and stage_ok(case_dir, "derive", fingerprint,
                               {"measured": measured_path})
            and os.path.isfile(measured_path)):
        return load_json(measured_path, required=True)

    dom = load_json(os.path.join(case_dir, "dom.json"), required=True)
    bands_path = os.path.join(case_dir, "bands.json")
    bands = load_json(bands_path, required=True)
    if not isinstance(bands, dict):
        raise CaseError("derive", "bands.json 不是对象：%s" % bands_path, [bands_path])
    # bug/0208：⛔ 不盲读 bands-backup.json；只接受 bands stage 登记过 sha 的产物。
    backup = verified_backup_bands(case_dir)
    pixel = {
        "roi": load_json(os.path.join(case_dir, "roi.json")),
        "primary": bands,
        "backup": backup,
        "frame": os.path.join(case_dir, "frame.png"),
        "backup_png": None,
    }
    derive = derive_metrics(dom.get("dom") or {}, dom.get("extras") or {}, B, bands)
    samples = attach_pixel_samples(case_dir, derive, dom.get("dom") or {})
    body_runs, body_cv = dom_body_runs(dom.get("dom") or {}, derive.get("dpr") or DPR)
    # N5：允许用「变异后的载荷 doc / 夹具副本」派生（bug/0155），⛔ 不复制旧产物。
    payload_doc = payload_doc if payload_doc is not None else (FIXTURE_DOC.get(fixture) or {})
    line_boxes = ((dom.get("dom") or {}).get("doc") or {}).get("line_boxes") or {}
    primary_count = bands.get("band_count")
    backup_count = (backup or {}).get("band_count")

    # bug/0120：装饰块确认合并后，依赖段间距的判据显式 unsupported，⛔ 不当 1 行静默参与。
    confirmed_splits = []
    for item in bands.get("bands") or []:
        decoration = item.get("decoration") or {}
        if decoration.get("confirmed_split") is True:
            confirmed_splits.append(item.get("index"))
    band_unsupported = []
    # 生产者字段整体缺失时 ⛔ 不能当成「没有合并带/没有告警」；显式 unsupported。
    missing_band_fields = [k for k in ("decorations", "warnings") if bands.get(k) is None]
    if missing_band_fields:
        band_unsupported.append({
            "id": "P-ENV-02",
            "reason": "no-decoration-diagnostics",
            "missing": missing_band_fields,
            "detail": "bands.json 缺 %s；⛔ 不能据此断言没有合并带/没有告警"
                      "（bug/0120/0165）" % "/".join(missing_band_fields),
        })
    if confirmed_splits:
        band_unsupported += [
            {"id": "P-ENV-02", "reason": "decoration-merged-band",
             "bands": confirmed_splits,
             "detail": "M1 把多行并成一带；正文间距 CV 不得按 1 行参与"},
            {"id": "pitch.B", "reason": "decoration-merged-band",
             "bands": confirmed_splits,
             "detail": "带内被引用条/表格线分割，pitch.B 可能含段间距"},
        ]
    pitch = bands.get("pitch") or {}
    pitch_fields = ("B", "B_source", "n_body_pitch", "n_body_runs", "pitches_body",
                    "body_runs", "body_run_rule", "spacing_cv_body",
                    "spacing_cv_body_percent", "quantization_floor_percent",
                    "pitch_resolution_px", "B_all_bands", "pitches", "cv")
    pitch_summary = {key: pitch.get(key) for key in pitch_fields}
    pitch_missing = [key for key in ("B", "B_source", "spacing_cv_body_percent",
                                     "quantization_floor_percent",
                                     "pitch_resolution_px")
                     if pitch.get(key) is None]

    # bug/0117/0121/0118/0122：页面自证 env 优先；缺则逐键盘记来源，⛔ 不冒充。
    snap = load_json(os.path.join(case_dir, "snapshot.json")) or {}
    page_attestation = snap.get("page_attestation") or {
        "status": "skipped", "reason": "no-page-attestation",
        "layout": None, "provenance": None, "fields": {},
        "missing_fields": ["page_layout", "page_provenance"],
        "source": "snapshot.json 缺失 page_attestation",
    }
    att_fields = page_attestation.get("fields") or {}
    env_block = dict(derive["env"])
    env_source = {}
    for key in ("content_width_px", "font_size", "line_height"):
        if att_fields.get(key) is not None:
            env_block[key] = att_fields[key]
            env_source[key] = "page_attestation"
        elif env_block.get(key) is not None:
            env_source[key] = "dom-probe"
        else:
            env_source[key] = None
    sidebar_width = att_fields.get("sidebar_width")
    if sidebar_width is None:
        sidebar_width = num_any((dom.get("extras") or {}).get("sidebar_width_px"))
    env_block["sidebar_width"] = sidebar_width
    env_source["sidebar_width"] = (
        "page_attestation" if att_fields.get("sidebar_width") is not None
        else ("dom-probe:extras" if sidebar_width is not None else None))
    env_block["content_box_height_px"] = att_fields.get("content_box_height_px")
    env_source["content_box_height_px"] = (
        "page_attestation" if att_fields.get("content_box_height_px") is not None
        else None)
    env_block["page_attestation_status"] = page_attestation.get("status")
    env_block["source"] = env_source

    if is_reference_derive:
        payload_binding = payload_binding_for(fixture)
        dom_line_boxes = line_boxes.get("dom_line_boxes", line_boxes.get("count"))
        payload_cross_check = payload_cross_check_for(fixture, dom_line_boxes)
    else:
        payload_binding = {
            "fixture": fixture,
            "status": "skipped",
            "reason": "非参考页派生（变异/负对照页）：载荷与夹具副本是故意分离的",
        }
        payload_cross_check = {
            "status": "skipped",
            "reason": "非参考页派生（变异/负对照页）；本轮只消费参考页载荷",
        }

    measured = {
        "tool": "l2-run",
        "fixture": fixture,
        "fixture_sha256": sha_file(fixture_md
                                   or os.path.join(FIXTURES_DIR, fixture + ".md")),
        "generated_at": now_iso(),
        "png": "frame.png",
        "png_size": png_size(os.path.join(case_dir, "frame.png")),
        "blocks": payload_doc.get("blocks"),
        "block_kinds": payload_doc.get("block_kinds"),
        # bug/0255、bug/0260：两条显式字段，缺席也写出来（⛔ 不静默）。
        "payload_binding": payload_binding,
        "payload_cross_check": payload_cross_check,
        "env": env_block,
        "page_attestation": page_attestation,
        "roi": pixel["roi"],
        "bands": {
            "count": primary_count,
            "band_count": primary_count,
            "items": bands.get("bands") or [],
            "body_runs": body_runs,
            "spacing_cv": body_cv,
            "decorations": bands.get("decorations"),
            "warnings": bands.get("warnings") or [],
            "warning_details": bands.get("warning_details"),
            "warning_details_present": bands.get("warning_details") is not None,
            "confirmed_split_indexes": confirmed_splits,
            "derived": bands.get("derived"),
            "pitch": pitch_summary,
            "pitch_missing": pitch_missing,
        },
        "primary_count": primary_count,
        "backup_count": backup_count,
        "primary_backup_count_diff": (
            abs(primary_count - backup_count)
            if primary_count is not None and backup_count is not None else None
        ),
        "dom": {
            "line_boxes": line_boxes.get("dom_line_boxes", line_boxes.get("count")),
        },
        "metrics": derive["metrics"],
        "metric_details": derive["details"],
        "metrics_missing": derive["missing"],
        "metrics_skipped": derive["skipped"],
        # bug/0173：探针字段 × 判据实现的覆盖声明（不进任何判据结论）。
        "probe_coverage": probe_coverage(dom.get("dom") or {}),
        "pixel_samples": samples,
        "unsupported": band_unsupported,
        "spec_checks": derive["spec"],
        "measure_layer": "L2-DOM/L2-PIXEL",
        "b_device_px": B,
        "provisional": True,
        "notes": [
            "metrics 由 l2-run 从 dom-probe/extras/bands 派生（§2.2 口径）。",
            "没有 L1 baseline 时 -PARITY 仍记 skipped(no-baseline)，⛔ 不假绿。",
            "颜色取样走 M4（bands.py --sample-color），⛔ 不用 --line 当容差语义（bug/0164）。",
        ],
    }
    if DRY:
        log("[dry-run]   # 派生 metrics（%d 个）与 spec_checks（%d 个）→ measured.json"
            % (len(derive["metrics"]), len(derive["spec"])))
        return measured
    write_json(measured_path, measured)
    mark_stage(case_dir, "derive", fingerprint,
               {"measured": measured_path, "measured_sha": sha_file(measured_path)})
    return measured


# ── 参考页比对（l2-check.sh）────────────────────────────────────────────

def stage_reference_check(case_dir, fixture):
    fingerprint = case_fingerprint(fixture)
    result_path = os.path.join(case_dir, "result.json")
    gates_path = os.path.join(case_dir, "gates.json")
    if (not FORCE and stage_ok(case_dir, "check", fingerprint,
                               {"result": result_path})
            and os.path.isfile(result_path)):
        result = load_json(result_path, required=True)
        # 缓存命中也要重写 gates.json：旧 gates 不能带着旧结论冒充本轮（bug/0177）。
        write_json(gates_path, {
            "tool": "preflight",
            "mode": "gates",
            "fixture": fixture,
            "inputs": (result.get("inputs")
                       or (result.get("preflight") or {}).get("inputs")),
            "gates": (result.get("preflight") or {}).get("gates"),
            "overall": (result.get("preflight") or {}).get("overall"),
        })
        return result

    # 非缓存命中：先删掉可能残留的旧 result/gates，命令没产出就报错，⛔ 不读旧文件。
    if not DRY:
        for stale in (result_path, gates_path):
            try:
                os.remove(stale)
            except FileNotFoundError:
                pass
    cmd = [
        CHECK, "--fixture", fixture,
        "--work", WORK,
        "--baseline", BASELINE,
        "--expect", EXPECT,
        "--fixtures-dir", FIXTURES_DIR,
        "--out", result_path,
    ]
    if DRY:
        plan_cmd(cmd)
        return None

    log("  比对：%s（l2-check.sh）" % fixture)
    rc, _ = run_cmd(cmd, os.path.join(case_dir, "check.log"))
    if not os.path.isfile(result_path):
        raise CaseError("check", "l2-check.sh 没有产出 result.json（退出 %d）" % rc,
                        [os.path.join(case_dir, "check.log")], cmd=cmd, rc=rc,
                        log_path=os.path.join(case_dir, "check.log"))
    result = load_json(result_path, required=True)
    result["_exit_code"] = rc
    write_json(os.path.join(case_dir, "gates.json"), {
        "tool": "preflight",
        "mode": "gates",
        "fixture": fixture,
        "inputs": (result.get("inputs")
                   or (result.get("preflight") or {}).get("inputs")),
        "gates": (result.get("preflight") or {}).get("gates"),
        "overall": (result.get("preflight") or {}).get("overall"),
    })
    mark_stage(case_dir, "check", fingerprint,
               {"result": result_path, "result_sha": sha_file(result_path)})
    return result


# ── 变异页：D2 环境豁免 + preflight 比对 ────────────────────────────────

def aggregate_status(checks):
    statuses = [c.get("status") for c in checks]
    if "fail" in statuses:
        return "fail"
    if "product-change" in statuses:
        return "product-change"
    concrete = [s for s in statuses if s not in ("n/a", None)]
    if not concrete:
        return "n/a"
    if "skipped" in concrete:
        return "skipped"
    return "pass"


def _env_mutation_policy():
    """§7.2 D2 的唯一机器可读来源（mutations.py ENV_MUTATION）。"""
    policy = MUTSPEC.get("env_mutation") or {}
    return {
        "run": list(policy.get("run") or ["P-ENV-01.nonempty", "P-ENV-01.width"]),
        "not_run": list(policy.get("not_run") or []),
    }


def _check_matches_env_condition(check, condition):
    """按结构化 data 识别检查项，⛔ 不依赖可改名/可翻译的中文 name（bug/0201）。"""
    data = check.get("data") if isinstance(check.get("data"), dict) else {}
    if condition.endswith(".nonempty"):
        return "bytes" in data and "size" in data
    if condition.endswith(".width"):
        return "width" in data and "expected" in data
    return False


def filter_gates_for_mutation(gates):
    """§7.2 D2：变异页只跑『图像非空 + 宽度断言』；其余显式豁免。

    bug/0201：keep 条件来自 mutations.py 的 ENV_MUTATION，且按结构化 data 匹配；
    必需的检查项一个都找不到时记 skipped（→ 整轮 incomplete），⛔ 不落 pass。
    全部为 n/a 时同样 ⛔ 不算 pass。
    """
    policy = _env_mutation_policy()
    env01_conditions = [c for c in policy["run"] if c.startswith("P-ENV-01.")]
    gate_level_skip = {c for c in policy["not_run"] if "." not in c}
    out = json.loads(json.dumps(gates))
    kept = []
    seen_env01 = False
    for gate in out.get("gates") or []:
        gid = gate.get("id")
        if gid == "P-ENV-01":
            seen_env01 = True
            checks = []
            matched_conditions = set()
            for check in gate.get("checks") or []:
                hits = [c for c in env01_conditions
                        if _check_matches_env_condition(check, c)]
                if hits:
                    matched_conditions.update(hits)
                    checks.append(check)
                else:
                    skipped = dict(check)
                    skipped["status"] = "n/a"
                    skipped["detail"] = (
                        "变异页豁免（D2，mutations.py env_mutation.not_run）："
                        "只跑 %s" % ", ".join(env01_conditions))
                    checks.append(skipped)
            missing = [c for c in env01_conditions if c not in matched_conditions]
            if missing:
                checks.append({
                    "name": "D2 必需检查缺失",
                    "status": "skipped",
                    "detail": "变异页豁免策略要求 %s，但 gates 里找不到对应结构化检查项"
                              % ", ".join(missing),
                    "data": {"missing": missing},
                })
            gate["checks"] = checks
            gate["status"] = aggregate_status(checks)
        elif gid in gate_level_skip:
            gate["checks"] = [{
                "name": "本页豁免",
                "status": "n/a",
                "detail": "D2：%s 只对基线页生效；变异页不套（mutations.py env_mutation）" % gid,
            }]
            gate["status"] = "n/a"
        kept.append(gate)
    if not seen_env01:
        kept.append({
            "id": "P-ENV-01",
            "title": "取像有效性",
            "status": "skipped",
            "checks": [{
                "name": "P-ENV-01 缺失",
                "status": "skipped",
                "detail": "gates.json 没有 P-ENV-01；变异页无法证明图像非空/宽度（bug/0201）",
            }],
        })
    out["gates"] = kept
    concrete = [g.get("status") for g in kept
                if g.get("status") not in ("n/a", None)]
    if not concrete:
        overall, code = "incomplete", 30
    elif "fail" in concrete:
        overall, code = "environment-invalid", 20
    elif "product-change" in concrete:
        overall, code = "product-typography-change", 15
    elif "skipped" in concrete:
        overall, code = "incomplete", 30
    else:
        overall, code = "pass", 0
    out["overall"] = {
        "status": overall,
        "exit_code": code,
        "summary": "变异页 D2 豁免后：%s（P-ENV-01 只含非空+宽度）" % overall,
    }
    return out


def stage_mutation_preflight(case_dir, fixture, mid):
    fingerprint = case_fingerprint(fixture, mid)
    gates_path = os.path.join(case_dir, "gates.json")
    filtered_path = os.path.join(case_dir, "gates.filtered.json")
    compare_path = os.path.join(case_dir, "compare.json")
    if (not FORCE and stage_ok(case_dir, "preflight", fingerprint,
                               {"gates": gates_path, "filtered": filtered_path,
                                "compare": compare_path})
            and os.path.isfile(filtered_path) and os.path.isfile(compare_path)):
        return {
            "gates": load_json(gates_path),
            "filtered": load_json(filtered_path),
            "compare": load_json(compare_path),
        }

    # 非缓存命中：先删旧产物，⛔ 不让上一轮的 gates/compare 冒充本轮（bug/0177）。
    if not DRY:
        for stale in (gates_path, filtered_path, compare_path):
            try:
                os.remove(stale)
            except FileNotFoundError:
                pass
    root = mut_root(mid)
    ensure_root(root)
    cmd = [
        sys.executable, "-I", PREFLIGHT, "gates",
        "--fixture", fixture,
        "--work", root,
        "--baseline", BASELINE,
        "--expect", EXPECT,
        "--fixtures-dir", FIXTURES_DIR,
        "--json-out", gates_path,
    ]
    if DRY:
        plan_cmd(cmd)
        log("[dry-run]   # D2 过滤：P-ENV-01 仅保留 图像非空+宽度断言；02/03/06 标 n/a")
        log("[dry-run]   write %s" % filtered_path)
        plan_cmd([sys.executable, "-I", PREFLIGHT, "compare",
                  "--fixture", fixture, "--work", root,
                  "--baseline", BASELINE, "--expect", EXPECT,
                  "--fixtures-dir", FIXTURES_DIR,
                  "--gates-json", filtered_path, "--json-out", compare_path])
        return {"gates": None, "filtered": None, "compare": None}

    log("  变异页闸门：%s × %s" % (mid, fixture))
    rc, _ = run_cmd(cmd, os.path.join(case_dir, "gates.log"))
    if not os.path.isfile(gates_path):
        raise CaseError("preflight", "preflight gates 没有产出 gates.json（退出 %d）" % rc,
                        [os.path.join(case_dir, "gates.log")], cmd=cmd, rc=rc,
                        log_path=os.path.join(case_dir, "gates.log"))
    gates = load_json(gates_path, required=True)
    filtered = filter_gates_for_mutation(gates)
    write_json(filtered_path, filtered)

    cmd2 = [
        sys.executable, "-I", PREFLIGHT, "compare",
        "--fixture", fixture,
        "--work", root,
        "--baseline", BASELINE,
        "--expect", EXPECT,
        "--fixtures-dir", FIXTURES_DIR,
        "--gates-json", filtered_path,
        "--json-out", compare_path,
    ]
    rc2, _ = run_cmd(cmd2, os.path.join(case_dir, "compare.log"))
    compare = load_json(compare_path)
    if not isinstance(compare, dict):
        raise CaseError("compare", "preflight compare 没有产出 compare.json（退出 %d）" % rc2,
                        [os.path.join(case_dir, "compare.log")], cmd=cmd2, rc=rc2,
                        log_path=os.path.join(case_dir, "compare.log"))
    mark_stage(case_dir, "preflight", fingerprint,
               {"gates": gates_path, "filtered": filtered_path, "compare": compare_path,
                "gates_sha": sha_file(gates_path),
                "filtered_sha": sha_file(filtered_path),
                "compare_sha": sha_file(compare_path)})
    return {"gates": gates, "filtered": filtered, "compare": compare}


# ── 判据取值与同端灵敏度比较 ────────────────────────────────────────────
#
# ⚠️ 现阶段没有 L1 `baseline.json`，所以 `-PARITY` 本身仍是 skipped(no-baseline)。
#    这里做的「参考页 vs 变异页」是**同端灵敏度**：它只证明变异确实被观测到，
#    ⛔ 不冒充「与 Mardo 相同/不同」的 PARITY 结论。

COLOR_DE_MAX = 3.0
RATIO_TOL = 0.05
ABS_EPS = 1e-6

GEOMETRY_DETAIL_SUFFIX = "/B"


def is_color_value(value):
    return isinstance(value, str) and parse_color(value) is not None


def primary_value(record, cid):
    metric = (record.get("metrics") or {}).get(cid)
    if isinstance(metric, dict):
        return metric.get("value")
    return metric


def detail_value(record, cid, selector):
    det = (record.get("metric_details") or {}).get(cid)
    if not isinstance(det, dict):
        return None
    if selector in det:
        return det[selector]
    keys = [k for k in det if fnmatch.fnmatchcase(k, selector)]
    if not keys:
        return None
    return [det[k] for k in sorted(keys)]


def values_for(record, cid, selector=None):
    if selector:
        return detail_value(record, cid, selector)
    if cid == "P-TBL-05-PARITY":
        det = (record.get("metric_details") or {}).get(cid) or {}
        if det.get("ratios"):
            return det["ratios"]
    if cid == "P-C-TBLINQ-01-PARITY":
        det = (record.get("metric_details") or {}).get(cid) or {}
        left = det.get("left/B")
        ratios = det.get("ratios") or []
        if left is not None:
            return [left] + list(ratios)
        if ratios:
            return list(ratios)
    return primary_value(record, cid)


def compare_pair(ref_value, mut_value):
    if ref_value is None or mut_value is None:
        return "unverified", {"reason": "缺值", "ref": ref_value, "mut": mut_value}
    if is_color_value(ref_value) or is_color_value(mut_value):
        de = color_delta(ref_value, mut_value)
        if de is None:
            return "unverified", {"reason": "颜色不可解析",
                                  "ref": ref_value, "mut": mut_value}
        return ("red" if de > COLOR_DE_MAX else "green"), {
            "kind": "color", "delta_e": de,
            "ref": ref_value, "mut": mut_value,
        }

    rlist = ref_value if isinstance(ref_value, list) else [ref_value]
    mlist = mut_value if isinstance(mut_value, list) else [mut_value]
    if len(rlist) != len(mlist):
        return "red", {
            "kind": "vector", "reason": "长度不同",
            "ref_len": len(rlist), "mut_len": len(mlist),
        }
    diffs = []
    red = False
    measured = False
    for a, b in zip(rlist, mlist):
        av, bv = num(a), num(b)
        if av is None or bv is None:
            continue
        measured = True
        diff = abs(av - bv)
        tol = max(ABS_EPS, RATIO_TOL * max(abs(av), abs(bv)))
        diffs.append({
            "ref": av, "mut": bv, "diff": diff, "tol": tol,
            "rel": (diff / max(abs(av), ABS_EPS)),
        })
        if diff > tol:
            red = True
    if not measured:
        return "unverified", {"reason": "无可比数值",
                              "ref": ref_value, "mut": mut_value}
    return ("red" if red else "green"), {
        "kind": "vector" if len(rlist) > 1 else "scalar",
        "diffs": diffs,
    }


def compare_metric(ref_record, mut_record, cid, selector=None):
    rv = values_for(ref_record, cid, selector)
    mv = values_for(mut_record, cid, selector)
    status, detail = compare_pair(rv, mv)
    return {
        "id": cid,
        "metric": selector,
        "status": status,
        "ref": rv,
        "mut": mv,
        "detail": detail,
    }


def observation_summary(evidence):
    """把一条必须红判据的逐夹具证据压成「哪条没红、差多少」（bug/0133、bug/0149）。

    `max_tol_fraction` = max(|diff| / tol)：<1 表示全部落在 T2 容差内（判据不敏感），
    报告读者不必再从嵌套的 diffs 里自己算。颜色项用 `delta_e / COLOR_DE_MAX`。
    """
    red, green, unverified = [], [], []
    max_tol_fraction = None
    max_rel = None
    max_delta_e = None
    for ev in evidence or []:
        fixture = ev.get("fixture")
        status = ev.get("status")
        if status == "red":
            red.append(fixture)
        elif status == "green":
            green.append(fixture)
        else:
            unverified.append(fixture)
        det = ev.get("detail") or {}
        if det.get("kind") == "color":
            de = num(det.get("delta_e"))
            if de is not None:
                max_delta_e = de if max_delta_e is None else max(max_delta_e, de)
                frac = de / COLOR_DE_MAX if COLOR_DE_MAX else None
                if frac is not None:
                    max_tol_fraction = (frac if max_tol_fraction is None
                                        else max(max_tol_fraction, frac))
            continue
        for diff in det.get("diffs") or []:
            rel = num(diff.get("rel"))
            if rel is not None:
                max_rel = rel if max_rel is None else max(max_rel, rel)
            diff_value = num(diff.get("diff"))
            tol = num(diff.get("tol"))
            if diff_value is not None and tol:
                frac = diff_value / tol
                max_tol_fraction = (frac if max_tol_fraction is None
                                    else max(max_tol_fraction, frac))
    return {
        "red_fixtures": red,
        "green_fixtures": green,
        "unverified_fixtures": unverified,
        "max_rel_change": max_rel,
        "max_tol_fraction": max_tol_fraction,
        "tolerance_ratio": RATIO_TOL,
        "max_delta_e": max_delta_e,
        "color_de_max": COLOR_DE_MAX,
    }


def spec_item_status(item):
    declared = item.get("status")
    if declared in ("pass", "fail", "skipped"):
        return declared
    value = num(item.get("value"))
    expected = item.get("expected")
    if value is None or expected is None:
        return "skipped"
    tol = item.get("tolerance") or {}
    if isinstance(expected, (int, float)):
        limit = num(tol.get("value")) or 0.0
        return "pass" if abs(value - expected) <= limit + 1e-9 else "fail"
    return "pass" if value == expected else "fail"


def spec_status_for(record, cid):
    for item in record.get("spec_checks") or []:
        if item.get("id") == cid:
            return spec_item_status(item), item
    return None, None


def geometry_components(record, cid):
    """返回 [(detail_key, value)]：只取 /B 比值与 ratios 向量。

    T5 的绝对 px（`RAG_para_px`）、计数（`paragraphs`）与 `color/*` 不进几何比较。
    """
    comp = []
    primary = primary_value(record, cid)
    if primary is not None:
        comp.append(("value", primary))
    det = (record.get("metric_details") or {}).get(cid)
    if isinstance(det, dict):
        for key in sorted(det):
            if key.endswith(GEOMETRY_DETAIL_SUFFIX) or key == "ratios":
                comp.append((key, det[key]))
    return comp


def component_pairs(ref_record, mut_record, cid):
    ref_map = dict(geometry_components(ref_record, cid))
    mut_map = dict(geometry_components(mut_record, cid))
    for key in sorted(set(ref_map) | set(mut_map)):
        yield key, ref_map.get(key), mut_map.get(key)


def expand_ids(records, item, exclude):
    cid = item.get("id")
    scope = item.get("scope")
    ids = set()
    if scope:
        for record in records:
            for src in (record.get("ref"), record.get("mut")):
                if not src:
                    continue
                ids.update((src.get("metrics") or {}).keys())
        return sorted(x for x in ids
                      if x.endswith("-PARITY") and x not in exclude)
    if cid and item.get("glob"):
        for record in records:
            for src in (record.get("ref"), record.get("mut")):
                if not src:
                    continue
                pool = set((src.get("metrics") or {}).keys())
                pool.update(x.get("id") for x in (src.get("spec_checks") or [])
                            if x.get("id"))
                for candidate in pool:
                    if fnmatch.fnmatchcase(candidate, cid) and candidate not in exclude:
                        ids.add(candidate)
        return sorted(ids)
    if cid and cid not in exclude:
        ids.add(cid)
    return sorted(ids)


def eval_red_item(records, item):
    cid = item.get("id")
    selector = item.get("metric")
    evidence = []
    saw_red = False
    saw_measured = False
    for record in records:
        ref_record = record.get("ref")
        mut_record = record.get("mut")
        if cid.endswith("-SPEC"):
            if not mut_record:
                continue
            status, spec_item = spec_status_for(mut_record, cid)
            if status is None:
                continue
            if status in ("pass", "fail"):
                saw_measured = True
            if status == "fail":
                saw_red = True
            evidence.append({
                "fixture": record["fixture"],
                "status": status,
                "value": (spec_item or {}).get("value"),
                "expected": (spec_item or {}).get("expected"),
            })
            continue
        if not ref_record or not mut_record:
            continue
        result = compare_metric(ref_record, mut_record, cid, selector)
        if result["status"] in ("red", "green"):
            saw_measured = True
        if result["status"] == "red":
            saw_red = True
        evidence.append(dict(result, fixture=record["fixture"]))
    status = "red" if saw_red else ("green" if saw_measured else "unverified")
    return {
        "id": cid,
        "metric": selector,
        "expected": "red",
        # bug/0279：把静态声明的必需夹具/生产者带到结果里，供覆盖判定消费。
        "required_fixtures": item.get("required_fixtures"),
        "producer": item.get("producer"),
        "status": status,
        "evidence": evidence,
        "observation": observation_summary(evidence),
    }


def eval_green_item(records, item, exclude):
    ids = expand_ids(records, item, exclude)
    base = {
        "id": item.get("id"),
        "scope": item.get("scope"),
        "metric": item.get("metric"),
        "expected": "green",
        # bug/0279：静态声明的必需夹具/生产者。
        "required_fixtures": item.get("required_fixtures"),
        "producer": item.get("producer"),
        "ids": ids,
    }
    if not ids:
        base.update(status="unverified", reason="没有可观测的判据实例", evidence=[])
        return base

    violations = []
    measured_ids = []
    unverified_ids = []

    def check_spec(cid):
        recorded = False
        for record in records:
            mut_record = record.get("mut")
            if not mut_record:
                continue
            status, spec_item = spec_status_for(mut_record, cid)
            if status is None:
                continue
            recorded = True
            if status == "fail":
                violations.append({
                    "fixture": record["fixture"], "id": cid, "kind": "SPEC",
                    "status": status,
                    "value": (spec_item or {}).get("value"),
                    "expected": (spec_item or {}).get("expected"),
                })
        return recorded

    if item.get("scope") or item.get("glob") or not item.get("metric"):
        for cid in ids:
            if cid.endswith("-SPEC"):
                if check_spec(cid):
                    measured_ids.append(cid)
                else:
                    unverified_ids.append(cid)
                continue
            found = False
            for record in records:
                ref_record = record.get("ref")
                mut_record = record.get("mut")
                if not ref_record or not mut_record:
                    continue
                for key, rv, mv in component_pairs(ref_record, mut_record, cid):
                    status, detail = compare_pair(rv, mv)
                    if status in ("red", "green"):
                        found = True
                    if status == "red":
                        violations.append({
                            "fixture": record["fixture"], "id": cid,
                            "kind": "GEOMETRY", "component": key,
                            "detail": detail,
                        })
            if found:
                measured_ids.append(cid)
            else:
                unverified_ids.append(cid)
    else:
        selector = item.get("metric")
        for cid in ids:
            found = False
            for record in records:
                ref_record = record.get("ref")
                mut_record = record.get("mut")
                if not ref_record or not mut_record:
                    continue
                result = compare_metric(ref_record, mut_record, cid, selector)
                if result["status"] in ("red", "green"):
                    found = True
                if result["status"] == "red":
                    violations.append({
                        "fixture": record["fixture"], "id": cid,
                        "kind": "METRIC", "metric": selector,
                        "detail": result["detail"],
                    })
            if found:
                measured_ids.append(cid)
            else:
                unverified_ids.append(cid)

    if violations:
        status = "red"
    elif measured_ids and not unverified_ids:
        status = "green"
    else:
        status = "unverified"
    base.update(
        status=status,
        measured_ids=sorted(set(measured_ids)),
        unverified_ids=sorted(set(unverified_ids)),
        violations=violations,
    )
    return base


def isolation_reds(records, allowed):
    """任何未被「必须红/必须绿/允许连带红」声明的 PARITY 红都算越界。"""
    all_ids = set()
    for record in records:
        for src in (record.get("ref"), record.get("mut")):
            if src:
                all_ids.update((src.get("metrics") or {}).keys())
    unexpected = []
    for cid in sorted(all_ids):
        if cid in allowed or not cid.endswith("-PARITY"):
            continue
        evidence = []
        for record in records:
            ref_record = record.get("ref")
            mut_record = record.get("mut")
            if not ref_record or not mut_record:
                continue
            result = compare_metric(ref_record, mut_record, cid, None)
            if result["status"] == "red":
                evidence.append(dict(result, fixture=record["fixture"]))
        if evidence:
            unexpected.append({"id": cid, "evidence": evidence})
    return unexpected


def mutation_allowed_ids(mutation, green_results):
    allowed = {item.get("id") for item in mutation.get("must_red") or []
               if item.get("id")}
    for group in mutation.get("allowed_collateral_red") or []:
        for cid in group.get("ids") or []:
            allowed.add(cid)
    for result in green_results:
        allowed.update(result.get("ids") or [])
    return allowed


def producer_index(records):
    """哪个夹具真正产出了某判据 ID（metrics 或 spec_checks）。

    bug/0278/0279：must 的「必须红/必须绿」只有在选中夹具确有生产者时才可判；
    子集没覆盖到生产者时必须记 unverified，⛔ 不能当成 pass/满足。
    """
    index = {}
    for record in records:
        for role in ("ref", "mut"):
            src = record.get(role)
            if not isinstance(src, dict):
                continue
            ids = set((src.get("metrics") or {}).keys())
            ids.update(x.get("id") for x in (src.get("spec_checks") or [])
                       if x.get("id"))
            for cid in ids:
                index.setdefault(cid, set()).add(record.get("fixture"))
    return {cid: sorted(v) for cid, v in index.items()}


def annotate_must_coverage(results, producers, selected_fixtures=None):
    """把每条 must 的生产条件与覆盖情况写回结果（bug/0278/0279）。

    bug/0279：must 项自带 `required_fixtures`（由 mutations.py 静态声明，见
    CRITERION_FIXTURES）。子集跑批时若一个必需夹具都没选中，该条**不可判**，
    记 unverified + reason=requires-fixtures-not-selected，⛔ 不拿空记录当 pass。
    """
    selected = set(selected_fixtures or [])
    uncovered = []
    for result in results:
        required = []
        if result.get("id"):
            required.append(result["id"])
        for cid in result.get("ids") or []:
            if cid not in required:
                required.append(cid)
        declared = list(result.get("required_fixtures") or [])
        coverage = {}
        for cid in required:
            fixtures = producers.get(cid) or []
            coverage[cid] = {"producers": fixtures, "covered": bool(fixtures)}
            if not fixtures:
                uncovered.append(cid)
        result["declared"] = {
            "required_fixtures": declared,
            "producer": result.get("producer"),
        }
        result["coverage"] = {
            "required": required,
            "by_id": coverage,
            "required_fixtures": declared,
            "note": "producers=真正产出该判据的夹具；声明来自 mutations.py"
                    "（bug/0279），空集 ⇒ 子集不覆盖生产条件",
        }
        if selected:
            present = sorted(set(declared) & selected)
            missing = sorted(set(declared) - selected)
            result["coverage"]["selected_present"] = present
            result["coverage"]["missing_from_selection"] = missing
            if declared and not present:
                result["reason"] = "requires-fixtures-not-selected"
                if result.get("status") in ("red", "green"):
                    result["status"] = "unverified"
        if result.get("status") == "unverified":
            if result.get("reason") == "requires-fixtures-not-selected":
                pass
            elif required and all(not producers.get(cid) for cid in required):
                result["reason"] = "no-producer-in-selected-fixtures"
            elif required:
                result["reason"] = "producer-exists-but-not-measured"
            else:
                result["reason"] = "no-observable-instance"
        elif result.get("status") in ("red", "green") and required and all(
                not producers.get(cid) for cid in required):
            result["reason"] = "measured-without-producer"
    return sorted(set(uncovered))


def evaluate_mutation(mutation, records):
    red_results = [eval_red_item(records, item)
                   for item in mutation.get("must_red") or []]
    for result in red_results:
        result["source"] = "mutation"
    exclude = {item.get("id") for item in mutation.get("must_red") or []
               if item.get("id")}
    green_results = [eval_green_item(records, item, exclude)
                     for item in mutation.get("must_green") or []]
    for result in green_results:
        result["source"] = "mutation"

    # bug/0205：同轮不变量（如 M1-INV）此前被并入 must_green，失败/未验证只剩
    # 一个 id，分不清是页面变异自身还是附带断言。这里单独评估、单独记分组，
    # 每条结果带 source=invariant:<id>，同时仍参与越界判定与退出码聚合。
    invariants = INVARIANTS_BY_PAGE.get(mutation["id"]) or []
    invariant_groups = []
    for invariant in invariants:
        inv_results = [eval_green_item(records, item, exclude)
                       for item in invariant.get("must_green") or []]
        for result in inv_results:
            result["source"] = "invariant:%s" % invariant["id"]
        invariant_groups.append({
            "id": invariant["id"],
            "title": invariant.get("title"),
            "must_green": inv_results,
        })
    invariant_green_results = [r for group in invariant_groups
                               for r in group["must_green"]]

    allowed = mutation_allowed_ids(mutation, green_results + invariant_green_results)
    unexpected = isolation_reds(records, allowed)

    # bug/0204：「允许连带红」此前只用来放行越界判定，红没红无人记录。
    # 逐项实测并落盘：observed=确实变红的族（附证据），unused=声明了但本轮没红。
    allowed_red_observed = []
    allowed_red_unused = []
    for group in mutation.get("allowed_collateral_red") or []:
        family = group.get("family")
        for cid in group.get("ids") or []:
            item = eval_red_item(records, {"id": cid})
            if item["status"] == "red":
                allowed_red_observed.append({
                    "family": family, "id": cid,
                    "evidence": item.get("evidence") or [],
                })
            else:
                allowed_red_unused.append({
                    "family": family, "id": cid,
                    "status": item["status"],
                    "reason": "本轮没有观测到该允许连带红",
                })

    # bug/0278/0279：must 与「选中夹具是否覆盖生产条件」绑定；缺生产者 ⇒ unverified + reason。
    producers = producer_index(records)
    selected_fixtures = [record["fixture"] for record in records]
    uncovered = annotate_must_coverage(red_results, producers, selected_fixtures)
    uncovered += annotate_must_coverage(green_results, producers, selected_fixtures)
    for group in invariant_groups:
        uncovered += annotate_must_coverage(
            group["must_green"], producers, selected_fixtures)
    required_ids = set()
    for result in red_results + green_results + invariant_green_results:
        if result.get("id"):
            required_ids.add(result["id"])
        required_ids.update(result.get("ids") or [])

    expectation_failures = []
    for result in red_results:
        if result["status"] == "green":
            expectation_failures.append({
                "kind": "must-red-not-red", "id": result["id"],
                "source": result.get("source"),
                "metric": result.get("metric"),
                # 0133/0149：必须红没红时，列出逐夹具红/绿与「差多少到容差」，
                # ⛔ 不改期望、不静默；报告读者据此判定是判据不敏感还是产品没变。
                "observations": result.get("observation"),
            })
    for result in green_results + invariant_green_results:
        if result["status"] == "red":
            expectation_failures.append({
                "kind": "must-green-red", "id": result["id"],
                "source": result.get("source"),
                "scope": result.get("scope"),
                "violations": result.get("violations") or [],
            })
    for entry in unexpected:
        expectation_failures.append({
            "kind": "unexpected-collateral-red", "id": entry["id"],
            "source": "isolation",
        })

    all_green_results = green_results + invariant_green_results
    unverified = ([r["id"] for r in red_results if r["status"] == "unverified"]
                  + [r.get("id") or r.get("scope")
                     for r in all_green_results if r["status"] == "unverified"])
    unverified_detail = [{
        "id": r.get("id") or r.get("scope"),
        "source": r.get("source"),
        "expected": r.get("expected"),
        "reason": r.get("reason") or "unverified",
        "coverage": r.get("coverage"),
    } for r in red_results + all_green_results
        if r.get("status") == "unverified"]

    if expectation_failures:
        code, label = 10, "MUTATION-EXPECTATION-FAIL"
    elif unverified:
        code, label = 30, "INCOMPLETE"
    else:
        code, label = 0, "PASS"

    return {
        "id": mutation["id"],
        "title": mutation.get("title"),
        "code": code,
        "label": label,
        "must_red": red_results,
        "must_green": green_results,
        # bug/0205：同轮不变量单独成组，⛔ 不再折进 must_green 丢掉来源。
        "invariants": invariant_groups,
        "unexpected_red": unexpected,
        # bug/0204：允许连带红的实测记录（observed/unused），⛔ 只用于放行不落账。
        "allowed_red_observed": allowed_red_observed,
        "allowed_red_unused": allowed_red_unused,
        "expectation_failures": expectation_failures,
        "unverified": sorted(set(unverified)),
        "unverified_detail": unverified_detail,
        "coverage": {
            "selected_fixtures": [record["fixture"] for record in records],
            "uncovered_must": sorted(set(uncovered)),
            "producers": {cid: producers.get(cid) or []
                          for cid in sorted(required_ids)},
            "note": "must 的必需生产条件；producers 为空 ⇒ 子集不覆盖，该条 unverified"
                    "（bug/0278/0279）",
        },
        "fixtures": [record["fixture"] for record in records],
    }


# ── 管线运行 ────────────────────────────────────────────────────────────

def bands_pitch_B(bands):
    """bug/0148/0127：只认 `pitch.B`。⛔ 不回退 `median(pitches)`（含段间距）。"""
    pitch = (bands or {}).get("pitch") or {}
    return num_any(pitch.get("B"))


def bands_pitch_info(bands):
    pitch = (bands or {}).get("pitch") or {}
    info = {key: pitch.get(key) for key in (
        "B", "B_source", "n_body_pitch", "n_body_runs", "pitches_body",
        "body_runs", "body_run_rule", "spacing_cv_body",
        "spacing_cv_body_percent", "quantization_floor_percent",
        "pitch_resolution_px", "B_all_bands", "pitches", "cv")}
    info["B_unavailable"] = info["B"] is None
    info["unavailable_reason"] = (
        None if info["B"] is not None else "no-B: pitch.B 缺失或为 null")
    return info


def prepare_pixels(case_dir, fixture, mut_id=None):
    stage_build(case_dir, fixture, mut_id)
    snapshot = stage_snapshot(case_dir, fixture, mut_id)
    pixel = stage_bands(case_dir, fixture, mut_id)
    return snapshot, pixel


def summarize_check(result):
    """bug/0261/0266：参考页结论要能独立回答「为何 30/10」，并区分复用/实测。"""
    verdict = (result or {}).get("verdict") or {}
    preflight = (result or {}).get("preflight") or {}
    measured = "_exit_code" in (result or {})
    raw_exit = (result or {}).get("_exit_code")
    # bug/0268：l2-check.sh 的 distinguishes.not_green_skips 目前没有消费方；
    # 这里从 gates 原始状态派生同口径事实，⛔ 不把「跳过」当绿。
    gate_statuses = {}
    for gate in preflight.get("gates") or []:
        gid = gate.get("id")
        if gid:
            gate_statuses[gid] = gate.get("status")
    skipped_gates = sorted(gid for gid, status in gate_statuses.items()
                           if status in ("skipped", "skip"))
    green_gates = sorted(gid for gid, status in gate_statuses.items()
                         if status in ("pass", "green"))
    derived_skips_not_green = bool(skipped_gates)
    stated_skips_not_green = ((verdict.get("distinguishes") or {})
                              .get("not_green_skips"))
    return {
        "code": verdict.get("code"),
        "label": verdict.get("label"),
        "category": verdict.get("category"),
        "detail": verdict.get("detail"),
        "parity": verdict.get("parity"),
        "spec": verdict.get("spec"),
        "register": verdict.get("register"),
        "l3": verdict.get("l3"),
        "environment_status": verdict.get("environment_status"),
        "check_exit_code": (raw_exit if raw_exit is not None
                            else verdict.get("code")),
        "check_result_source": "measured" if measured else "reused",
        "coverage_invalid": bool((result or {}).get("coverage_invalid")),
        "inputs": (result or {}).get("inputs") or preflight.get("inputs"),
        "families": (result or {}).get("families"),
        "preflight_overall": preflight.get("overall"),
        "compare_overall": (result or {}).get("compare_overall"),
        # bug/0268：跳过/绿闸门计数与「跳 ≠ 绿」的自证。
        "gate_statuses": gate_statuses,
        "skipped_gates": skipped_gates,
        "green_gate_count": len(green_gates),
        "skips_not_green": derived_skips_not_green,
        "skips_not_green_stated": stated_skips_not_green,
        "skips_not_green_consistent": (
            None if stated_skips_not_green is None
            else bool(stated_skips_not_green) == derived_skips_not_green),
    }


def snapshot_summary(snap):
    if not isinstance(snap, dict):
        return None
    env = snap.get("env") if isinstance(snap.get("env"), dict) else {}
    attestation = snap.get("page_attestation")
    attestation = attestation if isinstance(attestation, dict) else {}
    return {
        "dpr_mode": snap.get("dpr_mode"),
        "dpr_observed": snap.get("dpr_observed"),
        "dpr_expected": snap.get("dpr_expected"),
        "screen_backing_scale": snap.get("screen_backing_scale"),
        "snap_source": snap.get("snap_source"),
        "png_size": env.get("png_size") or snap.get("png_size"),
        "canvas_pt": env.get("canvas_pt") or snap.get("canvas_pt"),
        "visibility": snap.get("visibility"),
        "alpha_source": snap.get("alpha_source"),
        # bug/0265（R1 N2）：聚合摘要也带顶层 provenance，⛔ 只留在 env.*。
        "window_id": snap.get("window_id"),
        "window_id_source": snap.get("window_id_source"),
        "frame_sha256": snap.get("frame_sha256"),
        "frame_sha256_source": snap.get("frame_sha256_source"),
        "captured_at": snap.get("captured_at"),
        "captured_at_source": snap.get("captured_at_source"),
        "provenance_complete": (snap.get("provenance") or {}).get("complete"),
        "invalid": snap.get("invalid"),
        "page_attestation": attestation.get("status"),
        "page_attestation_reason": attestation.get("reason"),
    }


def run_references():
    records = []
    for fixture in REF_FIXTURES:
        case_dir = ref_case_dir(fixture)
        role = "auxiliary" if fixture in AUX_FIXTURES else "reference"
        record = {
            "fixture": fixture,
            "role": role,
            "case_dir": case_dir,
            "error": None,
            "measured": None,
            "check": None,
            "verdict": None,
            "snapshot": None,
            "bands_pitch": None,
            "payload_binding": None,
            "payload_cross_check": None,
        }
        # bug/0255：参考页阶段先做「载荷 text ↔ 磁盘夹具」绑定检查；
        # 不匹配 ⇒ 该夹具记 invalid（CaseError → 既有退出码 4），⛔ 不静默前进。
        binding = payload_binding_for(fixture)
        record["payload_binding"] = binding
        if binding.get("status") != "ok":
            record["error"] = CaseError(
                "payload-binding",
                "载荷 ↔ 夹具绑定失败（%s）：%s"
                % (fixture, binding.get("reason")),
                [binding.get("fixture_path"), FIXTURES_JSON],
            ).as_dict()
            records.append(record)
            continue
        try:
            snapshot, _ = prepare_pixels(case_dir, fixture, None)
            record["snapshot"] = snapshot_summary(snapshot)
        except CaseError as exc:
            record["error"] = exc.as_dict()
            records.append(record)
            continue
        records.append(record)

    b_ref = None
    b_source = None
    b_info = None
    for record in records:
        if record["fixture"] != "00-body" or record["error"]:
            continue
        try:
            bands = load_json(os.path.join(record["case_dir"], "bands.json"))
        except Exception:
            bands = None
        info = bands_pitch_info(bands)
        record["bands_pitch"] = info
        if b_info is None:
            b_info = info
        b_ref = info["B"]
        if b_ref is not None:
            b_source = "reference 00-body（bands.pitch.B，B_source=%s）" % (
                info.get("B_source") or "?")
            break
    if b_info is None:
        b_info = {"B": None, "B_unavailable": True,
                  "unavailable_reason": "reference-00-body-missing-or-errored"}

    if b_ref is not None and not DRY:
        write_json(B0_JSON, {
            "B": b_ref,
            "source": b_source,
            "fixture": "00-body",
            "pitch": b_info,
            "at": now_iso(),
        })

    for record in records:
        if record["error"]:
            continue
        if record["bands_pitch"] is None:
            try:
                record["bands_pitch"] = bands_pitch_info(
                    load_json(os.path.join(record["case_dir"], "bands.json")))
            except Exception:
                record["bands_pitch"] = b_info
        if b_ref is None:
            record["error"] = {
                "stage": "b",
                "detail": "参考页 00-body 没有给出 B（bands.pitch.B 缺失/为 null）：%s；"
                          "⛔ 不回退 median(pitch.pitches)（bug/0148/0127）"
                          % (b_info.get("unavailable_reason") or "unknown"),
                "artifacts": [os.path.join(record["case_dir"], "bands.json")],
                "pitch": b_info,
            }
            continue
        try:
            record["measured"] = stage_derive(
                record["case_dir"], record["fixture"], b_ref, None)
            record["page_attestation"] = record["measured"].get("page_attestation")
            record["payload_cross_check"] = record["measured"].get(
                "payload_cross_check")
            if (record["payload_cross_check"] or {}).get("status") == "warn":
                details = "; ".join(
                    item.get("detail") or ""
                    for item in record["payload_cross_check"].get("warnings") or [])
                log("  ⚠️ payload_cross_check WARN（%s）：%s"
                    % (record["fixture"], details or "未给出细节"))
            if record["role"] == "reference":
                result = stage_reference_check(record["case_dir"], record["fixture"])
                record["check"] = result
                record["verdict"] = summarize_check(result)
        except CaseError as exc:
            record["error"] = exc.as_dict()
    return records, b_ref, b_source


def run_mutation(mutation_id, b_ref):
    mutation = MUT_BY_ID[mutation_id]
    root = mut_root(mutation_id)
    ensure_root(root)

    # 每个变异环境有自己的 B：变异页的正文行距可能整体缩放（M1）。
    aux_dir = mut_case_dir(mutation_id, "00-body")
    b_mut = None
    b_source = None
    b_info = None
    aux_error = None
    aux_snapshot = None
    b_fallback = False
    try:
        aux_snapshot, _ = prepare_pixels(aux_dir, "00-body", mutation_id)
        bands = load_json(os.path.join(aux_dir, "bands.json"))
        b_info = bands_pitch_info(bands)
        b_mut = b_info["B"]
        if b_mut is not None:
            b_source = "mutated 00-body（bands.pitch.B，B_source=%s）" % (
                b_info.get("B_source") or "?")
    except CaseError as exc:
        aux_error = exc.as_dict()
    if b_mut is None:
        # bug/0262：回退不是“换个字符串”而已——必须让 verdict 显式降级并带 reason。
        b_fallback = b_ref is not None
        b_mut = b_ref
        b_source = ("reference 00-body（变异页 pitch.B 不可用，fallback；"
                    "reference B_source=%s）" % ((b_info or {}).get("B_source") or "?")
                    if b_ref is not None else None)

    records = []
    cases = []
    for fixture in FIXTURES:
        case_dir = mut_case_dir(mutation_id, fixture)
        case = {
            "fixture": fixture,
            "mutation": mutation_id,
            "case_dir": case_dir,
            "b": b_mut,
            "b_source": b_source,
            "b_pitch": b_info,
            "env_ok": False,
            "env_status": None,
            "compare_code": None,
            "error": None,
            "env": None,
            "snapshot": None,
            "page_attestation": None,
            "diagnostics": None,
        }
        try:
            snapshot = aux_snapshot if fixture == "00-body" else None
            if fixture != "00-body":
                snapshot, _ = prepare_pixels(case_dir, fixture, mutation_id)
            case["snapshot"] = snapshot_summary(snapshot)
            measured = stage_derive(case_dir, fixture, b_mut, mutation_id)
            case["page_attestation"] = measured.get("page_attestation")
            case["diagnostics"] = diagnostics_of(measured)
            preflight = stage_mutation_preflight(case_dir, fixture, mutation_id)
            overall = ((preflight.get("filtered") or {}).get("overall") or {})
            compare = preflight.get("compare") or {}
            compare_overall = compare.get("overall") or {}
            env_status = overall.get("status")
            # bug/0186：incomplete/n/a 不是「环境有效」；只有 pass 才允许参与变异判定。
            env_ok = env_status == "pass"
            case["env_ok"] = env_ok
            case["env_status"] = env_status
            case["compare_code"] = compare_overall.get("exit_code")
            case["env"] = {
                "filtered": overall,
                "compare": compare_overall,
                "compare_coverage_invalid": bool(compare.get("coverage_invalid")),
            }

            ref_measured = None
            ref_path = os.path.join(ref_case_dir(fixture), "measured.json")
            if os.path.isfile(ref_path):
                ref_measured = load_json(ref_path)
            record = {
                "fixture": fixture,
                "ref": ref_measured,
                "mut": measured if env_ok else None,
                "env_ok": env_ok,
                "reason": None,
            }
            if ref_measured is None:
                record["mut"] = None
                record["reason"] = "参考页 measured.json 缺失（先跑参考页）"
            elif not env_ok:
                record["reason"] = "变异页环境未通过：%s（compare exit %s）" % (
                    env_status, compare_overall.get("exit_code"))
            records.append(record)
            case["reason"] = record.get("reason")
            case["ref_present"] = ref_measured is not None
            case["mut_present"] = measured is not None
            case["aux_error"] = aux_error
        except CaseError as exc:
            case["error"] = exc.as_dict()
            case["reason"] = exc.detail
            case["ref_present"] = False
            case["mut_present"] = False
            case["aux_error"] = aux_error
            records.append({
                "fixture": fixture,
                "ref": None,
                "mut": None,
                "env_ok": False,
                "reason": exc.detail,
            })
        cases.append(case)

    verdict = evaluate_mutation(mutation, records)
    verdict["b"] = b_mut
    verdict["b_source"] = b_source
    verdict["b_pitch"] = b_info
    verdict["aux_error"] = aux_error
    verdict["b_fallback"] = {
        "used": bool(b_fallback),
        "reason": ("变异页 pitch.B 不可用，退回 reference B=%s；该轮 B 不是变异页实测"
                   % (fmt_num(b_ref) if b_ref is not None else "缺")
                   if b_fallback else None),
    }
    if b_fallback:
        verdict["unverified"] = sorted(set(
            list(verdict.get("unverified") or []) + ["B-FALLBACK"]))
        detail = verdict.setdefault("unverified_detail", [])
        detail.append({
            "id": "B-FALLBACK",
            "expected": "变异页自己的 pitch.B",
            "reason": "b-fallback-to-reference",
            "aux_error": aux_error,
        })

    # bug/0210：内部错误、环境无效、compare 15、B 回退、环境未完成都显式并入退出码，
    # ⛔ 不再出现「批次已经 10/20 时内部错误不改变顶层码」。优先级由 pick_exit 统一。
    extra_codes = []
    if any(c["error"] for c in cases):
        extra_codes.append(4)       # 任一夹具阶段失败都是内部错误
    if any((c.get("env_status") == "environment-invalid")
           or ((c.get("env") or {}).get("compare_coverage_invalid")) for c in cases):
        extra_codes.append(20)
    if any(c.get("compare_code") == 15 for c in cases):
        extra_codes.append(15)      # bug/0186：compare 的产品排版变更不再被丢
    if b_fallback:
        extra_codes.append(30)
    if any(c["error"] is None and not c["env_ok"] for c in cases):
        extra_codes.append(30)      # incomplete / n/a 不再冒充环境有效
    if aux_error and not b_fallback:
        extra_codes.append(4)       # 辅助页失败且无 B 可退 ⇒ 内部错误
    base_code = verdict.get("code")
    final_code = pick_exit([base_code] + extra_codes)
    verdict["code"] = final_code
    verdict["label"] = label_for_code(final_code, verdict.get("label"))
    verdict["aggregation"] = {
        "base_code": base_code,
        "extra_codes": extra_codes,
        "final_code": final_code,
        "priority": "4 > 20 > 15 > 10 > 30 > 0",
    }
    attempted = [c for c in cases if not c["error"]]
    verdict["attempted"] = len(attempted)
    verdict["stage_failed"] = len(cases) - len(attempted)

    if not DRY:
        write_json(os.path.join(root, "verdict.json"), verdict)
    return {"id": mutation_id, "verdict": verdict, "cases": cases}


def diagnostics_of(measured):
    """bug/0120/0165：把 ROI 回落、装饰带与告警从 measured.json 带到总 result.json。"""
    if not isinstance(measured, dict):
        return None
    bands = measured.get("bands") if isinstance(measured.get("bands"), dict) else {}
    return {
        "roi": measured.get("roi"),
        "bands": {
            "decorations": bands.get("decorations"),
            "warnings": bands.get("warnings") or [],
            "warning_details": bands.get("warning_details") or [],
            "confirmed_split_indexes": bands.get("confirmed_split_indexes") or [],
        },
        "unsupported": measured.get("unsupported") or [],
        "metrics_missing_count": len(measured.get("metrics_missing") or []),
        "metrics_skipped_count": len(measured.get("metrics_skipped") or []),
        "pitch_missing": measured.get("pitch_missing"),
    }


def summarize_record(record):
    return {
        "fixture": record.get("fixture"),
        "role": record.get("role"),
        "case_dir": record.get("case_dir"),
        "error": record.get("error"),
        "verdict": record.get("verdict"),
        "measured": bool(record.get("measured")),
        "diagnostics": diagnostics_of(record.get("measured")),
        "snapshot": record.get("snapshot"),
        "bands_pitch": record.get("bands_pitch"),
        "page_attestation": record.get("page_attestation"),
        # bug/0266：每个阶段的 cached/at/指纹可见，⛔ 不把复用当实测。
        "stages": stages_for(record.get("case_dir")),
        # bug/0255、bug/0260：显式字段随记录进总 result.json。
        "payload_binding": record.get("payload_binding"),
        "payload_cross_check": record.get("payload_cross_check"),
    }


def payload_binding_summary(ref_records):
    """bug/0255：把逐夹具绑定结果与集合/自摘要核对汇成 result.json 顶层字段。"""
    checked = []
    mismatches = []
    for record in ref_records:
        binding = record.get("payload_binding")
        if not isinstance(binding, dict):
            continue
        checked.append({
            "fixture": record.get("fixture"),
            "role": record.get("role"),
            "status": binding.get("status"),
            "fixture_sha256": binding.get("fixture_sha256"),
            "payload_text_sha256": binding.get("payload_text_sha256"),
        })
        if binding.get("status") != "ok":
            mismatches.append({
                "fixture": record.get("fixture"),
                "expected_sha": binding.get("fixture_sha256"),
                "payload_sha": binding.get("payload_text_sha256"),
                "reason": binding.get("reason"),
            })
    set_check = payload_set_check()
    self_check = payload_self_check()
    if (mismatches or set_check.get("status") != "ok"
            or self_check.get("status") != "ok"):
        status = "mismatch"
    else:
        status = "ok"
    return {
        "status": status,
        "normalization": "none（逐字节 UTF-8；⛔ 不 strip、不折叠/统一换行）",
        "mismatches": mismatches,
        "checked": checked,
        "set": set_check,
        "self": self_check,
    }


def payload_cross_check_summary(ref_records):
    """bug/0260 消费侧汇总：本轮只 WARN，⛔ 不参与退出码。"""
    fixtures = []
    for record in ref_records:
        cross = record.get("payload_cross_check")
        if not isinstance(cross, dict):
            continue
        fixtures.append({
            "fixture": record.get("fixture"),
            "role": record.get("role"),
            "status": cross.get("status"),
            "warnings": cross.get("warnings") or [],
        })
    status = "warn" if any(f.get("status") == "warn" for f in fixtures) else "ok"
    return {
        "status": status,
        "hard_failure": False,
        "note": "本轮只 WARN + 落盘；要不要判红留给设计（bug/0260）",
        "fixtures": fixtures,
    }


# ── 负对照 N1–N7（管线层，⛔ 不套 D2 变异页豁免）─────────────────────

NEGATIVE_TITLES = {
    "N1": "ROI 平移 10 px",
    "N2": "墨迹阈值 32 → 160",
    "N3": "基线某行置空",
    "N4": "基线 window_id 改成不存在的值（已移入 §7.1 L1）",
    "N5": "夹具加一行",
    "N6": "backing scale 1 ↔ 2",
    "N7": "snapshotWidth 写死 1000 并当成 px",
}


def neg_result(nid, status, code, **kwargs):
    result = {
        "id": nid,
        "title": NEGATIVE_TITLES.get(nid),
        "status": status,
        "code": code,
        "evidence": [],
        "notes": [],
        # bug/0240：负对照与变异共用 must 口径，⛔ 不再只有自由文本证据。
        # 不跑 preflight 闸门的 N1/N2/N6 显式记 isolation.evaluated=false，
        # 避免「没检查」与「检查通过」在 JSON 里无法区分。
        "must_red": [],
        "must_green": [],
        "unexpected_red": [],
        "isolation": {
            "evaluated": False,
            "reason": "该负对照不跑 preflight 闸门，越界红不可判（bug/0240）",
        },
        # D3 ③：N1 的 green 继承自参考页，顶层要能直接读总闸门结论。
        "reference_gates_overall": None,
        "reference_green": None,
    }
    result.update(kwargs)
    return result


def negative_artifact(nid, name):
    return os.path.join(neg_root(nid), name)


def require_ref_file(fixture, name):
    path = os.path.join(ref_case_dir(fixture), name)
    if not os.path.isfile(path):
        raise CaseError("negative", "参考页缺少 %s：%s" % (name, path), [path])
    return path


def ref_gate(fixture, gate_id):
    path = os.path.join(ref_case_dir(fixture), "gates.json")
    data = load_json(path)
    if not isinstance(data, dict):
        return None, None
    for gate in data.get("gates") or []:
        if gate.get("id") == gate_id:
            return gate.get("status"), gate
    return None, None


def ref_spec_statuses(fixture):
    measured = load_json(os.path.join(ref_case_dir(fixture), "measured.json"))
    if not isinstance(measured, dict):
        return None
    statuses = []
    for item in measured.get("spec_checks") or []:
        statuses.append((item.get("id"), spec_item_status(item)))
    return statuses


def reference_env_green(fixture):
    """bug/0241：N1 的 green 继承自参考页，先确认参考页本身是绿的。

    读 `gates.json.overall`（旧实现只读单闸门/单 spec，参考页整体
    `environment-invalid/20` 时 N1 仍会写 `green=true`）。⛔ 缺失或非
    `pass + exit 0` 一律视为「不绿」，不得继承。
    """
    path = os.path.join(ref_case_dir(fixture), "gates.json")
    data = load_json(path)
    overall = (data or {}).get("overall") if isinstance(data, dict) else None
    if not isinstance(overall, dict):
        return False, {
            "status": None,
            "exit_code": None,
            "file": path,
            "reason": "reference-gates-overall-missing",
        }
    raw_code = overall.get("exit_code")
    try:
        code = None if raw_code is None else int(raw_code)
    except (TypeError, ValueError):
        code = None
    ok = overall.get("status") == "pass" and code == 0
    return ok, {
        "status": overall.get("status"),
        "exit_code": raw_code,
        "file": path,
        "reason": None if ok else "reference-gates-not-pass",
    }


def prepare_negative_root(nid):
    """bug/0177/0263：负对照开跑前清空自己的产物根。

    旧实现只 `makedirs`，上一轮的 gates.json/PNG/measured.json 会留在原处，
    失败路径或“先跑后读”只判 `isinstance` 的代码会把旧证据当成本轮结果。
    """
    root = neg_root(nid)
    if DRY:
        return root
    if os.path.isdir(root):
        shutil.rmtree(root)
    os.makedirs(root, exist_ok=True)
    write_json(os.path.join(root, "run.json"), {
        "id": nid,
        "started_at": now_iso(),
        "pid": os.getpid(),
        "logic_version": L2RUN_LOGIC_VERSION,
    })
    return root


def negative_n1():
    fixture = NEG_FIXTURE
    ref_dir = ref_case_dir(fixture)
    frame = require_ref_file(fixture, "frame.png")
    roi = load_json(os.path.join(ref_dir, "roi.json"), required=True)
    base_bands = load_json(os.path.join(ref_dir, "bands.json"), required=True)
    root = prepare_negative_root("N1")

    shifted = json.loads(json.dumps(roi))
    box = shifted.get("content_box") or {}
    for key in ("left", "right", "top", "bottom"):
        if num(box.get(key)) is None:
            raise CaseError("negative", "参考 ROI 缺 %s" % key, [os.path.join(ref_dir, "roi.json")])
        box[key] = num(box[key]) + 10.0
    shifted["source"] = "N1：参考 ROI 平移 +10 px（x 与 y 同向）"
    roi_path = negative_artifact("N1", "roi-shifted.json")
    bands_path = negative_artifact("N1", "bands-shifted.json")
    write_json(roi_path, shifted)

    cmd = [sys.executable, "-I", BANDS,
           "--png", frame, "--roi", roi_path, "--json", bands_path]
    rc, _ = run_cmd(cmd, negative_artifact("N1", "bands.log"))
    if rc != 0:
        raise CaseError("negative", "bands.py（平移 ROI）退出 %d" % rc,
                        [roi_path, negative_artifact("N1", "bands.log")],
                        cmd=cmd, rc=rc,
                        log_path=negative_artifact("N1", "bands.log"))
    shifted_bands = load_json(bands_path, required=True)

    base_items = base_bands.get("bands") or []
    shift_items = shifted_bands.get("bands") or []
    matched = min(len(base_items), len(shift_items))
    per_band = []
    changed = 0
    for index in range(matched):
        b = base_items[index]
        s = shift_items[index]
        deltas = {}
        for key in ("left", "right", "top", "bottom", "height"):
            bv, sv = num(b.get(key)), num(s.get(key))
            deltas[key] = None if (bv is None or sv is None) else (sv - bv)
        moved_edges = sum(
            1 for key in ("left", "right", "top", "bottom")
            if deltas[key] is not None and abs(deltas[key]) >= 5.0
        )
        if moved_edges:
            changed += 1
        per_band.append({"index": index, "deltas": deltas, "moved_edges": moved_edges})

    count_same = len(base_items) == len(shift_items)
    all_changed = bool(matched) and changed == matched and count_same
    spec = ref_spec_statuses(fixture)
    ref_green, ref_gate_detail = reference_env_green(fixture)
    # bug/0241：参考页整体不绿（如 environment-invalid/20）时，N1 不得继承 green=true。
    spec_green = bool(spec) and all(status == "pass" for _, status in spec) and ref_green
    env05_status, _ = ref_gate(fixture, "P-ENV-05")
    env05_green = env05_status == "pass" and ref_green

    # bug/0134：设计写的「全部几何必须红」不可满足——判据层几何来自 DOM，
    # 而 ROI 只作用于像素路径。必须红按**实际能动的量**（像素派生量）定义：
    # ① 每个匹配带的左/右/上/下缘至少一侧移动 ≥5 px；② 带数不变。
    # DOM 派生量登记为「不受影响」，作为「ROI 不该改变判据层几何」的正面证据。
    pixel_red = all_changed
    resized = png_size(frame)
    roi_shifted_bottom = num((shifted.get("content_box") or {}).get("bottom"))
    roi_overrun = bool(resized and roi_shifted_bottom is not None
                       and roi_shifted_bottom > resized[1])

    if not matched:
        status, code, reason = "unverified", 30, "no-band-matched"
    elif not ref_green:
        # 前提不成立：参考页环境无效时，「红 + 绿继承」的结论无意义。
        status, code, reason = "unverified", 30, ref_gate_detail["reason"]
    elif pixel_red and spec_green and env05_green:
        status, code, reason = "red", 0, None
    else:
        status, code, reason = "expectation-fail", 10, "pixel-or-inherited-green-missing"

    evidence = [{
        "fixture": fixture,
        "roi_base": roi.get("content_box"),
        "roi_shifted": shifted.get("content_box"),
        "frame_size": resized,
        "roi_shifted_bottom": roi_shifted_bottom,
        "roi_overrun_frame": roi_overrun,
        "base_band_count": len(base_items),
        "shifted_band_count": len(shift_items),
        "matched_bands": matched,
        "changed_bands": changed,
        "bands": per_band,
        "reference_gates_overall": ref_gate_detail,
        "reference_green": ref_green,
    }]
    notes = [
        "bug/0134：原设计「全部几何红」按构造不可满足——判据层几何由 dom-probe 的 "
        "getClientRects()/getComputedStyle() 产出，与 ROI 无关；ROI 只裁像素图。",
        "本负对照的必须红改为像素派生量：%d/%d 个匹配带的左/右/上/下缘至少一侧移动 "
        "≥5 px，且带数%s。" % (changed, matched, "不变" if count_same else "改变"),
        "DOM 派生量（P-*-PARITY 的判据层几何）在 N1 下不变，已作为「不受 ROI 影响」"
        "的证据登记；⛔ 不把它们算进必须红。",
        "P-*-SPEC 与 P-ENV-05 沿用参考页闸门；两者任一不绿 ⇒ 记 expectation-fail。",
    ]
    if roi_overrun:
        notes.append(
            "⚠️ 平移后的 ROI 下缘 %s px 超出帧高 %s px：bands.py 实际是在被裁过的窗口"
            "上取带，这条负对照同时混入「窗口裁切」变量（见 bug/0134 §1.1）。"
            % (fmt_num(roi_shifted_bottom), fmt_num(resized[1] if resized else None)))
    return neg_result(
        "N1", status, code,
        expectation="像素派生量红：全部匹配带边缘移动 ≥5 px 且带数不变；DOM 几何不变；P-*-SPEC、P-ENV-05 绿",
        reason=reason,
        evidence=evidence,
        notes=notes,
        must_red=[{
            "id": "PIXEL-BANDS",
            "scope": "像素派生量：行带左/右/上/下缘、带数",
            "status": "red" if pixel_red else "green",
        }],
        # bug/0240：负对照的 green 侧也进 must 口径（此前只有自由文本）。
        must_green=[{
            "id": "DOM-GEOMETRY",
            "status": "unchanged",
            "reason": "ROI 只作用于像素路径；判据层几何由 DOM 派生，按构造不变（bug/0134）",
        }, {
            "id": "P-ENV-05",
            "status": "pass" if env05_green else "fail",
            "detail": env05_status,
        }],
        # D3 ③：顶层给出参考页总闸门结论，⛔ 只埋在 evidence[] 里。
        reference_gates_overall=ref_gate_detail,
        reference_green=ref_green,
        unaffected=[{
            "id": "DOM-GEOMETRY",
            "status": "unchanged",
            "reason": "ROI 只作用于像素路径；判据层几何由 DOM 派生，按构造不变（bug/0134）",
        }],
        case_dir=root,
        green={
            "spec_all_pass": spec_green,
            "P-ENV-05": env05_status,
            # bug/0241：green 的继承源本身必须绿，否则这里全为 false。
            "reference_gates_green": ref_green,
            "reference_gates": ref_gate_detail,
        },
    )


def negative_n2():
    """N2：墨迹阈值 32 → 160。

    bug/0124：设计写「必须红 P-ENV-01（带数变）」，但 P-ENV-01 在 `preflight.py` 里
    **没有「期望带数」输入**（design L1644 D1 明令不含「带数与预期显示行数相等」），
    所以无论带数怎么变，该闸门都不会红。这里：
      ① 在确实会变的夹具上测带数差（默认 06a-table，其次 12-task / 00-body）；
      ② 同时跑阈值 40 的微扰，区分「灵敏」与「抖动」；
      ③ 结论如实记 `unsupported`（30），⛔ 绝不因为带数变了就记 red/0。
    """
    root = prepare_negative_root("N2")
    candidates = [f for f in ("06a-table", "12-task", "00-body")
                  if os.path.isdir(ref_case_dir(f))]
    if not candidates:
        raise CaseError("negative", "N2 找不到可用的参考页（06a-table/12-task/00-body）",
                        [NEG_ROOT])

    runs = []
    for fixture in candidates:
        frame = require_ref_file(fixture, "frame.png")
        roi = require_ref_file(fixture, "roi.json")
        per_threshold = {}
        for threshold in (32, 40, 160):
            out = negative_artifact("N2", "%s-bands-t%d.json" % (fixture, threshold))
            cmd = [sys.executable, "-I", BANDS,
                   "--png", frame, "--roi", roi, "--threshold", str(threshold),
                   "--json", out]
            log_name = "%s-bands-t%d.log" % (fixture, threshold)
            rc, _ = run_cmd(cmd, negative_artifact("N2", log_name))
            if rc != 0:
                raise CaseError("negative", "bands.py --threshold %d 退出 %d（%s）"
                                % (threshold, rc, fixture),
                                [out, negative_artifact("N2", log_name)],
                                cmd=cmd, rc=rc,
                                log_path=negative_artifact("N2", log_name))
            data = load_json(out, required=True)
            per_threshold[threshold] = {
                "band_count": data.get("band_count"),
                "B": bands_pitch_B(data),
                "json": out,
            }
        c32 = per_threshold[32]["band_count"]
        c40 = per_threshold[40]["band_count"]
        c160 = per_threshold[160]["band_count"]
        runs.append({
            "fixture": fixture,
            "threshold_32": per_threshold[32],
            "threshold_40": per_threshold[40],
            "threshold_160": per_threshold[160],
            "band_count_delta_160": (
                None if (c32 is None or c160 is None) else c160 - c32),
            "band_count_delta_40": (
                None if (c32 is None or c40 is None) else c40 - c32),
            "baseline_readable": bool(c32) and c32 > 0,
        })

    readable = [r for r in runs if r["baseline_readable"]]
    perturbed = [r for r in readable if r["band_count_delta_160"]]
    noisy = [r for r in readable if r["band_count_delta_40"]]
    chosen = perturbed[0]["fixture"] if perturbed else None

    if not readable:
        status, code = "unverified", 30
        reason = "baseline-unreadable"
    elif not perturbed:
        # 阈值变化没有引起任何带数变化 ⇒ 这版负对照的施加本身不成立。
        status, code = "expectation-fail", 10
        reason = "threshold-perturbation-no-effect"
    else:
        # 带数确实变了，但 P-ENV-01 无「期望带数」可比 ⇒ 必须红不可满足。
        status, code = "unsupported", 30
        reason = "P-ENV-01-has-no-expected-band-count"

    notes = [
        "bug/0124：`preflight.py` 的 P-ENV-01 只判 `count > 0` 与主/备带数差 ≤1，"
        "没有「期望带数」输入（design L1644 D1 明令不含该相等判定）⇒ "
        "「必须红 P-ENV-01（带数变）」按现设计**不可满足**，本负对照只能记 unsupported。",
        "带数差仅作为 runner 级灵敏度证据，⛔ 不冒充 preflight 红、⛔ 不记绿。",
        "阈值 32→40 的微扰用于区分「灵敏」与「抖动」：本夹具上 40 与 32 的带数%s。"
        % ("一致" if not noisy else "不一致（%s）" % ", ".join(
            "%s:%s" % (r["fixture"], r["band_count_delta_40"]) for r in noisy)),
        "要真正打红，需给 P-ENV-01 补「期望带数」输入（如从参考页带数冻结），"
        "属 preflight.py 的契约变更，见 .agent/l2-contract-requests.md。",
    ]
    return neg_result(
        "N2", status, code,
        reason=reason,
        expectation="P-ENV-01 红（带数变）；基线读取本身绿",
        evidence=[{
            "candidates": candidates,
            "chosen_fixture": chosen,
            "runs": runs,
            "band_count_changed": bool(perturbed),
            "reverse_perturbation_ok": not noisy,
        }],
        # bug/0240：N2 不跑闸门，必须红按设计不可满足；如实记 not-judgeable，
        # ⛔ 不写成 red，也不留空数组让读者猜。
        must_red=[{
            "id": "P-ENV-01.band_count",
            "status": "not-judgeable",
            "reason": reason,
            "detail": "P-ENV-01 无期望带数输入（bug/0124），施加有效也不可判红",
        }],
        must_green=[{
            "id": "BASELINE-READABLE",
            "status": "pass" if readable else "fail",
            "detail": "阈值 32 的基线带数可读且 > 0",
        }],
        isolation={
            "evaluated": False,
            "reason": "N2 只调 bands.py 阈值，不跑 preflight 闸门（bug/0240）",
        },
        notes=notes,
        case_dir=root,
    )


def negative_n3():
    root = prepare_negative_root("N3")
    if not os.path.isfile(BASELINE):
        return neg_result(
            "N3", "unsupported", 30,
            expectation="仅被置空的那一个 ID 红；其余 ID 绿",
            evidence=[{"baseline": BASELINE, "present": False}],
            notes=["缺 L1 baseline.json ⇒ N3 无从施加；落地基线后按 §7.2 重跑。",
                   "⛔ 不把『没有基线』写成通过。"],
            case_dir=root,
        )
    return neg_result(
        "N3", "unsupported", 30,
        expectation="仅被置空的那一个 ID 红；其余 ID 绿",
        evidence=[{"baseline": BASELINE, "present": True}],
        notes=["preflight.py 对空值走 compare_values → skipped(type-mismatch)，"
               "不是 fail ⇒ 现有比对器无法表达 §7.2『仅该 ID 红』。",
               "需要在比对器侧新增『空值 = 红』语义后才能真跑；⛔ 不伪造红。"],
        case_dir=root,
    )


def negative_n4():
    """N4：把基线 `window_id` 改成不存在的值 ⇒ P-ENV-04 必须红。

    bug/0161：设计把它移进 §7.1 的 L1 变异表，但全仓没有 baseline.json 的写入者、
    也没有 L1 变异 runner ⇒ 这条负对照在任何层都不执行。本函数如实产出
    `skipped(reason=no-runner)`，并由汇总与结果 JSON 的 `unverified_negatives`
    让「未验证」可见；⛔ 不混在普通 30 里被忽略。
    """
    root = prepare_negative_root("N4")
    return neg_result(
        "N4", "skipped", 30,
        reason="no-runner",
        expectation="—（§7.2 表已移入 §7.1 的 L1 变异表）",
        evidence=[{
            "moved_to": "§7.1 L1",
            "l1_runner": None,
            "baseline_writer": None,
            "l2_window_id_source": "l2-run.sh::stage_snapshot 写死 window_id=None",
        }],
        notes=[
            "N4 改的是基线 window_id，属 L1 窗口闸门；L2 离屏管线无从施加。",
            "§7.1 侧无执行体：没有 baseline.json 写入者，也没有 L1 变异 runner "
            "⇒ 该负对照未执行（reason=no-runner），⛔ 不当作通过。",
            "P-ENV-04 的 base_window 仍从基线顶层读 window_id，而设计 §2.9 把 "
            "window_id 放在每条基线的 provenance 里 ⇒ 读取路径不一致，"
            "⚑ 待设计批准（window_id 的正规位置）＋待 C 组改 preflight.py。",
        ],
        case_dir=root,
    )


def _n5_mutated_payload(fixture, root):
    """为 N5 造一份「同一夹具加了一行」的 Stage A 载荷副本（bug/0155）。

    只在副本上给目标夹具追加一个 Paragraph 块（html/text/blocks 同步增），
    ⛔ 不改 `fixtures.json` 本体、⛔ 不改 `fixtures/` 原文件。
    """
    payload = load_json(FIXTURES_JSON, required=True)
    mutated = json.loads(json.dumps(payload))
    doc = None
    for entry in mutated.get("docs") or []:
        if isinstance(entry, dict) and canonical_fixture(entry.get("name")) == fixture:
            doc = entry
            break
    if doc is None:
        raise CaseError("negative", "Stage A 载荷里没有夹具 %s" % fixture,
                        [FIXTURES_JSON])
    extra_text = "N5 负对照：新增一行。"
    doc["html"] = (doc.get("html") or "") + "\n<p>%s</p>\n" % extra_text
    doc["text"] = (doc.get("text") or "") + "\n\n%s\n" % extra_text
    last_line = int(doc.get("line_count") or 0) + 1
    doc["line_count"] = last_line
    kinds = doc.get("block_kinds") or []
    para_index = kinds.index("Paragraph") if "Paragraph" in kinds else 0
    blocks = json.loads(json.dumps(doc.get("blocks") or []))
    blocks.append([para_index, last_line, last_line, 1])
    doc["blocks"] = blocks
    path = os.path.join(root, "fixtures-n5.json")
    write_json(path, mutated)
    return path, doc


def negative_n5():
    """N5：夹具加一行 ⇒ P-ENV-05 必须红；P-COV-02（块序列/行盒数）允许连带红。

    bug/0155：旧实现只改夹具副本 SHA、把参考页的 measured/frame/bands/roi 原样复制，
    块种类序列与 DOM 行盒数读的都是**旧产物** ⇒ 这条负对照对它们没有鉴别力。
    现在改为：变异载荷副本 → 重新构页/取像/度量/派生（不复制任何旧产物）→ 跑闸门。
    """
    fixture = NEG_FIXTURE
    root = prepare_negative_root("N5")
    work = os.path.join(root, "work")
    tmp_fixtures = os.path.join(root, "fixtures")
    case_dir = os.path.join(work, fixture)

    if DRY:
        plan_cmd(["cp", os.path.join(FIXTURES_DIR, fixture + ".md"),
                  os.path.join(tmp_fixtures, fixture + ".md")])
        log("[dry-run]   # 追加一行到 N5 夹具副本 + Stage A 载荷副本")
        plan_cmd([BUILD, fixture, os.path.join(case_dir, "page"),
                  "--fixtures-json", os.path.join(root, "fixtures-n5.json"),
                  "--sidebar-width", fmt_num(SIDEBAR)])
        return neg_result("N5", "planned", 0, evidence=[], notes=[],
                          reason="dry-run", case_dir=root)

    os.makedirs(case_dir, exist_ok=True)
    os.makedirs(tmp_fixtures, exist_ok=True)
    # 每次都重采：⛔ 不复制参考页旧产物，也不复用上一次 N5 的产物。
    clean_case(case_dir)

    src_fixture = os.path.join(FIXTURES_DIR, fixture + ".md")
    dst_fixture = os.path.join(tmp_fixtures, fixture + ".md")
    shutil.copyfile(src_fixture, dst_fixture)
    with open(dst_fixture, "a", encoding="utf-8") as handle:
        handle.write("\n\nN5 负对照：新增一行。\n")

    payload_path, mutated_doc = _n5_mutated_payload(fixture, root)
    stage_build(case_dir, fixture, None, payload_path=payload_path)
    stage_snapshot(case_dir, fixture, None)
    stage_bands(case_dir, fixture, None)

    bands = load_json(os.path.join(case_dir, "bands.json")) or {}
    b_n5 = bands_pitch_B(bands)
    b_n5_source = "mutated-N5（bands.pitch.B）"
    if b_n5 is None:
        ref_bands = load_json(os.path.join(ref_case_dir(fixture), "bands.json")) or {}
        b_n5 = bands_pitch_B(ref_bands)
        b_n5_source = "reference-fallback（N5 变异页 pitch.B 缺失）"
    measured = stage_derive(case_dir, fixture, b_n5, None,
                            payload_doc=mutated_doc, fixture_md=dst_fixture)

    ensure_root(work)
    gates_path = negative_artifact("N5", "gates.json")
    cmd = [sys.executable, "-I", PREFLIGHT, "gates",
           "--fixture", fixture, "--work", work,
           "--baseline", BASELINE, "--expect", EXPECT,
           "--fixtures-dir", tmp_fixtures, "--json-out", gates_path]
    rc, _ = run_cmd(cmd, negative_artifact("N5", "gates.log"))
    gates = load_json(gates_path)
    if not isinstance(gates, dict):
        raise CaseError("negative", "N5 preflight gates 没有产出 gates.json（exit %d）" % rc,
                        [negative_artifact("N5", "gates.log")], cmd=cmd, rc=rc,
                        log_path=negative_artifact("N5", "gates.log"))

    def gate_of(gate_id):
        for entry in gates.get("gates") or []:
            if entry.get("id") == gate_id:
                return entry
        return None

    gate05 = gate_of("P-ENV-05")
    gate06 = gate_of("P-ENV-06")

    def check_status(gate, name):
        for check in (gate or {}).get("checks") or []:
            if check.get("name") == name:
                return check.get("status")
        return None

    sha_failed = check_status(gate05, "夹具 SHA 与期望") == "fail"
    kinds_failed = check_status(gate05, "块种类序列") == "fail"
    boxes_status = check_status(gate06, "DOM 行盒数")
    expect = load_json(EXPECT)
    entry = (expect or {}).get(fixture + ".md") or {}
    expected_boxes = entry.get("dom_line_boxes")
    current_boxes = ((measured.get("dom") or {}).get("line_boxes"))
    boxes_changed = (expected_boxes is not None and current_boxes is not None
                     and current_boxes != expected_boxes)
    gate05_status = (gate05 or {}).get("status")

    # 必须红：P-ENV-05 红，且**块种类序列**这一子项确实红（不是只看 SHA）。
    # 允许连带红：DOM 行盒数（P-ENV-06）变 > 1 行；同样要求它真的被观测到。
    red = (gate05_status == "fail" and kinds_failed and boxes_changed
           and boxes_status in ("fail", "product-change"))
    status = "red" if red else "expectation-fail"
    code = 0 if red else 10
    other = {
        entry.get("id"): entry.get("status")
        for entry in gates.get("gates") or []
        if entry.get("id") != "P-ENV-05"
    }
    # bug/0240：负对照跑闸门时也要落越界红；P-ENV-06（行盒数）是本轮声明的
    # 允许连带红，其余非预期 fail 只记录、不改 N5 的结论口径。
    allowed_collateral = {"P-ENV-06"}
    unexpected_gate_reds = [
        {"id": cid, "status": status}
        for cid, status in sorted(other.items())
        if status == "fail" and cid not in allowed_collateral
    ]
    return neg_result(
        "N5", status, code,
        reason=None if red else "N5-remeasure-did-not-red-block-kinds-or-line-boxes",
        expectation="P-ENV-05 红（块种类序列变）；DOM 行盒数变（P-COV-02 允许连带红）",
        must_red=[{
            "id": "P-ENV-05",
            "status": "red" if gate05_status == "fail" else "green",
            "detail": {"block_kinds_check": kinds_failed, "sha_check": sha_failed},
        }],
        must_green=[{
            "id": "MEASURED-RECOMPUTED",
            "status": "pass",
            "detail": "本轮重新构页/取像/派生，⛔ 不复制参考页产物",
        }],
        allowed_red_observed=[{
            "id": "P-ENV-06.dom_line_boxes",
            "status": "red" if boxes_changed else "not-observed",
            "detail": {"expected": expected_boxes, "current": current_boxes},
        }],
        unexpected_red=unexpected_gate_reds,
        isolation={
            "evaluated": True,
            "allowed_collateral_red": sorted(allowed_collateral),
            "gate_count": len(gates.get("gates") or []),
        },
        evidence=[{
            "fixture": fixture,
            "mutated_fixture": dst_fixture,
            "mutated_payload": payload_path,
            "measured_recomputed_this_run": True,
            "measured_generated_at": measured.get("generated_at"),
            "b_source": b_n5_source,
            "b_value": b_n5,
            "P-ENV-05": gate05_status,
            "P-ENV-05_checks": (gate05 or {}).get("checks"),
            "sha_check_failed": sha_failed,
            "block_kinds_check_failed": kinds_failed,
            "expected_dom_line_boxes": expected_boxes,
            "current_dom_line_boxes": current_boxes,
            "dom_line_boxes_delta": (None if expected_boxes is None
                                     or current_boxes is None
                                     else current_boxes - expected_boxes),
            "P-ENV-06": (gate06 or {}).get("status"),
            "P-ENV-06_checks": (gate06 or {}).get("checks"),
            "other_gates": other,
        }],
        notes=[
            "bug/0155：N5 改为「变异夹具/载荷副本 ⇒ 重新构页取像 ⇒ 重新派生 ⇒ 跑闸门」，"
            "⛔ 不再复制参考页的 measured/snapshot/frame/bands/roi。",
            "判红条件从「SHA 子项 fail」改为「块种类序列 fail 且 DOM 行盒数实测变化」，"
            "SHA 只是顺带的第二证据。",
            "验证鉴别力的元测试：把 gate_05 的块种类子项改成恒 pass，本负对照必须 "
            "变成 expectation-fail（见 bug/0155 §7 与 .agent/l2-fix-D.md）。",
        ],
        case_dir=root,
    )


def negative_n6():
    fixture = "00-body" if os.path.isdir(ref_case_dir("00-body")) else NEG_FIXTURE
    ref_dir = ref_case_dir(fixture)
    page = os.path.join(ref_dir, "page")
    eval_file = os.path.join(page, "__l2-eval.js")
    root = prepare_negative_root("N6")
    if not os.path.isdir(page):
        raise CaseError("negative", "参考页目录不存在：%s" % page, [page])

    runs = {}
    for dpr in (1, 2):
        out = negative_artifact("N6", "dpr%d.png" % dpr)
        dom_out = negative_artifact("N6", "dpr%d-dom.json" % dpr)
        # bug/0125：`--dpr` 是期望值，不符即 exit 64；N6 必须配 `--force-scale`
        # 才会真的按 1×/2× 重新栅格化（⛔ 不是把 2× 图降采样）。
        cmd = [SNAP_BIN, "--page", page, "--out", out,
               "--width", fmt_num(CANVAS_W), "--height", fmt_num(CANVAS_H),
               "--dpr", fmt_num(dpr), "--force-scale", fmt_num(dpr),
               "--eval-file", eval_file,
               "--json", dom_out, "--timeout", str(TIMEOUT)]
        if DRY:
            plan_cmd(cmd)
            continue
        rc, stdout = run_cmd(cmd, negative_artifact("N6", "dpr%d.log" % dpr),
                             capture=True)
        parsed = parse_stdout_lines(stdout)
        runs[dpr] = {
            "exit": rc,
            "png": out,
            "size": png_size(out) if os.path.isfile(out) else None,
            "dpr_line": parsed.get("dpr"),
            "ready": parsed.get("ready"),
            "force_scale": dpr,
        }
    if DRY:
        return neg_result("N6", "planned", 0, evidence=[], notes=[],
                          case_dir=root)

    expected_widths = {d: int(round(d * CANVAS_W)) for d in (1, 2)}
    widths = {dpr: (runs[dpr]["size"] or [None, None])[0] for dpr in runs}
    width_ok = all(widths.get(d) == expected_widths[d] for d in (1, 2))
    run_errors = [d for d in (1, 2) if runs[d]["exit"] != 0]

    band_runs = {}
    for dpr in (1, 2):
        png = runs[dpr]["png"]
        dom_path = negative_artifact("N6", "dpr%d-dom.json" % dpr)
        dom = load_json(dom_path) if os.path.isfile(dom_path) else None
        if not os.path.isfile(png) or not isinstance(dom, dict):
            band_runs[dpr] = {"status": "unavailable",
                              "reason": "缺 PNG 或 dom.json"}
            continue
        doc_env = (((dom.get("dom") or {}).get("doc") or {}).get("env") or {})
        viewport = (dom.get("dom") or {}).get("viewport") or {}
        left = num_any(doc_env.get("content_box_left_px"))
        right = num_any(doc_env.get("content_box_right_px"))
        top = num_any(doc_env.get("content_box_top_px"))
        bottom = num_any(doc_env.get("content_box_bottom_px"))
        size = png_size(png) or [0, 0]
        roi_warnings = []
        if None in (left, right):
            band_runs[dpr] = {"status": "unavailable",
                              "reason": "DOM 缺 content box 左右缘"}
            continue
        if None in (top, bottom):
            top, bottom = 0.0, float(size[1])
            roi_warnings.append("roi-fallback:viewport（缺 content box 纵向边界）")
        roi = {
            "content_box": {
                "left": left * dpr,
                "right": right * dpr,
                "top": round(top * dpr),
                "bottom": round(bottom * dpr),
            },
            "source": "content_box" if not roi_warnings else "viewport",
            "unit": "device_px",
            "dpr": dpr,
            "warnings": roi_warnings,
            "context": "N6 dpr%d" % dpr,
        }
        roi_path = negative_artifact("N6", "dpr%d-roi.json" % dpr)
        bands_path = negative_artifact("N6", "dpr%d-bands.json" % dpr)
        write_json(roi_path, roi)
        rc, _ = run_cmd([sys.executable, "-I", BANDS,
                         "--png", png, "--roi", roi_path, "--json", bands_path],
                        negative_artifact("N6", "dpr%d-bands.log" % dpr))
        data = load_json(bands_path)
        if rc != 0 or not isinstance(data, dict):
            band_runs[dpr] = {"status": "unavailable",
                              "reason": "bands.py 退出 %d" % rc}
            continue
        items = data.get("bands") or []
        band_runs[dpr] = {
            "status": "ok",
            "band_count": data.get("band_count"),
            "tops": [num_any(item.get("top")) for item in items],
            "pitch_B": bands_pitch_B(data),
            "pitch_B_source": (data.get("pitch") or {}).get("B_source"),
            "roi": roi_path,
            "bands": bands_path,
        }

    count_same = (band_runs[1].get("band_count") is not None
                  and band_runs[1].get("band_count") == band_runs[2].get("band_count"))
    center_diffs = []
    if count_same:
        for top1, top2 in zip(band_runs[1].get("tops") or [],
                              band_runs[2].get("tops") or []):
            if top1 is None or top2 is None:
                center_diffs.append(None)
            else:
                center_diffs.append(abs(top2 - 2.0 * top1))
    centers_same = bool(center_diffs) and all(
        v is not None and v <= 3.0 for v in center_diffs)
    bands_ok = count_same and centers_same
    # bug/0240：N6 的判据是 green 侧（宽度/行带不变），显式进 must 口径。
    n6_must_green = [{
        "id": "PNG-WIDTH",
        "status": "pass" if width_ok else "fail",
        "expected": expected_widths,
        "observed": widths,
    }, {
        "id": "BAND-SEQUENCE",
        "status": "pass" if bands_ok else "fail",
        "detail": {"count_same": count_same, "centers_same": centers_same},
    }]

    evidence = [{
        "fixture": fixture,
        "runs": runs,
        "expected_widths": expected_widths,
        "width_ok": width_ok,
        "force_scale": {1: 1, 2: 2},
        "band_runs": band_runs,
        "band_count_same": count_same,
        "center_diffs_x2": center_diffs,
        "centers_tolerance_px": 3.0,
        "bands_ok": bands_ok,
    }]
    notes = [
        "bug/0125：两轮均传 --force-scale <dpr>，按 1×/2× 真实重新栅格化；"
        "⛔ 不再用硬编码 2.0×CANVAS_W 判宽度。",
        "宽度判据：每轮 dpr × CANVAS_W（%s）。" % expected_widths,
        "行带比较按 2× 归一化（dpr2.top vs 2 × dpr1.top），容差 3 px。",
    ]
    if run_errors:
        return neg_result(
            "N6", "expectation-fail", 10,
            expectation="两种 DPR 下宽度断言都成立、行带序列与带数不变",
            evidence=evidence,
            notes=notes + ["取像失败（exit≠0）的轮次：%s；N6 未真正施加。" % run_errors],
            reason="snapshot-failed",
            must_green=n6_must_green,
            case_dir=root,
        )
    if not width_ok:
        return neg_result(
            "N6", "expectation-fail", 10,
            expectation="两种 DPR 下宽度断言都成立、行带序列与带数不变",
            evidence=evidence,
            notes=notes + ["宽度不符：实测 %s，期望 %s" % (widths, expected_widths)],
            reason="width-assertion-failed",
            must_green=n6_must_green,
            case_dir=root,
        )
    if not bands_ok:
        return neg_result(
            "N6", "partial", 10,
            expectation="两种 DPR 下宽度断言都成立、行带序列与带数不变",
            evidence=evidence,
            notes=notes + ["行带序列/带数未通过：count_same=%s centers_same=%s"
                           % (count_same, centers_same)],
            reason="band-sequence-changed",
            must_green=n6_must_green,
            case_dir=root,
        )
    return neg_result(
        "N6", "red", 0,
        expectation="两种 DPR 下宽度断言都成立、行带序列与带数不变",
        evidence=evidence,
        notes=notes,
        must_green=n6_must_green,
        case_dir=root,
    )


def negative_n7():
    fixture = "00-body" if os.path.isdir(ref_case_dir("00-body")) else NEG_FIXTURE
    ref_dir = ref_case_dir(fixture)
    frame = require_ref_file(fixture, "frame.png")
    roi = load_json(os.path.join(ref_dir, "roi.json"), required=True)
    ref_measured = load_json(os.path.join(ref_dir, "measured.json"), required=True)
    ref_bands = load_json(os.path.join(ref_dir, "bands.json"), required=True)
    # bug/0243：目标尺寸与缩放系数由画布/DPR 推导，⛔ 不再写死 801×1000 和 /2.0。
    # N7 模拟「snapshotWidth 把 pt 当 px」：目标宽高 = CANVAS_W/H（pt 数值即 px）。
    target_w = int(round(CANVAS_W))
    target_h = int(round(CANVAS_H))
    ref_size = png_size(frame) or [None, None]
    ref_dpr = num_any((ref_measured.get("env") or {}).get("dpr")) or DPR
    if not ref_size[0] or not ref_size[1] or not ref_dpr or ref_dpr <= 0:
        raise CaseError("negative",
                        "N7 无法推导缩放系数（ref_size=%s，DPR=%s）"
                        % (ref_size, ref_dpr), [frame])
    scale_x = float(ref_size[0]) / target_w
    scale_y = float(ref_size[1]) / target_h
    root = prepare_negative_root("N7")
    work = os.path.join(root, "work")
    if not DRY:
        os.makedirs(os.path.join(work, fixture), exist_ok=True)
        ensure_root(work)

    if shutil.which("sips") is None:
        return neg_result(
            "N7", "unsupported", 30,
            expectation="P-ENV-01 宽度断言红（≈%d px ≠ %d px）；行带序列与带数不变"
                        % (target_w, ref_size[0]),
            evidence=[{"reason": "缺 sips，无法把 %d px 图降为 %d px"
                                 % (ref_size[0], target_w)}],
            notes=["⛔ 不伪造降采样图。"],
            case_dir=root,
        )

    scaled_png = os.path.join(work, fixture, "frame.png")
    cmd = ["sips", "-z", str(target_h), str(target_w), frame, "--out", scaled_png]
    if DRY:
        plan_cmd(cmd)
        return neg_result("N7", "planned", 0, evidence=[], notes=[],
                          case_dir=root)
    rc, _ = run_cmd(cmd, negative_artifact("N7", "sips.log"))
    size = png_size(scaled_png)
    if rc != 0 or not size or size[0] != target_w or size[1] != target_h:
        raise CaseError("negative", "sips 未产出 %d×%d PNG（exit %d, size=%s）"
                        % (target_w, target_h, rc, size),
                        [scaled_png, negative_artifact("N7", "sips.log")],
                        cmd=cmd, rc=rc,
                        log_path=negative_artifact("N7", "sips.log"))

    scaled_roi = json.loads(json.dumps(roi))
    for key in ("left", "right", "top", "bottom"):
        if num((scaled_roi.get("content_box") or {}).get(key)) is not None:
            axis = scale_x if key in ("left", "right") else scale_y
            scaled_roi["content_box"][key] = num(scaled_roi["content_box"][key]) / axis
    scaled_roi["source"] = ("N7：把 %d px 图按 1/%s 降采样为 %d px 后的 ROI"
                            % (ref_size[0], fmt_num(scale_x), target_w))
    roi_path = os.path.join(work, fixture, "roi.json")
    bands_path = os.path.join(work, fixture, "bands.json")
    write_json(roi_path, scaled_roi)
    rc, _ = run_cmd([sys.executable, "-I", BANDS, "--png", scaled_png,
                     "--roi", roi_path, "--json", bands_path],
                    negative_artifact("N7", "bands.log"))
    scaled_bands = load_json(bands_path)
    if not isinstance(scaled_bands, dict):
        raise CaseError("negative", "N7 bands.py 没有产出 bands.json", [bands_path])

    # measured：只替换 png / png_size / bands，env 保持 DPR 2、W_canvas 1000。
    measured = json.loads(json.dumps(ref_measured))
    measured["png"] = "frame.png"
    measured["png_size"] = [size[0], size[1]]
    count = scaled_bands.get("band_count")
    measured["bands"] = {
        "count": count,
        "band_count": count,
        "items": scaled_bands.get("bands") or [],
        "spacing_cv": (scaled_bands.get("pitch") or {}).get("cv"),
    }
    measured["primary_count"] = count
    # bug/0179：N7 只有一张降采样图，没有独立的备份路径实测。
    # ⛔ 不再把 backup_count 伪造成与主路相同、diff 伪造成 0；缺的就说缺。
    measured["backup_count"] = None
    measured["primary_backup_count_diff"] = None
    measured["primary_backup_comparison"] = {
        "primary": count,
        "backup": None,
        "diff": None,
        "reason": "N7-only-one-downsampled-frame: no independent backup path",
    }
    measured["notes"] = [
        "N7：模拟 snapshotWidth 把 pt 当 px（目标 %d×%d、漏乘 DPR=%s）的产物。"
        % (target_w, target_h, fmt_num(ref_dpr))]
    write_json(os.path.join(work, fixture, "measured.json"), measured)

    snap_path = os.path.join(ref_dir, "snapshot.json")
    if os.path.isfile(snap_path):
        shutil.copyfile(snap_path, os.path.join(work, fixture, "snapshot.json"))

    gates_path = negative_artifact("N7", "gates.json")
    cmd = [sys.executable, "-I", PREFLIGHT, "gates",
           "--fixture", fixture, "--work", work,
           "--baseline", BASELINE, "--expect", EXPECT,
           "--fixtures-dir", FIXTURES_DIR, "--json-out", gates_path]
    rc, _ = run_cmd(cmd, negative_artifact("N7", "gates.log"))
    gates = load_json(gates_path)
    if not isinstance(gates, dict):
        raise CaseError("negative", "N7 preflight gates 没有产出 gates.json", [gates_path])

    width_check = None
    backup_check = None
    for gate in gates.get("gates") or []:
        if gate.get("id") != "P-ENV-01":
            continue
        for check in gate.get("checks") or []:
            if check.get("name") == "宽度断言":
                width_check = check
            elif check.get("name") == "主/备两路带数差":
                backup_check = check
    width_failed = (width_check or {}).get("status") == "fail"

    ref_items = ref_bands.get("bands") or []
    new_items = scaled_bands.get("bands") or []
    count_same = len(ref_items) == len(new_items)
    center_diffs = []
    for index in range(min(len(ref_items), len(new_items))):
        ref_top = num(ref_items[index].get("top"))
        new_top = num(new_items[index].get("top"))
        if ref_top is None or new_top is None:
            center_diffs.append(None)
        else:
            center_diffs.append(abs(ref_top - scale_y * new_top))
    centers_same = bool(center_diffs) and all(
        value is not None and value <= 2.0 for value in center_diffs)
    bands_green = count_same and centers_same
    # bug/0240：N7 跑闸门，必须红=P-ENV-01 宽度；其余非预期 fail 只记录，⛔ 不改口径。
    other_gates = {
        gate.get("id"): gate.get("status")
        for gate in gates.get("gates") or []
        if gate.get("id") != "P-ENV-01"
    }
    unexpected_gate_reds = [
        {"id": cid, "status": status}
        for cid, status in sorted(other_gates.items())
        if status == "fail"
    ]

    if width_failed and bands_green:
        status, code = "red", 0
    elif not width_failed:
        status, code = "expectation-fail", 10
    else:
        status, code = "partial", 10

    return neg_result(
        "N7", status, code,
        expectation="P-ENV-01 宽度断言红（≈%d px ≠ %d px）；行带序列与带数不变"
                    % (target_w, ref_size[0]),
        must_red=[{
            "id": "P-ENV-01.width",
            "status": "red" if width_failed else "green",
            "check": width_check,
        }],
        must_green=[{
            "id": "BAND-SEQUENCE",
            "status": "pass" if bands_green else "fail",
            "detail": {"count_same": count_same, "centers_same": centers_same},
        }],
        unexpected_red=unexpected_gate_reds,
        isolation={
            "evaluated": True,
            "gate_count": len(gates.get("gates") or []),
        },
        evidence=[{
            "fixture": fixture,
            "png_size": size,
            "declared_env": measured.get("env"),
            "width_check": width_check,
            "width_failed": width_failed,
            "backup_count_check": backup_check,
            "primary_backup_comparison": measured.get("primary_backup_comparison"),
            "band_count_ref": len(ref_items),
            "band_count_n7": len(new_items),
            "count_same": count_same,
            "center_diffs_x2": center_diffs,
            "centers_same": centers_same,
            "gates_file": gates_path,
        }],
        notes=["%d×%d PNG 由 sips 从 %d×%d 参考帧按 1/%s 降采样得到；"
               "它不是 l2-snapshot 的真实产物，但形状与『snapshotWidth 当 px』一致。"
               % (target_w, target_h, ref_size[0], ref_size[1], fmt_num(scale_x)),
               "行带比较按实际缩放 %s 归一化（N7 top × %s vs 参考 top），容差 2 px。"
               % (fmt_num(scale_y), fmt_num(scale_y)),
               "bug/0179：本负对照没有独立备份路径，主/备带数差如实记 skipped"
               "（⛔ 不再伪造 backup_count=primary_count、diff=0）。"],
        case_dir=root,
    )


NEGATIVE_RUNNERS = {
    "N1": negative_n1,
    "N2": negative_n2,
    "N3": negative_n3,
    "N4": negative_n4,
    "N5": negative_n5,
    "N6": negative_n6,
    "N7": negative_n7,
}


def run_negative(nid):
    # bug/0178：非 CaseError 异常此前逃出 runner，整个进程以 1 + traceback 退出，
    # 结果 JSON 没有该负对照的任何记录。现在统一收敛成 error/4 并保留类型与栈；
    # KeyboardInterrupt/SystemExit 仍按控制流向上抛。
    try:
        return NEGATIVE_RUNNERS[nid]()
    except (KeyboardInterrupt, SystemExit):
        raise
    except CaseError as exc:
        return neg_result(
            nid, "error", 4,
            expectation="见 §7.2 负对照表",
            evidence=[],
            notes=[exc.detail],
            error=exc.as_dict(),
            case_dir=neg_root(nid),
        )
    except Exception as exc:
        detail = "%s: %s" % (type(exc).__name__, exc)
        return neg_result(
            nid, "error", 4,
            expectation="见 §7.2 负对照表",
            evidence=[],
            notes=["未捕获异常 ⇒ 记内部错误，⛔ 不当作未验证或通过：" + detail],
            error={
                "stage": "negative",
                "kind": type(exc).__name__,
                "detail": detail,
                "traceback": traceback.format_exc(),
            },
            case_dir=neg_root(nid),
        )


# ── dry-run：只校验契约与打印命令序列，⛔ 不执行 ──────────────────────

def dry_validate():
    problems = []
    required = [
        (BUILD, "build-l2-page.sh"),
        (SNAP_SWIFT, "l2-snapshot.swift"),
        (BANDS, "bands.py"),
        (PROBE, "dom-probe.js"),
        (PREFLIGHT, "preflight.py"),
        (CHECK, "l2-check.sh"),
        (MUT_PY, "mutations.py"),
        (FIXTURES_JSON, ".work/fixtures.json（Stage A 载荷）"),
        (EXPECT, "fixtures-expect.json"),
    ]
    for path, label in required:
        if not os.path.isfile(path):
            problems.append("缺 %s（%s）" % (label, path))
    if os.path.isfile(BUILD) and not os.access(BUILD, os.X_OK):
        problems.append("build-l2-page.sh 不可执行")
    if not os.path.isdir(FIXTURES_DIR):
        problems.append("缺夹具目录 %s" % FIXTURES_DIR)

    def read(path):
        try:
            return open(path, encoding="utf-8").read()
        except OSError:
            return ""

    probe = read(PROBE)
    if "__PARITY_DOM" not in probe:
        problems.append("dom-probe.js 未暴露 window.__PARITY_DOM")
    snap = read(SNAP_SWIFT)
    for marker in ("--page", "--out", "--dpr", "--eval-file", "--json"):
        if marker not in snap:
            problems.append("l2-snapshot.swift 缺契约参数 %s" % marker)
    bands_src = read(BANDS)
    if "--threshold" not in bands_src:
        problems.append("bands.py 缺 --threshold（N2 需要）")
    preflight_src = read(PREFLIGHT)
    for marker in ("gates", "compare"):
        if marker not in preflight_src:
            problems.append("preflight.py 缺 %s 子命令" % marker)
    check_src = read(CHECK)
    for marker in ("--fixture", "--work"):
        if marker not in check_src:
            problems.append("l2-check.sh 缺参数 %s" % marker)

    expect = load_json(EXPECT)
    expect_keys = set(expect.keys()) if isinstance(expect, dict) else set()
    for fixture in REF_FIXTURES:
        md = os.path.join(FIXTURES_DIR, fixture + ".md")
        if not os.path.isfile(md):
            problems.append("缺夹具文件 %s" % md)
        if expect_keys and (fixture + ".md") not in expect_keys:
            problems.append("fixtures-expect.json 缺 %s.md" % fixture)

    for mid in SELECTED_MUTATIONS:
        mutation = MUT_BY_ID.get(mid) or {}
        if not mutation.get("css"):
            problems.append("%s 没有注入 CSS" % mid)

    if problems:
        for problem in problems:
            err(problem)
        die3("dry-run 校验失败：缺 %d 项契约/依赖" % len(problems))

    log("✔ 依赖与契约字段校验通过")
    log("  baseline.json：%s"
        % (BASELINE if os.path.isfile(BASELINE)
           else "不存在（-PARITY 会记 skipped(no-baseline)，⛔ 不假绿）"))


def plan_bands(case_dir):
    frame = os.path.join(case_dir, "frame.png")
    roi = os.path.join(case_dir, "roi.json")
    log("[dry-run]   write %s  # content_box 由 L2-DOM 现测，⛔ 不写常量" % roi)
    plan_cmd([sys.executable, "-I", BANDS,
              "--png", frame, "--roi", roi,
              "--json", os.path.join(case_dir, "bands.json")])
    # bug/0213：实跑只在取像交付了与主帧不同的备份 PNG 时才度量备份帧
    # （stage_bands 的 backup_png 分支）。dry-run 无法预知交付结果，所以这里
    # 标成条件步骤，⛔ 不让计划把「一定执行」写死。
    log("[dry-run]   # 仅当 snapshot.backup.path 存在且 ≠ 主帧时：")
    plan_cmd([sys.executable, "-I", BANDS,
              "--png", os.path.join(case_dir, "frame-backup.png"),
              "--roi", roi,
              "--json", os.path.join(case_dir, "bands-backup.json")])


def plan_case(case_dir, fixture, mut_id=None):
    stage_build(case_dir, fixture, mut_id)
    stage_snapshot(case_dir, fixture, mut_id)
    plan_bands(case_dir)
    log("[dry-run]   # 派生 metrics + spec_checks → %s"
        % os.path.join(case_dir, "measured.json"))
    if mut_id:
        stage_mutation_preflight(case_dir, fixture, mut_id)
    else:
        stage_reference_check(case_dir, fixture)


def plan_negative(nid):
    root = neg_root(nid)
    log("[dry-run] ── 负对照 %s：%s" % (nid, NEGATIVE_TITLES[nid]))
    if nid == "N1":
        log("[dry-run]   write %s/roi-shifted.json（参考 ROI 平移 +10 px）" % root)
        plan_cmd([sys.executable, "-I", BANDS,
                  "--png", os.path.join(ref_case_dir(NEG_FIXTURE), "frame.png"),
                  "--roi", os.path.join(root, "roi-shifted.json"),
                  "--json", os.path.join(root, "bands-shifted.json")])
        log("[dry-run]   # 逐带比较 left/right/top/bottom/height：像素派生量必须红；"
            "DOM 派生量登记为不受影响（bug/0134）")
    elif nid == "N2":
        planned = False
        for fixture in ("06a-table", "12-task", "00-body"):
            case = ref_case_dir(fixture)
            if not os.path.isdir(case):
                continue
            planned = True
            for threshold in (32, 40, 160):
                plan_cmd([sys.executable, "-I", BANDS,
                          "--png", os.path.join(case, "frame.png"),
                          "--roi", os.path.join(case, "roi.json"),
                          "--threshold", str(threshold),
                          "--json", os.path.join(
                              root, "%s-bands-t%d.json" % (fixture, threshold))])
        if not planned:
            log("[dry-run]   # 无可用参考页（06a-table/12-task/00-body）⇒ 会记 unverified/30")
        log("[dry-run]   # 带数差仅作灵敏度证据；P-ENV-01 无期望带数 ⇒ 记 unsupported/30")
    elif nid == "N3":
        log("[dry-run]   # 缺 baseline.json 时记 unsupported；不执行")
    elif nid == "N4":
        log("[dry-run]   # skipped(reason=no-runner)：§7.1 没有 L1 runner，"
            "结果 JSON 显式记 skipped/30（bug/0161）")
    elif nid == "N5":
        page_dir = os.path.join(root, "work", NEG_FIXTURE, "page")
        plan_cmd(["cp", os.path.join(FIXTURES_DIR, NEG_FIXTURE + ".md"),
                  os.path.join(root, "fixtures", NEG_FIXTURE + ".md")])
        log("[dry-run]   # 追加一行到夹具副本（⛔ 不改 fixtures/ 原文件）")
        log("[dry-run]   write %s（Stage A 载荷副本：html/text/blocks 同步增）"
            % os.path.join(root, "fixtures-n5.json"))
        plan_cmd(["rm", "-rf", page_dir])
        plan_cmd([BUILD, NEG_FIXTURE, page_dir,
                  "--fixtures-json", os.path.join(root, "fixtures-n5.json"),
                  "--sidebar-width", fmt_num(SIDEBAR)])
        plan_cmd(["cp", PROBE, os.path.join(page_dir, "__dom-probe.js")])
        log("[dry-run]   write %s" % os.path.join(page_dir, "__l2-extras.js"))
        log("[dry-run]   write %s" % os.path.join(page_dir, "__l2-eval.js"))
        log("[dry-run]   patch %s" % os.path.join(page_dir, "index.html"))
        plan_cmd([SNAP_BIN, "--page", page_dir,
                  "--out", os.path.join(root, "work", NEG_FIXTURE, "frame.png"),
                  "--width", fmt_num(CANVAS_W), "--height", fmt_num(CANVAS_H),
                  "--dpr", fmt_num(DPR),
                  "--eval-file", os.path.join(page_dir, "__l2-eval.js"),
                  "--json", os.path.join(root, "work", NEG_FIXTURE, "dom.json"),
                  "--timeout", str(TIMEOUT)])
        plan_cmd([sys.executable, "-I", BANDS,
                  "--png", os.path.join(root, "work", NEG_FIXTURE, "frame.png"),
                  "--roi", os.path.join(root, "work", NEG_FIXTURE, "roi.json"),
                  "--json", os.path.join(root, "work", NEG_FIXTURE, "bands.json")])
        log("[dry-run]   # 用变异载荷与夹具副本重新派生 measured.json（⛔ 不复制旧产物）")
        plan_cmd([sys.executable, "-I", PREFLIGHT, "gates",
                  "--fixture", NEG_FIXTURE,
                  "--work", os.path.join(root, "work"),
                  "--baseline", BASELINE, "--expect", EXPECT,
                  "--fixtures-dir", os.path.join(root, "fixtures"),
                  "--json-out", os.path.join(root, "gates.json")])
        log("[dry-run]   # 必须红：P-ENV-05（块种类序列）；DOM 行盒数须实测变化")
    elif nid == "N6":
        for dpr in (1, 2):
            plan_cmd([SNAP_BIN, "--page", os.path.join(ref_case_dir("00-body"), "page"),
                      "--out", os.path.join(root, "dpr%d.png" % dpr),
                      "--width", fmt_num(CANVAS_W), "--height", fmt_num(CANVAS_H),
                      "--dpr", fmt_num(dpr), "--force-scale", fmt_num(dpr),
                      "--eval-file", os.path.join(ref_case_dir("00-body"), "page", "__l2-eval.js"),
                      "--json", os.path.join(root, "dpr%d-dom.json" % dpr),
                      "--timeout", str(TIMEOUT)])
            plan_cmd([sys.executable, "-I", BANDS,
                      "--png", os.path.join(root, "dpr%d.png" % dpr),
                      "--roi", os.path.join(root, "dpr%d-roi.json" % dpr),
                      "--json", os.path.join(root, "dpr%d-bands.json" % dpr)])
        log("[dry-run]   # 每轮宽度判据 dpr × CANVAS_W；行带序列按 2× 归一化比较")
    elif nid == "N7":
        # bug/0243：目标尺寸跟随画布，⛔ 不写死 1000×801。
        plan_cmd(["sips", "-z", str(int(round(CANVAS_H))),
                  str(int(round(CANVAS_W))),
                  os.path.join(ref_case_dir("00-body"), "frame.png"),
                  "--out", os.path.join(root, "work", "00-body", "frame.png")])
        plan_cmd([sys.executable, "-I", BANDS,
                  "--png", os.path.join(root, "work", "00-body", "frame.png"),
                  "--roi", os.path.join(root, "work", "00-body", "roi.json"),
                  "--json", os.path.join(root, "work", "00-body", "bands.json")])
        plan_cmd([sys.executable, "-I", PREFLIGHT, "gates",
                  "--fixture", "00-body",
                  "--work", os.path.join(root, "work"),
                  "--baseline", BASELINE, "--expect", EXPECT,
                  "--fixtures-dir", FIXTURES_DIR,
                  "--json-out", os.path.join(root, "gates.json")])
        # bug/0243：期望文本也按画布推导，⛔ 不写死 1000/2×1000。
        _n7_w = int(round(CANVAS_W))
        log("[dry-run]   # 期望 P-ENV-01 宽度断言红（%d ≠ %s×%d）"
            % (_n7_w, fmt_num(DPR) if DPR_EXPLICIT else "DPR",
               _n7_w))


def dry_run():
    log("════════════════════════════════════════════════════════════════════")
    log("L2 跑批计划（dry-run，⛔ 不执行任何构页/取像/度量）")
    log("  work        : %s" % WORK)
    log("  result      : %s" % OUT)
    log("  fixtures    : %s" % ", ".join(FIXTURES))
    log("  mutations   : %s" % (", ".join(SELECTED_MUTATIONS) or "—"))
    log("  negatives   : %s" % (", ".join(SELECTED_NEGATIVES) or "—"))
    log("  sidebar     : %s pt" % fmt_num(SIDEBAR))
    log("  DPR         : %s" % ("显式 %s" % fmt_num(DPR) if DPR_EXPLICIT
                                else "auto（取 l2-snapshot 实测 px/pt）"))
    log("  canvas      : %s × %s pt ⇒ %s × %s px（显式 DPR 时）"
        % (fmt_num(CANVAS_W), fmt_num(CANVAS_H),
           int(round(DPR * CANVAS_W)), int(round(DPR * CANVAS_H))))
    log("  载荷 provenance: build_id=%s ↔ %s"
        % (BUILD_ID_CHECK.get("payload_build_id"), BUILD_ID_CHECK.get("build_id")))
    log("  B 来源      : 参考页 00-body 的 bands.pitch.B；每个变异页另测自己的 B")
    log("════════════════════════════════════════════════════════════════════")
    dry_validate()

    for fixture in REF_FIXTURES:
        role = "辅助" if fixture in AUX_FIXTURES else "参考"
        log("")
        log("[dry-run] ── %s页 %s" % (role, fixture))
        plan_case(ref_case_dir(fixture), fixture, None)

    for mid in SELECTED_MUTATIONS:
        log("")
        log("[dry-run] ══ 变异 %s：%s" % (mid, MUT_BY_ID[mid].get("title")))
        ensure_root(mut_root(mid))
        log("[dry-run] ── 变异辅助页 00-body（用于该环境的 B）")
        plan_case(mut_case_dir(mid, "00-body"), "00-body", mid)
        for fixture in FIXTURES:
            if fixture == "00-body":
                continue
            log("[dry-run] ── 变异页 %s × %s" % (mid, fixture))
            plan_case(mut_case_dir(mid, fixture), fixture, mid)

    for nid in SELECTED_NEGATIVES:
        plan_negative(nid)

    log("")
    log("dry-run 总结：%d 个参考页、%d 个变异、%d 个负对照；未执行任何命令。"
        % (len(REF_FIXTURES), len(SELECTED_MUTATIONS), len(SELECTED_NEGATIVES)))
    return 0


# ── 汇总与退出码 ────────────────────────────────────────────────────────

def pick_exit(codes):
    """汇总退出码（bug/0144）。

    ⛔ 不把 15（产品排版变更）并进 10（产品不匹配）：两者判因不同，合并会让
    「产品改版需人工确认」看起来像「判据不匹配」。优先级：
    4（内部错误）> 20（环境无效）> 15（产品排版变更）> 10（不匹配／期望失败）
    > 30（未完成／未验证）> 0。

    15 高于 10 的理由：参考页一旦判 15，变异面是建立在「已重生成的基线」上的，
    应先把产品变更交给人确认。两者同时出现时具体数值见结果 JSON 的 `exit_reasons`。

    bug/0216：任何未知/None 退出码（负对照抛非 CaseError、子进程被信号杀死等）
    按内部错误 4 处理，⛔ 不落进 `return 0` 的默认通过。
    """
    known = {0, 4, 10, 15, 20, 30}
    for code in codes:
        if not isinstance(code, int) or code not in known:
            return 4
    if 4 in codes:
        return 4
    if 20 in codes:
        return 20
    if 15 in codes:
        return 15
    if 10 in codes:
        return 10
    if 30 in codes:
        return 30
    return 0


CODE_LABELS = {
    0: "PASS",
    4: "INTERNAL-ERROR",
    10: "MISMATCH",
    15: "PRODUCT-TYPOGRAPHY-CHANGE",
    20: "ENVIRONMENT-INVALID",
    30: "INCOMPLETE",
}


def unknown_exit_codes(codes):
    """bug/0216：列出不能映射到契约退出码集合的原始值（None/字符串/其它整数）。"""
    known = set(CODE_LABELS)
    return sorted({repr(code) for code in codes
                   if not isinstance(code, int) or code not in known})


def exit_code_aggregation(codes, final_code):
    """bug/0178：记录聚合输入与「被更高优先级掩盖」的码。

    `pick_exit` 只给最终值；10 被 20/4 盖住时，结果 JSON 仍要能看出原本发生过
    不匹配/期望失败。这里保留逐码计数、最终值与被掩盖的明细。
    """
    counts = {}
    for code in codes:
        key = repr(code)
        counts[key] = counts.get(key, 0) + 1
    masked = [code for code in codes
              if isinstance(code, int) and code in CODE_LABELS
              and code != final_code and code != 0]
    return {
        "inputs": [code for code in codes],
        "counts": {key: counts[key] for key in sorted(counts)},
        "final": final_code,
        "masked_nonzero": masked,
        "unknown": unknown_exit_codes(codes),
        "note": "final 由 pick_exit 按 4>20>15>10>30>0 聚合；逐条来源见 exit_reasons",
    }


def label_for_code(code, fallback=None):
    """把最终退出码映射回 label（bug/0210）。

    变异判定自身的 10 保留 `MUTATION-EXPECTATION-FAIL` 语义；其它情况按最终码
    重新标注，⛔ 不允许 `code=4` 还挂着旧 `PASS`/`MISMATCH` 的 label。
    """
    if code == 10 and fallback == "MUTATION-EXPECTATION-FAIL":
        return fallback
    if code == 30 and fallback in ("UNVERIFIED", "skipped", "INCOMPLETE"):
        return "UNVERIFIED"
    return CODE_LABELS.get(code, fallback or "UNKNOWN(%s)" % code)


def negative_status_label(status):
    """bug/0161：机器面 label 与 status 分离。

    旧实现把 `status` 原样当 `label`，`"skipped"` 与普通跳过混同，读者无法区分
    「没有执行体 / 不适用」和「执行了但未验证」。⛔ 不再复用 `"skipped"` 作 label。
    """
    if status in ("skipped", "unsupported", "unverified", "partial"):
        return "UNVERIFIED"
    return {
        "pass": "PASS",
        "red": "EXPECTED-RED",
        "green": "UNEXPECTED-GREEN",
        "error": "INTERNAL-ERROR",
        "planned": "PLANNED",
    }.get(status, (status or "").upper() or None)


def unverified_negatives(negatives):
    rows = []
    for entry in negatives:
        status = entry.get("status")
        if status not in ("skipped", "unsupported", "unverified", "partial"):
            continue
        rows.append({
            "id": entry.get("id"),
            "status": status,
            "label": negative_status_label(status),
            "reason": entry.get("reason"),
            "expectation": entry.get("expectation"),
            "not_green": True,
        })
    return rows


def exit_reasons(ref_records, mutations, negatives):
    """逐个列出退出码贡献者（bug/0144）。

    顶层 `exit_code` 只是聚合结果；`10` 在参考页路径上是 PRODUCT-MISMATCH、
    在变异路径上是 MUTATION-EXPECTATION-FAIL，⛔ 不允许只看顶层码判断原因。
    """
    rows = []
    for record in ref_records:
        if record["role"] != "reference":
            continue
        if record.get("error"):
            err = record.get("error") or {}
            code = reference_code(record)
            rows.append({
                "source": "reference",
                "id": record["fixture"],
                "code": code,
                "label": "INCOMPLETE" if code == 30 else "INTERNAL-ERROR",
                "meaning": "no-B" if code == 30 else err.get("stage"),
                "detail": err.get("detail"),
            })
            continue
        verdict = record.get("verdict") or {}
        code = verdict.get("code")
        rows.append({
            "source": "reference",
            "id": record["fixture"],
            "code": int(code) if code is not None else 30,
            "label": verdict.get("label"),
            "meaning": "PRODUCT-MISMATCH" if code == 10 else verdict.get("category"),
        })
    for entry in mutations:
        verdict = entry["verdict"]
        code = verdict.get("code")
        rows.append({
            "source": "mutation",
            "id": entry["id"],
            "code": int(code) if code is not None else 30,
            "label": verdict.get("label"),
            "meaning": ("MUTATION-EXPECTATION-FAIL" if code == 10
                        else verdict.get("category")),
            "expectation_failures": verdict.get("expectation_failures") or [],
        })
    for entry in negatives:
        status = entry.get("status")
        rows.append({
            "source": "negative",
            "id": entry["id"],
            "code": entry.get("code"),
            "status": status,
            "label": negative_status_label(status),
            "meaning": entry.get("reason") or "negative-control",
            "reason": entry.get("reason"),
        })
    return rows


def reference_code(record):
    if record.get("error"):
        # bug/0148/0127：B 不可用是「没有测量」，不是脚本内部错误；
        # 记 30（未完成），⛔ 不冒充 4 的「内部错误」语义。
        stage = (record.get("error") or {}).get("stage")
        return 30 if stage == "b" else 4
    verdict = record.get("verdict")
    if not isinstance(verdict, dict):
        return 30
    code = verdict.get("code")
    return int(code) if code is not None else 30


def summarize_case(case):
    env = case.get("env") or {}
    return {
        "fixture": case.get("fixture"),
        "case_dir": case.get("case_dir"),
        "env_ok": case.get("env_ok"),
        "env_status": case.get("env_status"),
        "compare_code": case.get("compare_code"),
        "env": case.get("env"),
        "filtered_overall": env.get("filtered") if isinstance(env, dict) else None,
        "compare_overall": env.get("compare") if isinstance(env, dict) else None,
        "reason": case.get("reason"),
        "ref_present": case.get("ref_present"),
        "mut_present": case.get("mut_present"),
        "b": case.get("b"),
        "b_source": case.get("b_source"),
        "b_pitch": case.get("b_pitch"),
        "error": case.get("error"),
        "aux_error": case.get("aux_error"),
        "snapshot": case.get("snapshot"),
        "page_attestation": case.get("page_attestation"),
        "diagnostics": case.get("diagnostics"),
        "stages": stages_for(case.get("case_dir")),
    }


def print_summary(ref_records, mutations, negatives, exit_code):
    log("")
    log("════════════════════════════════════════════════════════════════════")
    log("L2 跑批汇总")
    log("  参考页：")
    for record in ref_records:
        if record["role"] != "reference":
            continue
        if record.get("error"):
            log("    %-14s ⛔ %s" % (record["fixture"], record["error"].get("detail")))
        else:
            verdict = record.get("verdict") or {}
            line = "    %-14s %s（exit %s）" % (
                record["fixture"], verdict.get("label"), verdict.get("code"))
            # bug/0267：参考页为何 30/10 必须能直接读出来，⛔ 只给 label+code。
            detail = verdict.get("detail")
            if detail:
                line += " — %s" % detail
            log(line)
            # bug/0268：跳过闸门要显式列出，⛔ 混进绿计数。
            if verdict.get("skipped_gates"):
                log("      ⚑ 跳过闸门（⛔ 不算绿）：%s"
                    % ", ".join(verdict["skipped_gates"]))
            if verdict.get("skips_not_green_consistent") is False:
                log("      ⚑ 「跳 ≠ 绿」口径与 l2-check.sh 声明不一致（bug/0268）")
    if mutations:
        log("  变异：")
        for entry in mutations:
            verdict = entry["verdict"]
            red = [x for x in verdict.get("must_red") or [] if x.get("status") == "red"]
            green = [x for x in verdict.get("must_green") or [] if x.get("status") == "green"]
            log("    %-4s %-28s 红 %d/%d，绿 %d/%d，越界 %d"
                % (entry["id"], verdict.get("label"),
                   len(red), len(verdict.get("must_red") or []),
                   len(green), len(verdict.get("must_green") or []),
                   len(verdict.get("unexpected_red") or [])))
            # bug/0267：期望失败逐条落到汇总（含 source），⛔ 只在 JSON 里。
            for failure in verdict.get("expectation_failures") or []:
                log("      ⛔ %s %s%s"
                    % (failure.get("kind"), failure.get("id"),
                       "［%s］" % failure["source"] if failure.get("source") else ""))
            # bug/0205：同轮不变量单独计数。
            for group in verdict.get("invariants") or []:
                inv_red = [x for x in group.get("must_green") or []
                           if x.get("status") == "red"]
                log("      %s 绿 %d/%d%s"
                    % (group.get("id"),
                       len([x for x in group.get("must_green") or []
                            if x.get("status") == "green"]),
                       len(group.get("must_green") or []),
                       "，红 %d" % len(inv_red) if inv_red else ""))
            # bug/0204：允许连带红不再只用于放行，汇总里给出实测条数。
            observed = verdict.get("allowed_red_observed") or []
            unused = verdict.get("allowed_red_unused") or []
            if observed or unused:
                log("      允许连带红：观测 %d / 未红 %d"
                    % (len(observed), len(unused)))
            fallback = verdict.get("b_fallback") or {}
            if fallback.get("used"):
                log("      ⚑ B 回退（⛔ 不是变异页实测）：%s" % (fallback.get("reason") or "?"))
            if verdict.get("aux_error"):
                log("      ⛔ 辅助页错误：%s"
                    % ((verdict.get("aux_error") or {}).get("detail") or "?"))
            unverified = verdict.get("unverified") or []
            if unverified:
                log("      ⚑ 未验证：%s" % ", ".join(str(x) for x in unverified))
            coverage = verdict.get("coverage") or {}
            uncovered = coverage.get("uncovered_must") or []
            if uncovered:
                log("      ⚑ must 项无生产者/无记录：%s"
                    % ", ".join(str(x) for x in uncovered))
            aggregation = verdict.get("aggregation") or {}
            if aggregation and aggregation.get("extra_codes"):
                log("      聚合：base=%s + %s ⇒ %s"
                    % (aggregation.get("base_code"),
                       aggregation.get("extra_codes"),
                       aggregation.get("final_code")))
    if negatives:
        log("  负对照：")
        for entry in negatives:
            line = "    %-3s %-22s %s（exit %s）" % (
                entry["id"], entry.get("status"),
                entry.get("title"), entry.get("code"))
            reason = entry.get("reason")
            if reason:
                line += " — %s" % reason
            log(line)
            # bug/0240/0267：负对照的 must 计数与被观测到的越界红也进汇总。
            red = entry.get("must_red") or []
            green = entry.get("must_green") or []
            if red or green:
                log("      must 红 %d/%d，绿 %d/%d，越界 %d"
                    % (len([x for x in red if x.get("status") == "red"]), len(red),
                       len([x for x in green if x.get("status") in ("pass", "green")]),
                       len(green), len(entry.get("unexpected_red") or [])))
        unverified = [entry["id"] for entry in negatives
                      if entry.get("status") in ("skipped", "unsupported", "unverified")]
        if unverified:
            log("    ⚑ 未验证（⛔ 不得当成通过）：%s" % ", ".join(unverified))
    log("  总退出码：%d" % exit_code)
    log("  退出码来源（同一数值可能有两种语义，按 source 区分）：")
    for row in exit_reasons(ref_records, mutations, negatives):
        if row.get("code"):
            log("    %-10s %-14s %-2s %-28s %s"
                % (row.get("source"), row.get("id"), row.get("code"),
                   row.get("label") or "", row.get("meaning") or ""))
    log("  结果 JSON：%s" % OUT)
    log("════════════════════════════════════════════════════════════════════")


def write_running_placeholder():
    """bug/0263：开跑即占住 OUT，⛔ 不让上一轮成功 JSON 冒充本轮。

    旧结果先挪到 `OUT.prev`（仅当它不是本进程刚写的 running 占位），再原子写
    `state=running`。中途 SIGTERM/崩溃时 OUT 至少是 running/fatal，不是 PASS。
    """
    if DRY:
        return None
    out_dir = os.path.dirname(OUT)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    backup = None
    prior_state = None
    if os.path.isfile(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                prior_state = (json.load(f) or {}).get("state")
        except Exception:
            prior_state = None
        if prior_state != "running":
            backup = OUT + ".prev"
            try:
                os.replace(OUT, backup)
            except OSError:
                backup = None
    write_json(OUT, {
        "schema": "rmd-parity-l2run/1",
        "tool": "l2-run",
        "logic_version": L2RUN_LOGIC_VERSION,
        "generated_at": now_iso(),
        "started_at": now_iso(),
        "state": "running",
        "pid": os.getpid(),
        "previous_result_backup": backup,
        "exit_code": None,
        "invocation": {
            "fixtures": FIXTURES,
            "mutations": SELECTED_MUTATIONS,
            "negatives": SELECTED_NEGATIVES,
            "work": WORK,
            "out": OUT,
        },
    })
    return backup


def main():
    if DRY:
        return dry_run()

    os.makedirs(WORK, exist_ok=True)
    os.makedirs(L2_DIR, exist_ok=True)
    started_at = now_iso()
    previous_result_backup = write_running_placeholder()

    log("════════════════════════════════════════════════════════════════════")
    log("L2 跑批开始")
    log("  work      : %s" % WORK)
    log("  fixtures  : %s" % ", ".join(FIXTURES))
    log("  mutations : %s" % (", ".join(SELECTED_MUTATIONS) or "—"))
    log("  negatives : %s" % (", ".join(SELECTED_NEGATIVES) or "—"))
    log("  force     : %s" % ("yes" if FORCE else "no（复用已有产物）"))
    log("════════════════════════════════════════════════════════════════════")

    ref_records, b_ref, b_source = run_references()
    log("  B = %s（%s）" % (fmt_num(b_ref) if b_ref is not None else "缺", b_source))

    mutations = []
    for mid in SELECTED_MUTATIONS:
        log("")
        log("▶ 变异 %s：%s" % (mid, MUT_BY_ID[mid].get("title")))
        mutations.append(run_mutation(mid, b_ref))

    negatives = []
    for nid in SELECTED_NEGATIVES:
        log("")
        log("▶ 负对照 %s：%s" % (nid, NEGATIVE_TITLES[nid]))
        negatives.append(run_negative(nid))

    # bug/0210：辅助页（role=auxiliary）的错误也必须参与聚合，⛔ 只取 reference。
    codes = [reference_code(record) for record in ref_records]
    codes += [entry["verdict"]["code"] for entry in mutations]
    codes += [entry["code"] for entry in negatives]
    exit_code = pick_exit(codes)

    aux_errors = [{
        "fixture": record.get("fixture"),
        "role": record.get("role"),
        "code": reference_code(record),
        "error": record.get("error"),
    } for record in ref_records if record.get("error")]

    b_info = None
    observed_dpr = None
    for record in ref_records:
        snapshot = record.get("snapshot") or {}
        if observed_dpr is None and snapshot.get("dpr_observed") is not None:
            observed_dpr = snapshot.get("dpr_observed")
        if (record.get("fixture") == "00-body" and b_info is None
                and record.get("bands_pitch")):
            b_info = record.get("bands_pitch")

    # bug/0125：自动模式下没有实测 scale 时，⛔ 不用默认 DPR 假装知道 PNG 期望尺寸。
    expected_scale = observed_dpr if observed_dpr is not None else (DPR if DPR_EXPLICIT else None)
    result = {
        "schema": "rmd-parity-l2run/1",
        "tool": "l2-run",
        "logic_version": L2RUN_LOGIC_VERSION,
        "generated_at": now_iso(),
        "started_at": started_at,
        "state": "complete",
        "previous_result_backup": previous_result_backup,
        "pid": os.getpid(),
        "payload_provenance": PAYLOAD_PROVENANCE,
        "payload_binding": payload_binding_summary(ref_records),
        "payload_cross_check": payload_cross_check_summary(ref_records),
        "build_id_check": BUILD_ID_CHECK,
        "invocation": {
            "fixtures": FIXTURES,
            "mutations": SELECTED_MUTATIONS,
            "negatives": SELECTED_NEGATIVES,
            "sidebar_width_pt": SIDEBAR,
            "dpr": DPR,
            "dpr_mode": "explicit" if DPR_EXPLICIT else "auto",
            "dpr_observed": observed_dpr,
            "canvas_pt": [CANVAS_W, CANVAS_H],
            "expected_png_px": ([int(round(expected_scale * CANVAS_W)),
                                 int(round(expected_scale * CANVAS_H))]
                                if expected_scale is not None else None),
            "work": WORK,
            "out": OUT,
            "force": FORCE,
            "baseline": BASELINE,
            "baseline_present": os.path.isfile(BASELINE),
        },
        "b": {
            "value": b_ref,
            "source": b_source,
            "file": B0_JSON,
            "pitch": b_info,
        },
        "references": [summarize_record(record) for record in ref_records],
        "mutations": [{
            "id": entry["id"],
            "verdict": entry["verdict"],
            "cases": [summarize_case(case) for case in entry["cases"]],
        } for entry in mutations],
        "negatives": negatives,
        # bug/0173：判据有定义但还没有执行器的全部登记在这里，⛔ 不假装已覆盖。
        # unit_main 只注入 main 所需名字，故用 globals().get 兜底。
        "unimplemented_criteria": ((globals().get("MUTSPEC") or {})
                                   .get("unimplemented_criteria") or []),
        "unverified_negatives": unverified_negatives(negatives),
        "aux_errors": aux_errors,
        "exit_code": exit_code,
        # bug/0178：最终码的聚合输入与被掩盖的码要落盘。
        "exit_code_aggregation": (globals().get("exit_code_aggregation")
                                  or (lambda values, final: None))(codes, exit_code),
        # bug/0216：未知码一律折成 4，但原始值要留证，⛔ 不静默改写退出码来源。
        "unknown_exit_codes": (globals().get("unknown_exit_codes")
                               or (lambda values: []))(codes),
        "exit_reasons": exit_reasons(ref_records, mutations, negatives),
        "log_meta": {
            "total_lines": len(LOG_LINES),
            "appended_lines": min(len(LOG_LINES), 300),
            "truncated": len(LOG_LINES) > 300,
        },
        "log": LOG_LINES[-300:],
    }
    write_json(OUT, result)
    print_summary(ref_records, mutations, negatives, exit_code)
    return exit_code


sys.exit(main())
PY
ENGINE_PID=$!
wait "$ENGINE_PID" && ENGINE_RC=0 || ENGINE_RC=$?
exit "$ENGINE_RC"
