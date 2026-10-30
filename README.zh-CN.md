# rmd — 面向大型文档与本地文档目录的 Markdown 阅读器

在 macOS 上浏览、检索和阅读源码仓库、项目文档与本地 Markdown 资料。
从目录中定位文件，通过大纲和正文查找阅读长文，并在下次打开时继续阅读。

[English](README.md) · [下载](https://github.com/kumustone/rmd/releases/latest) · [更新记录](CHANGELOG.md) · [从源码构建](BUILDING.md)

**系统要求：macOS 13+，Apple Silicon。**

> 本文介绍当前开发分支。文档列表、空目录过滤、自定义目录过滤清单和侧边栏搜索属于开发版功能；
> 下载版的功能范围以对应 [Release 说明](https://github.com/kumustone/rmd/releases/latest) 为准。

[![rmd 阅读界面：中文排版、大纲、代码高亮、公式与表格](assets/screenshots/theme-light.png)](assets/screenshots/theme-light.png)

## 核心功能

### 大文档阅读与导航

- 支持代码高亮、数学公式、图表和表格，适合阅读技术文档与长篇说明。
- 通过大纲跳转章节，用 `⌘F` 查找当前文档的正文内容。
- 记住阅读位置，重新打开文档后继续阅读。
- 可调整字号、行高和内容宽度，提供浅色、深色、暖色及跟随系统的主题设置。

已对约 **100 KB–10 MB**、包含正文、标题、代码和表格的生成语料进行分阶段性能测量，
详见[性能基线](#性能基线)。

### 大规模目录浏览（开发版）

- **文件树**按需加载各层目录，适合沿项目结构浏览文档。
- **文档列表**集中展示当前目录及子目录中收录的 Markdown 文件，并显示父目录以区分同名文件。
- 列表分批追加，最多显示 **5,000 条**；超过上限时明确提示已显示条数与总数，可继续通过文件名搜索定位。
- 重新打开目录时恢复上次的文档与树展开状态；切换树／列表保留当前阅读的文档。

### 目录过滤（开发版）

- 隐藏点开头的文件与目录，减少无关条目。
- `node_modules`、`target`、`dist`、`build` 等默认忽略目录灰显且不进入扫描；可通过配置文件调整清单。
- 根据索引隐藏子树中没有 Markdown 文档的目录，保留能够通向文档的分支。
- 无法完整扫描的子树保守保留；文档列表会提示索引收录不完整的情况。

过滤用于减少导航噪声，不移动或删除磁盘上的文件。

### 快速文件名检索

- 用 `⌘P` 搜索当前目录及子目录中的文件名，无须先逐层展开目录。
- 支持模糊匹配，选中结果即可打开对应文档。
- 开发版还提供侧边栏常驻搜索框，与 `⌘P` 共用同一份索引。
- 检索对象为收录的 `.md` 文件；文件名搜索与当前文档正文查找分别提供入口。

## 安装与快速开始

### 下载应用

从 [Releases](https://github.com/kumustone/rmd/releases/latest) 下载 `.dmg`，打开后将 `rmd.app` 拖入 `/Applications`。
校验值与该版本的更新说明位于同一 Release 页面。

当前安装包使用本地签名（ad-hoc），尚未经过 Apple 公证。如果 macOS 阻止打开，先尝试启动应用，
再进入「系统设置 → 隐私与安全性 → 仍要打开」，按照系统提示确认。
参见 [Apple 的打开应用说明](https://support.apple.com/zh-cn/102445)。

### 浏览与阅读

1. 使用 `⌘O` 打开目录，或 `⇧⌘O` 打开单个 Markdown 文件。
2. 在文件树中浏览目录；开发版可通过文件面板的切换按钮选择文档列表。
3. 使用 `⌘P` 按文件名定位文档，使用大纲和 `⌘F` 查找文档中的内容。

### 从终端打开

打开应用菜单「rmd → 安装命令行工具…」，选择安装位置：

- `~/.local/bin`：无需管理员权限；若未加入 `PATH`，应用会提供配置说明。
- `/usr/local/bin`：安装时需要管理员授权。

安装完成后，应用会检测命令是否可用。它不会修改 shell 配置；卸载入口位于同一菜单。

```bash
rmd README.md     # 打开一个文件
rmd ./docs        # 打开一个目录
```

命令链接指向应用内的可执行文件；在相同路径替换新版应用后仍然有效，移动应用后需重新安装命令。

<details>
<summary>手动安装命令行入口</summary>

以下示例对应 `/Applications/rmd.app`。如安装在其他位置，请调整目标路径。

```bash
mkdir -p "$HOME/.local/bin"
ln -s /Applications/rmd.app/Contents/MacOS/rmd "$HOME/.local/bin/rmd"
export PATH="$HOME/.local/bin:$PATH"
```

`export` 仅影响当前终端；持久生效需按所用 shell 配置 `PATH`。已有同名入口时，可通过应用菜单管理。
</details>

从源码构建的依赖、命令和应用打包步骤见 [BUILDING.md](BUILDING.md)。

## 性能基线

在 **Apple M2 Pro、16 GB 内存、macOS 27.0** 上测量，以下均为 release 构建的中位数（2026-10-24）：

| 场景 | 测量结果 | 范围 |
|---|---:|---|
| 构建 10 万份 `.md` 的索引（201 个目录） | 122 ms | 后端索引构建 |
| 查询已建立的 10 万条索引，高命中率 | 48–54 ms | 后端匹配、排序与结果截断 |
| 列出单目录的 10 万项 | 354 ms | 后端扫描、过滤与排序 |
| 文档列表首批 500 行 | 12–13 ms | 离屏 DOM 构造与布局 |
| 文档列表 5,000 行追加完成 | 113 ms | 离屏 DOM 构造与布局 |

首次查询还需承担索引构建成本。上述数字不包含 IPC、真实窗口合成与首帧绘制，
不能视为完整的打开或输入响应时间。完整环境、分阶段大文档结果和复现方法见[性能文档](assets/performance/)。
目录、列表与搜索基线对应当前开发分支，具体版本范围在性能文档中说明。

## 阅读设置与可选编辑

rmd 以阅读为主。需要修改当前文档时，可显式进入分栏编辑：左侧 Markdown 源码，右侧渲染预览，
支持可选 Vim 键位。也可以用外部编辑器打开文档，磁盘内容变化后自动重载。
界面支持中文和英文。

<details>
<summary>查看浅色、深色与暖色主题</summary>

同一份文档在三套主题下的阅读效果。字号、行高和内容宽度可独立调整。

| 浅色 | 深色 | 暖色 |
| :---: | :---: | :---: |
| [![浅色](assets/screenshots/theme-light.png)](assets/screenshots/theme-light.png) | [![深色](assets/screenshots/theme-dark.png)](assets/screenshots/theme-dark.png) | [![暖色](assets/screenshots/theme-warm.png)](assets/screenshots/theme-warm.png) |

</details>

## 常用快捷键

| 动作 | 快捷键 |
|---|---|
| 打开目录 / 打开文件 | `⌘O` / `⇧⌘O` |
| 按文件名快速打开 | `⌘P` |
| 刷新文件索引 | `⌘R` |
| 当前文档正文查找 | `⌘F` |
| 显示或隐藏侧边栏 / 顶栏 | `⌘B` / `⇧⌘B` |
| 设置 | `⌘,` |
| 用外部编辑器打开 | `⇧⌘E` |
| 切换分栏编辑 | `⌘E` |

完整快捷键可在设置中查看，暂不支持自定义键位。

## 本地文件与隐私

文档直接保存在本地目录，无需导入或注册账号，也没有遥测或云同步。
文件读取遵循用户授权的文件与目录范围；文档脚本不执行，外部链接交给系统浏览器打开。
安全说明与漏洞报告渠道见 [SECURITY.md](SECURITY.md)。

## 构建与参与

rmd 使用 Rust、Tauri 2 和系统 WKWebView，不附带独立浏览器内核。前端使用原生 JavaScript，
分栏编辑基于 CodeMirror 6。运行应用不需要 Node.js。

- [从源码构建](BUILDING.md)
- [贡献指南](CONTRIBUTING.md)
- [GPL-3.0-or-later 许可证](LICENSE)
- [第三方组件与许可证](THIRD-PARTY-NOTICES.md)
