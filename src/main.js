// rmd 前端入口 —— 编排：会话 → 侧边栏 → 正文 → 冒烟回报 / 批次 2 测量回报。
//
// # 分批边界（`design/0002` §10.4）
//
// - **批 1**（已完成）：`rmd <文件>` 打开窗口，10 MB 中文文档能显示、能滚动。
// - **批 3 = `design/0003`（已通过）**：文件树侧边栏 + 单文件未授权态。
// - ⭐ **批 2（数字）= 本文件现在这一版**：T4/T5/T5b/T6/T6b + **DOM 节点总数** +
//   残差 `R`，口径见 `design/0002` §7.3。⚠️ **只有在 `RMD_MEASURE=1` 时才回报并退出**；
//   平时那几处 `performance.now()` 照样取（微秒级），但走的是原来的冒烟路径。
//
// # 这个文件里唯一有讲究的三件事
//
// 1. ⭐ **提交点全在 `services/session.js`**，这里只消费它的结论。
//    ⛔ 不在这里写 `if (resp.gen === ...)`——那会变成第二个真值。
// 2. ⭐ **打开文档的路径只从两个地方来**：启动 argv（后端已授权）与
//    树里点的那一项（后端已授权）。⛔ 前端不拼路径、不猜路径（`INV-TREE-01`）。
// 3. ⚠️ **状态条只写后端报回来的 T1/T2/T3**；前端自己的时间线是批 2 的事，
//    它**只从 `report_measure` 走**，⛔ 不混进状态条、⛔ 不与 T1/T2/T3 相加。
// ⚠️⚠️ **每个文件都包一层 IIFE**——这**不是**风格问题，是必须的。
//
// 经典脚本（⛔ 不是 ES module）的顶层 `const` **共用一个全局词法作用域**：
// 两个文件都写 `const api = …`（或 `const V` / `const S` / `const T`）时，
// 后加载的那个文件**整个不执行**（解析期 `SyntaxError`），
// 而错误只出现在 WebView 的控制台里——本项目看不到它。
//
// 表现：**一个永远开着的空白窗口**，stderr 里连一条错误都没有。
// 2026-10-13 实施 `design/0003` 时真踩到了：7 个模块几乎全被
// `const V` / `const api` 撞掉，冒烟挂在那里一动不动。
//
// ⇒ 双导出（浏览器挂 `window.rmd.*` / node 挂 `module.exports`）**必须在 IIFE 里**。
(function () {
  'use strict';

  const S = window.rmd.session;
  /** ⭐ `design/0038`：启动页的**纯逻辑**（行换算 / 数字键 / 五种放行）。
      ⚠️ 加载期取值 ⇒ `services/start.js` 必须排在**本文件之前**（`index.html`，`0009` 同族）。 */
  const ST = window.rmd.start;
  /** ⭐ `design/0038`：启动页的**渲染与局部键盘模型**。⚠️ 同一条加载期纪律。 */
  const SS = window.rmd.startScreen;
  const T = window.rmd.tauri;
  const V = window.rmd.versions;
  const Sidebar = window.rmd.sidebar;
  const FileTree = window.rmd.fileTree;
  /** ⭐ `design/0050`：盘上变更的**前端唯一入口**（两条通道 ＋ 内容修订 ＋ 健康状态）。
      ⚠️ 加载期取值 ⇒ `services/diskevents.js` 必须排在**本文件之前**（`index.html` 已注明）。
      ⛔ **本文件不许再自己 `T.listen('rmd://tree-changed')`**：两条通道各订阅一遍，
      症状是"一次改动列两次"（`tests/js/tree-fresh.test.js` 有源码级判据盯着）。 */
  const DE = window.rmd.diskEvents;
  // ⭐ `design/0041`：文档列表走纯逻辑（`doclists.js`）+ 组件（`DocList.js`）两份，
  //    ⚠️ 加载顺序见 `index.html`（都在 `session.js` 之后）。
  const DL = window.rmd.doclists;
  const DocListUI = window.rmd.docList;
  const ImageView = window.rmd.imageView;
  const Th = window.rmd.theme;
  const ThSw = window.rmd.themeSwitcher;
  const M = window.rmd.measure;
  const K = window.rmd.keymap;
  /** ⭐ `design/0025`：界面文案的**唯一**字典。⚠️ `index.html` 里它是 `services/` 的第一条
      `<script>`（`INV-I18N-06`）；取不到就退化成"整屏 key"这种**看得见**的样子，⛔ 不静默。 */
  const I18N = window.rmd.i18n || null;
  /**
   * ⭐ 取一句界面文案（`design/0025` §2.1）。
   *
   * ⚠️ `I18N` 不在时（`index.html` 少一行 `<script>`）回落成 **key 本身**——
   * 屏幕上会是一串 `status.open-failed` 这样的键名。那不是"优雅降级"，是**看得见的坏**：
   * ⛔ 静默退回中文会让"字典没加载"这件事永远没人发现（`INV-I18N-06`）。
   * ⚠️ **诊断出口不走这里**（§2.2）：`console.error` / `report_status` 的字段留中文，
   * 它们要随日志一起被读，⛔ 不该随用户语言漂移。
   */
  const t = I18N ? I18N.t : function (key) { return key; };
  const Settings = window.rmd.settings;
  /** ⭐ `design/0009` 的文件名搜索浮层。⚠️ 它要用 `Settings` 的覆盖层登记处，
      所以脚本顺序上必须排在 `Settings.js` 之后（`index.html` 里已注明）。 */
  const QuickOpen = window.rmd.quickOpen;
  /** ⭐ `design/0042`：侧边栏底部常驻的文件名搜索（与 `⌘P` 共用同一份匹配实现）。 */
  const SidebarSearchUI = window.rmd.sidebarSearch;
  /** ⭐ `design/0011` 的正文内查找浮层。它要用 `find.js`（判据）、`keymap.js`
      （认 `⌘G`/`⇧⌘G`）与 `Settings` 的覆盖层登记处 ⇒ 脚本顺序排在最后三个之后。 */
  const FindBar = window.rmd.findBar;
  /** ⭐ `design/0018` 的图片缩放预览层。⚠️ 它要用 `Settings` 的覆盖层登记处
      与 `services/imagezoom.js` 的数学 ⇒ 脚本顺序排在两者之后。
      ⭐ **这一层只调一次 `installDelegation`**：事件委托与缩放数学都在
      `ImageViewer.js` / `imagezoom.js` 里，⛔ `main.js` 里没有第二份。 */
  const ImageViewer = window.rmd.imageViewer;
  /** ⭐ `design/0006` 的纯逻辑（闸门 / 事件判据 / 三级滚动锚点）。 */
  const R = window.rmd.reload;
  /** ⭐ `design/0017` 的纯逻辑（形状转换 / 频控 / 恢复三态）。
      ⚠️ 锚点算法仍然只有 `R` 一份——这里只用它做**落盘形状与决策**，
      ⛔ 不在这里解锚点（`P.toAnchor` 只做形状补齐，真正的定位走 `R.resolveAnchor`）。 */
  const P = window.rmd.progress;
  /** ⭐ `design/0020`：目录会话的**全部前端逻辑**（包含判据 / 载荷整形 / 恢复事务 / 写者）。
      ⚠️ 本文件只做**接线**（⛔ 不在这里写恢复或写盘的编排）：
      评审 R3/R5 指出的全是跨 `await` 的时序问题，而 `main.js` **不进 `tests/js/`** ——
      把编排留在这个文件里，等于让那两条缺陷**无法被自动验证**。 */
  const D = window.rmd.dirSession;
  /** ⭐ Q22 的那一句「部分代码未高亮（规模限制）」。⚠️ 它是纯逻辑、**有断言**
      （`tests/js/renderstat.test.js`）——写在这一层的话测试碰不到，
      而它的失效形态是"那一句永远不出现、屏幕上一切正常"。 */
  const RS = window.rmd.renderstat;
  /** ⭐ 2026-10-29 代码评审第 5 条：提交后**整篇重渲**的那一句「本次重渲整篇 N ms」。
      ⚠️ 同 ← `RS` 的纪律：判定与文案**不在这里**（`main.js` 不进 `tests/js/`），
      这一层只负责把这次挂载的耗时喂进去。**加载期取值** ⇒ `services/renderbudget.js`
      必须排在**本文件之前**。 */
  const RB = window.rmd.renderbudget;
  /** ⭐ `design/0012` §11 的左右滚动同步。⚠️ 判据与**接线**都在那一份里
      （⛔ 不在这里再写一遍）——这一层只负责把四个取值器接上去。 */
  const SY = window.rmd.sync;
  /** ⭐ `design/0033`：命令行工具菜单那两步的**结果 → 状态条那句话**（唯一的生成处）。
      ⚠️ 判据与文案都在那一份里（键表 `KEYS` ＋ `summarize`/`render`/`isError`），
      ⛔ 本文件只做接线：拿到载荷 → 重画状态条。**加载期取值** ⇒ `services/clitool.js`
      必须排在**本文件之前**（`0009` 同族）。 */
  const CT = window.rmd.cliTool;

  /**
   * ⭐ `design/0026`：文档内链接的**纯逻辑**（`href` 归一 / 锚点查找 / 结果→动作 / 存活判据）。
   * ⚠️ 它**不判授权、不拼路径**——那两件事只在后端做得到（`INV-LINK-03`）。
   * ⚠️ 加载期取常量 ⇒ `services/links.js` 必须排在**本文件之前**（`index.html`，`0009` 同族）。
   */
  const Links = window.rmd.links;
  /** ⭐ `design/0012` 的编辑区。四个模块各有各的分工，⛔ 别互相代劳：
      · `Ed`      —— CM6 的挂载/销毁 ＋ **扩展白名单** ＋ 脏标记 ＋ 三合一自证；
      · `EdKeys`  —— **转发白名单**（从后端那张表派生）＋ `ctx` 垫片；
      · `EdPrev`  —— 预览的**三档调度状态机**（纯逻辑，⛔ 无 DOM）；
      · `EdSave`  —— 保存的**唯一入口**（纯逻辑，⛔ 无 DOM）。
      ⚠️ 后两个是纯逻辑，产品代码只负责"把 DOM 与 IPC 接上去"——
      这与 `services/reload.js` 的分工是同一条纪律（`design/0002` §7.0：
      只能用真窗口验的东西**不算验证**）。 */
  const Ed = window.rmd.editor;
  const EdKeys = window.rmd.editorKeys;
  const EdPrev = window.rmd.editorPreview;
  const EdSave = window.rmd.editorSave;
  /** ⭐ `design/0014`：编辑态 Vim 键位的**纯装配层**（⛔ 无 DOM、⛔ 无 IPC）。
      ⚠️ 它与上面四个**并列**，⛔ 不是 `Ed` 的一部分——理由见 `0014` §2.4-1：
      装配面与编辑面各自可测，混在一起就变成"要测 `:w` 得先起一个 `EditorView`"。 */
  const EdVim = window.rmd.editorVim;
  /**
   * ⭐ `design/0047`：阅读—编辑连续性（「唯一全文模型 ＋ 单块编辑视图」）。
   *
   * ⚠️ 分工与 `0012` 的 `Ed*` 一族完全同构：**判据与状态机在 `src/live/**`（纯逻辑，
   * `node --test` 跑得到），这里只做真 DOM / CM6 / IPC 的接线**。
   * ⛔ 别把"什么时候提交""身份对不对"写进本文件——`main.js` 不进 `tests/js/`，
   * 写在这里的判据**任何断言都碰不到**（`design/0002` §7.0 那条纪律）。
   *
   * ⚠️ 九个文件**全部在加载期取值** ⇒ `index.html` 里它们必须排在**本文件之前**
   * （`tests/js/keymap.test.js` 的「脚本加载顺序」闸门盯着这一条）。
   */
  const LC = window.rmd.liveController;
  const LB = window.rmd.liveBlocks;
  const LSel = window.rmd.liveSelection;
  /** ⚠️ 全局名是 `liveMarks`（⛔ 不是 `src/live/decorations.js`）——理由写在那份文件的尾部：
      源码级闸门不许**非 `live/**`** 的文件里出现那个 CM6 扩展名的子串。 */
  const LMarks = window.rmd.liveMarks;
  const LIn = window.rmd.liveInput;
  const LA11y = window.rmd.liveA11y;
  const LBox = window.rmd.liveBox;
  /** ⭐ `design/0054`：**编辑对象的策略表**（允许的操作 / 输入约束 / 呈现 / 写回校验）。
      ⚠️ 同一条约束⛔ 不许在本文件里再写一半——粘贴折行、`cellContext`、走格分支全部读它。 */
  const LObj = window.rmd.liveObjects;
  /** ⭐ `design/0049`：表格单元格的纯逻辑（扁平下标 / 写回 / 转义）。 */
  const LCell = window.rmd.liveCell;
  /** ⭐ `design/0051`：任务项方框的纯逻辑（识别 / 块内扁平下标 / 同长度翻转）。 */
  const LTask = window.rmd.liveTask;

  /** ⭐ **批次 2 的测量模式**。由 Rust 侧在注入脚本里写下来（`gui/mod.rs` 的 `init_script`）。
      ⚠️ 前端**不读环境变量**（WebView 里读不到），也⛔ 不靠"有没有传参"来判断。 */
  const MEASURE = !!window.__rmdMeasure;

  /** ⭐ 主题与阅读设置（`design/0004` / `design/0005`）。在 `bootInner` 里建。 */
  let theme = null;
  let themeSwitcher = null;

  /** ⭐ `design/0010`：快捷键分发器与设置覆盖层。在 `bootInner` 里建。 */
  let keymap = null;
  let settings = null;
  /** ⭐ `design/0009`：文件名搜索浮层。在 `setupKeys` 里建（它要 `keymap`）。 */
  let quickOpen = null;
  /** ⭐ `design/0042`：侧边栏底部常驻搜索。同样在 `setupKeys` 里建（它要 `keymap`）。 */
  let sidebarSearch = null;
  /** ⭐ `design/0011`：正文内查找浮层。同样在 `setupKeys` 里建。 */
  let findBar = null;
  /** ⭐ `design/0018`：图片缩放预览层。同样在 `setupKeys` 里建（它要 `Settings` 的登记处）。 */
  let imageViewer = null;
  /**
   * ⭐ `design/0038`：启动页（`#doc` 空态里那张「最近的目录」表）。
   * ⚠️ 在 `bootInner` **最前面**建：`showDocEmpty` 是它的唯一挂载点，而那三个入口
   * 在第 4 步就会调（空会话 / 目录模式）。建晚了的表现是"启动页**永远不出现**"，
   * 而界面上一切正常——那种半残最难发现。
   * ⚠️ 这里传的两个回调都**读 `let`**（`settings`/`quickOpen`/… 此刻还是 `null`），
   * 所以必须是**函数**、⛔ 不能把当时的值抄下来。
   */
  let startScreen = null;
  /** 后端 `get_shortcuts` 返回的**真表**。⚠️ 自检与冒烟回报都要用它。 */
  let shortcutTable = [];
  /**
   * ⭐ `design/0025` §2.4：语言的**偏好**（`system` / `zh` / `en`）。
   *
   * ⚠️ 它与**生效**语言是两件事：偏好 `system` 在中文系统上生效为 `zh`、在英文系统上为 `en`。
   * 设置里那个下拉选的是**偏好**，而界面/菜单用的是**生效**值（由 Rust 裁定一次）。
   * ⚠️ 初值取 `system`（配置里 `None` 就等于它）——**⛔ 不是**"猜一个界面语言"：
   * 真正的生效值由注入脚本的 `window.__rmdLang` 给，快照到了之后再复核一遍。
   */
  let langPreference = 'system';
  /** ⭐ 跨语言自检的结果（§2.1 ② 第三层）。⛔ 只报，⛔ 不改变任何行为。 */
  let actionsCheck = { ok: false, note: '未做' };
  /** ⭐ 菜单事件通道订阅成了吗（§2.1 ⑧）。⚠️ 失败只在控制台里 = 看不见，所以进回报。 */
  let listenCheck = { ok: false, note: '未做' };
  /** ⭐ `design/0011`：正文内查找的**前端自证**结果（§3）。⚠️ 同 `actionsCheck`：只报，不改变行为。 */
  let findCheck = { ok: false, note: '未做' };

  /**
   * ⭐ 从后端那张表里取某个动作的**显示串**（`INV-SET-01`）——⛔ 前端不自己拼键位。
   *
   * ⚠️ 为什么这条要命：空文档页上那句"用 `⌘O` 打开一个目录"是用户**唯一**的引导，
   * 而它手写在字符串里的话，某天键位一改就**静默地说错话**——没有报错、没有日志，
   * 用户按着提示按下去没反应，只会以为软件坏了。
   * ⚠️ 表还没拿到（IPC 失败/ACL 少一条）时返回空串，调用方**要能承受**空串。
   */
  function accelText(id) {
    for (let i = 0; i < shortcutTable.length; i++) {
      if (shortcutTable[i].id === id) return shortcutTable[i].display || '';
    }
    return '';
  }

  /**
   * ⭐ 空会话那两句引导文案。键位**现算**（`accelText`），⛔ 不写死。
   * ⚠️ 表没拿到时退成"不提键位"的说法——**宁可少说，不能说错**。
   */
  function openHint() {
    const dir = accelText('file.open-directory');
    const file = accelText('file.open-file');
    if (dir && file) return t('status.hint-open', { dir: dir, file: file });
    return t('status.hint-open-no-keys');
  }

  function readyHint() {
    const dir = accelText('file.open-directory');
    return t('status.ready', { hint: dir ? t('status.ready-open-dir', { dir: dir }) : t('status.ready-no-table') });
  }

  /**
   * ⭐ 侧边栏那两个图标（收起 `‹` / 展开 `›`）的 **hover 提示里带上键位**。
   *
   * 用户 2026-10-22 点题：「鼠标放到收起/展开图标那里可以展示快捷键，类似 ChatGPT 客户端一样」。
   *
   * ⚠️ 为什么**不能**直接在 `index.html` 的 `title` 里把键写死，也不能靠 `data-i18n-title`：
   *   ① 前端⛔ 不许写键位字面量（`INV-SET-01`，`keymap.test.js` 有一条源码级闸门盯着），
   *      键位只能从后端那张表现取；
   *   ② `data-i18n-title` 由 `applyDom()` 重贴，而它**不做占位符替换**
   *      ⇒ 静态属性只能放纯标签，带 `{key}` 的那句必须在这里现拼。
   *
   * ⭐ 因此本函数有**两个**调用点，缺一个就是静默的半残：
   *   · `setupKeys()` 之后 —— 那时后端那张表才到手（`Sidebar` 建得比它早，
   *     所以 `Sidebar` 自己拼不出来，也⛔ 不该拼）；
   *   · `relabelDynamic()` 里 —— `setLang()` 的顺序是 字典 → `applyDom` → **订阅者**，
   *     不挂在订阅者这一侧，每次换语言都会被 `applyDom` 顶回纯标签（键位无声消失）。
   *
   * ⚠️ 表还没到手（IPC 失败 / ACL 少一条）时 `accelText` 给空串 ⇒ **退成纯标签**：
   *    宁可少说，不能说错（同 `openHint`）。
   */
  function syncSidebarKeyHints() {
    const key = accelText('view.toggle-sidebar');
    const pairs = [
      ['btn-collapse', 'sidebar.collapse', 'sidebar.collapse-key'],
      ['btn-expand', 'sidebar.expand', 'sidebar.expand-key'],
    ];
    for (let i = 0; i < pairs.length; i++) {
      const el = $(pairs[i][0]);
      if (!el) continue;
      el.title = key ? t(pairs[i][2], { key: key }) : t(pairs[i][1]);
    }
  }

  /** ⭐ 批次 2 的测量器。在 `bootInner` 的**第一行**建——T6/T6b 要它从最早一刻起就在听。 */
  let measure = null;

  /** 最近一次打开的各段耗时（前端口径）。⚠️ 只给 `reportMeasure` 用。 */
  let lastOpen = null;

  /** 拿 DOM。⛔ 不用 `innerHTML` 读，也不给正文容器拼字符串。 */
  function $(id) { return document.getElementById(id); }

  // ════════════════════════════════════════════════════════════════════
  // ⭐ 顶栏折叠（`design/0037`，2026-10-23）
  //
  // 用户原话：「这一排的展示应该可以折叠，隐藏。」
  // 折叠掉的是**工具栏 ＋ 状态条**两行，⛔ **不是整个 `.topbar`**——
  // `#reload-bar` / `#preview-bar` / `#edit-prompt` 也住在 `.topbar` 里，
  // 它们承担「降级必须显式告知」（`INV-EXT-04`）与「陈旧必须始终可见」
  // （`INV-EDIT-11`）⇒ 折叠不许把它们一起吞掉（CSS 里逐条点名，见 `style.css`）。
  //
  // ⚠️ 状态**只在内存里**（⛔ 不写 `config.json`）：它是一次阅读里的临时姿态，
  //    不是外观偏好。持久化的代价是"某天重开、顶栏不见了而用户不知道去哪找"——
  //    那正是 `design/0012` §2.1⑤ 警告的那类"隐藏手势"。
  // ⚠️ 编辑态**不许折叠**：那会把「退出编辑」唯一可见的入口藏起来。
  //    入口 = `setChromeHidden()` 里那道拒绝 ＋ `enterEdit()` 里的复位 ＋
  //    `body.editing .chrome-btn` 那条 CSS（三处，缺一处就有一条静默的路）。
  // ════════════════════════════════════════════════════════════════════
  let chromeHidden = false;

  /**
   * 折叠 / 收回顶栏。⭐ **唯一写入口**（工具栏按钮、折叠后的抓手、快捷键都走它）。
   * ⚠️ 直接改 `classList` 的地方只有这一处；`body.chrome-hidden` 是 CSS 认的那个开关。
   */
  function setChromeHidden(next) {
    const on = next === true;
    if (on && editing) return; // 编辑态拒绝（见上面那段）
    chromeHidden = on;
    document.body.classList.toggle('chrome-hidden', on);
    syncChromeHints();
  }

  /**
   * 「隐藏顶栏 / 显示顶栏」两个控件的 `title`（带键位）。
   *
   * ⚠️ 键位**现算**（`accelText`），⛔ 写死——`INV-SET-01` 与
   *    `keymap.test.js` 的源码级闸门盯着这一条。
   * ⚠️ 两个调用点，与 `syncSidebarKeyHints` 同形：`setupKeys()` 之后（表才到手）
   *    与 `relabelDynamic()`（换语言会把 `title` 顶回纯标签）。
   */
  function syncChromeHints() {
    const key = accelText('view.toggle-chrome');
    const pairs = [
      ['chrome-hide', 'toolbar.hide-chrome', 'toolbar.hide-chrome-key'],
      ['chrome-grip', 'toolbar.show-chrome', 'toolbar.show-chrome-key'],
    ];
    for (let i = 0; i < pairs.length; i++) {
      const el = $(pairs[i][0]);
      if (!el) continue;
      el.title = key ? t(pairs[i][2], { key: key }) : t(pairs[i][1]);
    }
  }

  /** 顶栏折叠的接线。⚠️ 在 `setupKeys()` 之后调一次（那时键位才拿得到）。 */
  function setupChrome() {
    const hide = $('chrome-hide');
    if (hide) hide.addEventListener('click', function () { setChromeHidden(true); });
    const grip = $('chrome-grip');
    if (grip) grip.addEventListener('click', function () { setChromeHidden(false); });
    syncChromeHints();
  }

  /** 字节数 → 人读得懂的单位。只用于状态条。 */
  function humanBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /** ⭐ 状态条那一行的"重画配方"（`design/0025` §2.5.1 ②）。`null` = 重画不出来。 */
  let statusRepaint = null;
  let statusIsError = false;
  /** ⭐ 编辑提示带上那行的"重画配方"（`design/0025` §2.5.1 ②）。 */
  let editNoteRepaint = null;
  /** ⭐ 正文区空态那一句的"重画配方"。 */
  let docEmptyRepaint = null;

  /**
   * 状态条上的一行字。⛔ 不写进正文容器——正文里必须是**纯渲染结果**。
   *
   * ⭐ `design/0025` §2.5.1 ②：换语言后那一行要能**重画**，所以同时记下"它当初是
   * 怎么算出来的"（`statusRepaint`）。用原文调它的调用方（诊断串、拼好的整句）
   * 一律把 recipe 清掉——那种行重画不出来，也不该假装能。
   */
  function setStatus(text, isError) {
    statusRepaint = null;
    statusIsError = !!isError;
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('status-error', !!isError);
  }

  /** ⭐ 按字典键写状态条，并**记下重画的方法**（§2.5.1 ②）。 */
  function setStatusT(key, vars, isError) {
    setStatus(t(key, vars), isError);
    statusRepaint = function () { return t(key, vars); };
  }

  /** ⭐ 传一个**返回整句**的函数（文档摘要那种），同样记下来供换语言时重画。 */
  function setStatusFn(fn, isError) {
    setStatus(fn(), isError);
    statusRepaint = fn;
  }

  /**
   * 正文区的空态（打开目录但还没选文件时）。⛔ 不自动打开第一个文件（§2.1）。
   *
   * ⭐ `design/0038` §2.1 ②：这个函数是启动页的**唯一**挂载点（`INV-START-01`）。
   *    ⚠️ 三个入口（直接调 / `showDocEmptyT` / `showDocEmptyFn`）都经过这里
   *    ⇒ ⛔ 别在别处往 `#doc` 里塞 `.start-list`。有正文时那张表必须**不存在**：
   *    `openDocument` 用 `doc.innerHTML = …` 整块换掉，表会被冲掉没错，但**在那之前**
   *    用户看到的是"正文与一屏最近目录并存"。
   *    ⚠️ `recent` 为空时 `SS.render` 什么都不画 ⇒ 与今天**逐字节相同**（只有那句话）。
   *    ⚠️ 重画（换语言 / 再进空态）会**先摘旧监听再挂**——`SS` 内部记账，这里不用管。
   */
  function showDocEmpty(text) {
    docEmptyRepaint = null;
    const doc = $('doc');
    doc.textContent = '';
    const box = document.createElement('div');
    box.className = 'doc-empty';
    // ⚠️ 提示语包一层 `<div>`（而不是继续 `box.textContent = text`）：启动页要**追加**进来，
    //    而 `textContent = …` 之后再 appendChild 会让那句话留在同一个文本节点里、
    //    无法与列表分块（`.doc-empty` 现在是"一句话 ＋ 一张表"）。
    const line = document.createElement('div');
    line.className = 'doc-empty-text';
    line.textContent = text;
    box.appendChild(line);
    doc.appendChild(box);
    // ⭐ 启动页（`design/0038`）。⚠️ 数据**只来自快照**（`S.state.recent`）——
    //    ⛔ 不在这里从 `dirSession` / `reading_progress` 再推一份（`INV-START-05`）。
    //    ⭐ `design/0043` §2.6：收藏段同样只读快照（`S.state.favorites`）。
    if (startScreen) startScreen.render(box, S.state.recent, S.state.favorites);
    doc.setAttribute('aria-busy', 'false');
  }

  /** ⭐ 空态那句也按字典键现翻（换语言要跟着变）。 */
  function showDocEmptyT(key, vars) {
    showDocEmpty(t(key, vars));
    docEmptyRepaint = function () { return t(key, vars); };
  }

  /** ⭐ 传一个**返回整句**的函数（空会话那句引导里有**现算的键位**）。 */
  function showDocEmptyFn(fn) {
    showDocEmpty(fn());
    docEmptyRepaint = fn;
  }

  /**
   * ⭐ `design/0043` §2.6：收藏增删/重排之后**重画启动页**。
   *
   * ⚠️ 只重画"**正挂着**"的时候（`visible()`）——否则会把空态那句提示重新贴到
   *    一次本来没有空态的界面上（`INV-START-01`：启动页只活在 `#doc` 的空态里）。
   * ⚠️ 配方（`docEmptyRepaint`）必须**取出来再放回去**，理由与 `relabelDynamic` 同一条：
   *    `showDocEmpty` 开头会把它清空。
   */
  function repaintStart() {
    if (!startScreen || !startScreen.visible()) return;
    if (!docEmptyRepaint) { showDocEmpty($('doc').textContent || ''); return; }
    const recipe = docEmptyRepaint;
    showDocEmpty(recipe());
    docEmptyRepaint = recipe;
  }

  /**
   * ⭐ 换语言后把**由 JS 现写**的那几块重画一遍（`design/0025` §2.5.1 ③）。
   *
   * ⚠️ `applyDom` 只够得到 `index.html` 里带 `data-i18n*` 的静态节点；
   * 状态条、空态、重载条、决策条、编辑按钮这几处是 JS 写的 ⇒ 它们**只能**靠订阅者。
   */
  function relabelDynamic() {
    if (statusRepaint) setStatusFn(statusRepaint, statusIsError);
    // ⚠️ 先把配方取出来再重画：`showDocEmpty` 开头会把它清空（那是给"用原文直接调"的
    //    调用方准备的），于是**第二次**换语言时 `docEmptyRepaint` 已经是 `null`，
    //    空态那句话（`design/0038` 起还有启动页的标题/标记）就永远停在旧语言。
    //    ⭐ 这是 `0038` 实施时发现的既有缺陷：只有换过两次语言才看得见。
    const emptyRepaint = docEmptyRepaint;
    if (emptyRepaint) {
      showDocEmpty(emptyRepaint());
      docEmptyRepaint = emptyRepaint;
    }
    if (editNoteRepaint) setEditNote(editNoteRepaint());
    syncReloadBar();
    syncEditToggle();
    syncEditPrompt();
    // ⭐ 收起 / 展开那两个图标的 tooltip（标签 + 键位）必须在这里重拼一次：
    //    `applyDom()` 只会把它顶回纯标签（它不做占位符替换）。
    syncSidebarKeyHints();
    // ⭐ `design/0037`：顶栏折叠那两个控件同理（同一条理由，同一处）。
    syncChromeHints();
    // ⭐ `design/0041`：形态按钮的文案/`title`/`aria-label` 是 JS 贴的，
    //    `applyDom()` 只会顶回出厂那句 ⇒ 换语言时必须在这里重贴一次。
    if (sidebar) sidebar.relabelFileView();
  }

  /**
   * 🗂 目录模式下**必须**给状态条一句话。
   *
   * ⚠️ `index.html` 里状态条的初值是「加载中…」，而目录模式下**没有** `open_document`
   * 会去改它 ⇒ 不在这里补一句，用户看到的是一个**永远停在「加载中…」**的状态条。
   * 2026-10-13 冒烟实测到：`侧边栏=directory` 而 `状态条：加载中…`。
   * 它不违反任何不变量，但会让人以为"还在加载"而一直等——正是最不该有的那种假象。
   */
  function setDirectoryStatus() {
    const st = S.state;
    const roots = st.roots || [];
    const root = roots.length ? String(roots[0]) : '';
    const name = root.split('/').filter(Boolean).pop() || root;
    setStatusT('status.dir-opened', { name: name, roots: roots.length, gen: st.generation });
  }

  let sidebar = null;
  let tree = null;
  /** 上一次渲染侧边栏时的根目录与代次，用来判断"要不要重扫"。 */
  let lastRoot = null;
  let lastGen = -1;

  // ⭐ `design/0020` 的两个协调器（在 `bootInner` 里建，因为要 `tree`）。
  // ⚠️ 编排**全在 `services/dirsession.js`**；这里只持有引用并接线（`G4`：⛔ 没有 `writeDirSession`）。
  /** 恢复事务：`run()` / `cancel(reason)` / `noteUserToggle()`。 */
  let dirRestorer = null;
  /** 写者：`noteTreeChange()` / `noteDocOpen()` / `flush()`。去抖窗口是它的常量，⛔ 这里不另存一份。 */
  let dirWriter = null;

  // ── ⭐ 侧边栏形态与文档列表（`design/0041`）──────────────────────────────
  /**
   * 文档列表实例（`components/DocList.js`）。
   * ⚠️ 它**不是**"列表形态才存在"：树形态下"隐藏空目录"也要那份清单的 `keep_dirs`
   * ⇒ 只把 `setActive(false)`（不画 DOM），⛔ 不销毁——否则切一次形态就重扫一遍盘。
   */
  let docList = null;
  /**
   * 树过滤的判据集合（来自最近一份**已通过判据**的清单）。
   * `null` = 还没就绪或已换根 ⇒ 树**照旧全显示**（R1：未知一律保留）。
   */
  let keepDirs = null;
  /** ⭐ 本次会话**新建**的目录（R4 的临时例外；换根清空、⛔ 不落盘）。 */
  const recentCreated = new Set();
  /** 清单该不该重拉（换根 / 不可见期间盘上变了 / 刚建实例）。 */
  let docListDirty = true;
  /** 树监视事件后的去抖重建定时器。 */
  let docListTimer = 0;
  /** 清单在树不可见时到过 ⇒ 切回文件页要补一次刷新事务。 */
  let treeFilterStale = false;

  // ════════════════════════════════════════════════════════════════════
  // ⭐ 自动重载的运行时状态（`design/0006` §2.1 ④⑤⑥）
  //
  // ⚠️ 这里**只有**运行时状态（计时器 / 在途标志 / 一条提示文案）。
  //    "哪份文档、哪个监视代号"的真值**全在 `session.js`**——
  //    ⛔ 别在这儿再存一份"我以为在显示什么"，那正是 §2.1.2 (5) 拒绝的第二个真值。
  // ════════════════════════════════════════════════════════════════════

  /** debounce 计时器。⚠️ 收到**每一条**事件都要重置它（见 `onDocumentChanged`）。 */
  let reloadTimer = null;
  /** 一次重载还在路上。⛔ 不许叠加第二次——那会让两次读盘抢同一个 DOM。 */
  let reloadInFlight = false;
  /** 降级提示的文案（`null` = 没有要提示的）。由闸门写入，由重载/换文档清掉。 */
  /**
   * 重载提示条上那句待显示的话。
   *
   * ⚠️ 存的是**键 + 参数**不是译文（`design/0025` §2.5.1 ②）：这条带子可能挂很久
   * （直到用户手动重载），期间切一次语言，存译文就会把它冻在旧语言里。
   */
  let pendingNotice = null;
  let pendingNoticeVars = null;

  /**
   * ⭐ **通道**订阅成了吗（`rmd://document-changed`）。
   *
   * ⚠️ 它与 `S.state.watchNote` 是**两件事**，⛔ 不合并：
   * `watchNote` 说的是"这个**文件**监视不起来"（后端 `watch_document` 的结果），
   * 这里说的是"这个**事件通道**收不到"（ACL 少了 `core:event:allow-listen`）。
   * 两者都会让自动刷新不工作，但**修法完全不同**——
   * 合成一条的话，排查的人会先去看文件权限。
   */
  let watchListenOk = false;
  let watchListenNote = '';
  /** ⭐ `watchListenNote` 里的**原始原因**（可见那半按 key 现翻，见 `syncReloadBar`）。 */
  let watchListenArg = '';

  // ════════════════════════════════════════════════════════════════════
  // ⭐ 窗口内编辑的运行时状态（`design/0012`）
  //
  // ⚠️ 与上面那段同一条纪律：这里**只有**运行时状态（挂载出来没有、脏不脏、
  //    待决问题是什么）。"目标文件是谁、基线是什么、授权还在不在"的真值
  //    **全在后端**（`commands/edit.rs`）—— ⛔ 别在这儿再存一份"我以为在编辑什么"。
  // ════════════════════════════════════════════════════════════════════

  /** 现在是编辑态吗。⚠️ 它**跟随** `body.editing` 那个类，⛔ 别让两者各自为政。 */
  let editing = false;
  /** `Ed.createEditor` 的产物（挂载/销毁/脏标记/取文本）。 */
  let editor = null;
  /** `EdSave.createSaver` 的产物——⭐ **唯一的保存入口**（`INV-EDIT-10`）。 */
  let editorSave = null;
  /** `EdPrev.createScheduler` 的产物（三档调度、单飞、陈旧）。 */
  let editorPreview = null;
  /** 最近一次 `begin_edit` 的 `EditGrant`（`envelope` 给的是行尾/BOM 的事实）。 */
  let editGrant = null;
  /** ⭐ `ctx.editable()` 垫片（§2.3-5）。⚠️ 它必须**注入** `createKeymap`，见 `setupKeys`。 */
  let forwardShim = null;
  /** 转发白名单的 CM6 扩展。⚠️ 每次 `mount` 都要**重建**（扩展是绑在 state 上的）。 */
  let forwardExt = null;
  /** ⭐ 转发白名单的**派生自检**（§2.3-6）：翻不出来的项必须**响亮报**，⛔ 不许静默。 */
  let forwardCheck = { ok: false, note: '未做', skipped: [], notes: [] };
  /** ⭐ 三合一自证（`Ed.selfTest`）——它是 `edit_ok` 的**唯一**生产者。 */
  let editSelfCheck = { ok: false, note: '未做' };
  /** 脏标记的**镜像**（真源在 `editor` 那个实例上；这里只为回报与决策条）。 */
  let editDirty = false;
  /** 最近一次保存的结果（回报用）。⛔ 不参与任何判断。 */
  let editLastSave = null;
  /** 待决问题的内容（`null` = 没有）。⚠️ 由 `askEdit` 写、由按钮**自己**清。 */
  let editPromptState = null;
  /** ⭐ `save_document` 的 `req` 计数器（**第五个**计数器，只服务保存这一条路）。 */
  let editReqSeq = 0;
  /** 用户对"外部改动 ∧ 脏"表过态之后就不再自动弹（换文档/重新进编辑态时复位）。 */
  let externalChangeSettled = false;

  // ════════════════════════════════════════════════════════════════════
  // ⭐ 阅读—编辑连续性的运行时状态（`design/0047`）
  //
  // ⚠️ 与上面两段同一条纪律：这里只有**运行时**的东西（控制器实例 / 块↔节点的对齐表 /
  //    离屏视图句柄）。"全文是什么、改到哪一步了"的真值在 `src/live/index.js`，
  //    ⛔ 别在这儿再存一份"我以为全文是什么"。
  // ════════════════════════════════════════════════════════════════════

  /** `LC.createController` 的产物。⚠️ **整个进程只建一次**（它跨块、跨提交活着）。 */
  let live = null;
  /** 块 ↔ `#doc` 顶层子节点的对齐结果（`LB.align` 的 `slots`）。每次 `mountDocument` 重算。 */
  let liveSlots = [];
  /** 对齐失败的原因（非空 ⇒ ⛔ 不进编辑态，`INV-LIVE-06`）。 */
  let liveAlignIssues = [];
  /** 当前活动块的辅助技术通告面（`LA11y.attach` 的返回值）；`null` = 没有活动块。 */
  let liveAnnouncer = null;
  /** ⭐ `save_document` 的**第六个**计数器（只服务 live 这一条路；与 `editReqSeq` 分开）。 */
  let liveSaveReq = 0;

  // ════════════════════════════════════════════════════════════════════
  // ⭐ 阅读进度的运行时状态（`design/0017` §2.3 ③④⑤）
  //
  // ⚠️ 与上面两段同一条纪律：这里只有**运行时**的东西（计时器 / 上次写成的基线 /
  //    一份还没兑现的恢复意图）。**恢复表本身在 `S.state.readingProgress`**，
  //    真值在 `config.json`——⛔ 别在这儿再存第三份"我以为进度是什么"。
  // ════════════════════════════════════════════════════════════════════

  /** 停止滚动后那一次延时写盘的计时器。 */
  let progressTimer = null;
  /** `real_path -> {entry, at, persisted}`：同一路径的**写入基线**（频控与去重用）。 */
  const lastAppliedByPath = new Map();
  /**
   * 一份**还没兑现**的恢复意图（`design/0017` §2.3 ⑤）。
   *
   * ⚠️ 它存在的原因是**图片**：挂完 DOM 的那一刻页面可能还比视口短
   * （图还没解码、`scrollHeight` 是小的），这时滚不动 ⇒ 意图先存着，
   * 等 `ImageView` 报"落定"再兑现。⛔ 直接放弃就是"打开大图文档永远回到顶部"。
   */
  let pendingRestore = null;
  /** ⭐ **挂载代号**：每次 `mountDocument` +1。⚠️ 它是"迟到回调"的第一道闸。 */
  let mountGen = 0;
  /** 切换/隐藏/退出前的冲刷最多等这么久（§2.3 ④）——⛔ 不许让一次写盘拖住切换。 */
  const FLUSH_TIMEOUT_MS = 400;
  /** 恢复意图的有效期（§2.3 ⑤）。过了就作废，⛔ 不许无限期地抢滚动位置。 */
  const RESTORE_EXPIRES_MS = 10000;

  // ════════════════════════════════════════════════════════════════════
  // ⭐ **左右滚动同步**（`design/0012` §11，`INV-EDIT-13`/`INV-EDIT-14`）
  // ⚠️ 判据、折线、来源闸、监听与观察器**全在 `services/sync.js`**——
  //    这里只有"把四个取值器接上去"与两个生命周期钩子。理由见该文件头：
  //    写在这一层的东西**任何断言都碰不到**（`main.js` 不进 `tests/js/`）。
  // ════════════════════════════════════════════════════════════════════
  /** `SY.createDriver` 的产物。⚠️ **每次进编辑态重建**——它记着来源闸与折线。 */
  let syncDriver = null;
  /**
   * ⭐ **缓冲是否领先于预览**（§11.7）。
   *
   * ⚠️⚠️ 这就是"不得把旧行号映射当作当前精确位置使用"那一条的落点，而且是**唯一**一处：
   *    折线的锚点 = 后端 `toc[].line`（属于**上一次渲染的那份文本**）
   *    ＋ 右侧 DOM 里标题的位置（同一次渲染）。缓冲一领先，`toc` 的行号
   *    就**不再是当前源码的行号** ⇒ 那一对锚点已经不是同一个东西的位置了
   *    ⇒ 折线**降级成按比例**（`sync.js` 只管降级，判这条的是这里）。
   * ⚠️ 它**刻意不用** `editorPreview.stale()`：调度器在刚进编辑态时 `renderSeq = -1`，
   *    那个函数会答 `true`——而那一刻挂着的 DOM **正是当前文本渲的**（刚 `begin_edit`）。
   *    拿它当判据会把"刚进来"误判成"预览过期"。
   */
  let syncTextAhead = false;
  /**
   * ⭐ **观察器看不见的那几种布局变化**的登记处（`syncStart` 里的 `onChange` 往里塞，
   *    `setupEditSplitter` 的拖动钩子往外叫）。
   *    ⚠️ 是一条**模块级**的短表，不是第二个真值：它只转告"可能变了"，
   *    真正重建折线的仍是 driver 那一个 `schedule()`。
   */
  const syncLayoutHooks = [];

  /**
   * ⭐ 源码行号 → 源码栏的**内容坐标**（`design/0012` §11.3 第 2 步）。
   *
   * ⚠️ 换算本身在 `sync.js::sourceLineTopOf`（⛔ 不在这儿再写一遍）——
   *    那是 §11 唯一"押在 CM6 行为上"的假设，而 `main.js` **不进 `tests/js/`**
   *    ⇒ 写在这一层就没有断言，离屏探针也没法用同一份。
   *    这里只负责一句"视图在不在"。
   */
  function sourceLineTop(line) {
    const v = (editing && editor && editor.isMounted()) ? editor.raw() : null;
    return v ? SY.sourceLineTopOf(v, line) : null;
  }

  /** ⭐ 源码栏的**滚动容器**。⚠️ CM6 的 `scrollDOM`，⛔ 不是 `#editor` 那个外框。 */
  function syncSrcElement() {
    if (!editing || !editor || !editor.isMounted()) return null;
    try {
      const v = editor.raw();
      if (v && v.scrollDOM) return v.scrollDOM;
    } catch (e) { /* 视图拆到一半 ⇒ 当作没有 */ }
    try { return editor.scrollDOM() || null; } catch (e) { return null; }
  }

  /**
   * ⭐ 预览栏的滚动容器。
   *
   * ⚠️⚠️ **必须经 `scrollHost()` 判**（⛔ 不自己写一句 `editing ? $('doc') : null`）——
   *    「右栏的滚动容器是谁」在整个前端**只有一处判定**，而那正是 `design/0012`
   *    §11.6 点名的「⛔ 抄一份就是缺陷」。抄一份的失败形态是**静默的**：
   *    两边哪天不一致（比如编辑态改成用别的最外层容器），同步就会去驱动一个看不见的元素。
   * ⚠️ 阅读态 `scrollHost()` 给的是 `window`，而同步**只在编辑态**跑
   *    ⇒ 回落成 `null`（driver 见到 `null` 就只挂监听、不驱动，
   *    ⛔ 不会跑去写窗口的滚动位置）。
   */
  function syncDstElement() {
    const h = scrollHost();
    return (h && h !== window) ? h : null;
  }

  /**
   * ⭐ **进出编辑态时挂/拆**（§11.6）。
   *
   * ⚠️ 只在**编辑态**才有两个可比的滚动容器——阅读态那一栏是 `window`，
   *    而 §11.2 说的"另一侧"根本不显示（预览栏就是正文本身）。
   * ⚠️ 每次都是**新建**一个 driver：它握着来源闸与折线，跨会话复用会带着
   *    上一次的"来源"与一份**属于上一份文档**的折线。
   */
  function syncStart() {
    if (syncDriver) { syncDriver.stop(); syncDriver = null; }
    if (!SY || typeof SY.createDriver !== 'function') return;
    syncTextAhead = false;
    syncDriver = SY.createDriver({
      src: syncSrcElement,
      dst: syncDstElement,
      lineTop: sourceLineTop,
      toc: function () { const doc = S.state.currentDoc; return (doc && doc.toc) || []; },
      headingTops: headingPositions,
      /** ⚠️ **符号是反的**：`fresh` 问的是"挂着的渲染还对不对得上当前源码"。 */
      fresh: function () { return !syncTextAhead; },
      /**
       * ⭐ 观察器**看不见**的那几种布局变化。
       * ⚠️ 字号 / 内容宽 / 行高改的是**内容的尺寸**，两个滚动容器自己的盒子
       *    被网格拉着不变 ⇒ `ResizeObserver` **一次都不响**。
       *    分栏拖动同理（源码栏变宽，但它的 `clientHeight` 没动，横向不滚）。
       *    ⇒ 这四种都得**显式**告诉它。⛔ 不是"多此一举"——
       *    漏了这一条的形态是"改了字号之后同步就偏了，屏幕上一点异常都没有"。
       */
      onChange: function (cb) {
        const 退订表 = [];
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('resize', cb);
          退订表.push(function () { window.removeEventListener('resize', cb); });
        }
        if (Th && typeof Th.subscribe === 'function') {
          退订表.push(Th.subscribe(function () { cb(); }));
        }
        syncLayoutHooks.push(cb);
        退订表.push(function () {
          const i = syncLayoutHooks.indexOf(cb);
          if (i >= 0) syncLayoutHooks.splice(i, 1);
        });
        return function () { for (let i = 0; i < 退订表.length; i++) 退订表[i](); };
      },
    });
    syncDriver.start();
  }

  /**
   * ⭐ 分栏拖动时也要重建（`setupEditSplitter` 调它）。
   * ⚠️ `mousemove` 一秒钟能来几百次 ⇒ 这里**只转告**，合流由 driver 的 rAF 做。
   */
  function syncAfterLayoutChange() {
    for (let i = 0; i < syncLayoutHooks.length; i++) {
      try { syncLayoutHooks[i](); } catch (e) { /* ⚠️ 一个钩子抛错不该挡住其余 */ }
    }
  }

  function syncStop() {
    if (syncDriver) { syncDriver.stop(); syncDriver = null; }
    syncTextAhead = false;
  }

  /**
   * ⭐ 回报用（`report_status` 的 `sync_state`，`make smoke` 打成 `滚动同步：` 一行）。
   *
   * ⛔ 产品逻辑不许拿它做判断。
   * ⚠️⚠️ 它**正常就是「编辑态未起」**——冒烟窗口里没人进编辑态（见本文件
   *    `report()` 里"为什么不让冒烟去按键"那一段），而它⛔ **不参与 `pass`**。
   *    ⭐ 它存在的理由是"接上了没有"这件事**能直接读**：进编辑态之后它是
   *    `精确｜锚点 7/7｜折线 7｜来源 src`；而**接线断了**（`syncDriver` 恒 `null`）
   *    时它照旧是「编辑态未起」⇒ 要和同一份回报里的 `editor_mounted` **对着读**
   *    才分得开。⚠️ 所以它**不是**一条判据。
   */
  function syncState() {
    if (!syncDriver) return '编辑态未起';
    const st = syncDriver.state();
    // ⚠️ 两个锚点数**都报**：`用上/采集`。
    //    某一栏不可滚时 `buildKnots` 会把每个锚点都丢掉（折线退化成一点），
    //    那时只报"采集到 7 个"就是**一句谎**——它会印成「精确」。
    return (st.exact ? '精确' : '按比例') + '｜锚点 ' + st.used + '/' + st.anchors +
      '｜折线 ' + st.knots + '｜来源 ' + (st.origin || '无');
  }

  /** 状态条之外的**第二行**提示（`INV-EXT-04`：降级必须显式告知）。 */
  function syncReloadBar() {
    const bar = $('reload-bar');
    const text = $('reload-text');
    const btn = $('reload-now');
    if (!bar) return;
    const st = S.state;
    // ⚠️ 顺序有讲究：**闸门那条提示**只在监视还活着时才有意义——
    //    监视都没了，"立即重载"这个按钮就成了一个通往 `stale` 的按钮。
    if (pendingNotice && st.watchSeq !== 0) {
      text.textContent = t(pendingNotice, pendingNoticeVars);
      btn.hidden = false;
      bar.hidden = false;
      return;
    }
    // ⚠️ 两种"不工作"共用这一行，但文案各自说明是哪一种。
    // ⭐ `design/0025` §2.2 一料两出口：`state.watchNote` / `watchListenNote` 是**诊断**
    //    文案（进 `report_status` 的 `watch_note`，`make smoke` 按它取数，⛔ 不能随语言漂），
    //    屏幕上这一行按 key 现翻。
    const note = st.watchNoteKey
      ? t(st.watchNoteKey, { note: st.watchNoteArg })
      : (watchListenNote ? t('reload.watch-unavailable', { note: watchListenArg }) : '');
    if (note) {
      text.textContent = note;
      btn.hidden = true;
      bar.hidden = false;
      return;
    }
    bar.hidden = true;
  }

  /**
   * ⭐ `design/0050` §2.3.4 / `INV-DISK-06`：监视**降级必须显式告知**。
   *
   * 判据只有一份（`diskevents.js` 的 `healthOf`），这里只负责画：
   * - 有键 ⇒ 翻字典；**没有键**（后端加了新档而前端没跟上）⇒ 走 `disk.unknown`
   *   并把 `reason` 原文带出来，⛔ 不许静默成"没事"（那正是"监视坏了、界面不吭声"）；
   * - `retry` 为 `false` 的档（`rescan`：临时态，自己会好）⇒ ⛔ 不给按钮，
   *   给了就是让用户去点一个"点了也没用"的按钮。
   *
   * ⚠️ 它住在 `.topbar` 里，而 `body.chrome-hidden` 只点 `.toolbar` / `.status`
   * （`INV-CHROME-01`）⇒ 顶栏折叠时这条提示**照样可见**——降级不是装饰。
   */
  function renderDiskBar() {
    const bar = $('disk-bar');
    if (!bar) return;
    const text = $('disk-text');
    const btn = $('disk-retry');
    const v = DE.state();
    const h = DE.healthOf(v);
    if (!h) { bar.hidden = true; return; }
    const reason = (v && v.reason) || '';
    text.textContent = h.key ? t(h.key) : t('disk.unknown', { reason: reason });
    btn.hidden = !h.retry;
    // ⚠️ 用 class 而不是色值：颜色仍只从语义变量来（`INV-THEME-02`）。
    bar.classList.toggle('disk-bar-warn', !h.transient);
    bar.hidden = false;
  }

  /**
   * 按当前会话状态刷新侧边栏。
   *
   * ⚠️ 它**只**管侧边栏与正文区的空态，⛔ **绝不动已经挂上去的正文**——
   * 目录失效 / 授权被收回时，用户正在读的内容不应该消失（§6 的失败模型
   * 第 3 条：目录失效不把正在读的文档一起清掉）。
   */
  async function renderSidebar() {
    const st = S.state;
    const dirRoot = st.roots.length > 0 ? st.roots[0] : null;

    if (st.mode === 'directory' && dirRoot) {
      // ⭐ `design/0042`：目录模式才有东西可搜 ⇒ 底部搜索框出现（单文件 / 空会话没有索引）。
      if (sidebar) sidebar.setSearchAvailable(true);
      // ⭐ `design/0044`：根头承认"当前根是哪个目录"。⚠️ 每趟都贴（它只是几个属性，
      //    不重画外层）——换根那条分支之外还有"同一根但名字变了"（改名/软链）的情形。
      if (sidebar) sidebar.setRootHeader(dirRoot);
      // 目录模式：树视图。⚠️ 代次变了才重扫（切根 / 收回授权后）
      if (dirRoot !== lastRoot || st.generation !== lastGen) {
        lastRoot = dirRoot;
        lastGen = st.generation;
        // ⭐ `design/0041`：**换根必须先把清单判据清掉**——上一份 `keep_dirs`
        //    里全是旧根的路径，拿它过滤新根会把**每一个目录**都藏掉。
        //    R4：新建目录的临时例外也是**按根**的，一起清。
        keepDirs = null;
        recentCreated.clear();
        docListDirty = true;
        treeFilterStale = false;
        await tree.showRoot(dirRoot);
        // ⭐ `design/0020`：**目录被授权的那一刻**恢复上次的文件与展开态
        //    （⛔ 不是进程启动时——那时根本没有授权，`INV-FS-03`）。
        //    ⚠️ 必须 `await`：它可能顺手打开一份文档，而紧接着的定位要看到
        //    `st.currentPath` 已经变成那一份。判据（幂等 / 取消 / 时序）全在
        //    `dirsession.js::createRestorer` 里，⛔ 这里不判。
        if (dirRestorer) await dirRestorer.run();
        // ⚠️ 定位**不 await**（它可能要读好几层盘）：侧边栏该画完就画完。
        //    错误由 `revealInTree` 自己讲出来（它不抛）。
        if (st.currentPath) revealInTree(st.currentPath);
      }
      // ⭐ `design/0041`：形态与清单。⚠️ 排在 `showRoot` 之后——
      //    树先把"全显示"的一版画出来（R1：清单没就绪时未知一律保留），
      //    清单到达后由 `onDocListResult` 触发**一次既有刷新事务**把空目录收掉。
      await applySidebarView(false);
      return;
    }

    // ⭐ **空会话**（`rmd` 裸跑）：既没有授权也没有文档。
    // ⚠️ 这一支**必须**排在未授权态之前——否则空会话会被画成"未授权态"，
    //    而那个界面是给**单文件模式**用的：它会显示「所在目录：（未知）」，
    //    那是在解释一个根本不存在的东西（§2.1.4 的未授权态不是"欢迎页"）。
    if (st.mode === 'empty' && !st.currentDoc) {
      lastRoot = null;
      lastGen = st.generation;
      tree.reset(null);
      // ⭐ `design/0042`：没有目录就没有可搜的索引 ⇒ 搜索框收起，**并清掉**在途查询。
      hideSidebarSearch();
      // ⭐ `design/0041`：没有 root 就没有可列的东西 ⇒ 实例连同判据一起收掉
      //    （⛔ 留着只会让下一次进目录拿旧 `keep_dirs` 过滤新根）。
      destroyDocList();
      sidebar.showNoDirectory({ lastDirectory: st.lastDirectory });
      return;
    }

    // 单文件模式（或目录被收回）→ ⭐ **未授权态**：显式的说明 + 按钮，
    // ⛔ 不是一个"看起来像树、但只有一项"的残缺树（§2.1.4 的禁止呈现）。
    lastRoot = null;
    lastGen = st.generation;
    tree.reset(null);
    // ⭐ `design/0041`：单文件模式同样没有 root（`roots` 已清）⇒ 清单收掉。
    destroyDocList();
    // ⭐ `design/0042`：同样没有索引 ⇒ 搜索框收起并清掉在途查询。
    hideSidebarSearch();
    const file = st.currentDoc ? baseName(st.currentDoc.real_path) : (st.startupDocument ? baseName(st.startupDocument) : null);
    sidebar.showUnauthorized({
      directory: st.pendingDirectory || dirOf(st.startupDocument),
      file: file,
      filePath: st.currentDoc ? st.currentDoc.real_path : st.startupDocument,
    });
  }

  function baseName(p) {
    if (typeof p !== 'string') return '';
    const parts = p.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : p;
  }

  function dirOf(p) {
    if (typeof p !== 'string') return null;
    const i = p.lastIndexOf('/');
    return i > 0 ? p.slice(0, i) : null;
  }

  // ════════════════════════════════════════════════════════════════════
  // ⭐ 侧边栏形态与文档列表（`design/0041`）
  //
  // 分工：判据在 `services/doclists.js`、渲染在 `components/DocList.js`，
  // **这里只做编排**（什么时候拉、什么时候通知树、什么时候承认一个形态）。
  // ════════════════════════════════════════════════════════════════════

  /**
   * ⭐ **当前这一刻真的该显示的形态**。
   *
   * ⚠️ 目录模式之外一律按树画：未授权态与空会话的入口都长在 `#pane-tree` 里，
   * 而列表形态对着一个没有 root 的会话没有任何可列的东西（会是一块空白）。
   * 偏好本身**不改**——下次进目录仍然按用户选的那个形态显示。
   */
  function effectiveFileView() {
    const st = S.state;
    if (st.mode !== 'directory' || !st.roots || st.roots.length === 0) return 'tree';
    return st.sidebarFileView === 'list' ? 'list' : 'tree';
  }

  /** 建（或取）列表实例。⚠️ 只建一次；形态切换复用同一份清单。 */
  function ensureDocList() {
    if (docList) return docList;
    docList = DocListUI.createDocList({
      host: $('pane-doclist'),
      // 与树完全同一条打开路径（`openDocument` 会过授权与版本判据）
      onOpenFile: function (path) {
        openDocument(path).then(function (p) { if (p) renderSidebar(); });
      },
      onResult: onDocListResult,
      onError: function (e) { console.warn('文档列表出错：', e); },
      // ⚠️ 键位显示字形**现取**（`INV-SET-01`：前端源码里⛔ 不出现按键字面量）
      keyText: accelText,
    });
    docListDirty = true;
    return docList;
  }

  /**
   * ⭐ 一份清单**通过判据**之后（`design/0041` §2.2）。
   *
   * ⚠️ 树不可见时只记"该刷了"，⛔ 不在后台把它重建一遍——树可能正被用户
   * 翻在很深的位置，而无人在看（R5 的脏标记）。
   */
  function onDocListResult(_result, dirs) {
    keepDirs = dirs;
    docListDirty = false;
    if (!S.state.hideEmptyDirs) return;
    if (sidebar && sidebar.fileView() === 'tree' && sidebar.isFilesVisible()) {
      treeFilterStale = false;
      if (tree) tree.refreshVisible();
    } else {
      treeFilterStale = true;
    }
  }

  /**
   * ⭐ 承认当前形态：切面板、按需拉清单。
   *
   * @param {boolean} [rebuild] 强制重建索引（换根 / 树事件之后 / 人工刷新）
   */
  async function applySidebarView(rebuild) {
    if (!sidebar) return;
    const view = effectiveFileView();
    sidebar.setFileView(view);
    // ⭐ `design/0041` R4：从列表切回**树** ⇒ 补做那次**刻意没消费**的展开恢复。
    //    ⚠️ 判据与"只做一次"都在协调器里（`treeRestorePending === generation`），
    //    ⛔ 这里不另存一个"上次是什么形态"。
    //    ⚠️ **不 await**：它可能要读好几层盘，而侧边栏该画完就画完。
    if (view === 'tree' && dirRestorer) {
      Promise.resolve(dirRestorer.restorePendingTree()).catch(function (e) {
        console.error('⛔ 补做树展开失败：', e);
      });
    }
    // 树形态下只有"隐藏空目录"开着时才需要清单；关着就一个请求都不发。
    const need = view === 'list' || S.state.hideEmptyDirs;
    if (!need) return;
    const dl = ensureDocList();
    // ⚠️ "可见" = 形态是列表 **且** 文件那一页在前（去了大纲页就不画）。
    dl.setActive(view === 'list' && sidebar.isFilesVisible());
    if (!docListDirty && !rebuild) return;
    docListDirty = false;
    try {
      await dl.refresh(!!rebuild);
    } catch (e) {
      // ⚠️ 失败要重试得起来：把脏标记放回去，下一次 `renderSidebar` 会再拉一次。
      docListDirty = true;
      throw e;
    }
  }

  /** ⭐ 形态按钮：切一次 = 写一次盘（失败要说出来，R5）+ 切面板 + 拉清单。 */
  async function toggleFileView() {
    const next = S.state.sidebarFileView === 'list' ? 'tree' : 'list';
    try {
      await S.setSidebarFileView(next);
    } catch (e) {
      // ⚠️ **本次切换照样生效**（后端内存里已经改了）——只是没存下来。
      setStatusT('fileView.save-failed', {}, true);
      console.error('侧边栏形态未能保存：', e);
    }
    await applySidebarView(false);
  }

  /**
   * ⭐ 盘上可能变了（`rmd://tree-changed`）⇒ 清单可能旧了（`design/0041` §2.2 时机 ⑤）。
   * ⚠️ 不可见时**只置脏**，等下一次可见再拉（⛔ 不替用户看的地方白扫盘）。
   */
  function noteDocListStale() {
    docListDirty = true;
    if (!sidebar || !sidebar.isFilesVisible()) return;
    if (!S.state.hideEmptyDirs && sidebar.fileView() !== 'list') return;
    if (docListTimer) clearTimeout(docListTimer);
    docListTimer = setTimeout(function () {
      docListTimer = 0;
      if (!sidebar || !sidebar.isFilesVisible()) return;
      applySidebarView(true).catch(function (e) {
        console.error('重建文档列表失败：', e);
      });
    }, DL.STALE_REBUILD_MS);
  }

  /** 离开目录模式时把列表实例收掉（它没有任何可列的东西了）。 */
  function destroyDocList() {
    if (docListTimer) { clearTimeout(docListTimer); docListTimer = 0; }
    if (docList) { docList.destroy(); docList = null; }
    keepDirs = null;
    recentCreated.clear();
    docListDirty = true;
    treeFilterStale = false;
  }

  // ════════════════════════════════════════════════════════════════════
  // ⭐ 在树里定位（`design/0009` §2.1 ⑤）
  //
  // ⚠️ `FileTree.revealPath` 在 `0009` 里被加厚成 `{ok, reason}`——"定位不到"
  //    有好几种原因，而**它们长得一模一样**（浮层关了、正文出来了、树没动）。
  //    ⇒ 这里是**唯一**的消费点：把原因翻成人话，写在树顶上（`tree.note`）。
  // ⛔ 别再写出丢掉返回值的那种调用（`tree.revealPath(p);`）——
  //    那正是"静默失败"的形状，而 `INV-SEARCH-07` 要的就是**可见**。
  // ════════════════════════════════════════════════════════════════════

  /**
   * 失败原因 → 字典键。⛔ `outside` 故意不在表里：它不是失败（见下）。
   *
   * ⚠️ 这里存的是**键**不是中文（`design/0025` §2.5.1 ②）：存译文等于在**加载期**
   * 把语言冻住，换语言后这七句会永远停在旧语言——而它们恰恰只在失败时出现，
   * 没人会在换语言时顺手验一遍"定位失败"。
   */
  const REVEAL_KEY = {
    'too-deep': 'reveal.too-deep',
    'unreadable': 'reveal.unreadable',
    'missing': 'reveal.missing',
    'missing-parent': 'reveal.missing-parent',
    'not-a-dir': 'reveal.not-a-dir',
    'stale': 'reveal.stale',
  };

  /**
   * 把一份文档定位到树里；**失败要说出来**。
   *
   * ⚠️ 三种情况要分清：
   * ① `ok` —— 到位置了，什么都不说；
   * ② `outside` —— ⛔ **不是失败**：`Cmd+Shift+O` 打开的外部单文件本来就不在
   *    任何 root 之下，树里没有它是**对的**。（⚠️ 树在未授权态里本来就不显示。）
   * ③ 其余 —— 真的没定位到，写一行灰字（`INV-SEARCH-07`）。
   *
   * ⚠️ 树不在（未授权态 / 目录被收回）时**什么都不做**：那种界面上没有树，
   * 往一个空的容器里插一行"没定位到"只会让人以为程序坏了。
   */
  async function revealInTree(realPath) {
    if (!tree || !realPath) return;
    let r;
    try {
      r = await tree.revealPath(realPath);
    } catch (e) {
      // ⚠️ 定位只是个**便利**：它炸了不该带走正文（那边已经挂好了）。
      //    但⛔ 也不静默——`console` 是本项目唯一的 stderr 通路。
      console.error('⛔ 树里定位出错：', e);
      tree.note(t('reveal.error', { msg: (e && e.message) || e }));
      return;
    }
    if (r && r.ok) { tree.note(null); return; }
    const reason = (r && r.reason) || 'unknown';
    if (reason === 'outside') return;
    tree.note(t('reveal.miss', {
      name: baseName(realPath),
      reason: REVEAL_KEY[reason] ? t(REVEAL_KEY[reason]) : t('reveal.unknown', { reason: reason }),
    }));
  }

  /**
   * ⭐ 打开一份文档并按 §2.1.3 的提交点 ① 落地。
   *
   * @param {string} path
   * @param {object} [opts]
   * @param {'restore'} [opts.reason] ⭐ `design/0020`：这次打开是**恢复事务**发起的。
   *   ⚠️ 它改变两件事，⛔ 不要顺手用在别的调用点上：
   *   ① **不作废恢复**（否则恢复会把自己取消掉）；
   *   ② **跳过目录会话的冲刷**（R2：那一刻 `currentPath` 还是 null，
   *      冲刷会把 `last_file` 写成 null——**恢复还没试就已经把记录抹了**）。
   */
  async function openDocument(path, opts) {
    const reason = (opts && opts.reason) || null;
    // ⭐ `design/0012` §6：**编辑态下切文档要过闸**（`INV-EDIT-06`）。
    //   ⚠️ 挂在这里是因为**所有**打开路径都经过它：树里点、搜索浮层、`⇧⌘O`、
    //      启动参数。⛔ 挂在某一条上就会留下一个"从另一条进来就把用户的字丢了"的口子。
    //   ⚠️ 不脏时**静默退出编辑态**：那时缓冲与磁盘一致，没有东西可丢，
    //      而"切了文档还留在旧文档的编辑态里"是更坏的状态（预览会显示新文档、
    //      缓冲还是旧文档 ⇒ 保存会写错文件）。
    if (editing) {
      if (editDirty) {
        // ⚠️ 走这条之前**先退出编辑态**（不是直接再调一次 `openDocument`）：
        //    脏标记要等 `exitEdit()` 之后才清得掉，否则那一次重入会**再弹一次**
        //    ——同一个问题问两遍，而且第二遍的答案还是同一个。
        promptLeaveEdit('edit.ask-switch', { name: baseName(path) }, function () {
          exitEdit().then(function () { return openDocument(path); });
        });
        return null;
      }
      await exitEdit();
    }
    // ⭐ `design/0047` §2.5：**就地编辑的脏内容同样要过闸**。
    //   ⚠️ 与上面那一段分开写，⛔ 不合并：分栏的"保存"是 `saveNow()`（编辑器缓冲），
    //      就地编辑的"保存"是"提交 ＋ 写盘"（`liveSaveNow()`）——两条路各有一个存活的
    //      会话，把它们揉进一个闸里，早晚有一条走错（`INV-LIVE-11` ④）。
    //   ⚠️ 两个会话**不可能同时活着**：进分栏之前 `liveToSplitEdit()` 会先 `leave()`，
    //      反向的"分栏 → 就地"这条路本次没做（§4.2 的方向是单向的）。
    if (!editing && live) {
      if (live.isDirty()) {
        liveAskSwitch(baseName(path), function () { openDocument(path, opts); });
        return null;
      }
      if (live.isEditing()) {
        // ⚠️ 不脏 ⇒ **静默退出**：提交是幂等的，没有东西可丢，多问一次只会让人
        //    学会忽略这条带子（与上面 `editDirty` 那段同一条口径）。
        //    ⚠️ 必须 `await`：`openDocument` 紧接着就要换身份，而 `leave()` 里的
        //    `commitTarget` 还在用**旧**身份渲染（换早了会把那一块提交进新文档）。
        // ⭐ `design/0054` §7 第 5 条：提交**被拒** ⇒ ⛔ 不切文档。切了就是
        //    "用户唯一那份输入被销毁"，而且是**无提示**的（脏标记在 `isEditing()` 那一侧）。
        const left = await liveSerial(function () { return leaveLive({}); });
        if (left && left.ok === false) return null;
        // ⭐⭐ **提交之后再核对一次**（2026-10-29 复评 P1）：`leave()` 会把视图里的输入
        //    提交进会话，而 `liveSerial` 排队那段时间用户还能继续打字 ⇒ 此刻的"脏"是
        //    「已提交、未落盘」。⛔ 别拿上面那个 `isDirty()` 当 `await` 之后的结论：
        //    紧接着换文档会把这份输入**无声**丢掉（脏带子连弹都不会弹）。
        if (live.isDirty()) {
          liveAskSwitch(baseName(path), function () { openDocument(path, opts); });
          return null;
        }
      }
    }
    // ⭐ `design/0017` §2.3 ④：**切文档之前冲刷**。
    //   ⚠️ 时机是"此刻"——后端的 `current_document` 还是**旧**那一份，
    //      这次写入会被接受；`mountDocument` 一挂上去，旧身份就没了。
    //   ⚠️ 有上限（`FLUSH_TIMEOUT_MS`），⛔ 不许让写盘拖住切文档。
    await flushReadingProgress();
    // ⭐ `design/0020` §2.3 ③(a) 的**取消规则**：用户亲手打开一份文件 ⇒
    //    **整条恢复作废**（展开继续毫无意义，而且它随后可能再打开一份"上次的文件"，
    //    把用户刚点的那份顶掉）。⚠️ 恢复自己发起的这次**不**取消自己。
    if (dirRestorer && reason !== 'restore') dirRestorer.cancel('user-open');
    // ⭐ `design/0020` §2.3 ③(c)：切文档之前冲刷目录会话。
    //   ⚠️ **必须在 `S.openDocument` 之前**：它内部可能在本趟里按 §2.1.4 第 ③ 步
    //      调 `closeDirectory()`（代次 +1），之后这次写必然被判 `stale`。
    //   ⚠️ `reason === 'restore'` 那一趟**跳过**（R2，见函数头）。
    if (reason === 'restore') {
      // ⛔ 不冲刷：这正是评审 R2 点名的形态。
    } else if (dirWriter) {
      await dirWriter.flush();
    }
    let out;
    // ⭐ **T4**（`design/0002` §7.3.2）：`invoke('open_document')` → Promise resolve。
    // ⚠️ **它包含后端全部耗时**（序列化 + 解析 + 渲染 + IPC 往返），
    //    ⛔ **它不是"IPC 开销"**——那部分要靠残差 `R` 减出来。
    const t4a = measure ? measure.now() : 0;
    try {
      out = await S.openDocument(path);
    } catch (e) {
      setStatusT('status.open-failed', {
        msg: e.wording || e.message,
        path: e.path ? t('common.in-parens', { path: e.path }) : '',
      }, true);
      return null;
    }
    const t4b = measure ? measure.now() : 0;
    // ⛔ 提交点判定不通过 → **什么都不做**。这正是"慢的 A 不覆盖快的 B"。
    if (!out.payload) return null;
    const spans = mountDocument(out.payload);
    // ⭐ `design/0017` §2.3 ⑤：挂完之后立刻尝试恢复（**在 `ensureWatch` 之前**）。
    //   ⚠️ 必须是**挂载之后**：恢复要读 `scrollHeight`，而那要等新正文进了布局。
    //   ⚠️ 这里只处理"现在就能滚"那一档；滚不动的意图由 `mountDocument` 里
    //      `ImageView` 的 `onSettled` 兑现（图片解码后页面才变高）。
    restoreReadingProgress(out.payload);
    // ⭐ `design/0020` §2.3 ③(c)：**用户打开的文件就是"上次的文件"**，这是它唯一的来源。
    //   ⚠️ **直接写、⛔ 不走去抖窗口**——500 ms 内关窗/切目录就会把它吞掉，
    //      而那条记录正是下次恢复要用的那一条。
    //   ⚠️ **不 `await`**：正文已经挂好，写盘是后台的事，⛔ 不该让它拖慢"打开"。
    //      失败由写者自己置回 dirty（下一次树操作会重试）。
    //   ⚠️ 恢复那一趟跳过：`restoreToken` 活着时写者本来就挂起（双重保险，
    //      即便挂起失效，载荷与镜像相同 ⇒ `sameEntry` 也拒发）。
    if (reason !== 'restore' && dirWriter) {
      dirWriter.noteDocOpen();
    }
    lastOpen = {
      t4_ms: t4b - t4a,
      // ⚠️ 这两个是**同一段代码的同步耗时**，⛔ 不是浏览器认定的 long task（§7.3.3）
      t5_ms: spans.t5_ms,
      t5b_ms: spans.t5b_ms,
    };
    // ⭐ 新文档 ⇒ 旧的那条降级提示不再适用（§2.1 ④：提示是**跟着这份文档**的）。
    pendingNotice = null;
    pendingNoticeVars = null;
    // ⭐ `INV-EXT-06`：监视**只在一次成功的提交之后**建立。
    await ensureWatch(out.payload.real_path);
    return out.payload;
  }

  // ════════════════════════════════════════════════════════════════════
  //  ⭐ 文档内链接（`design/0026`，收口 `docs/bugs/0001`）
  // ════════════════════════════════════════════════════════════════════

  /**
   * 把锚点滚到视口顶部。找不到 ⇒ **明确说一句**（`INV-LINK-08`，⛔ 不猜最近标题）。
   *
   * ⚠️⚠️ **必须经 `hostSetTop`**：它是全项目唯一一处"把阅读位置写回去"（`design/0012` §2.6-5）。
   *    在这里直接 `host.scrollTop = …` 或 `el.scrollIntoView()` 会绕过滚动同步的记账
   *    ⇒ 编辑态下那次移动被判成"用户接管"，预览栏立刻反向驱动源码栏（`docs/bugs/0006`）。
   */
  function scrollToFragment(fragment) {
    const doc = $('doc');
    const el = Links.anchorFor(fragment, doc);
    if (!el) {
      setStatusT('link.anchor-missing', { anchor: fragment || '' }, true);
      return;
    }
    const host = scrollHost();
    const base = host === window ? 0 : host.getBoundingClientRect().top;
    const y = hostTop() + (el.getBoundingClientRect().top - base);
    hostSetTop(Math.max(0, y));
  }

  /**
   * 后端说"授权内的一份 Markdown" ⇒ 走**既有** `openDocument`（`INV-LINK-06`）。
   *
   * ⚠️ ⛔ 不在这里读文件：脏缓冲保护、阅读进度、目录会话、监视、树定位全在
   *    `openDocument` / `mountDocument` 那一条路上，另起一条就是第二份实现。
   */
  async function openLinkedDocument(path, fragment) {
    if (!path) {
      setStatusT('link.failed', { message: 'document' }, true);
      return;
    }
    const payload = await openDocument(path);
    // ⚠️ `null` 有四种来路（失败已报 / 提交点判陈旧 / 脏缓冲已弹决策条 / 用户取消），
    //    每一种**都已经说过话**（或正在等用户回答）⇒ 这里⛔ 不再补一句。
    if (!payload || !fragment) return;
    // ⚠️ 锚点在**新正文挂完之后**才找得到；而阅读进度恢复可能刚把位置挪走
    //    ⇒ 这一次定位就是用户点链接要的那一个位置，放在它后面是有意的。
    scrollToFragment(fragment);
  }

  /**
   * 目标在授权外 ⇒ **不自动授权**，摆一条决策条让用户自己选（§2.5）。
   *
   * ⚠️ 复用既有 `askEdit` 那条行内条子：它不抢焦点（`INV-SET-05`），
   *    而弹一个模态框会把中文输入法正在组合的那一段弄丢。
   */
  function askLinkAuthorization(href) {
    askEdit('link.unauthorized', { href: href }, [
      { label: 'link.act-choose-file', run: function () { onChooseFile(); } },
      { label: 'link.act-choose-dir', run: function () { onChooseDirectory(); } },
    ]);
  }

  /** 把 `links.js::plan` 的那一格变成界面上的一件事（§2.7 那张表）。 */
  function applyLinkPlan(p) {
    switch (p.action) {
      case 'status': setStatusT(p.key, p.vars, p.isError); return;
      case 'anchor': scrollToFragment(p.fragment); return;
      case 'open': openLinkedDocument(p.path, p.fragment); return;
      case 'ask-auth': askLinkAuthorization((p.vars && p.vars.href) || ''); return;
      default:
        // ⚠️ 走到这里说明 `plan` 返回了这张 switch 不认识的动作（它自己那条 default
        //    已经把未知 `kind` 兜成 `status` 了）⇒ 仍然要**说一句**，⛔ 不静默。
        setStatusT('link.failed', { message: String(p.action || '') }, true);
    }
  }

  /**
   * ⭐ **一次点击的全部流程**（`design/0026` §2.2 ③）：递 `href` ＋ `doc_seq` → 按结果落地。
   *
   * ⚠️⚠️ `doc_seq` 在**点击那一刻**取好并原样带回：后端在**读 `doc_dir` 的同一把锁**里
   *    核对它（`INV-LINK-11`），对不上就回 `stale` 且什么都不做。
   * ⚠️ 回包之后**再判一次**（`isAlive`）：`await` 期间用户可能换了文档，
   *    照旧回包去 `openDocument` 会把用户刚点的那份顶掉。
   */
  async function followLink(href) {
    const raw = Links.normalizeHref(href);
    const seq = S.state.docSeq;
    let out;
    try {
      out = await S.openLink(raw, seq);
    } catch (e) {
      // ⚠️ 这一条最可能的原因就是 ACL 少了 `allow-open-link`（`kb/0007` 的静默拒形态）。
      console.error('⛔ open_link 调用失败（多半是 ACL 少了 allow-open-link）：', e);
      setStatusT('link.failed', { message: (e && (e.wording || e.message)) || String(e) }, true);
      return;
    }
    if (!Links.isAlive(seq, S.state.docSeq)) {
      setStatusT('link.stale');
      return;
    }
    applyLinkPlan(Links.plan(out));
  }

  /**
   * ⭐ 正文里的链接委托（`#doc` 上**一处**）。
   *
   * ⚠️⚠️ **注册顺序是判据**：必须排在 `ImageViewer.installDelegation` **之后**
   *    （§6「最怕的四件事」最后一条）。图在链接里的形态是 `<a><img></a>`，
   *    图片那一层先 `preventDefault` ⇒ 这里第一句读 `defaultPrevented` 就退出，
   *    于是一次点击只有一个动作。
   *
   * ⚠️⚠️ **读 `getAttribute('href')`，⛔ 不读 `a.href`**：后者是**解析后**的绝对 URL，
   *    相对链接（`other.md`、`#frag`）会变成 `tauri://localhost/...` 那一串，
   *    交给后端就全成了"不支持的协议"或一个**猜出来的**绝对路径。
   *
   * ⚠️ `preventDefault()` **一律调**（`INV-LINK-02`）：哪怕这一跳是 anchor，
   *    不拦的话 WKWebView 会把它当成一次**导航**——而 `on_navigation` 只放行应用入口
   *    ⇒ 一次静默的拒绝（`bugs/0001` 的形态）。`on_navigation` 是第二层，⛔ 不是替代。
   */
  function installLinkDelegation(docEl) {
    if (!docEl) return function () {};

    /** 从事件目标往上找**带 href 的**链接；不越过 `#doc`。 */
    function linkOf(target) {
      if (!target || typeof target.closest !== 'function') return null;
      return target.closest('a[href]');
    }

    /**
     * 这一次激活该不该由我们接管：带 `⌘`/`⌃`/`⌥` 的点击**不是**"打开这条链接"的意思
     * （那是系统与未来的"新窗口"那一档），⛔ 我们不替用户猜。
     *
     * ⚠️ 判据**只能转调** `K.hasModifier`（`services/keymap.js`）——在调用侧再写一遍
     *    `e.metaKey || …` 就是第二份"这个事件带不带修饰键"的判断，而
     *    `keymap.test.js` 的「修饰键标识符只允许出现在 keymap.js」会红
     *    （与 `components/ImageViewer.js` 同一条纪律）。
     * ⚠️ `⇧` 不在那个判据里 ⇒ ⇧-点击按普通点击处理：它在浏览器里的含义是"新窗口打开"，
     *    而本项目没有多窗口（`on_new_window` 一律拒绝，`design/0026` §2.1）。
     */
    function owns(e) {
      return !K.hasModifier(e);
    }

    function onClick(e) {
      // ⚠️ **第一句**：图片缩放那一层已经处理过这一击（`e.preventDefault` + `stopPropagation`）。
      //    `stopPropagation` 拦不住**同一元素上的**另一个监听器 ⇒ 只能靠这个标记分家。
      if (e.defaultPrevented) return;
      if (e.button !== 0) return;
      const a = linkOf(e.target);
      if (!a) return;
      if (!owns(e)) return;
      // ⭐ `INV-LINK-02`：**先拦，再问**。哪怕后端最后说"不支持"，也⛔ 不许让
      //    WebKit 拿着这个 href 去导航一次。
      e.preventDefault();
      followLink(a.getAttribute('href'));
    }

    function onKeydown(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      // ⚠️ 中文输入法组合中按空格是**上屏**，不是激活（`INV-SET-05` 同族）。
      if (e.isComposing || e.keyCode === 229) return;
      if (e.defaultPrevented) return;
      const a = linkOf(e.target);
      if (!a) return;
      if (!owns(e)) return;
      e.preventDefault();
      followLink(a.getAttribute('href'));
    }

    docEl.addEventListener('click', onClick);
    docEl.addEventListener('keydown', onKeydown);
    return function uninstall() {
      docEl.removeEventListener('click', onClick);
      docEl.removeEventListener('keydown', onKeydown);
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  ⭐ Apple Event 打开请求（`design/0015` §2.1 ④）
  // ════════════════════════════════════════════════════════════════════

  /** 串行化 drain：两次唤醒挨得很近时，不许两组 `openDocument` 交错。 */
  let drainChain = Promise.resolve();

  /**
   * ⭐ 把后端队列里的打开请求**取空并依次打开**。
   *
   * ⚠️ 事件 `rmd://open-path` **只是唤醒信号**，⛔ 不携带路径（`INV-APP-03`）——
   * 路径的唯一真值在后端队列里，而且每一条都已经过授权（`INV-APP-02`）。
   * ⚠️ 依次 `await`：本期不做多窗口，最后一次提交就是窗口里显示的那一份（§4）。
   * ⚠️ 取队列失败要**响亮**（ACL 少了 `allow-take-pending-open` 就长这样），
   * ⛔ 不能安静地什么都不做——那正是 `kb/0007` 那一族静默失效。
   */
  async function drainPendingOpens() {
    let paths;
    try {
      paths = await S.takePendingOpen();
    } catch (e) {
      console.error('⛔ 取 Apple Event 打开请求失败（多半是 ACL 少了 allow-take-pending-open）：', e);
      return;
    }
    if (!paths || paths.length === 0) return;
    for (let i = 0; i < paths.length; i++) {
      // ⚠️ 编辑态脏缓冲时的询问由 `openDocument` 自己处理（`design/0012` §6）；
      //    这里继续处理后面的请求，⛔ 不因为一条被用户放弃就吞掉整批。
      await openDocument(paths[i]);
    }
    await renderSidebar();
    sidebar.setTab('toc');
  }

  /** 排队一次 drain；前一次失败不阻断后一次。 */
  function queueDrainPendingOpens() {
    drainChain = drainChain.then(drainPendingOpens, drainPendingOpens);
    return drainChain;
  }

  // ════════════════════════════════════════════════════════════════════
  // ⭐ 文件监视 + 自动重载（`design/0006` §2.1 ②④⑤⑥）
  // ════════════════════════════════════════════════════════════════════

  /**
   * 确保监视**就是** `realPath` 这一份（`INV-EXT-06`：只在成功提交后调）。
   *
   * ⚠️ 路径没变就**什么都不做**：后端那条 `watch_document` 会**换掉**现有监视，
   *    每次都白起一条 FSEventStream 只是浪费（而且会让 `seq` 无谓地涨）。
   * ⚠️ 失败**不是**致命错误（`watchDocument` 内部把它变成 `watchNote`）——
   *    正文照样能读，只是不会自动刷新，而那是 `INV-EXT-04` 要求**说出来**的事。
   */
  async function ensureWatch(realPath) {
    if (!realPath) return;
    const st = S.state;
    if (st.watchSeq !== 0 && st.watchPath === realPath) return;
    await S.watchDocument(realPath);
    syncReloadBar();
  }

  /**
   * 大纲里每个标题**当前**的像素位置。
   *
   * ⚠️ 用 `getBoundingClientRect().top + window.scrollY` 现算，⛔ 不用 `offsetTop`：
   *    后者相对的是**最近的定位祖先**，而这个布局里那个祖先不是页面
   *    （`.topbar` 是 sticky），于是会得到一个"差一个顶栏高度"的静默错位。
   * ⚠️ 大纲的 `id` 来自**后端**（`adr/0003`：文档级统一分配），这里只拿它去查元素，
   *    查不到就跳过——⛔ 不自己生成 id。
   */
  function headingPositions() {
    const doc = S.state.currentDoc;
    const toc = (doc && doc.toc) || [];
    const host = scrollHost();
    // ⚠️ 两种宿主的换算必须**同源**（与 `hostTop()` 同一把尺子）：
    //    窗口那份 = `rect.top + scrollY`；元素那份 = 「离宿主内容区顶部的距离」
    //    = `rect.top − 宿主 rect.top + 宿主 scrollTop`。
    //    写成 `base` 再统一减一下，两种形态就只差这一行。
    const base = host === window
      ? -window.scrollY
      : host.getBoundingClientRect().top - host.scrollTop;
    const out = [];
    for (let i = 0; i < toc.length; i++) {
      const el = document.getElementById(toc[i].id);
      if (!el) continue;
      out.push({ id: toc[i].id, top: el.getBoundingClientRect().top - base });
    }
    return out;
  }

  /**
   * ⭐ **滚动源**（`design/0012` §2.1②/§3.1）：阅读态是 `window`，编辑态是**预览栏 `#doc`**。
   *
   * ⚠️ 编辑态下 `body` 是 `overflow: hidden` 的网格（`editor.css`，"两栏各自滚"）
   *    ⇒ 那一刻 `window.scrollY` **恒为 0**、`window.scrollTo` **什么都不做**。
   *    而"重载后回到原处"这套锚点（`captureAnchor` / `restoreAnchor` /
   *    `headingPositions` / `scrollMetrics`）是**四条都**要按宿主换算的——
   *    只改其中一两条就会得到一个**静默错位**：光标回到顶部、换算看着"没错"
   *    （因为两个数都是 0，比值恒为 0，三级锚点会一路退到"回顶部"并**报一句
   *    '没能恢复阅读位置'**，而那个提示指向的原因完全是错的）。
   *    ⇒ 所以宿主只在这**一处**判，四条全部经它。
   *
   * ⚠️ 退不到 `#doc` 时（编辑态但 `#doc` 还没挂）**回落到 `window`**：
   *    宁可换算按阅读态来，也不要在这条路上抛（它跑在自动重载里，
   *    抛出去的表现是"文件改了、界面不动"——§2.1 里最糟的那种失败形态）。
   */
  function scrollHost() {
    if (editing) {
      const el = $('doc');
      if (el) return el;
    }
    return window;
  }

  function hostTop() {
    const h = scrollHost();
    return h === window ? window.scrollY : h.scrollTop;
  }

  /**
   * ⭐⭐ **全项目唯一一处"把阅读位置写回去"**（`design/0012` §2.6-5，`docs/bugs/0006`）。
   *
   * ⚠️⚠️ **它不是 `host.scrollTop = y` 的改名**。程序滚动与用户滚动产生的 `scroll`
   *    事件**长得一模一样**（同一个元素、同一个事件类型、没有 `isTrusted` 之外的区别），
   *    而滚动同步的来源闸只能靠"**这个值是不是我刚写的**"来分辨
   *    （`sync.js` 的期望值回显环，`ECHO_EPS = 1`）。
   *    ⇒ 绕过它直接赋值 ⇒ 那次写被判成**用户接管** ⇒ 来源翻到预览栏 ⇒
   *    它立刻反向驱动源码栏 ⇒ 两栏互推一次。
   *    ⚠️ 这条失败**不报错、不留日志**，只表现为"打字的时候画面在晃"
   *    （实测：文末一次提交把预览的可见内容挪 **48 px** 且来源翻到 `dst`，
   *    同一场景走锚点法 + 记账是 **0**——见 `docs/bugs/0006` 的表）。
   * ⚠️ 编辑态**不带 driver 时**（`sync.js` 没加载 / driver 已停）回落到裸赋值：
   *    宁可少一次记账，也不要在这条路上抛（它跑在重载里，抛出去就是"文件改了、界面不动"）。
   */
  function hostSetTop(y) {
    const h = scrollHost();
    if (h === window) { window.scrollTo(0, y); return; }
    if (syncDriver && typeof syncDriver.写入预览 === 'function') {
      syncDriver.写入预览(y);
      return;
    }
    h.scrollTop = y;
  }

  /** 当前页面的可滚动高度与视口高度。⚠️ 两处算法必须同源（`pickAnchor` 与 `resolveAnchor`）。 */
  function scrollMetrics() {
    const h = scrollHost();
    if (h !== window) return { scrollHeight: h.scrollHeight, clientHeight: h.clientHeight };
    return {
      scrollHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      ),
      clientHeight: window.innerHeight,
    };
  }

  /** 重载**之前**记下阅读位置。 */
  function captureAnchor() {
    const m = scrollMetrics();
    return R.pickAnchor(hostTop(), headingPositions(), m.scrollHeight, m.clientHeight);
  }

  /**
   * 重载**之后**把位置还回去。
   *
   * ⭐ 三级锚点（§6.1）：标题 + 行内偏移 → 比例 → 回顶部。
   * ⛔ **回顶部必须提示**（那正是用户会以为"文档被改了"的时刻）——
   *    提示走的是**状态条之外**那一行，⛔ 不弹窗、⛔ 不挡正文。
   */
  function restoreAnchor(anchor) {
    const m = scrollMetrics();
    const r = R.resolveAnchor(anchor, headingPositions(), m.scrollHeight, m.clientHeight);
    hostSetTop(r.scrollTop);
    if (r.notice) {
      pendingNotice = 'reload.pos-lost';
      pendingNoticeVars = null;
    }
    syncReloadBar();
  }

  // ════════════════════════════════════════════════════════════════════
  // ⭐ 阅读进度的读写与恢复（`design/0017` §2.3 ③④⑤）
  //
  // ⚠️ 分工与 `0006`/`0011`/`0012` 一致：**判据与形状**在 `services/progress.js`
  //    （纯逻辑、可 `node --test`），**锚点算法**在 `services/reload.js`，
  //    这里只有"把 DOM、IPC、计时器接上去"。⛔ 别把任何判据搬进这个文件——
  //    `main.js` 不进 `tests/js/`，搬进来就没有断言了。
  // ════════════════════════════════════════════════════════════════════

  /** 当前**已提交**文档的会话号（`design/0017` §2.2 ①）。⛔ 不猜、不自增。 */
  function currentDocSeq() {
    return (S.state.currentDoc && S.state.currentDoc.doc_seq) || 0;
  }

  /** 当前文档的源字节数（落盘条目带它，用于前后对照）。 */
  function sourceBytesOfCurrent() {
    return (S.state.currentDoc && S.state.currentDoc.source_bytes) || 0;
  }

  /** 现在这一份**滚得动**吗。⚠️ 与 `applyRestore`/`restorePlan` 同一把尺子（> 1 px）。 */
  function isScrollable() {
    const m = scrollMetrics();
    return m.scrollHeight - m.clientHeight > 1;
  }

  /**
   * ⭐ **一次写盘的落地**（成功/失败共用）：先核对身份，再并入运行期恢复表。
   *
   * ⚠️ 三个核对**缺一不可**（`design/0017` §2.2 ②）：
   * ① `capture.path`——A→B→A 之后，A 的迟到写入不许落进来；
   * ② `capture.docSeq`——**同一路径的两次打开**（重开同一份）也不许落进来；
   * ③ 后端回来的 `status`——`stale`/`ignored` 时**没有**可用的 `entry`。
   * ⚠️ `persisted` 记的是"后端确认写成了"，⛔ 不是"请求发出去了"——
   *    `persist_failed` 必须留成 `false`，否则同值重试会被 `planSave` 永久跳过（评审 R2）。
   */
  function acceptProgressWrite(capture, res) {
    if (capture.path !== S.state.currentPath || capture.docSeq !== currentDocSeq()) return;
    if (res.status === 'ok' || res.status === 'persist_failed') {
      const evicted = res.evicted || [];
      P.mergeWrite(S.state.readingProgress, capture.path, res.entry, evicted);
      // ⚠️ 被淘汰的路径连**基线**一起清：留着它会让那条路径的第一次写入被误判成
      //    "间隔不够"从而白等一轮（它已经不是"上次写成的值"了）。
      for (let i = 0; i < evicted.length; i++) lastAppliedByPath.delete(evicted[i]);
      lastAppliedByPath.set(capture.path, {
        entry: res.entry,
        at: Date.now(),
        persisted: res.status === 'ok',
      });
    }
  }

  /**
   * 滚动停下 1.5 s 之后写一次（§2.3 ③）。⚠️ 只重新**计时**，不做任何判据——
   * 判据全在 `P.planSave`（频控 2 s、±8 px / ±0.5% 去重、失败重试）。
   */
  function onReadingScroll() {
    if (editing) return;
    if (!S.state.currentPath) return;
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(function () { saveReadingProgress(false); }, P.SAVE_IDLE_MS);
  }

  /** 真写一次（或按间隔再等一会儿）。`force` = 切换/隐藏/退出前的冲刷。 */
  function saveReadingProgress(force) {
    progressTimer = null;
    const path = S.state.currentPath;
    if (!path || editing) return;
    const docSeq = currentDocSeq();
    const next = P.toEntry(captureAnchor(), sourceBytesOfCurrent());
    const last = lastAppliedByPath.get(path) || null;
    const since = last ? Date.now() - last.at : Number.MAX_SAFE_INTEGER;
    const plan = P.planSave(last, next, since, !!force);
    if (plan.action === 'wait') {
      // ⚠️ 这次重试**不再强制**（force 只用于"要走了，最后一次"）。
      progressTimer = setTimeout(function () { saveReadingProgress(false); }, plan.waitMs);
      return;
    }
    if (plan.action !== 'save') return;
    const capture = { path: path, docSeq: docSeq };
    S.setReadingProgress(path, docSeq, next).then(function (res) {
      acceptProgressWrite(capture, res);
    }).catch(function () {
      // ⚠️ 失败开放：阅读进度**绝不能**打断阅读（它只是一个便利）。
      //    ⛔ 也不要在界面上报错——用户没有任何可做的动作。
    });
  }

  /**
   * ⭐ **冲刷**（§2.3 ④）：切文档之前 / 窗口隐藏 / 页面卸载之前。
   *
   * ⚠️ 有上限（`FLUSH_TIMEOUT_MS`）：一次写盘**不许**拖住切文档。
   * ⚠️ 值的捕获发生在 `editing` 判定**之后**——阅读态才有"阅读位置"可言。
   */
  async function flushReadingProgress() {
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    const path = S.state.currentPath;
    if (!path || editing) return;
    const docSeq = currentDocSeq();
    const next = P.toEntry(captureAnchor(), sourceBytesOfCurrent());
    const last = lastAppliedByPath.get(path) || null;
    if (P.planSave(last, next, 0, true).action !== 'save') return;
    const capture = { path: path, docSeq: docSeq };
    await Promise.race([
      S.setReadingProgress(path, docSeq, next).then(function (res) {
        acceptProgressWrite(capture, res);
      }).catch(function () { /* 同上：失败开放 */ }),
      new Promise(function (resolve) { setTimeout(resolve, FLUSH_TIMEOUT_MS); }),
    ]);
  }

  /**
   * ⭐ **挂载之后决定要不要恢复**（§2.3 ⑤）。三态来自 `P.restorePlan`：
   * `skip`（没有可用条目）/ `apply`（现在就能滚）/ `defer`（**滚不动，但意图保留**）。
   *
   * ⚠️ `defer` 是评审 R3 的直接产物：图片解码之前页面可能比视口短，
   *    此时直接放弃 = "打开带大图的文档永远回到顶部"（而且**没有任何报错**）。
   */
  function restoreReadingProgress(payload) {
    const path = payload.real_path;
    const entry = S.state.readingProgress[path];
    const plan = P.restorePlan(entry, isScrollable());
    if (plan === 'skip') return;
    const anchor = P.toAnchor(entry);
    const base = {
      path: path,
      mountGen: mountGen,
      docSeq: payload.doc_seq,
      anchor: anchor,
      appliedTop: 0,
      expires: Date.now() + RESTORE_EXPIRES_MS,
      userAborted: false,
    };
    if (plan === 'apply') applyRestore(base);
    else pendingRestore = base;
  }

  /** 真把位置写回去一次，并记下"这个值来自磁盘"（免得 1.5 s 后原样再写一遍）。 */
  function applyRestore(p) {
    const m = scrollMetrics();
    if (m.scrollHeight - m.clientHeight <= 1) { pendingRestore = p; return; }
    // ⚠️ 迟到的调用不许动新正文（§2.3 ⑤ 的第一道闸）。
    if (p.mountGen !== mountGen) return;
    const r = R.resolveAnchor(p.anchor, headingPositions(), m.scrollHeight, m.clientHeight);
    hostSetTop(r.scrollTop);
    pendingRestore = Object.assign({}, p, { appliedTop: r.scrollTop });
    lastAppliedByPath.set(p.path, {
      entry: P.toEntry(p.anchor, sourceBytesOfCurrent()),
      at: Date.now(),
      persisted: true,
      source: 'restore',
    });
  }

  /**
   * ⭐ 图片**落定**之后的校正（§2.3 ⑤，评审 R3/R4）。
   *
   * ⚠️ 六个条件全在 `P.shouldCorrect` 里（挂载代号 / 路径 / 会话号 / 编辑态 /
   *    过期 / 用户接管）。**挂载代号是"迟到回调"的那道闸**——换了一份文档之后，
   *    上一份的图片回调**仍然会到达**，它不许把新正文抢回旧位置。
   * ⚠️ 用户一旦自己动了（滚轮 / 触摸 / 翻页键），⛔ **绝不**再把位置抢回来。
   */
  function correctReadingProgress(gen) {
    if (!pendingRestore || pendingRestore.mountGen !== gen) return;
    if (pendingRestore.userAborted) { pendingRestore = null; return; }
    if (!P.shouldCorrect(pendingRestore, gen, S.state.currentPath,
                         currentDocSeq(), editing, false, Date.now())) {
      // ⚠️ 不可校正时**只在真的作废（过期 / 换了文档）才清**：
      //    其余几种（编辑态、会话号变了）下一次事件还会再来，留着不碍事。
      if (Date.now() > pendingRestore.expires || pendingRestore.path !== S.state.currentPath) {
        pendingRestore = null;
      }
      return;
    }
    const p = pendingRestore;
    if (p.appliedTop === 0) { applyRestore(p); return; }
    const m = scrollMetrics();
    const r = R.resolveAnchor(p.anchor, headingPositions(), m.scrollHeight, m.clientHeight);
    pendingRestore = null;
    // ⚠️ 不到 1 px 就不写：图片落定常常**不改变**布局，白写一次会让来源闸多一次噪声。
    if (Math.abs(r.scrollTop - p.appliedTop) < 1) return;
    hostSetTop(r.scrollTop);
    lastAppliedByPath.set(p.path, {
      entry: P.toEntry(p.anchor, sourceBytesOfCurrent()),
      at: Date.now(),
      persisted: true,
      source: 'restore',
    });
  }

  /** 用户自己动了 ⇒ 作废还没兑现的恢复意图（§2.3 ⑤ 的最后一条）。 */
  function markProgressUserAbort() {
    if (pendingRestore) pendingRestore.userAborted = true;
  }

  /** ⭐ 把上面这一族接到窗口上。⚠️ 全部 `passive`——它们只读，⛔ 不拦任何默认行为。 */
  function setupReadingProgress() {
    window.addEventListener('scroll', onReadingScroll, { passive: true });
    // ⚠️ 用 `visibilitychange` + `pagehide`，⛔ 不用 `beforeunload`：
    //    后者在 WebKit 里会阻止页面进 bfcache，而我们要的只是"走之前写一次"。
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushReadingProgress();
    });
    window.addEventListener('pagehide', function () { flushReadingProgress(); });

    // ⚠️ 接管判据是**输入事件**，⛔ 不是"像素有没有变"——用户滚走再滚回来，
    //    像素与恢复意图完全一样，像素判据识别不出来（`progress.js` 文件头第 ③ 条）。
    window.addEventListener('wheel', markProgressUserAbort, { passive: true });
    window.addEventListener('touchstart', markProgressUserAbort, { passive: true });
    window.addEventListener('pointerdown', markProgressUserAbort, { passive: true });
    window.addEventListener('keydown', function (e) {
      if (!pendingRestore) return;
      const k = e.key;
      if (k === 'PageUp' || k === 'PageDown' || k === 'Home' || k === 'End' || k === ' ' ||
          k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
        pendingRestore.userAborted = true;
      }
    }, true);
  }

  /**
   * ⭐ **重载并保留阅读位置**。自动重载与「立即重载」按钮走的是**同一条**路
   * （⛔ 不写两份：两份的差别迟早会漂）。
   *
   * ⚠️ 失败**静默**（除了提交点判成陈旧——那是正常竞态，§2.1.3）：
   *    文件被删/被移出授权时 `reload_document` 返回 `not_found` / `not_authorized`，
   *    这时**正文必须留着**（用户正在读它），只把原因写进提示条。
   */
  async function reloadCurrentDocument(reason) {
    // ⭐⭐ `design/0047` §2.5：**就地编辑有未写盘的提交时，任何一条重载都不许静默覆盖它**。
    //     ⚠️ 这条闸是**必须**的，⛔ 不是"防御性代码"：提交只活在内存里（`save()` 才落盘），
    //        而 `#reload-now` 那条按钮直接调到这里 —— 用户点它一下，
    //        **攒着的提交就全没了**，而且每一步看着都对。
    //     ⚠️ 提问是异步的（用户可能选「取消」）⇒ 这一趟直接返回，由那个选择再发起重载。
    if (live) {
      if (live.isDirty()) {
        promptLiveExternalChange();
        return null;
      }
      // 不脏 ⇒ 先提交退出（幂等、没有东西可丢），再把提交栈清掉：
      // 身份马上就要换，旧栈里的行号会指向**另一份文本**的行（`sameDocumentSession` 的口径）。
      // ⭐ `design/0054` §7 第 5 条：提交被拒 ⇒ ⛔ 不重载（重载会把视图连同输入一起换掉）。
      if (live.isEditing()) {
        const left = await liveSerial(function () { return leaveLive({}); });
        if (left && left.ok === false) return null;
      }
      // ⭐⭐ **提交之后再核对一次**（2026-10-29 复评 P1）：`leave()` 会把视图里的输入
      //    提交进会话，而排队等它那段时间用户还能继续打字 ⇒ 此刻的"脏"是
      //    「已提交、未落盘」。⛔ 别拿 `await` 之前那个 `isDirty()` 当结论：
      //    紧接着的 `reset()` + 读盘会把这份输入**无声**换成磁盘那一份。
      if (live.isDirty()) {
        promptLiveExternalChange();
        return null;
      }
      await liveSerial(function () { return live.reset(); });
    }
    if (reloadInFlight) return null;
    reloadInFlight = true;
    const anchor = captureAnchor();
    let out;
    const t4a = measure ? measure.now() : 0;
    try {
      out = await S.reloadDocument();
    } catch (e) {
      reloadInFlight = false;
      // ⚠️ `wording` 是后端给的人话（`tauri.js` 那层），没有就退到 message。
      // ⭐ `reason` 是**字典键**（`design/0025` §2.2.1）——传中文进来再拼出去，
      //    英文界面里会得到 "Auto-reload failed (文件已改变)" 这种半句。
      pendingNotice = 'reload.auto-failed';
      // ⚠️ `reason` 在这里**现翻**，⛔ 不在写这条时翻——见 `pendingNotice` 的注释。
      pendingNoticeVars = { reason: reason, msg: e.wording || e.message };
      syncReloadBar();
      return null;
    }
    const t4b = measure ? measure.now() : 0;
    if (!out.payload) {
      // ⛔ 陈旧 ⇒ **什么都不做**，⛔ 也不提示（用户已经切到别处了）。
      reloadInFlight = false;
      return null;
    }
    // ⭐ **盘上变了 ⇒ 图片缓存整表作废**（2026-10-29 代码评审第 6 条）：
    //    缓存只认 `(文档身份, src)`，而这里发生的正是"同一份文档的内容变了"——
    //    图片可能被外部改掉、也可能换了一张同名文件。TTL（5 分钟）兜不住
    //    （用户完全可能在 5 分钟内换一张同名图）。⚠️ 缓存只是**加速**，⛔ 不是事实来源。
    ImageView.clearAssetCache();
    const spans = mountDocument(
      out.payload,
      // ⭐ `design/0012` §2.1②：编辑态下**预览栏自己滚** ⇒ 重渲要保住它的滚动位置；
      //    也不必再去树里定位（重载的**就是**这一份，树早就定位过了）。
      //    ⚠️ 用 `editing` 现判，⛔ 不从调用方传进来：`mountDocument` 的调用点
      //       有三个，多一个参数就是多一处迟早会漂的判据。
      //    ⛔ 阅读态**一个字都不变**：那条路上 `#doc` 不是滚动容器，
      //       `keepScroll` 会去夹一个恒为 0 的 `scrollTop`，而"切文档回顶部"
      //       那条行为是 `design/0006` 冒烟里验过的，⛔ 不在这条边角上动它。
      //    ⭐ 把**读盘之前**记的那一个锚点交给它 ⇒ 由下面那句 `restoreAnchor` 统一还回去
      //       （⛔ 不让它自己再记一次：那一次记的已经是"读盘之后"的了）。
      editing ? { keepScroll: true, noReveal: true, anchor: anchor } : null
    );
    lastOpen = { t4_ms: t4b - t4a, t5_ms: spans.t5_ms, t5b_ms: spans.t5b_ms };
    pendingNotice = null;
    pendingNoticeVars = null;
    restoreAnchor(anchor);
    // ⭐ `design/0012` §6：编辑态下预览栏换了内容 ⇒ 源码栏也得跟上，
    //    否则用户左栏在改 A、右栏是磁盘上的 B，而左栏那句"未保存"还是假的。
    //    ⚠️ `refreshEditBuffer()` **自己会判脏**（脏就不动缓冲，只换预览）——
    //       这里⛔ 不再判一次：两处判据迟早会漂。
    //    ⚠️ **必须 await**：`reloadInFlight` 是"一次只跑一条重载"那道闸，
    //       在 IPC 还没回来时就放开它，下一条事件能挤进来、两道重载并行。
    if (editing) await refreshEditBuffer();
    reloadInFlight = false;
    return out.payload;
  }

  /**
   * ⭐ 收到一条「文件变了」的事件（`design/0006` §2.1 ②④）。
   *
   * 两件事，顺序不能换：
   * ① **判据**（`reload.js::acceptEvent`）——不是我这一轮监视的东西就丢掉，**并计数**；
   * ② **debounce**（300 ms）——⛔ 每条事件都重载的话，"保存一次"会变成"卡十下"
   *    （实测同一操作报过 2 / 6 / 11 条，`kb/0020`）。
   */
  function onDocumentChanged(ev) {
    const st = S.state;
    if (!R.acceptEvent(ev, st.watchSeq, st.currentPath)) {
      // ⚠️ **丢弃要计数**（§2.1 ②）：静默丢弃与"自动刷新坏了"在界面上长得一样，
      //    而这个数会进 `report_status`，让冒烟分得清。
      //    ⚠️ 计数本身**不触发** `emit`（它是给回报用的，不是给界面用的）。
      S.noteDroppedEvent();
      return;
    }
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(function () {
      reloadTimer = null;
      // ⭐ 决策时点 = **闸门在这里现算**（§2.1 ④：每次收到事件、且在 debounce 之后）。
      //    ⛔ 不在收到第一条事件时算：那时还不知道噪声有没有平息。
      decideAndReload();
    }, R.DEBOUNCE_MS);
  }

  /** debounce 平息之后：闸门判一次，然后自动重载或只提示。 */
  function decideAndReload() {
    const st = S.state;
    const doc = st.currentDoc;
    if (!doc) return;
    // ⭐⭐ `design/0012` §6 表里"最怕的一种"：**编辑态 ∧ 有未保存内容**。
    //     ⛔ 自动重载在这里**必须让位**——`reloadCurrentDocument` 会拿磁盘那份
    //     覆盖预览，紧接着 `refreshEditBuffer` 又覆盖缓冲，用户刚敲的字
    //     **无声消失**（而每个中间步骤看着都对）。
    //     ⇒ 这里不判"多重不重"、也不判耗时：只要有未保存内容就**停下来问**。
     //       降级提示那一支（下面那个 `verdict !== 'auto'`）同样要绕开，
     //       所以这一句在**闸门之前**。
    if (editing) {
      if (editDirty) { promptExternalChange(); return; }
      // ⚠️ 不脏：可以安全地自动刷新（缓冲里没有磁盘上没有的东西）。
      //    但用户已经说过"保留我的修改"之后**就不再问**（`externalChangeSettled`）
      //    —— 那一支**根本不该走到这里**：它选择了"不读磁盘那份"，
      //    于是后续的自动重载同样不该发生。⇒ 已定案就**整条路都不走**。
      if (externalChangeSettled) return;
    }
    // ⭐ `design/0047`：就地编辑与上面那条是**同一类"最怕的情况"**（提交只在内存里）。
    //   ⚠️ 覆盖层开着时**整条路都不走**：用户正在打字，而重载会在他手底下把正文换掉，
    //      提交点还会在同一时刻重挂视图（两个 `mountDocument` 交错 ⇒ 视图挂到旧树上）。
    //      那一刻磁盘上的变化**不会丢**——退出覆盖层之后下一次事件（或用户手动重载）会看到它。
    if (live) {
      if (live.isEditing()) return;
      if (live.isDirty()) { promptLiveExternalChange(); return; }
    }
    // ⭐ 闸门的两个输入（`reload.js::autoReloadDecision` 的口径写在那个文件里）：
    // ① 这份文档**上一次整段打开/重载**的耗时（前端实测，含 IPC 往返）——
    //    ⚠️ 它比后端那三个数更接近"用户要等多久"，而且**只有前端有**；
    // ② 源字节数，且**只在没有①时**才用。
    const prevMs = lastOpen && typeof lastOpen.t4_ms === 'number' ? lastOpen.t4_ms : null;
    const bytes = typeof doc.source_bytes === 'number' ? doc.source_bytes : null;
    const verdict = R.autoReloadDecision(prevMs, bytes);
    if (verdict === 'auto') {
      reloadCurrentDocument('reload.reason.auto');
      return;
    }
    // ⭐ **降级：不自动重载，但要出一行提示 + 一个按钮**（§2.1 ④ / `INV-EXT-04`）。
    const mb = (Math.max(0, doc.source_bytes) / 1024 / 1024).toFixed(1);
    pendingNotice = 'reload.paused';
    pendingNoticeVars = { mb: mb };
    syncReloadBar();
  }

  /**
   * ⭐ `Cmd+E` / File 菜单 · 用外部编辑器打开当前文档（`design/0006` §2.1 ②）。
   *
   * ⚠️ 目标**由后端定**（`current_document`），⛔ 这里不传路径。
   * ⚠️ 失败必须**说出来**（`INV-EXT-04`）：应用名拼错时 `open` 返回非零，
   *    而"按了没反应"是这个功能最可能的表现形态。
   */
  async function openExternalEditor() {
    // ⭐ **没有当前文档就别发这条 IPC**（`docs/bugs/0005`，2026-10-16）。
    //    ⚠️ 在此之前这里是**唯一**不先看本地真值的入口——`enterEdit()` 与 `saveNow()`
    //    都先查 `S.state.currentDoc`，只有 `⌘E` 把"没有文档"整件事**推给后端**，
    //    于是用户拿到的是后端的拒绝。⛔ 那不是"后端不该拒"——后端拒得对（`error.rs`
    //    的 `NoDocument`），问题是**拒绝的文案在前端那张表里缺了一格**，
    //    掉进兜底显示成「操作失败」（不定义原因的说法）。
    //    ⭐ 两侧都补：这里挡住常见的那个（菜单里点得着、空会话下也有键位），
    //    表里那格挡住够不着这里的路径（`reload_document`、`begin_edit` 的竞态）。
    //    ⚠️ ⛔ 别把这条写成"因为后端会报错所以先查一下"——真正的理由是**本地就知道**：
    //    发一条注定被拒的 IPC 再拿一句话解释，比直接说"你还没打开文档"绕。
    if (!S.state.currentDoc) {
      setStatusT('status.no-doc-external', null, true);
      return;
    }
    // ⭐ `design/0012` §6 那一行：编辑态下按 `⌘E`，外部编辑器打开的是**磁盘上那份**
    //    （⛔ 不含未保存的修改）——用户很可能以为看到的是自己刚改的，那是个陷阱。
    //    ⛔ 不 dirty 时**不问**：没有可丢的东西，多问一次只会让人学会忽略这条带子。
    //
    // ⚠️ 这里的两个按钮**不是** `promptLeaveEdit` 那三个：这一条问的是"要不要
    //    带着这个陷阱往下走"，⛔ 不是"你要存还是丢"——⛔ 别复用（复用会得到一个
    //    死循环：选「丢弃修改并继续」之后脏标记**还在**，于是再弹一次，永远弹下去）。
    if (editing && editDirty) {
      askEdit('edit.ask-external', null, [
        { label: 'edit.act-open-anyway', run: function () { openExternalEditorNow(); } },
        { label: 'common.cancel', run: function () { setEditStatus(t('edit.cancelled'), false); } },
      ]);
      return;
    }
    // ⭐ `design/0047`：就地编辑这一支是**同一个陷阱**——还没写盘的提交只有屏幕上有，
    //    外部编辑器打开的是磁盘那份。⇒ 先过"存 / 丢"那道闸，选完再重入本函数。
    //    ⚠️ 保存过 / 丢弃过之后两个判据都假 ⇒ 递归一次就落到 `openExternalEditorNow()`。
    if (!editing && live && (live.isEditing() || live.isDirty())) {
      liveAskSwitch(baseName(S.state.currentPath || ''), function () { openExternalEditor(); });
      return;
    }
    return openExternalEditorNow();
  }

  /** ⭐ `⌘E` 真正干活的那一半（上面那个函数负责"要不要先问一句"）。 */
  async function openExternalEditorNow() {
    try {
      await T.call('open_in_external_editor');
      setStatusT('status.external-opened', null, false);
    } catch (e) {
      setStatusT('status.external-failed', {
        msg: e.wording || e.message,
        path: e.path ? t('common.in-parens', { path: e.path }) : '',
      }, true);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // ⭐ 窗口内编辑（`design/0012`）——编排层
  //
  // ⚠️ 这个文件里**判据一律不写**：白名单的派生在 `editor/keys.js`、
  //    三档调度在 `editor/preview.js`、保存的单飞与"清脏前重判"在 `editor/save.js`。
  //    本节只做三件事：**接 DOM、发 IPC、把两个真值对齐**。
  //    理由与 `services/reload.js` 一模一样（`design/0002` §7.0：
  //    只在真窗口里能验的东西**不算验证**，所以判据必须留在可 `node --test` 的纯逻辑里）。
  // ════════════════════════════════════════════════════════════════════

  /** 编辑提示带上那行字（`#edit-note`）：信封提示、失败说明…空串 = 不显示。 */
  function setEditNote(text) {
    // ⭐ 配方留一份：这行文字是 `envelopeNote` 现算的，换语言要跟着重画（§2.5.1 ②）。
    editNoteRepaint = null;
    const el = $('edit-note');
    if (el) el.textContent = text || '';
  }

  /** 编辑提示带上那行字（`#edit-status`）：保存结果。⚠️ `isError` 决定它是不是红的。 */
  function setEditStatus(text, isError) {
    const el = $('edit-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  /**
   * ⭐ 信封的常驻提示（`INV-EDIT-12` ② / §2.4-5）。
   *
   * ⚠️ `lossy` 由**后端算**（`document/envelope.rs` 那段注释：不让前端自己判
   *    `eol === 'other'`——那是本设计的语义，抄一份就是"改一处忘一处"）。
   *    这里⛔ **不重新判一遍**，只把后端给的那个布尔翻成人话。
   */
  function envelopeNote(env) {
    if (!env) return '';
    const parts = [];
    if (env.lossy) parts.push(t('edit.envelope-eol'));
    if (env.bom) parts.push(t('edit.envelope-bom'));
    return parts.join(' · ');
  }

  /** ⭐ 信封提示按**后端给的布尔**重画（换语言时用；`env` 来自那次进编辑态的授权）。 */
  function setEnvelopeNote(env) {
    setEditNote(envelopeNote(env));
    editNoteRepaint = function () { return envelopeNote(env); };
  }

  /** 脏标记变化（⭐ `Ed.createEditor` 的 `updateListener` 是它**唯一**的来源）。 */
  function onEditDirty(dirty) {
    editDirty = dirty;
    const el = $('edit-dirty');
    if (el) el.hidden = !dirty;
    // ⚠️ 它**不进状态条**：状态条那一行是"这份文档的摘要"（`mountDocument` 写的），
    //    拿它显示"有未保存改动"会让摘要一闪一闪。
    //    它的可见形态是编辑提示带上那个 ● ，它的可断言形态是 `report.editor_dirty`。
  }

  /**
   * 预览那一栏的提示条（⭐ `onStale` 是它**唯一**的写入点，`INV-EDIT-11`）。
   *
   * @param {boolean} stale 缓冲是不是已经跑在预览前面了
   * @param {string} tier `'A'|'B'|'C'`
   */
  function syncPreviewBar(stale, tier) {
    const bar = $('preview-bar');
    const text = $('preview-text');
    const btn = $('preview-now');
    if (!bar) return;
    if (!stale) {
      bar.hidden = true;
      return;
    }
    bar.classList.toggle('is-stale', tier === 'C');
    text.textContent = tier === 'C'
      ? t('edit.preview-stale-c')
      : t('edit.preview-stale-ab');
    // ⚠️ 按钮**只**在档 C 出现：A/B 档下它是多余的（不用点也会更新），
    //    而多一个几乎永远不该点的按钮就是在教用户忽略这个位置。
    btn.hidden = tier !== 'C';
    bar.hidden = false;
  }

  /**
   * ⭐ **未保存修改的决策条**（`design/0012` §6）。
   *
   * ⚠️ 为什么不是 `window.confirm`：本项目**不给前端 `dialog:*` 权限**
   *    （`src-tauri/src/gui/mod.rs:885` 与 `commands/fs.rs:275` 都写明了理由），
   *    而 `confirm` 在 WKWebView 里到底可不可用**从来没验过** ⇒ ⛔ 不赌它。
   *    ⭐ 用行内条子还有个好处：它**不抢焦点**——用户正在打字，弹一个模态框
   *    会把「中文输入法正在组合的那一段」直接弄丢（`INV-SET-05` 的同族）。
   *
   * ⚠️ 存的是**键**不是译文（`design/0025` §2.5.1 ②）：这条带子可能一直挂着
   *    而用户在别处切了语言，存译文就等于把它冻在旧语言里。
   *
   * @param {string} key 一句话说清发生了什么（字典键）
   * @param {object} [vars] 模板参数
   * @param {Array<{label:string, run:Function}>} actions 按钮（`label` 也是字典键，顺序即显示顺序）
   */
  function askEdit(key, vars, actions) {
    editPromptState = { key: key, vars: vars || null, actions: actions };
    syncEditPrompt();
  }

  /** 把 `editPromptState` 画出来。⚠️ 按钮的 click **自己**清状态后再动手。 */
  function syncEditPrompt() {
    const bar = $('edit-prompt');
    const textEl = $('edit-prompt-text');
    const actEl = $('edit-prompt-actions');
    if (!bar || !textEl || !actEl) return;
    const s = editPromptState;
    actEl.textContent = '';
    if (!s) { bar.hidden = true; return; }
    textEl.textContent = t(s.key, s.vars);
    s.actions.forEach(function (act) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t(act.label);
      b.addEventListener('click', function () {
        // ⚠️ **先清再动手**：动作里可能又调一个会 `askEdit` 的东西
        //    （比如"保存后继续"失败时那条提示），
        //    反过来写会让那条新提示被这次清除顺手抹掉。
        editPromptState = null;
        syncEditPrompt();
        try { act.run(); } catch (e) { console.error('决策条动作抛错：', e); }
      });
      actEl.appendChild(b);
    });
    bar.hidden = false;
  }

  /**
   * ⭐ **有未保存修改时，一切"会把它弄丢"的动作都要过这道闸**（`INV-EDIT-06`）。
   *
   * ⚠️ 四种场景共用它（§6 那张表）：退出编辑 / 切换文档 / 重载 / 外部编辑器。
   *    ⛔ 不许各写一份——那种"看起来一样的四份"正是 `design/0017` 那次事故的形状。
   *
   * @param {string} askKey 问句的字典键（⛔ 不是"会被做什么"的半句——见 §2.2.1）
   * @param {object} [askVars] 问句的参数
   * @param {Function} proceed 用户选了"丢/存"之后真正要做的事
   */
  function promptLeaveEdit(askKey, askVars, proceed) {
    askEdit(askKey, askVars, [
      {
        label: 'edit.act-save-continue',
        run: function () {
          saveNow().then(function (out) {
            if (out) { proceed(); return; }
            // ⚠️ 保存失败 ⇒ ⛔ **不许**继续：那会变成"以为存了、其实丢了"。
            setEditStatus(t('edit.save-failed-cancelled'), true);
          });
        },
      },
      { label: 'edit.act-discard-continue', run: proceed },
      { label: 'common.cancel', run: function () { setEditStatus(t('edit.cancelled'), false); } },
    ]);
  }

  /** ⭐ **唯一的保存入口**（`INV-EDIT-10`）：`⌘S`、按钮、将来的 `:w` 全走这里。 */
  async function saveNow() {
    // ⭐ `design/0047` §2.8：**就地编辑这条路不经过分栏那个保存器**（这时 `editorSave` 是 null）。
    //    ⚠️ 判据是"live 有没有在编辑、有没有没写盘的提交"，⛔ 不是"`editing` 为假"：
    //       覆盖层退出之后用户照样可能按 `⌘S`，那时脏内容还在 live 的会话里
    //       （`INV-LIVE-11` ④ 的另一半——写会话不在，提交栈还在）。
    if (!editing && live && (live.isEditing() || live.isDirty())) return liveSaveNow();
    if (!editing) {
      // ⚠️ 阅读态按保存键**不该是无声的**：`file.save` 是全局动作，
      //    而"按下去什么都没发生"与"保存成功了但没提示"在界面上长得一样。
      setStatusT('status.not-editing', null, true);
      return null;
    }
    const btn = $('btn-save');
    // ⭐ §2.4-4 明写"前端同时**禁用保存按钮**"：`save.js` 里那道单飞闸防的是
    //    "发出去两次"，这个 `disabled` 防的是"用户能按下去"——两件事。
    if (btn) btn.disabled = true;
    try {
      return await editorSave.save();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * ⭐ 用**编辑缓冲**渲染右侧预览（§2.1 ② / §2.6）。
   *
   * ⚠️ 注入 DOM 走的是**同一个** `mountDocument`（`adr/0003`：⛔ 不新增第二个
   *    `innerHTML` 注入点）。⚠️ 但它**不**做"打开一份新文档"该做的事：
   *    ⛔ 不重置滚动、⛔ 不在树里重新定位（每敲几下就把树展开一遍是纯浪费，
   *    而且会让侧边栏在打字时不停地抖）。
   */
  async function renderPreviewOnce(req) {
    const t0 = performance.now();
    const payload = await S.renderPreview(editor.text(), req);
    mountDocument(payload, { keepScroll: true, noReveal: true });
    // ⭐ **预览提交是唯一"锚点与 DOM 同时换掉"的时刻**（§11.7）⇒ 折线必须重建，
    //    而且必须在这一行**之后**（`toc` 与右侧 DOM 此刻才是同一份文本的）。
    // ⚠️ 顺序反了的表现是"改完标题之后，同步从那一处起一直偏"——静默的。
    syncTextAhead = false;
    if (syncDriver) syncDriver.rebuild();
    return { ms: performance.now() - t0, payload: payload };
  }

  /**
   * ⭐ 起始档位的依据（§2.6-2）——**用已经量到的那几个数**，⛔ 不"先渲一次看看"。
   *
   * `render_preview` 那一趟 = **解析（T2）＋ 渲染（T3）＋ DOM 注入（T5）＋ 强制布局（T5b）**，
   * 只少了 T1（读盘）——而那四个数在**上一次打开/重载这份文档**时就已经量到手了。
   * ⚠️ 外推是有代价的（预览的文本与磁盘那份不完全一样），所以它只是**起始档位**，
   *    第一次真渲完之后立刻按实测覆盖（`preview.js` 的 `fire` 里那一段）。
   * ⚠️ 少了任何一段就按最快的档起步：**宁可先多渲一次，也不要一进编辑就卡用户**。
   */
  function previewInitialMs() {
    const p = (S.state.currentDoc) || {};
    const o = lastOpen || {};
    const parts = [p.t2_ms, p.t3_ms, o.t5_ms, o.t5b_ms];
    if (parts.some(function (x) { return typeof x !== 'number' || !isFinite(x); })) return 0;
    return parts.reduce(function (a, b) { return a + b; }, 0);
  }

  /**
   * ⭐ **进入编辑态**（§2.4-1：授权动作 = 用户按下"进入编辑"）。
   *
   * 顺序有讲究（踩过就知道）：
   * ① 先**问后端拿授权与文本**——拿不到就什么都不改，界面上⛔ 不留半个编辑面；
   * ② 再挂 `body.editing` —— ⚠️ 必须**早于** `mount()`：CM6 建 `EditorView` 时
   *    要量 DOM，容器还在 `display:none` 里时量出来是 0×0，
   *    表现是"编辑区一片空白、光标点不进去"（比报错难查得多）；
   * ③ 最后挂缓冲。
   */
  async function enterEdit() {
    if (editing) return true;
    if (!S.state.currentDoc) {
      setStatusT('status.no-doc-edit', null, true);
      return false;
    }
    // ⭐ 自证没过就**不让进**：放进去只会得到一个"看起来在编辑、其实按不动"的界面，
    //    而那个界面**不报错**——正是 `edit_ok` 那条判据要挡的形态。
    if (!editSelfCheck.ok) {
      setStatusT('status.edit-unavailable', { note: editSelfCheck.note }, true);
      return false;
    }

    let grant;
    // ⭐ `design/0017` §10 的实施偏差（**登记在案**）：进编辑态之前也冲刷一次。
    //    ⚠️ 设计 §2.3 ④ 只列了"切文档 / 隐藏 / 卸载"三处，但编辑态下 `scroll`
    //       监听是**早退的**（`onReadingScroll` 第一句），而 `#doc` 在分栏里换成了
    //       另一个滚动容器 ⇒ "滚一下马上点编辑"那次位置会丢。
    //    ⚠️ **不 await**：`flush` 的函数体在第一个 `await` 之前就同步取好了锚点，
    //       这里等它只会让"点编辑"多卡最多 400 ms。顺序仍然安全——
    //       `begin_edit` 不改 `current_document` / `doc_seq`，迟到的写入照样被接受。
    flushReadingProgress().catch(function () {});
    try {
      grant = await S.beginEdit();
    } catch (e) {
      setStatusT('status.edit-enter-failed', {
        msg: e.wording || e.message,
        path: e.path ? t('common.in-parens', { path: e.path }) : '',
      }, true);
      return false;
    }
    editGrant = grant;

    // —— ② 三栏布局 + 输入焦点让开 ——
    document.body.classList.add('editing');
    editing = true;
    // ⭐ `design/0037`：折叠态下进编辑态 ⇒ **先把顶栏收回来**。
    //    `design/0012` §2.1⑤ 要求编辑态必须有**可见**的退出控件，而那个按钮在顶栏里；
    //    折叠着进编辑态（例如用 `⌘E`）会让"怎么退出"变成一道隐藏题。
    setChromeHidden(false);
    // ⚠️ 「外部改动已定案」是**上一次编辑会话**的判断（§6 表里那一行）：
    //    带着它进新会话 = 这一整段时间里的外部改动都**不再提示**，
    //    而用户上一次选的是"保留我当时那份修改"，与现在缓冲里的内容无关。
    externalChangeSettled = false;

    // —— ③ 挂编辑面 ——
    if (!editor) {
      editor = Ed.createEditor({
        CM6: window.rmdCM6,
        host: $('editor-host'),
        onDirtyChange: onEditDirty,
        // ⭐ **预览调度的唯一入口**（`preview.js::markEdited`，§2.6-3）。
        //    ⚠️⚠️ 必须挂 `onDocChanged`（**每一次**改动都响），
        //    ⛔ **不能**挂 `onDirtyChange`（只在脏状态**翻转**时响一次）——
        //    后者会让"改第一个字之后，后面每一个字都不再重排防抖"，
        //    而**屏幕上一点异常都没有**。2026-10-16 之前**根本没有过这一行**：
        //    编辑态的自动重渲与陈旧提示条因此从未生效（`docs/bugs/0004`）。
        //    ⚠️ `editorPreview` 在这一刻**还是 `null`**（它在本函数下面才建），
        //    所以必须判空；⛔ 也⛔ **不许**为了省这个判空把它的创建挪到上面去——
        //    `previewInitialMs()` 要的是**这一份文档**刚量出来的那四段耗时。
        onDocChanged: function () {
          if (editorPreview) editorPreview.markEdited();
          // ⭐ **缓冲从此领先于预览**（§11.7）：`toc` 里那些行号属于**上一次渲染**的文本，
          //    再拿它们配右侧标题的位置就不是同一个东西了 ⇒ 折线降级成按比例。
          //    ⚠️ 恢复的时机只有一个：`renderPreviewOnce` 提交完（见那一处）。
          syncTextAhead = true;
          if (syncDriver) syncDriver.schedule();
        },
        // ⭐ `design/0014`：Vim 那 4 项的**取值函数**（⛔ 不是一份现成的扩展）。
        //    ⚠️ 必须是**取值函数**：开关关着时也要能后来才装上（`Compartment.reconfigure`），
        //    而"先要一份、后来再要一份"在 `editor/main.js` 里被记忆化成同一个实例
        //    （⛔ 每次开关都重建的话，寄存器/宏/上次的模式会跟着换一份，`INV-VIM-07`）。
        //    ⚠️ 这里**只 build，⛔ 不装 `:w`/宿主键位**——那两件在 `setupEditorVim()` 里
        //    做一次（它们与"哪一次挂载"无关）。
        buildVim: function () {
          if (!window.rmdCM6 || typeof EdVim.build !== 'function') return [];
          return EdVim.build(window.rmdCM6, { status: true });
        },
      });
    }
    // ⭐ 裁定 (a)：挂载时带上**当前**的开关值（来自 `config.json` 的 `vim_mode`，
    //    经 `theme.applied` 进来的）。⚠️ 冷启动时 Vim 若不在这里生效，
    //    用户看到的是"设置里明明开着、进编辑态却是普通编辑"——而**没有任何提示**。
    editor.mount(grant.text, forwardExt, { vimOn: !!(theme && theme.applied.vimMode) });

    // ⭐ 保存器**每次进编辑态重建**：它闭包里握着 `editor` 与那一个会话的
    //    `onClean`——跨会话复用会把"上一份文档的脏标记"接到这一份上。
    editorSave = EdSave.createSaver({
      getText: function () { return editor.text(); },
      rev: function () { return editor.revision(); },
      send: function (text) { return S.saveDocument(text, ++editReqSeq); },
      onStatus: setEditStatus,
      onClean: function () { editor.markClean(); editorPreview.markSaved(); },
      onDone: function (out) { editLastSave = out; },
      isMounted: function () { return editing && !!editor && editor.isMounted(); },
    });

    // ⭐ 调度器同样每次重建：它的**起始档位**由**这一份文档**的实测耗时决定。
    editorPreview = EdPrev.createScheduler({
      render: renderPreviewOnce,
      onStale: syncPreviewBar,
      initialMs: previewInitialMs(),
      isMounted: function () { return editing && !!editor && editor.isMounted(); },
    });

    // ⭐ 信封那条**常驻**提示（`INV-EDIT-12`）：行尾不统一的文件保存后会被统一成 LF，
    //    这件事⛔ 不能等到保存完才让用户知道。
    setEnvelopeNote(grant.envelope);
    setEditStatus(t('edit.entered', { name: baseName(grant.real_path) }), false);
    // ⚠️ 显式复位一次预览提示条：上一次会话留下的"已过期"不该挂到这一次上。
    syncPreviewBar(false, editorPreview.tier());
    // ⭐ 刚进来时缓冲与预览**是同一份内容**（预览就是拿磁盘那份渲的）⇒ 不是陈旧。
    //    `preview.js` 的 `renderSeq` 起始值是 `-1`，而 `syncStale` 只在
    //    `markEdited` / `fire` 里被调 ⇒ 这时**没有任何提示条**，正是要的形态。
    syncEditToggle();
    // ⭐ **挂在最后**：`syncDriver` 要问"挂着的渲染对不对得上当前源码"，
    //    而那要 `editorPreview` 与 `syncTextAhead` 都已经是这一副会话的值。
    //    ⚠️ 此刻 `syncTextAhead` 是 `false`（刚 `begin_edit`，预览就是磁盘那份渲的）
    //    ⇒ 折线一上来就是**带锚点**的，⛔ 不是先按比例再慢慢爬上去。
    syncStart();
    return true;
  }

  /**
   * ⭐ **退出编辑态**（§2.4-2 ⑤：⛔ 不触发预览重渲——文本没变）。
   *
   * ⚠️ ⛔ **不恢复正文**：预览那一栏现在是"缓冲的渲染结果"，而它与磁盘上的内容
   *    在**没有脏标记**时是同一份（`INV-EDIT-12` 的 no-op 短路保证过这件事）。
   *    重新 `reload_document` 一次只是白读一遍盘，还会把滚动位置抖一下。
   */
  async function exitEdit() {
    if (!editing) return;
    if (editorPreview) { editorPreview.cancel(); editorPreview = null; }
    // ⚠️ **顺序**：先拆同步、再销毁 view。反过来的话 driver 撤监听时那些元素
    //    已经被 CM6 拆掉了（`removeEventListener` 不报错，但观察器还挂在
    //    一个正在死掉的节点上，而 `#doc` 是**活的**——它的监听必须被撤掉）。
    syncStop();
    if (editor) editor.unmount();
    // ⚠️ 顺序：先销毁 view，再撤掉三栏。反过来会让 CM6 在一个 `display:none`
    //    的容器里做最后一次度量（它在 `destroy` 里仍会拆自己挂的那些观察器）。
    document.body.classList.remove('editing');
    editing = false;
    editGrant = null;
    editorSave = null;
    // ⚠️ 与 `enterEdit` 那一处配对：这一位只在**一次编辑会话内**有效。
    //    留着它的话，下一次进编辑态时的第一次外部改动会**静默地不提示**。
    externalChangeSettled = false;
    // ⚠️ `unmount()` 已经让 `isDirty()` 变回 false 并推过一次 `onDirtyChange`，
    //    这里只是**把界面上的残影扫干净**（提示带那两行字）。
    setEditNote('');
    setEditStatus('', false);
    syncPreviewBar(false, 'A');
    syncEditToggle();
    // ⚠️ 后端**不返回错误**（重复调用是常态，`edit.rs` 写着），但 IPC 本身可能失败
    //    （ACL 少一条）——那要**说出来**：否则"写授权一直挂着"是个静默的旧真值。
    try {
      await S.endEdit();
    } catch (e) {
      console.warn('⛔ 撤销写授权失败（后端可能还握着它）：', e);
    }
  }

  /**
   * 工具栏那两个按钮的显隐（阅读态只露「编辑」，编辑态只露「保存」）。
   *
   * ⚠️⚠️ 这里**必须连 `title` 一起写**（`design/0025` §2.5.1 ①③）：`#btn-edit` 在
   * `index.html` 里带 `data-i18n="editor.enter"` + `data-i18n-title="editor.enter-title"`，
   * 而 `applyDom` 每次换语言都会按**静态**那两条把它写回"进入编辑"。进了编辑态之后
   * 那个按钮的文字是这句函数写的（`退出编辑`）⇒ 不跟着写回 `title`，换语言会得到
   * 「Done Editing」+ 一个说"进入编辑"的 tooltip。`setLang` 的顺序是
   * applyDom → 订阅者，所以订阅者（本函数）最后写、写赢。
   */
  function syncEditToggle() {
    const edit = $('btn-edit');
    const save = $('btn-save');
    if (edit) {
      edit.textContent = editing ? t('editor.exit') : t('editor.enter');
      edit.title = editing ? t('editor.exit-title') : t('editor.enter-title');
    }
    if (save) save.hidden = !editing;
    // ⚠️ 退出编辑时 `save.js` 那道单飞闸不会自己松开——它每次进编辑态都是新的一个，
    //    但**按钮的 `disabled` 是 DOM 上的**，所以这里显式复位一次。
    if (save) save.disabled = false;
  }

  /** 工具栏「编辑 / 退出编辑」。 */
  function toggleEdit() {
    // ⭐ `design/0047` §4.2：覆盖层里按 `⌘E` ＝ **换到分栏继续改**（⛔ 不是"退出编辑"）。
    //    ⚠️ 这里必须是"提交 + 转场"，⛔ 不是 `leaveLive()`：直接退出会让用户以为
    //       那一下点击把这一段交还给了阅读态——而屏幕上的正文还没重渲完，
    //       他按下去的下一件事很可能是继续敲字，那时已经没有编辑视图接住了。
    if (!editing && live && live.isEditing()) {
      liveSerial(liveToSplitEdit);
      return;
    }
    if (!editing) { enterEdit(); return; }
    if (editDirty) { promptLeaveEdit('edit.ask-exit', null, exitEdit); return; }
    exitEdit();
  }

  /**
   * ⭐ **磁盘上的文件变了，而编辑面有未保存内容**（§6 表里"最怕的一种"）。
   *
   * ⚠️ 这是**状态机**不是一行判断（设计原话）：`reloadCurrentDocument` 那条
   *    "自动重载"的路在编辑态里**必须让位**——直接重载会拿磁盘那份覆盖缓冲，
   *    用户刚敲的字**无声消失**。
   */
  function promptExternalChange() {
    askEdit('edit.external-changed', null, [
      {
        label: 'edit.act-reload-disk',
        run: async function () {
          await exitEdit();
          await reloadCurrentDocument('reload.reason.external');
          await enterEdit();
        },
      },
      {
        label: 'edit.act-keep-mine',
        run: function () {
          setEditStatus(t('edit.kept-mine'), false);
          // ⚠️ 之后**不再重复弹**：用户已经表过态了，而每次外部改动都弹一次
          //    会把他困在这条带子上（他在编辑时那个文件其实是静止的）。
          externalChangeSettled = true;
        },
      },
    ]);
  }

  /**
   * ⭐ 编辑态下把**缓冲**换成磁盘上那一份。
   *
   * ⚠️ **只有不脏的时候才允许调**：脏 ⟹ 缓冲里有磁盘上没有的东西，
   *    换掉就是**无声地丢掉用户敲的字**。⚠️ 所以这里有第二道防御（调用方已经判过一次）
   *    —— 这种"丢了就找不回来"的操作值得多一道。
   *
   * ⚠️ 走的是 `begin_edit` 的**刷新**语义（`edit.rs` 那段：再调一次会把文本与基线
   *    **一起**换新，旧的未保存内容不保留）——⭐ 正是我们要的，因为此刻不脏。
   *    ⛔ **不是**"退出再重进编辑态"：那会连三栏布局一起拆掉重建，
   *    而这一点点外部改动不该让整个界面闪一下。
   * ⭐ 源栏的光标与滚动位置**保住**（`mount` 的 `keepCursor`）：换掉的是整份缓冲，
   *    ⛔ 不保的话表现是"每次外部保存，光标跳回第一行"——编辑期最难受的一类干扰。
   *    ⚠️ 恢复是**尽力而为**：偏移量不带"它指着哪段文字"的信息，外部改动动过光标
   *    **之前**的内容时落点会偏（固有限度，见 `editor/main.js::mount` 的注释）。
   */
  async function refreshEditBuffer() {
    if (!editing || editDirty) return;
    let grant;
    try {
      grant = await S.beginEdit();
    } catch (e) {
      setEditStatus(t('edit.disk-read-failed', { msg: e.wording || e.message }), true);
      return;
    }
    editGrant = grant;
    editor.mount(grant.text, forwardExt, { keepCursor: true });
    setEnvelopeNote(grant.envelope);
    setEditStatus(t('edit.switched-to-disk'), false);
    // ⚠️ 换了文本就是"预览与缓冲可能不一致了"，但两者此刻**是同一份内容**
    //    （预览就是拿磁盘那份渲的）⇒ 显式复位，别让上一次的"已过期"挂在这一份上。
    syncPreviewBar(false, editorPreview ? editorPreview.tier() : 'A');
  }

  /** 键盘/按钮进入编辑态之前的那道自证 —— 只在 `setupEdit` 里跑一次。 */
  function runEditSelfTest() {
    editSelfCheck = Ed.selfTest(window.rmdCM6, forwardCheck.specs, document);
    if (!editSelfCheck.ok) console.error('⛔ 编辑功能自证没过：', editSelfCheck.note);
    else console.log('编辑功能自证：', editSelfCheck.note);
    if (!forwardCheck.ok) {
      console.error('⛔ 转发白名单有该报的项：', forwardCheck.note);
    }
  }

  /**
   * ⭐ `design/0014`：编辑态 Vim 的**装配**——`setupEdit` 里调一次。
   *
   * ⚠️ **在这里做、⛔ 不塞进 `buildVim`**：那一个是**取值函数**（`editor/main.js::取VimExt`
   * 会把它记忆化），而 `:w` / 宿主键位都是**模块级的登记**，与"哪一次挂载"无关
   * ⇒ 放进去会让"没进过编辑态就没装 `:w`"这种接缝变得可发生。
   *
   * ⚠️ 两件事都**幂等**（`installEx` 是赋值、`hostKeys` 有自己的标记），
   * 所以重复调无害；但它们**不是**同一形态——理由写在 `src/editor/vim.js` 的注释里。
   */
  function setupEditorVim() {
    const CM6 = window.rmdCM6;
    // ⚠️ bundle 不在（`make cm6` 没跑）/ 旧产物里没有 `Vim` ⇒ **什么都不做，⛔ 不抛**：
    //    自证那一步（`Ed.selfTest` 的 ④）已经把这一条报出来了，
    //    这里再炸一次只会多一个噪声，而且会让**没有 Vim 的构建**连编辑态都进不去。
    if (!CM6 || !CM6.Vim || typeof EdVim.build !== 'function') {
      console.warn('没有 Vim 装配面（`make cm6` 跑过吗？）—— Vim 开关会点了没反应，`:w` 也不会注册');
      return;
    }
    // ⭐ 裁定 (b)：`:w` **只调既有保存入口**（`INV-VIM-03`）——授权 / 冲突检查 /
    //    组合态保护全是那条路自带的，⛔ 这里不开第二条写路径。
    //    ⚠️ 递的是**取值函数**而不是当前那一个实例：保存器**每次进编辑态重建**
    //    （`exitEdit` 还会把它置回 `null`）⇒ 递一份快照的话，第二次编辑态里 `:w`
    //    写的就是**上一个会话**的保存器，而它闭包里的 `onClean` / `rev` 都是旧的。
    EdVim.installEx(CM6.Vim, function () {
      if (!editorSave) return;  // 不在编辑态（或已退出）⇒ Vim 那时也不在，正常路径到不了这儿
      editorSave.save();
    });
    // ⭐ 裁定 (e)：`⌃K` / `⌃H` 的宿主键位适配（幂等）。
    EdVim.hostKeys(CM6.Vim);
    // ⭐ 裁定 (a)：开关的**两个消费者**里编辑面这一个——它只**订阅**，⛔ 不持有状态
    //    （状态住在 `theme.applied.vimMode` 里，因为设置覆盖层那个复选框也要读它，
    //    而那个东西在**没进编辑态时**就得能勾上）。
    theme.subscribe(function () {
      // ⚠️ 还没建过编辑面 ⇒ 什么都不用做：下一次 `mount` 会带上 `vimOn`。
      //    ⛔ 别在这里去建一个 `EditorView`——那不在本设计的边界内。
      if (!editor) return;
      editor.setVim(theme.applied.vimMode);
    });
  }

  /**
   * ⭐ 2026-10-20（用户点题「Vim 模式要在一个显眼的地方，选择打勾。快速开关。」）：
   * **顶栏那个复选框**的接线。
   *
   * ⚠️ 它⛔ **不是第二个真源**：勾选态只读 `theme.applied.vimMode`，写只走
   *    `theme.setVimMode()`（全应用唯一写入口）。设置覆盖层里那个复选框与它
   *    是**同一个状态的两张脸**——两边都只被 `theme.subscribe` 回填。
   *    ⛔ 别在这里自己攒一个 `vimOn` 变量：那会让"设置里关掉、顶栏还勾着"变成可能。
   *
   * ⚠️ 它**与 bundle 在不在无关**：没有 Vim 装配面时这个开关仍然能勾、能持久化
   *    （下一次带 bundle 的构建照常生效），⛔ 所以不放进 `setupEditorVim` 的早退之后。
   */
  function setupVimToggle() {
    const box = $('vim-toggle');
    if (!box) return;
    function sync() { box.checked = theme.applied.vimMode === true; }
    box.addEventListener('change', function () { theme.setVimMode(box.checked); });
    theme.subscribe(sync);
    sync();
  }

  // ════════════════════════════════════════════════════════════════════
  // ⭐ 阅读—编辑连续性：接线（`design/0047`）
  //
  // ⚠️⚠️ 这一段里**一条判据都没有**：块表、行号↔偏移换算、提交栈、身份复核、输入状态机
  //    全在 `src/live/**`（那半边在 `node --test` 里跑得到，`INV-LIVE-17`）。
  //    这里只做四件事——① 把真 DOM / 真 CM6 / 真 IPC 注进控制器；
  //    ② 把 `#doc` 的节点与块表对齐；③ 把用户的动作翻成控制器调用；④ 把控制器的话翻成界面文字。
  //    ⛔ 别把"什么时候能进""身份对不对"写进本文件：`main.js` 不进 `tests/js/`，
  //    写在这里的判据**任何断言都碰不到**（与 `design/0002` §7.0 同一条纪律）。
  // ════════════════════════════════════════════════════════════════════

  /** `config.live_edit`（§8，默认 **关**）。⚠️ 关着 ⇒ 单击不进覆盖层，行为与 `0012` 逐字相同。 */
  function liveOn() {
    return !!(S.state && S.state.liveEdit === true);
  }

  /**
   * 块级闸门的**初值**（§7.1 的 0f 还没跑出 p50/p95 ⇒ 这两个数是外推初值）。
   * ⚠️ 超过它**不是缺陷**：提示语会把用户指到分栏（`status.live-block-too-large`）。
   */
  const LIVE_LIMITS = { maxBlockLines: 2000, maxBlockBytes: 256 * 1024 };

  /** 最近一次 `save_document` 的回包（`{written, bytes, ms}`）——只为状态条那一行。 */
  let liveLastSaveOut = null;

  /**
   * ⭐ **所有 live 动作走同一条串行链**（`INV-LIVE-11` ④ 的落地）。
   *
   * ⚠️ 为什么必须有：`begin` / `commit` / `leave` / `save` 全是 `async`，而"点另一块"
   *    本身就是 **commit ＋ begin** 两件事，`⌘S` 又是 **commit ＋ 写盘**。两条链并行时
   *    会出现**同一时刻两个写会话**——`begin_edit` 再调一次是"刷新"语义（会把文本与基线
   *    一起换新），于是前一条链手里的缓冲被**静默换掉**，`INV-EDIT-06` 那道闸形同虚设。
   * ⚠️ 链尾**必须**挂一个吞拒绝的空 `then`：一次失败不能让整条链变成永久 rejected
   *    （那之后每一次 `liveSerial` 都静默不执行，界面上是"点了没反应、也没有报错"）。
   */
  let liveChain = Promise.resolve();
  function liveSerial(fn) {
    const run = liveChain.then(function () { return fn(); });
    liveChain = run.then(function () {}, function () {});
    return run;
  }

  // ── ⭐ `⌘↵`：跳出当前块，在它后面新起一段（`bugs/0024` / `design/0052` U7）────────
  //
  // ⚠️⚠️ 2026-10-28 **用户更正了这条需求**，原文：
  //    「`⌘Enter` 表示跳出当前引用块，在块后创建新的正文段落，并将真实编辑光标放到该段落，
  //      保持编辑状态与输入焦点；不是退出到阅读态后等待按键重新进入。`Enter` 继续引用。」
  //    ⇒ 2026-10-27 那套 `caretHint`（退出到阅读态 ＋ 自绘一根 `.rmd-caret-hint` ＋
  //      敲字再进来）**是错误需求的实现，已整体撤回**：阅读态里根本没有真光标，
  //      "画一根假的再等按键"既不是用户要的，也没法带 IME 候选窗。
  //
  // ⭐ 新做法（细节与三步理由在 `live/index.js::newParagraph`）：
  //    提交当前块 → 列表里插三行空行 → 用一个**临时 `<p>` 宿主**开一个新段落视图，
  //    光标落在段首 ⇒ **视图一直开着、焦点一直在离屏输入层上**，IME / 撤销 / 打字全都是真的。
  //
  // ⚠️ 为什么是三行空行，⛔ 不是一行：comrak 把**相邻非空行并进同一段**。
  //    只插一行的话，用户敲的第一个字会跟上面的引用块或下面的正文**合并**——
  //    屏幕上表现为"新写的字跑进了引用块里"。
  //
  // ⚠️ 那个 `<p>` 是**临时宿主**：空行在 comrak 里不是块，所以这一块只存在于视图开着的
  //    这段时间里。下一次整篇重渲（提交 / 保存 / 重载）它就不在了，`reseat` 也⛔ 不许去碰它
  //    （`live.isNewParagraph()` 为真时跳过），而一个字都没敲就退出时
  //    `leave()` 会把那三行**原样撤回**（⛔ 不在用户文件里留空行）。

  /**
   * ⭐ 给「新起的一段」造一个临时宿主：插在刚离开那一块**之后**。
   *
   * ⚠️ 用 `<p>` 而不是 `div`：`.doc` 的版面规则按标签写（`bugs/0015` 那一族踩过
   *    "换上去之后 `margin-bottom` 与 `padding-left` 凭空消失"）。
   * @param {object|null} prev 刚离开那一块的渲染节点
   * @returns {object|null}
   */
  function pendingHost(prev) {
    if (!prev || !prev.parentNode) return null;
    const host = document.createElement('p');
    host.className = 'rmd-pending-block';
    prev.parentNode.insertBefore(host, prev.nextSibling);
    return host;
  }

  /** `⌘↵` 的唯一实现入口。⚠️ 调用方负责把它放进 `liveSerial`（串行链）。 */
  function startNewParagraph() {
    if (!live) return Promise.resolve(false);
    return live.newParagraph();
  }

  /**
   * 有没有覆盖层开着（`design/0038` 起只有这一份判据，⛔ 别在各处再抄一遍）。
   * ⚠️ 读的是 `settings` / `quickOpen` / `findBar` / `imageViewer` **此刻的值**——
   *    它们在启动页那一步还是 `null`（`setupKeys` 才建）⇒ 启动页那边也必须包着它调，
   *    ⛔ 不许把结果**先算好**再传。
   */
  function overlayOpen() {
    return !!(
      (settings && settings.isOpen()) ||
      (quickOpen && quickOpen.isOpen()) ||
      (findBar && findBar.isOpen()) ||
      (imageViewer && imageViewer.isOpen())
    );
  }

  /** live 的接线（控制器 / 文档级监听）。⚠️ 在 `setupEdit()` **之后**调一次。 */
  function setupLive() {
    // ⭐ 开关关着就**一条监听都不挂**：那是 `0047` §8 的回滚路径，⛔ 不是"半开着"。
    if (!liveOn()) return;
    if (!window.rmdCM6) {
      // ⚠️ bundle 不在 ⇒ 整条路不可用。⛔ 不弹提示：`edit_ok` 自证会报（`status.edit-unavailable`）。
      console.log('就地编辑不可用：CM6 bundle 没加载（先跑 make cm6）');
      return;
    }
    if (!LC || typeof LC.createController !== 'function') {
      console.log('就地编辑不可用：src/live/index.js 没加载（检查 index.html 的脚本顺序）');
      return;
    }
    live = LC.createController({
      t: t,
      // ⚠️ 控制器交过来的是**已经翻好的**整句（`§2.2.1`：⛔ 不在接线层拼半句）。
      //    ⭐ **等级由控制器显式给**（评审第 19 条）：以前这里按首字是不是 `⛔` 推断，
      //    于是"改一个译文字"就能改掉界面语义，而且没人守那条约定。
      //    ⚠️ 控制器那边只有 `fail()` / `note()` 两个出口（源码闸门钉着 `report(` 恰好两处）。
      report: function (msg, isError) {
        const s = String(msg === undefined || msg === null ? '' : msg);
        setStatus(s, isError === true);
      },
      announce: function (msg) {
        if (liveAnnouncer) liveAnnouncer.announce(msg);
      },
      beginEdit: function () { return S.beginEdit(); },
      // ⚠️ 控制器传的 `{discard}` 后端**不认**（`end_edit` 无参）——丢弃发生在内存那一侧。
      endEdit: function () { return S.endEdit(); },
      // ⭐ `design/0054`：`verify`（候选结构校验请求）必须**原样透传**——
      //    它只是搭在同一趟渲染上的一个可选字段，⛔ 别在这里丢掉（丢了就是"回包没有验，
      //    而前端又读不到 `verify` ⇒ 每次单元格提交都被判 `verify-missing`"）。
      renderPreview: function (a) { return S.renderPreview(a.text, a.req, a.verify); },
      saveDisk: function (a) {
        return S.saveDocument(a.text, ++liveSaveReq).then(function (out) {
          liveLastSaveOut = out;
          return out;
        });
      },
      // ⭐ 提交点**只经 `mountDocument`**（`INV-LIVE-14`）：⛔ 这里不许另开一条注入路径。
      mount: function (payload, o) { mountDocument(payload, { keepScroll: !!(o && o.keepScroll) }); },
      makeView: makeLiveView,
      swap: swapLiveView,
      /**
       * ⭐ **块序号 → 当前这一棵树里的节点**。
       * ⚠️⚠️ 控制器在 `begin()` 里可能**先 `leave()` 再进入**（点另一块 / 换块），
       *    而 `leave()` 会提交 ⇒ `render_preview` ⇒ `mountDocument` ⇒ `#doc.innerHTML` 整棵换掉
       *    ⇒ 调用方手里那个 `el` 在那一刻就已经**脱树**了。拿它继续走：
       *    ① `getComputedStyle` 对脱树节点返回空串 ⇒ 盒子一颗都不搬；② `heightOf` 量成 0
       *    ⇒ 必被几何闸门拒；③ `el.parentNode` 是 null ⇒ 宿主根本挂不上去。
       *    ⇒ 提交之后**按序号从新树重取**（对齐表在 `noteLive` 里已经刷新过）。
       */
      nodeOf: function (index) { return slotNode(index); },
      /**
       * ⭐ **给「`⌘↵` 新起的一段」造一个临时宿主**（`bugs/0024`）。
       * ⚠️ 为什么宿主由接线层造：空行在 comrak 里**不是块**，所以这一块的 DOM 只能是我们
       *    自己插的占位节点；控制器只认「节点 ＋ 行区间」，⛔ 不需要知道它是怎么来的。
       */
      pendingHost: pendingHost,
      /**
       * ⭐ **块序号 ＋ 扁平格序号 → 新树里的那一格**（`design/0049`）。
       * ⚠️ 与 `nodeOf` 同一族：控制器在"点另一格 / `Tab` 走格"时会先 `leave()` 再进入，
       *    而 `leave()` 会提交并整篇重渲 ⇒ 调用方手里那个 `<td>` 已经脱树。
       * ⚠️ 表格在、格子不在 ⇒ 返回 `null`（控制器会据此报"对不上"，⛔ 不猜一个节点）。
       */
      cellNodeOf: function (index, flat) { return cellNodeOf(index, flat); },
      // ⚠️ 用 `getBoundingClientRect().height`（**分数像素**），⛔ 不是 `offsetHeight`：
      //    后者两侧各自四舍五入到整数 ⇒ 差值最多被虚增 **1 px**，而"变矮"告警的阈值只有 **0.5**
      //    ⇒ "本来就对得上"的块会被报成变矮（2026-10-26 实测：802 行块真实差 40.28，
      //    取整后成了 41，凭空多出 0.72 px）。
      heightOf: function (el) { return el ? el.getBoundingClientRect().height : 0; },
      limits: LIVE_LIMITS,
    });
    const doc = $('doc');
    // ⚠️ **不加 capture**：`selection.js` 在覆盖层内部是 capture ＋ `stopPropagation`，
    //    所以"点在正在编辑的那一块上"结构上到不了这里（⛔ 不需要我们再判一次）。
    if (doc) doc.addEventListener('mousedown', onLiveDocDown);
    // ⭐ 焦点丢了也要退得出去（理由与三条闸在 `onLiveGlobalKey` 的头注释里）。
    //    ⚠️ `capture` 是**硬要求**：要赶在 `input` 那一条之前判"这次事件是不是它的"。
    document.addEventListener('keydown', onLiveGlobalKey, true);
  }

  /**
   * 正文那一栏的**内容盒宽度**（离屏建视图时唯一的宽度来源）。
   *
   * ⚠️ 必须减掉内边距：`clientWidth` 含 padding，而 CM6 的 `.cm-content` 宽度是内容盒
   *    ⇒ 直接用 `clientWidth` 会让软换行点偏右、块高量出来偏小。
   */
  function liveHostWidth() {
    const doc = $('doc');
    if (!doc) return 0;
    const cs = window.getComputedStyle(doc);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const cw = doc.clientWidth - pad;
    return cw > 0 ? Math.round(cw) : 0;
  }

  /**
   * 建一个**块视图**（§2.3 步骤 ③ / §5.1 那条**独立封闭**的白名单）。
   *
   * ⚠️⚠️ 这里装的每一项都要能在 §5.1 表里找到（`INV-LIVE-11` ②）：
   *    ⛔ `defaultKeymap` / `standardKeymap` / `basicSetup` / `drawSelection` /
   *    `@codemirror/search` / `historyKeymap` 一个都不许进来——它们自带键位，
   *    而"谁处理哪个键"由本文件自己分派（应用键走 `forwardShim`，编辑键走 live）。
   *
   * @param {{text:string, lineOffset:number}} req
   * @returns {{dom:object, lines:Function, height:Function, destroy:Function, focusAt?:Function}}
   */
  function makeLiveView(req) {
    const CM6 = window.rmdCM6;
    const text = String(req && req.text !== undefined ? req.text : '');
    const lineOffset = (req && req.lineOffset) || 0;
    // ⚠️ **被换掉的那一块**（`#doc` 的直接孩子）。离屏量高时就要把它的盒子搬过来，
    //    否则等高校验比的是"有内边距的 `blockquote`"与"没有内边距的 `div`"⇒ 永远差一截。
    const el = (req && req.el) || null;
    // ⭐ `design/0049`：单元格形态——只换 `<td>` 的**孩子**，`el` 是那一格。
    const isCell = !!(req && req.cell);
    // ⭐⭐ `design/0054` `INV-EDITOBJ-01/02`：**这个编辑对象的策略**（唯一声明处
    //    `src/live/objects.js`）。下面四件事全部读它，⛔ 不许在本函数里再各判一半：
    //    ① 盒子搬不搬（`obj.box`）② 装饰层只按行内语义不（`obj.inlineOnly`）
    //    ③ `Tab`/`Enter` 走格还是退出/换行（`obj.tab`/`obj.enter`）
    //    ④ 文本入口的约束（`obj.text`，交给 `createInputMachine`）。
    //    ⚠️ `isCell` 仍然留着——它判的是**几何与 DOM 形状**（换 `<td>` 的孩子、
    //    冻结表宽、只换一行），那是"这一个视图怎么装"，⛔ 不是对象契约。
    const obj = LObj.policyOf({ cell: req && req.cell });
    const kindCls = LBox && typeof LBox.classNameOf === 'function' ? LBox.classNameOf(el) : '';
    // §4.4：代码块**不装软换行**（长行横滚，⛔ 不让它折断缩进结构）。
    // ⚠️⚠️ 单元格**要装**（2026-10-28 更正，此前写的是"也不装"）：不装的形态是
    //    比列宽长的字在右边缘被 `overflow-x: clip` **整段切断**、光标跑到格子外面，
    //    用户看到的是"打字打不进去、方向键也没用"（字其实进去了、光标其实在动）。
    //    当初不装的理由是"一换行就会把整张表撑高（`INV-CELL-04`）"——**那条理由已经作废**
    //    （`bugs/0035`，2026-10-28 需求变更）：格子里的换行现在**保留**，
    //    `CELL.text` 原样放行、提交时 `cell.js::encode` 把它写成 `<br>`，
    //    而阅读态的 `<td>` 本来就把那个 `<br>` 排成第二行 ⇒ 两边行数一致，表格照旧不跳
    //    （判据 `Q14b` 判的就是"编辑态高度 == 阅读态两行"）。
    //    视觉软换行不改一个字节，而**阅读态的 `<td>` 本来就软换行** ⇒ 两边高度一致，
    //    表格不会因为进入编辑而跳（判据 `Q20`/`Q21`）。
    const code = kindCls.indexOf('cm-rmd-code') >= 0;

    // ⭐ host 是**我们自己的 div**（⛔ 不是 `view.dom`）：`.cm-rmd-liveHost` 那一族样式
    //    全是后代选择器，而离屏标记也挂在它身上 ⇒ 换进文档流的东西必须是它。
    const host = document.createElement('div');
    host.className = isCell
      ? 'cm-rmd-liveHost cm-rmd-cell cm-rmd-offscreen'
      : 'cm-rmd-liveHost cm-rmd-offscreen' + kindCls;
    // ⭐ 把被换掉那一块的**盒子**（外边距 / 内边距 / 左边框 / 圆角 / 底色）搬到 host 上
    //    ——⚠️ 少了它，`margin-bottom` 与 `padding-left` 这两样**任何判据都看不见**，
    //    用户看到的是"点一下，下面全文往上蹦 15.4px、列表整体往左跳"。理由见 `live/box.js`。
    //    ⚠️ 单元格**不搬**：`<td>` 的内边距由表格自己出，搬进 host 会与 `.cm-rmd-cell`
    //       那几条打架，而且格子里的内容本来就不该带块级外边距。
    if (obj.box && LBox && typeof LBox.applyBox === 'function') LBox.applyBox(host, el);
    // ⚠️ 离屏期间父容器**不是** `.doc`（`position: fixed`）⇒ `width: auto` 会算成
    //    `max-content`，软换行点与正文不一致 ⇒ 高度必然对不上（`live.css` §1b）。
    //    ⇒ 显式给内容盒宽度，swap 时再清掉。
    //    ⚠️ 单元格不给：它的宽度就是那一格的宽度（由 `<td>` 决定），给死宽度反而与列宽打架。
    if (!isCell) {
      const w = liveHostWidth();
      if (w > 0) host.style.width = w + 'px';
    }
    document.body.appendChild(host);

    // ⭐⭐ **表格布局冻结**（`INV-CELL-04`）：进入编辑前把列宽写死，退出逐像素还原。
    //    ⚠️ 少了它，格子里敲一个字就可能让整张表重排（列宽跟着内容走）——
    //    用户看到的正是"编辑期间表格在跳"，而块级那套几何判据**看不见**它（量的是 `<td>`）。
    //    ⭐ 实现在 `cell.js::freezeTableLayout`（2026-10-29 代码评审第 15 条搬过去）：
    //    那里 `make typecheck` 查得到、`live-cell.test.js` 用假节点跑得到。这里只接线。
    //    ⚠️ `isCell` 来自 `req.cell`，⛔ 不是"LCell 说它是格子" ⇒ 这里要自己判 `LCell`
    //       在不在（其余调用点同口径，别让脚本没加载变成一次 TypeError）。
    const thaw = isCell && LCell ? LCell.freezeTableLayout(el) : null;

    // ⚠️ 顺序：软换行（段落/标题/列表/引用）→ 语法 → 装饰 → 通知 → 只读 → 不可聚焦。
    //    代码块那一条由上面 `code` 决定是否装（§4.4），⛔ 不是两份清单。
    //
    // ⭐⭐ `measuring`：**Prep 量高期间一律不展开活动行**。
    //    理由（2026-10-26 实测出来的口径缺陷）：Prep 时选区恒在 0 ⇒ 第 0 行是"活动行"
    //    ⇒ 它按规则 2 显示源码、比渲染态**多折一行**（英文长段实测 **+23.797 px**）
    //    ⇒ 带行内标记的段落/所有引用块/所有代码块**一律过不了** 0.5 的等高校验
    //    （用户点了没反应，状态条报「这一块的高度对不上」）。
    //    ⇒ 量高时按"**全部标记都藏起来**"量（＝ `notes/0037` 原型的计量条件），
    //      换进文档流的那一刻（`swapLiveView`）再放开活动行。
    //    ⚠️ 放开之后活动行确实会让这一块**变高一点**——那是 L2「源码可见」的**固有代价**，
    //      ⛔ 不是量错；F6 要求的是"编辑期间只有输入在动"，而这一刻是**进入**的那一下。
    let measuring = true;
    const extensions = [];
    if (!code) extensions.push(CM6.EditorView.lineWrapping);
    // ⚠️⚠️ **必须显式换 `base`**（`design/0052` U3）：`markdown()` 的默认 base 是
    //    `commonmarkLanguage`（**纯 CommonMark，没有 GFM**）⇒ `~~删~~` 在语法树里根本
    //    不是 `Strikethrough` 节点，装饰层就藏不掉它的 `~~`。
    //    `markdownLanguage` = `commonmark.configure([GFM, Subscript, Superscript, Emoji])`，
    //    ⚠️ 后三条是 comrak **不支持**的方言 ⇒ 那三类节点**故意不进隐藏白名单**，
    //    差异登记给 U9 的差分表（`src/live/decorations.js` 的 `HIDDEN_MARK` 那段）。
    extensions.push(CM6.markdown({ base: CM6.markdownLanguage }));
    // ⭐⭐ 撤销 / 重做**归 CM6 的 `history()`**（`design/0052` U2）：分组、选区随撤销恢复、
    //    重做栈语义都由内核给，`src/live/` 不再自己记一份快照栈。
    //    ⚠️ 它**不绑任何键位**（`historyKeymap` 仍不装）：`⌘Z` / `⇧⌘Z` 由本文件的
    //    `onKeyDown` 分派到 `CM6.undo(view)` / `CM6.redo(view)`（A 栏命令，`INV-KERNEL-02`）。
    //    ⚠️ 历史仍然**随视图销毁结束**（`design/0047` §4.6）：换块就是换 `EditorState`，
    //    退出编辑态之后只能撤到上一次提交 —— 本单元换的只是"块内那部分怎么写"。
    extensions.push(CM6.history());
    // ⭐ 藏 Markdown 标记的装饰层：**块级装饰必须走 `StateField`**
    //    （`ViewPlugin` 一抛 `RangeError` 就整块白屏，`decorations.js` 文件头规则 1）。
    //    ⚠️⚠️ `createField` 返回的是 `[StateField, EditorView.decorations.from(...)]`
    //    ——只 push 前者等于**一个标记都藏不掉**（`decorations.js` 那一段的长注释）。
    extensions.push(LMarks.createField(CM6, {
      activeLineIndexes: function (state) {
        if (measuring) return [];
        return LMarks.activeLineIndexes(state);
      },
      // ⭐ 块基线是**标题尺度**时（被换掉的是 `h1`–`h6`），非标题的行要回落成正文尺度
      //    —— 否则表头往下一敲回车，新行还是 28px/700（`bugs/0015`）。
      //    ⚠️ 尺度本身仍只有样式表一处来源：回落类 `cm-rmd-body` 用的是同一批 `--reader-*`。
      bodyLines: !!(LBox && typeof LBox.headingLevelOf === 'function' && LBox.headingLevelOf(el) > 0),
      // ⭐⭐ 单元格：**只按行内语义呈现**（2026-10-28 评审 P2-③）。格子是从全文里切出来
      //    单独解析的 ⇒ `# 普通格子` 在树里是 `ATXHeading1`，装饰层照块级规则贴 `cm-rmd-h1`
      //    ⇒ 点进去字号/行高当场变掉，而阅读态 `<td>` 里它就是七个字。
      //    ⚠️ 修法**不是**"看见井号就跳过"（那只是这一个符号的特例），而是让整格按
      //    `markers()` 的 `cellContext` 走：不认标题/引用/围栏/代码块，只留行内强调与链接。
      cellContext: obj.inlineOnly,
    }));
    extensions.push(CM6.EditorView.updateListener.of(function (update) {
      if (update.docChanged || update.selectionSet) afterUpdate();
    }));
    // ⭐⭐ `contentDOM` **不可编辑、不可聚焦**（`INV-LIVE-12`）：
    //    `editable(false)` 把 `contenteditable` 关掉，浏览器⛔ 再也写不进一个字节
    //    ⇒ 组合串只能停在 preedit 覆盖层上（用户 2026-10-26 的 F6 强需求）。
    extensions.push(CM6.EditorView.editable.of(false));
    extensions.push(CM6.EditorView.contentAttributes.of({ tabindex: '-1', 'aria-hidden': 'true' }));

    const view = new CM6.EditorView({
      state: CM6.EditorState.create({
        doc: text,
        extensions: extensions,
      }),
      parent: host,
    });

    // ⭐ **输入事件的唯一来源**（§2.7）：离屏 `textarea`。⚠️ 它只负责产出事件，
    //    自己那份文本**每条事件之后都清空**（组合期除外）——真相永远只在 CM6 的 doc 里。
    const input = document.createElement('textarea');
    input.className = 'cm-rmd-input';
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    // ⚠️ `tabindex=-1`：⛔ 不进 Tab 序（Tab 要能离开这一块），但 `focus()` 仍然可用。
    input.setAttribute('tabindex', '-1');
    input.setAttribute('aria-hidden', 'true');
    document.body.appendChild(input);

    let sel = { anchor: 0, head: 0 };
    /** 上下移动的目标列（像素无关，UTF-16 列；`selection.js::vertical` 的口径）。 */
    let goal = null;
    let destroyed = false;
    let frame = 0;
    let preeditEl = null;
    /** 组合串上一帧量的是**哪一行**的排版（同一个元素就不重复量，见 `syncPreeditMetrics`）。 */
    let preeditLine = null;

    const machine = LIn.createInputMachine(onTransaction, obj);
    const layer = LSel.createLayer(view, CM6);
    const a11y = LA11y.attach(host, { t: t, lineOffset: lineOffset });
    liveAnnouncer = a11y;

    // ── 小工具 ──────────────────────────────────────────────────────

    /**
     * ⭐ **这个视图的文本**（提交与身份复核都按行）。
     */
    function splitLines(s) {      const M = window.rmd.liveModel;
      if (M && typeof M.splitLines === 'function') return M.splitLines(s);
      return String(s === undefined || s === null ? '' : s).split('\n');
    }

    function clampPos(n) {
      if (!Number.isInteger(n)) return 0;
      return Math.max(0, Math.min(n, view.state.doc.length));
    }

    function selectedText() {
      const r = LSel.range(sel);
      if (r.from === r.to) return '';
      return view.state.doc.sliceString(r.from, r.to);
    }

    /** 把按钮/角标的位置量递给下一帧：`coordsAtPos` 是一次几何测量，⛔ 不在 dispatch 里做。 */
    function scheduleAfter() {
      if (frame || destroyed) return;
      frame = window.requestAnimationFrame(function () {
        frame = 0;
        if (destroyed) return;
        placeInput();
        layer.refresh();
        ensureVisible();
      });
    }

    /** 把离屏 `textarea` 挪到插入符那一格（IME 候选窗跟着它走）。 */
    function placeInput() {
      const c = view.coordsAtPos(sel.head);
      if (!c) return;
      input.style.left = Math.round(c.left) + 'px';
      input.style.top = Math.round(c.top) + 'px';
      input.style.height = Math.max(1, Math.round(c.bottom - c.top)) + 'px';
    }

    /** 插入符跑出视口 ⇒ 滚一点点（⛔ 不居中：那会让正文每次敲字都跳一下）。 */
    function ensureVisible() {
      const c = view.coordsAtPos(sel.head);
      if (!c) return;
      const pad = 64;
      const top = c.top;
      const bottom = c.bottom;
      if (top < pad) window.scrollBy(0, top - pad);
      else if (bottom > window.innerHeight - pad) window.scrollBy(0, bottom - window.innerHeight + pad);
    }

    function syncSel() {
      const m = view.state.selection.main;
      sel = { anchor: m.anchor, head: m.head };
      a11y.sync(view.state.doc, sel);
    }

    /** 文档或选区变了之后的**唯一**收尾（⛔ 别在多处各写一半）。 */
    function afterUpdate() {
      if (destroyed) return;
      syncSel();
      layer.refresh();
      scheduleAfter();
    }

    function clearInput() {
      if (input.value !== '') input.value = '';
      try { input.selectionStart = 0; input.selectionEnd = 0; } catch (e) { void e; }
    }

    /**
     * ⭐ 光标所在的**那一行**（`.cm-line`）—— 组合串的排版基准。
     *
     * ⚠️ `domAtPos` 是**按行**解析的（`Text.lineAt` 对行末位置返回本行）
     *    ⇒ 停在标题行末尾时拿到的仍是标题行，⛔ 不会跳到下一行。
     * @returns {object|null}
     */
    function caretLineEl() {
      try {
        const at = view.domAtPos(sel.head);
        let n = at && at.node ? at.node : null;
        while (n && n.nodeType !== 1) n = n.parentNode;
        if (n && typeof n.closest === 'function') return n.closest('.cm-line');
      } catch (e) { void e; }
      return null;
    }

    /**
     * ⭐⭐ 组合串的**排版权重必须跟光标所在那一行**走，⛔ 不是跟 host 走。
     *
     * 为什么不能靠继承（2026-10-29 用户实测）：host 上搬来的是**块级**文字层
     * （`live/box.js` 量的是被换掉的那一个元素）⇒ 标题块里从第二行起是**正文**尺度
     * （`.cm-line.cm-rmd-body`），而 host 仍是标题尺度。覆盖层挂在 host 上
     * ⇒ 拼音按标题字号画、上屏之后却按正文排。用户原话：
     * 「在标题下面一行输入的时候，拼音落地的字体虽然是正文，正常，但是拼音的字很大。」
     * ⚠️ 代码块同理：等宽字体住在**行**里（`.cm-rmd-code` 的那一档 mono），host 上是 sans。
     * ⚠️ 仍然**量**、⛔ 不在样式表里另写一份数值（`INV-LIVE-07`：样式表是唯一来源）。
     * @param {object} el `.cm-rmd-preedit` 覆盖层
     */
    function syncPreeditMetrics(el) {
      const src = caretLineEl() || view.contentDOM;
      if (!src) return;
      // ⚠️ 同一行就不重量：组合期每次 `compositionupdate` 都会走到这里，
      //    而 `getComputedStyle` 是一次强制样式解析。
      if (src === preeditLine) return;
      preeditLine = src;
      const cs = window.getComputedStyle(src);
      el.style.fontSize = cs.fontSize;
      el.style.lineHeight = cs.lineHeight;
      el.style.fontFamily = cs.fontFamily;
      el.style.fontWeight = cs.fontWeight;
    }

    /** 组合串画在**覆盖层**上（⛔ 不进文档——这一条就是 F6）。 */
    function paintPreedit(text2) {
      const s = String(text2 === undefined || text2 === null ? '' : text2);
      if (!s) {
        if (preeditEl && preeditEl.parentNode) preeditEl.parentNode.removeChild(preeditEl);
        preeditEl = null;
        preeditLine = null;
        return;
      }
      if (!preeditEl) {
        preeditEl = document.createElement('span');
        preeditEl.className = 'cm-rmd-preedit';
        host.appendChild(preeditEl);
      }
      // ⚠️ 先对齐排版再写文字：上屏的字落在**这一行**，拼音就得按这一行的尺度画。
      syncPreeditMetrics(preeditEl);
      preeditEl.textContent = s;
      const c = view.coordsAtPos(sel.head);
      if (!c) return;
      const base = host.getBoundingClientRect();
      preeditEl.style.left = Math.round(c.left - base.left) + 'px';
      preeditEl.style.top = Math.round(c.top - base.top) + 'px';
    }

    /**
     * 这次删除（`⌫` / `⌦` / `⌥` / `⌘`）要删掉哪一段。
     *
     * ⚠️⚠️ **纯逻辑已搬到 `live/selection.js::deleteRange`**（2026-10-27，`bugs/0014`）：
     *    它原来住在这里 ⇒ `main.js` 加载期就要整个应用，node 一条判据都够不到
     *    ⇒ 里面读了一个**不存在**的字段（`LSel.range()` 不返回 `head`）也没人发现。
     *    现在 node 侧把 8 条分支全钉住了，这里只剩"把当前选区递进去"。
     */
    function deleteRange(doc, forward, byWord, byLine) {
      return LSel.deleteRange(doc, sel, { forward: forward, byWord: byWord, byLine: byLine });
    }

    // ── 事务 / 撤销 ─────────────────────────────────────────────────

    /** ⭐ 状态机的唯一出口：**已归一化**的 `{from, to, next}` → 一条 CM6 事务。 */
    function onTransaction(tx) {
      if (destroyed) return;
      const from = clampPos(tx.from);
      const to = Math.max(from, clampPos(tx.to));
      const insert = (tx.next || []).join('\n');
      // ⚠️ 这里**不再**压撤销快照：`history()` 已经在扩展里（见上面），
      //    它按"时间 + 邻近性"给改动分组 —— 一次连续输入 = 一次撤销，与系统惯例一致。
      view.dispatch({
        changes: { from: from, to: to, insert: insert },
        selection: { anchor: from + insert.length },
      });
      goal = null;
    }

    /**
     * ⭐ 撤销 / 重做是 CM6 的两个**命令**（`design/0052` U2 / `INV-KERNEL-01`）。
     *
     * ⚠️ 它们只改 `EditorState`，⛔ 不碰输入层：键仍由离屏 `textarea` 收
     * （`INV-KERNEL-04`），命令返回 `false` 时说明历史栈已空。
     * ⚠️ `updateListener` 会跟着这次 dispatch 跑 `afterUpdate()`（重画装饰 + 同步选区），
     * 所以这里⛔ 不要自己再 `scheduleAfter()` 一遍。
     */
    function undoOnce() {
      // ⭐ 先撤**键级**（CM6 历史）；键级空了，才轮到「`⌘↵` 新起一段」那**一整步**
      //    （`bugs/0024`，2026-10-28：「一次撤销恢复操作前内容与光标」）。
      //    ⚠️ `resolveUndo` 的纪律不变：⛔ 一次 ⌘Z 绝不跨层——这里是"这一层空了才换下一层"。
      const done = CM6.undo(view);
      if (done) return true;
      if (live && typeof live.isNewParagraph === 'function' && live.isNewParagraph()) {
        liveSerial(function () { return live.undoNewParagraph(); });
        return true;
      }
      return false;
    }

    function redoOnce() {
      return CM6.redo(view);
    }

    // ── 键盘 ────────────────────────────────────────────────────────

    /**
     * ⭐ **应用键从后端那张表现认**（`INV-SET-01`）：`K.matchEvent` 命中就交给
     * `forwardShim.forward(id)` —— 那正是编辑区分栏在用的同一条垫片，
     * `ctx.editable()` 在转发期间返回 `false`，于是 `keymap.dispatch` 照常执行。
     * ⛔ 这里**不许**出现第二个白名单，也⛔ 不许出现键位字面量（源码级闸门盯着 `src/**`）。
     */
    function onKeyDown(ev) {
      if (destroyed) return;
      const composing = machine.state.composing || ev.isComposing === true;
      if (composing) {
        // ⚠️ 组合期**一个键都不接**：`Esc` 由输入法自己取消，方向键是候选窗的。
        //    ⛔ 也别在这里放应用键——`⌘S` 在组合期会把半截组合串连文档一起写出去。
        return;
      }
      const id = (keymap && K.matchEvent(keymap.bindings, ev)) || null;
      if (id) {
        ev.preventDefault();
        // ⭐⭐ `⌘A` **由这一块自己认领**（`bugs/0036`，2026-10-29）。
        //    ⇒ 就地编辑态的"全选"只能是**这一块**：选区住在单块视图里，
        //      跨块选区是 `design/0053` 的题目（那份设计状态仍是 `待评审`）。
        //    ⚠️ 别改成转发——全局 handler 选的是**正文全文**，那会在编辑中途把选区拉走、
        //      而光标（`sel` / `textarea` 的焦点）仍留在块内，两边当场不一致。
        if (id === 'edit.select-all') {
          view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
          return;
        }
        if (forwardShim) forwardShim.forward(id);
        else console.error(`就地编辑：按键转发垫片没建好（应用键「${id}」按不动）`);
        return;
      }

      // ⚠️⚠️ 修饰键**只从 `K.modifiers()` 取**（`INV-SET-01` 的源码级闸门：
      //    `metaKey` / `ctrlKey` / `altKey` 这四个标识符只许出现在 `services/keymap.js`）。
      //    ⛔ 别在这里写 `ev.metaKey`——那会被判成"又藏了一份键位表"。
      const mods = K.modifiers(ev);
      // ⭐ **单元格里 `Tab` 走格**（`design/0049` §4）。
      //    ⚠️ 这条**必须早于**下面那条裸 `Tab` 分支：那条是"提交并退出"。
      //    ⚠️ `⌘↵` 不在这里接（`mods.cmd` 挡掉了）——它是**退出**，走下面那条既有分支。
      //    ⭐ `design/0054`：判据来自**对象策略**（`obj.tab` / `obj.enter`），⛔ 不是这里的 `isCell`。
      if (obj.tab === 'walk' && ev.key === 'Tab') {
        ev.preventDefault();
        navigateCell(ev.shiftKey ? -1 : 1);
        return;
      }
      // ⭐⭐ **`Enter` 在格子里现在也是换行**（`bugs/0035`，2026-10-28 用户需求变更）：
      //    用户原话「表格编辑还是不能换行，enter 键无法换到下一行，直接到表格的下一行中了」
      //    ⇒ `CELL.enter` 从 `'walk'` 改成 `'newline'`，落进下面那条裸 `Enter` 分支，
      //    由状态机插入真换行；提交时 `cell.js::encode` 把它写成 `<br>`。
      //    ⚠️⚠️ 这一格**不能再折成空格**：折了就是 `bugs/0028` 那个"输入与提交不一致"
      //    ——屏幕上换行了、源码里没有换行。两者的口径现在由 `encode`/`decode` 一对逆变换兜住。
      //    ⚠️ 于是这一段 `enter === 'walk'` 眼下**两张策略表都不命中**（块与格子都是
      //    `'newline'`）。留着是因为 `design/0054` §2.1 的契约表里 `enter` 仍是四件事之一
      //    ——将来若有"按 Enter 走格"的对象（例如下一版的表格行编辑），改动只落在策略表。
      if (obj.enter === 'walk' && (ev.key === 'Enter' || ev.key === 'NumpadEnter') && !mods.cmd) {
        ev.preventDefault();
        navigateCell('down');
        return;
      }
      const doc = view.state.doc;
      let cmd = null;
      switch (ev.key) {
        case 'ArrowLeft': cmd = mods.alt ? 'wordLeft' : 'charLeft'; break;
        case 'ArrowRight': cmd = mods.alt ? 'wordRight' : 'charRight'; break;
        case 'ArrowUp': cmd = mods.cmd ? 'docStart' : 'lineUp'; break;
        case 'ArrowDown': cmd = mods.cmd ? 'docEnd' : 'lineDown'; break;
        case 'Home': cmd = mods.cmd ? 'docStart' : 'lineStart'; break;
        case 'End': cmd = mods.cmd ? 'docEnd' : 'lineEnd'; break;
        case 'PageUp': cmd = 'pageUp'; break;
        case 'PageDown': cmd = 'pageDown'; break;
        default: break;
      }
      // ⭐⭐ 上下移动走**视觉行**（`view.moveVertically`），⛔ 不走 `LSel.move` 的
      //    `lineUp`/`lineDown`：那两个按**逻辑行**算，而块与格子现在都装了软换行
      //    （`2026-10-28`）⇒ 一段折成五行时按一下 ↓ 会**直接跳到整块末尾**
      //    （`selection.js::vertical` 在 `target > doc.lines` 时就是 `doc.length`）。
      //    ⚠️ 这是给单元格装上换行之后**当场暴露**出来的另一半：用户那句
      //    「上下左右箭头，也没有用」的"上下"就落在这一条上。
      //    ⛔ 不装 `defaultKeymap`：这里只借它同一套**几何**，键位仍由本文件分派。
      //    ⚠️ 到边界（第一/最后一视觉行）⇒ **什么都不做**；⛔ 不改成"跳到隔壁格"——
      //       那是新的交互口径（走格已由 `Tab`/`Enter` 负责），要另开设计。
      if ((cmd === 'lineUp' || cmd === 'lineDown') && typeof view.moveVertically === 'function') {
        ev.preventDefault();
        const cur = view.state.selection.main;
        const next = view.moveVertically(cur, cmd === 'lineDown');
        if (next && Number.isInteger(next.head) && next.head !== cur.head) {
          view.dispatch({
            selection: { anchor: mods.shift ? cur.anchor : next.head, head: next.head },
          });
          goal = null;
        }
        return;
      }
      if (cmd) {
        ev.preventDefault();
        const next = LSel.move(doc, sel, cmd, { extend: mods.shift, goal: goal, pageLines: 10 });
        if (next) {
          goal = next.goal === undefined ? null : next.goal;
          view.dispatch({ selection: { anchor: next.anchor, head: next.head } });
        }
        return;
      }

      if (ev.key === 'Backspace' || ev.key === 'Delete') {
        ev.preventDefault();
        const forward = ev.key === 'Delete';
        const r = deleteRange(doc, forward, mods.alt, mods.cmd);
        if (r.to > r.from) {
          machine.handle({
            type: 'beforeinput',
            inputType: forward ? 'deleteContentForward' : 'deleteContentBackward',
            from: r.from,
            to: r.to,
          });
        }
        return;
      }
      // ⭐ `⌘↵` = **跳出当前块，在它后面新起一段**（2026-10-28 用户更正的需求，见文件头
      //    `pendingHost` 那一段的注释）：**不退出编辑态**，光标直接落在新段落里。
      //    ⚠️ 单元格里（`design/0049`）没有"新起一段"这回事（会把表格行拆散）⇒
      //    `newParagraph()` 返回 `false`，退回原来的"提交并退出"。
      //    ⚠️⚠️ **必须排在下面那个裸 `Enter` 之前**：`⌘↵` 的第一个条件就是 `key === 'Enter'`，
      //    放到后面等于永远到不了（2026-10-27 第一版就是这么写的）。
      if (mods.cmd && (ev.key === 'Enter' || ev.key === 'NumpadEnter')) {
        ev.preventDefault();
        liveSerial(function () { return startNewParagraph(); }).then(function (ok) {
          if (!ok) liveSerial(function () { return leaveLive({ reason: 'mod-enter' }); });
        });
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const r = LSel.range(sel);
        machine.handle({ type: 'beforeinput', inputType: 'insertLineBreak', data: '\n', from: r.from, to: r.to });
        return;
      }
      if (ev.key === 'Escape') {
        // ⭐ `Esc` = **提交并退出**（§2.5）。⚠️ 先 `cancel` 一次：真有组合态时
        //    那一步是"组合作废"，与系统行为一致（未上屏的字丢掉）。
        ev.preventDefault();
        machine.handle({ type: 'cancel' });
        clearInput();
        paintPreedit('');
        liveSerial(function () { return leaveLive({ reason: 'escape' }); });
        return;
      }
      if (ev.key === 'Tab') {
        // ⚠️ Tab **不吞含义**：它同样提交并退出，但焦点要**真的**离开这一块
        //    （可访问性的默认行为）⇒ 退出之后把焦点还给正文容器。
        ev.preventDefault();
        liveSerial(function () { return leaveLive({ reason: 'tab' }); });
        return;
      }
      if (mods.cmd && (ev.key === 'z' || ev.key === 'Z')) {
        ev.preventDefault();
        if (mods.shift) redoOnce(); else undoOnce();
        return;
      }
    }

    // ── 输入（`beforeinput` / `input` / `composition*` / 剪贴板）────────

    function currentRange() {
      return LSel.range(sel);
    }

    function onBeforeInput(ev) {
      if (destroyed) return;
      const t2 = ev.inputType || '';
      // ⚠️ 删除 / 换行 / 格式化 / 拖放**我们自己处理**：把它们放给 textarea 会先改掉
      //    它自己那份文本（于是 `data` 与文档就不是一回事了）。
      if (t2.slice(0, 6) === 'delete' || t2.slice(0, 6) === 'format'
        || t2 === 'insertLineBreak' || t2 === 'insertParagraph' || t2 === 'insertFromDrop') {
        ev.preventDefault();
        return;
      }
      // 其余（`insertText` / `insertFromPaste` 以外的普通输入）交给 `input` 那一支：
      // ⚠️ WebKit 各版本对 `beforeinput` 的支持不一致，**文档只认 `input` 这一条路**
      //    （`input` 在各版本上都发；`beforeinput` 只用来挡上面那几类）。
    }

    function onInput(ev) {
      if (destroyed) return;
      const composing = machine.state.composing || ev.isComposing === true;
      if (composing) {
        // ⭐ 组合期的 `input` 一律**不动文档**（F6）：组合结果只从 `compositionend` 进来。
        return;
      }
      const data = ev.data;
      // ⚠️ 非组合态：textarea 只是输入源 ⇒ 它自己那份文本立刻清掉（⛔ 别留着，
      //    否则下一次 `data` 会带上上一次的内容）。
      clearInput();
      if (data === null || data === undefined) return;
      const r = currentRange();
      machine.handle({ type: 'input', data: data, from: r.from, to: r.to });
    }

    function onCompositionStart() {
      const r = currentRange();
      machine.handle({ type: 'compositionstart', from: r.from, to: r.to });
    }

    function onCompositionUpdate(ev) {
      machine.handle({ type: 'compositionupdate', data: ev.data });
      // ⭐ preedit 画在覆盖层上——**文档一个字节都不动**，这是 F6 的判据所在。
      paintPreedit(ev.data);
    }

    function onCompositionEnd(ev) {
      const res = machine.handle({ type: 'compositionend', data: ev.data });
      clearInput();
      paintPreedit('');
      if (res && res.applied) {
        // ⚠️ 组合结束后光标要在**上屏文本之后**（`caretAfterComposition` 的口径）
        scheduleAfter();
      }
    }

    function onCopy(ev) {
      const text2 = selectedText();
      if (!text2) return;
      ev.preventDefault();
      if (ev.clipboardData) ev.clipboardData.setData('text/plain', text2);
      else if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text2);
    }

    function onCut(ev) {
      const text2 = selectedText();
      if (!text2) return;
      onCopy(ev);
      const r = currentRange();
      machine.handle({ type: 'beforeinput', inputType: 'deleteContentBackward', from: r.from, to: r.to });
    }

    function onPaste(ev) {
      ev.preventDefault();
      const r = currentRange();
      const text2 = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
      // ⭐⭐ **这里⛔ 什么都不折**（`design/0054` `INV-EDITOBJ-01`）。
      //    归一化（CRLF/裸 CR → LF）与**对象约束**都在
      //    `live/input.js` 的 `textIn()` 里、由策略表（`live/objects.js`）声明 ——
      //    ⚠️ 单元格那边的策略是**恒等**（`bugs/0035` 之后换行要真的保留，
      //    折行留给 `cell.js::encode` 写成 `<br>`）。
      //    同一条约束只许有一个声明处。⚠️ 这里原先写着 `isCell ? … : …`：
      //    那是同一件事的**第二份事实**，而且它只管粘贴一个入口
      //    （IME 上屏、`beforeinput` 插入都绕过去了）⇒ 正是 `INV-EDITOBJ-01` 要收掉的那一半。
      machine.handle({ type: 'paste', text: text2, from: r.from, to: r.to });
    }

    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('beforeinput', onBeforeInput);
    input.addEventListener('input', onInput);
    input.addEventListener('compositionstart', onCompositionStart);
    input.addEventListener('compositionupdate', onCompositionUpdate);
    input.addEventListener('compositionend', onCompositionEnd);
    input.addEventListener('copy', onCopy);
    input.addEventListener('cut', onCut);
    input.addEventListener('paste', onPaste);

    // ⭐ 阅读态那一次按下的手势（`bugs/0042`）：只给**这一次建视图**用，取走即清空。
    //    ⚠️ `released === true`（松手早于视图就绪）⇒ 不传 —— ⛔ 不许启动悬空拖动。
    const gesture = (pendingDown && pendingDown.released !== true) ? pendingDown : null;
    pendingDown = null;
    const uninstallMouse = LSel.installMouse(view, {
      onSelect: function (s) {
        sel = { anchor: s.anchor, head: s.head };
        a11y.sync(view.state.doc, sel);
        scheduleAfter();
      },
      focus: function () {
        // ⚠️ 鼠标点在覆盖层里也要把焦点给**离屏 textarea**（⛔ 不是 contentDOM）：
        //    否则紧接着敲的键会落到 `#doc` / body 上，一个都不进编辑。
        try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
      },
      gesture: gesture,
    });

    return {
      dom: host,
      lines: function () { return splitLines(view.state.doc.toString()); },
      /**
       * ⭐ **当前光标（块内偏移）**（`bugs/0024`）：`⌘↵` 跳出去之前记一下，
       * 撤销那一步时原样放回去（用户 2026-10-28 的验收：「一次撤销恢复操作前内容与光标」）。
       *
       * ⚠️⚠️ **必须取视图自己的选区**，⛔ 不许绕道 `LSel.range(sel)` 再取 `.head`
       *    （2026-10-28 探针实测踩过）：`range()` 归一化出的是 `{from, to}`，**没有 `head`**
       *    ⇒ 取到 `undefined`，`Number.isInteger` 一挡就退成 `caretPos: 0`，
       *    「一次 ⌘Z 恢复光标」静默变成「回到段首」——而 `W1`（新段落光标就是 `0`）照样全绿，
       *    整条缺陷在纯逻辑层与类型层都看不见（`main.js` 不在 `make typecheck` 范围里）。
       *    `tests/js/live-wiring.test.js` 有一条源码级判据钉住这一点。
       * @returns {number}
       */
      caret: function () { return view.state.selection.main.head; },
      /**
       * ⭐ 量高**前必须先逼 CM6 同步量一次**（`readMeasured()`）。
       * ⚠️⚠️ 理由（2026-10-26 实测，`design/0047` §10）：CM6 的行高表只在它自己的测量循环
       *    （rAF）里更新，而这里读的是一串**同步**代码 ⇒ 不逼它量，读到的是它**建视图那一刻**
       *    的估值：未渲染的行一律按 `HeightOracle` 硬编码的 **14 px** 算
       *    （真值 20.141 ⇒ 矮 30%）。表现是**凡是高过一个视口的块都进不来**。
       * ⚠️ 与 `styles/live.css` §1b 的 `visibility:hidden + left:0` **是一对**：
       *    那条让这块**落在窗口里**（CM6 只量窗口内的可见区间），这条让测量**现在就发生**。
       *    只做一条不够——两条都缺一半（实测过）。
       * ⚠️ 分数像素的理由同 `heightOf`。
       */
      height: function () {
        try { view.readMeasured(); } catch (e) { void e; }
        return host.getBoundingClientRect().height;
      },
      // ⚠️ 这里曾有一个 `slack()`（"量高期间多出来的高度上界"，几何闸门的允许量）。
      //    2026-10-27 `design/0052` U6 连同**拒收**一起删了：`INV-KERNEL-05` 定的是
      //    "块永远进得去"，没有上界就没有允许量，留着它就是**没有调用方的第二份算式**。
      //    ⚠️ 结构差本身仍有人记账：`live/decorations.js::layoutSlack()`（唯一实现）
      //    由 `make probe-live-block` 的 B-3b 印进判据说明里，⛔ 不再参与任何拦截。
      /**
       * ⭐ 量完了：放开"活动行显示源码"（`measuring`）。
       * ⚠️ **必须由 `swapLiveView` 在挂进文档流之前调**——挂上去的那一帧就该是最终形态，
       *    ⛔ 不要"先按量高的样子挂上、下一帧再展开"（那是一帧可见的跳动）。
       * ⚠️ 幂等：重复调用是空操作（`focusAt` 里也会走一次，那条路不必关心先后）。
       */
      endMeasure: function () {
        if (!measuring) return;
        measuring = false;
        // ⚠️ 必须发一次**选区事务**：装饰只在 `tr.docChanged || tr.selection` 时重建
        //    （`decorations.js::createField`），光翻标志位不会让视图重算。
        view.dispatch({ selection: { anchor: view.state.selection.main.head } });
      },
      /**
       * ⭐ 进入覆盖层时把插入符放到指定位置。
       * ⚠️ 控制器是在 swap **之后**才调它的 ⇒ 坐标就是真坐标，⛔ 不用自己减离屏偏移。
       *
       * 两种落点（`bugs/0024`）：
       *   `{pos: n}` ⇒ 块内偏移 `n`（`⌘↵` 新起一段用 `0`、撤销之后用记下的那个数）；
       *   `{x, y}`   ⇒ 用户点的那一处（走 `posAtCoords`）。
       */
      focusAt: function (point) {
        // ⚠️ 兜底：走的是同一段同步代码，正常情况下 `swapLiveView` 已经放开过了。
        if (measuring) {
          measuring = false;
          view.dispatch({ selection: { anchor: view.state.selection.main.head } });
        }
        let pos = 0;
        if (point && Number.isInteger(point.pos)) {
          pos = clampPos(point.pos);
        } else if (point && typeof view.posAtCoords === 'function') {
          const p = view.posAtCoords({ x: point.x, y: point.y });
          if (Number.isInteger(p)) pos = p;
        }
        view.dispatch({ selection: { anchor: pos } });
        sel = { anchor: pos, head: pos };
        try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
        placeInput();
      },
      /**
       * ⭐⭐ `design/0052` U6 的**锚定**：把"用户点的那一处"钉回原来的屏幕坐标。
       *
       * ⚠️ 为什么必须有它：几何闸门不再拒收（`INV-KERNEL-05`：块永远进得去）⇒
       *    块在编辑态变高/变矮都**直接上屏**，下面的内容跟着动。用户看到的不是"进不去"，
       *    而是"我点的那一行跑了"。补一次 `scrollTop` 就把它钉回去，代价远小于拒收。
       *
       * ⚠️⚠️ **宁可不补，也不乱补**（`design/0052` §4 的失败形态）：
       *    坐标读不到、或者差得离谱（> 一屏），就**原样返回**——乱补一次会让页面跳到别处，
       *    比"内容移动几行"糟得多。
       *
       * ⚠️ 必须放在 `requestAnimationFrame` 里：swap 那一刻 CM6 的布局表还是旧值，
       *    它的测量在自己那轮 rAF 里做（`readMeasured()` 那条注释是同一件事的另一面）。
       *    ⚠️ 调用前**再逼它量一次**（`readMeasured()`）：文档顶部偏移（`documentTop`）在
       *    离屏期是**别处**的值 ⇒ 不量就取，`coordsAtPos` 的 `top` 是错的，补丁会把页面送走。
       *
       * ⚠️⚠️ **要复查，不能只补一次**（2026-10-27 探针实测）：swap 那一帧里 CM6 的测量
       *    可能还没跟上（它自己的测量在**它那一轮** rAF 里做），第一次读出来的 `delta`
       *    可以接近 0，而下一帧布局落定后行顶已经差了 16 px（`probe-live-block` 的
       *    `B*-3b` 就是这么红的）。⇒ 补完**再等一帧复查**，直到 `|delta| ≤ 1` 或补满三次。
       *    ⛔ 不是"来回试"：每次只在差得动（≤ 一屏）时补，且次数有上界。
       *
       * ⚠️⚠️ **真值取渲染态的 `.cm-line`，⛔ 不是 `coordsAtPos`**（2026-10-27 第二次实测）：
       *    那一帧里 CM6 的高度表对这一块还是**估算值**，`coordsAtPos` 给的行顶与 DOM 里
       *    那一行的真实位置差 **16.375 px**——而它恰好和锚点基线的算法误差相抵，`delta`
       *    被算成 0，一次都不补（`B11` / `blankmd B2` / `longcode B2` / `tasks B8` 全红在
       *    这里）。用户看见的是 `.cm-line`，就按它的 `getBoundingClientRect()` 钉。
       *    兜底才退回 `coordsAtPos`（DOM 里找不到那一行时；理论上不会——它就在视口里）。
       *
       * @param {{y:number}} anchor 被点那一行的**行顶**（`swapLiveView` 按行高取模算出来的）
       */
      anchorAt: function (anchor) {
        if (!anchor || typeof anchor.y !== 'number') return;
        const target = anchor.y;
        const MAX_PASS = 3;
        let pass = 0;
        const step = function () {
          if (destroyed) return;
          if (pass >= MAX_PASS) return;
          pass += 1;
          try {
            try { view.readMeasured(); } catch (e) { void e; }
            const top = 光标行顶(view);
            // ⚠️ 读不到（`coordsAtPos` 对**还没量到**的位置返回 `null`）⇒ 再等一帧
            //    （不是"放弃"：它下一帧就有了；放弃会让这一块整块错位，而这正是要修的那件事）。
            if (top === null) { requestAnimationFrame(step); return; }
            const delta = top - target;
            if (Math.abs(delta) <= 1) return;
            const viewH = window.innerHeight || 0;
            if (viewH && Math.abs(delta) > viewH) return;
            const sc = scrollHostOf(host);
            if (!sc) return;
            sc.scrollTop += delta;
            requestAnimationFrame(step);
          } catch (e) { void e; }
        };
        requestAnimationFrame(step);
      },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        // ⭐ 表格布局逐像素还原（`INV-CELL-04`）。⚠️ 块形态是 `null`，这一句是空操作。
        if (thaw) {
          try { thaw(); } catch (e) { void e; }
        }
        if (frame) { window.cancelAnimationFrame(frame); frame = 0; }
        uninstallMouse();
        paintPreedit('');
        if (liveAnnouncer === a11y) liveAnnouncer = null;
        a11y.destroy();
        layer.destroy();
        view.destroy();
        if (input.parentNode) input.parentNode.removeChild(input);
        if (host.parentNode) host.parentNode.removeChild(host);
      },
    };
  }

  /**
   * ⭐ **单元格的 swap**（`design/0049`）：把 `<td>` 的孩子挪出来、把 host 挂进去。
   *
   * ⚠️ 与块级那条的**结构性差异**：块是"整块换掉"（`insertBefore(host)` + `removeChild(el)`），
   * 单元格⛔ **不能换掉 `<td>` 本身**——它是表格网格的一部分，换掉行列结构就散了。
   * ⚠️ 原孩子**留在内存里**（`saved`）而不是 `innerHTML = ''`：撤销时要逐字放回去，
   * 而 comrak 渲染出来的孩子可能是"文本节点 + 行内元素"的混合，重新拼一遍就会丢标记。
   * ⚠️ **同步**，同块级那条（中间插一帧会塌一下）。
   *
   * @returns {{undo: Function}}
   */
  function swapLiveCell(el, host) {
    // ⭐⭐ **摘掉离屏标记**——与块级那条是**同一条纪律**（`live.css` §1b 末行明写
    //    "Swap 时由 `main.js::swapLiveView` 摘掉这个 class"，而单元格走的是**另一个函数**）。
    //    ⚠️⚠️ 不摘 = 挂进 `<td>` 的 host 仍是 `position: fixed; visibility: hidden;
    //    z-index: -1; pointer-events: none` ⇒ **那一格的文字在屏幕上直接消失**、光标也画在
    //    离屏层里、点它还会穿到 `<td>` 上。用户 2026-10-28 原话：「点击表格中的数据，
    //    数据会消失，无法选中，无法编辑」——就是这一行的漏项。
    //    ⚠️ Q 段当时**全绿**是因为它只量了进得去 / 列宽 / 表高 / 载荷字节：
    //    `parentElement` 仍然是 `<td>`（`Q1` 绿）、列宽被冻结（`Q2` 绿）、
    //    同级别的格子撑着行高（`Q2b` 绿）——**没有一条判"看不看得见"**。
    //    ⇒ 同批补 `Q1b`/`Q1c` ＋ 变异 `M25`。
    //    ⚠️ 整串重写（⛔ 不用 `classList.remove`），与 `swapLiveView` 块级那条同一个写法。
    host.className = 'cm-rmd-liveHost cm-rmd-cell';
    const saved = [];
    while (el.firstChild) saved.push(el.removeChild(el.firstChild));
    el.appendChild(host);
    let undone = false;
    return {
      undo: function () {
        if (undone) return false;
        undone = true;
        host.removeAttribute('style');
        if (host.parentNode) host.parentNode.removeChild(host);
        for (let i = 0; i < saved.length; i++) el.appendChild(saved[i]);
        return true;
      },
    };
  }

  /**
   * ⭐ Swap：把视图挂进文档流、把原块摘下来（§2.3 步骤 ④）。
   *
   * ⚠️ 这一段**必须同步**（控制器把它夹在"没有 `await`"的一小段里）：中间插一次微任务
   *    就会有一帧"原块已摘掉、新块还没挂上"，用户看到正文塌一下。
   *
   * @param {{el:object, host:object, view:object}} req
   * @returns {{undo: Function}}
   */
  /**
   * 从 `el` 往上找**真正在滚**的那个元素（`scrollTop` 补在它身上）。
   * ⚠️ 不假设是 `#doc`：`html, body` 也是 `overflow-y: auto`（`style.css` 开头那两行
   * 是"能滚"的关键），实际在滚的可能是文档根 —— 拿错了补丁就是**静默无效**。
   */
  /**
   * 光标所在那一行的行顶（视口坐标）；读不到则 `null`。
   *
   * ⚠️ 用**光标位置**认行：`focusAt` 刚刚按同一个点定位过它
   *    ⇒ 它就是"用户点的那一处"在编辑态里的身份，⛔ 不用行号（行号会随装饰层变）。
   *    ⚠️ 行尾取 `side = 1`，落到**下一行**也无关紧要——同一块里各行的位移是一样的。
   * ⚠️⚠️ DOM 是**首选**真值，`coordsAtPos` 只是兜底：swap 那一帧里 CM6 的高度表
   *    对这一块还是估算值，它给的行顶与渲染位置差过 16 px（2026-10-27 实测）。
   * ⚠️ 与基线**同一把尺**：取首字的**字形顶**（`首行盒` 用的也是它），⛔ 不是
   *    `.cm-line` 的行盒顶——两者差半个行距（半行间隙），代码块上约 2 px。
   */
  function 光标行顶(view) {
    if (!view || !view.state) return null;
    const head = view.state.selection.main.head;
    try {
      const at = view.domAtPos(head, 1);
      let n = at ? at.node : null;
      if (n && n.nodeType === 3) n = n.parentElement;
      const ln = n && n.nodeType === 1 ? n.closest('.cm-line') : null;
      if (ln) {
        const g = 首字顶(ln);
        return g !== null ? g : ln.getBoundingClientRect().top;
      }
    } catch (e) { void e; }
    try {
      const c = view.coordsAtPos(head);
      if (c) return c.top;
    } catch (e) { void e; }
    return null;
  }

  /**
   * 元素里**第一个可见字符**的字形顶（视口坐标）；没有文字则 `null`。
   *
   * ⚠️ 为什么不用 `el.getBoundingClientRect().top + paddingTop`：那只对"文字直接住在
   *    这个元素里"成立。**代码块不成立**——`.doc pre` 自己 `padding: 0`，内边距挂在
   *    内层 `code` 上（`live.css` 的注释写着同一件事）⇒ 拿 `pre` 的 padding 算，
   *    文字真实位置比它低 `--reader-code-padding`（14 px 正文下 **16.38 px**）。
   *    ⚠️ 2026-10-27 探针实测：正是这个差让 `anchorAt` 把整页往上补 16.375 px
   *    （`B11`／`blankmd B2`／`longcode B2`／`tasks B8` 四块，全是代码块）。
   * ⚠️ 用 `Range` 取**一个字符**的矩形：它给的是字形盒，与 CSS `line-height` 无关
   *    ⇒ 探针与产品两边量的是同一种东西（`INV-KERNEL-07` 的"同一把尺"）。
   */
  function 首字顶(root) {
    const box = 首行盒(root);
    return box ? box.top : null;
  }

  /**
   * 元素里第一个可见字符的 `{top, lh}`（`lh` 取**那个字符所在元素**的行高）。
   * ⚠️ `lh` 必须从**文字所在的那个元素**上取：代码块的行高住内层 `code` 上，
   *    从 `pre` 上取会拿到正文行高，按行高取模算行顶就会整行漂。
   */
  function 首行盒(root) {
    if (!root) return null;
    try {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let t = w.nextNode();
      let i = 0;
      while (t) {
        const s = t.nodeValue || '';
        let k = 0;
        while (k < s.length && (s[k] === '\n' || s[k] === '\r')) k += 1;
        if (k < s.length) { i = k; break; }
        t = w.nextNode();
      }
      if (!t) return null;
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + 1);
      const b = r.getBoundingClientRect();
      if (!b || !(b.height > 0)) return null;
      const cs = window.getComputedStyle(t.parentElement || root);
      return { top: b.top, lh: parseFloat(cs.lineHeight) || 0 };
    } catch (e) { void e; }
    return null;
  }

  function scrollHostOf(el) {
    let cur = el ? el.parentNode : null;
    while (cur && cur.nodeType === 1) {
      const oy = window.getComputedStyle(cur).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight + 1) return cur;
      cur = cur.parentNode;
    }
    return document.scrollingElement || document.documentElement || null;
  }

  function swapLiveView(req) {
    const el = req.el;
    const host = req.host;
    // ⭐ 单元格：**只换 `<td>` 的孩子**（⛔ 不换掉 `<td>`、不动它周围的行列与列宽）。
    //    `design/0049` §2.1 第 4 层；⚠️ 这一段同样**同步**。
    if (LCell && LCell.isCellNode(el)) return swapLiveCell(el, host);
    // ⭐⭐ **把被换掉那一块的盒子重搬一次**——⚠️ 少了这一步就是"点一下，下面全文往上蹦"。
    //    `.doc p` 带 `margin-bottom: var(--reader-gap-block)`（＝正文 1.1 倍，14px 下 **15.4px**），
    //    列表还有 `padding-left`，引用块有内边距与左边框，代码块有底色——而 host 是 `div`，
    //    `.doc` 那些**按标签写的**规则**一条都不匹配**。
    //    ⚠️⚠️ 等高校验量的是 **border box**（`getBoundingClientRect().height`）：
    //    它**不含外边距**、**不含横向**（`offsetHeight` 与它的区别只在**整数取整**，
    //    见 `deps.heightOf` 那一段；两者都拿不到 `margin-bottom`）⇒ 漏了这里，
    //    几何检查**照样不吭声**（高度差只看 border box，外面距与横向都不在它的量纲里），
    //    用户却看得见跳动。
    // ⚠️ 量的是**样式表算出来的值**，⛔ 不是在这里重新定义间距（`INV-LIVE-07` 仍然成立）。
    // ⚠️⚠️ **必须在 `removeChild(el)` 之前量**：节点一脱树，`getComputedStyle` 的所有长属性
    //    都返回空串 ⇒ 搬过去等于什么都没写，**静默无效**（表现与没写这段代码完全相同）。
    // ⚠️ 已知窗口：编辑期间用户改字号/行高 ⇒ 这组 px 会旧到下一次 swap；
    //    每次提交都会 `mountDocument` ⇒ `reseat` ⇒ 重算，所以只覆盖"改完设置但还没提交"那一小段。
    if (LBox && typeof LBox.applyBox === 'function') LBox.applyBox(host, el);
    // ⭐ 品种类也要重贴：`reseat` 走的是同一段，而那时用户可能刚把这一块敲成了别的种类
    //    （一段 → 列表/代码块）。⛔ 不用 `classList.remove('cm-rmd-offscreen')`——
    //    整串重写才能保证旧品种类不残留（离屏标记也在这一下里消失）。
    const kindCls = LBox && typeof LBox.classNameOf === 'function' ? LBox.classNameOf(el) : '';
    host.className = 'cm-rmd-liveHost' + kindCls;
    host.style.width = '';
    // ⭐ 量完了 ⇒ **挂上去之前**放开"活动行显示源码"（`makeLiveView` 的 `measuring`）。
    //    ⚠️ 顺序是硬的：`height()` 刚在**离屏期**取过（那一次必须"全藏"才与渲染态可比），
    //    而这里放开之后视图会按光标所在行重算一次 ⇒ 挂进文档流的就是**最终形态**，
    //    ⛔ 不会出现"先挂上、下一帧才展开"的一帧跳动。
    if (req.view && typeof req.view.endMeasure === 'function') req.view.endMeasure();
    const parent = el.parentNode;
    const next = el.nextSibling;
    // ⭐⭐ `design/0052` U6 的锚点：**被点那一行的行顶**（视口坐标）。
    //    ⚠️ 必须在 `removeChild(el)` **之前**算：`el` 一脱树，`getComputedStyle` 的所有长属性
    //    都返回空串（同 `applyBox` 那条注释），拿到的行高是 0 ⇒ 锚点退化成"块内容顶边"，
    //    点在块中部时那一行仍会跑掉一整行。
    //    ⚠️ 渲染态**没有逐行 DOM**（一整个 `<p>` / `<pre>`），所以行顶只能按"行高取模"估：
    //    内容顶往下第 `floor(off / 行高)` 个行盒 —— 渲染态行高是均匀的，这正是它能成立的前提。
    //    ⚠️ 折行的长段落会让这个估计偏（一个源码行占好几个行盒），偏差上界仍是一行。
    let anchorY = null;
    if (req.point && typeof req.point.y === 'number') {
      // ⚠️ 基线取**第一行文字的字形顶**（`首行盒`），⛔ 不是"元素顶边 ＋ 它自己的 padding"：
      //    代码块的内边距住在内层 `code` 上，按 `pre` 的 padding 算会差 16.38 px
      //    ⇒ 进代码块时整页被**莫名**补一次滚动（2026-10-27 探针实测）。
      const rect = el.getBoundingClientRect();
      const box = 首行盒(el);
      const cs = window.getComputedStyle(el);
      const lh = (box && box.lh) || parseFloat(cs.lineHeight) || 0;
      const top = box ? box.top : rect.top + (parseFloat(cs.paddingTop) || 0);
      const off = req.point.y - top;
      anchorY = top + (lh > 0 && off > 0 ? off - (off % lh) : 0);
    }
    if (parent) parent.insertBefore(host, el);
    if (parent) parent.removeChild(el);
    // ⭐⭐ `design/0052` U6 的锚定：**挂上去之后再补**（`anchorAt` 自己排 rAF）。
    //    ⚠️ 位置很讲究：必须在本函数末尾、`el` 已经离场之后——⛔ 不能放在
    //    `removeChild(el)` 之前，那一刻量到的还是"两块同时在流里"的中间态。
    //    ⚠️ 单元格那条走 `swapLiveCell`，早就返回了，走不到这里。
    if (anchorY !== null && req.view && typeof req.view.anchorAt === 'function') {
      req.view.anchorAt({ y: anchorY });
    }
    let undone = false;
    return {
      undo: function () {
        if (undone) return false;
        undone = true;
        // ⚠️ 搬过去的盒子也一并清掉：host 虽然要脱树，但同一个 host 会被 `reseat` 复用，
        //    留着上一块的 px 会让"换到另一块"的第一帧用错间距。
        //    ⛔ 不用逐个属性 `= ''`——`boxOf()` 的清单会变，整串清掉才不会漏。
        host.removeAttribute('style');
        if (host.parentNode) host.parentNode.removeChild(host);
        // ⚠️ 放回**原来的位置**（⛔ 不能 `appendChild`：脚注 / 引用定义会跑到文末）
        if (parent && next && next.parentNode === parent) parent.insertBefore(el, next);
        else if (parent) parent.appendChild(el);
        return true;
      },
    };
  }

  /** 块序号 → `#doc` 的直接孩子（对齐表的唯一查询口）。 */
  function slotNode(index) {
    for (let i = 0; i < liveSlots.length; i++) {
      const s = liveSlots[i];
      if (s && s.block && s.block.index === index) return s.node || null;
    }
    return null;
  }

  /** `#doc` 的直接孩子 → 块序号（点哪一块就进哪一块）。 */
  function slotIndexFromNode(node) {
    for (let i = 0; i < liveSlots.length; i++) {
      const s = liveSlots[i];
      if (s && s.node === node && s.block) return s.block.index;
    }
    return null;
  }

  // ── ⭐ 表格单元格（`design/0049`）────────────────────────────────────────

  /** 事件目标 → 它所在的 `<td>`/`<th>`（只在这张表里找；没有 ⇒ `null`）。 */
  function cellFromTarget(target, tableNode) {
    if (!LCell) return null;
    let cur = target;
    while (cur && cur !== tableNode) {
      if (LCell.isCellNode(cur)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  /** 块序号 ＋ 扁平格序号 → 那一格（`null` = 表格不在 / 格子数不够）。 */
  function cellNodeOf(index, flat) {
    const table = slotNode(index);
    if (!table || !LCell) return null;
    return LCell.cellAtIndex(table, flat);
  }

  /**
   * ⭐ 单元格之间的移动（`Tab` / `⇧Tab` / `Enter`，`design/0049` §4）。
   *
   * ⚠️ **走到头就退出**（提交并离开）——与裸 `Tab` 的语义一致（焦点是真的要离开），
   * 而"绕回第一格"会让用户按一次 Tab 就永远出不来。
   * ⚠️ 真正的"提交当前格 ＋ 进入下一格"由 `live.begin` 自己做（它进入前会先 `leave()`），
   * 这里只负责**算下一个扁平下标**；⛔ 不要在这里再提交一次（那会提交两遍）。
   */
  function navigateCell(delta) {
    if (!live || !LCell) return;
    const a = live.activeCell();
    if (!a) return;
    const table = slotNode(a.blockIndex);
    let next = -1;
    if (table) {
      next = delta === 'down' ? LCell.flatBelow(table, a.flat) : LCell.flatAfter(table, a.flat, delta);
    }
    if (next < 0) {
      liveSerial(function () { return leaveLive({ reason: 'cell-nav' }); });
      return;
    }
    const blockIndex = a.blockIndex;
    liveSerial(function () {
      // ⚠️ `el` 传 `null`：`leave()` 之后那棵树整棵换新，控制器会按 `d.cellNodeOf` 重取。
      return live.begin({ index: blockIndex, cell: { flat: next }, el: null });
    });
  }

  /** 从事件目标往上找 `root` 的**直接孩子**（⛔ 不返回 root 自己）。 */
  function topChildOf(el, root) {
    let cur = el;
    while (cur && cur !== root) {
      if (cur.parentNode === root) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  // ── ⭐ 任务项打勾（`design/0051`）──────────────────────────────────────

  /**
   * 武装任务项的方框（`INV-TASK-07`）—— ⭐ **只做接线**（2026-10-29 代码评审第 15 条）。
   *
   * ⚠️ 「哪些算方框 / 摘哪两处 `disabled` / 要不要占 Tab 位 / 挂哪两个监听」这些**判据**
   * 全部搬进 `src/live/task.js::arm`，那里 `make typecheck` 查得到、`live-task.test.js`
   * 用假节点跑得到。⚠️ 留在这里的判据**任何断言都碰不到**（本文件不进 `tests/js/`）。
   * ⚠️ 只在 `live` 存在时被调用（`noteLive` 第一句就是 `if (!live) return`）⇒
   * `config.live_edit = false` 时阅读态**逐像素**回到今天（`0047` §8 的回滚路径）。
   * @returns {number} 这一趟新武装的个数（给探针/调试用；产品路径不关心）
   */
  function armTaskBoxes() {
    if (!LTask || typeof LTask.arm !== 'function') return 0;
    const doc = $('doc');
    if (!doc) return 0;
    return LTask.arm(doc, { down: onTaskBoxDown, click: onTaskBoxClick });
  }

  /** 记下点击**之前**的勾选状态（进到 `click` 时已经是翻转后的值了）。 */
  function onTaskBoxDown(ev) {
    const box = ev.currentTarget;
    if (box) box.__rmdTaskWasChecked = box.checked === true;
  }

  /**
   * ⭐ 点方框 ⇒ 一次事务（`INV-TASK-03/04`）。全程异步，屏上是**重渲之后**的样子。
   *
   * ⚠️ 三条"对不上"都要**说出来**（与表格单元格同一条纪律）：⛔ 静默退回
   * "结构块不能改"会让人以为是别的问题。
   */
  function onTaskBoxClick(ev) {
    const box = ev.currentTarget;
    if (!live || !LTask || !box) return;
    // ⚠️ 必须拦：⛔ 不让控件自己翻转——失败时屏幕要能**原样**留着（`design/0051` §6 末行）。
    ev.preventDefault();
    ev.stopPropagation();
    const was = typeof box.__rmdTaskWasChecked === 'boolean' ? box.__rmdTaskWasChecked : !box.checked;
    box.__rmdTaskWasChecked = undefined;
    const doc = $('doc');
    const node = doc ? topChildOf(box, doc) : null;
    const index = node ? slotIndexFromNode(node) : null;
    const flat = node ? LTask.flatIndexOf(node, box) : -1;
    if (index === null || flat < 0) {
      if (live.isEditing()) {
        liveSerial(function () { return leaveLive({ reason: 'task-pairing' }); });
        return;
      }
      setStatusT('status.task-pairing', {}, true);
      return;
    }
    const req = {
      index: index,
      flat: flat,
      domCount: LTask.countOf(node),
      domChecked: was,
    };
    liveSerial(function () { return live.toggleTask(req); });
  }

  /**
   * ⭐ `mountDocument` 之后调：块表换新 ⇒ 对齐表重算，并把视图**重新挂到新节点上**。
   *
   * ⚠️ 顺序是硬要求：`notePayload` → `align` → `reseat`。
   *    · 控制器的 `submit()` 是在 `d.mount(payload)` **之后**才 `notePayload` 的，
   *      而本函数就在 `mount` 里面被调到 ⇒ 这里**先自己调一次**（幂等，⛔ 不是两份真值）。
   *    · `align` 拿的是**新树**的直接孩子，`reseat` 要的正是同一棵树里的节点。
   */
  function noteLive(payload) {
    if (!live) return;
    live.notePayload(payload);
    const doc = $('doc');
    const nodes = doc ? Array.prototype.slice.call(doc.children) : [];
    const out = LB.align(nodes, live.blocks());
    liveSlots = (out && out.slots) || [];
    liveAlignIssues = (out && out.issues) || [];
    if (liveAlignIssues.length > 0) {
      // ⚠️ 对齐失败 ⇒ ⛔ 不许进就地编辑（`INV-LIVE-06`）。但这**不是**要打断用户的事：
      //    正文照常可读，所以只报一行，进入时控制器还会自己拒一次。
      setStatusT('status.live-align', { msg: liveAlignIssues[0] }, true);
      return;
    }
    // ⭐ 对齐成立才武装任务项方框（`INV-TASK-07`）：对齐失败时块序号不可信，
    //    武装了也只会被配对闸门拒 ⇒ ⛔ 不如保持灰方框、什么都不承诺。
    armTaskBoxes();
    reseatLive();
  }

  /**
   * 把活着的块视图重新挂到**新树**里的同一个块节点上（`index.js::reseat`）。
   *
   * ⚠️ 只在"仍在编辑态 ∧ 有活动块"时做：`leave()` 的半路（`active` 已置空但 state 还是
   *    `committing`）同样会走到 `mountDocument`，那时无事可做，⛔ 别去报对齐失败。
   */
  function reseatLive() {
    if (!live) return false;
    if (!live.isEditing() || live.activeIndex() === null) return false;
    // ⭐ 「`⌘↵` 新起的一段」是**合成块**：它的宿主是我们自己插的临时 `<p>`（`pendingHost`），
    //    而 comrak 里那条空行**不是块** ⇒ `nodeOf(index)` 拿到的是**上面那一块**。
    //    ⇒ 整篇重渲之后（例如在空段落里按 ⌘S）自己重新造一个宿主再接回去，
    //    ⛔ 不许按块序号去挂——那会把用户正在打的字接到引用块上。
    if (typeof live.isNewParagraph === 'function' && live.isNewParagraph()) {
      const host = pendingHost(slotNode(live.activeIndex()));
      if (!host) return false;
      return live.reseat(host);
    }
    // ⭐ 单元格形态（`design/0049`）：要重取的是**那一格**，⛔ 不是整张表。
    const cell = typeof live.activeCell === 'function' ? live.activeCell() : null;
    if (cell) {
      const td = cellNodeOf(cell.blockIndex, cell.flat);
      if (!td) {
        setStatusT('status.cell-pairing', {}, true);
        liveSerial(function () { return leaveLive({ discard: true }); });
        return false;
      }
      return live.reseat(td);
    }
    const el = slotNode(live.activeIndex());
    if (!el) {
      // ⚠️ 提交之后那一块在**新树**里找不到 ⇒ 视图已经没有落点。⛔ 不猜一个节点挂上去
      //    （挂错就是把光标放进另一段文字里）⇒ 退出覆盖层并说出来。
      setStatusT('status.live-align', { msg: t('status.live-why-structural') }, true);
      liveSerial(function () { return leaveLive({ discard: true }); });
      return false;
    }
    return live.reseat(el);
  }

  /**
   * 提交并退出覆盖层（`Esc` / 点另一块 / `⌘E` / 切文档之前都走它）。⚠️ **默认提交**。
   *
   * ⚠️ `design/0052` U7 的"阅读态续写光标"**已整体撤回**（2026-10-28 用户更正需求）
   * ⇒ 这个函数回到"只是退出"，⛔ 不再在阅读态里画任何东西（原委见 `pendingHost` 那一段）。
   */
  async function leaveLive(opts) {
    if (!live) return { ok: true, committed: false };
    return await live.leave(opts || {});
  }

  /** `⌘S` 在 live 这条路：**提交 ＋ 写盘**（§2.8）。⚠️ ⛔ 不渲染（`save_document` 不回 HTML）。 */
  async function liveSaveNow() {
    if (!live) return null;
    liveLastSaveOut = null;
    const ok = await live.save();
    // ⚠️ 失败时控制器已经报过原因（`status.live-save-failed` / `status.live-identity`）⇒ 不再报一次。
    if (!ok) return null;
    const out = liveLastSaveOut || {};
    if (out.written === false) {
      // ⚠️ 没改动直接短路（`INV-EDIT-12` ①）：⛔ 报"已保存"会让用户以为写过一次盘。
      setStatusT('save.no-change');
    } else {
      setStatusT('save.done', {
        bytes: typeof out.bytes === 'number' ? out.bytes : 0,
        ms: typeof out.ms === 'number' ? out.ms.toFixed(1) : '0',
      });
    }
    return out;
  }

  /**
   * ⭐ live 的脏提示（与 `0012` 的 `promptLeaveEdit` **同一套三选一**，只换保存那一路）。
   *
   * ⚠️ 为什么不复用 `promptLeaveEdit`：那条路的"保存"是 `saveNow()`（分栏缓冲），
   *    这里是 `liveSaveNow()`（提交 ＋ 写盘）。⛔ 把两条揉进一个函数里，早晚有一条走错。
   */
  function liveAskSwitch(name, proceed) {
    askEdit('live.ask-switch', { name: name }, [
      {
        label: 'edit.act-save-continue',
        run: function () {
          liveSaveNow().then(function (out) {
            if (out) { proceed(); return; }
            // ⚠️ 保存失败 ⇒ ⛔ **不许**继续（那会变成"以为存了、其实丢了"）。
            setStatusT('edit.save-failed-cancelled', null, true);
          });
        },
      },
      {
        label: 'edit.act-discard-continue',
        run: function () {
          // ⚠️ 丢弃 = 退出覆盖层**且清掉内存那一份**（`reset()`），否则下一次进入会把
          //    这份没人要的文本当成基线（于是"刚打开就显示有未保存修改"）。
          liveSerial(function () { return live.reset(); }).then(function () { proceed(); });
        },
      },
      { label: 'common.cancel', run: function () { setStatusT('edit.cancelled'); } },
    ]);
  }

  /**
   * ⭐ `⌘E` 在覆盖层里 = **换到分栏继续改**（§4.2：同一个入口，不是第二个按钮）。
   *
   * 顺序有讲究：① 记下活动块的**起始行**（提交会重渲正文，行号会漂，所以记行区间而不是
   * 光标偏移）→ ② 提交并退出覆盖层 → ③ 进分栏 → ④ 用 `fullText()` 初始化缓冲
   * （含**还没写盘**的提交）→ ⑤ 滚到那一段。
   * ⚠️ ④ 之后**必须** `markDirty()`：`enterEdit()` 挂的是**磁盘**那份，而我们刚才的提交
   *    还没有落盘 ⇒ 不标脏就"切文档不提示"，那一段字会无声消失（§2.5）。
   */
  async function liveToSplitEdit() {
    if (!live) return false;
    const idx = live.activeIndex();
    const blocks2 = live.blocks();
    let jump = 0;
    for (let i = 0; i < blocks2.length; i++) {
      if (blocks2[i].index === idx) { jump = blocks2[i].startLine || 0; break; }
    }
    const dirtyBefore = live.isDirty();
    // ⭐ `design/0054` §7 第 5 条：提交失败 ⇒ **不切**。旧块视图还活着，此时进分栏
    //    = 同一份文本有两份可写的缓冲，谁先落盘谁赢，另一份的改动无声消失。
    const left = await live.leave({ reason: 'split' });
    if (left && left.ok === false) return false;
    // ⭐⭐ **提交之后再取一次**（2026-10-29 复评 P1：⛔ 不许用一次缓存的 dirty 推导
    //    `await` 之后的状态）：`leave()` 自己会把视图里的输入提交进会话，而排队等它
    //    的那些时间里用户还能继续打字 ⇒ 分栏缓冲拿到的 `fullText()` 里**已经含有**
    //    这些"已提交、未落盘"的字。只按 `await` 之前那个布尔决定 `markDirty()`，
    //    等于让分栏在"含未保存改动"的状态下**不提示**（切文档时无声丢字）。
    const dirty = dirtyBefore || live.isDirty();
    const text = live.fullText();
    const ok = await enterEdit();
    if (!ok) return false;
    if (text !== null && editor) {
      // ⚠️ `keepCursor` **不传**：这是"另一份文本"，旧偏移没有意义（`editor/main.js` 的注释）。
      editor.mount(text, forwardExt, { vimOn: !!(theme && theme.applied.vimMode) });
      if (dirty) editor.markDirty();
    }
    if (jump > 0) scrollEditToLine(jump);
    return true;
  }

  /**
   * 把分栏缓冲滚到第 `n` 行（1-based）。
   * ⚠️ `EditorView.scrollIntoView` 是**返回 StateEffect 的静态方法**，⛔ 不是"直接滚"的动作
   *    —— 必须放进 `dispatch({ effects })`（`src/vendor/cm6.bundle.js:11802`）。
   */
  function scrollEditToLine(n) {
    if (!editor || !editor.isMounted()) return false;
    const view = editor.raw();
    if (!view) return false;
    const doc = view.state.doc;
    const line = Math.max(1, Math.min(n, doc.lines));
    const pos = doc.line(line).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: window.rmdCM6.EditorView.scrollIntoView(pos, { y: 'start' }),
    });
    return true;
  }

  /**
   * ⭐ `⌘A` 的落点（`bugs/0036`，2026-10-29）：**你正在读 / 写的那份正文**。
   *
   * | 语境 | 选什么 |
   * |---|---|
   * | 分栏编辑态 | 编辑器**全文**（CM6 的 `0..doc.length`） |
   * | 阅读态 | `#doc` 里的**渲染正文**（原生 Range） |
   * | 就地编辑态 | ⛔ **走不到这里** —— 那一块在 `makeLiveView::onKeyDown` 里自己认领（选当前块） |
   *
   * ⚠️⚠️ **不许把范围放宽到 `document.body`**：那正是缺陷本身
   *    （侧边栏文件名、顶栏状态条一起进选区 ⇒ `⌘C` 复制出来的东西是错的）。
   *    ⭐ 另一层防线在样式里：`.topbar` / `.sidebar` 都设了 `user-select: none`
   *    （`src/style.css`，`bugs/0036` §5）——那一层管的是**原生** 全选（`Menu::default`
   *    自带的 `Select All` 走 AppKit，不经过本函数）。
   */
  function selectAllText() {
    if (editor && editor.isMounted()) {
      const view = editor.raw();
      if (view) {
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        view.focus();
        return;
      }
    }
    const main = $('doc');
    const sel = window.getSelection ? window.getSelection() : null;
    if (!main || !sel || !main.firstChild) return;
    const range = document.createRange();
    range.selectNodeContents(main);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * 磁盘上的文件变了，而就地编辑有**未写盘**的提交（§2.5 的最后两行）。
   * ⚠️ 与 `promptExternalChange` 分开：那一条救的是**分栏缓冲**，这一条救的是**提交栈**。
   */
  function promptLiveExternalChange() {
    askEdit('live.external-changed', null, [
      {
        label: 'edit.act-reload-disk',
        run: function () {
          // ⚠️ 顺序：先丢内存那份（`reset` 会顺手退出覆盖层），再读盘。
          liveSerial(function () { return live.reset(); }).then(function () {
            return reloadCurrentDocument('reload.reason.external');
          });
        },
      },
      { label: 'common.cancel', run: function () { setStatusT('edit.cancelled'); } },
    ]);
  }

  /**
   * ⭐⭐ **焦点丢了也退得出去**（2026-10-27 用户实测：「一旦进入标签模式，就出不来」）。
   *
   * 覆盖层的键盘全挂在那个**离屏 textarea** 上（`input.addEventListener('keydown', …)`）。
   * 一旦焦点不在它身上（用户点过侧边栏 / 顶栏 / 另一个窗口，或 `input.focus()` 那一次没生效），
   * `Esc` 与 `⌘↵` **一个字节都收不到** ⇒ 界面上除了覆盖层本身，没有任何一条退路。
   * ⇒ 在 `document` 的**捕获期**补一条兜底。
   *
   * ⚠️ 三条闸，缺一条都会踩到别人：
   *   ① 目标就是那个 textarea ⇒ **原样放行**（它自己有完整的一条路，含组合态处理）；
   *   ② 焦点落**在任何有用的地方**（查找框 / 快速打开 / 设置）⇒ 不接：那里也有自己的 `Esc`；
   *   ③ 只认 `Esc` / `⌘↵` 两个键，⛔ 别扩成"什么都兜"——那会变成第二份键位表（`INV-SET-01`）。
   *
   * ⭐ 2026-10-28：`⌘↵` 在这里的语义与块内那条**相同**——跳出当前块、新起一段
   *    （`bugs/0024` 用户更正；⛔ 不再是"退出到阅读态"）。⛔ 这里不另写一份逻辑，走
   *    `startNewParagraph()`，它自己会在"新起不了"（格子 / 没有活动块）时退回退出。
   */
  function onLiveGlobalKey(ev) {
    if (!live) return;
    if (!live.isEditing()) return;
    if (ev.defaultPrevented || ev.isComposing === true) return;
    const tgt = ev.target;
    if (tgt && tgt.classList && tgt.classList.contains('cm-rmd-input')) return;
    const ae = document.activeElement;
    const docEl = $('doc');
    const idle = !ae || ae === document.body || (!!docEl && (ae === docEl || docEl.contains(ae)));
    if (!idle) return;
    // ⚠️ 修饰键只从 `K.modifiers()` 取（`INV-SET-01` 的源码级闸门）。
    const mods = K.modifiers(ev);
    const isEsc = ev.key === 'Escape';
    const isModEnter = mods.cmd && (ev.key === 'Enter' || ev.key === 'NumpadEnter');
    if (!isEsc && !isModEnter) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (isEsc) {
      liveSerial(function () { return leaveLive({ reason: 'escape' }); });
      return;
    }
    liveSerial(function () { return startNewParagraph(); }).then(function (ok) {
      if (!ok) liveSerial(function () { return leaveLive({ reason: 'mod-enter' }); });
    });
  }

  /**
   * ⭐ **阅读态那一次按下的手势**（`bugs/0042`）：`live.begin` 是异步的（`begin_edit` IPC
   * → 建视图），而 `mousedown` 的事件路径**当场就走完了** ⇒ 新视图的 `down()` 永远收不到它。
   * ⇒ 这里把 `{clientX, clientY, detail, shiftKey, at, released}` 记下来，由
   * `selection.js::installMouse` 的第一个 `mousemove` 接手。
   * ⚠️ `released` 是**必须**的：松手早于视图就绪时，⛔ 不许再启动一次悬空拖动。
   */
  let pendingDown = null;

  /** 记下一次按下，并挂一条一次性的 `mouseup` 把"已松开"标上。 */
  function noteDownGesture(ev) {
    const g = {
      clientX: ev.clientX,
      clientY: ev.clientY,
      shiftKey: ev.shiftKey === true,
      detail: ev.detail || 1,
      at: Date.now(),
      released: false,
    };
    pendingDown = g;
    const doc = document;
    function onUp() {
      g.released = true;
      doc.removeEventListener('mouseup', onUp, true);
    }
    doc.addEventListener('mouseup', onUp, true);
    // ⚠️ 视图一直没建起来（提交失败 / 被别的事件顶掉）⇒ 不许让它永远挂着：
    //    超时之后自己作废，`removeEventListener` 也一并收掉。
    setTimeout(function () {
      g.released = true;
      doc.removeEventListener('mouseup', onUp, true);
    }, 1800);
  }

  /**
   * 正文里点一下：命中可编辑块就进覆盖层，命中结构块就给一条可执行的路。
   *
   * ⚠️⚠️ **"点了但没进得去"必须等于"退出"**（2026-10-27 用户实测：「一旦进入标签模式，
   *    就出不来」）。原来这里四类落空（点空白 / 块间间隙 / 不在对齐表里 / 结构块）
   *    全是裸 `return` —— 那意味着**覆盖层还在、焦点还在离屏 textarea 上**，
   *    用户点了一下"外面"，界面却什么都没变，于是除了 `Esc` 没有任何退路。
   *    ⭐ 现在的口径与 §2.5 的「点另一块 = 提交并退出」同一条：**点哪儿都是提交并退出**，
   *    「进不进新块」是后一步的事。
   */
  function onLiveDocDown(ev) {
    if (!live) return;
    if (ev.button !== 0) return;
    if (ev.defaultPrevented) return;
    // ⭐ 任务项方框（`design/0051`）：它自己那条 `click` 已经接走了（`armTaskBoxes`）。
    //    ⚠️ 必须在任何 `leaveAway()` **之前**返回：否则点一下方框会先退出当前编辑态，
    //    再走一遍"进入这一块"的流程——而用户要的只是一次打勾。
    if (LTask && LTask.isTaskCheckbox(ev.target)) return;
    const doc = $('doc');
    if (!doc) return;
    // 点了正文里一处**不会进入覆盖层**的地方 ⇒ 提交并退出（⛔ 不静默留在编辑态）。
    function leaveAway(reason) {
      if (!live.isEditing()) return false;
      liveSerial(function () { return leaveLive({ reason: reason }); });
      return true;
    }
    const node = topChildOf(ev.target, doc);
    if (!node) { leaveAway('blank'); return; }
    // ⚠️ 正在编辑的那一块内部由 `selection.js` 在 capture 期接走（它会 `stopPropagation`）
    //    ⇒ 走到这里说明点的**不是**它；但万一顺序变了，这一句是第二道闸。
    if (node.classList && node.classList.contains('cm-rmd-liveHost')) return;
    const index = slotIndexFromNode(node);
    if (index === null) { leaveAway('blank'); return; }
    const blocks2 = live.blocks();
    let block = null;
    for (let i = 0; i < blocks2.length; i++) {
      if (blocks2[i].index === index) { block = blocks2[i]; break; }
    }
    if (!block) { leaveAway('blank'); return; }
    // ⭐ **表格：点在格子里 ⇒ 走单元格入口**（`design/0049`）。
    //    ⚠️ `Table` 块本身仍然是 `editable = 0`，这里⛔ 不是把 Table 挪进白名单——
    //    单元格编辑是**另一条**入口（见 `block.editable !== true` 分支上方的注释）。
    if (block.kind === 'Table' && LCell) {
      const td = cellFromTarget(ev.target, node);
      if (!td) {
        // 点的是表格的边框 / 表头分隔线那一类"不是格子"的地方 ⇒ 给一条可执行的路。
        if (leaveAway('cell-structural')) return;
        setStatusT('status.cell-hint', { accel: accelText('edit.toggle') }, true);
        return;
      }
      const spans = live.cellsOf(index);
      const domCount = LCell.countCells(node);
      const flat = LCell.flatIndexOf(node, td);
      // ⚠️ 三条拒绝，三条都要**说出来**（§6）：⛔ 静默退回"结构块不能改"会让人以为是别的问题。
      if (!spans) {
        if (leaveAway('cell-pairing')) return;
        setStatusT('status.cell-pairing', {}, true);
        return;
      }
      // ⚠️ 数量对不上 ⇒ ⛔ 不部分配对（`INV-CELL-06`）：错位一格 = 改的是**别的格子**，
      //    而且屏幕上完全看不出来。
      if (domCount !== spans.length || flat < 0) {
        if (leaveAway('cell-pairing')) return;
        setStatusT('status.cell-pairing', {}, true);
        return;
      }
      ev.preventDefault();
      // ⭐ 这次按下可能一路拖下去（`bugs/0042`）：把手势带过 `live.begin` 的异步边界。
      noteDownGesture(ev);
      const point = { x: ev.clientX, y: ev.clientY };
      liveSerial(function () {
        return live.begin({ index: index, block: block, el: td, cell: { flat: flat }, point: point });
      });
      return;
    }
    if (block.editable !== true) {
      // ⭐ 结构块（表格 / 代码块 / 公式 / 分隔线）：⛔ 不进覆盖层，但**给一条可执行的路**（§4.1）。
      //    ⚠️ 键位从后端那张表现取，⛔ 不写字面量（`INV-SET-01`）。
      //    ⚠️ 正在编辑另一块时**先退出**——提交会写一条状态，那条提示留到阅读态才有意义。
      if (leaveAway('structural')) return;
      setStatusT('status.live-structural', { accel: accelText('edit.toggle') }, true);
      return;
    }
    // ⚠️ 只拦**我们自己要处理的那一次点击**：`preventDefault` 让 `#doc` 不把焦点交给
    //    `contentDOM`、也不开始原生选择（`INV-LIVE-12`）。
    ev.preventDefault();
    // ⭐ 同格子那一条：这次按下可能一路拖下去（`bugs/0042`）。
    noteDownGesture(ev);
    const point = { x: ev.clientX, y: ev.clientY };
    liveSerial(function () {
      return live.begin({ index: index, block: block, el: node, point: point });
    });
  }

  /** 编辑面的接线（按钮 / 分隔条 / 自证）。⚠️ 在 `setupKeys()` **之后**调一次。 */
  function setupEdit() {
    runEditSelfTest();
    setupVimToggle();
    setupEditorVim();

    const edit = $('btn-edit');
    if (edit) edit.addEventListener('click', function () { toggleEdit(); });
    const save = $('btn-save');
    if (save) save.addEventListener('click', function () { saveNow(); });
    const pv = $('preview-now');
    if (pv) {
      pv.addEventListener('click', function () {
        // ⚠️ 手动更新**不受档位限制**（`requestNow` 那一条）：
        //    档 C 下它就是唯一的出路，而它要能更新得动。
        if (editorPreview) editorPreview.requestNow();
      });
    }
    setupEditSplitter();
    syncEditToggle();
    syncEditPrompt();

    // ⭐ `design/0025` §2.5.1 ③：这些面由 JS 现写文字，`applyDom` 够不到
    //    ⇒ 换语言后必须自己重画一遍。⚠️ `setLang` 的顺序是 applyDom → **订阅者**，
    //    所以这里最后写、写赢；⛔ 别改成在 `applyDom` 之前跑。
    if (I18N) I18N.subscribe(relabelDynamic);
  }

  /**
   * 分隔条的拖动（§4 第 3 条：**可在窗口内拖动，但 ⛔ 不落盘**）。
   *
   * ⚠️ 不持久化是**明说的取舍**：要它记住就得给 `Config` 加字段 + 让
   *    `INV-THEME-05` 的"一次写完"跟着扩——那是**另一次改动**，⛔ 不塞进本设计。
   * ⚠️ 用 `mousemove`/`mouseup` 挂在 `window` 上（⛔ 不是元素上的 `pointermove`）：
   *    鼠标拖出分隔条那一瞬间指针捕获就没了，指针跑得比元素快时拖动会**卡住**。
   */
  function setupEditSplitter() {
    const sp = $('editor-splitter');
    if (!sp) return;
    sp.addEventListener('mousedown', function (e) {
      if (!editing) return;
      e.preventDefault();
      const root = document.documentElement;
      const body = document.body;
      const startX = e.clientX;
      const startPct = parseFloat(getComputedStyle(root).getPropertyValue('--editor-ratio')) || 50;
      const padLeft = parseFloat(getComputedStyle(body).paddingLeft) || 0;
      const usable = Math.max(1, body.clientWidth - padLeft);
      sp.classList.add('is-dragging');
      body.classList.add('editor-splitting');

      function onMove(ev) {
        const pct = startPct + ((ev.clientX - startX) / usable) * 100;
        // ⚠️ 夹在 15%–85%：⛔ 不设下限会让某一栏被拖成 0 宽，
        //    而 0 宽的那一栏**没有任何办法拖回来**（分隔条自己也跟着没了）。
        root.style.setProperty('--editor-ratio', Math.min(85, Math.max(15, pct)).toFixed(2) + '%');
        // ⭐ 分栏宽度变了 ⇒ 折线作废（`design/0012` §11.7）。⚠️ 两个滚动容器的
        //    **盒子**在这一拖里没变（它们被网格拉着），`ResizeObserver` **不响**
        //    ⇒ 必须从这儿显式说一声。⛔ 这里**只转告**：`mousemove` 一秒几百次，
        //    合流是 driver 那一层 rAF 的事。
        syncAfterLayoutChange();
      }
      function onUp() {
        sp.classList.remove('is-dragging');
        body.classList.remove('editor-splitting');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  /**
   * 把 HTML 挂进正文容器。
   *
   * ⚠️ `innerHTML` 与紧跟的强制布局**都是同步的**——这正是 `§7.3.3` 说的
   * "WKWebView 没有 `longtask`，改用同步分段"的落点。⛔ 中间**不要**插 rAF/微任务：
   * 那会改变被测代码的形状（`design/0002` §7.3.3 的口径就没了）。
   *
   * ⭐ `design/0012` 起它**同时**是预览那一栏的挂载点（§2.1 ②：⛔ 不新增第二个
   *    `innerHTML` 注入点）。为此多了 `opts`——⛔ 它不是"另一条挂载路径"，
   *    只是从**同一条**路径上卸掉两件只该在"打开一份新文档"时做的事。
   *
   * @param {object} payload `DocumentPayload`
   * @param {object} [opts]
   * @param {boolean} [opts.noReveal] ⛔ 不在树里重新定位。⚠️ 预览重渲**每敲几下**就来一次，
   *        而 `revealInTree` 可能要展好几层目录——那是纯浪费，
   *        而且会让侧边栏在用户打字时不停地抖（文档没换，树也不该动）。
   * @param {boolean} [opts.keepScroll] ⭐ 保留**预览栏**的滚动位置。
   *        ⚠️ 这是"预览不跳"的第一版处置：拿重渲前的 `scrollTop`，渲完按新的
   *        可滚范围夹一下再写回去。⛔ 它**不是** §7 步骤 0f 的答案（那一步要量的是
   *        "重渲期间按键延迟 + 滚动位置保没保住"，而 0f **尚未做**）。
   *        ⭐ **2026-10-16 改**：它现在**记的是三级锚点，⛔ 不是裸 `scrollTop`**
   *        （`design/0012` §2.6-5 的硬要求，实测依据见 `docs/bugs/0006`）。
   * @param {object|null} [opts.anchor] ⭐ **调用方已经记好的锚点**（`captureAnchor()` 的产物）。
   *        ⚠️ 传了它 ⇒ 这一趟**不写位置**，由调用方挂完之后自己 `restoreAnchor`。
   *        理由：重载那条路要的是**读文件之前**记的那个位置（读盘那几百毫秒里用户还能滚），
   *        而这里现记的那个已经是读盘之后的了。⛔ 两个都写 = 同一件事写两遍，别这样。
   * @returns {{t5_ms:number, t5b_ms:number}} 同步耗时（没测量器时是 0）
   */
  function mountDocument(payload, opts) {
    const o = opts || {};
    const doc = $('doc');
    // ⭐ `design/0017` §2.3 ⑤：**每一次挂载都是一个新代号**，并且作废上一份还没兑现的
    //    恢复意图。⚠️ 这两句必须在换 DOM 之前——图片回调、滚动事件都可能在这之后到达。
    //    ⚠️ 预览重渲（编辑态）也会 +1：那时根本不该有恢复意图，多 +1 无害。
    mountGen += 1;
    pendingRestore = null;
    // ⭐ `design/0018` §2.3 ⑤：这是打开 / 自动重载 / 预览重渲的**唯一提交点**，
    //    旧 `<img>` 节点即将被整棵替换。不关的话预览会继续显示**上一版**的图，
    //    而焦点还回去的那个节点已经脱离文档了。
    //    ⚠️ `restoreFocus: false`：此刻焦点应留给新正文，⛔ 不还给一个马上要消失的元素。
    if (imageViewer) imageViewer.close({ restoreFocus: false });
    // ⚠️ 位置**必须在 `innerHTML` 之前**记：之后取到的已经是新内容算出来的值。
    //    ⭐ 编辑态记的是**三级锚点**（标题 + 行内偏移 → 比例 → 回顶部）：
    //    整棵 DOM 换掉之后，裸 `scrollTop` 在不均等的重排下**本来就不指向同一处内容**
    //    （实测：文末那一节一次提交挪 48 px，`docs/bugs/0006`）。
    //    ⚠️ 用的就是 `design/0006` §6.1 那一份实现（`captureAnchor` / `resolveAnchor`），
    //    ⛔ 这里不另写一份——两条路的锚点语义必须同一个。
    const prevAnchor = o.keepScroll ? (o.anchor || captureAnchor()) : null;
    const imgStatBefore = null; void imgStatBefore;

    // ⭐ **T5**：DOM 解析 + 建节点。
    // ⭐ `design/0038`（`INV-START-01`）：正文要挂上来了 ⇒ **先把启动页摘掉**。
    //    ⚠️ `innerHTML` 只清 DOM，**摘不掉 `document` 级 keydown 监听**——
    //    不显式 `clear()` 的话，正文在屏上、按 `1` 会打开第一个最近目录。
    //    ⚠️ 必须在 `innerHTML` **之前**（与上面 `imageViewer.close` 同一条纪律）。
    if (startScreen) startScreen.clear();
    // ⭐ **T5 / T5b 的计时器**（2026-10-29 代码评审第 5 条）。
    //   ⚠️ 原来这两段**只在 `measure` 存在时**才计时，而 `measure` 只在 `RMD_MEASURE=1`
    //   时创建 ⇒ 生产路径上 `t5_ms` / `t5b_ms` **恒为 0**，状态条那句「本次重渲花了多少」
    //   的输入永远是 0，等于**永远不说**。这不是"少一个数字"，是那条可见降级整个不存在。
    //   ⇒ 没有测量器时退回 `performance.now()`（⛔ 不改任何时序：包的还是同一段代码）。
    const span = function (fn) {
      if (measure) return measure.span(fn);
      const a = performance.now();
      const value = fn();
      return { ms: performance.now() - a, value: value };
    };
    let t5 = span(function () { doc.innerHTML = payload.html; });
    doc.setAttribute('aria-busy', 'false');
    if (o.keepScroll && !o.anchor) {
      // ⭐ 渲染完再把它还原成位置（`resolveAnchor` 自己夹到新的可滚范围里）。
      //    ⚠️ 走 `hostSetTop`（⛔ 不 `doc.scrollTop = …`）：编辑态这一次写必须**被同步
      //    的来源闸记账**，否则它会被当成"用户接管预览栏"——见 `hostSetTop` 的注释。
      const m = scrollMetrics();
      const r = R.resolveAnchor(prevAnchor, headingPositions(), m.scrollHeight, m.clientHeight);
      hostSetTop(r.scrollTop);
    }

    // 图片：路线 A（`read_asset`）或占位（未授权 / 远程 / 缺失）——见 ImageView 的头注释
    // ⭐ `design/0017` §2.3 ⑤：`onSettled` 是"图片真的进了布局"的信号（解码 + 两帧）。
    //   ⚠️ 传的是**这一次挂载的代号**——旧文档的图片回调不许动新正文的恢复意图。
    const mountGenNow = mountGen;
    const imgStat = ImageView.renderImages(doc, {
      // ⭐ **缓存键里必须带文档身份**（2026-10-29 代码评审第 6 条）：同一个 `src`
      //    在两份文档里是两个文件（后端 `doc_dir.join(src)`）⇒ 只认 `src` 会把
      //    A 文档的图贴到 B 文档里，那是**错的内容**，比慢严重得多。
      //    ⚠️ 预览那条路送来的是**同一份** `real_path`（`edit.rs` 里注明它与 `path` 同值），
      //    所以重渲不会把缓存判成"换了文档"。
      docKey: payload.real_path || '',
      onChooseDirectory: onChooseDirectory,
      onSettled: function () { correctReadingProgress(mountGenNow); },
    });

    // ⭐ **T5b**：强制布局。⚠️ 读 `offsetHeight` 会同步触发 layout——
    //    但**只对已经 dirty 的那一棵**有效，所以它必须紧跟 `innerHTML` 之后
    //    （中间插了图片渲染，多出来的那部分也算进去，口径写清楚即可）。
    let t5b = { ms: 0, value: 0 };
    // ⚠️ 读 `offsetHeight` 会**同步强制布局**，本身有成本 ⇒ ⛔ 不能在打开文档那条路上
    //    无条件加一次（今天那条路是在后面别处才布局的）。只在"这一趟反正要布局"的地方读：
    //    ① 有测量器（`RMD_MEASURE=1`，原本就一直在读）；
    //    ② 提交后的重渲（下面 `scrollMetrics()` / 调用方的 `restoreAnchor` 马上就要读，
    //       早读晚读是**同一趟**布局）——而那正是 `renderbudget` 唯一关心的那条路。
    if (measure || o.keepScroll) {
      t5b = span(function () { return doc.offsetHeight; });
    }

    // 大纲：复用后端给的标题 ID，⛔ 前端不重新生成（`adr/0003`）
    // ⚠️ 预览重渲时**也要**刷：标题正是用户此刻在改的东西，
    //    不刷的话大纲会停在"上次保存时"的样子（一个静默的旧真值）。
    sidebar.setToc(payload.toc);

    // ⭐⭐ **挂上去的这一份 `toc` 必须同时是"位置的那一份"**（`design/0012` §11.7）。
    //    ⚠️⚠️ 预览提交**刻意不碰会话状态**（`INV-EDIT-07`：`render_preview` 不读盘、
    //    不改 `currentDoc`）⇒ 重渲之后 `S.state.currentDoc.toc` 还是**上一版文本**的行号，
    //    而右侧 DOM 已经是这一版的了 ⇒ 那一对锚点**不是同一个东西的位置**。
    //    ⚠️ 后果**静默**：`syncState()` 照旧报「精确」，而折线是按**上一版**的行号配的；
    //    `headingPositions()` 也拿这份 `toc` 去查元素 ⇒ 刚改过标题的那一条直接落空、
    //    连带我上面那次锚点还原也退成按比例。
    //    ⇒ 只换 `toc` 这一个字段（其余字段属于"打开的是哪份文件"，不归这里管）。
    if (S.state.currentDoc && payload.toc) S.state.currentDoc.toc = payload.toc;

    // 切文档 = **替换**（不做多标签），滚动位置**重置到顶部**
    // ⚠️ `keepScroll` 是"预览重渲"那一支：那不是切文档，⛔ 不该把预览弹回顶部。
    if (!o.keepScroll) window.scrollTo(0, 0);

    // 当前项高亮（至多一个）
    S.state.currentPath = payload.real_path;
    if (tree) {
      tree.setCurrent(payload.real_path);
      // ⚠️ 同样**不 await**：正文已经挂好了，定位慢不该拖着这一帧。
      // ⚠️ 文档**没换**时不定位（`noReveal`）——重渲时它只是白干活，见 `opts` 的说明。
      if (!o.noReveal) revealInTree(payload.real_path);
    }

    const summary =
      t('status.summary', {
        path: payload.real_path,
        src: humanBytes(payload.source_bytes),
        html: humanBytes(payload.html_bytes),
        ast: payload.ast_nodes,
        toc: payload.toc_entries,
        total: imgStat.total,
        loaded: imgStat.loaded,
        unauthorized: imgStat.unauthorized,
        remote: imgStat.remote,
        missing: imgStat.missing,
        t1: payload.t1_ms.toFixed(1),
        t2: payload.t2_ms.toFixed(1),
        t3: payload.t3_ms.toFixed(1),
      }) +
      (payload.had_bom ? t('status.bom-stripped') : '') +
      // ⭐ Q22（`design/0007` 文末追加节）：规模闸门挡下来的代码块必须**说给用户听**。
      //   ⚠️ 判定与文案**不在这里**——在 `services/renderstat.js` 里，因为它要有断言。
      //   写在这儿的版本是**测试碰不到**的（`main.js` 不进 `tests/js/`），
      //   而它的失效形态是"那一句永远不出现、屏幕上一切正常"。
      //   ⭐ `design/0025`：译文由**这里**注入（`RS` 在 Node 里也要能 `require`，⛔ 不抓 `window`）。
      RS.codeNotice(payload, t) +
      // ⭐ 2026-10-29 代码评审第 5 条：**提交 = 整篇重渲**的文档级成本。
      //   单块上限（`LIVE_MAX_LINES`）管的是"这一块多大"，管不到"这份文档多大"——
      //   实测 XL 三份语料一次重渲 **1245 / 2660 / 3745 ms**（L-plain 也有 401）。
      //   ⚠️ 判定与文案同样**不在这里**（`RB` 有断言，本文件没有）；这里只喂三个数：
      //   `rerender` = 这次是不是提交后的重渲（⛔ 打开文档那一次不说话：它是一次性代价，
      //   而且状态条上已经有 T1/T2/T3，在那条路上说"重渲很久"会让人以为是编辑引起的）。
      RB.notice(
        {
          t5_ms: t5.ms,
          t5b_ms: t5b.ms,
          html_bytes: payload.html_bytes,
          rerender: !!o.keepScroll,
        },
        t
      );
    setStatusFn(function () { return summary; }, false);

    // ⚠️ 暴露给将来用：批 2 在这里量 T5/T5b 并做 `supportedEntryTypes` 的运行时探测。
    window.__rmd = { payload, images: imgStat };

    // ⭐ `design/0011` `INV-FIND-02`：**文档一提交，查找索引就作废**。
    //
    //   ⚠️ 挂**在这里**是刻意的：`mountDocument` 是**打开**（`openDocument`）与
    //      **自动重载**（`reloadCurrentDocument`）两条路唯一的公共提交点 ——
    //      挂在某一条上，另一条就会拿着**上一份正文**的段偏移继续搜，
    //      而表现是"高亮落在文档里另一段文字上"（⛔ 不报错，也不一定会立刻看出来）。
    //   ⚠️ 它必须在 `innerHTML` **之后**：此前 `getDoc()` 指向的还是旧的那棵树。
    //   ⭐ 浮层还开着时它自己会重建（`invalidate` 里那一句），⛔ 不留空窗期。
    if (findBar) findBar.invalidate();

    // ⭐ `design/0047` §3.2：`#doc` 换了整棵树 ⇒ 块表与"块序号 → 节点"的对齐表必须重算，
    //    活着的块视图也要**重挂到新节点上**（`noteLive` 里那三步，顺序是硬要求）。
    //   ⚠️ 挂在这个提交点上是刻意的：打开 / 自动重载 / 提交 / 编辑态预览重渲**都经过它**
    //      （`INV-LIVE-14`）。⛔ 挂在某一条上，其余几条就会拿着上一棵树的对齐表继续用。
    //   ⚠️ 它必须在 `innerHTML` **之后**（此前 `getDoc()` 指向的还是旧的那棵树）。
    noteLive(payload);

    return { t5_ms: t5.ms, t5b_ms: t5b.ms };
  }

  /**
   * ⭐ 进入一个**后端记过的**目录（`design/0038` §2.1 ③）——启动页点一行、
   * 侧边栏点「上次的目录」，**⛔ 都不弹系统面板**。
   *
   * ⚠️ 与 `onChooseDirectory` 的差别只有**授权的来路**：那条弹面板（用户当场选），
   *    这条递一个**记录过的字符串**（后端逐字比对，`INV-START-02`）。
   *    之后的三件事（代次 +1 / 树重挂 / 恢复上次那份文档）在前端完全同形——
   *    因为后端两条命令共用 `enter_directory` 一份收尾（`INV-START-03`）。
   *
   * ⚠️ 这里的顺序照抄 `onChooseDirectory`，一条都不能省：
   *    · 先作废在跑的恢复（`root-changed`）——切根会让代次 +1，旧恢复的 `alive()` 会兜住，
   *      这里是第二重；
   *    · 再 flush 在跑的写（`design/0020` §2.3 ③(c)）——必须**赶在代次变之前**落地，
   *      否则这次写必然 `stale`，上一棵树的展开态就白记了。
   *
   * @returns {Promise<object>} 新快照；⚠️ 失败会**throw**（`StartScreen` 据此标 `data-missing`）
   */
  async function onOpenRecentDirectory(root) {
    if (dirRestorer) dirRestorer.cancel('root-changed');
    if (dirWriter) await dirWriter.flush();
    // ⚠️ 失败**不在这里吞**：状态条那句话由 `startScreen` 的 `onError` 写（它也是唯一
    //    知道"是哪一行"的地方），异常必须继续抛出去——吞掉的话行就不会变灰（`INV-START-07`）。
    const snap = await S.openRecentDirectory(root);
    // 目录模式下没有"当前文档"：显式空态，⛔ 不自动打开第一个文件（§2.1）。
    // ⚠️ 这一步会**重画启动页**（`showDocEmpty` 的唯一挂载点）⇒ 表里的顺序/`last`
    //    标记用的是**刚回来的快照**，不是点之前那一份。
    showDocEmptyT('doc.empty-choose');
    setDirectoryStatus();
    sidebar.setTab('tree');
    await renderSidebar();
    // ⚠️ 用 `snap`（⛔ 不是再读一次 `S.state`）：返回值与镜像在同一个提交点，
    //    而恢复流程可能在这之后立刻把 `lastDirectory` 改掉。
    return snap;
  }

  /**
   * ⭐ `design/0043` §2.7：打开一条收藏。**授权全在后端**（`open_favorite`，`INV-FAV-03`）
   * ——前端只负责"原串回传"和打开之后的既有收尾。
   *
   * ⚠️ 顺序照抄 `onOpenRecentDirectory`（一条都不能省）：
   *    · 先作废在跑的恢复；再 flush 在跑的写（必须赶在代次变之前落地）。
   * ⚠️ 收藏可能是**目录**也可能是**文件**（Add 时只允许这两种）⇒ 按后端快照的 `mode` 分派，
   *    目录走"空态 + 树"，文件走 `openDocument`（⛔ 前端不自己猜类型）。
   * ⚠️ 失败**不在这里吞**：`StartScreen` 的行变灰与状态条那句都由它那条路负责（`INV-START-07`）。
   *
   * @returns {Promise<object>} 新快照
   */
  async function onOpenFavorite(path) {
    if (dirRestorer) dirRestorer.cancel('root-changed');
    if (dirWriter) await dirWriter.flush();
    const snap = await S.openFavorite(path);
    if (snap && snap.mode === 'directory') {
      showDocEmptyT('doc.empty-choose');
      setDirectoryStatus();
      sidebar.setTab('tree');
      await renderSidebar();
      return snap;
    }
    // 单文件：与 `onChooseFile` 同一条提交路径（版本/身份复核、监视切换都在里面）。
    if (snap && snap.startup_document) await openDocument(snap.startup_document);
    await renderSidebar();
    return snap;
  }

  /**
   * ⭐ `design/0043` §2.5：树上/根头上的「收藏 / 取消收藏」。
   *
   * ⚠️ 目标路径**原样回传**（后端 `favorites_apply` 要逐字比对）；⚠️ 失败**必须可见**
   * （状态条一句）——否则用户会以为点中了，"收藏着却看不见"最难自查。
   */
  async function toggleFavoriteFromUi(path) {
    let res;
    try {
      res = await S.toggleFavorite(path);
    } catch (e) {
      setStatusT('status.favorite-failed', { msg: e.wording || e.message }, true);
      return;
    }
    if (res && res.applied) {
      setStatusT(S.isFavorite(path) ? 'status.favorited' : 'status.unfavorited', {});
      repaintStart();
    }
  }

  /**
   * ⭐ `design/0045`（隐私）：启动页最近目录那一行右键「从列表移除」。
   *
   * ⚠️ `root` **原样回传**（后端 `recent_apply` 要逐字命中那份记录）。
   * ⚠️ 只是**忘掉这条记录**——磁盘上的目录一个字节都不动、授权也不动（`INV-REC-01`）。
   * ⚠️ `applied === false`（迟到 / 代次变了）⇒ **一句话都不说**：那一刻界面已经被
   *    另一次快照重画过了，再补一句只会让状态条说一件没发生的事。
   */
  async function forgetRecentFromUi(root) {
    let res;
    try {
      res = await S.removeRecent(root);
    } catch (e) {
      setStatusT('status.recent-clear-failed', { msg: e.wording || e.message }, true);
      console.error('从「最近的目录」移除失败：', root, e);
      return;
    }
    if (res && res.applied === false) return;
    repaintStart();
    setStatusT('status.recent-removed', {});
  }

  /**
   * ⭐ `design/0045`（隐私）：启动页「清空」**第二下**才走到这里
   * （第一下由 `StartScreen` 就地变成"确认清空？"，判据是 `start.js::clearConfirm`）。
   *
   * ⚠️ 清的是 **`config.json` 里的 `dir_sessions` ＋ `last_directory`**——
   *    ⛔ 不删磁盘上的任何目录、⛔ 不撤授权（`INV-REC-01`）。
   */
  async function clearRecentFromUi() {
    let res;
    try {
      res = await S.clearRecent();
    } catch (e) {
      setStatusT('status.recent-clear-failed', { msg: e.wording || e.message }, true);
      console.error('清空「最近的目录」失败：', e);
      return;
    }
    if (res && res.applied === false) return;
    repaintStart();
    setStatusT('status.recent-cleared', {});
  }

  /** 用户点了「打开目录」（按钮 / `Cmd+O` / 未授权态里那个按钮）。 */
  async function onChooseDirectory() {
    // ⭐ `design/0020` §2.3 ③(c)：切根会让代次 +1 ⇒ 必须**赶在代次变之前**落地，
    //    否则这次写必然 `stale`（上一棵树的展开态就白记了）。
    // ⚠️ 先作废在跑的恢复（它的 `alive()` 也会兜住，这里是第二重）。
    if (dirRestorer) dirRestorer.cancel('root-changed');
    if (dirWriter) await dirWriter.flush();
    try {
      await S.chooseDirectory();
    } catch (e) {
      setStatusT('status.choose-dir-failed', { msg: e.wording || e.message }, true);
      return;
    }
    // 目录模式下没有"当前文档"：显式空态，⛔ **不自动打开第一个文件**（§2.1）
    showDocEmptyT('doc.empty-choose');
    // ⭐ 换根 ⇒ 图片缓存整表作废（2026-10-29 代码评审第 6 条）：进的是**另一组文件**，
    //    旧条目再也不会被命中（键里带文档身份），留着只是白占内存。⚠️ 键里那个身份
    //    本身已经保证了"不会贴错图"——这里做的是**腾地方**，不是正确性。
    ImageView.clearAssetCache();
    setDirectoryStatus();
    sidebar.setTab('tree');
    await renderSidebar();
  }

  /** 用户点了「打开文件」（`Cmd+Shift+O`）。 */
  async function onChooseFile() {
    // ⭐ `design/0020`：打开外部单文件 = 用户接管 ⇒ 作废在跑的恢复，
    //    并把上一棵树的会话先落地（`choose_file` 可能改变根集合/模式）。
    if (dirRestorer) dirRestorer.cancel('user-open');
    if (dirWriter) await dirWriter.flush();
    let snap;
    try {
      snap = await S.chooseFile();
    } catch (e) {
      setStatusT('status.choose-file-failed', { msg: e.wording || e.message }, true);
      return;
    }
    const target = snap.startup_document;
    if (!target) return; // 用户取消
    await openDocument(target);
    // ⚠️ 顺序：`openDocument` 内部可能触发 §2.1.4 第 ③ 步（收回旧 root），
    //    所以侧边栏要在**它之后**才刷。
    await renderSidebar();
  }

  /**
   * ⭐ 搜索浮层里回车选中的那一条（`design/0009` §2.1 ④⑤）。
   *
   * ⚠️ 它走的是**既有的那条打开路径**（`openDocument` → `open_document`），
   * ⛔ 不是另一条"搜索专用"的打开方式：读盘校验、提交点判定、监视、树定位
   * 全都只该有一份实现（`INV-FS-01` / `INV-SINGLE-01` 的同一条精神）。
   * ⭐ 树定位由 `mountDocument` 里的 `revealInTree` 负责——所以这里**不再**调一次。
   *
   * ⚠️ 不 `await` 完之后刷侧边栏：目录模式下根与代次都没变，
   * `renderSidebar` 会原地返回；而单文件模式根本开不出浮层（见 `isAvailable`）。
   */
  async function openFromQuickOpen(realPath) {
    const payload = await openDocument(realPath);
    if (!payload) return;
    // ⚠️ 成功时**什么都不补**：状态条上那行摘要是用户要看的东西，
    //    ⛔ 不要用"已从搜索打开"之类的句子把它盖掉（那就是第二个真值）。
    console.log('搜索浮层打开：', realPath);
  }

  /**
   * ⭐ `design/0042`：侧边栏搜索的**结果层**显隐（进入 / 退出"正在搜"）。
   *
   * 两件事，都在这一处（⛔ 别让组件去改面板 `hidden`——`Sidebar.applyPanes` 是唯一计算处）：
   * ① 树 / 列表都不算"可见"（`isFilesVisible()` 会返回 false）⇒ 列表分片停下、
   *    盘上变化只置脏标记而不重建（`design/0041` §2.2 时机⑤的同一套判据）；
   * ② 退出搜索时把 ① 欠下的树刷新**补消费**一次（与 `onTabChange` 同形）。
   */
  function onSidebarSearchActive(on) {
    if (sidebar) sidebar.setSearchActive(on);
    // ⚠️ 顺序：先让 `Sidebar` 承认状态，`isFilesVisible()` 才是**新**的答案。
    if (docList) docList.setActive(!on && effectiveFileView() === 'list' && sidebar.isFilesVisible());
    if (on) return;
    if (treeFilterStale) {
      treeFilterStale = false;
      if (S.state.hideEmptyDirs && tree) tree.refreshVisible();
    }
  }

  /**
   * ⭐ `design/0042`：离开目录模式时把底部搜索**收起并清空**。
   * ⚠️ 两件事都要做：只收起输入框会留下一份"看不见但还在显示着"的结果层
   * （下次进目录时它会突然盖住一棵用户没搜过的树）。
   */
  function hideSidebarSearch() {
    if (sidebar) sidebar.setSearchAvailable(false);
    if (sidebarSearch) sidebarSearch.reset();
  }

  /**
   * ⭐ `design/0025` §2.4/§2.6：语言的**读写口**（建好之后注入给设置覆盖层）。
   *
   * # 为什么它不像主题那样有个服务文件
   *
   * 主题那半有一个 `theme.js`，是因为它要维护**一条写盘队列**（`INV-THEME-05`：
   * 五个键一次写完，⛔ 不能四次并发）。语言只有**一个**键，而且它**必须改菜单**
   * ——那件事只有后端命令能做 ⇒ 这里就是一层薄接线，⛔ 不值得为它再造一个服务。
   *
   * ⚠️ **它⛔ 不经过 `theme.js` 的队列**：混进去会让"改语言"和"改字号"共享一个
   * `Appearance` 快照，而后端那两个命令认的是**不同的载荷**（`appearance` vs `preference`）。
   *
   * ⚠️ `menu_updated === false` **必须说出来**（`INV-I18N-05`：⛔ 不许假装成功）：
   * 界面已经换了、菜单没换，用户看到的是"菜单还是旧语言"——
   * 那条消息就是这个不一致**唯一的解释**，⛔ 别吞进控制台了事。
   */
  function createLanguageDep() {
    return {
      get: function () { return langPreference; },
      set: function (pref) {
        const want = (pref === 'zh' || pref === 'en') ? pref : 'system';
        return T.call('set_language', { preference: want }).then(function (r) {
          const res = r || {};
          // ⚠️ 以后端回来那份为准：它可能把未知串归一成 `system`。
          langPreference = (typeof res.preference === 'string') ? res.preference : want;
          if (I18N && typeof res.effective === 'string' && res.effective !== I18N.lang()) {
            // ⭐ 顺序承重：`setLang` 内部先换字典 + `<html lang>`，再 `applyDom`，最后通知订阅者
            //    （`design/0025` §2.5.1 末）。⛔ 这里不许自己再贴一遍 DOM。
            I18N.setLang(res.effective);
          }
          if (res.menu_updated === false) {
            setStatusT('status.menu-lang-pending', null, false);
            console.warn('⚠️ 菜单未能立即切换语言（menu_updated=false），将在重启后生效');
          }
          return res;
        });
      }
    };
  }

  /**
   * ⭐ 用**会话快照**复核语言（`design/0025` §2.4）。
   *
   * ⚠️ 首帧的语言来自注入脚本（`window.__rmdLang`，`i18n.js` **加载期**取）
   * ——那是为了不让英文系统先闪一屏中文（评审 #6）。
   * 这里**只核对**：两者不一致说明注入与快照分叉了，如实记一条诊断，**以快照为准**
   * （菜单是后端在启动期建的，它认的是快照这条路上的那份配置）。
   */
  function applySnapshotLanguage(snap) {
    if (snap && typeof snap.language_preference === 'string') {
      langPreference = snap.language_preference;
    }
    if (!I18N || !snap || typeof snap.language !== 'string') return;
    if (snap.language !== I18N.lang()) {
      console.warn('⚠️ 注入语言与快照不一致（注入=' + I18N.lang() +
        '，快照=' + snap.language + '），以快照为准');
      I18N.setLang(snap.language);
    }
  }

  /**
   * ⭐ 快捷键与设置覆盖层（`design/0010` §2.1 ②⑤⑦）。在 `bootInner` 的第 1.5 步调一次。
   *
   * # 三件事，顺序有讲究
   *
   * 1. **先拿后端的表**（`get_shortcuts`）。⚠️ 拿不到就**响亮报**——ACL 少一条
   *    `allow-get-shortcuts` 时的表现是"设置界面里那一列空着"，**看起来像"没有快捷键"，
   *    不像出错**（§6 的失败表点名了这条）。⛔ 所以这里不吞异常。
   * 2. **建 `keymap` 并注册全部 handler**。⚠️ `ACTIONS` 是**全动作**注册表——
   *    `owner = Menu` 的两个也在里面（菜单点击要走同一个 `dispatch`，`INV-SET-02`）。
   * 3. **最后自检**（§2.1 ② 的第三层）：这是**唯一**能同时看到"后端那张表"
   *    与"前端这份 handler 表"的地方，所以它只能在运行时做。
   *    ⚠️ 缺与多**都要报**——多了的那条正是"迁移漏删的旧绑定"。
   */
  async function setupKeys() {
    try {
      shortcutTable = await T.call('get_shortcuts');
    } catch (e) {
      // ⚠️ 不 `reportFatal`：阅读器的主体功能不受影响（`design/0010` §6 的失败表
      //    把它归为"列表空着"而不是"打不开"）。⛔ 但**绝不静默**——
      //    `actionsCheck.ok` 会是 false，冒烟判据 `快捷键=` 与 `动作=` 会变红。
      console.error('⛔ 拿不到快捷键表（多半是 ACL 少了 allow-get-shortcuts）：', e);
      shortcutTable = [];
    }

    // ⭐ `design/0012` §2.3-5：**可编辑焦点的垫片**。⛔ 必须先于 `createKeymap` 建——
    //    `keymap` 在**加载期之后、建实例这一刻**把 `ctx` **按引用**收进去
    //    （`keymap.js` 里 `const ctx = opts.ctx || {…}`），所以这个对象之后每次
    //    `bind()` 换掉里面的函数，`keymap` 看到的是**同一份**。
    //    ⚠️ 反过来（先建 keymap、再给它换 ctx）改不动——那个默认对象已经拷进去了。
    forwardShim = EdKeys.createForwardShim({ win: window });

    keymap = K.createKeymap({ table: shortcutTable, ctx: forwardShim.ctx });
    forwardShim.bind(keymap);

    settings = Settings.createSettings({
      theme: theme,
      shortcuts: shortcutTable,
      // ⭐ `design/0025` §2.6：语言的读写口。⚠️ 没有它设置里就**不渲染那一行**
      //    （`Settings.js` 拿不到依赖时不臆造入口），而这里恒给 ⇒ 那一行必然在。
      language: createLanguageDep(),
    });

    // ⭐ `design/0009`：文件名搜索浮层。⚠️ **只在这里建一次**，
    //    它是**应用内的一层**（与设置覆盖层同族，`INV-SET-07` 的互斥前提）。
    quickOpen = QuickOpen.createQuickOpen({
      // ⚠️ 转接（⛔ 不把 `session` 整个递进去）：浮层不认识 IPC，
      //    它只拿到"给我一个 pattern + 要不要重建，还你一份结论"。
      search: function (pattern, rebuild) { return S.searchFiles(pattern, rebuild); },
      onPick: function (realPath) { openFromQuickOpen(realPath); },
      onError: function (e) { console.warn('搜索出错：', e); },
      // ⚠️ **只为读 `bindings`**：刷新索引那个键**从后端那张表里认**
      //    （`INV-SET-01`），⛔ 浮层源码里没有键位字面量。
      keymap: keymap,
      refreshId: 'file.refresh-index',
      keyText: accelText,
      // ⭐ 单文件/空会话里**按了没反应**（§2.1 ④ 末）：那里没有 root，
      //    索引是空的，弹出来只会是一个永远搜不到东西的框。
      isAvailable: function () {
        return S.state.mode === 'directory' && S.state.roots.length > 0;
      },
    });

    // ⭐ `design/0011`：正文内查找浮层。⚠️ 与 `quickOpen` 同族——**应用内的一层**，
    //    注册进 `Settings` 的**同一个**登记处 ⇒ `⌘F` / `⌘P` / 设置三者互斥（`INV-FIND-06`）。
    // ⭐ `design/0042`：侧边栏底部常驻的文件名搜索。⚠️ 它与 `quickOpen` **共用**
    //    `session.searchFiles`（同一份 Rust 匹配实现、同一套 `req`/代次判据），
    //    ⛔ 不是第二条搜索路径。它**不是覆盖层**（常驻在侧边栏里），所以不登记进
    //    `Settings` 的登记处。
    sidebarSearch = SidebarSearchUI.createSidebarSearch({
      els: {
        input: $('sidebar-search-input'),
        pane: $('pane-search'),
      },
      search: function (pattern, rebuild) { return S.searchFiles(pattern, rebuild); },
      // 与 `⌘P` 完全同一条打开路径（授权 / 版本 / 监视 / 树定位都只该有一份）
      onPick: function (realPath) { openFromQuickOpen(realPath); },
      onActiveChange: onSidebarSearchActive,
      onError: function (e) { console.warn('侧边栏搜索出错：', e); },
      // ⚠️ **只为读 `bindings`**：刷新索引那个键从后端那张表里认（`INV-SET-01`）。
      keymap: keymap,
      refreshId: 'file.refresh-index',
    });

    findBar = FindBar.createFindBar({
      // ⚠️ **取**而不是缓存元素：`design/0006` 的自动重载会换掉 `#doc` 的内容，
      //    而 `invalidate()` 之后重扫要拿到**当时**那一棵。
      getDoc: function () { return $('doc'); },
      // ⚠️ **只为读 `bindings`**：`⌘G`/`⇧⌘G` 从后端那张表里认（`INV-SET-01`），
      //    ⛔ 浮层源码里没有键位字面量（`keymap.test.js` 的源码级闸门盯着）。
      keymap: keymap,
      keyText: accelText,
      nextId: 'edit.find-next',
      prevId: 'edit.find-prev',
      // ⭐ 单文件模式**也能搜**（与 `⌘P` 相反）：那时正文就在屏幕上，搜的是它。
      isAvailable: function () { return !!S.state.currentDoc; },
    });

    // ⭐ `design/0018`：图片缩放预览层。⚠️ 与上面两层同族——**应用内的一层**，
    //    注册进 `Settings` 的**同一个**登记处 ⇒ 与查找 / `⌘P` / 设置**双向互斥**（`INV-ZOOM-04`）。
    //    ⭐ 委托挂在 `#doc` 上（不是每张图上）：`#doc` 的 `innerHTML` 会被整棵替换，
    //    而 `#doc` 本身是活的。⚠️ `getViewer` 是取值器、⛔ 不缓存实例（`destroy` 之后要拿得到 null）。
    imageViewer = ImageViewer.createImageViewer();
    ImageViewer.installDelegation($('doc'), function () { return imageViewer; });

    // ⭐ `design/0026`：正文里的链接委托。⚠️⚠️ **必须排在上一行之后**——
    //    `<a><img></a>` 上图片那一层先 `preventDefault`，链接这一层读它退出
    //    ⇒ 一次点击只发生一个动作（§6「最怕的四件事」最后一条）。
    //    ⚠️ 委托挂在 `#doc` 上：它的 `innerHTML` 会被整棵替换，而它自己是活的。
    installLinkDelegation($('doc'));

    // ⭐ **十二个 id 一个都不少**（`INV-SET-02`②）。⚠️ 少一个不会报错，
    //    只会让那个键/那个菜单项**按下去没反应**——所以 `checkActions` 会点出来。
    //    （`design/0037` 起这条表再加一项 `view.toggle-chrome`，同上：漏了就静默。）
    keymap.register('settings.open', function () { settings.open(); });
    keymap.register('view.toggle-sidebar', function () {
      sidebar.setCollapsed(!sidebar.isCollapsed());
    });
    // ⭐ `design/0037`：折叠 / 收回顶栏（`⇧⌘B`，与上面那条相邻：都是"把界面让给正文"）。
    //    ⚠️ handler 挂 id、⛔ 不认键（`INV-SET-01`：换键只动 Rust 那张表）。
    keymap.register('view.toggle-chrome', function () { setChromeHidden(!chromeHidden); });
    keymap.register('file.open-directory', function () { onChooseDirectory(); });
    keymap.register('file.open-file', function () { onChooseFile(); });
    keymap.register('reader.font-inc', function () {
      theme.setFontSize(theme.applied.fontSize + 1);
    });
    keymap.register('reader.font-dec', function () {
      theme.setFontSize(theme.applied.fontSize - 1);
    });
    keymap.register('reader.font-reset', function () {
      theme.setFontSize(theme.DEFAULTS.fontSize);
    });
    // ⭐ `design/0006`：外部编辑器（§9.3 第 4 条）——它与 File 菜单那条**无加速键**
    //    的普通项（`PLAIN_MENU_ITEM_IDS`）共用这一个 handler：
    //    菜单点击走 `rmd://menu` → 同一个 `dispatch`（`INV-SET-02`）。
    //    ⚠️⚠️ **它的加速键 2026-10-16 从 `⌘E` 改成 `⇧⌘E`**（`⌘E` 让给下面那条
    //    `edit.toggle`）。⛔ 这一行**没有跟着改**——handler 按 id 挂，⛔ 不认键。
    //    这正是 `INV-SET-01`（表是唯一来源）买到的东西：换键只动 Rust 那一处。
    keymap.register('file.open-external-editor', function () { openExternalEditor(); });
    // ⭐ `design/0012`：`⌘E` = **进入 / 退出分栏编辑态**（2026-10-16 用户裁定，与上面那条换键）。
    //
    //   ⚠️ 在此之前分栏编辑**只有顶栏 `#btn-edit` 一个入口**——V2 的头等功能挂了把鼠标，
    //      而"编辑"最顺手的那个键被 `adr/0006` 的 V1 替代方案（外部编辑器）占着。
    //   ⚠️ 它**有副作用**（⛔ 不是 `file.refresh-index` 那种空 handler）：
    //      与顶栏那个按钮**共用同一个 `toggleEdit()`**——⛔ 不许另写一条"按下就进编辑态"
    //      的捷径（编辑态的真值在 `Ed` 那边，写第二条路迟早与它对不上）。
    //   ⚠️ 面板互斥由 `toggleEdit` 自己处理：进编辑态前它要先把 `⌘F` / `⌘P` / 设置
    //      那三层浮层收掉，⛔ 不在这里再判一次（同一件事两份判据 = 迟早漂）。
    keymap.register('edit.toggle', function () { toggleEdit(); });
    // ⭐ `design/0009`：按文件名搜索（浮层的**唯一**入口）。
    keymap.register('file.quick-open', function () {
      // ⚠️ 非目录模式（单文件 / 空会话）**按了没反应**，但**说一声到 stderr**：
      //    `open()` 返回 `false` 这件事只有这里知道，用户看到的是"键按下去没动静"。
      if (!quickOpen.open()) console.log('文件名搜索：当前不是目录模式（没有已授权的目录）');
    });
    // ⭐ `file.refresh-index`（`design/0009` §2.1 ②）：**登记进表、但全局什么都不做**。
    //
    //   ⚠️ 它为什么不做事：这个键是**浮层的局部键**（浮层内重建索引，弹层里那一行
    //      提示也写着它）。开成全局动作会有两个后果：① 浮层没开时按它没有任何意义；
    //      ② `INV-SET-04` 的"两组所有者不重叠"要靠 **owner** 分，而不是靠"运行时看看
    //      浮层开没开"——那种判据在两端都挂 keydown 时只能去赌 AppKit 的行为（`kb/0016` §6）。
    //   ⚠️ 它为什么**还是**要登记：`INV-SET-01` 要求键位的唯一来源是后端那张表，
    //      而浮层要能在**不写键位字面量**的前提下认出这个键 ⇒ 必须有一条表项
    //      把 `accel` 送下来（`display` 也一并送，那一行提示要用）。
    //   ⚠️ 已知后果：`⌘R` 从此由前端 `preventDefault` 吃掉。macOS 的 `Menu::default`
    //      里**没有** Reload（那个键在别的平台上是"重载页面"），所以没有东西被抢走。
    keymap.register('file.refresh-index', function () {
      // ⛔ **故意是空的**（见上）。`INV-SET-02`② 要的是"每个 id 都有 handler"，
      //    判据是**存在**，不是"必须做事"——所以这条空函数是**要求的**形状，
      //    不是忘了写。⚠️ `checkActions` 会因为它存在而判 `动作=全`。
    });

    // ⭐ `design/0011`：正文内查找（§9.1 第 2/5 条，三条都归 `Owner::Web`）。
    //
    //   ⚠️ `edit.find` **同时**进 `PLAIN_MENU_ITEMS`（Edit 菜单里看得见、**无加速键**）——
    //      菜单点击走 `rmd://menu` → 同一个 `dispatch`（`INV-SET-02`）。
    //      「菜单里有没有这一项」与「这个键归谁处理」是**两个维度**（`0006` 的 `⌘E` 先例）。
    //   ⚠️ 单文件/空会话里 `open()` 返回 `false` ⇒ **按了没反应**，但**说一声到 stderr**
    //      （与 `file.quick-open` 同一条纪律：`open()` 的返回值只有这里知道）。
    keymap.register('edit.find', function () {
      // ⭐ `design/0047` §4.3：覆盖层里按 `⌘F` ⇒ **先提交退出，再开浮层**。
      //    ⚠️ 不能直接在覆盖层里开：浮层要的是"整篇正文"的字符偏移，而活动那一块
      //       此刻还是**源码形态**（Markdown 标记没被渲染掉）⇒ 高亮会整体错位，
      //       而且"找到了但看不见"（`INV-FIND-05` 那条不诚实）。
      if (live && live.isEditing()) {
        liveSerial(function () { return leaveLive({}); }).then(function () {
          if (!findBar.toggle()) console.log('正文内查找：还没有已打开的文档（没有可搜的正文）');
        });
        return;
      }
      if (!findBar.toggle()) console.log('正文内查找：还没有已打开的文档（没有可搜的正文）');
    });
    //   ⚠️ 下面两条在**浮层没开时是明确的 no-op**（§9.1 第 5 条）——⛔ 不顺手把浮层打开：
    //      `⌘G` 离开"查找中"没有意义，而在浏览时按一下弹出一个空浮层是**抢焦点**。
    //   ⚠️ 它们**还是要登记**（`INV-SET-02`② 的"每个 id 都有 handler"），
    //      而且**浮层开着时这两条全局 handler 根本不会被调到**——焦点在输入框里，
    //      `keymap.dispatch` 被 `ctx.editable()` 整条挡掉（`design/0010` §2.1 ③）。
    //      ⇒ 浮层内那两条键由 `FindBar` 自己的本地模型接（`INV-FIND-09` 先挡组合态）。
    //      ⛔ 这不违反 `INV-SET-04`（两组所有者不重叠）：那一条管的是**菜单加速键**
    //      与**前端 keydown** 不重叠，而这里浮层本地那条是**宿主内的键盘导航**
    //      （与 `QuickOpen.js` 的 Esc/↑↓ 同族、同在 `keymap.test.js` 的白名单里）。
    keymap.register('edit.find-next', function () { findBar.next(); });
    keymap.register('edit.find-prev', function () { findBar.prev(); });

    // ⭐ `bugs/0036`（2026-10-29）：`⌘A` = **全选正文**（⛔ 不含侧边栏与顶栏）。
    //    ⚠️ 三个语境的分工见 `selectAllText()` 的头注释：
    //       就地编辑态**走不到这里**（那一块自己认领，选的是当前块），
    //       分栏编辑态转发进来 ⇒ 选编辑器全文。
    //    ⚠️ 这条 handler 的失效形态是"**选到了侧边栏**"——只看选区长度看不出对错，
    //       所以它的判据在 `tests/js/live-wiring.test.js`（源码级）＋ `bugs/0036` §6 的手工表。
    keymap.register('edit.select-all', function () { selectAllText(); });

    // ⭐ `design/0012` §2.3-4 / `INV-EDIT-10`：**唯一的保存入口**。
    //    ⚠️ 三条路（`⌘S` / 工具栏按钮 / 编辑区里的转发）全都落到 `saveNow()`——
    //       ⛔ `save.js` 不从这里调第二次，⛔ 也不在别处再调一次 `S.saveDocument`
    //       （两份"保存"的差别迟早会漂，而漂的那一天丢的是用户的字）。
    //    ⚠️ 阅读态按它**说一声**（`saveNow` 里那一支），⛔ 不是无声 no-op。
    keymap.register('file.save', function () { saveNow(); });

    // ⭐ `design/0012` §2.3-4：**转发白名单的派生**——"哪些应用键在编辑区里
    //    还能用"这件事，⛔ 不是一张手写的清单，而是从后端那张表**现算**出来的。
    //    ⚠️ 手写清单的失败形态是**静默的**：改一次 `accel` 就少一条，
    //       而表现只是"某个键在编辑区里按不动"（界面上没有任何异常）。
    //    ⚠️ `skipped` / `notes` 是给人看的**为什么没进来**，进 `report_status`。
    forwardCheck = EdKeys.deriveWhitelist(shortcutTable);
    // ⚠️ 派生出来的结果自己也要**对得上**才有意义：一条都没派生出来 ⇒
    //    编辑区里所有应用键都失效（那正是 `edit_ok` 第 ③ 项要挡的形态）。
    //    ⛔ 但**不在这里下结论**——自证（`runEditSelfTest`）是唯一判几次的地方，
    //       这里只负责把 `specs` 交给它，两处判据不重复。
    forwardCheck = {
      ok: !!(forwardCheck && forwardCheck.specs && forwardCheck.specs.length),
      specs: (forwardCheck && forwardCheck.specs) || [],
      skipped: (forwardCheck && forwardCheck.skipped) || [],
      notes: (forwardCheck && forwardCheck.notes) || [],
      note: !(forwardCheck && forwardCheck.specs && forwardCheck.specs.length)
        ? '转发白名单是空的（应用键在编辑区里会全部失效）'
        : '转发白名单 ' + forwardCheck.specs.length + ' 项，跳过 ' +
          ((forwardCheck && forwardCheck.skipped) || []).length + ' 项',
    };

    // ⭐ 转发扩展：**只在 bundle 在的时候建**（不在就是"没跑过 `make cm6`"，
    //    而那种情况下编辑功能整体不可用、自证会报出来，⛔ 不必在这里再报一次）。
    //    ⚠️ `Prec.low` 由 `buildBindings` 自己包（那是它的产物之一，见 `keys.js`）。
    forwardExt = window.rmdCM6
      ? EdKeys.buildBindings(window.rmdCM6, forwardCheck.specs, forwardShim.forward)
      : null;

    keymap.attach();

    // ⭐ **菜单点击 → 前端**（§2.1 ⑧）：菜单是 Rust 建的，事件也只到 Rust，
    //    所以这条通道是我们自己接的。⚠️ 它走 `core:` 插件命令、**受 ACL 管**——
    //    失败必须**响亮**（`.agent/spec.md` 纪律 6），⛔ 不能是
    //    "菜单点下去没反应、stderr 里什么都没有"。
    //    ⚠️ 而"只在控制台里喊"**不算响亮**：本项目的控制台没人看（批 1 起就如此）
    //    ⇒ 结果要进 `report_status` 的回报，让 `make smoke` 判得出来（`kb/0007` 的坑）。
    try {
      await T.listen('rmd://menu', function (e) {
        // ⚠️ 走**同一个** `dispatch`：菜单路径也要挡组合态与可编辑焦点（`INV-SET-05`）。
        keymap.dispatch(e.payload, 'menu');
      });
      listenCheck = { ok: true, note: '' };
    } catch (e) {
      console.error('⛔ 订阅菜单事件失败（多半是 ACL 少了 core:event:allow-listen）：', e);
      listenCheck = { ok: false, note: String((e && (e.message || e.wording)) || e) };
    }

    // ⭐ `design/0033`：命令行工具菜单那两步的**结果**（`rmd://cli-tool`）。
    //    ⚠️ 它和菜单通道用**同一条** ACL 权限（`core:event:allow-listen`），但**不进 `listenCheck`**：
    //    那个标志是 `design/0010` 菜单通道的判据（`make smoke` 会判），把它染红等于让
    //    "命令行工具这条路没接上"看起来像"菜单坏了"。
    //    ⭐ 重画走 `setStatusFn`（**存的是取值器、不是字符串**）⇒ 切语言后这一行会跟着变
    //    （`summarize()` 只出键、`render()` 被调用那一刻才查字典，见 `services/clitool.js`）。
    try {
      await T.listen('rmd://cli-tool', function (e) {
        const payload = (e && e.payload) || {};
        const lines = CT.summarize(payload);
        setStatusFn(function () { return CT.render(lines, t); }, CT.isError(payload));
      });
    } catch (e) {
      console.error('⛔ 订阅命令行工具结果失败（多半是 ACL 少了 core:event:allow-listen）：', e);
    }

    actionsCheck = keymap.checkActions();
    if (!actionsCheck.ok) {
      console.error('⛔ 快捷键自检没过：', actionsCheck.note);
    } else {
      console.log('快捷键自检：', actionsCheck.note);
    }

    // ⭐ 文件变化事件（`design/0006` §2.1 ②）。
    //    ⚠️ 它**不**进 `listenCheck`：那是 `design/0010` 菜单通道的判据，
    //    两条通道用的是同一条 ACL 权限（`core:event:allow-listen`）但**各自独立**——
    //    把两者混成一个标志，会让"菜单能点但文件变化收不到"看起来一切正常。
    //    ⚠️ 这里**等它**（不像别的订阅那样 fire-and-forget）：回报里那个 `watch_note`
    //    必须在 `report()` 之前就是最终值，否则冒烟会在"订阅还没回来"与
    //    "订阅失败了"之间分不清（§7 的判据要的是前者不算失败）。
    try {
      await T.listen('rmd://document-changed', function (e) { onDocumentChanged(e.payload); });
      watchListenOk = true;
      watchListenNote = '';
      watchListenArg = '';
    } catch (e) {
      watchListenOk = false;
      watchListenArg = String((e && (e.message || e.wording)) || e);
      // ⚠️ 诊断那句留中文（报告 / 冒烟按它取数，⛔ 不随用户语言漂）。
      watchListenNote = '收不到文件变化事件（自动刷新不可用）：' + watchListenArg;
      console.error('⛔ 订阅文件变化事件失败：', e);
    }

    // ⭐ `design/0034`：目录内容变了（新建 / 外部改动 / 新建之后自己触发的那一次）。
    //    ⚠️ 载荷**为空**（`INV-TREE-08`）：这条通道只负责说"某些层可能旧了"，
    //    具体哪一层由 `FileTree` 的 `layerEpoch` 按路径判——⛔ 不在这里猜。
    //    ⚠️ 它**不进 `listenCheck` / `watchListenOk`**：各自通道各自的判据，
    //    混成一个标志会让"菜单能点、树不刷新"看起来一切正常（同上面几条的纪律）。
    //    ⚠️ 刷新事务**已经被提交**才把当前项挂回去：事务没提交时树还是旧的，
    //    `setCurrent` 挂上去也只是白挂（下一次提交会再挂一次）。
    //
    //    ⭐ `design/0050` 起**订阅本身在 `services/diskevents.js`**（最终约束 4/8）：
    //    那条通道一到就同步推进内容修订（在途结果作废），这里只收"该重列了"的回调。
    //    ⚠️ 两件事分开的意义：健康变化（`dir-watch` 降级 / 恢复）会走另一条回调，
    //    ⛔ 不会顺手把树重列一遍。
    //    ⚠️ 订阅失败**必须报出来**：静默失败的表现是"盘上变了但树不刷新"，
    //    与"没有变化"长得一模一样。⛔ 它不是致命错（阅读仍可用），所以只报不抛。
    const diskInstall = await DE.install(T);
    if (!diskInstall.treeOk) {
      console.error('⛔ 订阅目录变化事件失败（盘上改动不会自动出现）：', diskInstall.note);
    }
    if (!diskInstall.diskOk) {
      console.error('⛔ 订阅目录监视状态失败（降级不会显式告知）：', diskInstall.note);
    }
    DE.onChange(function () {
      if (!tree) return;
      tree.noteTreeChanged().then(function (r) {
        if (r && r.committed) tree.setCurrent(S.state.currentPath);
      }).catch(function (e) {
        console.error('⛔ 刷新侧边栏失败：', e);
      });
      // ⭐ `design/0041` §2.2 时机 ⑤：盘上变了 ⇒ 清单也旧了。
      //    ⚠️ 只置脏（可见时去抖重建一次），⛔ 不在这里等它、⛔ 不让树的重建等它。
      noteDocListStale();
    });
    DE.onState(function () { renderDiskBar(); });
    // ⚠️ 启动时先画一版：快照里那份 `DiskView` 是在 `session.applySnapshot` 里采纳的，
    //    它早于这里的订阅 ⇒ 不补这一下，**启动时就已降级的会话**要等到下一次
    //    健康变化才有提示（可能是几十分钟之后）。
    renderDiskBar();


    //    ⚠️ 它**不进 `listenCheck`**，也⛔ 不并进 `watchListenOk`：那是各自通道的判据。
    //    两条通道共用 `core:event:allow-listen`，但把三者混成一个标志会让
    //    "菜单能点、双击文件没反应"看起来一切正常。
    //    ⚠️ 冷启动时 macOS 可能先把 `odoc` 投给进程，而那时本监听还没注册
    //       ⇒ 唤醒信号会丢，但队列还在；引导阶段第 4.5 步会**主动 drain 一次**。
    try {
      await T.listen('rmd://open-path', function () { queueDrainPendingOpens(); });
    } catch (e) {
      console.error('⛔ 订阅 Apple Event 打开请求失败（多半是 core:event:allow-listen 被拒）：', e);
    }
    syncReloadBar();
  }

  /**
   * ⛔ 启动过程中出的任何错都要**回报给后端**再退出。
   *
   * ⚠️ 这条不是"顺手加的"：没有它，一个前端异常的表现是
   * **一个永远开着的空白窗口 + 一条完全静默的 stderr**——
   * 而 `tools/smoke-gui.sh` 只能看到"进程还在跑"，看不出任何东西。
   * （2026-10-13 实施时真踩到了：`DocumentPayload` 少回带 `gen`
   *   → 提交点判成陈旧 → 正文静默不挂 → 冒烟挂在那儿不动。）
   */
  async function reportFatal(err) {
    const msg = (err && (err.stack || err.message)) || String(err);
    console.error('启动失败：', err);
    setStatusT('status.startup-failed', { msg: msg }, true);
    try {
      await T.call('report_status', {
        report: {
          ok: false,
          summary: '启动失败：' + msg,
          doc_children: 0,
          scroll_height: 0,
          viewport_height: window.innerHeight,
          text_len: 0,
          sample: '',
          entry_types: supportedEntryTypes(),
          user_agent: navigator.userAgent,
          sidebar_mode: 'empty',
          doc_loaded: false,
          tree_nodes: 0,
          tree_ignored: 0,
          tree_current: 0,
          unauthorized_explicit: false,
          theme: document.documentElement.dataset.theme || '',
          reader_font_size: parseFloat(cssVar('--reader-font-size')) || 0,
          // ⚠️ 失败路径也如实带上——**这份恰好是最需要看见它们的时刻**
          //    （"快捷键表拿不到"往往就是启动失败的原因）。
          shortcuts: shortcutTable.length,
          actions_ok: !!actionsCheck.ok,
          actions_note: String(actionsCheck.note || ''),
          listen_ok: !!listenCheck.ok,
          listen_note: String(listenCheck.note || ''),
          // ⚠️ 失败路径也如实带上：**"起监视那一步"正是最可能出问题的地方**
          //    （ACL 少一条 `allow-watch-document` 时，现象就是这里非空）。
          watch_seq: S.state.watchSeq,
          watch_dropped: S.state.watchDropped,
          // ⚠️ ⛔ **不编话**：启动可能在订阅那一步**之前**就挂了，
          //    那时这里就是空串——如实空着，别写成"通道未订阅"，
          //    那会把一个未发生的事实写进回报（`design/0003` §7 步骤 18 的同族要求）。
          watch_note: String(S.state.watchNote || watchListenNote || ''),
          // ⭐ `design/0012`：失败路径也如实带（与上面几个同一条纪律）——
          //    "启动就挂"的那一刻，编辑面**多半就是没自证过**，而这正是最需要
          //    看见的东西：`edit_ok=false` + `edit_note` 那句话通常直接就是原因。
          //    ⚠️ 后端那六个字段全 `#[serde(default)]`，缺着也收得下，
          //       ⛔ 但**缺着**与**是 false** 在回报里长得不一样——别省。
          edit_ok: !!editSelfCheck.ok,
          edit_note: String(editSelfCheck.note || ''),
          editor_mounted: !!editing,
          editor_dirty: !!editDirty,
          preview_req: editorPreview ? editorPreview.latestReq() : -1,
          preview_stale: editorPreview ? !!editorPreview.isStale() : false,
        },
      });
    } catch (e) {
      console.error('连回报都失败了：', e);
    }
  }

  /** 启动流程。⚠️ 任何异常都走 [`reportFatal`]——⛔ 不许静默。 */
  async function boot() {
    try {
      await bootInner();
    } catch (e) {
      await reportFatal(e);
    }
  }

  async function bootInner() {
    // ⭐ **测量器必须是第一行**：`paint` / `largest-contentful-paint` 要它**从最早一刻起**
    //    就在听，否则 T6/T6b 会漏掉这一轮的首屏绘制（`design/0002` §7.3.2）。
    //    ⚠️ 它只读时钟与性能条目、⛔ 不碰 DOM、不改状态——放在这儿不污染任何被测时刻。
    if (M) measure = M.createMeasure();

    // ⚠️ 先确认 `window.__TAURI__` 在——不在的话后面每一条命令都会抛同一句话，
    //    不如在这里就说一次。`withGlobalTauri` 关掉时就是这个形态。
    T.resolveInvoke();

    const doc = $('doc');

    // —— 0.05 启动页（`design/0038`）——
    // ⚠️ 必须排在**任何 `showDocEmpty` 之前**：那一族函数是它的唯一挂载点
    //    （`INV-START-01`），建晚了启动页就永远不出现，而界面上看不出任何异常。
    // ⚠️ `overlayOpen` 里读的是 `settings` / `quickOpen` / `findBar` / `imageViewer`
    //    **此刻的值**——它们在这一步还是 `null`（`setupKeys` 才建）⇒ 必须包成函数。
    // ⛔ `onOpen` 就这一处：行点击与数字键走的是**同一条**授权命令（§2.1 ③）。
    startScreen = SS.createStartScreen({
      onOpen: onOpenRecentDirectory,
      // ⭐ `design/0043` §2.6 / §2.7：收藏行的三条动作。
      // ⚠️ 三条**都不在这个文件里判可达性**——移除/上移/下移只改配置，
      //    打开那一条的授权全在 `open_favorite`（`INV-FAV-03`）。
      onOpenFavorite: onOpenFavorite,
      onUnfavorite: function (path) {
        return S.removeFavorite(path).then(function () { repaintStart(); });
      },
      onMoveFavorite: function (path, delta) {
        return S.moveFavorite(path, delta).then(function () { repaintStart(); });
      },
      // ⭐ `design/0045`（隐私）：最近目录那一段的两条"忘掉记录"。
      // ⚠️ 两条都**只**改 `config.json` 里的 `dir_sessions` / `last_directory`——
      //    磁盘上的目录与授权都不动（`INV-REC-01`）。
      onForgetRecent: forgetRecentFromUi,
      onClearRecent: clearRecentFromUi,
      onError: function (e, target) {
        // ⭐ `INV-START-07`：打不开必须**可见**——行被 `StartScreen` 标成 `data-missing`，
        //    状态条这一句是另一半（用户不一定看得见行变灰，尤其只有一行时）。
        // ⚠️ 收藏行与最近目录行**分开说话**：`open_favorite` 的失败是"这条收藏现在够不着"，
        //    不是"这个最近目录没了"——同一句话会把两种成因混成一种。
        const isFav = typeof target === 'string' && S.isFavorite(target);
        setStatusT(isFav ? 'status.favorite-open-failed' : 'status.recent-not-found', { dir: target }, true);
        // ⚠️ 诊断出口走 stderr（`design/0025` §2.2）：那句话随语言漂移，日志不漂。
        console.error(isFav ? '打开收藏失败：' : '打开最近目录失败：', target, e);
      },
      // ⚠️ 传**函数**而不是布尔值（注释在上面 `overlayOpen` 那一步）；实现只有一份。
      overlayOpen: overlayOpen,
    });

    // —— 0. 主题与阅读设置（`design/0004` / `design/0005`）——
    // ⚠️ 它排在**最前面**：窗口的注入脚本已经把 `data-theme` 写上了
    // （那是"无白屏帧"的关键，见 `src-tauri/src/gui/mod.rs` 的 `init_script`），
    // 这里建的服务负责**后续**每一次切换。
    // ⚠️ 真正的权威值要等 `S.refresh()` 回来才灌进去（`theme.reset`），
    //    那一步会连同夹取一起做掉。
    theme = Th.createThemeService({
      // ⚠️ 这个参数**不是**内存里那条记录（camelCase），而是 `theme.js::toPayload`
      //    翻好的**线上形状**（snake_case 的五个键）——⚠️⛔ 别"顺手"改成 `applied`：
      //    后端 `config::Appearance` 认的是 snake_case，而 serde 对不认识的键**静默忽略**
      //    ⇒ 那会让外观变成"存进去了、值是出厂值"（`docs/bugs/0007`）。
      save: function (payload) { return T.call('set_appearance', { appearance: payload }); },
    });
    themeSwitcher = ThSw.createThemeSwitcher({
      els: {
        themeSelect: $('theme-select'),
        fsDec: $('fs-dec'),
        fsInc: $('fs-inc'),
        fsVal: $('fs-val'),
        lhSelect: $('lh-select'),
        cwSelect: $('cw-select'),
        saveWarn: $('save-warn'),
      },
      theme: theme,
    });
    theme.attachSystemListener();
    themeSwitcher.sync();

    // —— 1. 建 UI 骨架 ——
    // ⭐ 「立即重载」按钮（`design/0006` §2.1 ④ 的降级出路）。
    //    ⚠️ 它走的是**同一条** `reloadCurrentDocument`（⛔ 不许另写一条"手动重载"的路：
    //    两条路迟早会漂，而其中一条还没有阅读位置恢复）。
    const reloadNow = $('reload-now');
    if (reloadNow) {
      reloadNow.addEventListener('click', function () { reloadCurrentDocument('reload.reason.manual'); });
    }
    // ⭐ `design/0050` 最终约束 5：健康提示上的「重新监视」——它与手动刷新**不是**同一件事。
    //    ⚠️ 先让后端重接管道，再让树重列一次（重接之后才可能有新事件，顺序反过来会白列一趟）。
    //    ⚠️ 失败**照实报**（`INV-DISK-06`：监视的状态不许静默）——回包里新的 `reason` 会把
    //    `#disk-bar` 重画成"仍然坏着"，⛔ 不要在这里自己猜一句"重试失败"。
    const diskRetry = $('disk-retry');
    if (diskRetry) {
      diskRetry.addEventListener('click', function () {
        DE.retryWatch(T).catch(function (e) {
          console.error('⛔ 重新监视失败：', e);
        }).then(function () {
          if (tree) tree.noteTreeChanged();
        });
      });
    }
    tree = FileTree.createFileTree({
      // ⚠️⚠️ `design/0044` §2.4：**只画 `#tree-host`**，⛔ 不是 `#pane-tree`。
      //    根头与树是同一个静态壳里的兄弟节点；树那侧会 `textContent=''` 重画、
      //    还会把新建输入行插到 `host.firstChild` 之前——共用一个容器就会
      //    删掉根头 / 把输入行顶到根头上面。
      host: $('tree-host'),
      // ⭐ `design/0043` §2.5：树行的「收藏 / 取消收藏」。
      //    ⚠️ 判据与动作都由会话那侧给（`S.isFavorite` / `toggleFavoriteFromUi`），
      //    ⛔ `FileTree` 不认识收藏表本身（那是第二份真值）。
      isFavorite: function (path) { return S.isFavorite(path); },
      onToggleFavorite: toggleFavoriteFromUi,
      onOpenFile: function (path) {
        openDocument(path).then(function (p) { if (p) renderSidebar(); });
      },
      onError: function (e) { console.warn('树读取出错：', e); },
      // ⭐ `design/0020`：树**真的变了**（用户展开/折叠之后）⇒ 写者记一笔，
      //    500 ms 去抖后落盘。⚠️ 恢复过程不来这里（`FileTree` 用 `restoring` 抑制）。
      onStateChange: function () {
        if (dirWriter) dirWriter.noteTreeChange();
      },
      // ⭐ `design/0020`：用户**亲手**动了树 ⇒ 恢复事务从此不再替他打开上次的文件
      //    （§2.3 ③ 的 `browsing`）。⛔ 与上一条不是一回事：这条不写盘。
      onUserToggle: function () {
        if (dirRestorer) dirRestorer.noteUserToggle();
      },
      // ⭐ `design/0035` §3.1：改名入口的置灰依据是"**编辑器挂着**"（干净也算），
      //    ⛔ 不是"有未保存改动"。⚠️ 它只是提前告知——后端 `rename_guard` 会独立拒。
      getEditorState: function () { return { editing: editing }; },
      // ⭐ `design/0041` §2.2：空目录过滤的**唯一**判据入口（R1 的三态收在 `doclists.js`）。
      //    ⚠️ `keepDirs === null`（清单还没到 / 刚换根）⇒ 原样返回，与今天的行为逐字一致。
      //    ⛔ 过滤只决定"这一层画哪些"，不碰 `failed` / `layerEpoch`（`FileTree` 的注释）。
      filterEntries: function (entries) {
        return DL.visibleEntries(entries, keepDirs, recentCreated, S.state.hideEmptyDirs);
      },
      // ⭐ `design/0041` R4：新建**空目录**的临时例外——刚建的目录里必然还没有 md，
      //    不记这一笔，父层一重列它就被过滤掉了（用户会以为新建失败）。
      //    ⚠️ `FileTree` 保证这发生在父层重列**之前**；⛔ 别把记账挪到 `afterCreate` 之后。
      onCreated: function (path) { recentCreated.add(path); },
      // ⭐ `design/0050` 最终约束 5：右键「刷新」的**跨 IPC 入口**。
      //    ⚠️ 它必须走 `reconcile_disk`（后端真的去核一遍盘）而不是本地重列一版——
      //    本地重列拿到的还是后端缓存里那份，树"刷过了"但盘上的改动看不见。
      //    ⚠️ 回包里 `epoch` 前进会同步推前端内容修订（在途结果作废），
      //    随后 `FileTree` 自己那一趟重列读到的就是新的起点。
      onManualRefresh: function () { return DE.refresh(T); },
    });

    // ⭐ 两个协调器：依赖**全部注入**（`getState` / `root` / `tree` / IPC），
    //    ⇒ 时序能在 `tests/js/dirsession.test.js` 里逐帧控制（评审 R3/R5 的落点）。
    dirRestorer = D.createRestorer({
      getState: function () { return S.state; },
      tree: tree,
      openDocument: function (path, opts) { return openDocument(path, opts); },
    });
    dirWriter = D.createWriter({
      getState: function () { return S.state; },
      tree: tree,
      setDirSession: function (root, generation, lastFile, expanded) {
        return S.setDirSession(root, generation, lastFile, expanded);
      },
    });
    sidebar = Sidebar.createSidebar({
      els: {
        sidebar: $('sidebar'),
        paneTree: $('pane-tree'),
        // ⭐ `design/0044` §2.4：根头与树**两个 host**（静态壳见 `index.html`）。
        treeHost: $('tree-host'),
        treeRootHeader: $('tree-root-header'),
        treeRootName: document.querySelector('#tree-root-header .tree-root-name'),
        treeRootIcon: document.querySelector('#tree-root-header .node-icon'),
        treeRootMore: $('tree-root-more'),
        // ⭐ `design/0041` §2.3：文件页的两种形态各占一个**互斥但不卸载**的面板
        paneDoclist: $('pane-doclist'),
        paneToc: $('pane-toc'),
        // ⭐ `design/0042`：底部常驻搜索的**结果层**与输入框那一行（可见性由 `applyPanes` 统一算）
        paneSearch: $('pane-search'),
        searchBar: $('sidebar-search'),
        tabTree: $('tab-tree'),
        tabToc: $('tab-toc'),
        // ⭐ `design/0041` §2.3：形态切换按钮（文案表示"点下去会切成什么"）
        btnFileView: $('btn-file-view'),
        collapseBtn: $('btn-collapse'),
        expandBtn: $('btn-expand'),
        resizer: $('sidebar-resizer'),
      },
      tree: tree,
      onChooseDirectory: onChooseDirectory,
      // ⭐ `design/0041` §2.3：形态切换的**消费点**在这里——写盘（`setSidebarFileView`）
      //    与列表加载都在这一侧，⛔ `Sidebar` 不认识 IPC。
      onToggleFileView: toggleFileView,
      /**
       * ⭐ `design/0041` R5：切回**文件**页时消费欠下的那次刷新。
       *
       * ⚠️ 树不可见期间（去了大纲页）不重建树：用户可能正翻在很深的位置，
       *    而无人在看。这里补一次即可，⛔ 不是"每次变更都刷一遍"。
       */
      onTabChange: function (name) {
        if (!sidebar) return;
        // ⚠️ 启动时 `setTab('tree')` 早于第 3 步的 `renderSidebar`：那一刻既没有清单
        //    也没有 root，什么都没欠 ⇒ 直接返回（⛔ 别在启动路径上多发一个 `list_documents`）。
        if (!docList && !lastRoot) return;
        // 列表形态的"可见"还包含"这一页在不在前"：不在前就停分片、清 DOM，
        // 切回来由 `setActive(true)` 用**同一份**清单补画（⛔ 不重拉）。
        if (docList) docList.setActive(effectiveFileView() === 'list' && sidebar.isFilesVisible());
        if (name !== 'tree') return;
        if (treeFilterStale) {
          treeFilterStale = false;
          if (S.state.hideEmptyDirs && tree) tree.refreshVisible();
        }
        // 换根 / 盘上变了欠下的那次拉取，也在这里补。
        if (docListDirty) {
          applySidebarView(false).catch(function (e) { console.error('文档列表加载失败：', e); });
        }
      },
      // ⭐ `design/0038` §2.1 ⑤：「上次的目录」那个按钮走**授权命令**，⛔ 不再弹面板。
      //    接线只有这一处；不接的话 `Sidebar` 会退回老行为（弹面板），⛔ 不会静默失效。
      onOpenLastDirectory: onOpenRecentDirectory,
      /**
       * ⭐ `design/0044` §2.2：根头的菜单（`⋯` / 右键 / `Shift+F10`）。
       * ⚠️ 动作清单只在 `FileTree::openRootMenu` 写一份——这里只转发坐标与
       *   "把焦点还回根头"那个回调（`Sidebar` 自己知道根头是哪个节点）。
       */
      onRootMenu: function (at) {
        if (!tree) return;
        tree.openRootMenu(at.x, at.y, { returnFocus: at.returnFocus });
      },
      // ⭐ 侧边栏那句"也可以按 … 打开一份文档"**由这里给**（`INV-SET-01`）——
      //    它在后端那张表到手之前就建好了，所以传**函数**、⛔ 不传当时的值。
      keyText: accelText,
    });

    // —— 1.5 快捷键与设置覆盖层（`design/0010`）——
    // ⭐ **唯一的键位事实来源在后端**（`INV-SET-01`）：
    //    前端⛔ 不写任何按键字面量，只拿这张表去建匹配器。
    //    ⚠️ 这一段必须排在 `sidebar` 之后——`view.toggle-sidebar` 的 handler 要它。
    await setupKeys();
    // ⭐ 表到手了 ⇒ 补一次「收起 / 展开」两个图标的 tooltip（标签 + 键位）。
    //    ⚠️ 必须排在 `setupKeys()` **之后**：`Sidebar` 建得比它早，那一刻 `accelText` 还是空串。
    //    ⚠️ 之后每次换语言由 `relabelDynamic()` 负责重拼（`setLang` 的订阅者那一档）。
    syncSidebarKeyHints();

    // —— 1.55 顶栏折叠（`design/0037`）——
    // ⚠️ 同样必须排在 `setupKeys()` 之后：两个控件的 tooltip 要现取键位。
    setupChrome();

    // —— 1.6 编辑面（`design/0012`）——
    // ⭐ **必须排在 `setupKeys()` 之后**：它要跑那道自证，而自证第 ③ 项判的正是
    //    `setupKeys` 里派生出来的 `forwardCheck.specs`（⛔ 不是这里再算一遍）。
    //    ⚠️ 它只**接线**（按钮 / 分隔条 / 自证），⛔ **不进编辑态**、⛔ 不碰任何文件：
    //       进编辑态是用户按「编辑」或某个键之后的事。
    setupEdit();

    // —— 1.6b 阅读—编辑连续性（`design/0047`）——
    // ⚠️⚠️ **不在这里**：它的开关来自快照（`config.live_edit`），而快照在第 2 步才回来。
    //    在这里调会读到默认值 `false` ⇒ **整条能力永远不接线，而且没有任何报错**
    //    （表现是"点了正文没反应"，与"开关关着"逐字相同）。接线点在第 2 步之后。

    // —— 1.7 阅读进度（`design/0017`）——
    // ⭐ 只**接线**：滚动/可见性/卸载/user-abort 那几族监听。
    //    ⚠️ 必须排在 `S.refresh()` 之前——启动那份文档的恢复要读快照里的
    //    `reading_progress`，而监听先挂上没有副作用（`currentPath` 还是 null 时全部早退）。
    setupReadingProgress();

    // —— 2. 问后端"现在是什么状态" ——
    // ⚠️ 重试几次：`AppState` 是在 Tauri 的 `setup()` 里托管的，
    //    而 WebView 的脚本有可能在那一行之前就跑起来（两者都在主线程上排队，
    //    常见情形下顺序是对的，但"常见"不是"保证"）。
    let snap = null;
    for (let i = 0; i < 5 && !snap; i++) {
      try {
        snap = await S.refresh();
      } catch (e) {
        if (i === 4) {
          setStatusT('status.session-failed', { msg: e.wording || e.message }, true);
          return;
        }
        await new Promise(function (r) { setTimeout(r, 50); });
      }
    }
    sidebar.applyWidth(snap.sidebar_width);
    // ⭐ **权威外观值**（`INV-THEME-03`：配置文件是唯一真源）。
    // 注入脚本与这里用的是同一份数据，但**写入点只有一个**：
    // 那次注入是"让首帧好看"，这里是"承认后端说了算"——
    // 后端会把越界值夹回来，所以两者不一致时以这里为准。
    theme.reset(snap.appearance);
    themeSwitcher.sync();

    // ⭐ `design/0025` §2.4：**语言**的权威值也只认快照（注入脚本那份只负责首帧）。
    //    ⚠️ 它排在 `setupKeys` 之后 —— 设置覆盖层与快捷键表都已经建好，
    //    这里一换语言，`applyDom` 与订阅者会把 JS 建的节点一起重贴（`§2.5.1` ③）。
    applySnapshotLanguage(snap);

    // —— 2.5 ⭐ 阅读—编辑连续性（`design/0047`）——
    // ⚠️ **必须在这里**，两个理由都是硬要求：
    //   ① 开关（`config.live_edit`）**来自刚回来这份快照**——早一步就是默认值 `false`，
    //      于是整条能力静默不接线（表现与"开关关着"逐字相同，⛔ 没有任何报错）；
    //   ② 必须排在**打开启动文档之前**（第 4 步）：`mountDocument` 会调 `noteLive`，
    //      而那时如果没有控制器，第一份文档就没有块表对齐结果
    //      （⇒ 用户点第一下时 `slotIndexFromNode` 恒 `null`，"点了没反应"）。
    // ⚠️ 它只**接线**（一个文档级 `mousedown` ＋ 一个控制器），⛔ 不进编辑态、⛔ 不碰文件。
    setupLive();

    // —— 3. 按打开的是什么决定侧边栏长什么样（§2.1 的那张表）——
    // ⚠️ 空会话与目录模式都先看**树**那个 tab：它们的界面就是"怎么开始"
    //    （目录模式 = 树；空会话 = 打开入口 + 上次目录）。只有单文件模式先看大纲。
    sidebar.setTab(snap.mode === 'single-file' ? 'toc' : 'tree');
    await renderSidebar();

    // —— 4. 打开启动参数里的那份文档（若有）——
    if (snap.startup_document && snap.mode === 'single-file') {
      await openDocument(snap.startup_document);
      // ⚠️ 打开之后再刷一次：`open_document` 可能触发第 ③ 步（收回旧 root）
      await renderSidebar();
      sidebar.setTab('toc');
    } else if (snap.mode === 'directory') {
      showDocEmptyT('doc.empty-choose');
      setDirectoryStatus();
    } else {
      // ⭐ 空会话（`rmd` 裸跑）
      showDocEmptyFn(openHint);
      setStatusFn(readyHint, false);
    }

    // —— 4.5 ⭐ 取走启动期间到达的 Apple Event 打开请求（`design/0015` §2.1 ④）——
    // ⚠️ **必须主动取一次**：冷启动时 macOS 可能先把 `odoc` 投给进程，
    //    而那时的 WebView 还没有注册监听 ⇒ 唤醒信号已经丢了，队列还在。
    // ⚠️ 放在启动文档之后：`open -a rmd.app 某.md` 走的是 Apple Event **不是** argv，
    //    所以正常冷启动时 `startup_document` 是空的，这一步就是"打开那一份"。
    await queueDrainPendingOpens();

    // —— 5. 快捷键 ——
    // ⛔ **原来这里有一段手写的 `Cmd+O` / `Cmd+Shift+O` 的 `keydown`，`design/0010` 起已删除。**
    //    它现在由 `keymap.js` 按后端那张表统一分发（见上面第 1.5 步），
    //    那两个动作的所有权**没有变**（仍是 `owner = Web`，`INV-SET-04`）——
    //    变的只是"谁在监听"，而它顺带补上了原来缺的两道保护：
    //    组合态（`INV-SET-05`）与可编辑焦点。

    // —— 6. 会话变化（授权被收回 / 切根）→ 重刷侧边栏 ——
    // ⚠️ 顺带刷提示条：`applySnapshot` 会在代次变化时把 `watchNote` 写成
    //    「文件监视已停止（授权已改变）」（`INV-EXT-09` 的**可见**那一半），
    //    而那条消息只有在这里才上得了屏。
    S.onChange(function () { renderSidebar(); syncReloadBar(); });

    // —— 7. 回报 ——
    // ⭐ 批 2：`RMD_MEASURE=1` 时走**测量回报**（`report_measure`），后端收到就退出。
    //    ⚠️ 两条路径**互斥**：测的时候不报冒烟，报冒烟时不测——
    //       否则 `report_status` 里那些查询会给被测时间线添噪声。
    if (MEASURE) { await reportMeasure(doc); return; }
    if (measure) measure.stop();
    await report(doc);
  }

  /**
   * 批次 0 留的尾巴：**Tauri 自己的** WKWebView 能观测什么。
   *
   * 批次 0 探的是裸 `WKWebView`（`tools/wkwebview-probe/`），量出本机恰好 8 个
   * `supportedEntryTypes`、**没有 `longtask`**（`docs/kb/0003`）。
   * ⚠️ Tauri 会往 WebView 注入自己的脚本，**它那个是不是同一套能力，源码读不出来**——
   * 只能在这里问一次。
   *
   * ⛔ **只读、不测任何时刻**：`supportedEntryTypes` 是个静态属性，
   * 问它不会改变文档状态，也就不污染批 2 要采的时间线。
   */
  function supportedEntryTypes() {
    // ⚠️ 转调 `measure.js` 那一份——**只留一个实现**。原来这里手写了一遍
    //    `window.PerformanceObserver && PerformanceObserver.supportedEntryTypes`，
    //    守卫与取值来自**两个不同的对象**，在任何另有全局 `PerformanceObserver`
    //    的环境里会读错（Node 就有）。浏览器里两者恰好相同，所以这个错**永远不报**。
    if (M) return M.probeEntryTypes();
    return [];
  }

  /** 读一个 CSS 自定义属性在 `documentElement` 上的**生效值**。
      ⚠️ 走 `getComputedStyle` 而不是读 `style.getPropertyValue`：
      后者只看得见**行内**写的那一份，看不见 `tokens.css` 的默认值——
      而"到底生效了哪个"才是这里要问的。 */
  function cssVar(name) {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (e) {
      return '';
    }
  }

  /**
   * 用 rAF 等 `n` 帧。⛔ **不要**用 `setTimeout(0)` 代替——那**不保证**发生过绘制。
   */
  function nextFrames(n) {
    return new Promise(function (resolve) {
      let left = n;
      (function tick() {
        if (left-- <= 0) return void resolve();
        requestAnimationFrame(tick);
      })();
    });
  }

  /**
   * ⭐ **批次 2 的「滚动那半」**（`design/0002` §10.5.3）。
   *
   * 问的是：**「打开时已经付过的那一次布局（`T5b`），滚动到文档底部要不要再付一次」**。
   * ⚠️ 这不是好奇心：`adr/0004` 的**分块渲染**要成立，必须能省掉某一部分**每次都要付**的钱。
   * 若滚动**不再**付布局价，那"少建节点"能省的只有那一次性的 `T5b`，而 `T5b` 又是**已付过**的。
   *
   * ⚠️ **滚动容器⛔ 不是 `#doc`**——`style.css` 的 `html, body { height:100%; overflow-y:auto }`
   * 才是"能滚"的原因。拿 `$('doc').scrollTop` 去量会**永远得到 0**。
   *
   * ⚠️⚠️ **2026-10-14 实测更正（原地改并留痕）**：本节原写「滚动容器是
   * `document.scrollingElement`（`html`）」——**那是错的，而且正是我踩的那一脚**。
   * 实测第一次跑出来的 `scroll_height` 对 **0.1 MB 和 10 MB（148 万节点）是同一个 769**
   * ——那就是**视口高度**，说明 `html` 的高度**恰好等于视口**（`scrollHeight == clientHeight`），
   * 真正在滚的是 **`body`**。`window.scrollTo()` 滚的是 `html` ⇒ **一次都没滚**，
   * 而 `t5c/t5d` 会安静地报 0 —— 一份**看起来漂亮的、其实是空的**测量。
   * ⇒ 改成**运行时挑真正溢出的那个**（`pickScroller()`），并把「到底滚了多少」
   * 一起报上去自证（`scroll_top` / `client_height`）：**为 0 就不能拿它做结论**。
   * ⚠️ 冒烟路径（本文件上面报 `scroll_height` 那处）早就在用
   * `max(html.scrollHeight, body.scrollHeight)`「谁大听谁的」——同一个道理，只是没写明。
   *
   * ⚠️ **三个数的口径各不相同，⛔ 不能混着读、更不能相加**：
   *  · `t5c_ms` —— **同步**：跳到最底 + 读 `getBoundingClientRect()`（强制布局）。
   *  · `t5d_ms` —— **同步**：再「回顶 → 再跳到底」一遍 + 强制布局。⭐ 它是**对照组**：
   *    若 `t5c` 明显大于 `t5d`，说明**第一次滚到底要补做一次布局**（第二次不必）；
   *    两者都 ≈ 0 ⇒ 布局在 `T5b` 那一次就**做完了**。
   *  · `t5e_ms` —— ⚠️ **异步**：从"跳到底"到**后面那一帧**的回调。它**不在 §7.3 的同步口径里**
   *    （含绘制/合成，且被帧率量化到 ≈16.7 ms 一档）⇒ 只能读成「**一帧内画完没有**」，
   *    ⛔ 不与上面两个同步数相加、⛔ 不许当成"滚动耗时"。
   *
   * @returns {Promise<{t5c_ms:number, t5d_ms:number, t5e_ms:(number|null),
   *   scroll_height:number, client_height:number, scroll_top:number, scroll_el:string}>}
   */
  async function measureScroll(doc) {
    const empty = {
      t5c_ms: 0, t5d_ms: 0, t5e_ms: null,
      scroll_height: 0, client_height: 0, scroll_top: 0, scroll_el: '',
    };
    // ⛔ 只在测量模式下动作——产品路径上**一行都不跑**（`RMD_MEASURE` 才置 `MEASURE`）。
    const sc = measure ? pickScroller() : null;
    if (!sc) return empty;
    const bottom = sc.scrollHeight - sc.clientHeight;
    // ⚠️ 没有可滚的东西（空文档 / 一屏装得下）⇒ 报 0 而**不是**拿当前位置充数。
    if (bottom <= 0) return empty;

    /** 读一个**必然触发布局**的量。⚠️ `scrollHeight` 不够——它有缓存。 */
    const force = function () { return doc.getBoundingClientRect().top; };
    /** 跳转 + 回读。⚠️ 回读的 `scrollTop` 就是**这一跳到底有没有发生**的自证。 */
    const jump = function (y) { sc.scrollTop = y; return sc.scrollTop; };

    let moved = 0;
    const t5c = measure.span(function () {
      moved = jump(bottom);
      return force();
    });
    const t5d = measure.span(function () {
      jump(0);
      force();
      jump(bottom);
      return force();
    });

    // ⚠️ rAF 回调在**绘制之前**跑；再等一帧才是"这一帧画完了"的近似。
    const t5e = await new Promise(function (resolve) {
      const a = measure.now();
      jump(bottom);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { resolve(measure.now() - a); });
      });
    });

    return {
      t5c_ms: t5c.ms,
      t5d_ms: t5d.ms,
      t5e_ms: t5e,
      scroll_height: sc.scrollHeight,
      client_height: sc.clientHeight,
      scroll_top: moved,
      scroll_el: String(sc.tagName || '').toLowerCase(),
    };
  }

  /**
   * ⭐ **真正在滚的那个元素**（`2026-10-14` 实测踩坑后补）。
   *
   * ⛔ `document.scrollingElement` **不能直接用**：它返回 `html`，而本项目的
   * `html, body { height:100%; overflow-y:auto }` 让 `html` 的高度**恰好等于视口**
   * ⇒ `html` 从不溢出、从不滚动，真正滚的是 **`body`**。
   * 判定与冒烟路径同一套口径：**谁溢出的多谁就是容器**（那里写作
   * `max(html.scrollHeight, body.scrollHeight)`）。
   *
   * @returns {Element|null} 没有可滚的东西时返回 `null`（⛔ 不是回落到 `html`）。
   */
  function pickScroller() {
    const cands = [document.scrollingElement, document.documentElement, document.body];
    let best = null;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (!c) continue;
      const over = c.scrollHeight - c.clientHeight;
      if (over > 0 && (!best || over > best.over)) best = { el: c, over: over };
    }
    return best ? best.el : null;
  }

  /** 子树里的**全部**节点数（含文本节点）。⚠️ 只在绘制时刻之后调——
      它是一次全树遍历。 */
  function countNodes(root) {
    try {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_ALL, null);
      let n = 0;
      while (w.nextNode()) n++;
      return n;
    } catch (e) {
      return -1;
    }
  }

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : 0; }

  /**
   * ⭐ **批次 2 的测量回报**（`design/0002` §7.3.2）。
   *
   * ⚠️ 三处口径必须逐字遵守，否则数字不可比：
   * ① **`r_ms` 是推导值**——`T4 − (T1+T2+T3)`，代表"序列化 + IPC 往返 + 反序列化"；
   *    ⛔ 它与任何一段都**不可加**（§7.3.2 明写禁"T4 = GUI 总时长 − CLI 总时长"这类算式）。
   * ② **Rust 的三个数与前端的时间戳不同纪元**——只作为**时长**参与那条减法，
   *    ⛔ 绝不与前端时间戳混进同一个变量。
   * ③ **T6/T6b 必须扣掉启动地板**（`research/notes/0007`：约 0.5 s 的固定地板，
   *    连 117 B 的文档都一样）⇒ 这里报的是**从 `rmd:boot` 这个 mark 起**的相对值，
   *    ⛔ 不是 `performance.timeOrigin` 起的绝对值。分析时**再**扣一次地板。
   */
  async function reportMeasure(doc) {
    // 等两帧：`T5/T5b` 之后**至少要有一次绘制**发生，T6/T6b 才有条目可读。
    // ⚠️ 这两帧**不属于任何一段被测耗时**（§7.3.2 里没有它们的位置）。
    await nextFrames(2);
    // ⚠️ LCP 在"用户交互 / 页面隐藏"之前会持续更新。再给一段静默期，
    //    让大文档那块有机会算进最终值。⛔ 同样不计入 T4–T6b。
    await new Promise(function (r) { setTimeout(r, 250); });

    const paints = measure ? measure.paints() : { fcp_ms: null, lcp_ms: null };
    // ⚠️ **必须在 `paints()` 之后**：滚动会改变可见内容、可能再派发 LCP 条目，
    //    先滚的话读到的就不是"打开时的那一帧"了。
    const scroll = await measureScroll(doc);
    const p = (window.__rmd && window.__rmd.payload) || {};
    const o = lastOpen || {};
    const supported = supportedEntryTypes();

    const sample = {
      file: p.real_path || '',
      source_bytes: num(p.source_bytes),
      html_bytes: num(p.html_bytes),
      ast_nodes: num(p.ast_nodes),
      toc_entries: num(p.toc_entries),
      had_bom: !!p.had_bom,

      // —— 后端口径（Rust `Instant`，⛔ 只当"时长"用）——
      t1_ms: num(p.t1_ms), t2_ms: num(p.t2_ms), t3_ms: num(p.t3_ms),
      // —— 前端口径（WebView 时间轴）——
      t4_ms: num(o.t4_ms), t5_ms: num(o.t5_ms), t5b_ms: num(o.t5b_ms),
      // ⭐ 残差 `R`（推导值）：序列化 + IPC 往返 + 反序列化
      r_ms: M ? M.round(num(o.t4_ms) - (num(p.t1_ms) + num(p.t2_ms) + num(p.t3_ms))) : null,
      // —— 绘制（相对 `rmd:boot` 那个 mark，⛔ 不是 timeOrigin）——
      t6_fcp_ms: paints.fcp_ms,
      t6b_lcp_ms: paints.lcp_ms,

      // ⭐ **滚动那半**（§10.5.3）。⚠️ 三个数的口径**各不相同**，⛔ 不许相加：
      //    `t5c`/`t5d` 是**同步**分段（跳到底 / 回顶再到底），`t5e` 是**异步**（到下一帧）。
      //    ⚠️ 它们**不在 §7.3.2 的六个量里**——是批 2 收尾时补的第七个问题，
      //    所以**只与同一份结果文件里的数比**，⛔ 不与 2026-10-14 那份 `-gui.json` 混读。
      t5c_ms: num(scroll.t5c_ms),
      t5d_ms: num(scroll.t5d_ms),
      t5e_ms: (scroll.t5e_ms === null || scroll.t5e_ms === undefined)
        ? null : num(scroll.t5e_ms),
      scroll_height: num(scroll.scroll_height),
      // ⚠️ 这两个是**这次滚动到底发生了没有的自证**（`2026-10-14` 踩坑后补）：
      //    `scroll_top` 必须 ≈ `scroll_height − client_height`。⛔ **为 0 就说明没滚成**
      //    （第一版正是这样：滚的是 `html`，而真正在滚的是 `body`），那时
      //    `t5c`/`t5d` 那两个 0 **不是结论、是空测量**。`scroll_el` 是实际选中的容器。
      client_height: num(scroll.client_height),
      scroll_top: num(scroll.scroll_top),
      scroll_el: scroll.scroll_el || '',

      // ⭐ **前端时钟的分辨率**（ms）。⚠️ 它解释上面那几个数怎么读：
      //    WebKit 把高精度时钟**粗化**过 ⇒ `t5_ms = 0` 的含义是"**不到一个刻度**"，
      //    ⛔ 不是"零成本"。实测本机 T4/T5/T5b/FCP/LCP **全是整数**，
      //    而 t1/t2/t3（Rust 侧）带小数 —— 那个差别就是这个粗化。
      //    ⚠️ 这次忙等**发生在所有被测分段之后**，⛔ 不污染任何一段。
      clock_ms: M ? M.clockResolutionMs() : null,

      // ⭐ DOM 规模。**指标换过一次**（`design/0002` §10.3）：`childElementCount`
      //    只数**直接子元素**（`XL-tables` 量出 18 548，而 AST 是 860 837）——
      //    那不是 §7.2 第 9 条要的"DOM 节点数"。这里报**两个**：
      //    `doc_elements`（元素，`querySelectorAll('*')`）与 `doc_nodes_total`
      //    （含文本节点的全树遍历）。
      doc_elements: doc.querySelectorAll('*').length,
      doc_nodes_total: countNodes(doc),

      entry_types: supported,
      watching: measure ? measure.watching : null,
      theme: document.documentElement.dataset.theme || '',
      reader_font_size: parseFloat(cssVar('--reader-font-size')) || 0,
      user_agent: navigator.userAgent,
    };

    try {
      await T.call('report_measure', { sample: sample });
    } catch (e) {
      console.warn('report_measure 失败：', e);
    }
  }

  /**
   * 回报给后端（`src-tauri/src/gui/mod.rs` 的 `FrontendReport`）。
   *
   * ⚠️ 这是**测试脚手架**，不是产品功能。没有它，验收（"能显示、能滚动"、
   * "树真的建出来了"）在 Agent 这边**无从核实**——那是个 GUI 窗口，
   * 看不到内容就等于只验了"进程没崩"。
   *
   * ⚠️ 回报的必须是**前端自己测出来的事实**（DOM 子元素数、滚动高度、树里几个节点），
   * ⛔ 不是把后端的返回值转述一遍。
   *
   * ⭐ 2026-10-13 起多两项：**生效的主题名**与**生效的正文字号**。
   * 它们让"`0004`/`0005` 真的落地了"从"我看了一眼觉得对"变成一条机器判据。
   */
  async function report(doc) {
    const st = S.state;
    const text = doc.textContent || '';

    // ⭐ `design/0011` §3：**前端自己驱动一遍查找**再回报。
    //
    //   ⚠️ 为什么不让冒烟去按键：`tools/smoke-gui.sh` 跑在**没人看的窗口**里，
    //      它判不了"等一下点 ⌘F 再打字"。⇒ 判据必须由前端自己走完：
    //      开浮层 → 建索引 → 拿**第一段自己的文本**当关键词搜 → 核对命中区间
    //      读出来是不是那个词 → 再搜一个**一定搜不到**的哨兵 → 关掉清干净。
    //   ⭐ 探测词从正文里取（⛔ 不是常量表）：这一条在**任何**语料上都成立，
    //      而"每个语料配一个已知命中数"的表迟早会与语料漂开。
    //   ⚠️ 只判 `doc_loaded` 的那些用例——空会话/目录模式里没有正文可搜，
    //      那**不是**失败（后端 `pass` 那一侧也这么判）。
    if (findBar && st.currentDoc) {
      try {
        const r = await findBar.probe();
        // 判据是**两条一起**：探测词命中 ≥ 1 号且区间读出来等于那个词，
        // **并且**哨兵命中 = 0。⛔ 只验前一条会被"永远返回全部段"的实现骗过。
        const ok = r.hits >= 1 && r.text_ok && r.miss === 0;
        const note = ok ? '' : (r.note ||
          ('命中 ' + r.hits + ' / 区间核对=' + (r.text_ok ? '对' : '错') + ' / 哨兵 ' + r.miss));
        findCheck = { ok: ok, note: note, segs: r.seg, hits: r.hits, miss: r.miss };
      } catch (e) {
        findCheck = { ok: false, note: '自证抛错：' + String((e && e.message) || e), segs: 0, hits: -1, miss: -1 };
      }
    } else {
      findCheck = { ok: false, note: '没有已挂载的文档', segs: 0, hits: -1, miss: -1 };
    }

    const sidebarMode =
      (st.mode === 'directory' && st.roots.length > 0) ? 'directory'
        : (st.currentDoc ? 'single-file' : 'empty');
    const payload = {
      ok: true,
      summary: $('status').textContent,
      // ⚠️ 这里**故意仍报 `childElementCount`**，别当成"`design/0002` §10.3 那条没换干净"：
      //    它是「HTML 真的建出了节点没有」的**活性判据**（后端判 `> 0`），
      //    ⛔ 不是 §7.2 第 9 条要的那个**规模**指标。规模指标在 `reportMeasure()` 里
      //    （`doc_elements` / `doc_nodes_total` + AST 节点数）。两者用途不同，
      //    而且换它会动 `tools/smoke-gui.sh` 的解析口径。
      doc_children: doc.childElementCount,
      scroll_height: doc.scrollHeight,
      viewport_height: window.innerHeight,
      text_len: text.length,
      sample: text.replace(/\s+/g, ' ').trim().slice(0, 60),
      entry_types: supportedEntryTypes(),
      user_agent: navigator.userAgent,
      sidebar_mode: sidebarMode,
      doc_loaded: !!st.currentDoc,
      tree_nodes: tree ? tree.nodeCount() : 0,
      tree_ignored: tree ? tree.ignoredCount() : 0,
      tree_current: tree ? tree.currentCount() : 0,
      unauthorized_explicit: !!document.querySelector('#pane-tree .unauth[data-unauthorized]'),
      // ⚠️ 判据是**那个钩子**而不是"有没有那条文字"：文案会改，钩子不该改
      last_dir_offer: !!document.querySelector('#pane-tree [data-last-dir-offer]'),
      theme: document.documentElement.dataset.theme || '',
      reader_font_size: parseFloat(cssVar('--reader-font-size')) || 0,
      // ⭐ `design/0010` §7 步骤 12 的判据。
      //    ⚠️ `shortcuts` 是**前端从 `get_shortcuts` 收到**的条数
      //    （后端拿它跟自己的表长比，见 `gui/mod.rs` 的 `shortcut_ok`），
      //    所以它同时证明了"IPC 往返通了"——ACL 少一条时这里会是 0，
      //    而窗口其余部分**一切正常**（那正是它值得当判据的原因）。
      shortcuts: shortcutTable.length,
      actions_ok: !!actionsCheck.ok,
      actions_note: String(actionsCheck.note || ''),
      // ⭐ 菜单事件通道（§2.1 ⑧）。⚠️ 它只走 `core:event:allow-listen` 那一条权限——
      //    失败时的现象是"**菜单点下去没反应**"，页面上看不出任何异样。
      listen_ok: !!listenCheck.ok,
      listen_note: String(listenCheck.note || ''),
      // ⭐ 文件监视（`design/0006` §7）。⚠️ 与后端的那个 `seq` 对不上就是缺陷
      //    （后端建了、前端认不下 ⇒ 事件到了也认不出来），所以两个数都要报。
      watch_seq: st.watchSeq,
      // ⚠️ **丢弃计数**：静默丢弃与"自动刷新坏了"在界面上长得一样。
      watch_dropped: st.watchDropped,
      // ⭐ `INV-EXT-04`：降级必须**说出来**——这里把两种"不工作"的原因**合成一个字段**
      //    （文件监视建不起来 / 事件通道没订上），因为对 `report_status` 这一侧来说
      //    它们是同一件事：**为什么自动刷新不工作**。
      //    ⚠️ 分开的两份说明都在前端各自的位置上（`session.watchNote` 与这里的
      //    `watchListenNote`），合并只发生在**回报**这一步。
      watch_note: String(st.watchNote || watchListenNote || ''),
      // ⭐ `design/0011` §3：正文内查找的**前端自证**（跑法见上面那一段的注释）。
      //    ⚠️ `find_hits` = -1 表示**这一轮没跑**（没有已挂载的文档）——
      //    ⇒ 后端的 `pass` 只在 `doc_loaded` 时才要求它，⛔ 别把"没跑"读成 0 处命中。
      find_ok: !!findCheck.ok,
      find_note: String(findCheck.note || ''),
      find_segments: findCheck.segs || 0,
      find_hits: (typeof findCheck.hits === 'number') ? findCheck.hits : -1,
      find_miss: (typeof findCheck.miss === 'number') ? findCheck.miss : -1,
      // ⭐ `design/0012` §3.2④：编辑面的**前端自证**（六个字段，全 `#[serde(default)]`，
      //    也就是说这几个在**旧前端**上缺着时后端照样收得下）。
      //    ⚠️ 判据与"跑法"在 `editor/main.js::selfTest` 里，这里只转述结果——
      //       `edit_ok` 的三个子项（bundle 在 / 文本往返相等 / 转发白名单含 `Mod-s`）
      //       **任何一项**没过它都是 false，而 `note` 里写着是哪一项。
      //    ⚠️ 它**不依赖有没有打开文档**（自证用临时容器），所以空会话里也该是 true。
      edit_ok: !!editSelfCheck.ok,
      edit_note: String(editSelfCheck.note || ''),
      // ⚠️ 这个字段说的是"**这一刻**编辑面挂着没有"——⛔ 不是"能不能编辑"。
      //    阅读态下它恒为 false，那是**正常**的（`edit_ok` 才是能力判据）。
      editor_mounted: !!editing,
      // ⭐ 与 `edit_dirty` 配对：后端拿不到 DOM，脏标记只有前端知道（§2.4-4）。
      editor_dirty: !!editDirty,
      // ⭐ 预览的**第四个计数器**（§2.6-2）：`preview_req` 是最后一次**发出去**的序号，
      //    `preview_stale` 是"现在屏幕上那一份是否已过期"。
      //    ⚠️ 两者要能**独立**看：只报一个的话，"序号涨了但界面没更新"这种
      //       （渲染回来被判陈旧的）形态就看不出来。`-1` = 这一轮没渲染过。
      preview_req: editorPreview ? editorPreview.latestReq() : -1,
      preview_stale: editorPreview ? !!editorPreview.isStale() : false,
      // ⭐ `design/0012` §11：左右滚动同步的**这一刻的状态**（排障观测量）。
      //    ⚠️ 冒烟里**正常就是「编辑态未起」**（没人进编辑态）⇒ ⛔ 后端也**不拿它判**。
      //    ⭐ 它与 `editor_mounted` 配对读才有信息量，见 `syncState()` 的注释。
      sync_state: syncState(),
    };
    try {
      await T.call('report_status', { report: payload });
    } catch (e) {
      console.warn('report_status 失败：', e);
    }
  }

  // ⚠️ 兜底：事件回调里抛的异常不会经过 `boot()` 的 try/catch，
  //    没有这两行它们就是"点了没反应"且**没有任何痕迹**。
  window.addEventListener('error', function (e) { reportFatal(e.error || e.message); });
  window.addEventListener('unhandledrejection', function (e) { reportFatal(e.reason); });

  // Tauri 注入的脚本在 document 起始处执行，但这里再等一次 DOMContentLoaded，
  // 免得顺序在某个 WebKit 版本上变了之后 `getElementById` 拿到 null。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); });
  } else {
    boot();
  }
})();
