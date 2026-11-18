#!/usr/bin/env bash
# 跑 `design/0047` §7.2 **第 6 条**（`make probe-live-block`）：
# **「唯一全文模型 ＋ 单块编辑视图」在真 WKWebView 里的接线与几何**。
#
# 用法：
#   tools/live-probe/block-probe.sh                # 每份夹具一轮 ＋ 六十七处变异（M1–M38、M40–M41、M43–M54、M56–M70；M39／M55 已退役、M42 挂起，见 M41 之后）
#   tools/live-probe/block-probe.sh --no-mutate    # 只跑基线（快）
#   tools/live-probe/block-probe.sh --save         # 另存一份到 benchmarks/results/
#   tools/live-probe/block-probe.sh --save --force # 允许覆盖同名结果
#   tools/live-probe/block-probe.sh --json         # 只打原始 JSON
#   tools/live-probe/block-probe.sh --only=tasks --diag  # 只跑一份夹具（取证用，⛔ 不是全轮判据）
#   tools/live-probe/block-probe.sh --e2e           # ⭐ `design/0062` 端到端输入探针（原生键 / 组合注入）
#
# ⭐ `--e2e`（`design/0062`）**不是**上面那套几何判据：它复用 Stage A 夹具与 `build_page`，
#    换成 `input-e2e-harness.js` ＋ `input-e2e-probe.swift`，在第一响应者 / `NSTextInputClient`
#    两个面注入真实 `NSEvent` / 组合文本，跑 A–H 组判据（到达性 / 文本 / 组合 / 删除换行方向 /
#    焦点 Tab / 菜单抢键 / 提交 / 自证），再跑四条变异（M-E1–M-E4）验证判据承重。
#    ⚠️ 该分支**会**调 `window.makeFirstResponder(webView)`（按键必须进本窗口的响应者链），
#    但窗口既非 key、进程也未激活、alpha＝0、`orderBack`，⛔ 不改变用户焦点（判据 H1–H5 自证）。
#    退出码沿用：0 全绿 / 1 判据红 / 3 环境无效 / 4 变异没打到。
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
# ⭐ **U 段：列表项上的多输入序列**（2026-11-11 用户要求「自己执行多输入测试」）——
#   逐字键入 / 回车续项 / 空项退列表 / 组合上屏 / 正文中间插入，每种列表行（无序／有序／任务）
#   各跑一遍，**每步都比上一步的期望全文＋光标＋行号**；每场景之后 `⌘Z` 必须撤回基线，退出零提交。
#   覆盖闸门是下面的 `U-覆盖`；承重变异是 M60（空项不删标记）与 M61（编号不 +1）。
#
# ⚠️ 判据 M1–M38、M40–M41、M43–M54、M56–M70 是**变异测试**，打在**页面副本**上（⛔ 不碰仓库文件）：
#   下面逐条写的是**踩过坑、改法有歧义**的那几条；其余各条（M5 / M9–M19 / M21–M24 / M27–M31 / M40）的
#   一句话口径与"必须红哪条判据"在脚本末尾那批 `变异判据(...)` 里，⛔ 不在此重复。
#   ⭐ **2026-11-12 补齐五条承重变异**（按 `.claude/rules/tests.md`「没做过变异测试的断言不算数」）：
#       M62＝`bugs/0304`（`zwRanges` 退回空）｜M63＝`bugs/0316`（`pre-wrap` → `break-spaces`）｜
#       M64＝`bugs/0317`（落点映射退回合并区间；⚠️ **只随 `PROBE_W=760` 档产出**，1000 宽下该路径不可达）｜
#       M65＝`bugs/0314`（④′ 恒假）｜
#       M66＝`bugs/0111` A6（删除层拿不到块前缀）。连同 M50／M52／M61，本轮八条修复都有承重变异。
#   ⭐ **M41（`design/0061` §5 `INV-LIVE-14`）**＝把「活动行显示源码」打回来（`design/0061` 之前的
#       产品形态）⇒ 判据 `Q35`（活动行也不许露源码）与 `Q36`（进入编辑态行几何逐行相同）必须红，
#       而 `B0-4`/`B0-5`/`D2`／`Q35b` 必须仍绿（块级几何与"标记确实存在"与本条无关）。
#       ⚠️⚠️ 靶子**打在 `decorations.js` 施加隐藏区间的那一步**（`plan.ranges` / `plan.fenceLines`），
#       ⛔ 不打 `activeLineIndexes` 函数体：L1 可能把它删掉或退化成恒空，打在那里会 `HITS=0`；
#       而在施加点"按光标行放行"复现的**用户可见后果**与旧形态逐点相同（标记露出来、行变宽/变高）。
#   ⛔ **M39 已退役（2026-11-08，`bugs/0099` §5.1）**：它压的前提（进入编辑态时活动行显示源码 ⇒
#       格内排版比阅读态宽）已被 `design/0061` L1 消灭 ⇒ 变异后**0 条判据红**（2026-11-05 实测
#       `m39.json` 400 条 0 红）。⛔ 别再把它加回 `变异判据`，也别说它证明 `bugs/0084` 第三面。
#       ⚠️ 同族承重已由 **M41**（`Q35`/`Q36`）承担。
#   ⛔ **M55 已退役（2026-11-09，`bugs/0302` §3.3）**：`render.rs` 把任务方框写进首段**内部**之后，
#       `<li>` 自己不再有行盒 ⇒ WebKit 把 `li::first-line` 落到首个子块的首行 ⇒ 原来的第二条
#       选择器 `.doc li.task-list-item > p:first-of-type::first-line` 冗余。摘掉它重跑
#       `W11p` **仍然通过**、几何逐点相同（方框顶 774.83 / 首字顶 772.66）⇒ 变异后 0 条判据新增红。
#       ⛔ 别再把它加回 `变异判据`；阅读态的承重证据由 **M54** 单独承担（`W11r`＋`W11p`）。
#   ⚠️ **M42 挂起**：把 `selection.js::legalEdge` 停成恒等（`return pos`）⇒ 落点/删除相关的新判据必红。
#       2026-11-05 写这一版时该函数**尚不存在**（`design/0061` L2 实施中）；2026-11-08 复核它**已落地**
#       （`src/live/selection.js:345`），但**仍没有承重判据**：`Q34` 走 `legalNearest`（dir 0）；
#       `D12–D16` / `Q22` / `Q37` 的落点都在可见字节上，恒等 `legalEdge` 结果相同 ⇒ 只是"假变异"。
#       ⛔ **不写 HITS=1 但 0 红的假变异**；落地口径见 M41 之后那段 `# M42（挂起）` 与 `bugs/0099` §7。
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
E2E=0
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --json)      TO_JSON=1 ;;
    --save)      SAVE=1 ;;
    --force)     FORCE=1 ;;
    --no-mutate) MUTATE=0 ;;
    --diag)      DIAG=1 ;;
    --e2e)       E2E=1 ;;
    --only=*)    ONLY="${arg#--only=}" ;;
    -h|--help) sed -n '2,110p' "${BASH_SOURCE[0]}"; exit 0 ;;
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

# ── 工作目录与互斥 ───────────────────────────────────────────────────────────
# ⚠️ **2026-11-09 真踩过两次**：两跑共用 `.lb-work`，后起的 `build_page`（`rm -rf "$dir"`）
#    会把前跑正在用的页面目录删掉，症状是 `sed: …/other/longcode.err: No such file or directory`、
#    载荷 0 字节——**看上去像"产品红"，其实是环境无效**。锁必须在第一次 `rm -rf` 之前拿到。
#
# 要**真正并行**（例如两个 agent 同时在改这份仓）就给后来者一个独立工作目录：
#     LB_WORK=/tmp/lb-work-b tools/live-probe/block-probe.sh --no-mutate
# 锁跟着工作目录走，两边互不相干；共用一个目录时后到者退 3，⛔ 别删锁硬闯。
WORK="${LB_WORK:-$HERE/.lb-work}"
LOCK="${WORK}.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  HOLD="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$HOLD" ] && kill -0 "$HOLD" 2>/dev/null; then
    echo "⛔ 另一个探针正在跑（pid ${HOLD}，锁：${LOCK}）" >&2
    echo "   两跑共用 $WORK 会互相删页面（2026-11-09 实测）⇒ 这次跑出来的数字不作数。等它跑完，或用 LB_WORK 换个目录。" >&2
    exit 3
  fi
  echo "⚠️ 清掉残留锁（pid ${HOLD:-?} 已不在）" >&2
  rm -rf "$LOCK"
  mkdir "$LOCK" || { echo "⛔ 抢锁失败：$LOCK" >&2; exit 3; }
fi
echo "$$" >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

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

# ⭐ 夹具名：**`blocks` 排第一 ⇒ 主夹具**（F6、H 链路与大部分变异都压在它身上）。
#    ⚠️⚠️ **2026-11-12 实测**：原来按"块最多"排，`edges`（25 块 > `blocks` 17 块）进夹具集后
#    主夹具被换成 `edges` ⇒ M15–M26 / M29–M32 / M35–M38 / M40 / M43 / M50 / M59 共 26 条变异
#    全部退化成"变异后 null"（它们瞄准的是**表格 / 任务项 / 引用 / 围栏**这些形状，`edges`
#    一样都不带）⇒ 判据无法判定（只剩"变异新增红 = []"这一征，人一略过就静默失效）。
#    主夹具必须是**全形状**那份，⛔ 不能只按块数挑；其余夹具仍按块数降序（只为日志好读）。
NAMES_FILE="$WORK/names.txt"
python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
names = [x["name"] for x in sorted(d["docs"], key=lambda x: -len(x["blocks"]))]
if "blocks" in names:            # 全形状夹具：表格 / 任务项 / 引用 / 围栏 / 强调都在
    names.remove("blocks")
    names.insert(0, "blocks")
for n in names:
    print(n)
' "$FIXTURE_JSON" > "$NAMES_FILE"
if [ ! -s "$NAMES_FILE" ]; then
  echo "⛔ 夹具载荷里没有文档" >&2
  exit 3
fi
TARGET="$(sed -n '1p' "$NAMES_FILE")"
# ⭐ `--only=NAME`：只跑一份夹具（取证 / 单份复跑用）。⚠️ 它**不是**一轮判据：
#    其余夹具的覆盖闸门（`block-probe.sh::W-覆盖`）会看到"这一份没跑"，⛔ 别把 `--only`
#    的结果当成"全轮通过"。
if [ -n "$ONLY" ]; then
  if ! grep -qx -- "$ONLY" "$NAMES_FILE"; then
    echo "⛔ --only=$ONLY 不在夹具载荷里（有：$(tr '\n' ' ' < "$NAMES_FILE")）" >&2
    exit 3
  fi
  grep -x -- "$ONLY" "$NAMES_FILE" > "$WORK/names.only"
  mv "$WORK/names.only" "$NAMES_FILE"
  TARGET="$ONLY"
fi
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
    位置: String(e.filename || '').split('/').pop() + ':' + (e.lineno || 0),
    // ⚠️ `file://` 下这里是 `Script error.`（跨源拿不到栈）⇒ 阶段标记是**唯一**线索。
    阶段: String(window.__PHASE || '') });
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
# ⚠️ **2026-11-09 真踩过**：`block-harness.js` 里一段文档注释漏了收尾 `*/`，后半段被整段吞掉，
#    `window.__RUN` 没挂上 ⇒ 全部夹具都报 `Script error.`，运行器**照样产出 JSON**，
#    看上去像"产品全红"。语法错误必须在**起跑前**拦下（`node --check`，几毫秒）。
if command -v node >/dev/null 2>&1; then
  node --check "$HARNESS" >"$WORK/harness-syntax.log" 2>&1 || {
    echo "⛔ 探针自己语法错误（⛔ 这不是产品红）：" >&2
    sed -n '1,20p' "$WORK/harness-syntax.log" >&2
    exit 3
  }
fi
BIN="$WORK/live-block-probe"
echo "▶ 编译运行器…" >&2
swiftc -O "$SWIFT" -o "$BIN" >"$WORK/build.log" 2>&1 || {
  echo "⛔ 编译失败：" >&2; sed -n '1,40p' "$WORK/build.log" >&2; exit 3
}

# ── ④ 跑一轮（运行器自带 300 秒兜底；这里再套一层 360 秒看门狗）──
# ⚠️ 2026-11-05：180/240 → 300/360。`M15`（单元格写回整行重拼）那一页把提交弄坏之后，
#    下游每条判据都要等满自己的 `waitFor` ⇒ 实测 **187 秒**（其余页 20–90 秒），
#    180 秒的兜底把"慢"误报成"挂死"。⛔ 这是兜底，不是性能判据。
run_round() {
  local page="$1" raw="$2" err="$3"
  "$BIN" "$page" >"$raw" 2>"$err" &
  local pid=$!
  local i
  for i in $(seq 1 720); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "⛔ 360 秒没结束，强杀。" >&2
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
  #    每一帧都走 300 ms 兜底 ⇒ 整轮拖过兜底时限，报出来的却是「300 秒没拿到结果」，
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
  # ⭐ 记一行"这一处变异**真的施加了**"（`bugs/0099` §5 第 3 条）：聚合器把它与
  #    "变异后红数"一起输出，用来把「变异失效（命中 1 次、但一条判据都没红）」与
  #    普通失败区分开。⚠️ 只记**校验通过**的施加；HITS≠1 / cksum 没变在上面就退出了。
  local page
  page="${file#"$WORK"/}"
  page="${page%%/*}"
  printf '%s|HITS=1|%s|%s\n' "$page" "$before" "$after" >> "$WORK/mutations.log"
}

# ── ⑤b `--e2e`（`design/0062`）：端到端输入探针 ───────────────────────────────
#
# ⭐ 与上面的几何探针**同一份构页产物**（Stage A 的真 comrak 载荷 ＋ 产品 `src/**` ＋ 假后端），
#    只换两样：页面侧 `window.__E2E`（薄动作/快照）与运行器（原生键 / 组合注入）。
# ⚠️ ⛔ 不改产品 `src/**`、⛔ 不改 `block-harness.js` 的判据。
e2e_judge() {
  python3 -I - "$1" <<'PY'
import json, sys
p = sys.argv[1]
try:
    d = json.load(open(p, encoding="utf-8"))
except Exception as e:
    print(f"⛔ 读不了 {p}: {e}", file=sys.stderr)
    sys.exit(3)
c = d.get("结论") or {}
ok, bad = int(c.get("通过") or 0), int(c.get("失败") or 0)
sk = int(c.get("跳过") or 0)
checks = d.get("判据") or []
print(f"{ok}/{ok + bad} 通过，{bad} 失败，{sk} 跳过")
for ck in checks:
    if ck.get("ok") is not True:
        print(f"- 红：{ck.get('判据')}｜{ck.get('说明')}")
env = d.get("环境") or {}
if env.get("前台被抢过"):
    print("⛔ 前台被抢过（本轮作废）", file=sys.stderr)
if d.get("致命"):
    print(f"⛔ 致命：{d['致命']}", file=sys.stderr)
PY
}
e2e_red() {  # $1=json $2=判据前缀 → 0=红, 1=绿, 4=没有这条判据
  python3 -I - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
pre = sys.argv[2]
hit = [c for c in (d.get("判据") or []) if str(c.get("判据", "")).startswith(pre)]
if not hit:
    sys.exit(4)
sys.exit(0 if any(c.get("ok") is not True for c in hit) else 1)
PY
}
e2e_env_ok() {  # 0=环境有效
  # ⚠️ **不判 `isVisible`**：`orderBack` 之后窗口仍在窗口序里（`isVisible` 真），
  #    它在屏幕上看不见靠的是 `alpha == 0`；判 `isVisible` 会把正确环境判成无效
  #    （2026-11-15 首次实跑踩到）。真正的"没打扰用户"是：前台应用未变、进程未激活、窗口不是 key。
  python3 -I - "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
env = d.get("环境") or {}
w = env.get("窗口") or {}
bad = (d.get("致命") is not None or env.get("前台被抢过") is True
       or float(w.get("alpha", -1)) != 0.0
       or w.get("窗口是_key") is True or w.get("进程被激活") is True)
sys.exit(1 if bad else 0)
PY
}
run_e2e_round() {  # $1=binary $2=page $3=raw $4=err
  "$1" "$2" >"$3" 2>"$4" &
  local pid=$! i
  for i in $(seq 1 480); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "⛔ 240 秒没结束，强杀。" >&2
    kill -9 "$pid" 2>/dev/null || true
    return 3
  fi
  wait "$pid" 2>/dev/null || true
  if ! grep -q '^{' "$3" 2>/dev/null; then
    echo "⛔ 端到端运行器没产出 JSON（${2}）。stderr：" >&2
    sed -n '1,80p' "$4" >&2
    return 3
  fi
  sed -n '1,10p' "$4" >&2 || true
  return 0
}
run_e2e() {
  local harness="$HERE/input-e2e-harness.js" swift="$HERE/input-e2e-probe.swift"
  local f
  for f in "$harness" "$swift"; do
    if [ ! -f "$f" ]; then echo "⛔ 缺 $f" >&2; return 3; fi
  done
  if command -v node >/dev/null 2>&1; then
    node --check "$harness" >"$WORK/e2e-harness-syntax.log" 2>&1 || {
      echo "⛔ 端到端页面脚本语法错误（⛔ 不是产品红）：" >&2
      sed -n '1,20p' "$WORK/e2e-harness-syntax.log" >&2
      return 3
    }
  fi
  HARNESS="$harness" # ⭐ `build_page` 复用它（拷成 `__harness.js` 并注入页尾）
  local bin="$WORK/input-e2e-probe"
  echo "▶ 编译端到端运行器…" >&2
  swiftc -O "$swift" -o "$bin" >"$WORK/e2e-build.log" 2>&1 || {
    echo "⛔ 编译失败：" >&2; sed -n '1,60p' "$WORK/e2e-build.log" >&2; return 3
  }

  local page="$WORK/page-e2e" raw="$WORK/e2e-base.json" err="$WORK/e2e-base.err"
  build_page "$page" "$TARGET"
  echo "▶ 端到端基线（原生长键 / 组合注入；离屏、无前台切换）…" >&2
  run_e2e_round "$bin" "$page" "$raw" "$err" || return 3
  echo "=== 端到端输入（design/0062）===" >&2
  e2e_judge "$raw" >&2
  if ! e2e_env_ok "$raw"; then
    echo "⛔ 环境无效（前台/窗口自证不过）⇒ 本轮数字作废，⛔ 不读成产品红。" >&2
    return 3
  fi

  # ── I 组：四条负对照 ──
  local mut_fail=0
  # ⭐ 只判「这一轮里 `$pre` 是否按预期打红」；**改靶在调用点写**（`apply_mutation` 的
  #    路径必须是字面形状 `"$mN/xxx"`，否则 `tests/js/probe-targets.test.js` 解析不到映射）。
  e2e_mut() { # $1=名字 $2=期望红的判据前缀 $3=页面目录（空 ⇒ 菜单变异，走基线页＋环境变量）
    local name="$1" pre="$2" pg="${3:-}"
    local mraw="$WORK/e2e-$name.json" merr="$WORK/e2e-$name.err"
    if [ -n "$pg" ]; then
      run_e2e_round "$bin" "$pg" "$mraw" "$merr" || return 3
    else
      RMD_E2E_MUTATION=menu run_e2e_round "$bin" "$page" "$mraw" "$merr" || return 3
    fi
    local rc=1
    if e2e_red "$mraw" "$pre"; then rc=0; else rc=$?; fi
    if [ "$rc" = "0" ]; then
      echo "  ✓ ${name} ⇒ 「${pre}…」按预期打红" >&2
    elif [ "$rc" = "1" ]; then
      echo "  ⛔ ${name} ⇒ 「${pre}…」**没有**打红（判据不承重）" >&2
      mut_fail=1
    elif [ "$rc" = "4" ]; then
      echo "  ⛔ ${name} ⇒ 变异后连「${pre}…」这条判据都没产出（靶子漂移/流程断了）" >&2
      mut_fail=4
    else
      echo "  ⛔ $name ⇒ 无法判定（JSON 读不了）" >&2
      mut_fail=3
    fi
  }
  echo "▶ 变异（每条都必须让对应判据实际打红）…" >&2
  if [ "${E2E_SKIP_MUT:-0}" = "1" ]; then
    # ⚠️ 只给调靶子/调注入用；此模式下**不得**把判据读成承重证据（`tests.md`）。
    echo "  ⚠️ E2E_SKIP_MUT=1 ⇒ 变异整组跳过，本轮仅调试" >&2
  else
  local m1="$WORK/page-e2e-M-E1"
  build_page "$m1" "$TARGET"
  apply_mutation "$m1/main.js" \
    "const r = deleteRange(doc, forward, mods.alt, mods.cmd);" \
    "const r = { from: 0, to: 0 };" || return 4
  e2e_mut "M-E1-删除" "D1 " "$m1"
  [ "$mut_fail" = "0" ] || return "$mut_fail"
  local m2="$WORK/page-e2e-M-E2"
  build_page "$m2" "$TARGET"
  apply_mutation "$m2/live/input.js" \
    "            tx(at.from, at.to, text.split('\n'), 'composition');
            state.swallow = text;" \
    "            tx(at.from, at.to, text.split('\n'), 'composition');
            tx(at.from, at.to, text.split('\n'), 'composition');
            state.swallow = text;" || return 4
  e2e_mut "M-E2-组合双插" "C3 " "$m2"
  [ "$mut_fail" = "0" ] || return "$mut_fail"
  local m3="$WORK/page-e2e-M-E3"
  build_page "$m3" "$TARGET"
  apply_mutation "$m3/main.js" \
    "        ev.preventDefault();
        liveSerial(function () { return leaveLive({ reason: 'tab' }); });" \
    "        liveSerial(function () { return leaveLive({ reason: 'tab' }); });" || return 4
  e2e_mut "M-E3-Tab不去焦点" "E1 " "$m3"
  [ "$mut_fail" = "0" ] || return "$mut_fail"
  e2e_mut "M-E4-菜单无加速键" "F2 "
  [ "$mut_fail" = "0" ] || return "$mut_fail"
  fi

  if [ "$TO_JSON" = "1" ]; then
    python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1],encoding="utf-8")), ensure_ascii=False))' "$raw"
  fi
  # 基线里有没有判据红（变异都过了，只看基线）
  python3 -I - "$raw" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
