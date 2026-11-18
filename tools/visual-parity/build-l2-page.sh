#!/usr/bin/env bash
# ⭐ `design/0063` §7.2 步 1：L2 构页（Mardo 全程不启动）。
#
# 用法：
#   tools/visual-parity/build-l2-page.sh <fixture-name> <outdir> \
#       --fixtures-json <path> [--sidebar-width <px>] \
#       [--font-size <px>] [--line-height <n>] [--content-width <px>] \
#       [--config <config.json>] [--fixtures-dir <dir>]
#
#   <fixture-name>   Stage A 载荷里 `docs[].name`（夹具文件名的 stem）。
#   <outdir>         输出目录：必须不存在或为空（⛔ 不覆盖非空目录，避免误删）。
#   --fixtures-json  Stage A 载荷（`tools/visual-parity/.work/fixtures.json`）。
#                    ⚠️ 由另一个 Agent 跑 `live_block_夹具导出` 产出；
#                    本脚本 **⛔ 不跑 cargo**（不抢构建锁，也不自己造第二份渲染）。
#   --sidebar-width  L1 实测的 `sidebar_width`（px）。缺省读环境变量
#                    `RMD_PARITY_SIDEBAR_WIDTH`；两者都没有 ⇒ **报错退出**，
#                    ⛔ 不回退到代码里的 260/280（那样内容列与 L1 不同宽）。
#   --font-size / --line-height / --content-width
#                    阅读排版三字段（`bugs/0122`）。缺省按同一顺序读
#                    `--config`（默认用户 `config.json`）的 `reader_font_size` /
#                    `reader_line_height` / `reader_content_width`；
#                    ⛔ 三者都没有 ⇒ 报错退出，⛔ 不用 14 / 1.7 / 0 兜底。
#   --config        用户配置 JSON 路径。缺省
#                    `$RMD_PARITY_CONFIG`，再缺省
#                    `$HOME/Library/Application Support/io.github.kumustone.rmd/config.json`。
#   --fixtures-dir  夹具目录（解析 `<img src>` 的本地相对路径用），默认 `./fixtures`。
#
# 环境变量：
#   RMD_L2_CHECK_FIXTURE_MEDIA=0
#                   关闭「夹具引用的 `pic.png` 与 `fixtures-media-expect.json`
#                   摘要一致」预检（默认 1 = 开启；`bugs/0198`）。清单缺失时
#                   只报 WARN 并继续，摘要/尺寸不符则以退出码 3 失败。
#
# ⚠️ 载荷缺顶层 `shortcuts` 时 ⛔ **不补空数组**（`bugs/0257`）：判定**前置**到
#    写出任何页面/provenance 之前，直接以退出码 3 失败（⛔ 不留整页假产物；
#    早先版本会先写页面再退 3）。显式空数组记为 `empty`，与「缺键」区分开
#    （不失败，但报 WARN）。
#
# 产物（除页面外还写两份自证）：
#   __l2-provenance.json  本次构页实际生效的排版三字段、侧栏宽、载荷 provenance、
#                         本地资源清单（`bugs/0122` / `0154`）。
#   `__fake-tauri.js` 尾部注入 `window.__PARITY_PROVENANCE` 与
#   `window.__PARITY_ASSETS`（`read_asset` 的真实字节通道，`bugs/0118`）。
#
# 做法逐条照搬 `tools/live-probe/block-probe.sh::build_page`：
#   ① 产品 `src/` **整棵**拷进 outdir（⛔ 不用符号链接：WKWebView 的
#      `allowingReadAccessTo` 是按目录给的，链到目录外读不到）；
#   ② 注入 `__fixture.js` / `__fake-tauri.js` / `__harness.js`，且顺序排在
#      `vendor/cm6.bundle.js` **之前**——产品脚本在**加载期**取 `window.rmd.*`，
#      而这三个只碰 `window.__FIXTURE` / `window.__TAURI__` / `window.__RUN`，
#      ⛔ 不读产品全局 ⇒ 放最前不会改变任何加载期依赖关系；
#   ③ 额外注入 `__parity-boot.js`：等 `.doc` 出现且 `innerHTML` 非空、字体就绪
#      （`document.fonts.ready`）、且**连续两帧布局尺寸不变**之后才置
#      `window.__PARITY_READY = true`（`bugs/0117`）；8 s 超时置
#      `window.__PARITY_ERROR`，供离线取像脚本轮询。
#      稳定后的列宽/内容盒高/溢出判定写进 `window.__PARITY_LAYOUT`。
#
# 侧栏占位（§7.2 U4，四条都是硬要求）：
#   ① ⛔ **不添加** `body.sidebar-collapsed`（它会把 `padding-left` 归 0、
#      内容列变成整幅画布）——本脚本从不写这个类；
#   ② `__fake-tauri` 返回的 `sidebar_width` = `--sidebar-width`：
#      只改**页面副本**里那份替身（⛔ 不动 `tools/live-probe/fake-tauri.js`）；
#   ③ `.sidebar` 不参与排版/取像：用 `display:none` 隐藏。⚠️ 元素**保留**在 DOM 里，
#      否则真 `main.js` 取不到 `#sidebar`，启动期就会抛错（设计允许 display:none）；
#   ④ **保留** `body { padding-left: var(--sidebar-width) }` 这个占位
#      （`sidebar.css` 一字未改），让内容列与 L1 同宽。
#
# 退出码：0 = 成功；2 = 用法/参数错误；3 = 输入或环境缺失（含排版三字段无从取值、
#         载荷缺 `shortcuts`、图片夹具摘要不符）；4 = 页面注入守卫失败。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

SRC="$ROOT/src"
FAKE="$ROOT/tools/live-probe/fake-tauri.js"
# ⚠️ `__harness.js` 默认复用既有探针的页面判据（`design/0063` §7.2 明写
#    "复用 block-probe.sh::build_page"）。若 L2 另有专用 harness，用
#    `RMD_PARITY_HARNESS=/abs/path/l2-harness.js` 指过去即可。
HARNESS="${RMD_PARITY_HARNESS:-$ROOT/tools/live-probe/block-harness.js}"

