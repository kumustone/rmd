#!/usr/bin/env python3
"""docs/ 的机器可查结构自检（`docs/README.md` 规则 8 的落地）。

查什么（都是有限枚举 / 编号 / 固定节名，见 docs/README.md §5 与各 _TEMPLATE.md）：

  E1 文件名 `NNNN-slug.md`，四位零填充；同目录内编号不重复
  E2 头部表的必填行齐全（每条文档类型的模板里那几格）
  E3 状态词 ∈ 模板给的有限枚举（features/design/bugs/adr）
  E4 文档间 `.md` 引用（反引号里的 `./`、`../`、`docs/` 开头）能解析到文件
  E5 显式指针（design 的「被取代为」、feature 的「设计」、ADR 的 `superseded by`）指向的真有
  E6 状态与固定节名一致：design 置 `已实施` ⇒ 必须有 `## 10.` 实施记录
  E7 design 没有同号 feature 时，「对应 feature」一格必须写明理由（`无独立 feature`）
  E8 `docs/README.md` §6 的「命运表」要覆盖 docs/ 下每个目录
  E9 `docs/quality/` 能力矩阵的「合计：绿 N · 红 N · 未测 N」必须等于实数出来的格数
  E10 能力矩阵的每一行必须是 7 格、且值只许 `绿` / `红` / `未测`
  E11 能力矩阵 §4 未测清单的格数合计必须等于矩阵里的 `未测` 格数

默认口径：E1/E2/E3/E6/E7/E9/E10 是 ERROR，E4/E5/E8/E11 是 WARN（历史文档里存在大量
示例路径与待补写指针，把它们一律判红只会让人关掉闸门；§4 与矩阵的对应关系也可能
是「红格缺判据」被暂时记在未测清单里，那需要人判）。`--strict` 把 WARN 也当 ERROR。

只读：本脚本不写任何文件，不改状态（状态只能由人改）。

用法：
    python3 -I tools/docs-check.py                  # 在仓库根跑
    python3 -I tools/docs-check.py --strict
    python3 -I tools/docs-check.py --docs /tmp/mirror/docs --repo /tmp/mirror
    python3 -I tools/docs-check.py --list-warn      # 逐条列出 WARN（默认只给计数）

退出码：0 = 无 ERROR；1 = 有 ERROR；2 = 用法错误。
"""

import argparse
import os
import re
import sys

# ---------------------------------------------------------------- 模板里的枚举

ENUMS = {
    "features": {"收集中", "已立项", "已完成", "已放弃", "已取代"},
    "design": {"草稿", "待评审", "已通过", "已实施", "已否决", "已取代"},
    "bugs": {"待确认", "已确认", "修复中", "已修复", "非缺陷"},
    "vision": set(),   # 愿景文档没有状态行
    "kb": set(),       # 知识库模板没有状态行
}
ADR_STATE_RE = re.compile(r"^(proposed|accepted|deprecated|superseded by ADR-\d{4})$")

# 头部表必填行（与各 _TEMPLATE.md 对齐）。允许同义写法：模板成形之前的老文档
# 用了别的标签，但信息在（例：design 用「来源」写 feature 指针、用「评审报告」写评审）。
# 同义表只收「同一件事的另一种叫法」，⛔ 不收「干脆没有」。
REQUIRED = {
    "features": ["状态", "来源", "设计"],
    "design": ["状态", "对应 feature", "评审"],
    "bugs": ["状态", "发现于", "影响"],
    "adr": ["状态", "日期", "评审"],
    "kb": ["关键词", "适用场景", "最近核实"],
    "vision": [],
}
ALIASES = {
    "对应 feature": ["来源"],
    "评审": ["评审报告", "评审记录"],
    "设计": ["对应 design"],
    "来源": ["需求池条目"],
}

NUMBERED_DIRS = ["vision", "features", "design", "bugs", "adr", "kb"]
NAME_RE = re.compile(r"^(\d{4})-(.+)\.md$")
SKIP_NAMES = {"_TEMPLATE.md", "README.md", "catalog.md", "index.md"}

# 占位符 / 示例路径：模板与举例里本来就解析不到，不算缺陷
PLACEHOLDER = re.compile(
    r"(xxx|XXXX|NNNN|YYYY|MM-DD|<[^>]*>|…|\.\.\.|\*|\{|\}|(^|/)x\.md$|docs/设计\.md)"
)
FENCE_RE = re.compile(r"^\s*(```|~~~)")
CELL_RE = r"^\|\s*\**{name}\**\s*\|\s*(.*?)\s*\|\s*$"
DOCREF_RE = re.compile(r"`((?:\.\.?/|docs/)[^`\n]*?\.md)(?::\d+(?:-\d+)?)?`")
BACKTICK_RE = re.compile(r"`([^`\n]+)`")


