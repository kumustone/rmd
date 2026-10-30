// 文件名搜索的**纯逻辑** —— `design/0009-文件名模糊搜索.md` §2.1 ③⑥（2026-10-14 已通过）。
//
// # 这个文件里有什么
//
// ① ⭐ **命中区间：UTF-8 字节 → UTF-16 码元**（`INV-SEARCH-03` 的后半句）。
//    后端回的是**原文件名上的字节区间**（Rust 侧一切偏移都是 UTF-8 字节，
//    `document/search.rs` 与 `offset.rs` 同一条纪律），而 DOM / `String.prototype.slice`
//    用的是 **UTF-16 码元**。⛔ 不换算的话：ASCII 名字恰好也对，
//    中文名会**切进字符中间**，Emoji 更会整体错位半个字符——
//    这是本项目最容易静默出错的地方（`docs/vision/0001` §6.2 点名过）。
// ② **`req` / 代次的竞态判据**（§2.1 ⑥，`INV-VER-01` 的同族）：
//    先发的可能后回、切根后旧结果必须被丢掉。
// ③ **`SearchResult` 的形状归一**：字段名是后端 serde 的名字，
//    前端只认这一份；⛔ 认不出来的一律**不猜**（少一条结果 ≠ 显示一条错的）。
//
// # ⛔ 这个文件里没有什么
//
// **没有匹配算法**。匹配在 Rust 侧（`fs/tree.rs::search`）：一份实现、可直接单测，
// 且与"树的过滤"共用**同一个谓词**（`INV-SEARCH-02`）。在前端再写一份子序列匹配
// 就是 `INV-SINGLE-01` 的镜像形态——两份实现一分开，"排序看起来对不对"就没人说得清。
// ⛔ 也没有 DOM、Tauri、定时器：那几样让这份逻辑没法用 `node --test` 直跑
//    （与 `versions.js` / `chunked.js` 同一条纪律）。

