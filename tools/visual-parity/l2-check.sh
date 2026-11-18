#!/usr/bin/env bash
# 端侧对照测试 L2 的**比对入口**（`docs/design/0063-Mardo-端侧对照测试.md` §7.2 步 4/5）。
#
# 用法：
#   tools/visual-parity/l2-check.sh --fixture <name> \
#       [--baseline baseline.json] [--expect fixtures-expect.json] \
#       [--coverage coverage.json] [--work .work] [--fixtures-dir fixtures] \
#       [--out result.json]
#
#   --fixture  夹具名：`00-body` 或 `00-body.md`（读 .work/<name>/measured.json）
#   --baseline L1 实测基线；**不存在时 -PARITY 记 skipped(no-baseline)，⛔ 不退 0**
#   --expect   fixtures-expect.json；**夹具 sha256 与基线不一致 ⇒ 报「基线过期」，⛔ 不静默比较**
#   --coverage coverage.json（§3 判据清单）；缺文件 ⇒ 覆盖无效，⛔ 不判绿
#   --payload  Stage A 导出的 .work/fixtures.json（P-COV-02 块序列/结构摘要输入）
#   --ocr      外部 OCR 结果 JSON（P-COV-03 分母核对；缺省由覆盖闸门记 SKIP）
#   --out      结果 JSON 落点；默认 `.work/<fixture>/result.json`
#
# 管线：
#   1) preflight.py gates       —— P-ENV-01..06 六条环境闸门
#   2) ast-expect-check.py gates —— P-COV-01..04 覆盖闸门（0135：必须真正执行，
#        覆盖缺项/设计不同步/provenance 不完整一律影响退出码）
#   3) preflight.py compare     —— -SPEC / -PARITY / -REG / -L3 四族比较
#        -SPEC   只读测量阶段给出的同端合规检查项（期望来自规范/产品契约）
#        -PARITY 只用 L1 实测基线；必须 provenance + fixture_sha256；
#                 L2-OCR 另须 review 三项；没有基线 ⇒ skipped(no-baseline)
#        -REG    仅登记，⛔ 不进 pass/fail
#        -L3     人工目视，⛔ 拒绝自动判绿（输入自称 pass 也不采信）
#   4) 合并出 result.json ＋ 人类可读结论；退出码反映真实结果
#
# 退出码（与 preflight.py 一致；覆盖闸门失败按性质映射到 20/30，⛔ 不新增码）：
#   0  PASS                      环境、覆盖与已执行判据全绿
#   2  ERROR                     参数 / 缺必需输入 / JSON 损坏
#   10 PRODUCT-MISMATCH          环境有效，-SPEC 或 -PARITY 红
#   15 PRODUCT-TYPOGRAPHY-CHANGE P-ENV-06 判因分叉：三字段一致而 DOM 行盒数变
#   20 ENVIRONMENT-INVALID       任一 P-ENV 红，或 P-COV-04 provenance 不完整，
#                                 或 compare 自身判覆盖无效（单一实现在 preflight）
#   30 INCOMPLETE                环境/覆盖/判据有未完成项（no-baseline、基线过期、
#                                 期望未冻结、覆盖缺项、register_only 无 PARITY 实比等）
#
# ⚠️ 只读离屏产物：不启动/激活 app、不 open、不发合成事件、不跑 cargo。
# ⚠️ Python 一律用 `-I`（隔离模式）：避免从当前目录载入同名模块。

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$HERE/.work"
BASELINE="$HERE/baseline.json"
EXPECT="$HERE/fixtures-expect.json"
COVERAGE="$HERE/coverage.json"
PAYLOAD="$HERE/.work/fixtures.json"
OCR=""
FIXTURES="$HERE/fixtures"
FIXTURE=""
OUT=""
PYTHON="${PYTHON:-python3}"

