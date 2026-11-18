#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""L2 环境闸门（`design/0063` §7.0 / §7.2 / §7.4）。

只做**可自动化**的前置检查；⛔ 不代替 §4.3 那种人在可见窗口里做的 preflight，
⛔ 不启动 / 激活任何 app，⛔ 不发合成事件，⛔ 不访问前端。

两个子命令
==========

`gates`（默认）
    读 `.work/<fixture>/measured.json`、`.work/<fixture>/snapshot.json`、
    `fixtures-expect.json` 与可选的 `baseline.json`，逐条判定：

      P-ENV-01  图像非空；PNG 宽 == DPR × W_canvas；行带数 > 0；主/备两路带数差 ≤1；
                主/备两路行带几何逐条比对（容差 ±1 px，口径待设计批准，0191）
      P-ENV-02  仅基线页（`00-body.md`）：F0/01 与 F0/03 各有 ≥3 条连续正文行带，
                帧内行距变异系数 ≤1%。
                ⛔ 本条**不判**「可见行数 == 某值」——该口径已被设计撤销（D1/E1）；
                全文唯一做「== 预期显示行」相等判定的是 P-ENV-06（DOM 行盒数）。
      P-ENV-03  环境表三字段齐全；与基线差 ≤1 pt
      P-ENV-04  前台应用前后未变；isActive=False；isKeyWindow=False；窗口不可见
      P-ENV-05  夹具 sha256 与 fixtures-expect.json 一致；当轮 blocks 种类序列 == 期望
      P-ENV-06  DOM 行盒数 == fixtures-expect.json 的 dom_line_boxes；
                不等时按 E2 做判因分叉（三字段一致 ⇒ 产品排版变更）

`compare`
    读同一批输入，按四族比较：
      -SPEC   同端合规（只读测量阶段给出的 `spec_checks`，⛔ 不拿 rmd 自己的 CSS 当期望）
      -PARITY 跨端对照（⛔ 只许用 L1 实测基线；必须 provenance + fixture_sha256；
               L2-OCR 另须 review 三项齐全；没有基线 ⇒ `skipped(no-baseline)`）
      -REG    仅登记（⛔ 不进 pass/fail）
      -L3     人工目视（⛔ 拒绝自动判绿，输入声称 pass 也不采信）

退出码（让调用者能区分「环境无效」与「产品不一致」）
====================================================
  0   PASS                     全部闸门与已执行的判据通过
  2   ERROR                    参数 / 缺必需输入 / JSON 损坏
  10  PRODUCT-MISMATCH         环境有效，-SPEC 或 -PARITY 红
  15  PRODUCT-TYPOGRAPHY-CHANGE  P-ENV-06 判因分叉：三字段一致而 DOM 行盒数变
  20  ENVIRONMENT-INVALID      任一 P-ENV 红（或 P-COV-04 provenance 不完整）
  30  INCOMPLETE               有闸门/判据被跳过（含 no-baseline、基线过期、期望未冻结）

⚠️ `-I` 运行：`python3 -I tools/visual-parity/preflight.py ...`，避免从 cwd 载入同名模块。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import struct
import sys
import time

# ── 退出码 ───────────────────────────────────────────────────────────────
EXIT_PASS = 0
EXIT_ERROR = 2
EXIT_PRODUCT = 10
EXIT_PRODUCT_CHANGE = 15
EXIT_ENV_INVALID = 20
EXIT_INCOMPLETE = 30

# 0230：`--gates-json` 的外部产物必须能自证是哪一轮、哪份夹具、什么结论。
GATES_IDS = ("P-ENV-01", "P-ENV-02", "P-ENV-03", "P-ENV-04", "P-ENV-05", "P-ENV-06")
GATE_STATUSES = {"pass", "fail", "product-change", "skipped", "n/a"}
GATES_OVERALL_EXIT = {
    "pass": EXIT_PASS,
    "environment-invalid": EXIT_ENV_INVALID,
    "product-typography-change": EXIT_PRODUCT_CHANGE,
    "incomplete": EXIT_INCOMPLETE,
}

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WORK = os.path.join(HERE, ".work")
DEFAULT_EXPECT = os.path.join(HERE, "fixtures-expect.json")
DEFAULT_BASELINE = os.path.join(HERE, "baseline.json")
DEFAULT_FIXTURES = os.path.join(HERE, "fixtures")
DEFAULT_COVERAGE = os.path.join(HERE, "coverage.json")

#: `design/0063` §7.2 / §2.8 固定画布宽（point）。⭐ 期望值只能来自这里，
#: ⛔ 不取当轮 `measured.env.canvas_w`（`0141`：那等于让被测对象自己出题）。
W_CANVAS_PT = 1000.0
#: `design/0063` §2.6 / §7.2 固定画布高（point）。
H_CANVAS_PT = 801.0
#: 基线页夹具（P-ENV-02 只对它生效）。
BASELINE_PAGE = "00-body"
#: P-ENV-03 三字段的比较容差（pt / px）。
ENV_TOLERANCE = 1.0
#: P-ENV-02 帧内行距变异系数上限。
SPACING_CV_MAX = 0.01
#: 0191：主/备两路行带几何逐条比较的坐标容差（px）。
#: 设计 §2.2 写「行带序列逐条一致」，§7.0 只写「带数差 ≤1」，两处都没给坐标容差。
#: 实测 1 px 差来自两路取像的半像素采样相位（`l2-snapshot.swift` 主路
#: `takeSnapshot` vs 备路 `cacheDisplay`），故取 1 px；**该口径待设计批准**，
#: 见 `.agent/l2-fix2-C.md`。⛔ 不许调用方用参数覆盖（0164 的教训：
#: 容差不能由被检方/调用方挑）。
BACKUP_GEOMETRY_TOLERANCE_PX = 1
#: §2.3 T2：跨端比值默认 ±5%。
PARITY_RATIO_TOL = 0.05
#: §2.3 T4：颜色 ΔE2000 默认上限（面积 ≥3×3）。
COLOR_DE_MAX = 3.0
#: §2.3 T4：1 px 线可用 ≤8。具体哪条判据用 8 由 `coverage.json` 的「容差」列决定
#: （`color_limit_for`），⛔ 不靠基线行里没有生产者的 `line_1px` 幻影字段（`0159`）。
COLOR_DE_MAX_LINE = 8.0
#: 0229：alpha 分量的允许差（1/255，即一个量化级）。设计尚未给 alpha 口径
#: （`bugs/0229` 标「待设计批准」），这里只保证「alpha 不同不得判绿」。
COLOR_ALPHA_MAX_DIFF = 1.0 / 255.0
#: 0188：单位缺失/未知时的容差哨兵。⛔ 不默认回退 T2 ±5%（那会把未声明单位
#: 当比值判绿）；调用方据此记 `register_only(unknown-unit)`。
TOLERANCE_UNIT_UNVERIFIED = "unit-unverified"

#: 0164：M4 容差来源。`bands.py` 发 `geometry:1px_line` / `geometry:area_ge_3x3` /
#: `explicit`；契约申请写作 `geometry-line` / `geometry-area` / `de-tol`。
#: 两套拼写都认，语义一一对应，⛔ 不新增第三种取值。
TOLERANCE_SRC_LINE = ("geometry-line", "geometry:1px_line", "geometry_line", "1px_line")
TOLERANCE_SRC_AREA = ("geometry-area", "geometry:area_ge_3x3", "geometry_area",
                      "area_ge_3x3")
TOLERANCE_SRC_EXPLICIT = ("de-tol", "de_tol", "explicit", "explicit-de-tol")
#: 容差来源存在但无法落成数值时，compare 记 skipped（⛔ 不猜一个限值判绿）。
TOLERANCE_SRC_MISSING = ("missing-de-tol-value", "unknown-tolerance-source")

#: `design/0063` §2.2 / §2.9：`-PARITY` 基线行允许的采集层。
COLLECTION_LAYERS = ("L1→L2", "L1->L2", "L2-OCR")

#: §2.9 / P-COV-04：基线行必须带的字段。
PROV_FIELDS = ("frame_sha256", "window_id", "captured_at")
REVIEW_FIELDS = ("reviewer", "frame_sha256", "signed_at")

STATUS_LABEL = {
    "pass": "PASS",
    "fail": "FAIL",
    "skipped": "SKIP",
    "n/a": "N/A",
    "product-change": "PRODUCT-CHANGE",
    "register_only": "REGISTER-ONLY",
    "invalid": "INVALID",
}


class PreflightError(Exception):
    """参数 / 输入错误 ⇒ 退出码 2，⛔ 不混进环境红或产品红。"""


# ── 通用小工具 ───────────────────────────────────────────────────────────

