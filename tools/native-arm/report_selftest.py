#!/usr/bin/env python3
"""`report.py` 的负例自测（⛔ 只跑 happy-path 不算数）。

⭐ 2026-10-29 复评 P2-2 的原话：「为报告器本身写"不符/异常/缺行/未知/观测"负例测试；
   不仅运行 happy-path 的真实 JSON。」

做法：用**造出来的最小 JSON** 压 `report.main()` 的退出码与关键输出行。
⛔ 不读真实探针产物——那只能证明上一次跑成了什么样，证明不了"报告器会不会变红"。

跑法：`python3 tools/native-arm/report_selftest.py`
退出码：0 = 全部负例的期望都对；1 = 有一条不对（打印哪一条）。

⚠️ 每一个用例都钉**两件事**：退出码对吧？红得**是不是那条理由**？
   （只钉退出码会让"碰巧因为别的原因红了"也算过。）
"""
import contextlib
import io
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import report  # noqa: E402


ENV_OK = {
    "环境": {
        "前台应用_起跑前": "iTerm2",
        "前台应用_收工时": "iTerm2",
        "前台被抢过": False,
        "窗口": {
            "isVisible": True,
            "alpha": 0,
            "窗口是_key": False,
            "调过_NSApp_activate": False,
            "调过_makeKey": False,
            "进程被激活": False,
        },
        "墙钟秒": 12.5,
        "环境有效": True,
    }
}


def cell(结论="pass", 判定=None, 期望=None, 复制="abc", 文本="abc",
         选区=(0, 3), 覆盖率=1.0, 越界率=0.0, **extra):
    c = {
        "选区": list(选区),
        "方向": "正向",
        "文本": 文本,
        "复制": 复制,
        "高亮": {"覆盖率": 覆盖率, "越界率": 越界率, "矩形数": 1, "期望块数": 1},
        "期望": 期望 if 期望 is not None else {"选区": [0, 3]},
    }
    if 结论 is not None:
        c["结论"] = 结论
        c["符合期望"] = 结论 == "pass"
    if 判定 is None and 结论 is not None and 期望 is None:
        判定 = {"范围": True, "复制": True, "覆盖": True, "越界": True}
    if 判定 is not None:
        c["判定"] = 判定
    c.update(extra)
    return c


def pair(na, s, *, 不可比=False, same=True, rid="A1"):
    return {"id": rid, "动作": "造出来的动作", "两臂选中文本相同": same,
            "不可比": 不可比, "N": na, "S": s}


def doc(**parts):
    d = json.loads(json.dumps(ENV_OK))
    d.update(parts)
    return d


def run(d):
    fd, path = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = report.main(path)
        return code, buf.getvalue()
    finally:
        os.unlink(path)


CASES = []


def case(name, expect_code, must=(), must_not=()):
    def deco(fn):
        CASES.append((name, fn, expect_code, must, must_not))
        return fn
    return deco


# ── 1. 正例：四个量都成立 ⇒ 0 ───────────────────────────────────────────────
@case("正例·四个量都成立", 0, must=("pass=2", "期✓"))
def _():
    return doc(判据=[pair(cell(), cell())])


# ── 2. 不符（范围）⇒ 1 ─────────────────────────────────────────────────────
@case("不符·范围", 1, must=("[fail]", "红行"))
def _():
    return doc(判据=[pair(cell(), cell(结论="fail", 判定={"范围": False, "复制": True, "覆盖": True, "越界": True}))])


# ── 3. 异常：H 段独有行抛错（用户 2026-10-29 的实测反证）⇒ 1 ────────────────
@case("异常·混合臂独有的抛错要被扫到", 1, must=("H_TEST", "[异常]"))
def _():
    return doc(判据=[pair(cell(), cell())],
               混合臂独有=[{"id": "H_TEST", "动作": "boom", "文本": "⛔ 抛错：boom", "符合期望": None}])


# ── 4. 复制错 + 覆盖率 0（旧格式，没有 `判定`）⇒ 1，而且要红在复制/覆盖上 ──────
@case("复制错·覆盖率 0（旧格式降级换算）", 1, must=("覆盖", "[fail]"))
def _():
    bad = {"选区": [0, 3], "方向": "正向", "文本": "abc", "复制": "WRONG",
           "高亮": {"覆盖率": 0.0, "越界率": 1.0, "矩形数": 0, "期望块数": 1},
           "期望": {"选区": [0, 3]}, "符合期望": True}
    return doc(判据=[pair(bad, dict(bad))])


