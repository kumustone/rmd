#!/usr/bin/env bash
# rmd 的验收冒烟：**真开窗口**，让程序自己判定通过与否。
#
#     tools/smoke-gui.sh                 # 文件 4 个（XL 语料）+ 目录 2 个 + 裸跑 1 个（默认）
#     tools/smoke-gui.sh FILE.md         # 只跑指定的（文件或目录都可以）
#     tools/smoke-gui.sh --               # 只跑**裸跑**（不带参数）这一个用例
#
# # 为什么需要这个脚本
#
# `design/0002` §10.4 批 1 的验收是「`rmd <文件>` 打开窗口，**10 MB 中文文档能显示、能滚动**」；
# `design/0003` 批 3 的验收多了「**目录模式下文件树真的建出来了**」。
# 但那是个 GUI 窗口——**Agent 看不到它**。没有这条自动化，
# "能显示"就只能验成"进程没崩"，**等于没验**。
#
# # 它到底验了什么
#
# 前端在把 HTML 放进 DOM 之后，把**它自己量到的**数回报给后端
# （`src-tauri/src/gui/mod.rs` 的 `FrontendReport`），**判据写在 Rust 里**，⛔ 不靠人眼看输出：
#
#   · `doc_children` / `text_len` > 0    —— HTML 真的建出了节点、文字真的进去了
#   · `doc_loaded` 时还要求 `scroll_height` > 1.5×视口 —— **"能滚"的直接证据**
#     （⚠️ 目录模式下**不自动开文件**是 `0003` §2.1 明确的设计，所以那时"能滚"不算判据）
#   · 目录模式下 `tree_nodes` > 0        —— **文件树真的建出来了**
#   · `tree_current` ≤ 1                 —— 当前项高亮**至多一个**
#   · 前端推导的模式 == 后端声明的模式    —— 两边不许各说各话
#   · 单文件启动**必须**真挂上文档且能滚 —— ⛔ "什么都没打开"不算通过
#     ⚠️ 2026-10-13 实测：判据只看前端回报时，**启动文档没被打开**那一版照样 PASS
#     ⇒ 现在判据同时查后端 `Session::mode()`（那是**声明**，不是前端推导的）
#   · 空会话里若后端记着"上次打开的目录"，界面上就得有那条提示（§2.1.1 第 4 条）
#
# ⚠️ 屏幕上会闪一下窗口——`RMD_SMOKE=1` 让它自证完就自己退出，不会留着。
# ⚠️ 必须先 `make build-gui`。本脚本**不**替你构建——
# 构建要几分钟，混在一起会让"是构建坏了还是渲染坏了"分不清。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BIN="$ROOT/src-tauri/target/release/rmd"

if [ ! -x "$BIN" ]; then
  echo "✗ 没有 ${BIN}，先跑 make build-gui" >&2
  exit 1
fi

# 默认：4 个 XL 文件 + 2 个目录。
# ⚠️ tables 是**最坏情形**（860 837 个 AST 节点，见 docs/research/notes/0005 §4.2）——
#    只跑 plain 就等于只测了最容易的那个。
if [ "$#" -gt 0 ]; then
  CASES=("$@")
else
  CASES=(
    "$ROOT/benchmarks/corpus/XL-plain.md"
    "$ROOT/benchmarks/corpus/XL-headings.md"
    "$ROOT/benchmarks/corpus/XL-code.md"
    "$ROOT/benchmarks/corpus/XL-tables.md"
    # ⭐ 目录模式（`design/0003`）：语料目录是"干净的一层"
    "$ROOT/benchmarks/corpus"
    # ⭐ 目录模式 + **忽略清单**：`src-tauri/` 下有 `target`，
    #    它必须**可见、灰显、点不动**，且**从未被扫描**（§7 步骤 5 的日志判据）。
    "$ROOT/src-tauri"
    # ⭐ **裸跑**（没有参数）= 空会话（§2.1.1 第 4 条）。⚠️ 用 `-` 表示"不带参数"，
    #    不是文件；上面的目录用例刚把 `last_directory` 写进配置，
    #    所以这一个用例顺带验了"**上次打开的目录**有没有真的画出来"。
    "-"
  )
fi

