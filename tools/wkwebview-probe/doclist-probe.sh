#!/usr/bin/env bash
# 「文档列表」的**离屏接线闸门**（`design/0041` §7）
#
# ⭐ 2026-10-24 改写：`components/DocList.js` 落地后，本探针**跑产品那六份源码**
#    （`services/{i18n,versions,chunked,doclists,search,dirsession,tauri,session}.js`
#    ＋ `components/DocList.js`）与**产品那四张样式表**
#    ⇒ 它从"取证探针"升级成**闸门**：判据 A–D 进退出码（`.claude/rules/tests.md` 的四层划分）。
#
# 用法：
#   tools/wkwebview-probe/doclist-probe.sh            # 四档 × 3 轮 ＋ 四条判据
#   tools/wkwebview-probe/doclist-probe.sh --json     # 只打原始 JSON
#   tools/wkwebview-probe/doclist-probe.sh --save     # 另存一份到 benchmarks/results/
#   tools/wkwebview-probe/doclist-probe.sh --save --force
#
# 退出码：0 = 拿到结果、四条判据全绿且**没抢前台**；1 = 判据红 / 前台被抢；3 = 跑不起来
#
# ⚠️ 离屏、不弹窗、不抢前台、不合成系统按键（同 `probe-i18n` 那一族）。
# ⚠️ 假后端（`window.__TAURI__.core.invoke` 由 harness 装）⇒ 数字**不含真 IPC**。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
RESULTS="${ROOT}/benchmarks/results"
TODAY="$(date +%F)"

TO_JSON=0
SAVE=0
FORCE=0
for arg in "$@"; do
  case "${arg}" in
    --json)  TO_JSON=1 ;;
    --save)  SAVE=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：${arg}" >&2; exit 3 ;;
  esac
done

command -v swiftc >/dev/null 2>&1 || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2; exit 3; }

WORK="$(mktemp -d /tmp/rmd-doclist-probe.XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT
PAGE="${WORK}/page"
mkdir -p "${PAGE}/services" "${PAGE}/components" "${PAGE}/styles"

# ⭐ **产品那几份**，原样拷进去（⛔ 探针不抄第二份实现）。顺序即 `index.html` 的依赖顺序。
cp "${ROOT}/src/services/i18n.js"       "${PAGE}/services/i18n.js"
cp "${ROOT}/src/services/versions.js"   "${PAGE}/services/versions.js"
cp "${ROOT}/src/services/chunked.js"    "${PAGE}/services/chunked.js"
cp "${ROOT}/src/services/doclists.js"   "${PAGE}/services/doclists.js"
cp "${ROOT}/src/services/search.js"     "${PAGE}/services/search.js"      # `session.js` 加载期取
cp "${ROOT}/src/services/dirsession.js" "${PAGE}/services/dirsession.js"  # 同上
cp "${ROOT}/src/services/tauri.js"      "${PAGE}/services/tauri.js"
cp "${ROOT}/src/services/session.js"    "${PAGE}/services/session.js"
cp "${ROOT}/src/components/DocList.js"  "${PAGE}/components/DocList.js"
cp "${HERE}/doclist-harness.js"         "${PAGE}/doclist-harness.js"

# ⭐ **产品那四张样式表**（与 `index.html` 同序）——行高、字号、省略号都来自它们，
#    所以"行结构"这一半也不再是拟定的。
cp "${ROOT}/src/styles/tokens.css"     "${PAGE}/styles/tokens.css"
cp "${ROOT}/src/styles/themes.css"     "${PAGE}/styles/themes.css"
cp "${ROOT}/src/styles/typography.css" "${PAGE}/styles/typography.css"
cp "${ROOT}/src/styles/sidebar.css"    "${PAGE}/styles/sidebar.css"

cat > "${PAGE}/index.html" <<'HTML'
<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<title>doclist probe</title>
<link rel="stylesheet" href="styles/tokens.css">
<link rel="stylesheet" href="styles/themes.css">
<link rel="stylesheet" href="styles/typography.css">
<link rel="stylesheet" href="styles/sidebar.css">
<style>
  /* ⚠️ 只补"探针自身的容器"：产品里这些行住在 `#sidebar` 里，探针没有那层外壳。
     ⛔ 这里**不许**写任何 `.doclist-*` 的样式——那是产品的事（`styles/sidebar.css`）。 */
  html, body { margin: 0; padding: 0; background: var(--ui-bg); color: var(--ui-text); }
  #doclist-probe-host { margin: 8px; }
