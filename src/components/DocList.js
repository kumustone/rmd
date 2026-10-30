// 文档列表（平铺视图）—— `design/0041` §2.3（2026-10-24 已通过）。
//
// # 它是什么
//
// 文件树标签页的**第二种形态**：把索引里的全部 Markdown 文档按「父目录 → 文件名」
// 平铺出来，每行两段（名字 ＋ 父目录），点一行打开那份文档。
// ⛔ **不读正文**（`INV-DOCS-05`）、⛔ 不建第二份索引（`INV-DOCS-01`）：
// 数据来自 `list_documents`，与文件名搜索共用后端那一份 `FileIndex`。
//
// # 三个承重点
//
// 1. **排序在后端**（`INV-DOCS-06`）：`fs/order.rs` 的自然序只有一份实现，
//    前端 ⛔ 不再排一遍（`localeCompare` 与它必然漂移，而两边单独看都对）。
// 2. **分片渲染复用 `chunked.js`**，参数是 `versions.js` 的 500 / 500。
//    ⚠️ 分片的收益是"**首批 DOM＋布局完成** 11 ms"（R8 的口径修正），
//    ⛔ 不是"更快渲完"——5 000 行分片全部完成 188 ms，**比一次插入慢**。
//    ⇒ 到 `MAX_RENDER`（5 000）就停下并**常驻一行说明**，⛔ 不设"放弃"阈值。
// 3. ⭐ **生命周期取消用组合令牌**（R3 / `INV-DOCS-09`）。评委反例：切走之后
//    旧分片还在往容器里追加，**残留 500 行旧内容**——"看起来就是有这么多文档"，
//    是**静默的错误内容**。判据在 `doclists.js::createToken` / `shouldApply`，
//    本文件只负责把它接进 `chunked.js` 的 `currentGen`。
//
// ⚠️⚠️ 每个文件都包一层 IIFE（经典脚本共享全局词法作用域，理由见 `chunked.js` 文件头）。

