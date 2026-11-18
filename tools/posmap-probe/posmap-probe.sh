#!/usr/bin/env bash
# `design/0059` 阶段 C：**渲染同源的位置映射**隔离原型（`tools/` 内，⛔ 不碰产品）
#
# 用法：
#   tools/posmap-probe/posmap-probe.sh            # 跑一轮，比例表落盘到 benchmarks/results/
#   tools/posmap-probe/posmap-probe.sh --json     # 只打原始 JSON（不落盘）
#   tools/posmap-probe/posmap-probe.sh --force    # 覆盖今天已有的那份结果文件
#
# 退出码：0 = 全部判据通过；1 = 有判据失败；3 = 跑不起来
#
# # 它拼的是什么
#
# ① Rust 半：`tools/live-probe --render-json` —— 用**产品那一次渲染**
#    （`document/render.rs::to_html_with_stats`）把夹具变成 HTML，连同
#    `document/offset.rs` 算的 UTF-8/UTF-16 换算表一起交给页面。
# ② 页面半：`posmap-harness.js` 在真实 DOM 上建索引，把每个源码边界归到
#    `exact` / `snapped` / `unmappable`，做严格往返与陈旧判定。
# ③ 窗口：`posmap-probe.swift` —— `.prohibited` + `alphaValue = 0` + `orderBack`，
#    ⛔ 不弹窗、⛔ 不抢前台、⛔ 不合成按键（根 `CLAUDE.md` 工作约定 4）。
#
# ⚠️ 判据 E 是**环境自证**（前台没被抢、窗口不可见、不是 key 窗口）：
#    离屏的代价就是每次都要证明自己真的离屏。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FIXTURES="$HERE/fixtures"
HARNESS="$HERE/posmap-harness.js"
SWIFT="$HERE/posmap-probe.swift"

TO_JSON=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --json)  TO_JSON=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 3
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "⛔ 没有 cargo" >&2
  exit 3
fi
for f in "$HARNESS" "$SWIFT"; do
  [ -f "$f" ] || { echo "⛔ 缺 $f" >&2; exit 3; }
done
[ -d "$FIXTURES" ] || { echo "⛔ 缺夹具目录 $FIXTURES" >&2; exit 3; }

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/posmap-${TODAY}-${MODEL}.json"
if [ "$TO_JSON" = "0" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 3
fi

WORK="$HERE/.posmap-work"
mkdir -p "$WORK"
PAGE="$WORK/page"

# ── ① Rust 半：真实产品渲染 → JSON ──────────────────────────────────────────
SAMPLES=(
  "$FIXTURES/paragraph.md"
  "$FIXTURES/heading.md"
  "$FIXTURES/list.md"
  "$FIXTURES/quote.md"
  "$FIXTURES/code.md"
  "$FIXTURES/table.md"
  "$FIXTURES/task.md"
  "$FIXTURES/image.md"
  "$FIXTURES/html-inline.md"
  "$FIXTURES/math.md"
)
for f in "${SAMPLES[@]}"; do
  [ -f "$f" ] || { echo "⛔ 缺夹具 $f" >&2; exit 3; }
done

echo "▶ 用产品渲染出 HTML（tools/live-probe --render-json）…" >&2
RENDER="$WORK/render.json"
LLOG="$WORK/live-probe.log"
# ⚠️ `--offline`：依赖与产品逐字同版本，且注册表缓存已在（⛔ 不联网拉新版）。
(cd "$ROOT/tools/live-probe" && cargo run --offline --release -- --render-json "${SAMPLES[@]}") \
  >"$RENDER" 2>"$LLOG" || {
  echo "⛔ live-probe 跑挂了：" >&2
  sed -n '1,40p' "$LLOG" >&2
  exit 3
}
if ! grep -q '^{' "$RENDER"; then
  echo "⛔ live-probe 没产出 JSON：" >&2
  sed -n '1,40p' "$LLOG" >&2
  exit 3
fi
grep -q 'warning' "$LLOG" && sed -n '1,20p' "$LLOG" >&2 || true

# ── ② 组装页面 ──────────────────────────────────────────────────────────────
rm -rf "$PAGE"
mkdir -p "$PAGE"
cp "$HARNESS" "$PAGE/harness.js"
# ⚠️ JSON 作为**外部脚本**注入（⛔ 不内联）：代码夹具里出现 `</script>` 会截断内联脚本。
{ printf 'window.__RENDER__ = '; cat "$RENDER"; printf ';\n'; } > "$PAGE/render-data.js"

cat > "$PAGE/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>rmd · posmap probe</title>
<style>
  html, body { margin: 0; font: 400 14px/1.5 -apple-system, sans-serif; }
  .rendered { max-width: 720px; }
  pre { white-space: pre-wrap; }
</style>
<div id="stage"></div>
<!-- ⚠️ 加载期错误只能靠这个面看见：经典脚本抛异常时**页面不报给 Swift**，
     表现与"忘了拷某个文件"逐字相同。 -->
<script>
  window.rmd = {};
  window.__LOADERR = [];
  window.addEventListener('error', function (e) {
    window.__LOADERR.push(String(e.message) + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0));
  });