class Report:
    def __init__(self):
        self.errors = []
        self.warns = []

    def error(self, path, rule, msg):
        self.errors.append((rule, path, msg))

    def warn(self, path, rule, msg):
        self.warns.append((rule, path, msg))


def read_cells(path, limit=40):
    """头部表：键 -> 值，只扫前 limit 行。

    ⚠️ 单元格的值可能换行（表里常见：`| 影响 | 一句话` 换行续写，末行才收 `|`），
    所以只要求行首是 `|`，不要求本行闭合。
    """
    cells = {}
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh):
            if i > limit:
                break
            m = re.match(r"^\|\s*\**([^|*]+?)\**\s*\|\s*(.*)$", line)
            if m and m.group(1).strip() not in ("项", "", "---"):
                # 收尾的竖线属于表格语法，不是值的一部分（空单元格会只剩一个 "|"）
                val = m.group(2).rstrip().rstrip("|").strip()
                cells.setdefault(m.group(1).strip(), val)
    return cells


def has_cell(cells, key):
    if key in cells:
        return True
    return any(a in cells for a in ALIASES.get(key, []))


def status_token(raw, kind=None):
    """状态格里的状态词。

    取值顺序：① ADR 用整句式正则；② 本类型枚举里**确实出现**的那个词（状态格
    常跟着一段解释，例如「⚠️ **已取代 → `0035`**」，此时正确的词是「已取代」，
    而不是格子里第一个反引号串）；③ 退化成「去掉标记后的第一个词」，好让
    越界的写法（如 feature 里写 `待评审`）原样报出来。
    """
    if not raw:
        return None
    if kind == "adr":
        m = re.search(r"(proposed|accepted|deprecated|superseded by ADR-\d{4})", raw)
        return m.group(1) if m else None
    enum = ENUMS.get(kind or "", set())
    hits = [(raw.find(w), w) for w in enum if w in raw]
    if hits:
        return min(hits)[1]
    # 去掉强调/反引号/表情，取第一个词；这样「⚠️ **已取代 → `0035`**」报「已取代」
    s = re.sub(r"[`*_~]|[^\w一-鿿\s]", "", raw).strip()
    m = re.match(r"([A-Za-z][A-Za-z ]*[A-Za-z]|[一-鿿]+)", s)
    if m:
        return m.group(1).strip()
    m = BACKTICK_RE.search(raw)
    return m.group(1).strip() if m else None


def check_numbering(docs, rep):
    for d in NUMBERED_DIRS:
        full = os.path.join(docs, d)
        if not os.path.isdir(full):
            continue
        seen = {}
        for name in sorted(os.listdir(full)):
            if not name.endswith(".md") or name in SKIP_NAMES:
                continue
            m = NAME_RE.match(name)
            if not m:
                rep.error(os.path.join(d, name), "E1", "文件名不是 NNNN-slug.md（四位零填充）")
                continue
            num = m.group(1)
            if num in seen:
                rep.error(
                    os.path.join(d, name), "E1",
                    "编号 %s 与 %s 重复（编号不回收，也不共用）" % (num, seen[num]),
                )
            else:
                seen[num] = name


def check_headers(docs, rep):
    for d, required in REQUIRED.items():
        full = os.path.join(docs, d)
        if not os.path.isdir(full):
            continue
        for name in sorted(os.listdir(full)):
            if not name.endswith(".md") or name in SKIP_NAMES:
                continue
            path = os.path.join(full, name)
            rel = os.path.join(d, name)
            cells = read_cells(path)
            for key in required:
                if not has_cell(cells, key):
                    alts = ALIASES.get(key)
                    hint = "（也认 %s）" % "/".join(alts) if alts else ""
                    rep.error(rel, "E2", "头部表缺必填行「%s」%s" % (key, hint))
            raw = cells.get("状态")
            if raw is None or not ENUMS.get(d):
                continue
            tok = status_token(raw, d)
            if not tok:
                rep.error(rel, "E3", "状态格为空或取不出状态词：%r" % raw[:40])
            elif d == "adr":
                if not ADR_STATE_RE.match(tok):
                    rep.error(rel, "E3", "状态 `%s` 不在 ADR 枚举 proposed/accepted/deprecated/"
                              "superseded by ADR-NNNN 内" % tok)
            elif tok not in ENUMS[d]:
                rep.warn(rel, "E3", "状态 `%s` 不在 %s 模板枚举内（%s）"
                         % (tok, d, "/".join(sorted(ENUMS[d]))))


