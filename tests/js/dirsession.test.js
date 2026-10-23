// `design/0020` §7.3 的 23 条（#23–#45）：目录会话的**纯逻辑** ＋ **协调器时序**
// ＋ 4 条**源码级接线闸门**。
//
// ⚠️ 这些断言的错法**全是静默的**（这一族在 `bugs/0003/0004/0005/0006` 里已经栽过五次）：
//    `isInside` 少了补分隔符 ⇒ `rootfoo` 从前缀陷阱里溜过去（`INV-FS-01` 的同族）；
//    `sameEntry` 认了顺序 ⇒ 每折一次就写一次盘；认不出"没变" ⇒ 同样；
//    `flush()` 在恢复期不挂起 ⇒ **先把上次的文件抹成 null 再去找它**（R2）；
//    `run()` 少一次 `alive()` ⇒ 切根之后还在旧树上展开（R3）；
//    `flush()` 的回填少一道闸 ⇒ A 的迟到回包把 B 的镜像顶掉（R5）。
// ⇒ 逐条钉边界，⛔ 不靠"看起来对"。
//
// ⭐ 时序用例**全部用可手控的 Promise**（`deferred()`）造，⛔ **不睡真时间**：
//    `deps` 全注入（`getState` / `tree` / `openDocument` / `setDirSession` / 定时器），
//    所以"响应先发后回"这种交错可以在 node 里逐帧摆出来。
// ⚠️ 这不是"为了测试"：评审 R3/R5 指出的全是时序问题，而 `main.js` 不进 `tests/js/`
//    ⇒ 编排必须在 `dirsession.js` 里、接线只能由 #42–#45 那四条源码级闸门盯着。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const D = require('../../src/services/dirsession.js');

const ROOT = path.join(__dirname, '..', '..');

// ── 小夹具 ───────────────────────────────────────────────────────────

const A = '/a/root';

/** 一份"目录模式、已授权"的最小状态。⚠️ 字段名与 `services/session.js` 的 `state` 一致。 */
function mkState(over) {
  return Object.assign({
    mode: 'directory',
    roots: [A],
    files: [A],
    currentPath: null,
    currentDoc: null,
    dirSession: null,
    dirSessionGen: 0,
    restoredGen: 0,
    restoreToken: null,
    generation: 1,
  }, over || {});
}

/** 可手控的 Promise（⛔ 不睡真时间：`await` 的每一帧都由用例自己放行）。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
  return { promise: promise, resolve: resolve, reject: reject };
}

/**
 * 假的 `FileTree`：只实现两个协调器要用的两件事。
 *
 * ⚠️ `restoreExpanded` 的语义**逐条照抄** `components/FileTree.js` 那一份：
 *    **每步之前**问一次 `shouldContinue()`；问不过就收手并报 `cancelled`。
 *    （真树还多一层 `restoring` 抑制，那半由 `make probe-dir-session` 守。）
 */
function mkTree(opts) {
  const o = opts || {};
  const expanded = new Set(o.expanded || []);
  const missing = new Set(o.missing || []);
  const view = {
    expanded: expanded,
    /** 每一步展开之后的钩子（用例在这里改世界：换代次 / 取消 / 用户折叠）。 */
    onStep: o.onStep || null,
    expandedPaths: function () { return Array.from(expanded); },
    restoreExpanded: async function (paths, shouldContinue) {
      const cont = typeof shouldContinue === 'function' ? shouldContinue : function () { return true; };
      const list = Array.isArray(paths) ? paths : [];
      let restored = 0;
      let skipped = 0;
      for (let i = 0; i < list.length; i++) {
        if (!cont()) return { restored: restored, skipped: skipped, cancelled: true };
        if (missing.has(list[i])) { skipped += 1; continue; }
        expanded.add(list[i]);
        restored += 1;
        if (view.onStep) view.onStep(i, list[i]);
      }
      return { restored: restored, skipped: skipped, cancelled: false };
    },
  };
  return view;
}

