#!/usr/bin/env python3
"""把 L2-DOM 实测的行盒数回填进 `fixtures-expect.json`（`docs/bugs/0195`）。

现状（0195）：20 条 `dom_line_boxes` 是手工抄进去的，仓库内没有生成脚本；
`generated_at` 也不随回填更新。本脚本给出可重放的载体：

  对期望文件里的每个夹具，读取 `<work-dir>/<夹具>/dom.json` 的
  `dom.doc.line_boxes.count`，写回 `dom_line_boxes`，
  同时更新该条 `generated_at`（**UTC** ISO8601，`Z` 结尾，与
  `export-fixtures.sh` 一致），并写 `provenance` 指针（`source_work`
  绝对路径 ＋ `dom.json` 的 mtime/sha256）。

缺 `dom.json` 的夹具**显式列进 `missing`**，载荷读不出来的列进 `invalid`；
⛔ 不静默跳过。默认只要存在 missing/invalid 就**不写文件**并退 3
（`--allow-partial` 才允许只写能回填的条目）。`--dry-run` 只打印报告、不动文件。

真写之前按 `0194` 口径**先备份**目标期望：默认在同目录生成
`<expect>.bak.<UTC 时间戳>.<pid>`；`--backup-dir <dir>` 可改目录。写成功后
打印备份路径；备份失败则不写并退 3。

用法：
  backfill-expect.py --work-dir <dir> [--expect <path>] [--dry-run]
                     [--allow-partial] [--backup-dir <dir>]

`dom.json` 目录约定：`<work-dir>/<夹具 stem>/dom.json`
（例如 `--work-dir tools/visual-parity/.work`）。

`SOURCE_DATE_EPOCH`（可选）：十进制非负整数；设置后 `generated_at` /
`backfilled_at` 用它固定（与导出侧一致），非法值退 3。

退出码：0 = 成功（含 dry-run）；2 = 用法错误；3 = 数据不足或读写失败。
⛔ 本轮只要求工具可用 ＋ 干跑；不要在没有设计裁定的情况下真跑
（`bugs/0282` / `0283` 的排版口径尚未定）。
"""

import argparse
import datetime
import hashlib
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def utc_stamp(ts=None):
    """UTC ISO8601（Z 结尾），如 2026-11-08T12:10:00Z；与导出侧一致。

    `ts=None` 时取当前时间；`SOURCE_DATE_EPOCH` 已设置则用它固定。
    """
    if ts is None:
        raw = os.environ.get("SOURCE_DATE_EPOCH", "")
        if raw != "":
            try:
                ts = int(raw, 10)
            except ValueError:
                print("⛔ SOURCE_DATE_EPOCH 必须是十进制非负整数（实际：%r）" % raw,
                      file=sys.stderr)
                raise SystemExit(3)
            if ts < 0:
                print("⛔ SOURCE_DATE_EPOCH 不能为负（实际：%r）" % raw, file=sys.stderr)
                raise SystemExit(3)
        else:
            ts = time.time()
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fixture_stem(name):
    return name[:-3] if name.endswith(".md") else name


def read_count(dom_path):
    """返回 (count, error)。⛔ 只认 dom.doc.line_boxes.count（0195 的实测口径）。"""
    try:
        with open(dom_path, encoding="utf-8") as f:
            data = json.load(f)
    except OSError as exc:
        return None, "读不了 dom.json：%s" % exc
    except ValueError as exc:
        return None, "dom.json 不是合法 JSON：%s" % exc
    if not isinstance(data, dict):
        return None, "dom.json 顶层不是对象"
    dom = data.get("dom")
    if not isinstance(dom, dict):
        return None, "缺 dom 对象"
    doc = dom.get("doc")
    if not isinstance(doc, dict):
        return None, "缺 dom.doc 对象"
    line_boxes = doc.get("line_boxes")
    if not isinstance(line_boxes, dict):
        return None, "缺 dom.doc.line_boxes 对象"
    count = line_boxes.get("count")
    if isinstance(count, bool) or not isinstance(count, int):
        return None, "dom.doc.line_boxes.count 不是整数：%r" % (count,)
    if count < 0:
        return None, "dom.doc.line_boxes.count 为负：%r" % (count,)
    return count, None


def write_atomic(path, data):
    out_dir = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(out_dir, exist_ok=True)
    tmp_path = path + ".tmp.%d" % os.getpid()
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def backup_expect(path, backup_dir):
    """按 `0194` 口径备份目标期望文件；返回备份路径。

    默认：`<expect>.bak.<UTC 时间戳>.<pid>`（同目录）。
    `backup_dir` 非空：`<backup_dir>/<basename>.bak.<UTC 时间戳>.<pid>`。
    """
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = os.path.basename(path)
    if backup_dir:
        os.makedirs(backup_dir, exist_ok=True)
        dest = os.path.join(backup_dir, "%s.bak.%s.%d" % (base, stamp, os.getpid()))
    else:
        dest = "%s.bak.%s.%d" % (path, stamp, os.getpid())
    shutil.copy2(path, dest)
    return dest


