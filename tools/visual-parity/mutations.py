#!/usr/bin/env python3
"""design/0063 §7.2「页内 CSS 变异」的唯一登记处（M1–M6 ＋ M1-INV）。

# 这个文件干什么

只做一件事：把 `docs/design/0063-Mardo-端侧对照测试.md` §7.2 的变异表
**逐条落成可执行的数据**——注入的 CSS 文本、受影响的判据族、以及
「必须红 / 允许连带红 / 必须绿」的分类。

⛔ 本文件不读图片、不跑页面、不判红绿；判红绿由 `l2-check.sh` 做，
   本文件只提供**期望集合**，`l2-run.sh` 用它们做变异页的 verdict。

# 为什么每条都用 `!important`

`src/services/theme.js:196` 在启动时把用户外观写进
`document.documentElement.style`（内联样式）：

    s.setProperty('--reader-font-size', applied.fontSize + 'px');

内联声明的优先级高于普通作者样式表声明。若 M1 只写
`:root { --reader-font-size: 16px; }`，页面自身的 14px 内联值会赢，
变异**根本没打上**，最后会表现为「M1 没有变红」——与「判据不敏感」
长得一模一样。自定义属性允许 `!important`，且作者 `!important`
优先于普通内联声明 ⇒ 每条都带 `!important`，只改页面副本，⛔ 不改产品源码。

# 与 §7.2 的硬约束

1. 每条只改**一处**排版量，⛔ 不扩大变异面：M1–M5 为一个 `--reader-*` 变量；
   M6 为 `.doc h2` 的 `font-size` 声明（bug/0162：`--reader-size-h2` 同时驱动
   h2 的 `font-size` 与上下 `margin`，改变量不是纯字号变异）。
2. M1-INV 与 M1 **同一次运行**（§7.2 原文「同上（与 M1 同一次运行）」），
   不单独出页；它只断言纯 em 派生的 `/B` 比值必须全绿。
3. M6 的值是**无单位系数** 1.40，⛔ 不写 px（§7.2 表 M6 行）。
4. 变异页的环境豁免只到「图片非空 ＋ 宽 == DPR × W_canvas」两条；
   `P-ENV-02` / `P-ENV-03` / `P-ENV-06` 只对基线页生效（`D2` 硬规则）。
   ⛔ 负对照 N1–N7 不豁免——那部分不归本文件管。

# 用法

    python3 -I tools/visual-parity/mutations.py --list
    python3 -I tools/visual-parity/mutations.py --json
    python3 -I tools/visual-parity/mutations.py --ids
    python3 -I tools/visual-parity/mutations.py --all-ids
    python3 -I tools/visual-parity/mutations.py --css M1
    python3 -I tools/visual-parity/mutations.py --spec M1
    python3 -I tools/visual-parity/mutations.py --skip-env
    python3 -I tools/visual-parity/mutations.py --selftest

`--selftest` 是**纯逻辑**自检：不读网、不跑页面、不依赖任何其它文件。
它把 §7.2 表里的每个字面值重新断言一遍，并做结构校验（ID 存在、归属正确、
必须红/必须绿不重叠、`PAGE_IDS` 与 `emit_page` 派生一致），改错立刻非 0 退出。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from fnmatch import fnmatch

SCHEMA = "rmd-parity-mutations/1"

# §7.2「变异页的环境豁免」的唯一一份机器可读表述。
ENV_MUTATION = {
    "policy": "mutation",
    "run": [
        "P-ENV-01.nonempty",
        "P-ENV-01.width",
    ],
    "not_run": [
        "P-ENV-01.band_count",
        "P-ENV-01.backup_diff",
        "P-ENV-02",
        "P-ENV-03",
        "P-ENV-06",
    ],
    "note": (
        "§7.2 D2 硬规则：变异页只跑『图片非空 ＋ PNG 宽 == DPR × W_canvas』；"
        "P-ENV-02/03/06 只对基线页生效。⛔ 负对照 N1–N7 不适用本豁免。"
    ),
}


def _id(criterion, metric=None):
    """精确判据 ID；metric 可写 glob（如 `IND_*/B`）。"""
    item = {"id": criterion}
    if metric is not None:
        item["metric"] = metric
    return item


def _glob(criterion, metric=None):
    """按前缀/通配匹配一组判据（如 `P-QUOTE-*`）。"""
    item = {"id": criterion, "glob": True}
    if metric is not None:
        item["metric"] = metric
    return item


def _scope(name):
    """类级期望：ALL_GEOMETRY / ALL_SPEC / ALL / ALL_EXCEPT。"""
    return {"scope": name}


# ────────────────────────────────────────────────────────────────────────────
# M1：--reader-font-size: 16px
#
# §7.2 的「必须红只剩三类」（C4 ＋ D3）：
#   ① 绝对锚点：--reader-rule-width: 1px（P-RULE-01）、pic.png 64px（P-IMG-01），
#      判据写成 /B 比值 ⇒ 变的不是 64px 本身，是比值；
#   ② 不随 font-size 缩放的 UA 控件：复选框方框尺寸取 WebKit 默认，
#      只有 margin-right: 0.4em 跟随（P-BOX-01 / P-TASK-01 / P-C-NESTTASK-01）；
#   ③ 断行函数：栏宽不变而字号变 ⇒ 断点变（P-PARA-01 / P-C-CJK-01）。
# ⛔ P-TBL-05-PARITY 不在必须红里（E3）：w_i/Σw 按构造不变，首轮实跑前
#    只能进「表格列宽族」的允许连带红。
# ────────────────────────────────────────────────────────────────────────────

M1 = {
    "id": "M1",
    "title": "--reader-font-size: 16px",
    "kind": "page-css",
    "css": (
        ":root {\n"
        "  /* M1（§7.2）：正文字号 14px → 16px；!important 压过 theme.js 的内联外观。 */\n"
        "  --reader-font-size: 16px !important;\n"
        "}\n"
    ),
    "decls": [["--reader-font-size", "16px"]],
    "same_run_as": None,
    "emit_page": True,
    "must_red": [
        _id("P-BOX-01-PARITY"),
        _id("P-TASK-01-PARITY"),
        _id("P-C-NESTTASK-01-PARITY"),
        _id("P-PARA-01-PARITY"),
        _id("P-C-CJK-01-PARITY"),
        _id("P-RULE-01-PARITY"),
        _id("P-IMG-01-PARITY"),
    ],
    # M1 的「必须绿」由 M1-INV 承担；这里留空，⛔ 不把 M1-INV 混进 M1。
    "must_green": [],
    "allowed_collateral_red": [
        {
            "family": "复选框族",
            "ids": [
                "P-TASK-01-PARITY",
                "P-BOX-01-PARITY",
                "P-C-NESTTASK-01-PARITY",
            ],
            "note": "其余量；方框尺寸取 WebKit 默认，只有 margin-right: 0.4em 跟随",
        },
        {
            "family": "RAG_para 族",
            "ids": ["P-PARA-01-PARITY", "P-C-CJK-01-PARITY"],
            "note": "其余量；栏宽不变、字号变 ⇒ 断点变",
        },
        {
            "family": "表格列宽族",
            "ids": [
                "P-TBL-01-PARITY",
                "P-TBL-02-PARITY",
                "P-TBL-03-PARITY",
                "P-TBL-05-PARITY",
                "P-C-TBLINQ-01-PARITY",
            ],
            "note": "含 P-TBL-05-PARITY 的占比漂移；纯 em 派生的 /B 比值不在连带红里",
        },
    ],
    "env": dict(ENV_MUTATION),
    "notes": [
        "必须红逐个列名，⛔ 不含 P-TBL-05-PARITY（E3）。",
        "P-RULE-01 / P-IMG-01 的分子是绝对锚点，变的是 /B 比值。",
        "允许连带红只按族写，⛔ 不族内逐条列举。",
    ],
}

# ────────────────────────────────────────────────────────────────────────────
# M1-INV：与 M1 同一次运行；只含纯 em 派生的判据，必须全绿。
# §7.2：「列表缩进（P-UL-01 / P-OL-01 / P-NEST-01 的 IND_*/B）、
#        引用条宽（P-QUOTE-01 的 W_qbar/B）、代码内边距（PAD_code/B，含
#        P-FENCE-01 / P-INDENT-01 / P-C-LICODE-01）、表头字高
#        （P-H-0*-PARITY 与 P-TBL-01 的 H/B）」。
# ────────────────────────────────────────────────────────────────────────────

M1_INV = {
    "id": "M1-INV",
    "title": "M1 的同轮不变式：纯 em 派生比值必须全绿",
    "kind": "page-css-invariant",
    "css": M1["css"],
    "decls": M1["decls"],
    "same_run_as": "M1",
    "emit_page": False,  # 与 M1 同一次运行，⛔ 不单独出页
    "must_red": [],
    "must_green": [
        _id("P-UL-01-PARITY", "IND_*/B"),
        _id("P-OL-01-PARITY", "IND_*/B"),
        _id("P-NEST-01-PARITY", "IND_*/B"),
        _id("P-QUOTE-01-PARITY", "W_qbar/B"),
        _id("P-FENCE-01-PARITY", "PAD_code/B"),
        _id("P-INDENT-01-PARITY", "PAD_code/B"),
        _id("P-C-LICODE-01-PARITY", "PAD_code/B"),
        _id("P-H-01-PARITY", "H/B"),
        _id("P-H-02-PARITY", "H/B"),
        _id("P-H-03-PARITY", "H/B"),
        _id("P-H-04-PARITY", "H/B"),
        _id("P-H-05-PARITY", "H/B"),
        _id("P-H-06-PARITY", "H/B"),
        _id("P-TBL-01-PARITY", "H/B"),
    ],
    "allowed_collateral_red": [],
    "env": dict(ENV_MUTATION),
    "notes": [
        "与 M1 同一次运行（§7.2：『同上（与 M1 同一次运行）』）。",
        "只含纯 em 派生的 /B 比值；按构造只能绿。",
    ],
}

# ────────────────────────────────────────────────────────────────────────────
# M2：--reader-list-indent +8px
# ────────────────────────────────────────────────────────────────────────────

M2 = {
    "id": "M2",
    "title": "--reader-list-indent +8px",
    "kind": "page-css",
    "css": (
        ":root {\n"
        "  /* M2（§7.2）：列表缩进 2em → 2em + 8px；只改这一个变量。 */\n"
        "  --reader-list-indent: calc(2em + 8px) !important;\n"
        "}\n"
    ),
    "decls": [["--reader-list-indent", "calc(2em + 8px)"]],
    "same_run_as": None,
    "emit_page": True,
    "must_red": [
        _id("P-UL-01-PARITY"),
        _id("P-OL-01-PARITY"),
        _id("P-NEST-01-PARITY"),
        _id("P-C-QULI-01-PARITY"),
        _id("P-C-LIQT-01-PARITY"),
        # §2 给 C-NESTTASK 的量是「每级方框左缘、方框宽/B」。缩进 +8px 移动的
        # 是**左缘**（方框宽由 UA 决定，不随缩进变）⇒ 这里点名 left/B，
        # 否则会拿不变的 width/B 去比，把预期的红误判成绿。
        _id("P-C-NESTTASK-01-PARITY", "left/B"),
    ],
    "must_green": [
        _glob("P-QUOTE-*"),
        _glob("P-H-*"),
        _glob("P-TBL-*"),
    ],
    "allowed_collateral_red": [],
    "env": dict(ENV_MUTATION),
    "notes": ["必须绿按族写：引用、标题、表格三族不受列表缩进影响。",
              "C-NESTTASK 比 left/B：缩进移动左缘，方框宽不变。"],
}

# ────────────────────────────────────────────────────────────────────────────
# M3：表格单元格 padding +2px
# ────────────────────────────────────────────────────────────────────────────

M3 = {
    "id": "M3",
    "title": "表格单元格 padding +2px",
    "kind": "page-css",
    "css": (
        ":root {\n"
        "  /* M3（§7.2）：表格单元格 padding .5em → .5em + 2px。 */\n"
        "  --reader-table-cell-pad: calc(.5em + 2px) !important;\n"
        "}\n"
    ),
    "decls": [["--reader-table-cell-pad", "calc(.5em + 2px)"]],
    "same_run_as": None,
    "emit_page": True,
    "must_red": [
        _id("P-TBL-01-PARITY"),
        _id("P-TBL-05-PARITY"),
        _id("P-C-TBLINQ-01-PARITY"),
    ],
    "must_green": [
        _glob("P-UL-*"),
        _glob("P-QUOTE-*"),
    ],
    "allowed_collateral_red": [
        {
            "family": "表格列宽重排",
            "ids": ["P-TBL-02-PARITY", "P-TBL-03-PARITY"],
            "note": "auto 布局重分列宽，预期同红",
        }
    ],
    "env": dict(ENV_MUTATION),
    "notes": ["P-TBL-05 / P-C-TBLINQ 同红是 auto 布局重分列宽的预期结果。"],
}

# ────────────────────────────────────────────────────────────────────────────
# M4：引用条色改 #ff0000
# ────────────────────────────────────────────────────────────────────────────

M4 = {
    "id": "M4",
    "title": "引用条色改 #ff0000",
    "kind": "page-css",
    "css": (
        ":root {\n"
        "  /* M4（§7.2）：只改引用条颜色；条宽仍由 --reader-quote-bar-factor 派生。 */\n"
        "  --reader-quote-bar-color: #ff0000 !important;\n"
        "}\n"
    ),
    "decls": [["--reader-quote-bar-color", "#ff0000"]],
    "same_run_as": None,
    "emit_page": True,
    "must_red": [
        _id("P-QUOTE-01-PARITY", "color/C_quote_bar"),
    ],
    "must_green": [_scope("ALL_GEOMETRY")],
    "allowed_collateral_red": [],
    "env": dict(ENV_MUTATION),
    "notes": ["只判颜色项；全部几何必须绿。"],
}

# ────────────────────────────────────────────────────────────────────────────
# M5：表头底改 #ff0000
# ────────────────────────────────────────────────────────────────────────────

M5 = {
    "id": "M5",
    "title": "表头底改 #ff0000",
    "kind": "page-css",
    "css": (
        ":root {\n"
        "  /* M5（§7.2）：只改表头底色（契约第 58 个变量）。 */\n"
        "  --reader-table-head-bg: #ff0000 !important;\n"
        "}\n"
    ),
    "decls": [["--reader-table-head-bg", "#ff0000"]],
    "same_run_as": None,
    "emit_page": True,
    "must_red": [
        _id("P-TBL-01-PARITY", "color/C_table_head"),
    ],
    "must_green": [_scope("ALL_GEOMETRY")],
    "allowed_collateral_red": [],
    "env": dict(ENV_MUTATION),
    "notes": ["只判颜色项；全部几何必须绿。"],
}

# ────────────────────────────────────────────────────────────────────────────
# M6：h2 字号系数 1.75 → 1.40（无单位系数；⛔ 不写 px）
#
# bug/0162：产品里 `--reader-size-h2` 同时是 h2 的 `font-size` 与上下 `margin`
# 的乘数（`src/styles/typography.css`）。改这个变量会连带收缩标题间距——
# 那不是「纯字号变异」，且设计允许连带红表没有列任何间距/行带判据。
# ⇒ 本变异只覆盖 `.doc h2 { font-size: ... }`，⛔ 不碰 `--reader-size-h2`，
#    也不碰 `margin`。字号变化量与设计一致（14 px × 1.40 = 19.6 px）。
#
# B7(a)：--reader-gap-heading-before 是无单位系数，写 -4px 会得到
# calc(px × px) 并被 CSS 丢弃；改字号才是有效变异。
# ────────────────────────────────────────────────────────────────────────────

M6 = {
    "id": "M6",
    "title": "h2 字号 1.75→1.40（只改 font-size，不动 margin）",
    "kind": "page-css",
    "css": (
        ".doc h2 {\n"
        "  /* M6（§7.2）：h2 字号系数 1.75 → 1.40；⛔ 无单位，不写 px。\n"
        "     bug/0162：只覆盖 font-size，避免连带动 h2 上下 margin。 */\n"
        "  font-size: calc(var(--reader-font-size) * 1.40) !important;\n"
        "}\n"
    ),
    "decls": [["font-size", "calc(var(--reader-font-size) * 1.40)"]],
    "same_run_as": None,
    "emit_page": True,
    "must_red": [
        _id("P-H-02-PARITY"),
        _id("P-H-02-SPEC"),
    ],
    "must_green": [
        _glob("P-H-01*"),
        _glob("P-H-03*"),
    ],
    "allowed_collateral_red": [
        {
            "family": "标题行内底块",
            "ids": ["P-C-HINLINE-01-PARITY"],
            "note": "标题行内底块随字号变",
        }
    ],
    "env": dict(ENV_MUTATION),
    "notes": [
        "1.40 是无单位系数；⛔ CSS 里不得出现 px（selftest 会查）。",
        "bug/0162：只改 `.doc h2` 的 font-size，⛔ 不改 `--reader-size-h2`，"
        "否则会连带把 h2 上下 margin 按同一系数收缩（设计未登记该类连带红）。",
        "P-H-02-SPEC 是 L2-DOM 产品值判据，不依赖 L1 基线。",
    ],
}

MUTATIONS = [M1, M1_INV, M2, M3, M4, M5, M6]
_BY_ID = {m["id"]: m for m in MUTATIONS}
PAGE_IDS = [m["id"] for m in MUTATIONS if m.get("emit_page")]
ALL_IDS = [m["id"] for m in MUTATIONS]


# ────────────────────────────────────────────────────────────────────────────
# 静态判据目录 ＋「本变异会动哪些判据」的归属表（⛔ 只在 --selftest 里用）
#
# 这不是「第二份期望值」，而是让 selftest 能回答三个**与字面量无关**的问题；
# 否则把一条 must 换成另一个真实存在但不该在此的判据，字面量比对只能靠人肉同步：
#   ① ID 存在   —— must 项必须是 §3 判据目录里的真判据（拼错/臆造立刻红）；
#   ② 归属正确 —— must_red 只能落在本变异真的会动的判据上；must_green 必须落在
#                  本变异按构造**不会**动的判据上（防把无关判据塞进 must、
#                  或把受本变异影响的判据写成绿）；
#   ③ 无矛盾   —— 同一变异不得同时要求某判据红与绿。
# 权威仍是 `docs/design/0063` §3 与 §7.2；这里只收 §7.2 会引用到的判据，
# 且目录里每条都必须被某个 must/连带红条目（含通配展开）引用，⛔ 不留死条目。
# ────────────────────────────────────────────────────────────────────────────

CRITERION_FAMILY = {}


def _register(family, *criterion_ids):
    for cid in criterion_ids:
        CRITERION_FAMILY[cid] = family


_register("box", "P-BOX-01-PARITY")
_register("task", "P-TASK-01-PARITY")
_register("para", "P-PARA-01-PARITY", "P-C-CJK-01-PARITY")
_register("rule", "P-RULE-01-PARITY")
_register("img", "P-IMG-01-PARITY")
_register("list",
          "P-UL-01-PARITY", "P-UL-01-SPEC",
          "P-OL-01-PARITY", "P-NEST-01-PARITY",
          "P-C-QULI-01-PARITY", "P-C-LIQT-01-PARITY",
          "P-C-NESTTASK-01-PARITY")
_register("quote",
          "P-QUOTE-01-PARITY", "P-QUOTE-02-PARITY", "P-QUOTE-04-PARITY",
          "P-QUOTE-05-PARITY", "P-QUOTE-06-PARITY",
          "P-QUOTE-01-SPEC", "P-QUOTE-02-SPEC", "P-QUOTE-03-SPEC",
          "P-QUOTE-04-SPEC", "P-QUOTE-05-SPEC", "P-QUOTE-06-SPEC")
_register("code",
          "P-FENCE-01-PARITY", "P-INDENT-01-PARITY", "P-C-LICODE-01-PARITY")
_register("heading",
          "P-H-01-PARITY", "P-H-02-PARITY", "P-H-03-PARITY",
          "P-H-04-PARITY", "P-H-05-PARITY", "P-H-06-PARITY",
          "P-H-01-SPEC", "P-H-02-SPEC", "P-H-03-SPEC",
          "P-H-04-SPEC", "P-H-05-SPEC", "P-H-06-SPEC", "P-H-07-SPEC",
          "P-C-HINLINE-01-PARITY")
_register("table",
          "P-TBL-01-PARITY", "P-TBL-02-PARITY", "P-TBL-03-PARITY",
          "P-TBL-05-PARITY",
          "P-TBL-01-SPEC", "P-TBL-02-SPEC", "P-TBL-03-SPEC", "P-TBL-04-SPEC",
          "P-TBL-07-SPEC", "P-TBL-08-SPEC", "P-TBL-09-SPEC", "P-TBL-10-SPEC",
          "P-C-TBLINQ-01-PARITY")

# ── bug/0279：每条判据的显式「必需夹具 / 生产者」声明 ─────────────────────
#
# 旧实现只有运行时 producer_index：必须项是否可判完全取决于用户选了哪些夹具，
# 同一份产品代码会随 `--fixtures` 在 0/10/30 之间跳变，且报告说不出「为什么没测到」。
# 这里把「哪个夹具能产出该判据、由哪个探针字段产出」写成静态事实：
#   - fixtures 为空 ⇒ 当前没有已知生产路径（如 P-IMG-01），运行时仍记 unverified；
#   - 选中的子集与声明不相交 ⇒ unverified + reason=requires-fixtures-not-selected；
#   - producer 只用于报告归因，不参与判红绿。
# ⛔ 这不是第二份判定逻辑：红/绿仍只由 l2-check.sh / l2-run 的 comparator 决定。
CRITERION_PRODUCER = {
    "box": "dom-probe:task-checkbox-rects",
    "task": "dom-probe:task-list-rects",
    "para": "dom-probe:doc.line_boxes",
    "rule": "dom-probe:hr-rects",
    "img": "dom-probe:images.items",
    "list": "dom-probe:list-item-rects",
    "quote": "dom-probe:blockquote-rects",
    "code": "dom-probe:code-block-rects",
    "heading": "dom-probe:heading-rects",
    "table": "dom-probe:tableInfo",
}

CRITERION_FIXTURES = {
    "P-BOX-01-PARITY": ("12-task", "13b-combos2"),
    "P-TASK-01-PARITY": ("12-task", "13b-combos2"),
    "P-PARA-01-PARITY": ("00-body", "02-blocks", "03-quote",
                         "08-links-images", "12-task", "13a-combos",
                         "13b-combos2"),
    "P-C-CJK-01-PARITY": ("00-body", "02-blocks", "03-quote",
                          "08-links-images"),
    "P-RULE-01-PARITY": ("02-blocks",),
    # 设计期望图片判据来自 08/11；当前 images.items 生产者仍为 0（bug/0278）。
    "P-IMG-01-PARITY": ("08-links-images", "11-diagrams"),
    "P-UL-01-PARITY": ("03-quote", "04a-lists-basic", "04b-lists-nested",
                       "04c-lists-edge", "12-task", "13a-combos",
                       "13b-combos2"),
    "P-UL-01-SPEC": ("03-quote", "04a-lists-basic", "04b-lists-nested",
                     "04c-lists-edge", "12-task", "13a-combos",
                     "13b-combos2"),
    "P-OL-01-PARITY": ("04a-lists-basic", "04b-lists-nested",
                       "04c-lists-edge", "13a-combos"),
    "P-NEST-01-PARITY": ("04b-lists-nested", "04c-lists-edge", "12-task",
                         "13a-combos", "13b-combos2"),
    "P-C-QULI-01-PARITY": ("03-quote", "13a-combos"),
    "P-C-LIQT-01-PARITY": ("13a-combos",),
    "P-C-NESTTASK-01-PARITY": ("12-task", "13b-combos2"),
    "P-QUOTE-01-PARITY": ("03-quote", "13a-combos", "13b-combos2"),
    "P-QUOTE-02-PARITY": ("03-quote", "13a-combos", "13b-combos2"),
    "P-QUOTE-04-PARITY": ("03-quote", "13a-combos", "13b-combos2"),
    "P-QUOTE-05-PARITY": ("03-quote", "13a-combos", "13b-combos2"),
    "P-QUOTE-06-PARITY": ("03-quote", "13a-combos", "13b-combos2"),
    "P-QUOTE-01-SPEC": ("03-quote", "13a-combos", "13b-combos2"),
    "P-QUOTE-02-SPEC": ("03-quote", "13a-combos", "13b-combos2"),
    "P-QUOTE-03-SPEC": ("03-quote", "13a-combos", "13b-combos2"),
    "P-QUOTE-04-SPEC": ("03-quote", "13a-combos", "13b-combos2"),
    "P-QUOTE-05-SPEC": ("03-quote", "13a-combos", "13b-combos2"),
    "P-QUOTE-06-SPEC": ("03-quote", "13a-combos", "13b-combos2"),
    "P-FENCE-01-PARITY": ("05-fences", "02-blocks", "03-quote",
                          "13a-combos"),
    "P-FENCE-01-SPEC": ("05-fences", "02-blocks", "03-quote", "13a-combos"),
    "P-INDENT-01-PARITY": ("02-blocks", "03-quote", "05-fences",
                           "13a-combos"),
    "P-C-LICODE-01-PARITY": ("13a-combos", "05-fences"),
    "P-H-01-PARITY": ("01-headings",),
    "P-H-02-PARITY": ("01-headings",),
    "P-H-03-PARITY": ("01-headings", "13a-combos"),
    "P-H-04-PARITY": ("01-headings",),
    "P-H-05-PARITY": ("01-headings",),
    "P-H-06-PARITY": ("01-headings",),
    "P-H-01-SPEC": ("01-headings",),
    "P-H-02-SPEC": ("01-headings",),
    "P-H-03-SPEC": ("01-headings", "13a-combos"),
    "P-H-04-SPEC": ("01-headings",),
    "P-H-05-SPEC": ("01-headings",),
    "P-H-06-SPEC": ("01-headings",),
    "P-H-07-SPEC": ("01-headings",),
    "P-C-HINLINE-01-PARITY": ("13a-combos",),
    "P-TBL-01-PARITY": ("06a-table", "06b-table-edge", "13b-combos2"),
    "P-TBL-02-PARITY": ("06a-table", "06b-table-edge", "13b-combos2"),
    "P-TBL-03-PARITY": ("06a-table", "06b-table-edge", "13b-combos2"),
    "P-TBL-05-PARITY": ("06a-table", "06b-table-edge", "13b-combos2"),
    "P-TBL-01-SPEC": ("06a-table", "06b-table-edge", "13b-combos2"),
    "P-TBL-02-SPEC": ("06a-table", "06b-table-edge", "13b-combos2"),
    "P-TBL-03-SPEC": ("06a-table", "06b-table-edge", "13b-combos2"),
    "P-TBL-04-SPEC": ("06a-table", "06b-table-edge", "13b-combos2"),
    "P-TBL-07-SPEC": ("06a-table", "06b-table-edge", "13b-combos2"),
    "P-TBL-08-SPEC": ("06a-table", "06b-table-edge", "13b-combos2"),
    "P-TBL-09-SPEC": ("06a-table", "06b-table-edge", "13b-combos2"),
    "P-TBL-10-SPEC": ("06a-table", "06b-table-edge", "13b-combos2"),
    "P-C-TBLINQ-01-PARITY": ("13b-combos2",),
}

# bug/0173：设计 §3.4/§3.5 已列出、但当前管线完全没有执行体的判据。
# 显式登记（而不是让它们静默缺席），runner 会原样带进结果 JSON。
UNIMPLEMENTED_CRITERIA = [
    {"id": "P-CELLBR-01-PARITY", "reason": "no-per-cell-line-boxes-and-no-LH_table"},
    {"id": "P-CELLBR-01-SPEC", "reason": "no-cell-level-structure-probe"},
    {"id": "P-CELLBR-02-SPEC", "reason": "no-cell-code-node-text-probe"},
    {"id": "P-CELLBR-02-PARITY", "reason": "no-OCR"},
    {"id": "P-BR-01-PARITY", "reason": "probe-has-breaks-but-no-LH-and-no-consumer"},
    {"id": "P-MERMAID-01-SPEC", "reason": "no-diagram-node-probe"},
    {"id": "P-MERMAID-01-PARITY", "reason": "no-diagram-node-probe"},
    {"id": "P-MERMAID-01-CENTER-PARITY", "reason": "no-diagram-node-probe"},
    {"id": "P-FLOW-01-SPEC", "reason": "no-diagram-node-probe"},
    {"id": "P-FLOW-01-PARITY", "reason": "no-diagram-node-probe"},
    {"id": "P-SEQUENCE-01-SPEC", "reason": "no-diagram-node-probe"},
    {"id": "P-SEQUENCE-01-PARITY", "reason": "no-diagram-node-probe"},
    {"id": "P-MATHFENCE-01-SPEC", "reason": "no-math-node-probe"},
    {"id": "P-MATH-01-SPEC", "reason": "no-math-node-probe"},
]

# §7.2：每条变异「允许改变」的判据全集（必须红与允许连带红的并集）。
# must_red ⊆ 本集合；must_green ∩ 本集合 == ∅。M1-INV 是纯不变式 ⇒ 空集。
MUTATION_AFFECTED = {
    "M1": frozenset({
        "P-BOX-01-PARITY", "P-TASK-01-PARITY", "P-C-NESTTASK-01-PARITY",
        "P-PARA-01-PARITY", "P-C-CJK-01-PARITY", "P-RULE-01-PARITY",
        "P-IMG-01-PARITY",
        # 允许连带红（表格列宽族）
        "P-TBL-01-PARITY", "P-TBL-02-PARITY", "P-TBL-03-PARITY",
        "P-TBL-05-PARITY", "P-C-TBLINQ-01-PARITY",
    }),
    "M1-INV": frozenset(),
    "M2": frozenset({
        "P-UL-01-PARITY", "P-OL-01-PARITY", "P-NEST-01-PARITY",
        "P-C-QULI-01-PARITY", "P-C-LIQT-01-PARITY",
        "P-C-NESTTASK-01-PARITY",
    }),
    "M3": frozenset({
        "P-TBL-01-PARITY", "P-TBL-02-PARITY", "P-TBL-03-PARITY",
        "P-TBL-05-PARITY", "P-C-TBLINQ-01-PARITY",
    }),
    "M4": frozenset({"P-QUOTE-01-PARITY"}),
    "M5": frozenset({"P-TBL-01-PARITY"}),
    "M6": frozenset({
        "P-H-02-PARITY", "P-H-02-SPEC", "P-C-HINLINE-01-PARITY",
    }),
}

# 判据的度量维度名（§2.2 的 X/B 比值与颜色项）。metric 拼错 ⇒ selftest 红。
KNOWN_METRICS = frozenset({
    "IND_*/B", "W_qbar/B", "PAD_code/B", "H/B", "left/B",
    "color/C_quote_bar", "color/C_table_head",
})
KNOWN_SCOPES = frozenset({"ALL_GEOMETRY", "ALL_SPEC", "ALL", "ALL_EXCEPT"})

# §7.2 原表逐行抄下来的期望（`(ID/模式, kind, metric)`，kind ∈ id|glob|scope）。
# ⚠️ 这是**契约**：selftest 先做上面的结构校验，再逐项对照本表；两者缺一不可
#    ——结构校验防「换成另一个合法的判据」，本表防「少一项/多一项/量纲漂移」。
EXPECTED_MUST = {
    "M1": {
        "red": [
            ("P-BOX-01-PARITY", "id", None),
            ("P-TASK-01-PARITY", "id", None),
            ("P-C-NESTTASK-01-PARITY", "id", None),
            ("P-PARA-01-PARITY", "id", None),
            ("P-C-CJK-01-PARITY", "id", None),
            ("P-RULE-01-PARITY", "id", None),
            ("P-IMG-01-PARITY", "id", None),
        ],
        "green": [],
    },
    "M1-INV": {
        "red": [],
        "green": [
            ("P-UL-01-PARITY", "id", "IND_*/B"),
            ("P-OL-01-PARITY", "id", "IND_*/B"),
            ("P-NEST-01-PARITY", "id", "IND_*/B"),
            ("P-QUOTE-01-PARITY", "id", "W_qbar/B"),
            ("P-FENCE-01-PARITY", "id", "PAD_code/B"),
            ("P-INDENT-01-PARITY", "id", "PAD_code/B"),
            ("P-C-LICODE-01-PARITY", "id", "PAD_code/B"),
            ("P-H-01-PARITY", "id", "H/B"),
            ("P-H-02-PARITY", "id", "H/B"),
            ("P-H-03-PARITY", "id", "H/B"),
            ("P-H-04-PARITY", "id", "H/B"),
            ("P-H-05-PARITY", "id", "H/B"),
            ("P-H-06-PARITY", "id", "H/B"),
            ("P-TBL-01-PARITY", "id", "H/B"),
        ],
    },
    "M2": {
        "red": [
            ("P-UL-01-PARITY", "id", None),
            ("P-OL-01-PARITY", "id", None),
            ("P-NEST-01-PARITY", "id", None),
            ("P-C-QULI-01-PARITY", "id", None),
            ("P-C-LIQT-01-PARITY", "id", None),
            ("P-C-NESTTASK-01-PARITY", "id", "left/B"),
        ],
        "green": [
            ("P-QUOTE-*", "glob", None),
            ("P-H-*", "glob", None),
            ("P-TBL-*", "glob", None),
        ],
    },
    "M3": {
        "red": [
            ("P-TBL-01-PARITY", "id", None),
            ("P-TBL-05-PARITY", "id", None),
            ("P-C-TBLINQ-01-PARITY", "id", None),
        ],
        "green": [
            ("P-UL-*", "glob", None),
            ("P-QUOTE-*", "glob", None),
        ],
    },
    "M4": {
        "red": [("P-QUOTE-01-PARITY", "id", "color/C_quote_bar")],
        "green": [("ALL_GEOMETRY", "scope", None)],
    },
    "M5": {
        "red": [("P-TBL-01-PARITY", "id", "color/C_table_head")],
        "green": [("ALL_GEOMETRY", "scope", None)],
    },
    "M6": {
        "red": [
            ("P-H-02-PARITY", "id", None),
            ("P-H-02-SPEC", "id", None),
        ],
        "green": [
            ("P-H-01*", "glob", None),
            ("P-H-03*", "glob", None),
        ],
    },
}


def get(mutation_id):
    """取一条定义；未知 ID 抛 KeyError（CLI 会转成人话）。"""
    return _BY_ID[mutation_id]


def page_mutations():
    """需要单独出页的变异（M1–M6）；M1-INV 与 M1 同轮，⛔ 不在此列。"""
    return [m for m in MUTATIONS if m.get("emit_page")]


def invariants_for(page_id):
    """返回与该页同轮运行的不变式（目前只有 M1 → M1-INV）。"""
    return [m for m in MUTATIONS if m.get("same_run_as") == page_id]


def skip_env_for_page_mutations():
    """变异页必须跳过的环境闸门（供 l2-run.sh --skip-env 使用）。"""
    return list(ENV_MUTATION["not_run"])


def _enrich_must_item(item):
    """bug/0279：把静态夹具/生产者声明附到每条 must 项上（只加字段，不改期望）。"""
    out = dict(item)
    if "scope" in out:
        return out
    ids = ([cid for cid in CRITERION_FAMILY if fnmatch(cid, out["id"])]
           if out.get("glob") else [out.get("id")])
    fixtures = []
    families = []
    for cid in ids:
        for fixture in CRITERION_FIXTURES.get(cid, ()):
            if fixture not in fixtures:
                fixtures.append(fixture)
        family = CRITERION_FAMILY.get(cid)
        if family and family not in families:
            families.append(family)
    out["required_fixtures"] = fixtures
    out["producer"] = ", ".join(CRITERION_PRODUCER.get(f, "unknown:%s" % f)
                                for f in families) or None
    return out


def as_json():
    mutations = []
    for m in MUTATIONS:
        enriched = dict(m)
        enriched["must_red"] = [_enrich_must_item(x)
                                for x in m.get("must_red") or []]
        enriched["must_green"] = [_enrich_must_item(x)
                                  for x in m.get("must_green") or []]
        mutations.append(enriched)
    return {
        "schema": SCHEMA,
        "source": "docs/design/0063-Mardo-端侧对照测试.md §7.2",
        "env_mutation": ENV_MUTATION,
        "page_ids": PAGE_IDS,
        "all_ids": ALL_IDS,
        "mutations": mutations,
        # bug/0173：缺席判据的显式清单（runner 原样写入结果 JSON）。
        "unimplemented_criteria": UNIMPLEMENTED_CRITERIA,
    }


# ────────────────────────────────────────────────────────────────────────────
# 纯逻辑自检：把 §7.2 的字面值重新断言一遍
# ────────────────────────────────────────────────────────────────────────────

def _ids(items):
    return [x.get("id") for x in items if "id" in x]


def _norm_items(items):
    """归一成 `(ID/模式, kind, metric)`；kind ∈ id|glob|scope。"""
    out = []
    for x in items:
        if "scope" in x:
            out.append((x["scope"], "scope", None))
        else:
            out.append((x["id"], "glob" if x.get("glob") else "id",
                        x.get("metric")))
    return out


def _expand_ids(items):
    """把 must 项展开成判据 ID 集合；scope 项不展开（由 KNOWN_SCOPES 单独校验）。"""
    out = []
    for x in items:
        if "scope" in x:
            continue
        if x.get("glob"):
            out.extend(cid for cid in CRITERION_FAMILY if fnmatch(cid, x["id"]))
        else:
            out.append(x["id"])
    return out


def _selftest():
    failures = []
    checks = []

    def check(name, cond, detail=""):
        checks.append(name)
        if cond:
            print("[PASS] %s" % name)
        else:
            print("[FAIL] %s  %s" % (name, detail))
            failures.append(name)

    check("7 条登记（M1–M6 ＋ M1-INV）", len(MUTATIONS) == 7,
          "actual=%d" % len(MUTATIONS))
    check("ID 顺序", [m["id"] for m in MUTATIONS] == [
        "M1", "M1-INV", "M2", "M3", "M4", "M5", "M6"])

    # M1
    m1_red = _ids(M1["must_red"])
    check("M1 必须红逐个列名", m1_red == [
        "P-BOX-01-PARITY",
        "P-TASK-01-PARITY",
        "P-C-NESTTASK-01-PARITY",
        "P-PARA-01-PARITY",
        "P-C-CJK-01-PARITY",
        "P-RULE-01-PARITY",
        "P-IMG-01-PARITY",
    ], repr(m1_red))
    check("M1 不含 P-TBL-05-PARITY（E3）",
          "P-TBL-05-PARITY" not in m1_red)
    check("M1 的必须绿留空（由 M1-INV 承担）", M1["must_green"] == [])
    fam = [f["family"] for f in M1["allowed_collateral_red"]]
    check("M1 允许连带红按族写清",
          fam == ["复选框族", "RAG_para 族", "表格列宽族"], repr(fam))
    tbl = M1["allowed_collateral_red"][2]["ids"]
    check("M1 表格列宽族含 P-TBL-05-PARITY",
          "P-TBL-05-PARITY" in tbl, repr(tbl))
    check("M1 CSS 恰好是 --reader-font-size: 16px",
          "--reader-font-size: 16px !important;" in M1["css"])
    check("M1 必须红逐项（含顺序/量纲）",
          _norm_items(M1["must_red"]) == EXPECTED_MUST["M1"]["red"],
          repr(_norm_items(M1["must_red"])))
    check("M1 必须绿逐项（空，由 M1-INV 承担）",
          _norm_items(M1["must_green"]) == EXPECTED_MUST["M1"]["green"],
          repr(_norm_items(M1["must_green"])))

    # M1-INV
    check("M1-INV 与 M1 同一次运行", M1_INV["same_run_as"] == "M1")
    check("M1-INV 不单独出页", M1_INV["emit_page"] is False)
    check("M1-INV CSS 与 M1 相同", M1_INV["css"] == M1["css"])
    check("M1-INV 没有必须红", M1_INV["must_red"] == [])
    inv_ids = _ids(M1_INV["must_green"])
    for want in ("P-UL-01-PARITY", "P-OL-01-PARITY", "P-NEST-01-PARITY",
                 "P-QUOTE-01-PARITY", "P-FENCE-01-PARITY",
                 "P-INDENT-01-PARITY", "P-C-LICODE-01-PARITY",
                 "P-H-01-PARITY", "P-H-02-PARITY", "P-H-03-PARITY",
                 "P-H-04-PARITY", "P-H-05-PARITY", "P-H-06-PARITY",
                 "P-TBL-01-PARITY"):
        check("M1-INV 必须绿含 %s" % want, want in inv_ids)
    check("M1-INV 必须绿逐项（14 项，含 metric 与顺序）",
          _norm_items(M1_INV["must_green"]) == EXPECTED_MUST["M1-INV"]["green"],
          repr(_norm_items(M1_INV["must_green"])))
    check("M1-INV 允许连带红为空", M1_INV["allowed_collateral_red"] == [])

    # M2
    check("M2 必须红", _ids(M2["must_red"]) == [
        "P-UL-01-PARITY", "P-OL-01-PARITY", "P-NEST-01-PARITY",
        "P-C-QULI-01-PARITY", "P-C-LIQT-01-PARITY",
        "P-C-NESTTASK-01-PARITY",
    ], repr(_ids(M2["must_red"])))
    check("M2 C-NESTTASK 比 left/B（缩进移动左缘）",
          M2["must_red"][-1].get("metric") == "left/B",
          repr(M2["must_red"][-1]))
    check("M2 CSS +8px", "calc(2em + 8px)" in M2["css"])
    check("M2 必须红逐项（含 left/B 量纲）",
          _norm_items(M2["must_red"]) == EXPECTED_MUST["M2"]["red"],
          repr(_norm_items(M2["must_red"])))
    check("M2 必须绿逐项（引用/标题/表格三族通配）",
          _norm_items(M2["must_green"]) == EXPECTED_MUST["M2"]["green"],
          repr(_norm_items(M2["must_green"])))

    # M3
    check("M3 必须红", _ids(M3["must_red"]) == [
        "P-TBL-01-PARITY", "P-TBL-05-PARITY", "P-C-TBLINQ-01-PARITY",
    ], repr(_ids(M3["must_red"])))
    check("M3 允许连带红 = TBL-02/03",
          M3["allowed_collateral_red"][0]["ids"] == [
              "P-TBL-02-PARITY", "P-TBL-03-PARITY"],
          repr(M3["allowed_collateral_red"]))
    check("M3 CSS +2px", "calc(.5em + 2px)" in M3["css"])
    check("M3 必须红逐项",
          _norm_items(M3["must_red"]) == EXPECTED_MUST["M3"]["red"],
          repr(_norm_items(M3["must_red"])))
    check("M3 必须绿逐项（列表/引用两族通配）",
          _norm_items(M3["must_green"]) == EXPECTED_MUST["M3"]["green"],
          repr(_norm_items(M3["must_green"])))

    # M4
    check("M4 颜色项", _ids(M4["must_red"]) == ["P-QUOTE-01-PARITY"]
          and M4["must_red"][0].get("metric") == "color/C_quote_bar")
    check("M4 全部几何必须绿",
          M4["must_green"] == [{"scope": "ALL_GEOMETRY"}])
    check("M4 CSS #ff0000", "--reader-quote-bar-color: #ff0000" in M4["css"])
    check("M4 必须红逐项（颜色量纲）",
          _norm_items(M4["must_red"]) == EXPECTED_MUST["M4"]["red"],
          repr(_norm_items(M4["must_red"])))
    check("M4 必须绿逐项（全部几何）",
          _norm_items(M4["must_green"]) == EXPECTED_MUST["M4"]["green"],
          repr(_norm_items(M4["must_green"])))

    # M5
    check("M5 颜色项", _ids(M5["must_red"]) == ["P-TBL-01-PARITY"]
          and M5["must_red"][0].get("metric") == "color/C_table_head")
    check("M5 全部几何必须绿",
          M5["must_green"] == [{"scope": "ALL_GEOMETRY"}])
    check("M5 CSS #ff0000", "--reader-table-head-bg: #ff0000" in M5["css"])
    check("M5 必须红逐项（颜色量纲）",
          _norm_items(M5["must_red"]) == EXPECTED_MUST["M5"]["red"],
          repr(_norm_items(M5["must_red"])))
    check("M5 必须绿逐项（全部几何）",
          _norm_items(M5["must_green"]) == EXPECTED_MUST["M5"]["green"],
          repr(_norm_items(M5["must_green"])))

    # M6
    check("M6 必须红", _ids(M6["must_red"]) == [
        "P-H-02-PARITY", "P-H-02-SPEC"], repr(_ids(M6["must_red"])))
    check("M6 必须绿 P-H-01/03", _ids(M6["must_green"]) == [
        "P-H-01*", "P-H-03*"], repr(_ids(M6["must_green"])))
    check("M6 必须红逐项",
          _norm_items(M6["must_red"]) == EXPECTED_MUST["M6"]["red"],
          repr(_norm_items(M6["must_red"])))
    check("M6 必须绿逐项（通配标志必须保留）",
          _norm_items(M6["must_green"]) == EXPECTED_MUST["M6"]["green"],
          repr(_norm_items(M6["must_green"])))
    check("M6 允许连带红 C-HINLINE",
          M6["allowed_collateral_red"][0]["ids"]
          == ["P-C-HINLINE-01-PARITY"],
          repr(M6["allowed_collateral_red"]))
    check("M6 CSS 系数 1.40",
          "calc(var(--reader-font-size) * 1.40)" in M6["css"])
    _m6_css_no_comment = re.sub(r"/\*.*?\*/", "", M6["css"], flags=re.S)
    check("M6 CSS 不含 px（无单位系数）",
          "px" not in _m6_css_no_comment, M6["css"])
    check("M6 只改 .doc h2 的 font-size",
          M6["css"].lstrip().startswith(".doc h2 {")
          and M6["decls"] == [["font-size", "calc(var(--reader-font-size) * 1.40)"]],
          repr(M6["decls"]))
    check("M6 不碰 --reader-size-h2 / margin（bug/0162）",
          "--reader-size-h2" not in _m6_css_no_comment
          and "margin" not in _m6_css_no_comment, M6["css"])

    # 环境豁免：所有变异页同一条硬规则
    for m in MUTATIONS:
        env = m["env"]
        check("%s 环境 policy=mutation" % m["id"],
              env.get("policy") == "mutation")
        check("%s 只跑 nonempty+width" % m["id"],
              env.get("run") == ["P-ENV-01.nonempty", "P-ENV-01.width"])
        nr = env.get("not_run") or []
        check("%s 不套 P-ENV-02/03/06" % m["id"],
              all(x in nr for x in ("P-ENV-02", "P-ENV-03", "P-ENV-06")))

    # 只改一处排版量
    for m in MUTATIONS:
        check("%s decls 恰好一项" % m["id"], len(m["decls"]) == 1,
              repr(m["decls"]))
        if m["id"] == "M6":
            # bug/0162：M6 只覆盖 font-size，⛔ 不碰同时驱动 margin 的变量。
            check("M6 CSS 只给 .doc h2", m["css"].lstrip().startswith(".doc h2 {"))
            check("M6 不改 --reader-* 变量",
                  not m["decls"][0][0].startswith("--reader-"))
        else:
            check("%s 只注入一个 --reader-* 变量" % m["id"],
                  m["decls"][0][0].startswith("--reader-"))
            check("%s CSS 只给 :root" % m["id"],
                  m["css"].lstrip().startswith(":root {"))

    # ── 结构校验：ID 存在 / 归属正确 / 非空 / 无矛盾 ──────────────────────
    unknown_affected = sorted(
        cid for ids in MUTATION_AFFECTED.values() for cid in ids
        if cid not in CRITERION_FAMILY)
    check("归属表里的判据都在判据目录里",
          not unknown_affected, repr(unknown_affected))
    check("归属表与变异定义一一对应",
          sorted(MUTATION_AFFECTED) == sorted(ALL_IDS),
          repr(sorted(set(MUTATION_AFFECTED) ^ set(ALL_IDS))))
    check("期望表的键与变异定义一一对应",
          sorted(EXPECTED_MUST) == sorted(ALL_IDS),
          repr(sorted(set(EXPECTED_MUST) ^ set(ALL_IDS))))

    for m in MUTATIONS:
        mid = m["id"]
        affected = MUTATION_AFFECTED[mid]
        if mid != "M1-INV":
            check("%s 必须红非空" % mid, bool(m["must_red"]),
                  "%s 的必须红为空 ⇒ 该变异没有一条必须红" % mid)
        if mid != "M1":
            check("%s 必须绿非空" % mid, bool(m["must_green"]),
                  "%s 的必须绿为空 ⇒ 该族只剩主值兜底（bug/0203）" % mid)

        for label, items in (("必须红", m["must_red"]),
                             ("必须绿", m["must_green"])):
            for x in items:
                if "scope" in x:
                    check("%s %s scope 合法：%s" % (mid, label, x["scope"]),
                          x["scope"] in KNOWN_SCOPES and "metric" not in x,
                          repr(x))
                    continue
                pat = x.get("id")
                check("%s %s ID 非空" % (mid, label), bool(pat), repr(x))
                if "glob" in x:
                    check("%s %s 通配标志为 True：%s" % (mid, label, pat),
                          x["glob"] is True, repr(x))
                check("%s %s 通配项不带 metric：%s" % (mid, label, pat),
                      not (x.get("glob") and "metric" in x), repr(x))
                if "metric" in x:
                    check("%s %s metric 合法：%s" % (mid, label, x["metric"]),
                          x["metric"] in KNOWN_METRICS, repr(x))
                if x.get("glob"):
                    hit = [cid for cid in CRITERION_FAMILY
                           if fnmatch(cid, pat)]
                    check("%s %s 通配命中判据目录：%s" % (mid, label, pat),
                          bool(hit), "没有任何判据匹配 %r" % pat)
                else:
                    check("%s %s ID 存在：%s" % (mid, label, pat),
                          pat in CRITERION_FAMILY, repr(pat))

        red_ids = set(_expand_ids(m["must_red"]))
        green_ids = set(_expand_ids(m["must_green"]))
        check("%s 必须红归属正确" % mid,
              red_ids <= affected, repr(sorted(red_ids - affected)))
        check("%s 必须绿归属正确（本变异不会动）" % mid,
              not (green_ids & affected), repr(sorted(green_ids & affected)))
        check("%s 必须红/必须绿不重叠" % mid,
              not (red_ids & green_ids), repr(sorted(red_ids & green_ids)))

        for group in m["allowed_collateral_red"]:
            family = group.get("family", "?")
            ids = group.get("ids") or []
            check("%s 连带红「%s」非空" % (mid, family), bool(ids), repr(group))
            unknown = [cid for cid in ids if cid not in CRITERION_FAMILY]
            check("%s 连带红「%s」ID 存在" % (mid, family),
                  not unknown, repr(unknown))
            outside = [cid for cid in ids if cid not in affected]
            check("%s 连带红「%s」归属正确" % (mid, family),
                  not outside, repr(outside))

    # ── 元测试：selftest 自身覆盖表 ───────────────────────────────────────
    # ① 判据目录里每条都必须被某个 must/连带红条目（含通配展开）引用，⛔ 不留死条目。
    #    M1-INV 的 14 条在 must_green 里；连带红组也算引用（它同样是被断言的对象）。
    referenced = set()
    for m in MUTATIONS:
        referenced.update(_expand_ids(m["must_red"]))
        referenced.update(_expand_ids(m["must_green"]))
        for group in m["allowed_collateral_red"]:
            referenced.update(group.get("ids") or [])
    dead = sorted(set(CRITERION_FAMILY) - referenced)
    check("判据目录每条都至少被 must 或连带红条目引用",
          not dead, repr(dead))

    # ② 每条变异都必须至少有一类 must 断言（或作为同轮不变式被引用）。
    coverage = {}
    for m in MUTATIONS:
        sources = []
        if m["must_red"]:
            sources.append("must_red")
        if m["must_green"]:
            sources.append("must_green")
        host = m.get("same_run_as")
        if host:
            sources.append("same_run_as<-%s" % host)
        coverage[m["id"]] = sources
        check("%s 在自检覆盖表里" % m["id"], bool(sources),
              "must_red/must_green 都为空且无同轮引用 ⇒ 该变异没有任何 must 断言")
    check("自检覆盖表覆盖全部变异", sorted(coverage) == sorted(ALL_IDS),
          repr(sorted(set(coverage) ^ set(ALL_IDS))))

    # ③ 派生量：PAGE_IDS / emit_page / same_run_as / invariants_for。
    check("PAGE_IDS 恰为 M1–M6（M1-INV 同轮不出页）",
          PAGE_IDS == ["M1", "M2", "M3", "M4", "M5", "M6"], repr(PAGE_IDS))
    check("ALL_IDS 恰为 7 条", ALL_IDS == [
        "M1", "M1-INV", "M2", "M3", "M4", "M5", "M6"], repr(ALL_IDS))
    for mid in ("M1", "M2", "M3", "M4", "M5", "M6"):
        check("%s emit_page=True" % mid,
              _BY_ID[mid].get("emit_page") is True,
              "显式断言：%s 是出页变异" % mid)
    check("M1-INV emit_page=False", _BY_ID["M1-INV"].get("emit_page") is False)
    check("PAGE_IDS 与 emit_page 派生一致",
          PAGE_IDS == [m["id"] for m in MUTATIONS if m.get("emit_page") is True],
          repr(PAGE_IDS))
    check("page_mutations() 与 PAGE_IDS 一致",
          [m["id"] for m in page_mutations()] == PAGE_IDS)
    check("invariants_for(M1) == [M1-INV]",
          [m["id"] for m in invariants_for("M1")] == ["M1-INV"])
    check("same_run_as 目标都是出页变异",
          all(m.get("same_run_as") in PAGE_IDS for m in MUTATIONS
              if m.get("same_run_as")))
    for m in MUTATIONS:
        if m.get("emit_page") is True:
            check("%s 出页时必须出现在 PAGE_IDS" % m["id"],
                  m["id"] in PAGE_IDS)
        elif m.get("emit_page") is False:
            check("%s 不出页时必须挂到一条出页变异" % m["id"],
                  m.get("same_run_as") in PAGE_IDS, repr(m.get("same_run_as")))

    # ④ bug/0279：每条 must 必须有显式夹具/生产者声明，且夹具名真实存在。
    fixture_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "fixtures")
    undeclared = []
    for m in MUTATIONS:
        for item in (m.get("must_red") or []) + (m.get("must_green") or []):
            if "scope" in item:
                continue
            expanded = ([cid for cid in CRITERION_FAMILY
                         if fnmatch(cid, item["id"])]
                        if item.get("glob") else [item.get("id")])
            if not expanded:
                undeclared.append("%s:%s(no-criterion)" % (m["id"], item.get("id")))
            for cid in expanded:
                if not CRITERION_FIXTURES.get(cid):
                    undeclared.append("%s:%s" % (m["id"], cid))
    check("0279: 每条 must 都有必需夹具声明", not undeclared,
          repr(undeclared))
    bad_fixtures = sorted({
        fixture
        for fixtures in CRITERION_FIXTURES.values()
        for fixture in fixtures
        if not os.path.isfile(os.path.join(fixture_dir, fixture + ".md"))
    })
    check("0279: 声明的必需夹具文件都存在", not bad_fixtures,
          repr(bad_fixtures))
    enriched = as_json()
    missing_required = []
    for m in enriched["mutations"]:
        for item in (m.get("must_red") or []) + (m.get("must_green") or []):
            if "scope" in item:
                continue
            if "required_fixtures" not in item:
                missing_required.append("%s:%s" % (m["id"], item.get("id")))
    check("0279: as_json 的每条 must 都带 required_fixtures",
          not missing_required, repr(missing_required))
    check("0173: 未实现判据清单非空且字段完整",
          bool(UNIMPLEMENTED_CRITERIA)
          and all(x.get("id") and x.get("reason")
                  for x in UNIMPLEMENTED_CRITERIA),
          repr(UNIMPLEMENTED_CRITERIA[:2]))

    print()
    if failures:
        print("⛔ selftest 失败 %d 项：%s" % (len(failures), ", ".join(failures)),
              file=sys.stderr)
        return 1
    print("✅ mutations.py selftest 全过（%d 条变异，%d 项断言）"
          % (len(MUTATIONS), len(checks)))
    return 0


def _print_list():
    print("design/0063 §7.2 页内 CSS 变异")
    print()
    for m in MUTATIONS:
        flag = "出页" if m.get("emit_page") else "同轮"
        print("[%s] %-7s %s（%s）" % (flag, m["id"], m["title"], m["kind"]))
        print("    decls: %s" % ", ".join("%s=%s" % (k, v) for k, v in m["decls"]))
        print("    必须红: %s" % (", ".join(_ids(m["must_red"])) or "—"))
        print("    必须绿: %s" % (_describe(m["must_green"]) or "—"))
        if m["allowed_collateral_red"]:
            print("    允许连带红: %s" % ", ".join(
                f["family"] for f in m["allowed_collateral_red"]))
        print()


def _describe(items):
    out = []
    for x in items:
        if "scope" in x:
            out.append("scope:" + x["scope"])
        else:
            s = x.get("id", "")
            if x.get("metric"):
                s += "#" + x["metric"]
            out.append(s)
    return ", ".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="design/0063 §7.2 页内 CSS 变异定义（M1–M6 ＋ M1-INV）")
    ap.add_argument("--list", action="store_true", help="人读清单")
    ap.add_argument("--json", action="store_true", help="完整定义（JSON）")
    ap.add_argument("--ids", action="store_true", help="只打印需要出页的 ID")
    ap.add_argument("--all-ids", action="store_true", help="打印全部 ID")
    ap.add_argument("--css", metavar="ID", help="只打印该变异的 CSS 文本")
    ap.add_argument("--spec", metavar="ID", help="只打印该变异的 JSON 定义")
    ap.add_argument("--skip-env", action="store_true",
                    help="打印变异页要跳过的环境闸门（逗号分隔）")
    ap.add_argument("--selftest", action="store_true", help="纯逻辑自检")
    args = ap.parse_args(argv)

    if args.selftest:
        return _selftest()
    if args.json:
        json.dump(as_json(), sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return 0
    if args.ids:
        for x in PAGE_IDS:
            print(x)
        return 0
    if args.all_ids:
        for x in ALL_IDS:
            print(x)
        return 0
    if args.css:
        try:
            sys.stdout.write(get(args.css)["css"])
        except KeyError:
            print("⛔ 未知变异：%s（可用：%s）" % (args.css, ", ".join(ALL_IDS)),
                  file=sys.stderr)
            return 2
        return 0
    if args.spec:
        try:
            json.dump(get(args.spec), sys.stdout, ensure_ascii=False, indent=2)
            sys.stdout.write("\n")
        except KeyError:
            print("⛔ 未知变异：%s（可用：%s）" % (args.spec, ", ".join(ALL_IDS)),
                  file=sys.stderr)
            return 2
        return 0
    if args.skip_env:
        print(",".join(skip_env_for_page_mutations()))
        return 0

    _print_list()
    return 0


if __name__ == "__main__":
    sys.exit(main())
