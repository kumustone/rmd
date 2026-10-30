#!/usr/bin/env bash
# rmd 公开边界扫描 —— 三棵树、三份结论（源头：docs/design/0024-公开边界与可重复导出.md §2.2）
#
# ## 它回答什么
#   · 当前树（**只含已跟踪文件**）里有没有绝对路径 / 凭据 / 邮箱
#   · **全部可达提交**里有没有（⛔ 不含 reflog / dangling / 远端未取的提交）
#   · 真正要公开的那棵树里有没有
#
# ## 三条实现铁律（INV-EXPORT-04）
#   1. ⛔ **绝不用 -o / --only-matching**：它打印的是**匹配到的文本**，而
#      `password=` / `ghp_` / 私钥头一旦命中，秘密会直接进终端 scrollback 与
#      shell history —— 那正是"扫描器自己造成二次泄露"。本方只输出 `文件:行号:类型`。
#   2. 历史扫描**逐提交** `|| true`：`git grep` 无命中退出 1，在 `set -e` 下会让循环
#      在**第一个没命中的提交**处静默中止 ⇒ 假阴性。报告必须打印 `已扫描 N/M`，
#      **N ≠ M 即退出 5**。
#   3. 报告**默认只写 stdout**；要留档必须显式 `--report <path>`，且**拒绝落在导出树内**
#      （否则命中清单本身进了公开树）。
#
# ## 用法
#   scripts/scan-public.sh                      # 扫当前树 + 历史 + 默认导出树
#   scripts/scan-public.sh --tree /tmp/x        # 换导出树
#   scripts/scan-public.sh --no-tree            # 只扫当前树 + 历史
#   scripts/scan-public.sh --report /tmp/r.txt  # 留档（⛔ 不许落在导出树里）
#   scripts/scan-public.sh --include-self       # 连扫描器自己的源码一起扫（默认跳过）
#   scripts/scan-public.sh --self-test          # 夹具真值表（同一份判定实现）
#
# ## 为什么默认跳过 `scripts/scan-public.sh` 自己
#   本文件**必须**写出那 7 条正则的原文，`--self-test` 的夹具里也**必须**有
#   `/Users/realuser/…`、`password=…`、`someone@example.com` 这类**故意**的样例串
#   ⇒ 它随 `scripts/` 一起被导出之后，任何一次扫描都会命中它自己
#   （2026-10-21 实测：导出树的"真机/疑似"**全部**来自这里，没有一处是泄露）。
#   处置是**跳过并印出来**，⛔ 不是静默过滤；要看它自己就加 `--include-self`。
#   ⛔ 也不许改用"把 realuser 加进占位符表"这种办法——那等于用真实的假阴性换观感。
#
# ## 退出码
#   0 扫描完成（**命中不是失败**——命中要人判，脚本只报）
#   1 参数/环境错误（不在 git 仓库、`--report` 落在导出树内）
#   5 历史扫描不完整（N ≠ M）
#
# ⚠️ 兼容 macOS 自带的 bash 3.2（无关联数组、无 `${x,,}`、无 `mapfile`）。
set -eu
set -o pipefail

DEFAULT_TREE="${HOME}/rmd-public-candidate/rmd"

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  printf '扫描失败：当前目录不在 git 仓库里\n' >&2
  exit 1
}

