#!/usr/bin/env bash
# 跑「文档内链接安全导航」的**真 DOM 离屏探针**（`design/0026` §7.2：判据 1–5 ＋ E）
#
# 用法：
#   tools/wkwebview-probe/link-nav-probe.sh              # 一轮，判据进退出码
#   tools/wkwebview-probe/link-nav-probe.sh --save       # 另存一份到 benchmarks/results/
#   tools/wkwebview-probe/link-nav-probe.sh --save --force
#   tools/wkwebview-probe/link-nav-probe.sh --json       # 只打原始 JSON
#
# 退出码：0 = 全通过；1 = 有检查**失败**；3 = 跑不起来
#
# ⚠️ **默认不落盘**：`benchmarks/results/` 是历史记录（`docs/README.md` §6），
#    而这一条是**闸门**（改一次 `src/services/links.js` / `src/main.js` 的链接那半就该跑一次）。
#
# ⚠️ 它跑的是**产品那两份**，原样拷进页面：
#    `src/services/links.js`（`href` 归一 / 结果→动作 / 存活判据）＋
#    `src/services/keymap.js`（`K.hasModifier`——修饰键判据只有一份）。
#    委托注册与 `followLink` 的流程是**镜像**自 `src/main.js` 的（根脚本进不了探针页）；
#    那一层的**产品侧**由 `tests/js/links.test.js` 的源码级闸门 #19–#24 守。
#
# ⚠️⚠️ **一条不可信事件的边界，别读错**：页面里的 `el.click()` 是**不可信事件**，
#    WebKit 不为它执行默认导航 ⇒ "点了 location 没变"**证明不了** `preventDefault` 生效。
#    所以对照组（判据 2）走**程序性导航** `location.href = 'other.md'`——那是真的会进
#    `decidePolicyFor`（= Tauri `on_navigation`）的一条路。判据 1 里承重的是
#    "后注册的监听器读到 `defaultPrevented === true`"与"`followLink` 收到的是原始相对串"。
#
# ⚠️ 判据 3b 是**事实记录**（`design/0026` §7.1 0a）：同文档 `#frag` 导航走不走
#    `decidePolicyFor`，**两种答案都正常**——这一条只要求"答得出来"，答案随 `--json` 落盘。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

TO_JSON=0
SAVE=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --json)  TO_JSON=1 ;;
    --save)  SAVE=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

LINKSJS="$ROOT/src/services/links.js"
KEYMAPJS="$ROOT/src/services/keymap.js"
HARNESS="$HERE/link-nav-harness.js"
SWIFT="$HERE/link-nav-probe.swift"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 3
fi
for f in "$LINKSJS" "$KEYMAPJS" "$HARNESS" "$SWIFT"; do
  if [ ! -f "$f" ]; then
    echo "⛔ 缺 $f" >&2
    exit 3
  fi
