#!/usr/bin/env bash
# 跑 `design/0047` §7.2 **第 6 条**（`make probe-live-block`）：
# **「唯一全文模型 ＋ 单块编辑视图」在真 WKWebView 里的接线与几何**。
#
# 用法：
#   tools/live-probe/block-probe.sh                # 每份夹具一轮 ＋ 三十二处变异（M1–M32），判据进退出码
#   tools/live-probe/block-probe.sh --no-mutate    # 只跑基线（快）
#   tools/live-probe/block-probe.sh --save         # 另存一份到 benchmarks/results/
#   tools/live-probe/block-probe.sh --save --force # 允许覆盖同名结果
#   tools/live-probe/block-probe.sh --json         # 只打原始 JSON
#
# 退出码：0 = 全通过；1 = 有判据**失败**；2 = 有判据**跳过**；3 = 跑不起来；4 = 变异没落到文件里
#
# ⚠️⚠️ **它跑的是真应用**：`src/index.html` ＋ 全部 `src/**`（含 `main.js` 与 `src/live/**`），
#    只把后端换成 `fake-tauri.js`（回 Stage A 用**真 comrak** 导出的载荷）。
#    ⇒ 驱到的是真 `onLiveDocDown` / `makeLiveView` / `swapLiveView`，⛔ 探针不重写那三份。
#    ⚠️ 由此也带来它的**边界**：假后端不渲染 Markdown，所以只在"正文没真正改动"的路径上跑
#    （进入 / 组合 / 撤销后退出）。"改字后整篇重渲"的判据分给 `make probe-live-commit` /
#    `make fidelity` / 人工（可见首帧，§7.1 `0c-②`）。
#
# ⭐ **两段**：
#   ① **Rust 半**：`cargo test --features gui -- --ignored live_block` 跑
#      `commands/document.rs::live_block_夹具导出`，把每份夹具**真实渲染**出来的 html /
#      块表 / toc 写成一份 JSON（⛔ 探针不自己造 HTML——那就是第二份渲染实现）；
#   ② **页面半**：每份夹具建一个页面、各跑一轮（⛔ 不在页内切文档：切文档会重置 `noteLive`，
#      而"点这块进那块"正是要验的东西，切来切去会把失败掩盖成"另一份的基线"）。
#
# ⭐ **判据六段**（逐条见 `block-harness.js` 文件头）：A 启动｜B 逐块几何｜C 结构块不进｜
#   D F6 四段｜G 长代码行（§7.1 `0d`）｜H 纵向链路（§7.1 `0h`）｜
#   ⭐ **L 键入代价（§7.1 `0f`）**：`fixtures/bigblock.md` 的 200 / 800 / 2000 行块里
#   各敲 125 个字符，量 `input` → CM6 事务 → 装饰层重算 → DOM 补丁 → 一次强制同步布局的
#   p50/p95，核对 **p95 ≤ 16 ms**（设计给的进场上限）⇒ 给 `LIVE_LIMITS` 找依据。
#   ⚠️⚠️ 它 **⛔ 不是端到端输入延迟**（不含系统键事件、合成/光栅化、提交后整篇重渲）。
#
# ⚠️ 判据 M1–M32 是**变异测试**，打在**页面副本**上（⛔ 不碰仓库文件）：
#   下面逐条写的是**踩过坑、改法有歧义**的那几条；其余各条（M5 / M9–M19 / M21–M24 / M27–M32）的
#   一句话口径与"必须红哪条判据"在脚本末尾那批 `变异判据(...)` 里，⛔ 不在此重复。
#   M1 = `live/box.js` **只搬文字层、⛔ 不搬外边距**（＝盒子没搬）⇒ 判据 `B0-5` 必须红；
#        ⚠️⚠️ 两个**等价改法**都实测过、都不红（⛔ 别再走一遍）：
#        ① 只删 `swapLiveView` 里那一处 `applyBox` —— `makeLiveView` 建视图时已经搬过一遍；
#        ② 把 `applyBox` 整个停掉 —— 几何闸门会先拒收这一块（`font-size` 对不上），
#           `B0-*` 一条都不产出，表现出来是"变异后 = null"。
#   M2 = `compositionupdate` 也产事务            ⇒ 判据 `D1b` 必须红；
#        ⚠️ 事务的 `next` 必须是**行数组**（`tx` 的契约），传字符串等于什么都没发生。
#   M3 = `commitActive` 去掉「文本没变就短路」    ⇒ 判据 `E1` 必须红。
#   M4 = `save()` **先取全文再提交**（＝写盘拿到的是提交前的那一份）⇒ 判据 `H4` 与 `H5` 必须红；
#        ⚠️ 这两条是**同一次变异**的两个面：H4 判"写下去的是不是基线＋刚敲的字"，
#        H5 判"合回（render_preview）与写盘是不是同一份字节"。⛔ 别按"两条＝两处变异"记。
#        ⚠️ 为什么要这条：`0h` 的纵向链路是本轮唯一真正驱动 `⌘S` 的判据，
#        没有变异就分不清"接线对了"与"判据不承重"。
#   M6/M7 = 把 `bugs/0014`（`⌫`/`⌦` 在折叠选区下一个字符都不删）原样打回
#        （`live/selection.js` 的 `const head = r.from;` → `r.head`）⇒ 判据 `D13`/`D14` 必须红，
#        ⭐ 而 **`D15`（选区删除）必须仍绿**——那正是它当初从 462 条全绿里逃过去的原因。
#   M8 = 把 `bugs/0015` 原样打回：`main.js` 不再把 `bodyLines` 交给装饰层
#        ⇒ 标题块里回车出来的新行仍是标题尺度 ⇒ 判据 `N2` 必须红。
#        ⚠️ 只删 `main.js` 那一行，⛔ 不动 `decorations.js`：纯逻辑判据在那边全绿，
#        那正是这一条要防的形态（"算得对"≠"产品真传了"）。
#   ⚠️ 施加前先校验"模式命中**恰好 1 次**"，并用 `cksum` 证明**真改到了**——
#      否则"没红"会与"断言不承重"长得一模一样（见 `.claude/rules/tests.md`）。
#
# ⚠️⚠️ **不弹窗、不抢焦点、不合成系统按键、不写用户剪贴板**（根 `CLAUDE.md` 工作约定 4）：
#    `.prohibited` ＋ `.borderless` ＋ `alphaValue = 0` ＋ `orderBack`；页内事件是派发到
#    **DOM 元素**上的 `MouseEvent` / `KeyboardEvent` / `CompositionEvent` / `InputEvent`。
#    ⛔ 全程不调 `NSApp.activate` / `makeKey` / `makeFirstResponder`，⛔ 不用 `osascript`。
#    ⚠️ 每条跑完由 `.swift` 自证"前台应用没被抢过"，那一项也进判据。
#
# ⚠️ **默认不落盘**：`benchmarks/results/` 是历史记录（`docs/README.md` §6）。
# ⚠️ 本脚本跑 `/bin/bash` 3.2（macOS 自带）也能过：⛔ 不用 `mapfile` / 关联数组。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

TO_JSON=0
SAVE=0
FORCE=0
MUTATE=1
DIAG=0
for arg in "$@"; do
  case "$arg" in
    --json)      TO_JSON=1 ;;
    --save)      SAVE=1 ;;
    --force)     FORCE=1 ;;
    --no-mutate) MUTATE=0 ;;
    --diag)      DIAG=1 ;;
    -h|--help) sed -n '2,59p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

FIXTURES="$HERE/fixtures"
FAKE="$HERE/fake-tauri.js"
HARNESS="$HERE/block-harness.js"
SWIFT="$HERE/probe.swift"
SRC="$ROOT/src"
CM6="$SRC/vendor/cm6.bundle.js"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 3
fi
for f in "$FAKE" "$HARNESS" "$SWIFT" "$SRC/index.html"; do
  if [ ! -f "$f" ]; then
    echo "⛔ 缺 $f" >&2
    exit 3
  fi
done
if [ ! -s "$CM6" ]; then
  echo "⛔ 缺 $CM6 —— 先跑 make cm6（⛔ 本脚本不替你装依赖）" >&2
  exit 3
