// 文件树的**刷新、新建、复制路径与重命名**的纯逻辑（`design/0034` §2.1 A / C，§3；
// ⭐ `design/0035` §2.1 / §3.1 在它上面加了 `copyTarget` / `renameTarget` / `selectStem`）。
//
// # 这里装什么、⛔ 不装什么
//
// | 在这里 | ⛔ 不在这里 |
// |---|---|
// | 层 epoch 的判脏、按路径的请求序、事务去留决策、滚动锚点换算 | 任何 DOM 读写、任何 IPC |
// | 右键目标解析、输入行的按键语义（含中文组合态） | 谁该重列、怎么提交（那是 `FileTree.js`） |
//
// ⚠️ **为什么不塞进 `FileTree.js`**：那个文件要真 DOM 才能跑，
// 而 `tests/js/` 的 `node --test` 里没有 DOM。判据留在这份里才**真的被测到**
// （与 `services/reload.js` / `services/dirsession.js` 同一条纪律：能 `require` 的那半单独成文件）。
//
// ⚠️⚠️ **它必须排在 `FileTree.js` 之前**（`index.html`）：经典脚本按顺序执行，
// 而模块依赖是**加载期取值**（`const R = … : window.rmd.treeRefresh`）。
// 顺序反了的症状与 `0009` 的 `search.js` 同族——**只在第一次要刷新/右键时**才炸。
//
// # 三条承重约定（细节见 `design/0034` §2.1）
//
// 1. **层 epoch 记"请求发出时"的值，⛔ 不记返回值时**：请求在途中又来了事件，
//    这一层仍然算"可能旧"，下次展开要再 fresh（§A.1）。
// 2. **请求序是"按路径"的**（`layerSeq`）：父子层同时展开是**常态**，
//    全局序号会把正常并发互相判死（§A.2 末，`design/0009` 的评审结论）。
// 3. **刷新事务整体提交或整体丢弃**：`decide()` 只看三个身份（代次 / 会话令牌 / 展开版本），
//    ⛔ 不看时间、⛔ 不看"看起来像不像用户点的"（§A.2 第 4 条）。
(function () {
  'use strict';

  /** 事务被用户操作打断后**最多重跑**几次（立即一次 ＋ 1 s 后一次，§A.2 第 4 条）。 */
  const MAX_RETRIES = 2;

  /** 重跑之间的等待（毫秒）。⚠️ 第一次立即重跑，第二次隔 1 s。 */
  const RETRY_DELAY_MS = 1000;

  /**
   * `path` 这一层**可能旧**吗？（§A.1）
   *
   * 判据只有一条：这层最后一次成功列完时记下的 epoch，与当前 epoch 不同。
   * ⚠️ **没记过**也算旧（`undefined !== epoch`）——新展开的层当然要列一次。
   * @param {Map<string, number>} layerEpoch
   * @param {string} path
   * @param {number} epoch
   * @returns {boolean}
   */
  function staleLayer(layerEpoch, path, epoch) {
    return layerEpoch.get(path) !== epoch;
  }

  /**
   * 给 `path` 取一个**新的请求序号**（从 1 开始）。
   * @param {Map<string, number>} seqMap
   * @param {string} path
   * @returns {number}
   */
  function nextSeq(seqMap, path) {
    const n = (seqMap.get(path) || 0) + 1;
    seqMap.set(path, n);
    return n;
  }

  /**
   * 这次回包**还归我管**吗？
   *
   * ⚠️ 返回 `false` 的处置是"直接丢弃、不碰容器"——⛔ 连 `failed` 也不动：
   * 这一层归更晚那个请求管（§A.2「每层一个请求序」）。
   * @param {Map<string, number>} seqMap
   * @param {string} path
   * @param {number} seq
   * @returns {boolean}
   */
  function isCurrent(seqMap, path, seq) {
    return seqMap.get(path) === seq;
  }

  /** 一段路径有几段（`/a/b` → 2）。 */
  function depthOf(path) {
    return String(path).split('/').filter(function (s) { return s.length > 0; }).length;
  }

  /**
   * 让一组路径**浅→深**（同深度按字面序）。
   *
   * ⚠️ 恢复展开态时祖先必须先于后代——这是 `restoreExpanded` 的既有前提
   * （`design/0020` §2.3 ③(a) 的那条纪律），这里只是把顺序算出来，⛔ 不另写一份恢复。
   * @param {Iterable<string>} paths
   * @returns {string[]}
   */
  function sortShallowFirst(paths) {
    const out = [];
    for (const p of paths) out.push(p);
    out.sort(function (a, b) {
      const d = depthOf(a) - depthOf(b);
      if (d !== 0) return d;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    return out;
  }

  /** 某段路径的父目录；到根（没有 `/`）返回空串。 */
  function parentOf(path) {
    const s = String(path);
    const i = s.lastIndexOf('/');
    // `/abc` 的父是 `/`：`i === 0` 时返回 `/`，⛔ 不是空串。
    if (i < 0) return '';
    if (i === 0) return '/';
    return s.slice(0, i);
  }

  /**
   * `path` 之下**用户自己展开过**的那些路径（浅→深）。§A.1 末尾那一步的输入。
   *
   * ⚠️ 它的规模由**用户操作**决定，⛔ 不是"目录树有多大就遍历多少"。
   * ⚠️ 返回**快照**（数组）：调用方通常会先把活树清掉再拿它恢复。
   * @param {Set<string>|Iterable<string>} expanded
   * @param {string} path
   * @returns {string[]}
   */
  function descendants(expanded, path) {
    const prefix = path.endsWith('/') ? path : path + '/';
    const out = [];
    for (const p of expanded) {
      if (p !== path && p.indexOf(prefix) === 0) out.push(p);
    }
    return sortShallowFirst(out);
  }

  /**
   * 找**滚动锚点**：第一个底边越过容器顶边的可见行（§A.2 第 2 条）。
   *
   * @param {Array<{path:string, top:number, bottom:number}>} rows 可见行（DOM 顺序）
   * @param {number} containerTop 容器的 `getBoundingClientRect().top`
   * @returns {{path:string, offset:number}|null} `offset` = 行顶边 − 容器顶边（可为负）
   */
  function anchorRow(rows, containerTop) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].bottom > containerTop) {
        return { path: rows[i].path, offset: rows[i].top - containerTop };
      }
    }
    return null;
  }

  /**
   * 新树里锚点行该把 `scrollTop` 挪多少（§A.2 第 5 条）。
   *
   * ⚠️ 锚点行**不在新树里**（被删/被过滤）⇒ 退到**最近的存活祖先**；
   * 祖先们也不在 ⇒ 返回 `null`，调用方**只夹取滚动范围**，⛔ **不回顶部**
   * （回顶部等于把用户正在看的位置扔了，而这次刷新不是他要求的）。
   *
   * @param {{path:string, offset:number}|null} anchor
   * @param {Array<{path:string, top:number}>} rows 新树的可见行
   * @param {number} containerTop
   * @param {(p:string)=>string} [parentOfFn] 默认 [`parentOf`]
   * @returns {number|null} 要**加到** `scrollTop` 上的增量
   */
  function restoreOffset(anchor, rows, containerTop, parentOfFn) {
    if (!anchor) return null;
    const up = typeof parentOfFn === 'function' ? parentOfFn : parentOf;
    const byPath = new Map();
    for (let i = 0; i < rows.length; i++) byPath.set(rows[i].path, rows[i]);
    let p = anchor.path;
    // ⚠️ 防御：`parentOf` 在异常输入上若原地打转，这里不许变成死循环。
    for (let guard = 0; p && guard < 4096; guard++) {
      const r = byPath.get(p);
      if (r) return (r.top - containerTop) - anchor.offset;
      const next = up(p);
      if (next === p) break;
      p = next;
    }
    return null;
  }

  /**
   * 事务复核：**提交 / 丢弃 + 重跑 / 放弃**（§A.2 第 4 条；⭐ `design/0050` 加第 4 个身份）。
   *
   * 四个身份，判据是**相等**，⛔ 不是时间：
   * - `token`（`reset()` 递增的会话令牌）变了 ⇒ 整棵树都换了 ⇒ `cancelled`，⛔ 不重跑；
   * - `gen`（后端授权代次）变了 ⇒ 这一轮结果已作废 ⇒ `stale`，⛔ 不重跑；
   * - `seq`（前端内容修订，`diskevents.seq()`）变了 ⇒ **同一棵树、盘上内容变了**
   *   ⇒ `rev`，**必须**重跑（⛔ 不许丢，那是"外部改动永远不出现"）；
   * - `version`（活树展开版本）变了 ⇒ **用户动了树** ⇒ 丢弃；最多重跑 `MAX_RETRIES` 次，
   *   仍被打断 ⇒ `give_up`，调用方留 `refreshPending` 等下一次事件。
   *
   * ⚠️⚠️ **`rev` 与 `stale` 的处置正好相反**，⛔ 别合并成一个 reason：
   * `stale` 重试只会再输一次（整棵树都换了），`rev` 不重试就是把新内容丢了。
   * ⚠️ `rev` 的等待是 [`RETRY_DELAY_MS`]（⛔ 不是 0）：事件是**成簇**来的，
   * 立即重跑多半还在同一簇里、拿到同样的 `rev` ⇒ 两次预算一秒内烧光。
   *
   * @param {{gen0:number, gen:number, token0:number, token:number,
   *          version0:number, version:number, seq0?:number, seq?:number,
   *          retries?:number}} s
   * @returns {{action:'commit'|'discard'|'give_up',
   *            reason:'ok'|'cancelled'|'stale'|'rev'|'user',
   *            retry:boolean, delayMs:number}}
   */
  function decide(s) {
    if (s.token !== s.token0) {
      return { action: 'discard', reason: 'cancelled', retry: false, delayMs: 0 };
    }
    if (s.gen !== s.gen0) {
      return { action: 'discard', reason: 'stale', retry: false, delayMs: 0 };
    }
    // ⚠️ 两个 `seq` 都可能缺失（老调用点）：⚠️ **缺一个就当"没观测"**，
    //    ⛔ 别把它当成"变了"——那会让每一次刷新都白重跑一轮。
    if (typeof s.seq === 'number' && typeof s.seq0 === 'number' && s.seq !== s.seq0) {
      const retries = s.retries || 0;
      if (retries >= MAX_RETRIES) {
        return { action: 'give_up', reason: 'rev', retry: false, delayMs: 0 };
      }
      return { action: 'discard', reason: 'rev', retry: true, delayMs: RETRY_DELAY_MS };
    }
    if (s.version !== s.version0) {
      const retries = s.retries || 0;
      if (retries >= MAX_RETRIES) {
        return { action: 'give_up', reason: 'user', retry: false, delayMs: 0 };
      }
      // 第一次立即重跑（用户可能只是点了一下、树已经静下来）；第二次隔 1 s。
      return {
        action: 'discard',
        reason: 'user',
        retry: true,
        delayMs: retries === 0 ? 0 : RETRY_DELAY_MS,
      };
    }
    return { action: 'commit', reason: 'ok', retry: false, delayMs: 0 };
  }

  /**
   * 这次刷新要不要**挂起**（§A.3）。
   *
   * ⚠️ 三个条件任一成立都不许动 DOM：
   * 输入行开着（重建会把用户打了一半的名字拆掉）、创建请求在飞（回包要重列同一个父层）、
   * 已有一个事务在跑（排队而不是并发）。
   * @param {{inputOpen?:boolean, creating?:boolean, running?:boolean}} s
   * @returns {boolean}
   */
  function shouldDefer(s) {
    return !!(s && (s.inputOpen || s.creating || s.running));
  }

  /**
   * 手动刷新（右键菜单那项）是否置灰（§2.1 D）。
   * ⚠️ 判据比 [`shouldDefer`] 少一个 `running`：事务正在跑时**不置灰**，
   * 再点一次只会排到它后面（而且菜单在点击后就关了）。
   * @param {{inputOpen?:boolean, creating?:boolean}} s
   * @returns {boolean}
   */
  function manualDisabled(s) {
    return !!(s && (s.inputOpen || s.creating));
  }

  /**
   * 右键位置 → 新条目落在哪个目录（§2.1 C 那张表，**唯一一份判据**）。
   *
   * | 右键位置 | 结果 |
   * |---|---|
   * | 目录行 | 该目录 |
   * | 文件行 | 该文件的父目录 |
   * | 空白处 | 根目录 |
   * | 灰显行（`ignored`） | `null`（**不出菜单**） |
   * | 没有根（空会话） | `null` |
   *
   * ⚠️ 这里返回 `null` **只是关掉入口**，⛔ **不能替代后端校验**：
   * 直接 IPC 带一个 ignored 父路径仍必须被 `check_creatable` 拒成 `unusable_parent`。
   *
   * @param {{path:string, isDir:boolean, ignored?:boolean}|null} hit `null` = 空白处
   * @param {string|null} root
   * @returns {{dir:string, kind:'dir'|'file'|'blank'}|null}
   */
  function resolveMenuTarget(hit, root) {
    if (!root) return null;
    if (hit && hit.ignored) return null;
    if (!hit) return { dir: root, kind: 'blank' };
    if (hit.isDir) return { dir: hit.path, kind: 'dir' };
    // ⚠️ 文件行的父目录**只从路径切**：前端节点路径本来就来自 `list_dir`（`INV-TREE-01`），
    //    这里⛔ 不拼新路径，只是把最后一段去掉。
    const dir = parentOf(hit.path);
    return { dir: dir || root, kind: 'file' };
  }

  /**
   * 输入行的按键语义（§2.1 C）。
   *
   * ⚠️⚠️ **组合态必须挡在"提交"之前**：中文输入法选词时按回车，
   * 有些 WebKit 版本给出的 `e.key` 就是 `Enter`——那一下提交的是**半截拼音**。
   * 判据是 `isComposing` **或** `keyCode === 229`（`INV-SET-05` 同款两条）。
   *
   * @param {{key?:string, isComposing?:boolean, keyCode?:number}} e
   * @returns {'submit'|'cancel'|'composing'|'ignore'}
   */
  function inputAction(e) {
    if (!e) return 'ignore';
    if (e.key !== 'Enter' && e.key !== 'Escape') return 'ignore';
    if (e.isComposing || e.keyCode === 229) return 'composing';
    return e.key === 'Enter' ? 'submit' : 'cancel';
  }

  /**
   * 「复制绝对路径」的目标（`design/0035` §2.1）。
   *
   * | 右键位置 | 结果 |
   * |---|---|
   * | 文件行 / 目录行 | 该条目的**路径原样**（⛔ 不拼、⛔ 不转义、⛔ 不 trim） |
   * | 空白处（`hit === null`） | `null` |
   * | 灰显行（`ignored`） | `null` |
   * | 没有根（空会话） | `null` |
   *
   * ⚠️⚠️ **顺序是判据的一部分**：`!hit` 必须排在 `hit.ignored` **之前**——
   * 反过来写是空引用（`TypeError`），而它在右键空白处**每次**都会踩到。
   * ⚠️ 路径**一个字都不改**：用户的判据是"粘到终端里能不能直接用"（§2.1），
   * 所以这里⛔ 不加引号、⛔ 不做 shell 转义、⛔ 不裁掉尾随空格。
   *
   * @param {{path:string, isDir:boolean, ignored?:boolean}|null} hit `null` = 空白处
   * @param {string|null} root
   * @returns {string|null}
   */
  function copyTarget(hit, root) {
    if (!root) return null;
    if (!hit) return null;
    if (hit.ignored) return null;
    if (typeof hit.path !== 'string' || !hit.path) return null;
    return hit.path;
  }

  /**
   * 「重命名」的目标（`design/0035` §3.1）。只有**文件行**有这一项。
   *
   * | 情况 | 结果 |
   * |---|---|
   * | 目录行 / 空白处 / 灰显 / 没有根 | `null`（**不出这一项**） |
   * | 当前文档 ＋ 正在编辑（干净或脏） | `{path, disabled:true, reason:'editing'}` |
   * | 其余文件行 | `{path, disabled:false}` |
   *
   * ⚠️ **不判扩展名**：那会是第二份名字判据（`INV-TREE-07`）——树里本来就只列 `.md`
   * （`tree::classify` 的 `Class::Other` 不列），后端 `check_renamable` 才是判据。
   * ⚠️ 编辑态**只挡当前文档**：别的文件没被编辑器持有，改名不会碰到缓冲区
   * （§3.4：⛔ 别因为"编辑器开着"就把整棵树置灰）。
   * ⚠️ 这里置灰**只是界面上的提前告知**，⛔ **不能替代后端**：`rename_guard`
   * 用同一组条件独立拒（菜单在状态变化之前就打开了，就是它兜的那一下）。
   *
   * @param {{path:string, isDir:boolean, ignored?:boolean}|null} hit
   * @param {string|null} root
   * @param {{editing?:boolean, current?:string|null}} [st]
   * @returns {{path:string, disabled:boolean, reason?:string}|null}
   */
  function renameTarget(hit, root, st) {
    if (!root) return null;
    if (!hit) return null;
    if (hit.ignored) return null;
    if (hit.isDir) return null;
    if (typeof hit.path !== 'string' || !hit.path) return null;
    const s = st || {};
    if (s.editing === true && s.current === hit.path) {
      return { path: hit.path, disabled: true, reason: 'editing' };
    }
    return { path: hit.path, disabled: false };
  }

  /**
   * 「在访达中显示」的目标（`design/0048`）。**文件行与目录行都有**这一项。
   *
   * | 情况 | 结果 |
   * |---|---|
   * | 文件行 | `{path, isDir:false}` ⇒ 后端用 `open -R`（定位并**选中**） |
   * | 目录行 | `{path, isDir:true}` ⇒ 后端用 `open <dir>`（**打开**这个目录） |
   * | 空白处（`hit === null`） | `null` |
   * | 灰显行（`ignored`） | `null` |
   * | 没有根（空会话） | `null` |
   *
   * ⚠️ **顺序是判据的一部分**：`!hit` 必须排在 `hit.ignored` **之前**（同 `copyTarget`：
   * 反过来写是空引用，而右键空白处**每次**都会踩到）。
   * ⚠️ `isDir` **只当提示**用（后端按 `check_readable` 返回的**规范路径**自己判类型）——
   * 软链、名字里带点、`.` 开头的目录都以前端那个 `hit.isDir` 为准会错。
   * ⚠️ 路径**一个字都不改**（⛔ 不 trim、⛔ 不转义）：后端会 `canonicalize`，
   * 前端拼/裁路径就是在造第二条真值。
   *
   * @param {{path:string, isDir:boolean, ignored?:boolean}|null} hit `null` = 空白处
   * @param {string|null} root
   * @returns {{path:string, isDir:boolean}|null}
   */
  function revealTarget(hit, root) {
    if (!root) return null;
    if (!hit) return null;
    if (hit.ignored) return null;
    if (typeof hit.path !== 'string' || !hit.path) return null;
    return { path: hit.path, isDir: hit.isDir === true };
  }

  /** 路径最后一段（`/a/b.md` → `b.md`；`/` → 空串）。 */
  function baseName(path) {
    const s = String(path);
    const i = s.lastIndexOf('/');
    return i < 0 ? s : s.slice(i + 1);
  }

  /**
   * 输入行里**选中哪一段**：只选主名，后缀留在选中范围之外（§3.2 的"就地改名"）。
   *
   * - `note.md` ⇒ `{start:0, end:4}`，打字直接换主名、`.md` 不动；
   * - `a.b.md` ⇒ `{start:0, end:3}`（⚠️ 是**最后一个**点，⛔ 不是第一个）；
   * - 没有点 / 以点开头 ⇒ 全选（⛔ 不返回一个空选区）。
   *
   * ⚠️ 这里按"最后一个点"切只是**选区**，⛔ 不是"合法名字"的判据。
   *
   * @param {string} name
   * @returns {{start:number, end:number}}
   */
  function selectStem(name) {
    const s = String(name || '');
    const i = s.lastIndexOf('.');
    if (i <= 0) return { start: 0, end: s.length };
    return { start: 0, end: i };
  }

  /** `not_renamable` 的 `reason` → 文案键（⛔ 不做字符串拼接，字典闸门认字面量）。 */
  const RENAME_REASON_KEY = {
    symlink: 'err.rename.symlink',
    not_markdown: 'err.rename.not_markdown',
    editing: 'err.rename.editing',
  };

  /** 后端 `degraded` 标签 → 提示文案键（§3.5：改名成功但某一半降级了）。 */
  const DEGRADED_KEY = {
    watch: 'tree.rename.degraded.watch',
    path_check: 'tree.rename.degraded.path_check',
  };

  /**
   * 复制失败 → 文案键（`design/0035` §2.4 的三类）。
   *
   * ⚠️ 键是**字面量**（⛔ 不拼 `'tree.copy.' + reason`）：字典闸门只认字面量，
   * 拼出来的键等于**没有登记的文案**。⚠️ 未知 reason 一律落到"复制失败"——
   * ⛔ 不猜一个更具体的说法。
   */
  const COPY_FAIL_KEY = {
    unsupported: 'tree.copy.unsupported',
    denied: 'tree.copy.denied',
    failed: 'tree.copy.failed',
  };

  /**
   * @param {string} reason 「`clipboard.js` 的失败类别」（`unsupported`/`denied`/`failed`）
   * @returns {string} 字典键
   */
  function copyFailKey(reason) {
    return COPY_FAIL_KEY[reason] || COPY_FAIL_KEY.failed;
  }

  /**
   * 改名成功、父层重列完成之后，**要不要把高亮挂到新路径上**。
   *
   * ⚠️⚠️ 判据取**重列完成那一刻**的当前文档（`currentPath`），⛔ 不盲信后端回包里的
   * `current_moved`：从"改名返回"到"重列完成"之间可能已经过去了若干次 `await`，
   * 用户完全可能在这期间打开了另一份文档（`design/0035` §10.6 的 P2）。
   * 那时把旧文档的新名字高亮上去，界面就会变成"树里亮的是 A，正文显示的是 B"。
   *
   * @param {string|null} currentPath 重列完成那一刻 `S.state.currentPath`
   * @param {string|null} newPath 改名后的路径（`res.path`）
   * @returns {boolean}
   */
  function highlightRenamed(currentPath, newPath) {
    return !!newPath && currentPath === newPath;
  }

  /**
   * `degraded` 列表 → 要显示的文案键数组（⚠️ **字面量表**，⛔ 不拼 `'…' + x`：
   * `i18n.test.js` 的闸门不认拼接出来的键，拼了等于**没登记的文案**）。
   *
   * @param {string[]} degraded
   * @returns {string[]}
   */
  function degradedKeys(degraded) {
    const out = [];
    if (!Array.isArray(degraded)) return out;
    for (let i = 0; i < degraded.length; i++) {
      const key = DEGRADED_KEY[degraded[i]];
      if (key) out.push(key);
    }
    return out;
  }

  /**
   * 错误对象 → 给人看的一句（§2.3 第 2 条：**只有文案映射，没有规则判断**）。
   *
   * ⚠️ 名字规则**只在后端**（`INV-TREE-07`）：这里只把 `raw.reason` 翻成一句人话，
   * ⛔ 不重新判一遍"这个名字合不合法"。`not_renamable` 同理（§3.4）。
   *
   * @param {{kind?:string, wording?:string, message?:string, raw?:object}} e
   * @param {(key:string, vars?:object)=>string} t 翻译器
   * @returns {string}
   */
  function errorText(e, t) {
    if (!e) return '';
    const tr = typeof t === 'function' ? t : function (k) { return k; };
    const reason = e.raw && e.raw.reason;
    if (typeof reason === 'string' && reason) {
      // ⚠️ 键来自**字面量表**（`RENAME_REASON_KEY` / `'err.name.' + reason` 的两种形态）：
      //    前者是查表，后者是既有 `invalid_name` 的约定（键集合在字典里一一对应）。
      let key = '';
      if (e.kind === 'invalid_name') key = 'err.name.' + reason;
      else if (e.kind === 'not_renamable') key = RENAME_REASON_KEY[reason] || '';
      if (key) {
        const s = tr(key);
        // ⚠️ 字典里没这条时 `t` 会退回 key 本身——那比"名字不合法"更难看，
        //    所以只在**真的查到了**的时候用它。
        if (typeof s === 'string' && s && s !== key) return s;
      }
    }
    if (e.wording) return e.wording;
    if (e.message) return e.message;
    return tr('err.kind.other');
  }

  const api = {
    MAX_RETRIES,
    RETRY_DELAY_MS,
    staleLayer,
    nextSeq,
    isCurrent,
    depthOf,
    sortShallowFirst,
    parentOf,
    descendants,
    anchorRow,
    restoreOffset,
    decide,
    shouldDefer,
    manualDisabled,
    resolveMenuTarget,
    copyTarget,
    renameTarget,
    revealTarget,
    baseName,
    selectStem,
    RENAME_REASON_KEY,
    DEGRADED_KEY,
    COPY_FAIL_KEY,
    degradedKeys,
    highlightRenamed,
    copyFailKey,
    inputAction,
    errorText,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).treeRefresh = api;
})();
