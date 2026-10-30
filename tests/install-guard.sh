#!/bin/bash
# `make install` / `make uninstall` 的**落点守卫**（`design/0033`）。
#
# 背景：应用内「安装命令行工具」建的是一条**指向运行中 `.app` 的符号链接**
# （换新版 `.app` 之后它自己跟着变）；`make install` 装的是一份**拷贝**。
# 两者落在同一个 `$(PREFIX)/rmd` 上 ⇒ 谁都能悄悄把对方换掉，而屏幕上一切正常。
#
# 这里守的就是那条界：
#   · 链接在手时 `make install` **跳过**（⛔ 不顺着链接写进去、⛔ 不删链接）；`FORCE=1` 才换。
#   · 链接在手时 `make uninstall` **跳过**（谁建的谁撤）；`FORCE=1` 只删链接本身。
#   · 普通文件 / 目录 / 悬空链接三种形态各自怎么走。
#
# ⚠️⚠️ 最值钱的一条是 **C**：守卫若用 `test -e` 判存在（悬空链接是"假"），
# `make install` 会把那条链接**当成空地**⇒ 后面那一步会把**链接本身换成一份拷贝**
# （⚠️ **已取代** 2026-10-22 实测：`install(1)` 先写临时文件再 rename，⛔ **不顺着链接写**；
# 详见 `scripts/install-guard.sh` 头与 `design/0033` §10）⇒ 应用菜单里那份"换新版自己跟着变"
# 的托管关系就此断掉。**主判据是 C2**；C3 是反向保险（目标处不许凭空多出文件）。
#
# 跑法：`make test-install-guard`（或 `bash tests/install-guard.sh`）。
# ⚠️ 它**注入 `BIN=` 与 `PREFIX=`**，只在临时目录里动，⛔ 不碰 `~/.local/bin`。

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MAKE=${MAKE:-make}
PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "  ✔ $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ✖ $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

