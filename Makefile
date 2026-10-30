# rmd Makefile —— 本地 build / run / 测量入口
#
# ## 这个文件里哪些命令是有讲究的
#
# 1. **`bench` 拒绝覆盖 `benchmarks/results/` 里已有的同名文件。**
#    `results/` 是**历史记录**（`docs/README.md` §6、`design/0002` §8）——
#    「删掉就要重跑一遍才知道当初为什么这么决策」。
#    文件名是 `<日期>-<机型>.json`，所以**同一天同一机型重跑就会撞名**。
#    这里把「静默覆盖」变成「显式拒绝」，并给出改名办法。
#
# 2. **`bench` 与 `test` 强制走 `--release`。**
#    debug 构建的解析/渲染数字会差一个量级，而且**看起来完全正常**——
#    这正是本项目最怕的那类错（`design/0002` §7.3）。`rmd bench` 自己也会把
#    `profile` 打在输出里，但入口这里先保证一次。
#
# 3. **`clean` 只碰 `src-tauri/target/`。** ⛔ 不动 `benchmarks/results/`（历史记录），
#    ⛔ 不动 `benchmarks/corpus/`（可再生，但要重跑一次 `make corpus` 才回来——
#    语料 53 MB，删了不划算，所以单独给了 `clean-corpus`）。
#
# 4. **`build` 与 `build-gui` 是两个目标，不要合并。**
#    不带 `gui` 的 `build` 只编 CLI（快，改一行 CLI 不用等 Tauri 链接）；
#    `build-gui` 才链整棵 Tauri 依赖树（几分钟）。
#    ⚠️ **前端资源（`src/*.html|js|css`）是编译期嵌进二进制的**
#    （`tauri-codegen` 的 `EmbeddedAssets`，见 `docs/kb/0006`）——
#    **改前端必须重跑 `make build-gui`**，刷新窗口没用。
#    批 1（`design/0002` §10.4）起 `dev`/`open` 是真 GUI。
#
# 5. **`build-gui` 会顺带刷新 PATH 里那份 `$(PREFIX)/rmd`。**（2026-10-15 起）
#    起因是一次真翻车：`0011` 的 `⌘F` 全部实现、`make smoke` 7/7 绿，
#    但 `~/.local/bin/rmd` 还是**前一天的**那份 ⇒ 用户敲 `rmd` 拿到的是没有 ⌘F 的旧版。
#    **根因是验证口径的盲区**：`test`/`smoke`/`lint-theme` 验的全是 `$(BIN)`，
#    **不是** PATH 里那份——「全绿」从不说明你敲的那个命令是新的。
#    要跳过（例如特意留一份旧的做对比）：`make build-gui NO_INSTALL=1`。
#    ⚠️ `make build`（纯 CLI）**不触发**安装——它写的是同一个路径，
#    装上它只会得到"看着装成功、一给文件就报没编译 GUI"，所以 `install` 自己也有 GUI 标记闸门。
#
# 6. **终端里直接敲 `rmd <路径>` 现在是静默的**（`design/0022`，2026-10-21）。
#    stdout 与 stderr **都连着终端**时，父进程把同一份二进制再拉一遍、自己立刻退出 0
#    ⇒ 提示符马上回来、终端零输出。⚠️ **退出码 0 只表示子进程创建成功**，
#    ⛔ 不表示窗口已打开。诊断去 `~/Library/Logs/io.github.kumustone.rmd/rmd.log`（按 pid 找）；
#    要看 stderr 就用 `RMD_FOREGROUND=1 rmd <路径>`（或 `make open DEV=1`）。
#    ⚠️ 任一 fd 被重定向（`2>log`、管道、`make smoke` 那一族）⇒ **不分离**，行为与以前逐字相同。
#
# ⚠️ macOS 自带 GNU Make 3.81：没有 `.ONESHELL`、没有 `!=`。多行逻辑靠 `\` 续行。
# ⚠️ 凡 shell 变量后面紧跟中文字符，必须写 `$${var}`——不加大括号时 bash 会把
#    中文的首字节并进变量名（个人仓库实测踩过，见 skills/personal-run-entry）。

.DEFAULT_GOAL := help
.PHONY: help doctor build build-gui cm6 dev open verify-0d smoke fidelity test test-js typecheck test-install-guard test-shell-vars lint-theme docs-check docs-check-selftest third-party check-third-party export-public scan-public check-links probe probe-wkwebview probe-find-key probe-editor-key probe-cm6 probe-editor-latency probe-scroll-sync probe-edit-chrome probe-vim-keys probe-image-viewer probe-reading-progress probe-dir-session probe-tree-menu probe-favorites-rootheader probe-i18n probe-link-nav probe-doclist probe-sidebar-search probe-index probe-live-step0 probe-live-commit probe-live-markup probe-live-block probe-menu corpus bench bench-quick bench-search measure-gui check clean clean-corpus install uninstall icon app install-app uninstall-app smoke-app dmg which-default default-app

