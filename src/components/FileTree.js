// 文件树 —— `design/0003` §2.1 的懒加载树。
//
// # 只做五件事
//
// 1. **展开才扫**：只列一层（后端 `list_dir` 一次只列一层，前端不递归）。
// 2. **状态在数据层**：展开集合是 `expanded: Set<路径>`，⛔ 不从 DOM 反推。
//    ⇒ 收起/展开侧边栏**不可能**影响它（`INV-TREE-02` 后半句）。
// 3. **分片追加**：单层超过阈值时分片（`chunked.js`），每个分片开头查代次。
// 4. **当前项只有一个**：`setCurrent` 先把旧的摘掉再挂新的。
// 5. ⭐ **键盘可达**（2026-10-13 补，`design/0004` §9.1 B13）：一个 Tab 停靠点
//    ＋方向键在行间移动。⛔ 不是"每行 `tabindex=0`"——见 `styles/sidebar.css`。
//
// # ⛔ 前端不做的一件事：不拼路径
//
// 节点路径**只**来自 `list_dir` 的返回值（`INV-TREE-01`）。
// ⚠️ 本文件里出现的 `isInside()` 是**导航用**的（"该展开哪些祖先节点"），
// ⛔ **不是**授权判断——授权只在后端 `check_readable` 里做，
// 前端连"这个路径能不能读"都不该有意见。
//
// # ⚠️ 一个容易误判的细节：`ignored` 节点
//
// 忽略清单里的目录（`node_modules` / `target` / `dist` / `build`）
// **可见但灰显、点击无任何反应**（⛔ 不弹错、⛔ 不展开）。
// 后端已经**没有扫描**它们的子项——这里"点不动"只是把那个事实呈现出来，
// ⛔ 不是"进去之后再过滤"（§2.1 的两个集合判据，§7 步骤 5）。
//
// # ⭐ `design/0009` 在本文件加厚了三处（2026-10-14，实施记录见其 §10）
//
// 搜索浮层选中的那条结果要**在树里定位到**（§7 步骤 9/9b/9c），而原型期的树
// 有三处办不到，全部是**静默**的：
//
// 1. ⭐ **`expand` 变成可等待**（返回 `Promise`，含分片追加的最后一片）。
//    原型的 `renderLayer` 是"发起即返回"，>500 项那一层还在追加时调用方
//    就去 `findNode` ⇒ 目标落在没追加的分片里时**返回 `null`**，
//    表现是"结果点得开正文、树定位不到"。⚠️ 为了拿到"这一层完事了"这个信号，
//    `chunked.js` 加了 `onDone(state)`（保证**只调一次**，含整批回滚那一路）。
// 2. ⭐ **`relistAndFind`：先作废那一层再重列**（§2.1 ⑤ 表格第三行）。
//    树缓存的键是**（代次, 单层路径）**，而"目录里多了个文件"**不会**让代次动
//    ⇒ 搜索刚看到的新文件在树里可能不在。⚠️ **只重试一次**，⛔ 不循环。
// 3. ⭐ **`revealPath` 的返回值从 `boolean` 加厚成 `{ok, reason}`**——
//    "定位不到"有**好几种**原因，出路各不相同（层级过深要说到明处、
//    这一层读不出来要能重试、路径不在这棵树里则**根本不是缺陷**）。
//    ⛔ 一个 `false` 把它们混成一种，调用方只能静默（`INV-SEARCH-07` 要的正是"可见"）。
//
// ⚠️ 因此**调用方必须消费那个对象**：`main.js` 的 `revealInTree()` 是**唯一**
// 调用点，它把失败变成树顶上那行灰字（`note()`）。⛔ 别再写出
// `tree.revealPath(p);` 这种丢掉返回值的写法——那正是加厚之前的形状。

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

  // ⭐ `design/0025`：可见文案走字典。⚠️ 本文件的那几句话都挂在**已经画好的树节点**上，
  //    切语言时没有谁会重画它们 ⇒ 用 `specNodes` 记下"怎么重算"（§2.5.1 ②）。
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) ||
    (typeof module !== 'undefined' && module.exports ? require('../services/i18n.js') : null);
  const t = I18N ? I18N.t : function (key) { return key; };

  /** 树里的"现算文案"登记表：`{el, prop, key, vars}`。⚠️ 只留还在文档里的那些。 */
  const specNodes = [];

  /** 写一句话并记下配方（`prop` 是 `'textContent'` 或 `'title'`）。 */
  function setSpec(el, prop, key, vars) {
    el[prop] = t(key, vars);
    specNodes.push({ el: el, prop: prop, key: key, vars: vars });
  }

  /** 切语言时重贴树里所有还活着的那些句子（`subscribe` 那一路）。 */
  function relabelTree() {
    let k = 0;
    for (let i = 0; i < specNodes.length; i++) {
      const r = specNodes[i];
      if (!r.el || !r.el.isConnected) continue;
      r.el[r.prop] = t(r.key, r.vars);
      specNodes[k++] = r;
    }
    specNodes.length = k;
  }

  if (I18N) I18N.subscribe(relabelTree);

  const V = (typeof module !== 'undefined' && module.exports) ? require('../services/versions.js') : window.rmd.versions;
  const C = (typeof module !== 'undefined' && module.exports) ? require('../services/chunked.js') : window.rmd.chunked;
  const S = (typeof module !== 'undefined' && module.exports) ? require('../services/session.js') : window.rmd.session;
  const D = (typeof module !== 'undefined' && module.exports) ? require('../services/dirsession.js') : window.rmd.dirSession;
  // ⭐ `design/0034`：刷新事务 / 右键目标 / 输入行语义的**纯逻辑**。
  //    ⚠️ 加载期取值 ⇒ `index.html` 里它必须排在本文件**之前**。
  const R = (typeof module !== 'undefined' && module.exports) ? require('../services/treerefresh.js') : window.rmd.treeRefresh;
  // ⭐ `design/0035`：剪贴板的**只读能力核对** ＋ 唯一一条写入实现（纯前端，⛔ 不写盘）。
  //    ⚠️ 加载期取值 ⇒ `index.html` 里它必须排在本文件**之前**。
  const CLIP = (typeof module !== 'undefined' && module.exports)
    ? require('../services/clipboard.js') : window.rmd.clipboard;
  // ⭐ `design/0050`：内容修订（`seq`）与两条窄命令。⚠️ 加载期取值 ⇒
  //    `index.html` 里 `services/diskevents.js` 必须排在本文件**之前**。
  //    ⚠️ 本文件只用 `seq()`（提交点比对）与 `refresh()`（人工刷新先对一次盘）——
  //    ⛔ **不订阅**任何通道（订阅点只有 `diskevents.install` 一处）。
  const DE = (typeof module !== 'undefined' && module.exports)
    ? require('../services/diskevents.js') : window.rmd.diskEvents;

  /**
   * 路径分隔符只在规范化后的 POSIX 路径上讨论（macOS 上 Rust 侧就是 `/`）。
   *
   * ⭐ **`design/0020` 起函数体搬到了 `services/dirsession.js`**——`main.js` 的
   * 写者/恢复器也要用同一条包含判断，而"两份实现"在安全路径上就是
   * `INV-FS-01` 的失效形态。⚠️ 这里保留这个名字只是**导出兼容**（`api.isInside`），
   * ⛔ 别再在这里写第二份函数体。
   */
  const isInside = D.isInside;

  function splitPath(p) {
    return p.split('/').filter(function (s) { return s.length > 0; });
  }

  /**
   * 文件名里可能有控制字符 / bidi 覆盖字符（§6 的失败模型：可能被伪装）。
   * V1 的做法是**转义**，⛔ 不做 bidi 视觉重排。
   */
  function safeName(name) {
    // eslint-disable-next-line no-control-regex
    return String(name).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '�');
  }

  /** 内联 SVG 用（`createElementNS` 的命名空间）。 */
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * ⭐ B8 的节点图标。
   *
   * ⚠️ **内联 SVG，⛔ 不用 emoji / 不是图标字体 / 不引外部资源**：
   *    - emoji 在不同 macOS 版本上会换字形，同一棵树的观感会漂；
   *    - 图标字体/外部 SVG 要在 CSP 与打包上多开一个口子，收益只有两个图标；
   *    - `stroke: currentColor` ⇒ **颜色自动跟随主题**，⛔ 这里不写任何色值
   *      （`INV-THEME-02`：写了就在深色主题下漏一个角落）。
   *
   * ⛔ 不用 `innerHTML` 拼字符串：这条路径上没有任何用户数据，
   *    但"这个文件里只有一处 innerHTML"这件事本身就是值钱的。
   */
  function svgIcon(kind) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.3');
    svg.setAttribute('stroke-linejoin', 'round');
    const d = kind === 'folder'
      ? 'M2 12.6V3.4h4.1l1.6 2H14v7.2z'
      : 'M4.3 2.4h5.1l2.9 2.9v8.3H4.3z';
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    if (kind === 'file') {
      const fold = document.createElementNS(SVG_NS, 'path');
      fold.setAttribute('d', 'M9.4 2.4v2.9h2.9');
      svg.appendChild(fold);
    }
    return svg;
  }

  /**
   * 建一棵树。
   *
   * @param {object} opts
   * @param {HTMLElement} opts.host 树挂在哪
   * @param {(path:string) => void} opts.onOpenFile 点了一份 `.md`
   * @param {(e:object) => void} [opts.onError] 出错时的提示（⛔ 不要弹全局错误框）
   * @param {() => void} [opts.onStateChange] ⭐ `design/0020`：展开集合**真的变了**之后通知
   *   （写者的唯一入口）。⚠️ 恢复事务里的变化**不通知**（`restoring` 抑制），
   *   否则"恢复"会被当成"用户改了树"再写回去一轮。
   * @param {() => void} [opts.onUserToggle] ⭐ `design/0020`：**用户亲手**展开/折叠
   *   （⛔ 与 `onStateChange` 不是一回事：它回答的是"用户接管了没有"，
   *   用于让恢复事务**不再自动打开**上次的文件）。
   * @param {() => {editing:boolean}} [opts.getEditorState] ⭐ `design/0035` §3.1：
   *   编辑器**挂着没有**（⛔ 不是"脏不脏"）。只有"当前文档 + 正在编辑"才置灰改名。
   *   取不到就当作"没在编辑"——那不会造成滥用：后端 `rename_guard` 会独立拒。
   * @param {(entries:Array, dirPath:string) => Array} [opts.filterEntries]
   *   ⭐ `design/0041` §2.2：**渲染前**过一道判据（隔离"没有 md 的目录"）。
   *   ⚠️ 调用点**只有这一处**（`renderLayer` 之前）——⛔ 不在 `makeNode` 里逐项判：
   *   那样"一层过滤后为空"与"这一层读不出来"就长得一样了。取不到 ⇒ 原样返回。
   * @param {(path:string) => void} [opts.onCreated] ⭐ `design/0041` R4：
   *   **新建目录**成功之后回调（⛔ 改名不回调）。调用方记一条会话级例外，
   *   让这个**还是空的**目录在下次过滤时**仍然可见**——否则用户刚建完就看不见它，
   *   更进不去建第一份 md。⚠️ 必须在父层重列**之前**调。
   * @param {() => Promise<void>} [opts.onManualRefresh] ⭐ `design/0050` 最终约束 5：
   *   人工刷新**先跨 IPC 对一次盘**（`reconcile_disk`），再走刷新事务。
   *   ⚠️ 两件事**不是二选一**：对账让后端推内容修订并清旧纪元缓存，
   *   重列让界面真的把新内容画出来。取不到 ⇒ 只剩重列（旧行为）。
   */
  function createFileTree(opts) {
    /** 连续补跑的硬上限（⛔ 不空转）。到达之后只留 `refreshPending` 等下一份信息。 */
    const AUTO_RETRY_LIMIT = 3;
    /** 补跑之间的等待（毫秒）。⚠️ 与后端的去抖静默窗同量级：再短就还在同一簇事件里。 */
    const AUTO_RETRY_DELAY_MS = 300;

    const host = opts.host;
    const onOpenFile = opts.onOpenFile;
    const onError = opts.onError || function () {};
    const onStateChange = opts.onStateChange || function () {};
    const onUserToggle = opts.onUserToggle || function () {};
    const getEditorState = opts.getEditorState || function () { return { editing: false }; };
    const filterEntries = opts.filterEntries || function (entries) { return entries; };
    const onCreated = opts.onCreated || function () {};
    // ⭐ `design/0050` 最终约束 5：人工刷新那条**跨 IPC 的对账**（⛔ 不是必须的）。
    const onManualRefresh = typeof opts.onManualRefresh === 'function'
      ? opts.onManualRefresh : function () { return Promise.resolve(); };
    // ⭐ `design/0043` §2.3：收藏的两项。⚠️ 判据（现在收藏着没有）由调用方从
    //    **会话真值**里读（⛔ 本文件不存第二份收藏表）；"收藏 ⇄ 取消"由调用方去发命令。
    const isFavorite = opts.isFavorite || function () { return false; };
    const onToggleFavorite = opts.onToggleFavorite || function () {};

    /**
     * ⭐ `design/0020`：恢复事务进行中。
     * ⚠️ **只抑制通知，⛔ 不抑制 DOM**——树必须真的长出来，只是"这不是用户干的"。
     */
    let restoring = false;

    /** 展开集合真的变了（⛔ 恢复期间沉默）。 */
    function notifyState() { if (!restoring) onStateChange(); }

    /** 用户亲手碰了树（⛔ 恢复期间沉默：那正是我们要区分的两件事）。 */
    function notifyUserToggle() { if (!restoring) onUserToggle(); }

    /** ⭐ 展开状态。**数据层**，与 DOM 无关。 */
    const expanded = new Set();
    /** 已展开但读失败的层（⛔ 不清空已渲染的内容，只是标一下）。 */
    const failed = new Set();
    let currentEl = null;
    let root = null;
    /** ⭐ 树顶上那行"定位失败"的灰字（`design/0009`）。同时只有一条。 */
    let revealNote = null;
    /** ⭐ 那行灰字被写过几次（`design/0035`：`flash` 只清自己那一句）。 */
    let noteSeq = 0;
    /** ⭐ 在途分片。⚠️ 记**容器**（`design/0009` §2.1 ⑤ 要能只作废**某一层**）。 */
    const appenders = [];

    // ─────────────────────────────────────────────────────────────────────
    // ⭐ `design/0034` §2.1 A：刷新的五个纯数据态
    //
    // ⚠️ 这里**不做任何遍历**：事件到达时只 `epoch += 1`，真正的比较落在
    //    「下一次展开这一层」与「刷新事务」两处（§2.1 A.1 的 no-polling 纪律）。
    // ─────────────────────────────────────────────────────────────────────

    /** ⭐ 树事件代次（`rmd://tree-changed` 每来一次 +1）。
     *  ⚠️ 与 `S.state.generation`（后端**授权**代次）**不是一回事**：那个管换根，
     *  这个管"盘上的目录内容变了"。判新鲜度时两者都要看。 */
    let epoch = 0;
    /** 每层**最近一次成功取回**时的 `epoch`（§2.1 A.1）。 */
    const layerEpoch = new Map();
    /** 每层在途请求的序号：**按路径**发号（§2.1 A.2），⛔ 没有全局 `latestTreeReq`。 */
    const layerSeq = new Map();
    /** 每层**最新**那次在途 fill 的 Promise。⚠️ 只用来让被取代的一方等到赢家
     *  （`expand` 遇到 `superseded` 时），⛔ 不用它做任何提交判据。 */
    const inflight = new Map();
    /** 会话令牌：`reset` 时 +1 ⇒ 上一棵树的在途回包一律作废（⛔ 且不写回任何状态）。 */
    let sessionToken = 0;
    /** 展开集合的版本号：刷新事务用它判"用户中途改过树没有"。 */
    let expandVersion = 0;
    /** 有事件在等一次刷新。⚠️ 事务被丢弃 / 让位给输入行时**保留**，⛔ 别清成 false。 */
    let refreshPending = false;
    /** 刷新事务正在跑：同一时刻**至多一个**（§2.1 A.3 的互斥）。 */
    let refreshing = false;
    /**
     * ⭐ 补跑的预算与定时器（`design/0050` 最终约束 4）。
     *
     * ⚠️ 「暂不重试」与「永远不重试」在界面上**长得一模一样**，都是"树停在旧的"。
     * ⇒ 非要丢掉的那一次，只能是**有界**的放弃，而且必须有下一份信息把它救回来
     * （新事件会把预算重新给满，见 `noteTreeChanged`）。
     */
    let autoRetries = 0;
    let autoTimer = null;
    /** 离屏构建正在填的目录：活树这一侧要对它让路（§2.1 A.2 的并行保护）。 */
    const building = new Set();
    /** 在飞的新建请求数（刷新事务要给它让路，⛔ 不然输入行会被换掉）。 */
    let creating = 0;
    /** 就地输入行的状态；`null` = 当前没有输入行。 */
    let input = null;
    /** 右键菜单（网页里的一层）。⚠️ 同时只有一个。 */
    let menuEl = null;
    let menuCleanup = null;

    /** 展开集合变了一下（刷新事务的版本判据）。 */
    function bumpVersion() { expandVersion += 1; }

    /**
     * 停掉在途分片。
     * @param {HTMLElement|null} container 只停这一个容器里的；`null` = 全停
     */
    function stopAppenders(container) {
      for (let i = appenders.length - 1; i >= 0; i--) {
        if (container && appenders[i].container !== container) continue;
        appenders[i].a.state.stopped = true;
        appenders.splice(i, 1);
      }
    }

    /** 停止**全部**在途分片（切根时用：⛔ 别让旧代的分片继续往新树里追加）。 */
    function cancelAppenders() { stopAppenders(null); }

    /**
     * ⭐ 忘掉 `path` 之下所有已展开的层。
     *
     * ⚠️ **这是"作废某一层并重列"的必要一半**（`design/0009` §2.1 ⑤）：
     * 重列会把那一层的子节点**整个换掉**，而 `expanded` 是按路径记的——
     * 不清的话，新渲染出来的目录节点**长得是收起的**（它没有 `expanded` class），
     * 但数据层认为它展开着 ⇒ 用户点一下"展开"，实际执行的是**折叠**。
     * 一个纯粹的、只会让人以为鼠标坏了的错。
     */
    function forgetDescendants(path) {
      const prefix = path.endsWith('/') ? path : path + '/';
      expanded.forEach(function (p) {
        if (p !== path && p.indexOf(prefix) === 0) expanded.delete(p);
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // ⭐ `design/0034`：刷新事务要用的几个小工具（都是只读的）
    // ─────────────────────────────────────────────────────────────────────

    function sleep(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /** `path` 相对根的第几层（根 = 0）。⚠️ 只用于 `depthAllowed` 与缩进，⛔ 不判授权。 */
    function depthInRoot(path) {
      if (!root || typeof path !== 'string') return 0;
      return splitPath(path).length - splitPath(root).length;
    }

    /**
     * 量出当前**可见行**的位置（视口坐标）。
     * ⚠️ 不可见的行（收起的分支）`getClientRects()` 为空，自然被排除——
     * ⛔ 不另算一遍"哪些展开了"（那会变成 `expanded` 的第二个真值）。
     */
    function measureRows(container) {
      const out = [];
      const all = container.querySelectorAll('.node > .row');
      for (const r of all) {
        if (r.getClientRects().length === 0) continue;
        const b = r.getBoundingClientRect();
        out.push({ path: r.parentElement.dataset.path, top: b.top, bottom: b.bottom });
      }
      return out;
    }

    /** 刷新前的**滚动锚点**：第一行"底部还在视口里"的行（`R.anchorRow`）。 */
    function captureAnchor() {
      if (!host.getClientRects().length) return null;
      return R.anchorRow(measureRows(host), host.getBoundingClientRect().top);
    }

    /** 刷新前焦点在哪一行（⛔ 不抢焦点，只记下来一会儿还回去）。 */
    function focusedPath() {
      const a = document.activeElement;
      if (!a || !a.classList || !a.classList.contains('row')) return null;
      const n = a.parentElement;
      return n && n.dataset ? (n.dataset.path || null) : null;
    }


    // ⭐ **B13 的键盘可达性。**
    //
    // 采用的模式与 VS Code / Typora 一致：**一个 Tab 停靠点 + 方向键在行间移动**。
    // ⛔ 不给每行 `tabindex="0"`——5000 项的目录会变成 5000 个 Tab 停靠点。
    // ⇒ 容器可聚焦，行是 `tabindex="-1"`（可编程聚焦、不进 Tab 序列）。
    //
    // ⚠️ 「可见行」= 有布局盒的行。收起的分支是 `display:none`，
    // `getClientRects()` 为空，自然被排除——⛔ 不需要另算一遍"哪些展开了"
    // （那会变成 `expanded` 集合的第二个真值）。
    host.tabIndex = 0;
    host.addEventListener('keydown', onKeyDown);

    /** 当前可见的行（按 DOM 顺序）。 */
    function visibleRows() {
      const all = host.querySelectorAll('.node > .row');
      const out = [];
      for (const r of all) if (r.getClientRects().length > 0) out.push(r);
      return out;
    }

    /** 这一行所属的 `.node`。 */
    function nodeOf(row) { return row.parentElement; }

    /** 上一级的行（父目录那一行）。找不到就是根层。 */
    function parentRow(row) {
      const node = nodeOf(row);
      const kids = node.parentElement;          // .children
      const parent = kids && kids.parentElement; // 父 .node
      return parent ? parent.firstElementChild : null;
    }

    function focusRow(row) {
      if (!row) return;
      row.focus();
      row.scrollIntoView({ block: 'nearest' });
    }

    /**
     * ⚠️ 键盘行为只做**四个方向 + Enter/Space + Home/End**——
     * 这是树控件的最小可用集。⛔ 不做 type-ahead 跳转、不做多选：
     * 本项目是**只读阅读器**，"当前项"至多一个（§2.1）。
     */
    function onKeyDown(e) {
      const host2 = document.activeElement;
      const inside = host2 && host2.classList && host2.classList.contains('row');
      if (!inside) {
        // 容器自己拿到焦点：第一次按 ↓ 落在第一行
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          focusRow(visibleRows()[0]);
        }
        return;
      }
      const row = host2;
      const rows = visibleRows();
      const i = rows.indexOf(row);
      const node = nodeOf(row);
      const isDir = node.dataset.dir === '1';

      if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(rows[i + 1]); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(rows[i - 1]); return; }
      if (e.key === 'Home') { e.preventDefault(); focusRow(rows[0]); return; }
      if (e.key === 'End') { e.preventDefault(); focusRow(rows[rows.length - 1]); return; }

      if (e.key === 'ArrowRight' && isDir) {
        e.preventDefault();
        const path = node.dataset.path;
        const depth = Number(node.dataset.depth) || 0;
        if (!expanded.has(path)) {
          // ⭐ `design/0020`：用户亲手展开 ⇒ 恢复事务从此**不再自动打开**文件。
          notifyUserToggle();
          expand(node, path, depth);
        } else {
          // 已展开 → 进到第一个子行（这才是标准树控件的行为）
          const first = node._kids && node._kids.querySelector('.node > .row');
          if (first) focusRow(first);
        }
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (isDir && expanded.has(node.dataset.path)) {
          // ⭐ `design/0020`：同 `ArrowRight`，手动的键操作也算"用户接管"。
          notifyUserToggle();
          collapse(node, node.dataset.path);
        } else {
          focusRow(parentRow(row));
        }
        return;
      }
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        row.click();
      }
    }

    /** 清空整棵树（切根 / 打开外部文件时）。 */
    function reset(newRoot) {
      cancelAppenders();
      expanded.clear();
      failed.clear();
      currentEl = null;
      // ⚠️ 那行"定位失败"的灰字也跟着走：它说的是一份**具体文档**的事，
      //    树都换了一棵了，留着它就是一条指向不存在的事实的说明。
      revealNote = null;
      // ⭐ `design/0034`：换树 ⇒ 上一棵树的**全部**判据作废。
      //    ⚠️ `sessionToken++` 是关键那一半：在途回包回来时看到令牌变了，
      //    直接丢弃，⛔ 不许把旧的 `layerEpoch` / `layerSeq` 写回新树
      //    （那会让"上一层旧内容"被记成"这一层刚取过"）。
      sessionToken += 1;
      epoch += 1;
      bumpVersion();
      layerEpoch.clear();
      layerSeq.clear();
      building.clear();
      refreshPending = false;
      // ⚠️ 正在跑的刷新事务由 `sessionToken` 作废；`refreshing` 由它自己的
      //    `finally` 复位，这里⛔ 不改（否则两个 finally 会互相踩）。
      closeInput(true);
      closeMenu();
      root = newRoot || null;
      host.textContent = '';
    }

    function makeNode(entry, depth) {
      const node = document.createElement('div');
      node.className = 'node';
      node.dataset.path = entry.path;
      node.dataset.dir = entry.is_dir ? '1' : '0';
      node.dataset.depth = String(depth);
      if (entry.ignored) node.classList.add('ignored');
      if (entry.is_dir) node.classList.add('dir');

      const row = document.createElement('div');
      row.className = 'row';

      const twisty = document.createElement('span');
      twisty.className = 'twisty';
      // ⭐ **2026-10-13 改**：`design/0004` §9.1 **B7** 通过后，箭头改为**常显**
      //    （原设计是 hover 才显示，学 Typora；但那样**静止时目录与文件长得一模一样**，
      //     看不出哪一行能展开——那是可发现性问题，不是审美）。
      //    ⚠️ 可见性由 CSS 定（`styles/sidebar.css` 的 `.twisty`）：
      //    文件的箭头是 `visibility:hidden` 而不是不渲染——**占位要留着**，
      //    否则同一层的目录名与文件名会错开一个箭头的宽度。
      //    节点也要一直在，键盘与屏幕阅读器才有东西可依（`aria-expanded` 挂在它上面）。
      //    ⚠️ 字形是 `▸`（朝右），展开时由 CSS 旋转 90° 变成朝下——
      //    ⛔ 不要在 JS 里换字形：那会让"展开状态"多出第二个真值。
      if (entry.is_dir) twisty.textContent = '▸';
      row.appendChild(twisty);

      // ⭐ **补做**：`design/0003` §2.1.1 第 5 条要的是「**树节点图标** / 展开箭头」**两样**，
      //    而此前只做了箭头那一半（`design/0003` §10.5 记了这处漏做）。
      //    ⚠️ 形态与可见性归 `design/0004`（§9.1 B8：**常显**，学 VS Code），
      //    尺寸与间距见 `styles/sidebar.css` 的 `--ui-icon-size` / `--ui-icon-gap`。
      //    ⛔ `aria-hidden`：它纯装饰，读屏念一遍"文件夹"只会更吵（文件名已经说了）。
      const icon = document.createElement('span');
      icon.className = 'node-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.appendChild(svgIcon(entry.is_dir ? 'folder' : 'file'));
      row.appendChild(icon);

      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      // ⭐ 用 `textContent`，⛔ 绝不 `innerHTML`：文件名是用户数据。
      nameEl.textContent = safeName(entry.name);
      nameEl.title = entry.path;
      row.appendChild(nameEl);
      node.appendChild(row);

      const kids = document.createElement('div');
      kids.className = 'children';
      node.appendChild(kids);
      node._kids = kids;

      if (entry.ignored) {
        // 可见但点不动：给出**为什么**（§2.1 的两个集合判据）
        setSpec(row, 'title', 'tree.ignored-title', { path: entry.path });
        return node;
      }
      if (entry.is_dir) {
        row.addEventListener('click', function () {
          // 只在**目录且未超深**时可展开；点一下展开、再点一下折叠
          if (!V.depthAllowed(depth)) return;
          // ⭐ `design/0020`：**先**说"用户接管了"，**再**动树——
          //    恢复事务可能正在 `await` 这一层的 `list_dir`，顺序反了它会把
          //    用户刚点开的那一层当成"恢复自己干的"，然后继续去开旧文件。
          notifyUserToggle();
          if (expanded.has(entry.path)) collapse(node, entry.path);
          else expand(node, entry.path, depth);
        });
        row.setAttribute('aria-expanded', 'false');
        // ⚠️ `tabindex="-1"`：**可编程聚焦、不进 Tab 序列**。
        //    理由见 `styles/sidebar.css` 的 `.pane`——5000 项目录若有 5000 个
        //    Tab 停靠点，键盘用户只能一格一格爬出去。焦点由方向键在行间移动
        //    （B13 的键盘焦点态就是为它准备的）。
        row.tabIndex = -1;
        row.setAttribute('role', 'treeitem');
      } else {
        row.addEventListener('click', function () { onOpenFile(entry.path); });
        // ⚠️ `tabindex="-1"`：**可编程聚焦、不进 Tab 序列**。
        //    理由见 `styles/sidebar.css` 的 `.pane`——5000 项目录若有 5000 个
        //    Tab 停靠点，键盘用户只能一格一格爬出去。焦点由方向键在行间移动
        //    （B13 的键盘焦点态就是为它准备的）。
        row.tabIndex = -1;
        row.setAttribute('role', 'treeitem');
      }
      return node;
    }

    function collapse(node, path) {
      // ⭐ `design/0034`：刷新事务拿这个版本号判"用户中途改过树没有"。
      bumpVersion();
      expanded.delete(path);
      node.classList.remove('expanded');
      node._kids.style.display = 'none';
      const row = node.firstChild;
      row.setAttribute('aria-expanded', 'false');
      // ⭐ `design/0020`：展开集合变了 ⇒ 写者该记一笔（恢复期由 `notifyState` 自己抑制）。
      notifyState();
    }

    /**
     * ⭐ **列一层并填进 `container`**——`expand` 与"作废某一层再重列"共用的那一半。
     *
     * ⚠️ 调用方负责：`expanded` 的标记、容器的清理、以及**读失败时怎么呈现**。
     * 这里只做"读 + 渲染"，⛔ 不改任何界面状态（那会让两条调用路径的语义分叉）。
     *
     * ⭐ `design/0034` §2.1 A.2 起它是**按路径发号**的：同一层先后两次请求，
     * 后发的那次赢；早先的回包看到序号变了就**什么都不碰**（⛔ 不碰容器、
     * ⛔ 不回滚 `expanded`），只回一个 `superseded` 让调用方安静收手。
     *
     * @param {HTMLElement} container 往哪儿填
     * @param {string} path 列哪一层
     * @param {number} childDepth 这一层的**子项**算第几层（`depthAllowed` 用的是父层）
     * @param {boolean} [fresh] ⭐ 先作废后端那一层的缓存再列（`design/0009` §2.1 ⑤）
     * @param {boolean} [recordEpoch] 成功之后记 `layerEpoch`（默认 `true`）。
     *   ⚠️ 刷新事务的**离屏构建**传 `false`：它那一份内容属于"事务开始时"的
     *   `epoch`，由事务在提交时统一记账（`commitRefresh`）。
     * @param {boolean} [offscreen] 离屏构建。⚠️ 离屏时**不碰** `layerSeq` / `failed`，
     *   也不让路——它本来就该和活树并行（§2.1 A.2）。
     * @returns {Promise<{ok:boolean, reason:string|null, error:Error|null}>}
     *   `reason`：`unreadable`（读失败）/ `stale`（授权代次或会话变了，已丢弃）
     *   / `superseded`（同一层有更晚的请求）/ `deferred`（这一层正在离屏构建中）
     *   / `partial`（分片被回滚）
     */
    function fillLayer(container, path, childDepth, fresh, recordEpoch, offscreen) {
      const live = !offscreen;
      // ⭐ 并行保护：同一层正在离屏构建 ⇒ 活树这边**让路**（⛔ 不碰 DOM、⛔ 不发号）。
      //    否则两条路各写一次这一层，后回来的那条会把前一条的序号顶掉，
      //    两边互相判"被取代"，最后谁也不填。
      if (live && building.has(path)) return Promise.resolve({ ok: true, reason: 'deferred', error: null });
      const run = fillLayerInner(container, path, childDepth, fresh, recordEpoch, live);
      if (!live) return run;
      // ⚠️ 登记"这一层最新的一次"：被取代的那一方要能等到赢家（见 `expand`）。
      const clear = function () { if (inflight.get(path) === run) inflight.delete(path); };
      run.then(clear, clear);
      inflight.set(path, run);
      return run;
    }

    /** `fillLayer` 的本体。⚠️ 只有它 `await`，外层那个 `function` 是为了同步登记 `inflight`。 */
    async function fillLayerInner(container, path, childDepth, fresh, recordEpoch, live) {
      const seq = live ? R.nextSeq(layerSeq, path) : 0;
      const token0 = sessionToken;
      const epochAtSend = epoch;
      let payload;
      try {
        payload = await S.listDir(path, fresh);
      } catch (e) {
        // ⚠️ 令牌变了 ⇒ 这棵树已经不在了，⛔ 连 `failed` 都不许碰（那是新树的状态）。
        if (token0 !== sessionToken) return { ok: false, reason: 'stale', error: null };
        if (live && !R.isCurrent(layerSeq, path, seq)) {
          return { ok: false, reason: 'superseded', error: null };
        }
        if (live) failed.add(path);
        return { ok: false, reason: 'unreadable', error: e };
      }
      if (token0 !== sessionToken) return { ok: false, reason: 'stale', error: null };
      if (!payload.decision.commit) {
        // ⭐ 提交点 ③：代次已经变了 → 本批及剩余全部丢弃（§2.1.3）
        // ⭐ `design/0050`：**内容修订**变了是另一回事 —— 同一棵树、盘上新了一点。
        //    ⚠️ 两者的 reason 必须分开（`stale` 要放弃、`rev` 要重列）：
        //    合成一个的话，"外部改动"要么被永久丢掉、要么被当成换根而放弃重试。
        return { ok: false, reason: payload.decision.reason === 'rev' ? 'rev' : 'stale', error: null };
      }
      // ⭐ 按路径的先后判据（§2.1 A.2）：**晚发的赢**，早发的安静退出。
      if (live && !R.isCurrent(layerSeq, path, seq)) {
        return { ok: false, reason: 'superseded', error: null };
      }
      if (live) failed.delete(path);
      // ⭐ `design/0041` §2.2：判据在**渲染之前**过一次（唯一调用点）。
      //    ⚠️ 过滤只决定"这一层画哪些"，⛔ 不影响 `failed` / `layerEpoch` 的语义
      //    （"读得出来"与"画得出来"是两件事：一个读得出但没有 md 的目录，不是失败）。
      const entries = filterEntries(payload.result.entries, path);
      const r = await renderLayer(container, entries, childDepth);
      if (token0 !== sessionToken) return { ok: false, reason: 'stale', error: null };
      if (r.ok && recordEpoch !== false) {
        // ⚠️ 记的是**发送时刻**的 epoch（⛔ 不是现在的）：回包在路上的这段时间里
        //    如果来过一次事件，这一层的内容就已经旧了 —— 记成新 epoch 会让它
        //    永远不再重取（`design/0034` §2.1 A.1 的承重点）。
        layerEpoch.set(path, epochAtSend);
      }
      if (live && !R.isCurrent(layerSeq, path, seq)) {
        // 渲染期间被更晚的请求顶掉了：内容已经在容器里，但我们不认它。
        // ⚠️ 这里**不回滚 DOM**——回滚会连带删掉后来那一批刚追加的节点。
        return { ok: false, reason: 'superseded', error: null };
      }
      return { ok: r.ok, reason: r.ok ? null : r.reason, error: null };
    }

    /**
     * 展开一层。⭐ 结果**逐层**写进树，⛔ 不缓存到前端（缓存是后端 `TreeCache` 的事，
     * 它的键带代次；前端再存一份就是第二个真值）。
     *
     * ⭐ **返回一个 Promise，它 resolve 时这一层已经**全渲染完**
     * （含分片追加的最后一片）——`design/0009` §2.1 ⑤ 的 `revealPath` 就靠它：
     * 原稿先 `await expand(...)` 再**立刻** `findNode`，而 >500 项的层是
     * **异步分片**追加的 ⇒ 目标落在还没追加的分片里时 `findNode` 返回 `null`，
     * 表现是"结果点得开正文、树定位不到"，**静默**。
     *
     * @param {boolean} [fresh] 先作废这一层的后端缓存再列（同上）
     * @returns {Promise<{shown:boolean, reason:string|null}>}
     */
    async function expand(node, path, depth, fresh) {
      // ⭐ `design/0034`：展开/折叠是"用户改了树"的一种（刷新事务据此重试或让路）。
      bumpVersion();
      const token0 = sessionToken;
      // ⚠️ 先标成展开、再等 IO：否则用户连点两下会发两次 `list_dir`。
      //    真出错时会回滚这个标记。
      expanded.add(path);
      node.classList.add('expanded');
      node._kids.style.display = '';
      const row = node.firstChild;
      row.setAttribute('aria-expanded', 'true');

      // ⭐ `design/0034` §2.1 A.1：**要不要重取这一层**由"取回时的 epoch"决定。
      //    `fresh` 仍然有用（人工/搜索那条"作废后端缓存"的路），两者取或。
      const needFresh = !!fresh || R.staleLayer(layerEpoch, path, epoch);
      // ⚠️ 重取会把子树**整个换掉** ⇒ 先把已展开的后代记下来，填完再按记录展开回去
      //    （`design/0034` §2.1 C：展开态与滚动锚点都要保持）。
      const desc = needFresh ? R.descendants(expanded, path) : [];

      if (needFresh) {
        // ⭐ 作废这一层：**先停分片再清容器**。反过来的话，还在跑的那个分片
        //    会往清空后的容器里继续追加——得到两层混在一起的树（且看不出哪层是新的）。
        forgetDescendants(path);
        stopAppenders(node._kids);
        node._kids.textContent = '';
      } else if (node._kids.childElementCount > 0) {
        // 已经在数据层展开过且有子节点 → 只是把 DOM 显示出来（§7 步骤 3：
        // "展开→折叠→再展开"必须保留，所以这里**不重扫**）
        // ⚠️ 这一支**也是一次真的状态变化**（它刚从折叠态回来）⇒ 要通知写者。
        notifyState();
        return { shown: true, reason: null };
      }

      if (!V.depthAllowed(depth)) {
        // §6：> 32 层**明确显示「层级过深」**，⛔ 不静默截断
        appendNote(node._kids, 'tree.too-deep', { n: V.MAX_DEPTH });
        // ⭐ `design/0009` §2.1 ⑤ 要的**可见降级**：这一层不进 `expanded`
        //    （否则"展开"与"没展开"两个说法并存），并把原因交给调用方
        //    ——正文照常打开，但定位失败这件事**有人要说出来**。
        expanded.delete(path);
        return { shown: false, reason: 'too-deep' };
      }

      const r = await fillLayer(node._kids, path, depth + 1, needFresh, true, false);

      if (r.reason === 'deferred') {
        // ⭐ 这一层正在刷新事务的离屏构建里：**让路**。⚠️ 展开标记留着
        //    （用户点的那一下不能因为一次后台刷新而失效），并保留一次待办刷新
        //    ——事务若因用户改动被丢弃，这次展开最终要靠它补上内容。
        refreshPending = true;
        notifyState();
        return { shown: true, reason: 'deferred' };
      }
      if (r.reason === 'superseded') {
        // ⭐ 同一层有更晚的请求在路上（§2.1 A.2）：等它，⛔ 别自己再填一遍。
        //    ⚠️ **不回滚 `expanded`**：回滚会让用户刚点开的目录自己合上。
        const latest = inflight.get(path);
        if (latest) { try { await latest; } catch (e) { /* 交给那一跳去报 */ } }
        if (token0 !== sessionToken) return { shown: false, reason: 'stale' };
        const filled = node._kids.childElementCount > 0;
        return { shown: filled, reason: filled ? null : 'stale' };
      }
      if (r.reason === 'unreadable') {
        expanded.delete(path);
        node.classList.remove('expanded');
        node.classList.add('unreadable');
        row.setAttribute('aria-expanded', 'false');
        // §6：报错限于该条目，⛔ 不弹全局错误，⛔ 也不清空已渲染的兄弟项
        // ⚠️ "有原因"与"没原因"是**两条键**（`design/0025` §2.2.1）：
        //    ⛔ 别在 `vars` 里塞一个**当场算好**的中文兜底——那会把语言冻在这一刻。
        const why = r.error.wording || r.error.message || '';
        if (why) appendNote(node._kids, 'tree.layer-unreadable', { msg: why });
        else appendNote(node._kids, 'tree.layer-unreadable-nomsg');
        onError(r.error);
        return { shown: false, reason: 'unreadable' };
      }
      if (r.reason === 'rev') {
        // ⭐ `design/0050`：读盘期间**盘上又变了**（内容修订前进了）。
        // ⚠️ **不撤销 `expanded`**：用户点的是"展开这个目录"，那件事没失败；
        //    失败的是"这一次读到的内容还算不算数"。撤销展开会让用户刚点开的目录自己合上，
        //    而它下一秒就会被正确的数据填上。
        // ⚠️ 留一次待办 ＋ 排一次补跑：⛔ 不许把它做成"什么都不发生"。
        refreshPending = true;
        scheduleRetry(AUTO_RETRY_DELAY_MS);
        notifyState();
        return { shown: false, reason: 'rev' };
      }
      if (r.reason === 'stale') {
        expanded.delete(path);
        node.classList.remove('expanded');
        return { shown: false, reason: 'stale' };
      }
      // ⭐ `design/0034`：重取之后把**原来展开着的后代**展开回去。
      //    ⚠️ 必须在 `notifyState()` **之前**：恢复期间 `restoring` 抑制了
      //    逐层的通知，这里只发一次，⛔ 不让"刷新"变成 N 次写盘。
      if (r.ok && desc.length) {
        await restoreExpanded(desc, function () {
          return node.isConnected && token0 === sessionToken;
        });
      }
      // ⭐ `design/0020`：只有**真的留在了展开集合里**才通知（上面两条失败分支
      //    都把 `expanded` 撤销了 ⇒ 净变化为零，通知出去就是一次假写盘）。
      if (r.ok) notifyState();
      return { shown: r.ok, reason: r.reason };
    }

    /** 一行灰字说明（占位 / 层级过深 / 读不出来）。 */
    /**
     * 在 `container` 里加一行灰字。
     * ⚠️ 2026-10-21（`design/0025`）签名从 `(container, text)` 改成
     *    `(container, key, vars)`：**传键不传句子**，这样它才能登记重画配方。
     */
    function appendNote(container, key, vars) {
      const note = document.createElement('div');
      note.className = 'note';
      setSpec(note, 'textContent', key, vars || {});
      container.appendChild(note);
    }

    /**
     * 渲染一层。⚠️ 超过阈值时**分片**——理由是"一帧内插太多节点"，
     * ⛔ 不是"扫描太慢"（扫描 5200 项只要 2.4 ms，见 `research/notes/0006`）。
     *
     * ⭐ **返回 Promise，resolve 时这一层已经全渲染完**（含最后一片）。
     * ⚠️ 这不是"方便"，是 `design/0009` §2.1 ⑤ 的硬要求：分片是**异步**的，
     * 而调用方下一步就要在这一层里找节点（⛔ 用轮询或 `setTimeout` 去猜
     * "应该好了吧"——在 5000 项的层上那是必然偶发的 bug）。
     *
     * @returns {Promise<{ok:boolean, reason:'done'|'gen'|null}>}
     */
    function renderLayer(container, entries, depth) {
      const gen = S.state.generation;
      if (entries.length <= V.CHUNK_FIRST) {
        for (let i = 0; i < entries.length; i++) container.appendChild(makeNode(entries[i], depth));
        return Promise.resolve({ ok: true, reason: 'done' });
      }
      return new Promise(function (resolve) {
        const appender = C.createChunkAppender({
          total: entries.length,
          gen: gen,
          // ⭐ 现取：这个函数每个分片开头都会被调一次，**必须是**当前值
          currentGen: function () { return S.state.generation; },
          build: function (from, to) {
            const out = [];
            for (let i = from; i < to; i++) out.push(makeNode(entries[i], depth));
            return out;
          },
          append: function (nodes) { for (const n of nodes) container.appendChild(n); },
          // ⭐ 陈旧时**移除已追加的部分**：⛔ 不能只停止调度，
          //    那会留下一棵"看起来目录里真只有这么多"的半截旧树（`INV-VER-01`）
          remove: function (nodes) { for (const n of nodes) n.remove(); },
          step: V.CHUNK_STEP,
          // ⭐ `chunked.js` 那边保证**只调一次**（`done` 与整批回滚都算）
          onDone: function (st) { resolve({ ok: st.reason === 'done', reason: st.reason }); },
        });
        appenders.push({ a: appender, container: container });
        appender.start();
      });
    }

    /** 根层：打开目录时列一次。 ⭐ `fresh` 见 `fillLayer`。 */
    async function showRoot(rootPath, fresh) {
      reset(rootPath);
      host.textContent = '';
      if (!rootPath) return { ok: false, reason: 'no-root' };
      const r = await fillLayer(host, rootPath, 0, fresh);
      if (r.reason === 'unreadable') {
        const why = r.error.wording || r.error.message || '';
        if (why) appendNote(host, 'tree.root-unreadable', { msg: why });
        else appendNote(host, 'tree.root-unreadable-nomsg');
        onError(r.error);
      }
      return { ok: r.ok, reason: r.reason };
    }

    // ─────────────────────────────────────────────────────────────────────
    // ⭐ `design/0034` §2.1 A.3：刷新事务
    //
    // 一句话：**先在离屏的 div 里把"当前展开的那些层"整个重建一遍，
    // 复核三道身份（会话 / 授权代次 / 用户改动）都还成立，才原子地换上去。**
    // ⚠️ 三道任一变了 ⇒ 丢弃重来（至多两次），⛔ 绝不把半新半旧的树换给用户。
    // ─────────────────────────────────────────────────────────────────────

    /**
     * 后端说「盘上的目录内容变了」（`rmd://tree-changed`，载荷为空）。
     * ⭐ 只做两件事：`epoch += 1`（让所有层的新鲜度作废）＋ 排一次刷新。
     *
     * ⚠️ `design/0050` 起它**只由去抖之后那次广播**触发（后端每 300 ms 静默 /
     * 至多 1 s 合并一窗）——**原始**信号走 `seq`（`diskevents` 里同步 +1），
     * 那条路**不重建**，只让在途结果在提交点自己作废。⛔ 别把两条并成一条：
     * 并了之后每一次原始事件都会重列整棵可见树（`git checkout` 就是几千次）。
     */
    function noteTreeChanged() {
      epoch += 1;
      // ⚠️ 不清 `layerEpoch`：按层比较本来就会看到 `epoch` 变了；
      //    清掉只会让"这一层上一次什么时候取过"这个排查信息消失。
      // ⭐ 新事件是一份**新信息** ⇒ 自动重跑预算重新给满（⛔ 否则一次数据密集的
      //    `git checkout` 会把预算烧光，之后到来的事件全被"上限"挡掉）。
      autoRetries = 0;
      return refreshVisible();
    }

    /** 用户按「刷新」：⭐ 先跨 IPC 对一次盘（`design/0050` 最终约束 5），再重列。 */
    function manualRefresh() {
      // ⚠️ 对账**失败也要重列**：它只是"顺便让后端也看一遍盘"，
      //    而用户点的是"刷新"，那件事不该因为一次 IPC 失败就什么都不做。
      return Promise.resolve()
        .then(function () { return onManualRefresh(); })
        .catch(function (e) {
          // ⚠️ 失败照实说（否则"点了刷新没反应"会被记成产品缺陷）。
          if (typeof console !== 'undefined') console.error('⛔ 手动对账失败（仍会重列可见层）：', e);
        })
        .then(function () { return refreshVisible(); });
    }

    /**
     * ⭐ **补跑的调度器**（`design/0050` 最终约束 4 的"⛔ 不许永远丢掉、⛔ 不许空转"）。
     *
     * 两条纪律：
     * 1. **同时只有一个定时器**：后来的请求只是合并进来（⛔ 不叠定时器、⛔ 不空转）；
     * 2. **有硬上限**：连续补跑 [`AUTO_RETRY_LIMIT`] 次仍没提交就停下，
     *    把 `refreshPending` 留着等下一次事件（那一定会来——`rev` 只可能是事件推出来的）。
     *
     * @param {number} delayMs
     */
    function scheduleRetry(delayMs) {
      if (refreshing) return;             // 事务在跑：它收尾时自己会看 `refreshPending`
      if (autoTimer !== null) return;     // 已经排上了：合并
      if (autoRetries >= AUTO_RETRY_LIMIT) return;
      autoRetries += 1;
      autoTimer = setTimeout(function () {
        autoTimer = null;
        refreshVisible();
      }, delayMs);
    }

    /**
     * 刷新事务的**唯一入口**（事件与人工刷新都走这里）。
     * @returns {Promise<{committed:boolean, reason:string}>}
     *   `reason` ∈ `ok` | `busy` | `stale` | `cancelled` | `user` | `unreadable` | `no-root` | `error`
     */
    async function refreshVisible() {
      if (!root) return { committed: false, reason: 'no-root' };
      if (refreshing) { refreshPending = true; return { committed: false, reason: 'busy' } };
      // ⚠️ 输入行 / 新建在飞时**让路**：刷新会把整棵树换掉，输入行会跟着没，
      //    用户正在敲的名字就丢了（§2.1 C 的"刷新不得弄丢正在输入的名字"）。
      if (R.shouldDefer({ inputOpen: !!input, creating: creating > 0, running: false })) {
        refreshPending = true;
        return { committed: false, reason: 'busy' };
      }
      refreshing = true;
      refreshPending = false;
      let committed = false;
      /** 这一趟为什么没提交（`finally` 里据此决定要不要排补跑）。 */
      let why = 'ok';
      try {
        const r = await runRefresh();
        committed = r.committed;
        why = r.reason;
        // ⚠️ 没提交就**保留**待办：⛔ 不许把"没发生的事"记成"已刷新"。
        if (!r.committed) refreshPending = true;
        if (r.committed) autoRetries = 0;
        return r;
      } catch (e) {
        why = 'error';
        refreshPending = true;
        onError(e);
        return { committed: false, reason: 'error' };
      } finally {
        refreshing = false;
        // ⚠️ 只有"事务成功 + 期间又来过事件"才自动补跑一次。
        //    `busy`（输入行开着）/ 重试用尽的 `user` 都**不补跑**——
        //    否则输入行一开着就变成死循环，或用户连续展开变成无限重建。
        if (committed && refreshPending) {
          refreshPending = false;
          setTimeout(function () { refreshVisible(); }, 0);
        }
        // ⭐ `design/0050` 最终约束 4：`rev`（同一棵树、盘上又变了）**必须**有下一次。
        //    ⚠️ 排在这里而不是 `try` 里：`scheduleRetry` 看见 `refreshing` 会直接返回。
        if (!committed && why === 'rev') scheduleRetry(AUTO_RETRY_DELAY_MS);
      }
    }

    /** 事务本体：快照 → 离屏构建 → 复核 → 提交（或重试）。 */
    async function runRefresh() {
      const token0 = sessionToken;
      const gen0 = S.state.generation;
      let retries = 0;
      while (true) {
        if (token0 !== sessionToken) return { committed: false, reason: 'cancelled' };
        if (gen0 !== S.state.generation) return { committed: false, reason: 'stale' };
        const epoch0 = epoch;
        const version0 = expandVersion;
        // ⭐ `design/0050`：内容修订的**观测起点**。⚠️ 取在**构建之前**、
        //    比在**构建之后**——"这份内容描述的是哪个时刻的盘"只有这两个点之差能回答。
        const seq0 = DE.seq();
        const keep = Array.from(expanded);
        const anchor = captureAnchor();
        const focusPath = focusedPath();

        const det = document.createElement('div');
        const paths = [root].concat(keep.filter(function (p) { return p !== root; }));
        for (const p of paths) building.add(p);
        let built;
        try {
          built = await buildDetached(det, root, keep);
        } finally {
          // ⚠️ 必须**逐路径**删：事务跑的同时可能有别的层在活树上展开，
          //    整表 `clear()` 会把别人的让路标记一起抹掉。
          for (const p of paths) building.delete(p);
        }
        if (!built.ok) {
          // ⭐ `design/0050`：构建期间盘上又变了 ⇒ **不是读不出来**，是这一份内容过期了。
          //    ⚠️ 两件事的处置相反：`unreadable` 换上去就是一棵空树（必须保留旧树、⛔ 不重试），
          //    `rev` 必须重跑（保留旧树、**重试**）。⚠️ 合并的话，"外部改动"要么被当成
          //    读盘失败而**永远停在旧树上**，要么被当成可重试而对着一个真坏了的目录空转。
          if (built.reason === 'rev') {
            if (retries >= R.MAX_RETRIES) return { committed: false, reason: 'rev' };
            await sleep(R.RETRY_DELAY_MS);
            retries += 1;
            continue;
          }
          // ⚠️ 根层都读不出来 ⇒ **保留旧树**（换上去只会得到一棵空树）。
          return { committed: false, reason: 'unreadable' };
        }

        const d = R.decide({
          token: sessionToken, token0: token0,
          gen: S.state.generation, gen0: gen0,
          seq: DE.seq(), seq0: seq0,
          version: expandVersion, version0: version0,
          retries: retries,
        });
        if (d.action === 'commit') {
          commitRefresh(det, keep, built.keep, anchor, focusPath, epoch0);
          return { committed: true, reason: 'ok' };
        }
        if (!d.retry) return { committed: false, reason: d.reason };
        if (d.delayMs) await sleep(d.delayMs);
        retries += 1;
      }
    }

    /**
     * 离屏重建：根层 + 每个"当前展开着的目录"各列一层。
     * ⚠️ ⛔ **不调 `expand` / `renderLayer` 之外的任何界面动作**——
     *    这里既不发通知、也不动 `expanded` / `currentEl` / 滚动位置。
     * @returns {Promise<{ok:boolean, keep:string[]}>} `keep` 是**真的还展开得起来**的那些
     *   （读不出来的那层会被剔掉——提交后它该是收起的，⛔ 不能挂着一个空的展开态）
     */
    async function buildDetached(det, rootPath, keep) {
      // ⚠️⚠️ **`fresh` 必须是 `true`**（`design/0034` §2.1 A.3 第 3 步原文：「先 **fresh** 列根层；
      //    再对 `keep` 里…按浅→深 **fresh** 列它那一层」）。
      //    这个参数漏成 `false` 的表现是**整条刷新链静默失效**：后端 `TreeCache` 的键是
      //    `(代次, 路径)`，而"目录里多了一个文件"**不动代次** ⇒ 不 fresh 就命中旧层、
      //    离屏重建出**一模一样**的树，提交后界面上什么都没变（手动刷新同样没用）。
      //    2026-10-27 用户实测「其他程序在目录里加了一个文档，目录树里没展示」即此，
      //    日志铁证：每次刷新都是 `list_dir … 代次 2**·缓存**… 0.00 ms` 且条目数不变。
      const r0 = await fillLayer(det, rootPath, 0, true, false, true);
      if (!r0.ok) {
        // ⭐ `design/0050`：`rev` 要**原样报上去**（调用方据此重跑），⛔ 别并进
        //    "根层读不出来"——那条路会保留旧树**并且不再重试**，症状正是"外部改动不出现"。
        return { ok: false, keep: keep, reason: r0.reason === 'rev' ? 'rev' : 'unreadable' };
      }
      const dirs = R.sortShallowFirst(keep.filter(function (p) { return p !== rootPath; }));
      const dropped = [];
      for (const p of dirs) {
        const node = findNodeIn(det, p);
        if (!node || node.dataset.dir !== '1' || node.classList.contains('ignored')) {
          dropped.push(p);
          continue;
        }
        const depth = Number(node.dataset.depth) || 0;
        if (!V.depthAllowed(depth)) { dropped.push(p); continue; }
        node.classList.add('expanded');
        node._kids.style.display = '';
        const row = node.firstChild;
        if (row) row.setAttribute('aria-expanded', 'true');
        const r = await fillLayer(node._kids, p, depth + 1, true, false, true);
        if (!r.ok) {
          // ⭐ `design/0050`：某一层 `rev` ⇒ **整趟作废重跑**，⛔ 不许把这一层"剔掉"。
          //    剔掉的语义是"这个目录读不出来"（提交后它会收起），而真实原因只是
          //    "读到的这一份过期了"。⚠️ 静默收起一个用户展开着的目录，比不刷新更费解。
          if (r.reason === 'rev') return { ok: false, keep: keep, reason: 'rev' };
          node.classList.remove('expanded');
          node.classList.add('unreadable');
          node._kids.style.display = 'none';
          if (row) row.setAttribute('aria-expanded', 'false');
          dropped.push(p);
        }
      }
      // ⚠️ 被丢掉的那一层的后代也一并丢掉（父层都没展开，后代不可能出现在树里）
      const keep2 = keep.filter(function (p) {
        if (p === rootPath) return true;
        for (const q of dropped) {
          const prefix = q.endsWith('/') ? q : q + '/';
          if (p === q || p.indexOf(prefix) === 0) return false;
        }
        return true;
      });
      return { ok: true, keep: keep2 };
    }

    /**
     * 原子换树 + 记账 + 还回滚动锚点与焦点。
     * @param {string} epochAtBuild ⚠️ **构建开始时**的 epoch：这一份内容属于那一刻，
     *   ⛔ 不能记成"现在"（构建期间若又来过事件，这些层必须仍被视作旧的）。
     */
    function commitRefresh(det, prev, keep, anchor, focusPath, epochAtBuild) {
      cancelAppenders();
      host.textContent = '';
      while (det.firstChild) host.appendChild(det.firstChild);

      expanded.clear();
      for (const p of keep) expanded.add(p);
      // ⚠️ 只给**真的走到了**的目录挂展开态（`keep` 已剔掉读不出来的那些）。
      const all = host.querySelectorAll('.node');
      for (const n of all) {
        const p = n.dataset.path;
        if (n.dataset.dir !== '1' || !expanded.has(p) || n.classList.contains('ignored')) continue;
        n.classList.add('expanded');
        n._kids.style.display = '';
        const row = n.firstChild;
        if (row) row.setAttribute('aria-expanded', 'true');
      }
      // ⭐ 记账：这些层的**内容**是 `epochAtBuild` 那一刻取回来的。
      //    ⚠️ 根层也记：`showRoot` 用的是同一个 `layerEpoch`。
      for (const p of expanded) layerEpoch.set(p, epochAtBuild);
      layerEpoch.set(root, epochAtBuild);

      // ⚠️ 旧节点全走了，`currentEl` 是一条悬空的引用；当前项由调用方
      //    （`main.js` 收到 `committed` 之后）按 `state.currentPath` 重新挂。
      currentEl = null;

      // —— 滚动锚点：同一行还在就对齐那一行，否则退到最近的祖先 ——
      // ⚠️ `null` = 没有可用的锚（或一个都没活下来）⇒ **什么都不做**，
      //    让浏览器按内容长度自己夹取。⛔ 不许"回到顶部"。
      if (anchor) {
        const delta = R.restoreOffset(anchor, measureRows(host), host.getBoundingClientRect().top, R.parentOf);
        if (delta != null) host.scrollTop += delta;
      }
      // —— 焦点：原来那一行还在就还回去（⛔ 不抢：不在就不动）——
      if (focusPath) {
        const n = findNode(focusPath);
        const row = n && n.firstChild;
        if (row) {
          try { row.focus({ preventScroll: true }); } catch (e) { row.focus(); }
        }
      }
      // ⚠️ 展开集合**真的变了**才通知写者：一次刷新通常什么都没变，
      //    每次都通知等于每次事件都写一遍 `dir_sessions`（§2.1 A.3）。
      if (!samePaths(prev, keep)) notifyState();
    }

    /** 两个路径集合是否相同（⚠️ 只比成员，不比顺序）。 */
    function samePaths(a, b) {
      if (a.length !== b.length) return false;
      const s = new Set(a);
      for (const p of b) if (!s.has(p)) return false;
      return true;
    }
    /** 当前项高亮。⚠️ **至多一个**：先摘旧的，再挂新的。 */
    function setCurrent(realPath) {
      if (currentEl) { currentEl.classList.remove('current'); currentEl = null; }
      if (!realPath) return;
      const el = findNode(realPath);
      if (el) {
        el.classList.add('current');
        currentEl = el;
      }
    }

    function findNode(path) { return findNodeIn(host, path); }

    /** 在**指定容器**里按路径找节点（刷新事务的离屏树用）。 */
    function findNodeIn(container, path) {
      // ⚠️ 用 `dataset` 比对而不是拼 CSS 选择器：路径里可能有引号、空格、Emoji，
      //    拼进选择器要么炸要么匹配错（那是**猜测**，`INV-TREE-01` 禁止）。
      const all = container.querySelectorAll('.node');
      for (const n of all) if (n.dataset.path === path) return n;
      return null;
    }

    /**
     * 作废 `parentPath` 这一层再重列，然后在里面找 `childPath`。
     *
     * ⭐ 这是 `design/0009` §2.1 ⑤ 那张表的第三行：**索引刚重建过，
     * 而某一层的树缓存是更早的**（缓存键 =（代次, 单层路径），
     * 而"目录里多了个文件"**不会**让代次动）⇒ 那一层看不到这个新文件。
     * ⇒ 作废它、重列一次。
     *
     * ⚠️ **只重试一次**（⛔ 不循环）：真的是"文件不存在"时，循环重列
     * 会把一次定位失败变成 N 次全目录读盘。
     *
     * @param {HTMLElement|null} parentNode 父目录节点；`null` = 这一层是**根层**
     * @param {number} childDepth 子项算第几层
     */
    async function relistAndFind(parentNode, parentPath, childDepth, childPath) {
      // ⭐ `design/0034`：整层换掉 = 用户可见的树变了（刷新事务要据此让路/重试）。
      bumpVersion();
      // ⚠️ 顺序：**先停分片、再清容器**（与 `expand` 的 `fresh` 那一支同一条理由）
      forgetDescendants(parentPath);
      if (parentNode) {
        const container = parentNode._kids;
        stopAppenders(container);
        container.textContent = '';
        await fillLayer(container, parentPath, childDepth, true);
      } else {
        // 根层那一格：整棵树重列一次。⚠️ **展开状态会一并没掉**——
        // 这是可见的（树回到只展开根的样子），而且只在"索引刚建、根下刚多了文件"
        // 时才会走到；⛔ 比"静默地定位不到"好。
        cancelAppenders();
        expanded.clear();
        failed.clear();
        currentEl = null;
        host.textContent = '';
        await fillLayer(host, parentPath, 0, true);
      }
      return findNode(childPath);
    }

    /**
     * 展开祖先链并滚动到可见位置（§2.1「当前项的呈现」）。
     *
     * ⭐ **返回值在 `design/0009` §2.1 ⑤ 里被加厚过一次**：
     * 原来只回 `true/false`（"在这棵树里找到了吗"），现在回
     * `{ok, reason}`——因为"定位不到"有**四种不同的原因**，而它们的出路不同：
     * 层级过深（降级：正文照开 + 说到明处）、这一层读不出来、父链断在缓存里、
     * 以及路径根本不在这棵树的范围里。⛔ 一个 `false` 全都说不清。
     *
     * @returns {Promise<{ok:boolean, reason:string|null}>}
     *   `reason` ∈ `outside` | `missing` | `missing-parent` | `not-a-dir`
     *            | `too-deep` | `unreadable` | `stale`（后四个是 `expand` 透传的）
     */
    async function revealPath(realPath) {
      if (!root || !isInside(root, realPath)) return { ok: false, reason: 'outside' };
      if (realPath === root) return { ok: true, reason: null };
      const segs = splitPath(realPath);
      const rootSegs = splitPath(root);
      const rel = segs.slice(rootSegs.length);

      let curPath = root;
      let parentNode = null;   // 根层的子项**没有** `.node`（它们直接挂在 `host` 上）
      let depth = 0;
      for (let i = 0; i < rel.length; i++) {
        const childPath = curPath + '/' + rel[i];
        const last = i === rel.length - 1;
        let node = findNode(childPath);
        if (!node) node = await relistAndFind(parentNode, curPath, i, childPath);
        if (!node) return { ok: false, reason: last ? 'missing' : 'missing-parent' };
        if (last) {
          setCurrent(childPath);
          node.scrollIntoView({ block: 'nearest' });
          return { ok: true, reason: null };
        }
        if (node.dataset.dir !== '1') return { ok: false, reason: 'not-a-dir' };
        if (!expanded.has(childPath)) {
          const r = await expand(node, childPath, depth, false);
          if (!r.shown) return { ok: false, reason: r.reason };
        }
        curPath = childPath;
        parentNode = node;
        depth += 1;
      }
      return { ok: false, reason: 'missing' };
    }

    /**
     * ⭐ **按记录把树展开回原样**（`design/0020` §2.3 ③(b)）。
     *
     * # 四条纪律
     *
     * 1. **由浅到深**：`dirsession.js::restorePlan` 已经排好序（祖先必在后代之前），
     *    这里 ⛔ 不再排——那是第二份判据。某层的节点找不到，就是"它不在了"。
     * 2. **静默跳过**：目录被删 / 改名 / 变文件 / 在忽略清单里 ⇒ 只计数，
     *    ⛔ **不调 `note()`**。理由：用户看到的是一棵"少了一层"的树，
     *    而他并没有请求任何东西——把三条"这份目录已经变样了"的灰字堆上去
     *    是在解释一个他没问的问题。
     * 3. **每步前查一次 `shouldContinue()`**：恢复可能被切根 / 被用户打开文件作废，
     *    ⛔ 不能靠"反正后端会拒"来收尾（那会让 DOM 继续长一棵已经不存在的树）。
     * 4. **不动当前项**：`setCurrent` 由调用方在恢复完成后按 `state.currentPath`
     *    单独做（`revealInTree`），这里 ⛔ 不抢那个职责。
     *
     * @param {string[]} paths 要展开的目录（已按浅→深排好）
     * @param {() => boolean} [shouldContinue] 每一步之前问一次；`false` ⇒ 立刻收手
     * @returns {Promise<{restored:number, skipped:number, cancelled:boolean}>}
     */
    async function restoreExpanded(paths, shouldContinue) {
      const cont = typeof shouldContinue === 'function' ? shouldContinue : function () { return true; };
      const list = Array.isArray(paths) ? paths : [];
      let restored = 0;
      let skipped = 0;
      // ⭐ `design/0034`：按记录展开是"树变了"（刷新事务据此重试）。
      bumpVersion();

      // ⚠️ `restoring` 期间 `expand` 里的 `notifyState()` 全被抑制：
      //    这次展开**不是用户改的树**，写回它只会让"恢复"和"写盘"互相追尾。
      restoring = true;
      try {
        for (let i = 0; i < list.length; i++) {
          if (!cont()) return { restored: restored, skipped: skipped, cancelled: true };
          const path = list[i];
          const node = typeof path === 'string' && path ? findNode(path) : null;
          // 不在树里（父层没展开 / 这一项不在了）/ 不是目录 / 在忽略清单里 ⇒ 跳过
          if (!node || node.dataset.dir !== '1' || node.classList.contains('ignored')) {
            skipped += 1;
            continue;
          }
          if (expanded.has(path)) { restored += 1; continue; }
          const depth = Number(node.dataset.depth) || 0;
          if (!V.depthAllowed(depth)) { skipped += 1; continue; }
          const r = await expand(node, path, depth, false);
          if (r && r.shown) restored += 1;
          else skipped += 1;
        }
        return { restored: restored, skipped: skipped, cancelled: false };
      } finally {
        restoring = false;
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ⭐ `design/0034` §2.1 C：右键菜单与就地输入
    //
    // ⚠️ 菜单是**网页里的一层**（⛔ 不是原生菜单）：与 `0009` 的浮层同族，
    //    可以在离屏探针里验；而原生菜单一弹就是系统窗口（根约定 §4 不许抢）。
    // ⚠️ 输入行是**就地**的（⛔ 不用 `window.prompt`：本项目没有 `dialog:*` 权限）。
    // ─────────────────────────────────────────────────────────────────────

    /** 右键落在哪、能不能建，全部交给纯逻辑那张真值表（`treerefresh.js`）。 */
    function onContextMenu(e) {
      // ⚠️ 没有根（未打开目录 / 未授权）⇒ **不拦截**：让系统菜单出现，
      //    比弹一个什么都不能点的自制菜单更诚实。
      if (!root) return;
      e.preventDefault();
      const el = e.target && e.target.closest ? e.target.closest('.node') : null;
      const hit = el && host.contains(el)
        ? {
          path: el.dataset.path,
          isDir: el.dataset.dir === '1',
          ignored: el.classList.contains('ignored'),
        }
        : null;
      const target = R.resolveMenuTarget(hit, root);
      closeMenu();
      // ⚠️ 忽略清单里的目录 / 不在树里的行：⛔ 不给菜单（那里本来就不能建）。
      if (!target) return;
      openMenu(e.clientX, e.clientY, target, hit);
    }

    host.addEventListener('contextmenu', onContextMenu);

    /** 编辑器状态（`renameTarget` 的 `st`）。⚠️ 路径真值仍取 `S.state.currentPath`。 */
    function editorState() {
      const e = getEditorState();
      return { editing: !!(e && e.editing === true), current: S.state.currentPath };
    }

    /**
     * ⭐ 「复制绝对路径」（`design/0035` §2.2–§2.4）。**纯前端**动作，⛔ 不碰后端。
     *
     * ⚠️ 成功提示在 `copy()` **resolve 之后**才出（`writeText` 是异步的）
     * ——先报"已复制"再 catch 就是假报（§2.4）。
     * ⚠️ 三类失败各说各的（能力缺失 / 被拒 / 其他），⛔ 一律静默或一律"失败"都不行。
     */
    function copyAbsolutePath(path) {
      const copier = CLIP.defaultCopier();
      copier.copy(path).then(function (r) {
        if (r && r.ok) flash(t('tree.copy.ok'));
        else note(t(R.copyFailKey(r && r.reason)));
      }).catch(function () {
        // ⚠️ 只有真正发生异常才走到这里（能力缺失在 `copy()` 里已经变成 `unsupported`）
        note(t('tree.copy.failed'));
      });
    }

    /**
     * ⭐ 「在访达中显示」（`design/0048`）。⛔ **不判路径、不判类型**，只把树里那一行交给后端；
     * 授权校验、`is_dir` 的判定、`/usr/bin/open` 的派发全在 `commands::fs::reveal_entry`。
     *
     * ⚠️ **成功不说话**：访达自己会浮到前台，那就是反馈。只有失败才在树顶灰字里说一句
     * （`open` 被拒、路径在授权外、条目刚被删掉）。
     * ⚠️ 失败文案⛔ 不复用「复制失败」——那是另一件事（`tree.reveal.failed` 单独一条）。
     */
    function revealInFinder(path) {
      S.revealEntry(path).then(function () {
        // 成功：什么都不做（⛔ 别 flash "已打开"，那句话会盖住访达带来的视觉反馈）。
      }).catch(function () {
        note(t('tree.reveal.failed'));
      });
    }

    /**
     * ⭐ 菜单的**骨架只有一份**（`design/0043` / `design/0044`）：树行右键、根头 `⋯`、
     * 根头右键都调它，只换"往里面塞哪些项"。
     *
     * @param {number} x
     * @param {number} y
     * @param {function(Function, HTMLElement):void} build 收到 `addItem` 与菜单容器
     * @param {{returnFocus?:function():void}} [extra] `returnFocus` = `Escape` 时把焦点还给谁
     */
    function showMenu(x, y, build, extra) {
      const menu = document.createElement('div');
      menu.className = 'tree-menu';
      menu.setAttribute('role', 'menu');

      /**
       * @param {string} key 文案键
       * @param {Function} fn 点下去做什么
       * @param {boolean} [disabled]
       * @param {string} [titleKey] 置灰时那句 `title`（出路；`design/0035` §3.1）
       */
      const addItem = function (key, fn, disabled, titleKey) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tree-menu-item';
        b.setAttribute('role', 'menuitem');
        b.tabIndex = -1;
        setSpec(b, 'textContent', key);
        // ⚠️ 也走 `setSpec`：切语言时这句 `title` 要跟着重贴（`specNodes` 那套）
        if (titleKey) setSpec(b, 'title', titleKey);
        if (disabled) {
          b.disabled = true;
          b.classList.add('disabled');
        } else {
          b.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            closeMenu();
            fn();
          });
        }
        menu.appendChild(b);
      };

      build(addItem, menu);

      // ⚠️ 先挂上再量（不挂就没有布局盒，量出来是 0×0）
      menu.style.left = '0px';
      menu.style.top = '0px';
      document.body.appendChild(menu);
      const box = menu.getBoundingClientRect();
      const left = Math.max(4, Math.min(x, window.innerWidth - box.width - 4));
      const top = Math.max(4, Math.min(y, window.innerHeight - box.height - 4));
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';

      menuEl = menu;
      const returnFocus = extra && extra.returnFocus;
      const onDown = function (ev) { if (!menu.contains(ev.target)) closeMenu(); };
      const onKey = function (ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          closeMenu();
          // ⭐ `design/0044` §2.4：根头的菜单关掉之后焦点要**回到根头**（否则掉到 `body`）。
          if (typeof returnFocus === 'function') returnFocus();
        }
      };
      const onScroll = function () { closeMenu(); };
      const onResize = function () { closeMenu(); };
      const onBlur = function () { closeMenu(); };
      // ⚠️ 延迟一拍再挂监听：打开菜单的那次事件（及其同族的 `mousedown`）
      //    还没走完，立刻挂会被自己关掉。
      setTimeout(function () {
        if (menuEl !== menu) return;
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        window.addEventListener('blur', onBlur);
      }, 0);
      menuCleanup = function () {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('blur', onBlur);
      };
    }

    function openMenu(x, y, target, hit) {
      // ⚠️ 输入行开着时「刷新」不可点：刷新会把整棵树（连同输入行）换掉。
      const busy = R.manualDisabled({ inputOpen: !!input, creating: creating > 0 });
      const sep = function (menu) {
        const el = document.createElement('div');
        el.className = 'tree-menu-sep';
        menu.appendChild(el);
      };
      showMenu(x, y, function (addItem, menu) {
        addItem('tree.menu.new-file', function () { openInput(target.dir, 'file'); });
        addItem('tree.menu.new-folder', function () { openInput(target.dir, 'dir'); });

        // ── `design/0035`：这两项**各自独立**的可见性表（⛔ 不从新建那张表反推）──
        const copyPath = R.copyTarget(hit, root);
        const ren = R.renameTarget(hit, root, editorState());
        // ── `design/0048`：文件行与目录行**都有**这一项（分流在后端按规范路径判）──
        const rv = R.revealTarget(hit, root);
        // ── `design/0043`：🔖 只给**真实的行**（根自己走根头，⛔ 不在空白处重复一遍）──
        const favPath = hit && hit.path ? hit.path : null;
        if (copyPath || rv || ren || favPath) sep(menu);
        if (copyPath) {
          addItem('tree.menu.copy-path', function () { copyAbsolutePath(copyPath); });
        }
        if (rv) {
          addItem('tree.menu.reveal', function () { revealInFinder(rv.path); });
        }
        if (favPath) {
          addItem(isFavorite(favPath) ? 'tree.menu.unfavorite' : 'tree.menu.favorite',
            function () { onToggleFavorite(favPath); });
        }
        if (ren) {
          addItem(
            'tree.menu.rename',
            function () { openInput(null, 'file', { action: 'rename', from: ren.path }); },
            ren.disabled,
            ren.disabled ? 'tree.menu.rename.disabled-editing' : ''
          );
        }

        sep(menu);
        addItem('tree.menu.refresh', function () { manualRefresh(); }, busy);
      });
    }

    /**
     * ⭐ **根头的菜单**（`design/0044` §2.4，`INV-ROOT-02`）。
     *
     * ⚠️ 白名单：新建文件 / 新建文件夹 / 复制路径 / 收藏（`0043`）/ 刷新。
     *    ⛔ 不出现重命名、⛔ 不出现移到废纸篓——在工作区根上做那两件事，
     *    会话 / 授权 / 监视三处身份会一起失效。
     * ⚠️ 与树行右键**共用** `showMenu` 那一段（⛔ 不复制一份菜单骨架）。
     *
     * @param {number} x
     * @param {number} y
     * @param {{returnFocus?:function():void}} [extra]
     */
    function openRootMenu(x, y, extra) {
      if (!root) return;
      const base = root;
      // ⚠️ 输入行开着时「刷新」不可点：同 `openMenu`，刷新会把输入行一起换掉。
      const busy = R.manualDisabled({ inputOpen: !!input, creating: creating > 0 });
      showMenu(x, y, function (addItem, menu) {
        addItem('tree.menu.new-file', function () { openInput(base, 'file'); });
        addItem('tree.menu.new-folder', function () { openInput(base, 'dir'); });
        const el = document.createElement('div');
        el.className = 'tree-menu-sep';
        menu.appendChild(el);
        addItem('tree.menu.copy-path', function () { copyAbsolutePath(base); });
        // ⭐ `design/0048`：根就是一个目录 ⇒ 与目录行同一件事（`open <dir>`，⛔ 不是 `-R`）。
        addItem('tree.menu.reveal', function () { revealInFinder(base); });
        addItem(isFavorite(base) ? 'tree.menu.unfavorite' : 'tree.menu.favorite',
          function () { onToggleFavorite(base); });
        const el2 = document.createElement('div');
        el2.className = 'tree-menu-sep';
        menu.appendChild(el2);
        addItem('tree.menu.refresh', function () { manualRefresh(); }, busy);
      }, extra);
    }

    function closeMenu() {
      if (menuCleanup) { menuCleanup(); menuCleanup = null; }
      if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
      menuEl = null;
      // ⚠️ `specNodes` 里那几条由 `relabelTree` 按 `isConnected` 自己清，⛔ 不手动摘。
    }

    /**
     * 就地输入行（`design/0034` §2.1 C；⭐ `design/0035` §3.2 起**参数化**）。
     *
     * 两种用法（⛔ 不是两条实现——提交 / 取消 / 组合态 / 失败保留，全部共用下面这一段）：
     * - **新建**：`openInput(dir, 'file'|'dir')`，插在该层**最前面**，全选默认名；
     * - **重命名**：`openInput(null, 'file', { action:'rename', from })`，插在**那一行之前**，
     *   初值是当前文件名，**只选主名**（`.md` 留在选区外，§3.2 的取舍）。
     *
     * @param {string|null} dir 新建落在哪一层（重命名时 ⛔ 不用，传 `null`）
     * @param {'file'|'dir'} kind
     * @param {{action?:'rename', from?:string}} [opt]
     * @returns {{action,dir,from,kind,row,el,err,busy,token}|undefined}
     */
    function openInput(dir, kind, opt) {
      if (!root) return undefined;
      const o = opt || {};
      const renaming = o.action === 'rename';

      let container = null;
      let anchor = null;   // `null` = 插到层首（新建）；否则插在这一行**之前**（重命名）
      if (renaming) {
        const node = typeof o.from === 'string' && o.from ? findNode(o.from) : null;
        // ⚠️ 行不在树上（换根 / 外部刷新）⇒ 不开输入行：那等于对着一个已经不存在的对象改名
        if (!node || !node.parentNode) return undefined;
        container = node.parentNode;
        anchor = node;
      } else {
        const isRootLayer = dir === root;
        const parentNode = isRootLayer ? null : findNode(dir);
        container = isRootLayer ? host : (parentNode && parentNode._kids);
        if (!container) return undefined;
        // ⚠️ 目标目录必须真的展开着：不可见的层里插一行输入等于什么都没发生。
        if (parentNode && !expanded.has(dir)) return undefined;
      }

      // ⚠️ 已有输入行 ⇒ 先取消它（⛔ 不并排开两个；也⛔ 不把它静默留在那里）
      if (input) closeInput(true);

      const row = document.createElement('div');
      row.className = 'tree-input-row';
      const icon = document.createElement('span');
      icon.className = 'node-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.appendChild(svgIcon(kind === 'dir' ? 'folder' : 'file'));
      row.appendChild(icon);
      const el = document.createElement('input');
      el.type = 'text';
      el.className = 'tree-input';
      el.spellcheck = false;
      el.autocomplete = 'off';
      // ⚠️ **完整**字典键三选一，⛔ 不拼 `'tree.menu.' + …`——
      //    `i18n.test.js` 的「零 `t('…' + …)` 拼接调用」管的就是这条
      //    （拼出来的键既查不到、又没法逐条翻译）。
      el.setAttribute('aria-label', t(renaming
        ? 'tree.menu.rename'
        : (kind === 'dir' ? 'tree.menu.new-folder' : 'tree.menu.new-file')));
      row.appendChild(el);
      const err = document.createElement('div');
      err.className = 'tree-error';
      err.hidden = true;
      row.appendChild(err);

      // ⚠️ 新建插在这一层**最前面**（新条目就在用户右键的那个位置附近）；
      //    重命名插在**那一行之前**（视觉上"替换"它，而不是跑到层顶去）
      container.insertBefore(row, anchor || container.firstChild);

      const st = {
        action: renaming ? 'rename' : 'create',
        dir: renaming ? null : dir,
        from: renaming ? o.from : null,
        kind: kind,
        row: row,
        el: el,
        err: err,
        busy: false,
        token: sessionToken,
      };
      input = st;
      if (renaming) {
        // ⭐ 初值 = 当前文件名（含 `.md`）；只选主名（§3.2：⛔ 别让人一敲就把后缀打掉）
        const base = R.baseName(o.from);
        el.value = base;
        el.focus();
        const sel = R.selectStem(base);
        try { el.setSelectionRange(sel.start, sel.end); } catch (e) { el.select(); }
      } else {
        el.value = t(kind === 'dir' ? 'tree.default-folder-name' : 'tree.default-file-name');
        // ⭐ 全选默认名：用户一敲就替换（⛔ 让人先手动删三下）
        el.focus();
        el.select();
      }
      try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 离屏探针里没有滚动容器 */ }

      el.addEventListener('keydown', function (ev) {
        const a = R.inputAction(ev);
        if (a === 'ignore' || a === 'composing') return;
        ev.preventDefault();
        // ⚠️ Enter 与 Escape 都**不许穿到树容器**上去（否则 Enter 会再点一次行）。
        ev.stopPropagation();
        if (a === 'submit') submitInput();
        else closeInput(true);
      });
      el.addEventListener('input', function () { err.hidden = true; });
      // ⚠️ 失焦 = 取消。⚠️ 但**提交在飞**时不许取消（那会把收尾吃掉）。
      //    ⚠️ 延后一拍：点菜单 / 切窗口时焦点先走、点击后到，立刻关会让点击落空。
      el.addEventListener('blur', function () {
        setTimeout(function () {
          if (input === st && !st.busy) closeInput(true);
        }, 0);
      });
      return st;
    }

    /** 收起输入行。⚠️ `cancelled` 时若还有被让路的刷新，补跑一次。 */
    function closeInput(cancelled) {
      const st = input;
      if (!st) return;
      input = null;
      if (st.row && st.row.parentNode) st.row.parentNode.removeChild(st.row);
      if (cancelled && refreshPending) {
        setTimeout(function () { refreshVisible(); }, 0);
      }
    }

    /**
     * 提交输入行。⭐ **不在这里校验名字**：空 / 分隔符 / 点开头 / 忽略目录 /
     * 过长 / 重名，全部由后端 `fs/create.rs::validate_name` 一份判据回答
     * （`INV-TREE-07`）。前端只负责"提交 / 取消 / 把原因显示出来"。
     *
     * ⭐ `design/0035` §3.2：重命名**复用同一条路**（幂等、组合态、失败保留），
     * 只有两处不同——命令与成功后的收尾。
     */
    async function submitInput() {
      const st = input;
      if (!st || st.busy) return;   // ⚠️ 双击 Enter / 连点 = **只发一次**
      st.busy = true;
      // ⚠️ 这个计数在刷新事务里叫"有新建在飞"（`shouldDefer`），改名同样要让它让路：
      //    重列那一层会把输入行换掉。⇒ 共用这一个计数，⛔ 不另开第二个。
      creating += 1;
      st.row.classList.add('busy');
      st.el.readOnly = true;
      st.err.hidden = true;
      let done = null;
      try {
        done = st.action === 'rename'
          ? await S.renameEntry(st.from, st.el.value)
          : await S.createEntry(st.dir, st.el.value, st.kind);
      } catch (e) {
        if (input === st) {
          st.busy = false;
          st.row.classList.remove('busy');
          st.el.readOnly = false;
          // ⭐ 失败**保留输入行与内容**（改一个字符就能重试）
          st.err.hidden = false;
          st.err.textContent = R.errorText(e, t);
          st.el.focus();
          st.el.select();
        }
        return;
      } finally {
        creating -= 1;
      }
      // ⚠️ 提交期间切了根 ⇒ 这一行已经不在那棵树里了，⛔ 别对着新树做收尾。
      if (input !== st) return;
      closeInput(false);
      if (st.action === 'rename') await afterRename(st.from, done);
      else {
        // ⭐ `design/0041` R4：**空目录的临时例外**必须赶在父层重列**之前**记下——
        //    否则这一轮 `filterEntries` 已经把它藏掉，用户看不见刚建的那个目录，
        //    也就进不去建第一份 md。
        // ⚠️ 只有**目录**要这条：文件本来就不参与"空目录"判据（后端索引只收 `.md`，
        //    但**文件夹本身**才是会被判据藏起来的那一类）。
        if (st.kind === 'folder') {
          try { onCreated(done.path); } catch (e) { /* 记账出错不该让新建失败 */ }
        }
        await afterCreate(st.dir, done.path);
      }
      // ⚠️ 输入期间被让路的刷新现在补上（⛔ 别把没提交的记成已刷新）
      if (refreshPending) refreshVisible();
    }

    /**
     * 新建成功之后：**重列父层** → 把原来展开着的后代展开回去 → 焦点/滚动到新行。
     * ⚠️ ⛔ **不打开文档**、⛔ 不 `setCurrent`：用户要的是"在树里多一项"，
     *    不是"跳到那份空文档上"。
     */
    async function afterCreate(parentPath, createdPath) {
      const token0 = sessionToken;
      bumpVersion();
      const desc = R.descendants(expanded, parentPath);
      forgetDescendants(parentPath);
      const isRootLayer = parentPath === root;
      const parentNode = isRootLayer ? null : findNode(parentPath);
      const container = isRootLayer ? host : (parentNode && parentNode._kids);
      if (!container) { refreshPending = true; return; }
      // ⚠️ 先停分片、再清容器（与 `expand` 的 `fresh` 那一支同一条理由）
      stopAppenders(container);
      container.textContent = '';
      // ⚠️ `fresh=true`：刚落盘的那一项必须真的从盘上读回来
      //    （后端那一层缓存是新建**之前**的，树里会看不到它）。
      const r = await fillLayer(container, parentPath, depthInRoot(parentPath) + 1, true, true, false);
      if (token0 !== sessionToken) return;
      if (!r.ok) {
        if (r.reason === 'unreadable') {
          const why = (r.error && (r.error.wording || r.error.message)) || '';
          if (why) appendNote(container, 'tree.layer-unreadable', { msg: why });
          else appendNote(container, 'tree.layer-unreadable-nomsg');
          onError(r.error);
        }
        // ⚠️ 没重列成功 ⇒ 保留待办，让下一次事件/人工刷新把它补上
        refreshPending = true;
        return;
      }
      if (desc.length) {
        await restoreExpanded(desc, function () { return token0 === sessionToken; });
      }
      if (token0 !== sessionToken) return;
      const n = findNode(createdPath);
      const row = n && n.firstChild;
      if (row) {
        try { row.focus({ preventScroll: true }); } catch (e) { row.focus(); }
        try { row.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 离屏探针 */ }
      }
      // ⚠️ 不 `notifyState()`：`expanded` 集合经过 forget + restore 之后**净变化为零**，
      //    通知出去就是一次假写盘（`design/0020` 的同一条纪律）。
    }

    /**
     * ⭐ 改名成功之后（`design/0035` §3.5 的"前端层缓存"那一行）。
     *
     * 复用 `afterCreate` 的"重列一层 ＋ 恢复展开 ＋ 滚动到目标行"——改名**不换目录**，
     * 所以父层不变，需要重列的正是它。⛔ 不整树重建：用户可能滚在很深的位置。
     *
     * ⚠️ 当前文档身份（`currentPath` / `watchSeq`）已经由 `session.renameEntry`
     * 迁好了（那是**状态真值**，⛔ 不在这里改第二遍）；这里只补树上的那点：
     * 重列会把节点整个换掉，`current` 高亮得重新挂。
     *
     * ⚠️ `degraded` 非空 ⇒ 改名**已经成功**，只是某一半降级（§3.6）：
     * 用树顶那行灰字说出来，⛔ 不弹错误、⛔ 不说"改名失败"。
     *
     * @param {string} oldPath
     * @param {{path:string, current_moved:boolean, degraded:string[]}} res
     */
    async function afterRename(oldPath, res) {
      const token0 = sessionToken;
      const parentPath = R.parentOf(oldPath) || root;
      await afterCreate(parentPath, res.path);
      if (token0 !== sessionToken) return;
      // ⚠️ 高亮取**重列完成这一刻**的当前文档（`R.highlightRenamed`），
      //    ⛔ 不盲信回包里的历史 `current_moved`：等待父层重列期间用户可能
      //    已经打开了另一份文档（`design/0035` §10.6）。重列失败时 `findNode`
      //    是 `null`，`setCurrent` 自己会跳过——写出来是为了让"重列失败"
      //    不被误读成"改名没生效"。
      if (R.highlightRenamed(S.state.currentPath, res.path)) setCurrent(res.path);
      const keys = R.degradedKeys(res.degraded);
      if (keys.length) {
        const lines = [];
        for (let i = 0; i < keys.length; i++) lines.push(t(keys[i]));
        note(lines.join(' '));
      }
    }

    /**
     * ⭐ 树里**展开的目录**（`design/0020`：写者算载荷时读它）。
     * ⚠️ 返回的是一份**取值时刻的快照**（数组）——写者可能跨 `await` 用它，
     * 而 `expanded` 是活对象，直接遍历会读到"半路又被用户改了一次"的中间态。
     */
    function expandedPaths() { return Array.from(expanded); }

    /**
     * ⭐ 树顶上那行灰字（`design/0009` §2.1 ⑤ 的"可见降级"，`INV-SEARCH-07`）。
     *
     * ⚠️ 为什么要有这么一个口子：`revealPath` 失败时**树自己没有变化**
     * （没有新节点、没有红字），而正文那边**照常打开了**——
     * 用户看到的是"浮层关了、文档出来了、树一动不动"，
     * 那与"这个文件本来就不在这棵树里"**长得一模一样**。
     *
     * ⚠️ 只写**一份**：每次替换上一次那条（⛔ 不往 `host` 里越堆越多，
     * 树本来就有"展开越多、页面越长"的问题）。
     * ⛔ 用 `textContent`（路径与文件名是用户数据，⛔ 不拼 `innerHTML`）。
     *
     * @returns {number} 这一句的序号（`flash` 用它判断"期间有没有被别的句子顶掉"）
     */
    function note(text) {
      noteSeq += 1;
      if (!text) {
        if (revealNote && revealNote.parentNode) revealNote.parentNode.removeChild(revealNote);
        revealNote = null;
        return noteSeq;
      }
      if (!revealNote) {
        revealNote = document.createElement('div');
        revealNote.className = 'note note-reveal';
        host.insertBefore(revealNote, host.firstChild);
      }
      revealNote.textContent = text;
      return noteSeq;
    }

    /**
     * 一句**会自己消失**的灰字（`design/0035` §2.4：复制成功的反馈）。
     *
     * ⚠️ 与 `note()` 共用那一行，但**只清自己那一句**：期间来了别的话（定位失败、
     * 改名降级）⇒ 序号变了，定时器什么都不做（⛔ 别把别人的话顺手抹掉）。
     */
    function flash(text, ms) {
      if (!text) return;
      const seq = note(text);
      setTimeout(function () {
        if (seq === noteSeq) note('');
      }, typeof ms === 'number' && ms > 0 ? ms : 2500);
    }

    return {
      reset,
      showRoot,
      /** ⭐ `design/0044`：根头的菜单入口（`⋯` 与根头右键共用；⛔ 不另造一份动作清单）。 */
      openRootMenu,
      setCurrent,
      revealPath,
      /** ⭐ `design/0020`：按记录展开回原样（恢复事务的唯一树操作入口）。 */
      restoreExpanded,
      /** ⭐ `design/0020`：展开集合的**快照**（写者算载荷用）。 */
      expandedPaths,
      /** ⭐ `design/0009`：定位失败的**唯一**可见出口（见上方 `note` 的注释）。 */
      note,
      /** ⭐ `design/0034`：`rmd://tree-changed` 的唯一落点（后端载荷为空）。 */
      noteTreeChanged,
      /** ⭐ `design/0034`：刷新事务的唯一入口（人工刷新也走它）。 */
      refreshVisible,
      expanded,
      failed,
      cancelAppenders,
      nodeCount: function () { return host.querySelectorAll('.node').length; },
      ignoredCount: function () { return host.querySelectorAll('.node.ignored').length; },
      currentCount: function () { return host.querySelectorAll('.node.current').length; },
    };
  }

  // ⭐ `design/0044`：**导出**是因为根头（`Sidebar.js`）要用同一个图标——
  //    ⛔ 别为了它再画一份 `<svg>`（两种写法迟早不一样）。
  const api = { createFileTree, isInside, safeName, svgIcon };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).fileTree = api;
})();
