#!/usr/bin/env bash
#
# 主题的两条自动化闸门 —— `design/0004` §7 表下的那一段。
#
# ⚠️ **这两条都不是"锦上添花"**，它们是两条不变量的**唯一**自动化防线：
#
#   ① `INV-THEME-02`：组件样式只允许引用第 2 层语义变量。
#      ⛔ 写死一处 `#333`，深色主题下那一处就永远是不可读的深色——
#      **浏览器不会报错**，只会漏出一个"忘了改"的角落。
#   ② §2.1.1.1 的**最低契约**：20 个「必须」变量每套主题都要显式给值。
#      ⚠️ 缺项时浏览器**静默回落**到 `:root` 的值，不报错、不报警——
#      只有显式清单校验能发现，⛔ 打开看看是看不出来的。
#
# ⚠️ 这个脚本**故意用最笨的 grep/awk**：它要能在一个**没有 CI**、
#    没有 node_modules、没有 python 的裸机上跑（本项目 2026-10-13 就是这种状态）。
#    用 jq / 解析器会更优雅，但会在最需要它的地方跑不起来。
#
# 用法：`make lint-theme`（或直接 `bash scripts/lint-theme.sh`）

set -u

cd "$(dirname "$0")/.." || exit 2

fail=0
say() { printf '%s\n' "$*"; }

# ─────────────────────────────────────────────────────────────────────────
# 闸门 ①：字面色值
# ─────────────────────────────────────────────────────────────────────────

# 允许出现字面色值的**只有两个文件**：
#   - tokens.css：第 1 层原始色板，色值的**唯一定义处**
#   - themes.css：各主题覆盖，每套主题本来就得写出自己的色值
ALLOWED='^src/styles/(tokens|themes)\.css:'

# ⭐ `design/0012` §2.5：`src/vendor/cm6.bundle.js` 是**产物**（`make cm6` 产出，⛔ 不入库），
#    它的主题色是**上游**写死的（`#167` / `#00c` …），不是本仓能改的东西
#    ⇒ 它**必须**从闸门 ① 里排除，否则这条闸门对 bundle 一建出来就永远红。
#
# ⛔⛔ **只排除这一个文件**，⛔ **不是**整个 `src/vendor/`：
#    以后若有人往 `src/vendor/` 下写**自己的**代码，那代码**必须**照样受这条闸门管。
#    「排除整个目录」的写法（`src/vendor/`）更省事，代价是那条规则**静默失效**——
#    与 `tests/js/keymap.test.js` 的 `是产物(rel)` 是同一条纪律（那边还配了诱饵断言）。
# ⚠️ 路径是**字面**的（只有 `\.` 一处转义），⛔ 不许加通配符。
VENDOR='^src/vendor/cm6\.bundle\.js:'

# ⚠️ **诱饵自检**（照 `keymap.test.js` 那条）：验证 `$VENDOR` **真的只**排掉那一个文件。
#    ⛔ 少了这一步，写宽一个字符（比如 `src/vendor/`）不会报错，只会**静默地少查一片代码**。
#
# ⚠️⚠️ 变量名**必须是 ASCII**：`for 诱饵 in …` 在 **bash** 里直接报
#    `not a valid identifier`，而本脚本只有 `set -u`（**没有 `set -e`**）⇒
#    那一行只往 stderr 吐一句话、循环体**一次都不执行**，脚本照样打印"全绿"。
#    ⭐ 2026-10-15 实测踩到：诱饵自检**静默失效**了整整一轮，正是它自己要挡的形状。
#    （zsh 允许非 ASCII 标识符 ⇒ 用 zsh 跑或肉眼看都会以为它是好的。）
BAIT_VENDOR='src/vendor/别的文件.js:1:color: "#fff"'
# ⚠️ 第二个诱饵是**反向**的：`src/styles/editor.css` **从来不该**被排除，
#    它保证"排除"没有宽到把真正受管的组件样式也漏掉。
BAIT_STYLES='src/styles/editor.css:1:color: "#fff"'
for BAIT in "$BAIT_VENDOR" "$BAIT_STYLES"; do
  if printf '%s\n' "$BAIT" | grep -Eq "$VENDOR"; then
    say "⛔ 闸门 ① 的排除清单太宽：它把「${BAIT}」也排掉了"
    fail=1
  fi
done