/** 定时器桩：⛔ 不让 500 ms 去抖真的跑起来（用例自己调 `flush()`）。 */
function noopTimer() { return 0; }

function mkWriter(state, tree, setDirSession) {
  return D.createWriter({
    getState: function () { return state; },
    tree: tree,
    setDirSession: setDirSession,
    setTimeout: noopTimer,
    clearTimeout: function () {},
  });
}

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 剥注释（行 ＋ 块）。⚠️ 见 `sync.test.js` 那份的同一条说明。 */
function 去注释(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** ⭐ **裸判据**：按花括号配平抠出某个 `function 名(` 的函数体（剥注释后调用）。 */
function 身体(code, 名) {
  const 头 = new RegExp('(?:async\\s+)?function\\s+' + 名 + '\\s*\\(');
  const m = 头.exec(code);
  if (!m) return null;
  const 开 = code.indexOf('{', m.index);
  if (开 < 0) return null;
  let 深 = 0;
  for (let i = 开; i < code.length; i++) {
    if (code[i] === '{') 深++;
    else if (code[i] === '}') { 深--; if (深 === 0) return code.slice(开, i + 1); }
  }
  return null;   // 配不平 ⇒ 当作没抠到（⛔ 不假装成功）
}

/** 从 `from` 之后第一个 `{` 起配平出一整块（`if (...) { … }` 的那半）。 */
function 块(code, from) {
  const 开 = code.indexOf('{', from);
  if (开 < 0) return null;
  let 深 = 0;
  for (let i = 开; i < code.length; i++) {
    if (code[i] === '{') 深++;
    else if (code[i] === '}') { 深--; if (深 === 0) return code.slice(开, i + 1); }
  }
  return null;
}

// ══ 纯函数（#23–#31）══════════════════════════════════════════════════

test('#23 isInside：`rootfoo` 不在 `root` 里（前缀陷阱）', function () {
  assert.strictEqual(D.isInside(A, '/a/rootfoo'), false);
  assert.strictEqual(D.isInside(A, '/a/rootfoo/bar'), false);
  assert.strictEqual(D.isInside(A, '/a/root/foo'), true);
  // ⚠️ 这一条不是文字游戏：`INV-FS-01` 的同族失效形态就是"少补一个分隔符"，
  //    而它在前端这半边会让"别的目录的文件"被当成"这个根里的当前文档"写进会话。
});

test('#24 isInside：相等为真、带尾斜杠为真、空串为假', function () {
  assert.strictEqual(D.isInside(A, A), true);
  assert.strictEqual(D.isInside(A + '/', '/a/root/x'), true);
  assert.strictEqual(D.isInside('', '/a/root'), false);
  assert.strictEqual(D.isInside(A, ''), false);
  assert.strictEqual(D.isInside(null, '/a/root'), false);
});

test('#25 restorePlan：由浅到深（祖先一定在后代之前）', function () {
  const plan = D.restorePlan({
    last_file: null,
    expanded: ['/a/root/a/b/c', '/a/root/a', '/a/root/a/b'],
  }, A);
  assert.deepStrictEqual(plan.dirs, ['/a/root/a', '/a/root/a/b', '/a/root/a/b/c']);
  // ⚠️ 顺序是**承重**的：后代在祖先之前展开 ⇒ 真树里 `findNode` 找不到那个节点，
  //    整条链在第一次就 `skipped`（而屏幕上只会少展开几层，不报错）。
});

test('#26 restorePlan：去重、丢 root 自身、丢越界、丢非字符串', function () {
  const plan = D.restorePlan({
    last_file: null,
    expanded: ['/a/root/a', '/a/root/a', '/a/root', '/b/other', '/a/root/b', 42, null, ''],
  }, A);
  assert.deepStrictEqual(plan.dirs, ['/a/root/a', '/a/root/b']);
});

test('#27 restorePlan：`file` 越界 → null', function () {
  assert.strictEqual(D.restorePlan({ last_file: '/elsewhere/x.md' }, A).file, null);
  assert.strictEqual(D.restorePlan({ last_file: A }, A).file, null);
  assert.strictEqual(D.restorePlan({ last_file: '/a/root/x.md' }, A).file, '/a/root/x.md');
  assert.strictEqual(D.restorePlan({ last_file: null }, A).file, null);
});

test('#28 sameEntry：只差 `updated_at` / 顺序 → 视为相同（不写）', function () {
  const a = { last_file: '/a/root/x.md', expanded: ['/a/root/a', '/a/root/b'], updated_at: 1 };
  const b = { last_file: '/a/root/x.md', expanded: ['/a/root/b', '/a/root/a'], updated_at: 999 };
  assert.strictEqual(D.sameEntry(a, b), true);
  assert.strictEqual(D.sameEntry(a, { last_file: '/a/root/y.md', expanded: a.expanded }), false);
  assert.strictEqual(D.sameEntry(a, { last_file: a.last_file, expanded: ['/a/root/a'] }), false);
  assert.strictEqual(D.sameEntry(null, null), true);
  assert.strictEqual(D.sameEntry(a, null), false);
});

test('#29 toEntry：`expanded` 传 `Set` / 数组两种形态结果一致', function () {
  const viaSet = D.toEntry(A, '/a/root/x.md', new Set(['/a/root/b', '/a/root/a']));
  const viaArr = D.toEntry(A, '/a/root/x.md', ['/a/root/b', '/a/root/a']);
  assert.deepStrictEqual(viaSet.entry, viaArr.entry);
  assert.deepStrictEqual(viaSet.entry.expanded, ['/a/root/a', '/a/root/b']);
  assert.strictEqual(viaSet.entry.updated_at, 0);
  assert.deepStrictEqual(viaSet.dropped, []);
});

test('#30 shouldRestore：同一代第二次 → false；换代 → true；单文件模式 → false', function () {
  const base = {
    mode: 'directory',
    dirSession: { last_file: '/a/root/x.md', expanded: [] },
    restoredGen: 3,
    generation: 3,
  };
  assert.strictEqual(D.shouldRestore(base), false, '同一代第二次不许再恢复一遍');
  assert.strictEqual(D.shouldRestore(Object.assign({}, base, { generation: 4 })), true);
  assert.strictEqual(D.shouldRestore(Object.assign({}, base, { mode: 'file' })), false);
  assert.strictEqual(D.shouldRestore(Object.assign({}, base, { dirSession: null })), false);
});

test('#31 ⭐ docInRoot：A 根里的路径在 B 根上为 false（R1 的判据本体）', function () {
  const st = { mode: 'directory', currentPath: '/a/A/x.md' };
  assert.strictEqual(D.docInRoot(st, '/a/B'), false);
  assert.strictEqual(D.docInRoot(st, '/a/A'), true);
  // 单文件模式：即便路径恰好在某个根下，也**不是**"树里的当前项"
  assert.strictEqual(D.docInRoot({ mode: 'file', currentPath: '/a/A/x.md' }, '/a/A'), false);
  // 根自己不是"树里的文件"
  assert.strictEqual(D.docInRoot({ mode: 'directory', currentPath: '/a/A' }, '/a/A'), false);
  assert.strictEqual(D.docInRoot({ mode: 'directory', currentPath: '' }, '/a/A'), false);
});

// ══ 协调器时序（#32–#41）═════════════════════════════════════════════

test('#32 ⭐ R1：`currentPath` 还指着 A 的文件时，切到 B 仍会打开 B 的 `last_file`', async function () {
  // ⚠️ 这条钉的是"清零点在 `session.js`，判据在 `docInRoot`"这个分工：
  //    恢复这一侧**必须**自己再判一次，⛔ 不能信 `currentPath` 非空就等于"已经有当前文档了"。
  //    信了的表现：换了目录之后，上次的文件**永远不自动打开**（而树照常展开）。
  const st = mkState({
    roots: ['/a/B'],
    currentPath: '/a/root/A.md',          // 陈旧身份（`applySnapshot` 会清，这里模拟"清之前/没清干净"）
    currentDoc: { real_path: '/a/root/A.md' },
    dirSession: { last_file: '/a/B/b.md', expanded: [], updated_at: 1 },
    dirSessionGen: 1,
    restoredGen: 0,
    generation: 1,
  });
  const opened = [];
  const restorer = D.createRestorer({
    getState: function () { return st; },
    tree: mkTree(),
    openDocument: function (p, o) { opened.push({ p: p, o: o }); return Promise.resolve(); },
  });

  assert.strictEqual(D.docInRoot(st, '/a/B'), false, 'R1 的判据本体：陈旧路径在新根上必须是 false');

  const out = await restorer.run();
  assert.strictEqual(out.opened, true);
  assert.deepStrictEqual(opened.map(function (x) { return x.p; }), ['/a/B/b.md']);
  assert.strictEqual(opened[0].o.reason, 'restore');
});

test('#33 ⭐ R2：恢复进行中调 `writer.flush()` ⇒ `setDirSession` 零调用（挂起）', async function () {
  const token = { generation: 1, root: A, browsing: false, cancelled: false };
  const st = mkState({ restoreToken: token, currentPath: null });
  const calls = [];
  const writer = mkWriter(st, mkTree({ expanded: ['/a/root/a'] }), function () {
    calls.push(Array.prototype.slice.call(arguments));
    return Promise.resolve({ status: 'ok' });
  });

  writer.noteTreeChange();
  const r = await writer.flush();
  assert.strictEqual(r.status, 'suspended');
  assert.strictEqual(calls.length, 0, '恢复期写盘会把 `last_file` 抹成 null（R2）');
  // ⚠️ dirty **不清**：恢复结束之后它还得被写出去（`INV-SESS-09`）
  assert.strictEqual(writer.isDirty(), true);

  // 挂起解除（恢复结束）⇒ 同一次改动真的发出去
  st.restoreToken = null;
  const r2 = await writer.flush();
  assert.strictEqual(r2.status, 'ok');
  assert.strictEqual(calls.length, 1);
});

test('#34 ⭐ R2：恢复成功打开后 `noteDocOpen()` ＋ `flush()` ⇒ 零调用（自我确认不做）', async function () {
  // 镜像就是"存下来的那份"，恢复把**同一份**打开了 ⇒ 内容没变 ⇒ 不许回写。
  const st = mkState({
    currentPath: '/a/root/x.md',
    dirSession: { last_file: '/a/root/x.md', expanded: ['/a/root/a'], updated_at: 5 },
    dirSessionGen: 1,
    restoredGen: 1,
    generation: 1,
  });
  const calls = [];
  const writer = mkWriter(st, mkTree({ expanded: ['/a/root/a'] }), function () {
    calls.push(Array.prototype.slice.call(arguments));
    return Promise.resolve({ status: 'ok' });
  });

  const r = await writer.noteDocOpen();
  assert.strictEqual(r.status, 'same');
  assert.strictEqual(calls.length, 0, '恢复那一趟不许产生任何写盘（R2）');
});

test('#35 ⭐ R2：恢复失败（`open` reject）后 `flush()` ⇒ 记录原样（⛔ 不发空载荷）', async function () {
  const mirrored = { last_file: '/a/root/keep.md', expanded: [], updated_at: 7 };
  const st = mkState({
    currentPath: null,                    // 恢复失败之后就是这样：正文空着
    dirSession: mirrored,
    dirSessionGen: 1,
    restoredGen: 0,
    generation: 1,
  });
  const calls = [];
  const writer = mkWriter(st, mkTree({ expanded: ['/a/root/a'] }), function () {
    calls.push(Array.prototype.slice.call(arguments));
    // 后端会照单返回**它收到的**那一份（`status` 三态见 §7.2）
    return Promise.resolve({
      status: 'ok',
      entry: { last_file: '/a/root/keep.md', expanded: ['/a/root/a'], updated_at: 2 },
    });
  });
  const restorer = D.createRestorer({
    getState: function () { return st; },
    tree: mkTree(),
    openDocument: function () { return Promise.reject(new Error('文件被删了')); },
  });

  const out = await restorer.run();       // ⛔ 不许把 reject 抛出去（那会带走 `renderSidebar`）
  assert.strictEqual(out.opened, true);

  writer.noteTreeChange();
  await writer.flush();
  // ⭐ 判据是"记录原样"，不是"零调用"：写别的字段（比如展开态）是允许的，
  //    但 `last_file` **一个字节都不许变成 null**——那等于"恢复还没成，先把答案擦了"。
  for (const c of calls) {
    assert.strictEqual(c[2], '/a/root/keep.md', '⛔ 恢复失败后把 `last_file` 写成了 ' + String(c[2]));
  }
  assert.strictEqual(st.dirSession.last_file, '/a/root/keep.md');
});

test('#36 ⭐ R3：展开到第 2 条时换掉 `generation` ⇒ 第 3 条不再展开、`openDocument` 零调用', async function () {
  const st = mkState({
    dirSession: {
      last_file: '/a/root/x.md',
      expanded: ['/a/root/d1', '/a/root/d2', '/a/root/d3'],
      updated_at: 1,
    },
    dirSessionGen: 1,
    restoredGen: 0,
    generation: 1,
  });
  const tree = mkTree({
    onStep: function (i) { if (i === 1) st.generation = 2; },   // 第 2 条展开之后世界变了
  });
  const opened = [];
  const restorer = D.createRestorer({
    getState: function () { return st; },
    tree: tree,
    openDocument: function (p) { opened.push(p); return Promise.resolve(); },
  });

  const out = await restorer.run();
  assert.deepStrictEqual(Array.from(tree.expanded), ['/a/root/d1', '/a/root/d2']);
  assert.strictEqual(out.cancelled, true);
  assert.strictEqual(opened.length, 0, '换代次之后⛔ 不许再打开旧根里的文件');
  assert.strictEqual(st.restoreToken, null, '`finally` 要把 token 清掉');
});

test('#37 ⭐ R3：展开中有用户打开文件（`cancel(\'user-open\')`）⇒ 后续展开停、自动打开不做', async function () {
  const st = mkState({
    dirSession: {
      last_file: '/a/root/x.md',
      expanded: ['/a/root/d1', '/a/root/d2', '/a/root/d3'],
      updated_at: 1,
    },
    dirSessionGen: 1,
    restoredGen: 0,
    generation: 1,
  });
  const tree = mkTree();
  const opened = [];
  let restorer = null;
  tree.onStep = function (i) { if (i === 0) restorer.cancel('user-open'); };
  restorer = D.createRestorer({
    getState: function () { return st; },
    tree: tree,
    openDocument: function (p) { opened.push(p); return Promise.resolve(); },
  });

  const out = await restorer.run();
  assert.deepStrictEqual(Array.from(tree.expanded), ['/a/root/d1']);
  assert.strictEqual(out.cancelled, true);
  assert.strictEqual(out.opened, false);
  assert.strictEqual(opened.length, 0, '⛔ 用户刚点了一份，恢复不许再打开"上次的文件"把它顶掉');
});

test('#38 ⭐ R3：展开中用户折叠一层（`browsing`）⇒ 剩余展开继续、自动打开不做', async function () {
  const st = mkState({
    dirSession: {
      last_file: '/a/root/x.md',
      expanded: ['/a/root/d1', '/a/root/d2'],
      updated_at: 1,
    },
    dirSessionGen: 1,
    restoredGen: 0,
    generation: 1,
  });
  const tree = mkTree();
  const opened = [];
  let restorer = null;
  tree.onStep = function (i) { if (i === 0) restorer.noteUserToggle(); };
  restorer = D.createRestorer({
    getState: function () { return st; },
    tree: tree,
    openDocument: function (p) { opened.push(p); return Promise.resolve(); },
  });

  const out = await restorer.run();
  // ⭐ 与 #37 的差别**只有一条**：`browsing` **不作废**展开——用户还在浏览，
  //    把剩下的层也展开完正是他要的；但不许再自动打开一份文件。
  assert.deepStrictEqual(Array.from(tree.expanded), ['/a/root/d1', '/a/root/d2']);
  assert.strictEqual(out.cancelled, false);
  assert.strictEqual(out.opened, false);
  assert.strictEqual(opened.length, 0);
});

test('#39 ⭐ R4：`toEntry` 对"全折叠"返回空载荷 ⇒ `writer.flush()` 真的发出去', async function () {
  // ⚠️ 这一条守的是 R4 的**另一侧**：空会话是**合法状态**。
  //    如果 `sameEntry` 或缺省值把"空"当成"没有"，用户折叠掉最后一个目录之后
  //    记录**永远删不掉**（下次打开又原样展开出来）。
  const st = mkState({
    currentPath: null,
    dirSession: { last_file: null, expanded: ['/a/root/d1'], updated_at: 3 },
    dirSessionGen: 1,
    generation: 1,
  });
  const calls = [];
  const writer = mkWriter(st, mkTree({ expanded: [] }), function (root, gen, lastFile, expanded) {
    calls.push({ root: root, gen: gen, lastFile: lastFile, expanded: expanded });
    return Promise.resolve({ status: 'cleared', entry: null });
  });

  const built = D.toEntry(A, null, []);
  assert.deepStrictEqual(built.entry.expanded, []);
  assert.strictEqual(built.entry.last_file, null);

  writer.noteTreeChange();
  const r = await writer.flush();
  assert.strictEqual(calls.length, 1, '⛔ 空载荷被 `sameEntry` 误判成"没变"，记录就删不掉了');
  assert.deepStrictEqual(calls[0].expanded, []);
  assert.strictEqual(calls[0].lastFile, null);
  assert.strictEqual(r.status, 'cleared');
});

test('#40 ⭐ R5：A 的写请求悬着 → 切到 B → A 的响应回来 ⇒ 镜像仍是 B 的', async function () {
  const st = mkState({
    roots: ['/a/A'],
    dirSession: { last_file: null, expanded: [], updated_at: 1 },
    dirSessionGen: 1,
    generation: 1,
  });
  const d = deferred();
  const calls = [];
  const writer = mkWriter(st, mkTree({ expanded: ['/a/A/d1'] }), function () {
    calls.push(Array.prototype.slice.call(arguments));
    return d.promise;
  });

  writer.noteTreeChange();
  const p = writer.flush();
  assert.strictEqual(calls.length, 1);

  // 世界换成 B（授权变了：代次 +1、根换了、镜像也换了）
  const bEntry = { last_file: '/a/B/b.md', expanded: [], updated_at: 9 };
  st.generation = 2;
  st.roots = ['/a/B'];
  st.files = ['/a/B'];
  st.dirSession = bEntry;
  st.dirSessionGen = 2;

  d.resolve({ status: 'ok', entry: { last_file: '/a/A/d1/x.md', expanded: ['/a/A/d1'], updated_at: 2 } });
  const r = await p;

  assert.strictEqual(r.status, 'dropped');
  assert.strictEqual(r.reason, 'generation');
  assert.strictEqual(st.dirSession, bEntry, '⛔ A 的迟到响应把 B 的镜像顶掉了（R5）');
  assert.strictEqual(st.dirSessionGen, 2);
});

test('#41 ⭐ R5：同代两次写、先发的后回 ⇒ 镜像等于**后发**那次的结果', async function () {
  // ⚠️ 镜像**必须是"另一份"**：如果它恰好等于第一次算出来的载荷，
  //    `sameEntry` 会让第一次**根本不发** ⇒ 这个用例就退化成"只发了一次"（什么也没证明）。
  const st = mkState({
    dirSession: { last_file: null, expanded: ['/a/root/d0'], updated_at: 1 },
    dirSessionGen: 1,
    generation: 1,
  });
  const d1 = deferred();
  const d2 = deferred();
  let n = 0;
  // ⚠️ **同一个写者**连着发两次：`seq` / `latestSeq` 是**实例内的**计数器，
  //    换成两个写者就什么都证明不了（各自 `latestSeq` 都是 1）。
  const tree = mkTree({ expanded: [] });
  const writer = mkWriter(st, tree, function () {
    n += 1;
    return n === 1 ? d1.promise : d2.promise;
  });

  writer.noteTreeChange();
  const p1 = writer.flush();                       // 第 1 次（展开为空）
  tree.expanded.add('/a/root/d1');
  writer.noteTreeChange();
  const p2 = writer.flush();                       // 第 2 次（多了一条展开）

  const e2 = { last_file: null, expanded: ['/a/root/d1'], updated_at: 2 };
  const e1 = { last_file: null, expanded: [], updated_at: 1 };

  d2.resolve({ status: 'ok', entry: e2 });         // 先发的**后**回：这正是 seq 闸存在的理由
  const r2 = await p2;
  assert.strictEqual(r2.status, 'ok');
  assert.strictEqual(st.dirSession, e2);

  d1.resolve({ status: 'ok', entry: e1 });
  const r1 = await p1;
  assert.strictEqual(r1.status, 'dropped');
  assert.strictEqual(r1.reason, 'seq');
  assert.strictEqual(st.dirSession, e2, '⛔ 陈旧的响应回填了镜像（seq 闸没起作用）');
});

// ══ 源码级接线闸门（#42–#45）════════════════════════════════════════
//
// ⚠️ 为什么必须有这四条：`sync.js` 那 70 条、探针那 17 条、`dirsession.js` 上面那 19 条
//    **全都自己建协调器** ⇒ 它们合起来仍然没有一条问过"`src/main.js` 到底接没接"。
//    这一族在本仓库已经栽过五次（`bugs/0003/0004/0005/0006` ＋ `design/0019`），
//    而 `main.js` / `session.js` 是**根脚本 / 会话真值**，进不了 `node --test`
//    ⇒ 只能读源码断言。

test('#42 G1：`src/main.js` 真的调了 `restorer.run(`', function () {
  const code = 去注释(readSrc('src/main.js'));

  // ⭐ 变量名是 `dirRestorer`（设计稿写的是 `restorer.run(` 那个形状）⇒ 按**后缀**认，
  //    ⛔ 不锁死一个标识符：改名不该让闸门失效，**没接**才该。
  const names = [];
  const re = /([A-Za-z_$][\w$]*)\s*\.\s*run\s*\(/g;
  let m;
  while ((m = re.exec(code))) names.push(m[1]);
  assert.ok(
    names.some(function (x) { return /restorer$/i.test(x); }),
    '⛔ `src/main.js` 里找不到 `…restorer.run(` —— 恢复**从来不会被触发**，' +
    '而"打开目录"看起来一切正常（树照常展开、正文照常空着）。见 `design/0020` §2.3 ③(a)'
  );

  // 另一半：协调器**是**从 `dirsession.js` 建的，⛔ 不是就地又写一份
  assert.ok(
    /D\s*\.\s*createRestorer\s*\(/.test(code),
    '⛔ `src/main.js` 没有调 `D.createRestorer(` —— 恢复的编排被就地展开写了'
  );
});

test('#43 G2：`session.js::applySnapshot` 里含 `D.isInside(`（R1 的清零点）', function () {
  const code = 去注释(readSrc('src/services/session.js'));
  const body = 身体(code, 'applySnapshot');
  assert.ok(body, '⛔ 在 `src/services/session.js` 里抠不出 `applySnapshot` 的函数体（改名了？）');

  assert.ok(
    /(?:D|dirSession)\s*\.\s*isInside\s*\(/.test(body),
    '⛔ `applySnapshot` 没有按 `isInside` 重新裁定文档身份 —— 换了目录之后 ' +
    '`currentPath` 会一直指着**上一个根**里的文件（R1），而屏幕上什么都不会报'
  );
  // ⭐ 裁定的**动作**也要在：判据为假时把三件身份字段清掉
  assert.ok(
    /currentPath\s*=\s*null/.test(body),
    '⛔ `applySnapshot` 判出了越界却没有清 `currentPath`（R1 只做了一半）'
  );
  // ⚠️ 判据必须**只有一份**：⛔ 不许在这里再写一个 `startsWith` 版本（前缀陷阱同族）
  assert.ok(
    !/startsWith\s*\(\s*prefix/.test(body),
    '⛔ `applySnapshot` 里出现了第二份包含判断（`INV-TREE-01` / R1）'
  );
});

test('#44 G3：`openDocument` 的 `reason === \'restore\'` 分支不调 `flush(`', function () {
  const code = 去注释(readSrc('src/main.js'));
  const body = 身体(code, 'openDocument');
  assert.ok(body, '⛔ 在 `src/main.js` 里抠不出 `openDocument` 的函数体（改名了？）');

  const at = body.indexOf("reason === 'restore'");
  assert.ok(at >= 0, '⛔ `openDocument` 里没有 `reason === \'restore\'` 这个分支（R2 的落点没了）');

  const br = 块(body, at);
  assert.ok(br, '⛔ 抠不出 `reason === \'restore\'` 后面那一块');

  assert.ok(
    !/\bflush\s*\(/.test(br),
    '⛔ `reason === \'restore\'` 那一支调了 `flush(` —— 这正是评审 R2 点名的形态：' +
    '那一刻 `currentPath` 还是 null，冲刷会把 `last_file` 抹成 null，' +
    '**恢复还没试，记录已经没了**（而且下一次树操作就把它永久写下去）'
  );

  // 反面：**别的一趟**还是要冲刷的（否则"用户亲手打开文件"这条唯一的来源就断了）
  const 开 = body.indexOf('{', at);
  const rest = body.slice(0, 开) + body.slice(开 + br.length);
  assert.ok(
    /\.flush\s*\(/.test(rest),
    '⛔ `openDocument` 除了恢复那一趟之外也不冲刷了 —— 用户打开的文件将永远存不进会话'
  );
});

test('#45 G4：`src/main.js` 里不存在 `writeDirSession`（逻辑只在 `dirsession.js`）', function () {
  const code = 去注释(readSrc('src/main.js'));
  assert.ok(
    !/\bwriteDirSession\b/.test(code),
    '⛔ `src/main.js` 里出现了 `writeDirSession` —— 写盘逻辑被搬回了根脚本，' +
    '而它**进不了 `tests/js/`** ⇒ #33–#41 那九条时序断言再也盯不住它'
  );

  // 正面：两份协调器都真的从 `dirsession.js` 导出（否则 `D.createWriter` 是 undefined，
  // 而 `main.js` 在**加载期**取它 —— 表现是启动就炸，⛔ 不是静默）
  const mod = 去注释(readSrc('src/services/dirsession.js'));
  assert.ok(/createRestorer\s*:/.test(mod), '⛔ `dirsession.js` 没有导出 `createRestorer`');
  assert.ok(/createWriter\s*:/.test(mod), '⛔ `dirsession.js` 没有导出 `createWriter`');
});
