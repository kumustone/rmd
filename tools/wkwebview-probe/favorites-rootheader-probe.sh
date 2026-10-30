#!/usr/bin/env bash
# 跑「**根头**（`design/0044`）＋ **启动页收藏段**（`design/0043`）＋ **最近目录的删除 / 清空**
# （`design/0045`）」的**真 DOM 离屏探针**。
#
# 用法：
#   tools/wkwebview-probe/favorites-rootheader-probe.sh                # 基线 + 十一处变异，判据进退出码
#   tools/wkwebview-probe/favorites-rootheader-probe.sh --no-mutate    # 只跑基线（快）
#   tools/wkwebview-probe/favorites-rootheader-probe.sh --save         # 另存一份到 benchmarks/results/
#   tools/wkwebview-probe/favorites-rootheader-probe.sh --save --force # 允许覆盖同名结果
#   tools/wkwebview-probe/favorites-rootheader-probe.sh --json         # 只打原始 JSON
#
# 退出码：0 = 全通过；1 = 有检查**失败**；2 = 有检查**跳过**；3 = 跑不起来；4 = 变异没落到文件里
#
# ⚠️⚠️ **默认不落盘**：`benchmarks/results/` 是**历史记录**（`docs/README.md` §6），
#    而这一条是个**闸门**（改 `Sidebar.js` / `FileTree.js` / `StartScreen.js` 就跑一次）。
#
# ⚠️ 它跑的是**产品那几份**，原样拷进页面（⛔ 探针不抄第二份实现）：
#    `components/{FileTree,Sidebar,StartScreen}.js`
#    ＋ `services/{i18n,versions,chunked,dirsession,tauri,search,keymap,session,start,treerefresh,clipboard}.js`。
#    `main.js` 那层接线**不进**探针页，本探针也**不镜像**它——只照它的调用顺序驱动公开行为。
#
# ⚠️ 判据 M1–M10 是**变异测试**，作用在**页面副本**上（⛔ 不碰仓库文件）：
#    M1 = 空态不隐藏根头              ⇒ 判据 5 必须红；
#    M2 = 根层新建把输入行插到 host 外面（= 顶到根头上面）⇒ 判据 3 必须红；
#    M3 = 顶层深度从 0 改成 1（根头占一层）    ⇒ 判据 10 必须红；
#    M4 = 收藏行也编上数字            ⇒ 判据 B1 必须红；
#    M5 = 根头右键不再开菜单          ⇒ 判据 8 必须红；
#    M6 = 「清空」一下就直接执行（丢掉两步确认）⇒ 判据 B10 必须红；
#    M7 = 「从列表移除」回传 `~` 缩写（⛔ 不是后端原串）⇒ 判据 B11 必须红；
#    M8 = `allEls()` 与版式脱钩（焦点顺序仍是"最近在前"）⇒ 判据 B7 必须红；
#    M9 = `Shift+F10` 只认收藏行      ⇒ 判据 B12 必须红；
#    ⭐ M10 = 刷新事务的离屏重建不带 `fresh`（`bugs/0019` 的原样）⇒ 判据 12 **必须仍绿**。
#       ⚠️ 这条 2026-10-27 由**红**翻成**绿**（`design/0050` §7.5 明写"必须由红转绿"）：
#       后端 `TreeCache` 的键从 (代次, 路径) 变成 (代次, **纪元**, 路径)，磁盘变了纪元就前进
#       ⇒ 调用方忘了 `fresh` 也命中不到旧层。**它现在是反向对照**，证明兜底不是"恰好绿"。
#    ⭐ M11 = `fresh` 打回 `false` **且**纪元不前进（假后端 `bumpEpoch()` 变空操作）⇒ 判据 12 必须红。
#       ⚠️ 这一条才是承重的正面控制：没有纪元这道栅栏时，同一个缺陷立刻复活。
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
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

