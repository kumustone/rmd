#!/usr/bin/env bash
# 跑「⌘F 会不会被 WKWebView 吞掉」探针（`design/0011` §7 步骤 0b）
#
# 用法：
#   tools/wkwebview-probe/find-keyprobe.sh              # 落盘到 benchmarks/results/
#   tools/wkwebview-probe/find-keyprobe.sh --stdout     # 只打屏幕，不落盘
#   tools/wkwebview-probe/find-keyprobe.sh --force      # 允许覆盖已有的同名结果
#   ROUNDS=3 tools/wkwebview-probe/find-keyprobe.sh     # 多轮（布尔判据，3 轮足够）
#
# ⚠️ 与 `make bench` 同一条纪律：`benchmarks/results/` 是**历史记录**，默认**拒绝覆盖**。
#
# ⚠️⚠️ 本脚本用 `osascript` 合成**真按键**（走 WindowServer 的事件路径，等价于真人按一次）。
#     因此**调用进程需要「辅助功能」权限**。权限没给时 System Events **静默不送键**——
#     那和"被吞"长得一模一样。⇒ 本脚本**总是同时发一个无主键 `⌘K` 作对照**：
#     对照也没到 ⇒ 判为**权限问题**，退 3，⛔ 不许读成"被吞"。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

TO_STDOUT=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --stdout) TO_STDOUT=1 ;;
    --force)  FORCE=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

ROUNDS="${ROUNDS:-1}"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "⛔ 没有 swiftc。这条探针需要 Xcode 命令行工具：xcode-select --install" >&2
  exit 1
fi
if ! command -v osascript >/dev/null 2>&1; then
  echo "⛔ 没有 osascript。" >&2
  exit 1
fi

MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
TODAY="$(date -u +%F)"
OUT="$ROOT/benchmarks/results/find-key-${TODAY}-${MODEL}.json"

# ⚠️ 覆盖检查在**编译之前**：编译要几十秒，跑完才发现要拒绝等于白跑
if [ "$TO_STDOUT" != "1" ] && [ -f "$OUT" ] && [ "$FORCE" != "1" ]; then
  echo "⛔ 拒绝覆盖 $OUT" >&2
  echo "   benchmarks/results/ 是历史记录（docs/README.md §6）。要留两份对比：先改名，或加 --force。" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "▶ 编译探针…" >&2
swiftc -O "$HERE/find-keyprobe.swift" -o "$WORK/find-keyprobe" >"$WORK/build.log" 2>&1 || {
  echo "⛔ 编译失败：" >&2; cat "$WORK/build.log" >&2; exit 1
}

# ⚠️ 每次发键**之前**都等探针真的在前台：`System Events` 把键送**当前前台应用**。
#    探针自己在等待窗口里持续抢焦点（见 .swift 里那个 Timer），这里再对齐一次就稳了。
send_key() {
  local key="$1" front=""
  for _ in $(seq 1 40); do
    front="$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null || true)"
    [ "$front" = "find-keyprobe" ] && break
    sleep 0.25
  done
  if [ "$front" != "find-keyprobe" ]; then
    echo "⚠️ 探针没能成为前台应用（当前前台：${front:-未知}）——这一键可能脱靶" >&2
  fi
  sleep 0.4
  osascript -e "tell application \"System Events\" to keystroke \"$key\" using command down" >/dev/null 2>&1 || true
  sleep 1.6
}

# 跑**一轮**：起探针 → 发 ⌘F 与对照 ⌘K → 收 JSON。返回 0 表示两键都到（这一轮算数）。
# ⚠️ 整轮失败是**真实存在**的（前台被别的应用抢走 / `System Events` 丢键）——
#    所以判据是"两键都到"，否则**重试整轮**。⛔ 不许把脱靶轮混进结论里。
run_one_round() {
  local raw="$1" err="$2"
  rm -f "$raw" "$err"
  "$WORK/find-keyprobe" >"$raw" 2>"$err" &

  for _ in $(seq 1 60); do
    grep -q '^READY$' "$raw" 2>/dev/null && break
    sleep 0.5
  done
  if ! grep -q '^READY$' "$raw" 2>/dev/null; then
    echo "⛔ 探针没能进入就绪态（当前不在图形会话里？SSH / 无登录桌面）。stderr：" >&2
    cat "$err" >&2
    exit 4
  fi

  # ⭐ 真按键：先 ⌘F（被测），再 ⌘K（对照，全项目**无绑定**）
  send_key f
  send_key k

  for _ in $(seq 1 80); do
    pgrep -f "$WORK/find-keyprobe" >/dev/null || break
    sleep 0.5
  done
  sleep 1.5   # 轮间留白：上一轮进程彻底退干净再起下一轮（⛔ 别让两轮抢前台）

  python3 -I -c "
import json, sys
t = open(sys.argv[1], encoding='utf-8').read()
try:
    d = json.loads(t[t.index('{'):])
except Exception:
    sys.exit(1)
ks = {e['key'] for e in d['页面侧'].get('keys', [])}
sys.exit(0 if {'f', 'k'} <= ks else 1)
" "$raw" >/dev/null 2>&1
}