fi
if ! ls "$FIXTURES"/*.md >/dev/null 2>&1; then
  echo "⛔ 夹具目录里没有 .md：$FIXTURES" >&2
  exit 3
fi

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/live-block-${TODAY}-${MODEL}.json"
if [ "$SAVE" = "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 3
fi

WORK="$HERE/.lb-work"
rm -rf "$WORK"
mkdir -p "$WORK/other"

# ── ① Stage A：用**真 comrak** 把夹具渲染成载荷（Rust 半，`#[ignore]` 测试点名跑）──
FIXTURE_JSON="$WORK/fixtures.json"
echo "▶ Stage A：真 comrak 导出一份夹具载荷…" >&2
(
  cd "$ROOT/src-tauri"
  RMD_LIVE_BLOCK_DIR="$FIXTURES" RMD_LIVE_BLOCK_OUT="$FIXTURE_JSON" \
    cargo test --release --offline --features gui -- --ignored --nocapture live_block \
    >"$WORK/stage-a.log" 2>&1
) || {
  echo "⛔ Stage A 失败（cargo test --ignored live_block）：" >&2
  sed -n '1,60p' "$WORK/stage-a.log" >&2
  exit 3
}
if [ ! -s "$FIXTURE_JSON" ]; then
  echo "⛔ Stage A 没产出载荷：$FIXTURE_JSON" >&2
  sed -n '1,40p' "$WORK/stage-a.log" >&2
  exit 3
fi

# ⭐ 夹具名（⚠️ **块最多的那份排第一** ⇒ 主夹具：F6、H 链路与五次变异都压在它身上，
#    块越多越能暴露"点这块进那块"；其余夹具只跑 F5 ＋ 几何 + ⭐ D 段删除五连那半）。
NAMES_FILE="$WORK/names.txt"
python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
for doc in sorted(d["docs"], key=lambda x: -len(x["blocks"])):
    print(doc["name"])
' "$FIXTURE_JSON" > "$NAMES_FILE"
if [ ! -s "$NAMES_FILE" ]; then
  echo "⛔ 夹具载荷里没有文档" >&2
  exit 3
fi
TARGET="$(sed -n '1p' "$NAMES_FILE")"
echo "▶ 夹具：$(tr '\n' ' ' < "$NAMES_FILE")（$(wc -c < "$FIXTURE_JSON" | tr -d ' ') 字节）" >&2

# ── ② 组装一份页面：产品 `src/` **整棵拷进去**（⛔ 不用符号链接：
#      `allowingReadAccessTo` 是按目录给的，链接指到目录外读不到） ──
#
# ⚠️ 与 `wkwebview-probe/*` 那族**不同**：这里拷的是**整份真应用**（含 `main.js`），
#    因为本探针要验的正是 `main.js` 里那几段接线（`onLiveDocDown` / `makeLiveView` /
#    `swapLiveView`）。只注入三样：夹具、假后端、harness。
build_page() {
  local dir="$1" name="$2"
  rm -rf "$dir"
  mkdir -p "$dir"
  cp -R "$SRC/." "$dir/"
  # ⚠️ 注入的三个脚本排在 `vendor/cm6.bundle.js` **之前**：`main.js` 与 `live/**` 都在
  #    **加载期**取 `window.rmd.*`，而这三个只碰 `window.__FIXTURE` / `__TAURI__` / `__RUN`，
  #    ⛔ 不读产品全局 ⇒ 放最前不会改变任何加载期依赖关系。
  python3 -I - "$FIXTURE_JSON" "$name" "$dir/__fixture.js" <<'PY'
import json, sys
src, name, out = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src, encoding="utf-8"))
doc = next(x for x in d["docs"] if x["name"] == name)
# ⭐ 键位表是**整轮共用**的一份（Rust 的 `gui::SHORTCUTS`），⛔ 不是每份夹具一份：
#    `0h` 的纵向链路要按 `⌘S`，而空表会让"按了没反应"与"产品没接线"长得一模一样。
doc["shortcuts"] = d.get("shortcuts") or []
with open(out, "w", encoding="utf-8") as f:
    f.write("window.__FIXTURE = ")
    json.dump(doc, f, ensure_ascii=False)
    f.write(";\n")
    # ⭐ **未捕获异常收集器**（2026-10-27）：它必须是**全页第一个脚本**——
    #    产品在事件处理器里抛错时，异常只会进 `window.onerror`，**不会**让
    #    `dispatchEvent` 抛出来 ⇒ 探针看到的是"按了没反应"，与"按键没接线"一模一样。
    #    ⚠️ 判据是 `Z1`（`block-harness.js` 末尾）；只收 `window` 上的脚本错误，
    #    ⛔ 不收资源加载失败（`<img>` 404 那一类会把它污染成永红）。
    f.write('''
window.__ERR = [];
window.addEventListener('error', function (e) {
  if (!e || e.target !== window) return;
  window.__ERR.push({ 类型: 'error', 消息: String(e.message || ''),
    位置: String(e.filename || '').split('/').pop() + ':' + (e.lineno || 0) });
}, true);
window.addEventListener('unhandledrejection', function (e) {
  var r = e && e.reason;
  window.__ERR.push({ 类型: 'rejection',
    消息: String((r && r.message) || r || '').slice(0, 200) });
}, true);
''')
PY
  cp "$FAKE" "$dir/__fake-tauri.js"
  cp "$HARNESS" "$dir/__harness.js"
  # `--diag`：把**页面副本**里那道几何检查关掉（⛔ 仓库文件一字未动），好把每个块的
  # 「原高 vs 视高」与被换掉那一块的计算样式一起打出来 —— 这是"改哪儿"的依据，⛔ 不是判据。
  if [ "$DIAG" = "1" ]; then
    printf 'window.__DIAG = true;\n' > "$dir/__diag.js"
    # ⚠️ 这里改过三次，每次都是**产品那一行变了**：
    #    2026-10-26 闸门带上"允许量"（`slack`）／2026-10-27 `design/0049` 又加 `!wantCell && (`；
    #    ⭐ **2026-10-27 `design/0052` U6 把"拒收"整条删掉了**（`INV-KERNEL-05`：块永远进得去）
    #    ⇒ 从前的目标串**一个字都不剩**。现在 `--diag` 关的是**变矮告警**那一支
    #    （同样只改页面副本）——它的用处变成"别让告警混进诊断输出"，⛔ 不再是"绕过拒收"。
    #    ⚠️ 命中 0 一律退 4（`apply_mutation` 自己查），⛔ 别让 `--diag` 静默退化。
    apply_mutation "$dir/live/index.js" \
      "if (!wantCell && diff < -HEIGHT_TOLERANCE) {" \
      "if (false) {"
  else
    printf 'window.__DIAG = false;\n' > "$dir/__diag.js"
  fi
  python3 -I - "$dir/index.html" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
needle = '  <script src="vendor/cm6.bundle.js"></script>\n'
if src.count(needle) != 1:
    print("HITS=%d（期望 1）" % src.count(needle), file=sys.stderr)
    sys.exit(4)
inject = ('  <script src="__fixture.js"></script>\n'
          '  <script src="__fake-tauri.js"></script>\n')
src = src.replace(needle, inject + needle)
tail = '</body>\n</html>'
if src.count(tail) != 1:
    print("TAIL=%d（期望 1）" % src.count(tail), file=sys.stderr)
    sys.exit(4)
src = src.replace(tail, '  <script src="__diag.js"></script>\n'
                        '  <script src="__harness.js"></script>\n' + tail)
open(path, "w", encoding="utf-8").write(src)
PY
}

# ── ③ 编译运行器 ──
BIN="$WORK/live-block-probe"
echo "▶ 编译运行器…" >&2
swiftc -O "$SWIFT" -o "$BIN" >"$WORK/build.log" 2>&1 || {
  echo "⛔ 编译失败：" >&2; sed -n '1,40p' "$WORK/build.log" >&2; exit 3
}

# ── ④ 跑一轮（运行器自带 180 秒兜底；这里再套一层 240 秒看门狗）──
run_round() {
  local page="$1" raw="$2" err="$3"
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
    echo "⛔ 运行器没产出 JSON（${page}）。stderr：" >&2
    sed -n '1,60p' "$err" >&2
    exit 3
  fi
  # ⭐ **环境闸门**（2026-10-27 真踩过，`design/0052` U6 收尾那一轮）：
  #    屏幕锁上 / 显示器睡眠 ⇒ WebKit 停掉显示链路，`requestAnimationFrame` 不再回调，
  #    每一帧都走 300 ms 兜底 ⇒ 整轮拖过 180 秒，报出来的却是「180 秒没拿到结果」，
  #    看上去像产品挂死。页面那边已先判过（`block-harness.js::帧健康`）⇒ 这里把它
  #    **同一个事实**翻译成人看得懂的一句话，并且**立刻整轮收工**，⛔ 不再跑后面的页面。
  #    ⚠️ 退出码仍用 3（与"编译失败 / 没产出 JSON"同属**环境与基建**那一档），
  #       ⛔ 不与 1（判据红）/ 4（变异没施加）混在一起——它是"这轮数字作废"，不是"产品坏了"。
  if python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); sys.exit(0 if d.get("环境有效") is False else 1)' "$raw" 2>/dev/null; then
    echo "⛔ 本轮无效：页面不可见，requestAnimationFrame 一次都没触发" >&2
    echo "   （屏幕已锁 / 显示器睡眠 / 页面被 WebKit 冻结）⇒ 几何与时序数字全部作废。" >&2
    echo "   ⚠️ 这不是产品缺陷；解锁后重跑同一命令。" >&2
    sed -n '1,20p' "$err" >&2
    exit 3
  fi
  sed -n '1,8p' "$err" >&2 || true
}

# ── ⑤ 变异：⛔ 只打**页面副本**；命中数必须恰好 1，`cksum` 必须变 ──
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

PRIMARY_PAGE="$WORK/page-base"
build_page "$PRIMARY_PAGE" "$TARGET"
echo "▶ 跑基线（真应用、离屏、无前台切换、无系统级按键）…" >&2
run_round "$PRIMARY_PAGE" "$WORK/base.json" "$WORK/base.err"

# `--diag`：只打诊断，⛔ 不判判据、⛔ 不落盘（这是给"改哪儿"取证用的）。
if [ "$DIAG" = "1" ]; then
  echo "▶ 诊断（⛔ 不是判据；几何闸门已在**页面副本**上关掉）：" >&2
  python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1], encoding="utf-8")), ensure_ascii=False, indent=1))' \
    "$WORK/base.json"
  exit 0
fi

# 其余夹具各跑一轮（⚠️ 只跑 F5 ＋ 几何那半；F6 只压在第一个夹具上，⛔ 别重复计条）
while read -r name; do
  [ -n "$name" ] || continue
  page="$WORK/page-$name"
  build_page "$page" "$name"
  echo "▶ 跑夹具 ${name}…" >&2
  run_round "$page" "$WORK/other/$name.json" "$WORK/other/$name.err"
done < <(sed -n '2,$p' "$NAMES_FILE")

if [ "$MUTATE" = "1" ]; then
  # M1：**外边距**一点都不搬 ⇒ host 是 `div`，天然没有 `.doc p` 的 `margin-bottom`
  #     ⇒ 下面的块整体上跳（正文 14px 下那条 15.4px）⇒ 判据 `B0-5`（块外零位移）必须红。
  #     ⚠️⚠️ 只变异**外边距**这一支，⛔ 不是把 `applyBox` 整个停掉：
  #     它还搬 `font-size` / `line-height`，一起停掉的话 `h1` / 引用块的 `offsetHeight`
  #     先对不上 ⇒ **几何闸门直接拒收这一块**，`B0-*` 一条都不产出
  #     （2026-10-26 实测：`M1` 的"变异后"是 `null`，那是"块根本没进去"，不是"判据红了"）。
  #     ⚠️⚠️ 也⛔ 不能只删 `swapLiveView` 那一处调用：`makeLiveView` 建视图时已经搬过一遍，
  #     只删换入那处是**等价改法**（同一轮实测：判据全绿，而那不是"判据不敏感"）。
  P1="$WORK/page-m1"; build_page "$P1" "$TARGET"
  echo "▶ M1：外边距一点都不搬…" >&2
  apply_mutation "$P1/live/box.js" \
    "      host.style.setProperty(k, box[k]);" \
    "      if (k.slice(0, 6) === 'margin') return;
      host.style.setProperty(k, box[k]);"
  run_round "$P1" "$WORK/m1.json" "$WORK/m1.err"

  # M2：`compositionupdate` 也产事务（= 组合串进了文档，浏览器每帧自己排版）
  #     ⇒ 判据 `D1b`（组合期块内文本不变）必须红。
  P2="$WORK/page-m2"; build_page "$P2" "$TARGET"
  echo "▶ M2：组合中间态也落事务…" >&2
  #     ⚠️ `tx` 的 `next` 契约是**行数组**（`compositionend` 用的是 `text.split('\n')`）；
  #     传字符串等于什么都没发生（2026-10-26 实测：判据照样绿，而那不是"判据不敏感"）。
  apply_mutation "$P2/live/input.js" \
    "            state.provisional = e.data || '';" \
    "            state.provisional = e.data || ''; tx(state.start, state.end, (e.data || '').split('\n'), 'compositionupdate');"
  run_round "$P2" "$WORK/m2.json" "$WORK/m2.err"

  # M3：去掉「文本没变就短路」⇒ 每次退出都整篇重渲 ⇒ 判据 `E1` 必须红。
  #     ⚠️⚠️ **2026-10-28 换靶**：`design/0054` 之后这条短路有**两处**（同一个事实写了两遍）：
  #     ① `commitActive` 的 `sameLines(next, cur)`；② `publish` 的 `candText === baseText`。
  #     ⇒ 只摘一处**等于什么都没发生**（另一处照样短路、`E1` 仍绿）——那是「改法等价」，
  #     不是「判据不敏感」⇒ 这条变异**必须两处一起摘**，各自 `HITS=1` 自检。
  P3="$WORK/page-m3"; build_page "$P3" "$TARGET"
  echo "▶ M3：未改动也提交…" >&2
  apply_mutation "$P3/live/index.js" \
    "      if (sameLines(next, cur)) return { committed: false, failed: false, why: '' };" \
    "      /* 变异：未改动也短路（外层）摘掉 */"
  apply_mutation "$P3/live/index.js" \
    "      if (candText === baseText) return { committed: false, failed: false, why: '' };" \
    "      /* 变异：未改动也短路（发布层）摘掉 */"
  run_round "$P3" "$WORK/m3.json" "$WORK/m3.err"

  # M4：`save()` **先取全文、后提交** ⇒ 写盘用的是"提交前"的那一份
  #     ⇒ 用户敲的那一块的改动没写进去 ⇒ 判据 `H4`（写下去 = 基线 ＋ 刚敲的字）必须红；
  #     同一次变异还会让 `H5`（render ≡ save 同一份字节）红——那是同一处缺陷的第二个面。
  #     ⚠️ 两条判据**共用同一份变异产物** `m4.json`，⛔ 不是两处变异。
  P4="$WORK/page-m4"; build_page "$P4" "$TARGET"
  echo "▶ M4：保存取的是提交前的全文…" >&2
  #     ⚠️⚠️ **2026-10-29 二度换靶**（`design/0054` §10.11 的 P1-2 把 `save()` 的快照改成
  #     `sess.lines()` / `sess.fullText()` 的**同批快照**，旧靶子 `const text = session.fullText();`
  #     已经不存在 ⇒ 上一版这里 `HITS=0`、整轮退 4）。现在把写出去的那份文本取成**基线**
  #     （＝提交前那一份）就等价复现了这条缺陷：写下去的文本里没有刚敲的那个字。
  apply_mutation "$P4/live/index.js" \
    "      const snapText = sess.fullText();" \
    "      const snapText = baseline ? baseline.join('\n') : sess.fullText(); /* 变异：写的是提交前那份 */"
  run_round "$P4" "$WORK/m4.json" "$WORK/m4.err"

  # M6：⭐ **把 2026-10-27 那个真缺陷原样打回去**——`deleteRange` 读 `range()` 里
  #     **不存在**的 `head` ⇒ `undefined` 进算术 ⇒ `NaN` ⇒ `to > from` 恒假 ⇒ 折叠选区下
  #     **一个字符都不删**，而**有选区时**照常能用。
  #     ⇒ 判据 `D13`（`⌫`）与 `D14`（`⌦`）必须红，而 `D15`（选区删除）**必须仍绿**
  #     ——那正是它当初从 462 条全绿里逃过去的原因（`bugs/0014`）。
  #     ⚠️ 两条判据共用同一份 `m6.json`，⛔ 不是两处变异。
  P6="$WORK/page-m6"; build_page "$P6" "$TARGET"
  echo "▶ M6：删除读了一个不存在的字段…" >&2
  apply_mutation "$P6/live/selection.js" \
    "    const head = r.from;" \
    "    const head = r.head;"
  run_round "$P6" "$WORK/m6.json" "$WORK/m6.err"

  # M8：⭐ **把 `bugs/0015` 原样打回去**——`main.js` 不再把 `bodyLines` 交给装饰层
  #     ⇒ 标题块里的非标题行不再带回落类 ⇒ 回车出来的新行继承 host 上那一份**块级**
  #     文字层（`h2` = 24.5px/700）⇒ 判据 `N2` 必须红。
  #     ⚠️ 只删 `main.js` 那一行，⛔ 不动 `decorations.js`：那边的纯逻辑判据（"该给哪些行贴类"）
  #     照样全绿——这正是一条"算得对 ≠ 产品真传了"的缺口，只有真 DOM 这一层看得见。
  P8="$WORK/page-m8"; build_page "$P8" "$TARGET"
  echo "▶ M8：不再把 bodyLines 交给装饰层…" >&2
  apply_mutation "$P8/main.js" \
    "      bodyLines: !!(LBox && typeof LBox.headingLevelOf === 'function' && LBox.headingLevelOf(el) > 0),