usage() {
  # 头部注释到第一个空行为止（⛔ 不写死行号，避免加注释后截断）。
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ── 参数 ────────────────────────────────────────────────────────────────
FIXTURE_NAME=""
OUTDIR=""
FIXTURES_JSON=""
SIDEBAR_WIDTH="${RMD_PARITY_SIDEBAR_WIDTH:-}"
# `bugs/0122`：排版三字段必须从参数/用户配置来，⛔ 不存在写死默认值。
FONT_SIZE=""
LINE_HEIGHT=""
CONTENT_WIDTH=""
CONFIG_PATH="${RMD_PARITY_CONFIG:-}"
FIXTURES_DIR="$HERE/fixtures"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fixtures-json)
      [ "$#" -ge 2 ] || { echo "⛔ --fixtures-json 缺参数值" >&2; exit 2; }
      FIXTURES_JSON="$2"; shift 2 ;;
    --fixtures-json=*)
      FIXTURES_JSON="${1#*=}"; shift ;;
    --sidebar-width)
      [ "$#" -ge 2 ] || { echo "⛔ --sidebar-width 缺参数值" >&2; exit 2; }
      SIDEBAR_WIDTH="$2"; shift 2 ;;
    --sidebar-width=*)
      SIDEBAR_WIDTH="${1#*=}"; shift ;;
    --font-size)
      [ "$#" -ge 2 ] || { echo "⛔ --font-size 缺参数值" >&2; exit 2; }
      FONT_SIZE="$2"; shift 2 ;;
    --font-size=*)
      FONT_SIZE="${1#*=}"; shift ;;
    --line-height)
      [ "$#" -ge 2 ] || { echo "⛔ --line-height 缺参数值" >&2; exit 2; }
      LINE_HEIGHT="$2"; shift 2 ;;
    --line-height=*)
      LINE_HEIGHT="${1#*=}"; shift ;;
    --content-width)
      [ "$#" -ge 2 ] || { echo "⛔ --content-width 缺参数值" >&2; exit 2; }
      CONTENT_WIDTH="$2"; shift 2 ;;
    --content-width=*)
      CONTENT_WIDTH="${1#*=}"; shift ;;
    --config)
      [ "$#" -ge 2 ] || { echo "⛔ --config 缺参数值" >&2; exit 2; }
      CONFIG_PATH="$2"; shift 2 ;;
    --config=*)
      CONFIG_PATH="${1#*=}"; shift ;;
    --fixtures-dir)
      [ "$#" -ge 2 ] || { echo "⛔ --fixtures-dir 缺参数值" >&2; exit 2; }
      FIXTURES_DIR="$2"; shift 2 ;;
    --fixtures-dir=*)
      FIXTURES_DIR="${1#*=}"; shift ;;
    -h|--help)
      usage; exit 0 ;;
    -*)
      echo "⛔ 未知参数：$1" >&2; exit 2 ;;
    *)
      if [ -z "$FIXTURE_NAME" ]; then
        FIXTURE_NAME="$1"
      elif [ -z "$OUTDIR" ]; then
        OUTDIR="$1"
      else
        echo "⛔ 多余的参数：$1" >&2; exit 2
      fi
      shift ;;
  esac
done

if [ -z "$FIXTURE_NAME" ] || [ -z "$OUTDIR" ] || [ -z "$FIXTURES_JSON" ]; then
  echo "⛔ 缺参数。用法：" >&2
  usage >&2
  exit 2
fi

if [ -z "$SIDEBAR_WIDTH" ]; then
  echo "⛔ 缺 --sidebar-width，且环境变量 RMD_PARITY_SIDEBAR_WIDTH 未设置。" >&2
  echo "   侧栏宽度必须是 **L1 实测值**（design/0063 §7.2 U4②）；" >&2
  echo "   ⛔ 本脚本不回退到代码里的 260/280 默认值——那会让 L2 内容列与 L1 不同宽。" >&2
  exit 2
fi

# 只接受正数（允许小数，CSS px 合法）。
if ! awk -v w="$SIDEBAR_WIDTH" 'BEGIN { exit !(w ~ /^[0-9]+([.][0-9]+)?$/ && w + 0 > 0) }'; then
  echo "⛔ --sidebar-width 必须是正数（px），收到：$SIDEBAR_WIDTH" >&2
  exit 2
fi

# ── 输入与环境 ──────────────────────────────────────────────────────────
if ! command -v python3 >/dev/null 2>&1; then
  echo "⛔ 没有 python3（注入脚本与载荷解析都要它）" >&2
  exit 3
fi

if [ ! -e "$FIXTURES_JSON" ]; then
  echo "⛔ 找不到 Stage A 载荷：$FIXTURES_JSON" >&2
  echo "   它应由另一个 Agent 跑 \`live_block_夹具导出\` 产出" >&2
  echo "   （RMD_LIVE_BLOCK_DIR/RMD_LIVE_BLOCK_OUT → cargo test --ignored live_block）。" >&2
  echo "   ⛔ 本脚本不自己跑 cargo 生成。" >&2
  exit 3
fi
if [ ! -f "$FIXTURES_JSON" ] || [ ! -s "$FIXTURES_JSON" ]; then
  echo "⛔ Stage A 载荷不是可读的非空文件：$FIXTURES_JSON" >&2
  exit 3
fi

# ── 载荷 `shortcuts` 状态（bugs/0257）────────────────────────────────────
# ⭐ 必须把「载荷根本没有这个键」与「产品确实没有键位（显式空数组）」分开：
#    · missing = 键不存在 ⇒ 页面/provenance 显式标记，构页结束退 3（⛔ 不补 []）
#    · empty   = 键存在且是 [] ⇒ 与 missing 区分；报 WARN，但不失败
#    · ok      = 键存在且非空数组
#    · invalid = 键存在但不是数组 ⇒ 输入契约破坏，退 3
SHORTCUTS_META="$(python3 -I - "$FIXTURES_JSON" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as f:
        d = json.load(f)
except Exception as e:  # noqa: BLE001 —— 这里只要一句人话
    print("⛔ Stage A 载荷不是合法 JSON：%s（%s）" % (sys.argv[1], e), file=sys.stderr)
    sys.exit(3)

if not isinstance(d, dict):
    print("⛔ Stage A 载荷顶层不是对象：%s" % sys.argv[1], file=sys.stderr)
    sys.exit(3)

if "shortcuts" not in d:
    status, count = "missing", 0
else:
    value = d["shortcuts"]
    if not isinstance(value, list):
        status, count = "invalid", 0
    elif not value:
        status, count = "empty", 0
    else:
        status, count = "ok", len(value)
print("%s\t%d" % (status, count))
PY
)"
IFS=$'\t' read -r SHORTCUTS_STATUS SHORTCUTS_COUNT <<< "$SHORTCUTS_META"