def resolve_ref(docs, repo, rel_doc, target):
    """文档引用能不能解析：依次试「相对当前文件」「相对仓库根」「相对 docs/」。

    三种都认，是因为仓库里两种写法并存（`docs/README.md` §5 允许「相对当前文件」，
    也有不少旧文档写仓库根路径）。⚠️ 判定因此偏宽：它只证明"这个目标存在"，
    ⛔ 不证明"作者想指的正是这一份"。
    """
    here = os.path.dirname(os.path.join(docs, rel_doc))
    for cand in (os.path.join(here, target), os.path.join(repo, target),
                 os.path.join(docs, target)):
        if os.path.exists(os.path.normpath(cand)):
            return True
    return False


def check_docrefs(docs, repo, rep):
    for root, _dirs, files in os.walk(docs):
        for name in sorted(files):
            if not name.endswith(".md"):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, docs)
            in_fence = False
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    if FENCE_RE.match(line):
                        in_fence = not in_fence
                        continue
                    if in_fence:
                        continue
                    for m in DOCREF_RE.finditer(line):
                        target = m.group(1)
                        if PLACEHOLDER.search(target):
                            continue
                        if not resolve_ref(docs, repo, rel, target):
                            rep.warn(rel, "E4", "文档引用解析不到：`%s`" % target)


def check_pointers(docs, rep):
    # design「被取代为」→ design/NNNN-*.md
    ddir = os.path.join(docs, "design")
    if os.path.isdir(ddir):
        names = set(os.listdir(ddir))
        for name in sorted(names):
            if not name.endswith(".md") or name in SKIP_NAMES:
                continue
            raw = read_cells(os.path.join(ddir, name)).get("被取代为")
            if not raw:
                continue
            # 以破折号开头 = 「没有取代」（格子后面常跟一段解释，如「—（新稿；…）」）
            if raw.strip().lstrip("*").strip()[:1] in ("—", "-", "–", "无"):
                continue
            # 优先找「NNNN-…md」形态，避免把格子里第一个反引号（如 `q()`）当文件名
            m = (re.search(r"(\d{4}-[^\s`）)]*?\.md)", raw)
                 or re.search(r"`([^`\n]+?\.md)`", raw))
            if not m:
                continue
            target = m.group(1).strip()
            if PLACEHOLDER.search(target):
                continue
            if target not in names:
                rep.warn(os.path.join("design", name), "E5",
                         "「被取代为」指向不存在的文件 `%s`" % target)

    # feature「设计」→ ../design/NNNN-*.md
    fdir = os.path.join(docs, "features")
    if os.path.isdir(fdir):
        for name in sorted(os.listdir(fdir)):
            if not name.endswith(".md") or name in SKIP_NAMES:
                continue
            raw = read_cells(os.path.join(fdir, name)).get("设计")
            if not raw:
                continue
            for m in DOCREF_RE.finditer(raw):
                target = m.group(1)
                if PLACEHOLDER.search(target):
                    continue
                if not resolve_ref(docs, os.path.dirname(docs), os.path.join("features", name), target):
                    rep.warn(os.path.join("features", name), "E5",
                             "「设计」指向不存在的文件 `%s`" % target)

    # ADR「superseded by ADR-NNNN」→ 该 ADR 存在
    adir = os.path.join(docs, "adr")
    if os.path.isdir(adir):
        nums = {n[:4] for n in os.listdir(adir) if NAME_RE.match(n)}
        for name in sorted(os.listdir(adir)):
            if not name.endswith(".md") or name in SKIP_NAMES:
                continue
            tok = status_token(read_cells(os.path.join(adir, name)).get("状态", ""), "adr")
            m = re.match(r"superseded by ADR-(\d{4})$", tok or "")
            if m and m.group(1) not in nums:
                rep.warn(os.path.join("adr", name), "E5",
                         "superseded by ADR-%s，但 adr/ 里没有 %s" % (m.group(1), m.group(1)))