" \
    ""
  run_round "$P8" "$WORK/m8.json" "$WORK/m8.err"

  # M10：⭐ **把 `bugs/0016` 原样打回去**。
  #     ⚠️⚠️ **2026-10-27 `design/0052` U3 之后这个变异必须换目标**：行品种不再由
  #     `HEADING` 那条正则判（U5 起 `HEADING` 只剩 `layoutSlack()` 一个调用方），
  #     真正决定"这一行是不是标题"的是**语法树节点** `HEADING_NODE`（第 205 行）。
  #     ⇒ 变异改成"标题节点里除了井号什么都没有时，不按标题排"——这正是缺陷的用户面：
  #     一行只剩 `##`（CommonMark 里是**空 ATX 标题**）在渲染态是空 h2、在编辑态塌成正文 14px。
  #     判据 `O-h1-5`／`O-ul-5` 必须红，而 `O-p-5`（折行块上那行是 `##类…`，本来就不是标题）、
  #     `O-pre-5`（围栏里是代码）、全部 `-5b`（已经删干净、没有标题节点）**必须仍绿**。
  #     ⚠️ 这一处**只有 O 段看得见**：`N` 段只问"回车出来的新行"，`B` 段量的是整块高度，
  #     纯逻辑那半（`tests/js/live-decorations.test.js`）是**另一层**的同一处缺陷。
  P10="$WORK/page-m10"; build_page "$P10" "$TARGET"
  echo "▶ M10：只剩井号的行不当标题…" >&2
  apply_mutation "$P10/live/decorations.js" \
    "          const h = HEADING_NODE.exec(name);
          if (h) {" \
    "          const h = HEADING_NODE.exec(name);
          if (h && /[^\\s#]/.test(src.slice(node.from, node.to))) {"
  run_round "$P10" "$WORK/m10.json" "$WORK/m10.err"

  # M11：删掉 `paste` 的监听器 ⇒ 粘贴**静默失效**（剪贴板内容进了离屏 textarea、
  #     却不进文档；屏幕上什么都不动）⇒ 判据 `O-h1-5c` 必须红。
  #     ⚠️ 这一处**只有 O 段看得见**：`live-input.test.js` 压的是状态机（`handle({type:'paste'})`），
  #     `live-wiring.test.js` 只查三行里面有 `'paste'`（删掉整行也还是"没有 paste" ⇒ 它照样红，
  #     但那条只说明"接线丢了"，**说不出用户会看到什么**）。
  P11="$WORK/page-m11"; build_page "$P11" "$TARGET"
  echo "▶ M11：粘贴的监听器不接…" >&2
  apply_mutation "$P11/main.js" \
    "    input.addEventListener('paste', onPaste);" \
    "    /* 变异：粘贴不接线 */"
  run_round "$P11" "$WORK/m11.json" "$WORK/m11.err"

  # ── `bugs/0018` 的三处（2026-10-27 用户实测「一旦进入标签模式，就出不来」）──
  #   ⚠️⚠️ 这三条**全都只有 P 段看得见**：B 段只用 `键(ta,'Escape')` 一种退出方式，
  #     而且**直接往 `ta` 派发**（判不了焦点在不在它身上）⇒ 三条缺陷它一条都撞不到。
  #   ⚠️ **M12 已不是这三处之一**（2026-10-28 二度换靶，见下面那段）：它现在打的是
  #     "重复节点"这一类通用缺陷，仍落在 P 段、仍以 `P6` 为判据。

  # M12：`swapLiveView` **不摘旧节点**（`insertBefore(host, el)` 之后少了 `removeChild(el)`）
  #     ⇒ 同一段文字在**原地**再出现一次（同一个 `el` ＋ 它前面的 `host`），`#doc` 的孩子
  #     多一个 ⇒ 判据 `P6`（提交重渲之后没有多余节点）必须红。
  P12="$WORK/page-m12"; build_page "$P12" "$TARGET"
  echo "▶ M12：换进去之后不摘旧节点…" >&2
  #     ⚠️⚠️ **2026-10-28 二度换靶（本轮的实跑结论，⛔ 不是又一次翻译）**：
  #     上一版靶子是"把 `swap.undo()` 从 `mount` 之前挪到之后"（`bugs/0018` 的原形态）。
  #     实跑 **P6 基线绿、变异后仍绿** ⇒ 按纪律查了「没红四种」，结论是 **③ 改法等价**：
  #     `d.mount()` 收尾就调 `noteLive(payload)` ⇒ `reseatLive()` ⇒ `index.js::reseat()`
  #     把 `a.swap` 换成**新树上的**一个（`swapLiveView` 重新 `insertBefore`）。
  #     ⇒ 那次 `a.swap.undo()` 撤的是**刚建好的**新 swap，`next` 就在树里
  #     （探针实测 `nextInParent=true`、`host在树里=true`）⇒ 完美复原，⛔ 没有多余节点。
  #     ⭐ 也就是说 `design/0054` 那句"摘宿主必须在 `mount` 之前"如今是**纵深防御**，
  #     ⛔ 不再是唯一承重面（真正承重的是"`reseat` 必须在 `mount` 收尾重建 swap"）。
  #     ⇒ 换成"重复节点"这一类靶子：它确实会打红 P6。
  #     ⚠️⚠️ 附带 13 条 `B*-5 块外零位移` ＋ `P7` 一起红——那是**重复节点的物理后果**
  #     （下面每一块都被顶下去），⛔ 不是变异写坏了；⚠️ 但也因此它**证明不了 P6 独立承重**
  #     （见 `design/0054` §10.9 那条"没能自动验证"）。
  apply_mutation "$P12/main.js" \
    "    if (parent) parent.insertBefore(host, el);
    if (parent) parent.removeChild(el);" \
    "    if (parent) parent.insertBefore(host, el);
    /* 变异：不摘旧节点 */"
  run_round "$P12" "$WORK/m12.json" "$WORK/m12.err"

  # M13：`begin()` 不再按新表 / 新树重取（用调用方手里那份过期的 `block` / `el`）
  #     ⇒ 点另一块时 `el` 已脱树、`block` 是旧行区间 ⇒ 判据 `P7`（进去的是被点那一块）必须红。
  P13="$WORK/page-m13"; build_page "$P13" "$TARGET"
  echo "▶ M13：点另一块时用过期节点…" >&2
  apply_mutation "$P13/live/index.js" \
    "      if (switched) {" \
    "      if (false) { /* 变异：不重取 */"
  run_round "$P13" "$WORK/m13.json" "$WORK/m13.err"

  # M14：删掉 `document` 级的键盘兜底 ⇒ 焦点一离开离屏 textarea（用户点过侧栏 / 顶栏），
  #     `Esc` 一个字节都收不到 ⇒ **没有任何键能退出**，屏幕上覆盖层还好端端开着。
  #     ⇒ 判据 `P4` 必须红。⚠️ 这一处只有 P 段看得见：B 段的事件**恒派发到 `ta`**。
  P14="$WORK/page-m14"; build_page "$P14" "$TARGET"
  echo "▶ M14：去掉键盘兜底…" >&2
  apply_mutation "$P14/main.js" \
    "    document.addEventListener('keydown', onLiveGlobalKey, true);" \
    "    /* 变异：没有兜底 */"
  run_round "$P14" "$WORK/m14.json" "$WORK/m14.err"

  # M15（`design/0049`）：单元格写回不再走 `cell.js::splice`，改成**整行重拼**
  #     ⇒ 两侧填充空格被吃掉（`INV-CELL-01`）⇒ 判据 `Q5d`（改的正是那一格）必须红。
  #     ⚠️ 这一处只有 `Q` 段看得见：`live-cell.test.js` 验的是 `splice` 本身，
  #     而那 13 条判据在"产品不调它"时**全绿**。
  P15="$WORK/page-m15"; build_page "$P15" "$TARGET"
  echo "▶ M15：单元格写回整行重拼…" >&2
  #     ⚠️ 2026-10-28 首次换靶（`padFor` 落地）；⚠️⚠️ **同日第二次换靶**：`design/0054` 把
  #        写回改成"候选 → 校验 → 发布"之后，`padFor` 的产物先存进 `replacement`（校验请求要带它），
  #        `splice` 那一行只接 `replacement`。⇒ 靶子落在 `splice` 这一行，⛔ 不是 `padFor` 那一行
  #        （改 `padFor` 自己会让**校验**先拒掉，提交根本不发生 ⇒ `Q5d` 红是"没提交"而不是"写错了"）。
  apply_mutation "$P15/live/index.js" \
    "        nextLine = cellMod.splice(cur, a.cell.from, a.cell.to, replacement);" \
    "        nextLine = '| ' + encoded + ' |'; /* 变异：整行重拼、丢掉两侧填充 */"
  run_round "$P15" "$WORK/m15.json" "$WORK/m15.err"

  # M16（`design/0049`）：单元格提交从"一行换一行"退回**整篇提交**
  #     ⇒ 同排其余格子与整篇都会被重写 ⇒ 判据 `Q5c`（提交只动了那一行）必须红。
  P16="$WORK/page-m16"; build_page "$P16" "$TARGET"
  echo "▶ M16：单元格提交改成整篇提交…" >&2
  #     ⚠️⚠️ **2026-10-28 换靶**：单元格提交现在经 `publish()`，`session.commit` 由它统一发；
  #     靶子因此落在 `commitCell` 给的那份**行区间**上（把它放大成整篇）。
  apply_mutation "$P16/live/index.js" \
    "        range: { from: from, to: from + 1 }," \
    "        range: { from: 0, to: lines.length }, /* 变异：整篇提交 */"
  run_round "$P16" "$WORK/m16.json" "$WORK/m16.err"

  # ── `design/0051`（任务项就地打勾）的两处 ──

  # M17：`armTaskBoxes()` 只摘 `disabled`、**不接 click** ⇒ 方框看起来能点、点下去
  #     `checked` 也会翻（浏览器原生激活），但**没有任何提交**：屏幕上是"勾上了"，
  #     文件里一个字节都没变——关掉重开就回去了。
  #     ⇒ 判据 `V1`（点方框发出一次提交）必须红。
  #     ⚠️ 这一处**只有 V 段看得见**：`live-task.test.js` 验的是 `toggleLine`/配对逻辑本身，
  #     那 11 条在"产品根本不接这条路"时**全绿**。
  #     ⚠️ 2026-10-29 第 15 条**换靶**：武装本体已从 `main.js::armTaskBoxes` 搬进
  #     `live/task.js::arm`（那里 `make typecheck` 查得到、`live-task.test.js` 用假节点跑得到）
  #     ⇒ 靶子跟着搬，⛔ 别让它留在一条已经不存在的行上（那样 `HITS=0` 直接退 4）。
  P17="$WORK/page-m17"; build_page "$P17" "$TARGET"
  echo "▶ M17：方框不接 click…" >&2
  apply_mutation "$P17/live/task.js" \
    "      if (typeof h.click === 'function') box.addEventListener('click', h.click);" \
    "      /* 变异：不接 click */"
  run_round "$P17" "$WORK/m17.json" "$WORK/m17.err"

  # M18：`toggleLine` 的翻转改成**恒变勾上**（取消勾选这条路消失）⇒ 第一次点仍然对，
  #     第二次点**回不去**——文件里那个字节永远停在 `x`。
  #     ⇒ 判据 `V4`（再点一次逐字节回到原样）必须红，而 `V2`（只改那一处）仍应绿
  #     （它只问"改了几处"，不问方向）。⚠️ 这条只有"点第二次"的判据抓得住。
  P18="$WORK/page-m18"; build_page "$P18" "$TARGET"
  echo "▶ M18：勾上之后取消不了…" >&2
  apply_mutation "$P18/live/task.js" \
    "    else if (sym === CHECKED || sym === 'X') next = UNCHECKED;" \
    "    else if (sym === CHECKED || sym === 'X') next = CHECKED; /* 变异：取消不了 */"
  run_round "$P18" "$WORK/m18.json" "$WORK/m18.err"

  # M19：把 2026-10-27 真抓出来的那个缺陷**原样打回**——`isCheckedSymbol` 的口径是
  #     「把**翻之前**那一行翻一下之后是不是勾上」，传 `nextLine` 等于**连翻两下**
  #     ⇒ 状态条永远说反（勾上了却说「已取消勾选」）。
  #     ⇒ 判据 `V3b`（状态条说的是「已勾选」）必须红。
  #     ⚠️⚠️ 这一处**任何纯逻辑判据都看不见**：`task.js` 的两个函数各自的单测都是绿的，
  #     错的是调用点传了哪个参数——只有真点一下再看状态条才发现得了。
  P19="$WORK/page-m19"; build_page "$P19" "$TARGET"
  echo "▶ M19：状态条文案说反…" >&2
  apply_mutation "$P19/live/index.js" \
    "      const checked = taskMod.isCheckedSymbol(cur, span.from, span.to);" \
    "      const checked = taskMod.isCheckedSymbol(nextLine, span.from, span.to); /* 变异 */"
  run_round "$P19" "$WORK/m19.json" "$WORK/m19.err"

  # ── `design/0052` U7（`⌘↵` 新起一段，2026-10-28 按用户更正重写）──
  #
  # M20：撤销**不把光标放回去**（恒 `caretPos: 0`）⇒ 一次 `⌘Z` 之后正文回来了，
  #     但用户的光标落在新段落段首（屏幕上表现为"撤销把光标甩到别处"）。
  #     ⇒ 判据 `W2b`（一次 ⌘Z 把光标放回操作前那一处）必须红，
  #     而 `W2`（正文恢复）与 `W5`（裸 Enter 只多一个换行）**必须仍绿**——
  #     `W5` 的期望值用的是**此刻真实的光标**（2026-10-28 为此特意解耦），
  #     所以它能当负对照；否则说明它把"撤销恢复光标"也算进了自己的成败。
  #     ⚠️ 这一处**探针与 `live-controller.test.js` 都看得见**（那边判的是同一件事的
  #     纯逻辑面：`focusAt` 收到的 `pos`），但**探针这一格是端到端面**：只有它经过
  #     真 `mountDocument` 重渲＋重挂视图，纯逻辑那条到不了那条路。
  P20="$WORK/page-m20"; build_page "$P20" "$TARGET"
  echo "▶ M20：撤销不把光标放回去…" >&2
  apply_mutation "$P20/live/index.js" \
    "          caretPos: Number.isInteger(s.caretBefore) ? s.caretBefore : 0," \
    "          caretPos: 0, /* 变异：撤销不恢复光标 */"
  run_round "$P20" "$WORK/m20.json" "$WORK/m20.err"

  # ── `design/0049`（表格单元格）的第三处：**离屏标记没摘**（2026-10-28 用户实测）──
  #
  # M21：`swapLiveCell` 换进 `<td>` 时**不重写 `host.className`** ⇒ 那一格仍带着
  #     `cm-rmd-offscreen`（`position: fixed; visibility: hidden; pointer-events: none`）
  #     ⇒ 点一下，**格子里的字整片消失**、光标也画在离屏层里。
  #     用户原话：「对于表格数据，点击表格中的数据，数据会消失，无法选中，无法编辑。」
  #     ⇒ 判据 `Q1b`（看得见）与 `Q1c`（文字仍在）必须红。
  #     ⚠️⚠️ 这一处**Q 段原来一条判据都抓不住**（所以它一直绿）：
  #     `Q1` 只判 `parentElement`（离屏宿主照样满足）、列宽被冻结 ⇒ `Q2` 绿、
  #     同一行别的格子撑着行高 ⇒ `Q2b` 绿、`Q3`–`Q5d` 读的 `.cm-content` 文本一字不差。
  #     ⚠️ 负对照 `Q2`/`Q2b`/`Q3`/`Q5b` 在变异后**必须仍绿**——否则说明它们也在量"可见性"，
  #     那就不该把它们当成几何/载荷判据来引用。
  P21="$WORK/page-m21"; build_page "$P21" "$TARGET"
  echo "▶ M21：单元格换进文档流时不摘离屏标记…" >&2
  apply_mutation "$P21/main.js" \
    "    host.className = 'cm-rmd-liveHost cm-rmd-cell';" \
    "    /* 变异：不摘离屏标记 */"
  run_round "$P21" "$WORK/m21.json" "$WORK/m21.err"

  # ── `design/0049`（表格单元格）的第四处：**这一格的水平溢出漏给了表格**（2026-10-28 实测）──
  #
  # M22：把 `.cm-rmd-cell` 的 `overflow-x: clip` 摘掉 ⇒ 格子里编辑视图的**瞬时溢出**
  #     （CM6 量行高时塞进 `.cm-content` 的那个 `width: 99999px` 绝对定位 `.cm-line` 替身）
  #     会传到 `.doc table`（`display: block; overflow-x: auto`）⇒ WebKit 给表格分配一条
  #     **经典横向滚动条**，而 `style.css` 的 `::-webkit-scrollbar { height: 12px }` 让它
  #     **实打实吃掉 12 px 高度**：整张表长高、下面所有内容被推下去（`bugs/0027`）。
  #     ⇒ 判据 `Q2b`（表高不变）与 `Q2c`（下游零位移）必须红。
  #     ⚠️⚠️ 负对照 `Q1b`/`Q1c`（看得见）与 `Q1d`（那一格自身高度）**必须仍绿**：
  #     它们量的是"这一格"，而这条缺陷量的是"整张表"——两者分开才说明判据各管一件事。
  P22="$WORK/page-m22"; build_page "$P22" "$TARGET"
  echo "▶ M22：单元格的水平溢出不再就地截断…" >&2
  apply_mutation "$P22/styles/live.css" \
    "  overflow-x: clip;
  overflow-y: visible;" \
    "  /* 变异：不截这一格的水平溢出 */"
  run_round "$P22" "$WORK/m22.json" "$WORK/m22.err"

  # ── `design/0049`（表格单元格）的第五处：**粘贴进来的换行在入口就被折掉** ──
  #
  # M23：把 `live/objects.js` 单元格策略的 `text` 从**恒等**改成"`\n` → 空格"
  #     ⇒ 两行粘进一格时，**视图里只剩一行**（真实的第二行根本没进视图）。
  #     ⇒ 判据 `Q14b`（粘贴两行之后视图里**两行都在**、且高度 == 阅读态两行的高度）必须红。
  #     ⚠️⚠️ **2026-10-28 换靶**（`bugs/0035` 用户需求变更）：这道折行**原先在**策略表里
  #     （`text: foldNewlines`），`bugs/0035` 之后格内换行合法 ⇒ 产品的策略是恒等，
  #     靶子只能反过来施加"打回旧形态"。继续用旧 old-string 会 `HITS=0`（`apply_mutation` 退 4），
  #     而"没改到"与"判据不敏感"在输出上一模一样。
  #     ⚠️ `Q14`（提交字节是 `<br>`）与 `Q14c`（再点进来仍是两行）**也会红**：
  #     折在入口之后，提交出去的是空格、再进来也没有换行——那是同一处缺陷的三面，
  #     ⛔ 别当成三条独立证据（独立承重分别由 `M32` 与负对照承担）。
  #     ⚠️ 负对照 `Q11`/`Q12`/`Q13`（都在它之前跑）**必须仍绿**：这条变异只动"粘贴"这一件事。
  P23="$WORK/page-m23"; build_page "$P23" "$TARGET"
  echo "▶ M23：单元格入口把换行折成空格…" >&2
  apply_mutation "$P23/live/objects.js" \
    "    tab: /** @type {const} */ ('walk'),
    enter: /** @type {const} */ ('newline'),
    text: /** @type {TextRule} */ (identity)," \
    "    tab: /** @type {const} */ ('walk'),
    enter: /** @type {const} */ ('newline'),
    text: function (t) { return String(t).replace(/\\n/g, ' '); }, /* 变异：入口折换行 */"
  run_round "$P23" "$WORK/m23.json" "$WORK/m23.err"

  # ── `design/0049`（表格单元格）的第六处：**提交之后列区间不跟着内容走** ──
  #
  # M24：删掉 `live/index.js::commitCell` 里那行 `a.cell.to = a.cell.from + encoded.length`
  #     ⇒ `stillDirty` 拿**旧区间**比对 ⇒ 判"还脏" ⇒ 补一次提交时把刚写进去的字**又写一遍**。
  #     屏幕上一切正常（格子里的字本来就对），只有**字节层**看得见。
  #     ⇒ 判据 `Q15`（Tab 走格先提交，连提两次也不把字写重）必须红。
  #     ⚠️ 负对照 `Q5d`（**第一次**提交仍只改那一格）必须仍绿：
  #     旧区间只在"改过一次之后再改"时才错位，第一次本来就用的是对的区间。
  P24="$WORK/page-m24"; build_page "$P24" "$TARGET"
  echo "▶ M24：单元格提交之后列区间不跟内容走…" >&2
  apply_mutation "$P24/live/index.js" \
    "      a.cell.to = a.cell.from + encoded.length;" \
    "      /* 变异：区间不跟内容走 */"
  run_round "$P24" "$WORK/m24.json" "$WORK/m24.err"

  # ── `bugs/0029`（格子里打长句子，被右边缘整段切断）的第一处：**单元格不装软换行** ──
  #
  # M25：把 `main.js::makeLiveView` 的 `if (!code)` 打回 `if (!code && !isCell)`
  #     ⇒ 单元格视图不装 `EditorView.lineWrapping` ⇒ 比列宽的字**在右边缘被切掉**、
  #     光标跑到格子外面。用户原话「表格内的输入无法换行」就是它。
  #     ⇒ 判据 `Q20`（视觉行盒 ≥ 2 且光标落在格内）**必红**、`Q20b`（收回之后字节原样）必绿。
  #     ⚠️⚠️ **`Q21`/`Q22` 也会跟着红**，那是**同一处缺陷的另外两面**，⛔ 别当成两条独立证据：
  #        · `Q21` 拿"同一串字在阅读态排多高"当对照 ⇒ 编辑态不换行就只有一行高 ⇒ 红；
  #        · `Q22` 的 ↑/↓ 按**视觉行**走，只有一行时 `moveVertically` 返回 `null` ⇒ 一次都不动 ⇒ 红。
  #     ⇒ 负对照取**不读折行**的那几条：`Q19`（←/→ 连续移动）与 `Q1d`/`Q2b`（几何）必须仍绿。
  P25="$WORK/page-m25"; build_page "$P25" "$TARGET"
  echo "▶ M25：单元格不装软换行…" >&2
  apply_mutation "$P25/main.js" \
    "    if (!code) extensions.push(CM6.EditorView.lineWrapping);" \
    "    if (!code && !isCell) extensions.push(CM6.EditorView.lineWrapping); /* 变异：单元格不装软换行 */"
  run_round "$P25" "$WORK/m25.json" "$WORK/m25.err"

  # ── `bugs/0030`（↑/↓ 按逻辑行算 ⇒ 一按就跳到块首/块尾）的唯一一处 ──────────
  #
  # M26：把 `main.js::onKeyDown` 那段"上下走**视觉行**"（`view.moveVertically`）关掉
  #     ⇒ 落回 `LSel.move` 的 `lineUp`/`lineDown`，而它们按**逻辑行**算：块视图与单元格
  #     都只有 1 个逻辑行 ⇒ ↑ 跳 `0`、↓ 跳 `doc.length`。
  #     ⇒ 判据 `Q22` **必红**（它同时读偏移与几何：`↑` 之后要求 `0 < 头 < 原头 ∧ y 变小`）。
  #     ⚠️ 负对照 `Q19`（←/→）、`Q20`（软换行本身）、`Q21`（高度）**必须仍绿**——
  #     这条变异只动"上下"，⛔ 不许把它连带的左右移动与折行也打红。
  P26="$WORK/page-m26"; build_page "$P26" "$TARGET"
  echo "▶ M26：上下箭头退回按逻辑行…" >&2
  apply_mutation "$P26/main.js" \
    "      if ((cmd === 'lineUp' || cmd === 'lineDown') && typeof view.moveVertically === 'function') {" \
    "      if (false && typeof view.moveVertically === 'function') { /* 变异：上下退回按逻辑行 */"
  run_round "$P26" "$WORK/m26.json" "$WORK/m26.err"

  # ── `bugs/0031`（「文本选择功能极不顺畅」）的块内那一半，两处 ─────────────
  #
  # M27：把 `live/selection.js::installMouse` 里**双击分支**的 `dragging = true;` 摘掉
  #     ⇒ 双击选中一个词之后**继续拖**没有反应（旧形态：那个分支直接 `return`）。
  #     ⇒ 判据 `R1b`（拖着走：锚点不动、头往前）**必红**；
  #     ⚠️ 负对照 `R1`（双击本身选中了一个词）**必须仍绿**——这条变异只动"接着拖"，
  #        ⛔ 不许把双击选词那一半也打红，否则分不清判据在判哪件事。
  P27="$WORK/page-m27"; build_page "$P27" "$TARGET"
  echo "▶ M27：双击之后不进入拖拽态…" >&2
  apply_mutation "$P27/live/selection.js" \
    "        set({ anchor: a, head: b });
        dragging = true;" \
    "        set({ anchor: a, head: b });
        /* 变异：双击之后不进入拖拽态 */"
  run_round "$P27" "$WORK/m27.json" "$WORK/m27.err"

  # M28：把 `moveHandler` 末尾那行"起自动滚动循环"摘掉
  #     ⇒ 拖到窗口边缘光标不再前进（用户说的"极不顺畅"的另外一半）。
  #     ⇒ 判据 `R2`（下边缘 ⇒ 页面真的滚了）**必红**；
  #     ⚠️ 负对照 `R1`/`R1b` **必须仍绿**——选区照旧跟手，只有"滚"这一条没了。
  #     ⚠️⚠️ **不能跑主夹具**：`R2` 的前提是**页面可滚**，而 `blocks.md`（主夹具）一屏装得下
  #        ⇒ `R` 段记 `自动滚动:false`、`R2` 压根不产出 ⇒ 基线/变异后都是 `null`，判不出东西
  #        （2026-10-28 实测）。⇒ 这一轮明写 `bigblock`：全场唯一真能滚的那份。
  #        ⚠️ 连带 `变异判据` 要指 `基线键="bigblock/R2"`——基线表里那份夹具的判据带夹具前缀。
  P28="$WORK/page-m28"; build_page "$P28" bigblock
  echo "▶ M28：拖动不再自动滚动…" >&2
  apply_mutation "$P28/live/selection.js" \
    "      if (!scrollRaf) scrollRaf = requestAnimationFrame(步进);" \
    "      /* 变异：拖动不再自动滚动 */"
  run_round "$P28" "$WORK/m28.json" "$WORK/m28.err"

  # M29：`commitCell` 不接 `padFor`（把 `cellMod.padFor(cur, a.cell.to, encoded)` 打回 `encoded`）
  #     ⇒ 内容以反斜杠结尾时，那个 `\` 会把右侧分隔竖线转义掉、把右邻格并进来
  #     ⇒ 判据 `Q23`（格数与右邻格都不变）必红。
  #     ⚠️⚠️ **这条只有 Q23 看得见**：`live-cell.test.js` 的纯逻辑判据验的是 `padFor` 自己，
  #        "提交出去的那一行真是它拼的"要经过 `splice` + `session.commit` + `a.cell.to` 跟随。
  #     ⚠️ 负对照取 `Q5d`（第一次提交改的正是那一格）与 `Q15`（连提两次不写重）：
  #        两条都不以"内容末尾是反斜杠"为前提，必须仍绿；否则说明它们是按"提交有没有发生"在判，
  #        而不是按"提交的对不对"。
  P29="$WORK/page-m29"; build_page "$P29" "$TARGET"
  echo "▶ M29：单元格提交不做右侧补位…" >&2
  #     ⚠️⚠️ **2026-10-28 换靶**：`design/0054` 起 `padFor` 的产物先存进 `replacement`
  #     （校验请求要带它），靶子因此落在**赋值那一行**。
  apply_mutation "$P29/live/index.js" \
    "        replacement = cellMod.padFor(cur, a.cell.to, encoded);" \
    "        replacement = encoded; /* 变异：不做右侧补位 */"
  run_round "$P29" "$WORK/m29.json" "$WORK/m29.err"

  # M30：把单元格的 `enter` 策略从 `'newline'` 打回 `'walk'`（＝ `bugs/0035` 之前的产品形态）
  #     ⇒ 格内裸 `Enter` 走下一行同一列（`main.js::navigateCell('down')`），
  #       `⇧↵`/`⌥↵` 也一起走格（那条分支只挡 `⌘`）⇒ 格内**再也按不出新行**。
  #     ⇒ 判据 `Q8`（Enter 在格内换行、⛔ 不走到下一行）与 `Q24`（⇧↵/⌥↵ 同样换行）**都必须红**。
  #     ⚠️⚠️ **2026-10-28 换靶**（`bugs/0035` 用户需求变更）：旧靶子是"`⇧↵`/`⌥↵` 逃出格子分支、
  #     落到普通块的裸 `Enter`"——那在"格内不许换行"的年代是缺陷，现在**正是要的行为**。
  #     再拿它当靶子，判据红的是正确行为。
  #     ⚠️ 负对照取 `Q11`（格内 ⌘A＋⌫）与 `Q19`（格内 ←/→）：都不碰 Enter，必须仍绿
  #     ——否则说明这条变异把整格编辑都弄坏了，分不清是哪儿坏的。
  P30="$WORK/page-m30"; build_page "$P30" "$TARGET"
  echo "▶ M30：格内 Enter 打回「走下一行」…" >&2
  apply_mutation "$P30/live/objects.js" \
    "    tab: /** @type {const} */ ('walk'),
    enter: /** @type {const} */ ('newline')," \
    "    tab: /** @type {const} */ ('walk'),
    enter: /** @type {const} */ ('walk'), /* 变异：Enter 打回走格 */"
  run_round "$P30" "$WORK/m30.json" "$WORK/m30.err"

  # M31：`makeLiveView` 不给装饰层 `cellContext`
  #     ⇒ 格子的文本被当成**独立 Markdown 文档**解析，`# 普通格子` 套上 `cm-rmd-h1`
  #     ⇒ 判据 `Q25`（无标题类、字号 == 正文）必红。
  #     ⚠️ **2026-10-28 换靶**：`design/0054` 起接线的值来自对象策略（`obj.inlineOnly`），
  #     ⛔ 不再是接线处临时算的 `isCell`。摘掉整行的效果与旧靶子逐字等价。
  #     ⚠️ 负对照取 `N2`（标题块里回车长出来的新行 == 正文字号）与 `O-h1-5`（只剩 `##`）：
  #        它们走的是**块**上下文，`cellContext` 与它们无关 ⇒ 必须仍绿，
  #        否则说明这条变异把整条"行品种"都关了，分不清是哪儿坏的。
  P31="$WORK/page-m31"; build_page "$P31" "$TARGET"
  echo "▶ M31：单元格不做独立上下文的排版…" >&2
  apply_mutation "$P31/main.js" \
    "      cellContext: obj.inlineOnly," \
    "      /* 变异：格子不做独立上下文的排版 */"
  run_round "$P31" "$WORK/m31.json" "$WORK/m31.err"

  # M32：`live/index.js` 进格时**不做解码**（`text = cellMod.decode(raw)` 打回 `text = raw`）
  #     ⇒ 源码里的 `<br>` 原样落进视图：用户在自己的表格里看见**字面的 `<br>`**。
  #     提交出去仍是一个 `<br>`（`encode` 把它当普通字符照抄）⇒ **字节没变**、
  #     退出时连"脏"都不算 ⇒ 屏幕上看不出来的唯一一面就是"再进去时看到的是什么"。
  #     ⇒ 判据 `Q14c`（提交之后再点进这一格：视图仍是两行、⛔ 不是字面的 `<br>`）必须红。
  #     ⚠️ 负对照 `Q14`（提交出去是一个 `<br>`）与 `Q14b`（第一次粘贴时两行都在、几何对）
  #        必须仍绿——解码只影响"**读进视图**"，不影响"写出去"。那两条各自承重
  #        （`M23` 与 `Q14` 的字节面、`Q14b` 的几何面），⛔ 别把三条一起打红当成三条证据。
  P32="$WORK/page-m32"; build_page "$P32" "$TARGET"
  echo "▶ M32：进格不解码 <br>…" >&2
  apply_mutation "$P32/live/index.js" \
    "        text = cellMod.decode(raw);" \
    "        text = raw; /* 变异：不解码 <br> */"
  run_round "$P32" "$WORK/m32.json" "$WORK/m32.err"

  # M33：**组合串不跟光标那一行的排版走**（用户 2026-10-29 实测：
  #     「在标题下面一行输入的时候，拼音落地的字体虽然是正文，正常，但是拼音的字很大」）。
  #     摘掉 `main.js::paintPreedit` 里那一句 `syncPreeditMetrics(preeditEl)` ⇒
  #     覆盖层只剩"继承 host"，而 host 上搬来的是**块级**文字层（标题尺度）
  #     ⇒ 判据 `N3b`（正文行上的拼音 == 那一行的字号/字重）必红。
  #     ⚠️ 负对照 `N1b`（标题行上的拼音 == 标题尺度）必须**仍绿**：
  #        它证的是"覆盖层跟着**行**走"、⛔ 不是"被钉成了正文字号"。
  #     ⚠️ 也⛔ 连带 `N2`/`N3`（行本身的尺度）一起打红——那两条与本变异无关，
  #        它们红说明变异改错了地方，不是判据不敏感。
  P33="$WORK/page-m33"; build_page "$P33" "$TARGET"
  echo "▶ M33：组合串不跟那一行的排版走…" >&2
  apply_mutation "$P33/main.js" \
    "      syncPreeditMetrics(preeditEl);" \
    "      /* 变异：覆盖层只继承 host（块级文字层），不跟光标那一行 */"
  run_round "$P33" "$WORK/m33.json" "$WORK/m33.err"
fi

# ── ⑥ 判据汇总：**退出码就是结论** ──
python3 -I - "$WORK" "$MUTATE" "$TO_JSON" "$SAVE" "$OUT" "$MODEL" "$TODAY" <<'PY'
import glob
import json
import os
import platform
import sys

work, mutate, to_json, save, out, model, today = sys.argv[1:8]

def 读(path, 标签):
    try:
        doc = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        print("⛔ 读不出%s结果：%s" % (标签, e), file=sys.stderr)
        sys.exit(3)
    return doc

基线原始 = 读(os.path.join(work, "base.json"), "基线")
if "致命" in 基线原始:
    print("⛔ harness 致命错误：%s" % 基线原始["致命"], file=sys.stderr)
    print("   环境：%s" % json.dumps(基线原始.get("环境"), ensure_ascii=False), file=sys.stderr)
    sys.exit(3)

def 键(c):
    """判据 id 的**前导词**（`B0-4 块自身 top 不动` → `B0-4`）。
    ⚠️ 全串带中文描述（好读），但查表与"缺了哪条"只能按前导词。"""
    return str(c.get("id", "")).split(" ")[0]

结果名 = {"skip": "跳过", True: "通过", False: "失败"}

def 收集(原始, 前缀=""):
    出 = []
    for c in (原始.get("判据") or []):
        出.append({"id": 前缀 + str(c.get("id")), "_键": 前缀 + 键(c),
                   "结果": 结果名.get(c.get("ok"), "失败"),
                   "判据": "见 tools/live-probe/block-harness.js 里同名前缀的那一条",
                   "值": {"说明": c.get("msg") or ""}})
    return 出

检查 = 收集(基线原始)
环境 = {"主夹具名": 基线原始.get("文档"), "主夹具": 基线原始.get("环境"),
        "其余夹具": []}
# G 段（长代码行）只在**真有超宽 `<pre>`** 的夹具上成立 ⇒ 逐份收 摘要.G 供 `G-覆盖` 核对
G表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "G": (基线原始.get("摘要") or {}).get("G")}]
# L 段（§7.1 步骤 0f：键入代价 vs 块大小）同理：只在**有 ≥200 行可编辑块**的夹具上成立
L表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "L": (基线原始.get("摘要") or {}).get("L")}]
# N 段（`bugs/0015` 行级排版）同理：只在**有标题块**的夹具上成立
N表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "N": (基线原始.get("摘要") or {}).get("N")}]
# O 段（2026-10-27「操作 × 不变量」e2e 探测器）同理：每一类块跑 8 条，块类**逐份不同**
O表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "O": (基线原始.get("摘要") or {}).get("O")}]
# P 段（`bugs/0018` 退出通道 ＋ 提交后重渲那一面）同理：只在**有可编辑块**的夹具上成立
P表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "P": (基线原始.get("摘要") or {}).get("P")}]
# Q 段（`design/0049` 表格单元格）同理：只在**有 Table 块**的夹具上成立
Q表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "Q": (基线原始.get("摘要") or {}).get("Q")}]
# V 段（`design/0051` 任务项就地打勾）同理：只在**载荷里有 task_items** 的夹具上成立
V表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "V": (基线原始.get("摘要") or {}).get("V")}]
# W 段（`design/0052` U7 `⌘↵` 新起一段）同理：只在**可编辑、且后面还有正文**的夹具上成立
W表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "W": (基线原始.get("摘要") or {}).get("W")}]
# R 段（`bugs/0031` 鼠标拖选）同理：只在**有 ≥ 4 字符可编辑块**的夹具上成立
R表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "R": (基线原始.get("摘要") or {}).get("R")}]
for path in sorted(glob.glob(os.path.join(work, "other", "*.json"))):
    name = os.path.splitext(os.path.basename(path))[0]
    try:
        原始 = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        检查.append({"id": "%s/A0" % name, "名": "夹具 %s 起不来" % name, "结果": "失败",
                     "判据": "每份夹具都必须跑起来", "值": {"原因": str(e)}})
        continue
    if "致命" in 原始:
        检查.append({"id": "%s/A0" % name, "名": "夹具 %s 起不来" % name, "结果": "失败",
                     "判据": "每份夹具都必须跑起来", "值": {"致命": 原始.get("致命")}})
        continue
    检查.extend(收集(原始, name + "/"))
    环境["其余夹具"].append({"名": name, "环境": 原始.get("环境")})
    G表.append({"夹具": name, "G": (原始.get("摘要") or {}).get("G")})
    L表.append({"夹具": name, "L": (原始.get("摘要") or {}).get("L")})
    N表.append({"夹具": name, "N": (原始.get("摘要") or {}).get("N")})
    O表.append({"夹具": name, "O": (原始.get("摘要") or {}).get("O")})
    P表.append({"夹具": name, "P": (原始.get("摘要") or {}).get("P")})
    Q表.append({"夹具": name, "Q": (原始.get("摘要") or {}).get("Q")})
    V表.append({"夹具": name, "V": (原始.get("摘要") or {}).get("V")})
    W表.append({"夹具": name, "W": (原始.get("摘要") or {}).get("W")})
    R表.append({"夹具": name, "R": (原始.get("摘要") or {}).get("R")})