FAILED=0
for c in "${CASES[@]}"; do
  args=("$c")
  name="$(basename "$c")"
  kind="文件"
  if [ "$c" = "-" ]; then
    # ⭐ 裸跑：**不带任何参数**，验空会话
    args=()
    name="（不带参数）"
    kind="空会话"
  else
    if [ ! -e "$c" ]; then
      echo "✗ $name 不存在（文件类先跑 make corpus）" >&2
      FAILED=$((FAILED + 1))
      continue
    fi
    [ -d "$c" ] && kind="目录"
  fi

  echo "───────── ${kind}「${name}」─────────"
  # ⚠️ `set -e` 下不能让失败直接退出循环——要把每个用例都跑完再汇总。
  out="$(RMD_SMOKE=1 "$BIN" "${args[@]}" 2>&1)" || true
  # 第 1 行是「▶ rmd 打开 …」；后面是会话、`open_document`、`list_dir` 与前端回报。
  # ⚠️ 第 1 行是「▶ rmd 打开 …」或「▶ rmd 启动（没有参数…）」——跳过它
  echo "$out" | sed -n '2,13p' | sed 's/^/  /'
  # ⭐ `design/0010` 的判据（表 / 菜单 / 动作自检）在更下面。**按标记取**，
  #    ⛔ 不"把上面那个 sed 范围调大"——固定窗口会随着新增的 `eprintln!` 悄悄漏掉新判据，
  #    而漏掉的表现是"判据加了、屏幕上却看不见"，正是本项目最不该出现的那种静默。
  # ⭐ `design/0006` 的 `监视：`一行同样按标记取：它同时打出**前端认下的 seq**、
  #    后端手里那一份、以及"说明"（降级原因）——三者中任何一个不对，
  #    自动刷新就是静默失效的。
  # ⭐ `design/0011` 的 `查找：`一行同理：段数 / 探测词命中 / 哨兵命中 / 自证——
  #    前三个数是**前端自己跑完一遍查找**量出来的（⛔ 不是"我打开窗口看了一眼"）。
  # ⭐ `design/0012` 的 `编辑：`一行：自证 / 编辑面 / 写授权 / 基线 / 保存在途 / 自写指纹 / 预览——
  #    ⚠️ 这几项**全部读后端真值**（`Session` 的那几个字段），⛔ 不是前端自报。
  #    ① "自证"是前端的编辑面自检（CM6 全局在、`EditorView` 建得起来、文本能往返、
  #       **转发白名单非空且含 `Mod-s`**）——最后这一条是"一行推导写错 ⇒ 编辑区里
  #       所有应用快捷键静默失效"的唯一自动防线；
  #    ② "写授权"与"基线"必须**同时**在或**同时**不在（它们是一对，见 `edit.rs` 模块头）。
  # ⭐ Q22（`design/0007` 文末追加节）的 `渲染统计：`一行：它有 `code=`／`code_over=`／
  #    `code_budget=` 三个计数器，超限时还会多一句「部分代码未高亮（规模限制）」。
  #    ⚠️ 它此前叫 `公式渲染：` 且**不在下面那张表里** ⇒ 那半句"未高亮可见"是**加了却看不见**的。
  # ⭐ `design/0012` §11 的 `滚动同步：`一行：⚠️⚠️ **它正常就是「编辑态未起」**——
  #    冒烟窗口里没人进编辑态 ⇒ ⛔ **它不是判据**，后端也**不拿它进 `pass`**。
  #    ⭐ 它要**和同一份输出里的 `编辑：`**（那一栏的「编辑面=」）**对着读**：
  #    「编辑面=活的」而这一栏「编辑态未起」才说明**接线断了**（这两种形态**光看这一行分不开**）。
  # ⭐ 取的时候**按标记**，⛔ 不"把上面那个 sed 范围调大"。
  echo "$out" | grep -E '^  (快捷键|外观|监视|查找|编辑|滚动同步|渲染统计)：|^    动作明细：|^    菜单事件明细：|^    查找明细：|^    编辑明细：' | sed 's/^/  /' || true

  if echo "$out" | grep -q '^RMD_SMOKE PASS'; then
    echo "  ✅ PASS"
  else
    echo "  ⛔ FAIL"
    echo "$out" | sed -n '1,8p' | sed 's/^/     /'
    FAILED=$((FAILED + 1))
  fi
done

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✅ 全部通过：${#CASES[@]} 个用例（文件能显示能滚 / 目录能建出树 / 裸跑有入口）"
  exit 0
fi
echo "⛔ $FAILED / ${#CASES[@]} 个用例没过"
exit 1
