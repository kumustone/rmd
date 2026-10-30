#!/usr/bin/env python3
"""
生成 / 校验 `THIRD-PARTY-NOTICES.md`（第三方依赖的许可证清单）。

## 为什么要有这个脚本

`features/0023` 的工作项 2（许可证与第三方声明）要求「依赖许可证**逐条**核对」。
手写一份清单一定会漂：依赖一升级，清单就少一条或版本号对不上，而**没人看得出来**。
所以清单**只由本脚本生成**（`THIRD-PARTY-NOTICES.md` 顶部也写着这句），
人只维护脚本里的**判定规则**（哪些许可算宽松、哪些要挂红旗）。

## 数据从哪来（⛔ 不联网）

- Rust：`cargo metadata --locked --features gui --filter-platform aarch64-apple-darwin`。
  ⚠️ **必须带 `--features gui`**——`tauri` / `notify` / `muda` 是 optional 依赖，
  默认构建根本链不进来；不带这个参数生成的清单会**漏掉整棵 GUI 依赖树**，
  而那一棵树正是发布出去的二进制里占大头的那部分。
  ⚠️ `--filter-platform` 只留下**该目标上真的会被编译**的包（否则会混进
  Windows / Linux 专用的 crate，清单会虚胖，审核的人也看不出哪条与产物有关）。
- npm：从 `package.json` 的 `dependencies` 出发，在 `node_modules/` 里按 Node 的
  解析规则递归收集（`devDependencies` 里的 `esbuild` **只在构建期用**，不分发，
  单独列在 §4）。⚠️ 没有 `node_modules/`（干净检出）时**不猜**：直接报错退出，
  提示先 `npm ci`——凭 `package-lock.json` 反推运行时实际解析结果会造出第二份真值。

## 两种模式

- 默认：把生成结果写到 `THIRD-PARTY-NOTICES.md`。
- `--check`：只生成到内存，与磁盘上的那份逐字节比对；不一致退出 1（供 `make check-third-party`）。

用法：
    python3 scripts/gen-third-party.py            # 生成
    python3 scripts/gen-third-party.py --check    # 校验
"""

import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "THIRD-PARTY-NOTICES.md")
TARGET = "aarch64-apple-darwin"

# ── 许可证判定规则 ────────────────────────────────────────────────────────
# ⚠️ 这些是**本项目的判定**，不是法律意见：宽松 = 只要保留声明即可分发；
#    带义务 = 除了声明还要做别的事（给全文 / 公开改动 / 注明 Unicode 数据来源）；
#    阻断 = 与"以 GPL-3.0-or-later 发布整个程序"不相容，必须由人拍板。
PROJECT_LICENSE = "GPL-3.0-or-later"
PERMISSIVE = {
    "MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause",
    "ISC", "0BSD", "Zlib", "CC0-1.0", "Unlicense", "BSD-3-Clause-Clear",
}
WITH_OBLIGATIONS = {
    # MPL-2.0 是**文件级**弱著佐权：链接不传染，但改过的那几个文件要公开源码。
    "MPL-2.0": "文件级弱著佐权：分发时须提供被修改文件的源码（本项目未修改它们）",
    # Unicode 许可证要求随分发附带许可证与版权声明。
    "Unicode-3.0": "须随分发附带 Unicode 许可证与版权声明",
    "Unicode-DFS-2016": "须随分发附带 Unicode 许可证与版权声明",
}
COPYLEFT = re.compile(r"^(A?GPL|LGPL)", re.IGNORECASE)
# ⭐ 2026-10-23：项目自身改为 GPL-3.0-or-later（`features/0023` D3 的取代）
#    ⇒ **与 GPL-3 兼容**的著佐权依赖不再阻断，只剩"随分发提供源码"的义务。
#    ⚠️ `GPL-2.0-only` 与 GPL-3 **不相容**（不能进本表）；AGPL/LGPL 语义不同，
#    遇到时仍落进"阻断/未知"由人拍板。
COPYLEFT_COMPATIBLE = {"GPL-3.0-only", "GPL-3.0-or-later", "GPL-2.0-or-later"}

