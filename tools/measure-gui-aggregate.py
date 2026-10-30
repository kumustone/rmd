#!/usr/bin/env python3
"""批次 2（`design/0002` §10.4 批 2）的**聚合与落盘**。

    python3 tools/measure-gui-aggregate.py records.tsv out.json 3 1200 Mac14,9

`records.tsv` 由 `tools/measure-gui.sh` 产出：一行一轮，`文件<TAB>样本JSON`。
本脚本只做三件事：**按文件分组 → 取中位数 → 写成一份带口径说明的 JSON**。

⚠️ 三条不能省的口径（写进结果文件的 `口径` 块里，因为**读的人不会回头看这个脚本**）：

1. **多轮取中位数**（`design/0002` §7.3.1）。单轮数字不许进结果文件。
2. **`null` 不是 0**。`r_ms` / `t6_fcp_ms` / `t6b_lcp_ms` 采不到就是 `null`
   （WebKit 上没有 `longtask`、LCP 可能压根没有条目）。中位数**只对非空的取**，
   并把**可用的轮数**单列成 `n_available`——⛔ 不把 `null` 当 0 混进中位数。
3. **⛔ 不与 CLI `bench` 的绝对时间相加**（`§7.3.1` 口径 A/B 不许混用）。
   本文件里的每一个数都来自**同一次打开、同一时间轴**。
"""

import json
import os
import sys
from datetime import datetime, timezone

# 取中位数的数值字段。⚠️ 以下字段单独处理：
#   · `NULLABLE` —— 采不到就是 null，中位数**只对非空的取**
#   · `clock_ms` —— 前端时钟刻度，全部轮次应当是同一个值，中位数即可
NULLABLE = ("r_ms", "t6_fcp_ms", "t6b_lcp_ms", "clock_ms", "t5e_ms")
NUMERIC = (
    "source_bytes", "html_bytes", "ast_nodes", "toc_entries",
    "t1_ms", "t2_ms", "t3_ms", "t4_ms", "t5_ms", "t5b_ms",
    "t5c_ms", "t5d_ms", "scroll_height", "client_height", "scroll_top",
    "doc_elements", "doc_nodes_total",
    "_wall_ms", "_peak_rmd_rss_bytes", "_peak_webcontent_rss_bytes", "_webcontent_procs_max",
) + NULLABLE
# ⚠️ **字符串**字段，⛔ 不能进 `NUMERIC`（中位数会对字符串取 `round()` 而炸）。
#    目前只有滚动容器名一个——它**每份都该是同一个值**，取首轮那个即可。
STRINGY = ("scroll_el",)


def median(values):
    """偶数个取中间两个的**均值**（`design/0002` §7.3.1 要求多轮中位数）。

    ⚠️ 这与 `cli/bench.rs` 的 `Stat` 不同——那里取**偏小**的那个。
    两处口径不一致是**故意的**：bench 的注释写了理由（更好复现、更好解释），
    而这里要的是"典型值"。⇒ ⛔ 别"顺手统一"，那会让历史数字不可比。
    """
    a = sorted(v for v in values if v is not None)
    if not a:
        return None
    n = len(a)
    mid = n // 2
    if n % 2:
        return round(a[mid], 3)
    return round((a[mid - 1] + a[mid]) / 2.0, 3)


def summarize(samples):
    med, avail = {}, {}
    for k in NUMERIC:
        vals = [s.get(k) for s in samples]
        med[k] = median(vals)
        avail[k] = sum(1 for v in vals if v is not None)
    return med, avail


