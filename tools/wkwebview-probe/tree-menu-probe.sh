#!/usr/bin/env bash
# 跑「文件树右键菜单：复制绝对路径 ＋ 重命名」的**真 DOM 离屏探针**
# （`design/0034` §8 第 5 条欠的那份；`design/0035` §3.8 的 A4 / B8–B13）
#
# 用法：
#   tools/wkwebview-probe/tree-menu-probe.sh                 # 四轮：基线 + 三处变异，判据进退出码
#   tools/wkwebview-probe/tree-menu-probe.sh --no-mutate      # 只跑基线（快）
#   tools/wkwebview-probe/tree-menu-probe.sh --save           # 另存一份到 benchmarks/results/
#   tools/wkwebview-probe/tree-menu-probe.sh --save --force   # 允许覆盖同名结果
#   tools/wkwebview-probe/tree-menu-probe.sh --json           # 只打原始 JSON
#
# 退出码：0 = 全通过；1 = 有检查**失败**；2 = 有检查**跳过**；3 = 跑不起来；4 = 变异没落到文件里
#
# ⚠️⚠️ **默认不落盘**：`benchmarks/results/` 是**历史记录**（`docs/README.md` §6），
#    而这一条是个**闸门**（改一次 `FileTree.js` / `treerefresh.js` / `clipboard.js` 就跑一次）。
#    ⇒ 要存证据时才 `--save`（那时仍拒绝覆盖，除非 `--force`）。
#
# ⚠️⚠️ **不碰用户真剪贴板**：页面里的 `CLIP.defaultCopier()` 被 harness 换成记账桩子
#    （见 `tree-menu-harness.js` 文件头）⇒ 真实写入仍只能人工验收（`design/0035` §7 H1）。
#
# ⚠️ 它跑的是**产品那几份**，原样拷进页面：
#    `src/services/{i18n,versions,chunked,dirsession,tauri,search,session,treerefresh,clipboard}.js`
#    ＋ `src/components/FileTree.js`。⛔ 探针不抄第二份实现——`main.js` 那层接线不进探针页，
#    本探针也**不镜像**它：它只驱动 `FileTree` 自己的公开行为。
#
# ⚠️ 判据 M1/M2/M3 是**变异测试**，作用在**页面副本**上（⛔ 不碰仓库文件）：
#    M1 = 删掉 `copyTarget` 的 `if (!hit) return null;` ⇒ A1（空白处右键）必须红；
#    M2 = 把重命名项的 `disabled` 恒置假       ⇒ B8（编辑态置灰）必须红；
#    M3 = `selectStem` 改成"第一个点"           ⇒ B2（主名选区）必须红。
#    ⚠️ 变异前先校验"模式命中**恰好 1 次**"，并用 `cksum` 证明**真改到了**——
#       否则"没红"会与"断言不承重"长得一模一样（见 `.claude/rules/tests.md`）。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

TO_JSON=0
SAVE=0
FORCE=0
MUTATE=1
for arg in "$@"; do
  case "$arg" in
    --json)      TO_JSON=1 ;;
    --save)      SAVE=1 ;;
    --force)     FORCE=1 ;;
    --no-mutate) MUTATE=0 ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

I18N="$ROOT/src/services/i18n.js"
VERSIONS="$ROOT/src/services/versions.js"
CHUNKED="$ROOT/src/services/chunked.js"
DIRSESSION="$ROOT/src/services/dirsession.js"
TAURIJS="$ROOT/src/services/tauri.js"
SEARCHJS="$ROOT/src/services/search.js"
SESSIONJS="$ROOT/src/services/session.js"
TREEREFRESH="$ROOT/src/services/treerefresh.js"
CLIPBOARD="$ROOT/src/services/clipboard.js"
FILETREE="$ROOT/src/components/FileTree.js"
HARNESS="$HERE/tree-menu-harness.js"
SWIFT="$HERE/tree-menu-probe.swift"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 3
fi
for f in "$I18N" "$VERSIONS" "$CHUNKED" "$DIRSESSION" "$TAURIJS" "$SEARCHJS" "$SESSIONJS" \
         "$TREEREFRESH" "$CLIPBOARD" "$FILETREE" "$HARNESS" "$SWIFT"; do
  if [ ! -f "$f" ]; then
    echo "⛔ 缺 $f" >&2
    exit 3
  fi