c = d.get("结论") or {}
sys.exit(1 if int(c.get("失败") or 0) > 0 else 0)
PY
}

if [ "$E2E" = "1" ]; then
  run_e2e
  exit $?
fi

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
    "      host.style.setProperty(css, f ? 表达式(f.k, f.b) : box[css]);" \
    "      if (css.slice(0, 6) === 'margin') continue;
      host.style.setProperty(css, f ? 表达式(f.k, f.b) : box[css]);"
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
  #     ⚠️⚠️ **2026-11-03 三度换靶**（`design/0058`）：两条短路都改成返回
  #     `txPayload(txn.STATUS.UNCHANGED, …)`，旧的一行式靶子已不存在 ⇒ `HITS=0`。
  #     现在靶子落在**条件**上（`if (false)`），等价复现"不做短路"。
  apply_mutation "$P3/live/index.js" \
    "      if (sameLines(next, cur)) {" \
    "      if (false) { /* 变异：未改动也短路（外层）摘掉 */"
  apply_mutation "$P3/live/index.js" \
    "      if (candText === baseText) {" \
    "      if (false) { /* 变异：未改动也短路（发布层）摘掉 */"
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
  #     判据 `O-h1-5`／`O-ul-5` 必须红，而 `O-pre-5`（围栏里是代码）、全部 `-5b`（已经删干净、
  #     没有标题节点）**必须仍绿**。
  #     ⚠️⚠️ **2026-11-05 起 `O-p-5` 从"保持绿"名单里拿掉了**：`bugs/0084` 第三面的
  #     `snapClickX` 落地后，`点末()` 那一下**真的落在第一视觉行右端**（不再落到折行点），
  #     于是这一条量到的是"删到只剩 `##`"——**空 ATX 标题**，正是本条变异要打断的行为
  #     ⇒ 它现在跟着 `O-h1-5`/`O-ul-5` 一起红（实测 `字号 14≠24.5`）。这不是判据坏了，
  #     是负对照的目标漂了：换成 `O-p-5b`（标记删干净、**没有标题节点**，变异碰不到）。
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
  #     ⚠️⚠️ **2026-11-03 换靶**（`design/0058` §2.1）：`splice` 从 `commitCell` **下沉**进
  #        `live/cell.js::judge`（三个结果的唯一判据），靶子跟着搬过去（⛔ 别让变异静默落空）。
  apply_mutation "$P15/live/cell.js" \
    "      nextLine = splice(line, b.from, b.to, replacement);" \
    "      nextLine = '| ' + encoded + ' |'; /* 变异：整行重拼、丢掉两侧填充 */"
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
  #     ⚠️⚠️ **2026-11-09 换靶（第二处）**：`bugs/0297` 之后，编辑期的表格是
  #     `display: table`，横向溢出的**承接者变成了 `freezeTableLayout` 的临时外壳**
  #     （`live/cell.js`，原本就横滚 ⇒ `auto`，否则 `clip`）⇒ 只摘 `.cm-rmd-cell` 的
  #     clip 时溢出被外壳接住，**一条判据都不红**（2026-11-09 实测 `Q2b` 仍 `ΔH 0 px`，
  #     外壳 `scrollW 100056 / overflowX visible`）。⇒ 必须**同时**把外壳强行改成
  #     `auto`（＝"外壳自己也当了滚动容器"），12 px 才真的回来。
  #     ⛔ 别只留第一处：那样是一条 HITS=1、0 红的假变异（`bugs/0099` §5）。
  #     ⚠️⚠️ **2026-11-09 再换靶（第三处）：`Q2b`/`Q2c` → `Q41b`**。两处都改过之后，
  #     在**本轮口径 `PROBE_W=760`** 下 `Q2b` 仍是 `ΔH 0 px`：`Q2b` 只点 (0,0) 那一格，
  #     而那个窄宽度下这一格不会触发 CM6 量行高的 `99999px` 替身（同一变异在
  #     `PROBE_W=1000` 下实测 `ΔH 12 px`）⇒ 差别在**窗口宽度**，不在变异强度。
  #     承重判据换成 `Q41b`（逐格扫描、量**滚动条厚度**，与内容无关）：基线
  #     `Δ滚动条 0 px`、变异后第 0 格 `0 → 12 px`（2026-11-09 实测）。
  P22="$WORK/page-m22"; build_page "$P22" "$TARGET"
  echo "▶ M22：单元格的水平溢出不再就地截断（外壳也改成滚动容器）…" >&2
  apply_mutation "$P22/styles/live.css" \
    "  overflow-x: clip;
  overflow-y: visible;" \
    "  /* 变异：不截这一格的水平溢出 */"
  apply_mutation "$P22/live/cell.js" \
    "        + 'overflow-x:' + (原横滚 ? 'auto' : 'clip') + ';'" \
    "        + 'overflow-x:' + 'auto' + ';'   /* 变异（M22 第二处）：外壳也当滚动容器 */"
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
    // ⭐ bugs/0104：方向键到格子边界 ⇒ 进相邻格（复刻 Mardo）。
    arrows: /** @type {const} */ ('cross'),
    text: /** @type {TextRule} */ (identity)," \
    "    tab: /** @type {const} */ ('walk'),
    enter: /** @type {const} */ ('newline'),
    // ⭐ bugs/0104：方向键到格子边界 ⇒ 进相邻格（复刻 Mardo）。
    arrows: /** @type {const} */ ('cross'),
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
  # M27：把 `live/selection.js::startDrag` 末尾的 `dragging = true;` 摘掉
  #     ⇒ 按下的那一刻**不进拖拽态**，双击选中一个词之后**继续拖**没有反应。
  #     ⇒ 判据 `R1b`（拖着走：锚点不动、头往前）**必红**；
  #     ⚠️ 负对照 `R1`（双击本身选中了一个词）**必须仍绿**——这条变异只动"接着拖"，
  #        ⛔ 不许把双击选词那一半也打红，否则分不清判据在判哪件事。
  #     ⚠️⚠️ **2026-11-02 换靶**：`bugs/0042`–`0046` 之后三档（字符 / 词 / 行）共用
  #        `startDrag`，旧靶子（双击分支里那一对 `set(...)` ＋ `dragging = true;`）已经不存在
  #        ⇒ 变异 `HITS=0`、整轮以退出码 4 结束（**不是**判据红）。靶子改成三档共用的那一行。
  P27="$WORK/page-m27"; build_page "$P27" "$TARGET"
  echo "▶ M27：双击之后不进入拖拽态…" >&2
  apply_mutation "$P27/live/selection.js" \
    "      dragging = true;
    }" \
    "      /* 变异：按下之后不进入拖拽态 */
    }"
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
  #     ⚠️⚠️ **2026-11-03 换靶**（`design/0058` §2.1）：`padFor` 同样下沉进 `cell.js::judge`。
  apply_mutation "$P29/live/cell.js" \
    "      replacement = padFor(line, b.to, encoded);" \
    "      replacement = encoded; /* 变异：不做右侧补位 */"
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

  # M33：**组合串退回"绝对定位的覆盖层"**（2026-11-02 之前的形态，用户当天
  #     「按照 mardo 来修改」之前的实现）。`position: absolute` 让它**脱离排版**：
  #     后面的字不再被推开，两段字形叠在同一片像素上（`bugs/0060` 的原缺陷）。
  #     ⇒ 判据 `D3`（行内 · ⛔ 不是 absolute）与 `D3b`（行尾被推右）必红。
  #     ⚠️ 负对照 `D1`/`D1b`/`D2`/`D1c` 必须**仍绿**：CSS 换掉定位只影响"占不占位"，
  #        ⛔ 不该把"文档不变 / 上方的块不动"也打红——那几条各自承重（`M2` 等）。
  P33="$WORK/page-m33"; build_page "$P33" "$TARGET"
  echo "▶ M33：组合串退回绝对定位的覆盖层（不占版面）…" >&2
  apply_mutation "$P33/styles/live.css" \
    '  color: var(--reader-text);
  /* ⚠️ 下划线是"这段还没进文档"的唯一提示。' \
    '  position: absolute; /* 变异：退回覆盖层（不占版面） */
  color: var(--reader-text);
  /* ⚠️ 下划线是"这段还没进文档"的唯一提示。'
  run_round "$P33" "$WORK/m33.json" "$WORK/m33.err"

  # M34：**组合串画错位置**（落在插入点右边一个字）。这是"拿错位置"的典型形态：
  #     组合串还在行内、还占位、行尾照样被推右 —— 只有"它在文档的哪个偏移上"这一面能看出来。
  #     ⇒ 判据 `D3c`（`posAtDOM(widget)` == 选区头）必红。
  #     ⚠️ 负对照 `D3`/`D3b`（行内 / 占版面）必须**仍绿**——它们证的是"有没有进排版"，
  #        ⛔ 不是"落在哪一格"；这两面分开承重，⛔ 别把一条当另一条的替代。
  P34="$WORK/page-m34"; build_page "$P34" "$TARGET"
  echo "▶ M34：组合串落在插入点右边一个字…" >&2
  apply_mutation "$P34/main.js" \
    "      if (s && !preeditShown) preeditPos = clampPos(currentRange().from);" \
    "      if (s && !preeditShown) preeditPos = clampPos(currentRange().from + 1); /* 变异：画错一格 */"
  run_round "$P34" "$WORK/m34.json" "$WORK/m34.err"

  # M35：**摘掉表格命中的几何兜底**（`main.js` 的 `|| LCell.cellAtPoint(…)`，`bugs/0066` 之前
  #     的产品形态）⇒ 行尾死区里的按下**命中的是 `<table>` 元素本身**，`cellFromTarget`
  #     一步都走不动 ⇒ 只弹一条"请点格子"的提示。
  #     ⇒ 判据 `Q26`（行尾 +0/+8/+16）、`Q28`（表头行尾）、`Q29`（最后一行底边）必须红。
  #     ⚠️ 负对照 `Q1`（格子左上角）与 `Q27`（死区 +64 px ⛔ 不抢点击）必须**仍绿**：
  #        Q1 走的是正常 DOM 上溯，Q27 判的是"别过头"——两面分开承重，⛔ 别拿一条当另一条。
  #     ⚠️ `Q26b`（行尾那几次按下的目标真的是 `<table>`）也必须仍绿：它判的是**几何前提**，
  #        与兜底在不在无关；它红了说明夹具/CSS 变了，⛔ 不是这条变异的证据。
  P35="$WORK/page-m35"; build_page "$P35" "$TARGET"
  echo "▶ M35：表格命中没有几何兜底（点行尾只弹提示）…" >&2
  apply_mutation "$P35/main.js" \
    "      const td = cellFromTarget(ev.target, node)
        || (typeof LCell.cellAtPoint === 'function'
          ? LCell.cellAtPoint(node, ev.clientX, ev.clientY)
          : null);" \
    "      const td = cellFromTarget(ev.target, node); /* 变异：摘掉几何兜底 */"
  run_round "$P35" "$WORK/m35.json" "$WORK/m35.err"

  # M36（`design/0049`）：宿主内那**两道**拦截一起摘 ⇒ 在正在编辑的格子里再点一下会被
  #     当成一次**新的进入**：重新 `begin_edit`、换一个新宿主 ⇒ 光标 / 选区 / 组合串全丢。
  #     ⇒ 判据 `Q32` 必须红。
  #     ⚠️⚠️ **必须两处一起摘**（2026-11-03 实测：M36 第一版只摘 ① 那两句，`Q32` **仍然全绿**
  #        ——"变异没红"与"判据不承重"长得一模一样，⛔ 别把那一版当成判据的证据）：
  #        ① `selection.js::down()`（capture 期，挂在 `view.dom` 上）的
  #           `preventDefault()` ＋ `stopPropagation()`；
  #        ② `main.js::onLiveDocDown` 的 `if (ev.defaultPrevented) return;`。
  #        摘掉 ① 之后事件继续下潜到 CM6 自己的 `mousedown` 处理，**它**会 `preventDefault()`；
  #        接着 ② 那一句把事件挡掉 ⇒ 少了任何一道，另一道都会顶上（纵深防御，不是重复代码）。
  #     ⚠️⚠️ **2026-11-04 起还要摘第三处**（`bugs/0069` 的活动格守卫）：那 6 行在
  #        `onLiveDocDown` 的 Table 分支里判「点中的就是正在编辑的那一格 ⇒ 只挪光标」，
  #        会在 ① ② 都被摘掉之后**顶住 Q32**。⇒ 本变异现在证明的是
  #        「**三层**合起来守住 Q32」，而 M38 单独证明第三层自己的职责。
  #     ⚠️⚠️ **为什么块级没有任何一条会红**：`onLiveDocDown` 里那道
  #        `node.classList.contains('cm-rmd-liveHost')` 闸判的是**块顶节点**，
  #        而格子那颗宿主是挂在 `<td>` **里面**的 ⇒ 闸看到的是 `<table>`、
  #        拦不住。这一条正是"块级有闸、格子靠两处拦截"的证词。
  #     ⚠️ 负对照取 `Q1`（点格子进得去）与 `Q31`（点**另一格**换格）：
  #        这两条走的是"按下发生在宿主**外面**"的那条路，摘掉宿主内那两道拦不该影响它们
  #        （2026-11-03 实测：这两条变异后仍绿）；它们红了说明改到的不是"宿主内的那一下"。
  P36="$WORK/page-m36"; build_page "$P36" "$TARGET"
  echo "▶ M36：在正在编辑的格子里再点一下会重新进格…" >&2
  apply_mutation "$P36/live/selection.js" \
    "      ev.preventDefault();
      ev.stopPropagation();" \
    "      /* 变异：宿主内的按下不拦 */"
  apply_mutation "$P36/main.js" \
    "    if (ev.defaultPrevented) return;" \
    "    /* 变异：第二道闸也摘掉 */"
  apply_mutation "$P36/main.js" \
    "      const act = typeof live.activeCell === 'function' ? live.activeCell() : null;
      if (act && act.blockIndex === index && act.flat === flat && live.isEditing()
        && typeof live.focusPoint === 'function') {
        live.focusPoint({ x: ev.clientX, y: ev.clientY });
        return;
      }" \
    "      /* 变异：第三层（活动格守卫）也摘掉 */"
  run_round "$P36" "$WORK/m36.json" "$WORK/m36.err"

  # M37（`bugs/0069`）：`installMouse` **不把监听面放宽到那一格的 `<td>`**（摘掉 `hitArea` 整条通路，
  #     `bugs/0069` 之前的产品形态）⇒ 格内右侧空白上的按下**没有任何人接**，一路冒泡到
  #     `#doc` 的 `onLiveDocDown`。此时 `Q33` 仍绿（`onLiveDocDown` 里那道"点的就是活动的那一格
  #     ⇒ 只挪光标"的守卫还顶上），**只有拖拽没了**：`moveHandler` 要靠 `down()` 建立的拖拽态，
  #     而那一下没人叫 `down()` ⇒ 判据 `Q33c`（空白处按下再拖出选区）必须红。
  #     ⚠️⚠️ **必须两处一起摘**：只摘 `selection.js` 的兜底，`main.js` 仍会传 `hitArea`，
  #        `(hooks.hitArea) || view.dom` 照样拿得到 `<td>` ⇒ `Q33c` 仍绿。
  #        （同 M36 的教训：变异没红与判据不承重长得一模一样，⛔ 别把半拉版本当证据。）
  #     ⚠️ 负对照取 `Q31`（点**另一格**换格）、`Q32`（宿主内再点一下）、`Q33`／`Q33b`
  #        （只挪光标那两条）——它们分别由别的通路承重，摘掉监听面不该影响它们。
  P37="$WORK/page-m37"; build_page "$P37" "$TARGET"
  echo "▶ M37：按下监听面不覆盖 <td>（格内空白拖不出选区）…" >&2
  apply_mutation "$P37/live/selection.js" \
    "    const dom = (hooks && hooks.hitArea) || view.dom;" \
    "    const dom = view.dom; /* 变异：监听面不覆盖 <td> */"
  apply_mutation "$P37/main.js" \
    "      hitArea: (isCell && el) ? el : null," \
    "      hitArea: null, /* 变异：不把 <td> 交出去 */"
  run_round "$P37" "$WORK/m37.json" "$WORK/m37.err"

  # M38（`bugs/0069`）：摘掉 `onLiveDocDown` 里"点中的就是**正在编辑的那一格** ⇒ 只挪光标、
  #     ⛔ 不重进"那道守卫（6 行）⇒ 按在 `<td>` 右边界外 8 px 的**死区**（`bugs/0066` 的 16 px
  #     几何容差里，目标元素是 `<table>` 本身）会被当成一次**新的进入**：
  #     `leave('switch')` 提交 ＋ 整篇重渲 ＋ 重新 `begin_edit` ＋ 换宿主。
  #     ⇒ 判据 `Q33b` 必须红。
  #     ⚠️ `Q33`（格内空白）仍绿：那一条在 `selection.js` 的 capture 监听器里就被接走了
  #        （`hitArea`），走不到这里 —— ⭐ 这正是"两层各有独立职责"的证据。
  #     ⚠️ 负对照取 `Q31`（点**另一格**必须重进）、`Q32`（宿主内再点一下）、`Q33`
  #        （格内空白只挪光标）：前两条证明这道守卫**没有**把"换格"一起吃掉。
  #        ⛔ `Q33c` **不作**负对照（2026-11-04 实测）：`Q33b` 红的表现就是"重进一次、换宿主"，
  #        而 `Q33c` 排在它后面、读的是原宿主 ⇒ 恒为 `-1..-1`，与 `hitArea` 无关；
  #        `hitArea` 的承重证据在 M37 那条（`Q33c` 必须红）。
  P38="$WORK/page-m38"; build_page "$P38" "$TARGET"
  echo "▶ M38：正在编辑的那一格的死区按下会重新进格…" >&2
  apply_mutation "$P38/main.js" \
    "      const act = typeof live.activeCell === 'function' ? live.activeCell() : null;
      if (act && act.blockIndex === index && act.flat === flat && live.isEditing()
        && typeof live.focusPoint === 'function') {
        live.focusPoint({ x: ev.clientX, y: ev.clientY });
        return;
      }" \
    "      /* 变异：摘掉「点的就是活动那一格 ⇒ 只挪光标」的守卫 */"
  run_round "$P38" "$WORK/m38.json" "$WORK/m38.err"

  # ── M39（**退役**，2026-11-08 `bugs/0099` §5.1）───────────────────────────────
  # 它原本把 `main.js::focusAt` 的 `mappingCoords` 判据与 `selection.js::snapClickX`
  # 一起摘掉，构造 `bugs/0084` 第三面修之前的形态，压 `Q34`（阅读态点格末字右半）。
  # ⚠️⚠️ 前提已被 `design/0061` L1 消灭：标记**恒定隐藏**、编辑态与阅读态逐行恒等
  #    （`Q36` 就是这件事）⇒ 坐标换算没有偏差可压 ⇒ 2026-11-05 实测 `m39.json`
  #    **400 条判据 0 红**，`Q34` 变异后仍绿。
  # ⇒ 已从执行段与 `变异判据` 名单移出；⛔ 别再按"它证明 `bugs/0084` 第三面"记。
  #    同族承重改由 M41（`Q35`/`Q36`）承担。留此注释只为解释为何编号断档。


  # M40（`bugs/0085`）：光标**不再夹回可见区**。
  #     格子 `.cm-rmd-cell` 是 `inline-block`（宽收缩到内容宽）＋ `overflow-x: clip`，
  #     行末光标的左边界正好压在裁剪盒右边界上 ⇒ 2 px 全被裁掉、屏幕上一根都看不见。
  #     ⇒ 判据 `Q34c`（行末光标剩余可见宽 ≥ 1 px）必须红。
  #     ⚠️ 负对照取 `Q34`（落点仍在格末）与 `Q34b`（左端的点不在格末）：这一条改的是**画**，
  #        ⛔ 不是落点 ⇒ 它们必须仍绿；红了说明变异碰到的不是画光标那一段。
  P40="$WORK/page-m40"; build_page "$P40" "$TARGET"
  echo "▶ M40：光标不夹回可见区（行末那 2 px 被格子裁掉）…" >&2
  apply_mutation "$P40/live/selection.js" \
    "        if (q.caret) left = 夹回可见区(left, 层宽, CARET_W);" \
    "        /* 变异：不夹回可见区（bugs/0085） */"
  run_round "$P40" "$WORK/m40.json" "$WORK/m40.err"

  # M41（`design/0061` §5 `INV-LIVE-14`）：把「活动行显示源码」打回来（＝本设计之前的规则 2）。
  #     进入编辑态时光标/选区所在行**不藏任何标记** ⇒ 屏幕上重新出现 `**`、反引号、`#`，
  #     行变宽、可能多折一行 ⇒ 块变高。
  #     ⇒ 判据 `Q35`（活动行也不许露源码）必红、`Q36`（进入前后逐视觉行相同）必红。
  #     ⚠️⚠️ 靶子打在**施加隐藏区间的那一步**（`decorations.js::createField::build` 的
  #        `plan.ranges` / `plan.fenceLines`），⛔ 不打 `activeLineIndexes` 函数体：
  #        L1 会把那个函数删掉或退化成恒 `[]` ⇒ 打在那里会 `HITS=0`，那是**假变异**。
  #        在施加点"按光标/选区所在行放行"复现的用户可见后果与旧形态逐点相同
  #        （`markers()` 里旧规则就是 `if (active[lineOf(from)]) return;`，按**起点行**放行）。
  #     ⚠️ 负对照取 `B0-4`（块自身 top 不动）/ `B0-5`（块外零位移，按块自身高度变化解释后）
  #        与 `D2`（组合期活动块只长高 ≤ 一行）：这条变异只改"藏不藏"，⛔ 不改块盒与外边距；
  #        `Q35b`（这一块源码里**确实**有标记）也必须仍绿，否则 Q35 的"红"不承重。
  P41="$WORK/page-m41"; build_page "$P41" "$TARGET"
  echo "▶ M41：活动行恢复显示源码（design/0061 之前的规则 2）…" >&2
  apply_mutation "$P41/live/decorations.js" \
    "      const decos = plan.ranges.map(function (r) {
        return hide.range(r.from, r.to);
      });" \
    "      /* 变异（M41）：活动行放行隐藏区间（＝ design/0061 之前的规则 2） */
      const __m41行 = (function (st) {
        const s = {};
        for (let i = 0; i < st.selection.ranges.length; i++) {
          const r = st.selection.ranges[i];
          const a = st.doc.lineAt(r.from).number;
          const b = st.doc.lineAt(r.to).number;
          for (let n = a; n <= b; n++) s[n - 1] = true;
        }
        return s;
      })(state);
      const __m41在活动行 = function (pos) {
        return __m41行[state.doc.lineAt(pos).number - 1] === true;
      };
      const decos = plan.ranges.filter(function (r) {
        return !__m41在活动行(r.from);
      }).map(function (r) {
        return hide.range(r.from, r.to);
      });"
  apply_mutation "$P41/live/decorations.js" \
    "      plan.fenceLines.forEach(function (f) {
        if (fenceHide) decos.push(fenceHide.range(f.from, f.to));
        else decos.push(lineDeco('cm-rmd-fence').range(f.from));
      });" \
    "      plan.fenceLines.forEach(function (f) {
        if (__m41在活动行(f.from)) return; /* 变异（M41）：活动行的围栏行也不塌 */
        if (fenceHide) decos.push(fenceHide.range(f.from, f.to));
        else decos.push(lineDeco('cm-rmd-fence').range(f.from));
      });"
  run_round "$P41" "$WORK/m41.json" "$WORK/m41.err"

  # M43（`bugs/0104` 用户复报，2026-11-06）：跨格**方向反了**（↓ 传成 ↑ 的语义）。
  #     产品形态的旧缺陷是"模块级函数直接摸 `makeLiveView` 闭包里的 `view`"⇒ 按一下就
  #     `ReferenceError`（WKWebView 栈里连消息都没有）⇒ 全局 `error` ⇒ `reportFatal`。
  #     但那条修法**没法用一条变异稳定表达**（把 `view` 参数删掉会让整页抛，
  #     所有判据一起红，等于不承重）⇒ 这里钉**可判的那一半**：方向真的按 ↓/↑ 传。
  #     ⇒ 判据 `Q37`（末视觉行按 ↓ 进下一行同一列）必须红。
  #     ⚠️ 覆盖范围只到 `Q37`（↓）：`Q38`（←）/`Q39`（→）根本不经过这个函数，而 `Q40`（↑）
  #        在"方向恒为 ↑"下**依旧落在上一行** ⇒ 这三条**不由本变异承重**；它们暂时没有
  #        专属变异（理由与缺口写在 harness 的 `Q38`–`Q40` 那段注释里，⛔ 不另造跑不动的变异段）。
  #     ⚠️ 负对照取 `Q22`（格内 ↑/↓ 走视觉行）：这条变异改的是**跨格方向**，
  #        ⛔ 不改格内移动；Q22 红了说明变异碰到的不是跨格那一段。
  P43="$WORK/page-m43"; build_page "$P43" "$TARGET"
  echo "▶ M43：↓ 传成 ↑（跨格方向反了）…" >&2
  apply_mutation "$P43/main.js" \
    "          crossCellVertical(view, cmd === 'lineDown');" \
    "          crossCellVertical(view, false); /* 变异（M43）：跨格方向反了 */"
  run_round "$P43" "$WORK/m43.json" "$WORK/m43.err"

  # M44（`bugs/0108` 用户报告，2026-11-07）：行尾回车**不再续列表标记**
  #     （`lineBreakAction` 的第一道闸恒过 ⇒ 一律裸 `\n`；`\n- ` / `\n> - ` / 编号 +1 /
  #       任务空框全没了 ⇒ 新行退成正文）。
  #     ⚠️ 这一轮明跑 `tasks`：全场任务项最密集、W 段选中的块里必有列表项的夹具
  #       （判据 `W7`/`W7b`/`W7d` 都由它承重）⇒ 连带 `变异判据` 指
  #       `基线键={"W7": "tasks/W7", …}`——基线表里那份夹具的判据带夹具前缀。
  #     ⚠️ 负对照取 `W1`/`W2`/`W6`：这条变异只改**行尾回车**那一条路，⛔ 不改
  #       `⌘↵` 新起一段与收尾撤销；它们红了说明变异碰到的不是续标记那一段。
  P44="$WORK/page-m44"; build_page "$P44" tasks
  echo "▶ M44：行尾回车不再续列表标记…" >&2
  apply_mutation "$P44/live/input.js" \
    "    if (from !== to) return out;" \
    "    if (true) return out; /* 变异（M44）：行尾回车一律裸 \\n（不再续标记） */"
  run_round "$P44" "$WORK/m44.json" "$WORK/m44.err"

  # M45（`bugs/0110` 用户报告，2026-11-07）：**行中**回车退回裸换行
  #     （＝恢复 `bugs/0108` 修复前的语义：只有行尾才续标记）⇒ 在**已写好的**列表项
  #     正文中间按回车，新行退成正文 ⇒ 判据 `W9` 必须红。
  #     ⚠️ 负对照取 `W7`/`W7b`：这条变异⛔ 不改行尾那条路，它们红了说明变异碰到的
  #       不是"行中"那一段。⚠️ 与 W9 同夹具（`tasks`），基线键带夹具前缀。
  #     ⚠️⚠️ 变异形态是**在列表判定之后补回旧守卫**，不是把列表判定整个短路
  #        （那样连行尾一起红，等于 M44 的重复，不承重行中这一半）。
  #     ⚠️ 2026-11-12 换代：旧的 `if (!是列表项) return out;` 已被引用行分支
  #        （`bugs/0111` A1，`if (!是列表项) { … }`）取代 ⇒ 靶子改到那道闸的**左花括号行**，
  #        在它之前补"行中即裸 `\n`"的旧守卫（非列表行本来就是裸 `\n`，不受影响）。
  P45="$WORK/page-m45"; build_page "$P45" tasks
  echo "▶ M45：行中回车退回裸换行（不再续标记）…" >&2
  apply_mutation "$P45/live/input.js" \
    "    if (!是列表项) {" \
    "    for (let i = from; i < lineEnd; i++) { const c = s.charCodeAt(i); if (c !== 32 && c !== 9) return { type: 'insert', data: '\\n', from: from, to: from }; } /* 变异（M45）：行中回车退回裸换行 */
    if (!是列表项) {"
  run_round "$P45" "$WORK/m45.json" "$WORK/m45.err"

  # M46（`bugs/0109` 用户报告，2026-11-07）：编辑态**列表缩进归零**
  #     （行装饰的缩进不再从 `--reader-list-indent` 乘以深度 ⇒ 正文左缘贴住行盒左缘，
  #       与阅读态 `<li>` 的缩进对不上）⇒ 判据 `W8` 必须红。
  #     ⚠️ 负对照取 `W7`/`W7b`：缩进对**新旧两行同时**生效，行间一致性不受影响
  #        ⇒ 它们红了说明变异碰到的不是"编辑态缩进"这个值。
  #     ⚠️ 2026-11-15 靶子换代（`design/0084`）：缩进从 `padding-left` 搬到 `margin-left`
  #        （UA 的 `::marker` 按边框盒定位），归零同样等于"正文贴住宿主左缘"。
  P46="$WORK/page-m46"; build_page "$P46" tasks
  echo "▶ M46：编辑态列表缩进归零…" >&2
  apply_mutation "$P46/live/decorations.js" \
    "        style: 'margin-left: ' + 几何.marginLeft," \
    "        style: 'margin-left: 0px', /* 变异（M46）：列表缩进归零 */"
  run_round "$P46" "$WORK/m46.json" "$WORK/m46.err"

  # M47（`bugs/0112 B4`，2026-11-08）：**引用块里的列表丢掉第一条缩进**
  #     （＝ `bugs/0112 B4` 修之前的产品形态：行级深度直接 `listStack.length`，
  #       看不见宿主搬的是引用块、内层 `<ul>` 的 `padding-left` 没人搬）。
  #     ⇒ 编辑态正文左缘比阅读态 `<li>` 左 28 px（14 px × `--reader-list-indent`）
  #     ⇒ 判据 `W8` 必须红。
  #     ⚠️ 变异轮跑 tasks（W 段挑中的正是引用块里的任务列表）；基线键带 `tasks/` 前缀。
  #     ⚠️ 负对照取 `W8t`（**顶层**列表——宿主搬的就是那个 `<ul>`，深度从 0 起是对的）
  #        与 `W7`/`W7b`（行间一致性不受第一条缩进影响）：它们红了说明变异碰到的
  #        不是"引用块里的列表缺一条缩进"这个面。
  #     ⚠️ `design/0065` P1（2026-11-10）起"补位规则"在 `src/live/geometry.js`，
  #        靶子随之搬过去（⛔ 不再有 `const 深 = listStack.length + 深基` 可打）；
  #        判据、期望的差值（28 px）与负对照都没变。
  P47="$WORK/page-m47"; build_page "$P47" tasks
  echo "▶ M47：引用块里的列表丢掉第一条缩进…" >&2
  apply_mutation "$P47/live/geometry.js" \
    "    const 补位 = 顶层即列表 ? (i.hostKind === 'box' ? 1 : 0) : 1;" \
    "    const 补位 = 顶层即列表 ? (i.hostKind === 'box' ? 1 : 0) : 0; /* 变异（M47）：丢掉宿主没搬的那一条列表缩进 */"
  run_round "$P47" "$WORK/m47.json" "$WORK/m47.err"

  # M48（`bugs/0090` 的探针侧等价 oracle，2026-11-08）：**引文空行的行高不再走段距**。
  #     `cm-rmd-quote-gap` 的 `line-height` 从 `--reader-gap-block`（14 px 下 15.4）
  #     改成一个**与段距不等**的固定值 ⇒ 编辑态那一行的高度不再等于阅读态
  #     "下一段 top − 上一段 bottom"。判据 `O-blockquote-1/3/4/5/5b/5c` 的
  #     "quote-gap 行盒高 == 阅读态段距"必须红——它们此前就是被这条行高骗红的。
  #     ⚠️ 变异轮跑 blankmd（引用块里夹一段 `>` 空行，O 段会挨个动作量到它）。
  #     ⚠️ 负对照取 `O-p-1`（普通段落块，压根没有 quote-gap 行）：它红了说明变异
  #        碰到的不是"引文空行"这个品种。
  P48="$WORK/page-m48"; build_page "$P48" blankmd
  echo "▶ M48：引文空行的行高不再走段距…" >&2
  apply_mutation "$P48/styles/live.css" \
    "  line-height: var(--reader-gap-block);" \
    "  line-height: 20px; /* 变异（M48）：引文空行不再承载段距 */"
  run_round "$P48" "$WORK/m48.json" "$WORK/m48.err"

  # M49（`bugs/0102` 的探针侧等价 oracle，2026-11-08）：**列表续行的行首缩进不再藏**。
  #     摘掉 `decorations.js` 里续行补深度时的那句 `raw.push({ from: 首, to: i })`
  #     ⇒ 编辑态续行保留源码里的两个空格（`white-space: pre-wrap`），而阅读态
  #     `<li>` 由内容列定起点、行首空白被 HTML 折叠 ⇒ 逐字 oracle 多出两个空格。
  #     判据 `B2-3c`（标记藏完后的可见文本逐字对齐独立 oracle）必须红。
  #     ⚠️ 变异轮跑 tasks（B2 是带续行的列表块）；基线键带 `tasks/` 前缀。
  #     ⚠️ 负对照取 `B0-3c`（普通段落块，没有列表续行）：它红了说明变异碰到的
  #        不是"续行行首缩进"这个品种。
  P49="$WORK/page-m49"; build_page "$P49" tasks
  echo "▶ M49：列表续行的行首缩进不再藏…" >&2
  apply_mutation "$P49/live/decorations.js" \
    "        raw.push({ from: 首, to: i, prefix: 1 });" \
    "        /* 变异（M49）：续行行首缩进不藏（bugs/0102 之前的产品形态） */"
  run_round "$P49" "$WORK/m49.json" "$WORK/m49.err"

  # M50（⭐ 2026-11-09「最高体验」标准的**承重变异**）：**围栏行不再塌成 0 高**。
  #     `design/0052` U5 之后围栏行在非活动时 `font-size:0 / line-height:0` 整行塌掉；
  #     把 `line-height` 改回一个**真实行高**，就是 `bugs/0023`／`bugs/0298` 那一族的产品形态：
  #     进入代码块时上下两条 ``` 各占一整行 ⇒ 块长高（`B11-3a`）＋ 下游整体下移（`B11-5`）。
  #     ⭐ 这条变异存在的唯一目的，是证明 **2026-11-09 收紧后的 ΔH ≤ 0.5 px 判据真的会咬人**
  #     ——此前 `B*-3a` 只判"长高只记账"，改红之后没有任何一条变异打红过它。
  #     ⚠️ 变异轮跑主夹具（`blocks`，`B11` 就是 ```rust 那个代码块）。
  #     ⚠️ 负对照取 `T2`/`T3`：`T` 段量的是**普通块**贴下沿进入，围栏塌行与它无关；
  #        它们要是红了，说明这条变异污染的是"位置"而不是「围栏行」这个品种。
  #     ⚠️⚠️ **2026-11-12 换靶（`bugs/0298` 候选 1b）**：围栏行改由
  #     `Decoration.replace({block:true, widget})` 的 block widget 承载（widget 里那个
  #     `.cm-rmd-fence-block` 才负责塌高），`.cm-line.cm-rmd-fence` 那条规则**已经管不到
  #     围栏行** ⇒ 旧靶 `HITS=1` 但 0 红（实测 B11-3a/B11-5 变异后仍绿，反倒是
  #     O-blockquote-3/-5b 被污染）——那是**假变异**。⇒ 靶子改到 widget 自己的
  #     `height: 0`：把它改成真实行高，就是"围栏行各占一整行"的产品缺陷形态。 */
  P50="$WORK/page-m50"; build_page "$P50" "$TARGET"
  echo "▶ M50：围栏行不再塌成 0 高（ΔH ≤ 0.5 判据的承重变异）…" >&2
  apply_mutation "$P50/styles/live.css" \
    ".cm-rmd-liveHost .cm-rmd-fence-block {
  height: 0;" \
    ".cm-rmd-liveHost .cm-rmd-fence-block {
  height: 20.297px; /* 变异（M50）：围栏行不再塌高（bugs/0023／0298 的产品形态） */"
  run_round "$P50" "$WORK/m50.json" "$WORK/m50.err"

  # M51（`bugs/0300` 用户报告，2026-11-09）：**任务框 widget 回到 `side: 1`**（＝缺陷形态）。
  #     方框与光标同在正文起点，`side` 决定同一点上光标画在 widget 左边还是右边；
  #     `side: 1` 时插入符画在方框**左缘**（离屏实测：caret.left == wrap.left，方框在它
  #     右边 22 px）⇒ 用户看到的正是「Enter 之后，光标处于 todo 框的前面」。
  #     ⇒ 判据 `W7e`/`W7h` 必须红（两条都断言"画出的插入符在方框右缘之后"）。
  #     ⚠️ `W7f` 在 `side: 1` 下**仍绿**（离屏实测：键入的字在两种 side 下都渲染在方框
  #        右缘之后，字节也相同）⇒ 它不列为这一轮的靶子，承重证据见 M52。
  #     ⚠️ 变异轮跑 `tasks`（W 段挑中的任务列表在它里面）；基线键带 `tasks/` 前缀。
  #     ⚠️ 负对照取 `W7`/`W7b`/`W7d`：这条变异只改**光标与方框的左右关系**，
  #        ⛔ 不改续标记的字节、品种、主机与方框存在性；它们红了说明变异碰到的不是
  #        "widget 的 side"这个面。
  P51="$WORK/page-m51"; build_page "$P51" tasks
  echo "▶ M51：任务框 widget 回到 side: 1（光标画在方框左缘）…" >&2
  apply_mutation "$P51/live/decorations.js" \
    "          decos.push(CM6.Decoration.widget({ widget: taskWidget(t.checked), side: -1 }).range(t.pos));" \
    "          decos.push(CM6.Decoration.widget({ widget: taskWidget(t.checked), side: 1 }).range(t.pos)); /* 变异（M51）：光标画在方框左缘（bugs/0300） */"
  run_round "$P51" "$WORK/m51.json" "$WORK/m51.err"

  # M52（`bugs/0300` §6 的落点变异，2026-11-09）：事务出口把光标放回**插入起点**
  #     （`from + insert.length` → `from + 0`）⇒ 回车之后光标停在 `\n` 前/行首附近，
  #     新行正文起点断言与"立刻敲字"的字节断言都必须红。
  #     ⚠️ 这条变异改的是**所有**事务的落点，红面很宽；负对照仍取 `W7`/`W7b`/`W7d`
  #        （它们只读主机/品种/字节/方框存在性，不读光标）。
  #     ⚠️ 2026-11-12 换代：落点不再是内联的 `from + insert.length`，而由
  #        `selection.js::caretAfterInsert` 给出（`bugs/0313`）⇒ 靶子改到那次 dispatch 的
  #        `selection: { anchor: caret },`，变异成 `anchor: from`（＝插入起点）。
  P52="$WORK/page-m52"; build_page "$P52" tasks
  echo "▶ M52：事务落点退成插入起点（from + 0）…" >&2
  apply_mutation "$P52/main.js" \
    "        selection: { anchor: caret }," \
    "        selection: { anchor: from }, /* 变异（M52）：落点退成插入起点（bugs/0300 §6） */"
  run_round "$P52" "$WORK/m52.json" "$WORK/m52.err"

  # M53（`bugs/0300` 现象二，2026-11-09 用户裁定）：`lineBreakAction` 不再把**源码续行**
  #     认成所属列表项（＝改回"续行回车是裸 `\\n`"的旧语义）⇒ 判据 `W10` 必须红。
  #     ⚠️ 靶子打在**续行回溯那一段的入口条件**上（`if (li && li.kind === 'plain' …)` 前加
  #        `false &&`），⛔ 不打 `项 = r;`——那行在 while 里、命中次数不唯一。
  #     ⚠️ 变异轮跑 **wraptasks**（唯一含"源码续行"的夹具），⛔ 不是主夹具；
  #        负对照取 W7/W7b/W9/W8b（它们走的都是**真列表项行**，与续行回溯无关）。
  P53="$WORK/page-m53"; build_page "$P53" wraptasks
  echo "▶ M53：源码续行回车退回裸换行…" >&2
  apply_mutation "$P53/live/input.js" \
    "    if (li && li.kind === 'plain' && li.code !== true && list) {" \
    "    if (false && li && li.kind === 'plain' && li.code !== true && list) { /* 变异（M53）：续行不再继承所属项（bugs/0300 现象二） */"
  run_round "$P53" "$WORK/m53.json" "$WORK/m53.err"

  # M54（`bugs/0302`）：把阅读态任务项首行的 `word-break: break-all` 那条规则停掉
  #     （2026-11-09 起是**一条**选择器，紧凑项与松散项共用，见 `typography.css` 注释）
  #     ⇒ 超宽首词整段掉到第二行、方框独占首行（用户截图里的形态）
  #     ⇒ 判据 `W11r`（紧凑）与 `W11p`（松散）**都必须红**。
  #     ⚠️ 编辑态那半**不在这条变异的射程里**：`live.css` 里另有一条
  #        `.cm-line[data-rmd-li="task"]::first-line { word-break: break-all }`，M54 不碰它
  #        ⇒ `W11l` 必须**仍绿**，它是**负对照**（证明两态各有一条规则、互不代偿），
  #        ⛔ 不写成"也必须红"。编辑态那条的承重变异是 `M56`。
  #        ⚠️⚠️ 2026-11-09 初版这里曾写"编辑态没有对应规则、`anywhere` 本来就允许劈词"
  #        ——**那是错的**（`bugs/0302` §3.3）：方框后的空格是断行点，`anywhere` 不拆词。
  #     ⚠️ 变异轮跑 **wraptasks**（紧凑项与松散项都在）；负对照取 `W10`（续行回车，与断行无关）。
  P54="$WORK/page-m54"; build_page "$P54" wraptasks
  echo "▶ M54：任务项首行不再允许词内断行…" >&2
  apply_mutation "$P54/styles/typography.css" \
    ".doc li.task-list-item::first-line { word-break: break-all; }" \
    ".doc li.task-list-item::first-line { word-break: normal; } /* 变异（M54） */"
  run_round "$P54" "$WORK/m54.json" "$WORK/m54.err"

  # ── M55（**已退役**，2026-11-09）───────────────────────────────────────────────────
  # 它原来打的是第二条选择器 `.doc li.task-list-item > p:first-of-type::first-line`
  # （"松散项那一半"）。`render.rs` 把方框写进首段**内部**之后，`<li>` 自己不再有行盒，
  # WebKit 把 `li::first-line` 落到首个子块的首行 ⇒ 第二条选择器**冗余**，M55 失去靶子。
  # ⭐ 证据（2026-11-09 实测）：把 `typography.css` 换成**只有一条**选择器之后跑
  #    `make probe-live-block ARGS="--only=wraptasks --no-mutate"`，`W11p` **仍然通过**，
  #    几何逐点相同（方框顶 774.83 / 首字顶 772.66，行高 21.42）。
  #    同一轮 M55 的判据输出正是 `变异新增红 = []`（"⚠️ 变异失效"）。
  # ⇒ ⛔ 不保留"有变异、无承重判据"的假变异；阅读态的承重证据由 `M54` 单独承担，
  #    而"紧凑／松散两种形态都覆盖"由判据 `W11r`／`W11p` 各自负责。

  # M56（`bugs/0302` **编辑态那一半**）：只把 `live.css` 里任务行首行的 `word-break: break-all`
  #     停掉（阅读态那条原样保留）⇒ `W11l` 必须红，而 `W11r`／`W11p`（阅读态）与 `W10`
  #     （续行回车）必须**仍绿**——它们证明变异碰到的确实是「编辑态首行断行」这个面。
  #     ⚠️ 靶子打在**整条规则**（选择器 ＋ 声明）上，⛔ 不打 `break-all` 字面：那个词在
  #        `typography.css` 里还出现，而变异只该动一份文件；打整条也顺带守住"规则没被改名"。
  P56="$WORK/page-m56"; build_page "$P56" wraptasks
  echo "▶ M56：编辑态任务行首行不再允许词内断行…" >&2
  apply_mutation "$P56/styles/live.css" \
    ".cm-rmd-liveHost .cm-line[data-rmd-li=\"task\"]::first-line {
  word-break: break-all;
}" \
    ".cm-rmd-liveHost .cm-line[data-rmd-li=\"task\"]::first-line {
  word-break: normal; /* 变异（M56）：编辑态首行不许词内断行（bugs/0302 §6） */
}"
  run_round "$P56" "$WORK/m56.json" "$WORK/m56.err"

  # M57（`bugs/0303` 行内上标的行盒）：把 `typography.css` 的 `.doc sup { … line-height: 0 }`
  #     退回**只有字号**那一句（＝修之前的形态）⇒ 抬高后的行内盒超出本行 strut，
  #     带脚注引用的那条视觉行从 23.80 涨到 27.73 px ⇒ `S1`（行距相同）必须红。
  #     ⚠️ 同一处缺陷的第二面是 `B*-3a`（该可编辑块在编辑态**矮 3.94 px**）——它也会红，
  #        ⛔ 别当成两条独立证据（那是"阅读态行盒"与"两态等高"的同一件事）。
  #     ⚠️ 变异轮跑 **wraptasks**（唯一带 `[^…]` 的夹具）；基线键带 `wraptasks/` 前缀。
  #     ⚠️ 负对照取 `W11r`／`W10`（断行与续行，与上标无关）与 `S-覆盖` 之外那些**阅读态**
  #        判据——它们红了说明变异碰到的不是"上标的行盒"这个面。
  P57="$WORK/page-m57"; build_page "$P57" wraptasks
  # ⚠️ 用单引号：双引号里的反引号会被当成命令替换（`bash -n` 就能抓到）。
  echo '▶ M57：`<sup>` 的行内盒重新参与行盒高度…' >&2
  apply_mutation "$P57/styles/typography.css" \
    ".doc sup { font-size: var(--reader-size-small); line-height: 0; }" \
    ".doc sup { font-size: var(--reader-size-small); } /* 变异（M57）：行内盒重新撑高行盒（bugs/0303） */"
  run_round "$P57" "$WORK/m57.json" "$WORK/m57.err"

  # M58（`design/0065` P1 §2.3 变异 ②，2026-11-10）：**补位恒为 1**
  #     （`live/geometry.js::listGeometry` 的 `顶层即列表 ? … : 1` 改成无条件 `1`）
  #     ⇒ 宿主搬的就是那个 `<ul>` 的顶层列表也被再补一条缩进，编辑态 28 + 28 = 56 px
  #        （`bugs/0113` C1 那个"多缩进"的形态）⇒ `W8t`（顶层列表两态正文左缘）必须红。
  #     ⚠️ 变异轮跑 tasks（`W8t` 量的是这份夹具里第一份顶层列表）；基线键带 `tasks/` 前缀。
  #     ⚠️ 负对照取 `W8`（引用块里的列表：那一支本来就是 1，变异不动它）与 `W7`/`W7b`
  #        （行间一致性不受第一条缩进影响）：它们红了说明变异碰到的不是"顶层列表的补位"。
  P58="$WORK/page-m58"; build_page "$P58" tasks
  echo "▶ M58：列表补位恒为 1（顶层列表多缩进一条）…" >&2
  apply_mutation "$P58/live/geometry.js" \
    "    const 补位 = 顶层即列表 ? (i.hostKind === 'box' ? 1 : 0) : 1;" \
    "    const 补位 = 1; /* 变异（M58）：补位恒 1 ⇒ 真 <ul> 宿主 28+28（design/0065 P1 §2.3 ②） */"
  run_round "$P58" "$WORK/m58.json" "$WORK/m58.err"

  # M59（⭐ **2026-11-11 用户裁定**「插入光标也零格式变化」，`vision/0001` §2.1）：把
  #     「活动行显示源码」**连同它的响应性**一起打回——这是 `design/0061` L1 之前的规则 2，
  #     只是触发条件从"进入编辑"扩到"光标走到哪一行"。
  #     ⚠️⚠️ **为什么不能复用 M41**：M41 只改「施加隐藏区间」那一步，而 `createField.update`
  #        只在 `tr.docChanged`（或语法树换对象）时重算 ⇒ 光标移动**根本不触发重建**，
  #        实测 2026-11-11 `--only=blocks` 全量变异：M41 的新增红里**没有** `B0-10`
  #        ⇒ 那时 `B*-10` 一条承重变异都没有。本条在两个点同时改：
  #        ① `update` 把 `tr.selection` 也算成重算条件（恢复选区响应性）；
  #        ② 隐藏区间 / 围栏塌行按**光标或选区所在行**放行（与 M41 同义）。
  #     合起来的用户可见后果：**光标移到哪一行，哪一行的 `**` / `#` / 反引号就露出来**，
  #     行变宽甚至多折一行、围栏行撑回整行 ⇒ 行顶与行高逐项变化 —— 正是 `B{i}-10` 要抓的形态。
  #     ⇒ 判据 `B5-10` / `B7-10` / `B11-10`（光标移动零位移）必须红。
  #     ⚠️ **`B0-10` 不红，而且这是对的**（2026-11-11 首跑实测后改的口径）：`B{i}-10` 只在
  #        **一个块内**走位 ⇒ 单行块（`B0` 是 H1）进入编辑时光标已经在那一行，活动行源码在
  #        **基线**里就露着，变异不改变任何可见文本。有区分力的只有**多行块**。
  #     ⚠️ 它**同时**会让 `Q35` / `Q36` 红（进入那一帧光标就在第一行）——
  #        ⛔ 别当成两条独立证据，那是同一处"标记可见性"的两个面。
  #     ⚠️ 负对照取 `B0-4`（块自身 top 不动）/ `B0-6`（滚动量不变）：本条只改"藏不藏"，
  #        ⛔ 不改块盒与外边距 ⇒ 它们必须仍绿。
  #     ⚠️ 变异轮跑 `$TARGET`（＝全形状主夹具 `blocks`，`B5`/`B7`/`B11` 都在）；基线键不带前缀。
  P59="$WORK/page-m59"; build_page "$P59" "$TARGET"
  echo "▶ M59：光标走到哪一行，哪一行就露源码（＝选区驱动的活动行）…" >&2
  apply_mutation "$P59/live/decorations.js" \
    "        if (tr.docChanged) return build(tr.state, 10);" \
    "        if (tr.docChanged || tr.selection) return build(tr.state, 10); /* 变异（M59）：选区变化也重算（＝ L1 之前） */"
  apply_mutation "$P59/live/decorations.js" \
    "      const decos = plan.ranges.map(function (r) {
        return hide.range(r.from, r.to);
      });" \
    "      /* 变异（M59）：活动行放行隐藏区间（＝ design/0061 之前的规则 2） */
      const __m59行 = (function (st) {
        const s = {};
        for (let i = 0; i < st.selection.ranges.length; i++) {
          const r = st.selection.ranges[i];
          const a = st.doc.lineAt(r.from).number;
          const b = st.doc.lineAt(r.to).number;
          for (let n = a; n <= b; n++) s[n - 1] = true;
        }
        return s;
      })(state);
      const __m59在活动行 = function (pos) {
        return __m59行[state.doc.lineAt(pos).number - 1] === true;
      };
      const decos = plan.ranges.filter(function (r) {
        return !__m59在活动行(r.from);
      }).map(function (r) {
        return hide.range(r.from, r.to);
      });"
  apply_mutation "$P59/live/decorations.js" \
    "      plan.fenceLines.forEach(function (f) {
        if (fenceHide) decos.push(fenceHide.range(f.from, f.to));
        else decos.push(lineDeco('cm-rmd-fence').range(f.from));
      });" \
    "      plan.fenceLines.forEach(function (f) {
        if (__m59在活动行(f.from)) return; /* 变异（M59）：活动行的围栏行也不塌 */
        if (fenceHide) decos.push(fenceHide.range(f.from, f.to));
        else decos.push(lineDeco('cm-rmd-fence').range(f.from));
      });"
  run_round "$P59" "$WORK/m59.json" "$WORK/m59.err"

  # M60（2026-11-11 用户要求「自己执行多输入测试」的承重证据）：**空列表项回车不再退列表**
  #     （`live/input.js::lineBreakAction` 的"删标记"那一支恒不成立）。
  #     ⇒ 空项上回车只会续出一个新标记（`- ` / `2. ` / `- [ ] `），而不是把标记删掉、
  #       让正文回到上一行行尾 ⇒ `U3`（空项再回车删标记退列表）必须红。
  #     ⚠️⚠️ **为什么必须用 U3 而不是某条单步判据**：单步判据（`W7d` 续框、`B*-3a` 几何……）
  #        在"续出标记"和"删标记"两条路上都可能绿；只有"回车前后**全文**"这一比才分得开。
  #     ⚠️ 变异轮跑 tasks（无序／有序／任务三种列表行都在这一份里）；基线键带 `tasks/` 前缀。
  #     ⚠️ 负对照取 `U2-task`（非空项续标记，走的是另一支）与 `U1-task`（行尾逐字键入）：
  #        它们必须仍绿；红了说明变异碰到的不是"空项退出"这一个面。
  P60="$WORK/page-m60"; build_page "$P60" tasks
  echo "▶ M60：空列表项回车不再删标记（空项退列表失效）…" >&2
  apply_mutation "$P60/live/input.js" \
    "    if (项 === li && s.slice(li.contentFrom, lineEnd) === '') {" \
    "    if (false) { /* 变异（M60）：空项也走续标记那一支 ⇒ 退不出列表（判据 U3） */"
  run_round "$P60" "$WORK/m60.json" "$WORK/m60.err"

  # M61（同一天的承重证据之二）：**有序项续出的编号不前进**（`+ 1` → `+ 0`）。
  #     ⇒ 回车之后新行的标记仍是原编号 ⇒ `U2-ordered`（回车续项，逐字比全文）必须红。
  #     ⚠️ 若 `W7` 选中的块恰好是有序项，`W7c` 也会红——那是同一处机制的第二面，
  #        ⛔ 别当独立证据；这里只钉 `U2-ordered`，`W7c` 留作旁证。
  #     ⚠️ 负对照取 `U2-bullet` / `U2-task`（续标记那两支不数编号）：必须仍绿。
  #     ⚠️⚠️ **2026-11-12 换靶**：编号只有一份来源之后（`bugs/0111` A3 / `bugs/0315`），
  #     新 plan 走 `项.number + 1`，`parseInt` 那条只剩"旧 plan 缺 `number`"的兜底；
  #     `tasks` 夹具走的是新路 ⇒ 只改兜底是 `HITS=1` 但 0 红的**假变异**（实测
  #     `U2-ordered` 变异后仍绿）。⇒ 两处**同一次变异一起改**，哪条路被走到都生效。
  P61="$WORK/page-m61"; build_page "$P61" tasks
  echo "▶ M61：有序项回车续出的编号不前进（恒为原编号）…" >&2
  apply_mutation "$P61/live/input.js" \
    "        const 下一 = 项.number + 1;" \
    "        const 下一 = 项.number + 0; /* 变异（M61）：编号不 +1 */"
  apply_mutation "$P61/live/input.js" \
    "        return String(parseInt(num, 10) + 1) + punct + ws;" \
    "        return String(parseInt(num, 10) + 0) + punct + ws; /* 变异（M61）：旧 plan 兜底同样不 +1 */"
  run_round "$P61" "$WORK/m61.json" "$WORK/m61.err"

  # ── M62–M66（2026-11-12）：本轮八条修复里此前**没有承重变异**的五条 ───────────────
  # ⚠️ 按 `.claude/rules/tests.md`「没做过变异测试的断言不算数」：0298（M50）／0313（M52）／
  #    0315（M61）已有，剩下 0304／0316／0317／0314／0111-A6 的判据此前只是"实测绿"。
  #    这几条变异都打**修之前的产品形态**，跑在能产出对应判据的夹具上。

  # M62（`bugs/0304`）：`markers()` 的 `zwRanges` 退回空 ⇒ 行内代码反引号重新走
  #     `Decoration.replace`（零宽 + `cm-widgetBuffer`），「（」之后又能断行 ⇒
  #     `edges` 的说明段整段矮一行。判据 `B5-3a`（块高）与 `B5-5`（块外位移）必须红。
  #     ⚠️ 负对照取 `B0-3a`（标题块，没有行内代码）与 `K1`（回车落点，与折行无关）。
  P62="$WORK/page-m62"; build_page "$P62" edges
  echo "▶ M62：行内代码反引号退回零宽替换（`bugs/0304` 的缺陷形态）…" >&2
  apply_mutation "$P62/live/decorations.js" \
    "      const zwRanges = Array.isArray(plan.zwRanges) ? plan.zwRanges : [];" \
    "      const zwRanges = []; /* 变异（M62）：反引号退回零宽替换（bugs/0304 修之前） */"
  run_round "$P62" "$WORK/m62.json" "$WORK/m62.err"

  # M63（`bugs/0316`）：`pre-wrap` 改回 CM6 的 `break-spaces`（修之前的形态）⇒
  #     折行点上的空格计入行宽、整段错后一个字。判据 `reflow/Q36` 必须红。
  #     ⚠️ 负对照取 `Q35`（标记隐藏与首视觉行文本，与空白模型无关）。
  P63="$WORK/page-m63"; build_page "$P63" reflow
  echo "▶ M63：白空格模型退回 break-spaces（`bugs/0316` 的缺陷形态）…" >&2
  apply_mutation "$P63/styles/live.css" \
    ".cm-rmd-liveHost .cm-content.cm-lineWrapping {
  white-space: pre-wrap;" \
    ".cm-rmd-liveHost .cm-content.cm-lineWrapping {
  white-space: break-spaces; /* 变异（M63）：退回 bugs/0316 修之前的折行模型 */"
  run_round "$P63" "$WORK/m63.json" "$WORK/m63.err"

  # M64（`bugs/0317`）：`legalHiddenMapped` 退回合并后的区间（修之前）⇒ 相邻隐藏区间
  #     之间的边界被抹掉，连续输入时第二个字落到反引号之后。判据 `O-ol-4` / `O-ol-5c`
  #     必须红。⚠️ 负对照取 `U2-ordered`（回车续编号，不经过落点映射）。
  #     ⚠️⚠️ **只在 `PROBE_W=760` 档施加**：`bugs/0317` §2 实测该路径在默认 1000 宽
  #     跑不到（`tasks` 的那一行在 1000 下不折行 ⇒ 光标不贴反引号）⇒ 1000 档施加会得到
  #     `HITS=1`、`变异新增红 = []` 的**假变异**（2026-11-12 实测）。
  if [ "${PROBE_W:-1000}" = "760" ]; then
    P64="$WORK/page-m64"; build_page "$P64" tasks
    echo "▶ M64：落点映射退回合并区间（`bugs/0317` 的缺陷形态，760 档）…" >&2
    apply_mutation "$P64/live/selection.js" \
      "    const src = plan && plan.rawRanges ? plan.rawRanges : hiddenOfPlan(plan);" \
      "    const src = hiddenOfPlan(plan); /* 变异（M64）：映射退回合并后的区间（bugs/0317 修之前） */"
    run_round "$P64" "$WORK/m64.json" "$WORK/m64.err"
  fi

  # M65（`bugs/0314`）：`lineBreakAction` 的 ④′ 分支条件恒假 ⇒ 续行行首回车重新写前缀、
  #     留下只有空白的幻行。判据 `edges/K5a` 必须红。
  #     ⚠️ 负对照取 `K4`（引用内空项回车，另一支）与 `K1`（标题行首回车）。
  P65="$WORK/page-m65"; build_page "$P65" edges
  echo "▶ M65：续行行首不再走裸换行（`bugs/0314` 的缺陷形态）…" >&2
  apply_mutation "$P65/live/input.js" \
    "    if (li && li.kind === 'plain' && li.code !== true
        && typeof li.contentFrom === 'number' && from <= li.contentFrom) {" \
    "    if (li && li.kind === 'plain' && li.code !== true
        && typeof li.contentFrom === 'number' && from < 0) { /* 变异（M65）：④′ 失效（bugs/0314 修之前） */"
  run_round "$P65" "$WORK/m65.json" "$WORK/m65.err"

  # M66（`bugs/0111` A6）：删除层不再拿到"块前缀"这两份数据（都退回 `null` ⇒ 回落隐藏集合）⇒
  #     `> - ` 与成对标记并成一条链，一次 ⌫ 删两层。判据 `edges/K3` 必须红。
  #     ⚠️ **两份都要摘**：K3 的"只退一层"走的是 `levels`（分层区间），只摘 `prefix` 时
  #        `K3` 仍绿（2026-11-12 实测：`变异新增红 = []`，是**假变异**）⇒ 与 M61 同一条纪律。
  #     ⚠️ 负对照取 `K4`／`K7`（都是回车路径，不经过删除层）。
  P66="$WORK/page-m66"; build_page "$P66" edges
  echo "▶ M66：删除层拿不到块前缀（`bugs/0111` A6 的缺陷形态）…" >&2
  apply_mutation "$P66/main.js" \
    "        prefix: LSel.prefixRanges(view, hiddenHook)," \
    "        prefix: null, /* 变异（M66）：块前缀退回与行内标记合并成一条链（bugs/0111 A6 修之前） */"
  apply_mutation "$P66/main.js" \
    "        levels: LSel.prefixLevels(view, hiddenHook)," \
    "        levels: null, /* 变异（M66）：分层前缀一并摘掉（K3 走的就是这一份） */"
  run_round "$P66" "$WORK/m66.json" "$WORK/m66.err"

  # M67（2026-11-14 用户报告）：组合串的 `side` 翻回 `1`（`bugs/0060` 到 2026-11-14 之间的形态）⇒
  #     组合串仍**行内、仍占版面、仍落在插入点上**，只有"自绘插入符画在串的哪一侧"变了：
  #     `side: 1` 让 caret.left == 串左缘，上屏后跳到串右缘（用户原话「内容在光标的后面，
  #     等按了 Enter 真正输入之后，光标变成在内容的后面，产生跳动」）。
  #     ⇒ 判据 `D3d`（插入符画在串之后）必须红。
  #     ⚠️ 负对照 `D3`/`D3b`/`D3c` 必须**仍绿**——它们证的是"行内 / 占版面 / 落在哪一格"，
  #        与"画在串的哪一侧"是两面（同 M33/M34 的分工，⛔ 别把一条当另一条的替代）。
  P67="$WORK/page-m67"; build_page "$P67" "$TARGET"
  echo "▶ M67：组合串 side 翻回 1（插入符画在串的左缘）…" >&2
  apply_mutation "$P67/live/preedit.js" \
    "side: -1 }).range(pos)" \
    "side: 1 }).range(pos) /* 变异（M67）：组合串画在光标右边（2026-11-14 用户报告的形态） */"
  run_round "$P67" "$WORK/m67.json" "$WORK/m67.err"

  # ── M68–M70（2026-11-16）：`design/0085` C5 / C4 / C2 的**离屏承重变异** ──────────
  # ⚠️ 按 `.claude/rules/tests.md`「没做过变异测试的断言不算数」：C5／C4 此前只有
  #    源码级闸门与纯逻辑判据，今天补的两条离屏判据（标题字色 / 嵌套引用文字左缘）
  #    各要一条能打红它的变异。

  # M68（C5）：去掉 `.cm-rmd-h1` 的 `color: var(--reader-heading)`（＝C5 修之前的形态）
  #     ⇒ 标题字色回落到继承的 `--reader-text`（比正文浅一档）。
  #     判据 `O-h1-1`（进入时逐行样式 ≡ 渲染态，含标题字色）必须红。
  #     ⚠️ 负对照 `B0-3a`：字色不影响几何，块高必须仍逐像素不变。
  P68="$WORK/page-m68"; build_page "$P68" shapes
  echo "▶ M68：标题规则去掉 color（C5 修之前的形态）…" >&2
  apply_mutation "$P68/styles/live.css" \
    ".cm-rmd-liveHost .cm-line.cm-rmd-h1 {
  color: var(--reader-heading);
  font-size: var(--reader-size-h1);" \
    ".cm-rmd-liveHost .cm-line.cm-rmd-h1 {
  font-size: var(--reader-size-h1); /* 变异（M68）：标题字色退回继承（C5 修之前） */"
  run_round "$P68" "$WORK/m68.json" "$WORK/m68.err"

  # M69（C4）：把第 2 层引用的 `padding-left` 少乘一层（`* 2` → `* 1`）
  #     ⇒ 第 2 层正文的文字左缘比阅读态少一个引用让位（≈17.5 px）。
  #     判据 `O-blockquote2-1`（含"嵌套引用文字左缘 == 阅读态"）必须红。
  #     ⚠️ 负对照 `O-blockquote-1`：那份引用块没有嵌套（层 1 不挂属性），必须仍绿。
  P69="$WORK/page-m69"; build_page "$P69" shapes
  echo "▶ M69：第 2 层引用的左内边距少乘一层（C4 盒子的退化形态）…" >&2
  apply_mutation "$P69/styles/live.css" \
    "  padding-left: calc(var(--reader-font-size) * var(--reader-quote-pad-x-factor) * 2);" \
    "  padding-left: calc(var(--reader-font-size) * var(--reader-quote-pad-x-factor) * 1); /* 变异（M69） */"
  run_round "$P69" "$WORK/m69.json" "$WORK/m69.err"

  # M70（C2）：`applyBox` 的写值退回 swap 时的 px 快照（`box[css]`），不再写成
  #     `calc(var(--reader-font-size) * k ± b)`（＝C2 修之前的形态）。
  #     ⇒ 根字号改了以后，已挂载的 host 与行仍停在旧 px，不跟 `--reader-font-size` 重解析。
  #     判据 `O-p-6b`（改根字号后已挂载的块跟着重解析）必须红。
  #     ⚠️ 负对照 `B0-3a`：14 px 下表达式与快照数值相等 ⇒ 块高必须仍逐像素不变。
  P70="$WORK/page-m70"; build_page "$P70" "$TARGET"
  echo "▶ M70：长度退回 swap 时的 px 快照（C2 修之前的形态）…" >&2
  apply_mutation "$P70/live/box.js" \
    "      const f = 系数 && 尺度[css] === true ? 系数[css] : null;" \
    "      const f = null; /* 变异（M70）：写裸 px 快照，不跟 --reader-font-size（C2 修之前） */"
  run_round "$P70" "$WORK/m70.json" "$WORK/m70.err"

  # ── M42（**挂起**：`design/0061` L2 的 `legalEdge`）─────────────────────────────────
  # 设计 §7 第 4 条要求：把 `selection.js::legalEdge` 停成恒等（`return pos`）⇒
  # 落点/删除判据必红。
  # ⚠️ 2026-11-05 17:19 该函数**已落地**（`src/live/selection.js:345`，导出见 1416 行；
  #    纯逻辑判据在 `tests/js/live-selection.test.js`）。
  # ⚠️⚠️ **2026-11-08 复核（`bugs/0099` §7）：仍然没有承重判据**——
  #    `Q34` 量的是点击换算（走 `legalNearest`，dir 0，不经过 `legalEdge`）；
  #    `D12–D16` / `Q22` / `Q37` 的落点都在**可见字节**上，指针本来就在合法边界
  #    ⇒ 恒等 `legalEdge` 结果逐点相同，一条都不会红。
  #    ⇒ 现在写 M42 只能是"有变异、无承重判据"的**假变异**，按用户口径 ⛔ 不写。
  # ⇒ **下一步**：先补一条真正踩 `snapPos(dir≠0)` / `deleteRange` 的判据——
  #    例如让光标/删除从**隐藏区间内部或其边界**出发（`design/0061` L2/L3 的落点与整段跨过），
  #    且在基线里断言它落到隐藏区间另一侧的可见位置；有了它再补 M42（靶串已验**恰好命中 1 次**）：
  #    ① 在下面加 `P42="$WORK/page-m42"; build_page …`；
  #    ② `apply_mutation "$P42/live/selection.js" \
  #         "  function legalEdge(hidden, pos, dir) {
  #            if (!Number.isInteger(pos)) return pos;" \
  #         "  function legalEdge(hidden, pos, dir) {
  #            return pos; /* 变异（M42）：停成恒等（design/0061 §7 第 4 条） */"`
  #       ⚠️ 必须带上函数签名那一行：`legalNearest` 里有一模一样的
  #       `if (!Number.isInteger(pos)) return pos;`，只匹配那一句会 HITS=5；
  #       再 `run_round "$P42" "$WORK/m42.json" "$WORK/m42.err"`；
  #    ③ 在 `变异判据` 那批末尾加 `M42`，必红判据按新判据的实际 id 填；
  #    ④ 同步第 6 行的计数与本文件头部的 M 名单。
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
# S 段（`bugs/0303` 行内上标的行盒）同理：只在**有被引用的脚注**的夹具上成立
S表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "S": (基线原始.get("摘要") or {}).get("S")}]
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
# U 段（2026-11-11 用户要求「自己执行多输入测试」）同理：只在**有可测列表行的可编辑块**上成立
U表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "U": (基线原始.get("摘要") or {}).get("U")}]
# K 段（2026-11-11 长任务：编辑边界多输入序列）同理：只在**真有那几种形状**的夹具上成立
#   （`edges.md` 专门造齐；其余夹具只记"不适用"，⛔ 不算通过）
K表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "K": (基线原始.get("摘要") or {}).get("K")}]
# W 段（`design/0052` U7 `⌘↵` 新起一段）同理：只在**可编辑、且后面还有正文**的夹具上成立
W表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "W": (基线原始.get("摘要") or {}).get("W")}]
# R 段（`bugs/0031` 鼠标拖选）同理：只在**有 ≥ 4 字符可编辑块**的夹具上成立
R表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "R": (基线原始.get("摘要") or {}).get("R")}]
# Y 段（`design/0061` §5 `INV-LIVE-14`：进编辑态不显示源码、不改变行几何）同理：
#   只在**首行带行内标记的可编辑块**的夹具上成立（没有标记 ⇒ Q35 的负对照不成立）
Y表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "Y": (基线原始.get("摘要") or {}).get("Y")}]
# T 段（`INV-LIVE-04` ①：块贴**视口下沿**时进入编辑）同理：只要有 ≥60 px 的可编辑块就
#   应当有 T 段读数；没有就由 `T-覆盖` 报缺（⛔ 别让"没跑"看起来像"通过"）。
T表 = [{"夹具": str(基线原始.get("文档") or "主夹具"),
        "T": (基线原始.get("摘要") or {}).get("T")}]