usage() {
  sed -n '2,41p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "⛔ $*" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fixture)
      [ "$#" -ge 2 ] || die "--fixture 需要参数"
      FIXTURE="$2"; shift 2 ;;
    --baseline)
      [ "$#" -ge 2 ] || die "--baseline 需要参数"
      BASELINE="$2"; shift 2 ;;
    --expect)
      [ "$#" -ge 2 ] || die "--expect 需要参数"
      EXPECT="$2"; shift 2 ;;
    --coverage)
      [ "$#" -ge 2 ] || die "--coverage 需要参数"
      COVERAGE="$2"; shift 2 ;;
    --payload)
      [ "$#" -ge 2 ] || die "--payload 需要参数"
      PAYLOAD="$2"; shift 2 ;;
    --ocr)
      [ "$#" -ge 2 ] || die "--ocr 需要参数"
      OCR="$2"; shift 2 ;;
    --work)
      [ "$#" -ge 2 ] || die "--work 需要参数"
      WORK="$2"; shift 2 ;;
    --fixtures-dir)
      [ "$#" -ge 2 ] || die "--fixtures-dir 需要参数"
      FIXTURES="$2"; shift 2 ;;
    --out)
      [ "$#" -ge 2 ] || die "--out 需要参数"
      OUT="$2"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      die "不认识的参数：${1}（用 --help 看用法）" ;;
  esac
done

[ -n "$FIXTURE" ] || die "缺 --fixture <name>"
command -v "$PYTHON" >/dev/null 2>&1 || die "找不到 python3（需要 3.8+）"
[ -f "$HERE/preflight.py" ] || die "缺 $HERE/preflight.py"

CANON="${FIXTURE%.md}"
CANON="$(basename "$CANON")"
[ -n "$CANON" ] || die "非法夹具名：$FIXTURE"

FIXTURE_DIR=""
for cand in "$WORK/$CANON" "$WORK/$CANON.md"; do
  if [ -d "$cand" ]; then FIXTURE_DIR="$cand"; break; fi
done
[ -n "$FIXTURE_DIR" ] || die "找不到夹具工作目录：$WORK/${CANON}（先跑 l2-run.sh / bands.py）"
[ -f "$FIXTURE_DIR/measured.json" ] || die "缺 $FIXTURE_DIR/measured.json"

[ -n "$OUT" ] || OUT="$FIXTURE_DIR/result.json"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/l2-check.XXXXXX")" || die "mktemp 失败"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

GATES_JSON="$TMP/gates.json"
COV_JSON="$TMP/coverage-gates.json"
COMPARE_JSON="$TMP/compare.json"

echo "════════════════════════════════════════════════════════════════════"
echo "L2 比对 · fixture ${CANON}.md"
echo "  work     : $FIXTURE_DIR"
echo "  baseline : $BASELINE$([ -f "$BASELINE" ] || echo '（不存在）')"
echo "  expect   : $EXPECT$([ -f "$EXPECT" ] || echo '（不存在）')"
echo "  coverage : $COVERAGE$([ -f "$COVERAGE" ] || echo '（不存在）')"
echo "  payload  : $PAYLOAD$([ -f "$PAYLOAD" ] || echo '（不存在）')"
[ -n "$OCR" ] && echo "  ocr      : $OCR"
echo "  result   : $OUT"
echo "════════════════════════════════════════════════════════════════════"
echo
echo "▶ 1/4 环境闸门（P-ENV-01..06）"
"$PYTHON" -I "$HERE/preflight.py" gates \
  --fixture "$CANON" \
  --work "$WORK" \
  --baseline "$BASELINE" \
  --expect "$EXPECT" \
  --coverage "$COVERAGE" \
  --fixtures-dir "$FIXTURES" \
  --json-out "$GATES_JSON"
GATES_RC=$?

if [ ! -s "$GATES_JSON" ]; then
  echo "⛔ 环境闸门没有产出结果 JSON（退出码 ${GATES_RC}）：输入错误，停止比对" >&2
  exit 2
fi

echo
echo "▶ 2/4 覆盖闸门（P-COV-01..04；0135：未被执行的闸门不得算通过）"
COV_ARGS=(--coverage "$COVERAGE" --expect "$EXPECT" --baseline "$BASELINE"
          --payload "$PAYLOAD" --json "$COV_JSON")
[ -n "$OCR" ] && COV_ARGS+=(--ocr "$OCR")
"$PYTHON" -I "$HERE/ast-expect-check.py" gates "${COV_ARGS[@]}"
COV_RC=$?

if [ ! -s "$COV_JSON" ]; then
  echo "⛔ 覆盖闸门没有产出结果 JSON（退出码 ${COV_RC}）：输入错误，停止比对" >&2
  exit 2
fi