# 许可证表达式里可能出现的连接词。⚠️ 必须**先按 AND 拆、再按 OR 拆**：
#   `(MIT OR Apache-2.0) AND Unicode-3.0` 的意思是"MIT 或 Apache 二者其一，
#   **并且**还要满足 Unicode-3.0"，⛔ 不能摊平成四个可任选的 token。
CONJUNCTION = re.compile(r"\s+AND\s+", re.IGNORECASE)
DISJUNCTION = re.compile(r"\s+OR\s+|/", re.IGNORECASE)


def _level_of(token):
    if COPYLEFT.match(token):
        if token in COPYLEFT_COMPATIBLE:
            return "obligations", (
                f"{token}：项目自身即 {PROJECT_LICENSE} ⇒ **相容**，"
                "分发时须随附源码与许可证")
        return "copyleft", f"{token} 与「以 {PROJECT_LICENSE} 分发整个程序」不相容"
    if token in WITH_OBLIGATIONS:
        return "obligations", WITH_OBLIGATIONS[token]
    if token in PERMISSIVE:
        return "permissive", ""
    return "unknown", f"未登记的许可证标识 `{token}`"


def classify(expr: str):
    """返回 (等级, 说明)。等级：permissive / obligations / copyleft / unknown。"""
    # 括号只是分组，判定用的是同一套"与/或"语义 ⇒ 先剥掉。
    expr = (expr or "").replace("(", " ").replace(")", " ").strip()
    if not expr:
        return "unknown", "没有声明许可证"

    # 顶层是合取：每一份都必须满足，取**最坏**的那一份。
    worst, notes = "permissive", []
    order = {"permissive": 0, "obligations": 1, "unknown": 2, "copyleft": 3}
    for conjunct in CONJUNCTION.split(expr):
        # 合取项内部是析取：**任选一条**即可 ⇒ 取**最好**的那一条（选宽松路走）。
        best = None
        for token in DISJUNCTION.split(conjunct):
            token = token.strip()
            if not token:
                continue
            level, note = _level_of(token)
            if best is None or order[level] < order[best[0]]:
                best = (level, note)
        if best is None:
            return "unknown", "许可证表达式解析失败"
        if order[best[0]] > order[worst]:
            worst = best[0]
        if best[0] != "permissive" and best[1]:
            notes.append(best[1])
    return worst, "；".join(sorted(set(notes)))


# ── Rust ─────────────────────────────────────────────────────────────────


def rust_packages():
    cmd = [
        "cargo", "metadata", "--locked", "--format-version", "1",
        "--features", "gui", "--filter-platform", TARGET,
        "--manifest-path", os.path.join(ROOT, "src-tauri", "Cargo.toml"),
    ]
    try:
        raw = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    except FileNotFoundError:
        sys.exit("✗ 找不到 cargo：本清单的 Rust 那半边需要 Rust 工具链")
    except subprocess.CalledProcessError as exc:
        sys.exit("✗ cargo metadata 失败：\n" + (exc.stderr or "")[-2000:])

    meta = json.loads(raw)
    by_id = {p["id"]: p for p in meta["packages"]}
    # 本仓自己（workspace member）不进清单——它不是第三方。
    members = {p["id"] for p in meta["packages"] if p.get("source") is None}

    rows = []
    for node in meta["resolve"]["nodes"]:
        if node["id"] in members:
            continue
        pkg = by_id[node["id"]]
        rows.append({
            "name": pkg["name"],
            "version": pkg["version"],
            "license": pkg.get("license") or "",
            "repo": pkg.get("repository") or "",
        })
    rows.sort(key=lambda r: (r["name"].lower(), r["version"]))
    return rows


# ── npm ──────────────────────────────────────────────────────────────────


def npm_repository(pkg):
    repo = pkg.get("repository")
    if isinstance(repo, dict):
        repo = repo.get("url") or ""
    if not isinstance(repo, str):
        return ""
    # 归一化 `git+https://…/x.git` 这类写法，只为了表格好读；不是权威来源。
    return re.sub(r"^git\+", "", repo).removesuffix(".git")