if [ "$SHORTCUTS_STATUS" = "missing" ]; then
  echo "⛔ 载荷没有顶层 \`shortcuts\` 键（bugs/0257）：$FIXTURES_JSON" >&2
  echo "   ⛔ 不补空数组，且**在写出任何页面/provenance 之前**失败（不留整页假产物）。" >&2
  echo "   修法：用 --features gui 的构建导出 Stage A 载荷（含 gui::SHORTCUTS 真表）。" >&2
  exit 3
elif [ "$SHORTCUTS_STATUS" = "empty" ]; then
  echo "⚠️ 载荷 \`shortcuts\` 是显式空数组（bugs/0257）：与『缺键』区分，" >&2
  echo "   不视为缺失；但产品真表通常非空，请确认导出侧没有丢键位。" >&2
elif [ "$SHORTCUTS_STATUS" = "invalid" ]; then
  echo "⛔ 载荷 \`shortcuts\` 不是数组（bugs/0257）：$FIXTURES_JSON" >&2
  exit 3
fi

for f in "$SRC/index.html" "$FAKE" "$HARNESS" "$SRC/vendor/cm6.bundle.js"; do
  if [ ! -f "$f" ]; then
    echo "⛔ 缺 $f" >&2
    exit 3
  fi
done

if [ ! -d "$FIXTURES_DIR" ]; then
  echo "⛔ 夹具目录不存在：$FIXTURES_DIR" >&2
  exit 3
fi

# ── 排版三字段（bugs/0122）：参数 → 用户配置，⛔ 不写死 14 / 1.7 / 0 ──────
# 值域按产品 `services/theme.js` 的 clamp 区间收紧：超出就会被产品夹住，
# 那样"注入值"与"实际生效值"不一致，provenance 就会撒谎。
set +e
APPEARANCE_RAW="$(python3 -I - "$CONFIG_PATH" "$FONT_SIZE" "$LINE_HEIGHT" "$CONTENT_WIDTH" <<'PY'
import json
import os
import sys

config_path, font, lh, cw = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
DEFAULT_CONFIG = os.path.expanduser(
    "~/Library/Application Support/io.github.kumustone.rmd/config.json")
if not config_path:
    config_path = DEFAULT_CONFIG

FIELDS = (
    ("font_size", font, "reader_font_size", (12.0, 28.0), "--font-size"),
    ("line_height", lh, "reader_line_height", (1.2, 2.0), "--line-height"),
    ("content_width", cw, "reader_content_width", (0.0, 2400.0), "--content-width"),
)

cfg = None
cfg_error = None
if any(v == "" for _, v, _, _, _ in FIELDS):
    try:
        with open(config_path, encoding="utf-8") as f:
            cfg = json.load(f)
        if not isinstance(cfg, dict):
            cfg, cfg_error = None, "顶层不是对象"
    except Exception as e:  # noqa: BLE001 —— 这里只要一句人话
        cfg_error = str(e)


def number(raw, flag):
    try:
        value = float(raw)
    except ValueError:
        print("⛔ %s 不是数字：%r" % (flag, raw), file=sys.stderr)
        sys.exit(2)
    if value != value or value in (float("inf"), float("-inf")):
        print("⛔ %s 不是有限数字：%r" % (flag, raw), file=sys.stderr)
        sys.exit(2)
    return value


rows = []
for key, explicit, cfg_key, (lo, hi), flag in FIELDS:
    if explicit != "":
        value = number(explicit, flag)
        source = "param:" + flag
    else:
        if cfg is None:
            print("⛔ 缺 %s，且读不到用户配置 %s（%s）\n"
                  "   ⛔ 本脚本不用 14 / 1.7 / 0 兜底——那会让 L2 测的不是用户所见。"
                  % (flag, config_path, cfg_error or "未提供"), file=sys.stderr)
            sys.exit(3)
        raw = cfg.get(cfg_key)
        if raw is None:
            print("⛔ 用户配置缺 %s（%s）：%s" % (cfg_key, flag, config_path),
                  file=sys.stderr)
            sys.exit(3)
        value = number(raw, cfg_key)
        source = "config:" + config_path
    if key == "content_width":
        ok = (value == 0.0) or (lo <= value <= hi)
    else:
        ok = lo <= value <= hi
    if not ok:
        print("⛔ %s=%s 超出产品 clamp 区间 [%s, %s]（content_width 允许 0）"
              % (flag, value, lo, hi), file=sys.stderr)
        sys.exit(2)
    rows.append((key, ("%d" % value) if value == int(value) else repr(value), source))

for key, value, source in rows:
    print("%s\t%s\t%s" % (key, value, source))
PY
)"
APPEARANCE_RC=$?
set -e
[ "$APPEARANCE_RC" -eq 0 ] || exit "$APPEARANCE_RC"

field() { printf '%s\n' "$APPEARANCE_RAW" | awk -F'\t' -v k="$1" '$1==k{print $2; exit}'; }
source_of() { printf '%s\n' "$APPEARANCE_RAW" | awk -F'\t' -v k="$1" '$1==k{print $3; exit}'; }
FONT_SIZE="$(field font_size)"
LINE_HEIGHT="$(field line_height)"
CONTENT_WIDTH="$(field content_width)"
FONT_SOURCE="$(source_of font_size)"
LH_SOURCE="$(source_of line_height)"
CW_SOURCE="$(source_of content_width)"

for pair in "font_size=$FONT_SIZE" "line_height=$LINE_HEIGHT" "content_width=$CONTENT_WIDTH"; do
  if [ "${pair#*=}" = "" ]; then
    echo "⛔ 排版字段解析失败：$pair" >&2
    exit 3
  fi
done

# ⚠️ 只接受空目录：`rm -rf` 用户传进来的路径太危险。
if [ -e "$OUTDIR" ]; then
  if [ ! -d "$OUTDIR" ]; then
    echo "⛔ 输出路径不是目录：$OUTDIR" >&2
    exit 2
  fi
  if [ -n "$(ls -A "$OUTDIR")" ]; then
    echo "⛔ 输出目录非空（为避免误删而拒绝）：$OUTDIR" >&2
    echo "   请换一个空目录，或自行清理后重跑。" >&2
    exit 2
  fi
else
  mkdir -p "$OUTDIR"
fi
OUTDIR="$(cd "$OUTDIR" && pwd)"

# ── ① 产品 `src/` 整棵拷进 outdir ────────────────────────────────────────
cp -R "$SRC/." "$OUTDIR/"