echo
echo "▶ 3/4 家族比较（-SPEC / -PARITY / -REG / -L3）"
"$PYTHON" -I "$HERE/preflight.py" compare \
  --fixture "$CANON" \
  --work "$WORK" \
  --baseline "$BASELINE" \
  --expect "$EXPECT" \
  --coverage "$COVERAGE" \
  --fixtures-dir "$FIXTURES" \
  --gates-json "$GATES_JSON" \
  --json-out "$COMPARE_JSON"
COMPARE_RC=$?

if [ ! -s "$COMPARE_JSON" ]; then
  echo "⛔ 家族比较没有产出结果 JSON（退出码 ${COMPARE_RC}）：停止" >&2
  exit 2
fi

echo
echo "▶ 4/4 结论"

"$PYTHON" -I - "$GATES_JSON" "$COV_JSON" "$COMPARE_JSON" "$OUT" "$CANON" "$COV_RC" <<'PY'
import json
import os
import sys
import time

gates_path, cov_path, compare_path, out_path, fixture, cov_rc = sys.argv[1:7]
cov_rc = int(cov_rc)

with open(gates_path, encoding="utf-8") as f:
    gates = json.load(f)
with open(cov_path, encoding="utf-8") as f:
    coverage_gates = json.load(f)
with open(compare_path, encoding="utf-8") as f:
    compare = json.load(f)

env = gates.get("overall") or {}
env_status = env.get("status")
families = compare.get("families") or {}
spec = families.get("SPEC") or {"status": "n/a", "items": []}
parity = families.get("PARITY") or {"status": "n/a", "items": []}
register = families.get("REG") or {"status": "n/a", "items": []}
l3 = families.get("L3") or {"status": "n/a", "items": []}
compare_overall = compare.get("overall") or {}
coverage_invalid = bool(compare.get("coverage_invalid"))


def items_with(family, *statuses):
    return [item for item in family.get("items") or [] if item.get("status") in statuses]


def family_reason(family):
    reason = family.get("reason")
    status = family.get("status")
    if status == "skipped" and reason:
        return f"skipped({reason})"
    return status


# ── 覆盖闸门（0159：单一实现只认 preflight 的 overall；覆盖只做准入）──
cov_results = coverage_gates.get("results") or []
cov_problems = [r for r in cov_results if r.get("status") != "PASS"]
cov_fail = [r for r in cov_problems if r.get("status") == "FAIL"]
cov_04_fail = [r for r in cov_fail if r.get("gate") == "P-COV-04"]
cov_summary = coverage_gates.get("summary") or {}

spec_fail = items_with(spec, "fail")
parity_fail = items_with(parity, "fail")
parity_skip = items_with(parity, "skipped")
spec_pass = items_with(spec, "pass")
parity_pass = items_with(parity, "pass")
parity_compared = compare.get("parity_compared_items")
compared = compare.get("compared_items")

if cov_rc == 3:
    # 覆盖闸门输入畸形/不可读：契约内 ERROR，⛔ 不当作判据红。
    code, label, category = 2, "ERROR", "error"
    detail = "覆盖闸门输入不可读/畸形（P-COV 输入错误）⇒ 本轮无结论"
elif cov_04_fail:
    code, label, category = 20, "ENVIRONMENT-INVALID", "environment-invalid"
    detail = ("P-COV-04 红：baseline 条目的 provenance / fixture_sha256 / review "
              "不完整或混入非 -PARITY 行 ⇒ 整轮作废，⛔ 不记产品红")
elif cov_problems:
    # 0135：覆盖闸门 FAIL/SKIP/WARN 都必须影响退出码；缺席不是通过。
    code, label, category = 30, "INCOMPLETE", "incomplete"
    names = "、".join(f"{r.get('gate')}/{r.get('check')}={r.get('status')}"
                      for r in cov_problems[:10])
    detail = ("覆盖闸门有未完成项 ⇒ ⛔ 不判绿：" + names
              + (f" 等 {len(cov_problems)} 项" if len(cov_problems) > 10 else ""))
