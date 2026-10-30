// 正文内查找的**纯逻辑** —— `design/0011-正文内查找.md`（2026-10-14 已通过）。
//
// # 为什么"段边界"的判据在**这一份**里
//
// `INV-FIND-03` 把"段"定义成四条截断点切出来的**连续 run**。那四条判据**本身**
// （哪些标签算块级、哪些子树被排除、什么叫"排版空白"）放在这里，因为它们是
// 本设计里最容易写错、也最容易被"顺手优化"改坏的一段——放进纯逻辑 ⇒
// `node --test` 能逐条钉住（`tests/js/find.test.js`），⛔ 不必把 DOM 拖进单测。
// ⚠️ 走树、造 `Range`、上高亮那半**必须真 DOM**，在 `components/FindBar.js` 里。
//
// # 为什么不提供 `el.textContent` 那条快路径（`INV-FIND-10`）
//
// `INV-FIND-10` 允许它当"段内没有被排除子树"时的**等价快路径**，但**不允许**
// 因为快慢路径对不上而丢段。本实现**一条都不用**：段的 `pieces` 本来就要逐节点建
// （高亮要靠它把偏移落回 `(textNode, offset)`），所以 `textContent` 在这里
// **无处可省**——多调一次只是白花钱。
// ⇒ 「快慢路径不一致」这个失败面在本实现里**不存在**（比不变量要求的更强）。
//
// # ⛔ 本文件里没有按键字面量
//
// 键位显示一律走 `main.js` 的 `accelText(id)`（`INV-SET-01`／`INV-FIND-08`）。
// ⚠️ 这条由 `tests/js/keymap.test.js` 的源码级闸门盯着（⛔ 不是靠人自觉）。