done

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/link-nav-${TODAY}-${MODEL}.json"
if [ "$SAVE" = "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 3
fi

WORK="$HERE/.ln-work"
mkdir -p "$WORK"
PAGE="$WORK/ln-page"

# ── ① 组装页面：产品文件**拷进去**（⛔ 不用符号链接：`allowingReadAccessTo` 是按目录给的）──
rm -rf "$PAGE"
mkdir -p "$PAGE"
cp "$LINKSJS"  "$PAGE/links.js"
cp "$KEYMAPJS" "$PAGE/keymap.js"
cp "$HARNESS"  "$PAGE/harness.js"

# ⚠️⚠️ **对照组的目标文件必须真实存在**（2026-10-21 实测，本探针第一版就栽在这里）：
#    `file://` 下指向**不存在**的文件时，WebKit 在 `decidePolicyFor` **之前**就不发起导航
#    ⇒ 导航日志里一条都没有，而"闸门回调没收到"与"闸门把请求拒了"在页面上**长得一模一样**。
#    ⇒ 判据 2（对照组）如果指向空气，它证明的是"我们没测到"，⛔ 不是"检测器死了"。
printf '# other\n\nprobe fixture\n' > "$PAGE/other.md"

# ⚠️ `<script>` 顺序：`keymap.js` 与 `links.js` 都**不依赖别的模块**（加载期零依赖），
#    顺序没有自由度；`harness.js` 必须在两者之后（它取 `window.rmd.links/keymap`）。
cat > "$PAGE/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>rmd · link-nav probe</title>
<style>
  html, body { margin: 0; font: 400 14px/1.5 -apple-system, sans-serif; }
  #doc { padding: 8px; }
</style>
<div id="doc">
  <h2 id="sec-1">sec-1</h2>
  <p><a id="rel" href="other.md#sec">相对链接</a></p>
  <p><a id="frag" href="#sec-1">同文档锚点</a></p>
  <p><a id="jsmark" href="rmd-unsupported:javascript">被改写的危险 scheme</a></p>
  <p><a id="rawjs" href="javascript:window.__PWNED=1">反面对照：真的 javascript:</a></p>
</div>
<!-- ⚠️ 加载期错误只能靠这个面看见：经典脚本抛异常时**页面不报给 Swift**，
     表现与"忘了拷某个文件"逐字相同（`frontend.md` 那条结构性约束的同族）。 -->
<script>
  window.rmd = {};
  window.__LOADERR = [];
  window.addEventListener('error', function (e) {
    window.__LOADERR.push(String(e.message) + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0));
  });
</script>
<script src="keymap.js"></script>
<script src="links.js"></script>
<script src="harness.js"></script>
HTML

# ── ② 编译探针 ──
BIN="$WORK/link-nav-probe"
if [ ! -x "$BIN" ] || [ "$SWIFT" -nt "$BIN" ]; then
  echo "▶ 编译探针…" >&2
  swiftc -O "$SWIFT" -o "$BIN" >"$WORK/ln-build.log" 2>&1 || {
    echo "⛔ 编译失败：" >&2; cat "$WORK/ln-build.log" >&2; exit 3
  }
fi

# ── ③ 跑一轮（探针自带 120 秒兜底；这里再套一层 200 秒看门狗）──
RAW="$WORK/ln.json"
ERR="$WORK/ln.err"
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
sed -n '1,6p' "$ERR" >&2 || true

# ── ④ 判据汇总：**退出码就是结论** ──
python3 -I - "$RAW" "$TO_JSON" "$SAVE" "$OUT" "$MODEL" "$TODAY" <<'PY'
import json, os, platform, sys

(raw_path, to_json, save, out, model, today) = sys.argv[1:7]
raw = json.load(open(raw_path, encoding="utf-8"))
if "致命" in raw:
    print("⛔ 致命：" + str(raw["致命"]), file=sys.stderr)
    sys.exit(3)

env = raw.get("环境") or {}
窗口 = env.get("窗口") or {}
导航 = raw.get("导航") or []
观察 = raw.get("观察") or {}
步骤 = {str(s.get("id")): s for s in (raw.get("步骤") or [])}
末步 = (raw.get("步骤") or [{}])[-1].get("id")

检查 = []
def add(cid, name, ok, 判据, 值):
    检查.append({"id": cid, "名": name, "结果": "通过" if ok else "失败",
                 "判据": 判据, "值": 值})

def 窗口内(sid):
    """某一步的导航事件：**半开区间** `[t0, t1)`。

    ⚠️⚠️ 半开是承重的（2026-10-21 实测）：上一步的 `t1` 与下一步的 `t0` 常常是**同一毫秒**
    （`Date.now()` 的粒度就是 1 ms），而"下一步发起的那条导航"恰好落在那一毫秒里。
    闭区间会让它**同时属于两步** ⇒ 判据 3（"本步零导航"）把 3b 那条算进来，假红。
    ⇒ 边界归**后一步**；只有最后一步用闭区间（它后面没有"后一步"了）。
    """
    s = 步骤.get(sid)
    if not s:
        return None, []
    末 = sid == 末步
    return s, [n for n in 导航
               if s.get("t0", 0) <= n.get("ms", 0) and (n.get("ms", 0) <= s.get("t1", 0) if 末
                                                        else n.get("ms", 0) < s.get("t1", 0))]

