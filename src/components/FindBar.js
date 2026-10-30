// 正文内查找浮层 —— `design/0011-正文内查找.md`（2026-10-14 已通过）。
//
// # 它是什么
//
// `⌘F` 出来的**瞬时**浮层：就地高亮 + 「第几 / 共几」+ 上/下一个。
// ⛔ **没有结果列表**——那会变成"找错对象了"（`design/0011` §4；列表是 `⌘P` 的形态）。
//
// # 索引建在**前端的 DOM** 上（这是本设计的主线）
//
// 「可见文本」只存在于渲染结果里：Rust 侧要拿到它，只能重写渲染器或新引一个
// HTML 解析器再复现 comrak 的排版空白（`design/0011` §2.2 备选 B 的两条否决理由）。
// ⇒ 段数组在**这份文件里**建、一次（第一次 `⌘F` / 文档提交之后重建）、在内存里搜。
//
// # 四条截断点（`INV-FIND-03`）
//
// 「段」= **DOM 顺序上一个连续 run**，⛔ 不是"一个块级容器"。实现上它们落成
// **四类切缝**，逐条都能在下面的 `consume()` 里指出来：
//
//   ① 块级容器的**进出** → 判据是"**最近的那个块级祖先换了没有**"（`blockInfo`）。
//      ⚠️ 用"换了没有"而不是"进入/离开事件"，是因为 `TreeWalker` 只给"进入"不给"离开"，
//      而 `<li>甲<p>中</p>乙</li>` 里的 `乙` 恰恰是**离开 `<p>` 回到 `<li>`** 才该切
//      （⛔ 按"进入块级容器"切会把 `中乙` 拼成一段，那正是评审 `R1` 的原例）。
//  ② `<br>` 元素本身切成两段。⚠️ `SHOW_TEXT` **看不见 `BR`**，所以 walker 必须
//     同时要 `SHOW_ELEMENT`——否则 `甲<br>乙` 会被拼成 `甲乙`，命中一个**屏幕上不存在**的词。
//  ③ 被排除子树（`<svg>`/`<math>`）→ walker 的 `FILTER_REJECT` **整棵剪掉**，
//     并在**遇到的那一刻**记一个 `pendingBreak`，让它后面的第一个文本节点切一刀。
//     ⚠️ 少了这一刀，`甲<math>…</math>乙` 会拼成 `甲乙`（跨着一个被跳过的公式命中）。
//  ④ "排版空白"文本节点（全空白 ∧ 非 `pre` 后代）→ 切一刀，**且不进任何段**
//     （判据在 `services/find.js::isLayoutWhitespace`，一手依据是 comrak 的 `cr()`/`lf()`）。
//
// # 三条必须知道的边界
//
// · **索引只按需建**（`INV-FIND-08`）：⛔ 不在打开文档时建——绝大多数打开不搜索。
//   文档**提交成功即作废**（`INV-FIND-02`），`main.js` 在 `mountDocument` 里调 `invalidate()`。
// · **只读**（`INV-FIND-01`）：走 `CSS.highlights` 时**正文一个节点都不动**；
//   `<mark>` 回退路要按"清空 + 重建 pieces"两条一起做（见 `clearHighlights`）。
// · **本文件里没有按键字面量**（`INV-SET-01`）：`⌘G`/`⇧⌘G` 靠
//   `K.matchEvent(keymap.bindings, e)` 从后端那张表里认，与全局分发器**同一份匹配算法**；
//   键位**显示**走 `keyText(id)`。⚠️ 这条由 `tests/js/keymap.test.js` 的源码级闸门盯着。
//
// # 与另外两层浮层的关系
//
// `⌘F` / `⌘P` / 设置覆盖层**至多一层**（`INV-FIND-06`）——三者都注册进
// `Settings.registerOverlay` 那**唯一一个**登记处（`INV-SET-07`），开一个就关另一个。

