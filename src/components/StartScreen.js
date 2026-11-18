// 启动页 —— `#doc` 空态里的三段：「开始」「收藏」「最近的目录」
// （`design/0038` §2.1 ／ `design/0043` §2.6 ／ `design/0081` §2.1 ③）。
//
// # 它是什么 / 不是什么
//
// 用户 2026-10-24 点题：「打开最近目录不应该去唤醒 mac 本身的 finder，交互体验并不好。
// 我觉得 rmd 启动的时候，可以参考 vim startify 插件的展示。」
// ⇒ 本文件**只画表**，点一行由 `opts.onOpen` / `opts.onOpenFavorite` 去调后端命令
//   （**授权**那一半全在后端，`INV-START-02` / `INV-FAV-03`）。⛔ 本文件不碰 `fetch`/`invoke`、
//   ⛔ 不读 `config.json`、⛔ 不排序（排序与截断都在后端，见 `services/start.js` 模块头）。
//
// # 两个必须一起读的约束
//
// · **`INV-START-01`**：启动页只活在 `#doc` 的空态里。挂载点是 `main.js::showDocEmpty`
//   ——那是**唯一**的空态入口（三个 `showDocEmpty*` 都经过它）⇒ ⛔ 别在别处 `appendChild`
//   一张 `.start-list`：有文档时它必须**不存在**（否则正文被挤开或盖住）。
// · **`INV-START-04`**：本地键盘模型必须先放行五种情形（树/浮层已处理、组合态、
//   覆盖层开着、可编辑焦点、带修饰键）。⚠️ 判据本体在 `services/start.js::guard`，
//   本文件只负责**当场算**那五项事实——⛔ 别在这里另写一份 `if`。
//
// # ⭐ 两段的顺序（`design/0045`，2026-10-25 用户点题）
//
// **收藏在前、最近的目录在后**（用户原话：「收藏的，要放到最近打开目录的上面。」）。
// ⚠️ 版式顺序与 `allEls()` 的焦点顺序**必须同源**——两处各写一份，
// 表现是"↓ 从最后一行跳到看不见的地方"。
//
// # ⭐ 「开始」段（`design/0081` §2.1 ③，2026-11-15 用户点题）
//
// 用户原话：「导航页新增 打开的功能，有点类似 Vscode 的导航页。」
// ⇒ 导航页最上面多一段**可点的入口**：打开… / 打开文件… / 快速打开…（目录模式下才有）。
// · ⚠️ 动作名与键位**都不在本文件**：`opts.labelText(id)` / `opts.keyText(id)` 由
//   `main.js` 从后端 `SHORTCUTS` 表现取（`INV-SET-01` / `INV-START-08`）。
//   ⛔ 别在这儿写"打开…"/"⌘O"——那是第二个真值，菜单一改名导航页就静默说错话。
// · ⚠️ 点击走 `opts.runAction(id, 'menu')`（`main.js` 里就是 `keymap.dispatch`），
//   ⛔ 不在这里直接调 `onOpen` 之类：动作只能有一份实现（`INV-SET-02`）。
// · ⭐ 顺序：**开始 → 收藏 → 最近**，`allEls()` 同源（`INV-START-09`）。
// · ⚠️ 它让"全空"的导航页也有东西可看——这正是"新窗口默认打开导航页"要的效果；
//   数字键**仍然只映射最近段**（`INV-FAV-05` 的原意不变）。
//
// # ⭐ 收藏段（`design/0043`）
//
// · **数字键只映射最近表**（`INV-FAV-05`）：两段编号会随收藏条数漂移。
// · 收藏行的动作在**右键菜单**里：取消收藏 / 上移 / 下移（首末行各有一项置灰）。
//   ⚠️ 失效行**同样可操作**——这三个动作都不查可达性（它们只改 `config.json`）。
// · `Shift+F10` 打开同一份菜单。⚠️ 它**过得了** `guard`：`keymap.hasModifier` 只认
//   ⌘/⌃/⌥，⛔ 不认 ⇧（见 `services/keymap.js`）——所以这里不必绕开那道闸门。
//
// # ⭐ 最近段的删除（`design/0045`，隐私）
//
// · 段标题右边一个「清空」：**两步确认**（第一下变「确认清空？」，3 秒内再点才真清）；
//   ⛔ 不用原生 `confirm()`——模态窗口会打断用户，而且离屏探针够不到
//   （判据在 `services/start.js::clearConfirm`，纯逻辑）。
// · 每一行右键 / `Shift+F10` ⇒「从列表移除」（只删这一条历史，⛔ 不删磁盘上的目录）。
// · ⚠️ 两件事都**只改 `config.json` 的 `dir_sessions` ＋ `last_directory`**
//   （后端 `recent_apply`）：⛔ 不删文件、⛔ 不动授权、⛔ 不动收藏。

