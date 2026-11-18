#!/usr/bin/env python3
"""`design/0060` §7.2 的变异自证：逐条把闸门改坏，要求对应测试**真的变红**，然后还原。

用法：`python3 scripts/mermaid-mutations.py`（**不需要**联网，也不需要 `make`）。
约一分钟；每条只重编一次 `rmd` 的 test 目标。

⚠️ 只改一个字符串、只跑一条测试、每次都在 finally 里还原——
   中途失败也不会留下改坏的源码（脚本退出前会再核对一遍 sha256）。
⚠️ 锚点命中次数 ≠ 1 时**报错而不是跳过**：产品代码一改名，"变异"就会退化成
   "什么都没改"，而那种情况下测试**照样是绿的**——看起来和"判据不敏感"一模一样。
⚠️ 退出码非 0 只说明有失败项；⚠️ "测试变红"必须同时满足「编译过了」——
   变异体编译失败（比如改出语法错）不算打红，脚本会单独报出来。
⚠️ 本文件只管 `document/mermaid.rs`。引擎侧的那一条变异（把汉字的 1em 估宽改成
   西文值）在 `../docs/design/0060` §10.11，它要改 cargo 缓存里的 flowmaid 源码，⛔ 不放这里。
"""
import hashlib
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src-tauri/src/document/mermaid.rs"

MUTATIONS = [
    (
        "M1 准入表：未知头部放行",
        '    Err(Reject::UnknownKind(tok.to_string()))\n}',
        '    Ok("flowchart")\n}',
        "未知头部不是流程图",
    ),
    (
        "M2 预扫描闸门整条停用",
        "    if est.tokens > MAX_PRESCAN_TOKENS || est.edges > MAX_PRESCAN_EDGES {",
        "    if false && (est.tokens > MAX_PRESCAN_TOKENS || est.edges > MAX_PRESCAN_EDGES) {",
        "乘法放大在解析前就被挡下且布局零调用",
    ),
    (
        "M3 单图节点上限放宽到 5000",
        "const MAX_NODES: usize = 512;",
        "const MAX_NODES: usize = 5000;",
        "模型闸门在非流程图里能先于预扫描咬住",
    ),
    (
        "M4 <a> 不再解包（改成回退）",
        '                    if local == "a" {\n                        stack.push(Frame::UnwrapA);\n                        continue;\n                    }',
        '                    if local == "a" {\n                        *why = format!("危险元素 <{local}>");\n                        return Err(());\n                    }',
        "click_三种协议都不留导航标签",
    ),
    (
        "M5 id 不加文档前缀",
        '            return Ok((name.into(), format!("m{seq}-{value}")));',
        '            return Ok((name.into(), value.to_string()));',
        "两图的_id_集合不相交",
    ),
    (
        "M6 url(#…) 不跟着加前缀",
        '    Ok(format!("url(#m{seq}-{inner})"))',
        '    Ok(format!("url(#{inner})"))',
        "两图的_id_集合不相交",
    ),
    (
        "M7 模式 B 判定恒假（作者样式被覆盖）",
        "        D::Flowchart(g) | D::State(g) => graph_styled(g),",
        "        D::Flowchart(g) | D::State(g) => {\n            let _ = g;\n            false\n        }",
        "模式b的三条路径都能判定",
    ),
    (
        "M8 颜色替换整条停用（引擎色原样透出）",
        '                Some(var) => format!("var({var})"),',
        '                Some(_var) => value.to_string(),',
        "模式a下没有字面色残留",
    ),
    (
        "M9 回退块不再输出可见原因",
        '    context.write_str("<p class=\\"rmd-diagram-note\\">")?;',
        '    context.write_str("<p class=\\"rmd-diagram-why\\">")?;',
        "回退块是一个外壳加一行原因加逐字原文",
    ),
    (
        "M10 累计触顶记成单块超限（归因错误）",
        "        Outcome::BudgetExhausted => {\n            stats.mermaid_exhausted = true;\n            fallback(context, src, Reject::DocBudget, true)",
        "        Outcome::BudgetExhausted => {\n            stats.mermaid_exhausted = true;\n            fallback(context, src, Reject::TooLarge, true)",
        "节点累计触顶之后粘滞",
    ),
    (
        "M11 元素白名单停用（未知元素透传）",
        "    if !ELEMENTS.contains(&local) {",
        "    if false && !ELEMENTS.contains(&local) {",
        "未知元素与属性一律回退",
    ),
    (
        "M12 头部关键字重新对每一行生效",
        "            if !seen_header {\n                seen_header = true;",
        "            if true {\n                seen_header = true;",
        "头部关键字只在第一条语句上成立",
    ),
    (
        "M13 预扫描不把 ~~~ 算作边运算符",
        "let edgeish = s.contains('-') || s.contains('=') || s.contains('~');",
        "let edgeish = s.contains('-') || s.contains('=');",
        "不可见连线也算边",
    ),
    (
        "M14 遮罩子树也做主题色替换",
        "                write_start(&mut out, local, &e, seq, true, subst && mask_depth == 0, why)?;",
        "                write_start(&mut out, local, &e, seq, true, subst, why)?;",
        "mask_子树不做主题色替换",
    ),
    (
        "M15 class 值不再校验",
        "fn class_value(v: &str) -> bool {",
        "fn class_value(v: &str) -> bool {\n    if !v.is_empty() {\n        return true;\n    }",
        "未知元素与属性一律回退",
    ),
    (
        "M16 配置指令只查表头前",
        "    if src.lines().any(|l| l.trim_start().starts_with(\"%%{\")) {",
        "    if src.lines().take_while(|l| !l.contains(\"flowchart\")).any(|l| l.trim_start().starts_with(\"%%{\")) {",
        "frontmatter_与配置指令分别回退",
    ),
    (
        "M17 围栏总数不再设上限",
        "    if stats.mermaid_blocks > MAX_BLOCKS {",
        "    if false && stats.mermaid_blocks > MAX_BLOCKS {",
        "围栏总数有上限且触顶粘滞",
    ),
    (
        "M18 单块超限重新排在全文额度之后",
        "    if src.len() > MAX_SOURCE {\n        return fallback(context, src, Reject::TooLarge, false);\n    }",
        "    if false {\n        return fallback(context, src, Reject::TooLarge, false);\n    }",
        "单块超限不连坐后面的图",
    ),
    (
        "M19 作者命名色被拒",
        "            if named_color(value) || func_color(value) {",
        "            if false && (named_color(value) || func_color(value)) {",
        "作者配色语法可以进清洗器",
    ),
    (
        "M20 每块都用文档里的第 0 号前缀（两图 ID 互撞）",
        "    let seq = stats.mermaid_diagrams;",
        "    let seq = 0;",
        "两份围栏在同一文档里各自成图",
    ),
    (
        "M21 空图记成安全拒绝（计数归错门）",
        "        Reject::Empty => stats.mermaid_empty += 1,",
        "        Reject::Empty => stats.mermaid_security += 1,",
        "空图与安全拒绝各记各的",
    ),
    (
        "M22 单图源码闸门从 `>` 改 `>=`（16384 字节被误拒）",
        "    if src.len() > MAX_SOURCE {\n        return Outcome::Fallback(Reject::TooLarge);\n    }",
        "    if src.len() >= MAX_SOURCE {\n        return Outcome::Fallback(Reject::TooLarge);\n    }",
        "源码刚好在上限内仍出图_多一字节才回退",
    ),
    (
        "M23 序号改用围栏数（回退块也吃掉一个 ID 前缀）",
        "    let seq = stats.mermaid_diagrams;",
        "    let seq = stats.mermaid_blocks - 1;",
        "回退的块不占_ID_前缀序号",
    ),
    (
        "M24 accDescr 多行块不再整段跳过",
        "                    acc_block = true;",
        "                    acc_block = false;",
        "accDescr_多行块既不算节点也不触发预算",
    ),
]