</script>
<!-- ⚠️ `render-data.js` 必须在 `harness.js` 之前：后者在 `__RUN` 里取 `window.__RENDER__`。 -->
<script src="render-data.js"></script>
<script src="harness.js"></script>
HTML

# ── ③ 编译并跑探针（探针自带 120 秒兜底；这里再套一层 200 秒看门狗）──
BIN="$WORK/posmap-probe"
if [ ! -x "$BIN" ] || [ "$SWIFT" -nt "$BIN" ]; then
  echo "▶ 编译探针…" >&2
  swiftc -O "$SWIFT" -o "$BIN" >"$WORK/swift.log" 2>&1 || {
    echo "⛔ 编译失败：" >&2; cat "$WORK/swift.log" >&2; exit 3
  }
fi

RAW="$WORK/raw.json"
ERR="$WORK/raw.err"
echo "▶ 跑探针（⚠️ 全程**一个不可见窗口**、无前台切换、无合成按键）…" >&2
"$BIN" "$PAGE" >"$RAW" 2>"$ERR" &
PID=$!
i=0
while [ "$i" -lt 400 ]; do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
  i=$((i + 1))
done
if kill -0 "$PID" 2>/dev/null; then
  echo "⛔ 200 秒没结束，强杀。" >&2
  kill -9 "$PID" 2>/dev/null || true
  exit 3
fi
wait "$PID" 2>/dev/null || true
if ! grep -q '^{' "$RAW" 2>/dev/null; then
  echo "⛔ 探针没产出 JSON。stderr：" >&2
  sed -n '1,40p' "$ERR" >&2
  exit 3
fi
sed -n '1,10p' "$ERR" >&2 || true

# ── ④ 判据汇总：**退出码就是结论** ─────────────────────────────────────────
python3 -I - "$RAW" "$TO_JSON" "$OUT" "$MODEL" "$TODAY" <<'PY'
import json, os, platform, sys

(raw_path, to_json, out, model, today) = sys.argv[1:6]
raw = json.load(open(raw_path, encoding="utf-8"))
if "致命" in raw:
    print("⛔ 致命：" + str(raw["致命"]), file=sys.stderr)
    sys.exit(3)

env = raw.get("环境") or {}
窗口 = env.get("窗口") or {}
docs = raw.get("文档") or []
覆盖 = set(raw.get("夹具覆盖") or [])
陈旧 = raw.get("陈旧") or {}

检查 = []
def add(cid, name, ok, 判据, 值):
    检查.append({"id": cid, "名": name, "结果": "通过" if ok else "失败",
                 "判据": 判据, "值": 值})

def by(pred):
    return [d for d in docs if pred(d.get("name") or "")]

# 1 · 三档守恒：每个源码边界恰好归入一档（⛔ 不许"漏算"或"重复算"）
bad = []
for d in docs:
    b = (d.get("stats") or {}).get("boundaries") or {}
    if b.get("exact", 0) + b.get("snapped", 0) + b.get("unmappable", 0) != b.get("total", -1):
        bad.append({"doc": d.get("name"), "boundaries": b})
add("1", "三档守恒：exact + snapped + unmappable = 边界总数",
    not bad and len(docs) > 0,
    "每份夹具的每个源码边界（UTF-16，含文末）恰好归入 exact/snapped/unmappable 之一",
    {"文档数": len(docs), "不守恒": bad})

# 2 · 字符级严格往返：映射到的每个字符都能原路返回
bad = []
for d in docs:
    rt = d.get("roundTrip") or {}
    if rt.get("charBad"):
        bad.append({"doc": d.get("name"), "bad": rt["charBad"]})
