#!/usr/bin/env bash
# 花括号守卫 —— `$VAR` 后面紧跟非 ASCII 字节时，必须写成 `${VAR}`
#
# ## 它回答什么
#   仓库里的 shell 片段（`Makefile` 与 `*.sh`）有没有 `$NAME：` / `$NAME（` 这种写法。
#
# ## 为什么这是 bug 而不是风格
#   macOS 自带的 **bash 3.2**（`/bin/bash`，GitHub Actions 的 `macos-15` runner 上就是它）
#   在 **UTF-8 locale** 下会把紧跟变量的多字节字符**吃进变量名**：
#
#     $ env -i LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 /bin/bash -c 'set -u; label=x; echo "$label："'
#     bash: label�: unbound variable          ← 变量名被当成 `label：`
#
#   bash 5（本机 Homebrew 那份）**不会** ⇒ 本机全绿、CI 红，且报错里的变量名是乱码，
#   与源码对不上。2026-10-23 就是这样丢掉一轮 Actions（`scripts/lint-theme.sh:142`）。
#   ⚠️ 没有 `set -u` 时它**不报错**：`$label：` 静默变成 `：`，值直接消失——更坏。
#
# ## 判据
#   源文件里出现 `$` + 名字/位置参数 + **非可打印非空白字节** ⇒ 退出 1。
#   ⚠️ C locale 下 awk 按字节比较，`[^[:print:][:space:]]` 就是「>= 0x80」，
#   不会误吃 `$label<TAB>` / `$label ` / `${label}：`。
#   ⚠️ BSD grep 一把抓不住这条（实测 `grep -E` 对同一行不匹配，`awk` 匹配）⇒ 用 awk。
#
# ## 用法
#   scripts/check-shell-vars.sh                # 扫默认范围（Makefile ＋ 三个目录的 *.sh）
#   scripts/check-shell-vars.sh <文件>...      # 只扫点名文件
#   scripts/check-shell-vars.sh --self-test    # 真值表（同一份判定实现）
#
# ## 退出码
#   0 干净；1 有命中或缺文件；2 用法错误
set -eu
set -o pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

# 判定实现（⛔ 只有这一份；`--self-test` 也走它）
scan() { # $@=文件
  LC_ALL=C awk '
    /\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*?#!])[^[:print:][:space:]]/ {
      s = $0
      printf "%s:%d: %s\n", FILENAME, FNR, substr(s, 1, 120)
      hits++
    }
    END { exit (hits > 0 ? 1 : 0) }
  ' "$@"
}

if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  # 基线：正确写法一条都不能命中
  printf '%s\n' 'say "${label}：x"' 'say "$label x"' 'say "$label	end"' 'echo "$${T}"' >"$tmp/ok.sh"
  # 夹具：每一种都恰好命中一次
  printf '%s\n' 'say "$label：x"' >"$tmp/bad1.sh"
  printf '%s\n' 'say "$1（缺）"' >"$tmp/bad2.sh"
  printf '%s\n' 'echo "$T）“"' >"$tmp/bad3.sh"
  pass=0
  fail=0
  ok() { pass=$((pass + 1)); printf 'ok    %s\n' "$1"; }
  no() { fail=$((fail + 1)); printf 'FAIL  %s\n' "$1"; }

  if out=$(scan "$tmp/ok.sh"); then ok "基线 4 条正确写法 0 命中"; else no "基线误报：$out"; fi
  for f in bad1 bad2 bad3; do
    if out=$(scan "$tmp/$f.sh"); then
      no "$f 应命中却 0 命中"
    else
      n=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
      if [ "$n" = "1" ]; then ok "$f 恰好 1 命中"; else no "$f 命中 $n 条（应为 1）"; fi
    fi
  done
  printf '\n自检：%d 通过 / %d 失败\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
  exit
fi

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=("$ROOT/Makefile")
  # ⚠️ 跳过本文件自己：它**必须**写出坏写法（文档示例 + `--self-test` 的夹具），
  # 否则守不住；处置是**印出来**，⛔ 不是静默过滤。要连它一起扫就点名传参。
  self="$ROOT/scripts/check-shell-vars.sh"
  while IFS= read -r f; do
    [ "$f" = "$self" ] && continue
    files+=("$f")
  done < <(find "$ROOT/scripts" "$ROOT/tests" "$ROOT/tools" -type f -name '*.sh' | LC_ALL=C sort)
  printf '（默认跳过本守卫自己的文件：它必须写出坏写法）\n'
fi

for f in "${files[@]}"; do
  [ -f "$f" ] || { printf '⛔ 找不到文件：%s\n' "$f" >&2; exit 1; }
done

printf '── 花括号守卫：%d 个文件 ──\n' "${#files[@]}"
if out=$(scan "${files[@]}"); then
  printf '✅ 干净：没有 `$VAR` 紧跟非 ASCII 字节的写法\n'
else
  printf '⛔ 这些地方要写成 ${VAR}（bash 3.2 + UTF-8 locale 会把后面的字符吃进变量名）：\n'
  printf '%s\n' "$out" | sed 's/^/    /'
  exit 1
fi
