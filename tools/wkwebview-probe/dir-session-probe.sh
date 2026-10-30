#!/usr/bin/env bash
# 跑「目录会话恢复」的**真 DOM 离屏探针**（`design/0020` §7.4，判据 46–52 ＋ 变异 53/54）
#
# 用法：
#   tools/wkwebview-probe/dir-session-probe.sh            # 三轮：基线 + 两处变异，判据进退出码
#   tools/wkwebview-probe/dir-session-probe.sh --no-mutate       # 只跑基线（快）
#   tools/wkwebview-probe/dir-session-probe.sh --save            # 另存一份到 benchmarks/results/
#   tools/wkwebview-probe/dir-session-probe.sh --save --force    # 允许覆盖同名结果
#   tools/wkwebview-probe/dir-session-probe.sh --json            # 只打原始 JSON
#
# 退出码：0 = 全通过；1 = 有检查**失败**；2 = 有检查**跳过**；3 = 跑不起来；4 = 变异没落到文件里
#
# ⚠️⚠️ **默认不落盘**：`benchmarks/results/` 是**历史记录**（`docs/README.md` §6），
#    而这一条是个**闸门**（改一次 `src/services/dirsession.js` / `src/components/FileTree.js`
#    就该跑一次）。⇒ 要存证据时才 `--save`（那时仍拒绝覆盖，除非 `--force`）。
#
# ⚠️ 它跑的是**产品那几份**，原样拷进页面：
#    `src/services/dirsession.js`（全部判定）＋ `src/components/FileTree.js`（`restoreExpanded`
#    与两个通知出口）＋ `src/services/{tauri,versions,chunked,search,session}.js`（树读一层、
#    开一份文档都要走真提交判据）。⛔ 探针不抄第二份实现——`main.js` 那层接线只能在页面里
#    **镜像**（它是根脚本，进不了探针页），镜像的那两行在 harness 头部写明了。
#
# ⚠️ 判据 53/54 是**变异测试**，作用在**页面副本**上（⛔ 不碰仓库文件）：
#    53 = 把 `restoreExpanded` 的 `restoring` 抑制去掉 ⇒ 判据 48 必须红；
#    54 = 把 `shouldContinue` 短路成恒真       ⇒ 判据 51 必须红。
#    ⚠️ 变异前先校验"模式命中**恰好 1 次**"，并用 `cksum` 证明**真改到了**——
#       否则"没红"会与"断言不承重"长得一模一样（本仓踩过四次，见 `.claude/rules/tests.md` ⑬⑭⑯）。

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
    -h|--help) sed -n '2,27p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

DIRSESSION="$ROOT/src/services/dirsession.js"
FILETREE="$ROOT/src/components/FileTree.js"
TAURIJS="$ROOT/src/services/tauri.js"
VERSIONS="$ROOT/src/services/versions.js"
CHUNKED="$ROOT/src/services/chunked.js"
SEARCHJS="$ROOT/src/services/search.js"
SESSIONJS="$ROOT/src/services/session.js"
HARNESS="$HERE/dir-session-harness.js"
SWIFT="$HERE/dir-session-probe.swift"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 3
fi
for f in "$DIRSESSION" "$FILETREE" "$TAURIJS" "$VERSIONS" "$CHUNKED" "$SEARCHJS" \
         "$SESSIONJS" "$HARNESS" "$SWIFT"; do
  if [ ! -f "$f" ]; then
    echo "⛔ 缺 $f" >&2
    exit 3
  fi