(function () {
  'use strict';

  const S = (typeof module !== 'undefined' && module.exports) ? require('../services/session.js') : window.rmd.session;
  const V = (typeof module !== 'undefined' && module.exports) ? require('../services/versions.js') : window.rmd.versions;
  const C = (typeof module !== 'undefined' && module.exports) ? require('../services/chunked.js') : window.rmd.chunked;
  const DL = (typeof module !== 'undefined' && module.exports) ? require('../services/doclists.js') : window.rmd.doclists;
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) ||
    (typeof module !== 'undefined' && module.exports ? require('../services/i18n.js') : null);
  const t = I18N ? I18N.t : function (key) { return key; };

  /**
   * 建一个文档列表。
   *
   * @param {object} opts
   * @param {HTMLElement} opts.host 挂在哪儿（`#pane-doclist`）
   * @param {(path:string) => void} opts.onOpenFile 点了一行
   * @param {(result:object, keepDirs:Set<string>) => void} [opts.onResult]
   *   ⭐ 一份清单**真的落到屏上**之后回调（用于树过滤与"切回来时补一次"）。
   *   ⛔ 被判据丢弃的回包不会走这里。
   * @param {(e:object) => void} [opts.onError]
   * @param {(id:string) => string} [opts.keyText] 键位显示字形（`INV-SET-01`：⛔ 不在源码里写字面量）
   */
  function createDocList(opts) {
    const host = opts.host;
    const onOpenFile = opts.onOpenFile || function () {};
    const onResult = opts.onResult || function () {};
    const onError = opts.onError || function () {};
    const keyText = opts.keyText || function () { return ''; };

    /** ⭐ 组合令牌（`epoch` / `seq` / `key`）——`destroy()` 之后 `current()` 恒为 -1。 */
    const token = DL.createToken();
    let alive = true;
    /** 已提交清单的发布版本（提交判据的第三条：⛔ 不许倒退）。 */
    let appliedRev = 0;
    /** 在途分片（同一时刻只有一条：换内容前一定 `stopAppender()`）。 */
    let appender = null;
    /**
     * ⭐ 这一份清单**当前是不是可见的**（形态 = 列表且文件标签页在前）。
     *
     * ⚠️ 它存在的理由是"树也要用这份清单"（空目录过滤）：树形态下仍然要拉清单，
     * 但**不该**为此在隐藏的容器里画 5 000 行——`refresh()` 照常请求、照常回调
     * `onResult`（判据集合有了），只是不建 DOM。切回列表时 `setActive(true)`
     * 用**同一份**清单补画，⛔ 不再多拉一次。
     */
    let active = false;
    /** 最近一份**已通过判据**的清单（切回列表时补画用）。 */
    let lastResult = null;

    function stopAppender() {
      if (!appender) return;
      // ⚠️ 与 `FileTree.stopAppenders` 同一条：只置 `stopped`，
      //    已追加的节点由**调用方**清容器时一并去掉（`chunked.js` 的回滚只认它自己的）。
      appender.state.stopped = true;
      appender = null;
    }

    function clearHost() {
      stopAppender();
      host.textContent = '';
    }

    function el(tag, cls, text) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      // ⚠️ 一律 `textContent`：文件名与路径都是用户数据（⛔ `innerHTML`）。
      if (text != null) n.textContent = text;
      return n;
    }

    /**
     * 一行两段：`<名字><扩展名>` ＋ `<父目录，相对 root>`。
     * ⚠️ 扩展名单独一段**只为了降透明度**（纯 CSS，`styles/doclist.css`）。
     */
    function makeRow(entry) {
      const row = el('div', 'doclist-row');
      row.dataset.path = entry.real_path;
      row.title = entry.real_path;
      // ⚠️ `tabindex="-1"`：与树的 `makeNode` 同一条理由——5 000 行若各占一个
      //    Tab 停靠点，键盘用户只能一格一格爬出去。本视图的"按名字找"由 ⌘P 覆盖
      //    （§2.3 明确不做过滤输入框）。
      row.tabIndex = -1;
      row.setAttribute('role', 'listitem');

      const parts = DL.splitName(entry.name);
      const name = el('span', 'doclist-name', parts.base);
      if (parts.ext) name.appendChild(el('span', 'doclist-ext', parts.ext));
      row.appendChild(name);
      row.appendChild(el('span', 'doclist-parent', DL.parentLabel(entry.rel)));

      row.addEventListener('click', function () { onOpenFile(entry.real_path); });
      return row;
    }

    /** 末尾的常驻说明行（截断 / 收录不完整）＋空态。⛔ 不参与分片。 */
    function appendStatic(result, shown) {
      if (shown === 0) {
        // ⚠️ 空态只说"没有文档"：**收录不完整**时下面那条说明会补上
        //    "为什么可能不止这些"（R1：⛔ 不许把未知说成空）。
        host.appendChild(el('p', 'doclist-note doclist-empty', t('doclist.empty')));
      }
      // ⚠️ 搜索快捷键的**显示字形**现取（`INV-SET-01`：⛔ 不在源码里写 `⌘P`）。
      const keys = DL.notices(result, shown, keyText('file.quick-open'));
      for (let i = 0; i < keys.length; i++) {
        host.appendChild(el('p', 'doclist-note doclist-note-' + keys[i].key.split('.').pop(),
          t(keys[i].key, keys[i].params)));
      }
    }

    /**
     * 把一份**已通过判据**的清单记下来（并且，如果这一视图可见，画上去）。
     * ⚠️ `onResult` **总是**调：树过滤与"脏标记消费"靠它（可见与否无关）。
     */
    function commit(result) {
      appliedRev = result.index_rev;
      lastResult = result;
      // ⭐ 树过滤的判据集合：**来自完整索引**（⛔ 不受 `entries` 截断影响，R7）。
      const keepDirs = new Set(result.keep_dirs || []);
      // ⭐ 清单落地之后才通知调用方（树过滤、脏标记消费都靠它）。
      try {
        onResult(result, keepDirs);
      } catch (e) {
        console.error('文档列表的落地回调出错：', e);
      }
      if (active) paint(result);
    }

    /**
     * 真正往 DOM 里画。
     * ⚠️ 顺序是「先停旧任务 → 再清容器 → 再开新任务」——`chunked.js` 的回滚
     * 只会移除**它自己**追加的节点，⛔ 不清容器就会留下上一份的尾巴。
     */
    function paint(result) {
      clearHost();

      const entries = result.entries || [];
      const shown = DL.renderedCount(entries.length);

      const items = el('div', 'doclist-items');
      items.setAttribute('role', 'list');
      host.appendChild(items);

      if (shown === 0) {
        appendStatic(result, 0);
      } else {
        const myKey = token.current();
        const a = C.createChunkAppender({
          total: shown,
          gen: myKey,
          // ⭐ 现取：**同根刷新 / 换形态 / 卸载**都不改授权代次，
          //    只看 `gen` 的话旧分片会接着追加（R3 的 500 行反例）。
          currentGen: function () { return token.current(); },
          build: function (from, to) {
            const out = [];
            for (let i = from; i < to; i++) out.push(makeRow(entries[i]));
            return out;
          },
          append: function (nodes) { for (let i = 0; i < nodes.length; i++) items.appendChild(nodes[i]); },
          remove: function (nodes) { for (let i = 0; i < nodes.length; i++) nodes[i].remove(); },
          step: V.CHUNK_STEP,
          // ⚠️ `chunked.js` 保证只调一次；**整批回滚也会调**（那时 reason 是 'gen'）
          //    ⇒ 只有 `done` 才补说明行——被丢弃的那一份不该在屏幕上留任何一句。
          onDone: function (st) {
            if (st.reason !== 'done') return;
            if (!alive || !active) return;
            appendStatic(result, shown);
          },
        });
        appender = a;
        a.start();
      }
    }

    /**
     * 拉一次清单。
     * @param {boolean} [rebuild] 强制重建索引（与 `search_files` 的同名参数逐字同义）
     */
    async function load(rebuild) {
      if (!alive) return;
      // ⭐ 先在**本地**推进视图代次：这一刻起，在途分片在下一个分片开头就回滚。
      token.bump();
      const key0 = token.request().key;
      let r;
      try {
        r = await S.listDocuments(!!rebuild);
      } catch (e) {
        if (!alive || token.key() !== key0) return;
        clearHost();
        host.appendChild(el('p', 'doclist-note doclist-error', t('doclist.failed', {
          msg: (e && (e.wording || e.message)) || '',
        })));
        onError(e);
        return;
      }
      // ⚠️ 等待期间被 `refresh` / `destroy` / 切形态顶掉 ⇒ 这份回包连判断都不做。
      if (!alive || token.key() !== key0) return;
      // 后端判代次不符（切根后的在途请求）：**正常路径**，⛔ 不画、⛔ 不报错。
      if (r.stale || !r.result) return;

      // ⭐ 提交判据（三条同时成立）：`gen` / `req` / `index_rev` 不倒退。
      const cur = S.currentDocList();
      const ok = DL.shouldApply(r.result, {
        generation: cur.generation,
        seq: r.req,
        appliedRev: appliedRev,
      });
      if (!ok) return;
      // ⚠️ 同一个请求号只能提交一次（`seq` 相等但令牌已前进 ⇒ 这是**旧**回包）。
      if (r.req !== cur.latestDocListReq) return;
      commit(r.result);
    }

    return {
      /** 首次加载 / 切回列表 / 换根之后：用缓存（除非调用方要求重建）。 */
      refresh: function (rebuild) { return load(rebuild); },
      /**
       * ⭐ 可见性（形态 = 列表 **且** 文件标签页在前）。
       * ⚠️ 从"不可见"切到"可见"时用**最近一份清单**补画，⛔ 不再多拉一次。
       */
      setActive: function (on) {
        if (!alive) return;
        const next = !!on;
        if (next === active) return;
        active = next;
        if (!next) {
          // 停分片 + 清空：隐藏的容器里留着 5 000 行只会让下一次渲染多付一次 GC。
          token.bump();
          clearHost();
          return;
        }
        if (lastResult) paint(lastResult);
      },
      /** 卸载（换形态）：停分片、令牌作废。⛔ 不清 DOM——切回来会重建一个新的。 */
      destroy: function () {
        alive = false;
        token.destroy();
        stopAppender();
      },
      isAlive: function () { return alive; },
    };
  }

  const api = { createDocList };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).docList = api;
})();