else:
    # 单一判据梯：只读 preflight compare 的 overall（0159：两处实现结论必须一致）。
    # ⛔ `int(... or 30)` 会把合法的 exit_code=0 折成 30（PASS 永不可达）。
    raw_code = compare_overall.get("exit_code")
    try:
        code = 30 if raw_code is None else int(raw_code)
    except (TypeError, ValueError):
        code = 30
    if coverage_invalid or code == 20:
        code, label, category = 20, "ENVIRONMENT-INVALID", "environment-invalid"
        detail = ("compare 判定覆盖无效：coverage.json 不可用，或 SPEC/PARITY 条目 "
                  "invalid（provenance / fixture_sha256 / review / 后缀）⇒ 整轮作废")
    elif code == 15:
        label, category = "PRODUCT-TYPOGRAPHY-CHANGE", "product-typography-change"
        detail = f"{env.get('summary') or 'P-ENV-06 判因分叉'}；按 §2.6 重生成期望"
    elif code == 10:
        fails = [item.get("id") for item in spec_fail + parity_fail]
        label, category = "PRODUCT-MISMATCH", "product-mismatch"
        detail = ("环境有效，判据不一致：" + "、".join(str(x) for x in fails)
                  + "；SPEC 红记缺陷，PARITY 红记「与 Mardo 不同」由人决定是否追平")
    elif code == 0:
        label, category = "PASS", "pass"
        detail = (f"环境闸门全绿；覆盖闸门 {cov_summary.get('PASS', 0)} 项通过；"
                  f"SPEC {len(spec_pass)} 条通过、PARITY {len(parity_pass)} 条通过"
                  f"（PARITY 实比 {parity_compared} 条，累计 {compared} 条）；"
                  f"REG {len(register.get('items') or [])} 条仅登记；L3 需人工验收")
    else:
        label, category = "INCOMPLETE", "incomplete"
        detail = (f"有判据/闸门未完成、⛔ 不判绿：SPEC={family_reason(spec)}、"
                  f"PARITY={family_reason(parity)}；PARITY 实比 {parity_compared} 条")

# bug/0264：整体因 invalid 判 20 时，族状态不能再写 fail（fail-first 的词面矛盾）。
# 只改写「确实含 invalid 条目」的族，并保留 raw_status 供追查。
if code == 20 and coverage_invalid:
    for _name, _family in (families or {}).items():
        if not isinstance(_family, dict):
            continue
        _items = _family.get("items") or []
        if not any(item.get("status") == "invalid" for item in _items):
            continue
        if _family.get("status") != "invalid":
            _family["raw_status"] = _family.get("status")
            _family["status"] = "invalid"

result = {
    "tool": "l2-check",
    "fixture": fixture,
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "inputs": gates.get("inputs"),
    "preflight": {
        "overall": env,
        "gates": gates.get("gates"),
    },
    "coverage_gates": {
        "overall": {
            "exit_code": cov_rc,
            "summary": cov_summary,
            "problems": [f"{r.get('gate')}/{r.get('check')}={r.get('status')}"
                         for r in cov_problems],
        },
        "results": cov_results,
    },
    "compare_overall": compare_overall,
    "compared_items": compared,
    "parity_compared_items": parity_compared,
    "families": families,
    "coverage_invalid": coverage_invalid,
    "verdict": {
        "code": code,
        "label": label,
        "category": category,
        "detail": detail,
        "environment_status": env_status,
        "distinguishes": {
            "environment_invalid": category == "environment-invalid",
            "product_mismatch": category == "product-mismatch",
            "not_green_skips": code == 30,
        },
        "parity": family_reason(parity),
        "spec": family_reason(spec),
        "register": family_reason(register),
        "l3": family_reason(l3),
    },
}

parent = os.path.dirname(os.path.abspath(out_path))
if parent and not os.path.isdir(parent):
    os.makedirs(parent, exist_ok=True)
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
    f.write("\n")

print(f"结论：{label}（exit {code}）")
print(f"  类别：{category}")
print(f"  依据：{detail}")
print("  家族：" + "；".join([
    f"SPEC={spec.get('status')}",
    f"PARITY={family_reason(parity)}",
    f"REG={register.get('status')}",
    f"L3={family_reason(l3)}",
]))
if parity_skip:
    print("  ⛔ 未判绿的 -PARITY 条目：")
    for item in parity_skip[:20]:
        reason = item.get("reason") or "skipped"
        print(f"     - {item.get('id')}  {reason}  {item.get('detail') or ''}")
print(f"  结果 JSON：{out_path}")
sys.exit(code)
PY

RC=$?
exit "$RC"
