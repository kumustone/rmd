#!/usr/bin/env bash
# 跑「编辑态 Vim 键位」的**真 DOM 离屏探针**（`docs/design/0014` §7 步骤 0：0b/0c/0d-①/0e/0f）
#
# 用法：
#   tools/wkwebview-probe/vim-keys-probe.sh            # 只打屏幕，判据进退出码
#   tools/wkwebview-probe/vim-keys-probe.sh --save     # 另存一份到 benchmarks/results/
#   tools/wkwebview-probe/vim-keys-probe.sh --save --force   # 允许覆盖同名结果
#   tools/wkwebview-probe/vim-keys-probe.sh --json     # 只打原始 JSON
#
# 退出码：0 = 全通过；1 = 有检查**失败**；2 = 有检查**跳过**（环境自证没过）；3 = 跑不起来
#
# ⚠️⚠️ **默认不落盘**：`benchmarks/results/` 是**历史记录**（`docs/README.md` §6），
#    而这一条是**闸门**（改一次 `src/editor/vim.js` / 键位 / 光标样式就该跑一次）。
#    要存证据时才 `--save`（那时仍拒绝覆盖，除非 `--force`）。
#
# ⚠️ 它跑的是**产品那几份**（`.sh` 从仓库里原样拷进页面）：
#      · `src/vendor/cm6.bundle.js`   —— `make cm6` 的产物（⛔ 不是 node_modules）
#      · `src/services/keymap.js`     —— 分发器
#      · `src/editor/keys.js`         —— 转发白名单的**唯一**派生处
#      · `src/styles/{tokens,themes,editor}.css` —— 真样式表（0e 全靠它们）
#      · `src-tauri/src/gui/mod.rs` 的 `SHORTCUTS` —— 本脚本用 python **现读**后喂给页面
#    ⛔ 探针**不抄第二份**键位表 / 白名单 / 样式表。这一族（"两端各写一半的契约"）
#    在 `docs/bugs/0003`/`0004`/`0005` 里已经三次出事，断的都是中间那一跳。
#
# ⚠️ 前置：`src/vendor/cm6.bundle.js` 必须先由 `make cm6` 产出（要 node）。
#    页面能起、但 CM6 不在时探针会**响亮地**报"bundle 没加载"，⛔ 不静默降级。
#
# ⚠️⚠️ **诚实性边界**（`design/0014` §7.1 那一行的口径）：
#    页面里 `dispatchEvent` 造出的是**不可信事件**，WebKit ⛔ **不会**为它执行默认编辑行为
#    ⇒ 本探针答得了「**页内谁处理了这个键**」，⛔ 答不了「**WebKit 会改什么**」。
#    后者的真按键证据在 `design/0012` §2.3-4 ＋
#    `benchmarks/results/editor-key-2026-10-16-Mac14,9.json`（71→72 / 51 / 70 / 70）。

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
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 3 ;;
  esac
done

BUNDLE="$ROOT/src/vendor/cm6.bundle.js"
KEYMAP="$ROOT/src/services/keymap.js"
KEYS="$ROOT/src/editor/keys.js"
GUI="$ROOT/src-tauri/src/gui/mod.rs"
HARNESS="$HERE/vim-keys-harness.js"
CSS_TOKENS="$ROOT/src/styles/tokens.css"
CSS_THEMES="$ROOT/src/styles/themes.css"
CSS_EDITOR="$ROOT/src/styles/editor.css"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 3
fi
for f in "$KEYMAP" "$KEYS" "$GUI" "$HARNESS" "$CSS_TOKENS" "$CSS_THEMES" "$CSS_EDITOR"; do
  [ -f "$f" ] || { echo "⛔ 缺 $f" >&2; exit 3; }
done
if [ ! -f "$BUNDLE" ]; then
  echo "⛔ 缺 $BUNDLE —— 先跑 make cm6（要 node；这是 design/0012 §2.5 的产品产物）" >&2
  exit 3
