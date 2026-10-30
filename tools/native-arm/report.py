#!/usr/bin/env python3
"""把 `probe.sh` 拿到的原始 JSON 打成一张能读的表。

⭐ 2026-10-29 复评 P2-1/P2-2 之后的口径（⛔ 旧口径已作废：只判选区范围、
   覆盖率与复制只打印不进退出码、`混合臂独有` 的抛错漏扫）：

每条判据 = **四个独立通过值**（范围 / 复制 / 覆盖 / 越界）＋ **一个统一 status**：
  pass     —— 四个量全部成立（不适用的记为 `不判`，不算通过、也不算失败）
  fail     —— 任一量明确不成立
  未测     —— 某个量本臂不支持或没量到（S 臂没有复制路径、越界率被 600 字符上限截断…）
 观测     —— 写死标了 `{观测:true}` 的诊断行，⛔ 不算通过
  不可比   —— 两臂本来就不可比（S 臂的键盘路径夹具里没接线）
  未知     —— **既没有写死期望、也没标观测、还产出了数值** ⇒ ⛔ 记红
  异常     —— 抛错（`文本` 以 ⛔ 开头 / 缺这一臂的单元格）

退出码（⭐ 比上一版严）：
  0  = 无异常 ∧ 无未知 ∧ 无 fail ∧ 环境自证有效
       ⚠️ 「0」**不**表示未测的量为 0：未测 / 观测 / 不可比 单列计数，⛔ 一律不算通过
  1  = 有 fail / 未知 / 异常
  2  = 没产出任何可比行（⛔ 空表**不是**绿灯）
  3  = 环境无效（页面不可见 / 前台被抢 / 致命）

⚠️ **`0` 的含义只有上面那一行**：它**不**表示"混合臂能迁移"、也不表示"真机可用"。
   `arm.js::摘要.未测` 里那几条永远不由本脚本判定。
⚠️ 本脚本**不重算期望**——期望写死在 `arm.js` 的矩阵里。这里只做
   ① 归一 status（含把旧格式的 `符合期望: true/false` 降级换算）
   ② 把每个量送进汇总与退出码 ③ 呈现。
   自测（负例夹具）在 `report_selftest.py`，⛔ 别只跑 happy-path。
"""
import json
import sys

# ⚠️ 两个默认上限与 `arm.js` 里的 `覆盖下限` / `越界上限` **同值**（口径一致性由自测钉住）。
#    实测依据见 `arm.js::subJudgments()` 的注释：覆盖率恒 1；越界率合法值最高 0.928。
COVER_MIN = 0.95
OUTSIDE_MAX = 0.95

MISSING = object()

STATUSES = ("pass", "fail", "未测", "观测", "不可比", "未知", "异常")


def clip(s, n=46):
    s = "" if s is None else str(s)
    s = s.replace("\n", "⏎").replace("\t", "→")
    if len(s) > n:
        s = s[: n - 1] + "…"
    return s


def fmt(v, n=60):
    """把任意 JSON 值压成一行（只为读，不求可解析）。"""
    if isinstance(v, list):
        if v and isinstance(v[0], (int, float)):
            return "[%s]" % ", ".join(fmt(x, 8) for x in v)
        return "[%s]" % ", ".join(fmt(x, 18) for x in v)
    if isinstance(v, dict):
        # ⚠️ 高亮那一坨只留判得动的那几个数
        if "覆盖率" in v:
            return "覆=%s 越界=%s 矩形=%s/%s" % (
                v.get("覆盖率"), v.get("越界率"), v.get("矩形数"), v.get("期望块数"))
        return "{%s}" % ", ".join("%s=%s" % (k, fmt(x, 16)) for k, x in v.items())
    if isinstance(v, str):
        return "'%s'" % clip(v, n)
    return str(v)


def digest(row, skip=("id", "动作", "期望", "符合期望", "判定", "结论")):
    parts = []
    for k, v in row.items():
        if k in skip:
            continue
        parts.append("%s=%s" % (k, fmt(v)))
    return " ".join(parts)


