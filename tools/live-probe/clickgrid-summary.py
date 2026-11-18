#!/usr/bin/env python3
"""点击网格扫描的**汇总与退出码**（`tools/live-probe/clickgrid-probe.sh` 的第 ⑤ 步）。

⚠️ 单独成文件只为一件事：**报告器本身要能被测**。它内联在 shell 里时，
"环境无效也退 0" 这种缺陷没有任何判据（2026-11-04 实测踩过：屏幕锁定、rAF 0/8，
汇总打印「0 个点，0 个红点」并退 0 —— 把"没测成"记成了"全绿"）。
⇒ `tests/js/probe-report.test.js` 直接拿构造出来的 `rows.jsonl` 跑这一份，验三条退出码。

用法：`clickgrid-summary.py <rows.jsonl> <to_json 0|1>`

退出码：0 = 没有红点；1 = 有红点或致命；3 = **有夹具环境无效（这一类没测成）**

⚠️ 3 优先于 1：环境无效那一轮的数字整体不可信，先把它排除掉再谈红不红。
"""
import json
import sys


def 读(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def 汇总(rows, to_json):
    """返回 (要打印的行, 退出码)。⛔ 不在这里 print / exit，好让测试直接调。"""
    out = []
    红 = [r for r in rows if r.get("红")]
    致命 = [r for r in rows if r.get("致命")]
    环境 = [r for r in rows if r.get("环境无效")]
    跳过 = [r for r in rows if r.get("跳过")]
    if to_json:
        out.append(json.dumps(rows, ensure_ascii=False, indent=1))
    else:
        # ⚠️ 分母只数**真点过**的：把环境无效 / 致命 / 跳过算进"个点"会让 0 个点的
        #    空跑看起来像"扫了 1 个点"。
        out.append("═══ 点击网格扫描：%d 个点，%d 个红点%s ═══" % (
            len(rows) - len(致命) - len(环境) - len(跳过), len(红),
            "，%d 个跳过" % len(跳过) if 跳过 else ""))
        for r in 红:
            p = r.get("点") or {}
            out.append("  ⛔ %s %s %s@(%d,%d) 命中 %s ⇒ %s" % (
                r.get("夹具"), r.get("目标") or p.get("位置"), "",
                p.get("x", 0), p.get("y", 0), r.get("命中"), "；".join(r["红"])))
        for r in 致命:
            out.append("  ⛔ %s 致命：%s" % (r.get("夹具"), r["致命"]))
        for r in 环境:
            out.append("  ⚠️ %s 环境无效（本轮这些夹具**没测成**）：%s" % (
                r.get("夹具"), r.get("原因")))
        for r in 跳过:
            out.append("  · %s 点 %s 跳过：%s" % (
                r.get("夹具"), r.get("点序号"), r["跳过"]))
    if 环境:
        return out, 3
    return out, (1 if (红 or 致命) else 0)


def main(argv):
    if len(argv) < 3:
        sys.stderr.write("用法：clickgrid-summary.py <rows.jsonl> <to_json 0|1>\n")
        return 2
    lines, code = 汇总(读(argv[1]), argv[2] == "1")
    for line in lines:
        print(line)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
