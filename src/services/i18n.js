// 界面文案的**唯一**来源 —— `design/0025-界面中英双语.md` §2.1/§2.5（2026-10-21）。
//
// # 它是什么
//
// 一个文件、两本扁平字典（`zh` / `en`），加一个**永远返回字符串**的 `t()`。
// ⛔ 不引 i18n 框架、⛔ 不做复数/RTL/日期本地化、⛔ 不做语言包热加载
// （理由：本项目 300 多个键，最复杂的形态是 `已打开目录 {root}（根 {n} 个）`）。
//
// # 三条承重约定
//
// 1. ⭐ **`t()` 永不返回空串或 `undefined`**（`INV-I18N-02`）：
//    回落链是 **当前语言 → 中文 → key 本身**。
//    ⚠️ 界面上出现一块空白，比"英文没翻"更难查——后者一眼看得出是没翻，
//    前者会被当成布局 bug 去查 CSS。
// 2. ⭐ **生效语言只有一个裁定点在 Rust**（`INV-I18N-07`）：本文件**⛔ 不读
//    `navigator.language`**。初始语言来自 `window.__rmdLang`（`gui/mod.rs` 的
//    `init_script` 注入，与 `window.__rmdMeasure` 同一手法），之后再被会话快照复核。
//    两处判定 = 两份真值，分叉的表现是"菜单中文、界面英文"。
// 3. ⭐ **翻译只影响显示**（`INV-I18N-04`）：⛔ 别把 `t()` 的结果拿去比较、存盘、
//    当 `data-*` 值或快捷键 id。本项目已经有 `tauri.js` 的 `kind` 与
//    `report_status` 那几行**机器读**的串，它们一律不进字典。
//
// # 加载期
//
// `i18n.js` 必须排在**所有使用者之前**（`INV-I18N-06`，`index.html` 里
// `services/i18n.js` 是 `services/` 的第一条 `<script>`）。经典脚本按顺序执行、
// 模块依赖是加载期取值 ⇒ 排反了的表现是"某个界面第一次用到时才炸"
// （`design/0009` §10.3 实测过同一族：浮层能开，敲第一个字符才报 undefined）。
//
// ⚠️ 它**不依赖任何 `window.rmd.*` 模块**——这是它能排最前的前提。
// ⚠️⚠️ 每个文件都包一层 IIFE（经典脚本共享全局词法作用域，顶层 `const` 撞名
// 会让整个文件不执行，见 `FileTree.js` 的详细说明）。
(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────
  // 两本字典
  //
  // ⚠️ 键是**扁平点分串**、**按界面区域**分组（⛔ 不按文件分组：
  //    `Settings.js` 与 `ThemeSwitcher.js` 共用 `theme.*`）。
  // ⚠️ 两本的**键集合必须逐字相等**，每个键的**占位符集合也必须相等**
  //    （`INV-I18N-03`，由 `tests/js/i18n.test.js` 双向断言）。
  //    少一个参数的表现是句子缺一块，而屏幕上不会报任何错。
  // ⚠️ 中文这一本是**回落目标**，改它等于改出厂文案——改之前先搜一下谁在断言它
  //    （`editor.test.js` / `vim-save.test.js` / `renderstat.test.js` / `search.test.js`
  //    的断言里逐字含着一批中文子串，见 `design/0025` §1.2）。
  // ────────────────────────────────────────────────────────────────
  const DICT = {
    zh: {
      // ── 侧边栏 ──
      'sidebar.tab-files': '文件树',
      'sidebar.tab-outline': '大纲',
      'sidebar.open-dir': '目录…',
      'sidebar.open-dir-title': '打开目录',
      'sidebar.collapse': '收起侧边栏',
      'sidebar.expand': '展开侧边栏',
      // ⭐ 两个图标按钮的 **tooltip**（`title`）：标签 + 键位。
      //   ⚠️ `applyDom()` **不做占位符替换**，所以这两条⛔ 不能写进 `data-i18n-title`
      //   ——那会原样贴上 `{key}`。带键的那句只在 `main.js::syncSidebarKeyHints()` 里现拼。
      'sidebar.collapse-key': '收起侧边栏（{key}）',
      'sidebar.expand-key': '展开侧边栏（{key}）',
      'sidebar.resize-title': '拖动调整宽度',
      'sidebar.unauth-title': '还没有授权任何目录，所以看不到文件列表。',
      'sidebar.unauth-dir': '所在目录：{dir}',
      'sidebar.unknown': '（未知）',
      'sidebar.open-this-dir': '打开此目录',
      'sidebar.unauth-hint': '打开目录后即可浏览其中的 Markdown 文件。',
      'sidebar.no-dir-title': '还没有打开任何目录。',
      'sidebar.last-dir': '上次打开的目录：{dir}',
      'sidebar.open-last-dir': '打开上次的目录',
      'sidebar.choose-other-dir': '选择其他目录…',
      'sidebar.open-dir-menu': '打开目录…',
      'sidebar.hint-open-key': '也可以按 {key} 直接打开一份文档。',
      'sidebar.hint-open': '也可以直接打开一份 .md 文档。',
      'sidebar.toc-empty': '这份文档没有标题。',
      'sidebar.untitled': '(无标题)',

      // ── 顶栏 ──
      'toolbar.theme': '主题',
      'toolbar.font-size': '字号',
      'toolbar.font-dec': '缩小字号',
      'toolbar.font-inc': '放大字号',
      'toolbar.line-height': '行高',
      'toolbar.width': '宽度',
      'toolbar.save-warn': '上次的设置未能保存',
      'toolbar.vim-title': '编辑态按 Vim 键位（普通 / 插入模式）',
      'toolbar.hide-chrome': '隐藏顶栏',
      'toolbar.show-chrome': '显示顶栏',
      // ⚠️ 带 `{key}` 的两条由 `main.js::syncChromeHints()` 现拼（`applyDom` 不做占位符替换）；
      //    静态 `title`/`aria-label` 只放纯标签 —— 与 `sidebar.collapse-key` 同形。
      'toolbar.hide-chrome-key': '隐藏顶栏（{key}）',
      'toolbar.show-chrome-key': '显示顶栏（{key}）',

      // ── 主题与排版（顶栏与设置覆盖层**共用**这几条）──
      'theme.system': '跟随系统',
      'theme.light': '浅色',
      'theme.dark': '深色',
      'theme.warm': '暖色',
      'typo.line-height.tight': '紧凑',
      'typo.line-height.normal': '标准',
      'typo.line-height.loose': '宽松',
      'typo.width.full': '铺满',
      'typo.width.wide': '宽 1200',
      'typo.width.medium': '中 900',
      'typo.width.narrow': '窄 720',

      // ── 编辑态外壳 ──
      'editor.enter': '编辑',
      'editor.enter-title': '进入编辑（在源码栏里改，右侧实时预览）',
      'editor.save': '保存',
      'editor.save-title': '保存这一份文档',
      'editor.preview-now': '更新预览',
      'editor.dirty': '● 未保存',
      'editor.splitter-title': '拖动调整分栏',
      // ⭐ 退出编辑：那两个按钮是**同一个** `#btn-edit`，文案随状态切（§2.5.1 ③）。
      'editor.exit': '退出编辑',
      'editor.exit-title': '退出编辑（回到阅读态）',
      // ── 正文里的图片（`design/0025`：占位块的文案也要能切语言）──
      'img.unauthorized': '此处有图片（{src}）未加载——未授权其所在目录',
      'img.missing': '图片不存在（{src}）',
      'img.unreadable': '图片读不出来（{src}）：{msg}',
      'img.unreadable-nomsg': '图片读不出来（{src}）',
      'img.remote': '远程图片（{src}）未加载',
      'img.load-once': '加载这一次',
      'img.loading': '图片加载中…',
      'img.authorize': '授权并打开其所在目录',
      'img.view': '查看图片',
      'img.view-with-alt': '查看图片：{alt}',
      // ── `⌘P` 文件名搜索浮层 ──
      'qo.title': '按文件名搜索',
      'qo.placeholder': '文件名…',
      'qo.index-ready': '索引已建好（{age}）',
      'qo.building': '正在建索引…',
      'qo.rebuilding': '正在重建索引…',
      'qo.refresh-hint': '{key} 刷新索引',
      'qo.empty-hint': '输入文件名开始搜索',
      'qo.error': '搜索失败：{msg}',
      // ── 文件树里的灰字与提示 ──
      'tree.ignored-title': '{path}\n（在忽略清单里：不展开、不扫描）',
      'tree.too-deep': '层级过深（超过 {n} 层），不再展开',
      'tree.layer-unreadable': '这一层读不出来（{msg}）。点一下可重试',
      'tree.layer-unreadable-nomsg': '这一层读不出来。点一下可重试',
      'tree.root-unreadable': '这个目录读不出来：{msg}',
      'tree.root-unreadable-nomsg': '这个目录读不出来',
      // ── `design/0034`：右键菜单、就地输入行、新建失败 ──
      // ⚠️ 菜单只有三项（新建文件 / 新建文件夹 / 刷新），⛔ 不照抄 Typora 的整张原生菜单。
      'tree.menu.new-file': '新建文件',
      'tree.menu.new-folder': '新建文件夹',
      'tree.menu.refresh': '刷新',
      // ── `design/0035`：复制绝对路径 / 重命名 ──
      'tree.menu.copy-path': '复制绝对路径',
      'tree.menu.rename': '重命名…',
      // ⭐ 置灰时那句 `title`（出路，不是原因）：干净编辑态下改名同样会撤销写授权，
      //    所以判据是"在编辑态"而不是"有未保存内容"（`design/0035` §3.4）。
      'tree.menu.rename.disabled-editing': '当前文档正在编辑，先保存并退出编辑态再重命名',
      // ⭐ 成功提示必须出现在 `await` **之后**；三类失败各说各的（§2.4）。
      'tree.copy.ok': '已复制绝对路径',
      'tree.copy.unsupported': '这个环境不支持复制，请手动记录这个路径',
      'tree.copy.denied': '系统拒绝了复制请求',
      'tree.copy.failed': '复制失败',
      // ⭐ 改名成功但后续某一步降级（§3.6：降级不是失败，但必须说出来）。
      'tree.rename.degraded.watch': '已改名，但自动刷新不可用（没能重新监视这个文件）',
      'tree.rename.degraded.path_check': '已改名，但没能确认新位置仍在已授权目录内',
      'reload.watch-rename-failed': '自动刷新不可用：改名后没能重建监视',
      // ⚠️ 预填名会被**全选**，直接打字就能覆盖；最终名字以后端返回的为准（可能补 `.md`）。
      'tree.default-file-name': '未命名.md',
      'tree.default-folder-name': '未命名文件夹',
      // ⭐ 刷新的可见反馈（1 秒内的淡出，⛔ 不弹 toast）。
      'tree.refreshing': '正在刷新…',
      // ── 图片预览覆盖层（`design/0018`）──
      'viewer.label': '图片预览',
      'viewer.zoom-out': '缩小',
      'viewer.zoom-in': '放大',
      'viewer.fit': '适应',
      'viewer.actual': '实际大小',
      'viewer.close': '关闭',

      // ── 编辑态的决策条与提示（`design/0012` §6）──
      // ⚠️ 这几条**整句**进字典，⛔ 不在源码里拼（§2.2.1）。
      'edit.ask-switch': '有未保存的修改，仍要打开「{name}」吗？',
      'edit.ask-exit': '有未保存的修改，仍要退出编辑吗？',
      'edit.ask-external': '有未保存的修改：外部编辑器只会看到磁盘上那一份（不含你刚改的内容）',
      'edit.act-save-continue': '保存后继续',
      'edit.act-discard-continue': '丢弃修改并继续',
      'edit.act-open-anyway': '仍要打开',
      'edit.act-reload-disk': '重新加载磁盘上的版本',
      'edit.act-keep-mine': '保留我的修改',
      'edit.cancelled': '已取消',
      'edit.save-failed-cancelled': '保存没成功，已取消上一步操作',
      'edit.entered': '已进入编辑（{name}）',
      'edit.envelope-eol': '⛔ 此文件行尾不统一，保存后将统一为 LF（不保证逐字节保真）',
      'edit.envelope-bom': '此文件带 BOM，保存时会保留',
      'edit.external-changed': '磁盘上的这份文件已变化，而编辑面里有未保存的修改',
      'edit.kept-mine': '已保留编辑面里的修改；磁盘上的那一份还没有被读取',
      'edit.disk-read-failed': '⛔ 磁盘上那一份读不回来：{msg}',
      'edit.switched-to-disk': '已换成磁盘上的版本',
      'edit.preview-stale-c': '预览已过期：这份文档重渲一次要一秒以上，已停止自动更新',
      'edit.preview-stale-ab': '预览已过期（停止输入后会自己更新）',

      // ── 状态条 ──
      'status.loading': '加载中…',
      'status.reload-now': '立即重载',
      // ⚠️ `INV-I18N-05`：菜单没换成时**必须**说出来（界面换了、菜单没换是可见的不一致）。
      'status.menu-lang-pending': '菜单将在重启后生效',
      // ⭐ `main.js` 那几处空态与失败态（⛔ 诊断串不在这里，§2.2）。
      'status.hint-open': '用 {dir} 打开一个目录，或 {file} 打开一份文档',
      'status.hint-open-no-keys': '用工具栏的「目录…」打开一个目录，或直接打开一份 .md 文件',
      'status.ready': '就绪 · 未打开任何文件（{hint}）',
      'status.ready-open-dir': '{dir} 打开目录',
      'status.ready-no-table': '未加载快捷键表',
      'status.dir-opened': '已打开目录 {name}（根 {roots} 个 · 代次 {gen}）· 从左侧选择一份文档',
      'status.open-failed': '⛔ 打开失败：{msg}{path}',
      'status.choose-dir-failed': '⛔ 打开目录失败：{msg}',
      'status.choose-file-failed': '⛔ 打开文件失败：{msg}',
      'status.session-failed': '⛔ 拿不到会话状态：{msg}',
      'status.startup-failed': '⛔ 启动失败：{msg}',
      'status.no-doc-external': '⛔ 还没有打开文档：先打开一份 .md 再用外部编辑器打开',
      'status.external-opened': '已交给外部编辑器打开（改完保存，这里会自动刷新）',
      'status.external-failed': '⛔ 打不开外部编辑器：{msg}{path}',
      'status.not-editing': '现在不在编辑态：按工具栏的「编辑」先进入编辑',
      'status.no-doc-edit': '⛔ 还没有打开文档：先打开一份 .md 再进入编辑',
      'status.edit-unavailable': '⛔ 编辑功能不可用：{note}',
      'status.edit-enter-failed': '⛔ 进不了编辑态：{msg}{path}',
      // ⚠️ 这一段**整句**给模板，⛔ 不在 `main.js` 里拼（§2.2.1）：
      //    半个句子分别翻译，拼出来一定是中式英文。
      'status.summary': '{path} · {src} 源 → {html} HTML · AST {ast} 节点 · 目录 {toc} 项 · ' +
        '图片 {total}（已载 {loaded} / 未授权 {unauthorized} / 远程 {remote} / 缺失 {missing}） · ' +
        'T1 {t1} / T2 {t2} / T3 {t3} ms',
      'status.bom-stripped': ' · 已剥 BOM',
      // ⚠️ 与 `services/renderstat.js` 的 `DEFAULT_TPL` **逐字相同**（测试钉着）。
      'doc.code-unhighlighted': ' · 代码未高亮 {un} / {all} 块（规模限制，内容完整）',
      // ⭐ `design/0033` 命令行工具：**22 条**（install 7 ＋ uninstall 5 ＋ none 1 ＋ verify 5 ＋ kind 4）。
      //    ⚠️ 设计写的是 16 条 —— 多出来的那几条是"一句话装不下"逼出来的，理由见
      //    `design/0033` §10（`shadowed` 拆成"被路径挡"与"被 kind 挡"两句；四类 kind 要各自的词）。
      //    ⛔ 键表在 `services/clitool.js` 的 `KEYS`，两边逐格对应（`tests/js/clitool.test.js` 钉着）。
      'status.cli.install.installed': '已建立链接：{path}（指向当前应用，换新版 .app 后它跟着变）',
      'status.cli.install.replaced': '已改写悬空链接：{path}（原链接指向的应用已不在了）',
      'status.cli.install.already': '已经装好了：{path} 就指向当前应用（未改动）',
      'status.cli.install.conflict': '⛔ 未安装：{path} 已存在且不是本应用建的链接（{detail}）',
      'status.cli.install.refused': '⛔ 不能从当前位置安装：{detail}',
      'status.cli.install.failed': '⛔ 安装失败：{path}（{detail}）',
      'status.cli.install.cancelled': '已取消：没有安装命令行工具',
      'status.cli.uninstall.uninstalled': '已删除：{path}',
      'status.cli.uninstall.absent': '本来就没有：{path}',
      'status.cli.uninstall.not-ours': '未删除：{path} 不是本应用建的链接（{detail}）',
      'status.cli.uninstall.cancelled': '未删除：{path}（授权被取消）',
      'status.cli.uninstall.failed': '⛔ 删除失败：{path}（{detail}）',
      // ⚠️ 连接词在**这里**（⛔ 不在 `clitool.js` 里拼「A 与 B」——那会把中文烤进载荷）。
      'status.cli.uninstall.none': '本来就没装：{a} 与 {b} 都没有本应用的链接',
      // ⚠️ `{dir}` 由 `clitool.js` 从链接路径现算（⛔ 不是后端字段）。
      //    ⛔ 这两句都**不许**说"可以用了"（`INV-CLI-06`）。
      'status.cli.verify.verified': '终端里现在能敲 rmd',
      'status.cli.verify.not-on-path': '终端还找不到：{dir} 不在 PATH 里。把 export PATH="{dir}:$PATH" ' +
        '加进 ~/.zshrc（bash 用 ~/.bash_profile），再新开一个终端',
      'status.cli.verify.shadowed-file': '路径已建好，但终端里敲 rmd 走的是 {path}（同名命令挡在前面）',
      'status.cli.verify.shadowed-kind': '路径已建好，但 shell 里的{kind} rmd 会先截住它，敲的不是这个',
      'status.cli.verify.unknown': '路径已建好，但没能确认终端里能不能敲到（探测输出不合约定）',
      'status.cli.kind.alias': '别名',
      'status.cli.kind.function': '函数',
      'status.cli.kind.builtin': '内建命令',
      'status.cli.kind.keyword': '保留字',
      'search.age-now': '刚刚',
      'search.age-seconds': '{n} 秒前',
      'search.age-minutes': '{n} 分钟前',
      'search.age-hours': '{n} 小时前',
      'search.none': '没有匹配的文件名',
      'search.truncated': '显示前 {shown} 条（共 {total} 条）',
      'search.count': '{n} 条',
      'search.index-age': '索引 {age}',
      'find.none': '无结果',
      'find.cap-note': '共 {total} 处，已高亮前 {shown} 处',
      'find.scope': '范围：渲染后的正文（不含 Markdown 源码标记）',
      'find.panel-label': '正文内查找',
      'find.placeholder': '在正文中查找…',
      'find.input-label': '查找关键词',
      'find.close': '关闭查找',
      'find.prev': '上一个',
      'find.next': '下一个',
      'find.prev-title': '{key} 上一个',
      'find.next-title': '{key} 下一个',
      'find.hint-next': '下一个 {key}',
      'find.hint-prev': '上一个 {key}',
      'find.building': '正在建立索引…',
      'find.error': '查找出错（{what}）：{msg}',
      'find.what-build': '建索引',
      'find.what-search': '搜索',
      'find.what-next': '下一个',
      'find.what-prev': '上一个',
      'find.what-close': '关闭',
      'save.saving': '正在保存…',
      'save.ignored': '正在保存，已忽略',
      'save.failed': '保存失败',
      'save.failed-with': '⛔ 保存失败：{msg}{path}',
      'save.no-change': '无改动',
      'save.done': '已保存（{bytes} 字节 / {ms} ms）',
      'save.done-but-dirty': '已保存，但你后来又改了（仍未保存）',

      // ── 文档内链接（`design/0026` §5 的那张表）──
      // ⚠️ 每一条都对应 `commands/link.rs` 的一种 `kind`（`services/links.js::plan` 逐格映射）：
      //    后端加一个 `kind` 而这里漏一句，屏幕上就是"点了没反应"（`INV-LINK-08`）。
      // ⚠️ `unauthorized` 与 `missing` **必须是两种说法**：前者引导用户显式选择，
      //    后者只是"没有它"——但两者都**⛔ 不透露授权外的东西存不存在**（那是后端判的）。
      'link.empty': '这条链接没有目标地址',
      'link.unauthorized': '这个位置还没有授权，rmd 没有打开它：{href}',
      'link.missing': '链接目标不存在或无法访问：{href}',
      'link.unsupported': '不支持的链接类型：{scheme}',
      'link.local-query': '本地链接带查询串，暂不支持：{href}',
      'link.anchor-missing': '正文里没有这个锚点：#{anchor}',
      'link.external-failed': '打不开系统浏览器：{message}',
      'link.reveal-failed': '打不开 Finder：{message}',
      'link.no-document': '还没有打开文档，链接无法定位基准目录',
      'link.stale': '链接目标已随文档切换失效（本次忽略）',
      'link.failed': '链接打开失败：{message}',
      'link.not-in-tree': '已在窗口中打开，但树里没有定位到它',
      'link.act-choose-file': '选择文件…',
      'link.act-choose-dir': '选择目录…',
      // ⚠️ 这两条是**成功**的那两格（`INV-LINK-08`：每一次点击都要有一个看得见的结果）。
      //    设计 §5 那张表只列了失败与拒绝的分支，这两条是实施时补的 ——
      //    理由与留痕在 `design/0026` §10。
      'link.external-opened': '已在系统浏览器中打开链接',
      'link.revealed': '已在 Finder 中显示该文件',

      // ── 空正文 ──
      'doc.empty-choose': '从左侧选择一份文档',

      // ── 树里定位失败的原因（`main.js::revealInTree`）──
      'reveal.too-deep': '层级太深，树里不展开',
      'reveal.unreadable': '中间某一层读不出来',
      'reveal.missing': '这个目录里没有它（可能刚被移走）',
      'reveal.missing-parent': '它的某一级父目录不在树里',
      'reveal.not-a-dir': '路径里有一段不是目录',
      'reveal.stale': '目录已切换，这次定位作废',
      'reveal.unknown': '未知原因（{reason}）',
      'reveal.miss': '未能定位到「{name}」：{reason}',
      'reveal.error': '树里定位出错：{msg}',

      // ── 自动重载（`design/0006`）──
      'reload.pos-lost': '文档已重新加载，原有的阅读位置没能恢复（已回到顶部）',
      'reload.auto-failed': '⚠️ 自动重载失败（{reason}）：{msg}',
      'reload.paused': '文件已在外部改变（{mb} MB，重载可能较慢）——已暂停自动刷新',
      'reload.watch-unavailable': '收不到文件变化事件（自动刷新不可用）：{note}',
      'reload.watch-stopped': '文件监视已停止（授权已改变）',
      'reload.watch-start-failed': '自动刷新不可用：{note}',
      // ⚠️ 这三个是**拼进上面那句话的短语**，⛔ 不是独立的界面元素——
      //    它们必须短，因为它们在括号里（`reload.auto-failed` 的 `{reason}`）。
      'reload.reason.auto': '文件已改变',
      'reload.reason.external': '外部改动',
      'reload.reason.manual': '手动重载',

      // ── 无障碍标签 ──
      'a11y.editor': '源码编辑区',
      'a11y.sidebar': '侧边栏',

      // ── 设置覆盖层 ──
      'settings.title': '设置',
      'settings.close': '关闭',
      'settings.group.appearance': '外观',
      'settings.group.editing': '编辑',
      'settings.group.shortcuts': '快捷键',
      'settings.theme': '主题',
      'settings.font-size': '字号',
      'settings.line-height': '行高',
      'settings.content-width': '内容宽度',
      'settings.custom': '自定义 {value}',
      'settings.language': '语言',
      'settings.lang.system': '跟随系统',
      'settings.lang.zh': '中文',
      'settings.lang.en': 'English',
      'settings.vim': 'Vim 模式',
      'settings.vim-toggle': '按 Vim 键位编辑',
      'settings.vim-note': '开启后，编辑态里那一栏源码按 Vim 的键位响应（普通 / 插入模式，模式名显示在栏内）。' +
        ' 关闭时它是普通编辑。⚠️ 这一项**默认关闭**，改完立即生效并记住。',
      'settings.shortcuts-note': 'V1 不支持改键位。下面是全部可用的键，由后端那张表生成。',

      // ── 后端拒绝的七类（`tauri.js` 的 `KIND_KEY` 指向这里）──
      // ⚠️ `no_document` 与 `not_found` **必须是两种说法**（`design/0006` §10.6 第 6 条）：
      //    "你打开的那个文件找不到了" vs "现在根本没有当前文档"。
      'err.kind.not_authorized': '未授权其所在目录',
      'err.kind.not_found': '文件不存在',
      'err.kind.stale': '已被更新的操作取代',
      'err.kind.io': '读写失败',
      'err.kind.conflict': '保存已取消（磁盘上的内容已变）',
      'err.kind.save_in_flight': '正在保存，已忽略',
      'err.kind.no_document': '没有打开文档',
      // ⭐ `design/0034`：新建文件 / 目录的四类拒绝。
      // ⚠️ `invalid_name` 只是**类别**那一句；具体原因见下面 `err.name.*`（六条）。
      'err.kind.already_exists': '同名条目已存在',
      'err.kind.invalid_name': '名字不合法',
      'err.kind.unusable_parent': '这个位置不能新建（父目录被隐藏或在忽略清单里）',
      'err.kind.created_outside_root': '创建复核失败（目标不在已授权目录内，未删除）',
      // ⭐ `design/0035`：重命名的拒绝。具体原因在 `raw.reason`（`err.rename.*`），
      //    ⛔ 不把三句拆成三个 kind（与 `invalid_name` 同一条理由）。
      'err.kind.not_renamable': '不能重命名这个文件',
      'err.rename.symlink': '这是符号链接，不能重命名',
      'err.rename.not_markdown': '只能重命名普通 Markdown 文件',
      'err.rename.editing': '当前文档正在编辑，先保存并退出编辑态再重命名',
      // ⚠️ `InvalidName` 的六个 reason（**与后端校验顺序一一对应**）。
      //    前端只做文案映射，⛔ 不重新判一遍规则（`INV-TREE-07`）。
      'err.name.empty': '名字不能为空',
      'err.name.separator': '名字里不能有 / \\ : 或控制字符',
      'err.name.reserved': '「.」和「..」不能用作名字',
      'err.name.hidden': '名字不能以「.」开头（树里不显示这样的条目）',
      'err.name.ignored': '这是被忽略的目录名（树里不展开它）',
      'err.name.too_long': '名字太长（超过 255 字节）',
      // ⚠️ 兜底那句的语义是"**我们不定义原因**"——⛔ 别改成"读取失败"（那是替一个
      //    未知的失败编了一个读盘原因，`docs/bugs/0005` 的同一族）。
      'err.kind.other': '操作失败',

      // ── 通用词（多处共用）──
      'common.cancel': '取消',
      // ⚠️ 路径后缀：中文全角括号、英文半角带前导空格——
      //    一处两用会在英文界面里排成"两个字的空当里塞一个路径"（§2.2.1 同族）。
      'common.in-parens': '（{path}）',
    },

    en: {
      // ── sidebar ──
      'sidebar.tab-files': 'Files',
      'sidebar.tab-outline': 'Outline',
      'sidebar.open-dir': 'Folder…',
      'sidebar.open-dir-title': 'Open Folder',
      'sidebar.collapse': 'Collapse Sidebar',
      'sidebar.expand': 'Expand Sidebar',
      'sidebar.collapse-key': 'Collapse Sidebar ({key})',
      'sidebar.expand-key': 'Expand Sidebar ({key})',
      'sidebar.resize-title': 'Drag to Resize',
      'sidebar.unauth-title': 'No directory has been authorized yet, so there is no file list.',
      'sidebar.unauth-dir': 'Directory: {dir}',
      'sidebar.unknown': '(unknown)',
      'sidebar.open-this-dir': 'Open this directory',
      'sidebar.unauth-hint': 'Open the directory to browse its Markdown files.',
      'sidebar.no-dir-title': 'No directory is open.',
      'sidebar.last-dir': 'Last opened: {dir}',
      'sidebar.open-last-dir': 'Open last directory',
      'sidebar.choose-other-dir': 'Choose another…',
      'sidebar.open-dir-menu': 'Open directory…',
      'sidebar.hint-open-key': 'Or press {key} to open a document.',
      'sidebar.hint-open': 'Or open a .md document directly.',
      'sidebar.toc-empty': 'This document has no headings.',
      'sidebar.untitled': '(untitled)',

      // ── 顶栏 ──
      'toolbar.theme': 'Theme',
      'toolbar.font-size': 'Font Size',
      'toolbar.font-dec': 'Decrease Font Size',
      'toolbar.font-inc': 'Increase Font Size',
      'toolbar.line-height': 'Line Height',
      'toolbar.width': 'Width',
      'toolbar.save-warn': "Couldn't save the last change",
      'toolbar.vim-title': 'Vim keys in the editor (normal / insert)',
      'toolbar.hide-chrome': 'Hide Top Bar',
      'toolbar.show-chrome': 'Show Top Bar',
      'toolbar.hide-chrome-key': 'Hide Top Bar ({key})',
      'toolbar.show-chrome-key': 'Show Top Bar ({key})',

      // ── theme & typography ──
      'theme.system': 'System',
      'theme.light': 'Light',
      'theme.dark': 'Dark',
      'theme.warm': 'Warm',
      'typo.line-height.tight': 'Compact',
      'typo.line-height.normal': 'Normal',
      'typo.line-height.loose': 'Relaxed',
      'typo.width.full': 'Full Width',
      'typo.width.wide': 'Wide 1200',
      'typo.width.medium': 'Medium 900',
      'typo.width.narrow': 'Narrow 720',

      // ── editor chrome ──
      'editor.enter': 'Edit',
      'editor.enter-title': 'Start editing (source on the left, live preview on the right)',
      'editor.save': 'Save',
      'editor.save-title': 'Save this document',
      'editor.preview-now': 'Update Preview',
      'editor.dirty': '● Unsaved',
      'editor.splitter-title': 'Drag to Resize Panes',
      'editor.exit': 'Done Editing',
      'editor.exit-title': 'Stop editing (back to reading)',
      // ── images in the document ──
      'img.unauthorized': 'An image here ({src}) was not loaded — its directory is not authorized',
      'img.missing': 'Image not found ({src})',
      'img.unreadable': 'Image could not be read ({src}): {msg}',
      'img.unreadable-nomsg': 'Image could not be read ({src})',
      'img.remote': 'Remote image ({src}) not loaded',
      'img.load-once': 'Load this time',
      'img.loading': 'Loading image…',
      'img.authorize': 'Authorize and open its directory',
      'img.view': 'View image',
      'img.view-with-alt': 'View image: {alt}',
      // ── the ⌘P file-name search overlay ──
      'qo.title': 'Search by file name',
      'qo.placeholder': 'File name…',
      'qo.index-ready': 'Index ready ({age})',
      'qo.building': 'Building index…',
      'qo.rebuilding': 'Rebuilding index…',
      'qo.refresh-hint': '{key} refresh index',
      'qo.empty-hint': 'Type a file name to search',
      'qo.error': 'Search failed: {msg}',
      // ── grey notes and tooltips in the file tree ──
      'tree.ignored-title': '{path}\n(in the ignore list: not expanded, not scanned)',
      'tree.too-deep': 'Too deep (over {n} levels); not expanding',
      'tree.layer-unreadable': 'This level could not be read ({msg}). Click to retry',
      'tree.layer-unreadable-nomsg': 'This level could not be read. Click to retry',
      'tree.root-unreadable': 'This directory could not be read: {msg}',
      'tree.root-unreadable-nomsg': 'This directory could not be read',
      // ── context menu, in-place input row, create failures (design/0034) ──
      'tree.menu.new-file': 'New File',
      'tree.menu.new-folder': 'New Folder',
      'tree.menu.refresh': 'Refresh',
      // ── `design/0035`：复制绝对路径 / 重命名 ──
      'tree.menu.copy-path': 'Copy Absolute Path',
      'tree.menu.rename': 'Rename…',
      'tree.menu.rename.disabled-editing': 'The document is being edited — save and leave edit mode before renaming',
      'tree.copy.ok': 'Absolute path copied',
      'tree.copy.unsupported': 'Copying is not supported here — please note the path manually',
      'tree.copy.denied': 'The system denied the copy request',
      'tree.copy.failed': 'Copy failed',
      'tree.rename.degraded.watch': 'Renamed, but auto-refresh is unavailable (the file could not be re-watched)',
      'tree.rename.degraded.path_check': 'Renamed, but the new location could not be confirmed to be inside an authorized folder',
      'reload.watch-rename-failed': 'Auto-refresh unavailable: could not re-watch after renaming',
      'tree.default-file-name': 'Untitled.md',
      'tree.default-folder-name': 'Untitled Folder',
      'tree.refreshing': 'Refreshing…',
      // ── image preview overlay (design/0018) ──
      'viewer.label': 'Image preview',
      'viewer.zoom-out': 'Zoom out',
      'viewer.zoom-in': 'Zoom in',
      'viewer.fit': 'Fit',
      'viewer.actual': 'Actual size',
      'viewer.close': 'Close',

      // ── editing decision bar & notes (`design/0012` §6) ──
      'edit.ask-switch': 'You have unsaved changes. Open “{name}” anyway?',
      'edit.ask-exit': 'You have unsaved changes. Stop editing anyway?',
      'edit.ask-external': 'You have unsaved changes: the external editor only sees the file on disk, not what you just typed',
      'edit.act-save-continue': 'Save and Continue',
      'edit.act-discard-continue': 'Discard and Continue',
      'edit.act-open-anyway': 'Open Anyway',
      'edit.act-reload-disk': 'Reload From Disk',
      'edit.act-keep-mine': 'Keep My Changes',
      'edit.cancelled': 'Cancelled',
      'edit.save-failed-cancelled': "The save didn't succeed — the previous action was cancelled",
      'edit.entered': 'Editing {name}',
      'edit.envelope-eol': '⛔ Mixed line endings — saving normalises them to LF (byte-for-byte fidelity is not guaranteed)',
      'edit.envelope-bom': 'This file has a BOM; it is kept on save',
      'edit.external-changed': 'The file changed on disk while the editor has unsaved changes',
      'edit.kept-mine': 'Your changes in the editor were kept; the version on disk has not been read',
      'edit.disk-read-failed': "⛔ Couldn't read the copy on disk: {msg}",
      'edit.switched-to-disk': 'Switched to the copy on disk',
      'edit.preview-stale-c': 'Preview is out of date: re-rendering this document takes over a second, so auto-update has stopped',
      'edit.preview-stale-ab': 'Preview is out of date (it updates once you stop typing)',

      // ── status bar ──
      'status.loading': 'Loading…',
      'status.reload-now': 'Reload Now',
      'status.menu-lang-pending': 'The menu will switch on the next launch',
      'status.hint-open': 'Press {dir} to open a folder, or {file} to open a document',
      'status.hint-open-no-keys': 'Use “Folder…” in the toolbar to open a folder, or open a .md file directly',
      'status.ready': 'Ready · no file open ({hint})',
      'status.ready-open-dir': '{dir} to open a folder',
      'status.ready-no-table': 'shortcut table not loaded',
      'status.dir-opened': 'Opened folder {name} ({roots} roots · generation {gen}) · choose a document on the left',
      'status.open-failed': "⛔ Couldn't open: {msg}{path}",
      'status.choose-dir-failed': "⛔ Couldn't open the folder: {msg}",
      'status.choose-file-failed': "⛔ Couldn't open the file: {msg}",
      'status.session-failed': "⛔ Couldn't get the session state: {msg}",
      'status.startup-failed': '⛔ Startup failed: {msg}',
      'status.no-doc-external': '⛔ No document open: open a .md file first, then use the external editor',
      'status.external-opened': 'Opened in the external editor (save there and this window refreshes automatically)',
      'status.external-failed': "⛔ Couldn't launch the external editor: {msg}{path}",
      'status.not-editing': 'Not editing: press “Edit” in the toolbar first',
      'status.no-doc-edit': '⛔ No document open: open a .md file before editing',
      'status.edit-unavailable': '⛔ Editing is unavailable: {note}',
      'status.edit-enter-failed': "⛔ Couldn't start editing: {msg}{path}",
      'status.summary': '{path} · {src} source → {html} HTML · AST {ast} nodes · TOC {toc} entries · ' +
        'images {total} (loaded {loaded} / unauthorized {unauthorized} / remote {remote} / missing {missing}) · ' +
        'T1 {t1} / T2 {t2} / T3 {t3} ms',
      'status.bom-stripped': ' · BOM stripped',
      'doc.code-unhighlighted': ' · {un} / {all} code blocks not highlighted (size limit; content is complete)',
      // ⭐ `design/0033`: **22** keys — see the zh block for why it is not 16.
      'status.cli.install.installed': 'Linked: {path} (points at the running app, so it follows .app upgrades)',
      'status.cli.install.replaced': 'Replaced a dangling link: {path} (its app is gone)',
      'status.cli.install.already': 'Already installed: {path} points at the running app (unchanged)',
      'status.cli.install.conflict': '⛔ Not installed: {path} exists and is not a link this app created ({detail})',
      'status.cli.install.refused': '⛔ Cannot install from this location: {detail}',
      'status.cli.install.failed': '⛔ Install failed: {path} ({detail})',
      'status.cli.install.cancelled': 'Cancelled: the command line tool was not installed',
      'status.cli.uninstall.uninstalled': 'Removed: {path}',
      'status.cli.uninstall.absent': 'Nothing there to begin with: {path}',
      'status.cli.uninstall.not-ours': 'Not removed: {path} is not a link this app created ({detail})',
      'status.cli.uninstall.cancelled': 'Not removed: {path} (authorization cancelled)',
      'status.cli.uninstall.failed': '⛔ Removal failed: {path} ({detail})',
      'status.cli.uninstall.none': 'Not installed to begin with: neither {a} nor {b} holds a link from this app',
      'status.cli.verify.verified': 'You can run rmd in the terminal now',
      'status.cli.verify.not-on-path': 'The terminal cannot find it yet: {dir} is not on PATH. Add ' +
        'export PATH="{dir}:$PATH" to ~/.zshrc (or ~/.bash_profile for bash), then open a new terminal',
      'status.cli.verify.shadowed-file': 'The link is in place, but typing rmd runs {path} instead (a same-named command comes first)',
      'status.cli.verify.shadowed-kind': 'The link is in place, but a shell {kind} named rmd catches it first',
      'status.cli.verify.unknown': 'The link is in place, but we could not confirm the terminal can reach it (probe output did not match the protocol)',
      'status.cli.kind.alias': 'alias',
      'status.cli.kind.function': 'function',
      'status.cli.kind.builtin': 'builtin command',
      'status.cli.kind.keyword': 'reserved word',
      'search.age-now': 'just now',
      'search.age-seconds': '{n}s ago',
      'search.age-minutes': '{n} min ago',
      'search.age-hours': '{n} h ago',
      'search.none': 'No matching file names',
      'search.truncated': 'Showing the first {shown} of {total}',
      'search.count': '{n} results',
      'search.index-age': 'index {age}',
      'find.none': 'No results',
      'find.cap-note': '{total} matches; highlighting the first {shown}',
      'find.scope': 'Scope: rendered text only (no Markdown source markers)',
      'find.panel-label': 'Find in document',
      'find.placeholder': 'Find in document…',
      'find.input-label': 'Search term',
      'find.close': 'Close find',
      'find.prev': 'Previous',
      'find.next': 'Next',
      'find.prev-title': '{key} previous',
      'find.next-title': '{key} next',
      'find.hint-next': 'Next {key}',
      'find.hint-prev': 'Previous {key}',
      'find.building': 'Building index…',
      'find.error': 'Find failed ({what}): {msg}',
      'find.what-build': 'build index',
      'find.what-search': 'search',
      'find.what-next': 'next',
      'find.what-prev': 'previous',
      'find.what-close': 'close',
      'save.saving': 'Saving…',
      'save.ignored': 'Already saving — ignored',
      'save.failed': 'Save failed',
      'save.failed-with': "⛔ Couldn't save: {msg}{path}",
      'save.no-change': 'No changes',
      'save.done': 'Saved ({bytes} bytes / {ms} ms)',
      'save.done-but-dirty': 'Saved, but you changed it again afterwards (still unsaved)',

      // ── links inside a document (`design/0026` §5) ──
      'link.empty': 'This link has no target',
      'link.unauthorized': "That location isn't authorized, so rmd didn't open it: {href}",
      'link.missing': "The link target doesn't exist or can't be reached: {href}",
      'link.unsupported': 'Unsupported link type: {scheme}',
      'link.local-query': "Local links with a query string aren't supported yet: {href}",
      'link.anchor-missing': 'No such anchor in this document: #{anchor}',
      'link.external-failed': "Couldn't open the system browser: {message}",
      'link.reveal-failed': "Couldn't open Finder: {message}",
      'link.no-document': 'No document is open, so the link has no base folder',
      'link.stale': 'The link went stale when the document changed (ignored)',
      'link.failed': 'Could not open the link: {message}',
      'link.not-in-tree': 'Opened in the window, but not found in the tree',
      'link.act-choose-file': 'Choose File…',
      'link.act-choose-dir': 'Choose Folder…',
      'link.external-opened': 'Opened the link in the system browser',
      'link.revealed': 'Revealed the file in Finder',

      // ── empty document pane ──
      'doc.empty-choose': 'Choose a document on the left',

      // ── why a reveal in the tree failed (`main.js::revealInTree`) ──
      'reveal.too-deep': 'Too deep — not expanded in the tree',
      'reveal.unreadable': "A folder along the way couldn't be read",
      'reveal.missing': 'Not in this folder (it may have just been moved)',
      'reveal.missing-parent': "One of its parent folders isn't in the tree",
      'reveal.not-a-dir': "Part of the path isn't a folder",
      'reveal.stale': 'The folder changed — this reveal was dropped',
      'reveal.unknown': 'Unknown reason ({reason})',
      'reveal.miss': "Couldn't locate “{name}”: {reason}",
      'reveal.error': "Couldn't locate it in the tree: {msg}",

      // ── auto-reload (`design/0006`) ──
      'reload.pos-lost': "Document reloaded, but the previous reading position couldn't be restored (back at the top)",
      'reload.auto-failed': '⚠️ Auto-reload failed ({reason}): {msg}',
      'reload.paused': 'The file changed on disk ({mb} MB — reloading may be slow) — auto-refresh paused',
      'reload.watch-unavailable': "File-change events aren't arriving (auto-refresh unavailable): {note}",
      'reload.watch-stopped': 'File watching stopped (access changed)',
      'reload.watch-start-failed': 'Auto-refresh unavailable: {note}',
      'reload.reason.auto': 'file changed',
      'reload.reason.external': 'external change',
      'reload.reason.manual': 'manual reload',

      // ── 无障碍标签 ──
      'a11y.editor': 'Source editor',
      'a11y.sidebar': 'Sidebar',

      // ── settings overlay ──
      'settings.title': 'Settings',
      'settings.close': 'Close',
      'settings.group.appearance': 'Appearance',
      'settings.group.editing': 'Editing',
      'settings.group.shortcuts': 'Shortcuts',
      'settings.theme': 'Theme',
      'settings.font-size': 'Font Size',
      'settings.line-height': 'Line Height',
      'settings.content-width': 'Content Width',
      'settings.custom': 'Custom {value}',
      'settings.language': 'Language',
      'settings.lang.system': 'System',
      'settings.lang.zh': '中文',
      'settings.lang.en': 'English',
      'settings.vim': 'Vim Mode',
      'settings.vim-toggle': 'Edit with Vim keys',
      'settings.vim-note': 'When on, the source pane follows Vim keys (normal / insert; the mode name shows in the pane).' +
        ' When off it is a plain editor. ⚠️ Off by default; changes apply and are remembered immediately.',
      'settings.shortcuts-note': 'V1 does not support rebinding. Below are all available keys, generated from the backend table.',

      // ── backend denial kinds ──
      'err.kind.not_authorized': 'Not authorized for its folder',
      'err.kind.not_found': 'File not found',
      'err.kind.stale': 'Superseded by a newer operation',
      'err.kind.io': 'Read/write failed',
      'err.kind.conflict': 'Save cancelled (the file changed on disk)',
      'err.kind.save_in_flight': 'Already saving — ignored',
      'err.kind.no_document': 'No document is open',
      'err.kind.already_exists': 'An item with that name already exists',
      'err.kind.invalid_name': 'Invalid name',
      'err.kind.unusable_parent': 'Cannot create here (the parent is hidden or in the ignore list)',
      'err.kind.created_outside_root': 'Post-create check failed (the item is outside the authorized folder; not deleted)',
      'err.kind.not_renamable': 'This file cannot be renamed',
      'err.rename.symlink': 'This is a symbolic link and cannot be renamed',
      'err.rename.not_markdown': 'Only plain Markdown files can be renamed',
      'err.rename.editing': 'The document is being edited — save and leave edit mode first',
      'err.name.empty': 'The name cannot be empty',
      'err.name.separator': 'The name cannot contain / \\ : or control characters',
      'err.name.reserved': '“.” and “..” are not valid names',
      'err.name.hidden': 'The name cannot start with “.” (the tree does not show such items)',
      'err.name.ignored': 'That is an ignored folder name (the tree never expands it)',
      'err.name.too_long': 'The name is too long (over 255 bytes)',
      'err.kind.other': 'Operation failed',

      // ── shared bits ──
      'common.cancel': 'Cancel',
      'common.in-parens': ' ({path})',
    },
  };

  /** `<html lang>` 的取值——⛔ 不是字典键。 */
  const HTML_LANG = { zh: 'zh-CN', en: 'en' };

  // ────────────────────────────────────────────────────────────────
  // 状态
  // ────────────────────────────────────────────────────────────────

  /**
   * 当前语言。⭐ 初始值取**注入**的那份（`window.__rmdLang`），⛔ 不读 `navigator.language`。
   * ⚠️ 注入缺失（老构建 / node 测试）时回落 `zh`——那是本项目的**出厂**语言。
   */
  let current = normalizeLang(
    (typeof window !== 'undefined' && window && window.__rmdLang) || 'zh'
  );

  /** ⭐ 请求过但**当前语言缺**的键（回落用过 zh 或 key）。去重、按首次出现排序。 */
  const missingKeys = [];
  /** ⭐ 模板里有、调用方没给（或给了 `undefined`）的占位符，`key:param` 形态。 */
  const missingParams = [];
  /** `setLang` 之后要重贴的动态文案（§2.5.1 层③）。 */
  const listeners = [];

  /** 任何输入都归一成 `'zh'` 或 `'en'`。⚠️ 未知值一律 `zh`（出厂）。 */
  function normalizeLang(l) {
    const s = String(l == null ? '' : l).trim().toLowerCase();
    // 接受 `zh` / `zh-CN` / `zh-Hans-CN` / `en` / `en-US` 这些形态——
    // 后端已经裁定过一次，这里只是把线上形状兜住（⛔ 不在这里再解释系统标签）。
    if (s === 'en' || s.indexOf('en-') === 0) return 'en';
    return 'zh';
  }

  function remember(list, item) {
    if (list.indexOf(item) < 0) list.push(item);
  }

  /**
   * 取一句话。
   *
   * @param {string} key 字典键（扁平点分串）
   * @param {object} [vars] 占位符取值，键名与模板里的 `{name}` 对应
   * @returns {string} **永远是字符串**（⛔ 不返回 `''` / `undefined`）
   */
  function t(key, vars) {
    const k = String(key == null ? '' : key);
    // ⚠️ **空键**是唯一"回落链给不出非空串"的输入：`String(key)` 本身就是 `''`。
    //    `INV-I18N-02` 要求**永不返回空串**（空白的代价是"看起来像布局 bug"），
    //    所以这里给一句**看得出来是缺键**的 ASCII 标记，⛔ 不是回落成 `''`。
    //    正常路径上不会出现——它只在有人把 `t()` 的参数写丢时露出来。
    if (!k) {
      remember(missingKeys, k);
      return '(i18n: empty key)';
    }
    let tpl = DICT[current][k];
    if (tpl == null) {
      tpl = DICT.zh[k];
      // ⚠️ 只记"当前语言缺"，⛔ 不记"两本都缺"成两条——那会让同一次漂移数出两倍。
      if (current !== 'zh') remember(missingKeys, k);
    }
    if (tpl == null) {
      // 两本都没有 ⇒ 显示 key 本身（比空白强：它**自己说明**是缺哪一条）。
      remember(missingKeys, k);
      return k;
    }
    if (tpl.indexOf('{') < 0) return tpl;
    return tpl.replace(/\{(\w+)\}/g, function (_m, name) {
      if (vars && Object.prototype.hasOwnProperty.call(vars, name) && vars[name] != null) {
        return String(vars[name]);
      }
      // ⚠️ 缺参数**不抛**、⛔ 不挡住整个界面：换成空串，并在自检里留下痕迹。
      remember(missingParams, k + ':' + name);
      return '';
    });
  }

  /** 当前语言。 */
  function lang() { return current; }

  /** 某个键在某本字典里有没有（默认查当前语言）。⚠️ 给闸门与测试用。 */
  function has(key, l) {
    const d = DICT[normalizeLang(l == null ? current : l)];
    return !!d && typeof d[key] === 'string';
  }

  /** 缺了哪些键（当前语言视角，去重）。 */
  function missing() { return missingKeys.slice(); }

  /** 缺了哪些占位符，`key:param` 形态。 */
  function missingVars() { return missingParams.slice(); }

  /**
   * 切语言。⭐ **顺序是承重的**（`design/0025` §2.5.1 末）：
   * ① 换字典与 `<html lang>` → ② `applyDom`（静态、带 `data-i18n*` 的）
   * → ③ 通知订阅者（**只能现算**的动态文案）。
   * 反过来，动态那半会读到旧字典。
   *
   * @param {string} l `'zh'` / `'en'` / 任何未知值（归一成 zh）
   */
  function setLang(l) {
    current = normalizeLang(l);
    const d = doc();
    if (d && d.documentElement) {
      // ⚠️ HTML 里保留一个出厂值 `zh-CN`，免得脚本没跑起来时 `lang` 缺失；
      //    但**运行时**一律由这里写，⛔ 不写死。
      d.documentElement.setAttribute('lang', HTML_LANG[current]);
    }
    if (d) applyDom(d);
    // ⚠️ 一个订阅者抛错**不许挡住其余**（与 `theme.js::subscribe` 同一条纪律）：
    //    覆盖层的 `relabel()` 崩一次不该让顶栏也停在旧语言。
    for (let i = 0; i < listeners.length; i++) {
      try { listeners[i](current); } catch (e) { console.error('i18n 订阅者出错：', e); }
    }
  }

  /**
   * 订阅语言变更（⭐ §2.5.1 层③：那些**只能现算**的动态文案）。
   * @returns {Function} 退订
   */
  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function doc() {
    return (typeof window !== 'undefined' && window && window.document) || null;
  }

  /** 四类 `data-i18n*` → 目标属性（`design/0025` §2.5 的表，逐字）。 */
  const ATTRS = [
    { sel: '[data-i18n]', attr: 'textContent', key: 'data-i18n' },
    { sel: '[data-i18n-title]', attr: 'title', key: 'data-i18n-title' },
    { sel: '[data-i18n-placeholder]', attr: 'placeholder', key: 'data-i18n-placeholder' },
    { sel: '[data-i18n-aria-label]', attr: 'aria-label', key: 'data-i18n-aria-label' },
  ];

  /**
   * 把 `root` 子树里带 `data-i18n*` 的节点重贴一遍。
   *
   * ⭐ **幂等**：切换语言后重复调用是正常路径（不是"顺手再跑一次"）。
   * ⚠️ 它**只写文本与那三个属性**，⛔ 不碰结构、⛔ 不内联 HTML——
   * 把 DOM 结构变成字符串会悄悄绕过 `INV-SEC-01`（渲染只在 Rust 侧）那条边界。
   * @param {Element|Document} [root] 默认整个文档
   * @returns {number} 改了多少个节点（探针用它做"真的切了"的反面判据）
   */
  function applyDom(root) {
    const base = root || doc();
    if (!base || typeof base.querySelectorAll !== 'function') return 0;
    let n = 0;
    for (let i = 0; i < ATTRS.length; i++) {
      const spec = ATTRS[i];
      const list = base.querySelectorAll(spec.sel);
      for (let j = 0; j < list.length; j++) {
        const node = list[j];
        const key = node.getAttribute(spec.key);
        if (!key) continue;
        const text = t(key);
        if (spec.attr === 'textContent') {
          if (node.textContent !== text) { node.textContent = text; n += 1; }
        } else if (node.getAttribute(spec.attr) !== text) {
          node.setAttribute(spec.attr, text);
          n += 1;
        }
      }
    }
    return n;
  }

  const api = {
    DICT: DICT,
    t: t,
    setLang: setLang,
    lang: lang,
    has: has,
    missing: missing,
    missingVars: missingVars,
    applyDom: applyDom,
    subscribe: subscribe,
    normalizeLang: normalizeLang,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && window) (window.rmd || (window.rmd = {})).i18n = api;
})();