def expect_mark(v):
    if v is True or v == "pass":
        return " 期✓"
    if v is False or v == "fail":
        return " 期✗"
    if v == "未测":
        return " 期?未测"
    if v == "观测":
        return " 期·观测"
    return ""


def txt_is_err(t):
    return isinstance(t, str) and t.startswith("⛔")


def norm(v):
    """`符合期望` / `结论` 归一成 status 字符串；认不出的返回 None。"""
    if v is True:
        return "pass"
    if v is False:
        return "fail"
    if isinstance(v, str) and v in STATUSES:
        return v
    return None


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def derive_subs(cell):
    """旧格式（没有 `判定`）时，从 `选区 / 文本 / 复制 / 高亮` 现算四个独立值。

    ⚠️ 这是**降级换算**，⛔ 不是第二份实现：新格式的 `判定` 由 `arm.js` 产出，
       这里只在它缺席时兜底——而「缺席」本身在 `classify_cell()` 里也会被记账。
    """
    exp = cell.get("期望") or {}
    out = {"范围": "不判", "复制": "不判", "覆盖": "不判", "越界": "不判"}
    if exp.get("观测") or exp.get("策略差异"):
        return out
    r = norm(cell.get("符合期望"))
    if r in ("pass", "fail"):
        out["范围"] = (r == "pass")
    s = cell.get("选区")
    hi = cell.get("高亮") or {}
    # ⚠️ "选中了东西"有两条证据：`选区` 非折叠 **或** 有覆盖率数字
    #    （`arm.js::snap()` 只在选区非空时才算 coverage ⇒ 有覆盖率 = 当时真选了）。
    #    旧格式里可能只有后者（用户 2026-10-29 的 `bad_visual_copy.json` 就是那个形状）。
    has_sel = (isinstance(s, list) and len(s) == 2 and s[0] != s[1]) or _num(hi.get("覆盖率"))
    if not has_sel:
        return out                                  # 折叠 / 没量到 ⇒ 后三条不适用
    cp = cell.get("复制")
    if exp.get("复制") == "不判":
        out["复制"] = "不判"
    elif isinstance(cp, str) and cp.startswith("未测"):
        out["复制"] = "未测"
    elif cp == "":
        # 空复制 + 非空选区：可能"本臂没有复制路径"，也可能"真坏了"——分不清 ⇒ 未测（⛔ 不记通过）
        out["复制"] = "未测"
    else:
        out["复制"] = (cp == (cell.get("文本") or ""))
    c, w = hi.get("覆盖率"), hi.get("越界率")
    至少 = exp.get("覆盖至少", COVER_MIN)
    至多 = exp.get("越界至多", OUTSIDE_MAX)
    out["覆盖"] = "未测" if not _num(c) else (c >= 至少)
    out["越界"] = "未测" if not _num(w) else (w <= 至多)
    return out


def classify_cell(cell, row_uncomparable=False, row_verdict=MISSING):
    """一个臂的单元格 → `(status, 判定, 笔记)`。⛔ 任何分支都不许"默认通过"。

    `row_verdict` = 配对行上的 `N符合期望` / `S符合期望` …（旧格式把结论写在那儿）。
    """
    notes = []
    if not isinstance(cell, dict) or not cell:
        return "未知", {}, ["缺这一臂的单元格"]
    if txt_is_err(cell.get("文本")) or cell.get("结果") == "error":
        return "异常", {}, ["抛错：" + clip(cell.get("文本"), 60)]
    subs = cell.get("判定")
    if not isinstance(subs, dict) or not subs:
        subs = derive_subs(cell)
        if (cell.get("结论") is not None or cell.get("符合期望") is not None) and not subs:
            notes.append("缺判定（旧格式）")
    else:
        subs = dict(subs)
    exp = cell.get("期望") or {}
    base = None
    if cell.get("未测") or row_uncomparable:
        base = "不可比"
        notes.append(str(cell.get("未测") or "两臂不可比"))
    elif exp.get("观测") or exp.get("策略差异"):
        base = "观测"
    else:
        base = norm(cell.get("结论")) or norm(cell.get("符合期望"))
        if base is None and row_verdict is not MISSING:
            base = norm(row_verdict)
    vals = list(subs.values())
    if base in ("不可比", "观测"):
        return base, subs, notes
    if any(v is False for v in vals):
        return "fail", subs, notes
    if base == "fail":
        return "fail", subs, notes
    if base == "未测" or any(v == "未测" for v in vals):
        return "未测", subs, notes
    if base == "pass":
        return "pass", subs, notes
    # 走到这里：既没有写死的期望，也没有 `结论`，但很可能产出了数值（高亮/复制）
    if cell.get("高亮") is not None or cell.get("复制"):
        notes.append("产出了数据但没有写死的期望（⛔ 观测行必须显式标 `{观测:true}`）")
    return "未知", subs, notes