done

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/tree-menu-${TODAY}-${MODEL}.json"
if [ "$SAVE" = "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 3
fi

WORK="$HERE/.tm-work"
mkdir -p "$WORK"

# ── ① 组装一份页面：产品文件全部**拷进去**（⛔ 不用符号链接：
#      `allowingReadAccessTo` 是按目录给的，链接指到目录外读不到） ──
build_page() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  cp "$I18N"       "$dir/i18n.js"
  cp "$VERSIONS"   "$dir/versions.js"
  cp "$CHUNKED"    "$dir/chunked.js"
  cp "$DIRSESSION" "$dir/dirsession.js"
  cp "$TAURIJS"    "$dir/tauri.js"
  cp "$SEARCHJS"   "$dir/search.js"
  cp "$SESSIONJS"  "$dir/session.js"
  cp "$TREEREFRESH" "$dir/treerefresh.js"
  cp "$CLIPBOARD"  "$dir/clipboard.js"
  cp "$FILETREE"   "$dir/filetree.js"
  cp "$HARNESS"    "$dir/harness.js"

  # ⚠️ `<script>` 顺序照 `src/index.html` 的相对次序（经典脚本按顺序执行、依赖是**加载期取值**）：
  #    `i18n → versions → chunked → dirsession → tauri → search → session
  #     → treerefresh → clipboard → FileTree`。
  #    ⛔ 别调换：`session.js` 在加载期取 `window.rmd.{tauri,versions,search,dirSession}`，
  #    `FileTree.js` 又取 `window.rmd.{i18n,versions,chunked,session,dirSession,treeRefresh,clipboard}`。
  cat > "$dir/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>rmd · tree-menu probe</title>
<style>
  html, body { margin: 0; }
  #pane-tree { height: 640px; width: 320px; overflow-y: auto;
               font: 400 13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; }
  #pane-tree .row { display: flex; gap: 4px; align-items: center; height: 20px; }
  #pane-tree .twisty { width: 10px; }
  #pane-tree .node-icon { width: 12px; height: 12px; display: inline-block; }
  #pane-tree .node-icon svg { width: 12px; height: 12px; }
  #pane-tree .children { display: none; padding-left: 14px; }
  #pane-tree .node.expanded > .children { display: block; }
  #pane-tree .node.current > .row { background: #dde; }
  #pane-tree .node.ignored > .row { opacity: .5; }
  #pane-tree .note { color: #888; font-size: 11px; }
  #pane-tree .tree-error { color: #a00; font-size: 11px; }
  .tree-menu { position: fixed; background: #fff; border: 1px solid #ccc; padding: 2px 0; }
  .tree-menu-item { display: block; width: 100%; text-align: left; border: 0; background: transparent;
                    font: inherit; padding: 3px 12px; }
  .tree-menu-item.disabled { opacity: .5; }
</style>
<div id="pane-tree" class="pane"></div>
<!-- ⚠️ 加载期错误只能靠这个面看见：经典脚本抛异常时**页面不报给 Swift**，
     表现与"忘了 `make` 某一步"逐字相同（`frontend.md` 那条结构性约束的同族）。 -->
<script>
  window.rmd = {};
  window.__LOADERR = [];
  window.addEventListener('error', function (e) {
    window.__LOADERR.push(String(e.message) + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0));
  });
</script>
<script src="i18n.js"></script>
<script src="versions.js"></script>
<script src="chunked.js"></script>
<script src="dirsession.js"></script>
<script src="tauri.js"></script>
<script src="search.js"></script>
<script src="session.js"></script>
<script src="treerefresh.js"></script>
<script src="clipboard.js"></script>
<script src="filetree.js"></script>
<script src="harness.js"></script>
HTML
}