def npm_packages():
    pkg_json = os.path.join(ROOT, "package.json")
    with open(pkg_json, encoding="utf-8") as fh:
        root = json.load(fh)
    wanted = list((root.get("dependencies") or {}))
    if not wanted:
        return [], []

    def resolve(name):
        # Node 的解析规则：从仓库根往上找 node_modules；本仓是单层，但别写死成一层。
        cur = ROOT
        while True:
            candidate = os.path.join(cur, "node_modules", *name.split("/"), "package.json")
            if os.path.exists(candidate):
                return candidate
            parent = os.path.dirname(cur)
            if parent == cur:
                return None
            cur = parent

    found, missing = {}, []
    stack = list(wanted)
    while stack:
        name = stack.pop()
        if name in found or name in missing:
            continue
        path = resolve(name)
        if not path:
            missing.append(name)
            continue
        with open(path, encoding="utf-8") as fh:
            pkg = json.load(fh)
        found[name] = {
            "name": pkg.get("name") or name,
            "version": pkg.get("version") or "",
            "license": pkg.get("license") or "",
            "repo": npm_repository(pkg),
        }
        stack.extend((pkg.get("dependencies") or {}).keys())

    if missing:
        sys.exit(
            "✗ node_modules/ 里缺少这些运行时依赖：" + ", ".join(sorted(missing))
            + "\n  先跑 `npm ci` 再生成清单（⛔ 不从 lockfile 反推，那是第二份真值）"
        )
    return sorted(found.values(), key=lambda r: (r["name"].lower(), r["version"])), []


def npm_build_only():
    """构建期工具：产出的 bundle 里**不含**它们的代码，单独列出以示无遗漏。"""
    pkg_json = os.path.join(ROOT, "package.json")
    with open(pkg_json, encoding="utf-8") as fh:
        root = json.load(fh)
    rows = []
    for name in sorted(root.get("devDependencies") or {}):
        path = os.path.join(ROOT, "node_modules", *name.split("/"), "package.json")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                pkg = json.load(fh)
            rows.append({
                "name": pkg.get("name") or name,
                "version": pkg.get("version") or "",
                "license": pkg.get("license") or "",
                "repo": npm_repository(pkg),
            })
        else:
            rows.append({"name": name, "version": "", "license": "", "repo": ""})
    return rows


# ── 渲染 ─────────────────────────────────────────────────────────────────


def table(rows):
    out = ["| 包 | 版本 | 许可证 | 上游仓库 |", "|---|---|---|---|"]
    for r in rows:
        lic = r["license"].replace("|", "\\|") or "⚠️ 未声明"
        repo = r["repo"].replace("|", "\\|") or "—"
        out.append(f"| `{r['name']}` | {r['version']} | {lic} | {repo} |")
    return "\n".join(out)


def flagged(rows, levels):
    hits = []
    for r in rows:
        level, note = classify(r["license"])
        if level in levels:
            hits.append((level, r, note))
    return hits