# ⚠️ 判据**必须逐条产出**：少一条 = 那条判据根本没跑（⛔ 别把"没产出"读成"通过"）。
有 = set(c["_键"] for c in 检查)
for cid in ["A0", "A1", "A2", "A3", "A4", "E1"]:
    if cid not in 有:
        检查.append({"id": cid, "名": "（探针没有产出这一条判据）", "结果": "失败",
                     "判据": "启动/重渲这几条必须逐条产出", "值": {"缺": cid}})

# ⚠️ 逐块覆盖：每个块要么有 `B{i}-*`（可编辑），要么有 `C{i}`（结构块）。
#    ⛔ "少跑了几块"与"全绿"输出一模一样——所以按块号核对。
def 块号集合(cs):
    s = set()
    for c in cs:
        k = c.get("_键", "")
        for pre in ("B", "C"):
            if k.startswith(pre):
                num = ""
                for ch in k[len(pre):]:
                    if ch.isdigit():
                        num += ch
                    else:
                        break
                if num:
                    s.add(int(num))
    return s

块数 = (基线原始.get("摘要") or {}).get("块数")
已覆盖 = 块号集合(检查)
if isinstance(块数, int) and 块数 > 0:
    缺 = sorted(set(range(块数)) - 已覆盖)
    检查.append({
        "id": "B-覆盖", "名": "每一个块都跑过一轮",
        "结果": "失败" if 缺 else "通过",
        "判据": "块号 0..块数-1 必须逐个出现在判据里（可编辑块 B{i}-* / 结构块 C{i}）",
        "值": {"块数": 块数, "缺": 缺},
    })
