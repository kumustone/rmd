#!/usr/bin/env bash
# 跑「中英文界面」的**真 DOM 离屏探针**（`design/0025` §7.2 的 `make probe-i18n`）
#
# 用法：
#   tools/wkwebview-probe/i18n-probe.sh              # 五轮：基线 + 四处变异，判据进退出码
#   tools/wkwebview-probe/i18n-probe.sh --no-mutate  # 只跑基线（快）
#   tools/wkwebview-probe/i18n-probe.sh --save       # 另存一份到 benchmarks/results/
#   tools/wkwebview-probe/i18n-probe.sh --save --force
#   tools/wkwebview-probe/i18n-probe.sh --json       # 只打原始 JSON
#
# 退出码：0 = 全通过；1 = 有检查**失败**；2 = 有检查**跳过**；3 = 跑不起来；4 = 变异没落到文件里
#
# ⚠️⚠️ **默认不落盘**：`benchmarks/results/` 是历史记录（`docs/README.md` §6），
#    而这一条是**闸门**（改一次 `src/services/i18n.js` / `src/index.html` / `src/styles/**`
#    就该跑一次）。⇒ 要留证据才 `--save`，且照旧拒绝覆盖（除非 `--force`）。
#
# ⭐⭐ **它加载的是真 `src/index.html`**：整棵 `src/` 原样拷进页面目录（保住 `styles/**` 的
#    相对路径 ⇒ 量的是**真样式**），然后**行级**剥掉 `<script>`：只留
#    `services/i18n.js` 一条，`settings.js` / `harness.js` 由本脚本注入。
#    ⚠️ 剥离**必须按整行匹配**：`index.html` 里有一行**注释**含 `<script src>`，
#    非贪婪的 `[\s\S]*?` 会从注释中间吃掉一大段（本仓那条源码级闸门同源）。
#    ⇒ 剥完当场断言「留下 1 条 ∧ 剥掉 > 0 条」，两个数都印出来。
#
# ⚠️⚠️ **与 `design/0025` §7.2 字面的一处不同**（已登记在其 §10）：设置覆盖层**不在
#    `index.html` 里**，它是 `components/Settings.js` 在运行时建的。要量「设置覆盖层
#    在英文下不溢出」就**必须**让那份产品代码跑起来 ⇒ 注入 `settings.js`（产品原样），
#    ⛔ 不手抄一份覆盖层标记（那会造出第二份真值）。
#
# ⚠️ 判据 ①②要量的东西静态上**一半是 `hidden`**（保存按钮 / 保存失败提示 / 重载条 /
#    预览条 / 决策条）⇒ 页面侧**强制打开**（`design/0025` §7.2 末的评审 #9），
#    否则「英文 ＋ 保存 ＋ 失败提示同时可见」那个**最坏宽度永远量不到**。
#
# ⚠️ 三条变异打在**页面副本**上（⛔ 不碰仓库文件），各自只钉**一条**判据：
#      M1 删 en 字典里的 `'toolbar.theme'` ⇒ 判据 4（英文里没有汉字）必须红；
#      M2 删 `<html lang>` 那句 setAttribute ⇒ 判据 6 必须红；
#      M3 让 `applyDom` 的 ATTRS 循环一次都不跑 ⇒ 判据 5（切换后真的变了）必须红；
#      M4 把 `el(…, '')` 的空字典键放回去 ⇒ 判据 3（属性值不许为空串）必须红。
#    ⚠️ 施加前校验模式命中**恰好 1 次**，并用 `cksum` 证明**真改到了**——
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
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 3 ;;
  esac
done

SRCDIR="$ROOT/src"
GUI="$ROOT/src-tauri/src/gui/mod.rs"
HARNESS="$HERE/i18n-harness.js"
SWIFT="$HERE/i18n-probe.swift"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 3
fi
for f in "$SRCDIR/index.html" "$SRCDIR/services/i18n.js" "$SRCDIR/components/Settings.js" \
         "$GUI" "$HARNESS" "$SWIFT"; do
  if [ ! -f "$f" ]; then
    echo "⛔ 缺 $f" >&2
    exit 3
  fi