# ── ② `__fixture.js`：注入的必须是**这一份** doc（⇐ Stage A 的真 comrak 产物）──
python3 -I - "$FIXTURES_JSON" "$FIXTURE_NAME" "$OUTDIR/__fixture.js" \
  "$SHORTCUTS_STATUS" "$SHORTCUTS_COUNT" <<'PY'
import json
import sys

src, name, out, shortcuts_status, shortcuts_count = sys.argv[1:6]

try:
    with open(src, encoding="utf-8") as f:
        d = json.load(f)
except Exception as e:  # noqa: BLE001 —— 这里只要一句人话，不要栈
    print("⛔ Stage A 载荷不是合法 JSON：%s（%s）" % (src, e), file=sys.stderr)
    sys.exit(3)

docs = d.get("docs")
if not isinstance(docs, list) or not docs:
    print("⛔ Stage A 载荷里没有 docs：%s" % src, file=sys.stderr)
    sys.exit(3)

doc = next((x for x in docs if isinstance(x, dict) and x.get("name") == name), None)
if doc is None:
    names = [str(x.get("name")) for x in docs if isinstance(x, dict)]
    print("⛔ 载荷里没有夹具 %r；可用：%s" % (name, ", ".join(names) or "（空）"), file=sys.stderr)
    sys.exit(3)

# ⚠️ 不改原载荷里的对象：拷一份再补 `shortcuts`。
#    键位表是**整轮共用**的一份（Rust 的 `gui::SHORTCUTS`），⛔ 不是每份夹具一份。
#    ⭐ `bugs/0257`：缺键 ⇒ ⛔ **不补 `[]`**。页面用
#    `window.__L2_SHORTCUTS_STATUS = "missing"` 显式说明；present-empty 记 `empty`。
doc = dict(doc)
if shortcuts_status != "missing":
    doc["shortcuts"] = d["shortcuts"]

with open(out, "w", encoding="utf-8") as f:
    f.write("window.__FIXTURE = ")
    # ⚠️ `json.dump` 不带 indent ⇒ 整个对象一定在**一行**内（换行会被转义），
    #    自检脚本因此可以按行取出并 `json.loads` 回来核对。
    json.dump(doc, f, ensure_ascii=False)
    f.write(";\n")
    # ⭐ `bugs/0257`：把载荷侧的键位状态显式带到页面，供 DOM 探针/人工查证。
    f.write("window.__L2_SHORTCUTS_STATUS = %s;\n" % json.dumps(shortcuts_status))
    f.write("window.__L2_SHORTCUTS_COUNT = %d;\n" % int(shortcuts_count))
    # ⭐ **未捕获异常收集器**（照搬 block-probe）：产品在事件处理器里抛错时，
    #    异常只会进 `window.onerror`，不会让 `dispatchEvent` 抛出来。
    #    ⚠️ 只收 `window` 上的脚本错误，⛔ 不收资源加载失败。
    f.write('''
window.__ERR = [];
window.addEventListener('error', function (e) {
  if (!e || e.target !== window) return;
  window.__ERR.push({ 类型: 'error', 消息: String(e.message || ''),
    位置: String(e.filename || '').split('/').pop() + ':' + (e.lineno || 0),
    阶段: String(window.__PHASE || '') });
}, true);
window.addEventListener('unhandledrejection', function (e) {
  var r = e && e.reason;
  window.__ERR.push({ 类型: 'rejection',
    消息: String((r && r.message) || r || '').slice(0, 200) });
}, true);
''')
PY

# ── ③ 假后端 ＋ harness ─────────────────────────────────────────────────
cp "$FAKE" "$OUTDIR/__fake-tauri.js"
cp "$HARNESS" "$OUTDIR/__harness.js"

# ⭐ U4②：替身里把 `sidebar_width` 写死成 260（`fake-tauri.js` 是既有探针的基线）。
#    U4②＋`bugs/0122`：`appearance` 三字段同样只改**页面副本**——`get_session` 返回的
#    是同一个 snapshot 对象，在脚本末尾改属性即改返回值，且该脚本排在 `main.js` 之前。
#    `bugs/0118`：`read_asset` 在真产品里返回**真实字节**；这里按夹具里出现的
#    `<img src>` 预置 base64，命中返回 `{data_url, real_path}`，未命中才按
#    `kind=not_found` 拒绝（保留产品的占位降级路径）。
#    `bugs/0154`：把载荷 provenance（`build_id` / `exported_at` / sha）随页面带下去。
python3 -I - "$FIXTURES_JSON" "$FIXTURE_NAME" "$OUTDIR/__fake-tauri.js" \
  "$FIXTURES_DIR" "$OUTDIR" "$SIDEBAR_WIDTH" \
  "$FONT_SIZE" "$LINE_HEIGHT" "$CONTENT_WIDTH" \
  "$FONT_SOURCE" "$LH_SOURCE" "$CW_SOURCE" \
  "$SHORTCUTS_STATUS" "$SHORTCUTS_COUNT" \
  "$HERE/make-fixture-image.py" "$HERE/fixtures-media-expect.json" \
  "${RMD_L2_CHECK_FIXTURE_MEDIA:-1}" <<'PY'
import base64
import hashlib
import json
import mimetypes
import os
import re
import struct
import subprocess
import sys
import time

(payload_path, fixture, fake_js, fixtures_dir, outdir, sidebar,
 font_size, line_height, content_width,
 font_source, lh_source, cw_source,
 shortcuts_status, shortcuts_count,
 media_generator, media_manifest, media_enabled_raw) = sys.argv[1:18]

try:
    with open(payload_path, encoding="utf-8") as f:
        payload = json.load(f)
except Exception as e:  # noqa: BLE001 —— 只要一句人话
    print("⛔ Stage A 载荷不是合法 JSON：%s（%s）" % (payload_path, e), file=sys.stderr)
    sys.exit(3)

docs = payload.get("docs") or []
doc = next((x for x in docs if isinstance(x, dict) and x.get("name") == fixture), None)
if doc is None:
    print("⛔ 载荷里没有夹具 %r" % fixture, file=sys.stderr)
    sys.exit(3)