def digest(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run_test(name: str) -> tuple[bool, str]:
    r = subprocess.run(
        [
            "cargo", "test", "--offline",
            "--manifest-path", "src-tauri/Cargo.toml",
            "--bins", f"document::mermaid::tests::{name}", "--", "--exact",
        ],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode == 0, (r.stdout + r.stderr)


def main() -> int:
    original = SRC.read_text()
    base = digest(SRC)
    bad = 0
    for title, old, new, test_name in MUTATIONS:
        if original.count(old) != 1:
            print(f"✗ {title}：锚点命中 {original.count(old)} 次（必须 1 次）")
            bad += 1
            continue
        SRC.write_text(original.replace(old, new))
        try:
            ok, out = run_test(test_name)
        finally:
            SRC.write_text(original)
            assert digest(SRC) == base, "还原失败！"
        compiled = "test result:" in out
        if not compiled:
            print(f"✗ {title}：变异体没编译过（这不算打红）\n{out[-800:]}")
            bad += 1
        elif ok:
            print(f"✗ {title}：测试仍然绿 —— 这条断言抓不住它")
            bad += 1
        else:
            print(f"✅ {title} ⇒ `{test_name}` 变红")
    print(f"\n{len(MUTATIONS) - bad}/{len(MUTATIONS)} 条变异各自打红了对应测试")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