def sub_brief(subs):
    parts = []
    for k in ("范围", "复制", "覆盖", "越界"):
        v = subs.get(k, MISSING)
        if v is MISSING or v == "不判":
            continue
        if v is True:
            parts.append("%s✓" % k)
        elif v is False:
            parts.append("⛔%s✗" % k)
        else:
            parts.append("%s?%s" % (k, v))
    return " ".join(parts)


def main(path):
    with open(path, "r", encoding="utf-8") as f:
        d = json.load(f)

    if not isinstance(d, dict):
        print("⛔ 致命：顶层不是对象")
        return 3
    if "致命" in d:
        print("⛔ 致命：%s" % d["致命"])
        return 3

    env = d.get("环境") or {}
    win = env.get("窗口") or {}
    print("── 环境自证")
    print(
        "   前台 起跑前=%s 收工时=%s 被抢过=%s"
        % (env.get("前台应用_起跑前"), env.get("前台应用_收工时"), env.get("前台被抢过"))
    )
    print(
        "   窗口 isVisible=%s alpha=%s key=%s 调过activate=%s 调过makeKey=%s 进程被激活=%s"
        % (
            win.get("isVisible"),
            win.get("alpha"),
            win.get("窗口是_key"),
            win.get("调过_NSApp_activate"),
            win.get("调过_makeKey"),
            win.get("进程被激活"),
        )
    )
    # ⚠️ 「前台应用变了」有两种：我们自己抢的 ⇔ 用户自己切走的。
    #    前者使本轮无效；后者只是噪声——判据全在离屏页面里，与前台是谁无关。
    stolen = bool(
        win.get("进程被激活")
        or win.get("窗口是_key")
        or win.get("调过_NSApp_activate")
        or win.get("调过_makeKey")
    )
    if env.get("前台被抢过") and not stolen:
        print("   ⚠️ 前台应用变过，但**本进程没被激活、窗口不是 key** ⇒ 是用户自己切的，判据仍有效")
    print("   墙钟 %ss" % env.get("墙钟秒"))

    检查 = d.get("判据") or []
    检查H = d.get("混合臂对照") or []
    独有H = d.get("混合臂独有") or []
    检查M = d.get("交还鼠标对照") or []
    独有M = d.get("交还鼠标独有") or []
    焦点 = d.get("焦点适配") or []
    文档级 = d.get("文档级") or []

    counts = {s: 0 for s in STATUSES}
    bad = []        # (表, id, 臂, status, 说明)
    notes_all = []  # (表, id, 臂, 文本)
    warn = []       # 观测/不可比 行上的异常迹象（⛔ 不进退出码，但必须打印）

    def take(表, rid, 臂, cell, row_uncomparable=False, row_verdict=MISSING):
        st, subs, notes = classify_cell(cell, row_uncomparable, row_verdict)
        counts[st] = counts.get(st, 0) + 1
        if st in ("fail", "未知", "异常"):
            bad.append((表, rid, 臂, st, "；".join(notes) or sub_brief(subs)))
        else:
            for n in notes:
                notes_all.append((表, rid, 臂, n))
        # ⭐ 观测行不算验收，但"选区非空、复制却是空"这种迹象必须看得见
        if st == "观测" and isinstance(cell, dict):
            s = cell.get("选区")
            cp = cell.get("复制")
            if isinstance(s, list) and len(s) == 2 and s[0] != s[1] and cp == "":
                warn.append("%s/%s 选区非空但复制为空（观测行，⛔ 不作判据）" % (rid, 臂))
            hi = cell.get("高亮") or {}
            c = hi.get("覆盖率")
            if _num(c) and c < COVER_MIN:
                warn.append("%s/%s 覆盖率=%s（观测行，⛔ 不作判据）" % (rid, 臂, c))
        return st, subs

    def take_pair(表, rows, ka, kb):
        out = []
        for r in rows:
            rid = r.get("id")
            unc = bool(r.get("不可比"))
            # ⚠️ 旧格式把结论写在**行**上（`N符合期望` / `S符合期望`…）⇒ 一起递下去
            sa, _ = take(表, rid, ka, r.get(ka), unc, r.get(ka + "符合期望", MISSING))
            sb, _ = take(表, rid, kb, r.get(kb), unc, r.get(kb + "符合期望", MISSING))
            out.append((r, sa, sb))
        return out

    t1 = take_pair("表一", 检查, "N", "S")
    t2 = take_pair("表二", 检查H, "N", "H")
    t4 = take_pair("表四", 检查M, "N", "M")
    for r in 独有H:
        take("表三", r.get("id"), "H", r)
    for r in 独有M:
        take("表五", r.get("id"), "M", r)
    for r in 焦点:
        take("表六", r.get("id"), "F", r)
    for r in 文档级:
        take("表七", r.get("id"), "D", r)

    # ── 表一：N ↔ S（绘制 / 鼠标 / 输入都换掉） ─────────────────────────────
    print()
    print("── 表一 · N 原生臂 ↔ S 自建臂（整臂对照：绘制、鼠标、输入全换）")
    print("%-6s %-26s %-40s %-40s %s" % ("id", "动作", "N", "S", "同"))
    print("-" * 132)
    same = 0
    for r, st_a, st_b in t1:
        n = r.get("N") or {}
        s = r.get("S") or {}
        if r.get("两臂选中文本相同"):
            same += 1
        if r.get("不可比"):
            mark = "—"
        elif r.get("两臂选中文本相同"):
            mark = "✓"
        else:
            mark = "✗"
        if "异常" in (st_a, st_b):
            mark = "⛔"
        print(
            "%-6s %-26s %-40s %-40s %s"
            % (
                r.get("id"),
                clip(r.get("动作"), 26),
                clip("%s %r 覆=%s%s %s" % (n.get("选区"), clip(n.get("文本"), 12),
                                          (n.get("高亮") or {}).get("覆盖率"),
                                          expect_mark(st_a), sub_brief(n.get("判定") or {})), 40),
                clip("%s %r 覆=%s%s %s" % (s.get("选区"), clip(s.get("文本"), 12),
                                          (s.get("高亮") or {}).get("覆盖率"),
                                          expect_mark(st_b), sub_brief(s.get("判定") or {})), 40),
                mark,
            )
        )

    # ── 表二：N ↔ H（⭐ **只换绘制**，用户 2026-10-29 指定的第 1 步） ─────────
    print()
    print("── 表二 · N 原生臂 ↔ H 混合臂（⭐ 只换绘制：drawSelection ＋ 产品 R1 输入层 ＋ 自研鼠标）")
    print("%-6s %-26s %-40s %-40s %s" % ("id", "动作", "N", "H", "同"))
    print("-" * 132)
    sameH = 0
    for r, st_a, st_b in t2:
        n = r.get("N") or {}
        h = r.get("H") or {}
        if r.get("两臂选中文本相同"):
            sameH += 1
        if r.get("不可比"):
            mark = "—"
        elif r.get("两臂选中文本相同"):
            mark = "✓"
        else:
            mark = "✗"
        if "异常" in (st_a, st_b):
            mark = "⛔"
        print(
            "%-6s %-26s %-40s %-40s %s"
            % (
                r.get("id"),
                clip(r.get("动作"), 26),
                clip("%s %r 覆=%s%s %s" % (n.get("选区"), clip(n.get("文本"), 12),
                                          (n.get("高亮") or {}).get("覆盖率"),
                                          expect_mark(st_a), sub_brief(n.get("判定") or {})), 40),
                clip("%s %r 覆=%s%s %s" % (h.get("选区"), clip(h.get("文本"), 12),
                                          (h.get("高亮") or {}).get("覆盖率"),
                                          expect_mark(st_b), sub_brief(h.get("判定") or {})), 40),
                mark,
            )
        )

    # ── 表三：H 段独有（本臂才产出的行） ───────────────────────────────────
    print()
    print("── 表三 · H 段独有（高亮 / 光标层 / 复制 / 中文组合 / ⭐ 取消·失败·重入）")
    if not 独有H:
        print("   ⛔ 一条都没有 —— 混合臂没跑起来（先看「致命」那一栏）")
    for r in 独有H:
        st, _, _ = classify_cell(r)
        print("   %s [%s]%s %s" % (r.get("id"), st, expect_mark(st), r.get("动作")))
        print("      %s" % digest(r))
        if st == "异常":
            print("      ⛔ %s" % clip(r.get("文本"), 90))

    # ── 表四：N ↔ HM（⭐ **只换鼠标**，用户 2026-10-29 指定的第 2 步） ────────
    print()
    print("── 表四 · N 原生臂 ↔ HM 交还鼠标臂（⭐ 只换鼠标：CM6 的 handlers.mousedown ＋ MouseSelection）")
    print("%-8s %-26s %-40s %-40s %s" % ("id", "动作", "N", "M", "同"))
    print("-" * 132)
    sameM = 0
    for r, st_a, st_b in t4:
        n = r.get("N") or {}
        m = r.get("M") or {}
        if r.get("两臂选中文本相同"):
            sameM += 1
        if r.get("不可比"):
            mark = "—"
        elif r.get("两臂选中文本相同"):
            mark = "✓"
        else:
            mark = "✗"
        if "异常" in (st_a, st_b):
            mark = "⛔"
        print(
            "%-8s %-26s %-40s %-40s %s"
            % (
                r.get("id"),
                clip(r.get("动作"), 26),
                clip("%s %r 覆=%s%s %s" % (n.get("选区"), clip(n.get("文本"), 12),
                                          (n.get("高亮") or {}).get("覆盖率"),
                                          expect_mark(st_a), sub_brief(n.get("判定") or {})), 40),
                clip("%s %r 覆=%s%s %s" % (m.get("选区"), clip(m.get("文本"), 12),
                                          (m.get("高亮") or {}).get("覆盖率"),
                                          expect_mark(st_b), sub_brief(m.get("判定") or {})), 40),
                mark,
            )
        )

    # ── 表五：HM 段独有（只读视图 / 焦点交还 / 事件链 / 公开面口径） ─────────
    print()
    print("── 表五 · HM 段独有（只读视图 / 焦点交还 / ⭐ 事件链 / 公开面口径）")
    if not 独有M:
        print("   ⛔ 一条都没有 —— 交还鼠标臂没跑起来（先看「致命」那一栏）")
    for r in 独有M:
        st, _, _ = classify_cell(r)
        print("   %s [%s]%s %s" % (r.get("id"), st, expect_mark(st), r.get("动作")))
        print("      %s" % digest(r))
        chain = r.get("事件链")
        if chain:
            print("      事件链：%s" % " → ".join(str(x) for x in chain))
        if st == "异常":
            print("      ⛔ %s" % clip(r.get("文本"), 90))

    # ── 表六：焦点交还的适配候选（⭐ 2026-10-29 复评 P2-3） ───────────────────
    print()
    print("── 表六 · 焦点交还适配候选（F0 负对照⛔期望是反的 ／ F1 `focus()` 置空 ／ F2 `focusin` 回焦 ／"
          " F3 `mouseup` 同步还焦 ／ F4 = F2＋F3）")
    if not 焦点:
        print("   ⛔ 一条都没有 —— 焦点适配那一段没跑（先看「致命」那一栏）")
    for r in 焦点:
        st, _, _ = classify_cell(r)
        print("   %s [%s]%s %s" % (r.get("id"), st, expect_mark(st), clip(r.get("动作"), 70)))
        print("      %s" % digest(r))
        chain = r.get("事件链")
        if chain:
            print("      事件链：%s" % " → ".join(str(x) for x in chain))
        if st == "异常":
            print("      ⛔ %s" % clip(r.get("文本"), 90))

    # ── 表七：文档级集成原型（⭐ 用户三步走的第 3 步） ──────────────────────
    print()
    print("── 表七 · 文档级集成原型（D1–D4 整篇一份 `EditorState` ／ D5 单块负对照⛔期望是反的）")
    if not 文档级:
        print("   ⛔ 一条都没有 —— 文档级那一段没跑（先看「致命」那一栏）")
    for r in 文档级:
        st, _, _ = classify_cell(r)
        print("   %s [%s]%s %s" % (r.get("id"), st, expect_mark(st), clip(r.get("动作"), 70)))
        print("      %s" % digest(r))
        if st == "异常":
            print("      ⛔ %s" % clip(r.get("文本"), 90))

    print()
    print("── 差异明细（表一里两臂**选中文本不一致**的那些）")
    diff = [r for r in 检查 if r.get("两臂选中文本相同") is False]
    if not diff:
        print("   无")
    for r in diff:
        print("   %s %s" % (r.get("id"), r.get("动作")))
        print("      N: 选区=%s 文本=%r" % ((r.get("N") or {}).get("选区"), (r.get("N") or {}).get("文本")))
        print("      S: 选区=%s 文本=%r" % ((r.get("S") or {}).get("选区"), (r.get("S") or {}).get("文本")))
        print("      N 复制=%r" % ((r.get("N") or {}).get("复制"),))
        print("      S 复制=%r" % ((r.get("S") or {}).get("复制"),))

    print()
    print("── 差异明细（表二里 N 与 H **选中文本不一致**的那些）")
    diffH = [r for r in 检查H if r.get("两臂选中文本相同") is False]
    if not diffH:
        print("   无")
    for r in diffH:
        print("   %s %s" % (r.get("id"), r.get("动作")))
        print("      N: 选区=%s 文本=%r" % ((r.get("N") or {}).get("选区"), (r.get("N") or {}).get("文本")))
        print("      H: 选区=%s 文本=%r" % ((r.get("H") or {}).get("选区"), (r.get("H") or {}).get("文本")))
        print("      N 复制=%r" % ((r.get("N") or {}).get("复制"),))
        print("      H 复制=%r" % ((r.get("H") or {}).get("复制"),))

    摘要 = d.get("摘要") or {}

    print()
    print("── 汇总")
    print("   ⭐ status 计数（每臂一个单元格算一条）：%s"
          % " ".join("%s=%d" % (s, counts[s]) for s in STATUSES if counts.get(s)))
    print("   表一 条数 %d ｜ 两臂文本相同 %d ｜ 单臂不可比 %d"
          % (len(检查), same, sum(1 for r in 检查 if r.get("不可比"))))
    print("   表二 条数 %d ｜ 两臂文本相同 %d（⭐ 只换绘制之后应当**逐条相同**）" % (len(检查H), sameH))
    print("   表三 H 段独有 %d 条 ｜ 表四 配对 %d 条（文本相同 %d）｜ 表五 HM 段独有 %d 条"
          % (len(独有H), len(检查M), sameM, len(独有M)))
    if 焦点:
        # ⭐ 每个候选分开数：三个候选的**结论不同**才是这一段的产出
        by = {}
        for r in 焦点:
            p = str(r.get("id", ""))[:2]
            st = classify_cell(r)[0]
            by.setdefault(p, {})
            by[p][st] = by[p].get(st, 0) + 1
        print("   表六 焦点适配 %d 条：%s"
              % (len(焦点), " ｜ ".join(
                  "%s[%s]" % (p, " ".join("%s=%d" % (s, by[p][s]) for s in sorted(by[p])))
                  for p in sorted(by))))

    if 文档级:
        byd = {}
        for r in 文档级:
            st = classify_cell(r)[0]
            byd[st] = byd.get(st, 0) + 1
        print("   表七 文档级 %d 条：%s"
              % (len(文档级), " ".join("%s=%d" % (s, byd[s]) for s in sorted(byd))))

    # ⭐ R 段 = 「取消 / 失败 / 重入 / 焦点变化」那几条（2026-10-29 用户扩展评审）。
    #    ⚠️ 它们压的是**产品那份 `src/live/input.js`**（R1–R3）与两条臂都跑的驱动端（R4/R5）
    #    ⇒ 不符**不是**实验故障，是产品缺陷被钉住了。
    r_rows = [r for r in 独有H if str(r.get("id", "")).startswith("R")]
    if r_rows:
        r_st = [classify_cell(r)[0] for r in r_rows]
        print("   R 段（取消·失败·重入·焦点）%d 条：%s"
              % (len(r_rows), " ".join("%s=%d" % (s, r_st.count(s)) for s in sorted(set(r_st)))))
        r_fail = [r.get("id") for r, st in zip(r_rows, r_st) if st == "fail"]
        if r_fail:
            print("      ⛔ 不符的是：%s ——「不符合」= 在混合臂上**复现了产品缺陷**（⛔ 不是实验故障）；"
                  "这几条在把输入层交还 CM6 之后整装消失" % "、".join(r_fail))

    if bad:
        print("   ⛔ 红行（fail / 未知 / 异常，进退出码）：")
        for 表, rid, 臂, st, why in bad:
            print("      %s %s/%s [%s] %s" % (表, rid, 臂, st, why))
    if notes_all:
        print("   ⚠️ 不可比 / 未测 的说明：")
        for 表, rid, 臂, n in notes_all[:20]:
            print("      %s %s/%s %s" % (表, rid, 臂, n))
        if len(notes_all) > 20:
            print("      …另有 %d 条" % (len(notes_all) - 20))
    if warn:
        print("   ⚠️ 观测行上的异常迹象（⛔ 不作判据，但值得记）：")
        for w in warn:
            print("      %s" % w)

    au = 摘要.get("自动滚动子实验_原生臂") or {}
    if au:
        print("   自动滚动子实验（把 .cm-editor 约束成滚动容器，⨀ 不参与 A1–A16）：%s" % au.get("结论"))
        print("      滚动前 %s → 滚动后 %s；选中 %s 字符" % (au.get("滚动前"), au.get("滚动后"), au.get("选中字符数")))
    cost = 摘要.get("成本") or {}
    print("   成本（⚠️ 参考数字，⛔ 不是闸门）：N=%s  S=%s" % (cost.get("N"), cost.get("S")))
    print("   夹具：%s 行 / %s 字符" % (摘要.get("夹具行数"), 摘要.get("夹具字符")))
    print("   ⛔ 未测：")
    for u in 摘要.get("未测") or []:
        print("      - %s" % u)

    print()
    print("── 退出码口径（⛔ 别把它读成「能迁移」）")
    print("   0 = 无异常 ∧ 无未知 ∧ 无 fail ∧ 环境有效；⚠️ 未测 / 观测 / 不可比 **不算通过**；")
    print("   1 = 有 fail / 未知 / 异常；2 = 没产出可比行；3 = 环境无效。")

    if stolen:
        print()
        print("⛔ 本轮无效：本进程被激活 / 窗口变成 key —— 抢了前台")
        return 3
    if env.get("环境有效") is False:
        print()
        print("⛔ 本轮无效：页面不可见（帧健康闸门）")
        return 3
    if not 检查 and not 检查H and not 独有M and not 焦点 and not 文档级:
        print()
        print("⛔ 本轮无效：一条可比行都没有")
        return 2
    if bad:
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("用法：report.py <result.json>", file=sys.stderr)
        sys.exit(64)
    sys.exit(main(sys.argv[1]))