add("2", "字符级严格往返：源码↔DOM 双向一致",
    not bad,
    "每个被映射的源码字符 c：srcToDom[c] = d ∧ domToSrc[d] = c（⛔ 单向映射不算）",
    {"失败": bad})

# 3 · exact 子集严格往返（阶段 C 明文：只对 exact 主张严格往返）
bad = []
for d in docs:
    rt = d.get("roundTrip") or {}
    b = (d.get("stats") or {}).get("boundaries") or {}
    if rt.get("bad") or rt.get("neighborBad") or rt.get("exactChecked", 0) != b.get("exact", -1):
        bad.append({"doc": d.get("name"), "往返失败": rt.get("bad"),
                    "邻字不符": rt.get("neighborBad"),
                    "checked": rt.get("exactChecked"), "exact": b.get("exact")})
add("3", "exact 子集严格往返 ＋ 邻字绝对校验：源码边界 → DOM → 同一源码边界",
    not bad,
    "每个 exact 边界 p：domToSource(srcToDom(p)) == p；且 DOM 位置两侧的**字**必须等于源码两侧的字"
    "（⛔ 只做往返会放过「整体错位 k 个字符」）；检查数 = exact 总数（⛔ 抽样）",
    {"失败": bad})

# 4 · snapped 按声明规则成立：位置有效、规则稳定、bias 有记录
bad = []
for d in docs:
    pts = d.get("snapPointsBad") or []
    if pts:
        bad.append({"doc": d.get("name"), "bad": pts})
add("4", "snapped 合规：吸附位置在真实文本节点内、重复查询稳定、bias 有记录",
    not bad,
    "snapped 的 DOM 位置必须落在某个文本节点的 [0, len] 内；同一协议两次查询同位置；"
    "bias ∈ {left, right, both-ambiguous}",
    {"失败": bad,
     "bias 分布": {d.get("name"): (d.get("stats") or {}).get("snapBias") for d in docs}})

# 5 · unmappable 明确失败：⛔ 不返回任何 DOM 位置
bad = []
for d in docs:
    for x in (d.get("snapPointsBad") or []):
        if "unmappable" in str(x.get("why")):
            bad.append({"doc": d.get("name"), "bad": x})
add("5", "unmappable 明确失败：⛔ 不猜位置",
    not bad,
    "unmappable 的返回值里没有 DOM 位置（harness 只在给了位置时记 badPoints）",
    {"失败": bad})

# 6 · 重渲 / 修订变化 ⇒ 旧映射被拒；变异必须被抓
steps = 陈旧.get("steps") or []
add("6", "陈旧判定：重渲后旧映射被拒；绕开守卫的变异落在脱离文档的节点上",
    bool(陈旧.get("ok")) and len(steps) == 4,
    "① 建索引后立即可查；② 重渲（新实例）后 ⇒ stale；③ 变异绕开身份判据 ⇒ 节点已脱离文档；"
    "④ 修订标签变化 ⇒ stale",
    {"步骤": steps})

# 7 · 夹具覆盖：九类块逐类有夹具，且产品渲染**真的**出了对应结构
need = {
    "paragraph.md": ["Paragraph"],
    "heading.md": ["Heading"],
    "list.md": ["List"],
    "quote.md": ["BlockQuote"],
    "code.md": ["CodeBlock"],
    "table.md": ["Table"],
    "task.md": ["List"],
    "image.md": ["Paragraph"],
    "html-inline.md": ["HtmlBlock"],
    # ⚠️ 块级公式在 comrak 里是 `Paragraph → Math(display_math)` ⇒ 顶层看到的是 Paragraph。
    "math.md": ["Heading", "Paragraph"],
}
missing = []
names = {os.path.basename(d.get("name") or ""): d for d in docs}
for f, kinds in need.items():
    d = names.get(f)
    if d is None:
        missing.append({"夹具": f, "为什么": "没跑"})
        continue
    have = set((d.get("stats") or {}).get("kinds") or [])
    lack = [k for k in kinds if k not in have]
    if lack:
        missing.append({"夹具": f, "缺块类": lack, "实有": sorted(have)})
add("7", "夹具覆盖：九类块 + 公式，逐类都有真实渲染产物",
    not missing and len(docs) == 10,
    "每份夹具的顶层块种类里必须包含它要验的那一类（⛔ 只看文件名不算）",
    {"缺": missing, "文档数": len(docs)})