say '── 闸门 ①：字面色值（INV-THEME-02）──'
hits=$(
  grep -rEn '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' src/ \
       --include='*.css' --include='*.js' --include='*.ts' 2>/dev/null \
  | grep -Ev "$ALLOWED" \
  | grep -Ev "$VENDOR" \
  | grep -Ev ':[0-9]+:[[:space:]]*(/\*|\*|//)' \
  | grep -Ev ':[0-9]+:[[:space:]]*[^:]*//' \
  || true
)
# ⚠️ 上面排掉注释行（`/* 写死 #333 之后… */`）：注释里举例子**不是**违反。
#    没有这一步，文档写得好反而会被自己的检查卡住。

if [ -n "$hits" ]; then
  say '⛔ 这些地方写死了色值——深色主题下它们不会跟着变：'
  printf '%s\n' "$hits"
  fail=1
else
  say '✅ 干净：色值只出现在 tokens.css 与 themes.css'
fi

# ─────────────────────────────────────────────────────────────────────────
# 闸门 ②：最低契约（每套主题是否给全了 20 个「必须」变量）
# ─────────────────────────────────────────────────────────────────────────

# ⚠️ 这份清单与 `design/0004` §2.1.1.1 的表**逐字对应**。
#    改设计时**必须**同时改这里——它会红，正是它有用的地方。
# ⭐ 2026-10-14 按 `design/0007` §3 扩了三族（高亮 13 + 公式 4 + 图表 16）：
#    它们全是**颜色**（`INV-THEME-04` 的"会随主题变"那一侧），
#    所以每一套主题都得显式给值——⛔ 缺项的后果是**静默回落**到 light 值。
# ⭐ 2026-10-14 又按 `design/0011` §3 扩了 **4** 个（正文内查找的两档高亮 × 底/字）：
#    ⚠️ 与 `0007` 那次不同，**这次变量名是新增的** ⇒ 数从 53 变 **57**。
#    ⚠️ 为什么非要四个：`::highlight()` 的 `color` 会盖掉正文色，
#    只给底色不给字色 ⇒ 深色主题下"深底 + 深字"。`INV-FIND-07` 要的正是这一对。
# ⭐ 2026-10-25 按 `design/0046` 再扩 **1** 个（`reader-table-head-bg`，表头底色）：
#    ⚠️ 又一个**新增变量名** ⇒ 57 变 **58**。
#    ⚠️ 为什么必须进契约：它三套的值**各自不同**（light 冷蓝 / warm 米黄 / dark 深灰），
#    漏给一套会**静默回落**到 light 那个冷蓝——在暖纸或深底上就是一块贴错的白纸。
#    ⚠️ 引用条 `reader-quote-bar-color` 本来就在契约里，这次只是**换值**
#    （半透明 → 实色），⛔ 不是新增成员。
# ⭐ 2026-11-03 按 `design/0060`（Mermaid 直传）再扩 **4** 个
#    （teal-bg / violet-bg / steel-bg / note-bg）：58 变 **62**。
#    ⚠️ 0.33.0 的引擎色板比 0.27.0 多出三块浅底与一块便签黄；漏给一套会**静默回落**
#    到 light 的浅色值 ⇒ 深色主题上露出一块白。
# ⭐ 2026-11-03 同日、评审 P0-5 再扩 **5** 个（panel / panel-line / ink-soft /
#    rose-bg / coral-bg）：62 变 **67**。⚠️ 全是**新增变量名**，不是换值：
#    子图面板与簇标题原先**没有槽**（落进"未知色值"），journey 八色段落底缺两头。
#    ⛔ 别把它们合并进 `guide` / `line-soft`——那几条是**线**，拿来当底或当字，
#    在浅色主题下要么淡到看不见，要么与真正的线同色。
# ⭐ 2026-11-04 按 `bugs/0073` 再扩 **1** 个（`reader-diag-on-accent`）：67 变 **68**。
#    ⚠️ 又一个**新增变量名**：强调查色块上的**引擎深字**在 dark/warm 下必须留深，
#    ⛔ 不能跟 `reader-diag-text` 一起变浅（那是 1.44–2.88 : 1，等于看不见）。
#    漏给一套会**静默回落**到 light 的深字 ⇒ 深色主题上正是这个缺陷本身。
# ⭐ 2026-11-04 同日、`bugs/0073` 再扩 **8** 个（八条强调族的 `-ink`，强调色**当文字**时用）：
#    68 变 **76**。⚠️ 又一个**新增变量名族**：`-line` 那批是给**填充/描边**挑的，
#    直接拿来当 13px 字，light 上只有 2.6–4.4 : 1 ⇒ 每族另给一档 ≥4.6 : 1 的深墨。
#    ⚠️ dark 这八条与 `-line` **同值**（深色下强调色本来就亮），⛔ 别以为重复就删掉——
#    契约管的是"每套主题各给一份"，漏给会静默回落成 light 的深墨 ⇒ 深底上看不见。
REQUIRED="ui-bg ui-bg-elevated ui-text ui-text-muted ui-border ui-hover-bg ui-selected-bg ui-accent
reader-text reader-bg reader-heading reader-border reader-link reader-selection-bg
reader-inline-code-bg reader-inline-code-text reader-block-code-bg reader-block-code-text
reader-quote-bar-color reader-quote-bg reader-table-head-bg
reader-find-hit-bg reader-find-hit-text reader-find-current-bg reader-find-current-text
reader-hl-comment reader-hl-keyword reader-hl-string reader-hl-number reader-hl-function
reader-hl-type reader-hl-variable reader-hl-macro reader-hl-tag reader-hl-attr
reader-hl-operator reader-hl-punctuation reader-hl-invalid
reader-math-source-text reader-math-source-bg reader-math-source-border reader-math-error-accent
reader-diag-surface reader-diag-text reader-diag-on-accent reader-diag-line reader-diag-line-soft
reader-diag-green-bg reader-diag-green-line reader-diag-indigo-bg reader-diag-indigo-line
reader-diag-amber-bg reader-diag-amber-line reader-diag-guide
reader-diag-teal-bg reader-diag-violet-bg reader-diag-steel-bg reader-diag-note-bg
reader-diag-rose-line reader-diag-teal-line reader-diag-violet-line reader-diag-coral-line
reader-diag-steel-line reader-diag-panel reader-diag-panel-line reader-diag-ink-soft
reader-diag-rose-bg reader-diag-coral-bg
reader-diag-green-ink reader-diag-indigo-ink reader-diag-amber-ink reader-diag-rose-ink
reader-diag-teal-ink reader-diag-violet-ink reader-diag-coral-ink reader-diag-steel-ink"