for path in sorted(glob.glob(os.path.join(work, "other", "*.json"))):
    name = os.path.splitext(os.path.basename(path))[0]
    try:
        原始 = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        检查.append({"id": "%s/A0" % name, "_键": "%s/A0" % name,
                     "名": "夹具 %s 起不来" % name, "结果": "失败",
                     "判据": "每份夹具都必须跑起来", "值": {"原因": str(e)}})
        continue
    if "致命" in 原始:
        检查.append({"id": "%s/A0" % name, "_键": "%s/A0" % name,
                     "名": "夹具 %s 起不来" % name, "结果": "失败",
                     "判据": "每份夹具都必须跑起来", "值": {"致命": 原始.get("致命")}})
        continue
    检查.extend(收集(原始, name + "/"))
    环境["其余夹具"].append({"名": name, "环境": 原始.get("环境")})
    G表.append({"夹具": name, "G": (原始.get("摘要") or {}).get("G")})
    L表.append({"夹具": name, "L": (原始.get("摘要") or {}).get("L")})
    N表.append({"夹具": name, "N": (原始.get("摘要") or {}).get("N")})
    S表.append({"夹具": name, "S": (原始.get("摘要") or {}).get("S")})
    O表.append({"夹具": name, "O": (原始.get("摘要") or {}).get("O")})
    P表.append({"夹具": name, "P": (原始.get("摘要") or {}).get("P")})
    Q表.append({"夹具": name, "Q": (原始.get("摘要") or {}).get("Q")})
    V表.append({"夹具": name, "V": (原始.get("摘要") or {}).get("V")})
    U表.append({"夹具": name, "U": (原始.get("摘要") or {}).get("U")})
    K表.append({"夹具": name, "K": (原始.get("摘要") or {}).get("K")})
    W表.append({"夹具": name, "W": (原始.get("摘要") or {}).get("W")})
    R表.append({"夹具": name, "R": (原始.get("摘要") or {}).get("R")})
    Y表.append({"夹具": name, "Y": (原始.get("摘要") or {}).get("Y")})
    T表.append({"夹具": name, "T": (原始.get("摘要") or {}).get("T")})