# 8 · 产品渲染**真的**出了对应结构（⛔ 不是"夹具跑到就算"）
def chk(f, key, least, 值的人话):
    d = names.get(f)
    if d is None:
        return {"夹具": f, "为什么": "没跑"}
    n = ((d.get("domChecks") or {}).get(key))
    if n is None:
        return {"夹具": f, "缺检查项": key}
    if n < least:
        return {"夹具": f, "结构": 值的人话, "实得": n, "至少": least}
    return None

structural = [x for x in [
    chk("paragraph.md", "p", 2, "<p>"),
    chk("heading.md", "heading", 4, "<h1..h6>"),
    chk("list.md", "li", 6, "<li>"),
    chk("quote.md", "blockquote", 1, "<blockquote>"),
    chk("code.md", "pre", 2, "<pre>"),
    chk("code.md", "hlSpan", 1, "高亮 <span class>"),
    chk("table.md", "table", 1, "<table>"),
    chk("table.md", "th", 3, "<th>"),
    chk("task.md", "checkbox", 3, "任务复选框"),
    chk("image.md", "img", 3, "<img>"),
    chk("math.md", "math", 2, "MathML <math>"),
] if x]
# 反面对照：裸 HTML 块必须**被省略**（产品默认安全口径的可观察面）。
box = names.get("html-inline.md")
if box is not None and ((box.get("domChecks") or {}).get("rawBox") or 0) != 0:
    structural.append({"夹具": "html-inline.md", "结构": "裸 HTML 块⛔ 不该出现", "实得": box["domChecks"]["rawBox"]})
add("8", "真实渲染产物：每类块都在 DOM 里出了对应结构",
    not structural,
    "DOM 查询计数（p/h/li/blockquote/pre/table/th/checkbox/img/math/高亮 span）逐项达标；"
    "⭐ 反面对照：裸 HTML 块的 `.box` 必须不存在（默认省略原始 HTML）",
    {"缺": structural})

# 8 · 环境自证：离屏、不抢前台
抢 = env.get("前台被抢过")
try:
    alpha0 = float(窗口.get("alpha", -1)) == 0.0
except (TypeError, ValueError):
    alpha0 = False
okE = ((抢 is False) and alpha0 and (窗口.get("调过_NSApp_activate") is False)
       and (窗口.get("进程被激活") is False) and (窗口.get("窗口是_key") is False))
add("E", "前台没有被抢（离屏不打扰用户）",
    okE,
    "frontmostApplication 起跑前后相同 ∧ 窗口 alpha=0 ∧ 没调 NSApp.activate"
    " ∧ 进程没被激活 ∧ 窗口不是 key",
    {"前台被抢过": 抢, "窗口": 窗口,
     "前台应用_起跑前": env.get("前台应用_起跑前"),
     "前台应用_收工时": env.get("前台应用_收工时")})

# 9 · 单位一致：UTF-16 是工作单位，UTF-8 由 offset.rs 的表给出
bad = []
for d in docs:
    u = (d.get("stats") or {}).get("units") or {}
    if not u.get("unitMapOk"):
        bad.append({"doc": d.get("name"), "units": u})
add("9", "单位一致：UTF-16 码元为工作单位，UTF-8 字节由 document/offset.rs 换算表给出",
    not bad,
    "unitMap 长度 = 码元数 + 1 且末项 = 文本字节数（换算表来自 Rust，⛔ JS 自算）",
    {"失败": bad})

# ⚠️ 防"探针半路停了还报全绿"：1..9 缺任何一条都当场记失败。
有 = set(str(c.get("id")) for c in 检查)
for i in range(1, 10):
    if str(i) not in 有:
        检查.append({"id": str(i), "名": "（探针没有产出这一条判据）", "结果": "失败",
                     "判据": "阶段 C 的 1–9 必须逐条产出", "值": {"缺": str(i)}})

def key(c):
    i = str(c.get("id"))
    return (0, int(i), "") if i.isdigit() else (1, 0, i)

检查.sort(key=key)
通过 = [c for c in 检查 if c["结果"] == "通过"]
失败 = [c for c in 检查 if c["结果"] == "失败"]

def ratio(d):
    b = (d.get("stats") or {}).get("boundaries") or {}
    t = max(1, b.get("total", 1))
    return {"exact": round(b.get("exact", 0) * 100.0 / t, 1),
            "snapped": round(b.get("snapped", 0) * 100.0 / t, 1),
            "unmappable": round(b.get("unmappable", 0) * 100.0 / t, 1)}

