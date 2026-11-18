#!/usr/bin/env python3
"""Stage A 成功判据（`docs/bugs/0254`）。

`cargo test -- --ignored live_block` 在过滤串 0 命中时**退 0**、只打印
`running 0 tests`。因此「cargo 退 0」和「载荷文件非空」都不能证明
`live_block_夹具导出` 真的跑过。本脚本解析完整日志，要求同时命中：

  1. 一行 `running 1 test`
  2. 同一运行段里一行 `test <路径>::<目标测试名> ... ok`
  3. 一段 `test result: ok. 1 passed; 0 failed;`

且三者顺序成立（1 → 2 → 3）。目标测试名默认 `live_block_夹具导出`。

用法：
  check-stage-a-log.py <stage-a.log> [目标测试名子串]

退出码：0 = 日志证明目标测试跑了 1 次且通过；3 = 不能证明（打印原因）。
⛔ 只读日志，不启动任何进程。
"""

import re
import sys

DEFAULT_NEEDLE = "live_block_夹具导出"


def main(argv):
    if len(argv) < 2:
        print("⛔ 用法：check-stage-a-log.py <stage-a.log> [目标测试名子串]",
              file=sys.stderr)
        return 3
    log_path = argv[1]
    needle = argv[2] if len(argv) > 2 and argv[2] else DEFAULT_NEEDLE

    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError as exc:
        print("⛔ 读不了 Stage A 日志：%s（%s）" % (log_path, exc), file=sys.stderr)
        return 3

    running_idx = [i for i, line in enumerate(lines) if line.strip() == "running 1 test"]
    result_re = re.compile(r"^test result: ok\. 1 passed; 0 failed;")
    test_re = re.compile(r"^test .*" + re.escape(needle) + r".*\.\.\. ok\s*$")

    for start in running_idx:
        test_idx = None
        result_idx = None
        for i in range(start + 1, len(lines)):
            line = lines[i].strip()
            if line.startswith("test result:") and result_idx is None:
                result_idx = i
                break
            if test_re.match(line) and test_idx is None:
                test_idx = i
        if test_idx is None or result_idx is None:
            continue
        if not result_re.match(lines[result_idx].strip()):
            continue
        # 该运行段里应恰好只有目标这一条测试（`running 1 test` 已保证数量）。
        segment = [lines[i].strip() for i in range(start + 1, result_idx)
                   if lines[i].strip().startswith("test ")]
        if len(segment) != 1:
            continue
        print("✅ Stage A 日志证明目标测试跑了 1 次且通过：%s" % lines[test_idx].strip())
        return 0

    # ── 失败时给出可诊断的摘要（⛔ 不吞掉「为什么」）────────────────────
    print("⛔ Stage A 日志不能证明 %r 真的跑了（`bugs/0254`）：%s"
          % (needle, log_path), file=sys.stderr)
    zero = sum(1 for line in lines if line.strip() == "running 0 tests")
    one = sum(1 for line in lines if line.strip() == "running 1 test")
    print("   命中：running 1 test ×%d；running 0 tests ×%d" % (one, zero),
          file=sys.stderr)
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("test result:") or stripped.startswith("running "):
            print("   | %s" % stripped, file=sys.stderr)
    if not one:
        print("   ⇒ 过滤串 0 命中时 cargo 仍会退 0；本次导出必须判失败。",
              file=sys.stderr)
    return 3


if __name__ == "__main__":
    sys.exit(main(sys.argv))
