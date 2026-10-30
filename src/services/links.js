// 文档内链接的**纯逻辑** —— `design/0026-文档内链接安全导航.md` §2.7/§3（2026-10-21）。
//
// # 它管什么、⛔ 不管什么
//
// | 这一份 | 别处 |
// |---|---|
// | `href` 归一、锚点查找、**结果 → 界面动作**的映射、会话存活的判据 | 分类 / 授权 / 派发（`src-tauri/src/link.rs` ＋ `commands/link.rs`） |
//
// ⚠️⚠️ **它不判授权、不拼路径、不知道文档在哪**（`INV-LINK-03`）：那三件事只有在后端
// 才做得到，前端做了就是第二条真值。这里连 `path` 都不加工——后端给的规范化路径原样用。
//
// # 为什么单独一个文件
//
// 同 `renderstat.js` / `progress.js` 那一族：这些判据原本会散在 `main.js` 里，
// 而 `main.js` **进不了 `node --test`**（它一加载就要 DOM 与 `window.rmd.*`）。
// 抽出来之后，"结果 → 动作"这张表可以被逐格断言——⚠️ **加一种 `kind` 忘了加映射**
// 在屏幕上的表现是"点了没反应"（`INV-LINK-08` 正是禁这个），而它⛔ 不会报任何错。
//
// ⚠️ 每个文件都包一层 IIFE（经典脚本共享全局词法作用域，顶层 `const` 撞名会让
//    整个文件不执行——见 `FileTree.js` 的详细说明）。
// ⚠️ **无 `window.rmd.*` 依赖**（与 `find.js` / `sync.js` 同族），⇒ 它可以排在
//    `session.js` 之前，也可以直接 `require` 进测试。
(function () {
  'use strict';

  /**
   * 把 `href` 归一成**要交给后端的那一个串**。
   *
   * ⚠️ 只做 `trim`：⛔ **不在前端解码、切分或改写**——那三件事在后端是**一份**实现
   * （`link.rs::split_url` / `percent_decode`），前端再解一次就是二次解码
   * （`a%2520b` 会被解成 `a b`，那是**另一个文件**）。
   */
  function normalizeHref(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim();
  }

  /**
   * 锚点片段解码一次（`#a%20b` → `a b`）。
   *
   * ⚠️ 后端回来的 `fragment` **已经解码过**（`commands/link.rs`），本函数是
   * 给"别处还想直接从 `href` 取片段"的调用方留的**唯一**入口——⛔ 别在调用点
   * 自己写一个 `decodeURIComponent`（`%` 后面跟非十六进制时它会**抛**）。
   */
  function decodeFragment(s) {
    if (typeof s !== 'string') return '';
    const t = s.charAt(0) === '#' ? s.slice(1) : s;
    try {
      return decodeURIComponent(t);
    } catch (e) {
      // ⚠️ 非法序列**原样保留**（与后端 `percent_decode` 同一口径）：
      //    它更可能是标题里真有一个 `%`，而不是谁写错了编码。
      return t;
    }
  }

  /**
   * 在正文 DOM 里找锚点。找不到 ⇒ `null`（调用方**明确提示**，⛔ 不猜最近标题）。
   *
   * ⚠️ 只用 `getElementById`：`querySelector('#' + fragment)` 在片段含
   * `:`、`.`、`[` 这类字符时会**抛 SyntaxError**，而那段字符正是标题 ID 允许出现的。
   * ⚠️ `docEl` 由调用方给（`#doc`），⛔ 不用全局 `document`——探针与单测要能传假的。
   */
  function anchorFor(fragment, docEl) {
    const f = typeof fragment === 'string' ? fragment : '';
    if (!f) return null;
    if (!docEl || typeof docEl.getElementById !== 'function') return null;
    return docEl.getElementById(f) || null;
  }

  /**
   * **后端的一次结果 → 界面要做的一件事**（`design/0026` §2.7 那张表，逐行）。
   *
   * 返回 `{action, key?, vars?, isError?, path?, fragment?}`：
   *
   * | `action` | 谁执行 |
   * |---|---|
   * | `status` | 状态条一行（`key` ＋ `vars`） |
   * | `anchor` | 就地滚动到 `fragment` |
   * | `open` | 走既有 `openDocument(path)`，之后再定位 `fragment` |
   * | `ask-auth` | 既有决策条（`askEdit`）＋ 两个选择器按钮 |
   *
   * ⚠️ **每一种 `kind` 都必须有映射**（`KINDS` 是那张封闭清单）：漏一种的表现是
   * "点了没反应"，而它⛔ 不报错。`tests/js/links.test.js` 逐格断言。
   */
  function plan(out) {
    const o = out && typeof out === 'object' ? out : {};
    const href = typeof o.href === 'string' ? o.href : '';
    const msg = typeof o.message === 'string' ? o.message : '';
    switch (o.kind) {
      case 'empty':
        return { action: 'status', key: 'link.empty', isError: true };
      case 'anchor':
        return { action: 'anchor', fragment: typeof o.fragment === 'string' ? o.fragment : '' };
      case 'document':
        return {
          action: 'open',
          path: typeof o.path === 'string' ? o.path : '',
          fragment: typeof o.fragment === 'string' ? o.fragment : '',
        };
      case 'reveal':
        return { action: 'status', key: 'link.revealed' };
      case 'external':
        return { action: 'status', key: 'link.external-opened' };
      case 'reveal_failed':
        return { action: 'status', key: 'link.reveal-failed', vars: { message: msg }, isError: true };
      case 'external_failed':
        return { action: 'status', key: 'link.external-failed', vars: { message: msg }, isError: true };
      case 'unauthorized':
        return { action: 'ask-auth', key: 'link.unauthorized', vars: { href: href } };
      case 'missing':
        // ⚠️ 文案**不说死"不存在"**：父目录没有执行权限时 `canonicalize` 也失败，
        //    后端把它归成同一类（`design/0026` §2.5 的 `P3-6`）。
        return { action: 'status', key: 'link.missing', vars: { href: href }, isError: true };
      case 'unsupported':
        return { action: 'status', key: 'link.unsupported', vars: { scheme: msg || '?' }, isError: true };
      case 'local_query':
        return { action: 'status', key: 'link.local-query', vars: { href: href }, isError: true };
      case 'no_document':
        return { action: 'status', key: 'link.no-document', isError: true };
      case 'stale':
        return { action: 'status', key: 'link.stale' };
      case 'failed':
        return { action: 'status', key: 'link.failed', vars: { message: msg }, isError: true };
      default:
        // ⚠️ 走到这里说明**后端加了新 kind 而这张表没跟上**。⛔ 不静默：
        //    给出的仍是"有结果"的一句话（`INV-LINK-08`），并把原始 kind 带上便于排查。
        return {
          action: 'status',
          key: 'link.failed',
          vars: { message: String(o.kind || '') },
          isError: true,
        };
    }
  }

  /** 后端 `LinkOutcome.kind` 的**封闭清单**（与 `commands/link.rs` 的 `KIND_*` 一一对应）。 */
  const KINDS = [
    'empty',
    'anchor',
    'document',
    'reveal',
    'external',
    'reveal_failed',
    'external_failed',
    'unauthorized',
    'missing',
    'unsupported',
    'local_query',
    'no_document',
    'stale',
    'failed',
  ];

  /**
   * 这次回包**还算数吗**（`INV-LINK-11`）。
   *
   * ⚠️ 判据是**会话号**，⛔ 不是时间、⛔ 不是"界面还是不是同一份 DOM"：
   * 用户在 `await` 期间换了文档 ⇒ 这条结果属于**上一份文档**，
   * 照它去 `openDocument` 就把用户刚点的那份顶掉了。
   */
  function isAlive(expectedSeq, currentSeq) {
    return expectedSeq === currentSeq;
  }

  const api = {
    normalizeHref: normalizeHref,
    decodeFragment: decodeFragment,
    anchorFor: anchorFor,
    plan: plan,
    isAlive: isAlive,
    KINDS: KINDS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && window) (window.rmd || (window.rmd = {})).links = api;
})();