doc = {
    "schema": "rmd-posmap-probe/1",
    "date": today,
    "口径": {
        "说明": "design/0059 阶段 C：用**产品那一次渲染**（document/render.rs::to_html_with_stats）"
                "的 HTML 在真实 DOM 上建索引，把每个源码边界归到 exact / snapped / unmappable。",
        "⛔ 不改产品": "只读原型：不加 DTO / 命令 / HTML schema，不改默认行为；"
                      "所有新代码在 tools/posmap-probe/ 与 live-probe 的一个新参数里。",
        "三档判据": "L=左邻字符映射位置+1，R=右邻字符映射位置；L=R ⇒ exact；"
                    "只有一侧或两侧不等 ⇒ snapped（左优先）；两侧都没有 ⇒ unmappable（⛔ 不猜）。",
        "对齐": "含字文本节点按 DOM 顺序单调匹配源码逐字同一段，搜索限定在该节点的顶层块区间；"
                "HtmlBlock 产品默认整段省略 ⇒ 配对时跳过它（声明过的假设）。",
        "已知限制": "① FootnoteDefinition 渲染到文末，会打破单调性 ⇒ 本原型不认脚注块；"
                    "② 实体（&amp;）只映射 `&` 本身，`amp;` 归 unmappable；"
                    "③ MathML / 图片 alt / 被省略的原始 HTML 没有文本对应 ⇒ unmappable。",
        "机器": f"{model} / macOS {platform.mac_ver()[0]} / {platform.machine()}",
        "⚠️ 离屏": "窗口 alphaValue=0 ＋ orderBack ＋ .prohibited ⇒ 不弹窗、不抢焦点、不合成按键"
                   "（根 CLAUDE.md 工作约定 4）。代价是环境要**每次自证**（判据 E）。",
        "⚠️ 验证层": "纯逻辑（Rust 渲染 / 换算表）＋ 真 DOM（WKWebView 里 innerHTML 后建索引）。"
                     "⛔ 未接产品 GUI、⛔ 未做真实 IME、⛔ 未接真实后端。",
    },
    "环境": {
        "machine_model": model,
        "os_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "python": platform.python_version(),
        "页面自证": env,
    },
    "夹具覆盖": sorted(覆盖),
    "比例": {d.get("name"): ratio(d) for d in docs},
    "文档": docs,
    "检查": 检查,
    "结论": {"通过": len(通过), "失败": len(失败)},
}

if to_json == "1":
    print(json.dumps(doc, ensure_ascii=False, indent=2))
else:
    if 失败:
        print("⛔ 位置映射原型：**没通过**", file=sys.stderr)
    else:
        print("✅ 位置映射原型：%d 条全通过" % len(通过), file=sys.stderr)
    for c in 检查:
        mark = {"通过": "✅", "失败": "⛔"}.get(c["结果"], "?")
        print("%s %-2s %s" % (mark, c["id"], c["名"]), file=sys.stderr)
        if c["结果"] != "通过":
            print("      判据：%s" % c["判据"], file=sys.stderr)
            print("      实测：%s" % json.dumps(c["值"], ensure_ascii=False), file=sys.stderr)
    print("\n· 三档比例（源码边界 %）", file=sys.stderr)
    print("  | 夹具 | exact | snapped | unmappable |", file=sys.stderr)
    for name, r in doc["比例"].items():
        print("  | %s | %s | %s | %s |" % (os.path.basename(name), r["exact"], r["snapped"],
                                           r["unmappable"]), file=sys.stderr)
    print("\n· 成本（Rust 解析 / 渲染 / DOM / 建索引 / 查询）", file=sys.stderr)
    for d in docs:
        c = d.get("cost") or {}
        print("  %-16s parse %.2f ms · render %.2f ms · innerHTML %.2f ms · build %.2f ms · "
              "query %.2f ms/%d · index %d B · runs %d/%d"
              % (os.path.basename(d.get("name") or ""), c.get("rustParseMs", 0),
                 c.get("rustRenderMs", 0), c.get("domSetMs", 0), c.get("buildMs", 0),
                 c.get("queryMs", 0), c.get("queryCount", 0), c.get("indexBytes", 0),
                 c.get("matchedRuns", 0), c.get("runs", 0)), file=sys.stderr)
    print(json.dumps(doc, ensure_ascii=False, indent=2))

if to_json == "0":
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("✅ 结果写入 %s" % out, file=sys.stderr)

sys.exit(1 if 失败 else 0)
PY
