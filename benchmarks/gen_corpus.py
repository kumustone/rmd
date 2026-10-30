#!/usr/bin/env python3
"""语料生成器 —— 对应 `docs/design/0002` §7.1 的矩阵。

⛔ **INV-CORPUS-01：语料必须由脚本生成，不许手工找文件。**
理由写在设计里：手工找来的文件无法复现，于是"上次跑得快不快"永远说不清。
所以这里固定随机种子（`--seed`，默认 20261013），同种子必然出同样的字节。

矩阵：4 个量级 × 4 类结构 + 1 个 mixed = 17 个文件。

| 量级 | 目标大小 |
|---|---|
| S | 100 KB |
| M | 1 MB |
| L | 5 MB |
| XL | 10 MB |

| 结构 | 内容 |
|---|---|
| plain | 中文长段落，极少标题 |
| headings | 多级标题（密度调到 L 量级 ≈ 3000 个） |
| code | 大量代码块 |
| tables | 大量表格 |

外加 `mixed.md`：中文 + 英文 + Emoji 混排，**专验 UTF-8/UTF-16 偏移换算**
（这条不是性能测试，是正确性测试）。

⚠️ 两个已知的尺度妥协（已在 `design/0002` §10 记过）：
1. 大小是**按字节逼近**的，不保证精确等于目标——切在句末而不是切在半个字上。
2. `headings` 的标题密度是**按大小驱动**的，不是"每个文件都恰好 3000 个"；
   3000 那个硬指标看 **`M-headings.md`**（实测 3179，偏差 +6%），
   别的量级按同密度缩放。生成器会把实际条数打出来。
"""

from __future__ import annotations

import argparse
import os
import random
import sys

SIZES = {
    "S": 100 * 1024,
    "M": 1024 * 1024,
    "L": 5 * 1024 * 1024,
    "XL": 10 * 1024 * 1024,
}

FEATURES = ["plain", "headings", "code", "tables"]

# —— 词汇池：够大，保证同一个词不会以固定周期反复出现（那会让压缩/缓存失真）——
NOUNS = "文档 目录 侧边栏 渲染 解析 偏移 索引 标题 锚点 主题 排版 字体 行高 字阶 表格 代码块 引用 列表 图片 链接 搜索 命中 高亮 滚动 视口 分块 虚拟 内存 延迟 帧率 初始化 授权 路径 校验 快照 版本 缓存 失效 残差 采样 基准 语料 探针 内核 编译器 标准库 并发 队列 调度 缓冲".split()
VERBS = "打开 关闭 解析 渲染 测量 对比 收敛 降级 回退 展开 折叠 定位 跳转 缓存 失效 授权 校验 采样 计时 聚合 冻结 追加 覆盖".split()
ADJS = "快 慢 稳 脆 大 小 深 浅 宽 窄 清晰 模糊 一致 可比 可复现 反直觉 静默 显式 隐式 原子".split()
EN_WORDS = "lexer parser renderer arena offset anchor theme typography baseline corpus probe invariant".split()


def sentence(rng: random.Random) -> str:
    n = rng.randint(3, 9)
    parts = []
    for _ in range(n):
        parts.append(rng.choice(NOUNS))
        if rng.random() < 0.3:
            parts.append(rng.choice(ADJS))
        parts.append(rng.choice(VERBS))
        if rng.random() < 0.15:
            parts.append(rng.choice(EN_WORDS))
    return "".join(parts) + "。"


def paragraph(rng: random.Random, min_sent: int = 3, max_sent: int = 9) -> str:
    return "".join(sentence(rng) for _ in range(rng.randint(min_sent, max_sent)))


def plain_block(rng: random.Random) -> str:
    return paragraph(rng) + "\n\n"


HEADING_LEVELS = [2, 2, 3, 3, 3, 4, 4, 5, 6]


def headings_block(rng: random.Random, counter: list[int]) -> str:
    counter[0] += 1
    lvl = rng.choice(HEADING_LEVELS) if counter[0] > 1 else 1
    title = "".join(rng.choice(NOUNS) for _ in range(rng.randint(2, 5)))
    # ⚠️ 每个标题带序号，保证**不重复**——否则测的是 ID 去重而不是目录规模
    return f"{'#' * lvl} {title} {counter[0]}\n\n{paragraph(rng, 1, 4)}\n\n"


CODE_SNIPPETS = [
    "fn render_markdown(src: &str) -> String {{\n    let arena = Arena::new();\n    let root = parse_document(&arena, src, &opts);\n    format_html(root, &opts, &mut out).unwrap();\n}}",
    "for node in root.descendants() {{\n    // # 这行不是标题\n    if let NodeValue::Heading(h) = &node.data().value {{\n        println!(\"{{}}\", h.level);\n    }}\n}}",
    "pub struct SessionGrants {{\n    roots: Vec<PathBuf>,\n    files: Vec<PathBuf>,\n    root_generation: u64,\n}}",
    "let hits = find_all(&src, needle, &index);\nassert!(!hits.is_empty());\n// 中文：字节偏移 != UTF-16 偏移",
    "SELECT id, path, mtime FROM files WHERE root_id = ?1 ORDER BY path LIMIT 200;",
]