done

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/dir-session-${TODAY}-${MODEL}.json"
if [ "$SAVE" = "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 3
fi

WORK="$HERE/.ds-work"
mkdir -p "$WORK"

# ── ① 组装一份页面：产品文件全部**拷进去**（⛔ 不用符号链接：
#      `allowingReadAccessTo` 是按目录给的，链接指到目录外读不到） ──
build_page() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  cp "$VERSIONS"  "$dir/versions.js"
  cp "$CHUNKED"   "$dir/chunked.js"
  cp "$DIRSESSION" "$dir/dirsession.js"
  cp "$TAURIJS"   "$dir/tauri.js"
  cp "$SEARCHJS"  "$dir/search.js"
  cp "$SESSIONJS" "$dir/session.js"
  cp "$FILETREE"  "$dir/filetree.js"
  cp "$HARNESS"   "$dir/harness.js"

  # ⚠️ `<script>` 顺序照 `src/index.html` 的相对次序（经典脚本按顺序执行、依赖是**加载期取值**）：
  #    `versions → chunked → dirsession → tauri → search → session → FileTree`。
  #    ⛔ 别调换：`session.js` 在加载期取 `window.rmd.{tauri,versions,search,dirSession}`，
  #    `FileTree.js` 又取 `window.rmd.{versions,chunked,session,dirSession}`。
  cat > "$dir/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>rmd · dir-session probe</title>
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
<script src="versions.js"></script>
<script src="chunked.js"></script>
<script src="dirsession.js"></script>
<script src="tauri.js"></script>
<script src="search.js"></script>
<script src="session.js"></script>
<script src="filetree.js"></script>
<script src="harness.js"></script>
HTML
}

# ── ② 编译探针 ──
BIN="$WORK/dir-session-probe"
if [ ! -x "$BIN" ] || [ "$SWIFT" -nt "$BIN" ]; then
  echo "▶ 编译探针…" >&2
  swiftc -O "$SWIFT" -o "$BIN" >"$WORK/ds-build.log" 2>&1 || {
    echo "⛔ 编译失败：" >&2; cat "$WORK/ds-build.log" >&2; exit 3
  }
fi

