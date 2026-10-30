# benchmarks —— 语料与实测结果

> 归属：`docs/design/0002-性能原型与技术验证.md` §7.1（语料矩阵）与 §7.2（实测清单）。
> **性能数字只落在这里与 `docs/research/notes/`**——设计文档只引用，不重述。

## 1. 两个目录，两种性质（⛔ 别搞混）

| 目录 | 性质 | 能不能删 | 能不能覆盖 |
|---|---|---|---|
| `corpus/` | **可再生的中间产物** | ✅ 删了跑 `gen_corpus.py` 就回来 | ✅ `--force` |
| `results/` | **历史记录**（`docs/README.md` §6） | ⛔ **不删** | ⛔ **不覆盖**（见下） |

⚠️ **`results/` 里有三种 schema，⛔ 三类不许混读**：`rmd-bench/1`（后端计时矩阵）、
`rmd-gui-measure/1`（GUI 侧同一次打开内的分段，§7.3.1 的**口径 A**）、
`rmd-wkwebview-probe/1`（环境能力快照）。判据是文件里的 `schema` 字段，**不是文件名**。

⚠️ **`results/` 是历史记录**，理由写在 `design/0002` §8：
「删掉就要重跑一遍才知道当初为什么这么决策」。
将来若发现某个数字是错的（例如计时口径有 bug），**原地改并留痕，不并存第二份**。

⚠️ **同一天同一机型重跑会覆盖同名文件**（文件名是 `<日期>-<机型>.json`，
GUI 侧与 A/B 各自带后缀：`-gui.json` / `-gui-scroll.json` / `-sourcepos-{off,on}.json`）。要留两次对比，
**先把旧的改名**再跑。
⚠️ 唯一一次**故意的**同名覆盖：`2026-10-14-Mac14,9-gui-scroll.json` 的第一版是**空测量**
（滚动容器选错，`滚到` 恒为 0），**同日重跑覆盖**——它没有留下第二份，
因为它的滚动四列不是"另一个数字"而是**没量到**；留痕在两处：§5 的表里、
以及 `docs/research/notes/0013` §3⑦ 与 §5。

## 2. 语料

```bash
python3 benchmarks/gen_corpus.py          # 17 个文件，约 53 MB
python3 benchmarks/gen_corpus.py --help   # --out / --seed / --only / --only-feature / --force
```

⛔ **INV-CORPUS-01：语料必须由脚本生成，不许手工找文件**（`design/0002` §7.1）。
理由是手工找来的文件无法复现，于是"上次跑得快不快"永远说不清。

- **种子固定** `20261013`；每个文件的 rng 由 `f"{seed}:{size}:{feat}"` 派生，
  所以**只改一个文件不会让其它文件全部变样**——语料的可比性靠这个保住。
- **大小是按字节逼近**的（切在段落边界），偏差通常在 ±3% 以内。
  ⚠️ A/B 比较时用**实际字节数**，不要用目标值。

矩阵：4 个量级（S 100 KB / M 1 MB / L 5 MB / XL 10 MB）× 4 类结构
（`plain` / `headings` / `code` / `tables`）= 16，外加 **`mixed.md`**（1 MB）= **17**。

> ⚠️ `design/0002` §7.1 的汇总句写「共 16 个文件」，漏算了 `mixed.md`
> （§7.1 正文与 §7.2 第 5 条都提到了它）。**以实际的 17 为准**，
> 差异已记在 `design/0002` §10.2。

📌 **哪个文件对应哪条指标**：`vision/0001` §9 的「3000 个标题」从
**`M-headings.md`** 上读（实测 3 180 项，+6%）；别的量级按同密度缩放。

## 3. 怎么跑

**后端（无窗口，`rmd-bench/1`）**

```bash
cd src-tauri && cargo build --release && cd ..

# 单文件
./src-tauri/target/release/rmd bench benchmarks/corpus/L-plain.md --repeat 5

# 完整矩阵 + 落盘（⚠️ 先确认不会覆盖要留的历史）
./src-tauri/target/release/rmd bench benchmarks/corpus/*.md --repeat 5 \
  --json benchmarks/results/$(date -u +%F)-$(sysctl -n hw.model).json
```

常用开关：`--repeat`（默认 5）· `--warmup`（默认 1）· `--no-toc` · `--no-search` ·
`--needle`（默认 `文档`，**必须是语料词库里必然存在的词**）· `--chars`（见下）· `--date` ·
⭐ `--sourcepos`（默认开；见下）。

⚠️ **`--warmup` 不要设 0**：第一轮会把冷页与首次分配算进去。