# ⚠️ 判据**必须逐条产出**：少一条 = 那条判据根本没跑（⛔ 别把"没产出"读成"通过"）。
有 = set(c.get("_键", "") for c in 检查)
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
# ⭐ 2026-11-02（`bugs/0060` 第二版：组合串改成**行内 widget**）新加的三条：
#    `D1c`（下游只跟着块高走）/ `D3c`（组合串落在插入点上）/ `D4c`（上屏后块高 ≤ 基线＋一行）。
#    ⚠️ 同一条口径：覆盖表少一条 ＝ "没产出也算通过"。
need += ["D1c", "D3c", "D4c"]
缺D = [x for x in need if x not in 有]
检查.append({
    "id": "D-覆盖", "名": "F6 整套判据都在（含删除五连）",
    "结果": "失败" if (缺D or F6 is None) else "通过",
    "判据": "D0–D11 ＋ D1b/D1c/D3c/D4b/D4c ＋ ⭐ D12–D16（敲字／⌫／⌦／⌘A＋⌫／⌘Z）必须逐条产出（跑在一段可编辑段落上）",
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

# ⚠️ S 段（`bugs/0303`：`<sup>` 把所在视觉行撑高 3.94 px）只在**有被引用的脚注**的夹具上成立。
#   ⇒ 与 `N-覆盖` / `G-覆盖` 同一条口径：至少一份夹具 `摘要.S.适用 === true`；
#     而**产出了就要逐条在**（`S1`），且 `摘要.S.量到 >= 1`——引用只落在单视觉行的块里时
#     没有"行距"可判，⛔ 不许把它读成通过（那等于"这份夹具没验也记绿"）。
#   ⚠️ `S-覆盖` 现在只有一份承重夹具：`tools/live-probe/fixtures/wraptasks.md`
#     （可编辑的任务项里带 `[^loose]`）。⛔ 别为了让 `S1` 变绿把引用挪回表格——
#     那样就绕开了"引用在**可编辑块**里"这条唯一能同时压住阅读态行距与编辑态块高的路径。
真的跑了S = [row["夹具"] for row in S表 if (row["S"] or {}).get("适用") is True]
S量到 = [(row["夹具"], (row["S"] or {}).get("量到") or 0) for row in S表
         if (row["S"] or {}).get("适用") is True]
S有行距 = [名 for 名, n in S量到 if isinstance(n, int) and n >= 1]
缺S = []
for row in S表:
    s = row["S"] or {}
    if s.get("适用") is not True:
        continue
    前缀 = "" if row["夹具"] == 主夹具名 else row["夹具"] + "/"
    if (前缀 + "S1") not in 有:
        缺S.append(前缀 + "S1")
检查.append({
    "id": "S-覆盖", "名": "本轮至少有一份夹具真的量了脚注引用所在块的行距（bugs/0303）",
    "结果": "通过" if (真的跑了S and S有行距 and not 缺S) else "失败",
    "判据": "至少一份夹具的 `摘要.S.适用 === true` 且 `摘要.S.量到 >= 1`（真有 ≥2 条视觉行的块），"
            "并有 `S1` 这一条判据——`tools/live-probe/fixtures/wraptasks.md` 的可编辑任务项里"
            "带 `[^loose]`；⛔ 不许把「这份夹具没有被引用的脚注 / 引用只落在单视觉行块」记成通过",
    "值": {"跑了S的夹具": 真的跑了S, "量到行距的夹具": S有行距, "缺": 缺S,
           "逐份": [{"夹具": row["夹具"], "S": row["S"]} for row in S表]},
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
         "Q23", "Q24", "Q25",                     # bugs/0032 / 0033 / 0034（M29、M30、M31）
         "Q26", "Q26b", "Q27", "Q28", "Q29", "Q30",  # 命中测试（`bugs/0066`；M35）
         "Q31", "Q32",
         # ⚠️ `Q37`–`Q40` 是**方向键跨格**的真按键判据（`bugs/0104`）：Q37 测 ↓，
         #    Q38/Q39/Q40 补 ←/→/↑。不列在这里时，页面不可见/无帧导致判据没跑，
         #    会被静默算成通过（与上面 `Q19`–`Q25` 同一条口径）。
         "Q37", "Q38", "Q39", "Q40"]
#   ⭐ `bugs/0069` 的三条**按夹具**判适用性（2026-11-04）：它们要求那一列里真有一格
#      "文字右边留白"（列宽由最长格决定 ⇒ 只有短格才有留白）。`blocks.md` 的 `列三` 有；
#      `tasks.md` 那张表每列都由它自己唯一那一格定宽 ⇒ 格内只有 `td` 的 `padding-right`
#      ⇒ harness 记 `摘要.Q.格内空白.不适用 = true`，这里就**不向它要**这三条。
#      ⚠️ 但**至少要有一次真的跑了**（`真的跑了Q33`）——否则"不适用"能把整族悄悄变成空跑。
需要Q33 = ["Q33", "Q33b", "Q33c"]
#   ⭐ `bugs/0084` 的两条同理，判据是"那一格里**有行内标记**"（反引号 / 两个星号）——
#      没有标记时"活动行展开源码"前后一样宽，这条判据**恒绿**（⛔ 那种绿不算证据）。
#      `blocks.md` 的 ``中等长度的 `内容` `` 满足；`tasks.md` 那张表不满足
#      ⇒ harness 记 `摘要.Q.格末.不适用 = true`，这里就不向它要这两条，
#      但也要求**至少一份夹具真的跑过**（`真的跑了Q34`）。
需要Q34 = ["Q34", "Q34b"]
缺Q = []
真的跑了Q33 = []
真的跑了Q34 = []
for row in Q表:
    q = row["Q"] or {}
    if q.get("适用") is not True:
        continue
    前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
    本份 = list(需要Q)
    if (q.get("格内空白") or {}).get("不适用") is not True:
        真的跑了Q33.append(row["夹具"])
        本份 = 本份 + 需要Q33
    if (q.get("格末") or {}).get("不适用") is not True:
        真的跑了Q34.append(row["夹具"])
        本份 = 本份 + 需要Q34
    缺Q.extend([前缀 + x for x in 本份 if (前缀 + x) not in 有])
检查.append({
    "id": "Q-覆盖", "名": "本轮至少有一份夹具真的验了表格单元格（design/0049）",
    "结果": "通过" if (真的跑了Q and 真的跑了Q33 and 真的跑了Q34 and not 缺Q) else "失败",
    "判据": "至少一份夹具的 `摘要.Q.适用 === true`，且 Q0–Q25（含各字母档）逐条都在——"
            "`tools/live-probe/fixtures/blocks.md` 里有一张 3×3 的表格；"
            "⭐ Q1b/Q1c 判**那一格换进文档流之后还看得见**（`cm-rmd-offscreen` 必须被摘掉，"
            "2026-10-28 用户实测的「数据会消失」就是它）；"
            "⭐ Q14/Q14b/Q14c 是 `bugs/0035`（格内换行）：提交成一个 `<br>`／"
            "粘贴时视图里两行都在且高度 == 阅读态／再点进来仍是两行（不是字面 `<br>`）；"
            "⭐ Q23/Q24/Q25 是 `bugs/0032`/`0034` 与 `bugs/0035` 的边界（末尾反斜杠不吃分隔竖线／"
            "格内 ⇧↵·⌥↵ 同样换行／格内 `# x` 不是标题）；"
            "⭐ Q26–Q30 是 `bugs/0066` 的**命中测试**：行尾死区（`+0/+8/+16 px`）进最后一格、"
            "更外侧（`+64 px`）⛔ 不抢点击、表头行尾与最后一行底边同样进得去、第一格 `⇧Tab` 退出；"
            "⭐ Q31/Q32 是**换格与重复进入**（`P5`/`P7` 的格子版）：编辑中点另一格要先提交再进、"
            "在正在编辑的那一格上再点一下 ⛔ 不许重新申请编辑授权；"
            "⭐ Q33/Q33b/Q33c 是 `bugs/0069`（用户原话「行尾无法插入光标」「使用 → 无法走到行尾」）："
            "编辑态点**格内右侧空白**（宿主之外、`<td>` 之内）只挪光标到行末、⛔ 不重进；"
            "点**格外 8 px 死区**同样；在那片空白上**按下再拖**要真的拖出选区；"
            "⚠️ 这三条**按夹具**判适用性：那张表的列若由它自己那一格定宽（格内没有留白），"
            "harness 记 `摘要.Q.格内空白.不适用`，本份就**不向它要**；"
            "但**至少一份**必须真的跑了（`真的跑了Q33` 非空），⛔ 不让「不适用」把整族变成空跑；"
            "⛔ 不许把「这份夹具没有表格」记成通过或跳过",
    "值": {"跑了Q的夹具": 真的跑了Q, "跑了Q33的夹具": 真的跑了Q33, "缺": 缺Q,
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

# ⚠️ U 段（2026-11-11 用户要求「自己执行多输入测试」）只在**含可测列表行的可编辑块**上产判据。
#   ⇒ 与 `V-覆盖` 同一条口径：至少一份夹具 `摘要.U.适用 === true`；
#     而**真的进去了哪一种**（`摘要.U.逐种[k]`）就要把 U0–U7b 逐条产在，
#     否则"某一步压根没跑"会被读成通过。⛔ 单步判据全绿 ≠ 多步序列正确：
#     `bugs/0312` 里每一步单独看都合法，整条序列却把文字写进了**别的行**。
真的跑了U = [row["夹具"] for row in U表 if (row["U"] or {}).get("适用") is True]
U种 = {"bullet", "ordered", "task"}
跑了U种 = set()
缺U = []
for row in U表:
    u = row["U"] or {}
    if u.get("适用") is not True:
        continue
    if not isinstance(u.get("逐种"), dict):
        缺U.append(row["夹具"] + "/U 逐种明细缺失")
        continue
    for 种 in u["逐种"]:
        跑了U种.add(种)
        前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
        需要 = ["U0", "U1", "U2", "U3", "U4", "U5", "U6", "U7", "U7b"]
        缺U.extend([前缀 + x + "-" + 种 for x in 需要
                    if (前缀 + x + "-" + 种) not in 有])
检查.append({
    "id": "U-覆盖", "名": "本轮真的跑了列表项上的**多输入序列**（逐字/回车/空项/组合/行中）",
    "结果": "通过" if (真的跑了U and not 缺U and U种.issubset(跑了U种)) else "失败",
    "判据": "至少一份夹具的 `摘要.U.适用 === true`；无序/有序/任务三种列表行**都至少跑到一次**"
            "（`摘要.U.逐种` 的并集 ⊇ {bullet, ordered, task}）；"
            "每种真的进去了的品种都要 U0/U1/U2/U3/U4/U5/U6/U7/U7b 逐条在——"
            "每步都比**上一步的期望全文 + 光标 + 行号**（⛔ 不比单步片段），"
            "⛔ 不许把「这份夹具没有可测列表行」记成通过或跳过",
    "值": {"跑了U的夹具": 真的跑了U, "跑到过的品种": sorted(跑了U种), "缺": 缺U,
           "逐份": [{"夹具": row["夹具"], "U": row["U"]} for row in U表]},
})

# ⚠️ K 段（2026-11-11 长任务）同理：每条边界场景**各自**只在真有那种形状的夹具上产判据。
#   ⇒ 至少一份夹具 `摘要.K.适用 === true`；而 K1/K1b/K3/K4/K5a/K6/K7 **每一条都要在某份夹具上真跑过**，
#     否则"这条边界压根没测"会被读成通过。⛔ 期望值来自源码字面与设计语义，⛔ 不是产品函数反算。
#   ⚠️ K2（相邻项 `⌦` 合并）**不进闸门**：它的期望（下一项 `- ` 该不该被一起吃）还没有裁定，
#      只记在 `摘要.K.观察` 里；⛔ 别把"没裁定"记成通过，也别拿它把整轮判红。
真的跑了K = [row["夹具"] for row in K表 if (row["K"] or {}).get("适用") is True]
需要K = ["K1", "K1b", "K3", "K4", "K5a", "K6", "K7"]
跑了K = set()
缺K = []
for row in K表:
    k = row["K"] or {}
    if k.get("适用") is not True:
        continue
    场 = k.get("场景") or {}
    if not isinstance(场, dict):
        缺K.append(row["夹具"] + "/K 场景明细缺失")
        continue
    for cid in 场:
        if (场[cid] or {}).get("适用") is True:
            跑了K.add(cid)
# ⚠️ 非主夹具的 `_键` 带夹具前缀（`edges/K1`）⇒ 判"有产出"要按尾部对。
有键 = set(c.get("_键", "") for c in 检查)
def 有判据(cid):
    return any(k == cid or k.endswith("/" + cid) for k in 有键)
for cid in 需要K:
    if cid not in 跑了K:
        缺K.append("没有夹具跑过 " + cid)
    elif not 有判据(cid):
        缺K.append(cid + " 场景声明跑了但没有判据产出")
检查.append({
    "id": "K-覆盖",
    "名": "本轮真的跑了**编辑边界多输入序列**（行首回车/跨项合并/引用内列表/续行/九位编号）",
    "结果": "通过" if (真的跑了K and not 缺K) else "失败",
    "判据": "至少一份夹具的 `摘要.K.适用 === true`；K1/K1b/K3/K4/K5a/K6/K7 七条边界"
            "**都至少在一份夹具上真跑过**（`摘要.K.场景[cid].适用 === true` 且判据有产出）；"
            "每条都比**整块全文 + 光标偏移 + 光标行**，⛔ 不把「这份夹具没有这种形状」记成通过；"
            "K2（未裁定）只进 `摘要.K.观察`，⛔ 不计入本闸门",
    "值": {"跑了K的夹具": 真的跑了K, "跑到过的场景": sorted(跑了K), "缺": 缺K,
           "逐份": [{"夹具": row["夹具"], "K": row["K"]} for row in K表]},
})


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
            "W1b 空行插在**这一块之后**（块后已有分隔行 ⇒ 2 行；提交进会话的正文逐行比）／"
            "W1c 新宿主在 DOM 里紧跟刚离开那一块／"
            "⭐ W2 一次 `⌘Z` 把正文恢复到操作前／⭐ W2b 同时把**光标**放回操作前那一处／"
            "W2c 撤销之后宿主回到原来那一块／W3 中文组合期一个字节都不动／"
            "W3b 中文上屏后逐字落进新段落（光标在 2）／W4 敲字之后要 `⌘Z` 两次（⛔ 一次不跨层）／"
            "W5 裸 `Enter` 仍留在这个块里（只多一个换行）／W6 收尾整篇逐行回到原样——"
            "⛔ 不许把「这份夹具没有可编辑块 / 块后面没有正文」记成通过或跳过",
    "值": {"跑了W的夹具": 真的跑了W, "缺": 缺W,
           "逐份": [{"夹具": row["夹具"], "W": row["W"]} for row in W表]},
})

# ⚠️ W7 段（`bugs/0108` 列表项行尾回车续标记）只在**W 段选中的块里真有列表项**的
#   夹具上产判据（否则 harness 记为 skip「前提没建立」，⛔ 不是通过）。
#   ⇒ 与 `W-覆盖` 同一条口径：至少一份夹具 `摘要.W.列表项 === true`；
#     而**产出了就要逐条在**。⚠️ W7d（任务项续空框）还必须有**至少一份真的通过**：
#     满场夹具都不是任务项时它整列 skip，此时⛔ 不许把 W7-覆盖 读成通过。
真的跑了W7 = [row["夹具"] for row in W表 if (row["W"] or {}).get("列表项") is True]
需要W7 = ["W7", "W7b"]
缺W7 = []
# ⭐ W8 段（`bugs/0109` 编辑态列表缩进 / `bugs/0110` 已写好的项行中回车）与 W7 同一批
#    夹具上产判据（`摘要.W.列表项 === true`），产出了就必须在。
需要W8 = ["W8", "W8b", "W9", "W8t"]
缺W8 = []
for row in W表:
    if (row["W"] or {}).get("列表项") is not True:
        continue
    前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
    缺W7.extend([前缀 + x for x in 需要W7 if (前缀 + x) not in 有])
    缺W8.extend([前缀 + x for x in 需要W8 if (前缀 + x) not in 有])
W7d承重 = [c["id"] for c in 检查 if c.get("_键", "").endswith("W7d") and c["结果"] == "通过"]
# ⚠️ W8/W8b/W9 都会在"前提没建立"时 skip（整块任务项 / 点不进正文中间）⇒
#    与 W7d 同一条口径：**每一条都至少有一份夹具真的通过**，⛔ skip 不算承重。
def 承重(键名):
    return [c["id"] for c in 检查
            if c.get("_键", "").split("/")[-1] == 键名 and c["结果"] == "通过"]
W8承重 = 承重("W8")
W8b承重 = 承重("W8b")
W9承重 = 承重("W9")
# ⭐ W8t（`bugs/0113` C1）：W8 只量 W 段挑中的那一块（优先 BlockQuote），**顶层**列表的缩进
#    从没被量过。C1 的"多缩进 28 px"与 `0112` B1 的既有度量相反 ⇒ 必须有一份夹具真的量到顶层列表。
W8t承重 = 承重("W8t")
# ⭐ `bugs/0300`（2026-11-09 用户报告「Enter 之后，光标处于 todo 框的前面」）：
#    W7e/W7f 只在 `摘要.W.任务项 === true`（真有可判的任务行）的夹具上产出；
#    W7h 只在 `摘要.W.嵌套任务项 === true`（真有 depth ≥ 2 的任务行）的夹具上产出。
#    ⚠️ 与 W7d 同一口径：**产出了就必须在**，且每一条至少有一份夹具真的通过；
#    ⛔ 不许把"这份夹具没有任务行"记成通过或跳过。
真的跑了W7任务 = [row["夹具"] for row in W表 if (row["W"] or {}).get("任务项") is True]
真的跑了W7嵌套 = [row["夹具"] for row in W表 if (row["W"] or {}).get("嵌套任务项") is True]
缺W7任务 = []
for row in W表:
    if (row["W"] or {}).get("任务项") is not True:
        continue
    前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
    缺W7任务.extend([前缀 + x for x in ("W7e", "W7f") if (前缀 + x) not in 有])
缺W7嵌套 = []
for row in W表:
    if (row["W"] or {}).get("嵌套任务项") is not True:
        continue
    前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
    if (前缀 + "W7h") not in 有:
        缺W7嵌套.append(前缀 + "W7h")
W7e承重 = 承重("W7e")
W7f承重 = 承重("W7f")
W7h承重 = 承重("W7h")
# ⭐ W10（`bugs/0300` 现象二：**源码续行**回车继承所属项）与 W11r/W11l（`bugs/0302`：
#    任务项首个词比一行还长时首行不能只剩方框）——与 W7e 同一口径：只在真有那种行的夹具上
#    产出（`摘要.W.源码续行` / `摘要.W.长词任务`）；产出了就必须在，且每条至少一份真的通过。
真的跑了W10 = [row["夹具"] for row in W表 if (row["W"] or {}).get("源码续行") is True]
真的跑了W11 = [row["夹具"] for row in W表 if (row["W"] or {}).get("长词任务") is True]
# ⭐ 松散项与紧凑项的首行是**两条规则**（`bugs/0302`）：`::first-line` ⛔ 不进块级子元素，
#    松散项的正文在 `<p>` 里 ⇒ 只验紧凑项等于漏掉用户报的那一半。
真的跑了W11松 = [row["夹具"] for row in W表 if (row["W"] or {}).get("长词任务松散") is True]
缺W10 = []
缺W11 = []
for row in W表:
    前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
    if (row["W"] or {}).get("源码续行") is True and (前缀 + "W10") not in 有:
        缺W10.append(前缀 + "W10")
    if (row["W"] or {}).get("长词任务") is True:
        # ⚠️⚠️ `W11r` 只判**紧凑**项（`W11p` 判松散项）⇒ 只有真有紧凑项超宽的夹具才要求它。
        #    2026-11-12 760 宽实测：`loosetasks` 的松散项首词在窄视口下也超宽，`长词任务`
        #    因此为真，而夹具里根本没有紧凑项 ⇒ 旧口径报 `缺 loosetasks/W11r`（假红）。
        #    ⚠️ 缺 `长词任务紧凑` 这一格时按 True 处理（老载荷保守从严，不悄悄放水）。
        if (row["W"] or {}).get("长词任务紧凑", True) is True and (前缀 + "W11r") not in 有:
            缺W11.append(前缀 + "W11r")
        if (前缀 + "W11l") not in 有:
            缺W11.append(前缀 + "W11l")
        if (row["W"] or {}).get("长词任务松散") is True and (前缀 + "W11p") not in 有:
            缺W11.append(前缀 + "W11p")
W10承重 = 承重("W10")
W11r承重 = 承重("W11r")
W11l承重 = 承重("W11l")
W11p承重 = 承重("W11p")
# ⭐ `design/0065` P1（2026-11-10 用户批准）：**全部列表块**的两态几何对照（`W8L`）。
#    摘要.W.列表块 = 这份夹具里"元素内含 <li>"的块序号；**每一块**都必须产出 `W8L-<序>`。
#    ⚠️ W8 只量 W 段挑中的那一块、W8t 只量第一份顶层列表 ⇒ 其余块从来没人量过，
#       `bugs/0305` ① 就出在这个缝里。⛔ 缺一块不能因为"这块不好量"被放过。
缺W8L = []
真的跑了W8L = []
for row in W表:
    Wb = row["W"] or {}
    块列 = Wb.get("列表块")
    if not isinstance(块列, list):
        continue
    前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
    for i in 块列:
        if (前缀 + "W8L-" + str(i)) not in 有:
            缺W8L.append(前缀 + "W8L-" + str(i))
    if 块列:
        真的跑了W8L.append(row["夹具"])
W8L承重 = [c["id"] for c in 检查
           if c.get("_键", "").split("/")[-1].startswith("W8L-")
           and c["结果"] == "通过"]
W8L红 = [c["id"] for c in 检查
         if c.get("_键", "").split("/")[-1].startswith("W8L-")
         and c["结果"] == "失败"]
检查.append({
    "id": "W8L-覆盖", "名": "每一份夹具里的**每一个**列表块都做了两态几何对照（design/0065 P1）",
    "结果": "通过" if (真的跑了W8L and not 缺W8L and W8L承重 and not W8L红) else "失败",
    "判据": "对每一份夹具的每一个内含 `<li>` 的块：进编辑态后逐行比「正文左缘 ＝ 行盒左缘 ＋ "
            "`padding-left`」与阅读态同一个 `<li>` 的「左缘 ＋ `padding-left`」，差 ≤ 0.5 px；"
            "行数不等判红（两态不是同一批行，⛔ 不能比值）；量完正文必须回到操作前。"
            "⛔ 缺块 / 跳过 都不算通过。",
    "值": {"跑了W8L的夹具": 真的跑了W8L, "缺块": 缺W8L, "承重条数": len(W8L承重), "红": W8L红},
})
检查.append({
    "id": "W7-覆盖", "名": "本轮至少有一份夹具真的验了列表项行尾回车续标记（bugs/0108/0109/0110/0300/0302）",
    "结果": "通过" if (真的跑了W7 and not 缺W7 and not 缺W8 and W7d承重
                       and 真的跑了W7任务 and not 缺W7任务 and W7e承重 and W7f承重
                       and 真的跑了W7嵌套 and not 缺W7嵌套 and W7h承重
                       and W8承重 and W8b承重 and W9承重 and W8t承重
                       and 真的跑了W10 and not 缺W10 and W10承重
                       and 真的跑了W11 and not 缺W11 and W11r承重 and W11l承重
                       and 真的跑了W11松 and W11p承重) else "失败",
    "判据": "至少一份夹具的 `摘要.W.列表项 === true`，且 W7/W7b/W8/W8b/W9 逐条都在——"
            "W7 主机不变、新行同品种、左缘与上一行对齐（≤ 1px）／"
            "W7b 续出的前缀与字节恰如期望（只多 `\\n` ＋ 前缀，0 重渲）／"
            "W7c 有序项续出「下一编号」（仅 ordered 项，其余 skip）／"
            "W7d 任务项续出空框（仅 task 项，其余 skip）／"
            "⭐ W7e 回车后光标偏移 == 新行正文起点（≠ 行首），且**画出的插入符在方框之后**"
            "（`bugs/0300`：只判偏移会在 `side: 1` 缺陷上恒绿）／"
            "⭐ W7f 回车后**立刻**敲一个字，落在「前缀 ＋ x」而不是「x ＋ 前缀」，"
            "且渲染在方框右缘之后、光标在字后、⌘Z ×2 可还原／"
            "⭐ W7h 嵌套任务项（depth ≥ 2）上重跑 W7e/W7f 两条——"
            "⭐ W8 编辑态列表项正文左缘 == 阅读态同一个 `<li>`（≤ 0.5px）／"
            "⭐ W8b 续行之后输入全程（Enter → 敲 2 字 → 停手）正文/圆点不跳／"
            "⭐ W9 在**已写好的**列表项正文中间回车仍续出同品种项（`bugs/0110`）——"
            "⭐ W8t **顶层**列表的编辑态正文左缘 == 阅读态 `<li>`（≤ 0.5px，`bugs/0113` C1）——"
            "⭐ W10 **源码续行**（列表项下面那条缩进的普通行）回车续出所属项的品种"
            "（`bugs/0300` 现象二，2026-11-09 用户裁定）／"
            "⭐ W11r/W11p/W11l 任务项首个词比一行还长时，**阅读态（紧凑项 W11r ＋ 松散项 "
            "W11p）与编辑态（W11l）** 的首行都从方框**后面**"
            "起排（`bugs/0302`；⛔ 不是整段掉到第二行、方框独占首行）——"
            "⛔ W7d / W7e / W7f / W7h / W8 / W8b / W9 / W8t / W10 / W11r / W11p / W11l 每条都至少"
            "一份夹具真的通过（skip 不算承重）；⛔ 不许把「W 段的块里没有列表项 / 没有任务行 / "
            "没有源码续行 / 没有长词任务项」记成通过",
    "值": {"跑了W7的夹具": 真的跑了W7, "缺": 缺W7 + 缺W8, "W7d承重": W7d承重,
           "跑了W7任务的夹具": 真的跑了W7任务, "缺任务判据": 缺W7任务,
           "跑了W7嵌套的夹具": 真的跑了W7嵌套, "缺嵌套判据": 缺W7嵌套,
           "W7e承重": W7e承重, "W7f承重": W7f承重, "W7h承重": W7h承重,
           "W8承重": W8承重, "W8b承重": W8b承重, "W9承重": W9承重, "W8t承重": W8t承重,
           "跑了W10的夹具": 真的跑了W10, "缺W10": 缺W10, "W10承重": W10承重,
           "跑了W11的夹具": 真的跑了W11, "缺W11": 缺W11,
           "跑了W11松散的夹具": 真的跑了W11松,
           "W11r承重": W11r承重, "W11l承重": W11l承重, "W11p承重": W11p承重,
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

# ⚠️ Y 段（`design/0061` §5 `INV-LIVE-14`：进编辑态不显示源码、不改变行几何）只在
#   **首行带行内标记的可编辑块**的夹具上产判据（否则 Q35 的负对照不成立）。
#   ⇒ 与 `G-覆盖` / `Q-覆盖` / `R-覆盖` 同一条口径：至少一份夹具 `摘要.Y.适用 === true`；
#     而**产出了就要逐条在**，否则"某条判据压根没跑"会被读成通过。
#   ⚠️ harness 在没有这种块时**既不记通过也不记跳过**（记跳过会让整轮退出码恒为 2），
#     ⇒ 这一条覆盖闸门是它唯一的防呆：没有它，所有夹具都「不适用」时整轮照样全绿。
真的跑了Y = [row["夹具"] for row in Y表 if (row["Y"] or {}).get("适用") is True]
需要Y = ["Q35", "Q35b", "Q36"]
缺Y = []
for row in Y表:
    y = row["Y"] or {}
    if y.get("适用") is not True:
        continue
    前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
    本份 = list(需要Y)
    # ⚠️ 进不去覆盖层的夹具**不向它要 Y0**：那一刻 Q35/Q36 已经是红的（进不去＝判不了），
    #    再记一条"缺 Y0"只是同一件事的第二张罚单。⚠️ 但 Q35b（源码里确有标记）照要——
    #    它只依赖源码，harness 在点击**之前**就产出。
    if y.get("进入") is not False:
        本份 = 本份 + ["Y0"]
    缺Y.extend([前缀 + x for x in 本份 if (前缀 + x) not in 有])
检查.append({
    "id": "Y-覆盖", "名": "本轮至少有一份夹具真的验了「进编辑态不重排」（design/0061）",
    "结果": "通过" if (真的跑了Y and not 缺Y) else "失败",
    "判据": "至少一份夹具的 `摘要.Y.适用 === true`，且 Q35（活动行不露源码）/ Q35b（负对照："
            "源码里确实有标记）/ Q36（进入前后逐视觉行的**块内相对** top/height/可见文本相同）"
            "逐条都在；**真的进了覆盖层**的夹具还必须有 Y0（退出后逐像素回到基线）。"
            "⛔ 不许把「这份夹具没有首行带标记的可编辑块」记成通过或跳过——"
            "那样 L1 的整个承诺会一条夹具都没承重",
    "值": {"跑了Y的夹具": 真的跑了Y, "缺": 缺Y,
           "逐份": [{"夹具": row["夹具"], "Y": row["Y"]} for row in Y表]},
})

# ⚠️ T 段（`INV-LIVE-04` ①：块贴**视口下沿**时进入编辑）与 `Y-覆盖` 同一条口径：
#   至少一份夹具 `摘要.T.适用 === true`，且 T0–T4 逐条在；真的进了覆盖层的还要 T5。
真的跑了T = [row["夹具"] for row in T表 if (row["T"] or {}).get("适用") is True]
需要T = ["T0", "T1", "T2", "T3", "T4"]
缺T = []
for row in T表:
    t = row["T"] or {}
    if t.get("适用") is not True:
        continue
    前缀 = "" if row["夹具"] == str(基线原始.get("文档") or "") else row["夹具"] + "/"
    本份 = list(需要T)
    # ⚠️ 进不去覆盖层时 T1 已经是红的，再要 T5 只是同一件事的第二张罚单。
    if t.get("进入") is not False:
        本份 = 本份 + ["T5"]
    缺T.extend([前缀 + x for x in 本份 if (前缀 + x) not in 有])
检查.append({
    "id": "T-覆盖", "名": "本轮至少有一份夹具真的验了「块贴视口下沿进入编辑」（INV-LIVE-04 ①）",
    "结果": "通过" if (真的跑了T and not 缺T) else "失败",
    "判据": "至少一份夹具的 `摘要.T.适用 === true`，且 T0（摆放成立：块底距视口下沿 0–120 px）/ "
            "T1（覆盖层开了）/ T2（ΔH ≤ 0.5 px）/ T3（块顶文档坐标 Δ ≤ 0.5 px）/ "
            "T4（ΔscrollTop ≤ 0.5 px）逐条都在；真的进了覆盖层的还要 T5（退出后逐像素回基线）。"
            "⛔ 不许把「这份夹具没有 ≥60 px 的可编辑块」记成通过——那样「非最大化窗口里点块」"
            "这一整类摆放会一条夹具都没承重",
    "值": {"跑了T的夹具": 真的跑了T, "缺": 缺T,
           "逐份": [{"夹具": row["夹具"], "T": row["T"]} for row in T表]},
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

def 变异命中数(文件名):
    """这一页副本上**真正施加成功**的变异处数（读 `apply_mutation` 的日志）。

    ⚠️ 与"变异后红数"配套（`bugs/0099` §5 第 3 条）：命中 ≥1 但红数 = 0 ＝ **变异失效**，
    与普通的"判据红了"不是一回事 —— ⛔ 不能只报一个"失败"让人分不清。
    """
    页 = "page-" + os.path.splitext(os.path.basename(文件名))[0]
    try:
        with open(os.path.join(work, "mutations.log"), encoding="utf-8") as f:
            lines = f.read().splitlines()
    except Exception:
        return 0
    return sum(1 for ln in lines if ln.startswith(页 + "|"))

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
    # ⭐ 区分「变异失效」与「判据红」（`bugs/0099` §5 第 3 条）。
    #
    # ⚠️⚠️ **2026-11-09 修正口径：看的是"新增红"，不是"红数 == 0"**。
    #    原判据只在**整页一条红都没有**时才报警——可基线自己就可能带红
    #    （例：`blocks` 基线的 `Q41` 是 `bugs/0299` 的已知红）。`M22` 换靶前正是这样：
    #    变异后 `Q2b`/`Q2c` **仍是绿的**（靶子被 `bugs/0297` 的外壳接住），
    #    而 `红数` 因为那条**基线红**读成 1 ⇒ 恒绿目标被"别人的红"盖住，
    #    聚合器一声不响，只能靠人肉读 `值.红` 才发现。⇒ 用「变异后红 − 基线红」判。
    命中 = 变异命中数(文件名)
    基线红 = {k for k, v in 基线表.items() if v == "失败"}
    红数 = sum(1 for v in table.values() if v == "失败")
    新增红 = sorted(k for k, v in table.items() if v == "失败" and k not in 基线红)
    值 = {"红": 红, "保持绿": 绿, "变异命中": 命中, "变异后红数": 红数,
          "基线红数": len(基线红), "变异新增红": 新增红,
          **({"基线取自": 基线键} if 基线键 else {}),
          "⚠️ 口径": "变异打在**页面副本**上（⛔ 仓库文件一字未动）；"
                     "施加前校验模式命中恰好 1 次，并用 cksum 证明文件真变了"}
    if 命中 == 0:
        值["⚠️ 变异未施加"] = ("日志里没有这一页的施加记录 ⇒ 本轮变异没真正改到页面副本，"
                              "⛔ 别把结果当成'产品没坏'")
    if not 新增红:
        值["⚠️ 变异失效"] = ("这一页副本上**相对基线没有新增任何红**（变异后红数 %d，全落在基线红 %d 条里）"
                            "⇒ 变异与判据之间没有区分力（靶子被兜住 / 它压的机制已被设计取代），"
                            "⛔ 不能按普通失败读；先补承重判据，否则退役这条变异（`bugs/0099`）"
                            % (红数, len(基线红)))
    return {"id": cid, "名": 说明, "结果": "通过" if ok else "失败",
            "判据": "基线里判据 %s 通过 ∧ 变异后失败%s（其余判据不参与本判据）"
                    % ("/".join(targets),
                       ("；负对照 %s 变异后必须仍通过" % "/".join(保持绿)) if 保持绿 else ""),
            "值": 值}

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
#    而 `O-pre-5`（围栏里是代码）、`O-p-5b`（标记删干净之后、**没有标题节点**）
#    **必须仍绿**——否则说明这一条判的是"位置"不是"品种"。`-5b`（删干净）由 O-覆盖 逐类核。
#    ⚠️⚠️ 2026-11-05：`O-p-5` 已从负对照里拿掉（理由见上面 M10 施加处那段注释）——
#    它现在与 `O-h1-5`/`O-ul-5` 一同红，那是**判据打中了靶子**，不是回归。
#    ⚠️⚠️ 2026-11-12：`O-pre-5` **从"保持绿"名单里拿掉**（与 2026-11-05 的 `O-p-5` 同一类）。
#    实测 `m10.json` 的 `变异新增红` 里带着 `O-pre-5`：代码块这一段 ③ 的标题行是
#    **在起始围栏行上面**敲出来的（见 `block-harness.js` ⑤ 那段 2026-11-12 实测），
#    那行在变异后会从"空 ATX 标题"掉成正文 ⇒ 它量与命中靶子的是同一件事，
#    ⛔ 不再是负对照。负对照保留 `O-p-5b`（标记删干净、没有标题节点，变异碰不到）。
#    ⛔ 别把"它红了"读成产品回归——基线里 `O-pre-5` 是绿的。
检查.append(变异判据("M10", "m10.json", ["O-h1-5", "O-ul-5"],
                    "变异：只剩井号的行不当标题（bugs/0016 原样打回）⇒ 判据 O-h1-5／O-ul-5 必须红，O-p-5b 必须仍绿",
                    保持绿=["O-p-5b"]))
# ⚠️ M11：`paste` 的监听器不接 ⇒ 粘贴静默失效（剪贴板进了离屏 textarea、不进文档）。
检查.append(变异判据("M11", "m11.json", "O-h1-5c",
                    "变异：删掉 `input.addEventListener('paste', onPaste)` ⇒ 判据 O-h1-5c（粘贴两行）必须红"))
# ⚠️ M12–M14 是 `bugs/0018` 的三处（2026-10-27「一旦进入标签模式，就出不来」）：
#    ⛔ 三条都**只有 P 段看得见**——B 段的退出方式只有一种，且事件**恒派发到 `ta`**。
检查.append(变异判据("M12", "m12.json", "P6",
                    "变异：`swapLiveView` 换进去之后不摘旧节点（同一段文字留在原地）⇒ 判据 P6（重渲后没有多余节点）必须红。⚠️ 2026-10-28 二度换靶：上一版「摘宿主挪到 mount 之后」实跑**没红**，是改法等价（`d.mount` 收尾的 `noteLive → reseat` 已把 `a.swap` 换成新树上的一个），细节在脚本里 M12 那段注释"))
检查.append(变异判据("M13", "m13.json", ["P7", "Q31"],
                    "变异：`begin()` 不重取新表 / 新树（用调用方的过期节点）⇒ 判据 P7（进去的是被点那一块）"
                    "必须红。⭐ 2026-11-03 起**同一次变异还压着格子那条路**：`Q31`（编辑中点另一格）"
                    "走的是同一段 `if (switched)`，只是换了个取值口（`d.cellNodeOf`）——"
                    "`el` 已脱树 ⇒ 宿主挂在一个不在文档里的 `<td>` 上 ⇒ 进不去那一格。"
                    "⛔ 别把它写成两处变异：代码只有一处，两个面分别由块级与格子级判据看守",
                    保持绿=["Q1"]))
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

检查.append(变异判据("M22", "m22.json", ["Q41b"],
                    "变异：`.cm-rmd-cell` 不截水平溢出（`bugs/0027`：格子里的编辑视图"
                    "瞬时撑到 10 万 px ⇒ 表格被分配一条 12 px 的经典横向滚动条，"
                    "整张表长高、下面全部被推下去）⇒ 判据 **Q41b**（逐格进入，⛔ 不新增横向滚动条）"
                    "必须红，而「这一格」那三条（Q1b 看得见 / Q1c 画在格里 / Q1d 格高不变）必须仍绿。"
                    "⚠️ **2026-11-09 起是两处改动同一次变异**（`bugs/0297` 之后 `freezeTableLayout` "
                    "的临时外壳接住了横向溢出）：`.cm-rmd-cell` 的 clip 摘掉 ＋ 外壳强行 `overflow-x: auto`。"
                    "只做第一处时 0 红（2026-11-09 实测 `Q2b` `ΔH 0 px`）——那是 HITS=1 的假变异。"
                    "⚠️ **靶子从 Q2b/Q2c 换成 Q41b**：`Q2b`/`Q2c` 只点 (0,0) 那一格，而"
                    "**本轮口径是 `PROBE_W=760`** —— 那个窄宽度下 (0,0) 这格不会触发 CM6 量行高的替身，"
                    "变异后仍 `ΔH 0 px`（2026-11-09 实测；同一变异在 `PROBE_W=1000` 下 `ΔH 12 px`，"
                    "说明差别在**窗口宽度**，不在变异强度）。`Q41b` 扫全部 9 格、量的是"
                    "**滚动条厚度**（与内容无关），760 下能稳定看到 `0 → 12 px`",
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

检查.append(变异判据("M33", "m33.json", ["D3", "D3b"],
                    "变异：组合串退回**绝对定位的覆盖层**（`live.css` 给 `.cm-rmd-preedit` 加 "
                    "`position: absolute`）⇒ 它脱离排版，后面的字不再被推开，两段字形叠在同一片"
                    "像素上——2026-11-02 用户「按照 mardo 来修改」之前正是这个形态。"
                    "判据 D3（在 `.cm-line` 里 ∧ 不是 absolute）与 D3b（行尾被推右 / 整段折行）"
                    "**都必须红**。"
                    "⚠️ 负对照 D1/D1b/D2/D1c 必须仍绿：换掉定位只影响「占不占位」，"
                    "⛔ 不该把「文档不变 / 上方的块不动 / 下游只跟着块高走」也打红",
                    保持绿=["D1", "D1b", "D2", "D1c"]))

检查.append(变异判据("M34", "m34.json", "D3c",
                    "变异：组合串画错位置（`preeditPos` 取成插入点**右边一个字**）⇒ 拼音还在行内、"
                    "还占版面、行尾照样被推右，**只有**它在文档里的偏移不对。"
                    "判据 D3c（`posAtDOM(widget)` == 选区头）必红。"
                    "⚠️ 负对照 D3（行内 ∧ ⛔ 进文档）与 D3b（占版面）必须仍绿——"
                    "它们证的是「有没有进排版」，⛔ 不是「落在哪一格」，两面分开承重",
                    保持绿=["D3", "D3b"]))

检查.append(变异判据("M35", "m35.json", ["Q26", "Q28", "Q29"],
                    "变异：摘掉表格命中的**几何兜底**（`main.js` 的 `|| LCell.cellAtPoint(…)`，"
                    "即 `bugs/0066` 之前的产品形态）⇒ 行尾死区里的按下命中的是 `<table>` "
                    "元素本身，`cellFromTarget` 一步都走不动 ⇒ 只弹一条「请点格子」的提示。"
                    "判据 Q26（行尾 +0/+8/+16 px）、Q28（表头行尾）、Q29（最后一行底边）**都必须红**。"
                    "⚠️ 负对照 Q1（格子左上角，走正常 DOM 上溯）与 Q27（死区 +64 px ⛔ 不抢点击）"
                    "必须仍绿——两面分开承重；Q26b 判的是**几何前提**（行尾那几次按下的目标"
                    "真的是 `<table>`），它也必须仍绿，红了说明夹具/CSS 变了 ⛔ 不是这条的证据",
                    保持绿=["Q1", "Q26b", "Q27"]))

检查.append(变异判据("M36", "m36.json", "Q32",
                    "变异：单元格里的按下**不再被视图接走**（`selection.js::down` 的 "
                    "`preventDefault()` ＋ `stopPropagation()` 一起摘）、`onLiveDocDown` 的 "
                    "`defaultPrevented` 闸也摘、**活动格守卫**（`bugs/0069`）也摘 ⇒ "
                    "事件冒泡到 `#doc` 被当成**新的进入**：重新 `begin_edit`、换一个新宿主。"
                    "判据 Q32 必红。"
                    "⚠️⚠️ 2026-11-04 起必须摘**三层**：只摘前两层时第三层会把 Q32 顶住"
                    "（那一版实测仍绿，⛔ 别当成判据不承重）。"
                    "⚠️⚠️ 负对照 Q1（点格子进得去）与 Q31（点**另一格**换格）必须仍绿——"
                    "这两条的按下都发生在宿主**外面**，摘掉宿主内的拦截不该影响它们；"
                    "它们红了说明变异改到的不是「宿主内的那一下」。"
                    "⚠️ 块级没有一条会红：`onLiveDocDown` 的 `cm-rmd-liveHost` 闸判的是块顶节点，"
                    "而格子那颗宿主挂在 `<td>` 里面 ⇒ 拦不住。这一条就是那个差别的证词",
                    保持绿=["Q1", "Q31"]))

检查.append(变异判据("M37", "m37.json", "Q33c",
                    "变异：`installMouse` 的**监听面不覆盖 `<td>`**（`selection.js` 的 `hitArea` 兜底 ＋ "
                    "`main.js` 传 `hitArea` 两处一起摘，＝ `bugs/0069` 之前的产品形态）⇒ "
                    "格内右侧空白上的按下没有任何人接，冒泡到 `onLiveDocDown`；"
                    "那道「点的就是活动那一格 ⇒ 只挪光标」的守卫**还能顶住 `Q33`**，"
                    "但 `moveHandler` 需要的拖拽态永远建不起来 ⇒ 判据 Q33c（空白处按下再拖出选区）必红。"
                    "⚠️⚠️ **必须两处一起摘**：只摘一处，另一处照样把 `<td>` 交出去 ⇒ Q33c 仍绿"
                    "（同 M36 的教训：变异没红与判据不承重长得一模一样）。"
                    "⚠️ 负对照取 Q31（点**另一格**换格）、Q32（宿主内再点一下）、"
                    "Q33／Q33b（只挪光标那两条）：它们各由别的通路承重，必须仍绿",
                    保持绿=["Q31", "Q32", "Q33", "Q33b"]))

检查.append(变异判据("M38", "m38.json", "Q33b",
                    "变异：摘掉 `main.js::onLiveDocDown` 里「点中的就是**正在编辑的那一格** ⇒ 只挪光标、"
                    "⛔ 不重进」那道守卫（6 行）⇒ 按在 `<td>` 右边界外 8 px 的死区（`bugs/0066` 的 16 px "
                    "几何容差里，目标元素是 `<table>` 本身）会被当成一次**新的进入**："
                    "`leave('switch')` 提交 ＋ 整篇重渲 ＋ 重新 `begin_edit` ＋ 换宿主。判据 Q33b 必红。"
                    "⚠️ 负对照取 Q31（点**另一格**必须重进）、Q32（宿主内再点一下）、"
                    "Q33（格内空白，走 `hitArea` 那条路）——"
                    "前两条证明这道守卫**没有**把「换格」一起吃掉；"
                    "Q33 仍绿正是「两层各有独立职责」的证据。"
                    "⛔ **负对照不取 `Q33c`**（2026-11-04 实测）：`Q33c` 只能排在 `Q33b` 之后，"
                    "而 `Q33b` 在这条变异下会真的重进一次、把原宿主摘掉 ⇒ `Q33c` 读 detach 的宿主，"
                    "恒为 `-1..-1`，与 `hitArea` 无关（退回 `bugs/0078` 的改动后一模一样红）；"
                    "把它提到前面又会改掉格内文字，让 `Q33`/`Q33b` 变成重新进格。"
                    "`hitArea` 的承重证据在 M37（`Q33c` 必须红）那一条",
                    保持绿=["Q31", "Q32", "Q33"]))

# ⛔ M39 已**退役**（2026-11-08，`bugs/0099` §5.1）：它压的前提（活动行显示源码 ⇒ 阅读态/编辑态
#    排版有差）已被 `design/0061` L1 消灭 ⇒ 2026-11-05 实测 `m39.json` 400 条判据 **0 红**。
#    ⛔ 别再恢复这条 `变异判据`；同族承重见 M41（`Q35`/`Q36`）。

检查.append(变异判据("M40", "m40.json", "Q34c",
                    "变异：`selection.js::paint` 里**不再把光标夹回可见区**（摘掉那一行 `夹回可见区` 调用），"
                    "＝ `bugs/0085` 修之前的产品形态：格子 `.cm-rmd-cell` 是 `inline-block`、宽收缩到内容宽、"
                    "`overflow-x: clip`，行末光标的左沿正好压在裁剪盒右沿上 ⇒ 2 px 全在盒外、"
                    "屏幕上一根都看不见（`getBoundingClientRect()` 照样有值，所以只看矩形量不到）。"
                    "判据 Q34c（行末光标**剩余可见宽** ≥ 1 px）必红。"
                    "⚠️ 这一条改的是**画**，⛔ 不是落点 ⇒ 负对照 Q34（阅读态点末字右半 ⇒ 仍在格末）"
                    "与 Q34b（同一格左端的点）必须仍绿；红了说明变异碰到的不是画光标那一段",
                    保持绿=["Q34", "Q34b"]))

检查.append(变异判据("M41", "m41.json", ["Q35", "Q36"],
                    "变异：把「活动行显示源码」打回来（＝ `design/0061` 之前的规则 2）——"
                    "`decorations.js::createField::build` 里**不再**对光标/选区所在行施加隐藏区间"
                    "（`plan.ranges` 按起点行过滤、`plan.fenceLines` 对活动行跳过塌行）⇒ "
                    "进入编辑态后 `**`、反引号、`#` 重新出现在屏幕上，行变宽、可能多折一行、块变高。"
                    "判据 Q35（活动行也不许露源码）与 Q36（进入前后逐视觉行相同——块内相对 top / "
                    "height / 可见文本）**必须一起红**——"
                    "它们判的是同一件事的两个面（可见文本 / 行几何），⛔ 别当成两条独立证据。"
                    "⚠️⚠️ 靶子**不打 `activeLineIndexes` 函数体**：L1 会把它删掉或退化成恒 `[]`，"
                    "打在那里是 `HITS=0` 的假变异；打在施加点复现的用户可见后果与旧形态逐点相同"
                    "（旧 `markers()` 就是 `if (active[lineOf(from)]) return;`，按**起点行**放行）。"
                    "⚠️ 负对照取 B0-4（块自身 top 不动）、B0-5（块外零位移，按块自身高度变化解释后）、"
                    "D2（组合期活动块只长高 ≤ 一行）与 Q35b（这一块源码里确实有标记）："
                    "这条变异只改「藏不藏」，⛔ 不改块盒与外边距 ⇒ 它们必须仍绿；"
                    "红了说明变异碰到的不是「标记可见性」这个开关",
                    保持绿=["B0-4", "B0-5", "D2", "Q35b"]))

检查.append(变异判据("M43", "m43.json", "Q37",
                    "变异：`main.js::onKeyDown` 把 `cmd === 'lineDown'` 传成 `false` ⇒ "
                    "按下箭头走的是**上一行**（跨格方向反了）。判据 Q37（末视觉行按 ↓ ⇒ "
                    "进下一行同一列）必须红。"
                    "⚠️ 这条只钉**方向真的按 ↓/↑ 传**；`bugs/0104` 那个更严重的形态"
                    "（模块级函数直接摸闭包里的 `view` ⇒ `ReferenceError`）没法用一条变异"
                    "稳定表达——那会让整页抛、所有判据一起红，等于不承重。"
                    "⚠️ 负对照取 Q22（格内 ↑/↓ 走视觉行）：这条变异⛔ 不改格内移动，"
                    "Q22 红了说明变异碰到的不是跨格那一段",
                    保持绿=["Q22"]))

检查.append(变异判据("M44", "m44.json", ["W7", "W7b", "W7d"],
                    "变异：`live/input.js::lineBreakAction` 第一道闸恒过 ⇒ 行尾回车一律裸 `\\n`"
                    "（不再续列表标记）。判据 W7/W7b/W7d（列表项行尾回车续出同品种标记、"
                    "前缀逐字节如期望、任务项续空框）必须红——`bugs/0108` 修的就是这条路。"
                    "⚠️ 变异轮跑的是 tasks 夹具（满篇任务项）⇒ 基线键带 `tasks/` 前缀；"
                    "W7c（有序项下一编号）在 tasks 上本来就是 skip，不在靶子里。"
                    "⚠️ 负对照取 W1/W2/W6：这条变异⛔ 不改 `⌘↵` 新起一段与收尾撤销，"
                    "红了说明变异碰到的不是「行尾回车」那一段",
                    保持绿=["W1", "W2", "W6"],
                    基线键={"W7": "tasks/W7", "W7b": "tasks/W7b", "W7d": "tasks/W7d"}))

检查.append(变异判据("M45", "m45.json", ["W9"],
                    "变异：`live/input.js::lineBreakAction` 在列表判定**之后**补回"
                    "「光标不在行尾 ⇒ 裸 `\\n`」的旧守卫 ⇒ **行中**回车不再续标记"
                    "（＝ `bugs/0108` 修复前的语义）。判据 W9（在**已写好的**列表项正文"
                    "中间回车仍续出同品种项）必须红——`bugs/0110` 修的就是这条路。"
                    "⚠️ 变异刻意**不短路整个列表判定**：那样连行尾一起红，就退化成 M44 的"
                    "重复，承重不到「行中」这一半。"
                    "⚠️ 负对照取 W7/W7b：这条变异⛔ 不改行尾那条路，"
                    "红了说明变异碰到的不是「行中」那一段",
                    保持绿=["W7", "W7b"],
                    基线键={"W9": "tasks/W9", "W7": "tasks/W7", "W7b": "tasks/W7b"}))

检查.append(变异判据("M46", "m46.json", ["W8"],
                    "变异：`live/decorations.js::listDeco` 的 `padding-left` 恒 `0px`"
                    "（不再 `--reader-list-indent × depth`）⇒ 编辑态列表正文左缘贴住行盒左缘，"
                    "与阅读态 `<li>` 的缩进对不上。判据 W8（编辑态正文左缘 == 阅读态，≤ 0.5px）"
                    "必须红——`bugs/0109` 的「缩进不对」量的就是这一个值。"
                    "⚠️ 负对照取 W7/W7b：缩进对**新旧两行同时**生效，行间一致性不受影响 ⇒ "
                    "它们必须仍绿；红了说明变异碰到的不是「编辑态缩进」这个值",
                    保持绿=["W7", "W7b"],
                    基线键={"W8": "tasks/W8", "W7": "tasks/W7", "W7b": "tasks/W7b"}))

检查.append(变异判据("M47", "m47.json", ["W8"],
                    "变异：`live/decorations.js::markers` 的列表行深度打回 `listStack.length`"
                    "（＝ `bugs/0112 B4` 修之前：引用块里的列表丢掉宿主没搬的那一条 `<ul>` 缩进）⇒ "
                    "编辑态正文左缘比阅读态 `<li>` 左 28 px（14 px × `--reader-list-indent`）。"
                    "判据 W8（编辑态正文左缘 == 阅读态，≤ 0.5px）必须红——"
                    "`bugs/0112 B4` 修的就是引用块里这一条缩进。"
                    "⚠️ 变异轮跑 tasks（W 段挑中的正是引用块里的任务列表）；基线键带 `tasks/` 前缀。"
                    "⚠️ 负对照取 W8t（**顶层**列表：宿主搬的就是那个 `<ul>`，深度从 0 起是对的）"
                    "与 W7/W7b（行间一致性不受第一条缩进影响）⇒ 它们必须仍绿；"
                    "红了说明变异碰到的不是「引用块里缺一条缩进」这个面",
                    保持绿=["W7", "W7b", "W8t"],
                    基线键={"W8": "tasks/W8", "W7": "tasks/W7", "W7b": "tasks/W7b",
                            "W8t": "tasks/W8t"}))

检查.append(变异判据("M48", "m48.json",
                    ["O-blockquote-1", "O-blockquote-3", "O-blockquote-4",
                     "O-blockquote-5", "O-blockquote-5b", "O-blockquote-5c"],
                    "变异：`styles/live.css` 里 `cm-rmd-quote-gap` 的行高不再是"
                    "`--reader-gap-block`，改成固定 `20px` ⇒ 编辑态那条引文空行的高度"
                    "不再等于阅读态「下一段 top − 上一段 bottom」的实测段距。"
                    "判据 O-blockquote-1/3/4/5/5b/5c 的等价几何那一步（quote-gap 行盒高"
                    "== 阅读态实测段距，≤ 0.5px）必须红——它们此前正是被这个行高骗红的。"
                    "⚠️ 变异轮跑 blankmd（引用块里夹一段 `>` 空行，O 段每个动作都量得到它）；"
                    "基线键带 `blankmd/` 前缀。"
                    "⚠️ 负对照取 O-p-1（普通段落块，压根没有 quote-gap 行）：它红了说明"
                    "变异碰到的不是「引文空行」这个品种",
                    保持绿=["O-p-1"],
                    基线键={k: "blankmd/" + k for k in
                            ["O-blockquote-1", "O-blockquote-3", "O-blockquote-4",
                             "O-blockquote-5", "O-blockquote-5b", "O-blockquote-5c",
                             "O-p-1"]}))

检查.append(变异判据("M49", "m49.json", ["B2-3c"],
                    "变异：`live/decorations.js` 的「续行补深度」不再藏行首缩进"
                    "（摘掉 `raw.push({ from: 首, to: i })`）⇒ 编辑态列表续行保留源码里"
                    "那两个空格（`white-space: pre-wrap`），而阅读态由 `<li>` 内容列定起点、"
                    "行首空白被 HTML 折叠。判据 B2-3c（标记藏完后的可见文本逐字对齐独立 oracle）"
                    "必须红——`bugs/0102` 的 oracle 认识这一品种，产品一旦不藏就对不上。"
                    "⚠️ 变异轮跑 tasks（B2 是带续行的列表块）；基线键带 `tasks/` 前缀。"
                    "⚠️ 负对照取 B0-3c（普通段落块，没有列表续行）：它红了说明变异碰到的"
                    "不是「续行行首缩进」这个品种",
                    保持绿=["B0-3c"],
                    基线键={"B2-3c": "tasks/B2-3c", "B0-3c": "tasks/B0-3c"}))

检查.append(变异判据("M50", "m50.json", ["B11-3a", "B11-5"],
                    "变异：围栏行 / 塌行不再塌成 0 高（＝`bugs/0023`／`0298` 那一族回来）"
                    "⇒ 进入代码块时上下两条围栏各占一整行，块长高、下游一起下移"
                    "⇒ 判据 B11-3a（块高逐像素不变）与 B11-5（块外零位移）必须红。"
                    "⭐ 这是 2026-11-09「进入瞬间 ΔH ≤ 0.5 px」标准的承重变异"
                    "（此前 `B*-3a` 只判\"长高只记账\"，改红后从没被变异打红过）。"
                    "⚠️ 变异轮跑主夹具（blocks，B11 是 ```rust 那个代码块）。"
                    "⚠️ 负对照取 T2/T3（T 段量的是**普通块**贴下沿进入，与围栏塌行无关）："
                    "它们红了说明变异污染的是\"位置\"而不是「围栏行」这个品种",
                    保持绿=["T2", "T3"]))

检查.append(变异判据("M51", "m51.json", ["W7e", "W7h"],
                    "变异：`live/decorations.js` 的任务框 widget 从 `side: -1` 改回 `side: 1`"
                    "（`bugs/0300` 的缺陷形态）⇒ 方框与光标同在正文起点时，插入符被画在方框"
                    "**左缘**（离屏实测 caret.left == wrap.left，方框在它右边 22 px）⇒ 用户看到的"
                    "正是「Enter 之后，光标处于 todo 框的前面」。判据 W7e/W7h 都断言"
                    "「画出的插入符在方框右缘之后」（≤ 0.5px）⇒ 两条必须红。"
                    "⚠️ `W7f` **不列在这里**：它判的是「敲的字落进新行正文」，离屏实测 `side: 1`"
                    "下键入的字仍渲染在方框右缘之后（两种 side 的字节与字位相同）⇒ 这条变异"
                    "打不红它；W7f 的承重证据在 M52（落点变异）。"
                    "⚠️ 变异轮跑 tasks；基线键带 `tasks/` 前缀。"
                    "⚠️ 负对照取 W7/W7b/W7d（主机/品种/字节/方框存在性不受 side 影响）："
                    "它们红了说明变异碰到的不是「widget 的 side」这个面",
                    保持绿=["W7", "W7b", "W7d"],
                    基线键={k: "tasks/" + k for k in
                            ["W7e", "W7h", "W7", "W7b", "W7d"]}))

检查.append(变异判据("M52", "m52.json", ["W7e", "W7f", "W7h"],
                    "变异：`main.js::onTransaction` 的落点从 `from + insert.length` 退成 `from + 0`"
                    "（`bugs/0300` §6 提的落点变异）⇒ 回车之后光标不再落在新行正文起点，"
                    "立刻敲的那个字也不会落进新行正文。判据 W7e（偏移 == 正文起点）与"
                    "W7f（字节 == 前缀 ＋ x）必须红；W7h 在嵌套项上重跑同两条，一并红。"
                    "⚠️ 这条变异作用于**所有**事务，红面很宽；负对照取 W7/W7b/W7d"
                    "（只读主机/品种/字节，不读光标）：它们红了说明变异碰到的不是「落点公式」"
                    "这个面。⚠️ 变异轮跑 tasks；基线键带 `tasks/` 前缀",
                    保持绿=["W7", "W7b", "W7d"],
                    基线键={k: "tasks/" + k for k in
                            ["W7e", "W7f", "W7h", "W7", "W7b", "W7d"]}))

检查.append(变异判据("M53", "m53.json", ["W10"],
                    "变异：`live/input.js::lineBreakAction` 不再把**源码续行**认成所属列表项"
                    "（＝把 `bugs/0300` 现象二修好前的旧语义打回去：续行回车是裸 `\\n`）"
                    "⇒ 判据 W10（续行回车续出所属项的品种）必须红。"
                    "⚠️ 变异轮跑 **wraptasks**（唯一含源码续行的夹具）；基线键带 `wraptasks/` 前缀。"
                    "⚠️ 负对照取 W7e／W7f（回车落点与「前缀 ＋ x」，走的是**真任务行**那条分支，"
                    "与续行回溯无关）：它们红了说明变异碰到的不是「续行」这个面。"
                    "⚠️⚠️ 2026-11-09 初版取的是 W7／W7b／W9／W8b，而那四条在 **wraptasks** 上"
                    "**根本不产出**（W 段挑中的是标题块 ⇒ 没有真列表项行；W9/W8b 在松散列表里跳过）"
                    "⇒ 负对照恒为 `null`／`跳过`，M53 永远 ⛔。⛔ 别再拿「这份夹具上不存在的判据」当负对照。",
                    保持绿=["W7e", "W7f"],
                    基线键={k: "wraptasks/" + k for k in
                            ["W10", "W7e", "W7f"]}))

检查.append(变异判据("M54", "m54.json", ["W11r", "W11p"],
                    "变异：阅读态任务项首行的 `word-break: break-all` 那条规则停掉"
                    "（2026-11-09 起是**一条**选择器，紧凑项与松散项共用）"
                    "⇒ 超宽首词整段掉到第二行、方框独占首行（`bugs/0302` 用户截图里的形态）"
                    "⇒ 判据 W11r（紧凑）与 W11p（松散）都必须红。"
                    "⚠️⚠️ 编辑态（`W11l`）在这条变异下必须**仍绿**：编辑态首行的劈词来自 "
                    "`live.css` 里**另一条** `.cm-line[data-rmd-li=\"task\"]::first-line` 规则"
                    "（承重变异是 M56）——它是**负对照**，证明两态各有一条规则、互不代偿，"
                    "⛔ 不许写成「也必须红」。"
                    "⚠️ 2026-11-09 初版这里写过「CM6 `lineWrapping` 的 `overflow-wrap: anywhere` "
                    "本来就允许劈词、产品侧没有对应规则」——**那是错的**（`bugs/0302` §3.3）："
                    "方框后那个空格是断行点，`anywhere` 只在无处可断时才拆词。"
                    "⚠️ 变异轮跑 **wraptasks**（两种项都在）；基线键带 `wraptasks/` 前缀。"
                    "⚠️ 负对照取 W10（续行回车，与断行规则无关）：它红了说明变异碰到的"
                    "不是「首行断行」这个面",
                    保持绿=["W10", "W11l"],
                    基线键={k: "wraptasks/" + k for k in
                            ["W11r", "W11p", "W11l", "W10"]}))

检查.append(变异判据("M56", "m56.json", ["W11l"],
                    "变异：**只**把 `live.css` 里编辑态任务行首行的 `word-break: break-all` 停掉"
                    "（`bugs/0302` 编辑态那一半）⇒ 超宽首词在编辑态整段掉到第二行、方框独占首行。"
                    "判据 W11l（编辑态每条超宽任务行首字都在方框后）必须红。"
                    "⚠️⚠️ 阅读态那条规则（`typography.css`）原样保留 ⇒ W11r / W11p 必须**仍绿**"
                    "（负对照：证明变异碰到的是「编辑态首行断行」这个面，不是整条断行决定）。"
                    "⚠️ 这条变异同时守住「两态各有一条规则、谁都不能代偿谁」：2026-11-09 曾据"
                    "「M54 之后 W11l 仍绿」把编辑态规则判成死代码删掉，实际是当时的 W11l 只量"
                    "文档顺序第一条超宽任务行（中文长句，缺陷态也绿）⇒ 判据不敏感，不是规则死。"
                    "⚠️ 变异轮跑 **wraptasks**（唯一同时含中文长句与长单词的夹具）；"
                    "基线键带 `wraptasks/` 前缀。⚠️ 负对照取 W11r / W11p / W10",
                    保持绿=["W11r", "W11p", "W10"],
                    基线键={k: "wraptasks/" + k for k in
                            ["W11l", "W11r", "W11p", "W10"]}))

检查.append(变异判据("M57", "m57.json", ["S1"],
                    "变异：`typography.css` 的 `.doc sup` 退回**只有字号**（摘掉 `line-height: 0`）"
                    "⇒ 抬高后的行内盒超出本行 strut，带脚注引用的那条视觉行从 23.80 涨到 27.73 px"
                    "（`bugs/0303`）。判据 S1（同一块里每条视觉行距相同 ≤ 0.5 px）必须红。"
                    "⚠️ 同一处缺陷的第二面是 `B*-3a`（该可编辑块在编辑态矮 3.94 px）——"
                    "它也会红，⛔ 别当成两条独立证据。"
                    "⚠️ 变异轮跑 **wraptasks**（唯一带 `[^…]` 的夹具）；基线键带 `wraptasks/` 前缀。"
                    "⚠️ 负对照取 W11r / W10（断行与续行，与上标无关）",
                    保持绿=["W11r", "W10"],
                    基线键={k: "wraptasks/" + k for k in ["S1", "W11r", "W10"]}))

检查.append(变异判据("M58", "m58.json", ["W8t"],
                    "变异：`live/geometry.js::listGeometry` 的补位恒为 1"
                    "（`design/0065` P1 §2.3 变异 ②）⇒ 宿主搬的**就是**那个 `<ul>` 的"
                    "顶层列表也被再补一条缩进，编辑态 28 + 28 = 56 px（`bugs/0113` C1 的"
                    "\"多缩进\"）。判据 W8t（顶层列表两态正文左缘相等，≤ 0.5 px）必须红。"
                    "⚠️ 变异轮跑 tasks（W8t 量的是这份夹具里第一份顶层列表）；基线键带 `tasks/` 前缀。"
                    "⚠️ 负对照取 W8（引用块里的列表：那一支本来就是 1，变异不动它）与 W7/W7b"
                    "（行间一致性不受第一条缩进影响）⇒ 它们必须仍绿；"
                    "红了说明变异碰到的不是「顶层列表的补位」这个面",
                    保持绿=["W8", "W7", "W7b"],
                    基线键={k: "tasks/" + k for k in ["W8t", "W8", "W7", "W7b"]}))

检查.append(变异判据("M59", "m59.json", ["B5-10", "B7-10", "B11-10"],
                    "变异：把「活动行显示源码」**连同选区响应性**一起打回"
                    "（＝ `design/0061` L1 之前的规则 2）：`decorations.js` 的 `update` 在"
                    "`tr.selection` 时也 `build`，且施加隐藏区间 / 围栏塌行时按光标或选区所在行放行。"
                    "⇒ **光标走到哪一行，哪一行就露出 `**` / `#` / 反引号**，行变宽甚至多折一行、"
                    "围栏行撑回整行 ⇒ 行顶与行高逐项变化。判据 B5-10 / B7-10 / B11-10（光标移动"
                    "零位移，`vision/0001` §2.1 2026-11-11 用户裁定）必须红。"
                    "⚠️ **为什么靶子是多行代码块，⛔ 不是 B0-10**（2026-11-11 实跑定下来的口径）："
                    "`B{i}-10` 只在**一个块内**走位，而单行块（`B0`/`B2`/`B4`…）进入编辑时光标就"
                    "已经落在**那一行**上 ⇒ 活动行源码在**基线**里就已经露着，变异不改变任何可见"
                    "文本（首跑实测：B0-10 变异后仍绿）。有区分力的只有**多行块**——光标跨行时"
                    "活动行换了 ⇒ 露出/收回。⚠️ 本条实测打红了 B5/B6/B7/B8/B10/B11 六条 -10"
                    "（都在 code / html 块上），这里只钉 B5/B7/B11 三条，留其余作旁证。"
                    "⚠️ 本条**不能由 M41 承担**：M41 只改施加点，而 `update` 只在 `tr.docChanged`"
                    "时重算 ⇒ 光标移动不触发重建（2026-11-11 `--only=blocks` 全量变异实测："
                    "M41 的新增红里没有 B0-10）。⚠️ 它同时会让 Q35 / Q36 红（进入那一帧光标就在"
                    "第一行）——同一处「标记可见性」的两个面，⛔ 别当独立证据。"
                    "⚠️ 负对照取 B0-4（块自身 top 不动）/ B0-6（滚动量不变）：本条只改「藏不藏」，"
                    "⛔ 不改块盒与外边距 ⇒ 它们必须仍绿",
                    保持绿=["B0-4", "B0-6"]))

检查.append(变异判据("M60", "m60.json", ["U3-task"],
                    "变异：`live/input.js::lineBreakAction` 的「空项删标记」那一支恒不成立"
                    "（`if (项 === li && … === '')` → `if (false)`）⇒ 空列表项上回车只会"
                    "续出一个新标记，而**不是**把标记删掉、让正文回到上一行行尾。"
                    "判据 U3（空项再回车删标记退列表：逐字比全文＋光标＋行号）必须红。"
                    "⚠️ 变异轮跑 tasks（三种列表行都在这一份里）；基线键带 `tasks/` 前缀。"
                    "⚠️ 负对照取 U2-task（非空项续标记，另一支）与 U1-task（行尾逐字键入）"
                    "⇒ 它们必须仍绿；红了说明变异碰到的不是「空项退出」这个面",
                    保持绿=["U2-task", "U1-task"],
                    基线键={k: "tasks/" + k for k in ["U3-task", "U2-task", "U1-task"]}))

检查.append(变异判据("M61", "m61.json", ["U2-ordered"],
                    "变异：`live/input.js::lineBreakAction` 的有序项续编号 `+ 1` → `+ 0`"
                    "⇒ 回车之后新行的标记仍是**原编号**。判据 U2（回车续项：逐字比"
                    "全文＋光标＋行号）在 ordered 那一份上必须红。"
                    "⚠️ 若 W7 选中的块恰好是有序项，W7c 也会红——同一处机制的第二面，"
                    "⛔ 别当独立证据。⚠️ 负对照取 U2-bullet / U2-task（续标记不数编号）"
                    "⇒ 必须仍绿",
                    保持绿=["U2-bullet", "U2-task"],
                    基线键={k: "tasks/" + k for k in ["U2-ordered", "U2-bullet", "U2-task"]}))

检查.append(变异判据("M62", "m62.json", ["B5-3a", "B5-5"],
                    "变异：`live/decorations.js::markers()` 的 `zwRanges` 退回空"
                    "（＝`bugs/0304` 修之前：行内代码反引号走 `Decoration.replace`，"
                    "零宽 + `cm-widgetBuffer`，UAX#14 让「（」之后又能断行）"
                    "⇒ `edges` 的说明段整段矮一行。判据 B5-3a（块高逐像素不变）与"
                    "B5-5（块外零位移）必须红。⚠️ 变异轮跑 edges；基线键带 `edges/` 前缀。"
                    "⚠️ 负对照取 B0-3a（标题块，没有行内代码）与 K1（回车落点，与折行无关）",
                    保持绿=["B0-3a", "K1"],
                    基线键={k: "edges/" + k for k in
                            ["B5-3a", "B5-5", "B0-3a", "K1"]}))

检查.append(变异判据("M63", "m63.json", ["Q36"],
                    "变异：`styles/live.css` 的 `.cm-content.cm-lineWrapping` 白空格模型"
                    "从 `pre-wrap` 改回 CM6 的 `break-spaces`（＝`bugs/0316` 修之前）"
                    "⇒ 折行点上的空格计入行宽、浏览器把前一个字一起退到下一行，"
                    "整段从该行起错后一个字。判据 reflow/Q36（逐视觉行文本＋行几何）必须红。"
                    "⚠️ 变异轮跑 reflow；基线键带 `reflow/` 前缀。"
                    "⚠️ 负对照取 Q35（标记隐藏与首视觉行文本，与空白模型无关）",
                    保持绿=["Q35"],
                    基线键={k: "reflow/" + k for k in ["Q36", "Q35"]}))

if os.environ.get("PROBE_W", "1000") == "760":
    检查.append(变异判据("M64", "m64.json", ["O-ol-4", "O-ol-5c"],
                        "变异：`live/selection.js::legalHiddenMapped` 的映射输入从"
                        "**未合并**的 `plan.rawRanges` 退回合并后的隐藏区间（＝`bugs/0317` 修之前）"
                        "⇒ 相邻隐藏区间之间的边界被抹掉，连续输入时第二个字落到反引号之后。"
                        "判据 O-ol-4 / O-ol-5c 必须红。⚠️ 变异轮跑 tasks；基线键带 `tasks/` 前缀。"
                        "⚠️ 负对照取 U2-ordered（回车续编号，不经过落点映射）：必须仍绿。"
                        "⚠️⚠️ **只在 PROBE_W=760 档产出本条**：默认 1000 宽下那条路径不可达"
                        "（`bugs/0317` §2），硬测会得到「HITS=1、0 红」的假变异——"
                        "所以施加与判据同由一个 `PROBE_W` 条件守着。",
                        保持绿=["U2-ordered"],
                        基线键={k: "tasks/" + k for k in
                                ["O-ol-4", "O-ol-5c", "U2-ordered"]}))

检查.append(变异判据("M65", "m65.json", ["K5a"],
                    "变异：`live/input.js::lineBreakAction` 的 ④′ 分支条件恒假"
                    "（`from <= li.contentFrom` → `from < 0`，＝`bugs/0314` 修之前）"
                    "⇒ 续行行首回车重新写前缀、留下只有空白的幻行。"
                    "判据 edges/K5a（续行行首回车不留幻行）必须红。"
                    "⚠️ 变异轮跑 edges；基线键带 `edges/` 前缀。"
                    "⚠️ 负对照取 K4（引用内空项回车）与 K1（标题行首回车），都是回车路径的邻支",
                    保持绿=["K4", "K1"],
                    基线键={k: "edges/" + k for k in ["K5a", "K4", "K1"]}))

检查.append(变异判据("M66", "m66.json", ["K3"],
                    "变异：`main.js::deleteRange` 不再把块前缀递给删除层（`prefix: null` ⇒"
                    "回落隐藏集合，＝`bugs/0111` A6 修之前）⇒ `> - ` 与成对行内标记并成一条链，"
                    "一次 ⌫ 删掉两层。判据 edges/K3（只退列表一层、引用标记留下）必须红。"
                    "⚠️ 变异轮跑 edges；基线键带 `edges/` 前缀。"
                    "⚠️ 负对照取 K4／K7（都是回车路径，不经过删除层）：必须仍绿",
                    保持绿=["K4", "K7"],
                    基线键={k: "edges/" + k for k in ["K3", "K4", "K7"]}))

检查.append(变异判据("M67", "m67.json", ["D3d"],
                    "变异：组合串的 `side` 翻回 `1`（2026-11-14 用户报告的形态）⇒ 自绘插入符"
                    "画在串的**左缘**，上屏后跳到串右缘。判据 D3d（插入符画在串之后）必须红。"
                    "⚠️ 负对照 D3／D3b／D3c 必须仍绿：它们证的是行内／占版面／落在哪一格，"
                    "与「画在串的哪一侧」是两面",
                    保持绿=["D3", "D3b", "D3c"]))

检查.append(变异判据("M68", "m68.json", ["O-h1-1"],
                    "变异：`styles/live.css` 的 `.cm-line.cm-rmd-h1` 去掉 "
                    "`color: var(--reader-heading)`（＝`design/0085` C5 修之前的形态）"
                    "⇒ 标题字色回落到继承的 `--reader-text`（比正文浅一档）。"
                    "判据 O-h1-1（进入时逐行样式含标题字色）必须红。"
                    "⚠️ 变异轮跑 shapes；基线键带 `shapes/` 前缀。"
                    "⚠️ 负对照取 B0-3a（字色不影响几何）：块高必须仍逐像素不变",
                    保持绿=["B0-3a"],
                    基线键={k: "shapes/" + k for k in ["O-h1-1", "B0-3a"]}))

检查.append(变异判据("M69", "m69.json", ["O-blockquote2-1"],
                    "变异：`styles/live.css` 第 2 层引用的 `padding-left` 少乘一层"
                    "（`* 2` → `* 1`）⇒ 第 2 层正文的文字左缘比阅读态少一个引用让位"
                    "（≈17.5 px）。判据 O-blockquote2-1（嵌套引用文字左缘 == 阅读态）必须红。"
                    "⚠️ 变异轮跑 shapes；基线键带 `shapes/` 前缀。"
                    "⚠️ 负对照取 O-blockquote-1（那份引用块没有嵌套，层 1 不挂属性）",
                    保持绿=["O-blockquote-1"],
                    基线键={k: "shapes/" + k for k in ["O-blockquote2-1", "O-blockquote-1"]}))

检查.append(变异判据("M70", "m70.json", ["O-p-6b"],
                    "变异：`live/box.js` 写 host 样式时退回 swap 时的 px 快照"
                    "（`box[css]`），不再写 `calc(var(--reader-font-size) * k ± b)`"
                    "（＝`design/0085` C2 修之前的形态）⇒ 根字号改了以后已挂载的块不跟。"
                    "判据 O-p-6b（改根字号后已挂载的块跟着重解析）必须红。"
                    "⚠️ 变异轮跑主夹具（`blocks`）；基线键不带前缀。"
                    "⚠️ 负对照取 B0-3a（14 px 下表达式与快照数值相等）：块高必须仍逐像素不变",
                    保持绿=["B0-3a"],
                    基线键={k: k for k in ["O-p-6b", "B0-3a"]}))

def 排序键(c):
    i = str(c["id"])
    # ⚠️ 只有 `夹具/判据` 这一种 id 才该按 "/" 切——判据**正文里也可能带斜杠**
    #    （例：`H8 退出后写授权收回（begin_edit / end_edit 配平）`），
    #    直接 `split("/")[-1]` 会把它切成 `' end_edit 配平）'` ⇒ 前缀一条都匹配不上，
    #    ⛔ 于是那条判据静默掉到最后一档（2026-10-26 实测踩到）。
    前缀 = i.split(" ", 1)[0].split("/", 1)
    带夹具 = len(前缀) == 2
    head = (前缀[1] + i[len(前缀[0]) + 1:]) if 带夹具 else i
    for pre in ("M", "A", "B-", "D-", "G-", "H-", "L-", "N-", "O-", "P-", "Q-", "R-", "Y", "C", "D", "G", "H", "L", "N", "O", "P", "Q", "R", "E", "B", "Z"):
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
    "分段": {"G": G表, "K": K表, "L": L表, "P": P表, "Q": Q表, "U": U表, "V": V表, "W": W表, "Y": Y表},
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
