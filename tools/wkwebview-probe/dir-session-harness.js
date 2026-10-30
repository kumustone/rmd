// rmd · 目录会话恢复的**真 DOM 离屏探针**（跑 `design/0020` §7.4 的判据 46–52）
//
// ⭐ 跑的是**产品那几份**，原样拷进页面，⛔ 探针不抄第二份实现：
//    · `src/services/dirsession.js` —— 恢复事务 / 恢复计划 / 包含判据（全部判定）；
//    · `src/components/FileTree.js`  —— `restoreExpanded` / `expand` / `notifyState`
//      / `notifyUserToggle`（判据 46–49、51 的被测面）；
//    · `src/services/session.js` ＋ `versions.js` ＋ `chunked.js` ＋ `search.js`
//      ＋ `tauri.js` —— 树读一层要走真 `listDir`（提交判据只有 `gen`），
//      `open_document` 要走真 `docCommitDecision`（`gen` ＋ `req`）。
//
// ⚠️ **假后端下沉到 `invoke` 那一层**（设计原话是"用内存里的假 `session` 层供树"）。
//    再往下探一层是为了让 `session.js` 的两条提交判据**跟着一起跑**：
//    ① `list_dir` 的 `gen` 闸（`filetree.js::fillLayer` 的 `payload.decision.commit`）；
//    ② `open_document` 的 `gen` ＋ `req` 闸（判据 50 要走真 `S.openDocument`）。
//    ⚠️ 这是**加强**不是放宽：假的东西只剩"磁盘里有什么"。
//    ⛔ 但 `invoke` 是同步 resolve 的 ⇒ 判据 52 的耗时**不含真实 IPC 延迟**，
//    它只是前端侧（DOM ＋ JS）的**下界**，写在 `值` 里，⛔ 别当成端到端数字引用。
//
// ⚠️ 唯一"照抄"的是 `src/main.js` 的两处接线（根脚本进不了探针页）：
//    ① `renderSidebar()` 在 `restorer.run()` 之后按 `state.currentPath` 定位（判据 50）；
//    ② `mountDocument()` 里 `tree.setCurrent(payload.real_path)`（判据 50 的当前项来源）。
//    镜像只有这两行，且都写在 `probeOpenDocument` / `t50` 的注释里。
//
// ⚠️ 离屏的安全形态（根 `CLAUDE.md` 工作约定 4）：
//    本文件只改**自己页面里的 DOM**、只在页面内 `dispatchEvent` / `element.click()`
//    （不可信事件，⛔ 不点亮任何系统级输入）。窗口由 `.swift` 那边
//    `alphaValue = 0` ＋ `orderBack` 建成，⛔ 全程不 `NSApp.activate`。
//
// 约定：`window.__RUN()` 返回 `{环境, 夹具, 检查, 结论}`；判据在**退出码**上（`.sh` 聚合）。
(function () {
  'use strict';

  const S = window.rmd.session;
  const D = window.rmd.dirSession;
  const FT = window.rmd.fileTree;

  const ROOT = '/probe/wiki';
  const host = document.getElementById('pane-tree');

  // ── 假文件系统：只有"磁盘里有什么"是假的 ─────────────────────────────
  const FS = Object.create(null);

  function ensureDir(p) { if (!FS[p]) FS[p] = []; return p; }

  function add(parent, name, isDir) {
    ensureDir(parent);
    const path = parent + '/' + name;
    FS[parent].push({ path: path, name: name, is_dir: !!isDir, ignored: false });
    if (isDir) ensureDir(path);
    return path;
  }

  function pad3(n) { return ('00' + n).slice(-3); }

  ensureDir(ROOT);
  add(ROOT, 'a.md', false);
  add(ROOT, 'b.md', false);
  const DOCS = add(ROOT, 'docs', true);
  const X_MD = add(DOCS, 'x.md', false);
  const DEEP = add(DOCS, 'deep', true);
  add(DEEP, 'y.md', false);
  const NOTES = add(ROOT, 'notes', true);
  add(NOTES, 'n.md', false);
  add(ROOT, 'archive', true);
  add(ROOT + '/archive', 'z.md', false);
  // ⭐ 判据 52：200 条展开（与 `MAX_EXPANDED_PER_DIR` 同一把尺子，恰好卡在上限）
  const T200 = [];
  for (let i = 1; i <= 200; i++) {
    const p = add(ROOT, 'd' + pad3(i), true);
    add(p, 'f.md', false);
    T200.push(p);
  }

  function copyEntry(e) {
    return { path: e.path, name: e.name, is_dir: e.is_dir, ignored: e.ignored };
  }

  // ── 假 IPC：真 `tauri.js` / `session.js` 全都照常跑 ────────────────────
  const calls = Object.create(null);
  function bump(cmd) { calls[cmd] = (calls[cmd] || 0) + 1; }

  function fakeInvoke(cmd, args) {
    bump(cmd);
    const a = args || {};
    // ⚠️ 代次**现取**（⛔ 不是发请求那一刻的）：真后端回的是它当刻的代次，
    //    而 `session.js` 的提交判据正是拿它跟当刻的 `state.generation` 比。
    const st = S && S.state ? S.state : { generation: 1 };

    if (cmd === 'get_session') {
      return Promise.resolve({
        generation: 1,
        mode: 'directory',
        roots: [ROOT],
        files: [],
        pending_directory: null,
        startup_document: null,
        sidebar_width: 280,
        last_directory: ROOT,
        reading_progress: {},
        doc_seq: 0,
        dir_session: null,
      });
    }
    if (cmd === 'list_dir') {
      const list = FS[a.path];
      if (!list) {
        return Promise.reject({
          kind: 'not_found',
          path: a.path,
          message: 'probe 的文件系统里没有 ' + a.path,
        });
      }
      return Promise.resolve({ gen: st.generation, req: a.req, entries: list.map(copyEntry) });
    }
    if (cmd === 'open_document') {
      return Promise.resolve({
        gen: st.generation,
        req: a.req,
        real_path: a.path,
        doc_dir: String(a.path).replace(/\/[^/]*$/, ''),
        // ⚠️ 两个都假：`step3Needed` 为假 ⇒ ⛔ 不会顺手 `close_directory`
        //    （那会把 `roots` 清掉，后面的判据就全在测另一个世界）。
        roots_nonempty: false,
        outside_roots: false,
        toc: [],
        toc_entries: 0,
      });
    }
    if (cmd === 'set_dir_session') {
      // ⚠️ 形状与真后端一致：`{status, entry, evicted}`，`entry` 是规范化后的那一份。
      return Promise.resolve({
        status: 'ok',
        entry: {
          last_file: a.last_file === undefined ? null : a.last_file,
          expanded: Array.isArray(a.expanded) ? a.expanded.slice() : [],
          updated_at: 1,
        },
        evicted: [],
      });
    }
    return Promise.reject({ kind: 'not_found', message: 'probe 没实现命令 ' + cmd });
  }

  window.__TAURI__ = { core: { invoke: fakeInvoke } };

  // ── 树（产品那份）＋ 两个通知计数（判据 48/49 的被测面）──────────────
  let stateChange = 0;
  let userToggle = 0;

  const tree = FT.createFileTree({
    host: host,
    onOpenFile: function () {},
    onError: function () {},
    // ⭐ `design/0020`：这两个回调**就是**写者与恢复器的输入（`main.js` 里接的是
    //    `dirWriter.noteTreeChange` / `dirRestorer.noteUserToggle`）。
    //    这里换成计数器——判据 48/49 问的就是"它们各响了几次"。
    onStateChange: function () { stateChange += 1; },
    onUserToggle: function () { userToggle += 1; },
  });

  /** ⭐ 作品那一条的开文档路径（⛔ 探针不自己造 payload）。 */
  function probeOpenDocument(path) {
    return S.openDocument(path).then(function (r) {
      // ⚠️ 镜像 `main.js::mountDocument` 的最后一步（当前项高亮，至多一个）。
      //    判据 50 的 `.node.current` 就是这一下挂上去的。
      if (r && r.payload) tree.setCurrent(r.payload.real_path);
      return r ? r.payload : null;
    });
  }

  function makeRestorer() {
    return D.createRestorer({
      getState: function () { return S.state; },
      tree: tree,
      openDocument: probeOpenDocument,
    });
  }

  /** 探针自己的观察工具（⛔ 不是产品判据）：按 `dataset.path` 找节点。 */
  function nodeByPath(p) {
    const all = host.querySelectorAll('.node');
    for (let i = 0; i < all.length; i++) if (all[i].dataset.path === p) return all[i];
    return null;
  }

  function expandedNodes() { return host.querySelectorAll('.node.expanded').length; }

  /**
   * 把会话摆成"这一代还没恢复过、记录是 `entry`"的形状，再把树重列一遍。
   * ⚠️ `restoredGen = 0` 是必须的：恢复事务跑过一次就会把这一代标成"恢复过"（幂等），
   *    不重置的话下一条判据拿到的是 `idle`（它不是在测它想测的东西）。
   */
  async function freshSession(entry) {
    S.state.restoreToken = null;
    S.state.restoredGen = 0;
    S.state.dirSession = entry;
    S.state.dirSessionGen = S.state.generation;
    S.state.currentPath = null;
    S.state.currentDoc = null;
    const r = await tree.showRoot(ROOT);
    // ⚠️ `showRoot` 期间的计数不属于任何判据（它本来就不该有）；
    //    清零之后再开始数，判据 48/49 才是在问"恢复/用户动作各响了几次"。
    stateChange = 0;
    userToggle = 0;
    return r;
  }

  // ── 判据记录的公共形状 ──────────────────────────────────────────────
  const checks = [];
  function rec(id, name, ok, criterion, value) {
    checks.push({
      id: String(id),
      名: name,
      结果: ok ? '通过' : '失败',
      判据: criterion,
      值: value,
    });
  }

  // ── 判据 46：3 层展开 → 恢复出 3 个 `.expanded` ──────────────────────
  async function t46() {
    const want = [DOCS, NOTES, DEEP];
    await freshSession({ last_file: null, expanded: want.slice(), updated_at: 1 });
    const r = await makeRestorer().run();
    const got = tree.expandedPaths().slice().sort();
    const ok = r.restored === 3 && r.skipped === 0 && r.cancelled === false &&
               r.opened === false && expandedNodes() === 3 &&
               got.join('|') === want.slice().sort().join('|');
    return {
      ok: ok,
      criterion: '3 条记录全部恢复 ∧ DOM 里恰好 3 个 .node.expanded ∧ 集合与记录逐条相同',
      value: { run: r, dom展开数: expandedNodes(), 树里的集合: got, 记录里: want.slice().sort() },
    };
  }

  // ── 判据 47：5 条记录里 2 条不存在 → 恢复 3、跳过 2、⛔ 没有灰字 ─────
  async function t47() {
    const recorded = [DOCS, DEEP, NOTES, ROOT + '/ghost', DOCS + '/gone'];
    await freshSession({ last_file: null, expanded: recorded.slice(), updated_at: 1 });
    const r = await makeRestorer().run();
    const notes = host.querySelectorAll('.note').length;
    const ok = r.restored === 3 && r.skipped === 2 && notes === 0 && expandedNodes() === 3;
    return {
      ok: ok,
      criterion: '恢复 3 条 ∧ skipped == 2 ∧ 树里一条 .note 灰字都没有（静默跳过）',
      value: {
        run: r,
        recorded: recorded.slice().sort(),
        树里的集合: tree.expandedPaths().slice().sort(),
        dom展开数: expandedNodes(),
        '灰字(.note)条数': notes,
      },
    };
  }

  // ── 判据 48：恢复过程 `onStateChange` 一次都不响（`INV-SESS-08`）──────
  async function t48() {
    const want = [DOCS, NOTES, DEEP];
    await freshSession({ last_file: null, expanded: want.slice(), updated_at: 1 });
    const before = stateChange;
    const r = await makeRestorer().run();
    const after = stateChange;
    // ⚠️ 这个判据**必须有"确实展开了"这一半**：否则"零次通知"也可能
    //    只是"什么都没发生"（那是一种**空真**，不是它要证明的东西）。
    const ok = after === before && r.restored === 3 && expandedNodes() === 3;
    return {
      ok: ok,
      criterion: '恢复期间 onStateChange 零次 ∧ 同时确实展开了 3 层（非空真）',
      value: { onStateChange: { before: before, after: after }, run: r, dom展开数: expandedNodes() },
    };
  }

  // ── 判据 49：用户折叠一层 → 两个回调各恰好一次 ───────────────────────
  async function t49() {
    const want = [DOCS, NOTES];
    await freshSession({ last_file: null, expanded: want.slice(), updated_at: 1 });
    await makeRestorer().run();
    const node = nodeByPath(DOCS);
    if (!node) throw new Error('没找到 ' + DOCS + ' 的节点（恢复没成功？）');
    // ⚠️ 只数**用户动作**带来的那两次：恢复那一段的计数在这里之前的
    //    `freshSession` 已经清零，而恢复本身按判据 48 应当零次。
    stateChange = 0;
    userToggle = 0;
    node.firstElementChild.click();   // 点 `.row` = 用户折叠
    const ok = stateChange === 1 && userToggle === 1 &&
               !tree.expanded.has(DOCS) && expandedNodes() === 1;
    return {
      ok: ok,
      criterion: '用户折叠一层 ⇒ onStateChange 恰好 1 次 ∧ onUserToggle 恰好 1 次 ∧ 该层真的收起',
      value: {
        onStateChange: stateChange,
        onUserToggle: userToggle,
        仍展开: tree.expandedPaths().slice().sort(),
        dom展开数: expandedNodes(),
      },
    };
  }

  // ── 判据 50：恢复后 `.node.current` 恰好一个，且是上次的文件 ──────────
  async function t50() {
    await freshSession({ last_file: X_MD, expanded: [DOCS], updated_at: 1 });
    const r = await makeRestorer().run();
    // ⚠️ 镜像 `main.js::renderSidebar()` 第 4.6 步：`run()` 之后按
    //    `state.currentPath` 定位（恢复器自己**不**设当前项——它的纪律 4）。
    let reveal = null;
    if (S.state.currentPath) reveal = await tree.revealPath(S.state.currentPath);
    const cur = host.querySelectorAll('.node.current');
    const ok = r.opened === true && S.state.currentPath === X_MD &&
               cur.length === 1 && cur[0].dataset.path === X_MD &&
               !!reveal && reveal.ok === true;
    return {
      ok: ok,
      criterion: '恢复了记录里的文件 ∧ currentPath == last_file ∧ DOM 里 .node.current 恰好一个且是它',
      value: {
        run: r,
        currentPath: S.state.currentPath,
        '当前项个数': cur.length,
        当前项: cur.length ? cur[0].dataset.path : null,
        reveal: reveal,
      },
    };
  }

  // ── 判据 51：`shouldContinue` 恒假 ⇒ 一条都不展开（R3 在真树上）──────
  async function t51() {
    const paths = [DOCS, NOTES];
    await freshSession({ last_file: null, expanded: paths.slice(), updated_at: 1 });
    // ⚠️ 直接调产品那个 API（⛔ 不经过恢复器）：要问的正是 `restoreExpanded`
    //    自己有没有在**每一步之前**问一次 `shouldContinue`。
    const r = await tree.restoreExpanded(paths.slice(), function () { return false; });
    const ok = r.restored === 0 && r.skipped === 0 && r.cancelled === true &&
               tree.expandedPaths().length === 0 && expandedNodes() === 0;
    return {
      ok: ok,
      criterion: 'shouldContinue 恒假 ⇒ restored=0 ∧ cancelled=true ∧ 树里零个展开（一次都没动）',
      value: { run: r, 树里的集合: tree.expandedPaths().slice(), dom展开数: expandedNodes() },
    };
  }

  // ── 判据 52：200 条展开的恢复耗时（§7.7 的数据来源）──────────────────
  async function t52() {
    await freshSession({ last_file: null, expanded: T200.slice(), updated_at: 1 });
    const listBefore = calls.list_dir || 0;
    const t0 = performance.now();
    const r = await makeRestorer().run();
    const ms = performance.now() - t0;
    const listCalls = (calls.list_dir || 0) - listBefore;
    const ok = r.restored === 200 && r.skipped === 0 && ms < 2000;
    return {
      ok: ok,
      criterion: '200 条全部恢复 ∧ 耗时 < 2000 ms（§7.7 的预算）',
      value: {
        run: r,
        毫秒: Math.round(ms * 100) / 100,
        list_dir次数: listCalls,
        dom展开数: expandedNodes(),
        '⚠️ 口径': '假 IPC 同步 resolve ⇒ 这里**不含**真实 IPC 延迟，是前端侧的下界；' +
                   '端到端（真盘 + 真 IPC）只会更慢。',
      },
    };
  }

  // ── 总装 ────────────────────────────────────────────────────────────
  window.__RUN = async function () {
    const t0 = Date.now();
    const errors = [];

    if (!S || !D || !FT) {
      return {
        致命: '产品模块没加载齐：session=' + !!S + ' dirSession=' + !!D +
              ' fileTree=' + !!FT + '；加载期错误：' + JSON.stringify(window.__LOADERR || []),
      };
    }

    // ① 会话就从"目录刚被授权"那一格起步（⛔ 不猜，走真 `get_session`）。
    await S.refresh();
    const bad = [];
    if (S.state.mode !== 'directory') bad.push('mode=' + S.state.mode);
    if (!S.state.roots || S.state.roots.length !== 1 || S.state.roots[0] !== ROOT) {
      bad.push('roots=' + JSON.stringify(S.state.roots));
    }
    if (S.state.generation !== 1) bad.push('generation=' + S.state.generation);
    if (bad.length) {
      return { 致命: '会话起步不对：' + bad.join('；') + '（假后端与 session.js 的契约漂了？）' };
    }

    const tests = [
      [46, '3 层展开全部恢复', t46],
      [47, '2 条不存在 ⇒ 静默跳过', t47],
      [48, '恢复期 onStateChange 零次', t48],
      [49, '用户折叠 ⇒ 两个回调各一次', t49],
      [50, '恢复后当前项恰好一个', t50],
      [51, 'shouldContinue 恒假 ⇒ 一条都不展开', t51],
      [52, '200 条恢复耗时', t52],
    ];

    for (const [id, name, fn] of tests) {
      try {
        const r = await fn();
        rec(id, name, r.ok, r.criterion, r.value);
      } catch (e) {
        errors.push({ id: id, error: String((e && e.stack) || e) });
        rec(id, name, false, '抛错', String((e && e.message) || e));
      }
    }

    return {
      环境: {
        加载期错误: window.__LOADERR || [],
        后端命令调用: Object.assign({}, calls),
        视口: { clientHeight: host.clientHeight, scrollHeight: host.scrollHeight },
        墙钟秒: Math.round((Date.now() - t0) / 10) / 100,
        '⚠️ 判据 53/54': '变异测试由 .sh 施加在**页面副本**上（⛔ 不碰仓库文件）：' +
                        'M53 把 restoreExpanded 的 restoring 抑制去掉（判据 48 必须红）；' +
                        'M54 把 shouldContinue 短路成恒真（判据 51 必须红）',
        错误: errors,
      },
      夹具: {
        根: ROOT,
        内容: 'a.md / b.md / docs/{x.md, deep/y.md} / notes/n.md / archive/z.md' +
              ' ＋ 判据 52 的 200 个平级目录 d001..d200',
        '⚠️ 假的那一层': 'window.__TAURI__.core.invoke（只有"磁盘里有什么"是假的）' +
                         '；tauri.js / session.js / versions.js / dirsession.js / FileTree.js 全是产品原样',
        '⚠️ 镜像的接线': 'main.js 那两处（run() 之后按 currentPath 定位；mountDocument 里 setCurrent）' +
                         '——根脚本进不了探针页',
      },
      检查: checks,
      结论: {
        通过: checks.filter(function (c) { return c.结果 === '通过'; }).length,
        失败: checks.filter(function (c) { return c.结果 === '失败'; }).length,
        跳过: 0,
      },
    };
  };

  window.__READY = true;
})();
