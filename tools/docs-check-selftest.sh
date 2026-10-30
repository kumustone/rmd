#!/usr/bin/env bash
# docs-check.py 的自检：每条断言都配一个「注入违规 ⇒ 必须报红」的负对照。
#
# 「没做过变异测试的断言不算数」——所以这里不测「真实 docs/ 现在有几条」，
# 只测「检查器对每一类违规真的会叫」。全部在 mktemp 出来的临时树里做，
# 不碰仓库里的任何文件。
#
#   bash tools/docs-check-selftest.sh
#
# 退出码：0 = 全部断言成立；1 = 有断言不成立。

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/docs-check.py"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/docs-check-selftest.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok()   { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf 'FAIL  %s\n' "$1"; }

# 造一份最小但合法的 docs（每种文档一份）
seed() {
  local root="$1"
  rm -rf "$root"; mkdir -p "$root"/docs/{features,design,bugs,adr,kb,vision}
  cat > "$root/docs/features/0001-甲.md" <<'EOF'
# 甲

| 项 | 内容 |
|---|---|
| 状态 | `已立项` |
| 来源 | tasks.md T1 |
| 设计 | `../design/0001-甲.md` |

## 1. 要什么
EOF
  cat > "$root/docs/design/0001-甲.md" <<'EOF'
# 甲

| 项 | 内容 |
|---|---|
| **状态** | `已通过` |
| **对应 feature** | `../features/0001-甲.md` |
| **被取代为** | — |
| **评审** | 用户 2026-10-30 |

## 1. 现状
见 `../features/0001-甲.md`。
EOF
  cat > "$root/docs/bugs/0001-乙.md" <<'EOF'
# 乙

| 项 | 内容 |
|---|---|
| 状态 | `已修复` |
| 发现于 | 2026-10-30 |
| 影响 | 无 |

## 1. 现象
EOF
  cat > "$root/docs/adr/0001-丙.md" <<'EOF'
# ADR-0001: 丙

| 项 | 内容 |
|---|---|
| **状态** | `accepted` |
| 日期 | 2026-10-30 |
| 评审 | 用户 |

## Context
EOF
  cat > "$root/docs/adr/0002-丁.md" <<'EOF'
# ADR-0002: 丁

| 项 | 内容 |
|---|---|
| **状态** | `superseded by ADR-0001` |
| 日期 | 2026-10-30 |
| 评审 | 用户 |

## Context
EOF
  cat > "$root/docs/kb/0001-戊.md" <<'EOF'
# 戊

| 项 | 内容 |
|---|---|
| 关键词 | a / b |
| 适用场景 | x |
| 最近核实 | 2026-10-30 |

## 问题
EOF
}

run_check() {  # run_check <root> [extra args...]
  local root="$1"; shift
  python3 -I "$CHECK" --docs "$root/docs" --repo "$root" "$@"
}

# --- C0 基线：最小合法树必须是绿的 ---------------------------------------
seed "$TMP/c0"
if out="$(run_check "$TMP/c0")"; then
  if printf '%s' "$out" | grep -q 'ERROR 0'; then
    ok "C0 最小合法树：ERROR 0、退出码 0"
  else
    bad "C0 退出码 0 但汇总不是 ERROR 0：$out"
  fi
else
  bad "C0 最小合法树被判红：$out"
fi

# --- C1 同目录编号重复 ----------------------------------------------------
seed "$TMP/c1"; cp "$TMP/c1/docs/design/0001-甲.md" "$TMP/c1/docs/design/0001-另一个.md"
out="$(run_check "$TMP/c1")"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q '^ERROR E1' \
  && ok "C1 编号重复 → E1、退出码 1" || bad "C1 未报红（rc=${rc}）：$out"

# --- C2 文件名不是四位编号 ------------------------------------------------
seed "$TMP/c2"; : > "$TMP/c2/docs/bugs/42-怪名字.md"
out="$(run_check "$TMP/c2")"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q '^ERROR E1' \
  && ok "C2 三位编号 → E1、退出码 1" || bad "C2 未报红（rc=${rc}）：$out"

# --- C3 头部缺必填行 ------------------------------------------------------
seed "$TMP/c3"; sed -i '' '/^| 来源 |/d' "$TMP/c3/docs/features/0001-甲.md"
out="$(run_check "$TMP/c3")"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'ERROR E2.*「来源」' \
  && ok "C3 缺「来源」→ E2、退出码 1" || bad "C3 未报红（rc=${rc}）：$out"

# --- C4 状态词越界：默认 WARN，--strict 才红 ------------------------------
seed "$TMP/c4"; sed -i '' 's/`已通过`/`已完成`/' "$TMP/c4/docs/design/0001-甲.md"
if run_check "$TMP/c4" >/dev/null; then
  ok "C4a 越界状态词默认只 WARN（退出码 0）"