# —— 路径与探测 ——
SRC        := src-tauri
BIN        := $(SRC)/target/release/rmd
CORPUS     := benchmarks/corpus
RESULTS    := benchmarks/results
MODEL      := $(shell sysctl -n hw.model 2>/dev/null || echo unknown)
TODAY      := $(shell date -u +%F)
OUTFILE    := $(RESULTS)/$(TODAY)-$(MODEL).json
CORPUS_N   := $(shell ls $(CORPUS)/*.md 2>/dev/null | wc -l | tr -d ' ')
RESULT_N   := $(shell ls $(RESULTS)/*.json 2>/dev/null | wc -l | tr -d ' ')
# probe-wkwebview 的 FORCE 开关：make probe-wkwebview FORCE=1 → 允许覆盖同名结果
FORCE      ?=
# make dev/open 要打开的文件。默认是批 1 的验收用例本身（10 MB 中文文档）。
FILE       ?= $(CORPUS)/XL-plain.md
# make install 的落点。默认放用户自己的 bin（⚠️ 本机 PATH 里它排第一），
# 因为 /usr/local/bin 在这台机器上**不存在**，建它要 sudo。换地方：make install PREFIX=/usr/local/bin
PREFIX     ?= $(HOME)/.local/bin

# ⭐ `design/0016`：日志目录（只读展示用）。⚠️ identifier **现读** tauri.conf.json，
# ⛔ 不在这儿另写一份字面量——那是第二份真值，改了配置这里会静默指错目录。
# 与 Rust 侧 `logging::default_dir()` 同形：$HOME/Library/Logs/<identifier>/。
LOG_ID     := $(shell sed -n 's/^[[:space:]]*"identifier"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' $(SRC)/tauri.conf.json | head -1)
LOG_DIR    := $(HOME)/Library/Logs/$(LOG_ID)

# ⭐ `design/0015`：应用包（手工组装，⛔ 不引 `tauri-cli`，见 `adr/0011`）
# 产物在 `build/`（**不入库**：可重建，且 `cmp` 判据要求它恒等于 $(BIN)）。
BUILD_APP     := build/macos/rmd.app
# `make install-app` 的落点。放 ~/Applications 是用户级安装的标准位置（⛔ 不要 sudo）。
APP_DIR       ?= $(HOME)/Applications
APP_INSTALLED := $(APP_DIR)/rmd.app
# `make default-app` 要设成默认的应用。换回 TextEdit：
#   make default-app APP=/System/Applications/TextEdit.app   （design/0015 §8 的回滚）
APP           ?= $(APP_INSTALLED)
# 默认处理器的**样本文件**：LaunchServices 是按"这个文件是什么类型"来认的，
# 所以要多递一个 `.md` 进去，⛔ 不硬编码 UTI（见 scripts/set-default-app.swift 的头）。
SAMPLE_MD     ?= tools/ime-sample.md
# `lsregister` 的路径（macOS 自带，没有公开命令名）。⚠️ 它**改的是 LaunchServices 缓存**，
# ⛔ 不是默认处理器——`INV-APP-04` 管的是后者。
LSREGISTER    := /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
# 「这个二进制含 GUI 吗」的**唯一判据**（doctor 与 install 共用这一处）。
# ⚠️ 为什么不能只看"文件在不在"：`build` 与 `build-gui` **写同一个路径**
#    （cargo 的两个 feature 组合共用 `target/release/rmd`）⇒ 先 build-gui 再 build
#    会**静默**把 GUI 二进制换成 CLI 的。那时 `rmd 文件.md` 只报"没编译 GUI"，
#    而文件本身看着完全正常（大小/权限/版本号都对）。
# ⚠️ 为什么选这个串：gui 模块（含 frontend 资源的 EmbedAssets）只在 `--features gui`
#    下编入，`rmd://menu` 是它 emit 的通道名（design/0010，冒烟里也有这条判据）。
GUI_MARKER := rmd://menu

# ⭐ `design/0012` 的前端构建产物（`make cm6` 产出，⛔ 不入库）。
# ⚠️ 路径**必须**在 `src/` 下：`src/` 是 Tauri 的 `frontendDist`，**整棵树**会被
#    嵌进二进制（`EmbeddedAssets`，`docs/kb/0006`）——而 `web.rs` 解析 Web 目录有
#    多级回退，挪到别处就是"读不到编辑器"。
# ⚠️ **2026-10-15 更正**：原文写「打进 `.app` 的 Resources」——**结论对、机制错**：
#    本仓库 `tauri.conf.json` 是 `"bundle": {"active": false}`，**当前没有 `.app`**，
#    也不存在 `Resources` 这一层（详见 `design/0012` §10.2 第 4 项）。
CM6_BUNDLE := src/vendor/cm6.bundle.js
# `make verify-0d` 打开的那份：⭐ 是**临时副本**，⛔ 不是仓库里那份。
# ⚠️ 理由：0d 的第 1 / 6 项要求**按 ⌘S**（验"逐字等于"与"组合态里不许存盘"）⇒ 一定会写盘。
#    直接开仓库里那份 ⇒ **验收一次脏一次工作树**，而"脏了"本身会污染后续 `git status` 判读。
# ⚠️ 用 `$(TMPDIR)`（macOS 上是每用户私有目录，形如 /var/folders/…/T/）。
IME_RUN    := $(TMPDIR)rmd-ime-sample.md

## 环境自检：工具链 / 依赖 / 语料 / 结果 / 仓库状态
doctor:
	@echo "═══ rmd 环境自检 ═══"
	@echo "本机      : $(MODEL) / $(shell uname -m) / $(shell uname -r)"
	@echo "cargo     : $(shell cargo --version 2>/dev/null || echo '✗ 没装')"
	@echo "rustc     : $(shell rustc --version 2>/dev/null || echo '✗ 没装')"
	@echo "  ⚠️ MSRV  : 1.89（Cargo.toml 的 rust-version；comrak 0.56.0 的要求）"
	@echo "python3   : $(shell python3 --version 2>/dev/null || echo '✗ 没装（make corpus 要用）')"
	@echo "swift     : $(shell swift --version 2>/dev/null | head -1 || echo '✗ 没装（make probe-wkwebview 要用）')"
	@echo "node      : $(shell node --version 2>/dev/null || echo '✗ 没装（⭐ make cm6 要用 —— design/0012 起本仓库第一次要求 node）')"
	@echo "npm       : $(shell npm --version 2>/dev/null || echo '✗ 没装（同上）')"
	@echo "  ⚠️ 用户机器**不需要** node：产物嵌进二进制（离线可用）"
	@echo "  CM6 产物  : $(shell if [ -f "$(CM6_BUNDLE)" ]; then newer=$$(find src/editor tools/cm6 package-lock.json package.json -newer "$(CM6_BUNDLE)" 2>/dev/null | head -1); if [ -n "$$newer" ]; then echo "⚠️ 比 $$newer 旧 ⇒ 重跑 make cm6（⛔ 不重跑就是一个没有编辑器的 rmd）"; else echo "✓ 在，且比 package-lock.json / src/editor/** / tools/cm6/** 新"; fi; else echo "⛔ 不在（跑 make cm6 —— 要 node）"; fi)"

	@echo "comrak    : $(shell grep -m1 '^comrak' $(SRC)/Cargo.toml 2>/dev/null | sed 's/ *#.*//')"
	@echo ""
	@echo "release 产物: $(shell test -x $(BIN) && echo '✓ 已编译' || echo '✗ 没编译（先 make build）')"
	@echo "  含 GUI 吗 : $(shell strings $(BIN) 2>/dev/null | grep -q '$(GUI_MARKER)' && echo '✓ 是（make build-gui 编的）' || echo '— 没有（make build 编的只有 CLI）；要装到 PATH 里得先 make build-gui')"
	@echo "PATH 里那份: $(shell if [ -L "$(PREFIX)/rmd" ]; then T=`readlink "$(PREFIX)/rmd"`; if [ -e "$(PREFIX)/rmd" ]; then echo "✓ $(PREFIX)/rmd 是**符号链接** → $${T}（应用内「安装命令行工具」建的：跟着 .app 走，⛔ make install 不碰它）"; else echo "⚠️ $(PREFIX)/rmd 是**悬空**符号链接 → $${T}（它指向的应用不在了；应用菜单里再装一次会改写它）"; fi; elif test -x "$(PREFIX)/rmd"; then if cmp -s $(PREFIX)/rmd $(BIN) 2>/dev/null; then echo '✓ 已装到 $(PREFIX)/rmd（拷贝），与当前 release 产物一致'; else echo '⚠️ 已装到 $(PREFIX)/rmd（拷贝），但**与当前产物不同**（跑过 make build？重跑 make build-gui 就会自动刷新）'; fi; else echo '— 没装到 PATH（跑 make build-gui 会自动装；或 make install；或在应用菜单里安装命令行工具）'; fi)"
	@echo ".app 产物  : $(shell if [ -x "$(BUILD_APP)/Contents/MacOS/rmd" ]; then R=`cat "$(BUILD_APP)/Contents/Resources/build-id.txt" 2>/dev/null`; N=`shasum -a 256 $(BIN) 2>/dev/null | cut -d' ' -f1`; if [ -n "$$R" ] && [ "$$R" = "$$N" ]; then echo '✓ 在（$(BUILD_APP)），装的是当前这一份'; else echo '⚠️ 在，但**不是当前 release 产物** ⇒ 重跑 make app（INV-APP-01：否则双击的是另一份）'; fi; else echo '— 没有（跑 make app；要 GUI 构建）'; fi)"
	@echo "  ⚠️ 判据是 build-id.txt（签名前的哈希）：bundle 签名会重写主可执行文件，cmp 在这条上永远不相等"
	@echo "已安装     : $(shell if [ -d "$(APP_INSTALLED)" ]; then R=`cat "$(APP_INSTALLED)/Contents/Resources/build-id.txt" 2>/dev/null`; N=`shasum -a 256 $(BIN) 2>/dev/null | cut -d' ' -f1`; if [ -n "$$R" ] && [ "$$R" = "$$N" ]; then echo '✓ $(APP_INSTALLED)（与当前 release 产物一致）'; else echo '⚠️ $(APP_INSTALLED) 在，但**不是当前 release 产物** ⇒ 退出应用后 make install-app（否则双击 / make open 跑的是旧的那份）'; fi; else echo '— 没装（make install-app；之后 make open 才会走后台）'; fi)"
	@echo "默认 .md   : $(shell if [ -f scripts/set-default-app.swift ]; then swift scripts/set-default-app.swift --show "$(SAMPLE_MD)" 2>/dev/null | head -1; else echo '— 缺 scripts/set-default-app.swift'; fi)"
	@echo "  ⚠️ 上面那条**只读**（⛔ 不改系统默认应用，INV-APP-04）；要改用 make default-app"
	@echo "日志目录  : $(LOG_DIR)"
	@echo "  当前文件: $(shell if [ -f "$(LOG_DIR)/rmd.log" ]; then N=`stat -f %z "$(LOG_DIR)/rmd.log" 2>/dev/null`; T=`stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$(LOG_DIR)/rmd.log" 2>/dev/null`; echo "✓ $$N 字节，最后写入 $${T}（本机时区）"; else echo '— 还没有（GUI 启动过一次之后才有；⛔ 这里不创建）'; fi)"
	@echo "  上一份    : $(shell if [ -f "$(LOG_DIR)/rmd.log.1" ]; then N=`stat -f %z "$(LOG_DIR)/rmd.log.1" 2>/dev/null`; echo "✓ $$N 字节（轮转保留的那一份）"; else echo '— 没有（还没轮转过）'; fi)"
	@echo "  ⚠️ 上限 2 MiB × 2 份（design/0016）；⛔ 硬崩报告不在这里，见 ~/Library/Logs/DiagnosticReports/"
	@echo "语料文件数  : $(CORPUS_N) / 17 $(shell test "$(CORPUS_N)" = "17" && echo '✓' || echo '⚠️ 先 make corpus')"
	@echo "结果文件数  : $(RESULT_N)"
	@echo "  本次会写到: $(OUTFILE)"
	@echo "  $(shell test -f $(OUTFILE) && echo '⛔ 已存在！make bench 会拒绝覆盖（这是有意的）' || echo '✓ 不与已有结果撞名')"
	@echo "批次 2 结果 : $(RESULTS)/$(TODAY)-$(MODEL)-gui.json"
	@echo "  $(shell test -f $(RESULTS)/$(TODAY)-$(MODEL)-gui.json && echo '⛔ 已存在！make measure-gui 会拒绝覆盖' || echo '✓ 不与已有结果撞名（make measure-gui）')"
	@echo "  ⚠️ make probe-wkwebview 也拒绝覆盖（加 FORCE=1 才覆盖）"
	@echo "步骤 0b 结果: $(RESULTS)/find-key-$(TODAY)-$(MODEL).json"
	@echo "  $(shell test -f $(RESULTS)/find-key-$(TODAY)-$(MODEL).json && echo '⛔ 已存在！make probe-find-key 会拒绝覆盖' || echo '✓ 不与已有结果撞名（make probe-find-key）')"
	@echo "CM6 冷启动结果: $(RESULTS)/cm6-coldstart-$(TODAY)-$(MODEL).json"
	@echo "  $(shell test -f $(RESULTS)/cm6-coldstart-$(TODAY)-$(MODEL).json && echo '⛔ 已存在！make probe-cm6 会拒绝覆盖' || echo '✓ 不与已有结果撞名（make probe-cm6）')"
	@echo ""
	@echo "git       : $(shell git rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo '✓ 是仓库' || echo '⚠️ 还没 git init（design/0002 §10.2 的提交列因此是空）')"
	@if bash scripts/lint-theme.sh >/dev/null 2>&1; then \
	  echo "主题闸门  : ✓ lint-theme 全绿（色值只在两处 + 三套主题 $$(bash scripts/lint-theme.sh 2>/dev/null | grep -m1 -oE '[0-9]+/[0-9]+')）"; \
	else echo "主题闸门  : ⛔ lint-theme 有失败项 —— 跑 make lint-theme 看详情"; fi
	@echo "文档闸门  : design 0002–0020 全部已通过并实施（0013 已否决）；⭐ 在途 = 0"
	@echo "            ⚠️ 状态全停在「已通过」——「已实施」只能由人改。每一份都**不算完工**：各自 §10 有未做项"
	@echo ""
	@echo "⚠️ 数字的可比性：数字只在「同机型 + 同 comrak 版本 + --release + 同语料 seed」下可比。"

## 编译 release 二进制（**只有 CLI**，不链 Tauri）
build:
	@echo "▶ cargo build --release（profile=release，lto=thin，codegen-units=1）"
	@cd $(SRC) && cargo build --release
	@echo "✓ $(BIN)  （$$(du -h $(BIN) 2>/dev/null | cut -f1)）"

## 编译 release 二进制（**含 GUI**，要链整棵 Tauri 依赖树，慢）
##
## ⚠️ 为什么分成两个目标：不分开的话，改一行 CLI 代码也要等几分钟的 Tauri 链接。
## ⚠️ `--features gui` 还决定 `cargo run -- <文件>` 走 `gui` 分支还是那句"没编译 GUI"。
##
## ⭐ `design/0012` §2.5-3 起它**依赖 `cm6`**（前端 bundle）：
##    编辑面是打进去的 `src/vendor/cm6.bundle.js`，产物不在就是"一个没有编辑器的 rmd"，
##    而界面上**看不出来**（只读阅读完全正常）——所以这里**前置 + 大声失败**，⛔ 不静默降级。
build-gui: cm6
	@echo "▶ cargo build --release --features gui（第一次会链 Tauri，几分钟）"
	@cd $(SRC) && cargo build --release --features gui
	@echo "✓ $(BIN)（含 GUI）  （$$(du -h $(BIN) 2>/dev/null | cut -f1)）"
	@echo "⚠️ 前端资源（src/*.html|js|css）是**编译期嵌进二进制**的"
	@echo "   （tauri-codegen 的 EmbeddedAssets）。改前端必须重跑本目标。"
	@if [ -n "$(NO_INSTALL)" ]; then \
	   echo "ℹ️ NO_INSTALL 非空 ⇒ **跳过**装到 $(PREFIX)/rmd——那份拷贝现在会过期（doctor 会 cmp 报出来）"; \
	 else \
	   echo "▶ 顺带刷新 $(PREFIX)/rmd（要跳过：make build-gui NO_INSTALL=1）"; \
	   $(MAKE) --no-print-directory install; \
	 fi

## 前端构建链（`design/0012` §2.5 / `adr/0009`）：把**钉死版本**的 CM6 打成一个经典脚本 bundle。
##
## ⚠️⚠️ **这是本仓库第一个要求 node 的目标。** 用户机器上**不需要** node——
##    产物**嵌进二进制**（`frontendDist` + `EmbeddedAssets`，离线可用）；
##    要 node 的只是**构建这一侧**。
##    ⚠️ **2026-10-15 更正**：原文写「打进 `.app` 的 Resources」——机制说错了，且
##    当前 `bundle.active = false` ⇒ **没有 `.app`**（见 `design/0012` §10.2 第 4 项）。
##
## ⚠️ 用 `npm ci` ⛔ **不是** `npm install`：后者会改 `package-lock.json`，
##    而那份锁文件是"数字与产物对得上"的唯一凭据（`design/0012` §1.3(d) 的实测
##    就是在这一组版本上量的）。
## ⭐ esbuild 的那串参数**只在 `package.json` 的 `scripts.build` 里定义一次**，
##    这里调 `npm run build`——⛔ 不把 6 个 flag 抄成第二份。
##
## ⭐ `npm ci` 会**先删掉 node_modules** 再装（这正是它比 install 可靠的原因），
##    代价是几秒到几十秒。所以下面加了一道**等价性判据**：`node_modules/.package-lock.json`
##    是 npm 自己写的"装的是哪一版"，它比 `package-lock.json` 新就说明装的是当前锁。
##    ⚠️ 判据失灵时的出口是 `make cm6 FORCE=1`（⛔ 不是"把判据删掉"）。
cm6:
	@test -n "$(shell command -v npm)" || { echo "⛔ 没有 npm —— CM6 要到 npm 上取（design/0012 §2.5-1）。这是本仓库第一次要求 node。"; exit 1; }
	@node tools/cm6/check-pins.mjs || exit 1
	@if [ -n "$(FORCE)" ] || [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then \
	   echo "▶ npm ci（⛔ 不是 npm install：后者会改 package-lock.json）"; \
	   npm ci --silent --no-audit --no-fund || { echo "⛔ npm ci 失败"; exit 1; }; \
	 else \
	   echo "ℹ️ node_modules 与 package-lock.json 一致 ⇒ 跳过 npm ci（要强制重装：make cm6 FORCE=1）"; \
	 fi
	@mkdir -p src/vendor
	@echo "▶ esbuild → $(CM6_BUNDLE)（--format=iife --global-name=rmdCM6）"
	@npm run build --silent || { echo "⛔ 打包失败"; exit 1; }
	@test -s "$(CM6_BUNDLE)" || { echo "⛔ 产物是空的：$(CM6_BUNDLE)"; exit 1; }
	@echo "✓ $(CM6_BUNDLE)  （$$(du -h $(CM6_BUNDLE) | cut -f1)）"
	@echo "  ⚠️ 它是**产物**，不入库（.gitignore 里那一行）；改变它的是 package-lock.json / src/editor/**"

## 打开一个窗口（批 1 的入口）。FILE=... 换文件
dev: open

## 打开一个窗口。默认打开批 1 的验收用例：10 MB 中文文档
##
## ⭐ `design/0015` §2.1⑦ 起**后台优先**：装了 .app 就走 `open -g`（终端立刻还给你，
##    关终端也不杀应用）；没装才回退到前台二进制。
## ⚠️ `-g`（background）**不把窗口带到前台**——这是根 `CLAUDE.md` 工作约定 4 的同一条：
##    打开一份文档**不值得**把用户正在用的应用挤掉。
## ⚠️ `DEV=1` 保留前台形态（要看 stderr 的时候用它）。⚠️ 两者**不会**同时生效：
##    `DEV` 非空 ⇒ 只走二进制，避免"以为在看日志、实际看的是后台那份"。
## ⭐ `design/0022` 起**直接敲 `rmd <路径>` 默认静默**（父进程拉起子进程后立刻退出）；
##    这两条前台分支因此**显式带 `RMD_FOREGROUND=1`**——它们嘴上说"终端会被占住"，
##    就**必须真的占住**，否则这句说明书就成了假话。
##    ⚠️ 想看后台那份的诊断：`~/Library/Logs/io.github.kumustone.rmd/rmd.log`（按 pid 找）。
open:
	@test -f "$(FILE)" || { echo "✗ 找不到 $(FILE)（先跑 make corpus，或指定 FILE=...）"; exit 1; }
	@if [ -n "$(DEV)" ]; then \
	   test -x $(BIN) || { echo "✗ 先跑 make build-gui"; exit 1; }; \
	   echo "▶ DEV=1 ⇒ 前台二进制（终端会被占住，stderr 直出）：$(FILE)"; \
	   RMD_FOREGROUND=1 $(BIN) "$(FILE)"; \
	 elif [ -d "$(APP_INSTALLED)" ]; then \
	   echo "▶ open -g -a $(APP_INSTALLED)「$(FILE)」（后台启动，终端不被占住）"; \
	   open -g -a "$(APP_INSTALLED)" "$(FILE)"; \
	 else \
	   echo "ℹ️ 没装 .app（$(APP_INSTALLED) 不存在）⇒ 回退到前台二进制"; \
	   echo "   装一次之后即可后台启动：make install-app（要 GUI 构建）"; \
	   test -x $(BIN) || { echo "✗ 先跑 make build-gui"; exit 1; }; \
	   RMD_FOREGROUND=1 $(BIN) "$(FILE)"; \
	 fi

## ⭐ `design/0012` §7 步骤 **0d（中文 IME）**的人工验收入口——⛔ **只能人敲**。
##
## ⭐⭐ **2026-10-16：这道闸门已由用户真人验收闭合**（`design/0012` §7 手工表第 14 行、
##    `design/0014` §10.4）——⚠️ **但本目标不删**：它仍是**回归入口**
##    （改编辑面 / IME 相关行为之后，重新敲一遍只用这一条命令）。
##    ⛔ 它「只能人敲」这条**性质不变**：探针与单测**结构上够不到**组合态。
## ⚠️ 为什么需要一个**专门的入口**：0d 的六项都要**在特定的结构里**敲
##    （普通段落 / 列表 / 标题 / 代码块 / 组合态中途），随手打开一份文档敲不到一半；
##    而"打开哪一份、按什么顺序敲"每次自己拼一遍，就会有人漏项——漏了**看不出来**。
## ⇒ 它打开 `tools/ime-sample.md`（为 0d **手写**的样本，⛔ 不是语料里的 XL 文件），
##    并把六项清单**打在终端上**（人不用一边翻文档一边敲）。
## ⚠️ 它**不做判定**：判据是「有没有可复现的坏形态」，只有人能答
##    （合成按键造不出组合态，`notes/0016` §2.5 末条）。
##    跑完把结论写进 `design/0012` §7 手工验证表的**第 14 行**。
verify-0d:
	@test -f "$(BIN)" || { echo "✗ 先跑 make build-gui"; exit 1; }
	@grep -q "$(GUI_MARKER)" "$(BIN)" 2>/dev/null || { echo "✗ $(BIN) 不含 GUI —— 先跑 make build-gui"; exit 1; }
	@echo "⚠️ 装到 PATH 的那份是不是新的？$(PREFIX)/rmd ——"
	@if [ -x "$(PREFIX)/rmd" ] && cmp -s "$(BIN)" "$(PREFIX)/rmd"; then echo "  ✓ 一致"; \
	 else echo "  ⛔ 不一致或没装：先跑 make build-gui（它收尾会刷新那份）"; fi
	@echo ""
	@echo "── 0d 六项（⛔ 判据是「有没有**可复现的**坏形态」，不是「能不能打」）──"
	@echo "  1. 三段中文（各 20 字以上，正常速度）⇒ 上屏顺序与手一致；⌘S 存下来**逐字等于**你敲的"
	@echo "  2. 组合态中途按 ←/→（候选窗还开着）⇒ 候选窗与光标**不打架**"
	@echo "  3. 组合态中途按 Esc ⇒ 候选窗**干净关掉**、不留半截拼音；之后 ⌘F 还灵"
	@echo "  4. 长句快速连打（不选词，连打 30 字再上屏）⇒ 不丢字、不串行、末几字不跑到前面"
	@echo "  5. 列表 / 标题 / 代码块里**各敲一次** ⇒ 与普通段落行为一致（⚠️ 代码块特别看）"
	@echo "  6. 组合态里按一次 ⌘S ⇒ ⛔ **不许存盘**"
	@echo ""
	@test -f tools/ime-sample.md || { echo "✗ 找不到 tools/ime-sample.md"; exit 1; }
	@cp tools/ime-sample.md "$(IME_RUN)"
	@echo "▶ 打开「$(IME_RUN)」——按 ⌘E 进编辑态（左栏源码、右栏渲染）"
	@echo "  ⚠️ 打开的是**临时副本**（第 1 / 6 项要按 ⌘S，会写盘）——仓库里那份不动。"
	@echo "     想比对：diff tools/ime-sample.md $(IME_RUN)"
	@$(BIN) "$(IME_RUN)"

## 侧边栏（批 3）的冒烟：4 个 XL 文件 + 2 个目录，程序自证"能显示能滚 / 树真建出来了"
##
## ⚠️ 目录那两条不是凑数：`src-tauri/` 下有 `target`，它必须**可见、灰显、点不动**，
##    且从未被扫描（design/0003 §7 步骤 5 的日志判据）。
smoke:
	@test -x $(BIN) || { echo "✗ 先跑 make build-gui（冒烟用 release 二进制）"; exit 1; }
	@bash tools/smoke-gui.sh

## `design/0012` §7 步骤 **0e**：源码保真（7 类样本逐字节比对）。
##
## ⚠️ 它**不是**冒烟的一部分：这条链要 `--features gui`（`commands/edit.rs` 在那个
##    feature 后面），而 `make smoke` 跑的是已经带 GUI 的**二进制**——两者互不替代。
## ⭐ 它**没有**独立的实现：脚本只是"跑那条测试 ＋ 数 7 类样本在不在"，
##    真正的判定在 `commands/edit.rs` 的测试里（⭐ 因为保存只有一个入口，
##    ⛔ 不能为了驱动它造一条 CLI 写盘路径 —— `INV-EDIT-10`）。
fidelity:
	@bash tools/editor-fidelity.sh


## 纯逻辑单测（release Rust + node）。⛔ 不用 debug——那会把断言之外的行为也测成另一套
test:
##   ⚠️ `pipefail` 是**承重的**（2026-10-21 修）：`cargo test … | tail` 的退出码是 `tail` 的
##   ⇒ 不写它时**测试红了也返回 0**，"全绿"只能靠人读输出。同 `test-js` 那条。
	@bash -o pipefail -c 'cd $(SRC) && cargo test --release 2>&1 | tail -20'
	@echo ""
	@$(MAKE) --no-print-directory test-js
	@$(MAKE) --no-print-directory typecheck
	@$(MAKE) --no-print-directory test-install-guard
	@$(MAKE) --no-print-directory test-shell-vars

## ⭐ 花括号守卫：`$VAR` 后面紧跟非 ASCII 字节时**必须**写成 `${VAR}`。
##
## ⚠️ 为什么这条值得常驻：macOS 自带的 **bash 3.2**（`/bin/bash`，CI runner 上就是它）
##    在 UTF-8 locale 下会把那个多字节字符**吃进变量名** ⇒ `set -u` 下报
##    `label�: unbound variable`（变量名是乱码，与源码对不上），没有 `set -u` 时则**静默变空**。
##    本机 `bash` 是 Homebrew 5.x，不复现 ⇒ 这是又一个"本机全绿、CI 红"的环境差。
##    2026-10-23 实测代价：一轮 Actions（`scripts/lint-theme.sh:142`）。
## ⚠️ 判定在 `scripts/check-shell-vars.sh`（C locale 下 awk 按字节比，带 `--self-test` 真值表）。
test-shell-vars:
	@bash scripts/check-shell-vars.sh

## ⭐ `design/0033`：`make install` / `make uninstall` 的**落点守卫**
## （`$(PREFIX)/rmd` 是应用托管的那条符号链接时，两者都不许动它）。
##
## ⚠️ 它**注入 `BIN=` 与 `PREFIX=`**，只在临时目录里动 ⇒ ⛔ 不碰 `~/.local/bin`、
##    不碰构建产物、不需要 GUI 构建。几秒钟跑完，所以挂在 `make test` 里。
test-install-guard:
	@bash tests/install-guard.sh

## JS 单测（`design/0003` §7 的纯逻辑部分：版本比对 / 分片中断 / 深度上限）
##
## ⚠️ 为什么这些不放在 `src/` 下：`src/` 是 Tauri 的 `frontendDist`，
##    **整个目录会在编译期嵌进二进制**——测试文件不该进产物。
test-js:
	@test -n "$(shell command -v node)" || { echo "✗ 没有 node（JS 单测要它）"; exit 1; }
##   ⚠️ `pipefail`：没有它时 `node --test … | tail -12` 的退出码**恒 0**（2026-10-21 修）。
	@bash -o pipefail -c 'node --test tests/js/ 2>&1 | tail -12'

## ⭐ `design/0052` U8：**类型闸门**——只查 `src/live/**` 与 `tests/js/live-*.test.js`。
##
## ⚠️ 为什么要有它：`bugs/0014` 那种「读了一个不存在的字段」（`r.head` 被写成 `r.from`
##    ⇒ `NaN` ⇒ 静默空转）在纯 JS 里**没有任何东西会报错**；而 `SelectionRange` 之类的形状
##    是 CM6 的公开类型 ⇒ `tsc` 一眼就抓住。几秒钟跑完，所以挂在 `make test` 里。
## ⚠️ `include` 只有那两处（`tsconfig.check.json`）——⛔ **不做全仓迁移**（`adr/0005` 不动）：
##    `src/main.js` / `src/services/**` 没有 JSDoc，加进来只会得到一屏噪声，然后被人用 `any` 遮掉。
## ⚠️ 它**只要 node**（`typescript` 是构建侧 devDependency）——用户机器不参与；
##    ⛔ 不用 `npx`（会去网上找）：直接走 `node_modules/.bin/tsc`。
typecheck:
	@test -x node_modules/.bin/tsc || { echo "✗ 没有 node_modules/.bin/tsc —— 先 npm ci（类型检查只要构建侧）"; exit 1; }
	@node_modules/.bin/tsc -p tsconfig.check.json && echo "✓ typecheck：src/live/** 与 tests/js/live-*.test.js 无类型错误"

## 步骤 0：技术风险先行（五步，无需 GUI）
probe:
	@cd $(SRC) && cargo run --release -q -- probe $(ARGS)

## 批次 0：真机 WKWebView 的能力探针（步骤 0 第 6 步）。
## ⚠️ 与 bench 同一条纪律：拒绝覆盖同名结果。要重跑先改名或加 FORCE=1
probe-wkwebview:
	@test -x "$(shell command -v swift)" || { echo "✗ 没有 swift。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/run.sh $${FORCE:+--force}

## 批次 3 步骤 0b：`⌘F` 会不会被 WKWebView 吞掉（`design/0011`）。
## ⚠️ 会开一个前台窗口并**合成真按键**（osascript）——跑的时候别碰键盘；
##    调用进程需要「辅助功能」权限，否则按键静默不送（脚本自带无主键对照，会当场指出是权限问题）。
## ⚠️ 同样拒绝覆盖同名结果。轮数默认 3（布尔判据），加 ROUNDS=1 更快
ROUNDS ?= 3
probe-find-key:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@ROUNDS=$(ROUNDS) bash tools/wkwebview-probe/find-keyprobe.sh $${FORCE:+--force}

## `design/0012` §7 步骤 **0c**：编辑区（CM6 `contenteditable`）聚焦时，
## `⌘,` / `⌘B` / `Ctrl+E` / `Ctrl+A` / `Ctrl+O` / `Esc` **各归谁**。
##
## ⚠️ 它回答的是 §2.3-4 那条**未核实**：「macOS 的 emacs 文本绑定在 WKWebView 的
##    `contenteditable` 上生效吗」——若生效，`Ctrl+E` 会**移动光标**（一个新的用户可见行为）。
## ⭐ **它不碰用户**：`.accessory` 激活策略 ＋ `.borderless` ＋ `alphaValue = 0` ＋ `orderBack`，
##    ⛔ **全程不调 `NSApp.activate`**、⛔ **不用 `osascript` / `System Events`**、⛔ **不要辅助功能授权**，
##    按键走 `NSEvent.keyEvent(...)` → `window.sendEvent(...)` 直接进**自己那个窗口**。
##    ⭐ **一个进程跑完全部键**（⛔ 不按测项起进程）——它第一版是"每键一个前台探针进程"
##    （14 键 = 14 次弹窗 + 14 次抢前台），**被用户叫停**，故重写成现在这条（`design/0012` §10.1）。
## ⚠️⚠️ **改写带来一处结构性盲区**（如实记着）：不可见窗口里 **DOM 选区改动不生效**
##    ⇒ **移光标那一族（⌃A/⌃B/⌃E/⌃F/⌃N/⌃P）离屏测不出来**，只能取 2026-10-16 那份
##    前台变体（`…run1-6键.json`）的数；⭐ **改内容那一族（⌃D/⌃H/⌃K/⌃O）可测**，
##    而那四个正是**会改用户文档**的那四个。探针内置**判别器**（程序性 `selection.collapse()`
##    也不生效）⇒ 下次"移光标测不出来"时**能判是盲区还是键没到**。
## ⚠️ 用**产品那份** CM6 产物（`src/vendor/cm6.bundle.js`）⇒ 先跑 `make cm6`；
##    这是有意的：探针量的必须是**产品那个版本**的 CM6，⛔ 不是探针自己另打一份。
## ⚠️ 同样拒绝覆盖同名结果。只测某几个键：`KEYS="ctrl-e escape" make probe-editor-key`
probe-editor-key:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@KEYS="$(KEYS)" bash tools/wkwebview-probe/editor-keyprobe.sh $${FORCE:+--force}

## V2 调研：用 CodeMirror 6 打开大 Markdown 的冷启动分段（`research/notes/0016` §2.5）。
## ⚠️ 取证探针，⛔ 不碰 src/、不进任何构建产物——`adr/0006`/`adr/0005` 都没被它改动。
## ⚠️ 首次运行要 npm install（拉 6 个 @codemirror/@lezer + esbuild），约 10 秒。
## ⚠️ 同样拒绝覆盖同名结果。轮数默认 3，加 REPEAT=1 更快
REPEAT ?= 3
probe-cm6:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@REPEAT=$(REPEAT) bash tools/wkwebview-probe/cm6-probe.sh $${FORCE:+--force}

## design/0012 §7 步骤 0f：键入延迟 / 连续输入期间的预览调度 / 滚动位置变化。
##
## ⛔ **不打扰用户**：全程一个**不可见**窗口（alphaValue=0 + orderBack + .accessory），
##    进程内 NSEvent 注入。不开可见窗口、不抢前台、不用 osascript / System Events、
##    不要辅助功能授权、不合成系统按键（见根 CLAUDE.md 工作约定 4）。
##
## ⚠️ 计时边界（如实登记，⛔ 别把这些数当"完整输入延迟"）：
##    · M1 是**页面侧**的 keydown → 绘制，**不含** HID → WindowServer → AppKit 那一段
##    · M2 的**后端是模拟的**（Σ 由已实测的分项拼出，Tauri IPC 在探针里没有），
##      但**主线程那一段用忙等真占** ⇒ "打字被重渲卡住多久"是真测出来的
##    · M3 量的是**浏览器事实**，⛔ 不是把产品规则再实现一遍
##
## ⚠️ 同样拒绝覆盖同名结果。只测某几个：`ONLY="T-B-resume" make probe-editor-latency`
## ⚠️ 跑之前先 `make cm6`（要产品那份 src/vendor/cm6.bundle.js）
probe-editor-latency:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@ONLY="$(ONLY)" M1="$(M1)" bash tools/wkwebview-probe/editor-latency-probe.sh $${FORCE:+--force}

## design/0012 §11.6/§11.7：左右滚动同步的**接线**那半（真 DOM + 真 CM6）。
##
## ⛔ **不打扰用户**：一个**不可见**窗口（alphaValue=0 + .borderless + .accessory），
##    页面只改自己那两个滚动容器。不开可见窗口、不抢前台、不用 osascript / System Events、
##    不要辅助功能授权、不合成任何按键（见根 CLAUDE.md 工作约定 4）。
##
## ⭐ 判据（17 条）**进退出码**：0 全过 / 1 有失败 / 2 有"环境不成立"的跳过 / 3 跑不起来。
## ⚠️ 跑的是**产品那两份**（src/services/sync.js ＋ src/vendor/cm6.bundle.js），
##    ⛔ 探针不抄第二份实现。⇒ 先跑 `make cm6`。
## ⚠️ 默认**不落盘**（这是个闸门，改一次 sync.js 就该跑一次）；
##    要存证据：`ARGS="--save"`（仍拒绝覆盖同名结果，除非 ARGS="--save --force"）。
##    纯逻辑那半的断言在 `make test-js`（tests/js/sync.test.js）。
probe-scroll-sync:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/scroll-sync-probe.sh $(ARGS)

## ⭐ 2026-10-16：编辑分栏**外壳**的离屏闸门（滚动条 / 焦点态 / 分界线）
##
## 起因：用户「滚动条和分割线，搞得小一点，干扰视线」。改的全是**纯 CSS + 伪元素**——
##   `make test-js` 够不着，浏览器也不会为它们报任何错 ⇒ 把"看得见的那条线多宽、什么色"
##   变成可断言的数（**26 条判据**：14 外壳 ＋ 3 光标色 ＋ ⭐ 6 提示条不占位
##   ＋ ⭐ 3 顶栏 Vim 快速开关〔`design/0014` §10.5，2026-10-20〕）。
##   ⭐ 其中"滚动条**占了 12px 布局**"是
##   `::-webkit-scrollbar` 真的生效的**唯一**可自动判据（伪元素的 getComputedStyle 拿不到）；
##   ⭐ 而那 6 条（`docs/bugs/0006` 根因①）量的是**两栏「有效视口」的矩形**——
##   ⚠️ 口径 2026-10-16 按 `design/0014` §7.3 裁定 (c) **原地改过**：
##   原写"显/隐一次两栏**高度差 = 0**"，现改为"**显/隐不动两栏有效视口** ＋ **提示条不与正文相交**"——
##   理由是"差为 0"是手段，且它**结构上抓不到"浮层盖住正文"**（覆盖不改矩形）。
##   ⛔ 老的没留、新的没并存（换口径，不是加一条）。
## ⛔ **不打扰用户**：不可见窗口（alphaValue=0），`orderBack` ＋ `makeKey` 但
##    **永不 `NSApp.activate`** ⇒ 前台应用与键盘焦点都还在用户那边（同 `probe-scroll-sync`）。
## ⚠️ 先跑 `make cm6`（页面挂的是产品那一个 bundle）。
## 用法：`make probe-edit-chrome`（浅色）；`ARGS="--theme dark"` 换主题；
##       `ARGS="--png /tmp/x.png"` 另存一张快照（⚠️ 快照只是给人看的，判据不依赖它）。
probe-edit-chrome:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/edit-chrome-probe.sh $(ARGS)

## ⭐ 2026-10-16：编辑态 **Vim 键位**的离屏闸门（`docs/design/0014` §7 步骤 0）
##
## 步骤 0 要求"**先跑完，再动手**"（⛔ 一条未过就别开工）。本目标把其中**能自动化的**五步
##   压成一条命令：**0b**（`vim()` 真带进来哪 4 件 ＋ 谁先拿到 keydown）、
##   **0c**（15 条 SHORTCUTS ＋ ⌘C/V/X/A/Z ＋ ⌃O/K/D/H ＋ ⌥x ＋ `hjkl/dd/u/:` ＋ `:q`/`:wq`/`:w`）、
##   **0d-①**（组合态的形状）、**0e**（块光标 × 四 面 × 三套主题 = 12 格 ＋ 规则原文 ＋ 反向对照）、
##   **0f**（上游"未实现"项登记）。
## ⚠️ **0d-②（真人敲中文 IME）与手感那半⛔ 不在本目标里** —— 它只能人做（`make verify-0d` 同族）。
##   ⭐ 那道闸门 2026-10-16 已由用户真人验收闭合；⛔ 但"探针够不到它"这条**边界照旧**。
## ⛔ **不打扰用户**：不可见窗口（alphaValue=0）＋ `orderBack`/`makeKey`，**永不 `NSApp.activate`**；
##   页面里是 `dispatchEvent` 的**页内合成事件**（⛔ 不是合成系统按键，到不了别的进程）。
## ⚠️⚠️ **判据能答什么**：`dispatchEvent` 造的是**不可信事件**，WebKit ⛔ 不会为它执行
##   默认编辑行为 ⇒ 本探针答"**页内谁处理了这个键**"，⛔ **答不了**"WebKit 会改什么"
##   （那半的真按键证据在 design/0012 §2.3-4 ＋ benchmarks/results/editor-key-2026-10-16-Mac14,9.json）。
## ⚠️ 跑的是**产品那几份**（bundle ＋ `services/keymap.js` ＋ `editor/keys.js` ＋ 三张真样式表），
##   键位表由脚本从 `gui/mod.rs` 的 `SHORTCUTS` **现读** ⇒ ⛔ 探针不抄第二份。
##    ⇒ **先跑 `make cm6`**（`src/vendor/cm6.bundle.js` 是产物）。
## ⚠️ 默认**不落盘**（这是个闸门）；要存证据：`ARGS="--save"`。
## 用法：`make probe-vim-keys`；`make probe-vim-keys ARGS="--json"` 只打原始 JSON。
probe-vim-keys:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/vim-keys-probe.sh $(ARGS)

## ⭐ 2026-10-19：**阅读进度恢复**的离屏闸门（`design/0017` §7.4，**12 条判据**）
##
## 判据 1–11 在页面里（真 DOM ＋ 真 `decode()` ＋ 真两帧 rAF），判据 12 在 `.swift` 侧
##   （起跑前后比一次 `frontmostApplication`）—— 一起进**退出码**。
## ⚠️ 跑的是**产品那三份**：`services/progress.js`（全部判定）＋ `services/reload.js`
##   （锚点解析）＋ `components/ImageView.js`（`onSettled` 的落定语义）⇒ ⛔ 探针不抄第二份。
##   唯一镜像的是 `main.js` 那层接线（根脚本进不了探针页），镜像范围写在 harness 头部。
## ⚠️ 夹具是 `canvas` 现生成的 `data:` PNG（⛔ 不读真实资产）——要的正是
##   "IPC 已回来但 `naturalHeight` 还是 0" 那个形态（判据 3）。
## ⚠️ 离屏、不弹窗、不抢前台、不合成系统按键（同 `probe-scroll-sync` 那一族）。
## ⚠️ 默认**不落盘**（改一次 `progress.js` / `ImageView.js` 的 `onSettled` 就跑一次）；
##   存证据 `ARGS="--save"`（仍拒绝覆盖同名结果，除非 `--force`）。
## 用法：`make probe-reading-progress`；`ARGS="--json"` 只打原始 JSON。
probe-reading-progress:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/reading-progress-probe.sh $(ARGS)

## ⭐ 2026-10-20：**图片缩放预览**的离屏闸门（`design/0018` §7.4，**25 条判据**）
##
## 跑的是**产品那几份**：`services/imagezoom.js`（缩放数学）＋ `services/keymap.js`
##   （⭐ **真实分发器**，评审 R1 点名 ⛔ 不用 stub）＋ `components/Settings.js`
##   （⭐ **真实覆盖层登记处**）＋ `components/ImageViewer.js` ＋ 四张样式表
##   ⇒ ⛔ 探针不抄第二份实现，也不抄夹具（夹具全在 harness 里现造）。
## ⚠️ **五个阶段**：Swift 侧在阶段之间改**视图 frame**（⛔ 不改产品 CSS）——
##   放大／缩小／缩到 64×52／回到原尺寸，用来验 `design/0018` §7.4 第 20/21 条
##   （resize 后手动比例⛔ 不被新的 fit 顶走）。
## ⚠️ **它证明不了什么**（§7.4 末段）：`dispatchEvent` 是不可信事件，浏览器不为它执行默认动作
##   ⇒ 第 12/14/17/22 条证明的是"该 preventDefault 的地方调了"，⛔ 不是"WebKit 真的照着做"；
##   真实默认行为与手感归 §7.5 的人工项。
## ⚠️ 离屏、不弹窗、不抢前台、不合成系统按键（同 `probe-scroll-sync` 那一族）。
## ⚠️ 默认**不落盘**（改一次 `imagezoom.js` / `ImageViewer.js` / `image-viewer.css` 就跑一次）；
##   存证据 `ARGS="--save"`（仍拒绝覆盖同名结果，除非 `--force`）。
## 用法：`make probe-image-viewer`；`ARGS="--json"` 只打原始 JSON。
probe-image-viewer:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/image-viewer-probe.sh $(ARGS)

## ⭐ 2026-10-21：**目录会话恢复**的离屏闸门（`design/0020` §7.4，**7 条判据 ＋ 2 条变异 ＋ E**）
##
## 判据 46–52 在页面里（真 DOM ＋ 真树），判据 E（前台没被抢）在 `.swift` 侧
##   （起跑前后比一次 `frontmostApplication`）—— 一起进**退出码**。
## ⚠️ 跑的是**产品那几份**：`services/dirsession.js`（全部判定）＋ `components/FileTree.js`
##   （`restoreExpanded` 与两个通知出口）＋ `services/{tauri,versions,chunked,search,session}.js`
##   （树读一层、开一份文档都走真提交判据）⇒ ⛔ 探针不抄第二份。
##   唯一镜像的是 `main.js` 那层接线（根脚本进不了探针页），镜像范围写在 harness 头部。
## ⭐ 判据 53/54 是**变异测试**，打在**页面副本**上（⛔ 不碰仓库文件）：
##   53 去掉 `restoreExpanded` 的 `restoring` 抑制 ⇒ 判据 48 必须红；
##   54 让 `shouldContinue` 短路恒真           ⇒ 判据 51 必须红。
##   ⚠️ 施加前校验命中**恰好 1 次**并 `cksum` 前后比对——"没红"必须先排除"没改到"。
## ⚠️ 离屏、不弹窗、不抢前台、不合成系统按键（同 `probe-scroll-sync` 那一族）。
## ⚠️ 判据 52 的耗时**不含真实 IPC 延迟**（假 IPC 同步 resolve）⇒ 它是**下界**。
## ⚠️ 默认**不落盘**（改一次 `dirsession.js` / `FileTree.js` 就跑一次）；
##   存证据 `ARGS="--save"`（仍拒绝覆盖同名结果，除非 `--force`）；
##   只想跑基线：`ARGS="--no-mutate"`（那两条会记成**跳过**，⛔ 不是通过）。
## 用法：`make probe-dir-session`；`ARGS="--json"` 只打原始 JSON。
probe-dir-session:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/dir-session-probe.sh $(ARGS)

## ⭐ 文件树右键菜单的离屏闸门（`design/0034` §8 第 5 条欠的那份；
##   `design/0035` §3.8 的 A4 / B8–B13 挂在这里）——**A1–A10 ＋ B1–B10 ＋ E ＋ M1/M2/M3**
##
## 判据落在三件事上：① **菜单里到底有没有那一项**（复制绝对路径 / 重命名，文件行 vs 目录行
##   vs 灰显行 vs 空白处 vs 没有根）；② **点下去真的做了什么**（逐字节路径、写入完成才报成功、
##   三类失败各说各的、Enter/Esc/组合态/连按、失败保留输入、编辑态置灰）；
##   ③ **换根之后迟到的回包不碰新树**（`A1` 的空白守卫 ＋ `B10` 的陈旧丢弃）。
## ⚠️⚠️ **剪贴板是记账桩子**：`CLIP.defaultCopier()` 被 harness 换掉，⛔ 真剪贴板一次都不碰
##   ⇒ 「真实写入能否成功」仍只能人工验收（`design/0035` §7 H1）。
## ⚠️ 跑的是**产品那几份**：`services/{treerefresh,clipboard}.js` ＋ `components/FileTree.js`
##   ＋ `services/{i18n,tauri,session,versions,chunked,search,dirsession}.js` ⇒ ⛔ 探针不抄第二份。
## ⚠️ `main.js` 不进探针页；本探针**不镜像**它，只驱动 FileTree 的公开行为。
## ⭐ 变异 M1/M2/M3 打在**页面副本**上（⛔ 不碰仓库文件）：
##   M1 删 `copyTarget` 的 `!hit` 守卫 ⇒ A1 必须红；
##   M2 重命名项的 `disabled` 恒假     ⇒ B8 必须红；
##   M3 `selectStem` 按第一个点切       ⇒ B2 必须红。
##   ⚠️ 施加前校验命中**恰好 1 次**并 `cksum` 前后比对——"没红"必须先排除"没改到"。
## ⚠️ 离屏 `.prohibited`、alpha=0、orderBack ⇒ 不弹窗、不抢前台、不合成按键（判据 E 自证）。
## ⚠️ 默认**不落盘**（改一次 `FileTree.js` / `treerefresh.js` / `clipboard.js` 就跑一次）；
##   存证据 `ARGS="--save"`（仍拒绝覆盖同名结果，除非 `--force`）；
##   只想跑基线：`ARGS="--no-mutate"`（三条会记成**跳过**，⛔ 不是通过）。
## 用法：`make probe-tree-menu`；`ARGS="--json"` 只打原始 JSON。
probe-tree-menu:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/tree-menu-probe.sh $(ARGS)

## ⭐ `design/0044`（根头）＋ `design/0043`（启动页收藏段）的离屏闸门
##   ——**1–11 ＋ B1–B9 ＋ M1–M5**（20 条判据 ＋ 5 条变异）。
##
## 要答两件事：① 根头与树是不是**两个 host**——`showRoot` / `refreshVisible` 的
##   `host.textContent = ''` 之后根头必须还在，新建输入行必须落在 `#tree-host` 内部、
##   排在根头**后面**；空态 / 未授权 / 根层读失败时根头**隐藏但不删除**；
##   换根、树↔列表切换、`⋯` 与右键同一份菜单、`Shift+F10`/`Enter`/`Escape` 的焦点回位；
##   ② 启动页两段：数字只在最近表（`INV-FAV-05`）、收藏行回传**后端原串**、
##   菜单三项与首末置灰、`↑↓` 跨两段连续、失效行仍可管理、重画时菜单先关。
## ⚠️ 跑的是**产品那几份**：`components/{FileTree,Sidebar,StartScreen}.js`
##   ＋ `services/{i18n,versions,chunked,dirsession,tauri,search,keymap,session,start,
##   treerefresh,clipboard}.js` ⇒ ⛔ 探针不抄第二份实现。
## ⚠️ `main.js` 不进探针页；本探针**不镜像**它，只照它的调用顺序驱动公开行为。
## ⭐ 变异 M1–M5 打在**页面副本**上（⛔ 不碰仓库文件）：
##   M1 空态不隐藏根头 ⇒ 5 红；M2 根层新建插到 host 外面 ⇒ 3 红；
##   M3 顶层深度 0→1 ⇒ 10 红；M4 收藏行也编数字 ⇒ B1 红；M5 根头右键不开菜单 ⇒ 8 红。
##   ⚠️ 施加前校验命中**恰好 1 次**并 `cksum` 前后比对——"没红"必须先排除"没改到"。
## ⚠️ 离屏 `.prohibited`、alpha=0、orderBack ⇒ 不弹窗、不抢前台、不合成按键。
## ⚠️ 观感（根头留白/字重、菜单阴影）与手感只能人工验收。
## ⚠️ 默认**不落盘**；存证据 `ARGS="--save"`（拒绝覆盖同名结果，除非 `--force`）；
##   只想跑基线：`ARGS="--no-mutate"`（五条变异会记成**跳过**，⛔ 不是通过）。
## 用法：`make probe-favorites-rootheader`；`ARGS="--json"` 只打原始 JSON。
probe-favorites-rootheader:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/favorites-rootheader-probe.sh $(ARGS)

## ⭐ 2026-10-21：**中英文界面**的离屏闸门（`design/0025` §7.2，**9 条判据 ＋ 4 条变异 ＋ E**）
##
## 判据 0/3/4/5/6 在页面里（真 DOM ＋ 真字典），判据 1/2/7 量**真布局**（横向溢出），
##   判据 8 量覆盖层语言行；判据 E（前台没被抢）在 `.swift` 侧
##   （起跑前后比一次 `frontmostApplication`）—— 一起进**退出码**。
## ⚠️ 加载的是**真 `src/index.html`**：整棵 `src/` 拷进页面目录（保住 `styles/**` 的相对路径
##   ⇒ 量的是真样式），然后**行级**剥掉除 `services/i18n.js` 外的全部 `<script>`
##   （⚠️ 必须整行匹配：`index.html` 里有一行**注释**含 `<script src>`），
##   剥完当场断言「留下 1 条 ∧ 剥掉 > 0 条」，两个数都印出来。
## ⚠️⚠️ 与 §7.2 字面的一处不同（登记在其 §10）：设置覆盖层**不在** `index.html` 里，
##   它是 `components/Settings.js` 运行时建的 ⇒ 探针**注入并加载产品那份**，
##   ⛔ 不手抄覆盖层标记（那会造出第二份真值）。
## ⚠️ 判据 1/2 要量的东西静态上**一半是 `hidden`**（保存按钮 / 失败提示 / 重载条 / 预览条 /
##   决策条）⇒ 页面侧**强制打开**，否则"英文 ＋ 保存 ＋ 失败提示同时可见"那个最坏宽度量不到。
## ⭐ 判据 9–12 是**变异测试**，打在**页面副本**上（⛔ 不碰仓库文件）：
##   9 删 en 字典的 `toolbar.theme` ⇒ 判据 4 必须红；10 删 `setAttribute('lang', …)` ⇒ 判据 6；
##   11 让 `applyDom` 的 ATTRS 循环空转 ⇒ 判据 5；
##   12 把 `Settings.js` 的 `el(…, '')` 空字典键放回去 ⇒ 判据 3
##      （⭐ 它正是本探针第一次跑抓到的**真缺陷**，在产品代码里已修）。
##   ⚠️ 施加前校验命中**恰好 1 次**并 `cksum` 前后比对——"没红"必须先排除"没改到"。
## ⚠️ 离屏（`.prohibited` ＋ `alphaValue = 0` ＋ `orderBack`）、不弹窗、不抢前台、不合成按键。
## ⚠️ 默认**不落盘**（改一次 `services/i18n.js` / `index.html` / `styles/**` 就跑一次）；
##   存证据 `ARGS="--save"`（仍拒绝覆盖同名结果，除非 `--force`）；
##   只想跑基线：`ARGS="--no-mutate"`（那四条会记成**跳过**，⛔ 不是通过）。
## ⚠️ 它**答不了**：英文读起来别扭不别扭、断行位置好不好看 —— 那是 §7.3 的人工项。
## 用法：`make probe-i18n`；`ARGS="--json"` 只打原始 JSON。
probe-i18n:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/i18n-probe.sh $(ARGS)

## ⭐ 「文档列表」的**离屏接线闸门**（`design/0041` §7，判据 A–D ＋ E）
##
## 要答的两件事：
## ① 成本：四档行数（500 / **1276**（实测的 `.md` 总数）/ 2000 / 5000）从 `refresh()`
##    到「首批 DOM＋布局完成」与「全部完成」各多久 ⇒ `MAX_RENDER` 与 `CHUNK_FIRST/STEP` 的数字依据。
## ② 正确性（评审给的三条反例，落到真 DOM 上）：
##    A 1 276 行一行不少；B 超 `MAX_RENDER` 停在 5000 且**常驻一句说明**；
##    C 点一行回传的是那一行的 `real_path`；⭐ D **刷新在途时旧分片回滚为 0 行**。
## ⭐ 2026-10-24 起**它算覆盖面**（`.claude/rules/tests.md` 的四层划分）：跑的是**产品那几份**
##   （`services/{i18n,versions,chunked,doclists,session}.js` ＋ `components/DocList.js`）
##   ＋ **产品那四张样式表** ⇒ 行结构、行高、分片调度与 CSS 都不再是拟定的。
##   ⚠️ 第一轮（`DocList.js` 还不存在时）的数是**拟定形状**下的，已作废留痕在
##   `docs/research/notes/0032` §4.1，证据另存 `benchmarks/results/doclist-render-shape-only-*.json`。
## ⚠️ 假后端（`invoke` 由 harness 装）⇒ 数字**不含真 IPC 与上屏**。
## ⚠️ 离屏 `.prohibited` ＋ `alphaValue=0` ＋ `orderBack`；不弹窗、不抢前台、不合成按键；
##   判据 E（前台没被抢）每次自证，进**退出码**（与 A–D 同级）。
## ⚠️ ⛔ **不给内存数字**（WKWebView 无可靠 JS 堆读数）——⛔ 不许拿它论证内存。
## 用法：`make probe-doclist`；`ARGS="--json"` 只打原始 JSON；`ARGS="--save"` 留证据（拒覆盖）。
probe-doclist:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/doclist-probe.sh $(ARGS)

## `design/0042` §7：**侧边栏底部常驻文件名搜索**的离屏接线闸门（判据 A–I ＋ **E**）。
##
## 要答的事：这个搜索框与 `⌘P` **逐条同源**（`design/0042` §2.1）——同一份 Rust 匹配、
## 同一套 `req`/代次竞态判据、同一条"第一次输入重建索引"的时机。
## 而纯逻辑单测（`tests/js/sidebarsearch.test.js`）里没有 DOM、没有 `session.searchFiles`、
## 也没有"两个异步回包先后到达"⇒ 那几条只能在这里验。
##
## A 初始态（目录未就绪不出现 / 就绪后出现且树仍可见）｜A2 大纲页收起
## B 中文查询（结果层盖住树、高亮正好是那两个字、说明行有条数）
## C 重建时机（进入搜索 rebuild=true / 继续敲 false）
## D 清空后树回来**且没被卸载**｜F 竞态（先发的回包后到不得覆盖）
## G 点行回传 `real_path` 并退出搜索｜H 刷新键从后端表里认 / 空模式只重建
## ⭐ 跑的是**产品那几份**（`services/{i18n,versions,chunked,doclists,search,sidebarsearch,
##   dirsession,tauri,session,keymap}.js` ＋ `components/{Sidebar,SidebarSearch}.js`）
##   ＋ **产品那四张样式表** ⇒ 算覆盖面（四层划分的第三层）。
## ⚠️ 假后端 ⇒ 不含真 IPC 与真读盘；本探针验**接线与竞态**，⛔ 不给性能数字。
## ⚠️ 离屏 `.prohibited` ＋ `alphaValue=0` ＋ `orderBack`；判据 E 每次自证。
## 用法：`make probe-sidebar-search`；`ARGS="--json"` 只打原始 JSON；`ARGS="--save"` 留证据（拒覆盖）。
probe-sidebar-search:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/sidebar-search-probe.sh $(ARGS)

## `design/0041` §7 步骤 0 第二项：**产品** `build_index` 的耗时与载荷字节（无 GUI）。
## ⚠️ 它**不启动窗口**、⛔ 不抢焦点、⛔ 不合成按键——就是一个只读的 `cargo test --ignored`。
## ⚠️ 默认扫仓库上一级（kumustone 工作区），`DIR=/path` 换目标；⛔ 不建不删不写。
## ⚠️ `scan_ms` 是**函数内**统计（含每层 `check_readable`）；墙钟还含夹具与序列化。
## ⛔ 它不是 `⌘P` 的端到端耗时（不含 IPC / 渲染）——那一半在 `make probe-doclist`。
## 用法：`make probe-index`；`make probe-index DIR=/some/dir`。
probe-index:
	@cd src-tauri && RMD_INDEX_PROBE_DIR="$(or $(DIR),$(abspath ..))" \
		cargo test --release --offline -- --ignored --nocapture 索引探针

## ⭐ `design/0047` §7.1 步骤 0 的**可运行证据**（0a 全跑 / 0b·0e·0f·0g 各自跑到哪见其 §7.1.1）。
##
## 四件事，**都不接入产品默认路径**（`src/`、`src-tauri/` 一个字节不动）：
##   ① 0a 块表覆盖率与**往返稳定性**：每个顶层块切出 [start_line, end_line] 重新 parse，
##      必须仍是同一 kind 且首尾正好盖住切片；另报**未知块间行**（疑似整行正文丢块）。
##   ② 0b blocks 载荷：朴素 JSON 与紧凑形状各占源码多少（⚠️ 只有 Rust 侧，⛔ 不含 IPC 与上屏）。
##   ③ 0e 信封：7 类样本的 `restore(normalize(raw))` 是否逐字节回原。
##   ④ 0f 静态半：五类 10 MB **单一**顶层块的行跨度/字节/往返 —— 为 `LIVE_MAX_LINES` 取数。
##   ⑤ 0g 的**纯逻辑半**：`tools/live-probe/js/` 的 node 测试 ＋ 变异自测。
##
## ⚠️⚠️ 它是**独立 crate**（`tools/live-probe/Cargo.toml`），⛔ 不进 src-tauri 的 workspace，
##   `CARGO_TARGET_DIR` 指到临时目录 ⇒ **⛔ 不会覆盖 `src-tauri/target/release/rmd`**
##   （那条坑见 `.claude/rules/build-and-run.md`「`make install` 为什么非查标记不可」）。
## ⚠️ 探针**按 `#[path]` 直接编译产品源码**（`document/{envelope,offset,parser}.rs`、`link.rs`）
##   ⇒ 探针与产品一旦分叉就编译不过，⛔ 不是第二份实现。
## ⚠️ 0a 的语料要先 `make corpus`（`benchmarks/corpus/` 是可再生的）。
## ⛔ 输入延迟 p50/p95、可见首帧、真实 IME / VoiceOver **这里都答不了**（其 §7.3）。
## 用法：`make probe-live-step0`；只跑其中一段 `ARGS=--fixtures` / `ARGS=--giant` / `ARGS=--envelope`。
probe-live-step0:
	@cd tools/live-probe && CARGO_TARGET_DIR="$${TMPDIR:-/tmp}/live-probe-target" \
		cargo build --release --offline --quiet
	@BIN="$${TMPDIR:-/tmp}/live-probe-target/release/live-probe"; \
		case "$(ARGS)" in \
			--fixtures|--giant|--envelope) "$$BIN" $(ARGS);; \
			*) "$$BIN" $(CORPUS)/*.md && "$$BIN" --fixtures && "$$BIN" --giant;; \
		esac
	@cd tools/live-probe/js && node --test --test-reporter=tap ./*.test.js | grep -E '^# (pass|fail)'

## ⭐ `design/0047` §7.2 **第 7 条**：`0e` 的 7 类信封 × 内容形态，**逐字符**。
##
##   两半：
##   ① **Rust 半**（`live-probe --commit-json`）出夹具：7 类信封各自的
##      **归一化全文**（恒 LF、无 BOM）＋ AST `sourcepos` 的块行区间；
##   ② **JS 半**（`tools/live-probe/js/commitFidelity.test.js`）拿真实样本压
##      **产品那两份**（`src/live/model.js` / `blocks.js`）：任意行区间自替换必须
##      逐字符不变、每块改一个字前后缀不动、撤销回原文、`fromPayload` 解包折算式正确。
## ⚠️ 归一化 ⛔ **不在 JS 里重做一遍**——那是第二份实现（`INV-SINGLE-01`）。
## ⚠️ 与 `make fidelity` **不重叠**：那条验 Rust 侧**写盘**（`commands/edit.rs`），
##   这条验 JS 侧**提交**（`src/live/**`）。两条都要跑。
## ⚠️ 独立 crate ⇒ `CARGO_TARGET_DIR` 在 `$TMPDIR`，⛔ 不覆盖 `src-tauri/target/release/rmd`。
## ⚠️ 判据条数进退出码：`pass ≥ 3 ∧ fail ＝ 0 ∧ skipped ＝ 0`
##   （⭐ `skipped ≠ 0` 只可能是夹具没喂进去 —— ⛔ 别把"看空"当成绿）。
probe-live-commit:
	@cd tools/live-probe && CARGO_TARGET_DIR="$${TMPDIR:-/tmp}/live-probe-target" \
		cargo build --release --offline --quiet
	@TMP="$${TMPDIR:-/tmp}"; \
		"$$TMP/live-probe-target/release/live-probe" --commit-json > "$$TMP/live-probe-commit.json" || exit 1; \
		echo "▶ 夹具：$$TMP/live-probe-commit.json（$$(wc -c < "$$TMP/live-probe-commit.json" | tr -d ' ') 字节）"; \
		cd tools/live-probe/js || exit 1; \
		RMD_COMMIT_JSON="$$TMP/live-probe-commit.json" \
			node --test --test-reporter=tap ./commitFidelity.test.js > "$$TMP/live-probe-commit.tap" 2>&1; \
		ST=$$?; \
		set -- $$(awk '/^# pass /{p=$$3} /^# fail /{f=$$3} /^# skipped /{s=$$3} END{print p+0, f+0, s+0}' "$$TMP/live-probe-commit.tap"); \
		if [ "$$ST" -ne 0 ] || [ "$$1" -lt 3 ] || [ "$$2" -ne 0 ] || [ "$$3" -ne 0 ]; then \
			cat "$$TMP/live-probe-commit.tap"; \
			echo "⛔ probe-live-commit 未通过：pass=$$1 fail=$$2 skipped=$$3" >&2; \
			exit 1; \
		fi; \
		echo "✅ 逐字符提交保真：pass=$$1 fail=$$2 skipped=$$3"

## ⭐ `design/0052` **U9**：**Lezer ↔ comrak 的方言差分表**。
##
##   读态 HTML 是 Rust 侧 comrak 渲染的，编辑态的标记是前端 `@lezer/markdown` 算的。
##   两个方言实现对"该藏哪些标记"不保证一致 ⇒ **某个标记永远不消失 / 永远消失**，
##   而且两边都不报错。这条只比一件事：同一行同一位置**该不该藏**。
##
##   两半：
##   ① **Rust 半**（`live-probe --markup-json`）出语料 ＋ comrak 侧该藏的区间（绝对字节偏移）；
##   ② **JS 半**（`tools/live-probe/js/markupDiff.test.js`）拿**产品那份**
##      `src/live/decorations.js::markers()` ＋ 同一份文本的 Lezer 树算另一侧，逐位置比。
##
## ⛔⚠️ **差异不判红**（`design/0052` §3 U9 原文）：两个解析器的方言差异是**外部事实**，
##   不是本仓的 bug。产物是**一份表**——`$TMPDIR/live-probe-markup.md`（落成
##   `docs/research/notes/` 的数据表 ＋ 一条 `docs/kb/`）。判红只会逼人把表调成恒绿。
## ⭐ 进退出码的只有**自检**：语料真被处理（`pass ≥ 3`）／`fail = 0`（差分器自测：把一侧
##   清空必须看得见差异）／`skipped = 0`（⛔ 夹具没喂进去不许当绿）。
## ⚠️ 与 `probe-live-block` **不重叠**：那条验"接线与几何"，这条验"两个解析器的口径差"。
## ⚠️ 独立 crate ⇒ `CARGO_TARGET_DIR` 在 `$TMPDIR`，⛔ 不覆盖 `src-tauri/target/release/rmd`。
probe-live-markup:
	@cd tools/live-probe && CARGO_TARGET_DIR="$${TMPDIR:-/tmp}/live-probe-target" \
		cargo build --release --offline --quiet
	@TMP="$${TMPDIR:-/tmp}"; \
		"$$TMP/live-probe-target/release/live-probe" --markup-json tools/live-probe/fixtures/markup/*.md > "$$TMP/live-probe-markup.json" || exit 1; \
		echo "▶ 语料：tools/live-probe/fixtures/markup/*.md（$$(wc -c < "$$TMP/live-probe-markup.json" | tr -d ' ') 字节 JSON）"; \
		cd tools/live-probe/js || exit 1; \
		RMD_MARKUP_JSON="$$TMP/live-probe-markup.json" RMD_MARKUP_TABLE="$$TMP/live-probe-markup.md" \
			node --test --test-reporter=tap ./markupDiff.test.js > "$$TMP/live-probe-markup.tap" 2>&1; \
		ST=$$?; \
		set -- $$(awk '/^# pass /{p=$$3} /^# fail /{f=$$3} /^# skipped /{s=$$3} END{print p+0, f+0, s+0}' "$$TMP/live-probe-markup.tap"); \
		if [ "$$ST" -ne 0 ] || [ "$$1" -lt 3 ] || [ "$$2" -ne 0 ] || [ "$$3" -ne 0 ]; then \
			cat "$$TMP/live-probe-markup.tap"; \
			echo "⛔ probe-live-markup 未通过：pass=$$1 fail=$$2 skipped=$$3" >&2; \
			exit 1; \
		fi; \
		echo "✅ 方言差分表：pass=$$1 fail=$$2 skipped=$$3"; \
		echo "   表：$$TMP/live-probe-markup.md"

## ⭐ 2026-10-26：**唯一全文模型 ＋ 单块编辑视图**在真 WKWebView 里的接线与几何
##   （`design/0047` §7.2 **第 6 条** ＋ §7.1 **步骤 0d / 0f / 0h**，**484 条判据 ＋ 五次变异**）
##
## ⚠️⚠️ 它跑的是**真应用**：`src/index.html` ＋ **全部** `src/**`（含 `main.js` 与 `src/live/**`），
##   只把后端换成 `fake-tauri.js`（回 Stage A 用**真 comrak** 导出的载荷）⇒ 驱到的是真
##   `onLiveDocDown` / `makeLiveView` / `swapLiveView`，⛔ 探针不重写那三份。
##   判据分七段：A 启动（页面起来 / 夹具对齐 / 假后端只被问该问的）｜B 逐块（**每一个块**都要
##   进得去又退得出：高度（border box）不矮、变高在上界内、**非活动行的标记真的藏掉**（逐字比对
##   `markers()` 的期望）、**块外零位移**）｜⭐ D F6 打入（组合期文档一字节不动 / 上屏 / ⌘Z 逐字回原文
##   ＋ **D12–D16 删除五连**：敲字落进文档 / `⌫` 删回原样 / `⌦` 前向 / `⌘A ＋ ⌫` 清空 / `⌘Z` 收回原文
##   ——⭐ 2026-10-27 补的，此前这一段**一条删除判据都没有**，`bugs/0014` 就是从那里漏出去的）｜
##   G 长代码行（0d，只在真有超宽 `<pre>` 的夹具上跑）｜H 纵向链路（0h：进入→敲字→⌘S→合回→重渲）｜
##   L 输入延迟（0f：`fixtures/bigblock.md` 的 202/802/2000 行块各敲 125 字符，判据 p95 ≤ 16 ms）｜E 退出。
##   ⚠️ G/L 都是"没有合适夹具就既不记通过也不记跳过" ⇒ 由 shell 端 `G-覆盖` / `L-覆盖` 把关。
## ⚠️ **边界**：假后端不渲染 Markdown ⇒ B/D/E 只在"正文没真正改动"的路径上跑，H 只判**调用了谁与载荷字节**；
##   改字后整篇重渲**出来的 HTML** 归 `make probe-live-commit` / `make fidelity` / 人工。
## ⚠️⚠️ H 段的 `⌘S` 走 `main.js::onKeyDown` ＋ `forwardShim`，**必须**用真键位表（Stage A 从
##   `gui::SHORTCUTS` 导出注入）——空表下"按了没反应"与"产品没接线"输出一模一样。
## ⚠️⚠️ **可见首帧**（其 §7.1 `0c-②`）**不在本目标里**——那要求窗口可见 ⇒ 如实留在人工验收。
## ⚠️ 五次变异打的都是**页面副本**（⛔ 仓库文件一字未动），各自只钉一条判据：
##   M1 只搬文字层、不搬外边距 ⇒ `B0-5` 红；M2 组合中间态也落事务 ⇒ `D1b` 红；M3 未改动也提交 ⇒ `E1` 红；
##   M4/M5 `save()` 先取全文再提交 ⇒ `H4`/`H5` 红（**同一份 `m4.json`**，⛔ 别记成两处变异）；
##   ⭐ M6/M7 把 `bugs/0014` 的真缺陷原样打回（`live/selection.js` 里 `const head = r.from;` → `r.head`）
##   ⇒ `D13`/`D14` 必红、**`D15`（选区删除）必须仍绿**（同一份 `m6.json` 的两面）。
##   ⚠️ 施加前校验命中**恰好 1 次**并 `cksum` 前后比对——"没红"必须先排除"没改到"。
##   ⚠️⚠️ M1 的两个**等价改法**都实测过、都不红（⛔ 别再走一遍）：只删 `swapLiveView` 那处调用、
##   或把 `applyBox` 整个停掉（后者会让几何闸门先拒收这一块，表现为"变异后 = null"）。
## ⚠️ 离屏 `.prohibited` ＋ `alphaValue=0` ＋ `orderBack` ⇒ 不弹窗、不抢前台、不合成系统按键；
##   页内事件是**派发到 DOM 元素**上的 `MouseEvent`/`KeyboardEvent`/`CompositionEvent`/`InputEvent`。
## ⚠️ 要 `swiftc` ＋ 先 `make cm6`；⚠️ 默认**不落盘**，存证据 `ARGS="--save"`（拒绝覆盖）；
##   只想跑基线：`ARGS="--no-mutate"`（**七条**变异判据记成**跳过**，⛔ 不是通过）。
## 用法：`make probe-live-block`；`ARGS="--json"` 只打原始 JSON；`ARGS="--diag"` 打诊断（⛔ 不判判据）。
probe-live-block:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/live-probe/block-probe.sh $(ARGS)

## ⭐ 2026-10-21：**文档内链接安全导航**的离屏闸门（`design/0026` §7.2，**5 条判据 ＋ E**）
##
## 判据 1 点击相对链接被拦（另注册的监听器读到 `defaultPrevented`）；
##   2 **对照组**：程序性 `location.href` 必须进 `decidePolicyFor`（= Tauri `on_navigation`）
##     ——证明"检测器活着"；3 同文档锚点被拦 ＋ **3b 记录事实**（锚点导航走不走回调，
##     两种答案都正常，`design/0026` §7.1 0a）；4 闸门拒绝后地址不变、页面存活；
##   5 `rmd-unsupported:javascript` 点击后零导航、无脚本执行。判据 E（前台没被抢）在 `.swift` 侧。
## ⚠️⚠️ **不可信事件的边界**：页面里 `el.click()` 是**不可信事件**，WebKit 不为它执行默认导航
##   ⇒ "点了 location 没变"**证明不了** `preventDefault` 生效。承重的是
##   "后注册的监听器读到 `defaultPrevented === true`"与"`followLink` 收到的是**原始相对串**"，
##   对照组因此走**程序性导航**（那才是真会进回调的一条路）。
## ⚠️ 跑的是**产品那两份**（`src/services/links.js` ＋ `src/services/keymap.js`，原样拷入），
##   委托与 `followLink` 的流程**镜像**自 `src/main.js`（根脚本进不了探针页）
##   ⇒ 产品侧那一层由 `tests/js/links.test.js` 的源码级闸门 #19–#24 守，
##   ⛔ 探针**不能**证明 `main.js` 接对了。
## ⚠️ 离屏（`.prohibited` ＋ `alphaValue = 0` ＋ `orderBack`）、不弹窗、不抢前台、不合成按键。
## ⚠️ 默认**不落盘**（改一次 `services/links.js` 或 `main.js` 的链接那半就跑一次）；
##   存证据 `ARGS="--save"`（仍拒绝覆盖同名结果，除非 `--force`）。
## ⚠️ 它**答不了**：真机上点一条链接的观感、决策条文案读起来顺不顺 —— 那是人工项。
## 用法：`make probe-link-nav`；`ARGS="--json"` 只打原始 JSON。
probe-link-nav:
	@test -x "$(shell command -v swiftc)" || { echo "✗ 没有 swiftc。需要 Xcode 命令行工具：xcode-select --install"; exit 1; }
	@bash tools/wkwebview-probe/link-nav-probe.sh $(ARGS)

## `design/0025` §7.1 步骤 0a：**菜单就地切换**的离线自证（A–G 七条判据）
##
## ⭐ 它问的是探针**够不到**的那一半：`probe-i18n` 量 DOM，而 nsmenu（原生菜单栏）
##    不是 DOM ⇒ 只能由**进程自己**改一次、再读回来。
## ⚠️ **不建窗口**：入口在 `win.build()` 之前，判据跑完就 `std::process::exit(code)`
##    ⇒ ⛔ 不弹窗；且 macOS 上先设 `.prohibited`（`docs/kb/0025`）⇒ ⛔ 不抢前台、不合成按键。
## ⚠️ 判据进**退出码**（0 = 七条全过，1 = 有判据没过）；⛔ 不去 grep 文案（文案是给人看的）。
## ⚠️⚠️ 必须带 `RMD_FOREGROUND=1`：否则从终端直接敲时那条**静默分离**
##    （`design/0022`）会把本进程变成父进程，**退出码 0 只表示子进程创建成功**，
##    而探针真正的退出码根本传不回来。
## ⚠️ 它是 **GUI 构建才有**的入口（`menu_probe` 在 `gui/` 下）⇒ 先 `make build-gui`。
##    这里**只读** $(BIN)，⛔ 不安装、不碰 $(PREFIX)。
## ⚠️ 它会**往 rmd.log 写一行启动记录**（GUI 启动即初始化 Sink，`design/0016`），
##    但 ⛔ 不写 `config.json`（没有窗口 ⇒ 没有任何"记住偏好"的触发点）。
probe-menu:
	@test -x $(BIN) || { echo "✗ 没有 $(BIN)——先跑 make build-gui"; exit 1; }
	@grep -q "$(GUI_MARKER)" $(BIN) 2>/dev/null || { echo "✗ $(BIN) 不含 GUI —— 先跑 make build-gui"; exit 1; }
	@RMD_MENU_PROBE=1 RMD_FOREGROUND=1 $(BIN) </dev/null

## 生成语料矩阵（17 个文件，约 53 MB）
corpus:
	@python3 benchmarks/gen_corpus.py

## 步骤 1：全量基准并落盘。⛔ 拒绝覆盖已有结果
bench:
	@test -x $(BIN) || { echo "✗ 没有 $(BIN)，先跑 make build"; exit 1; }
	@test "$(CORPUS_N)" = "17" || { echo "✗ 语料只有 $(CORPUS_N) 个（要 17），先跑 make corpus"; exit 1; }
	@if [ -f "$(OUTFILE)" ]; then \
		echo "⛔ 拒绝覆盖 $(OUTFILE)"; \
		echo "   benchmarks/results/ 是**历史记录**，不删不覆盖（design/0002 §8）。"; \
		echo "   要保留两份对比：先把旧文件改名，再重跑。"; \
		echo "   例：mv '$(OUTFILE)' '$(RESULTS)/$(TODAY)-$(MODEL)-run1.json'"; \
		exit 1; \
	fi
	@echo "▶ 17 文件 × 5 轮（预热 1）→ $(OUTFILE)"
	@$(BIN) bench $(CORPUS)/*.md --repeat 5 --json "$(OUTFILE)"

## 快速冒烟：只跑 3 个代表文件，不落盘（改代码后先跑这个）
bench-quick:
	@test -x $(BIN) || { echo "✗ 先 make build"; exit 1; }
	@$(BIN) bench $(CORPUS)/XL-plain.md $(CORPUS)/XL-headings.md $(CORPUS)/XL-tables.md --repeat 3

## `design/0009`/`0042`：**文件名搜索**的索引规模基准（⛔ 不是闸门，不做断言）
##
## 量两段：① 递归建索引要多久 ② 索引建好之后，一次查询多久（扫描 + 粗排 + 自然序 + 截断）。
## ⚠️ 夹具是**现造的临时目录**（默认 10 万个 .md，跑完即删），⛔ 不碰任何真实目录。
## ⚠️ 现造 10 万个文件约 10 s，整轮约 20–30 s；条数用 `N=` 调。
## ⛔ 不是端到端：**不含 IPC 序列化与前端渲染**（那两段见 `make probe-doclist`）。
## 用法：`make bench-search`；`make bench-search N=10000`；`make bench-search DIR=/some/dir` 只读已有目录。
bench-search:
	@cd $(SRC) && RMD_SEARCH_BENCH_N="$(or $(N),100000)" \
		RMD_SEARCH_BENCH_DIR="$(DIR)" \
		cargo test --release --offline -- --ignored --nocapture 搜索基准

## 批次 2：**GUI 侧**测量并落盘（`design/0002` §7.3 的口径 A）。⛔ 拒绝覆盖同名结果
##
## ⚠️ 与 `bench` 的分别：`bench` 量的是**后端**（T1/T2/T3，无窗口）；
##    本目标量的是**只有真 WebView 才有的那六个量**——T4/T5/T5b、T6/T6b、
##    残差 R、DOM 节点数，外加从 macOS 侧按进程采的 WebView 内存（§7.3.4 没有标准 API）。
##    ⇒ 它**真开窗口**，一次几十秒，而且**必须用 GUI 构建**（脚本自己会验 `rmd://menu` 标记）。
## ⚠️ 覆盖保护在**脚本里**（`tools/measure-gui.sh`），⛔ 不在这里再写一份——
##    bench 那份是历史遗留（脚本当时还没有），而同一判据两份实现迟早漂移。
##    要留两份对比：先改名，或显式 `make measure-gui ARGS=--force`。
## 常用：make measure-gui ARGS="--rounds 5" / ARGS="--out /tmp/x.json" / ARGS="某个文件.md"
measure-gui:
	@test -x $(BIN) || { echo "✗ 没有 $(BIN)，先跑 make build-gui（⛔ 批次 2 只能用 GUI 构建）"; exit 1; }
	@test "$(CORPUS_N)" = "17" || { echo "✗ 语料只有 $(CORPUS_N) 个（要 17），先跑 make corpus"; exit 1; }
	@bash tools/measure-gui.sh $(ARGS)

## 编译检查 + 规模统计（不产生产物）
check:
	@cd $(SRC) && cargo check --all-targets
	@echo ""
	@echo "Rust 代码行数："
	@find $(SRC)/src -name '*.rs' | sort | xargs wc -l | tail -20

## 主题的两条闸门（`design/0004` §7）：字面色值 + 最低契约完整性
##
## ⚠️ 这两条是 `INV-THEME-02` 与 §2.1.1.1 **唯一**的自动化防线，
##    而它们防的恰好是**浏览器不会报错**的两类缺陷：
##    ① 组件里写死一个色值 → 深色主题下那一处永远是最初那个色；
##    ② 某套主题少给一个「必须」变量 → **静默回落**到 light 的值。
##    两者都不会崩、不会报错，只会"看起来有点怪"——
##    ⛔ 所以不能靠"打开看看"，必须能在几毫秒里判定。
##
## ⚠️ 纯 grep/awk，不需要 node/python/cargo：它要能在裸机上跑。
lint-theme:
	@bash scripts/lint-theme.sh

## docs/ 的机器可查结构自检（`docs/README.md` 规则 8 留下的接口）
##
## 查四类：编号（四位、同目录不重复）／头部必填行／状态词是否落在模板枚举里／
## 文档间的 `.md` 引用能不能解析。**只读**，不写任何文件、不改任何状态。
##
## ⚠️ 两种口径：
##    ERROR（编号、必填行）→ 一律退出 1，修法是补文档；
##    WARN（状态词、断链、悬空指针）→ 默认只计数，`make docs-check STRICT=1` 才判红。
##    之所以不一刀切判红：历史文档里有整批「老标签／示例路径」，一刀切只会让人关闸门。
##
## 自检（每条断言都配注入违规的负对照）：make docs-check-selftest
docs-check:
	@python3 -I tools/docs-check.py $(if $(STRICT),--strict) $(if $(WARN),--list-warn)

docs-check-selftest:
	@bash tools/docs-check-selftest.sh

## 第三方依赖的许可证清单（`features/0027` 工作项 2）
##
## ⚠️ `THIRD-PARTY-NOTICES.md` **只由脚本生成**，⛔ 不要手改：
##    依赖一升级，手写清单就会少一条或版本对不上，而**没人看得出来**。
##    Rust 侧取 `cargo metadata --features gui --filter-platform aarch64-apple-darwin`
##    （⚠️ 不带 `--features gui` 会漏掉整棵 Tauri 依赖树）；
##    npm 侧从 `package.json` 的 dependencies 出发在 `node_modules/` 里收集（要 `npm ci`）。
## ⚠️ `check-third-party` 是**闸门**：磁盘上那份与"现在重新生成"不一致就退出 1。
third-party:
	@python3 -I scripts/gen-third-party.py

check-third-party:
	@python3 -I scripts/gen-third-party.py --check

## 公开候选树的导出 / 扫描 / 断链检查（`design/0024` §2.1、§2.2、§7）
##
## ⚠️ 这三条**只读写 `$TREE`（默认 `$(HOME)/rmd-public-candidate/rmd`），⛔ 不碰源仓库**：
##    导出是**白名单**（只拷 `is_public()` 里点名的路径），扫描**只报不改**。
## ⚠️ `export-public` 在**已跟踪文件有未提交改动**时默认退出 4——
##    因为文件集合取 `git ls-files`、内容取工作树，脏工作区会让
##    「同一 OUT 连跑两次 `diff -r` 为空」那条判据失效（`INV-EXPORT-06`）。
## ⚠️ `scan-public` 的**命中不是失败**（退出 0 只表示"扫完了"）：
##    导出树里本来就有 `/Users/x` 一类占位符，⛔ 别把"0 命中"读成安全证明。
##
## 常用：make export-public / make export-public OUT=/tmp/x
##       make scan-public / make scan-public TREE=/tmp/x / ARGS=--no-tree
##       make check-links / make check-links TREE=/tmp/x
OUT  ?=
TREE ?= $(HOME)/rmd-public-candidate/rmd

export-public:
	@bash scripts/export-public.sh $(if $(OUT),--out "$(OUT)") $(ARGS)

scan-public:
	@bash scripts/scan-public.sh --tree "$(TREE)" $(ARGS)

## ⚠️ 只判 **Markdown 链接**（`[x](y)` 与引用式 `[x]: y`），⛔ 不判反引号里的路径；
##    也不判 anchor 是否存在（见 `scripts/check-links.sh` 的文件头）。
check-links:
	@bash scripts/check-links.sh "$(TREE)"

## 清理构建产物。⛔ 不碰 benchmarks/results/（历史记录）
clean:
	@cd $(SRC) && cargo clean
	@echo "✓ 已删 $(SRC)/target/"
	@echo "ℹ️ 保留未动：$(RESULTS)/（$(RESULT_N) 个结果，历史记录）"
	@echo "             $(CORPUS)/（$(CORPUS_N) 个语料，可再生）"
	@echo "⚠️ 现在没有二进制了，跑任何测量前先 make build（GUI 用 make build-gui）。"

## 删语料（可再生产物）。结果不动
clean-corpus:
	@rm -rf $(CORPUS)
	@echo "✓ 已删 $(CORPUS)/"
	@echo "ℹ️ 保留未动：$(RESULTS)/（历史记录）。回来跑 make corpus。"

## 把编好的二进制**拷贝**一份到 $(PREFIX)（默认 ~/.local/bin，PATH 里已有）
##
## ⚠️ 四条讲究：
## 1. **只装 GUI 构建**。判定用 $(GUI_MARKER)（见文件头变量处的说明）——装上一份
##    纯 CLI 的会得到"看着装成功了，`rmd 文件.md` 却报没编译 GUI"。
## 2. **是一份拷贝，不是软链**。软链会被下一次 `make build`（纯 CLI）当场换掉；
##    拷贝的代价是**会过期**——⚠️ 但**现在这条基本被堵住了**：`build-gui` 收尾会自动调本目标
##    （见文件头第 5 条），所以"改了源码却忘了装"不再发生。
##    仍会出过期的两种情况：① 跑过 `make build`（纯 CLI，写的是同一个 $(BIN) 路径）；
##    ② 上次用了 `NO_INSTALL=1`。两种都靠 `make doctor` 的 `cmp` 报出来。
## 3. ⭐ **`$(PREFIX)/rmd` 已经是一条符号链接时，本目标⛔ 不碰它**（`design/0033`）。
##    应用内「安装命令行工具」建的就是一条指向运行中 `.app` 的链接 —— 换新版 `.app`
##    之后它自己跟着变。一份拷贝盖上去 = 用户从此**拿着会过期的旧二进制**，
##    而应用菜单里那份托管关系也就此断掉（判据见 `scripts/install-guard.sh` 的头）。
##    真要换成拷贝：`make install FORCE=1`（会**先删链接**，⛔ 不是顺着它写进去）。
## 4. 会**检查源码是否比二进制新**并提醒（不拦——你可能是特意装旧的那份去对比）。
install:
	@test -x $(BIN) || { echo "✗ 没有 $(BIN)——先跑 make build-gui"; exit 1; }
	@if ! strings -a $(BIN) 2>/dev/null | grep -q '$(GUI_MARKER)'; then \
	  echo "⛔ 拒绝安装：$(BIN) 是**不含 GUI** 的构建（找不到标记「$(GUI_MARKER)」）。"; \
	  echo "   装上它的表现是：文件大小/权限/版本号都正常，但 rmd 一给文件就报「没编译 GUI」。"; \
	  echo "   ⇒ 先跑 make build-gui（要重新链 Tauri，几分钟）。"; \
	  exit 1; \
	 fi
## ⭐ 落点判定（`scripts/install-guard.sh`，⛔ 只读）。⚠️ `-L` 排在 `-e` 前是承重的：
##    悬空链接 `test -e` 是假 ⇒ 那条链接会被当成"空落点"处理。
##    ⚠️ **已取代**（2026-10-22 实测，`design/0033` §10）：原来这里写的是"`install(1)` 会
##    顺着链接把目标创建出来"。**不准确**——`install(1)` 先写临时文件再 rename ⇒
##    它**替换掉链接本身**（指向的目标一个字节没变）。代价是**托管关系断掉**，⛔ 不是写坏 `.app`。
## ⚠️⚠️ 守卫与后续步骤**必须在同一个 shell 块里**：配方的一行一个 shell，
##    把 `exit 0` 写在前一行只能结束那一行，make 照样往下装（2026-10-22 实测踩到）。
	@K=$$(scripts/install-guard.sh $(PREFIX)/rmd); \
	 if [ "$$K" = link ] && [ -z "$(FORCE)" ]; then \
	   echo "⏭ 跳过：$(PREFIX)/rmd 是一条**符号链接** → $$(readlink $(PREFIX)/rmd)"; \
	   echo "   它多半是应用内「安装命令行工具」建的：指着运行中的 .app，换新版后自己跟着变。"; \
	   echo "   ⛔ 本目标是**拷贝**，盖上去会让你拿着会过期的旧二进制，也让菜单里那份托管关系断掉。"; \
	   echo "   ⇒ 想换成拷贝：make install FORCE=1（先删链接再拷）；想撤掉它：应用菜单「卸载命令行工具」。"; \
	   exit 0; \
	 elif [ "$$K" = link ]; then \
	   echo "⚠️ FORCE=1 ⇒ 先删掉那条符号链接，再拷一份（应用菜单里那份托管关系到此结束）"; \
	   rm -f $(PREFIX)/rmd; \
	 elif [ "$$K" = other ]; then \
	   echo "⛔ 拒绝安装：$(PREFIX)/rmd 存在，但既不是普通文件也不是符号链接（目录？）"; \
	   exit 1; \
	 fi; \
	 mkdir -p $(PREFIX); \
	 NEWER=$$(find src src-tauri/src -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.rs' \) -newer $(BIN) 2>/dev/null | wc -l | tr -d ' '); \
	 if [ "$$NEWER" != "0" ]; then \
	   echo "⚠️ 有 $$NEWER 个源文件比 $(BIN) 新 ⇒ 装下去的会是**旧**二进制（前端是编译期嵌进去的）"; \
	   echo "   要最新的就先 make build-gui"; \
	 fi; \
	 test -f $(PREFIX)/rmd && echo "ℹ️ 覆盖已有的 $(PREFIX)/rmd（先前装的那份拷贝）"; \
	 install -m 755 $(BIN) $(PREFIX)/rmd || exit 1; \
	 echo "✓ 已装到 $(PREFIX)/rmd  （$$(du -h $(PREFIX)/rmd | cut -f1)）"; \
	 echo "  版本：$$($(PREFIX)/rmd --version 2>&1 | head -1)"; \
	 case ":$$PATH:" in *":$(PREFIX):"*) echo "  ✓ $(PREFIX) 在 PATH 里，直接敲 rmd <文件|目录>";; \
	   *) echo "  ⚠️ $(PREFIX) **不在 PATH 里**——加一行到 ~/.zshrc：export PATH=\"$(PREFIX):\$$PATH\"";; esac; \
	 echo "  ℹ️ 它是一份拷贝：改源码后重跑 make build-gui 会自动刷新这份（make uninstall 可撤）"

## 删掉 make install 装的那一份（⛔ 只碰 $(PREFIX)/rmd 这一个路径，构建产物不动）
##
## ⚠️ 它删的是**拷贝**。落到一条符号链接上时⛔ 不删——那条链接是应用建的，
##    "谁建的谁撤"（`design/0033`：卸载入口在应用菜单里）。真要删：`FORCE=1`。
uninstall:
	@K=$$(scripts/install-guard.sh $(PREFIX)/rmd); \
	 case "$$K" in \
	   absent) echo "ℹ️ $(PREFIX)/rmd 本来就不存在，没动任何东西" ;; \
	   link) \
	     if [ -z "$(FORCE)" ]; then \
	       echo "⏭ 跳过：$(PREFIX)/rmd 是一条**符号链接** → $$(readlink $(PREFIX)/rmd)"; \
	       echo "   它不是 make install 建的（那是应用内「安装命令行工具」）⇒ 请从应用菜单里卸载它。"; \
	       echo "   ⚠️ 真要在这里删：make uninstall FORCE=1（只删链接本身，不碰它指向的 .app）"; \
	       exit 0; \
	     fi; \
	     rm -f $(PREFIX)/rmd; echo "✓ 已删符号链接 $(PREFIX)/rmd（它指向的 .app 未动）" ;; \
	   file) rm -f $(PREFIX)/rmd; echo "✓ 已删 $(PREFIX)/rmd" ;; \
	   other) echo "⛔ 拒绝：$(PREFIX)/rmd 既不是普通文件也不是符号链接（目录？），请自己看一眼再删"; exit 1 ;; \
	 esac
	@echo "ℹ️ 构建产物 $(BIN) 未动；仓库其他东西未动。"

## ⭐ `design/0015` · 产品图标（`INV-APP-05`）
##
## 唯一可编辑的输入是 `src-tauri/icons/icon.svg`；`.png` / `.icns` 都是**产物**。
## ⚠️ 要 SVG 渲染器：先试 `sips`，不行回退 `qlmanage`；两者都失败就**停下**（⛔ 不手改 icns）。
icon:
	@scripts/make-icon.sh

## ⭐ `design/0015` §2.1① · 组装 `build/macos/rmd.app`（手工，⛔ 不引 tauri-cli）
##
## 依赖 `build-gui`：`.app` 里的可执行文件必须**就是** `$(BIN)`（`INV-APP-01`）。
## ⚠️ 判据在**签名之前**用 `cmp` 跑，并把内容哈希记进 `Contents/Resources/build-id.txt`——
##    bundle 签名会重写主可执行文件（绑定 Info.plist 的 CodeDirectory，2026-10-19 实测），
##    签名后 `cmp` 必然不等，那不是装错了。事后核对（doctor / smoke-app）读那个哈希。
## ⚠️ 收尾会 ad-hoc 重签整个 bundle；失败即非零退出，⛔ **不产出半成品**。
app: build-gui
	@scripts/make-app.sh

## ⭐ 本地候选 DMG（开源准备 · 工作项 6 的本地那一半）
##
## ⚠️ **不是发布**：ad-hoc 签名、不公证、不上传；产物在 `build/dmg/`（gitignore）。
## ⚠️ 依赖 `app`（而 `app` 依赖 `build-gui`）⇒ 会重新组装一次 `.app`。
## ⚠️ **拒绝覆盖已有同名 DMG**（同一天重跑先改名，或 FORCE=1）。
## ⚠️ `hdiutil create` **不挂载** DMG ⇒ 不会弹 Finder 窗口。
## 终端安装怎么来：DMG 里的 `README.txt` 写明 `ln -s` 到 `.app` 内的二进制，
## ⛔ 不自动改 shell 配置、⛔ 不做 Homebrew tap。
dmg: app
	@bash scripts/make-dmg.sh $(if $(FORCE),--force)

## ⭐ `design/0015` §2.1⑤ · 装到 `~/Applications` 并刷新 LaunchServices 缓存
##
## ⛔ **不改默认处理器**（`INV-APP-04`）——那是 `make default-app` 一条显式路径。
## ⚠️ 目标应用正在运行时**拒绝**（替换运行中的 bundle 会造出一份"跑着旧文件、
##    磁盘上是新文件"的状态）；⛔ 不会去杀用户的实例。
install-app: app
	@if pgrep -f "$(APP_INSTALLED)/Contents/MacOS/rmd" >/dev/null 2>&1; then \
	   echo "⛔ $(APP_INSTALLED) 正在运行——先退出那个窗口（本目标不会去杀它）"; exit 1; \
	 fi
	@mkdir -p "$(APP_DIR)"
	@if [ -e "$(APP_INSTALLED)" ]; then \
	   echo "ℹ️ 覆盖已有的 $(APP_INSTALLED)"; rm -rf "$(APP_INSTALLED)"; \
	 fi
	@ditto "$(BUILD_APP)" "$(APP_INSTALLED)"
	@$(LSREGISTER) -f "$(APP_INSTALLED)" || echo "⚠️ lsregister 返回非零（LaunchServices 缓存可能没刷新）"
	@echo "✓ 已装到 $(APP_INSTALLED)"
	@echo "  ℹ️ 默认处理器**没有**被改（INV-APP-04）；要改：make default-app"
	@echo "  ℹ️ 之后 make open 会走后台启动（终端不再被占住）"

## 删掉 `make install-app` 装的那一份（⛔ 只碰 `$(APP_INSTALLED)`；`$(PREFIX)/rmd` 不动）
uninstall-app:
	@if pgrep -f "$(APP_INSTALLED)/Contents/MacOS/rmd" >/dev/null 2>&1; then \
	   echo "⛔ $(APP_INSTALLED) 正在运行——先退出那个窗口（本目标不会去杀它）"; exit 1; \
	 fi
	@if [ -e "$(APP_INSTALLED)" ]; then \
	   rm -rf "$(APP_INSTALLED)"; \
	   $(LSREGISTER) -u "$(APP_INSTALLED)" >/dev/null 2>&1 || true; \
	   echo "✓ 已删 $(APP_INSTALLED)"; \
	 else \
	   echo "ℹ️ $(APP_INSTALLED) 本来就不存在，没动任何东西"; \
	 fi
	@echo "ℹ️ 构建产物 $(BUILD_APP) 与 $(PREFIX)/rmd 都未动。"

## ⭐ `design/0015` §7.1 · `.app` 的自动验收（9 条判据，进退出码）
##
## ⚠️ 会**真的启动应用**（那正是被测对象），但一律 `open -g`（⛔ 不抢前台）、
##    ⛔ 不 `kill -9`；**已有 rmd 实例时整轮拒绝**，⛔ 不杀用户的进程。
## ⚠️ 它**不碰默认处理器**（`INV-APP-04`）——第 8 条只读 `which-default`。
smoke-app: app
	@tools/smoke-app.sh

## 只读：问"`.md` 现在默认由谁打开"（`NSWorkspace.urlForApplication(toOpen:)`）
## ⛔ 不改变任何设置——它可以在任何时候跑（doctor 也用它）。
which-default:
	@test -f "$(SAMPLE_MD)" || { echo "✗ 缺样本文件 $(SAMPLE_MD)"; exit 1; }
	@swift scripts/set-default-app.swift --show "$(SAMPLE_MD)"

## ⭐ `design/0015` §2.1⑥ · **唯一**会改系统默认打开程序的入口（`INV-APP-04`）
##
## 要求目标应用**已安装**（`make install-app`）——直接指向 `build/` 下那份会在
## 清理构建目录后留下一个指向不存在路径的默认处理器。
## 回滚：make default-app APP=/System/Applications/TextEdit.app
default-app:
	@test -d "$(APP)" || { echo "⛔ $(APP) 不存在——先 make install-app（或 APP= 指一个真实的应用）"; exit 1; }
	@test -f "$(SAMPLE_MD)" || { echo "✗ 缺样本文件 $(SAMPLE_MD)"; exit 1; }
	@echo "▶ 把「$(SAMPLE_MD)」这类文件的默认打开程序改为：$(APP)"
	@echo "  ⚠️ 这是**系统级设置**（INV-APP-04）；只有本目标会改它，安装/构建/冒烟都不会"
	@swift scripts/set-default-app.swift --set "$(APP)" "$(SAMPLE_MD)"

## 显示本帮助
help:
	@printf '%s\n' 'rmd —— macOS 优先的 Markdown 阅读器（只读 ＋ 受控的窗口内编辑）'
	@printf '\n'
	@printf '%s\n' '用法: make <目标>     参数走环境变量：FILE=…  DEV=1  ARGS="…"  OUT=…  PREFIX=…'
	@printf '%s\n' '命令全表与每条的长注释：.claude/rules/build-and-run.md（本文只到"有哪些目标"）'
	@printf '\n'
	@printf '%s\n' '入门'
	@printf '  %-24s %s\n' 'doctor' '环境自检（先跑这个）：工具链 / 依赖 / 语料 / 结果 / 闸门'
	@printf '  %-24s %s\n' 'build' '编译 release，只有 CLI（快）；⚠️ 与 build-gui 写同一路径'
	@printf '  %-24s %s\n' 'build-gui' '编译含 GUI 的 release（链 Tauri，慢）＋ 收尾自动刷新 ~/.local/bin/rmd'
	@printf '  %-24s %s\n' 'test' '纯逻辑单测 = Rust release ＋ 集成 ＋ node --test tests/js/'
	@printf '  %-24s %s\n' 'test-js' '只跑前端那批（改 src/*.js 后用它，快）'
	@printf '  %-24s %s\n' 'typecheck' 'design/0052 U8：src/live/** 的类型闸门（checkJs，几秒；已并入 test）'
	@printf '  %-24s %s\n' 'help' '本帮助'
	@printf '\n'
	@printf '%s\n' '打开与阅读'
	@printf '  %-24s %s\n' 'open' '打开一个窗口（FILE=… 换文件）；装了 .app 就后台启动，DEV=1 回前台看 stderr'
	@printf '  %-24s %s\n' 'dev' 'open 的别名（前台跑，stderr 直出）'
	@printf '  %-24s %s\n' 'smoke' '批 1 验收：4 个 XL 文件 ＋ 2 个目录，程序自证能显示能滚'
	@printf '  %-24s %s\n' 'fidelity' 'design/0012 步骤 0e：七类样本的源码保真（逐字节）；要 GUI 构建'
	@printf '  %-24s %s\n' 'verify-0d' '中文 IME 的人工回归入口（只打清单，它不做判定）'
	@printf '\n'
	@printf '%s\n' '性能数字'
	@printf '  %-24s %s\n' 'measure-gui' 'GUI 侧测量并落盘（T4/T5/T5b/T6/T6b ＋ 残差 R）；真开窗口、一文件一进程'
	@printf '  %-24s %s\n' 'corpus' '生成 17 个语料文件（约 53 MB，seed 固定）'
	@printf '  %-24s %s\n' 'bench' '17 文件 × 5 轮并落盘；⚠️ 拒绝覆盖已有结果（那是历史记录）'
	@printf '  %-24s %s\n' 'bench-quick' '只跑 3 个 XL 文件，不落盘（改代码后的冒烟）'
	@printf '  %-24s %s\n' 'bench-search' '文件名搜索的索引规模基准（10 万条目；N= 调条数、DIR= 只读已有目录）'
	@printf '\n'
	@printf '%s\n' '探针（共同点：离屏、不弹窗、不抢前台、不合成按键；判据进退出码；默认不落盘，ARGS="--save" 才存证据）'
	@printf '  %-24s %s\n' 'probe' '步骤 0：技术风险五步（可加 ARGS="--file X.md"）'
	@printf '  %-24s %s\n' 'probe-wkwebview' '真机 WKWebView 能力（取证；要图形会话）'
	@printf '  %-24s %s\n' 'probe-find-key' '⌘F 会不会被 WKWebView 吞（⚠️ 合成真按键，须经用户同意）'
	@printf '  %-24s %s\n' 'probe-editor-key' '编辑区聚焦时各键归谁（⚠️ 进程内注入，须经用户同意）'
	@printf '  %-24s %s\n' 'probe-cm6' 'CM6 打开大 Markdown 的冷启动分段（取证；要 npm）'
	@printf '  %-24s %s\n' 'probe-editor-latency' '键入→绘制 / 预览调度 / 滚动漂移（取证；后端是模拟的）'
	@printf '  %-24s %s\n' 'probe-scroll-sync' '左右滚动同步的接线（真 DOM ＋ 真 CM6；先 make cm6）'
	@printf '  %-24s %s\n' 'probe-edit-chrome' '编辑分栏外壳 ＋ 光标色 ＋ 提示条不占位（先 make cm6）'
	@printf '  %-24s %s\n' 'probe-vim-keys' 'Vim 键位的接线与样式（先 make cm6；⛔ 全绿 ≠ Vim 验收了）'
	@printf '  %-24s %s\n' 'probe-reading-progress' '阅读进度的接线（离屏）'
	@printf '  %-24s %s\n' 'probe-image-viewer' '图片缩放预览的接线与几何（离屏）'
	@printf '  %-24s %s\n' 'probe-dir-session' '目录会话恢复的接线（离屏；判据 E 自证没抢前台）'
	@printf '  %-24s %s\n' 'probe-tree-menu' '右键菜单：复制绝对路径 ＋ 重命名（离屏；剪贴板是桩子）'
	@printf '  %-24s %s\n' 'probe-favorites-rootheader' '根头（0044）＋ 启动页收藏段（0043）（离屏；含 5 条变异）'
	@printf '  %-24s %s\n' 'probe-i18n' '中英双语的界面（真 DOM；加载真 src/index.html）'
	@printf '  %-24s %s\n' 'probe-link-nav' '文档内链接的安全导航（离屏；夹具要真写 other.md）'
	@printf '  %-24s %s\n' 'probe-live-block' '就地编辑：唯一全文模型 ＋ 单块视图的接线与几何（0047；离屏；含 4 处变异）'
	@printf '  %-24s %s\n' 'probe-live-markup' 'Lezer ↔ comrak 的标记差分表（0052 U9；⚠️ 差异不判红，产物是一份表）'
	@printf '  %-24s %s\n' 'probe-menu' '原生菜单的就地切换（⚠️ 必带 RMD_FOREGROUND=1，否则退出码不代表结果）'
	@printf '%s\n' '   取证探针没有断言、跑它不产生红绿（probe / probe-wkwebview / probe-cm6 / probe-editor-latency），'
	@printf '%s\n' '   别把它们算进测试覆盖面；每份探针的判据数与覆盖面见 .claude/rules/tests.md（本文件不抄，抄了会漂）。'
	@printf '\n'
	@printf '%s\n' '应用化（design/0015）：后台启动 / 产品图标 / 默认打开 .md'
	@printf '  %-24s %s\n' 'icon' '由 src-tauri/icons/icon.svg 生成 png/icns（唯一可编辑输入是 SVG）'
	@printf '  %-24s %s\n' 'app' '组装 build/macos/rmd.app（依赖 build-gui；逐字节 = 那份二进制）'
	@printf '  %-24s %s\n' 'install-app' '装到 ~/Applications 并刷新 LaunchServices（⛔ 不改默认打开程序）'
	@printf '  %-24s %s\n' 'uninstall-app' '删掉上面装的那一份（⛔ 只碰 ~/Applications/rmd.app）'
	@printf '  %-24s %s\n' 'smoke-app' '.app 的自动验收（12 条；open -g 不抢前台；已有实例时拒绝）'
	@printf '  %-24s %s\n' 'dmg' '本地候选 DMG（ad-hoc 签名、不公证、不上传；拒绝覆盖同名文件）'
	@printf '  %-24s %s\n' 'which-default' '只读：.md 现在默认由谁打开'
	@printf '  %-24s %s\n' 'default-app' '⛔ 唯一会改系统默认打开程序的入口（回滚：APP=/System/Applications/TextEdit.app）'
	@printf '\n'
	@printf '%s\n' '维护'
	@printf '  %-24s %s\n' 'install' '把含 GUI 的二进制拷一份到 ~/.local/bin/rmd（改 PREFIX= 换地方）'
	@printf '  %-24s %s\n' 'uninstall' '删掉上面装的那一份（⛔ 只碰那一个路径）'
	@printf '  %-24s %s\n' 'check' '编译检查 ＋ 代码行数'
	@printf '  %-24s %s\n' 'lint-theme' '主题两闸门：字面色值 ＋ 最低契约变量（改 src/styles/ 之后跑，几毫秒）'
	@printf '  %-24s %s\n' 'docs-check' '文档结构自检：编号／必填行／状态词／引用（只读；STRICT=1 把 WARN 也判红）'
	@printf '  %-24s %s\n' 'docs-check-selftest' '上一条自己的负对照（每条违规注入一次，必须报红）'
	@printf '  %-24s %s\n' 'clean' '删构建产物（⛔ 不碰 benchmarks/results/）'
	@printf '  %-24s %s\n' 'clean-corpus' '删可再生的语料（结果不动）'
	@printf '  %-24s %s\n' 'third-party' '重新生成 THIRD-PARTY-NOTICES.md（⛔ 不手改那份清单）'
	@printf '  %-24s %s\n' 'check-third-party' '校验清单没过期（依赖变了没重跑 ⇒ 退出 1）'
	@printf '\n'
	@printf '%s\n' '开源准备（design/0024；⛔ 只碰 $${TREE}，默认 ~/rmd-public-candidate/rmd）'
	@printf '  %-24s %s\n' 'export-public' '白名单导出公开候选树（文件集取 git ls-files ＋ 未跟踪文件）'
	@printf '  %-24s %s\n' 'scan-public' '三棵树扫描；⚠️ 命中不是失败，只报类型与 文件:行号，⛔ 不打印秘密内容'
	@printf '  %-24s %s\n' 'check-links' '导出树里 Markdown 相对链接的断链检查（⚠️ 只判路径存在）'
	@printf '\n'
	@printf '%s\n' '闸门'
	@printf '%s\n' '⛔ design 未「已通过」不许写代码；「已实施」只能由人改，Agent 最多置到「待评审」。'
	@printf '%s\n' '   状态看 docs/design/ 各份抬头 ＋ .claude/rules/designs.md —— 本帮助不抄份数、不抄条数（抄了必然过期）。'
	@printf '%s\n' '   交付闸门 0d（中文 IME）2026-10-16 已由用户真人验收闭合；回归入口 make verify-0d。'