else:
    检查.append({"id": "B-覆盖", "名": "每一个块都跑过一轮", "结果": "失败",
                 "判据": "基线必须报出块数", "值": {"块数": 块数}})

# ⚠️ F6 那一段**每份夹具都跑**（都挑自己第一个可编辑段落块）⇒ D 段判据要逐份都在。
#    ⚠️ `D12`–`D16` 是 **2026-10-27 补的删除五连**（`bugs/0014`）：这一段此前**一条删除判据都没有**，
#    缺陷就是从那个缺口漏给用户的 ⇒ ⛔ 别再把它漏出覆盖表（覆盖表少一条＝"没产出也算通过"）。
F6 = (基线原始.get("摘要") or {}).get("F6")
need = ["D%d" % i for i in range(12)] + ["D12", "D13", "D14", "D15", "D16"] + ["D1b", "D4b"]
缺D = [x for x in need if x not in 有]
检查.append({
    "id": "D-覆盖", "名": "F6 整套判据都在（含删除五连）",
    "结果": "失败" if (缺D or F6 is None) else "通过",
    "判据": "D0–D11 ＋ D1b/D4b ＋ ⭐ D12–D16（敲字／⌫／⌦／⌘A＋⌫／⌘Z）必须逐条产出（跑在一段可编辑段落上）",
    "值": {"缺": 缺D, "摘要F6": F6},
})

# ⚠️ G 段（§7.1 步骤 0d，长代码行）**只在真有超宽 `<pre>` 的夹具上才产判据**：
#   夹具里没有超宽行时 harness 既不记通过也不记跳过（记跳过会让整轮退出码恒为 2）。
#   ⇒ "本轮到底验没验 0d"由这里统一核：至少一份夹具的 `摘要.G.适用 === true`。
真的跑了G = [row["夹具"] for row in G表 if (row["G"] or {}).get("适用") is True]
检查.append({
    "id": "G-覆盖", "名": "本轮至少有一份夹具真的跑了长代码行（0d）",
    "结果": "通过" if 真的跑了G else "失败",
    "判据": "至少一份夹具的 `摘要.G.适用 === true`——"
            "`tools/live-probe/fixtures/longcode.md` 应当在夹具列表里；"
            "⛔ 不许把「这份夹具没有超宽代码行」记成通过或跳过",
    "值": {"跑了G的夹具": 真的跑了G,
           "逐份": [{"夹具": row["夹具"], "G": row["G"]} for row in G表]},
})

# ⚠️ L 段（§7.1 步骤 0f，键入代价 vs 块大小）同样只在**有 ≥200 行可编辑块**时成立。
#   ⇒ 两条都必须真的成立，⛔ 缺一条就等于"0f 没验"：
#     ① 至少一份夹具 `摘要.L.适用 === true`；
#     ② 其中至少一个样本 **≥ 2000 行**——那是 `LIVE_LIMITS.maxBlockLines` 上的那一档，
#        少了它，"200 行没事" 推不出 "2000 行也没事"。
真的跑了L = [row["夹具"] for row in L表 if (row["L"] or {}).get("适用") is True]
L最大行 = 0
for row in L表:
    for s in ((row["L"] or {}).get("样本") or []):
        try:
            L最大行 = max(L最大行, int(s.get("行") or 0))
        except Exception:
            pass
检查.append({
    "id": "L-覆盖", "名": "本轮真的量了 0f（且量到了上限那一档）",
    "结果": "通过" if (真的跑了L and L最大行 >= 2000) else "失败",
    "判据": "至少一份夹具的 `摘要.L.适用 === true` 且样本里有 ≥ 2000 行的块——"
            "`tools/live-probe/fixtures/bigblock.md` 的第三块恰好压在上限上；"
            "⛔ 不许把「这份夹具没有大块」记成通过或跳过",
    "值": {"跑了L的夹具": 真的跑了L, "最大行": L最大行,
           "逐份": [{"夹具": row["夹具"], "L": row["L"]} for row in L表]},
})

