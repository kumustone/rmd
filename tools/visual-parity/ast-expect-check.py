#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""夹具 AST 期望核对 ＋ §3 覆盖闸门（P-COV-01..04）。

三个用途，彼此独立；均**不启动任何 app、不跑 cargo、不写期望文件**：

  1) 默认 / `ast`：读 Stage A 载荷 `tools/visual-parity/.work/fixtures.json`，
     把每份夹具的实际顶层块种类序列与 `tools/visual-parity/fixtures-expect.json`
     的 `blocks_kind` 逐条比对，输出差异明细。
     ⛔ 载荷或期望文件不存在时**报错退出（退出码 3）**，不自动生成、不伪造期望。

  2) `gates`：按 `docs/design/0063-Mardo-端侧对照测试.md` §7.0 的 P-COV-01..04
     跑覆盖闸门，输出人类可读表格 ＋ JSON（`--json`）。
     - P-COV-01  规范章节清单 ⊆ 本设计 ID ∪ §3.6；夹具 ↔ 判据双向覆盖。
     - P-COV-02  §3.6 豁免清单非空且每条给出理由；若有 Stage A 载荷，
                 另核「每份夹具的顶层块序列 == fixtures-expect.json」。
     - P-COV-03  有效 OCR 行 / OCR 应读行数 ≥ 0.8。分母由各 `L2-OCR` 判据
                 点名的夹具行清单给出。缺外部 OCR 结果时输出 **skipped**。
     - P-COV-04  `baseline.json` 中每条 `-PARITY` 的 `provenance`/`fixture_sha256`
                 完整；采集层为 `L2-OCR` 的另须 `review` 三项齐全。
                 缺 `baseline.json` 时输出 **skipped**。

  3) `coverage`：从设计文档 §3.1–§3.5 重新生成 `tools/visual-parity/coverage.json`
     （§7.5 要求它最终成为脚本产物）；`--check` 只比对不落盘。

退出码（三处统一）：
  0 = 全部通过
  2 = 有失败
  3 = 运行前置错误（文件缺失 / 解析失败 / 参数非法）——⛔ 不等于「通过」
  4 = 无失败，但有闸门被跳过（未完成，需人工/外部数据补齐）

⛔ 本脚本从不写 `fixtures-expect.json`、不写 `baseline.json`、不写 `src/**`。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

# ── 路径 ────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parents[2]
VP_DIR = ROOT / "tools" / "visual-parity"
DESIGN = ROOT / "docs" / "design" / "0063-Mardo-端侧对照测试.md"
FIXTURES = VP_DIR / "fixtures"
WORK = VP_DIR / ".work"
PAYLOAD = WORK / "fixtures.json"
EXPECT = VP_DIR / "fixtures-expect.json"
COVERAGE = VP_DIR / "coverage.json"
BASELINE = VP_DIR / "baseline.json"

EXIT_OK, EXIT_FAIL, EXIT_ERROR, EXIT_SKIP = 0, 2, 3, 4

# 产品 `BlockKind::KIND_NAMES` 的 10 个名字（src-tauri/src/document/blocks.rs）
KIND_NAMES = [
    "Paragraph", "Heading", "CodeBlock", "List", "BlockQuote",
    "Table", "HtmlBlock", "ThematicBreak", "FootnoteDefinition", "Other",
]

FAMILIES = ("SPEC", "PARITY", "REG", "L3")
CONCLUSIONS = ("覆盖", "仅登记", "有意差异", "不适用", "不比")

#: 冻结基线（0160 §1 / §9）。
#:
#: `P-COV-01` 的核心是「规范章节清单 ⊆ 本设计 ID」，但仓内没有 CommonMark 0.31.2 /
#: GFM 的章节清单来源，只校验设计自己的 §3.7 行等于自证。这里把**当前设计**的
#: §3 判据数与 §3.7 三张矩阵表的行数冻结为常量，作用等价于 `fixtures-expect.json`：
#: 删一行、少一章、族分布变化都会让闸门报红。它不能证明「规范章节没漏」
#: （那需要一份受版本控制的规范清单，属设计决定），但能证明「设计文档相对冻结版
#: 有结构变化」，从而不再是自己证明自己。
#:
#: 更新口径：设计文档有意变更时，同一次改动里更新本常量并在提交信息里说明。
FROZEN = {
    "criteria_rows": 150,
    "criteria_expanded": 168,
    "by_family_rows": {"SPEC": 90, "PARITY": 55, "REG": 3, "L3": 2},
    "by_family_expanded": {"SPEC": 101, "PARITY": 62, "REG": 3, "L3": 2},
    "spec_matrix_rows": 43,
    "spec_matrix_groups": {"CommonMark 0.31.2": 29, "GFM 扩展": 8, "本仓扩展": 6},
    "exemptions": 11,
    "fixture_index": 20,
}

#: `-PARITY` 基线行允许的采集层（§2.9）；`L2-PIX` 等不得进基线（0160 §4）。
BASELINE_LAYERS = ("L1→L2", "L2-OCR")


def conclusion_kind(raw: str) -> str:
    """§3.7「结论」列的归一：「覆盖（经组合）」→ 覆盖；保留原始串。"""
    for k in CONCLUSIONS:
        if raw.startswith(k):
            return k
    return raw


# ══════════════════════════════════════════════════════════════════════
# 一、Markdown 表格解析
# ══════════════════════════════════════════════════════════════════════

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")


def split_row(line: str) -> list[str]:
    """按**未转义**的 `|` 切单元格。

    §3.2 的 `P-TBL-04-SPEC` 等行里有 `` `a\\|b` `` 这种转义竖线，不能当分隔符。
    """
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", s)]


