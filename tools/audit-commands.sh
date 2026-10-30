#!/usr/bin/env bash
# 命令面三方对账（`docs/reviews/2026-10-29-后端与安全面-长跑走查.md` §2）。
#
# 为什么要有它：Tauri 2 的 ACL 是**静默拒**——三条清单（`build.rs` 的 app_manifest、
# `capabilities/default.json` 的 `allow-*`、`gui/mod.rs` 的 `generate_handler!`）任何一处漏了，
# 前端只会拿到一个 `Err`，日志里**一行都没有**（`docs/kb/0007`、`docs/bugs/0002`）。
# 靠人眼比对三份清单已经漏过一次，所以把它变成一条命令。
#
# ⚠️ 名字形状不同：`build.rs` 与 `generate_handler!` 是 **snake_case 函数名**，
#    `capabilities/` 是 **kebab 的 `allow-x-y`**。本脚本把后者的 `allow-` 去掉、`-` 换 `_`
#    再比——两边都对不上就是真的对不上，⛔ 不是"形状差异"。
#
# ⚠️ 只读：不写仓库里任何文件（临时档在 `mktemp -d` 里，退出即删）、不联网、不构建。
# 退出码：0 = 三方一致且没有孤儿 `#[tauri::command]`；1 = 有差异（明细见输出）。
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd) || exit 2
BUILD_RS="$ROOT/src-tauri/build.rs"
CAPS="$ROOT/src-tauri/capabilities/default.json"
GUI_RS="$ROOT/src-tauri/src/gui/mod.rs"

for f in "$BUILD_RS" "$CAPS" "$GUI_RS"; do
  if [ ! -f "$f" ]; then
    echo "⛔ 找不到 $f" >&2
    exit 2
  fi
done

TMP=$(mktemp -d "${TMPDIR:-/tmp}/rmd-audit-commands.XXXXXX") || exit 2
trap 'rm -rf "$TMP"' EXIT

# ── ① build.rs 的 app_manifest 命令清单 ────────────────────────────────────
# 只取 `AppManifest::new().commands(&[ … ])` 这一段里的双引号字面量；
# ⛔ 不要全文件 grep 引号，那会把注释里的例子也扫进来。
awk '/\.commands\(&\[/{inblk=1} inblk{print} inblk && /\]\)/{inblk=0}' "$BUILD_RS" \
  | grep -oE '"[A-Za-z_][A-Za-z0-9_]*"' \
  | tr -d '"' \
  | sort -u > "$TMP/build.txt"

# ── ② capabilities 的 allow-* ──────────────────────────────────────────────
# ⚠️ 排除 `core:…` 那一族（插件权限，不是自有命令）。
grep -oE '"allow-[a-z0-9-]+"' "$CAPS" \
  | tr -d '"' \
  | sed 's/^allow-//' \
  | tr '-' '_' \
  | sort -u > "$TMP/caps.txt"

# ── ③ generate_handler! 注册表 ─────────────────────────────────────────────
# 取宏体里的 `模块::函数名`，**只留最后一段**（与 `fn` 名对齐）。
awk '/generate_handler!\[/{inblk=1; next} inblk && /\]/{inblk=0} inblk{print}' "$GUI_RS" \
  | grep -vE '^\s*//' \
  | grep -oE '[A-Za-z_][A-Za-z0-9_:]*' \
  | awk -F'::' '{print $NF}' \
  | grep -vE '^(tauri|generate_handler)$' \
  | sort -u > "$TMP/handler.txt"

# ── ④ 源码里所有 `#[tauri::command]` 定义 ───────────────────────────────────
# 宏在**下一行**，形状是 `pub (async) fn name(`（含 `#[tauri::command]` 与 `fn` 同行的那种）。
grep -rn -A2 '^[[:space:]]*#\[tauri::command' "$ROOT/src-tauri/src" 2>/dev/null \
  | sed -n 's/.*fn \([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*(.*/\1/p' \
  | sort -u > "$TMP/defined.txt"

report() { # $1=标题 $2=只在左边 $3=只在右边；输出非空则计入差异
  local n
  n=$(wc -l < "$2" | tr -d ' ')
  if [ "$n" = "0" ]; then
    printf '  ✅ %s：无\n' "$1"
    return 0
  fi
  printf '  ⛔ %s（%s 条）:\n' "$1" "$n"
  sed 's/^/      · /' "$2"
  return 1
}

DIFF=0
echo "== 三方对账（$(date '+%Y-%m-%d %H:%M:%S')）=="
echo "  清单长度：build.rs=$(wc -l < "$TMP/build.txt" | tr -d ' ')" \
     "capabilities=$(wc -l < "$TMP/caps.txt" | tr -d ' ')" \
     "generate_handler=$(wc -l < "$TMP/handler.txt" | tr -d ' ')" \
     "源码 #[tauri::command]=$(wc -l < "$TMP/defined.txt" | tr -d ' ')"

echo
echo "-- ① 注册表 ↔ build.rs --"
comm -23 "$TMP/handler.txt" "$TMP/build.txt" > "$TMP/a"
comm -13 "$TMP/handler.txt" "$TMP/build.txt" > "$TMP/b"
report "已注册但 build.rs 没列（ACL 会静默拒）" "$TMP/a" || DIFF=1
report "build.rs 列了但没注册（死条目）" "$TMP/b" || DIFF=1

echo
echo "-- ② 注册表 ↔ capabilities --"
comm -23 "$TMP/handler.txt" "$TMP/caps.txt" > "$TMP/c"
comm -13 "$TMP/handler.txt" "$TMP/caps.txt" > "$TMP/d"
report "已注册但 capabilities 没 allow（ACL 会静默拒）" "$TMP/c" || DIFF=1
report "capabilities 有 allow 但没注册（陈旧权限）" "$TMP/d" || DIFF=1

echo
echo "-- ③ build.rs ↔ capabilities --"
comm -23 "$TMP/build.txt" "$TMP/caps.txt" > "$TMP/e"
comm -13 "$TMP/build.txt" "$TMP/caps.txt" > "$TMP/f"
report "build.rs 有、capabilities 没有" "$TMP/e" || DIFF=1
report "capabilities 有、build.rs 没有" "$TMP/f" || DIFF=1

echo
echo "-- ④ 源码 #[tauri::command] ↔ 注册表 --"
comm -23 "$TMP/defined.txt" "$TMP/handler.txt" > "$TMP/g"
comm -13 "$TMP/defined.txt" "$TMP/handler.txt" > "$TMP/h"
report "定义了但没注册（命令调不到）" "$TMP/g" || DIFF=1
report "注册了但源码里找不到定义（改名残留）" "$TMP/h" || DIFF=1

echo
if [ "$DIFF" = "0" ]; then
  echo "结论：四组对照全部为空 ⇒ 三方一致。"
  exit 0
fi
echo "结论：有差异（见上）。⚠️ 只多不少/只少不多都要人工确认，⛔ 别只看'能跑'。"
exit 1