def check_sections(docs, rep):
    """状态与固定节名的一致性：design 置 `已实施` 就必须有 `## 10.` 实施记录。

    这是模板里唯一一条「状态 ⇒ 固定节名」的机器可查关系（`design/_TEMPLATE.md`：
    「实施完成后：回填第 10 节『实施记录』，状态改 `已实施`，此后本文件冻结」）。
    """
    ddir = os.path.join(docs, "design")
    if not os.path.isdir(ddir):
        return
    for name in sorted(os.listdir(ddir)):
        if not name.endswith(".md") or name in SKIP_NAMES:
            continue
        path = os.path.join(ddir, name)
        tok = status_token(read_cells(path).get("状态", ""), "design")
        if tok != "已实施":
            continue
        text = open(path, encoding="utf-8").read()
        if not re.search(r"^##\s*10\.", text, re.M):
            rep.error(os.path.join("design", name), "E6",
                      "状态 `已实施` 但没有 `## 10.` 实施记录")


def check_pairing(docs, rep):
    """design 与 feature 同号是默认（`docs/README.md` §5）。

    没有同号 feature 不算错（`无独立 feature` 是明文允许的），但**必须写明**
    ——「对应 feature」一格留空、又没有同号 feature，就是一份找不到需求出处的设计。
    """
    fdir, ddir = os.path.join(docs, "features"), os.path.join(docs, "design")
    if not (os.path.isdir(fdir) and os.path.isdir(ddir)):
        return
    feats = {n[:4] for n in os.listdir(fdir) if NAME_RE.match(n)}
    for name in sorted(os.listdir(ddir)):
        m = NAME_RE.match(name)
        if not m:
            continue
        num = m.group(1)
        if num in feats:
            continue
        cell = read_cells(os.path.join(ddir, name))
        raw = cell.get("对应 feature", cell.get("来源", "")).strip()
        if not raw or raw[:1] in ("—", "-", ""):
            rep.error(os.path.join("design", name), "E7",
                      "没有同号 feature（%s），且「对应 feature」一格没写理由" % num)


def check_declared(docs, rep):
    """`docs/README.md` §6 的「每份文档只有一种命运」表要覆盖 docs/ 下每个目录。

    目录存在而表里没它 ⇒ 没人知道这个目录是活文档还是冻结记录（也就没人知道
    下次该不该改它）。只报 WARN：判定「该补行还是该删目录」需要人。
    """
    readme = os.path.join(docs, "README.md")
    if not os.path.isfile(readme):
        return
    text = open(readme, encoding="utf-8").read()
    m = re.search(r"\n##\s*6\..*?(?=\n##\s|\Z)", text, re.S)
    if not m:
        rep.warn("README.md", "E8", "找不到 §6「每份文档只有一种命运」")
        return
    section = m.group(0)
    for name in sorted(os.listdir(docs)):
        if not os.path.isdir(os.path.join(docs, name)) or name.startswith("."):
            continue
        if not re.search(r"\|\s*`docs/%s(?:/\*|/|\b)" % re.escape(name), section):
            rep.warn("README.md", "E8", "§6 没有声明 `docs/%s/`" % name)


MATRIX_VALUES = ("绿", "红", "未测")
SECTION_RE = r"\n##\s*%s\.[^\n]*\n(.*?)(?=\n##\s|\Z)"


def section(text, num):
    """取 `## <num>.` 那一节；`1\\.` 不会误命中 `## 10.`。"""
    m = re.search(SECTION_RE % num, text, re.S)
    return m.group(1) if m else None


def row_cells(line):
    s = line.strip()
    if not s.startswith("|"):
        return None
    return [c.strip().strip("*`").strip() for c in s.strip("|").split("|")]


