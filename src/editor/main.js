// 编辑面（`design/0012` §2.1①）——CM6 `EditorView` 的**挂载与销毁**、扩展白名单、脏标记、进出编辑态。
//
// # 这里**只**做四件事
//
// 1. **挂载 / 销毁**一个 `EditorView` 到 `#editor`
//    （⚠️ 重挂**同一份**文档时保住光标与滚动位置，见 `mount` 的 `keepCursor`）；
// 2. ⭐ **§① 那张扩展白名单**：这是全仓库**唯一**出现 `@codemirror/*` 扩展名的地方
//    （⛔ 别处按名字去取 `rmdCM6.*`）——加一项就是改本设计；
// 3. ⭐ **脏标记的唯一来源**：`updateListener` 里 `docChanged` 为真才算脏
//    （`selectionSet` 不算——光标动一下不是"改了文件"）；
// 4. **进出编辑态**：进去是 `begin_edit` 拿到文本 + 授权，出来是 `end_edit` 撤销授权。
//
// ⛔ **它不渲染任何东西**：预览整份由 Rust/comrak 产出、由 `main.js::mountDocument` 注入
//    （`adr/0003`）。CM6 在这里**只是源码编辑器**——它的 `markdown()` 只给语法树，
//    上游发行产物里 `Decoration`/`ViewPlugin`/`widget` 各 0 次（`notes/0016` §2.1）。
//
// ⚠️ 与 `src/` 下每个文件一样包一层 IIFE（经典脚本的顶层 `const` 共享全局词法作用域，
//    撞名会让**整个文件不执行**且 stderr 全静默——2026-10-13 真踩过）。
(function () {
  'use strict';

  /**
   * ⭐ **§2.1① 的扩展白名单**（逐条对得上）。
   *
   * | 扩展 | 用途 | ⛔ 明确不装的那些 |
   * |---|---|---|
   * | `EditorView.lineWrapping` | 软换行（与阅读视图观感一致，⛔ 不横向滚动） | `drawSelection` |
   * | `lineNumbers()` | 行号——⚠️ **唯一一项"视觉类"**，且不引入任何 `Decoration` | `highlightActiveLine` / `highlightSpecialChars` |
   * | `history()` ＋ `historyKeymap` | 撤销/重做（决策 1 点名要的） | `defaultKeymap` / `standardKeymap` / `emacsStyleKeymap` |
   * | `markdown()` | **语法树**（列表延续、将来 Vim 的 motion） | 任何 `Decoration` / `ViewPlugin` / `widget` |
   * | `updateListener` | ⭐ **脏标记的唯一来源** | `bracketMatching` / `closeBrackets` / 多光标 |
   * | 转发（`editor/keys.js`，`Prec.low`） | 应用键（§2.3-4） | ⛔ `basicSetup`（＝把上面一整串装回来） |
   * | ⭐ **Vim 槽位**（第 7 位，`design/0014`） | 编辑态 Vim 键位；⚠️ **它一次带进 4 件**（`ViewPlugin`/`Decoration`/隐藏原生插入符/面板）⇒ §2.1① 那张表**对编辑面不再封闭**（`0014` §1.5） | — |
   *
   * ⚠️ **`markdown()` 只装语言、⛔ 不装它的键位**（`markdownKeymap` 不在白名单里）
   *    ⇒ **列表延续本期不生效**，生效的只有语法树。已登记为 `design/0012` §10 的偏差，
   *    ⛔ 不许把它当成"已经能续列表"。
   *
   * ⭐⭐ **Vim 槽位为什么是这个形态**（`design/0014` 裁定 (a) 的开关，§2.4-3）：
   *    ① 它**不是**把 `vimExt` 直接摊进来，而是**装在一个 `Compartment` 里**
   *       （`vimSlot` 已经是 `compartment.of(…)` 的产物）⇒ 开关切换走 **`reconfigure`**，
   *       ⛔ **不许 `setState`**（那会重建 `EditorState` ⇒ **丢撤销历史**，`INV-VIM-08`）；
   *    ② 它**排在 `forwardExt` 之前**——⭐ 这是**唯一**决定"谁先拿到键"的地方：
   *       上游那个 Vim 插件挂的是**原生 keydown handler**（⛔ 不在 `keymap` facet 里，
   *       ⇒ `Prec` 对它**完全无效**，`design/0014` §1.1 的更正块），
   *       而事件分派在**第一个返回 `true` 的 handler** 处停下 ⇒ 位置就是优先级；
   *    ③ 关掉开关时槽位**还在**、里面是**空的**（⚠️ 不是把这一项删掉）——
   *       因为"关"之后还要能**再开**，而 `Compartment` 必须一直被同一个 state 认识。
   *       ⭐ 效果与"不装 Vim"等价（`design/0014` §2.1-7 / §8：关开关与最小回滚同一条路）。
   *
   * @param {object} CM6 `window.rmdCM6`（那个 bundle 的全局）
   * @param {object} hooks
   * @param {Function} hooks.onDocChanged `() => void` —— ⭐ 唯一一次"缓冲变了"的通知
   * @param {object} forwardExt 转发扩展（`editor/keys.js::buildBindings` 的产物）
   * @param {object} [vimSlot] ⭐ 第 7 位那个槽位（`Compartment.of(vim 那 4 项)` 或 `.of([])`）。
   *   ⚠️ 不传等价于 `.of([])`——⛔ **别把这一项整个省掉**：那样位置就漂了，
   *   而 `forwardExt` "必须是最后一位"是本设计写死的判据。
   */
  function extensions(CM6, hooks, forwardExt, vimSlot) {
    return [
      CM6.EditorView.lineWrapping,
      CM6.lineNumbers(),
      CM6.history(),
      CM6.keymap.of(CM6.historyKeymap),
      CM6.markdown(),
      CM6.EditorView.updateListener.of(function (update) {
        // ⚠️ **只有 `docChanged` 才算脏**（§2.1① 表里那一行）。
        //    ⛔ 不许把 `update.selectionSet` / `update.focusChanged` 也算进来——
        //    那会让"点一下编辑器"变成"有未保存改动"，于是退出编辑态时弹一个
        //    **没有对应事实**的确认框（`INV-EDIT-06` 那道闸会被用坏，用户学会忽略它）。
        if (update.docChanged && hooks && hooks.onDocChanged) hooks.onDocChanged();
      }),
      vimSlot || [],
      forwardExt,
    ];
  }

  /**
   * 建一个编辑面控制器。
   *
   * @param {object} opts
   * @param {object} opts.CM6 `window.rmdCM6`
   * @param {HTMLElement} opts.host `#editor` 里那个真正的编辑器容器
   * @param {Function} opts.onDirtyChange `(dirty: boolean) => void`
   * @param {Function} [opts.onDocChanged] `() => void` —— ⭐ **每一次**缓冲改动都调一次
   *        （⛔ **不是**"脏状态翻转时"，那是 `onDirtyChange`）。
   *        ⚠️ 它是**预览调度的唯一入口**（`src/main.js` 拿它接 `preview.js::markEdited`，
   *        见 `design/0012` §2.6-3）。⛔ 两个钩子不许合并 —— 理由见 `bufferChanged`。
   * @param {Function} [opts.buildVim] ⭐ `design/0014`：`() => Array`，返回上游 `vim()` 那 4 项。
   *        ⚠️ 是**取值函数**而不是一份现成的扩展，因为"先关着、后来才打开"必须也能装上；
   *        结果**记忆化一次**（见 `取VimExt`）。
   */
  function createEditor(opts) {
    const CM6 = opts.CM6;
    const host = opts.host;
    let view = null;
    /** ⭐ **缓冲的修订号**：每次 `docChanged` +1。⚠️ 保存的"清脏前重判"（§2.4-4）靠它。 */
    let rev = 0;
    /** 上一次被评为"干净"时的修订号 ⇒ `rev !== cleanRev` ⟺ 有未保存改动。 */
    let cleanRev = 0;

    /** ⭐ `design/0014` 裁定 (a)：Vim 槽位。⚠️ **每次 `mount` 新建一个**——
     *  `Compartment` 是**认 state 的**，新 state 必须配新实例（用旧的会 `reconfigure` 不动）。 */
    let vimCompartment = null;
    /** ⭐ **已经应用到 state 上**的开关值（⛔ 不是"用户想要的那个"，那个可能是被推迟的目标）。 */
    let vimOn = false;
    /** 组合态期间被**推迟**的目标值；`null` = 没有待处理的切换（§2.4-3-4）。 */
    let 待切 = null;
    /** `buildVim()` 的记忆化结果。⚠️ ⛔ 不许每次开关都重建：那会造出**新的**扩展实例，
     *  寄存器/宏/上次的模式都跟着换一份，而 `INV-VIM-07` 要的是"退出编辑态才清"。 */
    let vimExt = null;

    function 取VimExt() {
      if (vimExt === null) vimExt = (opts.buildVim && opts.buildVim()) || [];
      return vimExt;
    }
    /** 槽位里该放什么（`on` ⇒ 那 4 项；`off` ⇒ 空）。 */
    function 载荷(on) { return on ? 取VimExt() : []; }
    /**
     * ⚠️ **组合态判据用的是 CM6 自己那个**（`EditorView.composing`），⛔ 不是我们另记一个布尔：
     *    它正是 CM6 那条 Safari 守卫在用的同一个值（`design/0014` §7.1 尾部），
     *    两份判据会漂，而漂的表现是"组合态里把扩展换了 ⇒ 正在组的字丢掉"。
     */
    function 组合中() { return !!(view && view.composing); }

    function isMounted() { return view !== null; }
    function isDirty() { return isMounted() && rev !== cleanRev; }
    function text() { return view ? view.state.doc.toString() : ''; }
    function revision() { return rev; }

    /** ⚠️ 轮询用的**唯一**脏变化出口（`onDirtyChange` 只在真变的时候响一次）。 */
    let lastDirty = false;
    function pumpDirty() {
      const d = isDirty();
      if (d !== lastDirty) {
        lastDirty = d;
        if (opts.onDirtyChange) opts.onDirtyChange(d);
      }
    }

    /**
     * ⭐ **缓冲变了**的唯一出口（CM6 `updateListener` 的 `docChanged` 之后调一次）。
     *
     * ⚠️ **两个消费者，缺一不可**：
     *   ① `pumpDirty()` —— 脏标记（`INV-EDIT-06` 那道闸的输入）；
     *   ② `opts.onDocChanged` —— 预览调度的**唯一入口**。
     *
     * ⚠️⚠️ **⛔ 不许把 ② 并进 ①**：`pumpDirty` 只在**脏状态翻转**的时候才响
     *    （它上面那句注释 + `lastDirty` 就是干这个的），而预览要的是
     *    **每一次改动都重排防抖**。合并的后果不是"少一些通知"，是
     *    ⭐ **"改第一个字之后，后面每一个字都再也不重排防抖"**：
     *    第一次 `markEdited()` 之后 `isDirty()` 恒为 `true` ⇒ `lastDirty` 不再变
     *    ⇒ 通知只发生过一次 ⇒ 防抖窗口一到就渲**一**次，把**当时**的缓冲渲出去，
     *    之后的所有改动**屏幕上没有任何痕迹**（⛔ 也不报错）。
     *    ⚠️ 这正是 `docs/bugs/0004`（2026-10-16）：编辑态**从来没有接过**预览调度，
     *    因为唯一的接线点是 `onDirtyChange`，而它结构上到不了"每一次改动"。
     */
    function bufferChanged() {
      rev += 1;
      pumpDirty();
      if (opts.onDocChanged) opts.onDocChanged();
    }

    /**
     * ⭐ 取一份"光标在哪、滚到哪"的快照（`mount` 的 `keepCursor` 用）。
     *
     * ⚠️ **必须在 `unmount()` 之前取**——`destroy()` 会把 DOM 摘下来，
     *    脱离文档的元素 `scrollTop` 读回 **0**（真 CM6 亦然）⇒ 取晚了就是
     *    "位置永远恢复成开头"，而**页面上看不出这件事发生过**。
     *
     * ⚠️ 取不到就返回 `null`（⛔ 不编造一个 `0/0`）：`null` 的语义是"**没有**可恢复的位置"，
     *    与"位置**正好**在开头"是两件事。
     */
    function cursorSnapshot() {
      if (!view) return null;
      // ⚠️ 形状与真 CM6 一致：`state.selection` 是 `EditorSelection`、`.main` 是 `SelectionRange`。
      const sel = view.state && view.state.selection && view.state.selection.main;
      if (!sel) return null;
      const dom = view.scrollDOM;
      return {
        anchor: sel.anchor,
        head: sel.head,
        scrollTop: dom && typeof dom.scrollTop === 'number' ? dom.scrollTop : null,
      };
    }

    /**
     * 把快照夹进**新文档**的合法区间。
     *
     * ⚠️ 重挂的文本可能比原来**短**（外部改动删掉几行就是这种情形），而 CM6 的
     *    `EditorState.create` 对越界选区是**抛异常**的（`Selection points outside of
     *    document`）⇒ 不夹的话，一次外部保存就能把编辑面整个炸掉。
     *    ⚠️ 夹的是**UTF-16 偏移**，与 CM6 自己的坐标系一致（⛔ 不是字节、不是码点）。
     */
    function clampCursor(snap, len) {
      function 夹(n) {
        if (typeof n !== 'number' || !isFinite(n)) return 0;
        if (n < 0) return 0;
        if (n > len) return len;
        return n;
      }
      return { anchor: 夹(snap.anchor), head: 夹(snap.head) };
    }

    /**
     * 把缓冲挂进 `#editor`。
     *
     * ⭐ `EditorState.create({ doc })` 会把 `\r\n` / 裸 `\r` **折成 `\n`**
     * （`@codemirror/state` 的 `DefaultSplit = /\r\n?|\n/`，产物 `:608`）。
     * ⚠️ 这**不是缺陷**：逐字节保真是**信封**的责任（`INV-EDIT-12`），
     * 编辑缓冲**恒为 LF、无 BOM**——后端给的就是这份，写回时由 `Envelope::restore` 还回去。
     *
     * @param {string} doc 规范化后的源码（`EditGrant.text`）
     * @param {object} forwardExt 转发扩展
     * @param {object} [opts]
     * @param {boolean} [opts.keepCursor] ⭐ **只在重挂同一份文档时**传（`refreshEditBuffer`）。
     *   ⚠️ **换文档时（`enterEdit`）传它是错的**：新文档的光标停在旧文档那个偏移上
     *   是个**没有意义的位置**，而且用户看到的是"打开一份新文档，光标在中间"。
     *   ⚠️ 恢复是**尽力而为**：偏移量本身不带"它指着哪段文字"的信息，
     *   外部改动如果动过光标**之前**的内容，落点就是另一处了——这是这套机制的固有限度，
     *   ⛔ 不是可以靠多写几行代码消掉的东西（要消掉得做位置映射，那是另一个量级的工作）。
     * @param {boolean} [opts.vimOn] ⭐ `design/0014`：这次挂载时 Vim **开着吗**
     *   （值来自 `config.json` 的 `vim_mode`，由 `src/main.js` 传进来）。
     *   ⚠️ 默认 `false`——裁定 (a)：**出厂关闭**。
     */
    function mount(doc, forwardExt, opts) {
      const 旧位置 = opts && opts.keepCursor ? cursorSnapshot() : null;
      const 要Vim = !!(opts && opts.vimOn);
      unmount();
      // ⭐ 新 state 配**新的** `Compartment`（旧的那个属于已经销毁的那个 state）。
      vimCompartment = new CM6.Compartment();
      vimOn = false;
      待切 = null;
      const state = CM6.EditorState.create({
        doc: doc,
        selection: 旧位置 ? clampCursor(旧位置, doc.length) : undefined,
        extensions: extensions(CM6, {
          // ⚠️ 这里**只能**写 `bufferChanged`（`createEditor` 作用域的那个），
          //    ⛔ 别就地展开成 `rev += 1; pumpDirty();` —— 本函数的形参也叫 `opts`，
          //    就地展开时拿不到 `createEditor` 的 `opts.onDocChanged`，
          //    而**漏掉它一个字都不会报错**（`docs/bugs/0004` 就是这么来的）。
          onDocChanged: bufferChanged,
        }, forwardExt, vimCompartment.of(载荷(要Vim))),
      });
      view = new CM6.EditorView({ state: state, parent: host });
      // ⚠️ `vimOn` 记的是"**已经应用到 state 上**的那个值"——所以它在 `EditorState.create`
      //    **之后**才写。⛔ 别提到前面去：那样中途抛异常的话，记账与 state 就不一致了。
      vimOn = 要Vim;
      // ⭐ 裁定 (a) 第 4 条的另一半：组合结束后补上被推迟的切换（挂/拆与 mount/unmount 成对）。
      if (host && typeof host.addEventListener === 'function') {
        host.addEventListener('compositionend', flushVimToggle);
      }
      // ⚠️ 滚动位置在**建完之后**设：`EditorView` 的构造是同步的，此刻 `scrollDOM` 里
      //    已经是新内容的高度。⛔ 也别自己夹——新内容更短时浏览器会自己夹回去，
      //    在这里再夹一次只是多一份会漂的常量。
      if (旧位置 && 旧位置.scrollTop !== null) {
        const dom = view.scrollDOM;
        if (dom) dom.scrollTop = 旧位置.scrollTop;
      }
      rev = 0;
      cleanRev = 0;
      lastDirty = false;
      pumpDirty();
      return view;
    }

    function unmount() {
      if (!view) return false;
      view.destroy();
      view = null;
      // ⚠️ 与 `mount` 里那句成对：⛔ 不拆的话，进 N 次编辑态就堆 N 个监听器。
      if (host && typeof host.removeEventListener === 'function') {
        host.removeEventListener('compositionend', flushVimToggle);
      }
      // ⚠️ 槽位与开关记账**一并清掉**：它们属于刚销毁的那个 state。
      //    ⛔ `vimExt` **不清**（记忆化的那 4 项是模块级的、与 state 无关）。
      vimCompartment = null;
      vimOn = false;
      待切 = null;
      rev = 0;
      cleanRev = 0;
      // ⚠️⚠️ `lastDirty` **刻意不在这里清零**（我第一版清了，是错的）：
      //    清了之后下面那次 `pumpDirty()` 会算出"没变化"而**不发通知**，
      //    于是调用方那一侧的脏镜像会**停在 `true`**。
      //    表现：退出编辑态之后那个「● 未保存」还在（或更坏——切文档时
      //    弹一个**没有对应事实**的确认框，而用户已经被问过一次了）。
      //    ⇒ 让它自己比出 `true → false` 那一次转移，通知才发得出去。
      pumpDirty();
      return true;
    }

    /**
     * ⭐⭐ **开关 Vim**（`design/0014` 裁定 (a)）——编辑态里唯一允许改扩展的动作。
     *
     * ⛔⛔ **只准走 `Compartment.reconfigure`**（`INV-VIM-08`）：`setState` 会**重建
     * `EditorState`** ⇒ 用户的**撤销历史没了**，而且这件事**完全静默**。
     * 裁定逐字：「切换**不得丢文本、制造编辑事务或清空撤销历史**，
     * **组合态期间延后切换**」。四条在这里的落点：
     *
     * | # | 约束 | 怎么落的 |
     * |---|---|---|
     * | 1 | 不丢文本 | `reconfigure` 只换扩展，`doc` 一个字符都不动 |
     * | 2 | 不造编辑事务 | 那个 `dispatch` **只有 `effects`、⛔ 没有 `changes`** |
     * | 3 | 不清撤销历史 | 同 1：`EditorState` 本身没被替换（`history` 扩展也不在槽位里） |
     * | 4 | 组合态延后 | `组合中()` 为真时只**记账**（`待切`），等 `compositionend` 再应用 |
     *
     * ⚠️ 返回值是"**这次真的生效了吗**"：`false` = 推迟了 / 没挂载 / 没变化。
     *    ⛔ **调用方不许把 `false` 当成失败**（推迟是设计的一部分）。
     *
     * @param {boolean} on
     * @returns {boolean}
     */
    function setVim(on) {
      on = !!on;
      if (!view || !vimCompartment) {
        // ⚠️ 没挂载时**只记账**，等下一次 `mount(doc, forwardExt, {vimOn})` 生效。
        //    ⛔ 别在这里造一个 view —— 那是另一个量级的行为，而且不在本设计的边界内。
        vimOn = on;
        return false;
      }
      if (on === vimOn && 待切 === null) return false;
      if (组合中()) {
        // ⭐ 裁定 (a) 第 4 条：**组合态期间延后**。⚠️ 这里换扩展会让正在组的字丢掉
        //    （与 `0d` 同族），而丢字是四条约束里最贵的一种。
        待切 = on;
        return false;
      }
      return 应用(on);
    }

    /** ⭐ 真正的"换扩展"那一步——**全文件只有这一处** `reconfigure`。 */
    function 应用(on) {
      // ⚠️ `effects` 只有一项、⛔ **没有 `changes`**（约束 2）。
      view.dispatch({ effects: vimCompartment.reconfigure(载荷(on)) });
      vimOn = on;
      待切 = null;
      return true;
    }

    /**
     * ⭐ **组合结束后把被推迟的那次切换补上**（裁定 (a) 第 4 条的另一半）。
     *
     * ⚠️ 挂的是 `compositionend`，⛔ **不是 keydown**：`design/0012` §2.1 ① 明文
     *    「⛔ 不新增第四段手写 `keydown`」，本设计也没破这条——
     *    `compositionend` 不是键事件，它不改任何键的处理归属。
     */
    function flushVimToggle() {
      if (待切 === null) return false;
      if (!view || !vimCompartment) { 待切 = null; return false; }
      // ⚠️ 仍要再判一次组合态：`compositionend` 之后 CM6 可能还在收拾上屏那一下。
      if (组合中()) return false;
      return 应用(待切);
    }

    // ⚠️ 监听在 `mount` 里挂、在 `unmount` 里拆（**成对**），⛔ 不在这里挂一次了事——
    //    `createEditor` 是**每次进编辑态调一次**的（`src/main.js::enterEdit`），
    //    挂在这里就是"进一次编辑态多一个监听器"，而症状是
    //    "退出再进来之后，一次切换会被冲刷 N 次"——⭐ 与 `0012` §11 的
    //    `syncStart`/`syncStop` **同一形态**（那条也是进出编辑态各自挂/拆）。

    /** ⚠️ 只为排障/断言：当前**已应用**的开关值。 */
    function vimEnabled() { return vimOn; }
    /** ⚠️ 只为排障/断言：有没有一次切换在等着组合结束。 */
    function vimTogglePending() { return 待切; }

    /**
     * 标记"缓冲现在与磁盘一致"。
     *
     * ⚠️ **只有保存成功、且重判过修订号之后**才允许调它（`editor/save.js` 管那道判据）。
     *    ⛔ 别在 `begin_edit` 里调——那时绑定的是"刚载入的文本"，语义上本来就是干净的，
     *    而 `mount()` 已经把 `cleanRev` 归零了。
     */
    function markClean() { cleanRev = rev; pumpDirty(); }

    /** ⚠️ 编辑面当前的滚动容器（预览的锚点量的是**它**，见 `preview` 接线处）。 */
    function scrollDOM() { return view ? view.scrollDOM : null; }

    return {
      mount: mount,
      unmount: unmount,
      isMounted: isMounted,
      isDirty: isDirty,
      text: text,
      revision: revision,
      markClean: markClean,
      scrollDOM: scrollDOM,
      /** ⭐ `design/0014` 裁定 (a)：开关 Vim（只走 `reconfigure`）。 */
      setVim: setVim,
      /** ⚠️ 只为排障/断言：当前**已应用**的开关注（⛔ 不是"用户想要的那个"）。 */
      vimEnabled: vimEnabled,
      /** ⚠️ 只为排障/断言：有没有一次切换在等组合结束（`null` = 没有）。 */
      vimTogglePending: vimTogglePending,
      /** ⚠️ 只为排障。 */
      raw: function () { return view; },
    };
  }

  /**
   * ⭐ **三合一自证**（`FrontendReport.edit_ok` 的**唯一**生产者）。
   *
   * 为什么是**三件**而不是一件：`edit_ok` 要挡的是**构建链断掉**那一类——
   * 那时界面上一切正常（只读阅读完全不受影响），⛔ **只有点了「编辑」才发现按不动**。
   * 三件各挡一种形态：
   *
   * | # | 判据 | 它挡的是 |
   * |---|---|---|
   * | ① | CM6 的全局在 | bundle 没构建 / 没随 Web 资源发出去 |
   * | ② | 用**临时容器**建 `EditorView`、`dispatch` 一段文本、读回来**逐字相等** | 建不出来 / 读不回来 / 文本丢了 |
   * | ③ | **转发白名单非空且含 `Mod-s`** | §2.3-4 的派生判据写错一个字（白名单会**静默变成空数组**，那时编辑区里**所有**应用键都失效） |
   * | ④ | ⭐ **`vim` 与 `Vim.defineEx` 都在且是函数**（`design/0014`） | ⛔ `make cm6` 之后再没跑过一次入口改动的那些情形：**「编辑态起得来、`:w` 静默无效」** |
   *
   * ⚠️ **④ 为什么值得单列**（`design/0014` §7.2）：漏了它的表现是**最像"没事"的一种**——
   *    `vim()` 不在 ⇒ 开关点下去什么也不发生（页面上一切正常）；
   *    `Vim.defineEx` 不在 ⇒ `:w` 是**上游那个彻底静默的 no-op**（`core/vim.js:6398`：
   *    `commands.save` 与 `cm.save` 在我们这个 bundle 里都不存在）⇒ **用户以为存了**。
   *    ⚠️ 两者都不会有任何报错。
   *
   * ⚠️ ⛔ **不依赖有没有打开文档**（建一个 `EditorView` 不需要正文）
   *    ⇒ 空会话 / 目录模式里同样要过。⛔ 也**不进编辑态**、⛔ **不碰用户的任何文件**、
   *    ⛔ **不碰 `#editor`**（用临时容器，自证失败也不该在界面上留下残骸）。
   *
   * @param {object} CM6 `window.rmdCM6`（可能不存在——那正是 ① 要判的）
   * @param {Array} specs [`editor/keys.js::deriveWhitelist`] 的 `specs`
   * @param {object} doc `document`（注入以便单测）
   */
  function selfTest(CM6, specs, doc) {
    const D = doc || (typeof document !== 'undefined' ? document : null);
    const 探针 = 'rmd-自证-探针';
    // —— ① 全局在 ——
    if (!CM6 || typeof CM6 !== 'object') {
      return { ok: false, note: 'bundle 没加载（window.rmdCM6 不在）——跑 make cm6' };
    }
    if (typeof CM6.EditorView !== 'function' || !CM6.EditorState || !CM6.Prec) {
      return { ok: false, note: 'bundle 的导出面不对（EditorView / EditorState / Prec 缺）' };
    }
    if (typeof CM6.keymap !== 'object' || !CM6.keymap.of) {
      return { ok: false, note: 'bundle 里没有 keymap（@codemirror/view 的导出面变了）' };
    }
    if (!D || typeof D.createElement !== 'function') {
      return { ok: false, note: '没有 document（自证建不出临时容器）' };
    }

    // —— ② 建 / 写 / 读 往返 ——
    let view = null;
    try {
      const tmp = D.createElement('div');
      const state = CM6.EditorState.create({ doc: '' });
      view = new CM6.EditorView({ state: state, parent: tmp });
      view.dispatch({ changes: { from: 0, insert: 探针 } });
      const back = view.state.doc.toString();
      if (back !== 探针) {
        return { ok: false, note: '临时 EditorView 的文本往返不等（写进去 ' + 探针.length + ' 字，读回 ' + back.length + ' 字）' };
      }
    } catch (e) {
      return { ok: false, note: '临时 EditorView 建不出来：' + String((e && e.message) || e) };
    } finally {
      // ⚠️ **无论成败都要销毁**：临时容器会连着 CM6 的 DOM 观察器与度量循环，
      //    漏掉这一句就是每次自证都漏一个 view（冒烟里每条用例一次）。
      if (view) { try { view.destroy(); } catch (e) { /* 销毁失败不该盖掉上面的结论 */ } }
    }

    // —— ③ 转发白名单非空且含 `Mod-s` ——
    // ⚠️ `Mod-s` 来自后端那张表里的 `file.save`（`Cmd+S`）——不是这里写死的字面量，
    //    是**派生结果**。⛔ 本文件里没有按键字面量（源码级闸门盯着 `src/**`）。
    const list = specs || [];
    if (!list.length) {
      return { ok: false, note: '转发白名单是空的 —— §2.3-4 的派生判据写错了（编辑区里应用键会全部失效）' };
    }
    const 有保存 = list.some(function (r) { return r.spec === 'Mod-s'; });
    if (!有保存) {
      return { ok: false, note: '转发白名单里没有保存键（共 ' + list.length + ' 项）—— 后端表里的 file.save 没了 / 它的 accel 变了' };
    }

    // —— ④ ⭐ `design/0014`：Vim 那两件在不在 ——
    // ⚠️ 判的是**会被调到的两个成员**，⛔ 不是"名字在不在"：`vim` 是安装扩展（开关靠它），
    //    `Vim.defineEx` 是 `:w` 的唯一接口。两者缺任一，症状都是**静默的**
    //    （见上面那张表 ④ 那一行），而 `make test`/`smoke` 都不会因此变红。
    if (typeof CM6.vim !== 'function') {
      return { ok: false, note: 'bundle 里没有 `vim`（编辑态 Vim 开关会点了没反应）—— 跑 make cm6' };
    }
    if (!CM6.Vim || typeof CM6.Vim.defineEx !== 'function') {
      return { ok: false, note: 'bundle 里没有 `Vim.defineEx`（`:w` 会是静默 no-op，用户以为存了）' };
    }

    return { ok: true, note: 'CM6 在 / 文本往返逐字相等 / 转发 ' + list.length + ' 项（含保存键）/ Vim 装配面在' };
  }

  const api = {
    extensions: extensions,
    createEditor: createEditor,
    selfTest: selfTest,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).editor = api;
})();