T=$(mktemp -d "${TMPDIR:-/tmp}/rmd-install-guard.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT

# 假的 release 产物：可执行、并且含 GUI 标记（`make install` 会 `strings` 查它）。
mkdir -p "$T/bin"
cat > "$T/bin/rmd" <<'FAKE'
#!/bin/sh
# rmd://menu  ← 这就是 make install 要找的标记（真产物里由 gui/ 模块提供）
[ "$1" = "--version" ] && echo "rmd 0.0.0-guard-test"
exit 0
FAKE
chmod 755 "$T/bin/rmd"
BIN="$T/bin/rmd"

# 一次调用：$(1)=install|uninstall，$(2)=PREFIX，其余透传给 make（如 FORCE=1）。
run() {
  local k=$1 p=$2; shift 2
  ( cd "$ROOT" && "$MAKE" --no-print-directory "$k" BIN="$BIN" PREFIX="$p" "$@" 2>&1 )
}

echo "═══ install / uninstall 落点守卫（design/0033）═══"

# ── A：什么都没有 ⇒ 正常装一份拷贝 ────────────────────────────────
P="$T/a"; mkdir -p "$P"
OUT=$(run install "$P"); RC=$?
check "A1 空目录 ⇒ 退出 0" "[ $RC -eq 0 ]"
check "A2 装出来是普通文件（⛔ 不是链接）" "[ -f '$P/rmd' ] && [ ! -L '$P/rmd' ]"
check "A3 内容就是 release 产物本身" "cmp -s '$BIN' '$P/rmd'"

# ── B：已有一条**指向真文件**的链接（= 应用托管的那份）⇒ 跳过 ─────────
P="$T/b"; mkdir -p "$P" "$T/app"
echo "APP-BINARY" > "$T/app/rmd"; chmod 755 "$T/app/rmd"
ln -s "$T/app/rmd" "$P/rmd"
OUT=$(run install "$P"); RC=$?
check "B1 退出 0（跳过不是失败）" "[ $RC -eq 0 ]"
check "B2 输出里说明了跳过" "printf '%s' \"\$OUT\" | grep -q '跳过'"
check "B3 链接还在" "[ -L '$P/rmd' ]"
check "B4 链接指向没变" "[ \"\$(readlink '$P/rmd')\" = '$T/app/rmd' ]"
check "B5 ⭐ 目标文件一个字节没变（⛔ 没顺着链接写进去）" "printf 'APP-BINARY\n' | cmp -s - '$T/app/rmd'"

# ── C：链接是**悬空**的（它指向的 .app 已经不在了）⇒ 同样跳过 ─────────
P="$T/c"; mkdir -p "$P"
ln -s "$T/gone/rmd" "$P/rmd"
OUT=$(run install "$P"); RC=$?
check "C1 退出 0" "[ $RC -eq 0 ]"
check "C2 悬空链接还在（⛔ 没被当成'什么都没有'）" "[ -L '$P/rmd' ]"
check "C3 ⭐ 没有在链接目标处创建出文件" "[ ! -e '$T/gone/rmd' ] && [ ! -d '$T/gone' ]"

# ── D：FORCE=1 ⇒ 先删链接，再拷（⛔ 不是顺着它写）───────────────────
P="$T/d"; mkdir -p "$P" "$T/app2"
echo "APP-BINARY-2" > "$T/app2/rmd"; chmod 755 "$T/app2/rmd"
ln -s "$T/app2/rmd" "$P/rmd"
OUT=$(run install "$P" FORCE=1); RC=$?
check "D1 退出 0" "[ $RC -eq 0 ]"
check "D2 链接换成了普通文件" "[ -f '$P/rmd' ] && [ ! -L '$P/rmd' ]"
check "D3 内容是新拷的那份" "cmp -s '$BIN' '$P/rmd'"
check "D4 ⭐ 链接原来的目标也没被写" "printf 'APP-BINARY-2\n' | cmp -s - '$T/app2/rmd'"

# ── E：落点是个目录 ⇒ 拒绝（⛔ 不 rm -rf）──────────────────────────
P="$T/e"; mkdir -p "$P/rmd"
OUT=$(run install "$P"); RC=$?
check "E1 拒绝安装（退出非 0）" "[ $RC -ne 0 ]"
check "E2 那个目录还在" "[ -d '$P/rmd' ]"

# ── F：普通文件 ⇒ uninstall 删掉 ────────────────────────────────
P="$T/f"; mkdir -p "$P"; cp "$BIN" "$P/rmd"
OUT=$(run uninstall "$P"); RC=$?
check "F1 退出 0" "[ $RC -eq 0 ]"
check "F2 文件没了" "[ ! -e '$P/rmd' ]"

# ── G：链接 ⇒ uninstall 跳过（谁建的谁撤）──────────────────────────
P="$T/g"; mkdir -p "$P" "$T/app3"
echo "APP-BINARY-3" > "$T/app3/rmd"; chmod 755 "$T/app3/rmd"
ln -s "$T/app3/rmd" "$P/rmd"
OUT=$(run uninstall "$P"); RC=$?
check "G1 退出 0（跳过不是失败）" "[ $RC -eq 0 ]"
check "G2 输出里说明了跳过" "printf '%s' \"\$OUT\" | grep -q '跳过'"
check "G3 链接还在" "[ -L '$P/rmd' ]"
check "G4 它指向的 .app 未动" "printf 'APP-BINARY-3\n' | cmp -s - '$T/app3/rmd'"

# ── H：本来就没有 ⇒ 说一声，退出 0 ───────────────────────────────
P="$T/h"; mkdir -p "$P"
OUT=$(run uninstall "$P"); RC=$?
check "H1 退出 0" "[ $RC -eq 0 ]"
check "H2 说了'本来就不存在'" "printf '%s' \"\$OUT\" | grep -q '本来就不存在'"

# ── I：目录 ⇒ uninstall 拒绝（⛔ 不 rm -rf）────────────────────────
P="$T/i"; mkdir -p "$P/rmd"
OUT=$(run uninstall "$P"); RC=$?
check "I1 拒绝（退出非 0）" "[ $RC -ne 0 ]"
check "I2 目录还在" "[ -d '$P/rmd' ]"

echo ""
echo "═══ $PASS 通过 / $FAIL 失败 ═══"
[ "$FAIL" -eq 0 ] || exit 1