// ⚠️⚠️ **每个文件都包一层 IIFE**——这**不是**风格问题，是必须的。
//
// 经典脚本（⛔ 不是 ES module）的顶层 `const` **共用一个全局词法作用域**：
// 两个文件都写 `const api = …`（或 `const V` / `const api`）时，
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

  // ⭐ 翻译函数（`design/0025` §3）：浏览器走 `window.rmd.i18n`，`node --test` 走 `require`——
  //    **同一份字典**。⛔ 别在这儿另抄一份中文：抄出来的那份不会跟着字典走，
  //    而它恰恰是屏幕上最常出现的那几个词。
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) ||
    (typeof module !== 'undefined' && module.exports ? require('./i18n.js') : null);
  const t = I18N ? I18N.t : function (key) { return key; };

  /** 一个 code point 在 UTF-8 下占几个字节。 */
  function utf8Len(cp) {
    if (cp < 0x80) return 1;
    if (cp < 0x800) return 2;
    if (cp < 0x10000) return 3;
    return 4;
  }

  /**
   * ⭐ **UTF-8 字节偏移 → UTF-16 码元下标**。
   *
   * 返回一张"只在 code point 边界上有值"的表：`table[byteOffset] = utf16Index`。
   * ⚠️ 落在字符中间的字节偏移**查不到**——那正是我们要的：它说明后端给的区间
   * 与前端这份字符串**不是同一个串**（编码假设不一致），此时**丢掉这一段**，
   * ⛔ 绝不"就近取整"——取整出来的高亮会指向一个用户没搜的词。
   *
   * @param {string} s
   * @returns {Array<number|undefined>}
   */
  function byteToUnitTable(s) {
    const table = [];
    let bytes = 0;
    let units = 0;
    table[0] = 0;
    // ⚠️ `for…of` 按 **code point** 迭代（⛔ 不是按 UTF-16 码元）：
    //    Emoji 是**一个** code point 但**两个** UTF-16 码元（代理对）——
    //    按码元迭代会把它数成四个字节，整条表就歪了。
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      bytes += utf8Len(cp);
      units += cp > 0xffff ? 2 : 1;
      table[bytes] = units;
    }
    return table;
  }

  /**
   * 把后端的**扁平字节区间**换算成 UTF-16 区间。
   *
   * @param {string} name 文件名（**原串**）
   * @param {number[]} flat `[s0,e0,s1,e1,…]`，每个数都是 UTF-8 字节偏移
   * @returns {Array<[number, number]>} 按 UTF-16 码元、升序、互不重叠
   */
  function utf16Spans(name, flat) {
    const s = typeof name === 'string' ? name : '';
    const out = [];
    if (!Array.isArray(flat) || flat.length < 2) return out;
    const table = byteToUnitTable(s);
    let prevEnd = 0;
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const a = table[flat[i]];
      const b = table[flat[i + 1]];
      // ⚠️ 三种都丢掉：查不到（不在字符边界）、空区间、与上一段重叠或倒序。
      //    ⛔ 不 assert、不抛——一份高亮错了不值得让整个搜索结果区打不开，
      //    但**也不许**把它画出来（画出来就是"显示了用户没搜过的东西"）。
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      if (b <= a || a < prevEnd) continue;
      out.push([a, b]);
      prevEnd = b;
    }
    return out;
  }

  /**
   * 把名字切成"命中 / 未命中"的片段，给渲染用。
   *
   * @param {string} name
   * @param {Array<[number, number]>} spans UTF-16 区间（`utf16Spans` 的产物）
   * @returns {Array<{text: string, hit: boolean}>}
   */
  function segments(name, spans) {
    const s = typeof name === 'string' ? name : '';
    const out = [];
    const list = Array.isArray(spans) ? spans : [];
    let at = 0;
    for (let i = 0; i < list.length; i++) {
      const a = Math.max(at, list[i][0]);
      const b = Math.max(a, list[i][1]);
      if (a > at) out.push({ text: s.slice(at, a), hit: false });
      if (b > a) out.push({ text: s.slice(a, b), hit: true });
      at = b;
    }
    if (at < s.length) out.push({ text: s.slice(at), hit: false });
    return out;
  }

  function numOr(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  /**
   * ⭐ **归一化一份 `SearchResult`**（`design/0009` §2.1 ②.1 的响应契约）。
   *
   * ⚠️ 返回 `null` 的条件只有一条：**版本对读不出来**（`req` / `generation`
   * 不是数字）。那时这份响应没有任何用处——连"该不该显示"都判不了。
   * ⛔ 其余字段一律**容错**：少一个 `rel` 不该让 200 条结果全不显示。
   *
   * @param {*} raw 后端 `search_files` 的返回值（⚠️ **不可信**：形状是跨语言约定）
   * @returns {object|null}
   */
  function normalizeResult(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const req = numOr(raw.req, null);
    const generation = numOr(raw.generation, null);
    if (req === null || generation === null) return null;

    const entries = [];
    const list = Array.isArray(raw.entries) ? raw.entries : [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || typeof e !== 'object') continue;
      // ⛔ 没有可打开的路径就不显示它：这条命令的唯一出口是"把它交给
      //    `open_document`"（那一步仍会无条件过 `check_readable`）。
      //    一条点不动的结果比少一条结果更糟。
      if (typeof e.real_path !== 'string' || e.real_path === '') continue;
      const name = typeof e.name === 'string' ? e.name : '';
      entries.push({
        root: typeof e.root === 'string' ? e.root : '',
        realPath: e.real_path,
        rel: typeof e.rel === 'string' ? e.rel : '',
        name: name,
        spans: utf16Spans(name, e.match),
      });
    }

    return {
      generation: generation,
      req: req,
      roots: (Array.isArray(raw.roots) ? raw.roots : [])
        .filter(function (r) { return typeof r === 'string'; }),
      entries: entries,
      totalHits: numOr(raw.total_hits, entries.length),
      truncated: !!raw.truncated,
      // ⚠️ 设计里叫 `built_at_ms`，语义是**索引年龄**（`Instant` 没有纪元，
      //    所以它不可能是时间戳——见 `fs/tree.rs::SearchResult`）。
      builtAtMs: numOr(raw.built_at_ms, null),
    };
  }

  /**
   * ⭐ 提交判据（§2.1 ⑥，`INV-VER-01` 的同族）。
   *
   * ⚠️ 两条都在**提交那一刻**现取 `current`，⛔ 不是发请求时那一份
   * （与 `versions.js::staleReason` 是同一条纪律，只是字段名不同：
   * `SearchResult` 用的是设计的 `generation`，⛔ 不是树的 `gen`）。
   *
   * @param {object|null} result `normalizeResult` 的产物
   * @param {{generation:number, latestSearchReq:number}} current
   * @returns {{commit: boolean, reason: 'shape'|'gen'|'req'|null}}
   */
  function commitDecision(result, current) {
    if (!result) return { commit: false, reason: 'shape' };
    if (result.generation !== current.generation) return { commit: false, reason: 'gen' };
    if (result.req !== current.latestSearchReq) return { commit: false, reason: 'req' };
    return { commit: true, reason: null };
  }

  /**
   * 这个模式值不值得发一次 IPC。
   *
   * ⚠️ 空/纯空白**不发**（后端的 `search` 对空模式本来就返回空结果，
   * 发出去只是白跑一趟 IPC）。判据与 Rust 侧"空模式 → 空结果"对齐。
   */
  function shouldQuery(pattern) {
    return typeof pattern === 'string' && pattern.trim().length > 0;
  }

  /** 索引年龄的人话。⚠️ 它是"结果可能过期"的**可见**提示（§2.1 ② 的代价那一段）。 */
  function ageText(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return t('search.age-now');
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return t('search.age-seconds', { n: sec });
    const min = Math.floor(sec / 60);
    if (min < 60) return t('search.age-minutes', { n: min });
    return t('search.age-hours', { n: Math.floor(min / 60) });
  }

  /** 结果区那一行说明（条数 / 截断 / 索引年龄）。⛔ 不写键位——那由调用方拼。 */
  function summaryText(result) {
    if (!result) return '';
    const parts = [];
    if (result.totalHits === 0) parts.push(t('search.none'));
    else if (result.truncated) {
      parts.push(t('search.truncated', { shown: result.entries.length, total: result.totalHits }));
    } else {
      parts.push(t('search.count', { n: result.totalHits }));
    }
    const age = ageText(result.builtAtMs);
    if (age) parts.push(t('search.index-age', { age: age }));
    return parts.join(' · ');
  }

  const api = {
    utf8Len,
    byteToUnitTable,
    utf16Spans,
    segments,
    normalizeResult,
    commitDecision,
    shouldQuery,
    ageText,
    summaryText,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).search = api;
})();