# ── ② 编译探针 ──
BIN="$WORK/tree-menu-probe"
if [ ! -x "$BIN" ] || [ "$SWIFT" -nt "$BIN" ]; then
  echo "▶ 编译探针…" >&2
  swiftc -O "$SWIFT" -o "$BIN" >"$WORK/tm-build.log" 2>&1 || {
    echo "⛔ 编译失败：" >&2; cat "$WORK/tm-build.log" >&2; exit 3
  }
fi

# ── ③ 跑一轮（探针自带 150 秒兜底；这里再套一层 240 秒看门狗）──
run_round() {
  local page="$1" raw="$2" err="$3"
  echo "▶ 跑探针（⚠️ 全程**一个不可见窗口**、无前台切换、无合成按键、**不碰真剪贴板**）…" >&2
  "$BIN" "$page" >"$raw" 2>"$err" &
  local pid=$!
  local i
  for i in $(seq 1 480); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "⛔ 240 秒没结束，强杀。" >&2
    kill -9 "$pid" 2>/dev/null || true
    exit 3
  fi
  wait "$pid" 2>/dev/null || true
  if ! grep -q '^{' "$raw" 2>/dev/null; then
    echo "⛔ 探针没产出 JSON（${page}）。stderr：" >&2
    sed -n '1,40p' "$err" >&2
    exit 3
  fi
  sed -n '1,6p' "$err" >&2 || true
}

# ── ④ 变异：⛔ 只打**页面副本**；命中数必须恰好 1，`cksum` 必须变 ──
apply_mutation() {
  local file="$1" old="$2" new="$3"
  local before after
  before="$(cksum "$file" | awk '{print $1}')"
  python3 -I - "$file" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as f:
    src = f.read()
hits = src.count(old)
if hits != 1:
    print("HITS=%d" % hits, file=sys.stderr)
    sys.exit(4)
with open(path, "w", encoding="utf-8") as f:
    f.write(src.replace(old, new))
print("HITS=1", file=sys.stderr)
PY
  after="$(cksum "$file" | awk '{print $1}')"
  if [ "$before" = "$after" ]; then
    echo "⚠️⚠️ 变异**没改到文件**：$file" >&2
    exit 4
  fi
}

BASE_PAGE="$WORK/tm-page"
build_page "$BASE_PAGE"

RAW_BASE="$WORK/tm-base.json"
run_round "$BASE_PAGE" "$RAW_BASE" "$WORK/tm-base.err"

