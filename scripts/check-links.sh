#!/usr/bin/env bash
# rmd 导出树的 Markdown 链接检查（源头：docs/design/0024 §3 与 §7 第 7 条）
#
# 为什么要单独一件：公开候选树是**白名单导出**的，源仓库里成立的相对链接
# 在导出树里可能指向**被排除的文件**（最典型的是指向 `docs/` 内部文档的那些）。
# 这类断链不会让构建失败、也不会让测试变红 —— 只有人点到才发现。
#
# 用法：
#   scripts/check-links.sh <目录>        # 检查目录下所有 *.md；有断链 ⇒ 退出 1
#   scripts/check-links.sh --self-test   # 用**同一份**判定逻辑跑夹具真值表
#
# 判据：
#   · 只认**相对**目标：`http(s)://`、`mailto:` 等带 scheme 的一律跳过（不联网、不外联）
#   · `#anchor` 与空目标跳过（页内锚点不是文件）
#   · 去掉 `?query` 与 `#fragment` 之后再判存在性；`%XX` **解码一次**
#   · ``` 与 ~~~ 围栏里的内容不算链接（代码示例里的 `](x)` 不是文档链接）
#   · 目标可以是目录（有的 README 就链到目录）
#
# ⚠️ 覆盖面：它判的是「**路径存在**」，⛔ 不判「标题对不对」「锚点存不存在」。
# ⚠️ 判定只有**一份实现**（`run_check` 里的 heredoc）——自检复用它，⛔ 不另抄一份，
#    否则"自检绿"证明不了真正跑的那份是对的。
set -eu
set -o pipefail

run_check() {
  python3 - "$1" <<'PY'
import os, re, sys

root = sys.argv[1]
fence = re.compile(r'^\s{0,3}(```|~~~)')
link = re.compile(r'\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)')
ref = re.compile(r'^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$')
scheme = re.compile(r'^[A-Za-z][A-Za-z0-9+.\-]*:')
# 行内代码：定界反引号**个数相同**才算一段（⛔ 单个 ` 不会吃掉 ``x``）
code_span = re.compile(r'(`+)(?:(?!\1).)*?\1')

def decode(t):
    # 只解码一次（⛔ 不做二次解码：a%2520b 只变成 a%20b）
    return re.sub(r'%([0-9A-Fa-f]{2})', lambda m: chr(int(m.group(1), 16)), t)

def targets_of(path):
    infence = None
    with open(path, encoding='utf-8', errors='replace') as fh:
        for lineno, line in enumerate(fh, 1):
            m = fence.match(line)
            if m:
                if infence is None:
                    infence = m.group(1)
                elif m.group(1) == infence:
                    infence = None
                continue
            if infence is not None:
                continue
            # ⚠️ **行内代码也要剥**（2026-10-22 补）：`` `[x](javascript:alert(1))` ``
            #    在 Markdown 里是**代码样例**，⛔ 不是链接。不剥的话，
            #    `docs/kb/0005`（讲 comrak 安全行为）那 2 行会被判成断链 ——
            #    那是**判据错了**，不是文档错了。⛔ 别为此改文档。
            #    规则与 Markdown 一致：定界反引号**个数相同**才是一段。
            line = code_span.sub('', line)
            for rx in (link, ref):
                for t in rx.findall(line):
                    yield lineno, t

broken = 0
files = 0
for dirpath, dirnames, filenames in os.walk(root):
    dirnames.sort()
    for name in sorted(filenames):
        if not name.lower().endswith('.md'):
            continue
        files += 1
        path = os.path.join(dirpath, name)
        for lineno, raw in targets_of(path):
            t = raw.strip()
            if not t or t.startswith('#'):
                continue
            if t.startswith('//') or scheme.match(t):
                continue
            t = t.split('#', 1)[0].split('?', 1)[0]
            if not t:
                continue
            cand = os.path.normpath(os.path.join(os.path.dirname(path), decode(t)))
            if not os.path.exists(cand):
                rel = os.path.relpath(path, root)
                print('断链\t%s:%d\t%s' % (rel, lineno, raw))
                broken += 1

print('链接检查：%d 个 Markdown 文件，%d 条断链' % (files, broken))
if broken:
    print('⚠️ 断链多半指向**被白名单排除**的文件（典型：docs/ 内部文档）。')
    print('  处置只有两条：把目标改成公开文档，或把链接删掉 —— ⛔ 不要为此放宽白名单。')
sys.exit(1 if broken else 0)
PY
}

if [ $# -lt 1 ]; then
  printf '用法：%s <目录>  或  %s --self-test\n' "$0" "$0" >&2
  exit 64
fi

if [ "$1" = '--self-test' ]; then
  root=$(mktemp -d "${TMPDIR:-/tmp}/rmd-check-links.XXXXXX")
  trap 'rm -rf "$root"' EXIT
  mkdir -p "$root/sub dir"
  : > "$root/sub dir/a b.md"
  : > "$root/target.md"
  cat > "$root/doc.md" <<'MD'
# 链接样本

[存在](target.md)
[带锚点](target.md#whatever)
[不存在](missing.md)
[中文与空格](sub%20dir/a%20b.md)
[目录](sub%20dir)
[外链](https://example.com/x.md)
[页内](#anchor)
[带查询](target.md?x=1)
[引用式][r1]

[r1]: target.md

行内代码里的不算：`[样例](inline-code-not-a-link.md)` 与 ``[双反引号](nope.md)``

```
[围栏里的](not-a-link.md)
```
MD
  set +e
  out=$(run_check "$root")
  rc=$?
  set -e
  printf '%s\n' "$out"
  hits=$(printf '%s\n' "$out" | grep -c '^断链' || true)
  pass=0
  fail=0
  if [ "$rc" -eq 1 ]; then
    printf 'ok    退出码 1（有断链）\n'; pass=$((pass + 1))
  else
    printf 'FAIL  退出码应为 1，实得 %s\n' "$rc"; fail=$((fail + 1))
  fi
  if [ "$hits" -eq 1 ]; then
    printf 'ok    恰好 1 条断链\n'; pass=$((pass + 1))
  else
    printf 'FAIL  断链条数应为 1，实得 %s\n' "$hits"; fail=$((fail + 1))
  fi
  if printf '%s\n' "$out" | grep -q 'missing\.md'; then
    printf 'ok    命中的是 missing.md\n'; pass=$((pass + 1))
  else
    printf 'FAIL  没有命中 missing.md\n'; fail=$((fail + 1))
  fi
  printf '\n自检：%d 通过 / %d 失败\n' "$pass" "$fail"
  [ "$fail" -eq 0 ] || exit 1
  exit 0
fi

TREE=$1
if [ ! -d "$TREE" ]; then
  printf '不是目录：%s\n' "$TREE" >&2
  exit 64
fi

run_check "$TREE"