def main():
    if len(sys.argv) < 6:
        print(__doc__)
        return 2
    rec_path, out_path, rounds, hold_ms, model = sys.argv[1:6]

    groups = {}
    order = []
    with open(rec_path) as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            path, js = line.split("\t", 1)
            s = json.loads(js)
            if path not in groups:
                groups[path] = []
                order.append(path)
            groups[path].append(s)

    files = []
    for path in order:
        samples = sorted(groups[path], key=lambda s: s.get("_round", 0))
        med, avail = summarize(samples)
        kind = samples[0].get("_kind", "corpus")

        # —— 派生量：只在**同一次打开的时间轴内**做加减（§7.3.1 口径 A）——
        backend = None
        if med["t1_ms"] is not None:
            backend = round((med["t1_ms"] or 0) + (med["t2_ms"] or 0) + (med["t3_ms"] or 0), 3)
        derived = {
            "backend_ms_sum_T1T2T3": backend,
            "R_ms": med["r_ms"],
            "frontend_ms_sum_T4T5T5b": (
                None if med["t4_ms"] is None
                else round(med["t4_ms"] + (med["t5_ms"] or 0) + (med["t5b_ms"] or 0), 3)
            ),
            "dom_ms_T5T5b": (
                None if med["t5_ms"] is None
                else round((med["t5_ms"] or 0) + (med["t5b_ms"] or 0), 3)
            ),
            "注": (
                "均为**同一次打开、同一时间轴**内的加减（§7.3.1 口径 A）。"
                "⛔ 不与 CLI bench 的绝对时间相加。T4 **包含后端全部耗时**——"
                "它不是『IPC 开销』，R 才是。"
            ),
        }
        if med["t4_ms"]:
            derived["backend_share_of_T4"] = round(backend / med["t4_ms"], 4)
            if med["r_ms"] is not None:
                derived["R_share_of_T4"] = round(med["r_ms"] / med["t4_ms"], 4)
        # ⭐ **滚动那半**（§10.5.3）：第一次滚到底要补的布局，除以打开时那一次 `T5b`。
        #    ⚠️ 这是本文件里**唯一**跨"两个时刻"的比——`T5b` 在打开时，`T5c` 在滚动时。
        #    两者仍在**同一次打开的时间轴内**（⛔ 没有跨进程、没有跨口径 A/B），所以合法。
        if med["t5b_ms"]:
            derived["t5c_over_t5b"] = round(med["t5c_ms"] / med["t5b_ms"], 4)

        files.append({
            "file": os.path.basename(path),
            "path": path,
            "kind": kind,
            "rounds": len(samples),
            "median": {k: med[k] for k in NUMERIC},
            "n_available": {k: avail[k] for k in NUMERIC},
            # ⚠️ 字符串字段单列（⛔ 不进 `NUMERIC`）：它每轮都该是同一个值。
            "scroll_el": samples[0].get("scroll_el", ""),
            "derived": derived,
            "samples": samples,
        })

    floor = next((f for f in files if f["kind"] == "floor"), None)
    corpus = [f for f in files if f["kind"] != "floor"]

    # ⭐ **空测量的防线**（2026-10-14 踩过这一脚）：滚动那几列**只有在真的滚动了**
    #    的前提下才有意义。第一次跑的时候滚的是 `html`（它高度=视口、从不溢出），
    #    于是 `scroll_top` 全是 0 而 `T5c`/`T5d` 全是漂亮的 0.0 —— 一份**看着对的空测量**。
    #    ⇒ 把"没滚成"的文件点名，⛔ 不许安静地进结果文件。
    vacuous = [f["file"] for f in corpus if not (f["median"]["scroll_top"] or 0) > 0]

    doc = {
        "schema": "rmd-gui-measure/1",
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "rmd_version": rmd_version(),
        "profile": "release",
        "口径": {
            "说明": (
                "design/0002 §7.3 的**口径 A · 单次打开内的分段分解**。"
                "这里的每一个数都来自同一次打开、同一时间轴（WebView 的 performance.now()），"
                "⛔ 不与 CLI bench 的绝对时间相加（§7.3.1 禁止那条算式）。"
            ),
            "T4": "调用 open_document → Promise resolve。⚠️ **包含后端全部耗时**，它不是『IPC 开销』",
            "R": "残差 = T4 − (T1+T2+T3)，**推导值**：序列化 + IPC 往返 + 反序列化。⚠️ 可以为负",
            "T5": "container.innerHTML = html 的**同步**耗时（DOM 解析 + 建节点）",
            "T5b": "强制布局（读 offsetHeight）的**同步**耗时",
            "T6": "first-contentful-paint，**相对 `rmd:boot` 那个 mark**（⛔ 不是 timeOrigin）",
            "T6b": "largest-contentful-paint，同上。⚠️ 采不到就是 null，⛔ 不填 0",
            "T5c": (
                "⭐ **滚动那半**（`design/0002` §10.5.3）：**同步**分段——"
                "跳到可滚范围的底 + 读一次 `getBoundingClientRect()`（强制布局）。"
                "⭐ 判据：**它≈0 就说明打开时那次布局已经做完了，滚到底不再补做**——"
                "那正是『分块渲染能不能靠少布局获益』的答案。"
            ),
            "T5d": (
                "**同步**分段，对称照组：再「回顶 → 再跳到底」一遍 + 强制布局。"
                "⭐ 若 `T5c` 明显大于 `T5d`，说明**只有第一次**滚到底要补做一次布局。"
            ),
            "T5e": (
                "⚠️ **异步**：从『跳到底』到**后面那一帧**的回调（`rAF` × 2）。"
                "⛔ **不在 §7.3 的同步口径里**——含绘制/合成，且被帧率量化到 **≈16.7 ms** 一档"
                "⇒ 只能读成「**一帧内画完没有**」，⛔ 不许与 `T5c`/`T5d` 相加、"
                "⛔ 不许当成『滚动耗时』。采不到是 null。"
            ),
            "scroll_el": (
                "**实际选中的滚动容器**（`html` / `body`）。⚠️⚠️ **2026-10-14 实测更正**："
                "原写『容器是 `document.scrollingElement`（`html`）』——**错**。"
                "本项目 `html, body { height:100%; overflow-y:auto }` 让 `html` 的高度"
                "**恰好等于视口** ⇒ 它从不溢出、`window.scrollTo()` **一次都没滚**，"
                "而 `scroll_height` 会安静地等于**视口高度**（实测 0.1 MB 与 10 MB 都是 769）"
                "⇒ 一份**看起来漂亮的空测量**。真正在滚的是 **`body`**。"
                "前端已改为**运行时挑真正溢出的那个**；本列是它的自证。"
            ),
            "scroll_top": (
                "这一跳**实际滚到的位置**。⭐ **它是整段滚动测量的自证**："
                "必须 ≈ `scroll_height − client_height`，**为 0 就说明没滚成**——"
                "那时 `T5c`/`T5d` 的 0 **不是结论、是空测量**（见 `scroll_el` 那条）。"
            ),
            "scroll_height / client_height": (
                "所选容器的 `scrollHeight` / `clientHeight`。⚠️ 两者**比值**才是"
                "『有多少内容在屏幕外』——只看 `scroll_height` 会把视口高度当成文档高度。"
            ),
            "t5c_over_t5b": (
                "`T5c / T5b`。⚠️ 这是本文件里**唯一**跨『两个时刻』的比（一个在打开时、一个在滚动时），"
                "但两者仍在**同一次打开的时间轴内** ⇒ 合法。`≈0` 表示滚动不重付布局。"
                "⚠️ 读它之前先确认 `scroll_top` 不为 0。"
            ),
            "doc_elements": "`#doc` 内元素数（querySelectorAll('*')）",
            "doc_nodes_total": "含文本节点的全树节点数。⭐ 这两个才是 §7.2 第 9 条要的『DOM 节点数』",
            "启动地板": (
                "`kind: \"floor\"` 那一份（1 段极小文档，写在系统临时目录，"
                "⛔ 不在仓库里）。**分析 T6/T6b 前必须先扣掉它**——"
                "不扣的话连 117 B 的文档都会显示『慢』（research/notes/0007）。"
            ),
            "长任务": (
                "⛔ WKWebView **没有 `longtask`**（kb/0003）。T5/T5b 是『这一段代码的同步耗时』，"
                "⛔ 不是『浏览器认定的 long task』——两者不是同一个量。"
            ),
            "clock_ms": (
                "**前端时钟的刻度**（`measure.js::clockResolutionMs`）。⚠️ WebKit 出于 Spectre "
                "缓解把高精度时钟**粗化**过，本机是 **1 ms**（前端那几个数全是整数，Rust 侧带小数）。"
                "⇒ `t5_ms = 0` 的含义是『**不到 1 ms**』，⛔ **不是『零成本』**——"
                "不写下来，报告里那个 0 会被当成『不用管』。"
            ),
            "合并口径": (
                "多轮取中位数（§7.3.1）；偶数个样本时取**中间两个的均值**"
                "（⚠️ 与 cli/bench 取偏小那个不同，故意如此，别统一）。"
            ),
        },
        "环境": {
            "machine_model": model,
            "arch": os.uname().machine,
            "os_release": f"{os.uname().sysname.lower()} {os.uname().machine}",
            "cpus": os.cpu_count(),
        },
        "参数": {
            "rounds": int(rounds),
            "hold_ms": int(hold_ms),
            "files": [os.path.basename(f["path"]) for f in corpus],
            "floor_fixture": "临时目录里一份 1 段的极小文档（⛔ 不在仓库里）",
            "一文件一进程": True,
        },
        "内存": {
            "注": (
                "**WebView 侧**是 macOS 侧按**进程**采的峰值（§7.3.4：没有标准 API），"
                "标的是『进程级』⛔ 不是『DOM 占用』。⚠️ 与 Rust 侧**不可加**"
                "（共享页 + 重复映射），所以这里**不给『总内存』**。"
                "⭐ 与 CLI bench 不同：那里是整个进程跑完全部文件的水位，"
                "这里是**一文件一进程**，所以每一行都是**该文件自己的峰值**。"
            ),
            "peak_rmd_rss_bytes": median([f["median"]["_peak_rmd_rss_bytes"] for f in corpus]),
            "peak_webcontent_rss_bytes": median([f["median"]["_peak_webcontent_rss_bytes"] for f in corpus]),
        },
        "启动地板": None if floor is None else {
            "wall_ms_median": floor["median"]["_wall_ms"],
            "t6_fcp_ms_median": floor["median"]["t6_fcp_ms"],
            "t6b_lcp_ms_median": floor["median"]["t6b_lcp_ms"],
            "doc_nodes_total": floor["median"]["doc_nodes_total"],
            "注": "**每个被测文件的 T6/T6b 要减去这一行**（§7.3.2 + notes/0007）。",
        },
        "空测量": vacuous,
        "文件": files,
    }

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2, sort_keys=False)
        f.write("\n")

    print_table(doc)
    print(f"\n✅ 结果写入 {out_path}")
    return 0