⭐ **`--sourcepos` 是 2026-10-14 新增的口径开关**，`--sourcepos false` 关掉
`data-sourcepos` 的输出。⚠️ **它默认是 `true`（"开着"）不是为了好看，而是为了不换口径**：
本目录里两份历史 `rmd-bench/1` 都是在开着的时候跑的，改默认值等于让跨日期的数字不可比。
**产品路径（GUI）走的是关掉的那一份**（`design/0002` §10.2 定案）——两者的差是
**+3.0% ～ +99.2% 的 HTML 体积**（4 个 10 MB 语料的实测，见 `docs/kb/0002` §4），
⛔ **只在 §7.3.1 的口径 B 下对照，不许相加**。

**GUI 侧（真开窗口，`rmd-gui-measure/1`，§7.3 口径 A）**

```bash
make build-gui            # ⛔ 必须含 GUI 的构建，脚本会自己验 rmd://menu 标记
make measure-gui                        # 8 个语料 + 启动地板夹具 × 3 轮
make measure-gui ARGS="--rounds 5"      # 换轮数
make measure-gui ARGS="--force"         # 允许覆盖同名结果（⛔ 默认拒绝）
```

⚠️ 它**一文件一进程**、**每次都顺带跑一份 1 段的极小文档**当"启动地板"。
**分析 `T6`/`T6b` 前必须先扣掉地板**（`docs/research/notes/0007`），否则连 117 B
的文档都会显示"慢"。⚠️ 前端那几个数**被 WebKit 粗化过**（本机 1 ms）⇒
`T5 = 0.0` 读作"**不到一个刻度**"，⛔ 不是"零成本"（结果文件的 `口径.clock_ms` 写着这个刻度）。

## 4. `results/*.json` 的 schema（`rmd-bench/1`）

顶层：`schema` · `date` · `rmd_version` · `comrak_version` · `profile` · `口径` ·
`环境` · `参数` · `内存` · `文件[]`。

每文件一条：`source_bytes` · `html_bytes` · `html_per_source` · `ast_nodes` ·
`toc_entries` · `t8_hits` + 六个阶段的 `{min_ms, median_ms, max_ms}`。

⛔ **读这个文件前先读 `口径` 与 `内存` 两个键**，那里写着三条引用禁忌：

1. **不与 GUI 的绝对时间相加**（口径 B · 跨进程对照）；
2. **`T7` / `T8` 只是 Rust 侧的半段**——"目录可用"与前端搜索耗时在 GUI 侧另计；
3. **内存不是一个"总内存"**：`peak_rss_sampled` / `resident_size_max_bytes` 是
   **整个进程**跑完全部文件的水位，**含 T8 的命中列表**，且**不含 WebView**。
   要单文件、纯净的常驻值：`--no-search` 且一文件一进程地跑。

`--chars` 是**计划外的开关**（`design/0002` §10.2 有记），只为回答
`docs/kb/0002` 那条「`sourcepos_chars` 要多少毫秒」；本项目**不打算用它**
（理由与数字见 `docs/kb/0002` §3）。

## 5. 当前结果

| 文件 | 说明 | schema |
|---|---|---|
| `results/2026-10-13-Mac14,9.json` | 步骤 1 首次全量（17 文件 × 5 轮）。**结论摘要在 `docs/research/notes/0005`**；由 `make bench` 产出 | `rmd-bench/1` |
| `results/2026-10-14-Mac14,9.json` | 同日重跑（17 文件 × 5 轮，参数逐项相同）。⭐ **它与 10-13 的差别是一份"干净对照"**：四份 XL 里**只有 `XL-code` 动了**——`html/src` **1.23 → 4.29**、`t3_render` **13.5 → 3354.0 ms**（≈ **248×**），而 `t2_parse` **两轮相同（15.7 vs 16.1 ms）**、`XL-plain`/`XL-tables`/`XL-headings` 三行在噪声内不动。⇒ `design/0007`（代码高亮）的代价**全部落在渲染阶段、且只对代码密集文档显著**（分析见其 §10.3） | `rmd-bench/1` |
| `results/wkwebview-capabilities-2026-10-13-Mac14,9.json` | **批次 0**：真机 WKWebView 的观测能力真值（`supportedEntryTypes` / `observe()` / `paint`）。⚠️ **不是基准数字，是能力探测**——它回答"哪些 API 根本不存在"，不回答"多快"；由 `tools/wkwebview-probe/run.sh` 产出，**不是** `make bench` | `rmd-wkwebview-probe/1` |
| ⭐ `results/2026-10-14-Mac14,9-gui.json` | **批次 2 · GUI 侧**（`design/0002` §7.3 口径 A）：8 个语料 × 3 轮 + 1 份**启动地板夹具**，一文件一进程、先烧一轮丢掉。六个量（`T4`/`T5`/`T5b`/`FCP`/`LCP`/`R`）+ DOM 规模 + WebContent 进程 RSS。**含逐轮样本**（不只是中位数）。**结论摘要在 `docs/research/notes/0013`**；由 `make measure-gui` 产出 | `rmd-gui-measure/1` |
| ⭐ `results/2026-10-14-Mac14,9-gui-scroll.json` | **批次 2 · 同日补采的「滚动那半」**（`design/0002` §10.5.3 的缺口）：同一套 8 语料 × 3 轮 + 地板，**多数了四列**——`T5c`（跳到底＋强制布局，同步）、`T5d`（回顶再到底，同步对照）、`T5e`（到下一帧，⚠️ **异步**、被帧率量化）、`滚到`/`可滚高`/`scroll_el`（**容器与"到底滚没滚"的自证**）。⭐ 结论：**`T5c/T5b` = 0.00–0.01× ⇒ 布局是一次性的，滚到底不重付**（`XL-tables` 3 ms vs 3 683 ms）；⚠️ 绘制那半不是零。摘要见 `notes/0013` §3⑦ <br>⚠️ **留痕**：同名文件的第一版是**空测量**（容器写死成 `document.scrollingElement`＝`html`，而真正在滚的是 `body` ⇒ 一次都没滚），已**同日重跑覆盖**；`滚到 > 0` 与 `空测量` 字段就是为此加的 | `rmd-gui-measure/1` |
| ⭐ `results/2026-10-14-Mac14,9-sourcepos-off.json`<br>`…-sourcepos-on.json` | **`render_sourcepos` 的 A/B**（4 个 XL 语料 × 3 轮）：两份**只差** `参数.parse_opts.render_sourcepos`，用来回答 `docs/kb/0002` 那条"10 MB 级上的膨胀比值未测"。⭐ 结论：**+3.0%（`XL-code`）～ +99.2%（`XL-tables`）⇒ 它不是常数、取决于元素密度**（`kb/0002` §4）。⚠️ 手动跑 `rmd bench … --sourcepos {true,false}` 产出，**不是** `make bench`（后者是 17 文件 × 5 轮的固定矩阵） | `rmd-bench/1` |