def is_separator_row(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{2,}:?", c.replace(" ", "")) for c in cells)


def index_sections(lines: list[str]) -> dict[str, tuple[int, int]]:
    """返回 {标题前缀: (起始行, 结束行)}，结束行是下一个任意级标题。"""
    heads = []
    for i, ln in enumerate(lines):
        m = HEADING_RE.match(ln)
        if m:
            heads.append((i, len(m.group(1)), m.group(2).strip()))
    out: dict[str, tuple[int, int]] = {}
    for k, (i, _lvl, title) in enumerate(heads):
        end = heads[k + 1][0] if k + 1 < len(heads) else len(lines)
        # 用标题首词（如 "3.1"、"3.7.1"、"2.6"）做键
        key = title.split()[0] if title.split() else title
        out.setdefault(key, (i, end))
    return out


def parse_tables(lines: list[str]) -> list[dict]:
    """取一段区间内的所有管道表；返回 [{'header': [...], 'rows': [(行号, cells)]}]。"""
    tables: list[dict] = []
    cur: list[tuple[int, str]] = []
    for idx, ln in enumerate(lines):
        if ln.lstrip().startswith("|"):
            cur.append((idx, ln))
        elif cur:
            tables.append(cur)
            cur = []
    if cur:
        tables.append(cur)
    out = []
    for tbl in tables:
        if len(tbl) < 2:
            continue
        header = split_row(tbl[0][1])
        rows = []
        for idx, ln in tbl[1:]:
            cells = split_row(ln)
            if is_separator_row(cells):
                continue
            rows.append((idx, cells))
        out.append({"header": header, "rows": rows})
    return out


def find_table(lines: list[str], first_header: str) -> dict | None:
    for t in parse_tables(lines):
        if t["header"] and t["header"][0] == first_header:
            return t
    return None


def strip_ticks(s: str) -> str:
    return s.strip().replace("`", "").strip()


# ══════════════════════════════════════════════════════════════════════
# 二、判据 ID / 夹具行的机读化
# ══════════════════════════════════════════════════════════════════════

def family_of(cid: str) -> str | None:
    tail = cid.rsplit("-", 1)[-1]
    return tail if tail in FAMILIES else None


def expand_id(cid: str) -> list[str]:
    """把 `P-H-01/02/03-SPEC` 展开成三条独立 ID；单条 ID 原样返回。"""
    parts = cid.split("-")
    fam = parts[-1] if parts[-1] in FAMILIES else None
    body = parts[:-1] if fam else parts
    num_idx = next((i for i, p in enumerate(body) if re.fullmatch(r"\d+(?:/\d+)*", p)), None)
    if num_idx is None:
        return [cid]
    prefix, nums, tail = body[:num_idx], body[num_idx].split("/"), body[num_idx + 1:]
    out = []
    for n in nums:
        atom = "-".join(prefix + [n] + tail + ([fam] if fam else []))
        out.append(atom)
    return out


def normalize_layer(raw: str) -> tuple[str, list[str]]:
    """把 §3 的「层」列归一成 L1/L2/L3（判定层）＋完整层清单。

    规则（与 design/0063 §2.1/§3.0 对齐）：
      `L1→L2`      → 判定层 L2（L1 采集、采后转常驻），层清单 [L1, L2]
      `L1 登记`    → L1（只登记，无 L2 判读）
      `L2-DOM` / `L2-PIX` / `L2-OCR` → L2
      `L3`         → L3
      `L2-DOM / L3` 这类复合 → 判定层 L2，层清单 [L2, L3]
      `不比`        → 无判定层（§3.0 允许），返回 ("", []) 且由调用方接受
    """
    if strip_ticks(raw) == "不比":
        return "", []
    tokens: list[str] = []
    if "L1→L2" in raw.replace(" ", ""):
        tokens = ["L1", "L2"]
    else:
        if "L1" in raw:
            tokens.append("L1")
        if re.search(r"L2-(DOM|PIX|OCR)", raw):
            tokens.append("L2")
        if re.search(r"(?<![\w])L3", raw):
            tokens.append("L3")
    if not tokens:
        return "", []
    if tokens == ["L1"]:
        primary = "L1"
    elif "L2" in tokens:
        primary = "L2"
    elif "L3" in tokens:
        primary = "L3"
    else:
        primary = "L1"
    return primary, tokens


FREF_RE = re.compile(r"F(\d+)([a-z]?)/(\d+)(?:-(\d+))?")
FONLY_RE = re.compile(r"F(\d+)([a-z]?)(?=/|\b|、|；|，|$)")


def fixture_stem(code: str, suffix: str) -> str:
    """F4a → 04a；F0 → 00。"""
    return f"{int(code):02d}{suffix}"


_FILE_MAP: dict[str, str] | None = None


def fixture_file_map() -> dict[str, str]:
    """数字前缀 → 磁盘文件名，如 `04a` → `04a-lists-basic.md`。"""
    global _FILE_MAP
    if _FILE_MAP is None:
        _FILE_MAP = {}
        if FIXTURES.is_dir():
            for p in sorted(FIXTURES.glob("*.md")):
                _FILE_MAP[p.name.split("-")[0]] = p.name
    return _FILE_MAP


def fixture_file(stem: str) -> str:
    return fixture_file_map().get(stem, f"{stem}.md")


def parse_fixture_refs(raw: str, indexed_only: bool = False) -> list[dict]:
    """解析「夹具·行」单元格，返回 [{code, stem, file, start, end, raw}]。

    `indexed_only=True` 时只认带行号的 `F<n>/<行>` 形式（§3 判据表的写法）。
    """
    refs: list[dict] = []
    if indexed_only:
        for m in FREF_RE.finditer(raw):
            code, suffix, start, end = m.group(1), m.group(2), int(m.group(3)), m.group(4)
            stem = fixture_stem(code, suffix)
            refs.append({
                "code": f"F{code}{suffix}",
                "file": fixture_file(stem),
                "start": start,
                "end": int(end) if end else start,
                "raw": m.group(0),
            })
        return refs
    seen = set()
    for m in FONLY_RE.finditer(raw):
        code, suffix = m.group(1), m.group(2)
        key = f"F{code}{suffix}"
        if key in seen:
            continue
        seen.add(key)
        refs.append({"code": key, "file": fixture_file(fixture_stem(code, suffix)),
                     "start": None, "end": None, "raw": key})
    return refs


def expand_ref(ref: str) -> list[str]:
    """§3.7「判据 ID」列的写法 → 可比对的前缀串列表。

    `P-H-01..07` → P-H-01 … P-H-07；`P-C-*` → 前缀 `P-C-`；`P-RULE-01/02/03` → 三条。
    """
    ref = strip_ticks(ref)
    if not ref:
        return []
    if ref.endswith("*"):
        return [ref[:-1]]
    m = re.fullmatch(r"(.*?)(\d+)\.\.(\d+)", ref)
    if m:
        width = len(m.group(2))
        return [f"{m.group(1)}{n:0{width}d}" for n in range(int(m.group(2)), int(m.group(3)) + 1)]
    parts = ref.split("/")
    if len(parts) > 1 and all(re.fullmatch(r"\d+", p) for p in parts[1:]):
        m2 = re.fullmatch(r"(.*?)(\d+)", parts[0])
        if m2:
            width = len(m2.group(2))
            return [parts[0]] + [f"{m2.group(1)}{int(p):0{width}d}" for p in parts[1:]]
    return [p for p in parts if p]


def ref_matches(ref: str, atom: str) -> bool:
    if ref.endswith("-"):
        return atom.startswith(ref)
    return atom == ref or atom.startswith(ref + "-")


def criterion_tokens(cell: str) -> list[str]:
    """§3.7「判据 ID」列 → 干净的 ID 串列表。

    处理：反引号、`、；，,;` 分隔、行内括注（如「（编辑回读移 §4 `P-D3-03`）」）、
    `P-RULE-01/02/03` 这类复合写法（交给 expand_ref 展开）。
    """
    out = []
    for tok in re.split(r"[、；，,;]", strip_ticks(cell)):
        tok = re.split(r"[（(]", tok)[0].strip()
        if tok.startswith("P-"):
            out.append(tok)
    return out


# ══════════════════════════════════════════════════════════════════════
# 三、从设计文档生成 coverage.json
# ══════════════════════════════════════════════════════════════════════

def build_coverage(text: str, design_sha: str) -> dict:
    lines = text.splitlines()
    secs = index_sections(lines)

    def sec(key: str) -> list[str]:
        if key not in secs:
            raise SystemExit(f"⛔ 设计文档缺小节 §{key}")
        s, e = secs[key]
        return lines[s:e]

    criteria: list[dict] = []
    for sec_key in ("3.1", "3.2", "3.3", "3.4", "3.5"):
        block = sec(sec_key)
        tbl = find_table(block, "判据 ID")
        if tbl is None:
            raise SystemExit(f"⛔ §{sec_key} 找不到「判据 ID」表")
        base = secs[sec_key][0]
        for idx, cells in tbl["rows"]:
            if len(cells) < 8:
                raise SystemExit(f"⛔ §{sec_key} 第 {base + idx + 1} 行列数不足 8：{cells}")
            cid = strip_ticks(cells[0])
            fam = family_of(cid)
            if fam is None:
                raise SystemExit(f"⛔ 判据 ID 无合法族后缀（{FAMILIES}）：{cid}")
            atoms = expand_id(cid)
            refs = parse_fixture_refs(cells[2], indexed_only=True)
            layer_raw = cells[6]
            layer, layers = normalize_layer(layer_raw)
            if not layer and strip_ticks(layer_raw) != "不比":
                raise SystemExit(f"⛔ 无法归一「层」列：{cid} / {layer_raw!r}")
            criteria.append({
                "id": cid,
                "expanded_ids": atoms,
                "family": fam,
                "syntax_item": cells[1],
                "criterion": cells[5],          # 期望来源（族）
                "observable": cells[4],         # 可观测的量
                "measure": cells[3],            # 量法 M1–M8
                "layer": layer,
                "layers": layers,
                "layer_raw": layer_raw,
                "tolerance": cells[7],
                "notes": cells[8] if len(cells) > 8 else "",
                "fixture_refs": [r["raw"] for r in refs],
                "fixtures": sorted({r["file"] for r in refs}),
                "state": "declared",
                "source": {
                    "section": f"§{sec_key}",
                    "line": base + idx + 1,
                },
            })

    # §3.6 豁免清单
    exemptions = []
    tbl = find_table(sec("3.6"), "项")
    if tbl is None:
        raise SystemExit("⛔ §3.6 找不到「项」表")
    base = secs["3.6"][0]
    for idx, cells in tbl["rows"]:
        exemptions.append({
            "item": cells[0],
            "stance": cells[1] if len(cells) > 1 else "",
            "reason": cells[2] if len(cells) > 2 else "",
            "source": {"section": "§3.6", "line": base + idx + 1},
        })

    # §3.7 规范覆盖矩阵
    matrix = []
    for key, group in (("3.7.1", "CommonMark 0.31.2"),
                       ("3.7.2", "GFM 扩展"),
                       ("3.7.3", "本仓扩展")):
        block = sec(key)
        tbl = parse_tables(block)[0]
        base = secs[key][0]
        header = tbl["header"]
        for idx, cells in tbl["rows"]:
            if len(header) == 5:
                chapter, item, conclusion, ids, fixtures = cells[:5]
            elif len(header) == 4:
                chapter, item, conclusion, ids, fixtures = "", cells[0], cells[1], cells[2], cells[3]
            else:
                raise SystemExit(f"⛔ §{key} 表头列数异常：{header}")
            matrix.append({
                "group": group,
                "chapter": chapter,
                "item": item,
                "conclusion": strip_ticks(conclusion),
                "conclusion_kind": conclusion_kind(strip_ticks(conclusion)),
                "criterion_ids_raw": ids,
                "fixture_refs_raw": fixtures,
                "source": {"section": f"§{key}", "line": base + idx + 1},
            })

    # §2.6 夹具索引
    index_rows = []
    tbl = find_table(sec("2.6"), "夹具")
    if tbl is not None:
        base = secs["2.6"][0]
        for idx, cells in tbl["rows"]:
            name = strip_ticks(cells[0])
            if not name.endswith(".md"):
                continue
            src_lines = cells[2] if len(cells) > 2 else ""
            index_rows.append({
                "fixture": name,
                "intent": cells[1] if len(cells) > 1 else "",
                "source_lines": int(src_lines) if src_lines.isdigit() else None,
                "source": {"section": "§2.6", "line": base + idx + 1},
            })

    fam_rows: dict[str, int] = {f: 0 for f in FAMILIES}
    fam_atoms: dict[str, int] = {f: 0 for f in FAMILIES}
    layer_rows: dict[str, int] = {k: 0 for k in ("L1", "L2", "L3")}
    layer_any: dict[str, int] = {k: 0 for k in ("L1", "L2", "L3")}
    for c in criteria:
        fam_rows[c["family"]] += 1
        fam_atoms[c["family"]] += len(c["expanded_ids"])
        if c["layer"] in layer_rows:
            layer_rows[c["layer"]] += 1
        for lv in set(c["layers"]):
            layer_any[lv] = layer_any.get(lv, 0) + 1

    return {
        "schema": "rmd.visual-parity.coverage/1",
        "source": {
            "design": str(DESIGN.relative_to(ROOT)),
            "design_sha256": design_sha,
            "sections": ["3.1", "3.2", "3.3", "3.4", "3.5"],
            "note": "本文件由 ast-expect-check.py coverage 从设计文档生成；⛔ 不手改。",
        },
        "summary": {
            "total_criteria": len(criteria),
            "total_expanded_ids": sum(len(c["expanded_ids"]) for c in criteria),
            "by_family_rows": fam_rows,
            "by_family_expanded": fam_atoms,
            "by_layer_rows": layer_rows,
            "by_layer_any": layer_any,
        },
        "field_map": {
            "id": "§3 表「判据 ID」列原文；复合写法（如 P-H-01/02/03-SPEC）不拆，拆开见 expanded_ids",
            "family": "ID 末尾的族：SPEC / PARITY / REG / L3",
            "syntax_item": "§3.1–§3.4「语法项」列；§3.5 取「组合」列",
            "criterion": "§3 表「期望来源（族）」列（SPEC 出处 / PARITY 基线 / 契约 / 有意差异）",
            "observable": "§3 表「可观测的量」列",
            "measure": "§3 表「量法」列（M1–M8，含 M3＋M1 这类组合）",
            "layer": "「层」列归一后的判定层（L1/L2/L3）；L1→L2 记为 L2（L1 采集），原文见 layer_raw",
            "state": "固定 declared：本文件只声明判据，不记录采集/通过状态",
        },
        "criteria": criteria,
        "spec_matrix": matrix,
        "exemptions": exemptions,
        "fixture_index": index_rows,
    }


def load_design() -> tuple[str, str]:
    if not DESIGN.is_file():
        raise SystemExit(f"⛔ 缺设计文档：{DESIGN}")
    raw = DESIGN.read_bytes()
    return raw.decode("utf-8"), hashlib.sha256(raw).hexdigest()


def dump_json(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


# ══════════════════════════════════════════════════════════════════════
# 四、AST 期望核对
# ══════════════════════════════════════════════════════════════════════

class InputError(Exception):
    """输入文件不可读/畸形：必须映射到契约内的 EXIT_ERROR(3)，⛔ 不许 traceback 退 1。"""


def read_json(path: Path) -> dict:
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as exc:
        raise InputError(f"{path}: {exc}") from exc
    if not isinstance(data, (dict, list)):
        raise InputError(f"{path}: 顶层既不是对象也不是数组（{type(data).__name__}）")
    return data


def ast_check(payload_path: Path, expect_path: Path, fixture_dir: Path) -> int:
    missing = [str(p) for p in (payload_path, expect_path) if not p.is_file()]
    if missing:
        print("⛔ 前置产物不存在，拒绝伪造期望：", file=sys.stderr)
        for p in missing:
            print(f"   - {p}", file=sys.stderr)
        if payload_path in [Path(p) for p in missing]:
            print("   ⚠️ Stage A 载荷应由 tools/visual-parity/export-fixtures.sh 生成；"
                  "本脚本只读，不代跑 cargo。", file=sys.stderr)
        return EXIT_ERROR

    payload = read_json(payload_path)
    expect = read_json(expect_path)
    docs = {d.get("name"): d for d in payload.get("docs") or []}

    rows = []
    diffs = []
    problems = 0

    for key in sorted(expect):
        stem = key[:-3] if key.endswith(".md") else key
        exp = expect[key]
        exp_kinds = exp.get("blocks_kind")
        if stem not in docs:
            rows.append((key, len(exp_kinds or []), 0, "缺载荷", "载荷里没有这份夹具"))
            diffs.append(f"{key}：fixtures-expect.json 有，但 .work/fixtures.json 里没有对应 doc")
            problems += 1
            continue
        doc = docs[stem]
        table = doc.get("block_kinds") or KIND_NAMES
        kinds = []
        bad_idx = None
        for b in doc.get("blocks") or []:
            idx = b[0] if isinstance(b, list) and b else None
            if not isinstance(idx, int) or not (0 <= idx < len(table)):
                bad_idx = b
                break
            kinds.append(table[idx])
        if bad_idx is not None:
            rows.append((key, len(exp_kinds or []), 0, "载荷非法", f"非法 kind_idx：{bad_idx!r}"))
            diffs.append(f"{key}：载荷 blocks 出现非法 kind_idx {bad_idx!r}")
            problems += 1
            continue

        if exp_kinds is None:
            rows.append((key, 0, len(kinds), "无期望", "blocks_kind 为 null"))
            diffs.append(f"{key}：fixtures-expect.json 的 blocks_kind 为 null，无法比对")
            problems += 1
            continue

        ok = kinds == exp_kinds
        first = next((i for i, (a, b) in enumerate(zip(kinds, exp_kinds)) if a != b), None)
        if ok and len(kinds) == len(exp_kinds):
            rows.append((key, len(exp_kinds), len(kinds), "一致", "-"))
        else:
            where = "-"
            if first is not None:
                where = f"第 {first} 块：期望 {exp_kinds[first]} / 实际 {kinds[first]}"
            elif len(kinds) != len(exp_kinds):
                where = f"块数不同（期望 {len(exp_kinds)} / 实际 {len(kinds)}）"
            rows.append((key, len(exp_kinds), len(kinds), "不一致", where))
            diffs.append(
                f"{key}\n"
                f"  期望：{exp_kinds}\n"
                f"  实际：{kinds}\n"
                f"  首个差异：{where}"
            )
            problems += 1

        # 夹具漂移：SHA 与期望记录不符 ⇒ 期望过期（§3.7 AST 断言 / P-ENV-05 的前置）
        md = fixture_dir / key
        if md.is_file() and exp.get("sha256"):
            actual_sha = hashlib.sha256(md.read_bytes()).hexdigest()
            if actual_sha != exp["sha256"]:
                diffs.append(f"{key}：夹具 sha256 与期望记录不符（期望 {exp['sha256'][:12]}… / "
                             f"实际 {actual_sha[:12]}…）")
                problems += 1

    for stem in sorted(set(docs) - {k[:-3] if k.endswith(".md") else k for k in expect}):
        diffs.append(f"{stem}：载荷里有，但 fixtures-expect.json 里没有对应条目")
        problems += 1

    # ── 人类可读输出 ────────────────────────────────────────────────────
    print("夹具顶层块种类序列核对（Stage A 载荷 vs fixtures-expect.json）")
    print(f"  载荷：{payload_path}")
    print(f"  期望：{expect_path}")
    print()
    headers = ("夹具", "期望块数", "实际块数", "结果", "首个差异")
    widths = [24, 8, 8, 10, 0]
    print("  " + "  ".join(pad(h, w) for h, w in zip(headers, widths)))
    for name, ne, na, res, where in rows:
        print("  " + "  ".join(pad(str(v), w) for v, w in zip((name, ne, na, res, where), widths)))

    if diffs:
        print()
        print("差异明细：")
        for d in diffs:
            print(f"  - {d}")

    print()
    if problems:
        print(f"❌ {problems} 处不一致：期望来自 fixtures-expect.json，"
              f"⛔ 不得改夹具或改期望迁就（design/0063 §2.6）")
        return EXIT_FAIL
    print(f"✅ {len(rows)} 份夹具块序列与期望一致")
    return EXIT_OK


# ══════════════════════════════════════════════════════════════════════
# 五、覆盖闸门 P-COV-01..04
# ══════════════════════════════════════════════════════════════════════

class Report:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(self, gate: str, check: str, status: str, detail: str, data=None) -> None:
        self.items.append({"gate": gate, "check": check, "status": status,
                           "detail": detail, "data": data})

    def counts(self) -> dict[str, int]:
        c = {"PASS": 0, "FAIL": 0, "SKIP": 0, "WARN": 0}
        for it in self.items:
            c[it["status"]] = c.get(it["status"], 0) + 1
        return c

    def exit_code(self) -> int:
        c = self.counts()
        if c["FAIL"]:
            return EXIT_FAIL
        # 0160 §6：WARN 过去只计数、不影响退出码 ⇒ 悬空判据 ID 能带着全绿退出。
        # 现在 WARN 与 SKIP 同属「未完成」，返回契约内的 4（⛔ 不是 0）。
        if c["WARN"] or c["SKIP"]:
            return EXIT_SKIP
        return EXIT_OK


def fixture_line_count(path: Path) -> int:
    return len(path.read_text(encoding="utf-8").splitlines())


def gate_01(rep: Report, coverage: dict, generated: dict) -> dict:
    gate = "P-COV-01"
    lines = generated["spec_matrix"]
    ex = generated["criteria"]

    # 01·0 冻结基线：设计文档相对冻结版必须有相同结构（删章/删行/族漂移都红）。
    summary = generated["summary"]
    groups: dict[str, int] = {}
    for row in lines:
        groups[row["group"]] = groups.get(row["group"], 0) + 1
    drift = []
    if summary["total_criteria"] != FROZEN["criteria_rows"]:
        drift.append(f"判据行 {summary['total_criteria']} ≠ 冻结 {FROZEN['criteria_rows']}")
    if summary["total_expanded_ids"] != FROZEN["criteria_expanded"]:
        drift.append(f"展开 ID {summary['total_expanded_ids']} ≠ 冻结 {FROZEN['criteria_expanded']}")
    for fam, want in FROZEN["by_family_rows"].items():
        got = summary["by_family_rows"].get(fam, 0)
        if got != want:
            drift.append(f"{fam} 行 {got} ≠ 冻结 {want}")
    for fam, want in FROZEN["by_family_expanded"].items():
        got = summary["by_family_expanded"].get(fam, 0)
        if got != want:
            drift.append(f"{fam} 展开 {got} ≠ 冻结 {want}")
    if len(lines) != FROZEN["spec_matrix_rows"]:
        drift.append(f"§3.7 矩阵行 {len(lines)} ≠ 冻结 {FROZEN['spec_matrix_rows']}")
    for group, want in FROZEN["spec_matrix_groups"].items():
        got = groups.get(group, 0)
        if got != want:
            drift.append(f"§3.7 {group} 行 {got} ≠ 冻结 {want}")
    if len(generated["exemptions"]) != FROZEN["exemptions"]:
        drift.append(f"§3.6 豁免 {len(generated['exemptions'])} ≠ 冻结 {FROZEN['exemptions']}")
    if len(generated["fixture_index"]) != FROZEN["fixture_index"]:
        drift.append(f"§2.6 夹具索引 {len(generated['fixture_index'])} ≠ 冻结 {FROZEN['fixture_index']}")
    rep.add(gate, "frozen-baseline", "FAIL" if drift else "PASS",
            "设计结构与冻结基线一致" if not drift
            else "设计结构相对冻结基线漂移：" + "；".join(drift),
            data={"drift": drift, "frozen": FROZEN})

    # 01·1 §3.7 每行结论必须在四选一（＋§3.6 口径的「不比」）内
    bad = [r for r in lines if r["conclusion_kind"] not in CONCLUSIONS]
    rep.add(gate, "3.7-conclusion",
            "FAIL" if bad else "PASS",
            f"§3.7 共 {len(lines)} 行；结论越界 {len(bad)} 行",
            data=[{"line": r["source"]["line"], "conclusion": r["conclusion"]} for r in bad])

    # 01·2 标「覆盖」的行必须给出判据 ID 与夹具行
    bad = [r for r in lines if r["conclusion_kind"] == "覆盖"
           and (not strip_ticks(r["criterion_ids_raw"]) or not strip_ticks(r["fixture_refs_raw"]))]
    rep.add(gate, "3.7-cover-rows",
            "FAIL" if bad else "PASS",
            f"「覆盖」行 {sum(1 for r in lines if r['conclusion_kind'] == '覆盖')} 行；"
            f"缺 ID/夹具 {len(bad)} 行",
            data=[{"line": r["source"]["line"], "item": r["item"]} for r in bad])

    # 01·2b §3.0：夹具·行、量法、可观测的量、期望来源、层、容差缺一不算「可执行判据」
    required = [
        ("fixture_refs", "夹具·行"), ("measure", "量法"), ("observable", "可观测的量"),
        ("criterion", "期望来源"), ("layer", "层"), ("tolerance", "容差"),
    ]
    incomplete = []
    for c in ex:
        miss = []
        for key, label in required:
            val = c[key]
            if isinstance(val, list):
                if not val:
                    miss.append(label)
            elif not str(val).strip() or str(val).strip() in ("—", "-"):
                miss.append(label)
        if miss:
            incomplete.append({"id": c["id"], "missing": miss})
    rep.add(gate, "criteria-completeness", "FAIL" if incomplete else "PASS",
            f"{len(ex)} 条判据；六要素不全 {len(incomplete)} 条", data=incomplete)

    # 01·3 §3.7 引用的 ID 必须能落到 §3 判据；§4 的 P-D* 与「—」占位不在本闸门范围
    atom_set = {a for c in ex for a in c["expanded_ids"]}
    unresolved = []
    for r in lines:
        tokens = criterion_tokens(r["criterion_ids_raw"])
        for tok in tokens:
            if not tok.startswith("P-"):
                continue
            for ref in expand_ref(tok):
                # §4 的 `P-D3-03` 不在 §3 判据表；精确到 `P-D<数字>`，
                # ⛔ 不用 `startswith("P-D")`（那会把 §3.7.2 的 `P-DEL-01/02` 也跳过）。
                if re.match(r"^P-D\d", ref):
                    continue
                if not any(ref_matches(ref, a) for a in atom_set):
                    unresolved.append({"line": r["source"]["line"], "item": r["item"],
                                       "ref": ref, "conclusion": r["conclusion"]})
    hard = [u for u in unresolved if u["conclusion"].startswith("覆盖")]
    soft = [u for u in unresolved if not u["conclusion"].startswith("覆盖")]
    if hard:
        rep.add(gate, "3.7-ids-resolve", "FAIL",
                f"「覆盖」行引用 {len(hard)} 个不存在的判据 ID", data=hard)
    elif soft:
        rep.add(gate, "3.7-ids-resolve", "WARN",
                f"「覆盖」行全部可解析；非「覆盖」行有 {len(soft)} 个悬空引用（见 data）",
                data=soft)
    else:
        rep.add(gate, "3.7-ids-resolve", "PASS",
                f"§3.7 引用的判据 ID 全部落在 §3 判据表内（§4 的 P-D* 不计入）")

    # 01·4 coverage.json 必须是设计文档的确定性产物
    # 0160 §9：整对象比较会把 `source.design_sha256` 这种元数据漂移也算成不同步，
    # 而真正要盯的是**内容**（判据/矩阵/豁免/夹具索引）。因此只比内容四段。
    content_keys = ("criteria", "spec_matrix", "exemptions", "fixture_index", "summary")
    if coverage:
        same = all(coverage.get(k) == generated.get(k) for k in content_keys)
        differing = [k for k in content_keys if coverage.get(k) != generated.get(k)]
    else:
        same = False
        differing = list(content_keys)
    detail = "coverage.json 与设计文档展开一致（内容四段）"
    if not same and coverage:
        cids = [c["id"] for c in coverage.get("criteria", [])]
        gids = [c["id"] for c in generated["criteria"]]
        detail = (f"coverage.json 与设计不同步：条目 {len(cids)} vs {len(gids)}；"
                  f"不一致段 {differing}")
    rep.add(gate, "coverage-sync", "PASS" if same else "FAIL",
            detail if coverage else "coverage.json 不存在（先跑 coverage 子命令）")

    # 01·5 §2.6 夹具索引 vs 磁盘上的夹具
    disk = sorted(p.name for p in FIXTURES.glob("*.md"))
    indexed = sorted(r["fixture"] for r in generated["fixture_index"])
    missing_on_disk = [n for n in indexed if n not in disk]
    missing_in_index = [n for n in disk if n not in indexed]
    line_mismatch = []
    for r in generated["fixture_index"]:
        p = FIXTURES / r["fixture"]
        if p.is_file() and r["source_lines"] is not None:
            actual = fixture_line_count(p)
            if actual != r["source_lines"]:
                line_mismatch.append({"fixture": r["fixture"],
                                      "index_lines": r["source_lines"], "actual": actual})
    ok = not missing_on_disk and not missing_in_index and not line_mismatch
    rep.add(gate, "fixture-inventory", "PASS" if ok else "FAIL",
            f"磁盘 {len(disk)} 份 / §2.6 索引 {len(indexed)} 份；"
            f"索引有磁盘无 {len(missing_on_disk)}，磁盘有索引无 {len(missing_in_index)}，"
            f"源行数不符 {len(line_mismatch)}",
            data={"missing_on_disk": missing_on_disk, "missing_in_index": missing_in_index,
                  "line_mismatch": line_mismatch})

    # 01·6 每条判据至少被一份夹具触达（夹具文件真实存在且行号在范围内）
    bad_refs = []
    no_fixture = []
    for c in ex:
        if not c["fixture_refs"]:
            no_fixture.append(c["id"])
            continue
        for ref in parse_fixture_refs("、".join(c["fixture_refs"]), indexed_only=True):
            path = FIXTURES / ref["file"]
            if not path.is_file():
                bad_refs.append({"id": c["id"], "ref": ref["raw"], "why": "夹具文件不存在"})
                continue
            n = fixture_line_count(path)
            if ref["start"] < 1 or ref["end"] > n:
                bad_refs.append({"id": c["id"], "ref": ref["raw"],
                                 "why": f"行号越界（文件共 {n} 行）"})
    ok = not bad_refs and not no_fixture
    rep.add(gate, "criteria-to-fixtures", "PASS" if ok else "FAIL",
            f"{len(ex)} 条判据；无夹具 {len(no_fixture)} 条；夹具/行号无效 {len(bad_refs)} 处",
            data={"no_fixture": no_fixture, "bad_refs": bad_refs})

    # 01·7 每份夹具至少承载一条判据（§3 判据表 ∪ §3.7 矩阵的并集）
    from_criteria = {f for c in ex for f in c["fixtures"]}
    from_matrix = {r["file"] for row in lines
                   for r in parse_fixture_refs(row["fixture_refs_raw"])}
    union = from_criteria | from_matrix
    orphans = [n for n in disk if n not in union]
    only_matrix = sorted(from_criteria ^ union)
    rep.add(gate, "fixtures-to-criteria", "FAIL" if orphans else "PASS",
            f"{len(disk)} 份夹具；无任何判据归属 {len(orphans)} 份"
            + (f"（仅由 §3.7 矩阵触达：{'、'.join(only_matrix)}）" if only_matrix else ""),
            data={"orphans": orphans, "only_matrix": only_matrix})

    # 01·8 反向提示：判据是否被 §3.7 矩阵引用（只提示，不判红）
    cited = set()
    for row in lines:
        tokens = criterion_tokens(row["criterion_ids_raw"])
        for tok in tokens:
            for ref in expand_ref(tok):
                for a in atom_set:
                    if ref_matches(ref, a):
                        cited.add(a)
    uncited = sorted(a for a in atom_set if a not in cited)
    rep.add(gate, "criteria-cited-by-3.7",
            "WARN" if uncited else "PASS",
            f"{len(atom_set)} 条展开 ID 中 {len(uncited)} 条未被 §3.7 矩阵点名",
            data=uncited)

    # ── 四项报告数字 ────────────────────────────────────────────────────
    by_syntax: dict[str, list[str]] = {}
    for c in ex:
        by_syntax.setdefault(c["syntax_item"], []).append(c["id"])
    syntax_no_fixture = sorted(
        item for item, ids in by_syntax.items()
        if not any(c["fixture_refs"] for c in ex if c["id"] in ids)
    )
    return {
        "total_criteria": len(ex),
        "total_expanded_ids": sum(len(c["expanded_ids"]) for c in ex),
        "by_family_rows": generated["summary"]["by_family_rows"],
        "by_family_expanded": generated["summary"]["by_family_expanded"],
        "by_layer_rows": generated["summary"]["by_layer_rows"],
        "syntax_items_total": len(by_syntax),
        "syntax_items_without_fixture": syntax_no_fixture,
        "fixtures_total": len(disk),
        "fixtures_without_criteria": orphans,
        "fixtures_only_via_matrix": only_matrix,
        "criteria_without_fixture": no_fixture,
        "criteria_with_bad_fixture_ref": bad_refs,
    }


def gate_02(rep: Report, generated: dict, payload_path: Path, expect_path: Path) -> None:
    gate = "P-COV-02"
    ex_rows = generated["exemptions"]
    empty = [e for e in ex_rows if not e["reason"].strip()]
    rep.add(gate, "3.6-exemptions",
            "FAIL" if (not ex_rows or empty) else "PASS",
            f"§3.6 豁免 {len(ex_rows)} 条；缺理由 {len(empty)} 条",
            data={"empty_reason": [e["item"] for e in empty]})

    if not payload_path.is_file():
        rep.add(gate, "fixture-block-sequence", "FAIL",
                f"缺载荷 {payload_path}（Stage A 未生成）⇒ 无法核对块序列，"
                "⛔ 不记 SKIP 蒙混",
                data={"payload": str(payload_path)})
        return
    if not expect_path.is_file():
        rep.add(gate, "fixture-block-sequence", "FAIL",
                f"缺 {expect_path} ⇒ 期望未冻结，⛔ 不能记「核对 0 份」通过",
                data={"expect": str(expect_path)})
        return

    payload = read_json(payload_path)
    expect = read_json(expect_path)
    if not isinstance(expect, dict) or not expect:
        rep.add(gate, "fixture-block-sequence", "FAIL",
                "fixtures-expect.json 为空或不是对象：等价于期望全缺（⛔ 不能 PASS）",
                data={"expect_type": type(expect).__name__})
        return

    docs = {d.get("name"): d for d in payload.get("docs") or [] if isinstance(d, dict)}
    disk = sorted(p.name[:-3] if p.name.endswith(".md") else p.name
                  for p in FIXTURES.glob("*.md"))
    expect_stems = sorted(k[:-3] if k.endswith(".md") else k for k in expect)

    bad = []
    # 02·a 双向清点：期望有磁盘无、磁盘有期望无，都必须点名。
    missing_on_disk = [s for s in expect_stems if s not in disk]
    missing_in_expect = [s for s in disk if s not in expect_stems]
    if missing_on_disk:
        bad.append("期望里有磁盘不存在的夹具：" + "、".join(missing_on_disk))
    if missing_in_expect:
        bad.append("磁盘上有期望未冻结的夹具：" + "、".join(missing_in_expect))

    # 02·b 逐夹具比块种类序列。
    compared = 0
    dom_missing_in_expect = []
    dom_missing_in_payload = []
    dom_mismatch = []
    for key in sorted(expect):
        exp = expect.get(key)
        stem = key[:-3] if key.endswith(".md") else key
        doc = docs.get(stem)
        if doc is None:
            bad.append(f"{key}: 载荷缺该夹具")
            continue
        table = doc.get("block_kinds") or KIND_NAMES
        kinds, bad_idx = [], None
        for b in doc.get("blocks") or []:
            idx = b[0] if isinstance(b, list) and b else None
            if not isinstance(idx, int) or not (0 <= idx < len(table)):
                bad_idx = b
                break
            kinds.append(table[idx])
        if bad_idx is not None:
            bad.append(f"{key}: 载荷出现非法 kind_idx {bad_idx!r}")
            continue
        if not isinstance(exp, dict):
            bad.append(f"{key}: 期望条目不是对象")
            continue
        want_kinds = exp.get("blocks_kind")
        if not isinstance(want_kinds, list) or not want_kinds:
            bad.append(f"{key}: 期望缺 blocks_kind（空期望不得 PASS）")
        elif kinds != want_kinds:
            bad.append(f"{key}: 块序列 期望 {want_kinds} / 实际 {kinds}")
        else:
            compared += 1

        want_dom = exp.get("dom_line_boxes")
        if not isinstance(want_dom, int):
            dom_missing_in_expect.append(key)
            continue
        got_dom = None
        for src in (doc.get("dom"), doc):
            if isinstance(src, dict):
                got_dom = src.get("dom_line_boxes")
                if isinstance(got_dom, int):
                    break
        if got_dom is None:
            dom_missing_in_payload.append(key)
        elif got_dom != want_dom:
            dom_mismatch.append({"fixture": key, "expected": want_dom, "actual": got_dom})

    rep.add(gate, "fixture-block-sequence", "FAIL" if bad else "PASS",
            f"夹具块序列核对 {len(expect)} 份（一致 {compared} 份）；问题 {len(bad)} 处",
            data=bad)

    # 02·c 结构摘要（DOM 行盒数）必须双向核对；缺生产者时显式 SKIP，⛔ 不冒充通过。
    if dom_missing_in_expect or dom_mismatch:
        rep.add(gate, "fixture-structure-summary", "FAIL",
                f"期望缺 dom_line_boxes {len(dom_missing_in_expect)} 份；"
                f"核到不一致 {len(dom_mismatch)} 份",
                data={"missing_in_expect": dom_missing_in_expect,
                      "mismatch": dom_mismatch})
    elif dom_missing_in_payload:
        rep.add(gate, "fixture-structure-summary", "SKIP",
                f"载荷缺 dom_line_boxes {len(dom_missing_in_payload)} 份 ⇒ 结构摘要未核对"
                "（需 Stage A 在 .work/fixtures.json 产出该字段，见契约申请 CR-C-0135）",
                data={"missing_in_payload": dom_missing_in_payload})
    else:
        rep.add(gate, "fixture-structure-summary", "PASS",
                f"{len(expect)} 份夹具的 DOM 行盒数与期望一致")


OCR_TARGET_RE = re.compile(r"[Ff](\d+)([a-z]?)/(\d+)(?:-(\d+))?")


def ocr_targets(criteria: list[dict]) -> list[dict]:
    """OCR 应读行：只取层为 L2-OCR 的判据自己点名的夹具行（design/0063 §7.0 V3）。"""
    out = []
    for c in criteria:
        if "L2-OCR" not in c["layer_raw"]:
            continue
        targets = []
        for raw in c["fixture_refs"]:
            m = re.fullmatch(r"F(\d+)([a-z]?)/(\d+)(?:-(\d+))?", raw)
            if not m:
                continue
            start = int(m.group(3))
            end = int(m.group(4)) if m.group(4) else start
            targets.extend(range(start, end + 1))
        out.append({"id": c["id"], "fixtures": c["fixtures"],
                    "lines": c["fixture_refs"], "should_read": len(targets)})
    return out


def gate_03(rep: Report, generated: dict, ocr_path: Path | None) -> None:
    gate = "P-COV-03"
    targets = ocr_targets(generated["criteria"])
    total = sum(t["should_read"] for t in targets)
    if not targets:
        rep.add(gate, "ocr-channel", "WARN", "§3 里没有 L2-OCR 判据，OCR 通道为空")
        return
    rep.add(gate, "ocr-channel", "PASS",
            f"L2-OCR 判据 {len(targets)} 条，OCR 应读行合计 {total} 行（逐条见 data）",
            data=targets)

    if ocr_path is None or not ocr_path.is_file():
        rep.add(gate, "ocr-ratio", "SKIP",
                "缺外部 OCR 结果（Vision 识别 + 人工复核），无法计算「有效 OCR 行 / 应读行」；"
                "⛔ 不以 rmd DOM 行盒数代替分母（V3）",
                data={"should_read_total": total})
        return

    ocr = read_json(ocr_path).get("criteria", {})
    if not isinstance(ocr, dict):
        rep.add(gate, "ocr-ratio", "FAIL",
                "OCR JSON 的 criteria 不是对象 ⇒ 输入畸形", data={"type": type(ocr).__name__})
        return
    per, below, tampered = [], [], []
    seen = 0
    for t in targets:
        got = ocr.get(t["id"], {})
        if not isinstance(got, dict):
            got = {}
        # 0160 §3：分母**只取设计侧** `t["should_read"]`。输入自带
        # `should_read_lines` 一律不采信；与设计不一致即视为篡改，直接红。
        should = t["should_read"]
        claimed = got.get("should_read_lines")
        if claimed is not None and int(claimed) != should:
            tampered.append({"id": t["id"], "design": should, "input": claimed})
        try:
            valid = int(got.get("valid_lines", 0))
        except (TypeError, ValueError):
            valid = 0
        if valid > should:
            tampered.append({"id": t["id"], "design": should, "valid": valid,
                             "why": "valid_lines 大于应读行"})
        seen += valid
        ratio = (valid / should) if should else 0.0
        per.append({"id": t["id"], "valid": valid, "should": should,
                    "ratio": round(ratio, 3), "untested_lines": max(0, should - valid)})
        if ratio < 0.8:
            below.append(t["id"])
    if tampered:
        rep.add(gate, "ocr-ratio", "FAIL",
                f"OCR 输入改写了分母或越界 {len(tampered)} 处（分母固定为设计侧应读行）",
                data={"tampered": tampered, "per_criterion": per})
        return
    rep.add(gate, "ocr-ratio", "FAIL" if below else "PASS",
            f"有效 OCR 行 {seen}/{total}（分母取设计侧）；低于 0.8 的判据 {len(below)} 条",
            data={"per_criterion": per, "below": below})


REVIEW_FIELDS = ("reviewer", "frame_sha256", "signed_at")
PROV_FIELDS = ("frame_sha256", "window_id", "captured_at")


def gate_04(rep: Report, coverage: dict, baseline_path: Path) -> None:
    gate = "P-COV-04"
    parity = [c for c in coverage["criteria"] if c["family"] == "PARITY"]
    ocr_parity = [c for c in parity if "L2-OCR" in c["layer_raw"]]
    # 0160 §4：§2.9 只允许 L1→L2 / L2-OCR 进基线。
    # `P-MERMAID-01-CENTER-PARITY` 的层是 `L2-PIX` ⇒ 不进基线，也不要求有行。
    layer_of = {}
    for c in coverage["criteria"]:
        for a in c["expanded_ids"]:
            layer_of[a] = c["layer_raw"]
    eligible = sorted(a for a, raw in layer_of.items()
                      if a.endswith("-PARITY")
                      and any(l in (raw or "") for l in BASELINE_LAYERS))
    excluded = sorted(a for a in layer_of
                      if a.endswith("-PARITY") and a not in eligible)
    preview = {
        "parity_total": len(parity),
        "ocr_parity": [c["id"] for c in ocr_parity],
        "eligible_atoms": len(eligible),
        "excluded_non_baseline_atoms": excluded,
    }
    if not baseline_path.is_file():
        rep.add(gate, "baseline-provenance", "SKIP",
                f"缺 {baseline_path.name}（L1 基线待采）：{len(parity)} 条 -PARITY 需落基线，"
                f"其中 L2-OCR 采集层 {len(ocr_parity)} 条另需 review 三项；"
                f"按 §2.9 不得进基线的 {len(excluded)} 个原子已排除",
                data=preview)
        return

    baseline = read_json(baseline_path)
    entries = baseline.get("entries") or baseline.get("rows") or (
        baseline if isinstance(baseline, list) else [])
    if isinstance(entries, dict):
        entries = list(entries.values())

    declared = {a for c in coverage["criteria"] for a in c["expanded_ids"]}

    problems = []
    seen = set()
    for e in entries:
        if not isinstance(e, dict):
            problems.append({"id": None, "why": "基线条目不是对象"})
            continue
        cid = e.get("id")
        if not cid:
            problems.append({"id": None, "why": "基线条目缺 id"})
            continue
        # 0160 §5：§2.9 禁止 -SPEC/-REG/L3 进基线，过去被 `continue` 静默跳过。
        if not str(cid).endswith("-PARITY"):
            problems.append({"id": cid, "why": "非 -PARITY 行不得进基线（§2.9）"})
            continue
        seen.add(cid)
        if cid not in declared:
            problems.append({"id": cid, "why": "baseline 里的 ID 不在 §3 判据表内"})
            continue
        if cid in excluded:
            problems.append({"id": cid,
                             "why": f"该判据的采集层 {layer_of.get(cid)!r} 不得进基线（§2.9）"})
            continue
        prov = e.get("provenance")
        if not isinstance(prov, dict):
            problems.append({"id": cid, "why": "缺 provenance"})
        else:
            miss = [k for k in PROV_FIELDS if not prov.get(k)]
            if miss:
                problems.append({"id": cid, "why": f"provenance 缺 {miss}"})
        # 0160 §5：设计 L1033 同时要求 `fixture`，过去只查了 sha256。
        if not e.get("fixture"):
            problems.append({"id": cid, "why": "缺 fixture（§2.9 基线行字段）"})
        if not e.get("fixture_sha256"):
            problems.append({"id": cid, "why": "缺 fixture_sha256"})
        if "L2-OCR" in (layer_of.get(cid) or ""):
            rev = e.get("review")
            miss = [k for k in REVIEW_FIELDS if not (isinstance(rev, dict) and rev.get(k))]
            if miss:
                problems.append({"id": cid, "why": f"L2-OCR 的 review 缺 {miss}"})

    missing = [a for a in eligible if a not in seen]
    rep.add(gate, "baseline-provenance", "FAIL" if (problems or missing) else "PASS",
            f"-PARITY 判据 {len(parity)} 条；可进基线原子 {len(eligible)} 个"
            f"（排除 {len(excluded)} 个非 L1→L2/L2-OCR 原子）；"
            f"缺基线 {len(missing)} 个；字段不合规 {len(problems)} 处",
            data={"missing": missing, "problems": problems,
                  "excluded_non_baseline_atoms": excluded})


GATE_IDS = ("P-COV-01", "P-COV-02", "P-COV-03", "P-COV-04")


def run_gates(args) -> int:
    if not DESIGN.is_file():
        print(f"⛔ 缺设计文档：{DESIGN}", file=sys.stderr)
        return EXIT_ERROR
    text, sha = load_design()
    try:
        generated = build_coverage(text, sha)
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        return EXIT_ERROR

    # 0160 §8：`--only` 过去在四条闸门**全部执行之后**才过滤 ⇒ 无关输入畸形也会先崩。
    # 现在先决定跑哪些闸门，再读它们的输入。
    only = args.only
    if only and only not in GATE_IDS:
        print(f"⛔ 未知闸门：{only}", file=sys.stderr)
        return EXIT_ERROR
    want = {only} if only else set(GATE_IDS)

    rep = Report()
    metrics: dict = {}
    try:
        coverage_path = Path(args.coverage)
        coverage = {} if not coverage_path.is_file() else read_json(coverage_path)
    except InputError as exc:
        print(f"⛔ 输入不可读：{exc}", file=sys.stderr)
        return EXIT_ERROR

    try:
        # P-COV-02/03 不依赖 coverage.json：即使清单缺失也必须能单独执行。
        if "P-COV-02" in want:
            gate_02(rep, generated, Path(args.payload), Path(args.expect))
        if "P-COV-03" in want:
            gate_03(rep, generated, Path(args.ocr) if args.ocr else None)

        if not isinstance(coverage, dict) or not coverage:
            # 0160 §1/§9：没有清单就无法建立判据面，STOP 而不是静默用 generated 顶替。
            detail = f"缺 {args.coverage} 或为空（先跑 coverage 子命令）"
            if "P-COV-01" in want:
                rep.add("P-COV-01", "coverage-file", "FAIL", detail)
            if "P-COV-04" in want:
                rep.add("P-COV-04", "coverage-file", "FAIL", detail)
        else:
            if "P-COV-01" in want:
                metrics = gate_01(rep, coverage, generated)
            if "P-COV-04" in want:
                gate_04(rep, coverage, Path(args.baseline))
    except InputError as exc:
        print(f"⛔ 输入不可读：{exc}", file=sys.stderr)
        return EXIT_ERROR
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        return EXIT_ERROR

    if only:
        rep.items = [x for x in rep.items if x["gate"] == only]
        if not rep.items:
            print(f"⛔ 未知闸门：{only}", file=sys.stderr)
            return EXIT_ERROR

    # ── 人类可读表格 ────────────────────────────────────────────────────
    # `--json -` 时 stdout 只留纯 JSON（便于管道），表格改走 stderr。
    out_stream = sys.stderr if args.json == "-" else sys.stdout
    for gate in ("P-COV-01", "P-COV-02", "P-COV-03", "P-COV-04"):
        items = [x for x in rep.items if x["gate"] == gate]
        if not items:
            continue
        print(f"── {gate} " + "─" * (58 - len(gate)), file=out_stream)
        for it in items:
            mark = {"PASS": "PASS", "FAIL": "FAIL", "SKIP": "SKIP", "WARN": "WARN"}[it["status"]]
            print(f"  [{mark}] {pad(it['check'], 26)} {it['detail']}", file=out_stream)
    c = rep.counts()
    code = rep.exit_code()
    print("── 汇总 " + "─" * 53, file=out_stream)
    print(f"  PASS {c['PASS']}  FAIL {c['FAIL']}  WARN {c['WARN']}  SKIP {c['SKIP']}"
          f"  ⇒ 退出码 {code}", file=out_stream)
    if not metrics:
        metrics = {"total_criteria": generated["summary"]["total_criteria"],
                   "total_expanded_ids": generated["summary"]["total_expanded_ids"],
                   "fixtures_total": len(list(FIXTURES.glob("*.md"))),
                   "note": "P-COV-01 未执行（--only），结构指标取自本次解析"}
    print(f"  判据 {metrics.get('total_criteria')} 条（展开 "
          f"{metrics.get('total_expanded_ids')} 个 ID）；"
          f"夹具 {metrics.get('fixtures_total')} 份", file=out_stream)

    if args.json:
        out = {
            "schema": "rmd.visual-parity.coverage-gates/1",
            "design": {"path": str(DESIGN.relative_to(ROOT)),
                       "sha256": generated["source"]["design_sha256"]},
            "results": rep.items,
            "summary": {**c, "exit_code": code},
            "metrics": metrics,
        }
        payload = dump_json(out)
        if args.json == "-":
            print(payload, end="")
        else:
            Path(args.json).write_text(payload, encoding="utf-8")
            print(f"  JSON → {args.json}", file=sys.stdout)
    return code


# ══════════════════════════════════════════════════════════════════════
# 六、CLI
# ══════════════════════════════════════════════════════════════════════

def pad(s: str, width: int) -> str:
    """按显示宽度补空格（CJK 计 2）。"""
    w = sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in s)
    return s + " " * max(0, width - w)


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in ("ast", "gates", "coverage"):
        argv = ["ast"] + argv

    ap = argparse.ArgumentParser(
        prog="ast-expect-check.py",
        description="夹具 AST 期望核对（默认）＋ §3 覆盖闸门 P-COV-01..04",
    )
    sub = ap.add_subparsers(dest="cmd")

    p_ast = sub.add_parser("ast", help="块种类序列比对（默认）")
    p_ast.add_argument("--payload", default=str(PAYLOAD))
    p_ast.add_argument("--expect", default=str(EXPECT))
    p_ast.add_argument("--fixtures", default=str(FIXTURES))

    p_g = sub.add_parser("gates", help="P-COV-01..04 覆盖闸门")
    p_g.add_argument("--coverage", default=str(COVERAGE))
    p_g.add_argument("--payload", default=str(PAYLOAD))
    p_g.add_argument("--expect", default=str(EXPECT))
    p_g.add_argument("--baseline", default=str(BASELINE))
    p_g.add_argument("--ocr", default=None, help="外部 OCR 结果 JSON（缺省 ⇒ SKIP）")
    p_g.add_argument("--json", default=None, help="输出 JSON 到文件；'-' 表示 stdout")
    p_g.add_argument("--only", default=None,
                     choices=["P-COV-01", "P-COV-02", "P-COV-03", "P-COV-04"],
                     help="只跑一条闸门（逐条取退出码）")

    p_c = sub.add_parser("coverage", help="从设计文档生成 coverage.json")
    p_c.add_argument("--out", default=str(COVERAGE))
    p_c.add_argument("--check", action="store_true", help="只比对不落盘")

    args = ap.parse_args(argv)

    if args.cmd == "ast":
        return ast_check(Path(args.payload), Path(args.expect), Path(args.fixtures))

    if args.cmd == "gates":
        return run_gates(args)

    if args.cmd == "coverage":
        text, sha = load_design()
        try:
            generated = build_coverage(text, sha)
        except SystemExit as e:
            print(str(e), file=sys.stderr)
            return EXIT_ERROR
        out = Path(args.out)
        if args.check:
            if not out.is_file():
                print(f"❌ {out} 不存在", file=sys.stderr)
                return EXIT_FAIL
            same = read_json(out) == generated
            print("✅ coverage.json 与设计一致" if same
                  else "❌ coverage.json 与设计不同步：重新跑 coverage 生成")
            return EXIT_OK if same else EXIT_FAIL
        out.write_text(dump_json(generated), encoding="utf-8")
        s = generated["summary"]
        print(f"✅ 写出 {out}：判据 {s['total_criteria']} 条（展开 {s['total_expanded_ids']} 个 ID）")
        print(f"   族分布 rows={s['by_family_rows']} expanded={s['by_family_expanded']}")
        print(f"   层分布 {s['by_layer_rows']}")
        return EXIT_OK

    ap.print_help()
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