done

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/i18n-${TODAY}-${MODEL}.json"
if [ "$SAVE" = "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 3
fi

WORK="$HERE/.i18n-work"
mkdir -p "$WORK"

# ── ① 组装一份页面：整棵 `src/` 拷进去，再**行级**剥 `<script>` ──
#    ⚠️ 为什么整棵拷：`index.html` 的十一个 `<link rel="stylesheet">` 是相对路径
#       ⇒ 只拷那几个文件会漏掉 `styles/**` 里的 `@import`/字体/图标，
#       量出来的宽度就不是产品那个宽度了（"绿得没道理"的经典形态）。
#    ⚠️ 不用符号链接：`allowingReadAccessTo` 是按目录给的，链接指到目录外读不到。
build_page() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  cp -R "$SRCDIR/." "$dir/"
  python3 -I - "$GUI" "$dir/index.html" "$HARNESS" "$dir/__harness.js" <<'PY'
import json, re, sys

gui_path, index_path, harness_path, harness_dst = sys.argv[1:5]

# ── 键位表**现读**（`gui/mod.rs` 的 `SHORTCUTS`）──
#    ⚠️ 这是本探针的**输入**，⛔ 不许有第三份手抄清单（`INV-SET-01`）。
#    ⚠️ 解析器自带三条自检——Rust 侧一改格式就会"静默少读几项"，
#       而少读的那几项**不会以任何方式报错**（覆盖层只是窄了几像素）。
gui = open(gui_path, encoding="utf-8").read()
consts = dict(re.findall(r'const\s+([A-Z_]+)\s*:\s*&str\s*=\s*"([^"]+)"\s*;', gui))
start = gui.find("const SHORTCUTS: &[Shortcut] = &[")
if start < 0:
    sys.exit("⛔ 找不到 `const SHORTCUTS` —— Rust 侧改名/换写法了，本探针的输入变了")
end = gui.find("\n];", start)
if end <= start:
    sys.exit("⛔ 找不到 `SHORTCUTS` 的结尾 `];`")
body = gui[start:end]

rows = []
for blk in re.findall(r"Shortcut\s*\{[\s\S]*?\}", body):
    def field(name):
        m = re.search(name + r":\s*([^,\n]+)", blk)
        return m.group(1).strip() if m else None
    raw_id = field("id")
    m = re.search(r'id:\s*"([^"]+)"', blk)
    if m:
        rid = m.group(1)
    elif raw_id in consts:
        rid = consts[raw_id]
    else:
        continue
    m = re.search(r'accel:\s*"([^"]+)"', blk)
    if not m:
        continue
    accel = m.group(1)
    mz = re.search(r'label_zh:\s*"([^"]*)"', blk)
    me = re.search(r'label_en:\s*"([^"]*)"', blk)
    rows.append({"id": rid, "display": accel,
                 "label_zh": mz.group(1) if mz else "",
                 "label_en": me.group(1) if me else ""})

if len(rows) < 10:
    sys.exit("⛔ 只读到 %d 项（表应有 ≥10）—— 解析器跟不上格式了" % len(rows))
for must in ("file.save", "settings.open", "view.toggle-sidebar"):
    if must not in {r["id"] for r in rows}:
        sys.exit("⛔ 读不到 `%s` —— 要么它没了、要么解析器没跟上（含常量 id 那两条）" % must)
if any(not r["display"] for r in rows):
    sys.exit("⛔ 有行没有 accel —— 字段解析漏了")
# ── 剥 `<script>`：**整行**匹配（⛔ 非贪婪跨行：有一行注释含 `<script src>`）──
html = open(index_path, encoding="utf-8").read()
if "</body>" not in html:
    sys.exit("⛔ index.html 里没有 </body> —— 注入点变了")

LINE = re.compile(r'^[ \t]*<script\b[^>]*></script>[ \t]*$')
KEEP = 'src="services/i18n.js"'

# ⚠️ 加载期错误只能靠这个面看见：经典脚本抛异常时**页面不报给 Swift**，
#    表现与"忘了跑 `make cm6`"逐字相同（`frontend.md` 那条结构性约束的同族）。
#    ⚠️ 它必须排在 **i18n.js 之前**，否则 i18n.js 自己抛的错收不到。
COLLECTOR = (
    '  <script>\n'
    '    window.__LOADERR = [];\n'
    '    window.addEventListener("error", function (e) {\n'
    '      window.__LOADERR.push(String(e.message) + " @ " + (e.filename || "?") + ":" + (e.lineno || 0));\n'
    '    });\n'
    '  </script>'
)

out, kept, removed = [], 0, 0
for ln in html.split("\n"):
    if LINE.match(ln):
        if KEEP in ln:
            out.append(COLLECTOR)
            out.append(ln)
            kept += 1
            continue
        removed += 1
        continue
    out.append(ln)

if kept != 1:
    sys.exit("⛔ 留下来的 `<script>` 是 %d 条（应恰好 1 条 `%s`）" % (kept, KEEP))
if removed <= 0:
    sys.exit("⛔ 一条 `<script>` 都没剥掉 —— 剥离规则失效了（⛔ 别把'剥 0 条'当成通过）")

inject = (
    '  <script>\n'
    '    window.__SHORTCUTS = ' + json.dumps(rows, ensure_ascii=False) + ';\n'
    '  </script>\n'
    '  <script src="components/Settings.js"></script>\n'
    '  <script src="__harness.js"></script>\n'
)
html = "\n".join(out).replace("</body>", inject + "</body>", 1)
open(index_path, "w", encoding="utf-8").write(html)

with open(harness_path, encoding="utf-8") as f:
    harness = f.read()
with open(harness_dst, "w", encoding="utf-8") as f:
    f.write(harness)

print("· 剥 <script>：留 %d 条、剥 %d 条（⚠️ 剥 0 条等于没验）" % (kept, removed), file=sys.stderr)
print("· 从 gui/mod.rs 现读 %d 条快捷键：%s"
      % (len(rows), "、".join(r["display"] for r in rows)), file=sys.stderr)
PY
}

