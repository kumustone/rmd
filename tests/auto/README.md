# rmd 自动化测试框架（`tests/auto/`）

> 2026-11-08 建立。目标：把「方方面面」的功能变成**可并行、可计数、失败会退非零**的用例，
> 而不是一堆散落的脚本。⛔ 不抢焦点、不合成系统事件、不合成按键、不启动**可见**窗口
> ——只跑纯逻辑、离屏 CLI／离屏 WKWebView 与 Node 纯逻辑测试；需要可见窗口/真实 IME 的项仍归人工验收。

## 跑法

```bash
python3 tests/auto/runner.py                     # 全量（rust + exec + js）
python3 tests/auto/runner.py --jobs 8            # 指定并发
python3 tests/auto/runner.py --family md-inline  # 只跑某族（按 family/id/路径子串）
python3 tests/auto/runner.py --list              # 只统计，不执行
python3 tests/auto/runner.py --selftest          # 框架自检：必过退 0，必败退 1
make test-auto                                   # 要求总数 ≥ 10000
```

退出码：`0` 全绿；`1` 有用例失败；`2` 框架/构建错误；`3` 总数不足 `--min-cases`。

三条执行路径：

| 路径 | 位置 | 执行者 | 并行方式 |
|---|---|---|---|
| `rust` | `cases/rust/**/*.jsonl` | `src-tauri/src/autotest.rs`（`cargo test` 内） | 工作线程 = CPU 数 |
| `exec` | `cases/exec/**/*.jsonl` | `runner.py` 起子进程 | `--jobs` 个线程 |
| `js` | `js/**/*.test.js` | `node --test`（TAP） | 文件级 `--jobs` 并发 |

⛔ CLI 二进制走**隔离 target 目录** `target/autotest/release/rmd`，不碰 `target/release`
（后者可能是 GUI 构建，后构建者会覆盖）。首次运行会构建一次；`--no-build` 跳过。
⚠️ Rust 矩阵的 `cargo test` 同样由 runner 强制 `CARGO_TARGET_DIR=target/autotest`——
测试产物也不许落进 `target/release`。

## 历史 bug 回归族（`bugs-*`）

2026-11-08 起，`docs/bugs/` 里每条已修复的缺陷都要在自动化里留下**可复现的边界**，
并按它的**失效轴**举一反三（同类输入 × 变体 × 边界值），而不是只抄 bug 报告里那一行。

| family | 前缀 | 位置 | 覆盖面 |
|---|---|---|---|
| `bugs-block` | `bugblk-` | rust | 块级语法、空标题、软/硬换行、块边界 |
| `bugs-inline` | `buginl-` | rust | 行内标记、实体、代码、公式、脚注 |
| `bugs-services` | `bugsvc-` | rust | 目录 / 搜索 / 块表 / 单元格 / 任务 / 偏移 |
| `bugs-platform` | `bugplat-` | rust | 语言裁定、配置归一化、AppleLanguages |
| `bugs-tables` | `bugtbl-` | rust | 表格/单元格可写区与对齐 |
| `bugs-find` | `bugfind-` | rust | 文档搜索与目录锚点 |
| `bugs-links` | `buglink-` | rust | 链接分类、编解码、argv、相对路径 |
| `bugs-options` | `bugopt-` | rust | 渲染选项矩阵（sourcepos / heading_ids / math / hardbreaks） |
| `bugs-cli` | `bugcli-` | exec | 离屏 CLI（`probe` / `bench` / 参数校验） |
| `bugs-live-*` | — | js | 编辑态：模型、选区、输入、装饰、预编辑、事务 |
| `bugs-services-*` | — | js | 前端 services 纯逻辑 |
| `bugs-components-*` | — | js | 前端组件（树、侧栏、设置、浮层…） |
| `bugs-editor` | — | js | 编辑器装配、保存、预览调度 |

写这类用例的硬规则：

1. 每组前写 `# 源自 docs/bugs/NNNN（标题）`，让失败能直接回溯到缺陷档案。
2. **只钉当前行为 + 显式标注**：发现新的可疑行为时，用例按**现状**写绿，并加
   `# ⚠️ 疑似缺陷：…` 注释说明为什么可疑；⛔ 不要为了让用例变绿去改产品代码，
   也⛔ 不要把可疑行为默默写成「期望」。