# ── 本地图片资源：把 `<img src>` 指向的文件复制进页面并转 base64 ─────────
IMG_RE = re.compile(r"""<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.I)
srcs = []
for m in IMG_RE.finditer(str(doc.get("html") or "")):
    src = (m.group(1) if m.group(1) is not None else m.group(2)) or ""
    if src and src not in srcs:
        srcs.append(src)

assets = {}
asset_rows = []
skipped = []
for src in srcs:
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", src) or src.startswith("#"):
        skipped.append({"src": src, "reason": "absolute-or-data-url"})
        continue
    path = os.path.normpath(os.path.join(fixtures_dir, src))
    if not (path == fixtures_dir or path.startswith(fixtures_dir + os.sep)):
        skipped.append({"src": src, "reason": "escapes-fixtures-dir"})
        continue
    if not os.path.isfile(path):
        skipped.append({"src": src, "reason": "missing-in-fixtures"})
        continue
    with open(path, "rb") as f:
        raw = f.read()
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    data_url = "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode("ascii"))
    dest = os.path.join(outdir, src)
    os.makedirs(os.path.dirname(dest), exist_ok=True) if os.path.dirname(dest) else None
    with open(dest, "wb") as f:
        f.write(raw)
    row = {
        "src": src,
        "file": os.path.relpath(path, os.path.dirname(fixtures_dir)),
        "real_path": "/l2-fixtures/%s/%s" % (fixture, src),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "mime": mime,
    }
    if raw[:8] == b"\x89PNG\r\n\x1a\n" and len(raw) >= 24:
        w, h = struct.unpack(">II", raw[16:24])
        row["pixel_size"] = [w, h]
    assets[src] = {"data_url": data_url, "real_path": row["real_path"]}
    asset_rows.append(row)

# ── 图片夹具完整性（bugs/0198）：用到 `pic.png` 时核对清单 ─────────────
# ⚠️ 消费侧入口是 `make-fixture-image.py --check`；本脚本只负责在构页阶段
#    调用它（默认开，`RMD_L2_CHECK_FIXTURE_MEDIA=0` 关闭）。真正的环境闸门
#    在 `preflight.py`（不归本脚本改）。
MEDIA_OFF_VALUES = ("0", "false", "no", "off")
media_enabled = str(media_enabled_raw).strip().lower() not in MEDIA_OFF_VALUES
media_check = {
    "enabled": media_enabled,
    "status": "not_applicable",
    "asset": "pic.png",
    "manifest": os.path.abspath(media_manifest),
    "exit_code": None,
}
pic_srcs = [s for s in srcs if os.path.basename(s) == "pic.png"]
if not media_enabled:
    media_check["status"] = "disabled"
elif pic_srcs:
    pic_path = os.path.normpath(os.path.join(fixtures_dir, pic_srcs[0]))
    media_check["path"] = os.path.abspath(pic_path)
    cmd = [sys.executable, "-I", media_generator, "--check",
           "--out", pic_path, "--manifest", media_manifest]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True)
    media_check["exit_code"] = proc.returncode
    output = (proc.stdout or "").strip()
    if output:
        print("   图片夹具检查：" + output.replace("\n", "\n   "), file=sys.stderr)
    if proc.returncode == 0:
        media_check["status"] = "ok"
    elif proc.returncode == 4:
        # 清单缺失 ≠ 图片被改：无法核对，报 WARN 但继续（清单由
        # make-fixture-image.py 首次运行时生成）。
        media_check["status"] = "manifest_unavailable"
        print("   ⚠️ 图片夹具清单不可用，无法核对 pic.png（bugs/0198）",
              file=sys.stderr)
    elif proc.returncode == 3:
        media_check["status"] = "mismatch"
        print("⛔ 图片夹具 %s 与清单不符（bugs/0198）；⛔ 不生成使用坏图的页面。"
              % os.path.abspath(pic_path), file=sys.stderr)
        sys.exit(3)
    else:
        media_check["status"] = "check_error"
        print("⛔ 图片夹具检查器退出 %d（bugs/0198）" % proc.returncode,
              file=sys.stderr)
        sys.exit(3)

# ── 载荷 provenance（bugs/0154）：没有就显式记 false ────────────────────
payload_prov = payload.get("provenance")
if not isinstance(payload_prov, dict):
    payload_prov = None
docs_canonical = json.dumps(docs, ensure_ascii=False, sort_keys=True,
                            separators=(",", ":")).encode("utf-8")
docs_sha = hashlib.sha256(docs_canonical).hexdigest()
matches = None
if payload_prov and payload_prov.get("docs_sha256"):
    matches = payload_prov["docs_sha256"] == docs_sha

# ── 载荷规模交叉核对（bugs/0260）：`count` / 每份 doc 的 `line_count` ────
# ⭐ 这些字段此前无人读，产物看着有指纹实际没有消费者。构页阶段能拿到的是
#    载荷侧（docs 长度、text 行数）；DOM 行盒数要等取像阶段 ⇒ 本文件只记
#    载荷侧两侧值，并把 DOM 侧留 null（⛔ 不伪造）。
# ⛔ 不符只 WARN 并写进 provenance，不硬失败——先给数据，等设计决定要不要红。
docs_list = docs if isinstance(docs, list) else []
count_present = isinstance(payload, dict) and "count" in payload
count_value = payload.get("count") if isinstance(payload, dict) else None
count_is_int = isinstance(count_value, int) and not isinstance(count_value, bool)
if not count_present:
    count_match = None
elif not count_is_int:
    count_match = False
else:
    count_match = count_value == len(docs_list)

line_mismatches = []
line_checked = 0
selected_line = None
for item in docs_list:
    if not isinstance(item, dict):
        continue
    line_checked += 1
    payload_line_count = item.get("line_count")
    text = item.get("text")
    text_lines = (str(text).count("\n") + 1) if isinstance(text, str) else None
    lc_is_int = isinstance(payload_line_count, int) and not isinstance(payload_line_count, bool)
    # Rust `LineIndex::line_count()` = split('\n').length；这里只做文本纯函数核对，
    # ⛔ 不是第二套渲染。
    line_match = bool(lc_is_int and text_lines is not None
                      and payload_line_count == text_lines)
    row = {
        "name": item.get("name"),
        "payload_line_count": payload_line_count,
        "text_lines": text_lines,
        "match": line_match,
    }
    if not line_match:
        line_mismatches.append(row)
    if item.get("name") == fixture:
        selected_line = row

payload_cross_check = {
    "count": {
        "present": count_present,
        "payload": count_value,
        "actual_docs": len(docs_list),
        "match": count_match,
    },
    "line_count": {
        "checked_docs": line_checked,
        "mismatch_count": len(line_mismatches),
        "mismatches": line_mismatches,
        "selected": selected_line,
    },
    "dom_line_boxes": None,
    "dom_line_boxes_note": (
        "DOM 行盒数由 dom-probe 在取像阶段产出；构页阶段拿不到，"
        "⛔ 不在这里伪造。本文件只记录载荷侧两侧值，供后续消费者交叉核对。"
    ),
}

if count_present and count_match is False:
    print("   ⚠️ 载荷 count=%r 与 docs 长度 %d 不一致（bugs/0260）"
          % (count_value, len(docs_list)), file=sys.stderr)
elif not count_present:
    print("   ⚠️ 载荷没有 count，无法交叉核对规模（bugs/0260）", file=sys.stderr)
if line_mismatches:
    print("   ⚠️ 载荷 line_count 与 text 行数不一致：%d/%d 份（bugs/0260）"
          % (len(line_mismatches), line_checked), file=sys.stderr)
    for row in line_mismatches[:5]:
        print("      %s: line_count=%r text_lines=%r"
              % (row["name"], row["payload_line_count"], row["text_lines"]),
              file=sys.stderr)
    if len(line_mismatches) > 5:
        print("      …（其余 %d 份见 __l2-provenance.json）"
              % (len(line_mismatches) - 5), file=sys.stderr)

provenance = {
    "schema": "l2-page-provenance/1",
    "fixture": fixture,
    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "appearance": {
        "font_size": float(font_size),
        "line_height": float(line_height),
        "content_width": float(content_width),
        "source": {
            "font_size": font_source,
            "line_height": lh_source,
            "content_width": cw_source,
        },
    },
    "sidebar_width": float(sidebar),
    # bugs/0257：载荷键位表状态（missing / empty / ok / invalid）。
    "shortcuts_status": shortcuts_status,
    "shortcuts_count": int(shortcuts_count),
    # bugs/0198：图片夹具完整性检查（消费侧入口 --check 的结果）。
    "media_check": media_check,
    # bugs/0260：载荷侧规模交叉核对（DOM 侧留 null）。
    "payload_cross_check": payload_cross_check,
    "fixtures_payload": {
        "path": os.path.abspath(payload_path),
        "provenance_present": payload_prov is not None,
        "build_id": (payload_prov or {}).get("build_id"),
        # `export-fixtures.sh` 现在的键名是 `binary_sha256`；旧名 `build_sha256` 也认。
        "build_sha256": (payload_prov or {}).get("binary_sha256",
                                                 (payload_prov or {}).get("build_sha256")),
        "exported_at": (payload_prov or {}).get("exported_at"),
        "stage_a_sha256": (payload_prov or {}).get("stage_a_log_sha256",
                                                   (payload_prov or {}).get("stage_a_sha256")),
        "docs_sha256": docs_sha,
        "payload_docs_sha256": (payload_prov or {}).get("docs_sha256"),
        "docs_sha_matches": matches,
    },
    "assets": asset_rows,
    "assets_skipped": skipped,
    "page_rules": {"scrollbar_hidden": True},
}

with open(os.path.join(outdir, "__l2-provenance.json"), "w", encoding="utf-8") as f:
    json.dump(provenance, f, ensure_ascii=False, indent=2, sort_keys=True)
    f.write("\n")

js = []
js.append("\n// —— L2 构页注入（design/0063 §7.2 U4②；bugs/0118 / 0122 / 0154）——\n")
js.append("(function () {\n")
js.append("  'use strict';\n")
js.append("  if (!window.__FAKE || !window.__FAKE.snapshot) {\n")
js.append("    throw new Error('L2 构页：__fake-tauri.js 没有暴露 __FAKE.snapshot');\n")
js.append("  }\n")
js.append("  window.__FAKE.snapshot.sidebar_width = %s;\n" % float(sidebar))
js.append("  var ap = window.__FAKE.snapshot.appearance ||"
          " (window.__FAKE.snapshot.appearance = {});\n")
js.append("  ap.font_size = %s;\n" % float(font_size))
js.append("  ap.line_height = %s;\n" % float(line_height))
js.append("  ap.content_width = %s;\n" % float(content_width))
js.append("  // bugs/0154：载荷 provenance 随页面带下去（缺失时 provenance_present=false）。\n")
js.append("  window.__PARITY_PROVENANCE = %s;\n"
          % json.dumps(provenance, ensure_ascii=False, sort_keys=True))
js.append("  // bugs/0118：本地资源的真实字节。未命中 ⇒ kind=not_found（保留占位降级）。\n")
js.append("  var ASSETS = %s;\n" % json.dumps(assets, ensure_ascii=False, sort_keys=True))
js.append("  window.__PARITY_ASSETS = ASSETS;\n")
js.append("  var core = window.__TAURI__ && window.__TAURI__.core;\n")
js.append("  if (core && typeof core.invoke === 'function') {\n")
js.append("    var baseInvoke = core.invoke;\n")
js.append("    core.invoke = function (cmd, args) {\n")
js.append("      if (cmd !== 'read_asset') return baseInvoke(cmd, args);\n")
js.append("      var hit = ASSETS[args && args.src];\n")
js.append("      if (hit) return Promise.resolve({data_url: hit.data_url, real_path: hit.real_path});\n")
js.append("      var err = new Error('L2 假后端：没有这份资源 ' + String(args && args.src));\n")
js.append("      err.kind = 'not_found';\n")
js.append("      err.path = String((args && args.src) || '');\n")
js.append("      return Promise.reject(err);\n")
js.append("    };\n")
js.append("  }\n")
js.append("})();\n")
with open(fake_js, "a", encoding="utf-8") as f:
    f.write("".join(js))

print("▶ 排版注入：font_size=%s line_height=%s content_width=%s" %
      (font_size, line_height, content_width), file=sys.stderr)
print("▶ 本地资源：命中 %d，跳过 %d" % (len(asset_rows), len(skipped)), file=sys.stderr)
for row in skipped:
    print("   ⚠️ 跳过 %s（%s）" % (row["src"], row["reason"]), file=sys.stderr)
if payload_prov is None:
    print("   ⚠️ 载荷没有 provenance（build_id/exported_at/sha）⇒"
          " 本次构页无法证明 HTML 与当前二进制同源（bugs/0154）", file=sys.stderr)
elif matches is False:
    print("   ⚠️ 载荷 docs_sha256 与实际 docs 不一致 ⇒ 载荷被改过（bugs/0154）",
          file=sys.stderr)
elif not payload_prov.get("build_id"):
    print("   ⚠️ 载荷 provenance 缺 build_id（%s）⇒ 无法证明与当前二进制同源（bugs/0154）"
          % (payload_prov.get("build_id_error") or "无原因字段"), file=sys.stderr)
PY

# ── ④ `__parity-boot.js`：离线取像脚本的就绪/错误标志 ─────────────────────
cat > "$OUTDIR/__parity-boot.js" <<'JS'
// design/0063 §7.2 步 1：L2 构页的就绪标志。
// 真 main.js 是异步启动的（等 `get_session` 回包再打开启动文档）⇒
// 离线取像脚本不能只看 `DOMContentLoaded`，必须等 `.doc` 真有内容。
//
// ⭐ `bugs/0117`：**"HTML 已插入" ≠ "布局已稳定"**。启动时 `Sidebar.applyWidth()`
//    会把 `--sidebar-width: 280px` 改成实测值，`body { transition: padding-left .18s }`
//    因此有一段过渡；就绪信号若在过渡中途置位，测到的列宽每次都不一样。
//    ⇒ 就绪判据改为：`.doc` 非空 ＋ `document.fonts.ready` ＋
//    `document.getAnimations()` 为空 ＋ **连续两帧布局尺寸完全相同**。
//    稳定后的列宽/内容盒高/溢出判定写进 `window.__PARITY_LAYOUT`（`bugs/0121`）。
(function () {
  'use strict';

  var 超时毫秒 = 8000;
  var 等待下一帧毫秒 = 16;
  var 起点 = (window.performance && typeof performance.now === 'function')
    ? performance.now() : Date.now();

  window.__PARITY_READY = false;
  window.__PARITY_ERROR = null;
  window.__PARITY_BOOT = {
    ready: false, waited_ms: 0, doc_found: false, doc_html_bytes: 0,
    fonts_ready: false, stable_frames: 0, frames: 0
  };
  window.__PARITY_LAYOUT = null;

  var 字体已就绪 = false;
  try {
    if (document.fonts && document.fonts.ready
        && typeof document.fonts.ready.then === 'function') {
      // ⚠️ `fonts.ready` 被拒也要放行：字体加载失败不该让页面永远不就绪；
      //    代价是"没字体"会在帧里看得见，而不是静默挂死。
      document.fonts.ready.then(function () { 字体已就绪 = true; },
                               function () { 字体已就绪 = true; });
    } else {
      字体已就绪 = true;
    }
  } catch (e) {
    字体已就绪 = true;
  }

  function 已等待毫秒() {
    var 现在 = (window.performance && typeof performance.now === 'function')
      ? performance.now() : Date.now();
    return Math.round(现在 - 起点);
  }

  function 读状态() {
    var doc = document.querySelector('.doc');
    var html = doc ? String(doc.innerHTML || '') : '';
    return {
      doc_found: !!doc,
      doc_html_bytes: html.length,
      // ⚠️ 用 trim 判"非空"：只有空白/换行的 `.doc` 与没挂载等价。
      ready: !!doc && html.trim().length > 0
    };
  }

  function 读布局() {
    var doc = document.querySelector('.doc');
    if (!doc) return null;
    var rect = doc.getBoundingClientRect();
    var cs = window.getComputedStyle(doc);
    function px(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
    var padTop = px(cs.paddingTop);
    var padBottom = px(cs.paddingBottom);
    var 内容盒高 = (padTop == null || padBottom == null)
      ? null : rect.height - padTop - padBottom;
    var 画布高 = window.innerHeight;
    var 画布宽 = window.innerWidth;
    var 滚动条宽 = null;
    try {
      滚动条宽 = document.body.offsetWidth - document.body.clientWidth;
    } catch (e) {
      滚动条宽 = null;
    }
    return {
      left: rect.left,
      width: rect.width,
      height: rect.height,
      content_box_width: doc.clientWidth,
      content_box_height: 内容盒高,
      padding_left: px(cs.paddingLeft),
      padding_right: px(cs.paddingRight),
      font_size: px(cs.fontSize),
      line_height: px(cs.lineHeight),
      canvas_width: 画布宽,
      canvas_height: 画布高,
      // ⭐ `bugs/0121`：内容装不进画布时报 overflow（可复跑判定，⛔ 只看 801 常量）。
      content_box_overflows_canvas: (内容盒高 != null && 内容盒高 > 画布高),
      border_box_overflows_canvas: rect.height > 画布高,
      overflow: (内容盒高 != null && 内容盒高 > 画布高) || rect.height > 画布高,
      scrollbar_width: 滚动条宽,
      body_scroll_height: document.body ? document.body.scrollHeight : null
    };
  }

  var 数值键 = [
    'left', 'width', 'height', 'content_box_width', 'content_box_height',
    'padding_left', 'padding_right', 'font_size', 'line_height',
    'canvas_width', 'canvas_height', 'scrollbar_width'
  ];

  function 同值(a, b) {
    if (a == null || b == null) return a === b;
    return Math.abs(a - b) < 1e-6;
  }

  function 布局相同(a, b) {
    if (!a || !b) return false;
    for (var i = 0; i < 数值键.length; i += 1) {
      var k = 数值键[i];
      if (!同值(a[k], b[k])) return false;
    }
    return true;
  }

  function 动画数() {
    try {
      if (typeof document.getAnimations === 'function') {
        var list = document.getAnimations();
        return list ? list.length : 0;
      }
    } catch (e) { /* 老引擎没有 Web Animations API ⇒ 当成 0，仍有"两帧不变"兜底 */ }
    return 0;
  }

  var 上一帧 = null;
  var 连续相同 = 0;
  var 帧数 = 0;
  var 已排 = false;

  function 收尾错误(原因) {
    var st = 读状态();
    window.__PARITY_BOOT = {
      ready: false,
      waited_ms: 已等待毫秒(),
      doc_found: st.doc_found,
      doc_html_bytes: st.doc_html_bytes,
      fonts_ready: 字体已就绪,
      stable_frames: 连续相同,
      frames: 帧数
    };
    window.__PARITY_ERROR = 原因 + '（已等待 ' + 已等待毫秒() + ' ms）';
  }

  function 标记就绪(布局, 动画) {
    window.__PARITY_LAYOUT = {
      left: 布局.left,
      width: 布局.width,
      height: 布局.height,
      content_box_width: 布局.content_box_width,
      content_box_height: 布局.content_box_height,
      padding_left: 布局.padding_left,
      padding_right: 布局.padding_right,
      font_size: 布局.font_size,
      line_height: 布局.line_height,
      canvas_width: 布局.canvas_width,
      canvas_height: 布局.canvas_height,
      content_box_overflows_canvas: 布局.content_box_overflows_canvas,
      border_box_overflows_canvas: 布局.border_box_overflows_canvas,
      overflow: 布局.overflow,
      scrollbar_width: 布局.scrollbar_width,
      body_scroll_height: 布局.body_scroll_height,
      stable_frames: 连续相同,
      frames: 帧数,
      fonts_ready: 字体已就绪,
      running_animations: 动画,
      waited_ms: 已等待毫秒()
    };
    var st = 读状态();
    window.__PARITY_BOOT = {
      ready: true,
      waited_ms: 已等待毫秒(),
      doc_found: st.doc_found,
      doc_html_bytes: st.doc_html_bytes,
      fonts_ready: 字体已就绪,
      stable_frames: 连续相同,
      frames: 帧数
    };
    window.__PARITY_READY = true;
  }

  function 一步() {
    if (window.__PARITY_READY) return;
    if (已等待毫秒() > 超时毫秒) {
      var st = 读状态();
      收尾错误(st.doc_found
        ? '8 s 内布局未稳定（.doc 已有内容，但尺寸仍在变）'
        : '8 s 内页面上没有 .doc');
      return;
    }
    帧数 += 1;
    var st = 读状态();
    if (!st.ready || !字体已就绪) {
      连续相同 = 0;
      上一帧 = null;
      安排();
      return;
    }
    var 布局 = 读布局();
    var 动画 = 动画数();
    if (布局 && 上一帧 && 布局相同(布局, 上一帧) && 动画 === 0) {
      连续相同 += 1;
    } else {
      连续相同 = 0;
    }
    上一帧 = 布局;
    // ⭐ 连续两帧不变（= 两次相邻比较都相等）＋ 没有在跑的动画 ⇒ 布局稳定。
    if (连续相同 >= 2) {
      标记就绪(布局, 动画);
      return;
    }
    安排();
  }

  function 安排() {
    if (window.__PARITY_READY || 已排) return;
    已排 = true;
    var 执行过 = false;
    function 执行() {
      if (执行过) return;
      执行过 = true;
      已排 = false;
      一步();
    }
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(执行);
      // ⚠️ 兜底：窗口被离屏/遮挡时 rAF 可能不派发；定时器保证轮询继续。
      setTimeout(执行, 等待下一帧毫秒 * 4);
    } else {
      setTimeout(执行, 等待下一帧毫秒);
    }
  }

  安排();
})();
JS

# ── ⑤ 注入 index.html（守卫：每个 needle 必须恰好命中 1 次）───────────────
python3 -I - "$OUTDIR/index.html" <<'PY'
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

# ① 三个脚本排在 `vendor/cm6.bundle.js` **之前**（照搬 block-probe）。
needle = '  <script src="vendor/cm6.bundle.js"></script>\n'
if src.count(needle) != 1:
    print("HITS=%d（期望 1）：%r" % (src.count(needle), needle), file=sys.stderr)
    sys.exit(4)
inject = ('  <script src="__fixture.js"></script>\n'
          '  <script src="__fake-tauri.js"></script>\n'
          '  <script src="__harness.js"></script>\n')
src = src.replace(needle, inject + needle)

# ② 侧栏不参与排版/取像（U4③）。⚠️ 只隐藏，不删元素：
#    真 main.js 启动时要取 `#sidebar` 等节点，删掉会让启动期抛错。
head_tail = '</head>'
if src.count(head_tail) != 1:
    print("HEAD=%d（期望 1）" % src.count(head_tail), file=sys.stderr)
    sys.exit(4)
style = ('  <style id="__l2-page-rules">\n'
         '    /* design/0063 §7.2 U4③：侧栏不参与 L2 排版与取像（元素保留供 main.js 取节点）。\n'
         '       ⛔ 不写 body.sidebar-collapsed：U4① 要求保留 body 的 padding-left 占位。 */\n'
         '    .sidebar { display: none !important; }\n'
         '    /* ⭐ bugs/0121：内容溢出画布时 WebKit 会加约 12 px 纵向滚动条，\n'
         '       把内容列从 727 挤到 715 ⇒ 同一批夹具的列宽不可比。\n'
         '       L2 是离屏取像页，不需要滚动交互 ⇒ 在这里收起滚动条，\n'
         '       列的可用宽度只由画布决定；是否溢出改由 __PARITY_LAYOUT.overflow\n'
         '       显式记录（⛔ 不静默裁切）。 */\n'
         '    html, body { overflow-y: hidden !important; }\n'
         '  </style>\n')
src = src.replace(head_tail, style + head_tail)

# ③ `__parity-boot.js` 放在 `</body>` 前：等产品脚本先跑起来，它只做轮询。
tail = '</body>\n</html>'
if src.count(tail) != 1:
    print("TAIL=%d（期望 1）" % src.count(tail), file=sys.stderr)
    sys.exit(4)
src = src.replace(tail, '  <script src="__parity-boot.js"></script>\n' + tail)

open(path, "w", encoding="utf-8").write(src)
PY

echo "▶ L2 页面已生成：$OUTDIR" >&2
echo "  夹具：${FIXTURE_NAME}；sidebar_width=${SIDEBAR_WIDTH}px（L1 实测值）" >&2
echo "  排版：font_size=${FONT_SIZE} line_height=${LINE_HEIGHT} content_width=${CONTENT_WIDTH}" >&2
echo "        （来源：font=${FONT_SOURCE} line=${LH_SOURCE} width=${CW_SOURCE}）" >&2
echo "  注入顺序：__fixture.js → __fake-tauri.js → __harness.js → vendor/cm6.bundle.js … → __parity-boot.js" >&2
echo "  键位表：status=${SHORTCUTS_STATUS} count=${SHORTCUTS_COUNT}（bugs/0257）" >&2
printf '%s\n' "$OUTDIR"

# ⭐ bugs/0257 / R5 §3.7：缺键位表是**输入契约破坏**，⛔ 不能静默补 [] 让测试变绿。
#    该判定已在参数/输入阶段**前置**（写任何页面/provenance 之前退 3），
#    所以走到这里时 status 只可能是 ok/empty；⛔ 不再有「先写整页再失败」的尾块。