_NUM_RE = re.compile(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")


def as_number(value):
    """把 14 / "14px" / "1.6" / "50%" 之类转成 float；转不了返回 None。

    ⚠️ "50%" 返回 50.0（百分号本身不在这里归一），需要比例语义的调用方自己除 100。
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        m = _NUM_RE.search(value)
        if m:
            try:
                return float(m.group(0))
            except ValueError:
                return None
    return None


def first_of(obj, paths, default=None):
    """按点分路径依次取值，返回第一个存在且非 None 的值。"""
    for path in paths:
        cur = obj
        ok = True
        for part in path.split("."):
            if isinstance(cur, dict) and part in cur and cur[part] is not None:
                cur = cur[part]
            else:
                ok = False
                break
        if ok:
            return cur
    return default


def load_json(path, *, required=False):
    """读 JSON；required 时缺失/损坏抛 PreflightError。"""
    if not path or not os.path.isfile(path):
        if required:
            raise PreflightError(f"缺必需输入：{path}")
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        raise PreflightError(f"读取 JSON 失败：{path}（{exc}）") from exc


def load_optional_json(path):
    """读可选 JSON：不存在返回 (None, "文件不存在")；损坏仍是错误。"""
    if not path or not os.path.isfile(path):
        return None, "文件不存在"
    return load_json(path), None


def sha256_file(path):
    if not path or not os.path.isfile(path):
        return None
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    except OSError:
        return None
    return h.hexdigest()


def png_size(path):
    """只读 PNG 头（IHDR）拿宽高；不是 PNG 返回 None。"""
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "rb") as f:
            head = f.read(24)
    except OSError:
        return None
    if len(head) >= 24 and head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
        return struct.unpack(">II", head[16:24])
    return None


def fmt_num(value):
    if value is None:
        return "?"
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return f"{value:.4g}"
    return str(value)


def cv_of(values):
    """变异系数（总体标准差 / 均值）。少于 2 个样本按 0 处理。"""
    vals = [v for v in values if v is not None]
    if len(vals) < 2:
        return 0.0
    mean = sum(vals) / len(vals)
    if mean == 0:
        return 0.0
    var = sum((v - mean) ** 2 for v in vals) / len(vals)
    return math.sqrt(var) / abs(mean)


def normalize_cv(value):
    """把 CV 归一成**小数比值**这一唯一单位。

    0237：旧实现按 `n > 1.0` 决定是否除以 100，导致同一函数里 0.8（按小数
    是 80%）与 1.5（按百分数是 1.5%）语义相反。现在只认两种写法：

      - 带 `%` 的字符串（`"0.8%"`）⇒ 百分数；
      - 裸数值（`0.008` / `0.8` / `1.5`）⇒ 小数比值（0.8 = 80%）。

    于是 `0.008` 与 `"0.8%"` 都得到 0.008，且 1.0 附近连续。
    唯一单位口径待设计批准（`bugs/0237`）。
    """
    n = as_number(value)
    if n is None:
        return None
    if isinstance(value, str) and "%" in value:
        return n / 100.0
    return n


def canonical_fixture(name):
    """夹具名归一：去目录、去 .md、只允许安全字符。

    0239：显式拒绝 `.`、`..` 和任何以 `.` 开头的名字。旧正则
    `[0-9A-Za-z._-]+` 让 `.` / `..` 通过，`resolve_fixture_dir` 会拼出
    work 之外的路径。是否改成「已知夹具白名单」待设计批准。
    """
    base = os.path.basename(str(name)).strip()
    if base.endswith(".md"):
        base = base[:-3]
    if not base or base in (".", "..") or base.startswith("."):
        raise PreflightError(f"非法夹具名：{name!r}（不允许点号开头的路径分量）")
    if not re.fullmatch(r"[0-9A-Za-z._-]+", base):
        raise PreflightError(f"非法夹具名：{name!r}")
    return base


def fixture_keys(canonical):
    return [canonical + ".md", canonical]


def resolve_fixture_dir(work, canonical):
    for cand in (canonical, canonical + ".md"):
        path = os.path.join(work, cand)
        if os.path.isdir(path):
            return path
    return os.path.join(work, canonical)


def fixture_md_path(fixtures_dir, canonical):
    return os.path.join(fixtures_dir, canonical + ".md")


def new_check(name, status, detail, **data):
    item = {"name": name, "status": status, "detail": detail}
    if data:
        item["data"] = data
    return item


def aggregate(checks):
    """把子项聚合成闸门状态。

    优先级：fail > product-change > skipped > pass > n/a。
    """
    statuses = [c.get("status") for c in checks]
    if "fail" in statuses:
        return "fail"
    if "product-change" in statuses:
        return "product-change"
    concrete = [s for s in statuses if s not in ("n/a", None)]
    if not concrete:
        return "n/a"
    if "skipped" in concrete:
        return "skipped"
    return "pass"


def status_text(status, reason=None):
    """人类可读状态；skipped 带上原因，例如 skipped(no-baseline)。"""
    if status == "skipped" and reason:
        return f"skipped({reason})"
    if status == "product-change":
        return "PRODUCT-TYPOGRAPHY-CHANGE"
    return STATUS_LABEL.get(status, str(status).upper())


# ── 输入装载 ─────────────────────────────────────────────────────────────


def load_measured(fixture_dir):
    path = os.path.join(fixture_dir, "measured.json")
    data = load_json(path, required=True)
    if not isinstance(data, dict):
        raise PreflightError(f"measured.json 顶层不是对象：{path}")
    return data, path


def load_snapshot(fixture_dir):
    path = os.path.join(fixture_dir, "snapshot.json")
    data, reason = load_optional_json(path)
    if data is not None and not isinstance(data, dict):
        raise PreflightError(f"snapshot.json 顶层不是对象：{path}")
    return data, reason, path


def resolve_png_path(measured, fixture_dir, canonical):
    """PNG 路径：先按夹具目录，再按仓根，最后按 measured.json 所在目录。"""
    raw = first_of(measured, ["png", "png_path", "image", "snapshot.png"])
    if not isinstance(raw, str) or not raw:
        return None
    if os.path.isabs(raw):
        return raw
    candidates = [
        os.path.join(fixture_dir, raw),
        os.path.join(os.path.dirname(fixture_dir), raw),
        os.path.join(HERE, raw),
        os.path.join(os.path.dirname(HERE), raw),
    ]
    for cand in candidates:
        if os.path.isfile(cand):
            return cand
    # 返回第一个候选，让上层报“文件不存在”而不是“没有路径”。
    return candidates[0]


def _size_from(raw):
    """把 `[w,h]` / `{"width","height"}` / `{"w","h"}` 归一成整数对；读不出返回 None。"""
    if isinstance(raw, (list, tuple)) and len(raw) >= 2:
        w, h = as_number(raw[0]), as_number(raw[1])
    elif isinstance(raw, dict):
        w = as_number(first_of(raw, ["width", "w", "px_w"]))
        h = as_number(first_of(raw, ["height", "h", "px_h"]))
    else:
        return None
    if w is not None and h is not None:
        return int(w), int(h)
    return None


def declared_png_size(measured, snapshot=None):
    """`measured` 的 PNG 尺寸声明。

    0128：`l2-snapshot` 已发 `snapshot.png_size`（`[w,h]`）与 `png_px`，
    旧实现只读 `measured`。别名优先级：**现有键 > snapshot 新键**；
    snapshot 没有新键时行为与旧版完全一致（⛔ 不因缺新键变红）。
    """
    raw = first_of(measured, ["png_size", "image_size", "size", "snapshot.png_size",
                              "png_px", "image_px"])
    size = _size_from(raw)
    if size is not None:
        return size
    w = as_number(first_of(measured, ["png_width", "image_width"]))
    h = as_number(first_of(measured, ["png_height", "image_height"]))
    if w is not None and h is not None:
        return int(w), int(h)
    # 新键只作兜底；`snapshot.primary.size` 是文件落盘后的复核值，不在此列
    # （否则等于用被测对象的结果证明同一件事）。
    if isinstance(snapshot, dict):
        return _size_from(first_of(snapshot, ["png_size", "png_px", "env.png_size",
                                             "env.png_px"]))
    return None


def dpr_of(measured, snapshot):
    """DPR：0128 的别名字段也认（`px_per_pt`、`expected_dpr`、`backing_scale`）。

    `l2-snapshot.swift` 把 DPR 写成 `{"px_per_pt": "2.00", ...}`，旧实现只认裸数字。
    """
    for src in (measured.get("env"), measured, snapshot, (snapshot or {}).get("env")):
        if not isinstance(src, dict):
            continue
        raw = first_of(src, ["dpr", "device_pixel_ratio", "scale", "backing_scale",
                             "px_per_pt", "expected_dpr", "screen_backing_scale"])
        if isinstance(raw, dict):
            raw = first_of(raw, ["px_per_pt", "expected_dpr", "value", "scale",
                                 "screen", "match"])
        val = as_number(raw)
        if val is not None and val > 0:
            return val
    return None


def canvas_size_of(measured, snapshot=None):
    """当轮实测的画布尺寸（pt）及其来源。

    ⚠️ 只用于「实测画布是否等于设计常量」这一项核对，⛔ 不作为期望值：
    期望值固定取 `W_CANVAS_PT`/`H_CANVAS_PT`（`0141`：期望值不能由被测对象提供）。
    0128：`l2-snapshot` 已发 `snapshot.canvas_pt={"w","h"}`；别名优先级为
    **existing（env/measured）> snapshot**，且只在既有来源缺该分量时补位。
    """
    env = measured.get("env") if isinstance(measured.get("env"), dict) else {}
    w = as_number(first_of(env, ["canvas_w", "w_canvas", "canvas_width", "canvas.width"]))
    h = as_number(first_of(env, ["canvas_h", "h_canvas", "canvas_height", "canvas.height"]))
    source = "env"
    if w is None or h is None:
        canvas = first_of(measured, ["canvas", "canvas_pt", "canvas_size", "canvas_px"])
        if isinstance(canvas, (list, tuple)) and canvas:
            w = as_number(canvas[0]) if w is None else w
            h = as_number(canvas[1]) if h is None and len(canvas) > 1 else h
            source = "measured.canvas"
        elif isinstance(canvas, dict):
            w = as_number(first_of(canvas, ["width", "w", "pt_w"])) if w is None else w
            h = as_number(first_of(canvas, ["height", "h", "pt_h"])) if h is None else h
            source = "measured.canvas"
        elif canvas is not None and w is None:
            w = as_number(canvas)
            source = "measured.canvas_pt"
    if (w is None or h is None) and isinstance(snapshot, dict):
        snap_canvas = first_of(snapshot, ["canvas_pt", "canvas", "env.canvas_pt"])
        if isinstance(snap_canvas, (list, tuple)) and snap_canvas:
            snap_w = as_number(snap_canvas[0])
            snap_h = as_number(snap_canvas[1]) if len(snap_canvas) > 1 else None
        elif isinstance(snap_canvas, dict):
            snap_w = as_number(first_of(snap_canvas, ["w", "width", "pt_w"]))
            snap_h = as_number(first_of(snap_canvas, ["h", "height", "pt_h"]))
        else:
            snap_w = snap_h = None
        if snap_w is not None or snap_h is not None:
            filled = w is None or h is None
            if w is None:
                w = snap_w
            if h is None:
                h = snap_h
            if filled:
                source = "snapshot.canvas_pt"
    return w, h, source


def canvas_width_of(measured):
    """兼容旧调用：只取宽度；缺值时回落到设计常量。"""
    w, _, source = canvas_size_of(measured)
    if w is not None:
        return w, source
    return W_CANVAS_PT, "design-default(1000 pt)"


def bands_of(measured):
    bands = measured.get("bands")
    return bands if isinstance(bands, dict) else {}


def band_count_of(bands):
    for key in ("count", "band_count", "n", "line_bands", "bands_count"):
        val = bands.get(key)
        if isinstance(val, list):
            return len(val)
        num = as_number(val)
        if num is not None:
            return int(num)
    items = bands.get("items") or bands.get("bands")
    if isinstance(items, list):
        return len(items)
    return None


def primary_backup_counts(measured, snapshot):
    """拿主/备两路的带数，来源按优先级合并。

    0231：旧实现让自报 `count_diff` 压过由 primary/backup 重算的差
    （primary=5 / backup=9 / diff=0 仍取 0）。现在：
      - 两边计数都有 ⇒ **computed diff 优先**，自报值只做交叉核对；
      - 自报值与重算值矛盾 ⇒ `diff_conflict`，由 gate_01 判红；
      - 缺计数时才采信自报值，并标 `diff_unverified`。
    """
    sources = []
    bands = bands_of(measured)
    if bands:
        sources.append(("bands", bands))
    sources.append(("measured", measured))
    if isinstance(snapshot, dict):
        sources.append(("snapshot", snapshot))

    primary = backup = reported_diff = None
    primary_from = backup_from = diff_from = None
    for label, obj in sources:
        if primary is None:
            val = as_number(first_of(obj, [
                "primary_count", "primary.count", "primary.n", "primary_bands",
                "counts.primary",
            ]))
            if val is not None:
                primary, primary_from = int(val), label
        if backup is None:
            val = as_number(first_of(obj, [
                "backup_count", "backup.count", "backup.n", "backup_bands",
                "counts.backup",
            ]))
            if val is not None:
                backup, backup_from = int(val), label
        if reported_diff is None:
            val = as_number(first_of(obj, [
                "primary_backup_count_diff", "count_diff", "backup_diff",
                "paths.count_diff",
            ]))
            if val is not None:
                reported_diff, diff_from = abs(int(val)), label

    # 主路径缺计数时用 bands 带数兜底（同一份 measured.json 里）。
    if primary is None:
        primary = band_count_of(bands)
        if primary is not None:
            primary_from = "bands.count"

    consistent = None
    if isinstance(snapshot, dict):
        raw = first_of(snapshot, [
            "two_paths_consistent", "paths_consistent", "paths.consistent",
            "primary_backup_consistent",
        ])
        if isinstance(raw, bool):
            consistent = raw

    computed_diff = None
    diff_conflict = None
    diff_unverified = False
    if primary is not None and backup is not None:
        computed_diff = abs(primary - backup)
        if reported_diff is not None and reported_diff != computed_diff:
            diff_conflict = {
                "reported": reported_diff,
                "computed": computed_diff,
                "reported_from": diff_from,
            }
        diff = computed_diff
        diff_from = "computed"
    else:
        # 缺一路计数 ⇒ 自报差无法交叉核对，只能原样登记（不据此判绿）。
        diff = reported_diff
        diff_unverified = reported_diff is not None
    return {
        "primary": primary,
        "backup": backup,
        "diff": diff,
        "computed_diff": computed_diff,
        "reported_diff": reported_diff,
        "diff_conflict": diff_conflict,
        "diff_unverified": diff_unverified,
        "primary_from": primary_from,
        "backup_from": backup_from,
        "diff_from": diff_from,
        "consistent": consistent,
    }


def load_roi(fixture_dir, measured):
    """读当轮 ROI 描述：优先 `roi.json`，其次 `measured.roi`。

    0165：ROI 的纵向必须是 `.doc` 内容盒；`l2-run.sh` 写 `source` 取
    `content_box` / `viewport` / `roi-fallback:viewport`。消费侧不猜「描述性文字
    看起来像内容盒」——只认契约值，其它一律按不可信处理。
    """
    roi, _ = load_optional_json(os.path.join(fixture_dir, "roi.json"))
    if isinstance(roi, dict):
        return roi
    embedded = measured.get("roi")
    return embedded if isinstance(embedded, dict) else {}


def _bands_sequence(obj):
    """从 `bands.json` 形态里取行带列表；取不到返回 `None`。"""
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        for key in ("bands", "rows", "items"):
            seq = obj.get(key)
            if isinstance(seq, list):
                return seq
    return None


def primary_backup_geometry(fixture_dir, measured):
    """0191：主/备两路行带几何逐条比对（top/bottom/left/right）。

    主路取 `measured.bands.items`（缺则 `bands.json`），备路取 `bands-backup.json`
    —— 后者是 `bands.py` 对 `frame-backup.png` 的实测输出（`l2-run.sh:plan_bands`）。

    ⛔ 缺任一路几何、或带数不等时**不猜**逐条对应关系，返回 `reason` 让闸门记
    `skipped`；⛔ 不拿「带数相等」冒充「逐条一致」（这正是 0191 的缺陷）。
    """
    bands = bands_of(measured)
    primary = _bands_sequence(bands.get("items"))
    primary_src = "measured.bands.items" if primary is not None else None
    if primary is None:
        primary, _ = load_optional_json(os.path.join(fixture_dir, "bands.json"))
        primary = _bands_sequence(primary)
        primary_src = "bands.json" if primary is not None else None

    backup_raw, backup_reason = load_optional_json(
        os.path.join(fixture_dir, "bands-backup.json"))
    backup = _bands_sequence(backup_raw)
    backup_src = "bands-backup.json" if backup is not None else None

    result = {
        "tolerance_px": BACKUP_GEOMETRY_TOLERANCE_PX,
        "tolerance_status": "待设计批准（§2.2「逐条一致」未给坐标容差）",
        "primary_source": primary_src,
        "backup_source": backup_src,
        "backup_reason": backup_reason,
        "n_primary": len(primary) if primary is not None else None,
        "n_backup": len(backup) if backup is not None else None,
        "max_abs_diff": None,
        "n_diff_bands": None,
        "diffs": [],
        "reason": None,
    }
    if primary is None:
        result["reason"] = "no-primary-bands"
        return result
    if backup is None:
        result["reason"] = "no-backup-bands"
        return result
    if len(primary) != len(backup):
        result["reason"] = "band-count-mismatch"
        return result

    fields = ("top", "bottom", "left", "right")
    max_abs = 0
    diff_bands = set()
    diffs = []
    incomplete = False
    for idx, (pa, pb) in enumerate(zip(primary, backup)):
        if not isinstance(pa, dict) or not isinstance(pb, dict):
            incomplete = True
            continue
        for field in fields:
            va, vb = as_number(pa.get(field)), as_number(pb.get(field))
            if va is None or vb is None:
                incomplete = True
                continue
            delta = abs(va - vb)
            max_abs = max(max_abs, delta)
            if delta > 0:
                diff_bands.add(idx)
                if len(diffs) < 12:
                    diffs.append({
                        "index": idx, "field": field,
                        "primary": va, "backup": vb, "abs_diff": delta,
                    })
    if incomplete:
        result["reason"] = "incomplete-band-geometry"
    result["max_abs_diff"] = max_abs
    result["n_diff_bands"] = len(diff_bands)
    result["diffs"] = diffs
    return result


def roi_source_of(roi):
    src = first_of(roi, ["source"]) if isinstance(roi, dict) else None
    return src.strip() if isinstance(src, str) and src.strip() else None


def roi_is_content_box(roi):
    return roi_source_of(roi) == "content_box"


def roi_related_warnings(roi, bands):
    """收集 ROI 相关告警（`bands.warnings[]` 里 `code=roi-*` 或含 ROI 的字符串）。

    `bands.py` 当前把 0165 告警作为人类可读字符串发出，结构化字段在
    `warning_details`；两种形态都收，避免换形态时告警再次被静默丢弃。
    """
    out = []
    sources = (
        ("bands.warnings", bands.get("warnings") if isinstance(bands, dict) else None),
        ("bands.warning_details",
         bands.get("warning_details") if isinstance(bands, dict) else None),
        ("roi.warnings", roi.get("warnings") if isinstance(roi, dict) else None),
    )
    for label, seq in sources:
        if not isinstance(seq, list):
            continue
        for item in seq:
            if isinstance(item, dict):
                code = str(item.get("code") or "")
                if code.lower().startswith("roi-"):
                    out.append({**item, "source": label})
            elif isinstance(item, str) and ("roi-" in item.lower() or "ROI " in item
                                            or "ROI越界" in item):
                out.append({"code": "roi-warning", "detail": item, "source": label})
    return out


def roi_unsupported_detail(roi):
    """ROI 不可信时的统一说明；缺失与显式非 content_box 都点名契约值。"""
    src = roi_source_of(roi)
    if src is None:
        return ("roi.json 未提供 source ⇒ 无法证明 ROI 是 `.doc` 内容盒（契约值 "
                "content_box）；该判据 unsupported(reason=roi-not-content-box)")
    return (f"ROI source={src!r} ≠ content_box ⇒ 带/行距类判据 unsupported"
            "(reason=roi-not-content-box)")


def env_of(measured, snapshot):
    """合并 measured.env 与 snapshot.env 的环境字段。

    0238：旧实现让 `snapshot.env` 先到先得，而 `dpr_of` 是 measured 优先，
    同一环境事实有两个权威源。现在统一为 **measured 当轮权威、snapshot 只补缺**，
    两源冲突另由 `env_source_conflicts` 显式报红。
    """
    merged = {}
    for src in (measured.get("env"), measured,
                (snapshot or {}).get("env"), snapshot):
        if isinstance(src, dict):
            for key, value in src.items():
                merged.setdefault(key, value)
    return merged


def env_fields(env):
    """归一环境表字段。

    0192：旧实现只保留四项，`font_family` / `-webkit-font-smoothing` 被丢弃 ⇒
    字体面变化在环境闸门里完全不可见。现在原样保留（字符串），由 gate_03
    显式记录并在有基线时比较。
    """
    env = env if isinstance(env, dict) else {}
    family = first_of(env, [
        "font_family", "fontFamily", "font_family_declared", "reader_font_family",
        "--reader-font-sans", "font_sans",
    ])
    smoothing = first_of(env, [
        "font_smoothing", "webkit_font_smoothing", "-webkit-font-smoothing",
        "WebkitFontSmoothing", "font_smooth",
    ])
    return {
        "content_width_px": as_number(first_of(env, [
            "content_width_px", "content_column_px", "content_width", "doc_content_width_px",
            "content_box_width_px",
        ])),
        "font_size": as_number(first_of(env, [
            "font_size", "reader_font_size", "fontSize", "font_size_px",
        ])),
        "line_height": as_number(first_of(env, [
            "line_height", "computed_line_height", "lineHeight", "line_height_px",
        ])),
        # 0130：`design/0063` 环境表含 sidebar_width，旧实现从未读它。
        "sidebar_width": as_number(first_of(env, [
            "sidebar_width", "sidebar_px", "sidebar.width", "sidebar_width_px",
        ])),
        # 0192：字体面与平滑值保留为字符串（声明列表，非解析后的字体面）。
        "font_family": family.strip() if isinstance(family, str) and family.strip() else None,
        "font_smoothing": (smoothing.strip()
                           if isinstance(smoothing, str) and smoothing.strip() else None),
    }


#: 0238：两源一致性核对覆盖的数值字段。
ENV_NUMERIC_FIELDS = ("content_width_px", "font_size", "line_height", "sidebar_width")
#: 0238/0192：两源一致性核对覆盖的文本字段（字体面/平滑）。
ENV_TEXT_FIELDS = ("font_family", "font_smoothing")


def _norm_env_text(value):
    return " ".join(str(value).split()) if value is not None else None


def env_source_pair(measured, snapshot):
    """分别取 measured 与 snapshot 一侧的环境字段（不互相补缺）。"""
    measured_fields = env_fields(env_of(measured or {}, None))
    snapshot_fields = (env_fields(env_of({}, snapshot))
                       if isinstance(snapshot, dict) else {})
    return measured_fields, snapshot_fields


def env_source_conflicts(measured, snapshot):
    """0238：measured 与 snapshot 描述同一环境却不一致时列出冲突。

    返回 `(conflicts, compared)`；`compared` 是两源都提供、真正参与核对的字段数。
    `compared == 0` 表示没有可交叉核对的证据（调用方记 skipped，⛔ 不记绿）。
    """
    measured_fields, snapshot_fields = env_source_pair(measured, snapshot)
    conflicts = []
    compared = 0
    for key in ENV_NUMERIC_FIELDS:
        left, right = measured_fields.get(key), snapshot_fields.get(key)
        if left is None or right is None:
            continue
        compared += 1
        if abs(left - right) > 1e-6:
            conflicts.append({"field": key, "measured": left, "snapshot": right})
    for key in ENV_TEXT_FIELDS:
        left, right = measured_fields.get(key), snapshot_fields.get(key)
        if left is None or right is None:
            continue
        compared += 1
        if _norm_env_text(left) != _norm_env_text(right):
            conflicts.append({"field": key, "measured": left, "snapshot": right})
    measured_dpr = dpr_of(measured, None)
    snapshot_dpr = dpr_of({}, snapshot) if isinstance(snapshot, dict) else None
    if measured_dpr is not None and snapshot_dpr is not None:
        compared += 1
        if abs(measured_dpr - snapshot_dpr) > 1e-9:
            conflicts.append({"field": "dpr", "measured": measured_dpr,
                              "snapshot": snapshot_dpr})
    return conflicts, compared


def dom_line_boxes(measured):
    dom = measured.get("dom")
    if isinstance(dom, dict):
        for key in ("line_boxes", "dom_line_boxes", "count", "n", "lines"):
            val = dom.get(key)
            if isinstance(val, list):
                return len(val)
            # 0128：真实产物可能是 `{"line_boxes": {"count": 14}}` 的嵌套形态。
            if isinstance(val, dict):
                nested = as_number(first_of(val, ["count", "n", "length", "total"]))
                if nested is not None:
                    return int(nested)
            num = as_number(val)
            if num is not None:
                return int(num)
    num = as_number(first_of(measured, ["dom_line_boxes", "line_boxes"]))
    if num is not None:
        return int(num)
    if isinstance(dom, (int, float)) and not isinstance(dom, bool):
        return int(dom)
    return None


# ── fixtures-expect.json / baseline.json 读取 ────────────────────────────


def expect_entry(expect, canonical):
    """在 fixtures-expect.json 里按 `00-body.md` / `00-body` 两种键找条目。"""
    if not isinstance(expect, dict):
        return None
    containers = [expect]
    for key in ("fixtures", "expect", "entries"):
        if isinstance(expect.get(key), dict):
            containers.append(expect[key])
    for container in containers:
        for key in fixture_keys(canonical):
            if key in container:
                return container[key]
        # 也允许列表形态：[{fixture: "00-body.md", ...}]
        raw = container.get("items") if isinstance(container, dict) else None
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, dict) and item.get("fixture") in fixture_keys(canonical):
                    return item
    return None


def expect_sha(entry):
    if not isinstance(entry, dict):
        return None
    val = first_of(entry, ["sha256", "fixture_sha256", "sha"])
    return val if isinstance(val, str) and val else None


def expect_blocks(entry):
    if not isinstance(entry, dict):
        return None
    for key in ("blocks_kind", "blocks.kind", "blocks", "kinds"):
        val = first_of(entry, [key])
        if isinstance(val, list):
            return val
    return None


def expect_dom_boxes(entry):
    if not isinstance(entry, dict):
        return None
    for key in ("dom_line_boxes", "dom.line_boxes", "dom_line_box_count"):
        val = first_of(entry, [key])
        if val is None:
            continue
        num = as_number(val)
        if num is not None:
            return int(num)
        return None  # 显式 null：首版未冻结
    return None


def _doc_key(name):
    base = os.path.basename(str(name or "")).strip()
    for suffix in (".md", ".html", ".htm"):
        if base.endswith(suffix):
            base = base[:-len(suffix)]
    return base or "*"


def _sha_map(value):
    """把 docs 指纹的多种形状归一成 `{文档名: sha256}`。

    - 字符串：整体一个指纹（键 `*`）；
    - `{name: sha}` / `{name: {html_sha256, …}}`；
    - `[{name/fixture/path, html_sha256/sha256}, …]`。
    """
    out = {}
    if isinstance(value, str):
        if value.strip():
            out["*"] = value.strip()
        return out
    if isinstance(value, dict):
        for name, item in value.items():
            if isinstance(item, str):
                out[_doc_key(name)] = item
            elif isinstance(item, dict):
                sha = first_of(item, ["html_sha256", "sha256", "html_sha", "docs_sha256"])
                if isinstance(sha, str) and sha:
                    out[_doc_key(name)] = sha
        return out
    if isinstance(value, list):
        for item in value:
            if not isinstance(item, dict):
                continue
            sha = first_of(item, ["html_sha256", "sha256", "html_sha", "docs_sha256"])
            if not isinstance(sha, str) or not sha:
                continue
            name = first_of(item, ["name", "fixture", "path", "id"])
            out[_doc_key(name)] = sha
    return out


def _current_docs_shas(measured):
    """当轮载荷的文档 HTML 指纹；`docs[]` 优先于全局 `provenance.docs_sha256`。"""
    docs = _sha_map(measured.get("docs"))
    if docs:
        return docs, "measured.docs[].html_sha256"
    for path in ("provenance.docs_sha256", "page_attestation.provenance.docs_sha256",
                 "page_attestation.provenance.fixtures_payload.docs_sha256",
                 "fixtures_payload.docs_sha256", "docs_sha256"):
        val = first_of(measured, [path])
        shas = _sha_map(val)
        if shas:
            return shas, f"measured.{path}"
    return {}, None


def _frozen_docs_shas(expect, entry):
    """冻结指纹只从 `fixtures-expect.json` 读；⛔ 不拿当轮 measured 自证。"""
    for container in (entry, expect):
        if not isinstance(container, dict):
            continue
        for path in ("html_sha256", "docs_sha256", "provenance.docs_sha256",
                     "provenance.fixtures_payload.docs_sha256"):
            val = first_of(container, [path])
            shas = _sha_map(val)
            if shas:
                return shas, f"fixtures-expect.json:{path}"
    return {}, None


def docs_fingerprint_check(measured, expect, entry, canonical):
    """0154：`docs[].html_sha256` / `provenance.docs_sha256` 与冻结值一致。

    冻结值缺失 ⇒ `skipped`（⛔ 不静默 pass）；两边都有但不等 ⇒ `fail`。
    """
    current, current_src = _current_docs_shas(measured)
    frozen, frozen_src = _frozen_docs_shas(expect, entry)
    if not frozen:
        return new_check(
            "载荷 docs 指纹", "skipped",
            "fixtures-expect.json 没有 docs_sha256/html_sha256 冻结值 ⇒ 无法校验载荷 HTML 版本"
            "（⛔ 不当作通过；需在期望文件冻结）",
            reason="no-frozen-docs-sha", current=current or None,
        )
    if not current:
        return new_check(
            "载荷 docs 指纹", "skipped",
            f"当轮 measured 没有 docs[].html_sha256 / provenance.docs_sha256（冻结值来源 "
            f"{frozen_src}）⇒ 无法校验（⛔ 不当作通过）",
            reason="no-current-docs-sha", expected=frozen, expected_source=frozen_src,
        )
    wanted = frozen.get(_doc_key(canonical))
    if wanted is None:
        wanted = frozen.get("*")
        key = "*" if wanted is not None else _doc_key(canonical)
    else:
        key = _doc_key(canonical)
    actual = current.get(key)
    if actual is None:
        actual = current.get("*")
        actual_src = current_src if actual is not None else None
    else:
        actual_src = current_src
    if wanted is None:
        return new_check(
            "载荷 docs 指纹", "skipped",
            f"冻结值里没有夹具 {canonical} 的指纹（{frozen_src}）⇒ 该文档未冻结",
            reason="no-frozen-docs-sha", expected=frozen, expected_source=frozen_src,
        )
    if actual is None:
        return new_check(
            "载荷 docs 指纹", "skipped",
            f"当轮指纹里没有夹具 {canonical} 对应项（来源 {current_src}）⇒ 无法比较",
            reason="no-current-docs-sha", expected=wanted, expected_source=frozen_src,
        )
    if actual == wanted:
        return new_check(
            "载荷 docs 指纹", "pass",
            f"{wanted[:12]}… 一致（冻结 {frozen_src} / 当轮 {actual_src}）",
            expected=wanted, actual=actual,
            expected_source=frozen_src, actual_source=actual_src,
        )
    return new_check(
        "载荷 docs 指纹", "fail",
        f"载荷 HTML 已变：冻结 {wanted[:12]}…（{frozen_src}）≠ 当轮 {actual[:12]}…"
        f"（{actual_src}）⇒ 渲染来源与冻结载荷不一致",
        expected=wanted, actual=actual,
        expected_source=frozen_src, actual_source=actual_src,
    )


def normalize_block_kinds(value, table=None):
    """把多种 blocks 形状归一成种类名列表。

    - ["Paragraph", ...]
    - [{"kind": "Paragraph"}, ...]
    - [[0, 1, 2, 0], ...] ＋ 同份 doc 的 `block_kinds` 表
    """
    if isinstance(value, dict):
        for key in ("kind", "kinds", "blocks_kind", "types"):
            if isinstance(value.get(key), list):
                return normalize_block_kinds(value[key], table or value.get("block_kinds"))
        return None
    if not isinstance(value, list):
        return None
    out = []
    for item in value:
        if isinstance(item, str):
            out.append(item)
        elif isinstance(item, dict):
            kind = first_of(item, ["kind", "name", "type"])
            out.append(kind if isinstance(kind, str) else str(kind))
        elif isinstance(item, (list, tuple)) and item:
            idx = item[0]
            if isinstance(idx, str):
                out.append(idx)
            elif isinstance(idx, int) and isinstance(table, list) and 0 <= idx < len(table):
                out.append(str(table[idx]))
            else:
                out.append(str(idx))
        else:
            out.append(str(item))
    return out


def _kinds_from_container(container, table=None):
    if not isinstance(container, dict):
        return None, None
    for key in ("blocks_kind", "blocks", "kinds"):
        kinds = normalize_block_kinds(container.get(key),
                                      table or container.get("block_kinds"))
        if kinds:
            return kinds, key
    return None, None


def _disk_block_kinds(fixture_dir, work, canonical):
    """0189：磁盘/导出产物里的块种类序列（不是 measured.json 自报）。"""
    for name in ("blocks.json", "export.json", "payload.json"):
        path = os.path.join(fixture_dir, name)
        data, _ = load_optional_json(path)
        kinds, key = _kinds_from_container(data)
        if kinds:
            return kinds, f"{name}:{key}"
    # export-fixtures.sh 的汇总载荷：.work/fixtures.json
    payload, _ = load_optional_json(os.path.join(work, "fixtures.json"))
    if isinstance(payload, dict):
        for doc in payload.get("docs") or []:
            if not isinstance(doc, dict):
                continue
            try:
                name = canonical_fixture(str(doc.get("name")))
            except PreflightError:
                continue
            if name != canonical:
                continue
            kinds, key = _kinds_from_container(doc)
            if kinds:
                return kinds, f".work/fixtures.json:docs[{canonical}].{key}"
    return None, None


def _measured_block_kinds(measured):
    """measured.json 自报的块种类序列（只作交叉核对，0189）。"""
    return _kinds_from_container(measured)


def current_block_kinds(measured, fixture_dir, work, canonical):
    """当轮导出的 blocks.kind 序列；返回 `(kinds, source, meta)`。

    0189：旧实现先读 `measured.json`，磁盘/导出产物只是后备 ⇒ 被检对象可以
    自报一份与磁盘不同的种类序列。现在**磁盘产物优先**，measured 自报只做
    交叉核对；两者不一致时 `meta["conflict"]=True`，由 P-ENV-05 判红。
    只有 measured 自报、没有磁盘产物时 `meta["unverified"]=True`（仍可用，
    但不是「已核对」）。
    """
    disk_kinds, disk_src = _disk_block_kinds(fixture_dir, work, canonical)
    self_kinds, self_src = _measured_block_kinds(measured)
    meta = {
        "self_reported": self_kinds,
        "self_reported_source": self_src,
        "disk_source": disk_src,
        "conflict": None,
        "unverified": False,
    }
    if disk_kinds is not None:
        meta["conflict"] = (self_kinds is not None
                            and list(disk_kinds) != list(self_kinds))
        return disk_kinds, disk_src, meta
    if self_kinds is not None:
        meta["unverified"] = True
        return self_kinds, self_src, meta
    return None, None, meta


def baseline_rows_flat(baseline):
    """把 baseline.json 的多种形状摊平成 row 列表，保留顶层 B / environment。"""
    rows = []

    def push(value):
        if isinstance(value, dict) and ("id" in value or "value" in value):
            rows.append(value)
        elif isinstance(value, list):
            for item in value:
                push(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                if key in ("rows", "criteria", "items", "entries", "parity"):
                    push(item)
                elif isinstance(item, dict):
                    merged = dict(item)
                    merged.setdefault("id", key)
                    rows.append(merged)

    if isinstance(baseline, list):
        push(baseline)
    elif isinstance(baseline, dict):
        handled = False
        for key in ("rows", "criteria", "items", "entries", "parity"):
            if key in baseline:
                push(baseline.get(key))
                handled = True
        if isinstance(baseline.get("fixtures"), dict):
            for value in baseline["fixtures"].values():
                push(value)
            handled = True
        if not handled:
            push({k: v for k, v in baseline.items()
                  if k not in ("B", "environment", "env", "meta", "generated_at", "version")})
    return rows


def row_fixture_canonical(row):
    raw = row.get("fixture") if isinstance(row, dict) else None
    if isinstance(raw, str) and raw:
        try:
            return canonical_fixture(raw)
        except PreflightError:
            return None
    return None


def row_scope_is_global(row):
    """0232：缺 `fixture` 的行只有在显式声明 `scope: all` 时才算全局行。"""
    if not isinstance(row, dict):
        return False
    scope = first_of(row, ["scope", "fixture_scope", "applies_to"])
    return isinstance(scope, str) and scope.strip().lower() in (
        "all", "global", "*", "every", "any")


def baseline_env_candidates(baseline, canonical):
    """0236/0228：从 baseline 取**全部**环境表候选，返回 `[(来源, env), …]`。

    旧实现 `baseline_env` 先 `if not isinstance(baseline, dict): return None`
    （数组形 baseline 被判无环境，0236），又只 `return candidates[0]`
    （多行 14/16 取第一条，结论随行序翻转，0228）。这里：
      - dict / list 两种形状都摊平；
      - 顶层 `environment`/`env`、`meta.environment`、行级 `environment`/`env`
        全部计入，由 gate_03 检查彼此是否一致；
      - 只取本夹具的行（`rows_for_fixture` 已排除未声明 scope 的无 fixture 行）。
    """
    out = []
    if isinstance(baseline, dict):
        for key in ("environment", "env"):
            if isinstance(baseline.get(key), dict):
                out.append((f"top.{key}", baseline[key]))
        meta = baseline.get("meta")
        if isinstance(meta, dict):
            for key in ("environment", "env"):
                if isinstance(meta.get(key), dict):
                    out.append((f"meta.{key}", meta[key]))
    if isinstance(baseline, (dict, list)):
        for row in rows_for_fixture(baseline, canonical) or []:
            rid = row_id(row) or "?"
            for key in ("environment", "env"):
                if isinstance(row.get(key), dict):
                    out.append((f"row:{rid}.{key}", row[key]))
    return out


def baseline_env(baseline, canonical):
    """兼容入口：返回第一个环境表候选；判一致性请用 `baseline_env_candidates`。"""
    candidates = baseline_env_candidates(baseline, canonical)
    return candidates[0][1] if candidates else None


def baseline_window_ids(baseline, canonical):
    """0161/0236：从 dict/list 两种 baseline 收集窗口 ID。

    设计 §2.9 把 `window_id` 放在每条基线行的 `provenance` 里，旧实现只读
    基线顶层 ⇒ N4 在 L1 侧永远缺判据。这里同时读顶层、行内与 `provenance`。
    """
    ids = []

    def push(value):
        if value is None:
            return
        text = str(value).strip()
        if text and text not in ids:
            ids.append(text)

    if isinstance(baseline, dict):
        push(first_of(baseline, ["window_id", "window.id"]))
    if isinstance(baseline, (dict, list)):
        for row in rows_for_fixture(baseline, canonical) or []:
            push(first_of(row, ["window_id", "window.id"]))
            push(first_of(row, ["provenance.window_id", "provenance.window",
                                "provenance.windowid"]))
    return ids


# ── P-ENV-01 ─────────────────────────────────────────────────────────────


def gate_01(measured, snapshot, fixture_dir, canonical, roi=None):
    checks = []

    png_path = resolve_png_path(measured, fixture_dir, canonical)
    actual_size = None
    if not png_path:
        checks.append(new_check("图像非空", "fail", "measured.json 没有 png 路径"))
    elif not os.path.isfile(png_path):
        checks.append(new_check("图像非空", "fail", f"PNG 不存在：{png_path}"))
    else:
        size_bytes = os.path.getsize(png_path)
        actual_size = png_size(png_path)
        if size_bytes <= 0:
            checks.append(new_check("图像非空", "fail", f"PNG 为空文件：{png_path}"))
        elif actual_size is None:
            checks.append(new_check("图像非空", "fail", f"文件不是可解析的 PNG：{png_path}"))
        else:
            checks.append(new_check(
                "图像非空", "pass",
                f"{os.path.basename(png_path)} {size_bytes} B，{actual_size[0]}×{actual_size[1]} px",
                bytes=size_bytes, size=list(actual_size),
            ))

    declared = declared_png_size(measured, snapshot)
    width = height = None
    if declared and actual_size:
        if declared != actual_size:
            checks.append(new_check(
                "PNG 尺寸自洽", "fail",
                f"measured.png_size={declared[0]}×{declared[1]} 与文件 IHDR "
                f"{actual_size[0]}×{actual_size[1]} 不一致",
            ))
        else:
            checks.append(new_check(
                "PNG 尺寸自洽", "pass",
                f"measured.png_size 与文件 IHDR 一致（{declared[0]}×{declared[1]}）",
            ))
        width, height = declared
    elif actual_size:
        width, height = actual_size
    elif declared:
        width, height = declared

    dpr = dpr_of(measured, snapshot)
    canvas_w, canvas_h, canvas_src = canvas_size_of(measured, snapshot)
    # 0141：先核对「实测画布 == 设计常量」，再拿**设计常量**做期望值。
    # 旧实现把 measured.env.canvas_w 既当期望又当实测 ⇒ 自我证明。
    if canvas_w is None and canvas_h is None:
        checks.append(new_check(
            "画布尺寸", "skipped",
            "measured 未记录 canvas_w/canvas_h，snapshot 也未提供 canvas_pt="
            "{w,h} ⇒ 无法核对是否等于设计常量 "
            f"{fmt_num(W_CANVAS_PT)}×{fmt_num(H_CANVAS_PT)} pt（⛔ 不当作通过）",
        ))
    else:
        bad = []
        if canvas_w is None:
            bad.append("缺 canvas_w")
        elif abs(canvas_w - W_CANVAS_PT) > 1e-6:
            bad.append(f"canvas_w={fmt_num(canvas_w)} ≠ 设计 {fmt_num(W_CANVAS_PT)} pt")
        if canvas_h is None:
            bad.append("缺 canvas_h")
        elif abs(canvas_h - H_CANVAS_PT) > 1e-6:
            bad.append(f"canvas_h={fmt_num(canvas_h)} ≠ 设计 {fmt_num(H_CANVAS_PT)} pt")
        if bad:
            checks.append(new_check(
                "画布尺寸", "fail",
                "；".join(bad) + f"（来源：{canvas_src}；设计 §2.8/§7.2 固定 "
                f"{fmt_num(W_CANVAS_PT)}×{fmt_num(H_CANVAS_PT)} pt）",
                canvas_w=canvas_w, canvas_h=canvas_h,
            ))
        else:
            checks.append(new_check(
                "画布尺寸", "pass",
                f"canvas {fmt_num(canvas_w)}×{fmt_num(canvas_h)} pt == 设计常量"
                f"（来源：{canvas_src}）",
                canvas_w=canvas_w, canvas_h=canvas_h,
            ))

    if width is None:
        checks.append(new_check("宽度断言", "fail", "拿不到 PNG 宽度"))
    elif dpr is None:
        checks.append(new_check("宽度断言", "fail", "缺 DPR（⛔ 不用 2.0 顶替）"))
    else:
        # 期望宽度只由设计常量与 DPR 推出（0141）。
        expected_w = int(round(dpr * W_CANVAS_PT))
        detail = (f"PNG 宽 {width} px == DPR {fmt_num(dpr)} × W_canvas "
                  f"{fmt_num(W_CANVAS_PT)} pt = {expected_w} px（W_canvas 取设计常量）")
        if width == expected_w:
            checks.append(new_check("宽度断言", "pass", detail,
                                    width=width, expected=expected_w, dpr=dpr))
        else:
            hint = ""
            if width == int(round(W_CANVAS_PT)):
                hint = "；⚠️ 宽 == W_canvas ⇒ 疑似 N7：把 point 当像素、漏掉 DPR 因子"
            checks.append(new_check("宽度断言", "fail", detail + hint,
                                    width=width, expected=expected_w, dpr=dpr))

    if height is None:
        checks.append(new_check("高度断言", "fail", "拿不到 PNG 高度"))
    elif dpr is None:
        checks.append(new_check("高度断言", "fail", "缺 DPR（⛔ 不用 2.0 顶替）"))
    else:
        expected_h = int(round(dpr * H_CANVAS_PT))
        detail = (f"PNG 高 {height} px == DPR {fmt_num(dpr)} × H_canvas "
                  f"{fmt_num(H_CANVAS_PT)} pt = {expected_h} px（H_canvas 取设计常量）")
        if height == expected_h:
            checks.append(new_check("高度断言", "pass", detail,
                                    height=height, expected=expected_h, dpr=dpr))
        else:
            checks.append(new_check("高度断言", "fail", detail,
                                    height=height, expected=expected_h, dpr=dpr))

    bands = bands_of(measured)
    # 0165：带数/主备差都直接来自像素 ROI。ROI 不是 `.doc` 内容盒时，
    # 「带数 > 0」会被画布上方的界面文字顶成假绿，因此这两项不判、显式 unsupported。
    roi_ok = roi_is_content_box(roi)
    roi_warnings = roi_related_warnings(roi, bands)
    count = band_count_of(bands)
    if not roi_ok:
        checks.append(new_check(
            "行带数", "skipped", roi_unsupported_detail(roi),
            reason="roi-not-content-box", roi_source=roi_source_of(roi),
            roi_warnings=roi_warnings, count=count,
        ))
    elif count is None:
        checks.append(new_check("行带数", "fail", "measured.json 缺 bands 计数"))
    elif count <= 0:
        checks.append(new_check("行带数", "fail", f"行带数 {count} ≤ 0（空图不得假绿）", count=count))
    else:
        checks.append(new_check("行带数", "pass", f"行带数 {count} > 0", count=count))

    paths = primary_backup_counts(measured, snapshot)
    if not roi_ok:
        checks.append(new_check(
            "主/备两路带数差", "skipped", roi_unsupported_detail(roi),
            reason="roi-not-content-box", roi_source=roi_source_of(roi),
            roi_warnings=roi_warnings,
            primary=paths["primary"], backup=paths["backup"],
        ))
    elif paths["diff_conflict"]:
        # 0231：自报差与重算差不一致 ⇒ 数据自相矛盾，不得按任一方判绿。
        conflict = paths["diff_conflict"]
        checks.append(new_check(
            "主/备两路带数差", "fail",
            f"主 {paths['primary']} / 备 {paths['backup']} ⇒ 重算差 "
            f"{conflict['computed']}，但自报差 {conflict['reported']}"
            f"（来源 {conflict['reported_from'] or '未知'}）不一致 ⇒ 数据自相矛盾",
            primary=paths["primary"], backup=paths["backup"],
            diff=conflict["computed"], reported_diff=conflict["reported"],
            conflict=True,
        ))
    elif paths["consistent"] is False:
        # 0231：一致性自报为假时，即使重算差 ≤1 也不能被掩盖。
        checks.append(new_check(
            "主/备两路带数差", "fail",
            f"snapshot.two_paths_consistent=false（主 {paths['primary']} / "
            f"备 {paths['backup']} ⇒ 差 {paths['diff']}）⇒ 两路自报不一致",
            primary=paths["primary"], backup=paths["backup"], diff=paths["diff"],
            consistent=False,
        ))
    elif paths["diff"] is not None:
        status = "pass" if paths["diff"] <= 1 else "fail"
        unverified = "（⚠️ 缺一路计数，自报差无法交叉核对）" if paths["diff_unverified"] else ""
        checks.append(new_check(
            "主/备两路带数差", status,
            f"主 {paths['primary']} / 备 {paths['backup']} ⇒ 差 {paths['diff']}（要求 ≤1）"
            f"{unverified}",
            primary=paths["primary"], backup=paths["backup"], diff=paths["diff"],
            diff_source=paths["diff_from"], diff_unverified=paths["diff_unverified"],
        ))
    elif paths["consistent"] is not None:
        status = "pass" if paths["consistent"] else "fail"
        checks.append(new_check(
            "主/备两路带数差", status,
            f"snapshot.two_paths_consistent={paths['consistent']}",
        ))
    else:
        checks.append(new_check(
            "主/备两路带数差", "skipped",
            "未记录备份路径带数或两路一致性 ⇒ 无法完成 §7.2 的 sanity（⛔ 不当作通过）",
        ))

    # 0191：带数相等 ≠ 序列逐条一致（实测 4 份夹具的主/备 top/bottom/right 差
    # 1 px）。设计 §2.2 要求「行带序列逐条一致」，这里按坐标逐条比对；
    # 容差见 BACKUP_GEOMETRY_TOLERANCE_PX（待设计批准）。
    geom = primary_backup_geometry(fixture_dir, measured)
    snapshot_source = first_of(snapshot, [
        "snap_source", "snapshot_source", "snap.source",
    ]) if isinstance(snapshot, dict) else None
    geom_data = {
        "snapshot_source": snapshot_source,
        "tolerance_px": geom["tolerance_px"],
        "tolerance_status": geom["tolerance_status"],
        "primary_source": geom["primary_source"],
        "backup_source": geom["backup_source"],
        "n_primary": geom["n_primary"],
        "n_backup": geom["n_backup"],
        "max_abs_diff": geom["max_abs_diff"],
        "n_diff_bands": geom["n_diff_bands"],
        "diffs": geom["diffs"],
    }
    snap_src_text = f"snap_source={snapshot_source or '未记录'}"
    if not roi_ok:
        checks.append(new_check(
            "主/备两路逐条几何", "skipped", roi_unsupported_detail(roi),
            reason="roi-not-content-box", roi_source=roi_source_of(roi),
            roi_warnings=roi_warnings, **geom_data,
        ))
    elif isinstance(snapshot_source, str) and snapshot_source.strip().lower() not in (
            "", "primary"):
        # 主路径降级到备路时，「主路几何」本身就是备路读数，逐条比对失去意义；
        # 但降级事实必须可见（0191 §8 第 2 条），⛔ 不静默按一致处理。
        checks.append(new_check(
            "主/备两路逐条几何", "skipped",
            f"本轮取像已降级到备路（{snap_src_text}）⇒ 主路几何不是主路径读数，"
            "无法证明主/备一致（⛔ 不当作通过）",
            reason="snapshot-from-backup", **geom_data,
        ))
    elif geom["reason"] == "no-backup-bands":
        checks.append(new_check(
            "主/备两路逐条几何", "skipped",
            "缺 bands-backup.json（备路行带几何未产出）⇒ 无法逐条比对，"
            "⛔ 不用「带数相等」冒充一致（0191）",
            reason="no-backup-bands", **geom_data,
        ))
    elif geom["reason"] == "no-primary-bands":
        checks.append(new_check(
            "主/备两路逐条几何", "skipped",
            "缺主路行带序列（measured.bands.items / bands.json）⇒ 无法逐条比对",
            reason="no-primary-bands", **geom_data,
        ))
    elif geom["reason"] == "band-count-mismatch":
        checks.append(new_check(
            "主/备两路逐条几何", "skipped",
            f"主/备带数不等（{geom['n_primary']}/{geom['n_backup']}）⇒ 无逐条对应关系，"
            "带数差另由上一子项判定",
            reason="band-count-mismatch", **geom_data,
        ))
    elif geom["reason"] == "incomplete-band-geometry":
        checks.append(new_check(
            "主/备两路逐条几何", "skipped",
            "行带条目缺 top/bottom/left/right 中至少一个坐标 ⇒ 无法完成逐条比对"
            "（⛔ 不把缺值当相等）",
            reason="incomplete-band-geometry", **geom_data,
        ))
    elif geom["max_abs_diff"] <= geom["tolerance_px"]:
        checks.append(new_check(
            "主/备两路逐条几何", "pass",
            f"{geom['n_primary']} 带逐条比对，坐标最大差 {fmt_num(geom['max_abs_diff'])} px"
            f" ≤ {geom['tolerance_px']} px（{geom['n_diff_bands']} 带有非零差；"
            f"容差 {geom['tolerance_status']}；{snap_src_text}）",
            **geom_data,
        ))
    else:
        sample = "；".join(
            f"#{d['index']}.{d['field']} {fmt_num(d['primary'])}≠{fmt_num(d['backup'])}"
            f"（差 {fmt_num(d['abs_diff'])}）"
            for d in geom["diffs"][:4]
        )
        checks.append(new_check(
            "主/备两路逐条几何", "fail",
            f"{geom['n_primary']} 带逐条比对，坐标最大差 "
            f"{fmt_num(geom['max_abs_diff'])} px > {geom['tolerance_px']} px；"
            f"{geom['n_diff_bands']} 带有差异：{sample}"
            f"（容差 {geom['tolerance_status']}；{snap_src_text}）",
            **geom_data,
        ))

    return {
        "id": "P-ENV-01",
        "title": "取像有效性",
        "status": aggregate(checks),
        "checks": checks,
    }


# ── P-ENV-02 ─────────────────────────────────────────────────────────────


def _run_label(raw):
    if raw is None:
        return None
    text = str(raw)
    # `F0/01` 取斜杠后的段；否则取最后一个数字（`p3`、`paragraph-03`）。
    if "/" in text:
        text = text.rsplit("/", 1)[1]
    found = re.findall(r"\d{1,2}", text)
    return found[-1].zfill(2) if found else None


def _item_is_body(item):
    if not isinstance(item, dict):
        return False
    flag = first_of(item, ["body", "is_body", "text"])
    if isinstance(flag, bool):
        return flag
    kind = first_of(item, ["kind", "type", "block"])
    if isinstance(kind, str):
        return kind.lower() in ("body", "text", "paragraph", "para", "正文")
    return True


def extract_body_runs(bands):
    """从 bands 提取正文行段。

    优先 `bands.body_runs` / `bands.paragraph_runs`（bands.py 可以直接给）；
    否则从 `bands.items` 的 top/height 按「相邻间隙 > 1.5 × 中位行距」切段。
    返回 [{"label", "count", "pitches", "items"}] 或 None（无数据）。
    """
    explicit = first_of(bands, ["body_runs", "paragraph_runs", "runs"])
    if isinstance(explicit, list) and explicit:
        runs = []
        for entry in explicit:
            if isinstance(entry, dict):
                items = entry.get("items") or entry.get("bands") or entry.get("lines")
                count = as_number(first_of(entry, ["line_count", "count", "n", "lines_count"]))
                if count is None and isinstance(items, list):
                    count = len(items)
                pitches = entry.get("pitches") or entry.get("gaps") or entry.get("centers_diff")
                if pitches is not None and not isinstance(pitches, list):
                    pitches = None
                runs.append({
                    "label": _run_label(first_of(entry, [
                        "id", "label", "paragraph", "para", "source_line", "line",
                    ])),
                    "count": int(count) if count is not None else None,
                    "pitches": [as_number(p) for p in pitches] if pitches else None,
                    "items": items if isinstance(items, list) else None,
                })
            elif isinstance(entry, list):
                runs.append({"label": None, "count": len(entry), "pitches": None, "items": entry})
        return runs

    items = bands.get("items") or bands.get("bands")
    if not isinstance(items, list) or not items:
        return None
    points = []
    for item in items:
        if not _item_is_body(item):
            continue
        top = as_number(first_of(item, ["top", "y", "top_px"]))
        height = as_number(first_of(item, ["height", "h", "band_height"])) or 0.0
        label = _run_label(first_of(item, ["paragraph", "para", "run", "group", "block"]))
        if top is None:
            return None
        points.append({"center": top + height / 2.0, "label": label})
    if not points:
        return None
    points.sort(key=lambda p: p["center"])

    gaps = [points[i + 1]["center"] - points[i]["center"] for i in range(len(points) - 1)]
    positive = [g for g in gaps if g > 0]
    median_gap = sorted(positive)[len(positive) // 2] if positive else 0.0
    threshold = max(median_gap * 1.5, 1.0) if median_gap else 1.0

    groups = []
    current = [points[0]]
    for gap, point in zip(gaps, points[1:]):
        if gap > threshold:
            groups.append(current)
            current = [point]
        else:
            current.append(point)
    groups.append(current)

    runs = []
    for group in groups:
        centers = [p["center"] for p in group]
        pitches = [centers[i + 1] - centers[i] for i in range(len(centers) - 1)]
        labels = [p["label"] for p in group if p["label"]]
        runs.append({
            "label": labels[0] if labels else None,
            "count": len(group),
            "pitches": pitches,
            "items": group,
        })
    return runs


def _assign_f0_labels(runs):
    """F0 两个正文段按顺序对应源行 01（中文）与 03（英文）。"""
    labeled = {}
    unlabeled = []
    for run in runs:
        label = run.get("label")
        if label and label not in labeled:
            labeled[label] = run
        else:
            unlabeled.append(run)
    if "01" not in labeled and unlabeled:
        labeled["01"] = unlabeled.pop(0)
    if "03" not in labeled and unlabeled:
        labeled["03"] = unlabeled.pop(0)
    return labeled


def gate_02(measured, canonical, baseline_present, roi=None):
    """P-ENV-02：仅基线页；⛔ 不判可见行数。

    `0147`：非基线页过去返回 `n/a`，而 `n/a` 不参与准入聚合 ⇒ 该闸门在常规跑批里
    等于不存在且无痕迹。改为 `skipped` 并带 reason，让「没执行」可见且不被记绿。
    """
    if canonical != BASELINE_PAGE:
        return {
            "id": "P-ENV-02",
            "title": "基线页正文行带准入",
            "status": "skipped",
            "reason": "not-baseline-page",
            "visible_line_count_checked": False,
            "checks": [new_check(
                "适用性", "skipped",
                f"仅基线页 {BASELINE_PAGE}.md 生效；当前夹具 {canonical} 未执行该闸门"
                "（⛔ 不当作通过；复核由编排侧在基线页上强制运行）",
                baseline_page=BASELINE_PAGE, fixture=canonical,
            )],
        }

    checks = []
    bands = bands_of(measured)
    runs = extract_body_runs(bands)
    # 0165：连续行带与行距 CV 都取自行带，ROI 不是 `.doc` 内容盒时结论不可用。
    roi_ok = roi_is_content_box(roi)
    roi_warnings = roi_related_warnings(roi, bands)
    if not roi_ok:
        checks.append(new_check(
            "连续正文行带", "skipped", roi_unsupported_detail(roi),
            reason="roi-not-content-box", roi_source=roi_source_of(roi),
            roi_warnings=roi_warnings,
        ))
    elif not runs:
        checks.append(new_check(
            "连续正文行带", "skipped",
            "bands 未提供 items/body_runs ⇒ 无法数连续正文行带（⛔ 不当作通过）",
        ))
    else:
        by_label = _assign_f0_labels(runs)
        for label in ("01", "03"):
            run = by_label.get(label)
            if run is None:
                checks.append(new_check(f"F0/{label} 连续行带", "fail",
                                        f"没有找到 F0/{label} 的正文行段"))
                continue
            count = run.get("count")
            if count is None:
                checks.append(new_check(f"F0/{label} 连续行带", "skipped",
                                        f"F0/{label} 有行段但未给行数"))
            elif count >= 3:
                checks.append(new_check(f"F0/{label} 连续行带", "pass",
                                        f"{count} 条 ≥ 3", count=count))
            else:
                checks.append(new_check(f"F0/{label} 连续行带", "fail",
                                        f"{count} 条 < 3", count=count))

    # 0148/0127：CV 只认 `pitch.spacing_cv_body_percent`（像素域、仅正文行带间距）。
    # ⛔ 不再按 spacing_cv→pitch_cv→line_spacing_cv→cv 猜，也不再用含段间距的
    # `pitch.cv`（00-body 实测 25.04% vs 1.20%）。缺字段 ⇒ skipped，不回退旧键。
    pitch = {}
    cv_source = "measured.bands.pitch.spacing_cv_body_percent"
    if isinstance(bands.get("pitch"), dict):
        pitch = bands["pitch"]
    elif isinstance(measured.get("pitch"), dict):
        pitch = measured["pitch"]
        cv_source = "measured.pitch.spacing_cv_body_percent"
    cv_percent_raw = first_of(pitch, ["spacing_cv_body_percent"])
    # 该字段名就是 percent 值（1.2048 == 1.2048%）；字符串带不带 `%` 都按百分数/100。
    cv_percent = as_number(cv_percent_raw)
    cv_value = cv_percent / 100.0 if cv_percent is not None else None
    quantization_floor = as_number(first_of(pitch, ["quantization_floor_percent"]))
    b_source = first_of(pitch, ["B_source"])
    cv_data = {
        "cv": cv_value,
        "cv_source": cv_source,
        "quantization_floor_percent": quantization_floor,
        "B_source": b_source,
        "roi_warnings": roi_warnings,
    }
    if not roi_ok:
        checks.append(new_check(
            "帧内行距变异系数", "skipped", roi_unsupported_detail(roi),
            reason="roi-not-content-box", roi_source=roi_source_of(roi), **cv_data,
        ))
    elif cv_value is None:
        checks.append(new_check(
            "帧内行距变异系数", "skipped",
            "缺 pitch.spacing_cv_body_percent ⇒ 无法判 ≤1%（⛔ 不回退 spacing_cv/pitch_cv/cv）",
            reason="no-spacing-cv-body", **cv_data,
        ))
    else:
        extra = (f"；量化下界 {fmt_num(quantization_floor)}%、B 来源 {b_source}"
                 if quantization_floor is not None or b_source else "")
        if cv_value <= SPACING_CV_MAX:
            checks.append(new_check(
                "帧内行距变异系数", "pass",
                f"CV {cv_value * 100:.3f}% ≤ 1%（来源：{cv_source}{extra}）",
                **cv_data,
            ))
        else:
            checks.append(new_check(
                "帧内行距变异系数", "fail",
                f"CV {cv_value * 100:.3f}% > 1%（来源：{cv_source}{extra}）",
                **cv_data,
            ))

    return {
        "id": "P-ENV-02",
        "title": "基线页正文行带准入",
        "status": aggregate(checks),
        "visible_line_count_checked": False,
        "mardo_side": ("L1 baseline 已存在（Mardo 端未在 L2 复测）"
                       if baseline_present else "未取证（L1 首采时确认）"),
        "checks": checks,
    }


# ── P-ENV-03 ─────────────────────────────────────────────────────────────


def gate_03(measured, snapshot, baseline, canonical):
    checks = []
    env = env_of(measured, snapshot)
    fields = env_fields(env)
    # D10 三字段是硬要求；sidebar_width 单列（采集侧尚无生产者，见 0130 契约申请）。
    required = ("content_width_px", "font_size", "line_height")
    missing = [key for key in required if fields.get(key) is None]
    if missing:
        checks.append(new_check(
            "环境表字段齐全", "fail",
            "缺字段：" + "、".join(missing) + "（⛔ 不用 13/14、1.6/1.7 的历史值顶替）",
        ))
    else:
        checks.append(new_check(
            "环境表字段齐全", "pass",
            "content_width_px={}、font_size={}、line_height={}".format(
                fmt_num(fields["content_width_px"]),
                fmt_num(fields["font_size"]),
                fmt_num(fields["line_height"]),
            ),
            fields={k: fields[k] for k in required},
        ))

    if fields.get("sidebar_width") is None:
        # 0130：缺值必须可见，但「未产出」不等于「环境已经坏了」⇒ skipped（准入不成立）。
        checks.append(new_check(
            "sidebar_width", "skipped",
            "measured/snapshot 未记录 sidebar_width ⇒ 该字段未校验（⛔ 不当作通过；"
            "采集侧需补生产者，见 .agent/l2-contract-requests.md CR-C-0130）",
        ))
    else:
        checks.append(new_check(
            "sidebar_width", "pass",
            f"已读到 sidebar_width={fmt_num(fields['sidebar_width'])}",
            sidebar_width=fields["sidebar_width"],
        ))

    # 0192：字体面与平滑必须可见；缺值 ⇒ skipped（⛔ 不当作通过）。
    font_keys = ("font_family", "font_smoothing")
    font_missing = [key for key in font_keys if fields.get(key) is None]
    if font_missing:
        checks.append(new_check(
            "字体面与平滑", "skipped",
            "环境表缺 " + "、".join(font_missing) + " ⇒ 字体面变化不可见"
            "（⛔ 不当作通过；采集侧需补生产者，见 bugs/0192）",
            reason="no-font-env", missing=font_missing,
        ))
    else:
        checks.append(new_check(
            "字体面与平滑", "pass",
            "font_family={!r}；-webkit-font-smoothing={!r}".format(
                fields["font_family"], fields["font_smoothing"]),
            font_family=fields["font_family"],
            font_smoothing=fields["font_smoothing"],
        ))

    # 0238：measured 与 snapshot 是同一环境的两份产物，不一致必须显形。
    source_conflicts, source_compared = env_source_conflicts(measured, snapshot)
    if source_conflicts:
        sample = "；".join(
            f"{item['field']} measured={item['measured']!r} snapshot={item['snapshot']!r}"
            for item in source_conflicts)
        checks.append(new_check(
            "环境来源一致性", "fail",
            f"measured 与 snapshot 对同一环境给出不同值：{sample}"
            "（⛔ 两份产物不得各取一半）",
            conflicts=source_conflicts,
        ))
    elif source_compared == 0:
        checks.append(new_check(
            "环境来源一致性", "skipped",
            "measured 与 snapshot 没有同时提供的环境字段 ⇒ 无法交叉核对"
            "（⛔ 不当作通过）",
            reason="no-env-source-overlap",
        ))
    else:
        checks.append(new_check(
            "环境来源一致性", "pass",
            f"measured 与 snapshot 的 {source_compared} 个共有环境字段一致",
            compared=source_compared,
        ))

    candidates = baseline_env_candidates(baseline, canonical)
    if not candidates:
        checks.append(new_check(
            "与基线三字段差", "skipped",
            "没有 L1 基线环境表 ⇒ 无法校验 ≤1 pt（no-baseline；⛔ 不当作通过）",
        ))
        return {
            "id": "P-ENV-03",
            "title": "环境表三字段",
            "status": aggregate(checks),
            "checks": checks,
        }

    # 0228/0236：全部候选必须一致才采信；不一致即报告冲突，不再取第一条。
    by_identity = {}
    for source, env in candidates:
        base_fields_candidate = env_fields(env)
        identity = tuple(
            (key, None if base_fields_candidate.get(key) is None
             else (_norm_env_text(base_fields_candidate[key])
                   if key in ENV_TEXT_FIELDS
                   else round(float(base_fields_candidate[key]), 6)))
            for key in ENV_NUMERIC_FIELDS + ENV_TEXT_FIELDS)
        by_identity.setdefault(identity, []).append(source)
    if len(by_identity) > 1:
        groups = []
        for sources in by_identity.values():
            groups.append("、".join(sources[:3]) + ("…" if len(sources) > 3 else ""))
        checks.append(new_check(
            "基线环境一致性", "fail",
            "基线里同一夹具的环境表互相矛盾（" + " vs ".join(groups)
            + "）⇒ 环境基线不可复现，必须先重采 L1",
            candidate_sources=[source for source, _ in candidates],
        ))

    base_fields = env_fields(candidates[0][1])
    for key, label in (("content_width_px", "content_width_px"),
                       ("font_size", "font_size"),
                       ("line_height", "line_height"),
                       ("sidebar_width", "sidebar_width")):
        cur = fields.get(key)
        base = base_fields.get(key)
        if base is None:
            checks.append(new_check(f"{label} 与基线差", "skipped",
                                    f"基线环境表缺 {label}"))
            continue
        if cur is None:
            # 上面已有单项 skipped（sidebar）或 fail（D10 三字段），此处不重复判绿。
            continue
        diff = abs(cur - base)
        if diff <= ENV_TOLERANCE:
            checks.append(new_check(
                f"{label} 与基线差", "pass",
                f"L2 {fmt_num(cur)} vs 基线 {fmt_num(base)} ⇒ 差 {diff:.3g} ≤ 1 pt",
                current=cur, baseline=base, diff=diff,
            ))
        else:
            checks.append(new_check(
                f"{label} 与基线差", "fail",
                f"L2 {fmt_num(cur)} vs 基线 {fmt_num(base)} ⇒ 差 {diff:.3g} > 1 pt，基线重采",
                current=cur, baseline=base, diff=diff,
            ))

    # 0192：字体面/平滑按归一字符串比较（声明列表，不做字体解析）。
    for key, label in (("font_family", "font_family"),
                       ("font_smoothing", "-webkit-font-smoothing")):
        cur = fields.get(key)
        base = base_fields.get(key)
        if base is None and cur is None:
            continue
        if base is None:
            checks.append(new_check(f"{label} 与基线差", "skipped",
                                    f"基线环境表缺 {label} ⇒ 无法比较"))
            continue
        if cur is None:
            checks.append(new_check(f"{label} 与基线差", "skipped",
                                    f"当轮环境表缺 {label} ⇒ 无法比较（⛔ 不当作通过）"))
            continue
        if _norm_env_text(cur) == _norm_env_text(base):
            checks.append(new_check(
                f"{label} 与基线差", "pass",
                f"与基线一致（{_norm_env_text(cur)[:80]!r}）",
                current=cur, baseline=base,
            ))
        else:
            checks.append(new_check(
                f"{label} 与基线差", "fail",
                f"L2 {cur!r} ≠ 基线 {base!r} ⇒ 字体环境已变，结论不可跨机使用",
                current=cur, baseline=base,
            ))

    return {
        "id": "P-ENV-03",
        "title": "环境表三字段",
        "status": aggregate(checks),
        "checks": checks,
    }


# ── P-ENV-04 ─────────────────────────────────────────────────────────────


# ── 0181：前台应用自证的「读不到」不得算作「未改变」────────────────────────
#
# `l2-snapshot.swift` 在 `frontmostApplication == nil` 时写占位符 `<无法读取>`，
# `capture.sh` 的同类探针写 `-`。占位符是非空字符串，旧实现走 `before == after`
# 分支判绿 —— 但「两次都没读到」不是「两次读到同一个应用」的证据（§7.0 铁律 2
# 隐含前提是两次读值都真实）。这里把占位符一律按缺失处理，并尽量按
# `(bundle id, 应用名)` 二元组比较身份，避免同名不同应用被判「未改变」。
_FRONTMOST_PLACEHOLDERS = {
    "<无法读取>", "无法读取", "<unreadable>", "unreadable", "<unknown>",
    "-", "--", "—", "null", "nil", "none", "unknown", "?", "n/a", "na",
}

_FRONTMOST_NAME_KEYS = {
    "before": ("foreground_before", "foreground.before", "frontmost_before",
               "frontmost.before", "active_app_before", "apps.before"),
    "after": ("foreground_after", "foreground.after", "frontmost_after",
              "frontmost.after", "active_app_after", "apps.after"),
}
_FRONTMOST_BUNDLE_KEYS = {
    "before": ("frontmost_before_bundle", "frontmost_before_bundle_id",
               "frontmost_before.bundle_id", "foreground_before_bundle",
               "foreground_before.bundle_id", "foreground.before.bundle_id",
               "frontmost.before.bundle_id", "apps.before.bundle_id"),
    "after": ("frontmost_after_bundle", "frontmost_after_bundle_id",
              "frontmost_after.bundle_id", "foreground_after_bundle",
              "foreground_after.bundle_id", "foreground.after.bundle_id",
              "frontmost.after.bundle_id", "apps.after.bundle_id"),
}
_FRONTMOST_READ_OK_KEYS = {
    "before": ("frontmost_before_ok", "frontmost_read_ok_before",
               "foreground_before.read_ok", "foreground.before.read_ok"),
    "after": ("frontmost_after_ok", "frontmost_read_ok_after",
              "foreground_after.read_ok", "foreground.after.read_ok"),
}


def _is_placeholder_app(value):
    """`None`、空串、`<无法读取>`、`-` 之类一律视为「没读到」。"""
    if value is None:
        return True
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text:
        return True
    if text.lower() in _FRONTMOST_PLACEHOLDERS:
        return True
    # 当前生产者的占位写法统一是 `<…>`。
    return text.startswith("<") and text.endswith(">")


def _frontmost_identity(snapshot, phase):
    """解析一侧前台应用：应用名、bundle id、生产者是否报「读到」。

    返回 `{name, bundle, read_ok, raw}`；`read_ok` 为 `None` 表示生产者没给该字段
    （⛔ 不当作读成功）。
    """
    raw = first_of(snapshot, _FRONTMOST_NAME_KEYS[phase])
    bundle = first_of(snapshot, _FRONTMOST_BUNDLE_KEYS[phase])
    name = raw
    if isinstance(raw, dict):
        bundle = first_of(raw, ["bundle_id", "bundleIdentifier", "bundle"]) or bundle
        name = first_of(raw, ["name", "localized_name", "localizedName",
                              "application"])
    if isinstance(name, str):
        name = name.strip() or None
    if isinstance(bundle, str):
        bundle = bundle.strip() or None
    read_ok = first_of(snapshot, _FRONTMOST_READ_OK_KEYS[phase])
    if not isinstance(read_ok, bool):
        read_ok = None
    return {"name": name, "bundle": bundle, "read_ok": read_ok, "raw": raw}


def _frontmost_has_identity(ident):
    """至少有一项真实身份（非占位符）：应用名或 bundle id。"""
    name = ident.get("name")
    bundle = ident.get("bundle")
    return (not _is_placeholder_app(name)) or (not _is_placeholder_app(bundle))


def gate_04(snapshot, snapshot_reason, baseline, canonical):
    checks = []
    if not isinstance(snapshot, dict):
        checks.append(new_check(
            "取像自证", "fail",
            f"缺 snapshot.json（{snapshot_reason or '不可读'}）⇒ 无法证明未干扰前台",
        ))
        return {
            "id": "P-ENV-04",
            "title": "离屏取像自证",
            "status": "fail",
            "checks": checks,
        }

    before = _frontmost_identity(snapshot, "before")
    after = _frontmost_identity(snapshot, "after")
    ident_data = {
        "before": before["name"],
        "after": after["name"],
        "before_bundle": before["bundle"],
        "after_bundle": after["bundle"],
        "read_ok_before": before["read_ok"],
        "read_ok_after": after["read_ok"],
    }
    # 0181：读失败的占位符（`<无法读取>` / `-` / 空串）与人名词典里的占位符，
    # 都不构成「前后未改变」的证据。生产者显式报 `read_ok=false` 同理。
    read_failed = [
        label for label, ident in (("抓帧前", before), ("抓帧后", after))
        if ident["read_ok"] is False
    ]
    if read_failed:
        checks.append(new_check(
            "前台应用前后一致", "fail",
            f"{'、'.join(read_failed)}生产者报读不到前台应用 ⇒ 无证据，该帧作废"
            "（§7.0 铁律 2）",
            identity_basis=None, **ident_data,
        ))
    elif not _frontmost_has_identity(before) or not _frontmost_has_identity(after):
        checks.append(new_check(
            "前台应用前后一致", "fail",
            f"没读到真实前台应用（{before['name'] or before['raw'] or '缺'} → "
            f"{after['name'] or after['raw'] or '缺'}）⇒ 两值相等/皆缺不是「未改变」的"
            "证据，该帧作废（§7.0 铁律 2；0181）",
            identity_basis=None, **ident_data,
        ))
    else:
        name_differs = (
            not _is_placeholder_app(before["name"])
            and not _is_placeholder_app(after["name"])
            and str(before["name"]) != str(after["name"])
        )
        bundle_both = (
            not _is_placeholder_app(before["bundle"])
            and not _is_placeholder_app(after["bundle"])
        )
        bundle_differs = bundle_both and str(before["bundle"]) != str(after["bundle"])
        if name_differs or bundle_differs:
            if bundle_differs and not name_differs:
                shown = (f"{before['name']} → {after['name']}："
                         if not _is_placeholder_app(before["name"]) else "")
                detail = (f"{shown}bundle id {before['bundle']} ≠ "
                          f"{after['bundle']} ⇒ 是不同的应用，前台已改变，该帧作废")
            else:
                detail = f"{before['name']} → {after['name']}：前台应用改变，该帧作废"
            checks.append(new_check(
                "前台应用前后一致", "fail", detail,
                identity_basis="bundle+name" if bundle_both else "name", **ident_data,
            ))
        else:
            basis = "bundle+name" if bundle_both else "name"
            any_bundle = (
                not _is_placeholder_app(before["bundle"])
                or not _is_placeholder_app(after["bundle"])
            )
            if bundle_both:
                note = ""
            elif any_bundle:
                note = ("；⚠️ bundle id 只有一侧提供，身份未能按二元组完整核对"
                        "（生产者需两侧都发 bundle id，见 0181）")
            else:
                note = ("；⚠️ 两侧均未提供 bundle id，身份只按应用名比较"
                        "（同名不同应用不可排除，生产者需补 bundle id，见 0181）")
            checks.append(new_check(
                "前台应用前后一致", "pass",
                f"{before['name'] or before['bundle']} → "
                f"{after['name'] or after['bundle']}（未改变{note}）",
                identity_basis=basis, **ident_data,
            ))

    active = first_of(snapshot, [
        "is_active", "isActive", "app.is_active", "app.isActive",
        "nsapp_is_active", "nsapp_active", "NSApp.isActive",
    ])
    if not isinstance(active, bool):
        checks.append(new_check("isActive", "fail", "缺布尔字段 isActive（⛔ 不当作通过）"))
    elif active:
        checks.append(new_check("isActive", "fail", "isActive=true：应用被激活，取像无效"))
    else:
        checks.append(new_check("isActive", "pass", "isActive=false"))

    key = first_of(snapshot, [
        "is_key_window", "isKeyWindow", "window.is_key_window", "window.isKeyWindow",
        "key_window", "window_is_key",
    ])
    if not isinstance(key, bool):
        checks.append(new_check("isKeyWindow", "fail", "缺布尔字段 isKeyWindow（⛔ 不当作通过）"))
    elif key:
        checks.append(new_check("isKeyWindow", "fail", "isKeyWindow=true：窗口成了 key，取像无效"))
    else:
        checks.append(new_check("isKeyWindow", "pass", "isKeyWindow=false"))

    visible = first_of(snapshot, [
        "window_visible", "visible", "is_visible", "window.is_visible",
        "window.visible", "onscreen", "window_onscreen",
    ])
    if isinstance(visible, (int, float)) and not isinstance(visible, bool):
        if visible in (0, 1):
            visible = bool(visible)
    alpha = as_number(first_of(snapshot, ["alpha", "window.alpha", "alpha_value"]))
    # 0150：`alpha_source` 以 `static:` 开头 ⇒ 该值是读源码/常量得到的**自证**，
    # 不是运行期观测。此时 visible/alpha 一律不可采信，必须 skipped 并影响准入。
    alpha_source = first_of(snapshot, [
        "alpha_source", "attestation_source", "visibility_source", "source.alpha",
    ])
    static_attestation = (
        isinstance(alpha_source, str) and alpha_source.strip().lower().startswith("static")
    )
    if static_attestation:
        checks.append(new_check(
            "窗口不可见", "skipped",
            f"不可见性来自静态自证（alpha_source={alpha_source[:80]}）⇒ 不是运行期观测，"
            "不得记绿；需采集侧提供运行期 attestation（见契约申请 CR-C-0150）",
            alpha_source=alpha_source,
        ))
    elif isinstance(visible, bool):
        if visible:
            checks.append(new_check("窗口不可见", "fail", "visible=true：窗口可见，违反离屏约束"))
        else:
            checks.append(new_check("窗口不可见", "pass", "visible=false"))
    elif alpha is not None:
        if alpha == 0:
            checks.append(new_check("窗口不可见", "pass", f"alpha={fmt_num(alpha)} ⇒ 不可见"))
        else:
            checks.append(new_check("窗口不可见", "fail",
                                    f"alpha={fmt_num(alpha)} ≠ 0（未记录 visible）"))
    else:
        checks.append(new_check(
            "窗口不可见", "skipped",
            "snapshot 未记录 visible/alpha ⇒ 无法自证不可见（⛔ 不当作通过）",
        ))

    current_window = first_of(snapshot, ["window_id", "window.id", "windowId"])
    # 0161/0236：基线窗口 ID 同时读顶层、行内与 provenance，且 dict/list 两种
    # 形状都认；多值不一致 ⇒ 无法判定，显式报红。
    base_windows = baseline_window_ids(baseline, canonical)
    if len(base_windows) > 1:
        checks.append(new_check(
            "窗口 ID", "fail",
            "基线 window_id 不唯一（" + "、".join(base_windows[:4]) + "）⇒ N4 无唯一判据",
            baseline_windows=base_windows,
        ))
    elif current_window is not None and base_windows:
        base_window = base_windows[0]
        if str(current_window) == str(base_window):
            checks.append(new_check("窗口 ID", "pass", f"{current_window} == 基线"))
        else:
            checks.append(new_check(
                "窗口 ID", "fail",
                f"{current_window} ≠ 基线 {base_window}（§7.0；N4 属 L1）",
            ))
    elif current_window is None and base_windows:
        checks.append(new_check(
            "窗口 ID", "n/a",
            "L2 离屏取像无窗口 ID；该子项只在 L1 施加（N4）",
        ))
    elif current_window is None:
        checks.append(new_check("窗口 ID", "n/a", "无窗口 ID 可比"))
    else:
        # 0161：旧实现让这个组合落空（没有子项），aggregate 会把它当不存在。
        # 「本轮有窗口 ID、基线没有」不是「未改变」，而是**未验证**。
        checks.append(new_check(
            "窗口 ID", "skipped",
            f"本轮有窗口 ID {current_window}，但基线没有 window_id/provenance.window_id "
            "⇒ N4 无法判定（⛔ 不当作通过；需 L1 补窗口 ID）",
            reason="no-baseline-window-id",
        ))

    return {
        "id": "P-ENV-04",
        "title": "离屏取像自证",
        "status": aggregate(checks),
        "checks": checks,
    }


# ── P-ENV-05 ─────────────────────────────────────────────────────────────


def gate_05(measured, fixture_dir, work, canonical, fixtures_dir, expect, expect_reason):
    checks = []
    live_sha = sha256_file(fixture_md_path(fixtures_dir, canonical))
    recorded_sha = first_of(measured, ["fixture_sha256", "sha256", "fixture.sha256"])
    recorded_sha = recorded_sha if isinstance(recorded_sha, str) and recorded_sha else None
    # bugs/0189：⛔ 不许拿 measured.json 自报值顶替磁盘夹具——那等于让被检对象自证。
    # 磁盘夹具读不到时，"当前 sha" 就是未知，必须显形为 fail（输入缺失），不是 pass。
    current_sha = live_sha
    # 0189：产物记录 SHA 来源，下游可区分「磁盘实测」与「只有自报」。
    sha_source = "live" if live_sha else ("recorded" if recorded_sha else "none")
    sha_data = {
        "sha_source": sha_source,
        "sha_source_used": "live" if live_sha else None,
        "recorded_sha": recorded_sha,
    }

    if live_sha and recorded_sha and live_sha != recorded_sha:
        checks.append(new_check(
            "夹具 SHA 自洽", "fail",
            f"measured.json 记录 {recorded_sha[:12]}…，磁盘夹具为 {live_sha[:12]}…",
            live=live_sha, recorded=recorded_sha, **sha_data,
        ))
    elif live_sha:
        checks.append(new_check("夹具 SHA 自洽", "pass", f"磁盘夹具 {live_sha[:12]}…",
                                live=live_sha, **sha_data))
    else:
        checks.append(new_check(
            "夹具 SHA 自洽", "fail",
            f"夹具读不到（{fixture_md_path(fixtures_dir, canonical)}）；⛔ 不用 "
            f"measured.json 自报值顶替（sha_source={sha_source}）",
            recorded=recorded_sha, **sha_data,
        ))

    entry = expect_entry(expect, canonical)
    # 0154：载荷 HTML 版本指纹必须与期望文件冻结值一致；缺冻结值 ⇒ skipped（不静默 pass）。
    checks.append(docs_fingerprint_check(measured, expect, entry, canonical))
    if entry is None:
        checks.append(new_check(
            "夹具 SHA 与期望", "skipped",
            f"缺 fixtures-expect.json 条目（{expect_reason or '不可读'}）⇒ 整轮无法冻结期望",
        ))
        checks.append(new_check("块种类序列", "skipped", "缺期望条目"))
        return {
            "id": "P-ENV-05",
            "title": "夹具与期望冻结",
            "status": aggregate(checks),
            "checks": checks,
            "sha_source": sha_source,
        }

    expected_sha = expect_sha(entry)
    if expected_sha is None:
        checks.append(new_check("夹具 SHA 与期望", "skipped", "期望条目没有 sha256",
                                **sha_data))
    elif current_sha is None:
        checks.append(new_check("夹具 SHA 与期望", "skipped", "拿不到当前夹具 sha256",
                                **sha_data))
    elif current_sha == expected_sha:
        checks.append(new_check(
            "夹具 SHA 与期望", "pass", f"{current_sha[:12]}… 一致（来源 {sha_source}）",
            **sha_data,
        ))
    else:
        checks.append(new_check(
            "夹具 SHA 与期望", "fail",
            f"夹具已变：期望 {expected_sha[:12]}… ≠ 当前 {current_sha[:12]}…；"
            "fixtures-expect.json 过期（§2.6 合法重生成触发 1：夹具 sha256 变；"
            "⛔ 不得运行时回填）",
            expected=expected_sha, current=current_sha, **sha_data,
        ))

    expected_kinds = expect_blocks(entry)
    current_kinds, kinds_src, kinds_meta = current_block_kinds(
        measured, fixture_dir, work, canonical)
    if expected_kinds is None:
        checks.append(new_check("块种类序列", "skipped", "期望条目没有 blocks_kind",
                                **kinds_meta))
    elif current_kinds is None:
        checks.append(new_check(
            "块种类序列", "skipped",
            "当轮没有导出的 blocks.kind（⛔ 不用 §2.6 的表述当期望）",
            **kinds_meta,
        ))
    elif list(current_kinds) == list(expected_kinds):
        checks.append(new_check(
            "块种类序列", "pass",
            f"{len(current_kinds)} 块一致（来源 {kinds_src}）",
            kinds=list(current_kinds), source=kinds_src, **kinds_meta,
        ))
    else:
        checks.append(new_check(
            "块种类序列", "fail",
            f"当轮 {current_kinds} ≠ 期望 {expected_kinds}（整轮拒绝；P-COV-02）",
            current=list(current_kinds), expected=list(expected_kinds), source=kinds_src,
            **kinds_meta,
        ))

    # 0189：measured.json 自报值只作交叉核对；与磁盘产物不一致即红。
    if kinds_meta.get("conflict"):
        checks.append(new_check(
            "块种类自报交叉核对", "fail",
            "measured.json 自报的块种类序列与磁盘产物不一致 ⇒ 被检对象自证不可信"
            f"（自报来源 {kinds_meta.get('self_reported_source') or '未知'}）",
            self_reported=list(kinds_meta.get("self_reported") or []),
            disk=list(current_kinds or []),
            disk_source=kinds_meta.get("disk_source"),
        ))
    elif kinds_meta.get("unverified"):
        checks.append(new_check(
            "块种类自报交叉核对", "skipped",
            "只有 measured.json 自报的块种类序列，没有磁盘产物可交叉核对"
            "（⛔ 不当作已核对）",
            reason="no-disk-blocks",
            self_reported_source=kinds_meta.get("self_reported_source"),
        ))
    else:
        checks.append(new_check(
            "块种类自报交叉核对", "pass",
            "磁盘产物与 measured.json 自报一致（或 measured 未自报）",
            disk_source=kinds_meta.get("disk_source"),
        ))

    return {
        "id": "P-ENV-05",
        "title": "夹具与期望冻结",
        "status": aggregate(checks),
        "checks": checks,
        "sha_source": sha_source,
        "block_kinds_source": kinds_src,
    }


# ── P-ENV-06 ─────────────────────────────────────────────────────────────


def gate_06_impl(measured, canonical, expect, expect_reason, gate03, gate05):
    checks = []
    entry = expect_entry(expect, canonical)
    expected = expect_dom_boxes(entry) if entry is not None else None
    current = dom_line_boxes(measured)

    if entry is None:
        checks.append(new_check(
            "DOM 行盒数", "skipped",
            f"缺 fixtures-expect.json 条目（{expect_reason or '不可读'}）",
        ))
        return {
            "id": "P-ENV-06",
            "title": "DOM 行盒数（唯一相等判定）",
            "status": aggregate(checks),
            "checks": checks,
        }
    if expected is None:
        checks.append(new_check(
            "DOM 行盒数", "skipped",
            "fixtures-expect.json 的 dom_line_boxes 为 null（首版未冻结；⛔ 不当作通过）",
        ))
        return {
            "id": "P-ENV-06",
            "title": "DOM 行盒数（唯一相等判定）",
            "status": aggregate(checks),
            "checks": checks,
        }
    if current is None:
        checks.append(new_check(
            "DOM 行盒数", "skipped",
            "measured.json 的 dom 没有行盒数（⛔ 不拿像素行带数顶替）",
        ))
        return {
            "id": "P-ENV-06",
            "title": "DOM 行盒数（唯一相等判定）",
            "status": aggregate(checks),
            "checks": checks,
        }

    if current == expected:
        checks.append(new_check(
            "DOM 行盒数", "pass",
            f"DOM 行盒数 {current} == 期望 {expected}（唯一相等判定口径）",
            current=current, expected=expected,
        ))
    else:
        # E2 判因分叉：先看 P-ENV-03 三字段，再看 P-ENV-05 是否**真正 pass**。
        env_pass = gate03.get("status") == "pass"
        # 0234：旧实现 `!= "fail"` 把 skipped/unverified 也当成「冻结成功」，
        # 于是夹具未验证时仍可能判 product-change。只有 pass 才是证据。
        fixture_ok = gate05.get("status") == "pass"
        if env_pass and fixture_ok:
            checks.append(new_check(
                "DOM 行盒数", "product-change",
                f"DOM 行盒数 {current} ≠ 期望 {expected}，但三字段与基线一致 ⇒ "
                "判为产品排版变更（§2.6 第二种合法重生成触发）；"
                "⛔ 不得静默改期望，须列逐夹具 diff 与变更单指针",
                current=current, expected=expected,
            ))
        elif not fixture_ok:
            checks.append(new_check(
                "DOM 行盒数", "skipped",
                f"DOM 行盒数 {current} ≠ 期望 {expected}，但 P-ENV-05 未通过"
                f"（{status_text(gate05.get('status'), gate05.get('reason'))}）⇒ "
                "夹具/期望未验证，无法做判因分叉（⛔ 不当作 product-change）",
                reason="fixture-unverified",
                current=current, expected=expected,
                gate05_status=gate05.get("status"),
                gate05_reason=gate05.get("reason"),
            ))
        else:
            checks.append(new_check(
                "DOM 行盒数", "fail",
                f"DOM 行盒数 {current} ≠ 期望 {expected}，且 P-ENV-03 未通过"
                f"（{status_text(gate03.get('status'))}）⇒ 归因环境无效 / 无法排除环境变化",
                current=current, expected=expected,
            ))

    return {
        "id": "P-ENV-06",
        "title": "DOM 行盒数（唯一相等判定）",
        "status": aggregate(checks),
        "checks": checks,
    }


# ── gates 汇总 ───────────────────────────────────────────────────────────


def run_gates(args):
    canonical = canonical_fixture(args.fixture)
    fixture_dir = resolve_fixture_dir(args.work, canonical)
    measured, measured_path = load_measured(fixture_dir)
    measured["_fixture"] = canonical
    snapshot, snapshot_reason, snapshot_path = load_snapshot(fixture_dir)
    roi = load_roi(fixture_dir, measured)
    baseline, baseline_reason = load_optional_json(args.baseline)
    expect, expect_reason = load_optional_json(args.expect)

    if baseline is not None and not isinstance(baseline, (dict, list)):
        raise PreflightError(f"baseline.json 顶层不是对象/数组：{args.baseline}")
    if expect is not None and not isinstance(expect, dict):
        raise PreflightError(f"fixtures-expect.json 顶层不是对象：{args.expect}")

    gate01 = gate_01(measured, snapshot, fixture_dir, canonical, roi=roi)
    gate02 = gate_02(measured, canonical, baseline is not None, roi=roi)
    gate03 = gate_03(measured, snapshot, baseline, canonical)
    gate04 = gate_04(snapshot, snapshot_reason, baseline, canonical)
    gate05 = gate_05(measured, fixture_dir, args.work, canonical,
                     args.fixtures_dir, expect, expect_reason)
    gate06 = gate_06_impl(measured, canonical, expect, expect_reason, gate03, gate05)
    gates = [gate01, gate02, gate03, gate04, gate05, gate06]

    fails = [g for g in gates if g["status"] == "fail"]
    product_changes = [g for g in gates if g["status"] == "product-change"]
    skips = [g for g in gates if g["status"] == "skipped"]
    if fails:
        overall = "environment-invalid"
        exit_code = EXIT_ENV_INVALID
        summary = ("环境无效：" + "；".join(
            f"{g['id']} " + "；".join(c["detail"] for c in g["checks"] if c["status"] == "fail")
            for g in fails
        ))
    elif product_changes:
        overall = "product-typography-change"
        exit_code = EXIT_PRODUCT_CHANGE
        summary = "产品排版变更（非环境无效）：" + "；".join(
            f"{g['id']} " + "；".join(c["detail"] for c in g["checks"]
                                     if c["status"] == "product-change")
            for g in product_changes
        )
    elif skips:
        overall = "incomplete"
        exit_code = EXIT_INCOMPLETE
        summary = "环境闸门未全部完成（跳过：" + "、".join(g["id"] for g in skips) + "）"
    else:
        overall = "pass"
        exit_code = EXIT_PASS
        summary = "P-ENV-01..06 全部通过"

    result = {
        "tool": "preflight",
        "mode": "gates",
        "fixture": canonical,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "inputs": {
            "work": fixture_dir,
            "measured": measured_path,
            "snapshot": snapshot_path,
            "snapshot_present": snapshot is not None,
            "snapshot_reason": snapshot_reason,
            "baseline": args.baseline,
            "baseline_present": baseline is not None,
            "baseline_reason": baseline_reason,
            "expect": args.expect,
            "expect_present": expect is not None,
            "expect_reason": expect_reason,
            "fixtures_dir": args.fixtures_dir,
        },
        "fixture_sha256": sha256_file(fixture_md_path(args.fixtures_dir, canonical)),
        "gates": gates,
        "overall": {
            "status": overall,
            "exit_code": exit_code,
            "summary": summary,
        },
    }
    return result, exit_code


def print_gates_report(result):
    print(f"L2 环境闸门 · fixture {result['fixture']}.md")
    inputs = result["inputs"]
    print(f"  measured: {inputs['measured']}")
    print(f"  snapshot: {inputs['snapshot']} "
          f"({'有' if inputs['snapshot_present'] else '缺：' + str(inputs['snapshot_reason'])})")
    print(f"  baseline: {inputs['baseline']} "
          f"({'有' if inputs['baseline_present'] else '缺：' + str(inputs['baseline_reason'])})")
    print(f"  expect  : {inputs['expect']} "
          f"({'有' if inputs['expect_present'] else '缺：' + str(inputs['expect_reason'])})")
    print("─" * 72)
    for gate in result["gates"]:
        print(f"{gate['id']}  {status_text(gate['status'])}  {gate['title']}")
        for check in gate["checks"]:
            mark = {
                "pass": "✓", "fail": "✗", "skipped": "–",
                "n/a": "·", "product-change": "!",
            }.get(check["status"], "?")
            print(f"   {mark} {check['name']}：{check['detail']}")
    print("─" * 72)
    overall = result["overall"]
    print(f"环境结论：{status_text(overall['status'])}（exit {overall['exit_code']}）")
    print(f"  {overall['summary']}")


# ── 颜色：sRGB → CIELAB → CIEDE2000（§2.3 T4 / M4） ─────────────────────


def _alpha_fraction(raw):
    """把 alpha 写法（`0.1` / `10%` / `128`）归一成 [0,1]；读不出返回 None。"""
    if raw is None:
        return 1.0
    text = str(raw).strip()
    if not text:
        return 1.0
    try:
        if text.endswith("%"):
            return max(0.0, min(1.0, float(text[:-1]) / 100.0))
        num = float(text)
    except ValueError:
        return None
    if num > 1.0:
        num = num / 255.0
    return max(0.0, min(1.0, num))


def _channel_255(raw):
    """把 0..255 或 `50%` 的通道写法归一成 0..255；读不出返回 None。"""
    try:
        text = str(raw).strip()
        if text.endswith("%"):
            value = float(text[:-1]) * 255.0 / 100.0
        else:
            value = float(text)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(255.0, value))


def _hsl_to_rgb(hue, saturation, lightness):
    """HSL（hue 度、s/l ∈ [0,1]）→ sRGB 0..255。"""
    hue = (hue % 360.0) / 360.0
    saturation = max(0.0, min(1.0, saturation))
    lightness = max(0.0, min(1.0, lightness))
    if saturation == 0:
        value = int(round(lightness * 255))
        return (value, value, value)

    def hue_to_channel(p, q, t):
        if t < 0:
            t += 1
        if t > 1:
            t -= 1
        if t < 1.0 / 6.0:
            return p + (q - p) * 6.0 * t
        if t < 1.0 / 2.0:
            return q
        if t < 2.0 / 3.0:
            return p + (q - p) * (2.0 / 3.0 - t) * 6.0
        return p

    q = (lightness * (1.0 + saturation) if lightness < 0.5
         else lightness + saturation - lightness * saturation)
    p = 2.0 * lightness - q
    return tuple(int(round(hue_to_channel(p, q, hue + offset) * 255))
                 for offset in (1.0 / 3.0, 0.0, -1.0 / 3.0))


def parse_color(value):
    """把颜色写法解析成 `(r, g, b, alpha)`（alpha ∈ [0,1]）；读不出返回 None。

    0229：旧实现丢 alpha、只认 `#rgb/#rrggbb` 与 `rgb()/rgba()`，解析失败后
    `compare_values` 回退成「取字符串里第一个数字」⇒ 仅 alpha 不同、`hsl()`
    明度不同、`color(srgb …)` 不同都判 pass。现在支持：

      - `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`
      - `rgb()` / `rgba()`（逗号、空格、`/` 分隔；通道可带 `%`）
      - `hsl()` / `hsla()`（色相/饱和度/明度）
      - `color(srgb r g b [/ a])`（0..1 分量）
      - `white` / `black` / `transparent`
      - 长度 ≥3 的数值序列（长度 ≥4 时第 4 位视为 alpha）

    颜色语法覆盖范围与 alpha 比较口径待设计批准（`bugs/0229`）。
    """
    if isinstance(value, (list, tuple)):
        if len(value) < 3:
            return None
        try:
            rgb = tuple(max(0, min(255, int(round(float(value[i]))))) for i in range(3))
        except (TypeError, ValueError):
            return None
        alpha = _alpha_fraction(value[3]) if len(value) >= 4 else 1.0
        if alpha is None:
            return None
        return rgb + (alpha,)
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    named = {"white": (255, 255, 255), "black": (0, 0, 0)}
    if text == "transparent":
        return (0, 0, 0, 0.0)
    if text in named:
        return named[text] + (1.0,)
    if text.startswith("#"):
        hexpart = text[1:]
        if not re.fullmatch(r"[0-9a-f]{3,8}", hexpart):
            return None
        if len(hexpart) in (3, 4):
            rgb = tuple(int(ch * 2, 16) for ch in hexpart[:3])
            alpha = int(hexpart[3] * 17, 16) / 255.0 if len(hexpart) == 4 else 1.0
            return rgb + (alpha,)
        if len(hexpart) in (6, 8):
            rgb = tuple(int(hexpart[i:i + 2], 16) for i in (0, 2, 4))
            alpha = int(hexpart[6:8], 16) / 255.0 if len(hexpart) == 8 else 1.0
            return rgb + (alpha,)
        return None
    match = re.match(r"^(rgba?|hsla?|color)\((.*)\)$", text, re.S)
    if not match:
        return None
    function, body = match.group(1), match.group(2).strip()
    parts = [p for p in re.split(r"[,\s/]+", body) if p]
    if function in ("rgb", "rgba"):
        if len(parts) < 3:
            return None
        channels = [_channel_255(parts[i]) for i in range(3)]
        if any(channel is None for channel in channels):
            return None
        alpha = _alpha_fraction(parts[3]) if len(parts) >= 4 else 1.0
        if alpha is None:
            return None
        return tuple(int(round(channel)) for channel in channels) + (alpha,)
    if function in ("hsl", "hsla"):
        if len(parts) < 3:
            return None
        try:
            hue = float(parts[0].rstrip("deg"))
        except ValueError:
            return None

        def ratio(raw):
            raw = raw.strip()
            try:
                if raw.endswith("%"):
                    return float(raw[:-1]) / 100.0
                number = float(raw)
            except ValueError:
                return None
            return number / 100.0 if number > 1.0 else number

        saturation = ratio(parts[1])
        lightness = ratio(parts[2])
        if saturation is None or lightness is None:
            return None
        alpha = _alpha_fraction(parts[3]) if len(parts) >= 4 else 1.0
        if alpha is None:
            return None
        return _hsl_to_rgb(hue, saturation, lightness) + (alpha,)
    # color(srgb r g b [/ a])：分量是 0..1 小数。
    if not parts or parts[0] not in ("srgb", "srgb-linear", "display-p3"):
        return None
    if len(parts) < 4:
        return None
    channels = []
    for raw in parts[1:4]:
        try:
            channels.append(max(0.0, min(1.0, float(raw))) * 255.0)
        except ValueError:
            return None
    alpha = _alpha_fraction(parts[4]) if len(parts) >= 5 else 1.0
    if alpha is None:
        return None
    return tuple(int(round(channel)) for channel in channels) + (alpha,)


def rgb_to_lab(rgb):
    rgb = rgb[:3]
    def linear(channel):
        channel = channel / 255.0
        return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4

    r, g, b = (linear(x) for x in rgb)
    x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
    y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.00000
    z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883

    def f(t):
        return t ** (1.0 / 3.0) if t > 0.008856 else (7.787 * t + 16.0 / 116.0)

    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def delta_e_2000(lab1, lab2):
    """CIEDE2000（Sharma 等实现口径）。"""
    l1, a1, b1 = lab1
    l2, a2, b2 = lab2
    c1 = math.hypot(a1, b1)
    c2 = math.hypot(a2, b2)
    c_bar = (c1 + c2) / 2.0
    g = 0.5 * (1 - math.sqrt(c_bar ** 7 / (c_bar ** 7 + 25 ** 7)))
    a1p = (1 + g) * a1
    a2p = (1 + g) * a2
    c1p = math.hypot(a1p, b1)
    c2p = math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360
    h2p = math.degrees(math.atan2(b2, a2p)) % 360

    dlp = l2 - l1
    dcp = c2p - c1p
    if c1p * c2p == 0:
        dhp = 0.0
    elif abs(h2p - h1p) <= 180:
        dhp = h2p - h1p
    elif h2p - h1p > 180:
        dhp = h2p - h1p - 360
    else:
        dhp = h2p - h1p + 360
    dhp_big = 2 * math.sqrt(c1p * c2p) * math.sin(math.radians(dhp / 2.0))

    l_bar = (l1 + l2) / 2.0
    c_bar_p = (c1p + c2p) / 2.0
    if c1p * c2p == 0:
        h_bar = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        h_bar = (h1p + h2p) / 2.0
    elif h1p + h2p < 360:
        h_bar = (h1p + h2p + 360) / 2.0
    else:
        h_bar = (h1p + h2p - 360) / 2.0

    t = (1
         - 0.17 * math.cos(math.radians(h_bar - 30))
         + 0.24 * math.cos(math.radians(2 * h_bar))
         + 0.32 * math.cos(math.radians(3 * h_bar + 6))
         - 0.20 * math.cos(math.radians(4 * h_bar - 63)))
    d_theta = 30 * math.exp(-(((h_bar - 275) / 25) ** 2))
    rc = 2 * math.sqrt(c_bar_p ** 7 / (c_bar_p ** 7 + 25 ** 7))
    sl = 1 + (0.015 * (l_bar - 50) ** 2) / math.sqrt(20 + (l_bar - 50) ** 2)
    sc = 1 + 0.045 * c_bar_p
    sh = 1 + 0.015 * c_bar_p * t
    rt = -math.sin(math.radians(2 * d_theta)) * rc
    return math.sqrt(
        (dlp / sl) ** 2 + (dcp / sc) ** 2 + (dhp_big / sh) ** 2
        + rt * (dcp / sc) * (dhp_big / sh)
    )


def looks_color(value):
    return parse_color(value) is not None and (
        isinstance(value, str)
        or (isinstance(value, (list, tuple)) and len(value) >= 3)
    )


#: 0229：看起来是颜色语法的字符串（即使当前解析不了）。用于把「解析失败」
#: 与「根本不是颜色」分开：前者必须记 unverified，⛔ 不许回退成首数字比较。
_COLOR_SYNTAX_RE = re.compile(
    r"^(?:#.*|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\()", re.IGNORECASE)


def looks_color_syntax(value):
    return isinstance(value, str) and bool(_COLOR_SYNTAX_RE.match(value.strip()))


# ── baseline 行 / 容差 / 比较 ────────────────────────────────────────────


def row_id(row):
    raw = first_of(row, ["id", "criteria", "name"])
    return raw if isinstance(raw, str) and raw else None


def family_of_id(identifier):
    if not isinstance(identifier, str):
        return None
    if identifier.endswith("-SPEC"):
        return "SPEC"
    if identifier.endswith("-PARITY"):
        return "PARITY"
    if identifier.endswith("-REG"):
        return "REG"
    if identifier.endswith("-L3") or re.search(r"-L3($|-)", identifier):
        return "L3"
    if re.match(r"^P-D[1-6]($|-)", identifier):
        return "L3"
    return None


def rows_for_fixture(baseline, canonical):
    if baseline is None:
        return None
    rows = baseline_rows_flat(baseline)
    out = []
    for row in rows:
        rf = row_fixture_canonical(row)
        if rf is None:
            # 0232：缺 `fixture` 的行不能默认「对所有夹具成立」；只有显式
            # `scope: all` 才是全局行。其余留空行由调用方记 invalid。
            if row_scope_is_global(row):
                out.append(row)
            continue
        if rf != canonical:
            continue
        out.append(row)
    return out


def _nonempty(value):
    """0233：`0` / `False` / `0.0` 不是「有值」。

    provenance 的 SHA/窗口 ID/时间戳与 review 字段用数值占位符（0）表示
    「未取到」时，旧实现返回 True，能骗过 P-COV-04。
    """
    if value is None:
        return False
    if isinstance(value, bool):
        return value is True
    if isinstance(value, (int, float)):
        return value > 0
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, dict)):
        return bool(value)
    return True


def provenance_problems(row, criterion=None):
    """§2.9 / P-COV-04：provenance 与 review 的完整性。

    0131：采集层以 `coverage.json` 为准（唯一实现），⛔ 不是基线行自报。
    旧实现只看行内 `layer` 字段，行里没写就跳过 review 校验 ⇒ L2-OCR 被静默豁免。
    """
    problems = []
    prov = row.get("provenance")
    if not isinstance(prov, dict):
        return ["provenance 缺失"]
    if not _nonempty(first_of(prov, ["frame_sha256", "frame_sha", "frameSHA256"])):
        problems.append("provenance.frame_sha256 缺失")
    if not _nonempty(first_of(prov, ["window_id", "window", "windowid"])):
        problems.append("provenance.window_id 缺失")
    if not _nonempty(first_of(prov, ["captured_at", "capturedAt", "timestamp"])):
        problems.append("provenance.captured_at 缺失")

    if isinstance(criterion, dict):
        layer = criterion.get("layer_raw")
    else:
        layer = first_of(row, ["collection_layer", "layer", "采集层"])
        if layer is None:
            layer = first_of(prov, ["layer", "collection_layer"])
    layer_text = str(layer or "").replace("`", "").strip()
    if layer_text and layer_text not in COLLECTION_LAYERS:
        problems.append(f"非法采集层 {layer}（只允许 L1→L2 / L2-OCR）")

    if layer_text == "L2-OCR" or row.get("ocr"):
        review = row.get("review")
        if not isinstance(review, dict):
            problems.append("L2-OCR 条目缺 review")
        else:
            if not _nonempty(first_of(review, ["reviewer", "复核人"])):
                problems.append("review.reviewer 缺失")
            if not _nonempty(first_of(review, ["frame_sha256", "frame_sha", "被复核帧"])):
                problems.append("review.frame_sha256 缺失")
            if not _nonempty(first_of(review, ["signed_at", "签字时间", "signature_time"])):
                problems.append("review.signed_at 缺失")

    if not _nonempty(first_of(row, ["fixture_sha256", "sha256"])):
        problems.append("fixture_sha256 缺失")
    return problems


def color_limit_for(tolerance_text):
    """从 `coverage.json` 的「容差」列推出颜色 ΔE 上限。

    `design/0063` §2.3 T4 默认 ΔE≤3，1 px 线放宽到 ≤8。旧实现用基线行里从未
    存在的 `line_1px` 字段判断（`0159`）⇒ 该分支永远不可达。改为按设计原文：
    容差列写 `ΔE≤8` 的判据才放宽。
    """
    text = str(tolerance_text or "")
    for limit in re.findall(r"ΔE\s*[≤<=]\s*(\d+(?:\.\d+)?)", text):
        return float(limit)
    return COLOR_DE_MAX


def tolerance_is_register_only(tolerance_text):
    """容差列显式声明「绝对 px 不跨端比」⇒ 只登记（§2.3 T5）。"""
    text = str(tolerance_text or "")
    return "绝对 px 不跨端比" in text or "不跨端比" in text


def reference_tolerance(reference):
    """0164：从 `reference.tolerance_source` 推颜色容差。

    返回 `((kind, value), source_text)`；source 不可识别时 kind 用哨兵，
    由调用方转 `skipped`，⛔ 不退回设计默认值悄悄判绿。
    """
    if not isinstance(reference, dict):
        return None, None
    raw = reference.get("tolerance_source")
    if not isinstance(raw, str) or not raw.strip():
        return None, None
    source = raw.strip()
    norm = source.lower().replace("-", "_").replace(":", "_")
    if norm in {s.replace("-", "_").replace(":", "_") for s in TOLERANCE_SRC_LINE}:
        return ("color", COLOR_DE_MAX_LINE), source
    if norm in {s.replace("-", "_").replace(":", "_") for s in TOLERANCE_SRC_AREA}:
        return ("color", COLOR_DE_MAX), source
    if norm in {s.replace("-", "_").replace(":", "_") for s in TOLERANCE_SRC_EXPLICIT}:
        value = as_number(reference.get("tolerance"))
        if value is not None:
            return ("color", value), source
        return ("missing-de-tol-value", None), source
    return ("unknown-tolerance-source", None), source


def resolve_tolerance(row, is_color, unit, color_limit=None, reference=None):
    unit = (unit or "").lower()
    # §2.3 T5：绝对 px 一律「仅登记」。基线行即使写了绝对容差，也只能让该量
    # 更严格地保持仅登记，⛔ 不能升级成 pass/fail（0159：T5 两端承诺都不得违背）。
    if unit in ("px", "pt", "absolute"):
        return None
    # 0164：颜色容差先看生产者给的 `reference.tolerance_source`；显式 de-tol 优先
    # 由生产者保证（`explicit` 时 tolerance 已是 --de-tol），这里只负责映射。
    if isinstance(reference, dict):
        ref = reference
    elif isinstance(row, dict):
        ref = None
        for key in ("reference", "sample"):
            if isinstance(row.get(key), dict):
                ref = row[key]
                break
    else:
        ref = None
    if is_color or unit in ("color", "de", "delta_e", "δe"):
        from_reference, _ = reference_tolerance(ref)
        if from_reference is not None:
            return from_reference
    for key in ("tolerance", "tol", "tolerance_value", "threshold"):
        if key not in row or row.get(key) is None:
            continue
        raw = row.get(key)
        if isinstance(raw, dict):
            kind = str(first_of(raw, ["type", "kind", "mode"]) or "").lower()
            value_raw = first_of(raw, ["value", "max", "limit", "delta"])
            number = as_number(value_raw)
            if number is None:
                continue
            if "%" in str(value_raw):
                return ("relative", number / 100.0)
            if kind in ("relative", "rel", "percent", "pct", "ratio"):
                return ("relative", number / 100.0 if number > 1 else number)
            if kind in ("color", "de", "delta_e", "δe"):
                return ("color", number)
            if kind in ("absolute", "abs", "px", "pt"):
                # 走到这里说明 unit 不是 px/pt（已在函数入口拦掉）⇒ 行级绝对容差
                # 只能用于比值量的容差表达；仍按绝对差比较会产生 T5 之外的口径，
                # 因此按相对容差理解会失真，直接拒绝升级。
                return None
            if unit not in ("ratio", "b"):
                # 0188：容差对象没写 type，且量纲单位缺失/未知 ⇒ 不猜比值。
                return (TOLERANCE_UNIT_UNVERIFIED, None)
            return ("relative" if number < 1 else "absolute", number)
        if isinstance(raw, str) and "%" in raw:
            number = as_number(raw)
            if number is not None:
                return ("relative", number / 100.0)
        number = as_number(raw)
        if number is not None:
            if unit in ("ratio", "b"):
                return ("relative", number if number < 1 else number / 100.0)
            if unit in ("color", "de", "delta_e", "δe"):
                # 颜色量纲的裸数值容差就是 ΔE 上限，不属「未知单位」。
                return ("color", number)
            # 0188：单位缺失/未知时，行级容差到底是比值还是绝对 px 无法判定。
            # ⛔ 不默认按 relative；交调用方按「不判」处理。
            return (TOLERANCE_UNIT_UNVERIFIED, None)
    if is_color:
        return ("color", color_limit if color_limit is not None else COLOR_DE_MAX)
    if unit in ("ratio", "b"):
        return ("relative", PARITY_RATIO_TOL)
    # 0188：空串与未知单位（如 `em`、拼写错误）不再回退 T2 ±5%。设计里
    # 「未声明单位」不等于「比值」，缺字段不能落进最宽松的一档。
    return (TOLERANCE_UNIT_UNVERIFIED, None)


def _sample_trace(sample, reference):
    """0164：把 M4 的 `sample.geometry` / `warning_details[erode-skipped]` 透传出去。"""
    trace = {}
    for source in (sample, reference):
        if not isinstance(source, dict):
            continue
        geometry = first_of(source, ["geometry", "sample.geometry"])
        if geometry and "sample_geometry" not in trace:
            trace["sample_geometry"] = geometry
        details = source.get("warning_details")
        if isinstance(details, list):
            erode = [w for w in details if isinstance(w, dict)
                     and str(w.get("code") or "").lower() == "erode-skipped"]
            if erode:
                trace["sample_warnings"] = erode
    return trace


def compare_values(current, expected, row, color_limit=None, reference=None, sample=None):
    unit = first_of(row, ["unit", "units"]) or ""
    both_color = looks_color(current) and looks_color(expected)
    # 0229：两侧都长成颜色语法但当前解析不了时必须记「未比较」，
    # ⛔ 不能落到下面的 `as_number`（那会拿字符串首数字比较或误判 pass）。
    color_like = both_color or (looks_color_syntax(current) and looks_color_syntax(expected))
    is_color = color_like or str(unit).lower() in ("color", "de", "delta_e", "δe") \
        or row.get("kind") == "color"
    if reference is None and isinstance(row, dict):
        for key in ("reference", "sample"):
            if isinstance(row.get(key), dict):
                reference = row[key]
                break
    if sample is None and isinstance(reference, dict):
        sample = reference
    tolerance = resolve_tolerance(row, is_color, str(unit), color_limit, reference)
    trace = _sample_trace(sample, reference)
    ref_tol, ref_source = reference_tolerance(reference)

    if is_color and tolerance and tolerance[0] in TOLERANCE_SRC_MISSING:
        return {
            "status": "skipped",
            "reason": tolerance[0],
            "measured": current,
            "expected": expected,
            "detail": (f"容差来源 {ref_source!r} 无法落成数值 ⇒ "
                       "该颜色未比较（⛔ 不猜限值）"),
            **trace,
        }
    # 0164：有 M4 样本却没有任何容差来源 ⇒ 不拿设计默认值顶替（那会掩盖生产者漏字段）。
    row_has_tolerance = isinstance(row, dict) and any(
        row.get(key) is not None for key in ("tolerance", "tol", "tolerance_value", "threshold"))
    sample_ok = isinstance(sample, dict) and str(sample.get("status") or "").lower() in (
        "ok", "pass", "", "none")
    if is_color and sample_ok and ref_source is None and not row_has_tolerance:
        return {
            "status": "skipped",
            "reason": "missing-tolerance-source",
            "measured": current,
            "expected": expected,
            "detail": ("M4 样本未给 reference.tolerance_source ⇒ 无法按 0164 选容差"
                       "（geometry-line→ΔE≤8 / geometry-area→ΔE≤3 / de-tol 显式）"),
            **trace,
        }

    if color_like and not both_color:
        return {
            "status": "skipped",
            "reason": "unverified-color",
            "measured": current,
            "expected": expected,
            "detail": "两侧都像颜色写法但至少一侧解析失败 ⇒ 未比较（⛔ 不回退首数字）",
            **trace,
        }

    if both_color:
        color_cur = parse_color(current)
        color_exp = parse_color(expected)
        de = delta_e_2000(rgb_to_lab(color_cur), rgb_to_lab(color_exp))
        limit = tolerance[1] if tolerance and tolerance[0] == "color" else \
            (color_limit if color_limit is not None else COLOR_DE_MAX)
        source = ref_source
        # 0229：ΔE 只覆盖 RGB；仅 alpha 不同时 ΔE=0，必须单独比较。
        alpha_diff = abs(color_cur[3] - color_exp[3])
        alpha_ok = alpha_diff <= COLOR_ALPHA_MAX_DIFF
        ok = de <= limit and alpha_ok
        alpha_note = ""
        if not alpha_ok:
            alpha_note = (f"；alpha {color_cur[3]:.3f} vs {color_exp[3]:.3f}"
                          f"（差 {alpha_diff:.3f} > {COLOR_ALPHA_MAX_DIFF:.3f}）")
        return {
            "status": "pass" if ok else "fail",
            "kind": "color",
            "measured": current,
            "expected": expected,
            "delta_e": de,
            "alpha": color_cur[3],
            "alpha_expected": color_exp[3],
            "alpha_diff": alpha_diff,
            "tolerance": {"type": "color", "value": limit},
            "tolerance_source": source,
            "detail": (f"ΔE2000 {de:.3f} {'≤' if de <= limit else '>'} {fmt_num(limit)}"
                       + (f"（来源 {source}）" if source else "")
                       + alpha_note),
            **trace,
        }

    cur_num = as_number(current)
    exp_num = as_number(expected)
    # 0140：缺值不是「不适用」。`None` 参与比较必须 fail（N3 负对照才能落地）。
    if current is None or expected is None:
        return {
            "status": "fail",
            "reason": "missing-value",
            "measured": current,
            "expected": expected,
            "detail": f"缺值无法比较：measured={current!r}、expected={expected!r}",
        }
    if cur_num is None or exp_num is None:
        return {
            "status": "skipped",
            "reason": "type-mismatch",
            "measured": current,
            "expected": expected,
            "detail": f"值类型无法比较（measured={current!r}, expected={expected!r}）",
        }

    if tolerance and tolerance[0] == TOLERANCE_UNIT_UNVERIFIED:
        # 0188：单位缺失/未知 ⇒ 容差口径不可判定，只登记。
        return {
            "status": "register_only",
            "reason": "unknown-unit",
            "measured": cur_num,
            "expected": exp_num,
            "unit": str(unit),
            "detail": "单位缺失/未知 ⇒ 容差口径无法判定，仅登记（⛔ 不默认 ±5%）",
        }

    if tolerance is None:
        return {
            "status": "register_only",
            "reason": "no-tolerance",
            "measured": cur_num,
            "expected": exp_num,
            "detail": "未给容差：绝对 px 按 §2.3 T5 仅登记，⛔ 不进 pass/fail",
        }

    kind, limit = tolerance
    diff = abs(cur_num - exp_num)
    if kind == "relative":
        rel = diff / abs(exp_num) if exp_num != 0 else diff
        ok = rel <= limit
        detail = (f"{fmt_num(cur_num)} vs 基线 {fmt_num(exp_num)} ⇒ "
                  f"相对差 {rel * 100:.3f}% {'≤' if ok else '>'} {limit * 100:.3f}%")
        return {
            "status": "pass" if ok else "fail",
            "kind": "relative",
            "measured": cur_num, "expected": exp_num, "diff": diff, "rel_diff": rel,
            "tolerance": {"type": "relative", "value": limit},
            "detail": detail,
        }

    ok = diff <= limit
    return {
        "status": "pass" if ok else "fail",
        "kind": "absolute",
        "measured": cur_num, "expected": exp_num, "diff": diff,
        "tolerance": {"type": "absolute", "value": limit},
        "detail": f"{fmt_num(cur_num)} vs 基线 {fmt_num(exp_num)} ⇒ "
                  f"差 {fmt_num(diff)} {'≤' if ok else '>'} {fmt_num(limit)}",
    }


def metrics_index(measured):
    """measured.json 里的当前值：metrics 字典/数组，或 checks 带 value 的条目。

    P1-5/P1-6：除 `value`/`unit` 外保留 `sample`/`reference`/`source`/`hex`/`lab`，
    否则颜色分量的 M4 几何与容差来源在进入 `compare_values` 前就丢了。
    """
    def entry_of(value):
        if isinstance(value, dict):
            entry = {"value": value.get("value"), "unit": value.get("unit")}
            for key in ("sample", "reference", "source", "hex", "lab",
                        "status", "reason", "missing"):
                if key in value:
                    entry[key] = value.get(key)
            return entry
        return {"value": value, "unit": None}

    index = {}
    raw = measured.get("metrics")
    if isinstance(raw, dict):
        for key, value in raw.items():
            index[key] = entry_of(value)
    elif isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            identifier = first_of(item, ["id", "name"])
            if isinstance(identifier, str):
                index[identifier] = entry_of(item)
    for item in measured.get("checks") or []:
        if not isinstance(item, dict):
            continue
        identifier = first_of(item, ["id", "name"])
        if isinstance(identifier, str) and item.get("value") is not None:
            index.setdefault(identifier, entry_of(item))
    return index


# P1-5：新公共 metrics 契约里的指标名。用于在字段被整个删掉时仍能给出
# `missing-metric:<名>`，而不是退回含糊的 `missing-component`。
METRIC_NAMES = {
    "content_left_px", "background_top_px", "BAND_px", "BAND_over_B",
    "W_col_over_B", "roi_width_px", "data_row_height_px", "data_row_heights_px",
    "data_row_count", "header_row_height_px", "header_measured_from",
    "header_cells", "header_font_weight", "ratio_to_first",
    "first_data_cell_rect", "C_quote", "C_code", "C_th", "C_link", "C_rule",
    "rule_border_top_width_px",
}
# P1-5：基线分量名与新公共 metrics 名的对照。只做**同义映射**，不改变量纲；
# `H_table/B` 这类比值仍由 `metric_details` 提供，避免把 px 直接当比值比。
METRIC_COMPONENT_ALIASES = {
    "color/C_table_head": ("C_th",),
    "C_table_head": ("C_th",),
    "color/C_quote_bar": ("C_quote",),
    "C_quote_bar": ("C_quote",),
    "color/C_code": ("C_code",),
    "C_code": ("C_code",),
    "color/C_link": ("C_link",),
    "C_link": ("C_link",),
    "color/C_rule": ("C_rule",),
    "C_rule": ("C_rule",),
}
# 数组指标（`header_cells` / `ratio_to_first`）的基线分量可能按路径寻址，
# 例如 `header_cells[0].font_weight`、`columns[2].ratio_to_first`。
METRIC_ARRAY_ALIASES = {
    "columns": "ratio_to_first",
    "table_columns": "ratio_to_first",
}


def _metric_candidates(key):
    """给一个分量名列出可能的 metrics 键；顺序即优先级。"""
    candidates = [key]
    if key.startswith("color/"):
        candidates.append(key[len("color/"):])
    for candidate in list(candidates):
        for alias in METRIC_COMPONENT_ALIASES.get(candidate, ()):
            if alias not in candidates:
                candidates.append(alias)
    return candidates


def metric_component_value(metrics, key):
    """P1-5：从 `measured.metrics` 取分量；返回 `(值, 命中键, 指标条目)`。

    支持三种键：公共指标名（`data_row_height_px`/`C_th`）、颜色别名
    （`color/C_table_head`）、数组路径（`header_cells[0].font_weight`）。
    指标键存在但值为 `null` 时仍返回条目（值为 `None`），调用方据此判
    `missing-metric`，⛔ 不回退到 `metric_details` 掩盖生产者给的空值。
    """
    if not isinstance(metrics, dict):
        return None, None, None
    for candidate in _metric_candidates(key):
        entry = metrics.get(candidate)
        if isinstance(entry, dict):
            return entry.get("value"), candidate, entry
    match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\](?:\.(.+))?$", str(key))
    if not match:
        return None, None, None
    base, index_text, field = match.group(1), int(match.group(2)), match.group(3)
    base = METRIC_ARRAY_ALIASES.get(base, base)
    entry = metrics.get(base)
    sequence = entry.get("value") if isinstance(entry, dict) else None
    if not isinstance(sequence, list) or index_text >= len(sequence):
        return None, base, entry if isinstance(entry, dict) else None
    value = sequence[index_text]
    if field:
        for part in field.split("."):
            if isinstance(value, dict) and part in value:
                value = value.get(part)
            else:
                return None, f"{base}[{index_text}].{field}", entry
    if value is None:
        return None, f"{base}[{index_text}]" + (f".{field}" if field else ""), entry
    return value, f"{base}[{index_text}]" + (f".{field}" if field else ""), entry


def metric_is_domain(metrics, key):
    """该分量名是否属于新 `metrics` 契约（用于区分 `missing-metric` 与旧缺项）。"""
    if any(candidate in METRIC_NAMES for candidate in _metric_candidates(key)):
        return True
    match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\[", str(key))
    if match and METRIC_ARRAY_ALIASES.get(match.group(1), match.group(1)) in METRIC_NAMES:
        return True
    if not isinstance(metrics, dict):
        return False
    return any(candidate in metrics for candidate in _metric_candidates(key))


def component_index(measured):
    """`measured.metric_details` 里的分量：{判据 ID: {分量名: 值}}。

    0167：颜色等分量只写在这里，旧 `metrics_index` 从不读 ⇒ 颜色从未被比较。
    P1-5：它降级为**回退源**；同类分量若已进 `measured.metrics`，由
    `metric_component_value` 优先读取，这里只在指标缺席时兜底。
    """
    index = {}
    raw = measured.get("metric_details")
    if isinstance(raw, dict):
        for key, value in raw.items():
            if isinstance(value, dict):
                index[key] = value
    return index


def _component_is_color(key, value):
    name = str(key or "")
    return ("color" in name.lower() or name.startswith("C_") or looks_color(value))


def audit_components(identifier, components, expected_components, criterion, metrics=None):
    """把一个判据的分量集合与基线分量逐项比对（0139 / 0167 / P1-5）。

    读取优先级：`measured.metrics` → `measured.metric_details`（回退，detail 注明）。
    两处都没有 ⇒ `skipped(missing-metric:<名>)`，⛔ 不因主值 pass 而隐去。

    返回 (items, informational)：
    - 基线有、当轮无 ⇒ skipped（指标域用 `missing-metric`，旧比值用 `missing-component`）
    - 两边都有 ⇒ `compare_values`（颜色走 ΔE2000，并透传 M4 几何/容差来源）
    - 当轮有、基线无：**颜色**分量 ⇒ `skipped(no-baseline-component)`（不许静默）；
      其它辅助分量只记入 informational（不改变家族状态，避免把 bookkeeping 当判据）。
    - 颜色分量解析失败 ⇒ `skipped(unreadable-color-component)`。
    """
    items = []
    informational = []
    expected_components = expected_components if isinstance(expected_components, dict) else {}
    components = components if isinstance(components, dict) else {}
    color_limit = color_limit_for((criterion or {}).get("tolerance"))
    register_only = tolerance_is_register_only((criterion or {}).get("tolerance"))
    for key in sorted(expected_components):
        expected = expected_components.get(key)
        current, metric_name, metric_entry = metric_component_value(metrics, key)
        if current is not None:
            source = f"measured.metrics.{metric_name}"
            source_note = f"（来源 {source}）"
        elif metric_entry is None and key in components and components.get(key) is not None:
            current = components.get(key)
            source = "measured.metric_details"
            source_note = "（来源 measured.metric_details，metrics 缺该键时回退）"
        else:
            missing_reason = (f"missing-metric:{metric_name or key}"
                              if metric_entry is not None
                              or metric_is_domain(metrics, key) else "missing-component")
            items.append({
                "id": f"{identifier}::{key}",
                "status": "skipped",
                "reason": missing_reason,
                "detail": (f"当轮缺度量 {key}（metrics 与 metric_details 均无可用值）"
                           "⇒ 该维未比较（⛔ 不当作通过）"),
                "component": key,
            })
            continue
        if _component_is_color(key, expected) and parse_color(current) is None:
            items.append({
                "id": f"{identifier}::{key}",
                "status": "skipped",
                "reason": "unreadable-color-component",
                "detail": f"颜色分量 {key} 当轮值无法解析（{current!r}）⇒ 该维未比较",
                "component": key,
                "source": source,
            })
            continue
        row = {"unit": "color" if _component_is_color(key, expected) else "ratio"}
        if register_only:
            items.append({
                "id": f"{identifier}::{key}",
                "status": "register_only",
                "reason": "t5-register-only",
                "detail": "设计容差列声明绝对 px 不跨端比 ⇒ 只登记" + source_note,
                "component": key,
                "source": source,
                "measured": current, "expected": expected,
            })
            continue
        reference = None
        sample = None
        if isinstance(metric_entry, dict):
            sample = metric_entry.get("sample")
            reference = metric_entry.get("reference") or sample
        outcome = compare_values(current, expected, row, color_limit,
                                 reference=reference, sample=sample)
        outcome["id"] = f"{identifier}::{key}"
        outcome["component"] = key
        outcome["source"] = source
        if isinstance(outcome.get("detail"), str):
            outcome["detail"] += source_note
        items.append(outcome)
    for key in sorted(set(components) - set(expected_components)):
        value = components.get(key)
        if _component_is_color(key, value):
            items.append({
                "id": f"{identifier}::{key}",
                "status": "skipped",
                "reason": "no-baseline-component",
                "detail": f"颜色分量 {key} 当轮有值（{value!r}）但基线没有期望 ⇒ "
                          "未比较（⛔ 不当作通过；补采 L1 后复跑）",
                "component": key,
            })
        else:
            informational.append({"component": key, "value": value})
    return items, informational


def iter_named_items(raw):
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                yield item
            else:
                yield {"id": str(item), "value": item}
    elif isinstance(raw, dict):
        for key, value in raw.items():
            if isinstance(value, dict):
                item = dict(value)
                item.setdefault("id", key)
                yield item
            else:
                yield {"id": key, "value": value}


def evaluate_declared_item(item):
    """把测量阶段给出的 SPEC 检查项归一成 pass/fail/skipped。"""
    identifier = first_of(item, ["id", "name"])
    raw_status = first_of(item, ["status", "result", "state"])
    if isinstance(raw_status, bool):
        status = "pass" if raw_status else "fail"
        detail = item.get("detail") or ("检查项自报通过" if raw_status else "检查项自报失败")
    elif isinstance(raw_status, str):
        normalized = raw_status.strip().lower()
        mapping = {
            "pass": "pass", "ok": "pass", "green": "pass", "true": "pass", "通过": "pass",
            "fail": "fail", "red": "fail", "false": "fail", "失败": "fail",
            "skip": "skipped", "skipped": "skipped", "not-run": "skipped",
            "未测": "skipped", "n/a": "n/a",
        }
        status = mapping.get(normalized, "skipped")
        detail = item.get("detail") or f"测量阶段自报 {raw_status}"
    else:
        ok = first_of(item, ["ok", "passed"])
        if isinstance(ok, bool):
            status = "pass" if ok else "fail"
            detail = item.get("detail") or ("检查项 ok" if ok else "检查项 not ok")
        elif item.get("value") is not None and item.get("expected") is not None:
            outcome = compare_values(item.get("value"), item.get("expected"), item)
            # 0227：显式映射必须写在 `**outcome` 之后，否则 `register_only`
            # 会覆盖掉这里「只登记 ⇒ skipped」的判定；reason 保留可追溯。
            mapped = "skipped" if outcome["status"] == "register_only" else outcome["status"]
            return {
                **outcome,
                "id": identifier,
                "status": mapped,
                "reason": outcome.get("reason") or (
                    "register-only" if outcome["status"] == "register_only" else None),
                "detail": outcome.get("detail", ""),
            }
        else:
            status = "skipped"
            detail = "检查项既无 status 也无 value/expected"
    return {
        "id": identifier,
        "status": status,
        "detail": detail,
        "value": item.get("value"),
        "expected": item.get("expected"),
    }


def family_counts(items):
    counts = {"pass": 0, "fail": 0, "skipped": 0, "n/a": 0,
              "register_only": 0, "invalid": 0}
    for item in items:
        key = item.get("status")
        if key in counts:
            counts[key] += 1
    return counts


def family_status(items):
    """0264：`invalid` 先于 `fail`。

    覆盖无效时整轮退出码已是 20（`coverage_invalid`），族状态若仍写 `fail`
    会与整体结论词面矛盾，下游只读族状态会回到「产品红」的旧结论。
    """
    statuses = [item.get("status") for item in items]
    if "invalid" in statuses:
        return "invalid"
    if "fail" in statuses:
        return "fail"
    if not items:
        return "n/a"
    if "skipped" in statuses:
        return "skipped"
    if "pass" in statuses:
        return "pass"
    if "register_only" in statuses:
        return "register_only"
    return "n/a"


# ── coverage.json：设计声明的判据清单（0136 / 0139 / 0166）───────────────


def load_coverage(path):
    """读 `coverage.json`；返回 (data, reason)。缺文件/畸形都算 coverage 不可用。"""
    if not path:
        return None, "未指定 coverage.json"
    if not os.path.isfile(path):
        return None, f"文件不存在：{path}"
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as exc:
        return None, f"解析失败：{exc}"
    if not isinstance(data, dict) or not isinstance(data.get("criteria"), list):
        return None, "顶层不是对象或缺 criteria 数组"
    if not data["criteria"]:
        return None, "criteria 为空"
    return data, None


def criterion_layer_ok(criterion):
    """§2.9：基线只接受 L1→L2 / L2-OCR。

    `P-MERMAID-01-CENTER-PARITY` 的 `layer_raw` 是 `` `L2-PIX`（有界） ``，
    不能进基线（0160 §4）⇒ 保留在清单里但标 not eligible，⛔ 不静默丢弃。
    """
    raw = str((criterion or {}).get("layer_raw") or "")
    normalized = raw.replace("`", "").strip()
    return normalized in COLLECTION_LAYERS


def declared_atoms(coverage, canonical, family):
    """按设计声明的判据清单，返回该夹具该族的原子列表。

    每项：{"id", "criterion", "family", "eligible"}。`-PARITY` 的 eligible 由
    §2.9 采集层决定；其它族恒 True。
    """
    out = []
    if not isinstance(coverage, dict):
        return out
    fixture_name = f"{canonical}.md"
    for criterion in coverage.get("criteria") or []:
        if not isinstance(criterion, dict):
            continue
        if criterion.get("family") != family:
            continue
        fixtures = criterion.get("fixtures") or []
        if fixture_name not in fixtures:
            continue
        expected_ids = criterion.get("expanded_ids") or []
        if not expected_ids:
            expected_ids = [criterion.get("id")]
        for atom in expected_ids:
            if not atom:
                continue
            eligible = True if family != "PARITY" else criterion_layer_ok(criterion)
            out.append({
                "id": atom,
                "criterion": criterion,
                "family": family,
                "eligible": eligible,
            })
    return out


def coverage_report(atoms, items):
    """声明 vs 实测产出 vs 缺席：缺席必须点名（0136 P6）。

    ⚠️「产出」只算当轮真的量到的：`skipped(no-measurement)` 虽然有条目，但它是
    「清单里有、数据里没有」，必须计入 `missing`。否则摘要会把「6 条声明里 5 条
    没测」写成「6/6 全产出」，与 P6「缺席可见」自相矛盾。
    """
    top_level = [i for i in items if not i.get("parent")]
    by_id = {}
    for item in top_level:
        by_id.setdefault(item.get("id"), item)
    declared_ids = [atom["id"] for atom in atoms]

    def _unmeasured(identifier):
        item = by_id.get(identifier)
        return item is None or (item.get("status") == "skipped"
                                and item.get("reason") == "no-measurement")

    missing = [identifier for identifier in declared_ids if _unmeasured(identifier)]
    extra = sorted(set(by_id) - set(declared_ids))
    component_items = len(items) - len(top_level)
    return {
        "declared": len(declared_ids),
        "produced": len(declared_ids) - len(missing),
        "missing": missing,
        "extra": extra,
        "component_items": component_items,
    }


def _skip_item(identifier, reason, detail, **fields):
    item = {"id": identifier, "status": "skipped", "reason": reason, "detail": detail}
    item.update(fields)
    return item


# ── 四族构建 ─────────────────────────────────────────────────────────────


def build_parity(canonical, baseline, baseline_reason, env_state, measured,
                 current_sha, coverage=None, coverage_reason=None):
    """以 `coverage.json` 的 `-PARITY` 原子为清单，逐条产出条目（0136/0139）。

    旧实现只遍历基线行 ⇒ 没有基线的 34 条判据在报告里根本不出现。现在：
    清单里的每个原子都必然产出一条（pass/fail/skipped），缺席可见且不判绿。
    """
    atoms = declared_atoms(coverage, canonical, "PARITY")
    engine = _compare_baseline_rows(canonical, baseline, baseline_reason, env_state,
                                    measured, current_sha, coverage=coverage)
    by_id = {}
    for item in engine.get("items") or []:
        # 分量条目挂在父判据下（id 形如 `P-X-PARITY::C_bar`）。
        by_id.setdefault(item.get("parent") or item.get("id"), []).append(item)

    items = []
    if not atoms:
        items.extend(engine.get("items") or [])
    for atom in atoms:
        identifier = atom["id"]
        existing = by_id.pop(identifier, [])
        if not atom["eligible"]:
            items.append(_skip_item(
                identifier, "layer-not-baseline-eligible",
                f"采集层 {atom['criterion'].get('layer_raw')!r} 不在 §2.9 允许的 "
                "L1→L2 / L2-OCR 内 ⇒ 该判据不进基线，也不在本轮比较（⛔ 不当作通过）",
                layer_raw=atom["criterion"].get("layer_raw"),
            ))
            continue
        if existing:
            items.extend(existing)
            continue
        if baseline is None:
            items.append(_skip_item(
                identifier, "no-baseline",
                "没有 L1 实测基线 ⇒ 已登记但未比较（⛔ 不当作通过）",
            ))
        elif coverage is None:
            items.append(_skip_item(
                identifier, "coverage-unavailable",
                f"coverage.json 不可用（{coverage_reason or '未知'}）⇒ 无法建立清单",
            ))
        else:
            items.append(_skip_item(
                identifier, "no-baseline-row",
                "coverage.json 声明了该 -PARITY 判据，但 baseline.json 没有对应行 ⇒ "
                "该维未比较（⛔ 不当作通过；补采 L1 后复跑）",
            ))
    # 基线里出现、但清单未声明的行：不静默丢弃。
    for identifier, leftovers in by_id.items():
        if identifier is None:
            items.extend(leftovers)
            continue
        for item in leftovers:
            if item.get("status") == "invalid":
                items.append(item)
                continue
            wrapped = dict(item)
            wrapped.update(
                status="skipped",
                reason="undeclared-baseline-row",
                detail="baseline.json 有该行，但 coverage.json 未声明 ⇒ 不参与判绿",
            )
            items.append(wrapped)

    family = {
        "status": family_status(items),
        "reason": None,
        "detail": engine.get("detail") or "",
        "items": items,
        "counts": family_counts(items),
        "baseline": engine.get("baseline") or {
            "path_present": baseline is not None,
            "reason": baseline_reason,
            "stale": False,
            "stale_detail": None,
        },
        "coverage": coverage_report(atoms, items),
    }
    if family["status"] == "skipped":
        reasons = sorted({i.get("reason") for i in items
                          if i.get("status") == "skipped" and i.get("reason")})
        family["reason"] = "+".join(reasons) if reasons else "partial"
        details = []
        for item in items:
            if item.get("status") != "skipped":
                continue
            text = item.get("detail") or ""
            if text and text not in details:
                details.append(text)
        family["detail"] = "；".join(details)[:400]
    return family


def _compare_baseline_rows(canonical, baseline, baseline_reason, env_state, measured,
                           current_sha, coverage=None):
    family = {
        "status": "n/a",
        "reason": None,
        "detail": "",
        "items": [],
        "counts": {},
        "baseline": {
            "path_present": baseline is not None,
            "reason": baseline_reason,
            "stale": False,
            "stale_detail": None,
        },
    }
    if baseline is None:
        family.update(
            status="skipped",
            reason="no-baseline",
            detail="没有 L1 实测基线：-PARITY 不比较、不判绿（⛔ skipped 不是 pass）",
        )
        family["counts"] = family_counts([])
        return family

    rows = rows_for_fixture(baseline, canonical)
    # 0232：缺 `fixture` 且未声明 `scope: all` 的行不能静默丢弃，也不能当全局行
    # 套到每个夹具；记 invalid 让 P-COV-04 / coverage_invalid 承接。
    for row in baseline_rows_flat(baseline):
        if row_fixture_canonical(row) is not None or row_scope_is_global(row):
            continue
        family["items"].append({
            "id": row_id(row),
            "status": "invalid",
            "detail": ("baseline 行缺/非法 fixture 且未声明 scope: all ⇒ 无法归属夹具"
                       "（§2.9 / P-COV-04）"),
        })
    if not baseline_rows_flat(baseline):
        family.update(
            status="skipped",
            reason="no-baseline",
            detail="baseline.json 为空文件：等价于没有 L1 实测基线，-PARITY 不判绿",
        )
        family["counts"] = family_counts([])
        return family
    parity_rows = []
    for row in rows:
        identifier = row_id(row)
        fam = family_of_id(identifier)
        if fam == "PARITY":
            parity_rows.append(row)
        elif fam in ("SPEC", "REG", "L3"):
            # §2.9：基线只允许 -PARITY；混入别的族 ⇒ P-COV-04 红。
            family["items"].append({
                "id": identifier,
                "status": "invalid",
                "detail": f"baseline.json 只允许 -PARITY，发现 -{fam} 行（§2.9 / P-COV-04）",
            })
        elif identifier:
            family["items"].append({
                "id": identifier,
                "status": "invalid",
                "detail": "无法识别的判据后缀（只允许 -PARITY）",
            })

    if not parity_rows and not family["items"]:
        family.update(
            status="skipped",
            reason="no-parity-rows",
            detail=f"baseline.json 存在，但没有夹具 {canonical} 的 -PARITY 行",
        )
        family["counts"] = family_counts(family["items"])
        return family

    metrics = metrics_index(measured)
    components = component_index(measured)
    criteria = {}
    if isinstance(coverage, dict):
        for criterion in coverage.get("criteria") or []:
            if not isinstance(criterion, dict):
                continue
            for atom in criterion.get("expanded_ids") or []:
                criteria[atom] = criterion
    stale_any = False
    for row in parity_rows:
        identifier = row_id(row)
        item = {"id": identifier, "status": "skipped", "reason": None, "detail": ""}
        if not identifier:
            item.update(status="invalid", detail="baseline 行没有 id")
            family["items"].append(item)
            continue

        problems = provenance_problems(row, criteria.get(identifier))
        row_sha = first_of(row, ["fixture_sha256", "sha256"])
        row_sha = row_sha if isinstance(row_sha, str) and row_sha else None
        if row_sha is None:
            problems.append("fixture_sha256 缺失")
        if problems:
            # P-COV-04：该条不参与比对，整轮覆盖无效。
            item.update(status="invalid", detail="；".join(problems))
            family["items"].append(item)
            continue

        if current_sha is None:
            item.update(status="skipped", reason="unverifiable-sha",
                        detail="拿不到当前夹具 sha256，无法判断基线是否过期")
            family["items"].append(item)
            continue

        if row_sha != current_sha:
            stale_any = True
            item.update(
                status="skipped", reason="stale-baseline",
                detail=(f"基线过期：fixture_sha256 记录 {row_sha[:12]}…，"
                        f"当前夹具 {current_sha[:12]}…；⛔ 不静默比较"),
                expected_sha=row_sha, current_sha=current_sha,
            )
            family["items"].append(item)
            continue

        row_status = str(row.get("status") or "baseline").strip().lower()
        if row_status == "invalid":
            item.update(status="invalid", detail="baseline 行自报 invalid")
            family["items"].append(item)
            continue
        if row_status == "register_only":
            metric = metrics.get(identifier, {})
            item.update(status="register_only",
                        detail="baseline 行 status=register_only：只登记",
                        measured=metric.get("value"), expected=row.get("value"))
            family["items"].append(item)
            continue

        if env_state != "pass":
            item.update(status="skipped", reason=f"env-{env_state}",
                        detail=f"环境闸门未通过（{env_state}）⇒ -PARITY 不比较")
            family["items"].append(item)
            continue

        metric = metrics.get(identifier)
        if metric is None or metric.get("value") is None:
            item.update(status="skipped", reason="no-measurement",
                        detail="measured.json 没有该判据的当轮值 ⇒ 无法比较")
            family["items"].append(item)
            continue

        criterion = criteria.get(identifier)
        color_limit = color_limit_for((criterion or {}).get("tolerance"))
        # 0188：容差不能只看基线行。单位以当轮 metric 为准，基线行缺单位时补齐；
        # 两边都声明却不同 ⇒ invalid（否则容差会在错误量纲上判绿/判红）。
        metric_unit = str(metric.get("unit") or "").strip()
        row_unit = str(row.get("unit") or "").strip()
        if metric_unit and row_unit and metric_unit.lower() != row_unit.lower():
            item.update(
                status="invalid",
                detail=f"单位不一致：基线 {row_unit!r} vs 当轮 {metric_unit!r}（0188）",
            )
            family["items"].append(item)
            continue
        compare_row = dict(row)
        if not compare_row.get("unit") and metric_unit:
            compare_row["unit"] = metric_unit
        if tolerance_is_register_only((criterion or {}).get("tolerance")):
            item.update(
                status="register_only", reason="t5-register-only",
                detail="设计容差列声明绝对 px 不跨端比 ⇒ 只登记，⛔ 不进 pass/fail",
                measured=metric.get("value"), expected=row.get("value"),
            )
            family["items"].append(item)
            continue
        outcome = compare_values(
            metric.get("value"), row.get("value"), compare_row, color_limit,
            reference=metric.get("reference") or metric.get("sample"),
            sample=metric.get("sample"))
        item.update(outcome)
        item["id"] = identifier
        item["unit"] = metric.get("unit") or row.get("unit")
        item["provenance"] = row.get("provenance")
        item["criterion_tolerance"] = (criterion or {}).get("tolerance")
        family["items"].append(item)

        # 0139 / 0167：分量（含颜色）逐项比对，缺项可见。
        component_items, informational = audit_components(
            identifier,
            components.get(identifier),
            row.get("components") if isinstance(row.get("components"), dict) else {},
            criterion,
            metrics=metrics,
        )
        if informational:
            item["uncompared_components"] = informational
        for component_item in component_items:
            component_item["parent"] = identifier
            family["items"].append(component_item)

    family["baseline"]["stale"] = stale_any
    if stale_any:
        family["baseline"]["stale_detail"] = (
            "夹具 sha256 与基线记录不一致；按 §2.9 / P-ENV-05 必须重采 L1，"
            "⛔ 不得静默比较或回填"
        )

    family["status"] = family_status(family["items"])
    family["counts"] = family_counts(family["items"])
    if family["status"] == "skipped":
        reasons = sorted({item.get("reason") for item in family["items"]
                          if item.get("status") == "skipped" and item.get("reason")})
        family["reason"] = "+".join(reasons) if reasons else "partial"
        family["detail"] = "；".join(
            item["detail"] for item in family["items"] if item.get("status") == "skipped"
        )[:400]
    return family


def build_spec(canonical, measured, env_state, coverage=None, coverage_reason=None):
    """以 `coverage.json` 的 `-SPEC` 原子为清单（0136）。

    旧实现按 measured 里**已有**的检查项逐条评估 ⇒ 少产的判据在报告里不出现。
    现在清单里的每个原子都有一条：没产出 ⇒ `skipped(no-measurement)`。
    """
    has_key = "spec_checks" in measured
    declared = measured.get("spec_checks")
    checks = measured.get("checks")
    if not has_key and isinstance(checks, list):
        declared = [c for c in checks
                    if isinstance(c, dict) and family_of_id(first_of(c, ["id", "name"])) == "SPEC"]
        has_key = bool(declared)

    measured_items = {}
    for raw in iter_named_items(declared or []):
        identifier = first_of(raw, ["id", "name"])
        if identifier:
            measured_items.setdefault(identifier, raw)

    atoms = declared_atoms(coverage, canonical, "SPEC")
    items = []
    if atoms:
        for atom in atoms:
            identifier = atom["id"]
            raw = measured_items.get(identifier)
            if raw is None:
                items.append(_skip_item(
                    identifier, "no-measurement",
                    "coverage.json 声明了该 -SPEC 判据，但 measured.spec_checks 没有产出 ⇒ "
                    "该维未验证（⛔ 不当作通过）",
                ))
                continue
            evaluated = evaluate_declared_item(raw)
            evaluated["id"] = identifier
            if env_state != "pass":
                evaluated.update(
                    status="skipped",
                    reason=f"env-{env_state}",
                    detail=f"环境闸门未通过（{env_state}）⇒ 同端合规结论不作数",
                )
            items.append(evaluated)
        for identifier in sorted(set(measured_items) - {a["id"] for a in atoms}):
            items.append(_skip_item(
                identifier, "undeclared-spec-check",
                "measured 产出了该 -SPEC 检查项，但 coverage.json 未声明 ⇒ 不参与判绿",
            ))
        return {
            "status": family_status(items), "reason": None,
            "detail": "", "items": items, "counts": family_counts(items),
            "coverage": coverage_report(atoms, items),
        }

    # 清单不可用：退回旧行为，但把原因写出来（⛔ 不假装通过）。
    if declared is None:
        # 0184：与「清单为空」统一为 `skipped`（未执行），不再一条 n/a 一条
        # skipped 两种词面描述同一件事。
        return {
            "status": "skipped", "reason": "coverage-unavailable",
            "detail": f"coverage.json 不可用（{coverage_reason or '未知'}），且 measured 未提供 -SPEC 检查项",
            "items": [], "counts": family_counts([]),
            "coverage": {"declared": 0, "produced": 0, "missing": [],
                         "extra": [], "component_items": 0},
        }
    for raw in iter_named_items(declared):
        identifier = first_of(raw, ["id", "name"])
        if family_of_id(identifier) != "SPEC":
            items.append({"id": identifier, "status": "invalid",
                          "detail": "非 -SPEC 后缀混入 SPEC 族（§5.1）"})
            continue
        evaluated = evaluate_declared_item(raw)
        evaluated["id"] = identifier
        if env_state != "pass":
            evaluated.update(
                status="skipped",
                reason=f"env-{env_state}",
                detail=f"环境闸门未通过（{env_state}）⇒ 同端合规结论不作数",
            )
        items.append(evaluated)
    if not items:
        return {
            "status": "skipped", "reason": "no-spec-checks",
            "detail": "spec_checks 为空", "items": [], "counts": family_counts([]),
        }
    return {
        "status": family_status(items), "reason": None,
        "detail": "", "items": items, "counts": family_counts(items),
    }


def build_register(canonical, measured, coverage=None):
    """登记族：按 `coverage.json` 的 `-REG` 原子清单，⛔ 永不产出 pass（0159）。"""
    sources = []
    if "register" in measured:
        sources.append(measured.get("register"))
    metrics = measured.get("metrics")
    if isinstance(metrics, dict):
        sources.append({k: v for k, v in metrics.items()
                        if family_of_id(k) == "REG"})
    checks = measured.get("checks")
    if isinstance(checks, list):
        sources.append([c for c in checks if isinstance(c, dict)
                        and family_of_id(first_of(c, ["id", "name"])) == "REG"])
    measured_values = {}
    for src in sources:
        for raw in iter_named_items(src):
            identifier = first_of(raw, ["id", "name"])
            if family_of_id(identifier) != "REG":
                continue
            measured_values.setdefault(identifier, raw)

    atoms = declared_atoms(coverage, canonical, "REG")
    items = []
    if atoms:
        for atom in atoms:
            identifier = atom["id"]
            # 0185：coverage 的 REG 判据里混入非 -REG 原子时必须判 invalid，
            # 否则错误清单会被静默登记成 register_only，永远进不了 coverage_invalid。
            if family_of_id(identifier) != "REG":
                items.append({
                    "id": identifier,
                    "status": "invalid",
                    "detail": "非 -REG 后缀混入 REG 族（§5.1）",
                })
                continue
            raw = measured_values.get(identifier)
            value = None
            detail = "仅登记，⛔ 不进 pass/fail"
            reason = "t5-register-only"
            if raw is None:
                detail += "（measured 未产出该登记量）"
                reason = "no-measurement"
            else:
                value = raw.get("value") if isinstance(raw, dict) else raw
            items.append({
                "id": identifier,
                "status": "register_only",
                "reason": reason,
                "detail": detail,
                "value": value,
                "criterion_tolerance": atom["criterion"].get("tolerance"),
                "criterion_observable": atom["criterion"].get("observable"),
            })
        for identifier in sorted(set(measured_values) - {a["id"] for a in atoms}):
            items.append(_skip_item(
                identifier, "undeclared-register-item",
                "measured 产出了该 -REG 登记量，但 coverage.json 未声明",
            ))
        return {
            "status": family_status(items), "detail": "",
            "items": items, "counts": family_counts(items),
            "coverage": coverage_report(atoms, items),
        }

    for identifier, raw in measured_values.items():
        value = raw.get("value") if isinstance(raw, dict) else raw
        items.append({
            "id": identifier,
            "status": "register_only",
            "reason": "t5-register-only",
            "detail": "仅登记，⛔ 不进 pass/fail",
            "value": value,
        })
    if not items:
        return {
            "status": "n/a", "detail": "该夹具没有 -REG 登记量",
            "items": [], "counts": family_counts([]),
        }
    return {
        "status": family_status(items), "detail": "",
        "items": items, "counts": family_counts(items),
    }


def build_l3(canonical, measured, coverage=None):
    """L3 只能人验：按 `coverage.json` 的 L3 原子清单，全部 skipped（0136）。"""
    seen = set()
    items = []
    atoms = declared_atoms(coverage, canonical, "L3")
    for atom in atoms:
        identifier = atom["id"]
        if identifier in seen:
            continue
        seen.add(identifier)
        # 0185：L3 判据清单里混入非 L3 原子 ⇒ invalid，进 coverage_invalid。
        if family_of_id(identifier) != "L3":
            items.append({
                "id": identifier,
                "status": "invalid",
                "detail": "非 L3 后缀混入 L3 族（§5.1）",
            })
            continue
        items.append({
            "id": identifier,
            "status": "skipped",
            "reason": "l3-human",
            "detail": "⛔ L3 只能由人验收，拒绝自动判绿（§7.3）",
        })
    declared = measured.get("l3_checks")
    if declared is not None:
        for raw in iter_named_items(declared):
            identifier = first_of(raw, ["id", "name"])
            claimed = first_of(raw, ["status", "result", "state"])
            note = "⛔ L3 只能由人验收，拒绝自动判绿"
            if isinstance(claimed, str):
                note += f"（输入自称 {claimed}，不采信）"
            if identifier in seen:
                continue
            seen.add(identifier)
            if family_of_id(identifier) != "L3":
                items.append({
                    "id": identifier,
                    "status": "invalid",
                    "detail": "非 L3 后缀混入 l3_checks（§5.1）",
                })
                continue
            items.append({
                "id": identifier,
                "status": "skipped",
                "reason": "l3-human",
                "detail": note,
            })
    for raw in measured.get("checks") or []:
        if not isinstance(raw, dict):
            continue
        identifier = first_of(raw, ["id", "name"])
        if family_of_id(identifier) == "L3" and identifier not in seen:
            seen.add(identifier)
            items.append({
                "id": identifier,
                "status": "skipped",
                "reason": "l3-human",
                "detail": "⛔ L3 只能由人验收，拒绝自动判绿",
            })
    if not items:
        return {
            "status": "n/a", "detail": "无 L3 条目",
            "items": [], "counts": family_counts([]),
        }
    return {
        "status": "skipped", "reason": "l3-human",
        "detail": "L3 未自动判绿；需可见窗口人工验收（§7.3）",
        "items": items, "counts": family_counts(items),
        "coverage": coverage_report(atoms, items),
    }


# ── compare 汇总 ─────────────────────────────────────────────────────────


def gates_overall_from_statuses(statuses):
    """由闸门状态推 overall（与 `run_gates` 的优先级一致）。"""
    if "fail" in statuses:
        return "environment-invalid"
    if "product-change" in statuses:
        return "product-typography-change"
    if "skipped" in statuses:
        return "incomplete"
    return "pass"


def validate_gates_result(gates, canonical, live_sha):
    """0230：校验 `--gates-json` 产物，返回问题列表（空 = 可采信）。

    旧实现只读 `overall.status`，任何自称 pass 的 JSON 都能当环境闸门结论，
    fixture / mode / exit_code 全不校验。这里逐项核对：
      - `tool == "preflight"`、`mode == "gates"`；
      - `fixture` 与本轮夹具一致；
      - `overall.status` 合法，且 `exit_code` 与状态一致；
      - `gates` 数组含 P-ENV-01..06、状态合法，并能推出同一 overall；
      - `fixture_sha256` 绑定当前夹具内容（live sha 可得时）。
    """
    problems = []
    if not isinstance(gates, dict):
        return ["gates.json 顶层不是对象"]
    if gates.get("tool") != "preflight":
        problems.append(f"tool={gates.get('tool')!r} 不是 'preflight'")
    if gates.get("mode") != "gates":
        problems.append(f"mode={gates.get('mode')!r} 不是 'gates'")
    if gates.get("fixture") != canonical:
        problems.append(f"fixture={gates.get('fixture')!r} 与该轮 {canonical!r} 不符")
    status = first_of(gates, ["overall.status"])
    if status not in GATES_OVERALL_EXIT:
        problems.append(f"overall.status={status!r} 不是合法闸门结论")
    recorded_exit = first_of(gates, ["overall.exit_code"])
    if recorded_exit is None:
        problems.append("overall.exit_code 缺失")
    elif status in GATES_OVERALL_EXIT and recorded_exit != GATES_OVERALL_EXIT[status]:
        problems.append(
            f"overall.status={status!r} 与 exit_code={recorded_exit!r} 不一致"
            f"（应为 {GATES_OVERALL_EXIT[status]}）")
    gate_rows = gates.get("gates")
    if not isinstance(gate_rows, list) or not gate_rows:
        problems.append("gates 数组缺失/为空")
    else:
        rows = [g for g in gate_rows if isinstance(g, dict)]
        ids = [g.get("id") for g in rows]
        missing = [gate_id for gate_id in GATES_IDS if gate_id not in ids]
        if missing:
            problems.append("缺闸门 " + "、".join(missing))
        bad = sorted({str(g.get("status")) for g in rows
                      if g.get("status") not in GATE_STATUSES})
        if bad:
            problems.append("非法闸门状态 " + "、".join(bad))
        elif status in GATES_OVERALL_EXIT:
            derived = gates_overall_from_statuses({g.get("status") for g in rows})
            if derived != status:
                problems.append(
                    f"overall.status={status!r} 与闸门状态推出的 {derived!r} 矛盾")
    recorded_sha = gates.get("fixture_sha256")
    if live_sha:
        if not isinstance(recorded_sha, str) or recorded_sha != live_sha:
            problems.append(
                "fixture_sha256 与当前夹具不符（记录 "
                f"{str(recorded_sha)[:12] if recorded_sha else '<缺失>'}…，"
                f"实测 {live_sha[:12]}…）")
    return problems


def run_compare(args):
    canonical = canonical_fixture(args.fixture)
    fixture_dir = resolve_fixture_dir(args.work, canonical)
    measured, measured_path = load_measured(fixture_dir)
    measured["_fixture"] = canonical
    baseline, baseline_reason = load_optional_json(args.baseline)
    expect, expect_reason = load_optional_json(args.expect)
    if baseline is not None and not isinstance(baseline, (dict, list)):
        raise PreflightError(f"baseline.json 顶层不是对象/数组：{args.baseline}")

    live_sha = sha256_file(fixture_md_path(args.fixtures_dir, canonical))
    if args.gates_json:
        gates_result = load_json(args.gates_json, required=True)
        gates_problems = validate_gates_result(gates_result, canonical, live_sha)
    else:
        gates_result, _ = run_gates(args)
        gates_problems = []
    env_state = first_of(gates_result, ["overall.status"], "incomplete")
    if gates_problems:
        # 0230：外来 gates 产物不可采信 ⇒ 环境结论降为 invalid（exit 20），
        # ⛔ 不拿它自报的 pass / fixture_sha256 继续比对。
        env_state = "environment-invalid"
    current_sha = live_sha or (first_of(gates_result, ["fixture_sha256"])
                               if not gates_problems else None)

    coverage, coverage_reason = load_coverage(getattr(args, "coverage", DEFAULT_COVERAGE))

    parity = build_parity(canonical, baseline, baseline_reason, env_state,
                          measured, current_sha,
                          coverage=coverage, coverage_reason=coverage_reason)
    spec = build_spec(canonical, measured, env_state,
                      coverage=coverage, coverage_reason=coverage_reason)
    register = build_register(canonical, measured, coverage=coverage)
    l3 = build_l3(canonical, measured, coverage=coverage)

    # 覆盖面本身不可用（清单缺失/畸形），或四族任一 entry 无效（§5.1 混入错误
    # 后缀、基线行 provenance 不合 §2.9、REG/L3 清单错族）⇒ 覆盖无效。0159：只
    # 保留这一处实现，`l2-check.sh` 只读 `overall`，⛔ 不再自己重算一份。
    coverage_invalid = coverage is None or any(
        item.get("status") == "invalid"
        for family in (spec, parity, register, l3) for item in family["items"])

    # 真正参与 pass/fail 的条目数：PASS 需要 > 0（0159：只登记不能算通过）。
    compared = sum(
        1
        for family in (spec, parity)
        for item in family["items"]
        if item.get("status") in ("pass", "fail") and not item.get("parent")
    )
    # 0159：PARITY 一条都没实际比较（全部 register_only / skipped）时，SPEC 全绿
    # 也不能记 PASS（设计 §7.2 步 4 的比对对象是 *-PARITY）。
    parity_compared = sum(
        1 for item in parity["items"]
        if item.get("status") in ("pass", "fail") and not item.get("parent")
    )

    result = {
        "tool": "preflight",
        "mode": "compare",
        "fixture": canonical,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "inputs": {
            "work": fixture_dir,
            "measured": measured_path,
            "baseline": args.baseline,
            "baseline_present": baseline is not None,
            "baseline_reason": baseline_reason,
            "expect": args.expect,
            "expect_present": expect is not None,
            "expect_reason": expect_reason,
            "fixtures_dir": args.fixtures_dir,
            "gates_json": args.gates_json,
            "gates_problems": gates_problems,
        },
        "env": {
            "status": env_state,
            "exit_code": (EXIT_ENV_INVALID if gates_problems
                          else first_of(gates_result, ["overall.exit_code"])),
            "summary": first_of(gates_result, ["overall.summary"]),
            "problems": gates_problems,
        },
        "fixture_sha256": current_sha,
        "families": {
            "SPEC": spec,
            "PARITY": parity,
            "REG": register,
            "L3": l3,
        },
        "coverage": {
            "path": getattr(args, "coverage", DEFAULT_COVERAGE),
            "available": coverage is not None,
            "reason": coverage_reason,
            "families": {
                "SPEC": spec.get("coverage"),
                "PARITY": parity.get("coverage"),
                "REG": register.get("coverage"),
                "L3": l3.get("coverage"),
            },
        },
        "compared_items": compared,
        "parity_compared_items": parity_compared,
        "coverage_invalid": coverage_invalid,
    }

    if coverage_invalid:
        exit_code = EXIT_ENV_INVALID
    elif env_state == "environment-invalid":
        exit_code = EXIT_ENV_INVALID
    elif env_state == "product-typography-change":
        exit_code = EXIT_PRODUCT_CHANGE
    elif env_state == "incomplete":
        exit_code = EXIT_INCOMPLETE
    elif spec["status"] == "fail" or parity["status"] == "fail":
        exit_code = EXIT_PRODUCT
    elif spec["status"] == "skipped" or parity["status"] == "skipped":
        exit_code = EXIT_INCOMPLETE
    elif compared == 0 or parity_compared == 0:
        # 0159：没有任何一条真正参与 pass/fail（只有登记/不适用），或 PARITY 一条
        # 都没实际比较 ⇒ ⛔ 不得 PASS。
        exit_code = EXIT_INCOMPLETE
    elif spec["status"] == "pass" or parity["status"] == "pass":
        exit_code = EXIT_PASS
    else:
        exit_code = EXIT_INCOMPLETE

    result["overall"] = {
        "status": {
            EXIT_PASS: "pass",
            EXIT_PRODUCT: "product-mismatch",
            EXIT_PRODUCT_CHANGE: "product-typography-change",
            EXIT_ENV_INVALID: "environment-invalid",
            EXIT_INCOMPLETE: "incomplete",
        }.get(exit_code, "incomplete"),
        "exit_code": exit_code,
    }
    return result, exit_code


def print_family(name, family, limit=80):
    reason = family.get("reason")
    print(f"{name}  {status_text(family.get('status'), reason)}  "
          f"{family.get('detail') or ''}".rstrip())
    items = family.get("items") or []
    for item in items[:limit]:
        status = status_text(item.get("status"), item.get("reason"))
        detail = item.get("detail") or ""
        print(f"   {item.get('id')}  {status}  {detail}")
    if len(items) > limit:
        print(f"   … 还有 {len(items) - limit} 条，见 result.json")


def print_compare_report(result):
    print(f"L2 家族比较 · fixture {result['fixture']}.md")
    env = result["env"]
    print(f"  环境闸门：{status_text(env['status'])}（{env.get('summary') or ''}）")
    coverage = result.get("coverage") or {}
    if coverage.get("available"):
        print(f"  判据清单：{coverage.get('path')}")
    else:
        print(f"  ⛔ 判据清单不可用：{coverage.get('reason')}")
    print("─" * 72)
    for name in ("SPEC", "PARITY", "REG", "L3"):
        family = result["families"][name]
        print_family(name, family)
        report = family.get("coverage")
        if report:
            line = (f"   清单：声明 {report['declared']} / 产出 {report['produced']} / "
                    f"缺席 {len(report['missing'])}")
            if report["missing"]:
                line += "（" + "、".join(report["missing"][:8])
                if len(report["missing"]) > 8:
                    line += f" 等 {len(report['missing'])} 条"
                line += "）"
            if report.get("extra"):
                line += "；未声明：" + "、".join(report["extra"][:5])
            print(line)
    print("─" * 72)
    overall = result["overall"]
    print(f"比较结论：{overall['status'].upper()}（exit {overall['exit_code']}）")
    print(f"  真正参与 pass/fail 的条目：{result.get('compared_items')} 条"
          f"（其中 PARITY {result.get('parity_compared_items')} 条）")
    if result.get("coverage_invalid"):
        print("  ⛔ 覆盖无效：coverage.json 不可用，或 baseline 的 provenance / "
              "fixture_sha256 / review 不完整（§2.9 / P-COV-04）")


# ── CLI ──────────────────────────────────────────────────────────────────


def build_parser():
    parser = argparse.ArgumentParser(
        prog="preflight.py",
        description="design/0063 L2 环境闸门与家族比较（离屏、只读、不启动 app）",
        epilog=("退出码：0 PASS / 2 ERROR / 10 PRODUCT-MISMATCH / "
                "15 PRODUCT-TYPOGRAPHY-CHANGE / 20 ENVIRONMENT-INVALID / 30 INCOMPLETE"),
    )
    sub = parser.add_subparsers(dest="mode")

    def add_common(sp):
        sp.add_argument("--fixture", required=True, help="夹具名：00-body / 00-body.md")
        sp.add_argument("--work", default=DEFAULT_WORK, help=".work 目录（默认 tools/visual-parity/.work）")
        sp.add_argument("--baseline", default=DEFAULT_BASELINE, help="L1 基线 baseline.json")
        sp.add_argument("--expect", default=DEFAULT_EXPECT, help="fixtures-expect.json")
        sp.add_argument("--fixtures-dir", default=DEFAULT_FIXTURES, help="夹具 .md 目录")
        sp.add_argument("--coverage", default=DEFAULT_COVERAGE,
                        help="coverage.json（设计 §3 的判据清单；缺文件即 coverage 无效）")
        sp.add_argument("--json-out", default=None, help="把结果 JSON 写到该路径")

    gates = sub.add_parser("gates", help="P-ENV-01..06 六条环境闸门")
    add_common(gates)
    compare = sub.add_parser("compare", help="SPEC / PARITY / REG / L3 四族比较")
    add_common(compare)
    compare.add_argument("--gates-json", default=None,
                         help="复用已产出的 gates 结果 JSON（l2-check.sh 会传）")
    return parser


def write_json(path, data):
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=False)
        f.write("\n")


def main(argv=None):
    raw = list(sys.argv[1:] if argv is None else argv)
    if not raw or raw[0].startswith("-"):
        raw = ["gates"] + raw
    parser = build_parser()
    args = parser.parse_args(raw)
    try:
        if args.mode == "gates":
            result, code = run_gates(args)
            print_gates_report(result)
        else:
            result, code = run_compare(args)
            print_compare_report(result)
    except PreflightError as exc:
        print(f"⛔ {exc}", file=sys.stderr)
        return EXIT_ERROR
    except Exception as exc:  # 兜底：不让调用者拿到无信息的 traceback 退出码 1
        print(f"⛔ 内部错误：{type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_ERROR
    if args.json_out:
        try:
            write_json(args.json_out, result)
        except OSError as exc:
            print(f"⛔ 写结果 JSON 失败：{args.json_out}（{exc}）", file=sys.stderr)
            return EXIT_ERROR
    return code


if __name__ == "__main__":
    sys.exit(main())