</style>
</head>
<body>
<script src="services/i18n.js"></script>
<script src="services/versions.js"></script>
<script src="services/chunked.js"></script>
<script src="services/doclists.js"></script>
<script src="services/search.js"></script>
<script src="services/dirsession.js"></script>
<script src="services/tauri.js"></script>
<script src="services/session.js"></script>
<script src="components/DocList.js"></script>
<script src="doclist-harness.js"></script>
</body>
</html>
HTML

BIN="${WORK}/doclist-probe"
swiftc -O "${HERE}/doclist-probe.swift" -o "${BIN}" 2> "${WORK}/swiftc.log" || {
  echo "✗ swiftc 编译失败：" >&2; cat "${WORK}/swiftc.log" >&2; exit 3;
}

echo "▶ 页面：产品那六份 JS ＋ 四张样式表（⛔ 探针不抄第二份实现）" >&2
echo "▶ 离屏 .prohibited ＋ alphaValue=0 ＋ orderBack（不弹窗、不抢前台、不合成按键）" >&2

JSON="$("${BIN}" "${PAGE}" 2> "${WORK}/probe.log")" || {
  echo "✗ 探针失败：" >&2; cat "${WORK}/probe.log" >&2; exit 3;
}

if [ "${TO_JSON}" -eq 1 ]; then
  printf '%s\n' "${JSON}"
else
  PROBE_JSON="${JSON}" python3 -I - <<'PY'
import json, os, sys
d = json.loads(os.environ["PROBE_JSON"])
env = d.get("环境", {})
print("环境")
print("  前台应用（起跑前 → 收工时）：%s → %s" % (
    env.get("前台应用_起跑前"), env.get("前台应用_收工时")))
print("  前台被抢过：%s ｜ 进程被激活：%s ｜ 窗口是 key：%s ｜ alpha：%s" % (
    env.get("前台被抢过"), (env.get("窗口") or {}).get("进程被激活"),
    (env.get("窗口") or {}).get("窗口是_key"), (env.get("窗口") or {}).get("alpha")))
print("  分片参数：CHUNK_FIRST=%s ｜ CHUNK_STEP=%s ｜ MAX_RENDER=%s" % (
    (env.get("分片参数") or {}).get("CHUNK_FIRST"),
    (env.get("分片参数") or {}).get("CHUNK_STEP"),
    (env.get("分片参数") or {}).get("MAX_RENDER")))
print("  ⚠️ %s" % env.get("注意"))
print()
print("| 行数 | 行高(px) | 实际行数 | 说明行 | 首批可见 | 全部完成 | 超时轮数 |")
print("|---|---|---|---|---|---|---|")
for r in d.get("结果", []):
    print("| %d | %s | %s | %s | %s | %s | %s |" % (
        r["行数"], r["行高"], r["行数_实际"], r["说明行数"],
        r["首批可见"], r["全部完成"], r["超时轮数"]))
print()
print("单位：毫秒（3 轮中位数；布局已强制；⛔ 不含真 IPC 与上屏；⛔ 内存未量）")
print()
print("判据（跑产品那几份源码）")
bad = []
for c in d.get("判据", []):
    mark = "✅" if c.get("ok") else "⛔"
    extra = " ".join("%s=%s" % (k, v) for k, v in c.items()
                     if k not in ("判据", "ok"))
    print("  %s %s%s" % (mark, c.get("判据"), ("  · " + extra) if extra else ""))
    if not c.get("ok"):
        bad.append(c.get("判据"))
print()
ok = not env.get("前台被抢过") and not (env.get("窗口") or {}).get("进程被激活")
print("判据 E（没抢前台）：%s" % ("✅ 通过" if ok else "⛔ 失败——这次跑的数不要引用"))
if bad:
    print("⛔ 判据红：%s" % "；".join(bad))
sys.exit(0 if (ok and not bad) else 1)
PY
  RC=$?
  if [ "${RC}" -ne 0 ]; then exit 1; fi
fi

if [ "${SAVE}" -eq 1 ]; then
  mkdir -p "${RESULTS}"
  # ⚠️ 机型取 `hw.model`（`Mac14,9`），⛔ 不是 CPU 品牌串——`benchmarks/results/` 里
  #    同族的文件都是这个口径（如 `tree-bench-2026-10-24-Mac14,9.json`）。
  MODEL="$(sysctl -n hw.model 2>/dev/null | tr -d ' ')"
  OUT="${RESULTS}/doclist-render-${TODAY}-${MODEL}.json"
  if [ -e "${OUT}" ] && [ "${FORCE}" -eq 0 ]; then
    echo "⛔ 已存在，拒绝覆盖：${OUT}（要覆盖加 --force；历史记录先改名）" >&2; exit 3;
  fi
  printf '%s\n' "${JSON}" > "${OUT}"
  echo "✅ 已留证据：${OUT}" >&2
fi
