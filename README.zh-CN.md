# rmd —— 让技术文档读起来更舒服

一个为 macOS 打造的 Markdown 阅读器。从终端或其他应用打开本地 Markdown 文档，排版用心，文件好找。

[English](README.md)

> **状态：已发布。** macOS（Apple Silicon）安装包在 [Releases](https://github.com/kumustone/rmd/releases/latest)。
> 源码采用 **GPL-3.0-or-later**（见文末「许可证」）；从源码构建见 [BUILDING.md](BUILDING.md)。

[![rmd 正在阅读一份 Markdown 文档——侧边栏、工具栏与排版后的正文](assets/screenshots/theme-light.png)](assets/screenshots/theme-light.png)

## 为什么是 rmd

看技术文档，不必先打开写代码的工具。无论是从 Claude 中点开一份文档，还是在本地目录里寻找资料，
rmd 都希望让你尽快开始阅读，并且读得舒服：

- **随手打开**——从终端或其他应用打开本地 Markdown 文档。
- **合眼缘的排版**——为中文阅读细调的排版，配合浅色、深色和暖色主题（也可跟随系统）。
- **快速找到资料**——目录浏览与文件名搜索，让散落在文件夹里的文档更容易找到。
- **长文也好查阅**——通过大纲和正文搜索定位内容，记住阅读位置，下次接着看。

rmd 起于一个很简单的愿望：给自己经常阅读的技术文档，一个顺手、好看的打开方式。

## 它是什么

以阅读为主，编辑要你明确要求才发生。打开一个 Markdown 文件或一个目录，然后专心读：

- **渲染在 Rust 侧完成**——解析、代码高亮、公式与图表都做完之后，HTML 才交给窗口。
  10 MB 以内的实测成本见 [assets/performance/](assets/performance/)。
- **要编辑时才编辑**——显式的分栏编辑（左源码、右渲染），基于 CodeMirror 6，可选 Vim 键位。
  阅读态从不写你未明确打开编辑的文件。
- **交给你的编辑器**——用外部编辑器打开当前文档，磁盘上一改，rmd 自动重载。
- **界面中英双语**——菜单、状态条、提示跟随同一个语言设置；文档内容从不翻译。

它不是什么：不是笔记软件、知识库或同步笔记本；不是 Markdown 编辑器产品（编辑只对你显式打开的
那一份文档生效）；暂时也不跨平台——**macOS 13+，仅 Apple Silicon**。

## 主题

浅色、深色、暖色。下面三张截图是同一份文档——一份自写样张，含中文排版、行内代码、
带高亮的 Rust 代码块、行内与块级公式、表格和引用块——按同一组阅读设置
（16 px、行高 1.75、内容宽度 860）整窗截取，点开可看原尺寸。
切换主题只改变颜色；字号、行高与宽度保持你设定的值。

| 浅色 | 深色 | 暖色 |
| :---: | :---: | :---: |
| [![浅色](assets/screenshots/theme-light.png)](assets/screenshots/theme-light.png) | [![深色](assets/screenshots/theme-dark.png)](assets/screenshots/theme-dark.png) | [![暖色](assets/screenshots/theme-warm.png)](assets/screenshots/theme-warm.png) |

## 安装

### 下载安装

从 [Releases](https://github.com/kumustone/rmd/releases/latest) 下载最新的 `.dmg`（仅 Apple Silicon），
打开后把 `rmd.app` 拖进 `/Applications`。

它是 **ad-hoc 签名**（未公证），所以第一次打开会被 Gatekeeper 拦下：右键（或 Control-点按）
→ **打开** → 再点一次 **打开**；或者到「系统设置 ▸ 隐私与安全性」里点「仍要打开」。
放行一次之后系统会记住。

⚠️ 需要 **macOS 13+，Apple Silicon**。每个版本的校验值与变更记录在同页的 Release 里。

### 从源码安装

想自己编译，或者要一份不经过 Gatekeeper 的本地构建，见 [BUILDING.md](BUILDING.md)：
依赖、构建命令、`.app` 的组装、以及每条命令各自产出什么东西，都在那里。

### 在终端里用 `rmd`

打开 rmd → 菜单栏「rmd」→「安装命令行工具…」。它会问你装到哪：

- `~/.local/bin`——不需要密码，但 macOS 默认不把它放进 `PATH`。
- `/usr/local/bin`——通常已经在 `PATH` 里；写这个目录需要管理员密码。

链接指向正在运行的 `.app` 里的二进制，所以在同一路径上换新版 `.app` 它照样能用；
把应用挪走才需要重做一次。装完应用会当场探测一次，如实告诉你终端里现在能不能敲到
（敲不到时会给出可复制的那一行 `export`）。它**不会**改你的 shell 配置，卸载在同一个菜单里。

<details>
<summary>手动兜底（自己建一条软链）</summary>

```bash
mkdir -p ~/.local/bin
ln -sf ~/Applications/rmd.app/Contents/MacOS/rmd ~/.local/bin/rmd
```

路径要用应用实际所在的位置——从 DMG 装的话就是 `/Applications/rmd.app`。两个前提：
目录得先存在（所以有 `mkdir -p`），而且得在 `PATH` 里。
指向固定路径的链接在原位升级后仍然有效；只有把应用挪走才需要重建。
</details>

## 快捷键

| 动作 | 快捷键 |
|---|---|
| 打开目录 | `⌘O` |
| 打开文件 | `⇧⌘O` |
| 快速打开（按文件名搜） | `⌘P` |
| 刷新文件索引 | `⌘R` |
| 正文内查找 | `⌘F` |
| 显示/隐藏侧边栏 | `⌘B` |
| 显示/隐藏顶栏 | `⇧⌘B` |
| 设置 | `⌘,` |
| 用外部编辑器打开 | `⇧⌘E` |
| 切换分栏编辑 | `⌘E` |

完整键位在设置里，与菜单同一份来源；暂不支持改键位。

## 性能

只公开**自己这一版**的可复现基线，不做竞品排名。
测量方法、机器、语料与数字都在 [assets/performance/](assets/performance/)。
那里的每个数字都来自 `make bench` 产出的 JSON 结果文件，可以在本机复现。

那一页**没有**、这份 README 也**不**声称两件事：GUI 从启动到首屏要多久，以及 rmd 比别的阅读器快。
两件都还没有测过。

## 安全

rmd 是本地阅读器：没有联网功能、没有遥测、没有账号。文档里的裸 HTML **不会被透传**；
文档内容**不能**把阅读窗口导航走；文件访问只限你显式打开过的路径。
细节与报告渠道见 [SECURITY.md](SECURITY.md)。

## 技术栈

**Rust**（解析、渲染、文件访问）运行在 **Tauri 2** 外壳里，用系统自带的 WKWebView，
不打包浏览器内核。界面是原生 JavaScript 与 DOM；CodeMirror 6 在构建期打包，只供分栏编辑使用。
**只有构建需要 Node，运行 rmd 不需要。**

构建步骤与前置条件见 [BUILDING.md](BUILDING.md)。

## 许可证

rmd 是自由软件，采用 **GNU 通用公共许可证第 3 版或更高版本**（GPL-3.0-or-later）——
全文见 [LICENSE](LICENSE)。只要遵守 GPL，你可以再分发构建产物：随附许可证，并提供对应的源码。

随附的第三方组件及其许可证列在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，
由 `make third-party` 生成。

## 参与

见 [CONTRIBUTING.md](CONTRIBUTING.md)。比小修小补大的改动，请先开 issue。