else
  bad "C4a 默认口径不该红"
fi
run_check "$TMP/c4" --strict >/dev/null; rc=$?
[ "$rc" -eq 1 ] && ok "C4b 越界状态词 + --strict → 退出码 1" \
  || bad "C4b --strict 退出码是 ${rc}（应为 1）"

# --- C5 文档引用解析不到 --------------------------------------------------
seed "$TMP/c5"
printf '\n见 `../design/0009-不存在.md`。\n' >> "$TMP/c5/docs/features/0001-甲.md"
if run_check "$TMP/c5" >/dev/null; then ok "C5a 断链默认只 WARN"; else bad "C5a 默认不该红"; fi
run_check "$TMP/c5" --strict >/dev/null; rc=$?
[ "$rc" -eq 1 ] && ok "C5b 断链 + --strict → 退出码 1" \
  || bad "C5b --strict 退出码是 ${rc}（应为 1）"
run_check "$TMP/c5" --list-warn | grep -q '0009-不存在.md' \
  && ok "C5c 断链在 --list-warn 里点名" || bad "C5c 断链没被点名"

# --- C6 design「被取代为」指向不存在的文件 --------------------------------
seed "$TMP/c6"; sed -i '' 's/| \*\*被取代为\*\* | — |/| **被取代为** | `0099-无.md` |/' "$TMP/c6/docs/design/0001-甲.md"
out="$(run_check "$TMP/c6" --strict)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'ERROR E5.*0099-无.md' \
  && ok "C6 悬空「被取代为」→ E5、退出码 1" || bad "C6 未报红（rc=${rc}）：$out"

# --- C7 ADR superseded by 指向不存在的编号 --------------------------------
seed "$TMP/c7"; sed -i '' 's/superseded by ADR-0001/superseded by ADR-0099/' "$TMP/c7/docs/adr/0002-丁.md"
out="$(run_check "$TMP/c7" --strict)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'ADR-0099' \
  && ok "C7 悬空 superseded by → 退出码 1 且点名 ADR-0099" || bad "C7 未报红（rc=${rc}）：$out"

# --- C8 只在围栏代码块里的路径不算引用（不该误报） ------------------------
seed "$TMP/c8"
printf '\n```sh\ncat ../design/0009-不存在.md\n```\n' >> "$TMP/c8/docs/features/0001-甲.md"
run_check "$TMP/c8" --strict >/dev/null; rc=$?
[ "$rc" -eq 0 ] && ok "C8 围栏里的路径不误报（--strict 仍为 0）" \
  || bad "C8 围栏里的路径被误报（rc=${rc}）"

# --- C9「被取代为」以破折号开头（＝没有取代）时不误报 ----------------------
seed "$TMP/c9"; sed -i '' 's/| \*\*被取代为\*\* | — |/| **被取代为** | —（新稿；旧说法「\`q()\` 单引号转义」已撤） |/' "$TMP/c9/docs/design/0001-甲.md"
if grep -q 'q()' "$TMP"/c9/docs/design/0001-*.md; then :; else bad "C9 \u6ce8\u5165\u6ca1\u751f\u6548"; fi
run_check "$TMP/c9" --strict >/dev/null; rc=$?
[ "$rc" -eq 0 ] && ok "C9 破折号开头的「被取代为」不算悬空指针" \
  || bad "C9 误报（rc=${rc}）"

# --- C10 状态 `已实施` 却没有 `## 10.` ------------------------------------
seed "$TMP/c10"; sed -i '' 's/`已通过`/`已实施`/' "$TMP/c10/docs/design/0001-甲.md"
printf '## 10. 实施记录\n\n已落。\n' >> "$TMP/c10/docs/design/0001-甲.md"
run_check "$TMP/c10" >/dev/null; rc=$?
[ "$rc" -eq 0 ] && ok "C10a 已实施 + §10 → 绿" || bad "C10a 误报（rc=${rc}）"
python3 - "$TMP/c10/docs/design/0001-甲.md" <<'PY2'
import sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
open(p,'w',encoding='utf-8').write(s.replace('## 10. 实施记录','## 10 实施记录'))
PY2
out="$(run_check "$TMP/c10")"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'ERROR E6' \
  && ok "C10b 已实施但无 §10. → E6、退出码 1" || bad "C10b 未报红（rc=${rc}）：${out}"

# --- C11 design 没有同号 feature 且不写理由 --------------------------------
seed "$TMP/c11"
rm "$TMP/c11/docs/features/0001-甲.md"
sed -i '' 's/| \*\*对应 feature\*\* | .* |/| **对应 feature** |  |/' "$TMP/c11/docs/design/0001-甲.md"
out="$(run_check "$TMP/c11")"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'ERROR E7' \
  && ok "C11a 无同号 feature 且留空 → E7、退出码 1" || bad "C11a 未报红（rc=${rc}）：${out}"