(function () {
  'use strict';

  // ⭐ 翻译函数（`design/0025` §2.5.1 ②）：**每次渲染时取**，⛔ 不在加载期缓存译文
  //    （那样切一次语言就冻住了）。浏览器走 `window.rmd.i18n`，`node --test` 走 `require`。
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) ||
    (typeof module !== 'undefined' && module.exports ? require('./i18n.js') : null);
  const t = I18N ? I18N.t : function (key) { return key; };

  /**
   * "其余命中"最多高亮这么多处（`INV-FIND-05`）。
   *
   * ⭐ **计数永远是真的总数**，这个上限只截断**视觉标记**，并且会在浮层上写明。
   * ⚠️⚠️ 它同时是"每次输入刷新 ≤ 50 ms"这条判据的**前提**，⛔ 不是"诚实性 vs 性能"的取舍：
   * 实测 40 万处全亮 **360–438 ms**，而限在 2000 处只要 **1–2 ms**，**计数扫描一个字没少**
   * （`research/notes/0015` §5）。⇒ 想动这个数，得连 §7 步骤 0c 的判据 ② 一起重拍。
   */
  const HIGHLIGHT_CAP = 2000;

  /**
   * 两档高亮的注册名（`CSS.highlights` 的键，也是 `::highlight(...)` 里的名字）。
   *
   * ⚠️ 它们与 `src/styles/find.css` 里的两处伪元素**逐字相同**——
   * `tests/js/find.test.js` 有一条断言把这两个串读出来去 grep 那张 CSS（⛔ 不靠人对照）。
   */
  const HL_ALL = 'rmd-find';
  const HL_CURRENT = 'rmd-find-current';

  /**
   * **块级容器**白名单（`INV-FIND-03` 的截断点 ①）。
   *
   * ⚠️ 判据是"**最近的那个块级祖先变了没有**"，⛔ **不读 `getComputedStyle`**：
   * 那会为每个元素付一次样式解析，还会把"段边界"绑到运行期样式上
   * （`INV-THEME-04` 保证主题不改尺度，所以白名单是**确定的**）。
   *
   * ⭐ 这张表**必须含** `TABLE` 那一族（`TABLE/THEAD/TBODY/TFOOT/TR/TD/TH`）——
   * 有了它们，"每个单元格各自成段"是**自动**的，⛔ 不需要给单元格边界另写规则。
   * ⚠️ 与语料实际出现的标签集对过表（`design/0011` §7 的单测），
   * 漏一个的表现是「高亮跨了两个视觉块」——**不报错**，只是看起来莫名其妙。
   */
  const BLOCK_TAGS = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'td', 'th', 'table', 'thead', 'tbody', 'tfoot', 'tr',
    'pre', 'blockquote', 'dt', 'dd', 'figcaption', 'figure', 'div', 'hr',
    'ul', 'ol', 'dl', 'section', 'article', 'aside', 'header', 'footer',
    'main', 'nav', 'details', 'summary', 'caption',
  ]);

  /**
   * **被排除的子树**（`INV-FIND-03` 的截断点 ③，取舍见 `design/0011` §4）。
   *
   * ⚠️ 排除的是**公式/图自身的内容**，⛔ **不是"含公式的整个段落"**——
   * `<p>索引<math>…</math>回滚</p>` 里的 `索引` 与 `回滚` **照常可搜**
   * （`INV-FIND-10`；这一条是评审 `R5` 点名要写准的范围）。
   */
  const EXCLUDED_TAGS = new Set(['svg', 'math']);

  function tagOf(node) {
    return String((node && node.nodeName) || '').toLowerCase();
  }

  /** 这个标签是块级容器吗（截断点 ①）。 */
  function isBlockTag(tag) {
    return BLOCK_TAGS.has(String(tag || '').toLowerCase());
  }

  /** 这个标签的子树被排除吗（截断点 ③）。 */
  function isExcludedTag(tag) {
    return EXCLUDED_TAGS.has(String(tag || '').toLowerCase());
  }

  /**
   * 这是一个"**排版空白**"文本节点吗（截断点 ④）。
   *
   * ⭐ 判据（一手：`comrak-0.56.0/src/html.rs`）：**整个节点只含空白字符，且祖先链上没有 `<pre>`**。
   * ⚠️ 那一手依据是：comrak 的 `cr()` / `lf()` 会在标签排版之间写换行
   * （`render_table` 写完 `<table>`/`</table>` 后 `lf()`，`html.rs:1113-1140`），
   * ⇒ DOM 里会有**用户没写、也看不见**的文本节点。它们是分隔符，**不进任何段**。
   * ⚠️ 反过来说 ⛔ **不是"凡空白就删"**：`<pre>` 里的换行是**可见内容**
   * （`white-space` 保留它）⇒ 用"祖先链上没有 `pre`"把两类分开。
   *
   * ⚠️ 长度为 0 的节点**不算截断点**（它既不是空白也不是内容，跳过即可）——
   * 把它当截断点会在行内元素之间造出**假段边界**。
   *
   * @param {string} text 该文本节点的内容
   * @param {boolean} inPre 它在 `<pre>` 后代里吗
   */
  function isLayoutWhitespace(text, inPre) {
    if (inPre) return false;
    const s = String(text == null ? '' : text);
    if (s.length === 0) return false;
    return s.trim() === '';
  }

  /**
   * 关键词归一：**只有空白的关键词等于没输入**（⛔ 不是"搜一个空格"）。
   *
   * ⚠️ 这条是 `design/0011` §7 单测明确要求的「空关键词、只有空白的关键词 ⇒
   * 空命中 + **明确状态**」——而"明确状态"由调用方给（⛔ 不是 `0 / 0` 裸显示）。
   * ⭐ 它与截断点 ④ 是同一件事的两面：既然排版空白不进段，搜一个空格就几乎
   * 只能命中正文里真实存在的空格，那种"搜到了几十万处"的语料都是假的。
   */
  function normalizeQuery(q) {
    const s = String(q == null ? '' : q);
    return s.trim() === '' ? '' : s;
  }

  /**
   * 在段文本上做**非重叠**匹配（语义与 `document/search.rs` 一致）。
   *
   * ⚠️ 非重叠 = 找完一处**从它的结尾继续**：`aaaa` 里搜 `aa` 是 **2** 处，⛔ 不是 3 处。
   * ⭐ 与源域那份实现同口径是**刻意**的：两份实现搜的是两个空间，但"什么算一处命中"
   * 不能各说各话（否则同一个人在两处看到的数字不一致）。
   *
   * @param {string[]} texts 每段的文本（**纯字符串** ⇒ 单测可以喂普通数组）
   * @param {string} query 归一之后的关键词（空串 ⇒ 没有命中）
   * @returns {{seg:number,start:number,end:number}[]} 按段序、段内先后；偏移是 UTF-16 码元
   */
  function matchAll(texts, query) {
    const out = [];
    const q = normalizeQuery(query);
    if (!q) return out;
    const arr = texts || [];
    for (let i = 0; i < arr.length; i++) {
      const t = String(arr[i] == null ? '' : arr[i]);
      let from = 0;
      for (;;) {
        const p = t.indexOf(q, from);
        if (p < 0) break;
        out.push({ seg: i, start: p, end: p + q.length });
        from = p + q.length;      // ⛔ 非重叠
      }
    }
    return out;
  }

  /**
   * 按上限截断**高亮**（⛔ **不截断计数**）。
   *
   * @returns {{shown:number,total:number,truncated:boolean}}
   */
  function clampHits(hits, cap) {
    const total = (hits || []).length;
    const c = (typeof cap === 'number' && cap >= 0) ? cap : HIGHLIGHT_CAP;
    const shown = Math.min(total, c);
    return { shown: shown, total: total, truncated: total > shown };
  }

  /**
   * 推进"当前是第几处"，**两端环绕**。
   *
   * @param {number} cur 当前下标（从 0 起；**-1 = 还没有当前**）
   * @param {number} total
   * @param {number} dir `1` = 下一个，`-1` = 上一个
   * @returns {number} 新的下标（`total <= 0` 时是 -1）
   */
  function step(cur, total, dir) {
    if (total <= 0) return -1;
    const d = dir < 0 ? -1 : 1;
    if (cur < 0 || cur >= total) return d > 0 ? 0 : total - 1;
    const n = cur + d;
    if (n < 0) return total - 1;
    if (n >= total) return 0;
    return n;
  }

  /**
   * 千位分隔，**用空格**。
   *
   * ⚠️ 用空格而不是 `,`：`design/0011` §2.1 ③ 那句原文就是「已高亮前 **2 000** 处」，
   * 而中文正文里夹一个逗号会与句读混起来。
   */
  function group(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  /** 「第几 / 共几」那一行。⚠️ 无结果时**不给数字**（`INV-FIND-05` 后半条）。 */
  function countText(cur, total) {
    if (total <= 0) return t('find.none');
    return group(cur + 1) + ' / ' + group(total);
  }

  /** 超限时那句说明（⛔ 两个数都要在）。 */
  function capNote(total, shown) {
    if (total <= shown) return '';
    return t('find.cap-note', { total: group(total), shown: group(shown) });
  }

  /**
   * 从一段文本里取一个"**一定存在**"的探测关键词（只给冒烟的前端自证用，§3）。
   *
   * ⚠️ 取的是**前 n 个码点**，⛔ **不从代理对中间切开**——切出半个代理对的关键词
   * 永远匹配不上，而那会被误读成"查找坏了"（其实是探测件自己的 bug）。
   * ⚠️ 到**词尾就停**（不跨空白）：短一点更稳，且不会把跨词的片段当成关键词。
   *
   * @returns {string} 空串 = 这段文本里没有可用的非空白字符（调用方要**响亮**处理）
   */
  function probeQueryText(text, n) {
    const want = (typeof n === 'number' && n > 0) ? n : 4;
    const s = String(text == null ? '' : text);
    let i = 0;
    while (i < s.length && /\s/.test(s.charAt(i))) i++;
    let out = '';
    let count = 0;
    while (i < s.length && count < want) {
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      if (/\s/.test(ch)) break;
      out += ch;
      i += ch.length;
      count++;
    }
    return out;
  }

  /**
   * 冒烟探测用的"一定**搜不到**"的哨兵词（§3：对固定文件搜固定词，命中数要是**已知值**）。
   *
   * ⚠️ 用 U+2063（INVISIBLE SEPARATOR）夹一段 ASCII：两样都是真实语料里
   * 基本不可能出现的东西，而**只有真的走了匹配**才会知道它命中 0 处
   * （⛔ 一个坏的实现会报"0"——所以这一条的判据是**两条一起**：
   * 探测词命中 ≥ 1 **且** 哨兵命中 = 0）。
   */
  const PROBE_SENTINEL = '⁣rmd-find-probe⁣';

  /**
   * ⭐ **搜索范围的那句话**——浮层上**常驻**的一行（`FindBar` 的 `renderNote()` 第一个 part）。
   *
   * ⚠️ 为什么它必须在**界面上**说出来：`INV-FIND-04` 定的搜索域是 **`#doc` 的渲染结果**，
   * 于是 markdown 标记本身（`##`、`**`）、链接的 URL、纯 HTML 块的内容**搜不到**。
   * 这是对阅读器**正确**的选择（§2.1 的 §6.2 回应），但用户若习惯"在源码里找 `##`"
   * 会觉得是**坏了**，而当前没有任何东西告诉他原因 ⇒ 2026-10-16 用户裁定：
   * **接受"只搜渲染预览"，但界面要明确提示范围**（源码查找另立需求）。
   *
   * ⚠️ 它住在这里（纯逻辑模块）而不是 `FindBar.js`，是为了**可断言**——
   * `FindBar.js` 不进 `tests/js/`（它碰 DOM），`find.test.js` 只能读它的源码。
   * 与 `HL_ALL`/`HL_CURRENT` 同一条纪律：字符串改一边忘另一边 = **静默失效**。
   */
  const SCOPE_HINT = '范围：渲染后的正文（不含 Markdown 源码标记）';

  /**
   * ⭐ 界面上那句范围提示的**字典键**（`design/0025`）。
   *
   * ⚠️ 为什么不直接把 `SCOPE_HINT` 拿去显示：它是一个**加载期常量**，
   * 拿它当译文就等于**切语言时冻住**（§2.5.1 ②）。所以界面侧永远走 `t(SCOPE_HINT_KEY)`，
   * 而 `SCOPE_HINT` 只作为**中文原文的锚点**留下——`tests/js/i18n.test.js` 有一条
   * 断言 `t('find.scope') （zh）=== SCOPE_HINT` **逐字相等**，两边漂了会红。
   */
  const SCOPE_HINT_KEY = 'find.scope';

  const api = {
    HIGHLIGHT_CAP: HIGHLIGHT_CAP,
    HL_ALL: HL_ALL,
    HL_CURRENT: HL_CURRENT,
    BLOCK_TAGS: BLOCK_TAGS,
    EXCLUDED_TAGS: EXCLUDED_TAGS,
    PROBE_SENTINEL: PROBE_SENTINEL,
    SCOPE_HINT: SCOPE_HINT,
    SCOPE_HINT_KEY: SCOPE_HINT_KEY,
    tagOf: tagOf,
    isBlockTag: isBlockTag,
    isExcludedTag: isExcludedTag,
    isLayoutWhitespace: isLayoutWhitespace,
    normalizeQuery: normalizeQuery,
    matchAll: matchAll,
    clampHits: clampHits,
    step: step,
    group: group,
    countText: countText,
    capNote: capNote,
    probeQueryText: probeQueryText,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).find = api;
})();