# ── 5. 未知：产出了数据，却既没写死期望、也没标观测 ⇒ 1（⛔ 不默认通过） ────
@case("未知·没写期望也没标观测", 1, must=("[未知]", "没有写死的期望"))
def _():
    odd = {"选区": [0, 3], "方向": "正向", "文本": "abc", "复制": "abc",
           "高亮": {"覆盖率": 1.0, "越界率": 0.0, "矩形数": 1, "期望块数": 1}}
    return doc(判据=[pair(odd, dict(odd))])


# ── 6. 观测行：显式标了 `{观测:true}` ⇒ 不红（但也不记通过） ────────────────
@case("观测·显式标了就不红", 0, must=("[观测]", "不算通过"))
def _():
    obs = {"选区": [0, 3], "方向": "正向", "文本": "abc", "复制": "",
           "高亮": {"覆盖率": 1.0, "越界率": 0.0, "矩形数": 1, "期望块数": 1},
           "期望": {"观测": True}, "符合期望": None}
    return doc(判据=[pair(obs, dict(obs))], 混合臂独有=[dict(obs, id="H_观察", 动作="观察行")])


# ── 7. 缺行：一条可比行都没有 ⇒ 2（⛔ 空表不是绿灯） ───────────────────────
@case("缺行·空表", 2, must=("一条可比行都没有",))
def _():
    return doc(判据=[], 混合臂对照=[], 混合臂独有=[], 交还鼠标对照=[], 交还鼠标独有=[])


# ── 8. 缺行：配对行少了一臂的单元格 ⇒ 1（未知） ───────────────────────────
@case("缺行·配对缺一臂", 1, must=("缺这一臂的单元格",))
def _():
    r = pair(cell(), cell())
    del r["S"]
    return doc(判据=[r])


# ── 9. 未测不算通过，但也不红（S 臂没有复制路径就是这个形态） ───────────────
@case("未测·不算通过也不红", 0, must=("未测=1", "pass=1", "期?未测"))
def _():
    s = cell(结论="未测", 判定={"范围": True, "复制": "未测", "覆盖": True, "越界": True}, 复制="")
    return doc(判据=[pair(cell(), s)])


# ── 10. 环境无效：进程被激活 ⇒ 3 ──────────────────────────────────────────
@case("环境无效·抢了前台", 3, must=("抢了前台",))
def _():
    d = doc(判据=[pair(cell(), cell())])
    d["环境"]["窗口"]["进程被激活"] = True
    return d


# ── 11. 环境无效：帧健康闸门 ⇒ 3 ──────────────────────────────────────────
@case("环境无效·页面不可见", 3, must=("页面不可见",))
def _():
    d = doc(判据=[pair(cell(), cell())])
    d["环境"]["环境有效"] = False
    return d


# ── 12. 致命 ⇒ 3 ─────────────────────────────────────────────────────────
@case("致命", 3, must=("致命",))
def _():
    return {"致命": "boom"}


# ── 13. 表六（焦点适配）也要进退出码：候选 F0 的复制失败必须红 ───────────────
@case("焦点适配·候选不符也要进退出码", 1, must=("表六", "F03", "⛔复制✗"))
def _():
    f = cell(结论="fail", 判定={"范围": True, "复制": False, "覆盖": "不判", "越界": "不判"})
    f["id"] = "F03"
    f["动作"] = "候选 F0（不适配）：点击之后打字"
    return doc(判据=[pair(cell(), cell())], 焦点适配=[f])


# ── 14. 表六正例：三个候选各 6 条全 pass ⇒ 仍是 0（⛔ 别把新表做成恒红） ──────
@case("焦点适配·全 pass 不红", 0, must=("表六 焦点适配 12 条", "pass=14"))
def _():
    fs = []
    for cand in ("F0", "F1"):
        for i in range(1, 7):
            c = cell(结论="pass", 判定={"范围": True, "复制": True, "覆盖": True, "越界": True})
            c["id"] = "%s%d" % (cand, i)
            c["动作"] = "候选 %s 第 %d 条" % (cand, i)
            fs.append(c)
    return doc(判据=[pair(cell(), cell())], 焦点适配=fs)


def main():
    bad = 0
    for name, fn, want, must, must_not in CASES:
        try:
            got, out = run(fn())
        except Exception as e:                      # noqa: BLE001 —— 自测要如实报出来
            bad += 1
            print("✗ %s：抛错 %r" % (name, e))
            continue
        why = []
        if got != want:
            why.append("退出码 %d ≠ 期望 %d" % (got, want))
        for m in must:
            if m not in out:
                why.append("输出里没有 %r" % m)
        for m in must_not:
            if m in out:
                why.append("输出里不该有 %r" % m)
        if why:
            bad += 1
            print("✗ %s：%s" % (name, "；".join(why)))
        else:
            print("✓ %s（退出码 %d）" % (name, got))
    print()
    print("自测 %d 条：通过 %d ｜ ⛔ 失败 %d" % (len(CASES), len(CASES) - bad, bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