# 1 · 点击相对链接（处理器 preventDefault）
s1, n1 = 窗口内("s1")
ok1 = (s1 is not None
       and s1.get("followLink_收到") == ["other.md#sec"]
       and s1.get("点击后_defaultPrevented") is True
       and s1.get("location_之前") == s1.get("location_之后")
       and len(n1) == 0
       and any(p.get("action") == "open" and p.get("path") == "/tmp/other.md"
               for p in (s1.get("计划") or [])))
add("1", "点击相对链接：拦住（preventDefault）＋ 原样递相对串 ＋ 不走导航",
    ok1,
    "后注册的监听器读到 defaultPrevented=true ∧ followLink 收到 'other.md#sec'"
    "（⛔ 不是解析后的绝对 URL）∧ location 不变 ∧ 本步窗口内 decidePolicyFor **零次**"
    "∧ 产品 `links.js::plan` 给出 action=open",
    {"步骤": s1, "本步导航": n1})

# 2 · 对照组：程序性导航必须进回调（证明检测器活着）
s2, n2 = 窗口内("s2")
ok2 = (s2 is not None and any("other.md" in (n.get("url") or "") for n in n2))
add("2", "对照组：程序性导航到 other.md（闸门回调活着）",
    ok2,
    "本步窗口内 decidePolicyFor **必须**收到一条 url 含 other.md 的请求"
    "（⚠️ 不可信 click 不触发默认导航 ⇒ 对照组走程序性导航，见文件头）",
    {"本步导航": n2})

# 3 · 同文档锚点：点击被拦；3b 记录"锚点导航走不走回调"这个事实
s3, n3 = 窗口内("s3")
s3b, n3b = 窗口内("s3b")
ok3 = (s3 is not None and s3b is not None
       and s3.get("followLink_收到") == ["#sec-1"]
       and s3.get("点击后_defaultPrevented") is True
       and len(n3) == 0
       and any(p.get("action") == "anchor" for p in (s3.get("计划") or [])))
add("3", "同文档锚点：点击被拦、不进导航；并答出「锚点导航走不走回调」",
    ok3,
    "点击时 preventDefault ＋ followLink 收到 '#sec-1' ＋ plan 给出 action=anchor"
    "∧ 本步窗口内零导航；⭐ 3b 只要求**答得出来**（两种答案都正常，`design/0026` §7.1 0a）",
    {"步骤": s3, "本步导航": n3,
     "3b_锚点导航进回调": bool(n3b), "3b_导航": n3b})

# 4 · 闸门拒绝之后：地址没变、页面还活着
s4, n4 = 窗口内("s4")
ok4 = (s4 is not None
       and any("other.md" in (n.get("url") or "") for n in n4)
       and "other.md" not in (s4.get("location_之后") or "")
       and 观察.get("ALIVE") is True)
add("4", "闸门拒绝后：地址不变、页面存活",
    ok4,
    "程序性导航被 decidePolicyFor 拒绝（= Tauri `on_navigation` 返回 false）"
    "∧ location 里没有 other.md ∧ 之后页面仍能执行（`__ALIVE` 置上）",
    {"步骤": s4, "本步导航": n4})

# 5 · 改写后的危险 scheme：不导航、也没有脚本执行
s5, n5 = 窗口内("s5")
ok5 = (s5 is not None
       and s5.get("followLink_收到") == ["rmd-unsupported:javascript", "javascript:window.__PWNED=1"]
       and len(n5) == 0
       and 观察.get("PWNED") is None)
add("5", "rmd-unsupported:javascript：不导航、无脚本执行",
    ok5,
    "点击被拦、followLink 收到改写后的标记串（另一条真的 `javascript:` 也走同一条路）"
    "∧ 本步窗口内零导航 ∧ `window.__PWNED` 不存在",
    {"步骤": s5, "本步导航": n5, "PWNED": 观察.get("PWNED")})

