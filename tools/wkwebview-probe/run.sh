#!/usr/bin/env bash
# 跑 WKWebView 能力探针并把真值落盘（`design/0002` §7.0 第 6 步 / 批次 0）
#
# 用法：
#   tools/wkwebview-probe/run.sh                    # 落盘到 benchmarks/results/
#   tools/wkwebview-probe/run.sh --stdout           # 只打屏幕，不落盘
#   tools/wkwebview-probe/run.sh --force            # 允许覆盖已有的同名结果
#
# ⚠️ 与 `make bench` 同一条纪律：`benchmarks/results/` 是**历史记录**，
#    默认**拒绝覆盖**。要留两次对比，先把旧文件改名。
#
# ⚠️ macOS 没有 `timeout`（那是 coreutils 的 `gtimeout`）。
#    探针自己带 5 秒兜底，所以这里不需要外层超时。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

TO_STDOUT=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --stdout) TO_STDOUT=1 ;;
    --force)  FORCE=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

if ! command -v swift >/dev/null 2>&1; then
  echo "⛔ 没有 swift。这条探针需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 1
fi

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
# ⚠️ 文件名含机型（如 Mac14,9），逗号在 shell 里要引起来
OUT="$ROOT/benchmarks/results/wkwebview-capabilities-${TODAY}-${MODEL}.json"

# ⚠️ 覆盖检查必须在**跑探针之前**：探针要起一个 WKWebView、约 1 秒，
#    跑完才发现要拒绝等于白跑一趟。
if [ "$TO_STDOUT" != "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（design/0002 §8）。" >&2
  echo "   要保留两份对比：先改名，或加 --force。" >&2
  exit 1
fi

echo "▶ 跑 WKWebView 能力探针…（会创建一个不可见窗口，不会打断你）" >&2
RAW="$(swift "$HERE/probe.swift")" || {
  echo "⛔ 探针失败。常见原因：当前不在图形会话里（SSH / 无登录桌面）。" >&2
  exit 1
}

if [ "$TO_STDOUT" = "1" ]; then
  echo "$RAW"
  exit 0
fi

mkdir -p "$(dirname "$OUT")"

# 用 python3 合并元数据与探针原始输出——不引入 jq 依赖
python3 -I - "$RAW" "$OUT" "$MODEL" "$TODAY" <<'PY'
import json, platform, sys, os
raw, out, model, today = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
probe = json.loads(raw)

doc = {
    "schema": "rmd-wkwebview-probe/1",
    "date": today,
    "口径": {
        "说明": "design/0002 §7.0 第 6 步：真机 WKWebView 的观测能力真值。",
        "为什么": "kb/0003 读的是 WebKit 上游源码；上游 main ≠ 本机版本。"
                   "这条结论决定 §7.3 的整个测量方案成立与否。",
        "supportedEntryTypes": "PerformanceObserver 的静态只读属性（WebCore/page/PerformanceObserver.idl）。"
                               "⚠️ 这是探测的正确入口。",
        "observeProbe": "逐个 new PerformanceObserver().observe({type}) 的实测结果。"
                        "⭐ 关键：属性里没有的 type，observe **不抛错**——"
                        "所以不能用 try/catch 探测支持性，必须先查 supportedEntryTypes。",
        "paintEntries": "performance.getEntriesByType('paint')，看 T6 是否真的可测。",
    },
    "环境": {
        "machine_model": model,
        "os_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "python": platform.python_version(),
    },
    "探针": probe,
}
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(json.dumps(doc, ensure_ascii=False, indent=2))
print(f"\n✅ 结果写入 {out}", file=sys.stderr)
PY