RAW_M1="$WORK/tm-m1.json"
RAW_M2="$WORK/tm-m2.json"
RAW_M3="$WORK/tm-m3.json"
RAW_M4="$WORK/tm-m4.json"
if [ "$MUTATE" = "1" ]; then
  # M1：删掉 `copyTarget` 的 `!hit` 守卫（= 空白处右键会空引用的形态）⇒ 判据 A1 必须红。
  P1="$WORK/tm-page-m1"
  build_page "$P1"
  echo "▶ M1：删掉 copyTarget 的 !hit 守卫…" >&2
  # ⚠️ 模式必须**唯一**：`design/0048` 起 `revealTarget` 也有同样的三行守卫 ⇒
  #    只钉这三行会 HITS=2（`apply_mutation` 退出 4）。所以把 `copyTarget` 的返回行一起带上。
  apply_mutation "$P1/treerefresh.js" \
    "    if (!hit) return null;
    if (hit.ignored) return null;
    if (typeof hit.path !== 'string' || !hit.path) return null;
    return hit.path;" \
    "    if (hit.ignored) return null;
    if (typeof hit.path !== 'string' || !hit.path) return null;
    return hit.path;"
  run_round "$P1" "$RAW_M1" "$WORK/tm-m1.err"

  # M2：重命名项的 `disabled` 恒置假（= 编辑态置灰失效）⇒ 判据 B8 必须红。
  P2="$WORK/tm-page-m2"
  build_page "$P2"
  echo "▶ M2：把重命名项的 disabled 恒置假…" >&2
  # ⚠️ 2026-10-25（`design/0043` 落地）起这一项是**多行 addItem(...)**，参数缩进 12 格 ⇒
  #    旧的 10 格模式已命中 0 次（`HITS=0` 那次就是它）。模式与产品源码同步改。
  apply_mutation "$P2/filetree.js" \
    "            ren.disabled,
            ren.disabled ? 'tree.menu.rename.disabled-editing' : ''" \
    "            false,
            ''"
  run_round "$P2" "$RAW_M2" "$WORK/tm-m2.err"

  # M3：`selectStem` 改成"第一个点"（= 主名选区算错）⇒ 判据 B2 必须红。
  P3="$WORK/tm-page-m3"
  build_page "$P3"
  echo "▶ M3：selectStem 改成按第一个点切…" >&2
  apply_mutation "$P3/treerefresh.js" \
    "    const i = s.lastIndexOf('.');" \
    "    const i = s.indexOf('.');"
  run_round "$P3" "$RAW_M3" "$WORK/tm-m3.err"

  # M4：删掉树行菜单里的「在访达中显示」（= 接线断了）⇒ 判据 C1 必须红。
  P4="$WORK/tm-page-m4"
  build_page "$P4"
  echo "▶ M4：删掉树行菜单的「在访达中显示」…" >&2
  apply_mutation "$P4/filetree.js" \
    "        if (rv) {
          addItem('tree.menu.reveal', function () { revealInFinder(rv.path); });
        }
" \
    ""
  run_round "$P4" "$RAW_M4" "$WORK/tm-m4.err"
fi

# ── ⑤ 判据汇总：**退出码就是结论** ──
python3 -I - "$RAW_BASE" "$RAW_M1" "$RAW_M2" "$RAW_M3" "$RAW_M4" "$MUTATE" "$TO_JSON" "$SAVE" "$OUT" "$MODEL" "$TODAY" <<'PY'
import json, os, platform, sys

(raw_base, raw_m1, raw_m2, raw_m3, raw_m4, mutate, to_json, save, out, model, today) = sys.argv[1:12]
raw = json.load(open(raw_base, encoding="utf-8"))

if "致命" in raw:
    print("⛔ 致命：" + str(raw["致命"]), file=sys.stderr)
    sys.exit(3)

检查 = list(raw.get("检查") or [])
env = raw.get("环境") or {}
窗口 = env.get("窗口") or {}

# ⭐ 判据 E 在 Swift 那边算（页面够不到 frontmostApplication）——这里并进来。
#    ⚠️ 它带**非数字标签**，与 `probe-dir-session` 的 E 同族：⛔ 不占用 A/B 的编号。
抢 = env.get("前台被抢过")
try:
    alpha0 = float(窗口.get("alpha", -1)) == 0.0
except (TypeError, ValueError):
    alpha0 = False
okE = ((抢 is False) and alpha0 and (窗口.get("调过_NSApp_activate") is False)
       and (窗口.get("进程被激活") is False) and (窗口.get("窗口是_key") is False))
检查.append({
    "id": "E",
    "名": "前台没有被抢（离屏不打扰用户）",
    "结果": "通过" if okE else "失败",
    "判据": "frontmostApplication 起跑前后相同 ∧ 窗口 alpha=0 ∧ 没调 NSApp.activate"
            " ∧ 进程没被激活 ∧ 窗口不是 key（⛔ 不抢用户键盘焦点）",
    "值": {"前台被抢过": 抢, "窗口": 窗口,
           "前台应用_起跑前": env.get("前台应用_起跑前"),
           "前台应用_收工时": env.get("前台应用_收工时")},
})

# ⚠️ 防"探针半路停了还报全绿"：下面每一条都必须真的产出。
EXPECTED = ["A1", "A2", "A3", "A4", "A5", "A5b", "A6", "A7", "A8", "A9", "A10",
            "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10",
            "C1", "C2", "C3", "C4", "C5", "C6"]
