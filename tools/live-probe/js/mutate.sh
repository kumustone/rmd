#!/bin/bash
# 原型的**变异自测**（`.claude/rules/tests.md`：「没做过变异测试的断言不算数」）。
#
# ⚠️ 铁律三条，缺一条"变红"就不成立：
#   ① 命中数必须**恰好 1**（`HITS=0` = 没改到，"没红"什么都不说明）；
#   ② 文件 `cksum` 必须真的变了；
#   ③ 变红之后**还原**，再跑一次基线必须是绿的。
#
# ⚠️ 只动 `tools/live-probe/js/*.js` 的**副本**：备份 → 改 → 跑 → 还原（trap 兜底）。
# ⛔ 不碰 `src/`、不碰 `tests/js/`。

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$DIR/../../.."
cd "$DIR" || exit 1

run_tests() {
  node --test --test-reporter=tap ./*.test.js 2>&1 | awk '/^# fail/ {print $3}'
}

# mutate <file> <from> <to> <期望变红的判据名>
mutate() {
  local file="$1" from="$2" to="$3" label="$4"
  local backup="/tmp/live-probe-mut.$$.$RANDOM"
  cp "$file" "$backup" || return 1
  local before after
  before="$(cksum "$file" | awk '{print $1}')"

  FROM="$from" TO="$to" FILE="$file" perl -0pi -e '
    my $from = $ENV{FROM};
    my $to   = $ENV{TO};
    my $n = ($_ =~ s/\Q$from\E/$to/g);
    if ($n != 1) { print STDERR "HITS=$n\n"; }
    END { print STDERR "HITS=" . (defined $n ? $n : 0) . "\n" }
  ' "$file" 2>/tmp/live-probe-hits.$$

  local hits
  hits="$(grep -o 'HITS=[0-9]*' /tmp/live-probe-hits.$$ | tail -1 | cut -d= -f2)"
  after="$(cksum "$file" | awk '{print $1}')"

  if [ "${hits:-0}" != "1" ]; then
    echo "⚠️ [$label] 没改到（HITS=${hits:-?}）⇒ ⛔ 这一处变异不成立，不记"
    cp "$backup" "$file"
    rm -f "$backup" /tmp/live-probe-hits.$$
    return 1
  fi
  if [ "$before" = "$after" ]; then
    echo "⚠️ [$label] cksum 没变 ⇒ ⛔ 改法等价，不记"
    cp "$backup" "$file"
    rm -f "$backup" /tmp/live-probe-hits.$$
    return 1
  fi

  local fails
  fails="$(run_tests)"
  cp "$backup" "$file"
  rm -f "$backup" /tmp/live-probe-hits.$$

  if [ "${fails:-0}" -gt 0 ]; then
    echo "✅ [$label] 变红 $fails 条 ⇒ 判据确实在承重"
    return 0
  fi
  echo "❌ [$label] 变异后**仍然全绿** ⇒ 这一条没有断言钉住"
  return 1
}

echo "## 基线（不改任何东西）"
BASE_FAILS="$(run_tests)"
echo "失败条数：${BASE_FAILS:-?}"
if [ "${BASE_FAILS:-1}" != "0" ]; then
  echo "⛔ 基线不绿，变异自测无意义"
  exit 1
fi

echo
echo "## 变异"
BAD=0

mutate inputState.js \
  "state.provisional = ev.data || '';" \
  "state.provisional = ev.data || ''; onTransaction({ from: state.start, to: state.end, next: [ev.data || ''], reason: 'composition-update' });" \
  "组合期间动文档" || BAD=$((BAD + 1))

mutate inputState.js \
  "            state.swallowInput = true; // 吃掉紧随其后的那次重复 input" \
  "            state.swallowInput = false;" \
  "去掉重复 input 的吞并" || BAD=$((BAD + 1))

mutate inputState.js \
  "  return String(text == null ? '' : text).replace(/\\r\\n?/g, '\\n').split('\\n');" \
  "  return String(text == null ? '' : text).split('\\n');" \
  "去掉 \\r 归一" || BAD=$((BAD + 1))

mutate lineModel.js \
  "  return { from: startLine - 1, to: endLine };" \
  "  return { from: startLine, to: endLine };" \
  "toRange 差一" || BAD=$((BAD + 1))

mutate lineModel.js \
  "  if (reply.line_count !== state.line_count) {" \
  "  if (false) {" \
  "身份闸不比 line_count" || BAD=$((BAD + 1))

mutate undoStack.js \
  "  if (inBlockView && cm6HasHistory) return 'cm6';" \
  "  if (inBlockView && cm6HasHistory) return 'commit';" \
  "撤销跨层（层级选错）" || BAD=$((BAD + 1))

mutate undoStack.js \
  "      entries.push(e);
      if (entries.length > limit) entries.shift();" \
  "      entries.push(e);" \
  "去掉撤销栈上限" || BAD=$((BAD + 1))

echo
echo "## 还原后复跑基线"
FINAL_FAILS="$(run_tests)"
echo "失败条数：${FINAL_FAILS:-?}"

echo
if [ "$BAD" -gt 0 ] || [ "${FINAL_FAILS:-1}" != "0" ]; then
  echo "⚠️ $BAD 处变异不成立 / 或被变异后有断言没红"
  exit 1
fi
echo "✅ 7 处变异各自把对应的判据打红，且还原后全绿"