3. 延伸要成组：同一失效轴至少覆盖「正常 / 边界 / 畸形 / 变体」四类输入。

## rust 用例（JSONL，一行一条）

```json
{"id":"md-h-01","family":"md-inline","check":"html","input":{"md":"# 标题"},"expect":{"contains":["<h1>标题</h1>"]}}
```

- `id` 全库唯一；`family` 用于过滤；`check` 缺省 `html`。
- `input.opts` 可选：`render_sourcepos` / `sourcepos_chars` / `heading_ids` /
  `math_dollars` / `hardbreaks`（缺省取产品默认值）。

### 期望值语义（除 `html`/`diagram` 外的所有检查器）

`expect` 对象里：

| 键 | 含义 |
|---|---|
| `count` | 结果是数组时，元素个数必须相等 |
| `items` | 数组结果的**前缀**逐项部分匹配（对象只比给出的键） |
| `at` | `{"下标": {部分对象}}`，只匹配指定下标 |
| 其它键 | 与结果对象的同名字段递归比较；对象按**子集**比，数组按**长度相等**逐项比 |

### 检查器一览

| check | input | 结果形状 | 典型 expect |
|---|---|---|---|
| `html` | `{md, opts?}` | HTML 字符串 | `contains` / `not_contains` / `equals` / `starts_with` / `ends_with` / `counts` / `min_len` / `max_len` |
| `toc` | `{md, opts?}` | 数组 `{level,text,id,line,span}` | `count` / `items` / `at` |
| `search` | `{md, needle}` | 数组 `{line,span,utf16,excerpt}` | `count` / `items` / `at` |
| `blocks` | `{md, opts?}` | 数组 `{index,kind,start_line,end_line,editable}` | `count` / `items` / `at` |
| `cells` | `{md, opts?}` | 数组 `{block,cells:[{line,from,to,writable,text}]}` | 同上 |
| `tasks` | `{md, opts?}` | 数组 `{block,items:[{line,from,to,checked,writable,symbol}]}` | 同上 |
| `offset` | `{md,line,col,unit?,which?}` | `{offset}` | `{"offset": 12}` 或 `{"offset": null}` |
| `lang` | `{preference,system:"zh"\|"en"}` | `"zh"`/`"en"` | `{"$":...}`？——结果就是字符串，见下 |
| `lang_apple` | `{text}` | 同上 | 同上 |
| `link` | `{href}` | `{kind,...}` | `{"kind":"external","url":"https://…"}` |
| `link_codec` | `{fn:"encode"\|"decode"\|"normalize", s}` | `{value}` | `{"value":"…"}` |
| `envelope` | `{raw}`（可含 `﻿`、`\r\n`） | `{bom,eol,lossy,normalized,restored}` | `{"eol":"crlf","bom":true}` |
| `config` | `{fn, ...}` | `{value}` | `{"value": 1.5}` |
| `diagram` | `{kind:"flow"\|"sequence", src}` | `{ok,out,reject}` | `ok` / `out_contains` / `out_not_contains` / `reject_contains` |
| `mermaid_class` | `{src}` | `{ok,kind\|reject}` | `{"ok":true,"kind":"flowchart"}` |
| `argv` | `{fn:"editor", configured?, path}` | `{argv,len}` | `{"len":2,"argv":[...]}` |

⚠️ `lang` / `lang_apple` 的结果是**字符串**，`expect` 也写成字符串：
`{"check":"lang","input":{"preference":"zh","system":"en"},"expect":"zh"}`。

⚠️ `config.fn` 支持：`normalize_language`（参数 `arg`，可为 `null`）、`clamp_num`
（`v/lo/hi/fallback`）、`clamp_content_width`（`v`）、`normalize_ignore_dirs`（`raw`）。

## exec 用例（JSONL，一行一条）

```json
{"id":"cli-version","argv":["{{RMD}}","--version"],"expect":{"exit":0,"stdout_re":["^rmd \\d+\\.\\d+"]}}
```