⚠️ **两份（10-13/10-14 全量）的 `参数` 里没有 `parse_opts`，但它们都是同一个口径。**
那个键 2026-10-14 才加（`rmd bench --sourcepos` 落地时）——**两份历史文件都是在
`render_sourcepos = true`（当时的默认）下跑的**，⛔ 不要因为缺这个键就以为它们不可比。
⭐ 反过来，**读 2026-10-14 起的新文件时第一眼就该看它**：`render_sourcepos` 开/关会让
HTML 体积差出 **+3.0% ～ +99.2%**、`t3` 最坏 **1.97×**（4 个 XL 语料的实测见
`docs/kb/0002` §4 与上面那两份 `-sourcepos-{off,on}.json`），而**文件名上看不出来**
（除了那两份**故意**带后缀的 A/B 文件本身）。

⚠️ **三类文件不要混读**：`rmd-bench/1` 是后端计时矩阵（同机可重跑、可比较）、
`rmd-gui-measure/1` 是**同一时间轴上的 GUI 分段**（口径 A，⛔ 不与前者相加）、
`rmd-wkwebview-probe/1` 是**环境能力快照**（换 macOS 版本就可能变，且是"有/没有"而非"快/慢"）。
⚠️ 而**同为 `rmd-gui-measure/1` 的两份也不要混读列**：`…-gui.json` **没采过滚动**，
它的 `T5c/T5d/T5e/滚到/可滚高` 是**缺失**（⛔ 不是 0）——那几列只在 `…-gui-scroll.json` 里有。
三者都受同一条纪律约束：**落在本目录就是历史记录，⛔ 默认不覆盖**
（`make bench` / `make measure-gui` / `run.sh` 都会拒绝覆盖同名文件，除非显式 `--force`）。

⚠️ 这一批是 `comrak 0.56.0` + `--release` + 单机（`Mac14,9`/aarch64/10 核）的数据。
**换机器、换 comrak 版本、换 profile 都必须重跑**，⛔ 不要把旧数字当新基线。

### ⚠️ 刻意**不在**这里的东西

**批次 1（`design/0002` §10.4，「能打开」）的冒烟数字，有意不落进本目录。**
`make smoke` 会开窗、会打印 T1/T2/T3 与 DOM 规模，看起来很像一份结果——但它
**单次、无预热、只跑 4 个 XL 文件**，不满足 `design/0002` §7.3.1 的口径
（`--release` + **多轮中位数** + 全 17 文件）。

把它写进 `results/` 会**污染"同口径可比"这个前提**——而本目录存在的全部意义就是那个前提。
要引用 GUI 侧的数字，用**批次 2 按 §7.3 协议重采**的那一份。

同理，`make smoke` 打印的 **Tauri WebView 能力**（`supportedEntryTypes`）也**不落盘**：
它是每次重跑的**活检查**，落成快照只会变成一份会过期的假依据（`docs/kb/0003` §④）。