有 = set(str(c.get("id")) for c in 检查)
for cid in EXPECTED:
    if cid not in 有:
        检查.append({
            "id": cid,
            "名": "（探针没有产出这一条判据）",
            "结果": "失败",
            "判据": "§3.8 的 A4 / B8–B13 必须逐条产出",
            "值": {"缺": cid},
        })

def 结果表(path):
    try:
        doc = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        return None, "读不出：%s" % e
    if "致命" in doc:
        return None, "致命：" + str(doc["致命"])
    return {str(c.get("id")): c.get("结果") for c in (doc.get("检查") or [])}, None

def 变异判据(cid, path, target, 说明):
    """一条变异算通过 = 基线里 target 通过 ∧ 变异后 target 失败（⚠️ 只认**那一格**变了）。"""
    if mutate != "1":
        return {"id": cid, "名": "（没跑变异：--no-mutate）", "结果": "跳过",
                "判据": 说明 + "；本次用 --no-mutate 跳过", "值": {}}
    table, why = 结果表(path)
    if table is None:
        return {"id": cid, "名": "变异轮没跑起来", "结果": "失败",
                "判据": 说明, "值": {"原因": why}}
    base_target = 基线.get(target)
    got = table.get(target)
    ok = (base_target == "通过") and (got == "失败")
    return {
        "id": cid, "名": 说明,
        "结果": "通过" if ok else "失败",
        "判据": "基线里判据 %s 通过 ∧ 变异后判据 %s 失败（其余判据不参与本判据）" % (target, target),
        "值": {"基线": base_target, "变异后": got,
               "变异后全体": table,
               "⚠️ 口径": "变异打在**页面副本**上（⛔ 仓库文件一字未动）；"
                          "施加前校验模式命中恰好 1 次，并用 cksum 证明文件真变了"},
    }

基线 = {str(c.get("id")): c.get("结果") for c in 检查}
检查.append(变异判据(
    "M1", raw_m1, "A1",
    "变异：删掉 copyTarget 的 !hit 守卫 ⇒ 判据 A1（空白处右键不空引用）必须红"))
检查.append(变异判据(
    "M2", raw_m2, "B8",
    "变异：重命名项的 disabled 恒置假 ⇒ 判据 B8（编辑态置灰）必须红"))
检查.append(变异判据(
    "M3", raw_m3, "B2",
    "变异：selectStem 按第一个点切 ⇒ 判据 B2（主名选区）必须红"))
检查.append(变异判据(
    "M4", raw_m4, "C1",
    "变异：删掉树行菜单的「在访达中显示」⇒ 判据 C1（design/0048 接线）必须红"))

def key(c):
    i = str(c.get("id"))
    # 数字型（A1/B10 这类）按字面序排；非数字（E/M1）排后面
    if i and i[0] in "ABC" and i[1:].isdigit():
        return (0, i[0], int(i[1:]))
    return (1, i, 0)

检查.sort(key=key)
通过 = [c for c in 检查 if c["结果"] == "通过"]
失败 = [c for c in 检查 if c["结果"] == "失败"]
跳过 = [c for c in 检查 if c["结果"] == "跳过"]