def main(argv):
    parser = argparse.ArgumentParser(
        description="从 <work-dir>/<夹具>/dom.json 回填 dom_line_boxes（bugs/0195）")
    parser.add_argument("--work-dir", required=True,
                        help="含 <夹具>/dom.json 的工作目录（如 tools/visual-parity/.work）")
    parser.add_argument("--expect", default=os.path.join(HERE, "fixtures-expect.json"),
                        help="目标 fixtures-expect.json（默认同目录那份）")
    parser.add_argument("--dry-run", action="store_true",
                        help="只打印将写入什么，⛔ 不动文件")
    parser.add_argument("--allow-partial", action="store_true",
                        help="存在 missing/invalid 时仍写能回填的条目（默认不写并退 3）")
    parser.add_argument("--backup-dir", default=None,
                        help="真写前的备份目录（默认 <expect>.bak.<UTC 时间戳>.<pid>）")
    args = parser.parse_args(argv[1:])

    expect_path = os.path.abspath(args.expect)
    work_dir = os.path.abspath(args.work_dir)

    try:
        with open(expect_path, encoding="utf-8") as f:
            expect = json.load(f)
    except OSError as exc:
        print("⛔ 读不了期望文件：%s（%s）" % (expect_path, exc), file=sys.stderr)
        return 3
    except ValueError as exc:
        print("⛔ 期望文件不是合法 JSON：%s（%s）" % (expect_path, exc), file=sys.stderr)
        return 3
    if not isinstance(expect, dict):
        print("⛔ 期望文件顶层不是对象：%s" % expect_path, file=sys.stderr)
        return 3
    if not os.path.isdir(work_dir):
        print("⛔ --work-dir 不是目录：%s" % work_dir, file=sys.stderr)
        return 3

    now = utc_stamp()
    updated = []
    unchanged = []
    missing = []
    invalid = []
    written = 0
    new_expect = {name: dict(entry) if isinstance(entry, dict) else entry
                  for name, entry in expect.items()}

    for name in sorted(expect):
        entry = expect[name]
        if not isinstance(entry, dict):
            invalid.append({"fixture": name, "path": None,
                            "reason": "期望条目的顶层不是对象"})
            continue
        stem = fixture_stem(name)
        dom_path = os.path.join(work_dir, stem, "dom.json")
        if not os.path.isfile(dom_path):
            missing.append({"fixture": name, "expected_path": dom_path})
            continue
        count, error = read_count(dom_path)
        if error:
            invalid.append({"fixture": name, "path": dom_path, "reason": error})
            continue

        try:
            mtime = os.path.getmtime(dom_path)
            digest = sha256_file(dom_path)
        except OSError as exc:
            invalid.append({"fixture": name, "path": dom_path,
                            "reason": "读 dom.json 元数据失败：%s" % exc})
            continue

        old = entry.get("dom_line_boxes")
        row = {
            "fixture": name,
            "old": old,
            "new": count,
            "source_work": dom_path,
            "dom_json_mtime": utc_stamp(mtime),
            "dom_json_sha256": digest,
        }
        if old == count:
            unchanged.append(row)
        else:
            updated.append(row)
        written += 1

        # ⭐ 即使数值恰好等于旧值，也要写 provenance 与 generated_at：
        #    0195 的诉求之一是「这些值依据的是哪一次运行」，不是只在数值变化时才记。
        new_expect[name]["dom_line_boxes"] = count
        new_expect[name]["generated_at"] = now
        new_expect[name]["provenance"] = {
            "schema": "l2-expect-provenance/1",
            "source_work": dom_path,
            "dom_json_mtime": utc_stamp(mtime),
            "dom_json_sha256": digest,
            "dom_line_boxes_field": "dom.doc.line_boxes.count",
            "backfilled_at": now,
        }

    report = {
        "schema": "l2-expect-backfill-report/1",
        "expect": expect_path,
        "work_dir": work_dir,
        "dry_run": bool(args.dry_run),
        "generated_at": now,
        "updated": updated,
        "unchanged": unchanged,
        "missing": missing,
        "invalid": invalid,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))

    if missing or invalid:
        print("⚠️ 未能回填：missing=%d，invalid=%d（逐条见上）"
              % (len(missing), len(invalid)), file=sys.stderr)
    if args.dry_run:
        print("· dry-run：未写文件（将回填 %d 条，其中值变化 %d 条）"
              % (written, len(updated)), file=sys.stderr)
        return 0
    if (missing or invalid) and not args.allow_partial:
        print("⛔ 有夹具缺 dom.json / 数据非法 ⇒ 不写文件（加 --allow-partial 才部分写入）",
              file=sys.stderr)
        return 3

    if not written:
        print("· 没有可回填的条目（没有任何可读的 dom.json）；文件保持原样", file=sys.stderr)
        return 0
    # `0194` / R5 §3.5：真写前先备份；备份失败 ⇒ 不写。
    try:
        backup_path = backup_expect(expect_path, args.backup_dir)
    except OSError as exc:
        print("⛔ 备份目标期望失败，未写文件：%s（%s）" % (expect_path, exc),
              file=sys.stderr)
        return 3
    try:
        write_atomic(expect_path, new_expect)
    except OSError as exc:
        print("⛔ 写期望文件失败：%s（%s）" % (expect_path, exc), file=sys.stderr)
        print("   旧文件已备份：%s" % backup_path, file=sys.stderr)
        return 3
    print("✅ 已回填 %d 条（其中值变化 %d 条）到 %s"
          % (written, len(updated), expect_path), file=sys.stderr)
    print("📦 备份：%s" % backup_path, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
