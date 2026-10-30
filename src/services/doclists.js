// 文档列表的**纯逻辑** —— `design/0041` §2.2 / §2.3。
//
// 这里回答四个问题，四个都**不碰 DOM、不碰 Tauri、不碰定时器**：
//   ① 一层目录项里哪些该画（空目录过滤的判据）；
//   ② 清单的"截断"与"收录不完整"该怎么说出来（⛔ 两件事，分开说）；
//   ③ 一份回包能不能落到屏上（组合令牌判据，R3 / `INV-DOCS-09`）；
//   ④ 一行长什么样（名字 / 扩展名 / 父目录相对路径）。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，
// 顶层 `const` 撞名会让**整个文件不执行**（窗口空白、stderr 全静默）。
// 理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  /**
   * ⭐ 列表**最多画多少行**（`design/0041` §2.3）。
   *
   * ⚠️ 它**不是**"到这就卡"的判断，而是**"再多也没测过"的诚实边界**：
   * 已实测档位是 500 / 1 276 / 2 000 / 5 000 行（`benchmarks/results/doclist-render-*`，
   * 5 000 行一次插入 124 ms / 分片全完成 188 ms）。
   * ⇒ 到这条线就停下并**显示一条常驻说明行**（降级可见，⛔ 不静默）。
   */
  const MAX_RENDER = 5000;

  /**
   * ⭐ 树监视事件之后**去抖多久**重建一次清单（`design/0041` §2.2 的时机 ⑤）。
   * ⚠️ 与 `dirsession.js` 的写盘去抖不是同一件事、⛔ 别共用一个常量：
   * 那个是"记下来"，这个是"重新扫"。
   */
  const STALE_REBUILD_MS = 500;

  /**
   * ⭐ 树的一层该画哪些（`design/0041` §2.2，R1 的三态收在这里）。
   *
   * 三态的含义：
   * - **有 md**（路径在 `keepDirs` 里）⇒ 画；
   * - **确认无 md**（清单完整、路径不在 `keepDirs`）⇒ 不画；
   * - **未知**（清单没就绪 / 收录不完整而我们不知道这一支）⇒ **画**
   *   ——⚠️ `keepDirs` 已经**包含**未走完的子树路径（后端 `keep_dirs` 的职责），
   *   所以"未知"在这里表现为"在集合里"，⛔ 前端不需要第二个判据。
   *
   * @param {Array<{name:string,path:string,is_dir:boolean,ignored:boolean}>} entries 这一层
   * @param {Set<string>|null} keepDirs 判据集合；`null` = 清单还没到（⇒ 全画）
   * @param {Set<string>|null} recentCreated 本次会话**新建**的目录（临时例外，R4）
   * @param {boolean} hideEmpty 用户开关（`false` ⇒ 全画，等价于今天的行为）
   * @returns {Array} 新数组（⛔ 不改入参、⛔ 不改共享索引）
   */
  function visibleEntries(entries, keepDirs, recentCreated, hideEmpty) {
    const all = entries || [];
    if (!hideEmpty || !keepDirs) return all.slice();
    const recent = recentCreated || null;
    const out = [];
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      // 文件永远画：判据只回答"这个**目录**里有没有 md"。
      if (!e.is_dir) { out.push(e); continue; }
      // ⚠️ 忽略目录（`node_modules` 那一类）**灰显但可见**是既有语义
      //    （`design/0009` / `0040`）——⛔ 别用"空目录"判据把它顺手藏掉：
      //    用户需要看得见它，才知道"这里有个不扫的目录"。
      if (e.ignored) { out.push(e); continue; }
      if (keepDirs.has(e.path)) { out.push(e); continue; }
      if (recent && recent.has(e.path)) out.push(e);
    }
    return out;
  }

  /**
   * ⭐ 一行两段：名字 + 父目录（相对 root）。
   * ⚠️ `rel` 来自后端 `IndexEntry.rel`（**相对它自己的 root**），所以多 root 时
   * 也不需要前端知道是哪一个——⛔ 不用绝对路径截一段。
   * @param {string} rel 例：`notes/a.md` / `a.md`
   * @returns {string} 例：`notes` / `/`（root 直接下的一层显示 `/`）
   */
  function parentLabel(rel) {
    const s = String(rel || '');
    const i = s.lastIndexOf('/');
    if (i < 0) return '/';
    const p = s.slice(0, i);
    return p || '/';
  }

  /**
   * 名字拆成「主体 ＋ 扩展名」两段（扩展名单独降透明度，纯 CSS 的事）。
   * ⚠️ 扩展名判定必须与后端 `is_markdown` **同口径**：大小写不敏感
   * （`fs/tree.rs:292`，`Path::extension().eq_ignore_ascii_case("md")`）。
   * 后端索引只收 `.md`，所以这里不需要"别的扩展名怎么办"的分支——
   * 真出现别的扩展名就整串当名字（⛔ 别猜）。
   * @param {string} name
   * @returns {{base:string, ext:string}} `ext` 含点；不是 `.md` 时为空串
   */
  function splitName(name) {
    const s = String(name || '');
    const i = s.lastIndexOf('.');
    if (i <= 0) return { base: s, ext: '' };
    const ext = s.slice(i);
    if (ext.toLowerCase() !== '.md') return { base: s, ext: '' };
    return { base: s.slice(0, i), ext: ext };
  }

  /**
   * ⭐ 组合令牌（R3 / `INV-DOCS-09`）。
   *
   * 分片的"我还该不该继续"**不能**只看授权代次：**同根刷新、树 ⇄ 列表切换、
   * `refresh()`、卸载**都不改 `gen` ⇒ 旧分片会接着往容器里追加。
   * 评审时的反例就是：切走之后残留了 **500 行**旧内容（首批那一批），
   * 而页面上看起来"就是有这么多文档"——**静默的错误内容**。
   *
   * ⇒ 身份是 `{gen, indexRev, epoch, seq}`，其中能"自己动"的是后两个：
   * - `epoch` 视图代次：刷新 / 换形态 / 卸载时 +1；
   * - `seq` 请求号：每发一次 `list_documents` +1。
   *
   * `key` 把两者压成**一个单调数**给 `chunked.js` 的 `currentGen` 用
   * （那个接口只认数字，见 `chunked.js` 的 `gen` / `currentGen`）。
   * ⚠️ 每次变化都让 `key` 前进 ⇒ **旧分片在下一个分片开头**回滚并停下。
   */
  function createToken() {
    let epoch = 0;
    let seq = 0;
    let key = 1;
    let alive = true;
    return {
      alive: function () { return alive; },
      epoch: function () { return epoch; },
      seq: function () { return seq; },
      key: function () { return key; },
      /** 发一次请求：在途分片作废。返回这次的 `{epoch, seq, key}`（记进回包判据）。 */
      request: function () {
        seq += 1;
        key += 1;
        return { epoch: epoch, seq: seq, key: key };
      },
      /** 视图代次 +1（刷新 / 换形态）：在途的一切作废。 */
      bump: function () {
        epoch += 1;
        key += 1;
        return key;
      },
      /** 卸载：此后 `current()` 恒返回 `-1`（⛔ 不会再误判"还是我"）。 */
      destroy: function () {
        alive = false;
        key += 1;
      },
      /** 注入给 `chunked.js::currentGen` 的**现取值**（⛔ 不是建的时候那一份）。 */
      current: function () { return alive ? key : -1; },
    };
  }

  /**
   * ⭐ 回包能不能落到屏上（`design/0041` §2.3 的提交判据）。
   *
   * 三条**同时**成立才算数：
   * - `gen` 与**当前**授权代次相同（切根后的旧回包丢弃）；
   * - `req` 等于**最新发出的**那个请求号（同根刷新后的旧回包丢弃）；
   * - `index_rev` 不**倒退**（同代次里晚完成的旧构建不许覆盖新索引，R2）。
   *
   * ⚠️ `index_rev >= appliedRev` 用的是 `>=`：**同一份**索引可以被两个请求
   * 各回一次（后端命中新鲜缓存时票号不变、`rev` 也不变），那不是倒退。
   *
   * @param {{gen:number, req:number, index_rev:number}} reply
   * @param {{generation:number, seq:number, appliedRev:number}} current 现取真值
   * @returns {boolean}
   */
  function shouldApply(reply, current) {
    if (!reply || !current) return false;
    if (reply.gen !== current.generation) return false;
    if (reply.req !== current.seq) return false;
    return reply.index_rev >= current.appliedRev;
  }

  /**
   * 实际画多少行（⛔ 不是 `entries.length`：还有 `MAX_RENDER` 这条线）。
   * @param {number} n 回包里的条目数
   * @returns {number}
   */
  function renderedCount(n) {
    return Math.min(Math.max(n | 0, 0), MAX_RENDER);
  }

  /**
   * ⭐ 列表末尾那几条**常驻说明行**（顺序 = 显示顺序）。
   *
   * ⚠️ R1 的纪律：**收录不完整 ≠ 显示上限截断**——两件事各说各的，
   * ⛔ 不许合并成一句"结果可能不全"（那样用户分不清"盘上就这么多"还是"没画完"）。
   *
   * @param {object} result `DocListResult`
   * @param {number} shown 实际画出来的条数（`renderedCount`）
   * @param {string} [accel] 搜索快捷键的**显示字形**（由调用方从 `accelText()` 取；
   *   ⛔ 前端源码里不许出现按键字面量，`INV-SET-01`）
   * @returns {Array<{key:string, params:object}>} 空数组 = 什么都不说
   */
  function notices(result, shown, accel) {
    const out = [];
    if (!result) return out;
    if (result.complete === false) {
      out.push({
        key: result.incomplete_truncated ? 'doclist.incomplete-more' : 'doclist.incomplete',
        params: { n: (result.incomplete || []).length },
      });
    }
    // ⚠️ 两个来源都要说：后端 `MAX_DOCS` 截了（`truncated`）或前端 `MAX_RENDER` 截了
    //    （`entries.length > MAX_RENDER`）。对用户来说是同一句"没画完"。
    const cut = result.truncated === true || (result.entries || []).length > MAX_RENDER;
    if (cut) {
      out.push({
        key: accel ? 'doclist.truncated' : 'doclist.truncated-nokey',
        params: { shown: shown, total: result.total | 0, key: accel || '' },
      });
    }
    return out;
  }

  const api = {
    MAX_RENDER,
    STALE_REBUILD_MS,
    visibleEntries,
    parentLabel,
    splitName,
    createToken,
    shouldApply,
    renderedCount,
    notices,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).doclists = api;
})();