doc = {
    "schema": "rmd-tree-menu-probe/1",
    "date": today,
    "口径": {
        "说明": "design/0034 §8 第 5 条 ＋ design/0035 §3.8 的 A4 / B8–B13：跑**产品那几份**"
                "（services/treerefresh.js ＋ services/clipboard.js ＋ components/FileTree.js"
                " ＋ services/{i18n,tauri,session,versions,chunked,search,dirsession}.js）"
                "在真 WKWebView 里的右键菜单接线。",
        "为什么": "纯逻辑那批在 tests/js/{treerefresh,clipboard}.test.js；这里要验的是"
                  "「菜单里到底有没有那一项」「选区停在哪」「失败后输入行还在不在」"
                  "「换根之后迟到的回包会不会碰新树」——这四件都要真 DOM ＋ 真菜单。",
        "被测文件": {
            "treerefresh.js": "src/services/treerefresh.js（右键目标 / 复制目标 / 重命名目标 / 主名选区）",
            "clipboard.js": "src/services/clipboard.js（只读能力核对 ＋ 唯一一条写入实现）",
            "FileTree.js": "src/components/FileTree.js（菜单 / 输入行 / 提交 / 失败保留 / 收尾）",
            "session.js 等": "src/services/{i18n,tauri,session,versions,chunked,search,dirsession}.js",
            "夹具": "tools/wkwebview-probe/tree-menu-harness.js",
        },
        "⚠️ 边界": "① main.js 不进探针页，本探针**不镜像**它，只驱动 FileTree 的公开行为；"
                   "② 假后端下沉到 `window.__TAURI__.core.invoke` ⇒ 只有『磁盘里有什么』是假的；"
                   "③ ⭐ **剪贴板是记账桩子**（`CLIP.defaultCopier` 被换掉）⇒ "
                   "『真实写入成功』仍只能人工验收（§7 H1）；"
                   "④ 菜单观感 / 输入行手感属于人工验收（§7 H2/H3）。",
        "⚠️ 变异": "M1/M2/M3/M4 打在**页面副本**上（⛔ 不碰仓库文件）："
                   "M1 删 !hit 守卫 ⇒ A1 必须红；M2 disabled 恒假 ⇒ B8 必须红；"
                   "M3 主名选区按第一个点 ⇒ B2 必须红；"
                   "M4 删掉树行菜单的「在访达中显示」（design/0048）⇒ C1 必须红。"
                   "⚠️ 施加前校验命中恰好 1 次 ＋ cksum 前后不同，否则根本不算一次变异。",
        "机器": f"{model} / macOS {platform.mac_ver()[0]} / {platform.machine()}",
        "⚠️ 离屏": "窗口 alphaValue=0 ＋ orderBack ＋ .prohibited ⇒ **不弹窗、不抢焦点、不合成按键**"
                   "（根 CLAUDE.md 约定 4）。代价是环境要**每次自证**（判据 E）。",
    },
    "环境": {
        "machine_model": model,
        "os_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "python": platform.python_version(),
        "页面自证": env,
    },
    "夹具": raw.get("夹具"),
    "检查": 检查,
    "结论": {"通过": len(通过), "失败": len(失败), "跳过": len(跳过)},
}

if to_json == "1":
    print(json.dumps(doc, ensure_ascii=False, indent=2))
else:
    if 失败:
        print("⛔ 文件树右键菜单：**没通过**", file=sys.stderr)
    elif 跳过:
        print("⚠️ 文件树右键菜单：有 %d 条**没判定**（--no-mutate，⛔ 不是失败）" % len(跳过), file=sys.stderr)
    else:
        print("✅ 文件树右键菜单：%d 条全通过" % len(通过), file=sys.stderr)
    for c in 检查:
        mark = {"通过": "✅", "失败": "⛔", "跳过": "⏭"}.get(c["结果"], "?")
        print("%s %-4s %s" % (mark, c["id"], c["名"]), file=sys.stderr)
        if c["结果"] != "通过":
            print("      判据：%s" % c["判据"], file=sys.stderr)
            print("      实测：%s" % json.dumps(c["值"], ensure_ascii=False), file=sys.stderr)
    print("· 剪贴板 = %s" % json.dumps(env.get("剪贴板"), ensure_ascii=False), file=sys.stderr)
    for key_, val in env.items():
        if key_ == "剪贴板":
            continue
        print("· 环境.%s = %s" % (key_, json.dumps(val, ensure_ascii=False)), file=sys.stderr)
    print("· 夹具 = %s" % json.dumps(raw.get("夹具"), ensure_ascii=False), file=sys.stderr)
    print(json.dumps(doc, ensure_ascii=False, indent=2))

if save == "1":
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("✅ 结果写入 %s" % out, file=sys.stderr)

sys.exit(1 if 失败 else (2 if 跳过 else 0))
PY