usage() {
  sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

scanner() {
  # $1 = 仓库根  $2 = 导出树（空串 = 跳过）  $3 = 是否连扫描器自己也扫（1/0）
  python3 - "$1" "$2" "$3" <<'PY'
import os, re, subprocess, sys

root, tree, include_self = sys.argv[1], sys.argv[2], sys.argv[3] == '1'

# 模式表 —— 报告里**原样打印**，否则"命中/未命中"无从复核
PATTERNS = [
    ('ABSPATH_MAC',   r'/Users/[^/\s]+'),
    ('ABSPATH_LINUX', r'/home/[^/\s]+'),
    ('ABSPATH_WIN',   r'[A-Za-z]:\\Users\\'),
    ('TOKEN',         r'(ghp_|gho_|ghs_|github_pat_|AKIA[0-9A-Z]{16}|xox[bp]-|sk-[A-Za-z0-9]{20,})'),
    ('PRIVATE_KEY',   r'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
    ('ASSIGN',        r'(password|passwd|token|secret|api_key|apikey)[[:space:]]*[:=][[:space:]]*[^[:space:]]+'),
    ('EMAIL',         r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'),
]
def py_rx(rx):
    """给 **Python 这一侧**用的等价正则。
    ⚠️ 2026-10-21 实测：POSIX 字符类 `[[:space:]]` 在 Python `re` 里被当成**嵌套集合**
    （`FutureWarning: Possible nested set`），语义完全不同——它匹配的是
    `[` `:` `s` `p` `a` `c` `e` `]` 这几个字符，⛔ 不是空白。
    ⇒ 导出树那一份扫描（用 `re.search`）的 `ASSIGN` 一直是**错的**：
    既可能漏掉真赋值，也可能在毫不相干的文本上报命中。
    输出与报告里**照旧打印 POSIX 原串**（那是给 `git grep` 和读者复核用的）。"""
    return rx.replace('[[:space:]]', r'\s')

COMPILED = [(n, re.compile(py_rx(rx))) for n, rx in PATTERNS]

# ---------------------------------------------------------------------------
# 扫描器**自己**不参与扫描（可用 --include-self 纳入）
#
# 为什么：本文件里**必须**写出那 7 条正则的原文（否则"命中/未命中"无从复核，
# §2.2 铁律 3），`--self-test` 的那份夹具里也必须有 `/Users/realuser/...`、
# `password=…`、`someone@example.com` 这类**故意**的样例串。
# ⇒ 它一旦随 `scripts/` 被导出（design §2.1 明确要导出它），
#   任何一次扫描都会在**扫描器自己的源码**里命中——
#   2026-10-21 实测：导出树的"真机/疑似"全部来自这里（ABSPATH_MAC 4 处、
#   ABSPATH_LINUX 1 处、TOKEN 2 处、EMAIL 2 处），**没有一处是泄露**。
#
# 处置不是"偷偷滤掉"：**跳过这件事要印在报告里**，并在「扫描范围」段写清原因。
# ⛔ 也不许用"把 realuser 加进占位符表"那种改法——那会削弱分类器对**别处**
#   真机路径的识别力，等于用一个真实的假阴性换一个观感问题。
# ---------------------------------------------------------------------------
SELF_SOURCE = 'scripts/scan-public.sh'
SELF_SKIPPED = [0]

def is_self_source(path):
    return path == SELF_SOURCE or path.endswith('/' + SELF_SOURCE)

def keep(path):
    """要不要扫这条命中；跳过扫描器自己时计数（⚠️ 计数要印出来）。"""
    if include_self or not is_self_source(path):
        return True
    SELF_SKIPPED[0] += 1
    return False

# 占位符用户名：命中它的一律归「占位符」档，⛔ 不混进「真机路径」
PLACEHOLDER_USER = re.compile(r'^(x+|xxx|you|user|name|<[^>]*>|YOUR_[A-Z_]+)$')
# 用户名后面紧跟的标点要先剥掉再判定 —— 否则 `.../Users/x` 那个反引号会被算进用户名，
# `x`` 匹配不上占位符表 ⇒ **真机路径的假阳性**（2026-10-21 实测：Makefile 一句
# 「有 8 处 `/Users/x` 占位符」把导出树从"0 处真机路径"变成"1 处"）。
# ⚠️ 剥的集合里**没有 `<` `>`**：`<用户名>` 那种占位形式要连尖括号一起匹配上一条规则。
PLACEHOLDER_PUNCT = "`'\".,;:!?)]}）】」』、，。；："
IMAGE_SUFFIX = re.compile(r'(@2x\.(png|jpe?g|gif|tiff?)$|\.(png|jpe?g|gif|svg|ico|icns|tiff?)$)', re.I)

def git(*args, **kw):
    # `core.quotepath=false`：否则中文路径会被转成 `"docs/..."` 那种八进制转义，
    # 报告里的 `文件:行号` 就没法直接用了（⚠️ 只影响**显示**，不影响匹配）。
    return subprocess.run(['git', '-c', 'core.quotepath=false', '-C', root] + list(args),
                          capture_output=True, text=True, **kw)

def split_hit(text, sep=':'):
    """`path:line:content` → (path, line, content)；content 可能含冒号。"""
    p1 = text.find(sep)
    if p1 < 0:
        return text, '', ''
    p2 = text.find(sep, p1 + 1)
    if p2 < 0:
        return text[:p1], '', ''
    return text[:p1], text[p1 + 1:p2], text[p2 + 1:]

def classify(name, content):
    """返回档位：'hit' / 'placeholder' / 'exempt'。
    ⚠️ 只用于**分档**，内容一个字都不打印（INV-EXPORT-04）。"""
    if name == 'ABSPATH_MAC':
        m = re.search(r'/Users/([^/\s]+)', content)
        if m and PLACEHOLDER_USER.match(m.group(1).rstrip(PLACEHOLDER_PUNCT)):
            return 'placeholder'
        return 'hit'
    if name in ('EMAIL', 'TOKEN'):
        # `icon_512x512@2x.png` 这类资源名会被 EMAIL 当成邮箱域名
        if IMAGE_SUFFIX.search(content) or '@2x' in content:
            return 'exempt'
    return 'hit'

def scan_current(name, rx):
    """当前树：git grep 只搜**已跟踪**文件（未跟踪文件对它完全不可见）。"""
    # ⚠️ 模式必须走 `-e`：PRIVATE_KEY 那条以 `---` 开头，位置参数会被当成**选项**
    #    （实测 `git grep -E '-----BEGIN…'` 退出 129，unknown option `---BEGIN…`）。
    r = git('grep', '-n', '-I', '-E', '-e', rx, '--', '.')
    if r.returncode not in (0, 1):
        return None, r.returncode
    out = []
    for line in r.stdout.splitlines():
        path, lineno, content = split_hit(line)
        if not keep(path):
            continue
        # ⚠️ 只留 文件:行号；content 出了这个函数就丢
        out.append((path, lineno, classify(name, content)))
    return out, 0

def scan_history(name, rx):
    """历史：逐提交 git grep，⛔ 每条都必须 || true（无命中退出 1）。"""
    rl = git('rev-list', '--all')
    commits = rl.stdout.split()
    total = len(commits)
    scanned = 0
    out = []
    for c in commits:
        # 同上：`-e` 不能省（PRIVATE_KEY 以 `---` 开头，否则被当成选项）
        r = git('grep', '-l', '-E', '-e', rx, c, '--', '.')
        if r.returncode not in (0, 1):
            return out, scanned, total
        scanned += 1
        for line in r.stdout.splitlines():
            # git grep 在指定 commit 时前缀是 `<commit>:<path>`
            pair = line.split(':', 1)
            if len(pair) == 2 and not keep(pair[1]):
                continue
            out.append(pair)
    return out, scanned, total

def scan_tree(name, rx, base):
    """导出树：grep -r（含未跟踪/无 git 的树），-I 跳过二进制。"""
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for fn in sorted(filenames):
            p = os.path.join(dirpath, fn)
            try:
                with open(p, encoding='utf-8', errors='replace') as fh:
                    for i, line in enumerate(fh, 1):
                        if '\0' in line:
                            continue
                        if re.search(py_rx(rx), line):
                            rel = os.path.relpath(p, base)
                            if not keep(rel):
                                continue
                            out.append((rel, str(i), classify(name, line)))
            except OSError:
                continue
    return out

def bucket(out):
    hit = [(p, l) for p, l, k in out if k == 'hit']
    ph  = [(p, l) for p, l, k in out if k == 'placeholder']
    ex  = [(p, l) for p, l, k in out if k == 'exempt']
    return hit, ph, ex

def show(label, out, with_buckets):
    hit, ph, ex = bucket(out)
    print('  %s' % label)
    if not out:
        print('    0 命中')
        return
    print('    命中 %d 处（真机/疑似 %d）' % (len(out), len(hit)))
    for p, l in hit:
        print('      %s:%s' % (p, l))
    if with_buckets and ph:
        print('    ⚪ 占位符 %d 处（`/Users/x` 一类示例路径，不是真机路径）' % len(ph))
        for p, l in ph:
            print('      %s:%s' % (p, l))
    if with_buckets and ex:
        print('    ⚪ 豁免 %d 处（资源名 `@2x` / 图片后缀被 EMAIL 误吃）' % len(ex))
        for p, l in ex:
            print('      %s:%s' % (p, l))

print('=== 扫描范围 ===')
print('  当前树：`git grep` —— **只含已跟踪文件**；未跟踪文件对它完全不可见')
print('           ⚠️ **这与导出不一致**（2026-10-24 二次复评 R2-2 原地更正）：')
print('           导出现在取「已跟踪 ∪ 未跟踪且非软链」，本扫描仍只有已跟踪项。')
print('           ⇒ ⛔ 别把「当前树零命中」读成「公开树零命中」；以 `--tree` 那一份为准。')
rl = git('rev-list', '--all')
print('  历史：`git rev-list --all` —— **所有可达提交**，共 %d 个' % len(rl.stdout.split()))
print('        ⚠️ 不含 reflog / dangling / 远端未取的提交')
if tree:
    if os.path.isdir(tree):
        print('  导出树：%s' % tree)
    else:
        print('  导出树：%s' % tree)
        print('        ⚠️ **不存在 ⇒ 这一份没有扫**（先跑 `make export-public`）')
else:
    print('  导出树：本次跳过（--no-tree）')
if not include_self:
    # ⚠️ 跳过**必须**写在这里，⛔ 不许静默过滤（见文件内 is_self_source 的注释）
    print('  ⚠️ **跳过扫描器自身** %s —— 它含模式表原文与自检夹具，必然命中自己' % SELF_SOURCE)
    print('        （理由见脚本内注释；要纳入请加 --include-self）')
print()
print('=== 模式（原样） ===')
for n, rx in PATTERNS:
    print('  %-14s %s' % (n, rx))
print()

incomplete = []
for name, rx in PATTERNS:
    print('=== %s ===' % name)

    print(' 一、当前树')
    out, rc = scan_current(name, rx)
    if out is None:
        print('    ⚠️ git grep 失败（退出 %d）—— 这一格**没有结论**' % rc)
        incomplete.append('当前树/%s' % name)
    else:
        show('命中（文件:行号）', out, name in ('ABSPATH_MAC', 'EMAIL'))

    print(' 二、历史')
    hout, scanned, total = scan_history(name, rx)
    if scanned != total:
        print('    已扫描 %d/%d 个提交 ❌ **不完整**（假阴性不会被当成"干净"）' % (scanned, total))
        incomplete.append('历史/%s' % name)
    else:
        print('    已扫描 %d/%d 个提交 ✅' % (scanned, total))
    if hout:
        print('    命中 %d 处（`提交:文件`，⛔ 不含内容）' % len(hout))
        for c, p in hout:
            print('      %s:%s' % (c[:10], p))
    else:
        print('    0 命中')

    print(' 三、导出树')
    if tree and os.path.isdir(tree):
        tout = scan_tree(name, rx, tree)
        show('命中（文件:行号）', tout, name in ('ABSPATH_MAC', 'EMAIL'))
    elif tree:
        print('    ⚠️ 未扫（目录不存在）')
    else:
        print('    本次跳过')
    print()

print('=== 结论怎么读 ===')
print('  · **命中不是失败**：脚本只报，判它是什么要人看。⛔ 不要因为"0 命中"就说安全。')
print('  · 本报告**未覆盖**：reflog / dangling / 远端未取的提交、二进制内容、')
print('    文件名的语义（一个叫 `secret-notes.md` 的文件不会因文件名命中）。')
print('  · 历史里的命中**不能**靠删当前文件消除（`.gitignore` 管不到历史）。')
if not include_self:
    print('  · 本次**跳过扫描器自身** %s 的 %d 行命中（见「扫描范围」；--include-self 纳入）。'
          % (SELF_SOURCE, SELF_SKIPPED[0]))
if incomplete:
    print()
    print('⚠️ 有 %d 格没有结论：%s' % (len(incomplete), ', '.join(incomplete)))
    sys.exit(5)
PY
}

REPORT=''
TREE="$DEFAULT_TREE"
USE_TREE=1
SELF_TEST=0
INCLUDE_SELF=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tree)
      [ $# -ge 2 ] || { printf '缺 --tree 的值\n' >&2; exit 1; }
      TREE=$2; USE_TREE=1; shift 2 ;;
    --no-tree) USE_TREE=0; shift ;;
    --include-self) INCLUDE_SELF=1; shift ;;
    --report)
      [ $# -ge 2 ] || { printf '缺 --report 的值\n' >&2; exit 1; }
      REPORT=$2; shift 2 ;;
    --self-test) SELF_TEST=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 1 ;;
  esac
