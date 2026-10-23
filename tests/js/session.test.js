// `design/0035` §10.6 的 P2 处置：**改名回包的身份守卫**。
//
// ⚠️ 这一层的错法**全是静默的**：迟到的改名回包把**新会话**的 `currentPath` /
//    `currentDoc` / `watchSeq` 覆盖成旧文档的，界面上看起来一切正常，只是
//    "自动刷新指向了一份已经不在屏幕上的文件"。
// ⇒ 三个场景全部用**可手控的 Promise** 造（⛔ 不睡真时间）：
//    ① 切根后重开同一路径（路径相同、会话不同）
//    ② 切到别的文档再切回来（路径相同、`currentDoc` / `docSeq` 都是新的）
//    ③ 改名已返回、父层重列期间打开另一文档（高亮判据见 `treerefresh.test.js`）
//
// ⭐ 另一个必须钉住的事实：**盘上的改名已经成功**。身份对不上时
//    `renameEntry` 仍然原样交回 `res`（⛔ 不抛错、⛔ 不改字段），
//    否则调用方会把"前端放弃提交"误报成"改名失败"。

'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ⚠️ `session.js` 在加载期只做 `require`，⛔ 不碰 `window`；
//    但 `tauri.js::call` 每次现取 `window.__TAURI__`，所以这里先立一个假的。
global.window = {
  __TAURI__: {
    core: {
      invoke: function () { throw new Error('未安装 fake invoke'); },
    },
  },
};

const S = require('../../src/services/session.js');

/** 可手控的 Promise（与 `dirsession.test.js` 同款：⛔ 不睡真时间）。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * 装一套假后端：
 * - `get_session` 返回当前 `snap`；
 * - `open_document` **每次都推进 `doc_seq`**（与真后端一致：它是"打开会话号"）；
 * - `watch_document` 依次发 `seq`；
 * - `rename_entry` 挂起，由用例自己 resolve。
 */