say ''
say '── 闸门 ②：最低契约（§2.1.1.1 的 20 个 ＋ `0007` 的 33 个 ＋ `0011` 的 4 个）──'

# 取出一个选择器块的内容（从该选择器那一行，到下一个顶格 `}`）。
#
# ⚠️ 用**字面前缀比对**（`index()`），⛔ 不用动态正则：
#    `-v` 会吃掉反斜杠转义——传 `^\[data-theme` 进去，awk 拿到的是 `^[data-theme`，
#    于是报 `nonterminated character class` 并**整段不匹配**（macOS 自带 BWK awk，
#    2026-10-13 实测踩到）。前缀比对没有这个坑，而且这里本来也不需要正则。
block_of() { # $1=文件 $2=选择器前缀（字面）
  awk -v sel="$2" '
    index($0, sel) == 1 { inside = 1 }
    inside { print }
    inside && /^}/ { inside = 0 }
  ' "$1"
}

check_block() { # $1=标签 $2=要查的文本
  local label="$1" body="$2" missing="" n=0 v
  for v in $REQUIRED; do
    n=$((n + 1))
    printf '%s\n' "$body" | grep -Eq -- "--$v *:" || missing="$missing $v"
  done
  if [ -n "$missing" ]; then
    say "⛔ $label 缺 $(( n - $(printf '%s' "$missing" | wc -w) ))/$n —— 缺的是：$missing"
    fail=1
  else
    say "✅ ${label}：$n/$n"
  fi
}

# light 住在 tokens.css 的 `:root`（§2.1.1.1：它给全部「必须」变量一套默认值）
check_block 'light（tokens.css :root）' "$(block_of src/styles/tokens.css ':root')"

if [ -f src/styles/themes.css ]; then
  check_block 'dark' "$(block_of src/styles/themes.css '[data-theme="dark"]')"
  check_block 'warm' "$(block_of src/styles/themes.css '[data-theme="warm"]')"
else
  say '⛔ 找不到 src/styles/themes.css'
  fail=1
fi

say ''
if [ "$fail" -eq 0 ]; then
  say '✅ lint-theme 全绿'
else
  say '⛔ lint-theme 有失败项（见上）'
fi
exit "$fail"