//
// # ⭐ 打开失败的归因（`design/0070` §2.4）
//
// 打开一行是**三段**：① 授权/打开（收藏那条走 `open_favorite`）、② 打开文档、③ 刷新侧边栏。
// ⚠️ 对整条链一个 `catch` 会把"刷新列表失败"说成"这条收藏打不开"（`bugs/0319`）。
// ⇒ `onOpen` / `onOpenFavorite` **总是 resolve** `{ok, failedAt, note, err}`，
//   由本文件按段落容器：`favorite` ⇒ 行标灰 ＋ 段内联；`document` ⇒ 只段内联；
//   `refresh` ⇒ 什么都不改（中性状态条由界面层写）。段内联就是列表之后那条 `.start-note`。
// ⚠️ `data-busy` 在**成功与失败**两条路上都要清（今天失败后一直不清，那一行从此点不动）。
//
// # 焦点纪律
//
// ⚠️ **不预选、不抢焦点**（§2.1 第 4 条）：`render()` 一行都不 `.focus()`。
// 启动页出现时自动聚焦第一行 ⇒ 用户随手敲个回车就替他把目录打开了。
// 焦点只在用户**自己按 `↑`/`↓`** 时才移动（两张表共用一个顺序）。
//
// # 生命周期
//
// `render(host, recent, favorites)` 可以在同一份 DOM 上反复调（`relabelDynamic()` 换语言、
// 收藏增删后会重画），每次都会**重建行**并复用同一个 `document` 级 keydown 监听；`clear()` 摘监听。
// ⚠️ 监听挂在 `document` 而**不是**宿主节点上：宿主是 `<div>`，不可聚焦，
// 挂在它上面等于永远收不到键（除非用户先点一下它）。
(function () {
  'use strict';

  const Start = (typeof module !== 'undefined' && module.exports)
    ? require('../services/start.js')
    : window.rmd.start;
  const K = (typeof module !== 'undefined' && module.exports)
    ? require('../services/keymap.js')
    : window.rmd.keymap;
  // ⭐ `design/0025`：可见文案走字典（浏览器取 `window.rmd.i18n`，`node --test` 走 `require`）。
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) ||
    (typeof module !== 'undefined' && module.exports ? require('../services/i18n.js') : null);
  const t = I18N ? I18N.t : function (key) { return key; };

  /**
   * @param {object} opts
   *   · `onOpen(root)` —— 必填，返回 Promise（拒绝 ⇒ 这一行标成"打不开"）
   *   · `onOpenFavorite(path)` —— 可选，打开一条收藏（缺省 = 收藏行不响应点击）
   *   · ⭐ `onOpenInNewWindow(kind, value)` —— 可选，两张行菜单的「在新窗口中打开」
   *     （`design/0071` §5）。`kind ∈ {favorite, recent}`；`value` 是**后端记录的原串**。
   *     ⚠️ 本文件**不碰 IPC**（与 `onUnfavorite` 等同一条纪律）：命令落在 `main.js`。
   *     ⛔ 这里不拼路径、⛔ 不判可达性（授权在新窗口自己的命令里做）。
   *   · `onUnfavorite(path)` —— 可选，收藏行菜单「取消收藏」
   *   · `onMoveFavorite(path, delta)` —— 可选，收藏行菜单「上移 / 下移」（`delta` = ∓1）
   *   · ⭐ `onForgetRecent(root)` —— 可选，最近行菜单「从列表移除」（`design/0045`）
   *   · ⭐ `onClearRecent()` —— 可选，「清空」第二下确认之后（`design/0045`）
   *   · `onError(err, target, info)` —— 可选，**兜底**通报（段内联落不下去时）；`info = {section, kind}`。
   *     ⭐ `design/0070` §2.4：失败**不再**用 Promise 拒绝来表达——拒绝只剩"意外"。<br>
   *     ⚠️ `onOpen` / `onOpenFavorite` 必须**总是 resolve** `{ok, failedAt, note, err}`：
   *     `failedAt ∈ {favorite, document, refresh}`；`note = {key, vars, detail, retry}` 是段内联那句，
   *     `note === null` 表示**已由别处报告**（例如 `openDocument` 的全局条）。
   *   · `overlayOpen()` —— 必填，任一覆盖层开着吗（`Settings`/`QuickOpen`/`FindBar`/`ImageViewer`）
   *   · ⭐ `labelText(id)` —— 可选，「开始」段某一行的**动作名**（`design/0081`）。
   *     缺省 = `main.js` 没接表 ⇒ **该行不画**（宁缺不错：⛔ 不拿 id 当文案）。
   *   · ⭐ `keyText(id)` —— 可选，同一个动作的键位显示串（空串 ⇒ 不画那个胶囊）。
   *   · ⭐ `runAction(id, source)` —— 可选，「开始」段某一行被点/回车时执行。
   *     ⚠️ `main.js` 传的是 `keymap.dispatch(id, 'menu')`——⛔ 本文件不另写实现。
   *   · ⭐ `canQuickOpen()` —— 可选，「快速打开…」此刻可用吗（缺省 `false` ⇒ 不画那一行）。
   */
  function createStartScreen(opts) {
    const onOpen = opts.onOpen;
    const onOpenFavorite = opts.onOpenFavorite || function () { return null; };
    const onOpenInNewWindow = opts.onOpenInNewWindow || function () {};
    const onUnfavorite = opts.onUnfavorite || function () {};
    const onMoveFavorite = opts.onMoveFavorite || function () {};
    const onForgetRecent = opts.onForgetRecent || function () {};
    const onClearRecent = opts.onClearRecent || function () {};
    const onError = opts.onError || function () {};
    const overlayOpen = opts.overlayOpen || function () { return false; };
    // ⭐ `design/0081` §2.1 ③：「开始」段的三个注入点。⚠️ 缺省都是"画不出来就不画"，
    //    ⛔ 不回落成硬编码文案（`INV-START-08`）。
    const labelText = opts.labelText || function () { return ''; };
    const keyText = opts.keyText || function () { return ''; };
    const runAction = opts.runAction || function () { return false; };
    const canQuickOpen = opts.canQuickOpen || function () { return false; };

    /** 当前挂载的容器（`null` = 没显示）。 */
    let box = null;
    /** 与 `rowEls` 一一对应的数据（`services/start.js::rows` 的产物，**最近表**）。 */
    let data = [];
    let rowEls = [];
    /** 收藏段的数据与行（`services/start.js::favoriteRows` 的产物）。 */
    let favData = [];
    let favEls = [];
    /** ⭐ 「开始」段（`design/0081`）：`services/start.js::actionRows` 的产物（动作 id）与行。 */
    let actData = [];
    let actEls = [];
    /**
     * 两段的列表节点（`design/0070` §2.3.2：段内联提示挂在**列表之后**）。
     * ⚠️ 重画时随 `box` 一起换 ⇒ `clearDom()` 必须把它们清成 `null`。
     */
    let favListEl = null;
    let recentListEl = null;
    /** 两段各自的提示节点（`null` = 没显示）。 */
    let noteEls = { favorite: null, recent: null };
    /**
     * 行菜单（两张表共用，`design/0043` §2.3 ／ `design/0045`）。
     * ⚠️ 网页里的一层，⛔ 不是原生菜单——探针要能读到它。
     */
    let rowMenu = null;
    let rowMenuCleanup = null;
    /** 打开菜单的那一行（`Escape` 要把焦点还给它，⛔ 不还成 `body`）。 */
    let rowMenuOwner = null;
    /** ⭐ 「清空」的第一下是什么时候按的（`0` = 没有待确认的那一下）。 */
    let clearArmedAt = 0;
    /** 武装态的自动复位定时器（⚠️ 重画 / 卸载时必须清掉，否则它会去改一行已删除的按钮）。 */
    let clearTimer = null;
    /** 监听是否已挂——⚠️ 只挂一次，重画不重挂。 */
    let bound = false;

    /**
     * 三段共用的焦点顺序：**开始 → 收藏 → 最近**（与版式同源，`INV-START-09`）。
     * ⚠️ ⛔ 别写 `rowEls.concat(favEls)`——那是上一版的顺序，用户明确要求收藏在上。
     * ⚠️ `design/0081` 起「开始」段在最上面 ⇒ 它排第一；改这里必须同批改 `render`。
     */
    function allEls() { return actEls.concat(favEls, rowEls); }

    // ── 键盘模型（§2.1 第 4 条）─────────────────────────────────────────

    function onKeyDown(e) {
      if (!box) return;
      // ⚠️ 五项**当场现算**：`defaultPrevented` 必须在别的处理器已经跑过之后才准
      //   （⭐ 这正是"给 `FileTree` 让路"的判据，⛔ 别缓存它）。
      const ignore = Start.guard({
        defaultPrevented: e.defaultPrevented,
        modifier: K.hasModifier(e),
        composing: K.isComposingEvent(e),
        overlay: overlayOpen(),
        editable: K.isEditableElement(document.activeElement),
      });
      if (ignore) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        move(e.key === 'ArrowDown' ? 1 : -1, e);
        return;
      }
      // ⭐ `design/0043` §2.3 ／ `design/0045`：两张表的行菜单键。⚠️ ⇧ 不是 `hasModifier`
      //   认的修饰键 ⇒ 这个键**过得了**上面那道闸门，不必为它破例。
      if (e.key === 'F10' && e.shiftKey) {
        const favAt = favEls.indexOf(document.activeElement);
        if (favAt >= 0) {
          e.preventDefault();
          openFavMenu(favAt, null, null);
          return;
        }
        const recAt = rowEls.indexOf(document.activeElement);
        if (recAt >= 0) {
          e.preventDefault();
          openRecentMenu(recAt, null, null);
        }
        return;
      }
      const idx = Start.digitIndex(e.key);
      if (idx >= 0 && idx < rowEls.length) {
        e.preventDefault();
        activate(idx);
      }
    }

    /**
     * `↑`/`↓` 移焦点。⚠️ 逻辑是"**在行之间**走"（最近表 → 收藏表连续），不是"列表滚动"——
     * 所以只在**真的移动了**焦点时才 `preventDefault`（到边界就让键继续走，
     * 万一哪天 `#doc` 出现了滚动条，用户还能用方向键滚）。
     */
    function move(delta, e) {
      const els = allEls();
      if (els.length === 0) return;
      const at = els.indexOf(document.activeElement);
      // 没有焦点时：↓ 进第一行、↑ 进最后一行（⛔ 不预选的反面：只有用户按了才动）
      let next;
      if (at < 0) next = delta > 0 ? 0 : els.length - 1;
      else {
        next = at + delta;
        if (next < 0 || next >= els.length) return;
      }
      e.preventDefault();
      els[next].focus();
    }

    /**
     * 打开最近表第 `i` 行。⚠️ `busy` 是**双触发保护**：点一下 + 键盘敲同一个数字
     * （或双击）会让后端收到两条授权命令，代次 +2、树重挂两次——
     * 症状是"点一次，侧边栏闪两下"（功能没坏，但看着像卡了）。
     */
    function activate(i) {
      const el = rowEls[i];
      const r = data[i];
      if (!el || !r || el.dataset.busy === '1') return;
      el.dataset.busy = '1';
      runOpen(el, r.root, 'recent', function () { return onOpen(r.root); });
    }

    /** 打开收藏表第 `i` 行（同一条双触发保护与失败可见，`INV-START-07`）。 */
    function activateFavorite(i) {
      const el = favEls[i];
      const r = favData[i];
      if (!el || !r || el.dataset.busy === '1') return;
      el.dataset.busy = '1';
      runOpen(el, r.path, 'favorite', function () { return onOpenFavorite(r.path); });
    }

    /**
     * 打开一行，把结果**按段归因**（`design/0070` §2.4）。
     *
     * ⚠️ `call()` 必须**总是 resolve** `{ok, failedAt}`——⛔ 别改回"对整条链一个 `catch`"：
     *    那正是 `bugs/0319` 的成因（收藏授权、文档打开、列表刷新三步共用一句
     *    "这条收藏打不开"），用户看到的是一句**断言了错误成因**的话。
     * ⚠️ 只有 `favorite` 才标灰那一行；`document` / `refresh` **不改变行**
     *    （行变灰说的是"这个目标够不着了"，而刷新失败与目标无关）。
     *
     * @param {HTMLElement} el 被点的那一行（它是 `data-busy` 的唯一持有者）
     * @param {string} target 原始路径（只用于兜底通报，⛔ 不进 DOM 属性）
     * @param {('favorite'|'recent')} section 它在哪一段（段内联提示落在这里）
     * @param {function(): (Promise<{ok:boolean, failedAt?:string, note?:object|null}>|object)} call
     */
    function runOpen(el, target, section, call) {
      const finish = function (res) {
        try {
          if (!res || res.ok !== false) {
            // ⭐ §2.3.2：打开成功 ⇒ 这一段之前的提示收起（用户要的东西已经出来了）。
            if (res && res.ok) clearNote(section);
            return;
          }
          const kind = (res.failedAt === 'favorite' || res.failedAt === 'refresh')
            ? res.failedAt : 'document';
          if (kind === 'favorite') {
            // ⭐ `INV-START-07`：这一行**可操作性**变了，所以标灰 ＋ 一句提示；
            //    ⛔ 不再由它承担"说原因"的职责（那句话是段内联的）。
            el.dataset.missing = '1';
            el.title = t('start.fav-missing');
          }
          // ⚠️ `note === null` = **已由别处报告**（例如 `openDocument` 的全局条）——
          //    ⛔ 不再补一句，否则同一次失败会有两个锚点同时说话。
          if (res.note === null) return;
          if (res.note && res.note.key && showNote(section, res.note)) return;
          // ⚠️ 段内联落不下去（这一段被重画掉了 / 没有挂载点）⇒ 退回中性状态条，
          //    ⛔ 不假装行内说过。
          onError(res.err || res, target, { section: section, kind: kind });
        } finally {
          // ⭐ §2.4：`data-busy` **无条件**清掉。今天失败之后它一直留着 ⇒
          //    那一行从此点不动，而屏幕上没有任何解释。
          delete el.dataset.busy;
        }
      };

      let p;
      try {
        p = call();
      } catch (err) {
        // 同步抛 = 调用方违约（它本该 resolve）。按"文档打不开"处理：不标灰。
        finish({ ok: false, err: err });
        return;
      }
      Promise.resolve(p).then(finish, function (err) {
        // 拒绝 = 意外（不是产品路径）。同样不标灰，交给兜底通报。
        finish({ ok: false, err: err });
      });
    }

    // ── 段内联提示（`design/0070` §2.3.2）─────────────────────────────

    /**
     * 在 `section` 那张表**之后**挂一条提示：一句话 ＋ `重试` ＋ `关闭`。
     *
     * ⚠️ 为什么是段级、不是行级：行是 `<button role="listitem">`，往里塞第二段文字
     *    会破坏 `role=list` 的子项结构；段级提示就在被点的那一行下面，
     *    视觉上仍在"动作发生地"。
     *
     * @returns {boolean} `false` = 这一段没有挂载点（调用方退回状态条）
     */
    function showNote(section, note) {
      const listEl = section === 'favorite' ? favListEl : recentListEl;
      if (!box || !listEl || !listEl.parentNode) return false;
      clearNote(section);

      const el = document.createElement('div');
      el.className = 'start-note';
      // ⚠️ `P1`：`role=status` ＋ `polite`——⛔ 不是 `alert`（`INV-FAIL-06`）。
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');

      const text = document.createElement('span');
      text.className = 'start-note-text';
      text.textContent = t(note.key, note.vars || {});
      // 后端给的成因（io kind / Denied label）只做悬停补全，⛔ 不进 `data-*`。
      if (note.detail) text.title = String(note.detail);
      el.appendChild(text);

      if (typeof note.retry === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'start-note-btn';
        btn.textContent = t('fail.retry');
        btn.addEventListener('click', function () {
          if (btn.disabled) return;
          btn.disabled = true;
          Promise.resolve().then(note.retry).then(function (ok) {
            if (ok !== false) { clearNote(section); return; }
            btn.disabled = false;
          }, function () {
            // 重试又失败 ⇒ 同一条留着、按钮恢复（§6「不出现两条」）。
            btn.disabled = false;
          });
        });
        el.appendChild(btn);
      }

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'start-note-btn';
      closeBtn.textContent = t('fail.close');
      closeBtn.title = t('fail.close-hint');
      closeBtn.addEventListener('click', function () { clearNote(section); });
      el.appendChild(closeBtn);

      listEl.parentNode.insertBefore(el, listEl.nextSibling);
      noteEls[section] = el;
      return true;
    }

    /** 收起 `section` 那一条提示（没显示时是空操作）。 */
    function clearNote(section) {
      const el = noteEls[section];
      noteEls[section] = null;
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    /**
     * 界面层挂一条段内联失败（`main.js::noteStartFailure` 的唯一入口——
     * 打开收藏之外的那几条：移出 / 清空最近目录）。
     *
     * @param {('favorite'|'recent')} section
     * @param {{key:string, vars?:object, detail?:string, retry?:Function}} opts
     * @returns {boolean} `false` = 启动页不在屏上 / 这一段没有挂载点
     */
    function note(section, opts) {
      if (section !== 'favorite' && section !== 'recent') return false;
      if (!opts || !opts.key) return false;
      return showNote(section, opts);
    }

    // ── 行菜单（`design/0043` §2.3 收藏行 ／ `design/0045` 最近行）───────────

    /**
     * 打开一层行菜单——**两张表共用这一份构造**（菜单项与顺序由调用方给）。
     * ⚠️ 复制两段（一段给收藏、一段给最近）会分叉出两种"关闭方式"，
     *    而其中一种总会漏掉 `Escape` 还焦点那一步。
     *
     * @param {HTMLElement} owner 打开菜单的那一行（`Escape` 要把焦点还给它）
     * @param {Array<{key:string, run:function, disabled:boolean}>} items 菜单项（`key` 走字典）
     * @param {number|null} x 视口坐标；`null` = 键盘触发，落在那一行的左下角
     * @param {number|null} y
     */
    function openRowMenu(owner, items, x, y) {
      if (!owner) return;
      closeRowMenu(false);
      const menu = document.createElement('div');
      menu.className = 'start-menu';
      menu.setAttribute('role', 'menu');

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'start-menu-item';
        b.setAttribute('role', 'menuitem');
        b.tabIndex = -1;
        b.textContent = t(it.key);
        if (it.disabled) {
          b.disabled = true;
          b.classList.add('disabled');
        } else {
          b.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            closeRowMenu(false);
            it.run();
          });
        }
        menu.appendChild(b);
      }

      menu.style.left = '0px';
      menu.style.top = '0px';
      document.body.appendChild(menu);
      const boxRect = menu.getBoundingClientRect();
      const at = owner.getBoundingClientRect();
      const px = typeof x === 'number' ? x : at.left + 8;
      const py = typeof y === 'number' ? y : at.bottom;
      menu.style.left = Math.max(4, Math.min(px, window.innerWidth - boxRect.width - 4)) + 'px';
      menu.style.top = Math.max(4, Math.min(py, window.innerHeight - boxRect.height - 4)) + 'px';

      rowMenu = menu;
      rowMenuOwner = owner;
      const onDown = function (ev) { if (!rowMenu || !rowMenu.contains(ev.target)) closeRowMenu(false); };
      const onKey = function (ev) {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        // ⭐ 设计 §2.3：`Escape` 关闭并把焦点**还给那一行**（否则焦点掉到 `body`）。
        closeRowMenu(true);
      };
      const onScroll = function () { closeRowMenu(false); };
      const onResize = function () { closeRowMenu(false); };
      setTimeout(function () {
        if (rowMenu !== menu) return;
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
      }, 0);
      rowMenuCleanup = function () {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
      };
      if (typeof x !== 'number') {
        // 键盘触发：焦点进菜单第一项（可发现性），⛔ 不抢——用户刚按的就是这个键。
        const first = menu.querySelector('.start-menu-item');
        if (first) first.focus();
      }
    }

    /**
     * 收藏行的菜单：在新窗口中打开 / 取消收藏 / 上移 / 下移。
     * @param {number} i 收藏行下标
     */
    function openFavMenu(i, x, y) {
      const el = favEls[i];
      const r = favData[i];
      if (!el || !r) return;
      openRowMenu(el, [
        // ⭐ `design/0071` §5：**主操作**排第一。⚠️ 菜单项不放加速键、⛔ 不出现键位字面量。
        { key: 'start.menu.new-window', run: function () { onOpenInNewWindow('favorite', r.path); } },
        { key: 'start.menu.unfavorite', run: function () { onUnfavorite(r.path); } },
        // ⚠️ 「上移 / 下移」的**目标下标**由 `session.js` 在队首执行时现算，
        //    这里只表达"往哪个方向"——两处各算一份就会分叉。
        {
          key: 'start.menu.move-up',
          run: function () { onMoveFavorite(r.path, -1); },
          disabled: i === 0,
        },
        {
          key: 'start.menu.move-down',
          run: function () { onMoveFavorite(r.path, 1); },
          disabled: i === favData.length - 1,
        },
      ], x, y);
    }

    /**
     * 最近行的菜单（`design/0045`）：在新窗口中打开 / 从列表移除。
     * ⚠️ 传的是**后端给的原串** `r.root`（⛔ 不是屏幕上那个 `~` 缩写）。
     */
    function openRecentMenu(i, x, y) {
      const el = rowEls[i];
      const r = data[i];
      if (!el || !r) return;
      openRowMenu(el, [
        // ⭐ `design/0071` §5：**主操作**排第一；⛔ 不放加速键、⛔ 不出现键位字面量。
        { key: 'start.menu.new-window', run: function () { onOpenInNewWindow('recent', r.root); } },
        { key: 'start.menu.forget', run: function () { onForgetRecent(r.root); } },
      ], x, y);
    }

    /** @param {boolean} restoreFocus `true` = 把焦点还给打开菜单的那一行（`Escape` 用）。 */
    function closeRowMenu(restoreFocus) {
      const owner = rowMenuOwner;
      if (rowMenuCleanup) { rowMenuCleanup(); rowMenuCleanup = null; }
      if (rowMenu && rowMenu.parentNode) rowMenu.parentNode.removeChild(rowMenu);
      rowMenu = null;
      rowMenuOwner = null;
      if (restoreFocus && owner && owner.isConnected) owner.focus();
    }

    // ── 渲染 ────────────────────────────────────────────────────────────

    /**
     * 把启动页画进 `host`（`main.js` 建的 `.doc-empty`）。
     * ⚠️ ⭐ `design/0081` 起：只要 `host` 在就**总能画出「开始」段**（除非动作名取不到）。
     * ⛔ 别再写"两张表都空就什么都不画"——那会让空会话的新窗口看起来是**一张白页**
     * （用户 2026-11-15 第 2 条要的正是"一眼看出这是导航页"）。
     * `host` 里那句提示语是 `main.js` 写的，本文件⛔ 不动它。
     */
    function render(host, recent, favorites) {
      data = Start.rows(recent);
      favData = Start.favoriteRows(favorites);
      actData = Start.actionRows(canQuickOpen());
      clearDom();
      if (!host) {
        box = null;
        rowEls = [];
        favEls = [];
        actEls = [];
        unbind();
        return;
      }
      box = document.createElement('div');
      box.className = 'start';
      actEls = [];

      // ⭐ `design/0081` §2.1 ③：「开始」段在最上面（VS Code 欢迎页那种"这里能做什么"）。
      //    ⚠️ 取不到动作名就**整段不画**（`INV-START-08`：宁缺不错，⛔ 不拿 id 当文案）。
      const actRows = actData.filter(function (id) { return labelText(id) !== ''; });
      if (actRows.length) {
        const title = document.createElement('p');
        title.className = 'start-title start-act-title';
        title.textContent = t('start.act-title');
        box.appendChild(title);

        const list = document.createElement('div');
        list.className = 'start-list start-act-list';
        list.setAttribute('role', 'list');
        actEls = [];
        for (let i = 0; i < actRows.length; i++) {
          const id = actRows[i];
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'start-row start-act-row';
          btn.setAttribute('role', 'listitem');
          // ⚠️ 机器读的标记（探针 / 测试认行用），⛔ 不往这里写文案（`INV-I18N-04`）。
          btn.dataset.action = id;
          // ⭐ 键位胶囊：表里没给（IPC 失败 / ACL 少一条）就不画——宁可少说，不能说错。
          const key = keyText(id);
          if (key) {
            const k = document.createElement('span');
            k.className = 'start-key';
            k.textContent = key;
            btn.appendChild(k);
          }
          const name = document.createElement('span');
          name.className = 'start-name';
          name.textContent = labelText(id);
          btn.appendChild(name);
          btn.addEventListener('click', (function (aid) {
            return function () { runAction(aid, 'menu'); };
          })(id));

          list.appendChild(btn);
          actEls.push(btn);
        }
        box.appendChild(list);
      }

      // ⭐ `design/0045`（用户 2026-10-25 点题）：「收藏」在**上面**、「最近的目录」在下面。
      //    ⚠️ 视觉顺序与 `allEls()` 必须同源，⛔ 别只改这里（`B7` 判据就是这一条）。
      //    ⚠️ `.start-fav-title` 这个类**留着**是给探针认段用的，样式已不再靠它加间距。
      if (favData.length) {
        const title = document.createElement('p');
        title.className = 'start-title start-fav-title';
        title.textContent = t('start.fav-title');
        box.appendChild(title);

        const list = document.createElement('div');
        list.className = 'start-list start-fav-list';
        list.setAttribute('role', 'list');
        favEls = [];
        for (let i = 0; i < favData.length; i++) {
          const r = favData[i];
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'start-row start-fav-row';
          btn.setAttribute('role', 'listitem');
          btn.title = r.path;
          // ⚠️ ⛔ 这里不画数字：两段编号会随收藏条数漂移（`INV-FAV-05`）。
          btn.addEventListener('click', (function (idx) {
            return function () { activateFavorite(idx); };
          })(i));
          // 右键 / `Shift+F10` 的同一个入口（两个来源共用一份动作清单）
          btn.addEventListener('contextmenu', (function (idx) {
            return function (ev) {
              if (ev.defaultPrevented) return;
              ev.preventDefault();
              openFavMenu(idx, ev.clientX, ev.clientY);
            };
          })(i));

          const name = document.createElement('span');
          name.className = 'start-name';
          name.textContent = r.name;
          btn.appendChild(name);

          const path = document.createElement('span');
          path.className = 'start-path';
          path.textContent = r.tilded;
          btn.appendChild(path);

          list.appendChild(btn);
          favEls.push(btn);
        }
        box.appendChild(list);
        favListEl = list;
      }

      if (data.length) {
        // ⭐ `design/0045`：段标题右边一个「清空」（两步确认，见 `onClearClick`）。
        // ⚠️ 它是 `<button>` 而不是 `<a href="#">`：原生可聚焦、`Enter`/`Space` 原生触发。
        const head = document.createElement('div');
        head.className = 'start-head';

        const title = document.createElement('p');
        title.className = 'start-title';
        title.textContent = t('start.recent-title');
        head.appendChild(title);

        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'start-clear';
        // ⚠️ 文案与 `title` 都是**翻译过的**⇒ 只留在字典里，⛔ 不进 `data-*`（`INV-I18N-04`）
        clear.textContent = t('start.recent-clear');
        clear.title = t('start.recent-clear-hint');
        clear.addEventListener('click', onClearClick);
        head.appendChild(clear);

        box.appendChild(head);

        const list = document.createElement('div');
        // ⚠️ `start-recent-list` 是**显式段名**（`design/0081` 起有三段，
        //    "第一个不是收藏表的列表"这种选法会把「开始」段选进来）。
        list.className = 'start-list start-recent-list';
        list.setAttribute('role', 'list');
        rowEls = [];
        for (let i = 0; i < data.length; i++) {
          const r = data[i];
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'start-row start-recent-row';
          btn.setAttribute('role', 'listitem');
          // ⭐ 原生 `title` 给全路径：行里显示的是 `~` 缩写，悬停能看全
          btn.title = r.root;
          // ⚠️ `data-*` 只放**机器读**的标记（`last` / `missing` / `busy`），
          //    ⛔ 不放翻译后的文案（`INV-I18N-04`）。
          if (r.last) btn.dataset.last = '1';
          // ⚠️ 路径**不进 DOM 属性**：它已经在 `title` 里，再存一份就是第二个真值
          //    （有人改了 `title` 忘了这里，点击就打向旧路径）。
          btn.addEventListener('click', (function (idx) {
            return function () { activate(idx); };
          })(i));
          // ⭐ `design/0045`：右键 / `Shift+F10` ⇒「从列表移除」（只删这条历史）。
          btn.addEventListener('contextmenu', (function (idx) {
            return function (ev) {
              if (ev.defaultPrevented) return;
              ev.preventDefault();
              openRecentMenu(idx, ev.clientX, ev.clientY);
            };
          })(i));

          // ① 数字（与键盘映射同一套口径，⛔ 不写成"第 n 行"）
          if (i < 9) {
            const num = document.createElement('span');
            num.className = 'start-num';
            num.textContent = String(i + 1);
            btn.appendChild(num);
          }
          // ② 目录名
          const name = document.createElement('span');
          name.className = 'start-name';
          name.textContent = r.name;
          btn.appendChild(name);
          // ③ 路径（`~` 缩写）
          const path = document.createElement('span');
          path.className = 'start-path';
          path.textContent = r.path;
          btn.appendChild(path);
          // ④ 上次读的文件名（有才画）
          if (r.file) {
            const file = document.createElement('span');
            file.className = 'start-file';
            file.textContent = r.file;
            btn.appendChild(file);
          }
          // ⑤ 「上次打开」标记（⚠️ 只有那一条有）
          if (r.last) {
            const mark = document.createElement('span');
            mark.className = 'start-last';
            mark.textContent = t('start.last-mark');
            btn.appendChild(mark);
          }

          list.appendChild(btn);
          rowEls.push(btn);
        }
        box.appendChild(list);
        recentListEl = list;
      }

      // ⚠️ 三段全空（表还没到 / 动作名取不到 / 两份数据都空）⇒ 与旧空态一致：
      //    ⛔ 不挂一个空的 `.start` 壳，⛔ 不挂 document 监听（挂上去也一个键都不接）。
      if (!actRows.length && !favData.length && !data.length) {
        box = null;
        rowEls = [];
        favEls = [];
        actEls = [];
        unbind();
        return;
      }

      host.appendChild(box);
      bind();
    }

    // ── 「清空」的两步确认（`design/0045`）─────────────────────────────

    /** 把按钮恢复成"没武装"的样子（复位文案与 `data-armed`）。 */
    function resetClearButton(btn) {
      if (!btn) return;
      delete btn.dataset.armed;
      btn.textContent = t('start.recent-clear');
    }

    /** 取消武装态并清掉定时器（重画 / 卸载 / 已执行时调）。 */
    function disarmClear() {
      if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
      clearArmedAt = 0;
    }

    /**
     * 「清空」按钮的点击：**第一下只武装，第二下才真清**（判据在 `Start.clearConfirm`）。
     * ⚠️ 定时器必须兜底复位：留一个"确认清空？"在屏上，用户可能过一阵才回来点它，
     *    那时他早忘了自己按过第一下。
     */
    function onClearClick(ev) {
      const btn = ev.currentTarget;
      const r = Start.clearConfirm(clearArmedAt, Date.now());
      clearArmedAt = r.nextArmedAt;
      if (!r.fire) {
        btn.dataset.armed = '1';
        btn.textContent = t('start.recent-clear-confirm');
        if (clearTimer) clearTimeout(clearTimer);
        clearTimer = setTimeout(function () {
          clearTimer = null;
          clearArmedAt = 0;
          resetClearButton(btn);
        }, Start.CLEAR_CONFIRM_MS);
        return;
      }
      disarmClear();
      resetClearButton(btn);
      // ⚠️ 失败**不在这里吞**：`onClearRecent` 的实现负责给状态栏那句话
      //    （与 `onUnfavorite` 同一条纪律）；这里只保证不额外抛到 window。
      try {
        const p = onClearRecent();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (err) {
        console.error('清空最近目录失败：', err);
      }
    }

    /** 只摘本文件建的那块（`host` 里别的节点是 `main.js` 的）。 */
    function clearDom() {
      closeRowMenu(false);
      disarmClear();
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null;
      // ⚠️ 段内联提示随 `box` 一起消失（§2.3.2：段重画 ⇒ 收起），引用必须同批清空。
      favListEl = null;
      recentListEl = null;
      noteEls = { favorite: null, recent: null };
    }

    function bind() {
      if (bound) return;
      document.addEventListener('keydown', onKeyDown);
      bound = true;
    }

    function unbind() {
      if (!bound) return;
      document.removeEventListener('keydown', onKeyDown);
      bound = false;
    }

    /** 摘干净（`main.js` 在正文挂上时调；⚠️ 空态被重画时由 `render` 自己收）。 */
    function clear() {
      clearDom();
      data = [];
      rowEls = [];
      favData = [];
      favEls = [];
      actData = [];
      actEls = [];
      unbind();
    }

    /** 现在有几行最近目录（冒烟/测试读它，⛔ 别拿 DOM 数量去猜）。 */
    function count() { return data.length; }

    /** 现在有几行收藏（同上）。 */
    function favoriteCount() { return favData.length; }

    /** ⭐ 现在有几行「开始」（`design/0081`；同上）。 */
    function actionCount() { return actEls.length; }

    /** 现在是不是正挂着（空态重画前要判它，⛔ 别拿 `count()` 顶替：只收藏时它也是 0）。 */
    function visible() { return !!box; }

    return {
      render: render,
      clear: clear,
      count: count,
      favoriteCount: favoriteCount,
      actionCount: actionCount,
      visible: visible,
      // ⭐ `design/0070` §2.3.2：界面层（移出/清空最近目录失败）挂段内联提示的入口。
      note: note,
    };
  }

  const api = { createStartScreen: createStartScreen };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).startScreen = api;
})();