def rmd_version():
    here = os.path.dirname(os.path.abspath(__file__))
    cargo = os.path.join(os.path.dirname(here), "src-tauri", "Cargo.toml")
    try:
        with open(cargo) as f:
            for line in f:
                if line.startswith("version"):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return "?"


def print_table(doc):
    def g(v, d=1):
        return "-" if v is None else f"{v:.{d}f}"

    print("\n═══ 批次 2 · GUI 侧（口径 A，同一次打开内分段）═══")
    print(f"机器 {doc['环境']['machine_model']} · {doc['参数']['rounds']} 轮取中位数 · "
          f"{len(doc['参数']['files'])} 个语料")
    clock = next((f["median"]["clock_ms"] for f in doc["文件"] if f["median"]["clock_ms"]), None)
    if clock:
        print(f"⚠️ 前端时钟刻度 **{clock} ms**（WebKit 粗化）⇒ 表中 `0.0` 读作『不到一个刻度』，"
              f"⛔ 不是零成本")
    fl = doc.get("启动地板")
    if fl:
        print(f"⚠️ 启动地板（1 段文档）：墙钟 {g(fl['wall_ms_median'],0)} ms · "
              f"FCP {g(fl['t6_fcp_ms_median'],0)} · LCP {g(fl['t6b_lcp_ms_median'],0)} ms"
              f"  ⇒ **T6/T6b 要减掉这一行**")
    print()
    head = f"{'文件':<16}{'源MB':>7}{'T1+2+3':>9}{'T4':>9}{'R':>8}{'R占比':>7}{'T5':>9}{'T5b':>8}{'DOM元素':>10}{'DOM节点':>11}{'FCP':>8}{'LCP':>8}{'T5c':>8}{'T5d':>8}{'T5c/T5b':>9}{'滚到':>9}{'可滚高':>9}"
    print(head)
    print("-" * len(head))
    for f in doc["文件"]:
        if f["kind"] == "floor":
            continue
        m, d = f["median"], f["derived"]
        share = d.get("R_share_of_T4")
        ratio = d.get("t5c_over_t5b")
        print(f"{f['file']:<16}{m['source_bytes']/1048576:>7.1f}{g(d['backend_ms_sum_T1T2T3']):>9}"
              f"{g(m['t4_ms']):>9}{g(m['r_ms']):>8}"
              f"{('-' if share is None else f'{share*100:.0f}%'):>7}"
              f"{g(m['t5_ms']):>9}{g(m['t5b_ms']):>8}"
              f"{m['doc_elements']:>10}{m['doc_nodes_total']:>11}"
              f"{g(m['t6_fcp_ms'],0):>8}{g(m['t6b_lcp_ms'],0):>8}"
              f"{g(m['t5c_ms']):>8}{g(m['t5d_ms']):>8}"
              f"{('-' if ratio is None else f'{ratio:.2f}×'):>9}"
              f"{g(m['scroll_top'],0):>9}{g(m['scroll_height'],0):>9}")
    print()
    print("  单位：毫秒，除 DOM 两列、T5c/T5b、滚到、可滚高。⚠️ T4 **包含**后端耗时 ⇒ 后端占比高说明瓶颈不在 DOM。")
    print("  ⭐ T5c/T5d = 滚到底的两个**同步**分段；T5c/T5b **≈0 即『打开时那次布局已做完、"
          "滚动不重付』**。⚠️ 那三个数与 2026-10-14 那份 -gui.json **不可混读**（多采了这一段）。")
    els = sorted({f["scroll_el"] for f in doc["文件"] if f["kind"] != "floor" and f["scroll_el"]})
    if els:
        print(f"  滚动容器（实测选中）：{'、'.join(els)}  ⚠️ 判据是 **滚到 > 0**；"
              f"⛔ 滚到=0 时上面那两个 0 **不是结论、是空测量**")
    vac = doc.get("空测量") or []
    if vac:
        print()
        print(f"  ⛔⛔ **空测量**：{len(vac)} 份文件的『滚到』为 0 ⇒ 一次都没滚成，"
              f"T5c/T5d/T5e 与 T5c/T5b **全部作废**：{'、'.join(vac)}")
        print("      ⚠️ 先查 `scroll_el`：容器选错是本项目**实测踩过**的坑"
              "（`html` 高度=视口 ⇒ `window.scrollTo()` 不生效，真正在滚的是 `body`）。")
    mem = doc["内存"]
    print(f"  内存（进程级，⛔ 不可加）：rmd 中位峰值 {mem['peak_rmd_rss_bytes']/1048576:.0f} MB · "
          f"WebContent 中位峰值 {mem['peak_webcontent_rss_bytes']/1048576:.0f} MB")


if __name__ == "__main__":
    sys.exit(main())