# ⚠️ 防"探针半路停了还报全绿"：1..5 缺任何一条都当场记成失败。
有 = set(str(c.get("id")) for c in 检查)
for i in range(1, 6):
    if str(i) not in 有:
        检查.append({"id": str(i), "名": "（探针没有产出这一条判据）", "结果": "失败",
                     "判据": "§7.2 的 1–5 必须逐条产出", "值": {"缺": str(i)}})

# ⭐ 判据 E（非数字标签，⛔ 不占用 1–5 的编号）：与 `dir-session-probe` 同口径。
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

def key(c):
    i = str(c.get("id"))
    return (0, int(i), "") if i.isdigit() else (1, 0, i)

检查.sort(key=key)
通过 = [c for c in 检查 if c["结果"] == "通过"]
失败 = [c for c in 检查 if c["结果"] == "失败"]
跳过 = [c for c in 检查 if c["结果"] == "跳过"]

doc = {
    "schema": "rmd-link-nav-probe/1",
    "date": today,
    "口径": {
        "说明": "design/0026 §7.2：跑**产品那两份**（src/services/links.js ＋ src/services/keymap.js）"
                "在真 WKWebView 里的链接导航接线；委托与 followLink 的流程镜像自 src/main.js。",
        "为什么": "纯逻辑与接线那半在 tests/js/links.test.js（26 ＋ 1 条源码级闸门）；"
                  "探针要回答的是**WebKit 那半边**：不 preventDefault 会不会进导航回调、"
                  "同文档锚点走不走 decidePolicyFor（§7.1 0a）、闸门拒绝之后页面还在不在。",
        "被测文件": {
            "links.js": "src/services/links.js（原样拷入，⛔ 探针不抄第二份）",
            "keymap.js": "src/services/keymap.js（K.hasModifier——修饰键判据只有一份）",
            "镜像": "installLinkDelegation / followLink 的结构镜像自 src/main.js"
                    "（根脚本进不了探针页；产品侧由 links.test.js #19–#24 守）",
            "夹具": "tools/wkwebview-probe/link-nav-harness.js",
        },
        "⚠️ 边界": "① `el.click()` 是**不可信事件** ⇒ WebKit 不执行默认导航，"
                   "对照组因此改用程序性 `location.href`（判据 2）；"
                   "② 假后端只假『open_link 会回什么』；"
                   "③ 委托层是镜像 ⇒ ⛔ 不能证明 `main.js` 接对了；"
                   "④ 判据 3b 是**事实记录**，两种答案都正常。",
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
    "导航": 导航,
    "检查": 检查,
    "结论": {"通过": len(通过), "失败": len(失败), "跳过": len(跳过)},
}

if to_json == "1":
    print(json.dumps(doc, ensure_ascii=False, indent=2))
else:
    if 失败:
        print("⛔ 文档内链接导航：**没通过**", file=sys.stderr)
    else:
        print("✅ 文档内链接导航：%d 条全通过" % len(通过), file=sys.stderr)
    for c in 检查:
        mark = {"通过": "✅", "失败": "⛔", "跳过": "⏭"}.get(c["结果"], "?")
        print("%s %-4s %s" % (mark, c["id"], c["名"]), file=sys.stderr)
        if c["结果"] != "通过":
            print("      判据：%s" % c["判据"], file=sys.stderr)
            print("      实测：%s" % json.dumps(c["值"], ensure_ascii=False), file=sys.stderr)
    print("· 3b 锚点导航进回调 = %s" % json.dumps(
        bool(窗口内("s3b")[1]), ensure_ascii=False), file=sys.stderr)
    print(json.dumps(doc, ensure_ascii=False, indent=2))

if save == "1":
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("✅ 结果写入 %s" % out, file=sys.stderr)

sys.exit(1 if 失败 else 0)
PY
