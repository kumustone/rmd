// ⭐ 目录会话的**全部前端逻辑**（`design/0020` §2.3 ①）。
//
// 本模块有三类东西：
//   ① 纯函数：`isInside` / `docInRoot` / `toEntry` / `restorePlan` / `sameEntry` /
//      `shouldRestore`——可在 `node --test` 里逐条钉边界；
//   ② ⭐ `createRestorer`：**恢复事务**（展开 ＋ 必要时打开上次的文件）；
//   ③ ⭐ `createWriter`：**写者**（脏标记 ＋ 恢复期挂起 ＋ 迟到响应拦截）。
//
// ⚠️ ②③ 的所有依赖都是**注入的**（`getState` / `root` / `tree` / `openDocument` /
//    `setDirSession` / 定时器）⇒ 跨 `await` 的时序可以在 node 里**逐帧控制**。
//    这不是"为了测试"：评审 R3/R5 指出的全是时序问题，而 `main.js` 不进 `tests/js/`。
//    ⛔ 别把这里的编排搬回 `main.js`——`tests/js/dirsession.test.js` 的源码级闸门会红。
//
// ⚠️ **排在 `services/progress.js` 之后、`services/session.js` 之前**：
//    `session.js` 与 `FileTree.js` 在**加载期**取它（经典脚本按顺序执行）。
//
// ⚠️ 它**不碰 DOM**、⛔ 不拼路径（`INV-TREE-01`）：会话里的路径全部来自后端，
//    这里只做**包含关系过滤**。
(function () {
  'use strict';

  /** 每个目录最多记住多少条展开路径（与后端 `MAX_EXPANDED_PER_DIR` 同一把尺子）。 */
  const MAX_EXPANDED_PER_DIR = 200;
  /** 单条路径的字符数护栏（与后端 `MAX_SESSION_PATH_CHARS` 同一把尺子）。 */
  const MAX_SESSION_PATH_CHARS = 4096;
  /** 树操作的去抖窗口（`design/0020` §2.3 ③(c)：连续点开五层只写一次）。 */
  const DIR_SESSION_DEBOUNCE_MS = 500;

  /**
   * `p` 是否在 `prefix` **之下或恰好等于**它。
   *
   * ⭐ **函数体从 `FileTree.js:69-76` 原样搬来**（`design/0020` §2.3 ①）。
   * ⛔ **绝不写第二份包含判断**——`rootfoo` 前缀陷阱在安全路径上就是
   * `INV-FS-01` 的失效形态，两边都必须补分隔符再比。
   */
  function isInside(prefix, p) {
    if (!prefix || !p) return false;
    if (p === prefix) return true;
    return p.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
  }

  /** 路径深度（段数）。⚠️ 只用于**排序**（保浅的），⛔ 不是安全判断。 */
  function depthOf(p) {
    if (typeof p !== 'string' || p === '') return 0;
    return p.split('/').length;
  }

  /** 单条路径的护栏：⛔ 不截断，超限整个丢掉（与后端同一口径：按**码点**数）。 */
  function pathOk(p) {
    return typeof p === 'string' && p !== '' && Array.from(p).length <= MAX_SESSION_PATH_CHARS;
  }

  /** 同一深度按字节序 —— ⚠️ ASCII 上与后端 `(depth, bytes)` 完全一致。 */
  function byDepthThenPath(a, b) {
    const d = depthOf(a) - depthOf(b);
    if (d !== 0) return d;
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  /**
   * ⭐ **文档身份判据**：当前文档是不是"这个根里的那一份"。
   *
   * 恢复与写盘**都只认它**（⛔ 不各自写一份，评审 R1）。`state.mode` 必须是
   * `'directory'`：单文件模式即便路径恰好在某个根下，也不是"树里的当前项"。
   */
  function docInRoot(state, root) {
    if (!state || state.mode !== 'directory') return false;
    const p = state.currentPath;
    if (typeof p !== 'string' || p === '') return false;
    return isInside(root, p) && p !== root;
  }

  /**
   * 把前端状态整成 IPC 载荷（`design/0020` §2.1 ③ 的前端一半）。
   *
   * ⚠️ 只做**形状整理与包含过滤**：⛔ 不做规范化（`INV-TREE-01`）、
   * ⛔ 不做授权判断（那是 `check_readable` 的事）。
   *
   * @param {string} root 当前授权的根（后端规范化后的那一份）
   * @param {string|null} lastFile 当前文档路径（调用方先用 `docInRoot` 判过）
   * @param {Set<string>|string[]} expandedPaths 树里展开的目录
   * @returns {{entry:{last_file:string|null, expanded:string[], updated_at:number},
   *            dropped:string[]}}
   */
  function toEntry(root, lastFile, expandedPaths) {
    const dropped = [];
    const seen = new Set();
    let list = [];

    const src = expandedPaths instanceof Set
      ? Array.from(expandedPaths)
      : (Array.isArray(expandedPaths) ? expandedPaths.slice() : []);
    for (let i = 0; i < src.length; i++) {
      const p = src[i];
      if (!pathOk(p) || p === root || !isInside(root, p)) {
        dropped.push(String(p));
        continue;
      }
      if (seen.has(p)) continue;
      seen.add(p);
      list.push(p);
    }
    list.sort(byDepthThenPath);
    if (list.length > MAX_EXPANDED_PER_DIR) {
      const over = list.slice(MAX_EXPANDED_PER_DIR);
      for (let i = 0; i < over.length; i++) dropped.push(over[i]);
      list = list.slice(0, MAX_EXPANDED_PER_DIR);
    }

    let last = null;
    if (typeof lastFile === 'string' && lastFile !== '') {
      if (pathOk(lastFile) && lastFile !== root && isInside(root, lastFile)) last = lastFile;
      else dropped.push(lastFile);
    }
    return { entry: { last_file: last, expanded: list, updated_at: 0 }, dropped: dropped };
  }

  /**
   * 从镜像里算出"要按什么顺序恢复"。
   *
   * @returns {{dirs:string[], file:string|null}}
   *   `dirs` 由**浅到深**（祖先一定在后代之前，⛔ 不需要拓扑排序）；
   *   `file` 越界 / 为空 ⇒ `null`。
   */
  function restorePlan(entry, root) {
    const plan = { dirs: [], file: null };
    if (!entry || !root) return plan;

    const seen = new Set();
    const src = Array.isArray(entry.expanded) ? entry.expanded : [];
    for (let i = 0; i < src.length; i++) {
      const p = src[i];
      if (!pathOk(p) || p === root || !isInside(root, p) || seen.has(p)) continue;
      seen.add(p);
      plan.dirs.push(p);
    }
    plan.dirs.sort(byDepthThenPath);
    if (plan.dirs.length > MAX_EXPANDED_PER_DIR) plan.dirs = plan.dirs.slice(0, MAX_EXPANDED_PER_DIR);

    const f = entry.last_file;
    if (pathOk(f) && f !== root && isInside(root, f)) plan.file = f;
    return plan;
  }

  /** 两份载荷"内容是否相同"（忽略 `updated_at` 与数组顺序）。 */
  function sameEntry(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    const la = a.last_file || null;
    const lb = b.last_file || null;
    if (la !== lb) return false;
    const ea = Array.isArray(a.expanded) ? a.expanded : [];
    const eb = Array.isArray(b.expanded) ? b.expanded : [];
    if (ea.length !== eb.length) return false;
    const sa = new Set(ea);
    for (let i = 0; i < eb.length; i++) if (!sa.has(eb[i])) return false;
    return true;
  }

  /** 这一代（每授权一次目录）是否还需要恢复。 */
  function shouldRestore(state) {
    return !!state && state.mode === 'directory' && !!state.dirSession
      && state.restoredGen !== state.generation;
  }

  /** 树里展开的路径（`expandedPaths()` / `Set` / 数组三种形态都认，⛔ 不新增第二个真值）。 */
  function expandedOf(tree) {
    if (!tree) return [];
    if (typeof tree.expandedPaths === 'function') return tree.expandedPaths();
    if (tree.expanded instanceof Set) return Array.from(tree.expanded);
    if (Array.isArray(tree.expanded)) return tree.expanded;
    return [];
  }

  function rootOfState(state) {
    if (!state || !state.roots || state.roots.length !== 1) return null;
    return state.roots[0];
  }

  /**
   * ⭐ **恢复事务**（`design/0020` §2.3 ③(a)）。
   *
   * 七步（每一步的判据都是 `alive(token)`，⛔ 不靠"`open_document` 会自己校验代次"）：
   * 1. `shouldRestore` 幂等；2. 建 token 并记进 `state.restoreToken`；
   * 3. `restorePlan`；4. 由浅到深展开（每步前查一次）；5. 每次 `await` 之后必查；
   * 6. 必要时打开上次的文件；7. `finally` 清 token。
   *
   * @param {object} deps
   * @param {() => object} deps.getState
   * @param {() => string|null} [deps.root] 当前根（缺省从 `state.roots[0]` 取）
   * @param {object} deps.tree `FileTree`（要 `restoreExpanded`）
   * @param {(path:string, opts:object) => Promise<any>} deps.openDocument
   * @param {() => void} [deps.onDone]
   */
  function createRestorer(deps) {
    const getState = deps.getState;
    const tree = deps.tree;
    const openDocument = deps.openDocument;
    const rootOf = typeof deps.root === 'function' ? deps.root : function () { return rootOfState(getState()); };
    /** 正在跑的那次恢复；`null` = 没有。⚠️ 与 `state.restoreToken` **同一个对象**。 */
    let current = null;

    /** ⭐ 评审 R3 的落点：恢复有自己的身份，⛔ 不靠别处的校验。 */
    function alive(token) {
      const st = getState();
      return !!token && current === token && !token.cancelled
        && st.restoreToken === token
        && st.generation === token.generation
        && st.mode === 'directory'
        && !!st.roots && st.roots.length === 1 && st.roots[0] === token.root;
    }

    /** 整条恢复作废（切根 / 用户亲手打开文件 / 关目录）。 */
    function cancel(reason) {
      if (!current) return false;
      current.cancelled = true;
      current.cancelReason = reason || null;
      const st = getState();
      if (st.restoreToken === current) st.restoreToken = null;
      current = null;
      return true;
    }

    /** 用户亲手展开 / 折叠 ⇒ 只置 `browsing`：展开继续，⛔ 自动打开文件不做。 */
    function noteUserToggle() {
      if (!current || current.cancelled) return false;
      current.browsing = true;
      return true;
    }

    function isActive() { return !!current && !current.cancelled; }

    async function run() {
      const out = { restored: 0, skipped: 0, cancelled: false, opened: false, idle: false };
      const st = getState();
      if (!shouldRestore(st)) { out.idle = true; return out; }
      const root = rootOf();
      if (!root) { out.idle = true; return out; }

      const token = {
        generation: st.generation,
        root: root,
        browsing: false,
        cancelled: false,
      };
      // ⭐ 先记后用：`alive()` 的第一条就是"还是不是这一次"。
      current = token;
      st.restoreToken = token;
      st.restoredGen = st.generation;

      try {
        const plan = restorePlan(st.dirSession, root);
        const cont = function () { return alive(token); };
        if (plan.dirs.length && tree && typeof tree.restoreExpanded === 'function') {
          const r = await tree.restoreExpanded(plan.dirs, cont);
          out.restored = (r && r.restored) || 0;
          out.skipped = (r && r.skipped) || 0;
          out.cancelled = !!(r && r.cancelled);
        }
        // ⭐ 每次 `await` 之后必查（R3）：200 次展开期间世界会变。
        if (!alive(token)) { out.cancelled = true; return out; }

        if (plan.file && !token.browsing && !docInRoot(getState(), token.root)) {
          out.opened = true;
          // ⚠️ 打不开由 `openDocument` 自己 setStatus，这里⛔ 不补第二句话。
          // ⚠️ 这一份**就是**存下来的 `last_file` ⇒ 提交后 `sameEntry` 为真 ⇒ 零写盘。
          // ⚠️ **它抛了也不许带走侧边栏**（`renderSidebar` 正 `await` 着这里）：
          //    恢复是个便利，失败只该让"上次的文件没打开"，⛔ 不是让整棵树不画。
          //    `main.js::openDocument` 对**预期内**的失败（IPC 拒绝）本来就返回 null，
          //    能到这儿的是意外 ⇒ 只往 stderr 说（本仓唯一通路）。
          try {
            await openDocument(plan.file, { reason: 'restore', token: token });
          } catch (e) {
            if (typeof console !== 'undefined' && console.error) {
              console.error('目录会话恢复：打开上次的文件失败：', e);
            }
          }
        }
        return out;
      } finally {
        if (current === token) current = null;
        if (getState().restoreToken === token) getState().restoreToken = null;
        if (typeof deps.onDone === 'function') deps.onDone(out);
      }
    }

    return { run: run, cancel: cancel, isActive: isActive, noteUserToggle: noteUserToggle };
  }

  /**
   * ⭐ **写者**（`design/0020` §2.3 ③(c)）。三条纪律：
   *
   * ① 只在"真的变了"才发：先算 entry，再 `sameEntry(entry, 镜像)`；
   * ② 恢复期挂起：`state.restoreToken` 活着时 `flush()` **直接返回**（⛔ 不抹记录，R2）；
   * ③ 回填过三重闸：`seq === latestSeq` ＋ 代次 ＋ 根（迟到的 A 响应不许倒灌进 B，R5）。
   *
   * @param {object} deps
   * @param {() => object} deps.getState
   * @param {() => string|null} [deps.root]
   * @param {object} deps.tree
   * @param {(root:string, generation:number, lastFile:string|null, expanded:string[]) => Promise<any>} deps.setDirSession
   * @param {Function} [deps.setTimeout]
   * @param {Function} [deps.clearTimeout]
   */
  function createWriter(deps) {
    const getState = deps.getState;
    const tree = deps.tree;
    const setDirSession = deps.setDirSession;
    const rootOf = typeof deps.root === 'function' ? deps.root : function () { return rootOfState(getState()); };
    const setT = deps.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null);
    const clearT = deps.clearTimeout || (typeof clearTimeout === 'function' ? clearTimeout : null);

    let dirty = false;
    let timer = null;
    let seq = 0;
    let latestSeq = 0;

    /** 恢复期挂起（`INV-SESS-09`）。⚠️ dirty **不清**：恢复结束后它还得被写出去。 */
    function suspended() {
      const st = getState();
      const t = st && st.restoreToken;
      return !!(t && !t.cancelled);
    }

    /** 当前镜像（只信属于这一代的那一份）。 */
    function mirrorOf(st) {
      if (!st) return null;
      return st.dirSessionGen === st.generation ? st.dirSession : null;
    }

    function schedule() {
      if (!setT || timer) return;
      timer = setT(function () { timer = null; flush(); }, DIR_SESSION_DEBOUNCE_MS);
    }

    /** 树变了（⛔ 恢复过程不调——`FileTree` 在 `restoring` 里会抑制）。 */
    function noteTreeChange() {
      dirty = true;
      schedule();
    }

    /** 用户打开了一份文件（目录模式）：**直接写**，⛔ 不许被去抖窗口吞掉。 */
    function noteDocOpen() {
      dirty = true;
      return flush();
    }

    function flush() {
      if (timer && clearT) { clearT(timer); timer = null; }
      if (suspended()) return Promise.resolve({ status: 'suspended' });
      if (!dirty) return Promise.resolve({ status: 'clean' });

      const st = getState();
      const root = rootOf();
      // ⚠️ 不在目录模式 / 没有唯一的根 ⇒ 这次什么都不该写（调用点已经先冲刷过）。
      if (!st || st.mode !== 'directory' || !root) {
        dirty = false;
        return Promise.resolve({ status: 'ignored' });
      }
      dirty = false;

      const mirror = mirrorOf(st);
      // ⭐ **"上次的文件"取不到时，保住镜像里那一条**（R2 的另一半，§7.3 第 35 条）。
      //
      // `docInRoot` 为假有两种完全不同的原因：
      //   ① 目录刚被授权、恢复还没成功（`currentPath` 是 null）；
      //   ② 恢复**试过但失败**（文件被删 / 读不出来）。
      // 两种都不该把记录写成 `null`：那等于"恢复还没成，先把答案擦了"，
      // 下一次树操作就把它永久落盘成"没有上次的文件"。而用户**没有**任何
      // "关掉当前文档"的操作（目录模式里正文空着只是空态，不是动作）。
      // ⇒ 只有在镜像里本来也没有 `last_file` 时，才写 `null`（那才是真的没有）。
      // ⚠️ 镜像必须属于**这一代**（`mirrorOf` 已经判过）——否则 A 的文件会漏进 B。
      const lastFile = docInRoot(st, root)
        ? st.currentPath
        : ((mirror && mirror.last_file) || null);

      const built = toEntry(root, lastFile, expandedOf(tree));
      if (sameEntry(built.entry, mirror)) return Promise.resolve({ status: 'same' });

      const reqSeq = ++seq;
      latestSeq = reqSeq;
      const reqGen = st.generation;
      const reqRoot = root;

      return Promise.resolve(
        setDirSession(root, reqGen, built.entry.last_file, built.entry.expanded)
      ).then(function (res) {
        const now = getState();
        // ⭐ 三重回填闸（R5 / `INV-SESS-13`）
        if (reqSeq !== latestSeq) return { status: 'dropped', reason: 'seq' };
        if (!now || now.generation !== reqGen || !now.roots || now.roots[0] !== reqRoot) {
          return { status: 'dropped', reason: 'generation' };
        }
        now.dirSession = res && res.entry ? res.entry : null;
        now.dirSessionGen = reqGen;
        return { status: res && res.status };
      }, function (err) {
        // 写失败：记录还在后端内存里（下一次任意配置写入会顺带写下去）；
        // 置回 dirty，下一次树操作再试。
        dirty = true;
        return { status: 'failed', error: err };
      });
    }

    return {
      noteTreeChange: noteTreeChange,
      noteDocOpen: noteDocOpen,
      flush: flush,
      suspended: suspended,
      /** 仅供探针与单测：还有没有未落地的改动。 */
      isDirty: function () { return dirty; },
    };
  }

  const api = {
    MAX_EXPANDED_PER_DIR: MAX_EXPANDED_PER_DIR,
    MAX_SESSION_PATH_CHARS: MAX_SESSION_PATH_CHARS,
    DIR_SESSION_DEBOUNCE_MS: DIR_SESSION_DEBOUNCE_MS,
    isInside: isInside,
    docInRoot: docInRoot,
    toEntry: toEntry,
    restorePlan: restorePlan,
    sameEntry: sameEntry,
    shouldRestore: shouldRestore,
    createRestorer: createRestorer,
    createWriter: createWriter,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).dirSession = api;
})();