def check_quality(docs, rep):
    """能力矩阵（`docs/quality/*.md`）是**交付闸门**，表里每个值都会被人当结论用。

    它自己写着「每次更新本表都要重数，⛔ 别照抄这一行」，而重数正是机器该做的：
    E9 对数、E10 逐格取值、E11 §4 未测清单与矩阵的对应（后者可能是「红格缺判据」
    被临时记在未测里，得人判 ⇒ 只报 WARN）。
    """
    qdir = os.path.join(docs, "quality")
    if not os.path.isdir(qdir):
        return
    for name in sorted(os.listdir(qdir)):
        if not name.endswith(".md") or name in SKIP_NAMES:
            continue
        rel = os.path.join("quality", name)
        text = open(os.path.join(qdir, name), encoding="utf-8").read()
        body = section(text, 1)
        if body is None:
            continue
        counts = dict((v, 0) for v in MATRIX_VALUES)
        rows = 0
        for line in body.splitlines():
            cells = row_cells(line)
            if not cells or len(cells) < 2:
                continue
            vals = cells[1:]
            # 数据行：除首列以外的格子至少提一个状态值（表头/分隔行不会）
            if not any(any(v in c for v in MATRIX_VALUES) for c in vals):
                continue
            wrong = [c for c in vals if c not in MATRIX_VALUES]
            if len(vals) != 7 or wrong:
                rep.error(rel, "E10", "矩阵这一行不是 7 格 绿/红/未测：%s"
                          % " | ".join(cells))
                continue
            rows += 1
            for c in vals:
                counts[c] += 1
        if not rows:
            continue
        m = re.search(r"合计[^\n]*?绿\s*(\d+)[^0-9\n]*红\s*(\d+)[^0-9\n]*未测\s*(\d+)", text)
        real = (counts["绿"], counts["红"], counts["未测"])
        if not m:
            rep.error(rel, "E9", "找不到「合计：绿 N · 红 N · 未测 N」，%d 格无法对数"
                      % (rows * 7))
        else:
            claim = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
            if claim != real:
                rep.error(rel, "E9", "合计写 绿 %d · 红 %d · 未测 %d，实数 绿 %d · 红 %d · 未测 %d"
                          % (claim + real))
        body4 = section(text, 4)
        if body4 is None:
            continue
        nums = []
        for line in body4.splitlines():
            cells = row_cells(line)
            if cells and len(cells) >= 2 and re.fullmatch(r"\d+", cells[1]):
                nums.append(int(cells[1]))
        title = re.search(r"\n##\s*4\.\s*[^\n]*?（\s*(\d+)\s*格", text)
        stated = int(title.group(1)) if title else None
        if nums and sum(nums) != counts["未测"]:
            rep.warn(rel, "E11", "§4 清单格数合计 %d ≠ 矩阵里的 未测 %d（红格缺判据混进来了？）"
                     % (sum(nums), counts["未测"]))
        elif stated is not None and stated != counts["未测"]:
            rep.warn(rel, "E11", "§4 标题写着 %d 格，矩阵里 未测 是 %d 格" % (stated, counts["未测"]))


def main(argv):
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--docs", default=None, help="docs 根（默认 <repo>/docs）")
    ap.add_argument("--repo", default=None, help="仓库根（默认本脚本的上两级）")
    ap.add_argument("--strict", action="store_true", help="WARN 也当 ERROR")
    ap.add_argument("--list-warn", action="store_true", help="逐条列出 WARN")
    ap.add_argument("--list-error", action="store_true", default=True)
    args = ap.parse_args(argv)

    repo = os.path.abspath(args.repo or os.path.join(os.path.dirname(__file__), ".."))
    docs = os.path.abspath(args.docs or os.path.join(repo, "docs"))
    if not os.path.isdir(docs):
        print("docs-check: 找不到 docs 目录：%s" % docs, file=sys.stderr)
        return 2

    rep = Report()
    check_numbering(docs, rep)
    check_headers(docs, rep)
    check_docrefs(docs, repo, rep)
    check_pointers(docs, rep)
    check_sections(docs, rep)
    check_pairing(docs, rep)
    check_declared(docs, rep)
    check_quality(docs, rep)

    for rule, path, msg in rep.errors:
        print("%-5s %s  %s  %s" % ("ERROR", rule, path, msg))
    # --strict 下 WARN 就是失败项，必须逐条打出来，否则「红得没有理由」
    if args.list_warn or args.strict:
        for rule, path, msg in rep.warns:
            print("%-5s %s  %s  %s"
                  % ("ERROR" if args.strict else "WARN", rule, path, msg))

    by_rule = {}
    for rule, _p, _m in rep.warns:
        by_rule[rule] = by_rule.get(rule, 0) + 1
    warn_line = "，".join("%s×%d" % (k, by_rule[k]) for k in sorted(by_rule)) or "无"

    print("docs-check: %d 个文档目录，ERROR %d，WARN %d 处（%s）"
          % (len([d for d in NUMBERED_DIRS if os.path.isdir(os.path.join(docs, d))]),
             len(rep.errors), len(rep.warns), warn_line))
    if rep.warns and not args.list_warn and not args.strict:
        print("  ⚠️ WARN 明细：加 --list-warn；要当失败口径：加 --strict")

    failed = rep.errors or (args.strict and rep.warns)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