done

[ "$USE_TREE" = 1 ] || TREE=''

# ---------------------------------------------------------------------------
# --self-test：夹具真值表（⚠️ 复用**同一份** scanner，⛔ 不另抄一份判定）
# ---------------------------------------------------------------------------
if [ "$SELF_TEST" = 1 ]; then
  pass=0; fail=0
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/rmd-scan-selftest.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  repo="$tmp/repo"; out="$tmp/export"
  mkdir -p "$repo" "$out"
  git -C "$repo" init -q
  git -C "$repo" config user.email 'probe@example.invalid'
  git -C "$repo" config user.name 'probe'
  cat > "$repo/leak.txt" <<'TXT'
真机路径 /Users/realuser/notes
赋值式 password=hunter2_should_never_print
邮箱 someone@example.com
资源名 icon_512x512@2x.png
占位符 /Users/x/notes
反引号里的 `/Users/x` 也是占位符
带空格赋值 passwd = spaced_should_never_print
TXT
  git -C "$repo" add -A
  git -C "$repo" commit -qm fixture
  cp "$repo/leak.txt" "$out/leak.txt"
  # ⭐ 自指的夹具：一个**叫扫描器名字**的文件，里面有意写一条真机路径。
  #    判据是「默认跳过它 ∧ 报告里印出这件事」＋「--include-self 时它又出现」。
  mkdir -p "$repo/scripts" "$out/scripts"
  printf '夹具 /Users/selffixture/leak\n' > "$repo/scripts/scan-public.sh"
  git -C "$repo" add -A
  git -C "$repo" commit -qm selffixture
  cp "$repo/scripts/scan-public.sh" "$out/scripts/scan-public.sh"

  set +e
  out_text=$(cd "$repo" && scanner "$repo" "$out" 0 2>&1)
  rc=$?
  set -e
  set +e
  out_text_self=$(cd "$repo" && scanner "$repo" "$out" 1 2>&1)
  set -e

  check() {
    if [ "$1" = 1 ]; then printf 'ok    %s\n' "$2"; pass=$((pass + 1))
    else printf 'FAIL  %s\n' "$2"; fail=$((fail + 1)); fi
  }
  # ⚠️ `grep -q` 未命中退出 1，在 `set -e` 下会**打断整个自检**（第一版就栽在这里：
  #    秘密没漏进报告（正确），脚本却在"检查秘密没漏"那一行自己退出）。
  #    ⇒ 一律用 `if … then … else …`，⛔ 不用 `cmd; rc=$?`。
  expect_contains() {
    if printf '%s\n' "$out_text" | grep -q "$1"; then check 1 "$2"; else check 0 "$2"; fi
  }
  expect_not_contains() {
    if printf '%s\n' "$out_text" | grep -q "$1"; then check 0 "$2"; else check 1 "$2"; fi
  }

  expect_contains '已扫描 2/2 个提交 ✅' '历史扫描打印「已扫描 2/2」'
  expect_not_contains 'hunter2_should_never_print' '⛔ 报告里**没有**出现秘密内容（INV-EXPORT-04）'
  expect_contains 'leak.txt' '命中给出了 文件:行号'
  expect_contains '占位符' '/Users/x 进「占位符」档'
  # ⭐ 反面：反引号紧贴在占位符后面时，标点**不能**被算进用户名（否则它掉进「真机」档）
  expect_contains '占位符 2 处' '`/Users/x`（带标点）也进「占位符」档'
  expect_contains '豁免' '@2x 资源名进「豁免」档'
  # ⭐ `ASSIGN` 里那个 `[[:space:]]` 在 Python 侧必须真的当**空白**：
  #    等号两侧带空格的那一行（夹具第 7 行）只有翻译过的正则才认得出。
  expect_contains 'leak.txt:7' '`[[:space:]]` 在 Python 侧按空白解释（带空格的赋值命中）'
  # ⭐ 自指：默认跳过扫描器自身，且**印出**这件事；--include-self 时它重新出现。
  #    ⚠️ 判据是 `文件:行号`（`scripts/scan-public.sh:1`），⛔ 不是文件内容——
  #    报告按 INV-EXPORT-04 **从不打印命中的内容**，所以只能看它有没有作为**命中位置**出现。
  expect_not_contains 'scripts/scan-public.sh:1' '默认**跳过**扫描器自身（它命中了自己）'
  expect_contains '跳过扫描器自身' '跳过这件事**印在报告里**（⛔ 不静默过滤）'
  if printf '%s\n' "$out_text_self" | grep -q 'scripts/scan-public.sh:1'; then
    check 1 '--include-self 时扫描器自身重新被扫'
  else
    check 0 '--include-self 时扫描器自身重新被扫'
  fi

  if [ "$rc" = 0 ]; then check 1 '退出码 0（命中不是失败）'
  else check 0 "退出码 0（实得 ${rc}）"; fi

  printf '\n自检：%d 通过 / %d 失败\n' "$pass" "$fail"
  [ "$fail" -eq 0 ] || exit 1
  exit 0
