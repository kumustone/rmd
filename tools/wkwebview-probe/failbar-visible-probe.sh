#!/usr/bin/env bash
# 跑「全局失败条真的看得见吗」的**离屏可见性闸门**（`failbar-visible-probe.swift`）
#
# 用法：
#   tools/wkwebview-probe/failbar-visible-probe.sh          # 打屏
#   tools/wkwebview-probe/failbar-visible-probe.sh --json   # 机器读
#
# 退出码：0 = 全通过；1 = 有判据失败；2 = 环境自证没过；3 = 跑不起来
#
# 起因（2026-11-15 用户）：「新建文件，没有任何反应」
#   ⇒ 应用日志证明 `onNewFile()` 走到了 `raiseFail(fail.new.no-directory)`，
#     而且 `onShown` 留了痕（= `raise()` 真的渲染了）——**但用户说没反应**。
#   ⇒ 那就把"看得见"变成可断言的数：真 `index.html` ＋ 真样式表 ＋ 真 `services/failbar.js`，
#     在**每一种 body 状态**（阅读 / 编辑 / 折叠顶栏 / 专注 / 组合）下量它的矩形、
#     计算样式，以及 `elementFromPoint` 的命中者（被盖住 = 用户看不见）。
#
# ⚠️ 它是**离屏**的（窗口 `alphaValue = 0` ＋ `orderBack` ＋ `.prohibited`）：
#    ⛔ 不抢前台、⛔ 不合成按键（根 `CLAUDE.md` §4 / `kb/0025`）。
# ⚠️ 页面用**真的** `src/index.html`（只摘掉 `<script>`：没有 Tauri IPC 时真脚本会走
#    `reportFatal` 把 DOM 换掉，反而验不到），样式表按**原顺序**（顺序就是分层）。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

PASSTHRU=()
while [ $# -gt 0 ]; do
  case "$1" in
    --json) PASSTHRU+=(--json); shift ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 3 ;;
  esac
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/failbar-visible-probe"
PAGE="$WORK/page"

# ── 现搭一个页面目录：真 index.html + 真样式表 + 真失败条模块 ──
mkdir -p "$PAGE/styles" "$PAGE/services"
cp -R "$ROOT/src/styles/." "$PAGE/styles/"
cp "$ROOT/src/style.css" "$PAGE/style.css"
cp "$ROOT/src/services/failbar.js" "$PAGE/services/failbar.js"

# ⚠️ 摘 `<script>` 用 python（`sed` 处理跨行不可靠）；摘完在 `</body>` 前只补两份：
#    产品那一个 `failbar.js`（⛔ 不抄第二份实现）＋ 本探针的装填脚本。
python3 - "$ROOT/src/index.html" "$PAGE/index.html" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
html = open(src, encoding='utf-8').read()
html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
extra = ('<script src="services/failbar.js"></script>\n'
         '<script src="harness.js"></script>\n')
html = html.replace('</body>', extra + '</body>')
open(dst, 'w', encoding='utf-8').write(html)
PY

cat > "$PAGE/harness.js" <<'JS'
// 探针装填：**只做产品自己会做的事**——建失败条、raise 同一条 key。
// ⛔ 不改 `.topbar` 的结构、⛔ 不动产品 CSS。
(function () {
  'use strict';
  const TEXT = { 'fail.new.no-directory': '先打开一个目录' };
  window.__failbarProbe = function () {
    const fb = window.rmd.failBar.createFailBar({
      doc: document,
      t: function (k) { return TEXT[k] || k; },
    });
    const shown = fb.raise({
      key: 'fail.new.no-directory',
      level: 'P1',
      scope: { kind: 'none' },
      detail: 'no-root',
      area: 'new',
    });
    return { shown: shown, hidden: document.getElementById('fail-bar').hidden };
  };
})();
JS

swiftc -O "$HERE/failbar-visible-probe.swift" -o "$BIN" >"$WORK/build.log" 2>&1 || {
  echo "⛔ 编译失败：" >&2; cat "$WORK/build.log" >&2; exit 3
}

# ── ① 基线：必须全绿 ──
set +e
"$BIN" "$PAGE" "${PASSTHRU[@]+"${PASSTHRU[@]}"}"
BASE=$?
set -e
if [ "$BASE" -ne 0 ]; then
  echo "⛔ 基线没全绿（exit=${BASE}）" >&2
  exit "$BASE"
fi

# ── ② 变异：把失败条在**页面副本**里弄成 `display:none`（⛔ 仓库文件一字未动）
#    ⚠️ 没有这一步，"全绿"不说明判据在看在看（`tests.md`：没做过变异测试的断言不算数）。 ──
MPAGE="$WORK/page-m1"
cp -R "$PAGE" "$MPAGE"
python3 - "$MPAGE/style.css" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
old = ".fail-bar {\n  display: flex;"
assert s.count(old) == 1, "变异靶子命中 %d 次（应为 1）" % s.count(old)
open(p, 'w', encoding='utf-8').write(s.replace(old, ".fail-bar {\n  display: none;"))
PY
# ⚠️ 证明副本**真的变了**（否则"变异没转红"与"变异没打上"长得一模一样）
[ "$(cksum "$PAGE/style.css")" != "$(cksum "$MPAGE/style.css")" ] \
  || { echo "⛔ 变异没打上（副本与原文件相同）" >&2; exit 3; }

set +e
"$BIN" "$MPAGE" --json >"$WORK/m1.json" 2>"$WORK/m1.err"
MUT=$?
set -e

echo "── 变异自测 ──"
if [ "$MUT" -eq 0 ]; then
  echo "⛔ M1（失败条 display:none）没有把判据打红 ⇒ 可见性判据不敏感" >&2
  exit 1
fi
REDS="$(grep -c '"ok" : false' "$WORK/m1.json" 2>/dev/null || true)"
echo "✓ M1（失败条 display:none）⇒ 判据转红（exit=${MUT}，红 ${REDS:-?} 条）"
echo "✅ 基线全绿 ＋ 变异转红"