- 占位符：`{{ROOT}}`、`{{AUTO}}`、`{{TMP}}`（本条用例的私有临时目录）、`{{PY}}`、`{{NODE}}`、`{{RMD}}`。
- 可选字段：`files`（`{相对路径: 内容}`，对象/数组自动写 JSON）、`stdin`、`cwd`（缺省 `{{TMP}}`）、
  `env`、`timeout_s`（缺省 30）。
- `expect` 支持：`exit`（缺省 0）、`stdout_*` / `stderr_*`（`contains` / `not_contains` /
  `re` / `equals`）、`stdout_json`（子集匹配）、`files_exist` / `files_absent` /
  `file_contains`（`{相对路径: [子串…]}`）。
- ⛔ 绝不写「裸 `rmd` / `rmd <文件>`」：带 `gui` 的二进制会**开窗口**。
  安全子命令只有 `probe`、`bench`、`--version`、`--help` 与故意写错的参数。

## JS 用例（`node --test`）

- 放在 `js/<family>/*.test.js`；**扁平** `test("名字", fn)`，不要嵌套 `t.test`（按叶子计数）。
- 沿用 `tests/js/` 的既有做法：读源码 → `new Function('window', src)(win)` → 断言。
  ⛔ 不 `require` 产品文件（它们是浏览器经典脚本，不是 CommonJS）。
- 只测**纯逻辑/最小假 DOM**；不启动浏览器、不启动 app。
- 文件内每个 `test()` 都算一条用例。

## 给新增用例的硬约束

1. **注释与用例名用中文**，名字要说明「守的是什么错」，不要写 `test1`。
2. ⛔ 不改产品代码来让用例变绿。发现产品缺陷 → 记 `docs/bugs/NNNN`，并在用例里加
   `# ⚠️ 疑似缺陷：…` 注释；套件是**回归闸门**，这类用例按**现状**钉绿（修复后它们会转红，
   届时同步改判并关闭 bug 文件）。⛔ 不要把可疑行为默默写成「期望」——注释里必须给出
   bug 编号或「为什么可疑」。
3. ⛔ 不引第三方测试框架/依赖；Python 只用标准库，JS 只用 `node:test`。
4. 每条断言必须能在产品行为被改坏时**真的红**；只断言「文件存在」「函数被调用」不算。
5. 引用条数前先实跑 `runner.py --list` / 全量报告，⛔ 不估算。

## GUI 层（`design/0064` P1，2026-11-15）

`tests/auto/runner.py` 的**第四执行器**：把既有离屏探针当用例跑。⭐ 三行分母**永远分开报**，
`--min-cases` 只约束 logic；GUI 条数⛔ 不并进 logic 总数（`design/0064` §2.1）。

```bash
make test-gui                          # = runner.py --with-gui --no-rust --no-exec
python3 tests/auto/runner.py --list    # 打印 GUI 用例数与驱动接入数
```

- 用例：`tests/auto/cases/gui/*.jsonl`，一行一条，**只描述**「跑哪个驱动、要什么结论」：
  ```json
  {"id":"gui-i18n","driver":"i18n","argv":["make","--no-print-directory","probe-i18n"],
   "args":["--json"],"expect":{"verdict":"pass","min_checks":15},"timeout_s":600}
  ```
- 驱动清单：`tests/auto/gui/manifest.json`（form／script／target／退出码映射／是否支持
  `--json`／`wired`／估算耗时）。⛔ 执行器**不复制判据**：结论只来自驱动退出码与它自己的
  `--json` 的 `结论` 计数（`失败 == 0`、`通过 >= min_checks`）。
- 退出码归一化：`0/1/2/3/4` 按 manifest 映射到 `pass/fail/skip/harness`；**未登记的码一律
  harness 错（退 2）**。没有 `swiftc` ⇒ offscreen 驱动记「跳过」，⛔ 不是通过。
- 未接入（`wired:false`）的驱动出现在报告里记「跳过」，⛔ 不许读成绿。

⚠️ 边界（与 `design/0064` §4 一致）：不做真实 IPC、不做真实磁盘写、不启动可见窗口、
不合成系统事件、不驱动输入法。GUI 层绿灯⛔ 不等于人工验收。
