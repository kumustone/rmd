#!/bin/bash
# rmd · 「编辑选区与输入能力复用」隔离对照臂 —— 一键打包 + 离屏运行（`design/0054` §6.2 阶段 1）。
#
# 用法：
#   bash tools/native-arm/probe.sh            # 跑一轮，打印判据表
#   bash tools/native-arm/probe.sh --save     # 另存原始 JSON 到 $TMPDIR
#   bash tools/native-arm/probe.sh --raw      # 只打原始 JSON
#
# ⛔ **不安装、不提交、不推送、不发布**；⛔ 不改 `src/**` 一个字节。
# ⭐ 产物落在本目录的 `.na-work/`（已 gitignore），与 `tools/live-probe/.lb-work/` 同一族。
# ⚠️⚠️ **不能用 `$TMPDIR`**：WKWebView 只放行**仓库内**的 `file://`，`$TMPDIR` 会报
#    "Ignoring request to load this main resource because it is outside the sandbox"（实测踩过）。
#
# ⚠️ 离屏策略沿用 `tools/live-probe/probe.swift`（`.prohibited` ＋ `alphaValue = 0` ＋ `orderBack`）：
#    不弹窗、不抢前台、不合成系统级按键。运行器自己会把「前台应用前后相同 / 进程未激活 /
#    窗口不是 key」写进 `环境` 一栏，本轮判据里也含这一项。
# ⚠️ 屏幕锁着 / 显示器睡眠时跑不了（WebKit 停掉显示链路）——运行器 180 秒兜底会退 1。

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARM="${ROOT}/tools/native-arm"
WORK="${ARM}/.na-work"
SAVE=0
RAW=0
for a in "$@"; do
  case "${a}" in
    --save) SAVE=1 ;;
    --raw) RAW=1 ;;
    *) echo "未知参数：${a}" >&2; exit 64 ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "⛔ 缺 ${1}：$2" >&2; exit 65; }; }
need node "构建侧要 node（design/0012 §2.5）"
need swiftc "要 Xcode 命令行工具（同 make probe-live-block）"
if [ ! -x "${ROOT}/node_modules/.bin/esbuild" ]; then
  echo "⛔ 缺 node_modules/.bin/esbuild —— 先 npm ci" >&2
  exit 65
fi

# ⛔ 自检：隔离臂的入口绝不能出现在产品源码里（否则等于偷偷开放 B 栏）
if grep -R "native-arm" "${ROOT}/src" >/dev/null 2>&1; then
  echo "⛔ src/ 里出现了 native-arm 引用：B 栏被悄悄开放了" >&2
  exit 66
fi

mkdir -p "${WORK}"
rm -f "${WORK}/arm-cm6.js" "${WORK}/result.json"

echo "── 1/3 打包隔离臂（⛔ 不进 src/vendor）" >&2
"${ROOT}/node_modules/.bin/esbuild" "${ARM}/arm.entry.mjs" \
  --bundle --format=iife --global-name=__ARM_CM6 --target=safari17 \
  --outfile="${WORK}/arm-cm6.js" --log-level=warning || exit 65

cp "${ARM}/index.html" "${WORK}/index.html"
cp "${ARM}/arm.js" "${WORK}/arm.js"
# ⭐ E4（文档级集成）：把 `e4-doc.md` 的**磁盘字节**喂给页面 —— 这样「保存字节」那一行比的是
#    真文件，⛔ 不是"页面里的字符串跟它自己比"。字段：`.doc`（解码后的文本）、`.b64`（原始字节）。
node -e '
const fs = require("fs");
const b = fs.readFileSync(process.argv[1]);
fs.writeFileSync(process.argv[2],
  "window.__E4=" + JSON.stringify({ doc: b.toString("utf8"), b64: b.toString("base64") }) + ";\n");
' "${ARM}/e4-doc.md" "${WORK}/e4-bytes.js" || exit 65
# ⭐ 自建臂 / 混合臂跑的是**产品那两份**，⛔ 不是第二份实现
cp "${ROOT}/src/live/selection.js" "${WORK}/selection.js"
cp "${ROOT}/src/live/input.js" "${WORK}/input.js"

echo "── 2/3 编译离屏运行器" >&2
swiftc -O "${ROOT}/tools/live-probe/probe.swift" -o "${WORK}/arm-probe" || exit 65

echo "── 3/3 离屏运行（不弹窗、不抢前台）" >&2
# 四条臂**纵向叠放**（N / S / H / HM），每臂内容宽 640px；总高远超一屏 ⇒ 夹具每次动作前
# 把**本臂** `scrollIntoView` 到视口顶部（`arm.js::reset`），⛔ 不是靠窗口够高。
PROBE_W=1400 PROBE_H=1000 \
"${WORK}/arm-probe" "${WORK}" >"${WORK}/result.json" 2>"${WORK}/result.err" &
PID=$!
# ⚠️ macOS 没有 timeout(1)：自造看门狗（运行器内部另有 180 秒兜底）
N=0
while kill -0 "${PID}" 2>/dev/null; do
  sleep 0.5
  N=$((N + 1))
  if [ "${N}" -ge 480 ]; then
    kill -9 "${PID}" 2>/dev/null
    echo "⛔ 240 秒没拿到结果" >&2
    tail -20 "${WORK}/result.err" >&2
    exit 3
  fi
done
wait "${PID}"
RC=$?

if [ ! -s "${WORK}/result.json" ]; then
  echo "⛔ 运行器没有产出 JSON（退出码 ${RC}）" >&2
  tail -30 "${WORK}/result.err" >&2
  exit 3
fi

if [ "${RAW}" = "1" ]; then
  cat "${WORK}/result.json"
  exit 0
fi

# ⭐ 2026-10-29 复评 P2-2：「为报告器本身写不符/异常/缺行/未知/观测负例测试」。
#    先测报告器，再让它判真实产物 —— 报告器自己坏了的话，下面的绿是假的。
echo "── 报告器自测（负例夹具，⛔ 不是 happy-path）" >&2
python3 "${ARM}/report_selftest.py" >&2
SRC=$?
if [ "${SRC}" -ne 0 ]; then
  echo "⛔ 报告器自测未过（退出 ${SRC}）⇒ 本轮报告**不可信**，先修 report.py / report_selftest.py" >&2
  exit 4
fi

python3 "${ARM}/report.py" "${WORK}/result.json"
FRC=$?

if [ "${SAVE}" = "1" ]; then
  cp "${WORK}/result.json" "${WORK}/arm-probe-$(date +%Y-%m-%d-%H%M%S).json"
  echo "证据留在 ${WORK}/" >&2
fi

# ⚠️ stderr 里是页内 console 与运行器日志；只在有内容时打最后几行
if [ -s "${WORK}/result.err" ]; then
  echo "── 页内日志（尾部）" >&2
  tail -10 "${WORK}/result.err" >&2
fi

echo "⚠️ 环境自证在 JSON 的「环境」一栏；⭐ 退出码口径见 report.py 末尾那三行（0 = 无 fail/未知/异常 ∧ 环境有效，⚠️ 未测/观测/不可比**不算通过**）。" >&2
exit "${FRC}"
