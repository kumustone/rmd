// Tauri IPC 的**唯一**封装层。
//
// # 为什么要包一层
//
// 三件事，每件单看都很小，散在各处就会写歪：
//
// 1. **`window.__TAURI__` 的形状**：`withGlobalTauri` 注入的是 `__TAURI__.core.invoke`，
//    而有些版本/配置下是 `__TAURI__.invoke`。两处都试，让"形状变了"表现成一句人话，
//    ⛔ 而不是 `undefined is not a function`（那种报错会让人去查业务逻辑）。
// 2. ⭐ **`Denied` 的归一化**：后端的拒绝（**7 类**）走的是 Tauri 的 reject 通道，
//    形状是 `{kind, path, message, …}`。⛔ `not_authorized`（→"未授权其所在目录"）与
//    `not_found`（→"文件不存在"）**必须能区分**：用词错了会把我们的安全策略说成 bug
//    （`0003` §7 步骤 18）。
//    ⚠️ **这段原本写的是"四类"，是错的**（2026-10-16 更正）：`0003` 时确实只有四类
//    （`not_authorized`/`not_found`/`stale`/`io`），但 `0006` 加了 `no_document`、
//    `0012` 加了 `conflict`/`save_in_flight`，**这份注释没跟着走**。
//    ⚠️ 后果不止是注释旧：那张「拒绝 → 人话」的表**也没跟着走**，
//    `no_document` 缺了整半年 ⇒ 界面上显示成「操作失败」（`docs/bugs/0005`）。
//    ⇒ ⭐ **那张表与后端 `error.rs` 的 `Denied` 变体是一份契约的两半**，
//    改一边必须改另一边；`tests/js/tauri.test.js` 现在直接从 `error.rs` 里抠标签来对账。
//    ⭐ **2026-10-21（`design/0025`）起它存的是「字典键」**（`KIND_KEY`），
//    中文不再有第二份——文案的唯一来源是 `services/i18n.js`。
// 3. **`stale` 必须能被静默丢弃**：它是**正常路径**（§2.1.3），⛔ 不是错误提示。

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

  /** 取 Tauri 的 `invoke`。拿不到就抛一句人话。 */
  function resolveInvoke() {
    const g = window.__TAURI__;
    if (g) {
      if (g.core && typeof g.core.invoke === 'function') return g.core.invoke;
      if (typeof g.invoke === 'function') return g.invoke;
    }
    throw new Error('拿不到 window.__TAURI__（检查 tauri.conf.json 的 app.withGlobalTauri）');
  }

  /**
   * 拒绝 → **字典键**。⚠️ `kind` 是后端 [`Denied`] 的 serde 标签。
   *
   * ⭐ **2026-10-21（`design/0025`）由「人话表」改成「键表」**：这些句子是**界面文案**，
   * 而界面文案的唯一来源是 `services/i18n.js` 那本字典。⛔ 这里再存一份中文，
   * 换语言后这七句会永远停在中文，而且没有任何报错（`INV-I18N-01` 的典型形态）。
   * ⚠️ **键集合与后端 `error.rs` 的变体是一份契约的两半**，`tests/js/tauri.test.js` 逐条对账。
   *
   * ⭐ 后两类是 `design/0012` 的**写侧**拒绝——它们说的是"这次**保存动作**不能发生"，
   * 而路径本身好好的。⚠️ 少了它们就会落到兜底那句上去，
   * 于是"磁盘上有人改过这份文件"被显示成"读取失败"——
   * ⛔ 那会让用户去查一个根本不存在的读盘问题（§6 点名的那类错判）。
   */
  const KIND_KEY = {
    not_authorized: 'err.kind.not_authorized',
    not_found: 'err.kind.not_found',
    stale: 'err.kind.stale',
    // ⚠️ 读写**两侧**都用它：保存失败时它说的是"文件/目录不可写"，
    //    具体的"是目录不可写"由后端 message 带过来（§6 要求说清是哪一侧）。
    io: 'err.kind.io',
    conflict: 'err.kind.conflict',
    save_in_flight: 'err.kind.save_in_flight',
    // ⭐ `no_document`：**没有任何文档被打开**（`design/0006` §2.1 ② 的 `⌘E`、
    //    `reload_document`，以及 `design/0012` 的 `begin_edit` / `save_document`）。
    //    ⚠️⚠️ **⛔ 不许并进 `not_found`**：那两句话在界面上是不同的意思——
    //    「文件不存在」会让人**去找文件**，而真实原因是**他还没打开任何文档**
    //    （`design/0006` **§10.6 差异表第 6 条**的原话：「文案含义不同——『你打开的那个
    //    目录/文件找不到了』vs『**现在根本没有当前文档**』…合成一类会让前端把后者
    //    显示成『文件被删了』」；后端 `error.rs` 的变体文档同款）。
    //    ⭐ 2026-10-16 之前**这一条不存在**：后端 7 类，这张表只有 6 类 ⇒
    //    `no_document` 掉进下面的兜底，界面上显示成「操作失败」——
    //    ⚠️ 那句的语义是"**我们不定义原因**"，用它去说一个**已知**的前置条件
    //    正好是把用户推向错方向的写法。⛔ 论形态它比设计禁的那一种更坏：
    //    设计防的是"说成文件被删了"，实际出来的是"说成**不知道**"（`docs/bugs/0005`）。
    no_document: 'err.kind.no_document',
    // ⭐ `design/0034`：新建文件 / 目录的四类新拒绝（`error.rs` 同批加）。
    //    ⚠️ 键集合与后端变体是**一份契约的两半**，`tests/js/tauri.test.js` 逐条对账
    //    （漏一条就会落到兜底那句上去——"操作失败"什么也没说）。
    //    ⚠️ `invalid_name` 的**具体原因**（空 / 分隔符 / 保留名 / 点开头 / 忽略目录 / 过长）
    //       由调用方用 `raw.reason` 现查 `err.name.*`（`services/treerefresh.js::errorText`），
    //       ⛔ 不在这里展开成六条 kind：`.reason` 是**同一类拒绝的子分类**，
    //       拆成六个 kind 会让"名字不合法"在 ACL / 日志 / 文案三处各有一套分类。
    already_exists: 'err.kind.already_exists',
    invalid_name: 'err.kind.invalid_name',
    unusable_parent: 'err.kind.unusable_parent',
    created_outside_root: 'err.kind.created_outside_root',
    // ⭐ `design/0035`：重命名的一类拒绝（软链 / 非 `.md` / 编辑态）。
    //    ⚠️ 与 `invalid_name` 同形：**具体原因**在 `raw.reason`（`err.rename.*`），
    //    ⛔ 不拆成三个 kind（理由同上）。
    not_renamable: 'err.kind.not_renamable',
  };

  /** 兜底那一句的键。⚠️ 语义是"**我们不定义原因**"，⛔ 别指向任何带读盘原因的词。 */
  const OTHER_KEY = 'err.kind.other';

  /**
   * 拿这个进程里可用的**默认**翻译器。
   *
   * ⚠️ **惰性取**：`i18n.js` 排在 `tauri.js` 之前（`index.html`），但这里**不赌加载期**
   * ——文件顺序被人挪过一次（`design/0009` §10.3 那一族）。取不到就返回 `null`，
   * 由调用方决定怎么诚实降级。
   */
  function defaultTranslate() {
    if (typeof window === 'undefined' || !window || !window.rmd || !window.rmd.i18n) return null;
    const i = window.rmd.i18n;
    return function (key) { return i.t(key); };
  }

  /**
   * 把一个 reject 归一化成 `{kind, path, message, wording, raw}`。
   *
   * @param {*} e 后端 reject 的原样载荷
   * @param {Function} [translate] 键 → 人话。⭐ **显式可注入**：
   *   `tests/js/tauri.test.js` 在 node 里跑（没有 `window`），它传自己那份 zh 翻译；
   *   产品路径不传，这里惰性去拿 `window.rmd.i18n.t`。
   *   ⚠️ 两者都没有时 `wording` **回落成键本身**——与 `i18n.t()` 的"两本都缺 ⇒ 显示 key"
   *   是同一条纪律：可见、不静默，⛔ 不给一个编出来的中文。
   *
   * ⚠️ **认不出来的一律归 `other`**，⛔ 不猜成 `not_found`——
   * 把"我们自己的 bug"说成"文件不存在"会让人去错误的地方找原因。
   * ⚠️ 兜底那句同理：`err.kind.other` 的中文是「操作失败」——**不定义原因**的说法，
   * ⛔ 别改成"读取失败"（那是替一个未知的失败**编了一个读盘原因**）。
   */
  function normalizeError(e, translate) {
    let kind = 'other';
    let path = '';
    let message = '';
    if (e && typeof e === 'object') {
      if (typeof e.kind === 'string') kind = e.kind;
      if (typeof e.path === 'string') path = e.path;
      if (typeof e.message === 'string') message = e.message;
    } else if (typeof e === 'string') {
      message = e;
    }
    const key = KIND_KEY[kind] || OTHER_KEY;
    const tr = typeof translate === 'function' ? translate : defaultTranslate();
    let wording = key;
    if (tr) {
      // ⚠️ 翻译器自己抛错也得挡住：一条错误消息的格式化**不许**把原来那个错盖掉。
      try {
        const s = tr(key);
        if (typeof s === 'string' && s) wording = s;
      } catch (err) {
        console.error('翻译错误文案失败：', err);
      }
    }
    return {
      kind,
      path,
      message,
      wording,
      raw: e,
    };
  }

  /** 是不是"这次操作被更新的操作取代了"——正常路径，⛔ 不弹错。 */
  function isStale(e) {
    return !!(e && e.kind === 'stale');
  }

  /** 是不是"没授权"——要进未授权态，而不是报错。 */
  function isNotAuthorized(e) {
    return !!(e && e.kind === 'not_authorized');
  }

  /**
   * 调一条后端命令。
   *
   * ⚠️ 参数名用 Tauri 2 的约定：**由后端函数的参数名决定**（snake_case），
   * 前端这边不转换大小写，写错就是"参数缺失"的运行时错误。
   */
  async function call(cmd, args) {
    const invoke = resolveInvoke();
    try {
      return await invoke(cmd, args || {});
    } catch (e) {
      throw normalizeError(e);
    }
  }

  /**
   * ⭐ 订阅一个**后端事件**（`design/0010` §2.1 ⑧）。
   *
   * ⚠️ 菜单点击**不会**自动到达前端（`manager/menu.rs` 里零 `emit`），
   * 通道是 `on_menu_event` → `app.emit("rmd://menu", id)` → 这里。
   * ⚠️ 它走的是 **core 插件命令**（`plugin:event|listen`），因此**受 ACL 管**——
   * capability 里少了 `core:event:allow-listen` 就会被拒（那是步骤 0 要真机验的第一件事）。
   * ⛔ 失败**不许静默**：调用方要用 `reportFatal` 报到 stderr（`.agent/spec.md` 纪律 6）。
   *
   * @returns {Promise<Function>} 退订函数
   */
  async function listen(event, handler) {
    const g = window.__TAURI__;
    const ev = g && g.event;
    if (!ev || typeof ev.listen !== 'function') {
      throw new Error('拿不到 window.__TAURI__.event（withGlobalTauri 或 ACL 的问题）');
    }
    return await ev.listen(event, handler);
  }

  const api = { resolveInvoke, normalizeError, isStale, isNotAuthorized, call, listen, KIND_KEY, OTHER_KEY };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).tauri = api;
})();