def code_block(rng: random.Random) -> str:
    lang = rng.choice(["rust", "rust", "rust", "ts", "sql", ""])
    body = rng.choice(CODE_SNIPPETS)
    return f"```{lang}\n{body}\n```\n\n"


def table_block(rng: random.Random) -> str:
    cols = rng.randint(3, 6)
    header = " | ".join("".join(rng.choice(NOUNS) for _ in range(rng.randint(1, 2))) for _ in range(cols))
    sep = " | ".join("---" if rng.random() < 0.5 else "---:" for _ in range(cols))
    rows = []
    for _ in range(rng.randint(4, 12)):
        rows.append(" | ".join(rng.choice(NOUNS) + str(rng.randint(0, 9999)) for _ in range(cols)))
    return f"| {header} |\n| {sep} |\n" + "".join(f"| {r} |\n" for r in rows) + "\n"


def mixed_block(rng: random.Random) -> str:
    bits = [
        paragraph(rng, 1, 3),
        "\n",
        "English paragraph with **bold**, *italic*, `inline code`, and a "
        "[link](https://example.com/a?b=1&c=2).\n\n",
        "Emoji 密集：🚀🇨🇳👨👩👧👦🧑💻 与中文混排，🙂 每一行都有。\n\n",
        "HTML 实体：&amp; &lt; &gt; &quot; &#39; 与全角标点，，。、；：！？\n\n",
        "- 列表项 " + rng.choice(NOUNS) + "\n- 列表项 " + rng.choice(NOUNS) + "\n\n",
        "> 引用块 " + sentence(rng) + "\n\n",
    ]
    return "".join(bits)


def build(feature: str, target: int, rng: random.Random) -> tuple[str, int]:
    """按目标字节数逼近生成。返回 (文本, 标题数)。"""
    out: list[str] = []
    size = 0
    headings = [0]

    out.append(f"# rmd 性能语料 · {feature}\n\n")
    size += len(out[0].encode())

    # headings 的密度：`M` 量级（1 MB）自然落到 ≈3000 个标题，
    # 正好是 `vision/0001` §9 那个硬指标——所以**那条指标从 `M-headings.md` 上读**，
    # 别的量级按比例缩放（实测 S 313 / M 3179 / L 15752 / XL 31424）。
    step = 0

    while size < target:
        step += 1
        if feature == "plain":
            chunk = plain_block(rng)
        elif feature == "headings":
            if step % 9 == 0:
                chunk = plain_block(rng)
            else:
                chunk = headings_block(rng, headings)
        elif feature == "code":
            chunk = code_block(rng) if step % 3 else plain_block(rng)
        elif feature == "tables":
            chunk = table_block(rng) if step % 2 else plain_block(rng)
        elif feature == "mixed":
            chunk = mixed_block(rng)
        else:
            raise ValueError(feature)
        out.append(chunk)
        size += len(chunk.encode())

    return "".join(out), headings[0]


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 design/0002 §7.1 的语料矩阵")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus"))
    ap.add_argument("--seed", type=int, default=20261013)
    ap.add_argument("--only", help="只生成某些量级，逗号分隔，如 S,M")
    ap.add_argument("--only-feature", help="只生成某些结构，逗号分隔")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的文件")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    sizes = list(SIZES) if not args.only else [s.strip() for s in args.only.split(",")]
    feats = FEATURES if not args.only_feature else [f.strip() for f in args.only_feature.split(",")]

    print(f"out={args.out}  seed={args.seed}")
    print(f"{'文件':<22}{'目标':>10}{'实际':>12}{'偏差':>9}{'标题数':>9}")
    print("-" * 64)

    total = 0
    for size_name in sizes:
        for feat in feats:
            # ⚠️ 每个文件用**独立的** rng（种子由 size+feature 派生），
            # 这样只改一个文件不会让其它文件全部变样——语料可比性靠这个保住。
            rng = random.Random(f"{args.seed}:{size_name}:{feat}")
            target = SIZES[size_name]
            text, n_head = build(feat, target, rng)
            name = f"{size_name}-{feat}.md"
            path = os.path.join(args.out, name)
            if os.path.exists(path) and not args.force:
                print(f"{name:<22}{'(已存在，跳过；--force 覆盖)'}")
                continue
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            actual = len(text.encode())
            dev = (actual - target) / target * 100
            print(f"{name:<22}{target:>10,}{actual:>12,}{dev:>8.1f}%{n_head:>9,}")
            total += 1

    # mixed：单独一份，不参与 16 的矩阵
    if not args.only_feature:
        rng = random.Random(f"{args.seed}:mixed")
        target = SIZES["M"]
        text, _ = build("mixed", target, rng)
        path = os.path.join(args.out, "mixed.md")
        if os.path.exists(path) and not args.force:
            print("mixed.md               (已存在，跳过；--force 覆盖)")
        else:
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            actual = len(text.encode())
            print(f"{'mixed.md':<22}{target:>10,}{actual:>12,}{(actual-target)/target*100:>8.1f}%{'-':>9}")
            total += 1

    print("-" * 64)
    print(f"共写入 {total} 个文件。")
    print("⚠️ 大小是按字节逼近的，切在段落边界：偏差通常在 ±3% 以内，A 与 B 比较时用实际字节数。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