def render():
    rust = rust_packages()
    npm, _ = npm_packages()
    build_only = npm_build_only()

    lines = []
    add = lines.append
    add("<!-- 由 `scripts/gen-third-party.py` 生成，⛔ 不要手改；改规则请改脚本后重跑 `make third-party`。 -->")
    add("")
    add("# 第三方声明 / Third-Party Notices")
    add("")
    add("本文件列出 rmd 分发产物中包含的第三方组件及其许可证。")
    add("")
    add("> ⭐ **rmd 自身采用 GPL-3.0-or-later**（2026-10-23 拍板，见仓库根 `LICENSE`）。")
    add("> ⚠️ 二进制里链着 GPL-3.0-or-later 的 `flowmaid`——**与项目许可证相同 ⇒ 相容**；")
    add("> 分发时按 GPL 随附源码即可，不再是阻断项。")
    add("")
    add("## 1 这份清单是怎么来的")
    add("")
    add("```bash")
    add("make third-party        # = python3 scripts/gen-third-party.py")
    add("make check-third-party  # 只校验：磁盘上的这份与「现在重新生成」逐字节相同")
    add("```")
    add("")
    add("- **Rust 侧**：`cargo metadata --locked --features gui --filter-platform "
        + TARGET + "`。")
    add("  ⚠️ 带 `--features gui` 是因为 `tauri` / `notify` / `muda` 是 optional 依赖；")
    add("  不带它会漏掉整棵 GUI 依赖树。`--filter-platform` 只保留该目标上真会编译的包。")
    add("- **npm 侧**：从 `package.json` 的 `dependencies` 出发，在 `node_modules/` 里递归收集。")
    add("  `devDependencies`（只有 `esbuild`）只在构建期用，产出里不含它的代码，单列在 §6。")
    add("- ⛔ **不联网**：两个来源都是本机已有的锁文件 / 已安装包。")
    add("")
    add("## 2 ⚠️ 必须由人拍板：与项目许可证不相容的依赖")
    add("")
    blockers = flagged(rust + npm, {"copyleft", "unknown"})
    if blockers:
        add("| 级别 | 组件 | 许可证 | 后果 |")
        add("|---|---|---|---|")
        for level, r, note in blockers:
            label = "🚫 阻断" if level == "copyleft" else "❓ 未知"
            add(f"| {label} | `{r['name']} {r['version']}` | {r['license']} | {note} |")
        add("")
        add("⚠️ **上表里每一条都与项目许可证冲突**——")
        add("在它被解决之前，公开产物只能标为「本地候选」，⛔ 不能作为已发布版本分发。")
    else:
        add("无。所有依赖都可以随 rmd 一起按 " + PROJECT_LICENSE + " 分发"
            "（GPL-3 系著佐权组件见 §3 的「随附源码」义务）。")
    add("")
    add("## 3 需要保留声明的许可证（非阻断，但有义务）")
    add("")
    obls = flagged(rust + npm, {"obligations"})
    if obls:
        add("| 组件 | 许可证 | 义务 |")
        add("|---|---|---|")
        for level, r, note in obls:
            add(f"| `{r['name']} {r['version']}` | {r['license']} | {note} |")
        add("")
        add("⚠️ 上表的义务是**逐条**的：MPL-2.0 只约束它自己的那几个源文件，")
        add("不要求 rmd 整体换许可证；Unicode 那几条要求随分发附带许可证与版权声明。")
        add("")
        add("⚠️ **尚未做到**：分发包里还没有随附各许可证的**全文**。")
        add("这项工作属于打包环节（DMG 里放 `LICENSES/`），是首个二进制发布前的待办。")
    else:
        add("无。")
    add("")
    add("## 4 Rust 依赖（`" + TARGET + "`，`--features gui`）")
    add("")
    add(f"共 **{len(rust)}** 个第三方 crate。")
    add("")
    add(table(rust))
    add("")
    add("## 5 前端依赖（运行时，打进 `cm6.bundle.js`）")
    add("")
    add(f"共 **{len(npm)}** 个第三方 npm 包。")
    add("")
    add(table(npm))
    add("")
    add("## 6 构建期工具（不分发）")
    add("")
    add(table(build_only))
    add("")
    add("## 7 素材")
    add("")
    add("- 应用图标 `src-tauri/icons/icon.svg` 是本仓库自绘的几何图形，无第三方素材。")
    add("- 仓库根的 `mark_feixiang.md` 是第三方产品的说明文档，仅作排版对照样本，")
    add("  **不进入公开导出树**（`scripts/export-public.sh` 里显式排除）。")
    add("")
    return "\n".join(lines) + "\n"


def main():
    check = "--check" in sys.argv[1:]
    text = render()
    if check:
        try:
            with open(OUT, encoding="utf-8") as fh:
                current = fh.read()
        except FileNotFoundError:
            sys.exit("✗ 还没有 THIRD-PARTY-NOTICES.md：先跑 `make third-party`")
        if current != text:
            sys.exit(
                "✗ THIRD-PARTY-NOTICES.md 过期了（依赖变了，清单没跟上）。\n"
                "  跑 `make third-party` 重新生成，然后看一眼 diff 再提交。"
            )
        print("✓ THIRD-PARTY-NOTICES.md 与当前依赖一致")
        return
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(text)
    print(f"✓ 已写 {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