for r in $(seq 1 "$ROUNDS"); do
  RAW="$WORK/round$r.txt"
  ERR="$WORK/round$r.err"
  ok=1
  for attempt in 1 2 3; do
    echo "▶ 第 $r/$ROUNDS 轮（第 $attempt 次尝试）…（会开一个前台窗口，别碰键盘）" >&2
    if run_one_round "$RAW" "$ERR"; then ok=0; break; fi
    echo "   ⚠️ 这一轮按键没到齐，重试…" >&2
  done
  if [ "$ok" != "0" ]; then
    echo "⛔ 第 $r 轮连续 3 次都没收到按键。若每轮都这样 ⇒ 多半是「辅助功能」权限没给" >&2
    echo "   （System Events 权限不足时**静默不送键**，与「被吞」同形）⇒ 退 3。" >&2
    exit 3
  fi
done

echo "$ROUNDS" >"$WORK/rounds.txt"

python3 -I - "$WORK" "$TO_STDOUT" "$OUT" "$MODEL" "$TODAY" <<'PY'
import json, os, platform, sys

work, to_stdout, out, model, today = sys.argv[1:6]
rounds_n = int(open(os.path.join(work, "rounds.txt")).read().strip())

def load_round(i):
    p = os.path.join(work, f"round{i}.txt")
    txt = open(p, encoding="utf-8").read()
    start = txt.index("{")           # 跳过 READY 之前的行
    return json.loads(txt[start:])

rounds = [load_round(i) for i in range(1, rounds_n + 1)]

def keys_of(r):
    return {e["key"]: e for e in r["页面侧"].get("keys", [])}

summary = {"cmd_f_arrived": [], "cmd_k_arrived": [], "both": [], "verdict": None}

for r in rounds:
    k = keys_of(r)
    f_hit = k.get("f")
    ctl_hit = k.get("k")
    summary["cmd_f_arrived"].append(bool(f_hit and f_hit.get("meta")))
    summary["cmd_k_arrived"].append(bool(ctl_hit and ctl_hit.get("meta")))
    summary["both"].append({
        "f_meta": bool(f_hit and f_hit.get("meta")),
        "f_code": (f_hit or {}).get("code"),
        "f_keyCode": (f_hit or {}).get("keyCode"),
        "f_defaultPrevented": (f_hit or {}).get("defaultPrevented"),
        "f_afterDefaultPrevented": (f_hit or {}).get("afterDefaultPrevented"),
        "k_meta": bool(ctl_hit and ctl_hit.get("meta")),
        "prevented_calls": r["页面侧"].get("prevented", []),
        "text_finder_called": any("performTextFinderAction" in s for s in r["原生侧"].get("日志", [])),
        "responds_to_text_finder": r["前提"].get("responds_to_text_finder"),
        "new_visible_windows": r["原生侧"].get("新增且可见的窗口数"),
        "all_windows": r["原生侧"].get("全部窗口"),
    })

f_all = all(summary["cmd_f_arrived"])
ctl_all = all(summary["cmd_k_arrived"])

if not ctl_all:
    summary["verdict"] = "⚠️ 对照组也没到 ⇒ 这是「辅助功能权限没给」或「探针没在前台」，⛔ 不是「被吞」。无结论。"
    rc = 3
elif f_all:
    summary["verdict"] = "✅ ⌘F 没被吞：页面收到 keydown（metaKey=true、defaultPrevented=false、performTextFinderAction 从未被调、无新增可见窗口）⇒ Owner::Web 成立。"
    rc = 0
else:
    summary["verdict"] = "⛔ ⌘F 被吞：对照组到了而 ⌘F 没到 ⇒ Owner::Web 不成立，须改走菜单加速键。"
    rc = 1

doc = {
    "schema": "rmd-find-keyprobe/1",
    "date": today,
    "口径": {
        "说明": "design/0011 §7 步骤 0b：菜单里无 ⌘F、正文不可编辑时，⌘F 到不到得了页面。",
        "按键方式": "osascript System Events keystroke（合成真按键，走 WindowServer 事件路径）",
        "为什么带对照组": "权限没给时 System Events 静默不送键，与“被吞”同形；故同时发一个无主键 ⌘K。",
        "轮数": rounds_n,
    },
    "环境": {
        "machine_model": model,
        "os_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "swift": os.popen("swiftc --version 2>/dev/null | head -1").read().strip(),
        "python": platform.python_version(),
    },
    "汇总结论": summary,
    "原始": rounds,
}

if to_stdout == "1":
    print(json.dumps(doc, ensure_ascii=False, indent=2))
    print("\n" + summary["verdict"], file=sys.stderr)
    sys.exit(rc)

os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(json.dumps(summary, ensure_ascii=False, indent=2))
print(f"\n{summary['verdict']}")
print(f"✅ 结果写入 {out}", file=sys.stderr)
sys.exit(rc)
PY
