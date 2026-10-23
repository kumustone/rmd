#!/usr/bin/env bash
# `design/0012` §7 步骤 **0e**：**源码保真**——7 类样本各跑一遍「打开 → 改一个字 → 保存」，
# 前 5 类**逐字节**比对，后 2 类（`Eol = Other`）**必须**收敛成纯 LF。
#
#     tools/editor-fidelity.sh
#
# # 它为什么是「自动的那一半」
#
# §7 那张表里 0e 一行写着「⭐ **这一类能自动验，所以必须自动验**」——理由是它
# **不依赖前端**：验的是 `document/envelope.rs`（信封）＋ `commands/edit.rs`
# 的 `write_off_lock`（**全项目唯一的写盘路径**）。两样都在 Rust 侧，所以它能在
# `src/editor/main.js` 之前就做完。
#
# # ⚠️ 为什么**不能**拿一个 CLI 去跑保存
#
# 有个更"显然"的做法：加一条 `rmd --save <file>` 让脚本自己驱动保存。
# ⛔ **不能这么做**：那会造出**第二条写盘路径**，而 `INV-EDIT-10` 要的是
# "保存只有一个入口"。⇒ 唯一合法的驱动方式是**调那个函数本身**，也就是这条测试。
#
# # ⚠️ 为什么不用 `md5` 判"不改动直接存 ⇒ 磁盘没变"
#
# §7 那一行的原话是"磁盘 `md5` 不变"。本脚本判的是**更强**的一件事：
# 测试里同时断言 **mtime 未变**（"根本没写"必然 ⇒ "md5 相同"，反之不然）。
# ⭐ 所以这里不另算一次摘要——多算一次只会让判据变多，不会变准。
#
# # 判据
#
# ① 测试全绿；
# ② 输出里 `RMD_FIDELITY` 行**恰好 8 条**（7 类样本 ＋ 1 条 no-op），
#    且 7 个类名一个不少 —— ⚠️ 这一条才是本脚本存在的理由：
#    **"某个样本被静默跳过"与"全部通过"在输出上长得一模一样**
#    （本仓库为这类事吃过亏，见 `.claude/rules/tests.md`）。
# ③ `exact=no` 的**只允许**是 `mixed` / `bare-cr` 两类：把一条本该逐字节的样本
#    降级成"不承诺保真"，是本设计最怕的那种静默退化。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# ⚠️ `edit.rs` 住在 `commands/` 下 ⇒ 只有 `--features gui` 才编译得到
#    （那是"要链 Tauri 的那一次构建"）。不带 feature 的话是 0 个测试通过，
#    而不是报错 —— ⛔ 那正是"绿得毫无意义"的样子，所以下面还要数条数。
echo "▶ cargo test --release --features gui commands::edit（0e：7 类样本逐字节保真）"
cd "$ROOT/src-tauri"

out="$(cargo test --release --features gui commands::edit -- --nocapture 2>&1)" || {
  echo "$out" | tail -40
  echo "⛔ 0e 失败：测试没全绿（上面是尾部输出）" >&2
  exit 1
}

fid="$(echo "$out" | grep -E '^RMD_FIDELITY ' || true)"
n="$(printf '%s\n' "$fid" | grep -c . || true)"

echo
echo "── 7 类样本 ─────────────────────────────────────────────"
printf '%s\n' "$fid" | sed 's/^RMD_FIDELITY /  /'
echo "────────────────────────────────────────────────────────"

fail=0

# ① 条数：8 = 7 类 + noop
if [ "$n" != "8" ]; then
  echo "⛔ 0e：RMD_FIDELITY 行应当 8 条（7 类样本 + noop），实际 $n 条" >&2
  echo "   （少了就是有样本被静默跳过 —— 那与『全部通过』在输出上无法区分）" >&2
  fail=1
fi

# ② 七个类名一个不少
for cls in lf crlf bom+crlf no-trailing-newline empty mixed bare-cr; do
  if ! printf '%s\n' "$fid" | grep -q "class=$cls "; then
    echo "⛔ 0e：缺样本类 $cls" >&2
    fail=1
  fi
done

# ③ `exact=no` 只许出现在这两类上
bad="$(printf '%s\n' "$fid" | grep 'exact=no' | grep -vE 'class=(mixed|bare-cr) ' || true)"
if [ -n "$bad" ]; then
  echo "⛔ 0e：这两条**本应逐字节**却被降级成不承诺保真：" >&2
  printf '%s\n' "$bad" >&2
  fail=1
fi

# ④ 五类逐字节的必须在名单里且真的报了 exact=yes
for cls in lf crlf bom+crlf no-trailing-newline empty; do
  if ! printf '%s\n' "$fid" | grep -q "class=$cls .*exact=yes"; then
    echo "⛔ 0e：$cls 没报 exact=yes" >&2
    fail=1
  fi
done

# ⑤ no-op：⛔ 不许写出盘
if ! printf '%s\n' "$fid" | grep -q 'class=noop .*written=no .*mtime_same=yes'; then
  echo "⛔ 0e：不改动直接保存那一条没报 written=no / mtime_same=yes" >&2
  fail=1
fi

if [ "$fail" != "0" ]; then
  echo >&2
  echo "⛔ 0e 不通过（见上面的 ⛔ 行）" >&2
  exit 1
fi

echo "✅ 0e 通过：7 类样本（5 类逐字节 + 2 类收敛为 LF）＋ no-op 短路，共 8 条判据"