function installFake() {
  const fake = {
    snap: null,
    renameGate: null,
    renameCalls: 0,
    watchSeq: 100,
    install: function () {
      global.window.__TAURI__.core.invoke = function (cmd, args) {
        if (cmd === 'get_session') return Promise.resolve(clone(fake.snap));
        if (cmd === 'open_document') {
          fake.snap.doc_seq += 1;
          return Promise.resolve({
            gen: args.generation,
            req: args.req,
            real_path: args.path,
            roots_nonempty: true,
            outside_roots: false,
          });
        }
        if (cmd === 'watch_document') {
          fake.watchSeq += 1;
          return Promise.resolve({ seq: fake.watchSeq, path: args.path });
        }
        if (cmd === 'rename_entry') {
          fake.renameCalls += 1;
          fake.renameGate = deferred();
          return fake.renameGate.promise;
        }
        if (cmd === 'unwatch_document') return Promise.resolve();
        throw new Error('未预料的命令：' + cmd);
      };
    },
    /** 直接重置会话真值（⛔ 不经过前端自己的猜测）。 */
    reset: async function (snap) {
      fake.snap = snap;
      await S.refresh();
    },
  };
  return fake;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function snapshot(over) {
  return Object.assign({
    generation: 1,
    mode: 'directory',
    roots: ['/rootA'],
    files: [],
    pending_directory: null,
    sidebar_width: 280,
    last_directory: null,
    reading_progress: {},
    dir_session: null,
    doc_seq: 10,
  }, over || {});
}

/** 让 `S.renameEntry` 真的发出 IPC（它内部 `await T.call` 之前是同步的）。 */
async function tick() { await Promise.resolve(); await Promise.resolve(); }

test('改名回包：切根后重开同一路径 ⇒ 路径相同也不算同一会话，状态一个都不改', async function () {
  const fake = installFake();
  fake.install();
  await fake.reset(snapshot());
  let r = await S.openDocument('/rootA/a.md');
  assert.ok(r.payload, '前置：A 必须打开成功');
  await S.watchDocument('/rootA/a.md');
  const watchBefore = S.state.watchSeq;
  const docBefore = S.state.currentDoc;

  // 改名在飞
  const pending = S.renameEntry('/rootA/a.md', 'b');
  await tick();
  assert.strictEqual(fake.renameCalls, 1);

  // 期间：换根（同一个根被重新授权 ⇒ generation 变了），再打开**同一路径**
  fake.snap = snapshot({ generation: 2, roots: ['/rootA'], doc_seq: fake.snap.doc_seq });
  await S.refresh();
  r = await S.openDocument('/rootA/a.md');
  assert.ok(r.payload, '前置：重开同一路径必须成功');
  await S.watchDocument('/rootA/a.md');
  const watchNew = S.state.watchSeq;
  const docNew = S.state.currentDoc;
  assert.notStrictEqual(docNew, docBefore, '前置：重开之后必须是**新的**文档对象');

  fake.renameGate.resolve({
    path: '/rootA/b.md',
    old_path: '/rootA/a.md',
    current_moved: true,
    watch_seq: 999,
    degraded: [],
  });
  const res = await pending;

  // 盘上的成功事实照样交回去（⛔ 不被误报成失败）
  assert.strictEqual(res.path, '/rootA/b.md');
  assert.strictEqual(res.current_moved, true);
  // ⭐ 新会话的状态一个都不许被旧回包改写
  assert.strictEqual(S.state.generation, 2);
  assert.strictEqual(S.state.currentPath, '/rootA/a.md');
  assert.strictEqual(S.state.currentDoc, docNew);
  assert.strictEqual(S.state.currentDoc.real_path, '/rootA/a.md');
  assert.strictEqual(S.state.watchSeq, watchNew);
  assert.notStrictEqual(S.state.watchSeq, 999);
  assert.strictEqual(S.state.watchPath, '/rootA/a.md');
});

test('改名回包：切到别的文档再切回来 ⇒ 路径相同但 currentDoc / docSeq 已换，状态不改', async function () {
  const fake = installFake();
  fake.install();
  await fake.reset(snapshot());
  await S.openDocument('/rootA/a.md');
  await S.watchDocument('/rootA/a.md');

  const pending = S.renameEntry('/rootA/a.md', 'b');
  await tick();

  // 期间：B → 回到 A（**同一路径**，但后端每次打开都会推进 doc_seq）
  await S.openDocument('/rootA/other.md');
  await S.openDocument('/rootA/a.md');
  await S.watchDocument('/rootA/a.md');
  const docNew = S.state.currentDoc;
  const seqNew = S.state.docSeq;
  const watchNew = S.state.watchSeq;

  fake.renameGate.resolve({
    path: '/rootA/b.md',
    old_path: '/rootA/a.md',
    current_moved: true,
    watch_seq: 999,
    degraded: [],
  });
  const res = await pending;

  assert.strictEqual(res.path, '/rootA/b.md', '成功事实照样交回');
  assert.strictEqual(S.state.currentPath, '/rootA/a.md');
  assert.strictEqual(S.state.currentDoc, docNew);
  assert.strictEqual(S.state.docSeq, seqNew);
  assert.strictEqual(S.state.watchSeq, watchNew);
  assert.strictEqual(S.state.watchPath, '/rootA/a.md');
});

test('改名回包：换根后正文还没来得及换 ⇒ 根代次已变，⛔ 不迁移', async function () {
  // ⚠️ 这个窗口是真的：用户选了「打开文件」之后，快照（`roots` 变空、`generation` 变了）
  //    先落地，`openDocument` 的那一趟 IPC 才发出。中间这段时间 `currentDoc` **还是旧的**，
  //    ⇒ 只靠文档对象身份拦不住**换根**这件事（§10.6：要捕获"根代次及文档身份"）。
  const fake = installFake();
  fake.install();
  await fake.reset(snapshot());
  await S.openDocument('/rootA/a.md');
  await S.watchDocument('/rootA/a.md');
  const docBefore = S.state.currentDoc;
  const seqBefore = S.state.docSeq;

  const pending = S.renameEntry('/rootA/a.md', 'b');
  await tick();

  // 快照换代：目录会话收起（`roots` 为空 ⇒ R1 不清文档身份），正文尚未重新打开
  fake.snap = snapshot({
    generation: 2,
    roots: [],
    mode: 'single-file',
    doc_seq: seqBefore,
  });
  await S.refresh();
  assert.strictEqual(S.state.currentDoc, docBefore, '前置：正文还是旧的那一份');
  assert.strictEqual(S.state.currentPath, '/rootA/a.md');

  fake.renameGate.resolve({
    path: '/rootA/b.md',
    old_path: '/rootA/a.md',
    current_moved: true,
    watch_seq: 999,
    degraded: [],
  });
  const res = await pending;

  assert.strictEqual(res.path, '/rootA/b.md', '成功事实照样交回');
  assert.strictEqual(S.state.currentPath, '/rootA/a.md', '⛔ 路径不许跟着旧回包走');
  assert.strictEqual(S.state.currentDoc.real_path, '/rootA/a.md');
  // 换根已经让监视失效（`INV-EXT-09`），旧回包的 `watch_seq` 不许把它"复活"
  assert.strictEqual(S.state.watchSeq, 0);
  assert.strictEqual(S.state.watchPath, null);
  assert.strictEqual(S.state.watchStopped, true);
});

test('改名回包：会话没变 ⇒ 正常迁移当前文档与 watchSeq', async function () {
  const fake = installFake();
  fake.install();
  await fake.reset(snapshot());
  await S.openDocument('/rootA/a.md');
  await S.watchDocument('/rootA/a.md');
  const seqBefore = S.state.docSeq;

  const pending = S.renameEntry('/rootA/a.md', 'b');
  await tick();
  fake.renameGate.resolve({
    path: '/rootA/b.md',
    old_path: '/rootA/a.md',
    current_moved: true,
    watch_seq: 77,
    degraded: [],
  });
  const res = await pending;

  assert.strictEqual(res.path, '/rootA/b.md');
  assert.strictEqual(S.state.currentPath, '/rootA/b.md');
  assert.strictEqual(S.state.currentDoc.real_path, '/rootA/b.md');
  // ⭐ 改名**不**是一次新的打开会话（`design/0035` B6：doc_seq 不变）
  assert.strictEqual(S.state.docSeq, seqBefore);
  assert.strictEqual(S.state.watchSeq, 77);
  assert.strictEqual(S.state.watchPath, '/rootA/b.md');
  assert.strictEqual(S.state.watchNoteKey, '');
});