fi

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/vim-keys-${TODAY}-${MODEL}.json"
if [ "$SAVE" = "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 3
fi

WORK="$HERE/.cm6-work"
PAGE="$WORK/vk-page"
mkdir -p "$WORK" "$PAGE"

# ── ① 页面：产品那几份 + 探针自己的夹具，全部**拷进去**（⛔ 不用符号链接：
#      `allowingReadAccessTo` 是按目录给的，链接指到目录外读不到） ──
cp "$BUNDLE"     "$PAGE/bundle.js"
cp "$KEYMAP"     "$PAGE/keymap.js"
cp "$KEYS"       "$PAGE/editor-keys.js"
cp "$HARNESS"    "$PAGE/harness.js"
cp "$CSS_TOKENS" "$PAGE/tokens.css"
cp "$CSS_THEMES" "$PAGE/themes.css"
# ⚠️ `editor.css` **不拷**：它由 ③ 逐字节**内联**进页面（`<style id="editor-css">`）
#    —— 理由见 ③ 那段（`file://` 下链接样式表的 `cssRules` 读不到，而 0e 要读规则原文）。

# ── ② ⭐ 键位表**现读**：从 `gui/mod.rs` 的 `const SHORTCUTS` 抠出来喂给页面 ──
#      ⚠️ 这是本探针的**输入**，⛔ 不许有第三份手抄清单（`INV-SET-01` / `INV-EDIT-09`）。
#      ⚠️ 解析器**自带三条自检**：项数、必有 id、字段完整率 ——
#         Rust 侧一改格式就会"静默少读几项"，而少读的那几项**不会以任何方式报错**。
python3 -I - "$GUI" "$PAGE/shortcuts.js" <<'PY'
import json, re, sys

gui_path, out_path = sys.argv[1:3]
src = open(gui_path, encoding="utf-8").read()

# `id: MENU_SETTINGS_ID` 那两条的 id 是常量引用 ⇒ 先把常量表读出来替换掉。
consts = dict(re.findall(r'const\s+([A-Z_]+)\s*:\s*&str\s*=\s*"([^"]+)"\s*;', src))

start = src.find("const SHORTCUTS: &[Shortcut] = &[")
if start < 0:
    sys.exit("⛔ 找不到 `const SHORTCUTS` —— Rust 侧改名/换写法了，本探针的输入变了")
end = src.find("\n];", start)
if end <= start:
    sys.exit("⛔ 找不到 `SHORTCUTS` 的结尾 `];`")
body = src[start:end]

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
    # ⚠️ `design/0025` 起字段叫 `label_zh`（另有 `label_en`）——⛔ 别把 `_zh` 写死：
    #    这条正则同时接受旧名与新名，免得哪天再改名时这里**静默读到空串**
    #    （`label` 在下面只用于登记，空串不会让任何判据变红）。
    m = re.search(r'label(?:_zh)?:\s*"([^"]+)"', blk)
    label = m.group(1) if m else ""
    m = re.search(r"owner:\s*Owner::(Web|Menu|Other)", blk)
    if not m:
        continue
    owner = m.group(1).lower()
    m = re.search(r"aliases:\s*&\[([^\]]*)\]", blk)
    aliases = re.findall(r'"([^"]+)"', m.group(1)) if m else []
    rows.append({"id": rid, "accel": accel, "label": label, "aliases": aliases, "owner": owner})

# —— 解析自检：⛔ 少了这三条，格式一变就是"静默少测"，而输出里一个字都不会提 ——
if len(rows) < 15:
    sys.exit("⛔ 只读到 %d 项（表应有 ≥15）—— 解析器跟不上格式了，别把这个数当成'表变小了'" % len(rows))
ids = {r["id"] for r in rows}
for must in ("file.save", "edit.find", "edit.toggle", "settings.open", "view.toggle-sidebar"):
    if must not in ids:
        sys.exit("⛔ 读不到 `%s` —— 要么它没了、要么解析器没跟上（含常量 id 那两条）" % must)
if any(not r["accel"] for r in rows):
    sys.exit("⛔ 有行没有 accel —— 字段解析漏了")
if any(r["owner"] not in ("web", "menu", "other") for r in rows):
    sys.exit("⛔ 有行的 owner 没解析出来")

with open(out_path, "w", encoding="utf-8") as f:
    f.write("window.__SHORTCUTS = " + json.dumps(rows, ensure_ascii=False) + ";\n")
print("· 从 gui/mod.rs 现读 %d 条：%s" % (len(rows), "、".join(r["id"] for r in rows)), file=sys.stderr)
print("· web %d / menu %d / 常量 id 解析表 %d 个" % (
    sum(1 for r in rows if r["owner"] == "web"),
    sum(1 for r in rows if r["owner"] != "web"),
    len(consts)), file=sys.stderr)
PY

# ── ③ 页面壳 ──
#
# ⭐⭐ **2026-10-16：那两条块光标规则已从"候选"**搬进**产品**（`design/0014` 裁定 (d)）——
#    落点是 `src/styles/editor.css`（选择器逐字未改）＋ `src/styles/tokens.css`（`--ui-caret` 一族）。
#    ⇒ 这里**不再有候选副本**：`#cand` 换成了 `<style id="editor-css">`，
#      **内容逐字节取自** `src/styles/editor.css`（⛔ 探针不抄第二份规则）。
#      ⚠️ 反向对照照旧：`sheet.disabled = true` 一按，同一格必须回到上游写死的粉
#      —— 那才是"我们的规则真的赢了"的**证据**（⛔ 不是"特异性我算过、够高"）。
#      ⚠️ 停用的是**整张产品表**（不只是那两条），所以这条对照证的是
#      "产品表在承重"这件事本身；⛔ 恰恰因为如此，它**不可能**由"探针自己那份规则"伪造。
#
# ⚠️⚠️ **为什么是内联 `<style>` 而不是 `<link rel="stylesheet" href="editor.css">`**：
#    `file://` 下**链接**样式表的 `cssRules` 读不到（`SecurityError`，WKWebView 把 file 源
#    当不透明源）——而 0e 有一半判据正是"把命中规则的 `selectorText` / `cssText` 打出来"
#    （裁定 (d) 原话：「具体选择器由**锁定版本的真实样式**验证」）。内联才读得到。
#    ⚠️ 两种形态在这里**级联等价**：同一份字节、同一个位置（CM6 的 baseTheme 是**运行时注入**
#    `<head>` 的、永远排在后面 ⇒ 谁赢从来只由**特异性**决定，见 `editor.css` 文件头）。
#    ⛔ 也就是说：这一步只改"探针怎么装它"，⛔ 不改"探针验什么"。
#
# ⚠️ 页面用 `body.editing` ＋ `.editor-host`：与产品 `editor.css` 的选择器**同形**，
#    ⛔ 否则"我们的规则赢没赢"测的是一个**形状不同**的东西（那是本族最经典的假绿）。
#
# ⚠️ 内容里一旦出现 `</style` 就会把页面切坏（HTML 的 raw-text 元素只认它）⇒ 先自检。
if grep -q '</style' "$CSS_EDITOR"; then
  echo "⛔ $CSS_EDITOR 里出现了 </style —— 它没法内联进 <style> 元素" >&2
  exit 3
fi
cat > "$PAGE/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>rmd · vim-keys probe</title>
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="themes.css">
HTML
# ⭐ 产品那张表：**逐字节**拷进来（见上面那段：内联只为让 `cssRules` 读得到）
{ printf '<style id="editor-css">\n'; cat "$CSS_EDITOR"; printf '\n</style>\n'; } >> "$PAGE/index.html"
cat >> "$PAGE/index.html" <<'HTML'
<style>
  html, body { margin: 0; height: 100%; }
  body { background: var(--ui-bg); color: var(--ui-text); }
  #wrap { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
  .editor-host { height: 420px; overflow: hidden; }
  .cm-editor { height: 100%; }
  .cm-scroller { font-family: ui-monospace, Menlo, monospace; font-size: 14px; line-height: 1.6; }
  /* ⚠️ 下面这一组是**量色块**（⛔ 不解析字符串里的 var()——链要真的解开才算数）。
     每个 `sw-*` 用**一个**属性去取一个变量：`color` 取色值、`background-color` 也取色值。 */
  #swatch { position: fixed; left: -9999px; top: -9999px; }
  #sw-text        { color: var(--ui-text); }
  #sw-bg          { background-color: var(--ui-bg); }
  #sw-accent      { color: var(--ui-accent); }
  #sw-caret       { color: var(--ui-caret); }
  #sw-caret-text  { background-color: var(--ui-caret-text); }
</style>
<!-- ⚠️ `class="editing"` 是**必须的**：产品 `editor.css` 的每一条都挂在 `body.editing` 下
     ⇒ 不带这个类，那些规则**一条都不生效**，而探针会得到一堆"看起来正常"的默认值。 -->
<body class="editing">
<div id="swatch">
  <span id="sw-text"></span><span id="sw-bg"></span><span id="sw-accent"></span>
  <span id="sw-caret"></span><span id="sw-caret-text"></span>
</div>
<div id="wrap">
  <div class="editor-host" id="host-a"></div>
  <div class="editor-host" id="host-b"></div>
  <div class="editor-host" id="host-c"></div>
  <div class="editor-host" id="host-p"></div>
</div>
<!-- ⚠️ 顺序：bundle（全局 rmdCM6）→ 表 → 产品那两份 → 夹具。
     ⛔ 与 `src/index.html` 里那三条硬约束同一回事（经典脚本按顺序执行、依赖先于取值）。 -->
<script src="bundle.js"></script>
<script src="shortcuts.js"></script>
<script src="keymap.js"></script>
<script src="editor-keys.js"></script>
<script src="harness.js"></script>
HTML

# ── ④ 编译探针 ──
BIN="$WORK/vim-keys-probe"
if [ ! -x "$BIN" ] || [ "$HERE/vim-keys-probe.swift" -nt "$BIN" ]; then
  echo "▶ 编译探针…" >&2
  swiftc -O "$HERE/vim-keys-probe.swift" -o "$BIN" >"$WORK/vk-build.log" 2>&1 || {
    echo "⛔ 编译失败：" >&2; cat "$WORK/vk-build.log" >&2; exit 3
  }
fi

RAW="$WORK/vk-raw.json"
ERR="$WORK/vk.err"
echo "▶ 跑探针（⚠️ 全程**一个不可见窗口**、无前台切换、无合成系统按键；实测约 20–40 秒）…" >&2
# ⚠️ macOS **没有** `timeout(1)`：探针自己带 200 秒兜底，这里再套一层 360 秒看门狗。
"$BIN" "$PAGE" >"$RAW" 2>"$ERR" &
pid=$!
for _ in $(seq 1 720); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$pid" 2>/dev/null; then
  echo "⛔ 360 秒没结束，强杀。" >&2
  kill -9 "$pid" 2>/dev/null || true
  exit 3
fi
wait "$pid" 2>/dev/null || true

if ! grep -q '^{' "$RAW" 2>/dev/null; then
  echo "⛔ 探针没产出 JSON。stderr：" >&2
  sed -n '1,60p' "$ERR" >&2
  exit 3
fi
sed -n '1,20p' "$ERR" >&2 || true

# ── ⑤ 判据汇总：**退出码就是结论** ──
python3 -I - "$RAW" "$TO_JSON" "$SAVE" "$OUT" "$MODEL" "$TODAY" <<'PY'
import json, platform, sys

raw_path, to_json, save, out, model, today = sys.argv[1:7]
raw = json.load(open(raw_path, encoding="utf-8"))

if "致命" in raw:
    print("⛔ 致命：" + str(raw["致命"]), file=sys.stderr)
    print(json.dumps(raw, ensure_ascii=False, indent=2), file=sys.stderr)
    sys.exit(3)

检查 = raw.get("检查") or []
通过 = [c for c in 检查 if c["结果"] == "通过"]
失败 = [c for c in 检查 if c["结果"] == "失败"]
跳过 = [c for c in 检查 if c["结果"] == "跳过"]
未判定 = [c for c in 检查 if c["结果"] not in ("通过", "失败", "跳过")]

doc = {
    "schema": "rmd-vim-keys-probe/1",
    "date": today,
    "口径": {
        "说明": "docs/design/0014 §7 步骤 0（0b/0c/0d-①/0e/0f）：编辑态 Vim 键位的**接线与样式**，"
                "在真 WKWebView 里逐条 dispatch。",
        "被测文件": {
            "bundle.js": "src/vendor/cm6.bundle.js（make cm6 的产物；含 @replit/codemirror-vim）",
            "keymap.js": "src/services/keymap.js（唯一分发器，原样拷入）",
            "editor-keys.js": "src/editor/keys.js（转发白名单的**唯一**派生处，原样拷入）",
            "styles": "src/styles/{tokens,themes,editor}.css（原样拷入 —— 0e 全靠它们）",
            "表": "src-tauri/src/gui/mod.rs 的 `SHORTCUTS`（本脚本用 python **现读**，⛔ 无第三份手抄）",
            "夹具": "tools/wkwebview-probe/vim-keys-harness.js",
        },
        "⚠️ 诚实性边界": "页面内 `dispatchEvent` 造的是**不可信事件**，WebKit ⛔ 不会为它执行默认编辑行为"
                      "⇒ 本探针答得了『页内谁处理了这个键』，⛔ 答不了『WebKit 会改什么』。"
                      "后者的真按键证据在 design/0012 §2.3-4 ＋ "
                      "benchmarks/results/editor-key-2026-10-16-Mac14,9.json（71→72 / 51 / 70 / 70）。",
        "⚠️ 另一条边界": "离屏窗口里 DOM 选区改动落不下来（editor-keyprobe 的判别器实测）"
                      "⇒『移光标』那一族在本形态下结构性测不出，本探针**不测** ⌃A/⌃B/⌃E/⌃F/⌃N/⌃P。",
        "⚠️ 组合态边界": "合成 `compositionstart` 造得出 IME 的**事件形状**，⛔ 造不出真实的 input 记录流"
                      "（WebKit 只为**可信**输入发 beforeinput/input）⇒ CM6 的 `inputState.composing` 停在 0，"
                      "`ignoreDuringComposition` 那条 `> 0` 的守卫在本形态下**不会被触发**。"
                      "⇒ 0d 测的是**页内 Vim 自己**的守卫；真实 IME 的观感仍归人工（0d-②）。",
        "⚠️ 0e 的前提": "12 格的判据都压在『`.cm-fat-cursor` 真的画出来了』上；"
                     "E4 单独判那件事（布局正常且 rAF 在跑却没有块光标 = **失败**，不是跳过）。",
        "机器": f"{model} / macOS {platform.mac_ver()[0]} / {platform.machine()}",
        "⚠️ 离屏": "窗口 alphaValue=0 ＋ orderBack ＋ makeKey ⇒ **不弹窗、不抢焦点、不合成系统按键**"
                 "（根 CLAUDE.md 约定 4）。⚠️ `orderBack` 不是可选项：只 alpha=0 而从不 order 的窗口"
                 "WebKit **一帧 rAF 都不派**（scroll-sync-probe 第一版实测 1000 ms / 0 帧）——"
                 "而 0e 那一族正靠 measure 循环。代价是环境要**每次自证**：E1(rAF) / E3(activeElement) / "
                 "E4(块光标画出来了)，＋ swift 侧比一次 `frontmostApplication`（被抢过就别信这次数）。",
    },
    "环境": {
        "machine_model": model,
        "os_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "python": platform.python_version(),
        "页面自证": raw.get("环境"),
    },
    "夹具": raw.get("夹具"),
    "检查": 检查,
    "结论": raw.get("结论"),
}

if to_json == "1":
    print(json.dumps(doc, ensure_ascii=False, indent=2))
else:
    if 失败:
        print("⛔ 编辑态 Vim 键位：**没通过**", file=sys.stderr)
    elif 跳过:
        print("⚠️ 编辑态 Vim 键位：有 %d 条**没判定**（环境不成立，⛔ 不是失败）" % len(跳过), file=sys.stderr)
    else:
        print("✅ 编辑态 Vim 键位：%d 条全通过" % len(通过), file=sys.stderr)
    for c in 检查:
        mark = {"通过": "✅", "失败": "⛔", "跳过": "⏭"}.get(c["结果"], "?")
        print("%s %-22s %s" % (mark, c["id"], c["名"]), file=sys.stderr)
        if c["结果"] != "通过":
            print("      判据：%s" % c["判据"], file=sys.stderr)
            print("      实测：%s" % json.dumps(c["值"], ensure_ascii=False), file=sys.stderr)
        elif c["id"] in ("E1", "E2", "E3", "E4", "0b-4", "0e-规则原文", "0e-反向对照"):
            # ⭐ 这几种"结论本身"要让读者不必翻 JSON 也能看见（否则它们等于没跑）
            print("      实测：%s" % json.dumps(c["值"], ensure_ascii=False), file=sys.stderr)
    for key, val in (raw.get("环境") or {}).items():
        print("· 环境.%s = %s" % (key, json.dumps(val, ensure_ascii=False)), file=sys.stderr)
    print("· 夹具 = %s" % json.dumps(raw.get("夹具"), ensure_ascii=False), file=sys.stderr)
    print(json.dumps(doc, ensure_ascii=False, indent=2))

if 未判定:
    print("⛔ 有检查的结果字段不是 通过/失败/跳过：%s" % json.dumps(未判定, ensure_ascii=False), file=sys.stderr)
    sys.exit(3)
if save == "1":
    import os
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("✅ 结果写入 %s" % out, file=sys.stderr)

sys.exit(1 if 失败 else (2 if 跳过 else 0))
PY