# ── ② 编译探针 ──
BIN="$WORK/i18n-probe"
if [ ! -x "$BIN" ] || [ "$SWIFT" -nt "$BIN" ]; then
  echo "▶ 编译探针…" >&2
  swiftc -O "$SWIFT" -o "$BIN" >"$WORK/i18n-build.log" 2>&1 || {
    echo "⛔ 编译失败：" >&2; cat "$WORK/i18n-build.log" >&2; exit 3
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

BASE_PAGE="$WORK/page"
build_page "$BASE_PAGE"

RAW_BASE="$WORK/base.json"
run_round "$BASE_PAGE" "$RAW_BASE" "$WORK/base.err"

RAW_M1="$WORK/m1.json"
RAW_M2="$WORK/m2.json"
RAW_M3="$WORK/m3.json"
RAW_M4="$WORK/m4.json"
if [ "$MUTATE" = "1" ]; then
  # M1：删掉 en 字典里的 `'toolbar.theme'` ⇒ `t()` 回落到中文 ⇒ 英文界面里出现汉字
  #     ⇒ 判据 4（英文里没有汉字）必须红。⚠️ 换行也要一起吃掉，否则留一个空行无害但没意义。
  P1="$WORK/page-m1"
  build_page "$P1"
  echo "▶ M1：删掉 en 字典的 'toolbar.theme'…" >&2
  apply_mutation "$P1/services/i18n.js" \
    "      'toolbar.theme': 'Theme',
" \
    ''

  # M2：删掉 `<html lang>` 那句 ⇒ 判据 6（lang 跟着变）必须红
  P2="$WORK/page-m2"
  build_page "$P2"
  echo "▶ M2：删掉 setAttribute('lang', …)…" >&2
  apply_mutation "$P2/services/i18n.js" \
    "      d.documentElement.setAttribute('lang', HTML_LANG[current]);
" \
    ''

  # M3：让 `applyDom` 的 ATTRS 循环一次都不跑 ⇒ 判据 5（切换后变了 ≥20 处）必须红
  P3="$WORK/page-m3"
  build_page "$P3"
  echo "▶ M3：让 applyDom 的 ATTRS 循环一次都不跑…" >&2
  apply_mutation "$P3/services/i18n.js" \
    '    for (let i = 0; i < ATTRS.length; i++) {' \
    '    for (let i = 0; i > ATTRS.length; i++) {'

  # M4：把 `el(…, '')` 那个**空字典键**放回去（= 本探针 2026-10-21 第一次跑抓到的真缺陷）
  #     ⇒ 判据 3（属性值不许是空串）必须红。
  #     ⚠️ 这一条是"探针抓到了真 bug"的**证据**：它在产品代码里已经修掉了，
  #        而判据只有在它能把这个缺陷重新打红时才算数。
  P4="$WORK/page-m4"
  build_page "$P4"
  echo "▶ M4：把 Settings.js 的空字典键放回去…" >&2
  apply_mutation "$P4/components/Settings.js" \
    "    const fsVal = el('span', 'settings-value');" \
    "    const fsVal = el('span', 'settings-value', '');"

  run_round "$P1" "$RAW_M1" "$WORK/m1.err"
  run_round "$P2" "$RAW_M2" "$WORK/m2.err"
  run_round "$P3" "$RAW_M3" "$WORK/m3.err"
  run_round "$P4" "$RAW_M4" "$WORK/m4.err"
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

# ⭐ 判据 E 在 Swift 那边算（页面够不到 frontmostApplication）——
#    ⚠️ 它带**非数字标签**，与 `probe-dir-session` 的 E 同族：⛔ 不占用 0–8 的编号。
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

# ⚠️ 防"探针半路停了还报全绿"：0–8 缺任何一条都当场记成失败。
有 = set(str(c.get("id")) for c in 检查)
for i in range(0, 9):
    if str(i) not in 有:
        检查.append({
            "id": str(i),
            "名": "（探针没有产出这一条判据）",
            "结果": "失败",
            "判据": "§7.2 的 0–8 必须逐条产出",
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
    """一条变异算通过 = 基线里 target 通过 ∧ 变异后 target 失败（⚠️ 只认**那一格**）。"""
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
检查.append(变异判据("9", raw_m1, "4",
                   "变异：删掉 en 字典的 'toolbar.theme' ⇒ 判据 4（英文里没有汉字）必须红"))
检查.append(变异判据("10", raw_m2, "6",
                   "变异：删掉 setAttribute('lang', …) ⇒ 判据 6（lang 跟着变）必须红"))
检查.append(变异判据("11", raw_m3, "5",
                   "变异：让 applyDom 的 ATTRS 循环一次都不跑 ⇒ 判据 5（切换后变了 ≥20 处）必须红"))
检查.append(变异判据("12", raw_m4, "3",
                   "变异：把 Settings.js 的 `el(…, '')` 空字典键放回去 ⇒ 判据 3（属性值不许为空串）必须红"
                   "（⭐ 它在产品代码里已修掉；这一条证明那条判据真的能把它打红）"))

def key(c):
    i = str(c.get("id"))
    return (0, int(i), "") if i.isdigit() else (1, 0, i)

检查.sort(key=key)
通过 = [c for c in 检查 if c["结果"] == "通过"]
失败 = [c for c in 检查 if c["结果"] == "失败"]
跳过 = [c for c in 检查 if c["结果"] == "跳过"]

doc = {
    "schema": "rmd-i18n-probe/1",
    "date": today,
    "口径": {
        "说明": "design/0025 §7.2：加载**真 src/index.html**（整棵 src/ 拷进页面目录，"
                "行级剥掉除 services/i18n.js 外的全部 <script> 并断言条数），"
                "量中英双语的**真布局**。",
        "为什么": "纯逻辑那批在 tests/js/i18n.test.js（字典自洽、回落链、applyDom）；"
                  "而 §7.2 要验的是「英文在 1280 宽下挤不挤」「覆盖层挤不挤」"
                  "「每个 data-i18n* 是不是真的两种语言都有字」——"
                  "这三件**只有真 CSS ＋ 真 DOM 能答**。",
        "被测文件": {
            "index.html": "src/index.html（原样拷贝，只剥 <script> 与注入两条）",
            "i18n.js": "src/services/i18n.js（产品原样，⛔ 探针不抄第二份）",
            "Settings.js": "src/components/Settings.js（⭐ 设置覆盖层**不**在 index.html 里，"
                           "它是运行时建的 ⇒ 必须加载产品那份才量得到判据 7）",
            "styles/**": "src/styles/** ＋ src/style.css（原样，相对路径原封不动）",
            "快捷键表": "src-tauri/src/gui/mod.rs 的 SHORTCUTS，本脚本 python **现读**",
            "夹具": "tools/wkwebview-probe/i18n-harness.js",
        },
        "⚠️ 边界": "① `display` 用 `accel` 串（`Shift+Cmd+O`）而不是 `⇧⌘O` 字形 ⇒ "
                   "`<kbd>` 更宽，对溢出判据是**偏严**的口径；"
                   "② 视口 1280×820 < 13 英寸 MacBook 的 1440 逻辑宽 ⇒ 同样偏严；"
                   "③ 判据 1/2 是**强制打开全部 hidden** 的最坏宽度，"
                   "那个组合在真实操作里不一定同时出现（§7.2 的评审 #9 要求这么量）；"
                   "④ 只有 `charset=utf-8` 与本地 woff 之类的外部资源会被 file:// 拦掉 ⇒ "
                   "本探针不量字体回退效果；"
                   "⑤ ⛔ 不覆盖「英文读起来别扭不别扭」——那是人工。",
        "⚠️ 变异": "判据 9/10/11/12 是变异测试，打在**页面副本**上（⛔ 不碰仓库文件）："
                   "删 en 的 toolbar.theme ⇒ 4 必须红；删 lang 的 setAttribute ⇒ 6 必须红；"
                   "让 applyDom 的 ATTRS 循环空转 ⇒ 5 必须红；"
                   "放回 Settings.js 的空字典键 ⇒ 3 必须红。"
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
        print("⛔ 中英双语：**没通过**", file=sys.stderr)
    elif 跳过:
        print("⚠️ 中英双语：有 %d 条**没判定**（--no-mutate，⛔ 不是失败）" % len(跳过), file=sys.stderr)
    else:
        print("✅ 中英双语：%d 条全通过" % len(通过), file=sys.stderr)
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