(function () {
  'use strict';

  const F = (typeof module !== 'undefined' && module.exports) ? require('../services/find.js') : window.rmd.find;
  const K = (typeof module !== 'undefined' && module.exports) ? require('../services/keymap.js') : window.rmd.keymap;
  const St = (typeof module !== 'undefined' && module.exports) ? require('./Settings.js') : window.rmd.settings;
  // ⭐ `design/0025`：译文走字典。⚠️ 本文件建 DOM 时**同时**贴 `data-i18n*`——
  //    构造时的 `t()` 只负责"此刻这一屏"，之后切语言由 `applyDom` 重贴静态属性、
  //    由 `subscribe` 重跑 `renderNote()`/`refreshKeyTips()` 管动态那半。
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) || null;
  const t = I18N ? I18N.t : function (key) { return key; };

  /** 覆盖层名（登记处的键，也是 `closeOtherOverlays` 认得的名字）。 */
  const NAME = 'find-bar';

  /** 每批构建的**时间预算**（ms）。⚠️ 判据是"浮层先可输入"，⛔ 不是"索引最快建完"。 */
  const BATCH_MS = 8;

  /** 每 N 个节点看一次表（`performance.now()` 本身不免费，⛔ 别每个节点都问）。 */
  const CLOCK_EVERY = 256;

  /** 定位时命中矩形与视口边缘之间留的空隙（px）。 */
  const EDGE_PAD = 24;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /**
   * 建查找浮层。
   *
   * @param {object} opts
   * @param {() => (Element|null)} opts.getDoc ⭐ **取**正文容器（⛔ 不缓存元素：
   *        `design/0006` 的自动重载会重新 `innerHTML`，元素本身不变但内容会换）
   * @param {object} opts.keymap ⭐ `design/0010` 的分发器句柄——**只为读 `bindings`**
   *        （`⌘G`/`⇧⌘G` 从后端那张表里认出来）
   * @param {(id:string) => string} opts.keyText ⭐ 键位显示串（⛔ 不自己拼，`INV-SET-01`）
   * @param {string} opts.nextId 下一个那个动作 id
   * @param {string} opts.prevId 上一个那个动作 id
   * @param {() => boolean} [opts.isAvailable] 现在能不能用（没有已挂载的文档 ⇒ 按了没反应）
   * @param {boolean} [opts.forceFallback] ⚠️ **只给探针用**：强制走 `<mark>` 回退路线
   *        （本机 0a 已通过 ⇒ 这条路线跑不到，⛔ 但它必须写、也必须有办法被验，见 §6）
   */
  function createFindBar(opts) {
    const getDoc = opts.getDoc;
    const keymap = opts.keymap;
    const keyText = opts.keyText || function () { return ''; };
    const nextId = opts.nextId;
    const prevId = opts.prevId;
    const isAvailable = opts.isAvailable || function () { return true; };
    const forceFallback = !!opts.forceFallback;

    let opened = false;
    let restoreTo = null;

    /** ⭐ 段数组（`null` = 还没建 / 已作废）。每段 `{ text, pieces:[{node,startChars}], anchor, runIndex }`。 */
    let segs = null;
    /** 当前这一轮的关键词（归一之后）与命中 + 当前下标。 */
    let query = '';
    let hits = [];
    let current = -1;
    /** 状态机：`idle` / `building` / `ready`。 */
    let phase = 'idle';
    /** 回退路线专用的两个计数器（排障用，进回报）。 */
    let staleRanges = 0;
    let rescanMisses = 0;
    /** 上一次构建/高亮之后攒下的"浮层上那句话"。 */
    let noteText = '';

    // ── DOM（⭐ 由本文件建，⛔ 不在 `index.html` 里写死）─────────────────
    const root = el('div', 'find-layer');
    root.hidden = true;
    const panel = el('div', 'find-panel');
    panel.setAttribute('role', 'search');
    panel.setAttribute('data-i18n-aria-label', 'find.panel-label');
    panel.setAttribute('aria-label', t('find.panel-label'));

    const input = el('input', 'find-input');
    input.type = 'search';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('data-i18n-placeholder', 'find.placeholder');
    input.setAttribute('placeholder', t('find.placeholder'));
    input.setAttribute('data-i18n-aria-label', 'find.input-label');
    input.setAttribute('aria-label', t('find.input-label'));

    // ⚠️ `el()` 的第三个参数是**字典键**（⛔ 不是初始文案）：这一格的文字由 `renderNote()`
    //    现算。以前这里传空串 ⇒ 它被贴上 `data-i18n=""`，**每次换语言** `applyDom()`
    //    都会把计数写成 `(i18n: empty key)`（2026-10-21 探针抓到）。
    const count = el('span', 'find-count');
    count.setAttribute('aria-live', 'polite');

    // ⚠️ 这三个是**装饰字**（箭头/叉），⛔ 不是字典键 —— 传成键会让 `missing()` 永远多三条。
    const prevBtn = el('button', 'find-btn find-prev');
    prevBtn.type = 'button';
    prevBtn.textContent = '↑';
    const nextBtn = el('button', 'find-btn find-next');
    nextBtn.type = 'button';
    nextBtn.textContent = '↓';
    const closeBtn = el('button', 'find-btn find-close');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('data-i18n-aria-label', 'find.close');
    closeBtn.setAttribute('aria-label', t('find.close'));

    const note = el('div', 'find-note');

    panel.appendChild(input);
    panel.appendChild(count);
    panel.appendChild(prevBtn);
    panel.appendChild(nextBtn);
    panel.appendChild(closeBtn);
    panel.appendChild(note);
    root.appendChild(panel);
    document.body.appendChild(root);

    /**
     * 按钮上的提示文字**从后端那张表取**（⛔ 本文件不写键位字面量）。
     *
     * ⚠️ 有键位与没键位是**两句不同的话**（`· 上一个` 与 `上一个`），
     *    所以是两条键、⛔ 不在源码里拼（`design/0025` §2.2.1）。
     * ⚠️ 它读的是**当前语言** ⇒ 切语言时必须重跑（`subscribe` 那一路）。
     */
    function refreshKeyTips() {
      const nk = keyText(nextId);
      const pk = keyText(prevId);
      prevBtn.title = pk ? t('find.prev-title', { key: pk }) : t('find.prev');
      nextBtn.title = nk ? t('find.next-title', { key: nk }) : t('find.next');
      prevBtn.setAttribute('aria-label', prevBtn.title);
      nextBtn.setAttribute('aria-label', nextBtn.title);
    }

    /**
     * 那行说明：**搜索范围** + 键位提示 + 上限说明 + 回退路线的排障数（⛔ 后三个不是常态）。
     *
     * ⭐ **范围那句常驻**（`F.SCOPE_HINT`，2026-10-16 用户裁定加的）：搜索域是**渲染结果**
     *   ⇒ 源码里的 `##`/`**`、链接 URL 都搜不到。这一行是**唯一**告诉用户原因的地方，
     *   ⛔ 别把它挪进"搜不到时才出现"的分支里——那时用户已经问过一次了。
     * ⚠️ 文案住在 `find.js`（纯逻辑、可断言），⛔ 本文件不许另写一份。
     */
    function renderNote() {
      const parts = [];
      // ⚠️ 取**字典键**（`F.SCOPE_HINT_KEY`），⛔ 不取 `F.SCOPE_HINT` 本身——
      //    那是个加载期常量，拿它上屏就等于切语言时冻住（`design/0025` §2.5.1 ②）。
      parts.push(t(F.SCOPE_HINT_KEY));
      if (noteText) parts.push(noteText);
      const nk = keyText(nextId);
      const pk = keyText(prevId);
      if (nk || pk) parts.push(t('find.hint-next', { key: nk }) + ' · ' + t('find.hint-prev', { key: pk }));
      if (phase === 'building') parts.push(t('find.building'));
      note.textContent = parts.filter(function (s) { return !!s; }).join(' · ');
    }

    /**
     * 把一个**外部入口**（事件回调 / 定时回调）包起来。
     *
     * ⚠️⚠️ 为什么必须有它：查找的入口从 `input` / `click` / `requestAnimationFrame`
     * 进来，从这些地方抛出去的东西**先撞 `window.onerror`**——
     * 而 `main.js` 把它接到了 `reportFatal`，于是**一个查找的错会把状态条写成
     * 「⛔ 启动失败」并把 `doc_loaded` 打成 false**，正文看起来像没打开。
     * ⭐ 2026-10-14 实测踩到：`Highlight.apply`（类构造器不能用 `apply` 调）就是这么炸的，
     * 而它**掩盖了真正的错因**——屏幕上只有"启动失败"，没有"Highlight"。
     * ⇒ 错因写在**浮层那句话**上（看得见、且是出错的那一层），⛔ 不静默、也⛔ 不升级成全局故障。
     */
    function guard(what, fn) {
      try {
        return fn();
      } catch (e) {
        // ⚠️ 这条**是给用户看的**（浮层那句话），所以走字典；
        //    而 `what` 传进来的是**字典键**（⛔ 不是中文词）——传中文词就得在
        //    `guard()` 里再翻一次，那等于给 §2.2.1 的"整句进字典"开一个例外。
        const msg = t('find.error', {
          what: t(what),
          msg: String((e && (e.message || e)) || e),
        });
        console.error(msg, e);
        noteText = msg;
        renderNote();
        return undefined;
      }
    }

    function renderCount() {
      // ⚠️⚠️ **构建中不给数字**（`INV-FIND-05` 后半条）：给"已扫到的部分值"
      //     会让人以为"这份文档就这么多命中"，而它是**会涨的**——那是静默的错。
      if (phase === 'building') { count.textContent = '…'; return; }
      if (phase !== 'ready') { count.textContent = ''; return; }
      if (!query) { count.textContent = ''; return; }
      count.textContent = F.countText(current, hits.length);
    }

    // ── 建索引：**分段、可取消**（§2.1 ① 末尾 / §9.4 第 8 条）────────────
    //
    // ⚠️ 为什么必须分段：同步走一遍 40 万文本节点实测 **322 ms**（`notes/0015` §3），
    //    那是主线程上的一个长任务 ⇒ 浮层"打不开"。分段之后**总时长没省**
    //    （判据 ① 因此变成一条**真的关于"可输入"**的闸门），省的是"**可输入**"这个时点。

    /**
     * 扫一棵子树，产出段数组。**同一份规则**既给整篇建索引，也给回退路线重建
     * 某一段的 `pieces`（⛔ 绝不写第二份判据——那是 `INV-SEARCH-02` 那类漂移的成因）。
     *
     * ⭐ 返回一个**可分步推进**的扫描器：`step(deadline)` 跑到超过时限就交还，
     * 好让调用方让出主线程；`Infinity` 就是一口气跑完。
     */
    function createScan(startEl) {
      const state = {
        segs: [],
        cur: null,
        lastBlock: null,
        pendingBreak: true,   // 开头就等于"还没进任何段"
        next: undefined,
        done: false,
        cache: new WeakMap(),
      };

      /** ⚠️ `FILTER_REJECT` 在 **TreeWalker** 上是"剪掉整棵子树"（`NodeIterator` 才是同 `SKIP`）。 */
      function filter(node) {
        if (node.nodeType === 1) {
          const tag = F.tagOf(node);
          if (F.isExcludedTag(tag)) {
            // ⚠️ 在这里记 `pendingBreak`：`REJECT` 之后 walker **再也不会**叫我们，
            //    而"被排除子树的两侧要切开"这件事**只有这一刻**知道。
            state.pendingBreak = true;
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }

      const walker = document.createTreeWalker(startEl, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, filter);

      /** 收尾：把手里那一段推出去。⚠️ 空段不产出（"段里一个字都没有"= 没有段）。 */
      function cut() {
        if (state.cur && state.cur.text.length > 0) state.segs.push(state.cur);
        state.cur = null;
      }

      /**
       * 一个节点的**最近块级祖先**与"在不在 `pre` 里"。
       *
       * ⚠️ 两次判定用**同一次**上行：一次上行走完，两件事都有了（各走一遍就是两倍成本）。
       * ⚠️ 缓存按**父元素**存：段内相邻的文本节点多半同父 ⇒ 命中率很高。
       * ⭐ 在**浅树**上 `WeakMap` 未必划算（`notes/0015` §4 实测过 memoize 反而更慢），
       * 但这里缓存的是"语义判定"而不只是"祖先链长度"，且是**正确性**的落点，不省。
       */
      function blockInfo(parent) {
        if (!parent) return { block: null, inPre: false };
        const hit = state.cache.get(parent);
        if (hit) return hit;
        let block = null;
        let inPre = false;
        let n = parent;
        while (n && n.nodeType === 1) {
          const tag = F.tagOf(n);
          if (tag === 'pre') inPre = true;
          if (!block && F.isBlockTag(tag)) block = n;
          if (n === startEl) break;
          n = n.parentNode;
        }
        if (!block) block = startEl;
        const info = { block: block, inPre: inPre };
        state.cache.set(parent, info);
        return info;
      }

      /** 段开头：把 `anchor`/`runIndex` 一起记下（回退路线靠它把 `pieces` 找回来）。 */
      function openSeg(anchor) {
        const runIndex = state.perAnchor ? (state.perAnchor.get(anchor) || 0) : 0;
        if (state.perAnchor) state.perAnchor.set(anchor, runIndex + 1);
        return { text: '', pieces: [], anchor: anchor, runIndex: runIndex };
      }

      state.perAnchor = new Map();

      function consume(node) {
        if (node.nodeType === 1) {
          const tag = F.tagOf(node);
          // ⚠️ 两条都是**切缝**，但来由不同：`br` 是"屏幕上换了一行"，
          //    块级容器是"进了一个新的视觉块"。合成一条判断会让注释说不清为什么。
          if (tag === 'br' || F.isBlockTag(tag)) cut();
          return;
        }
        const info = blockInfo(node.parentNode);
        const text = node.nodeValue == null ? '' : node.nodeValue;
        // ⭐ 四类切缝里"① 块容器进出"与"③ 被排除子树"都落在这个 `changed` 上。
        const changed = (info.block !== state.lastBlock) || state.pendingBreak;
        const layoutWs = F.isLayoutWhitespace(text, info.inPre);
        if (changed || layoutWs) cut();
        state.lastBlock = info.block;
        state.pendingBreak = false;
        if (layoutWs || text.length === 0) return;   // ⛔ 排版空白与空节点**都不进段**
        if (!state.cur) state.cur = openSeg(info.block);
        state.cur.pieces.push({ node: node, startChars: state.cur.text.length });
        state.cur.text += text;
      }

      /** 跑到 `deadline`（`nowMs()` 口径）为止。@returns {boolean} 扫完了吗 */
      function step(deadline) {
        if (state.done) return true;
        let n = state.next;
        if (n === undefined) n = walker.nextNode();
        let guard = 0;
        while (n) {
          consume(n);
          n = walker.nextNode();
          guard++;
          if ((guard % CLOCK_EVERY) === 0 && nowMs() >= deadline) break;
        }
        state.next = n;
        if (!n) {
          cut();
          state.done = true;
        }
        return state.done;
      }

      return {
        step: step,
        isDone: function () { return state.done; },
        result: function () { return state.segs; },
      };
    }

    /** 一口气扫完（回退路线重建 `pieces` 时用；⚠️ 它**故意不分割**——那是重建路径的取舍）。 */
    function scanSync(startEl) {
      const s = createScan(startEl);
      while (!s.step(Infinity)) { /* 一口气 */ }
      return s.result();
    }

    /** 开一次分段构建。⚠️ 每次作废/重开都 `++buildToken`，让在途的那一轮自己停下。 */
    let buildToken = 0;
    let scanner = null;

    /**
     * 文档**提交成功**之后调一次（`INV-FIND-02`）：整份索引作废 + 高亮清干净。
     * ⚠️ 挂点是 `main.js` 的 `mountDocument()` —— 打开与自动重载**两条路都经过它**，
     * 所以"只有手动打开会作废、自动重载不会"这种漏掉不会发生。
     * ⭐ 浮层**还开着**时（自动重载期间很常见）立刻重建，⛔ 不留一个"搜不到了"的空窗期。
     */
    function invalidate() {
      buildToken++;          // ⚠️ 在途的那一轮会看到 token 变了而**停止写入**
      scanner = null;
      segs = null;
      hits = [];
      current = -1;
      phase = 'idle';
      clearHighlights();
      renderCount();
      renderNote();
      if (opened) startBuild();
    }

    function startBuild() {
      if (segs || phase === 'building') return;
      const doc = getDoc();
      if (!doc) return;
      phase = 'building';
      noteText = '';
      const token = ++buildToken;
      scanner = createScan(doc);
      renderCount();
      renderNote();
      tick(token);
    }

    function tick(token) {
      if (token !== buildToken) return;      // 作废了 ⇒ ⛔ 不写
      // ⚠️ 整段包在 `guard` 里：它跑在 `requestAnimationFrame` 上，抛出去就是全局故障。
      guard('find.what-build', function () {
        const done = scanner.step(nowMs() + BATCH_MS);
        if (token !== buildToken) return;
        if (!done) {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { tick(token); });
          else setTimeout(function () { tick(token); }, 0);
          return;
        }
        segs = scanner.result();
        scanner = null;
        phase = 'ready';
        // ⭐ 索引建好之后**重跑一次当前输入**：构建期间用户可能已经打过字了。
        runSearch(input.value);
        renderCount();
        renderNote();
      });
    }

    // ── 高亮（两档 + `<mark>` 回退）────────────────────────────────────

    /** 走 Custom Highlight 吗（**首选**：零 DOM 变更）。 */
    function useCustomHighlight() {
      if (forceFallback) return false;
      return !!(typeof CSS !== 'undefined' && CSS.highlights &&
        typeof Highlight === 'function' && typeof Highlight.prototype.add === 'function');
    }

    /**
     * 段内 UTF-16 偏移 → `(textNode, offset)`。
     *
     * ⚠️ 节点长度**每次现读**（`nodeValue.length`），⛔ 不用 `pieces` 里记的旧值——
     * 回退路线下 `splitText`/`normalize` 会改长度，用旧值算出来的偏移会**越界或错位**
     * （`INV-FIND-01` ②）。
     */
    function pointAt(seg, offset) {
      const ps = seg.pieces;
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const len = p.node.nodeValue == null ? 0 : p.node.nodeValue.length;
        if (offset <= p.startChars + len) {
          return { node: p.node, offset: Math.max(0, offset - p.startChars) };
        }
      }
      const last = ps[ps.length - 1];
      if (!last) return null;
      return {
        node: last.node,
        offset: (last.node.nodeValue == null ? 0 : last.node.nodeValue.length),
      };
    }

    function rangeFor(hit) {
      const seg = segs && segs[hit.seg];
      if (!seg || !seg.pieces.length) return null;
      const a = pointAt(seg, hit.start);
      const b = pointAt(seg, hit.end);
      if (!a || !b) return null;
      // ⚠️ 只在**回退路线**上查身份：那条路会 `splitText`/`normalize`，
      //    节点可能已经脱离 DOM；走 Custom Highlight 时正文一个节点都没动过，
    //    这次查询纯属白花钱（2000 处 × 2 次 `contains` 是要计时的）。
      if (!useCustomHighlight() && (!getDoc() || !getDoc().contains(a.node))) {
        staleRanges++;
        return null;
      }
      const r = document.createRange();
      try {
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
      } catch (e) {
        staleRanges++;
        return null;
      }
      return r;
    }

    /**
     * 清掉本轮的全部高亮标记。
     *
     * ⚠️⚠️ **回退路线要两条一起做**（`INV-FIND-01` ②，评审 `R2` 点出的）：
     * ① 摘掉 `<mark>` 并把文本并回去（`normalize()`）；
     * ② **重建受影响段的 `pieces`**——`normalize()` 只恢复**文本内容**、
     *    ⛔ **不恢复节点身份**：被合并掉的那些 Text 已经不在 DOM 里，
     *    `pieces[i].node` 成了废引用、`startChars` 可能超过该节点的新长度。
     * ⇒ 光"清干净"**修不了**这一条，这正是 `R2` 的本意。
     */
    function clearHighlights() {
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete(F.HL_ALL);
        CSS.highlights.delete(F.HL_CURRENT);
      }
      const doc = getDoc();
      if (!doc) return;
      const marks = doc.querySelectorAll('mark.rmd-find-hit, mark.rmd-find-current');
      if (!marks.length) return;
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        const p = m.parentNode;
        if (!p) continue;
        while (m.firstChild) p.insertBefore(m.firstChild, m);
        p.removeChild(m);
      }
      // ⚠️ `normalize()` 之后节点身份全变 ⇒ 下面的重建是**必须的**，不是优化。
      doc.normalize();
      rebuildPiecesAfterClear();
    }

    /**
     * 清完之后把受影响的段的 `pieces` 找回来。
     *
     * ⭐ 手法是"**回到那一段的锚点、用同一份规则重扫一遍**"：
     * `anchor` 是这个段所属的那个块级容器，`runIndex` 是它下面第几个 run
     * （同一个锚点在同一份 DOM 上重扫**必然产出同样的顺序**）。
     * ⚠️ 对不上（文本都变了）⇒ 记 `rescanMisses` 并**整份重建**——
     * 宁可慢，⛔ 也不能拿废引用接着算（那正是"第三次才错"的累积漂移）。
     */
    function rebuildPiecesAfterClear() {
      if (!segs) return;
      const byAnchor = new Map();
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (!seg.anchor) return void fullRebuild();
        let runs = byAnchor.get(seg.anchor);
        if (!runs) {
          runs = scanSync(seg.anchor);
          byAnchor.set(seg.anchor, runs);
        }
        const r = runs[seg.runIndex];
        if (!r || r.text !== seg.text) {
          rescanMisses++;
          return void fullRebuild();
        }
        seg.pieces = r.pieces;
      }
    }

    /** 兜底：整份索引重扫一次（只在回退路线"找回不来"时发生）。 */
    function fullRebuild() {
      const doc = getDoc();
      if (!doc) return;
      segs = scanSync(doc);
    }

    /**
     * 把一批命中包进 `<mark>`（⛔ **只有回退路线走到这里**）。
     *
     * ⚠️⚠️ **两条次序纪律，缺一条就会"第三次才错"**：
     *  ① **先算完所有 `(node, from, to)`，再开始切 DOM**。`splitText` 会把节点截短，
     *     而 `pointAt` 的偏移是相对**当时那个节点**算的 ⇒ 边算边切，后面那些落点全会错位。
     *  ② **从后往前包**。同一节点上有多处命中时，先切高偏移的那一处，
     *     低偏移那处的数据**一个字符都没被动过**。
     *
     * @param {Array} shown 要包的命中（**文档序**：段序 → 段内先后）
     * @param {number} curIdx `current` 在 `shown` 里的下标（`-1` = 当前那处不在这一批里）
     */
    function markHits(shown, curIdx) {
      if (!getDoc()) return;
      const jobs = [];
      for (let i = 0; i < shown.length; i++) {
        const seg = segs[shown[i].seg];
        if (!seg) continue;
        const a = pointAt(seg, shown[i].start);
        const b = pointAt(seg, shown[i].end);
        if (!a || !b) { staleRanges++; continue; }
        // ⚠️ 落点存的是**节点身份**（不是偏移字符串）：一个节点的 `nodeValue` 在
        //    切分之后会变，所以这里**顺带存下当时读到的长度**，供 `wrapOne` 判断"尾巴还在不在"。
        jobs.push({ seg: seg, a: a, b: b, cur: i === curIdx });
      }
      for (let i = jobs.length - 1; i >= 0; i--) wrapOne(jobs[i]);
    }

    /**
     * 包一处。⭐ 用**段内 pieces** 定位起止节点——`pieces` 按文档序排，所以
     * "中间那些整块落在命中里的文本节点"就是 `pieces[iFrom+1 … iTo-1]`，
     * ⛔ 不需要再走一遍 DOM，也不会把**块外的**节点框进来。
     */
    function wrapOne(job) {
      const ps = job.seg.pieces;
      let iFrom = -1;
      let iTo = -1;
      for (let i = 0; i < ps.length; i++) {
        if (ps[i].node === job.a.node) iFrom = i;
        if (ps[i].node === job.b.node) iTo = i;
      }
      if (iFrom < 0 || iTo < 0 || iFrom > iTo) { staleRanges++; return; }
      const cls = job.cur ? 'rmd-find-current' : 'rmd-find-hit';
      // ⚠️ 从后往前（高偏移 → 低偏移）：切后面的不动前面的字符。
      for (let i = iTo; i >= iFrom; i--) {
        const node = ps[i].node;
        if (!node || !node.parentNode || node.nodeType !== 3) continue;
        const len = node.nodeValue.length;
        const from = (i === iFrom) ? job.a.offset : 0;
        const to = (i === iTo) ? job.b.offset : len;
        if (to <= from || from < 0 || to > len) continue;
        const m = document.createElement('mark');
        m.className = cls;
        let mid = node;
        if (to < mid.nodeValue.length) mid.splitText(to);   // 切出尾巴（返回值不用）
        if (from > 0) mid = mid.splitText(from);            // 再切出头，`mid` 就是 [from,to)
        mid.parentNode.insertBefore(m, mid);
        m.appendChild(mid);
      }
    }

    /**
     * 上高亮（两档 + 上限）。
     * ⚠️ 上限只截**视觉标记**，⛔ 不截计数（`INV-FIND-05`）——`noteText` 用的是 `cap.total`。
     */
    function highlight() {
      const cap = F.clampHits(hits, F.HIGHLIGHT_CAP);
      const shown = hits.slice(0, cap.shown);
      const cur = (current >= 0 && current < hits.length) ? hits[current] : null;
      // ⚠️ `current` 一定是 `shown` 里的某一个（它按文档序排，且下标在前）——
      //    但**不要假设**：超出上限时"当前那处"照样要亮（设计 §2.1 ③ 明写）。
      let curIdx = -1;
      for (let i = 0; i < shown.length; i++) if (shown[i] === cur) { curIdx = i; break; }
      if (useCustomHighlight()) {
        const ranges = [];
        for (let i = 0; i < shown.length; i++) {
          const r = rangeFor(shown[i]);
          if (r) ranges.push(r);
        }
        // ⚠️⚠️ 必须是**展开**（`new Highlight(...ranges)`），⛔ 不能写 `Highlight.apply(null, ranges)`——
        //     那会变成 `new (Highlight.apply)(…)`，而 `apply` 内部再去**不带 `new`** 地调
        //     `Highlight`（它是 `Set` 的子类、一个**类构造器**）⇒ 立刻
        //     `TypeError: Class constructor Highlight cannot be invoked without 'new'`。
        //     ⚠️ 这条**2026-10-14 冒烟真抓到了**：抛错点在 `setTimeout` 里，
        //     逃出了 `probe()` 的 Promise、撞上 `window.onerror` ⇒ 整个阅读器
        //     被 `reportFatal` 打成「启动失败」（`design/0011` §10）。⛔ 别"顺手简化"回去。
        if (ranges.length) CSS.highlights.set(F.HL_ALL, new Highlight(...ranges));
        else CSS.highlights.delete(F.HL_ALL);
        const cr = cur ? rangeFor(cur) : null;
        // ⭐ **顺序**：`HL_CURRENT` 后设 ⇒ 两档重叠处它赢（后注册的覆盖先注册的）。
        //    ⚠️ 这一条**只到 CSS 规范层**，本机**未目视验过**（`notes/0015` §8 第 1 条）——
        //    所以 `find.css` 里两档的取值**本身就分得开**，即使重叠处判给了 `hit` 也读得出。
        if (cr) CSS.highlights.set(F.HL_CURRENT, new Highlight(cr));
        else CSS.highlights.delete(F.HL_CURRENT);
      } else {
        // ⚠️ 上限之外的那处**也要包**（`curIdx === -1` 那种情形）⇒ 分两批，⛔ 不重复包同一处。
        markHits(shown, curIdx);
        if (cur && curIdx < 0) markHits([cur], 0);
      }
      noteText = F.capNote(cap.total, cap.shown);
    }

    // ── 搜索与导航 ───────────────────────────────────────────────────

    function runSearch(raw) {
      query = F.normalizeQuery(raw);
      if (!segs || !query) {
        hits = [];
        current = -1;
        clearHighlights();
        noteText = '';
        renderCount();
        renderNote();
        return;
      }
      // ⭐ **每一轮都先清**：首选路线下这只是两次 `CSS.highlights.delete`（零 DOM 变更），
      //    回退路线下它才是那件必须做对的事（清 `<mark>` + 重建 `pieces`）。
      clearHighlights();
      hits = F.matchAll(segs.map(function (s) { return s.text; }), query);
      current = hits.length ? 0 : -1;
      highlight();
      renderCount();
      renderNote();
      if (current >= 0) reveal(current);
    }

    /** 把某处命中滚进视口（**完整**落在顶栏之下、底边之上）。 */
    function reveal(i) {
      const hit = hits[i];
      if (!hit) return;
      const r = rangeFor(hit);
      if (!r) return;
      const rect = r.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      // ⚠️ 上限取"顶栏"与"浮层下沿"里**更靠下**的那个：浮层是 `position:fixed` 压在
      //    正文上方的一块，只让过顶栏的话，命中的第一行会被浮层盖住——
      //    表现是"按了下一个，屏幕上什么都没变"（其实变的是被挡住的那一行）。
      let top = 0;
      const bar = document.querySelector('.topbar');
      if (bar && bar.getBoundingClientRect) {
        const br = bar.getBoundingClientRect();
        if (br && br.height > 0) top = Math.max(top, br.bottom);
      }
      const pr = panel.getBoundingClientRect();
      if (pr && pr.height > 0 && !root.hidden) top = Math.max(top, pr.bottom);
      const bottomLimit = window.innerHeight;
      if (rect.top < top + EDGE_PAD) window.scrollBy(0, rect.top - (top + EDGE_PAD));
      else if (rect.bottom > bottomLimit - EDGE_PAD) {
        window.scrollBy(0, rect.bottom - (bottomLimit - EDGE_PAD));
      }
    }

    function move(dir) {
      if (phase !== 'ready' || !hits.length) return false;
      const prev = current;
      current = F.step(current, hits.length, dir);
      if (current === prev) return true;
      highlight();
      renderCount();
      reveal(current);
      return true;
    }

    /**
     * 下一个 / 上一个的**唯一入口**（`⌘G`/`⇧⌘G` 与 ↑↓ 都走这里）。
     *
     * ⚠️⚠️ **浮层没开时返回 `false` 且什么都不做**（§9.1 第 5 条：明确的 no-op）——
     * ⛔ 不顺手把浮层打开：`⌘G` 离开"查找中"就没有意义，
     * 而在浏览时按一下弹出一个空浮层是**抢焦点**。
     */
    function next() { return opened ? move(1) : false; }
    function prev() { return opened ? move(-1) : false; }

    // ── 键盘（本层自己的，⛔ 与全局分发器不重叠）─────────────────────

    function onKeydown(e) {
      if (!opened) return;
      // ⭐⭐ **组合态必须先挡**（`INV-FIND-09`，评审 `R4` 点名）：
      //    中文候选窗口开着时，`Enter` 是"上屏"、↑↓ 是"翻候选"。
      //    不挡的话，"按回车选字"会变成"跳到下一处"——提交一次**用户没打算做的搜索动作**。
      //    ⚠️ 全局分发器（`keymap.js::dispatch`）挡的是**它自己那条路**，
      //    ⛔ 挡不到浮层的本地处理 ⇒ 这一道必须在这里单写。
      if (K.isComposingEvent(e)) return;

      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        move(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(-1); return; }
      if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); input.focus(); return; }

      // ⭐ `⌘G`/`⇧⌘G`：**从后端那张表里认**（`INV-SET-01`）——
      //    ⛔ 本文件里没有键位字面量，且与全局分发器用**同一份匹配算法**。
      const id = K.matchEvent(keymap ? keymap.bindings : [], e);
      if (id === nextId) { e.preventDefault(); e.stopPropagation(); move(1); return; }
      if (id === prevId) { e.preventDefault(); e.stopPropagation(); move(-1); return; }
      // 其余一律放行：普通字符要正常进输入框。
    }

    // ⭐ 切语言：这一层的两处**现算**文案（键位提示那句、说明行那句）要重贴。
    //    ⚠️ 静态属性（`data-i18n*` 那三处）由 `setLang()` 里的 `applyDom` 管，
    //    ⛔ 这里不许再贴一遍——两份都在写同一批属性，谁后写谁赢，那就成了两份真值。
    if (I18N) {
      I18N.subscribe(function () { refreshKeyTips(); renderNote(); });
    }

    // ⚠️ 用 **capture**（与搜索浮层同一条理由）：`Esc`/方向键/回车都得在页面其余部分
    //    看到之前拦下；且挂在 `document` 上而不是输入框上——焦点万一跑到别处，
    //    `Esc` 仍然要能关掉它。
    document.addEventListener('keydown', onKeydown, true);

    input.addEventListener('input', function () { guard('find.what-search', function () { runSearch(input.value); }); });
    nextBtn.addEventListener('click', function () { guard('find.what-next', function () { next(); }); });
    prevBtn.addEventListener('click', function () { guard('find.what-prev', function () { prev(); }); });
    closeBtn.addEventListener('click', function () { guard('find.what-close', function () { close(); }); });

    // ── 开 / 关 ──────────────────────────────────────────────────────

    /**
     * 打开浮层（`⌘F`）。
     *
     * ⚠️ **已开时是"保持现状"**：`⌘F` 在输入框有焦点时根本到不了全局分发器
     *    （`isEditableElement` 那道挡），所以这里只管"没开 ⇒ 开"。
     *
     * @returns {boolean} 真的能用吗（没有已挂载的文档 ⇒ 按了没反应）
     */
    function open() {
      if (opened) { input.focus(); return true; }
      if (!isAvailable()) return false;
      // ⭐ 开一层就关另外两层（`INV-FIND-06`）：设置覆盖层 / `⌘P` 浮层。
      St.closeOtherOverlays(NAME);
      restoreTo = document.activeElement;
      opened = true;
      root.hidden = false;
      document.body.classList.add('find-open');
      refreshKeyTips();
      renderNote();
      // ⭐ **浮层先可输入**：`startBuild()` 是**分段**的，输入框这一刻已经能打字了
      //    （§2.1 ① 末尾 / §9.4 第 8 条）。⚠️ 索引**只按需建**（`INV-FIND-08`）。
      startBuild();
      input.focus();
      // ⭐ 输入框里的旧词要**接得上**：`⌘F` 关掉再开（或浮层还开着时切回来）不该丢上一次的搜索。
      if (input.value) input.select();
      if (segs && query) runSearch(input.value);
      else renderCount();
      return true;
    }

    function close() {
      if (!opened) return;
      opened = false;
      root.hidden = true;
      document.body.classList.remove('find-open');
      // ⭐ 关掉就**清干净高亮**（`INV-FIND-01`）——⛔ 不留一地半透明标记。
      clearHighlights();
      current = -1;
      renderCount();
      // ⭐ 把焦点还给它打开前的那个元素（`INV-FIND-06` 的同族要求）：不还的话
      //    焦点掉到 `body` 上，键盘用户下次按 Tab 要重新找一遍。
      const back = restoreTo;
      restoreTo = null;
      if (back && typeof back.focus === 'function' && document.contains(back)) {
        try { back.focus(); } catch (e) { /* 不可聚焦就作罢，⛔ 不抛 */ }
      }
      if (St.currentFocusOwner() === NAME) St.releaseFocusOwner(NAME);
    }

    /** `⌘F`：开着就关、关着就开（菜单/快捷键两条路都走这一个）。 */
    function toggle() {
      if (opened) { close(); return true; }
      return open();
    }

    // ── 给 `report_status` 用的自证（`design/0011` §3）─────────────────
    //
    // ⚠️ 它**自己驱动一遍**完整路径（开浮层 → 建索引 → 搜 → 核 `Range` 文本 → 搜哨兵 → 关），
    //    ⛔ 不靠人按 `⌘F`——冒烟跑在没人看的窗口里，判据必须自己走完。
    // ⭐ 探测词**从第一段文本里取**（一定存在）⇒ 这一条在**任何**语料上都成立，
    //    ⛔ 不需要为每个语料写一个"已知命中数"的常量表（那种表迟早会与语料漂开）。

    /**
     * @returns {Promise<{open:boolean,seg:number,building:boolean,query:string,
     *   hits:number,text_ok:boolean,miss:number,stale:number,rescan:number,note:string}>}
     */
    function probe() {
      return new Promise(function (resolve) {
        const out = {
          open: false, seg: 0, building: false, query: '', hits: -1,
          text_ok: false, miss: -1, stale: staleRanges, rescan: rescanMisses, note: '',
        };
        function finish() {
          // ⚠️ 收尾：**关掉浮层并清干净**，让后面的回报看到的是平时那个状态
          //    （它不改变正文，但留着一层浮层会让别的判据读数分心）。
          close();
          out.stale = staleRanges;
          out.rescan = rescanMisses;
          out.building = phase === 'building';
          resolve(out);
        }
        const opened_ok = open();
        if (!opened_ok) { out.note = '没有已挂载的文档'; finish(); return; }
        out.open = true;
        let waited = 0;
        function waitReady() {
          // ⚠️⚠️ **这一整段必须自己包 try/catch**：它跑在 `setTimeout` 里，
          //    而 `setTimeout` 抛出去的东西**不会被 `await probe()` 接住**——
          //    它直接走 `window.onerror` → `reportFatal` ⇒ 一个**查找**的错
          //    会把整个阅读器报成「启动失败」（2026-10-14 实测踩到，见 `design/0011` §10）。
          //    ⭐ 探针是**仪表**：它自己怎么坏都不许把被测的东西带下水。
          try {
            if (phase === 'building') {
              waited++;
              if (waited > 6000) { out.note = '索引构建超时'; finish(); return; }
              setTimeout(waitReady, 5);
              return;
            }
            out.seg = segs ? segs.length : 0;
            const first = segs && segs.length ? segs[0].text : '';
            const q = F.probeQueryText(first, 4);
            if (!q) { out.note = '正文里找不到可用的非空白词（探测不了）'; finish(); return; }
            out.query = q;
            input.value = q;
            runSearch(q);
            out.hits = hits.length;
            // ⭐ 判据："**高亮所在的可见文本 == 用户输入的词**"（`design/0011` §7 第 4 步）。
            //    ⚠️ 这是渲染域方案里**唯一**能证明"偏移没错位"的东西——中文/Emoji 全靠它。
            const r = (hits.length && hits[0]) ? rangeFor(hits[0]) : null;
            out.text_ok = !!(r && r.toString() === q);
            if (r && r.toString() !== q) out.note = '命中区间读出来是「' + r.toString() + '」';
            // ⭐ 反面对照：一个**一定搜不到**的词必须命中 0 处。
            //    ⚠️ 只验"搜到了"会被一个**永远返回全部段**的实现骗过。
            const before = query;
            runSearch(F.PROBE_SENTINEL);
            out.miss = hits.length;
            runSearch(before);
            finish();
          } catch (e) {
            out.note = '自证抛错：' + String((e && (e.message || e)) || e);
            finish();
          }
        }
        waitReady();
      });
    }

    const handle = {
      open: open,
      close: close,
      toggle: toggle,
      next: next,
      prev: prev,
      isOpen: function () { return opened; },
      /** ⭐ 文档提交成功时调（`INV-FIND-02`）。 */
      invalidate: invalidate,
      /** ⭐ 冒烟的前端自证（`design/0011` §3）。 */
      probe: probe,
      /** 只给回报/单测读的观测量。⚠️ 不许拿它当第二份真值。 */
      state: function () {
        return {
          phase: phase,
          segments: segs ? segs.length : 0,
          total: hits.length,
          current: current,
          query: query,
          customHighlight: useCustomHighlight(),
          staleRanges: staleRanges,
          rescanMisses: rescanMisses,
        };
      },
      destroy: function () {
        document.removeEventListener('keydown', onKeydown, true);
        if (root.parentNode) root.parentNode.removeChild(root);
      },
    };

    // ⭐ 注册进**唯一那个**登记处（与设置覆盖层、搜索浮层共用，`INV-FIND-06`）
    St.registerOverlay(NAME, handle);
    return handle;
  }

  const api = { createFindBar: createFindBar, NAME: NAME };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).findBar = api;
})();