# ── ③ 跑一轮（探针自带 150 秒兜底；这里再套一层 240 秒看门狗）──
run_round() {
  local page="$1" raw="$2" err="$3"
  echo "▶ 跑探针（⚠️ 全程**一个不可见窗口**、无前台切换、无合成按键）…" >&2
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

BASE_PAGE="$WORK/ds-page"
build_page "$BASE_PAGE"

RAW_BASE="$WORK/ds-base.json"
run_round "$BASE_PAGE" "$RAW_BASE" "$WORK/ds-base.err"

RAW_M53="$WORK/ds-m53.json"
RAW_M54="$WORK/ds-m54.json"
if [ "$MUTATE" = "1" ]; then
  # M53：去掉 `restoring` 抑制（= `INV-SESS-08` 失效的形态）⇒ 判据 48 必须红。
  P53="$WORK/ds-page-m53"
  build_page "$P53"
  echo "▶ M53：把 restoreExpanded 的 restoring 抑制去掉…" >&2
  apply_mutation "$P53/filetree.js" \
    '      restoring = true;' \
    '      restoring = false;'
  run_round "$P53" "$RAW_M53" "$WORK/ds-m53.err"

  # M54：让 `shouldContinue` 短路恒真（= 恢复不再每步前查一次）⇒ 判据 51 必须红。
  P54="$WORK/ds-page-m54"
  build_page "$P54"
  echo "▶ M54：把 shouldContinue 短路成恒真…" >&2
  # ⚠️ 这一句里有单引号 ⇒ 用**双引号**包（`$` / 反引号都不在里面，⛔ 别改成 `\x27`：
  #    python 的 argv **不解释转义**，那样就成了一个永远匹配不上的模式，
  #    表现是 `HITS=0` 而不是"变异没红"——本仓那种"看起来一样的失败"又一种形态）。
  apply_mutation "$P54/filetree.js" \
    "      const cont = typeof shouldContinue === 'function' ? shouldContinue : function () { return true; };" \
    '      const cont = function () { return true; };'
  run_round "$P54" "$RAW_M54" "$WORK/ds-m54.err"
fi

# ── ⑤ 判据汇总：**退出码就是结论** ──
python3 -I - "$RAW_BASE" "$RAW_M53" "$RAW_M54" "$MUTATE" "$TO_JSON" "$SAVE" "$OUT" "$MODEL" "$TODAY" <<'PY'
import json, os, platform, sys

(raw_base, raw_m53, raw_m54, mutate, to_json, save, out, model, today) = sys.argv[1:10]
raw = json.load(open(raw_base, encoding="utf-8"))

if "致命" in raw:
    print("⛔ 致命：" + str(raw["致命"]), file=sys.stderr)
    sys.exit(3)

检查 = list(raw.get("检查") or [])
env = raw.get("环境") or {}
窗口 = env.get("窗口") or {}

# ⭐ 判据 E 在 Swift 那边算（页面够不到 frontmostApplication）——这里并进来。
#    ⚠️ 它带**非数字标签**，与 `probe-image-viewer` 的 E/E2/E3/E4 同族：⛔ 不占用 46–54 的编号。
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

# ⚠️ 防"探针半路停了还报全绿"：46..52 缺任何一条都当场记成失败。
有 = set(str(c.get("id")) for c in 检查)
for i in range(46, 53):
    if str(i) not in 有:
        检查.append({
            "id": str(i),
            "名": "（探针没有产出这一条判据）",
            "结果": "失败",
            "判据": "§7.4 的 46–52 必须逐条产出",
            "值": {"缺": str(i)},
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
    "53", raw_m53, "48",
    "变异：去掉 restoring 抑制 ⇒ 判据 48（恢复期零通知）必须红"))
检查.append(变异判据(
    "54", raw_m54, "51",
    "变异：shouldContinue 短路恒真 ⇒ 判据 51（恢复可取消）必须红"))

def key(c):
    i = str(c.get("id"))
    return (0, int(i), "") if i.isdigit() else (1, 0, i)

检查.sort(key=key)
通过 = [c for c in 检查 if c["结果"] == "通过"]
失败 = [c for c in 检查 if c["结果"] == "失败"]
跳过 = [c for c in 检查 if c["结果"] == "跳过"]

doc = {
    "schema": "rmd-dir-session-probe/1",
    "date": today,
    "口径": {
        "说明": "design/0020 §7.4：跑**产品那几份**（src/services/dirsession.js ＋ "
                "src/components/FileTree.js ＋ src/services/{tauri,versions,chunked,search,session}.js）"
                "在真 WKWebView 里的目录会话恢复接线。",
        "为什么": "纯逻辑那批在 tests/js/dirsession.test.js；而 §7.4 要验的是"
                  "「恢复期真的会通知写者吗」「用户折叠与恢复各自响几次」「恢复后当前项恰好一个」"
                  "「200 条展开要多久」——这四件都要真 DOM ＋ 真树。",
        "被测文件": {
            "dirsession.js": "src/services/dirsession.js（原样拷入，⛔ 探针不抄第二份）",
            "FileTree.js": "src/components/FileTree.js（restoreExpanded / expand / 两个通知出口）",
            "session.js 等": "src/services/{tauri,versions,chunked,search,session}.js"
                             "（树读一层与开文档都走真提交判据）",
            "夹具": "tools/wkwebview-probe/dir-session-harness.js",
        },
        "⚠️ 边界": "① main.js 那层接线是**镜像**的（根脚本进不了探针页，只镜像了两行）；"
                   "② 假后端下沉到 `window.__TAURI__.core.invoke` ⇒ 只有『磁盘里有什么』是假的；"
                   "③ 判据 52 的耗时**不含真实 IPC 延迟**（假 IPC 同步 resolve）⇒ 它是**下界**，"
                   "⛔ 别当端到端数字引用；"
                   "④ 树是手搭的夹具 ⇒ ⛔ 不覆盖『恢复手感好不好』。",
        "⚠️ 变异": "判据 53/54 是变异测试，打在**页面副本**上（⛔ 不碰仓库文件）："
                   "53 去掉 restoring 抑制 ⇒ 48 必须红；54 让 shouldContinue 恒真 ⇒ 51 必须红。"
                   "⚠️ 施加前校验命中恰好 1 次 ＋ cksum 前后不同，否则根本不算一次变异。",
        "机器": f"{model} / macOS {platform.mac_ver()[0]} / {platform.machine()}",
        "⚠️ 离屏": "窗口 alphaValue=0 ＋ orderBack ⇒ **不弹窗、不抢焦点、不合成按键**（根 CLAUDE.md 约定 4）。"
                   "代价是环境要**每次自证**（判据 E：起跑前后比一次 frontmostApplication）。",
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
        print("⛔ 目录会话恢复：**没通过**", file=sys.stderr)
    elif 跳过:
        print("⚠️ 目录会话恢复：有 %d 条**没判定**（--no-mutate，⛔ 不是失败）" % len(跳过), file=sys.stderr)
    else:
        print("✅ 目录会话恢复：%d 条全通过" % len(通过), file=sys.stderr)
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