fi

# ---------------------------------------------------------------------------
# --report 不得落在导出树内（INV-EXPORT-04 的第二半）
# ---------------------------------------------------------------------------
if [ -n "$REPORT" ]; then
  case "$REPORT" in
    /*) report_abs=$REPORT ;;
    *) report_abs="$PWD/$REPORT" ;;
  esac
  # 最近存在的祖先 + 剩余分量（与 export-public.sh 的 abspath 同一手法）
  rest=''
  probe=$report_abs
  while [ ! -d "$probe" ]; do
    rest="/$(basename "$probe")$rest"
    probe=$(dirname "$probe")
  done
  report_abs="$(cd -P "$probe" && pwd -P)$rest"
  if [ -n "$TREE" ] && [ -d "$TREE" ]; then
    tree_abs=$(cd -P "$TREE" && pwd -P)
    case "$report_abs" in
      "$tree_abs"|"$tree_abs"/*)
        printf '扫描失败：--report 落在导出树内（会把命中清单带进公开树）：%s\n' "$report_abs" >&2
        exit 1 ;;
    esac
  fi
fi

if [ -n "$REPORT" ]; then
  set +e
  scanner "$ROOT" "$TREE" "$INCLUDE_SELF" > "$REPORT"
  rc=$?
  set -e
  printf '扫描报告已写入：%s\n' "$REPORT"
  printf '（退出码 %d；⚠️ 这份文件**不要**放进导出树）\n' "$rc"
else
  set +e
  scanner "$ROOT" "$TREE" "$INCLUDE_SELF"
  rc=$?
  set -e
fi
exit "$rc"