# ⚠️ N 段（`bugs/0015`，行级排版跟着源码走）只在**有标题块**的夹具上产判据。
#   ⇒ "本轮到底验没验"由这里统一核：至少一份夹具的 `摘要.N.适用 === true`。
#   ⚠️ 这条覆盖表的意义与 D-覆盖 一致：判据**少一条**就等于"没产出也算通过"，
#     而这一族的缺陷是**纯视觉**的（`markers()` 的纯逻辑判据全绿也照样漏）。
真的跑了N = [row["夹具"] for row in N表 if (row["N"] or {}).get("适用") is True]
# ⚠️ 与 `D-覆盖` 同一条口径：**判据少一条就等于"没产出也算通过"**。
#    这一族的缺陷是纯视觉的（`markers()` 的纯逻辑判据全绿也照样漏），⛔ 别只看"有没有跑"。
#    ⚠️ 前缀要逐份算：主夹具的判据在 `收集(基线原始)` 里**不带前缀**，其余带 `<夹具名>/`。
需要N = ["N0", "N0b", "N0c", "N1", "N1b", "N2", "N3", "N3b", "N4", "N5", "N6a", "N6b"]
主夹具名 = str(基线原始.get("文档") or "")
缺N = []
for row in N表:
    if (row["N"] or {}).get("适用") is not True:
        continue
    前缀 = "" if row["夹具"] == 主夹具名 else row["夹具"] + "/"
    缺N.extend([前缀 + x for x in 需要N if (前缀 + x) not in 有])
检查.append({
    "id": "N-覆盖", "名": "本轮至少有一份夹具真的验了行级排版（bugs/0015）",
    "结果": "通过" if (真的跑了N and not 缺N) else "失败",
    "判据": "至少一份夹具的 `摘要.N.适用 === true`，且 N0 / N0b / N0c / N1–N5 / N6a·N6b 逐条都在——"
            "`tools/live-probe/fixtures/blocks.md` 的每一份夹具都带标题块；"
            "⛔ 不许把「这份夹具没有标题块」记成通过或跳过",
    "值": {"跑了N的夹具": 真的跑了N, "缺": 缺N,
           "逐份": [{"夹具": row["夹具"], "N": row["N"]} for row in N表]},
})

# ⚠️ O 段（2026-10-27，「操作 × 不变量」）逐**类块**产 8 条判据（`-0`…`-7`）。
#   ⛔ 别把块类型写死在这里：夹具换了、某类块没了，覆盖表要跟着走，
#   否则它退化成一句恒真的废话（那正是"判据少一条 = 没产出也算通过"的反面陷阱）。
#   ⇒ 标签从 `摘要.O.明细[].标签` 现取，逐份核对它自己真的跑过的那几类。
真的跑了O = [row["夹具"] for row in O表 if (row["O"] or {}).get("适用") is True]
# ⚠️ `5b` 不是笔误：`-5`（删到只剩 `##`）与 `-5b`（再删干净回正文）是**两个不同的品种档**
#    （空 ATX 标题 vs 正文，`bugs/0016` 就藏在两者之间），⛔ 别合并成一条。
需要O = ["0", "1", "2", "3", "4", "5", "5b", "5c", "6", "7"]
缺O = []
O类数 = 0
for row in O表:
    o = row["O"] or {}
    if o.get("适用") is not True:
        continue
    前缀 = "" if row["夹具"] == 主夹具名 else row["夹具"] + "/"
    标签s = [str(x.get("标签") or "") for x in (o.get("明细") or [])]
    O类数 += len(标签s)
    if not 标签s:
        缺O.append(前缀 + "(摘要里一类块都没有)")
    for t in 标签s:
        缺O.extend([前缀 + "O-" + t + "-" + k
                    for k in 需要O if (前缀 + "O-" + t + "-" + k) not in 有])
检查.append({
    "id": "O-覆盖", "名": "本轮每一类块都跑完了 10 条动作判据（进／回车／敲标题／删到井号／删干净／粘贴／撤销／退出）",
    "结果": "通过" if (真的跑了O and not 缺O) else "失败",
    "判据": "至少一份夹具的 `摘要.O.适用 === true`，且它列出的**每一类块**都有 `O-<标签>-0…-7` 共 10 条"
            "（`-5` 与 `-5b` 是两个品种档，缺一不可）；"
            "⛔ 不许把「这份夹具没有可编辑块」记成通过或跳过",
    "值": {"跑了O的夹具": 真的跑了O, "块类总数": O类数, "缺": 缺O,
           "逐份": [{"夹具": row["夹具"], "O": row["O"]} for row in O表]},
})

# ⚠️ P 段（`bugs/0018`，**退出通道**）——2026-10-27 用户实测「一旦进入标签模式，就出不来」。
#   B 段几百条判据一条都没红，因为它**只有一种退出方式**（`键(ta,'Escape')`）且**直接往 ta 派发**
#   （判不了焦点在不在 ta 上）。P 段补的是"焦点前提 ＋ 其余四条退出路 ＋ 提交重渲那一面"。
#   ⛔ 同 G/L 的口径：夹具没有可编辑块时 harness **既不记通过也不记跳过**，
#   "本轮到底验没验"由这里统一核。
真的跑了P = [row["夹具"] for row in P表 if (row["P"] or {}).get("适用") is True]
需要P = ["P1", "P2", "P3", "P4"]          # 有可编辑块就必须都在
需要P切换 = ["P5", "P6", "P7"]            # 还要求 ≥2 个可编辑块（够点"另一块"）
缺P = []
P切换过的 = []
for row in P表:
    p = row["P"] or {}
    if p.get("适用") is not True:
        continue
    前缀 = "" if row["夹具"] == 主夹具名 else row["夹具"] + "/"
    for k in 需要P:
        if (前缀 + k) not in 有:
            缺P.append(前缀 + k)
    多块 = isinstance(p.get("可编辑块"), int) and p["可编辑块"] >= 2
    if 多块:
        P切换过的.append(row["夹具"])
        for k in 需要P切换:
            if (前缀 + k) not in 有:
                缺P.append(前缀 + k)
检查.append({
    "id": "P-覆盖", "名": "本轮每一份有可编辑块的夹具都跑完了退出通道（含提交后重渲那一面）",
    "结果": "通过" if (真的跑了P and P切换过的 and not 缺P) else "失败",
    "判据": "至少一份夹具的 `摘要.P.适用 === true`，且每份适用的夹具都有 `P1`–`P4`"
            "（⌘↵／点空白／焦点离开后 Esc）；"
            "⭐ 另需**至少一份** `摘要.P.可编辑块 >= 2`，它还要有 `P5`–`P7`"
            "（提交后点另一块进得去／重渲之后没有多余节点／进去的是被点那一块）——"
            "⛔ 缺一条就等于「提交重渲那一面没验」，而 `bugs/0018` 正藏在那里",
    "值": {"跑了P的夹具": 真的跑了P, "跑过切换的夹具": P切换过的, "缺": 缺P,
           "逐份": [{"夹具": row["夹具"], "P": row["P"]} for row in P表]},
})

# ⚠️ Q 段（`design/0049` 表格单元格）只在**有 Table 块**的夹具上产判据。
#   ⇒ 与 `G-覆盖` 同一条口径：至少一份夹具 `摘要.Q.适用 === true`；而**产出了就要逐条在**，
#     否则"某条判据压根没跑"会被读成通过。
真的跑了Q = [row["夹具"] for row in Q表 if (row["Q"] or {}).get("适用") is True]
#   ⚠️ 2026-10-28：这张表原先停在 `Q10b`／`Q18`，后面补的 **Q19–Q25 一条都没进**——
#      "产出了就要逐条在"对它自己就成了空话：某一条哪天不再产出，这里不会红。
#      （发现方式：Q 段实跑 78 条 = 39 × 两份夹具，而 `需要Q` 只列了 31 条。）
需要Q = ["Q0", "Q1", "Q1b", "Q1c", "Q1d", "Q2", "Q2b", "Q2c", "Q2d", "Q3", "Q4", "Q4b",
         "Q5", "Q5b", "Q5c", "Q5d", "Q6", "Q7", "Q8", "Q9",
         "Q11", "Q12", "Q13", "Q14", "Q14b", "Q14c", "Q15", "Q16", "Q17", "Q18",
         "Q10", "Q10b",
         "Q19", "Q20", "Q20b", "Q21", "Q22",      # 软换行 / 上下走格（M25、M26）
         "Q23", "Q24", "Q25"]                     # bugs/0032 / 0033 / 0034（M29、M30、M31）
缺Q = []
for row in Q表:
    if (row["Q"] or {}).get("适用") is not True:
        continue
    前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
    缺Q.extend([前缀 + x for x in 需要Q if (前缀 + x) not in 有])
检查.append({
    "id": "Q-覆盖", "名": "本轮至少有一份夹具真的验了表格单元格（design/0049）",
    "结果": "通过" if (真的跑了Q and not 缺Q) else "失败",
    "判据": "至少一份夹具的 `摘要.Q.适用 === true`，且 Q0–Q25（含各字母档）逐条都在——"
            "`tools/live-probe/fixtures/blocks.md` 里有一张 3×3 的表格；"
            "⭐ Q1b/Q1c 判**那一格换进文档流之后还看得见**（`cm-rmd-offscreen` 必须被摘掉，"
            "2026-10-28 用户实测的「数据会消失」就是它）；"
            "⭐ Q14/Q14b/Q14c 是 `bugs/0035`（格内换行）：提交成一个 `<br>`／"
            "粘贴时视图里两行都在且高度 == 阅读态／再点进来仍是两行（不是字面 `<br>`）；"
            "⭐ Q23/Q24/Q25 是 `bugs/0032`/`0034` 与 `bugs/0035` 的边界（末尾反斜杠不吃分隔竖线／"
            "格内 ⇧↵·⌥↵ 同样换行／格内 `# x` 不是标题）；"
            "⛔ 不许把「这份夹具没有表格」记成通过或跳过",
    "值": {"跑了Q的夹具": 真的跑了Q, "缺": 缺Q,
           "逐份": [{"夹具": row["夹具"], "Q": row["Q"]} for row in Q表]},
})

# ⚠️ V 段（`design/0051` 任务项就地打勾）只在**载荷里真有 `task_items`** 的夹具上产判据。
#   ⇒ 与 `G-覆盖` / `Q-覆盖` 同一条口径：至少一份夹具 `摘要.V.适用 === true`；
#     而**产出了就要逐条在**，否则"某条判据压根没跑"会被读成通过。
真的跑了V = [row["夹具"] for row in V表 if (row["V"] or {}).get("适用") is True]
需要V = ["V0", "V0b", "V0c", "V1", "V1b", "V2", "V2b", "V2c",
         "V3", "V3b", "V4", "V4b", "V5", "V5b"]
缺V = []
for row in V表:
    if (row["V"] or {}).get("适用") is not True:
        continue
    前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
    缺V.extend([前缀 + x for x in 需要V if (前缀 + x) not in 有])
检查.append({
    "id": "V-覆盖", "名": "本轮至少有一份夹具真的验了任务项就地打勾（design/0051）",
    "结果": "通过" if (真的跑了V and not 缺V) else "失败",
    "判据": "至少一份夹具的 `摘要.V.适用 === true`，且 V0–V5b 逐条都在"
            "（含 V0b/V0c/V1b/V2b/V2c/V3b/V4b/V5b）——"
            "`tools/live-probe/fixtures/tasks.md` 里既有真任务项，也有 `- []` 这种**看着像**的行；"
            "⛔ 不许把「这份夹具没有任务项」记成通过或跳过",
    "值": {"跑了V的夹具": 真的跑了V, "缺": 缺V,
           "逐份": [{"夹具": row["夹具"], "V": row["V"]} for row in V表]},
})

# ⚠️ W 段（`design/0052` U7 `⌘↵` 新起一段）只在**可编辑、且后面还有正文**的夹具上产判据
#   （用户点名的"后面已有正文时的插入位置"就是这个前提）。
#   ⇒ 与 `G-覆盖` / `P-覆盖` 同一条口径：至少一份夹具 `摘要.W.适用 === true`；
#     而**产出了就要逐条在**，否则"某条判据压根没跑"会被读成通过。
真的跑了W = [row["夹具"] for row in W表 if (row["W"] or {}).get("适用") is True]
需要W = ["W1", "W1b", "W1c", "W2", "W2b", "W2c", "W3", "W3b", "W4", "W5", "W6"]
缺W = []
for row in W表:
    if (row["W"] or {}).get("适用") is not True:
        continue
    前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
    缺W.extend([前缀 + x for x in 需要W if (前缀 + x) not in 有])
检查.append({
    "id": "W-覆盖", "名": "本轮至少有一份夹具真的验了 `⌘↵` 新起一段（design/0052 U7）",
    "结果": "通过" if (真的跑了W and not 缺W) else "失败",
    "判据": "至少一份夹具的 `摘要.W.适用 === true`，且 W1–W6 逐条都在——"
            "W1 `⌘↵` 之后**仍在编辑态**、光标在新段落段首、焦点在离屏 textarea／"
            "W1b 三行空行插在**这一块之后**（提交进会话的正文逐行比）／"
            "W1c 新宿主在 DOM 里紧跟刚离开那一块／"
            "⭐ W2 一次 `⌘Z` 把正文恢复到操作前／⭐ W2b 同时把**光标**放回操作前那一处／"
            "W2c 撤销之后宿主回到原来那一块／W3 中文组合期一个字节都不动／"
            "W3b 中文上屏后逐字落进新段落（光标在 2）／W4 敲字之后要 `⌘Z` 两次（⛔ 一次不跨层）／"
            "W5 裸 `Enter` 仍留在这个块里（只多一个换行）／W6 收尾整篇逐行回到原样——"
            "⛔ 不许把「这份夹具没有可编辑块 / 块后面没有正文」记成通过或跳过",
    "值": {"跑了W的夹具": 真的跑了W, "缺": 缺W,
           "逐份": [{"夹具": row["夹具"], "W": row["W"]} for row in W表]},
})

# ⚠️ R 段（`bugs/0031` 鼠标拖选）只在**有 ≥ 4 字符可编辑块**的夹具上产判据。
#   ⇒ 与 `G-覆盖` / `Q-覆盖` 同一条口径：至少一份夹具 `摘要.R.适用 === true`；
#     而**产出了就要逐条在**，否则"某条判据压根没跑"会被读成通过。
#   ⚠️ `R2`/`R2b`（自动滚动）还多一个前提：这一份夹具的页面**真能滚**
#     （`摘要.R.自动滚动 === true`）；页面本来就滚不动的夹具⛔ 不许记通过也⛔ 不许记跳过，
#     但要保证**整轮至少有一份**真的滚了——否则这条判据没有任何一份夹具在承重。
真的跑了R = [row["夹具"] for row in R表 if (row["R"] or {}).get("适用") is True]
真的滚了R = [row["夹具"] for row in R表 if (row["R"] or {}).get("自动滚动") is True]
需要R = ["R0", "R1", "R1b"]
缺R = []
for row in R表:
    if (row["R"] or {}).get("适用") is not True:
        continue
    前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
    缺R.extend([前缀 + x for x in 需要R if (前缀 + x) not in 有])
    if (row["R"] or {}).get("自动滚动") is True:
        缺R.extend([前缀 + x for x in ("R2", "R2b") if (前缀 + x) not in 有])
