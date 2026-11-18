#!/usr/bin/env python3
"""rmd 自动化测试框架的统一入口。

设计目标（2026-11-08 用户指令）：
1. 用例**可并行**跑：exec 用例与 JS 测试文件按 `--jobs` 并发；Rust 矩阵在
   `cargo test` 内部按 CPU 起线程。
2. 覆盖**方方面面**：Markdown 语法、解析/渲染、目录、搜索、块表、语言、链接、
   前端纯逻辑、CLI、工具链。用例是数据（JSONL / Node 测试文件），不是一堆散落的脚本。
3. 失败**必须**让退出码非零；条数**必须**实跑统计，不靠估算。

⛔ 硬约束：不启动 GUI、不抢焦点、不合成按键。这里只跑纯逻辑、离屏 CLI 与
   Node 纯逻辑测试。任何需要可见窗口/真实 IME 的项都不属于本框架。

用法：
    python3 tests/auto/runner.py                     # 全量
    python3 tests/auto/runner.py --jobs 8
    python3 tests/auto/runner.py --family md-inline  # 只跑某一族
    python3 tests/auto/runner.py --list              # 只统计，不执行
    python3 tests/auto/runner.py --selftest          # 框架自检（失败必须被抓住）

退出码：0 全绿；1 有用例失败；2 框架/构建错误；3 条数未达 `--min-cases`。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUTO = ROOT / "tests" / "auto"
CASES = AUTO / "cases"
DEFAULT_RUST = CASES / "rust"
DEFAULT_EXEC = CASES / "exec"
DEFAULT_JS = AUTO / "js"
ISOLATED_TARGET = ROOT / "target" / "autotest"
# ⭐ `design/0064` P1：GUI 层的**第四执行器**。用例只描述「跑哪个驱动、要什么结论」，
#    ⛔ 判据仍在各驱动里（`--json` 的 `结论` 计数或退出码映射表），执行器不抄第二份期望。
DEFAULT_GUI = CASES / "gui"
GUI_MANIFEST = AUTO / "gui" / "manifest.json"
GUI_FORMS = ("offscreen", "cargo", "real-gui")
GUI_VERDICTS = ("pass", "fail", "skip", "harness")


def rel(path: Path) -> str:
    """仓库内路径给相对路径，仓外（`--js-dir` / 临时用例）退回绝对路径。

    ⚠️ 直接 `relative_to(ROOT)` 在仓外路径上会抛 ValueError，而 `--selftest`
    与临时目录正是这么用的——那会让报告器自己崩掉。
    """
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


# ——————————————————————————————————————————————————————————————
# 数据加载
# ——————————————————————————————————————————————————————————————


def load_jsonl(path: Path) -> list[dict]:
    out: list[dict] = []
    for line_no, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            case = json.loads(line)
        except json.JSONDecodeError as exc:
            raise HarnessError(f"{path}:{line_no} 不是合法 JSON：{exc}") from exc
        if not isinstance(case, dict):
            raise HarnessError(f"{path}:{line_no} 必须是对象")
        case.setdefault("id", f"{path.stem}-{line_no}")
        # ⚠️ 自检/临时用例在仓库外（%TEMP%）⇒ `relative_to` 会抛；那种情况报绝对路径。
        try:
            case["_file"] = str(path.relative_to(ROOT))
        except ValueError:
            case["_file"] = str(path)
        case["_line"] = line_no
        out.append(case)
    return out


def discover_jsonl(root: Path) -> list[dict]:
    # ⚠️ 允许直接给**单个 .jsonl 文件**（`--selftest` 与临时用例都这么用），
    #    不然 `rglob` 在文件上什么都不返回 ⇒ 必败用例也会"0 条全绿"。
    if root.is_file():
        return load_jsonl(root)
    if not root.exists():
        return []
    out: list[dict] = []
    for path in sorted(root.rglob("*.jsonl")):
        out.extend(load_jsonl(path))
    return out


def discover_js(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(root.rglob("*.test.js"))


class HarnessError(RuntimeError):
    pass


# ——————————————————————————————————————————————————————————————
# exec 用例
# ——————————————————————————————————————————————————————————————


class Context:
    def __init__(self, args: argparse.Namespace, tmp: Path):
        self.args = args
        self.tmp = tmp
        self.rmd = resolve_rmd(args)
        self.node = args.node or shutil.which("node") or "node"
        self.py = sys.executable
        self.root = ROOT


def resolve_rmd(args: argparse.Namespace) -> Path | None:
    if args.rmd:
        path = Path(args.rmd).expanduser().resolve()
        return path if path.exists() else None
    path = ISOLATED_TARGET / "release" / "rmd"
    return path if path.exists() else None


def subst(text: str, ctx: Context, tmp: Path) -> str:
    replacements = {
        "{{ROOT}}": str(ROOT),
        "{{AUTO}}": str(AUTO),
        "{{TMP}}": str(tmp),
        "{{PY}}": ctx.py,
        "{{NODE}}": ctx.node,
        "{{RMD}}": str(ctx.rmd) if ctx.rmd else "{{RMD}}",
    }
    for key, value in replacements.items():
        text = text.replace(key, value)
    return text


def json_subset(got, want, path: str = "$", errs: list[str] | None = None) -> list[str]:
    errs = [] if errs is None else errs
    if isinstance(want, dict):
        if not isinstance(got, dict):
            errs.append(f"{path} 期望对象，实际 {type(got).__name__}")
            return errs
        for key, value in want.items():
            if key not in got:
                errs.append(f"{path}.{key} 缺失")
            else:
                json_subset(got[key], value, f"{path}.{key}", errs)
    elif isinstance(want, list):
        if not isinstance(got, list):
            errs.append(f"{path} 期望数组")
            return errs
        if len(got) != len(want):
            errs.append(f"{path} 长度期望 {len(want)}，实际 {len(got)}")
        for i, value in enumerate(want):
            if i < len(got):
                json_subset(got[i], value, f"{path}[{i}]", errs)
    elif got != want:
        errs.append(f"{path} 期望 {want!r}，实际 {got!r}")
    return errs


def check_text(label: str, text: str, expect: dict) -> list[str]:
    errs: list[str] = []
    for needle in expect.get(f"{label}_contains", []):
        if needle not in text:
            errs.append(f"{label} 缺少 {needle!r}")
    for needle in expect.get(f"{label}_not_contains", []):
        if needle in text:
            errs.append(f"{label} 不应出现 {needle!r}")
    pattern = expect.get(f"{label}_re")
    if pattern is not None and re.search(pattern, text, re.M) is None:
        errs.append(f"{label} 不匹配正则 {pattern!r}")
    if f"{label}_equals" in expect and text != expect[f"{label}_equals"]:
        errs.append(f"{label} 期望 {expect[f'{label}_equals']!r}，实际 {text!r}")
    return errs


def run_exec_case(case: dict, ctx: Context) -> tuple[bool, str, float]:
    started = time.monotonic()
    tmp = Path(tempfile.mkdtemp(prefix="case-", dir=ctx.tmp))
    try:
        for rel, content in (case.get("files") or {}).items():
            path = tmp / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, (dict, list)):
                path.write_text(json.dumps(content, ensure_ascii=False), encoding="utf-8")
            else:
                path.write_text(str(content), encoding="utf-8")

        argv = case.get("argv")
        if not isinstance(argv, list) or not argv:
            return False, "argv 必须是非空数组", time.monotonic() - started
        if any("{{RMD}}" in str(a) for a in argv) and ctx.rmd is None:
            return (
                False,
                "CLI 未构建（target/autotest/release/rmd 不存在）；去掉 --no-build 后重跑",
                time.monotonic() - started,
            )
        cmd = [subst(str(a), ctx, tmp) for a in argv]
        cwd = subst(str(case.get("cwd", "{{TMP}}")), ctx, tmp)
        Path(cwd).mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env.update({str(k): str(v) for k, v in (case.get("env") or {}).items()})
        env.setdefault("NO_COLOR", "1")
        stdin = case.get("stdin", "")
        timeout = float(case.get("timeout_s", 30))
        try:
            proc = subprocess.run(
                cmd,
                input=stdin.encode("utf-8"),
                cwd=cwd,
                env=env,
                capture_output=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return False, f"超时（{timeout}s）：{' '.join(cmd)}", time.monotonic() - started
        except FileNotFoundError as exc:
            return False, f"命令不存在：{exc}", time.monotonic() - started

        stdout = proc.stdout.decode("utf-8", "replace")
        stderr = proc.stderr.decode("utf-8", "replace")
        expect = case.get("expect") or {}
        errs: list[str] = []
        want_exit = expect.get("exit", 0)
        if proc.returncode != want_exit:
            errs.append(f"退出码期望 {want_exit}，实际 {proc.returncode}")
        errs += check_text("stdout", stdout, expect)
        errs += check_text("stderr", stderr, expect)

        if "stdout_json" in expect:
            try:
                errs += json_subset(json.loads(stdout), expect["stdout_json"], "stdout_json")
            except json.JSONDecodeError as exc:
                errs.append(f"stdout 不是 JSON：{exc}")

        for rel in expect.get("files_exist", []):
            if not (tmp / rel).exists():
                errs.append(f"文件不存在：{rel}")
        for rel in expect.get("files_absent", []):
            if (tmp / rel).exists():
                errs.append(f"文件不应存在：{rel}")
        for rel, needles in (expect.get("file_contains") or {}).items():
            path = tmp / rel
            if not path.exists():
                errs.append(f"文件不存在：{rel}")
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            for needle in needles:
                if needle not in text:
                    errs.append(f"{rel} 缺少 {needle!r}")

        if errs:
            detail = "；".join(errs)
            if stdout.strip():
                detail += f"；stdout={stdout.strip()[:300]!r}"
            if stderr.strip():
                detail += f"；stderr={stderr.strip()[:300]!r}"
            return False, detail, time.monotonic() - started
        return True, "", time.monotonic() - started
    except Exception as exc:  # noqa: BLE001 - 用例级异常要变成失败，不能炸整轮
        return False, f"用例异常：{exc}", time.monotonic() - started
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ——————————————————————————————————————————————————————————————
# JS 用例（node --test，TAP 统计）
# ——————————————————————————————————————————————————————————————

TAP_SUMMARY = {
    "tests": re.compile(r"^# tests (\d+)$", re.M),
    "pass": re.compile(r"^# pass (\d+)$", re.M),
    "fail": re.compile(r"^# fail (\d+)$", re.M),
}


def run_js_file(path: Path, ctx: Context) -> tuple[bool, int, int, str, float]:
    started = time.monotonic()
    env = os.environ.copy()
    env["NO_COLOR"] = "1"
    try:
        proc = subprocess.run(
            [ctx.node, "--test", "--test-reporter=tap", str(path)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            timeout=float(ctx.args.js_timeout),
        )
    except subprocess.TimeoutExpired:
        return False, 0, 0, f"超时（{ctx.args.js_timeout}s）", time.monotonic() - started
    out = proc.stdout.decode("utf-8", "replace")
    err = proc.stderr.decode("utf-8", "replace")
    m_tests = TAP_SUMMARY["tests"].search(out)
    m_pass = TAP_SUMMARY["pass"].search(out)
    m_fail = TAP_SUMMARY["fail"].search(out)
    if m_tests and m_pass and m_fail:
        tests, passed, failed = int(m_tests.group(1)), int(m_pass.group(1)), int(m_fail.group(1))
    else:
        # 老版本 node 没有 TAP 汇总行：退回数叶子 ok / not ok。
        ok = len(re.findall(r"^\s*ok \d+", out, re.M))
        not_ok = len(re.findall(r"^\s*not ok \d+", out, re.M))
        tests, passed, failed = ok + not_ok, ok, not_ok
    good = proc.returncode == 0 and failed == 0 and tests > 0
    detail = ""
    if not good:
        names = re.findall(r"^\s*not ok \d+ - (.+)$", out, re.M)
        detail = f"退出码 {proc.returncode}，失败 {failed}/{tests}"
        if names:
            detail += "：" + "；".join(names[:6])
        tail = (out + "\n" + err).strip().splitlines()[-8:]
        if tail:
            detail += "；输出末尾：" + " / ".join(tail)[:500]
    return good, tests, passed, detail, time.monotonic() - started


# ——————————————————————————————————————————————————————————————
# Rust 矩阵（cargo test 内部并行）
# ——————————————————————————————————————————————————————————————


def run_rust(ctx: Context, family: str) -> tuple[bool, int, int, int, str, float]:
    started = time.monotonic()
    env = os.environ.copy()
    env["NO_COLOR"] = "1"
    # ⛔ 绝不能落到 `target/release`：那里可能是 GUI 产物，而"后构建者覆盖"会让
    #    用户拿旧/错形态的二进制复测。矩阵与 CLI 共用 `target/autotest`。
    env["CARGO_TARGET_DIR"] = str(ISOLATED_TARGET)
    if family:
        env["RMD_AUTOTEST_FILTER"] = family
    cmd = [
        ctx.args.cargo,
        "test",
        "--release",
        "--offline",
        "--bin",
        "rmd",
        "autotest::matrix",
        "--",
        "--exact",
        "--nocapture",
        "--test-threads=1",
    ]
    proc = subprocess.run(cmd, cwd=ROOT / "src-tauri", env=env, capture_output=True)
    out = proc.stdout.decode("utf-8", "replace")
    err = proc.stderr.decode("utf-8", "replace")
    summary = re.search(
        r"^AUTOTEST rust total=(\d+) pass=(\d+) fail=(\d+) ms=(\d+)$", out, re.M
    )
    if summary:
        total, passed, failed = (int(summary.group(i)) for i in (1, 2, 3))
        good = failed == 0 and proc.returncode == 0 and total > 0
        detail = ""
        if not good:
            fails = re.findall(r"^CASE fail (.+)$", out, re.M)
            detail = f"退出码 {proc.returncode}，失败 {failed}/{total}"
            if fails:
                detail += "：" + "；".join(fails[:8])
        return good, total, passed, failed, detail, time.monotonic() - started
    detail = f"cargo test 没有产出 AUTOTEST 汇总（退出码 {proc.returncode}）"
    tail = (out + "\n" + err).strip().splitlines()[-12:]
    if tail:
        detail += "；输出末尾：" + " / ".join(tail)[:800]
    return False, 0, 0, 0, detail, time.monotonic() - started


# ——————————————————————————————————————————————————————————————
# 编排
# ——————————————————————————————————————————————————————————————


def ensure_rmd(ctx: Context) -> None:
    if ctx.args.no_build:
        return
    if ctx.rmd is not None:
        return
    print("[autotest] 构建隔离 CLI（target/autotest，不碰 target/release）…", flush=True)
    env = os.environ.copy()
    env["CARGO_TARGET_DIR"] = str(ISOLATED_TARGET)
    proc = subprocess.run(
        [ctx.args.cargo, "build", "--release", "--offline", "--bin", "rmd"],
        cwd=ROOT / "src-tauri",
        env=env,
    )
    if proc.returncode != 0:
        raise HarnessError("隔离 CLI 构建失败（见上方 cargo 输出）")
    ctx.rmd = resolve_rmd(ctx.args)
    if ctx.rmd is None:
        raise HarnessError("构建成功但找不到 target/autotest/release/rmd")


def matches(case: dict, family: str) -> bool:
    if not family:
        return True
    return family in case.get("id", "") or family in case.get("family", "") or family in case["_file"]


# ——————————————————————————————————————————————————————————————
# GUI 用例（`design/0064` P1：只跑既有驱动，判据不在这里）
# ——————————————————————————————————————————————————————————————


def load_gui_manifest(path: Path | None = None) -> dict:
    """读驱动清单。⚠️ 盘上没有或坏了都**不静默放行**：`wired` 缺省视为未接入。"""
    p = path or GUI_MANIFEST
    if not p.exists():
        return {"drivers": {}}
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HarnessError(f"{rel(p)} 不是合法 JSON：{exc}") from exc
    if not isinstance(doc.get("drivers"), dict):
        raise HarnessError(f"{rel(p)} 缺 drivers 对象")
    return doc


def gui_skip_reason(manifest: dict, driver: str, case: dict) -> str | None:
    """返回跳过原因；`None` = 可以跑。⛔ 未接入 ≠ 通过。"""
    info = (manifest.get("drivers") or {}).get(driver)
    if not info:
        return f"驱动 {driver!r} 未登记（manifest.json）"
    if not info.get("wired"):
        return f"驱动 {driver!r} 未接入（{info.get('form', '?')}）"
    if info.get("form") not in GUI_FORMS:
        return f"驱动 {driver!r} 的 form 不合法：{info.get('form')!r}"
    if (case.get("args") or []) and "--json" in (case.get("args") or []) and not info.get("json"):
        return f"驱动 {driver!r} 不支持 --json（⛔ 不猜期望）"
    if not shutil.which("swiftc") and info.get("form") == "offscreen":
        return "没有 swiftc（环境无效，⛔ 不是通过）"
    return None


def gui_verdict(info: dict, code: int) -> str:
    """退出码归一化。⛔ 未登记的码一律记 harness 错——不猜。"""
    table = info.get("exit") or {}
    got = table.get(str(code))
    return got if got in GUI_VERDICTS else "harness"


def gui_counts(doc: dict) -> dict | None:
    """从驱动**自己**的 JSON 里取它自报的检查计数。

    ⚠️ 既有驱动有两种形状：`结论{通过,失败,跳过}`（i18n/link-nav/tree-menu）与
    `判据[{判据, ok}]`（doclist/sidebar-search）。⛔ 执行器只数驱动自己的结论，
    不重写判据、不按 id 猜期望；两种都不认识 ⇒ `None`（驱动违约，⛔ 不是通过）。
    """
    concl = doc.get("结论")
    if isinstance(concl, dict) and any(k in concl for k in ("通过", "失败", "跳过")):
        return {
            "通过": int(concl.get("通过") or 0),
            "失败": int(concl.get("失败") or 0),
            "跳过": int(concl.get("跳过") or 0),
        }
    checks = doc.get("判据")
    if isinstance(checks, list):
        out = {"通过": 0, "失败": 0, "跳过": 0}
        for c in checks:
            if not isinstance(c, dict):
                out["跳过"] += 1  # 认不出的条目记跳过；⛔ 不当通过
            elif c.get("ok") is True:
                out["通过"] += 1
            elif c.get("ok") is False:
                out["失败"] += 1
            else:
                out["跳过"] += 1
        return out
    return None


def gui_env_broken(doc: dict) -> str | None:
    """环境自证（`design/0062` INV-E2E-01 的同一条口径）：抢前台 / 进程被激活 ⇒ 本轮数作废。

    ⚠️ 即使驱动自己的退出码是绿，这两条也不许读成通过——它们是**环境**而不是产品结论。
    ⚠️ 自证的位置不统一：doclist/sidebar-search 在 `环境`，i18n/link-nav/tree-menu 在
    `环境.页面自证`；两处都看。
    """
    env = doc.get("环境") or {}
    proofs = [env]
    if isinstance(env.get("页面自证"), dict):
        proofs.append(env["页面自证"])
    for p in proofs:
        win = p.get("窗口") or {}
        if p.get("前台被抢过") is True:
            return "驱动自证：前台应用被抢过"
        if win.get("进程被激活") is True:
            return "驱动自证：探针进程被激活"
        before, after = p.get("前台应用_起跑前"), p.get("前台应用_收工时")
        if before and after and before != after:
            return f"驱动自证：前台应用从「{before}」变成「{after}」"
    return None


def elapsed_ms(started: float) -> float:
    """`started` 到现在，**毫秒**（⚠️ `time.monotonic()` 的单位是秒，别直接当 ms 用）。"""
    return (time.monotonic() - started) * 1000.0


def run_gui_case(case: dict, ctx: Context, manifest: dict) -> tuple[bool, bool, str, float]:
    """跑一条 GUI 用例。返回 `(ok, skipped, detail, ms)`。

    ⚠️ 期望只看两处：驱动的**退出码**映射（manifest）与它自己的 `--json` 里
    自报的检查计数（`gui_counts`）。⛔ 执行器不重写任何判据文本。
    """
    started = time.monotonic()
    driver = str(case.get("driver") or "")
    skip = gui_skip_reason(manifest, driver, case)
    if skip:
        return True, True, skip, elapsed_ms(started)
    info = manifest["drivers"][driver]
    # ⚠️ 占位符与 exec 那一路同口径（`{{PY}}` / `{{ROOT}}` …），临时用例与自检要用。
    argv = [subst(str(a), ctx, ctx.tmp) for a in (case.get("argv") or [])]
    if not argv:
        return False, False, "argv 必须是非空数组（例：[\"make\", \"probe-i18n\"]）", elapsed_ms(started)
    args = [str(a) for a in (case.get("args") or [])]
    if args:
        argv.append("ARGS=" + " ".join(args))
    timeout = float(case.get("timeout_s", 600))
    env = os.environ.copy()
    env.setdefault("NO_COLOR", "1")
    try:
        proc = subprocess.run(
            argv,
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return False, False, f"超时（{timeout}s）：{' '.join(argv)}", elapsed_ms(started)
    except FileNotFoundError as exc:
        return False, False, f"命令不存在：{exc}", elapsed_ms(started)

    stdout = proc.stdout.decode("utf-8", "replace")
    stderr = proc.stderr.decode("utf-8", "replace")
    verdict = gui_verdict(info, proc.returncode)
    expect = case.get("expect") or {}
    want = expect.get("verdict", "pass")
    errs: list[str] = []
    if verdict != want:
        errs.append(f"退出码 {proc.returncode} ⇒ {verdict}，期望 {want}")

    if info.get("json") and "--json" in args:
        doc = None
        try:
            doc = json.loads(stdout[stdout.index("{"):])
        except (ValueError, json.JSONDecodeError):
            errs.append("stdout 里没有可解析的 JSON（驱动违约）")
        if isinstance(doc, dict):
            broken = gui_env_broken(doc)
            if broken:
                errs.append(broken + "（本轮数作废，⛔ 不读成通过）")
            counts = gui_counts(doc)
            if counts is None:
                errs.append("驱动没给出可识别的结论（既无 结论 也无 判据）")
            else:
                if counts["失败"] != 0:
                    errs.append(f"驱动自报失败 {counts['失败']} 条")
                if "min_checks" in expect and counts["通过"] < int(expect["min_checks"]):
                    errs.append(
                        f"通过检查数 {counts['通过']} < min_checks {expect['min_checks']}"
                    )
                if "max_skipped" in expect and counts["跳过"] > int(expect["max_skipped"]):
                    errs.append(f"跳过检查数 {counts['跳过']} > max_skipped {expect['max_skipped']}")

    if errs:
        detail = "；".join(errs)
        tail = (stderr or stdout).strip().splitlines()[-3:]
        if tail:
            detail += "；" + " / ".join(tail)
        return False, False, detail, elapsed_ms(started)
    return True, verdict == "skip", "", elapsed_ms(started)


def manual_status() -> str:
    """人工验收的第二分母（`design/0064` §2.1 / P4）。

    ⚠️ P4 之前**没有工单池**：这里只如实说「未建单」，⛔ 不拿 0 冒充「已签完」。
    之后有 `docs/reviews/*人工验收*` 记录时，取最近一份的日期。
    """
    reviews = ROOT / "docs" / "reviews"
    found = sorted(reviews.glob("*人工验收*")) if reviews.exists() else []
    if not found:
        return "未建单    最近签字：无"
    latest = found[-1].name[:10]
    return f"{len(found)} 份记录    最近签字：{latest}"


def run(args: argparse.Namespace) -> int:
    started = time.monotonic()
    tmp = Path(tempfile.mkdtemp(prefix="rmd-autotest-"))
    try:
        ctx = Context(args, tmp)
        family = args.family or ""

        rust_cases = discover_jsonl(Path(args.rust_cases) if args.rust_cases else DEFAULT_RUST)
        exec_cases = discover_jsonl(Path(args.exec_cases) if args.exec_cases else DEFAULT_EXEC)
        js_files = discover_js(Path(args.js_dir) if args.js_dir else DEFAULT_JS)
        gui_cases = discover_jsonl(Path(args.gui_cases) if args.gui_cases else DEFAULT_GUI)
        manifest = load_gui_manifest()

        rust_cases = [c for c in rust_cases if matches(c, family)]
        exec_cases = [c for c in exec_cases if matches(c, family)]
        gui_cases = [c for c in gui_cases if matches(c, family)]
        if family:
            js_files = [p for p in js_files if family in rel(p)]

        if args.list:
            print(f"rust 用例 {len(rust_cases)} 条（{DEFAULT_RUST.relative_to(ROOT)}）")
            print(f"exec 用例 {len(exec_cases)} 条（{DEFAULT_EXEC.relative_to(ROOT)}）")
            print(f"JS 测试文件 {len(js_files)} 个（{DEFAULT_JS.relative_to(ROOT)}）")
            drivers = (manifest.get("drivers") or {})
            wired = sum(1 for d in drivers.values() if d.get("wired"))
            print(
                f"GUI 用例 {len(gui_cases)} 条（{DEFAULT_GUI.relative_to(ROOT)}）；"
                f"驱动 {len(drivers)} 个，已接入 {wired} 个，未接入 {len(drivers) - wired} 个"
            )
            return 0

        results = {"rust": None, "exec": [], "js": [], "gui": []}
        failures: list[str] = []
        # ⚠️ 退出码契约里的 2（框架错）必须真的可达：进程崩了/一条用例都没解析出来时，
        #    failed 计数仍是 0，⛔ 不能因此退 0。下面两个分支都要求「不是 ok 且零失败」
        #    记成 harness 错。
        harness_bad = False
        total = passed = failed = 0

        if not args.no_rust and (rust_cases or not family):
            # ⚠️ 过滤族在 Rust 侧没有对应用例时直接跳过：这不是框架错，⛔ 不能因为
            #    「Rust 0 条」就判红（exec/js 族本来就不该有 rust 用例）。
            ok, n, p, f, detail, ms = run_rust(ctx, family)
            results["rust"] = (ok, n, p, f, detail, ms)
            total += n
            passed += p
            failed += f
            if not ok:
                failures.append(f"rust: {detail}")
                if f == 0:
                    harness_bad = True
            print(f"[autotest] rust  {p}/{n} 通过，{f} 失败（{ms:.0f} ms）", flush=True)

        if not args.no_js and js_files:
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
                futures = {pool.submit(run_js_file, path, ctx): path for path in js_files}
                for future in concurrent.futures.as_completed(futures):
                    path = futures[future]
                    ok, n, p, detail, ms = future.result()
                    results["js"].append((path, ok, n, p, detail, ms))
                    total += n
                    passed += p
                    failed += n - p
                    if not ok:
                        failures.append(f"js {rel(path)}: {detail}")
                        # 文件崩溃/解析不出任何叶子时 n-p == 0，同样不能静默算绿。
                        if n == 0:
                            harness_bad = True
            js_tests = sum(r[2] for r in results["js"])
            js_pass = sum(r[3] for r in results["js"])
            print(
                f"[autotest] js    {js_pass}/{js_tests} 通过，{len(js_files)} 个文件",
                flush=True,
            )

        if not args.no_exec and exec_cases:
            ensure_rmd(ctx)
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
                futures = {pool.submit(run_exec_case, case, ctx): case for case in exec_cases}
                for future in concurrent.futures.as_completed(futures):
                    case = futures[future]
                    ok, detail, ms = future.result()
                    results["exec"].append((case, ok, detail, ms))
                    total += 1
                    if ok:
                        passed += 1
                    else:
                        failed += 1
                        failures.append(
                            f"exec {case['id']} ({case['_file']}:{case['_line']}): {detail}"
                        )
            exec_pass = sum(1 for _, ok, _, _ in results["exec"] if ok)
            print(f"[autotest] exec  {exec_pass}/{len(exec_cases)} 通过", flush=True)

        # ⭐ GUI 层（`design/0064` P1）：默认**不跑**（慢且依赖 swiftc/离屏环境），
        #    `--with-gui` 才接上。⚠️ GUI 条数**绝不并进 logic 总数**（§2.1）。
        gui_ran = bool(args.with_gui and gui_cases and not args.no_gui)
        if gui_ran:
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.gui_jobs) as pool:
                futures = {
                    pool.submit(run_gui_case, case, ctx, manifest): case for case in gui_cases
                }
                for future in concurrent.futures.as_completed(futures):
                    case = futures[future]
                    ok, skipped, detail, ms = future.result()
                    results["gui"].append((case, ok, skipped, detail, ms))
                    if not ok:
                        failures.append(
                            f"gui {case['id']} ({case['_file']}:{case['_line']}): {detail}"
                        )
            gui_pass = sum(1 for _, ok, sk, _, _ in results["gui"] if ok and not sk)
            gui_skip = sum(1 for _, ok, sk, _, _ in results["gui"] if ok and sk)
            print(
                f"[autotest] gui   {gui_pass}/{len(gui_cases)} 通过，{gui_skip} 跳过",
                flush=True,
            )

        elapsed = time.monotonic() - started
        # ⚠️ logic 一路都没跑（`--no-rust --no-js --no-exec`，例如 `make test-gui`）时，
        #    「合计：0 条」会被误读成「什么都没跑」⇒ 明说未运行；⛔ GUI 条数不并进这里。
        logic_ran = bool(
            (not args.no_rust and (rust_cases or not family))
            or (not args.no_js and js_files)
            or (not args.no_exec and exec_cases)
        )
        print("\n=== rmd 自动化用例 ===")
        if logic_ran:
            print(f"合计（logic）：{total} 条，通过 {passed}，失败 {failed}，耗时 {elapsed:.1f}s")
        else:
            print(f"合计（logic）：未运行，耗时 {elapsed:.1f}s")
        if results["rust"]:
            ok, n, p, f, detail, ms = results["rust"]
            print(f"  rust  {p}/{n}（{ms:.0f} ms）")
        if exec_cases and not args.no_exec:
            exec_pass = sum(1 for _, ok, _, _ in results["exec"] if ok)
            print(f"  exec  {exec_pass}/{len(exec_cases)}")
        if js_files and not args.no_js:
            js_tests = sum(r[2] for r in results["js"])
            js_pass = sum(r[3] for r in results["js"])
            print(f"  js    {js_pass}/{js_tests}（{len(js_files)} 个文件）")
        # ⭐ 三行分母（`design/0064` §2.1）：logic / gui / manual **永远分开**，
        #    ⛔ 不把 GUI 条数并进 logic 总数。
        if gui_ran:
            gui_pass = sum(1 for _, ok, sk, _, _ in results["gui"] if ok and not sk)
            gui_skip = sum(1 for _, ok, sk, _, _ in results["gui"] if ok and sk)
            print(f"  gui   {gui_pass}/{len(gui_cases)} 通过，{gui_skip} 跳过")
        else:
            print(f"  gui   未运行（{len(gui_cases)} 条用例；加 --with-gui 才跑）")
        print(f"  manual  {manual_status()}")

        if failures:
            print("\n--- 失败明细 ---")
            for item in failures:
                print(f"- {item}")

        report = {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "elapsed_s": round(elapsed, 2),
            "jobs": args.jobs,
            "family": family,
            "total": total,
            "passed": passed,
            "failed": failed,
            "counts": {
                "rust": None if results["rust"] is None else results["rust"][1],
                # ⚠️ 记**真跑了多少条**（`--no-exec` 时是 0），⛔ 不记"目录里有多少条"——
                #    否则 `make test-gui` 的报告会写 exec 1260，看上去像跑了 1260 条。
                "exec": len(results["exec"]),
                "js_tests": sum(r[2] for r in results["js"]),
                "js_files": len(js_files),
                # ⚠️ GUI 是**独立分母**（design/0064 §2.1），⛔ 不并进 total。
                "gui": {
                    "cases": len(gui_cases),
                    "ran": gui_ran,
                    "pass": sum(1 for _, ok, sk, _, _ in results["gui"] if ok and not sk),
                    "skip": sum(1 for _, ok, sk, _, _ in results["gui"] if ok and sk),
                    "fail": sum(1 for _, ok, _, _, _ in results["gui"] if not ok),
                    # 首次实跑的量级（design/0064 §7.3 的 `est_s`）从这里取。
                    "明细": [
                        {
                            "id": c["id"],
                            "ok": ok,
                            "skipped": sk,
                            "ms": round(ms),
                            "detail": detail,
                        }
                        for c, ok, sk, detail, ms in results["gui"]
                    ],
                },
                "manual": manual_status(),
            },
            "failures": failures,
        }
        if args.json:
            out = Path(args.json)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"\n报告：{out}")

        gui_failed = sum(1 for _, ok, _, _, _ in results["gui"] if not ok)
        if failed or gui_failed:
            return 1
        # 有「非 ok 但零失败」的执行路径（进程崩了、零用例文件）⇒ 框架错，退 2。
        if harness_bad:
            return 2
        # ⚠️ `--exec-cases` 是**临时用例目录/文件**时才跳过条数门槛（自检就这么跑）；
        #    默认全量跑（不传该参数）必须执行 `--min-cases`，否则门槛等于不存在。
        if args.min_cases and not family and not args.no_rust and not args.no_js and not args.exec_cases:
            if total < args.min_cases:
                print(
                    f"\n⛔ 用例总数 {total} < --min-cases {args.min_cases}",
                    file=sys.stderr,
                )
                return 3
        # ⚠️ GUI 门槛**只约束 GUI 自己的分母**，且只在真跑了的时候生效：
        #    未运行时它等于零信息，⛔ 不能把「没跑」算成「条数不足」。
        if args.min_gui and gui_ran:
            gui_pass = sum(1 for _, ok, sk, _, _ in results["gui"] if ok and not sk)
            if gui_pass < args.min_gui:
                print(
                    f"\n⛔ GUI 通过条数 {gui_pass} < --min-gui {args.min_gui}",
                    file=sys.stderr,
                )
                return 3
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def selftest() -> int:
    """框架自检：一条必过、一条必败，退出码必须分别是 0 与 1。

    ⭐ 另含 `design/0064` P1 那半：GUI 执行器的三种「红」都必须真的传到退出码
    （驱动自报失败 / 环境自证被抢 / 认不出结论），负对照保持绿。
    """
    tmp = Path(tempfile.mkdtemp(prefix="rmd-autotest-self-"))
    ok_case = {
        "id": "self-pass",
        "argv": ["{{PY}}", "-c", "print('hello')"],
        "expect": {"exit": 0, "stdout_contains": ["hello"]},
    }
    bad_case = {
        "id": "self-fail",
        "argv": ["{{PY}}", "-c", "print('hello')"],
        "expect": {"exit": 0, "stdout_contains": ["not-there"]},
    }
    ok_file = tmp / "ok.jsonl"
    bad_file = tmp / "bad.jsonl"
    ok_file.write_text(json.dumps(ok_case) + "\n", encoding="utf-8")
    bad_file.write_text(json.dumps(bad_case) + "\n", encoding="utf-8")
    base = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--no-rust",
        "--no-js",
        "--no-build",
        "--exec-cases",
    ]
    r1 = subprocess.run(base + [str(ok_file)], capture_output=True)
    r2 = subprocess.run(base + [str(bad_file)], capture_output=True)

    def gui_case(name: str, doc: dict, expect_extra: dict | None = None) -> Path:
        case = {
            "id": name,
            "driver": "i18n",  # 已登记、json=true、退出码 0 ⇒ pass
            "argv": ["{{PY}}", "-c", "import json; print(json.dumps(%r, ensure_ascii=False))" % (doc,)],
            "args": ["--json"],
            "expect": {"verdict": "pass", **(expect_extra or {})},
        }
        p = tmp / f"{name}.jsonl"
        p.write_text(json.dumps(case, ensure_ascii=False) + "\n", encoding="utf-8")
        return p

    gui_base = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--no-rust",
        "--no-js",
        "--no-exec",
        "--with-gui",
        "--gui-jobs",
        "1",
    ]
    g_ok = gui_case("gui-self-pass", {"结论": {"通过": 14, "失败": 0, "跳过": 0}})
    g_fail = gui_case("gui-self-fail", {"结论": {"通过": 13, "失败": 1, "跳过": 0}})
    g_env = gui_case("gui-self-env", {"结论": {"通过": 14, "失败": 0, "跳过": 0},
                                      "环境": {"页面自证": {"前台被抢过": True}}})
    g_judge = gui_case("gui-self-judge", {"判据": [{"判据": "A", "ok": True}, {"判据": "B", "ok": True}]},
                       {"min_checks": 2})
    g_runs = {p: subprocess.run(gui_base + ["--gui-cases", str(p)], capture_output=True)
              for p in (g_ok, g_fail, g_env, g_judge)}
    shutil.rmtree(tmp, ignore_errors=True)

    problems = []
    if r1.returncode != 0:
        problems.append("必过用例没有退 0")
    if r2.returncode != 1:
        problems.append("必败用例没有退 1（失败没有传到退出码）")
    if g_runs[g_ok].returncode != 0:
        problems.append("GUI 负对照（全绿）没有退 0")
    if g_runs[g_fail].returncode != 1:
        problems.append("GUI 驱动自报失败没有退 1")
    if g_runs[g_env].returncode != 1:
        problems.append("GUI 环境自证被抢没有退 1")
    if g_runs[g_judge].returncode != 0:
        problems.append("GUI `判据[]` 形状的绿没有被认（执行器违约）")
    if problems:
        print("SELFTEST 失败：" + "；".join(problems), file=sys.stderr)
        for p, r in (("ok", r1), ("bad", r2)):
            print(f"· {p}：\n{r.stdout.decode()}\n{r.stderr.decode()}", file=sys.stderr)
        for p, r in g_runs.items():
            print(f"· {p.name}：exit={r.returncode}\n{r.stdout.decode()}\n{r.stderr.decode()}",
                  file=sys.stderr)
        return 2
    print("SELFTEST ok：必过退 0，必败退 1；GUI 三种红都传到退出码")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="rmd 自动化测试框架")
    parser.add_argument("--jobs", type=int, default=min(32, (os.cpu_count() or 4)))
    parser.add_argument("--family", default="", help="按 family/id/路径子串过滤")
    parser.add_argument("--list", action="store_true", help="只统计用例数")
    parser.add_argument("--json", default="", help="写 JSON 报告")
    parser.add_argument("--min-cases", type=int, default=0)
    parser.add_argument("--no-rust", action="store_true")
    parser.add_argument("--no-js", action="store_true")
    parser.add_argument("--no-exec", action="store_true")
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument(
        "--with-gui",
        action="store_true",
        help="跑 GUI 层用例（design/0064 P1；慢、要 swiftc，默认不跑）",
    )
    parser.add_argument("--no-gui", action="store_true", help="即使传了 --with-gui 也不跑")
    parser.add_argument("--min-gui", type=int, default=0, help="GUI 通过条数门槛（只约束 GUI 分母）")
    parser.add_argument("--gui-jobs", type=int, default=2, help="GUI 用例并发（离屏探针吃 CPU）")
    parser.add_argument("--gui-cases", default="", help="临时 GUI 用例目录/文件")
    parser.add_argument("--rmd", default="", help="指定 CLI 路径（默认 target/autotest/release/rmd）")
    parser.add_argument("--cargo", default=shutil.which("cargo") or "cargo")
    parser.add_argument("--node", default="")
    parser.add_argument("--rust-cases", default="")
    parser.add_argument("--exec-cases", default="")
    parser.add_argument("--js-dir", default="")
    parser.add_argument("--js-timeout", type=float, default=120)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return selftest()
    try:
        return run(args)
    except HarnessError as exc:
        print(f"⛔ 框架错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