sed -i '' 's/| \*\*对应 feature\*\* |  |/| **对应 feature** | 无独立 feature（用户口述） |/' "$TMP/c11/docs/design/0001-甲.md"
run_check "$TMP/c11" >/dev/null; rc=$?
[ "$rc" -eq 0 ] && ok "C11b 写明「无独立 feature」→ 绿" || bad "C11b 误报（rc=${rc}）"

# --- C12 docs/ 下的目录必须在 README §6 里有归宿 --------------------------
seed "$TMP/c12"
cat > "$TMP/c12/docs/README.md" <<'EOF'
# 文档

## 6. 每份文档只有一种命运

| 文件 | 类型 | 更新规则 |
|---|---|---|
| `docs/features/*` | 历史记录 | 冻结 |
| `docs/design/*` | 历史记录 | 冻结 |
| `docs/bugs/*` | 历史记录 | 冻结 |
| `docs/adr/*` | 历史记录 | 冻结 |
| `docs/kb/*` | 活文档 | 更新 |
| `docs/vision/*` | 活文档 | 更新 |
EOF
run_check "$TMP/c12" --strict >/dev/null; rc=$?
[ "$rc" -eq 0 ] && ok "C12a 六个目录都在 §6 里 → 绿" || bad "C12a 误报（rc=${rc}）"
mkdir -p "$TMP/c12/docs/extra"
out="$(run_check "$TMP/c12" --strict)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'E8.*docs/extra' \
  && ok "C12b 未声明的目录 → E8（--strict 红）" || bad "C12b 未报红（rc=${rc}）：${out}"

# --- C13–C15 能力矩阵自洽（交付闸门，表里的每个值都会被人当结论用） ----------
seed_matrix() {  # seed_matrix <root>
  local root="$1"
  seed "$root"
  mkdir -p "$root/docs/quality"
  cat > "$root/docs/quality/矩阵.md" <<'EOF'
# 能力矩阵

## 1. 矩阵

| 动作 \ 语境 | 段落 | 标题 | 列表 | 引用 | 代码块 | 表格格 | 任务项 |
|---|---|---|---|---|---|---|---|
| 甲 | 绿 | 绿 | 绿 | 绿 | 绿 | 绿 | 绿 |
| 乙 | 红 | 红 | 绿 | 绿 | 绿 | 未测 | 未测 |

**合计：绿 10 · 红 2 · 未测 2。**

## 4. 未测清单（2 格）与补齐去向

| 缺口 | 格数 | 补法 |
|---|---|---|
| 乙那一行的末尾两格 | 2 | 补夹具 |
EOF
}

seed_matrix "$TMP/c13"
run_check "$TMP/c13" --strict >/dev/null; rc=$?
[ "$rc" -eq 0 ] && ok "C13a 矩阵自洽 → 绿" || bad "C13a 误报（rc=${rc}）"
sed -i '' 's/绿 10 · 红 2 · 未测 2/绿 10 · 红 2 · 未测 3/' "$TMP/c13/docs/quality/矩阵.md"
out="$(run_check "$TMP/c13")"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'ERROR E9' \
  && ok "C13b 合计与实数不符 → E9、退出码 1" || bad "C13b 未报红（rc=${rc}）：${out}"

seed_matrix "$TMP/c14"
sed -i '' 's/| 乙 | 红 | 红 |/| 乙 | 红 | 黄 |/' "$TMP/c14/docs/quality/矩阵.md"
out="$(run_check "$TMP/c14")"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'ERROR E10' \
  && ok "C14 矩阵出现非法值 → E10、退出码 1" || bad "C14 未报红（rc=${rc}）：${out}"

seed_matrix "$TMP/c15"
sed -i '' 's/| 乙那一行的末尾两格 | 2 |/| 乙那一行的末尾两格 | 5 |/' "$TMP/c15/docs/quality/矩阵.md"
if run_check "$TMP/c15" >/dev/null; then ok "C15a §4 格数对不上默认只 WARN"; else bad "C15a 默认不该红"; fi
out="$(run_check "$TMP/c15" --strict)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'E11' \
  && ok "C15b §4 与矩阵「未测」对不上 → E11（--strict 红）" || bad "C15b 未报红（rc=${rc}）：${out}"
# 标题里的格数写错也要抓（清单合计可能没写）
seed_matrix "$TMP/c16"
sed -i '' 's/未测清单（2 格）/未测清单（7 格）/' "$TMP/c16/docs/quality/矩阵.md"
out="$(run_check "$TMP/c16" --strict)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'E11' \
  && ok "C16 §4 标题的格数与矩阵「未测」不符 → E11" || bad "C16 未报红（rc=${rc}）：${out}"

printf '\nselftest: %d PASS / %d FAIL\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