检查.append({
    "id": "R-覆盖", "名": "本轮至少有一份夹具真的验了鼠标拖选，且至少一份真的滚了（bugs/0031）",
    "结果": "通过" if (真的跑了R and 真的滚了R and not 缺R) else "失败",
    "判据": "至少一份夹具的 `摘要.R.适用 === true`，且 R0/R1/R1b 逐条都在；"
            "页面能滚的夹具还必须有 R2/R2b；且**整轮至少一份** `摘要.R.自动滚动 === true`——"
            "否则「拖到边缘自动滚动」这条判据一条夹具都没承重。"
            "⛔ 不许把「这份夹具没有可拖的块 / 页面滚不动」记成通过或跳过",
    "值": {"跑了R的夹具": 真的跑了R, "真的滚了的夹具": 真的滚了R, "缺": 缺R,
           "逐份": [{"夹具": row["夹具"], "R": row["R"]} for row in R表]},
})

基线表 = {c.get("_键", c["id"]): c["结果"] for c in 检查}
def 变异表(path):
    try:
        doc = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        return None, "读不出：%s" % e
    if "致命" in doc:
        return None, "致命：" + str(doc["致命"])
    return {键(c): 结果名.get(c.get("ok"), "失败") for c in (doc.get("判据") or [])}, None

def 变异判据(cid, 文件名, target, 说明, 保持绿=(), 基线键=None):
    """一条变异算通过 = 基线里 target 通过 ∧ 变异后 target 失败（⚠️ 只认**那一格**）。

    `target` 可以是**一组**（同一次变异必须打红每一条）；`保持绿` 是**负对照**——
    那几条在变异后**必须仍是"通过"**，否则说明它判的是"位置"不是"品种"。
    """
    targets = [target] if isinstance(target, str) else list(target)
    if mutate != "1":
        return {"id": cid, "名": "（没跑变异：--no-mutate）", "结果": "跳过",
                "判据": 说明 + "；本次用 --no-mutate 跳过", "值": {}}
    table, why = 变异表(os.path.join(work, 文件名))
    if table is None:
        return {"id": cid, "名": "变异轮没跑起来", "结果": "失败", "判据": 说明,
                "值": {"原因": why}}
    红 = {t: {"基线": 基线表.get((基线键.get(t, t) if isinstance(基线键, dict)
                                   else (基线键 or t)), t), "变异后": table.get(t)}
          for t in targets}
    ok = all(v["基线"] == "通过" and v["变异后"] == "失败" for v in 红.values())
    绿 = {t: table.get(t) for t in 保持绿}
    ok = ok and all(v == "通过" for v in 绿.values())
    return {"id": cid, "名": 说明, "结果": "通过" if ok else "失败",
            "判据": "基线里判据 %s 通过 ∧ 变异后失败%s（其余判据不参与本判据）"
                    % ("/".join(targets),
                       ("；负对照 %s 变异后必须仍通过" % "/".join(保持绿)) if 保持绿 else ""),
            "值": {"红": 红, "保持绿": 绿,
                   **({"基线取自": 基线键} if 基线键 else {}),
                   "⚠️ 口径": "变异打在**页面副本**上（⛔ 仓库文件一字未动）；"
                              "施加前校验模式命中恰好 1 次，并用 cksum 证明文件真变了"}}

检查.append(变异判据("M1", "m1.json", "B0-5",
                    "变异：只搬文字层、不搬外边距（＝盒子没搬）⇒ 判据 B0-5（块外零位移）必须红"))
检查.append(变异判据("M2", "m2.json", "D1b",
                    "变异：组合中间态也落事务 ⇒ 判据 D1b（组合期块内文本不变）必须红"))
检查.append(变异判据("M3", "m3.json", "E1",
                    "变异：未改动也提交（两处短路**都**摘掉）⇒ 判据 E1（render_preview = 0）必须红"))
# ⚠️ M4 与 M5 是**同一次变异**的两个面（同一份 `m4.json`）：⛔ 别当成两处变异。
检查.append(变异判据("M4", "m4.json", "H4",
                    "变异：保存取的是**提交前**的全文（把 `text` 取成基线）⇒ 判据 H4（写下去 = 基线 ＋ 刚敲的字）必须红"))
检查.append(变异判据("M5", "m4.json", "H5",
                    "同一次变异的第二个面：写盘与合回不是同一份字节 ⇒ 判据 H5 必须红"))
# ⚠️ M6 与 M7 也是**同一次变异**的两个面（同一份 `m6.json`）：⭐ 打回的是 2026-10-27 的真缺陷。
检查.append(变异判据("M6", "m6.json", "D13",
                    "变异：删除读 `range()` 里不存在的 `head`（2026-10-27 的真缺陷）⇒ 判据 D13（⌫ 删回原样）必须红"))
检查.append(变异判据("M7", "m6.json", "D14",
                    "同一次变异的第二个面：⌦ 前向删除同样空转 ⇒ 判据 D14 必须红"))
# ⚠️ M8 打回的是 `bugs/0015`：删掉 `main.js` 里 `bodyLines:` 那一行。
检查.append(变异判据("M8", "m8.json", "N2",
                    "变异：不再把 `bodyLines` 交给装饰层（bugs/0015 原样打回）⇒ 判据 N2（回车出来的新行 == 正文字号）必须红"))
# ⚠️ M9 是**同一次变异**（同一份 `m8.json`）的第三个面：O 段用的是**与产品实现无关**的 oracle，
#    ⇒ 少了 `bodyLines` 时标题块里回车长出的新行会继承 24.5px，`O-h1-3` 必须红。
检查.append(变异判据("M9", "m8.json", "O-h1-3",
                    "同一次变异的第三个面：标题块里回车的**逐行**对照（oracle 口径）⇒ 判据 O-h1-3 必须红"))
# ⚠️ M10 打回的是 `bugs/0016`：只剩 `##` 的行不再按空 ATX 标题排（见施加处注释）。
#    ⚠️ 期望**红两条**：`O-h1-5`（标题块删到只剩井号）、`O-ul-5`（列表块同理）；
#    而 `O-p-5`（折行块上那一行是 `##类…`，本来就不是标题）、`O-pre-5`（围栏里是代码）
#    **必须仍绿**——否则说明这一条判的是"位置"不是"品种"。`-5b`（删干净）由 O-覆盖 逐类核。
检查.append(变异判据("M10", "m10.json", ["O-h1-5", "O-ul-5"],
                    "变异：只剩井号的行不当标题（bugs/0016 原样打回）⇒ 判据 O-h1-5／O-ul-5 必须红，O-p-5／O-pre-5 必须仍绿",
                    保持绿=["O-p-5", "O-pre-5"]))
# ⚠️ M11：`paste` 的监听器不接 ⇒ 粘贴静默失效（剪贴板进了离屏 textarea、不进文档）。
检查.append(变异判据("M11", "m11.json", "O-h1-5c",
                    "变异：删掉 `input.addEventListener('paste', onPaste)` ⇒ 判据 O-h1-5c（粘贴两行）必须红"))
# ⚠️ M12–M14 是 `bugs/0018` 的三处（2026-10-27「一旦进入标签模式，就出不来」）：
#    ⛔ 三条都**只有 P 段看得见**——B 段的退出方式只有一种，且事件**恒派发到 `ta`**。
检查.append(变异判据("M12", "m12.json", "P6",
                    "变异：`swapLiveView` 换进去之后不摘旧节点（同一段文字留在原地）⇒ 判据 P6（重渲后没有多余节点）必须红。⚠️ 2026-10-28 二度换靶：上一版「摘宿主挪到 mount 之后」实跑**没红**，是改法等价（`d.mount` 收尾的 `noteLive → reseat` 已把 `a.swap` 换成新树上的一个），细节在脚本里 M12 那段注释"))
检查.append(变异判据("M13", "m13.json", "P7",
                    "变异：`begin()` 不重取新表 / 新树（用调用方的过期节点）⇒ 判据 P7（进去的是被点那一块）必须红"))
检查.append(变异判据("M14", "m14.json", "P4",
                    "变异：去掉 `document` 级键盘兜底 ⇒ 判据 P4（焦点离开输入框后 Esc 仍能退出）必须红"))
# ⚠️ M15/M16 是 `design/0049`（表格单元格）的两处：⛔ 二者都**只有 Q 段看得见**——
#    `live-cell.test.js` 判的是 `cell.js` 那两个纯函数，产品**不调**它们时它照样全绿。
检查.append(变异判据("M15", "m15.json", "Q5d",
                    "变异：单元格写回整行重拼（丢掉两侧填充）⇒ 判据 Q5d（改的正是那一格）必须红"))
检查.append(变异判据("M16", "m16.json", "Q5c",
                    "变异：单元格提交退回整篇提交 ⇒ 判据 Q5c（提交只动了那一行）必须红"))
# ⚠️ M17–M19 是 `design/0051`（任务项就地打勾）的三处：⛔ 三者都**只有 V 段看得见**——
#    `live-task.test.js` 判的是 `task.js` 的纯函数与配对逻辑，产品**不接**那条路时它照样全绿。
检查.append(变异判据("M17", "m17.json", "V1",
                    "变异：`live/task.js::arm()` 只摘 `disabled`、不接 click ⇒ 判据 V1（点方框发出一次提交）必须红"))
检查.append(变异判据("M18", "m18.json", "V4",
                    "变异：`toggleLine` 恒变勾上（取消不了）⇒ 判据 V4（再点一次逐字节回到原样）必须红"))
检查.append(变异判据("M19", "m19.json", "V3b",
                    "变异：`isCheckedSymbol` 传 `nextLine`（连翻两下，状态条说反；2026-10-27 的真缺陷）"
                    "⇒ 判据 V3b（状态条说的是「已勾选」）必须红"))
# ⚠️ M20 是 `design/0052` U7（`⌘↵` 新起一段）的那一处：一次撤销**不恢复光标**。
#    负对照 `W2`（正文恢复）与 `W5`（裸 Enter）——`W5` 的期望值取自**此刻真实的光标**，
#    所以撤销没恢复光标**不该**让它红；它红了说明两条判据耦合成了一条。
检查.append(变异判据("M20", "m20.json", "W2b",
                    "变异：撤销不把光标放回去（恒 `caretPos: 0`）⇒ 判据 W2b 必须红，W2/W5 必须仍绿",
                    保持绿=["W2", "W5"]))

检查.append(变异判据("M21", "m21.json", ["Q1b", "Q1c"],
                    "变异：单元格换进 `<td>` 时不摘 `cm-rmd-offscreen`（用户 2026-10-28 实测的"
                    "「数据会消失，无法选中，无法编辑」）⇒ 判据 Q1b / Q1c 必须红，"
                    "几何与载荷那几条必须仍绿",
                    保持绿=["Q2", "Q2b", "Q3"]))

检查.append(变异判据("M22", "m22.json", ["Q2b", "Q2c"],
                    "变异：`.cm-rmd-cell` 不截水平溢出（`bugs/0027`：格子里的编辑视图"
                    "瞬时撑到 10 万 px ⇒ 表格被分配一条 12 px 的经典横向滚动条，"
                    "整张表长高、下面全部被推下去）⇒ 判据 Q2b / Q2c 必须红，"
                    "而「这一格」那三条（Q1b 看得见 / Q1c 画在格里 / Q1d 格高不变）必须仍绿",
                    保持绿=["Q1b", "Q1c", "Q1d", "Q3"]))

检查.append(变异判据("M23", "m23.json", ["Q14b", "Q14", "Q14c"],
                    "变异：单元格入口把换行折成空格（`live/objects.js` 的 `text` 从恒等改成 "
                    "`\\n → ' '`）⇒ 两行粘进一格时视图里**只剩一行**。"
                    "判据 Q14b（视图里两行都在 ∧ 高度 == 阅读态两行）必红；"
                    "⚠️ **Q14（提交出去是 `<br>`）与 Q14c（再点进来仍是两行）也会红**——"
                    "折在入口之后提交出去的是空格、再进来也没有换行，那是**同一处缺陷的三面**，"
                    "⛔ 别当成三条独立证据（字节面由 Q14 自己承担、解码面由 M32 承担）。"
                    "⚠️ 2026-10-28 换靶：`bugs/0035` 之后格内换行合法，产品的策略是恒等 ⇒ "
                    "靶子必须反过来施加旧形态（继续用 `text: foldNewlines` 会 `HITS=0` 退 4）",
                    保持绿=["Q11", "Q12", "Q13"]))

检查.append(变异判据("M24", "m24.json", ["Q15", "Q5d"],
                    "变异：`commitCell` 提交之后不更新 `a.cell.to`（区间不跟内容走）⇒ "
                    "判据 Q15（Tab 走格连提两次也不把字写重）与 Q5d（第一次提交改的正是那一格）"
                    "**都**必须红——⚠️ 2026-10-28 首次全量实跑当场纠正了原先的口径："
                    "`stillDirty()` 用**陈旧区间**去比 `textOf(cur, from, to)`，"
                    "只要这一次提交让内容**变长**它就会判「还脏」并补第二次提交 ⇒ "
                    "**一次提交的动作也逃不掉**，Q5d 当不了负对照。"
                    "⇒ 负对照换成**不碰提交**的纯几何两条（Q1d 那一格自身高度 / Q2b 表高）",
                    保持绿=["Q1d", "Q2b"]))

检查.append(变异判据("M25", "m25.json", ["Q20", "Q21", "Q22"],
                    "变异：单元格不装软换行（`makeLiveView` 的 `if (!code)` 打回 "
                    "`if (!code && !isCell)`）⇒ 判据 Q20（视觉行盒 ≥ 2 且光标在格内）必红。"
                    "⚠️⚠️ **Q21/Q22 也一并红，那是同一处缺陷的另外两面**（⇒ ⛔ 别把三条当成"
                    "三份独立证据）：Q21 的对照是「同一串字在阅读态排多高」，不换行就只有一行；"
                    "Q22 的 ↑/↓ 按视觉行走，只有一行时 `moveVertically` 返回 null ⇒ 一次都不动。"
                    "⇒ 负对照只能取**不读折行**的：Q19（←/→ 连续移动）与 Q1d/Q2b（几何）",
                    保持绿=["Q19", "Q1d", "Q2b"]))