I18N="$ROOT/src/services/i18n.js"
VERSIONS="$ROOT/src/services/versions.js"
CHUNKED="$ROOT/src/services/chunked.js"
DIRSESSION="$ROOT/src/services/dirsession.js"
TAURIJS="$ROOT/src/services/tauri.js"
SEARCHJS="$ROOT/src/services/search.js"
KEYMAP="$ROOT/src/services/keymap.js"
SESSIONJS="$ROOT/src/services/session.js"
STARTJS="$ROOT/src/services/start.js"
DISKEVENTS="$ROOT/src/services/diskevents.js"
TREEREFRESH="$ROOT/src/services/treerefresh.js"
CLIPBOARD="$ROOT/src/services/clipboard.js"
FILETREE="$ROOT/src/components/FileTree.js"
SIDEBAR="$ROOT/src/components/Sidebar.js"
STARTSCREEN="$ROOT/src/components/StartScreen.js"
HARNESS="$HERE/favorites-rootheader-harness.js"
SWIFT="$HERE/tree-menu-probe.swift"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 3
fi
for f in "$I18N" "$VERSIONS" "$CHUNKED" "$DIRSESSION" "$TAURIJS" "$SEARCHJS" "$KEYMAP" \
         "$SESSIONJS" "$STARTJS" "$DISKEVENTS" "$TREEREFRESH" "$CLIPBOARD" "$FILETREE" \
         "$SIDEBAR" "$STARTSCREEN" "$HARNESS" "$SWIFT"; do
  if [ ! -f "$f" ]; then
    echo "⛔ 缺 $f" >&2
    exit 3
  fi