检查.append(变异判据("M26", "m26.json", "Q22",
                    "变异：上下箭头退回按**逻辑行**（关掉 `main.js::onKeyDown` 里那段 "
                    "`view.moveVertically`）⇒ 判据 Q22 必红。"
                    "⚠️ 负对照 Q19（←/→）、Q20（软换行）、Q21（高度）必须仍绿——"
                    "这条变异只动「上下」，⛔ 别把折行本身也打红",
                    保持绿=["Q19", "Q20", "Q21"]))

检查.append(变异判据("M27", "m27.json", "R1b",
                    "变异：双击分支不置 `dragging = true`（`live/selection.js::installMouse`）"
                    "⇒ 双击选中一个词之后**继续拖**没有反应，判据 R1b 必红。"
                    "⚠️ 负对照 R1（双击本身选中了一个词）**必须仍绿**——这条变异只动「接着拖」",
                    保持绿=["R1"]))

检查.append(变异判据("M28", "m28.json", "R2",
                    "变异：`moveHandler` 末尾不再起自动滚动循环（摘掉 "
                    "`requestAnimationFrame(步进)`）⇒ 拖到窗口下边缘光标不再前进，判据 R2 必红。"
                    "⚠️ 负对照 R1/R1b **必须仍绿**——选区照旧跟手，只有「滚」这一条没了",
                    保持绿=["R1", "R1b"],
                    基线键="bigblock/R2"))

检查.append(变异判据("M29", "m29.json", "Q23",
                    "变异：`commitCell` 不接 `padFor`（内容末尾的反斜杠不再补右侧空格）⇒ "
                    "提交出去的行里那个 `\\` 把分隔竖线转义掉、右邻格被并进来，判据 Q23 必红。"
                    "⚠️ 这条**只有 Q23 看得见**：`tests/js/live-cell.test.js` 验的是 `padFor` 本身，"
                    "「提交出去的那一行真是它拼的」还要经过 `splice` ＋ `session.commit` ＋ `a.cell.to` 跟随。"
                    "⚠️ 负对照取 Q5d / Q15：它们不以「内容末尾是反斜杠」为前提，必须仍绿",
                    保持绿=["Q5d", "Q15"]))

检查.append(变异判据("M30", "m30.json", ["Q8", "Q24"],
                    "变异：单元格的 `enter` 策略打回 `'walk'`（`bugs/0035` 之前的产品形态）⇒ "
                    "格内裸 `Enter` 走下一行同一列、`⇧↵`/`⌥↵` 也一起走格 ⇒ 格内再也按不出新行。"
                    "判据 Q8（Enter 在格内换行 ∧ ⛔ 不走到下一行）与 Q24（⇧↵/⌥↵ 同样换行）"
                    "**都必须红**。⚠️ 2026-10-28 换靶：旧靶子（`⇧↵`/`⌥↵` 逃出格子分支）"
                    "在「格内不许换行」的年代是缺陷，`bugs/0035` 之后**那正是要的行为**。"
                    "⚠️ 负对照取 Q11（格内 ⌘A＋⌫）与 Q19（格内 ←/→）：都不碰 Enter，必须仍绿",
                    保持绿=["Q11", "Q19"]))

检查.append(变异判据("M31", "m31.json", "Q25",
                    "变异：`makeLiveView` 不给装饰层 `cellContext`（摘掉 `obj.inlineOnly` 那一行）⇒ 格子的文本被当成"
                    "**独立 Markdown 文档**解析，`# 普通格子` 套上 `cm-rmd-h1`（字号/行高跳一级），"
                    "判据 Q25（无标题类 ∧ 字号 == 正文）必红。"
                    "⚠️ 负对照取 N2（标题块里回车长出的新行 == 正文字号）与 O-h1-5（只剩 `##`）："
                    "两条都走**块**上下文，必须仍绿——否则说明这条变异把整条「行品种」都关了",
                    保持绿=["N2", "O-h1-5"]))

检查.append(变异判据("M32", "m32.json", "Q14c",
                    "变异：进格时不做解码（`live/index.js` 的 `text = cellMod.decode(raw)` "
                    "打回 `text = raw`）⇒ 源码里的 `<br>` 原样落进视图，用户在自己的表格里"
                    "看见**字面的 `<br>`**；提交出去仍是一个 `<br>`（`encode` 原样照抄）⇒ "
                    "字节没变、连「脏」都不算，屏幕上唯一的一面就是「再进去时看到的是什么」。"
                    "判据 Q14c（提交之后再点进这一格：视图仍是两行）必红。"
                    "⚠️ 负对照 Q14（提交出去是一个 `<br>`）与 Q14b（第一次粘贴时两行都在、几何对）"
                    "必须仍绿——解码只影响「读进视图」，不影响「写出去」",
                    保持绿=["Q14", "Q14b"]))

检查.append(变异判据("M33", "m33.json", "N3b",
                    "变异：组合串不跟光标那一行的排版走（摘掉 `paintPreedit` 里的 "
                    "`syncPreeditMetrics(preeditEl)`）⇒ 覆盖层只继承 host 的**块级**文字层，"
                    "而标题块里第二行是正文尺度 ⇒ 拼音按标题字号画、上屏却是正文"
                    "（用户 2026-10-29 原话：「拼音落地的字体虽然是正文，正常，但是拼音的字很大」）。"
                    "判据 N3b（正文行上的拼音 == 那一行的字号/字重）必红。"
                    "⚠️ 负对照 N1b（标题行上的拼音 == 标题尺度）与 N2/N3（行本身的尺度）"
                    "必须仍绿——覆盖层跟的是**行**，⛔ 不是把拼音钉成某个固定字号",
                    保持绿=["N1b", "N2", "N3"]))

def 排序键(c):
    i = str(c["id"])
    # ⚠️ 只有 `夹具/判据` 这一种 id 才该按 "/" 切——判据**正文里也可能带斜杠**
    #    （例：`H8 退出后写授权收回（begin_edit / end_edit 配平）`），
    #    直接 `split("/")[-1]` 会把它切成 `' end_edit 配平）'` ⇒ 前缀一条都匹配不上，
    #    ⛔ 于是那条判据静默掉到最后一档（2026-10-26 实测踩到）。
    前缀 = i.split(" ", 1)[0].split("/", 1)
    带夹具 = len(前缀) == 2
    head = (前缀[1] + i[len(前缀[0]) + 1:]) if 带夹具 else i
    for pre in ("M", "A", "B-", "D-", "G-", "H-", "L-", "N-", "O-", "P-", "Q-", "R-", "C", "D", "G", "H", "L", "N", "O", "P", "Q", "R", "E", "B", "Z"):
        if head.startswith(pre):
            rest = head[len(pre):]
            num = ""
            for ch in rest:
                if ch.isdigit():
                    num += ch
                else:
                    break
            return (1 if 带夹具 else 0, pre, int(num or 0), i)
    return (2, "", 0, i)

检查.sort(key=排序键)
通过 = [c for c in 检查 if c["结果"] == "通过"]
失败 = [c for c in 检查 if c["结果"] == "失败"]
跳过 = [c for c in 检查 if c["结果"] == "跳过"]

doc = {
    "schema": "rmd-live-block-probe/1",
    "date": today,
    "口径": {
        "说明": "`design/0047` §7.2 第 6 条：**真应用**（`src/index.html` ＋ 全部 `src/**`）"
                "在离屏 WKWebView 里跑，后端换成 `fake-tauri.js`（回**真 comrak** 导出的载荷）"
                "⇒ 驱动的是真 `onLiveDocDown` / `makeLiveView` / `swapLiveView`。",
        "为什么": "F5（活动块等高）与 Prep/Swap 几何**只有真 DOM ＋ 真样式表**能判："
                  "等高校验量的是 **border box**（`getBoundingClientRect().height`，不含外边距；"
                  "⚠️ 2026-10-26 由 `offsetHeight` 改过来，因为后者两侧取整会把 0.5 px 容差吃掉，"
                  "见 `docs/bugs/0013`），盒子没搬时它照样全绿、"
                  "用户却看得见'点一下全文上跳 15.4px'；F6 的四段也是一个纯逻辑测不到的形态。",
        "⚠️ 边界": "① 假后端**不渲染 Markdown** ⇒ B/D/E 只在'正文没真正改动'的路径上跑"
                   "（进入 / 组合 / 撤销后退出）；H 段**只判调用了谁与载荷是什么字节**，"
                   "⛔ 不判重渲出来的 HTML——那半归 `make probe-live-commit`、"
                   "`make fidelity` 与人工。"
                   "② ⚠️⚠️ **可见首帧（§7.1 `0c-②`）不在本探针里**——它要求窗口可见，"
                   "如实留在人工验收那一档。"
                   "③ 页内事件是**派发到 DOM 元素**上的（⛔ 不是系统级合成按键）。",
        "⭐ H 段": "`⌘S` 在 live 态**不走** `keymap.dispatch()`（离屏 `textarea` 持焦点 ⇒ 会拒收），"
                   "而是 `main.js::onKeyDown` 用 `K.matchEvent(keymap.bindings, ev)` ＋ `forwardShim` 转发 ⇒ "
                   "假后端的 `get_shortcuts` 必须是 `gui::SHORTCUTS` 的**真导出**，"
                   "否则'按了没反应'与'产品没接线'输出一模一样（那次 0h 等于没验）。",
        "⭐ L 段": "§7.1 步骤 `0f` 的**可自动那半**：200 / 800 / 2000 行块里各敲 125 个字符，"
                   "量 `input` 派发 → CM6 事务 → 装饰层 `markers()` 重算 → DOM 补丁 → "
                   "**一次强制同步布局**的 p50/p95，核对 p95 ≤ 16 ms。"
                   "⚠️⚠️ **⛔ 不是端到端输入延迟**：不含系统键事件、合成/光栅化、CM6 延到 rAF 的测量，"
                   "也不含提交后的整篇重渲（假后端不渲染 Markdown）。"
                   "⚠️ WebKit 把 `performance.now()` 截到 1 ms ⇒ 另报**批量均值**（3×20 连击）补精度。"
                   "⭐ 摘要里另有一条**取证**：直接压 `liveMarks.markers()` 量 2000/4000/8000 行的趋势"
                   "（⛔ 不是判据）——超上限的块产品根本不让进，趋势只能这么取。",
        "⚠️ 容差": "0.5 px（与 `src/live/index.js::HEIGHT_TOLERANCE` 同一个口径）；"
                   "⛔ 不逐位断言历史小数（那些数属于 `notes/0036`/`0037` 的取证）。",
        "⚠️ 变异": "M1 ⇒ B0-5 红；M2 ⇒ D1b 红；M3 ⇒ E1 红；M4/M5 ⇒ H4/H5 红（同一次变异的两面）；"
                   "M6/M7 ⇒ D13/D14 红（`bugs/0014` 的真缺陷原样打回，同一次变异的两面；"
                   "⚠️ 同一轮的 D15「选区删除」必须**仍绿**——那是这条变异的反面判据）；"
                   "M8 ⇒ N2 红（`bugs/0015` 原样打回：不再把 `bodyLines` 交给装饰层）。"
                   "施加前校验命中恰好 1 次 ＋ cksum 前后不同，否则根本不算一次变异。",
        "机器": "%s / macOS %s / %s" % (model, platform.mac_ver()[0], platform.machine()),
        "⚠️ 离屏": "窗口 alphaValue=0 ＋ orderBack ＋ .prohibited ⇒ **不弹窗、不抢焦点、"
                   "不合成按键**（根 CLAUDE.md 约定 4）。代价是环境要**每次自证**。",
    },
    "环境": {
        "machine_model": model,
        "os_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "python": platform.python_version(),
        "页面自证": 环境,
    },
    "摘要": 基线原始.get("摘要"),
    # ⭐ 分段摘要**逐份夹具**留着（`摘要` 只有主夹具那一份）：`G`（长代码行）与 `L`（键入代价）
    #    的判据都按"**本轮至少一份夹具 适用:true**"把关，而 §7.1 `0f` 的 p50/p95 是**设计要写进去的数**
    #    ⇒ 只印在 stderr 的话，`--save` 存下来的 JSON 里会没有它们（数字随终端一起丢）。
    "分段": {"G": G表, "L": L表, "P": P表, "Q": Q表, "V": V表, "W": W表},
    "检查": [{k: v for k, v in c.items() if k != "_键"} for c in 检查],
    "结论": {"通过": len(通过), "失败": len(失败), "跳过": len(跳过)},
}

if to_json == "1":
    print(json.dumps(doc, ensure_ascii=False, indent=2))
else:
    if 失败:
        print("⛔ 就地编辑块视图：**没通过**（%d 条失败）" % len(失败), file=sys.stderr)
    elif 跳过:
        print("⚠️ 就地编辑块视图：有 %d 条**没判定**（--no-mutate，⛔ 不是失败）" % len(跳过),
              file=sys.stderr)
    else:
        print("✅ 就地编辑块视图：%d 条全通过" % len(通过), file=sys.stderr)
    for c in 检查:
        mark = {"通过": "✅", "失败": "⛔", "跳过": "⏭"}.get(c["结果"], "?")
        print("%s %-12s %s" % (mark, c["id"], c["值"].get("说明", "")), file=sys.stderr)
        if c["结果"] != "通过":
            print("      判据：%s" % c["判据"], file=sys.stderr)
            print("      实测：%s" % json.dumps(c["值"], ensure_ascii=False), file=sys.stderr)
    print("· 摘要 = %s" % json.dumps(doc["摘要"], ensure_ascii=False), file=sys.stderr)
    for name, env in [("主夹具", 环境["主夹具"])] + [(x["名"], x["环境"]) for x in 环境["其余夹具"]]:
        print("· 环境[%s] = %s" % (name, json.dumps(env, ensure_ascii=False)), file=sys.stderr)
    print(json.dumps(doc, ensure_ascii=False, indent=2))

if save == "1":
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("✅ 结果写入 %s" % out, file=sys.stderr)

sys.exit(1 if 失败 else (2 if 跳过 else 0))
PY