done

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/favorites-rootheader-${TODAY}-${MODEL}.json"
if [ "$SAVE" = "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 3
fi

WORK="$HERE/.fr-work"
mkdir -p "$WORK"

# ── ① 组装一份页面：产品文件全部**拷进去**（⛔ 不用符号链接：
#      `allowingReadAccessTo` 是按目录给的，链接指到目录外读不到） ──
build_page() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  cp "$I18N"        "$dir/i18n.js"
  cp "$VERSIONS"    "$dir/versions.js"
  cp "$CHUNKED"     "$dir/chunked.js"
  cp "$DIRSESSION"  "$dir/dirsession.js"
  cp "$TAURIJS"     "$dir/tauri.js"
  cp "$SEARCHJS"    "$dir/search.js"
  cp "$KEYMAP"      "$dir/keymap.js"
  cp "$SESSIONJS"   "$dir/session.js"
  cp "$STARTJS"     "$dir/start.js"
  cp "$DISKEVENTS"  "$dir/diskevents.js"
  cp "$TREEREFRESH" "$dir/treerefresh.js"
  cp "$CLIPBOARD"   "$dir/clipboard.js"
  cp "$FILETREE"    "$dir/filetree.js"
  cp "$SIDEBAR"     "$dir/sidebar.js"
  cp "$STARTSCREEN" "$dir/startscreen.js"
  cp "$HARNESS"     "$dir/harness.js"

  # ⚠️ `<script>` 顺序照 `src/index.html` 的相对次序（经典脚本按顺序执行、依赖是**加载期取值**）：
  #    `i18n → versions → chunked → dirsession → tauri → search → start → diskevents
  #     → session → keymap → treerefresh → clipboard → FileTree → Sidebar → StartScreen`。
  #    ⛔ 别调换：`session.js` 加载期取 `window.rmd.{tauri,versions,search,dirSession,diskEvents}`，
  #    ⚠️ `diskEvents` 那份**必须排在 `session.js` / `FileTree.js` 之前**（两者都在加载期取值，
  #    见 `design/0050` 最终约束 4——`diskevents.js` 是盘上变更的**前端唯一入口**）。
  #    `FileTree.js` 取 `window.rmd.{i18n,versions,chunked,session,dirSession,treeRefresh,clipboard}`，
  #    `Sidebar.js` 取 `window.rmd.keymap`，`StartScreen.js` 取 `window.rmd.{start,keymap}`。
  cat > "$dir/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>rmd · favorites + root-header probe</title>
<style>
  html, body { margin: 0; }
  /* ⚠️ 只求"有布局盒"：观感归人工验收，这里不抄产品主题。 */
  #sidebar { width: 320px; height: 720px; display: flex; flex-direction: column; }
  #pane-tree { flex: 1; overflow-y: auto; font: 400 13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; }
  #pane-tree[hidden] { display: none; }
  .tree-root-wrap { display: block; }
  .tree-root-header { display: flex; gap: 4px; align-items: center; height: 24px; padding: 0 8px;
                      font-weight: 600; }
  .tree-root-header[hidden] { display: none; }
  .tree-root-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tree-root-more { margin-left: auto; border: 0; background: transparent; font: inherit; }
  .tree-host { display: block; }
  .row { display: flex; gap: 4px; align-items: center; height: 20px; }
  .twisty { width: 10px; }
  .node-icon { width: 12px; height: 12px; display: inline-block; }
  .node-icon svg { width: 12px; height: 12px; }
  .children { display: none; padding-left: 14px; }
  .node.expanded > .children { display: block; }
  .node.current > .row { background: #dde; }
  .node.ignored > .row { opacity: .5; }
  .note, .tree-error { color: #a00; font-size: 11px; }
  .unauth-title { font-size: 12px; }
  .tree-menu, .start-menu { position: fixed; background: #fff; border: 1px solid #ccc; padding: 2px 0;
                            z-index: 30; }
  .tree-menu-item, .start-menu-item { display: block; width: 100%; text-align: left; border: 0;
                                      background: transparent; font: inherit; padding: 3px 12px; }
  .tree-menu-item.disabled, .start-menu-item.disabled { opacity: .5; }
  #doc { padding: 8px; }
  .start-title { margin: 8px 0 4px; font-weight: 600; font-size: 12px; }
  .start-row { display: block; width: 100%; text-align: left; border: 0; background: transparent;
               font: inherit; padding: 3px 6px; }
  .start-row[data-missing='1'] { opacity: .5; }
  .start-num { display: inline-block; width: 14px; color: #888; }
  .start-path { margin-left: 6px; color: #666; font-size: 11px; }
  .start-file { margin-left: 6px; color: #666; font-size: 11px; }
  .start-last { margin-left: 6px; color: #080; font-size: 11px; }
</style>
<!-- 根头与原树**两个 host**（`design/0044` §2.4）：结构照 `src/index.html` 的静态壳抄，⛔ 不合并。 -->
<div id="sidebar">
  <button id="tab-tree">树</button><button id="tab-toc">大纲</button>
  <button id="btn-collapse">收起</button><button id="btn-expand">展开</button>
  <button id="btn-file-view">列表</button>
  <div id="sidebar-search" hidden><input id="sidebar-search-input"></div>
  <div id="sidebar-resizer"></div>
  <div id="pane-tree" class="pane" role="tabpanel">
    <div class="tree-root-wrap">
      <div id="tree-root-header" class="tree-root-header" tabindex="0" role="group" hidden>
        <span class="node-icon" aria-hidden="true"></span>
        <span class="tree-root-name"></span>
        <button id="tree-root-more" type="button" aria-label="当前目录操作">⋯</button>
      </div>
      <div id="tree-host" class="tree-host"></div>
    </div>
  </div>
  <div id="pane-toc" hidden></div>
  <div id="pane-doclist" hidden></div>
  <div id="pane-search" hidden></div>
</div>
<div id="doc"></div>
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
<script src="start.js"></script>
<script src="diskevents.js"></script>
<script src="session.js"></script>
<script src="keymap.js"></script>
<script src="treerefresh.js"></script>
<script src="clipboard.js"></script>
<script src="filetree.js"></script>
<script src="sidebar.js"></script>
<script src="startscreen.js"></script>
<script src="harness.js"></script>
HTML
}

# ── ② 编译探针（复用 tree-menu 那个**纯运行器**：它只负责离屏窗口 + `__RUN()` + 环境自证）──
BIN="$WORK/favorites-rootheader-probe"
if [ ! -x "$BIN" ] || [ "$SWIFT" -nt "$BIN" ]; then
  echo "▶ 编译探针…" >&2
  swiftc -O "$SWIFT" -o "$BIN" >"$WORK/fr-build.log" 2>&1 || {
    echo "⛔ 编译失败：" >&2; cat "$WORK/fr-build.log" >&2; exit 3
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

BASE_PAGE="$WORK/fr-page"
build_page "$BASE_PAGE"

RAW_BASE="$WORK/fr-base.json"
run_round "$BASE_PAGE" "$RAW_BASE" "$WORK/fr-base.err"

RAW_M1="$WORK/fr-m1.json"
RAW_M2="$WORK/fr-m2.json"
RAW_M3="$WORK/fr-m3.json"
RAW_M4="$WORK/fr-m4.json"
RAW_M5="$WORK/fr-m5.json"
RAW_M6="$WORK/fr-m6.json"
RAW_M7="$WORK/fr-m7.json"
RAW_M8="$WORK/fr-m8.json"
RAW_M9="$WORK/fr-m9.json"
RAW_M10="$WORK/fr-m10.json"
RAW_M11="$WORK/fr-m11.json"
if [ "$MUTATE" = "1" ]; then
  # M1：空态不隐藏根头（= 根头会浮在一句"没打开目录"的提示上面）⇒ 判据 5 必须红。
  P1="$WORK/fr-page-m1"
  build_page "$P1"
  echo "▶ M1：空态不隐藏根头…" >&2
  apply_mutation "$P1/sidebar.js" \
    "    function showEmpty(text) {
      setRootHeader(null);" \
    "    function showEmpty(text) {"
  run_round "$P1" "$RAW_M1" "$WORK/fr-m1.err"

  # M2：根层新建把输入行插到 `#tree-host` **外面**（= 顶到根头上面）⇒ 判据 3 必须红。
  P2="$WORK/fr-page-m2"
  build_page "$P2"
  echo "▶ M2：根层新建插到 host 外面…" >&2
  apply_mutation "$P2/filetree.js" \
    "        container = isRootLayer ? host : (parentNode && parentNode._kids);" \
    "        container = isRootLayer ? host.parentNode : (parentNode && parentNode._kids);"
  run_round "$P2" "$RAW_M2" "$WORK/fr-m2.err"

  # M3：顶层深度 0 → 1（= 根头占掉一层，深度上限提前截断）⇒ 判据 10 必须红。
  P3="$WORK/fr-page-m3"
  build_page "$P3"
  echo "▶ M3：顶层深度改成 1…" >&2
  apply_mutation "$P3/filetree.js" \
    "const r = await fillLayer(host, rootPath, 0, fresh);" \
    "const r = await fillLayer(host, rootPath, 1, fresh);"
  run_round "$P3" "$RAW_M3" "$WORK/fr-m3.err"

  # M4：收藏行也编上数字（= 两段编号随收藏条数漂移）⇒ 判据 B1 必须红。
  P4="$WORK/fr-page-m4"
  build_page "$P4"
  echo "▶ M4：收藏行也编数字…" >&2
  apply_mutation "$P4/startscreen.js" \
    "          const path = document.createElement('span');
          path.className = 'start-path';
          path.textContent = r.tilded;" \
    "          const num2 = document.createElement('span');
          num2.className = 'start-num';
          btn.appendChild(num2);
          const path = document.createElement('span');
          path.className = 'start-path';
          path.textContent = r.tilded;"
  run_round "$P4" "$RAW_M4" "$WORK/fr-m4.err"

  # M5：根头右键不再开菜单（= 只剩 `⋯` 一条入口）⇒ 判据 8 必须红。
  P5="$WORK/fr-page-m5"
  build_page "$P5"
  echo "▶ M5：根头右键不开菜单…" >&2
  apply_mutation "$P5/sidebar.js" \
    "      els.treeRootHeader.addEventListener('contextmenu', function (ev) {
        if (ev.defaultPrevented) return;
        ev.preventDefault();
        openRootMenuAt(ev.clientX, ev.clientY);" \
    "      els.treeRootHeader.addEventListener('contextmenu', function (ev) {
        if (ev.defaultPrevented) return;"
  run_round "$P5" "$RAW_M5" "$WORK/fr-m5.err"

  # M6：`清空` 一下就直接执行（丢掉两步确认）⇒ 判据 B10 必须红。
  P6="$WORK/fr-page-m6"
  build_page "$P6"
  echo "▶ M6：清空一下就直接执行…" >&2
  apply_mutation "$P6/startscreen.js" \
    "      if (!r.fire) {" \
    "      if (false) {"
  run_round "$P6" "$RAW_M6" "$WORK/fr-m6.err"

  # M7：最近行菜单回传 `~` 缩写而不是后端原串 ⇒ 判据 B11 必须红。
  P7="$WORK/fr-page-m7"
  build_page "$P7"
  echo "▶ M7：移除时回传 ~ 缩写…" >&2
  apply_mutation "$P7/startscreen.js" \
    "{ key: 'start.menu.forget', run: function () { onForgetRecent(r.root); } }," \
    "{ key: 'start.menu.forget', run: function () { onForgetRecent(r.tilded); } },"
  run_round "$P7" "$RAW_M7" "$WORK/fr-m7.err"

  # M8：`allEls()` 与版式脱钩（焦点顺序仍是旧的"最近在前"）⇒ 判据 B7 必须红。
  P8="$WORK/fr-page-m8"
  build_page "$P8"
  echo "▶ M8：焦点顺序与版式脱钩…" >&2
  apply_mutation "$P8/startscreen.js" \
    "function allEls() { return favEls.concat(rowEls); }" \
    "function allEls() { return rowEls.concat(favEls); }"
  run_round "$P8" "$RAW_M8" "$WORK/fr-m8.err"

  # M9：`Shift+F10` 只认收藏行（最近行走不到菜单）⇒ 判据 B12 必须红。
  P9="$WORK/fr-page-m9"
  build_page "$P9"
  echo "▶ M9：Shift+F10 只认收藏行…" >&2
  apply_mutation "$P9/startscreen.js" \
    "        const recAt = rowEls.indexOf(document.activeElement);" \
    "        const recAt = -1;"
  run_round "$P9" "$RAW_M9" "$WORK/fr-m9.err"

  # M10：把「刷新事务的离屏重建带 `fresh`」原样打回 `false` ⇒ **判据 12 必须仍绿**。
  #   ⚠️ 这是 2026-10-27 用户实测的那个真缺陷（`bugs/0019`）的**原始形状**：
  #   后端 `TreeCache` 的键是 (代次, 路径)，"目录里多了一个文件"不动代次 ⇒ 不 fresh 就命中旧层，
  #   离屏重建出**一模一样**的树 ⇒ 界面上什么都没变（手动刷新也一样）。
  #   ⭐ `design/0050` 之后它**由红转绿**（§7.5）：键里多了纪元，磁盘一变纪元就前进 ⇒
  #   旧层命中不到。⇒ 本条现在是**反向对照**：证明新一轮的绿不是"恰好绿"。
  #   ⚠️ **两处都要打回**：根层与"已展开的子层"是两条独立的 `fillLayer` 调用。
  P10="$WORK/fr-page-m10"
  build_page "$P10"
  echo "▶ M10：刷新事务不 fresh（纪元兜底 ⇒ 必须仍绿）…" >&2
  apply_mutation "$P10/filetree.js" \
    "const r0 = await fillLayer(det, rootPath, 0, true, false, true);" \
    "const r0 = await fillLayer(det, rootPath, 0, false, false, true);"
  apply_mutation "$P10/filetree.js" \
    "const r = await fillLayer(node._kids, p, depth + 1, true, false, true);" \
    "const r = await fillLayer(node._kids, p, depth + 1, false, false, true);"
  run_round "$P10" "$RAW_M10" "$WORK/fr-m10.err"

  # M11：`fresh` 打回 `false` **且**纪元不前进（= 去掉 `design/0050` 的 M1 栅栏）⇒ 判据 12 必须红。
  #   ⚠️ 这一条是**正面控制**：它与 M10 只差"假后端推不推纪元"这一件事。
  #   若 M11 也绿，说明判据 12 判不到 `bugs/0019`，M10 的绿就没有意义。
  P11="$WORK/fr-page-m11"
  build_page "$P11"
  echo "▶ M11：不 fresh ＋ 纪元不前进（M1 栅栏拆掉）…" >&2
  apply_mutation "$P11/filetree.js" \
    "const r0 = await fillLayer(det, rootPath, 0, true, false, true);" \
    "const r0 = await fillLayer(det, rootPath, 0, false, false, true);"
  apply_mutation "$P11/filetree.js" \
    "const r = await fillLayer(node._kids, p, depth + 1, true, false, true);" \
    "const r = await fillLayer(node._kids, p, depth + 1, false, false, true);"
  apply_mutation "$P11/harness.js" \
    "  function bumpEpoch() { cacheEpoch += 1; }" \
    "  function bumpEpoch() { /* 变异 M11：纪元不前进 */ }"
  run_round "$P11" "$RAW_M11" "$WORK/fr-m11.err"
fi

# ── ⑤ 判据汇总：**退出码就是结论** ──
python3 -I - "$RAW_BASE" "$RAW_M1" "$RAW_M2" "$RAW_M3" "$RAW_M4" "$RAW_M5" \
  "$RAW_M6" "$RAW_M7" "$RAW_M8" "$RAW_M9" "$RAW_M10" "$RAW_M11" \
  "$MUTATE" "$TO_JSON" "$SAVE" "$OUT" "$MODEL" "$TODAY" <<'PY'
import json
import os
import platform
import sys

(raw_base, raw_m1, raw_m2, raw_m3, raw_m4, raw_m5,
 raw_m6, raw_m7, raw_m8, raw_m9, raw_m10, raw_m11,
 mutate, to_json, save, out, model, today) = sys.argv[1:19]

try:
    raw = json.load(open(raw_base, encoding="utf-8"))
except Exception as e:
    print("⛔ 读不出基线结果：%s" % e, file=sys.stderr)
    sys.exit(3)
if "致命" in raw:
    print("⛔ harness 致命错误：%s" % raw["致命"], file=sys.stderr)
    print("   加载期错误：%s" % json.dumps(raw.get("加载期错误"), ensure_ascii=False), file=sys.stderr)
    sys.exit(3)

env = raw.get("环境") or {}
检查 = list(raw.get("检查") or [])

# ⚠️ 判据**必须逐条产出**：少一条 = 那条判据根本没跑（⛔ 别把"没产出"读成"通过"）。
EXPECTED = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12",
            "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12"]
有 = set(str(c.get("id")) for c in 检查)
for cid in EXPECTED:
    if cid not in 有:
        检查.append({
            "id": cid,
            "名": "（探针没有产出这一条判据）",
            "结果": "失败",
            "判据": "`design/0043`/`0044`/`0045` ＋ `bugs/0019` 的这 24 条必须逐条产出",
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

def 变异仍绿判据(cid, path, target, 说明):
    """一条"由红转绿"的变异算通过 = 基线里 target 通过 ∧ 变异后 target **仍然通过**（§7.5 的 M10）。"""
    if mutate != "1":
        return {"id": cid, "名": "（没跑变异：--no-mutate）", "结果": "跳过",
                "判据": 说明 + "；本次用 --no-mutate 跳过", "值": {}}
    table, why = 结果表(path)
    if table is None:
        return {"id": cid, "名": "变异轮没跑起来", "结果": "失败",
                "判据": 说明, "值": {"原因": why}}
    base_target = 基线.get(target)
    got = table.get(target)
    ok = (base_target == "通过") and (got == "通过")
    return {
        "id": cid, "名": 说明,
        "结果": "通过" if ok else "失败",
        "判据": "基线里判据 %s 通过 ∧ **变异后判据 %s 仍然通过**（由红转绿：兜底接住了调用方的遗漏）" % (target, target),
        "值": {"基线": base_target, "变异后": got,
               "变异后全体": table,
               "⚠️ 口径": "变异打在**页面副本**上（⛔ 仓库文件一字未动）；"
                          "施加前校验模式命中恰好 1 次，并用 cksum 证明文件真变了"},
    }

基线 = {str(c.get("id")): c.get("结果") for c in 检查}
检查.append(变异判据("M1", raw_m1, "5", "变异：空态不隐藏根头 ⇒ 判据 5（空态根头隐藏）必须红"))
检查.append(变异判据("M2", raw_m2, "3", "变异：根层新建插到 host 外面 ⇒ 判据 3（新建落点）必须红"))
检查.append(变异判据("M3", raw_m3, "10", "变异：顶层深度改成 1 ⇒ 判据 10（根头不占一层）必须红"))
检查.append(变异判据("M4", raw_m4, "B1", "变异：收藏行也编数字 ⇒ 判据 B1（数字只在最近行）必须红"))
检查.append(变异判据("M5", raw_m5, "8", "变异：根头右键不开菜单 ⇒ 判据 8（两路同一份菜单）必须红"))
检查.append(变异判据("M6", raw_m6, "B10", "变异：清空一下就直接执行 ⇒ 判据 B10（两下才清）必须红"))
检查.append(变异判据("M7", raw_m7, "B11", "变异：移除时回传 ~ 缩写 ⇒ 判据 B11（回传后端原串）必须红"))
检查.append(变异判据("M8", raw_m8, "B7", "变异：焦点顺序与版式脱钩 ⇒ 判据 B7（跨两段连续走）必须红"))
检查.append(变异判据("M9", raw_m9, "B12", "变异：Shift+F10 只认收藏行 ⇒ 判据 B12（最近行也吃这个键）必须红"))
检查.append(变异仍绿判据("M10", raw_m10, "12",
    "变异：刷新事务的离屏重建不带 fresh（`bugs/0019` 原样打回）⇒ 判据 12（外部新增可见）**必须仍绿**"
    "（`design/0050` §7.5 的『由红转绿』：纪元栅栏接住了调用方的遗漏）"))
检查.append(变异判据("M11", raw_m11, "12",
    "变异：不 fresh ＋ 纪元不前进（拆掉 `design/0050` 的 M1 栅栏）⇒ 判据 12（外部新增可见）必须红"))

def key(c):
    i = str(c.get("id"))
    if i.isdigit():
        return (0, int(i), "")
    return (1, 0, i)

检查.sort(key=key)
通过 = [c for c in 检查 if c["结果"] == "通过"]
失败 = [c for c in 检查 if c["结果"] == "失败"]
跳过 = [c for c in 检查 if c["结果"] == "跳过"]

doc = {
    "schema": "rmd-favorites-rootheader-probe/1",
    "date": today,
    "口径": {
        "说明": "`design/0044`（根头）＋ `design/0043`（启动页收藏段）＋ `design/0045`（最近目录的删除 / 清空）："
                "跑**产品那几份**（components/{FileTree,Sidebar,StartScreen}.js ＋ services/{i18n,versions,chunked,"
                "dirsession,tauri,search,keymap,session,start,treerefresh,clipboard}.js）"
                "在真 WKWebView 里的接线。",
        "为什么": "根头的失效形态是**结构性**的（共用一个 host ⇒ 刷新删掉根头 / 新建输入顶到根头上面），"
                  "收藏段的失效形态是**顺序性**的（两段编号漂移 / 焦点走不动 / 失效行不能管理），"
                  "而 `0045` 那两件事各有一次**不可逆**的错法：段序反了 ⇒ 用户找不到收藏、"
                  "「清空」一下就直接执行 ⇒ 手一滑整份历史没了——"
                  "这三族都要真 DOM ＋ 真事件，纯逻辑单测与源码 grep 都判不了。",
        "被测文件": {
            "FileTree.js": "src/components/FileTree.js（host 边界 / 刷新事务 / 根头菜单白名单 / 输入行落点 / 深度）",
            "Sidebar.js": "src/components/Sidebar.js（根头显隐 / `⋯` 与右键 / 空态与未授权态 / 切页签）",
            "StartScreen.js": "src/components/StartScreen.js（两段渲染与**收藏在前**的顺序 / 数字归属 / 两张行菜单 / 清空的两步确认 / 焦点）",
            "其余": "services/{i18n,versions,chunked,dirsession,tauri,search,keymap,session,start,treerefresh,clipboard}.js",
            "夹具": "tools/wkwebview-probe/favorites-rootheader-harness.js",
        },
        "⚠️ 边界": "① `main.js` 不进探针页，本探针**不镜像**它，只照它的调用顺序驱动公开行为；"
                   "② 假后端下沉到 `window.__TAURI__.core.invoke` ⇒ 只有『磁盘里有什么』是假的；"
                   "③ 剪贴板是记账桩子（本探针不点那一项）；"
                   "④ 观感（根头的留白/字重、菜单阴影）与手感只能人工验收。",
        "⚠️ 变异": "M1–M11 打在**页面副本**上（⛔ 不碰仓库文件）："
                   "M1 ⇒ 5 红；M2 ⇒ 3 红；M3 ⇒ 10 红；M4 ⇒ B1 红；M5 ⇒ 8 红；"
                   "M6 ⇒ B10 红；M7 ⇒ B11 红；M8 ⇒ B7 红；M9 ⇒ B12 红；"
                   "⭐ M10 ⇒ 12 **仍绿**（`bugs/0019` 原样：刷新事务不吃 `fresh`，"
                   "`design/0050` 的纪元栅栏把它接住了 —— 由红转绿，反向对照）；"
                   "⭐ M11 ⇒ 12 红（同一份 `fresh` 遗漏 **外加**纪元不前进 ⇒ 缺陷立刻复活，正面控制）。"
                   "⚠️ 施加前校验命中恰好 1 次 ＋ cksum 前后不同，否则根本不算一次变异。",
        "机器": f"{model} / macOS {platform.mac_ver()[0]} / {platform.machine()}",
        "⚠️ 离屏": "窗口 alphaValue=0 ＋ orderBack ＋ .prohibited ⇒ **不弹窗、不抢焦点、不合成按键**"
                   "（根 CLAUDE.md 约定 4）。代价是环境要**每次自证**（环境.窗口 / 前台被抢过）。",
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
        print("⛔ 根头 / 启动页收藏：**没通过**", file=sys.stderr)
    elif 跳过:
        print("⚠️ 根头 / 启动页收藏：有 %d 条**没判定**（--no-mutate，⛔ 不是失败）" % len(跳过), file=sys.stderr)
    else:
        print("✅ 根头 / 启动页收藏：%d 条全通过" % len(通过), file=sys.stderr)
    for c in 检查:
        mark = {"通过": "✅", "失败": "⛔", "跳过": "⏭"}.get(c["结果"], "?")
        print("%s %-4s %s" % (mark, c["id"], c["名"]), file=sys.stderr)
        if c["结果"] != "通过":
            print("      判据：%s" % c["判据"], file=sys.stderr)
            print("      实测：%s" % json.dumps(c["值"], ensure_ascii=False), file=sys.stderr)
    for key_, val in env.items():
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
